# LevelCode — Calm narrative transcript (voice + grouped activity) — scope & plan

The goal, in one sentence: make an agent run read like a colleague narrating their work — short
prose between actions, and consecutive actions folded into one expandable card whose header shows
the *live* step while running and a past-tense aggregate ("Read and edited PLAN.md +56 −0, ran 2
commands") when done — instead of a flat scroll of chips and cards.

The group card itself is never collapsed while it runs: its *members* collapse to one-line rows as
they finish, so the live step's output stays readable at a fixed vertical footprint. Clause order
in the aggregate is files first, commands last, matching the reference transcript.

Reference behavior: Claude Code's transcript (screenshots in the design discussion, 2026-07-23).
Two halves, shipped as separate slices: the **voice** (system prompt) and the **grouping** (webview).

## 1. Verified facts about our own code (read 2026-07-23, not recalled)

- **Interleaving already works end-to-end.** `providers.streamAgentTurn` returns Anthropic-shaped
  `turn.content` (text + tool_use blocks in order); `agent.js` pushes it wholesale into `messages`,
  so narration between tool calls is persisted and re-sent. In the webview, `agentDelta` streams
  text into a bubble and `agentTool`/`termRun`/`editApplied` each close the bubble
  (`finishAgentBubble`) and append a timeline entry. Text → chip → text already renders; it is the
  *prompt* that suppresses the text and the *flat appending* that makes it noisy.
- **The current prompt actively fights narration.** `SYSTEM_BASE` (agent.js:21): "Do NOT write long
  multi-point plans — at most ONE short sentence before each tool call", "Be DECISIVE and FAST",
  and a one-line `Done:` ending.
- **Three loop mechanics are load-bearing and must survive the voice change** (agent.js):
  1. The finish sentinel: `/(^|\n)\s*done\s*:/i` (line ~702) triggers auto-verify + finish. It
     matches a `Done:` **line anywhere** in the final text — so a structured summary is fine as
     long as one line still starts with `Done:`.
  2. The anti-stall nudge (line ~708): fires only on a **tool-less** turn that "promises action"
     (ends with `:`/`…`, or "let me… edit/check/run"). Narration followed by a tool call in the
     SAME turn never triggers it. The voice rules must keep the "narrate then CALL the tool in the
     same turn" discipline or runs will start eating nudges.
  3. `max_tokens` continuation + the `<think>` stripping for Kimi — unaffected, but more prose per
     turn slightly raises the odds of hitting the per-turn cap; the machinery already handles it.
- **Labels**: `run_command` already has an optional `explanation` input (rendered as the approval
  subtitle and the run card's italic `cmdwhy`), but the schema text doesn't say what to write and
  the system prompt never asks for it — in practice it's often missing. File ops post derived
  chips ("read X", `search "q"`). There is nothing like Claude Code's semantic command label
  ("Found exact insertion point in section 10") unless we make `explanation` required — which D6/S1
  now do (schema-required on all three tools).
- **Diffstat data exists everywhere we need it**: `editApplied` carries per-file `add`/`del`
  (rendered `+N −M` on the edit card); `reviewState` carries the run aggregate. A group header sum
  is arithmetic on data already in the webview.
- **Rendering**: every entry is a `.tl` div appended flat to `log`. `termRun` cards already
  collapse via a chevron. Edit cards are keyed (`editCards[id]`) and re-rendered in place;
  `resolveEditCard` collapses them when reviewed. `addApproval` is a blocking card with keyboard
  handling. `addQuestions` (ask_user) likewise interactive.
- **Testing pattern for webview logic exists**: `test/shHighlight.test.js` tests a function that
  lives inside `chat.html` (extraction pattern) — the CI gate runs the node suites before builds
  (release.yml "cheap gate"). New pure webview functions get tested the same way.

## 2. Decisions (with the reasoning, so they can be re-litigated)

### D1 — The voice is a system-prompt change, not a new mechanism.
The transport (interleaved blocks) and persistence already exist (§1). We rewrite the
communication rules in `SYSTEM_BASE`; no provider/loop code changes for the voice itself. The
`Done:` sentinel stays — the final message becomes "a line starting with `Done:` followed by a
short structured wrap-up", which the existing regex already accepts.

### D2 — Narration must never replace action in a turn. (The anti-stall covenant.)
The current rules that make the agent act ("words are not edits", act-in-the-same-turn, the nudge)
stay verbatim. The voice rules are additive: *narrate briefly, then call the tool in the same
turn*. A narration-only turn that promises action remains a stall and still gets nudged. This is
the difference between "calm" and "chatty but idle".

### D3 — Grouping is a webview-only reducer; the host keeps posting the same event *types*.
No new event types and no host-side grouping logic. The `agentTool` payload does gain optional
metadata — `label` (the model's `explanation`), `kind`, and `path` — so the webview can title and
categorise rows; `agent.js` fills those fields, but the grouping decisions all live in `chat.html`.
The router appends consecutive tool-ish entries (`agentTool` chips, `termRun` cards, `editApplied`
cards, verify cards) into the open group's body instead of `log`; any assistant text bubble,
`ask_user` card, `agentError`, or `agentDone` **closes** the group. This keeps the diff small,
rebase-safe, and revertable (one function + CSS).

### D4 — Interactive and alarming things never hide inside a collapsed group.
- `addApproval` and `addQuestions` (blocking, keyboard-owning) **close the current group** and
  render at top level, exactly as today. A hidden pending gate looks like a hang.
- A member that *fails* (termExit nonzero / timeout / stopped, `editApplied` error-free but
  verify-fail cards) **auto-expands** the group and highlights the row. Collapse is for success.
- Edit cards DO collapse into groups (their Keep/Undo stays usable when expanded; the global
  review bar and editor-side review remain the primary review paths). Header shows the summed
  `+a −d` so the information isn't lost while collapsed.
- `ask_user` asks **one question at a time** (`n of N`, Back, advance button). Stacked questions in
  a single card invited answering the first, missing the rest and sending — the agent then acted on
  defaults nobody chose. Nothing posts before the last question, and passing one over is deliberate:
  with nothing picked the button reads "Skip this one" and the answer is recorded as empty. On send
  the card collapses to `Answers recorded`, unfolding to the full question/answer record. A single
  question keeps the plain card — no step chrome.

### D5 — Two header states, exactly like the reference.
While the group is open (agent still acting, no closing event yet): header = the **live** step's
label in present-progressive + the working spinner. The *members* fold: each finished step
collapses to a one-line row while the running one keeps its body open, so the footprint stays
fixed without hiding the output the user is watching. The group card itself is never born
collapsed. When the group closes: header flips to the past-tense **aggregate** — file clauses
first, then searches, then commands ("Read and edited PLAN.md, ran 2 commands"), same-file
read+edit merged, summed diffstat, fallback "N steps" when the sentence would get awkward. A
single-member group unwraps and hands the card back **expanded** — no group chrome.

### D6 — Labels: model-written, for every tool that has a story to tell.
`run_command`, `read_file` and `search` all take a required `explanation`: "3–8 words, active
voice, what it does — e.g. 'Find the insertion point in section 10'" (the same range in the prompt
and all three schemas), and the voice rules require it. That sentence titles the row; the raw tool text (`read src/agent.js`) becomes the tooltip. UI
falls back to deriving a label from the arguments when absent (older transcripts, weaker models).
Tense: a small verb map (Run/Ran/Running, Read, Edit, Verify, Search, Create, Delete, Install,
Check ~a dozen) converts imperative → progressive/past; unknown verbs render as-is. No grammar
engine.

### D7 — Kimi degradation is accepted, not engineered around.
Claude models hold this register natively; Kimi K2.7 via the gateway will narrate less reliably.
The prompt carries the style; the UI (grouping, labels, aggregates) works identically either way —
that's where most of the calm comes from. No per-model prompt forks in v1.

## 3. Slices

**S1 — The voice (system prompt).** *(S)*
Rewrite `SYSTEM_BASE`'s communication rules in `agent.js`:
- Before a tool batch: 1–2 sentences, what + why ("PLAN.md already had uncommitted edits — let me
  confirm I added on top rather than clobbering:") then the tool call **in the same turn**.
- After results: interpret, don't restate ("the hash values differ but slice(0,6) truncates from
  the left — that's the bug").
- Corrections: once, plainly ("Correction —"), then continue.
- Decision points: `ask_user` with the tradeoff, a recommendation, and the trigger that would
  change it — never a decision buried in prose.
- Finish: a `Done:` line followed by a short structured wrap-up (what landed / how verified /
  what's next) for substantial runs; one line stays enough for trivial ones.
- `run_command`, `read_file` and `search` MUST carry `explanation` (D6 wording).
Keep verbatim: decisiveness, words-are-not-edits, same-turn action, skills/plan/multi-root/
autopilot blocks. Update those three schemas' `explanation` descriptions (D6).
*Test:* existing suites green (prompt text is data); manual acceptance below.

**S2 — The group reducer (webview).** *(M)*
In `chat.html`: `openGroup()/groupAppend(el, step)/closeGroup()`; route `addAgentLine`,
`addTermRun`, `addEditCard`, verify cards through it; close on text bubble / approval / questions
/ error / `agentDone`. Group DOM: `.tl.tl-group` → header (chevron · label · Σdiffstat · state) +
body (existing cards unchanged, each collapsed to a row by `collapseMember` once finished).
D4 rules (breakout + auto-expand-on-failure). CSS for header + collapsed member rows.
*Test:* `test/groupReducer.test.js` drives the real reducer functions against a zero-dep fake DOM —
header states, member collapse, failure re-open, unwrap, late background exit, grouping-off.

**S3 — Labels, aggregate, tense (pure functions + wiring).** *(M)*
`stepLabel(meta)`, `groupAggregate(steps)`, `verbForms(label)` as extractable pure functions in
`chat.html`; header live-updates on member start/finish (progressive label while running →
aggregate on close). Wire per-edit `add/del` into the sum.
*Test:* `test/narrativeUi.test.js` via the shHighlight extraction pattern — aggregate sentences
(counts, same-file merge, fallback), tense map, diffstat sums.

**S4 — Polish.** *(S)*
Auto-expand rules exercised (failed command, verify-fail); scroll behavior (`scrollIfStuck`)
inside collapsed groups; status-bar interplay (global working bar stays; group header is local
detail); single-member degenerate case; a settings escape hatch
(`levelcode.ai.chat.groupActivity`, default on) so the flat timeline remains one toggle away.

## 4. Risks

- **Prompt regression on the anti-stall machinery** — the voice invites prose; if the model starts
  ending turns on narration, nudges fire and runs slow down. Mitigation: D2's covenant wording +
  watch `dbg('nudge')` frequency before/after on the same tasks.
- **Output-token cost** rises modestly (narration is small next to tool payloads); the per-run cost
  line in the response bar keeps it honest.
- **Webview lifecycle**: if the chat webview is rebuilt mid-run, group state resets (entries after
  rebuild render flat until the next group opens). Same class of behavior as today's transcript;
  not worse. Not engineering session-restore for groups in v1.
- **Kimi adherence** (D7) — accepted.

## 5. Exit test

Run the acceptance task on a real repo (Claude model, agent mode, autopilot on):
"add a section to docs/X.md, verify the edit landed cleanly, and check repo state".
Pass when the transcript reads: short narration → **one card** titled with the live step while
running ("Verifying the edit and checking repo state ⟳"), its finished members folded to one-line
rows beneath it while the running step's output stays visible, flipping on completion to
"Read and edited X.md +N −0, ran 2 commands" → narration continues → a `Done:` wrap-up — and
expanding a folded row shows its full output (semantic labels, per-file diffstat), with
any approval card rendered outside the group and any failing step auto-expanded.
Then re-run with grouping toggled off and confirm the flat timeline is unchanged.

## 6. Not doing (yet)

- Group state across webview rebuilds / session restore.
- Per-model prompt forks for the voice.
- Collapsing `ask_user`/approvals into groups — deliberately excluded (D4).
