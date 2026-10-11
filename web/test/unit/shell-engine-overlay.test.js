/*---------------------------------------------------------------------------------------------
 *  The engine's file system — run: node web/test/unit/shell-engine-overlay.test.js
 *
 *  A copy-on-write overlay over a read-only, asynchronous base, plus memory. What matters:
 *    - nothing is ever written to the base: the only calls it sees are stat, readFile, readDir;
 *    - the caps are applied BEFORE a file is read, and a refusal says what really happened (notes);
 *    - a write's content never throws; the opening of a redirection does, as bash's own error;
 *    - what a command removes, it removes: a removed folder that is made again is empty;
 *    - the change set is the NET difference: no-op rewrites and create-then-delete are nothing;
 *    - every error carries a POSIX code and a message that starts with it.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

const assert = require('assert');
const path = require('path');

// a worker has `crypto`; Node 18 has it only as require('crypto').webcrypto (the /dev/urandom read uses it)
if (typeof globalThis.crypto === 'undefined') { globalThis.crypto = /** @type {any} */ (require('crypto').webcrypto); }

const { makeTree } = require('./shell-engine-support.js');
const { createOverlay, createMemory, planMounts, validCaps, DEFAULT_CAPS, DIR_SIZE, isShellScript } = require(path.join(__dirname, '..', '..', 'shell', 'engine', 'overlay-fs.js'));

/** @type {Array<{ name: string, fn: () => Promise<void> | void }>} */
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

const enc = new TextEncoder();
const dec = new TextDecoder();

/** A base over a tree, counting what it is asked and failing the test if anything but a read is attempted. */
function baseOf(tree) {
	/** @type {string[]} */
	const calls = [];
	const err = (code) => Object.assign(new Error(code), { code });
	const base = {
		calls,
		async stat(p) {
			calls.push('stat ' + p);
			if (!tree.nodes.has(p)) { throw err('ENOENT'); }
			const n = tree.nodes.get(p);
			return { type: n === null ? 'dir' : 'file', size: n ? n.length : 0, mtime: 1700000000000 };
		},
		async readFile(p) {
			calls.push('readFile ' + p);
			const n = tree.nodes.get(p);
			if (n === undefined) { throw err('ENOENT'); }
			if (n === null) { throw err('EISDIR'); }
			return n.slice();
		},
		async readDir(p) {
			calls.push('readDir ' + p);
			if (tree.nodes.get(p) !== null) { throw err(tree.nodes.has(p) ? 'ENOTDIR' : 'ENOENT'); }
			return tree.list(p);
		},
	};
	return base;
}

/** @param {Record<string, string | Uint8Array | null>} files @param {any} [o] */
function setup(files, o) {
	const tree = makeTree(Object.assign({ '/w': null }, files));
	const base = baseOf(tree);
	const ov = createOverlay(Object.assign({ folders: [{ id: 'f', path: '/w', name: 'w' }], base }, o || {}));
	return { tree, base, ov, fs: ov.fs };
}

const code = async (p) => { try { await p; return 'no error'; } catch (e) { assert.ok(e.message.startsWith(e.code + ': '), 'message starts with the code: ' + e.message); return e.code; } };
const changes = async (ov) => (await ov.changes()).changes;
const brief = (cs) => cs.map((c) => c.kind + ' ' + c.path + (c.viaDir ? ' via ' + c.viaDir : ''));

/* ---------------------------------------------------------------------------------------------- mounts */

test('a folder is mounted at its own path; the root, the shell\'s own paths, and a folder inside another are relocated under /mnt', () => {
	const plan = planMounts([
		{ id: '1', path: '/scratch', name: 'scratch' },
		{ id: '2', path: '/', name: 'repo' },
		{ id: '3', path: '/tmp', name: 'tmp' },
		{ id: '4', path: '/home/me/proj', name: 'proj' },
		{ id: '5', path: '/scratch/inner', name: 'inner' },
		{ id: '6', path: '/work', name: 'work' },
		{ id: '7', path: '/usr/src', name: 'src' },
		{ id: '8', path: '/dev', name: 'tmp' },
	]);
	const at = Object.fromEntries(plan.map((m) => [m.id, m.at]));
	assert.deepStrictEqual(plan.map((m) => m.id), ['1', '2', '3', '4', '5', '6', '7', '8'], 'the host\'s order is kept');
	assert.deepStrictEqual(at, { 1: '/scratch', 2: '/mnt/repo', 3: '/mnt/tmp', 4: '/mnt/proj', 5: '/mnt/inner', 6: '/work', 7: '/mnt/src', 8: '/mnt/tmp-2' });
	assert.deepStrictEqual(plan.filter((m) => m.relocated).map((m) => m.id), ['2', '3', '4', '5', '7', '8']);
	assert.ok(plan.every((m) => m.relocated === (m.at !== m.host)));
	assert.ok(plan.find((m) => m.id === '5').reason.includes('overlaps'));
	assert.ok(plan.find((m) => m.id === '2').reason.includes('root'));
	assert.ok(plan.find((m) => m.id === '3').reason.includes('itself'));
});

test('a relocated folder is read and reported under the path the host knows it by', async () => {
	const tree = makeTree({ '/tmp': null, '/tmp/a.txt': 'hi\n' });
	const base = baseOf(tree);
	const ov = createOverlay({ folders: [{ id: 'f', path: '/tmp', name: 'tmp' }], base });
	assert.strictEqual(ov.mounts[0].at, '/mnt/tmp');
	assert.strictEqual(ov.fromHost('/tmp/a.txt'), '/mnt/tmp/a.txt');
	assert.strictEqual(ov.toHost('/mnt/tmp/a.txt'), '/tmp/a.txt');
	assert.strictEqual(await ov.fs.readFile('/mnt/tmp/a.txt'), 'hi\n');
	assert.ok(base.calls.includes('stat /tmp/a.txt') && base.calls.includes('readFile /tmp/a.txt'), base.calls.join(' | '));
	assert.ok(!base.calls.some((c) => c.includes('/mnt')), 'the host never hears of /mnt');
	await ov.fs.writeFile('/mnt/tmp/new.txt', 'x');
	await ov.fs.rm('/mnt/tmp/a.txt');
	assert.deepStrictEqual(brief(await changes(ov)), ['write /tmp/new.txt', 'delete /tmp/a.txt']);
	assert.strictEqual(await ov.fs.exists('/tmp/a.txt'), false, 'the real /tmp is the shell\'s memory, not the folder');
});

test('the layout is what the engine looks for: / lists folders and the shell\'s own directories, /mnt leads to relocated ones', async () => {
	const { ov, fs } = setup({ '/w/a': 'x' });
	assert.deepStrictEqual(await fs.readdir('/'), ['bin', 'dev', 'home', 'proc', 'tmp', 'usr', 'w']);
	const m = createOverlay({ folders: [{ id: 'a', path: '/', name: 'root' }, { id: 'b', path: '/x/y', name: 'y' }], base: baseOf(makeTree({ '/': null, '/x/y': null })) });
	assert.deepStrictEqual(await m.fs.readdir('/'), ['bin', 'dev', 'home', 'mnt', 'proc', 'tmp', 'usr', 'x']);
	assert.deepStrictEqual(await m.fs.readdir('/mnt'), ['root']);
	assert.deepStrictEqual(await m.fs.readdir('/x'), ['y']);
	assert.strictEqual((await m.fs.stat('/x')).isDirectory, true);
	assert.strictEqual((await fs.stat('/w')).isDirectory, true, 'a folder exists even before the host has said anything');
	assert.strictEqual(ov.mounts[0].relocated, false);
	assert.strictEqual(await code(fs.readdir('/nope')), 'ENOENT');
	assert.strictEqual(await code(fs.readdir('/w/a')), 'ENOTDIR');
});

/* ---------------------------------------------------------------------------------------------- reading */

test('reading: bytes, text, latin1 bytes; errors have a code and start with it; a directory says what it is', async () => {
	const { ov, fs } = setup({ '/w/a.txt': 'héllo\n', '/w/d': null, '/w/bin': new Uint8Array([0, 255, 128]) });
	assert.strictEqual(await fs.readFile('/w/a.txt'), 'héllo\n');
	assert.strictEqual(await fs.readFile('/w/a.txt', 'utf8'), 'héllo\n');
	assert.deepStrictEqual([...await fs.readFileBuffer('/w/bin')], [0, 255, 128]);
	assert.strictEqual(await fs.readFileBytes('/w/a.txt'), 'hÃ©llo\n', 'one character per byte');
	assert.strictEqual(await fs.readFile('/w/bin', 'latin1'), '\u0000ÿ\u0080');
	assert.strictEqual(await fs.readFile('/w/bin', 'hex'), '00ff80');
	assert.strictEqual(await fs.readFile('/w/bin', 'base64'), 'AP+A');
	assert.strictEqual(await code(fs.readFile('/w/nope')), 'ENOENT');
	assert.strictEqual(await code(fs.readFile('/w/d')), 'EISDIR');
	assert.strictEqual(await code(fs.readFile('/w/a.txt/x')), 'ENOENT');
	assert.ok(ov.notes.some((n) => n.includes('"/w/d" is a directory') && n.includes('No such file or directory" line for it is wrong')));
	try { await fs.readFile('/w/nope'); } catch (e) { assert.strictEqual(e.message, "ENOENT: no such file or directory, open '/w/nope'"); }
});

