/*---------------------------------------------------------------------------------------------
 *  Unit tests for the response bar's credit formatting — run: node test/creditFormat.test.js
 *
 *  Like narrativeUi.test.js and shHighlight.test.js, the functions are EXTRACTED from the shipped
 *  chat.html, so these exercise the real code rather than a copy that can drift from it.
 *
 *  Two directions are load-bearing, and both are ways of lying about money:
 *    1. A run that cost something must never render as "0" — sub-credit turns are the common case on
 *       cheap models, so they floor rather than round away.
 *    2. A balance must never render negative. An overage can push it below zero, and "-2 left" is a
 *       worse thing to show someone than "0 left" (the dollar formatter this replaced clamped too).
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'media', 'chat.html'), 'utf8');

// Same slicing convention as narrativeUi.test.js: functions sit at 2 spaces and close with "  }".
function extract(name) {
	const start = html.indexOf('function ' + name + '(');
	assert.ok(start >= 0, 'chat.html no longer defines ' + name + '()');
	const end = html.indexOf('\n  }', start);
	assert.ok(end >= 0, 'no closing brace found for ' + name + '()');
	return html.slice(start, end + 4);
}

// MICROS_PER_CREDIT is a const in the same scope — pull it from the source so the test can never
// disagree with the shipped conversion rate.
const rateMatch = /const MICROS_PER_CREDIT = (\d+);/.exec(html);
assert.ok(rateMatch, 'chat.html no longer defines MICROS_PER_CREDIT');
assert.strictEqual(rateMatch[1], '10000', '1 credit must stay $0.01 — the website converts identically');

const sandbox = /** @type {any} */ ({});
new Function(
	'const MICROS_PER_CREDIT = ' + rateMatch[1] + ';\n'
	+ extract('toCredits') + '\n' + extract('creditBalance') + '\n' + extract('creditCost') + '\n'
	+ 'this.toCredits = toCredits; this.creditBalance = creditBalance; this.creditCost = creditCost;'
).call(sandbox);

const { toCredits, creditBalance, creditCost } = sandbox;

let n = 0;
function test(name, fn) { fn(); n++; console.log('  ok - ' + name); }

const usd = (d) => Math.round(d * 1e6);   // dollars → retail micro-$, the unit the gateway sends

// ---- 1. a cost must never read as free --------------------------------------------------------

test('COST: a sub-credit run floors to "<0.1" instead of rounding to zero', () => {
	// The cheap-model case, and the whole reason this is not a plain round(): a gpt-oss turn is ~0.4
	// credits and a very cheap one is far less. "0" would tell the user the run was free.
	assert.strictEqual(creditCost(usd(0.0002)), '<0.1');
	assert.strictEqual(creditCost(usd(0.0004)), '<0.1');
	assert.strictEqual(creditCost(usd(0.0036)), '0.4');   // the real gpt-oss per-turn figure
});

test('COST: keeps one decimal below 10, whole credits above', () => {
	assert.strictEqual(creditCost(usd(0.07)), '7.0', 'the trailing .0 must survive');
	assert.strictEqual(creditCost(usd(0.0767)), '7.7');
	assert.strictEqual(creditCost(usd(0.46)), '46');
	assert.strictEqual(creditCost(usd(0.5117)), '51');
});

test('COST: a genuinely zero cost is "0", not "<0.1"', () => {
	assert.strictEqual(creditCost(0), '0');
	assert.strictEqual(creditCost(-1), '0', 'a negative cost is nonsense — show nothing owed');
});

// ---- 2. a balance must never read negative ----------------------------------------------------

test('BALANCE: whole credits, with separators', () => {
	assert.strictEqual(creditBalance(usd(12.79)), '1,279');   // the figure the dashboard shows
	assert.strictEqual(creditBalance(usd(100)), '10,000');    // an Ultra month
	assert.strictEqual(creditBalance(usd(0.004)), '0');
});

test('BALANCE: an overage clamps to 0 rather than showing a negative', () => {
	// Going over budget makes remaining negative in the ledger. "-2 left" is worse than "0 left".
	assert.strictEqual(creditBalance(usd(-0.02)), '0');
	assert.strictEqual(creditBalance(usd(-5)), '0');
	assert.strictEqual(creditBalance(-1), '0');
});

// ---- 3. junk in, something sane out ------------------------------------------------------------

test('ROBUST: nullish and non-numeric input never render NaN', () => {
	for (const junk of [null, undefined, '', 'abc', {}, []]) {
		assert.strictEqual(creditBalance(junk), '0', 'balance from ' + JSON.stringify(junk));
		assert.strictEqual(creditCost(junk), '0', 'cost from ' + JSON.stringify(junk));
	}
	assert.strictEqual(toCredits(Infinity), 0, 'a non-finite figure must collapse to 0, not Infinity');
});

test('CONVERSION: $1 is 100 credits, in both directions of the bar', () => {
	assert.strictEqual(toCredits(usd(1)), 100);
	assert.strictEqual(creditBalance(usd(1)), '100');
	assert.strictEqual(creditCost(usd(1)), '100');
});

console.log('\ncreditFormat (chat.html): ' + n + ' tests passed.');
