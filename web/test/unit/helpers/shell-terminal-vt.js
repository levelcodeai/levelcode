// A small terminal model for TESTS: enough of xterm.js to say what the line editor leaves on the screen and where the
// cursor is. It models the behaviours the editor depends on, each one checked against the real xterm.js 6.1
// (the headless build, driven the same way) when the tests were written:
//   - a character written in the last column sets "pending wrap"; the wrap happens when the NEXT printable arrives;
//   - a wide character that does not fit wraps and leaves the last cell of the row empty;
//   - zero-width characters attach to the previous cell; a TAB only moves the cursor;
//   - CSI A/B clamp at the viewport, CSI C clamps at the last column, LF scrolls at the bottom;
//   - rows that were wrapped by the terminal are re-wrapped when the width changes (reflow); rows ended by LF are not.
//     resize() follows xterm's Buffer.resize / _reflowSmaller / _reflowLarger step by step, with `reflowCursorLine` off
//     as VS Code sets it, including what they do to the cursor row (it is moved by the rows EVERY line gained or lost,
//     whichever side of the cursor the line is on). shell-terminal-line-editor.test.js compares it with xterm.
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
					// VS Code runs xterm.js with scrollOnEraseInDisplay: what was on screen, down to its last row with
					// anything on it, is scrolled into the scrollback
					let last = -1;
					this.grid.forEach((g, i) => { if (g.cells.length) { last = i; } });
					for (let i = 0; i <= last; i++) { this.scrollback.push(this.grid[i]); }
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
	 * Change the size the way the workbench's xterm does (Buffer.resize: the rows first, then the reflow; reflowCursorLine
	 * off). The scrollback is unbounded here. `y` is the cursor's row in the viewport and `ybase` the rows above it.
	 * @param {number} cols @param {number} rows
	 */
	resize(cols, rows) {
		const oldCols = this.cols;
		const oldRows = this.rows;
		const blank = () => ({ cells: /** @type {string[]} */ ([]), wrapped: false });
		/** @type {Row[]} */
		const lines = this.scrollback.concat(this.grid);
		let ybase = this.scrollback.length;
		let y = this.r;
		let x = this.pending ? oldCols : this.c;
		let added = 0;
		if (oldRows < rows) {
			for (let k = oldRows; k < rows; k++) {
				if (lines.length < rows + ybase) {
					if (ybase > 0 && lines.length <= ybase + y + added + 1) { ybase--; added++; } else { lines.push(blank()); }
				}
			}
		} else {
			for (let k = oldRows; k > rows; k--) {
				if (lines.length > rows + ybase) {
					if (lines.length > ybase + y + 1) { lines.pop(); } else { ybase++; }
				}
			}
		}
		x = Math.min(x, cols - 1);
		y = Math.min(y, rows - 1);
		y += added;

		const trimmed = (/** @type {Row} */ row) => { let n = row.cells.length; while (n > 0 && row.cells[n - 1] === undefined) { n--; } return n; };
		/** The cells of a chain of rows, in order: a row that was wrapped is full up to the width, or one short before a wide character. */
		const content = (/** @type {Row[]} */ chain) => {
			const out = /** @type {string[]} */ ([]);
			chain.forEach((rw, k) => {
				const cells = k < chain.length - 1 ? rw.cells.slice(0, oldCols) : rw.cells.slice(0, trimmed(rw));
				for (const c of cells) { out.push(c === undefined ? ' ' : c); }
			});
			return out;
		};

		if (cols > oldCols) {
			// _reflowLarger: top down; the cursor's own line is skipped (by the row it had when this started); every row
			// removed anywhere moves the cursor up
			const cursorAbs = ybase + y;
			let removed = 0;
			const drops = /** @type {Array<{ at: number, count: number }>} */ ([]);
			for (let h = 0; h < lines.length - 1; h++) {
				let c = h + 1;
				if (!lines[c].wrapped) { continue; }
				const chain = [lines[h]];
				while (c < lines.length && lines[c].wrapped) { chain.push(lines[c]); c++; }
				if (cursorAbs >= h && cursorAbs < c) { h += chain.length - 1; continue; }
				const packed = this._split(content(chain), cols);
				const keep = Math.min(packed.length, chain.length);
				for (let k = 0; k < keep; k++) { chain[k].cells = packed[k]; }
				if (chain.length > keep) { drops.push({ at: h + keep, count: chain.length - keep }); removed += chain.length - keep; }
				h += chain.length - 1;
			}
			// the rows are taken out afterwards: every index above is the screen as it was
			for (const d of drops.reverse()) { lines.splice(d.at, d.count); }
			while (removed-- > 0) {
				if (ybase === 0) {
					if (y > 0) { y--; }
					if (lines.length < rows) { lines.push(blank()); }
				} else {
					ybase--;
				}
			}
		} else if (cols < oldCols) {
			// _reflowSmaller: bottom up; the cursor row is the running one, and each row a line gains moves it down
			const inserts = /** @type {Array<{ start: number, newLines: Row[] }>} */ ([]);
			let count = 0;
			for (let a = lines.length - 1; a >= 0; a--) {
				let row = lines[a];
				if (!row || (!row.wrapped && trimmed(row) <= cols)) { continue; }
				const chain = [row];
				while (row.wrapped && a > 0) { row = lines[--a]; chain.unshift(row); }
				const cursorAbs = ybase + y;
				if (cursorAbs >= a && cursorAbs < a + chain.length) { continue; }
				const packed = this._split(content(chain), cols);
				const extra = packed.length - chain.length;
				const fresh = [];
				for (let k = 0; k < extra; k++) { fresh.push({ cells: /** @type {string[]} */ ([]), wrapped: true }); }
				const all = chain.concat(fresh);
				for (let k = 0; k < all.length; k++) { all[k].cells = packed[k] || []; }
				if (fresh.length) { inserts.push({ start: a + chain.length + count, newLines: fresh }); count += fresh.length; }
				for (let m = Math.max(0, extra); m-- > 0;) {
					if (ybase === 0) {
						if (y < rows - 1) { y++; lines.pop(); } else { ybase++; }
					} else if (ybase < lines.length + count - rows) {
						ybase++;
					}
				}
			}
			if (inserts.length) {
				const original = lines.slice();
				const total = original.length;
				let at = total - 1;
				let n = 0;
				let next = inserts[n];
				let done = 0;
				lines.length = total + count;
				for (let i = total + count - 1; i >= 0; i--) {
					if (next && next.start > at + done) {
						for (let k = next.newLines.length - 1; k >= 0; k--) { lines[i--] = next.newLines[k]; }
						i++;
						done += next.newLines.length;
						next = inserts[++n];
					} else {
						lines[i] = original[at--];
					}
				}
			}
		}

		// a narrower terminal cuts every row, the cursor's own line included, at the new width (a wide character at the
		// edge keeps its first half)
		if (cols < oldCols) {
			for (const rw of lines) { if (rw.cells.length > cols) { rw.cells.length = cols; } }
		}
		// the viewport is the last `rows` rows of the buffer
		while (lines.length < ybase + rows) { lines.push(blank()); }
		this.scrollback = lines.slice(0, ybase);
		this.grid = lines.slice(ybase, ybase + rows);
		this.cols = cols;
		this.rows = rows;
		this.r = Math.max(0, Math.min(rows - 1, y));
		this.c = x;
		this.pending = false;
		this.last = null;
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
