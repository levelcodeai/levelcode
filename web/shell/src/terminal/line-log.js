// What a terminal printed, line by line, and the folder each line was printed in. Pure.
//
// Why: a file link is `src/a.js:3`, a path RELATIVE to the folder the command ran in, and the workbench hands the link
// provider the text of a line and the terminal it is in, nothing else (no row, no time). After `cd` the terminal's
// folder is another one, and in the agent's tab the folder of the last run is not the folder of the run above it. So
// what was written is remembered here, with the folder it was about, and the provider asks which folder a line it
// is shown was printed in.
//
// A line is known by its text as the terminal shows it (the cells of the row, tabs as the blanks they move over, the
// escape sequences gone). Two lines with the same text in two folders are told apart by nothing, and the latest one
// wins: the one that cannot be known resolves against the folder of the line that was written last. Lines the log
// has not seen (a line the editor drew, a progress bar that was overwritten) are not here at all, and the caller
// falls back to the folder the terminal is in now.
//
// Bounded: only lines that have a path-like word are kept, at most MAX_LINES of them, the first MAX_LINE characters
// of each; the characters of a line past that are not stored.
// @ts-check
'use strict';

const { cpWidth } = require('./width');
const { findCandidates, MAX_LINE } = require('./links');

/** At most this many lines are remembered; the oldest go first. */
const MAX_LINES = 400;

/**
 * The folders a stretch of output is about, most likely first. It is shared by every line of the stretch, so a folder
 * that becomes known later (the one a command ended in) is added once for all of them.
 * @typedef {{ cwds: string[] }} Scope
 */

/**
 * @param {{ max?: number }} [options]
 */
function createLineLog(options) {
	const max = options && options.max ? options.max : MAX_LINES;
	/** @type {Map<string, Scope>} */
	const lines = new Map();

	/** @type {Array<string | undefined>} the cells of the line being written; a hole is a cell nothing was written to */
	let cells = [];
	let col = 0;
	let last = -1;                 // the last cell that holds something
	/** @type {Scope | null} */
	let scope = null;              // the scope the line being written belongs to
	let state = 0;                 // 0 text, 1 after ESC, 2 in a CSI, 3 in an OSC, 4 in an OSC after ESC
	let csi = '';

	/** @param {string} s the line as the terminal shows it */
	const norm = (s) => (s.length > MAX_LINE ? s.slice(0, MAX_LINE) : s).trimEnd();

	function finish() {
		if (scope && last >= 0) {
			let text = '';
			for (let i = 0; i <= last; i++) { const c = cells[i]; text += c === undefined ? ' ' : c; }
			const key = norm(text);
			if (key !== '' && findCandidates(key).length > 0) {
				lines.delete(key);                     // the latest is the one kept, and the newest in the order
				lines.set(key, scope);
				if (lines.size > max) { lines.delete(/** @type {string} */ (lines.keys().next().value)); }
			}
		}
		cells = [];
		col = 0;
		last = -1;
	}

	/** @param {string} ch @param {number} w */
	function put(ch, w) {
		if (w === 0) {
			// it joins the cell before the cursor (the first half of a wide character is that cell, the second is empty)
			let at = Math.min(col, MAX_LINE) - 1;
			if (at >= 0 && cells[at] === '') { at--; }
			if (at >= 0 && cells[at] !== undefined) { cells[at] = /** @type {string} */ (cells[at]) + ch; }
			return;
		}
		if (col < MAX_LINE) {
			const end = col + w - 1;
			// writing over half of a wide character blanks the other half, as the terminal does
			if (cells[col] === '' && col > 0) { cells[col - 1] = ' '; }
			for (let c = col; c <= end; c++) {
				if (cells[c + 1] === '' && c + 1 > end) { cells[c + 1] = undefined; }
			}
			cells[col] = ch;
			if (w === 2) { cells[col + 1] = ''; }
			last = Math.max(last, end);
		}
		col += w;
	}

	/** @param {string} params @param {string} final */
	function sequence(params, final) {
		// only what changes what is on the row: erase to the end of it (and the whole row); every other movement is
		// left alone, and a line that depended on it is simply not found
		if (final === 'K') {
			const mode = params === '' ? 0 : Number(params);
			if (mode === 0) {
				// from the cursor: and from the middle of a wide character takes the half before it too
				if (col > 0 && cells[col] === '') { cells[col - 1] = undefined; }
				if (col < cells.length) { cells.length = col; }
				last = Math.min(last, col - 1);
			} else if (mode === 1) {
				// to the cursor, the cell under it too (and the second half of a wide character that it is the first of)
				for (let i = 0; i <= Math.min(col, cells.length - 1); i++) { cells[i] = undefined; }
				if (cells[col + 1] === '') { cells[col + 1] = undefined; }
			} else if (mode === 2) {
				cells = [];
				last = -1;
			}
		}
	}

	return {
		/**
		 * Text as it was written to the terminal (filtered output, the prompt, notes), about the folders of `about`.
		 * @param {string} text @param {Scope} about
		 */
		write(text, about) {
			if (scope !== about) {
				// what was written before is a line of its own, however it ended
				if (last >= 0) { finish(); }
				scope = about;
			}
			for (let i = 0; i < text.length; i++) {
				const c = text[i];
				switch (state) {
					case 1:
						if (c === '[') { state = 2; csi = ''; } else if (c === ']') { state = 3; } else { state = 0; }
						continue;
					case 2: {
						const code = c.charCodeAt(0);
						if (code >= 0x20 && code <= 0x3f) { if (csi.length < 64) { csi += c; } continue; }
						state = 0;
						if (code >= 0x40 && code <= 0x7e) { sequence(csi, c); }
						continue;
					}
					case 3:
						if (c === '\x07') { state = 0; } else if (c === '\x1b') { state = 4; }
						continue;
					case 4:
						state = c === '\\' ? 0 : 3;
						continue;
					default: break;
				}
				if (c === '\x1b') { state = 1; continue; }
				if (c === '\n') { finish(); continue; }
				if (c === '\r') { col = 0; continue; }
				if (c === '\b') { if (col > 0) { col--; } continue; }
				if (c === '\t') { col += 8 - (col % 8); continue; }
				const cp = /** @type {number} */ (text.codePointAt(i));
				if (cp > 0xffff) { i++; }
				if (cp < 0x20 || (cp >= 0x7f && cp <= 0x9f)) { continue; }
				put(cp > 0xffff ? String.fromCodePoint(cp) : c, cpWidth(cp));
			}
		},

		/**
		 * The folders the line was printed in, or undefined when the log has not seen a line like it.
		 * @param {string} line the text of a line, as the workbench gives it
		 * @returns {string[] | undefined}
		 */
		find(line) {
			const scoped = lines.get(norm(String(line)));
			return scoped ? scoped.cwds.slice() : undefined;
		},

		size: () => lines.size,
	};
}

module.exports = { createLineLog, MAX_LINES };
