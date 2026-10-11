# Engine notes

What the engine worker is, what was changed in just-bash and why, how to bump it, what the model has to be told about it,
and what is not covered. The contract is `web/shell/README.md`; where this file adds to it (the protocol fields in §6),
the README should say the same.

## 1. The files

| File | What it is |
| --- | --- |
| `worker.js` | Wires `self.onmessage` to the core. Five lines of logic; everything else is testable in node. |
| `core.js` | `createCore({ Engine, post, now })`: the protocol of README §4. One run = one fresh `Bash` over a fresh overlay. Classifies how a run ended, withholds changes, streams per statement. |
| `overlay-fs.js` | just-bash's `IFileSystem`, from scratch: a copy-on-write overlay over the host's read-only async `fs` RPC, plus memory for `/tmp`, `/home/user`, `/dev`, `/proc`, the program stubs. Produces the net change set. |
| `compat.js` | What GNU has and the engine lacks: argument normalisers and wrappers around built-ins (`xargs grep rm cp mv mkdir sed paste head tail stat awk date uniq wc touch tr ls`) and six programs the engine does not have (`od realpath uname id nproc cmp`). |
| `limits.js` | Every execution limit, explicit. The engine falls back to "normal" profile values (an hour, 256 MiB of output) for a key that is not given, so the table here is the only thing in force; a test dumps `ctx.limits` of a running command and compares. |
| `load.mjs` | `loadEngine()`: the patched file imported in node (for tests): temp file, specifiers rewritten to the vendored files, removed again. Also polyfills `globalThis.crypto` on Node 18. |
| `build.mjs` | esbuild: `worker.js` + the above + patched just-bash -> one classic IIFE. Refuses a `node:` import, a forbidden package (by package, from the metafile), a lost licence notice. Returns `{ code, bytes, gzip, brotli, packages, ... }`. |
| `vendor/just-bash/3.6.0/` | The unmodified npm file, `LICENSE`, `THIRD_PARTY.md` (all licences), `VENDOR.json` (pins), `apply-patches.mjs`. |
| `vendor/diff/8.0.4`, `vendor/sprintf-js/1.1.3` | The two packages `browser.js` imports without inlining, as published. |
| `vendor/stubs/{turndown,zlib,module}.mjs`, `shims/buffer.mjs` | Stubs for what must not or cannot be in a worker; the Buffer shim (the `buffer` package of the Code-OSS checkout). |

Run `node web/shell/engine/build.mjs --out <dir> --vscode <Code-OSS checkout>` (the checkout supplies esbuild and
`buffer`; `--no-minify` for reading the output). `engine.worker.THIRD_PARTY.md` is written next to the bundle.

## 2. The patches

`apply-patches.mjs` takes the file, checks its sha256 (`UNPATCHED_SHA256`), finds every anchor in the ORIGINAL text,
refuses unless each occurs exactly once and no two overlap, and builds the result from those positions in one pass (so a
replacement can neither create a second match nor be re-edited, and `$&` in a replacement means nothing). The result
starts with the Apache-2.0 §4(b) notice. The patched file is never committed: `load.mjs` and `build.mjs` make it in
memory. `VENDOR.json` pins its sha256 (c11f997f…ddfe) and size; a test compares.

