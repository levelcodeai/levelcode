// diff, from GNU's own behaviour, for what the engine's does not do: the two files are still compared by the engine's
// own algorithm (its normal format is read back as a list of changed ranges), and everything around that is here:
//
//   * folders: `diff A B` lists the names that are in one folder only (`Only in A: x`), the folders in both
//     (`Common subdirectories: A/d and B/d`) and compares the files in both; -r goes into the folders and -N takes a
//     missing file for an empty one; each file that differs is preceded by the line `diff OPTIONS A/x B/x` that GNU
//     prints (the options as they were typed)
//   * -q, -s, -x PAT / --exclude=PAT, -X FILE, a directory against a file (`diff d f` compares d/f with f)
//   * the output formats written here from those ranges and the files' own lines: unified (-u, -U N) and context (-c,
//     -C N) with any number of context lines and the timestamps GNU puts after the names, and `\ No newline at end of
//     file`
//   * -w, -b, -B, -i, -Z and --strip-trailing-cr: the files are compared with their lines made equal in the way asked
//     for, and what is printed is the original lines
//
// -y, -e, -f, -D, -I, -F, -p, -t, -T, -l and -E are not here: the engine says what is wrong with them.
'use strict';
// @ts-check

const { decodeBytes } = require('./text.js');

/**
 * @typedef {{ r: boolean, N: boolean, q: boolean, s: boolean, i: boolean, w: boolean, b: boolean, B: boolean, Z: boolean, stripCr: boolean,
 *   text: boolean, format: 'normal' | 'unified' | 'context', context: number, labels: string[], exclude: string[], excludeFrom: string[] }} DiffOptions
 */

/**
 * GNU's options for the subset above. `words` are the arguments that were options, as typed, for the `diff ...` line.
 *
 * @param {string[]} args
 * @returns {{ o: DiffOptions, operands: string[], words: string[] } | { unknown: true } | { error: string }}
 */
