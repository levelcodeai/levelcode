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
const P = new Function(block + '; return { sessRelTime, sessBucket, sessModelShort, sessGroup, sessCardHtml };')();

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

test('GROUP: pinned floats to its own bucket above the time buckets', () => {
	const g = P.sessGroup([
		{ id: 'p', pinned: true, updatedAt: msAgo(10 * 86400) },
		{ id: 't', updatedAt: msAgo(2 * 3600) },
		{ id: 'y', updatedAt: msAgo(20 * 3600) }
	], NOW);
	assert.deepStrictEqual(g.map((x) => x.bucket), ['Pinned', 'Today', 'Yesterday']);
	assert.strictEqual(g[0].entries[0].id, 'p', 'a pinned old session is Pinned, not Earlier');
});

test('CARD (rest): two lines — title + primary-file·time; done has no state class; pinned adds the class', () => {
	const done = { id: 's1', title: 'Idempotent refunds', updatedAt: msAgo(2 * 3600), turns: 41,
		model: 'anthropic/claude-opus-5', state: 'done', pinned: true, filesEdited: ['refund.rb', 'lock.rb'] };
	const h = P.sessCardHtml(done, NOW, esc, escAttr);
	assert.match(h, /class="sesscard pinned"/, 'done = no state class; pinned adds .pinned (resting star + accent)');
	assert.match(h, /data-id="s1"/);
	assert.match(h, /Idempotent refunds/);
	assert.match(h, /refund\.rb · 2h/, 'the quiet line = primary file · relative time');
	assert.match(h, /data-act="pin"[^>]*aria-label="Unpin"/, 'the pin toggle offers Unpin when pinned');
});

test('CARD (state): interrupted gets the warn class; an unpinned card has no pinned class', () => {
	const intr = { id: 's2', title: 'flaky test', updatedAt: msAgo(3600), state: 'interrupted', filesEdited: ['w.rb'], turns: 3 };
	const h = P.sessCardHtml(intr, NOW, esc, escAttr);
	assert.match(h, /class="sesscard warn"/, 'interrupted → the warn class (status dot / left edge)');
	assert.ok(!/pinned/.test(h), 'not pinned → no pinned class');
	assert.match(h, /data-act="pin"[^>]*aria-label="Pin"/, 'and the toggle offers Pin');
});

