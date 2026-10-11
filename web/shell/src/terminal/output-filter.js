// What may reach the terminal from COMMAND OUTPUT. Pure: a streaming sanitiser, no vscode, no timers.
//
// Why it exists (MEASURED in the release build): the workbench's xterm answers a long list of queries by typing the
// reply into the pty's input (cursor position, device attributes, colours, window size, mode status ...), so a `cat`
// of a hostile file can put text on the next prompt; it honours modes that change what the keyboard and the mouse
// send (application cursor keys, mouse tracking, focus reporting, bracketed paste), it takes titles, and it believes
// OSC 633 shell-integration sequences (only the nonce marks them trusted, and output must never carry the nonce).
//
// The policy is an ALLOW list, applied to a stream in any chunking:
//   text (code points kept whole), \t \b \r, \n (a bare LF becomes CRLF, an existing CRLF is left alone),
//   SGR (CSI .. m), the cursor/erase finals  A B C D E F G H f J(0-2) K L M P @ X S T s u,
//   CSI ?25 h|l (cursor visibility), and OSC 8 hyperlinks to http, https and mailto only.
// Everything else is dropped, not escaped (a dropped sequence leaves nothing on screen): every other CSI, any CSI with
// a private prefix (? > = <) or an intermediate byte, device and status queries, DCS/APC/PM/SOS, every other OSC,
// two-character escapes (RIS, charsets, keypad modes), C0 other than the four, DEL, C1, and the bidi controls.
// The 8-bit introducers (U+009B CSI, U+009D OSC, DCS/SOS/PM/APC) are read as the sequences xterm takes them for, and
// dropped with their bodies, so no half of one is left to print.
// Auto-wrap (?7) is dropped on purpose: the line editor's row arithmetic assumes the terminal wraps.
//
// Soundness: a character passes only from the ground state and only if it is printable or one of \t \b \r \n; a
// sequence is written only when it has been read to its end and every byte of it is on the list. So after every
// write the terminal is back in its ground state, whatever the input was. An unterminated OSC/DCS is NOT bounded in
// what it swallows: like in a real terminal it eats every later byte until a BEL/ST/ESC, or until the command ends
// (end() resets it) — the 4096 limit below bounds memory, not the damage.
// @ts-check
'use strict';

const ESC = '\x1b';
const ST = ESC + '\\';
/** Longest OSC body that is kept to be checked (an OSC 8 URI is at most 2048). Past it the body is just swallowed. */
const MAX_BODY = 4096;
/** Longest CSI parameter run kept. A longer one is dropped whole, never cut. */
const MAX_CSI = 64;
/** A numeric CSI parameter above this is not something a program prints; dropping it keeps a `CSI 99999999 L` out. */
const MAX_PARAM = 9999;

const CSI_PASS = new Set(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'f', 'J', 'K', 'L', 'M', 'P', '@', 'X', 'S', 'T', 's', 'u']);
const URI_OK = /^(?:https?|mailto):[\x21-\x7e]*$/i;
const OSC8_PARAMS = /^[A-Za-z0-9=:_.-]{0,64}$/;
/** A run of characters that pass without any decision: everything but C0, DEL, C1 and the bidi controls. */
const RUN = /[^\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]+/y;

const S = { GROUND: 0, ESC: 1, CSI: 2, OSC: 3, STRING: 4, STRING_ESC: 5, ESC_BYTE: 6 };

/**
 * A character budget that several filters can share (stdout and stderr of one command draw on one cap).
 * @param {number} [max]
 * @returns {{ used: number, max: number, full: boolean }}
 */
function createBudget(max) {
	return { used: 0, max: max === undefined ? Infinity : max, full: false };
}

/**
 * @param {{ maxChars?: number, budget?: { used: number, max: number, full: boolean } }} [options]
 *   maxChars: stop emitting after this many characters; budget: the same, shared with other filters.
 *   Sequences are never cut: output stops at a character or sequence boundary.
 */
