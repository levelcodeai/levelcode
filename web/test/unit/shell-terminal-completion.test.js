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
const { everyShape, pathological, took, N } = require('./helpers/shell-terminal-timing');

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
		['> ou', 2, 'ou', '', 'path'],             // a redirection first: its target is a file, not a command
		['> out ec', 6, 'ec', '', 'command'],      // ... and the word after the target is the command
		['2> out ec', 7, 'ec', '', 'command'],
		['< in > out gre', 11, 'gre', '', 'command'],
		['ls > out ec', 9, 'ec', '', 'path'],      // after a command it is an argument, as it was
		['< fi', 2, 'fi', '', 'path'],
		['2> er', 3, 'er', '', 'path'],
		['cat < fi', 6, 'fi', '', 'path'],
		['ls >> lo', 6, 'lo', '', 'path'],
		['echo a > b; gre', 12, 'gre', '', 'command'],   // and a command again after the `;`
		['if tr', 3, 'tr', '', 'command'],
		['while tru', 6, 'tru', '', 'command'],
		['echo $(ls sr', 10, 'sr', '', 'path'],
		['./scr', 0, './scr', '', 'path'],
		['src/ap', 0, 'src/ap', '', 'path'],
		['(gre', 1, 'gre', '', 'command'],
	];
	checkWords(rows);
	// only what is before the cursor counts
	assert.deepStrictEqual(word('cat sr/ap tail', 9), { start: 4, prefix: 'sr/ap', quote: '', kind: 'path' });
});

/** What the cursor is in, as the rows of these tables have it (the rest of the word is tested on its own). */
function word(line, cursor) {
	const { start, prefix, quote, kind } = wordAt(line, cursor);
	return { start, prefix, quote, kind };
}
/** @param {Array<Array<string | number>>} rows line, start, prefix, quote, kind; the cursor at the end of the line */
function checkWords(rows) {
	for (const [line, start, prefix, quote, kind] of rows) {
		assert.deepStrictEqual(word(String(line), Array.from(String(line)).length), { start, prefix, quote, kind }, JSON.stringify(line));
	}
}

test('a line end that is not quoted or escaped ends a command, as `;` does: the first word of the next line is a command again', () => {
	checkWords([
		['echo hi\ngre', 8, 'gre', '', 'command'],          // a pasted buffer of two lines
		['echo a > b\ngre', 11, 'gre', '', 'command'],      // and it ends a redirection's command too
		['cd src\nLC_ALL=C gre', 16, 'gre', '', 'command'],
		['echo "a\nb" sr', 11, 'sr', '', 'path'],           // inside quotes it is a character of the word: still an argument
	]);
});

test('assignments before the command are not the command: `LC_ALL=C gre` completes a command (the name unquoted, as bash reads one)', () => {
	checkWords([
		['LC_ALL=C gre', 9, 'gre', '', 'command'],
		['a=1 b=2 gre', 8, 'gre', '', 'command'],
		['FOO="a b" gre', 10, 'gre', '', 'command'],
		['a[1]=x gre', 7, 'gre', '', 'command'],
		['PATH+=:/x gre', 10, 'gre', '', 'command'],
		['2> err LC_ALL=C gre', 16, 'gre', '', 'command'],
		// what is not one: a quoted or escaped name is a command word (bash: `"LC_ALL"=C: command not found`), and after the
		// command a NAME=value is an argument
		['"LC_ALL"=C sr', 11, 'sr', '', 'path'],
		['A\\=b sr', 5, 'sr', '', 'path'],
		['make CC=gcc sr', 12, 'sr', '', 'path'],
	]);
});

