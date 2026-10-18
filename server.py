from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from urllib.parse import urlparse
import json, os, tempfile, shutil, mimetypes, subprocess, re, hashlib, sys, time, threading

HOST = "127.0.0.1"
PORT = 8000
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STORAGE_FILE = os.path.join(BASE_DIR, "storage.json")
SANDBOX_ROOT = os.path.join(BASE_DIR, "sandbox")
INFO_FILE = os.path.join(BASE_DIR, "extra-info.md")
MAX_BODY = 10 * 1024 * 1024
MAX_FILE_SIZE = 5 * 1024 * 1024
RUN_TIMEOUT = 30
RUNNABLE_EXTS = {'.py', '.sh', '.js', '.ts', '.rb', '.pl', '.php'}
VENDOR_DIR = os.path.join(BASE_DIR, "vendor")
VENDOR_WHITELIST = ("marked.min.js", "dompurify.min.js", "highlight.min.js")
INFO_MAX_SIZE = 2 * 1024 * 1024
OUTPUT_CAP = 1024 * 1024
STORAGE_LOCK = threading.Lock()
RUN_SEM = threading.Semaphore(4)
SEARCH_SEM = threading.Semaphore(2)
FILE_LOCKS = {}
FILE_LOCKS_GUARD = threading.Lock()

os.makedirs(SANDBOX_ROOT, exist_ok=True)

def read_storage():
    data = {}
    if os.path.exists(STORAGE_FILE):
        try:
            with open(STORAGE_FILE, "r") as f:
                loaded = json.load(f)
                if isinstance(loaded, dict):
                    data = loaded
        except json.JSONDecodeError:
            backup = STORAGE_FILE + ".corrupt." + str(int(time.time()))
            try:
                os.replace(STORAGE_FILE, backup)
                print(f"[storage] corrupt storage.json archived to {backup}", file=sys.stderr)
            except OSError:
                pass
            data = {}
        except OSError:
            data = {}
    if not isinstance(data.get("revision"), int):
        data["revision"] = 0
    return data

def write_storage(data):
    dir_name = os.path.dirname(STORAGE_FILE)
    fd, tmp = tempfile.mkstemp(dir=dir_name, suffix=".tmp")
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(data, f, indent=2)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, STORAGE_FILE)
        try:
            dfd = os.open(dir_name, os.O_RDONLY)
            try:
                os.fsync(dfd)
            finally:
                os.close(dfd)
        except OSError:
            pass
    except Exception:
        try: os.unlink(tmp)
        except OSError: pass
        raise

def _get_file_lock(chat_id):
    with FILE_LOCKS_GUARD:
        lock = FILE_LOCKS.get(chat_id)
        if lock is None:
            lock = threading.Lock()
            FILE_LOCKS[chat_id] = lock
            if len(FILE_LOCKS) > 64:
                stale = [k for k, v in FILE_LOCKS.items() if not v.locked() and k != chat_id]
                for k in stale:
                    del FILE_LOCKS[k]
        return lock

def _tail_output(path, cap=OUTPUT_CAP):
    try:
        size = os.path.getsize(path)
        if size <= cap:
            with open(path, "r", encoding="utf-8", errors="replace") as f:
                return f.read()
        with open(path, "rb") as f:
            f.seek(-cap, os.SEEK_END)
            data = f.read()
        return data.decode("utf-8", "replace") + "\n... (truncated)"
    except OSError:
        return ""

def _sanitize_chat_id(chat_id):
    if not chat_id or not isinstance(chat_id, str):
        return None
    if len(chat_id) > 64:
        return None
    if not re.match(r'^[a-zA-Z0-9_-]+$', chat_id):
        return None
    return chat_id

def _chat_sandbox(chat_id):
    cid = _sanitize_chat_id(chat_id)
    if not cid:
        return None
    d = os.path.join(SANDBOX_ROOT, cid)
    os.makedirs(d, exist_ok=True)
    return d

