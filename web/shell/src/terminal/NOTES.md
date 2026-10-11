# LevelCode Shell: the terminal (`web/shell/src/terminal`)

What the visitor's terminal promises, what it does not, and how to check it in a real browser. The contract with the
rest of the shell is `web/shell/README.md` (section 3b: what the terminal consumes from the runtime; section 6: the
terminal; section 7: the limits; section 8: what is never allowed). Where this file and the README disagree, the README
is right and this file is the bug.

## The modules

| File | What it is | Needs `vscode` |
| --- | --- | --- |
| `input-parser.js` | `handleInput` bytes to events; swallows every report, mouse and focus sequence | no |
| `line-editor.js` | the editor: layout, drawing, keys, history, multi-line, paste, Tab, resize | no |
| `width.js`, `width-table.json`, `gen-width.mjs` | cell widths exactly as xterm computes them (Unicode 11); the generator | no |
| `completeness.js` | is this line a whole command? (the only implementation: the browser just-bash has no parse) | no |
| `completion.js` | the word under the cursor, what to ask the session, how a candidate is written back | no |
| `output-filter.js` | the allow-list filter for command output (streaming, any chunking) | no |
| `output-sink.js` | the ordered write queue (16 KiB per macrotask) and one run's output (filter per stream, one cap) | no |
| `shell-integration.js` | OSC 633 bytes and the nonce | no |
| `history.js` | in-memory ring, persistence through `{ get, update }`, secrets stay in memory | no |
| `prompt.js` | the prompt line and the cwd label | no |
| `pty.js` | `ShellPty`, a `Pseudoterminal` over one `Session` (the `vscode` object is only used for `EventEmitter`, injected) | injected |
| `agent-tab.js` | the read-only "LevelCode Agent" tab, fed by `runtime.onAgentRun` | injected |
| `index.js` | `createTerminalSupport({ vscode, runtime, context, config })`: profile, commands, wiring | yes |

Everything except `index.js` runs under plain node, which is how it is tested.

## What it promises

### Keys

Bytes were measured on macOS in the release build (headless Chrome). Windows and Linux were not measured.

| Key | Does |
| --- | --- |
| Enter (also Shift+Enter, Ctrl+Enter, Ctrl+J) | accept the line; an unfinished one continues on the next row |
| Backspace / Delete | one character (a letter with its accents, a joined emoji, is one) |
| Ctrl+Backspace, Ctrl+H, Alt+Backspace | delete the word before the cursor (up to the previous non-word character) |
| Ctrl+W, Option+Backspace (macOS sends the same byte) | delete back to the previous blank |
| Ctrl+Delete, Alt+Delete, Alt+D | delete the word ahead |
| Left / Right, Ctrl+B / Ctrl+F | one character |
| Ctrl+Left/Right, Alt+Left/Right, Alt+B / Alt+F, Option+Left/Right | one word |
| Home / End, Ctrl+A / Ctrl+E, Cmd+Left/Right | start / end of the current line of the buffer |
| Up / Down, Ctrl+P / Ctrl+N | the line above / below in a multi-line buffer, and only from its first / last line the history |
| Ctrl+K | kill to the end of the line (at the end it joins the next one) |
| Ctrl+U, Cmd+Backspace | kill to the start of the line |
| Ctrl+Y | yank what Ctrl+U / Ctrl+K / the word kills removed (one entry) |
| Ctrl+T | transpose the two characters around the cursor |
| Ctrl+L | clear the screen and redraw the prompt and the line (not the scrollback) |
| Ctrl+C at the prompt | abandon the line: `^C` and a new prompt (no end-of-command mark) |
| Ctrl+C while a command runs | `session.stop()`: the engine worker is terminated. It is **not** an abort signal: the engine never yields to one |
| Ctrl+D | empty line: leave the terminal with the last status; otherwise delete the character under the cursor |
| Tab | complete (below) |
| Escape, Shift+Tab, PageUp/Down, Insert, F-keys, Ctrl+R/Z/G/V ... | ignored |

Browsers on Windows and Linux keep Ctrl+W, Ctrl+T and Ctrl+N for themselves, so those never arrive: each has an
alternative above except Ctrl+T.

### Lines