function parseOptions(args) {
	/** @type {DiffOptions} */
	const o = { r: false, N: false, q: false, s: false, i: false, w: false, b: false, B: false, Z: false, stripCr: false, text: false, format: 'normal', context: 3, labels: [], exclude: [], excludeFrom: [] };
	// the number of context lines is the greatest of what -U N and -C N said, or the number of -NUM; a bare -u or -c is
	// three lines, but only when there is no -NUM (`-u -U1` is three, `-U0 -u` is three, `-1 -u` is one, `-U1` is one)
	let contextValue = -1;
	let contextDigits = -1;
	let bareStyle = false;
	const more = (n) => { if (n > contextValue) { contextValue = n; } };
	/** @type {string[]} */
	const operands = [];
	/** @type {string[]} */
	const words = [];
	const style = (f) => { if (o.format !== 'normal' && o.format !== f) { return { error: 'diff: conflicting output style options\ndiff: Try \'diff --help\' for more information.\n' }; } o.format = f; return null; };
	let afterDashes = false;
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (afterDashes || a === '-' || !a.startsWith('-')) { operands.push(a); continue; }
		if (a === '--') { afterDashes = true; continue; }
		if (a.startsWith('--')) {
			const eq = a.indexOf('=');
			const name = eq < 0 ? a.slice(2) : a.slice(2, eq);
			const value = eq < 0 ? null : a.slice(eq + 1);
			words.push(a);
			const need = () => { if (value !== null) { return value; } const v = args[++i]; if (v !== undefined) { words.push(v); } return v; };
			switch (name) {
				case 'recursive': o.r = true; break;
				case 'new-file': o.N = true; break;
				case 'brief': o.q = true; break;
				case 'report-identical-files': o.s = true; break;
				case 'ignore-case': o.i = true; break;
				case 'ignore-all-space': o.w = true; break;
				case 'ignore-space-change': o.b = true; break;
				case 'ignore-blank-lines': o.B = true; break;
				case 'ignore-trailing-space': o.Z = true; break;
				case 'strip-trailing-cr': o.stripCr = true; break;
				case 'text': o.text = true; break;
				case 'normal': { const e = style('normal'); if (e) { return e; } break; }
				case 'unified': case 'context': {
					const e = style(name);
					if (e) { return e; }
					if (value !== null) { if (!/^\d+$/.test(value)) { return { error: `diff: invalid context length '${value}'\ndiff: Try 'diff --help' for more information.\n` }; } more(Number(value)); } else { bareStyle = true; }
					break;
				}
				case 'label': { const v = need(); if (v === undefined) { return { unknown: true }; } o.labels.push(v); break; }
				case 'exclude': { const v = need(); if (v === undefined) { return { unknown: true }; } o.exclude.push(v); break; }
				case 'exclude-from': { const v = need(); if (v === undefined) { return { unknown: true }; } o.excludeFrom.push(v); break; }
				case 'no-dereference': case 'minimal': case 'speed-large-files': break;
				default: return { unknown: true };
			}
			continue;
		}
		words.push(a);
		// a cluster: -NUM is -C NUM (the digits), the valued letters take the rest or the next argument
		for (let c = 1; c < a.length; c++) {
			const ch = a[c];
			const takeValue = () => {
				const rest = a.slice(c + 1);
				c = a.length;
				if (rest !== '') { return rest; }
				const v = args[++i];
				if (v !== undefined) { words.push(v); }
				return v;
			};
			if (ch >= '0' && ch <= '9') {
				// -NUM is the number of context lines, and nothing more: the format is what -c or -u says
				const m = /^\d+/.exec(a.slice(c));
				contextDigits = Number(m && m[0]);
				c += (m ? m[0].length : 1) - 1;
				continue;
			}
			switch (ch) {
				case 'r': o.r = true; break;
				case 'N': o.N = true; break;
				case 'q': o.q = true; break;
				case 's': o.s = true; break;
				case 'i': o.i = true; break;
				case 'w': o.w = true; break;
				case 'b': o.b = true; break;
				case 'B': o.B = true; break;
				case 'Z': o.Z = true; break;
				case 'a': o.text = true; break;
				case 'd': case 'H': case 'v': break;
				case 'u': { const e = style('unified'); if (e) { return e; } bareStyle = true; break; }
				case 'c': { const e = style('context'); if (e) { return e; } bareStyle = true; break; }
				case 'U': case 'C': {
					const v = takeValue();
					if (v === undefined) { return { unknown: true }; }
					if (!/^\d+$/.test(v)) { return { error: `diff: invalid context length '${v}'\ndiff: Try 'diff --help' for more information.\n` }; }
					const e = style(ch === 'U' ? 'unified' : 'context');
					if (e) { return e; }
					more(Number(v));
					break;
				}
				case 'L': { const v = takeValue(); if (v === undefined) { return { unknown: true }; } o.labels.push(v); break; }
				case 'x': { const v = takeValue(); if (v === undefined) { return { unknown: true }; } o.exclude.push(v); break; }
				case 'X': { const v = takeValue(); if (v === undefined) { return { unknown: true }; } o.excludeFrom.push(v); break; }
				case 'W': { if (takeValue() === undefined) { return { unknown: true }; } break; }
				default: return { unknown: true };
			}
		}
	}
	if (o.labels.length > 2) { return { error: 'diff: too many file label options\n' }; }
	o.context = contextDigits >= 0 ? Math.max(contextValue, contextDigits) : bareStyle ? Math.max(contextValue, 3) : contextValue >= 0 ? contextValue : 3;
	return { o, operands, words };
}

/** The lines of a text, each without its newline; `noNewline` is true when the last one had none (and `lines` is empty for no text). */
function splitLines(text) {
	if (text === '') { return { lines: [], noNewline: false }; }
	const parts = text.split('\n');
	if (parts[parts.length - 1] === '') { parts.pop(); return { lines: parts, noNewline: false }; }
	return { lines: parts, noNewline: true };
}

/**
 * A line as the options of the comparison see it: -w takes out all white space, -b makes a run of it one blank and drops
 * what ends the line, -Z drops what ends the line, --strip-trailing-cr the carriage return, -i the case.
 *
 * @param {string} line
 * @param {DiffOptions} o
 */
function canonical(line, o) {
	let s = line;
	if (o.stripCr) { s = s.replace(/\r$/, ''); }
	if (o.w) { s = s.replace(/[ \t\v\f\r]+/g, ''); } else if (o.b) { s = s.replace(/[ \t\v\f\r]+/g, ' ').replace(/ $/, ''); } else if (o.Z) { s = s.replace(/[ \t\v\f\r]+$/, ''); }
	// GNU folds the bytes with tolower(): ASCII only (`é` and `É` differ under -i in a UTF-8 locale)
	if (o.i) { s = s.replace(/[A-Z]+/g, (m) => m.toLowerCase()); }
	return s;
}

