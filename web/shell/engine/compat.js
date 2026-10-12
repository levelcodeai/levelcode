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
const tr = require('./tr.js');
const zero = require('./zero.js');
const datestr = require('./datestr.js');
const diffs = require('./diff.js');
const { decodeBytes, decodeByteString, encodeText, versionCompare } = require('./text.js');

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
/* options that need a value                                                                                     */
/* ------------------------------------------------------------------------------------------------------------ */

/**
 * The options of each program that REQUIRE a value, from GNU's getopt tables: `short` is a string of letters (the value
 * is the rest of the cluster or the next argument), `long` the names (`--name=V` or the next argument), `optional` the
 * letters whose value, if any, is the rest of the cluster (`-i[SUFFIX]`, `-I[FMT]`, `-l[N]`: they never wait for the
 * next argument and so end a cluster). `operands: 'stop'` is a program that stops reading options at its first operand
 * (xargs: the command is what follows); `status` is the exit status of the program's usage errors (2 for grep, sort, ls,
 * cmp; 1 for the rest); `bare` is gawk's own spelling of the letter, without quotes. One table and one reader, so that an option cannot reach a wrapper without its
 * value: they used to leak the word `undefined` or a TypeError into the message (`cp -t`, `touch -r`, `du -d`).
 *
 * @type {Record<string, { short: string, long: string[], optional?: string, operands?: 'stop', usage?: string[], status?: number, bare?: boolean }>}
 */
const OPTION_VALUES = {
	xargs: { short: 'ILnsPdEa', long: ['--max-args', '--max-chars', '--max-procs', '--delimiter', '--arg-file', '--process-slot-var'], optional: 'iel', operands: 'stop' },
	grep: { short: 'efmABCdDX', long: ['--regexp', '--file', '--max-count', '--after-context', '--before-context', '--context', '--include', '--exclude', '--exclude-from', '--exclude-dir', '--directories', '--devices', '--label', '--binary-files', '--group-separator'], usage: ['Usage: grep [OPTION]... PATTERNS [FILE]...'], status: 2 },
	cp: { short: 'tS', long: ['--target-directory', '--suffix', '--sparse', '--no-preserve'] },
	mv: { short: 'tS', long: ['--target-directory', '--suffix'] },
	rm: { short: '', long: [] },
	mkdir: { short: 'm', long: ['--mode'] },
	sed: { short: 'eflV', long: ['--expression', '--file', '--line-length'], optional: 'i', usage: ['Usage: sed [OPTION]... {script-only-if-no-other-script} [input-file]...'] },
	paste: { short: 'd', long: ['--delimiters'] },
	head: { short: 'nc', long: ['--lines', '--bytes'] },
	tail: { short: 'ncs', long: ['--lines', '--bytes', '--sleep-interval', '--pid', '--max-unchanged-stats'] },
	stat: { short: 'c', long: ['--format', '--printf', '--cached'] },
	uniq: { short: 'fsw', long: ['--skip-fields', '--skip-chars', '--check-chars'] },
	wc: { short: '', long: ['--files0-from'] },
	touch: { short: 'drt', long: ['--date', '--reference', '--time'] },
	ls: { short: 'wIT', long: ['--width', '--ignore', '--tabsize', '--block-size', '--hide', '--format', '--sort', '--time', '--time-style', '--indicator-style', '--quoting-style'], status: 2 },
	sort: { short: 'ktoSTy', long: ['--key', '--field-separator', '--output', '--buffer-size', '--temporary-directory', '--parallel', '--batch-size', '--files0-from', '--random-source', '--sort', '--compress-program'], status: 2 },
	du: { short: 'dBtX', long: ['--max-depth', '--block-size', '--threshold', '--exclude', '--exclude-from', '--files0-from', '--time-style'] },
	// gawk takes its long options to the short letter and says that one, without quotes
	awk: { short: 'fvFeEilWZ', long: ['--file', '--assign', '--field-separator', '--source', '--exec', '--include', '--load'], usage: ['Usage: awk [POSIX or GNU style options] -f progfile [--] file ...'], bare: true, longAs: { '--file': 'f', '--assign': 'v', '--field-separator': 'F', '--source': 'e', '--exec': 'E', '--include': 'i', '--load': 'l' } },
	date: { short: 'dfrs', long: ['--date', '--file', '--reference', '--set', '--rfc-3339'], optional: 'I' },
	od: { short: 'AtjNS', long: ['--address-radix', '--format', '--skip-bytes', '--read-bytes', '--endian'], optional: 'w' },
	realpath: { short: '', long: ['--relative-to', '--relative-base'] },
	cmp: { short: 'in', long: ['--ignore-initial', '--bytes'], status: 2, tryPrefix: 'cmp: ' },
	nproc: { short: '', long: ['--ignore'] },
	basename: { short: 's', long: ['--suffix'] },
	comm: { short: '', long: ['--output-delimiter'] },
	join: { short: '12ajeotv', long: [] },
	cut: { short: 'bcdf', long: ['--bytes', '--characters', '--delimiter', '--fields', '--output-delimiter'] },
	tac: { short: 's', long: ['--separator'] },
};
OPTION_VALUES.egrep = OPTION_VALUES.grep;
OPTION_VALUES.fgrep = OPTION_VALUES.grep;

/**
 * Does the command line end in an option that needs a value? GNU's getopt says so in its own words, and the program
 * does not run:
 *
 *   xargs: option requires an argument -- 'n'            (a short option)
 *   cp: option '--target-directory' requires an argument  (a long one)
 *   Try 'cp --help' for more information.
 *
 * (grep, sed and awk print their usage line instead of "Try".) Only a value that is missing is reported: the next
 * argument is the value whatever it looks like, as it is in getopt, and `--` ends the options.
 *
 * @param {string} program
 * @param {string[]} args
 * @returns {{ stdout: string, stderr: string, exitCode: number } | null}
 */
function missingOptionValue(program, args) {
	const t = OPTION_VALUES[program];
	if (!t) { return null; }
	const name = program === 'egrep' || program === 'fgrep' ? 'grep' : program;
	// grep prints its usage line and then "Try"; sed and awk print their usage (here its first line) and nothing else
	const tail = program === 'sed' || program === 'awk' ? '' : `${t.tryPrefix || ''}Try '${name} --help' for more information.\n`;
	const say = (what) => ({ stdout: '', stderr: `${name}: ${what}\n` + (t.usage ? t.usage.join('\n') + '\n' : '') + tail, exitCode: t.status || 1 });
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (a === '--') { return null; }
		if (a === '-' || !a.startsWith('-')) {
			if (t.operands === 'stop') { return null; }
			continue;
		}
		if (a.startsWith('--')) {
			const eq = a.indexOf('=');
			if (eq < 0 && t.long.includes(a)) {
				if (i + 1 >= args.length) { return say(t.longAs ? `option requires an argument -- ${t.longAs[a]}` : `option '${a}' requires an argument`); }
				i++;
			}
			continue;
		}
		for (let c = 1; c < a.length; c++) {
			if (t.short.includes(a[c])) {
				if (c === a.length - 1) {
					if (i + 1 >= args.length) { return say(`option requires an argument -- ${t.bare ? a[c] : `'${a[c]}'`}`); }
					i++;
				}
				break;
			}
			if (t.optional && t.optional.includes(a[c])) { break; }
		}
	}
	return null;
}

/**
 * The one reader of a short-option CLUSTER for the programs whose table (OPTION_VALUES) says which letters take a value:
 * getopt gives the rest of the cluster (or the next argument) to the first such letter, wherever it stands in it. The
 * engine's programs and several wrappers know a valued option only as the FIRST letter of a cluster, so `grep -nA1`,
 * `head -qn1`, `cut -sf1`, `cut -sd, -f1` were `invalid option`. A cluster is cut at the valued letter into the letters
 * before it, the letter, and its value, each an argument of its own (`-nA1` is `-n -A 1`). A letter of `optional`
 * (`sed -ni`, `-i.bak`) takes the rest as its own value and ends the cluster: such an argument is left whole. Values are
 * never looked at (the next argument is the value whatever it looks like), `--` ends the options, and a program that
 * stops reading options at its first operand (xargs) stops here too.
 *
 * @param {string} program
 * @param {string[]} args
 * @returns {string[]}
 */
function splitClusters(program, args) {
	const t = OPTION_VALUES[program];
	if (!t || !t.short) { return args; }
	/** @type {string[]} */
	const out = [];
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (a === '--' || (t.operands === 'stop' && (a === '-' || !a.startsWith('-')))) { out.push(...args.slice(i)); break; }
		if (a.startsWith('--')) {
			out.push(a);
			// `--name VALUE`: the next argument is the value whatever it looks like (`--lines -3`)
			if (a.indexOf('=') < 0 && t.long.includes(a) && i + 1 < args.length) { out.push(args[++i]); }
			continue;
		}
		if (a === '-' || !a.startsWith('-')) { out.push(a); continue; }
		let c = 1;
		let stop = false;
		for (; c < a.length; c++) {
			if (t.short.includes(a[c])) { break; }
			if (t.optional && t.optional.includes(a[c])) { stop = true; break; }
		}
		const drop = CLUSTER_DROP[program] || '';
		const letters = (x) => (drop === '' ? x : '-' + x.slice(1).split('').filter((ch) => !drop.includes(ch)).join(''));
		if (stop && c > 1) {
			// `-uIminutes`: the letters before it, and the option with an optional value (its rest) on its own
			if (letters(a.slice(0, c)) !== '-') { out.push(letters(a.slice(0, c))); }
			out.push('-' + a.slice(c));
			continue;
		}
		if (stop || c >= a.length) { if (letters(a) !== '-') { out.push(letters(a)); } continue; }
		if (letters(a.slice(0, c)) !== '-') { out.push(letters(a.slice(0, c))); }
		out.push('-' + a[c]);
		const rest = a.slice(c + 1);
		if (rest !== '') { out.push(rest); } else if (i + 1 < args.length) { out.push(args[++i]); }
	}
	return out;
}

/**
 * `--` ends the options. The engine's programs do not read it (`head: unrecognized option '--'`, `tac: --: No such file
 * or directory`), so it is taken here: what follows are operands, and a name that starts with a dash is made safe with
 * `./` (`-` alone stays standard input). Where the `--` stands is found with the table's valued options in mind, so
 * that it can be the VALUE of one (`head -n -- f` is an error in GNU too).
 *
 * @param {string} program
 * @param {string[]} args
 * @returns {string[]}
 */
function endOptions(program, args) {
	const t = OPTION_VALUES[program] || { short: '', long: [] };
	// (what env and date are given is not a file: it stays as it is. basename and dirname read `--` themselves)
	const names = !['basename', 'dirname', 'env', 'date'].includes(program);
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (a === '--') {
			return [...args.slice(0, i), ...args.slice(i + 1).map((f) => (names && f !== '-' && f.startsWith('-') ? './' + f : f))];
		}
		if (t.operands === 'stop' && (a === '-' || !a.startsWith('-'))) { return args; }
		if (a.startsWith('--')) {
			if (a.indexOf('=') < 0 && t.long.includes(a)) { i++; }
			continue;
		}
		if (a === '-' || !a.startsWith('-')) { continue; }
		for (let c = 1; c < a.length; c++) {
			if (t.short.includes(a[c])) { if (c === a.length - 1) { i++; } break; }
			if (t.optional && t.optional.includes(a[c])) { break; }
		}
	}
	return args;
}

/** the programs that get `splitClusters` and `endOptions` before they run (each is a name of OPTION_VALUES or a program without valued options) */
const CLUSTERED = new Set(['grep', 'egrep', 'fgrep', 'head', 'tail', 'cut', 'touch', 'paste', 'basename', 'date']);
/** letters of a cluster that GNU takes and that mean nothing here (cut's `-n`: do not split multibyte characters) */
const CLUSTER_DROP = { cut: 'n' };
const DASHDASH = new Set(['head', 'tail', 'sed', 'cut', 'md5sum', 'sha1sum', 'sha256sum', 'tac', 'file', 'comm', 'cmp', 'jq', 'env', 'date']);
/**
 * Programs that take `-` for standard input as an operand where the engine's own treats it as a file called `-` (`sort - g`
 * dropped the input, `tail -`, `nl -`, `awk '...' -`, `fold -` said No such file), and the ones that read it for the
 * first `-` and again for the second (GNU's second `-` is at the end of the input: `wc - -` counts it once). Both are
 * given a file that holds standard input, and an empty one for each `-` after it.
 */
const STDIN_ALWAYS = new Set(['sort', 'cut', 'tac', 'nl', 'tail', 'awk', 'fold', 'expand', 'unexpand', 'file']);
const STDIN_ONCE = new Set(['cat', 'head', 'wc', 'od', 'md5sum', 'sha1sum', 'sha256sum']);
/** what GNU calls standard input in the output of a program that names its inputs */
const STDIN_NAME = { head: 'standard input', tail: 'standard input', file: '/dev/stdin' };
/** the programs `commands()` adds only to say `--` and `-` the way GNU does */
const THIN = ['tac', 'nl', 'fold', 'expand', 'unexpand', 'cat', 'md5sum', 'sha1sum', 'sha256sum', 'file', 'env', 'jq'];

/**
 * The indexes of the operands of a command line (what is not an option and not the value of one of the program's
 * table; everything after `--`).
 *
 * @param {string} program
 * @param {string[]} args
 * @returns {number[]}
 */
function operandIndexes(program, args) {
	const t = OPTION_VALUES[program] || { short: '', long: [] };
	const out = [];
	let ended = false;
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (ended || a === '-' || !a.startsWith('-')) { out.push(i); continue; }
		if (a === '--') { ended = true; continue; }
		if (a.startsWith('--')) {
			if (a.indexOf('=') < 0 && t.long.includes(a)) { i++; }
			continue;
		}
		for (let c = 1; c < a.length; c++) {
			if (t.short.includes(a[c])) { if (c === a.length - 1) { i++; } break; }
			if (t.optional && t.optional.includes(a[c])) { break; }
		}
	}
	return out;
}

/** the indexes of the arguments that are the operand `-` (standard input) */
const dashOperands = (program, args) => operandIndexes(program, args).filter((i) => args[i] === '-');

/* ------------------------------------------------------------------------------------------------------------ */
/* argument normalisers                                                                                          */
/* ------------------------------------------------------------------------------------------------------------ */

/**
 * xargs for the ENGINE's xargs: the arguments it takes, from GNU's. This is what the `xargs` command hands over when
 * it cannot start commands itself (no `ctx.exec`) or meets an option `parseXargs` does not know; the command proper
 * is `parseXargs` + `xargsInput` + `xargsPlan` below. The engine takes `-I REPLACE`, `-n NUM`, `-P NUM`, `-d DELIM`,
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
	/** the option and its value, or the option alone when the line ended before the value (the engine says what is missing) */
	const withValue = (flag, v) => (v === undefined ? [flag] : [flag, String(v)]);
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
				case '--replace': out.push('-I', attached !== null ? attached : '{}'); break;
				case '--max-args': case '--max-lines': out.push(...withValue('-n', value())); break;
				case '--delimiter': out.push(...withValue('-d', value())); break;
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
				case 'I': out.push(...withValue('-I', value())); break;
				case 'i': consumed = true; out.push('-I', rest !== '' ? rest : '{}'); break;
				case 'n': out.push(...withValue('-n', value())); break;
				case 'L': out.push(...withValue('-n', value())); break;
				case 'l': consumed = true; out.push('-n', rest !== '' ? rest : '1'); break;
				case 'd': out.push(...withValue('-d', value())); break;
				case 'P': case 's': case 'E': value(); break;
				case 'e': consumed = true; break;
				default: out.push('-' + ch);
			}
		}
	}
	out.push(...args.slice(i));
	return out;
}

/**
 * GNU's default for -s: the command line xargs builds is at most this many bytes (the NUL that ends each word counted).
 * The system's own limit can be smaller, never the default larger.
 */
const XARGS_DEFAULT_CHARS = 128 * 1024;
/** What GNU's `xargs --show-limits` calls the POSIX upper limit, with an empty environment: ARG_MAX less 2048 of headroom. */
const XARGS_UPPER_LIMIT = 2097152 - 2048;

/** The bytes of a string as UTF-8 (a byte that is not UTF-8 is held as U+DC80..U+DCFF and is one). */
function utf8Length(s) {
	let n = 0;
	for (let i = 0; i < s.length; i++) {
		const c = s.charCodeAt(i);
		if (c < 0x80) {
			n += 1;
		} else if (c < 0x800) {
			n += 2;
		} else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
			n += 4;
			i++;
		} else if (c >= 0xdc80 && c <= 0xdcff) {
			n += 1;
		} else {
			n += 3;
		}
	}
	return n;
}

/**
 * xargs, the part that is parsing: GNU's options. The engine's xargs splits its input on any white space, takes no
 * `-L`, `-E` or `-a`, and gives `-I` one invocation per WORD (`ls | xargs -I{} echo file:{}` split `f s.txt`), so this
 * file runs xargs itself and hands the engine only the commands it starts.
 *
 * @param {string[]} args
 * @param {number} [upperLimit] what -s may be at most (GNU: ARG_MAX less the environment and 2048); above it GNU warns
 *   and uses it
 * @returns {{ opts: { nul: boolean, delim: string | null, replace: string | null, eof: string | null, maxLines: number | null, maxArgs: number | null, maxChars: number | null, exitIfExceeded: boolean, prompt: boolean, openTty: boolean, verbose: boolean, noRun: boolean, argFile: string | null }, command: string[], warnings: string[] } | { error: string } | null}
 *   null for an option this parser does not know: the caller leaves the command line to the engine
 */
function parseXargs(args, upperLimit = XARGS_UPPER_LIMIT) {
	const opts = { nul: false, delim: /** @type {string | null} */ (null), replace: /** @type {string | null} */ (null), eof: /** @type {string | null} */ (null), maxLines: /** @type {number | null} */ (null), maxArgs: /** @type {number | null} */ (null), maxChars: /** @type {number | null} */ (null), exitIfExceeded: false, prompt: false, openTty: false, verbose: false, noRun: false, argFile: /** @type {string | null} */ (null) };
	const warnings = [];
	const fail = (m) => ({ error: `xargs: ${m}\nTry 'xargs --help' for more information.\n` });
	const missing = missingOptionValue('xargs', args);
	if (missing) { return { error: missing.stderr }; }
	const number = (v, flag, min) => {
		if (!/^[-+]?\d+$/.test(String(v))) { return fail(`invalid number "${v}" for ${flag} option`); }
		if (Number(v) < min) { return fail(`value ${v} for ${flag} option should be >= ${min}`); }
		return Number(v);
	};
	/** -s is the one option whose bad value is said without the usage hint and not stopped on: nothing fits then */
	const setChars = (v) => {
		if (!/^[-+]?\d+$/.test(String(v))) { return fail(`invalid number "${v}" for -s option`); }
		const n = Number(v);
		if (n < 1) { return { error: `xargs: value ${v} for -s option should be >= 1\nxargs: cannot fit single argument within argument list size limit\n` }; }
		if (n > upperLimit) {
			warnings.push(`xargs: value ${v} for -s option should be <= ${upperLimit}\n`);
			opts.maxChars = upperLimit;
		} else {
			opts.maxChars = n;
		}
		return null;
	};
	/** `name` is how GNU names the option that came last: `-L`, or `--max-lines/-l` for -l and --max-lines */
	const setLines = (n, name) => {
		if (opts.replace !== null) { warnings.push(`xargs: warning: options --replace and ${name} are mutually exclusive, ignoring previous --replace value\n`); opts.replace = null; }
		if (opts.maxArgs !== null) { warnings.push(`xargs: warning: options --max-args and ${name} are mutually exclusive, ignoring previous --max-args value\n`); opts.maxArgs = null; }
		opts.maxLines = n;
	};
	const setArgs = (n) => {
		if (opts.maxLines !== null) { warnings.push('xargs: warning: options --max-lines and --max-args/-n are mutually exclusive, ignoring previous --max-lines value\n'); opts.maxLines = null; }
		opts.maxArgs = n;
	};
	const setReplace = (r) => {
		if (opts.maxLines !== null) { warnings.push('xargs: warning: options --max-lines and --replace/-I/-i are mutually exclusive, ignoring previous --max-lines value\n'); opts.maxLines = null; }
		if (opts.maxArgs !== null) { warnings.push('xargs: warning: options --max-args and --replace/-I/-i are mutually exclusive, ignoring previous --max-args value\n'); opts.maxArgs = null; }
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
	const badDelimiter = { error: 'xargs: Invalid input delimiter specification : the delimiter must be either a single character or an escape sequence starting with \\.\n' };
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
				case '--exit': opts.exitIfExceeded = true; break;
				case '--interactive': opts.prompt = true; break;
				case '--open-tty': opts.openTty = true; break;
				case '--show-limits': break;
				case '--max-procs': case '--process-slot-var': value(); break;
				case '--max-chars': { const e = setChars(value()); if (e) { return e; } break; }
				case '--replace': setReplace(attached !== null ? attached : '{}'); break;
				case '--eof': opts.eof = attached === null || attached === '' ? null : attached; break;
				case '--max-lines': { const n = attached === null ? 1 : number(attached, '-L', 1); if (typeof n !== 'number') { return n; } setLines(n, '--max-lines/-l'); break; }
				case '--max-args': { const n = number(value(), '-n', 1); if (typeof n !== 'number') { return n; } setArgs(n); break; }
				case '--delimiter': { const d = delimiter(String(value())); if (d === null) { return badDelimiter; } opts.delim = d; break; }
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
			if (ch === '0') {
				opts.nul = true;
			} else if (ch === 'r') {
				opts.noRun = true;
			} else if (ch === 't') {
				opts.verbose = true;
			} else if (ch === 'x') {
				opts.exitIfExceeded = true;
			} else if (ch === 'p') {
				opts.prompt = true;
			} else if (ch === 'o') {
				opts.openTty = true;
			} else if (ch === 'I') {
				setReplace(String(value()));
			} else if (ch === 'i') {
				c = a.length;
				setReplace(rest !== '' ? rest : '{}');
			} else if (ch === 'L') {
				const n = number(value(), '-L', 1);
				if (typeof n !== 'number') { return n; }
				setLines(n, '-L');
			} else if (ch === 'l') {
				c = a.length;
				const n = rest !== '' ? number(rest, '-l', 1) : 1;
				if (typeof n !== 'number') { return n; }
				setLines(n, '--max-lines/-l');
			} else if (ch === 'n') {
				const n = number(value(), '-n', 1);
				if (typeof n !== 'number') { return n; }
				setArgs(n);
			} else if (ch === 'E') {
				const v = value();
				opts.eof = v === '' ? null : String(v);
			} else if (ch === 'e') {
				c = a.length;
				opts.eof = rest === '' ? null : rest;
			} else if (ch === 'd') {
				const d = delimiter(String(value()));
				if (d === null) { return badDelimiter; }
				opts.delim = d;
			} else if (ch === 'a') {
				opts.argFile = String(value());
			} else if (ch === 's') {
				const e = setChars(value());
				if (e) { return e; }
			} else if (ch === 'P') {
				const n = number(value(), '-P', 0);
				if (typeof n !== 'number') { return n; }
			} else {
				return null;
			}
		}
	}
	// -E and -e are read only with blanks and newlines as separators: GNU says so, in a message that ends in a newline of
	// its own (hence the empty line after it)
	if (opts.eof !== null && (opts.nul || opts.delim !== null)) {
		warnings.push('xargs: warning: the -E option has no effect if -0 or -d is used.\n\n');
	}
	return { opts, command: args.slice(i), warnings };
}

