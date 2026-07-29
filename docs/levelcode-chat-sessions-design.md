# Chat Sessions — design

**Status:** proposed · **Scope:** `extensions/levelcode-ai` (chat + agent) · **Depends on:** nothing new; reuses the M5 compaction machinery

The problem, in one sentence: **"New Chat" is destructive.** `conversation` and
`agentMessages` are module-level in-memory arrays; `newChat()` wipes them, and so does a
window reload or a crash. A user who starts a new chat — or whose editor restarts —
loses the old one forever. Every serious AI editor now treats a chat as a *session*:
saved automatically, listed, resumable.

---

## 1. Goals & non-goals

**Goals**

1. Every chat is **saved automatically, locally**, without the user doing anything.
2. "New Chat" starts a fresh session; the previous one appears in a **History** list.
3. Any listed session can be **resumed** — even one that no longer fits the model's
   context window (that is where summarization enters, and *only* there).
4. Sessions survive window reloads, crashes, editor updates, and **folder renames**.
5. Everything is inspectable plain text on the user's disk — the hackable ethos, and
   the BYOK privacy promise: nothing leaves the machine.

**Non-goals (for this milestone)**

- Cross-device sync (that is M9 / LevelCode Sync territory; this design feeds it).
- Sharing sessions (the LevelLinks concept builds on this file format later).
- Restoring *files* to a session's point in time — per-turn checkpoints already own
  file restore and remain per-live-session.

---

## 2. Where we are today (grounded in the code)

- `extension.js`: `let conversation = []` (chat) and `agentMessages` (agent loop) are
  in-memory only. `newChat()` resets both, kills background commands and MCP servers,
  finalizes pending reviews, and posts `reset` to the webview. Nothing is written
  anywhere.
- **Compaction already exists**: `compactAgentMemory()` summarizes the bulky head of a
  live session into a briefing using `COMPACT_SYSTEM` / `COMPACT_INSTRUCTIONS`, cutting
  only at a user-message boundary so tool_use/tool_result pairs are never orphaned.
  This is exactly the machinery session resume needs — it just needs to run against a
  *loaded* transcript, not only the live one.
- Keep/Undo pending reviews persist in `globalState` (`levelcode.ai.pendingReviews`)
  and already survive reloads, keyed by file URI — orthogonal to sessions, but a
  session must *reference* its pending-review era so resume tells the truth.
- The webview (`media/chat.html`) renders from posted messages; it can replay a
  transcript it is fed. No storage of its own.

## 3. Prior art — what the three incumbents actually do

### VS Code Copilot Chat
- **Mechanics:** one JSON file per session under
  `…/User/workspaceStorage/<workspace-hash>/chatSessions/`, plus a session index in
  `state.vscdb`. History quick-pick + export/import commands.
