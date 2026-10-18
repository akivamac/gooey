"""Regression tests for gooey server.py — the invariants the audit broke.

Run with Termux python (NOT the proot system python):
    /data/data/com.termux/files/usr/bin/python3.14 -m pytest -q tests/

Notes:
- STORAGE_FILE is monkeypatched to a temp path so real chats are never touched.
- Tests named test_*_after_fix encode CORRECT behavior; they may FAIL until the
  corresponding audit fix lands. A red -> green transition is the fix working.
"""
import importlib.util
import json
import http.client
import os
import pathlib
import sys
import threading

import pytest

ROOT = pathlib.Path(__file__).resolve().parents[1]


def _load_server(tmp_path, monkeypatch):
    """Import server.py fresh with storage redirected to tmp_path."""
    monkeypatch.setattr(sys, "path", [str(ROOT)] + sys.path)
    spec = importlib.util.spec_from_file_location("server_under_test", ROOT / "server.py")
    mod = importlib.util.module_from_spec(spec)
    monkeypatch.setattr(sys, "modules", {**sys.modules, "server_under_test": mod})
    spec.loader.exec_module(mod)
    monkeypatch.setattr(mod, "STORAGE_FILE", str(tmp_path / "storage.json"))
    monkeypatch.setattr(mod, "SANDBOX_ROOT", str(tmp_path / "sandbox"))
    pathlib.Path(mod.SANDBOX_ROOT).mkdir(parents=True, exist_ok=True)
    return mod


@pytest.fixture()
def srv(tmp_path, monkeypatch):
    return _load_server(tmp_path, monkeypatch)


# ---------- path traversal ----------

@pytest.mark.parametrize("evil", [
    "../etc/passwd",
    "..%2fetc%2fpasswd",   # decoding happens at the HTTP layer; here it's literal
    "/etc/passwd",         # leading slashes stripped -> sandbox-relative
    "a/../../b",
    "..\\windows",         # backslash is a literal char on POSIX
])
def test_safe_path_never_escapes_sandbox(srv, evil):
    """The real security invariant: result is None or strictly inside the chat dir."""
    chat_dir = srv._chat_sandbox("chat1")
    real = os.path.realpath(chat_dir)
    result = srv.safe_path(evil, "chat1")
    if result is not None:
        assert os.path.realpath(result) == real or \
            os.path.realpath(result).startswith(real + os.sep), \
            f"{evil!r} escaped to {result}"


def test_safe_path_accepts_normal(srv):
    p = srv.safe_path("sub/file.txt", "chat1")
    assert p is not None and p.endswith("sub/file.txt")
    assert ".." not in p


def test_chat_id_charset(srv):
    assert srv.safe_path("f.txt", "../evil") is None


# ---------- storage ----------

def test_storage_roundtrip(srv):
    data = {"revision": 1, "projects": {}, "conversations": {"c1": {"id": "c1"}}}
    srv.write_storage(data)
    assert srv.read_storage() == data


def test_corrupt_storage_archived(srv):
    with open(srv.STORAGE_FILE, "w") as f:
        f.write("{not json")
    out = srv.read_storage()
    assert out == {} or out.get("revision") == 0
    # the corrupt file must be archived, not silently deleted
    backups = list(pathlib.Path(srv.STORAGE_FILE).parent.glob("storage.json.corrupt.*"))
    assert backups, "corrupt storage should be archived"


def test_read_only_view_does_not_write(srv):
    srv.write_storage({"revision": 3, "projects": {}, "conversations": {}})
    srv.read_storage()
    assert json.load(open(srv.STORAGE_FILE))["revision"] == 3


# ---------- HTTP behavior ----------

class LiveServer:
    def __init__(self, mod, port):
        import socketserver
        class ReuseTCPServer(mod.ThreadingHTTPServer):
            allow_reuse_address = True
        self.httpd = ReuseTCPServer(("127.0.0.1", port), mod.Handler)
        self.port = port
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *a):
        self.httpd.shutdown()
        self.httpd.server_close()


def _req(port, method, path, body=None, headers=None):
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    hdrs = dict(headers or {})
    data = None
    if body is not None:
        data = json.dumps(body)
        hdrs.setdefault("Content-Type", "application/json")
    conn.request(method, path, body=data, headers=hdrs)
    resp = conn.getresponse()
    payload = resp.read()
    conn.close()
    return resp.status, payload


def test_storage_get_ok(srv):
    with LiveServer(srv, 8731) as s:
        status, payload = _req(s.port, "GET", "/api/storage")
    assert status == 200
    assert b"revision" in payload


def test_equal_revision_conflict_after_fix(srv):
    """Two writers with the same base revision: the second must get 409.

    Correct CAS semantics (audit issue: lost update between tabs). Fails on
    unfixed code where rev == old_rev is accepted.
    """
    def seed(rev):
        return {"revision": rev,
                "projects": {},
                "conversations": {"a": {"id": "a", "title": "t", "messages": []}}}
    with LiveServer(srv, 8732) as s:
        # first writer: posts 11 (base 10 + 1) -> accepted, becomes 11
        st1, _ = _req(s.port, "POST", "/api/storage", seed(11))
        # second writer also posts 11 (its base 10 + 1) -> must be rejected
        st2, _ = _req(s.port, "POST", "/api/storage", seed(11))
    assert st1 == 200, f"first writer should win, got {st1}"
    assert st2 == 409, f"second writer must conflict (lost update), got {st2}"


def test_remote_host_rejected_after_fix(srv):
    """A rebound/foreign Host must be refused (DNS-rebinding audit issue).

    Fails on unfixed code where GET does no host validation at all.
    """
    with LiveServer(srv, 8733) as s:
        status, _ = _req(s.port, "GET", "/api/storage",
                         headers={"Host": "evil.example:8733"})
    assert status == 403, f"foreign Host must be rejected, got {status}"


def test_origin_mismatch_rejected(srv):
    with LiveServer(srv, 8734) as s:
        status, _ = _req(s.port, "POST", "/api/storage",
                         body={"revision": 1, "projects": {},
                               "conversations": {}},
                         headers={"Origin": "http://evil.example"})
    assert status == 403


# ---------- vendor serving ----------

@pytest.mark.parametrize("evil", ["../server.py", "..%2fserver.py", "a/b.js", ""])
def test_vendor_traversal_and_whitelist(srv, evil):
    with LiveServer(srv, 8735) as s:
        status, _ = _req(s.port, "GET", f"/vendor/{evil}")
    assert status in (403, 404)


def test_vendor_whitelisted_file_served(srv):
    with LiveServer(srv, 8736) as s:
        status, payload = _req(s.port, "GET", "/vendor/marked.min.js")
    assert status == 200 and len(payload) > 0
