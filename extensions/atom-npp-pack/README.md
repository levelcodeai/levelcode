# Atom++ — Notepad++ Pack

Built-in extension bringing Notepad++-style power editing to Atom++.

**M1 feature 1 — Macros (this version):**

| Action | Default key | Command |
| --- | --- | --- |
| Start/stop recording | `Cmd+Shift+R` | `Atom++: Macro: Start/Stop Recording` |
| Play last macro | `Cmd+Alt+P` | `Atom++: Macro: Play Last` |
| Play last N times | — | `Atom++: Macro: Play Last N Times…` |
| Save last macro | — | `Atom++: Macro: Save Last Macro…` |
| Run saved macro | — | `Atom++: Macro: Run Saved Macro…` |
| Delete saved macro | — | `Atom++: Macro: Delete Saved Macro…` |

While recording, typed text plus cursor moves (arrows, home/end, word-left/right), deletions (backspace/delete/word-delete), Enter and Tab are captured. Replay runs the steps at the current cursor; a motions-and-inserts macro replays as a single undo.

Recording only overrides the editor's `type` command for the duration of a recording session, so normal typing is never affected when you're not recording.

**File operations:**

- **Duplicate** — right-click a file or folder in the Explorer → *Duplicate* (or press `Cmd+D` in the file tree). Creates `name copy.ext` (then `name copy 2.ext`, …) next to the original. Works on folders (recursive) and multi-selection, and selects the new item so you can rename it immediately.

**Sublime-style persistence:** Atom++ ships with the strongest "hot exit" mode (`files.hotExit` = `onExitAndWindowClose`) as the **built-in default**, so unsaved edits and untitled tabs survive quitting the app and even an OS restart/shutdown — your work is continuously backed up to disk as you type. (`window.restoreWindows` is already `all` upstream.)

Because `files.hotExit` is an application-scoped setting, extensions are not permitted to change its default — so this is set as a one-line core default override (see `docs/CORE-PATCHES.md`). You can still pick any other mode in Settings → "Hot Exit".

**Line operations:** right-click in the editor → **Line Operations**, or run any from the Command Palette (`Atom++: Lines: …` / `Atom++: Convert to …`). They act on the selected lines, or the whole file if nothing is selected.

- Sort: ascending, descending, case-insensitive, numeric
- Remove: duplicate lines, consecutive duplicates, empty lines, trailing whitespace
- Reorder: reverse lines, join lines
- Case: UPPERCASE, lowercase, Title Case, tOGGLE cASE (per selection / multi-cursor; word or line under the cursor when nothing is selected)

**Column editor:** make a box selection (`Shift+Alt+drag`) or drop multiple cursors, then right-click → **Column Editor**, or run `Atom++: Column: …` from the palette.

- **Insert Incrementing Numbers** — fills each cursor top→bottom. The start value is also the format: `1` → 1,2,3; `001` → 001,002,003 (leading zeros set padding); `0x0a` → hex; add a second token for the step, e.g. `10 -2` → 10,8,6.
- **Fill With Text** — inserts the same text at every cursor/selection.

**Encoding / line endings:** a one-click toggle sits in the status bar (right side), labelled by platform — `⇄ LF · macOS/Unix` or `⇄ CRLF · Windows` — click it to convert the whole file's line endings instantly. Also from the editor right-click → **Encoding / Line Endings**, or the palette:

- Convert Line Endings to macOS/Unix (LF) / Windows (CRLF) / Toggle
- Change File Encoding… (reopen or save with a different encoding)

**Big-file mode:** large files open smoothly — the editor streams them into a memory-efficient buffer and reduces heavy features (syntax highlighting, etc.) automatically. Atom++ raises the open-without-confirmation limit (`workbench.editorLargeFileConfirmation` = 2048 MB) and shows a **⚡ Big-file mode** badge in the status bar with a one-time notice when a file is at least `atompp.bigFile.thresholdMB` (default 256). Editing, scrolling, and find still work; turn the notice off with `atompp.bigFile.notify`.

**AI features (temporarily off):** the upstream GitHub Copilot chat/agent UI is hidden by default (`chat.disableAIFeatures` = `true`) and the proprietary Copilot extension is not bundled. Atom++'s own AI layer (M2) will replace it; this default flips back on once our provider is wired in.

Coming next in M1: line operations, column-mode extras, encoding/EOL controls, big-file mode, and the Notepad++ keymap.
