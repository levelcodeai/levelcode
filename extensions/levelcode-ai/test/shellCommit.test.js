/*---------------------------------------------------------------------------------------------
 *  What becomes of a shell command's file changes — run: node test/shellCommit.test.js
 *
 *  shellCommit.js is the policy between a simulated shell and the review: which changes become Keep/Undo
 *  cards, which are written without one, which are refused. The rule behind all of it: the shell is never
 *  a way round what edit_file, write_file and delete_file refuse (binary files, files that changed under
 *  you) — and never a way to lose something the review could have kept.
 *  Pure and vscode-free, so this runs with plain node.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

const assert = require('assert');
const { commitShellChanges, reviewPathFor, isText, MAX_REVIEW_BYTES } = require('../shellCommit');

let n = 0;
async function test(name, fn) { await fn(); n++; console.log('  ok - ' + name); }
const enc = (s) => new TextEncoder().encode(s);
const W = (p, after, before) => ({ kind: 'write', path: p, existed: before !== undefined, before: before === undefined ? null : enc(before), after: typeof after === 'string' ? enc(after) : after });
const D = (p, before, viaDir) => ({ kind: 'delete', path: p, existed: true, before: typeof before === 'string' ? enc(before) : before, viaDir });

/** A ctx that records what the review was asked, and an `io` over a map of "what is on disk now". */
function rig(disk, folders, opts) {
	const edits = [], deletes = [];
	const ctx = {
		touched: new Set(), editCount: 0,
		applyEdit: async (r) => { edits.push(r); return !(opts && opts.refuseEdit); },
		applyDelete: async (r) => { deletes.push(r); return !(opts && opts.refuseDelete); },
	};
	const io = { folders: () => folders || [{ name: 'app', root: '/ws' }], readNow: async (abs) => (disk && disk[abs] !== undefined ? enc(disk[abs]) : null) };
	return { ctx, io, edits, deletes };
}

