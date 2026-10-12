// GNU tr (coreutils 8.32), whole: the engine's own `tr` works on characters, cannot see a NUL in its second set (`tr
// '\n' '\0'` made the digit zero), knows no `\NNN` beyond a few and no `[c*n]`, and took a bad set as a plain one. This
// follows coreutils' tr.c: bytes (never characters: `tr é e` is `ee`), its escapes (`\a \b \f \n \r \t \v \\ \NNN`, and
// any other `\c` is c: GNU's tr has no `\xHH`), `a-z` ranges, `[:class:]`, `[=c=]`, `[c*n]` and `[c*]`, -c -C -d -s -t, the
// long options with their unique abbreviations, and its messages, word for word (straight quotes for GNU's curly ones).
//
// Pure: `run(args, input)` takes the argument list and the standard input as bytes, and returns bytes and the two texts.
'use strict';
// @ts-check

const { encodeText } = require('./text.js');

const N_CHARS = 256;

/** Thrown inside the parser for a message that ends the program: `tr: MESSAGE`, status 1. */
class TrError extends Error {}
const die = (message) => { throw new TrError(message); };

/** What `quote()` writes between its marks for a string: straight quotes here, a backslash and control characters escaped. */
function quote(s) {
	return "'" + String(s).replace(/[\\\u0000-\u001f\u007f]/g, (c) => {
		if (c === '\\') { return '\\\\'; }
		const named = { 7: '\\a', 8: '\\b', 9: '\\t', 10: '\\n', 11: '\\v', 12: '\\f', 13: '\\r' };
		return named[c.charCodeAt(0)] || '\\' + c.charCodeAt(0).toString(8).padStart(3, '0');
	}) + "'";
}

/** The bytes of a string that tr would show as one character: a printable ASCII byte is itself, else `\ooo`. */
function printable(b) {
	return b >= 32 && b < 127 ? String.fromCharCode(b) : '\\' + b.toString(8).padStart(3, '0');
}

/**
 * What tr.c's `make_printable_str` writes for the bytes of an operand in a message: `\a \b \f \n \r \t \v` by name, a
 * printable ASCII byte as itself (a backslash too), anything else `\ooo`. A byte of a multi-byte character is anything
 * else, so `é` is `\303\251`.
 *
 * @param {ArrayLike<number>} bytes
 * @returns {string}
 */
function makePrintable(bytes) {
	const named = { 7: '\\a', 8: '\\b', 9: '\\t', 10: '\\n', 11: '\\v', 12: '\\f', 13: '\\r' };
	let out = '';
	for (let i = 0; i < bytes.length; i++) {
		const b = bytes[i];
		out += named[b] || (b >= 32 && b < 127 ? String.fromCharCode(b) : '\\' + b.toString(8).padStart(3, '0'));
	}
	return out;
}

/** @typedef {{ s: number[], escaped: boolean[] }} EString the bytes of an operand and, for each, whether a backslash made it */

/**
 * An operand as bytes with a backslash taken out, like tr.c's `unquote`: `\a \b \f \n \r \t \v` are control
 * characters, `\` and up to three octal digits (never past `\377`: `\400` is `\40` and `0`, with a warning) a byte, `\\` a
 * backslash, a backslash at the very end stays a backslash (with a warning), and `\` before anything else is that thing.
 *
 * @param {Uint8Array} b
 * @param {string[]} warnings
 * @returns {EString}
 */