/**
 * The changed ranges the engine's normal-format diff printed: 1-based, inclusive; for an addition `a1` is the line after
 * which the lines come (`a2 = a1`, no lines on the left) and for a deletion `b1` is the line after which they would be.
 *
 * @param {string} text
 * @returns {Array<{ a1: number, a2: number, b1: number, b2: number }>}
 */
function parseNormal(text) {
	const hunks = [];
	for (const line of text.split('\n')) {
		const m = /^(\d+)(?:,(\d+))?([acd])(\d+)(?:,(\d+))?$/.exec(line);
		if (!m) { continue; }
		const a1 = Number(m[1]);
		const a2 = m[2] === undefined ? a1 : Number(m[2]);
		const b1 = Number(m[4]);
		const b2 = m[5] === undefined ? b1 : Number(m[5]);
		// an addition has no lines on the left, a deletion none on the right: the range is empty and its start is the line before
		hunks.push({ a1: m[3] === 'a' ? a1 + 1 : a1, a2: m[3] === 'a' ? a1 : a2, b1: m[3] === 'd' ? b1 + 1 : b1, b2: m[3] === 'd' ? b1 : b2 });
	}
	return hunks;
}

/**
 * GNU's `shift_boundaries` (analyze.c): where a change could be put in more than one place (the added line is the same as
 * the one before or after it, a blank line, a `}`), a run of changed lines is slid back as far as the line before it
 * equals its last line, which joins it with a change it meets, and then forward as far as its first line equals the one
 * after it, and so on until it does not move; a run that was joined is put back to where it lines up with a change on the
 * other side. Two diffs of the same size that differ only in where such a run sits come out as GNU's. The ranges are the
 * engine's own (its comparison is what finds them); `same(x, y)` says two lines are equal for the options.
 *
 * @param {Array<{ a1: number, a2: number, b1: number, b2: number }>} changes
 * @param {number} n lines on the left
 * @param {number} m lines on the right
 * @param {(left: boolean, i: number, j: number) => boolean} same lines i and j (0-based) of one side are equal
 * @returns {Array<{ a1: number, a2: number, b1: number, b2: number }>}
 */
function shiftBoundaries(changes, n, m, same) {
	const ca = new Uint8Array(n + 2);
	const cb = new Uint8Array(m + 2);
	for (const c of changes) {
		for (let k = c.a1; k <= c.a2; k++) { ca[k - 1] = 1; }
		for (let k = c.b1; k <= c.b2; k++) { cb[k - 1] = 1; }
	}
	// the same pass for each side, with the other side's marks as `other`
	const pass = (changed, other, len, left) => {
		let i = 0;
		let j = 0;
		const end = len;
		for (;;) {
			let runlength;
			let start;
			let corresponding;
			// to the beginning of the next run, keeping the place on the other side
			while (i < end && !changed[i]) {
				while (other[j++]) { /* skip */ }
				i++;
			}
			if (i === end) { break; }
			start = i;
			while (changed[++i]) { /* the end of the run */ }
			while (other[j]) { j++; }
			do {
				runlength = i - start;
				// back, while the line before the run is the run's last: merges with what is before
				while (start > 0 && same(left, start - 1, i - 1)) {
					changed[--start] = 1;
					changed[--i] = 0;
					while (start > 0 && changed[start - 1]) { start--; }
					while (j > 0 && other[--j]) { /* skip */ }
				}
				corresponding = j > 0 && other[j - 1] ? i : end;
				// forward, while the run's first line is the one after it: merges with what is after
				while (i !== end && same(left, start, i)) {
					changed[start++] = 0;
					changed[i++] = 1;
					while (changed[i]) { i++; }
					while (other[++j]) { corresponding = i; }
				}
			} while (runlength !== i - start);
			// a merged run goes back to where it lines up with a change on the other side
			while (corresponding < i) {
				changed[--start] = 1;
				changed[--i] = 0;
				while (j > 0 && other[--j]) { /* skip */ }
			}
		}
	};
	pass(ca, cb, n, true);
	pass(cb, ca, m, false);
	// the script: runs that sit at the same place on both sides are one change
	const out = [];
	let i = 0;
	let j = 0;
	while (i < n || j < m) {
		if (!ca[i] && !cb[j]) { i++; j++; continue; }
		const i0 = i;
		const j0 = j;
		while (i < n && ca[i]) { i++; }
		while (j < m && cb[j]) { j++; }
		out.push({ a1: i0 + 1, a2: i, b1: j0 + 1, b2: j });
	}
	return out;
}

/**
 * The hunks of a unified or context diff: changed ranges that are close are one. GNU puts two changes in one hunk when
 * no more than twice the number of context lines separates them.
 *
 * @param {Array<{ a1: number, a2: number, b1: number, b2: number }>} changes
 * @param {number} context
 */
