// Text and bytes, without losing a byte that is not valid UTF-8.
//
// A file is bytes; the engine's commands work on strings. `TextDecoder` turns every invalid byte into U+FFFD, so a
// command that read a file as text and wrote it back (`sed -i` with no match, `tee`, `sort -o`, `$(cat f)`) changed
// bytes it was never asked to touch: a latin-1 file, a PNG header, a UTF-8 file with one bad byte. Here a byte that is
// not part of a valid sequence becomes U+DC00 + byte (always U+DC80..U+DCFF: ASCII is always valid) — Python's
// "surrogateescape" — and goes back to that byte when the text is encoded. No valid UTF-8 decodes to a lone surrogate,
// so an escape cannot be confused with real text.
//
// Used by overlay-fs.js (file contents), compat.js, core.js (what is shown), and by the patched just-bash (patch
// LC-10: its own text <-> byte-string conversions, `fe`, `x8` and `Pn`, are these).
'use strict';
// @ts-check

const enc = new TextEncoder();
/** `ignoreBOM: true`: U+FEFF stays in the string (a BOM is bytes of the file, and `sed -i` must write them back). */
const decFatal = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/**
 * UTF-8 to a string, losslessly. Valid input (nearly always) takes the native decoder.
 * @param {Uint8Array} u8
 * @returns {string}
 */
function decodeBytes(u8) {
	try { return decFatal.decode(u8); } catch { /* escape what is not UTF-8 */ }
	const cont = (i) => i < u8.length && (u8[i] & 0xc0) === 0x80;
	const parts = [];
	/** @type {number[]} */
	let units = [];
	for (let i = 0; i < u8.length;) {
		const b = u8[i];
		let cp = -1;
		let len = 1;
		if (b < 0x80) {
			cp = b;
		} else if (b >= 0xc2 && b <= 0xdf && cont(i + 1)) {
			cp = ((b & 0x1f) << 6) | (u8[i + 1] & 0x3f);
			len = 2;
		} else if (b >= 0xe0 && b <= 0xef && cont(i + 1) && cont(i + 2)) {
			cp = ((b & 0x0f) << 12) | ((u8[i + 1] & 0x3f) << 6) | (u8[i + 2] & 0x3f);
			len = 3;
			if (cp < 0x800 || (cp >= 0xd800 && cp <= 0xdfff)) { cp = -1; len = 1; }       // overlong, or a surrogate
		} else if (b >= 0xf0 && b <= 0xf4 && cont(i + 1) && cont(i + 2) && cont(i + 3)) {
			cp = ((b & 0x07) << 18) | ((u8[i + 1] & 0x3f) << 12) | ((u8[i + 2] & 0x3f) << 6) | (u8[i + 3] & 0x3f);
			len = 4;
			if (cp < 0x10000 || cp > 0x10ffff) { cp = -1; len = 1; }                         // overlong, or too big
		}
		if (cp < 0) {
			units.push(0xdc00 | b);
			i++;
			continue;
		}
		if (cp >= 0x10000) { cp -= 0x10000; units.push(0xd800 | (cp >> 10), 0xdc00 | (cp & 0x3ff)); } else { units.push(cp); }
		i += len;
		if (units.length >= 0x2000) { parts.push(String.fromCharCode.apply(null, units)); units = []; }
	}
	parts.push(String.fromCharCode.apply(null, units));
	return parts.join('');
}

/**
 * A string to UTF-8, the inverse of `decodeBytes`: a lone U+DC80..U+DCFF is the byte it escapes. Everything else is
 * what TextEncoder gives (a lone surrogate that is not an escape is U+FFFD, as it always was).
 * @param {string} s
 * @returns {Uint8Array}
 */
function encodeText(s) {
	if (!/[\udc80-\udcff]/.test(s)) { return enc.encode(s); }
	const out = new Uint8Array(s.length * 3);
	let n = 0;
	for (let i = 0; i < s.length; i++) {
		let c = s.charCodeAt(i);
		if (c < 0x80) { out[n++] = c; continue; }
		if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
			const d = s.charCodeAt(i + 1);
			if (d >= 0xdc00 && d <= 0xdfff) {
				c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00);
				i++;
				out[n++] = 0xf0 | (c >> 18);
				out[n++] = 0x80 | ((c >> 12) & 0x3f);
				out[n++] = 0x80 | ((c >> 6) & 0x3f);
				out[n++] = 0x80 | (c & 0x3f);
				continue;
			}
		}
		if (c >= 0xdc80 && c <= 0xdcff) { out[n++] = c & 0xff; continue; }
		if (c >= 0xd800 && c <= 0xdfff) { c = 0xfffd; }
		if (c < 0x800) {
			out[n++] = 0xc0 | (c >> 6);
			out[n++] = 0x80 | (c & 0x3f);
		} else {
			out[n++] = 0xe0 | (c >> 12);
			out[n++] = 0x80 | ((c >> 6) & 0x3f);
			out[n++] = 0x80 | (c & 0x3f);
		}
	}
	return out.slice(0, n);
}