test('stat: kinds, sizes (a directory reports 4096), a stable identity per path, modes from the shebang', async () => {
	const { fs } = setup({ '/w/a.txt': 'hello', '/w/d': null, '/w/run.sh': '#!/bin/sh\necho hi\n', '/w/app.js': '#!/usr/bin/env node\n', '/w/env.sh': '#!/usr/bin/env bash\n', '/w/plain': 'x' });
	const a = await fs.stat('/w/a.txt');
	assert.deepStrictEqual([a.isFile, a.isDirectory, a.isSymbolicLink, a.size, a.mode], [true, false, false, 5, 0o644]);
	assert.ok(a.mtime instanceof Date && +a.mtime === 1700000000000);
	const d = await fs.stat('/w/d');
	assert.deepStrictEqual([d.isFile, d.isDirectory, d.size, d.mode], [false, true, 4096, 0o755]);
	assert.strictEqual(DIR_SIZE, 4096);
	assert.strictEqual((await fs.stat('/w/a.txt')).identity, a.identity, 'the same path is the same file');
	assert.notStrictEqual((await fs.stat('/w/plain')).identity, a.identity);
	assert.strictEqual((await fs.lstat('/w/a.txt')).identity, a.identity);
	assert.strictEqual((await fs.stat('/w/run.sh')).mode, 0o755, 'a shell script is executable');
	assert.strictEqual((await fs.stat('/w/env.sh')).mode, 0o755, '#!/usr/bin/env bash too');
	assert.strictEqual((await fs.stat('/w/app.js')).mode, 0o644, 'a script for another interpreter is not run as shell');
	assert.strictEqual((await fs.stat('/w/plain')).mode, 0o644);
	assert.strictEqual(await code(fs.stat('/w/nope')), 'ENOENT');
	assert.strictEqual(await fs.exists('/w/a.txt'), true);
	assert.strictEqual(await fs.exists('/w/nope'), false);
	assert.strictEqual(await fs.realpath('/w/./d/../a.txt'), '/w/a.txt');
	assert.strictEqual(await fs.resolvePath('/w/d', '../a.txt'), '/w/a.txt');
	assert.strictEqual(await fs.resolvePath('/w', '/etc/../tmp'), '/tmp');
	assert.strictEqual(await fs.resolvePath('/', '../../x'), '/x', '.. stops at the root');
});

test('a path cannot leave its folder with ..: the base never hears of anything outside the mounts', async () => {
	const { base, fs } = setup({ '/w/a': 'x' });
	assert.strictEqual(await code(fs.readFile('/w/../etc/passwd')), 'ENOENT');
	assert.strictEqual(await code(fs.stat('/w/../../x')), 'ENOENT');
	assert.ok(base.calls.every((c) => /\s\/w(\/|$)/.test(c)), base.calls.join(' | '));
});

test('a mount root always exists and is listed through the base; a base error that is not "missing" is an error, not "empty"', async () => {
	const { base, fs } = setup({ '/w/a': 'x', '/w/b': null });
	assert.deepStrictEqual((await fs.readdirWithFileTypes('/w')).map((e) => [e.name, e.isFile, e.isDirectory]), [['a', true, false], ['b', false, true]]);
	assert.deepStrictEqual(base.calls, ['readDir /w'], 'a listing is one call, and a mount root needs no stat');
	const broken = createOverlay({
		folders: [{ id: 'f', path: '/w', name: 'w' }],
		base: { async stat() { throw Object.assign(new Error('boom'), { code: 'EACCES' }); }, async readFile() { throw new Error('x'); }, async readDir() { throw Object.assign(new Error('boom'), { code: 'EACCES' }); } },
	});
	assert.strictEqual(await code(broken.fs.readdir('/w')), 'EACCES');
	assert.strictEqual(await code(broken.fs.stat('/w/x')), 'EACCES');
	assert.strictEqual(await broken.fs.exists('/w/x'), false);
});

/* ---------------------------------------------------------------------------------------------- caps */

test('caps are applied before a file is read: stat first, a file over the cap is never fetched, and the note says it exists', async () => {
	const { base, ov, fs } = setup({ '/w/big.bin': new Uint8Array(5000), '/w/small': 'ok' }, { caps: { readFile: 1000, readRun: 100000 } });
	assert.strictEqual(await code(fs.readFileBuffer('/w/big.bin')), 'EFBIG');
	assert.ok(!base.calls.includes('readFile /w/big.bin'), 'not fetched');
	assert.strictEqual(await fs.readFile('/w/small'), 'ok');
	assert.ok(ov.notes.some((n) => /"\/w\/big\.bin" was NOT read: it is 4\.9 KiB, over the 1000 bytes/.test(n) && /file exists/.test(n)), ov.notes.join('\n'));
	assert.strictEqual((await fs.stat('/w/big.bin')).size, 5000, 'stat still works');
});

test('the per-run budget counts bytes read once, serves a second read from memory, and refuses what would exceed it', async () => {
	const { base, ov, fs } = setup({ '/w/a': 'x'.repeat(600), '/w/b': 'y'.repeat(600), '/w/c': 'z'.repeat(100) }, { caps: { readFile: 1000, readRun: 1000 } });
	await fs.readFile('/w/a');
	await fs.readFile('/w/a');
	assert.strictEqual(base.calls.filter((c) => c === 'readFile /w/a').length, 1, 'cached');
	assert.strictEqual(ov.stats.bytesRead, 600);
	assert.strictEqual(await code(fs.readFile('/w/b')), 'EFBIG');
	assert.strictEqual(await fs.readFile('/w/c'), 'z'.repeat(100), 'a smaller one still fits');
	assert.ok(ov.notes.some((n) => /"\/w\/b" was NOT read: this command has already read 600 bytes and the limit is 1000 bytes/.test(n)), ov.notes.join('\n'));
	assert.strictEqual(ov.stats.filesRead, 2);
});

test('the base is asked once per path and run: what it said about a path, a listing and a file is remembered', async () => {
	const { base, fs } = setup({ '/w/a.txt': 'hello', '/w/d/x': '1' });
	await fs.stat('/w/a.txt');
	await fs.stat('/w/a.txt');
	assert.strictEqual(await fs.exists('/w/a.txt'), true);
	assert.strictEqual(await fs.readFile('/w/a.txt'), 'hello');
	assert.strictEqual(await fs.readFile('/w/a.txt'), 'hello');
	await fs.readdir('/w/d');
	await fs.readdir('/w/d');
	assert.strictEqual(await fs.exists('/w/nope'), false);
	assert.strictEqual(await fs.exists('/w/nope'), false);
	const count = (c) => base.calls.filter((x) => x === c).length;
	assert.deepStrictEqual([count('stat /w/a.txt'), count('readFile /w/a.txt'), count('readDir /w/d'), count('stat /w/nope')], [1, 1, 1, 1], base.calls.join(' | '));
});

test('a shebang is looked for in at most 32 small files per run (a probe is a read)', async () => {
	/** @type {Record<string, string>} */
	const files = {};
	for (let i = 0; i < 40; i++) { files['/w/s' + String(i).padStart(2, '0')] = '#!/bin/sh\necho ' + i + '\n'; }
	files['/w/huge'] = '#!/bin/sh\n' + 'x'.repeat(40000);
	const { ov, fs } = setup(files);
	const modes = [];
	for (let i = 0; i < 40; i++) { modes.push((await fs.stat('/w/s' + String(i).padStart(2, '0'))).mode); }
	assert.strictEqual(modes.filter((m) => m === 0o755).length, 32);
	assert.strictEqual(ov.stats.probes, 32);
	assert.strictEqual((await fs.stat('/w/huge')).mode, 0o644, 'over 32 KiB is not read for its first line');
	// and by itself, with the probes not used up: a big file is not read for its first line either
	const big = setup({ '/w/huge': '#!/bin/sh\n' + 'x'.repeat(40000), '/w/small': '#!/bin/sh\n' });
	assert.strictEqual((await big.fs.stat('/w/huge')).mode, 0o644);
	assert.deepStrictEqual(big.base.calls.filter((c) => c.startsWith('readFile')), []);
	assert.strictEqual((await big.fs.stat('/w/small')).mode, 0o755);
	assert.deepStrictEqual(big.base.calls.filter((c) => c.startsWith('readFile')), ['readFile /w/small']);
	assert.strictEqual((await fs.lstat('/w/s00')).mode, 0o755, 'lstat uses what is already known');
	assert.strictEqual(isShellScript(enc.encode('#!/bin/zsh\n')), true);
	assert.strictEqual(isShellScript(enc.encode('#!/usr/bin/python3\n')), false);
	assert.strictEqual(isShellScript(enc.encode('# not a shebang\n')), false);
});

test('writes are capped per file, per run and by entries: the content is dropped and recorded, never thrown', async () => {
	const { ov, fs, tree } = setup({}, { caps: { writeFile: 10, writeRun: 16, entries: 3 } });
	await fs.writeFile('/w/ok1', '0123456789');
	await fs.writeFile('/w/toobig', '0123456789A');
	await fs.writeFile('/w/ok2', '01234');
	await fs.writeFile('/w/over-run', '01');
	await fs.writeFile('/w/third', '');
	await fs.writeFile('/w/fourth', '');
	assert.deepStrictEqual(ov.denied.map((d) => [d.path, d.reason, d.code]), [['/w/toobig', 'cap-file', 'EFBIG'], ['/w/over-run', 'cap-run', 'ENOSPC'], ['/w/fourth', 'cap-entries', 'ENOSPC']]);
	assert.ok(/not written: it would be 11 bytes, over the 10 bytes/.test(ov.denied[0].message));
	assert.deepStrictEqual((await changes(ov)).map((c) => c.path), ['/w/ok1', '/w/ok2', '/w/third']);
	assert.strictEqual(tree.nodes.has('/w/ok1'), false, 'nothing reached the base');
	await fs.appendFile('/w/ok2', '5');
	await fs.appendFile('/w/ok2', 'x');
	assert.strictEqual(ov.denied.length, 4);
	assert.strictEqual(await fs.readFile('/w/ok2'), '012345', 'the append that fit was applied, the one that did not was dropped');
});