function unquote(b, warnings) {
	/** @type {number[]} */
	const s = [];
	/** @type {boolean[]} */
	const escaped = [];
	const named = { 0x61: 7, 0x62: 8, 0x66: 12, 0x6e: 10, 0x72: 13, 0x74: 9, 0x76: 11, 0x5c: 0x5c };
	for (let i = 0; i < b.length; i++) {
		let c = b[i];
		let esc = false;
		if (c === 0x5c) {
			esc = true;
			i++;
			if (i >= b.length) {
				warnings.push('warning: an unescaped backslash at end of string is not portable');
				esc = false;
				c = 0x5c;
			} else if (b[i] >= 0x30 && b[i] <= 0x37) {
				// \N, \NN, \NNN: the third digit only while the byte stays below 256 (else the ambiguity is a warning)
				const first = i;
				c = b[i] - 0x30;
				if (i + 1 < b.length && b[i + 1] >= 0x30 && b[i + 1] <= 0x37) {
					c = c * 8 + (b[i + 1] - 0x30);
					i++;
					if (i + 1 < b.length && b[i + 1] >= 0x30 && b[i + 1] <= 0x37) {
						if (c * 8 + (b[i + 1] - 0x30) < N_CHARS) {
							c = c * 8 + (b[i + 1] - 0x30);
							i++;
						} else {
							const d = (k) => String.fromCharCode(b[k]);
							warnings.push(`warning: the ambiguous octal escape \\${d(first)}${d(first + 1)}${d(first + 2)} is being\n\tinterpreted as the 2-byte sequence \\0${d(first)}${d(first + 1)}, ${d(first + 2)}`);
						}
					}
				}
			} else {
				c = Object.prototype.hasOwnProperty.call(named, b[i]) ? named[b[i]] : b[i];
			}
		}
		s.push(c);
		escaped.push(esc);
	}
	return { s, escaped };
}

/** @type {Record<string, (c: number) => boolean>} the classes of the C locale (bytes 128 and over are in none of them) */
const CLASSES = {
	alnum: (c) => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122),
	alpha: (c) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122),
	blank: (c) => c === 32 || c === 9,
	cntrl: (c) => c < 32 || c === 127,
	digit: (c) => c >= 48 && c <= 57,
	graph: (c) => c > 32 && c < 127,
	lower: (c) => c >= 97 && c <= 122,
	print: (c) => c >= 32 && c < 127,
	punct: (c) => c > 32 && c < 127 && !((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122)),
	space: (c) => c === 32 || (c >= 9 && c <= 13),
	upper: (c) => c >= 65 && c <= 90,
	xdigit: (c) => (c >= 48 && c <= 57) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102),
};

/**
 * @typedef {{ type: 'char', c: number }
 *   | { type: 'range', from: number, to: number }
 *   | { type: 'class', name: string }
 *   | { type: 'equiv', c: number }
 *   | { type: 'repeat', c: number, count: number }} Item
 *   a `repeat` of count 0 is `[c*]` (as many as it takes)
 */

/**
 * A set as tr.c's `build_spec_list` reads it: the four constructs that start with `[`, a range `x-y` (looking one byte
 * ahead; the last two bytes of the string are never the start of a range), and plain bytes.
 *
 * @param {EString} es
 * @returns {Item[]}
 */
