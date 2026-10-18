# Sub-Agents & Model-RAM Orchestration

How to run multiple background "sub-agents" on this low-RAM device WITHOUT
overloading memory, plus how to watch what they're doing live.

---

## 1. The RAM problem (why we can't just parallel everything)

- A **7B-parameter model** (e.g. `Qwen2.5:7B`) needs roughly **5–8 GB RAM** while loaded.
  Running even ONE alongside the browser/CLI is already tight.
- A **3B-parameter model** (e.g. `Qwen2.5:1.5B`, `Qwen2.5:3B`, `phi3:mini`) needs only
  about **1.5–3 GB**.

Rule of thumb:
- You can run **several 3B models at once** (e.g. 3–4 × 3B ≈ fits on a ~8–12 GB device).
- You can generally run **only ONE 7B model at a time** — a second 7B would OOM.

### Budget model (RAM estimate table)

| Model               | ~Loaded RAM   | Can run how many at once (assume ~10 GB free) |
|---------------------|---------------|-----------------------------------------------|
| 1.5B (Qwen2.5:1.5b) | ~1–1.5 GB     | 5–6                                           |
| 3B                  | ~2–3 GB       | 3–4                                           |
| 7B                  | ~5–8 GB       | 1 (maybe 0 alongside other things)            |

A safe **reservation scheme**: before starting a sub-agent, check the sub-agent's model
size class and count how many we already reserved. Refuse to start if combined load would
exceed a `MEMORY_CAP_GB` (default ~8 GB).

---

## 2. Core orchestration: a SubAgent supervisor

The parent (main) chat is also a model, but it should be lightweight too. Sub-agents are
separate Ollama chat calls to SMALL models, each with its own full prompt.

Each sub-agent is just: an id, a goal/prompt, a model, a per-agent history, and a state.

```python
class SubAgent:
    def __init__(self, aid, goal, model, budget):
        self.id = aid
        self.goal = goal           # the task you gave it
        self.model = model         # e.g. "Qwen2.5:1.5b"
        self.phase = "queued"      # queued | loading | generating | running_tool | done | failed
        self.heartbeat = "waiting to start"   # one-line human phrase
        self.log = []              # memory-only transcript
        self.result = None
        self.budget = budget       # estimated GB while loaded
```

### Reservation / RAM gate (prevents 2× 7B)

```python
RAM_LIMIT_GB = 8.0
MODEL_GB = {"1.5b": 1.5, "3b": 3.0, "7b": 7.0}   # size-class -> GB

class AgentPool:
    def __init__(self):
        self.agents = {}
        self.reserved_gb = 0.0

    def can_spawn(self, model_class):
        need = MODEL_GB[model_class]
        return self.reserved_gb + need <= RAM_LIMIT_GB

    def spawn(self, aid, goal, model_class, ...):
        if not self.can_spawn(model_class):
            return None                      # reject: not enough RAM for 2nd 7B
        self.reserved_gb += MODEL_GB[model_class]
        agent = SubAgent(aid, goal, ...)
        agent.phase = "queued"
        self.agents[aid] = agent
        # then run it on a worker thread
        self.run_agent(agent)
        return agent

    def free(self, agent):
        self.reserved_gb = max(0.0, self.reserved_gb - MODEL_GB[agent.model])
```

Key: because we reserve based on model size-class, spawning a second 7B is refused
("not enough RAM"), while 3–4 3B agents start fine.

---

## 3. Running an agent (thread + phase transitions)

Each sub-agent runs as its own `run_worker(..., thread=True)` job (see TEXTUAL_REFERENCE.md
§4 — MUST pass the method reference, no parens). As it runs, it reports phase/heartbeat:

```python
def _agent_worker(self, aid):
    agent = self.pool.agents[aid]
    dolog = self.call_from_thread
    try:
        agent.phase = "loading"; agent.heartbeat = "loading model"; self.notify_view()
        msgs = [{"role":"system","content": self.system_prompt},
                {"role":"user","content": agent.goal}]
        agent.phase = "generating"
        agent.heartbeat = "thinking..."
        for chunk in stream_chat(msgs, agent.model):
            agent.buffer += chunk
            agent.heartbeat = "writing ({} chars)".format(len(agent.buffer))
            self.notify_view()                    # throttle this!
        agent.phase = "done"; agent.result = agent.buffer
        agent.heartbeat = "finished"
    except Exception as e:
        agent.phase = "failed"; agent.heartbeat = "error: " + str(e)
    finally:
        self.pool.free(agent)
        self.notify_view()
```

