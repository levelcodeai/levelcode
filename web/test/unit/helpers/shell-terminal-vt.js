// A small terminal model for TESTS: enough of xterm.js to say what the line editor leaves on the screen and where the
// cursor is. It models the behaviours the editor depends on, each one checked against the real xterm.js 6.1
// (the headless build, driven the same way) when the tests were written:
//   - a character written in the last column sets "pending wrap"; the wrap happens when the NEXT printable arrives;
//   - a wide character that does not fit wraps and leaves the last cell of the row empty;
//   - zero-width characters attach to the previous cell; a TAB only moves the cursor;
//   - CSI A/B clamp at the viewport, CSI C clamps at the last column, LF scrolls at the bottom;
//   - rows that were wrapped by the terminal are re-wrapped when the width changes (reflow); rows ended by LF are not.
// Everything else is parsed and ignored (colours, OSC, modes).
// @ts-check
'use strict';

const path = require('path');
const { cpWidth } = require(path.join(__dirname, '..', '..', '..', 'shell', 'src', 'terminal', 'width.js'));

const ESC = '\x1b';

/** @typedef {{ cells: string[], wrapped: boolean }} Row */

class VT {
	/** @param {number} [cols] @param {number} [rows] */
	constructor(cols = 40, rows = 12) {
		this.cols = cols;
		this.rows = rows;
		/** @type {Row[]} */
		this.grid = Array.from({ length: rows }, () => ({ cells: [], wrapped: false }));
		/** @type {Row[]} */
		this.scrollback = [];
		this.r = 0;
		this.c = 0;
		this.pending = false;
		this.last = /** @type {{ r: number, c: number } | null} */ (null);
		this.state = 0;
		this.buf = '';
		/** Bytes received, for tests that assert on what was written. */
		this.log = '';
	}

	/** @param {string} ch @param {number} w */
	_put(ch, w) {
		if (w === 0) {
			if (this.last) {
				const row = this.grid[this.last.r];
				row.cells[this.last.c] = (row.cells[this.last.c] || '') + ch;
			}
			return;
		}
		if (this.pending || this.c + w > this.cols) {
			this.c = 0;
			this._lf(true);
			this.pending = false;
		}
		const row = this.grid[this.r];
		while (row.cells.length < this.c) { row.cells.push(' '); }
		row.cells[this.c] = ch;
		for (let k = 1; k < w; k++) { row.cells[this.c + k] = ''; }
		this.last = { r: this.r, c: this.c };
		this.c += w;
		if (this.c >= this.cols) { this.c = this.cols - 1; this.pending = true; }
	}

	/** @param {boolean} wrapped */
	_lf(wrapped) {
		if (this.r === this.rows - 1) {
			const gone = /** @type {Row} */ (this.grid.shift());
			this.scrollback.push(gone);
			this.grid.push({ cells: [], wrapped });
			if (this.last) { this.last.r = Math.max(0, this.last.r - 1); }
		} else {
			this.r++;
			this.grid[this.r].wrapped = wrapped;
		}
	}

	/** @param {string} s */
	write(s) {
		this.log += s;
		for (const ch of s) {
			switch (this.state) {
				case 0:
					if (ch === ESC) { this.state = 1; break; }
					if (ch === '\r') { this.c = 0; this.pending = false; break; }
					if (ch === '\n') { this._lf(false); break; }
					if (ch === '\b') { if (this.pending) { this.pending = false; } else if (this.c > 0) { this.c--; } break; }
					if (ch === '\t') {
						const from = this.pending ? this.cols : this.c;
						let next = from + 1;
						while (next % 8 !== 0 && next < this.cols) { next++; }
						this.c = Math.min(next, this.cols - 1);
						this.pending = false;
						break;
					}
					if (ch < ' ' || (ch >= '\x7f' && ch <= '\x9f')) { break; }
					this._put(ch, cpWidth(/** @type {number} */ (ch.codePointAt(0))));
					break;
				case 1:
					if (ch === '[') { this.state = 2; this.buf = ''; } else if (ch === ']') { this.state = 3; } else { this.state = 0; }
					break;
				case 2:
					if (/[0-9;:?<=>]/.test(ch)) { this.buf += ch; break; }
					if (/[ -/]/.test(ch)) { this.buf += ch; break; }
					this.state = 0;
					this._csi(this.buf, ch);
					break;
				case 3:
					if (ch === '\x07') { this.state = 0; } else if (ch === ESC) { this.state = 4; }
					break;
				default:
					this.state = 0;
			}
		}
	}

