// The line editor behind the LevelCode Shell prompt. Pure: it never touches vscode. Key events come in from the input
// parser, bytes go out through host.write, and the Pseudoterminal wires the rest.
//
// Model. A buffer of code points, a cursor, the history position, and "where the terminal's cursor is, in rows below
// the first row I drew" (cursorRow). EVERY change redraws the editing region: go up to its first row, column 0, erase
// down, write prompt + text, go back to the cursor. The terminal wraps long lines by itself, so the layout must agree
// with it about cell widths (width.js is derived from xterm) and about the last column. What was measured against
// real xterm (CPR on the real thing; shell-terminal-line-editor.test.js replays the same cases through a model of it):
//   - a character written in the last column does not wrap until the NEXT one arrives ("pending wrap");
//   - a wide character that does not fit moves to the next row and leaves the last cell empty;
//   - a row filled exactly leaves the cursor pending: at the END of the buffer the editor forces the wrap (a space
//     and a carriage return, as readline does) so the cursor has a row of its own; the row it makes is "phantom" and
//     becomes the next line when Enter is pressed (no blank row between the command and its output);
//   - a TAB is drawn as spaces up to the next multiple of 8 (a raw tab only moves the cursor, and moves it BACK from
//     a pending wrap), so every cell is one the editor wrote.
// A cursor before a newline at the end of a full row has no cell of its own: it is shown on the row's last cell.
//
// A region taller than the panel cannot be redrawn by moving up (the terminal clamps at its top row), so then only a
// window of `rows` rows around the cursor is drawn and the window follows the cursor.
// @ts-check
'use strict';

const { cpWidth, strWidth, stripEscapes } = require('./width');
const { DEFAULT_MAX_PASTE } = require('./input-parser');

const CSI = '\x1b[';
const ZWJ = '\u200d';
const BIDI = /[\u202a-\u202e\u2066-\u2069]/;
const WORD = /[\p{L}\p{N}\p{M}_]/u;
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

/**
 * What may enter the buffer: tabs and newlines, and printable text. Controls, DEL, C1 and the bidi overrides are
 * dropped, so what is on screen is what will run.
 * @param {string} s
 * @returns {string[]} code points
 */
function cleanText(s) {
	const cps = [];
	for (const ch of s) {
		const cp = /** @type {number} */ (ch.codePointAt(0));
		if (ch === '\n' || ch === '\t') { cps.push(ch); continue; }
		if (cp < 0x20 || (cp >= 0x7f && cp <= 0x9f) || BIDI.test(ch)) { continue; }
		cps.push(ch);
	}
	return cps;
}

/**
 * @typedef {{ text: string, display?: string, dir?: boolean }} Candidate
 * @typedef {{
 *   write(s: string): void,
 *   prompt(): string,
 *   continuation?: string,
 *   marks?: { start: string, end: string },
 *   columns?: number,
 *   rows?: number,
 *   history?: () => readonly string[],
 *   isComplete?: (src: string) => { complete: boolean },
 *   complete?: (line: string, cursor: number) => Promise<{ start: number, candidates: Candidate[] } | null | undefined>,
 *   onSubmit: (src: string) => void,
 *   onEof?: () => void,
 *   maxPaste?: number,
 * }} EditorHost
 */

class LineEditor {
	/** @param {EditorHost} host */
	constructor(host) {
		this.host = host;
		this.cols = Math.max(2, host.columns || 80);
		this.rows = Math.max(2, host.rows || 24);
		this.cont = host.continuation === undefined ? '> ' : host.continuation;
		this.maxPaste = host.maxPaste || DEFAULT_MAX_PASTE;
		/** @type {string[]} code points */
		this.buf = [];
		this.cur = 0;
		this.hi = -1;                // the history entry shown, or -1 for the line being typed
		this.draft = '';             // the live line, kept while a history entry is shown
		this.kill = '';              // the kill ring: one entry
		this.cursorRow = 0;          // rows between the first row drawn and the terminal cursor
		this.winTop = 0;             // first row of the region that is drawn (0 unless the region is taller than the panel)
		this.lastRow = 0;            // last row of the region that was written
		this.targetRow = 0;          // the row the cursor was left on, in region rows
		this.cursorLine = 0;         // which logical line (separated by a newline in the buffer) the cursor is on
		this.cursorRowInLine = 0;    // rows between the first row of that line and the cursor
		this.phantom = false;        // the cursor is on a row made by forcing a wrap
		this.fresh = false;          // the next draw starts a prompt: write the prompt marks with it
		this.active = false;         // a prompt is waiting for input
		this.lastTab = false;        // the previous event was a Tab that had nothing to add
		this.version = 0;            // counts events, so an answer to a Tab that arrives late can be told from a current one
	}

