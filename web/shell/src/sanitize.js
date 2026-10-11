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
 *        C1 (U+0080-009F), every format character (Unicode category Cf: bidi marks and overrides, zero-width
 *        space and joiners, the word joiner, the byte-order mark, the Arabic number signs, the shorthand and
 *        musical format controls, tag characters), everything Unicode lists as default-ignorable (variation
 *        selectors, the Hangul and Mongolian fillers, the invisible math operators, the combining grapheme
 *        joiner), U+2028/2029, the blank Braille pattern, interlinear annotation anchors and lone surrogates
 *
 *  What is left alone, on purpose: spaces of another width (U+00A0, U+1680, U+2000-200A, U+202F, U+205F,
 *  U+3000). They are drawn as a gap, which is what they are; marking them would mark all CJK text. They cannot
 *  reorder or hide anything.
 *
 *  The two functions differ in three places, all because the readers differ:
 *    - a carriage return. forTerminal turns it into a line break, so a line cannot overwrite itself
 *      ("rm -rf /\rls"). forDisplay shows it (U+240D): on a card it is part of what is being approved.
 *    - the joiners of an emoji sequence. forTerminal keeps a VS16 after a pictograph and a ZWJ between
 *      pictographs, because a README full of emoji would otherwise be unreadable; forDisplay does not,
 *      because there nothing may be invisible.
 *    - the joiners of a script that is written with them. forTerminal keeps ONE zero-width non-joiner or
 *      joiner that stands between two letters or marks of the same script when that script is Arabic (Persian,
 *      Urdu, Kurdish and Pashto spell words with U+200C) or one of the Indic scripts (conjunct control). Shown
 *      as [U+200C] every compound word of a Persian README would be unreadable. It stays hidden when it is
 *      first, last, doubled, or next to anything else, so it cannot carry more than a bit per gap between two
 *      letters; forDisplay still shows it.
 *
 *  A third, forNote, is forDisplay for what is put inside one of the shell's own one-line notes: it also shows the
 *  line break and the tab, so a name cannot add a line to a note.
 *
 *  And one for what a provider THROWS: safeMessage(e) is what the error says as a note's reason, bounded and on one
 *  line. `e.message` is read inside it, not at its caller, so an error whose message is a getter that throws (or a
 *  Proxy that does) is a reason like any other, not an exception raised from the middle of a commit. safeGet is
 *  the same total read for any other property of something that was thrown (`code`, `name`).
 *
 *  Pure, no vscode, no I/O. Total: whatever it is given, even an object whose toString throws, it returns a
 *  string. The stream filter of the terminal (escape sequences that straddle chunks) is the terminal's own, in
 *  src/terminal.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

/**
 * Everything either function has to look at. \p{Cf} (format characters) and \p{Default_Ignorable_Code_Point}
 * are Unicode's own definitions of "has no visible glyph of its own" and move with the engine's Unicode tables,
 * so a character added next year is already covered; the rest are the invisible-ish characters they do not
 * list. Written with \u{...}: in this mode that also matches a LONE surrogate, which is what the last range is
 * for.
 */
const HAZARD = /[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}\u{2028}\u{2029}\u{2800}\u{FFF9}-\u{FFFB}\u{D800}-\u{DFFF}]/gu;

