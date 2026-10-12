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
| `links.js` | the terminal link provider: `path`, `path:line`, `path:line:col`, `(path:line)` in our terminals' output (asks the runtime where a path is and whether a file is there) | injected |
| `line-log.js` | what a terminal printed, by line, with the folder it was printed in (the links ask it) | no |
| `index.js` | `createTerminalSupport({ vscode, runtime, context, config })`: profile, commands, link provider, wiring | yes |

Everything except `index.js` runs under plain node, which is how it is tested.

## What it promises

### Keys

Bytes were measured on macOS in the release build (headless Chrome). Windows and Linux were not measured.

| Key | Does |
| --- | --- |
| Enter (also Shift+Enter, Ctrl+Enter, Ctrl+J) | accept the line; an unfinished one continues on the next row |
| Backspace / Delete | one character (a letter with its accents is one) |
| Ctrl+Backspace, Ctrl+H, Alt+Backspace | delete the word before the cursor (up to the previous non-word character) |
| Ctrl+W, Option+Backspace (macOS sends the same byte) | delete back to the previous blank |
| Ctrl+Delete, Alt+Delete, Alt+D | delete the word ahead |
| Left / Right, Ctrl+B / Ctrl+F | one character |
| Ctrl+Left/Right, Alt+Left/Right, Alt+B / Alt+F, Option+Left/Right | one word |
| Home / End, Ctrl+A / Ctrl+E, Cmd+Left/Right | start / end of the current line of the buffer |
| Up / Down, Ctrl+P / Ctrl+N | the line above / below in a multi-line buffer, and only from its first / last line the history |
| Ctrl+K | kill to the end of the line (at the end of a line that is not the last it joins the next one; the join does not enter the kill ring) |
| Ctrl+U, Cmd+Backspace | kill to the start of the line |
| Ctrl+Y | yank what Ctrl+U / Ctrl+K / the word kills removed (one entry) |
| Ctrl+T | transpose the two characters around the cursor |
| Ctrl+L | clear the screen and redraw the prompt and the line (not the scrollback) |
| Ctrl+C at the prompt | abandon the line: `^C` and a new prompt (no end-of-command mark) |
| Ctrl+C while a command runs | `session.stop()`: the engine worker is terminated. It is **not** an abort signal: the engine never yields to one. Only Ctrl+C: Alt+C is a key like any other and is not heard while a command runs. See "Ctrl+C" below |
| Ctrl+D | empty line: leave the terminal with the last status; otherwise delete the character under the cursor |
| Tab | complete (below) |
| Escape, Shift+Tab (it is not completion), PageUp/Down, Insert, F-keys, Ctrl+R/Z/G/V ... | ignored |

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
  A chunk of plain characters with a line end in it that arrives outside a bracketed paste is treated as a paste too (a
  person types one key per chunk). So `terminal.sendText(text, true)` and "Run Selected Text in Active Terminal" **insert**
  the text and never execute it: the visitor presses Enter. That is deliberate (text from another extension does not run
  by itself), and a user-visible difference from the built-in shell terminals.