	/* ------------------------------------------------------------------------------------------------ layout */

	_promptText() { return String(this.host.prompt()); }

	/**
	 * Where every code point of the whole region lands, and the rows.
	 * @returns {{ pos: Array<{ row: number, col: number }>, wid: number[], end: { row: number, col: number }, forced: boolean, lines: Array<{ row: number, idx: number }> }}
	 */
	_layout() {
		const cols = this.cols;
		const n = this.buf.length;
		const pos = new Array(n + 1);
		const wid = new Array(n);
		/** @type {Array<{ row: number, idx: number }>} */
		const lines = [];
		let row = 0;
		let col = 0;
		/** @param {number} w */
		const cell = (w) => {
			if (w > 0 && col + w > cols) { row++; col = 0; }
			const at = { row, col };
			col += w;
			return at;
		};
		/** @param {string} text */
		const prompt = (text) => { for (const ch of stripEscapes(text)) { cell(cpWidth(/** @type {number} */ (ch.codePointAt(0)))); } };

		lines.push({ row: 0, idx: 0 });
		prompt(this._promptText());
		for (let i = 0; i < n; i++) {
			const ch = this.buf[i];
			if (ch === '\n') {
				pos[i] = { row, col };
				wid[i] = 0;
				row++;
				col = 0;
				lines.push({ row, idx: i + 1 });
				prompt(this.cont);
			} else if (ch === '\t') {
				if (col >= cols) { row++; col = 0; }
				const w = 8 - (col % 8);
				pos[i] = { row, col };
				wid[i] = w;
				for (let k = 0; k < w; k++) { cell(1); }
			} else {
				const w = cpWidth(/** @type {number} */ (ch.codePointAt(0)));
				pos[i] = cell(w);
				wid[i] = w;
			}
		}
		pos[n] = { row, col };
		return { pos, wid, end: pos[n], forced: col >= cols, lines };
	}

	/** @param {ReturnType<LineEditor['_layout']>} L */
	_target(L) {
		const n = this.buf.length;
		const p = L.pos[this.cur];
		if (this.cur === n && L.forced) { return { row: p.row + 1, col: 0 }; }
		if (p.col >= this.cols) { return { row: p.row, col: this.cols - 1 }; }
		return p;
	}

	/* ------------------------------------------------------------------------------------------------ drawing */

	/** @param {boolean} [clear] also clear the screen first (Ctrl+L) */
	_draw(clear) {
		const L = this._layout();
		const n = this.buf.length;
		const target = this._target(L);
		const endRow = L.end.row;
		const phantom = L.forced && this.cur === n;
		const lastRow = phantom ? endRow + 1 : endRow;

		let winTop = this.winTop;
		let winBottom;
		if (lastRow + 1 <= this.rows) {
			winTop = 0;
			winBottom = lastRow;
		} else {
			if (target.row < winTop) { winTop = target.row; }
			if (target.row > winTop + this.rows - 1) { winTop = target.row - this.rows + 1; }
			winTop = Math.max(0, Math.min(winTop, lastRow - this.rows + 1));
			winBottom = winTop + this.rows - 1;
		}

		let out = '';
		if (clear) {
			out += CSI + '2J' + CSI + 'H';
			this.cursorRow = 0;
		}
		if (this.cursorRow > 0) { out += CSI + this.cursorRow + 'A'; }
		out += '\r' + CSI + 'J';

		let first = true;
		for (let li = 0; li < L.lines.length; li++) {
			const startIdx = L.lines[li].idx;
			const endIdx = li + 1 < L.lines.length ? L.lines[li + 1].idx - 1 : n;
			const promptRow = L.lines[li].row;
			if (L.pos[endIdx].row < winTop) { continue; }
			if (promptRow > winBottom) { break; }
			if (!first) { out += '\r\n'; }
			first = false;
			if (promptRow >= winTop) {
				if (li === 0) {
					const marks = this.fresh && this.host.marks;
					out += (marks ? marks.start : '') + this._promptText() + (marks ? marks.end : '');
				} else {
					out += this.cont;
				}
			}
			for (let k = startIdx; k < endIdx; k++) {
				const p = L.pos[k];
				if (p.row < winTop) { continue; }
				if (p.row > winBottom) { break; }
				out += this.buf[k] === '\t' ? ' '.repeat(L.wid[k]) : this.buf[k];
			}
		}

		let written;
		if (winBottom >= endRow) {
			written = endRow;
			if (phantom) { out += ' '; written = endRow + 1; }
		} else {
			written = winBottom;
		}
		const up = written - target.row;
		out += '\r';
		if (up > 0) { out += CSI + up + 'A'; }
		if (target.col > 0) { out += CSI + target.col + 'C'; }

		let line = 0;
		while (line + 1 < L.lines.length && L.lines[line + 1].idx <= this.cur) { line++; }
		this.cursorLine = line;
		this.cursorRowInLine = target.row - L.lines[line].row;
		this.winTop = winTop;
		this.cursorRow = target.row - winTop;
		this.lastRow = written;
		this.targetRow = target.row;
		this.phantom = phantom;
		this.fresh = false;
		this.host.write(out);
	}

