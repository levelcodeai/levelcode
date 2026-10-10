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
 *    createSecretStorage      the session store, shared by every tab of the origin
 *    startReturnFromSignIn    ?signin=1 and the return from a sign-in
 *    pickInitialTheme         the colours painted before the theme has loaded follow the system
 *    addChromeStyles          chrome.css comes AFTER the workbench's own stylesheet, from the build's prefix
 *    hideBuiltInChat          the workbench's own chat is told it is disabled; a workbench without it is fine
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', '..', 'main.js'), 'utf8');

/**
 * The text of a top-level `function name(...) { ... }` (or `async function`): a one-line function is its
 * line, any other ends at the first `}` in column 0.
 */
function extract(name) {
	let start = SOURCE.indexOf('\nfunction ' + name + '(');
	if (start < 0) { start = SOURCE.indexOf('\nasync function ' + name + '('); }
	assert.ok(start >= 0, 'main.js has no top-level function ' + name);
	const eol = SOURCE.indexOf('\n', start + 1);
	const line = SOURCE.slice(start + 1, eol);
	const opens = (line.match(/\{/g) || []).length;
	const closes = (line.match(/\}/g) || []).length;
	if (opens > 0 && opens === closes && line.endsWith('}')) { return line + '\n'; }
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

	/* ---- the secret store --------------------------------------------------------------------------- */
	const nodeCrypto = require('crypto');
	const STORE_KEY = 'levelcode-web.secrets.v1';
	const SECRET_SOURCE = ['b64', 'unb64', 'seal', 'unseal', 'createSecretStorage'].map(extract).join('\n');
	const memoryStorage = () => {
		const m = new Map();
		return {
			m,
			getItem: (k) => (m.has(k) ? m.get(k) : null),
			setItem: (k, v) => { m.set(k, String(v)); },
			removeItem: (k) => { m.delete(k); },
		};
	};
	/** A mutex shared by every "tab" that is handed the same one, as Web Locks is. */
	const sharedLocks = () => {
		let tail = Promise.resolve();
		const held = { max: 0, now: 0 };
		return {
			held,
			request: (_name, fn) => {
				const run = async () => { held.now++; held.max = Math.max(held.max, held.now); try { return await fn(); } finally { held.now--; } };
				const p = tail.then(run, run);
				tail = p.then(() => undefined, () => undefined);
				return p;
			},
		};
	};
	/** One tab of the editor: its own storage object over the shared localStorage, the shared origin key. */
	const tab = async ({ storage, key, locks, failKey = false, noKey = false }) => {
		const logs = { error: [], warn: [] };
		const factory = new Function('localStorage', 'navigator', 'console', 'loadOrCreateKey', 'crypto', 'TextEncoder', 'TextDecoder', 'btoa', 'atob', 'Uint8Array',
			SECRET_SOURCE + '\nreturn createSecretStorage;');
		const create = factory(storage, locks ? { locks } : {}, { warn: (...a) => logs.warn.push(a), error: (...a) => logs.error.push(a) },
			async () => { if (noKey) { throw new Error('no indexedDB'); } return key; }, nodeCrypto.webcrypto, TextEncoder, TextDecoder, btoa, atob, Uint8Array);
		return { store: await create(), logs };
	};
	const newKey = () => nodeCrypto.webcrypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);

	await test('secrets: set, get, keys and delete, and they are there after a reload', async () => {
		const storage = memoryStorage();
		const key = await newKey();
		const a = await tab({ storage, key });
		assert.strictEqual(a.store.type, 'persisted');
		await a.store.set('access', 'token-AAA');
		await a.store.set('refresh', 'token-RRR');
		assert.strictEqual(await a.store.get('access'), 'token-AAA');
		assert.deepStrictEqual((await a.store.keys()).sort(), ['access', 'refresh']);
		await a.store.delete('access');
		assert.strictEqual(await a.store.get('access'), undefined);
		const reloaded = await tab({ storage, key });
		assert.strictEqual(await reloaded.store.get('refresh'), 'token-RRR');
		assert.deepStrictEqual(await reloaded.store.keys(), ['refresh']);
	});
	await test('secrets: what is stored is sealed — neither the value nor its base64 is in it', async () => {
		const storage = memoryStorage();
		const a = await tab({ storage, key: await newKey() });
		await a.store.set('refresh', 'a-very-recognisable-secret-value');
		const blob = storage.getItem(STORE_KEY);
		assert.ok(blob && blob.length > 20);
		assert.ok(!blob.includes('recognisable') && !blob.includes(Buffer.from('a-very-recognisable-secret-value').toString('base64')));
	});
	await test('secrets: another tab\'s change is seen at once — the rotated refresh token is the one a second tab uses', async () => {
		const storage = memoryStorage();
		const key = await newKey();
		const locks = sharedLocks();
		const first = await tab({ storage, key, locks });
		await first.store.set('refresh', 'R1');
		await first.store.set('access', 'A1');
		const second = await tab({ storage, key, locks });                 // started while R1 was current
		assert.strictEqual(await second.store.get('refresh'), 'R1');
		await first.store.set('refresh', 'R2');                            // the first tab renews the session
		await first.store.set('access', 'A2');
		assert.strictEqual(await second.store.get('refresh'), 'R2', 'a second tab must not present the refresh token that was rotated away');
		assert.strictEqual(await second.store.get('access'), 'A2');
	});
	await test('secrets: a change is one key — a tab does not write back what it saw at start-up', async () => {
		const storage = memoryStorage();
		const key = await newKey();
		const locks = sharedLocks();
		const first = await tab({ storage, key, locks });
		await first.store.set('access', 'A1');
		const second = await tab({ storage, key, locks });
		await first.store.set('refresh', 'R2');                            // after the second tab started
		await second.store.set('verifier', 'V');                           // an unrelated change in the second tab
		assert.strictEqual(await first.store.get('refresh'), 'R2', 'the second tab\'s write did not undo the first\'s');
		assert.strictEqual(await first.store.get('verifier'), 'V');
		await second.store.delete('access');                               // the second tab signs out of the access token
		assert.strictEqual(await first.store.get('refresh'), 'R2');
		assert.strictEqual(await first.store.get('access'), undefined);
	});
	await test('secrets: changes made at the same moment in two tabs all land, one at a time', async () => {
		const storage = memoryStorage();
		const key = await newKey();
		const locks = sharedLocks();
		const a = await tab({ storage, key, locks });
		const b = await tab({ storage, key, locks });
		const work = [];
		for (let i = 0; i < 12; i++) {
			work.push(a.store.set('a' + i, 'x' + i));
			work.push(b.store.set('b' + i, 'y' + i));
		}
		await Promise.all(work);
		const keys = await a.store.keys();
		assert.strictEqual(keys.length, 24, 'lost: ' + [...Array(12).keys()].flatMap((i) => ['a' + i, 'b' + i]).filter((k) => !keys.includes(k)).join(','));
		assert.strictEqual(locks.held.max, 1, 'never two changes inside the lock at once');
	});
	await test('secrets: with no Web Locks a tab still applies its own changes one at a time', async () => {
		const storage = memoryStorage();
		const a = await tab({ storage, key: await newKey() });
		await Promise.all([...Array(10).keys()].map((i) => a.store.set('k' + i, 'v' + i)));
		assert.strictEqual((await a.store.keys()).length, 10);
	});
	await test('secrets: a store that cannot be read is dropped, with a warning, and the tab carries on', async () => {
		const storage = memoryStorage();
		storage.setItem(STORE_KEY, 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
		const a = await tab({ storage, key: await newKey() });
		assert.strictEqual(await a.store.get('refresh'), undefined);
		assert.strictEqual(storage.getItem(STORE_KEY), null);
		assert.strictEqual(a.logs.warn.length >= 1, true);
		await a.store.set('refresh', 'R');
		assert.strictEqual(await a.store.get('refresh'), 'R');
	});
	await test('secrets: a key from another browser profile cannot read it — that is a sign-in again, not an error', async () => {
		const storage = memoryStorage();
		const mine = await tab({ storage, key: await newKey() });
		await mine.store.set('refresh', 'R');
		const other = await tab({ storage, key: await newKey() });
		assert.strictEqual(await other.store.get('refresh'), undefined);
	});
	await test('secrets: where there is no key the store is in memory, writes nothing, and works for the session', async () => {
		const storage = memoryStorage();
		const a = await tab({ storage, key: null, noKey: true });
		assert.strictEqual(a.store.type, 'in-memory');
		await a.store.set('access', 'A');
		assert.strictEqual(await a.store.get('access'), 'A');
		assert.deepStrictEqual(await a.store.keys(), ['access']);
		await a.store.delete('access');
		assert.strictEqual(await a.store.get('access'), undefined);
		assert.strictEqual(storage.m.size, 0, 'nothing was written to localStorage');
	});
	await test('secrets: when the browser refuses the write the session is kept for this tab, not lost', async () => {
		const storage = memoryStorage();
		const key = await newKey();
		const a = await tab({ storage, key });
		await a.store.set('refresh', 'R1');
		const realSet = storage.setItem;
		storage.setItem = () => { throw new Error('QuotaExceededError'); };
		await a.store.set('access', 'A1');                                 // refused: kept in memory, with R1 carried over
		storage.setItem = realSet;
		assert.strictEqual(await a.store.get('access'), 'A1');
		assert.strictEqual(await a.store.get('refresh'), 'R1');
		await a.store.set('refresh', 'R2');
		assert.strictEqual(await a.store.get('refresh'), 'R2');
		assert.ok(a.logs.error.length >= 1, 'said so');
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


	/* ---- the look ---- */
	const THEMES = { dark: { themeType: 'dark', colors: { 'editor.background': '#111111' } }, light: { themeType: 'light', colors: { 'editor.background': '#ffffff' } } };
	const makePick = (matchMedia) => new Function('window', extract('pickInitialTheme') + '\nreturn pickInitialTheme;')({ matchMedia });
	await test('look: the colours before the theme loads are the light set when the system is light, the dark one otherwise', () => {
		const asked = [];
		const pick = makePick((q) => { asked.push(q); return { matches: /light/.test(q) }; });
		assert.strictEqual(pick({ initialColorTheme: THEMES }), THEMES.light);
		assert.deepStrictEqual(asked, ['(prefers-color-scheme: light)']);
		assert.strictEqual(makePick(() => ({ matches: false }))({ initialColorTheme: THEMES }), THEMES.dark);
	});
	await test('look: no matchMedia, or one that throws, is dark and not an error', () => {
		assert.strictEqual(makePick(undefined)({ initialColorTheme: THEMES }), THEMES.dark);
		assert.strictEqual(makePick(() => { throw new Error('no'); })({ initialColorTheme: THEMES }), THEMES.dark);
	});
	await test('look: a page configured without colours gives the workbench none (it keeps its own default)', () => {
		assert.strictEqual(makePick(() => ({ matches: true }))({}), undefined);
	});
	await test('look: chrome.css is linked from the build\'s prefix, at the end of the head', () => {
		const added = [];
		const head = { appendChild: (e) => added.push(e) };
		const document = { head, createElement: (t) => ({ tagName: t }) };
		const trimSlash = (x) => x.replace(/\/+$/, '');
		const add = new Function('document', 'trimSlash', extract('addChromeStyles') + '\nreturn addChromeStyles;')(document, trimSlash);
		add({ base: '/_/abc123/' });
		assert.strictEqual(added.length, 1);
		assert.deepStrictEqual({ tag: added[0].tagName, rel: added[0].rel, href: added[0].href }, { tag: 'link', rel: 'stylesheet', href: '/_/abc123/chrome.css' });
		add({});
		assert.strictEqual(added[1].href, '/chrome.css', 'a development page has no prefix');
	});
	await test('look: the built-in chat is told it is disabled, through the one context key, and a failure there is not an error', async () => {
		const sent = [];
		const hide = new Function(extract('hideBuiltInChat') + '\nreturn hideBuiltInChat;')();
		hide({ commands: { executeCommand: async (...a) => { sent.push(a); } } });
		await new Promise((r) => setTimeout(r, 0));
		assert.deepStrictEqual(sent, [['_setContext', 'chatSetupDisabledInWorkspace', true]]);
		assert.doesNotThrow(() => hide({ commands: { executeCommand: async () => { throw new Error('unknown command'); } } }));
		assert.doesNotThrow(() => hide({ commands: { executeCommand: () => { throw new Error('sync'); } } }));
		assert.doesNotThrow(() => hide({}));
		await new Promise((r) => setTimeout(r, 0));   // the rejected promise was handled, or this run would die here
	});

	console.log(`\n${n} tests passed`);
})().catch((e) => { console.error(e); process.exit(1); });
