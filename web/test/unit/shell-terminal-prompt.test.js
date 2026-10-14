/*---------------------------------------------------------------------------------------------
 *  LevelCode Shell terminal: the prompt - run: node web/test/unit/shell-terminal-prompt.test.js
 *
 *  Where the shell is, as the prompt says it: the folder of the workspace the working folder is in, named by that
 *  folder, `.../a/b` when it would take more than 40% of the width, `$ ` when even that does not fit; and two folders of
 *  one name told apart by the fewest folders they are in that make the labels differ. The path comes from the engine
 *  (a command can `cd` into whatever it made), so it is not trusted: a name 200,000 characters long, or a root with
 *  200,000 slashes, is a label in linear time.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

const assert = require('assert');
const path = require('path');

const dir = path.join(__dirname, '..', '..', 'shell', 'src', 'terminal');
const { cwdLabel, promptFor } = require(path.join(dir, 'prompt.js'));
const { strWidth } = require(path.join(dir, 'width.js'));
const sanitize = require(path.join(dir, '..', 'sanitize.js'));
const { everyShape, took } = require('./helpers/shell-terminal-timing');

const queue = [];
const test = (name, fn) => queue.push([name, fn]);

const label = (cwd, folders, columns = 100) => cwdLabel(cwd, folders, columns, sanitize);

test('the folder of the workspace the working folder is in names it; outside every folder it is the path', () => {
	const folders = [{ name: 'proj', root: '/ws/proj' }, { name: 'lib', root: '/ws/proj/lib' }];
	assert.strictEqual(label('/ws/proj', folders), 'proj');
	assert.strictEqual(label('/ws/proj/src/deep', folders), 'proj/src/deep');
	assert.strictEqual(label('/ws/proj/lib/x', folders), 'lib/x', 'the folder it is most inside');
	assert.strictEqual(label('/elsewhere/dir', folders), '/elsewhere/dir');
	assert.strictEqual(label('/', folders), '/');
	assert.strictEqual(label('/ws/proj', [{ name: 'proj', root: '/ws/proj/' }]), 'proj', 'a trailing slash of the root');
	assert.strictEqual(label('/ws/proj/src', [{ name: 'proj', root: '/ws/proj/' }]), 'proj/src');
	assert.strictEqual(label('/ws/proj/src', [{ name: 'proj', root: '/ws/proj///' }]), 'proj/src', 'and every one of them');
	assert.strictEqual(label('/a', [{ name: 'root', root: '/' }]), 'root/a');
});

test('two folders of one name are told apart by the fewest folders they are in that make the labels differ', () => {
	const f = (name, origin, root) => ({ name, root: root || origin, origin });
	// a/proj and b/proj: one folder is enough
	assert.strictEqual(label('/mnt/p1', [f('proj', '/x/a/proj', '/mnt/p1'), f('proj', '/y/b/proj', '/mnt/p2')]), 'a/proj');
	assert.strictEqual(label('/mnt/p2/src', [f('proj', '/x/a/proj', '/mnt/p1'), f('proj', '/y/b/proj', '/mnt/p2')]), 'b/proj/src');
	// the same folder above, so two are needed
	assert.strictEqual(label('/mnt/p1', [f('proj', '/x/a/proj', '/mnt/p1'), f('proj', '/y/a/proj', '/mnt/p2')]), 'x/a/proj');
	assert.strictEqual(label('/mnt/p2', [f('proj', '/x/a/proj', '/mnt/p1'), f('proj', '/y/a/proj', '/mnt/p2')]), 'y/a/proj');
	// three: the one that is told from both
	const three = [f('proj', '/x/a/proj', '/mnt/p1'), f('proj', '/y/b/proj', '/mnt/p2'), f('proj', '/y/a/proj', '/mnt/p3')];
	assert.strictEqual(label('/mnt/p1', three), 'x/a/proj');
	assert.strictEqual(label('/mnt/p2', three), 'b/proj');
	assert.strictEqual(label('/mnt/p3', three), 'y/a/proj');
	// one of them is at the top: its label has nothing above it, the other has what it is in
	assert.strictEqual(label('/mnt/p1', [f('proj', '/proj', '/mnt/p1'), f('proj', '/a/proj', '/mnt/p2')]), 'proj');
	assert.strictEqual(label('/mnt/p2', [f('proj', '/proj', '/mnt/p1'), f('proj', '/a/proj', '/mnt/p2')]), 'a/proj');
	// in the same place: nothing tells them apart, and the whole of where they are is shown
	assert.strictEqual(label('/mnt/p1', [f('proj', '/x/a/proj', '/mnt/p1'), f('proj', '/x/a/proj', '/mnt/p2')]), 'x/a/proj');
	// folders of other names do not count
	assert.strictEqual(label('/ws/proj', [{ name: 'proj', root: '/ws/proj' }, { name: 'lib', root: '/ws/lib' }]), 'proj');
});

/* What the code did before it was made linear, kept here as the reference the new one is compared with. */
function referenceParts(folder, folders) {
	const components = (p) => String(p).split('/').filter(Boolean);
	const name = String(folder.name || '');
	const where = (f) => components(typeof f.origin === 'string' ? f.origin : f.root);
	const others = folders.filter((f) => f && f !== folder && String(f.name || '') === name);
	if (others.length === 0) { return [name]; }
	const mine = where(folder);
	for (let up = 1; up <= mine.length; up++) {
		const l = mine.slice(-up - 1, -1).concat(name).join('/');
		if (others.every((f) => where(f).slice(-up - 1, -1).concat(name).join('/') !== l)) { return mine.slice(-up - 1, -1).concat(name); }
	}
	return mine.slice(0, -1).concat(name);
}

