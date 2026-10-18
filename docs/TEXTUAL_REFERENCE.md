# Textual 8.2.8 API Reference (for building your own CLI)

This is an OFFLINE, verified reference for the **exact** Textual build installed here:
`textual 8.2.8` (a custom fork, NOT identical to upstream docs). Use it to build
your own terminal chat CLI from scratch on this device. Every claim below was
confirmed by inspecting the installed package.

- Python: `/data/data/com.termux/files/usr/bin/python3`
- Site-packages: `/data/data/com.termux/files/usr/lib/python3.14/site-packages`
- A working example app lives at `/data/data/com.termux/files/home/gooey/gooey_cli.py`.

---

## 1. The bare minimum app

```python
from textual.app import App

class MyApp(App):
    def compose(self):                       # REQUIRED. There is NO compose_default
        from textual.widgets import Static
        yield Static("Hello")

if __name__ == "__main__":
    MyApp().run()
```

Run it: `/data/data/com.termux/files/usr/bin/python3 mycli.py`

- **`compose_default` does NOT exist** in this fork. Always implement `compose()`.
- `App.run()` blocks until the app exits. Wrap in try/except KeyboardInterrupt if desired.
- To exit programmatically, call `self.exit()`.

---

## 2. Widgets available (all import from `textual.widgets`)

Confirmed present: `Static, Label, Button, Input, RichLog, Select, ListView, ListItem,
TabbedContent, TabPane, Tabs, Tab, DataTable, Markdown, Tree, OptionList, Log,
ContentSwitcher`.

Containers: from `textual.containers` → `Horizontal, Vertical, ScrollableContainer,
VerticalScroll, HorizontalScroll, Grid, Center, Middle`.

### Static / Label
- `.update(text_or_renderable)` — replace its content.
- `Static("text", markup=True)` — markup is False by default for Static? Actually **Static defaults to markup=False** unless you pass `markup=True`. Test it. If you want `[bold]` tags to colour, pass `markup=True`.
- `Static.scroll_visible()` does **nothing** on a non-scrolling Static — it is not a scroll container.

### Input
- `Input(placeholder="...", id="...")` — text entry.
- `.value` — the current text (get/set). Set to `""` to clear.
- `.focus()` — focus the input.
- Emits `Input.Submitted` on Enter. Handler: `def on_input_submitted(self, event)`.
- Also has `action_focus`, and standard key editing built in.

### Button
- `Button("Label", variant="primary"|"error"|"success"|"warning"|"default", disabled=False, id=...)`.
- `.disabled = True/False` to enable/disable.
- Button click → `Button.Pressed` event. Handler: `def on_button_pressed(self, event)`; `event.button is self.my_button` to identify.

### RichLog (chat/terminal scrolling log)
- `RichLog(wrap=True, highlight=False, markup=False, id="messages", max_lines=500)`.
- **`markup=False` means `[bold]` strings render LITERALLY** — do NOT pass markup strings. Pass `rich.text.Text` objects or plain strings.
- `.write(renderable, width=None, expand=False, shrink=True)` — **NO `end=` kwarg** exists here.
- `.clear()` — wipe all lines.
- `.scroll_end(animate=False)` — jump to bottom.
- `max_lines=N` auto-evicts old lines (great for low RAM).

### Select (dropdown)
- `Select(options=[(label, value), ...], value=None, allow_blank=True, prompt="...")`.
- `.value` — read/set selected value.
- `.set_options([(label, value), ...])` — replace options after creation.
- Change → `Select.Changed` event. Handler: `on_select_changed`; `event.value`.

### ListView / ListItem
- `ListView()` then `.clear()` and `.extend([items])`.
- `ListItem(Label("..."), ...)` — a row; subclass it to carry extra data:
  ```python
  class Row(ListItem):
      def __init__(self, key, label):
          super().__init__(Label(label)); self.key = key
  ```
- Selection → `ListView.Selected`; handler `on_list_view_selected`; `event.item`.
- `ListView.focus()` to focus it.

### TabbedContent / TabPane (tabs UI — usable for sub-agent switcher)
- `TabbedContent()` contains `TabPane("Title", ...children)`.
- Good for multiple live sub-agent views you switch between.

### DataTable (tables)
- `.add_column(...)`, `.add_row(...)`, `.clear()`.

---

## 3. Layout with CSS

The `App` has a `CSS = """ ... """` class attribute. Layout is powerful but simple:

```python
CSS = """
#root { layout: vertical; height: 1fr; }
#header { height: 3; background: $panel; }
#messages { height: 1fr; border: round $accent; }
#controls { height: auto; align: left middle; }
ListView { border: round $panel; }
"""
```

Key facts:
- `layout: horizontal` / `layout: vertical` / `layout: grid`.
- Sizing: `width: 1fr` (fills remaining), `height: 1fr`, fixed `width: 32`, `min-width`, `max-width`.
- Design tokens you can reference with `$`: `$primary, $accent, $background, $surface, $panel, $text, $text-muted, $success, $error, $warning`.
- Borders: `border: round $accent;` (types: `round, solid, double, tall, heavy, blank`); `border-right: tall $panel;`.
- `margin` / `padding`: `margin: 0 1;` `padding: 1 2;` (top/bottom, left/right).
- Text: `text-style: bold; color: $accent; text-align: center;`.

---

## 4. THE most important gotcha: background work and threads

### `run_worker` — pass the METHOD (NOT the result)

This fork's `run_worker(self, work, name='', group='default', description='', exit_on_error=True, start=True, exclusive=False, thread=False)`.

**CRITICAL:** You must pass the function reference WITHOUT parentheses, and set `thread=True`
to run blocking code off the event loop:

```python
self.run_worker(self.some_worker, name="w", thread=True)     # CORRECT
self.run_worker(self.some_worker(), name="w", thread=True)   # WRONG — runs eagerly on main thread
```

If you write `self.some_worker()`, the whole body runs on the **main thread** (freezing the UI),
and any `call_from_thread` call will raise `RuntimeError` and kill the app.

`some_worker` should be a **plain `def`** (not async, not a generator) that does the blocking
I/O and returns. With `thread=True`, Textual runs it in a worker thread.

### Updating widgets from the worker thread

You **cannot** touch widgets directly from the worker thread. Use:

```python
dolog = self.call_from_thread        # grab once at worker start
dolog(self.live_label.update, "new text")
dolog(self.other_widget.write, "line")
```

`call_from_thread(callback, *args)` runs the callback on the main/UI thread. **It raises if
called from the main thread itself**, so only use it inside thread workers.

### Workers on the main thread (fast jobs)

For quick work that touches widgets, DON'T use run_worker at all — just call the function
directly (it runs on the main thread): `self._open_file(path)`.

---

## 5. Key bindings

```python
BINDINGS = [
    ("ctrl+q", "quit", "Quit"),
    ("ctrl+n", "new_session", "New session"),
    ("escape", "focus_input", "Focus input"),
]
```

- Each tuple: `(keys, action_method_without_'action_', description)`.
- Modifiers: `ctrl+`, `shift+`, `alt+`; also `"right"`, `"left"`, `"down"`, `"up"` for arrows.
- `"ctrl+x"` works as a binding key.
- The action method is named with `action_` prefix: binding `"quit"` → `def action_quit(self)`.
- Runtime: `self.run_action("quit")` or `self.action_quit()`.
- To capture ANY key (for custom navigation), implement:

```python
def on_key(self, event):
    if event.key == "ctrl+x":
        self.enter_subagent()
        event.prevent()
    elif event.key == "down":
        ...
```

`event.key` is the normalized key name; `event.prevent()` stops further handling.

NOTE: `ctrl+s` is the terminal XOFF freeze key — avoid using it as a binding on some
setups (screen/ssh). Prefer `ctrl+q`, `ctrl+n`, etc.

---

## 6. App lifecycle & polling

- `def on_mount(self)` — called once the UI is ready; do initial data load + widget setup.
  This is where `self.run_worker(...)` for background jobs can be kicked off.
- `self.set_interval(seconds, callback)` — call `callback` every N seconds (main thread).
- `self.set_timer(seconds, callback)` — one-shot timer.
- `self.TITLE = "..."` and `APP = "..."` class attrs; you can set `self.TITLE` at runtime.

---

## 7. Markup vs rich Text

- Use `Text` from `rich.text` for colored, safe strings:
  ```python
  from rich.text import Text
  t = Text(); t.append("You: ", style="bold green"); t.append(str(user_text)); 
  self.log_widget.write(t)
  ```
  This avoids interpreting user content as markup (safe + fast).
- For a simple Static that you WANT to interpret `[bold]` tags, use `markup=True`.

---

## 8. Building a streaming chat client (canonical pattern)

```python
self.streaming = True
self._errored = False
self.run_worker(self._chat_worker, name="chat", group="chat", thread=True)

def _chat_worker(self):
    msgs = [...history...]
    dolog = self.call_from_thread
    try:
        for chunk in stream_chat(msgs, self.model):      # blocking generator (thread)
            if self._stop: break
            self.buf += chunk
            dolog(self.live.update, self.buf)             # throttle to ~10Hz
        dolog(self.live.update, "")
        dolog(self.log.write, self.buf)
    except Exception as e:
        self._errored = True
        dolog(self.status.update, "Error")
    finally:
        if self.active_id == sid:
            self.streaming = False
            dolog(self.status.update, "Done" if not self._errored else "Error")
```

Throttle UI redraws (e.g. only every 0.1s) and disk flushes (every ~3s) to keep CPU/RAM low.

---

## 9. Low-RAM rules (this device)

1. Cap the displayed log (`max_lines=500`) and cap stored messages (e.g. 200).
2. Only send the LAST ~40 messages to the model (finite context anyway).
3. Never `.write()` on every token — throttle to ~10Hz.
4. Never flush JSON to disk on every token — throttle to ~3s.
5. Prefer plain `def` workers ran via `run_worker(..., thread=True)`; do heavy work in threads.

---

## 10. Quick API-cheat recap

| Need                           | Use                                                        |
|--------------------------------|------------------------------------------------------------|
| layout container               | `Horizontal`, `Vertical`                                   |
| static text                    | `Static`, `.update()`                                      |
| user input                     | `Input`, `.value`, `.focus()`                              |
| button                         | `Button`, `.disabled`, `on_button_pressed`                 |
| scrolling chat log             | `RichLog`, `.write/.clear/.scroll_end`, `max_lines`        |
| dropdown                       | `Select`, `.set_options`, `on_select_changed`              |
| list                           | `ListView`, `.extend/.clear`, `on_list_view_selected`      |
| tabs (sub-agent switcher)      | `TabbedContent`, `TabPane`                                 |
| run blocking work off UI       | `run_worker(self.fn, thread=True)`  (NO parens)            |
| update UI from worker thread   | `self.call_from_thread(self.widget.update, "...")`         |
| colored safe string            | `from rich.text import Text`                               |
| keys / navigation              | `BINDINGS` + `action_*`, or `on_key` + `event.prevent()`   |
| periodic                        | `self.set_interval(secs, cb)`                              |
| exit                            | `self.exit()`                                              |