| | Where (anchor starts with) | What and why | Pinned by (shell-engine-patches.test.js) |
| --- | --- | --- | --- |
| LC-1 | `execInScope` hands `n?.onStatement` to the depth-0 script; `executeScript` awaits `h(i)` after each statement's result (4 edits: the two `catch` classes that let the script go on call it too) | `ExecOptions.onStatement(result)`: output per top-level statement, so a long loop streams and what ran before a deadline survives. README §3 (chunks per statement). | order, awaited, expansion errors at their place, deadline |
| LC-2 | `expandSimple` ends `.sort()}` | A glob that ends in `/` matches directories only and keeps the slash (`echo */`, `for d in */`). The engine returned files, without the slash. | LC-2 |
| LC-3 | the `ArithConcat` loop `for(;DN(t,s);)` | `$(( $ ))`, `(( x = $ ))`: the loop did not advance and grew an array until the heap was gone. Now a syntax error at once. | LC-3, every form |
| LC-4 | `read` after the trailing delimiter is removed; `mapfile` where each element is pushed | `read` and `mapfile` assigned one character per BYTE: a non-ASCII line written back was double-encoded. Decoded as UTF-8 when the whole value is valid UTF-8, else untouched. | LC-4 (two tests) |
| LC-5 | the `catch` of the redirection's opening write | A redirection whose target cannot be opened (no folder, no permission, a directory) is `bash: f: <reason>`, status 1, command not run, script goes on, for every form. It used to reject the whole `exec()` and lose all output. | LC-5 (two tests), overlay |
| LC-6 | `logResult` stores the bytes before decoding | `exec()`'s result keeps the raw byte-shaped stdout/stderr as `lcRaw`. core.js needs it to cut exactly what the hook did not show from what the engine returned (the decoded text is shorter). | LC-6 (two tests), core |
| LC-7 | the not-found branch of command resolution | A program the engine knows it lacks (`tar yq xan python3 sqlite3 js-exec ...`) answered "use the Node.js bundle". Now `bash: NAME: command not found`, 127, like `git`. README §8. | LC-7, compat (every name of `LIKELY_MISSING`) |
| LC-8 | `ls -l` of a file operand, of a directory's entries, `ls -ld` | Printed `-rw-r--r--`/`drwxr-xr-x` whatever the mode was, so `chmod +x f; ls -l f` looked as if `chmod` did nothing. Now the mode the file system reports. | LC-8 |
| LC-9 | the three `localeCompare` comparisons of `sort` | `sort` collated by the visitor's browser locale, so the order of `B a A _x 1` depended on the language. Byte order, which is what `LANG=C.UTF-8` says. | LC-9 (every path that compares whole lines), golden (`l-sort-*`) |

README §9 lists LC-1..LC-4; LC-5..LC-9 are additions (see the report's requests).

### Bumping just-bash

1. `npm pack just-bash@NEW` (read-only registry access); note the tarball's integrity and take
   `package/dist/bundle/browser.js`. Put it in `vendor/just-bash/NEW/` with the `LICENSE`.
2. Set `UNPATCHED_SHA256`, and `VENDOR.json` (version, file bytes/sha256, integrity). Move `BROWSER_JS` in `load.mjs`.
3. `node web/shell/engine/vendor/just-bash/NEW/apply-patches.mjs --out /tmp/p.js`. An anchor that is not there exactly once
   is named; find the new text with `grep -o` around the old anchor's neighbours (the file is minified: identifiers
   change between builds, the strings do not), fix `from`/`to`, repeat. Compare each patch with upstream's changelog: an
   upstream fix makes a patch obsolete, and its test then passes without it (take the patch out).
4. `importSpecifiers(browser.js)` (load.mjs) must still be the four vendored/stubbed names; a new import is a new vendored
   package or a stub. Update `vendor/diff` and `vendor/sprintf-js` to the versions in just-bash's `package.json`
   (as published, with their licences) and `THIRD_PARTY.md`.
5. `limits.js`: the engine's `ExecutionLimits` has new keys? Add them (the core test fails with the key's name).
6. Run all of `web/test/unit/shell-engine-*.test.js`, on Node 24 and Node 18. A failing golden case is either a real
   regression or an upstream change: if upstream got closer to GNU, remove the case from the table in
   `shell-engine-golden.test.js` (the table may only shrink); if it got further, fix with compat.js or document.
7. Update `VENDOR.json`'s `patched` block (sha256, bytes, patches, edits) from the apply-patches output.
8. Check the licences of anything newly inlined (`THIRD_PARTY.md`), and that `FORBIDDEN_PACKAGES` in build.mjs still holds.

## 3. The programs

82 names (`ready.commands`, sorted; `/usr/bin/<name>` exists for each):

```
alias awk base64 basename bash cat chmod clear cmp column comm cp cut date diff dirname du echo egrep env expand expr
false fgrep file find fold grep head help history hostname id join jq ln ls md5sum mkdir mktemp mv nl nproc od paste
printenv printf pwd readlink realpath rev rg rm rmdir sed seq sh sha1sum sha256sum sleep sort split stat strings tac
tail tee time timeout touch tr tree true unalias uname unexpand uniq wc which whoami xargs yes
```