function referenceTruncate(labelText, max) {
	const cps = Array.from(labelText);
	while (cps.length > 4 && strWidth(cps.join('')) > max - 1) { cps.splice(cps.length - 2, 1); }
	return cps.join('') + '…';
}

test('the label is what it was: the same names, and the same cut, as the code that built a label for every depth and cut one character at a time', () => {
	let seed = 99;
	const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
	const pick = (a) => a[Math.floor(rnd() * a.length)];
	const names = ['a', 'b', 'proj', 'x', 'src', 'web', '你好', 'é'];
	let compared = 0;
	for (let k = 0; k < 600; k++) {
		const n = 1 + Math.floor(rnd() * 4);
		const folders = [];
		for (let i = 0; i < n; i++) {
			const depth = Math.floor(rnd() * 5);
			const parts = Array.from({ length: depth }, () => pick(names));
			const name = pick(['proj', 'proj', 'lib']);
			const root = '/' + parts.concat(name).join('/');
			folders.push(rnd() < 0.5 ? { name, root } : { name, root: '/mnt/' + i, origin: root });
		}
		for (const f of folders) {
			// folderParts is internal: what it decides shows as the label of the folder itself
			const shown = cwdLabel(f.root, folders, 1000, sanitize);
			const want = referenceParts(f, folders).join('/');
			assert.strictEqual(shown, want, JSON.stringify({ f, folders }));
			compared++;
		}
	}
	assert.ok(compared > 500);
	// the cut of a label that is still too wide: the first characters, then the last one, then the mark
	for (let k = 0; k < 400; k++) {
		const len = 1 + Math.floor(rnd() * 40);
		let name = '';
		for (let i = 0; i < len; i++) { name += pick(['a', 'b', 'c', '你', '好', 'é', '😀', '-']); }
		const columns = 10 + Math.floor(rnd() * 40);
		const max = Math.max(8, Math.floor(columns * 0.4));
		const shown = cwdLabel('/ws/' + name, [{ name: 'w', root: '/ws' }], columns, sanitize);
		const full = 'w/' + name;
		let want = full;
		const parts = ['w', name];
		if (strWidth(want) > max && parts.length > 2) { want = '.../' + parts.slice(-2).join('/'); }
		if (strWidth(want) > max && parts.length > 1) { want = '.../' + parts[parts.length - 1]; }
		if (strWidth(want) > max) { want = referenceTruncate(want, max); }
		assert.strictEqual(shown, want, JSON.stringify({ name, columns }));
		compared++;
	}
});

test('a label of wide characters that cannot fit is cut to four characters and the mark, however wide they are', () => {
	// the first three are 6 cells and the last is 2: more than the 7 that fit, and the cut stops at four characters
	assert.strictEqual(cwdLabel('/ws', [{ name: '\u4f60\u597d\u4e16\u754c\u4f60\u597d\u4e16\u754c', root: '/ws' }], 20, sanitize), '\u4f60\u597d\u4e16\u754c\u2026');
	assert.strictEqual(referenceTruncate('\u4f60\u597d\u4e16\u754c\u4f60\u597d\u4e16\u754c', 8), '\u4f60\u597d\u4e16\u754c\u2026');
	// and a narrow one is cut by the width, not by the count
	assert.strictEqual(cwdLabel('/ws', [{ name: 'abcdefghijklmnopqrstuvwxyz', root: '/ws' }], 20, sanitize), 'abcdef' + 'z' + '\u2026', 'seven cells of the eight, and the mark');
});

test('a prompt that does not fit is `$ `; a status that is not 0 is shown in it', () => {
	const folders = [{ name: 'proj', root: '/ws/proj' }];
	const p = (o) => promptFor(Object.assign({ cwd: '/ws/proj/src', folders, status: 0, columns: 80, sanitize }, o));
	assert.ok(/proj\/src.* \$ $/.test(p({}).replace(/\x1b\[[0-9;]*m/g, '')));
	assert.ok(p({ status: 3 }).includes('[3]'));
	assert.strictEqual(p({ columns: 8 }), '$ ');
});

test('a label is made in linear time: a name or a path of 200,000 characters, or 200,000 slashes', () => {
	const slowest = everyShape('a label', (text) => {
		// as a name in the working folder, as a name in a root, and as the root itself
		cwdLabel('/ws/' + text, [{ name: 'ws', root: '/ws' }], 80, sanitize);
		cwdLabel('/' + text + '/a', [{ name: 'r', root: '/' + text }], 80, sanitize);
		promptFor({ cwd: '/ws/' + text, folders: [{ name: 'ws', root: '/ws' }], status: 1, columns: 80, sanitize });
	});
	assert.ok(slowest > 0);
	// roots that share their end for a long way (the label walks from the end, once, and does not build one per depth)
	const deep = Array.from({ length: 30000 }, () => 'd').join('/');
	const folders = [{ name: 'p', root: '/mnt/1', origin: '/a/' + deep + '/p' }, { name: 'p', root: '/mnt/2', origin: '/b/' + deep + '/p' }];
	const ms = took(() => { cwdLabel('/mnt/1', folders, 80, sanitize); cwdLabel('/mnt/2', folders, 80, sanitize); });
	assert.ok(ms < 500, 'two folders that share 30,000 folders: ' + ms.toFixed(0) + ' ms');
	assert.strictEqual(label('/mnt/1', folders, 200000).split('/').length, 30002, 'and they are told apart by the first one');
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
