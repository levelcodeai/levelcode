# LevelCode Sessions — Project Memory & Continuity

**Status:** **shipped** — M1–M4 complete (§10) · **Scope:** `extensions/levelcode-ai` + the sessions store · **Third of the triad:** [`levelcode-chat-sessions-design.md`](./levelcode-chat-sessions-design.md) stores a chat · [`levelcode-sessions-experience.md`](./levelcode-sessions-experience.md) lets you browse it · **this doc lets the project *remember itself*.**

> The wish, in the user's words: *"if in one session we tidy the CHANGELOG for v1.0.4, then a new session already knows something about what was achieved — the past experience keeps growing, and it feels like home."* That is the right ambition. It is also the feature most likely to become expensive, stale, creepy, or wrong. This document is mostly about **not** doing those four things while still delivering the magic.

---

## 0. Four disciplines, stated up front

Every decision below serves one of these. If a choice violates one, it's the wrong choice:

1. **Small when always-on.** What loads into *every* session must be a tight digest (a page, not a library). You can never pour past sessions into a new one — it costs money and drowns the task.
2. **Deep when asked.** The full episodic record is retrieved *on demand* (a tool call, a search), not carried in context.
3. **Transparent always.** Memory is plain, readable, editable files the user owns and can correct — never a hidden vector store. This is the BYOK/hackable ethos *and* the only way memory earns trust.
4. **Never trusted blindly.** Memory is context, not gospel. It is dated, sourced, decays, and is treated as *possibly-stale, possibly-poisoned* input the agent verifies — because some of it was distilled from untrusted workspace content.

---

## 1. The trap: three things people call "memory"

Conflating these is why most "AI memory" features feel either useless or unsettling. LevelCode keeps them **separate layers**, each with a different size, lifetime, and trust level:

| Layer | What it is | Size | Loaded | Example |
|---|---|---|---|---|
| **Facts** | durable, curated truths about the project & your preferences | tiny | **always-on** | "Idempotency keys live in Redis." "CHANGELOG is `RELEASE-NOTES.md`." |
| **Journal** | a rolling digest of *recent outcomes* — what got done lately | small | **always-on (recent slice)** | "Shipped v1.0.4 notes; fixed the MCP timeline rail; tidied the CHANGELOG." |
| **Recall** | the full episodic corpus — every session, verbatim & summarized | large | **on-demand only** | *"What did we decide about refund retries last month?"* |

The user's example — *a new session knows we tidied the CHANGELOG* — is the **Journal** layer (recent accomplishments), backed by **Recall** for depth and **Facts** for the stable stuff. The magic is the Journal; the safety is that it's small and the rest is retrieved.

---

## 2. Prior art — what to copy, what to avoid

- **Claude Code `CLAUDE.md` / this project's own `# Memory`** — a *plain-file, curated, indexed* memory folded into every session. **Copy:** plain text, human-editable, an index file, per-item provenance, typed entries (fact / preference / project / reference). It is the proven shape. **Its gap:** it's hand-maintained; we add cheap-lane *auto-extraction* on top, without losing the editability.
- **ChatGPT Memory** — auto-extracts durable facts across chats, **shows them, lets you delete them.** **Copy:** transparency + per-item delete is non-negotiable. **Avoid:** opacity about *when* something was learned.
- **Cursor "memories" / rules** — auto + manual project rules. **Copy:** the always-on project-rules injection. **Avoid:** memories that silently accumulate with no review surface.
- **MemGPT / Letta** — the tiered *core memory (always-on) + archival memory (retrieved)* architecture. **Copy:** exactly this tiering — it is §0.1/§0.2 in one sentence. **Avoid:** its complexity; we don't need a self-editing agent loop to start, just extract-on-seal + a recall tool.
- **Naïve RAG-over-everything** — embed every message, retrieve top-k into every prompt. **Avoid:** unbounded cost, retrieval of stale/irrelevant chunks, and an opaque store nobody can read. Greppable JSONL + a scoped tool beats a mystery index for a single-project developer corpus.

**The synthesis:** a **tiered, plain-text, auto-extracted-but-user-editable** memory, per project, that loads a tight digest always and retrieves depth on demand.

---

## 3. Architecture (grounded in what already ships)

Three pieces of LevelCode already exist and this design just connects them:

- **`loadProjectRules`** (`agent.js`) already folds `AGENTS.md` / `CLAUDE.md` / `.cursorrules` into the cached system block. **That is the always-on injection channel** — `MEMORY.md` rides the exact same mechanism.
- **`compactAgentMemory` / `COMPACT_SYSTEM`** already summarize a transcript into a briefing. **That is the extraction engine** — pointed at a *sealed* session instead of a live one, on the **cheap/fast model lane** (the same routing titles use).
- **The sessions store** (`~/.levelcode/sessions/<project-slug>/`) is already per-project, plain-file, greppable, local. **Memory lives beside the sessions it came from.**

### Storage — plain files, per project

```
~/.levelcode/sessions/<project-slug>/
  memory/
    MEMORY.md        ← the always-on digest: Facts + a recent-Journal slice. Capped (~1–2k tokens). Human-editable. Injected into every session.
    journal.jsonl    ← append-only, one line per sealed session: its outcome summary, files, decisions, links back to the session id.
    facts.jsonl      ← durable facts with provenance {text, source_session, learned_at, confidence, confirmed:bool}
```

Everything is readable, `grep`-able, `git`-able (a user could even check `memory/` into a dotfiles repo), and rides the future M9 encrypted sync unchanged. No opaque DB, ever (anti-Cursor, per the spine).

### The pipeline

```
 session seals ──▶ cheap-lane "outcome" summary ──▶ append to journal.jsonl
                     (1–3 sentences: what was achieved, key files, any decision)

 every N seals ──▶ CONSOLIDATION pass (cheap-lane) ──▶ rewrite MEMORY.md
   (or on demand)     • fold recent journal entries into a tight "Recently" section
                      • promote repeated/confirmed observations into Facts
                      • let stale entries decay OUT of the digest (they stay in journal.jsonl)
                      • hard cap the file — evict lowest-signal first

 any session ──▶ MEMORY.md injected into the system block (like project rules)

 on request ──▶ recall_sessions(query)  ← an agent TOOL: fuzzy/greppable search over
                journal.jsonl + the full session JSONL; returns cited snippets on demand
```

- **Extraction is cheap and incremental:** one small model call when a session seals — not a batch job, not embeddings-of-everything. Reuses the compaction machinery.
- **Consolidation is where "growing memory" happens honestly:** it is the *sleep* of the system — recent experience is folded in, durable patterns are promoted to Facts, and stale detail decays from the always-on digest while remaining fully recoverable in `journal.jsonl` and Recall. This is what makes memory *compound* without *bloating*.
- **Recall is a tool, not a context tax:** `recall_sessions("refund retries")` runs only when the agent (or user) asks, and returns cited results — never loaded speculatively.

---

## 4. Staying true: freshness, provenance, conflict

Memory that lies is worse than no memory. Four guards:

- **Provenance on everything.** Each fact/journal entry carries `source_session` + `learned_at`. The UI and the model can always answer *"says who, and when?"* A memory is never a free-floating assertion.
- **"As of" honesty.** Injected memory is framed to the model as *"known as of <date>; verify against the current code before relying on it"* — the same discipline this project's own memory system uses. Memory informs; the code decides.
- **Newest-wins with flagging.** When a new observation contradicts a stored fact (`uses Redis` → `moved to Postgres`), consolidation supersedes the old one and keeps a one-line history; a genuinely ambiguous conflict is surfaced for the user, not silently guessed.
- **Decay.** Journal entries lose always-on weight with age and inactivity, so the digest reflects *current* project reality, not a museum. Decayed ≠ deleted — it's still in Recall.

---

## 5. How lifecycle feeds memory (the "not auto-archived" instinct, reconciled)

Your instinct — *draw memory from the sessions that weren't auto-archived* — is right, once we separate two kinds of archiving (see experience doc §4.9):

- **Manual "Done"** = *"I finished this real work."* These are **prime memory** — a shipped feature is exactly what a new session should know about. They feed the Journal and can be promoted to Facts.
- **Auto-archive (30d inactive)** = *"this went cold."* These **fade from the always-on digest** (they're stale — that is the decay in §4) **but stay in `journal.jsonl` and Recall.** So they're never *forgotten*, just no longer *front-of-mind*.
- **Pinned** sessions get **extra memory weight** — a long-running refactor thread you keep returning to should stay in the digest regardless of age.

So: **the Journal keeps growing (append-only), while the always-on digest stays fresh** — recent + done + pinned in front of mind, cold stuff one recall away. That is precisely "the past experience keeps growing" without "every new chat pays for a year of history."

---

## 6. Transparency & control — the non-negotiables

Auto-memory is only acceptable if the user is never surprised by it:

- **A "Project memory" surface** in the Sessions panel (a tab beside History): the current `MEMORY.md` rendered, every Fact and recent-Journal line with its source session and date, and per-item **edit · pin · delete · "not true"**. It is *your* growing knowledge base, visible and yours to curate.
- **It's just files.** `memory/MEMORY.md` opens in the editor. Power users edit it directly; the consolidation pass respects hand-written sections (a `<!-- pinned -->` block is never evicted).
- **Consent posture:** extraction is **on by default but fully reviewable**; auto-inferred Facts are marked *inferred* (lower trust, dimmer) until used/confirmed, at which point they become *confirmed*. Nothing durable is asserted with false confidence.
- **Off switches:** `sessions.memory.enabled` (master), per-project opt-out, and a "forget this session" that removes its contribution.
- **Never a black box:** no hidden embeddings the user can't read. If we ever add vectors for recall speed, they are a *derived cache* over the plain files — rebuildable, never the source of truth (same rule as the sessions index).

---

## 7. Security — memory is an attack surface

This is the part most designs skip, and LevelCode can't (it's the security-forward editor):