	/**
	 * Leave the cursor at column 0 of a row below everything that was edited, ready for output. The cursor is first
	 * taken to the end of the buffer by the callers that need it.
	 */
	_finishRegion() {
		const down = this.lastRow - this.targetRow;
		let s = down > 0 ? CSI + down + 'B' : '';
		s += this.phantom ? '\r' + CSI + 'K' : '\r\n';     // a phantom row is the row output starts on
		this.host.write(s);
		this.cursorRow = 0;
		this.winTop = 0;
		this.phantom = false;
	}

	/* ------------------------------------------------------------------------------------------------ lifecycle */

	/** Begin a new prompt on a row of its own. The cursor must be at column 0. */
	start() {
		this.buf = [];
		this.cur = 0;
		this.hi = -1;
		this.draft = '';
		this.cursorRow = 0;
		this.winTop = 0;
		this.fresh = true;
		this.lastTab = false;
		this.active = true;
		this._draw();
	}

	/**
	 * @param {number} cols
	 * @param {number} rows
	 */
	resize(cols, rows) {
		const c = Math.max(2, Math.floor(cols) || this.cols);
		const r = Math.max(2, Math.floor(rows) || this.rows);
		if (c === this.cols && r === this.rows) { return; }
		const widthChanged = c !== this.cols;
		this.cols = c;
		this.rows = r;
		if (!this.active) { return; }
		if (widthChanged) {
			// The workbench leaves the line the cursor is on exactly as it was (xterm's reflowCursorLine is off: shells
			// redraw it themselves) and re-wraps every other row. So the rows above the cursor's line are counted with the
			// new width, and the rows of the cursor's own line are the ones that were drawn.
			if (this.winTop === 0 && this.lastRow + 1 <= this.rows) {
				const L = this._layout();
				const line = Math.min(this.cursorLine, L.lines.length - 1);
				this.cursorRow = L.lines[line].row + this.cursorRowInLine;
			} else {
				this.winTop = 0;
				this.cursorRow = Math.min(this.cursorRow, this.rows - 1);
			}
		}
		this._draw();
	}

	text() { return this.buf.join(''); }

	/** Replace the buffer (a history entry, a draft). It is cleaned like anything typed: the store it came from is not trusted. @param {string} s */
	setText(s) {
		this.buf = cleanText(s);
		this.cur = this.buf.length;
	}

	/* ------------------------------------------------------------------------------------------------ input */

	/** @param {any[]} events from the input parser */
	input(events) {
		for (const e of events) {
			if (!this.active) { return; }
			this._event(e);
		}
	}

	/** @param {any} e */
	_event(e) {
		if (e.t === 'ignored') { return; }        // a report from the workbench: not the person typing
		const wasTab = this.lastTab;
		this.lastTab = false;
		this.version++;
		switch (e.t) {
			case 'text': this._insert(e.s); break;
			case 'paste': this._paste(e); break;
			case 'key': this._key(e, wasTab); break;
			default: break;
		}
	}