const PICTOGRAPH = /^[\p{Extended_Pictographic}\p{Emoji_Modifier}]$/u;
const KEYCAP_BASE = /^[0-9#*]$/;

/** A letter or a combining mark: the joiner follows a virama, a vowel sign or a letter and precedes a letter. */
const LETTER_OR_MARK = /^[\p{L}\p{M}]$/u;
/**
 * The scripts that are written with U+200C / U+200D inside a word, one regexp each, so that "the same script on
 * both sides" is a test of its own and a Persian letter next to a Devanagari one is not a word.
 */
const JOINER_SCRIPTS = [
	/^\p{Script_Extensions=Arabic}$/u, /^\p{Script_Extensions=Devanagari}$/u, /^\p{Script_Extensions=Bengali}$/u,
	/^\p{Script_Extensions=Gurmukhi}$/u, /^\p{Script_Extensions=Gujarati}$/u, /^\p{Script_Extensions=Oriya}$/u,
	/^\p{Script_Extensions=Tamil}$/u, /^\p{Script_Extensions=Telugu}$/u, /^\p{Script_Extensions=Kannada}$/u,
	/^\p{Script_Extensions=Malayalam}$/u, /^\p{Script_Extensions=Sinhala}$/u,
];

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
 * Is this ZWNJ or ZWJ part of a word written in a script that uses them (and so drawn, not hidden)? Only one
 * with a letter or mark on each side, both of the same script, from JOINER_SCRIPTS.
 * @param {string} s @param {number} i  index of the character in `s` @param {number} cp
 */
function joinsScript(s, i, cp) {
	if (cp !== 0x200C && cp !== 0x200D) { return false; }
	const left = before(s, i);
	const right = after(s, i + 1);
	if (!LETTER_OR_MARK.test(left) || !LETTER_OR_MARK.test(right)) { return false; }
	return JOINER_SCRIPTS.some((script) => script.test(left) && script.test(right));
}

/**
 * Any value as text, without being able to throw: an object with no prototype or a toString that throws is
 * not a reason for the caller to fail. null and undefined are nothing.
 * @param {unknown} value @returns {string}
 */
function textOf(value) {
	if (typeof value === 'string') { return value; }
	if (value === null || value === undefined) { return ''; }
	try { return String(value); } catch { return '[unprintable value]'; }
}

/**
 * Text that came out of a file or a command, made safe to write to a terminal. Newlines are LF (CRLF and a lone
 * CR both become one), tabs stay; with `crlf` the newline is written as CR LF, which is what a pty wants.
 * @param {unknown} text
 * @param {{ crlf?: boolean }} [o]
 * @returns {string}
 */
function forTerminal(text, o) {
	const s = textOf(text);
	const nl = o && o.crlf ? '\r\n' : '\n';
	return s.replace(HAZARD, (ch, i) => {
		const cp = /** @type {number} */ (ch.codePointAt(0));
		if (cp === 0x0A) { return nl; }
		if (cp === 0x09) { return '\t'; }
		if (cp === 0x0D) { return s.charCodeAt(i + 1) === 0x0A ? '' : nl; }   // CR LF: the LF writes the break
		if (cp < 0x20) { return String.fromCharCode(0x2400 + cp); }
		if (cp === 0x7F) { return '\u{2421}'; }
		if (joinsEmoji(s, i, cp) || joinsScript(s, i, cp)) { return ch; }
		return bracket(cp);
	});
}

/**
 * A command (or a path, or a name) shown to a person who is asked to approve it. Nothing is hidden and nothing
 * is rewritten except to be made visible; line breaks and tabs stay as they are, a CR is shown.
 * @param {unknown} text
 * @returns {string}
 */
function forDisplay(text) {
	return textOf(text).replace(HAZARD, (ch) => {
		const cp = /** @type {number} */ (ch.codePointAt(0));
		if (cp === 0x0A || cp === 0x09) { return ch; }
		if (cp < 0x20) { return String.fromCharCode(0x2400 + cp); }
		if (cp === 0x7F) { return '\u{2421}'; }
		return bracket(cp);
	});
}

/**
 * A name, a path or a reason put INSIDE a note ("[LevelCode Shell: ...]"): what forDisplay makes of it, and on one
 * line. A note is the shell's own voice; a file called "a\n[LevelCode Shell: all applied]" must not be able to
 * add a line to it.
 * @param {unknown} text
 * @returns {string}
 */
function forNote(text) {
	return forDisplay(text).replace(/\n/g, '\u{240A}').replace(/\t/g, '\u{2409}');
}

/**
 * One property of anything, without being able to throw: a getter that throws, a Proxy whose traps throw and a
 * revoked Proxy are all `undefined`. A primitive has no properties of its own to offer here, so it is `undefined` too.
 * @param {unknown} o @param {string} key @returns {any}
 */
function safeGet(o, key) {
	try {
		return o !== null && (typeof o === 'object' || typeof o === 'function') ? /** @type {any} */ (o)[key] : undefined;
	} catch { return undefined; }
}

/** What stands in for a reason when there is none to give: the thrown value was nothing, or no text. */
const NO_REASON = 'no reason was given';

/**
 * What a thrown value says, as the reason in a one-line note: its `message` when it has one that can be read, else
 * its own text; made safe like any name (forNote), cut to `max` UTF-16 units, never empty, never throwing. The cut is
 * made BEFORE the text is walked, so a provider that throws a multi-megabyte message costs a slice and not a scan.
 * @param {unknown} e @param {number} [max]
 * @returns {string}
 */
function safeMessage(e, max = 160) {
	const m = safeGet(e, 'message');
	// `m ? m : e` is the old `(e && e.message) || e`: a message that is empty or not there falls back to the value.
	const raw = textOf(m ? m : e);
	const cut = raw.length > max * 8 ? raw.slice(0, max * 8) : raw;   // forNote can make a character eight long
	let out = forNote(cut).slice(0, max);
	// A cut that ends inside a surrogate pair would leave half of one.
	const last = out.charCodeAt(out.length - 1);
	if (out.length === max && last >= 0xD800 && last <= 0xDBFF) { out = out.slice(0, -1); }
	return out === '' ? NO_REASON : out;
}

module.exports = { forTerminal, forDisplay, forNote, safeMessage, safeGet };
