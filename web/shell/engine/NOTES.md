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
| `compat.js` | What GNU has and the engine lacks: argument normalisers and wrappers around built-ins (`xargs grep rm cp mv mkdir sed paste head tail stat awk date uniq wc touch tr ls sort du`) and six programs the engine does not have (`od realpath uname id nproc cmp`). `du` is written here whole (the engine's printed bytes divided by 1024). |
| `text.js` | Bytes and text without losing a byte: a byte that is not UTF-8 is `U+DC00 + byte` (Python's surrogateescape) and goes back to that byte. Used by `overlay-fs.js`, `core.js` and the patched just-bash (patch LC-10). |
| `zone.js` | Local time that is not the visitor's: `LcDate`, the `Date` of the patched just-bash (patch LC-16), `partsAt`/`instantOf` for compat.js and the overlay. UTC unless the command's `TZ` names a zone. |
| `limits.js` | Every execution limit, explicit. The engine falls back to "normal" profile values (an hour, 256 MiB of output) for a key that is not given, so the table here is the only thing in force; a test dumps `ctx.limits` of a running command and compares. |
| `load.mjs` | `loadEngine()`: the patched file imported in node (for tests): temp file, specifiers rewritten to the vendored files, removed again. Also polyfills `globalThis.crypto` on Node 18. |
| `build.mjs` | esbuild: `worker.js` + the above + patched just-bash -> one classic IIFE. Refuses a `node:` import, a forbidden package (by package, from the metafile), a lost licence notice. Returns `{ code, bytes, gzip, brotli, packages, ... }`. |
| `vendor/just-bash/3.6.0/` | The unmodified npm file, `LICENSE`, `THIRD_PARTY.md` (all licences), `VENDOR.json` (pins), `apply-patches.mjs`. |
| `vendor/diff/8.0.4`, `vendor/sprintf-js/1.1.3` | The two packages `browser.js` imports without inlining, as published. |
| `vendor/stubs/{turndown,zlib,module}.mjs`, `shims/buffer.mjs` | Stubs for what must not or cannot be in a worker; the Buffer shim (the `buffer` package of the Code-OSS checkout). |

Run `node web/shell/engine/build.mjs --out <dir | file.js> --vscode <Code-OSS checkout>` (the checkout supplies esbuild
and `buffer`; `--minify` is the default and `--no-minify` is for reading the output; the last of the two wins; any other
flag is an error with exit status 2). A directory gets `engine.worker.js` and `engine.worker.THIRD_PARTY.md`; a name that
ends in `.js` is the file, and the notice is written next to it with the same stem. `web/shell/build.mjs` passes the
directory (it once passed a file name and got a folder called `engine.worker.js`; the test of that build runs it end to
end now).

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
| LC-9 | all twelve `localeCompare` of the file: `sort` (three), `sort -V`, the walk that find/du/grep -r/rg/tree share, glob results, `tree` (two), `$SHELLOPTS`, jq's comparators (three); and jq's `unique` and `group_by`, which did not sort at all | Everything that orders output collated by the visitor's browser language (`B a A _x 1` came out differently in Swedish). Code point order, which is UTF-8 byte order, which is what `LANG=C.UTF-8` says (`__lcCmp`; plain `<` would put U+1F600 before U+FF5E). jq's string order is by code point as well. | LC-9 (a patched file with no `localeCompare` left; the order of ten programs under a collation that is not English, and in a child process under `LC_ALL=sv_SE.UTF-8`), golden (`l-sort-*`, `r2-jq-order`) |
| LC-10 | the decoder of byte strings (`fe`: stdin of a command, a file read as bytes, the output of a command that returns bytes), its BOM handling, and the encoder (`Pn`) | Bytes that are not UTF-8 were left as latin-1 characters, which came out as the UTF-8 of those characters: `sort -o`, `$(cat f)`, a pipe through grep or awk changed a latin-1 file. Now `fe` escapes them (`text.js`) and `Pn` turns an escape into its byte; a BOM is kept. The decoder of the FINAL result (`x8`) is deliberately not patched: its input is text, and `é` alone is not UTF-8 as a byte. | LC-10, overlay (every encoding), core (what is shown) |
| LC-11 | the tokenizer of sed's `a i c` and where it prints their text | `$a\` (add a final newline if there is none), `a\`, `i\`, `c\` with no text: the engine printed a line with one backslash. Empty text prints no line. | LC-11, golden (`r2-sed-*`) |
| LC-12 | sed's `c` | On a range, `c` printed its text for every line; GNU prints it once, at the end of the range (never, if the range never ends); `!`, `{}` and one line are per line. Uses the engine's own range state (`__lcRangeOpen`). | LC-12, golden (`r2-sed-c-*`) |
| LC-13 | awk's primary expression | A bare `length` was an empty variable (`{print length}` printed nothing; `length > 5` nothing). It is `length($0)`. | LC-13, golden (`r2-awk-length`) |
| LC-14 | the regex adapter's `exec`, the four loops of grep's only-matching and count | `grep -o` with a pattern that can match nothing failed at the end of every line ("start index out of bounds", shown for a file as "No such file or directory"), and stepped over the position after an empty match twice (it missed `bb` in `abb` for `b*`). Empty matches are skipped, not printed; the status is the line's. | LC-14, golden (`r2-grep-o-*`) |
| LC-15 | cut's field loop | A line without the delimiter printed an empty line when the field was not 1; GNU prints it whole (unless `-s`). | LC-15, golden (`r2-cut-*`) |
| LC-16 | `Date` of the whole file (a `const Date` in the header, `LcDate` of `zone.js`) and the command dispatch (`setZone(env TZ)` before each command) | Local time was the visitor's zone: `date -u -d '2020-02-29 12:00:00'` was not 12:00, `touch -d`, `ls -l` and `stat` differed per visitor. It is UTC, or the zone the command's TZ names (any `TZ=...` prefix or export). | LC-16 (three process zones), core, golden/compat/fuzz suites (each is run under three zones), zone |
| LC-17 | program lookup | `echo printf pwd alias unalias history` are programs here and builtins in bash: `PATH=/x; echo a` was "command not found". They are found without a PATH (`cat` is not, as in bash). | LC-17, core |
| LC-18 | the set of builtin names and the topics of `help` | Thirteen builtins the engine names and does not implement (`trap umask kill jobs ...`) were listed by `help` and found by `command -v` and `type`, and are "command not found" when run. They are hidden; running one is still 127. | LC-18, core |

README §9 lists LC-1..LC-4; LC-5..LC-18 are additions (see the report's requests).
`node web/shell/engine/vendor/just-bash/3.6.0/apply-patches.mjs --check` verifies the hash of the file and that every
anchor is there exactly once, and writes nothing.

### Bumping just-bash

1. `npm pack just-bash@NEW` (read-only registry access); note the tarball's integrity and take
   `package/dist/bundle/browser.js`. Put it in `vendor/just-bash/NEW/` with the `LICENSE`.
2. Set `UNPATCHED_SHA256`, and `VENDOR.json` (version, file bytes/sha256, integrity). Move `BROWSER_JS` in `load.mjs`.
3. `node web/shell/engine/vendor/just-bash/NEW/apply-patches.mjs --check --in <the new browser.js>` names every anchor
   that is not there exactly once (`--out patched.js` writes the result). Find the new text with `grep -o` around the old
   anchor's neighbours (the file is minified: identifiers change between builds, the strings do not), fix `from`/`to`,
   repeat. The header uses three of the file's own names (`Nu`, `B3`-style names are in anchors only; `Nu` and
   `Ga` are in `__lcRangeOpen` and the jq `unique` edit): look at them first. Compare each patch with upstream's changelog: an
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
  suspend times trap ulimit umask`. They are `bash: trap: command not found`, 127, and the script goes on; `help`,
  `command -v` and `type` do not know them either (patch LC-18).
* Present but pointless: `ln` (symbolic and hard links are EPERM), `history` (empty), `alias` (per run), `time`.

## 4. What the model must be told

(For the tool description; every item is a behaviour a test pins, most of them in the golden table.)

1. It is not bash on a machine: 82 programs over the workspace folders, nothing else. No `git`, `node`, `npm`, `curl`,
   `python`, `tar`, `gzip`. Use the editor's own tools for those.
2. Each command is a fresh shell: `cd`, `export`, functions and aliases do not carry to the next command.
3. Only the workspace folders, `/tmp` and `/home/user` can be written. Everything else is read-only or absent. `/tmp` and
   `/home/user` are emptied after every command; a terminal session keeps them in the engine worker's memory, so they
   are lost with the worker (Ctrl+C, a timeout, closing the tab): `done.stats.tmpFiles` and `homeFiles` say how many
   files a session would lose, for the host to say so once.
4. File changes are applied only when the command ended by itself. A limit, a timeout, a stop, or a write the shell
   REFUSED (outside the folders, over a size cap, a folder turned into a file) applies NOTHING and the status is not 0.
   A write a real file system would refuse too (the folder is not there, the parent is a file, the target is a
   directory) is an ordinary error of that command, as in GNU (`touch nodir/f`, `tee nodir/x`, `sort -o nodir/o`); the
   rest of the script's changes are applied. Output printed before it is kept.
5. Caps: one file read 4 MiB, 16 MiB read per command; written 1 MiB per file, 8 MiB per command, 2000 files and
   folders (deletions and removed folders count: `rm -rf` of a tree with more than 2000 entries, or one that has more
   than 8000 below it, is refused whole). A file over the read cap is "No such file or directory" in the engine's words;
   the notes say it exists.
6. No background jobs: `cmd &` runs to its end first; `wait` is nothing; `trap`, `jobs`, `kill`, `umask`, `ulimit` are
   not there (not in `help`, not found by `command -v`). Loops are capped at 100000 iterations and 100000 commands,
   recursion at 100, `seq` and `yes` at 100000 lines. A program-level limit (`sed ':a;ba'`, an `awk` loop, a `jq` range)
   fails that program with status 126 and a message that names it; the script goes on and `how` stays `exit`.
7. Regular expressions are RE2: no back-references (`grep -E '(a)\1'`, `sed -E 's/(a)\1/x/'`) and no lookaround
   (`grep -P` is not there). `sed` has no `\U \L \E`. `find -regex` matches part of the path; `find -perm` takes no
   symbolic mode; `find -newermt` is not there. `awk` has no `system()`, reads `/dev/stdin` as empty, and formats `%e`
   and `%05.1f` its own way.
8. Arithmetic is double precision: past 2^53 it rounds; there is no 64-bit wrap-around.
9. Bytes: a file that is not UTF-8 goes through `sed -i`, `tee`, `sort -o`, `cat`, a pipe, `$(...)`, `grep`, `awk`,
   `cut -c`, `tr`, `paste` unchanged (a BOM and a NUL too). `printf '\377'` and `echo -e '\xff'` still produce the
   character U+00FF (UTF-8), not a byte, so a binary file cannot be made that way (`base64 -d` can); a terminal shows
   an invalid byte as U+FFFD. `grep` has no "binary file matches": it prints lines. `rev` and `sort` treat an invalid
   byte as one character that sorts above every character below U+DC80.
10. The whole script is parsed before any of it runs: a syntax error on line 20 stops line 1 from running.
11. Under `2>&1` the output of a command is in the order of statements (stdout, then stderr), not of writes; what a
    program writes to the path `/dev/stdout` (`tee /dev/stdout`) comes after the statement's own stdout.
    A script, heredocs included, of more than 1,000,000 bytes is "Input too large" (a syntax error, status 2): the
    parser's own limit, which `maxSourceBytes` and `maxHeredocSize` do not reach.
12. `chmod` lasts for the command only (nothing keeps a mode); a file whose first line is a shell shebang is executable
    (`ls -l` shows it, a plain `ls -F` does not mark it).
13. Every string order is by code point (byte order, `LANG=C.UTF-8`): `sort`, `sort -V`, `ls`, globs, `find`, `tree`,
    jq's `sort` `unique` `group_by` `min` `max` and object keys; the visitor's language is never asked. `sort -uf` keeps
    the last of equal lines. `$USER`, `$SHELL`, `$COLUMNS` are empty; `whoami` is `user`, `id` is 1000, `hostname` is
    `localhost`, `uname` says Linux x86_64.
14. Time: local time is UTC, or the zone of `TZ` in the command (`TZ=Asia/Tokyo date ...`, `export TZ=...`): `date -d`
    (also `Feb 29 2020 12:00`, `@N`, `... +0100`), `touch -d/-t`, `stat -c %y`, `ls -l`, `find -newer`. `date +%Z` of a
    zone that has no English abbreviation (`Asia/Tokyo`) prints `GMT+9`, not `JST`. `ls -l` shows a year for files
    older than 180 days (GNU: six months). A wall-clock time that does not exist (the hour a clock skips) is read an
    hour later; GNU says "invalid date".
15. Missing options that GNU has: `wc -L`, `cut --output-delimiter`, `cut -b`, `cut --complement`, `uniq -f`, `tail -f`,
    `tail -z`, `diff -r -w`, `grep -b -z`, `sed -s`, `ls -s`, `find -newermt`, `rm -v` of a tree lists the folder only.
    Work: `head -c 1K`, `-n -N`, `head -z`, `cp -a -u`, `mv -u`, `mkdir -m`, `sed -i.bak`, `sed '$a\'`, `xargs -P -I`,
    `stat -c %Y %y`, `touch -t -d @N`, `date -r`, `awk -f`, `awk '{print length}'`, `grep -o '[0-9]*'`, `grep -H`,
    `grep --include GLOB` (the value apart), `sort -nk2`, `du -s FILE -h -k -m -b -a -c -d N`, `ls -p --color=auto`.
16. `cp -i`, `mv -i`, `rm -i`, `rm -I`: there is nobody to answer, so they do nothing and say so (GNU answers no too).
17. `mv` and `cp -r` of a directory: onto a directory that has something in it is "Directory not empty" (mv) or a merge
    (cp), onto a file is "cannot overwrite non-directory", and a file onto a directory is "cannot overwrite directory",
    with nothing changed, as in GNU; `mv` keeps the file's modification time and mode; `cp -r a a/b` is "cannot copy a
    directory into itself" and copies nothing (GNU copies part of it, in an order that no file system fixes).
18. A symbolic link cannot be made. `ls -l` shows `user user`, directories 4096, and a `total` line as a file system
    with 4 KiB blocks has it. `du` counts 4 KiB blocks too: a file of 2 bytes is 4, an empty file 0, a directory 4.
19. `sed 'c'` on a range prints its text once at the end of the range; `a\`, `i\`, `c\` with no text add nothing, and
    `$a\` adds the missing final newline.

## 5. What is not covered, and known rough edges

* No real browser in the repo's tests. The bundle is run in a `vm` context that has a Worker's globals and none of node's
  (shell-engine-build.test.js); it was also run once by hand in headless Chrome (a real nested Worker, a stub host).
  Latency of `workspace.fs` (a remote workspace) is not modelled: a read is two round trips (stat for the cap, then
  readFile), and `grep -r` over 1000 files is 1000 reads plus 1020 stats. A prefetching host or a `readDir` that carries
  sizes would halve that.
* A synchronous stretch inside the engine (a huge `printf` width, a long-word glob: ~7 s for a 100 KB word) cannot be
  aborted until it returns; the host's own timer terminates the worker. The limits keep this to seconds. (The sed
  one-liner rewrite in compat.js used to be one of them: a script of 4000 spaces took 10 s. It is a one-pass scanner
  now, and a script over 64 KiB is not rewritten at all.)
* A read error other than "missing" is printed as "No such file or directory" by the engine; `notes` carry the true
  reason (permission, size cap, directory, host error).
* A write the file system refuses (a missing folder) is printed with the engine's own words (`touch: cannot touch
  'nodir/f': ENOENT: No such file or directory, open '/w/nodir/f'`), not GNU's.
* `/tmp` and `/home/user` live in the engine worker's heap. A worker that is terminated (Ctrl+C, a timeout) takes a
  session's `/tmp` with it; the host is told how many files that is (`stats.tmpFiles`) and says so.
* A change set cannot say "this path was a folder and is a file now" (or the reverse): writes are applied before
  deletions on purpose (`mv a b` writes b and then removes a, so a failure leaves both). Such a run is withheld as
  `incomplete` with the reason, and the next command can do it in two steps. The consistency suite counts these.
* A case-only rename (`mv a.txt A.txt`) on a disk that ignores case is a write and a delete of "the same" file; only
  commit.js's case-fold check defends against it (the engine does not know what kind of disk it is on).
* `sed -n 'w nodir/f'` does not report the missing folder (the engine swallows the failed write of `w`).
* Functions, aliases and options do not persist; `expandAliases` makes a session's aliases work as variables only.
* Anything in the golden table's 73 entries; the table is the authority and may only shrink.
* The fuzz run is 3000 scripts of one seed in UTC and 800 in each of two other zones (about 9 s). It proves no crash, no
  stack in the output, no hang past two seconds under tightened limits; it does not prove the output is right (the
  golden suite does, for 587 cases, and the consistency suite does for the change set of 300 nested scripts).
* The text domain is "UTF-8 with escapes": a string that is bytes and a string that is text are the same JavaScript
  type, and the engine tells them apart by what is above U+00FF. Patch LC-10 changes only the places that are known to
  receive BYTES (a pipe, a file read as bytes, the output of a command that returns bytes). A new program in a bumped
  version that decodes with its own `TextDecoder` is not covered until it is looked at (the patches suite counts the
  `TextDecoder` and `TextEncoder` of the file).

## 6. Protocol: what this engine does beyond README §4

All fields are additive and optional; a host that ignores them works.

| Message | Field | Meaning |
| --- | --- | --- |
| `init` | `limits` | Partial override of the pinned table: known keys, numbers greater than 0, the rest ignored. |
| `init` | `commands` | An allow-list; it can only narrow the engine's own list. compat.js's names are filtered by it too: a wrapper (`grep`, `sed` ...) is there only when the program it wraps is, and a program it adds (`cmp`, `id` ...) only when it is named. |
| `run` | `caps` | `{ readFile, readRun, writeFile, writeRun, entries }`, README §7 numbers by default. Each value only when it is a finite number above zero: `undefined`, `NaN`, a string, `0` and a negative one are the default (a comparison with NaN is false for every number, so a mistyped cap was no cap at all). |
| `run` | `keepTmp` | Keep `/tmp` and `/home/user` from the previous run (a terminal session). |
| `run` | `expandAliases` | Prepend `shopt -s expand_aliases` (the session carries aliases as variables). |
| `ready` | `mounts` | `[{ id, name, path, at, relocated }]`: where each folder is seen. A folder at `/`, on `/tmp /home /bin /usr /dev /proc`, or inside another (or around one) is seen under `/mnt/<name>` (`/lc-mnt/<name>` when a folder is mounted at `/mnt` itself); `done.cwd` and every path in the change set are the host's own paths. |
| `ready` | `error` | Init failed (a message): `commands` is empty. A host that waits for `ready` is told, not left waiting. |
| `done` | `denied` | `[{ path, op, reason, code, message }]`: every write the shell refused (policy or cap). Never an exception. An ordinary failure of a write (no such folder, a directory) is not here: it is an error of the command and its status. |
| `done` | `notes` | Sentences for the model: a relocated folder, a working directory that was not one, a read that was refused although the file exists, a write refused by policy, why nothing was applied (`None of its file changes were applied: ...`, for a refused write, an unrepresentable set, and for a limit, a deadline, a stop or an error when something had been staged). |
| `done` | `stats` | `filesRead bytesRead probes statCalls readCalls listCalls stagedBytes stagedEntries memoryBytesAtStart durationMs changes discarded withheld mounts tmpFiles homeFiles`. `withheld` is `null`, `'denied'` or `'incomplete'`; `discarded` is how many changes were not applied; `tmpFiles` and `homeFiles` are the files in `/tmp` and `/home/user` at the end of a `keepTmp` run (0 for a run that keeps nothing). |

`how`: `exit` (the script ran to its end, whatever its status), `limit` (126, a shell-level limit; the message names it,
without advice about options), `deadline` (124, the engine's own `maxExecutionTimeMs`), `aborted` (124, an `abort`
message), `error` (an exception from the engine: one `bash: ...` line, never a stack). Only `exit` has changes, and
a script that ended with status 0 with its changes withheld ends with status 1.

The change set is the NET difference: a rewrite with the same bytes, create-then-delete and an append of nothing are not
changes; deletions below a removed folder are listed (`viaDir`), deepest first; `before` is read lazily and only for what
stays a change, under the read caps (`null` beyond them). If the set cannot be represented (more than `entries`, a
folder that became a file, a folder below a removed one that the host would not list, the host failing while it was
worked out) `changes` is empty and `stats.withheld` is `'incomplete'` and the notes say why. Buffers are transferred, each once,
whole (a view into a larger buffer is copied first). If posting `done` throws, a smaller `done` (how `error`) is sent.

## 7. Size and speed

* `engine.worker.js`: 1,374,439 bytes raw, 393,819 gzip, 315,001 brotli (esbuild, minified, es2022). Of it, just-bash is
  about 1.26 MB; the `buffer` package (+ base64-js, ieee754) is 50 KB; `text.js` and `zone.js` are a few KB. Building
  twice gives the same bytes.
* In node, in-process, with a host that answers at once: loading and patching 45 ms; `init` 2 ms; `echo hi` 7 ms
  (a fresh `Bash` and its 82 stubs); a 2000-iteration loop 12 ms; `seq 1 20000 | sort -n | uniq | wc -l` 13 ms;
  `grep -rc` over 1000 files 18 ms (1000 reads, 1020 stats); `find` over the same 7 ms (21 listings).
* Memory is released after a run unless `keepTmp`; one run holds at most the caps (16 MiB read, 8 MiB staged) plus the
  engine's own `maxLiveBytes` (64 MiB).

## 8. Tests

| File | Tests | What |
| --- | --- | --- |
| `shell-engine-patches.test.js` | 41 | the vendored file (size, sha256, integrity), imports, anchors counted independently of the script, the patched hash, `--check`, refusal of a wrong file, each patch's behaviour (LC-1 .. LC-18) |
| `shell-engine-overlay.test.js` | 61 | mounts and relocation (both directions of overlap, `/proc`, a folder at `/mnt`), layout, caps before reads and their boundaries, notes and their cap, denied and its de-duplication, writes that are refused by the shell and writes a file system would refuse, tombstones, opaque folders, staged files below a removed or moved folder, net change set and its order, memory areas and their byte accounting, identity, devices, bytes that are not UTF-8, a base that fails |
| `shell-engine-core.test.js` | 52 | handshake, program list pinned by name, streaming, decoding, limits table (every number), limit/deadline/abort/error classification and wording, exit-path flushes, never rejects, late answers, env/cwd round trip, `/tmp`, relocation, change-set hand-over, caps from the host, `init.commands`, `tmpFiles`, the zone of the process, the stand-in engine contract |
| `shell-engine-compat.test.js` | 30 | every normaliser case by case (including what is NOT dropped), wrappers through the engine, `od`, `cmp`, `du`, the sed scanner, the exported lists pinned; run under three process zones |
| `shell-engine-golden.test.js` | 4 | 587 cases against GNU bash 5.1.16 / coreutils 8.32 (docker, recorded once): 514 identical, 73 listed with a reason and the differing fields, the list may only shrink; run under three process zones |
| `shell-engine-consistency.test.js` | 4 | 300 seeded random nested scripts: the change set, applied by the real `src/commit.js` over a map with a delete that takes a file or an EMPTY folder, leaves the tree GNU left (`web/test/fixtures/shell/consistency/`, recorded once) |
| `shell-engine-fuzz.test.js` | 3 | 3000 mutated and token-soup scripts in UTC, 800 in each of two other zones (`FUZZ_DUMP=file` writes failures) |
| `shell-engine-text.test.js` | 7 | the byte/text codec: every invalid form, a property test, a 4 MiB input, what is shown |
| `shell-engine-zone.test.js` | 7 | zones, offsets across a daylight saving change, the Date class, strings with and without a zone; each under five process zones |
| `shell-engine-build.test.js` | 8 | the build's checks on synthetic input and the command line (`--out` as a directory and as a file, `--minify`, bad arguments); when a Code-OSS checkout whose esbuild runs is found (`LEVELCODE_VSCODE`, `REPO/vscode`, `REPO/../../../vscode`): the real build, its contents, a run in a worker-like `vm`, and `web/shell/build.mjs` end to end. Without one it says so in a line that starts `!! SKIPPED`; `LEVELCODE_REQUIRE_BUILD=1` makes that a failure |

`node web/test/unit/shell-engine-<name>.test.js`; no dependencies, no network, `TZ` is set by the tests that read local
time. All of them pass on Node 24 and Node 18 (`docker run --rm --network none -v $PWD:/repo:ro -w /repo
catthehacker/ubuntu:act-latest node web/test/unit/shell-engine-core.test.js`; Node 18 has no global `crypto`, which
`load.mjs` and the overlay test supply).

The golden file is regenerated with `node web/test/fixtures/shell/golden/generate.mjs` (docker, the image above already
pulled, `--network none`, every case run twice; a case whose output differs between the runs is left out and named in
`meta.flaky`). Review the diff: a changed expected output is a new GNU, not a regression. New cases go in
`golden/cases/round2.mjs` (or `extra.mjs`); give a case that needs a time an explicit `touch -d '@N'`, and a file that is
not UTF-8 `base64 -d` (printf escapes make characters here). A case that depends on the locale or the order of a
directory in GNU (a copy of a directory into itself, `grep` of a latin-1 file, `rev`) is not a good case. The
consistency file is regenerated with `node web/test/fixtures/shell/consistency/generate.mjs`.

Every behaviour above was mutation-checked on a copy of the tree: a one-line defect put back (a cap not applied, a
tombstone dropped, a normaliser branch removed, a regex alternative removed, a patch edit removed with its pins
updated so a behaviour test decides, the write-withhold rule removed, ...), the suites run, and each had to go red.
A suite that stays green under a mutation is missing a test, not the mutation a reason. The ones that stayed green are
equivalent (`env.PWD = cwd` which the engine sets as well, the second `doneSent` guard that nothing reaches,
`pending.clear()` which only frees memory) and are listed in the report of the round that found them. Three more are
equivalent by construction and stay in the table of patches for the invariant "no `localeCompare` left": the order the
shared walk visits a directory in (only `cp -r`, `mv` and `chmod -R` use it, and none of them prints), the order of
`tree`'s fallback for a file system without `readdirWithFileTypes` (the overlay has it), and `$SHELLOPTS` (every name in
it is lowercase ASCII, which every collation orders the same).
