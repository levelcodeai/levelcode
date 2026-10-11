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
// was: a shell redraws its own line), and `resize()` below follows xterm's own loops, quirks included: the height
// first (rows go into the scrollback and come back from it: `ghosts`), then the width (`_cursorRowAfterReflow`).
// What the editor cannot see, it does not guess upward: a redraw that starts a row too low leaves a copy of the
// prompt's first row, and one that starts a row too high writes over a line that was there before the prompt.
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

// What of INVISIBLE is kept. It is the exception sanitize.js makes for forTerminal, and for the same reason: a name
// with a VS16 (every '\u2714\uFE0F'), a ZWJ emoji or a ZWNJ in a Persian word can only be addressed with the invisible
// character in it, and what the terminal shows of a listing is what has to be typeable. Nothing else is: anywhere
// else an invisible character is how `rm a<ZWSP>b.txt` is drawn as `rm ab.txt` and run against another name.
const PICTOGRAPH = /^[\p{Extended_Pictographic}\p{Emoji_Modifier}]$/u;
const KEYCAP_BASE = /^[0-9#*]$/;
const LETTER_OR_MARK = /^[\p{L}\p{M}]$/u;
/** The scripts that are written with U+200C / U+200D inside a word, one regexp each: "the same script on both sides". */
const JOINER_SCRIPTS = [
	/^\p{Script_Extensions=Arabic}$/u, /^\p{Script_Extensions=Devanagari}$/u, /^\p{Script_Extensions=Bengali}$/u,
	/^\p{Script_Extensions=Gurmukhi}$/u, /^\p{Script_Extensions=Gujarati}$/u, /^\p{Script_Extensions=Oriya}$/u,
	/^\p{Script_Extensions=Tamil}$/u, /^\p{Script_Extensions=Telugu}$/u, /^\p{Script_Extensions=Kannada}$/u,
	/^\p{Script_Extensions=Malayalam}$/u, /^\p{Script_Extensions=Sinhala}$/u,
];

/**
 * Is the invisible character at index `i` one that is kept: an emoji's variation selector or joiner, or the joiner of a
 * word in a script that has one?
 *  - U+FE0F / U+FE0E right after a pictograph (or a keycap base followed by U+20E3);
 *  - U+200D between two pictographs (a variation selector may sit before it);
 *  - U+200C or U+200D with a letter or mark on each side, both of the same script of JOINER_SCRIPTS.
 * The neighbours are the ones the text had (not the ones that are left of it), so a hidden character next to a joiner
 * makes it hidden too, as in forTerminal; and one that is first, last or doubled has no letter on a side.
 * @param {(i: number) => string | undefined} at the code point at an index, or undefined past either end
 * @param {number} i @param {number} cp
 */
function keepsInvisible(at, i, cp) {
	const prev = at(i - 1);
	const next = at(i + 1);
	if (cp === 0xFE0F || cp === 0xFE0E) {
		if (prev === undefined) { return false; }
		return PICTOGRAPH.test(prev) || (KEYCAP_BASE.test(prev) && next === '\u20E3');
	}
	if (cp !== 0x200C && cp !== 0x200D) { return false; }
	if (cp === 0x200D) {
		let left = prev;
		if (left === '\uFE0F' || left === '\uFE0E') { left = at(i - 2); }
		if (left !== undefined && next !== undefined && PICTOGRAPH.test(left) && PICTOGRAPH.test(next)) { return true; }
	}
	if (prev === undefined || next === undefined || !LETTER_OR_MARK.test(prev) || !LETTER_OR_MARK.test(next)) { return false; }
	return JOINER_SCRIPTS.some((script) => script.test(prev) && script.test(next));
}

/**
 * What may enter the buffer: tabs and newlines, and text the screen can show. Controls, DEL and C1 are dropped, and so
 * is every invisible character (INVISIBLE) but the ones that belong to an emoji or to a word of a script that is
 * written with them (keepsInvisible): what is on screen is what will run, so `rm a<ZWSP>b.txt` cannot be drawn as
 * `rm ab.txt`. The text is judged by itself and by the character before and after the place it goes into, so a joiner
 * typed between two letters that are already there is kept and one at the end of the text is not.
 * @param {string} s
 * @param {string} [before] the character in the buffer before where `s` goes
 * @param {string} [after] and after it
 * @returns {{ cps: string[], dropped: number }} the code points that were kept, and how many were not
 */
function cleanText(s, before, after) {
	const chars = Array.from(s);
	const n = chars.length;
	const at = (/** @type {number} */ i) => (i >= 0 && i < n ? chars[i] : i === -1 ? before : i === n ? after : undefined);
	/** @type {string[]} */
	const cps = [];
	let dropped = 0;
	for (let i = 0; i < n; i++) {
		const ch = chars[i];
		const cp = /** @type {number} */ (ch.codePointAt(0));
		if (ch === '\n' || ch === '\t') { cps.push(ch); continue; }
		if (cp < 0x20 || (cp >= 0x7f && cp <= 0x9f) || (INVISIBLE.test(ch) && !keepsInvisible(at, i, cp))) { dropped++; continue; }
		cps.push(ch);
	}
	return { cps, dropped };
}

/** The note under the line when what was typed, pasted or completed lost characters: not a word of what it was. @param {number} n */
function droppedNote(n) {
	return '[' + n + ' invisible character' + (n === 1 ? ' was' : 's were') + ' not typed]';
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
		this.ghosts = 0;             // rows of the region that xterm pushed into the scrollback, right above the screen (see resize)
		this.ghostLines = 0;         // how many logical lines those rows are the rows of, and how many cells they hold: what a wider
		this.ghostCells = 0;         // panel can join them to (at least this many lines, and no fewer rows than the cells need)
		this.blank = 0;              // rows known to be blank under what the region takes of the screen (a lower bound; see resize)
		this.span = 1;               // the rows the region has on the screen, as the terminal has them until it is drawn again
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
			this._noGhosts();                      // what was on the screen is now the scrollback, and is history
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
				if (p.row > winBottom) { break; }
				if (this.buf[k] === '\t') {
					// A tab is spaces, one cell each, that wrap like any other cell, so a tab that starts above the window can
					// end in it, and one that starts in it can end below. The spaces above the first row drawn are not
					// written, but the ones that land in it are (without them the row and everything after it would be drawn
					// left of where the cursor is computed). The ones past the last row drawn are not written either: the
					// terminal would scroll for them, and the cursor would end a row too low.
					const cellsToEnd = (winBottom - p.row + 1) * this.cols - p.col;
					const cellsAbove = p.row < winTop ? (winTop - p.row) * this.cols - p.col : 0;
					const n = Math.min(L.wid[k], cellsToEnd) - cellsAbove;
					if (n > 0) { out += ' '.repeat(n); }
				} else if (p.row >= winTop) {
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

		// What the region takes of the blank rows under it is not blank any more, and what it gives back (it got shorter: the
		// rows were erased) is; a region that fills the panel leaves none, and Ctrl+L puts it at the top of the screen.
		const shown = written - winTop + 1;
		this.blank = shown >= this.rows ? 0 : clear ? this.rows - shown : Math.max(0, this.blank + this.span - shown);
		this.span = shown;
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
		this._noGhosts();
		this._noRegion();
		this.phantom = false;
	}

	/** Nothing is known about the rows under what is drawn next, and it is not the region that was: one row, as at a prompt. */
	_noRegion() {
		this.blank = 0;
		this.span = 1;
		this.lastRow = this.winTop;
	}

	/** The rows that were pushed into the scrollback are history from here on. */
	_noGhosts() {
		this.ghosts = 0;
		this.ghostLines = 0;
		this.ghostCells = 0;
	}

	/* ------------------------------------------------------------------------------------------------ lifecycle */

	/** Begin a new prompt on a row of its own. The cursor must be at column 0. */
	start() {
		this.buf = [];
		this.cur = 0;
		this.hi = -1;
		this.draft = '';
		this.cursorRow = 0;
		this._noGhosts();
		this._noRegion();
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
	 *
	 * xterm.js does it in the order of Buffer.resize, and so does this: the HEIGHT first, then the width.
	 *   - A shorter screen puts the rows at its top into the scrollback, and a narrower one puts there the rows that
	 *     re-wrapping adds. What of the region goes there stays there: `ghosts` counts those rows, which sit right above
	 *     the screen and are stale copies of what is redrawn below them.
	 *   - A taller screen pulls rows back from the scrollback when the cursor is on its last row, as many as it has
	 *     grown by, and a wider one pulls one back for every row it takes out of the region. What is pulled is what was
	 *     pushed (the ghosts) and then what was there before the region, which has to stay. So the redraw starts at the
	 *     first ghost that came back and writes over them, and not at the top of the window, which would leave them above
	 *     the region once (the prompt's first rows, twice, after 12 -> 4 -> 12 rows).
	 *
	 * What the editor keeps of the ghosts is three numbers, each of them a FLOOR and never a guess, because the redraw
	 * writes over what comes back: one row of over-count is a line of output that was there before the prompt, written
	 * over; a row of under-count is a stale copy of the prompt's first row, which is only untidy.
	 *   ghosts      the rows of the region that are in the scrollback right above the screen;
	 *   ghostLines  the logical lines those rows are rows of (a wider panel joins the rows of one line, never two lines,
	 *               so each stays at least one row);
	 *   ghostCells  the cells those rows hold (joined, they need at least ceil(cells / width) rows).
	 * Lines and cells are counted when the rows are pushed and only ever from the rows xterm really pushed: the rows the
	 * screen had at that moment (`_headRows` of the arrangement `_reflowRows` works out), so a row is never credited with
	 * more cells than it holds. Counted afterwards, at the width the panel is asked about, they were: a row xterm pushed
	 * is as wide as the screen was (24 cells, pushed when the panel was 24 wide; and the line of the cursor is never
	 * re-wrapped, so a wider panel does not make it 64), which is what made two rows into one at 104 columns and the
	 * redraw start a row too high. Pulled rows are the newest: what is left is at least as many lines, and as many cells,
	 * as the rows that came back could have held. A narrower panel only splits rows, which makes the floor lower, not
	 * wrong. `_noGhosts` forgets all three: they say nothing of rows that are no longer there.
	 * @param {number} cols
	 * @param {number} rows
	 */
	resize(cols, rows) {
		const c = Math.max(2, Math.floor(cols) || this.cols);
		const r = Math.max(2, Math.floor(rows) || this.rows);
		if (c === this.cols && r === this.rows) { return; }
		if (!this.active) {
			this.cols = c;
			this.rows = r;
			return;
		}
		const t = this.targetRow;
		// before the size changes: the layout the terminal had is the one the changes start from
		const reflowed = this._cursorRowAfterReflow(c, r);
		const row = reflowed.row;
		let ghosts = this.ghosts;
		let pushed = 0;        // rows of the region that this event puts into the scrollback
		let pull = 0;          // rows that this event brings back into view above the region
		if (r < this.rows) {
			pushed = Math.max(0, t - r + 1 - this.winTop);
		} else if (r > this.rows && t - this.winTop === this.rows - 1) {
			// (xterm pulls only when the cursor is on the last row; with it elsewhere the redraw would clamp at the top of
			// the screen, which is where the window is: the condition is the rule's own, not a guard)
			pull = r - this.rows;
		}
		this._blankAfter(c, r, pushed, reflowed.span);
		if (c < this.cols) {
			// Every row a line gains moves the content of the screen down by one: first into the blank rows under the
			// cursor (xterm.js makes room by dropping them), and once the cursor is on the last row the top row of the
			// screen goes into the scrollback. Earlier output that is above the region goes first, and there is no more of
			// it than the cursor has rows left to go down (the screen has the cursor's row, and what is above it, in
			// all). So what is left after those rows is rows of the region, whatever else is on the screen: at least that
			// many, which is what `ghosts` is.
			pushed += Math.max(0, reflowed.added - Math.max(0, r - 1 - this.cursorRow));
		} else if (c > this.cols) {
			ghosts = this._ghostsAt(c);
			pull += reflowed.removed;
			// a row that was pushed and is joined to the rest of its line (which is on the screen) is no ghost
			if (reflowed.removed > 0) { pushed = 0; }
		}
		const back = Math.min(pull, ghosts);
		if (back > 0) {
			// what comes back is the newest of the ghosts: the rest are the oldest, with at least this many lines and cells
			const wide = Math.max(this.cols, c);
			this.ghostLines = ghosts > back ? Math.max(1, this.ghostLines - back) : 0;
			this.ghostCells = ghosts > back ? Math.max(0, this.ghostCells - back * wide) : 0;
		}
		if (pushed > 0) {
			const head = this._headRows(reflowed.arranged, pushed);
			this.ghostLines += head.lines;
			this.ghostCells += head.cells;
		}
		this.cols = c;
		this.rows = r;
		this.ghosts = ghosts - back + pushed;
		this.cursorRow = row + back;
		this._draw();
	}

	/**
	 * What is known of the blank rows under the region once the terminal has made the panel `cols` x `rows` and before the
	 * redraw: `blank` of them, and the region has `span` rows on the screen (the redraw then writes `shown` rows in their
	 * place, `_draw`: what is erased and not written is blank, and what it needs of them is not). A floor, as the ghosts
	 * are: it is what the 'cut' end of `_cursorRowAfterReflow` may count on.
	 *   - a shorter panel loses the blank rows first, a taller one adds them under the region when the cursor is not on the
	 *     last row of the screen, which is known when the region has rows under it (with the cursor on the region's last
	 *     row it may be on the screen's last, and then the rows come from the scrollback), and a wider one joins rows,
	 *     which come back from above and leave the rows under the region as they are;
	 *   - a narrower one takes rows from them for what it re-wraps, the output before the prompt too, which is not known;
	 *     and a shorter one that pushes the top of the region into the scrollback leaves the region at the top of a screen
	 *     of its own: how much of it is there is not worked out. Nothing is known then, which is what a prompt starts with.
	 * @param {number} c @param {number} r the new size
	 * @param {number} pushed the rows of the region the shorter panel put into the scrollback
	 * @param {number} span the rows the region has, once re-wrapped (`_cursorRowAfterReflow`)
	 */
	_blankAfter(c, r, pushed, span) {
		if (c < this.cols || pushed > 0) {
			this.blank = 0;
			this.span = 0;
			return;
		}
		if (r < this.rows) {
			this.blank = Math.max(0, this.blank - (this.rows - r));
		} else if (r > this.rows && this.lastRow > this.targetRow) {
			// (a panel that pulls rows back has the cursor on its last row: it is the last row of the region, or of its window)
			this.blank += r - this.rows;
		}
		this.span = span;
	}

	/**
	 * How many of the ghost rows are still rows after the panel is made `cols` wide: a wider panel joins the rows of a
	 * wrapped line, so not all of them. At least one row for each line, and at least what the cells of all of them
	 * need; and no more than there were (a narrower panel in between split rows that are not counted, so the cells
	 * can be more than the rows that are counted hold: those are not claimed). Only called for a wider panel.
	 * @param {number} cols
	 */
	_ghostsAt(cols) {
		return Math.min(this.ghosts, Math.max(this.ghostLines, Math.ceil(this.ghostCells / cols)));
	}

	/**
	 * What the first `count` rows of the screen are, once xterm has done with them: how many logical lines they are
	 * the rows of and how many cells they hold. These are the rows that a shorter or a narrower screen has put into the
	 * scrollback. `arranged` is what `_reflowRows` made of the screen (one arrangement per hypothesis about the blank
	 * rows under the region): the rows as the re-wrapping left them, line by line, and the first row of a window is a
	 * line of its own (see `_reflowRows`). The least of the arrangements is taken: each is a floor, and the one that is
	 * the truth is one of them.
	 * @param {Array<Array<{ line: number, cells: number }>>} arranged
	 * @param {number} count
	 * @returns {{ lines: number, cells: number }}
	 */
	_headRows(arranged, count) {
		let lines = Infinity;
		let cells = Infinity;
		for (const rows of arranged) {
			let seen = 0;
			let held = 0;
			let line = -1;
			for (let i = 0; i < count && i < rows.length; i++) {
				if (rows[i].line !== line) { seen++; line = rows[i].line; }
				held += rows[i].cells;
			}
			lines = Math.min(lines, seen);
			cells = Math.min(cells, held);
		}
		return { lines, cells };
	}

	/**
	 * Where the terminal's cursor is, in rows below the first row of what is on the screen (the region, or the window
	 * of it), after xterm.js has re-wrapped the screen for a new width. Not "where the line the cursor is on starts":
	 * xterm.js (Buffer._reflowSmaller / _reflowLarger, with `reflowCursorLine` off) walks the screen's lines and moves
	 * its cursor row by the rows each one gained or lost, whichever side of the cursor the line is on. So, line by line
	 * (a line is the rows one logical line of the buffer takes on the screen, with its prompt; in a window the first
	 * and the last may be cut: what the window's first row begins is a line of its own for xterm.js, because the
	 * redraw wrote it after an erase at column 0):
	 *   narrower: from the LAST line up. A line that was wrapped or is now too wide is re-wrapped, unless it holds the
	 *     cursor, and the cursor row is the running one: every row a lower line gained moved it down, so the line it is
	 *     on may no longer be the line that holds it. The cursor row grows by the rows the line gained.
	 *   wider: from the first line down, with the cursor row it had at the start. A wrapped line that does not hold it
	 *     is joined, and every row that was removed (below the cursor's line too) moves the cursor up. That can leave it
	 *     above the region: the answer is then negative.
	 * The line that holds the cursor is not touched, and when the panel is narrower its rows are cut at the new width:
	 * the arrangement says so (`arranged`), because it is what the ghosts are counted from.
	 * Known gap: xterm.js stops that at the top of its buffer, which the editor cannot see; it only matters when the
	 * region starts in the very first rows of the whole scrollback and lines under the cursor are re-joined.
	 *
	 * A shorter screen has also lost rows, and which ones is not fully known. xterm.js (Buffer.resize) pops the rows
	 * BELOW the cursor first (the blank ones and then the region's own: they were drawn, and are gone), as many as the
	 * screen got shorter by, and scrolls the top away only for what is left. The editor knows how many rows the region
	 * has below its cursor and how many the screen lost, and how many blank rows there are under the region at least
	 * (`blank`: the rows a taller panel added, less what the region has taken since), not how many there are: none when
	 * the region fills the screen or is a window (a terminal that has scrolled), more on a fresh terminal. So the rows
	 * that are left are worked out for both ends (all the blank rows there could be, and only the ones that are known
	 * to be) and the answer that puts the redraw LOWER is taken: a redraw that starts a row too high writes over a line
	 * that was there before the prompt, and one that starts a row too low leaves a copy of the prompt's first row, which
	 * is only untidy. A panel that was made taller and is made shorter again has the rows it added, blank: both ends
	 * are one, and the redraw is where the screen has the region, not a row above it (a copy of the prompt, which the
	 * lower of two answers left).
	 * @param {number} cols the new width
	 * @param {number} rows the new height
	 * @returns {{ row: number, added: number, removed: number, span: number, arranged: Array<Array<{ line: number, cells: number }>> }}
	 *   the row, the rows the re-wrapping added and took out, how many rows the region has on the screen afterwards (at
	 *   least), and the rows the screen has
	 */
	_cursorRowAfterReflow(cols, rows) {
		if (rows >= this.rows) {
			const whole = this._reflowRows(cols, this.lastRow);
			return { row: whole.row, added: whole.added, removed: whole.removed, span: whole.rows.length, arranged: [whole.rows] };
		}
		const lost = this.rows - rows;
		// the most blank rows there can be under the region on the screen (a window fills it), and the fewest
		const most = Math.max(0, this.rows - 1 - (this.lastRow - this.winTop));
		const least = Math.min(this.blank, most);
		const cut = this._reflowRows(cols, Math.max(this.targetRow, this.lastRow - Math.max(0, lost - least)));
		const kept = this._reflowRows(cols, Math.max(this.targetRow, this.lastRow - Math.max(0, lost - most)));
		const lower = kept.row < cut.row ? kept : cut;
		return { row: lower.row, added: lower.added, removed: lower.removed, span: cut.rows.length, arranged: [cut.rows, kept.rows] };
	}

	/**
	 * `_cursorRowAfterReflow` for a given last row of the region that is still there.
	 * @param {number} cols the new width
	 * @param {number} bottom the last row of the region that the terminal still has (the rows under it were dropped)
	 * @returns {{ row: number, added: number, removed: number, rows: Array<{ line: number, cells: number }> }}
	 *   the row, the rows the re-wrapping added and took out, and the screen's rows afterwards, top to bottom: the logical
	 *   line each belongs to and the cells it holds
	 */
	_reflowRows(cols, bottom) {
		const top = this.winTop;
		const before = this._layout(true);
		const cells = before.cells.filter((c) => c.row >= top && c.row <= bottom);
		// the row that was made by forcing a wrap holds a space, which is part of the last line and is re-wrapped with it
		// (it is the row the cursor is on, so no row is dropped from under it: `bottom` is never above it)
		if (this.phantom) { cells.push({ line: before.lines.length - 1, row: this.lastRow, w: 1 }); }
		/** @type {Array<{ first: number, last: number, widths: number[], byRow: number[][] }>} */
		const lines = [];
		for (const c of cells) {
			let l = lines[c.line];
			if (!l) { l = lines[c.line] = { first: c.row, last: c.row, widths: [], byRow: [] }; }
			l.last = c.row;
			l.widths.push(c.w);
			(l.byRow[c.row - l.first] || (l.byRow[c.row - l.first] = [])).push(c.w);
		}
		/**
		 * The rows a run of cells takes when it starts a row (a cell that does not fit goes to the next), and the cells in
		 * each.
		 * @param {number[]} widths
		 */
		const pack = (widths) => {
			const rows = [0];
			let col = 0;
			for (const w of widths) {
				if (w > 0 && col + w > cols) { rows.push(0); col = 0; }
				col += w;
				rows[rows.length - 1] += w;
			}
			return rows;
		};
		const on = lines.filter(Boolean);
		const start = on.map((l) => l.first - top);
		const was = on.map((l) => l.last - l.first + 1);
		const packed = on.map((l) => pack(l.widths));
		const now = packed.map((p) => p.length);
		const holds = (/** @type {number} */ row, /** @type {number} */ k) => row >= start[k] && row < start[k] + was[k];
		const wrapped = on.map(() => false);     // the line was re-wrapped (or joined): its rows are the packed ones
		let row = this.cursorRow;
		let added = 0;
		let removed = 0;
		if (cols < this.cols) {
			for (let k = on.length - 1; k >= 0; k--) {
				if (was[k] === 1 && now[k] === 1) { continue; }              // not wrapped, and not too wide: not touched
				if (holds(row, k)) { continue; }
				wrapped[k] = true;
				const gain = Math.max(0, now[k] - was[k]);
				row += gain;
				added += gain;
			}
		} else {
			const at = row;
			for (let k = 0; k < on.length; k++) {
				if (was[k] < 2 || holds(at, k)) { continue; }                   // only wrapped lines are joined
				wrapped[k] = true;
				const loss = Math.max(0, was[k] - now[k]);
				row -= loss;
				removed += loss;
			}
		}
		// the rows the screen has afterwards: a line that was not touched has its rows as they were, each cut at the new width
		/** @type {Array<{ line: number, cells: number }>} */
		const rows = [];
		on.forEach((l, k) => {
			if (wrapped[k]) {
				for (const n of packed[k]) { rows.push({ line: k, cells: n }); }
				return;
			}
			for (const widths of l.byRow) {
				let held = 0;
				for (const w of widths || []) {
					if (held + w > cols) { break; }
					held += w;
				}
				rows.push({ line: k, cells: held });
			}
		});
		return { row, added, removed, rows };
	}

	text() { return this.buf.join(''); }

	/** Replace the buffer (a history entry, a draft). It is cleaned like anything typed: the store it came from is not trusted. @param {string} s */
	setText(s) {
		this.buf = cleanText(s).cps;
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
			// One key, one character: a key that types nothing the screen can show does nothing, as any unmapped key does.
			// A paste or a completion is text that arrives whole and may have lost a part of itself: that is said.
			case 'text': this._insert(e.s, Array.from(e.s).length === 1); break;
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

	/**
	 * @param {string} s
	 * @param {boolean} [key] one key was pressed: what is not typed is not said (nothing happens, as for an unmapped key)
	 */
	_insert(s, key) {
		const { cps, dropped } = cleanText(s, this.buf[this.cur - 1], this.buf[this.cur]);
		if (!cps.length && (key || !dropped)) { return; }
		this._put(this.cur, 0, cps);
		this.cur += cps.length;
		this._changed(dropped);
	}

	/** Show the line after an insertion: with a note first when characters were left out of it. @param {number} dropped */
	_changed(dropped) {
		if (dropped > 0) { this._notice(droppedNote(dropped)); } else { this._draw(); }
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
		const { cps, dropped } = cleanText(text, this.buf[start - 1], this.buf[this.cur]);
		this._put(start, this.cur - start, cps);
		this.cur = start + cps.length;
		this._changed(dropped);
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
			// trimEnd, not /\s+$/: that is quadratic in a name with a long run of blanks inside it
			rows.push(items.slice(i, i + per).map((s) => s + ' '.repeat(Math.max(0, w - strWidth(s)))).join('').trimEnd());
		}
		return rows.join('\r\n');
	}
}

module.exports = { LineEditor, cleanText, droppedNote };