function buildSpecList(es) {
	const { s: p, escaped } = es;
	const len = p.length;
	/** @type {Item[]} */
	const out = [];
	const match = (i, c) => i < len && p[i] === c && !escaped[i];
	let i = 0;
	for (; i + 2 < len; i++) {
		if (match(i, 0x5b)) {
			let matched = true;
			if (match(i + 1, 0x3a) || match(i + 1, 0x3d)) {
				// [:class:] and [=c=]: the closing mark is the delimiter and `]`, neither of them escaped
				const delim = p[i + 1];
				let close = -1;
				for (let k = i + 2; k < len - 1; k++) {
					if (p[k] === delim && p[k + 1] === 0x5d && !escaped[k] && !escaped[k + 1]) { close = k; break; }
				}
				if (close >= 0) {
					const operand = p.slice(i + 2, close);
					if (operand.length === 0) { die(delim === 0x3a ? "missing character class name '[::]'" : "missing equivalence class character '[==]'"); }
					if (delim === 0x3a) {
						const name = String.fromCharCode(...operand);
						// The name goes through make_printable_str and then through quote(): a tab is `\\t` there, two backslashes
						if (!Object.prototype.hasOwnProperty.call(CLASSES, name)) { die(`invalid character class ${quote(makePrintable(operand))}`); }
						out.push({ type: 'class', name });
					} else {
						if (operand.length !== 1) { die(`${makePrintable(operand)}: equivalence class operand must be a single character`); }
						out.push({ type: 'equiv', c: operand[0] });
					}
					i = close + 1;
				} else {
					matched = false;
				}
			} else {
				// [c*n] and [c*]: a byte, an unescaped star, then up to the first unescaped `]`
				matched = false;
				if (match(i + 2, 0x2a)) {
					for (let k = i + 3; k < len && !escaped[k]; k++) {
						if (p[k] !== 0x5d) { continue; }
						const digits = p.slice(i + 3, k);
						let count = 0;
						if (digits.length) {
							const text = String.fromCharCode(...digits);
							const octal = digits[0] === 0x30;
							// GNU takes every count below 2^64 - 1 (xstrtoumax says that one is an overflow); one that is larger than
							// the set it is for needs is cut where the set is expanded
							const whole = (octal ? /^[0-7]+$/ : /^[0-9]+$/).test(text) ? BigInt((octal ? '0o' : '') + text) : -1n;
							if (whole < 0n || whole >= 0xffffffffffffffffn) {
								die(`invalid repeat count ${quote(makePrintable(digits))} in [c*n] construct`);
							}
							count = Number(whole);
						}
						out.push({ type: 'repeat', c: p[i + 1], count });
						i = k;
						matched = true;
						break;
					}
				}
			}
			if (matched) { continue; }
		}
		if (match(i + 1, 0x2d)) {
			if (p[i] > p[i + 2]) { die(`range-endpoints of '${printable(p[i])}-${printable(p[i + 2])}' are in reverse collating sequence order`); }
			out.push({ type: 'range', from: p[i], to: p[i + 2] });
			i += 2;
		} else {
			out.push({ type: 'char', c: p[i] });
		}
	}
	for (; i < len; i++) { out.push({ type: 'char', c: p[i] }); }
	return out;
}

/** The bytes of a class, in order. */
function classBytes(name) {
	const out = [];
	for (let c = 0; c < N_CHARS; c++) { if (CLASSES[name](c)) { out.push(c); } }
	return out;
}

/**
 * The statistics `get_spec_stats` keeps: how long the set is, its constructs, what classes it names.
 * @param {Item[]} list
 */
function specStats(list) {
	let length = 0;
	let indefinite = 0;
	let hasClass = false;
	let hasEquiv = false;
	let restricted = false;
	for (const it of list) {
		if (it.type === 'char' || it.type === 'equiv') { length++; hasEquiv = hasEquiv || it.type === 'equiv'; }
		else if (it.type === 'range') { length += it.to - it.from + 1; }
		else if (it.type === 'class') {
			hasClass = true;
			if (it.name !== 'upper' && it.name !== 'lower') { restricted = true; }
			length += classBytes(it.name).length;
		} else if (it.count === 0) { indefinite++; } else { length += it.count; }
	}
	return { length, indefinite, hasClass, hasEquiv, restricted };
}

/**
 * The bytes of a set in order. A `[c*]` takes as many as `total` still needs (what is left of the length of string1).
 * @param {Item[]} list
 * @param {number} total the length the whole list is to have (for the one `[c*]`), or -1
 * @returns {number[]}
 */
function expand(list, total) {
	/** @type {number[]} */
	const out = [];
	const fixed = specStats(list).length;
	for (const it of list) {
		if (it.type === 'char' || it.type === 'equiv') { out.push(it.c); }
		else if (it.type === 'range') { for (let c = it.from; c <= it.to; c++) { out.push(c); } }
		else if (it.type === 'class') { out.push(...classBytes(it.name)); }
		else {
			const n = it.count === 0 ? Math.max(0, total - fixed) : Math.min(it.count, total > 0 ? total : 1 << 20);
			for (let k = 0; k < n; k++) { out.push(it.c); }
		}
	}
	return out;
}