/**
 * xargs input as GNU reads it: the items of each line (a blank line has none). Without -0 and -d, blanks and newlines
 * separate items, `'..'` and `".."` group, and a backslash takes the next character as it is; with -I the separator is
 * the newline alone (leading blanks are dropped, the quotes still work). A quote that is not closed is an error, and
 * reading stops there: the items that were complete before it are returned (GNU runs them), not the word the quote
 * sits in, and with -I or -L (a line is run whole or not at all) not the line it is in.
 *
 * @param {string} input
 * @param {{ nul: boolean, delim: string | null, replace: string | null, eof: string | null, maxLines?: number | null }} o
 * @returns {{ lines: Array<string[] & { continued?: boolean }>, error: string | null, nul: boolean }} `nul`: an item has a
 *   NUL in it, which GNU says (once) when blanks and newlines are the separators
 */
function xargsInput(input, o) {
	/** @type {Array<string[] & { continued?: boolean }>} */
	const lines = [];
	if (o.nul || o.delim !== null) {
		const d = o.nul ? '\0' : /** @type {string} */ (o.delim);
		const items = input.split(d);
		if (items.length && items[items.length - 1] === '') { items.pop(); }
		for (const it of items) { lines.push([it]); }
		return { lines, error: null, nul: false };
	}
	const replaceMode = o.replace !== null;
	const wholeLines = replaceMode || (o.maxLines !== null && o.maxLines !== undefined);
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
				if (!wholeLines && line.length) { lines.push(line); }
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
	// a NUL in what blanks and newlines separated is said (once); the argument that holds it ends there, which is what
	// the command is given (run: a C string)
	const nul = lines.some((l) => l.some((it) => it.includes('\0')));
	if (o.eof !== null) {
		for (let k = 0; k < lines.length; k++) {
			const at = lines[k].indexOf(o.eof);
			if (at >= 0) { lines[k] = Object.assign(lines[k].slice(0, at), { continued: false }); lines.length = lines[k].length ? k + 1 : k; break; }
		}
	}
	return { lines, error: null, nul };
}

/**
 * The commands xargs runs, in order, from the input lines: what GNU's buildcmd does. One item per run with -I; N
 * logical lines with -L (a line that ends in a blank continues into the next); N items with -n; and every command
 * line holds at most `size.chars` bytes, the NUL that ends each word counted (the command and its own arguments too),
 * so a long list is many runs, as it is in GNU. The events are in the order GNU does them:
 *
 *   * `{ argv }`: a run. The batch that is open runs when the next argument does not fit or at the end of the input
 *     (after what stopped the reading was said)
 *   * `{ error, fatal: false }`: the reading stopped (an unmatched quote, one argument that cannot fit); what was read
 *     before it still runs, after the message
 *   * `{ error, fatal: true }`: GNU exits at once, the open batch is not run (`-I` or -L/-n with -x and a command line
 *     that is too long; nothing fits at all)
 *
 * @param {Array<string[] & { continued?: boolean }>} lines
 * @param {{ replace: string | null, maxLines: number | null, maxArgs: number | null, exitIfExceeded?: boolean, noRun?: boolean }} o
 * @param {string[]} base the command and its own arguments
 * @param {{ chars: number, items: number } | null} [size] -s, and how many arguments the shell accepts for one command;
 *   null is no bound
 * @param {string | null} [inputError] what stopped the reading of the input
 * @returns {Array<{ argv: string[] } | { error: string, fatal: boolean }>}
 */
function xargsPlan(lines, o, base, size = null, inputError = null) {
	const max = size ? size.chars : Infinity;
	const room = size ? Math.max(1, size.items - base.length) : Infinity;
	const cost = (w) => utf8Length(w) + 1;
	/** @type {Array<{ argv: string[] } | { error: string, fatal: boolean }>} */
	const events = [];
	let stopped = inputError;
	if (o.replace !== null) {
		if (o.replace === '' && lines.length) {
			// the command word is never changed: with nothing after it there is nowhere to put an item, and the command
			// is run once for each line with no argument (its size is checked as it is for any replace string)
			if (base.length === 1) { return xargsPlan(lines, Object.assign({}, o, { replace: '\u0000' }), base, size, inputError); }
			// an empty string is found at every place of every word, so the command line of the first item grows until it
			// is too long. The checks of -s that come before a command is built come first, in the words they have with -I
			// (the item that cannot fit, the command that cannot); what gets past them is the growing line
			const first = xargsPlan(lines.slice(0, 1), Object.assign({}, o, { replace: '\u0000' }), base, size, null)[0];
			if (first && 'error' in first && /argument line too long|cannot fit single argument/.test(first.error)) { return [Object.assign({}, first, { fatal: true })]; }
			return [{ error: 'xargs: command too long\n', fatal: true }];
		}
		for (const [at, l] of lines.entries()) {
			const item = l.join(' ');
			// a line is measured against the whole limit when it is the first, and against what is left of it by the
			// command word when a command is waiting (GNU keeps the size of the command from the first line on)
			if (cost(item) > (at === 0 ? max : max - cost(base[0]))) { stopped = 'xargs: argument line too long\n'; break; }
			const argv = [base[0], ...base.slice(1).map((w) => w.split(/** @type {string} */ (o.replace)).join(item))];
			// GNU puts the words in one at a time (the command word is never replaced): the command alone that does not
			// fit is the startup error, and a word that does not fit after the others is "too long" when it would not fit
			// alone either (its size reaches the limit) and "argument list too long" when only the sum is
			let total = 0;
			for (let i = 0; i < argv.length; i++) {
				const c = cost(argv[i]);
				if (i === 0 && c > max) { return [...events, { error: 'xargs: cannot fit single argument within argument list size limit\n', fatal: true }]; }
				if (total + c > max) { return [...events, { error: c >= max ? 'xargs: command too long\n' : 'xargs: argument list too long\n', fatal: true }]; }
				total += c;
			}
			events.push({ argv });
		}
		if (stopped) { events.push({ error: stopped, fatal: false }); }
		return events;
	}
	const initial = base.reduce((n, w) => n + cost(w), 0);
	if (initial > max) { return [{ error: 'xargs: cannot fit single argument within argument list size limit\n', fatal: true }]; }
	/** the logical lines of -L, else every item on its own */
	const units = [];
	if (o.maxLines !== null) {
		let open = null;
		for (const l of lines) {
			open = open ? open.concat(l) : l.slice();
			if (!l.continued) { units.push(open); open = null; }
		}
		if (open) { units.push(open); }
	} else {
		for (const l of lines) { for (const w of l) { units.push([w]); } }
	}
	let cur = [];
	let chars = initial;
	let count = 0;
	const flush = () => {
		if (cur.length) { events.push({ argv: [...base, ...cur] }); }
		cur = [];
		chars = initial;
		count = 0;
	};
	// -L implies -x; -x has an effect with -L and -n only
	const exact = o.maxLines !== null || (!!o.exitIfExceeded && o.maxArgs !== null);
	const full = () => (o.maxArgs !== null && cur.length >= o.maxArgs) || (o.maxLines !== null && count >= o.maxLines);
	scan: for (const u of units) {
		// a full batch runs when the next argument arrives, which is after the message about a quote that follows it
		if (full()) { flush(); }
		for (const w of u) {
			const n = cost(w);
			if (initial + n > max) {
				stopped = 'xargs: argument line too long\n';
				break scan;
			}
			if (chars + n > max) {
				if (exact) { return [...events, { error: 'xargs: argument list too long\n', fatal: true }]; }
				flush();
			} else if (cur.length >= room) {
				flush();
			}
			cur.push(w);
			chars += n;
		}
		count++;
	}
	if (stopped) {
		// with -x (which -L implies) the batch that was still being filled is not run, whatever stopped the reading; a
		// full one is
		if ((exact || o.exitIfExceeded) && !full()) { cur = []; }
		// what is open is sent off (and traced by -t) before the reading is said to have stopped: an item that does not
		// fit is found when the batch before it is being run, and GNU says the quote that is not closed after the
		// batch that came before it
		flush();
		events.push({ error: stopped, fatal: false });
	}
	flush();
	// nothing to read: GNU runs the command once, without arguments, unless -r
	if (!events.length && !o.noRun) { events.push({ argv: base.slice() }); }
	return events;
}

/**
 * Shell builtins that are no program on a system with GNU coreutils: `xargs cd`, `xargs exit 3` and `xargs export A=1`
 * are "No such file or directory", status 127, because xargs starts a program and has no shell to ask (`echo`, `printf`,
 * `pwd`, `true`, `false`, `test` and `[` are programs too, and are not here).
 */
const NOT_PROGRAMS = new Set(['cd', 'exit', 'export', 'type', 'set', 'unset', 'alias', 'unalias', 'read', 'source', '.', 'eval', 'local', 'declare', 'typeset', 'readonly', 'let', 'shift', 'return', 'break', 'continue', 'builtin', 'command', 'hash', 'history', 'jobs', 'fg', 'bg', 'wait', 'trap', 'ulimit', 'umask', 'exec', 'getopts', 'shopt', 'enable', 'help', 'dirs', 'pushd', 'popd', 'suspend', 'times', 'caller', 'mapfile', 'readarray', 'compgen', 'complete', 'bind', 'disown', 'logout', 'fc']);

