# LevelCode Sessions — Experience Design

**Status:** proposed · **Scope:** `extensions/levelcode-ai` webview + a thin store · **Builds on:** [`levelcode-chat-sessions-design.md`](./levelcode-chat-sessions-design.md) (the persistence spine) · **Owns:** everything a user sees, touches, and feels

> The spine doc answers *"how is a chat saved and resumed?"* — append-only JSONL, project-slug directories, three-tier resume. It is right, and this document does not relitigate it. This document answers the harder, unspecced half: **what is it like to live with your chat history?** That half is where Copilot and Cursor are beatable, and where an award is won or lost.

---

## 0. The thesis

An AI editor's session history is not a filing cabinet. It is the record of everything you and the agent have built together — the place you return to when you think *"I fixed this exact bug three weeks ago, how?"* Both incumbents treat it as a dropdown of titles. That is the opening.

**LevelCode Sessions is a browsable memory of your work, rendered with the same restraint and craft as the editor around it.** Not a feature bolted on — a first-class surface that looks like it was always meant to be there, moves like it costs nothing, and tells you the truth about what happened (including when a run was interrupted or a resume had to summarize to fit).

Three commitments, in priority order:

1. **Honest before beautiful.** A session that was interrupted, reloaded, or resumed-from-summary says so — legibly, never as a silent cliff. Awwwards juries reward polish; developers reward trust. We refuse to trade one for the other.
2. **Instant before rich.** Every primary action — resume the last chat, jump to a session, search — is reachable by keyboard in under a second, with zero mouse travel. Richness (previews, sparklines) is layered on top of a spine that is already fast.
3. **Native before novel.** It must feel like it belongs inside VS Code and inside LevelCode's "classic" (atom.io) identity — theme-aware to the pixel — *then* it can do things Copilot and Cursor can't.

---

## 1. Competitive teardown (the experience, not the storage)

The spine doc already dissected the *storage* of each incumbent. Here we dissect the *experience*, because that is what we are competing on.

### VS Code Copilot Chat — "the dropdown"
- **The surface:** a **quick-pick** (the same list widget as the command palette) titled "Show Chats." A flat, single-line-per-item list: title + relative time. That's it.
- **Where it's weak:** no preview of what a session *was*; no sense of size or activity; no in-place actions (rename/delete live in a `…` submenu or separate commands); the quick-pick evaporates on focus loss, so you can't browse and work side by side; nothing communicates a session's *state* (finished vs abandoned mid-run). It is a picker, not a place.

### Cursor — "the sidebar list"
- **The surface:** a **History panel** in the sidebar — a scrolling list of past chats/composers with an auto-title and a timestamp; click reopens; checkpoints let you rewind files within a chat.
- **What's genuinely good:** it's a persistent panel you can live next to; checkpoints are a real idea; titles are decent.
- **Where it's weak:** every row is visually identical — a title and a date, no information *design*; no way to see at a glance which session touched `RefundService` or ran 40 tools vs 3; search is by title only (the SQLite store isn't greppable, so you can't find a session by a command it ran or a file it edited); storage is opaque, so power users reach for third-party exporters; and the whole thing is competent but *characterless* — it could be any app's history list.

### The others, for inspiration
- **Claude Code** (`--resume` picker): terminal-native, but the append-only JSONL model is the right substrate and its "compact to fit" moment is honest. We adopt the substrate (spine doc) and give it a GUI it never had.
- **Warp / Raycast / Linear:** the bar for *keyboard-first command surfaces* and *considered motion* in developer tools. Linear's issue list and Raycast's root search are the interaction quality we benchmark the switcher against.

### The gap, stated as a target
> Copilot gives you a **list of titles**. Cursor gives you a **better list of titles**. LevelCode gives you a **map of your work** — every session legible at a glance (what it touched, how big it was, whether it finished), findable by anything it *did* (not just what it was named), and resumable in one keystroke.

---

## 2. Design principles

