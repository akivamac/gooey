#!/data/data/com.termux/files/usr/bin/python3
"""gooey-cli: a lightweight Textual terminal client for gooey chat sessions.

A project is simply the folder you launch it from. Sessions are stored locally
(never mixed with browser/web chats) in ~/.gooey/sessions.json, keyed by the
project's absolute path. If that folder contains a gooey.md file, its text is
injected as system context into every session in that project.

Invocation (callable from any directory):
    gooey               start a new session in the current folder
    gooey -r <id>       resume a session by id in the current folder
    gooey list          print all sessions in the current folder (no pager)
    gooey --help        this help

Chat streams from the local Ollama instance (http://127.0.0.1:11434) directly;
the CLI never loads a model, so RAM stays low. The gooey server (:8000) is used
only for web search and extra-info lookup, not for storing sessions.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
import threading
import time
import urllib.request
import urllib.parse


import re
import functools

from rich.text import Text

from textual.app import App
from textual.containers import Horizontal, Vertical
from textual.widgets import (
    Button, Input, Label, RichLog, Select, Static, ContentSwitcher,
)

MAX_SESSION_MSGS = 200     # cap stored messages (pairs) to bound RAM + disk
HISTORY_TO_LLM = 40        # only send the last N messages to Ollama
UI_REFRESH_HZ = 10.0       # live-bubble redraw rate
SAVE_FLUSH_SECS = 3.0      # max delay between session disk flushes
CONTEXT_TTL_SECS = 30.0    # how often gooey.md is re-read

_sessions_lock = threading.Lock()


SERVER_DEFAULT = "http://127.0.0.1:8000"
OLLAMA_DEFAULT = "http://127.0.0.1:11434"

SERVER = SERVER_DEFAULT
OLLAMA = OLLAMA_DEFAULT


# --------------------------------------------------------------------------
# Thin HTTP helpers (stdlib only; used for models + search + info)
# --------------------------------------------------------------------------

def _json_body(resp):
    try:
        return json.loads(resp.read().decode("utf-8", "replace"))
    except Exception:
        return {}


def http_get(url, timeout=20):
    req = urllib.request.Request(url)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.status, r.headers, _json_body(r), r.read()


def get_models():
    try:
        _, _, body, _ = http_get(OLLAMA + "/api/tags", timeout=8)
        names = [m.get("name") for m in (body.get("models") or [])]
        return [n for n in names if n]
    except Exception:
        return []


def stream_chat(messages, model, options=None):
    """Yield text chunks from Ollama's streaming /api/chat."""
    payload = {
        "model": model,
        "messages": messages,
        "stream": True,
        "options": options or {},
    }
    req = urllib.request.Request(
        OLLAMA + "/api/chat",
        data=json.dumps(payload).encode("utf-8"),
        method="POST",
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=600) as r:
        buf = ""
        while True:
            chunk = r.read(4096)
            if not chunk:
                break
            buf += chunk.decode("utf-8", "replace")
            while "\n" in buf:
                line, buf = buf.split("\n", 1)
                line = line.strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                except Exception:
                    continue
                msg = obj.get("message") or {}
                content = msg.get("content")
                if content:
                    yield content
                if obj.get("done"):
                    return


def web_search(query):
    try:
        url = SERVER + "/api/search?q=" + urllib.parse.quote(query)
        _, _, body, _ = http_get(url, timeout=30)
        return body.get("results") or []
    except Exception:
        return []


# --------------------------------------------------------------------------
# Local session store (project = launch folder)
# --------------------------------------------------------------------------

def sessions_path():
    return os.path.join(os.path.expanduser("~"), ".gooey", "sessions.json")


def load_sessions():
    try:
        with open(sessions_path(), "r", encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, dict):
            return data
    except Exception:
        print("Warning: {} is corrupt; starting with no sessions".format(sessions_path()), file=sys.stderr)
    return {}