	/**
	 * Replace `remove` code points at `at` with `items`. Not splice(...items): a paste can be 100,000 code points, which
	 * is more arguments than a call can carry on a small stack.
	 * @param {number} at @param {number} remove @param {string[]} items
	 */
	_put(at, remove, items) {
		this.buf = this.buf.slice(0, at).concat(items, this.buf.slice(at + remove));
	}

	/** @param {string} s */
	_insert(s) {
		const cps = cleanText(s);
		if (!cps.length) { return; }
		this._put(this.cur, 0, cps);
		this.cur += cps.length;
		this._draw();
	}

	/** @param {{ s: string, size?: number }} e */
	_paste(e) {
		const size = e.size === undefined ? e.s.length : e.size;
		if (size > this.maxPaste) {
			this._notice('paste not inserted: ' + size + ' characters is over the limit of ' + this.maxPaste);
			return;
		}
		this._insert(e.s.replace(/\r\n?/g, '\n'));
	}

	/** Print a dim line below the edited text and put the prompt back under it. @param {string} text */
	_notice(text) {
		this._finishRegion();
		this.host.write(DIM + text + RESET + '\r\n');
		this._draw();
	}

	/**
	 * @param {any} e
	 * @param {boolean} wasTab
	 */
	_key(e, wasTab) {
		const k = e.key;
		const word = !!(e.ctrl || e.alt);
		switch (k) {
			case 'enter': return this._enter();
			case 'backspace':
				if (e.ctrl || e.alt) { return this._killWordBack(false); }
				return this._deleteBack();
			case 'delete': return word ? this._killWordForward() : this._deleteForward();
			case 'left': return word ? this._moveTo(this._wordLeft()) : this._moveTo(this._prev(this.cur));
			case 'right': return word ? this._moveTo(this._wordRight()) : this._moveTo(this._next(this.cur));
			case 'home': return this._moveTo(this._lineStart(this.cur));
			case 'end': return this._moveTo(this._lineEnd(this.cur));
			case 'up': return this._up();
			case 'down': return this._down();
			case 'tab':
				if (e.shift) { return; }
				this._tab(wasTab).catch(() => { /* a completion that failed completes nothing */ });
				return;
			case 'escape': case 'pageup': case 'pagedown': case 'insert': return;
			default: break;
		}
		if (e.ctrl && !e.alt) { return this._ctrl(k); }
		if (e.alt && !e.ctrl) { return this._alt(k); }
	}

	/** @param {string} k */
	_ctrl(k) {
		switch (k) {
			case 'a': return this._moveTo(this._lineStart(this.cur));
			case 'e': return this._moveTo(this._lineEnd(this.cur));
			case 'b': return this._moveTo(this._prev(this.cur));
			case 'f': return this._moveTo(this._next(this.cur));
			case 'p': return this._up();
			case 'n': return this._down();
			case 'k': return this._killToEnd();
			case 'u': return this._killToStart();
			case 'w': return this._killWordBack(true);
			case 'y': if (this.kill) { this._insert(this.kill); } return;
			case 'l': this.fresh = true; this._draw(true); return;
			case 'c': this._abort(); return;
			case 'd':
				if (this.buf.length === 0) { if (this.host.onEof) { this.host.onEof(); } return; }
				return this._deleteForward();
			case 't': return this._transpose();
			default: return;
		}
	}

	/** @param {string} k */
	_alt(k) {
		switch (k) {
			case 'b': return this._moveTo(this._wordLeft());
			case 'f': return this._moveTo(this._wordRight());
			case 'd': return this._killWordForward();
			default: return;
		}
	}

	/* ------------------------------------------------------------------------------------------------ cursor */

	/** @param {string} ch a character that is part of the cell before it (a mark, a ZWJ, a variation selector) */
	_zeroWidth(ch) {
		return ch !== '\n' && ch !== '\t' && cpWidth(/** @type {number} */ (ch.codePointAt(0))) === 0;
	}