/** Every item of a list is the same single byte (`[x*5]`, `x`, `xx`): what `homogeneous_spec_list` asks. */
function homogeneous(bytes) {
	return bytes.every((c) => c === bytes[0]);
}

/**
 * The case classes of string2 against string1, as tr.c's validate_case_classes has them: a `[:upper:]` or `[:lower:]` in
 * string2 has to start where a case class (`[:upper:]` or `[:lower:]`, the same one or the other) of string1 starts, so
 * that the two are translated against each other 26 bytes to 26 (`[:lower:]` to `[:upper:]`, and also `xyz[:lower:]` to
 * `xyz[:upper:]`). `a-z` to `[:upper:]`, `[:lower:]` to `x[:upper:]` and `[:alpha:]` to `[:lower:]` are the error. The
 * length of string1 is its own, complemented or not; a class of string2 that starts after the end of it is not checked
 * (`abc` to `xyzw[:upper:]` is fine, to `xyz[:upper:]` it is not).
 *
 * @param {Item[]} s1
 * @param {Item[]} s2
 */
function validateCaseClasses(s1, s2) {
	const isCase = (it) => it.type === 'class' && (it.name === 'upper' || it.name === 'lower');
	if (!s2.some(isCase)) { return; }
	/** where each item of string1 starts, for the items that are case classes */
	const starts = new Set();
	let at = 0;
	for (const it of s1) {
		if (isCase(it)) { starts.add(at); }
		at += specStats([it]).length;
	}
	// string1's length is `at` now; a class that starts further on than the end of string1 has nothing to be aligned with
	const length = at;
	at = 0;
	for (const it of s2) {
		if (isCase(it) && at <= length && !starts.has(at)) { die('misaligned [:upper:] and/or [:lower:] construct'); }
		at += specStats([it]).length;
	}
}

/**
 * The places of string1 that are not translated although string2 names a byte for them: where a case class of string1 is
 * paired with the SAME class of string2 (`[:lower:]` to `[:lower:]`), only the first byte of the 26 is set, as GNU does it
 * (`a-z[:lower:]` to `A-Z[:lower:]` leaves `b` as `B` and takes `a` back to `a`). Every other pair is set in order and
 * the last one wins.
 *
 * @param {Item[]} s1
 * @param {Item[]} s2
 * @returns {Set<number>}
 */
function sameClassSkips(s1, s2) {
	/** @type {Map<number, string>} */
	const at1 = new Map();
	let at = 0;
	for (const it of s1) {
		if (it.type === 'class' && (it.name === 'upper' || it.name === 'lower')) { at1.set(at, it.name); }
		at += specStats([it]).length;
	}
	const skip = new Set();
	at = 0;
	for (const it of s2) {
		const n = specStats([it]).length;
		if (it.type === 'class' && at1.get(at) === it.name) { for (let k = 1; k < n; k++) { skip.add(at + k); } }
		at += n;
	}
	return skip;
}

/** The byte string2 is made longer with: the last of its last item (GNU says no when that item is a class). */
function padByte(list) {
	const last = list[list.length - 1];
	if (last.type === 'class') { die('when translating with string1 longer than string2,\nthe latter string must not end with a character class'); }
	return last.type === 'range' ? last.to : /** @type {any} */ (last).c;
}

/**
 * @param {string[]} args the arguments after the program's name
 * @param {Uint8Array} input standard input
 * @returns {{ stdout: Uint8Array, stderr: string, exitCode: number } | { passThrough: true }}
 *   `passThrough` for --help and --version, which the engine's tr answers
 */
