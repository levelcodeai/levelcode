/*---------------------------------------------------------------------------------------------
 *  The "Manage MCP servers…" rows — run: node test/mcpManage.test.js
 *
 *  Two pure functions out of extension.js decide what a user is TOLD about a server they cannot
 *  start. Both are claims about a security gate, which is why they get tests despite being three
 *  lines each:
 *
 *    mcpTrustIsStale  — "you approved this, and the repo has changed it since". The G1 attack in
 *                       docs/MCP.md is exactly this: get a benign command approved, then swap it.
 *                       summarizeMcp reports both cases as trusted:false, so if this collapses them
 *                       the UI silently downgrades an attack to "never set up".
 *    mcpServerItem    — the row itself. "not started" on a server that is actually waiting for
 *                       consent sends the user to debug a gate that is working correctly.
 *
 *  Extracted from the shipped extension.js the way ctxSegments/narrativeUi do with chat.html:
 *  extension.js requires the `vscode` module at load, which does not exist outside the editor, and a
 *  copy of the function here would be a test of the copy.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');

// Slice a top-level `function <name>(...) {…}` out of the source by matching its braces, not by
// looking for the first `\n}` (which truncates the moment a nested block's closing brace lands on its
// own line — i.e. on any reformat). Scan brace depth from the header's opening brace, skipping braces
// that live inside strings or comments, and stop at the brace that returns depth to zero. Dependency-free.
function extract(name) {
	const start = src.indexOf('function ' + name + '(');
	assert.ok(start >= 0, 'extension.js no longer defines ' + name + '()');
	const open = src.indexOf('{', start);
	assert.ok(open >= 0, 'no opening brace found for ' + name + '()');
	let depth = 0, str = '', comment = '';
	for (let i = open; i < src.length; i++) {
		const ch = src[i], next = src[i + 1];
		if (comment === 'line') { if (ch === '\n') { comment = ''; } continue; }
		if (comment === 'block') { if (ch === '*' && next === '/') { comment = ''; i++; } continue; }
		if (str) {
			if (ch === '\\') { i++; }                 // escaped char inside a string — skip it
			else if (ch === str) { str = ''; }
			continue;
		}
		if (ch === '/' && next === '/') { comment = 'line'; i++; continue; }
		if (ch === '/' && next === '*') { comment = 'block'; i++; continue; }
		if (ch === '"' || ch === "'" || ch === '`') { str = ch; continue; }
		if (ch === '{') { depth++; }
		else if (ch === '}' && --depth === 0) { return src.slice(start, i + 1); }
	}
	assert.fail('no matching closing brace found for ' + name + '()');
}

// eslint-disable-next-line no-new-func
const load = new Function(extract('mcpTrustIsStale') + '\n' + extract('mcpServerItem')
	+ '\nreturn { mcpTrustIsStale, mcpServerItem };');
const { mcpTrustIsStale, mcpServerItem } = load();

let n = 0;
function test(name, fn) { fn(); n++; console.log('  ok - ' + name); }

/** A summarizeMcp-shaped row. */
function row(over) {
	return Object.assign({
		name: 'fs', source: 'workspace', origin: '.levelcode/mcp.json', running: false,
		trusted: false, commandLine: 'npx -y server-filesystem /work', tools: 0, allowed: null, toolNames: []
	}, over);
}

// ---- mcpTrustIsStale ----

test('STALE: an approval that exists but no longer matches is stale, not "never approved"', () => {
	// The whole point. Same server name in the trust store => it WAS approved; trusted:false now =>
	// the fingerprint changed. Both facts are needed, and only their combination means "changed".
	assert.strictEqual(mcpTrustIsStale(row(), { fs: 'sha256-of-the-old-command' }), true);
	assert.strictEqual(mcpTrustIsStale(row(), {}), false, 'no entry at all is simply never approved');
	assert.strictEqual(mcpTrustIsStale(row(), { other: 'x' }), false, 'a different server being trusted says nothing');
});

test('STALE: a server that IS currently trusted is never reported as changed', () => {
	// trusted:true means the stored fingerprint matched — there is nothing stale about it.
	assert.strictEqual(mcpTrustIsStale(row({ trusted: true }), { fs: 'sha256-current' }), false);
});

test('STALE: a settings server is never stale — it has no fingerprint to go stale', () => {
	// summarizeMcp deliberately reports trusted:null for user-authored servers (they need no consent).
	// A stale badge on one would be pure fiction.
	assert.strictEqual(mcpTrustIsStale(row({ source: 'settings', trusted: null }), { fs: 'x' }), false);
});

test('STALE: junk trust stores do not throw and do not fake an approval', () => {
	for (const store of [ null, undefined, {} ]) {
		assert.strictEqual(mcpTrustIsStale(row(), store), false, 'store: ' + JSON.stringify(store));
	}
	// hasOwnProperty, not `in` / `store[name]`: every object inherits `toString`, and a server may be
	// legally named that. `'toString' in {}` is true, which would invent an approval nobody gave.
	assert.strictEqual(mcpTrustIsStale(row({ name: 'toString' }), {}), false,
		'an inherited property must not be mistaken for a stored approval');
	assert.strictEqual(mcpTrustIsStale(row({ name: 'constructor' }), {}), false);
});

// ---- mcpServerItem ----

test('ROW: a repo server awaiting consent says so, instead of looking merely unstarted', () => {
	const it = mcpServerItem(row(), {});
	assert.match(it.description, /needs approval/);
	assert.doesNotMatch(it.description, /not started/);
	assert.match(it.label, /^\$\(shield\) fs$/);
	assert.strictEqual(it.detail, 'npx -y server-filesystem /work', 'the command line is what consent is about');
});

test('ROW: a changed command line outranks the plain "needs approval" wording', () => {
	const it = mcpServerItem(row(), { fs: 'sha256-of-the-old-command' });
	assert.match(it.description, /command changed/);
	assert.match(it.label, /^\$\(warning\)/, 'and it is flagged, not shown as a routine unstarted server');
});

test('ROW: a running server reports its tool counts; a stopped one invents none', () => {
	const live = mcpServerItem(row({ running: true, trusted: true, tools: 12, allowed: 3 }), { fs: 'x' });
	assert.match(live.description, /running/);
	assert.match(live.description, /12 tools/);
	assert.match(live.description, /3 allow-listed/);

	const idle = mcpServerItem(row({ source: 'settings', trusted: null }), {});
	assert.match(idle.description, /not started/);
	assert.doesNotMatch(idle.description, /tool/, 'a server that never started has no tool count to report');
});

test('ROW: one tool is not "1 tools"', () => {
	assert.match(mcpServerItem(row({ running: true, trusted: true, tools: 1, allowed: 0 }), {}).description, /1 tool · /);
});

test('ROW: provenance is always visible — settings vs which repo file', () => {
	// The difference that decides whether the entry is user-authored or attacker-authored. It belongs
	// on the row, not one level down.
	assert.match(mcpServerItem(row({ source: 'settings', trusted: null }), {}).description, /your settings/);
	assert.match(mcpServerItem(row(), {}).description, /\.levelcode\/mcp\.json/);
	assert.match(mcpServerItem(row({ origin: '' }), {}).description, /workspace/, 'a missing origin still says untrusted');
});

console.log('\nmcpManage (extension.js): ' + n + ' tests passed.');