test('a redirection written against a word: the command before it ends there; a descriptor (`2>`) and an assignment do not; `>&`, `<&`, `&>` and `>|` are redirections', () => {
	// each checked against bash: `bash -xc 'cat>out echo sr'` traces `+ cat echo sr`
	checkWords([
		['cat>out sr', 8, 'sr', '', 'path'],
		['cat<in sr', 7, 'sr', '', 'path'],
		['ls>>log sr', 8, 'sr', '', 'path'],
		['x2>out sr', 7, 'sr', '', 'path'],                 // not all digits: a command word
		['"2">out sr', 8, 'sr', '', 'path'],                // quoted digits are a word too (`2: command not found`)
		['2>err ec', 6, 'ec', '', 'command'],               // a descriptor written against its operator
		['A=1>out gre', 8, 'gre', '', 'command'],           // an assignment written against one
		['>a>b gre', 5, 'gre', '', 'command'],              // the target of one written against the next
		['2>&1 gre', 5, 'gre', '', 'command'],              // `>&` duplicates a descriptor: it is not a background `&`
		['cat <&0 sr', 8, 'sr', '', 'path'],
		['cat &>out sr', 10, 'sr', '', 'path'],             // `&>` is one operator
		['cat&>out sr', 9, 'sr', '', 'path'],
		['&>out gre', 6, 'gre', '', 'command'],
		['>|out gre', 6, 'gre', '', 'command'],             // `>|` too: it is not a pipe
		['ls 2>&1 | gre', 10, 'gre', '', 'command'],        // and a pipe after the operator's target is one
	]);
});

test('the rest of the word after the cursor: where it ends and what it holds, read the same way as what is before it', () => {
	const rest = (line, cursor) => { const w = wordAt(line, cursor); return { end: w.end, rest: w.rest }; };
	assert.deepStrictEqual(rest('cat "my fi"', 10), { end: 11, rest: '' }, 'just before the closing quote: the quote is the rest');
	assert.deepStrictEqual(rest('cat "my fi" x', 10), { end: 11, rest: '' });
	assert.deepStrictEqual(rest('cat "my fi" x', 8), { end: 11, rest: 'fi' });
	assert.deepStrictEqual(rest('cat "my fi"le.txt x', 10), { end: 17, rest: 'le.txt' });
	assert.deepStrictEqual(rest("cat 'my fi'", 10), { end: 11, rest: '' });
	assert.deepStrictEqual(rest('cat my\\ fi', 7), { end: 10, rest: ' fi' }, 'a backslash before the cursor escapes what is after it');
	assert.deepStrictEqual(rest('cat sr;ls', 6), { end: 6, rest: '' });
	assert.deepStrictEqual(rest('echo $(ls sr)', 12), { end: 12, rest: '' });
	assert.deepStrictEqual(rest('cat sr', 6), { end: 6, rest: '' });
	assert.deepStrictEqual(rest('cat ', 4), { end: 4, rest: '' });
	assert.deepStrictEqual(rest('cat  x', 4), { end: 4, rest: '' }, 'a blank under the cursor: nothing after it is the word');
	assert.deepStrictEqual(rest('cat foo', 4), { end: 4, rest: '' }, 'a cursor after a blank starts a new word: the one after it is another');
	assert.deepStrictEqual(rest('cat "x"', 4), { end: 4, rest: '' });
});

test('Tab inside a word: a candidate must end with what is after the cursor, and then replaces it, closing quote and all; a folder keeps its quote open', async () => {
	const names = ['my file.txt', 'my fig.png', 'my dir/', 'README.md', 'ab', 'abb', 'abxb', 'src/'];
	const complete = createCompleter({ complete: async (kind, prefix) => names.filter((n) => n.startsWith(prefix)) }, sanitize);
	// just before the closing quote: the candidate replaces the quote too, so the line keeps one closing quote
	assert.deepStrictEqual((await complete('cat "my fil"', 11)).candidates, [{ text: '"my file.txt"', display: 'my file.txt', dir: false, end: 12 }]);
	// several candidates: each written whole, each with the end of the word
	assert.deepStrictEqual((await complete('cat "my fi"', 10)).candidates.map((c) => [c.text, c.end]), [['"my file.txt"', 11], ['"my fig.png"', 11]]);
	// a folder leaves its quote open for the next name: the quote that is there after the cursor closes it, so it stays
	assert.deepStrictEqual((await complete('cat "my d"', 9)).candidates, [{ text: '"my dir/', display: 'my dir/', dir: true }]);
	// inside a name, only names that end with the rest of the word: nothing after the cursor is dropped or split off
	assert.deepStrictEqual((await complete('cat "my fi"le.txt', 10)).candidates.map((c) => [c.text, c.end]), [['"my file.txt"', 17]]);
	assert.strictEqual(await complete('cat READ.old', 8), null, 'README.md does not end with .old');
	// prefix and rest may not overlap: "ab" typed, "b" after the cursor is the word "abb", which "ab" is not
	assert.deepStrictEqual((await complete('cat abb', 6)).candidates.map((c) => c.text), ['abb', 'abxb']);
	// a folder inside its name is written whole (the rest of the word was its end), with or without its slash
	assert.deepStrictEqual((await complete('cd src', 5)).candidates, [{ text: 'src/', display: 'src/', dir: true, end: 6 }]);
	assert.deepStrictEqual((await complete('cd "my d"ir', 8)).candidates, [{ text: '"my dir/"', display: 'my dir/', dir: true, end: 11 }]);
	// at the end of a word nothing changes: no end, as before
	assert.deepStrictEqual((await complete('cat READ', 8)).candidates, [{ text: 'README.md', display: 'README.md', dir: false }]);
});

