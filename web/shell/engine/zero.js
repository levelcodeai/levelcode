// Records that end in NUL: `sort -z`, `uniq -z`, `cut -z`, `tail -z`, `sed -z`, `grep -z`, and `grep -Z` (the engine's
// programs know none of them: they are "invalid option" there, which is honest, and a find -print0 | sort -z |
// xargs -0 pipeline was broken at its second step).
//
// The engine's programs split on the newline, so the records are given to them with the two exchanged: NUL becomes the
// newline (the engine's record separator), and a real newline becomes a placeholder character that is not in the data
// (an unused control character that sorts where the newline does, if there is room for one between the characters that
// are there, else a private-use one). What comes out is exchanged back. For a program that has no other idea of a
// newline (sort, uniq, cut, tail, grep, a sed script of s, y, d, p, n, N, G, H, x ...) this is exact; the commands of
// sed that write a newline of their own (a i c l r R w W F) and the M flag of a regular expression are refused, because
// the exchange would make them wrong. A file operand is given as a copy with the records exchanged (under /tmp, removed
// after), so that the program's own multi-file behaviour (names, -s) is its own; a file that cannot be read is left
// as it was typed, and the program says what is wrong with it.
//
// Nothing here knows the engine; `run` is given what it needs.
'use strict';
// @ts-check

/** What each program calls "records end in NUL" (short letters, long names). */
const ZERO_OPTIONS = {
	sort: { short: 'z', long: ['--zero-terminated'] },
	uniq: { short: 'z', long: ['--zero-terminated'] },
	cut: { short: 'z', long: ['--zero-terminated'] },
	tail: { short: 'z', long: ['--zero-terminated'] },
	head: { short: 'z', long: ['--zero-terminated'] },
	// programs whose output is a name or a value for each operand: the terminator is the only thing -z changes
	basename: { short: 'z', long: ['--zero'] },
	dirname: { short: 'z', long: ['--zero'] },
	readlink: { short: 'z', long: ['--zero'] },
	printenv: { short: '0', long: ['--null'] },
	paste: { short: 'z', long: ['--zero-terminated'] },
	comm: { short: 'z', long: ['--zero-terminated'] },
	join: { short: 'z', long: ['--zero-terminated'] },
	sed: { short: 'z', long: ['--null-data', '--zero-terminated'] },
	grep: { short: 'z', long: ['--null-data'] },
};
ZERO_OPTIONS.egrep = ZERO_OPTIONS.grep;
ZERO_OPTIONS.fgrep = ZERO_OPTIONS.grep;

/**
 * Takes the options that mean NUL out of an argument list and says where the operands are. A valued option is always
 * the option and then its value as two arguments (`-k2` is `-k`, `2`), so that the value has an index.
 *
 * @param {string} program
 * @param {string[]} argv
 * @param {{ short: string, long: string[], optional?: string } | undefined} table the program's options that need a value
 * @returns {{ zero: boolean, nul: boolean, args: string[], files: number[], scripts: number[], scriptFiles: number[], outputAt: number, suffix: string | null, inPlace: boolean, separate: boolean }}
 *   `files` are the indexes (in `args`, which has none of those options) of the operands that are input files, `-`
 *   included; for sed `scripts` are the indexes of script text and `scriptFiles` of the names of script files; for sort
 *   `outputAt` is the index of the name `-o` was given (-1 when it was not); `suffix` is that of sed's `-i`
 */