test('folders count toward the entry cap too: the one over it is not made, the error says why, and it is recorded', async () => {
	const { ov, fs } = setup({}, { caps: { entries: 2 } });
	await fs.mkdir('/w/a');
	assert.strictEqual(await code(fs.mkdir('/w/b/c', { recursive: true })), 'ENOSPC');   // b and c are two entries: only b fits
	assert.deepStrictEqual(ov.denied.map((d) => [d.path, d.op, d.reason]), [['/w/b/c', 'mkdir', 'cap-entries']]);
	assert.strictEqual(await fs.exists('/w/a'), true);
	assert.strictEqual(await fs.exists('/w/b'), true);
	assert.strictEqual(await fs.exists('/w/b/c'), false);
	assert.ok(/not created: this command would create more than 2 files and folders/.test(ov.denied[0].message), ov.denied[0].message);
});

/* ---------------------------------------------------------------------------------------------- writing */

test('the base is only ever read: a whole session of writes, removals and moves calls stat, readFile, readDir and nothing else', async () => {
	const { base, fs } = setup({ '/w/a.txt': 'one\n', '/w/d/x': '1', '/w/d/y': '2', '/w/old': 'o' });
	await fs.writeFile('/w/new.txt', 'n');
	await fs.appendFile('/w/a.txt', 'two\n');
	await fs.mkdir('/w/e/f', { recursive: true });
	await fs.cp('/w/d', '/w/d2', { recursive: true });
	await fs.mv('/w/old', '/w/newer');
	await fs.rm('/w/d', { recursive: true });
	await fs.chmod('/w/a.txt', 0o600);
	await fs.utimes('/w/a.txt', new Date(), new Date(0));
	assert.ok(base.calls.length > 0);
	assert.ok(base.calls.every((c) => /^(stat|readFile|readDir) /.test(c)), base.calls.join(' | '));
	assert.strictEqual(typeof /** @type {any} */ (base).writeFile, 'undefined');
});

test('reads see the command\'s own writes; an append to a base file starts from its bytes, and is amortised', async () => {
	const { base, ov, fs } = setup({ '/w/log': 'start\n' });
	await fs.appendFile('/w/log', 'a\n');
	await fs.appendFile('/w/log', 'b\n');
	assert.strictEqual(await fs.readFile('/w/log'), 'start\na\nb\n');
	assert.strictEqual(base.calls.filter((c) => c === 'readFile /w/log').length, 1, 'the base file is read once');
	const t0 = Date.now();
	for (let i = 0; i < 20000; i++) { await fs.appendFile('/w/many', 'line ' + i + '\n'); }
	assert.ok(Date.now() - t0 < 3000, '20000 appends took ' + (Date.now() - t0) + ' ms');
	assert.strictEqual((await fs.readFile('/w/many')).split('\n').length, 20001);
	const cs = await changes(ov);
	assert.strictEqual(cs.length, 2);
	const log = cs.find((c) => c.path === '/w/log');
	assert.deepStrictEqual([log.kind, log.existed, dec.decode(log.before), dec.decode(log.after)], ['write', true, 'start\n', 'start\na\nb\n']);
});

test('a view handed out earlier is not changed by a later append', async () => {
	const { fs } = setup({});
	await fs.writeFile('/w/f', 'abc');
	const first = await fs.readFileBuffer('/w/f');
	await fs.appendFile('/w/f', 'def');
	assert.strictEqual(dec.decode(first), 'abc');
	assert.strictEqual(await fs.readFile('/w/f'), 'abcdef');
	await fs.writeFile('/w/f', 'x');
	assert.strictEqual(dec.decode(first), 'abc');
});

test('mkdir, rmdir semantics and their errors', async () => {
	const { fs } = setup({ '/w/d/f': '1', '/w/file': 'x' });
	assert.strictEqual(await code(fs.mkdir('/w/d')), 'EEXIST');
	assert.strictEqual(await code(fs.mkdir('/w/file')), 'EEXIST');
	assert.strictEqual(await code(fs.mkdir('/w/a/b/c')), 'ENOENT');
	assert.strictEqual(await code(fs.mkdir('/w/file/x', { recursive: true })), 'ENOTDIR');
	await fs.mkdir('/w/a/b/c', { recursive: true });
	await fs.mkdir('/w/a/b/c', { recursive: true });
	assert.deepStrictEqual(await fs.readdir('/w/a/b'), ['c']);
	await fs.mkdir('/w/n');
	assert.strictEqual(await code(fs.rm('/w/d')), 'ENOTEMPTY');
	assert.strictEqual(await code(fs.rm('/w/nope')), 'ENOENT');
	await fs.rm('/w/nope', { force: true });
	await fs.rm('/w/n');
	assert.strictEqual(await fs.exists('/w/n'), false);
	await fs.createExclusive('/w/x1', { mode: 0o600 });
	assert.strictEqual(await code(fs.createExclusive('/w/x1', { mode: 0o600 })), 'EEXIST');
	assert.strictEqual((await fs.stat('/w/x1')).mode, 0o600);
	await fs.createExclusive('/w/xd', { mode: 0o700, directory: true });
	assert.strictEqual((await fs.stat('/w/xd')).isDirectory, true);
	assert.strictEqual(await code(fs.createExclusive('/w/nodir/x', { mode: 0o600 })), 'ENOENT');
});

test('links are refused, readlink of a file is EINVAL, and times and modes are per run', async () => {
	const { ov, fs } = setup({ '/w/a': 'x' });
	assert.strictEqual(await code(fs.symlink('a', '/w/l')), 'EPERM');
	assert.strictEqual(await code(fs.link('/w/a', '/w/h')), 'EPERM');
	assert.strictEqual(await code(fs.readlink('/w/a')), 'EINVAL');
	assert.strictEqual(await code(fs.readlink('/w/nope')), 'ENOENT');
	await fs.chmod('/w/a', 0o700);
	await fs.utimes('/w/a', new Date(), new Date(86400000));
	const s = await fs.stat('/w/a');
	assert.deepStrictEqual([s.mode, +s.mtime], [0o700, 86400000]);
	assert.strictEqual(await code(fs.chmod('/w/nope', 0o700)), 'ENOENT');
	assert.deepStrictEqual(await changes(ov), [], 'a mode and a time are not a change');
});

test('a staged file or folder is newer than anything before it in the run, even in the same millisecond', async () => {
	const { fs } = setup({}, { now: () => 5000 });
	await fs.writeFile('/w/a', '1');
	await fs.writeFile('/w/b', '2');
	await fs.mkdir('/w/c');
	await fs.appendFile('/w/a', '3');
	const m = [];
	for (const n of ['a', 'b', 'c']) { m.push(+(await fs.stat('/w/' + n)).mtime); }
	assert.ok(m[0] > m[1] && m[1] < m[2], 'a was written last (the append), b before c: ' + m.join(' '));
	assert.ok(new Set(m).size === 3);
});

/* ---------------------------------------------------------------------------------------------- the opening of a redirection */

test('a redirection that cannot open throws bash\'s reason and is not recorded', async () => {
	const { ov, fs } = setup({ '/w/d': null, '/w/f': 'x' });
	fs.writeFileSync('/bin/ls', 'stub');
	// the engine opens with an empty write, encoding 'binary'
	assert.strictEqual(await code(fs.writeFile('/w/nodir/f', '', 'binary')), 'ENOENT');
	assert.strictEqual(await code(fs.writeFile('/w/f/x', '', 'binary')), 'ENOTDIR');
	assert.strictEqual(await code(fs.writeFile('/w/d', '', 'binary')), 'EISDIR');
	assert.strictEqual(await code(fs.writeFile('/etc/passwd', '', 'binary')), 'EACCES');
	assert.strictEqual(await code(fs.appendFile('/etc/passwd', '', 'binary')), 'EACCES');
	assert.strictEqual(await code(fs.writeFile('/bin/ls', '', 'binary')), 'EACCES');
	assert.strictEqual(ov.denied.length, 0, 'a refused opening is a visible failure, not a drop');
	assert.ok(ov.notes.some((n) => n.startsWith('/etc/passwd is outside the workspace folders')), ov.notes.join('\n'));
	assert.ok(ov.notes.some((n) => n.startsWith('/bin/ls is part of the shell')));
});

test('a content write the SHELL refuses (outside the folders, a protected path) is dropped and recorded, never thrown', async () => {
	const { ov, fs } = setup({});
	fs.writeFileSync('/bin/ls', 'stub');
	await fs.writeFile('/etc/passwd', 'data');
	await fs.appendFile('/etc/passwd', 'more');
	await fs.writeFile('/bin/ls', 'data');
	assert.deepStrictEqual(ov.denied.map((d) => [d.path, d.op, d.reason, d.code]), [['/etc/passwd', 'write', 'outside', 'EACCES'], ['/etc/passwd', 'append', 'outside', 'EACCES'], ['/bin/ls', 'write', 'readonly', 'EACCES']]);
	assert.deepStrictEqual(await changes(ov), []);
});

test('a write a real file system would refuse (no parent, the parent is a file, a directory) is an error the command reports: it is not `denied`', async () => {
	const { ov, fs } = setup({ '/w/d': null, '/w/f': 'x' });
	// touch, tee, sort -o and split call writeFile with the content: GNU says "No such file or directory" and goes on
	assert.strictEqual(await code(fs.writeFile('/w/nodir/f', 'data')), 'ENOENT');
	assert.strictEqual(await code(fs.writeFile('/w/f/x', 'data')), 'ENOTDIR');
	assert.strictEqual(await code(fs.writeFile('/w/d', 'data')), 'EISDIR');
	assert.strictEqual(await code(fs.appendFile('/w/d', 'data')), 'EISDIR');
	assert.strictEqual(await code(fs.writeFile('/tmp/nodir/x', 'data')), 'ENOENT');
	assert.strictEqual(await code(fs.writeFile('/tmp', 'data')), 'EISDIR');
	assert.deepStrictEqual(ov.denied, [], 'nothing was refused by the shell: the whole run is not withheld');
	assert.deepStrictEqual(await changes(ov), []);
});