function run(args, input) {
	const usageHint = "Try 'tr --help' for more information.\n";
	let complement = false;
	let del = false;
	let squeeze = false;
	let truncate = false;
	/** @type {string[]} */
	const operands = [];
	const longs = ['complement', 'delete', 'squeeze-repeats', 'truncate-set1', 'help', 'version'];
	let i = 0;
	for (; i < args.length; i++) {
		const a = args[i];
		if (a === '--') { i++; break; }
		if (a === '-' || !a.startsWith('-')) { break; }                // `+` in the option string: the first operand ends options
		if (a.startsWith('--')) {
			const eq = a.indexOf('=');
			const name = eq < 0 ? a.slice(2) : a.slice(2, eq);
			const exact = longs.find((l) => l === name);
			const hits = exact ? [exact] : longs.filter((l) => l.startsWith(name));
			if (hits.length === 0) { return { stdout: new Uint8Array(0), stderr: `tr: unrecognized option '${a}'\n${usageHint}`, exitCode: 1 }; }
			if (hits.length > 1) { return { stdout: new Uint8Array(0), stderr: `tr: option '${a}' is ambiguous; possibilities: ${hits.map((h) => "'--" + h + "'").join(' ')}\n${usageHint}`, exitCode: 1 }; }
			if (eq >= 0) { return { stdout: new Uint8Array(0), stderr: `tr: option '--${hits[0]}' doesn't allow an argument\n${usageHint}`, exitCode: 1 }; }
			if (hits[0] === 'help' || hits[0] === 'version') { return { passThrough: true }; }
			if (hits[0] === 'complement') { complement = true; } else if (hits[0] === 'delete') { del = true; } else if (hits[0] === 'squeeze-repeats') { squeeze = true; } else { truncate = true; }
			continue;
		}
		for (let c = 1; c < a.length; c++) {
			const ch = a[c];
			if (ch === 'c' || ch === 'C') { complement = true; } else if (ch === 'd') { del = true; } else if (ch === 's') { squeeze = true; } else if (ch === 't') { truncate = true; } else if (ch !== 'A') {
				// getopt names the BYTE that is no option: the first of a multi-byte character is shown as it is, invalid
				const first = encodeText(String.fromCodePoint(/** @type {number} */ (a.codePointAt(c))))[0];
				const shown = first < 0x80 ? String.fromCharCode(first) : String.fromCharCode(0xdc00 + first);
				return { stdout: new Uint8Array(0), stderr: `tr: invalid option -- '${shown}'\n${usageHint}`, exitCode: 1 };
			}
		}
	}
	operands.push(...args.slice(i));
	const fail = (m) => ({ stdout: new Uint8Array(0), stderr: `tr: ${m}\n`, exitCode: 1 });
	const n = operands.length;
	// tr.c: one operand is enough to delete or to squeeze, two to translate or to do both (min_operands, max_operands)
	const min = 1 + (del === squeeze ? 1 : 0);
	const max = 1 + (Number(del) <= Number(squeeze) ? 1 : 0);
	if (n < min) {
		if (n === 0) { return fail('missing operand\n' + usageHint.slice(0, -1)); }
		return fail(`missing operand after ${quote(operands[n - 1])}\n${squeeze ? 'Two strings must be given when both deleting and squeezing repeats.' : 'Two strings must be given when translating.'}\n${usageHint.slice(0, -1)}`);
	}
	if (n > max) {
		return fail(`extra operand ${quote(operands[max])}\n${n === 2 ? 'Only one string may be given when deleting without squeezing repeats.\n' : ''}${usageHint.slice(0, -1)}`);
	}
	const warnings = [];
	let s1list;
	let s2list = null;
	try {
		s1list = buildSpecList(unquote(encodeText(operands[0]), warnings));
		if (n === 2) { s2list = buildSpecList(unquote(encodeText(operands[1]), warnings)); }
	} catch (e) {
		if (e instanceof TrError) { return { stdout: new Uint8Array(0), stderr: warnings.map((w) => `tr: ${w}\n`).join('') + `tr: ${e.message}\n`, exitCode: 1 }; }
		throw e;
	}
	const translating = n === 2 && !del;
	/** the bytes of string1, in order (duplicates kept) */
	let set1 = [];
	/** the bytes of string2 */
	let set2 = [];
	/** what translating maps FROM: string1, or with -c every byte it does not have, in order */
	let from = [];
	try {
		const st1 = specStats(s1list);
		if (st1.indefinite > 0) { die('the [c*] repeat construct may not appear in string1'); }
		set1 = expand(s1list, -1);
		if (complement) {
			const t = new Uint8Array(N_CHARS);
			for (const c of set1) { t[c] = 1; }
			for (let c = 0; c < N_CHARS; c++) { if (!t[c]) { from.push(c); } }
		} else {
			from = set1;
		}
		if (s2list) {
			const st2 = specStats(s2list);
			if (st2.indefinite > 1) { die('only one [c*] repeat construct may appear in string2'); }
			if (translating) {
				if (st2.hasEquiv) { die('[=c=] expressions may not appear in string2 when translating'); }
				if (st2.restricted) { die("when translating, the only character classes that may appear in\nstring2 are 'upper' and 'lower'"); }
				// the length of string1 is what it translates: its own, or with -c the bytes it leaves out
				validateCaseClasses(s1list, s2list);
				set2 = expand(s2list, from.length);
				if (from.length > set2.length && !truncate) {
					if (set2.length === 0) { die('when not truncating set1, string2 must be non-empty'); }
					const pad = padByte(s2list);
					while (set2.length < from.length) { set2.push(pad); }
				}
				if (complement && st1.hasClass && !(set2.length === from.length && homogeneous(set2))) {
					die('when translating with complemented character classes,\nstring2 must map all characters in the domain to one');
				}
			} else {
				if (st2.indefinite > 0) { die('the [c*] construct may appear in string2 only when translating'); }
				set2 = expand(s2list, 0);
			}
		}
	} catch (e) {
		if (e instanceof TrError) { return { stdout: new Uint8Array(0), stderr: warnings.map((w) => `tr: ${w}\n`).join('') + `tr: ${e.message}\n`, exitCode: 1 }; }
		throw e;
	}
	const stderr = warnings.map((w) => `tr: ${w}\n`).join('');

	/** the set as a membership table, complemented when -c asks (for deleting and squeezing; translating uses the list) */
	const member = (list, comp) => {
		const t = new Uint8Array(N_CHARS);
		for (const c of list) { t[c] = 1; }
		if (comp) { for (let c = 0; c < N_CHARS; c++) { t[c] ^= 1; } }
		return t;
	};
	const out = new Uint8Array(input.length);
	let len = 0;
	if (squeeze && n === 1) {
		// squeeze runs of a byte of string1 (or of its complement)
		const set = member(set1, complement);
		let prev = -1;
		for (let k = 0; k < input.length; k++) {
			const c = input[k];
			if (c === prev && set[c]) { continue; }
			out[len++] = c;
			prev = c;
		}
	} else if (del && n === 1) {
		const set = member(set1, complement);
		for (let k = 0; k < input.length; k++) { if (!set[input[k]]) { out[len++] = input[k]; } }
	} else if (del) {
		// delete string1 (or its complement), then squeeze what is left over string2
		const gone = member(set1, complement);
		const sq = member(set2, false);
		let prev = -1;
		for (let k = 0; k < input.length; k++) {
			const c = input[k];
			if (gone[c]) { continue; }
			if (c === prev && sq[c]) { continue; }
			out[len++] = c;
			prev = c;
		}
	} else if (translating) {
		const xlate = new Uint8Array(N_CHARS);
		for (let c = 0; c < N_CHARS; c++) { xlate[c] = c; }
		const skip = complement || !s2list ? new Set() : sameClassSkips(s1list, s2list);
		for (let k = 0; k < from.length && k < set2.length; k++) { if (!skip.has(k)) { xlate[from[k]] = set2[k]; } }
		const sq = squeeze ? member(set2, false) : null;
		let prev = -1;
		for (let k = 0; k < input.length; k++) {
			const c = xlate[input[k]];
			if (sq && c === prev && sq[c]) { continue; }
			out[len++] = c;
			prev = c;
		}
	} else {
		out.set(input);
		len = input.length;
	}
	return { stdout: out.subarray(0, len), stderr, exitCode: 0 };
}

module.exports = { run, buildSpecList, unquote };