test('CARD (actions): four row icon buttons (rename/done/delete/pin); clicking the card body resumes', () => {
	const e = { id: 's3', title: 't', updatedAt: msAgo(3600), turns: 41, model: 'anthropic/claude-opus-5',
		state: 'done', filesEdited: ['refund.rb', 'lock.rb'] };
	const h = P.sessCardHtml(e, NOW, esc, escAttr);
	for (const a of ['rename', 'done', 'delete', 'pin']) { assert.match(h, new RegExp('data-act="' + a + '"'), a + ' action present'); }
	assert.ok(!/data-act="resume"/.test(h), 'no Resume icon — clicking the card body resumes (default action)');
	assert.match(h, /class="sessacts">/, 'actions live in the row…');
	assert.ok(!/sessrich|sessbtn|sesschip|sessmeta/.test(h), '…not the old drawer/chip/meta markup');
	assert.match(h, /<svg class="ci"/, 'actions are icon buttons');
	assert.match(h, /aria-label="Rename"/, 'labelled for a11y (icon-only)');
	assert.match(h, /title="t — 41 turns · claude-opus-5 · refund\.rb, lock\.rb"/, 'model · turns · files fold into the tooltip');
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

// ── the Sessions sidebar view (a second WebviewView) ─────────────────────────────────────────────

const pkg = require('../package.json');
const ext = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');
const view = fs.readFileSync(path.join(__dirname, '..', 'media', 'sessionsView.html'), 'utf8');

test('RESUME WIRING: the host acts on card actions and the chat replays a resumed transcript', () => {
	assert.match(ext, /async function handleSessionAction/, 'a dispatcher for resume/done/rename/delete');
	assert.match(ext, /async function resumeSession/, 'and a resume path');
	assert.match(ext, /case 'sessionAction': await handleSessionAction\(/, 'both providers route actions to it');
	assert.match(ext, /type: 'sessionResumed'/, 'the host posts a resumed transcript');
	assert.match(ext, /m\.archive\(id\)[\s\S]{0,60}refreshSessions|refreshSessions\(\)/, 'Done archives (reversible), then the list refreshes');
	assert.match(html, /m\.type === 'sessionResumed'/, 'and the chat handles it');
	assert.match(html, /function resumeTranscript/, 'via a dedicated replay (prompts + prose, tool plumbing dropped)');
});

test('HOUSEKEEPING: a Pin toggle on the card, and a 30-day auto-archive sweep on startup', () => {
	assert.match(ext, /action === 'pin'[\s\S]{0,120}setPinned\(id, !cur\)/, 'Pin toggles the pinned flag');
	assert.match(ext, /autoArchiveStale\(\{ days \}\)/, 'startup runs the auto-archive sweep');
	assert.match(ext, /sessions\.autoArchiveDays/, 'gated by the setting');
	assert.ok((pkg.contributes.configuration.properties || {})['levelcode.ai.sessions.autoArchiveDays'], 'the setting is contributed');
	assert.ok(/sessActBtn\('pin'/.test(html) && /sessActBtn\('pin'/.test(view), 'both surfaces render a Pin action');
});

test('VIEW: the sidebar view and the modal share the EXACT same render block (no drift)', () => {
	const grab = (s) => s.slice(s.indexOf('// [SESSIONS-PURE-START]'), s.indexOf('// [SESSIONS-PURE-END]'));
	assert.ok(grab(view).length > 500, 'the view carries the pure block');
	assert.strictEqual(grab(view), grab(html), 'the two blocks must be byte-identical, or the two surfaces drift');
});

test('VIEW: contributed as a second webview view in the levelcodeAi container, with a palette command', () => {
	const views = (pkg.contributes.views || {}).levelcodeAi || [];
	const ids = views.map((v) => v.id);
	assert.ok(ids.includes('levelcodeAi.chat') && ids.includes('levelcodeAi.sessions'), 'both Chat and Sessions views present');
	assert.strictEqual(views.find((v) => v.id === 'levelcodeAi.sessions').type, 'webview');
	assert.ok((pkg.contributes.commands || []).some((c) => c.command === 'levelcode.ai.sessions'), 'a Command Palette entry exists');
});

test('VIEW: extension.js registers the provider and builds the HTML with a nonce/CSP', () => {
	assert.match(ext, /registerWebviewViewProvider\('levelcodeAi\.sessions', new SessionsViewProvider\(\)/);
	assert.match(ext, /function getSessionsHtml/);
	assert.match(ext, /sessionsView\.html/);
	assert.match(ext, /case 'newSession': newChat\(\)/, 'New Session starts a fresh chat');
	assert.match(view, /content="__CSP__"/);
	assert.match(view, /nonce="__NONCE__"/);
});

test('CAP: the surfaces list at most 30 sessions (no search → a bounded working set), pinned exempt', () => {
	assert.match(ext, /SESSIONS_SHOWN\s*=\s*30/, 'the displayed list is capped at 30');
	assert.match(ext, /function sessionList\(\)[\s\S]{0,400}pinned/, 'and a pinned session is never dropped for being old');
	assert.ok(!/id="sessSearch"|id="svSearch"/.test(html + view), 'neither surface still ships a search field');
});

test('VIEW: theme-true across the three kinds and reduced-motion-safe', () => {
	assert.match(view, /:root\s*\{[^}]*--cc-accent:\s*#7d6bff/, 'One Dark defaults');
	assert.match(view, /body\.vscode-light\s*\{[^}]*--cc-accent:\s*#5b3fd6/, 'One Light');
	assert.match(view, /body\.vscode-high-contrast[^{]*\{[^}]*--vscode-contrastBorder/, 'high-contrast defers to editor tokens');
	assert.match(view, /@media \(prefers-reduced-motion: reduce\)[\s\S]{0,120}\.sesscard[\s\S]{0,80}transition:\s*none/);
});

test('NO-JUMP: actions reveal as row icon buttons (no drawer), so the row height stays fixed on hover', () => {
	for (const [name, src] of [['modal', html], ['sidebar', view]]) {
		assert.ok(!/\.sesscard \.sessrich/.test(src), name + ': the old hover drawer is gone (nothing floats over neighbours)');
		assert.match(src, /\.sesscard \.sessacts \{[^}]*display: none/, name + ': actions are hidden at rest');
		assert.match(src, /\.sesscard:hover \.sessacts[^{]*\{[^}]*display: flex/, name + ': and revealed on hover');
		assert.match(src, /\.sesscard \.sesstop \{[^}]*min-height/, name + ': the row reserves the icon height so appearing icons never nudge it');
	}
});

console.log('sessionsUi: ' + n + ' tests passed');