test('the content write of a redirection never throws once the redirection opened its target: the command may have removed the parent or replaced the file (GNU writes to the open descriptor); a write with no opening still does', async () => {
	const { ov, fs } = setup({ '/w/d/x': 'x', '/w/f': 'old', '/w/g': 'old' });
	// the engine opens first (an empty write, 'binary'), runs the command, then writes the content
	await fs.writeFile('/w/d/f', '', 'binary');
	await fs.rm('/w/d', { recursive: true, force: true });
	await fs.writeFile('/w/d/f', 'hi\n', 'utf8');                  // the parent is gone: no error, nothing written
	await fs.appendFile('/w/d/f', 'more\n', 'utf8');
	assert.strictEqual(await fs.exists('/w/d'), false);
	// the target itself replaced by a directory
	await fs.writeFile('/w/f', '', 'binary');
	await fs.rm('/w/f');
	await fs.mkdir('/w/f');
	await fs.writeFile('/w/f', 'hi\n', 'utf8');
	assert.strictEqual((await fs.stat('/w/f')).isDirectory, true, 'the new folder is untouched');
	// a path that was never opened: the errno, as a real file system answers touch, tee, sort -o
	await fs.mkdir('/w/newdir');
	assert.strictEqual(await code(fs.writeFile('/w/d/never', 'data', 'utf8')), 'ENOENT');
	assert.strictEqual(await code(fs.writeFile('/w/newdir', 'data', 'binary')), 'EISDIR');
	assert.strictEqual(await code(fs.appendFile('/w/nodir/x', 'data', 'utf8')), 'ENOENT');
	// the opening itself is still refused out loud, whatever was opened before
	assert.strictEqual(await code(fs.writeFile('/w/d/f', '', 'binary')), 'ENOENT');
	assert.deepStrictEqual(ov.denied, [], 'a dropped descriptor write is not a refusal by the shell');
	assert.ok(!(await changes(ov)).some((c) => c.kind === 'write'), 'and nothing was written anywhere');
});

test('a policy refusal of a content write is still dropped and recorded after its opening was accepted (a cap is not a missing folder)', async () => {
	const { ov, fs } = setup({}, { caps: { writeFile: 10 } });
	await fs.writeFile('/w/f', '', 'binary');
	await fs.writeFile('/w/f', 'x'.repeat(11), 'utf8');
	assert.deepStrictEqual(ov.denied.map((d) => [d.path, d.reason, d.code]), [['/w/f', 'cap-file', 'EFBIG']]);
});

test('a name with a lone surrogate (the escape of a byte that is not UTF-8) refuses the whole change set, naming it as U+FFFD, and writes nothing', async () => {
	const { ov, fs } = setup({ '/w/keep': 'k' });
	await fs.writeFile('/w/ok.txt', 'fine');
	await fs.writeFile('/w/bad\udcff', 'x');
	await fs.mkdir('/w/dir\udc80z');
	const r = await ov.changes();
	assert.ok(r.refused && r.refused.includes('/w/bad� has a name that is not valid UTF-8'), String(r.refused));
	assert.ok(!/[\ud800-\udfff]/.test(r.refused), 'the reason is text a person can be shown');
	assert.ok(r.changes.every((c) => !/[\udc80-\udcff]/.test(c.path)), 'no path with a lone surrogate is handed over');
	// a pair is a character: an emoji in a name is a name
	const emoji = setup({});
	await emoji.fs.writeFile('/w/😀.txt', 'x');
	const e = await emoji.ov.changes();
	assert.strictEqual(e.refused, null);
	assert.deepStrictEqual(brief(e.changes), ['write /w/😀.txt']);
});

test('opening a file for writing truncates it in the stage; opening for append changes nothing', async () => {
	const { base, ov, fs } = setup({ '/w/f': 'keep me\n', '/w/g': 'also\n' });
	await fs.appendFile('/w/f', '', 'binary');
	await fs.writeFile('/w/g', '', 'binary');
	assert.deepStrictEqual(base.calls.filter((c) => c.startsWith('readFile')), [], 'opening for append does not fetch the file');
	assert.strictEqual(await fs.readFile('/w/f'), 'keep me\n');
	assert.strictEqual(await fs.readFile('/w/g'), '');
	const cs = await changes(ov);
	assert.deepStrictEqual(brief(cs), ['write /w/g']);
	assert.strictEqual(cs[0].after.length, 0);
});

/* ---------------------------------------------------------------------------------------------- removal */

test('removing a folder and making it again leaves it EMPTY: the old files do not come back', async () => {
	const { ov, fs } = setup({ '/w/d/a': '1', '/w/d/sub/b': '2', '/w/keep': 'k' });
	await fs.rm('/w/d', { recursive: true });
	await fs.mkdir('/w/d');
	assert.deepStrictEqual(await fs.readdir('/w/d'), []);
	assert.strictEqual(await fs.exists('/w/d/a'), false);
	assert.strictEqual(await fs.exists('/w/d/sub/b'), false);
	await fs.writeFile('/w/d/new', 'n');
	assert.deepStrictEqual(await fs.readdir('/w/d'), ['new']);
	await fs.mkdir('/w/d/sub');
	assert.deepStrictEqual(await fs.readdir('/w/d/sub'), []);
	// /w/d and /w/d/sub exist before and after: not changes. What was inside is deleted, the deeper file first.
	assert.deepStrictEqual(brief(await changes(ov)), ['write /w/d/new', 'delete /w/d/sub/b via /w/d', 'delete /w/d/a via /w/d']);
});

test('the same holds below a removed folder that came back, and for a file that took the place of a folder\'s name', async () => {
	const { fs } = setup({ '/w/a/b/c/f': '1', '/w/a/b/g': '2' });
	await fs.rm('/w/a', { recursive: true });
	await fs.mkdir('/w/a/b/c', { recursive: true });
	assert.deepStrictEqual(await fs.readdir('/w/a/b'), ['c']);
	assert.deepStrictEqual(await fs.readdir('/w/a/b/c'), []);
	assert.strictEqual(await fs.exists('/w/a/b/g'), false);
});

test('a removed folder expands to its base files in the change set, deepest first, then the folders themselves', async () => {
	const { ov, fs } = setup({ '/w/d/a': '1', '/w/d/s/b': '2', '/w/d/s/t/c': '3', '/w/other': 'o' });
	await fs.rm('/w/d', { recursive: true });
	const cs = await changes(ov);
	assert.deepStrictEqual(brief(cs), ['delete /w/d/s/t/c via /w/d', 'delete /w/d/s/b via /w/d', 'delete /w/d/a via /w/d', 'rmdir /w/d/s/t', 'rmdir /w/d/s', 'rmdir /w/d']);
	assert.deepStrictEqual(dec.decode(cs[0].before), '3');
});

test('create-then-delete is nothing; rewriting with the same bytes is nothing; touching one byte is a change with its before', async () => {
	const { ov, fs } = setup({ '/w/same': 'abc', '/w/diff': 'abc', '/w/gone': 'g' });
	await fs.writeFile('/w/tmp', 'x');
	await fs.rm('/w/tmp');
	await fs.mkdir('/w/tmpdir');
	await fs.writeFile('/w/tmpdir/f', 'y');
	await fs.rm('/w/tmpdir', { recursive: true });
	await fs.writeFile('/w/same', 'abc');
	await fs.appendFile('/w/same', '');
	await fs.writeFile('/w/diff', 'abd');
	const cs = await changes(ov);
	assert.deepStrictEqual(brief(cs), ['write /w/diff']);
	assert.deepStrictEqual([cs[0].existed, dec.decode(cs[0].before), dec.decode(cs[0].after)], [true, 'abc', 'abd']);
});

test('before is read lazily and only for what stays a change; a file over the read cap has before null', async () => {
	const { base, ov, fs } = setup({ '/w/a': 'old', '/w/b': 'same', '/w/c': 'x'.repeat(5000), '/w/gone': 'bye' }, { caps: { readFile: 1000, readRun: 100000 } });
	await fs.writeFile('/w/a', 'new');
	await fs.writeFile('/w/b', 'same');
	await fs.writeFile('/w/c', 'y');
	await fs.rm('/w/gone');
	assert.ok(!base.calls.some((c) => c.startsWith('readFile')), 'nothing was read while the command ran');
	const cs = await changes(ov);
	assert.deepStrictEqual(brief(cs), ['write /w/a', 'write /w/c', 'delete /w/gone']);
	assert.strictEqual(dec.decode(cs[0].before), 'old');
	assert.deepStrictEqual([cs[1].existed, cs[1].before], [true, null]);
	assert.strictEqual(dec.decode(cs[2].before), 'bye');
	assert.ok(!base.calls.includes('readFile /w/c'), 'the big one was never fetched');
});

test('the change set is ordered: new folders, writes, deletes (deepest first), removed folders; and paths carry no /mnt', async () => {
	const { ov, fs } = setup({ '/w/old/x': '1', '/w/old/y/z': '2' });
	await fs.writeFile('/w/b', 'b');
	await fs.mkdir('/w/n/m', { recursive: true });
	await fs.writeFile('/w/n/m/f', 'f');
	await fs.rm('/w/old', { recursive: true });
	const cs = await changes(ov);
	assert.deepStrictEqual(brief(cs), ['mkdir /w/n', 'mkdir /w/n/m', 'write /w/b', 'write /w/n/m/f', 'delete /w/old/y/z via /w/old', 'delete /w/old/x via /w/old', 'rmdir /w/old/y', 'rmdir /w/old']);
});

