// What the engine lacks that a model (or a person) types out of habit, without forking the engine.
//
//   * argument normalisers: pure functions from the arguments GNU accepts to the arguments the engine accepts
//   * wrappers: a custom command with a built-in's name that normalises and hands over through ctx.origCommand
//   * commands the engine does not have at all, or has wrong: realpath uname id nproc cmp od, and du and xargs, which
//     are written here whole (du prints a 4 KiB-block file system's numbers; xargs reads its input as GNU does and
//     starts the commands itself through ctx.exec)
//
// The normalisers are plain data in, plain data out, so they are tested without the engine
// (web/test/unit/shell-engine-compat.test.js). The golden differential runs the commands against GNU.
//
// Two rules decide what is dropped silently and what is not:
//   * an option may be dropped when ignoring it cannot change the result of a command in this shell: -f, -L, -P, -H,
//     -x on cp (nothing is read-only, nothing is a link), --color on grep, -s on grep (no file is unreadable by
//     permission), -m on mkdir (the mode is applied as a per-run chmod)
//   * an option that asks a QUESTION (-i, -I) or keeps a COPY (-b) is not dropped: ignoring it would delete or
//     overwrite what a real shell would have kept. It stays, the engine rejects it, and nothing is done.
//
// What is NOT done here, on purpose: a program that does not exist is not stubbed. A stub is a file in /usr/bin, and
// `command -v tar`, `which tar` and Tab completion would then say it is there. The engine's own "not found" path
// answers `bash: tar: command not found` (exit 127) after patch LC-7, and that is the honest answer.
'use strict';
// @ts-check

const zone = require('./zone.js');
const { decodeBytes } = require('./text.js');

/** just-bash commands that are not offered: they need node:zlib / a DOM, neither of which a worker has. */
const EXCLUDED = ['gzip', 'gunzip', 'zcat', 'html-to-markdown'];

/** What a model is likely to try that does not exist. Every one answers `bash: X: command not found`, exit 127. */
const LIKELY_MISSING = [
	'git', 'npm', 'npx', 'yarn', 'pnpm', 'node', 'deno', 'bun', 'python', 'python3', 'pip', 'pip3', 'ruby', 'perl', 'php', 'java', 'go',
	'cargo', 'rustc', 'make', 'cmake', 'gcc', 'cc', 'curl', 'wget', 'ssh', 'scp', 'rsync', 'tar', 'zip', 'unzip', 'gzip', 'gunzip', 'zcat',
	'xz', 'bzip2', 'patch', 'less', 'more', 'vi', 'vim', 'nano', 'sudo', 'su', 'ps', 'top', 'docker', 'yq', 'xan', 'sqlite3', 'js-exec',
	'html-to-markdown', 'bc', 'shuf', 'tsort', 'iconv', 'dd', 'install', 'truncate', 'sha512sum', 'shasum', 'cksum', 'hexdump', 'xxd',
];

/**
 * Shell builtins the engine knows by name and does not implement: `command -v trap` finds them, running one is
 * `bash: trap: command not found`, exit 127. A script that sets a trap, kills a job or sets a umask goes on without.
 */
const UNIMPLEMENTED_BUILTINS = ['bg', 'caller', 'disown', 'enable', 'fc', 'fg', 'jobs', 'kill', 'suspend', 'times', 'trap', 'ulimit', 'umask'];

/* ------------------------------------------------------------------------------------------------------------ */
/* argument normalisers                                                                                          */
/* ------------------------------------------------------------------------------------------------------------ */

/**
 * xargs for the ENGINE's xargs: the arguments it takes, from GNU's. This is what the `xargs` command hands over when
 * it cannot start commands itself (no `ctx.exec`) or meets an option `parseXargs` does not know; the command proper
 * is `parseXargs` + `xargsInput` + `xargsBatches` below. The engine takes `-I REPLACE`, `-n NUM`, `-P NUM`, `-d DELIM`,
 * `-0`, `-t`, `-r` (each value as a separate argument, one option per argument). GNU also takes the value attached
 * (`-I{}`, `-n1`, `-P4`), clusters (`-0r`, `-rn1`), `-i`, `-L`, `-s`, `-E`, and the long spellings. `-P`, `-s`, `-E`,
 * `-x` are accepted and dropped. `-L N` becomes `-n N`, which is WRONG for a line of several words: that is why the
 * command runs xargs itself.
 *
 * @param {string[]} args
 * @returns {string[]}
 */
function normaliseXargs(args) {
	const out = [];
	let i = 0;
	for (; i < args.length; i++) {
		const a = args[i];
		if (a === '--') { out.push(...args.slice(i)); return out; }
		if (a === '-' || !a.startsWith('-')) { break; }
		if (a.startsWith('--')) {
			const eq = a.indexOf('=');
			const name = eq < 0 ? a : a.slice(0, eq);
			const attached = eq < 0 ? null : a.slice(eq + 1);
			const value = () => (attached !== null ? attached : args[++i]);
			switch (name) {
				case '--null': out.push('-0'); break;
				case '--verbose': out.push('-t'); break;
				case '--no-run-if-empty': out.push('-r'); break;
				case '--replace': out.push('-I', attached !== null && attached !== '' ? attached : '{}'); break;
				case '--max-args': case '--max-lines': out.push('-n', String(value())); break;
				case '--delimiter': out.push('-d', String(value())); break;
				case '--max-procs': case '--max-chars': value(); break;
				case '--exit': case '--eof': case '--open-tty': break;
				default: out.push(a);
			}
			continue;
		}
		// a cluster of short options; the first option that takes a value takes the rest of the cluster
		let consumed = false;
		for (let c = 1; c < a.length && !consumed; c++) {
			const ch = a[c];
			const rest = a.slice(c + 1);
			const value = () => { consumed = true; return rest !== '' ? rest : args[++i]; };
			switch (ch) {
				case '0': out.push('-0'); break;
				case 'r': out.push('-r'); break;
				case 't': out.push('-t'); break;
				case 'x': break;
				case 'I': out.push('-I', String(value())); break;
				case 'i': consumed = true; out.push('-I', rest !== '' ? rest : '{}'); break;
				case 'n': out.push('-n', String(value())); break;
				case 'L': out.push('-n', String(value())); break;
				case 'l': consumed = true; out.push('-n', rest !== '' ? rest : '1'); break;
				case 'd': out.push('-d', String(value())); break;
				case 'P': case 's': case 'E': value(); break;
				case 'e': consumed = true; break;
				default: out.push('-' + ch);
			}
		}
	}
	out.push(...args.slice(i));
	return out;
}

/** Index of the first argument that is not an option of the (normalised) xargs line: where the command starts. */
function firstOperand(n) {
	const withValue = new Set(['-I', '-n', '-d']);
	let i = 0;
	for (; i < n.length; i++) {
		if (n[i] === '--') { return i + 1; }
		if (!n[i].startsWith('-') || n[i] === '-') { return i; }
		if (withValue.has(n[i])) { i++; }
	}
	return i;
}

/**
 * xargs, the part that is parsing: GNU's options. The engine's xargs splits its input on any white space, takes no
 * `-L`, `-E` or `-a`, and gives `-I` one invocation per WORD (`ls | xargs -I{} echo file:{}` split `f s.txt`), so this
 * file runs xargs itself and hands the engine only the commands it starts.
 *
 * @param {string[]} args
 * @returns {{ opts: { nul: boolean, delim: string | null, replace: string | null, eof: string | null, maxLines: number | null, maxArgs: number | null, verbose: boolean, noRun: boolean, argFile: string | null }, command: string[], warnings: string[] } | { error: string } | null}
 *   null for an option this parser does not know: the caller leaves the command line to the engine
 */
function parseXargs(args) {
	const opts = { nul: false, delim: /** @type {string | null} */ (null), replace: /** @type {string | null} */ (null), eof: /** @type {string | null} */ (null), maxLines: /** @type {number | null} */ (null), maxArgs: /** @type {number | null} */ (null), verbose: false, noRun: false, argFile: /** @type {string | null} */ (null) };
	const warnings = [];
	const fail = (m) => ({ error: `xargs: ${m}\nTry 'xargs --help' for more information.\n` });
	const number = (v, flag, min) => {
		if (!/^\d+$/.test(String(v))) { return fail(`invalid number "${v}" for ${flag} option`); }
		if (Number(v) < min) { return fail(`value ${v} for ${flag} option should be >= ${min}`); }
		return Number(v);
	};
	const setLines = (n) => {
		if (opts.replace !== null) { warnings.push('xargs: warning: options --replace and -L are mutually exclusive, ignoring previous --replace value\n'); opts.replace = null; }
		if (opts.maxArgs !== null) { warnings.push('xargs: warning: options --max-args and -L are mutually exclusive, ignoring previous --max-args value\n'); opts.maxArgs = null; }
		opts.maxLines = n;
	};
	const setArgs = (n) => {
		if (opts.maxLines !== null) { warnings.push('xargs: warning: options --max-lines and --max-args/-n are mutually exclusive, ignoring previous --max-lines value\n'); opts.maxLines = null; }
		opts.maxArgs = n;
	};
	const setReplace = (r) => {
		if (opts.maxLines !== null) { warnings.push('xargs: warning: options --max-lines and --replace/-I/-i are mutually exclusive, ignoring previous --max-lines value\n'); opts.maxLines = null; }
		opts.replace = r;
	};
	const delimiter = (v) => {
		const m = /^\\(?:([ntrfv0\\abe])|x([0-9a-fA-F]{1,2})|([0-7]{1,3}))$/.exec(v);
		if (m) {
			if (m[2] !== undefined) { return String.fromCharCode(parseInt(m[2], 16)); }
			if (m[3] !== undefined) { return String.fromCharCode(parseInt(m[3], 8)); }
			return { n: '\n', t: '\t', r: '\r', f: '\f', v: '\v', 0: '\0', '\\': '\\', a: '\x07', b: '\b', e: '\x1b' }[m[1]];
		}
		return [...v].length === 1 ? v : null;
	};
	let i = 0;
	for (; i < args.length; i++) {
		const a = args[i];
		if (a === '--') { i++; break; }
		if (a === '-' || !a.startsWith('-')) { break; }
		if (a.startsWith('--')) {
			const eq = a.indexOf('=');
			const name = eq < 0 ? a : a.slice(0, eq);
			const attached = eq < 0 ? null : a.slice(eq + 1);
			const value = () => (attached !== null ? attached : args[++i]);
			switch (name) {
				case '--null': opts.nul = true; break;
				case '--verbose': opts.verbose = true; break;
				case '--no-run-if-empty': opts.noRun = true; break;
				case '--exit': case '--open-tty': case '--interactive': case '--show-limits': case '--process-slot-var': case '--max-procs': case '--max-chars': if (name === '--max-procs' || name === '--max-chars' || name === '--process-slot-var') { value(); } break;
				case '--replace': setReplace(attached !== null && attached !== '' ? attached : '{}'); break;
				case '--eof': opts.eof = attached === null || attached === '' ? null : attached; break;
				case '--max-lines': { const n = attached === null ? 1 : number(attached, '-L', 1); if (typeof n !== 'number') { return n; } setLines(n); break; }
				case '--max-args': { const v = value(); const n = number(v, '-n', 1); if (typeof n !== 'number') { return n; } setArgs(n); break; }
				case '--delimiter': { const d = delimiter(String(value())); if (d === null) { return { error: 'xargs: Invalid input delimiter specification : the delimiter must be either a single character or an escape sequence starting with \\.\n' }; } opts.delim = d; break; }
				case '--arg-file': opts.argFile = String(value()); break;
				default: return null;
			}
			continue;
		}
		// a cluster of short options; the first one that takes a value takes the rest of the cluster (or the next argument)
		for (let c = 1; c < a.length; c++) {
			const ch = a[c];
			const rest = a.slice(c + 1);
			const value = () => { c = a.length; return rest !== '' ? rest : args[++i]; };
			if (ch === '0') { opts.nul = true; } else if (ch === 'r') { opts.noRun = true; } else if (ch === 't') { opts.verbose = true; } else if (ch === 'x' || ch === 'o' || ch === 'p') { /* nothing runs in parallel, nobody answers */ } else if (ch === 'I') {
				const v = value();
				if (v === undefined) { return fail("option requires an argument -- 'I'"); }
				setReplace(String(v));
			} else if (ch === 'i') { c = a.length; setReplace(rest !== '' ? rest : '{}'); } else if (ch === 'L') {
				const v = value();
				if (v === undefined) { return fail("option requires an argument -- 'L'"); }
				const n = number(v, '-L', 1);
				if (typeof n !== 'number') { return n; }
				setLines(n);
			} else if (ch === 'l') {
				c = a.length;
				const n = rest !== '' ? number(rest, '-l', 1) : 1;
				if (typeof n !== 'number') { return n; }
				setLines(n);
			} else if (ch === 'n') {
				const v = value();
				if (v === undefined) { return fail("option requires an argument -- 'n'"); }
				const n = number(v, '-n', 1);
				if (typeof n !== 'number') { return n; }
				setArgs(n);
			} else if (ch === 'E') {
				const v = value();
				opts.eof = v === undefined || v === '' ? null : String(v);
			} else if (ch === 'e') { c = a.length; opts.eof = rest === '' ? null : rest; } else if (ch === 'd') {
				const v = value();
				const d = delimiter(String(v));
				if (d === null) { return { error: 'xargs: Invalid input delimiter specification : the delimiter must be either a single character or an escape sequence starting with \\.\n' }; }
				opts.delim = d;
			} else if (ch === 'a') {
				const v = value();
				if (v === undefined) { return fail("option requires an argument -- 'a'"); }
				opts.argFile = String(v);
			} else if (ch === 's' || ch === 'P') {
				const v = value();
				if (v === undefined) { return fail(`option requires an argument -- '${ch}'`); }
				const n = number(v, '-' + ch, 0);
				if (typeof n !== 'number') { return n; }
			} else { return null; }
		}
	}
	return { opts, command: args.slice(i), warnings };
}

/**
 * xargs input as GNU reads it: the items of each line (a blank line has none). Without -0 and -d, blanks and newlines
 * separate items, `'..'` and `".."` group, and a backslash takes the next character as it is; with -I the separator is
 * the newline alone (leading blanks are dropped, the quotes still work). A quote that is not closed is an error: what
 * was read before it is still returned, because GNU runs it.
 *
 * @param {string} input
 * @param {{ nul: boolean, delim: string | null, replace: string | null, eof: string | null }} o
 * @returns {{ lines: Array<string[] & { continued?: boolean }>, error: string | null }}
 */
function xargsInput(input, o) {
	/** @type {Array<string[] & { continued?: boolean }>} */
	const lines = [];
	if (o.nul || o.delim !== null) {
		const d = o.nul ? '\0' : /** @type {string} */ (o.delim);
		const items = input.split(d);
		if (items.length && items[items.length - 1] === '') { items.pop(); }
		for (const it of items) { lines.push([it]); }
		return { lines, error: null };
	}
	const replaceMode = o.replace !== null;
	const isBlank = (c) => c === ' ' || c === '\t';
	/** @type {string[] & { continued?: boolean }} */
	let line = [];
	let item = '';
	let has = false;
	let lastWasBlank = false;
	const endItem = () => { if (has) { line.push(item); item = ''; has = false; } };
	const endLine = () => {
		endItem();
		if (line.length) { if (lastWasBlank && !replaceMode) { line.continued = true; } lines.push(line); }
		line = [];
	};
	for (let i = 0; i < input.length; i++) {
		const c = input[i];
		if (c === '\\') {
			if (i + 1 < input.length) { item += input[++i]; has = true; }
			lastWasBlank = false;
			continue;
		}
		if (c === "'" || c === '"') {
			let j = i + 1;
			while (j < input.length && input[j] !== c && input[j] !== '\n') { j++; }
			if (j >= input.length || input[j] === '\n') {
				endLine();
				return { lines, error: `xargs: unmatched ${c === "'" ? 'single' : 'double'} quote; by default quotes are special to xargs unless you use the -0 option\n` };
			}
			item += input.slice(i + 1, j);
			has = true;
			i = j;
			lastWasBlank = false;
			continue;
		}
		if (c === '\n') { endLine(); lastWasBlank = false; continue; }
		if (isBlank(c)) {
			if (replaceMode) { if (has) { item += c; } } else { endItem(); lastWasBlank = true; }
			continue;
		}
		item += c;
		has = true;
		lastWasBlank = false;
	}
	endLine();
	if (o.eof !== null) {
		for (let k = 0; k < lines.length; k++) {
			const at = lines[k].indexOf(o.eof);
			if (at >= 0) { lines[k] = Object.assign(lines[k].slice(0, at), { continued: false }); lines.length = lines[k].length ? k + 1 : k; break; }
		}
	}
	return { lines, error: null };
}