* Not offered although the engine has them (`compat.EXCLUDED`): `gzip gunzip zcat html-to-markdown` (no `node:zlib`, no
  DOM).
* Honest 127, with `command -v` saying not found (`compat.LIKELY_MISSING`, what a model tries: `git npm npx yarn pnpm node
  deno bun python python3 pip pip3 ruby perl php java go cargo rustc make cmake gcc cc curl wget ssh scp rsync tar zip
  unzip gzip gunzip zcat xz bzip2 patch less more vi vim nano sudo su ps top docker yq xan sqlite3 js-exec
  html-to-markdown bc shuf tsort iconv dd install truncate sha512sum shasum cksum hexdump xxd`). README's
  `ShellInfo.missing` can be this list minus anything in `ready.commands`.
* Builtins the engine declares and does not have (`compat.UNIMPLEMENTED_BUILTINS`): `bg caller disown enable fc fg jobs kill
  suspend times trap ulimit umask`. They are `bash: trap: command not found`, 127, and the script goes on. Two lies
  remain in the engine's own text: `help` lists them, and `command -v trap` finds them.
* Present but pointless: `ln` (symbolic and hard links are EPERM), `history` (empty), `alias` (per run), `time`.

## 4. What the model must be told

(For the tool description; every item is a behaviour a test pins, most of them in the golden table.)

1. It is not bash on a machine: 82 programs over the workspace folders, nothing else. No `git`, `node`, `npm`, `curl`,
   `python`, `tar`, `gzip`. Use the editor's own tools for those.
2. Each command is a fresh shell: `cd`, `export`, functions and aliases do not carry to the next command.
3. Only the workspace folders, `/tmp` and `/home/user` can be written. Everything else is read-only or absent. `/tmp` and
   `/home/user` are emptied after every command (a terminal session may keep them).
4. File changes are applied only when the command ended by itself. A limit, a timeout, a stop, or a write the shell
   refused (outside the folders, over a size cap, a folder turned into a file) applies NOTHING and the status is not 0.
   Output printed before it is kept.
5. Caps: one file read 4 MiB, 16 MiB read per command; written 1 MiB per file, 8 MiB per command, 2000 files and
   folders. A file over the read cap is "No such file or directory" in the engine's words; the notes say it exists.
6. No background jobs: `cmd &` runs to its end first; `wait` is nothing; `trap`, `jobs`, `kill`, `umask`, `ulimit` are
   not there. Loops are capped at 100000 iterations and 100000 commands, recursion at 100, `seq` and `yes` at 100000
   lines. A program-level limit (`sed ':a;ba'`, an `awk` loop, a `jq` range) fails that program with status 126 and a
   message that names it; the script goes on and `how` stays `exit`.
7. Regular expressions are RE2: no back-references (`grep -E '(a)\1'`, `sed -E 's/(a)\1/x/'`) and no lookaround
   (`grep -P` is not there). `sed` has no `\U \L \E`. `find -regex` matches part of the path; `find -perm` takes no
   symbolic mode. `awk` has no `system()`, reads `/dev/stdin` as empty, and formats `%e` and `%05.1f` its own way.
8. Arithmetic is double precision: past 2^53 it rounds; there is no 64-bit wrap-around.
9. `printf '\377'` and `echo -e '\xff'` produce the character U+00FF (UTF-8), not a byte: binary files cannot be written
   that way. `base64 -d`, `cp`, `cat`, `head -c` keep bytes.
10. The whole script is parsed before any of it runs: a syntax error on line 20 stops line 1 from running.
11. Under `2>&1` the output of a command is in the order of statements (stdout, then stderr), not of writes.
12. `chmod` lasts for the command only (nothing keeps a mode); a file whose first line is a shell shebang is executable.
13. `sort` is in byte order, `LANG=C.UTF-8`; `sort -uf` keeps the last of equal lines. `$USER`, `$SHELL`, `$COLUMNS` are
    empty; `whoami` is `user`, `id` is 1000, `hostname` is `localhost`, `uname` says Linux x86_64.
