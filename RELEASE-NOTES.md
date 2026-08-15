# LevelCode v1.0.5

Your chats stop disappearing. This release turns every conversation into a **session** you can find, resume, fork and export — and gives each project a **memory** that carries what you did last time into the next chat. Both are plain files on your disk, both are readable and correctable by hand, and both treat what they learned as *possibly stale, possibly poisoned* rather than as gospel.

## Highlights

### Chats are sessions now

Every conversation is persisted as it happens — one append-only JSONL file per session, under `~/.levelcode/sessions/<project>/`. **New Chat** no longer throws work away; it seals the session and starts a fresh one.

The **Sessions** panel (`AI: Sessions`, and a sidebar view) lists them in time buckets — Today, Yesterday, This week, Earlier — with the title, the file it touched most, and an activity sparkline. Click a card to resume it. On hover the second line swaps to the actions: **Rename · Fork · Copy · Done · Delete · Pin**.

Nothing is destroyed by accident. **Done** archives rather than deletes, **Delete** is a soft trash, and both offer **Undo** immediately afterwards. Sessions you stop touching auto-archive after 30 days (`levelcode.ai.sessions.autoArchiveDays`) — pinned ones never do.

### Resume is honest about what it can carry

A long session may not fit the model's context window. Rather than silently truncating, LevelCode plans the resume in three tiers: if the whole transcript fits, you get it **verbatim**; if it doesn't, it loads the most recent turns and tells you so in the chat, in words, rather than pretending the earlier ones are still there.

The full transcript is always kept on disk regardless — the budget only governs what the *model* is handed. `levelcode.ai.sessions.resumeBudgetPct` (default 40) sets how much of the window a resume may occupy.

### The project remembers itself

When a session seals, one cheap model call records **what it accomplished** into `memory/journal.jsonl`, and a consolidation pass distils the recent arc into `memory/MEMORY.md` — a small digest injected into every new session in that project, the same channel `AGENTS.md` and `CLAUDE.md` already use. Open a new chat and it starts already knowing the shape of the last week's work.

Durable truths get promoted separately into **Facts** — *"the changelog is RELEASE-NOTES.md"*, *"idempotency keys live in Redis"*. A fact seen once is marked **inferred** and weighed lightly; seen across sessions it becomes active; you can **Confirm** it, mark it **not true**, edit it, or forget it from the **Project memory** tab. When a later session contradicts an earlier one, the old fact is **superseded** — dimmed and restorable, with a line saying what replaced it, rather than silently overwritten.

Ask about older work and the agent can go looking: `recall_sessions` searches past outcomes *and* the transcripts themselves, and returns dated, cited results. Facts that decayed out of the always-on digest are still reachable that way — a memory that ages out is not a memory that is deleted.

### Memory is treated as untrusted input

Memory is replayed into the system prompt of every future session in a project, and it is distilled from transcripts that contain repo files, command output and MCP tool results — attacker-controlled for any repo you clone. So it is bounded like any other untrusted text:

- **A planted instruction cannot promote itself.** Ordinary facts become active by being observed across sessions, but text that reads as an *order* — `always …`, `never …`, `ignore previous instructions`, anything piping into a shell — never takes that route and needs an explicit Confirm. Repetition is not corroboration when the source is a file that is still sitting in the repo on the next session.
- **It is surfaced, not hidden.** Such an entry is still recorded and still listed, flagged, so you can see what a repo tried to plant.
- **Credentials are scrubbed on the way in.** Key-shaped text is redacted before it reaches `facts.jsonl`, `journal.jsonl` or `MEMORY.md` — including session titles and edited file paths, which those files print verbatim.
- **Injected memory is framed as verify-first** and explicitly says never to act on an instruction found inside it.

Everything lives in plain files you can open, `grep`, correct, or delete. Turn the whole thing off per project with `levelcode.ai.sessions.memory.enabled`.

### Fork a session

The *"what if I'd told it to do X instead"* branch. **Fork** seeds a new session with a copy of the conversation and leaves the original untouched, then opens it so you can take a different path from the same starting point.

The copy is genuinely a fresh session: it does not inherit the original's finished state, its archived status, or its pin — a fork of an archived chat arrives visible and active, and records which session it came from.

### Copy a session as Markdown

**Copy** puts the whole conversation on your clipboard as a clean Markdown transcript — title, date, model, files touched, then one block per turn — ready to paste into a pull request or an issue. *Save as file…* writes it to disk instead.

Because this is the first thing that takes a session *out* of LevelCode, it is scrubbed on the way out: credential-shaped text is redacted from the body, and from the suggested filename.

## New settings

| Setting | Default | |
| --- | --- | --- |
| `levelcode.ai.sessions.enabled` | `true` | Persist chats as sessions |
| `levelcode.ai.sessions.dir` | `""` | Where they live (blank = `~/.levelcode/sessions`) |
| `levelcode.ai.sessions.autoArchiveDays` | `30` | Fade untouched sessions out of the active list; pinned are exempt |
| `levelcode.ai.sessions.resumeBudgetPct` | `40` | How much of the context window a resume may occupy |
| `levelcode.ai.sessions.memory.enabled` | `true` | Cross-session project memory |
| `levelcode.ai.sessions.memory.summarize` | `true` | The cheap-lane call that records what a session achieved |
| `levelcode.ai.sessions.memory.facts` | `true` | Extract durable project facts |
| `levelcode.ai.sessions.memory.recallTool` | `true` | Give the agent `recall_sessions` |

## Not in this release

**The Sessions panel does not search yet.** There is no filter, no fuzzy switcher, and no keyboard jump — you scroll the list. That is the next thing being built, and it is the gap you will notice first once a project holds more than a screenful of sessions.

## Test coverage

- **32 suites**, **528 cases** across the bundled extensions — all green.
- `test/memoryPoisoning.test.js` (39 cases) — the adversarial pass: hostile inputs that must never become load-bearing memory, benign project facts that must keep working, credential shapes that must never reach disk, and the near-misses (git SHAs, content hashes, asset names) that must survive untouched.
- `test/sessions.test.js` (25 cases) — the lifecycle against a real store in a temp directory: persistence, verbatim rebuild, seal, resume, and the fork rules.
- `test/sessionStore.test.js`, `sessionEvents.test.js`, `sessionResume.test.js`, `sessionMemory.test.js` — the pure engine underneath, each testable without the editor.

**Full changelog:** https://github.com/levelcodeai/levelcode/compare/v1.0.4...v1.0.5