/**
 * The argument lists xargs runs its command with, from the input lines: one item per run with -I, N logical lines with
 * -L (a line that ends in a blank continues into the next), N items with -n, else all of them.
 *
 * @param {Array<string[] & { continued?: boolean }>} lines
 * @param {{ replace: string | null, maxLines: number | null, maxArgs: number | null }} o
 * @returns {string[][]}
 */
function xargsBatches(lines, o) {
	if (o.replace !== null) { return lines.map((l) => [l.join(' ')]); }
	if (o.maxLines !== null) {
		const out = [];
		let batch = [];
		let count = 0;
		let open = false;
		for (const l of lines) {
			batch.push(...l);
			if (!open) { count++; }
			open = !!l.continued;
			if (count >= o.maxLines && !open) { out.push(batch); batch = []; count = 0; }
		}
		if (batch.length) { out.push(batch); }
		return out;
	}
	const items = lines.flat();
	if (o.maxArgs !== null) {
		const out = [];
		for (let k = 0; k < items.length; k += o.maxArgs) { out.push(items.slice(k, k + o.maxArgs)); }
		return out;
	}
	return items.length ? [items] : [];
}

/** A word as `xargs -t` shows it: plain when it is made of safe characters, else quoted the way a shell wants it. */
function xargsQuote(w) {
	if (w !== '' && /^[A-Za-z0-9_+,.\/:@%^-]+$/.test(w)) { return w; }
	if (!w.includes("'")) { return `'${w}'`; }
	if (!/["$`\\!]/.test(w)) { return `"${w}"`; }
	return `'${w.replace(/'/g, "'\\''")}'`;
}

/** GNU grep options that take a value (so that the value is never mistaken for an option or for something to drop). */
const GREP_SHORT_VALUE = new Set(['e', 'f', 'm', 'A', 'B', 'C', 'd', 'D']);
const GREP_LONG_VALUE = new Set(['--regexp', '--file', '--max-count', '--after-context', '--before-context', '--context', '--include', '--exclude', '--exclude-from', '--exclude-dir', '--directories', '--devices', '--label']);
/**
 * The engine takes some of these only in their short form (`--after-context=2` is "unrecognized option"), and the
 * file globs only as `--include=GLOB`. Each long name, with a value, becomes this.
 */
const GREP_LONG_AS_SHORT = { '--regexp': '-e', '--file': '-f', '--max-count': '-m', '--after-context': '-A', '--before-context': '-B', '--context': '-C' };
/** Accepted by GNU grep, meaningless here (no terminal, no binary files, no colour, no unreadable files): removed. */
const GREP_DROP_SHORT = new Set(['s', 'I', 'a', 'U', 'H']);

/**
 * Did the command line ask grep to be quiet about files it cannot read (`-s`, `--no-messages`)?
 * @param {string[]} args
 */
function grepWantsSilence(args) {
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (a === '--') { return false; }
		if (a === '--no-messages') { return true; }
		if (a === '-' || !a.startsWith('-') || a.startsWith('--')) {
			if (GREP_LONG_VALUE.has(a)) { i++; }
			continue;
		}
		for (let c = 1; c < a.length; c++) {
			if (a[c] === 's') { return true; }
			if (GREP_SHORT_VALUE.has(a[c])) { if (c === a.length - 1) { i++; } break; }
		}
	}
	return false;
}

/**
 * What a grep command line names: whether it is recursive, whether it prints names, and the files it searches.
 * @param {string[]} args
 */
function grepOperands(args) {
	let recursive = false;
	let noName = false;
	let withName = false;
	let quiet = false;
	let patternGiven = false;
	/** @type {number[]} indexes into args of every operand (the pattern, when there is one, is the first) */
	const at = [];
	let afterDashes = false;
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (afterDashes || a === '-' || !a.startsWith('-')) { at.push(i); continue; }
		if (a === '--') { afterDashes = true; continue; }
		if (a.startsWith('--')) {
			const eq = a.indexOf('=');
			const name = eq < 0 ? a : a.slice(0, eq);
			if (name === '--recursive' || name === '--dereference-recursive') { recursive = true; }
			if (name === '--no-filename') { noName = true; }
			if (name === '--with-filename') { withName = true; }
			if (name === '--quiet' || name === '--silent') { quiet = true; }
			if (name === '--regexp' || name === '--file') { patternGiven = true; }
			if (eq < 0 && GREP_LONG_VALUE.has(name)) { i++; }
			continue;
		}
		for (let c = 1; c < a.length; c++) {
			const ch = a[c];
			if (ch === 'r' || ch === 'R') { recursive = true; }
			if (ch === 'h') { noName = true; }
			if (ch === 'H') { withName = true; }
			if (ch === 'q') { quiet = true; }
			if (GREP_SHORT_VALUE.has(ch)) {
				if (ch === 'e' || ch === 'f') { patternGiven = true; }
				if (c === a.length - 1) { i++; }
				break;
			}
		}
	}
	const fileAt = patternGiven ? at : at.slice(1);
	return { recursive, noName, withName, quiet, files: fileAt.map((i) => args[i]), fileAt };
}

/**
 * Is this a recursive search of exactly `.` that prints file names? GNU prefixes each name with './'; the engine
 * prints the name relative to it. (A search with no operand, or of any other folder, is the same in both.)
 * @param {string[]} args
 */
function grepDotPrefix(args) {
	const g = grepOperands(args);
	return g.recursive && !g.noName && !g.quiet && g.files.length === 1 && (g.files[0] === '.' || g.files[0] === './');
}

/**
 * `grep -r PATTERN` with no file searches the current directory in GNU grep; the engine reads standard input.
 * @param {string[]} args
 */
function grepNeedsDot(args) {
	const g = grepOperands(args);
	return g.recursive && g.files.length === 0;
}

/**
 * grep. The engine has no `-s`, `-I`, `-H`, `--color[=WHEN]`, `--line-buffered`, `-a`, `-U`, `--binary-files=`,
 * `--label`, and takes the long forms of a few options with a value only as they are written here: a separated value
 * (`--include '*.js'`, `--exclude-dir deep`) is joined with `=`, and `--regexp`, `--file`, `--max-count`,
 * `--after-context`, `--before-context`, `--context` become `-e -f -m -A -B -C`. Everything else (`-P` included) it
 * takes as it is. `-s` also silences the "no such file" lines, and `-H` is an operand (/dev/null) added by the wrapper.
 *
 * @param {string[]} args
 * @returns {string[]}
 */
function normaliseGrep(args) {
	const out = [];
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (a === '--') { out.push(...args.slice(i)); break; }
		if (a === '-' || !a.startsWith('-')) { out.push(a); continue; }
		if (a.startsWith('--')) {
			const eq = a.indexOf('=');
			const name = eq < 0 ? a : a.slice(0, eq);
			if (name === '--no-messages' || name === '--line-buffered' || name === '--text' || name === '--binary' || name === '--color' || name === '--colour' || name === '--with-filename') { continue; }
			if (name === '--binary-files') { if (eq < 0) { i++; } continue; }
			if (name === '--label') { if (eq < 0) { i++; } continue; }
			const isValued = GREP_LONG_VALUE.has(name);
			if (isValued) {
				const value = eq >= 0 ? a.slice(eq + 1) : (i + 1 < args.length ? args[++i] : null);
				if (value === null) { out.push(a); continue; }
				if (Object.prototype.hasOwnProperty.call(GREP_LONG_AS_SHORT, name)) { out.push(GREP_LONG_AS_SHORT[name], value); } else { out.push(name + '=' + value); }
				continue;
			}
			out.push(a);
			continue;
		}
		// a cluster: drop the letters that mean nothing here, keep the order of the rest
		let kept = '-';
		let takesValue = false;
		for (let c = 1; c < a.length; c++) {
			const ch = a[c];
			if (GREP_SHORT_VALUE.has(ch)) {
				kept += a.slice(c);                       // the rest of the cluster is this option's value
				takesValue = c === a.length - 1;
				break;
			}
			if (!GREP_DROP_SHORT.has(ch)) { kept += ch; }
		}
		if (kept !== '-') { out.push(kept); }
		if (takesValue && i + 1 < args.length) { out.push(args[++i]); }
	}
	return out;
}

/**
 * Moves `-t DIR` / `--target-directory=DIR` to the end, where the engine expects the destination.
 * @param {string[]} args
 * @returns {{ rest: string[], target: string | null }}
 */
function extractTarget(args) {
	const rest = [];
	let target = null;
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (a === '--') { rest.push(...args.slice(i)); break; }
		if (a === '--target-directory') { target = args[++i]; continue; }
		if (a.startsWith('--target-directory=')) { target = a.slice('--target-directory='.length); continue; }
		// -t attached to a cluster or to its value: -tDIR, -rt DIR
		const m = /^-([A-Za-z]*)t(.*)$/.exec(a);
		if (m && !a.startsWith('--') && /^[A-Za-z]*$/.test(m[1])) {
			if (m[1]) { rest.push('-' + m[1]); }
			target = m[2] !== '' ? m[2] : args[++i];
			continue;
		}
		rest.push(a);
	}
	return { rest, target };
}

/** Letters of a short cluster that are rewritten: `map[ch]` is the replacement ('' drops it). */
function mapCluster(arg, map) {
	let out = '-';
	for (let c = 1; c < arg.length; c++) {
		const ch = arg[c];
		out += Object.prototype.hasOwnProperty.call(map, ch) ? map[ch] : ch;
	}
	return out === '-' ? '' : out;
}

/**
 * Was -T / --no-target-directory given (cp, mv)? The letters of a short cluster that take a value (-t, -S) end the scan:
 * what follows them is that value.
 * @param {string[]} args
 */
function wantsNoTargetDirectory(args) {
	for (const a of args) {
		if (a === '--') { return false; }
		if (a === '--no-target-directory') { return true; }
		if (a.startsWith('--') || !a.startsWith('-') || a === '-') { continue; }
		for (let c = 1; c < a.length; c++) {
			if (a[c] === 'T') { return true; }
			if (a[c] === 't' || a[c] === 'S') { break; }
		}
	}
	return false;
}

/**
 * cp. The engine takes `-r -R -n -p -v`. `-a` means `-r -p`; `-f -L -P -H -d -x -T` are accepted and dropped (nothing
 * is read-only or a link, one file system); `-u` is returned as `update` and done by the wrapper; `-t DIR` moves to
 * the end. `-i` and `-b` are kept, so the engine refuses them (see the header).
 *
 * @param {string[]} args
 * @returns {{ args: string[], update: boolean }}
 */
function normaliseCp(args) {
	const { rest, target } = extractTarget(args);
	const out = [];
	let preserve = false;
	let update = false;
	let afterDashes = false;
	for (const a of rest) {
		if (afterDashes || a === '-' || !a.startsWith('-')) { out.push(a); continue; }
		if (a === '--') { afterDashes = true; out.push(a); continue; }
		if (a.startsWith('--')) {
			const name = a.split('=')[0];
			if (name === '--archive') { out.push('-r'); preserve = true; continue; }
			if (name === '--preserve') { preserve = true; continue; }
			if (name === '--update') { update = true; continue; }
			if (['--force', '--dereference', '--no-dereference', '--no-target-directory', '--one-file-system', '--no-preserve', '--reflink', '--sparse', '--strip-trailing-slashes', '--remove-destination'].includes(name)) { continue; }
			out.push(a);
			continue;
		}
		if (a.includes('u')) { update = true; }
		const m = mapCluster(a, { a: 'rp', f: '', L: '', P: '', H: '', d: '', x: '', u: '', T: '' });
		if (m) { out.push(m); }
	}
	if (preserve && !out.some((x) => /^-[A-Za-z]*p/.test(x) || x === '--preserve')) { out.unshift('-p'); }
	if (target !== null) { out.push(target); }
	return { args: out, update };
}

/**
 * mv. The engine takes `-f -n -v`. `-T` is dropped, `-u` is returned as `update` and done by the wrapper, `-t DIR`
 * moves to the end. `-i` and `-b` are kept, so the engine refuses them.
 *
 * @param {string[]} args
 * @returns {{ args: string[], update: boolean }}
 */
function normaliseMv(args) {
	const { rest, target } = extractTarget(args);
	const out = [];
	let update = false;
	let afterDashes = false;
	for (const a of rest) {
		if (afterDashes || a === '-' || !a.startsWith('-')) { out.push(a); continue; }
		if (a === '--') { afterDashes = true; out.push(a); continue; }
		if (a.startsWith('--')) {
			const name = a.split('=')[0];
			if (name === '--update') { update = true; continue; }
			if (['--no-target-directory', '--strip-trailing-slashes'].includes(name)) { continue; }
			out.push(a);
			continue;
		}
		if (a.includes('u')) { update = true; }
		const m = mapCluster(a, { u: '', T: '' });
		if (m) { out.push(m); }
	}
	if (target !== null) { out.push(target); }
	return { args: out, update };
}

/**
 * rm. `--preserve-root` and `--one-file-system` are dropped. `-i` and `-I` are kept: ignoring a question would
 * delete what a shell with nobody to answer would have kept.
 *
 * @param {string[]} args
 * @returns {string[]}
 */
function normaliseRm(args) {
	const out = [];
	let afterDashes = false;
	for (const a of args) {
		if (afterDashes || a === '-' || !a.startsWith('-')) { out.push(a); continue; }
		if (a === '--') { afterDashes = true; out.push(a); continue; }
		if (a.startsWith('--')) {
			const name = a.split('=')[0];
			if (['--preserve-root', '--no-preserve-root', '--one-file-system'].includes(name)) { continue; }
			out.push(a);
			continue;
		}
		out.push(a);
	}
	return out;
}

/**
 * mkdir. The engine has no `-m`; the mode is taken out and applied afterwards (per run: nothing keeps a mode).
 *
 * @param {string[]} args
 * @returns {{ args: string[], mode: string | null, dirs: string[] }} `dirs` are the operands
 */
function normaliseMkdir(args) {
	const out = [];
	const dirs = [];
	let mode = null;
	let afterDashes = false;
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (afterDashes || a === '-' || !a.startsWith('-')) { out.push(a); dirs.push(a); continue; }
		if (a === '--') { afterDashes = true; out.push(a); continue; }
		if (a.startsWith('--')) {
			if (a === '--mode') { mode = args[++i]; continue; }
			if (a.startsWith('--mode=')) { mode = a.slice(7); continue; }
			if (a === '--context' || a.startsWith('--context=')) { continue; }
			out.push(a);
			continue;
		}
		// a cluster such as -pm755, -m 755, -pv
		let kept = '-';
		for (let c = 1; c < a.length; c++) {
			const ch = a[c];
			if (ch === 'm') {
				const rest = a.slice(c + 1);
				mode = rest !== '' ? rest : args[++i];
				break;
			}
			if (ch === 'Z') { continue; }
			kept += ch;
		}
		if (kept !== '-') { out.push(kept); }
	}
	return { args: out, mode, dirs };
}

/**
 * sed. The engine takes `-i.bak` and then makes no backup, and has no long options for -i/-e/-f/-n/-E. The suffix and
 * the file operands for the wrapper that makes the backup, and the arguments in the engine's own spelling.
 *
 * @param {string[]} args
 * @returns {{ args: string[], suffix: string | null, files: string[] }}
 */
