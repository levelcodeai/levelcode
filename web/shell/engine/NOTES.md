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
| `compat.js` | What GNU has and the engine lacks: argument normalisers and wrappers around built-ins (`grep rm cp mv mkdir sed paste head tail stat awk date uniq wc touch tr ls sort`) and six programs the engine does not have (`od realpath uname id nproc cmp`). `du` and `xargs` are written here whole: `du` prints the numbers of a 4 KiB-block file system, and `xargs` reads its input the way GNU does, builds its command lines by size (`-s`, 128 KiB, `xargsPlan`) and starts each command through the engine with its arguments as an argument LIST (`ctx.exec(name, { args })`, never one string for the parser). `cp` and `mv` have a pre-flight (`preflight`): what GNU says before it does anything and the engine says differently or not at all; `transferEach` does `-u` and `cp -rn` a file at a time. `OPTION_VALUES` + `missingOptionValue` are the one reader of an option that needs a value and has none. |
| `text.js` | Bytes and text without losing a byte: a byte that is not UTF-8 is `U+DC00 + byte` (Python's surrogateescape) and goes back to that byte. Used by `overlay-fs.js`, `core.js` and the patched just-bash (patches LC-10, LC-29). `displayText` is what a person or a model is shown: EVERY lone surrogate (an escape, or half of an emoji that `awk substr` cut) is U+FFFD; `hasLoneSurrogate` is the question the overlay asks of a name; `joinEscapes` makes the escapes of bytes that are UTF-8 together the character (`printf '\303\251'`). |
| `zone.js` | Local time that is not the visitor's: `LcDate`, the `Date` of the patched just-bash (patch LC-16), `partsAt`/`instantOf` for compat.js and the overlay, `abbreviation` (`%Z`: JST, EDT, CEST, `+04`). UTC unless the command's `TZ` names a zone file (in the case the file is written in), or is a POSIX `NAME+-hh[:mm]`. |
| `zone-data.js` | GENERATED (`web/test/fixtures/shell/zones/generate.mjs`, from the reference container's tzdata 2024a, `--network none`): the 596 zone names, and tzdata's letters by offset (and by the time a zone that kept its offset renamed it) for 2010-2030. Do not edit. |
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
| LC-16 | `Date` of the whole file (a `const Date` in the header, `LcDate` of `zone.js`) and the command dispatch (`setZone(exportedEnv.TZ)` before each command) | Local time was the visitor's zone: `date -u -d '2020-02-29 12:00:00'` was not 12:00, `touch -d`, `ls -l` and `stat` differed per visitor. It is UTC, or the zone of the TZ the command was GIVEN: a prefix assignment or an exported variable, not `TZ=Asia/Tokyo; date` (GNU: UTC). | LC-16 (three process zones), core, golden/compat/fuzz suites (each is run under three zones), zone |
| LC-17 | program lookup | `echo printf pwd alias unalias history` are programs here and builtins in bash: `PATH=/x; echo a` was "command not found". They are found without a PATH (`cat` is not, as in bash). | LC-17, core |
| LC-18 | the set of builtin names and the topics of `help` | Thirteen builtins the engine names and does not implement (`trap umask kill jobs ...`) were listed by `help` and found by `command -v` and `type`, and are "command not found" when run. They are hidden; running one is still 127. | LC-18, core |
| LC-19 | strftime (`printf '%(fmt)T'`, and what `date` shares with it): the wall clock, `%Z`, and what `printf` hands it (3 edits) | `printf '%(%F %T %Z)T' 1600000000` formatted in the PROCESS's zone when the script had no TZ (Intl was called with `timeZone: undefined`), and `%Z` was Intl's `GMT+9`. The zone defaults to the command's, and `%Z` is `zone.js`'s `abbreviation` (a table of 205 names, tzdata's digits for the rest). `printf` no longer reads the variable TZ, so an unexported one is not the zone. | LC-19 (three process zones), golden (`r3-printf-T-*`, `r3-date-Z-names`), zone |
| LC-20 | `date`: where the zone and the string are read, the -I option and its output (3 edits) | `date -u -d WALL` read WALL in TZ and printed it in UTC; a TZ that was not exported or not an IANA name was honoured or ignored by the engine's own check. -u is applied first, the zone is the command's, and `-I[date\|hours\|minutes\|seconds\|ns]`, `--iso-8601[=...]` print a date (not a timestamp) and an offset with a colon. | LC-20 (three process zones), golden (`r3-date-*`, `r3-tz-*`) |
| LC-21 | the context's `exec` and the state a child exec gets (2 edits) | A program that starts commands through the shell (`xargs`, `timeout`, `find -exec`) ran them with the TOP-LEVEL variables, so `export FOO=1; xargs sh -c 'echo $FOO'` and `export TZ=Asia/Tokyo; timeout 5 date` saw nothing; and a variable given to a child (`env TZ=X cmd`, `bash -c`) was not exported inside it, which LC-16's reading of the exported variables needs. | LC-21, golden (`r3-tz-reaches-children`, `r3-exported-vars-reach-xargs`) |
| LC-22 | grep's basic-expression translation, its `mi` (the final regular expression), sed's `ku`, and the two call sites of grep's search (5 edits) | `grep -o '[0-9]\+'` printed nothing (`\+` and `\?` were literal characters), `\<` and `\>` matched a literal `<` in grep (basic and extended) and sed, and `grep -c -o` counted matches. Since the fourth round: a `\+`, `\?` or `*` after `\b \< \> \B` is a literal character (GNU), and `__lcQuant` (header) makes a quantifier after a quantifier the group `(?:a*)+` (`a*\+`, `a*+`, `a+?`: GNU's "optional run", RE2 said invalid or lazy) in grep and sed. | LC-22, golden (`r3-bre-*`, `r3-ere-*`, `r3-sed-word-boundaries`, `r3-grep-oc-counts-lines`, `r4-bre-*`) |
| LC-23 | sort's key text and its use of `-u` (5 edits) | `sort -k2` compared field 2 alone (GNU: to the end of the line), fields did not take the blanks before them, `-b` was not given to a key, and `-u` kept another line than GNU (`sort -u -k2,2`, `-nu`, `-uf`) because equal lines were put in order by the whole line and then thinned by the first key as a set. The key is coreutils' `begfield`/`limfield`; `-u` is the first of each run of lines that compare equal, and `-cu` is strict. | LC-23, golden (`r3-sort-*`, `s-sort-uf` no longer differs) |
| LC-24 | sed's `s` flags and the range matcher (4 edits) | `s/x/y/w FILE` was parsed as `s/x/y/` followed by a `w FILE` command that wrote EVERY line; `/four/,3d` (a numeric end that is not after the line the start matched) deleted to the end of the input and `/four/,3c X` printed nothing. | LC-24, golden (`r3-sed-s-w-file`, `r3-sed-range-numeric-end-before-start`) |
| LC-25 | the module's export list | The engine's `ExecutionLimitError` is exported as `LimitError`, so that `du` and `cp -u`, which are written in compat.js, end a script at `maxTraversalEntries` as `find` does (a limit of the script, `how: 'limit'`) and not as a program that failed. `core.js` hands it to `compat.commands`. | LC-25, core |
| LC-26 | the content write of a file redirection (`ys`) and of a descriptor a redirection opened (`lp`) (2 edits) | The content write is `{ encoding, lcRedirect: true }` where the encoding was. The file system could not tell it from `tee`'s or `sort -o`'s own write to the same path (`tee f` and `echo x > f` both end in `writeFile(f, text, 'binary')`), so the overlay kept a path-keyed set of what a redirection had opened, which never emptied: a LATER `tee d/f`, `awk '>'`, `sort -o` to a path a redirection had used and the command had since removed was dropped with status 0. Now a write that is a redirection's never throws (a throw rejects `exec()` and loses the output) and a program's always does, by what the call IS. | LC-26, overlay (same path), core (same path, eight shapes), golden (`r4-*-after-redirect-*`) |
| LC-27 | `cd`'s walk of the components (1 edit) | `..` to the root left `""` and `|| "/"` made it "/", to which the next name was added as `//name`: `cd /w/../w` set PWD to `//w`, which `pwd` printed and the next line was handed as its working directory. | LC-27, core, golden (`r4-cd-dotdot-root`, `r4-realpath-dotdot`) |
| LC-28 | the key specification of `sort -k` (`za`) (1 edit, `__lcKeySpec` in the header) | The letters at the very end of the whole specification were taken as the START's and the ones after the start position were lost: `-k1.1,1b` skipped the blanks in front of the start field (a different order from GNU for lines with a different number of leading blanks). Letters are read where they are written: after the start position (skipsblanks), after the end position (skipeblanks, `ignoreLeadingEnd`). `sort -c` still does not know `-u -r`. | LC-28, golden (`r4-sort-k-*`) |
| LC-29 | printf's format and `%b` (the shared helper `da`), echo -e (`U8`), `$'...'` (3 sites, 13 edits) | `printf '\xff'`, `'\377'`, `echo -e '\xff'` and `$'\xff'` made the character U+00FF, which a file holds as two bytes (`wc -c` said 2 for GNU's 1). A byte of 0x80 or more is the escape of text.js (U+DC80..U+DCFF), a run of them that is UTF-8 is the character (`__lcBytes`: `decodeBytes`), and what a format makes has its escapes joined (`__lcHeal`: `joinEscapes`). Where text becomes bytes (a file, a pipe: `encodeText`, patch LC-10) the escape goes back to the byte; core.js's `decodeBytes` joins what two statements printed in one chunk, for what is shown. | LC-29, text, golden (`r4-printf-*`, `binary-roundtrip`, `u-printf-escapes` now identical) |
| LC-30 | tee's and touch's `catch` (2 edits) | tee said "No such file or directory" for every reason and touch printed the engine's error (`ENOENT: ..., open '/w/d/f'`). Now `tee: d/f: Is a directory`, `touch: cannot touch 'd/f': No such file or directory`. | LC-30, golden (`r4-tee-after-redirect-dir`, `r4-touch-after-redirect-removed`) |
| LC-31 | the simple command's name (`executeSimpleCommandInner`, 2 edits) | The name was expanded as one string (`Be`), so `c="ls -l"; $c` ran a command called "ls -l" and said "command not found" (`$CC file.c`, `$(echo echo hi)`, `${DC} up`). A name that is only expansions is now expanded the way an argument is (`dr`: field splitting by the IFS in force, then globbing) and the words after the first are the command's first arguments; a quoted name (`"$c"`) is one word, as before. | LC-31, golden (`r4-command-word-split`) |

README §9 lists LC-1..LC-4; LC-5..LC-31 are additions (see the report's requests).
`node web/shell/engine/vendor/just-bash/3.6.0/apply-patches.mjs --check` verifies the hash of the file and that every
anchor is there exactly once, and writes nothing (31 patches, 91 edits).

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
   A redirection whose target the command itself takes away (`{ rm -rf d; echo hi; } > d/f`) loses its output without
   a word, as in GNU (the open file was unlinked), and the script goes on. A program's OWN write to a path is its own
   error whatever a redirection did to that path before (`mkdir d; echo a > d/f; rm -rf d; echo b | tee d/f` is
   `tee: d/f: No such file or directory`, status 1; `awk '>'` and `sort -o` are 2, as in GNU).
5. Caps: one file read 4 MiB, 16 MiB read per command; written 1 MiB per file, 8 MiB per command, 2000 files and
   folders (deletions and removed folders count: `rm -rf` of a tree with more than 2000 entries, or one that has more
   than 8000 below it, is refused whole). A file over the read cap is "No such file or directory" in the engine's words;
   the notes say it exists.
6. No background jobs: `cmd &` runs to its end first; `wait` is nothing; `trap`, `jobs`, `kill`, `umask`, `ulimit` are
   not there (not in `help`, not found by `command -v`). Loops are capped at 100000 iterations and 100000 commands,
   recursion at 100, `seq` and `yes` at 100000 lines. A program-level limit (`sed ':a;ba'`, an `awk` loop, a `jq` range)
   fails that program with status 126 and a message that names it; the script goes on and `how` stays `exit`.
7. Regular expressions are RE2: no back-references (`grep -E '(a)\1'`, `sed -E 's/(a)\1/x/'`) and no lookaround
   (`grep -P` is not there). In a basic expression `\+ \? \| \{m,n\} \( \)` work (also `a*\+`, `a\+\?`, ERE `a*+`:
   GNU's "optional run", here `(?:a*)+`), and `\<` `\>` are `\b` (so `\<` before a character that is not a word
   character matches where GNU's does not, and `\>` before one that is: RE2 has no lookaround to say "a word starts
   here"); a `\+`, `\?` or `*` right after `\b \< \>` is a plain character, as in GNU. `grep -w` is `\b(?:...)\b`:
   a match that starts or ends with a character that is not a word character is accepted where GNU's rule (the
   characters around the match are not word characters, and a shorter match at the same place is tried) rejects it
   (`grep -ow '[+]\+'` on `a+b` prints `+`). `sed` has no `\U \L \E \u \l`. `find -regex` matches part of
   the path; `find -perm` takes no symbolic mode; `find -newermt` is not there; `find -printf` does not know `%y` and
   some other letters. `awk` has no `system()`, reads `/dev/stdin` as empty, and formats `%e` and `%05.1f` its own way.
8. Arithmetic is double precision: past 2^53 it rounds; there is no 64-bit wrap-around.
9. Bytes: a file that is not UTF-8 goes through `sed -i`, `tee`, `sort -o`, `cat`, a pipe, `$(...)`, `grep`, `awk`,
   `cut -c`, `tr`, `paste` unchanged (a BOM and a NUL too). `printf '\377'`, `printf '\xff'`, `echo -e '\xff'` and
   `$'\xff'` are that byte (patch LC-29: a file holds one byte, `wc -c` says 1, `od`, `base64`, `sha256sum` agree),
   a run of them that is UTF-8 is the character (`\303\251` is `é`), so a binary file can be made with printf;
   `\NNN` over 255 is its low eight bits. A terminal shows an invalid byte as U+FFFD (`${#x}` of one is 1). `grep` has no "binary file matches": it prints lines. `rev` and `sort` treat an invalid
   byte as one character that sorts above every character below U+DC80. A file NAME that is not valid UTF-8
   (`touch "$(cat latin1)"`, `cat names | xargs touch` over latin-1 names) cannot be sent to the editor: the command's
   whole change set is refused with a note that names it (the byte shown as U+FFFD) and nothing is applied. Half of an
   emoji (`awk 'substr($0,1,1)'`, `cut -c`) is shown as U+FFFD too.
10. The whole script is parsed before any of it runs: a syntax error on line 20 stops line 1 from running.
11. Under `2>&1` the output of a command is in the order of statements (stdout, then stderr), not of writes; what a
    program writes to the path `/dev/stdout` (`tee /dev/stdout`) comes after the statement's own stdout.
    A script, heredocs included, of more than 1,000,000 bytes is "Input too large" (a syntax error, status 2): the
    parser's own limit, which `maxSourceBytes` and `maxHeredocSize` do not reach.
12. `chmod` lasts for the command only (nothing keeps a mode); a file whose first line is a shell shebang is executable
    (`ls -l` shows it, a plain `ls -F` does not mark it).
13. Every string order is by code point (byte order, `LANG=C.UTF-8`): `sort`, `sort -V`, `ls`, globs, `find`, `tree`,
    jq's `sort` `unique` `group_by` `min` `max` and object keys; the visitor's language is never asked. `sort -u`
    keeps the first of each run of lines that compare equal (`-k`, `-n`, `-f` decide what equal is), as GNU does; a key
    without an end (`sort -k2`) runs to the end of the line. `$USER`, `$SHELL`, `$COLUMNS` are empty; `whoami` is `user`,
    `id` is 1000, `hostname` is `localhost`, `uname` says Linux x86_64.
14. Time: local time is UTC, or the zone of a `TZ` the command was GIVEN: a prefix assignment (`TZ=Asia/Tokyo date`) or
    an exported variable (`export TZ=...`, a `TZ` the session carries), not a variable that was only assigned
    (`TZ=Asia/Tokyo; date` is UTC, as in GNU). It is the name of a zone file (also `:America/New_York`, `UTC`, `GMT0`,
    `Etc/GMT+5`) WRITTEN IN THE CASE THE FILE HAS (`TZ=asia/tokyo` is no zone: UTC with the name `asia`, as in GNU), or
    POSIX `NAME+-hh[:mm[:ss]]` with the sign of POSIX (hours WEST: `JST-9` is UTC+9, `UTC+3` is UTC-3). A daylight rule
    after it (`EST5EDT,M3.2.0,M11.1.0`) is not applied: standard time all year (the name `EST5EDT` alone is the zone
    and has its rules). Anything else is what glibc makes of it: its leading letters (three or more) are the name and
    the offset is 0 (`TZ=Nowhere` prints `Nowhere`, `ab` prints nothing). `date -d` (also `@N`, `Feb 29 2020 12:00`,
    `... +0100`), `printf '%(fmt)T'`, `touch -d/-t`, `stat -c %y`, `ls -l`, `find -newer` all use it; `date -u -d WALL`
    reads WALL in UTC. `%Z` is tzdata's short name (`JST`, `EDT`, `CEST`, `IST`, `GMT`, `AKDT`, `SST`) from
    `zone-data.js` for every zone file that has letters, by the offset it has at that instant (and by the time, for the
    18 zones that kept an offset and renamed it: Chihuahua MDT until 2022-10-30, CST since); its digits for the rest
    (`+04`, `-03`, `+0545`); `%z` has no seconds (a POSIX `XXX-9:30:15` prints `+0930`).
    `date -I`, `-Idate`, `-Ihours`, `-Iminutes`, `-Iseconds`, `-Ins`, `--iso-8601[=...]` print what GNU does. What `date -d`
    does not read: relative forms (`+1 day`, `2 weeks ago`, `next friday`, `last month`), `1 Jan 2020 3pm`,
    `20200229 1200`, a fractional `@1600000000.5`. `ls -l` shows a year for files older than 180 days (GNU: six months).
    A wall-clock time that does not exist (the hour a clock skips) is read an hour later; GNU says "invalid date".
15. Missing options that GNU has: `wc -L`, `cut --output-delimiter`, `cut -b`, `cut --complement`, `uniq -f`, `tail -f`,
    `tail -z`, `diff -r -w`, `grep -b -z`, `sed -s -z`, `sed q5` and `Q5` (an exit status), `ls -s -X`, `sort -z`, `rm -d`,
    `find -newermt`, `nl` (a line that is not numbered is padded with the separator, GNU's is spaces), `file` (its own
    words), `rm -v` of a tree lists the folder only. Work: `head -c 1K`, `-n -N`, `head -z`, `tail -c +N`, `tail -n -N`,
    `cp -a -u -T`, `mv -u -T`, `mkdir -m -pv`, `sed -i.bak`, `sed '$a\'`, `sed s///w FILE`, `xargs -L -l -I -i -E -a -d -0 -n -s -x -t -r`,
    `stat -c %Y %y`, `touch -t -d @N -r REF` (`-r` with `-d` takes the string, `-t` with `-r` or `-d` is "cannot specify
    times from more than one source"), `date -r`, `awk -f`, `awk '{print length}'`, `grep -o '[0-9]\+'`, `grep -H`,
    `grep --include GLOB` (the value apart), `sort -nk2 -k2 -u`, `du -s FILE -h -k -m -b -a -c -d N`, `ls -p --color=auto`,
    `cp -rv` (lists every file, in name order: GNU's is the file system's; a source and where it went are named as
    typed: `'d/sub' -> './sub'`, `'d/' -> 'ws/a b/d'`), `cp -rn` (merges what is missing into a folder that is there, as
    GNU does), `tail --lines=+N` and `head --lines N` (the long forms, joined or apart), `sort -k1.1,1b` (a `b` after
    the end position is the end's), `sort -k0` (invalid key, status 2) and `sort -o nodir/x` (`sort: open failed: ...`,
    status 2).
16. `cp -i`, `mv -i`, `rm -i`, `rm -I` are "invalid option", status 1, and nothing is overwritten or removed (this note
    used to say they ask nothing and say so: they never did). GNU asks on standard error, reads the answer from
    standard input, and with none answers no and exits 0 (`cp: overwrite 'g'? ` with nothing after it).
17. `mv` and `cp -r` of a directory: onto a directory that has something in it is "Directory not empty" (mv) or a merge
    (cp), onto a file is "cannot overwrite non-directory", and a file onto a directory is "cannot overwrite directory",
    with nothing changed, as in GNU; `mv` keeps the file's modification time and mode; `cp -r a a/b` is "cannot copy a
    directory into itself" and copies nothing (GNU copies part of it, in an order that no file system fixes). A
    directory onto a name that ends in a slash and is not there (`cp -r d d2/`, `mv d d2/`) makes it; a file onto one is
    "Not a directory"; a file on the way to a destination is "failed to access" (and comes before anything about the
    sources; `cp -f` and `mv -T` say "cannot stat"); a source that ends in a slash and is a file is "cannot stat"
    (`mv -n` with a destination that is there says nothing); `mv a a` is "are the same file" (`-n` makes it nothing);
    `-T` makes the destination the target itself (`cp -rT d e` merges, `mv -T d e` renames onto an empty folder). More
    than one source needs a folder ("target 'x/' is not a directory", counted on the operands as typed); a folder is
    never renamed through its `.` or `..` (`mv d/. x/` is "Device or resource busy", "are the same file", or what
    is wrong with the destination, and nothing changes); `cp d x` with no `-r` omits the folder whatever x is.
    A source that is named again with the folder as destination (`cp f ./f e`, `cp -r d d/ e`) is
    `cp: warning: source file 'F' specified more than once` (`source directory` for a folder), the second is not copied,
    and the status is that of the rest (a folder that is the same file comes first: "are the same file"). The 1,778
    command lines of `shell-engine-cpmv.test.js` pin this class against GNU, by status, listing, contents and
    message: 24 of them differ, listed with a reason (a folder copied into itself: GNU copies part of it in the order
    of the file system; `mv -T d e/..`; the order of two messages of `mv -u`; `cp -rv ./f x/`).
18. A symbolic link or a hard link cannot be made (`ln` says so in its own words, status 1). `ls -l` shows `user user`, directories 4096, and a `total` line as a file system
    with 4 KiB blocks has it. `du` counts 4 KiB blocks too: a file of 2 bytes is 4, an empty file 0, a directory 4.
19. `sed 'c'` on a range prints its text once at the end of the range; `a\`, `i\`, `c\` with no text add nothing, and
    `$a\` adds the missing final newline. A `:label` ends at `;`, so `sed ':a;N;$!ba;s/\n/ /g;$a\END'` is five
    commands; `-f script` files get the one-line `a\TEXT` form too (up to 64 KiB). `s/x/y/w FILE` writes only the
    lines it changed. A range whose numeric end is not after the line its start matched (`/four/,3`) is one line.
20. `xargs` is GNU's, run by this shell: blanks and newlines separate items, `'..'` `".."` and `\` quote, `-I` takes a
    LINE (leading blanks dropped), `-L N` takes N lines (a trailing blank continues one), `-E EOF`, `-a FILE`, `-d`, `-0`,
    `-n`, `-s`, `-x`; `-P` is accepted and does nothing, commands run one after another. A command line is built by
    SIZE as GNU's is (`-s`, default 128 KiB: the command, its arguments and every item counted in UTF-8 bytes with the
    NUL that ends each), so 16000 paths are 9 runs, as in GNU; an item that cannot fit is "argument line too long"
    (what was read before it runs first; with `-x` and `-n`, with `-L` (which implies it) and with `-I` a batch that
    was still being filled is NOT run, a full one is), `-x` with `-n`, `-L` or `-I` makes a list that is too long
    "argument list too long"; `-s 0` is GNU's error. With `-I` the words are put in one at a time as GNU does: the
    command word that does not fit by itself is "cannot fit single argument within argument list size limit", a word
    that does not fit after the others and reaches the limit by itself is "command too long", and one that only the
    sum overflows is "argument list too long"; a line after the first is measured against the limit less the command
    word. `shell-engine-xargs.test.js` holds 10,272 recorded command lines of this (-s 1..30 against one to three
    items, thirteen commands, -n/-L/-x, and a quote that is never closed) and replays the first, the middle and the last
    size of each run of sizes that did the same (3,692 lines): there is no known difference in it. A batch never holds more than the
    shell accepts as arguments of one command (`maxArrayElements`, 100000: only a `-s` over 200000 reaches it). The
    arguments reach the command as a LIST, never through the parser: no quoting, and no 1,000,000-byte cap. With no
    input the command runs once (not with `-r`, never with `-I`). Status: 0, 123 when a command exited 1-125 (also when
    the reading stopped: that alone is 1), 124 and a stop when one exited 255, 126/127 and a stop when the command
    cannot be run. `-t` writes the command line to standard error. An unmatched quote runs the items complete before it
    (not the word it sits in; with `-L` and `-I` a line is run whole or not at all) and then says so. `-p`,
    `--interactive` and `-o` FAIL CLOSED, as GNU does with no terminal: `xargs: failed to open /dev/tty for reading`
    (status 1) or `xargs: '/dev/tty': No such device or address` (125), and nothing runs. `-I ''` is "command too long".
    An option that needs a value and has none is getopt's error (`xargs: option requires an argument -- 'n'`, with
    `--max-args` `option '--max-args' requires an argument`), for every wrapper (`touch -r`, `cp -t`, `du -d`, `sort -k`,
    `awk -f` ...: `OPTION_VALUES`).
21. What the script exported reaches the commands that run commands (`xargs`, `timeout`, `find -exec`, `env`); `env -i`
    empties it; a variable that was only assigned does not.
22. The working directory is a canonical path: `cd /w/../w/./src` is `/w/src` for `pwd`, `$PWD`, `$OLDPWD`, `cd -`,
    `realpath`, and what the host is handed (`done.cwd`: a script's own `PWD=/a/../b` is canonical too). A script that
    ends in a directory whose name is not UTF-8 (its changes are refused) leaves the session in the nearest directory
    above it that has a name, and says so.
23. `touch` and `tee` say why in GNU's words; `sort -o` that cannot be written is `sort: open failed: F: reason`, 2.
24. A command word that is only expansions is split like an argument is (`c="ls -l"; $c`, `$(echo echo hi)`, `${DC} up`,
    by the IFS in force, then globbed); `"$c"` is one word, and `FOO=1 env` in a variable is a command named `FOO=1`
    (bash: "command not found"), as in bash.

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
  session's `/tmp` with it; the host is told how many files that is (`stats.tmpFiles`) and says so. `tmpFiles` counts
  files only: a session that made a folder of `/tmp` and nothing in it has `tmpFiles` 0 and `tmpEntries` 1 (files and
  folders; likewise `homeEntries`), which is the number to ask "is there anything to lose".
* A change set cannot say "this path was a folder and is a file now" (or the reverse): writes are applied before
  deletions on purpose (`mv a b` writes b and then removes a, so a failure leaves both). Such a run is withheld as
  `incomplete` with the reason, and the next command can do it in two steps. The consistency suite counts these.
* A case-only rename (`mv a.txt A.txt`) on a disk that ignores case is a write and a delete of "the same" file; only
  commit.js's case-fold check defends against it (the engine does not know what kind of disk it is on).
* `sed -n 'w nodir/f'` does not report the missing folder (the engine swallows the failed write of `w`).
* Functions, aliases and options do not persist; `expandAliases` makes a session's aliases work as variables only.
* A redirection writes to the PATH when it ends, not to an open descriptor (the overlay has none): `{ rm -rf d; echo hi;
  } > d/f` drops the output as GNU does, but `{ rm f; echo X > f; echo hi; } > f` ends with `hi` in f (GNU: X) and
  `{ rm -rf d; mkdir d; echo hi; } > d/f` makes d/f (GNU: no d/f). The content write of a redirection is marked as such
  (LC-26) and is dropped silently when the command took its parent away; a program that writes with no redirection
  (`touch`, `tee`, `sort -o`, `awk '>'`) gets the errno of a real file system and reports it, whatever a redirection
  did to the same path before.
* Regular expressions are RE2 (grep and sed): there is no lookaround, so `\<` and `\>` are `\b` (`\<` before a
  character that is not a word character matches where GNU's does not) and `grep -w` is `\b(?:...)\b` (a match that
  starts or ends with a character that is not a word character is accepted where GNU's rule would retry a shorter
  one: `grep -ow '[+]\+'` on `a+b`). Back-references in a pattern other than sed's replacement are not there.
  `sort -c` does not know `-u -r`. `sed` has no `\U \L \E \u \l`.
* Time zones: a zone is the name of a file of tzdata 2024a in its own case (`zone-data.js`, 596 names, generated by
  `web/test/fixtures/shell/zones/generate.mjs`), and the engine's Intl says what a zone's rules are (so the names Intl
  does not know are UTC). A POSIX TZ with a daylight rule (`EST5EDT,M3.2.0,M11.1.0`) is standard time all year.
  `%Z` is exact for 2010-2030 (the table was recorded at four instants); before that a zone that renamed an offset
  (Chihuahua's MDT until 2022) is named by its newer name. A year before 100 is not read.
* `cp` and `mv`: 24 of the 1,778 command lines of the matrix differ from GNU, each listed with its reason in
  `shell-engine-cpmv.test.js` (a folder copied into itself: GNU copies what the file system listed before the
  destination, in its own order, and then says it cannot; `mv -T d e/..`: busy against not empty; the order of two
  messages of `mv -u`; `cp -rv ./f x/` where x is not there: GNU names the copy it could not make). A folder that is
  copied into a folder that it contains is refused here, whole. `cp`/`mv`/`rm -i` (GNU asks on standard error and reads
  the answer from standard input: with none it answers no and exits 0) and `cp -b -l -s` are "invalid option", status 1
  here: nothing is overwritten or removed, so it fails closed, but a script that carries `rm -i` or `cp -i` stops.
* `xargs`: `--show-limits`, `--process-slot-var` and `--max-procs` are accepted and ignored (commands run one after
  another); `-p` and `-o` fail closed (no terminal); a command that is a shell FUNCTION is not found (GNU's would not
  find it either). `-s` is bounded by the 2 MiB less the exported environment less 2048 bytes (GNU's formula, which
  the engine counts as `NAME=value` plus its NUL; GNU's own count of the environment is not byte-exact against it), and
  a batch is at most 100,000 words (the shell's own limit; GNU has none).
* The reads of local time the vendored file makes, checked for this version: `Intl.DateTimeFormat` is called by
  strftime's wall clock (`X8`) and `%Z` (`J8`) (both patched, LC-19), by `%z` (`Y8`: with no zone it asks the shell's
  `Date`, with one it formats that), by `date -d` with an explicit zone (`yC`, `wC`: the command's) and by `gC` (only
  "is this a zone", unused since LC-20); `toLocale*` is not called at all; `getTimezoneOffset` is called only by `Y8`;
  every `new Date(` and `Date.now()` is the module's `LcDate` (the header's `const Date`); jq's date functions
  (`gmtime`, `mktime`, `strftime`, `todate`) are UTC only in 3.6.0 (`localtime` and `strflocaltime` are not there).
* Anything in the golden table's 77 entries (736 cases; the table is the authority and may only shrink).
* The fuzz run is 3000 scripts of one seed in UTC and 800 in each of two other zones (about 9 s). It proves no crash, no
  stack in the output, no hang past two seconds under tightened limits; it does not prove the output is right (the
  golden suite does, for 736 cases, the cp/mv matrix for 1,652 command lines, the xargs matrix for 10,272, and the
  consistency suite does for the change set of 300 nested scripts).
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
| `done` | `denied` | `[{ path, op, reason, code, message }]`: every write the shell refused (policy or cap). Never an exception. An ordinary failure of a write (no such folder, a directory) is not here: it is an error of the command and its status. `path` and `message` are shown text: a byte that is not UTF-8 in a name is U+FFFD. |
| `done` | `notes` | Sentences for the model: a relocated folder, a working directory that was not one, a read that was refused although the file exists, a write refused by policy, why nothing was applied (`None of its file changes were applied: ...`, for a refused write, an unrepresentable set, and for a limit, a deadline, a stop or an error when something had been staged). |
| `done` | `stats` | `filesRead bytesRead probes statCalls readCalls listCalls stagedBytes stagedEntries memoryBytesAtStart durationMs changes discarded withheld mounts tmpFiles homeFiles tmpEntries homeEntries`. `withheld` is `null`, `'denied'` or `'incomplete'`; `discarded` is how many changes were not applied; `tmpFiles` and `homeFiles` are the FILES in `/tmp` and `/home/user` at the end of a `keepTmp` run, `tmpEntries` and `homeEntries` the files and the folders in them (0 for a run that keeps nothing; the entries are the number to ask "is there anything a terminated worker would lose": a folder of `/tmp` with nothing in it counts). |
| `done` | `cwd` | The working directory the session is in, a canonical host path (`.` and `..` resolved, no `//`). When the script ended in a folder whose name is not valid UTF-8 (the editor cannot address it) it is the nearest folder above it that has a name, and `notes` says so (`The directory X has a name that is not valid UTF-8, which the editor cannot address; the session stays in Y.`). |
| `done` | `env` | The variables to carry to the next line. The keys are names; a VALUE may hold the escapes U+DC80..U+DCFF of bytes that are not UTF-8 (they are carried back unchanged, which is how a variable that holds a byte comes back as it was): nothing displays a value without `displayText`. |

What the engine promises, and where each promise stops (each was claimed more broadly once and the third round's check
found the exception):

* **A redirection does not reject exec().** The content write at the end of a redirection (marked `{ lcRedirect: true }`
  by LC-26: the overlay tells it from a program's own write by that mark, not by the path it names) never throws: a
  refusal by the shell is `denied`, and a path the redirection wrote that the command then removed or replaced is
  dropped without a word. The writes that are a program's own (`touch`, `tee`, `sort -o`, `split`, `awk '>'`, `cp`,
  `mv`) throw the errno of a real file system into the PROGRAM, and each of those reports it as its own error line
  (pinned program by program), however many redirections wrote to the same path before; the OPENING of a redirection
  is `bash: f: <reason>`, status 1, the command not run (LC-5). Anything that nobody catches ends the run as
  `how: 'error'` with one line, and `run` itself never rejects.
* **The visitor's zone is never asked** by anything this module reaches (the list of sites is in §5). It is UTC or the
  zone of the TZ the command was given; a name the browser's ICU does not know is UTC.
* **No lone surrogate is in what is SHOWN**: stdout and stderr (every statement and the tail), the `bash: PATH: ...`
  line, `denied[].path` and `.message`, `notes`, `done.cwd`, the keys of `done.env` and every string of `done.stats`;
  and none is in a change path (a set with such a name is refused whole). The exceptions are the values of `done.env`
  (carried to the next line unchanged, so that a variable that holds bytes that are not UTF-8 comes back as it was:
  they may hold U+DC80..U+DCFF) and the bytes of `changes[].after/before`, which are bytes. Escapes that are UTF-8
  together are the character wherever they are made or shown (`printf '\303\251'` is `é`, in a variable, a file name,
  `done.cwd`).

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

* `engine.worker.js`: 1,415,401 bytes raw, 407,869 gzip (level 9), 326,553 brotli (level 11), measured on this
  checkout with `node web/shell/engine/build.mjs --out <dir> --vscode <Code-OSS checkout>` (esbuild, minified, es2022; it
  prints the three numbers; patched just-bash sha256 `16121431664e...`; `scripts/build-web.mjs` prints the same three).
  Building twice gives the same bytes (`cmp`).
  The earlier figures in the notes of the rounds (1,374,439; 1,395,093) were of other checkouts and are not comparable:
  this is the one number. Of it, just-bash is about 1.27 MB; the `buffer` package (+ base64-js, ieee754) is 50 KB;
  `text.js`, `zone.js`, `zone-data.js` (596 zone names and 69 groups of letters: 13.7 KB, 5.5 KB gzip) and compat.js
  (`xargs`, `du`, `preflight`, `transferEach`, the table of options that need a value) are the rest.
* In node, in-process, with a host that answers at once: loading and patching 45 ms; `init` 2 ms; `echo hi` 7 ms
  (a fresh `Bash` and its 82 stubs); a 2000-iteration loop 12 ms; `seq 1 20000 | sort -n | uniq | wc -l` 13 ms;
  `grep -rc` over 1000 files 18 ms (1000 reads, 1020 stats); `find` over the same 7 ms (21 listings).
* Memory is released after a run unless `keepTmp`; one run holds at most the caps (16 MiB read, 8 MiB staged) plus the
  engine's own `maxLiveBytes` (64 MiB).

## 8. Tests

| File | Tests | What |
| --- | --- | --- |
| `shell-engine-patches.test.js` | 56 | the vendored file (size, sha256, integrity), imports, anchors counted independently of the script, the patched hash, `--check`, refusal of a wrong file, each patch's behaviour (LC-1 .. LC-31; LC-19 and LC-20 under three process zones; LC-29 in every place that makes an escape; LC-31 against bash's own answers) |
| `shell-engine-overlay.test.js` | 65 | mounts and relocation (both directions of overlap, `/proc`, a folder at `/mnt`), layout, caps before reads and their boundaries, notes and their cap, denied and its de-duplication, writes that are refused by the shell and writes a file system would refuse, the content write of a redirection after its opening, tombstones, opaque folders, staged files below a removed or moved folder, net change set and its order, a name with a lone surrogate, memory areas and their byte accounting, identity, devices, bytes that are not UTF-8, a base that fails |
| `shell-engine-core.test.js` | 58 | handshake, program list pinned by name, streaming, decoding, limits table (every number), limit/deadline/abort/error classification and wording, exit-path flushes, never rejects, seven redirections whose target the command removes, late answers, env/cwd round trip, `/tmp`, relocation, change-set hand-over, caps from the host, `init.commands`, `tmpFiles` and `tmpEntries`, the zone of the process, names that are not UTF-8 (and bytes that are UTF-8: `dé` made with printf), a working directory that is canonical, `du` and `cp -u` at the traversal limit (the limit exactly, and one over), the stand-in engine contract |
| `shell-engine-compat.test.js` | 53 | every normaliser case by case (including what is NOT dropped), wrappers through the engine, `od`, `cmp`, `du`, the sed scanner and its `-f` files, `cp`/`mv` onto `name/`, same file, `-T`, `-rv`, `mkdir -pv`, `touch -r -d -t`, `head`/`tail` long forms, `sort -k`, `xargs` (options, input, batches by size, `-s`, status codes, `-p`/`-o`, the quote), the sweep of every option that needs a value, the exported lists pinned; run under three process zones |
| `shell-engine-cpmv.test.js` | 4 | 1,778 `cp`/`mv` command lines (every source shape against every destination shape, a seeded sample of the options, and the same file and the repeated source under `-u`/`-n`) against GNU coreutils 8.32, compared on status, what -v printed, the listing, what each changed file holds and what was said; 24 listed with a reason, the list may only shrink (`web/test/fixtures/shell/cpmv/`, recorded once) |
| `shell-engine-xargs.test.js` | 2 | 412 groups, 10,272 `xargs` command lines recorded from GNU findutils 4.8.0: `-s 1..30` against one to three items with `-I` and thirteen commands, `-n`, `-L`, `-x`, and a quote that is never closed; the first, middle and last size of each run of equal behaviour (3,692 lines) are replayed and every one is GNU's (`web/test/fixtures/shell/xargs/`, recorded once) |
| `shell-engine-golden.test.js` | 4 | 737 cases against GNU bash 5.1.16 / coreutils 8.32 (docker, recorded once): 660 identical, 77 listed with a reason and the differing fields, the list may only shrink; run under three process zones |
| `shell-engine-consistency.test.js` | 4 | 300 seeded random nested scripts: the change set, applied by the real `src/commit.js` over a map with a delete that takes a file or an EMPTY folder, leaves the tree GNU left (`web/test/fixtures/shell/consistency/`, recorded once) |
| `shell-engine-fuzz.test.js` | 3 | 3000 mutated and token-soup scripts in UTC, 800 in each of two other zones (`FUZZ_DUMP=file` writes failures) |
| `shell-engine-text.test.js` | 9 | the byte/text codec: every invalid form, a property test, a 4 MiB input, what is shown (every lone surrogate, a pair left alone), the escapes that are UTF-8 together (and a pair whose low half looks like one) |
| `shell-engine-zone.test.js` | 11 | zones (case of the name, tzdata's 596 names at four instants against the recording of `zones/zones.json`), offsets across a daylight saving change, the Date class, strings with and without a zone, the forms a TZ may take (`%Z`, `%z` with seconds); each under five process zones |
| `shell-engine-build.test.js` | 8 | the build's checks on synthetic input and the command line (`--out` as a directory and as a file, `--minify`, bad arguments); when a Code-OSS checkout whose esbuild runs is found (`LEVELCODE_VSCODE`, `REPO/vscode`, `REPO/../../../vscode`): the real build, its contents, a run in a worker-like `vm`, and `web/shell/build.mjs` end to end. Without one it says so in a line that starts `!! SKIPPED`; `LEVELCODE_REQUIRE_BUILD=1` makes that a failure |

`node web/test/unit/shell-engine-<name>.test.js`; no dependencies, no network, `TZ` is set by the tests that read local
time. All of them pass on Node 24 and Node 18 (`docker run --rm --network none -v $PWD:/repo:ro -w /repo
catthehacker/ubuntu:act-latest node web/test/unit/shell-engine-core.test.js`; Node 18 has no global `crypto`, which
`load.mjs` and the overlay test supply).

The golden file is regenerated with `node web/test/fixtures/shell/golden/generate.mjs` (docker, the image above already
pulled, `--network none`, every case run twice; a case whose output differs between the runs is left out and named in
`meta.flaky`). Review the diff: a changed expected output is a new GNU, not a regression. New cases go in
`golden/cases/round4.mjs` (or `round3.mjs`, `round2.mjs`, `extra.mjs`); give a case that needs a time an explicit
`touch -d '@N'`. A byte that is not UTF-8 can be made with printf now (`printf '\xff'` is one byte), or with `base64 -d`.
A case that depends on the locale or the order of a directory in GNU (a copy of a directory into itself, `grep` of a
latin-1 file, `rev`) is not a good case. The size of `golden.json` is bounded (400 KiB; it is 329 KB for 737 cases): the
checkpoint had raised the bound to 480 KiB for a file of 406 KB, because the `gone` of a case that ran on a bare
workspace listed the fixture's 18 paths, which it never had (376 cases, 117 KB); only a case that runs on the fixture
can remove them, and records them now.
The other recordings: `node web/test/fixtures/shell/consistency/generate.mjs`, `.../cpmv/generate.mjs` (the cases are
`cases.mjs`; the fixture sets the times of its files, because `-u` compares them and files made in one breath have times
that the clock of the machine decides), `.../xargs/generate.mjs` and `.../zones/generate.mjs` (docker, `--network none`,
every case twice).

Every behaviour above was mutation-checked on a copy of the tree: a one-line defect put back (a cap not applied, a
tombstone dropped, a normaliser branch removed, a regex alternative removed, a patch edit removed with its pins
updated so a behaviour test decides, the write-withhold rule removed, ...), the suites run, and each had to go red.
A suite that stays green under a mutation is missing a test, not the mutation a reason. The ones that stayed green are
equivalent (`env.PWD = cwd` which the engine sets as well, the second `doneSent` guard that nothing reaches,
`pending.clear()` which only frees memory) and are listed in the report of the round that found them. The third round
ran 117 such edits (every edit of LC-16 and LC-19..LC-25 removed one at a time, the header's helpers, every branch of
`preflight`, `xargs`, `verboseTree`, `tail`, `touch -r`, the `-f` rewrite, `du`'s bound, the overlay's opened set, the
three `displayText` calls, `text.js`, `zone.js`) on a copy of the tree, each with the suites that could see it; 115 went
red. The two that stayed green are equivalent: an opened path whose content write is refused by POLICY (reordering that
check changes nothing, because a path whose opening was accepted cannot become a policy refusal), and the size check
in front of the wrapper's read of a `sed -f` file (the rewriter has the same bound itself). Three more are
equivalent by construction and stay in the table of patches for the invariant "no `localeCompare` left": the order the
shared walk visits a directory in (only `cp -r`, `mv` and `chmod -R` use it, and none of them prints), the order of
`tree`'s fallback for a file system without `readdirWithFileTypes` (the overlay has it), and `$SHELLOPTS` (every name in
it is lowercase ASCII, which every collation orders the same).

The fix round after the fourth verification ran 137 such edits, every NEW fix of the round one at a time on a copy of
`web/`, each with the suites that could see it: `-s` and `-I` accounting, the partial batch under `-x`/`-L`, the guard
table, `touch -r -d`, `preflight`, `transferEach`, the repeated source, `mkdir -pv`, `sort -k`, the canonical working
directory, the zones, `tmpEntries`, and the edits of LC-22 and LC-26..LC-31. 21 stayed green the first time, and each
was a missing test, not an equivalent: the cp/mv matrix compared names and not what a file held (a copy that
overwrote was green); `-u`, `-n` and a repeated source were reached only by the seed; the join of escapes in what is
shown, a pair whose low half looks like an escape, `%b`, `echo -e '\c'` and `$'\NNN'` had no test of their own; the
cases of `-I` at a size that is the size of its item were not pinned. Tests were added (the xargs matrix found two
more differences from GNU: the partial batch under `-x`, and a line measured against the command's size) and all of
them are red now. A harness defect was fixed on the way: a mutant of `apply-patches.mjs` itself must re-derive the
pins of `VENDOR.json`, or every such mutant is "killed" by the hash check. Four mutants have no anchor any more
because the code was DEAD, which was shown by making each branch throw and running every suite (never reached) and
then deleting it: `mkdir -pv`'s skip of `.` and `..` (the exists/planned check says the same), the same-file and
gone-source checks inside the per-file copy (preflight and the loop say them first), and xargs's retired
"nothing to read" branch (the plan says it). Two stay green and are equivalent as far as anything was found: the
`ArithmeticExpansion` alternative of LC-31's name test (a number has no blank and no glob character, so splitting it
changes nothing), and the `quoted` flag that LC-31 passes along for the extra words of a split name (the same flag
`dr` gives for an argument; 38 builtins were run with it forced to true and none answered differently).