def safe_path(rel_path, chat_id):
    chat_dir = _chat_sandbox(chat_id)
    if not chat_dir:
        return None
    rel_path = rel_path.lstrip("/")
    full = os.path.normpath(os.path.join(chat_dir, rel_path))
    real_dir = os.path.realpath(chat_dir)
    full = os.path.realpath(full)
    if full != real_dir and not full.startswith(real_dir + os.sep):
        return None
    if len(full) > 4096:
        return None
    return full

def list_files(rel_dir, chat_id):
    full = safe_path(rel_dir, chat_id)
    if not full or not os.path.isdir(full):
        return []
    items = []
    for name in sorted(os.listdir(full)):
        fp = os.path.join(full, name)
        rel = os.path.join(rel_dir, name) if rel_dir else name
        is_dir = os.path.isdir(fp)
        item = {"name": name, "path": rel, "isDir": is_dir}
        if not is_dir:
            try:
                stat = os.stat(fp)
                item["size"] = stat.st_size
                item["mtime"] = int(stat.st_mtime)
                item["mime"] = mimetypes.guess_type(name)[0] or "application/octet-stream"
            except OSError:
                pass
        items.append(item)
    return items

def tree_files(rel_dir, chat_id, depth=0, max_depth=4):
    if depth >= max_depth:
        return []
    items = list_files(rel_dir, chat_id)
    result = []
    for item in items:
        result.append(item)
        if item["isDir"]:
            item["children"] = tree_files(item["path"], chat_id, depth + 1, max_depth)
    return result

def ddg_search(q, max_results=6):
    from urllib.request import Request, urlopen
    from urllib.parse import quote, urlparse, parse_qs
    from html.parser import HTMLParser

    req = Request(
        "https://html.duckduckgo.com/html/?q=" + quote(q),
        headers={
            "User-Agent": "Mozilla/5.0 (X11; Linux x86_64; rv:120.0) Gecko/20100101 Firefox/120.0",
            "Accept-Language": "en-US,en;q=0.9",
        },
    )
    if not SEARCH_SEM.acquire(timeout=1):
        return None, "busy"
    try:
        try:
            with urlopen(req, timeout=10) as resp:
                status = resp.status if hasattr(resp, "status") else resp.getcode()
                if status != 200:
                    if status in (202, 403, 429):
                        return None, "blocked"
                    return None, f"search status {status}"
                raw = resp.read(512 * 1024).decode("utf-8", "replace")
        except Exception as e:
            return None, str(e)
    finally:
        SEARCH_SEM.release()

    class _Parser(HTMLParser):
        def __init__(self):
            super().__init__()
            self.entries = []
            self.href = None
            self.buf = []
            self.kind = None  # 'title' | 'snippet' | None
            self.depth = 0

        def handle_starttag(self, tag, attrs):
            cls = dict(attrs).get("class", "")
            if tag == "a" and "result__a" in cls and self.kind is None:
                self.kind = "title"
                self.href = dict(attrs).get("href", "")
                self.buf = []
                self.depth = 1
            elif tag in ("a", "span") and "result__snippet" in cls and self.kind is None:
                self.kind = "snippet"
                self.buf = []
                self.depth = 1
            elif self.kind == "title" and tag == "a":
                self.depth += 1
            elif self.kind == "snippet" and tag in ("a", "span"):
                self.depth += 1

        def handle_data(self, data):
            if self.kind is not None:
                self.buf.append(data)

        def handle_endtag(self, tag):
            if self.kind == "title" and tag == "a":
                self.depth -= 1
                if self.depth <= 0:
                    title = "".join(self.buf).strip()
                    if title:
                        self.entries.append({"title": title, "href": self.href or "", "snippet": ""})
                    self.kind = None
                    self.href = None
                    self.depth = 0
            elif self.kind == "snippet" and tag in ("a", "span"):
                self.depth -= 1
                if self.depth <= 0:
                    if self.entries:
                        self.entries[-1]["snippet"] = "".join(self.buf).strip()
                    self.kind = None
                    self.depth = 0

    def _looks_blocked(html):
        lh = html.lower()
        markers = (
            "anomaly",
            "captcha",
            "unusual traffic",
            "enable javascript",
            "verify you are a human",
            "automated requests",
            "recaptcha",
            "blocked",
            "challenge",
        )
        return sum(1 for m in markers if m in lh) >= 2

    p = _Parser()
    p.feed(raw)

    def _unwrap(u):
        if "uddg" in u:
            qs = parse_qs(urlparse(u).query)
            if "uddg" in qs:
                u = qs["uddg"][0]
        if u.startswith("//"):
            u = "https:" + u
        return u

    results = []
    for e in p.entries:
        url = _unwrap(e["href"])
        if not url.startswith("http"):
            continue
        results.append({"title": e["title"], "url": url, "snippet": e.get("snippet") or ""})
        if len(results) >= max_results:
            break
    if not results and _looks_blocked(raw):
        return None, "blocked"
    return results, None

