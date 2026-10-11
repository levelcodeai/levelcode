// What the engine lacks that a model (or a person) types out of habit, without forking the engine.
//
//   * argument normalisers: pure functions from the arguments GNU accepts to the arguments the engine accepts
//   * wrappers: a custom command with a built-in's name that normalises and hands over through ctx.origCommand
//   * commands the engine does not have at all, or has wrong (od): realpath uname id nproc cmp od
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

const decoder = new TextDecoder('utf-8');

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
 * xargs. The engine takes `-I REPLACE`, `-n NUM`, `-P NUM`, `-d DELIM`, `-0`, `-t`, `-r` (each value as a separate
 * argument, one option per argument). GNU also takes the value attached (`-I{}`, `-n1`, `-P4`), clusters (`-0r`,
 * `-rn1`), `-i`, `-L`, `-s`, `-E`, and the long spellings. `-P`, `-s`, `-E`, `-x` are accepted and dropped: nothing runs
 * in parallel here and the rest only matter for huge inputs. `-L N` becomes `-n N` (a line with several words differs).
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

/** GNU grep options that take a value (so that the value is never mistaken for an option or for something to drop). */
const GREP_SHORT_VALUE = new Set(['e', 'f', 'm', 'A', 'B', 'C', 'd', 'D']);
const GREP_LONG_VALUE = new Set(['--regexp', '--file', '--max-count', '--after-context', '--before-context', '--context', '--include', '--exclude', '--exclude-from', '--exclude-dir', '--directories', '--devices', '--label']);
/** Accepted by GNU grep, meaningless here (no terminal, no binary files, no colour, no unreadable files): removed. */
const GREP_DROP_SHORT = new Set(['s', 'I', 'a', 'U']);

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
	let quiet = false;
	let patternGiven = false;
	const operands = [];
	let afterDashes = false;
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (afterDashes || a === '-' || !a.startsWith('-')) { operands.push(a); continue; }
		if (a === '--') { afterDashes = true; continue; }
		if (a.startsWith('--')) {
			const eq = a.indexOf('=');
			const name = eq < 0 ? a : a.slice(0, eq);
			if (name === '--recursive' || name === '--dereference-recursive') { recursive = true; }
			if (name === '--no-filename') { noName = true; }
			if (name === '--quiet' || name === '--silent') { quiet = true; }
			if (name === '--regexp' || name === '--file') { patternGiven = true; }
			if (eq < 0 && GREP_LONG_VALUE.has(name)) { i++; }
			continue;
		}
		for (let c = 1; c < a.length; c++) {
			const ch = a[c];
			if (ch === 'r' || ch === 'R') { recursive = true; }
			if (ch === 'h') { noName = true; }
			if (ch === 'q') { quiet = true; }
			if (GREP_SHORT_VALUE.has(ch)) {
				if (ch === 'e' || ch === 'f') { patternGiven = true; }
				if (c === a.length - 1) { i++; }
				break;
			}
		}
	}
	const files = patternGiven ? operands : operands.slice(1);
	return { recursive, noName, quiet, files };
}

/**
 * Is this a recursive search of exactly `.` that prints file names? GNU prefixes each name with './'; the engine
 * prints the name relative to it. (A search with no operand, or of any other folder, is the same in both.)
 * @param {string[]} args
 */
