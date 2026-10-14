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
const { everyShape } = require('./helpers/shell-terminal-timing');

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

test('a cap of 0 hides what an earlier setting stored, and forgets it; a cap under the number stored keeps the newest', () => {
	const store = fakeStore(['a', 'b', 'c']);
	const none = createHistory({ store, cap: 0 });
	assert.deepStrictEqual(none.list(), [], 'slice(-0) is slice(0): the whole list would have come back');
	assert.deepStrictEqual(store.data.get(KEY), [], 'and the store was emptied, not only hidden');
	assert.strictEqual(none.add('ls'), false);
	// the same at the other end: nothing written when there was nothing there
	const empty = fakeStore([]);
	createHistory({ store: empty, cap: 0 });
	assert.strictEqual(empty.writes.length, 0);
	// a cap under what is stored
	const two = createHistory({ store: fakeStore(['a', 'b', 'c', 'd']), cap: 2 });
	assert.deepStrictEqual(two.list(), ['c', 'd']);
	const one = createHistory({ store: fakeStore(['a', 'b', 'c']), cap: 1 });
	assert.deepStrictEqual(one.list(), ['c']);
	// exactly the number stored: all of them
	assert.deepStrictEqual(createHistory({ store: fakeStore(['a', 'b']), cap: 2 }).list(), ['a', 'b']);
});

test('add(line, secret): the caller\'s verdict is used, and a secret is kept in memory only', () => {
	const store = fakeStore();
	const h = createHistory({ store });
	assert.strictEqual(h.add('plain', true), true);
	assert.strictEqual(h.add('other'), true);
	assert.deepStrictEqual(h.list(), ['plain', 'other']);
	assert.deepStrictEqual(store.data.get(KEY), ['other'], 'told it was one, it was not written');
	const b = createHistory({ store: fakeStore() });
	const looks = cat('export API_', 'KEY=', 'abc123');
	b.add(looks, false);
	assert.deepStrictEqual(b.list(), [looks]);
});

test('looksSecret reads a bounded part of a line, in time bounded by its length: every shape that backtracks', () => {
	const slow = [
		'a'.repeat(100000), 'eyJ-'.repeat(25000), 'a://'.repeat(25000), 'a:b@'.repeat(25000), '-----BEGIN ' + 'A'.repeat(100000),
		'token' + ' '.repeat(100000), 'bearer' + ' '.repeat(100000), '--password' + ' '.repeat(100000), 'x'.repeat(50000) + '://u:' + 'p'.repeat(50000),
		cat('ey', 'J') + 'a'.repeat(100000), 'sk-' + 'a'.repeat(100000),
	];
	for (const line of slow) {
		const t0 = process.hrtime.bigint();
		looksSecret(line);
		const ms = Number(process.hrtime.bigint() - t0) / 1e6;
		assert.ok(ms < 100, line.slice(0, 20) + '... took ' + ms.toFixed(1) + ' ms');
	}
});

test('the bounds are exactly the bounds: what is read, how long a scheme and a token may be', () => {
	const at = (n, text) => 'x'.repeat(n) + ' ' + text;
	// the first 4096 characters are read, not one more
	const secret = cat('export API_', 'KEY=', 'abc123');
	assert.strictEqual(looksSecret(at(4096 - secret.length - 1, secret)), true, 'ends exactly at 4096');
	assert.strictEqual(looksSecret(at(4096, secret)), false, 'starts after it');
	// the scheme of a URL with credentials: 32 characters, not 33
	const creds = (scheme) => scheme + '://user:pw@host';
	assert.strictEqual(looksSecret(creds('a'.repeat(32))), true);
	assert.strictEqual(looksSecret(creds('a'.repeat(33))), false);
	assert.strictEqual(looksSecret('git clone ' + creds('ssh+git')), true, 'an ordinary scheme after other words');
	assert.strictEqual(looksSecret('x-' + creds('https')), true, 'a scheme of its own after a punctuation mark');
	// the user and the password of that URL: 256 each
	assert.strictEqual(looksSecret('https://' + 'u'.repeat(256) + ':' + 'p'.repeat(256) + '@h'), true);
	assert.strictEqual(looksSecret('https://' + 'u'.repeat(257) + ':' + 'p'.repeat(256) + '@h'), false);
	assert.strictEqual(looksSecret('https://' + 'u'.repeat(256) + ':' + 'p'.repeat(257) + '@h'), false);
	// the first part of a JWT, after "eyJ": 10 to 2000 characters (the rest of it is only looked at for its start)
	const jwt = (n) => 'echo ' + cat('ey', 'J') + 'a'.repeat(n) + '.' + cat('ey', 'J') + 'b'.repeat(10);
	assert.strictEqual(looksSecret(jwt(2000)), true);
	assert.strictEqual(looksSecret(jwt(2001)), false);
	assert.strictEqual(looksSecret(jwt(10)), true);
	assert.strictEqual(looksSecret(jwt(9)), false);
});

test('the 4,096th character is read and the 4,097th is not: a secret is found when the character that completes it is at index 4095, and not at 4096', () => {
	// `password=x` is a secret when its `x` is there: the character that completes the pattern is the last of it
	const secret = cat('pass', 'word=', 'x');
	const padded = (completesAt) => ' '.repeat(completesAt - (secret.length - 1)) + secret;
	assert.strictEqual(padded(4095).length, 4096);
	assert.strictEqual(looksSecret(padded(4095)), true, 'the 4,096th character completes it');
	assert.strictEqual(looksSecret(padded(4096)), false, 'the 4,097th does not count');
	assert.strictEqual(looksSecret(padded(4094)), true);
	assert.strictEqual(looksSecret(padded(0 + secret.length - 1)), true, 'at the start');
	// and what is past it does not matter to a line that is a secret before it
	assert.strictEqual(looksSecret(secret + ' '.repeat(100000)), true);
});

test('looksSecret over the shapes a text can have: lines of blanks, line ends, marks, unfinished sequences', () => {
	everyShape('looksSecret', (text) => looksSecret(text));
});

let finished = false;
// a test that awaits something that never settles leaves nothing to keep the process alive: it would exit 0, silently
process.on('exit', (code) => { if (code === 0 && !finished) { console.error('the tests did not finish: one of them waits for something that never happens'); process.exitCode = 1; } });
(async () => {
	let n = 0;
	for (const [name, fn] of queue) { await fn(); n++; console.log('  ok - ' + name); }
	finished = true;
	console.log(`\n${n} tests passed`);
})().catch((e) => { console.error(e); process.exit(1); });
