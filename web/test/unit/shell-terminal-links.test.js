/*---------------------------------------------------------------------------------------------
 *  LevelCode Shell terminal: file links - run: node web/test/unit/shell-terminal-links.test.js
 *
 *  In the output of our terminals `src/a.js`, `src/a.js:12`, `src/a.js:12:5` and `(src/a.js:12)` become links that
 *  open the file at that line and column, when the file is there. The workbench's own file links are off, so this is
 *  the only path, and it reads text that came from files and commands:
 *    - what makes a candidate, as a table, with the false positives a terminal full of output has (URLs, `a:b`,
 *      times, drive letters, a sentence's last dot);
 *    - a candidate is a link only when the file exists, as a file, under a mount, relative to the terminal's folder;
 *    - the check is bounded: 5 stats per line, one per distinct path, 500 ms in all;
 *    - a terminal that is not ours is not looked at; the tooltip is a constant; the file is opened at line and column.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

const assert = require('assert');
const path = require('path');

const { fakeVscode, manualTimers, TERMINAL } = require('./helpers/shell-terminal-fakes');
const { createLinkProvider, findCandidates, resolvePath, MAX_STATS, STAT_MS, MAX_LINE } = require(path.join(TERMINAL, 'links.js'));
const { everyShape } = require('./helpers/shell-terminal-timing');

const queue = [];
const test = (name, fn) => queue.push([name, fn]);

/** [what is shown for the link, path, line, col] of each candidate of a line. */
const found = (text) => findCandidates(text).map((c) => [text.slice(c.startIndex, c.startIndex + c.length), c.path, c.line, c.col]);

test('what is a candidate: a path with a slash or an extension, and a :line or :line:col after it', () => {
	const table = [
		['src/a.js', [['src/a.js', 'src/a.js', null, null]]],
		['src/a.js:12', [['src/a.js:12', 'src/a.js', 12, null]]],
		['src/a.js:12:5', [['src/a.js:12:5', 'src/a.js', 12, 5]]],
		['(src/a.js:12)', [['src/a.js:12', 'src/a.js', 12, null]]],
		['at foo (src/a.js:12:5)', [['src/a.js:12:5', 'src/a.js', 12, 5]]],
		['src/a.js:12: error: x', [['src/a.js:12', 'src/a.js', 12, null]]],
		['  src/a.js:12:5:', [['src/a.js:12:5', 'src/a.js', 12, 5]]],
		['"src/a.js"', [['src/a.js', 'src/a.js', null, null]]],
		['[src/a.js]', [['src/a.js', 'src/a.js', null, null]]],
		['--config=src/a.js:3', [['src/a.js:3', 'src/a.js', 3, null]]],
		['./a.js ../b/c.ts /abs/d.py', [['./a.js', './a.js', null, null], ['../b/c.ts', '../b/c.ts', null, null], ['/abs/d.py', '/abs/d.py', null, null]]],
		['README.md', [['README.md', 'README.md', null, null]]],
		['Makefile:12:', [['Makefile:12', 'Makefile', 12, null]]],
		['src/日本語.js:3', [['src/日本語.js:3', 'src/日本語.js', 3, null]]],
		['a.js:0', [['a.js:0', 'a.js', 1, null]]],
		['two a.js, b.js', [['a.js', 'a.js', null, null], ['b.js', 'b.js', null, null]]],
	];
	for (const [text, want] of table) { assert.deepStrictEqual(found(text), want, JSON.stringify(text)); }
});

test('what is not: URLs, a:b, times, drive letters, version numbers, bare words, ~, folders of nothing', () => {
	const none = [
		'https://example.com/a.js:12', 'http://localhost:3000/', 'file:///etc/passwd:3', 'git@github.com:user/repo.git', 'mailto:me@x.org',
		'a:b', 'key: value', 'at 12:30', 'at 12:30:45', '1.5', 'v1.2.3', '3.14',
		'C:\\Users\\me\\a.js:3', 'C:/Users/me/a.js:3', 'D:\\x\\y.txt',
		'LICENSE', 'hello world', 'ls: cannot access', '~/a.js', '~',
		'', '   ', '...', '..', '.', '/', '::', ':12',
	];
	for (const text of none) {
		const hits = found(text).filter((h) => !['e.g', 'git@github.com'].includes(h[1]));
		assert.deepStrictEqual(hits, [], JSON.stringify(text));
	}
	// what it does take that the existence check then turns down, cheaply
	assert.deepStrictEqual(found('localhost:3000').map((h) => h[1]), ['localhost']);
	assert.deepStrictEqual(found('e.g.').map((h) => h[1]), ['e.g']);
	// the end of a sentence is not the path's
	assert.deepStrictEqual(found('see src/a.js.'), [['src/a.js', 'src/a.js', null, null]]);
	assert.deepStrictEqual(found('(see src/a.js, src/b.js)').map((h) => h[1]), ['src/a.js', 'src/b.js']);
	// a run too long to be a path (a minified line, a base64 blob) is not one
	assert.deepStrictEqual(found('a/' + 'x'.repeat(2000)), []);
});