test('a name the editor would type without one of its characters is not offered: `rm a` must not become `rm ab.txt`', async () => {
	// U+200B is not typed by the line editor (cleanText): the candidate would name another file than the one listed
	const zwsp = createCompleter({ complete: async () => ['a​b.txt'] }, sanitize);
	assert.strictEqual(await zwsp('rm a', 4), null);
	for (const hidden of ['​', '⁠', '﻿', '­', '‍', '‌', '️', '\u{e0041}', 'ㅤ']) {
		const r = await createCompleter({ complete: async () => ['a' + hidden + 'b.txt', 'abc.txt'] }, sanitize)('rm a', 4);
		assert.deepStrictEqual(r.candidates.map((c) => c.text), ['abc.txt'], 'U+' + /** @type {number} */ (hidden.codePointAt(0)).toString(16));
	}
	// what the editor keeps is offered: an emoji with its selector, a family, a Persian word with its ZWNJ
	const kept = ['✔️ done.md', '\u{1f468}‍\u{1f469}‍\u{1f467}.txt', 'می‌روم.txt'];
	for (const name of kept) {
		const r = await createCompleter({ complete: async () => [name] }, sanitize)('cat ' + Array.from(name)[0], 5);
		assert.strictEqual(r.candidates.length, 1, JSON.stringify(name));
	}
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

test('a name with a C1 control or DEL in it is not offered: the terminal reads U+009B as a CSI', async () => {
	const complete = createCompleter({ complete: async () => ['src/ok.js', 'src/\u009b31m.js', 'src/a\u007fb.js', 'src/\u0085x', 'src/\u009dtitle', 'src/\u2066x'] }, sanitize);
	const r = await complete('cat src/', 8);
	assert.deepStrictEqual(r.candidates.map((c) => c.text), ['src/ok.js']);
});

test('the word under the cursor, what is written back and the candidates are taken in linear time: the text and the names are not trusted', async () => {
	// the cursor at the end, and at the start (all of it is the rest of a word, or after one)
	everyShape('wordAt', (text) => { wordAt(text, Array.from(text).length); wordAt(text, 0); wordAt(text, 1); });
	// a word that ends in command position is asked whether it is an assignment, a long one too
	for (const text of ['a'.repeat(N) + ' x', 'a[' + 'b'.repeat(N) + ' x', 'a'.repeat(N) + '>x', '1'.repeat(N) + '>x', 'a=1 '.repeat(N / 4) + 'x']) {
		const ms = took(() => wordAt(text, Array.from(text).length));
		assert.ok(ms < 500, ms.toFixed(0) + ' ms on ' + JSON.stringify(text.slice(0, 12)));
	}
	everyShape('writeBack', (text) => { writeBack(text, '', false); writeBack(text, '"', false); writeBack(text, "'", true); });
	for (const shape of ['a run of spaces', 'a run of tabs', 'a run of line feeds', 'backslashes', 'letters', 'combining marks']) {
		const input = pathological()[shape];
		const t0 = process.hrtime.bigint();
		const r = await createCompleter({ complete: async () => [input, input + 'x', 'y' + input] }, sanitize)('cat ', 4);
		const ms = Number(process.hrtime.bigint() - t0) / 1e6;
		assert.ok(ms < 1000, shape + ': ' + ms.toFixed(0) + ' ms');
		assert.ok(r === null || r.candidates.length <= 3);
	}
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