	/** Start of the cluster before i: a character with the marks after it, and a joined ZWJ sequence. @param {number} i */
	_prev(i) {
		if (i <= 0) { return 0; }
		let j = i - 1;
		for (;;) {
			while (j > 0 && this._zeroWidth(this.buf[j])) { j--; }
			if (j > 0 && this.buf[j - 1] === ZWJ) { j--; continue; }
			return j;
		}
	}

	/** End of the cluster at i. @param {number} i @returns {number} */
	_next(i) {
		const n = this.buf.length;
		if (i >= n) { return n; }
		let j = i + 1;
		while (j < n && this._zeroWidth(this.buf[j])) { j++; }
		if (this.buf[j - 1] === ZWJ && j < n) { return this._next(j); }
		return j;
	}

	/** @param {number} i */
	_lineStart(i) { let j = i; while (j > 0 && this.buf[j - 1] !== '\n') { j--; } return j; }
	/** @param {number} i */
	_lineEnd(i) { let j = i; while (j < this.buf.length && this.buf[j] !== '\n') { j++; } return j; }

	/** @param {string} ch */
	_isWord(ch) { return WORD.test(ch); }

	_wordLeft() {
		let i = this.cur;
		while (i > 0 && !this._isWord(this.buf[i - 1])) { i--; }
		while (i > 0 && this._isWord(this.buf[i - 1])) { i--; }
		return i;
	}

	_wordRight() {
		const n = this.buf.length;
		let i = this.cur;
		while (i < n && !this._isWord(this.buf[i])) { i++; }
		while (i < n && this._isWord(this.buf[i])) { i++; }
		return i;
	}

	/** @param {number} i */
	_moveTo(i) {
		if (i !== this.cur) { this.cur = i; this._draw(); }
	}

	_up() {
		const ls = this._lineStart(this.cur);
		if (ls > 0) {                                     // there is a line above in the buffer: move into it
			const col = this.cur - ls;
			const prevEnd = ls - 1;
			this.cur = Math.min(this._lineStart(prevEnd) + col, prevEnd);
			this._draw();
			return;
		}
		this._historyMove(-1);
	}

	_down() {
		const le = this._lineEnd(this.cur);
		if (le < this.buf.length) {                       // there is a line below
			const col = this.cur - this._lineStart(this.cur);
			const nextStart = le + 1;
			this.cur = Math.min(nextStart + col, this._lineEnd(nextStart));
			this._draw();
			return;
		}
		this._historyMove(1);
	}

	/* ------------------------------------------------------------------------------------------------ editing */

	/** @param {number} from @param {number} to */
	_cut(from, to) {
		if (to <= from) { return ''; }
		const s = this.buf.splice(from, to - from).join('');
		this.cur = from;
		this._draw();
		return s;
	}

	_deleteBack() {
		if (this.cur > 0) { this._cut(this._prev(this.cur), this.cur); }
	}

	_deleteForward() {
		if (this.cur < this.buf.length) { this._cut(this.cur, this._next(this.cur)); }
	}

	/** @param {boolean} blankDelimited  Ctrl+W: back to the previous blank; otherwise back to the previous non-word */
	_killWordBack(blankDelimited) {
		let i = this.cur;
		const sep = blankDelimited ? (/** @type {string} */ ch) => /\s/.test(ch) : (/** @type {string} */ ch) => !this._isWord(ch);
		while (i > 0 && sep(this.buf[i - 1])) { i--; }
		while (i > 0 && !sep(this.buf[i - 1])) { i--; }
		if (i < this.cur) { this.kill = this._cut(i, this.cur); }
	}

	_killWordForward() {
		const j = this._wordRight();
		if (j > this.cur) { this.kill = this._cut(this.cur, j); }
	}

	_killToEnd() {
		const end = this._lineEnd(this.cur);
		if (end > this.cur) { this.kill = this._cut(this.cur, end); return; }
		if (end < this.buf.length) { this._cut(end, end + 1); }       // at the end of a line: join the next one
	}

	_killToStart() {
		const start = this._lineStart(this.cur);
		if (start < this.cur) { this.kill = this._cut(start, this.cur); }
	}

	_transpose() {
		const n = this.buf.length;
		if (n < 2) { return; }
		const b = this.cur >= n ? this._prev(n) : this.cur;     // start of the second cluster
		const a = this._prev(b);
		const e = this._next(b);
		if (a === b || this.buf[a] === '\n' || this.buf[b] === '\n') { return; }
		const first = this.buf.slice(a, b);
		const second = this.buf.slice(b, e);
		this.buf.splice(a, e - a, ...second, ...first);
		this.cur = e;
		this._draw();
	}

