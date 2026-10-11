// What Pseudoterminal.handleInput receives, turned into events. Pure: no vscode, no timers.
//
// Three things arrive on that channel, and they must never be confused:
//   - keys: printable text, C0 controls, CSI / SS3 sequences, a bracketed paste ESC[200~ ... ESC[201~;
//   - REPORTS the workbench's xterm types on its own when output asks for them or switches a mode on: cursor position,
//     device attributes, window size, colours, mode status, mouse and focus reports;
//   - noise: whatever a sequence cut in two or an unknown key leaves behind.
// Only the first becomes text. Text is never produced from an escape sequence or a C1 control; a sequence the table
// below does not name is reported as `ignored` and dropped, which is also what keeps the reply shapes (ESC[r;cR,
// ESC[0n, ESC[?..c, ESC[>..c, ESC[8;r;ct, ESC[?n;m$y, DCS..ST, OSC..BEL/ST) out of the line without a pattern that
// could eat a key: every key below has a final byte or a number that no report uses.
//
// Events (t = type):
//   { t:'text',  s }                       printable characters, code points kept whole
//   { t:'paste', s, size }                 a bracketed paste; `size` is the full length, `s` is '' when it was over
//                                          `maxPaste` (the editor rejects it; the bytes are not kept)
//   { t:'key',   key, ctrl?, alt?, shift?, meta? }
//                                          key: enter tab backspace delete up down left right home end pageup
//                                          pagedown insert escape, or the single character for Ctrl+x / Alt+x
//   { t:'ignored', kind }                  kind: reply mouse focus fkey unknown
//
// A chunk of plain characters with a carriage return or line feed in it ("ls\r" in one piece) is a PASTE: a person
// types one key per chunk, so a chunk that carries a line end is text from somewhere else (a terminal that ignores
// bracketed paste, another extension's sendText) and must be inserted, never executed.
// @ts-check
'use strict';

const ESC = '\x1b';
const PASTE_END = ESC + '[201~';

/** Longest CSI parameter+intermediate run kept; a longer one is junk and is swallowed to its final byte. */
const MAX_CSI = 64;
/** Longest OSC/DCS/APC body waited for. Past it the string state is abandoned so a lost terminator cannot eat keys. */
const MAX_STRING = 4096;
const DEFAULT_MAX_PASTE = 100000;

const S = { GROUND: 0, ESC: 1, CSI: 2, SS3: 3, STRING: 4, STRING_ESC: 5, X10: 6 };

/** 8-bit C1 introducers xterm treats like their 7-bit forms in UTF-8 mode. */
const C1_CSI = 0x9b;
const C1_OSC = 0x9d;
const C1_STRING = new Set([0x90, 0x98, 0x9e, 0x9f]);   // DCS SOS PM APC

/**
 * @param {string} params  "1;5" etc.
 * @returns {{ shift?: true, alt?: true, ctrl?: true, meta?: true }}
 */
function modifiers(params) {
	const parts = params.split(';');
	const m = parts.length > 1 ? Number(parts[1]) : 1;
	/** @type {{ shift?: true, alt?: true, ctrl?: true, meta?: true }} */
	const out = {};
	if (!Number.isFinite(m) || m <= 1) { return out; }
	const bits = m - 1;
	if (bits & 1) { out.shift = true; }
	if (bits & 2) { out.alt = true; }
	if (bits & 4) { out.ctrl = true; }
	if (bits & 8) { out.meta = true; }
	return out;
}

/** @param {string} key @param {object} [mods] */
function keyEvent(key, mods) { return Object.assign({ t: 'key', key }, mods); }

/**
 * @param {{ maxPaste?: number }} [options]
 */