function normaliseSed(args) {
	let suffix = null;
	let script = false;
	const out = [];
	const operands = [];
	let firstOperand = -1;
	let afterDashes = false;
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (afterDashes || a === '-' || !a.startsWith('-')) { if (firstOperand < 0) { firstOperand = out.length; } operands.push(a); out.push(a); continue; }
		if (a === '--') { afterDashes = true; out.push(a); continue; }
		if (a.startsWith('--')) {
			const eq = a.indexOf('=');
			const name = eq < 0 ? a : a.slice(0, eq);
			const val = () => (eq >= 0 ? a.slice(eq + 1) : args[++i]);
			if (name === '--in-place') { suffix = eq >= 0 ? a.slice(eq + 1) : (suffix || ''); out.push('-i'); continue; }
			// an option with no value (`sed -f` at the end of the line) goes on without one: the engine says so, in its own words
			if (name === '--expression') { script = true; const v = val(); out.push(...(v === undefined ? ['-e'] : ['-e', fixSedOneLiner(String(v))])); continue; }
			if (name === '--file') { script = true; const v = val(); out.push(...(v === undefined ? ['-f'] : ['-f', String(v)])); continue; }
			if (name === '--quiet' || name === '--silent') { out.push('-n'); continue; }
			if (name === '--regexp-extended') { out.push('-E'); continue; }
			out.push(a);
			continue;
		}
		let kept = '-';
		for (let c = 1; c < a.length; c++) {
			const ch = a[c];
			if (ch === 'i') { suffix = a.slice(c + 1); kept += 'i'; break; }
			if (ch === 'e' || ch === 'f' || ch === 'l') {
				if (ch !== 'l') { script = true; }
				const rest = a.slice(c + 1);
				const value = rest !== '' ? rest : args[++i];
				if (kept !== '-') { out.push(kept); }
				out.push('-' + ch, ...(value === undefined ? [] : [ch === 'e' ? fixSedOneLiner(String(value)) : String(value)]));
				kept = '';
				break;
			}
			kept += ch;
		}
		if (kept && kept !== '-') { out.push(kept); }
	}
	if (!script && firstOperand >= 0) { out[firstOperand] = fixSedOneLiner(out[firstOperand]); }
	const files = script ? operands : operands.slice(1);
	return { args: out, suffix, files };
}

/**
 * touch. The engine ignores `-t [[CC]YY]MMDDhhmm[.ss]` and reads `-d @EPOCH` as a year; a time of 0 it takes for
 * "no time given", and `-r FILE` (the times of another file) it ignores altogether. So these are taken out of the
 * command line and applied with utimes afterwards. The wall clock of `-t` is read in `tz` (the TZ of the command, UTC
 * when it has none): never the visitor's zone.
 *
 * @param {string[]} args
 * @param {string} [tz]
 * @returns {{ args: string[], time: number | null, files: string[], reference: string | null }} `time` in ms since the
 *   epoch; `reference` is the file `-r` names (its time is for the caller to read)
 */
function parseTouch(args, tz = 'UTC') {
	const out = [];
	const files = [];
	let time = null;
	let reference = null;
	let afterDashes = false;
	const OPT_VALUE = new Set(['-d', '--date', '-t']);
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (afterDashes || a === '-' || !a.startsWith('-')) { files.push(a); out.push(a); continue; }
		if (a === '--') { afterDashes = true; out.push(a); continue; }
		if (a === '-r' || a === '--reference') { reference = String(args[++i]); continue; }
		if (a.startsWith('--reference=')) { reference = a.slice(12); continue; }
		if (/^-r.+/.test(a) && !a.startsWith('--')) { reference = a.slice(2); continue; }
		let stamp = null;
		let date = null;
		if (a === '-t') { stamp = args[++i]; } else if (/^-t.+/.test(a) && !a.startsWith('--')) { stamp = a.slice(2); } else if (a === '-d' || a === '--date') { date = args[++i]; } else if (a.startsWith('--date=')) { date = a.slice(7); } else if (/^-d.+/.test(a) && !a.startsWith('--')) { date = a.slice(2); }
		if (stamp !== null) {
			const m = /^(\d{2}|\d{4})?(\d{2})(\d{2})(\d{2})(\d{2})(?:\.(\d{2}))?$/.exec(String(stamp));
			if (m) {
				let year = m[1];
				if (year === undefined) { year = String(zone.partsAt(Date.now(), tz).year); } else if (year.length === 2) { year = (Number(year) >= 69 ? '19' : '20') + year; }
				time = zone.instantOf(zone.wallUtc(Number(year), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] || 0), 0), tz);
				continue;
			}
			out.push('-t', String(stamp));
			continue;
		}
		if (date !== null) {
			const e = /^@(-?\d+)$/.exec(String(date));
			if (e) { time = Number(e[1]) * 1000; continue; }
			out.push('-d', String(date));
			continue;
		}
		out.push(a);
		if (OPT_VALUE.has(a) && i + 1 < args.length) { out.push(args[++i]); }
	}
	return { args: out, time, files, reference };
}

/** A sed script longer than this is not rewritten (it is a program, not a one-liner a person typed). */
const SED_REWRITE_MAX = 64 * 1024;

/** Index after the sed address that starts at i (a line number, `$`, `first~step`, `+N`, `~N`, `/re/` or `\cREc`, with I and M flags). */
function skipSedAddress(s, i) {
	const n = s.length;
	const digit = (k) => k < n && s[k] >= '0' && s[k] <= '9';
	if (s[i] === '$') { return i + 1; }
	if (digit(i) || s[i] === '+' || s[i] === '~') {
		i++;
		while (digit(i)) { i++; }
		if (s[i] === '~' && digit(i + 1)) { i++; while (digit(i)) { i++; } }
		return i;
	}
	if (s[i] === '/' || (s[i] === '\\' && i + 1 < n && s[i + 1] !== '\n')) {
		const d = s[i] === '/' ? '/' : s[i + 1];
		i += s[i] === '/' ? 1 : 2;
		while (i < n && s[i] !== d) { i += s[i] === '\\' && i + 1 < n ? 2 : 1; }
		if (i < n) { i++; }
		while (s[i] === 'I' || s[i] === 'M') { i++; }
	}
	return i;
}

/**
 * GNU's one-line form of the text commands (`1i\HEADER`, `$a\FOOTER`, `/re/c\new`): the engine prints the backslash.
 * The portable form, a backslash and a newline before the text, is what it understands. The script is read command
 * by command, in one pass, so what is inside an `s` or `y` or after `r`/`w` is not mistaken for a command, and a long
 * run of spaces costs what it should (the regular expression this replaces took seconds for 4000 of them).
 *
 * @param {string} script
 */
function fixSedOneLiner(script) {
	if (script.length > SED_REWRITE_MAX || !script.includes('\\')) { return script; }
	const n = script.length;
	let out = '';
	let i = 0;
	/** copy up to the end of the line, a backslash taking the character after it along (a continued text line) */
	const toEndOfLine = () => {
		while (i < n && script[i] !== '\n') {
			if (script[i] === '\\' && i + 1 < n) { out += script[i] + script[i + 1]; i += 2; } else { out += script[i++]; }
		}
	};
	/** copy one delimited section (the regex or the replacement of s, a set of y): up to the unescaped delimiter */
	const section = (d) => {
		while (i < n && script[i] !== d) {
			if (script[i] === '\\' && i + 1 < n) { out += script[i] + script[i + 1]; i += 2; } else { out += script[i++]; }
		}
		if (i < n) { out += script[i++]; }
	};
	while (i < n) {
		const ch = script[i];
		if (ch === ' ' || ch === '\t' || ch === '\n' || ch === ';' || ch === '{' || ch === '}') { out += ch; i++; continue; }
		if (ch === '#') { toEndOfLine(); continue; }
		// a command: [address[,address]][!]name
		const start = i;
		i = skipSedAddress(script, i);
		let j = i;
		while (script[j] === ' ' || script[j] === '\t') { j++; }
		if (script[j] === ',') {
			j++;
			while (script[j] === ' ' || script[j] === '\t') { j++; }
			i = skipSedAddress(script, j);
		}
		while (script[i] === ' ' || script[i] === '\t' || script[i] === '!') { i++; }
		const cmd = script[i];
		if (cmd === undefined) { out += script.slice(start); break; }
		out += script.slice(start, i + 1);
		i++;
		if (cmd === 'a' || cmd === 'i' || cmd === 'c') {
			let k = i;
			while (script[k] === ' ' || script[k] === '\t') { k++; }
			if (script[k] === '\\' && k + 1 < n && script[k + 1] !== '\n') {
				out += script.slice(i, k + 1) + '\n';
				i = k + 1;
			}
			toEndOfLine();
		} else if (cmd === 's' || cmd === 'y') {
			if (i < n && script[i] !== '\n' && script[i] !== '\\') {
				const d = script[i];
				out += d;
				i++;
				section(d);
				section(d);
				while (i < n && script[i] !== ';' && script[i] !== '\n' && script[i] !== '}') {
					if (script[i] === 'w') { toEndOfLine(); break; }
					out += script[i++];
				}
			}
		} else if (cmd === 'r' || cmd === 'R' || cmd === 'w' || cmd === 'W' || cmd === 'e') {
			toEndOfLine();
		} else if (cmd === ':') {
			// `:label` ends at a `;`, a blank or the end of the line (GNU), so `:a;N;$!ba;$a\END` has four commands
			while (i < n && script[i] === ' ') { out += script[i++]; }
			while (i < n && script[i] !== ';' && script[i] !== '\n' && script[i] !== ' ' && script[i] !== '\t') { out += script[i++]; }
		} else if (cmd === 'b' || cmd === 't' || cmd === 'T') {
			while (i < n && script[i] !== ';' && script[i] !== '\n' && script[i] !== '}') { out += script[i++]; }
		}
	}
	return out;
}

/**
 * paste. GNU reads standard input when no file is named; the engine wants a `-`.
 * @param {string[]} args
 * @returns {string[]}
 */
function normalisePaste(args) {
	let operands = 0;
	let afterDashes = false;
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (afterDashes || a === '-' || !a.startsWith('-')) { operands++; continue; }
		if (a === '--') { afterDashes = true; continue; }
		if (a === '-d' || a === '--delimiters') { i++; continue; }
		if (a.startsWith('-') && !a.startsWith('--') && a.endsWith('d') && a.length > 1 && /^-[a-z]*d$/.test(a)) { i++; continue; }
	}
	return operands === 0 ? [...args, '-'] : args;
}

/**
 * sort. The engine reads a cluster of flags (`-nr`) only when every letter is a flag: `-nk2`, `-rk2,2`, `-rt,` and
 * `-nrk 2` are "invalid option". A letter that takes a value (k, t, o) ends the cluster and takes the rest of it, or
 * the next argument; the flags before it stay together. `-S SIZE`, `-T DIR` and `--parallel`/`--buffer-size` only
 * matter for huge inputs and are dropped; the long forms of the three valued options become the short ones.
 *
 * @param {string[]} args
 * @returns {string[]}
 */
function normaliseSort(args) {
	const out = [];
	let afterDashes = false;
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (afterDashes || a === '-' || !a.startsWith('-')) { out.push(a); continue; }
		if (a === '--') { afterDashes = true; out.push(a); continue; }
		if (a.startsWith('--')) {
			const eq = a.indexOf('=');
			const name = eq < 0 ? a : a.slice(0, eq);
			const value = () => (eq >= 0 ? a.slice(eq + 1) : args[++i]);
			if (name === '--key') { out.push('-k', String(value())); continue; }
			if (name === '--field-separator') { out.push('-t', String(value())); continue; }
			if (name === '--output') { out.push('-o', String(value())); continue; }
			if (name === '--parallel' || name === '--buffer-size' || name === '--temporary-directory') { value(); continue; }
			out.push(a);
			continue;
		}
		let flags = '';
		for (let c = 1; c < a.length; c++) {
			const ch = a[c];
			if (ch === 'k' || ch === 't' || ch === 'o' || ch === 'S' || ch === 'T') {
				if (flags) { out.push('-' + flags); flags = ''; }
				const rest = a.slice(c + 1);
				const value = rest !== '' ? rest : (i + 1 < args.length ? args[++i] : '');
				if (ch !== 'S' && ch !== 'T') { out.push('-' + ch, value); }
				break;
			}
			flags += ch;
		}
		if (flags) { out.push('-' + flags); }
	}
	return out;
}

const COUNT_SUFFIX = { b: 512, kB: 1000, KB: 1000, K: 1024, k: 1024, MB: 1000 ** 2, M: 1024 ** 2, m: 1024 ** 2, GB: 1000 ** 3, G: 1024 ** 3, g: 1024 ** 3, TB: 1000 ** 4, T: 1024 ** 4, t: 1024 ** 4 };

/**
 * head and tail: `-c 1K`, `-n 2M`, `--bytes=1KB`. The engine reads the number and drops the suffix without a word
 * (`head -c 1K` printed one byte). The suffixes are GNU's (K is 1024, KB is 1000, b is 512).
 *
 * @param {string[]} args
 * @returns {string[]}
 */
function normaliseCounts(args) {
	const expand = (v) => {
		const m = /^([+-]?)(\d+)(b|kB|KB|K|k|MB|M|m|GB|G|g|TB|T|t)$/.exec(String(v));
		return m ? m[1] + String(Number(m[2]) * COUNT_SUFFIX[m[3]]) : v;
	};
	const out = [];
	let afterDashes = false;
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (afterDashes || a === '-' || !a.startsWith('-')) { out.push(a); continue; }
		if (a === '--') { afterDashes = true; out.push(a); continue; }
		if (a === '-c' || a === '-n' || a === '--bytes' || a === '--lines') { out.push(a); if (i + 1 < args.length) { out.push(expand(args[++i])); } continue; }
		const long = /^(--bytes=|--lines=)(.+)$/.exec(a);
		if (long) { out.push(long[1] + expand(long[2])); continue; }
		const short = /^(-[cn])(.+)$/.exec(a);
		if (short) { out.push(short[1] + expand(short[2])); continue; }
		out.push(a);
	}
	return out;
}

/**
 * head with a negative count (`-n -3`: all but the last three lines; `-c -5`: all but the last five bytes), or with
 * `-z` (records end in NUL), which the engine rejects. Everything else is the engine's.
 *
 * @param {string[]} args
 * @returns {null | { unit: 'lines' | 'bytes', count: number, negative: boolean, quiet: boolean, verbose: boolean, zero: boolean, files: string[] }}
 */
function parseHeadNegative(args) {
	/** @type {'lines' | 'bytes' | null} */
	let unit = null;
	let count = 0;
	let negative = false;
	let quiet = false;
	let verbose = false;
	let zero = false;
	const files = [];
	let afterDashes = false;
	const take = (/** @type {'lines' | 'bytes'} */ u, v) => {
		const m = /^(-?)(\d+)$/.exec(String(v));
		if (!m) { return; }
		unit = u;
		count = Number(m[2]);
		negative = m[1] === '-';
	};
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (afterDashes || a === '-' || !a.startsWith('-')) { files.push(a); continue; }
		if (a === '--') { afterDashes = true; continue; }
		if (a === '-n' || a === '--lines') { take('lines', args[++i]); continue; }
		if (a === '-c' || a === '--bytes') { take('bytes', args[++i]); continue; }
		if (a.startsWith('--lines=')) { take('lines', a.slice(8)); continue; }
		if (a.startsWith('--bytes=')) { take('bytes', a.slice(8)); continue; }
		if (a === '-q' || a === '--quiet' || a === '--silent') { quiet = true; continue; }
		if (a === '-v' || a === '--verbose') { verbose = true; continue; }
		if (a === '-z' || a === '--zero-terminated') { zero = true; continue; }
		if (/^-n-?\d+$/.test(a)) { take('lines', a.slice(2)); continue; }
		if (/^-c-?\d+$/.test(a)) { take('bytes', a.slice(2)); continue; }
		if (/^-\d+$/.test(a)) { take('lines', a.slice(1)); continue; }
		return null;
	}
	if (!negative && !zero) { return null; }
	if (unit === null) { unit = 'lines'; count = 10; }
	return { unit, count, negative, quiet, verbose, zero, files };
}