14. Missing options that GNU has: `du -b`, `wc -L`, `cut --output-delimiter`, `uniq -f`, `tail -f`, `diff -r -w`,
    `rm -v` of a tree lists the folder only. `head -c 1K`, `-n -N`, `cp -a -u`, `mv -u`, `mkdir -m`, `sed -i.bak`,
    `xargs -P -I`, `stat -c %Y`, `touch -t -d @N`, `date -r`, `awk -f` work (compat.js).
15. `cp -i`, `mv -i`, `rm -i`, `rm -I`: there is nobody to answer, so they do nothing and say so (GNU answers no too).
16. A symbolic link cannot be made. `ls -l` shows `user user`, directories 4096.

## 5. What is not covered, and known rough edges

* No real browser in the repo's tests. The bundle is run in a `vm` context that has a Worker's globals and none of node's
  (shell-engine-build.test.js); it was also run once by hand in headless Chrome (a real nested Worker, a stub host).
  Latency of `workspace.fs` (a remote workspace) is not modelled: a read is two round trips (stat for the cap, then
  readFile), and `grep -r` over 1000 files is 1000 reads plus 1020 stats. A prefetching host or a `readDir` that carries
  sizes would halve that.
* A synchronous stretch inside the engine (a huge `printf` width, a long-word glob: ~7 s for a 100 KB word) cannot be
  aborted until it returns; the host's own timer terminates the worker. The limits keep this to seconds.
* `help` lists builtins that are not there; `command -v trap` finds one. A read error other than "missing" is printed as
  "No such file or directory" by the engine; `notes` carry the true reason (permission, size cap, directory, host error).
* `sed`/`awk`/`jq` print their own name twice in a limit message (`sed: sed: command execution ...`).
* Functions, aliases and options do not persist; `expandAliases` makes a session's aliases work as variables only.
* Anything in the golden table's 74 entries; the table is the authority and may only shrink.
* The fuzz run is 3000 scripts of one seed (about 6 s). It proves no crash, no stack in the output, no hang past two
  seconds under tightened limits; it does not prove the output is right (the golden suite does, for 535 cases).

## 6. Protocol: what this engine does beyond README §4

All fields are additive and optional; a host that ignores them works.

| Message | Field | Meaning |
| --- | --- | --- |
| `init` | `limits` | Partial override of the pinned table: known keys, numbers greater than 0, the rest ignored. |
| `init` | `commands` | An allow-list; it can only narrow the engine's own list. |
| `run` | `caps` | `{ readFile, readRun, writeFile, writeRun, entries }`, README §7 numbers by default. |
| `run` | `keepTmp` | Keep `/tmp` and `/home/user` from the previous run (a terminal session). |
| `run` | `expandAliases` | Prepend `shopt -s expand_aliases` (the session carries aliases as variables). |
| `ready` | `mounts` | `[{ id, name, path, at, relocated }]`: where each folder is seen. A folder at `/`, on `/tmp /home /bin /usr /dev /proc`, or inside another is seen under `/mnt/<name>`; `done.cwd` and every path in the change set are the host's own paths. |
| `ready` | `error` | Init failed (a message): `commands` is empty. A host that waits for `ready` is told, not left waiting. |
| `done` | `denied` | `[{ path, op, reason, code, message }]`: every write the shell refused (policy or cap). Never an exception. |
| `done` | `notes` | Sentences for the model: a relocated folder, a working directory that was not one, a read that was refused although the file exists, a write refused by policy, why nothing was applied (`None of its file changes were applied: ...`, for a refused write, an unrepresentable set, and for a limit, a deadline, a stop or an error when something had been staged). |
| `done` | `stats` | `filesRead bytesRead probes statCalls readCalls listCalls stagedBytes stagedEntries memoryBytesAtStart durationMs changes discarded withheld mounts`. `withheld` is `null`, `'denied'` or `'incomplete'`; `discarded` is how many changes were not applied. |

`how`: `exit` (the script ran to its end, whatever its status), `limit` (126, a shell-level limit; the message names it,
without advice about options), `deadline` (124, the engine's own `maxExecutionTimeMs`), `aborted` (124, an `abort`
message), `error` (an exception from the engine: one `bash: ...` line, never a stack). Only `exit` has changes, and
a script that ended with status 0 with its changes withheld ends with status 1.

