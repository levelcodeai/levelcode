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
//
// Resize. The workbench re-wraps what is on the screen BEFORE it tells the pty, so the editor has to say where its
// cursor ended up. xterm.js is run by VS Code with `reflowCursorLine` off (the line the cursor is on is left as it
// was: a shell redraws its own line), and `resize()` below follows xterm's own loops, quirks included: see
// `_cursorRowAfterReflow`.
// @ts-check
'use strict';

const { cpWidth, strWidth, stripEscapes } = require('./width');
const { DEFAULT_MAX_PASTE } = require('./input-parser');

const CSI = '\x1b[';
/**
 * What the screen cannot show, or shows as a blank that is not one: Unicode's own "default ignorable" set (zero-width
 * space, joiners, bidi marks and overrides, soft hyphen, variation selectors, tag characters, fillers ...), lone
 * surrogates, the line and paragraph separators, the blank braille pattern and the interlinear anchors.
 */
const INVISIBLE = /[\p{Default_Ignorable_Code_Point}\p{Cs}\u2028\u2029\u2800\uFFF9-\uFFFB]/u;
const WORD = /[\p{L}\p{N}\p{M}_]/u;
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

/**
 * What may enter the buffer: tabs and newlines, and text the screen can show. Controls, DEL and C1 are dropped, and so
 * is every invisible character (INVISIBLE), so what is on screen is what will run: `rm a<ZWSP>b.txt` cannot be drawn
 * as `rm ab.txt`. The price is that a pasted word that had one (a ZWNJ in a Persian name, the joiner of a family
 * emoji) is typed without it.
 * @param {string} s
 * @returns {string[]} code points
 */