/** A word as one shell word, quoted so that nothing in it means anything. */
function shellQuote(w) { return "'" + w.replace(/'/g, "'\\''") + "'"; }

/**
 * A word as `xargs -t` shows it: gnulib's shell-escape quoting, as findutils 4.8 uses it, recorded character class by
 * character class (1,480 words of the reference: every printable ASCII character after a quote, alone, first, and in
 * random strings). A word of characters no shell treats specially is as it is (`x{}y`, `a%b`, `é`); one with a space or
 * one of `!"$&()*;<=>?[\^`|` (or a leading `#` or `~`, or a lone `{` or `}`) is in single quotes; one that holds a single
 * quote and none of those, nor `{ } # ~` in the middle, is in double quotes (`"it's"`); otherwise a quote is `'\''`.
 * A control character is written as `$'\n'` / `$'\001'` between quoted runs (`'a'$'\t''b'`), and a word that holds a
 * quote and ends in one is written with an extra pair of quotes in front (gnulib's, kept as it is).
 *
 * @param {string} w
 * @returns {string}
 */
function xargsQuote(w) {
	if (w === '') { return "''"; }
	const chars = [...w];
	/** the bytes of a character a terminal cannot show: a control character, and an escaped byte that is not UTF-8 */
	const raw = (ch) => {
		const c = /** @type {number} */ (ch.codePointAt(0));
		if (c < 0x20 || c === 0x7f) { return [c]; }
		if (c >= 0x80 && c <= 0x9f) { return [0xc2, c]; }
		if (c >= 0xdc80 && c <= 0xdcff) { return [c & 0xff]; }
		return null;
	};
	const hostile = (ch, i) => ' !"$&()*;<=>?[\\^`|'.includes(ch) || (i === 0 && (ch === '#' || ch === '~'));
	if (!chars.some((ch) => raw(ch))) {
		const quoted = chars.includes("'");
		if (!quoted && !chars.some((ch, i) => hostile(ch, i)) && w !== '{' && w !== '}') { return w; }
		// a single quote makes the double-quoted form possible, unless something else needs the single-quoted one
		if (quoted && !chars.some((ch, i) => '!"#$&()*;<=>?[\\^`{|}~'.includes(ch) && !(i === 0 && (ch === '#' || ch === '~')))) { return `"${w}"`; }
		return "'" + w.replace(/'/g, "'\\''") + "'";
	}
	const named = { 7: '\\a', 8: '\\b', 9: '\\t', 10: '\\n', 11: '\\v', 12: '\\f', 13: '\\r' };
	let out = "'";
	let escaped = false;
	for (const ch of chars) {
		const bytes = raw(ch);
		if (bytes) {
			if (!escaped) { out += "'$'"; escaped = true; }
			out += bytes.length === 1 && named[bytes[0]] ? named[bytes[0]] : bytes.map((b) => '\\' + b.toString(8).padStart(3, '0')).join('');
			continue;
		}
		if (ch === "'") { out += "'\\''"; escaped = false; continue; }
		if (escaped) { out += "''"; escaped = false; }
		out += ch;
	}
	out += "'";
	if (chars.includes("'") && raw(chars[chars.length - 1]) && chars[0] !== "'") {
		out = raw(chars[0]) ? "'" + out.slice(4) : "''" + out;
	}
	return out;
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
 * `-d ACTION` / `--directories=ACTION` and `-D ACTION` / `--devices=ACTION` of grep, taken out of the arguments (the
 * engine has neither). ACTION of -d is read, recurse or skip, or a prefix that is only one of them; recurse is `-r`.
 * What is left: the arguments, and what to do with a folder given as a file.
 *
 * @param {string[]} args
 * @returns {{ args: string[], action: 'read' | 'skip' | 'recurse', result?: { stdout: string, stderr: string, exitCode: number } }}
 */
function grepDirectories(args) {
	const kept = [];
	let action = 'read';
	let result;
	const words = ['read', 'recurse', 'skip'];
	const bad = (kind, value, ambiguous) => ({
		stdout: '',
		stderr: `grep: ${ambiguous ? 'ambiguous' : 'invalid'} argument '${value}' for '--${kind}'\nValid arguments are:\n${words.map((w) => `  - '${w}'`).join('\n')}\nUsage: grep [OPTION]... PATTERNS [FILE]...\nTry 'grep --help' for more information.\n`,
		exitCode: 1,
	});
	const take = (kind, value) => {
		if (result) { return; }
		if (kind === 'devices') {
			if (value !== 'read' && value !== 'skip') { result = { stdout: '', stderr: 'grep: unknown devices method\n', exitCode: 2 }; }
			return;
		}
		const exact = words.find((w) => w === value);
		const prefixed = exact ? [exact] : words.filter((w) => value !== '' && w.startsWith(value));
		if (prefixed.length === 1) { action = /** @type {any} */ (prefixed[0]); } else { result = bad('directories', value, prefixed.length > 1); }
	};
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (a === '--') { kept.push(...args.slice(i)); break; }
		if (a === '-' || !a.startsWith('-')) { kept.push(a); continue; }
		if (a.startsWith('--')) {
			const eq = a.indexOf('=');
			const name = eq < 0 ? a : a.slice(0, eq);
			if (name === '--directories' || name === '--devices') {
				const value = eq >= 0 ? a.slice(eq + 1) : args[++i];
				if (value === undefined) { kept.push(a); continue; }
				take(name.slice(2), value);
				continue;
			}
			kept.push(a);
			continue;
		}
		let cluster = '-';
		let taken = false;
		for (let c = 1; c < a.length; c++) {
			const ch = a[c];
			if (ch === 'd' || ch === 'D') {
				const value = c < a.length - 1 ? a.slice(c + 1) : args[++i];
				if (value === undefined) { cluster += a.slice(c); break; }
				take(ch === 'd' ? 'directories' : 'devices', value);
				taken = true;
				break;
			}
			if (GREP_SHORT_VALUE.has(ch)) { cluster += a.slice(c); if (c === a.length - 1 && i + 1 < args.length) { kept.push(cluster); cluster = ''; kept.push(args[++i]); } break; }
			cluster += ch;
		}
		if (cluster !== '-' && cluster !== '') { kept.push(cluster); } else if (!taken && cluster === '-') { kept.push(a); }
	}
	if (action === 'recurse') { kept.unshift('-r'); }
	return { args: kept, action, result };
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
		// a cluster: drop the letters that mean nothing here, keep the order of the rest; digits are -NUM, which is -C NUM
		let kept = '-';
		let takesValue = false;
		let digits = '';
		for (let c = 1; c < a.length; c++) {
			const ch = a[c];
			if (GREP_SHORT_VALUE.has(ch)) {
				kept += a.slice(c);                       // the rest of the cluster is this option's value
				takesValue = c === a.length - 1;
				break;
			}
			if (ch >= '0' && ch <= '9') { digits += ch; continue; }
			if (!GREP_DROP_SHORT.has(ch)) { kept += ch; }
		}
		if (kept !== '-') { out.push(kept); }
		if (digits !== '') { out.push('-C', digits); }
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
 * Was -f / --force given (cp)? Only the options before `--`, and not the values of -t and -S.
 * @param {string[]} args
 */
function wantsForce(args) {
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (a === '--') { return false; }
		if (a === '--force') { return true; }
		if (a === '--target-directory' || a === '--suffix') { i++; continue; }
		if (a.startsWith('--') || !a.startsWith('-') || a === '-') { continue; }
		for (let c = 1; c < a.length; c++) {
			if (a[c] === 'f') { return true; }
			if (a[c] === 't' || a[c] === 'S') { if (c === a.length - 1) { i++; } break; }
		}
	}
	return false;
}

/**
 * Does the command line ask cp to keep the modification times? `-p`, `-a`, `--archive`, `--preserve` alone (mode,
 * ownership, timestamps) or with a list that names timestamps (or all). The values of -t and -S end the scan.
 * @param {string[]} args
 */
function wantsPreserveTimes(args) {
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (a === '--') { return false; }
		if (a === '--archive') { return true; }
		if (a === '--preserve') { return true; }
		if (a.startsWith('--preserve=')) { return /(^|,)(timestamps|all)(,|$)/.test(a.slice(11)); }
		if (a === '--target-directory' || a === '--suffix') { i++; continue; }
		if (a.startsWith('--') || !a.startsWith('-') || a === '-') { continue; }
		for (let c = 1; c < a.length; c++) {
			if (a[c] === 'p' || a[c] === 'a') { return true; }
			if (a[c] === 't' || a[c] === 'S') { if (c === a.length - 1) { i++; } break; }
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
	/** where in `out` each operand is */
	const operandAt = [];
	let firstOperand = -1;
	let afterDashes = false;
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (afterDashes || a === '-' || !a.startsWith('-')) { if (firstOperand < 0) { firstOperand = out.length; } operands.push(a); operandAt.push(out.length); out.push(a); continue; }
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
	return { args: out, suffix, files, fileAt: script ? operandAt : operandAt.slice(1) };
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
	let dateText = null;
	let invalidStamp = null;
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
			// [[CC]YY]MMDDhhmm[.ss] is the only form GNU takes
			invalidStamp = String(stamp);
			continue;
		}
		if (date !== null) {
			const e = /^@(-?\d+)$/.exec(String(date));
			if (e) { time = Number(e[1]) * 1000; continue; }
			// GNU's date grammar (datestr.js), as `date -d` reads it: `yesterday`, `1 day ago`, `next week`, `2024-03-05 +1 week`
			const r = datestr.parse(String(date), Date.now(), tz);
			if (r && !('invalid' in r)) { time = Math.floor(r.ms / 1000) * 1000; dateText = String(date); continue; }
			out.push('-d', String(date));
			continue;
		}
		out.push(a);
		if (OPT_VALUE.has(a) && i + 1 < args.length) { out.push(args[++i]); }
	}
	return { args: out, time, files, reference, dateText, invalidStamp };
}

/**
 * Which times a touch line asks for: `-t STAMP`, `-d STRING`, `-r FILE` (GNU: -r with -d is fine, the string is read
 * relative to the file; -t with either of the others is "cannot specify times from more than one source").
 * @param {string[]} args
 */
function touchSources(args) {
	const found = { stamp: false, date: false, ref: false };
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (a === '--') { break; }
		if (a === '-' || !a.startsWith('-')) { continue; }
		if (a.startsWith('--')) {
			const name = a.split('=')[0];
			if (name === '--date') { found.date = true; } else if (name === '--reference') { found.ref = true; }
			if ((name === '--date' || name === '--reference' || name === '--time') && !a.includes('=')) { i++; }
			continue;
		}
		for (let c = 1; c < a.length; c++) {
			const ch = a[c];
			if (ch === 't') { found.stamp = true; } else if (ch === 'd') { found.date = true; } else if (ch === 'r') { found.ref = true; } else { continue; }
			if (c === a.length - 1) { i++; }
			break;
		}
	}
	return found;
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
function normalisePaste(args0) {
	// the delimiter list is read the way GNU does: \n, \t, \\ and \0 (nothing) are escapes (the engine took `\t` for a
	// backslash and a `t`)
	const args = args0.slice();
	const unescape = (v) => String(v).replace(/\\([nt\\0])/g, (_m, c) => ({ n: '\n', t: '\t', '\\': '\\', 0: '' }[c]));
	let operands = 0;
	let afterDashes = false;
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (afterDashes || a === '-' || !a.startsWith('-')) { operands++; continue; }
		if (a === '--') { afterDashes = true; continue; }
		if (a === '-d' || a === '--delimiters') { if (i + 1 < args.length) { args[i + 1] = unescape(args[i + 1]); } i++; continue; }
		if (a.startsWith('--delimiters=')) { args[i] = '--delimiters=' + unescape(a.slice(13)); continue; }
		if (a.startsWith('-') && !a.startsWith('--') && a.endsWith('d') && a.length > 1 && /^-[a-z]*d$/.test(a)) { i++; }
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

/**
 * What GNU's `quote()` writes between its quotation marks for an argument in a UTF-8 locale: a backslash is `\\`, the
 * control characters are C's escapes (`\n`, `\t` ...) or three octal digits, the rest is as it is. (The marks are
 * straight quotes here; GNU's are the curly ones.)
 *
 * @param {string} s
 * @returns {string}
 */
function gnuQuote(s) {
	const named = { 7: '\\a', 8: '\\b', 9: '\\t', 10: '\\n', 11: '\\v', 12: '\\f', 13: '\\r' };
	return String(s).replace(/[\\\u0000-\u001f\u007f]/g, (c) => {
		const n = c.charCodeAt(0);
		if (c === '\\') { return '\\\\'; }
		return named[n] || '\\' + n.toString(8).padStart(3, '0');
	});
}

/**
 * A sort key as coreutils reads it (sort.c, `case 'k'`): `POS1[,POS2]` where each position is `F[.C]` and the ordering
 * letters (`bdfghiMnRrV`) follow either one. A number is `strtoumax`'s: leading blanks and a plus sign are taken, a minus
 * sign or no digit at all is an error, and one that is too big is the largest there is (not an error). The field of
 * either position must be 1 or more and the character of the start too (an end character of 0 is "the end of the
 * field"); anything after the last position is a stray character. The error is GNU's, word for word (the quotes are
 * straight ones here).
 *
 * @param {string} spec
 * @returns {{ spec: string, start: string, end: string } | { error: string }} `spec` is the canonical text the engine
 *   reads (numbers in decimal, no blanks, no plus sign, an end character of 0 left out), `start` and `end` are the
 *   ordering letters of each position
 */
function parseSortKey(spec) {
	const s = String(spec);
	let at = 0;
	const bad = (what) => ({ error: `${what}: invalid field specification '${gnuQuote(s)}'` });
	/** strtoumax: blanks, a plus sign, digits. `null` is "invalid count" (no digit, or a minus sign). */
	const count = () => {
		let q = at;
		while (q < s.length && /[ \t\n\v\f\r]/.test(s[q])) { q++; }
		if (s[q] === '-') { return null; }
		if (s[q] === '+') { q++; }
		let d = q;
		while (d < s.length && s[d] >= '0' && s[d] <= '9') { d++; }
		if (d === q) { return null; }
		at = d;
		return Number(s.slice(q, d));
	};
	const invalid = (where) => ({ error: `${where}: invalid count at start of '${gnuQuote(s.slice(at))}'` });
	const letters = () => {
		let l = '';
		while (at < s.length && 'bdfghiMnRrV'.includes(s[at])) { l += s[at++]; }
		return l;
	};
	const field = count();
	if (field === null) { return invalid('invalid number at field start'); }
	if (field === 0) { return bad('field number is zero'); }
	let startChar = 0;
	if (s[at] === '.') {
		at++;
		const c = count();
		if (c === null) { return invalid("invalid number after '.'"); }
		if (c === 0) { return bad('character offset is zero'); }
		startChar = c;
	}
	const start = letters();
	let out = String(field) + (startChar ? '.' + startChar : '') + start;
	let end = '';
	if (s[at] === ',') {
		at++;
		const f = count();
		if (f === null) { return invalid("invalid number after ','"); }
		if (f === 0) { return bad('field number is zero'); }
		let endChar = 0;
		if (s[at] === '.') {
			at++;
			const c = count();
			if (c === null) { return invalid("invalid number after '.'"); }
			endChar = c;
		}
		end = letters();
		out += ',' + f + (endChar ? '.' + endChar : '') + end;
	}
	if (at < s.length) { return bad('stray character in field spec'); }
	return { spec: out, start, end };
}

/**
 * What GNU says when ordering options cannot be combined: more than one of -n -g -h -M and (-V, -R or -d/-i) applies to
 * a key (`sort -k1nM`: "options '-Mn' are incompatible"). The letters are named in the order of its key_to_opts.
 *
 * @param {string} letters every ordering letter that applies to the key (blanks and reverse are not part of the rule)
 * @returns {string | null} the message, or null when they combine
 */
function incompatibleOrdering(letters) {
	const has = (c) => letters.includes(c);
	const groups = (has('n') ? 1 : 0) + (has('g') ? 1 : 0) + (has('h') ? 1 : 0) + (has('M') ? 1 : 0) + (has('V') || has('R') || has('d') || has('i') ? 1 : 0);
	if (groups < 2) { return null; }
	// key_to_opts: b d f g h i M n R r V (blanks and reverse were cleared)
	return `options '-${[...'dfghiMnRV'].filter((c) => has(c)).join('')}' are incompatible`;
}

/**
 * The keys of a normalised `sort` line, read as GNU reads them: each `-k SPEC` is checked and handed to the engine in
 * its canonical form (`-k +1` and `-k ' 1'` are `-k 1`), and ordering options that cannot be combined are GNU's error,
 * for a key and for the global options a key inherits (a key with no letters of its own).
 *
 * @param {string[]} norm the arguments after `normaliseSort` (a valued option is `-k`, `-t` or `-o` and its value)
 * @returns {{ args: string[] } | { error: string }}
 */
function sortKeys(norm) {
	const args = norm.slice();
	/** @type {string[]} the ordering letters of each key */
	const keys = [];
	let global = '';
	const longLetters = { '--numeric-sort': 'n', '--general-numeric-sort': 'g', '--human-numeric-sort': 'h', '--month-sort': 'M', '--version-sort': 'V', '--random-sort': 'R', '--dictionary-order': 'd', '--ignore-nonprinting': 'i', '--reverse': 'r', '--ignore-case': 'f', '--ignore-leading-blanks': 'b' };
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (a === '--') { break; }
		if (a === '-t' || a === '-o') { i++; continue; }
		if (a === '-k') {
			const k = parseSortKey(args[i + 1] === undefined ? '' : args[i + 1]);
			if ('error' in k) { return { error: k.error }; }
			args[i + 1] = k.spec;
			keys.push(k.start + k.end);
			i++;
			continue;
		}
		if (Object.prototype.hasOwnProperty.call(longLetters, a)) { global += longLetters[a]; continue; }
		if (/^-[A-Za-z]+$/.test(a)) { global += a.slice(1); }
	}
	for (const letters of keys) {
		const bad = incompatibleOrdering(letters);
		if (bad) { return { error: bad }; }
	}
	if (!keys.length || keys.some((l) => l === '')) {
		const bad = incompatibleOrdering(global);
		if (bad) { return { error: bad }; }
	}
	return { args: inheritGlobal(args, keys, global, longLetters) };
}

/**
 * coreutils' sort gives the global ordering options (`-n -r -f -b -d -h -M -V`) to a key only when the key has none
 * of its own (`default_key_compare`: `sort -r -k2n` leaves key 2 numeric and ascending, `sort -n -k1,1r` compares the
 * field as text, reversed); what the keys do not take is the last-resort comparison of the whole line, which `-r`
 * reverses. The engine gave them to every key, so the line is rewritten the way GNU reads it: the global letters
 * are taken off the options, appended to each key that has no letters (`-k2` is `-k2n` under `-n`), and a last key
 * `-k1r` stands for the reversed last resort (not under `-s`, `-u` or `-c`, which have none).
 *
 * @param {string[]} args
 * @param {string[]} keys the ordering letters of each `-k`, in order
 * @param {string} global every letter of the global options
 * @param {Record<string, string>} longLetters
 * @returns {string[]}
 */
function inheritGlobal(args, keys, global, longLetters) {
	const ORDER = 'bdfghiMnRrV';
	const g = [...new Set(global.split('').filter((c) => ORDER.includes(c)))].join('');
	if (!keys.length || g === '') { return args; }
	const stop = args.indexOf('--');
	const opts = stop < 0 ? args : args.slice(0, stop);
	const tail = stop < 0 ? [] : args.slice(stop);
	const out = [];
	let nth = 0;
	let noLastResort = false;
	for (let i = 0; i < opts.length; i++) {
		const a = opts[i];
		if (a === '-t' || a === '-o') { out.push(a, opts[++i]); continue; }
		if (a === '-k') {
			const spec = String(opts[i + 1]);
			const comma = spec.indexOf(',');
			// (g, i and R are the letters the engine does not have: a key with only those is read as it always was, with the
			// global ordering, rather than as plain text)
			const own = keys[nth++].replace(/[giR]/g, '');
			out.push('-k', own !== '' ? spec : comma < 0 ? spec + g : spec.slice(0, comma) + g + spec.slice(comma) + (g.includes('b') ? 'b' : ''));
			i++;
			continue;
		}
		if (Object.prototype.hasOwnProperty.call(longLetters, a)) { continue; }
		if (a === '--stable' || a === '--unique') { noLastResort = true; }
		if (/^-[A-Za-z]+$/.test(a)) {
			if (/[su]/.test(a)) { noLastResort = true; }
			const rest = a.slice(1).split('').filter((c) => !ORDER.includes(c)).join('');
			if (rest !== '') { out.push('-' + rest); }
			continue;
		}
		out.push(a);
	}
	if (g.includes('r') && !noLastResort) { out.push('-k', '1r'); }
	return [...out, ...tail];
}

const COUNT_SUFFIX = { b: 512, kB: 1000, KB: 1000, K: 1024, k: 1024, MB: 1000 ** 2, M: 1024 ** 2, m: 1024 ** 2, GB: 1000 ** 3, G: 1024 ** 3, g: 1024 ** 3, TB: 1000 ** 4, T: 1024 ** 4, t: 1024 ** 4 };

/**
 * head and tail: `--lines=N`, `--lines N`, `--bytes=N`, `--bytes N` as `-n N` and `-c N`. The engine takes the long form
 * only joined with `=` and reads `--lines=+4` as "the last 4 lines" (`-n +4`, the same count, is "from line 4 on").
 *
 * @param {string[]} args
 * @returns {string[]}
 */
function shortCounts(args) {
	const out = [];
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (a === '--') { out.push(...args.slice(i)); break; }
		const m = /^--(lines|bytes)(?:=(.*))?$/s.exec(a);
		if (!m) { out.push(a); continue; }
		const flag = m[1] === 'lines' ? '-n' : '-c';
		if (m[2] !== undefined) { out.push(flag, m[2]); } else if (i + 1 < args.length) { out.push(flag, args[++i]); } else { out.push(a); }
	}
	return out;
}

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
	// standard input as an operand is read here too: the engine's head reads a file named `-`
	if (!negative && !zero && !files.includes('-')) { return null; }
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

/**
 * One number as C's printf writes it for `%[flags][width][.precision](e|E|f|F|g|G)`.
 *
 * @param {{ flags: string, width: number, precision: number | null, type: string }} spec
 * @param {number} v
 */
function fixedHalfEven(x, p) {
	// printf rounds an exact tie to the even digit; toFixed takes the larger one
	if (p > 70) { return x.toFixed(p); }
	const t = x.toFixed(p + 30);
	const dot = t.indexOf('.');
	const rest = t.slice(dot + 1 + p);
	if (!/^50*$/.test(rest)) { return x.toFixed(p); }
	const kept = t.slice(0, dot + 1 + p).replace(/\.$/, '');
	const last = kept.replace('.', '').slice(-1);
	return Number(last) % 2 === 0 ? kept : x.toFixed(p);
}

function formatFloat(spec, v) {
	const { flags, width, type } = spec;
	const upper = type === type.toUpperCase();
	let precision = spec.precision;
	let body;
	const negative = v < 0 || Object.is(v, -0);
	const x = Math.abs(v);
	const exp = (n, p) => {
		const t = n.toExponential(p);
		return t.replace(/e([+-])(\d)$/, 'e$10$2');
	};
	if (!Number.isFinite(x)) {
		body = Number.isNaN(x) ? 'nan' : 'inf';
	} else if (type === 'f' || type === 'F') {
		body = fixedHalfEven(x, precision === null ? 6 : precision);
		if (flags.includes('#') && !body.includes('.')) { body += '.'; }
	} else if (type === 'e' || type === 'E') {
		body = exp(x, precision === null ? 6 : precision);
		if (flags.includes('#') && !/\./.test(body)) { body = body.replace('e', '.e'); }
	} else {
		// %g: the shorter of %e and %f at P significant digits, without the trailing zeros (unless #)
		if (precision === null) { precision = 6; }
		if (precision === 0) { precision = 1; }
		const e = x === 0 ? 0 : Number(exp(x, precision - 1).split('e')[1]);
		if (e < -4 || e >= precision) {
			body = exp(x, precision - 1);
			if (!flags.includes('#')) { body = body.replace(/\.?0+e/, 'e'); }
		} else {
			body = fixedHalfEven(x, Math.max(0, precision - 1 - e));
			if (!flags.includes('#') && body.includes('.')) { body = body.replace(/\.?0+$/, ''); }
		}
	}
	if (upper) { body = body.toUpperCase(); }
	let sign = negative ? '-' : flags.includes('+') ? '+' : flags.includes(' ') ? ' ' : '';
	if (Number.isNaN(x)) { sign = flags.includes('+') ? '+' : flags.includes(' ') ? ' ' : ''; }
	let out = sign + body;
	if (out.length < width) {
		if (flags.includes('-')) { out = out.padEnd(width, ' '); } else if (flags.includes('0') && Number.isFinite(x)) { out = sign + body.padStart(width - sign.length, '0'); } else { out = out.padStart(width, ' '); }
	}
	return out;
}

/**
 * `seq -f FORMAT` (the engine's seq has no -f): the numbers, one for each step of FIRST, INCREMENT, LAST, written with a
 * printf format that holds exactly one of `e E f F g G`; `-s SEP` between them and a newline at the end.
 *
 * @param {string[]} args
 * @returns {{ stdout: string, stderr: string, exitCode: number } | null} null when the line has no -f (the engine's)
 */
function seqFormatted(args) {
	let format = null;
	let separator = '\n';
	let equal = false;
	const numbers = [];
	// only a wrong line (no number, one too many, a word for a number) is followed by the hint; a bad format is said alone
	const fail = (m, usage = false) => ({ stdout: '', stderr: `seq: ${m}\n${usage ? "Try 'seq --help' for more information.\n" : ''}`, exitCode: 1 });
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (a === '--') { numbers.push(...args.slice(i + 1)); break; }
		if (a === '-f' || a === '--format') { if (i + 1 >= args.length) { return null; } format = args[++i]; continue; }
		if (a.startsWith('--format=')) { format = a.slice(9); continue; }
		if (/^-f.+/.test(a) && !a.startsWith('--')) { format = a.slice(2); continue; }
		if (a === '-s' || a === '--separator') { separator = args[++i] === undefined ? separator : args[i]; continue; }
		if (a.startsWith('--separator=')) { separator = a.slice(12); continue; }
		if (/^-s.+/.test(a) && !a.startsWith('--')) { separator = a.slice(2); continue; }
		if (a === '-w' || a === '--equal-width') { equal = true; continue; }
		// a number that starts with a minus is a number, not an option
		if (/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(a)) { numbers.push(a); continue; }
		if (a.startsWith('-') && a !== '-') { return null; }
		numbers.push(a);
	}
	if (format === null) { return null; }
	if (numbers.length < 1) { return fail('missing operand', true); }
	if (numbers.length > 3) { return fail(`extra operand '${numbers[3]}'`, true); }
	if (equal) { return fail('format string may not be specified when printing equal width strings', true); }
	const parsed = numbers.map((t) => (/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(t.trim()) ? Number(t) : NaN));
	const badAt = parsed.findIndex((n) => Number.isNaN(n));
	if (badAt >= 0) { return fail(`invalid floating point argument: '${numbers[badAt]}'`, true); }
	const [first, step, last] = numbers.length === 1 ? [1, 1, parsed[0]] : numbers.length === 2 ? [parsed[0], 1, parsed[1]] : parsed;
	if (step === 0) { return fail(`invalid Zero increment value: '${numbers[1]}'`, true); }
	// the format: one conversion, `%%` for a percent
	const re = /%([-+ #0']*)(\d*)(?:\.(\d*))?L?([^]?)/g;
	let m;
	let spec = null;
	let at = 0;
	let literal = '';
	const pieces = [];
	while ((m = re.exec(format)) !== null) {
		if (m[0] === '%%') { literal += format.slice(at, m.index) + '%'; at = m.index + 2; continue; }
		if (m[4] === '') { return fail(`format '${format}' ends in %`); }
		if (spec) { return fail(`format '${format}' has too many % directives`); }
		if (!'eEfFgG'.includes(m[4]) && m[4] !== 'a' && m[4] !== 'A') { return fail(`format '${format}' has unknown %${m[4]} directive`); }
		spec = { flags: m[1], width: m[2] ? Number(m[2]) : 0, precision: m[3] === undefined ? null : Number(m[3] || 0), type: m[4] };
		pieces.push(literal + format.slice(at, m.index));
		literal = '';
		at = m.index + m[0].length;
	}
	pieces.push(literal + format.slice(at));
	if (!spec) { return fail(`format '${format}' has no % directive`); }
	const [pre, post] = [pieces[0], pieces[1] === undefined ? '' : pieces[1]];
	const out = [];
	for (let i = 0; step > 0 ? first + i * step <= last : first + i * step >= last; i++) {
		out.push(pre + formatFloat(spec, first + i * step) + post);
		if (out.length > 100000) { return fail('too many numbers', false); }
	}
	return { stdout: out.length ? out.join(separator) + '\n' : '', stderr: '', exitCode: 0 };
}

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
 * The options of ls the engine does not have and that only change which entries are listed or in what order: -I and
 * --ignore, --hide (not with -a or -A), -w and --width (no effect on one name a line), --sort=WORD, -X, -v, -U and
 * -n. What is left is the engine's own arguments.
 *
 * @param {string[]} args
 * @returns {{ error: string } | { args: string[], ignore: string[], hide: string[], all: boolean, sort: 'extension' | 'version' | null, numeric: boolean, reverse: boolean, active: boolean }}
 */
function lsOptions(args) {
	const out = [];
	const ignore = [];
	const hide = [];
	let all = false;
	/** @type {'extension' | 'version' | null} */
	let sort = null;
	let numeric = false;
	let reverse = false;
	let afterDashes = false;
	const SORTS = ['none', 'time', 'size', 'extension', 'version'];
	const useSort = (w) => {
		if (w === 'size') { out.push('-S'); sort = null; } else if (w === 'time') { out.push('-t'); sort = null; } else if (w === 'none') { sort = null; } else if (w === 'extension' || w === 'version') { sort = w; }
	};
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (afterDashes || a === '-' || !a.startsWith('-')) { out.push(a); continue; }
		if (a === '--') { afterDashes = true; out.push(a); continue; }
		if (a.startsWith('--')) {
			const eq = a.indexOf('=');
			const name = eq < 0 ? a : a.slice(0, eq);
			const value = () => (eq >= 0 ? a.slice(eq + 1) : args[++i]);
			if (name === '--ignore') { ignore.push(String(value())); continue; }
			if (name === '--hide') { hide.push(String(value())); continue; }
			if (name === '--width') { value(); continue; }
			if (name === '--sort') {
				const w = String(value());
				if (!SORTS.includes(w)) {
					return { error: `ls: invalid argument '${w}' for '--sort'\nValid arguments are:\n${SORTS.map((x) => `  - '${x}'`).join('\n')}\nTry 'ls --help' for more information.\n` };
				}
				useSort(w);
				continue;
			}
			if (name === '--all' || name === '--almost-all') { all = true; }
			if (name === '--reverse') { reverse = true; }
			if (name === '--numeric-uid-gid') { numeric = true; out.push('-l'); continue; }
			out.push(a);
			continue;
		}
		// a cluster: -I and -w take the rest or the next argument; -X -v -U -n are taken out
		let kept = '-';
		for (let c = 1; c < a.length; c++) {
			const ch = a[c];
			if (ch === 'I' || ch === 'w' || ch === 'T') {
				const rest = a.slice(c + 1);
				const value = rest !== '' ? rest : args[++i];
				if (ch === 'I') { ignore.push(String(value)); }
				if (ch === 'T') { kept += 'T'; if (rest === '') { out.push('-' + kept.slice(1), String(value)); kept = '-'; break; } }
				break;
			}
			if (ch === 'a' || ch === 'A') { all = true; }
			if (ch === 'r') { reverse = true; }
			if (ch === 'X') { sort = 'extension'; continue; }
			if (ch === 'v') { sort = 'version'; continue; }
			if (ch === 'U') { sort = null; continue; }
			if (ch === 'n') { numeric = true; kept += 'l'; continue; }
			kept += ch;
		}
		if (kept !== '-') { out.push(kept); }
	}
	const active = ignore.length > 0 || hide.length > 0 || sort !== null || numeric;
	return { args: out, ignore, hide, all, sort, numeric, reverse, active };
}

/** The glob of an ls pattern (fnmatch) as a regular expression: `*`, `?` and a set. */
function lsGlob(glob) {
	let re = '^';
	for (let i = 0; i < glob.length; i++) {
		const c = glob[i];
		if (c === '*') { re += '.*'; } else if (c === '?') { re += '.'; } else if (c === '[' && glob.indexOf(']', i + 2) > 0) {
			const close = glob.indexOf(']', i + 2);
			re += '[' + glob.slice(i + 1, close).replace(/^!/, '^').replace(/\\/g, '\\\\') + ']';
			i = close;
		} else { re += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
	}
	return new RegExp(re + '$');
}

/**
 * The listing the engine made, with what -I, --ignore and --hide hide taken out, and a plain listing of one folder
 * ordered by extension or version when that was asked for; -n shows 1000 for the owner and the group.
 *
 * @param {string} text
 * @param {{ ignore: string[], hide: string[], all: boolean, sort: 'extension' | 'version' | null, numeric: boolean, reverse: boolean }} o
 */
function lsRefine(text, o) {
	const patterns = [...o.ignore, ...(o.all ? [] : o.hide)].map(lsGlob);
	const lines = text.split('\n');
	const trailingNewline = lines[lines.length - 1] === '';
	if (trailingNewline) { lines.pop(); }
	const longRow = /^([-dl][-rwxsStT]{9} +\d+ +)(\S+)( +)(\S+)( +\d+ +\S+ +\S+ +\S+ )(.*)$/;
	const nameOf = (l) => {
		const m = longRow.exec(l);
		return m ? m[6] : l;
	};
	/** a name (a row of -l, or a bare name), not the `total` line, a blank line or the `DIR:` header of -R */
	const isEntry = (l) => longRow.test(l) || (l !== '' && !/^total \d+$/.test(l) && !/:$/.test(l));
	const keep = lines.filter((l) => !isEntry(l) || !patterns.some((re) => re.test(nameOf(l).replace(/[*\/@=|]$/, ''))));
	let out = keep;
	if (o.sort) {
		const entries = keep.filter(isEntry);
		const rest = keep.filter((l) => !isEntry(l));
		if (rest.every((l) => /^total \d+$/.test(l))) {
			const key = (l) => nameOf(l);
			const ext = (nm) => { const at = nm.lastIndexOf('.'); return at < 0 ? '' : nm.slice(at); };
			const cmp = o.sort === 'extension'
				? (x, y) => { const ex = ext(key(x)); const ey = ext(key(y)); return ex < ey ? -1 : ex > ey ? 1 : (key(x) < key(y) ? -1 : key(x) > key(y) ? 1 : 0); }
				: (x, y) => versionCompare(key(x), key(y));
			entries.sort(cmp);
			out = [...rest, ...(o.reverse ? entries.reverse() : entries)];
		}
	}
	if (o.numeric) { out = out.map((l) => l.replace(longRow, (_m, a, _u, s1, _g, b, name) => `${a}1000${s1}1000${b}${name}`)); }
	return out.join('\n') + (trailingNewline && out.length ? '\n' : '');
}

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

/**
 * The bytes of what a command is given on standard input: a byte string (one character per byte), or, when something
 * handed over text (a character above U+00FF), that text's UTF-8.
 * @param {string | undefined} s
 * @returns {Uint8Array}
 */
function stdinBytes(s) {
	if (!s) { return new Uint8Array(0); }
	const out = new Uint8Array(s.length);
	for (let i = 0; i < s.length; i++) {
		const c = s.charCodeAt(i);
		if (c > 255) { return encodeText(s); }
		out[i] = c;
	}
	return out;
}

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
 * `cp -v` and `mv -v` name what they did as GNU names it: a source as it was typed, and where it went as the
 * destination was typed with the source's own name after it (`'d/sub' -> './sub'`, `'d/' -> 'ws/a b/d'`, `'emp' ->
 * 'x//'`), and what is below a folder after that. The engine names the resolved path, with slashes of its own.
 *
 * @param {string} stdout the lines of the engine
 * @param {string[]} sources the source operands, as typed
 * @param {string} dest the destination operand, as typed
 * @param {boolean} intoFolder the destination was a folder before the command ran (a source goes INTO it)
 * @returns {string}
 */
function verboseAsTyped(stdout, sources, dest, intoFolder) {
	const strip = (p) => p.replace(/\/+$/, '') || '/';
	const top = sources.map((s) => (intoFolder ? `${strip(dest)}/${strip(s).slice(strip(s).lastIndexOf('/') + 1)}` : dest));
	return stdout.split('\n').map((line) => {
		const m = /^(renamed )?'(.*)' -> '(.*)'$/.exec(line);
		if (!m) { return line; }
		let best = -1;
		for (let k = 0; k < sources.length; k++) {
			const s = sources[k];
			if ((m[2] === s || m[2].startsWith(strip(s) + '/')) && (best < 0 || strip(s).length > strip(sources[best]).length)) { best = k; }
		}
		if (best < 0) { return line; }
		const rel = m[2] === sources[best] ? '' : m[2].slice(strip(sources[best]).length + 1);
		return `${m[1] || ''}'${m[2]}' -> '${rel ? strip(top[best]) + '/' + rel : top[best]}'`;
	}).join('\n');
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
 * `basename` and `dirname` of coreutils for the command lines that are plain: operands, `--`, `-a`/`--multiple`,
 * `-s SUFFIX`/`--suffix=SUFFIX`, `-z`/`--zero`. Returns null for anything else (the engine answers: its words for an
 * option or a count of operands this does not take).
 *
 * @param {'basename' | 'dirname'} program
 * @param {string[]} args
 * @returns {{ stdout: string, stderr: string, exitCode: number } | null}
 */
function nameCommand(program, args) {
	let multiple = false;
	let zero = false;
	let suffix = '';
	/** @type {string[]} */
	const operands = [];
	let ended = false;
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (ended || a === '-' || !a.startsWith('-')) { operands.push(a); continue; }
		if (a === '--') { ended = true; continue; }
		if (a === '-z' || a === '--zero') { zero = true; continue; }
		if (program === 'basename') {
			if (a === '-a' || a === '--multiple') { multiple = true; continue; }
			if (a === '-s' || a === '--suffix') { if (i + 1 >= args.length) { return null; } suffix = args[++i]; multiple = true; continue; }
			if (a.startsWith('--suffix=')) { suffix = a.slice(9); multiple = true; continue; }
		}
		return null;
	}
	if (operands.length === 0) { return null; }
	if (program === 'basename' && !multiple && operands.length > 2) { return null; }
	const base = (s, suf) => {
		if (s === '') { return ''; }
		const t = s.replace(/\/+$/, '');
		if (t === '') { return '/'; }
		const name = t.slice(t.lastIndexOf('/') + 1);
		return suf !== '' && name !== suf && name.endsWith(suf) ? name.slice(0, name.length - suf.length) : name;
	};
	const dir = (s) => {
		if (s === '') { return '.'; }
		const t = s.replace(/\/+$/, '');
		if (t === '') { return '/'; }
		const at = t.lastIndexOf('/');
		if (at < 0) { return '.'; }
		const d = t.slice(0, at).replace(/\/+$/, '');
		return d === '' ? '/' : d;
	};
	let list;
	if (program === 'dirname') { list = operands.map(dir); } else if (multiple) { list = operands.map((o) => base(o, suffix)); } else { list = [base(operands[0], operands.length === 2 ? operands[1] : '')]; }
	return { stdout: list.map((x) => x + (zero ? '\0' : '\n')).join(''), stderr: '', exitCode: 0 };
}

/**
 * @param {(name: string, execute: (args: string[], ctx: any) => Promise<any>) => any} defineCommand
 * @param {new (message: string, type: string) => Error} [LimitError] the engine's own limit error (what its find and
 *   grep -r throw when a traversal is too big, which ends the script and is a `limit`); without it a plain Error
 * @returns {any[]} custom commands, to hand to `new Bash({ customCommands })`
 */
function commands(defineCommand, LimitError) {
	const missingOriginal = (name) => ({ stdout: '', stderr: `${name}: internal error: the original program is not available\n`, exitCode: 1 });
	/** a program that has options with a value answers a missing one itself, in GNU's words, before it does anything */
	const define = (name, run) => defineCommand(name, OPTION_VALUES[name] || DASHDASH.has(name) || STDIN_ALWAYS.has(name) || STDIN_ONCE.has(name) ? async (args, ctx) => {
		const missing = OPTION_VALUES[name] && missingOptionValue(name, args);
		if (missing) { return missing; }
		if (DASHDASH.has(name) && args.includes('--')) { args = endOptions(name, args); }
		if (CLUSTERED.has(name)) { args = splitClusters(name, args); }
		if (args.includes('-') && (STDIN_ALWAYS.has(name) || STDIN_ONCE.has(name))) {
			const at = dashOperands(name, args);
			if (at.length >= (STDIN_ALWAYS.has(name) ? 1 : 2)) { return viaStdinFile(name, args, at, ctx, run); }
		}
		return run(args, ctx);
	} : run);
	/**
	 * Runs `run` with the first `-` operand replaced by a file that holds standard input and every later one by an empty
	 * file (the input is at its end), then puts GNU's name for standard input where the program wrote the file's.
	 */
	const viaStdinFile = async (name, args, at, ctx, run) => {
		const first = `/tmp/.lc-stdin-${++zeroSeq}`;
		const eof = `${first}-eof`;
		await ctx.fs.writeFile(first, stdinBytes(ctx.stdin));
		await ctx.fs.writeFile(eof, new Uint8Array(0));
		const argv = args.slice();
		at.forEach((k, n) => { argv[k] = n === 0 ? first : eof; });
		try {
			const r = await run(argv, ctx);
			const shown = STDIN_NAME[name] || '-';
			const fix = (x) => (typeof x === 'string' && x.includes(first) ? x.split(eof).join(shown).split(first).join(shown) : x);
			return Object.assign({}, r, { stdout: fix(r.stdout), stderr: fix(r.stderr) });
		} finally {
			for (const t of [first, eof]) { try { await ctx.fs.rm(t, { force: true }); } catch { /* under /tmp */ } }
		}
	};
	/** a built-in with its arguments normalised */
	const wrap = (name, fix) => define(name, async (args, ctx) => (ctx.origCommand ? ctx.origCommand(fix(args)) : missingOriginal(name)));
	const readBytes = (ctx) => async (p) => ctx.fs.readFileBuffer(ctx.fs.resolvePath(ctx.cwd, p));
	const abs = (ctx, p) => ctx.fs.resolvePath(ctx.cwd, p);
	const baseName = (p) => p.slice(p.lastIndexOf('/') + 1);
	const dirName = (p) => p.slice(0, p.lastIndexOf('/')) || '/';
	const statOrNull = async (ctx, p) => { try { return await ctx.fs.stat(p); } catch { return null; } };
	/**
	 * The stat of a path as a file system reaches it: each name as it was typed, and `..` from the folder that was reached.
	 * `x/../d` is not `d` when there is no `x` (the engine, like a shell's own path arithmetic, takes it for `d`).
	 * @param {any} ctx
	 * @param {string} typed
	 */
	const typedStat = async (ctx, typed) => {
		if (!typed.includes('..')) { return statOrNull(ctx, ctx.fs.resolvePath(ctx.cwd, typed)); }
		let cur = typed.startsWith('/') ? '/' : ctx.cwd;
		let st = await statOrNull(ctx, cur);
		for (const seg of typed.split('/')) {
			if (seg === '' || seg === '.') { continue; }
			if (!st || !st.isDirectory) { return null; }
			cur = ctx.fs.resolvePath(cur, seg);
			st = await statOrNull(ctx, cur);
		}
		return st;
	};
	/**
	 * Can the folder a name is in be reached as it is typed? (`x/../d` is not in `.` when `x` is not there.) A name with no
	 * `..` is its normal path's own.
	 * @param {any} ctx
	 * @param {string} name
	 */
	const reachable = async (ctx, name) => {
		if (!name.includes('..')) { return true; }
		const plain = name.replace(/\/+$/, '');
		const at = plain.lastIndexOf('/');
		if (at < 0) { return true; }
		const parent = await typedStat(ctx, plain.slice(0, at) || '/');
		return !!parent && parent.isDirectory;
	};
	/**
	 * Why a name cannot be looked at, walking it as it is typed: a file on the way is "Not a directory", a name that is
	 * not there "No such file or directory". Null when it can be.
	 * @param {any} ctx
	 * @param {string} typed
	 * @returns {Promise<string | null>}
	 */
	const whyMissing = async (ctx, typed) => {
		let cur = typed.startsWith('/') ? '/' : ctx.cwd;
		let st = await statOrNull(ctx, cur);
		for (const seg of typed.split('/')) {
			if (seg === '' || seg === '.') { continue; }
			if (!st) { return 'No such file or directory'; }
			if (!st.isDirectory) { return 'Not a directory'; }
			cur = ctx.fs.resolvePath(cur, seg);
			st = await statOrNull(ctx, cur);
		}
		return st ? null : 'No such file or directory';
	};

	/**
	 * The operands of a cp or mv line as typed, and whether the destination is a folder NOW (once the command has run it
	 * may be one that the command made): what `verboseAsTyped` needs.
	 * @param {any} ctx
	 * @param {string[]} norm
	 * @param {boolean} noTarget
	 * @returns {Promise<{ sources: string[], dest: string, intoFolder: boolean } | null>} null with -T (the destination is the target itself)
	 */
	async function transferNames(ctx, norm, noTarget) {
		if (noTarget) { return null; }
		const operands = [];
		let afterDashes = false;
		for (const a of norm) {
			if (!afterDashes && a === '--') { afterDashes = true; continue; }
			if (afterDashes || a === '-' || !a.startsWith('-')) { operands.push(a); }
		}
		if (operands.length < 2) { return null; }
		const dest = operands[operands.length - 1];
		const st = await statOrNull(ctx, abs(ctx, dest.replace(/\/+$/, '') || '/'));
		return { sources: operands.slice(0, -1), dest, intoFolder: !!(st && st.isDirectory) };
	}

	/** Does what cp or mv said before it did anything hold an error (the warning about a source named twice does not)? */
	const hasError = (text) => text.split('\n').some((l) => l !== '' && !/^cp: warning: source (file|directory) '.*' specified more than once$/.test(l));

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
	 * @param {boolean} [force] cp -f was given (the normaliser drops it: it matters only to what is said first)
	 * @returns {Promise<{ result: { stdout: string, stderr: string, exitCode: number } | null, args: string[], stderr: string }>}
	 *   `result` when the command is answered here; else the arguments for the engine and what to print before its output
	 */
	async function preflight(ctx, verb, norm, noTarget = false, force = false, explicitTarget = false) {
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
		const recursive = flags.some((f) => f === '--recursive' || /^-[A-Za-z]*[rR]/.test(f));
		const destTyped = norm[at[at.length - 1]];
		const destPlain = destTyped.replace(/\/+$/, '') || '/';
		const destStat = await typedStat(ctx, destPlain);
		// what GNU says about the operands as a whole comes first, and counts them as they were typed (a source that is
		// reported below does not make the command a different one): an operand too many for -T, and a destination
		// that is no folder for several sources
		const refuse = (say) => ({ result: { stdout: '', stderr: say, exitCode: 1 }, args: norm, stderr: '' });
		if (noTarget && at.length > 2) {
			return refuse(`${verb}: extra operand '${norm[at[2]]}'\nTry '${verb} --help' for more information.\n`);
		}
		// -t DIR names a folder, and one that is a file or not there is said before any source is looked at
		if (explicitTarget && !noTarget) {
			if (destStat && !destStat.isDirectory) { return refuse(`${verb}: target '${destTyped}' is not a directory\n`); }
			if (!destStat) { return refuse(`${verb}: failed to access '${destTyped}': ${(await whyMissing(ctx, destPlain)) || 'No such file or directory'}\n`); }
		}
		// a destination that cannot be looked at because a FILE is on the way to it (`g/x`, or `g/` with g a file) is
		// "failed to access" (mv -T: "cannot stat"), and comes before anything about the sources, whether they are there or
		// not. cp -f does not look first: it says "cannot stat" when it gets to the copy
		if (!force) {
			let blocked = !!(destStat && !destStat.isDirectory && destTyped.endsWith('/') && destTyped.length > 1);
			// a file the typed name goes through, up again by `..` (`f/../d`): the name as typed is not there at all
			if (!destStat && !blocked && destPlain.includes('..')) { blocked = (await whyMissing(ctx, destPlain)) === 'Not a directory'; }
			for (let q = dirName(abs(ctx, destPlain)); !destStat && !blocked; q = dirName(q)) {
				const st = await statOrNull(ctx, q);
				if (st) { blocked = !st.isDirectory; break; }
				if (q === '/') { break; }
			}
			if (blocked) { return refuse(`${verb}: ${noTarget && verb === 'mv' ? 'cannot stat' : 'failed to access'} '${destTyped}': Not a directory\n`); }
		}
		if (!noTarget && at.length > 2 && !(destStat && destStat.isDirectory)) {
			return refuse(`${verb}: target '${destTyped}' is not a directory\n`);
		}
		/** a folder to put the sources into (not with -T): where a source goes, as GNU shows it */
		const intoFolder = !noTarget && !!(destStat && destStat.isDirectory);
		// a destination whose path goes up through a folder that is not there (`x/../d`) has nothing to be put in
		const destUnreachable = !destStat && destPlain.includes('..') && !(await typedStat(ctx, destPlain.replace(/\/[^/]*$/, '') || '/'));
		let stderr = '';
		let said = '';
		const dropped = new Set();
		/** the source and where it goes, for each source seen so far that exists (cp: one named again is said, not copied again) */
		const seen = new Set();
		for (const i of at.slice(0, -1)) {
			const src = norm[i];
			const plain = src.replace(/\/+$/, '') || '/';
			const base = baseName(plain);
			const target = intoFolder ? ctx.fs.resolvePath(abs(ctx, destPlain), base) : abs(ctx, destPlain);
			const shown = intoFolder ? `${destTyped.replace(/\/+$/, '') || '/'}/${base}` : destTyped;
			const st = await typedStat(ctx, plain);
			if (!st) {
				// said here, in the order of the operands, with what is said about the others
				stderr += `${verb}: cannot stat '${src}': No such file or directory\n`;
				dropped.add(i);
				continue;
			}
			if (verb === 'cp' && !recursive && st && st.isDirectory) {
				// a folder with no -r is omitted, whatever the destination is
				stderr += `cp: -r not specified; omitting directory '${src}'\n`;
				dropped.add(i);
				continue;
			}
			if (src.length >= 2 && src.endsWith('/') && st && !st.isDirectory) {
				// a file written with a slash: mv -n looks at the destination before the source, and one that is there is
				// a quiet "no"; GNU looks at the source first, so this comes before a destination that cannot be reached
				if (!(verb === 'mv' && noClobber && (await statOrNull(ctx, target)))) { stderr += `${verb}: cannot stat '${src}': Not a directory\n`; }
				dropped.add(i);
				continue;
			}
			if (destUnreachable) {
				// cp -v names the copy before it tries it
				if (verb === 'cp' && verbose && !st.isDirectory) { said += `'${src}' -> '${destTyped}'\n`; }
				stderr += verb === 'cp' ? `cp: cannot create ${st.isDirectory ? 'directory' : 'regular file'} '${destTyped}': No such file or directory\n` : `mv: cannot move '${src}' to '${destTyped}': No such file or directory\n`;
				dropped.add(i);
				continue;
			}
			if (verb === 'mv' && (base === '.' || base === '..')) {
				// a folder cannot be renamed through its `.` or `..`: where it would go is itself, or busy; -n, with a
				// destination that is there, is a quiet no first. A destination that is a file, or whose folder is not
				// there, is what GNU says before "busy"
				const there = await statOrNull(ctx, target);
				if (noClobber && there) { dropped.add(i); continue; }
				if (there && !there.isDirectory && !intoFolder) {
					stderr += `mv: cannot overwrite non-directory '${destTyped}' with directory '${src}'\n`;
				} else if (!there && !(await statOrNull(ctx, dirName(target)))) {
					stderr += `mv: cannot move '${src}' to '${shown}': No such file or directory\n`;
				} else {
					stderr += target === abs(ctx, plain) ? `mv: '${src}' and '${shown}' are the same file\n` : `mv: cannot move '${src}' to '${shown}': Device or resource busy\n`;
				}
				dropped.add(i);
				continue;
			}
			// a source that is an earlier source again (`cp f ./f e`): said once and copied once. For a file the warning
			// takes the place of everything else about it; for a folder "the same file" (below) comes first
			const again = verb === 'cp' && intoFolder && seen.has(abs(ctx, plain) + '\0' + target);
			seen.add(abs(ctx, plain) + '\0' + target);
			if (again && !st.isDirectory) {
				stderr += `cp: warning: source file '${src}' specified more than once\n`;
				dropped.add(i);
				continue;
			}
			// into the folder it is in already: "the same file" (for a folder cp says so only with -r; -n makes it nothing)
			if (intoFolder && st && target === abs(ctx, plain) && (!st.isDirectory || verb === 'mv' || recursive)) {
				if (!noClobber) { stderr += `${verb}: '${src}' and '${shown}' are the same file\n`; }
				dropped.add(i);
				continue;
			}
			if (again) {
				stderr += `cp: warning: source directory '${src}' specified more than once\n`;
				dropped.add(i);
			}
		}
		const left = at.filter((i) => !dropped.has(i));
		if (left.length < 2 && dropped.size) { return { result: { stdout: said, stderr, exitCode: hasError(stderr) ? 1 : 0 }, args: norm, stderr }; }
		/** the arguments for the engine: the sources that were reported are gone, `over` replaces one operand */
		const build = (over) => norm.map((a, k) => (over && k === over.at ? over.text : a)).filter((_a, k) => !dropped.has(k));
		const args = build(null);
		const answer = (say, exitCode = 1, stdout = '') => ({ result: { stdout, stderr: stderr + say, exitCode }, args, stderr });
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
				if (destAbs === abs(ctx, src)) { return noClobber ? answer('', 0) : answer(`${verb}: '${src}' and '${dest}' are the same file\n`); }
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
			say = `${verb}: ${verb === 'cp' && force ? 'cannot stat' : 'failed to access'} '${dest}': Not a directory\n`;
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
	 * in name order (GNU's is the file system's, which nothing fixes). It needs no bound of its own: it walks what the
	 * engine has just copied, which stopped at the traversal limit (a limit of the script, `cp: filesystem traversal
	 * entry limit exceeded`) and at the cap on the entries one command may make.
	 *
	 * @param {any} ctx
	 * @param {string} stdout what the engine printed
	 */
	async function verboseTree(ctx, stdout) {
		const out = [];
		const walk = async (src, dst) => {
			let names;
			try { names = (await ctx.fs.readdir(abs(ctx, src))).slice().sort(); } catch { return; }
			for (const name of names) {
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
	 * The copies and moves that are done one pair of paths at a time, here and not by the engine:
	 *
	 *   * -u (cp and mv): a destination that is a file and is not older is left alone
	 *   * -n with -r (cp): a destination that is there is left alone, and what is missing is made. The engine skips a
	 *     folder that is there as a whole (`cp -rn d/. e` copied nothing into an existing e); GNU merges
	 *
	 * Folders are made when they are not there (an empty one too), files are copied or moved when the destination says
	 * so, and what GNU says about a pair that is the same file, a source that an earlier one took away, a folder onto a
	 * file, a folder into itself, is said as it says it. With -v a line is printed for what was made or copied.
	 *
	 * @param {any} ctx
	 * @param {string} verb 'cp' | 'mv'
	 * @param {string[]} norm the normalised arguments (options, then operands)
	 * @param {boolean} [noTarget] -T: the destination is the target itself, never a folder to go into
	 * @param {{ update?: boolean, noClobber?: boolean }} [mode]
	 */
	async function transferEach(ctx, verb, norm, noTarget = false, mode = {}) {
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
		const fail = (message) => { stderr += message + '\n'; exitCode = 1; };
		if (operands.length < 2) { return { stdout, stderr: `${verb}: missing destination file operand after '${operands[0] || ''}'\n`, exitCode: 1 }; }
		const dest = operands[operands.length - 1];
		const destAbs = abs(ctx, dest);
		const destStat = await statOrNull(ctx, destAbs);
		const srcs = operands.slice(0, -1);
		if (srcs.length > 1 && !(destStat && destStat.isDirectory)) { return { stdout, stderr: `${verb}: target '${dest}' is not a directory\n`, exitCode: 1 }; }
		const room = ctx.limits && ctx.limits.maxTraversalEntries;
		let visited = 0;
		const entry = () => {
			if (typeof room === 'number' && ++visited > room) {
				// the same bound as find, du and grep -r: a tree this big ends the script
				const message = `${verb}: filesystem traversal entry limit exceeded (${room})`;
				throw LimitError ? new LimitError(message, 'iterations') : Object.assign(new Error(message), { name: 'ExecutionLimitError' });
			}
		};
		const join = (shown, name) => shown.replace(/\/+$/, '') + '/' + name;
		/**
		 * one file (for mv: one thing): done unless the destination says no. A source that is its own destination was said
		 * by preflight, and one that an earlier source took away is said by the loop below, which looks at each source as
		 * it comes to it: neither reaches here
		 */
		const one = async (shown, srcAbs, dstAbs, st, shownDst) => {
			const t = await statOrNull(ctx, dstAbs);
			if (t && mode.noClobber) { return; }
			if (t && t.isDirectory && verb === 'cp') { fail(`cp: cannot overwrite directory '${shownDst}' with non-directory`); return; }
			if (t && !t.isDirectory && mode.update && +t.mtime >= +st.mtime) { return; }
			try {
				if (verb === 'cp') { await ctx.fs.cp(srcAbs, dstAbs, { recursive: false }); } else { await ctx.fs.mv(srcAbs, dstAbs); }
				if (verbose) { stdout += verb === 'cp' ? `'${shown}' -> '${shownDst}'\n` : `renamed '${shown}' -> '${shownDst}'\n`; }
			} catch (e) {
				const code = String(e && e.code);
				if (verb === 'mv' && code === 'ENOTDIR') { fail(`mv: cannot overwrite non-directory '${shownDst}' with directory '${shown}'`); } else if (verb === 'mv' && code === 'EISDIR') { fail(`mv: cannot overwrite directory '${shownDst}' with non-directory`); } else if (verb === 'mv' && code === 'ENOTEMPTY') { fail(`mv: cannot move '${shown}' to '${shownDst}': Directory not empty`); } else if (verb === 'mv' && code === 'EINVAL') { fail(`mv: cannot move '${shown}' to a subdirectory of itself, '${shownDst}'`); } else {
					fail(`${verb}: cannot ${verb === 'cp' ? 'create regular file' : 'move'} '${shownDst}': ${/ENOENT/.test(code) ? 'No such file or directory' : String(e.message).replace(/^[A-Z]+: /, '')}`);
				}
			}
		};
		/** a folder (cp -r): made when it is not there, then what is in it */
		const tree = async (srcAbs, dstAbs, shown, shownDst) => {
			entry();                                   // the folder itself is an entry, as it is for find and du
			const there = await statOrNull(ctx, dstAbs);
			if (there && !there.isDirectory) { fail(`cp: cannot overwrite non-directory '${shownDst}' with directory '${shown}'`); return; }
			if (dstAbs === srcAbs || dstAbs.startsWith(srcAbs === '/' ? '/' : srcAbs + '/')) { fail(`cp: cannot copy a directory, '${shown}', into itself, '${shownDst}'`); return; }
			if (!there) {
				try {
					await ctx.fs.mkdir(dstAbs, { recursive: false });
				} catch (e) {
					fail(`cp: cannot create directory '${shownDst}': ${/ENOENT/.test(String(e.code)) ? 'No such file or directory' : String(e.message).replace(/^[A-Z]+: /, '')}`);
					return;
				}
				if (verbose) { stdout += `'${shown}' -> '${shownDst}'\n`; }
			}
			for (const name of await ctx.fs.readdir(srcAbs)) {
				entry();
				const s = ctx.fs.resolvePath(srcAbs, name);
				const st = await ctx.fs.stat(s);
				const d = ctx.fs.resolvePath(dstAbs, name);
				if (st.isDirectory) { await tree(s, d, join(shown, name), join(shownDst, name)); } else { await one(join(shown, name), s, d, st, join(shownDst, name)); }
			}
		};
		const typedDir = dest.replace(/\/+$/, '') || '/';
		for (const src of srcs) {
			const srcAbs = abs(ctx, src);
			const st = await statOrNull(ctx, srcAbs);
			if (!st) { fail(`${verb}: cannot stat '${src}': No such file or directory`); continue; }
			const intoDir = !noTarget && destStat && destStat.isDirectory;
			const base = baseName(src.replace(/\/+$/, '') || '/');
			const target = intoDir ? ctx.fs.resolvePath(destAbs, base) : destAbs;
			const shownDst = intoDir ? typedDir + '/' + base : dest;
			if (st.isDirectory && verb === 'cp') {
				if (!recursive) { fail(`cp: -r not specified; omitting directory '${src}'`); continue; }
				await tree(srcAbs, target, src, shownDst);
				continue;
			}
			await one(src, srcAbs, target, st, shownDst);
		}
		return { stdout, stderr, exitCode };
	}

	/** GNU says `cannot open 'f' for reading` for a file head and tail cannot read; the engine says only what is wrong */
	const cannotOpen = (r, name) => {
		if (!r.stderr || !r.stderr.includes(': No such file or directory')) { return r; }
		const re = new RegExp(`^${name}: (.+): No such file or directory$`, 'gm');
		return Object.assign({}, r, { stderr: r.stderr.replace(re, `${name}: cannot open '$1' for reading: No such file or directory`) });
	};

	/** a name for the copies a NUL-terminated run makes under /tmp (never shown: the names are put back) */
	let zeroSeq = 0;

	/**
	 * `--files0-from=FILE` (wc, du, sort): the names in FILE (`-` is standard input), ended by NUL, are the operands.
	 *
	 * @param {any} ctx
	 * @param {string} program
	 * @param {string[]} args
	 * @returns {Promise<{ args: string[], stderr: string, failed: boolean } | { result: { stdout: string, stderr: string, exitCode: number } }>}
	 */
	async function filesFrom(ctx, program, args) {
		const status = program === 'sort' ? 2 : 1;
		let source = null;
		/** @type {string[]} */
		const rest = [];
		let operands = 0;
		let firstOperand = '';
		for (let i = 0; i < args.length; i++) {
			const a = args[i];
			if (a === '--') {
				for (const o of args.slice(i + 1)) {
					if (!operands++) { firstOperand = o; }
					rest.push(o);
				}
				break;
			}
			if (a === '--files0-from') { source = args[++i]; continue; }
			if (a.startsWith('--files0-from=')) { source = a.slice(14); continue; }
			if (a !== '-' && a.startsWith('-')) {
				rest.push(a);
				// the value of an option that takes one is not an operand
				const t = OPTION_VALUES[program];
				if (t && !a.startsWith('--') && a.length === 2 && t.short.includes(a[1])) { rest.push(args[++i]); }
				continue;
			}
			if (!operands++) { firstOperand = a; }
			rest.push(a);
		}
		if (source === null) { return { args, stderr: '', failed: false }; }
		if (operands) {
			return { result: { stdout: '', stderr: `${program}: extra operand '${firstOperand}'\nfile operands cannot be combined with --files0-from\nTry '${program} --help' for more information.\n`, exitCode: status } };
		}
		let text;
		try {
			text = source === '-' ? decodeByteString(ctx.stdin || '') : decodeBytes(await readBytes(ctx)(source));
		} catch {
			return { result: { stdout: '', stderr: `${program}: cannot open '${source}' for reading: No such file or directory\n`, exitCode: status } };
		}
		const names = text.split('\0');
		if (names.length && names[names.length - 1] === '') { names.pop(); }
		let stderr = '';
		const good = [];
		names.forEach((n, k) => {
			if (n === '') { stderr += `${program}: ${source}:${k + 1}: invalid zero-length file name\n`; } else { good.push(n); }
		});
		return { args: [...rest, ...(rest.includes('--') ? [] : good.length ? ['--'] : []), ...good], stderr, failed: stderr !== '' };
	}

	/**
	 * `-z`, `-Z` and `-s` (zero.js): the program is run by the engine on copies of its input whose records have NUL and
	 * newline exchanged, and what it printed is exchanged back, with the names of the copies put back as typed.
	 *
	 * @param {any} ctx
	 * @param {string} program sort, uniq, cut, tail, paste, comm, join, sed, grep, egrep or fgrep
	 * @param {ReturnType<typeof zero.plan>} p
	 * @returns {Promise<{ stdout: string, stderr: string, exitCode: number }>}
	 */
	/**
	 * Writes a copy under /tmp for a program to read. A write the shell refuses (the 8 MiB cap on what a command holds)
	 * does not throw: it leaves no file, and the program then read a file that was not there and said "No such file" or
	 * found no difference, or wrote an empty output file over the real one. That is an error of its own here.
	 *
	 * @param {any} ctx
	 * @param {string} path
	 * @param {Uint8Array} bytes
	 */
	async function putCopy(ctx, path, bytes) {
		await ctx.fs.writeFile(path, bytes);
		let there = false;
		try { there = await ctx.fs.exists(path); } catch { /* not there */ }
		if (!there) { throw Object.assign(new Error('memory exhausted'), { lcMemory: true }); }
	}

	async function zeroRun(ctx, program, p) {
		const isGrep = program === 'grep' || program === 'egrep' || program === 'fgrep';
		const status = isGrep || program === 'sort' ? 2 : 1;
		const fail = (message) => ({ stdout: '', stderr: `${program}: ${message}\n`, exitCode: status });
		const swap = p.zero;
		const args = p.args.slice();
		const g = isGrep ? grepOperands(args) : null;
		const kind = isGrep ? zero.grepOutputKind(args) : null;
		// what the exchange cannot carry is said, not done wrong
		if (g && (swap || p.nul) && g.recursive && !(p.nul && !swap && kind && (kind.names || kind.count))) {
			return fail(`${swap ? '-z' : '-Z'} cannot be used with -r in this shell${swap ? '' : ', except with -l, -L or -c'}`);
		}
		const readText = async (name) => decodeBytes(await readBytes(ctx)(name));
		/** @type {string[]} */
		const scriptTexts = [];
		if (swap && program === 'sed') {
			for (const i of p.scripts) { scriptTexts.push(args[i]); }
			for (const i of p.scriptFiles) {
				try { scriptTexts.push(await readText(args[i])); } catch { /* the engine says */ }
			}
			for (const t of scriptTexts) {
				const bad = zero.sedZeroRefusal(t);
				if (bad) { return fail(`-z cannot be combined with ${bad} in this shell`); }
			}
		}
		// the input: the files that can be read (a copy of each), and standard input when it is read
		/** @type {Map<number, string>} */
		const texts = new Map();
		if (swap) {
			for (const i of p.files) {
				if (args[i] === '-') { continue; }
				try { texts.set(i, await readText(args[i])); } catch { /* left as typed: the program says why */ }
			}
		}
		const usesStdin = p.files.length === 0 || p.files.some((i) => args[i] === '-');
		const stdinText = usesStdin ? decodeByteString(ctx.stdin || '') : '';
		const x = swap ? zero.pickPlaceholder([...texts.values(), stdinText, ...args, ...scriptTexts]) : '';
		const dir = `/tmp/.lc-zero-${++zeroSeq}`;
		/** @type {Array<{ at: number, tmp: string, name: string }>} */
		const copies = [];
		let outputTmp = null;
		/** where standard output goes when uniq was given an OUTPUT operand */
		let uniqOutput = null;
		try {
			if (swap && (texts.size || p.scriptFiles.length || p.outputAt >= 0)) { await ctx.fs.mkdir(dir, { recursive: true }); }
			if (swap) {
				for (const i of p.scripts) { args[i] = zero.sedScriptIn(args[i], x); }
				for (const i of p.scriptFiles) {
					try {
						const tmp = `${dir}/script-${i}`;
						await putCopy(ctx, tmp, encodeText(zero.sedScriptIn(await readText(args[i]), x)));
						args[i] = tmp;
					} catch (e) { if (e && e.lcMemory) { throw e; } /* the engine says */ }
				}
				// a newline given as the field delimiter is the placeholder
				for (let i = 0; i + 1 < args.length; i++) {
					if (((program === 'cut' && args[i] === '-d') || (program === 'sort' && args[i] === '-t')) && args[i + 1] === '\n') { args[i + 1] = x; }
				}
				for (const [i, text] of texts) {
					const tmp = `${dir}/${copies.length}`;
					await putCopy(ctx, tmp, encodeText(zero.swapIn(text, x)));
					copies.push({ at: i, tmp, name: args[i] });
					args[i] = tmp;
				}
			}
			if (p.outputAt >= 0) {
				outputTmp = `${dir}/out`;
				args[p.outputAt] = outputTmp;
			}
			if (program === 'uniq' && p.files.length > 1) {
				uniqOutput = args[p.files[1]];
				args.splice(p.files[1], 1);
			}
			const stdinFor = swap ? zero.swapIn(stdinText, x) : stdinText;
			const run = (list, stdin = stdinFor) => ctx.exec(shellQuote(program), { cwd: ctx.cwd, signal: ctx.signal, args: list, stdin });
			// context lines come with `--` between the groups, which is also a record that may be there: every record of
			// the output gets its line number (taken off again) so that the separator is known by what it is
			const stripNumbers = isGrep && swap && !!kind && kind.context && !kind.lineNumber && !kind.names && !kind.count && !kind.quiet;
			if (stripNumbers) { args.unshift('-n'); }
			let r;
			if (program === 'tail' && p.files.length > 0 && zero.tailHeaders(args, p.files.length)) {
				// each file is a run of its own, with the header GNU prints: its line ends in a newline, whatever ends a
				// record (the placeholder is turned into one with the rest), and a blank line comes before the second
				r = { stdout: '', stderr: '', exitCode: 0 };
				const skip = new Set(p.files);
				const base = zero.withoutHeaderOptions(args.filter((_a, i) => !skip.has(i)));
				let printed = false;
				let stdinLeft = stdinFor;
				for (const i of p.files) {
					// (standard input is what the engine reads when it is given no file: it knows no `-`)
					const one = await run(args[i] === '-' ? base : [...base, args[i]], args[i] === '-' ? stdinLeft : '');
					if (args[i] === '-') { stdinLeft = ''; }
					r.stderr += one.stderr;
					if (one.exitCode) { r.exitCode = one.exitCode; }
					// a file that cannot be read has no header
					if (one.exitCode && one.stdout === '') { continue; }
					r.stdout += `${printed ? x : ''}==> ${args[i] === '-' ? 'standard input' : copies.find((c) => c.at === i)?.name ?? args[i]} <==${x}${one.stdout}`;
					printed = true;
				}
			} else if (program === 'sed' && p.separate && !p.inPlace && p.files.length > 1) {
				// each file is a run of its own: `$` and the line numbers are the file's
				r = { stdout: '', stderr: '', exitCode: 0 };
				const skip = new Set(p.files);
				const base = args.filter((_a, i) => !skip.has(i));
				for (const i of p.files) {
					const one = await run([...base, args[i]]);
					// a stream that ends without its newline gets one when more follows
					if (r.stdout !== '' && !r.stdout.endsWith('\n') && one.stdout !== '') { r.stdout += '\n'; }
					r.stdout += one.stdout;
					r.stderr += one.stderr;
					if (one.exitCode) { r.exitCode = one.exitCode; }
				}
			} else {
				r = await run(p.inPlace ? args.map((a) => (a === '-i' ? '-i' : a)) : args);
			}
			let stdout = r.stdout;
			let stderr = r.stderr;
			for (const c of copies) {
				stdout = stdout.split(c.tmp).join(c.name);
				stderr = stderr.split(c.tmp).join(c.name);
			}
			const unswapped = (t) => (swap ? zero.swapOut(t, x) : t);
			const typedNames = p.files.map((i) => p.args[i]);
			if (swap) {
				if (isGrep && kind && !kind.names && !kind.count) {
					// the lines of the engine are the records, each with its prefixes, and the separator between groups
					stdout = grepRecords(stdout, x, { names: grepShownNames(typedNames, usesStdin, g), numbers: kind.lineNumber || stripNumbers, keepNumbers: kind.lineNumber, context: kind.context, nul: p.nul });
				} else {
					// names and counts (grep -l, -L, -c) are lines of their own, whatever ends a record
					stdout = isGrep && kind && (kind.names || kind.count) ? stdout.split(x).join('\n') : zero.swapOut(stdout, x);
				}
				stderr = stderr.split(x).join('\n');
				// `sort -c` ends its message about the record that is out of order as it ends a record
				if (program === 'sort') { stderr = stderr.replace(/(: disorder: [^\n]*)\n$/, '$1\0'); }
			}
			if (isGrep && p.nul && g && !(swap && kind && !kind.names && !kind.count)) { stdout = grepNullNames(stdout, typedNames, usesStdin, g, kind); }
			// the files the engine changed are written back with the records as they were
			if (p.inPlace && r.exitCode <= 1) {
				for (const c of copies) {
					const changed = await readText(c.tmp).catch(() => null);
					if (changed === null) { continue; }
					const original = texts.get(c.at);
					if (p.suffix && original !== undefined) {
						const real = abs(ctx, c.name);
						const name = p.suffix.includes('*') ? p.suffix.replace(/\*/g, baseName(real)) : baseName(real) + p.suffix;
						try { await ctx.fs.writeFile(name.startsWith('/') ? name : ctx.fs.resolvePath(dirName(real), name), encodeText(original)); } catch { /* the original is what mattered */ }
					}
					await ctx.fs.writeFile(abs(ctx, c.name), encodeText(unswapped(changed)));
				}
			}
			if (outputTmp !== null && r.exitCode === 0) {
				// the engine always makes its output file: one that is not there is a write the cap refused, and the real
				// file is left alone (an empty one was written over it)
				const out = await readText(outputTmp).catch(() => null);
				if (out === null) { return fail('memory exhausted'); }
				const real = p.args[p.outputAt];
				try {
					await ctx.fs.writeFile(abs(ctx, real), encodeText(unswapped(out)));
				} catch (e) {
					const why = { ENOENT: 'No such file or directory', EISDIR: 'Is a directory', ENOTDIR: 'Not a directory', EACCES: 'Permission denied', EPERM: 'Operation not permitted' }[String(e && e.code)];
					return { stdout: '', stderr: `sort: open failed: ${real}: ${why || 'cannot write'}\n`, exitCode: 2 };
				}
			}
			if (uniqOutput !== null && r.exitCode === 0) {
				try {
					await ctx.fs.writeFile(abs(ctx, uniqOutput), encodeText(stdout));
				} catch (e) {
					return { stdout: '', stderr: `uniq: ${uniqOutput}: ${String(e && e.code) === 'ENOENT' ? 'No such file or directory' : 'cannot write'}\n`, exitCode: 1 };
				}
				stdout = '';
			}
			return { stdout, stderr, exitCode: r.exitCode };
		} catch (e) {
			if (e && e.lcMemory) { return fail('memory exhausted'); }
			throw e;
		} finally {
			try { await ctx.fs.rm(dir, { recursive: true, force: true }); } catch { /* it is under /tmp, which is emptied */ }
		}
	}

	/**
	 * The names a grep line may put in front of a record, longest first: the files as typed, and `(standard input)`; none
	 * when the output has no names (one input, no -H, not recursive, or -h).
	 *
	 * @param {string[]} names the operands as they were typed
	 * @param {boolean} fromStdin
	 * @param {ReturnType<typeof grepOperands> | null} g
	 * @returns {string[]}
	 */
	function grepShownNames(names, fromStdin, g) {
		if (!g) { return []; }
		const shown = (names.filter((n) => n !== '-').length + (fromStdin ? 1 : 0) > 1 || g.withName || g.recursive) && !g.noName;
		if (!shown) { return []; }
		return names.filter((n) => n !== '-').concat(fromStdin ? ['(standard input)'] : []).sort((a, b) => b.length - a.length);
	}

	/**
	 * What a grep that read records ended by NUL printed, made GNU's: each line of the engine is one record (its newlines
	 * are `x`) with the prefixes the engine put on it (`NAME:`, `NAME-`, `N:`, `N-`), a record ends in NUL, the line `--`
	 * between groups of context is a newline-ended line (as GNU's `--\n`), and with -Z the name is ended by NUL where the
	 * engine had `:` or `-`.
	 *
	 * @param {string} out what the engine printed
	 * @param {string} x the character the real newlines were given as
	 * @param {{ names: string[], numbers: boolean, keepNumbers: boolean, context: boolean, nul: boolean }} o
	 */
	function grepRecords(out, x, o) {
		if (!out) { return out; }
		const lines = out.split('\n');
		if (lines[lines.length - 1] === '') { lines.pop(); }
		let text = '';
		for (const l of lines) {
			if (o.context && l === '--') { text += '--\n'; continue; }
			let rest = l;
			let name = '';
			let sep = '';
			for (const n of o.names) {
				if (rest.startsWith(n) && (rest[n.length] === ':' || rest[n.length] === '-')) { name = n; sep = rest[n.length]; rest = rest.slice(n.length + 1); break; }
			}
			let number = '';
			if (o.numbers) {
				const m = /^\d+[:-]/.exec(rest);
				if (m) { if (o.keepNumbers) { number = m[0]; } rest = rest.slice(m[0].length); }
			}
			text += (name === '' ? '' : name + (o.nul ? '\0' : sep)) + number + rest.split(x).join('\n') + '\0';
		}
		return text;
	}

	/**
	 * `grep -Z` of what is not a record: a name listed by -l or -L ends in NUL where it ended in a newline, `name:count` of
	 * -c is `name\0count`, and the name that starts a line is ended by NUL where it was ended by `:` or `-`.
	 *
	 * @param {string} out what the engine printed (lines)
	 * @param {string[]} names the operands as they were typed
	 * @param {boolean} fromStdin
	 * @param {ReturnType<typeof grepOperands>} g
	 * @param {{ names: boolean, count: boolean, quiet: boolean } | null} kind
	 */
	function grepNullNames(out, names, fromStdin, g, kind) {
		if (!out) { return out; }
		if (kind && kind.names) { return out.split('\n').map((l, i, all) => (i === all.length - 1 && l === '' ? '' : l + '\0')).join(''); }
		const known = grepShownNames(names, fromStdin, g);
		if (!known.length) { return out; }
		return out.split('\n').map((l) => {
			if (l === '' || l === '--') { return l; }
			if (kind && kind.count) { return l.replace(/^(.*):(\d+)$/, '$1\0$2'); }
			for (const n of known) {
				if (l.startsWith(n + ':') || l.startsWith(n + '-')) { return n + '\0' + l.slice(n.length + 1); }
			}
			return l;
		}).join('\n');
	}

	return [
		define('xargs', async (args, ctx) => {
			if (!ctx.origCommand) { return missingOriginal('xargs'); }
			// what -s may be at most, as GNU works it out: ARG_MAX less the environment and 2048 bytes of headroom
			const exported = ctx.exportedEnv instanceof Map ? [...ctx.exportedEnv.entries()] : Object.entries(ctx.exportedEnv || {});
			const upperLimit = Math.max(4096, XARGS_UPPER_LIMIT - exported.reduce((n, [k, v]) => n + utf8Length(k) + utf8Length(String(v)) + 2, 0));
			const parsed = ctx.exec ? parseXargs(args, upperLimit) : null;
			if (parsed && 'error' in parsed) { return { stdout: '', stderr: parsed.error, exitCode: 1 }; }
			if (parsed) {
				// GNU's xargs, run here: the engine's splits on every blank and has no -L, -E, -a (see parseXargs)
				const { opts, command, warnings } = parsed;
				// what a pipe hands over is bytes, one character each: the items are text (a name with an `é` is a name)
				let input = decodeByteString(ctx.stdin || '');
				if (opts.argFile !== null) {
					try { input = decodeBytes(await readBytes(ctx)(opts.argFile)); } catch { return { stdout: '', stderr: `xargs: Cannot open input file '${opts.argFile}': No such file or directory\n`, exitCode: 1 }; }
				}
				const maxIterations = ctx.limits && ctx.limits.maxLoopIterations;
				const limitError = (message) => (LimitError ? new LimitError(message, 'iterations') : Object.assign(new Error(message), { name: 'ExecutionLimitError' }));
				const read = xargsInput(input, opts);
				const base = command.length ? command : ['echo'];
				// the commands, in GNU's order and by GNU's measure (-s, default 128 KiB): a long list is many runs, and a
				// command line never nears the parser's own cap. The shell's own cap on the arguments of one command bounds
				// a batch as well (only a -s above 200000 can reach it)
				const size = { chars: opts.maxChars !== null ? opts.maxChars : Math.min(XARGS_DEFAULT_CHARS, upperLimit), items: ctx.limits && typeof ctx.limits.maxArrayElements === 'number' ? ctx.limits.maxArrayElements : Infinity };
				const plan = xargsPlan(read.lines, opts, base, size, read.error);
				const runs = plan.reduce((n, e) => n + ('argv' in e ? 1 : 0), 0);
				if (typeof maxIterations === 'number' && runs > maxIterations) { throw limitError(`xargs: iteration limit exceeded (${maxIterations})`); }
				let stdout = '';
				let stderr = warnings.join('') + (read.nul ? 'xargs: WARNING: a NUL character occurred in the input.  It cannot be passed through in the argument list.  Did you mean to use the --null option?\n' : '');
				let failed = false;
				let stoppedReading = false;
				let status = 0;
				for (const ev of plan) {
					if ('error' in ev) {
						stderr += ev.error;
						if (ev.fatal) { return { stdout, stderr, exitCode: 1 }; }
						stoppedReading = true;
						continue;
					}
					const argv = ev.argv.map((w) => (w.includes('\0') ? w.slice(0, w.indexOf('\0')) : w));
					// nobody can answer: GNU, with no terminal to ask, fails closed and runs nothing
					if (opts.prompt) { return { stdout, stderr: stderr + argv.map(xargsQuote).join(' ') + 'xargs: failed to open /dev/tty for reading: No such device or address\n', exitCode: 1 }; }
					if (opts.openTty) { return { stdout, stderr: stderr + "xargs: '/dev/tty': No such device or address\n", exitCode: 125 }; }
					if (opts.verbose) { stderr += argv.map(xargsQuote).join(' ') + '\n'; }
					// a builtin that is no program: GNU's xargs execs it and says so
					if (NOT_PROGRAMS.has(argv[0])) {
						stderr += `xargs: ${argv[0]}: No such file or directory\n`;
						status = 127;
						break;
					}
					// the arguments are handed over as they are (the engine's `args`), never through the parser: no quoting, and
					// no cap of its own on the length of the line
					// an argument is a C string: it ends at a NUL, whatever was put into it
					const r = await ctx.exec(shellQuote(argv[0]), { cwd: ctx.cwd, signal: ctx.signal, args: argv.slice(1) });
					stdout += r.stdout || '';
					const err = r.stderr || '';
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
				// a command that failed is 123, whatever stopped the reading (which alone is 1)
				return { stdout, stderr, exitCode: status || (failed ? 123 : (stoppedReading ? 1 : 0)) };
			}
			// no way to run a command from here (a stand-in engine without exec()): the engine's own xargs, as normalised
			return ctx.origCommand(normaliseXargs(args));
		}),
		...['grep', 'egrep', 'fgrep'].map((name) => define(name, async (args, ctx) => {
			if (!ctx.origCommand) { return missingOriginal(name); }
			// -d and -D (what to do with a folder, a device): taken out here, the engine has neither
			const dd = grepDirectories(args);
			if (dd.result) { return dd.result; }
			if (dd.args.length !== args.length || dd.args.some((x, k) => x !== args[k])) {
				args = dd.args;
				if (dd.action === 'skip' && !args.some((x) => x === '-r' || x === '-R' || x === '--recursive')) {
					// the folders given as files are not read, and not said: names are still shown when there were several
					const g = grepOperands(args);
					const drop = new Set();
					for (const i of g.fileAt) { const st = args[i] === '-' ? null : await statOrNull(ctx, abs(ctx, args[i])); if (st && st.isDirectory) { drop.add(i); } }
					if (drop.size) {
						if (drop.size === g.fileAt.length) { return { stdout: '', stderr: '', exitCode: 1 }; }
						const more = g.fileAt.length > 1 && !g.noName && !g.withName ? ['-H'] : [];
						args = [...more, ...args.filter((x, k) => !drop.has(k))];
					}
				}
			}
			// -l and -L of standard input name it `(standard input)`; the engine, given no operand, prints the lines it matched
			// (and nothing at all for -L). An operand `-` is the same input and it says the name
			{
				const g = grepOperands(args);
				if (!g.recursive && g.files.length === 0 && zero.grepOutputKind(args).names) { args = [...args, '-']; }
			}
			// -z and -Z (records and names that end in NUL): zeroRun
			const zp = zero.plan(name, args, OPTION_VALUES[name]);
			if (zp.zero || zp.nul) { return zeroRun(ctx, name, zp); }
			// a directory named with a trailing slash prints src/file, not src//file (GNU strips it for the name)
			const g0 = grepOperands(args);
			let typed = args.slice();
			for (const i of g0.fileAt) { if (typed[i].length > 1 && typed[i].endsWith('/')) { typed[i] = typed[i].slice(0, -1); } }
			// a recursive search is not told by the engine that a name is not there (it said nothing and the status was 1, or
			// 0 when another operand matched): said here, once for each, and the status is 2
			let notThere = '';
			let hadMissing = false;
			if (g0.recursive && g0.fileAt.length) {
				const gone = new Set();
				for (const i of g0.fileAt) {
					if (typed[i] !== '-' && !(await statOrNull(ctx, abs(ctx, typed[i])))) { gone.add(i); notThere += `grep: ${typed[i]}: No such file or directory\n`; }
				}
				if (gone.size) {
					hadMissing = true;
					if (grepWantsSilence(typed)) { notThere = ''; }
					if (gone.size === g0.fileAt.length) { return { stdout: '', stderr: notThere, exitCode: 2 }; }
					// the names are shown when there were several operands, whatever is left of them
					const names = g0.fileAt.length > 1 && !g0.noName && !g0.withName;
					typed = typed.filter((_x, k) => !gone.has(k));
					if (names) { typed = ['-H', ...typed]; }
				}
			}
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
			// -q stops at the first file with a match, and says what was wrong with the files before it (the engine says
			// nothing when something matched): one file at a time, in order
			if (g.recursive === false && g.files.length > 1 && zero.grepOutputKind(typed).quiet && ctx.exec) {
				const state = [];
				for (const f of g.files) { state.push(f === '-' ? 'ok' : (await statOrNull(ctx, abs(ctx, f))) ? ((await statOrNull(ctx, abs(ctx, f))).isDirectory ? 'dir' : 'ok') : 'missing'); }
				if (state.some((x) => x !== 'ok')) {
					const quietMessages = grepWantsSilence(typed);
					let said = '';
					let failed = false;
					for (let k = 0; k < g.files.length; k++) {
						if (state[k] !== 'ok') {
							failed = true;
							if (!quietMessages) { said += `grep: ${g.files[k]}: ${state[k] === 'dir' ? 'Is a directory' : 'No such file or directory'}\n`; }
							continue;
						}
						const only = typed.filter((x, at) => !g.fileAt.includes(at) || at === g.fileAt[k]);
						const one = await ctx.exec(shellQuote(name), { cwd: ctx.cwd, signal: ctx.signal, args: only, stdin: ctx.stdin });
						said += one.stderr || '';
						if (one.exitCode === 0) { return { stdout: '', stderr: said, exitCode: 0 }; }
						if (one.exitCode !== 1) { failed = true; }
					}
					return { stdout: '', stderr: said, exitCode: failed ? 2 : 1 };
				}
			}
			// -m N: at most N selected lines of each file. -m 0 reads nothing (GNU leaves at once, status 1, whatever else
			// was asked); -c with -m counts no more than N (the engine counted them all)
			let maxCount = null;
			for (let k = 0; k < norm.length && norm[k] !== '--'; k++) {
				if (norm[k] === '-m' && /^-?\d+$/.test(norm[k + 1] || '')) { maxCount = Number(norm[k + 1]); }
				if (norm[k] === '-e' || norm[k] === '-f') { k++; }
			}
			if (maxCount === 0) { return { stdout: '', stderr: '', exitCode: 1 }; }
			r = await ctx.origCommand(norm);
			if (maxCount !== null && maxCount > 0 && r.stdout && zero.grepOutputKind(typed).count) {
				r = Object.assign({}, r, { stdout: r.stdout.replace(/^((?:.*:)?)(\d+)$/gm, (_m, pre, n) => pre + Math.min(Number(n), maxCount)) });
			}
			if (addedNull && r.stdout) {
				r = Object.assign({}, r, { stdout: r.stdout.split('\n').filter((l) => l !== '/dev/null' && l !== '/dev/null:0').join('\n') });
			}
			if (r.stdout && grepDotPrefix(typed)) {
				r = Object.assign({}, r, { stdout: r.stdout.replace(/^(?!--$)(?=.)/gm, './') });
			}
			// -c counts a folder as 0 lines (the engine says nothing of it): its line, where it was in the operands
			if (/^grep: .*: Is a directory$/m.test(r.stderr) && zero.grepOutputKind(typed).count && !g.recursive) {
				const dirs = new Set(r.stderr.split('\n').map((l) => /^grep: (.*): Is a directory$/.exec(l)).filter(Boolean).map((m) => m[1]));
				const names = (g.files.length > 1 || g.withName) && !g.noName;
				const lines = r.stdout ? r.stdout.replace(/\n$/, '').split('\n') : [];
				let k = 0;
				const out = [];
				for (const f of g.files) { if (dirs.has(f)) { out.push(names ? f + ':0' : '0'); } else if (k < lines.length) { out.push(lines[k++]); } }
				r = Object.assign({}, r, { stdout: out.join('\n') + (out.length ? '\n' : '') });
			}
			// a folder given as a file is an error: the status is 2 whatever matched (-q alone, with a match, keeps 0)
			if (r.exitCode !== 2 && /^grep: .*: (Is a directory|No such file or directory)$/m.test(r.stderr) && !(r.exitCode === 0 && zero.grepOutputKind(typed).quiet)) {
				r = Object.assign({}, r, { exitCode: 2 });
			}
			// --label=NAME is what standard input is called in a name
			{
				let label = null;
				for (let k = 0; k < args.length && args[k] !== '--'; k++) {
					if (args[k] === '--label' && k + 1 < args.length) { label = args[k + 1]; k++; } else if (args[k].startsWith('--label=')) { label = args[k].slice(8); }
				}
				if (label !== null && r.stdout.includes('(standard input)')) { r = Object.assign({}, r, { stdout: r.stdout.split('(standard input)').join(label) }); }
			}
			if (hadMissing) { r = Object.assign({}, r, { stderr: notThere + r.stderr, exitCode: r.exitCode === 0 && zero.grepOutputKind(typed).quiet ? 0 : 2 }); }
			if (!r.stderr || !grepWantsSilence(typed)) { return r; }
			const kept = r.stderr.split('\n').filter((l) => !/^grep: .*: (No such file or directory|Is a directory|Permission denied)$/.test(l));
			return Object.assign({}, r, { stderr: kept.join('\n') });
		})),
		define('rm', async (args, ctx) => {
			if (!ctx.origCommand) { return missingOriginal('rm'); }
			const norm = normaliseRm(args);
			// the operands, and the flags that decide what is said and what is removed
			const flags = [];
			const operands = [];
			let afterDashes = false;
			for (const a of norm) {
				if (!afterDashes && a === '--') { afterDashes = true; continue; }
				if (!afterDashes && a.startsWith('-') && a !== '-') { flags.push(a); } else { operands.push(a); }
			}
			const has = (letters, long) => flags.some((f) => f === long || (!f.startsWith('--') && [...letters].some((c) => f.slice(1).includes(c))));
			const recursive = has('rR', '--recursive');
			const force = has('f', '--force');
			const verbose = has('v', '--verbose');
			const dirs = has('d', '--dir');
			// an option the program does not have is said once, before anything else (the operands are sent one by one
			// below, and each of them said it again): asked of the engine with a name that is not there
			if (dirs || (verbose && recursive)) {
				const own = flags.filter((f) => f.startsWith('--') ? f !== '--dir' && f !== '--verbose' : true).map((f) => (f.startsWith('--') ? f : '-' + f.slice(1).replace(/[dv]/g, ''))).filter((f) => f !== '-');
				const probe = await ctx.origCommand([...own, '-f', '--', '/.lc-no-such-name']);
				const bad = /^rm: (invalid option -- |unrecognized option )[^\n]*\n/.exec(probe.stderr);
				if (probe.exitCode && bad) { return { stdout: '', stderr: `${bad[0]}Try 'rm --help' for more information.\n`, exitCode: 1 }; }
			}
			let stderr = '';
			let exitCode = 0;
			const todo = [];
			for (const o of operands) {
				// `.` and `..` are never removed, and a name that ends in one is not either
				if (/(^|\/)\.{1,2}\/*$/.test(o)) {
					// the folder it is in decides: not there, a file, or the folder whose `.` or `..` it is
					const plain = o.replace(/\/+$/, '');
					const at = plain.lastIndexOf('/');
					const parent = at < 0 ? await statOrNull(ctx, ctx.cwd) : await typedStat(ctx, plain.slice(0, at) || '/');
					if (parent && parent.isDirectory) {
						// -r refuses them by name; without it they are folders, whatever -f says, and with -d the folder is looked
						// at: one that is empty is refused by name as well, one that is not is "Directory not empty"
						let refuse = recursive;
						if (!recursive && dirs) {
							try { refuse = (await ctx.fs.readdir(abs(ctx, o))).length === 0; } catch { refuse = false; }
						}
						stderr += refuse ? `rm: refusing to remove '.' or '..' directory: skipping '${o}'\n` : `rm: cannot remove '${o}': ${dirs ? 'Directory not empty' : 'Is a directory'}\n`;
						exitCode = 1;
					} else if (!force) {
						stderr += `rm: cannot remove '${o}': ${(await whyMissing(ctx, plain)) || (parent ? 'Not a directory' : 'No such file or directory')}\n`;
						exitCode = 1;
					}
					continue;
				}
				// a file written with a slash is no file (`rm f/` is "Not a directory" and f stays; the engine removed it)
				if (o.length > 1 && o.endsWith('/')) {
					const st = await typedStat(ctx, o.replace(/\/+$/, ''));
					if (st && !st.isDirectory) {
						if (!force) { stderr += `rm: cannot remove '${o}': Not a directory\n`; exitCode = 1; }
						continue;
					}
				}
				// a name through `..` of a folder that is not there is not there (the engine took `x/../d` for `d`)
				if (await reachable(ctx, o)) { todo.push(o); continue; }
				if (!force) {
					stderr += `rm: cannot remove '${o}': ${(await whyMissing(ctx, o.replace(/\/+$/, ''))) || 'No such file or directory'}\n`;
					exitCode = 1;
				}
			}
			if (!dirs && !(verbose && recursive) && todo.length === operands.length) {
				const r = await ctx.origCommand(norm);
				// the engine's message for a long option has no `Try` line (GNU's has)
				return /^rm: (invalid option -- |unrecognized option )[^\n]*\n$/.test(r.stderr) ? Object.assign({}, r, { stderr: r.stderr + "Try 'rm --help' for more information.\n" }) : r;
			}
			if (!todo.length) { return { stdout: '', stderr, exitCode }; }
			// -d removes an empty folder; -rv lists every entry it removes, a folder after what is in it
			const rest = flags.filter((f) => f.startsWith('--') ? f !== '--dir' && f !== '--verbose' : true)
				.map((f) => (f.startsWith('--') ? f : '-' + f.slice(1).replace(/[dv]/g, '')))
				.filter((f) => f !== '-');
			let stdout = '';
			/** @param {string} dir the name as typed */
			const listTree = async (dir) => {
				const out = [];
				for (const name of (await ctx.fs.readdir(abs(ctx, dir))).slice().sort()) {
					const p = dir.replace(/\/+$/, '') + '/' + name;
					const st = await statOrNull(ctx, abs(ctx, p));
					if (st && st.isDirectory) { out.push(...(await listTree(p)), `removed directory '${p}'\n`); } else { out.push(`removed '${p}'\n`); }
				}
				return out;
			};
			for (const o of todo) {
				const st = await typedStat(ctx, o);
				if (st && st.isDirectory && dirs && !recursive) {
					if ((await ctx.fs.readdir(abs(ctx, o))).length) {
						stderr += `rm: cannot remove '${o}': Directory not empty\n`;
						exitCode = 1;
						continue;
					}
					await ctx.fs.rm(abs(ctx, o), { recursive: false, force: false });
					if (verbose) { stdout += `removed directory '${o}'\n`; }
					continue;
				}
				const lines = verbose && recursive && st ? (st.isDirectory ? [...(await listTree(o)), `removed directory '${o}'\n`] : [`removed '${o}'\n`]) : null;
				const r = await ctx.origCommand([...rest, ...(verbose && lines === null ? ['-v'] : []), '--', o]);
				stderr += r.stderr;
				if (r.exitCode) { exitCode = r.exitCode; } else { stdout += lines === null ? r.stdout : lines.join(''); }
			}
			return { stdout, stderr, exitCode };
		}),
		define('cp', async (args, ctx) => {
			if (!ctx.origCommand) { return missingOriginal('cp'); }
			const n = normaliseCp(args);
			const pre = await preflight(ctx, 'cp', n.args, wantsNoTargetDirectory(args), wantsForce(args), extractTarget(args).target !== null);
			if (pre.result) { return pre.result; }
			const keepTimes = wantsPreserveTimes(args);
			/** the copy made: what -p / -a keep of the original is its modification time, the engine's copy is made now */
			const preserve = async (result) => {
				if (!keepTimes || result.exitCode !== 0) { return result; }
				const ops = [];
				let dashes = false;
				for (const a of pre.args) { if (!dashes && a === '--') { dashes = true; } else if (dashes || a === '-' || !a.startsWith('-')) { ops.push(a); } }
				if (ops.length < 2) { return result; }
				const dest = ops[ops.length - 1];
				const intoFolder = !!(names && names.intoFolder);
				const copyTimes = async (from, to) => {
					const st = await statOrNull(ctx, from);
					const dst = await statOrNull(ctx, to);
					if (!st || !dst) { return; }
					if (st.isDirectory && dst.isDirectory) {
						for (const name of await ctx.fs.readdir(from)) { await copyTimes(ctx.fs.resolvePath(from, name), ctx.fs.resolvePath(to, name)); }
					}
					try { await ctx.fs.utimes(to, st.mtime, st.mtime); } catch { /* the copy is what mattered */ }
				};
				for (const src of ops.slice(0, -1)) {
					const from = abs(ctx, src.replace(/\/+$/, '') || '/');
					const to = intoFolder ? ctx.fs.resolvePath(abs(ctx, dest.replace(/\/+$/, '') || '/'), baseName(from)) : abs(ctx, dest.replace(/\/+$/, '') || '/');
					await copyTimes(from, to);
				}
				return result;
			};
			let names = null;
			// -u, and -n of a folder (which the engine skips as a whole where GNU merges what is missing), are done a file at a time
			const recursive = pre.args.some((a) => /^-[A-Za-z]*[rR]/.test(a) || a === '--recursive');
			const noClobber = pre.args.some((a) => a === '--no-clobber' || (/^-[A-Za-z]*n/.test(a) && !a.startsWith('--')));
			names = await transferNames(ctx, pre.args, wantsNoTargetDirectory(args));
			if (n.update || (recursive && noClobber)) {
				const each = await transferEach(ctx, 'cp', pre.args, wantsNoTargetDirectory(args), { update: n.update, noClobber });
				return preserve(Object.assign({}, each, { stderr: pre.stderr + each.stderr, exitCode: hasError(pre.stderr) ? 1 : each.exitCode }));
			}
			let r = relativeVerbose(await ctx.origCommand(pre.args), ctx.cwd);
			if (r.stdout && r.stdout.includes("' -> '") && recursive) {
				r = Object.assign({}, r, { stdout: await verboseTree(ctx, r.stdout) });
			}
			if (r.stdout && names) { r = Object.assign({}, r, { stdout: verboseAsTyped(r.stdout, names.sources, names.dest, names.intoFolder) }); }
			return preserve(Object.assign({}, r, { stderr: pre.stderr + (r.stderr ? gnuTransferErrors(r.stderr, 'cp', ctx.cwd) : ''), exitCode: hasError(pre.stderr) ? 1 : r.exitCode }));
		}),
		define('mv', async (args, ctx) => {
			if (!ctx.origCommand) { return missingOriginal('mv'); }
			const n = normaliseMv(args);
			const pre = await preflight(ctx, 'mv', n.args, wantsNoTargetDirectory(args), false, extractTarget(args).target !== null);
			if (pre.result) { return pre.result; }
			if (n.update) {
				const noClobber = pre.args.some((a) => a === '--no-clobber' || (/^-[A-Za-z]*n/.test(a) && !a.startsWith('--')));
				const each = await transferEach(ctx, 'mv', pre.args, wantsNoTargetDirectory(args), { update: true, noClobber });
				return Object.assign({}, each, { stderr: pre.stderr + each.stderr, exitCode: hasError(pre.stderr) ? 1 : each.exitCode });
			}
			const names = await transferNames(ctx, pre.args, wantsNoTargetDirectory(args));
			let r = relativeVerbose(await ctx.origCommand(pre.args), ctx.cwd);
			if (r.stdout && names) { r = Object.assign({}, r, { stdout: verboseAsTyped(r.stdout, names.sources, names.dest, names.intoFolder) }); }
			return Object.assign({}, r, { stderr: pre.stderr + (r.stderr ? gnuTransferErrors(r.stderr, 'mv', ctx.cwd) : ''), exitCode: hasError(pre.stderr) ? 1 : r.exitCode });
		}),
		define('mkdir', async (args, ctx) => {
			if (!ctx.origCommand) { return missingOriginal('mkdir'); }
			const n = normaliseMkdir(args);
			// -pv names every folder it makes, the ones on the way too; the engine names the last
			const flags = n.args.filter((a) => a.startsWith('-') && a !== '--' && a !== '-');
			const verboseParents = flags.some((f) => f === '--parents' || /^-[A-Za-z]*p/.test(f)) && flags.some((f) => f === '--verbose' || /^-[A-Za-z]*v/.test(f));
			/** @type {string[]} */
			const made = [];
			if (verboseParents) {
				// each folder as GNU names it: the operand as typed up to that segment (`a//b`, `./c/./d`), the last one with
				// the slashes it was typed with (`g/h/`); a segment that is `.` or `..` is a folder that is there (or was just
				// planned), so it makes nothing and is not named
				const planned = new Set();
				for (const d of n.dirs) {
					const segments = [...d.matchAll(/[^/]+/g)];
					for (let k = 0; k < segments.length; k++) {
							const shown = k === segments.length - 1 ? d : d.slice(0, /** @type {number} */ (segments[k].index) + segments[k][0].length);
						const where = abs(ctx, d.slice(0, /** @type {number} */ (segments[k].index) + segments[k][0].length));
						if (!planned.has(where) && !(await statOrNull(ctx, where))) { planned.add(where); made.push(shown); }
					}
				}
			}
			// a name that goes back up (`a/b/../c`): -p makes the folders on the way as typed (a/b too), and without -p the
			// folder `a/b` has to be there already (the engine took the name for `a/c`)
			let margs = n.args;
			let mgone = '';
			if (n.dirs.some((d) => d.includes('..'))) {
				const parents = flags.some((f) => f === '--parents' || (!f.startsWith('--') && /^-[A-Za-z]*p/.test(f)));
				const drop = new Set();
				for (const d of n.dirs) {
					if (!d.includes('..')) { continue; }
					if (!parents) {
						if (!(await reachable(ctx, d))) {
							drop.add(d);
							const plain = d.replace(/\/+$/, '');
							mgone += `mkdir: cannot create directory '${d}': ${(await whyMissing(ctx, plain.slice(0, plain.lastIndexOf('/')) || '/')) || 'No such file or directory'}\n`;
						}
						continue;
					}
					let cur = d.startsWith('/') ? '/' : ctx.cwd;
					const segs = d.split('/').filter((x) => x !== '' && x !== '.');
					let typedSoFar = d.startsWith('/') ? '' : null;
					for (let k = 0; k < segs.length - 1; k++) {
						typedSoFar = typedSoFar === null ? segs[k] : typedSoFar + '/' + segs[k];
						cur = segs[k] === '..' ? dirName(cur) : ctx.fs.resolvePath(cur, segs[k]);
						const here = await statOrNull(ctx, cur);
						if (here && !here.isDirectory) {
							// a file where a folder is needed: said of the part of the path that is the file, and nothing is made
							drop.add(d);
							mgone += `mkdir: cannot create directory '${typedSoFar}': Not a directory\n`;
							break;
						}
						if (segs[k] !== '..') { try { await ctx.fs.mkdir(cur, { recursive: true }); } catch { /* the engine says what is wrong */ } }
					}
				}
				if (drop.size) {
					margs = n.args.filter((a) => !drop.has(a));
					if (!n.dirs.some((d) => !drop.has(d))) { return { stdout: '', stderr: mgone, exitCode: 1 }; }
				}
			}
			let r = await ctx.origCommand(margs);
			// a file on the way: GNU says "Not a directory" of the name that is a file (with -p, of the part of the path
			// that is one), where the engine says its own system's words and its own absolute path
			if (/ENOTDIR/.test(r.stderr)) {
				const parents = flags.some((f) => f === '--parents' || (!f.startsWith('--') && /^-[A-Za-z]*p/.test(f)));
				const lines = [];
				for (const line of r.stderr.split('\n')) {
					const m = /^mkdir: cannot create directory '(.*)': ENOTDIR: not a directory, mkdir '.*'$/.exec(line);
					if (!m) { lines.push(line); continue; }
					let shown = m[1];
					if (parents) {
						const parts = m[1].split('/');
						for (let k = 1; k <= parts.length; k++) {
							const prefix = parts.slice(0, k).join('/');
							if (prefix === '' || /^\.{0,2}$/.test(parts[k - 1])) { continue; }
							const st = await typedStat(ctx, prefix);
							if (st && !st.isDirectory) { shown = prefix; break; }
						}
					}
					lines.push(`mkdir: cannot create directory '${shown}': Not a directory`);
				}
				r = Object.assign({}, r, { stderr: lines.join('\n') });
			}
			if (mgone) { r = Object.assign({}, r, { stderr: mgone + r.stderr, exitCode: r.exitCode || 1 }); }
			if (verboseParents && r.exitCode === 0) { r = Object.assign({}, r, { stdout: made.map((m) => `mkdir: created directory '${m}'\n`).join('') }); }
			if (n.mode !== null && r.exitCode === 0 && /^[0-7]{1,4}$/.test(n.mode)) {
				for (const d of n.dirs) { try { await ctx.fs.chmod(abs(ctx, d), parseInt(n.mode, 8)); } catch { /* the directory is what mattered */ } }
			}
			return r;
		}),
		define('sed', async (args, ctx) => {
			if (!ctx.origCommand) { return missingOriginal('sed'); }
			const zp = zero.plan('sed', args, OPTION_VALUES.sed);
			// -z (records end in NUL), and -s (each file is its own stream: `$` and the line numbers are its own)
			if (zp.zero || (zp.separate && !zp.inPlace && zp.files.length > 1)) { return zeroRun(ctx, 'sed', zp); }
			// -s with one file, or with -i (which implies it), is what there is without it
			if (zp.separate) { args = zp.args.map((a) => (a === '-i' ? '-i' + (zp.suffix || '') : a === '--in-place' && zp.suffix ? '--in-place=' + zp.suffix : a)); }
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
			// GNU says `can't read` for a file it cannot open, and goes on to the next one: the status is 2 at the end
			// (the engine stops at the first)
			let cannotRead = '';
			let fatal = '';
			const gone = new Set();
			for (const k of n.fileAt) {
				if (n.args[k] === '-') { continue; }
				const st = await statOrNull(ctx, abs(ctx, n.args[k]));
				if (!st) {
					gone.add(k);
					cannotRead += `sed: can't read ${n.args[k]}: No such file or directory\n`;
					continue;
				}
				if (st.isDirectory) {
					// a folder ends it, after the files before it (a read error, status 4)
					fatal = n.suffix !== null ? `sed: couldn't edit ${n.args[k]}: not a regular file\n` : `sed: read error on ${n.args[k]}: Is a directory\n`;
					for (const j of n.fileAt) { if (j >= k) { gone.add(j); } }
					break;
				}
			}
			if (gone.size) {
				if (gone.size === n.fileAt.length) { return { stdout: '', stderr: cannotRead + fatal, exitCode: fatal ? 4 : 2 }; }
				n.args = n.args.filter((_, k) => !gone.has(k));
			}
			let r = withoutDoubledPrefix(await ctx.origCommand(n.args), 'sed');
			if (cannotRead || fatal) { r = Object.assign({}, r, { stderr: cannotRead + r.stderr + fatal, exitCode: fatal ? 4 : (r.exitCode || 2) }); }
			// a script file that is not there ends it (an I/O error, status 4)
			if (r.exitCode === 1 && /^sed: couldn't open file /m.test(r.stderr)) { r = Object.assign({}, r, { exitCode: 4 }); }
			return r;
		}),
		define('touch', async (args, ctx) => {
			if (!ctx.origCommand) { return missingOriginal('touch'); }
			const sources = touchSources(args);
			if (sources.stamp && (sources.date || sources.ref)) { return { stdout: '', stderr: 'touch: cannot specify times from more than one source\nTry \'touch --help\' for more information.\n', exitCode: 1 }; }
			const t = parseTouch(args, zone.getZone());
			if (t.invalidStamp !== null) { return { stdout: '', stderr: `touch: invalid date format '${t.invalidStamp}'\n`, exitCode: 1 }; }
			let time = t.time;
			if (t.reference !== null) {
				const ref = await statOrNull(ctx, abs(ctx, t.reference));
				if (!ref) { return { stdout: '', stderr: `touch: failed to get attributes of '${t.reference}': No such file or directory\n`, exitCode: 1 }; }
				// the time of REF is the one to use unless the line gave its own (-t, or -d: GNU lets those win)
				const stop = t.args.indexOf('--');
				const own = t.args.slice(0, stop < 0 ? undefined : stop).some((a) => a === '-d' || a === '-t');
				if (time === null && !own) { time = +ref.mtime; }
				// `-r REF -d '+1 day'`: the string is read relative to the time of REF
				if (t.dateText !== null) {
					const rel = datestr.parse(t.dateText, +ref.mtime, zone.getZone());
					if (rel && !('invalid' in rel)) { time = Math.floor(rel.ms / 1000) * 1000; }
				}
			}
			// a name through `..` of a folder that is not there cannot be made (the engine took `x/../n` for `n`)
			let gone = '';
			let toTouch = t.files;
			let touchArgs = t.args;
			if (t.files.some((f) => f.includes('..'))) {
				const keep = [];
				for (const f of t.files) {
					if (await reachable(ctx, f)) { keep.push(f); } else if (!t.args.some((a) => a === '-c' || a === '--no-create' || (/^-[A-Za-z]*c/.test(a) && !a.startsWith('--')))) { gone += `touch: cannot touch '${f}': ${(await whyMissing(ctx, f.replace(/\/+$/, ''))) || 'No such file or directory'}\n`; } else { keep.push(f); }
				}
				if (keep.length !== t.files.length) {
					toTouch = keep;
					const drop = new Set(t.files.filter((f) => !keep.includes(f)));
					touchArgs = t.args.filter((a) => !drop.has(a));
					if (!keep.length) { return { stdout: '', stderr: gone, exitCode: 1 }; }
				}
			}
			// -a alone changes the access time, which nothing here keeps: a file that is there is left as it is (its
			// modification time is not the access time), one that is not there is made
			{
				const upto = touchArgs.indexOf('--');
				const opts = upto < 0 ? touchArgs : touchArgs.slice(0, upto);
				let hasA = false;
				let hasM = false;
				for (let k = 0; k < opts.length; k++) {
					const a = opts[k];
					if (a === '-d' || a === '-r' || a === '-t' || a === '--date' || a === '--reference') { k++; continue; }
					const tw = a.startsWith('--time=') ? a.slice(7) : a === '--time' ? opts[++k] : null;
					if (tw !== null) { if (/^(atime|access|use)$/.test(tw)) { hasA = true; } else if (/^(mtime|modify)$/.test(tw)) { hasM = true; } continue; }
					if (/^-[A-Za-z]+$/.test(a)) { if (a.includes('a')) { hasA = true; } if (a.includes('m')) { hasM = true; } } else if (a === '--no-create') { /* -c */ }
				}
				if (hasA && !hasM) {
					const there = new Set();
					for (const f of toTouch) { if (await statOrNull(ctx, abs(ctx, f))) { there.add(f); } }
					if (there.size) {
						toTouch = toTouch.filter((f) => !there.has(f));
						const operandAt = new Set(operandIndexes('touch', touchArgs));
						touchArgs = touchArgs.filter((a, k) => !(operandAt.has(k) && there.has(a)));
						if (!toTouch.length) { return { stdout: '', stderr: gone, exitCode: gone ? 1 : 0 }; }
					}
				}
			}
			const r0 = await ctx.origCommand(touchArgs);
			const r = gone ? Object.assign({}, r0, { stderr: gone + r0.stderr, exitCode: r0.exitCode || 1 }) : r0;
			if (time !== null && r0.exitCode === 0) {
				for (const f of toTouch) {
					try { await ctx.fs.utimes(abs(ctx, f), new zone.LcDate(time), new zone.LcDate(time)); } catch { /* -c on a file that is not there */ }
				}
			}
			return r;
		}),
		define('ls', async (args, ctx) => {
			if (!ctx.origCommand) { return missingOriginal('ls'); }
			// -I PATTERN, --ignore, --hide, -w and --width (a column is one name wide here anyway), --sort=WORD, -X, -v, -U, -n
			const extra = lsOptions(args);
			if ('error' in extra) { return { stdout: '', stderr: extra.error, exitCode: 1 }; }
			const n = normaliseLs(extra.args);
			let r = await ctx.origCommand(n.args);
			if (n.slashOnly && r.stdout) { r = Object.assign({}, r, { stdout: r.stdout.replace(/\*$/gm, '') }); }
			if (r.stdout && extra.active) { r = Object.assign({}, r, { stdout: lsRefine(r.stdout, extra) }); }
			if (r.stdout && /(^|\n)total \d+\n/.test(r.stdout)) { r = Object.assign({}, r, { stdout: lsTotals(r.stdout) }); }
			if (!r.stderr) { return r; }
			// GNU: `ls: cannot access 'x': No such file or directory`
			return Object.assign({}, r, { stderr: r.stderr.replace(/^ls: (?!cannot access )(.+): No such file or directory$/gm, "ls: cannot access '$1': No such file or directory") });
		}),
		define('du', async (args0, ctx) => {
			const from = await filesFrom(ctx, 'du', args0);
			if ('result' in from) { return from.result; }
			const r = await du(from.args, {
				cwd: ctx.cwd,
				stat: (p) => statOrNull(ctx, p),
				readdir: async (p) => (await ctx.fs.readdir(p)).slice().sort(),
				resolve: (b, p) => ctx.fs.resolvePath(b, p),
				traversal: {
					entries: ctx.limits && ctx.limits.maxTraversalEntries,
					depth: ctx.limits && ctx.limits.maxTraversalDepth,
					exceeded: (message) => (LimitError ? new LimitError(message, 'iterations') : Object.assign(new Error(message), { name: 'ExecutionLimitError' })),
				},
			});
			return from.stderr ? Object.assign({}, r, { stderr: from.stderr + r.stderr, exitCode: r.exitCode || 1 }) : r;
		}),
		...['basename', 'dirname', 'readlink', 'printenv'].map((name) => define(name, async (args, ctx) => {
			if (!ctx.origCommand) { return missingOriginal(name); }
			// basename and dirname are string functions: done here for a plain command line (`basename /` is `/`, `dirname
			// a/b/` is `a`, `basename .js .js` is `.js`); an option or a count this does not read is the engine's
			if (name === 'basename' || name === 'dirname') {
				const r = nameCommand(name, args);
				if (r) { return r; }
			}
			// -z (printenv: -0): each result ends in NUL, not in a newline. A result is one record, so the program is run for
			// each operand and its own newline is the one that is replaced
			const zp = zero.plan(name, args, OPTION_VALUES[name]);
			if (!zp.zero) { return ctx.origCommand(args); }
			const operandSet = new Set(zp.files);
			const options = zp.args.filter((_a, i) => !operandSet.has(i));
			const names = zp.files.map((i) => zp.args[i]);
			const whole = name === 'basename' && !options.some((o) => o === '-a' || o === '--multiple' || /^-[A-Za-z]*a/.test(o) || o === '-s' || o.startsWith('--suffix') || /^-[A-Za-z]*s/.test(o));
			const record = (out) => (out.endsWith('\n') ? out.slice(0, -1) + '\0' : out);
			if (name === 'printenv' && !names.length) {
				const entries = ctx.env instanceof Map ? [...ctx.env.entries()] : Object.entries(ctx.env || {});
				return { stdout: entries.map(([k, v]) => `${k}=${v}\0`).join(''), stderr: '', exitCode: 0 };
			}
			if (whole || (name !== 'printenv' && !names.length)) { const r = await ctx.origCommand(zp.args); return Object.assign({}, r, { stdout: record(r.stdout) }); }
			let stdout = '';
			let stderr = '';
			let exitCode = 0;
			for (const n of names) {
				const r = await ctx.origCommand(name === 'printenv' ? [...options, n] : [...options, '--', n]);
				stdout += record(r.stdout);
				stderr += r.stderr;
				if (r.exitCode) { exitCode = r.exitCode; }
			}
			return { stdout, stderr, exitCode };
		})),
		define('diff', async (args, ctx) => {
			if (!ctx.origCommand) { return missingOriginal('diff'); }
			// folders, -r -N -q -s -x -X, -U N -C N with the timestamps GNU prints, -w -b -B -Z: diff.js, over the engine's
			// own comparison of two files
			const temps = [];
			const r = await diffs.run(args, {
				stdin: ctx.stdin || '',
				readFile: (p) => ctx.fs.readFileBuffer(abs(ctx, p)),
				stat: async (p) => {
					const st = await statOrNull(ctx, abs(ctx, p));
					return st ? { isFile: !!st.isFile, isDirectory: !!st.isDirectory, mtimeMs: +st.mtime } : null;
				},
				readdir: async (p) => (await ctx.fs.readdir(abs(ctx, p))).slice(),
				engine: (list) => ctx.origCommand(list),
				writeTemp: async (text) => {
					const path = `/tmp/.lc-diff-${++zeroSeq}`;
					await putCopy(ctx, path, encodeText(text));
					temps.push(path);
					return path;
				},
				stamp: (ms) => statTimeFormat('%y', ms === null ? Date.now() : ms, zone.getZone()),
				quote: xargsQuote,
			}).catch((e) => {
				// a copy the cap refused is a refusal, not "no difference" (the engine compared a file that was not there)
				if (e && e.lcMemory) { return { stdout: '', stderr: 'diff: memory exhausted\n', exitCode: 2 }; }
				throw e;
			}).finally(async () => { for (const t of temps) { try { await ctx.fs.rm(t, { force: true }); } catch { /* under /tmp */ } } });
			const res = r || await ctx.origCommand(args);
			// what the engine says of an option that is not one is GNU's getopt's, without the hint and with status 1: GNU's is 2
			if (res.exitCode === 1 && /^diff: (unrecognized option '|invalid option -- |option '[^']*' (requires|doesn't allow)|option requires)/.test(res.stderr) && !res.stderr.includes("Try 'diff --help'")) {
				return Object.assign({}, res, { stderr: res.stderr + "diff: Try 'diff --help' for more information.\n", exitCode: 2 });
			}
			return res;
		}),
		define('cut', async (args0, ctx) => {
			if (!ctx.origCommand) { return missingOriginal('cut'); }
			// the long options of the ones the engine has: --fields=LIST, --delimiter=C, --characters=LIST (it reads --only-delimited itself)
			const args = [];
			for (let i = 0; i < args0.length; i++) {
				const a = args0[i];
				if (a === '--') { args.push(...args0.slice(i)); break; }
				const m = /^--(fields|delimiter|characters)(?:=([^]*))?$/.exec(a);
				if (m) {
					const flag = { fields: '-f', delimiter: '-d', characters: '-c' }[m[1]];
					if (m[2] !== undefined) { args.push(flag, m[2]); } else if (i + 1 < args0.length) { args.push(flag, args0[++i]); } else { args.push(a); }
					continue;
				}
				args.push(a);
			}
			const zp = zero.plan('cut', args, { short: 'bcdf', long: ['--bytes', '--characters', '--delimiter', '--fields', '--output-delimiter'] });
			return zp.zero ? zeroRun(ctx, 'cut', zp) : ctx.origCommand(args);
		}),
		define('tr', async (args, ctx) => {
			if (!ctx.origCommand) { return missingOriginal('tr'); }
			// GNU's tr, whole (tr.js): bytes, its escapes (NUL as a second set too), classes, repeats and its errors
			const r = tr.run(args, stdinBytes(ctx.stdin));
			if ('passThrough' in r) { return ctx.origCommand(args); }
			return { stdout: latin1(r.stdout), stderr: r.stderr, exitCode: r.exitCode, stdoutEncoding: 'binary' };
		}),
		define('uniq', async (args, ctx) => {
			if (!ctx.origCommand) { return missingOriginal('uniq'); }
			const zp = zero.plan('uniq', args, OPTION_VALUES.uniq);
			if (zp.zero) { return zeroRun(ctx, 'uniq', zp); }
			const r = await ctx.origCommand(args);
			if (!args.some((a) => a === '--count' || (/^-[A-Za-z]+$/.test(a) && a.includes('c')))) { return r; }
			// the engine pads the count to 4 characters, GNU uniq to 7
			return Object.assign({}, r, { stdout: r.stdout.replace(/^ *(\d+) /gm, (_m, n) => n.padStart(7, ' ') + ' ') });
		}),
		define('wc', async (args0, ctx) => {
			if (!ctx.origCommand) { return missingOriginal('wc'); }
			const from = await filesFrom(ctx, 'wc', args0);
			if ('result' in from) { return from.result; }
			const args = from.args;
			const said = (res) => (from.stderr || from.failed ? Object.assign({}, res, { stderr: from.stderr + res.stderr, exitCode: res.exitCode || 1 }) : res);
			const r = await ctx.origCommand(args);
			if (r.exitCode !== 0 || !r.stdout) { return said(r); }
			const operands = args.filter((a) => a === '-' || !a.startsWith('-'));
			// names read from a list were not looked at before the counts, and the width is the least one
			let size = 0;
			let known = operands.length > 0;
			for (const f of from.args === args0 ? operands : []) {
				// (a file that holds standard input is not a file: the width is the one GNU gives to an input of no known size)
				if (f.startsWith('/tmp/.lc-stdin-')) { known = false; continue; }
				try {
					const st = await ctx.fs.stat(abs(ctx, f));
					if (st.isFile) { size += st.size; }
				} catch { known = false; }
			}
			return said(Object.assign({}, r, { stdout: wcWidth(r.stdout, operands.length, known || from.args !== args0 ? size : null) }));
		}),
		...['paste', 'comm', 'join'].map((name) => define(name, async (args, ctx) => {
			if (!ctx.origCommand) { return missingOriginal(name); }
			const zp = zero.plan(name, args, OPTION_VALUES[name]);
			if (zp.zero) { return zeroRun(ctx, name, zp); }
			return ctx.origCommand(name === 'paste' ? normalisePaste(args) : args);
		})),
		define('sort', async (args0, ctx) => {
			if (!ctx.origCommand) { return missingOriginal('sort'); }
			const from = await filesFrom(ctx, 'sort', args0);
			if ('result' in from) { return from.result; }
			const said = (res) => (from.stderr ? Object.assign({}, res, { stderr: from.stderr + res.stderr, exitCode: res.exitCode || 2 }) : res);
			const zp = zero.plan('sort', from.args, OPTION_VALUES.sort);
			if (zp.zero) { return said(await zeroRun(ctx, 'sort', zp)); }
			// -C is -c that says nothing (the engine has no -C): the status is the answer
			let quiet = false;
			const args = from.args.map((a) => {
				if (a === '--check=quiet' || a === '--check=silent') { quiet = true; return '-c'; }
				if (/^-[A-Za-z]*C[A-Za-z]*$/.test(a)) { quiet = true; return a.replace('C', 'c'); }
				return a;
			});
			// a key that is not F[.C][OPTS][,F[.C][OPTS]] is an error (the engine dropped it without a word), and the ones
			// that are valid reach it in one spelling
			const keyed = sortKeys(normaliseSort(args));
			if ('error' in keyed) { return said({ stdout: '', stderr: `sort: ${keyed.error}\n`, exitCode: 2 }); }
			let norm = keyed.args;
			let output = null;
			for (let i = 0; i < norm.length - 1 && norm[i] !== '--'; i++) {
				if (norm[i] === '-o') { output = norm[i + 1]; }
			}
			// the engine reads no `--`: what follows is operands, a name that starts with a dash made safe
			const dd = norm.indexOf('--');
			if (dd >= 0) { norm = [...norm.slice(0, dd), ...norm.slice(dd + 1).map((f) => (f !== '-' && f.startsWith('-') ? './' + f : f))]; }
			try {
				const r = await ctx.origCommand(norm);
				return said(quiet ? Object.assign({}, r, { stderr: '' }) : r);
			} catch (e) {
				// the output file that cannot be written: the engine lets the error out (it printed "sort: ENOENT: ..." and
				// 1); GNU says it in its own words and the status is 2
				const why = e && output !== null ? { ENOENT: 'No such file or directory', EISDIR: 'Is a directory', ENOTDIR: 'Not a directory', EACCES: 'Permission denied', EPERM: 'Operation not permitted' }[String(e.code)] : undefined;
				if (!why) { throw e; }
				return said({ stdout: '', stderr: `sort: open failed: ${output}: ${why}\n`, exitCode: 2 });
			}
		}),
		define('tail', async (args, ctx) => {
			if (!ctx.origCommand) { return missingOriginal('tail'); }
			// the old form `tail +N [FILE]` (`+Nc` bytes, `+Nb` blocks of 512): GNU reads it only as the first argument of a
			// line that has no more than one more
			if (args.length >= 1 && args.length <= 2) {
				const old = /^\+(\d+)([bcl]?)$/.exec(args[0]);
				if (old) { args = old[2] === 'c' ? ['-c', '+' + old[1], ...args.slice(1)] : old[2] === 'b' ? ['-c', '+' + Number(old[1]) * 512, ...args.slice(1)] : ['-n', '+' + old[1], ...args.slice(1)]; }
			}
			const zp = zero.plan('tail', args, OPTION_VALUES.tail);
			if (zp.zero) { return zeroRun(ctx, 'tail', zp); }
			// `tail -n -3` and `tail -c -2` are `-n 3` and `-c 2` (the minus is only a sign that head uses)
			const norm = normaliseCounts(args).map((a, i, all) => {
				const valued = i > 0 && (all[i - 1] === '-n' || all[i - 1] === '-c' || all[i - 1] === '--lines' || all[i - 1] === '--bytes');
				if (valued && /^-\d+$/.test(a)) { return a.slice(1); }
				const attached = /^(-[nc]|--lines=|--bytes=)-(\d+)$/.exec(a);
				return attached ? attached[1] + attached[2] : a;
			});
			const from = parseTailFrom(norm);
			if (!from) { return cannotOpen(await ctx.origCommand(shortCounts(norm)), 'tail'); }
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
		define('head', async (args, ctx) => {
			if (!ctx.origCommand) { return missingOriginal('head'); }
			// -z in a cluster (`-zc3`, `-nz`) is -z and the rest: parseHeadNegative reads it alone
			const zp = zero.plan('head', args, OPTION_VALUES.head);
			if (zp.zero) { args = [...zp.args, '-z']; }
			args = shortCounts(normaliseCounts(args));
			const neg = parseHeadNegative(args);
			if (!neg) { return cannotOpen(await ctx.origCommand(args), 'head'); }
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
		define('stat', async (args, ctx) => {
			if (!ctx.origCommand) { return missingOriginal('stat'); }
			const p = parseStat(args);
			// (the engine knows -c only: `--format=%F` is `-c %F`)
			if (p.format === null || !/%[YyXxZzWw%]/.test(p.format) || !p.files.length) { return ctx.origCommand(p.format === null ? args : [...p.other, '-c', p.format, ...p.files]); }
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
		define('awk', async (args, ctx) => {
			if (!ctx.origCommand) { return missingOriginal('awk'); }
			// what the engine's awk does not do: -f PROGFILE (it takes the program as text only), `-v VAR=value` for a special
			// variable (FS, OFS, RS ... are ignored) or with escapes in the value (`\t` stays two characters), and `var=value`
			// among the operands (`awk '{...}' FS=, file`), which GNU makes when it gets to it
			/** @type {string[]} */
			const opts = [];
			/** @type {string[]} */
			const assigns = [];
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
				if (a === '-v' || a === '--assign') { assigns.push(String(args[++i])); continue; }
				if (a.startsWith('--assign=')) { assigns.push(a.slice(9)); continue; }
				if (/^-v.+/.test(a) && !a.startsWith('--')) { assigns.push(a.slice(2)); continue; }
				if (a === '-F' || a === '--field-separator') { opts.push(a, args[++i]); continue; }
				if (a.startsWith('-') && a !== '-') { opts.push(a); continue; }
				operands.push(a);
			}
			const name = /^[A-Za-z_][A-Za-z0-9_]*=/s;
			const first = progs.length ? 0 : 1;
			const special = new Set(['FS', 'OFS', 'RS', 'ORS', 'SUBSEP', 'CONVFMT', 'OFMT', 'NF', 'NR', 'FNR', 'RSTART', 'RLENGTH']);
			const hasOperandAssign = operands.slice(first).some((o) => name.test(o));
			const needsRewrite = hasOperandAssign || assigns.some((x) => special.has(x.slice(0, x.indexOf('='))) || /\\/.test(x)) || operands.slice(first).includes('-');
			const read = async () => {
				let text = '';
				for (const f of progs) {
					try { text += decodeBytes(await readBytes(ctx)(f)) + '\n'; } catch { return { error: { stdout: '', stderr: `awk: fatal: can't open source file \`${f}' for reading: No such file or directory\n`, exitCode: 2 } }; }
				}
				return { text };
			};
			if (!needsRewrite) {
				// (the attached `-vNAME=VALUE` is an assignment as well: the engine took it for an option it does not know)
				if (!progs.length) { return withoutDoubledPrefix(await ctx.origCommand(assigns.length || args.some((x) => x === '--') ? [...opts, ...assigns.flatMap((x) => ['-v', x]), ...operands] : args), 'awk'); }
				const prog = await read();
				if ('error' in prog) { return prog.error; }
				return withoutDoubledPrefix(await ctx.origCommand([...opts, ...assigns.flatMap((x) => ['-v', x]), prog.text, ...operands]), 'awk');
			}
			/** a command-line value as awk reads it: its escapes are processed, and a number stays a number */
			const literal = (v) => {
				const raw = v.replace(/\\(?:([\\"/abfnrtv])|([0-7]{1,3}))/g, (_m, c, o) => (o !== undefined ? String.fromCharCode(parseInt(o, 8)) : { a: '\x07', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v' }[c] || c));
				if (/^[ \t]*[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?[ \t]*$/.test(raw)) { return raw.trim(); }
				return '"' + raw.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\t/g, '\\t').replace(/\r/g, '\\r') + '"';
			};
			const setter = (x) => { const eq = x.indexOf('='); return `${x.slice(0, eq)}=${literal(x.slice(eq + 1))}`; };
			const keep = [];
			const before = [];
			for (const x of assigns) {
				const nm = x.slice(0, x.indexOf('='));
				if (special.has(nm) || /\\/.test(x)) { before.push(setter(x)); } else { keep.push('-v', x); }
			}
			const files = [];
			const rules = [];
			const after = [];
			let pending = [];
			// a file named twice is two files: the assignments before the second one are for the second reading of it, so the
			// rules count how often each name was opened (the name alone would fire them at the first). The rule runs with the
			// first record read: a new FS splits that one again (`$0=$0`), as GNU's assignment came before it was read
			const named = operands.slice(first).filter((o) => !name.test(o));
			const opened = new Map();
			for (const o of operands.slice(first)) {
				if (name.test(o)) {
					if (!files.length) { after.push(setter(o)); } else { pending.push(setter(o)); }
					continue;
				}
				const nth = (opened.get(o) || 0) + 1;
				opened.set(o, nth);
				if (pending.length) {
					const again = named.filter((x) => x === o).length > 1;
					rules.push(`FNR==1&&FILENAME=="${o.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"${again ? `&&__lcn[FILENAME]==${nth}` : ''}{${pending.join(';')}${pending.some((x) => /^FS=/.test(x)) ? ';$0=$0' : ''}}`);
					pending = [];
				}
				files.push(o);
			}
			if (pending.length) { rules.push(`END{${pending.join(';')}}`); }
			if (rules.some((r) => r.includes('__lcn[FILENAME]'))) { rules.unshift('FNR==1{__lcn[FILENAME]++}'); }
			// a lone `-` is standard input, which is what no file is
			const operandsOut = files.length === 1 && files[0] === '-' ? [] : files;
			let text;
			if (progs.length) {
				const prog = await read();
				if ('error' in prog) { return prog.error; }
				text = prog.text;
			} else {
				text = operands[0];
			}
			// the -v assignments of special variables come before BEGIN, the operand ones after the BEGINs there are
			const program = (before.length ? `BEGIN{${before.join(';')}}\n` : '') + (rules.length ? rules.join('\n') + '\n' : '') + text + (after.length ? `\nBEGIN{${after.join(';')}}` : '');
			return withoutDoubledPrefix(await ctx.origCommand([...opts, ...keep, program, ...operandsOut]), 'awk');
		}),
		define('date', async (args, ctx) => {
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
			// a cluster of letters with a -d in it is the letters and the -d (`-ud STRING`, `-dnow`), which the engine's own
			// option reader does not take apart; the letters that take a value (f r s, and I's format) own the rest
			const flat = [];
			for (const a of out) {
				const m = /^-([A-Za-z]*)d([^]*)$/.exec(a);
				if (!m || a.length < 3 || /[frsI]/.test(m[1])) { flat.push(a); continue; }
				for (const letter of m[1]) { flat.push('-' + letter); }
				flat.push('-d');
				if (m[2] !== '') { flat.push(m[2]); }
			}
			out.length = 0;
			out.push(...flat);
			// -d STRING: the forms of GNU's date parser the engine does not read (a relative one, a date and a relative
			// part, YYYYMMDD, a time alone, a fraction of a second) are read here and handed over as the instant they are
			let nanos = 0;
			const utc = out.some((x) => x === '-u' || x === '--utc' || x === '--universal');
			for (let i = 0; i < out.length; i++) {
				const a = out[i];
				let at = -1;
				let text;
				if (a === '-d' || a === '--date') { at = i + 1; text = out[at]; } else if (a.startsWith('--date=')) { at = i; text = a.slice(7); }
				if (at < 0 || text === undefined) { continue; }
				const give = (seconds) => { if (at === i + 1) { out[at] = '@' + seconds; } else { out[i] = '--date=@' + seconds; } };
				// GNU takes blanks and a plus after the `@` (`@ 5`, `@+5`); the engine's date wants `@5`
				const blanks = /^\s*@\s*([+-]?)\s*(\d+(?:[.,]\d+)?)\s*$/.exec(text);
				if (blanks && blanks[0].trim() !== '@' + (blanks[1] === '-' ? '-' : '') + blanks[2]) {
					text = '@' + (blanks[1] === '-' ? '-' : '') + blanks[2];
					if (at === i + 1) { out[at] = text; } else { out[i] = '--date=' + text; }
				}
				const frac = /^\s*@(-?)(\d+)[.,](\d+)\s*$/.exec(text);
				if (frac) {
					// `@1.5`: seconds and a fraction; before the epoch the fraction counts back
					const f = Number((frac[3] + '000000000').slice(0, 9));
					const whole = Number(frac[2]);
					if (frac[1] === '-' && f > 0) { give(-whole - 1); nanos = 1e9 - f; } else { give(frac[1] === '-' ? -whole : whole); nanos = f; }
					continue;
				}
				if (text.startsWith('@')) { continue; }
				const r = datestr.parse(text, Date.now(), utc ? 'UTC' : zone.getZone());
				if (r === null) { continue; }
				// a count that takes the date out of the range of a Date is no date (it was printed as `@NaN`)
				if ('invalid' in r || !Number.isFinite(r.ms) || Math.abs(r.ms) > 8.64e15) { return { stdout: '', stderr: `date: invalid date '${gnuQuote(text)}'\n`, exitCode: 1 }; }
				nanos = r.nanos;
				give(Math.floor(r.ms / 1000));
			}
			// %N and %3N, %6N: the engine knows no fraction of a second, so it is written into the format here
			if (nanos) {
				for (let i = 0; i < out.length; i++) {
					if (!out[i].startsWith('+')) { continue; }
					out[i] = out[i].replace(/%%|%(\d*)N/g, (m, w) => (m === '%%' ? m : String(nanos).padStart(9, '0').slice(0, w ? Math.min(Number(w), 9) : 9)));
				}
			}
			return ctx.origCommand(out);
		}),
		define('seq', async (args, ctx) => {
			if (!ctx.origCommand) { return missingOriginal('seq'); }
			return seqFormatted(args) || ctx.origCommand(args);
		}),
		define('od', async (args, ctx) => od(args, async () => ctx.stdin || '', readBytes(ctx))),
		define('realpath', async (args, ctx) => realpath(args, { cwd: ctx.cwd, resolve: (b, p) => ctx.fs.resolvePath(b, p), exists: (p) => ctx.fs.exists(p) })),
		define('uname', async (args, ctx) => uname(args, (ctx.env && (ctx.env.get ? ctx.env.get('HOSTNAME') : ctx.env.HOSTNAME)) || 'localhost')),
		define('id', async (args) => id(args)),
		define('nproc', async (args) => {
			for (const a of args) { if (a !== '--all' && !a.startsWith('--ignore')) { return { stdout: '', stderr: `nproc: invalid option -- '${a.replace(/^-+/, '')}'\n`, exitCode: 1 }; } }
			return { stdout: '1\n', stderr: '', exitCode: 0 };
		}),
		...THIN.map((name) => define(name, async (args, ctx) => {
			if (!ctx.origCommand) { return missingOriginal(name); }
			if (name !== 'tac') { return ctx.origCommand(args); }
			// the engine's tac reads the first file only and takes no option: GNU's is here (records end in the separator, or
			// start with it under -b; -r reads the separator as a regular expression)
			let before = false;
			let regex = false;
			let sep = '\n';
			/** @type {string[]} */
			const files = [];
			let ended = false;
			const bad = (m) => ({ stdout: '', stderr: m + "Try 'tac --help' for more information.\n", exitCode: 1 });
			for (let i = 0; i < args.length; i++) {
				const a = args[i];
				if (ended || a === '-' || !a.startsWith('-')) { files.push(a); continue; }
				if (a === '--') { ended = true; continue; }
				if (a.startsWith('--')) {
					const eq = a.indexOf('=');
					const long = eq < 0 ? a : a.slice(0, eq);
					const names = ['--before', '--regex', '--separator', '--help', '--version'].filter((n) => n.startsWith(long));
					if (names.length !== 1 || long.length < 3) { return ctx.origCommand(args); }
					if (names[0] === '--help' || names[0] === '--version') { return ctx.origCommand(args); }
					if (names[0] === '--before' || names[0] === '--regex') {
						if (eq >= 0) { return bad(`tac: option '${names[0]}' doesn't allow an argument\n`); }
						if (names[0] === '--before') { before = true; } else { regex = true; }
						continue;
					}
					if (eq >= 0) { sep = a.slice(eq + 1); } else if (i + 1 < args.length) { sep = args[++i]; } else { return bad("tac: option '--separator' requires an argument\n"); }
					continue;
				}
				for (let c = 1; c < a.length; c++) {
					const ch = a[c];
					if (ch === 'b') { before = true; } else if (ch === 'r') { regex = true; } else if (ch === 's') {
						if (c + 1 < a.length) { sep = a.slice(c + 1); } else if (i + 1 < args.length) { sep = args[++i]; } else { return bad("tac: option requires an argument -- 's'\n"); }
						break;
					} else { return bad(`tac: invalid option -- '${ch}'\n`); }
				}
			}
			// (an empty separator is a NUL)
			if (sep === '') { sep = '\0'; }
			let re = null;
			if (regex) {
				try { re = new RegExp(sep, 'g'); } catch { return { stdout: '', stderr: 'tac: invalid regular expression\n', exitCode: 1 }; }
			}
			const sepText = latin1(encodeText(sep));
			/** the records of a byte string, each with its separator (after it, or before it under -b), in order */
			const records = (text) => {
				const cuts = [];
				if (re) {
					re.lastIndex = 0;
					for (let m = re.exec(text); m; m = re.exec(text)) {
						if (m[0] === '') { re.lastIndex++; continue; }
						cuts.push([m.index, m[0].length]);
					}
				} else {
					for (let k = text.indexOf(sepText); k >= 0; k = text.indexOf(sepText, k + sepText.length)) { cuts.push([k, sepText.length]); }
				}
				const out = [];
				let from = 0;
				for (const [at, len] of cuts) {
					if (before) { if (at > from || out.length === 0) { out.push(text.slice(from, at)); } from = at; } else { out.push(text.slice(from, at + len)); from = at + len; }
				}
				if (from < text.length) { out.push(text.slice(from)); }
				return out;
			};
			let stdout = '';
			let stderr = '';
			let exitCode = 0;
			const inputs = files.length ? files : ['-'];
			for (const f of inputs) {
				let bytes;
				if (f === '-') { bytes = stdinBytes(ctx.stdin); } else {
					try { bytes = await readBytes(ctx)(f); } catch (e) {
						stderr += /EISDIR/.test(String(e && e.code)) ? `tac: ${f}: read error: Invalid argument\n` : `tac: failed to open '${f}' for reading: No such file or directory\n`;
						exitCode = 1;
						continue;
					}
				}
				stdout += records(latin1(bytes)).reverse().join('');
			}
			return { stdout, stderr, exitCode, stdoutEncoding: 'binary' };
		})),
		define('cmp', async (args, ctx) => cmp(args, async (p) => {
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
	xargsPlan,
	utf8Length,
	missingOptionValue,
	splitClusters,
	endOptions,
	operandIndexes,
	OPTION_VALUES,
	xargsQuote,
	normaliseGrep,
	normaliseCp,
	normaliseMv,
	wantsNoTargetDirectory,
	wantsForce,
	normaliseRm,
	normaliseMkdir,
	normaliseSed,
	normalisePaste,
	normaliseSort,
	parseSortKey,
	sortKeys,
	seqFormatted,
	versionCompare,
	lsOptions,
	grepDirectories,
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
	verboseAsTyped,
	/** names `commands()` shadows to normalise their arguments or fill in what the engine lacks */
	WRAPPED: ['xargs', 'grep', 'egrep', 'fgrep', 'rm', 'cp', 'mv', 'mkdir', 'sed', 'paste', 'head', 'stat', 'awk', 'date', 'uniq', 'wc', 'touch', 'tr', 'ls', 'tail', 'sort', 'du', 'cut', 'comm', 'join', 'basename', 'dirname', 'readlink', 'printenv', 'diff', 'seq', ...THIN],
};
