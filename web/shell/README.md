# LevelCode Shell (browser edition)

A shell for the files of the workspace, inside the browser tab: a terminal panel for the visitor, and the engine behind the
agent's `run_command`. **It does not start programs.** It is a JavaScript bash (the vendored, patched `just-bash` 3.6.0:
bash grammar and 82 coreutils-like commands) running over `vscode.workspace.fs`. No `node`, `npm`, `git`, `python`,
no network, no background jobs. A later stage adds Pyodide and friends as custom commands behind the same seam.

This file is the contract between the parts. Where code and this file disagree, one of them is a bug. The parts
have notes of their own that go deeper and are subordinate to this file: `engine/NOTES.md` (what the engine promises,
the model-facing behaviours, the golden differential) and `src/terminal/NOTES.md` (keys, lines, rendering, how to
check it in a real browser).

## 1. The parts

```
 extension host (one web worker, shared by every extension)
 ┌────────────────────────────────────────────────────────────────────────────────────────────┐
 │ levelcode-ai  agent.js ── host.spawn(command, opts) ──┐                                      │
 │                                                       ▼                                      │
 │ levelcode-shell (lazily activated)                                                           │
 │   extension.js   profile, commands, viewsWelcome, exports { apiVersion: 1, agent }           │
 │   runtime.js     engine workers, fs RPC server (reads only), deadline, kill, commit          │
 │   terminal/*     Pseudoterminal: input parser, line editor, output filter, history, agent tab│
 │        │  postMessage                                                                        │
 │        ▼                                                                                     │
 │   engine worker (nested classic Worker from a Blob; its own thread and heap)                 │
 │     engine/core.js + patched just-bash + overlay-fs.js   — owns NO state that must survive   │
 └────────────────────────────────────────────────────────────────────────────────────────────┘
```

* The engine runs in a **nested classic Worker** because it never yields the thread and ignores `AbortSignal` while a
  script is CPU-bound (measured). Stop / Ctrl+C / a timeout is `worker.terminate()`; the next run spawns a new worker
  (about 45 ms). If a Worker cannot be created the shell is *unavailable*: the extension returns `{ apiVersion: 1 }`
  **without** `agent`, so `host.caps.shell` stays false and the agent keeps its shell tools withheld. There is no
  in-realm fallback.
* The engine worker **cannot write**. Its file system is a copy-on-write overlay over a read-only RPC to the host. A run
  ends with a **change set**; nothing reaches the workspace until the host commits it (§5). A run that is stopped, times
  out or hits an engine limit applies **nothing**: its staged writes are discarded and the result says so
  ("none of its file changes were applied"). Atomic and explainable; the output it had already printed stays.
* The host owns everything that must survive a kill: cwd/env of a terminal session, history, the commit. The engine
  owns nothing that has to survive it — with one exception the visitor is told about (§6, `/tmp`).

## 2. Names and files

