// Cell widths exactly as the workbench's terminal computes them: xterm.js with its Unicode 11 provider
// (`terminal.integrated.unicodeVersion`, default '11'). The table is DERIVED from the addon by gen-width.mjs and
// compared with it by shell-terminal-width.test.js; do not edit width-table.json by hand.
//
// The line editor places the cursor by counting cells, so a width that differs from xterm's by one is a cursor that
// sits on the wrong cell for the rest of the line. xterm measures CODE POINTS, not grapheme clusters: a ZWJ family
// emoji is 2+0+2+0+2 = 6 cells (measured), and that is what this module returns.
// @ts-check
'use strict';

/** @type {{ version: string, zero: number[][], wide: number[][] }} */
// @ts-ignore: a JSON module is the bundler's to resolve (esbuild inlines it)
const TABLE = require('./width-table.json');

/** @param {number[][]} ranges sorted, non-overlapping [lo, hi] pairs @param {number} cp */
function inRanges(ranges, cp) {
	let lo = 0;
	let hi = ranges.length - 1;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		if (cp < ranges[mid][0]) { hi = mid - 1; } else if (cp > ranges[mid][1]) { lo = mid + 1; } else { return true; }
	}
	return false;
}

/**
 * Cells one code point takes: 0 (controls, combining marks, ZWJ, variation selectors, ZWSP), 1 or 2.
 * @param {number} cp
 */
function cpWidth(cp) {
	if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) { return 0; }
	if (cp < 0x300) { return 1; }
	if (inRanges(TABLE.zero, cp)) { return 0; }
	if (inRanges(TABLE.wide, cp)) { return 2; }
	return 1;
}

/**
 * Cells a string takes when written at column 0 of a wide enough row. A tab counts as zero, like every control:
 * the editor lays tabs out itself.
 * @param {string} s
 */
function strWidth(s) {
	let w = 0;
	for (const ch of s) { w += cpWidth(/** @type {number} */ (ch.codePointAt(0))); }
	return w;
}

/**
 * The text of a prompt as it looks on screen: SGR and every other CSI/OSC sequence removed. Used to measure a prompt
 * that carries colours; the editor never lets a prompt carry anything that moves the cursor.
 * @param {string} s
 */
function stripEscapes(s) {
	return String(s)
		.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
		.replace(/\x1b\[[0-9;:?<=>]*[ -/]*[@-~]/g, '');
}

module.exports = { cpWidth, strWidth, stripEscapes, UNICODE_VERSION: TABLE.version };
