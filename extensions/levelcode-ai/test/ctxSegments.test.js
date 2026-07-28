/*---------------------------------------------------------------------------------------------
 *  The context-usage breakdown — run: node test/ctxSegments.test.js
 *
 *  One invariant carries this whole function: the segments must SUM TO THE WINDOW. The popover draws
 *  a segmented bar from them and prints a percentage per row, so a slice that double-counts does not
 *  look like a bug — it looks like the model used more context than it did.
 *
 *  That is the trap the MCP segment walks into (docs/MCP.md S5): `tools` already counts every schema,
 *  MCP included, so an "MCP tools" row must be carved OUT of it, never added alongside.
 *
 *  Extracted from the shipped chat.html the same way narrativeUi/shHighlight do, so these exercise the
 *  real code rather than a copy that can drift from it.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'media', 'chat.html'), 'utf8');

function extract(name) {
	const start = html.indexOf('function ' + name + '(');
	assert.ok(start >= 0, 'chat.html no longer defines ' + name + '()');
	const end = html.indexOf('\n  }', start);
	assert.ok(end >= 0, 'no closing brace found for ' + name + '()');
	return html.slice(start, end + 4);
}

const sandbox = {};
new Function(extract('ctxSegments') + '\nthis.ctxSegments = ctxSegments;').call(sandbox);
const { ctxSegments } = /** @type {any} */ (sandbox);

let n = 0;
function test(name, fn) { fn(); n++; console.log('  ok - ' + name); }

const byKey = (seg) => Object.fromEntries(seg.map((s) => [ s.key, s.tokens ]));
const sum = (seg) => seg.reduce((a, s) => a + s.tokens, 0);

test('SUM: the segments always add up to the window, MCP or not', () => {
	const cases = [
		[ 50000, 200000, 2000, 8000, 0 ],
		[ 50000, 200000, 2000, 8000, 5000 ],
		[ 199999, 200000, 2000, 8000, 5000 ],
		[ 0, 200000, 2000, 8000, 5000 ],
		[ 3000, 200000, 2000, 8000, 5000 ],      // used < overhead: the clamps must still balance
		[ 50000, 200000, 0, 0, 0 ]
	];
	for (const [ used, limit, sys, tools, mcp ] of cases) {
		const seg = ctxSegments(used, limit, sys, tools, mcp);
		assert.strictEqual(sum(seg), limit,
			'segments must sum to the LIMIT for ' + JSON.stringify([ used, limit, sys, tools, mcp ]));
		for (const s of seg) { assert.ok(s.tokens >= 0, s.key + ' must never go negative'); }
	}
});

test('MCP is carved OUT of tools, never added alongside it', () => {
	const without = byKey(ctxSegments(50000, 200000, 2000, 8000, 0));
	const withMcp = byKey(ctxSegments(50000, 200000, 2000, 8000, 5000));

	assert.strictEqual(without.tools, 8000, 'no MCP: the whole tools estimate is "Tools"');
	assert.strictEqual(withMcp.tools + withMcp.mcp, 8000, 'with MCP: the two still total the estimate');
	assert.strictEqual(withMcp.mcp, 5000);
	assert.strictEqual(withMcp.tools, 3000);

	// The rest of the breakdown must not shift just because the tools slice was split.
	assert.strictEqual(withMcp.messages, without.messages, 'splitting tools must not move Messages');
	assert.strictEqual(withMcp.free, without.free, 'nor Free space');
});

test('the MCP row is absent when no server contributed a schema', () => {
	// The overwhelming majority of runs configure no MCP at all; a permanent "MCP tools 0" row would be
	// noise on the one popover people open when they are worried about space.
	assert.ok(!('mcp' in byKey(ctxSegments(50000, 200000, 2000, 8000, 0))));
	assert.ok(!('mcp' in byKey(ctxSegments(50000, 200000, 2000, 8000, undefined))));
	assert.ok('mcp' in byKey(ctxSegments(50000, 200000, 2000, 8000, 1)));
});

test('an over-large or junk MCP estimate cannot eat another segment', () => {
	// Both numbers are `length / 4` estimates, so they can disagree. The clamp must fail toward a
	// truthful bar rather than a negative slice.
	const over = byKey(ctxSegments(50000, 200000, 2000, 8000, 999999));
	assert.strictEqual(over.mcp, 8000, 'clamped to the tools slice');
	assert.strictEqual(over.tools, 0);
	assert.strictEqual(sum(ctxSegments(50000, 200000, 2000, 8000, 999999)), 200000);

	for (const junk of [ -5000, NaN, null, undefined, 'x' ]) {
		const seg = ctxSegments(50000, 200000, 2000, 8000, junk);
		assert.strictEqual(sum(seg), 200000, 'junk mcpTools must not unbalance the bar: ' + String(junk));
	}
});

test('percentages are computed against the window, not the used total', () => {
	const seg = ctxSegments(50000, 200000, 2000, 8000, 5000);
	const mcp = seg.find((s) => s.key === 'mcp');
	assert.strictEqual(mcp.pct, 2.5, '5000 / 200000');
});

console.log('\nctxSegments: ' + n + ' tests passed.');