	/** @param {string} params @param {string} f */
	_csi(params, f) {
		const parts = params.split(';');
		const n = (/** @type {number} */ i, /** @type {number} */ d) => { const v = parts[i]; return v === undefined || v === '' ? d : Number(v); };
		const row = this.grid[this.r];
		switch (f) {
			case 'A': this.r = Math.max(0, this.r - Math.max(1, n(0, 1))); this.pending = false; break;
			case 'B': this.r = Math.min(this.rows - 1, this.r + Math.max(1, n(0, 1))); this.pending = false; break;
			case 'C': this.c = Math.min(this.cols - 1, (this.pending ? this.cols : this.c) + Math.max(1, n(0, 1))); this.pending = false; break;
			case 'D': this.c = Math.max(0, (this.pending ? this.cols - 1 : this.c) - Math.max(1, n(0, 1))); this.pending = false; break;
			case 'G': this.c = Math.max(0, Math.min(this.cols - 1, n(0, 1) - 1)); this.pending = false; break;
			case 'H': case 'f':
				this.r = Math.max(0, Math.min(this.rows - 1, n(0, 1) - 1));
				this.c = Math.max(0, Math.min(this.cols - 1, n(1, 1) - 1));
				this.pending = false;
				break;
			case 'K': {
				const m = n(0, 0);
				const at = this.pending ? this.cols : this.c;
				if (m === 0) { for (let k = at; k < Math.max(row.cells.length, this.cols); k++) { delete row.cells[k]; } this._trim(row); if (at === 0) { row.wrapped = false; } }
				else if (m === 2) { row.cells = []; row.wrapped = false; }
				else { for (let k = 0; k <= Math.min(at, this.cols - 1); k++) { row.cells[k] = ' '; } }
				break;
			}
			case 'J': {
				const m = n(0, 0);
				if (m === 0) {
					const at = this.pending ? this.cols : this.c;
					for (let k = at; k < Math.max(row.cells.length, this.cols); k++) { delete row.cells[k]; }
					this._trim(row);
					if (at === 0) { row.wrapped = false; }
					for (let r = this.r + 1; r < this.rows; r++) { this.grid[r] = { cells: [], wrapped: false }; }
				} else if (m === 2) {
					// xterm.js keeps what was on screen: the viewport is scrolled into the scrollback
					const used = this.grid.filter((g) => g.cells.length).length;
					if (used) { for (const g of this.grid) { this.scrollback.push(g); } }
					this.grid = Array.from({ length: this.rows }, () => ({ cells: [], wrapped: false }));
				}
				break;
			}
			default: break;
		}
	}

	/** @param {Row} row */
	_trim(row) { while (row.cells.length && row.cells[row.cells.length - 1] === undefined) { row.cells.pop(); } }