test('more changes than the entry cap, or a folder and a file swapping places, is refused with the reason (not half a list)', async () => {
	const { ov, fs } = setup({ '/w/d/a': '1', '/w/d/b': '2', '/w/d/c': '3' }, { caps: { entries: 2 } });
	await fs.rm('/w/d', { recursive: true });
	const r = await ov.changes();
	assert.ok(/it would change more than 2 files and folders/.test(String(r.refused)), String(r.refused));
	const t = setup({ '/w/x/f': '1' });
	await t.fs.rm('/w/x', { recursive: true });
	await t.fs.writeFile('/w/x', 'now a file');
	assert.ok(/is a folder and would become a file/.test(String((await t.ov.changes()).refused)));
	const u = setup({ '/w/y': 'file' });
	await u.fs.rm('/w/y');
	await u.fs.mkdir('/w/y');
	assert.ok(/is a file and would become a folder/.test(String((await u.ov.changes()).refused)));
});

test('a directory that only leads to a workspace folder cannot be removed either', async () => {
	const { fs } = setup({ '/a/b/f': 'x' }, { folders: [{ id: 'f', path: '/a/b', name: 'b' }] });
	assert.deepStrictEqual(await fs.readdir('/a'), ['b']);
	assert.strictEqual(await code(fs.rm('/a', { recursive: true })), 'EPERM');
	assert.strictEqual(await code(fs.mv('/a', '/tmp/a')), 'EPERM');
	assert.strictEqual(await fs.exists('/a/b/f'), true);
});

test('a mount root cannot be removed or moved, and says so', async () => {
	const { ov, fs } = setup({ '/w/a': 'x' });
	assert.strictEqual(await code(fs.rm('/w', { recursive: true })), 'EPERM');
	assert.strictEqual(await code(fs.rm('/', { recursive: true })), 'EACCES');
	assert.strictEqual(await code(fs.mv('/w', '/tmp/w')), 'EPERM');
	assert.ok(ov.denied.some((d) => d.reason === 'mount-root'));
	assert.strictEqual(await fs.exists('/w/a'), true);
});

/* ---------------------------------------------------------------------------------------------- copy and move */

test('cp and mv: files and trees, onto and into, with identity for the same-file check', async () => {
	const { ov, fs } = setup({ '/w/a': 'A', '/w/d/x': 'X', '/w/d/s/y': 'Y' });
	await fs.cp('/w/a', '/w/b');
	await fs.cp('/w/d', '/w/d2', { recursive: true });
	assert.strictEqual(await code(fs.cp('/w/d', '/w/d3')), 'EISDIR');
	assert.strictEqual(await code(fs.cp('/w/nope', '/w/z')), 'ENOENT');
	assert.strictEqual(await code(fs.cp('/w/d', '/w/d/in', { recursive: true })), 'EINVAL');
	await fs.mv('/w/b', '/w/c');
	await fs.mv('/w/d2', '/w/d4');
	assert.strictEqual(await fs.exists('/w/b'), false);
	assert.strictEqual(await fs.readFile('/w/d4/s/y'), 'Y');
	assert.strictEqual(await code(fs.mv('/w/nope', '/w/q')), 'ENOENT');
	assert.strictEqual(await code(fs.cp('/w/a', '/w/nodir/a')), 'ENOENT');
	assert.deepStrictEqual(brief(await changes(ov)), ['mkdir /w/d4', 'mkdir /w/d4/s', 'write /w/c', 'write /w/d4/s/y', 'write /w/d4/x']);
});

test('cp into the shell\'s own scratch space works both ways and is never a change', async () => {
	const { ov, fs } = setup({ '/w/a': 'A' });
	await fs.cp('/w/a', '/tmp/a');
	await fs.mkdir('/tmp/dir');
	await fs.writeFile('/tmp/dir/f', 'F');
	await fs.cp('/tmp/dir/f', '/w/from-tmp');
	assert.strictEqual(await fs.readFile('/w/from-tmp'), 'F');
	assert.deepStrictEqual(brief(await changes(ov)), ['write /w/from-tmp']);
	assert.strictEqual(await code(fs.cp('/w/a', '/etc/a')), 'EACCES');
	assert.ok(ov.denied.some((d) => d.path === '/etc/a' && d.reason === 'outside'), 'a refusal the engine may swallow (rm -f) is recorded');
});

/* ---------------------------------------------------------------------------------------------- memory and devices */

test('/tmp and /home/user are memory: writable, listed, never a change; the rest of the shell\'s tree is read-only', async () => {
	const { ov, fs } = setup({});
	await fs.writeFile('/tmp/x', 'tmp');
	await fs.mkdir('/tmp/d/e', { recursive: true });
	await fs.writeFile('/home/user/.bashrc', 'rc');
	await fs.writeFile('/dev/fd/63', 'process substitution');
	assert.deepStrictEqual(await fs.readdir('/tmp'), ['d', 'x']);
	assert.strictEqual(await fs.readFile('/dev/fd/63'), 'process substitution');
	assert.strictEqual(await fs.readFile('/home/user/.bashrc'), 'rc', 'a refused write is dropped and recorded, so what was written has to be there');
	assert.strictEqual(await fs.readFile('/tmp/x'), 'tmp');
	assert.deepStrictEqual(ov.denied, []);
	assert.strictEqual(await code(fs.mkdir('/etc/x')), 'EACCES');
	assert.strictEqual(await code(fs.mkdir('/home/other')), 'EACCES');
	assert.strictEqual(await code(fs.rm('/tmp')), 'EACCES');
	assert.strictEqual(await code(fs.mv('/dev/null', '/tmp/n')), 'EACCES', 'a move takes the source away: nothing outside the scratch space may be moved');
	assert.strictEqual(await fs.exists('/tmp/n'), false, 'and nothing was copied before it said so');
	assert.strictEqual(await code(fs.rm('/usr/bin', { recursive: true })), 'EACCES');
	await fs.rm('/tmp/d', { recursive: true });
	assert.deepStrictEqual(await fs.readdir('/tmp'), ['x']);
	assert.deepStrictEqual(await changes(ov), []);
	assert.ok(ov.denied.some((d) => d.path === '/etc/x' && d.reason === 'outside'));
});

test('the engine\'s own stubs: /bin and /usr/bin files are executable and cannot be written by a command', async () => {
	const { fs } = setup({});
	fs.writeFileSync('/bin/echo', '#!/bin/bash\n# Built-in command: echo\n');
	fs.writeFileSync('/usr/bin/echo', '#!/bin/bash\n# Built-in command: echo\n');
	fs.mkdirSync('/dev/fd', { recursive: true });
	assert.strictEqual((await fs.stat('/usr/bin/echo')).mode, 0o755);
	assert.strictEqual(await fs.exists('/bin/echo'), true);
	assert.deepStrictEqual(await fs.readdir('/bin'), ['echo']);
	assert.strictEqual(await code(fs.writeFile('/bin/echo', '', 'binary')), 'EACCES');
	assert.strictEqual(await code(fs.rm('/bin/echo')), 'EACCES');
});

test('devices: /dev/null swallows and reads empty; /dev/stdout and /dev/stderr are handed to the caller', async () => {
	const { ov, fs } = setup({});
	fs.writeFileSync('/dev/null', '');
	await fs.writeFile('/dev/null', 'gone');
	await fs.appendFile('/dev/null', 'more');
	assert.strictEqual(await fs.readFile('/dev/null'), '');
	assert.strictEqual((await fs.stat('/dev/null')).size, 0);
	await fs.writeFile('/dev/stderr', 'to stderr\n');
	await fs.appendFile('/dev/stdout', 'to stdout\n');
	assert.deepStrictEqual(ov.device, { stdout: 'to stdout\n', stderr: 'to stderr\n' });
	assert.deepStrictEqual(ov.denied, []);
	// the endless ones are a mebibyte here (a file is read whole): enough for head -c N with N up to that
	const zero = await fs.readFileBuffer('/dev/zero');
	assert.deepStrictEqual([zero.length, zero.every((b) => b === 0)], [1 << 20, true]);
	const random = await fs.readFileBuffer('/dev/urandom');
	assert.strictEqual(random.length, 1 << 20);
	assert.ok(random.some((b) => b !== 0));
});

test('memory kept by a session survives a new overlay; a new one starts empty; its bytes count toward the write cap', async () => {
	const memory = createMemory();
	const one = setup({}, { memory });
	await one.fs.writeFile('/tmp/keep', '12345');
	const two = setup({}, { memory, caps: { writeRun: 8 } });
	assert.strictEqual(await two.fs.readFile('/tmp/keep'), '12345');
	await two.fs.writeFile('/tmp/more', '1234');
	assert.strictEqual(two.ov.denied.length, 1, '5 bytes kept + 4 > 8');
	assert.strictEqual(two.ov.denied[0].reason, 'cap-run');
	const fresh = setup({});
	assert.strictEqual(await fresh.fs.exists('/tmp/keep'), false);
});

test('the engine\'s synchronous writes (stubs, /dev, /proc) land in memory and never in the change set', async () => {
	const { ov, fs } = setup({});
	fs.mkdirSync('/proc/self/fd', { recursive: true });
	fs.writeFileSync('/proc/version', 'Linux version');
	fs.writeFileSync('/usr/bin/ls', 'stub');
	assert.strictEqual(await fs.readFile('/proc/version'), 'Linux version');
	assert.deepStrictEqual(await changes(ov), []);
	assert.deepStrictEqual(ov.denied, []);
});