/** The first `count` lines (or bytes) of a byte string; a line ends in NUL when `zero`. */
function takeFirst(bytes, unit, count, zero) {
	if (unit === 'bytes') { return bytes.subarray(0, Math.min(bytes.length, count)); }
	const sep = zero ? 0 : 10;
	let seen = 0;
	for (let i = 0; i < bytes.length; i++) {
		if (bytes[i] === sep && ++seen === count) { return bytes.subarray(0, i + 1); }
	}
	return count === 0 ? bytes.subarray(0, 0) : bytes;
}

/** All but the last `count` lines (or bytes) of a byte string. */
function dropLast(bytes, unit, count, zero) {
	if (unit === 'bytes') { return bytes.subarray(0, Math.max(0, bytes.length - count)); }
	const sep = zero ? 0 : 10;
	// the lines of the input, each with its terminator; an unterminated last line is a line too
	let ends = [];
	for (let i = 0; i < bytes.length; i++) { if (bytes[i] === sep) { ends.push(i + 1); } }
	if (bytes.length && bytes[bytes.length - 1] !== sep) { ends.push(bytes.length); }
	const keep = Math.max(0, ends.length - count);
	return bytes.subarray(0, keep === 0 ? 0 : ends[keep - 1]);
}

/**
 * `tail -c +N` (from byte N on, counting from 1): the engine took it for "the last N bytes" and printed `f` for
 * `printf abcdef | tail -c +1`. `-n +N` is the engine's own and right.
 *
 * @param {string[]} args
 * @returns {null | { from: number, quiet: boolean, verbose: boolean, files: string[] }}
 */
function parseTailFrom(args) {
	let from = null;
	let quiet = false;
	let verbose = false;
	const files = [];
	let afterDashes = false;
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (afterDashes || a === '-' || !a.startsWith('-')) { files.push(a); continue; }
		if (a === '--') { afterDashes = true; continue; }
		let v = null;
		if (a === '--bytes') { v = args[++i]; } else if (a.startsWith('--bytes=')) { v = a.slice(8); } else if (a === '--quiet' || a === '--silent') { quiet = true; continue; } else if (a === '--verbose') { verbose = true; continue; } else if (a.startsWith('--')) { return null; } else {
			// a cluster of short options (-qc +2): q and v are flags, c takes the rest of the cluster or the next argument
			for (let c = 1; c < a.length; c++) {
				if (a[c] === 'q') { quiet = true; } else if (a[c] === 'v') { verbose = true; } else if (a[c] === 'c') { v = a.slice(c + 1) !== '' ? a.slice(c + 1) : args[++i]; break; } else { return null; }
			}
			if (v === null) { continue; }
		}
		const m = /^\+(\d+)$/.exec(String(v));
		if (!m) { return null; }
		from = Number(m[1]);
	}
	return from === null ? null : { from, quiet, verbose, files };
}

/**
 * stat -c with the time fields the engine prints literally. `%Y` is the modification time in seconds, `%y` as
 * `2020-05-06 07:08:09.000000000 +0000` in the zone `tz` (the TZ of the command, UTC when it has none); access and
 * status times are the modification time (nothing is tracked).
 *
 * @param {string} format
 * @param {number} mtimeMs
 * @param {string} [tz]
 */
function statTimeFormat(format, mtimeMs, tz = 'UTC') {
	const secs = Math.floor(mtimeMs / 1000);
	const p = zone.partsAt(secs * 1000, tz);
	const pad = (n, w = 2) => String(n).padStart(w, '0');
	const off = Math.round(p.offsetMs / 60000);
	const human = `${pad(p.year, 4)}-${pad(p.month + 1)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}.${pad(((mtimeMs % 1000) + 1000) % 1000 * 1000000, 9)} ${off < 0 ? '-' : '+'}${pad(Math.floor(Math.abs(off) / 60))}${pad(Math.abs(off) % 60)}`;
	let out = '';
	for (let i = 0; i < format.length; i++) {
		if (format[i] !== '%') { out += format[i]; continue; }
		const n = format[i + 1];
		if (n === '%') { out += '%%'; i++; continue; }          // kept: the caller turns %% into a percent sign
		if (n === 'Y' || n === 'X' || n === 'Z') { out += String(secs); i++; continue; }
		if (n === 'y' || n === 'x' || n === 'z') { out += human; i++; continue; }
		if (n === 'W') { out += '0'; i++; continue; }
		if (n === 'w') { out += '-'; i++; continue; }
		out += '%';
	}
	return out;
}

/**
 * Parses a stat command line: the format (-c / --format=, --printf= is left to the engine) and the files.
 * @param {string[]} args
 */
function parseStat(args) {
	let format = null;
	const files = [];
	const other = [];
	let afterDashes = false;
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (afterDashes || a === '-' || !a.startsWith('-')) { files.push(a); continue; }
		if (a === '--') { afterDashes = true; continue; }
		if (a === '-c' || a === '--format') { format = args[++i]; continue; }
		if (a.startsWith('--format=')) { format = a.slice(9); continue; }
		if (/^-c.+/.test(a)) { format = a.slice(2); continue; }
		other.push(a);
	}
	return { format, files, other };
}

/**
 * wc pads its numbers to a width the engine does not use. GNU: 7 for standard input with several counts, no padding
 * for one count, and for files the number of digits of the sum of their sizes (so `wc -l a b` right-aligns to the
 * size of the pair).
 *
 * @param {string} out the engine's output
 * @param {number} fileOperands how many names were given
 * @param {number | null} totalSize the sum of the sizes of the files named, or null when not every one is a file
 */
function wcWidth(out, fileOperands, totalSize) {
	const lines = out.split('\n');
	if (lines[lines.length - 1] === '') { lines.pop(); }
	const parsed = lines.map((l) => /^\s*((?:\d+\s+)*\d+)(?:\s+(.*))?$/.exec(l));
	if (!parsed.length || parsed.some((m) => !m)) { return out; }
	const cols = /** @type {any} */ (parsed[0])[1].trim().split(/\s+/).length;
	let width;
	if (fileOperands === 0) { width = cols > 1 ? 7 : 1; } else if (fileOperands === 1 && cols === 1) { width = 1; } else if (totalSize !== null) { width = String(totalSize).length; } else { width = 7; }
	return parsed.map((m) => {
		const [, nums, name] = /** @type {any} */ (m);
		return nums.trim().split(/\s+/).map((n) => n.padStart(width, ' ')).join(' ') + (name !== undefined ? ' ' + name : '');
	}).join('\n') + '\n';
}

/* ------------------------------------------------------------------------------------------------------------ */
/* od                                                                                                            */
/* ------------------------------------------------------------------------------------------------------------ */

const NAMED = ['nul', 'soh', 'stx', 'etx', 'eot', 'enq', 'ack', 'bel', 'bs', 'ht', 'nl', 'vt', 'ff', 'cr', 'so', 'si', 'dle', 'dc1', 'dc2', 'dc3', 'dc4', 'nak', 'syn', 'etb', 'can', 'em', 'sub', 'esc', 'fs', 'gs', 'rs', 'us', 'sp'];
const ESCAPES = { 0: '\\0', 7: '\\a', 8: '\\b', 9: '\\t', 10: '\\n', 11: '\\v', 12: '\\f', 13: '\\r' };

/** @typedef {{ kind: 'a' | 'c' | 'd' | 'o' | 'u' | 'x', size: number, z: boolean }} OdType */

function parseOdType(spec) {
	/** @type {OdType[]} */
	const out = [];
	for (let i = 0; i < spec.length;) {
		const kind = spec[i++];
		if (kind === 'a' || kind === 'c') {
			let z = false;
			if (spec[i] === 'z') { z = true; i++; }
			out.push({ kind, size: 1, z });
			continue;
		}
		if (!'doux'.includes(kind)) { throw new Error(`invalid type string '${spec}'`); }
		let size = 0;
		const digits = /^\d+/.exec(spec.slice(i));
		if (digits) { size = Number(digits[0]); i += digits[0].length; } else if (spec[i] === 'C') { size = 1; i++; } else if (spec[i] === 'S') { size = 2; i++; } else if (spec[i] === 'I') { size = 4; i++; } else if (spec[i] === 'L') { size = 8; i++; } else { size = 4; }
		if (![1, 2, 4, 8].includes(size)) { throw new Error(`invalid type string '${spec}'`); }
		let z = false;
		if (spec[i] === 'z') { z = true; i++; }
		out.push({ kind: /** @type {any} */ (kind), size, z });
	}
	if (!out.length) { throw new Error(`invalid type string '${spec}'`); }
	return out;
}

/** The width of one printed unit, as GNU od sets it (the unit is preceded by one space). */
function fieldWidth(t) {
	if (t.kind === 'a' || t.kind === 'c') { return 3; }
	const w = { o: { 1: 3, 2: 6, 4: 11, 8: 22 }, x: { 1: 2, 2: 4, 4: 8, 8: 16 }, u: { 1: 3, 2: 5, 4: 10, 8: 20 }, d: { 1: 4, 2: 6, 4: 11, 8: 20 } };
	return w[t.kind][t.size];
}

function formatUnit(t, bytes, at) {
	if (t.kind === 'a') {
		const b = bytes[at] & 0x7f;
		return b < 33 ? NAMED[b] : (b === 127 ? 'del' : String.fromCharCode(b));
	}
	if (t.kind === 'c') {
		const b = bytes[at];
		if (Object.prototype.hasOwnProperty.call(ESCAPES, b)) { return ESCAPES[b]; }
		if (b >= 32 && b < 127) { return String.fromCharCode(b); }
		return b.toString(8).padStart(3, '0');
	}
	let v = 0n;
	for (let k = t.size - 1; k >= 0; k--) { v = (v << 8n) | BigInt(at + k < bytes.length ? bytes[at + k] : 0); }
	if (t.kind === 'd') {
		const bits = BigInt(t.size * 8);
		if (v >= 1n << (bits - 1n)) { v -= 1n << bits; }
		return v.toString(10);
	}
	const s = v.toString(t.kind === 'o' ? 8 : t.kind === 'x' ? 16 : 10);
	return t.kind === 'u' ? s : s.padStart(fieldWidth(t), '0');
}

/**
 * GNU od (the subset people use): -A d|o|x|n, -t TYPE, -a -b -c -d -o -s -x -i -l, -j N, -N N, -v, -w[N].
 * Units are little-endian, as on the machines GNU od is run on.
 *
 * @param {string[]} args
 * @param {() => Promise<Uint8Array | string>} readStdin a string is one byte per character
 * @param {(path: string) => Promise<Uint8Array>} readFile
 * @returns {Promise<{ stdout: string, stderr: string, exitCode: number }>}
 */
async function od(args, readStdin, readFile) {
	const fail = (msg) => ({ stdout: '', stderr: `od: ${msg}\n`, exitCode: 1 });
	let radix = 'o';
	/** @type {OdType[]} */
	const types = [];
	let skip = 0;
	let limit = Infinity;
	let verbose = false;
	let width = 16;
	const files = [];
	const num = (s, what) => {
		const m = /^(0x[0-9a-f]+|0[0-7]*|\d+)(b|k|KB|K|m|MB|M|G|GB)?$/i.exec(s);
		if (!m) { throw new Error(`invalid ${what} argument '${s}'`); }
		const lit = m[1].toLowerCase();
		let n = lit.startsWith('0x') ? parseInt(lit, 16) : (lit.length > 1 && lit[0] === '0' ? parseInt(lit, 8) : parseInt(lit, 10));
		const mult = { b: 512, k: 1024, K: 1024, KB: 1000, m: 1048576, M: 1048576, MB: 1000000, G: 1073741824, GB: 1000000000 }[m[2] || ''];
		if (mult) { n *= mult; }
		return n;
	};
	try {
		for (let i = 0; i < args.length; i++) {
			const a = args[i];
			if (a === '--') { files.push(...args.slice(i + 1)); break; }
			if (a === '-' || !a.startsWith('-')) { files.push(a); continue; }
			if (a.startsWith('--')) {
				const eq = a.indexOf('=');
				const name = eq < 0 ? a : a.slice(0, eq);
				const val = () => (eq >= 0 ? a.slice(eq + 1) : args[++i]);
				if (name === '--address-radix') { radix = val(); } else if (name === '--format') { types.push(...parseOdType(val())); } else if (name === '--skip-bytes') { skip = num(val(), 'skip'); } else if (name === '--read-bytes') { limit = num(val(), 'limit'); } else if (name === '--output-duplicates') { verbose = true; } else if (name === '--width') { width = eq >= 0 ? num(a.slice(eq + 1), 'width') : 32; } else if (name === '--traditional' || name === '--endian') { /* ignored */ } else { return fail(`unrecognized option '${a}'`); }
				continue;
			}
			for (let c = 1; c < a.length; c++) {
				const ch = a[c];
				const rest = a.slice(c + 1);
				const value = () => (rest !== '' ? rest : args[++i]);
				if (ch === 'A') { radix = value(); break; }
				if (ch === 't') { types.push(...parseOdType(String(value()))); break; }
				if (ch === 'j') { skip = num(String(value()), 'skip'); break; }
				if (ch === 'N') { limit = num(String(value()), 'limit'); break; }
				if (ch === 'w') { width = rest !== '' ? num(rest, 'width') : 32; break; }
				if (ch === 'v') { verbose = true; continue; }
				const shortcut = { a: 'a', b: 'o1', c: 'c', d: 'u2', o: 'o2', s: 'd2', x: 'x2', i: 'd4', l: 'd8' }[ch];
				if (!shortcut) { return fail(`invalid option -- '${ch}'`); }
				types.push(...parseOdType(shortcut));
			}
		}
		if (!'donx'.includes(radix) || radix.length !== 1) { return fail(`invalid output address radix '${radix}'; it must be one character from [doxn]`); }
		if (!types.length) { types.push(...parseOdType('o2')); }
		if (!(width > 0)) { return fail('invalid width'); }
	} catch (e) {
		return fail(e.message);
	}
	// input: the concatenation of the files (or stdin)
	const parts = [];
	let stderr = '';
	let exitCode = 0;
	let opened = 0;
	for (const f of files.length ? files : ['-']) {
		try {
			if (f === '-') {
				const s = await readStdin();
				parts.push(typeof s === 'string' ? Uint8Array.from(s, (ch) => ch.charCodeAt(0) & 0xff) : s);
			} else {
				parts.push(await readFile(f));
			}
			opened++;
		} catch (e) {
			const why = String(e && (e.code || e.message));
			stderr += `od: ${f}: ${/ENOENT/.test(why) ? 'No such file or directory' : /EISDIR/.test(why) ? 'Is a directory' : 'cannot be read'}\n`;
			exitCode = 1;
		}
	}
	if (!opened) { return { stdout: '', stderr, exitCode }; }
	let total = 0;
	for (const p of parts) { total += p.length; }
	const all = new Uint8Array(total);
	let o = 0;
	for (const p of parts) { all.set(p, o); o += p.length; }
	if (skip > total) { return { stdout: '', stderr: stderr + 'od: cannot skip past end of combined input\n', exitCode: 1 }; }
	const data = all.subarray(Math.min(skip, all.length), limit === Infinity ? all.length : Math.min(all.length, skip + limit));
	// the widest unit decides: a row holds a whole number of them
	const maxSize = Math.max(...types.map((t) => t.size));
	if (width % maxSize !== 0) {
		// GNU does not round: it warns and uses the width of the widest type
		stderr += `od: warning: invalid width ${width}; using ${maxSize} instead\n`;
		width = maxSize;
	}
	// every type is printed over the same width: the widest of them sets it, and the units of each are spread over it
	const unitsPerRow = (t) => Math.ceil(width / t.size);
	const rowWidth = Math.max(...types.map((t) => unitsPerRow(t) * (fieldWidth(t) + 1)));
	const addr = (n) => {
		if (radix === 'n') { return ''; }
		return n.toString(radix === 'd' ? 10 : radix === 'o' ? 8 : 16).padStart(radix === 'x' ? 6 : 7, '0');
	};
	let out = '';
	let prevRow = null;
	let starred = false;
	for (let at = 0; at < data.length; at += width) {
		const row = data.subarray(at, Math.min(data.length, at + width));
		if (!verbose && prevRow && row.length === prevRow.length && bytesEqual(row, prevRow)) {
			if (!starred) { out += '*\n'; starred = true; }
			continue;
		}
		starred = false;
		prevRow = row;
		const lines = [];
		for (const t of types) {
			let line = '';
			const n = unitsPerRow(t);
			const units = Math.ceil(row.length / t.size);
			for (let u = 0; u < units; u++) {
				const text = formatUnit(t, row, u * t.size);
				line += text.padStart(Math.ceil((u + 1) * rowWidth / n) - Math.ceil(u * rowWidth / n), ' ');
			}
			if (t.z) {
				line = line.padEnd(rowWidth, ' ') + '  >' + Array.from(row, (b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '.')).join('') + '<';
			}
			lines.push(line);
		}
		const a = addr(at);
		lines.forEach((l, k) => { out += (k === 0 ? a : ' '.repeat(a.length)) + l + '\n'; });
	}
	if (radix !== 'n') { out += addr(data.length) + '\n'; }
	return { stdout: out, stderr, exitCode };
}