function createOutputFilter(options) {
	const budget = options && options.budget ? options.budget : createBudget(options && options.maxChars);

	let state = S.GROUND;
	let csi = '';
	let csiOver = false;
	let body = '';            // the OSC body being read (kept up to MAX_BODY)
	let bodyOver = false;
	let isOsc = false;        // inside OSC (BEL ends it) as opposed to DCS/APC/PM/SOS (only ST ends them)
	let lastCR = false;       // the last character written was a CR (so a following LF is already a CRLF)
	let atLineStart = true;   // nothing written yet, or the last character written was LF
	let discarded = 0;        // input characters that arrived after the cap was reached
	// terminal state this stream has changed and end() must put back
	let sgrOpen = false;
	let linkOpen = false;
	let cursorHidden = false;

	/** @param {string} chunk @returns {string} what to write for it */
	function write(chunk) {
		if (budget.full) { discarded += chunk.length; return ''; }
		let out = '';

		/** @param {string} tok one complete token; false when the cap stops us */
		const put = (tok) => {
			if (budget.used + tok.length > budget.max) {
				budget.full = true;
				return false;
			}
			out += tok;
			budget.used += tok.length;
			return true;
		};

		let i = 0;
		for (; i < chunk.length; i++) {
			if (state === S.GROUND) {
				RUN.lastIndex = i;
				const m = RUN.exec(chunk);
				if (m) {
					let run = m[0];
					const room = budget.max - budget.used;
					if (run.length > room) {
						// never cut a surrogate pair in two
						let cut = Math.max(0, room);
						const code = run.charCodeAt(cut - 1);
						if (cut > 0 && code >= 0xd800 && code <= 0xdbff) { cut--; }
						run = run.slice(0, cut);
						out += run;
						budget.used += run.length;
						if (run !== '') { lastCR = false; atLineStart = false; }
						budget.full = true;
						i += run.length;
						break;
					}
					out += run;
					budget.used += run.length;
					lastCR = false;
					atLineStart = false;
					i += run.length - 1;
					continue;
				}
			}
			const c = chunk[i];
			switch (state) {
				case S.GROUND: {
					if (c === ESC) { state = S.ESC; break; }
					if (c === '\n') {
						if (!put(lastCR ? '\n' : '\r\n')) { break; }
						lastCR = false;
						atLineStart = true;
						break;
					}
					if (c === '\r' || c === '\t' || c === '\b') {
						if (!put(c)) { break; }
						lastCR = c === '\r';
						atLineStart = false;
						break;
					}
					// the 8-bit forms of CSI, OSC and the string introducers are what xterm reads them as in UTF-8 mode
					if (c === '\u009b') { state = S.CSI; csi = ''; csiOver = false; break; }
					if (c === '\u009d') { state = S.OSC; body = ''; bodyOver = false; isOsc = true; break; }
					if (c === '\u0090' || c === '\u0098' || c === '\u009e' || c === '\u009f') { state = S.STRING; isOsc = false; break; }
					// another C0, DEL, another C1, a bidi control: dropped
					break;
				}
				case S.ESC: {
					if (c === '[') { state = S.CSI; csi = ''; csiOver = false; break; }
					if (c === ']') { state = S.OSC; body = ''; bodyOver = false; isOsc = true; break; }
					if (c === 'P' || c === '_' || c === '^' || c === 'X') { state = S.STRING; isOsc = false; break; }
					if (c === ESC) { break; }                                         // ESC ESC: the first is nothing
					// any other two-character escape is dropped; charset designators and ESC SP / ESC # / ESC % take one more byte
					state = '()*+#% '.includes(c) ? S.ESC_BYTE : S.GROUND;
					break;
				}
				case S.ESC_BYTE: {
					if (c === ESC) { state = S.ESC; break; }
					state = S.GROUND;
					break;
				}
				case S.CSI: {
					const cp = c.charCodeAt(0);
					if (cp >= 0x20 && cp <= 0x3f) {
						if (csi.length < MAX_CSI) { csi += c; } else { csiOver = true; }
						break;
					}
					if (cp >= 0x40 && cp <= 0x7e) {
						state = S.GROUND;
						const seq = csi;
						csi = '';
						if (csiOver || !csiPasses(seq, c)) { break; }
						if (!put(ESC + '[' + seq + c)) { break; }
						track(seq, c);
						lastCR = false;
						break;
					}
					// ESC or a control inside a CSI abandons it; the byte is read again from the ground
					state = S.GROUND;
					csi = '';
					i--;
					break;
				}
				case S.OSC: case S.STRING: {
					if (c === ESC) { state = S.STRING_ESC; break; }
					if (c === '\x18' || c === '\x1a') { body = ''; state = S.GROUND; break; }   // CAN and SUB abort a string
					if (c === '\x07' && isOsc) { finishString(put); state = S.GROUND; break; }
					if (c === '\x9c') { finishString(put); state = S.GROUND; break; }
					if (state === S.OSC) {
						if (body.length < MAX_BODY) { body += c; } else { bodyOver = true; }
					}
					break;
				}
				case S.STRING_ESC: {
					if (c === '\\') { finishString(put); state = S.GROUND; break; }
					// cut off by another escape: the string is dropped and this byte begins a new sequence
					body = '';
					state = S.ESC;
					i--;
					break;
				}
				default: break;
			}
			if (budget.full) { break; }
		}
		if (budget.full && i < chunk.length) { discarded += chunk.length - i; }
		return out;
	}

	/**
	 * @param {string} seq parameter and intermediate bytes
	 * @param {string} final
	 */
	function csiPasses(seq, final) {
		if (final === 'h' || final === 'l') { return seq === '?25'; }
		// digits and separators only: an intermediate byte or a private prefix (? > = <) makes it another sequence
		if (final === 'm') { return /^[0-9;:]*$/.test(seq); }
		if (!/^[0-9;]*$/.test(seq)) { return false; }
		if (!CSI_PASS.has(final)) { return false; }
		if (final === 'J' || final === 'K') {
			return seq === '' || seq === '0' || seq === '1' || seq === '2';          // 3J erases the scrollback
		}
		if (final === 's' || final === 'u') { return seq === ''; }
		const params = seq.split(';');
		if (params.length > (final === 'H' || final === 'f' ? 2 : 1)) { return false; }
		for (const p of params) { if (p.length > 4 || Number(p) > MAX_PARAM) { return false; } }
		return true;
	}

	/** Remember what an emitted sequence left switched on, for end(). @param {string} seq @param {string} final */
	function track(seq, final) {
		if (final === 'm') { sgrOpen = !(seq === '' || seq === '0'); return; }
		if (final === 'h' && seq === '?25') { cursorHidden = false; return; }
		if (final === 'l' && seq === '?25') { cursorHidden = true; }
	}

	/** @param {(tok: string) => boolean} put */
	function finishString(put) {
		const text = body;
		const over = bodyOver;
		body = '';
		bodyOver = false;
		if (!isOsc || over) { return; }
		const m = /^8;([^;]*);([\s\S]*)$/.exec(text);
		if (!m || !OSC8_PARAMS.test(m[1])) { return; }
		const uri = m[2];
		if (uri === '') {
			if (put(ESC + ']8;;' + ST)) { linkOpen = false; lastCR = false; }
			return;
		}
		if (uri.length > 2048 || !URI_OK.test(uri)) { return; }
		if (put(ESC + ']8;' + m[1] + ';' + uri + ST)) { linkOpen = true; lastCR = false; }
	}

	/**
	 * The command ended: abandon any open sequence and put back what the output changed (colours, a link, a hidden
	 * cursor). Returns only what is needed; a command that printed plain text returns ''.
	 */
	function end() {
		state = S.GROUND;
		csi = '';
		body = '';
		let s = '';
		if (sgrOpen) { s += ESC + '[0m'; }
		if (linkOpen) { s += ESC + ']8;;' + ST; }
		if (cursorHidden) { s += ESC + '[?25h'; }
		sgrOpen = false;
		linkOpen = false;
		cursorHidden = false;
		return s;
	}

	return {
		write,
		end,
		/** True when nothing has been written or the last character written was a line feed. */
		endsAtLineStart: () => atLineStart,
		/** Input characters that arrived after the cap was reached (the sink says how many were not shown). */
		stats: () => ({ discarded }),
	};
}

module.exports = { createOutputFilter, createBudget };