1. **The card carries the story.** A session row is not a line of text; it is a compact information object — title, when, model, size, what it touched, whether it finished — designed so the *right* session is recognizable without opening it.
2. **Two doors, one room.** A **panel** for browsing (mouse, exploration, management) and a **command-palette switcher** for jumping (keyboard, muscle memory). Same data, same model, two access patterns — never make the user use the wrong one.
3. **Search what it did, not what it's called.** Because storage is greppable JSONL (spine), search can index files touched, commands run, and models used — not just titles. This is the single biggest experiential lead over Cursor, and it falls out of the storage choice for free.
4. **Motion is feedback, never decoration.** Every animation answers "what just happened / where did this come from / where did it go." A card lifts because it's focusable; a resume morphs because the session *becomes* the conversation; nothing moves to be impressive. All of it respects `prefers-reduced-motion`.
5. **Theme-truth.** One Dark and One Light are designed with equal care; high-contrast defers entirely to `--vscode-*` tokens. If it looks wrong in any of the three, it is wrong.
6. **Tell the truth about time.** Interrupted runs, reloads, and summarize-to-fit resumes are *rendered*, not hidden. Honesty is the brand.

---

## 3. Design language

Grounded in LevelCode "classic" (the atom.io identity already shipped on the account modal), so Sessions looks like the same product.

### Palette (reuse the shipped `--cc-*` tokens)

| Token | One Dark | One Light | High-contrast |
|---|---|---|---|
| `--cc-bg` | `#282c34` | `#ffffff` | `--vscode-editor-background` |
| `--cc-surface` | `#21252b` | `#fafaf9` | `--vscode-editorWidget-background` |
| `--cc-text` | `#dcdfe4` | `#333333` | `--vscode-foreground` |
| `--cc-text2` | `#abb2bf` | `#555555` | `--vscode-foreground` |
| `--cc-text3` | `#828997` | `#777777` | `--vscode-descriptionForeground` |
| `--cc-line` | `#3e4451` | `#e0e0e0` | `--vscode-contrastBorder` |
| `--cc-accent` | `#7d6bff` | `#5b3fd6` | `--vscode-textLink-foreground` |

Semantic accents (used sparingly, only for state): `--cc-ok` (One Dark `#4ec9b0` / One Light green), `--cc-warn` (`#d19a66`), `--cc-danger` (`--vscode-errorForeground`). These encode session *state* (finished / interrupted / error) and never double as the brand accent.

### Type
- **Sans** (system UI stack) for titles and body — `-apple-system, BlinkMacSystemFont, "Segoe UI"…`.
- **JetBrains Mono** for all data: timestamps, turn counts, model ids, file chips, command snippets. `font-variant-numeric: tabular-nums` everywhere digits align (counts, times, sizes) so columns don't shimmer.
- Scale: card title 14px/600, meta 11.5px mono, section headers 11px mono uppercase +0.08em tracking (matches the existing "Synced · settings · skills" footer treatment).

### Shape & elevation
- `.classic-card` radius **6px**; interactive controls radius **4px** (shipped conventions).
- Elevation by **1px border + a single soft shadow on lift only** — never resting shadows (flat by default, like the rest of the webview). Hover/focus raises `box-shadow: 0 6px 20px rgba(0,0,0,.18)` (dark) with a `--cc-accent` hairline.

### The chevron/portal motif
The landing-page chevron (three rising strokes over drifting portal circles, `portalDrift 7s`) is LevelCode's signature. Sessions uses it in exactly **two** places, so it stays special:
- the **empty state** (first run — a large, calm, drifting chevron over "Every chat you have is saved here"),
- the **switcher's resting glyph** (a small static chevron where a result thumbnail would be).
It never decorates a populated list — populated lists are about the user's work, not our logo.

### Motion tokens
- `--mo-fast: 120ms` (hover, focus, chip toggles)
- `--mo-base: 220ms` (card enter, panel open, filter reflow) — easing `cubic-bezier(.2,.9,.25,1)`
- `--mo-morph: 320ms` (the resume shared-element transition) — easing `cubic-bezier(.2,.8,.2,1.1)` (a whisper of overshoot)
- Under `prefers-reduced-motion: reduce`: all of the above collapse to opacity-only at `--mo-fast`, and the portal drift stops.

