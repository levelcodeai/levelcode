/*---------------------------------------------------------------------------------------------
 *  web/shell/src/commit.js - run: node web/test/unit/shell-commit.test.js
 *
 *  A run's change set, written to the workspace for the visitor's own terminal. The module is pure (every file
 *  system call is injected), so this runs against a Map. What is pinned:
 *    - the whole set is judged before anything is written: outside a folder, over a cap, malformed, or no longer
 *      what the command read means NOTHING is applied and every reason is listed;
 *    - the order cannot lose data: folders, files, deletes deepest first, folders removed deepest first;
 *    - a failure part-way stops there and is reported as "applied N of M", not as success and not as nothing.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

// A promise that never settles ends the process with status 0 and no output: a suite that did not finish fails.
let finished = false;
process.on('exit', (code) => { if (!finished && code === 0) { console.error('not ok - the tests did not finish'); process.exitCode = 1; } });

const assert = require('assert');
const path = require('path');

const { commitChanges, checkChangeSet } = require(path.join(__dirname, '..', '..', 'shell', 'src', 'commit.js'));

const te = new TextEncoder();
const bytes = (/** @type {string} */ s) => te.encode(s);

/**
 * A disk and the calls made on it. Only /w (and /v) are workspace folders; a path elsewhere does not resolve.
 * @param {Record<string, string|null>} files  path -> text, or null for a folder
 */
function disk(files) {
	/** @type {Map<string, { dir: boolean, data: Uint8Array }>} */ const nodes = new Map();
	for (const [p, v] of Object.entries(files)) { nodes.set(p, { dir: v === null, data: v === null ? new Uint8Array(0) : bytes(v) }); }
	/** @type {string[]} */ const calls = [];
	/** @type {{ [op: string]: (p: string) => string|null }} */ const failing = {};
	const inFolder = (/** @type {string} */ p) => /^\/(w|v)(\/|$)/.test(p);
	const guard = (/** @type {string} */ op, /** @type {string} */ p) => { const f = failing[op]; const why = f && f(p); if (why) { throw new Error(why); } };
	const io = {
		resolve: (/** @type {string} */ p) => (inFolder(p) ? p : null),
		async stat(/** @type {string} */ p) { calls.push('stat ' + p); guard('stat', p); const n = nodes.get(p); return n ? { isDirectory: n.dir, size: n.data.length } : null; },
		async readFile(/** @type {string} */ p) { calls.push('readFile ' + p); guard('readFile', p); const n = nodes.get(p); if (!n) { throw new Error('missing ' + p); } return n.data; },
		async writeFile(/** @type {string} */ p, /** @type {Uint8Array} */ b) { calls.push('write ' + p); guard('write', p); nodes.set(p, { dir: false, data: b.slice() }); },
		async createDirectory(/** @type {string} */ p) { calls.push('mkdir ' + p); guard('mkdir', p); nodes.set(p, { dir: true, data: new Uint8Array(0) }); },
		async remove(/** @type {string} */ p) {
			calls.push('remove ' + p); guard('remove', p);
			if ([...nodes.keys()].some((k) => k.startsWith(p + '/'))) { throw new Error('not empty: ' + p); }
			nodes.delete(p);
		},
	};
	return {
		io, calls, failing, nodes,
		text: (/** @type {string} */ p) => { const n = nodes.get(p); return n ? Buffer.from(n.data).toString('utf8') : null; },
		writes: () => calls.filter((c) => /^(write|mkdir|remove) /.test(c)),
	};
}

const CAPS = { writeFile: 1000, writeRun: 5000, entries: 10 };
/** @param {string} p @param {string} after @param {string|null} [before] */
const write = (p, after, before) => ({
	kind: /** @type {const} */ ('write'), path: p, existed: before !== undefined && before !== null, before: before === undefined || before === null ? null : bytes(before), after: bytes(after),
});
/** @param {string} p @param {string|null} before @param {string} [viaDir] */
const del = (p, before, viaDir) => ({ kind: /** @type {const} */ ('delete'), path: p, before: before === null ? null : bytes(before), ...(viaDir ? { viaDir } : {}) });
const mkdir = (/** @type {string} */ p) => ({ kind: /** @type {const} */ ('mkdir'), path: p });
const rmdir = (/** @type {string} */ p) => ({ kind: /** @type {const} */ ('rmdir'), path: p });

