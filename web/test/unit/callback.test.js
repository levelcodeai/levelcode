/*---------------------------------------------------------------------------------------------
 *  web/callback.js — run: node web/test/unit/callback.test.js
 *
 *  The page a sign-in comes back to. It is a page of the editor's own site, so anyone can link to it, and what it
 *  leaves in localStorage the editor delivers when it next starts. These tests run the file as it is written,
 *  against a stand-in for the page (location, history, storage, the two text nodes), and look at what it leaves.
 *
 *    - it passes on a LevelCode sign-in, and only its one-time code: not a token in the link (the old flow),
 *      not a result for another destination, not the rest of the query
 *    - a tab that left the editor for the sign-in goes back to the address it left — the same folder or workspace
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', '..', 'callback.js'), 'utf8');
const ORIGIN = 'https://editor.example';
const RETURN_KEY = 'levelcode-web.return';

let n = 0;
async function test(name, fn) { await fn(); n++; console.log('  ok - ' + name); }

const storage = () => {
	const m = new Map();
	return { m, getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); } };
};

/** Load callback.html at `query` and run callback.js. */
function visit(query, { returnTo = null } = {}) {
	const local = storage();
	const session = storage();
	if (returnTo !== null) { session.setItem(RETURN_KEY, returnTo); }
	const href = ORIGIN + '/callback.html' + query;
	const out = { replaced: /** @type {string[]} */ ([]), history: /** @type {string[]} */ ([]), closed: false };
	const text = { title: '', text: '' };
	const more = { hidden: true, querySelector: () => ({ href: '' }) };
	const location = { href, origin: ORIGIN, pathname: '/callback.html', replace: (u) => out.replaced.push(u) };
	const document = { getElementById: (id) => (id === 'title' ? { set textContent(v) { text.title = v; } } : id === 'text' ? { set textContent(v) { text.text = v; } } : id === 'more' ? more : null) };
	vm.runInNewContext(SOURCE, {
		location, document, localStorage: local, sessionStorage: session, URL, URLSearchParams, decodeURIComponent, encodeURIComponent, JSON, Date, String,
		history: { replaceState: (_s, _t, u) => out.history.push(u) },
		setTimeout: (fn) => fn(),
		window: { close: () => { out.closed = true; } },
	});
	const results = [...local.m.entries()].filter(([k]) => k.startsWith('vscode-web.url-callbacks[')).map(([k, v]) => [k, JSON.parse(v)]);
	return { results, text, out, more, session };
}
const SIGN_IN = '?vscode-reqid=3&vscode-scheme=levelcode&vscode-authority=levelcode.levelcode-ai&vscode-path=%2Fauth%2Fcallback';