function createInputParser(options) {
	const maxPaste = options && options.maxPaste ? options.maxPaste : DEFAULT_MAX_PASTE;

	let state = S.GROUND;
	let csi = '';              // parameter and intermediate bytes of the CSI being read
	let csiOver = false;       // the CSI outgrew MAX_CSI: swallow it, report nothing useful
	let stringLen = 0;         // bytes of the OSC/DCS/APC being swallowed
	let stringIsOsc = false;   // only an OSC ends on BEL
	let x10 = 0;               // bytes of an X10 mouse report still to swallow
	let high = '';             // a high surrogate that ended the previous chunk
	let inPaste = false;
	let pasteBuf = '';
	let pasteSize = 0;
	let pasteTail = '';        // a suffix of the chunk that may be the start of ESC[201~

	/** @type {any[]} */
	let out = [];
	let text = '';

	const flushText = () => { if (text) { out.push({ t: 'text', s: text }); text = ''; } };
	/** @param {any} e */
	const emit = (e) => { flushText(); out.push(e); };

	/** @param {string} chunk */
	function feed(chunk) {
		out = [];
		text = '';
		let s = chunk;
		if (high) { s = high + s; high = ''; }

		// One chunk of plain characters that carries a line end is a paste, never a typed line.
		if (state === S.GROUND && !inPaste && s.length > 1 && /[\r\n]/.test(s) && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/.test(s)) {
			return [{ t: 'paste', s: s.length > maxPaste ? '' : s, size: s.length }];
		}

		let i = 0;
		while (i < s.length) {
			if (inPaste) {
				const joined = pasteTail + s.slice(i);
				pasteTail = '';
				const end = joined.indexOf(PASTE_END);
				if (end >= 0) {
					takePaste(joined.slice(0, end));
					emit({ t: 'paste', s: pasteBuf, size: pasteSize });
					inPaste = false;
					pasteBuf = '';
					pasteSize = 0;
					s = joined.slice(end + PASTE_END.length);
					i = 0;
					continue;
				}
				// keep a tail that might be the beginning of the terminator
				let keep = 0;
				for (let n = Math.min(PASTE_END.length - 1, joined.length); n > 0; n--) {
					if (PASTE_END.startsWith(joined.slice(joined.length - n))) { keep = n; break; }
				}
				takePaste(joined.slice(0, joined.length - keep));
				pasteTail = joined.slice(joined.length - keep);
				i = s.length;
				break;
			}

			const c = s[i];
			const cp = /** @type {number} */ (s.codePointAt(i));
			i++;

			switch (state) {
				case S.GROUND: {
					if (c === ESC) { state = S.ESC; break; }
					if (cp >= 0x80 && cp <= 0x9f) {
						if (cp === C1_CSI) { startCsi(); } else if (cp === C1_OSC) { startString(true); } else if (C1_STRING.has(cp)) { startString(false); } else { emit({ t: 'ignored', kind: 'unknown' }); }
						break;
					}
					if (cp < 0x20 || cp === 0x7f) { control(cp); break; }
					if (cp > 0xffff) { text += String.fromCodePoint(cp); i++; break; }
					if (cp >= 0xd800 && cp <= 0xdbff) {
						if (i >= s.length) { high = c; }                              // its pair arrives with the next chunk
						break;                                                        // a lone surrogate is never text
					}
					if (cp >= 0xdc00 && cp <= 0xdfff) { break; }
					text += c;
					break;
				}
				case S.ESC: {
					if (c === '[') { startCsi(); break; }
					if (c === ']') { startString(true); break; }
					if (c === 'P' || c === 'X' || c === '^' || c === '_') { startString(false); break; }
					if (c === 'O') { state = S.SS3; break; }
					if (c === ESC) { emit(keyEvent('escape')); break; }                // the first ESC was a key; this one begins a sequence
					state = S.GROUND;
					if (cp === 0x7f) { emit(keyEvent('backspace', { alt: true })); break; }
					if (cp === 0x0d || cp === 0x0a) { emit(keyEvent('enter', { alt: true })); break; }
					if (cp < 0x20 || (cp >= 0x80 && cp <= 0x9f)) { emit({ t: 'ignored', kind: 'unknown' }); break; }
					if (cp > 0xffff) { i++; }
					emit(keyEvent(String.fromCodePoint(cp), { alt: true }));
					break;
				}
				case S.CSI: {
					if ((cp >= 0x30 && cp <= 0x3f) || (cp >= 0x20 && cp <= 0x2f)) {
						if (csi.length < MAX_CSI) { csi += c; } else { csiOver = true; }
						break;
					}
					if (cp >= 0x40 && cp <= 0x7e) { state = S.GROUND; dispatchCsi(csi, c); break; }
					// a control or ESC inside a CSI abandons it; the character itself is handled afresh
					state = S.GROUND;
					emit({ t: 'ignored', kind: 'unknown' });
					i--;
					break;
				}
				case S.SS3: {
					state = S.GROUND;
					const k = ss3(c);
					if (k) { emit(k); } else if (c === ESC) { i--; emit({ t: 'ignored', kind: 'unknown' }); } else { emit({ t: 'ignored', kind: 'fkey' }); }
					break;
				}
				case S.STRING: {
					if (c === ESC) { state = S.STRING_ESC; break; }
					if (c === '\x07' && stringIsOsc) { state = S.GROUND; emit({ t: 'ignored', kind: 'reply' }); break; }
					if (cp === 0x9c) { state = S.GROUND; emit({ t: 'ignored', kind: 'reply' }); break; }
					if (++stringLen > MAX_STRING) { state = S.GROUND; emit({ t: 'ignored', kind: 'unknown' }); }
					break;
				}
				case S.STRING_ESC: {
					if (c === '\\') { state = S.GROUND; emit({ t: 'ignored', kind: 'reply' }); break; }
					// ESC inside a string that is not ST: the string is cut off and this is a fresh escape
					state = S.ESC;
					emit({ t: 'ignored', kind: 'unknown' });
					i--;
					break;
				}
				case S.X10: {
					if (--x10 <= 0) { state = S.GROUND; emit({ t: 'ignored', kind: 'mouse' }); }
					break;
				}
				default: break;
			}
		}
		flushText();
		return out;
	}

	/** The text of a paste is kept up to the cap; past it nothing is kept (only the size), so a huge paste costs no memory. @param {string} piece */
	function takePaste(piece) {
		pasteSize += piece.length;
		if (pasteSize <= maxPaste) { pasteBuf += piece; } else { pasteBuf = ''; }
	}

	function startCsi() { state = S.CSI; csi = ''; csiOver = false; }
	/** @param {boolean} osc */
	function startString(osc) { state = S.STRING; stringLen = 0; stringIsOsc = osc; }

	/** @param {number} cp */
	function control(cp) {
		switch (cp) {
			case 0x0d: case 0x0a: emit(keyEvent('enter')); return;
			case 0x09: emit(keyEvent('tab')); return;
			case 0x7f: emit(keyEvent('backspace')); return;
			case 0x08: emit(keyEvent('backspace', { ctrl: true })); return;   // Ctrl+Backspace and Ctrl+H
			case 0x00: emit({ t: 'ignored', kind: 'unknown' }); return;
			default:
				if (cp <= 0x1a) { emit(keyEvent(String.fromCharCode(cp + 96), { ctrl: true })); return; }   // 0x01 -> Ctrl+A
				emit(keyEvent(String.fromCharCode(cp + 64), { ctrl: true }));                                  // 0x1c -> Ctrl+\
		}
	}

	/**
	 * @param {string} params  parameter and intermediate bytes
	 * @param {string} final
	 */
	function dispatchCsi(params, final) {
		if (csiOver) { emit({ t: 'ignored', kind: 'unknown' }); return; }
		const first = params[0];
		const hasInter = /[ -/]/.test(params);
		if (hasInter) { emit({ t: 'ignored', kind: 'reply' }); return; }                     // DECRPM (ESC[?n;m$y) and friends
		if (first === '<') { emit({ t: 'ignored', kind: 'mouse' }); return; }                // SGR mouse ESC[<b;x;yM|m
		if (first === '?' || first === '>' || first === '=') { emit({ t: 'ignored', kind: 'reply' }); return; }
		if (params === '' && final === 'M') { state = S.X10; x10 = 3; return; }              // X10 mouse: three more bytes
		if (params === '' && (final === 'I' || final === 'O')) { emit({ t: 'ignored', kind: 'focus' }); return; }
		if (final === '~') {
			const n = Number(params.split(';')[0]);
			if (n === 200 && params === '200') { inPaste = true; pasteBuf = ''; pasteSize = 0; pasteTail = ''; return; }
			if (n === 201 && params === '201') { return; }                                      // a stray end marker
			const mods = modifiers(params);
			switch (n) {
				case 1: case 7: emit(keyEvent('home', mods)); return;
				case 2: emit(keyEvent('insert', mods)); return;
				case 3: emit(keyEvent('delete', mods)); return;
				case 4: case 8: emit(keyEvent('end', mods)); return;
				case 5: emit(keyEvent('pageup', mods)); return;
				case 6: emit(keyEvent('pagedown', mods)); return;
				default: emit({ t: 'ignored', kind: 'fkey' }); return;
			}
		}
		if (!/^[0-9;:]*$/.test(params)) { emit({ t: 'ignored', kind: 'unknown' }); return; }
		const mods = modifiers(params);
		switch (final) {
			case 'A': emit(keyEvent('up', mods)); return;
			case 'B': emit(keyEvent('down', mods)); return;
			case 'C': emit(keyEvent('right', mods)); return;
			case 'D': emit(keyEvent('left', mods)); return;
			case 'H': emit(keyEvent('home', mods)); return;
			case 'F': emit(keyEvent('end', mods)); return;
			case 'Z': emit(keyEvent('tab', { shift: true })); return;
			case 'P': case 'Q': case 'S': emit({ t: 'ignored', kind: 'fkey' }); return;
			case 'R': case 'c': case 'n': case 't': case 'y': emit({ t: 'ignored', kind: 'reply' }); return;   // CPR, DA, DSR, window ops
			case 'u': emit({ t: 'ignored', kind: 'fkey' }); return;                                           // CSI u (kitty keyboard)
			default: emit({ t: 'ignored', kind: 'unknown' });
		}
	}

	/** @param {string} c */
	function ss3(c) {
		switch (c) {
			case 'A': return keyEvent('up');
			case 'B': return keyEvent('down');
			case 'C': return keyEvent('right');
			case 'D': return keyEvent('left');
			case 'H': return keyEvent('home');
			case 'F': return keyEvent('end');
			default: return null;
		}
	}

	/**
	 * The chunk ended inside a sequence and nothing more came: a lone ESC is the Escape key, a paste is what has
	 * arrived of it, anything else is noise and is dropped.
	 */
	function flush() {
		out = [];
		text = '';
		const was = state;
		const wasPaste = inPaste;
		state = S.GROUND;
		csi = '';
		x10 = 0;
		high = '';
		if (wasPaste) {
			takePaste(pasteTail);
			inPaste = false;
			out.push({ t: 'paste', s: pasteBuf, size: pasteSize });
			pasteBuf = '';
			pasteSize = 0;
			pasteTail = '';
		} else if (was === S.ESC) {
			out.push(keyEvent('escape'));
		} else if (was !== S.GROUND) {
			out.push({ t: 'ignored', kind: 'unknown' });
		}
		return out;
	}

	const hasPending = () => state !== S.GROUND || inPaste || high !== '';

	return { feed, flush, hasPending };
}

module.exports = { createInputParser, DEFAULT_MAX_PASTE };
