# M1 Spec — The Notepad++ Power-Editing Pack

Goal of M1: make LevelCode feel like Notepad++ for the editing muscle-memory Sergii misses, by adding the power-editing features VS Code lacks. Exit condition (from PLAN.md): *open a 500 MB log, record a macro to reformat lines, replay it, switch encoding — all smooth.*

## Design principle: isolate, don't scatter

Everything that **can** live in a first-party bundled extension **does** — shipped enabled by default as the "Notepad++ Pack" (`extensions/levelcode-npp-pack/`). This keeps our code out of upstream core files so rebasing onto new Code-OSS stays cheap (PLAN.md §8). We only touch core where the extension API genuinely can't reach: large-file rendering and the encoding/EOL status-bar affordances. Those core touches are kept in clearly marked, self-contained modules.

Two buckets:

- **Bucket A — bundled extension** (`levelcode-npp-pack`): macros, line operations, column-mode extras, NPP keymap. No core edits.
- **Bucket B — core touches** (small, isolated): big-file mode, always-visible encoding/EOL status bar items. Each guarded behind an `_atomPlusPlus` product.json flag so it's easy to diff and toggle.

---

## Feature 1 — Macro record & replay (Bucket A) ★ headline

VS Code deliberately removed keystroke macros (multi-cursor + snippets were deemed enough). NPP users disagree — recording a sequence and replaying it across many lines/files is core muscle memory. We build it first-party so it's reliable, not a flaky marketplace extension.

**UX.** Commands + default keys (NPP-aligned): Start/Stop Recording (`Cmd+Shift+R`), Play (`Cmd+Shift+P` is taken by the palette → use `Cmd+Alt+P`), Play-N-times (prompt for count), Save Current Macro (names it, persists), Run Saved Macro. Status-bar indicator while recording (red dot). Saved macros appear in the Command Palette and are remappable.

**What gets recorded.** Editor command invocations and text edits via the command/keybinding layer — we capture the stream of executed editor commands (type, cursor moves, deletions, find-next, etc.), not raw OS keystrokes. Replay re-dispatches them through the command service. This is the tractable, robust approach and matches how NPP macros behave in practice (a list of actions). Edge cases to define in build: find/replace state, multi-cursor, and undo-as-one-step (a replayed macro should be a single undo unit).

**Persistence.** Saved macros stored in global state as JSON (a list of `{command, args}`); export/import to a file for sharing.

**Exit test.** Record "go to line start, insert `// `, go down" → replay 50× down a file → every line prefixed; one Undo reverts the whole replay.

## Feature 2 — Big-file mode (Bucket B) ★ headline

NPP's signature strength: open and search 300 MB–1 GB files that choke most editors. VS Code has a large-file heuristic but still degrades. We add an explicit, read-optimized path.

**UX.** On opening a file above a threshold (default 256 MB, configurable `levelcode.bigFile.thresholdMB`), LevelCode shows a non-blocking notification: "Opened in Big-File mode — tokenization, extensions, and minimap disabled for speed." A status-bar badge indicates the mode; one click toggles back to full mode (with a memory warning).

**Behavior in mode.** Disable syntax tokenization, the minimap, occurrence highlighting, language features/extensions for that editor, and word-based suggestions; keep find/replace (including regex) working on the virtualized buffer; keep go-to-line and basic editing. Read-only by default with an explicit "Enable editing" action.

**Implementation.** Extend VS Code's existing large-file-optimization switch rather than inventing a new buffer: raise/secondary-gate the limits, force the optimization flags on for over-threshold models, and add the status-bar toggle. Isolated in `src/vs/levelcode/bigfile/` and flag-gated. (Investigate streaming/virtualized load for >1 GB as a stretch; first cut targets a smooth 500 MB.)

**Exit test.** Open a 500 MB log: opens in <~3 s, scrolls smoothly, regex find-in-file returns results, no beachball; toggling full mode warns about memory.

## Feature 3 — Encoding & line-ending controls (Bucket B)

NPP keeps encoding and EOL one click away and converts on demand. VS Code can do most of this but buries it.