function cleanText(s) {
	const cps = [];
	for (const ch of s) {
		const cp = /** @type {number} */ (ch.codePointAt(0));
		if (ch === '\n' || ch === '\t') { cps.push(ch); continue; }
		if (cp < 0x20 || (cp >= 0x7f && cp <= 0x9f) || INVISIBLE.test(ch)) { continue; }
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
		this.cursorRow = 0;          // rows between the first row drawn and the terminal cursor (negative: above it, after a resize)
		this.winTop = 0;             // first row of the region that is drawn (0 unless the region is taller than the panel)
		this.lastRow = 0;            // last row of the region that was written
		this.targetRow = 0;          // the row the cursor was left on, in region rows
		this.phantom = false;        // the cursor is on a row made by forcing a wrap
		this.fresh = false;          // the next draw starts a prompt: write the prompt marks with it
		this.active = false;         // a prompt is waiting for input
		this.lastTab = false;        // the previous event was a Tab that had nothing to add
		this.version = 0;            // counts events, so an answer to a Tab that arrives late can be told from a current one
		/** @type {{ version: number } | null} */
		this.pendingTab = null;      // the Tab whose answer has not arrived
		this.tabQueued = false;      // a Tab came in meanwhile: it runs when that answer has been applied
	}

	/* ------------------------------------------------------------------------------------------------ layout */

	_promptText() { return String(this.host.prompt()); }

	/**
	 * Where every code point of the whole region lands, and the rows.
	 * @param {boolean} [collect] also list every cell (prompt and continuation prompts included): its line, row and width
	 * @returns {{ pos: Array<{ row: number, col: number }>, wid: number[], end: { row: number, col: number }, forced: boolean, lines: Array<{ row: number, idx: number }>, cells: Array<{ line: number, row: number, w: number }> }}
	 */
	_layout(collect) {
		const cols = this.cols;
		const n = this.buf.length;
		const pos = new Array(n + 1);
		const wid = new Array(n);
		/** @type {Array<{ row: number, idx: number }>} */
		const lines = [];
		/** @type {Array<{ line: number, row: number, w: number }>} */
		const cells = [];
		let row = 0;
		let col = 0;
		/** @param {number} w */
		const cell = (w) => {
			if (w > 0 && col + w > cols) { row++; col = 0; }
			const at = { row, col };
			col += w;
			if (collect) { cells.push({ line: lines.length - 1, row, w }); }
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
		return { pos, wid, end: pos[n], forced: col >= cols, lines, cells };
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
		// negative: a resize left the terminal's cursor above the first row of the region (see _cursorRowAfterReflow)
		if (this.cursorRow > 0) { out += CSI + this.cursorRow + 'A'; } else if (this.cursorRow < 0) { out += CSI + -this.cursorRow + 'B'; }
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
				if (this.buf[k] === '\t') {
					// The spaces of a tab that wrap past the last row drawn are not written: the terminal would scroll for
					// them, and the cursor would end a row too low.
					out += ' '.repeat(Math.min(L.wid[k], (winBottom - p.row + 1) * this.cols - p.col));
				} else {
					out += this.buf[k];
				}
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
		this.fresh = true;
		this.lastTab = false;
		this.pendingTab = null;
		this.tabQueued = false;
		this.active = true;
		this._draw();
	}

	/**
	 * The workbench has already changed the size of the terminal, and re-wrapped what was on it. Say where the cursor
	 * is now and draw the region again from its first row.
	 * @param {number} cols
	 * @param {number} rows
	 */
	resize(cols, rows) {
		const c = Math.max(2, Math.floor(cols) || this.cols);
		const r = Math.max(2, Math.floor(rows) || this.rows);
		if (c === this.cols && r === this.rows) { return; }
		// before the width changes: the layout the terminal had is the one the reflow starts from
		const reflowed = this.active && c !== this.cols;
		const row = reflowed ? this._cursorRowAfterReflow(c) : 0;
		this.cols = c;
		this.rows = r;
		if (!this.active) { return; }
		// the redraw starts at the first row that is on the screen, which is the first row of a window too
		if (reflowed) { this.cursorRow = row; }
		this._draw();
	}

	/**
	 * Where the terminal's cursor is, in rows below the first row of what is on the screen (the region, or the window
	 * of it), after xterm.js has re-wrapped the screen for a new width. Not "where the line the cursor is on starts":
	 * xterm.js (Buffer._reflowSmaller / _reflowLarger, with `reflowCursorLine` off) walks the screen's lines and moves
	 * its cursor row by the rows each one gained or lost, whichever side of the cursor the line is on. So, line by line
	 * (a line is the rows one logical line of the buffer takes on the screen, with its prompt; in a window the first
	 * and the last may be cut):
	 *   narrower: from the LAST line up. A line that was wrapped or is now too wide is re-wrapped, unless it holds the
	 *     cursor, and the cursor row is the running one: every row a lower line gained moved it down, so the line it is
	 *     on may no longer be the line that holds it. The cursor row grows by the rows the line gained.
	 *   wider: from the first line down, with the cursor row it had at the start. A wrapped line that does not hold it
	 *     is joined, and every row that was removed (below the cursor's line too) moves the cursor up. That can leave it
	 *     above the region: the answer is then negative.
	 * Known gap: xterm.js stops that at the top of its buffer, which the editor cannot see; it only matters when the
	 * region starts in the very first rows of the whole scrollback and lines under the cursor are re-joined.
	 * @param {number} cols the new width
	 * @returns {number}
	 */
	_cursorRowAfterReflow(cols) {
		const top = this.winTop;
		const before = this._layout(true);
		const cells = before.cells.filter((c) => c.row >= top && c.row <= this.lastRow);
		// the row that was made by forcing a wrap holds a space, which is part of the last line and is re-wrapped with it
		if (this.phantom) { cells.push({ line: before.lines.length - 1, row: this.lastRow, w: 1 }); }
		/** @type {Array<{ first: number, last: number, widths: number[] }>} */
		const lines = [];
		for (const c of cells) {
			let l = lines[c.line];
			if (!l) { l = lines[c.line] = { first: c.row, last: c.row, widths: [] }; }
			l.last = c.row;
			l.widths.push(c.w);
		}
		/** The rows a run of cells takes when it starts a row: a cell that does not fit goes to the next. @param {number[]} widths */
		const rowsAt = (widths) => {
			let rows = 1;
			let col = 0;
			for (const w of widths) {
				if (w > 0 && col + w > cols) { rows++; col = 0; }
				col += w;
			}
			return rows;
		};
		const on = lines.filter(Boolean);
		const start = on.map((l) => l.first - top);
		const was = on.map((l) => l.last - l.first + 1);
		const now = on.map((l) => rowsAt(l.widths));
		const holds = (/** @type {number} */ row, /** @type {number} */ k) => row >= start[k] && row < start[k] + was[k];
		let row = this.cursorRow;
		if (cols < this.cols) {
			for (let k = on.length - 1; k >= 0; k--) {
				if (was[k] === 1 && now[k] === 1) { continue; }              // not wrapped, and not too wide: not touched
				if (holds(row, k)) { continue; }
				row += Math.max(0, now[k] - was[k]);
			}
			return row;
		}
		const at = row;
		for (let k = 0; k < on.length; k++) {
			if (was[k] < 2 || holds(at, k)) { continue; }                   // only wrapped lines are joined
			row -= Math.max(0, was[k] - now[k]);
		}
		return row;
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
		if (e.t === 'key' && e.key === 'tab' && !e.shift && this.pendingTab && this.pendingTab.version === this.version) {
			// A Tab before the answer to the last one has arrived waits for it (one at most), so that Tab Tab lists even
			// when the first answer is slow. It is not an event of its own: the answer in flight is still current.
			this.tabQueued = true;
			return;
		}
		const wasTab = this.lastTab;
		this.lastTab = false;
		this.tabQueued = false;
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
				this._tab(wasTab);
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

	/** @param {string} ch a character that is part of the cell before it (a combining mark) */
	_zeroWidth(ch) {
		return ch !== '\n' && ch !== '\t' && cpWidth(/** @type {number} */ (ch.codePointAt(0))) === 0;
	}

	/** Start of the cluster before i: a character with the marks after it. @param {number} i */
	_prev(i) {
		if (i <= 0) { return 0; }
		let j = i - 1;
		while (j > 0 && this._zeroWidth(this.buf[j])) { j--; }
		return j;
	}

	/** End of the cluster at i. @param {number} i @returns {number} */
	_next(i) {
		const n = this.buf.length;
		if (i >= n) { return n; }
		let j = i + 1;
		while (j < n && this._zeroWidth(this.buf[j])) { j++; }
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
	 * Ask for completions and apply the answer. A Tab that came in while it was waiting runs when it has been applied.
	 * @param {boolean} second the previous event was a Tab that left several candidates
	 */
	async _tab(second) {
		if (!this.host.complete) { return; }
		const mine = { version: this.version };
		this.pendingTab = mine;
		try {
			await this._complete(mine.version, second);
		} catch (e) {
			/* a completion that failed completes nothing */
		} finally {
			if (this.pendingTab === mine) { this.pendingTab = null; }
		}
		if (this.tabQueued && this.active) {
			this.tabQueued = false;
			const wasTab = this.lastTab;
			this.lastTab = false;
			this.version++;
			this._tab(wasTab);
		}
	}

	/** @param {number} version the event count when the Tab was pressed @param {boolean} second */
	async _complete(version, second) {
		const line = this.buf.join('');
		const r = await /** @type {NonNullable<EditorHost['complete']>} */ (this.host.complete)(line, this.cur);
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