function plan(program, argv, table) {
	const zo = ZERO_OPTIONS[program];
	const t = table || { short: '', long: [] };
	const isGrep = program === 'grep' || program === 'egrep' || program === 'fgrep';
	const isSed = program === 'sed';
	/** @type {string[]} */
	const args = [];
	/** @type {number[]} */
	const operands = [];
	/** @type {number[]} */
	const scripts = [];
	/** @type {number[]} */
	const scriptFiles = [];
	let zero = false;
	let nul = false;
	let patternGiven = false;
	let inPlace = false;
	let separate = false;
	let suffix = /** @type {string | null} */ (null);
	let outputAt = -1;
	let afterDashes = false;
	/** a valued option's value, noted where it matters */
	const noteValue = (name, at) => {
		if (isGrep && (name === 'e' || name === 'f' || name === 'regexp' || name === 'file')) { patternGiven = true; }
		if (isSed && (name === 'e' || name === 'expression')) { patternGiven = true; scripts.push(at); }
		if (isSed && (name === 'f' || name === 'file')) { patternGiven = true; scriptFiles.push(at); }
		if (program === 'sort' && (name === 'o' || name === 'output')) { outputAt = at; }
	};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (afterDashes || a === '-' || !a.startsWith('-')) { operands.push(args.length); args.push(a); continue; }
		if (a === '--') { afterDashes = true; args.push(a); continue; }
		if (a.startsWith('--')) {
			const eq = a.indexOf('=');
			const name = eq < 0 ? a : a.slice(0, eq);
			if (zo && zo.long.includes(name) && eq < 0) { zero = true; continue; }
			if (isGrep && name === '--null' && eq < 0) { nul = true; continue; }
			if (isSed && name === '--separate' && eq < 0) { separate = true; continue; }
			if (isSed && name === '--in-place') { inPlace = true; suffix = eq >= 0 ? a.slice(eq + 1) : null; args.push('--in-place'); continue; }
			if (t.long.includes(name)) {
				const value = eq >= 0 ? a.slice(eq + 1) : argv[++i];
				args.push(name);
				if (value !== undefined) {
					noteValue(name.slice(2), args.length);
					args.push(value);
				}
				continue;
			}
			args.push(a);
			continue;
		}
		// a cluster of short options: the letters that mean NUL are taken out, the first valued letter takes the rest
		let kept = '-';
		for (let c = 1; c < a.length; c++) {
			const ch = a[c];
			if (zo && ch === zo.short) { zero = true; continue; }
			if (isGrep && ch === 'Z') { nul = true; continue; }
			if (isSed && ch === 's') { separate = true; continue; }
			if (isSed && ch === 'i') {
				inPlace = true;
				suffix = a.slice(c + 1) || null;
				kept += 'i';
				break;
			}
			if (t.short.includes(ch)) {
				const rest = a.slice(c + 1);
				const value = rest !== '' ? rest : argv[++i];
				if (kept !== '-') { args.push(kept); }
				args.push('-' + ch);
				if (value !== undefined) {
					noteValue(ch, args.length);
					args.push(value);
				}
				kept = '';
				break;
			}
			if (t.optional && t.optional.includes(ch)) { kept += a.slice(c); break; }
			kept += ch;
		}
		if (kept !== '-' && kept !== '') { args.push(kept); }
	}
	let files = operands;
	if ((isGrep || isSed) && !patternGiven && operands.length) {
		if (isSed) { scripts.push(operands[0]); }
		files = operands.slice(1);
	}
	return { zero, nul, args, files, scripts, scriptFiles, outputAt, suffix, inPlace, separate };
}

/** Is this a character the text may not have for the placeholder (it is in the data, or it is in the way)? */
function pickPlaceholder(texts) {
	const present = new Set();
	for (const t of texts) { for (const ch of t) { present.add(ch.codePointAt(0)); } }
	// where the newline sorts among the characters that are there: below the least one above it, above the greatest below
	let below = 0;
	let above = Infinity;
	for (const c of present) {
		if (c === 10 || c === 0) { continue; }
		if (c < 10 && c > below) { below = c; }
		if (c > 10 && c < above) { above = c; }
	}
	for (let c = 11; c < above && c < 32; c++) { if (!present.has(c)) { return String.fromCharCode(c); } }
	for (let c = below + 1; c < 10; c++) { if (!present.has(c)) { return String.fromCharCode(c); } }
	// no room: a private-use character (its position among the others is not the newline's, for the data that has one)
	for (let c = 0xe000; c < 0xf8ff; c++) { if (!present.has(c)) { return String.fromCharCode(c); } }
	return '﷐';
}

/** NUL becomes the newline and the newline becomes `x`. */
function swapIn(text, x) { return text.split('\n').join(x).split('\0').join('\n'); }
/** The newline becomes NUL and `x` becomes the newline. */
function swapOut(text, x) { return text.split('\n').join('\0').split(x).join('\n'); }

/**
 * The commands, flags and addresses of a sed script that the exchange of NUL and newline cannot carry: the ones that
 * write a newline of their own (`a i c l r R w W F e`), a `w` flag, and the M flag of a regular expression or an `s`.
 * Anything it cannot read is left to the engine.
 *
 * @param {string} script
 * @returns {string | null} what is not allowed (`the a command`), or null
 */
