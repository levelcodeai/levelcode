/*---------------------------------------------------------------------------------------------
 *  LevelCode Shell terminal: command history - run: node web/test/unit/shell-terminal-history.test.js
 *
 *  What a person expects of a shell's history, and the two rules that keep a pasted secret out of browser storage:
 *  a line that looks like it carries one is remembered for the session and never written down.
 *
 *  Every secret-shaped string here is assembled at run time from fragments: this repository is public and a secret
 *  scanner reads a token-shaped literal in a test as a leak.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

const assert = require('assert');
const path = require('path');

const { createHistory, looksSecret, KEY } = require(path.join(__dirname, '..', '..', 'shell', 'src', 'terminal', 'history.js'));

const queue = [];
const test = (name, fn) => queue.push([name, fn]);

/** A globalState stand-in that records what was written. */
function fakeStore(initial) {
	const data = new Map(initial === undefined ? [] : [[KEY, initial]]);
	const writes = [];
	return {
		data, writes,
		get: (k, d) => (data.has(k) ? data.get(k) : d),
		update: (k, v) => { data.set(k, v); writes.push(JSON.parse(JSON.stringify(v))); return Promise.resolve(); },
	};
}
const cat = (...parts) => parts.join('');

test('lines are remembered oldest first; blank lines, lines that start with a space and repeats are not', () => {
	const h = createHistory({ store: fakeStore() });
	assert.strictEqual(h.add('ls'), true);
	assert.strictEqual(h.add('ls'), false, 'the same as the one before');
	assert.strictEqual(h.add('cd src'), true);
	assert.strictEqual(h.add('ls'), true, 'the same as one before the last is fine');
	assert.strictEqual(h.add('   '), false);
	assert.strictEqual(h.add(''), false);
	assert.strictEqual(h.add(' secret thing'), false, 'a leading space keeps a line out (ignorespace)');
	assert.strictEqual(h.add('\tindented'), false);
	assert.deepStrictEqual(h.list(), ['ls', 'cd src', 'ls']);
});

test('the cap drops the oldest; 0 remembers nothing at all; the cap is held to 0..5000', () => {
	const h = createHistory({ store: fakeStore(), cap: 3 });
	['a', 'b', 'c', 'd', 'e'].forEach((l) => h.add(l));
	assert.deepStrictEqual(h.list(), ['c', 'd', 'e']);
	const none = createHistory({ store: fakeStore(), cap: 0 });
	assert.strictEqual(none.add('ls'), false);
	assert.deepStrictEqual(none.list(), []);
	assert.strictEqual(createHistory({ cap: 99999 }).cap(), 5000);
	assert.strictEqual(createHistory({ cap: -4 }).cap(), 0);
	assert.strictEqual(createHistory({}).cap(), 1000, 'the default');
	h.setCap(2);
	assert.deepStrictEqual(h.list(), ['d', 'e']);
	h.setCap(0);
	assert.deepStrictEqual(h.list(), []);
});

test('what is added is written to the store, and a new history starts from it', () => {
	const store = fakeStore();
	const h = createHistory({ store });
	h.add('ls');
	h.add('cat a.txt');
	assert.deepStrictEqual(store.data.get(KEY), ['ls', 'cat a.txt']);
	const again = createHistory({ store });
	assert.deepStrictEqual(again.list(), ['ls', 'cat a.txt']);
	again.add('pwd');
	assert.deepStrictEqual(store.data.get(KEY), ['ls', 'cat a.txt', 'pwd']);
});

test('a line that carries a secret is recalled in this session and never written', () => {
	const store = fakeStore();
	const h = createHistory({ store });
	const secrets = [
		cat('export API_', 'KEY=', 'abc123'),
		cat('export GITHUB_TO', 'KEN=', 'x'),
		cat('curl -H "Authori', 'zation: ', 'abc" https://x'),
		cat('curl -H "Bea', 'rer ', 'abcdefgh12345678" https://x'),
		cat('mysql --pass', 'word hunter2'),
		cat('echo pass', 'word=', 'hunter2'),
		cat('git clone https://user:', 'pw@host/repo'),
		cat('echo s', 'k', '-', 'a'.repeat(24)),
		cat('echo gh', 'p_', 'a'.repeat(30)),
		cat('echo AK', 'IA', 'A'.repeat(16)),
		cat('echo ey', 'J', 'a'.repeat(12), '.ey', 'J', 'b'.repeat(12)),
		cat('echo -----BEGIN RSA PRIVATE', ' KEY-----'),
	];
	for (const s of secrets) {
		assert.strictEqual(looksSecret(s), true, s);
		assert.strictEqual(h.add(s), true);
	}
	h.add('ls');
	assert.deepStrictEqual(h.list(), secrets.concat(['ls']), 'Up still finds them');
	assert.deepStrictEqual(store.data.get(KEY), ['ls'], 'the store has only the harmless line');
	for (const w of store.writes) { for (const s of secrets) { assert.ok(!w.includes(s)); } }
});

test('words that merely sound secret are not secrets', () => {
	for (const s of ['grep token file.txt', 'echo password', 'cat tokens.txt', 'ls secrets/', 'echo "the bearer of news"', 'git log --author=sky', 'echo sk-short', 'cd api-keys']) {
		assert.strictEqual(looksSecret(s), false, s);
	}
});

test('a very long line is kept for the session and not written (a pasted script would bloat the store)', () => {
	const store = fakeStore();
	const h = createHistory({ store });
	const big = 'echo ' + 'x'.repeat(5000);
	h.add(big);
	h.add('ls');
	assert.deepStrictEqual(h.list(), [big, 'ls']);
	assert.deepStrictEqual(store.data.get(KEY), ['ls']);
});

test('clear forgets the session and the store; a store that fails leaves the history working in memory', async () => {
	const store = fakeStore(['old1', 'old2']);
	const h = createHistory({ store });
	assert.deepStrictEqual(h.list(), ['old1', 'old2']);
	h.clear();
	assert.deepStrictEqual(h.list(), []);
	assert.deepStrictEqual(store.data.get(KEY), []);

	const broken = {
		get() { throw new Error('private window'); },
		update() { return Promise.reject(new Error('quota')); },
	};
	const m = createHistory({ store: broken });
	assert.strictEqual(m.add('ls'), true);
	assert.deepStrictEqual(m.list(), ['ls']);
	const throwing = { get: () => [], update() { throw new Error('closed'); } };
	const t = createHistory({ store: throwing });
	assert.doesNotThrow(() => t.add('ls'));
	await new Promise((r) => setTimeout(r, 5));   // a rejected update must not become an unhandled rejection

	// what is stored may not be what we wrote: anything that is not a non-empty string is ignored
	const odd = createHistory({ store: fakeStore(['ok', 7, null, '', '  ', { a: 1 }, 'fine']) });
	assert.deepStrictEqual(odd.list(), ['ok', 'fine']);
	assert.deepStrictEqual(createHistory({ store: fakeStore('not an array') }).list(), []);
});

(async () => {
	let n = 0;
	for (const [name, fn] of queue) { await fn(); n++; console.log('  ok - ' + name); }
	console.log(`\n${n} tests passed`);
})().catch((e) => { console.error(e); process.exit(1); });