/* ---------------------------------------------------------------------------------------------- staged files below a removed or moved folder */

test('a file written two to four levels below a folder that is then removed does not survive it, and is not in the change set', async () => {
	// base: only the top of the tree; the deeper folders exist in the base too, so nothing staged links them
	const { ov, fs } = setup({ '/w/build/out/deep/old.txt': 'old', '/w/build/keep': 'k', '/w/other/x': 'x' });
	await fs.writeFile('/w/build/out/deep/new.txt', 'new');
	await fs.writeFile('/w/build/out/deep/old.txt', 'changed');
	await fs.mkdir('/w/build/out/deep/sub', { recursive: true });
	await fs.writeFile('/w/build/out/deep/sub/f', 'f');
	await fs.rm('/w/build', { recursive: true });
	assert.strictEqual(await fs.exists('/w/build'), false);
	assert.strictEqual(await fs.exists('/w/build/out/deep/new.txt'), false);
	assert.strictEqual(await code(fs.readFile('/w/build/out/deep/old.txt')), 'ENOENT');
	const cs = brief(await changes(ov));
	assert.ok(cs.every((c) => c.startsWith('delete') || c.startsWith('rmdir')), cs.join(' | '));
	assert.deepStrictEqual(cs, ['delete /w/build/out/deep/old.txt via /w/build', 'delete /w/build/keep via /w/build', 'rmdir /w/build/out/deep', 'rmdir /w/build/out', 'rmdir /w/build']);
	assert.strictEqual(ov.denied.length, 0);
});

test('the same for a folder that is moved: what was staged below it goes with it, once, at the new place', async () => {
	const { ov, fs } = setup({ '/w/pkg/lib/deep/file.js': 'old', '/w/pkg/lib/other.js': 'o' });
	await fs.writeFile('/w/pkg/lib/deep/file.js', 'new');
	await fs.writeFile('/w/pkg/lib/deep/extra.js', 'x');
	await fs.mv('/w/pkg', '/w/pkg2');
	assert.strictEqual(await fs.exists('/w/pkg'), false);
	assert.strictEqual(await fs.readFile('/w/pkg2/lib/deep/file.js'), 'new');
	assert.strictEqual(await fs.readFile('/w/pkg2/lib/deep/extra.js'), 'x');
	const cs = await changes(ov);
	assert.deepStrictEqual(cs.filter((c) => c.kind === 'write').map((c) => c.path), ['/w/pkg2/lib/deep/extra.js', '/w/pkg2/lib/deep/file.js', '/w/pkg2/lib/other.js']);
	assert.ok(!cs.some((c) => c.kind === 'write' && c.path.startsWith('/w/pkg/')), 'nothing is written below what was moved away');
	assert.ok(cs.some((c) => c.kind === 'rmdir' && c.path === '/w/pkg'));
});

test('a folder removed and made again is empty at every depth, and what is staged in it afterwards is listed and read', async () => {
	const { ov, fs } = setup({ '/w/a/b/c/old': '1', '/w/a/b/keep': '2' });
	await fs.writeFile('/w/a/b/c/staged', 's');
	await fs.rm('/w/a', { recursive: true });
	await fs.mkdir('/w/a/b/c', { recursive: true });
	assert.deepStrictEqual(await fs.readdir('/w/a/b'), ['c']);
	assert.deepStrictEqual(await fs.readdir('/w/a/b/c'), []);
	await fs.writeFile('/w/a/b/c/fresh', 'n');
	assert.deepStrictEqual(await fs.readdir('/w/a/b/c'), ['fresh']);
	assert.deepStrictEqual(brief(await changes(ov)).filter((c) => c.startsWith('write')), ['write /w/a/b/c/fresh']);
});

test('removing one staged file leaves its staged siblings and the folders that lead to them listed', async () => {
	const { fs } = setup({ '/w/a/b/c/x': '1' });
	await fs.writeFile('/w/a/b/c/y', 'y');
	await fs.writeFile('/w/a/b/c/z', 'z');
	await fs.rm('/w/a/b/c/y');
	assert.deepStrictEqual(await fs.readdir('/w/a/b/c'), ['x', 'z']);
	await fs.rm('/w/a/b/c/z');
	await fs.rm('/w/a/b/c/x');
	assert.deepStrictEqual(await fs.readdir('/w/a/b/c'), []);
	assert.strictEqual(await fs.exists('/w/a/b/c'), true);
});

/* ---------------------------------------------------------------------------------------------- caps: exactly the limit passes, one over does not */

test('the read cap is on the size: a file of exactly the cap is read, one byte over is refused and never fetched', async () => {
	const { base, ov, fs } = setup({ '/w/at': new Uint8Array(100), '/w/over': new Uint8Array(101) }, { caps: { readFile: 100, readRun: 1000 } });
	assert.strictEqual((await fs.readFileBuffer('/w/at')).length, 100);
	assert.strictEqual(await code(fs.readFileBuffer('/w/over')), 'EFBIG');
	assert.ok(!base.calls.includes('readFile /w/over'));
	assert.ok(ov.notes.some((n) => /"\/w\/over" was NOT read: it is 101 bytes, over the 100 bytes/.test(n)), ov.notes.join('\n'));
});

test('the per-run read cap is on bytes read so far plus the size: exactly the cap is read, one over is refused', async () => {
	const { fs } = setup({ '/w/a': new Uint8Array(60), '/w/b': new Uint8Array(40), '/w/c': new Uint8Array(1) }, { caps: { readFile: 100, readRun: 100 } });
	await fs.readFileBuffer('/w/a');
	await fs.readFileBuffer('/w/b');                                       // 60 + 40 = 100: at the cap
	assert.strictEqual(await code(fs.readFileBuffer('/w/c')), 'EFBIG');     // 100 + 1
});

test('the write caps: a file of exactly the cap is written, one byte over is dropped; the same for a run, and for entries', async () => {
	const a = setup({}, { caps: { writeFile: 10, writeRun: 100, entries: 100 } });
	await a.fs.writeFile('/w/at', '0123456789');
	await a.fs.writeFile('/w/over', '0123456789A');
	assert.deepStrictEqual(a.ov.denied.map((d) => [d.path, d.reason]), [['/w/over', 'cap-file']]);
	assert.strictEqual((await changes(a.ov)).length, 1);
	const b = setup({}, { caps: { writeFile: 100, writeRun: 10, entries: 100 } });
	await b.fs.writeFile('/w/a', '01234');
	await b.fs.writeFile('/w/b', '01234');                                 // 5 + 5 = 10: at the cap
	await b.fs.writeFile('/w/c', '0');                                      // 11
	assert.deepStrictEqual(b.ov.denied.map((d) => [d.path, d.reason]), [['/w/c', 'cap-run']]);
	const c = setup({}, { caps: { writeFile: 100, writeRun: 100, entries: 3 } });
	await c.fs.writeFile('/w/a', '');
	await c.fs.mkdir('/w/d');
	await c.fs.writeFile('/w/b', '');                                       // 3 entries: at the cap
	await c.fs.writeFile('/w/c', '');
	await c.fs.writeFile('/w/a', 'again');                                   // an existing entry is not a new one
	assert.deepStrictEqual(c.ov.denied.map((d) => [d.path, d.reason]), [['/w/c', 'cap-entries']]);
});

test('the change set has at most `entries` entries, deletions and folders included: the cap itself passes, one over is refused whole', async () => {
	const files = {};
	for (let i = 0; i < 5; i++) { files['/w/d/f' + i] = String(i); }
	// rm -rf d: five deletes and one rmdir = 6 entries
	const at = setup(files, { caps: { entries: 6 } });
	await at.fs.rm('/w/d', { recursive: true });
	const ok = await at.ov.changes();
	assert.strictEqual(ok.refused, null, String(ok.refused));
	assert.strictEqual(ok.changes.length, 6);
	const over = setup(files, { caps: { entries: 5 } });
	await over.fs.rm('/w/d', { recursive: true });
	const no = await over.ov.changes();
	assert.ok(/more than 5 files and folders/.test(String(no.refused)), String(no.refused));
	// removals of single files are counted the same way as writes
	const many = setup(files, { caps: { entries: 5 } });
	for (let i = 0; i < 5; i++) { await many.fs.rm('/w/d/f' + i); }
	assert.strictEqual((await many.ov.changes()).refused, null);
	const one = setup(Object.assign({ '/w/d/f5': '5' }, files), { caps: { entries: 5 } });
	for (let i = 0; i < 6; i++) { await one.fs.rm('/w/d/f' + i); }
	assert.ok(/more than 5/.test(String((await one.ov.changes()).refused)));
});

test('caps from the host are numbers above zero or the default: undefined, NaN, a string, zero and a negative one are not limits', async () => {
	const dflt = Object.assign({}, DEFAULT_CAPS);
	assert.deepStrictEqual(validCaps(undefined), dflt);
	assert.deepStrictEqual(validCaps(null), dflt);
	assert.deepStrictEqual(validCaps('big'), dflt);
	assert.deepStrictEqual(validCaps({ readFile: undefined, readRun: NaN, writeFile: '5', writeRun: 0, entries: -3 }), dflt);
	assert.deepStrictEqual(validCaps({ readFile: Infinity }), dflt);
	assert.deepStrictEqual(validCaps({ readFile: 7, entries: 9, unknown: 1 }), Object.assign({}, dflt, { readFile: 7, entries: 9 }));
	// and the overlay enforces what is left
	const { ov, fs } = setup({}, { caps: { writeFile: NaN, writeRun: undefined, entries: '2' } });
	assert.deepStrictEqual(ov.caps, dflt);
	await fs.writeFile('/w/big', 'x'.repeat(DEFAULT_CAPS.writeFile + 1));
	assert.strictEqual(ov.denied.length, 1);
});

