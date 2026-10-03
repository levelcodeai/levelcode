/*---------------------------------------------------------------------------------------------
 *  Static guards for the session-expired path in media/chat.html — run: node test/sessionExpiredUi.test.js
 *
 *  The incident this covers: a gateway 401 that a token refresh could not recover reached the
 *  transcript as red text — "LevelCode Cloud API 401: Signature has expired" — while the account
 *  popover still said "signed in". The fix routes `code: 'session_expired'` to a sign-in card in
 *  BOTH error handlers and on a host-pushed startup check. A DOM test cannot see the routing
 *  order inside the message switch; these read the source and pin it.
 *
 *  The host's BEHAVIOUR — what ends a session, what replays the card, who falls back to BYOK — is
 *  run, not read, in sessionExpiredHost.test.js. What stays here is what can only be read: the order of
 *  the `ready` handler and the wiring between the two files.
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

test('the card is dismissed when an account message says no expiry is waiting', () => {
	// Signing in is one way to get there; BYOK chosen in Settings and a cleared cloud host are others.
	// The host decides (currentAccount → `expired`); the webview does not keep its own list of reasons.
	const b = branch('account');
	assert.ok(/if \(!m\.expired && sessionCard && sessionCard\.isConnected\)\{ sessionCard\.remove\(\); sessionCard = null; \}/.test(b));
	assert.ok(!/m\.signedIn && sessionCard/.test(b), 'not on sign-in alone');
	assert.ok(/signedIn: true, mode, expired: false,/.test(ext) && /signedIn: false, mode, expired: sessionExpiredPending\(\),/.test(ext), 'both account shapes carry it');
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

test('host: every focus runs the check — the ten-minute ration is on the refresh, inside it', () => {
	// With the ration in the hook, a window that had checked a minute ago did not look again, and so
	// did not notice another window ending the session they share until the next message failed.
	assert.ok(/onDidChangeWindowState\(\(st\) => \{\s*if \(st\.focused\) \{ checkCloudSession\('focus'\); \}/.test(ext), 'no time condition in the hook');
	const fn = ext.slice(ext.indexOf('async function checkCloudSession('), ext.indexOf('async function refreshGatewayToken('));
	const catchUp = fn.indexOf('await catchUpWithStoredSession(token)');
	const ration = fn.indexOf("reason === 'focus' && Date.now() - lastSessionCheck <= SESSION_CHECK_EVERY_MS");
	assert.ok(catchUp > 0 && ration > 0, 'both halves present');
	assert.ok(catchUp < ration, 'catching up comes before the ration');
});

test('host: ready replays an unanswered expiry LAST — after the check, and under a replayed transcript', () => {
	// The focus check can end the session with no chat open; post() then has nowhere to send the card,
	// and the next `ready` finds no token to check. The replay is what shows it — and it has to come
	// after the transcript replay, or a chat moved to an editor tab gets the card above its history.
	const ready = /case 'ready':[^\n]*/.exec(ext)[0];
	const check = ready.indexOf("await checkCloudSession('ready')");
	const transcript = ready.indexOf('replayLiveTranscript(');
	const replay = ready.indexOf('await replaySessionExpired()');
	assert.ok(check >= 0 && transcript >= 0 && replay >= 0, 'all three steps present');
	assert.ok(check < transcript && transcript < replay, 'order: check, transcript, expiry replay');
	assert.ok(/await replaySessionExpired\(\); break;$/.test(ready.trimEnd()), 'the replay is the last thing ready does');
});

test('host: the card\'s "use my own key" button answers the expiry before it opens the setting', () => {
	const byok = /case 'byokSettings':[^\n]*/.exec(ext)[0];
	assert.ok(byok.indexOf('await clearSessionExpired()') >= 0, 'marker cleared');
	assert.ok(byok.indexOf('await clearSessionExpired()') < byok.indexOf('workbench.action.openSettings'), 'before the settings open');
});

test('host: refresh stores the rotated refresh token and only a 401 ends the session', () => {
	const fn = ext.slice(ext.indexOf('async function refreshCloudToken('), ext.indexOf('async function sessionExpired('));
	assert.ok(/data\.refresh\)\s*\{\s*await ctx\.secrets\.store\(ACCOUNT_REFRESH_KEY, data\.refresh\)/.test(fn), 'rotation stored');
	assert.ok(/session\.classifyRefresh\(/.test(fn), 'classified, not res.ok');
	assert.ok(/outcome === 'expired'\)\s*\{\s*if \(await sessionExpired\(was\)\)/.test(fn), 'expired → sessionExpired, for the session the request was about');
});

test('host: only an ENDED session is signedOut — "no token" alone still falls back to BYOK', () => {
	// Gateway is the default mode, so gating this on "no token" turned every BYOK user with no
	// account into an expired session. It hangs off the marker sessionExpired() leaves instead.
	const fn = ext.slice(ext.indexOf('async function prepProviderRequest('), ext.indexOf('function captureSelection('));
	assert.ok(/if \(!token && sessionExpiredPending\(\)\) \{\s*return \{[^}]*reason: 'signedOut', gateway: true \};/.test(fn));
	assert.ok(!/providerMode\(\) === 'gateway' && !token/.test(fn), 'the token-only condition is gone');
	assert.ok(/req\.reason === 'signedOut'\)\s*\{ return session\.SESSION_EXPIRED_MESSAGE; \}/.test(ext));
});

