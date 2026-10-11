/*---------------------------------------------------------------------------------------------
 *  LevelCode Shell terminal: Tab completion - run: node web/test/unit/shell-terminal-completion.test.js
 *
 *  The session answers with names. This module reads the word under the cursor the way the shell reads it (quotes,
 *  backslashes, command position) and writes a candidate back so that the line still means what it says.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

const assert = require('assert');
const path = require('path');

const dir = path.join(__dirname, '..', '..', 'shell', 'src', 'terminal');
const { wordAt, writeBack, createCompleter } = require(path.join(dir, 'completion.js'));
const sanitize = require(path.join(dir, '..', 'sanitize.js'));

const queue = [];
const test = (name, fn) => queue.push([name, fn]);

test('the word under the cursor: where it starts, what was typed, the quote it is in, and what kind of thing it is', () => {
	const rows = [
		// line, start, prefix, quote, kind
		['ca', 0, 'ca', '', 'command'],
		['', 0, '', '', 'command'],
		['cat sr', 4, 'sr', '', 'path'],
		['cat ', 4, '', '', 'path'],
		['cat "my fi', 4, 'my fi', '"', 'path'],
		["cat 'my fi", 4, 'my fi', "'", 'path'],
		['cat my\\ fi', 4, 'my fi', '', 'path'],
		['echo hi; ls ./s', 12, './s', '', 'path'],
		['echo hi && gre', 11, 'gre', '', 'command'],
		['a | gre', 4, 'gre', '', 'command'],
		['ls > ou', 5, 'ou', '', 'path'],
		['if tr', 3, 'tr', '', 'command'],
		['while tru', 6, 'tru', '', 'command'],
		['echo $(ls sr', 10, 'sr', '', 'path'],
		['./scr', 0, './scr', '', 'path'],
		['src/ap', 0, 'src/ap', '', 'path'],
		['(gre', 1, 'gre', '', 'command'],
	];
	for (const [line, start, prefix, quote, kind] of rows) {
		assert.deepStrictEqual(wordAt(String(line), Array.from(String(line)).length), { start, prefix, quote, kind }, JSON.stringify(line));
	}
	// only what is before the cursor counts
	assert.deepStrictEqual(wordAt('cat sr/ap tail', 9), { start: 4, prefix: 'sr/ap', quote: '', kind: 'path' });
});

test('writeBack escapes for the quote the word is in, and closes it unless the candidate is a folder', () => {
	assert.strictEqual(writeBack('plain.txt', '', false), 'plain.txt');
	assert.strictEqual(writeBack('my file.txt', '', false), 'my\\ file.txt');
	assert.strictEqual(writeBack('a&b(c).txt', '', false), 'a\\&b\\(c\\).txt');
	assert.strictEqual(writeBack('#hash', '', false), '\\#hash');
	assert.strictEqual(writeBack('a#hash', '', false), 'a#hash');
	assert.strictEqual(writeBack('~tilde', '', false), '\\~tilde');
	assert.strictEqual(writeBack('my file', '"', false), '"my file"');
	assert.strictEqual(writeBack('a"b$c', '"', false), '"a\\"b\\$c"');
	assert.strictEqual(writeBack("it's", "'", false), "'it'\\''s'");
	assert.strictEqual(writeBack('src/', '', true), 'src/');
	assert.strictEqual(writeBack('my dir/', '"', true), '"my dir/', 'a folder leaves the quote open so the name can go on');
});

test('the completer asks the session for the right kind, keeps what continues the word, and sanitises what it shows', async () => {
	const asked = [];
	const session = {
		async complete(kind, prefix) {
			asked.push([kind, prefix]);
			return ['src/app.js', 'src/lib/', 'src/a b.js', 'src/bad\x1b[6n.js', 'src/‮evil', 'other', 'src/app.js', ''];
		},
	};
	const complete = createCompleter(session, sanitize);
	const r = await complete('cat src/a', 9);
	assert.deepStrictEqual(asked, [['path', 'src/a']]);
	assert.strictEqual(r.start, 4);
	const texts = r.candidates.map((c) => c.text);
	assert.ok(texts.includes('src/app.js') && texts.includes('src/a\\ b.js'));
	assert.ok(!texts.some((t) => /\x1b|‮/.test(t)), 'a name that cannot be typed is not offered');
	assert.ok(!texts.includes('other'), 'only what continues the word');
	assert.strictEqual(texts.filter((t) => t === 'src/app.js').length, 1, 'once');
	for (const c of r.candidates) { assert.ok(!/[\x00-\x1f\x7f-\x9f]/.test(c.display)); }

	assert.strictEqual(await complete('', 0), null, 'Tab on an empty line lists nothing');
	await complete('gre', 3);
	assert.deepStrictEqual(asked[asked.length - 1], ['command', 'gre']);
	const dirResult = await createCompleter({ complete: async () => ['src/lib/'] }, sanitize)('cat src/l', 9);
	assert.deepStrictEqual(dirResult.candidates, [{ text: 'src/lib/', display: 'src/lib/', dir: true }]);
	assert.strictEqual(await createCompleter({ complete: async () => { throw new Error('gone'); } }, sanitize)('cat a', 5), null);
	assert.strictEqual(await createCompleter({ complete: async () => 'nope' }, sanitize)('cat a', 5), null);
});

(async () => {
	let n = 0;
	for (const [name, fn] of queue) { await fn(); n++; console.log('  ok - ' + name); }
	console.log(`\n${n} tests passed`);
})().catch((e) => { console.error(e); process.exit(1); });