	/**
	 * Change the size the way the workbench's xterm does: rows the terminal wrapped itself are re-wrapped, EXCEPT the
	 * line that holds the cursor (reflowCursorLine is off in VS Code: a shell redraws its own line), which keeps its
	 * rows and is cut or padded at the new width. The cursor stays on its line.
	 * @param {number} cols @param {number} rows
	 */
	resize(cols, rows) {
		const all = this.scrollback.concat(this.grid);
		const curIndex = this.scrollback.length + this.r;
		/** @type {Array<{ rows: Row[], hasCursor: boolean }>} */
		const chains = [];
		all.forEach((rw, idx) => {
			if (rw.wrapped && chains.length) { chains[chains.length - 1].rows.push(rw); } else { chains.push({ rows: [rw], hasCursor: false }); }
			if (idx === curIndex) { chains[chains.length - 1].hasCursor = true; }
		});
		/** @type {Row[]} */
		const out = [];
		let newCurRow = 0;
		for (const ch of chains) {
			if (ch.hasCursor) {
				const first = out.length;
				ch.rows.forEach((rw) => {
					const cells = rw.cells.slice(0, cols);
					// do not leave half of a wide character at the edge
					if (cells.length === cols && cells[cols - 1] !== '' && rw.cells[cols] === '') { cells.length = cols - 1; }
					out.push({ cells, wrapped: rw.wrapped });
				});
				newCurRow = first + ch.rows.indexOf(all[curIndex]);
				continue;
			}
			const cells = [];
			ch.rows.forEach((rw, k) => {
				// a row that was wrapped is full up to its width (or one short, before a wide character)
				const used = k < ch.rows.length - 1 ? this._full(rw) : this._used(rw);
				for (const c of used) { cells.push(c); }
			});
			this._split(cells, cols).forEach((c, k) => out.push({ cells: c, wrapped: k > 0 }));
		}
		// when the content outgrew the screen, blank rows below the cursor go first; only then does the top scroll away
		const blank = (/** @type {Row} */ r) => this._used(r).length === 0 && !r.wrapped;
		let total = out.length;
		while (total > this.scrollback.length + this.rows && total - 1 > newCurRow && blank(out[total - 1])) { total--; }
		out.length = total;
		let start = Math.max(0, out.length - rows);
		if (newCurRow < start) { start = newCurRow; }
		while (out.length - start < rows) { out.push({ cells: [], wrapped: false }); }
		this.scrollback = out.slice(0, start);
		this.grid = out.slice(start, start + rows);
		this.cols = cols;
		this.rows = rows;
		this.r = Math.min(rows - 1, newCurRow - start);
		this.c = Math.min(this.c, cols - 1);
		this.pending = false;
		this.last = null;
	}

	/**
	 * Every cell of a row the terminal wrapped. A row that ends one cell early (a wide character did not fit) is
	 * not padded: that cell was never written and is not part of the text.
	 * @param {Row} row
	 */
	_full(row) {
		return row.cells.slice(0, this.cols).map((x) => (x === undefined ? ' ' : x));
	}

	/** @param {Row} row the cells that hold content, up to the full width when the row was wrapped */
	_used(row) {
		let len = row.cells.length;
		while (len > 0 && (row.cells[len - 1] === undefined || row.cells[len - 1] === ' ')) { len--; }
		const cells = row.cells.slice(0, len).map((x) => (x === undefined ? ' ' : x));
		return cells;
	}

	/** @param {string[]} cells @param {number} cols */
	_split(cells, cols) {
		if (cells.length === 0) { return [[]]; }
		/** @type {string[][]} */
		const rows = [];
		let cur = /** @type {string[]} */ ([]);
		for (let i = 0; i < cells.length; i++) {
			// a wide character is two cells: the glyph and an empty continuation; keep them together
			const wide = cells[i + 1] === '' && cells[i] !== '';
			const need = wide ? 2 : 1;
			if (cur.length + need > cols) { rows.push(cur); cur = []; }
			cur.push(cells[i]);
			if (wide) { cur.push(''); i++; }
		}
		rows.push(cur);
		return rows;
	}

	/** One string per screen row, trailing blanks removed. */
	lines() { return this.grid.map((r) => this._rowText(r)); }

	/** @param {Row} r */
	_rowText(r) { return r.cells.map((x) => (x === undefined ? ' ' : x)).join('').replace(/\s+$/, ''); }

	/** Screen text with the empty rows below the last used one removed. */
	text() {
		const l = this.lines();
		while (l.length && l[l.length - 1] === '') { l.pop(); }
		return l;
	}

	/** The cursor; `col` equals the width while a wrap is pending (as xterm.js reports its x). */
	cursor() { return { row: this.r, col: this.pending ? this.cols : this.c }; }
}

module.exports = { VT };
