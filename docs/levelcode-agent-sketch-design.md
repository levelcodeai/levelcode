# LevelCode — Agent Sketch — Design

> **Status:** SK1 skeleton shipped · **Date:** 2026-07-01 · **Owner:** Sergii Demianchuk
> **Vision:** Sketch a whole agentic system visually, right inside the LevelCode editor — connect
> specialized agents into flows, watch **tokens burned per step**, and **recalculate the same flow
> against different models** before committing to one. Chaining in the spirit of
> [ruflo](https://github.com/ruvnet/ruflo) ("Agent = Model + Harness"; 100+ specialized agents),
> with the canvas interaction model adapted from the SystemSketch (SysDes) prototype.

## 0. Why this is a natural LevelCode feature

Everything below sits on the multi-provider layer already shipped:

| Need | Already built |
|---|---|
| Run one agent step on ANY provider, BYO-key | P1/P2 — `providers.streamAgentTurn` (Anthropic native + OpenAI-compatible translation) |
| **Real token usage per step** | P2 — `usage` from `message_start`/`stream_options.include_usage` |
| Per-model capabilities to pick sensible defaults | P4 — `providers/catalog.js` tiers/caps |
| Cost math for the meter + what-if | `sketch/pricing.js` ($/MTok table; Anthropic published, others list-price estimates, labeled "est.") |
| No middle-man backend, keys in the keychain | The LevelCode architecture invariant |

## 1. The SK1 skeleton (shipped)

```
extensions/atom-ai/
  sketch.js                  controller: panel, persistence, THE RUNNER (reentrancy-guarded, abortable)
  sketch/agentCatalog.js     96 agent archetypes in 13 palette groups (derived from ruflo, MIT © ruvnet — names + one-line roles only)
  sketch/templates.js        ready-made topologies — incl. the "Design a Key-Value Store" hero template   [unit-tested]
  sketch/graph.js            pure DAG logic: validate (cycles/dangling), Kahn topo LEVELS, node-input builder   [unit-tested]
  sketch/pricing.js          $/MTok table + exact→basename→family matching + costOf()                          [unit-tested]
  media/sketch.html          the canvas webview (vanilla JS, no build step)
```

### Templates — drop a whole topology, set the goal, run
`sketch/templates.js` ships pre-wired flows loadable from the **Templates…** dropdown; each is a full
sketch (nodes + edges + per-node instructions) laid out on a grid. The hero is **Design a Key-Value
Store**, a faithful 11-node / 6-level topology of the *System Design Interview* ("Design a Key-Value
Store" / ByteByteGo) chapter:

```
requirements → architecture → [ storage-engine · consistent-hash · replication+quorum ·
                                vector-clocks · gossip+failover ]  (parallel)
             → integrate+server → [ tests · build+validate ] → review+run-guide
```

Every node carries a precise task pinning its aspect (WAL/memtable/SSTable/bloom/compaction;
consistent-hashing ring; N/W/R quorum + read-repair; vector-clock reconciliation; gossip + sloppy
quorum + hinted handoff + Merkle anti-entropy; coordinator/request routing; cluster tests). The
flow **goal** (top of the canvas) sets the language — type *"build using C"* and the flow produces a
C implementation covering every aspect. Other templates: feature-pipeline, research-synthesize,
code-review-swarm, SPARC, TDD, bug-fix, API-service, security-audit, refactor.

### Hardening (post adversarial review)
The `Workflow` adversarial review surfaced 31 confirmed findings; the load-bearing ones are fixed:
- **Reentrancy / unstoppable spend** — `runSketch` claims a run slot *synchronously* before any
  `await` and clears it only if still its own; a double-clicked Run can't orphan the first run, so
  **Stop always aborts** (real BYOK money).
- **Abort ≠ failure** — a user Stop paints in-flight nodes `stopped`, not red `error`, and `runDone`
  no longer reports `failed`.
- **Truncation surfaced** — a node that hits the per-node cap is badged `⚠ truncated` and its stored
  output marked incomplete (cap raised 4096 → 8192 so a full module fits).
- **`uiError` channel** — save/load/clipboard failures no longer masquerade as run errors.
- **Pricing drift killed** — the webview's hand-rolled matcher is gone; the extension resolves each
  model's price once (authoritative matcher) and sends the map.
- **Hostile-JSON safe** — loaded sketches are sanitized (array coercion, `__proto__`/dup-id
  rejection, dangling-edge drop); disk-sourced strings are HTML-escaped before `innerHTML`.
- **Cross-provider guard** — a per-node model override invalid on the active provider falls back to
  the tier default with a note (no stray `gpt-4o` 400 on a Claude key).
- **UX** — node rename, run-gating of Load/Templates/Clear, catalog descriptions de-truncated.

- **Palette → canvas → connect → Run.** Drag agents (coder, planner, reviewer, security-manager,
  raft-manager, pr-manager, …) onto the canvas; wire output→input ports into a DAG (cycles are
  rejected live). `Run` executes **levels in parallel, chains in sequence** (Kahn levels — ruflo's
  mesh/pipeline hybrid).
- **Each node = one turn on the active provider** via `streamAgentTurn` (no tools in SK1): system
  prompt = the agent's role from the catalog (+ optional per-node task), user message = flow goal +
  upstream agents' outputs.
- **Metering:** every node card shows real tokens in/out + estimated cost; the footer totals roll up
  live. The **what-if selector re-prices the whole recorded run on a different model** without
  re-running — the feature that answers "what would this flow cost on Haiku vs Opus?"
- **Per-node model:** catalog `tier` (fast/balanced/powerful) → provider-specific default
  (`MODEL_TIERS`), overridable per node in the inspector.
- **Persistence:** named sketches in the workspace at `.levelcode/sketches/<name>.json`.
- Command: **`levelcode.ai.sketch`** ("AI: Agent Sketch…"), also in the Customize panel.

### Safety posture (SK1)
Sketch nodes are **text-only** — no file edits, no commands, no tools. A sketch run cannot touch the
workspace; it only spends the user's own tokens (BYOK, direct to provider, key never in the sketch
files). Costs shown are planning estimates from list prices — the provider bills the user directly.

### Canvas UX (SK1.1)
- **No lost work.** A node runs to completion via `runNodeTurn` auto-continuation: `streamAgentTurn`
  caps a single turn at 8192 tokens, and if the model stops on `max_tokens` the runner feeds its own
  partial back with a "continue where you left off" instruction and keeps going — accumulating text
  and usage across up to 8 turns. A whole code module (or the KV-store integrator's output) is no
  longer truncated. Nodes that needed more than one turn show `⟳n`; only exhausting the 8-turn safety
  cap marks a node truncated.
- **Zoom + bigger board.** 12000×8000 world; `translate(pan)·scale(zoom)` with wheel-zoom (cursor-
  anchored), +/−/reset/fit controls, ⌘0 / ⌘± shortcuts, and a **Fit** that frames the whole flow.
  All drop/drag/wire math goes through `toWorld()` so it's correct at any zoom.
- **Board command bar (LLM edits the graph).** Type an instruction — *"add a security-auditor after
  coder"*, *"set every agent to Opus 4.8"*, *"tidy the layout"* — and the active model returns a JSON
  op list (`add`/`connect`/`disconnect`/`remove`/`setModel` scoped all|agent|node/`setTask`/`setGoal`/
  `layout`) applied deterministically in the webview. Unknown agents/refs are skipped with a note; the
  DAG stays acyclic.
- **Active-node highlight redesigned.** The marching-ants border is gone (it flickered over the
  connector dots); the running node now has a breathing glow + a header shimmer, and ports sit above
  it (`z-index`) so they never blink.
- **Palette optimized.** Live search filter, per-agent tier chip (f/b/p), sticky group headers,
  expand/collapse-all.
- **What-if reworked.** Instead of one dropdown, a row of chips shows what *this exact flow* would cost
  on each candidate model (the active provider's fast/balanced/powerful tiers + any model actually
  used), cheapest first, current run marked. Clicking a chip switches every agent to that model — so
  the comparison is also the action.
- **Tidy.** One-click `autoLayout` (topological columns) re-arranges the flow left→right by dependency.

## 2. Roadmap

| Phase | Deliverable |
|---|---|
| **SK1.3** | **Prompt → whole flow** (shipped): type a plain-English description into the (empty) board and the active model designs a complete DAG — `generateFlow()` returns `{goal, nodes, edges}`, normalized to a loadable sketch and auto-laid-out. Empty canvas = *build*; populated canvas = *edit* (the existing ops command). |
| **SK2** | **Tool-using + connector nodes**: a node runs the full `agent.js` loop (read/edit/run with Keep-Undo review) so a sketched flow edits the workspace; **connector nodes actually act** — Telegram/Slack post, email send, webhook call, file write — behind credentials + per-flow permission (see §4). |
| **SK3** | **Triggers & topologies**: a `scheduler`/`webhook-trigger` root fires the flow on a **cron cadence / inbound event** (Managed-Agents-style scheduled deployment); coordinator/hierarchical patterns, conditional edges, retry/verify loops; per-flow token budgets. |
| **SK4** | **Interop**: import/export ruflo swarm configs; publish sketches as shareable templates; sketch → `levelcode.ai` chat-agent handoff. |

## 4. Node tiers: text → tools → connectors → triggers

Not every node is the same *kind* of thing. The catalog now spans four execution tiers; SK1 runs them
all as **text-only** (a connector emits the payload it *would* send; a trigger emits the context it
*would* fire with), and later phases make the side-effecting tiers real — each with the safety it needs.

| Tier | Examples | SK1 (today) | Later — what "real" needs |
|---|---|---|---|
| **Text** | coder, researcher, news-collector, copywriter, editor-in-chief | one LLM turn, in/out text | — (this is the whole SK1 model) |
| **Tool / file** | file-writer, and any node run through `agent.js` | outputs the file + contents it *would* write | SK2: writes via the same **Keep/Undo review + per-run checkpoint** the chat agent uses |
| **Connector (actuator)** | telegram-publisher, email-sender, slack-publisher, webhook-caller | outputs the exact message/email/HTTP payload it *would* send | SK2: real send. Needs **(a)** credentials in SecretStorage/keychain (bot token, SMTP creds — never in the sketch file), **(b)** a **per-flow send permission** the user grants once (sending is outward-facing — mirrors the harness "Explicit permission" rule: publishing/messaging requires a clear yes), **(c)** an **allowlist** (which chat/recipient/host), **(d)** a dry-run preview (show the message, click Send) |
| **Trigger** | scheduler (cron), webhook-trigger | the ROOT node; outputs the run context ("collect news since the last run at <time>") | SK3: a **scheduled/triggered run** — cron cadence or inbound webhook fires the downstream DAG unattended. Maps onto the Managed-Agents *scheduled deployment* pattern (cron + per-firing run records) or a local scheduler; ties into the run-persistence archive so every firing is logged |

**Why the tiering is the point:** it keeps SK1 shippable and safe (nothing sends, nothing runs on a
timer — you can design and cost a Telegram-publishing pipeline today and see exactly what it *would*
post), while giving a clear, honest path to real automation where each dangerous capability (send,
write, schedule) is gated by the credential + permission model it deserves. The BYOK rule is unchanged
— connectors use the *user's own* integration credentials; LevelCode never proxies or stores the content.

### Worked example (what the generator produces)
Prompt: *"5 agents collect recent AI & agentic-AI news; a head-of-press-release edits them; a
copywriter verifies and composes one post; publish it to Telegram; run it daily."* →

```
daily-trigger (scheduler)
  → [ai-research · agentic · products · funding · safety]  (5 news-collectors, parallel)
      → press-desk (press-editor)
        → copywriter (copywriter)
          → editor-approval (editor-in-chief)
            → telegram-post (telegram-publisher)
```

Today that runs text-only: the collectors produce cited news summaries, the copywriter composes the
post, and `telegram-post` outputs the exact Markdown message it *would* send — metered, costed, and
persisted. SK2 turns `telegram-post` into a real send (bot token + "allow send to @channel"); SK3
makes `daily-trigger` actually fire the flow every morning.

## 3. Attribution & licensing
Agent names/roles derived from ruflo's `.claude/agents/` library (MIT © 2024–2026 ruvnet) — metadata
only (name + one-line role); every node executes on LevelCode's own agent loop and providers. The canvas
interaction model (palette/nodes/edges/live metrics) is adapted from the internal SysDes prototype.
