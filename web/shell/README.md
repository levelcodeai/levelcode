# LevelCode Shell (browser edition)

A shell for the files of the workspace, inside the browser tab: a terminal panel for the visitor, and the engine behind the
agent's `run_command`. **It does not start programs.** It is a JavaScript bash (the vendored, patched `just-bash` 3.6.0:
bash grammar and about 80 coreutils-like commands) running over `vscode.workspace.fs`. No `node`, `npm`, `git`, `python`,
no network, no background jobs. A later stage adds Pyodide and friends as custom commands behind the same seam.

This file is the contract between the parts. Where code and this file disagree, one of them is a bug.

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
  (about 45 ms). If a Worker cannot be created the shell is *unavailable* (`caps.shell` stays false): there is no
  in-realm fallback.
* The engine worker **cannot write**. Its file system is a copy-on-write overlay over a read-only RPC to the host. A run
  ends with a **change set**; nothing reaches the workspace until the host commits it (§5). A run that is stopped, times
  out or hits an engine limit applies **nothing**: its staged writes are discarded and the result says so
  ("none of its file changes were applied"). Atomic and explainable; the output it had already printed stays.
* The host owns everything that must survive a kill: cwd/env of a terminal session, history, the commit.

## 2. Names and files

| Path | What |
| --- | --- |
| `web/shell/package.json` | the extension manifest (built-in, **no activation events**: commands, terminal profile, keybindings, viewsWelcome) |
| `web/shell/src/extension.js` | `activate()`; registers the profile/commands; returns the API of §3 |
| `web/shell/src/runtime.js` | engine worker lifecycle, fs RPC server, `Session`, deadline/kill, commit orchestration |
| `web/shell/src/commit.js` | writing a change set straight to `vscode.workspace.fs` (the visitor's own terminal) |
| `web/shell/src/info.js` | the program list, `ShellInfo`, the "missing" list the prompt names |
| `web/shell/src/sanitize.js` | `forTerminal`, `forDisplay`, the output allow-list filter |
| `web/shell/src/terminal/*` | pty, line editor, input parser, history, completion, agent tab |
| `web/shell/engine/*` | worker entry, `core.js`, `overlay-fs.js`, compat wrappers, vendoring, build |
| `web/test/unit/shell-*.test.js` | unit tests (found by `scripts/test-extensions.sh`, which globs `web/test/unit/*.test.js`) |

Plain CommonJS for everything that runs in the extension host (`web/shell/src`, the way `web/workspace` is). The engine
worker is bundled by esbuild (`web/shell/engine/build.mjs`) into one `engine.worker.js` asset.

## 3. The API levelcode-ai consumes

`vscode.extensions.getExtension('levelcode.levelcode-shell').exports` is:

```js
{
  apiVersion: 1,
  agent: {
    info: ShellInfo,
    spawn(command: string, opts: SpawnOptions): ChildLike,
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
  commit?: (changes: Change[]) => Promise<{ rest: Change[]; notes: string[]; failed?: number }>;
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
* Chunks are **strings**. They are streamed per top-level statement of the script (engine patch LC-1), so a long
  `for` loop or one pipeline arrives at its end; everything else as it completes.
* `close` code: the script's exit status; 126 when an engine limit was hit (message names the limit); 124 for a
  deadline; 130 after `kill('SIGTERM')`; 137 after `kill('SIGKILL')`. (agent.js reports 130/124 itself from its flags.)
* Each `spawn` is a **fresh shell** (`sh -c` parity): cwd, exports, functions and aliases do not carry to the next call.
  The visitor's terminal is a persistent *session* (§6), separate.
* Env given to the engine is minimal: `HOME=/home/user PATH=/usr/bin:/bin PWD=<cwd> TERM=dumb CI=1 NO_COLOR=1 LANG=C.UTF-8`
  plus `opts.env`. Never `ctx`, keys, tokens or the `vscode` object.

`Change`:

```ts
type Change =
  | { kind: 'write';  path: string; existed: boolean; before: Uint8Array | null; after: Uint8Array }
  | { kind: 'delete'; path: string; before: Uint8Array | null; viaDir?: string }
  | { kind: 'mkdir';  path: string }
  | { kind: 'rmdir';  path: string };
```

`path` is absolute under a mount (`/scratch/src/a.js`, `/my-folder/README.md`). `before` is the bytes the command saw
(null when it did not exist).

## 3b. What the terminal consumes (runtime → terminal)

```ts
runtime.folders(): Array<{ name: string; root: string; uri: string }>        // live workspace folders, in order
runtime.createSession(o?: { cwd?: string }): Session                          // a persistent terminal session
runtime.onAgentRun(listener: (e: AgentRunEvent) => void): { dispose(): void } // every run_command, for the mirror tab
runtime.dispose(): void

interface Session {
  readonly cwd: string;                      // updated after every run
  readonly env: Readonly<Record<string, string>>;
  run(script: string, o?: { onStdout?(text: string): void; onStderr?(text: string): void; cols?: number }): Promise<RunResult>;
  stop(): void;                              // Ctrl+C: terminate the engine worker; the pending run settles with how:'aborted'
  complete(kind: 'path' | 'command', prefix: string): Promise<string[]>;   // for Tab; read-only, bounded
  dispose(): void;
}
interface RunResult { exitCode: number; how: 'exit'|'limit'|'deadline'|'aborted'|'error'; notes: string[]; cwd: string; applied: number; durationMs: number }
type AgentRunEvent =
  | { type: 'start'; id: number; command: string; cwd: string }
  | { type: 'chunk'; id: number; stream: 'stdout' | 'stderr'; text: string }
  | { type: 'end';   id: number; exitCode: number; how: string; notes: string[] };
```

A session runs **one script at a time** (a second `run` while one is pending rejects with `Error('busy')`).
`complete()` asks the engine worker's file system through the same read RPC, with a cap of 200 names and 2 s.

## 4. Engine worker protocol

Structured clone; `ArrayBuffer`s transferred. `gen` is a generation number the host increments per spawned worker; every
host-side handler ignores messages of an older generation.

host → engine

| message | |
| --- | --- |
| `{ t:'init', gen, folders:[{id,path,name}], limits, commands:string[] }` | once; the engine answers `ready` |
| `{ t:'run', id, script, cwd, env, stdin, caps:{ readFile, readRun, writeFile, writeRun, entries } }` | one script |
| `{ t:'abort', id }` | cooperative stop (the host also terminates after a grace period) |
| `{ t:'fsr', rid, ok:true, value }` / `{ t:'fsr', rid, ok:false, error:{ code, message } }` | answer to an `fs` request |

engine → host

| message | |
| --- | --- |
| `{ t:'ready', gen, commands }` | the program list that really exists |
| `{ t:'fs', rid, op:'stat'\|'readFile'\|'readDir', path }` | **reads only**. `stat` → `{type:'file'\|'dir', size, mtime}`; `readFile` → `Uint8Array`; `readDir` → `[name, 'file'\|'dir'][]`; errors carry a POSIX `code` |
| `{ t:'out', id, stream:'stdout'\|'stderr', text }` | after each completed top-level statement |
| `{ t:'done', id, exitCode, how, cwd, env, changes, denied, notes, stats }` | exactly once per run. `how`: `exit` `limit` `deadline` `aborted` `error` |

The host checks that every `fs` path is inside a mounted folder and that the generation is current; a read the engine
sends after `done`, or from a terminated generation, is dropped.

## 5. Commit

A run's change set is committed by the host, in this order, after the engine's `done` **when `how` is `exit`** (a
script that ran to its end, whatever its status; otherwise nothing is applied):

1. **Agent runs** (`opts.commit` given): `commit(changes)` is levelcode-ai's `shellCommit` — it validates the *whole*
   set first and applies **nothing** if any change is refused (protected path, binary, too large, > 300 files, file
   changed on disk since the command read it, unsaved editor buffer, line endings that would not survive, case-only
   rename). Allowed changes go through `ctx.applyEdit` / `ctx.applyDelete`: the same Keep/Undo and per-turn checkpoint as
   `edit_file`. It returns `rest` (the `mkdir`/`rmdir` entries) which the shell applies with `workspace.fs`, and `notes`
   which are appended to stderr.
2. **The visitor's terminal** (no `commit`): `src/commit.js` validates (inside the folders, size caps, entry cap) and
   writes bytes with `workspace.fs` — creates, then deletes, deepest paths first — and reports a partial application
   honestly (`N of M applied`).

Every write the engine attempts outside a mount, to a protected path or past a cap is **dropped and recorded** in
`denied` (never thrown: just-bash rejects `exec()` for any error from a write in a redirection and loses all output);
the run's exit status becomes 1 if it was 0.

## 6. The terminal

A `vscode.Pseudoterminal` created by the contributed profile "LevelCode Shell" or by `levelcode.shell.new`.
Each terminal tab is a **session**: it keeps `cwd` and `env` (taken back from the engine's result after every line),
the history, and one engine worker created on first use. Functions, aliases and shell options do **not** persist across
lines (documented in the welcome text and `help`). A line is one script; an unterminated quote / here-doc / trailing
`\`, `|` or `&&` continues on the next line (the editor decides; there is no parser export in the browser build).
Output to the terminal goes through the allow-list filter of `src/sanitize.js`; **every** string that did not come from
this extension's own constants is untrusted.

The agent's commands are mirrored into one read-only tab "LevelCode Agent" (§ terminal spec in
`docs/SHELL.md` once written) without taking the focus.

## 7. Limits (explicit; asserted by tests)

| | agent run | terminal line |
| --- | --- | --- |
| engine `maxCommandCount` / `maxLoopIterations` / `maxCallDepth` | 100000 / 100000 / 100 | same |
| engine `maxOutputSize` / `maxStringLength` / `maxLiveBytes` / `maxInputBytes` | 8 MiB / 16 MiB / 64 MiB / 32 MiB | same |
| engine `maxExecutionTimeMs` (backstop; the host timer is the real one) | 600000 | 600000 |
| host wall-clock deadline | agent.js `commandTimeout` (kills via `kill('SIGKILL')`) | none; Ctrl+C |
| read one file | 4 MiB | 4 MiB |
| bytes read per run | 16 MiB | 16 MiB |
| bytes staged per file / per run / entries | 1 MiB / 8 MiB / 2000 | 8 MiB / 32 MiB / 2000 |
| files a reviewed commit may change | 300 | 2000 |
| output returned to the model | head+tail window of 8000 chars with the status line last | n/a |
| output shown in a terminal tab per run | 1 MiB, in 16 KiB macrotask chunks | same |

## 8. What is never allowed

* No network: `curl`, `wget`, `js-exec`, `python3`, `sqlite3`, `tar`, `yq`, `xan` are 127 with an honest message. The
  engine option `network` is never passed; the command allow-list is explicit and asserted.
* The engine worker gets no secrets: nothing from `context.secrets`, `globalState`, settings, or the vscode object.
* A string from a file, a command's output or the model reaches a terminal only through the filter, and a card only
  through `forDisplay`.

## 9. Vendoring

`engine/vendor/just-bash/3.6.0/` holds the **unmodified** npm file (`browser.js`, sha256 pinned in `VENDOR.json`,
`LICENSE` Apache-2.0). `apply-patches.mjs` refuses unless the input hash matches and every anchor occurs exactly once,
then writes the patched file at build time. The patched file is modified by LevelCode (Apache-2.0 §4(b): the build
output carries a notice). Patches: LC-1 statement hook, LC-2 glob `*/`, LC-3 arithmetic `$` guard, LC-4 `read` UTF-8.
`legalComments` are kept in the bundle (re2js MIT, ieee754 BSD-3-Clause). Never vendor `node-liblzma` (LGPL), the zstd
native module, `typescript`, `sql.js`.