def save_sessions(data):
    path = sessions_path()
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), suffix=".tmp")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump(data, f, indent=None, separators=(",", ":"))
        except Exception:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise
        os.replace(tmp, path)
    except Exception:
        pass


def sessions_for_folder(folder):
    with _sessions_lock:
        return load_sessions().get(os.path.realpath(folder) or folder, [])


def put_session(folder, session):
    with _sessions_lock:
        data = load_sessions()
        key = os.path.realpath(folder) or folder
        lst = data.setdefault(key, [])
        for i, s in enumerate(lst):
            if s.get("id") == session.get("id"):
                lst[i] = session
                break
        else:
            lst.append(session)
        lst.sort(key=lambda s: s.get("updated") or 0, reverse=True)
        save_sessions(data)


def get_project_context(folder):
    """Return (text_or_None, mtime_or_None) from <folder>/gooey.md if present."""
    path = os.path.join(folder, "gooey.md")
    try:
        if os.path.isfile(path):
            with open(path, "r", encoding="utf-8", errors="replace") as f:
                return f.read(), os.path.getmtime(path)
    except Exception:
        pass
    return None, None


# --------------------------------------------------------------------------
# Sub-agent orchestration (memory-only; RAM-gated so 2× 7B can't run at once)
# --------------------------------------------------------------------------

RAM_LIMIT_GB = 8.0
# size-class -> estimated loaded GB. Use these to gate concurrency.
MODEL_GB = {"1.5b": 1.5, "3b": 3.0, "7b": 7.0, "unknown": 2.0}
SUBAGENT_DEFAULT = "3b"          # sub-agents default to a small model
AGENT_TRANSCRIPT_MAX = 200       # memory-only; cap lines per agent


def _model_class(display):
    d = (display or "").lower()
    if "7b" in d:
        return "7b"
    if "3b" in d:
        return "3b"
    if "1.5b" in d or "1b" in d:
        return "1.5b"
    return "unknown"


class SubAgent:
    """One background sub-agent. State is memory-only (discarded on exit)."""

    def __init__(self, aid, goal, model, gb):
        self.id = aid
        self.goal = goal
        self.model = model
        self.gb = gb
        self.phase = "queued"          # queued|loading|generating|running_tool|done|failed
        self.heartbeat = "waiting to start"
        self.buffer = ""
        self.lines = []                # transcript, capped
        self.result = None
        self.child_ids = []            # agents this one spawned (for descent)


class AgentPool:
    def __init__(self, limit_gb=RAM_LIMIT_GB):
        self.limit_gb = limit_gb
        self.agents = {}
        self.order = []

    def reserved_gb(self):
        return sum(a.gb for a in self.agents.values())

    def can_spawn(self, gb):
        return self.reserved_gb() + gb <= self.limit_gb

    def gb_for_display(self, model):
        return MODEL_GB.get(_model_class(model), MODEL_GB["unknown"])

    def spawn(self, goal, model):
        gb = self.gb_for_display(model)
        if not self.can_spawn(gb):
            return None, "out of RAM ({}GB reserved of {}GB); {} would add {}GB".format(
                round(self.reserved_gb(), 1), self.limit_gb, model, gb)
        aid = "A" + str(len(self.order) + 1) + "_" + str(int(time.time() * 1000))[-5:]
        while aid in self.agents:
            aid = "A" + str(len(self.order) + 1) + "_" + str(int(time.time() * 1000) + 1)[-5:]
        agent = SubAgent(aid, goal, model, gb)
        self.agents[aid] = agent
        self.order.append(aid)
        return agent, None

    def free(self, aid):
        a = self.agents.pop(aid, None)
        if a and aid in self.order:
            self.order.remove(aid)
        return a

    def children_of(self, aid):
        a = self.agents.get(aid)
        if not a:
            return [x for x in self.order if not any(c in self.agents for c in [])]
        return [self.agents[c] for c in a.child_ids if c in self.agents]


# --------------------------------------------------------------------------
# Textual application
# --------------------------------------------------------------------------