function grepDotPrefix(args) {
	const g = grepOperands(args);
	return g.recursive && !g.noName && !g.quiet && g.files.length === 1 && g.files[0] === '.';
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
 * grep. The engine has no `-s`, `-I`, `--color[=WHEN]`, `--line-buffered`, `-a`, `-U`, `--binary-files=`.
 * Everything else (`-P` included) it takes as it is. `-s` also silences the "no such file" lines, which the wrapper
 * does with the engine's stderr.
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
			if (name === '--no-messages' || name === '--line-buffered' || name === '--text' || name === '--binary' || name === '--color' || name === '--colour') { continue; }
			if (name === '--binary-files') { if (eq < 0) { i++; } continue; }
			out.push(a);
			if (eq < 0 && GREP_LONG_VALUE.has(name) && i + 1 < args.length) { out.push(args[++i]); }
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
			if (name === '--expression') { script = true; out.push('-e', fixSedOneLiner(String(val()))); continue; }
			if (name === '--file') { script = true; out.push('-f', String(val())); continue; }
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
				out.push('-' + ch, ch === 'e' ? fixSedOneLiner(String(value)) : String(value));
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
 * "no time given". So these two are taken out of the command line and applied with utimes afterwards.
 *
 * @param {string[]} args
 * @returns {{ args: string[], time: number | null, files: string[] }} `time` in ms since the epoch
 */
function parseTouch(args) {
	const out = [];
	const files = [];
	let time = null;
	let afterDashes = false;
	const OPT_VALUE = new Set(['-r', '--reference', '-d', '--date', '-t']);
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (afterDashes || a === '-' || !a.startsWith('-')) { files.push(a); out.push(a); continue; }
		if (a === '--') { afterDashes = true; out.push(a); continue; }
		let stamp = null;
		let date = null;
		if (a === '-t') { stamp = args[++i]; } else if (/^-t.+/.test(a) && !a.startsWith('--')) { stamp = a.slice(2); } else if (a === '-d' || a === '--date') { date = args[++i]; } else if (a.startsWith('--date=')) { date = a.slice(7); } else if (/^-d.+/.test(a) && !a.startsWith('--')) { date = a.slice(2); }
		if (stamp !== null) {
			const m = /^(\d{2}|\d{4})?(\d{2})(\d{2})(\d{2})(\d{2})(?:\.(\d{2}))?$/.exec(String(stamp));
			if (m) {
				let year = m[1];
				if (year === undefined) { year = String(new Date().getFullYear()); } else if (year.length === 2) { year = (Number(year) >= 69 ? '19' : '20') + year; }
				const d = new Date(Number(year), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] || 0));
				time = d.getTime();
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
	return { args: out, time, files };
}

/**
 * GNU's one-line form of the text commands (`1i\HEADER`, `$a\FOOTER`, `/re/c\new`): the engine prints the backslash.
 * The portable form, a backslash and a newline before the text, is what it understands.
 *
 * @param {string} script
 */
function fixSedOneLiner(script) {
	return script.replace(/(^|[;{\n])(\s*(?:\d+|\$|\/(?:[^\/\\]|\\.)*\/)?(?:\s*,\s*(?:\d+|\$|\/(?:[^\/\\]|\\.)*\/))?\s*!?\s*[aic])\\(?=[^\n])(.*)$/gm, (_m, pre, cmd, rest) => `${pre}${cmd}\\\n${rest}`);
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
 * head with a negative count (`-n -3`: all but the last three lines; `-c -5`: all but the last five bytes), which
 * the engine rejects. Everything else is the engine's.
 *
 * @param {string[]} args
 * @returns {null | { unit: 'lines' | 'bytes', count: number, quiet: boolean, verbose: boolean, zero: boolean, files: string[] }}
 */
function parseHeadNegative(args) {
	let unit = null;
	let count = 0;
	let negative = false;
	let quiet = false;
	let verbose = false;
	let zero = false;
	const files = [];
	let afterDashes = false;
	const take = (u, v) => {
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
	if (!negative || unit === null) { return null; }
	return { unit, count, quiet, verbose, zero, files };
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
 * stat -c with the time fields the engine prints literally. `%Y` is the modification time in seconds, `%y` as
 * `2020-05-06 07:08:09.000000000 +0000`; access and status times are the modification time (nothing is tracked).
 *
 * @param {string} format
 * @param {number} mtimeMs
 */
function statTimeFormat(format, mtimeMs) {
	const secs = Math.floor(mtimeMs / 1000);
	const d = new Date(secs * 1000);
	const pad = (n, w = 2) => String(n).padStart(w, '0');
	const human = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}.${pad(mtimeMs % 1000 * 1000000, 9)} +0000`;
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
 * @param {{ stdout: string }} r
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
 * @param {(name: string, execute: (args: string[], ctx: any) => Promise<any>) => any} defineCommand
 * @returns {any[]} custom commands, to hand to `new Bash({ customCommands })`
 */
function commands(defineCommand) {
	const missingOriginal = (name) => ({ stdout: '', stderr: `${name}: internal error: the original program is not available\n`, exitCode: 1 });
	/** a built-in with its arguments normalised */
	const wrap = (name, fix) => defineCommand(name, async (args, ctx) => (ctx.origCommand ? ctx.origCommand(fix(args)) : missingOriginal(name)));
	const readBytes = (ctx) => async (p) => ctx.fs.readFileBuffer(ctx.fs.resolvePath(ctx.cwd, p));
	const abs = (ctx, p) => ctx.fs.resolvePath(ctx.cwd, p);
	const baseName = (p) => p.slice(p.lastIndexOf('/') + 1);
	const dirName = (p) => p.slice(0, p.lastIndexOf('/')) || '/';
	const statOrNull = async (ctx, p) => { try { return await ctx.fs.stat(p); } catch { return null; } };

	/**
	 * -u for cp and mv: one pair of paths at a time, skipped when the destination is a file that is not older.
	 * @param {any} ctx
	 * @param {string} verb 'cp' | 'mv'
	 * @param {string[]} norm the normalised arguments (options, then operands)
	 */
	async function updateTransfer(ctx, verb, norm) {
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
		const walk = async (srcAbs, dstAbs, shown, shownDst) => {
			for (const name of await ctx.fs.readdir(srcAbs)) {
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
			const intoDir = destStat && destStat.isDirectory;
			const target = intoDir ? ctx.fs.resolvePath(destAbs, baseName(srcAbs)) : destAbs;
			const shownDst = intoDir ? typedDir + '/' + baseName(srcAbs) : dest;
			if (st.isDirectory && verb === 'cp') {
				if (!recursive) { stderr += `cp: -r not specified; omitting directory '${src}'\n`; exitCode = 1; continue; }
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
			const norm = normaliseGrep(args);
			let r = await ctx.origCommand(grepNeedsDot(args) ? [...norm, '.'] : norm);
			if (r.stdout && grepDotPrefix(args)) {
				r = Object.assign({}, r, { stdout: r.stdout.replace(/^(?!--$)(?=.)/gm, './') });
			}
			if (!r.stderr || !grepWantsSilence(args)) { return r; }
			const kept = r.stderr.split('\n').filter((l) => !/^grep: .*: (No such file or directory|Is a directory|Permission denied)$/.test(l));
			return Object.assign({}, r, { stderr: kept.join('\n') });
		})),
		wrap('rm', normaliseRm),
		defineCommand('cp', async (args, ctx) => {
			if (!ctx.origCommand) { return missingOriginal('cp'); }
			const n = normaliseCp(args);
			return n.update ? updateTransfer(ctx, 'cp', n.args) : relativeVerbose(await ctx.origCommand(n.args), ctx.cwd);
		}),
		defineCommand('mv', async (args, ctx) => {
			if (!ctx.origCommand) { return missingOriginal('mv'); }
			const n = normaliseMv(args);
			return n.update ? updateTransfer(ctx, 'mv', n.args) : relativeVerbose(await ctx.origCommand(n.args), ctx.cwd);
		}),
		defineCommand('mkdir', async (args, ctx) => {
			if (!ctx.origCommand) { return missingOriginal('mkdir'); }
			const n = normaliseMkdir(args);
			const r = await ctx.origCommand(n.args);
			if (n.mode !== null && r.exitCode === 0 && /^[0-7]{1,4}$/.test(n.mode)) {
				for (const d of n.dirs) { try { await ctx.fs.chmod(abs(ctx, d), parseInt(n.mode, 8)); } catch { /* the directory is what mattered */ } }
			}
			return r;
		}),
		defineCommand('sed', async (args, ctx) => {
			if (!ctx.origCommand) { return missingOriginal('sed'); }
			const n = normaliseSed(args);
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
			return ctx.origCommand(n.args);
		}),
		defineCommand('touch', async (args, ctx) => {
			if (!ctx.origCommand) { return missingOriginal('touch'); }
			const t = parseTouch(args);
			const r = await ctx.origCommand(t.args);
			if (t.time !== null && r.exitCode === 0) {
				for (const f of t.files) {
					try { await ctx.fs.utimes(abs(ctx, f), new Date(t.time), new Date(t.time)); } catch { /* -c on a file that is not there */ }
				}
			}
			return r;
		}),
		defineCommand('ls', async (args, ctx) => {
			if (!ctx.origCommand) { return missingOriginal('ls'); }
			const r = await ctx.origCommand(args);
			if (!r.stderr) { return r; }
			// GNU: `ls: cannot access 'x': No such file or directory`
			return Object.assign({}, r, { stderr: r.stderr.replace(/^ls: (.+): No such file or directory$/gm, "ls: cannot access '$1': No such file or directory") });
		}),
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
		defineCommand('tail', async (args, ctx) => (ctx.origCommand ? ctx.origCommand(normaliseCounts(args)) : missingOriginal('tail'))),
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
				out += latin1(dropLast(bytes, neg.unit, neg.count, neg.zero));
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
				const fmt = statTimeFormat(p.format, +st.mtime).replace(/%%/g, '\u0001');
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
			if (!progs.length) { return ctx.origCommand(args); }
			let program = '';
			for (const f of progs) {
				try { program += decoder.decode(await readBytes(ctx)(f)) + '\n'; } catch { return { stdout: '', stderr: `awk: fatal: can't open source file \`${f}' for reading: No such file or directory\n`, exitCode: 2 }; }
			}
			return ctx.origCommand([...opts, program, ...operands]);
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
	normaliseGrep,
	normaliseCp,
	normaliseMv,
	normaliseRm,
	normaliseMkdir,
	normaliseSed,
	normalisePaste,
	fixSedOneLiner,
	parseTouch,
	grepNeedsDot,
	grepOperands,
	grepDotPrefix,
	wcWidth,
	grepWantsSilence,
	normaliseCounts,
	parseHeadNegative,
	dropLast,
	statTimeFormat,
	parseStat,
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
	WRAPPED: ['xargs', 'grep', 'egrep', 'fgrep', 'rm', 'cp', 'mv', 'mkdir', 'sed', 'paste', 'head', 'stat', 'awk', 'date', 'uniq', 'wc', 'touch', 'tr', 'ls', 'tail'],
};
