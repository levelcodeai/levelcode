/*---------------------------------------------------------------------------------------------
 *  Sessions panel — pure render helpers + static invariants — run: node test/sessionsUi.test.js
 *
 *  The panel's logic lives inline in chat.html, so — like mcpManage — we EXTRACT the pure block
 *  (bracketed by [SESSIONS-PURE-START/END], esc/escAttr injected so it needs no webview globals) and
 *  unit-test the card/bucket/time output directly. Plus a few webviewCss-style static invariants for the
 *  things a DOM test can't see: the three theme token blocks, the reduced-motion guard, and the wiring.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'media', 'chat.html'), 'utf8');
const block = html.slice(html.indexOf('// [SESSIONS-PURE-START]'), html.indexOf('// [SESSIONS-PURE-END]'));
// eslint-disable-next-line no-new-func
const P = new Function(block + '; return { sessRelTime, sessBucket, sessMatch, sessModelShort, sessSparkSvg, sessGroup, sessCardHtml };')();

let n = 0;
function test(name, fn) { fn(); n++; console.log('  ok - ' + name); }

// deterministic, timezone-independent: `now` is a LOCAL noon (far from midnight); msAgo is an absolute delta
const now = new Date(2026, 6, 28, 12, 0, 0);
const NOW = now.getTime();
const msAgo = (secs) => new Date(NOW - secs * 1000).toISOString();
const esc = (s) => String(s == null ? '' : s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const escAttr = (s) => esc(s).replace(/"/g, '&quot;');

test('TIME: relative time steps through just-now → m → h → d → w → a date', () => {
	assert.strictEqual(P.sessRelTime(msAgo(20), NOW), 'just now');
	assert.strictEqual(P.sessRelTime(msAgo(30 * 60), NOW), '30m');
	assert.strictEqual(P.sessRelTime(msAgo(5 * 3600), NOW), '5h');
	assert.strictEqual(P.sessRelTime(msAgo(3 * 86400), NOW), '3d');
	assert.strictEqual(P.sessRelTime(msAgo(21 * 86400), NOW), '3w');
	const old = P.sessRelTime(msAgo(60 * 86400), NOW);
	assert.ok(old.length > 0 && !/^\d+[mhdw]$/.test(old) && old !== 'just now', '60d ago falls through to a date: ' + old);
});

test('BUCKET: today / yesterday / this week / earlier by local calendar day', () => {
	assert.strictEqual(P.sessBucket(msAgo(2 * 3600), NOW), 'Today');
	assert.strictEqual(P.sessBucket(msAgo(20 * 3600), NOW), 'Yesterday');
	assert.strictEqual(P.sessBucket(msAgo(4 * 86400), NOW), 'This week');
	assert.strictEqual(P.sessBucket(msAgo(20 * 86400), NOW), 'Earlier');
});

test('MATCH: search hits title, files, and preview; empty query matches all', () => {
	const e = { title: 'Refund retries', filesEdited: ['refund.rb'], preview: 'add idempotency' };
	assert.ok(P.sessMatch(e, ''));
	assert.ok(P.sessMatch(e, 'refund'), 'title');
	assert.ok(P.sessMatch(e, 'refund.rb'), 'file — the lead over Cursor');
	assert.ok(P.sessMatch(e, 'idempotency'), 'preview');
	assert.ok(!P.sessMatch(e, 'zzz'));
});

test('GROUP: pinned floats to its own bucket above the time buckets', () => {
	const g = P.sessGroup([
		{ id: 'p', pinned: true, updatedAt: msAgo(10 * 86400) },
		{ id: 't', updatedAt: msAgo(2 * 3600) },
		{ id: 'y', updatedAt: msAgo(20 * 3600) }
	], NOW);
	assert.deepStrictEqual(g.map((x) => x.bucket), ['Pinned', 'Today', 'Yesterday']);
	assert.strictEqual(g[0].entries[0].id, 'p', 'a pinned old session is Pinned, not Earlier');
});

test('SPARK: an array of counts becomes one <rect> per bar; empty is nothing', () => {
	assert.strictEqual(P.sessSparkSvg([]), '');
	const svg = P.sessSparkSvg([1, 2, 4]);
	assert.match(svg, /^<svg/);
	assert.strictEqual((svg.match(/<rect/g) || []).length, 3);
});

test('CARD (rest): two lines — title + primary-file·time; done shows NO state marker; pin only when pinned', () => {
	const done = { id: 's1', title: 'Idempotent refunds', updatedAt: msAgo(2 * 3600), turns: 41,
		model: 'anthropic/claude-opus-5', state: 'done', pinned: true, filesEdited: ['refund.rb', 'lock.rb', 'a', 'b'], spark: [1, 3, 5] };
	const h = P.sessCardHtml(done, NOW, esc, escAttr);
	assert.match(h, /class="sesscard"/, 'a finished session carries no state class (silent when normal)');
	assert.match(h, /data-id="s1"/);
	assert.match(h, /Idempotent refunds/);
	assert.match(h, /refund\.rb · 2h/, 'the quiet line = primary file · relative time');
	assert.match(h, /sessstar/, 'pinned → a star');
});

test('CARD (state): interrupted gets the warn left-edge; a done card and an unpinned card stay bare', () => {
	const intr = { id: 's2', title: 'flaky test', updatedAt: msAgo(3600), state: 'interrupted', filesEdited: ['w.rb'], turns: 3 };
	const h = P.sessCardHtml(intr, NOW, esc, escAttr);
	assert.match(h, /class="sesscard warn"/, 'interrupted → the only resting marker, a 2px edge');
	assert.ok(!/sessstar/.test(h), 'not pinned → no star');
});

test('CARD (rich): the hover detail carries files, model, turns, sparkline, and actions', () => {
	const e = { id: 's3', title: 't', updatedAt: msAgo(3600), turns: 41, model: 'anthropic/claude-opus-5',
		state: 'done', filesEdited: ['refund.rb', 'lock.rb', 'a', 'b'], spark: [1, 3, 5] };
	const h = P.sessCardHtml(e, NOW, esc, escAttr);
	assert.match(h, /sessrich/);
	assert.match(h, /claude-opus-5/, 'model shown short (no provider prefix)');
	assert.match(h, /41 turns/);
	assert.match(h, /<svg/, 'sparkline lives in the expand, not the resting row');
	assert.match(h, /data-act="resume"/, 'inline actions, no … menu');
	assert.match(h, /class="sesschip">\+1</, '4 files → 3 chips + overflow');
});

test('CARD (safety): the title is escaped, never injected raw', () => {
	const h = P.sessCardHtml({ id: 'x', title: '<script>alert(1)</script>', updatedAt: msAgo(60), state: 'done', filesEdited: [] }, NOW, esc, escAttr);
	assert.ok(h.indexOf('<script>alert') < 0, 'no raw markup from a session title');
	assert.match(h, /&lt;script&gt;/);
});

// ── static invariants (webviewCss style) ─────────────────────────────────────────────────────────

test('THEME: the panel defines classic tokens for all three VS Code theme kinds', () => {
	assert.match(html, /\.sesspanel\s*\{[^}]*--cc-accent:\s*#7d6bff/, 'One Dark defaults');
	assert.match(html, /body\.vscode-light\s+\.sesspanel\s*\{[^}]*--cc-accent:\s*#5b3fd6/, 'One Light');
	assert.match(html, /body\.vscode-high-contrast\s+\.sesspanel[^{]*\{[^}]*--vscode-contrastBorder/, 'high-contrast defers to editor tokens');
});

test('MOTION: the card animation is inside a prefers-reduced-motion guard', () => {
	assert.match(html, /@media \(prefers-reduced-motion: reduce\)\s*\{[^}]*\.sesscard[^}]*transition:\s*none/,
		'the hover lift must be reduced-motion-safe');
});

test('STATE→TOKEN: each resting state edge maps to a semantic --cc token, never a hard-coded hex', () => {
	assert.match(html, /\.sesscard\.warn\s*\{[^}]*border-left:[^}]*var\(--cc-warn\)/);
	assert.match(html, /\.sesscard\.err\s*\{[^}]*border-left:[^}]*var\(--cc-danger\)/);
	assert.match(html, /\.sesscard\.res\s*\{[^}]*border-left:[^}]*var\(--cc-accent\)/);
});

test('WIRING: /sessions opens the panel, and a "sessions" message renders real entries', () => {
	assert.match(html, /\/\^\\\/sessions\\b\/i\.test\(t\)/, 'the composer intercepts /sessions');
	assert.match(html, /m\.type === 'sessions'/, 'and the host can push entries');
	assert.match(html, /id="sessOverlay"/, 'the overlay exists');
	assert.match(html, /id="sessList"/, 'and its list container');
});

console.log('sessionsUi: ' + n + ' tests passed');