(async () => {
	await test('a path is relative to its folder; with several folders it carries the folder name, which is how it is found again', () => {
		const one = [{ name: 'app', root: '/ws' }];
		const two = [{ name: 'scratch', root: '/scratch' }, { name: 'proj', root: '/proj' }];
		assert.strictEqual(reviewPathFor('/ws/src/a.js', one), 'src/a.js');
		assert.strictEqual(reviewPathFor('/proj/src/a.js', two), 'proj/src/a.js');
		assert.strictEqual(reviewPathFor('/scratch/a.js', two), 'scratch/a.js');
		assert.strictEqual(reviewPathFor('/elsewhere/a.js', two), null);
		assert.strictEqual(reviewPathFor('/ws', one), '', 'the folder itself');
		assert.strictEqual(reviewPathFor('/a.txt', [{ name: 'root', root: '/' }]), 'a.txt', 'a folder at / is its own prefix');
		assert.strictEqual(reviewPathFor('/ws2/a', one), null, 'a name that merely starts with a folder\'s is not inside it');
		assert.strictEqual(reviewPathFor('/ws/sub/x', [{ name: 'ws', root: '/ws' }, { name: 'sub', root: '/ws/sub' }]), 'sub/x', 'the deepest folder wins, as host.uriFor does');
	});

	await test('text: created and modified files are reviewed; edit and delete counts and ctx.touched follow', async () => {
		const r = rig({ '/ws/a.txt': 'old' });
		const out = await commitShellChanges([W('/ws/new.txt', 'hi\n'), W('/ws/a.txt', 'new', 'old'), D('/ws/b.txt', 'bye')], r.ctx, r.io);
		assert.deepStrictEqual(r.edits, [{ path: 'a.txt', exists: true, proposed: 'new' }, { path: 'new.txt', exists: false, proposed: 'hi\n' }]);
		assert.deepStrictEqual(r.deletes, [{ path: 'b.txt' }]);
		assert.strictEqual(r.ctx.editCount, 3);
		assert.deepStrictEqual([...r.ctx.touched].sort(), ['/ws/a.txt', '/ws/new.txt']);
		assert.strictEqual(out.failed.length, 0);
		assert.match(out.notes[0], /3 files changed, ready for Keep\/Undo: ~a\.txt \+new\.txt -b\.txt/);
	});

	await test('a deleted file is no longer verified', async () => {
		const r = rig();
		r.ctx.touched.add('/ws/gone.txt');
		await commitShellChanges([D('/ws/gone.txt', 'x')], r.ctx, r.io);
		assert.ok(!r.ctx.touched.has('/ws/gone.txt'));
	});

	await test('build output and dependency folders are written by the shell and not reviewed', async () => {
		const r = rig();
		const out = await commitShellChanges([W('/ws/dist/app.js', 'x'), W('/ws/node_modules/p/i.js', 'x'), W('/ws/app.js.map', 'x'), D('/ws/.git/x', 'y')], r.ctx, r.io);
		assert.deepStrictEqual(r.edits, []);
		assert.strictEqual(out.rest.length, 4);
		assert.match(out.notes.join('\n'), /4 files in build output or binary form were written without review/);
	});

	await test('a NEW binary file is written without review; an EXISTING binary file is refused — never overwritten, never deleted', async () => {
		const r = rig();
		const bin = new Uint8Array([1, 0, 2]);
		const out = await commitShellChanges([W('/ws/new.bin', bin), { kind: 'write', path: '/ws/old.bin', existed: true, before: bin, after: enc('text now') }, D('/ws/gone.bin', bin)], r.ctx, r.io);
		assert.deepStrictEqual(out.rest.map((c) => c.path), ['/ws/new.bin']);
		assert.deepStrictEqual(out.failed.map((f) => f.c.path).sort(), ['/ws/gone.bin', '/ws/old.bin']);
		assert.deepStrictEqual(r.edits, []);
		assert.deepStrictEqual(r.deletes, []);
		assert.match(out.notes.join('\n'), /NOT applied: old\.bin — it is binary or too large to review/);
	});

	await test('bytes that are not UTF-8 are not text, whatever the NUL test says', () => {
		assert.strictEqual(isText(new Uint8Array([0xe9, 0x74, 0xe9])), false, 'latin-1 would be corrupted by a decode/encode round trip');
		assert.strictEqual(isText(enc('héllo')), true);
		assert.strictEqual(isText(new Uint8Array(0)), true, 'an empty file is a text file');
		assert.strictEqual(isText(new Uint8Array([65, 0, 66])), false);
		const late = new Uint8Array(8001).fill(65); late[8000] = 0;
		assert.strictEqual(isText(late), true, 'a NUL after byte 8000 is not looked for (host.isBinary)');
	});

	await test('a file larger than the review limit is not shown as a diff', async () => {
		const r = rig();
		const big = new Uint8Array(MAX_REVIEW_BYTES + 1).fill(97);
		const out = await commitShellChanges([W('/ws/big.txt', big)], r.ctx, r.io);
		assert.deepStrictEqual(out.rest.map((c) => c.path), ['/ws/big.txt'], 'new and large: written, said so');
		const out2 = await commitShellChanges([{ kind: 'write', path: '/ws/big.txt', existed: true, before: big, after: enc('x') }], rig().ctx, r.io);
		assert.strictEqual(out2.failed.length, 1, 'existing and large: refused');
	});

	await test('a file that changed on disk while the command ran is NOT overwritten, and the model is told', async () => {
		const r = rig({ '/ws/a.txt': 'what the user saved meanwhile' });
		const out = await commitShellChanges([W('/ws/a.txt', 'command output', 'what the command started from')], r.ctx, r.io);
		assert.deepStrictEqual(r.edits, []);
		assert.match(out.notes.join('\n'), /NOT applied: a\.txt — it changed while the command ran/);
	});

	await test('a NEW file that appeared while the command ran is not overwritten either', async () => {
		const r = rig({ '/ws/n.txt': 'someone else made this' });
		const out = await commitShellChanges([W('/ws/n.txt', 'mine')], r.ctx, r.io);
		assert.strictEqual(out.failed.length, 1);
	});

	await test('a directory is removed only when every file in it was', async () => {
		const ok = rig();
		const dirOk = await commitShellChanges([D('/ws/src/a.js', 'a', '/ws/src'), D('/ws/src/b.js', 'b', '/ws/src'), { kind: 'rmdir', path: '/ws/src' }], ok.ctx, ok.io);
		assert.deepStrictEqual(dirOk.rest.map((c) => c.kind), ['rmdir']);
		const blocked = rig(undefined, undefined, { refuseDelete: true });
		const dirNo = await commitShellChanges([D('/ws/src/a.js', 'a', '/ws/src'), { kind: 'rmdir', path: '/ws/src' }], blocked.ctx, blocked.io);
		assert.deepStrictEqual(dirNo.rest, [], 'the directory stays: a file in it could not be removed');
	});

	await test('a path outside every workspace folder is never applied', async () => {
		const r = rig();
		const out = await commitShellChanges([W('/etc/hosts', 'x')], r.ctx, r.io);
		assert.deepStrictEqual(r.edits, []);
		assert.strictEqual(out.failed[0].why, 'outside the workspace folders');
	});

	await test('the review refusing an edit is reported, not swallowed', async () => {
		const r = rig(undefined, undefined, { refuseEdit: true });
		const out = await commitShellChanges([W('/ws/a.txt', 'x')], r.ctx, r.io);
		assert.strictEqual(r.ctx.editCount, 0);
		assert.match(out.notes.join('\n'), /NOT applied: a\.txt — the editor could not apply it/);
	});

	await test('a host with no review hooks leaves everything to the shell rather than dropping it', async () => {
		const out = await commitShellChanges([W('/ws/a.txt', 'x')], { touched: new Set() }, rig().io);
		assert.strictEqual(out.rest.length, 1);
	});

	console.log('\nshellCommit: ' + n + ' tests passed.');
})().catch((e) => { console.error(e); process.exit(1); });