---

## 4. The surfaces

### 4.1 The Sessions panel — the hero

Reached by the **clock icon** in the chat header, `⇧⌘H`, or `LevelCode: Chat History`. It is an **in-webview overlay panel** (not a separate VS Code view) so it inherits the chat's theme and can animate a session *into* the conversation on resume — a separate view can't do the shared-element morph.

**Anatomy, top to bottom:**

```
┌─ Sessions ───────────────────────────── ⌘F  ✕ ┐
│  ⌕ Search sessions, files, commands…           │   ← instant search, autofocus
│  [ This project ▾ ]  [ ⌂ all ] [ ★ ] [ ⟳ edits ] [ ⚠ interrupted ]   ← scope + filter chips
├────────────────────────────────────────────────┤
│  TODAY                                          │   ← time buckets, mono uppercase
│  ┌──────────────────────────────────────────┐  │
│  │ Idempotent refunds via Redis keys      ★  │  │   ← session card (see 4.2)
│  │ 2h ago · Opus 5 · 41 turns · ⣀⣠⣴⣶ ▏       │  │
│  │ refund.rb  redis_lock.rb  +3   · ✓ done   │  │
│  └──────────────────────────────────────────┘  │
│  ┌──────────────────────────────────────────┐  │
│  │ Debug the flaky payment webhook test      │  │
│  │ 5h ago · Kimi K2.7 · 12 turns · ⣀⣄⡀       │  │
│  │ webhook_spec.rb  · ⚠ interrupted          │  │
│  └──────────────────────────────────────────┘  │
│  YESTERDAY                                      │
│  …                                              │
└────────────────────────────────────────────────┘
```