test('paths are resolved against the folder of the terminal, with .. first, and stay inside what is mounted', () => {
	assert.strictEqual(resolvePath('/scratch/src', 'a.js'), '/scratch/src/a.js');
	assert.strictEqual(resolvePath('/scratch/src', './a.js'), '/scratch/src/a.js');
	assert.strictEqual(resolvePath('/scratch/src', '../b/c.js'), '/scratch/b/c.js');
	assert.strictEqual(resolvePath('/scratch/src', '/abs/x.js'), '/abs/x.js');
	assert.strictEqual(resolvePath('/scratch', '../../../etc/passwd'), '/etc/passwd', '.. stops at the root');
	assert.strictEqual(resolvePath('/scratch', 'a//b/./c'), '/scratch/a/b/c');
});

/** A provider on a fake file system and a fake clock. `files` maps uri strings to a FileType. */
function setup(files, o) {
	const opts = o || {};
	const fv = fakeVscode();
	Object.assign(fv.state.files, files);
	const timers = manualTimers();
	const terminal = { name: 'LevelCode Shell' };
	const provider = createLinkProvider({
		vscode: fv.vscode,
		mounts: () => opts.mounts || [{ mount: '/scratch', uri: 'file:///scratch' }, { mount: '/mnt/site', uri: 'file:///' }],
		// the folders the line was printed in: the likeliest first
		cwdsOf: (t, line) => (t === terminal ? (opts.cwds ? (typeof opts.cwds === 'function' ? opts.cwds(line) : opts.cwds) : [opts.cwd || '/scratch']) : undefined),
		setTimeout: timers.setTimeout,
		clearTimeout: timers.clearTimeout,
	});
	return { fv, timers, terminal, provider };
}
const token = { isCancellationRequested: false };

test('a candidate is a link when its file exists, as a file, under a mount; not a folder, not a missing file, not outside', async () => {
	const t = setup({ 'file:///scratch/a.js': 1, 'file:///scratch/dir': 2, 'file:///etc/passwd': 1 });
	const line = 'a.js dir/ missing.js ../etc/passwd dir';
	const links = await t.provider.provideTerminalLinks({ line, terminal: t.terminal }, token);
	assert.deepStrictEqual(links.map((l) => line.slice(l.startIndex, l.startIndex + l.length)), ['a.js']);
	assert.strictEqual(links[0].tooltip, 'Open in the editor', 'a constant: the text of the line is not in it');
	// every path of that line was asked about once, in the file system the mount says
	assert.ok(t.fv.state.stats.includes('file:///scratch/a.js'));
	assert.ok(t.fv.state.stats.includes('file:///scratch/missing.js'));
	assert.ok(!t.fv.state.stats.some((u) => u.startsWith('file:///etc')), 'nothing outside the mounts is ever asked');
});

test('a mount that is not at its folder (the root of a file system under /mnt) is found through its uri', async () => {
	const t = setup({ 'file:///src/app.js': 1 }, { cwd: '/mnt/site' });
	const links = await t.provider.provideTerminalLinks({ line: 'src/app.js:3', terminal: t.terminal }, token);
	assert.deepStrictEqual(links.map((l) => String(l.uri)), ['file:///src/app.js']);
});

test('at most 5 distinct paths of a line are asked about, each once', async () => {
	assert.strictEqual(MAX_STATS, 5);
	const files = {};
	for (let i = 0; i < 12; i++) { files['file:///scratch/f' + i + '.js'] = 1; }
	const t = setup(files);
	const line = 'f0.js f0.js ' + Array.from({ length: 12 }, (_, i) => 'f' + i + '.js').join(' ') + ' f0.js:3';
	const links = await t.provider.provideTerminalLinks({ line, terminal: t.terminal }, token);
	assert.strictEqual(t.fv.state.stats.length, 5);
	assert.strictEqual(new Set(t.fv.state.stats).size, 5);
	// the first five paths, and every place of them on the line (f0.js is there four times)
	assert.deepStrictEqual(links.map((l) => line.slice(l.startIndex, l.startIndex + l.length)), ['f0.js', 'f0.js', 'f0.js', 'f1.js', 'f2.js', 'f3.js', 'f4.js', 'f0.js:3']);
});

