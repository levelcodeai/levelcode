/*---------------------------------------------------------------------------------------------
 *  web/shell/src/commit.js - run: node web/test/unit/shell-commit.test.js
 *
 *  A run's change set, written to the workspace for the visitor's own terminal. The module is pure (every file
 *  system call is injected), so this runs against a Map. What is pinned:
 *    - the whole set is judged before anything is written: outside a folder, over a cap, malformed, or no longer
 *      what the command read means NOTHING is applied and every reason is listed;
 *    - the order cannot lose data: folders, files, deletes deepest first, folders removed deepest first;
 *    - a failure part-way stops there and is reported as "applied N of M", not as success and not as nothing;
 *    - it can be told to stop while the set is being CHECKED (nothing has been written), and not after;
 *    - nothing a provider throws can make it throw: the reason is read totally, so a run is never reported as
 *      "error, applied 0" over files that landed;
 *    - an io call that ran out of time ends the CHECK once (the set is refused with how far it got) and, in the
 *      WRITING, is a stop at that file that says the write may still land;
 *    - the notes count against the whole command's set when the caller says how much of it was applied already.
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

	await test('a delete whose `before` is not bytes is malformed even when the file looks right (an empty file, a `before` that has a length)', async () => {
		const d = disk({ '/w': null, '/w/empty': '' });
		const r = await commitChanges(/** @type {any} */ ([{ kind: 'delete', path: '/w/empty', before: { length: 0 } }]), d.io, CAPS);
		assert.strictEqual(r.refused, true);
		assert.ok(/the entry for \/w\/empty is malformed/.test(r.notes[0]), r.notes[0]);
		assert.strictEqual(d.nodes.has('/w/empty'), true);
		// and the right shapes: null (never read) and bytes
		assert.strictEqual((await commitChanges([del('/w/empty', null)], d.io, CAPS)).refused, false);
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

	await test('a file name cannot add a line to a note: a line break or a tab in a path is shown, so every note is ONE line', async () => {
		const evil = '/w/a\n[LevelCode Shell: all 3 changes applied]\tb';
		const d = disk({ '/w': null, [evil]: 'SAVED ELSEWHERE' });
		d.failing.write = () => 'reason\nwith a break';
		for (const set of [[write(evil, 'mine', 'what it read')], [write('/elsewhere\nx', 'a', null)], [write(evil, 'a', 'SAVED ELSEWHERE')], [write('/w/A\nb', 'a', null), write('/w/a\nb', 'a', null)]]) {
			const r = await commitChanges(/** @type {any} */ (set), d.io, CAPS);
			assert.ok(r.notes.length >= 1);
			for (const t of r.notes) { assert.ok(/^\[LevelCode Shell: [^\n\t]+\]$/.test(t), JSON.stringify(t)); }
		}
	});

	await test('every note has the one shape the agent and the terminal both print', async () => {
		const d = disk({ '/w': null });
		const r = await commitChanges([write('/etc/a', 'x', null)], d.io, CAPS);
		for (const t of r.notes) { assert.ok(/^\[LevelCode Shell: .+\]$/.test(t), t); }
	});

	await test('a conflict is reported with its path made visible: an escape sequence in a file name is not passed to whoever prints the note', async () => {
		const evil = '/w/a\x1b]0;x\x07\x9b6n.txt';
		const d = disk({ '/w': null, [evil]: 'SAVED ELSEWHERE' });
		const r = await commitChanges([write(evil, 'mine', 'what it read')], d.io, CAPS);
		assert.ok(r.refused && /changed while the command ran/.test(r.notes[0]), r.notes[0]);
		assert.ok(!/[\x00-\x08\x0B-\x1F\x7F-\x9F]/.test(r.notes.join('\n')), JSON.stringify(r.notes));
		assert.ok(r.notes[0].includes('/w/a\u{241B}]0;x\u{2407}[U+009B]6n.txt'), r.notes[0]);
		// ...and so is every other kind of conflict a path can be in
		const e2 = disk({ '/w': null, [evil]: 'x' });
		e2.failing.stat = () => 'EIO\x1b[31m';
		const r2 = await commitChanges([write(evil, 'mine', 'x')], e2.io, CAPS);
		assert.ok(!/[\x00-\x08\x0B-\x1F\x7F-\x9F]/.test(r2.notes.join('\n')), JSON.stringify(r2.notes));
		for (const set of [[write(evil, 'x', null)], [del(evil, 'x')], [mkdir(evil)]]) {
			const e3 = disk({ '/w': null, [evil]: set[0].kind === 'mkdir' ? 'a file' : null });
			const r3 = await commitChanges(/** @type {any} */ (set), e3.io, CAPS);
			assert.ok(r3.refused, JSON.stringify(set[0].kind));
			assert.ok(!/[\x00-\x08\x0B-\x1F\x7F-\x9F]/.test(r3.notes.join('\n')), set[0].kind + ': ' + JSON.stringify(r3.notes));
		}
	});

	await test('the case-only refusal says what it is and why it is conservative: the shell cannot tell what kind of disk the folder is on', async () => {
		const d = disk({ '/w': null });
		const r = await commitChanges([write('/w/README.md', 'a', null), write('/w/readme.md', 'b', null)], d.io, CAPS);
		assert.strictEqual(r.refused, true);
		assert.ok(/only in letter case or accent form/.test(r.notes[0]), r.notes[0]);
		assert.ok(/cannot tell which kind of disk/.test(r.notes[0]) && /case-sensitive disk, like the scratch workspace, would have kept both/.test(r.notes[0]), r.notes[0]);
		assert.ok(/^\[LevelCode Shell: .+\]$/.test(r.notes[0]));
	});

	/* ----- stopping --------------------------------------------------------------------------- */

	await test('cancelled() before the first write: nothing is written, and the result says it was cancelled, without a note of its own', async () => {
		const d = disk({ '/w': null, '/w/a': 'a', '/w/b': 'b' });
		const r = await commitChanges([write('/w/a', 'A', 'a'), write('/w/b', 'B', 'b'), mkdir('/w/new')], d.io, CAPS, () => true);
		assert.deepStrictEqual(r, { total: 3, applied: 0, failed: 3, refused: false, cancelled: true, notes: [] });
		assert.deepStrictEqual(d.writes(), []);
		assert.deepStrictEqual(d.calls, [], 'not even a stat: it was asked before the first file');
		assert.strictEqual(d.text('/w/a'), 'a');
	});

	await test('cancelled() while the files are being checked stops the checking where it is, and discards what it found, conflicts too', async () => {
		const d = disk({ '/w': null, '/w/a': 'a', '/w/b': 'CHANGED', '/w/c': 'c' });
		let asked = 0;
		// not cancelled for the first two files' checks (the second has a conflict), cancelled from the third on
		const r = await commitChanges([write('/w/a', 'A', 'a'), write('/w/b', 'B', 'b'), write('/w/c', 'C', 'c')], d.io, CAPS, () => ++asked > 2);
		assert.strictEqual(r.cancelled, true);
		assert.strictEqual(r.refused, false, 'a conflict seen before the stop is not the answer; the stop is');
		assert.deepStrictEqual(r.notes, []);
		assert.deepStrictEqual(d.calls.filter((c) => c.startsWith('stat ')), ['stat /w/a', 'stat /w/b'], 'the third file was not looked at');
		assert.deepStrictEqual(d.writes(), []);
	});

	await test('cancelled() is asked once more after the last check: a stop that came during the last read applies nothing', async () => {
		const d = disk({ '/w': null, '/w/a': 'a' });
		let cancel = false;
		const real = d.io.stat;
		d.io.stat = async (/** @type {string} */ p) => { const v = await real(p); cancel = true; return v; };   // the stop arrives during the only check
		const r = await commitChanges([write('/w/a', 'A', 'a')], d.io, CAPS, () => cancel);
		assert.strictEqual(r.cancelled, true);
		assert.deepStrictEqual(d.writes(), []);
		assert.strictEqual(d.text('/w/a'), 'a');
	});

	await test('cancelled() that is never true is the same as none; a stop that comes DURING the writes is not heard (a move is not left half-done)', async () => {
		const d = disk({ '/w': null, '/w/a': 'a' });
		let after = false;
		const w = d.io.writeFile;
		d.io.writeFile = async (/** @type {string} */ p, /** @type {Uint8Array} */ b) => { after = true; return w(p, b); };
		const r = await commitChanges([write('/w/b', 'a', null), del('/w/a', 'a')], d.io, CAPS, () => after);
		assert.deepStrictEqual({ applied: r.applied, failed: r.failed, cancelled: r.cancelled }, { applied: 2, failed: 0, cancelled: undefined });
		assert.strictEqual(d.text('/w/b'), 'a');
		assert.strictEqual(d.text('/w/a'), null);
		const plain = await commitChanges([write('/w/c', 'c', null)], d.io, CAPS, () => false);
		assert.strictEqual(plain.applied, 1);
	});


	/* ----- what a provider throws -------------------------------------------------------------- */

	/** @returns {Array<[string, any]>} */
	function hostileThrown() {
		const revoked = Proxy.revocable({}, {});
		revoked.revoke();
		return [
			['a message getter that throws', Object.defineProperty({}, 'message', { get() { throw new Error('getter-boom'); } })],
			['a Proxy whose every trap throws', new Proxy({}, new Proxy({}, { get() { throw new Error('trap-boom'); } }))],
			['a revoked Proxy', revoked.proxy],
			['an object with no prototype', Object.create(null)],
			['a Symbol', Symbol('sym')],
			['a BigInt', 12n],
			['undefined (a rejection with nothing)', undefined],
			['null', null],
			['an object whose toString throws', { toString() { throw new Error('no'); } }],
		];
	}

	await test('step() never throws: a hostile thing thrown by a write is a stop at that file, with the files before it counted and on disk', async () => {
		for (const [what, thrown] of hostileThrown()) {
			const d = disk({ '/w': null });
			const real = d.io.writeFile;
			d.io.writeFile = async (/** @type {string} */ p, /** @type {Uint8Array} */ b) => { if (p === '/w/b') { throw thrown; } return real(p, b); };
			let r;
			await assert.doesNotReject(async () => { r = await commitChanges([write('/w/a', 'A', null), write('/w/b', 'B', null), write('/w/c', 'C', null)], d.io, CAPS); }, what);
			const res = /** @type {any} */ (r);
			assert.deepStrictEqual({ applied: res.applied, failed: res.failed, refused: res.refused }, { applied: 1, failed: 2, refused: false }, what);
			assert.ok(/^\[LevelCode Shell: applied 1 of 3 file changes; stopped at \/w\/b: .+\. The rest were not applied\.\]$/.test(res.notes[0]), what + ': ' + res.notes[0]);
			assert.strictEqual(d.text('/w/a'), 'A', what + ': the file before it landed');
			assert.strictEqual(d.text('/w/c'), null, what + ': and the one after it was not written');
		}
	});

	await test('the same for the other steps: a folder that cannot be made, a delete and a folder removal that throw something hostile', async () => {
		for (const [what, thrown] of hostileThrown()) {
			for (const op of ['mkdir', 'remove']) {
				const d = disk({ '/w': null, '/w/gone': 'x', '/w/dir': null });
				const real = /** @type {any} */ (d.io)[op === 'mkdir' ? 'createDirectory' : 'remove'];
				/** @type {any} */ (d.io)[op === 'mkdir' ? 'createDirectory' : 'remove'] = async (/** @type {string} */ p) => { if (/new$|gone$|dir$/.test(p)) { throw thrown; } return real(p); };
				let r;
				const set = op === 'mkdir' ? [write('/w/ok.txt', 'ok', null), mkdir('/w/new')] : [write('/w/ok.txt', 'ok', null), del('/w/gone', 'x'), rmdir('/w/dir')];
				await assert.doesNotReject(async () => { r = await commitChanges(set, d.io, CAPS); }, what + ' ' + op);
				assert.ok(/stopped at \/w\/(new|gone): /.test(/** @type {any} */ (r).notes[0]), what + ' ' + op + ': ' + /** @type {any} */ (r).notes[0]);
			}
		}
	});

	await test('a hostile thing thrown by a CHECK is a path that could not be checked: refused, with a reason, not an exception', async () => {
		for (const [what, thrown] of hostileThrown()) {
			const d = disk({ '/w': null, '/w/a': 'a', '/w/b': 'b' });
			const real = d.io.stat;
			d.io.stat = async (/** @type {string} */ p) => { if (p === '/w/a') { throw thrown; } return real(p); };
			let r;
			await assert.doesNotReject(async () => { r = await commitChanges([write('/w/a', 'A', 'a'), write('/w/b', 'B', 'b')], d.io, CAPS); }, what);
			const res = /** @type {any} */ (r);
			assert.strictEqual(res.refused, true, what);
			assert.ok(/^\[LevelCode Shell: refused: \/w\/a could not be checked: .+\]$/.test(res.notes[0]), what + ': ' + res.notes[0]);
			assert.deepStrictEqual(d.writes(), [], what);
		}
	});

	await test('a reason that is megabytes long is cut before it is shown, and stays one line', async () => {
		const d = disk({ '/w': null });
		d.failing.write = () => 'X'.repeat(160) + 'Y'.repeat(5 * 1024 * 1024);
		const t0 = Date.now();
		const r = await commitChanges([write('/w/a', 'A', null)], d.io, CAPS);
		assert.ok(r.notes[0].includes(': ' + 'X'.repeat(160) + '.'), r.notes[0].slice(0, 300));
		assert.ok(r.notes[0].length < 400 && Date.now() - t0 < 1000);
	});

	/* ----- time ----------------------------------------------------------------------------------- */

	/** What the runtime's gate rejects with (its words, written out here: commit.js has no clock). */
	const late = (/** @type {any} */ extra) => Object.assign(new Error('timed out'), { code: 'ETIMEDOUT', timedOut: true }, extra);

	await test('a check that is out of time ends at the FIRST such call: the set is refused once, with how far it got, and no further path is asked', async () => {
		const d = disk({ '/w': null, '/w/a': 'a', '/w/b': 'b', '/w/c': 'c', '/w/d': 'd' });
		const real = d.io.stat;
		d.io.stat = async (/** @type {string} */ p) => { if (p === '/w/c') { throw late({ mayStillLand: false }); } return real(p); };
		const set = ['a', 'b', 'c', 'd'].map((f) => write('/w/' + f, f.toUpperCase(), f));
		const r = await commitChanges(set, d.io, CAPS);
		assert.deepStrictEqual({ refused: r.refused, applied: r.applied, failed: r.failed }, { refused: true, applied: 0, failed: 4 });
		assert.strictEqual(r.notes.length, 2, r.notes.join('\n'));
		assert.strictEqual(r.notes[0], '[LevelCode Shell: refused: the changes could not be checked in time: /w/c: timed out (2 of 4 were checked)]');
		assert.ok(/NONE of this command's file changes were applied/.test(r.notes[1]));
		assert.ok(!d.calls.includes('stat /w/d'), 'the path after the one that did not answer was not asked: ' + d.calls.join(','));
		assert.deepStrictEqual(d.writes(), []);
	});

	await test('what a check had found before it ran out of time is listed with it', async () => {
		const d = disk({ '/w': null, '/w/a': 'CHANGED', '/w/b': 'b' });
		const real = d.io.stat;
		d.io.stat = async (/** @type {string} */ p) => { if (p === '/w/b') { throw late({}); } return real(p); };
		const r = await commitChanges([write('/w/a', 'A', 'a'), write('/w/b', 'B', 'b')], d.io, CAPS);
		assert.ok(/\/w\/a changed while the command ran/.test(r.notes[0]), r.notes.join('\n'));
		assert.ok(/could not be checked in time: \/w\/b: timed out \(1 of 2 were checked\)/.test(r.notes[1]), r.notes.join('\n'));
	});

	await test('a Stop that gave up on a read (abandoned) ends the check the same way, and with cancelled() true the answer is the stop, not a refusal', async () => {
		const d = disk({ '/w': null, '/w/a': 'a', '/w/b': 'b' });
		let stopped = false;
		const real = d.io.stat;
		d.io.stat = async (/** @type {string} */ p) => { if (p === '/w/a') { stopped = true; throw Object.assign(new Error('stopped'), { abandoned: true }); } return real(p); };
		const r = await commitChanges([write('/w/a', 'A', 'a'), write('/w/b', 'B', 'b')], d.io, CAPS, () => stopped);
		assert.deepStrictEqual({ cancelled: r.cancelled, refused: r.refused, applied: r.applied, notes: r.notes }, { cancelled: true, refused: false, applied: 0, notes: [] });
		assert.ok(!d.calls.includes('stat /w/b'));
		// with no cancelled() at all, the io's word is enough: the check ends there and the set is refused
		const e = disk({ '/w': null, '/w/a': 'a', '/w/b': 'b' });
		const real2 = e.io.stat;
		e.io.stat = async (/** @type {string} */ p) => { if (p === '/w/a') { throw Object.assign(new Error('stopped'), { abandoned: true }); } return real2(p); };
		const r2 = await commitChanges([write('/w/a', 'A', 'a'), write('/w/b', 'B', 'b')], e.io, CAPS);
		assert.strictEqual(r2.refused, true);
		assert.ok(/could not be checked in time: \/w\/a: stopped \(0 of 2 were checked\)/.test(r2.notes[0]), r2.notes[0]);
		assert.ok(!e.calls.includes('stat /w/b'), 'b was not asked');
		assert.deepStrictEqual(e.writes(), []);
	});

	await test('a write that was not answered in time is a stop at that file and says it may still land; one that was never made does not say so', async () => {
		for (const [mayStillLand, expectLanding] of /** @type {Array<[boolean, boolean]>} */ ([[true, true], [false, false]])) {
			const d = disk({ '/w': null });
			const real = d.io.writeFile;
			d.io.writeFile = async (/** @type {string} */ p, /** @type {Uint8Array} */ b) => { if (p === '/w/b') { throw late({ mayStillLand }); } return real(p, b); };
			const r = await commitChanges([write('/w/a', 'A', null), write('/w/b', 'B', null), write('/w/c', 'C', null)], d.io, CAPS);
			assert.strictEqual(r.applied, 1);
			assert.ok(/^\[LevelCode Shell: applied 1 of 3 file changes; stopped at \/w\/b: timed out\./.test(r.notes[0]), r.notes[0]);
			assert.strictEqual(/may still land/.test(r.notes[0]), expectLanding, r.notes[0]);
			assert.ok(/The rest were not applied\.\]$/.test(r.notes[0]), r.notes[0]);
		}
	});

	/* ----- progress ------------------------------------------------------------------------------- */

	await test('progress: the phase is what the caller set until the first write, then "write"; applied counts what is confirmed, from where it started', async () => {
		const d = disk({ '/w': null, '/w/old': 'o', '/w/gone': 'g' });
		const progress = { phase: 'check', applied: 0, total: 4 };
		/** @type {string[]} */ const seen = [];
		for (const op of /** @type {const} */ (['stat', 'readFile', 'writeFile', 'createDirectory', 'remove'])) {
			const real = /** @type {any} */ (d.io)[op];
			/** @type {any} */ (d.io)[op] = (/** @type {any[]} */ ...a) => { seen.push(op + ':' + progress.phase + ':' + progress.applied); return real(...a); };
		}
		const r = await commitChanges([write('/w/new/a', 'A', null), mkdir('/w/m'), write('/w/old', 'O', 'o'), del('/w/gone', null)], d.io, CAPS, undefined, progress);
		assert.strictEqual(r.applied, 4);
		assert.strictEqual(progress.applied, 4);
		assert.strictEqual(progress.phase, 'write');
		const phases = seen.map((x) => x.split(':')[1]);
		const flip = phases.indexOf('write');
		assert.ok(flip > 0 && phases.slice(0, flip).every((x) => x === 'check') && phases.slice(flip).every((x) => x === 'write'), 'check, then write, never back: ' + seen.join(' '));
		assert.ok(seen.slice(0, flip).every((x) => /^(stat|readFile):check:0$/.test(x)), 'the check only reads, with nothing applied: ' + seen.join(' '));
		assert.ok(!seen.slice(0, flip).some((x) => /^(writeFile|createDirectory|remove)/.test(x)), 'no write in the check phase');
		// the count a caller can read while a write is in flight is what is confirmed so far
		/** @type {number[]} */ const during = [];
		const d2 = disk({ '/w': null });
		const p2 = { phase: 'check', applied: 0, total: 3 };
		const w2 = d2.io.writeFile;
		d2.io.writeFile = async (/** @type {string} */ p, /** @type {Uint8Array} */ b) => { during.push(p2.applied); return w2(p, b); };
		await commitChanges([write('/w/a', 'A', null), write('/w/b', 'B', null), write('/w/c', 'C', null)], d2.io, CAPS, undefined, p2);
		assert.deepStrictEqual(during, [0, 1, 2]);
	});

	await test('progress: a commit of what a review left counts against the whole set: "3 of 5", not "0 of 2"; and a refusal says how much had been applied', async () => {
		const d = disk({ '/w': null, '/w/f': 'a file' });
		d.failing.mkdir = (p) => (p === '/w/new' ? 'read-only folder' : null);
		const progress = { phase: 'rest', applied: 3, total: 5 };
		const r = await commitChanges([mkdir('/w/new'), mkdir('/w/other')], d.io, CAPS, undefined, progress);
		assert.strictEqual(r.notes[0], '[LevelCode Shell: applied 3 of 5 file changes; stopped at /w/new: read-only folder. The rest were not applied.]');
		assert.strictEqual(r.applied, 0, 'this call\'s own count is its own');
		assert.strictEqual(progress.applied, 3);
		const refused = await commitChanges([mkdir('/w/f'), mkdir('/w/x')], d.io, CAPS, undefined, { phase: 'rest', applied: 3, total: 5 });
		assert.strictEqual(refused.refused, true);
		assert.ok(/\/w\/f is a file now/.test(refused.notes[0]), refused.notes[0]);
		assert.strictEqual(refused.notes[1], '[LevelCode Shell: NONE of the remaining 2 changes were applied (3 of 5 had already been).]');
		const one = await commitChanges([mkdir('/w/f')], d.io, CAPS, undefined, { phase: 'rest', applied: 1, total: 2 });
		assert.strictEqual(one.notes[1], '[LevelCode Shell: NONE of the remaining 1 change was applied (1 of 2 had already been).]');
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