* What enters the buffer is what the screen can show. Controls, DEL and C1 are dropped; so is every character of
  Unicode's `Default_Ignorable_Code_Point` (zero-width space, joiners, bidi marks and overrides, soft hyphen, variation
  selectors, tag characters, fillers, BOM, the invisible math operators), lone surrogates, U+2028/2029, the blank
  braille pattern and the interlinear anchors. Otherwise `rm a<ZWSP>b.txt` would be drawn as `rm ab.txt` and run
  against another name. **Except** what belongs to an emoji or to a word, which is the exception `sanitize.js` makes
  for `forTerminal` (the editor's rule is tested to equal it on a corpus): U+FE0F/U+FE0E right after a pictograph (or a
  keycap base before U+20E3), U+200D between two pictographs (a variation selector may sit before it), and U+200C or
  U+200D with a letter or mark on each side, both of one script of Arabic, Devanagari, Bengali, Gurmukhi, Gujarati,
  Oriya, Tamil, Telugu, Kannada, Malayalam, Sinhala. So `✔️ done.md`, a family emoji and a Persian word with its ZWNJ
  can be pasted, completed and recalled, and a file named so is addressed by what is on the screen. The neighbours
  are the ones the text had, so a hidden character next to a joiner makes it hidden too; the other variation
  selectors (U+FE00-FE0D, the Mongolian and the supplement U+E0100) are not kept, as `forTerminal` shows them in
  brackets. What is dropped from a paste, from a chunk of text that arrives whole (more than one character in one
  event) or from a completion is said once, dim, under the line: `[2 invisible characters were not typed]` (a recalled
  history entry is cleaned silently). **One key pressed alone** that types nothing the screen can show does nothing and says
  nothing, as a key that is not mapped does: a ZWNJ pressed on a Persian keyboard or a ZWJ on an Indic one, between
  letters, is not typed (it has no letter after it yet, and a joiner that stayed alone before a blank would be
  invisible: the hole this rule closes), so a word typed key by key has no joiner in it. Paste it, or complete it, to
  have one. A joiner typed between two letters that are already there is kept. Chosen over keeping a joiner that
  follows a letter (it would leave an invisible character in a command, which Backspace removes only together with its
  letter) and over holding the key back until the next one (a pending state, for what a paste and Tab already do).
  Fix round 2 had made every such key print the note and leave a second copy of the line: five rows for one word. A
  kept joiner can be left without its neighbour by a Backspace; it stays, as a letter's accent does.
* While a command runs only Ctrl+C is heard. Other keys are dropped, not kept for the next prompt.

### Prompt

`folder-name/relative/path [status] $ `: the workspace folder containing the cwd, by name, else the absolute path;
`.../a/b` when it would take more than 40% of the width; a short `$ ` when even that does not fit. Not `~`: the shell's
HOME is `/home/user`, so `~` for "the workspace" would be false. Two workspace folders of the same name are told apart
by the fewest folders they are in that make the labels differ (`a/proj` and `b/proj`; `x/a/proj` and `y/a/proj`), by
their place in the workspace, not by where the engine mounted them. A label is made in linear time, whatever the
names: the working folder comes from the engine, and a command can make a directory with a name of any length. Colours are SGR only (bold blue, red for a non-zero status), so both themes apply.

### Completion

Tab asks `session.complete('command' | 'path', prefix)`. One candidate is inserted (a folder gets no trailing space),
several insert their common prefix, and a second Tab with nothing to add lists them in columns below and redraws the
prompt. Names are written back escaped or quoted for the quote the word is in. A name that cannot be typed (a control
character, a bidi override, any invisible character) is not offered or is typed without it. An answer that arrives after
the line changed is ignored.

A Tab pressed before the answer to the previous one has arrived is **queued** (one at most; a third is dropped): it asks
when that answer has been applied, about the line as it is then, so `Tab Tab` lists even when the first answer is slow.
Any other key drops the queued Tab and makes the answer in flight stale (it is not applied); a Tab after that asks at
once. (The alternative, ignoring the second Tab, would lose the list on a slow session.)

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

### Ctrl+C