/* ---------------------------------------------------------------------------------------------- what is remembered, and said */

test('a refusal is recorded once per path, operation and reason, however often the command tries; notes stop at twenty', async () => {
	const { ov, fs } = setup({}, { caps: { writeFile: 4 } });
	for (let i = 0; i < 50; i++) { await fs.appendFile('/w/log', 'line ' + i + '\n'); }
	assert.strictEqual(ov.denied.length, 1, JSON.stringify(ov.denied));
	assert.deepStrictEqual([ov.denied[0].path, ov.denied[0].op, ov.denied[0].reason], ['/w/log', 'append', 'cap-file']);
	await fs.writeFile('/w/log', 'long line');
	assert.deepStrictEqual(ov.denied.map((d) => d.op), ['append', 'write'], 'another operation is another record');
	// notes: twenty distinct ones at most (a note is said once for what it says)
	const many = setup({}, {});
	for (let i = 0; i < 40; i++) { await many.fs.writeFile('/etc/file' + i, 'x', undefined).catch(() => { /* a drop, not a throw */ }); }
	assert.strictEqual(many.ov.notes.length, 20, many.ov.notes.length + ' notes');
	assert.strictEqual(new Set(many.ov.notes).size, 20);
});

test('a note is said once however often the command trips over the same thing', async () => {
	const { ov, fs } = setup({ '/w/big': new Uint8Array(500), '/w/d': null }, { caps: { readFile: 100 } });
	for (let i = 0; i < 5; i++) { await fs.readFileBuffer('/w/big').catch(() => { /* refused */ }); }
	for (let i = 0; i < 5; i++) { await fs.readFileBuffer('/w/d').catch(() => { /* a directory */ }); }
	assert.strictEqual(ov.notes.length, 2, ov.notes.join('\n'));
	assert.ok(/"\/w\/big" was NOT read/.test(ov.notes[0]) && /"\/w\/d" is a directory/.test(ov.notes[1]));
});

test('memory bytes follow every write, append, overwrite and removal (they count toward the write cap of the next run)', async () => {
	const { ov, fs } = setup({});
	const m = ov.memory;
	const start = m.bytes;
	await fs.writeFile('/tmp/f', '12345');
	assert.strictEqual(m.bytes - start, 5);
	await fs.appendFile('/tmp/f', '678');
	assert.strictEqual(m.bytes - start, 8);
	await fs.writeFile('/tmp/f', '12');
	assert.strictEqual(m.bytes - start, 2, 'an overwrite replaces what was there');
	await fs.writeFile('/tmp/g', 'abc');
	await fs.mkdir('/tmp/d');
	await fs.writeFile('/tmp/d/h', 'wxyz');
	assert.strictEqual(m.bytes - start, 9);
	await fs.rm('/tmp/g');
	assert.strictEqual(m.bytes - start, 6);
	await fs.rm('/tmp/d', { recursive: true });
	assert.strictEqual(m.bytes - start, 2);
	await fs.rm('/tmp/f');
	assert.strictEqual(m.bytes - start, 0);
	// moved and copied inside memory
	await fs.writeFile('/tmp/a', 'xxxx');
	await fs.cp('/tmp/a', '/tmp/b');
	assert.strictEqual(m.bytes - start, 8);
	await fs.mv('/tmp/a', '/tmp/c');
	assert.strictEqual(m.bytes - start, 8);
	assert.strictEqual(m.countFiles('/tmp'), 2);
	assert.strictEqual(m.countFiles('/tmp/b'), 1);
	assert.strictEqual(m.countFiles('/home/user'), 0);
});

/* ---------------------------------------------------------------------------------------------- where folders are mounted */

test('a folder that contains an earlier one is relocated too (the overlap is checked both ways)', () => {
	const inside = planMounts([{ id: '1', path: '/a/b', name: 'b' }, { id: '2', path: '/a', name: 'a' }]);
	assert.deepStrictEqual(inside.map((m) => [m.id, m.at, m.relocated]), [['1', '/a/b', false], ['2', '/mnt/a', true]]);
	assert.ok(/overlaps/.test(inside[1].reason || ''));
	const around = planMounts([{ id: '1', path: '/a', name: 'a' }, { id: '2', path: '/a/b', name: 'b' }]);
	assert.deepStrictEqual(around.map((m) => [m.id, m.at, m.relocated]), [['1', '/a', false], ['2', '/mnt/b', true]]);
	const same = planMounts([{ id: '1', path: '/a', name: 'a' }, { id: '2', path: '/a', name: 'a' }]);
	assert.deepStrictEqual(same.map((m) => m.at), ['/a', '/mnt/a']);
	// a sibling with the same prefix is not inside it
	const sibling = planMounts([{ id: '1', path: '/a', name: 'a' }, { id: '2', path: '/ab', name: 'ab' }]);
	assert.deepStrictEqual(sibling.map((m) => m.relocated), [false, false]);
});

test('/proc is the shell\'s own, and a name that starts with a dot or has odd characters is made safe for /mnt', () => {
	const plan = planMounts([
		{ id: '1', path: '/proc/x', name: 'x' },
		{ id: '2', path: '/', name: '..' },
		{ id: '3', path: '/dev/w', name: '.hidden' },
		{ id: '4', path: '/tmp/a', name: 'my project (2)' },
		{ id: '5', path: '/usr', name: '' },
	]);
	assert.deepStrictEqual(plan.map((m) => m.at), ['/mnt/x', '/mnt/_', '/mnt/_hidden', '/mnt/my_project_2_', '/mnt/usr']);
	assert.ok(plan.every((m) => m.relocated));
	assert.ok(plan.every((m) => m.at.split('/').length === 3 && !m.at.slice(5).includes('..')));
});

test('a folder rooted at /mnt does not hang the search for a free name: the others go to /lc-mnt (bounded, whatever the names)', () => {
	const t0 = Date.now();
	const plan = planMounts([
		{ id: '1', path: '/mnt', name: 'mnt' },
		{ id: '2', path: '/', name: 'root' },
		{ id: '3', path: '/tmp', name: 'tmp' },
		{ id: '4', path: '/tmp/x', name: 'mnt' },
		{ id: '5', path: '/lc-mnt', name: 'lc' },
	]);
	assert.ok(Date.now() - t0 < 500, 'it ended');
	assert.deepStrictEqual(plan.map((m) => [m.id, m.at]), [['1', '/mnt'], ['2', '/lc-mnt-2/root'], ['3', '/lc-mnt-2/tmp'], ['4', '/lc-mnt-2/mnt'], ['5', '/lc-mnt']]);
	// two folders called mnt, and the same name five times: distinct names under /mnt
	const same = planMounts([{ id: 'a', path: '/', name: 'mnt' }, { id: 'b', path: '/tmp', name: 'mnt' }, { id: 'c', path: '/home', name: 'mnt' }]);
	assert.deepStrictEqual(same.map((m) => m.at), ['/mnt/mnt', '/mnt/mnt-2', '/mnt/mnt-3']);
	// every mount is distinct and none is inside another (the invariant, for a pile of awkward input)
	const pile = [];
	for (let i = 0; i < 40; i++) { pile.push({ id: 'p' + i, path: ['/', '/mnt', '/mnt/x', '/tmp', '/lc-mnt', '/a', '/a/b'][i % 7], name: ['mnt', 'x', '', '..', 'lc-mnt'][i % 5] }); }
	const out = planMounts(pile);
	assert.strictEqual(out.length, 40);
	const ats = out.map((m) => m.at);
	assert.strictEqual(new Set(ats).size, 40, 'distinct');
	for (const a of ats) { for (const b of ats) { assert.ok(a === b || !a.startsWith(b + '/'), `${a} is inside ${b}`); } }
});

/* ---------------------------------------------------------------------------------------------- what is executable */

test('a script is a file that starts with a shebang naming a shell: env forms, a space after #!, CRLF, the size bound', async () => {
	const yes = ['#!/bin/sh\n', '#!/usr/bin/env bash\n', '#!/usr/bin/env -S bash\n', '#!/usr/bin/env -S bash -e\n', '#! /bin/sh\n', '#!/bin/bash\r\n', '#!/bin/sh', '#!/usr/bin/env bash -x\necho\n', '#!/bin/dash\n', '#!/usr/bin/zsh\n'];
	const no = ['#!/usr/bin/env node\n', '#!/usr/bin/env -S node --flag\n', '#!/usr/bin/python3\n', '# !/bin/sh\n', '#!\n', '#!/usr/bin/env\n', 'echo hi\n', '', '#', '#!/usr/bin/envbash\n'];
	for (const t of yes) { assert.strictEqual(isShellScript(enc.encode(t)), true, JSON.stringify(t)); }
	for (const t of no) { assert.strictEqual(isShellScript(enc.encode(t)), false, JSON.stringify(t)); }
	assert.strictEqual(isShellScript(enc.encode('#!/bin/sh' + ' '.repeat(300) + '\n')), true, 'a long first line is still bash');
	assert.strictEqual(isShellScript(enc.encode('#!' + 'x'.repeat(300) + '/sh\n')), false);
	// the size bound: a probe reads files up to 32 KiB, not one byte more
	const head = '#!/bin/sh\n';
	const files = {
		'/w/at': head + 'x'.repeat(32 * 1024 - head.length),
		'/w/over': head + 'x'.repeat(32 * 1024 + 1 - head.length),
		'/w/one': '#',
		'/w/two': '#!',
	};
	const { fs } = setup(files);
	assert.strictEqual((await fs.stat('/w/at')).size, 32768);
	assert.strictEqual((await fs.stat('/w/at')).mode, 0o755);
	assert.strictEqual((await fs.stat('/w/over')).size, 32769);
	assert.strictEqual((await fs.stat('/w/over')).mode, 0o644);
	assert.strictEqual((await fs.stat('/w/one')).mode, 0o644, 'a file of one byte is never probed');
	assert.strictEqual((await fs.stat('/w/two')).mode, 0o644, '"#!" alone names no shell');
});