### Heartbeat threading rules (memory-only)

- State lives ONLY in memory (`self.pool.agents`), discarded on exit — per user request.
- The worker thread UPDATES agent fields (phase/heartbeat/log) directly — cheap, GIL-safe.
- The worker thread must NOT touch widgets directly; it calls `self.call_from_thread(
  self.refresh_agent_view, agent_id)` (throttled) to repaint.
- Throttle repaints (e.g. 5–10 Hz) and store only a bounded transcript per agent (e.g. last
  200 lines) to keep RAM flat.

---

## 4. Seeing what sub-agents are doing (the "inspect" view)

The user wants to DESCEND into sub-agents to watch them, not just see "parent spawned N".

### Keyboard navigation (as requested)

- **Ctrl+X** then **Down**: descend from the parent chat into the sub-agent view
  (and into deeper levels if an agent itself spawned agents).
- **Left / Right**: switch between sibling sub-agents at the current level.
- **Up**: climb back up one level toward the parent.

Implement with a `TabbedContent` of `TabPane`s (one per active sub-agent) plus an
`on_key` handler that manages a `self.focus_stack` of ids:

```python
self.focus_stack = []                 # [] = parent, then [agentA], [agentA, agentB]...
def on_key(self, event):
    k = event.key
    siblings = self.current_siblings()      # children of the focused agent
    if k == "ctrl+x" and not self._x_pending:
        self._x_pending = True; event.prevent(); return
    if self._x_pending and k == "down":
        self._x_pending = False
        if siblings: self.descend(siblings[0].id); event.prevent(); return
        self._x_pending = False; return
    if k == "right" and self.focus_stack and siblings:
        self.next_sibling(+1); event.prevent(); return
    if k == "left" and self.focus_stack and siblings:
        self.next_sibling(-1); event.prevent(); return
    if k == "up" and self.focus_stack:
        self.focus_stack.pop(); self.refresh_agent_view(); event.prevent(); return
    if k == "ctrl+x":
        self._x_pending = True; event.prevent()
    # else: normal app keys / pass through
```

`event.prevent()` stops Textual from also treating the key as a normal key/input.

### Per-agent live view contents

For the focused agent, show:
1. `id`, `model`, `goal` (the prompt you gave it)
2. Current `phase` badge: `queued / loading / generating / running_tool / done / failed`
3. `heartbeat` (the one-line "what it's doing right now")
4. Its streaming `buffer` / transcript (memory-only, re-drawn ~5–10 Hz)
5. RAM reservation (`~1.5 GB of 8 GB used`)

A always-visible summary (in the parent/sidebar when back at top) could list:
`[3] A7B-1 generating «fix the bug»  |  B3B-2 done  |  C3B-3 failed` — so even at the top
you can see all agents and their states at a glance.

---

## 5. Wiring it into the existing CLI

The gooey CLI already uses `run_worker(..., thread=True)` + `call_from_thread` and a
`TabbedContent`-compatible layout. To add sub-agents:

1. Add an `AgentPool` to `GooeyApp.__init__`.
2. Add `/spawn <goal>` slash command: pick a 3B model by default, reserve RAM, spawn.
3. Add a `TabbedContent` pane-per-agent + `on_key` nav (block 4 above).
4. Keep agent state memory-only (do not write ~/.gooey for agents).
5. On app exit, everything is discarded (per requirement).

---

## 6. Summary of the RAM rules

- One 7B at a time; several 3B together.
- Reserve RAM by model size-class before spawning; refuse when over budget.
- Each agent = one `run_worker(thread=True)`; no parallel 7B because the pool gate blocks it.
- Agent state is memory-only; watch it live via Ctrl+X+Down → Left/Right → Up.

See `/data/data/com.termux/files/home/gooey/gooey_cli.py` for the working low-RAM
thread/streaming pattern to copy.