/**
 * A byte-shaped string (one character per byte: what a pipe, a redirect from a file and `readFileBytes` hand a
 * command) as text, losslessly. A string with a character above 255 is text already, and a string of ASCII needs
 * nothing. Only for strings that are KNOWN to be bytes: text with an `é` in it has every character below 256 too.
 * @param {string} s
 * @returns {string}
 */
function decodeByteString(s) {
	if (!s) { return s; }
	let high = false;
	for (let i = 0; i < s.length; i++) {
		const c = s.charCodeAt(i);
		if (c > 255) { return s; }
		if (c > 127) { high = true; }
	}
	if (!high) { return s; }
	const b = new Uint8Array(s.length);
	for (let i = 0; i < s.length; i++) { b[i] = s.charCodeAt(i); }
	return decodeBytes(b);
}

/**
 * A string that may be bytes or may be text (the result of a statement: `printf '\303\251'` makes the text "Ã©",
 * which a terminal shows as "é" because they are the bytes of one): bytes that are valid UTF-8 are decoded, anything
 * else is text and is left alone.
 * @param {string} s
 * @returns {string}
 */
function decodeIfBytes(s) {
	if (!s) { return s; }
	let high = false;
	for (let i = 0; i < s.length; i++) {
		const c = s.charCodeAt(i);
		if (c > 255) { return s; }
		if (c > 127) { high = true; }
	}
	if (!high) { return s; }
	const b = new Uint8Array(s.length);
	for (let i = 0; i < s.length; i++) { b[i] = s.charCodeAt(i); }
	try { return decFatal.decode(b); } catch { return s; }
}

/**
 * The escapes of bytes that are valid UTF-8 together, joined into the characters they are: `printf '\303\251'` makes
 * the two escapes of C3 and A9 (each a byte), which a person is shown as "é" and `${#x}` counts as one. A run that is not
 * valid stays escapes, byte by byte; a surrogate PAIR whose low half happens to lie in the escape range is a character
 * and is left alone.
 * @param {string} s
 * @returns {string}
 */
function joinEscapes(s) {
	if (!/[\udc80-\udcff]/.test(s)) { return s; }
	return s.replace(/(?<![\ud800-\udbff])[\udc80-\udcff]+/g, (run) => {
		const b = new Uint8Array(run.length);
		for (let i = 0; i < run.length; i++) { b[i] = run.charCodeAt(i) & 0xff; }
		return decodeBytes(b);
	});
}

/**
 * What a person or a model is shown: an escaped byte is U+FFFD, the one character a terminal could draw for it, and so
 * is any other lone surrogate (half of a character that something cut, such as awk's `substr` through an emoji): a lone
 * surrogate in a JSON string is something an API may refuse, and in a URI something that cannot be encoded. A surrogate
 * PAIR is a character and stays.
 * @param {string} s
 * @returns {string}
 */
function displayText(s) {
	if (!/[\ud800-\udfff]/.test(s)) { return s; }
	let out = '';
	for (let i = 0; i < s.length; i++) {
		const c = s.charCodeAt(i);
		if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
			const d = s.charCodeAt(i + 1);
			if (d >= 0xdc00 && d <= 0xdfff) { out += s[i] + s[i + 1]; i++; continue; }
		}
		out += c >= 0xd800 && c <= 0xdfff ? '\ufffd' : s[i];
	}
	return out;
}

/**
 * Does the string hold a surrogate that is not half of a pair? (A name like that cannot be made into a URI.)
 * @param {string} s
 * @returns {boolean}
 */
function hasLoneSurrogate(s) {
	if (!/[\ud800-\udfff]/.test(s)) { return false; }
	for (let i = 0; i < s.length; i++) {
		const c = s.charCodeAt(i);
		if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
			const d = s.charCodeAt(i + 1);
			if (d >= 0xdc00 && d <= 0xdfff) { i++; continue; }
		}
		if (c >= 0xd800 && c <= 0xdfff) { return true; }
	}
	return false;
}

