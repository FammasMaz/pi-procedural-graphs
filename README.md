# pi-procedural-graphs

A [pi](https://pi.dev) extension implementing the **Procedural Graph** framework from
[arXiv:2609.09153 — *Procedural Graphs: Self-Evolving Execution Structures for LLM Agents*](https://arxiv.org/abs/2609.09153).

A Procedural Graph organizes procedural knowledge — *what to do, in what order, under which
conditions* — as directed, attributed triplets `(procedure --relation--> procedure)`, each edge
carrying `condition`, `guidance`, and `pitfalls`. At every decision step pi's context hook
localizes the agent's active node, extracts its h-hop neighborhood, and injects it as
step-level situational guidance that biases the next action without dictating it. After batches
of verdict-bearing tasks, an LLM refiner proposes topology/attribute edits; candidates must pass
structural validation and a configurable validation gate, and rejected candidates are kept as
negative evidence (rejection memory) so the refiner does not repeat them.

It is fully self-contained: state lives in `.pi/procedural-graph.json` on disk. It does **not**
depend on magic-context or any other extension, and composes fine with them (each `context`
handler adds its own block).

---

## Install

```bash
# from npm (once published)
pi install npm:pi-procedural-graphs

# or from this repo directly
pi install /path/to/pi-procedural-graphs
```

To try without installing (current run only):

```bash
pi -e /path/to/pi-procedural-graphs
```

The package manifest (`pi.extensions` → `./src/index.ts`) is read automatically. Extensions run
with full permissions — review `src/` before installing a third-party copy.

### First run

The extension auto-creates a small neutral skeleton graph on the first session. You can replace
it at any time:

- `/pg init` — recreate the neutral skeleton
- `/pg init --scratch` — minimal graph (just `Start`)
- `/pg init --expert path/to/graph.json` — import your own graph (must satisfy the schema below)
- `/pg reset` — back to skeleton (keeps history), `/pg reset --history` also clears history

---

## How it maps to the paper

| Paper (Section 3) | This extension |
|---|---|
| Graph `G = (V, R, E, Φ)`, edges `(u, r, v)` with `condition/guidance/pitfalls` | `ProceduralGraph` in `src/graph.ts` |
| `locate`: `u_t = Match(a_{t-1}, V)` | last tool call name matched to node `tool:<name>` (or exact id / label) |
| `extract`: h-hop neighborhood `𝒩_h(u_t)`, full graph on miss | `neighborhood(g, node, hops)`, `injectOnMiss` config |
| `generate`: `g_t = Ψ(𝒢_t, q, 𝒯_{t-w:t})` | `inject` mode = raw subgraph; `llm` mode = separate guidance-model call (`modelRegistry.complete`, same LLM as solver — as in the paper) |
| solver `a_t ~ P_solver(q, 𝒯_t, g_t)` | pi's main loop; guidance appended via the `context` event before each LLM call |
| Self-evolution: diagnostic rollout → mutation → validation gate → rejection memory | `src/evolution.ts`; verdict-bearing task batches, LLM refiner, structural validity, optional `validationCommand`, rejection memory |

Defaults match the paper: `hops: 2`, `window: 3`. Raw injection is not a hack — the paper's
usage ablation (Table 3) explicitly compares *raw full-graph injection* vs *generative
guidance*.

---

## Configuration

Optional per-project file `.pi/procedural-graph.config.json` (everything is optional; shown with
defaults):

```json
{
  "enabled": true,
  "graphFile": ".pi/procedural-graph.json",
  "guidance": {
    "mode": "inject",
    "hops": 2,
    "window": 3,
    "maxTokens": 400,
    "injectOnMiss": true,
    "maxGraphNodesForFullInjection": 20
  },
  "evolution": {
    "batchSize": 5,
    "minBatchForForce": 2,
    "autoApprove": false,
    "validationCommand": null,
    "refinerMaxTokens": 2000,
    "maxTrajectoryTokens": 8000,
    "maxRejectionMemories": 10
  },
  "verdict": {
    "command": null,
    "autoFailOnError": false
  }
}
```

- `guidance.mode`: `inject` (free) or `llm` (separate distillation call per step — faithful to
  the paper's generative guidance, costs tokens + latency).
- `evolution.validationCommand`: your **held-out validation proxy**. A shell command run with
  cwd = project and env `PG_CANDIDATE_FILE` pointing at the candidate graph JSON (and
  `PG_GRAPH_FILE` at the current graph). Exit 0 = pass → candidate is committed; non-zero = fail
  → candidate goes to rejection memory. With `autoApprove: false` it is also run by `/pg review`
  to inform your accept/reject decision.
- `verdict.command`: a shell command that derives a task verdict at task end. Exit 0 = success,
  non-zero = fail. Leave `null` to mark verdicts manually with `/pg verdict`.

---

## Commands

| Command | What it does |
|---|---|
| `/pg` | Status: graph size, mode, active node, injection/evolution stats, pending tasks |
| `/pg graph` | Print the graph; `/pg graph --localize` shows the current neighborhood |
| `/pg task start [name]` | Explicit task start (usually unnecessary — user prompts auto-start tasks) |
| `/pg task done --verdict success\|fail\|score:N` | End current task with a verdict |
| `/pg verdict success\|fail\|score:N [note]` | Mark the active task's outcome (used by the refiner) |
| `/pg evolve` | Run the refiner on pending verdict-bearing tasks; `/pg evolve --force` runs with fewer than a full batch |
| `/pg review` | Show the staged candidate diff (+ run `validationCommand` if set) |
| `/pg accept [note]` | Commit the staged candidate |
| `/pg reject [reason]` | Reject the staged candidate into rejection memory |
| `/pg edit add-node …` | Manual graph editing (minimal mode without the refiner) |
| `/pg disable` / `/pg enable` | Toggle guidance injection (persisted to config) |
| `/pg export [path]` | Export the graph JSON |
| `/pg reset [--history]` | Replace the graph with the skeleton (confirm required) |

`/pg edit` syntax:

```
/pg edit add-node step:check_tests --kind step --label "Check tests"
/pg edit add-edge tool:edit leads_to step:check_tests --guidance "Run the affected test file"
/pg edit add-edge tool:bash if_failed state:needs_verification --pitfalls "Don't blindly rerun"
/pg edit revise-edge tool:bash if_failed state:needs_verification --guidance "Read the error first"
/pg edit delete-node step:obsolete
/pg edit delete-edge tool:read leads_to tool:edit
```

The extension also registers a `pg_status` tool the model can call to inspect the active
procedural context.

---

## How the loop works day-to-day

1. You work as usual. Each user prompt starts a task; tool calls/observations are tracked
   silently.
2. Before every LLM call, the localized subgraph is injected as `<procedural-guidance>` context
   (marked as automatic, not a user message).
3. When a task finishes, give it a verdict: `/pg verdict success` or `/pg verdict fail`
   (or configure `verdict.command` to automate it).
4. After `evolution.batchSize` verdict-bearing tasks accumulate, the refiner runs: it contrasts
   successes vs failures and proposes edits. Candidates are staged:
   - `/pg review` to inspect, then `/pg accept` or `/pg reject`;
   - or configure `evolution.autoApprove` / `validationCommand` to automate the gate.

---

## Graph JSON schema

`.pi/procedural-graph.json` wraps the graph with history/rejection/staging state. The graph
portion:

```json
{
  "version": 1,
  "name": "default",
  "nodes": [
    { "id": "Start", "kind": "step", "label": "Start" },
    { "id": "tool:bash", "kind": "tool" }
  ],
  "edges": [
    {
      "id": "tool:edit --leads_to--> tool:bash",
      "source": "tool:edit",
      "relation": "leads_to",
      "target": "tool:bash",
      "attrs": {
        "condition": "After modifying code.",
        "guidance": "Run the relevant tests or a build to verify your change.",
        "pitfalls": "Do not claim success without verification."
      }
    }
  ]
}
```

Node kinds: `tool` (id `tool:<name>` matching a pi tool name), `step`, `state`. Relations are
free-form; the skeleton uses `leads_to`, `if_failed`, and `requires`.

---

## Validation (safe — won't disturb running sessions)

This extension is designed to be validated in an isolated project so running pi sessions are
untouched. Nothing here touches `~/.pi/agent/settings.json` or any running session.

**Step 0 — pure logic (no pi at all):**

```bash
cd /path/to/pi-procedural-graphs
npm install          # dev deps only, writes just this repo's node_modules
npm run smoke        # exercises graph/evolution core in memory + /tmp
```

**Step 1 — one disposable pi session:**

```bash
mkdir -p /tmp/pg-test && cd /tmp/pg-test
git init -q
pi -e /path/to/pi-procedural-graphs/src/index.ts   # try once; nothing installed globally
```

(`-e` loads the extension file for the current run only. Alternatively `pi install -l
/path/to/pi-procedural-graphs` inside the disposable project writes only that project's
`.pi/settings.json`.)

**Step 2 — fully automated real-model check (optional, makes real LLM calls):**

```bash
npm run disposable-test
```

This runs pi in `--mode json` with the extension in a sandboxed HOME + fresh `/tmp` project
(sandboxed settings strip your `packages`/`extensions`, so broken global extensions can't
interfere; running sessions are untouched). It pins the model to
`freebuff/deepseek/deepseek-v4-flash` via LiteLLM by default — override with
`DISPOSABLE_MODEL=provider/model` — and asserts that context injection fired, the task
succeeded, and an evolution round ran. Artifacts stay in `/tmp/pg-disposable`.

Inside that disposable session:

1. `/pg status` — expect the skeleton graph (9 nodes / 13 edges) and `inject:0`.
2. Ask pi to do a small task (read a file, edit something, run a check). `pg_status` should show
   a matched active node and `injections` increasing on `/pg status`.
3. `/pg verdict success`, then `/pg evolve --force` — expect a staged proposal.
4. `/pg review` → `/pg accept` or `/pg reject`.
5. Inspect `.pi/procedural-graph.json` afterwards.

Because `-e` loads the extension for that run only (and `install -l` writes only the disposable
project's settings), your global settings and other sessions are never modified. The extension
writes only `.pi/procedural-graph*.json` files inside the project directory.

---

## Known differences from the paper

- **Validation gate**: the paper gates on held-out benchmark scores. Here the gate is your
  `validationCommand` (a shell proxy) or explicit user review. Without a scoring harness the
  extension cannot measure held-out performance on its own.
- **Localization**: exact-match on tool names, plus a `Start` marker — the paper's `Match` is
  also exact-match, so this is close, but pi's open-ended tasks have no fixed action grammar.
- **Batch/session semantics**: "training tasks" are pi sessions/tasks with user-provided
  verdicts; the paper uses curated benchmark splits.
- **No weight updates**: like the paper, all learning is graph edits; no model retraining.

## Publishing

```bash
npm publish          # requires an npm account; package is "pi-procedural-graphs"
pi install npm:pi-procedural-graphs
```

## License

MIT