| Path | What |
| --- | --- |
| `web/shell/package.json` | the extension manifest (built-in, **no activation events**: commands, terminal profile, keybindings, viewsWelcome) |
| `web/shell/src/extension.js` | `activate()`; registers the profile/commands; returns the API of §3 |
| `web/shell/src/runtime.js` | engine worker lifecycle, fs RPC server, mount planning, `Session`, deadline/kill, commit orchestration |
| `web/shell/src/commit.js` | writing a change set straight to `vscode.workspace.fs` (the visitor's own terminal) |
| `web/shell/src/info.js` | the program list, `ShellInfo`, the "missing" list the prompt names, the `LIMITS` table |
| `web/shell/src/sanitize.js` | `forTerminal`, `forDisplay`, `forNote`: untrusted *strings* made safe to show (§8). Not the terminal's output filter |
| `web/shell/src/terminal/output-filter.js` | the allow-list filter every byte of a command's output passes before it reaches a terminal (§8) |
| `web/shell/src/terminal/links.js` | the only file-link path of our terminals (`terminal.integrated.enableFileLinks` is `off`) |
| `web/shell/src/terminal/*` | pty, line editor, input parser, history, completion, shell integration, agent tab |
| `web/shell/engine/*` | worker entry, `core.js`, `overlay-fs.js`, `compat.js` (wrappers), `text.js` (the byte/text domain), `zone.js` (time zones), vendoring, build |
| `web/test/unit/shell-*.test.js` | unit tests (found by `scripts/test-extensions.sh`, which globs `web/test/unit/*.test.js`) |
| `web/test/helpers/mutation/` | the mutation runner and its table (a tool, not a suite) |
| `web/test/e2e-shell.mjs` | the end-to-end run in a real Chrome (a tool, not part of the unit gate) |

Plain CommonJS for everything that runs in the extension host (`web/shell/src`, the way `web/workspace` is). The engine
worker is bundled by esbuild (`web/shell/engine/build.mjs --out <dir|file.js> [--vscode <dir>] [--minify|--no-minify]`;
an unknown flag is exit 2) into one `engine.worker.js` asset.

## 3. The API levelcode-ai consumes

`vscode.extensions.getExtension('levelcode.levelcode-shell').exports` is:

```js
{
  apiVersion: 1,
  agent: {                       // absent when this browser cannot start a nested Worker from a Blob
    info: ShellInfo,
    spawn(command: string, opts: SpawnOptions): ChildLike,
    forDisplay(text: string): string,   // host.displaySafe(): what an approval card shows of a model-written string
  },
}
```

```ts
interface ShellInfo {
  label: 'LevelCode Shell';
  background: false;            // '&' and background:true are not supported
  programs: false;              // no real programs
  network: false;
  commands: string[];           // the programs that exist (exact names), sorted
  missing: string[];            // the ones the model is likely to try that do not (git, npm, node, python3, curl, ...)
  limits: { commandCount: number; loopIterations: number; callDepth: number; outputBytes: number; fileReadBytes: number; runReadBytes: number };
}
interface SpawnOptions {
  cwd: string;                                         // absolute path: a workspace folder root, or inside one
  folders?: Array<{ name: string; root: string; uri: string }>;   // live, in order; each is mounted at its `root`
  env?: Record<string, string>;
  explanation?: string;                                // the model's own label for the command, for the mirror tab (<= 500 UTF-16 units)
  timeoutMs?: number;                                  // 1..2^31-1; anything else is the default deadline
  commit?: (changes: Change[], control: { cancelled(): boolean }) =>
    Promise<{ rest: Change[]; notes: string[]; failed?: number; refused?: boolean }>;
}
interface ChildLike {          // what agent.js's runCommand uses of a Node ChildProcess
  pid?: number;                // undefined => agent.js kills with child.kill(sig)
  stdout: { on(ev: 'data', cb: (chunk: string) => void): void };
  stderr: { on(ev: 'data', cb: (chunk: string) => void): void };
  on(ev: 'close', cb: (code: number) => void): void;   // exactly once, after every 'data', after the commit
  on(ev: 'error', cb: (e: Error) => void): void;
  kill(signal?: string | number): boolean;
}
```

* `spawn` **never throws** for an ordinary failure; it reports it as stderr + `close(1)`.
* Chunks are **strings**, never empty. They are streamed per top-level statement of the script (engine patch LC-1), so a
  long `for` loop or one pipeline arrives at its end; everything else as it completes.
* `close` code: the script's exit status; 126 when an engine limit was hit (message names the limit); 124 for a
  deadline; 130 after `kill('SIGTERM')`; 137 after `kill('SIGKILL')`. (agent.js reports 130/124 itself from its flags.)
* Each `spawn` is a **fresh shell** (`sh -c` parity): cwd, exports, functions and aliases do not carry to the next call.
  The visitor's terminal is a persistent *session* (§6), separate.
* Env given to the engine is minimal: `HOME=/home/user PATH=/usr/bin:/bin PWD=<cwd> TERM=dumb CI=1 NO_COLOR=1 LANG=C.UTF-8`
  plus `opts.env` (at most 512 variables and 256 KiB; the ones that did not fit are named in one note — a variable is
  skipped, not everything after it). Never `ctx`, keys, tokens or the `vscode` object.
* `commit` is asked **once**, after the command ran to its end and before `close`. `control.cancelled()` turns true
  when the run was stopped while the set was being checked: the review then applies nothing. Once its first write has
  begun nothing interrupts it.

`Change`:

```ts
type Change =
  | { kind: 'write';  path: string; existed: boolean; before: Uint8Array | null; after: Uint8Array }
  | { kind: 'delete'; path: string; before: Uint8Array | null; viaDir?: string }
  | { kind: 'mkdir';  path: string }
  | { kind: 'rmdir';  path: string };
```

`path` (and `viaDir`) is absolute **in the workspace's own terms** — the folder's real root, not the engine's mount: the
host translates a relocated mount back before a change reaches the review. `before` is the bytes the command saw
(null when it did not exist).

## 3b. What the terminal consumes (runtime → terminal)

```ts
runtime.folders(): Array<{ name: string; root: string; uri: string }>        // live workspace folders, in order
runtime.mounts(): Array<{ ...folder; mount: string }>                         // where the engine sees each (README §4)
runtime.createSession(o?: { cwd?: string }): Session                          // a persistent terminal session
runtime.onAgentRun(listener: (e: AgentRunEvent) => void): { dispose(): void } // every run_command, for the mirror tab
runtime.dispose(): void

interface Session {
  readonly cwd: string;                      // updated after every run
  readonly env: Readonly<Record<string, string>>;
  run(script: string, o?: { onStdout?(text: string): void; onStderr?(text: string): void; cols?: number; rows?: number; timeoutMs?: number }): Promise<RunResult>;
  stop(): void;                              // Ctrl+C: terminate the engine worker; the pending run settles with how:'aborted'
  complete(kind: 'path' | 'command', prefix: string): Promise<string[]>;   // for Tab; read-only, bounded
  dispose(): void;
}
interface RunResult { exitCode: number; how: 'exit'|'limit'|'deadline'|'aborted'|'error'; notes: string[]; cwd: string; applied: number; durationMs: number }
type AgentRunEvent =
  | { type: 'start'; id: number; command: string; cwd: string; explanation?: string }   // explanation is untrusted text, <= 500
  | { type: 'chunk'; id: number; stream: 'stdout' | 'stderr'; text: string }
  | { type: 'end';   id: number; exitCode: number; how: string; notes: string[] };
```

A session runs **one script at a time** (a second `run` while one is pending rejects with `Error('busy')`; a `script`
that is not text rejects with `Error('script must be text')`). `rows`/`cols` become `LINES`/`COLUMNS` (whole numbers
1..9999, else absent). `complete()` asks the engine worker's file system through the same read RPC, with a cap of 200
names and 2 s. Every string in `notes` is one line and already safe to print; a run's first note may be the `/tmp`
note (§6) or the "environment variables not kept" note.

## 4. Engine worker protocol

Structured clone; `ArrayBuffer`s transferred. `gen` is a generation number the host increments per spawned worker; every
host-side handler ignores messages of an older generation. **The host never sends `abort`**: a stop is `terminate()`.

host → engine

| message | |
| --- | --- |
| `{ t:'init', gen, folders:[{id,path,name}], limits, commands:string[] }` | once; the engine answers `ready`. `path` is the mount the **host** planned (§ mounts below), `limits` is `LIMITS.engine` laid over the engine's own table (`engine/limits.js`; a key that is not a positive number is ignored), `commands` is what the shell asks for — a wrapper in `compat.js` is offered only when its original is named |
| `{ t:'run', id, script, cwd, env, stdin, caps:{ readFile, readRun, writeFile, writeRun, entries }, keepTmp?, expandAliases? }` | one script. `caps` are validated once by the overlay (a bad one refuses the run). `keepTmp` and `expandAliases` are set for a terminal line only |
| `{ t:'fsr', rid, ok:true, value }` / `{ t:'fsr', rid, ok:false, error:{ code, message } }` | answer to an `fs` request |

engine → host

| message | |
| --- | --- |
| `{ t:'ready', gen, commands }` | the program list that really exists; it is what `ShellInfo.commands` becomes |
| `{ t:'fs', rid, op:'stat'\|'readFile'\|'readDir', path }` | **reads only**. `stat` → `{type:'file'\|'dir', size, mtime}`; `readFile` → `Uint8Array`; `readDir` → `[name, 'file'\|'dir'][]`; errors carry a POSIX `code`. A `size` that is not a finite number ≥ 0 is `EIO` |
| `{ t:'out', id, stream:'stdout'\|'stderr', text }` | after each completed top-level statement |
| `{ t:'done', id, exitCode, how, cwd, env, changes, denied, notes, stats }` | exactly once per run. `how`: `exit` `limit` `deadline` `aborted` `error`. `stats.tmpFiles` and `stats.homeFiles` count what a `keepTmp` run left in `/tmp` and `/home/user` |

The host checks that every `fs` path is inside a mounted folder and that the generation is current; a read the engine
sends after `done`, or from a terminated generation, is dropped.

**Mounts.** The engine sees a folder at its real root when that is a path it can host. A root that is `/`, that is
under one of the engine's own top-level names (`/bin`, `/dev`, `/home`, `/proc`, `/tmp`, `/usr`), or that overlaps an
earlier folder is **relocated** by the host (`planMounts`, in `runtime.js`) to `/mnt/<slug>` — or to `/lc-mnt/<slug>`,
`/lc-mnt-2/<slug>`… when a folder is itself rooted at `/mnt`. The plan always terminates and never nests mounts. The
run's stderr names every relocation once, with the folder's name and path made safe. `Change` paths are translated back
(§3).

## 5. Commit

A run's change set is committed by the host, in this order, after the engine's `done` **when `how` is `exit`** (a
script that ran to its end, whatever its status; otherwise nothing is applied):

1. **Agent runs** (`opts.commit` given): `commit(changes, control)` is levelcode-ai's `shellCommit` — it validates the
   *whole* set first and applies **nothing** if any change is refused (protected path, binary, too large, > 300 files,
   file changed on disk since the command read it, unsaved editor buffer, line endings that would not survive,
   case-only rename, or a Stop while it was checking). Allowed changes go through `ctx.applyEdit` / `ctx.applyDelete`:
   the same Keep/Undo and per-turn checkpoint as `edit_file`. It answers `{ rest, notes, failed?, refused? }`; `rest`
   may only contain `mkdir`/`rmdir` entries **of this change set** (anything else is counted failed and named), which
   the shell applies with `workspace.fs`; an answer that is not an object with a `rest` list is "gave no answer";
   `failed` must be a finite non-negative number. `notes` are appended to stderr.
2. **The visitor's terminal** (no `commit`): `src/commit.js` validates (inside the folders, size caps, entry cap),
   checks that nothing changed on disk since the command read it (read-only, bounded), and writes bytes with
   `workspace.fs` — creates, then deletes, deepest paths first, **never recursive and never to the trash** — and reports
   a partial application honestly (`N of M applied`).

While a run is committing, a worker failure or `dispose()` does not settle it with a false "nothing was applied": it
ends when the commit does, and says how many changes landed. Every provider call has a deadline (`workers.fsMs`, the
review `workers.commitMs`); a call that outlives it is reported (`stopped at`), and a write that completes later still
lands — that is not cancellable, and the result says so.

Every write the engine attempts outside a mount, to a protected path or past a cap is **dropped and recorded** in
`denied` (never thrown: just-bash rejects `exec()` for any error from a write in a redirection and loses all output);
the run's exit status becomes 1 if it was 0. An ordinary failure (a missing folder, a directory where a file was
meant) is the errno `bash` itself would print, not a `denied`.