function sedZeroRefusal(script) {
	const n = script.length;
	let i = 0;
	const digit = (k) => k < n && script[k] >= '0' && script[k] <= '9';
	/** the end of a delimited section starting after the delimiter at i (`s/RE/`): the index after the closing one */
	const section = (k, d) => {
		let inBracket = false;
		while (k < n) {
			const c = script[k];
			if (c === '\\') { k += 2; continue; }
			if (!inBracket && c === '[') { inBracket = true; k++; if (script[k] === '^') { k++; } if (script[k] === ']') { k++; } continue; }
			if (inBracket) { if (c === ']') { inBracket = false; } k++; continue; }
			if (c === d) { return k + 1; }
			k++;
		}
		return k;
	};
	while (i < n) {
		const ch = script[i];
		if (' \t\n;{}!'.includes(ch)) { i++; continue; }
		if (ch === '#') { while (i < n && script[i] !== '\n') { i++; } continue; }
		// an address, or two
		for (let part = 0; part < 2; part++) {
			if (script[i] === '$') { i++; } else if (digit(i) || script[i] === '+' || script[i] === '~') {
				i++;
				while (digit(i)) { i++; }
				if (script[i] === '~' && digit(i + 1)) { i++; while (digit(i)) { i++; } }
			} else if (script[i] === '/' || (script[i] === '\\' && i + 1 < n && script[i + 1] !== '\n')) {
				const d = script[i] === '/' ? '/' : script[i + 1];
				i = section(i + (script[i] === '/' ? 1 : 2), d);
				while (script[i] === 'I' || script[i] === 'M') {
					if (script[i] === 'M') { return 'the M flag of an address'; }
					i++;
				}
			}
			while (script[i] === ' ' || script[i] === '\t') { i++; }
			if (part === 0 && script[i] === ',') { i++; while (script[i] === ' ' || script[i] === '\t') { i++; } } else { break; }
		}
		while (script[i] === ' ' || script[i] === '\t' || script[i] === '!') { i++; }
		const cmd = script[i];
		if (cmd === undefined) { break; }
		i++;
		if ('aicrRwWFe'.includes(cmd)) { return `the ${cmd} command`; }
		if (cmd === 'l') { return 'the l command'; }
		if (cmd === 's' || cmd === 'y') {
			const d = script[i];
			if (d === undefined || d === '\n' || d === '\\') { break; }
			i = section(section(i + 1, d), d);
			if (cmd === 's') {
				while (i < n && !';\n}#'.includes(script[i])) {
					if (script[i] === 'M' || script[i] === 'm') { return 'the M flag of the s command'; }
					if (script[i] === 'w') { return 'the w flag of the s command'; }
					if (script[i] === 'e') { return 'the e flag of the s command'; }
					i++;
				}
			}
			continue;
		}
		if (cmd === ':' || cmd === 'b' || cmd === 't' || cmd === 'T') {
			while (i < n && script[i] !== ';' && script[i] !== '\n') { i++; }
			continue;
		}
		if (cmd === 'q' || cmd === 'Q' || cmd === 'L') { while (digit(i) || script[i] === ' ') { i++; } }
	}
	return null;
}

/**
 * A sed script as the exchanged records need it: a `\n` (a newline in a pattern, a replacement, a set of `y`) is the
 * placeholder, where a backslash before the `n` is not itself escaped. A newline that separates commands is left.
 *
 * @param {string} script
 * @param {string} x
 */
function sedScriptIn(script, x) {
	let out = '';
	for (let i = 0; i < script.length; i++) {
		const c = script[i];
		if (c === '\\' && i + 1 < script.length) {
			const e = script[i + 1];
			// a backslash before a real newline is a newline (the replacement of `s/a/x\<newline>y/`)
			if (e === '\n') { out += x; i++; continue; }
			// `\x00`, `\o0`, `\d0` are the NUL, which here is the newline the engine splits on
			const num = e === 'x' ? /^[0-9a-fA-F]{1,2}/ : e === 'o' ? /^[0-7]{1,3}/ : e === 'd' ? /^[0-9]{1,3}/ : null;
			const m = num && num.exec(script.slice(i + 2));
			if (m && parseInt(m[0], e === 'x' ? 16 : e === 'o' ? 8 : 10) === 0) {
				out += '\\n';
				i += 1 + m[0].length;
				continue;
			}
			out += e === 'n' ? x : c + e;
			i++;
			continue;
		}
		out += c;
	}
	return out;
}