test('the answers are waited for 500 ms, and a line that is not answered in time has no links for what did not answer', async () => {
	assert.strictEqual(STAT_MS, 500);
	const t = setup({ 'file:///scratch/fast.js': 1 });
	// a file system that never answers for one of them
	const real = t.fv.vscode.workspace.fs.stat;
	t.fv.vscode.workspace.fs.stat = (uri) => (String(uri).endsWith('hang.js') ? new Promise(() => { }) : real(uri));
	const line = 'fast.js hang.js';
	/** @type {any} */
	let done = null;
	const pending = t.provider.provideTerminalLinks({ line, terminal: t.terminal }, token).then((l) => { done = l; });
	await new Promise((r) => setTimeout(r, 5));
	assert.strictEqual(done, null, 'still waiting');
	t.timers.advance(499);
	await new Promise((r) => setTimeout(r, 5));
	assert.strictEqual(done, null, 'at 499 ms');
	t.timers.advance(1);
	await pending;
	assert.deepStrictEqual(done.map((l) => line.slice(l.startIndex, l.startIndex + l.length)), ['fast.js']);
});

test('a terminal that is not one of ours is not looked at: no scan, no stat', async () => {
	const t = setup({ 'file:///scratch/a.js': 1 });
	const other = { name: 'bash' };
	assert.deepStrictEqual(await t.provider.provideTerminalLinks({ line: 'a.js:1', terminal: other }, token), []);
	assert.deepStrictEqual(t.fv.state.stats, []);
	assert.deepStrictEqual(await t.provider.provideTerminalLinks({ line: 5, terminal: t.terminal }, token), [], 'a line that is not text');
});

test('a cancelled request returns nothing; a stat that throws is a file that is not there', async () => {
	const t = setup({ 'file:///scratch/a.js': 1 });
	assert.deepStrictEqual(await t.provider.provideTerminalLinks({ line: 'a.js', terminal: t.terminal }, { isCancellationRequested: true }), []);
	t.fv.vscode.workspace.fs.stat = () => { throw new Error('no permission'); };
	assert.deepStrictEqual(await t.provider.provideTerminalLinks({ line: 'a.js', terminal: t.terminal }, token), []);
});

test('only the first 4,000 characters of a line are read', async () => {
	const t = setup({ 'file:///scratch/early.js': 1, 'file:///scratch/late.js': 1 });
	const line = 'early.js ' + ' '.repeat(4000) + 'late.js';
	const links = await t.provider.provideTerminalLinks({ line, terminal: t.terminal }, token);
	assert.deepStrictEqual(links.map((l) => line.slice(l.startIndex, l.startIndex + l.length)), ['early.js']);
});

test('the bound is exactly 4,000: a word that ends at the last character read is taken, and one the cut goes through is not read as half a word', () => {
	assert.strictEqual(MAX_LINE, 4000);
	const word = 'src/a.js';
	// ends at index 3999, the 4,000th character, and the text goes on with a blank
	const whole = ' '.repeat(4000 - word.length) + word + ' tail';
	assert.deepStrictEqual(found(whole).map((h) => h[1]), ['src/a.js']);
	assert.deepStrictEqual(found(' '.repeat(4000 - word.length) + word).map((h) => h[1]), ['src/a.js'], 'and at the very end of the text');
	// one character further: the cut would read `src/a.j`, which is another file's name; it is not read at all
	const through = ' '.repeat(4001 - word.length) + word;
	assert.deepStrictEqual(found(through), []);
	// a `:line` the cut goes through is not read as a shorter one
	const line = ' '.repeat(4000 - 'a.js:12'.length) + 'a.js:123';
	assert.deepStrictEqual(found(line), []);
	// a word that ends before the cut and is followed by something that is not a word
	assert.deepStrictEqual(found(' '.repeat(4000 - 'a.js'.length) + 'a.js' + ',x.js').map((h) => h[1]), ['a.js']);
	// and nothing is read past it
	assert.deepStrictEqual(found('a.js' + ' '.repeat(4000) + 'b.js').map((h) => h[1]), ['a.js']);
});

test('what is a candidate is found in linear time: runs of dots, slashes, colons and blanks do not backtrack', () => {
	everyShape('findCandidates', (text) => { findCandidates(text); });
	// ... and the longest line it will read, made of the worst shape for each part of the pattern
	// (the dots one is /\.+$/ over a run of 3,999 dots that does not end the word: 8 million steps a line, 10 ms)
	for (const text of ['.'.repeat(3999) + 'a', 'a'.repeat(3999) + '.', '/'.repeat(4000), 'a:'.repeat(2000), '1:'.repeat(2000), 'a.b.'.repeat(1000)]) {
		const t0 = process.hrtime.bigint();
		for (let i = 0; i < 300; i++) { findCandidates(text); }
		const ms = Number(process.hrtime.bigint() - t0) / 1e6;
		assert.ok(ms < 500, JSON.stringify(text.slice(0, 10)) + ' x300 took ' + ms.toFixed(0) + ' ms');
	}
});