(async () => {
	await test('a sign-in coming back with its code is handed to the editor: the code, and nothing else', async () => {
		const r = visit(SIGN_IN + '&code=abc123&state=x&token=ignored');
		assert.strictEqual(r.results.length, 1);
		const [k, v] = r.results[0];
		assert.strictEqual(k, 'vscode-web.url-callbacks[3]');
		assert.deepStrictEqual({ scheme: v.scheme, authority: v.authority, path: v.path, query: v.query }, { scheme: 'levelcode', authority: 'levelcode.levelcode-ai', path: '/auth/callback', query: 'code=abc123' });
		assert.strictEqual(typeof v.at, 'number');
		assert.strictEqual(r.text.title, 'You are signed in');
		assert.deepStrictEqual(r.out.history, ['/callback.html'], 'the code is taken out of the address bar');
	});
	await test('a code that came back inside vscode-query counts too', async () => {
		const r = visit(SIGN_IN + '&vscode-query=' + encodeURIComponent('code=from-query'));
		assert.strictEqual(r.results[0][1].query, 'code=from-query');
	});
	await test('a link with a session token in it — the old flow, or someone else\'s session — is not passed on', async () => {
		for (const q of ['&token=attacker-access&refresh=attacker-refresh&name=Eve&email=eve%40example.test',
			'&vscode-query=' + encodeURIComponent('token=attacker-access&refresh=r'),
			'']) {
			const r = visit(SIGN_IN + q);
			assert.deepStrictEqual(r.results, [], 'delivered for ' + JSON.stringify(q));
			assert.strictEqual(r.text.title, 'This link does not look right');
		}
	});
	await test('a result for any other destination is not passed on, whatever it carries', async () => {
		const others = [
			'?vscode-reqid=3&vscode-scheme=levelcode&vscode-authority=other.extension&vscode-path=%2Fauth%2Fcallback&code=c',
			'?vscode-reqid=3&vscode-scheme=levelcode&vscode-authority=levelcode.levelcode-ai&vscode-path=%2Flaunch&code=c',
			'?vscode-reqid=3&vscode-scheme=levelcode&vscode-authority=levelcode.levelcode-ai&code=c',
			'?vscode-reqid=x&vscode-scheme=levelcode&vscode-authority=levelcode.levelcode-ai&vscode-path=%2Fauth%2Fcallback&code=c',
			'?vscode-scheme=levelcode&vscode-authority=levelcode.levelcode-ai&vscode-path=%2Fauth%2Fcallback&code=c',
			'?code=c',
		];
		for (const q of others) { assert.deepStrictEqual(visit(q).results, [], 'delivered for ' + q); }
	});
	await test('a code that is not a code (blank, huge, with spaces) is not passed on', async () => {
		for (const c of ['', '%20', 'a%20b', 'x'.repeat(3000)]) { assert.deepStrictEqual(visit(SIGN_IN + '&code=' + c).results, [], 'code=' + c.slice(0, 20)); }
	});
	await test('a sign-in the user turned down says so, and leaves nothing behind', async () => {
		const r = visit(SIGN_IN + '&error=access_denied', { returnTo: '/' });
		assert.deepStrictEqual(r.results, []);
		assert.strictEqual(r.text.title, 'The sign-in did not finish');
	});
	await test('a tab that left the editor for the sign-in goes back to the address it left — the same folder, not the scratch workspace', async () => {
		const folder = '/?folder=file%3A%2F%2F%2Fmy-project&payload=%5B%5D';
		const r = visit(SIGN_IN + '&code=c1', { returnTo: folder });
		assert.deepStrictEqual(r.out.replaced, [ORIGIN + folder]);
		const w = visit(SIGN_IN + '&code=c2', { returnTo: '/index.html?workspace=file%3A%2F%2F%2Fa.code-workspace&signin=1#frag' });
		assert.deepStrictEqual(w.out.replaced, [ORIGIN + '/index.html?workspace=file%3A%2F%2F%2Fa.code-workspace#frag'], 'only the sign-in request is dropped');
		const old = visit(SIGN_IN + '&code=c3', { returnTo: '1' });   // what an editor before this change left
		assert.deepStrictEqual(old.out.replaced, [ORIGIN + '/']);
	});
	await test('the address it goes back to is the editor page of this site, and nothing else', async () => {
		for (const bad of ['https://evil.example/?folder=x', '//evil.example/', '/callback.html?x=1', '/somewhere/else', 'javascript:alert(1)']) {
			const r = visit(SIGN_IN + '&code=c', { returnTo: bad });
			assert.deepStrictEqual(r.out.replaced, [ORIGIN + '/'], 'went to ' + bad);
		}
	});
	await test('a tab that did not leave the editor (the pop-up path) closes and points back home', async () => {
		const r = visit(SIGN_IN + '&code=c');
		assert.deepStrictEqual(r.out.replaced, []);
		assert.strictEqual(r.out.closed, true);
		assert.strictEqual(r.more.hidden, false);
	});

	console.log(`\n${n} tests passed`);
})().catch((e) => { console.error(e); process.exit(1); });
