/*---------------------------------------------------------------------------------------------
 *  Behaviour of the cloud-session code in extension.js — run: node test/sessionExpiredHost.test.js
 *
 *  sessionExpiredUi.test.js pins strings; this RUNS the code. The difference is why it exists: the
 *  first version of this change read `req` in a catch that could not see it, so every failed chat
 *  request threw a ReferenceError instead of showing an error — and every string guard passed,
 *  because the strings were all there. What is pinned here is what the user gets:
 *
 *    - a failed chat request is an error in the transcript, never an exception
 *    - a refresh that merely FAILED (offline, 5xx, a malformed reply) keeps the session; only the
 *      refresh endpoint answering 401 ends it
 *    - an expiry found while no chat was open is shown by the next webview to load, and keeps
 *      being shown until the user answers it: signs in, signs out, or picks their own key
 *    - gateway is the DEFAULT mode, so "no token" still means BYOK for everyone who never had a
 *      session — only an ENDED session may stop a request and ask for a sign-in
 *    - a refresh's answer belongs to the session it started against: one that arrives after a
 *      sign-in or a sign-out changes nothing, and the request itself cannot outlast its deadline
 *    - New Chat, a resumed session and a checkpoint restore rewrite the transcript in place; the
 *      card they take with them is put back
 *
 *  The functions are sliced out of the shipped extension.js and run against stand-ins for what they
 *  touch (SecretStorage, globalState, fetch, the provider adapter), the way mcpManage.test.js does
 *  it: extension.js requires `vscode` at load, and a copy here would be a test of the copy.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const session = require('../providers/session');
const { resolveGateway, GATEWAY_PATH } = require('../providers/gateway');

const src = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');

// Slice a top-level `[async] function <name>(...) {…}` out of the source by matching its braces,
// skipping the ones inside strings and comments (see mcpManage.test.js for why not "first `\n}`").
function extract(name) {
	let start = src.indexOf('function ' + name + '(');
	assert.ok(start >= 0, 'extension.js no longer defines ' + name + '()');
	const open = src.indexOf('{', start);
	if (src.slice(start - 6, start) === 'async ') { start -= 6; }
	let depth = 0, str = '', comment = '';
	for (let i = open; i < src.length; i++) {
		const ch = src[i], next = src[i + 1];
		if (comment === 'line') { if (ch === '\n') { comment = ''; } continue; }
		if (comment === 'block') { if (ch === '*' && next === '/') { comment = ''; i++; } continue; }
		if (str) {
			if (ch === '\\') { i++; }
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

/** A one-line top-level declaration, taken from the source so the keys here cannot drift from the real ones. */
function decl(name) {
	const m = new RegExp('^(?:const|let) ' + name + ' = [^;\\n]*;', 'm').exec(src);
	assert.ok(m, 'extension.js no longer declares ' + name);
	return m[0];
}

const FUNCTIONS = [
	'post', 'providerMode', 'providerErrorMessage', 'isAuthError', 'cloudEndpoint', 'cloudApiUrl',
	'refreshCloudToken', 'withSessionLock', 'sameSession', 'sessionExpired', 'postSessionExpired',
	'sessionExpiredPending', 'clearSessionExpired', 'replaySessionExpired', 'checkCloudSession',
	'refreshGatewayToken', 'prepProviderRequest', 'handleSend', 'accountSignOut', 'storeSession',
	'newChat', 'resumeSession', 'restoreCheckpoint'
];
// eslint-disable-next-line no-new-func
const makeHost = new Function('env', [
	"'use strict';",
	'const { vscode, session, providers, resolveGateway, fetch, ctx, dbg, aiConfig, postAccount, sendConfigToWebview,',
	'  gatewayModel, maxOutputTokens, currentProviderId, baseUrlFor, getProviderKey, activeModel, storeImages, agentFlow,',
	'  listWorkspaceFiles, workspaceMapBlock, activeFileBlock, contextFileBlocks, gatherAutoContext, labelImages, withImages,',
	'  sealLiveSession, resetConversationState, postContextFiles, postMemoryDigest, sessionsManager, currentContextLimit,',
	'  refreshSessions, focusChatView, review, checkpoints } = env;',
	"const SYSTEM_PROMPT = 'system';",
	'let activeWebview = env.webview, cloudSignedIn = env.signedIn, agentMode = false, conversation = [], pendingContext = null, conversationEpoch = 0, abort = null;',
	'let agentMessages = [], currentCheckpoint = null, lastAgentGoal = null;',
	decl('ACCOUNT_TOKEN_KEY'), decl('ACCOUNT_REFRESH_KEY'), decl('ACCOUNT_PROFILE_KEY'), decl('ACCOUNT_EXPIRED_KEY'),
	decl('sessionQueue'), decl('sessionGeneration'), decl('lastSessionCheck'),
	...FUNCTIONS.map(extract),
	'return { ' + FUNCTIONS.join(', ') + ',',
	'  KEY: { token: ACCOUNT_TOKEN_KEY, refresh: ACCOUNT_REFRESH_KEY, profile: ACCOUNT_PROFILE_KEY, expired: ACCOUNT_EXPIRED_KEY },',
	'  signedIn: () => cloudSignedIn, conversation: () => conversation, abort: () => abort,',
	'  openWebview: (w) => { activeWebview = w; }, setAgentMessages: (m) => { agentMessages = m; } };'
].join('\n'));