function bytesEqual(a, b) {
	if (a.length !== b.length) { return false; }
	for (let i = 0; i < a.length; i++) { if (a[i] !== b[i]) { return false; } }
	return true;
}

/* ------------------------------------------------------------------------------------------------------------ */
/* small commands                                                                                                */
/* ------------------------------------------------------------------------------------------------------------ */

const UNAME = { s: 'Linux', n: 'localhost', r: '5.15.0', v: '#1 SMP', m: 'x86_64', p: 'x86_64', i: 'x86_64', o: 'GNU/Linux' };

/** @param {string[]} args @param {string} nodename */
function uname(args, nodename) {
	const want = new Set();
	for (const a of args) {
		if (a === '-a' || a === '--all') { for (const k of 'snrvmpio') { want.add(k); } continue; }
		const long = { '--kernel-name': 's', '--nodename': 'n', '--kernel-release': 'r', '--kernel-version': 'v', '--machine': 'm', '--processor': 'p', '--hardware-platform': 'i', '--operating-system': 'o' }[a];
		if (long) { want.add(long); continue; }
		if (/^-[snrvmpio]+$/.test(a)) { for (const k of a.slice(1)) { want.add(k); } continue; }
		return { stdout: '', stderr: `uname: ${a.startsWith('--') ? 'unrecognized option' : 'invalid option'} '${a}'\n`, exitCode: 1 };
	}
	if (!want.size) { want.add('s'); }
	const parts = [];
	for (const k of 'snrvmpio') { if (want.has(k)) { parts.push(k === 'n' ? nodename : UNAME[k]); } }
	return { stdout: parts.join(' ') + '\n', stderr: '', exitCode: 0 };
}

/** @param {string[]} args */
function id(args) {
	const user = 'user';
	let mode = '';
	let name = false;
	const operands = [];
	for (const a of args) {
		if (/^-[ugGnr]+$/.test(a)) {
			for (const ch of a.slice(1)) { if (ch === 'n') { name = true; } else if (ch !== 'r') { mode = ch; } }
		} else if (a.startsWith('-')) { return { stdout: '', stderr: `id: invalid option -- '${a.replace(/^-+/, '')}'\n`, exitCode: 1 }; } else { operands.push(a); }
	}
	if (operands.length && operands[0] !== user) { return { stdout: '', stderr: `id: '${operands[0]}': no such user\n`, exitCode: 1 }; }
	if (mode === 'u' || mode === 'g' || mode === 'G') { return { stdout: (name ? user : '1000') + '\n', stderr: '', exitCode: 0 }; }
	return { stdout: 'uid=1000(user) gid=1000(user) groups=1000(user)\n', stderr: '', exitCode: 0 };
}

/**
 * realpath: all components but the last must exist (-e: all of them, -m: none).
 * @param {string[]} args
 * @param {{ cwd: string, resolve(base: string, p: string): string, exists(p: string): Promise<boolean> }} io
 */
async function realpath(args, io) {
	let mode = 'default';
	let quiet = false;
	let zero = false;
	let relativeTo = null;
	const operands = [];
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (a === '--') { operands.push(...args.slice(i + 1)); break; }
		if (a === '-e' || a === '--canonicalize-existing') { mode = 'e'; } else if (a === '-m' || a === '--canonicalize-missing') { mode = 'm'; } else if (a === '-s' || a === '--strip' || a === '--no-symlinks' || a === '-L' || a === '-P' || a === '--logical' || a === '--physical') { /* no links here */ } else if (a === '-q' || a === '--quiet') { quiet = true; } else if (a === '-z' || a === '--zero') { zero = true; } else if (a.startsWith('--relative-to=')) { relativeTo = a.slice(14); } else if (a === '--relative-to') { relativeTo = args[++i]; } else if (a === '--relative-base') { i++; } else if (a.startsWith('--relative-base=')) { /* ignored */ } else if (a.startsWith('-') && a !== '-') { return { stdout: '', stderr: `realpath: invalid option -- '${a.replace(/^-+/, '')}'\n`, exitCode: 1 }; } else { operands.push(a); }
	}
	if (!operands.length) { return { stdout: '', stderr: 'realpath: missing operand\n', exitCode: 1 }; }
	let out = '';
	let err = '';
	let rc = 0;
	for (const op of operands) {
		const abs = io.resolve(io.cwd, op);
		let ok = true;
		if (mode === 'e') { ok = await io.exists(abs); } else if (mode === 'default') { ok = abs === '/' || await io.exists(io.resolve(abs, '..')); }
		if (!ok) {
			rc = 1;
			if (!quiet) { err += `realpath: ${op}: No such file or directory\n`; }
			continue;
		}
		let shown = abs;
		if (relativeTo !== null) {
			const base = io.resolve(io.cwd, relativeTo).split('/').filter(Boolean);
			const tgt = abs.split('/').filter(Boolean);
			let k = 0;
			while (k < base.length && k < tgt.length && base[k] === tgt[k]) { k++; }
			shown = [...Array(base.length - k).fill('..'), ...tgt.slice(k)].join('/') || '.';
		}
		out += shown + (zero ? '\0' : '\n');
	}
	return { stdout: out, stderr: err, exitCode: rc };
}

/**
 * cmp [-s] [-l] FILE1 FILE2
 * @param {string[]} args
 * @param {(p: string) => Promise<Uint8Array>} read
 */
async function cmp(args, read) {
	let silent = false;
	let list = false;
	const files = [];
	for (const a of args) {
		if (a === '-s' || a === '--quiet' || a === '--silent') { silent = true; } else if (a === '-l' || a === '--verbose') { list = true; } else if (a.startsWith('-') && a !== '-') { return { stdout: '', stderr: `cmp: invalid option -- '${a.replace(/^-+/, '')}'\n`, exitCode: 2 }; } else { files.push(a); }
	}
	if (files.length < 2) { return { stdout: '', stderr: files.length ? `cmp: missing operand after '${files[0]}'\n` : 'cmp: missing operand\n', exitCode: 2 }; }
	let a;
	let b;
	try { a = await read(files[0]); } catch { return { stdout: '', stderr: `cmp: ${files[0]}: No such file or directory\n`, exitCode: 2 }; }
	try { b = await read(files[1]); } catch { return { stdout: '', stderr: `cmp: ${files[1]}: No such file or directory\n`, exitCode: 2 }; }
	const n = Math.min(a.length, b.length);
	// the byte numbers of -l are as wide as the digits of the smaller file (a pipe has no size to count)
	const sized = [files[0] === '-' ? null : a.length, files[1] === '-' ? null : b.length].filter((x) => x !== null);
	const width = String(sized.length ? Math.min(...sized) : Math.max(a.length, b.length)).length;
	let out = '';
	let differ = false;
	let line = 1;
	for (let i = 0; i < n; i++) {
		if (a[i] !== b[i]) {
			differ = true;
			if (silent) { return { stdout: '', stderr: '', exitCode: 1 }; }
			if (!list) { return { stdout: `${files[0]} ${files[1]} differ: byte ${i + 1}, line ${line}\n`, stderr: '', exitCode: 1 }; }
			out += `${String(i + 1).padStart(width)} ${a[i].toString(8).padStart(3)} ${b[i].toString(8).padStart(3)}\n`;
		}
		if (a[i] === 10) { line++; }
	}
	if (a.length !== b.length) {
		if (silent) { return { stdout: '', stderr: '', exitCode: 1 }; }
		const shorter = a.length < b.length ? files[0] : files[1];
		return { stdout: out, stderr: `cmp: EOF on ${shorter} after byte ${n}${list ? '' : `, in line ${line}`}\n`, exitCode: 1 };
	}
	return { stdout: out, stderr: '', exitCode: differ ? 1 : 0 };
}

/* ------------------------------------------------------------------------------------------------------------ */
/* du                                                                                                            */
/* ------------------------------------------------------------------------------------------------------------ */

/** What a file system with 4 KiB blocks reports: a file takes whole blocks, a directory is one. */
const DU_BLOCK = 4096;

/**
 * GNU's -h / -H: the size in the largest unit that keeps it under 1024 (1000), rounded UP, one decimal below 10.
 * @param {number} bytes
 * @param {number} base 1024, or 1000 for --si
 */
function humanSize(bytes, base = 1024) {
	if (bytes < base) { return String(bytes); }
	let v = bytes / base;
	let u = 0;
	const units = [base === 1000 ? 'k' : 'K', 'M', 'G', 'T', 'P', 'E', 'Z', 'Y'];
	while (v >= base && u < units.length - 1) { v /= base; u++; }
	const t = Math.ceil(v * 10) / 10;
	if (t >= base) { return Math.ceil(v / base) + units[Math.min(u + 1, units.length - 1)]; }
	return (t < 10 ? t.toFixed(1) : String(Math.ceil(v))) + units[u];
}

/** A -B / --block-size argument (`1K`, `4096`, `1MB`, `M`) in bytes, or null. */
function parseBlockSize(text) {
	const m = /^(\d*)([KMGTPEZY]?)(iB|B)?$/i.exec(String(text));
	if (!m || (m[1] === '' && m[2] === '') || (m[2] === '' && m[3])) { return null; }
	const exp = m[2] === '' ? 0 : 'KMGTPEZY'.indexOf(m[2].toUpperCase()) + 1;
	// KB, MB are powers of 1000; K, KiB, M, MiB of 1024
	const base = m[3] && m[3].toUpperCase() === 'B' && !/i/i.test(m[3]) ? 1000 : 1024;
	const n = (m[1] === '' ? 1 : Number(m[1])) * base ** exp;
	return n > 0 ? n : null;
}

/**
 * du, with the numbers of a file system that has 4 KiB blocks (the engine printed bytes divided by 1024, nothing for
 * `-s FILE`, and had no `-h`/`-k`): disk usage in 1 KiB blocks by default, apparent size with `-b`/`--apparent-size`.
 *
 * @param {string[]} args
 * The walk is bounded like the engine's own (find, ls -R, grep -r): more than `traversal.entries` entries or a tree
 * deeper than `traversal.depth` ends the script with the engine's wording (`du: filesystem traversal entry limit
 * exceeded (100000)`), which the core reports as a limit.
 *
 * @param {{ cwd: string, stat(p: string): Promise<{ isFile: boolean, isDirectory: boolean, size: number } | null>, readdir(p: string): Promise<string[]>, resolve(base: string, p: string): string, traversal?: { entries?: number, depth?: number, exceeded(message: string): Error } }} io
 * @returns {Promise<{ stdout: string, stderr: string, exitCode: number }>}
 */
async function du(args, io) {
	const fail = (msg) => ({ stdout: '', stderr: `du: ${msg}\n`, exitCode: 1 });
	let all = false;
	let summarize = false;
	let human = 0;
	let apparent = false;
	let total = false;
	let maxDepth = Infinity;
	let block = 1024;
	let nul = false;
	const operands = [];
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (a === '--') { operands.push(...args.slice(i + 1)); break; }
		if (a === '-' || !a.startsWith('-')) { operands.push(a); continue; }
		if (a.startsWith('--')) {
			const eq = a.indexOf('=');
			const name = eq < 0 ? a : a.slice(0, eq);
			const value = () => (eq >= 0 ? a.slice(eq + 1) : args[++i]);
			if (name === '--all') { all = true; } else if (name === '--summarize') { summarize = true; } else if (name === '--human-readable') { human = 1024; } else if (name === '--si') { human = 1000; } else if (name === '--total') { total = true; } else if (name === '--apparent-size') { apparent = true; } else if (name === '--bytes') { apparent = true; block = 1; human = 0; } else if (name === '--null') { nul = true; } else if (name === '--one-file-system' || name === '--dereference' || name === '--dereference-args' || name === '--separate-dirs' || name === '--count-links') { /* one file system, no links */ } else if (name === '--max-depth') {
				const d = Number(value());
				if (!Number.isInteger(d) || d < 0) { return fail(`invalid maximum depth '${a.slice(eq + 1)}'`); }
				maxDepth = d;
			} else if (name === '--block-size') {
				const b = parseBlockSize(value());
				if (b === null) { return fail(`invalid --block-size argument '${a.slice(eq + 1)}'`); }
				block = b;
				human = 0;
			} else { return { stdout: '', stderr: `du: unrecognized option '${a}'\n`, exitCode: 1 }; }
			continue;
		}
		for (let c = 1; c < a.length; c++) {
			const ch = a[c];
			if (ch === 'a') { all = true; } else if (ch === 's') { summarize = true; } else if (ch === 'h') { human = 1024; } else if (ch === 'H') { human = 1000; } else if (ch === 'k') { block = 1024; human = 0; } else if (ch === 'm') { block = 1048576; human = 0; } else if (ch === 'b') { apparent = true; block = 1; human = 0; } else if (ch === 'c') { total = true; } else if (ch === '0') { nul = true; } else if (ch === 'x' || ch === 'L' || ch === 'P' || ch === 'S' || ch === 'l') { /* one file system, no links */ } else if (ch === 'd' || ch === 'B') {
				const rest = a.slice(c + 1);
				const v = rest !== '' ? rest : args[++i];
				if (ch === 'd') {
					const d = Number(v);
					if (!Number.isInteger(d) || d < 0) { return fail(`invalid maximum depth '${v}'`); }
					maxDepth = d;
				} else {
					const b = parseBlockSize(v);
					if (b === null) { return fail(`invalid --block-size argument '${v}'`); }
					block = b;
					human = 0;
				}
				break;
			} else { return { stdout: '', stderr: `du: invalid option -- '${ch}'\n`, exitCode: 1 }; }
		}
	}
	if (summarize) { maxDepth = 0; }
	const eol = nul ? '\0' : '\n';
	const show = (bytes) => (human ? humanSize(bytes, human) : String(Math.ceil(bytes / block)));
	let out = '';
	let err = '';
	let rc = 0;
	let grand = 0;
	/** what was counted already: a second operand inside the first is not counted twice (GNU keeps the inodes it saw) */
	const seen = new Set();
	const budget = io.traversal;
	let visited = 0;
	/** @returns {Promise<number>} the usage of p, printing what is asked for on the way */
	const walk = async (p, shown, depth, top) => {
		if (seen.has(p)) { return 0; }
		seen.add(p);
		if (budget) {
			if (typeof budget.depth === 'number' && depth > budget.depth) { throw budget.exceeded(`du: filesystem traversal depth limit exceeded (${budget.depth})`); }
			if (typeof budget.entries === 'number' && ++visited > budget.entries) { throw budget.exceeded(`du: filesystem traversal entry limit exceeded (${budget.entries})`); }
		}
		const st = await io.stat(p);
		if (!st) { return 0; }
		const own = st.isDirectory ? DU_BLOCK : (apparent ? st.size : Math.ceil(st.size / DU_BLOCK) * DU_BLOCK);
		let sum = apparent && st.isDirectory ? DU_BLOCK : own;
		if (st.isDirectory) {
			for (const name of await io.readdir(p)) {
				sum += await walk(io.resolve(p, name), (shown.endsWith('/') ? shown : shown + '/') + name, depth + 1, false);
			}
		}
		if (depth <= maxDepth && (st.isDirectory || all || top)) { out += `${show(sum)}\t${shown}${eol}`; }
		return sum;
	};
	for (const op of operands.length ? operands : ['.']) {
		const p = io.resolve(io.cwd, op);
		if (!(await io.stat(p))) {
			err += `du: cannot access '${op}': No such file or directory\n`;
			rc = 1;
			continue;
		}
		grand += await walk(p, op, 0, true);
	}
	if (total) { out += `${show(grand)}\ttotal${eol}`; }
	return { stdout: out, stderr: err, exitCode: rc };
}