/**
 * `ls -v` / `--sort=version` and `sort -V`: gnulib's `filevercmp` as coreutils 8.32 has it (not glibc's `strverscmp`).
 * Leading zeros make no difference to a number, and names equal as versions fall back to their bytes, so `w0 w00 w000`
 * (not the other way round) and `file01.txt` is not `file1.txt` for `sort -u`; `~` sorts before the end of a name and a
 * letter before any other mark; a file suffix (`.tar.gz`, `.txt`) is left out of the comparison unless what is before
 * it is the same; a name with a leading dot sorts before any other, `.` and `..` first. Compared as UTF-8 bytes.
 * Recorded against GNU on 1,000 random sets of names and on the lists of shell-engine-compat.test.js.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number} negative, zero or positive
 */
function versionCompare(a, b) {
	const isDigit = (/** @type {number} */ c) => c >= 48 && c <= 57;
	const isAlpha = (/** @type {number} */ c) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
	/** where the file suffix `(\.[A-Za-z~][A-Za-z0-9~]*)*` of the name starts (-1: there is none) */
	const suffixAt = (/** @type {Uint8Array} */ s) => {
		let match = -1;
		let afterDot = false;
		for (let i = 0; i < s.length; i++) {
			const c = s[i];
			if (afterDot) {
				afterDot = false;
				if (!isAlpha(c) && c !== 126) { match = -1; }
			} else if (c === 46) {
				if (match < 0) { match = i; }
				afterDot = true;
			} else if (!isDigit(c) && !isAlpha(c) && c !== 126) {
				match = -1;
			}
		}
		return match;
	};
	const weight = (/** @type {number} */ c) => (isDigit(c) ? 0 : isAlpha(c) ? c : c === 126 ? -1 : c + 256);
	const at = (/** @type {Uint8Array} */ s, /** @type {number} */ p) => (p < s.length ? s[p] : 0);
	/** dpkg's comparison: marks and letters first, then the digits as numbers */
	const compare = (/** @type {Uint8Array} */ s1, /** @type {number} */ l1, /** @type {Uint8Array} */ s2, /** @type {number} */ l2) => {
		let p1 = 0;
		let p2 = 0;
		while (p1 < l1 || p2 < l2) {
			let first = 0;
			while ((p1 < l1 && !isDigit(s1[p1])) || (p2 < l2 && !isDigit(s2[p2]))) {
				const w1 = p1 === l1 ? 0 : weight(s1[p1]);
				const w2 = p2 === l2 ? 0 : weight(s2[p2]);
				if (w1 !== w2) { return w1 - w2; }
				p1++;
				p2++;
			}
			while (at(s1, p1) === 48) { p1++; }
			while (at(s2, p2) === 48) { p2++; }
			while (isDigit(at(s1, p1)) && isDigit(at(s2, p2))) {
				if (!first) { first = s1[p1] - s2[p2]; }
				p1++;
				p2++;
			}
			if (isDigit(at(s1, p1))) { return 1; }
			if (isDigit(at(s2, p2))) { return -1; }
			if (first) { return first; }
		}
		return 0;
	};
	const b1 = encodeText(a);
	const b2 = encodeText(b);
	let simple = 0;
	for (let i = 0; i < Math.min(b1.length, b2.length) && simple === 0; i++) { simple = b1[i] - b2[i]; }
	simple = simple || b1.length - b2.length;
	if (simple === 0) { return 0; }
	if (b1.length === 0) { return -1; }
	if (b2.length === 0) { return 1; }
	if (a === '.') { return -1; }
	if (b === '.') { return 1; }
	if (a === '..') { return -1; }
	if (b === '..') { return 1; }
	if (b1[0] === 46 && b2[0] !== 46) { return -1; }
	if (b1[0] !== 46 && b2[0] === 46) { return 1; }
	const s1 = b1[0] === 46 ? b1.subarray(1) : b1;
	const s2 = b2[0] === 46 ? b2.subarray(1) : b2;
	const m1 = suffixAt(s1);
	const m2 = suffixAt(s2);
	let l1 = m1 < 0 ? s1.length : m1;
	let l2 = m2 < 0 ? s2.length : m2;
	// the suffixes count when what is before them is the same
	if ((m1 >= 0 || m2 >= 0) && l1 === l2 && s1.subarray(0, l1).every((c, i) => c === s2[i])) {
		l1 = s1.length;
		l2 = s2.length;
	}
	return compare(s1, l1, s2, l2) || simple;
}

module.exports = { decodeBytes, encodeText, decodeByteString, decodeIfBytes, joinEscapes, displayText, hasLoneSurrogate, versionCompare };