What had not been written yet is dropped, so the filters' idea of what they have put on the terminal can be wrong (the
sequence that closed a link, showed the cursor again or reset a colour was in the queue). So Ctrl+C writes, whatever the
filters believe: `ESC[0m`, `ESC]8;;ST`, `ESC[?25h`, then `^C`, and the run shows nothing more. `^C` is where the output
stopped, and a line break follows it before anything else (the runtime's note is never glued to it).

The runtime does not interrupt a run that is already applying its changes (half of a `mv` is worse than all of it), so a
stopped run can take a while to settle. After **5 s** the terminal says `still applying the changes of this command.
Ctrl+C again gives the prompt back; the changes keep being applied`, and a **second Ctrl+C** (before the notice it is the
same keypress as the first and does nothing) ends the run in the terminal with status 130 and brings the prompt back.
The run's own result, when it settles, is **not** heard (its notes, and a failure to apply, are dropped), and until it
has settled the session refuses a new line: `the shell is busy: the previous command is still applying its changes.`

### Shell integration

`OSC 633` A/B around the prompt (once per prompt, again after Ctrl+L; not on every key), E and C around a run, D and
`P;Cwd=` after it, `P;HasRichCommandDetection` and `P;ContinuationPrompt` at open. The nonce is 128 random bits from
`crypto.getRandomValues` per terminal (no fallback), goes to `createTerminal` as `shellIntegrationNonce`, and is written
in exactly two sequences, E and `P;Cwd`. The cwd and the command come from the session and the editor, never from output.
The agent's tab has **no** shell integration: a command the model wrote must not become a "recent command".

### The agent's tab

One reusable read-only tab, appended to with a header (explanation dim, `$ command` bold, `in <folder>`), the output, and
a result line (`✓ exit 0 · 1.4s`, `✗ exit N`, `■ stopped`, `■ timed out`, `■ stopped: a limit of the shell was reached`).
The command text, explanation, cwd and notes go through `forTerminal`, the output through the filter. Caps: 1 MiB for
the output; the first line of a command 300 characters; the explanation and each note 300 characters (cut on what is
shown, with `…`), at most 8 notes. The explanation is written first and **counts in the run's 1 MiB**; the notes come
after the output, so counting them would change nothing, and they are bounded by 8 x 300 instead. Only the first 4,800
characters of an explanation or a note are looked at (blank lines past that are not read through), and the join of its
lines is linear.

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

### File links (`links.js`, `line-log.js`)

`registerTerminalLinkProvider`. In the output of our terminals (the visitor's shells and the agent's tab) `path`,
`path:line`, `path:line:col` and `(path:line)` become links that open the file at that line and column. The workbench's
own file links are off (`enableFileLinks: off`), so this is the only way.

* A candidate is a run of path characters (not blanks, quotes, brackets, `: ; , | * ? \ =`), optionally followed by
  `:line` or `:line:col`, that does not start after a path character, `:`, `\` or `~`; trailing dots are not part of it.
  It looks like a path: it has a `/`, an extension, or a `:line`; it has a letter (`12:30` is not one); it does not start
  with `~` (HOME is not the workspace). URLs, `a:b`, drive letters, version numbers and times are therefore not read.
  Bare words (`Makefile`, `LICENSE`) are links only with a `:line`.
* It is a link only if the file **exists**, as a file, relative to the folder **the line was printed in**, under a mount.
  The check is bounded: at most 5 DISTINCT paths per line are asked about (the budget is for paths, not for the
  folders each is looked for in), each in the folder the line was printed in first and in the one the command began in
  only when it is not there (so at most 10 stats for a line of a shell that `cd`ed, 5 anywhere else, once each: a
  spelling of the same file, and a place that was asked about already, are not asked again), the answers are waited for
  500 ms in all, however many rounds (a line that is not answered in time has links only for what was), and only the
  first 4,000 characters of a line are read (a word the cut goes through is not read at all: half of `src/a.js` is
  another file's name). A path in no mount costs nothing. A folder is not a link, and nor is what the runtime does not
  know to be a file: `runtime.stat` says `'file'` only for the File bit, `'dir'` for the Directory bit and `'other'` for
  what has neither (a provider that does not say, `FileType.Unknown`; a link to nothing, `SymbolicLink` alone), and
  this module takes the string `'file'` and nothing else (a link to a file, `File | SymbolicLink`, is a `'file'`).
  Where a path is and whether a file is there are the runtime's to say (`runtime.resolve`, `runtime.stat`: the mounts and
  the bound on a file system that does not answer are its own); this module races its own 500 ms clock against them.
* **Which folder.** The workbench hands the provider the text of a line and the terminal, no row and no time, so the
  terminals remember what they print (`line-log.js`): every line that has a path-like word in it, as the cells of its row
  (tabs as the blanks they move over, marks joined, overwrites and erases applied: compared with xterm.js's own row for
  36,000 random lines, no difference), with the folder of the run it was in. A line is looked up by its text.
  - The visitor's shell: a run's output, its notes, and the line that was typed (with the prompt, and `> ` on the
    continuation lines) are about the folder the command **ended** in, then the folder it **began** in (both are tried,
    in that order; they are one when it did not `cd`). So after `cd src`, an older `lib/b.js:7` is still about the folder
    it was printed in.
  - The agent's tab: every run is about the folder it was started in (a workspace path, mapped through the mounts); the
    header lines (the command, `in <folder>`), the output and the notes of a run belong to it. Two runs in two folders
    do not change each other's links.
  - **What cannot be known**: two lines with the same text printed in two folders (the latest is taken: nothing on the
    line tells them apart); a line the log has not seen or did not keep (the banner, `help`, `history`, a line that cursor
    movement or a tab that wraps made differ from its text, the 401st line back); a line that begins before a clear
    screen. These are resolved against the folder the terminal has when the question is asked, as links always were
    (the shell's current folder; the agent tab's last run).
  - The log is memory only, bounded (400 lines of at most 4,000 characters), and holds what the terminal shows.
* A terminal that is not ours is not looked at at all. The tooltip is a constant: the text of the line is never in it. A
  file that will not open as text falls back to `vscode.open`.

### Linear time

Everything a terminal is given is untrusted text, and the extension host is one thread that every extension shares: a
pattern that is quadratic in a run of blanks is a freeze that a model (or a file, or a command) can cause. Pinned by
`helpers/shell-terminal-timing.js`, which runs every function that sees such text over 23 shapes of 200,000 characters
(runs of blanks, tabs, line ends, `a:` pairs, parentheses, backslashes, marks, ZWJ chains, unfinished escapes) against
a budget of 500 ms (a linear pass is tens of ms). What was superlinear and is not any more: the agent tab's one-line
join of an explanation or a note (`/\s*\r?\n\s*/g`, 5 s for 100,000 blanks; and the text is cut before it is looked at:
at most 4,800 characters are scanned, so blank lines past that are not looked through), the prompt label for a long
folder name (cut one character at a time: 85 s for 200,000 characters), the folders-in-common search of the prompt
(a label per depth), the trailing-blank trim of the candidate list, and `/\.+$/` and `/\/+$/` in the links and the
prompt. Audited and linear: `cleanText`, completion, completeness, `looksSecret` (bounded to 4,096 characters), the
output filter, the input parser, `exit`/`history` rules, the link candidates.

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
* Resize follows xterm.js's own behaviour (see "Facts"), in the order it does it, the height and then the width, with
  these gaps that the editor cannot see. **The rule is that a resize does not write over a row that is not the editor's
  own** (earlier output, a command's result, the note under a line): where the emulation is unsure it starts the redraw
  LOWER, and what that costs is a stale copy of the first rows of the prompt, above the region (on the screen, or just
  above it in the scrollback, until the panel brings it back). Output is not lost to it; a copy is untidy. The rule is
  not a proof: the row xterm ends on is not monotonic in the number of rows it dropped from the bottom, so the editor
  tries EVERY count between its floor and its ceiling and takes the lowest redraw (a verifier found 8 sessions of 20,000
  of one flow that lost a line when only the two ends were tried; the three minimal sessions are
  `web/test/fixtures/shell/terminal/resize-chains.json`, in the strict suite). Measured since: 0 lost in those 20,000, in
  the 33,600 below, and in 16,000 more; one in about 112,000 chains was found before the change and is not an argument
  that the rate is zero.

  *How the rule is measured.* By a generator that is not the suite's own (the verifier's `rz2.js`), on the real xterm.js
  6.1: a panel of 20 to 180 columns and 3 to 50 rows, 0 to 90 lines of earlier output of which a quarter wrap, a prompt
  of 2 to 30 cells, and sessions of 6 to 16 events: lines typed and pasted (up to three panel widths), the cursor taken up,
  down, home and end, Tab, Ctrl+L, a note under the line, and the panel changed by width, by height, by both at once, by
  a drag in small steps, by a toggle, by a maximise and a restore. After EVERY step: what was on the terminal before the
  prompt and the note under the line are there, whole and in order; the region is on the screen where the editor says it
  is; **what the editor believes of the blank rows under its region and of the rows it pushed into the scrollback is a
  floor** (never more than there is: it is what the next resize writes over; `blankOver`, `ghostOver`, `cellsOver`,
  `linesOver` in the helper); and a pasted line is on the screen once. Sessions of 33,600 (7 flows x 12 seeds x 400) in
  which, at any step, earlier output or the note was written over / a copy of the prompt was left on the screen / a copy
  was left only above it, at the three checkpoints and now:

  | flow, 4,800 sessions each | a7f393c | 648a547 | 6afd1c5 | now |
  | --- | --- | --- | --- | --- |
  | width and height at once | 4 / 554 / 924 | 168 + 57 / 372 / 749 | 2 / 379 / 721 | **0** / 381 / 721 |
  | any of the six, at random | 8 / 673 / 900 | 136 + 26 / 258 / 456 | 1 / 179 / 348 | **0** / 174 / 348 |
  | maximise, type, restore | 35 / 225 / 220 | 40 + 38 / 236 / 231 | 0 / 269 / 145 | **0** / 188 / 119 |
  | a drag in small steps | 1 / 158 / 425 | 5 + 4 / 117 / 356 | 0 / 66 / 262 | **0** / 66 / 262 |
  | width only | 0 / 106 / 347 | 0 / 109 / 379 | 0 / 28 / 229 | **0** / 28 / 229 |
  | height only | 0 / 497 / 719 | 0 / 6 / 59 | 0 / 6 / 59 | **0** / 6 / 59 |
  | a user's own mix (height, drag, maximise, toggle, width) | 3 / 53 / 70 | 5 + 1 / 5 / 17 | 0 / 4 / 18 | **0** / 4 / 18 |
  | all 33,600 | 51 / 2,266 / 3,605 | 354 + 126 / 1,103 / 2,247 | 3 / 931 / 1,782 | **0** / 847 / 1,756 |

  ("written over" is earlier output, then the note under a line where a version had one: 648a547 lost a note in the
  second number of its column; a7f393c dropped the character without a note, so it has none to lose.) Fresh seeds, the
  same checks and six variants of the generator (more seeds of the same, lengths at the edge of the panel's width,
  panels of 3 to 40 columns, sessions of 3 to 10 events with a command and its output between, the toggle, chains of
  three resizes: 172,400 sessions): nothing written over, and the editor never believed more than there was. The suite
  carries 683 of the sessions, seeded, in about two seconds (`helpers/shell-terminal-resize-sessions.js` is the
  generator with the same checks), and the three that 6afd1c5 wrote over.

  1. **The top of the buffer.** xterm stops its cursor at the first row of the whole buffer, so when the lines below
     the cursor that a wider panel re-joins are more rows than there are above the cursor (the scrollback counts), the
     editor goes down further than it should and leaves a stale copy of the first row. It needs a fresh terminal: a
     multi-line paste of long lines, the cursor taken to the first line, then a much wider panel. **2 to 3 percent of
     realistic sessions**: 28 of 1,150 on a terminal that had not scrolled (2.4%) and 10 of the 44 that had, 38 of
     1,200 over seeds 1-4 (3.2%; 12 to 24 rows, 60 to 100 columns made 120 to 200, a 3-line banner, pastes of up to 5
     lines of up to 200 characters), 0 of 1,282 when narrowing; the same sessions, the same count, at a7f393c. A cursor
     position report does not resolve it: it says where the cursor is, not where the region begins, and learning that
     takes a report at every prompt and tracking every scroll and every earlier line that re-wraps. It was tried on
     paper and not built: it would be a timer, a reply that can be a key (Shift+F3 is `CSI 1;2R`), and a redraw that
     waits, for a case that comes up once in thirty to fifty.
  2. **How many blank rows are under the region.** A shorter panel drops the rows under the cursor first, the blank
     ones and then the region's own, and scrolls the top away only for what is left. The editor knows how many rows
     the region has under its cursor and how many the panel lost, and keeps a FLOOR of the blank rows under the region
     (`blank`): a taller panel adds blank rows when the cursor is not on the last row of the region (on it, it may be
     on the last row of the screen and the rows come from the scrollback: nothing is known), the region takes some when
     it grows and gives them back when it shrinks, and a narrower panel, a shorter one that pushes rows, Ctrl+C and a new
     prompt leave nothing known. It works out the rows that are left for both ends (the blank rows that are known, and
     all there could be) and takes the redraw that starts lower (`_cursorRowAfterReflow`); the rows between the
     region's first row and where that redraw starts are not rows it erases, and are not counted. Fix round 2 assumed the
     region was at the top of the screen, which is only so for a window: on a terminal that has scrolled it counted rows
     that xterm had dropped and started one row too high (25 of 2,400 sessions of width and height together wrote over
     the line before the prompt). **What is left**: a stale copy of the prompt's first row, visible above the region,
     when the panel was made taller with the cursor ON THE LAST ROW of the region and the screen had not scrolled
     (nothing says the rows that came are blank rows and not rows of the scrollback), and then made shorter. In the
     maximise-and-restore flow of the verifier (1,800 sessions of the `maximize` family, seeds 11-16 x 300): a copy on
     the screen in 41 of them (a7f393c 41, 648a547 37, 6afd1c5 54), of which 20 are sessions in which neither a7f393c
     nor 648a547 left one (33 at 6afd1c5; two of the 20 are sessions in which they wrote over output). Not resolved: the
     editor would have to know whether the screen had scrolled, and it cannot see it.
  3. **Rows pushed into the scrollback.** What xterm pushes there (the top of a region that no longer fits after the
     panel got shorter or narrower, and whatever the re-wrapping of earlier output pushes) cannot be erased. The editor
     counts the rows of the region it knows were pushed (`ghosts`) and, when the panel grows with the cursor on its last
     row, or a wider one takes rows out of the region, starts its redraw at the first of them that came back, so
     shrinking and growing the panel again leaves the prompt once. It keeps three numbers and each is a FLOOR, because
     the redraw writes over what comes back (one row too many is a line of earlier output): the rows (`ghosts`), the
     logical lines they are rows of (`ghostLines`: a wider panel joins the rows of a line, never two lines, so each is
     at least one row), and the cells they hold (`ghostCells`: joined, they need at least ceil(cells / width) rows),
     and a wider panel leaves `min(ghosts, max(lines, ceil(cells / width)))` of them. Why they cannot be more than
     there is:
     - the cells and the lines are counted when the rows are pushed and from the rows xterm really pushed: what the
       screen is after the re-wrapping, line by line (`_reflowRows`), where the line of the cursor is NOT re-wrapped
       (`reflowCursorLine` is off) but cut at the new width, and any other is packed at it. The rows of one line that
       were pushed at 24 columns are 24 cells each, and a wider panel does not make them 64: counted at the width the
       panel was asked about they were 105 cells in two rows that join to one at 104 columns, and the redraw started a
       row too high (the verifier's R1, R2 and R3; R2 was worse than both checkpoints before it);
     - only rows that were at or above the cursor are counted (`safe`). When the screen has not scrolled xterm makes
       room for the rows a line gains by dropping rows from the BOTTOM of its buffer (`Buffer._reflowSmaller`, the
       blank ones, and when there are not enough, the rows under the cursor), and what is left of a line under the
       cursor is the end of it, flagged as a continuation of the row above it: a pushed row of it is not the first row
       of a line, and a prompt and a row of it are ONE line that a wider panel joins to one row. Counted as two lines
       they were two rows, and the next taller panel took back a row of output from before the prompt (the sessions
       `the cursor is on the first of two lines ...` in the suite: a7f393c and 648a547 do not write over it, 6afd1c5
       does). Found by checking the floors after every step, not by the output (the verifier's generator saw it in
       none of its 33,600);
     - what is pulled back is the newest of them, so what is left is at least the lines and the cells of the rest, and
       a row holds at most as many cells as the wider of the two widths; a narrower panel only splits rows, which leaves
       the floor low, not wrong; the rows are not cut afterwards (the editor's redraw begins every window with a row
       that is a line of its own for xterm, so they are not the line of the cursor any more);
     - a new prompt, Ctrl+L and Ctrl+C forget all three.
     Not exact, on purpose: a stale copy is left when earlier output wrapped and pushed more rows than the editor
     counted, and when rows came back that the floor did not know about (the table above: the copies column).
* The measurements above are on a scrollback of 2,000 rows. xterm.js re-wraps only when it has a scrollback
  (`terminal.integrated.scrollback` 0 turns it off, and the editor, which assumes it, is then wrong about where the region
  is); a scrollback that is full trims its top rows, which the editor neither sees nor depends on (the rows it counts are
  the newest), but that was not measured: a trimmed line looks like a lost one to the generator's check.
* The result of a run that was let go of with a second Ctrl+C is not shown.
* A terminal's file links need the file to exist under a mount; a path with a space in it is not read as one.

## Facts about the workbench this depends on

Measured in the release build by the research, and re-checked here against the real `xterm.js` 6.1.0-beta.285
(`@xterm/headless`) where a unit test can:

* the workbench's xterm types replies into `handleInput` for DSR/CPR/DA/XTVERSION/DECRQM/DECRQSS/colours/window ops, and
  obeys DECCKM, mouse, focus and bracketed-paste modes: the filter's table and `shell-terminal-pty.test.js` pin it;
* a character written in the last column does not wrap until the next one; a wide character that does not fit wraps and
  leaves the last cell empty; a raw TAB moves the cursor (and moves it back from a pending wrap), so tabs are drawn as
  spaces;
* on resize xterm (`Buffer._reflowSmaller` / `_reflowLarger`, `reflowCursorLine` off: `terminalInstance.ts` sets it only
  for conpty) walks the screen's lines, **narrower from the last line up** (a wrapped or too wide line is re-wrapped
  unless it holds the cursor row *as it is by then*) and **wider from the first down** (a wrapped line is joined unless
  it holds the cursor row it had at the start), and moves its cursor row by the rows each line gained or lost,
  whichever side of the cursor the line is on. So the line under the cursor does not decide where the cursor ends up:
  a line below it that grows moves it down, and one below it that shrinks moves it up, possibly above the first row of
  the editor's region. The editor and the test model terminal reproduce that, and `shell-terminal-line-editor.test.js`
  compares both with xterm.js (scenarios and seeded sessions, both directions); every row is also cut at the new width;
* narrower, xterm.js does the re-wrapping over the WHOLE buffer, the scrollback too (rows pushed earlier are split, and
  the cells stay), and a line that gained rows is not given the room by pushing the top away: while the screen has not
  scrolled (`ybase` is 0) and the cursor is not on its last row, every row gained moves the cursor down by one and
  DROPS the last row of the buffer, whichever it is (`this.lines.pop()`: the blank ones, and when there are not enough
  of them the rows of the lines under the cursor, which are the new ones' own old rows, so what is left of a line is
  its end, with every row flagged as a continuation of the one above it); only then does the top go into the scrollback.
  With a scrollback (`ybase` > 0) nothing is dropped and the cursor row does not move: each gained row pushes one;
* the height first (`Buffer.resize`): a shorter panel first removes the blank rows below the cursor, then pushes the top
  of the screen into the scrollback; a taller one gives rows back **from the scrollback when the cursor is on the last
  row of the screen**, and adds blank rows below otherwise (the viewport top moves and the cursor with it: a region taller
  than the panel is a window that fills the screen, so its cursor is on the last row whenever it is on the window's last
  row);
* the redraw is written after `CSI J` at column 0, which makes the first row of a window a line of its own for xterm:
  a logical line that straddles the top of a window is two lines to the re-wrapping, and the rows above the window are
  not counted;
* `scrollOnEraseInDisplay` is on in VS Code (`xtermTerminal.ts`): `ESC[2J` scrolls what was on the screen, down to its
  last row with anything on it, into the scrollback; the test terminals are made that way;
* `Pseudoterminal` events fired before `open()` are lost (the agent tab holds them and re-says its name);
  `open(undefined)` is possible, `setDimensions` follows.

## Tests

`web/test/unit/shell-terminal-*.test.js`, plain node, deterministic (seeded), no network, nothing over a second:

| Suite | Pins |
| --- | --- |
| `input-parser` | the byte table, every report swallowed at every cut, the keys a sloppy "drop replies" pattern would eat, paste and its cap |
| `width` | the 25 measured widths; the table equals the addon (when an xterm checkout is found) |
| `line-editor` | the keys, the cursor on a newline, the full row, wide/combining characters, what may enter the buffer and what is kept (and the note), tabs (also at the top of a window), resize (scenarios on the model terminal, and the same on xterm.js), a tall buffer, Tab and the queued second Tab; a seeded differential against an oracle at three widths and with resizes; and, if xterm is found, against the real xterm.js: the editor's output, the model terminal's re-wrapping, seeded sessions with resizes in both directions, and a strict harness (after every step the screen is the text written once, nothing of the region is above it, and nothing that was on the terminal before it is lost: shrink and grow, a command, a note, Ctrl+C, Ctrl+L, windows, pinned sequences; and width and height in one event, with earlier output taller than the panel: pinned corner scenarios, each of which guards one of the estimates, and 200 seeded sessions on each terminal, aimed at the cursor above the end of a region on a terminal that has scrolled, in which a copy of the prompt may be left but nothing before it may be lost; then the same scenarios again through the verifier's generator's checker, which asks after every step that what the editor believes of the blank rows and of the pushed rows is a floor and that no copy of a pasted line is left (the corner ones), and 683 of its sessions in about two seconds; and the account of the pushed rows itself, `_ghostsAt` and `_headRows`, as units) |
| `completeness` | the table of traps and open constructs |
| `completion` | the word under the cursor and the write-back |
| `output-filter` | the 25 queries, the modes, the OSC list, links, the cap, a seeded chunking fuzz |
| `history` | the rules and the secret patterns (assembled from fragments) |
| `sink` | the OSC 633 escaping, the nonce, the queue and a run's output |
| `pty` | bytes in, bytes out: prompt, run, history, paste, Ctrl+C (the tail, the break, the stuck run), exit, 126/124, hostile output, a 100,000-character line |
| `agent-tab` | order, the result lines, sanitising, the caps (and that they cost linear time), the reveal table, the folder of every run |
| `links` | what is a candidate (a table of false positives), the existence check and its bounds (5 distinct paths, each in the folder it ended in and then only the misses in the folder it began in; 500 ms for all the rounds; 4,000 characters exactly; six spellings of one file are one of the five), what the runtime is asked, only a `file` is a link (`other`, `dir`, a link to nothing are none; a link to a file is), opening at the line and column |
| `line-log` | how the text of a row is made from bytes (and against xterm.js's own rows), what is kept, the latest of two equal lines |
| `prompt` | the label, the fewest folders that tell two apart, equivalent to the code before it was made linear, linear time |
| `index` | what is registered, focus rules, the shared history, the last working folder, the agent tab coming up, the links of a shell and of the agent's tab |

**Type check**: `tsc -p web/test/tsconfig.shell-terminal.json` is the sources of this directory under `strict`, and
`tsc -p web/test/tsconfig.shell-terminal-tests.json` the 14 test files and their helpers under the same options with
`noImplicitAny` off (they are plain scripts with unannotated local helpers; with it on they give 365 errors, all of
that kind, none in the sources). Both have 0 errors (TypeScript 6.0 with `@types/node`: the Code-OSS checkout has
both). **A test that waits for something that never happens exits 0** in this style (nothing keeps the process alive),
so each of the files ends with an `exit` handler that turns that into a failure; a mutation run must look for the
`N tests passed` line too.

`LEVELCODE_XTERM_DIR=<path to node_modules/@xterm>` points the xterm-backed checks at an xterm (and is then the only place
looked in); without it the tests look in `<repo>/vscode/node_modules/@xterm` and in the main checkout above a worktree.
When there is none they print `SKIPPED` (and a `::warning::` annotation for CI) and go on; **`LEVELCODE_REQUIRE_XTERM=1`
makes that a failure** in the width, line-editor, line-log, pty and agent-tab suites: a CI that has the checkout must set it, or it
is green with the staleness guard, the editor differentials and the hostile-output check not run. `node web/shell/src/terminal/gen-width.mjs <addon-unicode11.js> [--write]` regenerates the width table.
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
  and `LINES` from `rows`.
* The `start` agent event may carry `explanation` (shown dim when present).
* The prompt label uses the runtime's own `planMounts` (exported by `runtime.js`) so that a folder mounted under `/mnt`
  is still named by its folder; if that export goes away the label falls back to `folders()` and shows `/mnt/...`. The
  agent's tab maps the folder of a run (a workspace path) to the engine's with `toMountPath` the same way.
* The file links ask `runtime.resolve(path) -> Uri | null` and `runtime.stat(path) -> { type: 'file' | 'dir' | 'other',
  size } | null` (engine paths, never throwing; `stat` waits `workers.fsMs` at most; only `'file'` makes a link).
  Without them there are no links, and no error.