- **Time buckets:** Today / Yesterday / This week / Earlier (then by month). Sticky bucket headers on scroll. This is how a human actually remembers work ("that was Tuesday"), and it beats a flat reverse-chron list.
- **Density:** default is the rich card above. A **compact** toggle (`⌘\`) collapses to a single mono line (title · time · turns) for users who prefer Copilot-terseness — respecting that some people want the dropdown. The preference persists.
- **Virtualized** list (§8) so 5,000 sessions scroll at 60fps.
- The panel **does not steal the conversation** — it slides over it from the right at `--mo-base`, and the conversation stays warm underneath (dimmed 40%), so dismissing feels like closing a drawer, not navigating away.

### 4.2 The session card — information design

This is the piece Cursor doesn't have. Every field earns its place by helping you recognize the session you want:

```
┌────────────────────────────────────────────────┐
│  Idempotent refunds via Redis keys           ★ │  ← title (14/600, 1 line, ellipsis); star = pinned
│  2h ago · Opus 5 · 41 turns · ⣀⣠⣴⣶⣶⣦⣀ ▏        │  ← meta row (11.5 mono): when · model · size · activity sparkline
│  refund.rb · redis_lock.rb · +3    ✓ done      │  ← files-touched chips (max 2 + overflow) · state pill
└────────────────────────────────────────────────┘
        hover ▸ reveals: [Resume ⏎] [Rename] [Fork] [Export] [Delete]
```

- **Title** — auto-generated (cheap-lane, per spine §Titles) or user-renamed. One line, `text-overflow: ellipsis`, full title on hover title-attr.
- **Activity sparkline** — a ~28px Unicode/`<canvas>` micro-bar of tool-calls-per-turn across the session. It tells you *shape* at a glance: a long ramp (big feature), a short spike (quick fix), a flat line then a cliff (interrupted). No incumbent shows this; it's cheap (the data is already in the JSONL) and instantly legible.
- **Files-touched chips** — the top 2 files this session *edited* (not read), + `+N` overflow. This is the single most useful recognition cue for developers ("the one that touched `refund.rb`") and is impossible in Cursor's title-only search. Derived from the `agent` edit events already stored.
- **State pill** — `✓ done` (`--cc-ok`), `⚠ interrupted` (`--cc-warn`), `✕ error` (`--cc-danger`), `↻ resumed-from-summary` (accent). This is the honesty layer as UI. A session that ended mid-run is *marked*, so History never lies about what finished.
- **Pin (★)** — pinned sessions float to a "Pinned" bucket above Today. For the handful of chats you return to (a long-running refactor, a design thread).
- **Hover/focus actions** — appear inline (not a `…` menu): Resume (primary, ⏎), Rename, **Fork** (see §6), Export as Markdown, Delete. Keyboard: arrow to a card, actions are on `⏎` (resume), `r`, `f`, `e`, `⌫`.

### 4.3 The switcher — keyboard-first resume

`⌘P`-for-sessions (bound `⌃⌘P` to avoid the file picker). A centered command-palette overlay, Raycast/Linear-grade:

```
┌─────────────────────────────────────────────┐
│ ⌕ refund                                     │
├─────────────────────────────────────────────┤
│ ▸ Idempotent refunds via Redis keys   2h  ⏎ │  ← fuzzy match on title + files + commands
│   Refactor RefundService retries      3d    │
│   Add refund webhook idempotency      1w    │
├─────────────────────────────────────────────┤
│ ⏎ resume   ⇧⏎ fork   ⌘⏎ open in split       │  ← footer legend
└─────────────────────────────────────────────┘
```

- **Fuzzy across the greppable fields** — typing `refund.rb` finds the session that edited it; typing `bundle exec` finds the one that ran it. This is the search Cursor structurally cannot do.
- **Sub-16ms keystroke response** on the in-memory index (§8); results reorder with a `--mo-fast` cross-fade, never a jarring repaint.
- **No mouse required, ever** — up/down, `⏎` resume, `⇧⏎` fork, `esc` dismiss. This is the "resume last chat in one keystroke" promise made real.

### 4.4 Search & filter (in the panel)

- **One field, three indexes:** title (weighted highest), files-edited, commands-run. Match highlights show *why* a session matched ("matched `refund.rb`").
- **Scope switch:** `This project` (default) ↔ `All projects` — because sometimes you remember the work, not the repo.
- **Filter chips** (toggle, combine): `★ pinned`, `⟳ has edits`, `⚠ interrupted`, `by model ▾`, `date ▾`. Chips animate in/out and the list reflows at `--mo-base`. Active filters are summarized in the empty-result state ("No interrupted sessions in the last 7 days — clear filters?").

### 4.5 The resume experience — the signature moment

Resuming is where LevelCode earns the award, because it is the one moment that is both a *transition* and a *truth-telling*.

- **The morph.** On resume, the session **card expands into the conversation** — a shared-element transition (`--mo-morph`, subtle overshoot): the card's title becomes the chat header title, its surface expands to fill, the panel dims away. The session doesn't "load"; it *becomes* the room. (Reduced-motion: a clean crossfade.)
- **Verbatim (tier 1).** The transcript replays instantly from JSONL. A hairline "· resumed" marker sits in the header; nothing else changes. The model sees exactly what it left.
- **Summarize-to-fit (tier 3), designed honestly.** When the stored transcript exceeds the resume budget, *before spending a token* a calm sheet appears:

  ```
  ┌ This chat is larger than the model's window ┐
  │ 214k tokens stored · Opus 5 fits ~128k      │
  │                                             │
  │ Resume from a summary of the early turns    │
  │ (≈ $0.04, one call) — the full transcript   │
  │ stays in History, untouched.                │
  │                                             │
  │   [ Resume from summary ]  [ Start fresh ]  │
  └─────────────────────────────────────────────┘
  ```

  After summarizing, a single in-chat line — *"Resumed from a summary of 41 earlier turns · view full transcript"* — is a **first-class, styled element** (accent left-rule, `↻` glyph), not a gray aside. Clicking "view full transcript" opens the verbatim history read-only. **This is the honest version of "save by summarizing": we summarize to *fit*, never to *store*, and we show it.**

- **What died is said.** If the session had background commands, MCP servers, or a running agent when it was last open, resume renders a quiet **"since you left"** strip: *"3 background processes and 1 MCP server were stopped when this chat was last closed. The agent will re-establish anything it needs."* — turning the spine's honesty events into UI. No incumbent does this; it is the difference between resuming a *state* and resuming a *transcript*.

### 4.6 New Chat — seal & rotate

- `⌘N` (in-panel) / the `+` in the header. The current session **seals** (final index write, async title if untitled) and a fresh one opens.
- **The affordance, taught once:** the sealed session doesn't just vanish — its card **flies to the History icon** (a `--mo-base` translate+scale to the clock, then the icon pulses once). First time only, a one-line toast: *"Saved to History (⇧⌘H)."* Dismiss = never shown again. This teaches the entire feature in one gesture, then gets out of the way.

### 4.7 Empty & edge states — where character lives

Awwwards juries read the empty states. Ours have quiet personality without cuteness:
- **First run:** the drifting chevron/portal over *"Every chat you have is saved here — automatically, on your machine, in plain files you can read."* (The last clause is the BYOK/hackable brand, stated as reassurance.)
- **No search results:** *"Nothing matches `refund.rb` in this project."* + `Search all projects ↗` + `Clear filters`.
- **Recovered index:** if `index.json` was corrupt and rebuilt by scanning (spine §self-heal), a one-time, dismissible strip: *"Rebuilt your history from disk — nothing was lost."* Honesty as reassurance, again.
- **A single interrupted session at the top:** gently offered — *"Pick up where you left off?"* on the most-recent interrupted session, once, on panel open.

### 4.8 In-chat session chrome

- The chat header shows the **live session title** (click to rename inline) with a subtle live-dot when a run is active. A breadcrumb affordance (`Sessions ▸ Idempotent refunds…`) lets you get back to the panel without the icon.
- A hairline **session age** in the header footer area (`started 2h ago · 41 turns · autosaved`) — quiet proof the autosave promise is being kept, so the user never wonders "is this being saved?"

---

### 4.9 Lifecycle — seal · done · archive · delete (and why never "remove on complete")

Completion is where a naïve design does real harm, so it gets its own model. **Two independent axes, and conflating them is the trap:**

- **Run state** (derived, automatic) — what the *agent* did last: `done · interrupted · error · resumed-from-summary`. This is the state pill (§4.2). Never user-set.
- **Lifecycle state** (user intent) — what *you* decided about the session: `active → done/archived → trashed`. This is "completion."

A session can be run-state `interrupted` yet lifecycle `done` (you gave up on it and filed it away). The two are drawn differently and never merged into one chip.

**Four verbs, three of them cheap:**

1. **Seal** (automatic — *not* completion). New Chat finalizes the *live* session (index write, async title). A sealed session is still **Active**. Seal just means "no longer the one you're typing into"; it is not a judgment that the work is done.
2. **Done / Archive** (the completion action). You mark a session complete: it **leaves the Active list** — the decluttering that is the entire point — and enters **Archive**, where it stays **fully searchable and resumable**. Reversible in one click. Implemented as a `{"kind":"label","lifecycle":"archived","t":…}` event **appended** to the JSONL — no file move, no rewrite — so it is crash-safe and greppable like everything else.
3. **Delete** (separate, heavier, recoverable). Moves the file to the **OS trash** — never `unlink` — and drops it from the index. For junk or privacy. Rare, because Archive already absorbs the clutter.
4. **Pin** (orthogonal). Keep a session prominent regardless of age; a pinned session is **exempt from auto-archive**.

**The best-practice call: archive on complete, never remove.** Removing a session when a user "finishes" it destroys the one thing the feature exists to provide — the ability to return to *how* you solved something. "I shipped the fix" is not "erase the record of it." Worse, an *irreversible* completion makes people afraid to mark done, so they never declutter and the feature fails at its single job. Storage is plain text and effectively free; there is no space pressure to delete. Every mature analog agrees: Gmail archives and trashes as separate acts; Arc auto-archives tabs; Linear and Things keep a completed view rather than deleting. So — **Done = archive (reversible); Delete = a deliberate, separate, recoverable act.**

**Manual, plus opt-in smart-auto:**

- **Manual Done** is primary — a checkmark on the card (`d`), a **bulk archive** for a day of one-offs, and a gentle offer at New-Chat seal *only* for short, clearly-finished one-offs (*"Archive this quick one?"* — dismissible, never forced).
- **Auto-archive** (`sessions.autoArchiveDays`, default **30**, `0` = off) — a session untouched for the window auto-archives, Arc-style, keeping Active fresh with zero janitorial work. It is **honest** (the card reads `archived · inactive 30d`), **exempts pinned**, and **never deletes**.
- **Never auto-delete.** Automatic destruction without consent is the one thing we don't do. An optional `sessions.trashArchivedAfterDays` (default `0` / off) exists for the rare aggressive-cleanup user — and even it only *trashes* (recoverable), only *archived*, never *pinned*.

**Reversibility everywhere:** archiving raises a toast with **Undo** (`⌘Z`); resuming an archived session offers *"reopen"* (un-archive); delete is trash, not unlink (spine §retention — one level of oops-protection).

**UI:** the panel shows **Active** by default; a scope pill toggles **Archive** (with its count — *"142 archived"*) and **Trash**. Archived cards render dimmed and re-activate inline. Card actions become **Resume · Done · Rename · Fork · Export · Delete** (`⏎ · d · r · f · e · ⌫`). The run-state pill and a small lifecycle glyph (active / archived) stay visually distinct.

**The one call that is genuinely yours:** whether auto-archive ships **on at 30 days** (my recommendation — it is the Arc magic that keeps the list alive for free) or **opt-in, off** (more conservative). And the verb: I lean **"Done"** (the decluttering framing users reach for) with *archive* as the mechanism underneath.

## 5. Signature interactions & motion (the differentiators)

Each is specific, cheap, and reduced-motion-safe:

1. **Card focus lift** (`--mo-fast`): border → `--cc-accent`, `translateY(-1px)`, soft shadow in. Communicates focusability; the whole list is arrow-navigable.
2. **Resume morph** (`--mo-morph`): the shared-element card→conversation transition (§4.5). The single most memorable moment; the thing a juror screenshots.
3. **Sparkline draw-in** (`--mo-base`, staggered 8ms/bar on first paint of a card entering the viewport): the activity bars grow from baseline. Ambient life, not noise; only on enter, never on scroll-back.
4. **Filter reflow** (`--mo-base`): cards that leave fade+collapse; remaining cards ease to new positions (FLIP). Turns filtering from a repaint into a legible rearrangement.
5. **Seal-to-history fly** (§4.6): the New Chat teaching moment.
6. **Search match shimmer** (`--mo-fast`): matched substrings get an accent underline that draws left-to-right — shows *why* a result matched.
7. **Portal drift** (`7s`, empty state + switcher glyph only): the brand's ambient signature, used with extreme restraint.

Global rule: **nothing animates on scroll** except the one-time sparkline draw-in; scrolling a history of your own work must feel like paper, not a parallax site. Restraint is the awwwards move here, not maximalism.

---

## 6. Features that beat the incumbents

Beyond the card and the search, the "wow" list — each grounded in the JSONL substrate so it's cheap to build:

- **Fork a session** (`⇧⏎`) — resume a *copy* from any point, leaving the original intact. The "what if I'd told it to do X instead" branch. Cursor's checkpoints rewind *files*; forking rewinds the *conversation*. Both, together, is new.
- **Files-touched search & chips** (§4.2/4.4) — find work by what it changed. The structural lead over Cursor.
- **Activity sparkline** (§4.2) — session *shape* at a glance.
- **The honesty layer as UI** — interrupted / reloaded / summarized states are pills and strips, not silence (§4.5, §4.7).
- **Pins & light tags** — `★` pin, plus optional freeform tags (`#refactor`, `#spike`) surfaced as filter chips. Small, opt-in, greppable.
- **"Copy as Markdown" / Export** — because the storage is plain text, a session exports to a clean Markdown transcript in one action; a natural share/paste-into-PR flow (and the seed of the later LevelLinks "share a run").
- **Cross-session recall (later, but designed-for)** — since storage is greppable JSONL, an agent *tool* over your own history ("what did we decide about idempotency keys last week?") is a natural follow-up; the card/search IA here is what makes its results presentable.

---

## 7. Information architecture → data

The rich UI needs a few fields beyond a bare transcript. All are **derivable by scanning the JSONL** (so the index stays a rebuildable cache, per spine §Index), computed once at seal and cached in `index.json`:

| Card field | Source | Notes |
|---|---|---|
| title | `title` event / first user msg | spine §Titles |
| when | `meta.createdAt` / last event `t` | relative, tabular |
| model | last `assistant`/`agent` turn's model | most-used, not last, if they differ |
| turns | count of `user` events | |
| sparkline | tool-calls per turn from `agent` events | array of small ints; ~1 byte each |
| files-edited | `edit_file`/`write_file` tool events | de-duped, ordered by edit count |
| state | terminal event kind | `done` / `interrupted` / `error` / `compact`-on-resume |
| pinned / tags | a `label` event | append-only, like titles |

**Extension to `index.json`** (still a cache, still rebuildable):
```json
{ "id":"…", "title":"…", "createdAt":"…", "updatedAt":"…", "turns":41,
  "model":"anthropic/claude-opus-5", "state":"done", "pinned":true,
  "filesEdited":["app/services/refund.rb","app/models/redis_lock.rb"],
  "spark":[1,3,2,5,8,6,4,2,1], "tags":["refactor"], "preview":"Add idempotency…" }
```
The webview never reads JSONL directly for the list — it reads this index (fast, small). It reads the full JSONL only on resume/preview. Clean separation: **index feeds recognition, JSONL feeds resumption.**

---

## 8. Performance

- **Virtualized list** — render only the ~20 cards in view + a small buffer; recycle nodes. 5,000 sessions must scroll at 60fps and open in <100ms.
- **Search index in memory** — on panel open, the extension hands the webview a compact index (title + filesEdited + commands, per project). Fuzzy match runs in the webview against it; keystroke→results < 16ms. All-projects scope loads lazily on switch.
- **Previews are lazy** — the sparkline array is in the index (cheap); a full hover-preview of the transcript is fetched on hover-intent (150ms dwell), never eagerly.
- **The index is a cache, never load-bearing** (spine §self-heal) — a missing/corrupt index rebuilds by scanning; the UI shows the recovered strip (§4.7) and is otherwise unaffected.

---

## 9. Accessibility & theming

- **Keyboard-complete.** Every action has a binding; the panel and switcher are fully operable with no pointer. Focus is trapped in the panel while open, restored to the composer on close. Documented map:

  | Key | Action |
  |---|---|
  | `⇧⌘H` | open/close Sessions panel |
  | `⌃⌘P` | switcher (fuzzy jump) |
  | `↑ ↓` | move selection |
  | `⏎` | resume · `⇧⏎` fork · `⌘⏎` split |
  | `d` | mark **done** (archive) · `⇧d` un-archive |
  | `r` `f` `e` `⌫` | rename · fork · export · delete (on focused card) |
  | `⌘F` | focus search · `⌘\` compact toggle |
  | `esc` | close (restores composer focus) |

- **Screen readers:** cards are a `role="listbox"` of `option`s with an `aria-label` composing the human summary ("Idempotent refunds, 2 hours ago, Opus 5, 41 turns, done, pinned"). Buckets are `group`s with labels. The state pill has a text equivalent, never color-only.
- **Reduced motion:** §3 motion tokens collapse to opacity; the morph becomes a crossfade; portal drift stops.
- **Three theme kinds, equal care:** One Dark / One Light designed deliberately; **high-contrast defers entirely to `--vscode-*`** (the account-modal precedent) — the accessibility choice always wins over the brand palette.

---

## 10. Implementation plan (experience layer)

Layered on the spine's Phase 1–4. Each phase ships something usable; none blocks on the next.

**E1 — the panel & the card** *(M)* — the Sessions overlay, time buckets, the rich card (title/meta/state), resume (verbatim tier), New Chat seal + fly-to-history. *Ships the moment History stops being a dropdown.* Exit: three sessions, browsable, resumable, recognizable at a glance; theme-correct in all three kinds.

**E2 — the switcher & search** *(M)* — `⌃⌘P` fuzzy jump; in-panel search over title+files+commands; filter chips; scope switch. *Ships the keyboard-first, search-what-it-did lead over Cursor.* Exit: type a filename, resume the session that edited it, in three keystrokes.

**E3 — the honesty layer & rich recognition** *(M)* — activity sparkline, files-touched chips, state pills, the interrupted/reload/summarize strips, the compact-on-resume sheet. *Ships the trust story and the visual lead.* Exit: an interrupted session is unmistakable in the list and on resume; a too-big session resumes via the honest sheet.

**E4 — signature polish** *(S)* — the resume morph, FLIP filter reflow, sparkline draw-in, pins/tags, seal-to-history fly, empty states, export-as-Markdown. *Ships the award.* Exit: the demo reel — open, search, fork, resume-with-morph — reads as one considered product.

**Deliberately later:** fork-visualized-as-a-branch-graph; cross-session recall agent tool; LevelLinks share-a-run; the M9 encrypted sync of the same files.

---

## 11. Testing the experience

The webview has no runtime DOM test harness, so we test the way the shipped code already does — **static invariants over the source** (`webviewCss.test.js` style: "bugs no DOM test can see"), plus pure-logic units and a manual matrix.

- **Static invariants** (`test/sessionsUi.test.js`): every session-card class that toggles at runtime has its `[hidden]`/state escape; the state-pill classes each map to a `--cc-*` semantic token (never a hard-coded hex); the panel's motion rules are all inside a `prefers-reduced-motion` guard; the keyboard map in code matches the documented table; the switcher publishes the `pendingApproval`-style contract the key handler reads.
- **Pure units** (`test/sessionsIndex.test.js`): sparkline derivation from an events array; files-edited de-dupe/ordering; state classification from a terminal event; fuzzy-rank determinism; index build == index rebuilt-by-scan (the self-heal invariant).
- **Render-mock** (the method used to land the timeline rail fix): a static HTML reproduction of the panel/card with the real classic CSS, rendered to eyeball dark/light/HC and reduced-motion — no live editor needed.
- **Manual matrix** (EXIT-TEST.md): resume-morph correctness, interrupted-state truthfulness, virtualized-scroll at 5k sessions, keyboard-only completion of every action, theme correctness ×3.

---

## 12. Open decisions (flagging, not deciding)

1. **Panel vs. VS Code sidebar view.** This doc argues for an in-webview overlay (enables the resume morph, inherits theme). The cost: it lives inside the chat panel's width. A native sidebar view would be wider but loses the morph and the shared-theme guarantee. *Recommendation: overlay; revisit if users want a persistent side-by-side list.*
2. **How much tagging.** Pins are clearly worth it; freeform tags risk becoming an unused feature. *Recommendation: ship pins in E4, tags behind the greppable search first, promote to chips only if used.*
3. **Sparkline: Unicode vs `<canvas>`.** Unicode is zero-cost and copy-pasteable; canvas is prettier and animatable (draw-in). *Recommendation: canvas in the card (E3), Unicode fallback in the compact row and exports.*
4. **Fork UX depth.** Fork-from-end is easy (E4); fork-from-an-arbitrary-turn needs a turn picker in the transcript. *Recommendation: fork-from-end first; per-turn fork rides the later checkpoint-visualization work.*

---

*This document is the experience half of LevelCode Sessions; [`levelcode-chat-sessions-design.md`](./levelcode-chat-sessions-design.md) is the persistence half. Together they specify a sessions feature that is honest, instant, native — and beats a dropdown and a list of titles.*