class GooeyApp(App):
    TITLE = "gooey-cli"
    CSS = """
    #root {
        layout: vertical;
        height: 1fr;
    }
    #header {
        height: 3;
        background: $panel;
        padding: 0 1;
        align: left middle;
    }
    #title-label {
        text-style: bold reverse;
        color: $accent;
        padding: 0 1;
    }
    #meta-label {
        text-style: italic;
        color: $text-muted;
        padding: 1;
    }
    #messages {
        height: 1fr;
        border: round $accent;
        background: $surface;
        margin: 0 0 1 0;
    }
    #live-bubble {
        height: auto;
        min-height: 0;
        border: round $primary;
        background: $panel;
        padding: 0 1;
        margin: 0 0 1 0;
    }
    #controls {
        height: auto;
        padding: 0 0 1 0;
        align: left middle;
    }
    #model-pick {
        width: 28;
        margin-right: 1;
    }
    #input {
        margin: 0 0 1 0;
    }
    #statusbar {
        height: 1;
        color: $text-muted;
        padding: 0 1;
        background: $panel;
    }
    #send-btn, #stop-btn, #new-btn, #regen-btn, #export-btn {
        min-width: 8;
    }
    """

    BINDINGS = [
        ("ctrl+n", "new_session", "New session"),
        ("ctrl+e", "export", "Export session"),
        ("ctrl+r", "regenerate", "Regenerate"),
        ("ctrl+s", "focus_input", "Focus input"),
        ("ctrl+q", "quit", "Quit"),
        ("escape", "focus_input", "Focus input"),
    ]

    def __init__(self, project, resume_id=None, **kwargs):
        super().__init__(**kwargs)
        self.project = os.path.realpath(project)
        self.resume_id = resume_id
        self.sessions = []
        self.models = []
        self.model = None
        self.active_id = None
        self.assistant_buffer = ""
        self.streaming = False
        self._stop = False
        self._errored = False
        self._ctx_text = None
        self._ctx_mtime = None
        self._ctx_check_time = 0.0
        self._last_flush = 0.0
        self._last_ui = 0.0
        self.pool = AgentPool()
        self.focus_stack = []        # [] = parent; [aid, ...] = descended path
        self._x_pending = False
        self._agent_refresh = 0.0

    # ------------------------------------------------------------------ data

    def _load_project_sessions(self):
        self.sessions = sessions_for_folder(self.project)

    def _active_session(self):
        for s in self.sessions:
            if s.get("id") == self.active_id:
                return s
        return None

    def resolve_session(self):
        sess = None
        if self.resume_id:
            wanted = self.resume_id
            for s in self.sessions:
                if s.get("id") == wanted:
                    sess = s
                    break
            if sess is None:
                print("Session {} not found in {}; starting a new session.".format(
                    wanted, self.project), file=sys.stderr)
                self.resume_id = None
        if sess is None and self.sessions:
            sess = self.sessions[0]
        if sess is None:
            sid = str(int(time.time() * 1000))
            sess = {
                "id": sid,
                "title": "New session",
                "messages": [],
                "model": None,
                "created": time.time(),
                "updated": time.time(),
            }
            self.sessions.insert(0, sess)
            put_session(self.project, sess)
        self.active_id = sess["id"]
        return sess

    def save_session(self, sess, persist=True):
        sess["updated"] = time.time()
        if persist:
            put_session(self.project, sess)

    def refresh_models(self):
        if not self.models:
            self.models = get_models()
            if self.models and not self.model:
                self.model = self.models[0]

    def ensure_context(self):
        """Load gooey.md as system context; re-check at most every ~30s."""
        now = time.monotonic()
        if now - self._ctx_check_time < CONTEXT_TTL_SECS and self._ctx_text is not None:
            return self._ctx_text
        self._ctx_check_time = now
        text, mtime = get_project_context(self.project)
        if mtime is not None and (text, mtime) != (self._ctx_text, self._ctx_mtime):
            self._ctx_text = text
            self._ctx_mtime = mtime
        return self._ctx_text

    def build_ollama_messages(self, sess):
        ctx = self.ensure_context()
        msgs = []
        if ctx and ctx.strip():
            msgs.append({"role": "system", "content": ctx})
        history = sess.get("messages", [])[-HISTORY_TO_LLM:]
        for m in history:
            role = m.get("role")
            # skip empty assistant placeholders (not yet filled in)
            if role == "assistant" and not (m.get("content") or "").strip():
                continue
            if role in ("user", "assistant"):
                msgs.append({"role": role, "content": m.get("content") or ""})
        return msgs

    # ------------------------------------------------------------------ ui

    def compose(self):
        with Vertical(id="root"):
            with ContentSwitcher(id="switcher"):
                with Vertical(id="chat-view"):
                    with Horizontal(id="header"):
                        yield Label("gooey-cli", id="title-label")
                        self.meta_label = Label("", id="meta-label")
                        yield self.meta_label
                    self.messages = RichLog(wrap=True, highlight=False, markup=False, id="messages", max_lines=500)
                    yield self.messages
                    self.live_bubble = Static("", id="live-bubble", markup=True)
                    yield self.live_bubble
                    with Horizontal(id="controls"):
                        self.model_pick = Select(
                            options=[(str(m), m) for m in self.models] or [("(no models)", None)],
                            value=None, allow_blank=True, prompt="Model", id="model-pick",
                        )
                        yield self.model_pick
                        self.send_btn = Button("Send", id="send-btn", variant="primary")
                        yield self.send_btn
                        self.stop_btn = Button("Stop", id="stop-btn", disabled=True, variant="error")
                        yield self.stop_btn
                        self.new_btn = Button("New", id="new-btn")
                        yield self.new_btn
                        self.regen_btn = Button("Regen", id="regen-btn")
                        yield self.regen_btn
                        self.export_btn = Button("Export", id="export-btn")
                        yield self.export_btn
                    self.input = Input(placeholder="Message (Enter to send, Ctrl+Q to quit)", id="input")
                    yield self.input
                with Vertical(id="agent-view"):
                    self.agent_title = Static("Sub-agents", id="agent-title")
                    yield self.agent_title
                    self.agent_body = RichLog(wrap=True, highlight=False, markup=True, id="agent-body", max_lines=400)
                    yield self.agent_body
            self.statusbar = Static("", id="statusbar")
            yield self.statusbar

    def on_mount(self):
        self.switcher = self.query_one("#switcher", ContentSwitcher)
        self.agent_body = self.query_one("#agent-body", RichLog)
        self.switcher.current = "chat-view"
        self.refresh_models()
        self._load_project_sessions()
        sess = self.resolve_session()
        self.ensure_context()
        if self.models:
            self.model_pick.set_options([(str(m), m) for m in self.models])
            if sess.get("model"):
                self.model_pick.value = sess["model"]
                self.model = sess["model"]
            elif self.model:
                self.model_pick.value = self.model
        self.update_header()
        self.redraw_messages()
        self.input.focus()

    def update_header(self):
        sess = self._active_session()
        sid = sess.get("id") if sess else "-"
        ctx = "  [gooey.md context]" if self._ctx_text else ""
        name = os.path.basename(self.project) or self.project
        model = sess.get("model") or "no model"
        self.meta_label.update("{}  ·  session {}  ·  {}{}".format(name, sid[-6:], model, ctx))

    @staticmethod
    def _chat_line(label, style, content):
        t = Text()
        t.append(label + " ", style=style)
        t.append(str(content))
        return t

    def redraw_messages(self):
        self.messages.clear()
        sess = self._active_session()
        if not sess:
            return
        for m in sess.get("messages", []):
            if m.get("role") == "system":
                continue
            if m["role"] == "user":
                self.messages.write(self._chat_line("You:", "bold green", m.get("content") or ""))
            else:
                self.messages.write(self._chat_line("gooey:", "bold cyan", m.get("content") or ""))
        self.messages.scroll_end(animate=False)

    def append_user_to_log(self, text):
        self.messages.write(self._chat_line("You:", "bold green", text))
        self.messages.scroll_end(animate=False)

    def set_status(self, msg):
        self.statusbar.update(msg)

    # ------------------------------------------------------------------ actions

    def action_new_session(self):
        if self.streaming:
            self.set_status("Stop the current reply first (Stop button).")
            return
        self.resume_id = None
        sess = self.resolve_session()
        self.update_header()
        self.redraw_messages()
        self.input.focus()
        self.set_status("New session")

    def action_export(self):
        self._export_worker()

    def action_regenerate(self):
        if self.streaming:
            self.set_status("Already streaming.")
            return
        self._regenerate_worker()

    def action_focus_input(self):
        self.input.focus()

    def action_quit(self):
        self.exit()

    # ------------------------------------------------------------------ send

    def on_button_pressed(self, event: Button.Pressed):
        if event.button is self.send_btn:
            self.submit_input()
        elif event.button is self.stop_btn:
            self.stop_stream()
        elif event.button is self.new_btn:
            self.action_new_session()
        elif event.button is self.regen_btn:
            self.action_regenerate()
        elif event.button is self.export_btn:
            self.action_export()

    def on_input_submitted(self, event: Input.Submitted):
        self.submit_input()

    def on_select_changed(self, event: Select.Changed):
        if event.select is self.model_pick and event.value:
            self.model = event.value
            sess = self._active_session()
            if sess:
                sess["model"] = self.model
                self.save_session(sess)

    def submit_input(self):
        text = self.input.value
        if not text or not text.strip():
            return
        stripped = text.strip()
        if stripped.startswith("/spawn"):
            self.input.value = ""
            self._spawn_from_command(stripped)
            return
        if self.streaming:
            self.set_status("Still streaming; press Stop first.")
            return
        if not self.model:
            self.refresh_models()
            if not self.models:
                self.set_status("No Ollama models reachable.")
                return
            self.model = self.model_pick.value or self.models[0]
        self.input.value = ""
        sess = self._active_session()
        if not sess:
            sess = self.resolve_session()
        if not sess.get("title") or sess.get("title") == "New session":
            sess["title"] = stripped[:40]
        sess["messages"].append({"role": "user", "content": stripped, "ts": time.time()})
        sess["messages"].append({"role": "assistant", "content": "", "ts": time.time()})
        sess["model"] = self.model
        self.save_session(sess)
        self.append_user_to_log(stripped)
        self.assistant_buffer = ""
        self.streaming = True
        self._errored = False
        self.render_stop_button(True)
        self.run_worker(self._chat_worker, name="chat", group="chat", thread=True)
        self.input.focus()

    def stop_stream(self):
        self._stop = True

    def render_stop_button(self, on):
        self.stop_btn.disabled = not on
        self.send_btn.disabled = on

    # ------------------------------------------------------------------ workers

    def _chat_worker(self):
        self._stop = False
        self._errored = False
        stop = False
        sid = self.active_id
        sess = self._active_session()
        idx = len(sess["messages"]) - 1
        dolog = self.call_from_thread
        if sess is None or idx < 0 or sess["messages"][idx].get("role") != "assistant":
            self._stop = False
            if self.active_id == sid:
                self.streaming = False
                dolog(self.render_stop_button, False)
                dolog(self.set_status, "Nothing to answer")
            return
        msgs = self.build_ollama_messages(sess)
        last_flush = time.monotonic()
        last_ui = 0.0

        def write_chunk(content):
            if self.active_id == sid:
                dolog(self.live_bubble.update, "[bold cyan]gooey:[/bold cyan] " + content)

        def commit_display():
            if self.active_id != sid:
                return
            dolog(self.live_bubble.update, "")
            dolog(self.messages.write, self._chat_line("gooey:", "bold cyan", sess["messages"][idx].get("content") or ""))
            dolog(self.messages.scroll_end, animate=False)

        try:
            for chunk in stream_chat(msgs, self.model):
                if self._stop:
                    break
                if idx < len(sess["messages"]):
                    sess["messages"][idx]["content"] += chunk
                self.assistant_buffer += chunk
                now = time.monotonic()
                if now - last_ui >= 1.0 / UI_REFRESH_HZ:
                    last_ui = now
                    write_chunk(self.assistant_buffer)
                if now - last_flush >= SAVE_FLUSH_SECS:
                    last_flush = now
                    self.save_session(sess, persist=True)
            stop = self._stop
            if stop:
                if idx < len(sess["messages"]):
                    sess["messages"][idx]["content"] += "\n\n*[stopped]*"
            commit_display()
            self._cap_session_messages(sess)
        except Exception as e:
            self._errored = True
            if idx < len(sess["messages"]):
                sess["messages"][idx]["content"] = (sess["messages"][idx]["content"] or "") + "\n\n*[Error: {}]*".format(e)
            dolog(self.live_bubble.update, "")
            if self.active_id == sid:
                dolog(self.messages.write, self._chat_line("gooey:", "bold cyan", sess["messages"][idx].get("content") or ""))
                dolog(self.messages.scroll_end, animate=False)
            dolog(self.set_status, "Error: " + str(e))
        finally:
            dolog(self.live_bubble.update, "")
            if idx < len(sess["messages"]):
                self._cap_session_messages(sess)
            self.save_session(sess, persist=True)
            if self.active_id == sid:
                self.streaming = False
                dolog(self.render_stop_button, False)
                if self._errored:
                    dolog(self.set_status, "Error")
                elif stop:
                    dolog(self.set_status, "Stopped")
                else:
                    dolog(self.set_status, "Done")
            self._stop = False

    def _cap_session_messages(self, sess):
        """Trim stored messages to bound RAM + disk, keeping the system ctx."""
        msgs = sess.get("messages") or []
        if len(msgs) <= MAX_SESSION_MSGS:
            return
        head = msgs[0] if msgs and msgs[0].get("role") == "system" else None
        kept = msgs[-MAX_SESSION_MSGS:]
        if head:
            kept.insert(0, head)
        sess["messages"] = kept

    def _regenerate_worker(self):
        sess = self._active_session()
        if not sess or not sess.get("messages"):
            return
        while sess["messages"] and sess["messages"][-1]["role"] == "assistant":
            sess["messages"].pop()
        self.save_session(sess)
        self.redraw_messages()
        self.input.focus()
        self.set_status("Last reply removed. Type a new message or press Send.")

    def _export_worker(self):
        sess = self._active_session()
        if not sess:
            self.set_status("No session to export.")
            return
        title = (sess.get("title") or "session").replace(" ", "_")
        lines = ["# " + (sess.get("title") or "session"), ""]
        for m in sess.get("messages", []):
            if m.get("role") == "system":
                continue
            who = "You" if m["role"] == "user" else "Assistant"
            lines.append("## " + who + "\n")
            lines.append(str(m.get("content") or "") + "\n")
        md = "\n".join(lines)
        fname = "gooey-export-{}.md".format(re.sub(r"[^A-Za-z0-9]", "_", title))
        outpath = os.path.join(self.project, fname)
        try:
            with open(outpath, "w", encoding="utf-8") as f:
                f.write(md)
            self.set_status("Exported to " + outpath)
        except Exception as e:
            self.set_status("Export failed: " + str(e))

    # ------------------------------------------------------------------ sub-agent orchestration

    def _spawn_from_command(self, stripped):
        parts = stripped.split(None, 1)
        goal = parts[1].strip() if len(parts) > 1 else ""
        if not goal:
            self.set_status("Usage: /spawn <goal>  [model:name]")
            return
        model = self.model or SUBAGENT_DEFAULT
        if "model:" in goal:
            goal, model = goal.split("model:", 1)
            goal = goal.rstrip()
            model = model.strip().split()[0]
        if _model_class(model) == "7b" and self.pool.reserved_gb() > 0:
            self.set_status("7B sub-agent refused: already {}GB reserved (one 7B at a time).".format(
                round(self.pool.reserved_gb(), 1)))
            return
        agent, err = self.pool.spawn(goal, model)
        if agent is None:
            self.set_status("Cannot spawn {}: {}".format(model, err))
            return
        self.set_status("Spawned {} on {} ({}GB) — Ctrl+X ↓ to watch".format(agent.id, model, agent.gb))
        self.run_worker(functools.partial(self._agent_worker, agent.id),
                        name="agent-" + agent.id, group="agents", thread=True)

    def _agent_worker(self, aid):
        agent = self.pool.agents.get(aid)
        if agent is None:
            return
        dolog = self.call_from_thread
        ctx = self._ctx_text or ""
        msgs = [
            {"role": "system", "content": (ctx + "\n\n" if ctx else "") + "You are a focused sub-agent."},
            {"role": "user", "content": agent.goal},
        ]
        try:
            agent.phase = "loading"
            agent.heartbeat = "loading model…"
            self._touch_agent(agent)
            tmp = ""
            for chunk in stream_chat(msgs, agent.model):
                tmp += chunk
                agent.buffer = tmp
                agent.heartbeat = "thinking / writing ({})".format(len(tmp))
                if len(agent.buffer) > 0 and len(agent.buffer) % 200 < 20:
                    self._touch_agent(agent)
            agent.phase = "done"
            agent.result = agent.buffer.replace("\n", "").strip()
            agent.heartbeat = "finished"
        except Exception as e:
            agent.phase = "failed"
            agent.heartbeat = "error: " + str(e)
        finally:
            self._touch_agent(agent)
            self.pool.free(aid)

    def _touch_agent(self, agent):
        now = time.monotonic()
        if now - self._agent_refresh < 1.0 / UI_REFRESH_HZ:
            return
        self._agent_refresh = now
        try:
            self.call_from_thread(self._refresh_agent_view)
        except Exception:
            pass

    def _refresh_agent_view(self):
        if self.switcher.current == "agent-view":
            self._render_agent_view()
        self._update_agent_summary()

    def _render_agent_view(self, aid=None):
        body = self.agent_body
        if aid is None:
            aid = self.focus_stack[-1] if self.focus_stack else (
                next((a for a in self.pool.order if a in self.pool.agents), None))
        body.clear()
        if not aid or aid not in self.pool.agents:
            self.agent_title.update("Sub-agents")
            body.write(Text("No sub-agents running yet.\nType /spawn <goal> ...", style="dim"))
            return
        a = self.pool.agents[aid]
        self.agent_title.update("{}  ·  {}  ·  {}GB".format(a.id, a.model, a.gb))
        lines = [
            ("[bold]phase:[/bold] " + a.phase, "bold"),
            ("[bold]now:[/bold] " + (a.heartbeat or ""), ""),
            ("[bold]RAM:[/bold] {}GB reserved of {}GB\n".format(round(self.pool.reserved_gb(), 1),
                                                               RAM_LIMIT_GB), ""),
            ("\n[bold]goal:[/bold] " + (a.goal or ""), ""),
            ("\n[bold]output[/bold]\n" + (a.buffer or ""), ""),
        ]
        for text, style in lines:
            body.write(Text(text, style=style) if style else Text(text))
        body.scroll_end(animate=False)

    def _update_agent_summary(self):
        if not self.pool.order:
            return
        s = ", ".join(
            "{} {} {}".format(aid, self.pool.agents[aid].phase, (self.pool.agents[aid].heartbeat or "")[:40])
            for aid in self.pool.order if aid in self.pool.agents)
        self.statusbar.update("agents: " + s + "   |   Ctrl+X ↓ watch   ← → switch   ↑ back")

    def _switch_to_agent_view(self, aid=None):
        self._render_agent_view(aid)
        self.switcher.current = "agent-view"
        self._update_agent_summary()

    def _current_siblings(self):
        if not self.focus_stack:
            return [self.pool.agents[a] for a in self.pool.order if a in self.pool.agents]
        parent = self.pool.agents.get(self.focus_stack[-1])
        if parent is None:
            return []
        return [self.pool.agents[c] for c in parent.child_ids if c in self.pool.agents]

    def _descend(self):
        kids = self._current_siblings()
        if kids:
            self.focus_stack.append(kids[0].id)
            self._switch_to_agent_view(kids[0].id)
            return True
        return False

    def _next_sibling(self, delta):
        if not self.focus_stack:
            return
        kids = self._current_siblings()
        if not kids:
            return
        cur = self.focus_stack[-1]
        idx = next((i for i, k in enumerate(kids) if k.id == cur), -1)
        nxt = kids[(idx + delta) % len(kids)].id
        self.focus_stack[-1] = nxt
        self._switch_to_agent_view(nxt)

    def _climb_up(self):
        if not self.focus_stack:
            return
        self.focus_stack.pop()
        if self.focus_stack:
            self._switch_to_agent_view(self.focus_stack[-1])
        else:
            self.switcher.current = "chat-view"
            self._update_agent_summary()

    def on_key(self, event):
        k = event.key
        ctrl_multikey = self._x_pending and k == "down"
        if self._x_pending and k == "ctrl+x":
            ctrl_multikey = True
        nav = ((k == "right" or k == "left" or k == "up") and bool(self.focus_stack))
        if self._x_pending and not (ctrl_multikey or k == "down"):
            self._x_pending = False
        if not (k == "ctrl+x" or ctrl_multikey or nav):
            return
        event.prevent_default()
        if k == "ctrl+x":
            self._x_pending = True
        elif ctrl_multikey:
            self._x_pending = False
            self._descend()
        elif k == "right":
            self._next_sibling(1)
        elif k == "left":
            self._next_sibling(-1)
        elif k == "up":
            self._climb_up()