- **What works:** plain JSON per session; per-workspace scoping; auto titles.
- **What fails — loudly, in public issues:** the workspace **hash** is derived from the
  folder URI, so renaming/moving a folder, saving an untitled workspace, or reopening
  in a dev container orphans every session (microsoft/vscode #285059, #301793,
  #305818); a corrupted `state.vscdb` index hides sessions that still exist on disk
  (community repair tools exist for exactly this). **Lesson: never make a URI-derived
  hash the only key, and never let an index be load-bearing.**

### Cursor
- **Mechanics:** everything in SQLite (`state.vscdb`) — global `cursorDiskKV` table
  with `composerData:<id>` (session metadata) and `bubbleId:<composerId>:<bubbleId>`
  (每 message), workspace DBs for the rest. History panel, checkpoints, long-context
  condensation.
- **What works:** robust incremental writes (one row per bubble); global storage means
  sessions survive workspace-identity changes; snappy history UI.
- **What fails:** the store is **opaque** — users need third-party exporter tools to
  read their own history, WAL/corruption incidents lock people out, and nothing is
  greppable. **Lesson: an AI editor's memory should not need a reverse-engineered
  schema to read.**

### Claude Code
- **Mechanics:** one **JSONL file per session** under
  `~/.claude/projects/<project-path-slug>/<session-id>.jsonl` — append-only events,
  one JSON object per line. `--continue` resumes the last session, `--resume` shows a
  picker; sessions are titled; when a resumed/long session approaches the context
  limit it is **auto-compacted**: the head is summarized, recent turns stay verbatim.
- **What works — and why this is the model to copy:** append-only = crash-safe by
  construction (a crash costs at most the line being written); the project *path slug*
  is human-readable and survives editor reinstalls; plain JSONL means `grep`, `jq`,
  and third-party tooling work day one; storage is verbatim and lossless while
  summarization is reserved for the one place it is needed — fitting an old
  conversation back into a finite context window.

### The synthesis LevelCode adopts

| Decision | Choice | Because |
|---|---|---|
| Storage format | Append-only JSONL, one file per session | Crash-safe, greppable, hackable (Claude Code); no opaque DB (anti-Cursor) |
| Location | `~/.levelcode/sessions/<project-slug>/` | Survives reinstalls & workspace-identity churn (anti-Copilot); `dataFolderName` is already `.levelcode` |
| Keying | Human-readable project path slug **plus** the real path stored inside each file | A renamed folder degrades to "listed under old name", never to "lost" |
| Index | `index.json` per project, **rebuildable by scanning** | An index may cache, it must never be load-bearing (anti-Copilot #vscdb-corruption) |
| What gets summarized | **Nothing at rest.** Transcripts are stored verbatim | Disk is free; tokens are not. Summarizing to store pays money to lose information |
| Where summarization IS used | (a) resume when the transcript exceeds the context budget — reuse `compactAgentMemory`; (b) async title generation | The user's instinct ("summarize with an LLM") lands here, not in storage |
| Privacy | Local files only; never uploaded | The BYOK promise; M9 sync may later offer opt-in encrypted sync of this same format |

## 4. Data model

```
~/.levelcode/sessions/
  <project-slug>/                 e.g. -Users-ada-code-thin-ly  (path, slashes → dashes)
    index.json                    cache: [{id, title, createdAt, updatedAt, turns, model, preview}]
    2026-07-28T09-12-33-8f3k.jsonl
    2026-07-28T14-02-10-p9q2.jsonl
```

**Session file = one meta line + append-only events** (schema-versioned):

```jsonl
{"kind":"meta","v":1,"id":"2026-07-28T09-12-33-8f3k","project":"/Users/ada/code/thin.ly","createdAt":"…","title":null}
{"kind":"user","t":"…","content":"Add idempotency to RefundService…","contextFiles":["app/services/refund.rb"]}
{"kind":"assistant","t":"…","content":[…provider content blocks, verbatim…]}
{"kind":"agent","t":"…","messages":[…the agentMessages delta for this turn…]}
{"kind":"event","t":"…","type":"checkpoint","n":3}
{"kind":"title","t":"…","title":"Idempotent refunds via Redis keys"}
{"kind":"compact","t":"…","briefing":"…","coversThrough":41}
```

Rules:

- **Verbatim provider shapes.** `conversation` and `agentMessages` entries are stored
  as-is (the same objects sent to the provider), so resume rebuilds byte-identical
  arrays — no lossy re-parsing. Schema `v` guards future migrations.
- **Append-only.** One `fs.appendFile` per turn (debounced 500ms), fsync'd. Never
  rewrite the file except `compact` events, which are *also appended* — a compaction
  is an event in the history, not a rewrite of it.
- **The meta line is written at session birth**, so even a one-message crash leaves a
  listable session.
- **Caps:** a session file is soft-capped (default 20 MB — huge tool outputs are
  already truncated upstream); beyond it, oldest `agent` tool-result payloads are
  elided on load (they are never resent to the model anyway once compacted).
- `index.json` is written atomically (tmp + rename) after each turn; on any read
  error or mismatch it is **rebuilt by scanning the directory** — self-healing.

## 5. Lifecycle

### Autosave (the default state of the world)
Every turn appends its events. There is no Save button and no dirty state. The live
session id lives in `workspaceState` so a window reload re-opens the same session
(webview replays the transcript; background commands/MCP are *not* resurrected — a
`event:"reload"` line records the discontinuity honestly).

### New Chat
`newChat()` keeps its reaping semantics (kill commands/MCP, finalize reviews, drop
checkpoints) but first **seals the current session** (final index update, kick off
async title generation if still untitled) and then opens a fresh file. Nothing is
lost — the old session is one click away in History.

### Titles
On seal (or after the 2nd user turn, whichever first): if untitled, generate one
asynchronously with the **fast/cheap lane** (the same per-provider fast model routing
autocomplete uses; ≤ 200 tokens: "6 words, imperative, no punctuation"). Failure or
BYOK-frugal mode falls back to the first user message, truncated. Titles are events,
so retitling is append-not-rewrite; a manual **Rename** writes the same event.

### Resume — the three-tier rule
Let `T` = stored transcript tokens (estimated as today, chars/4), `W` = model context
window, `B` = the context budget resume may spend (default 40% of `W`):

1. **T ≤ B — verbatim resume.** Arrays rebuilt exactly; the model sees the same
   conversation it left. No summarization, no cost.
2. **T > B, has prior `compact` event — incremental.** Load the last briefing + turns
   after `coversThrough`; if still over budget, fall through to (3) on the remainder.
3. **T > B — compact-on-resume.** Run `compactAgentMemory()`'s exact machinery over
   the head (cut at a user-message boundary, never orphaning tool pairs), keep the
   last N turns verbatim, append the `compact` event, resume on briefing + tail. One
   visible line in the chat says so: *"Resumed from summary — full transcript in
   History."* The full verbatim history remains on disk and in the History view;
   only the model's working context is summarized. **This is the honest version of
   "save by summarizing": summarize to *fit*, never to *store*.*

Cost note: tier 3 costs one summarization call on the user's key/plan — the UI says
so before running it when the estimated input exceeds a threshold (default 50k
tokens), with "Resume from summary" / "Start fresh instead" choices.

### Pending work at switch time
- **Keep/Undo reviews:** already survive independently; the session records which
  eras it owns. Switching sessions with pending reviews keeps today's `newChat()`
  behavior (finalize = keep files, drop UI) but says so in one status line.
- **Running agent:** switching aborts it (as `newChat()` does today); the abort is
  recorded as an event so a resumed session shows *"(run interrupted)"* rather than
  a silent cliff.
- **Background commands / MCP servers:** reaped, recorded as events. Never
  auto-restarted on resume — the resumed chat *tells* the model what died via the
  reload/interrupt events, so the agent re-establishes state deliberately.

### Retention
Defaults: keep everything (it is the user's disk, and text is small). Settings for
max sessions per project and max age; deletion from the History UI is per-session
(move to OS trash, not unlink, for one level of oops-protection).

## 6. UI (classic, minimal)

- **History** button in the chat header (clock icon) → in-webview list, newest first:
  title · relative time · turn count · model. Click = resume; hover actions:
  Rename, Delete, "Copy as Markdown".
- **New Chat** unchanged in placement; after it, a one-line toast: *"Previous chat
  saved to History."* — teaches the feature exactly once (dismiss = never again).
- Command palette: `LevelCode: New Chat`, `LevelCode: Chat History`,
  `LevelCode: Resume Last Chat` (the `--continue` analog), `LevelCode: Export Chat
  as Markdown`.
- Multi-window: two windows on the same project each get their own live session;
  the History list shows both. A session file is owned by one window at a time
  (lockfile beside it, stale-lock timeout 30s) — the second window resuming the
  same session gets a read-only "open a copy?" prompt. No merge semantics.

## 7. Settings

| Setting | Default | Meaning |
|---|---|---|
| `levelcode.ai.sessions.enabled` | `true` | master switch (off = today's ephemeral behavior) |
| `levelcode.ai.sessions.dir` | `~/.levelcode/sessions` | hackability: point it anywhere (a dotfiles repo, an encrypted volume) |
| `levelcode.ai.sessions.autoTitle` | `true` | cheap-lane titles; off = first-message truncation |
| `levelcode.ai.sessions.resumeBudgetPct` | `40` | share of the context window resume may fill |
| `levelcode.ai.sessions.confirmCompactOverTokens` | `50000` | ask before a paid compact-on-resume |
| `levelcode.ai.sessions.maxPerProject` / `maxAgeDays` | `0` (unlimited) | retention |

## 8. Implementation phases

**Phase 1 — persistence spine** *(M)*
`sessionStore.js` (new, pure Node — unit-testable like `update.js`): slugging,
meta/append/read/scan/index, atomic index writes, lock files, schema versioning.
Wire `conversation`/`agentMessages`/checkpoint boundaries into per-turn appends;
live-session id in `workspaceState`; reload replays. *Exit test: kill -9 the editor
mid-turn; reopen; the session lists and resumes with at most the in-flight turn
missing.*

**Phase 2 — History UI + New Chat sealing** *(M)*
Webview list + actions, toast, palette commands, rename/delete/export. `newChat()`
seals + rotates. *Exit test: three chats in a row; all three listed, titled (fallback
titles), resumable; delete works; folder rename in Finder → sessions still listed
(under the stored real path) and resumable.*

**Phase 3 — resume tiers + titles** *(M)*
Three-tier resume with `compactAgentMemory` reuse; async cheap-lane titles; the
paid-compact confirmation; interrupted-run/reload honesty lines. *Exit test: a 200k-
token stored session resumes into a 128k-window model via tier 3, the briefing chat
line appears, and the next agent turn acts on state only present in the summarized
head (proving the briefing carried it).*

**Phase 4 — polish** *(S)*
Markdown export, retention settings, multi-window locks, `sessions.dir` relocation,
docs page + walkthrough entry. *Exit test: EXIT-TEST.md additions all green.*

**Deliberately later:** M9 encrypted sync of `~/.levelcode/sessions` (same format —
this design is the sync payload); LevelLinks "share a run" (same format — a session
file is the replay source); cross-session memory ("what did we decide last week?" —
search over JSONL is trivially greppable, an agent tool over it is a natural S-size
follow-up).

## 9. Test plan (beyond exit tests)

- `test/sessionStore.test.js`: slug edge cases (unicode paths, root, UNC), append/
  scan roundtrip, index self-heal from deliberate corruption, lock stealing after
  timeout, schema `v` forward-refusal, cap-elision determinism.
- Resume-tier unit tests with a fake tokenizer: boundary math at exactly `B`,
  compact-event incremental path, tool-pair integrity across the cut (reuses the
  existing boundary-picking function — test it directly).
- Manual matrix in EXIT-TEST.md: crash, reload, rename-folder, two-window, BYOK vs
  gateway title/compact costs surfaced correctly.

## 10. Risks, honestly

- **Transcripts contain code.** They already transit the model; at rest they are
  plain files in the user's home directory, same trust class as the code itself.
  Anything that later *shares* a session (LevelLinks) must scrub — that is that
  feature's burden, recorded here so it is not forgotten.
- **Compact-on-resume costs money** and briefings lose nuance. Mitigations: verbatim
  tier preferred, explicit confirmation over the threshold, full transcript always
  kept, briefing visibly marked in the chat.
- **Two windows, one project** is the only real concurrency surface; the lockfile +
  read-only fallback keeps it boring.
- **Index drift** is a solved non-risk by construction: scanning is the source of
  truth, the index is a cache.