let n = 0;
async function test(/** @type {string} */ name, /** @type {() => Promise<void>} */ fn) { await fn(); n++; console.log('  ok - ' + name); }

(async () => {
	/* ----- applying ------------------------------------------------------------------------- */

	await test('a plain set is applied: new file, overwrite, delete, and says nothing', async () => {
		const d = disk({ '/w': null, '/w/a.txt': 'old', '/w/gone.txt': 'bye' });
		const r = await commitChanges([write('/w/a.txt', 'new', 'old'), write('/w/b.txt', 'fresh', null), del('/w/gone.txt', 'bye')], d.io, CAPS);
		assert.deepStrictEqual({ total: r.total, applied: r.applied, failed: r.failed, refused: r.refused, notes: r.notes }, { total: 3, applied: 3, failed: 0, refused: false, notes: [] });
		assert.strictEqual(d.text('/w/a.txt'), 'new');
		assert.strictEqual(d.text('/w/b.txt'), 'fresh');
		assert.strictEqual(d.text('/w/gone.txt'), null);
	});

	await test('the order is folders, files, deletes deepest first, folders removed deepest first', async () => {
		const d = disk({ '/w': null, '/w/old': null, '/w/old/sub': null, '/w/old/sub/x.txt': 'x', '/w/old/y.txt': 'y', '/w/keep.txt': 'k' });
		await commitChanges([
			rmdir('/w/old'), rmdir('/w/old/sub'), del('/w/old/y.txt', 'y', '/w/old'), del('/w/old/sub/x.txt', 'x', '/w/old'),
			write('/w/new/deep/f.txt', 'f', null), mkdir('/w/new'), mkdir('/w/new/deep'), write('/w/keep.txt', 'k2', 'k'),
		], d.io, CAPS);
		assert.deepStrictEqual(d.writes(), [
			'mkdir /w/new', 'mkdir /w/new/deep',
			'write /w/keep.txt', 'write /w/new/deep/f.txt',
			'remove /w/old/sub/x.txt', 'remove /w/old/y.txt',
			'remove /w/old/sub', 'remove /w/old',
		]);
		assert.strictEqual(d.nodes.has('/w/old'), false);
	});

	await test('a write into a folder that is not there makes the folder first; one that is there is left alone', async () => {
		const d = disk({ '/w': null, '/w/src': null });
		await commitChanges([write('/w/src/a.js', 'a', null), write('/w/lib/b.js', 'b', null)], d.io, CAPS);
		const made = d.calls.filter((c) => c.startsWith('mkdir '));
		assert.deepStrictEqual(made, ['mkdir /w/lib'], 'src existed (stat), /w is the mount root (stat); only lib is made');
	});

	await test('mkdir of a folder that exists is not an error and is counted as done', async () => {
		const d = disk({ '/w': null, '/w/d': null });
		const r = await commitChanges([mkdir('/w/d')], d.io, CAPS);
		assert.strictEqual(r.applied, 1);
		assert.deepStrictEqual(d.calls.filter((c) => c.startsWith('mkdir ')), []);
	});

	await test('rmdir of a folder that is already gone is a no-op; rmdir of one that has gained a file fails honestly', async () => {
		const d = disk({ '/w': null, '/w/full': null, '/w/full/late.txt': 'x' });
		let r = await commitChanges([rmdir('/w/absent')], d.io, CAPS);
		assert.strictEqual(r.applied, 1);
		r = await commitChanges([rmdir('/w/full')], d.io, CAPS);
		assert.strictEqual(r.applied, 0);
		assert.strictEqual(r.failed, 1);
		assert.ok(/applied 0 of 1/.test(r.notes[0]) && /\/w\/full/.test(r.notes[0]), r.notes[0]);
		assert.strictEqual(d.text('/w/full/late.txt'), 'x');
	});

	await test('an empty change set is nothing: no calls, no notes', async () => {
		const d = disk({ '/w': null });
		const r = await commitChanges([], d.io, CAPS);
		assert.deepStrictEqual(r, { total: 0, applied: 0, failed: 0, refused: false, notes: [] });
		assert.deepStrictEqual(d.calls, []);
	});

	/* ----- refusing the whole set -------------------------------------------------------------- */

	await test('a path in no workspace folder refuses the whole set: the good change beside it is not applied', async () => {
		const d = disk({ '/w': null, '/etc': null });
		const r = await commitChanges([write('/w/ok.txt', 'ok', null), write('/etc/passwd', 'x', null)], d.io, CAPS);
		assert.strictEqual(r.refused, true);
		assert.strictEqual(r.applied, 0);
		assert.strictEqual(r.failed, 2);
		assert.deepStrictEqual(d.writes(), []);
		assert.ok(r.notes.some((t) => /\/etc\/passwd is outside the workspace folders/.test(t)), r.notes.join('\n'));
		assert.ok(/NONE of this command's file changes were applied/.test(r.notes[r.notes.length - 1]));
	});

	await test('a path that is not normal is refused, not resolved: ../, ./, //, relative, trailing slash', async () => {
		const d = disk({ '/w': null, '/w/a': null });
		for (const p of ['/w/../etc/x', '/w/./x', '/w//x', 'w/x', '/w/dir/', '/w/a/../b']) {
			const r = await commitChanges([write(p, 'x', null)], d.io, CAPS);
			assert.strictEqual(r.refused, true, p);
			assert.ok(/not a normal absolute path/.test(r.notes[0]), p + ' -> ' + r.notes[0]);
		}
		assert.deepStrictEqual(d.writes(), []);
	});

	await test('the same path twice, and a malformed entry, refuse the set; nothing the engine sends can make it throw', async () => {
		const d = disk({ '/w': null });
		const bad = [
			[write('/w/a', '1', null), write('/w/a', '2', null)],
			[null], [{ kind: 'chmod', path: '/w/a' }], [{ kind: 'write', path: '/w/a' }], [{ kind: 'write', path: 5 }],
			[{ kind: 'write', path: '/w/a', existed: 'yes', before: null, after: bytes('x') }],
			[{ kind: 'write', path: '/w/a', existed: false, before: 'text', after: bytes('x') }],
			[{ kind: 'delete', path: '/w/a', before: 7 }],
		];
		for (const set of bad) {
			let r;
			await assert.doesNotReject(async () => { r = await commitChanges(/** @type {any} */ (set), d.io, CAPS); });
			assert.strictEqual(/** @type {any} */ (r).refused, true, JSON.stringify(set));
		}
		const dup = await commitChanges([write('/w/a', '1', null), write('/w/a', '2', null)], d.io, CAPS);
		assert.ok(/\/w\/a appears twice in the change set/.test(dup.notes[0]) && !/letter case/.test(dup.notes[0]), dup.notes[0]);
		const notAList = await commitChanges(/** @type {any} */ ({ length: 1 }), d.io, CAPS);
		assert.strictEqual(notAList.refused, true);
		assert.deepStrictEqual(d.writes(), []);
	});

	await test('a rename that only changes case is refused, not applied as "write the new name, delete the old" (which deletes the file on a disk that ignores case)', async () => {
		const d = disk({ '/w': null, '/w/readme.md': 'text' });
		const r = await commitChanges([write('/w/README.md', 'text', null), del('/w/readme.md', 'text')], d.io, CAPS);
		assert.strictEqual(r.refused, true);
		assert.ok(/\/w\/(readme\.md differs from \/w\/README\.md|README\.md differs from \/w\/readme\.md) only in letter case/.test(r.notes[0]), r.notes[0]);
		assert.deepStrictEqual(d.writes(), []);
		assert.strictEqual(d.text('/w/readme.md'), 'text');
	});

	await test('two paths that differ only in case or in the way an accent is written are one path to a disk that ignores case', async () => {
		const d = disk({ '/w': null });
		for (const [a, b] of [['/w/a.txt', '/w/A.txt'], ['/w/caf\u{E9}', '/w/cafe\u{301}'], ['/w/Dir', '/w/dir']]) {
			const r = await commitChanges([mkdir(a), mkdir(b)], d.io, CAPS);
			assert.strictEqual(r.refused, true, a + ' ' + b);
		}
		const fine = await commitChanges([write('/w/a/x.txt', '1', null), write('/w/b/x.txt', '2', null), write('/w/a.txt', '3', null), write('/w/a.txt.bak', '4', null)], d.io, CAPS);
		assert.strictEqual(fine.refused, false, 'different directories and different names are different');
	});

	await test('caps: one file, the whole run, and the number of entries; the cap itself is allowed', async () => {
		const d = disk({ '/w': null });
		const exact = 'x'.repeat(1000);
		assert.strictEqual((await commitChanges([write('/w/a', exact, null)], d.io, CAPS)).refused, false, 'exactly the per-file cap');
		let r = await commitChanges([write('/w/b', exact + 'x', null)], d.io, CAPS);
		assert.ok(r.refused && /1001 bytes; at most 1000 per file/.test(r.notes[0]), r.notes[0]);
		const six = [1, 2, 3, 4, 5, 6].map((i) => write('/w/f' + i, 'y'.repeat(900), null));
		r = await commitChanges(six, d.io, CAPS);
		assert.ok(r.refused && /total 5400 bytes; at most 5000 per command/.test(r.notes[0]), r.notes[0]);
		const five = [1, 2, 3, 4, 5].map((i) => write('/w/g' + i, 'z'.repeat(1000), null));
		assert.strictEqual((await commitChanges(five, d.io, CAPS)).refused, false, 'exactly the per-run cap');
		assert.strictEqual((await commitChanges(five.slice(0, 4).concat(write('/w/g9', 'z'.repeat(1000), null), write('/w/g10', 'z', null)), d.io, CAPS)).refused, true, 'one byte over');
		const many = Array.from({ length: 11 }, (_, i) => write('/w/m' + i, '', null));
		r = await commitChanges(many, d.io, CAPS);
		assert.ok(r.refused && /changed 11 files and folders; at most 10/.test(r.notes[0]), r.notes[0]);
		assert.strictEqual((await commitChanges(many.slice(0, 10), d.io, CAPS)).refused, false, 'exactly the entry cap');
		assert.strictEqual(d.nodes.has('/w/b'), false);
		assert.strictEqual(d.nodes.has('/w/f1'), false);
	});

	await test('a note lists at most six reasons and counts the rest', async () => {
		const d = disk({ '/w': null });
		const set = Array.from({ length: 9 }, (_, i) => write('/out/f' + i, 'x', null));
		const r = await commitChanges(set, d.io, { writeFile: 1000, writeRun: 5000, entries: 20 });
		assert.strictEqual(r.notes.length, 6 + 1 + 1);
		assert.ok(/and 3 more refused/.test(r.notes[6]));
	});

	/* ----- conflicts ----------------------------------------------------------------------------- */

	await test('a file somebody saved while the command ran is a conflict: nothing is applied, over the whole set', async () => {
		const d = disk({ '/w': null, '/w/a.txt': 'SAVED ELSEWHERE', '/w/b.txt': 'b' });
		const r = await commitChanges([write('/w/b.txt', 'B', 'b'), write('/w/a.txt', 'mine', 'original')], d.io, CAPS);
		assert.strictEqual(r.refused, true);
		assert.ok(r.notes.some((t) => /\/w\/a\.txt changed while the command ran/.test(t)), r.notes.join('\n'));
		assert.deepStrictEqual(d.writes(), []);
		assert.strictEqual(d.text('/w/b.txt'), 'b');
	});

	await test('same size, different bytes is still a conflict; a different size is one without reading the file', async () => {
		const d = disk({ '/w': null, '/w/same.txt': 'abcd', '/w/size.txt': 'a longer text' });
		let r = await commitChanges([write('/w/same.txt', 'x', 'abce')], d.io, CAPS);
		assert.ok(r.refused && /same\.txt changed/.test(r.notes[0]));
		d.calls.length = 0;
		r = await commitChanges([write('/w/size.txt', 'x', 'short')], d.io, CAPS);
		assert.ok(r.refused && /size\.txt changed/.test(r.notes[0]));
		assert.ok(!d.calls.some((c) => c.startsWith('readFile')), 'the size already said it changed: ' + d.calls.join(','));
	});

	await test('a file that was not there is not allowed to have appeared; one that was there is not allowed to be gone', async () => {
		const d = disk({ '/w': null, '/w/appeared.txt': 'x' });
		let r = await commitChanges([write('/w/appeared.txt', 'mine', null)], d.io, CAPS);
		assert.ok(r.refused && /appeared\.txt was created while the command ran/.test(r.notes[0]));
		r = await commitChanges([write('/w/vanished.txt', 'mine', 'before')], d.io, CAPS);
		assert.ok(r.refused && /vanished\.txt was removed while the command ran/.test(r.notes[0]));
		r = await commitChanges([del('/w/vanished.txt', 'before')], d.io, CAPS);
		assert.ok(r.refused && /was removed while the command ran/.test(r.notes[0]));
	});

	await test('a folder where a file was, and a file where a folder was, are conflicts', async () => {
		const d = disk({ '/w': null, '/w/now-a-dir': null, '/w/now-a-file': 'f' });
		let r = await commitChanges([write('/w/now-a-dir', 'x', 'old')], d.io, CAPS);
		assert.ok(r.refused && /is a folder now/.test(r.notes[0]), r.notes[0]);
		r = await commitChanges([mkdir('/w/now-a-file')], d.io, CAPS);
		assert.ok(r.refused && /is a file now/.test(r.notes[0]), r.notes[0]);
	});

	await test('a file whose original bytes were never read (a truncating overwrite, an rm) is checked for existing, not for content', async () => {
		const d = disk({ '/w': null, '/w/big.bin': 'anything', '/w/del.bin': 'anything' });
		const r = await commitChanges([
			{ kind: 'write', path: '/w/big.bin', existed: true, before: null, after: bytes('new') },
			{ kind: 'delete', path: '/w/del.bin', before: null },
		], d.io, CAPS);
		assert.strictEqual(r.refused, false);
		assert.strictEqual(d.text('/w/big.bin'), 'new');
		assert.strictEqual(d.text('/w/del.bin'), null);
	});

	await test('a path that cannot even be checked is a conflict, not a pass', async () => {
		const d = disk({ '/w': null, '/w/a': 'x' });
		d.failing.stat = (p) => (p === '/w/a' ? 'EIO: disk on fire' : null);
		const r = await commitChanges([write('/w/a', 'y', 'x')], d.io, CAPS);
		assert.ok(r.refused && /could not be checked: EIO: disk on fire/.test(r.notes[0]), r.notes[0]);
		assert.deepStrictEqual(d.writes(), []);
	});

	/* ----- a failure part-way -------------------------------------------------------------------- */

	await test('a write that fails stops the apply: N of M applied, where, why; the deletes did not run, so a move loses nothing', async () => {
		const d = disk({ '/w': null, '/w/a.txt': 'a', '/w/c.txt': 'c' });
		d.failing.write = (p) => (p === '/w/b.txt' ? 'quota exceeded' : null);
		// mv a.txt b.txt ; echo C > c.txt  =  write b, write c, delete a
		const r = await commitChanges([write('/w/b.txt', 'a', null), write('/w/c.txt', 'C', 'c'), del('/w/a.txt', 'a')], d.io, CAPS);
		assert.strictEqual(r.refused, false);
		assert.strictEqual(r.applied, 0);
		assert.strictEqual(r.failed, 3);
		assert.strictEqual(r.notes.length, 1);
		assert.ok(/applied 0 of 3 file changes; stopped at \/w\/b\.txt: quota exceeded\. The rest were not applied\./.test(r.notes[0]), r.notes[0]);
		assert.strictEqual(d.text('/w/a.txt'), 'a', 'the source of the move is still there');
		assert.strictEqual(d.text('/w/c.txt'), 'c', 'writes after the failed one were not attempted');
	});

	await test('a failure after some writes is reported with the count that did land', async () => {
		const d = disk({ '/w': null, '/w/a': 'a', '/w/b': 'b', '/w/c': 'c' });
		d.failing.write = (p) => (p === '/w/c' ? 'permission lapsed' : null);
		const r = await commitChanges([write('/w/a', 'A', 'a'), write('/w/b', 'B', 'b'), write('/w/c', 'C', 'c')], d.io, CAPS);
		assert.deepStrictEqual({ applied: r.applied, failed: r.failed }, { applied: 2, failed: 1 });
		assert.ok(/applied 2 of 3 .* stopped at \/w\/c: permission lapsed/.test(r.notes[0]), r.notes[0]);
		assert.strictEqual(d.text('/w/a'), 'A');
		assert.strictEqual(d.text('/w/c'), 'c');
	});

	await test('a folder that cannot be made stops the apply before any file is written', async () => {
		const d = disk({ '/w': null });
		d.failing.mkdir = () => 'read-only folder';
		const r = await commitChanges([mkdir('/w/new'), write('/w/new/a', 'a', null)], d.io, CAPS);
		assert.strictEqual(r.applied, 0);
		assert.ok(/stopped at \/w\/new: read-only folder/.test(r.notes[0]), r.notes[0]);
		assert.deepStrictEqual(d.writes(), ['mkdir /w/new']);
	});

	await test('paths and reasons in a note cannot carry a terminal escape: they are shown, not passed', async () => {
		const d = disk({ '/w': null });
		d.failing.write = () => 'bad \x1b[31m reason';
		const evil = '/w/x\x1b[2Jy';
		const r = await commitChanges([write(evil, 'a', null)], d.io, CAPS);
		assert.ok(!/[\x00-\x08\x0B-\x1F\x7F-\x9F]/.test(r.notes.join('\n')), JSON.stringify(r.notes));
		assert.ok(r.notes[0].includes('\u{241B}'));
		const r2 = await commitChanges([write('/etc/x\x1b]52;c;?\x07', 'a', null)], d.io, CAPS);
		assert.ok(!/[\x00-\x08\x0B-\x1F\x7F-\x9F]/.test(r2.notes.join('\n')), JSON.stringify(r2.notes));
	});

	await test('every note has the one shape the agent and the terminal both print', async () => {
		const d = disk({ '/w': null });
		const r = await commitChanges([write('/etc/a', 'x', null)], d.io, CAPS);
		for (const t of r.notes) { assert.ok(/^\[LevelCode Shell: .+\]$/.test(t), t); }
	});

	/* ----- checkChangeSet alone ---------------------------------------------------------------- */

	await test('checkChangeSet is the part that needs no disk: reasons, and no reasons for a good set', async () => {
		const io = { resolve: (/** @type {string} */ p) => (p.startsWith('/w') ? p : null) };
		assert.deepStrictEqual(checkChangeSet([write('/w/a', 'a', null)], io, CAPS), []);
		assert.strictEqual(checkChangeSet([write('/x/a', 'a', null)], io, CAPS).length, 1);
		assert.strictEqual(checkChangeSet('nope', io, CAPS).length, 1);
	});

	finished = true;
	console.log(`\n${n} tests passed`);
})().catch((e) => { console.error(e); process.exit(1); });
