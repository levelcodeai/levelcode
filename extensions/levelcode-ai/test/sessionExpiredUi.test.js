/*---------------------------------------------------------------------------------------------
 *  Static guards for the session-expired path in media/chat.html — run: node test/sessionExpiredUi.test.js
 *
 *  The incident this covers: a gateway 401 that a token refresh could not recover reached the
 *  transcript as red text — "LevelCode Cloud API 401: Signature has expired" — while the account
 *  popover still said "signed in". The fix routes `code: 'session_expired'` to a sign-in card in
 *  BOTH error handlers and on a host-pushed startup check. A DOM test cannot see the routing
 *  order inside the message switch; these read the source and pin it.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'media', 'chat.html'), 'utf8');
const ext = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');
const agent = fs.readFileSync(path.join(__dirname, '..', 'agent.js'), 'utf8');

let n = 0;
function test(name, fn) { fn(); n++; console.log('  ok - ' + name); }

/** The body of the `else if (m.type === '<type>'){ … }` branch — up to the next top-level `else if`. */
function branch(type) {
	const start = html.indexOf("m.type === '" + type + "'");
	assert.ok(start > 0, 'no handler for ' + type);
	const next = html.indexOf('\n    else if (m.type ===', start + 1);
	return html.slice(start, next > 0 ? next : start + 2000);
}

test('a sign-in card exists and is a button, not text', () => {
	assert.ok(/function addSignInCard\(/.test(html));
	assert.ok(/data-act="signin"/.test(html.slice(html.indexOf('function addSignInCard('), html.indexOf('function addSignInCard(') + 2500)));
	assert.ok(/type: 'accountSignIn'/.test(html.slice(html.indexOf('function addSignInCard('), html.indexOf('function addSignInCard(') + 2500)));
});

test('assistantError: session_expired is checked BEFORE the cap card and the red-text fallback', () => {
	const b = branch('assistantError');
	const i = b.indexOf('isSessionExpired(m)'), cap = b.indexOf('addUpgradeCard('), red = b.indexOf("class=\"err\"");
	assert.ok(i > 0 && cap > 0 && red > 0, 'all three paths present');
	assert.ok(i < cap && i < red, 'session check is not first');
});

test('agentError: the same ordering', () => {
	const b = branch('agentError');
	const i = b.indexOf('isSessionExpired(m)'), cap = b.indexOf('addUpgradeCard('), red = b.indexOf("class=\"err\"");
	assert.ok(i > 0 && cap > 0 && red > 0, 'all three paths present');
	assert.ok(i < cap && i < red, 'session check is not first');
});

test('a host-pushed sessionExpired (startup / focus check) shows the card before anything is typed', () => {
	assert.ok(/m\.type === 'sessionExpired'\)\{ addSignInCard\(m\); \}/.test(html));
});

test('the card is dismissed when a signed-in account message arrives', () => {
	const b = branch('account');
	assert.ok(/m\.signedIn && sessionCard/.test(b));
});

test('the card uses an icon the inline codicon set actually defines', () => {
	const m = /function addSignInCard\([\s\S]*?codicon\('([a-z-]+)'\)/.exec(html);
	assert.ok(m, 'card has an icon');
	assert.ok(new RegExp("'" + m[1] + "': \\{ vb:").test(html), 'icon "' + m[1] + '" is not in the set');
});

test('host: both send paths and the agent run name a dead session as session_expired', () => {
	// Two shapes: the chat catch names it outright; the two prep-failure sites name it via a ternary on
	// req.reason, so count the string wherever it appears as a code value.
	assert.ok((ext.match(/'session_expired'/g) || []).length >= 3, 'chat catch + two prep sites');
	assert.ok(/code: 'session_expired'/.test(agent), 'agent.js run-level catch');
	assert.ok(/isSessionExpired: \(e\) =>/.test(ext), 'ctx hook handed to agent.js');
});

test('host: the webview ready handler checks the session before the first message', () => {
	assert.ok(/case 'ready':[^\n]*await checkCloudSession\('ready'\)/.test(ext));
	assert.ok(/onDidChangeWindowState/.test(ext), 'focus re-check');
});

test('host: refresh stores the rotated refresh token and only a 401 ends the session', () => {
	const fn = ext.slice(ext.indexOf('async function refreshCloudToken('), ext.indexOf('async function sessionExpired('));
	assert.ok(/data\.refresh\)\s*\{\s*await ctx\.secrets\.store\(ACCOUNT_REFRESH_KEY, data\.refresh\)/.test(fn), 'rotation stored');
	assert.ok(/session\.classifyRefresh\(/.test(fn), 'classified, not res.ok');
	assert.ok(/outcome === 'expired'\)\s*\{\s*await sessionExpired\(\)/.test(fn), 'expired → sessionExpired');
});

test('host: gateway mode with no token is signedOut, never "No API key set"', () => {
	assert.ok(/reason: 'signedOut', gateway: true/.test(ext));
	assert.ok(/req\.reason === 'signedOut'\)\s*\{ return session\.SESSION_EXPIRED_MESSAGE; \}/.test(ext));
});

console.log('\nsessionExpiredUi: ' + n + ' tests passed.');