test('host: the chat catch shows the card only once the session has ended, and never ends it itself', () => {
	const fn = ext.slice(ext.indexOf('async function handleSend('), ext.indexOf('async function setModelSetting('));
	// Chat and the agent ask ONE question, in one place — so a clause added for one (a sign-out is
	// not an expiry) cannot be missing from the other.
	assert.ok(/if \(isEndedSessionError\(req, e\)\) \{/.test(fn), 'the chat catch asks isEndedSessionError');
	assert.ok(/isSessionExpired: \(e\) => isEndedSessionError\(req, e\),/.test(ext), 'and so does the hook handed to agent.js');
	assert.ok(/refreshAuth: async \(\) => \{\s*if \(!req\.gateway\) \{ return null; \}\s*return \(await refreshGatewayToken\(\)\) \? await ctx\.secrets\.get\(ACCOUNT_TOKEN_KEY\) : null;/.test(ext), 'refreshAuth renews through the same refresh');
	const rule = ext.slice(ext.indexOf('function isEndedSessionError('), ext.indexOf('async function clearSessionExpired('));
	assert.ok(/!!\(req && req\.gateway\) && !cloudSignedIn && sessionExpiredPending\(\) && session\.isSessionExpiredError\(e\)/.test(rule), 'gateway, signed out, an expiry waiting, a 401');
	assert.ok(!/\bsessionExpired\(/.test(fn.replace(/\/\/[^\n]*/g, '')), 'handleSend does not call sessionExpired()');
	const only = (ext.replace(/\/\/[^\n]*/g, '').match(/await sessionExpired\(/g) || []).length;
	assert.strictEqual(only, 1, 'one caller ends a session: the refresh endpoint answering 401');
});

// ── the card itself, run against a stand-in DOM ─────────────────────────────────────────────────
function signInCard() {
	const posted = [];
	const log = { children: [], appendChild(c) { this.children.push(c); c.parent = this; c.isConnected = true; return c; } };
	const createElement = () => {
		const buttons = {};
		return {
			className: '', parent: null, isConnected: false, _html: '',
			set innerHTML(v) { this._html = String(v); for (const m of this._html.matchAll(/data-act="([\w-]+)"/g)) { buttons[m[1]] = { onclick: null }; } },
			get innerHTML() { return this._html; },
			querySelector(sel) { const m = /^\[data-act="([\w-]+)"\]$/.exec(sel); assert.ok(m, 'stand-in DOM cannot parse ' + sel); return buttons[m[1]] || null; },
			remove() { if (this.parent) { this.parent.children.splice(this.parent.children.indexOf(this), 1); } this.parent = null; this.isConnected = false; }
		};
	};
	const start = html.indexOf('function addSignInCard(');
	const fnSrc = html.slice(start, html.indexOf('\n  }', start) + 4);
	// eslint-disable-next-line no-new-func
	const api = new Function('document', 'log', 'vscode',
		'const clearStatus = () => {}, finishAgentBubble = () => {}, closeGroup = () => {}, scrollIfStuck = () => {};\n'
		+ 'const esc = (s) => String(s), codicon = (n) => "<i:" + n + ">";\nlet sessionCard = null;\n' + fnSrc
		+ '\nreturn { addSignInCard, current: () => sessionCard };')({ createElement }, log, { postMessage: (m) => posted.push(m) });
	return { api, log, posted };
}

test('card: a second expiry notice replaces the first — one card, however many paths find it', () => {
	const { api, log } = signInCard();
	api.addSignInCard({ name: 'Ada' });
	api.addSignInCard({});   // e.g. the assistantError that follows the host-pushed notice
	assert.strictEqual(log.children.length, 1);
	assert.strictEqual(api.current(), log.children[0]);
});

test('card: "Sign in" starts the sign-in and leaves the card up until an account message says it worked', () => {
	const { api, log, posted } = signInCard();
	api.addSignInCard({ name: 'Ada' });
	assert.ok(/Welcome back, Ada\./.test(log.children[0].innerHTML));
	log.children[0].querySelector('[data-act="signin"]').onclick();
	assert.deepStrictEqual(posted, [{ type: 'accountSignIn' }]);
	assert.strictEqual(log.children.length, 1);
});

test('card: "Use my own key instead" tells the host and takes the card away', () => {
	const { api, log, posted } = signInCard();
	api.addSignInCard({});
	log.children[0].querySelector('[data-act="byok"]').onclick();
	assert.deepStrictEqual(posted, [{ type: 'byokSettings' }]);
	assert.strictEqual(log.children.length, 0, 'the card is gone');
	assert.strictEqual(api.current(), null);
});

console.log('\nsessionExpiredUi: ' + n + ' tests passed.');