function groupChanges(changes, context) {
	/** @type {Array<typeof changes>} */
	const groups = [];
	for (const c of changes) {
		const last = groups[groups.length - 1];
		if (last) {
			const prev = last[last.length - 1];
			// the unchanged lines between the end of the previous one and the start of this one (old side)
			const gap = c.a1 - 1 - prev.a2;
			if (gap <= 2 * context) { last.push(c); continue; }
		}
		groups.push([c]);
	}
	return groups;
}

const NO_NEWLINE = '\\ No newline at end of file\n';

/**
 * @param {Array<{ a1: number, a2: number, b1: number, b2: number }>} changes
 * @param {string[]} a
 * @param {string[]} b
 * @param {{ noNlA: boolean, noNlB: boolean }} eof
 * @param {number} context
 * @returns {string}
 */
function unifiedBody(changes, a, b, eof, context) {
	let out = '';
	const range = (start, count) => (count === 1 ? String(start) : count === 0 ? `${start - 1},0` : `${start},${count}`);
	// a line of the old file, with the marker when it is the last one and has no newline
	const lineA = (prefix, n) => `${prefix}${a[n - 1]}\n${n === a.length && eof.noNlA ? NO_NEWLINE : ''}`;
	const lineB = (prefix, n) => `${prefix}${b[n - 1]}\n${n === b.length && eof.noNlB ? NO_NEWLINE : ''}`;
	for (const group of groupChanges(changes, context)) {
		const first = group[0];
		const last = group[group.length - 1];
		const startA = Math.max(1, first.a1 - context);
		const endA = Math.min(a.length, last.a2 + context);
		// the lines of the new file at the same place: the same number of unchanged lines before the first change
		const startB = first.b1 - (first.a1 - startA);
		const endB = last.b2 + (endA - last.a2);
		const countA = endA - startA + 1;
		const countB = endB - startB + 1;
		out += `@@ -${range(startA, countA)} +${range(startB, countB)} @@\n`;
		let at = startA;
		for (const c of group) {
			for (; at < c.a1; at++) { out += lineA(' ', at); }
			for (let n = c.a1; n <= c.a2; n++) { out += lineA('-', n); }
			for (let n = c.b1; n <= c.b2; n++) { out += lineB('+', n); }
			at = c.a2 + 1;
		}
		for (; at <= endA; at++) { out += lineA(' ', at); }
	}
	return out;
}

/**
 * @param {Array<{ a1: number, a2: number, b1: number, b2: number }>} changes
 * @param {string[]} a
 * @param {string[]} b
 * @param {{ noNlA: boolean, noNlB: boolean }} eof
 * @param {number} context
 * @returns {string}
 */
function contextBody(changes, a, b, eof, context) {
	let out = '';
	const range = (start, end) => (end < start ? `${end}` : start === end ? String(start) : `${start},${end}`);
	const lineA = (prefix, n) => `${prefix}${a[n - 1]}\n${n === a.length && eof.noNlA ? NO_NEWLINE : ''}`;
	const lineB = (prefix, n) => `${prefix}${b[n - 1]}\n${n === b.length && eof.noNlB ? NO_NEWLINE : ''}`;
	for (const group of groupChanges(changes, context)) {
		const first = group[0];
		const last = group[group.length - 1];
		const startA = Math.max(1, first.a1 - context);
		const endA = Math.min(a.length, last.a2 + context);
		const startB = first.b1 - (first.a1 - startA);
		const endB = last.b2 + (endA - last.a2);
		out += '***************\n';
		const hasOld = group.some((c) => c.a2 >= c.a1);
		const hasNew = group.some((c) => c.b2 >= c.b1);
		out += `*** ${range(startA, endA)} ****\n`;
		if (hasOld) {
			let at = startA;
			for (const c of group) {
				for (; at < c.a1; at++) { out += lineA('  ', at); }
				const mark = c.b2 >= c.b1 ? '! ' : '- ';
				for (let n = c.a1; n <= c.a2; n++) { out += lineA(mark, n); }
				at = c.a2 + 1;
			}
			for (; at <= endA; at++) { out += lineA('  ', at); }
		}
		out += `--- ${range(startB, endB)} ----\n`;
		if (hasNew) {
			let at = startB;
			for (const c of group) {
				for (; at < c.b1; at++) { out += lineB('  ', at); }
				const mark = c.a2 >= c.a1 ? '! ' : '+ ';
				for (let n = c.b1; n <= c.b2; n++) { out += lineB(mark, n); }
				at = c.b2 + 1;
			}
			for (; at <= endB; at++) { out += lineB('  ', at); }
		}
	}
	return out;
}

