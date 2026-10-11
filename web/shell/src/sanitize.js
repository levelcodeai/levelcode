/*---------------------------------------------------------------------------------------------
 *  LevelCode Shell - what may be shown of text that came from a file, a command or the model.
 *
 *  A terminal is an interpreter: ESC, the 8-bit C1 controls (xterm.js reads U+009B as CSI), BEL, a lone CR
 *  and more can make it type into its own input, move the cursor over what was printed or change its state.
 *  A card the user is asked to approve is a different reader with a different worry: text that is invisible
 *  or that reorders what is shown (a bidi override, a tag character, a Hangul filler) lets a command read as
 *  something it is not. One rule serves both: what cannot be told apart from nothing, or that acts, is
 *  shown as what it is.
 *
 *    C0 controls (not \n, \t) and DEL   ->  a control picture; ESC becomes U+241B
 *    everything else that is invisible  ->  [U+XXXX]
 *        C1 (U+0080-009F), bidi marks and overrides, zero-width and format characters, tag characters,
 *        variation selectors, the Hangul and Mongolian fillers, the invisible math operators, U+2028/2029,
 *        the blank Braille pattern, interlinear annotation anchors and lone surrogates
 *
 *  The two functions differ in two places, both because the readers differ:
 *    - a carriage return. forTerminal turns it into a line break, so a line cannot overwrite itself
 *      ("rm -rf /\rls"). forDisplay shows it (U+240D): on a card it is part of what is being approved.
 *    - the joiners of an emoji sequence. forTerminal keeps a VS16 after a pictograph and a ZWJ between
 *      pictographs, because a README full of emoji would otherwise be unreadable; forDisplay does not,
 *      because there nothing may be invisible.
 *
 *  Pure, no vscode, no I/O. The stream filter of the terminal (escape sequences that straddle chunks) is the
 *  terminal's own, in src/terminal.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

/**
 * Everything either function has to look at. \p{Default_Ignorable_Code_Point} is Unicode's own definition of
 * "has no visible glyph of its own" and moves with the engine's Unicode tables, so a character added next year
 * is already covered; the rest are the invisible-ish characters it does not list. Written with \u{...}: in this
 * mode that also matches a LONE surrogate, which is what the last range is for.
 */
const HAZARD = /[\p{Cc}\p{Default_Ignorable_Code_Point}\u{2028}\u{2029}\u{2800}\u{FFF9}-\u{FFFB}\u{D800}-\u{DFFF}]/gu;

const PICTOGRAPH = /^[\p{Extended_Pictographic}\p{Emoji_Modifier}]$/u;
const KEYCAP_BASE = /^[0-9#*]$/;

/** @param {number} cp */
function bracket(cp) { return '[U+' + cp.toString(16).toUpperCase().padStart(4, '0') + ']'; }

/**
 * The code point that ends just before UTF-16 index `i`, as a string ('' at the start).
 * @param {string} s @param {number} i
 */
function before(s, i) {
	if (i <= 0) { return ''; }
	const lo = s.charCodeAt(i - 1);
	if (lo >= 0xDC00 && lo <= 0xDFFF && i >= 2) {
		const hi = s.charCodeAt(i - 2);
		if (hi >= 0xD800 && hi <= 0xDBFF) { return s.slice(i - 2, i); }
	}
	return s[i - 1];
}

/** The code point that starts at UTF-16 index `i`, as a string ('' at the end). @param {string} s @param {number} i */
function after(s, i) {
	if (i >= s.length) { return ''; }
	return String.fromCodePoint(/** @type {number} */ (s.codePointAt(i)));
}

/**
 * Is this VS16/VS15 or ZWJ part of an emoji sequence (and so drawn, not hidden)? Only the shapes a font really
 * joins: a variation selector right after a pictograph, or a keycap base followed by U+20E3; a ZWJ between two
 * pictographs, where a variation selector may sit before it.
 * @param {string} s @param {number} i  index of the character in `s` @param {number} cp
 */
function joinsEmoji(s, i, cp) {
	const prev = before(s, i);
	if (cp === 0xFE0F || cp === 0xFE0E) {
		if (PICTOGRAPH.test(prev)) { return true; }
		return KEYCAP_BASE.test(prev) && s.charCodeAt(i + 1) === 0x20E3;
	}
	if (cp === 0x200D) {
		let left = prev;
		if (left === '\u{FE0F}' || left === '\u{FE0E}') { left = before(s, i - 1); }
		return PICTOGRAPH.test(left) && PICTOGRAPH.test(after(s, i + 1));
	}
	return false;
}

/**
 * Text that came out of a file or a command, made safe to write to a terminal. Newlines are LF (CRLF and a lone
 * CR both become one), tabs stay; with `crlf` the newline is written as CR LF, which is what a pty wants.
 * @param {string} text
 * @param {{ crlf?: boolean }} [o]
 * @returns {string}
 */
function forTerminal(text, o) {
	const s = text === null || text === undefined ? '' : String(text);
	const nl = o && o.crlf ? '\r\n' : '\n';
	return s.replace(HAZARD, (ch, i) => {
		const cp = /** @type {number} */ (ch.codePointAt(0));
		if (cp === 0x0A) { return nl; }
		if (cp === 0x09) { return '\t'; }
		if (cp === 0x0D) { return s.charCodeAt(i + 1) === 0x0A ? '' : nl; }   // CR LF: the LF writes the break
		if (cp < 0x20) { return String.fromCharCode(0x2400 + cp); }
		if (cp === 0x7F) { return '\u{2421}'; }
		if (joinsEmoji(s, i, cp)) { return ch; }
		return bracket(cp);
	});
}

/**
 * A command (or a path, or a name) shown to a person who is asked to approve it. Nothing is hidden and nothing
 * is rewritten except to be made visible; line breaks and tabs stay as they are, a CR is shown.
 * @param {string} text
 * @returns {string}
 */
function forDisplay(text) {
	return (text === null || text === undefined ? '' : String(text)).replace(HAZARD, (ch) => {
		const cp = /** @type {number} */ (ch.codePointAt(0));
		if (cp === 0x0A || cp === 0x09) { return ch; }
		if (cp < 0x20) { return String.fromCharCode(0x2400 + cp); }
		if (cp === 0x7F) { return '\u{2421}'; }
		return bracket(cp);
	});
}

module.exports = { forTerminal, forDisplay };