def print_sessions(folder):
    """Print sessions for a project folder to the terminal (no pager)."""
    folder = os.path.realpath(folder)
    name = os.path.basename(folder) or folder
    sessions = sessions_for_folder(folder)
    print("{}: {} sessions".format(name, len(sessions)))
    if not sessions:
        print("  (no sessions yet — run `gooey` in this folder to start one)")
        return
    for s in sessions:
        sid = s.get("id", "?")
        title = (s.get("title") or "Untitled")
        model = s.get("model") or "?"
        n = len([m for m in s.get("messages", []) if m.get("role") in ("user", "assistant")])
        t = time.strftime("%Y-%m-%d %H:%M", time.localtime(s.get("updated") or 0))
        print("  {:<15} {:>3} msgs  {:<14} {:<30} {}".format(sid, n, model, title[:28], t))
    print("\nResume:  gooey -r <id>")


def main(argv=None):
    global SERVER, OLLAMA
    ap = argparse.ArgumentParser(prog="gooey", description="gooey terminal client (sessions are per-folder)")
    ap.add_argument("--server", default=SERVER_DEFAULT, help="gooey server base URL (search/info only)")
    ap.add_argument("--ollama", default=OLLAMA_DEFAULT, help="Ollama base URL")
    ap.add_argument("-r", "--resume", metavar="ID", default=None, help="resume a session by id in the current folder")
    ap.add_argument("-d", "--dir", default=None, help="project folder (default: current directory)")
    ap.add_argument("list", nargs="?", const=True, default=None, help="list sessions in the project folder")
    args = ap.parse_args(argv)
    SERVER = args.server
    OLLAMA = args.ollama
    folder = os.path.realpath(args.dir or os.getcwd())
    if args.list:
        print_sessions(folder)
        return 0
    app = GooeyApp(folder, resume_id=args.resume)
    try:
        app.run()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