/* ------------------------------------------------------------------------------------------------------------ */
/* ls                                                                                                            */
/* ------------------------------------------------------------------------------------------------------------ */

/**
 * ls. The engine has no `--color[=WHEN]` (dropped: there is no terminal) and no `-p` (a slash after a directory). `-p`
 * is the engine's `-F` with the `*` of executables taken off the end of each name, which `-p` does not print.
 *
 * @param {string[]} args
 * @returns {{ args: string[], slashOnly: boolean }}
 */
function normaliseLs(args) {
	const out = [];
	let slashOnly = false;
	let classify = false;
	let afterDashes = false;
	for (const a of args) {
		if (afterDashes || a === '-' || !a.startsWith('-')) { out.push(a); continue; }
		if (a === '--') { afterDashes = true; out.push(a); continue; }
		if (a.startsWith('--')) {
			const name = a.split('=')[0];
			if (name === '--color' || name === '--colour') { continue; }
			if (a === '--indicator-style=slash' || a === '--file-type') { slashOnly = true; out.push('-F'); continue; }
			if (a === '--classify' || a === '--classify=always') { classify = true; out.push('-F'); continue; }
			out.push(a);
			continue;
		}
		if (a.includes('F')) { classify = true; }
		const m = a.includes('p') ? mapCluster(a, { p: 'F' }) : a;
		if (a.includes('p')) { slashOnly = true; }
		if (m) { out.push(m); }
	}
	return { args: out, slashOnly: slashOnly && !classify };
}

/**
 * The `total N` line of a long listing is the disk usage of what is listed, in 1 KiB blocks of a 4 KiB-block file system
 * (the engine printed the bytes divided by 4096, rounded up: `total 3` for 5000 + 4096 + 2 bytes, GNU says 16). Every
 * section (`ls -l a b` has one each) is summed from its own lines; a section whose sizes are not numbers (`-h`) keeps
 * the engine's line.
 *
 * @param {string} out
 */
function lsTotals(out) {
	const lines = out.split('\n');
	let at = -1;
	let sum = 0;
	let numeric = true;
	const close = () => { if (at >= 0 && numeric) { lines[at] = 'total ' + sum; } at = -1; };
	for (let i = 0; i < lines.length; i++) {
		const l = lines[i];
		if (/^total \d+$/.test(l)) { close(); at = i; sum = 0; numeric = true; continue; }
		if (at < 0) { continue; }
		if (l === '') { close(); continue; }
		const m = /^([-dl])[-rwxsStT]{9} +\d+ +\S+ +\S+ +(\d+) /.exec(l);
		if (m) {
			sum += m[1] === 'd' ? 4 : Math.ceil(Number(m[2]) / DU_BLOCK) * 4;
		} else if (/^[-dl][-rwxsStT]{9} /.test(l)) {
			numeric = false;
		}
	}
	close();
	return lines.join('\n');
}

/**
 * What `cp` and `mv` print, in GNU's words, for what the engine said in its own: its text carries the error code and
 * the syscall (`mv: cannot move 'd1': ENOTEMPTY: directory not empty, mv '/w/dst/d1'`).
 *
 * @param {string} stderr
 * @param {string} verb 'cp' | 'mv'
 * @param {string} cwd
 */
function gnuTransferErrors(stderr, verb, cwd) {
	const rel = (p) => (cwd !== '/' && p.startsWith(cwd + '/') ? p.slice(cwd.length + 1) : p);
	// mv copies and then removes, so the syscall of an error of its own may be the copy's
	const re = new RegExp(`^${verb}: cannot (?:copy|move) '(.*)': (ENOTEMPTY|ENOTDIR|EISDIR|EINVAL|EEXIST): [^,]*, (?:cp|mv) '(.*)'$`);
	const itself = new RegExp(`^${verb}: cannot (?:copy|move) '(.*)' into itself, '(.*)'$`);
	return stderr.split('\n').map((line) => {
		const same = itself.exec(line);
		if (same) {
			const to = rel(same[2]).replace(/(.)\/+$/, '$1');
			return verb === 'cp' ? `cp: cannot copy a directory, '${same[1]}', into itself, '${to}'` : `mv: cannot move '${same[1]}' to a subdirectory of itself, '${to}'`;
		}
		const m = re.exec(line);
		if (!m) { return line; }
		const [, src, code, path] = m;
		const dst = rel(path);
		if (code === 'ENOTEMPTY') { return `${verb}: cannot move '${src}' to '${dst}': Directory not empty`; }
		if (code === 'ENOTDIR') { return `${verb}: cannot overwrite non-directory '${dst}' with directory '${src}'`; }
		if (code === 'EISDIR') { return `${verb}: cannot overwrite directory '${dst}' with non-directory`; }
		if (code === 'EINVAL') { return verb === 'cp' ? `cp: cannot copy a directory, '${src}', into itself, '${dst}'` : `mv: cannot move '${src}' to a subdirectory of itself, '${dst}'`; }
		return line;
	}).join('\n');
}

/* ------------------------------------------------------------------------------------------------------------ */
/* the commands, for the engine                                                                                  */
/* ------------------------------------------------------------------------------------------------------------ */

/** A string of bytes (one char per byte) for a Uint8Array. */
function latin1(u8) {
	let s = '';
	for (let i = 0; i < u8.length; i += 0x2000) { s += String.fromCharCode.apply(null, /** @type {any} */ (u8.subarray(i, i + 0x2000))); }
	return s;
}

/**
 * `cp -v` and `mv -v` print `'a' -> 'b'` with the name as it was typed; the engine prints the resolved path of the
 * destination. The working directory is taken off the front again.
 * @param {{ stdout: string, stderr?: string }} r
 * @param {string} cwd
 */
