// Timing for the tests that say "this stays linear": the text a terminal is given is not trusted, and the extension host
// is one thread that every extension shares, so a pattern that is quadratic in a run of blanks is a freeze that the
// model (or a file, or a command) can cause. The inputs are the shapes that make a backtracking pattern, or a loop that
// rescans, go wrong: long runs of one separator, of a two-character unit, of something that opens and never closes,
// of marks and joiners. The budget is far above what a linear pass costs (tens of milliseconds for 200,000
// characters, on a slow machine a few times that) and far below what a quadratic one costs (18 s for the first one).
// @ts-check
'use strict';

const assert = require('assert');

/** The size of an input: big enough that a quadratic pass is minutes, small enough that a linear one is a blink. */
const N = 200000;
/** What one call may take for an input of that size. */
const BUDGET_MS = 500;

/** The shapes. Each is a string of about N characters. @returns {Record<string, string>} */
function pathological(n = N) {
	return {
		'a run of spaces': 'a' + ' '.repeat(n) + 'b',
		'a run of tabs': 'a' + '\t'.repeat(n) + 'b',
		'a run of no-break spaces': 'a' + ' '.repeat(n) + 'b',
		'a run of line separators': 'a' + ' '.repeat(n) + 'b',
		'a run of line feeds': 'a' + '\n'.repeat(n) + 'b',
		'a run of carriage returns': 'a' + '\r'.repeat(n) + 'b',
		'CR LF pairs': 'a' + '\r\n'.repeat(n / 2) + 'b',
		'blank and line feed, in turn': ' \n'.repeat(n / 2),
		'line feed and blank, in turn': 'x\n '.repeat(n / 3),
		'a: pairs': 'a:'.repeat(n / 2),
		'open parentheses': '('.repeat(n),
		'backslashes': '\\'.repeat(n),
		'$( pairs': '$('.repeat(n / 2),
		'quotes': '"'.repeat(n),
		'combining marks': 'e' + '́'.repeat(n),
		'emoji joined by ZWJ': '\u{1f468}‍'.repeat(n / 2) + '\u{1f467}',
		'check marks with variation selectors': '✔️'.repeat(n / 2),
		'dots': '.'.repeat(n) + 'x',
		'slashes': '/'.repeat(n) + 'a',
		'ESC [ pairs': '\x1b['.repeat(n / 2),
		'ESC ] pairs': '\x1b]'.repeat(n / 2),
		'an unfinished CSI': '\x1b[' + ';'.repeat(n),
		'letters': 'a'.repeat(n),
	};
}

/**
 * How long a call takes, in milliseconds.
 * @param {() => unknown} fn
 */
function took(fn) {
	const t0 = process.hrtime.bigint();
	fn();
	return Number(process.hrtime.bigint() - t0) / 1e6;
}

/**
 * Run `fn(input)` over every shape and fail, naming it, when one takes longer than the budget.
 * @param {string} what  the code under test, for the message
 * @param {(input: string, shape: string) => unknown} fn
 * @param {{ n?: number, budget?: number, only?: string[] }} [o]
 * @returns {number} the slowest, in ms
 */
function everyShape(what, fn, o) {
	const opts = o || {};
	const budget = opts.budget || BUDGET_MS;
	let worst = 0;
	for (const [shape, input] of Object.entries(pathological(opts.n))) {
		if (opts.only && !opts.only.includes(shape)) { continue; }
		const ms = took(() => fn(input, shape));
		assert.ok(ms < budget, what + ' took ' + ms.toFixed(0) + ' ms (budget ' + budget + ' ms) on ' + shape + ' of ' + input.length + ' characters');
		worst = Math.max(worst, ms);
	}
	return worst;
}

module.exports = { N, BUDGET_MS, pathological, took, everyShape };