The change set is the NET difference: a rewrite with the same bytes, create-then-delete and an append of nothing are not
changes; deletions below a removed folder are listed (`viaDir`), deepest first; `before` is read lazily and only for what
stays a change, under the read caps (`null` beyond them). If the set cannot be represented (more than `entries`, a
folder that became a file) `changes` is empty and `stats.withheld` is `'incomplete'`. Buffers are transferred, each once,
whole (a view into a larger buffer is copied first). If posting `done` throws, a smaller `done` (how `error`) is sent.

## 7. Size and speed

* `engine.worker.js`: 1,356,848 bytes raw, 387,749 gzip, 310,476 brotli (esbuild, minified, es2022). Of it, just-bash is
  about 1.26 MB; the `buffer` package (+ base64-js, ieee754) is 50 KB. Building twice gives the same bytes.
* In node, in-process, with a host that answers at once: loading and patching 40 ms; `init` 2 ms; `echo hi` 12 ms
  (a fresh `Bash` and its 82 stubs); a 2000-iteration loop 10 ms; `seq 1 20000 | sort -n | uniq | wc -l` 9 ms;
  `grep -rc` over 1000 files 46 ms (1000 reads, 1020 stats); `find` over the same 6 ms (21 listings).
* Memory is released after a run unless `keepTmp`; one run holds at most the caps (16 MiB read, 8 MiB staged) plus the
  engine's own `maxLiveBytes` (64 MiB).

## 8. Tests

| File | Tests | What |
| --- | --- | --- |
| `shell-engine-patches.test.js` | 23 | the vendored file (size, sha256, integrity), imports, anchors counted independently of the script, the patched hash, refusal of a wrong file, each patch's behaviour |
| `shell-engine-overlay.test.js` | 37 | mounts and relocation, layout, caps before reads, notes, writes that never throw, opening that does, tombstones, opaque folders, net change set and its order, memory areas, identity, devices |
| `shell-engine-core.test.js` | 38 | handshake, program list pinned by name, streaming, decoding, limits table dumped from the engine, limit/deadline/abort/error classification and wording, never rejects, late answers, env/cwd round trip, `/tmp`, relocation, change-set hand-over, the stand-in engine contract |
| `shell-engine-compat.test.js` | 20 | every normaliser case by case (including what is NOT dropped), wrappers through the engine, `od`, `cmp`, the exported lists pinned |
| `shell-engine-golden.test.js` | 4 | 535 cases against GNU bash 5.1.16 / coreutils 8.32 (docker, recorded once): 461 identical, 74 listed with a reason and the differing fields, the list may only shrink |
| `shell-engine-fuzz.test.js` | 1 | 3000 mutated and token-soup scripts, seed 20261011 (`FUZZ_DUMP=file` writes failures) |
| `shell-engine-build.test.js` | 3 | the build's checks on synthetic input; when a Code-OSS checkout with esbuild and `buffer` is found (`LEVELCODE_VSCODE`, `REPO/vscode`, `REPO/../../../vscode`): the real build, its contents, and a run in a worker-like `vm` |

`node web/test/unit/shell-engine-<name>.test.js`; no dependencies, no network, `TZ` is set by the tests that read local
time. All of them pass on Node 24 and Node 18 (`docker run --rm --network none -v $PWD:/repo:ro -w /repo
catthehacker/ubuntu:act-latest node web/test/unit/shell-engine-core.test.js`; Node 18 has no global `crypto`, which
`load.mjs` and the overlay test supply).

The golden file is regenerated with `node web/test/fixtures/shell/golden/generate.mjs` (docker, the image above already
pulled, `--network none`, every case run twice; a case whose output differs between the runs is left out and named in
`meta.flaky`). Review the diff: a changed expected output is a new GNU, not a regression. New cases go in
`golden/cases/extra.mjs`; give a case that needs a time an explicit `touch -d '@N'`.

Every behaviour above was mutation-checked on a copy of the tree: a one-line defect put back (a cap not applied, a
tombstone dropped, a normaliser branch removed, a regex alternative removed, a patch edit neutered, the write-withhold
rule removed, ...), the suites run, and each had to go red. About 200 of them; the ones that survived are equivalent
(`env.PWD = cwd` which the engine sets as well, the second `doneSent` guard that nothing reaches, `pending.clear()`
which only frees memory). A suite that stays green under a mutation is missing a test, not the mutation a reason.
