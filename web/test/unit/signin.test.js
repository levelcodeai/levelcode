/*---------------------------------------------------------------------------------------------
 *  The extension's sign-in callback (handleAuthCallback in extensions/levelcode-ai/extension.js) — run:
 *  node web/test/unit/signin.test.js
 *
 *  In a browser the callback is a page of the editor's own site that anyone can link to (web/callback.js), and
 *  the page delivers what it was given when the editor next starts. So there the extension takes only a code that
 *  answers a sign-in this editor started: a token in the link (the old flow) or a code nobody asked for must not
 *  sign the user in to someone else's account. The desktop does what it always did.
 *
 *  The function is sliced out of the shipped extension.js and run against stand-ins for what it touches — the
 *  secret store, the token exchange, the session store — the way extensions/levelcode-ai/test/sessionExpiredHost
 *  .test.js does it.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'extensions', 'levelcode-ai', 'extension.js'), 'utf8');

/** A top-level `[async] function name(...) {…}`, braces matched outside strings and comments. */
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
		if (str) { if (ch === '\\') { i++; } else if (ch === str) { str = ''; } continue; }
		if (ch === '/' && next === '/') { comment = 'line'; i++; continue; }
		if (ch === '/' && next === '*') { comment = 'block'; i++; continue; }
		if (ch === '"' || ch === "'" || ch === '`') { str = ch; continue; }
		if (ch === '{') { depth++; }
		else if (ch === '}' && --depth === 0) { return src.slice(start, i + 1); }
	}
	assert.fail('no matching closing brace for ' + name + '()');
}
const decl = (name) => { const m = new RegExp('^const ' + name + ' = [^;\\n]*;', 'm').exec(src); assert.ok(m, 'no ' + name); return m[0]; };

let n = 0;
async function test(name, fn) { await fn(); n++; console.log('  ok - ' + name); }

/** The handler, with a stand-in for everything around it. `browser` decides the one capability it asks about. */
function makeHandler({ browser, pendingVerifier = null }) {
	const secrets = new Map();
	const VERIFIER = /'(levelcode\.cloud\.verifier)'/.exec(decl('ACCOUNT_VERIFIER_KEY'))[1];
	if (pendingVerifier) { secrets.set(VERIFIER, pendingVerifier); }
	const seen = { exchanged: /** @type {any[]} */ ([]), stored: /** @type {any[]} */ ([]), dbg: /** @type {any[]} */ ([]) };
	const env = {
		host: { caps: { unaskedSignIn: !browser } },
		ctx: { secrets: { get: async (k) => secrets.get(k), delete: async (k) => { secrets.delete(k); } } },
		fetch: async (url, init) => { seen.exchanged.push({ url, body: JSON.parse(init.body) }); return { ok: true, json: async () => ({ access: 'A-' + JSON.parse(init.body).code, refresh: 'R', profile: { email: 'me@example.test' } }) }; },
		storeSession: async (access, refresh, profile) => { seen.stored.push({ access, refresh, profile }); },
		cloudApiUrl: () => 'https://levelcode.example',
		dbg: (...a) => seen.dbg.push(a),
		postAccount: async () => {},
		vscode: { window: { showInformationMessage: () => {} } },
	};
	// eslint-disable-next-line no-new-func
	const handle = new Function('env', "'use strict'; const { host, ctx, fetch, storeSession, cloudApiUrl, dbg, postAccount, vscode } = env;\n"
		+ decl('ACCOUNT_VERIFIER_KEY') + '\n' + extract('handleAuthCallback') + '\nreturn handleAuthCallback;')(env);
	return { handle, seen, secrets, VERIFIER };
}
const link = (query) => ({ scheme: 'levelcode', authority: 'levelcode.levelcode-ai', path: '/auth/callback', query });

(async () => {
	await test('browser: a code answering the sign-in this editor started is exchanged with its verifier, once', async () => {
		const t = makeHandler({ browser: true, pendingVerifier: 'V-mine' });
		await t.handle(link('code=c1'));
		assert.deepStrictEqual(t.seen.exchanged.map((e) => e.body), [{ code: 'c1', verifier: 'V-mine' }]);
		assert.strictEqual(t.seen.stored[0].access, 'A-c1');
		assert.strictEqual(t.secrets.has(t.VERIFIER), false, 'the verifier is single-use');
		await t.handle(link('code=c1'));
		assert.strictEqual(t.seen.exchanged.length, 1, 'the same link again finds no sign-in pending, and does nothing');
	});
	await test('browser: a link with a session token in it does not sign anyone in — with or without a sign-in pending', async () => {
		for (const pending of [null, 'V-mine']) {
			const t = makeHandler({ browser: true, pendingVerifier: pending });
			await t.handle(link('token=attacker-access&refresh=attacker-refresh&email=eve%40example.test'));
			assert.deepStrictEqual(t.seen.stored, [], 'stored a session from a link (pending: ' + pending + ')');
			assert.deepStrictEqual(t.seen.exchanged, []);
		}
	});
	await test('browser: a code nobody asked for is not exchanged at all', async () => {
		const t = makeHandler({ browser: true, pendingVerifier: null });
		await t.handle(link('code=attacker-code'));
		assert.deepStrictEqual(t.seen.exchanged, [], 'a code delivered with no sign-in pending reached the server');
		assert.deepStrictEqual(t.seen.stored, []);
		assert.ok(t.seen.dbg.some((d) => d[0] === 'account.callback' && d[1] && d[1].ignored), 'and it says why, in the debug log');
	});
	await test('desktop: unchanged — the code flow, and the old token-in-the-link flow the desktop still accepts', async () => {
		const a = makeHandler({ browser: false, pendingVerifier: 'V' });
		await a.handle(link('code=c'));
		assert.deepStrictEqual(a.seen.exchanged.map((e) => e.body), [{ code: 'c', verifier: 'V' }]);
		const b = makeHandler({ browser: false, pendingVerifier: null });
		await b.handle(link('code=c'));
		assert.deepStrictEqual(b.seen.exchanged.map((e) => e.body), [{ code: 'c', verifier: '' }], 'as before: the server decides');
		const c = makeHandler({ browser: false });
		await c.handle(link('token=T&refresh=R&name=N&email=e%40x&plan=pro'));
		assert.deepStrictEqual(c.seen.stored, [{ access: 'T', refresh: 'R', profile: { name: 'N', email: 'e@x', plan: 'pro' } }]);
	});

	console.log(`\n${n} tests passed`);
})().catch((e) => { console.error(e); process.exit(1); });