// The defaults a fresh install runs with come from package.json, not from this file: the whole
// point of the BYOK cases below is what happens to someone who has changed nothing.
const pkg = require('../package.json');
const settingDefaults = Object.assign({}, ...[].concat(pkg.contributes.configuration).map((c) => c.properties || {}));
function shippedDefault(key) { return settingDefaults[key] ? settingDefaults[key].default : undefined; }

/** An unsigned JWT with the given payload — its `exp` is all the host reads. */
function jwt(payload) {
	const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
	return b64({ alg: 'HS256', typ: 'JWT' }) + '.' + b64(payload) + '.sig';
}
const HOUR = 3600;
const now = () => Math.floor(Date.now() / 1000);
const liveAccess = () => jwt({ sub: 1, exp: now() + 8 * HOUR });
const deadAccess = () => jwt({ sub: 1, exp: now() - HOUR });

/** The gateway's answer to an expired access token, as the openai adapter throws it. */
const gateway401 = () => new Error('LevelCode Cloud API 401: {"error":{"code":"token_expired","message":"Your LevelCode Cloud session has expired. Sign in again to continue."}}');

/** One turn of the event loop — what every SecretStorage / globalState call costs in the editor. */
const tick = () => new Promise((resolve) => setImmediate(resolve));
/** Let everything already in motion finish. */
async function settle() { for (let i = 0; i < 25; i++) { await tick(); } }
/** Wait for something the host is doing in the background; fail rather than spin if it never happens. */
async function until(cond, what) {
	for (let i = 0; i < 200; i++) { if (cond()) { return; } await tick(); }
	assert.fail('never happened: ' + what);
}
/** A reply that arrives when the test says so. */
function deferred() { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; }
/** Fail loudly, instead of hanging the suite, when something that must finish does not. */
function within(promise, ms, what) {
	let timer;
	const late = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(what + ' did not finish within ' + ms + ' ms')), ms); });
	return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

/**
 * One editor window: the sliced host functions wired to in-memory stand-ins.
 *   settings      — overrides on top of the shipped defaults (`null` unsets one)
 *   access/refresh/profile/expired — what SecretStorage and globalState hold at the start
 *   byokKey       — the user's own provider key ('' = none saved); t.keyError makes the lookup throw
 *   webview       — false to start with the chat closed
 *   refreshTimeoutMs — the refresh deadline, so a test of it need not take ten seconds
 *
 * The stores answer a turn of the event loop LATER, as the real ones do: every call to them is a
 * round trip to another process. That gap is where two session changes can interleave, so a
 * stand-in that answered at once would hide exactly what the lock is for.
 */