/**
 * How a grep line asks for its output (`-l`, `-L`, `-c`, `-q`: names, counts or nothing, not lines; `-n`; context lines
 * with `-A -B -C -NUM`), from the arguments `plan` returns.
 *
 * @param {string[]} args
 * @returns {{ names: boolean, count: boolean, quiet: boolean, lineNumber: boolean, context: boolean }}
 */
function grepOutputKind(args) {
	let names = false;
	let count = false;
	let quiet = false;
	let lineNumber = false;
	let context = false;
	const valuedShort = 'efmABCdD';
	const valuedLong = ['--regexp', '--file', '--max-count', '--after-context', '--before-context', '--context', '--include', '--exclude', '--exclude-dir', '--exclude-from', '--directories', '--devices', '--label', '--binary-files', '--group-separator'];
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (a === '--') { break; }
		if (a === '-' || !a.startsWith('-')) { continue; }
		if (a.startsWith('--')) {
			const name = a.split('=')[0];
			if (name === '--files-with-matches' || name === '--files-without-match') { names = true; }
			if (name === '--count') { count = true; }
			if (name === '--quiet' || name === '--silent') { quiet = true; }
			if (name === '--line-number') { lineNumber = true; }
			if (name === '--after-context' || name === '--before-context' || name === '--context') { context = true; }
			if (valuedLong.includes(name) && !a.includes('=')) { i++; }
			continue;
		}
		for (let c = 1; c < a.length; c++) {
			const ch = a[c];
			if (valuedShort.includes(ch)) {
				if ('ABC'.includes(ch)) { context = true; }
				if (c === a.length - 1) { i++; }
				break;
			}
			if (ch === 'l' || ch === 'L') { names = true; }
			if (ch === 'c') { count = true; }
			if (ch === 'q') { quiet = true; }
			if (ch === 'n') { lineNumber = true; }
			// -NUM is -C NUM
			if (ch >= '0' && ch <= '9') { context = true; }
		}
	}
	return { names, count, quiet, lineNumber, context };
}

/** The options of tail that take a value (`plan` gives each as the option and its value, two arguments). */
const TAIL_VALUED = new Set(['-n', '-c', '-s', '--lines', '--bytes', '--sleep-interval', '--pid', '--max-unchanged-stats']);

/**
 * Whether `tail` prints a `==> NAME <==` header for each file: `-q` never, `-v` always (the last of them decides),
 * otherwise when there are several files.
 *
 * @param {string[]} args the ones `plan` returns
 * @param {number} files how many files there are
 * @returns {boolean}
 */
function tailHeaders(args, files) {
	let mode = 'multiple';
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (a === '--') { break; }
		if (a === '--quiet' || a === '--silent') { mode = 'never'; continue; }
		if (a === '--verbose') { mode = 'always'; continue; }
		if (TAIL_VALUED.has(a)) { i++; continue; }
		if (a.startsWith('--') || !a.startsWith('-') || a === '-') { continue; }
		for (const ch of a.slice(1)) {
			if (ch === 'q') { mode = 'never'; } else if (ch === 'v') { mode = 'always'; }
		}
	}
	return mode === 'always' || (mode === 'multiple' && files > 1);
}

/**
 * The arguments with the options that ask for headers taken out (what is left is for one file at a time).
 *
 * @param {string[]} args the ones `plan` returns
 * @returns {string[]}
 */
function withoutHeaderOptions(args) {
	const out = [];
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (a === '--') { out.push(...args.slice(i)); break; }
		if (a === '--quiet' || a === '--silent' || a === '--verbose') { continue; }
		if (TAIL_VALUED.has(a)) { out.push(a, args[++i]); continue; }
		if (a.startsWith('--') || !a.startsWith('-') || a === '-') { out.push(a); continue; }
		const kept = a.slice(1).replace(/[qv]/g, '');
		if (kept !== '') { out.push('-' + kept); }
	}
	return out;
}

module.exports = { ZERO_OPTIONS, plan, pickPlaceholder, swapIn, swapOut, sedZeroRefusal, sedScriptIn, grepOutputKind, tailHeaders, withoutHeaderOptions };