## 6. The terminal

A `vscode.Pseudoterminal` created by the contributed profile "LevelCode Shell" or by `levelcode.shell.new`.
Each terminal tab is a **session**: it keeps `cwd` and `env` (taken back from the engine's result after every line),
the history, and one engine worker created on first use. Functions and shell options do **not** persist across lines;
**aliases do** (the engine carries them in the environment; the welcome text and `help` say so). A line is one script;
an unterminated quote / here-doc / trailing `\`, `|` or `&&` continues on the next line (the editor decides; there is
no parser export in the browser build). A pasted chunk with a line end is inserted, never executed.

**`/tmp` belongs to a terminal's worker.** It survives from one line to the next, and is lost when that worker is
replaced (idle for 60 s — twice that when `/tmp` holds files —, Ctrl+C, a deadline, a crash, eviction). The next line
says so once, with the number of files it held. An agent run never keeps `/tmp`.

Output to the terminal goes through the allow-list filter of `src/terminal/output-filter.js`, and **every** string that
did not come from this extension's own constants is untrusted and goes through `src/sanitize.js` (§8). File
links in output are made only by `src/terminal/links.js`: a path that exists as a file under a mount, at most five per
line, 500 ms in all.

The agent's commands are mirrored into one read-only tab "LevelCode Agent" without taking the focus.

## 7. Limits (explicit; asserted by tests; one table, `info.js` `LIMITS`)

| | agent run | terminal line |
| --- | --- | --- |
| engine `maxCommandCount` / `maxLoopIterations` / `maxCallDepth` | 100000 / 100000 / 100 | same |
| engine `maxOutputSize` / `maxStringLength` / `maxLiveBytes` / `maxInputBytes` | 8 MiB / 16 MiB / 64 MiB / 32 MiB | same |
| a script (or its here-docs) | 1,000,000 bytes — just-bash's own parser cap, under `maxSourceBytes`: "Input too large", status 2 | same |
| engine `maxExecutionTimeMs` (backstop) | 600000 | 600000 |
| host wall-clock deadline | agent.js `commandTimeout` (kills via `kill('SIGKILL')`); the backstop + 15 s otherwise | backstop + 15 s (615 s); Ctrl+C |
| read one file | 4 MiB | 4 MiB |
| bytes read per run (the script's) / served by the host in all | 16 MiB / 32 MiB | same |
| bytes staged per file / per run / entries | 1 MiB / 8 MiB / 2000 | 8 MiB / 32 MiB / 2000 |
| files a reviewed commit may change | 300 | 2000 |
| a file call to the provider / levelcode-ai's review | 60 s / 120 s | 60 s / – |
| live engine workers / idle before terminate | 4 / 60 s | same |
| output returned to the model | head+tail window of 8000 chars with the status line last | n/a |
| output shown in a terminal tab per run | 1 MiB, in 16 KiB macrotask chunks | same |
| completion | – | 200 names, 2 s |

The engine's own table (`engine/limits.js`) has 45 keys; `LIMITS.engine` above is the ones the shell sets, the engine's
own values the rest.

## 8. What is never allowed

* No network: `curl`, `wget`, `js-exec`, `python3`, `sqlite3`, `tar`, `yq`, `xan` are 127 with an honest message. The
  engine option `network` is never passed; the command allow-list is explicit and asserted.
* The engine worker gets no secrets: nothing from `context.secrets`, `globalState`, settings, or the vscode object.
* A string from a file, a command's output or the model reaches a terminal only through the filter
  (`output-filter.js`; only OSC 633 from `shell-integration.js`, with a random nonce per terminal), a card only
  through `forDisplay`, a one-line note through `forNote`. `sanitize.js` makes control, format (`Cf`), bidi and
  unpaired-surrogate characters visible as `␛` / `[U+XXXX]`; the one exception is a single ZWNJ/ZWJ between two
  letters of the **same** Arabic or Indic script, which `forTerminal` keeps and `forDisplay` still shows.
* A command never changes the protected paths (`.git`, `.vscode`, `.levelcode`, `.cursor`, `.husky`,
  `.github/workflows`, `AGENTS.md`, `CLAUDE.md`, `.cursorrules`, `.windsurfrules`), whole-set refusal.
* The browser's settings are **application**-scoped: a folder's `.vscode/settings.json` cannot change the cloud
  endpoint, autopilot or the verify command (Workspace Trust is off in a tab). Only the display preferences in
  `WORKSPACE_SETTINGS_OK` (`web/ai-extension/manifest.js`) are workspace-scoped.

## 9. Vendoring

`engine/vendor/just-bash/3.6.0/` holds the **unmodified** npm file (`browser.js`, sha256 pinned in `VENDOR.json`,
`LICENSE` Apache-2.0). `apply-patches.mjs` refuses unless the input hash matches and every anchor occurs exactly once,
then writes the patched file at build time (`node apply-patches.mjs --check` verifies the anchors without writing).
The patched file is modified by LevelCode (Apache-2.0 §4(b): the build output carries a notice).

Patches (18, 47 anchor edits; the title of each is next to it in `apply-patches.mjs`):

| | |
| --- | --- |
| LC-1 | the per-top-level-statement hook (`onStatement`: live output, what ran before a deadline survives) |
| LC-2 | glob `*/` matches directories only |
| LC-3 | arithmetic `$` followed by a non-name character no longer loops forever |
| LC-4 | `read` / `mapfile` assign UTF-8 text |
| LC-5 | a redirection whose target cannot be opened is `bash: f: <reason>`, status 1, the command not run |
| LC-6 | the result of `exec()` keeps raw bytes (`lcRaw`) |
| LC-7 | an honest 127 for the programs the engine knows it lacks |
| LC-8 | `ls -l` shows the real mode |
| LC-9 | every ordering comparison is by code point (`sort`, `jq`, `tree`…) |
| LC-10 | bytes that are not UTF-8 survive a round trip (surrogate-escape domain, `engine/text.js`) |
| LC-11 – LC-15 | `sed` `a\ i\ c\` and `c` on a range; `awk` bare `length`; `grep -o` with empty matches; `cut` without a delimiter |
| LC-16 | `Date` is the command's `TZ` (UTC when none), `engine/zone.js` |
| LC-17 – LC-18 | builtins resolved without `PATH`; builtins the engine does not implement are not listed |

`legalComments` are kept in the bundle (re2js MIT, ieee754 BSD-3-Clause); `diff` 8.0.4 and `sprintf-js` 1.1.3 are
vendored beside it. Never vendor `node-liblzma` (LGPL), the zstd native module, `typescript`, `sql.js`. `turndown`,
`zlib` and `module` are stubbed; `gzip`, `gunzip` and `zcat` are left out because they need `node:zlib`.