	/* ------------------------------------------------------------------------------------------------ history */

	_historyList() { return this.host.history ? this.host.history() : []; }

	/** @param {-1 | 1} dir */
	_historyMove(dir) {
		const hist = this._historyList();
		// hi < 0 is the line being typed. The history is shared by every terminal and changes under us: it grows, so
		// "the live line" is the position after whatever the end is now, not a number remembered at the start of the
		// prompt; and it can be cleared while an entry is shown, which sends us back to the line that was being typed.
		if (this.hi >= hist.length) {
			this.hi = -1;
			this.setText(this.draft);
			this._draw();
			return;
		}
		if (!hist.length) { return; }
		const at = this.hi < 0 ? hist.length : this.hi;
		const next = at + dir;
		if (next < 0 || next > hist.length) { return; }
		if (at === hist.length) { this.draft = this.buf.join(''); }
		this.hi = next === hist.length ? -1 : next;
		this.setText(next === hist.length ? this.draft : hist[next]);
		this._draw();
	}

	/* ------------------------------------------------------------------------------------------------ accept */

	_enter() {
		const src = this.buf.join('');
		const state = this.host.isComplete ? this.host.isComplete(src) : { complete: true };
		if (!state.complete) {
			// a continuation: a newline at the end of the buffer, and the continuation prompt below it
			this.buf.push('\n');
			this.cur = this.buf.length;
			this._draw();
			return;
		}
		this.cur = this.buf.length;
		this._draw();
		this._finishRegion();
		this.active = false;
		this.host.onSubmit(src);
	}

	/** Ctrl+C at the prompt: the line is abandoned, `^C` is shown, and a new prompt follows. */
	_abort() {
		this.cur = this.buf.length;
		this._draw();
		this.host.write('^C\r\n');
		this.start();
	}

	/* ------------------------------------------------------------------------------------------------ completion */

	/**
	 * @param {boolean} second the previous event was a Tab that left several candidates
	 */
	async _tab(second) {
		if (!this.host.complete) { return; }
		const version = this.version;
		const line = this.buf.join('');
		const r = await this.host.complete(line, this.cur);
		if (!this.active || version !== this.version || !r || !r.candidates || r.candidates.length === 0) { return; }
		if (!(r.start >= 0 && r.start <= this.cur)) { return; }
		const cs = r.candidates;
		const typed = this.buf.slice(r.start, this.cur).join('');
		if (cs.length === 1) {
			this._replace(r.start, cs[0].text + (cs[0].dir ? '' : ' '));
			return;
		}
		const common = cs.map((c) => c.text).reduce((a, b) => {
			let k = 0;
			while (k < a.length && k < b.length && a[k] === b[k]) { k++; }
			return a.slice(0, k);
		});
		// still ambiguous after this Tab: the next one, if nothing was typed, lists the candidates
		if (common.length > typed.length) {
			this._replace(r.start, common);
			this.lastTab = true;
			return;
		}
		if (!second) { this.lastTab = true; return; }
		this._list(cs.map((c) => (c.display !== undefined ? c.display : c.text)));
	}

	/** @param {number} start @param {string} text */
	_replace(start, text) {
		const cps = cleanText(text);
		this._put(start, this.cur - start, cps);
		this.cur = start + cps.length;
		this._draw();
	}

	/** @param {string[]} items */
	_list(items) {
		this._finishRegion();
		this.host.write(this._columns(items) + '\r\n');
		this._draw();
	}

	/** @param {string[]} items @returns {string} */
	_columns(items) {
		const w = Math.min(this.cols, Math.max(...items.map((s) => strWidth(s))) + 2);
		const per = Math.max(1, Math.floor(this.cols / w));
		const rows = [];
		for (let i = 0; i < items.length; i += per) {
			rows.push(items.slice(i, i + per).map((s) => s + ' '.repeat(Math.max(0, w - strWidth(s)))).join('').replace(/\s+$/, ''));
		}
		return rows.join('\r\n');
	}
}

module.exports = { LineEditor };
