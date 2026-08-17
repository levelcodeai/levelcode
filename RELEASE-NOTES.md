# LevelCode v1.1.0

The chat moves to the middle of the editor and starts reading like a document. This release takes the panel out of the narrow column on the right, gives the transcript a real measure and type scale, and lets the agent answer you even when no folder is open.

## Highlights

### The chat is an editor tab now

It opens centred, as a tab, like a file — and that is the only place it lives. Drag it to a split, move it between groups, pull it into a second window: it behaves like every other editor because it now *is* one.

The old right-hand chat view is gone rather than deprioritised. One conversation with two possible hosts needed a hand-over card, a detached state, a move command and a replay on every transition — machinery for a choice nobody wanted. **Sessions** keeps the right-hand panel to itself, which is the right place for an index of past conversations: it no longer splits a narrow column with the conversation it indexes.

**Closing the tab closes the chat**, and closing is an ending rather than a discard — the session is sealed into History and memory learns from it, exactly as **New Chat** has always done. `⇧⌘I` opens it again.

If you don’t want it opening on its own, set `levelcode.ai.chat.startLocation: "none"`.

### The transcript reads like a document

Nothing constrained line length before this. In a 380px sidebar the container did that job, so it never looked wrong — but a chat in an editor tab at 900px produced **154-character lines**, and no amount of good prose survives that.

- **A bounded measure.** The column caps at **820px** and centres, matched against the Claude Code console rather than derived from print typography — the 45–75 character rule assumes prose without identifiers, file paths or fenced code.
- **Prose gets its own type.** Message bodies now read one step above the workbench UI size, with looser leading. Expressed as an offset rather than a fixed number, so it tracks the editor font instead of inverting against it if you have raised that for accessibility.
- **Hierarchy you can see.** The heading scale moves from `1.3 / 1.18 / 1.07` — three levels inside a quarter of an em — to `1.45 / 1.25 / 1.1`, with more space above a heading than below it.
- **Rhythm that scales.** Prose spacing is in `em`, anchored to the prose size, so raising the type opens the page instead of tightening it.
- **Code blocks get room.** `pre` padding widens and its margins join the same rhythm.

The whole panel shares one column: the composer, the status row and the notice bars line up with the prose above them instead of spanning the full width beneath it.

### Speakers are told apart by treatment, not by a label

`YOU` and `LEVELCODE AI` sat above every message restating what the shape of the message already said. Your turn is now a tinted bubble **on the right** that hugs its content — "Yes" is a short bubble, a pasted stack trace is a wide one — and the assistant's is unadorned prose on the left.

The labels are gone from the screen but kept in the accessibility tree: the bubble is a purely visual cue, so removing the element outright would leave a screen reader with an unattributed wall of text.

### The agent answers without a folder open

Opening LevelCode without a workspace used to refuse every request outright — *"Open a folder first."* That guard was written for the file tools and placed where it failed the whole run, so a question that never needed a workspace died on it: what an error means, anything through an MCP server, a follow-up about the conversation itself.

The root now gates the tools that resolve a path against it, and nothing else. Rootless, `list_files`, `read_file`, `search`, `edit_file`, `write_file`, `delete_file` and `run_command` are withheld — a tool that is present but always fails is worse than one that is absent, because the model retries it — while `update_plan`, `ask_user`, `use_skill` **and every MCP tool** keep working. The model is told plainly why the file tools are missing, so it says so in a line instead of improvising about files it cannot see.

## New settings

| Setting | Default | Description |
| --- | --- | --- |
| `levelcode.ai.chat.startLocation` | `editor` | Where the chat opens with a window. `none` stops it opening on its own |
| `levelcode.ai.chat.fontSize` | `0` | Prose size in px. `0` tracks the editor UI font, one step up for reading |
| `levelcode.ai.chat.proseWidth` | `0` | Transcript width in px. `0` uses the 820px measure — it does **not** mean unconstrained |

Both sizes are clamped at the boundary (8–24 and 320–2000). The `minimum`/`maximum` in a contribution schema only drive the settings *editor*; a hand-edited `settings.json` reaches the extension unchecked, and these land directly in CSS, where `proseWidth: 1` is a one-pixel transcript with nothing left on screen to open settings with.

## Also fixed

- **Closing the chat no longer leaves the conversation loaded.** Sealing the session ended it — so the next chat opened visually empty — while the in-memory history was still there and shipped to the model on the next message. The teardown now also stops in-flight work and reaps background commands and MCP servers, which are detached children and were outliving the surface that reported on them.
- **A teardown cannot be raced by the run it is tearing down.** Closing mid-stream aborts the request, and the abort landed in a handler that pushed the partial reply back into the history that had just been cleared — the exact leak the teardown exists to prevent, caused by the teardown's own abort.
- **Reveals of the chat can no longer become unhandled promise rejections** in the extension host. Failures are logged with the caller named rather than surfacing as an error attributed to nothing.

## Not in this release

**The Sessions panel still does not search.** No filter, no fuzzy switcher, no keyboard jump — you scroll the list. It was the stated gap in v1.0.5 and it is still the gap; the chat surface took this cycle.

**The empty-state wordmark had a false start.** A redrawn mark shipped and had to be pulled: it was built from full block characters on the assumption they tile seamlessly in any monospace font, which is not true — whether `█` fills its cell is a property of the font, and in Monaco it does not, so the logo shattered into disconnected bars. The replacement is drawn from box-drawing rules and real text, and was checked in seven font families before shipping this time.

## Test coverage

- **34 suites**, **575 cases** across the bundled extensions — all green.
- `test/chatSurface.test.js` (23 cases) — the single-surface contract: one live webview, one message handler, the transcript surviving a hand-over, and a close that seals rather than discards.
- `test/webviewCss.test.js` (33 cases) — the layout invariants no DOM test can see: the measure, the shell column, the type scale, and the wordmark's width against its container.
- `test/agentNoWorkspace.test.js` (6 cases) — which tools are withheld without a root, which must keep working, and that the context meter is billed for the list that was actually sent.

**Full changelog:** https://github.com/levelcodeai/levelcode/compare/v1.0.5...v1.1.0