/* ---------------------------------------------------------------------------------------------- mv, rm and mkdir in the memory areas */

test('mv carries a mode set with chmod, for a file and for everything below a folder; a file keeps its modification time', async () => {
	const { fs } = setup({ '/w/a': 'x', '/w/d/f': 'y', '/w/d/sub/g': 'z' });
	await fs.chmod('/w/a', 0o600);
	await fs.chmod('/w/d/f', 0o700);
	await fs.chmod('/w/d/sub', 0o711);
	await fs.utimes('/w/a', new Date(0), new Date(1234000));
	await fs.mv('/w/a', '/w/b');
	assert.strictEqual((await fs.stat('/w/b')).mode, 0o600);
	assert.strictEqual(+(await fs.stat('/w/b')).mtime, 1234000, 'rename keeps the time');
	await fs.mv('/w/d', '/w/e');
	assert.strictEqual((await fs.stat('/w/e/f')).mode, 0o700);
	assert.strictEqual((await fs.stat('/w/e/sub')).mode, 0o711);
	assert.strictEqual((await fs.stat('/w/e/sub/g')).mode, 0o644);
	assert.strictEqual(await code(fs.stat('/w/d/f')), 'ENOENT');
	// memory areas too
	await fs.writeFile('/tmp/t', 'x');
	await fs.chmod('/tmp/t', 0o640);
	await fs.mv('/tmp/t', '/tmp/u');
	assert.strictEqual((await fs.stat('/tmp/u')).mode, 0o640);
});

test('the process-substitution directory cannot be removed, its files can; mkdir -p through a file in /tmp is ENOTDIR', async () => {
	const { fs } = setup({});
	await fs.writeFile('/dev/fd/63', 'p');
	assert.strictEqual(await code(fs.rm('/dev/fd', { recursive: true })), 'EACCES');
	assert.strictEqual(await code(fs.rm('/dev/fd')), 'EACCES');
	await fs.rm('/dev/fd/63');
	assert.strictEqual(await fs.exists('/dev/fd/63'), false);
	assert.strictEqual(await fs.exists('/dev/fd'), true);
	await fs.writeFile('/tmp/file', 'x');
	assert.strictEqual(await code(fs.mkdir('/tmp/file/x', { recursive: true })), 'ENOTDIR');
	assert.strictEqual(await code(fs.mkdir('/tmp/file/x/y', { recursive: true })), 'ENOTDIR');
	assert.strictEqual(await code(fs.mkdir('/tmp/file/x')), 'ENOENT');
	assert.strictEqual(await fs.exists('/tmp/file/x'), false);
	await fs.mkdir('/tmp/d/e/f', { recursive: true });
	assert.strictEqual(await fs.exists('/tmp/d/e/f'), true);
});

/* ---------------------------------------------------------------------------------------------- bytes that are not UTF-8 */

test('a file that is not valid UTF-8 read as text and written back is the same bytes (and so is a BOM and a NUL)', async () => {
	const samples = {
		latin1: [0x63, 0x61, 0x66, 0xe9, 0x0a],
		png: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d],
		bom: [0xef, 0xbb, 0xbf, 0x68, 0x69, 0x0a],
		nul: [0x61, 0, 0x62, 0x0a],
		mixed: [0xc3, 0xa9, 0xff, 0xe2, 0x82, 0xac, 0xe2, 0x82, 0x0a],
		surrogate: [0xed, 0xa0, 0x80, 0x0a],
		overlong: [0xc0, 0x80, 0xe0, 0x80, 0x80, 0xf0, 0x80, 0x80, 0x80],
		toobig: [0xf4, 0x90, 0x80, 0x80, 0xf5, 0x80],
		truncated: [0xf0, 0x9f, 0x98],
		astral: [0xf0, 0x9f, 0x98, 0x80, 0x0a],
	};
	for (const [name, bytes] of Object.entries(samples)) {
		const { ov, fs } = setup({ ['/w/' + name]: Uint8Array.from(bytes) });
		const text = await fs.readFile('/w/' + name);
		assert.strictEqual(typeof text, 'string');
		await fs.writeFile('/w/' + name, text);
		assert.deepStrictEqual(await changes(ov), [], name + ': writing the text back is not a change');
		await fs.writeFile('/w/copy-' + name, text);
		assert.deepStrictEqual([...await fs.readFileBuffer('/w/copy-' + name)], bytes, name);
	}
	// what is valid is exactly what TextDecoder says; only the bytes that are not become escapes
	const { fs } = setup({ '/w/ok': enc.encode('héllo ✓ 😀\n'), '/w/bad': Uint8Array.from([0x61, 0xff, 0x62]) });
	assert.strictEqual(await fs.readFile('/w/ok'), 'héllo ✓ 😀\n');
	assert.strictEqual(await fs.readFile('/w/bad'), 'a\udcffb');
	assert.strictEqual(await fs.readFile('/w/bom-less'.replace('bom-less', 'ok'), 'utf8'), 'héllo ✓ 😀\n');
});

test('every encoding of a write: utf8 (default, named, in an object), binary, latin1, base64, hex', async () => {
	const { fs } = setup({});
	await fs.writeFile('/w/u', 'é');
	await fs.writeFile('/w/u2', 'é', 'utf8');
	await fs.writeFile('/w/u3', 'é', { encoding: 'utf-8' });
	await fs.writeFile('/w/b', '\u00e9\u0100', 'binary');
	await fs.writeFile('/w/l', 'é', 'latin1');
	await fs.writeFile('/w/b64', '/+Dg', 'base64');
	await fs.writeFile('/w/hex', 'c3a9ff', 'hex');
	await fs.writeFile('/w/lone', 'a\udcffb\ud800c');
	const bytes = async (p) => [...await fs.readFileBuffer(p)];
	assert.deepStrictEqual(await bytes('/w/u'), [0xc3, 0xa9]);
	assert.deepStrictEqual(await bytes('/w/u2'), [0xc3, 0xa9]);
	assert.deepStrictEqual(await bytes('/w/u3'), [0xc3, 0xa9]);
	assert.deepStrictEqual(await bytes('/w/b'), [0xe9, 0x00], 'binary is the low byte of each character');
	assert.deepStrictEqual(await bytes('/w/l'), [0xe9]);
	assert.deepStrictEqual(await bytes('/w/b64'), [0xff, 0xe0, 0xe0]);
	assert.deepStrictEqual(await bytes('/w/hex'), [0xc3, 0xa9, 0xff]);
	assert.deepStrictEqual(await bytes('/w/lone'), [0x61, 0xff, 0x62, 0xef, 0xbf, 0xbd, 0x63], 'an escape is its byte, any other lone surrogate is U+FFFD');
	assert.strictEqual(await fs.readFile('/w/hex', 'hex'), 'c3a9ff');
	assert.strictEqual(await fs.readFile('/w/b64', 'base64'), '/+Dg');
});

/* ---------------------------------------------------------------------------------------------- a base that fails */

test('an unlistable folder below a removed one makes the set refused (what removing it takes with it is not known)', async () => {
	const tree = makeTree({ '/w': null, '/w/d/a.txt': 'a', '/w/d/sub/f.txt': 'f' });
	const base = baseOf(tree);
	const failing = Object.assign({}, base, {
		async readDir(p) { if (p === '/w/d/sub') { throw Object.assign(new Error('no permission'), { code: 'EACCES' }); } return base.readDir(p); },
	});
	const ov = createOverlay({ folders: [{ id: 'f', path: '/w', name: 'w' }], base: failing });
	await ov.fs.writeFile('/w/ok.txt', 'ok');
	await ov.fs.rm('/w/d', { recursive: true });
	const r = await ov.changes();
	assert.ok(/"?\/w\/d\/sub"? could not be listed, so what removing \/w\/d takes with it is not known/.test(String(r.refused)) || /\/w\/d\/sub could not be listed/.test(String(r.refused)), String(r.refused));
	assert.ok(ov.notes.some((n) => /could not be listed: the editor answered EACCES/.test(n)), ov.notes.join('\n'));
});

test('a base that fails while the change set is worked out is refused with a reason; changes() never throws', async () => {
	const tree = makeTree({ '/w': null, '/w/d/a.txt': 'a', '/w/d/f.txt': 'f' });
	const base = baseOf(tree);
	const failing = Object.assign({}, base, {
		async stat(p) { if (p === '/w/d/f.txt') { throw Object.assign(new Error('input/output error'), { code: 'EIO' }); } return base.stat(p); },
	});
	const ov = createOverlay({ folders: [{ id: 'f', path: '/w', name: 'w' }], base: failing });
	await ov.fs.rm('/w/d', { recursive: true });
	let r;
	await assert.doesNotReject(async () => { r = await ov.changes(); });
	assert.deepStrictEqual(r.changes, []);
	assert.ok(/the editor could not be read while the changes were worked out \(/.test(String(r.refused)), String(r.refused));
	assert.ok(!/^EIO: /.test(String(r.refused)));
});

/* ---------------------------------------------------------------------------------------------- run */

(async () => {
	for (const t of tests) {
		await t.fn();
		console.log('  ok - ' + t.name);
	}
	console.log(`\n${tests.length} tests passed`);
	void DEFAULT_CAPS;
})().catch((e) => { console.error(e); process.exit(1); });