function relativeVerbose(r, cwd) {
	if (!r.stdout || !r.stdout.includes("-> '")) { return r; }
	const prefix = (cwd === '/' ? '' : cwd) + '/';
	const stripped = r.stdout.split("-> '" + prefix).join("-> '");
	// `mv -v c d/` is printed with the slash of `d/` and the one it adds
	return Object.assign({}, r, { stdout: stripped.replace(/-> '([^']*)'/g, (_m, p) => "-> '" + p.replace(/\/{2,}/g, '/') + "'") });
}

/**
 * The engine prefixes a limit message with the program's name although the message has it already
 * (`sed: sed: command execution exceeded ...`).
 * @template {{ stderr?: string }} R
 * @param {R} r
 * @param {string} name
 * @returns {R}
 */
function withoutDoubledPrefix(r, name) {
	if (!r || !r.stderr || !r.stderr.includes(name + ': ' + name + ': ')) { return r; }
	return Object.assign({}, r, { stderr: r.stderr.split(name + ': ' + name + ': ').join(name + ': ') });
}

/**
 * @param {(name: string, execute: (args: string[], ctx: any) => Promise<any>) => any} defineCommand
 * @param {new (message: string, type: string) => Error} [LimitError] the engine's own limit error (what its find and
 *   grep -r throw when a traversal is too big, which ends the script and is a `limit`); without it a plain Error
 * @returns {any[]} custom commands, to hand to `new Bash({ customCommands })`
 */
function commands(defineCommand, LimitError) {
	const missingOriginal = (name) => ({ stdout: '', stderr: `${name}: internal error: the original program is not available\n`, exitCode: 1 });
	/** a built-in with its arguments normalised */
	const wrap = (name, fix) => defineCommand(name, async (args, ctx) => (ctx.origCommand ? ctx.origCommand(fix(args)) : missingOriginal(name)));
	const readBytes = (ctx) => async (p) => ctx.fs.readFileBuffer(ctx.fs.resolvePath(ctx.cwd, p));
	const abs = (ctx, p) => ctx.fs.resolvePath(ctx.cwd, p);
	const baseName = (p) => p.slice(p.lastIndexOf('/') + 1);
	const dirName = (p) => p.slice(0, p.lastIndexOf('/')) || '/';
	const statOrNull = async (ctx, p) => { try { return await ctx.fs.stat(p); } catch { return null; } };

	/**
	 * What GNU's cp and mv say before they copy or move anything, and the engine says differently or not at all:
	 *
	 *   * a source written with a trailing slash that is a FILE (`cp a/ b`, `mv a/ b`): "cannot stat 'a/': Not a
	 *     directory". The engine took the slash off. That source is reported and left out of what the engine gets
	 *   * a file onto itself (`mv a a`, `mv a ./a`, `mv a .`, `cp a a`): "'a' and 'a' are the same file", status 1
	 *     (`-n` makes it nothing). The engine did nothing and said nothing (mv), or named the resolved path (cp)
	 *   * one source and a destination that is not there: in a folder that is not there either (`cp a nodir/x`: the
	 *     engine says "cannot stat 'a'", and a is there), or below a file ("failed to access"), or written as `name/`
	 *   * -T / --no-target-directory (`noTarget`): the destination is the target itself, never a folder to put the
	 *     source into. `cp -rT d e` merges d's contents into e; `mv -T d e` renames d onto an EMPTY e; a file onto a
	 *     directory, and a third operand, are errors. The engine put d INSIDE e
	 *
	 * `name/` names a DIRECTORY that does not exist yet, and a directory source is copied or renamed to it (`cp -r d
	 * d2/`, `mv d d2/`: the commonest way to write either). Only a FILE source cannot be made into `name/` ("Not a
	 * directory"); a missing destination whose folder is there is the engine's own to handle.
	 *
	 * @param {any} ctx
	 * @param {string} verb 'cp' | 'mv'
	 * @param {string[]} norm the normalised arguments (options, then operands)
	 * @param {boolean} [noTarget] -T was given
	 * @returns {Promise<{ result: { stdout: string, stderr: string, exitCode: number } | null, args: string[], stderr: string }>}
	 *   `result` when the command is answered here; else the arguments for the engine and what to print before its output
	 */
	async function preflight(ctx, verb, norm, noTarget = false) {
		const at = [];
		const flags = [];
		let afterDashes = false;
		norm.forEach((a, i) => {
			if (!afterDashes && a === '--') { afterDashes = true; return; }
			if (!afterDashes && a.startsWith('-') && a !== '-') { flags.push(a); return; }
			at.push(i);
		});
		if (at.length < 2) { return { result: null, args: norm, stderr: '' }; }
		const noClobber = flags.some((f) => f === '--no-clobber' || /^-[A-Za-z]*n/.test(f));
		const verbose = flags.some((f) => f === '--verbose' || /^-[A-Za-z]*v/.test(f));
		let stderr = '';
		const dropped = new Set();
		for (const i of at.slice(0, -1)) {
			const src = norm[i];
			if (src.length < 2 || !src.endsWith('/')) { continue; }
			const st = await statOrNull(ctx, abs(ctx, src.replace(/\/+$/, '')));
			if (st && !st.isDirectory) { stderr += `${verb}: cannot stat '${src}': Not a directory\n`; dropped.add(i); }
		}
		const left = at.filter((i) => !dropped.has(i));
		if (left.length < 2 && dropped.size) { return { result: { stdout: '', stderr, exitCode: 1 }, args: norm, stderr }; }
		/** the arguments for the engine: the sources that were reported are gone, `over` replaces one operand */
		const build = (over) => norm.map((a, k) => (over && k === over.at ? over.text : a)).filter((_a, k) => !dropped.has(k));
		const args = build(null);
		const answer = (say, exitCode = 1, stdout = '') => ({ result: { stdout, stderr: stderr + say, exitCode }, args, stderr });
		if (noTarget && left.length > 2) { return answer(`${verb}: extra operand '${norm[left[2]]}'\nTry '${verb} --help' for more information.\n`); }
		if (left.length !== 2) { return { result: null, args, stderr }; }
		const src = norm[left[0]];
		const dest = norm[left[1]];
		const srcStat = await statOrNull(ctx, abs(ctx, src));
		if (!srcStat) { return { result: null, args, stderr }; }
		const destAbs = abs(ctx, dest.replace(/\/+$/, '') || '/');
		const there = await statOrNull(ctx, destAbs);
		if (there && there.isDirectory && !noTarget) {
			// into the folder: a file moved or copied to where it already is
			const into = ctx.fs.resolvePath(destAbs, baseName(abs(ctx, src)));
			if (!srcStat.isDirectory && into === abs(ctx, src)) {
				return noClobber ? answer('', 0) : answer(`${verb}: '${src}' and '${dest.replace(/\/+$/, '') || '/'}/${baseName(abs(ctx, src))}' are the same file\n`);
			}
		}
		if (there && (there.isDirectory || !dest.endsWith('/'))) {
			if (!srcStat.isDirectory && !there.isDirectory && destAbs === abs(ctx, src)) {
				return noClobber ? answer('', 0) : answer(`${verb}: '${src}' and '${dest}' are the same file\n`);
			}
			if (noTarget && there.isDirectory) {
				if (!srcStat.isDirectory) { return answer(`${verb}: cannot overwrite directory '${dest}' with non-directory\n`); }
				if (verb === 'cp') {
					// the contents of the source, into the destination: the engine's `src/.` form (without -r it says what GNU does)
					if (!flags.some((f) => f === '--recursive' || /^-[A-Za-z]*[rR]/.test(f))) { return { result: null, args, stderr }; }
					return { result: null, args: build({ at: left[0], text: src.replace(/\/+$/, '') + '/.' }), stderr };
				}
				if ((await ctx.fs.readdir(destAbs)).length) { return answer(`mv: cannot move '${src}' to '${dest}': Directory not empty\n`); }
				try {
					await ctx.fs.mv(abs(ctx, src), destAbs);
				} catch (e) {
					return answer(`mv: cannot move '${src}' to '${dest}': ${String(e && e.message).replace(/^[A-Z]+: /, '').replace(/,.*$/, '')}\n`);
				}
				return answer('', 0, verbose ? `renamed '${src}' -> '${dest}'\n` : '');
			}
			return { result: null, args, stderr };
		}
		const parent = there ? null : await statOrNull(ctx, dirName(destAbs));
		if (parent && parent.isDirectory && (!dest.endsWith('/') || srcStat.isDirectory)) { return { result: null, args, stderr }; }
		// the nearest ancestor that exists: a file anywhere on the way makes the whole path "Not a directory"
		let up = dirName(destAbs);
		let near = parent;
		while (!near && up !== '/') { up = dirName(up); near = await statOrNull(ctx, up); }
		let say;
		if (there || (near && !near.isDirectory)) {
			say = `${verb}: failed to access '${dest}': Not a directory\n`;
		} else if (verb === 'cp') {
			say = `cp: cannot create ${srcStat.isDirectory ? 'directory' : 'regular file'} '${dest}': ${parent ? 'Not a directory' : 'No such file or directory'}\n`;
		} else {
			say = `mv: cannot move '${src}' to '${dest}': ${parent ? 'Not a directory' : 'No such file or directory'}\n`;
		}
		return answer(say);
	}

	/**
	 * `cp -rv d e` lists every file it copies (`'d' -> 'e'`, `'d/f' -> 'e/f'`, ...); the engine lists the directory it
	 * was given and nothing below it. The entries are added after each directory line, a folder's before what is in it,
	 * in name order (GNU's is the file system's, which nothing fixes).
	 *
	 * @param {any} ctx
	 * @param {string} stdout what the engine printed
	 */
	async function verboseTree(ctx, stdout) {
		const budget = ctx.limits && ctx.limits.maxTraversalEntries;
		let count = 0;
		const out = [];
		const walk = async (src, dst) => {
			let names;
			try { names = (await ctx.fs.readdir(abs(ctx, src))).slice().sort(); } catch { return; }
			for (const name of names) {
				if (typeof budget === 'number' && ++count > budget) { return; }
				const a = src + '/' + name;
				const b = dst + '/' + name;
				out.push(`'${a}' -> '${b}'`);
				const st = await statOrNull(ctx, abs(ctx, a));
				if (st && st.isDirectory) { await walk(a, b); }
			}
		};
		for (const line of stdout.split('\n')) {
			if (line === '') { continue; }
			const m = /^'(.*)' -> '(.*)'$/.exec(line);
			// `cp -rv d/. e` names what is inside d, not d/. itself
			if (!m || !m[1].endsWith('/.')) { out.push(line); }
			if (!m) { continue; }
			const st = await statOrNull(ctx, abs(ctx, m[1]));
			if (st && st.isDirectory) { await walk(m[1].replace(/\/+$/, ''), m[2].replace(/\/+$/, '')); }
		}
		return out.join('\n') + '\n';
	}

	/**
	 * -u for cp and mv: one pair of paths at a time, skipped when the destination is a file that is not older.
	 * @param {any} ctx
	 * @param {string} verb 'cp' | 'mv'
	 * @param {string[]} norm the normalised arguments (options, then operands)
	 * @param {boolean} [noTarget] -T: the destination is the target itself, never a folder to go into
	 */
	async function updateTransfer(ctx, verb, norm, noTarget = false) {
		const flags = [];
		const operands = [];
		let afterDashes = false;
		for (const a of norm) {
			if (!afterDashes && a === '--') { afterDashes = true; continue; }
			if (!afterDashes && a.startsWith('-') && a !== '-') { flags.push(a); } else { operands.push(a); }
		}
		const recursive = flags.some((f) => /^-[A-Za-z]*[rR]/.test(f) || f === '--recursive');
		const verbose = flags.some((f) => /^-[A-Za-z]*v/.test(f) || f === '--verbose');
		let stdout = '';
		let stderr = '';
		let exitCode = 0;
		if (operands.length < 2) { return { stdout, stderr: `${verb}: missing destination file operand after '${operands[0] || ''}'\n`, exitCode: 1 }; }
		const dest = operands[operands.length - 1];
		const destAbs = abs(ctx, dest);
		const destStat = await statOrNull(ctx, destAbs);
		const srcs = operands.slice(0, -1);
		if (srcs.length > 1 && !(destStat && destStat.isDirectory)) { return { stdout, stderr: `${verb}: target '${dest}' is not a directory\n`, exitCode: 1 }; }
		/** @type {Array<[string, string, string, any, string]>} src and dst as typed, srcAbs, dstAbs, stat */
		const pairs = [];
		const room = ctx.limits && ctx.limits.maxTraversalEntries;
		let visited = 0;
		const walk = async (srcAbs, dstAbs, shown, shownDst) => {
			for (const name of await ctx.fs.readdir(srcAbs)) {
				if (typeof room === 'number' && ++visited > room) {
					// the same bound as find, du and grep -r: a tree this big ends the script
					const message = `${verb}: filesystem traversal entry limit exceeded (${room})`;
					throw LimitError ? new LimitError(message, 'iterations') : Object.assign(new Error(message), { name: 'ExecutionLimitError' });
				}
				const s = ctx.fs.resolvePath(srcAbs, name);
				const st = await ctx.fs.stat(s);
				const d = ctx.fs.resolvePath(dstAbs, name);
				if (st.isDirectory) { await walk(s, d, shown + '/' + name, shownDst + '/' + name); } else { pairs.push([shown + '/' + name, s, d, st, shownDst + '/' + name]); }
			}
		};
		const typedDir = dest.replace(/\/+$/, '') || '/';
		for (const src of srcs) {
			const srcAbs = abs(ctx, src);
			const st = await statOrNull(ctx, srcAbs);
			if (!st) { stderr += `${verb}: cannot stat '${src}': No such file or directory\n`; exitCode = 1; continue; }
			const intoDir = !noTarget && destStat && destStat.isDirectory;
			const target = intoDir ? ctx.fs.resolvePath(destAbs, baseName(srcAbs)) : destAbs;
			const shownDst = intoDir ? typedDir + '/' + baseName(srcAbs) : dest;
			if (st.isDirectory && verb === 'cp') {
				if (!recursive) { stderr += `cp: -r not specified; omitting directory '${src}'\n`; exitCode = 1; continue; }
				visited++;                                   // the folder itself is an entry, as it is for find and du
				await walk(srcAbs, target, src, shownDst);
				continue;
			}
			pairs.push([src, srcAbs, target, st, shownDst]);
		}
		for (const [shown, srcAbs, dstAbs, st, shownDst] of pairs) {
			const t = await statOrNull(ctx, dstAbs);
			if (t && !t.isDirectory && +t.mtime >= +st.mtime) { continue; }
			try {
				if (verb === 'cp') {
					await ctx.fs.mkdir(dirName(dstAbs), { recursive: true });
					await ctx.fs.cp(srcAbs, dstAbs, { recursive: false });
				} else {
					await ctx.fs.mv(srcAbs, dstAbs);
				}
				if (verbose) { stdout += verb === 'cp' ? `'${shown}' -> '${shownDst}'\n` : `renamed '${shown}' -> '${shownDst}'\n`; }
			} catch (e) {
				stderr += `${verb}: cannot ${verb === 'cp' ? 'create regular file' : 'move'} '${dstAbs}': ${/ENOENT/.test(String(e.code)) ? 'No such file or directory' : String(e.message).replace(/^[A-Z]+: /, '')}\n`;
				exitCode = 1;
			}
		}
		return { stdout, stderr, exitCode };
	}

	return [
		defineCommand('xargs', async (args, ctx) => {
			if (!ctx.origCommand) { return missingOriginal('xargs'); }
			const parsed = ctx.exec ? parseXargs(args) : null;
			if (parsed && 'error' in parsed) { return { stdout: '', stderr: parsed.error, exitCode: 1 }; }
			if (parsed) {
				// GNU's xargs, run here: the engine's splits on every blank and has no -L, -E, -a (see parseXargs)
				const { opts, command, warnings } = parsed;
				let input = ctx.stdin || '';
				if (opts.argFile !== null) {
					try { input = decodeBytes(await readBytes(ctx)(opts.argFile)); } catch { return { stdout: '', stderr: `xargs: Cannot open input file '${opts.argFile}': No such file or directory\n`, exitCode: 1 }; }
				}
				const maxIterations = ctx.limits && ctx.limits.maxLoopIterations;
				const limitError = (message) => (LimitError ? new LimitError(message, 'iterations') : Object.assign(new Error(message), { name: 'ExecutionLimitError' }));
				const read = xargsInput(input, opts);
				let batches = xargsBatches(read.lines, opts);
				// nothing to read: GNU runs the command once, without arguments, unless -r (and -I has nothing to replace)
				if (!batches.length && !read.error && !opts.noRun && opts.replace === null) { batches = [[]]; }
				if (typeof maxIterations === 'number' && batches.length > maxIterations) { throw limitError(`xargs: iteration limit exceeded (${maxIterations})`); }
				const base = command.length ? command : ['echo'];
				let stdout = '';
				let stderr = warnings.join('');
				let failed = false;
				let status = 0;
				const quote = (w) => "'" + w.replace(/'/g, "'\\''") + "'";
				for (const batch of batches) {
					// the replacement is made in the arguments the command was given, not in its name
					const argv = opts.replace !== null ? [base[0], ...base.slice(1).map((w) => w.split(/** @type {string} */ (opts.replace)).join(batch[0]))] : [...base, ...batch];
					if (opts.verbose) { stderr += argv.map(xargsQuote).join(' ') + '\n'; }
					const r = await ctx.exec(argv.map(quote).join(' '), { cwd: ctx.cwd, signal: ctx.signal });
					stdout += r.stdout || '';
					let err = r.stderr || '';
					const name = argv[0];
					if (r.exitCode === 127 && err.includes(`bash: ${name}: command not found\n`)) {
						stderr += err.replace(`bash: ${name}: command not found\n`, '') + `xargs: ${name}: No such file or directory\n`;
						status = 127;
						break;
					}
					if (r.exitCode === 126 && err.includes(`bash: ${name}: Permission denied\n`)) {
						stderr += err.replace(`bash: ${name}: Permission denied\n`, '') + `xargs: ${name}: Permission denied\n`;
						status = 126;
						break;
					}
					stderr += err;
					if (r.exitCode === 255) {
						stderr += `xargs: ${name}: exited with status 255; aborting\n`;
						status = 124;
						break;
					}
					if (r.exitCode !== 0) { failed = true; }
				}
				if (read.error) { stderr += read.error; status = status || 1; }
				return { stdout, stderr, exitCode: status || (failed ? 123 : 0) };
			}
			const n = normaliseXargs(args);
			const empty = !/\S/.test(ctx.stdin || '') && !n.slice(0, firstOperand(n)).includes('-0');
			const flags = n.slice(0, firstOperand(n));
			if (empty && !flags.includes('-r') && !flags.includes('-I') && n.length > firstOperand(n) && ctx.exec) {
				// GNU xargs runs the command once, without arguments, when there is nothing to read
				const cmd = n.slice(firstOperand(n)).map((w) => "'" + w.replace(/'/g, "'\\''") + "'").join(' ');
				return ctx.exec(cmd, { cwd: ctx.cwd });
			}
			return ctx.origCommand(n);
		}),
		...['grep', 'egrep', 'fgrep'].map((name) => defineCommand(name, async (args, ctx) => {
			if (!ctx.origCommand) { return missingOriginal(name); }
			// a directory named with a trailing slash prints src/file, not src//file (GNU strips it for the name)
			const g0 = grepOperands(args);
			const typed = args.slice();
			for (const i of g0.fileAt) { if (typed[i].length > 1 && typed[i].endsWith('/')) { typed[i] = typed[i].slice(0, -1); } }
			let norm = normaliseGrep(typed);
			const g = grepOperands(typed);
			let r;
			let addedNull = false;
			if (g.recursive && g.files.length === 1 && !g.withName && !g.noName) {
				// `grep -r X file` names no file when what it was given is a file
				const st = await statOrNull(ctx, abs(ctx, g.files[0]));
				if (st && st.isFile) { norm = ['-h', ...norm]; }
			}
			if (g.withName) {
				// -H: a second operand makes the engine print names. /dev/null has no lines, and its own line is taken off
				if (g.files.length === 0 && !g.recursive) { norm = [...norm, '-']; }
				norm = [...norm, ...(grepNeedsDot(typed) ? ['.'] : []), '/dev/null'];
				addedNull = true;
			} else if (grepNeedsDot(typed)) {
				norm = [...norm, '.'];
			}
			r = await ctx.origCommand(norm);
			if (addedNull && r.stdout) {
				r = Object.assign({}, r, { stdout: r.stdout.split('\n').filter((l) => l !== '/dev/null' && l !== '/dev/null:0').join('\n') });
			}
			if (r.stdout && grepDotPrefix(typed)) {
				r = Object.assign({}, r, { stdout: r.stdout.replace(/^(?!--$)(?=.)/gm, './') });
			}
			if (!r.stderr || !grepWantsSilence(typed)) { return r; }
			const kept = r.stderr.split('\n').filter((l) => !/^grep: .*: (No such file or directory|Is a directory|Permission denied)$/.test(l));
			return Object.assign({}, r, { stderr: kept.join('\n') });
		})),
		wrap('rm', normaliseRm),
		defineCommand('cp', async (args, ctx) => {
			if (!ctx.origCommand) { return missingOriginal('cp'); }
			const n = normaliseCp(args);
			const pre = await preflight(ctx, 'cp', n.args, wantsNoTargetDirectory(args));
			if (pre.result) { return pre.result; }
			if (n.update) { return updateTransfer(ctx, 'cp', pre.args, wantsNoTargetDirectory(args)); }
			let r = relativeVerbose(await ctx.origCommand(pre.args), ctx.cwd);
			if (r.stdout && r.stdout.includes("' -> '") && pre.args.some((a) => /^-[A-Za-z]*[rR]/.test(a) || a === '--recursive')) {
				r = Object.assign({}, r, { stdout: await verboseTree(ctx, r.stdout) });
			}
			if (r.stdout) {
				// the destination is printed as it was typed: `cp -v d d2/` says 'd2/', the engine took the slash off
				const typed = pre.args.filter((a) => !a.startsWith('-') || a === '-').pop();
				const bare = typed && typed.length > 1 ? typed.replace(/\/+$/, '') : typed;
				if (typed && bare !== typed) { r = Object.assign({}, r, { stdout: r.stdout.split(`-> '${bare}'\n`).join(`-> '${typed}'\n`) }); }
			}
			return Object.assign({}, r, { stderr: pre.stderr + (r.stderr ? gnuTransferErrors(r.stderr, 'cp', ctx.cwd) : ''), exitCode: pre.stderr ? 1 : r.exitCode });
		}),
		defineCommand('mv', async (args, ctx) => {
			if (!ctx.origCommand) { return missingOriginal('mv'); }
			const n = normaliseMv(args);
			const pre = await preflight(ctx, 'mv', n.args, wantsNoTargetDirectory(args));
			if (pre.result) { return pre.result; }
			if (n.update) { return updateTransfer(ctx, 'mv', pre.args, wantsNoTargetDirectory(args)); }
			const r = relativeVerbose(await ctx.origCommand(pre.args), ctx.cwd);
			return Object.assign({}, r, { stderr: pre.stderr + (r.stderr ? gnuTransferErrors(r.stderr, 'mv', ctx.cwd) : ''), exitCode: pre.stderr ? 1 : r.exitCode });
		}),
		defineCommand('mkdir', async (args, ctx) => {
			if (!ctx.origCommand) { return missingOriginal('mkdir'); }
			const n = normaliseMkdir(args);
			// -pv names every folder it makes, the ones on the way too; the engine names the last
			const flags = n.args.filter((a) => a.startsWith('-') && a !== '--' && a !== '-');
			const verboseParents = flags.some((f) => f === '--parents' || /^-[A-Za-z]*p/.test(f)) && flags.some((f) => f === '--verbose' || /^-[A-Za-z]*v/.test(f));
			/** @type {string[]} */
			const made = [];
			if (verboseParents) {
				const planned = new Set();
				for (const d of n.dirs) {
					const parts = d.replace(/\/+$/, '').split('/');
					let at = '';
					for (let k = 0; k < parts.length; k++) {
						at = k === 0 ? parts[0] : at + '/' + parts[k];
						if (at === '' || at === '.' || at === '..' || parts[k] === '') { continue; }
						if (!planned.has(at) && !(await statOrNull(ctx, abs(ctx, at)))) { planned.add(at); made.push(at); }
					}
				}
			}
			let r = await ctx.origCommand(n.args);
			if (verboseParents && r.exitCode === 0) { r = Object.assign({}, r, { stdout: made.map((m) => `mkdir: created directory '${m}'\n`).join('') }); }
			if (n.mode !== null && r.exitCode === 0 && /^[0-7]{1,4}$/.test(n.mode)) {
				for (const d of n.dirs) { try { await ctx.fs.chmod(abs(ctx, d), parseInt(n.mode, 8)); } catch { /* the directory is what mattered */ } }
			}
			return r;
		}),
		defineCommand('sed', async (args, ctx) => {
			if (!ctx.origCommand) { return missingOriginal('sed'); }
			const n = normaliseSed(args);
			// a script file gets the same rewrite as -e text (GNU's one-line `$a\TEXT`); one that is not a plain small
			// file is handed over as it is, and the engine says what is wrong with it
			for (let k = 0; k < n.args.length - 1; k++) {
				if (n.args[k] !== '-f' || n.args[k + 1] === '-') { continue; }
				try {
					const st = await ctx.fs.stat(abs(ctx, n.args[k + 1]));
					if (!st.isFile || st.size > SED_REWRITE_MAX) { continue; }
					const text = decodeBytes(await readBytes(ctx)(n.args[k + 1]));
					const fixed = fixSedOneLiner(text);
					if (fixed !== text) { n.args.splice(k, 2, '-e', fixed); }
				} catch { /* the engine reports a file it cannot read */ }
			}
			if (n.suffix) {
				// GNU keeps the original next to the edited file; the engine takes the suffix and keeps nothing
				for (const f of n.files) {
					try {
						const p = abs(ctx, f);
						const st = await ctx.fs.stat(p);
						if (!st.isFile) { continue; }
						const name = n.suffix.includes('*') ? n.suffix.replace(/\*/g, baseName(p)) : baseName(p) + n.suffix;
						await ctx.fs.writeFile(name.startsWith('/') ? name : ctx.fs.resolvePath(dirName(p), name), await ctx.fs.readFileBuffer(p));
					} catch { /* the engine reports a file it cannot read */ }
				}
			}
			return withoutDoubledPrefix(await ctx.origCommand(n.args), 'sed');
			}),
			defineCommand('touch', async (args, ctx) => {
			if (!ctx.origCommand) { return missingOriginal('touch'); }
			const t = parseTouch(args, zone.getZone());
			let time = t.time;
			if (t.reference !== null) {
				const ref = await statOrNull(ctx, abs(ctx, t.reference));
				if (!ref) { return { stdout: '', stderr: `touch: failed to get attributes of '${t.reference}': No such file or directory\n`, exitCode: 1 }; }
				if (time === null) { time = +ref.mtime; }
			}
			const r = await ctx.origCommand(t.args);
			if (time !== null && r.exitCode === 0) {
				for (const f of t.files) {
					try { await ctx.fs.utimes(abs(ctx, f), new zone.LcDate(time), new zone.LcDate(time)); } catch { /* -c on a file that is not there */ }
				}
			}
			return r;
		}),
		defineCommand('ls', async (args, ctx) => {
		if (!ctx.origCommand) { return missingOriginal('ls'); }
		const n = normaliseLs(args);
		let r = await ctx.origCommand(n.args);
		if (n.slashOnly && r.stdout) { r = Object.assign({}, r, { stdout: r.stdout.replace(/\*$/gm, '') }); }
		if (r.stdout && /(^|\n)total \d+\n/.test(r.stdout)) { r = Object.assign({}, r, { stdout: lsTotals(r.stdout) }); }
		if (!r.stderr) { return r; }
		// GNU: `ls: cannot access 'x': No such file or directory`
		return Object.assign({}, r, { stderr: r.stderr.replace(/^ls: (.+): No such file or directory$/gm, "ls: cannot access '$1': No such file or directory") });
		}),
		defineCommand('du', async (args, ctx) => du(args, {
			cwd: ctx.cwd,
			stat: (p) => statOrNull(ctx, p),
			readdir: async (p) => (await ctx.fs.readdir(p)).slice().sort(),
			resolve: (b, p) => ctx.fs.resolvePath(b, p),
			traversal: {
				entries: ctx.limits && ctx.limits.maxTraversalEntries,
				depth: ctx.limits && ctx.limits.maxTraversalDepth,
				exceeded: (message) => (LimitError ? new LimitError(message, 'iterations') : Object.assign(new Error(message), { name: 'ExecutionLimitError' })),
			},
		})),
		defineCommand('tr', async (args, ctx) => {
			if (!ctx.origCommand) { return missingOriginal('tr'); }
			// the engine cannot see a NUL byte: `tr '\0' x` and `tr -d '\0'` are done here
			const flags = args.filter((a) => a.startsWith('-') && a !== '-');
			const sets = args.filter((a) => !a.startsWith('-') || a === '-');
			const nul = (x) => x === '\\0' || x === '\\000' || x === '\\x00';
			if (sets.length >= 1 && nul(sets[0]) && flags.every((f) => f === '-d' || f === '--delete')) {
				const del = flags.length > 0;
				if (del && sets.length === 1) { return { stdout: (ctx.stdin || '').replace(/\u0000/g, ''), stderr: '', exitCode: 0, stdoutEncoding: 'binary' }; }
				if (!del && sets.length === 2 && sets[1].length >= 1) {
					const to = sets[1] === '\\n' ? '\n' : sets[1] === '\\t' ? '\t' : sets[1][0];
					return { stdout: (ctx.stdin || '').replace(/\u0000/g, to), stderr: '', exitCode: 0, stdoutEncoding: 'binary' };
				}
			}
			return ctx.origCommand(args);
		}),
		defineCommand('uniq', async (args, ctx) => {
			if (!ctx.origCommand) { return missingOriginal('uniq'); }
			const r = await ctx.origCommand(args);
			if (!args.some((a) => a === '--count' || (/^-[A-Za-z]+$/.test(a) && a.includes('c')))) { return r; }
			// the engine pads the count to 4 characters, GNU uniq to 7
			return Object.assign({}, r, { stdout: r.stdout.replace(/^ *(\d+) /gm, (_m, n) => n.padStart(7, ' ') + ' ') });
		}),
		defineCommand('wc', async (args, ctx) => {
			if (!ctx.origCommand) { return missingOriginal('wc'); }
			const r = await ctx.origCommand(args);
			if (r.exitCode !== 0 || !r.stdout) { return r; }
			const operands = args.filter((a, i) => (a === '-' || !a.startsWith('-')) && !(args[i - 1] === '--files0-from'));
			let size = 0;
			let known = operands.length > 0;
			for (const f of operands) {
				try {
					const st = await ctx.fs.stat(abs(ctx, f));
					if (st.isFile) { size += st.size; }
				} catch { known = false; }
			}
			return Object.assign({}, r, { stdout: wcWidth(r.stdout, operands.length, known ? size : null) });
		}),
		defineCommand('paste', async (args, ctx) => (ctx.origCommand ? ctx.origCommand(normalisePaste(args)) : missingOriginal('paste'))),
		defineCommand('sort', async (args, ctx) => (ctx.origCommand ? ctx.origCommand(normaliseSort(args)) : missingOriginal('sort'))),
		defineCommand('tail', async (args, ctx) => {
			if (!ctx.origCommand) { return missingOriginal('tail'); }
			// `tail -n -3` and `tail -c -2` are `-n 3` and `-c 2` (the minus is only a sign that head uses)
			const norm = normaliseCounts(args).map((a, i, all) => {
				const valued = i > 0 && (all[i - 1] === '-n' || all[i - 1] === '-c' || all[i - 1] === '--lines' || all[i - 1] === '--bytes');
				if (valued && /^-\d+$/.test(a)) { return a.slice(1); }
				const attached = /^(-[nc]|--lines=|--bytes=)-(\d+)$/.exec(a);
				return attached ? attached[1] + attached[2] : a;
			});
			const from = parseTailFrom(norm);
			if (!from) { return ctx.origCommand(norm); }
			const names = from.files.length ? from.files : ['-'];
			let out = '';
			let err = '';
			let rc = 0;
			for (let i = 0; i < names.length; i++) {
				const f = names[i];
				let bytes;
				try {
					bytes = f === '-' ? Uint8Array.from(ctx.stdin || '', (ch) => ch.charCodeAt(0) & 0xff) : await readBytes(ctx)(f);
				} catch (e) {
					err += `tail: cannot open '${f}' for reading: ${/EISDIR/.test(String(e.code)) ? 'Is a directory' : 'No such file or directory'}\n`;
					rc = 1;
					continue;
				}
				if ((names.length > 1 && !from.quiet) || from.verbose) { out += `${i > 0 ? '\n' : ''}==> ${f === '-' ? 'standard input' : f} <==\n`; }
				out += latin1(bytes.subarray(Math.min(bytes.length, Math.max(0, from.from - 1))));
			}
			return { stdout: out, stderr: err, exitCode: rc, stdoutEncoding: 'binary' };
		}),
		defineCommand('head', async (args, ctx) => {
			if (!ctx.origCommand) { return missingOriginal('head'); }
			args = normaliseCounts(args);
			const neg = parseHeadNegative(args);
			if (!neg) { return ctx.origCommand(args); }
			const names = neg.files.length ? neg.files : ['-'];
			let out = '';
			let err = '';
			let rc = 0;
			for (let i = 0; i < names.length; i++) {
				const f = names[i];
				let bytes;
				try {
					bytes = f === '-' ? Uint8Array.from(ctx.stdin || '', (ch) => ch.charCodeAt(0) & 0xff) : await readBytes(ctx)(f);
				} catch (e) {
					err += `head: cannot open '${f}' for reading: ${/EISDIR/.test(String(e.code)) ? 'Is a directory' : 'No such file or directory'}\n`;
					rc = 1;
					continue;
				}
				if ((names.length > 1 && !neg.quiet) || neg.verbose) { out += `${i > 0 ? '\n' : ''}==> ${f === '-' ? 'standard input' : f} <==\n`; }
				out += latin1(neg.negative ? dropLast(bytes, neg.unit, neg.count, neg.zero) : takeFirst(bytes, neg.unit, neg.count, neg.zero));
			}
			return { stdout: out, stderr: err, exitCode: rc, stdoutEncoding: 'binary' };
		}),
		defineCommand('stat', async (args, ctx) => {
			if (!ctx.origCommand) { return missingOriginal('stat'); }
			const p = parseStat(args);
			if (p.format === null || !/%[YyXxZzWw%]/.test(p.format) || !p.files.length) { return ctx.origCommand(args); }
			let out = '';
			let err = '';
			let rc = 0;
			for (const f of p.files) {
				let st;
				try { st = await ctx.fs.stat(abs(ctx, f)); } catch { err += `stat: cannot statx '${f}': No such file or directory\n`; rc = 1; continue; }
				// the engine does not know %%: a placeholder goes through it and comes back as a percent sign
				const fmt = statTimeFormat(p.format, +st.mtime, zone.getZone()).replace(/%%/g, '\u0001');
				const r = await ctx.origCommand([...p.other, '-c', fmt, f]);
				out += r.stdout.replace(/\u0001/g, '%');
				err += r.stderr;
				if (r.exitCode) { rc = r.exitCode; }
			}
			return { stdout: out, stderr: err, exitCode: rc };
		}),
		defineCommand('awk', async (args, ctx) => {
			if (!ctx.origCommand) { return missingOriginal('awk'); }
			// -f PROGFILE: the engine takes the program as text only
			const opts = [];
			const progs = [];
			const operands = [];
			let afterDashes = false;
			for (let i = 0; i < args.length; i++) {
				const a = args[i];
				if (afterDashes) { operands.push(a); continue; }
				if (a === '--') { afterDashes = true; continue; }
				if (a === '-f' || a === '--file') { progs.push(args[++i]); continue; }
				if (a.startsWith('--file=')) { progs.push(a.slice(7)); continue; }
				if (/^-f.+/.test(a) && !a.startsWith('--')) { progs.push(a.slice(2)); continue; }
				if (a === '-F' || a === '-v' || a === '--field-separator' || a === '--assign') { opts.push(a, args[++i]); continue; }
				if (a.startsWith('-') && a !== '-') { opts.push(a); continue; }
				operands.push(a);
			}
			if (!progs.length) { return withoutDoubledPrefix(await ctx.origCommand(args), 'awk'); }
			let program = '';
			for (const f of progs) {
				try { program += decodeBytes(await readBytes(ctx)(f)) + '\n'; } catch { return { stdout: '', stderr: `awk: fatal: can't open source file \`${f}' for reading: No such file or directory\n`, exitCode: 2 }; }
				}
				return withoutDoubledPrefix(await ctx.origCommand([...opts, program, ...operands]), 'awk');
		}),
		defineCommand('date', async (args, ctx) => {
			if (!ctx.origCommand) { return missingOriginal('date'); }
			// -r FILE: the modification time of a file
			const out = [];
			for (let i = 0; i < args.length; i++) {
				const a = args[i];
				const ref = a === '-r' || a === '--reference' ? args[++i] : a.startsWith('--reference=') ? a.slice(12) : (/^-r.+/.test(a) && !a.startsWith('--') ? a.slice(2) : null);
				if (ref === null || ref === undefined) { out.push(a); continue; }
				let st;
				try { st = await ctx.fs.stat(abs(ctx, ref)); } catch { return { stdout: '', stderr: `date: ${ref}: No such file or directory\n`, exitCode: 1 }; }
				out.push('-d', '@' + Math.floor(+st.mtime / 1000));
			}
			return ctx.origCommand(out);
		}),
		defineCommand('od', async (args, ctx) => od(args, async () => ctx.stdin || '', readBytes(ctx))),
		defineCommand('realpath', async (args, ctx) => realpath(args, { cwd: ctx.cwd, resolve: (b, p) => ctx.fs.resolvePath(b, p), exists: (p) => ctx.fs.exists(p) })),
		defineCommand('uname', async (args, ctx) => uname(args, (ctx.env && (ctx.env.get ? ctx.env.get('HOSTNAME') : ctx.env.HOSTNAME)) || 'localhost')),
		defineCommand('id', async (args) => id(args)),
		defineCommand('nproc', async (args) => {
			for (const a of args) { if (a !== '--all' && !a.startsWith('--ignore')) { return { stdout: '', stderr: `nproc: invalid option -- '${a.replace(/^-+/, '')}'\n`, exitCode: 1 }; } }
			return { stdout: '1\n', stderr: '', exitCode: 0 };
		}),
		defineCommand('cmp', async (args, ctx) => cmp(args, async (p) => {
			if (p === '-') { return Uint8Array.from(ctx.stdin || '', (ch) => ch.charCodeAt(0) & 0xff); }
			return readBytes(ctx)(p);
		})),
	];
}

module.exports = {
	EXCLUDED,
	LIKELY_MISSING,
	UNIMPLEMENTED_BUILTINS,
	normaliseXargs,
	parseXargs,
	xargsInput,
	xargsBatches,
	xargsQuote,
	normaliseGrep,
	normaliseCp,
	normaliseMv,
	wantsNoTargetDirectory,
	normaliseRm,
	normaliseMkdir,
	normaliseSed,
	normalisePaste,
	normaliseSort,
	normaliseLs,
	fixSedOneLiner,
	parseTouch,
	grepNeedsDot,
	grepOperands,
	grepDotPrefix,
	wcWidth,
	grepWantsSilence,
	normaliseCounts,
	parseHeadNegative,
	parseTailFrom,
	dropLast,
	takeFirst,
	statTimeFormat,
	parseStat,
	du,
	lsTotals,
	humanSize,
	parseBlockSize,
	gnuTransferErrors,
	withoutDoubledPrefix,
	od,
	uname,
	id,
	realpath,
	cmp,
	commands,
	/** names `commands()` defines that are not wrappers of a built-in */
	ADDED: ['od', 'realpath', 'uname', 'id', 'nproc', 'cmp'],
	relativeVerbose,
	/** names `commands()` shadows to normalise their arguments or fill in what the engine lacks */
	WRAPPED: ['xargs', 'grep', 'egrep', 'fgrep', 'rm', 'cp', 'mv', 'mkdir', 'sed', 'paste', 'head', 'stat', 'awk', 'date', 'uniq', 'wc', 'touch', 'tr', 'ls', 'tail', 'sort', 'du'],
};
