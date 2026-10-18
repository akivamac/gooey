# gooey

A local LLM chat app that runs on top of [Ollama](https://ollama.com). No cloud, no accounts — the model runs on your machine and your chats never leave it.

Built to run well on low-resource devices (it lives in Termux on an Android tablet), with a small stdlib-only Python server and a plain-JS frontend.

## Features

- **Chat with local models** — streams straight from Ollama (`http://127.0.0.1:11434` by default, changeable in the UI)
- **Projects** — group chats into projects, each with its own settings
- **Markdown rendering** — code blocks with syntax highlighting, collapsible long output, copy buttons, image attachments
- **File tools** — the model can create/edit/read files in a sandboxed working folder, plus run code (`.py`, `.sh`, `.js`, `.ts`, `.rb`, `.pl`, `.php`) with a 30s timeout
- **Web search** — server-side search the model can use for up-to-date answers
- **extra-info** — an `extra-info.md` file the model reads and searches on demand, so it can remember facts about you or your device without a restart
- **PWA** — installable, works offline for the UI part
- **Dark/light theme**, conversation search, export as markdown

## Components

| File | What it is |
| --- | --- |
| `server.py` | Zero-dependency Python HTTP server — serves the UI, storage, file sandbox, code runner, search |
| `index.html`, `app.js`, `style.css` | The web UI (vanilla JS, no build step) |
| `gooey_cli.py` | A Textual terminal client for the same chats |
| `vendor/` | Locally vendored marked, DOMPurify, highlight.js (so it works offline) |

## Safety disclaimer

This is hobby open-source software by a beginner developer. **Nothing here is guaranteed safe to use.** It has not been professionally audited, penetration-tested, or verified in any way, and there is no warranty of any kind.

Be especially aware that:

- the **code runner executes model-generated code as your own user** — treat it like running any random script you found on the internet
- the server binds to localhost but has **not been hardened** against hostile local processes or browser-based attacks (DNS rebinding)
- your chats live in a plain `storage.json` with no encryption

Use at your own risk, read the code yourself, and don't point it at anything you can't afford to lose. Known issues are tracked in the [issue tracker](https://github.com/akivamac/gooey/issues) with the `audit` label.

## Quick start

Requires Python 3 and a running Ollama instance.

```sh
git clone https://github.com/akivamac/gooey.git
cd gooey
python3 server.py
```

Open http://127.0.0.1:8000.

### Terminal client

`gooey_cli.py` is a Textual TUI that talks to the same Ollama instance directly (sessions stored separately in `~/.gooey/sessions.json`, keyed by the folder you launch it from). If the folder contains a `gooey.md`, its text is injected as system context.

```sh
pkg install textual   # or: pip install textual
python3 gooey_cli.py          # new session in the current folder
python3 gooey_cli.py -r <id>  # resume a session
python3 gooey_cli.py list     # list sessions for this folder
```

## How it works

- Chats are stored in `storage.json` (atomic writes, corruption is auto-archived rather than fatal).
- Files the model touches live in `sandbox/`, and code runs there under per-extension and concurrency limits.
- Everything binds to `127.0.0.1` — nothing is exposed to the network unless you say so.

## License

No license attached yet.