function boot(over) {
	const o = Object.assign({ settings: {}, access: null, refresh: null, profile: null, expired: false, byokKey: '', webview: true, refreshTimeoutMs: 0 }, over);
	const settings = {
		'levelcode.ai.providerMode': shippedDefault('levelcode.ai.providerMode'),
		'levelcode.cloud.endpoint': shippedDefault('levelcode.cloud.endpoint'),
		'levelcode.ai.chat.autoContext': false, 'levelcode.ai.chat.workspaceMap': false
	};
	for (const k of Object.keys(o.settings)) { if (o.settings[k] === null) { delete settings[k]; } else { settings[k] = o.settings[k]; } }

	const secrets = new Map(), state = new Map(), posted = [], ops = [];
	const calls = { refresh: [], stream: [], keyPrompts: 0, account: 0 };
	const vscode = { workspace: { getConfiguration: (section) => ({ get: (k, d) => (settings[section + '.' + k] === undefined ? d : settings[section + '.' + k]) }) } };
	const webview = { postMessage: (m) => { posted.push(m); } };
	const t = {
		posted, calls, ops, secrets, state, webview, settings,
		/**
		 * What POST /auth/refresh answers: 'offline'; 'stall' (accepts, never answers); { status, body },
		 * where a body of 'garbage' is unparseable and 'stall' never arrives; or a function returning any
		 * of those, or a promise of one — which is how a reply is made to arrive late.
		 */
		refreshReply: 'offline',
		/** Called with every write the host makes to the stores, as it starts — the hook for landing something mid-change. */
		onOp: (_op) => { },
		checkpoints: [],
		/** The provider adapter: called with the request, and the attempt number. */
		stream: async (_req, _attempt) => { },
		byokKey: o.byokKey,
		/** @type {Error|null} */ keyError: null,
		types: () => posted.map((m) => m.type),
		last: (type) => posted.filter((m) => m.type === type).pop()
	};
	const env = {
		vscode, resolveGateway, webview: o.webview ? webview : undefined, signedIn: !!o.access,
		session: o.refreshTimeoutMs ? Object.assign({}, session, { REFRESH_TIMEOUT_MS: o.refreshTimeoutMs }) : session,
		ctx: {
			secrets: {
				get: async (k) => { await tick(); return secrets.get(k); },
				store: async (k, v) => { const op = 'store ' + k; ops.push(op); t.onOp(op); await tick(); secrets.set(k, v); },
				delete: async (k) => { const op = 'forget ' + k; ops.push(op); t.onOp(op); await tick(); secrets.delete(k); }
			},
			globalState: {
				get: (k) => state.get(k),
				update: async (k, v) => {
					const op = (v === undefined ? 'clear ' : 'set ') + k; ops.push(op); t.onOp(op); await tick();
					if (v === undefined) { state.delete(k); } else { state.set(k, v); }
				}
			}
		},
		fetch: async (url, init) => {
			const call = { url, body: JSON.parse(init.body), signal: init.signal };
			calls.refresh.push(call);
			// Silence until the caller's own deadline aborts the request. With no signal there is nothing
			// to end it, and it hangs — which is the bug, and what within() then reports.
			const silence = () => new Promise((_, reject) => {
				if (init.signal) { init.signal.addEventListener('abort', () => reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }))); }
			});
			const r = typeof t.refreshReply === 'function' ? await t.refreshReply(call) : t.refreshReply;
			if (r === 'offline') { throw new TypeError('fetch failed'); }
			if (r === 'stall') { return silence(); }
			return {
				status: r.status,
				json: async () => {
					if (r.body === 'garbage') { throw new SyntaxError('Unexpected token <'); }
					if (r.body === 'stall') { return silence(); }
					return r.body;
				}
			};
		},
		providers: {
			getProvider: (id) => ({ id, label: 'Claude' }),
			isInsecureCustomUrl: () => false,
			streamChat: async (req) => { calls.stream.push(req); return t.stream(req, calls.stream.length); }
		},
		getProviderKey: async (_id, opts) => {
			if (t.keyError) { throw t.keyError; }
			if (!t.byokKey && opts && opts.prompt) { calls.keyPrompts++; }
			return t.byokKey || undefined;
		},
		aiConfig: () => vscode.workspace.getConfiguration('levelcode.ai'),
		dbg: () => { }, postAccount: async () => { calls.account++; }, sendConfigToWebview: () => { },
		gatewayModel: () => 'cloud-model', maxOutputTokens: () => 4096, currentProviderId: () => 'claude',
		baseUrlFor: () => '', activeModel: () => 'claude-model', storeImages: () => [], agentFlow: async () => { },
		listWorkspaceFiles: async () => [], workspaceMapBlock: () => '', activeFileBlock: () => '',
		contextFileBlocks: async () => [], gatherAutoContext: async () => ({ blocks: [], names: [] }),
		labelImages: (b) => b, withImages: (m) => m,
		// What New Chat, a resumed session and a checkpoint restore touch besides the transcript.
		sealLiveSession: () => { }, resetConversationState: () => { },
		postContextFiles: () => { posted.push({ type: 'contextFiles' }); }, postMemoryDigest: () => { posted.push({ type: 'memoryDigest' }); },
		sessionsManager: () => ({
			resume: () => ({
				messages: [{ role: 'user', content: 'an earlier goal' }], entry: { title: 'An earlier session' }, note: '', plan: { tier: 1 },
				turns: [{ role: 'user', text: 'an earlier goal' }, { role: 'assistant', text: 'done' }]
			})
		}),
		currentContextLimit: () => 200000, refreshSessions: () => { }, focusChatView: () => { },
		review: { restoreOne: async () => true, finalizeAll: () => { } }, checkpoints: t.checkpoints
	};
	t.host = makeHost(env);
	const K = t.host.KEY;
	if (o.access) { secrets.set(K.token, o.access); }
	if (o.refresh) { secrets.set(K.refresh, o.refresh); }
	if (o.profile) { state.set(K.profile, o.profile); }
	if (o.expired) { state.set(K.expired, true); }
	t.K = K;
	return t;
}

let n = 0;
async function test(name, fn) { await fn(); n++; console.log('  ok - ' + name); }