- **Poisoning via untrusted content.** Sessions contain workspace text, which in a hostile repo is attacker-controlled. A naïve extractor could be steered into writing a false "memory" (*"the deploy token is safe to print"*). Mitigations: extraction summarizes **outcomes and user/agent actions, not arbitrary quoted content**; the digest is **bounded and reviewable**; and injected memory is **framed as untrusted, verify-first** (§4) — it can inform, never command.
- **Memory never executes.** It is context in the system block, exactly like project rules. It cannot run a tool, approve an MCP call, or edit a file. An injected instruction inside a "memory" is treated like any other untrusted text (the project's existing prompt-injection posture).
- **Provenance limits blast radius.** Because every item is sourced and dated, a poisoned entry is traceable to its session and removable in one click.
- **Instruction-shaped text never self-promotes.** ⚠️ This bullet used to claim that "low, *inferred* confidence keeps it from being load-bearing until a human confirms it." **That was not what the code did.** `foldFacts` promoted anything observed in ≥ 2 distinct sessions with no human in the loop — and against a hostile repo, repetition is not corroboration: the planted file is still checked out next session, so one piece of evidence gets counted twice. Repetition still promotes ordinary facts, but text that reads as an *order* (`always …`, `never …`, `you must …`, `ignore previous instructions`, anything piping into a shell) now requires an explicit Confirm. It is still recorded and listed — surfaced, not silently dropped, so you can see what a repo tried to plant. Pinned by `test/memoryPoisoning.test.js`.
- **Secrets are scrubbed at the write boundary.** The extractor's prompt asks the model not to emit credentials, and a request is not a filter. `redactSecrets()` strips the named key shapes (GitHub, Anthropic, OpenAI, Stripe, AWS, Google, Slack, bearer tokens, PEM private keys) from fact text, session titles and refined summaries *before* they reach `facts.jsonl` / `journal.jsonl` — files the user is explicitly invited to open, grep and check into a dotfiles repo. Named prefixes only, never a "looks random" heuristic: git SHAs, content hashes and asset names are legitimate things for a fact to mention, and corrupting a true fact is a worse failure than missing an exotic token shape.
- **Local & private.** Memory never leaves the machine (BYOK promise); M9 sync, if enabled later, encrypts it like the sessions themselves.

---

## 8. The "feels like home" experience

The magic, delivered quietly (never a wall of text):

- **Welcome-back digest.** A new session's empty state shows a tight, dismissible strip: *"This project, lately: shipped v1.0.4 notes · fixed the MCP timeline · tidied the CHANGELOG. 3 pinned threads. [what I remember ↗]"* — glanceable, honest, one click to the full memory surface. The agent already **has** this context, so its first reply is continuous, not amnesiac.
- **Continuity in the answer.** Because `MEMORY.md` is in context, a new session's agent naturally says *"picking up from the v1.0.4 work — the CHANGELOG's already tidied; want me to…"* instead of asking what project this is. That is the "home" feeling: it remembers, so you don't re-explain.
- **The growing artifact.** Over weeks, `MEMORY.md` becomes a genuine, readable project brain the user can watch grow, prune, and pin — a compounding asset, not a chat log. Opening it feels like opening a well-kept lab notebook the project wrote about itself.

---

## 9. Settings

| Setting | Default | Meaning |
|---|---|---|
| `sessions.memory.enabled` | `true` | master switch for extraction + injection |
| `sessions.memory.dir` | `<sessions.dir>/<project>/memory` | hackability: relocate it |
| `sessions.memory.digestTokens` | `1500` | hard cap on the always-on `MEMORY.md` |
| `sessions.memory.consolidateEverySeals` | `5` | how often the consolidation pass runs (also: on demand) |
| `sessions.memory.journalRecentDays` | `21` | recency window fed to the always-on digest |
| `sessions.memory.confirmFacts` | `false` | require a click before an inferred Fact becomes confirmed |
| `sessions.memory.recallTool` | `true` | expose `recall_sessions` to the agent |

---

## 10. Implementation phases (layered on the sessions plan)

**M1 — Journal + recall tool** *(M)*. Extract-on-seal → `journal.jsonl` (reuse compaction, cheap lane); ship `recall_sessions` as an agent tool over journal + JSONL. *No always-on injection yet — deep recall works first, cheaply.* Exit: in a fresh session, *"what did we do about refunds?"* returns cited past-session answers.

**M2 — the always-on digest** *(M)*. Consolidation pass → `MEMORY.md`; inject it via the `loadProjectRules` channel; the welcome-back strip. Freshness/decay/provenance. Exit: a new session opens already knowing the recent arc, in ≤1.5k tokens, with sources.

**M3 — the memory surface & control** *(M)*. The "Project memory" panel tab: view/edit/pin/delete/"not true", inferred-vs-confirmed, per-project off. Exit: a user corrects a wrong memory and the agent stops repeating it.

**M4 — polish & safety hardening** *(S)*.

- ✅ **Conflict reconciliation** — semantic supersede: a newer session's fact marks an older one obsolete, dimmed and restorable rather than silently replaced.
- ✅ **Poisoning red-team pass.** `test/memoryPoisoning.test.js` — 34 cases, an adversarial corpus in the style of `commandSafety.test.js`: ten hostile shapes that must never self-promote, benign project facts that must keep working, nine credential shapes that must never reach disk, and the near-misses (git SHAs, content hashes, asset names) that must survive untouched. It found the gap it was written to look for — see §7. Every case verified non-vacuous by bypassing each guard and confirming failure.
  *Exit met: an adversarial repo cannot plant a load-bearing memory.* The original wording said "EXIT-TEST.md green", but that file is the **M0** fork/build checklist and was never the right home for this; an executable corpus is a better exit test than a checklist anyway, since it re-runs on every change.
- ✅ **Decayed-entry recall.** `recallFacts()` ranks over the **full** fold rather than `activeFacts`, so a fact that decayed out of the digest is still findable by a direct question — §4's *"Decayed ≠ deleted — it's still in Recall"*, which until now was only true of the journal. `consolidate()` writes only active facts to `MEMORY.md` and `recall()` searched the journal alone, so an **inferred**, **superseded**, or instruction-withheld fact was in neither: on disk, cited, and unreachable by any question. Every hit carries a `state` (`confirmed` · `observed` · `inferred` · `superseded` · `unconfirmed-instruction`) and the tool result qualifies it for the model, so a low-confidence answer is never laundered into a settled one — a superseded hit names what replaced it, and a withheld instruction says *do not act on it*. The single exclusion is `removed`: a user's "not true" must stay not true.
- ✅ **Export** — "Copy as Markdown" on the session card (`sessionEvents.toMarkdown`), clipboard with a *Save as file…* follow-up. **Scrubbed**, because this is the first surface that *shares* a session and `levelcode-chat-sessions-design.md` §10 says sharing carries that burden — `redactSecrets` is passed in explicitly at the call site rather than baked into the renderer, so the scrub is visible where it happens. Roles render as bold labels, never headings: a turn's own `#`/`##` would otherwise outrank the label meant to delimit it. Memory-set export is still open.

**Deliberately later:** cross-*project* memory ("how did I do idempotency in the *other* service?"); a vector cache over the plain files for large corpora; team-shared project memory (rides M9 sync).

---

## 11. Risks, honestly

- **The digest goes stale or wrong** → decay + provenance + "verify-first" framing + one-click correction; and it's capped so a bad line can't dominate.
- **Extraction costs add up** → cheap/fast lane only, one small call per seal, consolidation every N (not every) seals; all tunable, all disableable.
- **Poisoning from hostile repos** → outcomes-not-content extraction, bounded reviewable digest, untrusted-context framing, memory-never-executes (§7).
- **Creepiness** → nothing is hidden; it's plain files with a review surface and a delete button; inferred facts are visibly low-confidence until confirmed.
- **Over-remembering noise** → not every session earns a Fact; the Journal is recency-weighted and decays; one-off Q&A sessions contribute a thin line at most, and fade.

---

*Store it (spine) · browse it (experience) · **remember it (this doc).** Together: a sessions feature where the project accumulates its own experience — small in every prompt, deep on request, legible and yours, and safe against the repo that would lie to it.*