/**
 * The normal format from ranges and the original lines.
 * @param {Array<{ a1: number, a2: number, b1: number, b2: number }>} changes
 * @param {string[]} a
 * @param {string[]} b
 * @param {{ noNlA: boolean, noNlB: boolean }} eof
 */
function normalBody(changes, a, b, eof) {
	let out = '';
	const span = (x, y) => (x === y ? String(x) : `${x},${y}`);
	for (const c of changes) {
		const del = c.a2 >= c.a1;
		const add = c.b2 >= c.b1;
		const type = del && add ? 'c' : del ? 'd' : 'a';
		const left = del ? span(c.a1, c.a2) : String(c.a1 - 1);
		const right = add ? span(c.b1, c.b2) : String(c.b1 - 1);
		out += `${left}${type}${right}\n`;
		for (let n = c.a1; n <= c.a2; n++) { out += `< ${a[n - 1]}\n${n === a.length && eof.noNlA ? NO_NEWLINE : ''}`; }
		if (del && add) { out += '---\n'; }
		for (let n = c.b1; n <= c.b2; n++) { out += `> ${b[n - 1]}\n${n === b.length && eof.noNlB ? NO_NEWLINE : ''}`; }
	}
	return out;
}

/**
 * The glob a name is matched with by --exclude (fnmatch: `*`, `?`, a set with ranges and `!`/`^`, a backslash; not
 * `/`-special). It is matched by table (the pattern's tokens against the name's characters), not by a regular
 * expression: `a*a*a*a*b` over a long name of a's was a backtracking RegExp that did not return.
 *
 * @param {string} glob
 * @returns {{ test(name: string): boolean }}
 */
function globMatcher(glob) {
	/** @type {Array<{ k: 'any' | 'one' | 'set' | 'lit', c?: string, neg?: boolean, items?: Array<[string, string]> }>} */
	const tokens = [];
	for (let i = 0; i < glob.length; i++) {
		const c = glob[i];
		if (c === '*') { if (!tokens.length || tokens[tokens.length - 1].k !== 'any') { tokens.push({ k: 'any' }); } continue; }
		if (c === '?') { tokens.push({ k: 'one' }); continue; }
		if (c === '[') {
			const close = glob.indexOf(']', i + 2);
			if (close < 0) { tokens.push({ k: 'lit', c }); continue; }
			let body = glob.slice(i + 1, close);
			let neg = false;
			if (body[0] === '!' || body[0] === '^') { neg = true; body = body.slice(1); }
			/** @type {Array<[string, string]>} */
			const items = [];
			for (let k = 0; k < body.length; k++) {
				if (k + 2 < body.length && body[k + 1] === '-') { items.push([body[k], body[k + 2]]); k += 2; } else { items.push([body[k], body[k]]); }
			}
			tokens.push({ k: 'set', neg, items });
			i = close;
			continue;
		}
		if (c === '\\' && i + 1 < glob.length) { tokens.push({ k: 'lit', c: glob[++i] }); continue; }
		tokens.push({ k: 'lit', c });
	}
	const one = (t, ch) => {
		if (t.k === 'one') { return true; }
		if (t.k === 'lit') { return t.c === ch; }
		const inSet = t.items.some(([a, b]) => a <= ch && ch <= b);
		return inSet !== t.neg;
	};
	return {
		test(name) {
			const chars = Array.from(name);
			// reach[j]: the first i tokens can have matched the first j characters
			let reach = new Array(chars.length + 1).fill(false);
			reach[0] = true;
			for (const t of tokens) {
				const next = new Array(chars.length + 1).fill(false);
				if (t.k === 'any') {
					let on = false;
					for (let j = 0; j <= chars.length; j++) { on = on || reach[j]; next[j] = on; }
				} else {
					for (let j = 0; j < chars.length; j++) { if (reach[j] && one(t, chars[j])) { next[j + 1] = true; } }
				}
				reach = next;
			}
			return reach[chars.length];
		},
	};
}

/**
 * @typedef {{
 *   stdin: string,
 *   readFile(path: string): Promise<Uint8Array>,
 *   stat(path: string): Promise<{ isFile: boolean, isDirectory: boolean, mtimeMs: number } | null>,
 *   readdir(path: string): Promise<string[]>,
 *   engine(args: string[]): Promise<{ stdout: string, stderr: string, exitCode: number }>,
 *   writeTemp(text: string): Promise<string>,
 *   stamp(ms: number | null): string,
 *   quote(word: string): string,
 * }} DiffIO
 */

