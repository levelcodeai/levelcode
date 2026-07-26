# LevelCode v1.0.2

A UI-polish release. The model picker is **name-forward** instead of a wall of detail, a finished plan **folds away** on its own, and the footer shed a redundant chip.

## Highlights

### A cleaner model picker

Picking a model used to mean reading three technical fields per row — the raw id (`anthropic/claude-opus-5`), the context size, and a `6.67× credits · 1000K ctx · ≈103 turns left` second line. Handy for debugging, noise for choosing. Each model is now a single, **name-forward** line: just the name, an active check, and a lock on "coming soon" models — the way Cursor and Claude Code present them.

Your plan and remaining credits still sit in the picker's header, so the number that matters isn't lost; only the per-row debug detail is gone. Type to filter by model name.

### A finished plan cleans up after itself

When the agent works from a checklist, a completed plan used to sit fully expanded in the sticky bar — a large part of the panel — long after the run had ended. Now, matching how Claude Code and Cursor handle a finished plan:

- **It auto-collapses** to its green header the moment every item is done: still there, still one click to expand, just no longer hogging the view.
- **A dismiss (×)** closes it outright — and also clears a plan left **stranded by a run that was stopped or errored**. It's keyboard-operable (Tab to it, Enter / Space to close), like the other controls in the plan bar.

### A slimmer footer

Dropped the redundant home-icon **"LevelCode Cloud"** chip from the status bar. The mode-and-plan chip on the right (`Gateway · Pro+`, `BYO key`, `Direct · no key`) already tells you where your requests go.

## Test coverage

- **24 suites** across the bundled extensions, all green on every release.
- These are webview / picker UI changes, so they're verified by parsing the shipped `chat.html` — every script block, plus the `webviewCss` and `creditFormat` suites that read it — rather than by snapshot.

**Full changelog:** https://github.com/levelcodeai/levelcode/compare/v1.0.1...v1.0.2