def _info_blocks(text):
    blocks = []
    heading = "(top)"
    buffer = []
    start_line = 1
    for i, raw in enumerate(text.splitlines(), start=1):
        stripped = raw.strip()
        if stripped.startswith("#"):
            if buffer:
                blocks.append((heading, start_line, "\n".join(buffer).strip()))
                buffer = []
            heading = stripped.lstrip("#").strip()
            continue
        if not stripped:
            if buffer:
                blocks.append((heading, start_line, "\n".join(buffer).strip()))
                buffer = []
            continue
        if not buffer:
            start_line = i
        buffer.append(raw)
    if buffer:
        blocks.append((heading, start_line, "\n".join(buffer).strip()))
    return [b for b in blocks if b[2]]

def _entry_code(heading, block):
    return hashlib.md5(("INFO|" + heading + "\n" + block).encode("utf-8", "replace")).hexdigest()[:8]

def _search_info(text, q):
    blocks = _info_blocks(text)
    terms = [t for t in re.findall(r"[a-z0-9']+", q.lower()) if len(t) > 1]
    scored = []
    for heading, line, block in blocks:
        low = block.lower()
        score = 0
        matched = 0
        for t in set(terms):
            c = len(re.findall(r"(?<![A-Za-z0-9])" + re.escape(t) + r"(?![A-Za-z0-9])", low))
            if c:
                score += c
                matched += 1
        if matched:
            score += matched * 3
            scored.append((score, heading, line, block))
    scored.sort(key=lambda x: (-x[0], x[2]))
    results = []
    for score, heading, line, block in scored[:5]:
        snippet = block if len(block) <= 600 else block[:600].rsplit(" ", 1)[0] + " \u2026"
        results.append({"entry": _entry_code(heading, block), "heading": heading, "snippet": snippet, "score": score})
    return results

def _read_info_entry(text, code):
    code = (code or "").strip().lower()
    for heading, line, block in _info_blocks(text):
        if _entry_code(heading, block) == code:
            return heading, block
    return None, None

def _valid_conversations(conversations):
    if not isinstance(conversations, dict):
        return False
    for cid, conv in conversations.items():
        if not isinstance(cid, str):
            return False
        if not isinstance(conv, dict):
            return False
        if "title" in conv and not isinstance(conv.get("title"), str):
            return False
        messages = conv.get("messages")
        if not isinstance(messages, list):
            return False
        for msg in messages:
            if not isinstance(msg, dict):
                return False
            if msg.get("role") not in ("user", "assistant"):
                return False
            content = msg.get("content")
            if content is not None and not isinstance(content, str):
                return False
            images = msg.get("images")
            if images is not None and (not isinstance(images, list) or not all(isinstance(i, str) for i in images)):
                return False
            for key in ("fileOps", "searchCards"):
                val = msg.get(key)
                if val is not None and (not isinstance(val, list) or not all(isinstance(d, dict) for d in val)):
                    return False
    return True

def _valid_projects(projects):
    if not isinstance(projects, dict):
        return False
    for pid, proj in projects.items():
        if not isinstance(pid, str):
            return False
        if not isinstance(proj, dict):
            return False
        if "name" in proj and not isinstance(proj.get("name"), str):
            return False
        if "instructions" in proj and not isinstance(proj.get("instructions"), str):
            return False
    return True