**UX.** Always-visible status-bar items: current **encoding** (UTF-8, UTF-16LE/BE, common codepages) and **EOL** (CRLF/LF/CR). Click → quick pick to *reopen with* or *save with / convert to* that encoding, and to convert line endings for the whole file. Add a BOM toggle.

**Implementation.** Mostly surfaces and lightly extends existing text-file encoding/EOL services; the new part is the persistent, prominent status-bar affordances and the "convert EOL for whole file" command. Bucket B because it leans on core services, but the change is small and additive.

**Exit test.** Open a CRLF Windows-1251 file → status bar shows both → convert to UTF-8 + LF in two clicks → save → re-open confirms.

## Feature 4 — Column / multi-cursor extras (Bucket A)

VS Code already has box-selection (`Shift+Alt+drag`) and multi-cursor. NPP's column editor adds the bits people actually reach for. We layer those on.

**Commands.** Column Insert (type text down a column selection), Column Fill (repeat a value), and **Insert Incrementing Numbers** (NPP's killer: fill a column with 1,2,3… or 0-padded, custom start/step, optionally hex). Also "Add cursors at line ends of selection" and "Split selection into lines" with NPP-flavored defaults.

**Exit test.** Box-select 10 lines → Insert Incrementing Numbers start=1 step=1 zero-pad=3 → lines get `001`…`010`.

## Feature 5 — Line operations (Bucket A)

The everyday NPP "TextFX"-style operations, bundled and discoverable.

**Commands.** Sort lines (asc/desc, case-insensitive, numeric, by column), Remove Duplicate Lines (keep first / adjacent-only), Remove Empty Lines, Trim Trailing/Leading Whitespace, Convert Case (UPPER/lower/Title/tOGGLE), Join Lines, Reverse Lines, Mark/Highlight All occurrences. Several exist piecemeal in core; we provide the full set with NPP names and sensible keymaps so they're one palette search away.

**Exit test.** Select a block → Sort numeric desc → Remove duplicates → correct result; Convert Case round-trips.

## Feature 6 — Notepad++ keymap preset (Bucket A)

Ship a selectable **"Notepad++"** keymap (alongside an "Atom" keymap from M3) so muscle memory transfers on day one. Mirror NPP's common bindings where they don't collide with essential LevelCode/VS Code ones; document every deliberate deviation. Offer it on first run and via the keymap picker.

**Exit test.** Activate the NPP keymap → `Ctrl+D` (duplicate line), `Ctrl+L` (delete line), macro record/play, `Ctrl+Shift+Up/Down` (move line) all match NPP behavior.

---

## Build order & milestone gates

1. **Scaffold `levelcode-npp-pack`** bundled extension + "Notepad++ Pack" settings namespace (`levelcode.*`). Wire it into the build's built-in extensions list.
2. **Macros** (headline) → demo + exit test.
3. **Line ops + column extras** (fast wins, pure extension) → exit tests.
4. **Encoding/EOL status bar** (Bucket B, small core touch) → exit test.
5. **Big-file mode** (headline, the riskiest core touch) → 500 MB exit test.
6. **NPP keymap** preset + first-run offer.
7. **M1 verification pass** (subagent): run all exit tests on the packaged `LevelCode.app`, confirm no regressions to normal editing, and confirm Bucket B core touches are isolated to `src/vs/levelcode/**` for clean rebasing.

## References we'll mine

- Synced **Notepad++** source (`lovable/notepad-plus-plus`) — exact macro semantics, column editor behavior, EOL/encoding menus, default keymap.
- VS Code's existing large-file optimization, encoding/EOL services, and built-in extension structure (read-only reference; we extend, not fork-in-place).

## Open questions for Sergii (decide at M1 kickoff)

- Big-file threshold default (256 MB?) and the hard ceiling we promise to handle smoothly (500 MB vs 1 GB).
- Macro key for Play — `Cmd+Alt+P` (palette owns `Cmd+Shift+P`), or prefer the NPP-style binding even if it remaps a default?
- Ship the NPP keymap **on** by default, or offer it on first run and leave VS Code defaults otherwise?