(async () => {
	await test('premise: a fresh install is in gateway mode with a cloud host configured', () => {
		assert.strictEqual(shippedDefault('levelcode.ai.providerMode'), 'gateway');
		assert.ok(/^https:\/\//.test(shippedDefault('levelcode.cloud.endpoint')), 'a default endpoint is set');
	});

	// ── a failed chat request is an error in the transcript, never an exception ──────────────────
	await test('chat: a BYOK provider error is posted as assistantError (the catch can read req)', async () => {
		const t = boot({ byokKey: 'sk-own' });
		t.stream = async () => { throw new Error('Claude API 529: overloaded'); };
		await t.host.handleSend('hello');   // the regression: this REJECTED with "req is not defined"
		const err = t.last('assistantError');
		assert.ok(err, 'an assistantError was posted — the webview is not left streaming');
		assert.strictEqual(err.message, 'Claude API 529: overloaded');
		assert.notStrictEqual(err.code, 'session_expired');
		assert.strictEqual(t.host.conversation().length, 0, 'the failed turn was taken back out');
		assert.strictEqual(t.host.abort(), null, 'the turn released its abort controller');
	});

	await test('chat: an error while PREPARING the request is posted too, not thrown', async () => {
		const t = boot({ byokKey: 'sk-own' });
		t.keyError = new Error('keychain is locked');
		await t.host.handleSend('hello');
		assert.strictEqual(t.last('assistantError').message, 'keychain is locked');
		assert.strictEqual(t.calls.stream.length, 0, 'nothing was sent');
		assert.strictEqual(t.host.conversation().length, 0, 'the failed turn was taken back out');
	});

	await test('chat: a gateway error that is not a 401 is shown as itself', async () => {
		const t = boot({ access: liveAccess(), refresh: 'r1' });
		t.stream = async () => { const e = new Error('LevelCode Cloud API 402: {"error":{"code":"cap_reached"}}'); e.code = 'cap_reached'; throw e; };
		await t.host.handleSend('hello');
		const err = t.last('assistantError');
		assert.strictEqual(err.code, 'cap_reached');
		assert.strictEqual(t.calls.refresh.length, 0, 'not an auth failure — no refresh attempted');
		assert.ok(t.secrets.get(t.K.token) && t.secrets.get(t.K.refresh), 'session untouched');
	});

	// ── only the refresh endpoint's 401 ends the session ─────────────────────────────────────────
	for (const [label, reply] of [
		['offline', 'offline'],
		['a 503', { status: 503, body: null }],
		['an unparseable reply', { status: 200, body: 'garbage' }],
		['a 200 with no token in it', { status: 200, body: {} }]
	]) {
		await test('chat: a 401 whose refresh fails (' + label + ') keeps the session and shows the error', async () => {
			const access = liveAccess();
			const t = boot({ access, refresh: 'r1', profile: { name: 'Ada' } });
			t.refreshReply = reply;
			t.stream = async () => { throw gateway401(); };
			await t.host.handleSend('hello');
			assert.strictEqual(t.calls.refresh.length, 1, 'one refresh attempt');
			assert.strictEqual(t.secrets.get(t.K.token), access, 'access token kept');
			assert.strictEqual(t.secrets.get(t.K.refresh), 'r1', 'refresh token kept');
			assert.strictEqual(t.host.signedIn(), true, 'still signed in');
			assert.strictEqual(t.state.get(t.K.expired), undefined, 'no expiry recorded');
			assert.ok(!t.types().includes('sessionExpired'), 'no sign-in card');
			const err = t.last('assistantError');
			assert.ok(err && /API 401/.test(err.message), 'the request error is shown');
			assert.notStrictEqual(err.code, 'session_expired');
			assert.strictEqual(t.calls.stream.length, 1, 'no retry without a fresh token');
		});
	}

	await test('chat: a 401 whose refresh is REFUSED (401) ends the session — one card, credentials gone', async () => {
		const t = boot({ access: liveAccess(), refresh: 'r1', profile: { name: 'Ada' } });
		t.refreshReply = { status: 401, body: { error: { code: 'refresh_expired' } } };
		t.stream = async () => { throw gateway401(); };
		await t.host.handleSend('hello');
		assert.strictEqual(t.secrets.get(t.K.token), undefined);
		assert.strictEqual(t.secrets.get(t.K.refresh), undefined);
		assert.strictEqual(t.host.signedIn(), false);
		assert.strictEqual(t.state.get(t.K.expired), true, 'the expiry is recorded');
		assert.deepStrictEqual(t.last('sessionExpired'), { type: 'sessionExpired', name: 'Ada', message: session.SESSION_EXPIRED_MESSAGE });
		const err = t.last('assistantError');
		assert.strictEqual(err.code, 'session_expired');
		assert.strictEqual(err.message, session.SESSION_EXPIRED_MESSAGE);
		assert.deepStrictEqual(t.state.get(t.K.profile), { name: 'Ada' }, 'profile kept so the card can greet by name');
		assert.ok(t.calls.account >= 1, 'the account popover was resynced, so it stops saying "signed in"');
	});

	await test('chat: a 401 whose refresh succeeds retries once on the new token and stores the rotated pair', async () => {
		const t = boot({ access: liveAccess(), refresh: 'r1' });
		const fresh = liveAccess() + 'x';
		t.refreshReply = { status: 200, body: { access: fresh, refresh: 'r2' } };
		t.stream = async (req, attempt) => { if (attempt === 1) { throw gateway401(); } };
		await t.host.handleSend('hello');
		assert.deepStrictEqual(t.calls.refresh[0].body, { refresh: 'r1' });
		assert.strictEqual(t.secrets.get(t.K.token), fresh);
		assert.strictEqual(t.secrets.get(t.K.refresh), 'r2', 'rotated refresh token stored');
		assert.strictEqual(t.calls.stream.length, 2);
		assert.strictEqual(t.calls.stream[1].apiKey, fresh, 'the retry carries the new token');
		assert.ok(t.types().includes('assistantDone') && !t.types().includes('assistantError'));
	});

	await test('sessionExpired: the marker is written BEFORE the credentials are forgotten', async () => {
		const t = boot({ access: deadAccess(), refresh: 'r1' });
		t.refreshReply = { status: 401, body: { error: { code: 'refresh_expired' } } };
		await t.host.checkCloudSession('focus');
		const marker = t.ops.indexOf('set ' + t.K.expired), forget = t.ops.indexOf('forget ' + t.K.token);
		assert.ok(marker >= 0 && forget >= 0 && marker < forget, 'order was: ' + t.ops.join(', '));
	});

	// ── an expiry nobody was there to see is replayed, until it is answered ──────────────────────
	await test('focus check with the chat CLOSED: the session ends, and the next webview to load shows the card', async () => {
		const t = boot({ access: deadAccess(), refresh: 'r1', profile: { name: 'Ada' }, webview: false });
		t.refreshReply = { status: 401, body: { error: { code: 'refresh_expired' } } };
		await t.host.checkCloudSession('focus');
		assert.strictEqual(t.secrets.get(t.K.token), undefined, 'credentials are gone');
		assert.deepStrictEqual(t.posted, [], 'nobody was listening');

		t.host.openWebview(t.webview);            // the user opens the chat
		await t.host.checkCloudSession('ready');  // …which finds no token and says nothing
		assert.deepStrictEqual(t.posted, []);
		await t.host.replaySessionExpired();      // …and `ready` ends with the replay
		assert.deepStrictEqual(t.posted, [{ type: 'sessionExpired', name: 'Ada', message: session.SESSION_EXPIRED_MESSAGE }]);
	});

	await test('replay: every fresh document gets the card while the expiry is unanswered', async () => {
		const t = boot({ expired: true, profile: { name: 'Ada' } });
		await t.host.replaySessionExpired();   // a new chat
		await t.host.replaySessionExpired();   // the chat moved to an editor tab
		assert.strictEqual(t.posted.filter((m) => m.type === 'sessionExpired').length, 2);
	});

	await test('replay: answered by signing in again', async () => {
		const t = boot({ expired: true });
		await t.host.storeSession(liveAccess(), 'r2', { name: 'Ada' });
		assert.strictEqual(t.state.get(t.K.expired), undefined);
		await t.host.replaySessionExpired();
		assert.deepStrictEqual(t.posted, []);
	});

	await test('replay: answered by signing out on purpose', async () => {
		const t = boot({ expired: true, profile: { name: 'Ada' } });
		await t.host.accountSignOut();
		assert.strictEqual(t.state.get(t.K.expired), undefined);
		await t.host.replaySessionExpired();
		assert.ok(!t.types().includes('sessionExpired'));
	});

	await test('replay: answered by choosing your own key', async () => {
		const t = boot({ expired: true });
		await t.host.clearSessionExpired();
		await t.host.replaySessionExpired();
		assert.deepStrictEqual(t.posted, []);
	});

	await test('replay: silent for someone who never had a session, in BYOK mode, with no host, or with a live token', async () => {
		const never = boot({}); await never.host.replaySessionExpired();
		assert.deepStrictEqual(never.posted, [], 'never signed in');
		const byok = boot({ expired: true, settings: { 'levelcode.ai.providerMode': 'byok' } }); await byok.host.replaySessionExpired();
		assert.deepStrictEqual(byok.posted, [], 'BYOK mode');
		const inert = boot({ expired: true, settings: { 'levelcode.cloud.endpoint': '' } }); await inert.host.replaySessionExpired();
		assert.deepStrictEqual(inert.posted, [], 'no cloud host to sign in to');
		const live = boot({ expired: true, access: liveAccess() }); await live.host.replaySessionExpired();
		assert.deepStrictEqual(live.posted, [], 'another window signed in again');
	});

	await test('session check: a token with hours left costs no request; one near expiry is renewed', async () => {
		const fine = boot({ access: liveAccess(), refresh: 'r1' });
		await fine.host.checkCloudSession('ready');
		assert.strictEqual(fine.calls.refresh.length, 0);
		const stale = boot({ access: deadAccess(), refresh: 'r1' });
		const fresh = liveAccess();
		stale.refreshReply = { status: 200, body: { access: fresh, refresh: 'r2' } };
		await stale.host.checkCloudSession('ready');
		assert.strictEqual(stale.secrets.get(stale.K.token), fresh);
		assert.deepStrictEqual(stale.posted, [], 'renewed silently');
	});

	// ── gateway is the default mode: "no token" is BYOK unless a session ENDED ───────────────────
	await test('BYOK: a fresh install with its own key and no account goes straight to the provider', async () => {
		const t = boot({ byokKey: 'sk-own' });
		const req = await t.host.prepProviderRequest({ prompt: true });
		assert.strictEqual(req.ok, true);
		assert.strictEqual(req.providerId, 'claude');
		assert.strictEqual(req.apiKey, 'sk-own');
		assert.ok(!req.gateway, 'not the gateway');
		await t.host.handleSend('hello');
		assert.strictEqual(t.calls.stream.length, 1, 'the message was sent');
		assert.strictEqual(t.calls.stream[0].apiKey, 'sk-own');
		assert.ok(t.types().includes('assistantDone'));
		assert.ok(!t.posted.some((m) => m.code === 'session_expired' || m.type === 'sessionExpired'), 'no sign-in card');
	});

	await test('BYOK: no account and no key is "No API key set for <provider>", not a session card', async () => {
		const t = boot({});
		const req = await t.host.prepProviderRequest({ prompt: true });
		assert.deepStrictEqual({ ok: req.ok, reason: req.reason, providerId: req.providerId }, { ok: false, reason: 'key', providerId: 'claude' });
		assert.ok(/^No API key set for Claude/.test(t.host.providerErrorMessage(req)));
		assert.strictEqual(t.calls.keyPrompts, 1, 'and the key prompt is offered, as before');
	});

	await test('BYOK: signing out on purpose falls back to your own key', async () => {
		const t = boot({ access: liveAccess(), refresh: 'r1', profile: { name: 'Ada' }, byokKey: 'sk-own' });
		assert.strictEqual((await t.host.prepProviderRequest({ prompt: true })).gateway, true, 'on the plan while signed in');
		await t.host.accountSignOut();
		const req = await t.host.prepProviderRequest({ prompt: true });
		assert.deepStrictEqual({ ok: req.ok, providerId: req.providerId, apiKey: req.apiKey }, { ok: true, providerId: 'claude', apiKey: 'sk-own' });
	});

	await test('signed in: the request routes through the gateway on the session token', async () => {
		const access = liveAccess();
		const t = boot({ access, refresh: 'r1', byokKey: 'sk-own' });
		const req = await t.host.prepProviderRequest({ prompt: true });
		assert.strictEqual(req.gateway, true);
		assert.strictEqual(req.apiKey, access);
		assert.strictEqual(req.baseURL, shippedDefault('levelcode.cloud.endpoint') + GATEWAY_PATH);
	});

	await test('an ENDED session stops the request with a sign-in card — own key or not, and never a key prompt', async () => {
		for (const byokKey of ['', 'sk-own']) {
			const t = boot({ expired: true, byokKey });
			const req = await t.host.prepProviderRequest({ prompt: true });
			assert.deepStrictEqual({ ok: req.ok, reason: req.reason, gateway: req.gateway }, { ok: false, reason: 'signedOut', gateway: true });
			assert.strictEqual(t.host.providerErrorMessage(req), session.SESSION_EXPIRED_MESSAGE);
			assert.strictEqual(t.calls.keyPrompts, 0, 'nobody is asked for a key they never needed');
			await t.host.handleSend('hello');
			assert.strictEqual(t.last('assistantError').code, 'session_expired');
			assert.strictEqual(t.calls.stream.length, 0, 'nothing was sent');
		}
	});

	await test('an ended session answered with "use my own key" is BYOK from the next message', async () => {
		const t = boot({ expired: true, byokKey: 'sk-own' });
		await t.host.clearSessionExpired();
		const req = await t.host.prepProviderRequest({ prompt: true });
		assert.deepStrictEqual({ ok: req.ok, providerId: req.providerId, apiKey: req.apiKey }, { ok: true, providerId: 'claude', apiKey: 'sk-own' });
	});

	await test('an ended session answered by switching to BYOK mode is BYOK too', async () => {
		const t = boot({ expired: true, byokKey: 'sk-own', settings: { 'levelcode.ai.providerMode': 'byok' } });
		assert.strictEqual((await t.host.prepProviderRequest({ prompt: true })).ok, true);
	});

	// ── a refresh's answer belongs to the session it started against ─────────────────────────────
	const refused = { status: 401, body: { error: { code: 'refresh_expired' } } };

	await test('late 401: a sign-in that lands while the refresh is out keeps its new session', async () => {
		const t = boot({ access: deadAccess(), refresh: 'r1', profile: { name: 'Ada' } });
		const reply = deferred();
		t.refreshReply = () => reply.promise;
		const check = t.host.checkCloudSession('focus');          // the old session's refresh goes out…
		await until(() => t.calls.refresh.length === 1, 'the refresh request');
		const fresh = liveAccess();
		await t.host.storeSession(fresh, 'r2', { name: 'Ada' });  // …the user signs in again…
		reply.resolve(refused);                                   // …and only now does the 401 for r1 arrive
		await check;
		assert.strictEqual(t.secrets.get(t.K.token), fresh, 'the new access token survived');
		assert.strictEqual(t.secrets.get(t.K.refresh), 'r2', 'the new refresh token survived');
		assert.strictEqual(t.state.get(t.K.expired), undefined, 'no expiry recorded against the new session');
		assert.strictEqual(t.host.signedIn(), true);
		assert.ok(!t.types().includes('sessionExpired'), 'no sign-in card');
	});

	await test('late 401: a sign-in that brought no refresh token of its own is a new session all the same', async () => {
		// The stored refresh token is unchanged here, so comparing tokens would call this "the same
		// session" and delete an access token minted seconds ago. Counting sign-ins does not.
		const t = boot({ access: deadAccess(), refresh: 'r1' });
		const reply = deferred();
		t.refreshReply = () => reply.promise;
		const check = t.host.checkCloudSession('focus');
		await until(() => t.calls.refresh.length === 1, 'the refresh request');
		const fresh = liveAccess();
		await t.host.storeSession(fresh, null, { name: 'Ada' });
		reply.resolve(refused);
		await check;
		assert.strictEqual(t.secrets.get(t.K.token), fresh);
		assert.strictEqual(t.state.get(t.K.expired), undefined);
		assert.ok(!t.types().includes('sessionExpired'));
	});

	await test('late 401: a sign-out while the refresh is out is not turned into an expiry', async () => {
		const t = boot({ access: deadAccess(), refresh: 'r1', profile: { name: 'Ada' } });
		const reply = deferred();
		t.refreshReply = () => reply.promise;
		const check = t.host.checkCloudSession('focus');
		await until(() => t.calls.refresh.length === 1, 'the refresh request');
		await t.host.accountSignOut();
		reply.resolve(refused);
		await check;
		assert.strictEqual(t.state.get(t.K.expired), undefined, 'signed out on purpose: nothing to answer');
		assert.ok(!t.types().includes('sessionExpired'), 'no sign-in card');
		assert.strictEqual(t.calls.account, 1, 'only the sign-out resynced the popover');
	});

	await test('late 200: a sign-out while the refresh is out stays signed out', async () => {
		const t = boot({ access: deadAccess(), refresh: 'r1' });
		const reply = deferred();
		t.refreshReply = () => reply.promise;
		const renewal = t.host.refreshCloudToken();
		await until(() => t.calls.refresh.length === 1, 'the refresh request');
		await t.host.accountSignOut();
		reply.resolve({ status: 200, body: { access: liveAccess(), refresh: 'r2' } });
		assert.strictEqual(await renewal, false, 'nothing to retry with');
		assert.strictEqual(t.secrets.get(t.K.token), undefined, 'not signed back in');
		assert.strictEqual(t.secrets.get(t.K.refresh), undefined);
		assert.strictEqual(t.host.signedIn(), false);
	});

	await test('late 200: tokens for the old session are not filed under a newer sign-in', async () => {
		const t = boot({ access: deadAccess(), refresh: 'r1', profile: { name: 'Ada' } });
		const reply = deferred();
		t.refreshReply = () => reply.promise;
		const renewal = t.host.refreshCloudToken();
		await until(() => t.calls.refresh.length === 1, 'the refresh request');
		const other = liveAccess() + '.bo';
		await t.host.storeSession(other, 'rB', { name: 'Bo' });   // someone else signs in on this machine
		reply.resolve({ status: 200, body: { access: liveAccess() + '.ada', refresh: 'r1b' } });
		assert.strictEqual(await renewal, true, 'a token is in place — the newer session\'s');
		assert.strictEqual(t.secrets.get(t.K.token), other);
		assert.strictEqual(t.secrets.get(t.K.refresh), 'rB');
		assert.deepStrictEqual(t.state.get(t.K.profile), { name: 'Bo', email: '', plan: '' });
	});

	await test('the lock: a sign-in that starts in the MIDDLE of an expiry\'s deletes is not lost', async () => {
		const t = boot({ access: deadAccess(), refresh: 'r1' });
		t.refreshReply = refused;
		const fresh = liveAccess();
		let signIn = null;
		// The expiry has decided this is still the dead session and begun its writes. A sign-in arriving
		// now must wait its turn; interleaved, its tokens would be stored and then deleted.
		t.onOp = (op) => { if (!signIn && op === 'set ' + t.K.expired) { signIn = t.host.storeSession(fresh, 'r2', { name: 'Ada' }); } };
		await t.host.checkCloudSession('focus');
		assert.ok(signIn, 'the sign-in was started mid-expiry');
		await signIn;
		assert.strictEqual(t.secrets.get(t.K.token), fresh, 'ops were: ' + t.ops.join(', '));
		assert.strictEqual(t.secrets.get(t.K.refresh), 'r2');
		assert.strictEqual(t.state.get(t.K.expired), undefined, 'the sign-in answered the expiry');
		assert.strictEqual(t.host.signedIn(), true);
	});

	await test('two refreshes at once, both renewed: one matching pair is stored and both report a token', async () => {
		const t = boot({ access: deadAccess(), refresh: 'r1' });
		const pairs = [{ access: liveAccess() + '.a', refresh: 'r2a' }, { access: liveAccess() + '.b', refresh: 'r2b' }];
		let i = 0;
		t.refreshReply = () => ({ status: 200, body: pairs[i++] });
		assert.deepStrictEqual(await Promise.all([t.host.refreshCloudToken(), t.host.refreshCloudToken()]), [true, true]);
		const stored = { access: t.secrets.get(t.K.token), refresh: t.secrets.get(t.K.refresh) };
		assert.ok(pairs.some((p) => p.access === stored.access && p.refresh === stored.refresh), 'an access token from one reply and a refresh token from the other: ' + JSON.stringify(stored));
	});

	await test('two refreshes at once, both refused: the session ends once — one card, one resync', async () => {
		const t = boot({ access: deadAccess(), refresh: 'r1', profile: { name: 'Ada' } });
		t.refreshReply = refused;
		assert.deepStrictEqual(await Promise.all([t.host.refreshCloudToken(), t.host.refreshCloudToken()]), [false, false]);
		assert.strictEqual(t.posted.filter((m) => m.type === 'sessionExpired').length, 1);
		assert.strictEqual(t.calls.account, 1);
		assert.strictEqual(t.state.get(t.K.expired), true);
	});

	await test('another window signed in while this refresh was out: its session is left alone', async () => {
		const t = boot({ access: deadAccess(), refresh: 'r1' });
		const reply = deferred();
		t.refreshReply = () => reply.promise;
		const check = t.host.checkCloudSession('focus');
		await until(() => t.calls.refresh.length === 1, 'the refresh request');
		const theirs = liveAccess() + '.other-window';
		t.secrets.set(t.K.token, theirs); t.secrets.set(t.K.refresh, 'rW');   // written by another process: no counter here saw it
		reply.resolve(refused);
		await check;
		assert.strictEqual(t.secrets.get(t.K.token), theirs);
		assert.strictEqual(t.secrets.get(t.K.refresh), 'rW');
		assert.strictEqual(t.state.get(t.K.expired), undefined);
		assert.ok(!t.types().includes('sessionExpired'));
	});

	await test('another window ENDED the session while this refresh was out: this window catches up', async () => {
		const t = boot({ access: deadAccess(), refresh: 'r1', profile: { name: 'Ada' } });
		const reply = deferred();
		t.refreshReply = () => reply.promise;
		const check = t.host.checkCloudSession('focus');
		await until(() => t.calls.refresh.length === 1, 'the refresh request');
		t.secrets.delete(t.K.token); t.secrets.delete(t.K.refresh); t.state.set(t.K.expired, true);   // the other window's sessionExpired()
		reply.resolve(refused);
		await check;
		assert.strictEqual(t.host.signedIn(), false, 'stops presenting a live session');
		assert.strictEqual(t.posted.filter((m) => m.type === 'sessionExpired').length, 1, 'shows the card');
		assert.strictEqual(t.calls.account, 1, 'resyncs the popover');
		assert.deepStrictEqual(t.ops, [], 'and writes nothing — there was nothing left to end');
	});

	// ── the refresh has a deadline, body included ────────────────────────────────────────────────
	await test('a host that accepts the request and never answers: the check gives up, credentials kept', async () => {
		const access = deadAccess();
		const t = boot({ access, refresh: 'r1', refreshTimeoutMs: 40 });
		t.refreshReply = 'stall';
		await within(t.host.checkCloudSession('ready'), 2000, 'the session check `ready` waits on');
		assert.strictEqual(t.calls.refresh[0].signal.aborted, true, 'the request was aborted at the deadline');
		assert.strictEqual(t.secrets.get(t.K.token), access);
		assert.strictEqual(t.secrets.get(t.K.refresh), 'r1');
		assert.strictEqual(t.host.signedIn(), true);
		assert.strictEqual(t.state.get(t.K.expired), undefined);
		assert.deepStrictEqual(t.posted, []);
	});

	await test('headers arrive but the body never does: still bounded, still "this attempt failed"', async () => {
		const access = deadAccess();
		const t = boot({ access, refresh: 'r1', refreshTimeoutMs: 40 });
		t.refreshReply = { status: 200, body: 'stall' };
		assert.strictEqual(await within(t.host.refreshCloudToken(), 2000, 'the refresh'), false);
		assert.strictEqual(t.secrets.get(t.K.token), access);
		assert.strictEqual(t.secrets.get(t.K.refresh), 'r1');
		assert.strictEqual(t.state.get(t.K.expired), undefined);
	});

	await test('a 401 whose body never arrives is still the server saying no: the session ends', async () => {
		const t = boot({ access: deadAccess(), refresh: 'r1', refreshTimeoutMs: 40 });
		t.refreshReply = { status: 401, body: 'stall' };
		assert.strictEqual(await within(t.host.refreshCloudToken(), 2000, 'the refresh'), false);
		assert.strictEqual(t.secrets.get(t.K.token), undefined);
		assert.strictEqual(t.state.get(t.K.expired), true);
	});

	await test('a refresh that answers in time is not aborted afterwards — its timer is cleared', async () => {
		const t = boot({ access: deadAccess(), refresh: 'r1', refreshTimeoutMs: 40 });
		t.refreshReply = { status: 200, body: { access: liveAccess(), refresh: 'r2' } };
		assert.strictEqual(await t.host.refreshCloudToken(), true);
		await new Promise((resolve) => setTimeout(resolve, 90));   // well past the deadline
		assert.strictEqual(t.calls.refresh[0].signal.aborted, false);
	});

	await test('the shipped deadline is ten seconds', () => {
		assert.strictEqual(session.REFRESH_TIMEOUT_MS, 10000);
	});

	// ── what rewrites the transcript in place takes the card with it; it is put back ─────────────
	const order = (t, ...of) => t.types().filter((x) => of.includes(x));

	await test('New Chat: the card is replayed into the emptied transcript', async () => {
		const t = boot({ expired: true, profile: { name: 'Ada' } });
		t.host.newChat();
		await until(() => t.types().includes('sessionExpired'), 'the replay after New Chat');
		assert.deepStrictEqual(order(t, 'reset', 'memoryDigest', 'sessionExpired'), ['reset', 'memoryDigest', 'sessionExpired']);
		assert.strictEqual(t.last('sessionExpired').name, 'Ada');
	});

	await test('a session resumed from History: the card goes back UNDER the restored transcript', async () => {
		const t = boot({ expired: true });
		await t.host.resumeSession('s1');
		assert.deepStrictEqual(order(t, 'reset', 'sessionResumed', 'sessionExpired'), ['reset', 'sessionResumed', 'sessionExpired']);
	});

	await test('a checkpoint restore: the card dropped with the later turns is replayed', async () => {
		const t = boot({ expired: true });
		const goal = { role: 'user', content: 'a goal' };
		t.checkpoints.push({ turnId: 7, goalMsg: goal, files: new Map() });
		t.host.setAgentMessages([goal, { role: 'assistant', content: 'done' }]);
		await t.host.restoreCheckpoint(7);
		assert.deepStrictEqual(t.types(), ['checkpointRestored', 'sessionExpired']);
	});

	await test('none of the three says anything when no expiry is waiting', async () => {
		const t = boot({});
		const goal = { role: 'user', content: 'a goal' };
		t.checkpoints.push({ turnId: 7, goalMsg: goal, files: new Map() });
		t.host.setAgentMessages([goal]);
		await t.host.restoreCheckpoint(7);
		await t.host.resumeSession('s1');
		t.host.newChat();
		await settle();
		assert.ok(t.types().includes('reset') && t.types().includes('checkpointRestored'), 'all three ran');
		assert.ok(!t.types().includes('sessionExpired'));
	});

	console.log('\nsessionExpiredHost: ' + n + ' tests passed.');
})().catch((e) => { console.error(e); process.exit(1); });