/**
 * A name as diffutils 3.8 writes it in the `diff ...` line and in the labels of `---`, `+++` and `***` (not in the
 * `Only in`, `Files ... differ` and `Common subdirectories` lines): in double quotes when it holds a blank, a double
 * quote, a backslash or a control character, with C's escapes inside. Anything else (a `'`, a `$`, `é`) is as it is.
 *
 * @param {string} name
 * @returns {string}
 */
function quoteName(name) {
	if (!/[ "\\\u0000-\u001f\u007f]/.test(name)) { return name; }
	const named = { 7: '\\a', 8: '\\b', 9: '\\t', 10: '\\n', 11: '\\v', 12: '\\f', 13: '\\r' };
	return '"' + name.replace(/[\\"\u0000-\u001f\u007f]/g, (c) => {
		if (c === '\\') { return '\\\\'; }
		if (c === '"') { return '\\"'; }
		return named[c.charCodeAt(0)] || '\\' + c.charCodeAt(0).toString(8).padStart(3, '0');
	}) + '"';
}

/**
 * `diff` over the engine: see the header of this file.
 *
 * @param {string[]} args
 * @param {DiffIO} io
 * @returns {Promise<{ stdout: string, stderr: string, exitCode: number } | null>} null: not for this module (the engine answers)
 */
async function run(args, io) {
	const parsed = parseOptions(args);
	if ('unknown' in parsed) { return null; }
	if ('error' in parsed) { return { stdout: '', stderr: parsed.error, exitCode: 2 }; }
	const { o, operands, words } = parsed;
	if (operands.length < 2) {
		return { stdout: '', stderr: `diff: missing operand after '${args.length ? args[args.length - 1] : 'diff'}'\ndiff: Try 'diff --help' for more information.\n`, exitCode: 2 };
	}
	if (operands.length > 2) { return { stdout: '', stderr: `diff: extra operand '${operands[2]}'\ndiff: Try 'diff --help' for more information.\n`, exitCode: 2 }; }
	const header = `diff${words.length ? ' ' + words.map((w) => io.quote(w)).join(' ') : ''}`;
	const plain = !(o.w || o.b || o.B || o.Z || o.stripCr || o.i);
	let status = 0;
	let out = '';
	let err = '';
	const trouble = (m) => { err += m; status = 2; };
	const excludes = [...o.exclude];
	for (const f of o.excludeFrom) {
		try {
			for (const l of decodeBytes(await io.readFile(f)).split('\n')) { if (l !== '') { excludes.push(l); } }
		} catch {
			return { stdout: '', stderr: `diff: ${f}: No such file or directory\n`, exitCode: 2 };
		}
	}
	const excluded = excludes.map(globMatcher);
	const isExcluded = (name) => excluded.some((re) => re.test(name));
	const hasNul = (u8) => u8.indexOf(0) >= 0;
	const join = (d, n) => (d.endsWith('/') ? d + n : d + '/' + n);
	const same = (x, y) => x.length === y.length && x.every((v, k) => v === y[k]);

	/**
	 * Two files, either of which may be missing with -N (it is an empty one). `nameA` and `nameB` are what is opened
	 * (`/dev/null` for a missing one), `shownA` and `shownB` what is said; `show` puts the `diff ...` line first.
	 */
	const compareFiles = async (nameA, nameB, shownA, shownB, show) => {
		// what the one-line messages call the files: the label of each, when there is one
		const saidA = o.labels[0] !== undefined ? o.labels[0] : shownA;
		const saidB = o.labels[1] !== undefined ? o.labels[1] : shownB;
		const load = async (name) => {
			if (name === '-') { return { b: Uint8Array.from(io.stdin, (ch) => ch.charCodeAt(0) & 0xff), t: null }; }
			if (name === '/dev/null') { return { b: new Uint8Array(0), t: 0, missing: true }; }
			const st = await io.stat(name);
			if (!st) { return null; }
			return { b: await io.readFile(name), t: st.mtimeMs };
		};
		let A;
		let B;
		try {
			A = await load(nameA);
			B = await load(nameB);
		} catch {
			trouble(`diff: ${shownA}: Permission denied\n`);
			return;
		}
		if (A === null || B === null) { trouble(`diff: ${A === null ? shownA : shownB}: No such file or directory\n`); return; }
		const identical = same(A.b, B.b);
		const say = (m) => { out += m + '\n'; };
		if (!o.text && (hasNul(A.b) || hasNul(B.b))) {
			if (identical) { if (o.s) { say(`Files ${saidA} and ${saidB} are identical`); } return; }
			say(o.q ? `Files ${saidA} and ${saidB} differ` : `Binary files ${saidA} and ${saidB} differ`);
			status = Math.max(status, 1);
			return;
		}
		const sa = splitLines(decodeBytes(A.b));
		const sb = splitLines(decodeBytes(B.b));
		/** the changed ranges, by the lines as the options make them equal */
		let changes = [];
		if (!identical) {
			if (plain) {
				const r = await io.engine([nameA, nameB]);
				changes = parseNormal(r.stdout);
			} else {
				// a last line with no newline is another line than the same one with it, unless white space is what is ignored
				const marks = !(o.w || o.b || o.Z);
				const ca = sa.lines.map((l, k) => canonical(l, o) + (marks && sa.noNewline && k === sa.lines.length - 1 ? '\uE000' : ''));
				const cb = sb.lines.map((l, k) => canonical(l, o) + (marks && sb.noNewline && k === sb.lines.length - 1 ? '\uE000' : ''));
				if (!(ca.length === cb.length && ca.every((l, k) => l === cb[k]))) {
					const r = await io.engine([await io.writeTemp(ca.map((l) => l + '\n').join('')), await io.writeTemp(cb.map((l) => l + '\n').join(''))]);
					changes = parseNormal(r.stdout);
				}
				if (o.B) {
					// a change that only adds or removes blank lines is ignored
					changes = changes.filter((c) => {
						for (let n = c.a1; n <= c.a2; n++) { if (canonical(sa.lines[n - 1], o) !== '') { return true; } }
						for (let n = c.b1; n <= c.b2; n++) { if (canonical(sb.lines[n - 1], o) !== '') { return true; } }
						return false;
					});
				}
			}
		}
		// where the engine put a change that could be somewhere else is moved to where GNU puts it
		if (changes.length) {
			const key = (side, k) => {
				const lines = side === sa ? sa : sb;
				return canonical(lines.lines[k], o) + (!(o.w || o.b || o.Z) && lines.noNewline && k === lines.lines.length - 1 ? '\uE000' : '');
			};
			const keysA = sa.lines.map((_l, k) => key(sa, k));
			const keysB = sb.lines.map((_l, k) => key(sb, k));
			changes = shiftBoundaries(changes, keysA.length, keysB.length, (left, x, y) => (left ? keysA[x] === keysA[y] : keysB[x] === keysB[y]));
		}
		if (!changes.length) {
			if (o.s) { say(`Files ${saidA} and ${saidB} are identical`); }
			return;
		}
		status = Math.max(status, 1);
		if (o.q) { say(`Files ${saidA} and ${saidB} differ`); return; }
		if (show) { say(`${header} ${quoteName(shownA)} ${quoteName(shownB)}`); }
		const eof = { noNlA: sa.noNewline, noNlB: sb.noNewline };
		const labelA = o.labels[0] !== undefined ? o.labels[0] : `${quoteName(shownA)}\t${io.stamp(A.t)}`;
		const labelB = o.labels[1] !== undefined ? o.labels[1] : `${quoteName(shownB)}\t${io.stamp(B.t)}`;
		if (o.format === 'unified') {
			out += `--- ${labelA}\n+++ ${labelB}\n` + unifiedBody(changes, sa.lines, sb.lines, eof, o.context);
		} else if (o.format === 'context') {
			out += `*** ${labelA}\n--- ${labelB}\n` + contextBody(changes, sa.lines, sb.lines, eof, o.context);
		} else {
			out += normalBody(changes, sa.lines, sb.lines, eof);
		}
	};

	/** with -N -r: a folder that only one side has is compared, file by file, with nothing */
	const compareOneSided = async (dir, other, onRight) => {
		for (const name of (await io.readdir(dir)).slice().sort()) {
			if (isExcluded(name)) { continue; }
			const p = join(dir, name);
			const st = await io.stat(p);
			if (st && st.isDirectory) { await compareOneSided(p, join(other, name), onRight); continue; }
			await compareFiles(onRight ? '/dev/null' : p, onRight ? p : '/dev/null', onRight ? join(other, name) : p, onRight ? p : join(other, name), !o.q);
		}
	};

	/** a folder against a folder; `A` and `B` are the names as GNU shows them */
	const compareDirs = async (A, B) => {
		let namesA;
		let namesB;
		// with -N a folder that is not there is an empty one
		try { namesA = await io.readdir(A); } catch { if (o.N && !(await io.stat(A))) { namesA = []; } else { trouble(`diff: ${A}: No such file or directory\n`); return; } }
		try { namesB = await io.readdir(B); } catch { if (o.N && !(await io.stat(B))) { namesB = []; } else { trouble(`diff: ${B}: No such file or directory\n`); return; } }
		const names = [...new Set([...namesA, ...namesB])].filter((n) => !isExcluded(n)).sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
		for (const name of names) {
			const pa = join(A, name);
			const pb = join(B, name);
			const sa = namesA.includes(name) ? await io.stat(pa) : null;
			const sb = namesB.includes(name) ? await io.stat(pb) : null;
			const dirA = !!sa && sa.isDirectory;
			const dirB = !!sb && sb.isDirectory;
			if (!sa || !sb) {
				if (!o.N) {
					out += `Only in ${sa ? A : B}: ${name}\n`;
					status = Math.max(status, 1);
				} else if (dirA || dirB) {
					// a folder that one side lacks is, with -N, an empty one: with -r it is walked, and without it is "common"
					if (o.r) { await compareOneSided(sa ? pa : pb, sa ? pb : pa, !sa); } else { out += `Common subdirectories: ${pa} and ${pb}\n`; }
				} else {
					await compareFiles(sa ? pa : '/dev/null', sb ? pb : '/dev/null', pa, pb, !o.q);
				}
				continue;
			}
			if (dirA && dirB) {
				if (o.r) { await compareDirs(pa, pb); } else { out += `Common subdirectories: ${pa} and ${pb}\n`; }
			} else if (dirA || dirB) {
				out += `File ${pa} is a ${dirA ? 'directory' : 'regular file'} while file ${pb} is a ${dirB ? 'directory' : 'regular file'}\n`;
				status = Math.max(status, 1);
			} else {
				await compareFiles(pa, pb, pa, pb, !o.q);
			}
		}
	};

	const [A, B] = operands;
	const sa = A === '-' ? { isFile: true, isDirectory: false, mtimeMs: 0 } : await io.stat(A);
	const sb = B === '-' ? { isFile: true, isDirectory: false, mtimeMs: 0 } : await io.stat(B);
	if (!sa || !sb) {
		// with -N a file that is not there is an empty one
		if (o.N && (sa || sb) && !(sa && sa.isDirectory) && !(sb && sb.isDirectory)) {
			await compareFiles(sa ? A : '/dev/null', sb ? B : '/dev/null', A, B, false);
			return { stdout: out, stderr: err, exitCode: status };
		}
		if (o.N && (sa ? sa.isDirectory : sb && sb.isDirectory)) {
			await compareDirs(A, B);
			return { stdout: out, stderr: err, exitCode: status };
		}
		return { stdout: '', stderr: (!sa ? `diff: ${A}: No such file or directory\n` : '') + (!sb ? `diff: ${B}: No such file or directory\n` : ''), exitCode: 2 };
	}
	if (sa.isDirectory && sb.isDirectory) {
		await compareDirs(A, B);
	} else if (sa.isDirectory || sb.isDirectory) {
		// a folder and a file: the file of that name in the folder
		const trimmed = (p) => p.replace(/\/+$/, '');
		const base = (p) => trimmed(p).slice(trimmed(p).lastIndexOf('/') + 1);
		const dir = sa.isDirectory ? A : B;
		const file = sa.isDirectory ? B : A;
		const inner = join(dir, base(file));
		const si = await io.stat(inner);
		if (!si) { return { stdout: '', stderr: `diff: ${inner}: No such file or directory\n`, exitCode: 2 }; }
		if (si.isDirectory) { return { stdout: `File ${sa.isDirectory ? A : B} is a directory while file ${sa.isDirectory ? B : A} is a regular file\n`, stderr: '', exitCode: 1 }; }
		if (sa.isDirectory) { await compareFiles(inner, B, inner, B, false); } else { await compareFiles(A, inner, A, inner, false); }
	} else {
		await compareFiles(A, B, A, B, false);
	}
	return { stdout: out, stderr: err, exitCode: status };
}

module.exports = { run, quoteName, parseOptions, splitLines, canonical, parseNormal, shiftBoundaries, groupChanges, unifiedBody, contextBody, normalBody, globMatcher };