* A line is one script. A newline in the buffer (a paste, or an unfinished command) runs as one script on Enter.
* Held back for another line: an unterminated `'` `"` or backtick, `$(` `${` `$((`, a here-document before its
  delimiter, a trailing `\` `|` `&&` `||` `|&`, and any open `if`/`for`/`while`/`case`/`{`/`(`/`[[`/`function`.
  Everything doubtful is run, not held: a stray `fi`, `)` or `}` is the engine's syntax error, not a stuck prompt.
* `exit [n]` is a rule about the line: only a line that is just that closes the terminal (status `n & 255`, default the
  last one). `exit` inside a group, after another command or in a function is the engine's and ends that line only.
* `clear`, `help`, `history [n|-c]` are answered by the terminal when they are the whole line.
* A paste is bracketed (`?2004` is on for the life of the tab and the output filter never lets a program change it):
  inserted, never run. Over 100,000 characters it is **rejected** with a notice; nothing is inserted or cut.
  A chunk of plain characters with a line end in it that arrives outside a bracketed paste is treated as a paste too.
* While a command runs only Ctrl+C is heard. Other keys are dropped, not kept for the next prompt.

### Prompt

`folder-name/relative/path [status] $ `: the workspace folder containing the cwd, by name, else the absolute path;
`.../a/b` when it would take more than 40% of the width; a short `$ ` when even that does not fit. Not `~`: the shell's
HOME is `/home/user`, so `~` for "the workspace" would be false. Colours are SGR only (bold blue, red for a non-zero
status), so both themes apply.

### Completion

Tab asks `session.complete('command' | 'path', prefix)`. One candidate is inserted (a folder gets no trailing space),
several insert their common prefix, and a second Tab with nothing to add lists them in columns below and redraws the
prompt. Names are written back escaped or quoted for the quote the word is in. A name that cannot be typed (a control
character, a bidi override) is not offered. An answer that arrives after the line changed is ignored.

### Output

All of it goes through one ordered queue, 16 KiB per macrotask, and only these kinds of text are written:

1. constants of this extension (banner, `^C`, marks, colours);
2. strings from elsewhere (cwd, file names, notes, history, help): `sanitize.forTerminal` first;
3. command output: `output-filter.js`, a filter per stream and one cap per run.

The filter is an allow list: text, `\t \b \r`, LF as CRLF, SGR, the cursor/erase finals `A B C D E F G H f J(0-2) K L M P
@ X S T s u`, `?25`, and OSC 8 links to http, https and mailto. Everything else is dropped: every other CSI (private
prefixes, intermediates, queries), DCS/APC/PM/SOS, every other OSC, two-character escapes, C0 other than those four,
DEL, C1 (the 8-bit introducers are read as their 7-bit forms and dropped with their bodies) and the bidi overrides.
Auto-wrap (`?7`) is dropped on purpose: the editor's row arithmetic assumes the terminal wraps.

Real behaviour, not the earlier claim: **an unterminated OSC or DCS swallows every later byte of that stream until a BEL,
ST, ESC, CAN or SUB, or until the command ends.** The 4096 limit bounds memory, not what is eaten. Each stream (stdout,
stderr) has its own filter, so one cannot hide the other, and `end()` abandons whatever was open. After every command
`end()` puts back what the output changed (colours, a link, a hidden cursor) and writes nothing when it changed nothing.

The cap is 1 MiB of characters **after** filtering (LF counts as two), shared by both streams, with a visible
`[output limit reached: N more characters were not shown]`. Output is cut between tokens, never inside a sequence.

### Shell integration

`OSC 633` A/B around the prompt (once per prompt, again after Ctrl+L; not on every key), E and C around a run, D and
`P;Cwd=` after it, `P;HasRichCommandDetection` and `P;ContinuationPrompt` at open. The nonce is 128 random bits from
`crypto.getRandomValues` per terminal (no fallback), goes to `createTerminal` as `shellIntegrationNonce`, and is written
in exactly two sequences, E and `P;Cwd`. The cwd and the command come from the session and the editor, never from output.
The agent's tab has **no** shell integration: a command the model wrote must not become a "recent command".

### The agent's tab

One reusable read-only tab, appended to with a header (explanation dim, `$ command` bold, `in <folder>`), the output, and
a result line (`✓ exit 0 · 1.4s`, `✗ exit N`, `■ stopped`, `■ timed out`, `■ stopped: a limit of the shell was reached`).
The command text, explanation, cwd and notes go through `forTerminal`, the output through the filter, both capped.

Reveal (`levelcode.shell.revealAgentRuns`): `firstRun` (default) opens the tab for the first run of the session,
`always` for every run, `never` not at all, and none of them within **30 s of the last key typed in one of our shells**
(`terminal.show(true)` from a focused terminal leaves the keyboard focus on the page body: measured). A reveal is
`show(true)`, never `show(false)`. A tab that is not the active one is named `LevelCode Agent •`. Closing the tab only
hides it; the next run makes a new one. Ctrl+C there does nothing but say where the Stop button is.

### Wiring (`index.js`)

The profile provider is `levelcode.shell` (the FIRST contributed profile: Split Terminal uses it). `levelcode.shell.new`
creates and shows a terminal, and shows it **again after 250 ms** (the immediate form alone lost the focus in about one
run in five). The same hook runs for terminals made from the `+` menu (`onDidOpenTerminal`, matched by the pty the
provider made). `levelcode.shell.toggle` shows and focuses the active LevelCode terminal, else the first, else makes one:
the built-in toggle does re-show the panel, but it leaves the focus in the chat. A new shell starts in the cwd of the
active one, else the last cwd (workspaceState). There are no `commandsToSkipShell` entries: measured to have no effect.
Settings are read from `levelcode.shell.*` when they matter: `revealAgentRuns`, `historySize` (0..5000).

## What it does not do

* No Ctrl+R, no Ctrl+Z, no job control, no background jobs, no stdin for a running command (`cat` with no
  arguments and `read` return at once). No type-ahead.
* `history | grep x` does not see the terminal's history (the engine has its own, empty one); only the bare `history` does.
* No restoring of tabs or scrollback after a reload (`isTransient` is fixed by the workbench).
* IME composition, touch keyboards, Safari and Firefox were not run. Windows and Linux key bytes were not measured.
* A prompt wider than the terminal is replaced by `$ `; the editor itself does not support a prompt that wraps while the
  buffer is taller than the panel (the window then starts mid-prompt).
* Zero-width and invisible characters in **output** other than the bidi overrides are not removed by the filter (only
  strings that go through `forTerminal` get the longer list). They cannot act on the terminal.
* Resizing while a buffer taller than the panel is being edited is approximate: xterm re-wraps rows it wrapped itself and
  leaves the line the cursor is on alone (`reflowCursorLine` is off in VS Code except for Windows conpty), and for a
  windowed draw the editor can only guess which rows moved. The next keystroke redraws it.
* A very fast second Tab (before the first answer arrives) is read as a first Tab.

## Facts about the workbench this depends on

Measured in the release build by the research, and re-checked here against the real `xterm.js` 6.1.0-beta.285
(`@xterm/headless`) where a unit test can:

* the workbench's xterm types replies into `handleInput` for DSR/CPR/DA/XTVERSION/DECRQM/DECRQSS/colours/window ops, and
  obeys DECCKM, mouse, focus and bracketed-paste modes: the filter's table and `shell-terminal-pty.test.js` pin it;
* a character written in the last column does not wrap until the next one; a wide character that does not fit wraps and
  leaves the last cell empty; a raw TAB moves the cursor (and moves it back from a pending wrap), so tabs are drawn as
  spaces;
* the line the cursor is on is not re-wrapped on resize (`terminalInstance.ts`: `reflowCursorLine` is set only for
  conpty), every other row is;
* `Pseudoterminal` events fired before `open()` are lost (the agent tab holds them and re-says its name);
  `open(undefined)` is possible, `setDimensions` follows.

## Tests

`web/test/unit/shell-terminal-*.test.js`, plain node, deterministic (seeded), no network, nothing over a second:

| Suite | Pins |
| --- | --- |
| `input-parser` | the byte table, every report swallowed at every cut, the keys a sloppy "drop replies" pattern would eat, paste and its cap |
| `width` | the 25 measured widths; the table equals the addon (when an xterm checkout is found) |
| `line-editor` | the keys, the cursor on a newline, the full row, wide/combining/joined characters, tabs, resize, a tall buffer, Tab; a seeded differential against an oracle at three widths and with resizes; and, if xterm is found, against the real xterm.js |
| `completeness` | the table of traps and open constructs |
| `completion` | the word under the cursor and the write-back |
| `output-filter` | the 25 queries, the modes, the OSC list, links, the cap, a seeded chunking fuzz |
| `history` | the rules and the secret patterns (assembled from fragments) |
| `sink` | the OSC 633 escaping, the nonce, the queue and a run's output |
| `pty` | bytes in, bytes out: prompt, run, history, paste, Ctrl+C, exit, 126/124, hostile output |
| `agent-tab` | order, the result lines, sanitising, the reveal table |
| `index` | what is registered, focus rules, the shared history, the agent tab coming up |

`LEVELCODE_XTERM_DIR=<path to node_modules/@xterm>` points the xterm-backed checks at an xterm; without it the
tests look in `<repo>/vscode/node_modules/@xterm` and in the main checkout above a worktree, and say "skipped" when
there is none. `node web/shell/src/terminal/gen-width.mjs <addon-unicode11.js> [--write]` regenerates the width table.
Linux Node 18 (no network): `docker run --rm --network none -v "$PWD":/repo:ro -w /repo catthehacker/ubuntu:act-latest
bash -lc 'node web/test/unit/shell-terminal-pty.test.js'` (add `-v <@xterm>:/xterm:ro -e LEVELCODE_XTERM_DIR=/xterm`).

## Testing it in a browser

What the unit tests cannot say is that the workbench does what the model terminal does. The harness rules below were
found the hard way (research checker); `web/test/e2e-shell.mjs` is the place for them.

1. **Focus emulation first.** A fresh headless page has no focus (`document.hasFocus()` is false), so the first
   Ctrl+` is lost however long the harness waits. Send `Emulation.setFocusEmulationEnabled { enabled: true }` before
   the first key. Then assert `document.activeElement.className === 'xterm-helper-textarea'` before typing.
2. **Key events need `windowsVirtualKeyCode`** (and `text` for printables), or xterm gets nothing: Enter 13, Backspace 8,
   Tab 9, Escape 27, Left 37, Up 38, Right 39, Down 40, Home 36, End 35, Delete 46, Backquote 192, letters their
   upper-case code, digits their code. Use `Input.insertText` for punctuation. Ctrl+key is the key with `modifiers: 2`.
3. **Read the terminal after a frame.** The DOM renderer paints on `requestAnimationFrame`: read `.xterm-rows > div`
   after two rAFs, and `Page.bringToFront` if the target is not in front (a hidden page leaves the rows empty).
   `terminal.integrated.gpuAcceleration` is `auto` in the product (WebGL has no DOM rows): set `off` **only in the
   harness's configuration defaults**.
4. **A fresh Chrome profile and a fresh random debugging port per run, and close Chrome in a `finally`.** Extension
   files under `/_/<build id>/` are served `immutable`; a leaked Chrome on a fixed port makes the next run drive the stale
   browser and its cached `extension.js`.
5. **Page unload.** A modifier key as the last input before a reload makes the workbench veto the unload
   (`window.confirmBeforeClose: keyboardOnly`) and raise a `beforeunload` dialog even with no terminal open: handle
   `Page.javascriptDialogOpening` (accept), or release the modifier first.
6. **Never click a `vscode:` OSC 8 link** in a test: the page stops receiving key events afterwards.
7. **Clipboard**: `Browser.grantPermissions { permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'] }` before a
   paste check.
8. **The chat-first layout takes the focus a few seconds after start** (it closes the panel): wait for `.part.editor`,
   then assert the focus (rule 1) instead of sleeping.

What to assert, in this order: lazy activation (`extension.js` not requested before first use); a shell from the welcome
button, the `+` profile and Ctrl+`; the same from the menu path (panel visible and the xterm focused 250 ms later);
`echo hi` and the editing keys; a paste of two lines; `$COLUMNS` after two widths; `true; false; echo x` gives three
decorations; `printf '\033[6n\033[c\033]10;?\007\033]0;pwned\007\033[?1000h'` then a click and Enter leaves the prompt
clean and the tab name unchanged; an agent run appends to the "LevelCode Agent" tab without moving the focus out of the
chat; Ctrl+C in a running `sleep 30` returns the prompt at once.

## Assumptions about the runtime, and what to ask for

* `session.complete(kind, prefix)` returns full strings that start with `prefix` and end a folder with `/`
  (the runtime's `completePath` does); strings that do not start with the prefix are dropped.
* `session.run` option `rows` (the panel's height) is passed next to `cols`; the runtime sets `COLUMNS` from `cols`
  and could set `LINES` from `rows`.
* The `start` agent event may carry `explanation` (shown dim when present).
* The prompt label uses the runtime's own `planMounts` (exported by `runtime.js`) so that a folder mounted under `/mnt`
  is still named by its folder; if that export goes away the label falls back to `folders()` and shows `/mnt/...`.
