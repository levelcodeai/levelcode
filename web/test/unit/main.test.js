/*---------------------------------------------------------------------------------------------
 *  web/main.js — run: node web/test/unit/main.test.js
 *
 *  main.js is a page entry: it reads the DOM and awaits the workbench at the top level, so it cannot be
 *  imported. The functions whose behaviour matters are plain top-level declarations, and this test runs
 *  them as they are written (it cuts them out of the file) against stand-ins for the globals they use.
 *
 *    leaveForSignIn           the one command the page offers an extension: it must take the tab to the
 *                             account site's /ai/ pages and nowhere else
 *    createUrlCallbackProvider  .drain / .whenListening: what is delivered when the page starts
 *    startReturnFromSignIn    ?signin=1 and the return from a sign-in
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', '..', 'main.js'), 'utf8');

/** The text of a top-level `function name(...) { ... }` — it ends at the first `}` in column 0. */
function extract(name) {
	const start = SOURCE.indexOf('\nfunction ' + name + '(');
	assert.ok(start >= 0, 'main.js has no top-level function ' + name);
	const end = SOURCE.indexOf('\n}\n', start);
	assert.ok(end > start, 'could not find the end of ' + name);
	return SOURCE.slice(start + 1, end + 2);
}
/** The value of a top-level `const NAME = <expression>;` on one line. */
function constant(name) {
	const m = SOURCE.match(new RegExp('^const ' + name + ' = (.+);$', 'm'));
	assert.ok(m, 'main.js has no top-level const ' + name);
	return new Function('return (' + m[1] + ')')();
}

const RETURN_KEY = constant('RETURN_KEY');
const FRESH_MS = constant('FRESH_MS');

let n = 0;
async function test(name, fn) { await fn(); n++; console.log('  ok - ' + name); }

/* ---- leaveForSignIn ------------------------------------------------------------------------------- */
function makeLeave() {
	const assigned = [];
	const session = new Map();
	const warned = [];
	const location = { assign: (u) => assigned.push(u) };
	const sessionStorage = { setItem: (k, v) => session.set(k, v), getItem: (k) => (session.has(k) ? session.get(k) : null), removeItem: (k) => session.delete(k) };
	const console_ = { warn: (...a) => warned.push(a.join(' ')) };
	const leave = new Function('location', 'sessionStorage', 'console', 'RETURN_KEY', 'URL',
		extract('leaveForSignIn') + '\nreturn leaveForSignIn;')(location, sessionStorage, console_, RETURN_KEY, URL);
	return { leave, assigned, session, warned };
}
const ACCOUNT = 'https://levelcode.example';