def _is_run_body(body):
    if not isinstance(body, dict):
        return False
    if "mkdir" in body or "content" in body:
        return False
    return isinstance(body.get("path"), str) and bool(body.get("path")) and "chatId" in body

class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=BASE_DIR, **kwargs)

    def _cors_headers(self):
        origin = self.headers.get("Origin")
        if not origin:
            return
        hostname = urlparse(origin).hostname
        if hostname and hostname.startswith("[") and hostname.endswith("]"):
            hostname = hostname[1:-1]
        if hostname not in ("127.0.0.1", "localhost", "::1"):
            return
        self.send_header("Access-Control-Allow-Origin", origin)
        self.send_header("Vary", "Origin")

    def _check_origin(self):
        origin = self.headers.get("Origin")
        if origin:
            if origin != "http://" + (self.headers.get("Host") or ""):
                self._json_response(403, {"error": "forbidden origin"})
                return False
            return True
        host = self.headers.get("Host") or ""
        hostname = urlparse("http://" + host).hostname
        if hostname and hostname.startswith("[") and hostname.endswith("]"):
            hostname = hostname[1:-1]
        if hostname not in ("127.0.0.1", "localhost", "::1"):
            self._json_response(403, {"error": "forbidden origin"})
            return False
        return True

    def _check_json_content_type(self):
        if not self.headers.get("Content-Type", "").lower().startswith("application/json"):
            self._json_response(415, {"error": "Content-Type must be application/json"})
            return False
        return True

    def _json_response(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self._cors_headers()
        self.end_headers()
        self.wfile.write(body)

    def _read_body(self):
        if self.headers.get("Transfer-Encoding", "").lower().strip() == "chunked":
            self._json_response(411, {"error": "Length Required"})
            return None
        length_raw = self.headers.get("Content-Length")
        if length_raw is None:
            self._json_response(411, {"error": "Length Required"})
            return None
        try:
            length = int(length_raw)
        except ValueError:
            self._json_response(411, {"error": "Length Required"})
            return None
        if length < 0:
            self._json_response(400, {"error": "bad content length"})
            return None
        if length > MAX_BODY:
            self._json_response(413, {"error": "too large"})
            return None
        prev_timeout = self.connection.gettimeout()
        self.connection.settimeout(15)
        try:
            raw = self.rfile.read(length) if length else b"{}"
        except OSError:
            self._json_response(400, {"error": "read failed"})
            return None
        finally:
            self.connection.settimeout(prev_timeout)
        try:
            body = json.loads(raw)
        except (json.JSONDecodeError, ValueError):
            self._json_response(400, {"error": "invalid json"})
            return None
        if body is None:
            self._json_response(400, {"error": "expected JSON object"})
            return None
        return body

    def _get_chat_id_qs(self):
        from urllib.parse import urlparse, parse_qs
        qs = parse_qs(urlparse(self.path).query, keep_blank_values=True)
        return qs.get("chatId", [None])[0]

    def do_GET(self):
        try:
            path_no_query = self.path.split("?")[0]
            if path_no_query == "/api/storage":
                self._json_response(200, read_storage())
            elif path_no_query == "/api/search":
                self._handle_search()
            elif path_no_query == "/api/info":
                self._handle_info()
            elif path_no_query == "/api/files" or path_no_query.startswith("/api/files/"):
                self._handle_files_get()
            elif path_no_query in ("/", "/index.html"):
                self._serve_static("index.html")
            elif path_no_query == "/manifest.json":
                self._serve_static("manifest.json")
            elif path_no_query == "/style.css":
                self._serve_static("style.css")
            elif path_no_query == "/app.js":
                self._serve_static("app.js")
            elif path_no_query.startswith("/vendor/"):
                self._serve_vendor(path_no_query[len("/vendor/"):])
            else:
                self.send_error(404)
        except Exception:
            self._json_response(500, {"error": "internal error"})

    def _serve_static(self, name):
        full = os.path.join(BASE_DIR, name)
        try:
            with open(full, "rb") as f:
                data = f.read()
        except OSError:
            self.send_error(404)
            return
        self.send_response(200)
        ctype = mimetypes.guess_type(name)[0] or "application/octet-stream"
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self._cors_headers()
        self.end_headers()
        self.wfile.write(data)

    def _serve_vendor(self, name):
        if not name or "/" in name or "\\" in name or ".." in name:
            self.send_error(404)
            return
        if name not in VENDOR_WHITELIST:
            self.send_error(404)
            return
        full = os.path.join(VENDOR_DIR, name)
        try:
            with open(full, "rb") as f:
                data = f.read()
        except OSError:
            self.send_error(404)
            return
        self.send_response(200)
        ctype = mimetypes.guess_type(name)[0] or "application/javascript"
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self._cors_headers()
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        try:
            path_no_query = self.path.split("?")[0]
            if path_no_query.startswith("/api"):
                if not self._check_origin():
                    return
                if path_no_query == "/api/storage" or path_no_query == "/api/files/run" or path_no_query == "/api/files" or path_no_query.startswith("/api/files/"):
                    if not self._check_json_content_type():
                        return
            if path_no_query == "/api/storage":
                body = self._read_body()
                if body is None: return
                if not isinstance(body, dict):
                    self._json_response(400, {"error": "expected JSON object"})
                    return
                projects = body.get("projects")
                conversations = body.get("conversations")
                if not isinstance(projects, dict) or not isinstance(conversations, dict):
                    self._json_response(400, {"error": 'expected {projects: {}, conversations: {}}'})
                    return
                if not _valid_conversations(conversations) or not _valid_projects(projects):
                    self._json_response(400, {"error": "invalid data shape"})
                    return
                with STORAGE_LOCK:
                    old = read_storage()
                    old_rev = old.get("revision") if isinstance(old, dict) else None
                    old_rev = old_rev if isinstance(old_rev, int) else 0
                    if "revision" in body:
                        rev = body["revision"]
                        if isinstance(rev, bool) or not isinstance(rev, int):
                            self._json_response(400, {"error": "revision must be an integer"})
                            return
                        if rev < old_rev:
                            self._json_response(409, {"error": "revision conflict", "revision": old_rev})
                            return
                    else:
                        rev = old_rev + 1
                    body["revision"] = rev
                    write_storage(body)
                    self._json_response(200, {"ok": True, "revision": rev})
            elif path_no_query == "/api/files/run":
                body = self._read_body()
                if body is None: return
                if _is_run_body(body):
                    self._handle_files_run(body)
                else:
                    self._handle_files_post(body)
            elif path_no_query == "/api/files" or path_no_query.startswith("/api/files/"):
                self._handle_files_post()
            else:
                self.send_error(404)
        except Exception:
            self._json_response(500, {"error": "internal error"})

    def do_PUT(self):
        try:
            path_no_query = self.path.split("?")[0]
            if path_no_query.startswith("/api"):
                if not self._check_origin():
                    return
                if not self._check_json_content_type():
                    return
            if path_no_query == "/api/files" or path_no_query.startswith("/api/files/"):
                self._handle_files_put()
            else:
                self.send_error(404)
        except Exception:
            self._json_response(500, {"error": "internal error"})

    def do_DELETE(self):
        try:
            path_no_query = self.path.split("?")[0]
            if path_no_query.startswith("/api"):
                if not self._check_origin():
                    return
            if path_no_query == "/api/storage":
                with STORAGE_LOCK:
                    old = read_storage()
                    old_rev = old.get("revision") if isinstance(old, dict) else None
                    old_rev = old_rev if isinstance(old_rev, int) else 0
                    write_storage({"projects": {}, "conversations": {}, "revision": old_rev + 1})
                    self._json_response(200, {"ok": True})
            elif path_no_query == "/api/files" or path_no_query.startswith("/api/files/"):
                self._handle_files_delete()
            else:
                self.send_error(404)
        except Exception:
            self._json_response(500, {"error": "internal error"})

    def do_OPTIONS(self):
        self.send_response(200)
        self._cors_headers()
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _handle_search(self):
        from urllib.parse import urlparse, parse_qs
        qs = parse_qs(urlparse(self.path).query, keep_blank_values=True)
        q = (qs.get("q", [""])[0] or "").strip()
        if not q:
            self._json_response(400, {"error": "missing q"})
            return
        if len(q) > 300:
            self._json_response(400, {"error": "query too long"})
            return
        results, err = ddg_search(q)
        if err:
            print("[search] error:", err)
            if err == "busy":
                self._json_response(503, {"error": "search busy"})
                return
            if err == "blocked":
                self._json_response(200, {"query": q, "results": [], "error": "search blocked", "blocked": True})
                return
            self._json_response(502, {"error": "search failed"})
            return
        self._json_response(200, {"query": q, "results": results})

    def _handle_info(self):
        from urllib.parse import urlparse, parse_qs
        qs = parse_qs(urlparse(self.path).query, keep_blank_values=True)
        q = (qs.get("q", [""])[0] or "").strip()
        if len(q) > 300:
            self._json_response(400, {"error": "query too long"})
            return
        entry_code = (qs.get("entry", [""])[0] or "").strip().lower()
        if entry_code and not re.fullmatch(r"[0-9a-fA-F]{8}", entry_code):
            self._json_response(400, {"error": "invalid entry"})
            return
        try:
            size = os.path.getsize(INFO_FILE)
            if size > INFO_MAX_SIZE:
                self._json_response(400, {"error": "extra-info.md too large"})
                return
            with open(INFO_FILE, "r", encoding="utf-8", errors="replace") as f:
                text = f.read()
        except OSError:
            self._json_response(404, {"error": "info file not found"})
            return
        if entry_code:
            heading, block = _read_info_entry(text, entry_code)
            if block is None:
                self._json_response(404, {"error": "entry not found"})
                return
            self._json_response(200, {"entry": entry_code, "heading": heading, "content": block})
            return
        if not q:
            truncated = False
            content = text
            if len(content) > 65536:
                content = content[:65536] + "\u2026[truncated]"
                truncated = True
            self._json_response(200, {"content": content, "size": len(text.encode("utf-8")), "truncated": truncated})
            return
        self._json_response(200, {"query": q, "results": _search_info(text, q)})

    def _parse_file_path(self):
        prefix = "/api/files"
        path = self.path.split("?")[0]
        path = path[len(prefix):].strip("/")
        from urllib.parse import unquote
        return unquote(path)

    def _handle_files_get(self):
        from urllib.parse import urlparse, parse_qs
        qs = parse_qs(urlparse(self.path).query, keep_blank_values=True)
        chat_id = qs.get("chatId", [None])[0]
        if not _sanitize_chat_id(chat_id):
            self._json_response(400, {"error": "missing or invalid chatId"})
            return
        rel_path = self._parse_file_path()

        if "tree" in qs:
            self._json_response(200, {"tree": tree_files(rel_path, chat_id)})
            return

        full = safe_path(rel_path, chat_id)
        if not full:
            self._json_response(400, {"error": "invalid path"})
            return
        if not os.path.exists(full):
            self._json_response(404, {"error": "not found"})
            return
        if os.path.isdir(full):
            self._json_response(200, {"files": list_files(rel_path, chat_id)})
            return

        stat = os.stat(full)
        if stat.st_size > MAX_FILE_SIZE:
            self._json_response(413, {"error": "file too large"})
            return
        mime = mimetypes.guess_type(full)[0] or "application/octet-stream"
        ext = os.path.splitext(rel_path)[1].lower()
        is_text = mime.startswith("text/") or mime in ("application/json", "application/javascript", "application/xml") or mime.endswith("+json") or mime.endswith("+xml")

        sheet_text = None
        if not is_text and ext in ('.xlsx', '.xls', '.ods', '.csv', '.tsv'):
            sheet_text = self._sheet_as_text(full)

        if is_text or sheet_text is not None:
            try:
                if sheet_text is not None:
                    content = sheet_text
                else:
                    with open(full, "r", encoding="utf-8", errors="replace") as f:
                        content = f.read()
                self._json_response(200, {"content": content, "mime": mime, "size": stat.st_size, "path": rel_path, "sheet": sheet_text is not None})
            except OSError:
                self._json_response(500, {"error": "read failed"})
        else:
            import base64
            with open(full, "rb") as f:
                data = base64.b64encode(f.read()).decode()
            self._json_response(200, {"content": data, "mime": mime, "size": stat.st_size, "path": rel_path, "binary": True})

    def _sheet_as_text(self, full):
        try:
            with open(full, "rb") as f:
                raw = f.read()
        except OSError:
            return None
        if raw[:2] == b'PK':
            return None
        try:
            return raw.decode("utf-8")
        except UnicodeDecodeError:
            return None

    def _handle_files_post(self, body=None):
        if body is None:
            body = self._read_body()
            if body is None: return
        if not isinstance(body, dict):
            self._json_response(400, {"error": "expected JSON object"})
            return
        chat_id = body.get("chatId")
        if not _sanitize_chat_id(chat_id):
            self._json_response(400, {"error": "missing or invalid chatId"})
            return
        if "mkdir" in body:
            rel = body["mkdir"].strip("/")
            full = safe_path(rel, chat_id)
            if not full:
                self._json_response(400, {"error": "invalid path"})
                return
            os.makedirs(full, exist_ok=True)
            self._json_response(200, {"ok": True})
            return
        self._json_response(400, {"error": "use PUT to write files, POST with {chatId, mkdir} to create dirs"})

    def _handle_files_put(self):
        body = self._read_body()
        if body is None: return
        if not isinstance(body, dict):
            self._json_response(400, {"error": "expected JSON object"})
            return
        chat_id = body.get("chatId")
        if not _sanitize_chat_id(chat_id):
            self._json_response(400, {"error": "missing or invalid chatId"})
            return
        rel = body.get("path", "").strip("/")
        full = safe_path(rel, chat_id)
        if not full:
            self._json_response(400, {"error": "invalid path"})
            return
        with _get_file_lock(chat_id):
            os.makedirs(os.path.dirname(full), exist_ok=True)

            if body.get("append"):
                content = body.get("content", "")
                if not isinstance(content, str):
                    self._json_response(400, {"error": "content must be a string"})
                    return
                with open(full, "a", encoding="utf-8") as f:
                    f.write(content)
                self._json_response(200, {"ok": True, "path": rel, "appended": True})
                return

            old = body.get("old")
            new = body.get("new")
            if old is not None:
                if not isinstance(old, str) or not isinstance(new, str):
                    self._json_response(400, {"error": "old and new must be strings"})
                    return
                if not os.path.exists(full):
                    self._json_response(404, {"error": "file does not exist"})
                    return
                with open(full, "r", encoding="utf-8") as f:
                    content = f.read()
                if old not in content:
                    self._json_response(404, {"error": "old text not found in file"})
                    return
                content = content.replace(old, new, 1)
                with open(full, "w", encoding="utf-8") as f:
                    f.write(content)
                self._json_response(200, {"ok": True, "path": rel, "edited": True})
                return

            content = body.get("content", "")
            if isinstance(content, str):
                with open(full, "w", encoding="utf-8") as f:
                    f.write(content)
            elif isinstance(content, bytes):
                try:
                    import base64
                    data = base64.b64decode(content)
                except Exception:
                    self._json_response(400, {"error": "invalid base64 content"})
                    return
                with open(full, "wb") as f:
                    f.write(data)
            else:
                self._json_response(400, {"error": "invalid base64 content"})
                return
            self._json_response(200, {"ok": True, "path": rel})

    def _handle_files_run(self, body=None):
        if not RUN_SEM.acquire(timeout=1):
            self._json_response(503, {"error": "too many concurrent runs"})
            return
        try:
            if body is None:
                body = self._read_body()
                if body is None: return
            if not isinstance(body, dict):
                self._json_response(400, {"error": "expected JSON object"})
                return
            chat_id = body.get("chatId")
            if not _sanitize_chat_id(chat_id):
                self._json_response(400, {"error": "missing or invalid chatId"})
                return
            rel = body.get("path", "").strip("/")
            stdin_data = body.get("stdin", "")
            full = safe_path(rel, chat_id)
            if not full:
                self._json_response(400, {"error": "invalid path"})
                return
            if not os.path.isfile(full):
                self._json_response(404, {"error": "file not found"})
                return
            ext = os.path.splitext(rel)[1].lower()
            if ext not in RUNNABLE_EXTS:
                self._json_response(400, {"error": f"cannot run {ext} files"})
                return
            chat_dir = _chat_sandbox(chat_id)
            interpreters = {
                '.py': ['python3', full],
                '.sh': ['bash', full],
                '.js': ['node', full],
                '.ts': ['npx', 'ts-node', full],
                '.rb': ['ruby', full],
                '.pl': ['perl', full],
                '.php': ['php', full],
            }
            cmd = interpreters.get(ext)
            if not cmd:
                self._json_response(400, {"error": "unsupported file type"})
                return
            with _get_file_lock(chat_id):
                out_fd, out_path = tempfile.mkstemp(prefix="gooey-run-out-", suffix=".log")
                err_fd, err_path = tempfile.mkstemp(prefix="gooey-run-err-", suffix=".log")
                try:
                    with os.fdopen(out_fd, "wb") as out_f, os.fdopen(err_fd, "wb") as err_f:
                        proc = subprocess.Popen(
                            cmd, stdin=subprocess.PIPE, stdout=out_f, stderr=err_f, cwd=chat_dir
                        )
                        try:
                            proc.communicate(
                                input=stdin_data.encode("utf-8", "replace") if stdin_data else None,
                                timeout=RUN_TIMEOUT
                            )
                        except subprocess.TimeoutExpired:
                            try:
                                proc.kill()
                            except OSError:
                                pass
                            try:
                                proc.communicate()
                            except Exception:
                                pass
                            self._json_response(408, {"error": f"script timed out after {RUN_TIMEOUT}s"})
                            return
                    stdout_text = _tail_output(out_path)
                    stderr_text = _tail_output(err_path)
                except FileNotFoundError:
                    self._json_response(500, {"error": f"interpreter not found: {cmd[0]}"})
                    return
                except Exception:
                    self._json_response(500, {"error": "run failed"})
                    return
                finally:
                    try: os.unlink(out_path)
                    except OSError: pass
                    try: os.unlink(err_path)
                    except OSError: pass
                self._json_response(200, {
                    "stdout": stdout_text,
                    "stderr": stderr_text,
                    "exit_code": proc.returncode
                })
        finally:
            RUN_SEM.release()

    def _handle_files_delete(self):
        chat_id = self._get_chat_id_qs()
        if not _sanitize_chat_id(chat_id):
            self._json_response(400, {"error": "missing or invalid chatId"})
            return
        rel = self._parse_file_path()
        if not rel or rel in (".", ".."):
            self._json_response(400, {"error": "invalid path"})
            return
        full = safe_path(rel, chat_id)
        if not full:
            self._json_response(400, {"error": "invalid path"})
            return
        if full == os.path.realpath(_chat_sandbox(chat_id)):
            self._json_response(400, {"error": "cannot delete chat sandbox root"})
            return
        if not os.path.exists(full):
            self._json_response(404, {"error": "not found"})
            return
        try:
            if os.path.isdir(full):
                shutil.rmtree(full)
            else:
                os.unlink(full)
        except OSError:
            self._json_response(500, {"error": "delete failed"})
            return
        self._json_response(200, {"ok": True})

if __name__ == "__main__":
    try:
        with ThreadingHTTPServer((HOST, PORT), Handler) as server:
            print(f"Serving at http://{HOST}:{PORT}")
            server.serve_forever()
    except KeyboardInterrupt:
        print("\nBye!")