test('a line is resolved against the folder it was printed in; the folder the command began in is tried after the one it ended in', async () => {
	const t = setup({ 'file:///scratch/a/x.js': 1, 'file:///scratch/b/x.js': 1, 'file:///scratch/b/only.js': 1, 'file:///scratch/a/early.js': 1 }, {
		cwds: (line) => (line.startsWith('A:') ? ['/scratch/a'] : line.startsWith('B:') ? ['/scratch/b'] : ['/scratch/b', '/scratch/a']),
	});
	const uris = async (line) => (await t.provider.provideTerminalLinks({ line, terminal: t.terminal }, token)).map((l) => String(l.uri));
	assert.deepStrictEqual(await uris('A: x.js'), ['file:///scratch/a/x.js']);
	assert.deepStrictEqual(await uris('B: x.js'), ['file:///scratch/b/x.js']);
	// ended in b, began in a: what b has is b's, and what only a has is found there
	assert.deepStrictEqual(await uris('x.js early.js'), ['file:///scratch/b/x.js', 'file:///scratch/a/early.js']);
	assert.deepStrictEqual(await uris('only.js'), ['file:///scratch/b/only.js']);
	// no folder at all is a line that is nobody's
	const none = setup({ 'file:///scratch/a.js': 1 }, { cwds: [] });
	assert.deepStrictEqual(await none.provider.provideTerminalLinks({ line: 'a.js', terminal: none.terminal }, token), []);
	assert.deepStrictEqual(none.fv.state.stats, []);
	// the budget is for paths, not for folders: two folders of one name are two paths
	const many = {};
	for (let i = 0; i < 5; i++) { many['file:///scratch/b/f' + i + '.js'] = 1; }
	const m = setup(many, { cwds: ['/scratch/a', '/scratch/b'] });
	await m.provider.provideTerminalLinks({ line: 'f0.js f1.js f2.js f3.js f4.js', terminal: m.terminal }, token);
	assert.strictEqual(m.fv.state.stats.length, MAX_STATS);
});

test('a terminal that is not ours is not scanned at all, even where a path that is nobody\'s would resolve (a mount at the root)', async () => {
	// with the guard gone a foreign line is resolved against `undefined`, which is the root: and the root is mounted here
	const t = setup({ 'file:///undefined/a.js': 1, 'file:///a.js': 1 }, { mounts: [{ mount: '/', uri: 'file:///' }] });
	const other = { name: 'bash' };
	assert.deepStrictEqual(await t.provider.provideTerminalLinks({ line: 'a.js:1 undefined/a.js', terminal: other }, token), []);
	assert.deepStrictEqual(t.fv.state.stats, [], 'not a stat');
	// ours, in the same set-up, is looked at
	const ours = await t.provider.provideTerminalLinks({ line: 'a.js:1', terminal: t.terminal }, token);
	assert.strictEqual(ours.length, 0, 'the folder is /scratch, which is not mounted here');
});

test('clicking a link opens the file at its line and column, 0-based for the editor; a file that will not open falls back to the workbench', async () => {
	const t = setup({ 'file:///scratch/a.js': 1 });
	const [link] = await t.provider.provideTerminalLinks({ line: 'a.js:12:5', terminal: t.terminal }, token);
	await t.provider.handleTerminalLink(link);
	assert.strictEqual(t.fv.state.opened.length, 1);
	const sel = t.fv.state.opened[0].options.selection;
	assert.deepStrictEqual([sel.start.line, sel.start.character, sel.end.line, sel.end.character], [11, 4, 11, 4]);
	// a bare path opens at the top
	const [bare] = await t.provider.provideTerminalLinks({ line: 'a.js', terminal: t.terminal }, token);
	await t.provider.handleTerminalLink(bare);
	const top = t.fv.state.opened[1].options.selection;
	assert.deepStrictEqual([top.start.line, top.start.character], [0, 0]);
	// showTextDocument refuses (a binary file): the workbench's own open
	t.fv.vscode.window.showTextDocument = () => Promise.reject(new Error('binary'));
	await t.provider.handleTerminalLink(link);
	assert.deepStrictEqual(t.fv.state.executed, ['vscode.open file:///scratch/a.js']);
});

(async () => {
	let n = 0;
	for (const [name, fn] of queue) { await fn(); n++; console.log('  ok - ' + name); }
	console.log(`\n${n} tests passed`);
})().catch((e) => { console.error(e); process.exit(1); });