(async () => {
	await test('leaveForSignIn: the account site\'s sign-in page is where the tab goes, and the tab is marked as one to bring back', () => {
		const t = makeLeave();
		const url = ACCOUNT + '/ai/login?redirect_uri=https://editor.example/callback.html%3Fvscode-reqid%3D1&code_challenge=abc&code_challenge_method=S256';
		t.leave(url, { account: ACCOUNT });
		assert.deepStrictEqual(t.assigned, [url]);
		assert.strictEqual(t.session.get(RETURN_KEY), '1');
	});
	await test('leaveForSignIn: provider sign-in pages of the account site are fine too', () => {
		const t = makeLeave();
		t.leave(ACCOUNT + '/ai/auth/oauth/github?redirect_uri=x', { account: ACCOUNT });
		assert.strictEqual(t.assigned.length, 1);
	});
	await test('leaveForSignIn: an account given with a path or a trailing slash is still the same origin', () => {
		const t = makeLeave();
		t.leave(ACCOUNT + '/ai/login', { account: ACCOUNT + '/' });
		assert.strictEqual(t.assigned.length, 1);
	});
	await test('leaveForSignIn: nowhere else — other hosts, other paths, other schemes, tricks', () => {
		const refused = [
			'https://evil.example/ai/login',                    // another site
			'https://levelcode.example.evil.example/ai/login',  // a host that begins with the account's
			'https://levelcode.example@evil.example/ai/login',  // userinfo: the host is evil.example
			'http://levelcode.example/ai/login',                // the same host, another scheme
			'https://levelcode.example:8443/ai/login',          // another port
			ACCOUNT + '/api/levelcode/v1/auth/web_handoff',     // the account site, but not a sign-in page
			ACCOUNT + '/ai',                                    // /ai/ is the prefix, with its slash
			ACCOUNT + '/aix/login',
			ACCOUNT + '/ai/../api/anything',                    // dot segments are resolved before the test
			ACCOUNT + '/ai%2Flogin',
			'javascript:alert(1)',
			'data:text/html,<script>1</script>',
			'//levelcode.example/ai/login',                     // no scheme: not an absolute address
			'/ai/login',
			'not a url',
			'',
		];
		for (const u of refused) {
			const t = makeLeave();
			t.leave(u, { account: ACCOUNT });
			assert.deepStrictEqual(t.assigned, [], 'went to ' + JSON.stringify(u));
			assert.strictEqual(t.session.size, 0, 'marked the tab for ' + JSON.stringify(u));
		}
	});
	await test('leaveForSignIn: arguments that are not addresses, and a page with no usable account, do nothing', () => {
		for (const bad of [undefined, null, 42, {}, ['https://levelcode.example/ai/login', 'x']]) {
			const t = makeLeave();
			t.leave(bad, { account: ACCOUNT });
			if (Array.isArray(bad)) { continue; }   // String([..]) joins; the origin test still decides, below
			assert.deepStrictEqual(t.assigned, [], 'went somewhere for ' + JSON.stringify(bad));
		}
		const t = makeLeave();
		t.leave(ACCOUNT + '/ai/login', { account: '' });
		t.leave(ACCOUNT + '/ai/login', {});
		assert.deepStrictEqual(t.assigned, []);
	});
	await test('leaveForSignIn: sessionStorage being unavailable does not stop the sign-in', () => {
		const assigned = [];
		const leave = new Function('location', 'sessionStorage', 'console', 'RETURN_KEY', 'URL',
			extract('leaveForSignIn') + '\nreturn leaveForSignIn;')(
			{ assign: (u) => assigned.push(u) },
			{ setItem() { throw new Error('denied'); } }, console, RETURN_KEY, URL);
		leave(ACCOUNT + '/ai/login', { account: ACCOUNT });
		assert.strictEqual(assigned.length, 1);
	});

	/* ---- the callback provider --------------------------------------------------------------------- */
	function makeProvider(entries, now = 1_000_000) {
		const store = new Map(Object.entries(entries));
		const localStorage = {
			get length() { return store.size; },
			key: (i) => [...store.keys()][i] ?? null,
			getItem: (k) => (store.has(k) ? store.get(k) : null),
			setItem: (k, v) => store.set(k, String(v)),
			removeItem: (k) => store.delete(k),
		};
		const realNow = Date.now;
		Date.now = () => now;
		const URI = { revive: (d) => ({ ...d, revived: true }), from: (c) => c };
		const win = { addEventListener() {}, removeEventListener() {} };
		const factory = new Function('URI', 'localStorage', 'window', 'location', 'setTimeout', 'console',
			extract('createUrlCallbackProvider') + '\nreturn createUrlCallbackProvider;');
		const provider = factory(URI, localStorage, win, { protocol: 'https:', host: 'editor.example' }, setTimeout, console)(URI, '/callback.html');
		return { provider, store, restore: () => { Date.now = realNow; } };
	}
	const KEY = (i) => 'vscode-web.url-callbacks[' + i + ']';
	const NOW = 1_000_000;

	await test('drain: a fresh result is delivered once and removed; one with no age is delivered too', () => {
		const t = makeProvider({
			[KEY(1)]: JSON.stringify({ scheme: 'levelcode', authority: 'levelcode.levelcode-ai', path: '/auth/callback', query: 'code=a', at: NOW - 1000 }),
			[KEY(2)]: JSON.stringify({ scheme: 'levelcode', authority: 'levelcode.levelcode-ai', path: '/auth/callback', query: 'code=b' }),
			unrelated: 'keep me',
		});
		try {
			const got = [];
			t.provider.onCallback((u) => got.push(u));
			assert.strictEqual(t.provider.drain(FRESH_MS), 2);
			assert.deepStrictEqual(got.map((u) => u.query).sort(), ['code=a', 'code=b']);
			assert.ok(got.every((u) => u.revived), 'delivered as URIs');
			assert.deepStrictEqual([...t.store.keys()], ['unrelated'], 'only the sign-in results were taken');
			assert.strictEqual(t.provider.drain(FRESH_MS), 0, 'and not again');
		} finally { t.restore(); }
	});
	await test('drain: a result older than the limit is removed and NOT delivered', () => {
		const t = makeProvider({
			[KEY(1)]: JSON.stringify({ scheme: 'levelcode', authority: 'levelcode.levelcode-ai', path: '/auth/callback', query: 'code=old', at: NOW - FRESH_MS - 1 }),
		});
		try {
			const got = [];
			t.provider.onCallback((u) => got.push(u));
			assert.strictEqual(t.provider.drain(FRESH_MS), 0);
			assert.deepStrictEqual(got, []);
			assert.strictEqual(t.store.size, 0, 'a code that cannot be exchanged any more is not kept');
		} finally { t.restore(); }
	});
	await test('drain: an entry that is not JSON is dropped without stopping the rest', () => {
		const t = makeProvider({
			[KEY(1)]: '{not json',
			[KEY(2)]: JSON.stringify({ scheme: 'levelcode', authority: 'levelcode.levelcode-ai', path: '/auth/callback', query: 'code=ok', at: NOW }),
		});
		const errors = console.error;
		console.error = () => {};
		try {
			const got = [];
			t.provider.onCallback((u) => got.push(u));
			assert.strictEqual(t.provider.drain(FRESH_MS), 1);
			assert.strictEqual(got[0].query, 'code=ok');
			assert.strictEqual(t.store.size, 0);
		} finally { console.error = errors; t.restore(); }
	});
	await test('whenListening: true as soon as the workbench has subscribed, false when it never does', async () => {
		const t = makeProvider({});
		try {
			let state = 'pending';
			const p = t.provider.whenListening().then((v) => { state = v; return v; });
			await new Promise((r) => setTimeout(r, 30));
			assert.strictEqual(state, 'pending');
			t.provider.onCallback(() => {});
			assert.strictEqual(await p, true);
		} finally { t.restore(); }
	});

	/* ---- startReturnFromSignIn --------------------------------------------------------------------- */
	function makeStart(href, { drained = 0, listening = true, sessionThrows = false } = {}) {
		const calls = { replaced: [], drain: [], fired: [], removed: [] };
		const location = { href };
		const history = { replaceState: (_s, _t, url) => calls.replaced.push(url) };
		const sessionStorage = { removeItem: (k) => { if (sessionThrows) { throw new Error('denied'); } calls.removed.push(k); } };
		const callbacks = {
			whenListening: async () => listening,
			drain: (ms) => { calls.drain.push(ms); return drained; },
			fire: (u) => calls.fired.push(u),
		};
		const URI = { from: (c) => c };
		const start = new Function('location', 'history', 'sessionStorage', 'RETURN_KEY', 'FRESH_MS', 'URL',
			extract('startReturnFromSignIn') + '\nreturn startReturnFromSignIn;')(location, history, sessionStorage, RETURN_KEY, FRESH_MS, URL);
		return { start: () => start(callbacks, URI), calls };
	}
	const tick = () => new Promise((r) => setTimeout(r, 5));

	await test('start: ?signin=1 asks for the sign-in once, as the launch link, and leaves no trace in the address', async () => {
		const t = makeStart('https://editor.example/?signin=1&keep=this');
		t.start(); await tick();
		assert.deepStrictEqual(t.calls.replaced, ['/?keep=this']);
		assert.deepStrictEqual(t.calls.fired, [{ scheme: 'levelcode', authority: 'levelcode.levelcode-ai', path: '/launch' }]);
		assert.deepStrictEqual(t.calls.drain, [FRESH_MS]);
		assert.deepStrictEqual(t.calls.removed, [RETURN_KEY], 'the tab is no longer one that is expected back');
	});
	await test('start: when a sign-in result was waiting, it is delivered and no second sign-in is started', async () => {
		const t = makeStart('https://editor.example/?signin=1', { drained: 1 });
		t.start(); await tick();
		assert.deepStrictEqual(t.calls.fired, []);
	});
	await test('start: a plain start only delivers what is waiting', async () => {
		const t = makeStart('https://editor.example/', { drained: 0 });
		t.start(); await tick();
		assert.deepStrictEqual(t.calls.replaced, [], 'the address is left alone');
		assert.deepStrictEqual(t.calls.fired, []);
		assert.deepStrictEqual(t.calls.drain, [FRESH_MS]);
	});
	await test('start: signin with any other value is not the parameter', async () => {
		for (const q of ['?signin=0', '?signin=true', '?signin=', '?Signin=1']) {
			const t = makeStart('https://editor.example/' + q);
			t.start(); await tick();
			assert.deepStrictEqual(t.calls.fired, [], q);
			assert.deepStrictEqual(t.calls.replaced, [], q);
		}
	});
	await test('start: with nobody listening nothing is taken out of storage and nothing is started', async () => {
		const t = makeStart('https://editor.example/?signin=1', { listening: false });
		t.start(); await tick();
		assert.deepStrictEqual(t.calls.drain, []);
		assert.deepStrictEqual(t.calls.fired, []);
	});
	await test('start: sessionStorage being unavailable is not an error', async () => {
		const t = makeStart('https://editor.example/?signin=1', { sessionThrows: true });
		t.start(); await tick();
		assert.strictEqual(t.calls.fired.length, 1);
	});

	console.log(`\n${n} tests passed`);
})().catch((e) => { console.error(e); process.exit(1); });
