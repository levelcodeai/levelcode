/*---------------------------------------------------------------------------------------------
 *  What becomes of a shell command's file changes — run: node test/shellCommit.test.js
 *
 *  shellCommit.js is the policy between a simulated shell and the review, and its rule is one sentence:
 *  EVERYTHING IS REVIEWED OR THE WHOLE COMMAND IS REFUSED. A change set is validated as a whole first; if one
 *  change is refused nothing is applied and every refusal is listed. Pure and vscode-free: plain node.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

const assert = require('assert');
const { commitShellChanges, reviewPathFor, isPlainText, eolStyle, isProtected, MAX_REVIEW_BYTES, MAX_REVIEWED_FILES } = require('../shellCommit');

let n = 0;
async function test(name, fn) { await fn(); n++; console.log('  ok - ' + name); }
const enc = (s) => new TextEncoder().encode(s);
const W = (p, after, before) => ({ kind: 'write', path: p, existed: before !== undefined, before: before === undefined ? null : (typeof before === 'string' ? enc(before) : before), after: typeof after === 'string' ? enc(after) : after });
const D = (p, before, viaDir) => ({ kind: 'delete', path: p, before: typeof before === 'string' ? enc(before) : before, viaDir });

/** A ctx that records what the review was asked, and an `io` over a map of "what is on disk now". */
function rig(disk, opts) {
	const edits = [], deletes = [];
	const o = opts || {};
	const ctx = {
		touched: new Set(), editCount: 0,
		applyEdit: async (r) => { if (o.throwOn && o.throwOn === r.path) { throw new Error('openTextDocument failed'); } edits.push(r); return !o.refuseEdit; },
		applyDelete: async (r) => { deletes.push(r); return !o.refuseDelete; },
	};
	const io = {
		folders: () => o.folders || [{ name: 'app', root: '/ws' }],
		readNow: async (abs) => (disk && disk[abs] !== undefined ? (typeof disk[abs] === 'string' ? enc(disk[abs]) : disk[abs]) : null),
		isDirty: o.dirty ? (abs) => o.dirty.includes(abs) : undefined,
	};
	return { ctx, io, edits, deletes };
}
const ids = (out) => out.failed.map((f) => f.c.path).sort();

(async () => {
	await test('a path is relative to its folder; with several folders it carries the folder name, which is how it is found again', () => {
		const one = [{ name: 'app', root: '/ws' }];
		const two = [{ name: 'scratch', root: '/scratch' }, { name: 'proj', root: '/proj' }];
		assert.deepStrictEqual(reviewPathFor('/ws/src/a.js', one), { rel: 'src/a.js', review: 'src/a.js' });
		assert.deepStrictEqual(reviewPathFor('/proj/src/a.js', two), { rel: 'src/a.js', review: 'proj/src/a.js' });
		assert.strictEqual(reviewPathFor('/elsewhere/a.js', two), null);
		assert.strictEqual(reviewPathFor('/ws2/a', one), null, 'a name that merely starts with a folder\'s is not inside it');
		assert.deepStrictEqual(reviewPathFor('/a.txt', [{ name: 'root', root: '/' }]), { rel: 'a.txt', review: 'a.txt' });
		assert.strictEqual(reviewPathFor('/ws/sub/x', [{ name: 'ws', root: '/ws' }, { name: 'sub', root: '/ws/sub' }]).review, 'sub/x', 'the deepest folder wins, as host.uriFor does');
	});

	await test('text changes are reviewed; edit and delete counts and ctx.touched follow; the files named in the note', async () => {
		const r = rig({ '/ws/a.txt': 'old', '/ws/b.txt': 'bye' });
		const out = await commitShellChanges([W('/ws/new.txt', 'hi\n'), W('/ws/a.txt', 'new', 'old'), D('/ws/b.txt', 'bye')], r.ctx, r.io);
		assert.deepStrictEqual(r.edits, [{ path: 'a.txt', exists: true, proposed: 'new' }, { path: 'new.txt', exists: false, proposed: 'hi\n' }]);
		assert.deepStrictEqual(r.deletes, [{ path: 'b.txt' }]);
		assert.strictEqual(r.ctx.editCount, 3);
		assert.deepStrictEqual([...r.ctx.touched].sort(), ['/ws/a.txt', '/ws/new.txt']);
		assert.strictEqual(out.refused, false);
		assert.strictEqual(out.failed.length, 0);
		assert.match(out.notes[0], /3 files changed, ready for Keep\/Undo: ~a\.txt \+new\.txt -b\.txt/);
	});

	await test('a deleted file is no longer verified', async () => {
		const r = rig({ '/ws/a.txt': 'x' });
		r.ctx.touched.add('/ws/a.txt');
		await commitShellChanges([D('/ws/a.txt', 'x')], r.ctx, r.io);
		assert.ok(!r.ctx.touched.has('/ws/a.txt'));
	});

	await test('one refusal refuses everything: nothing is applied, every refusal is listed, the last note says so', async () => {
		const r = rig({ '/ws/ok.txt': 'a', '/ws/logo.png': new Uint8Array([0x89, 0x50, 0, 1]) });
		const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 1]);
		const out = await commitShellChanges([W('/ws/ok.txt', 'b', 'a'), W('/ws/logo.png', png, new Uint8Array([0x89, 0x50, 0, 1]))], r.ctx, r.io);
		assert.strictEqual(out.refused, true);
		assert.deepStrictEqual(r.edits, [], 'the good change was not applied either');
		assert.deepStrictEqual(ids(out), ['/ws/logo.png']);
		assert.match(out.notes.join('\n'), /refused: logo\.png — it would be binary/);
		assert.match(out.notes[out.notes.length - 1], /NONE of this command's file changes were applied/);
		assert.strictEqual(r.ctx.editCount, 0);
		assert.deepStrictEqual(out.rest, [], 'directories are not made either');
	});

	await test('a move of a binary is refused whole — it is not a copy and an exit 1', async () => {
		const bin = new Uint8Array([1, 0, 2]);
		const r = rig({ '/ws/logo.png': bin });
		const out = await commitShellChanges([W('/ws/assets/logo.png', bin), D('/ws/logo.png', bin)], r.ctx, r.io);
		assert.strictEqual(out.refused, true);
		assert.strictEqual(ids(out).length, 2);
		assert.deepStrictEqual(r.edits.concat(r.deletes), []);
	});

	await test('there is no unreviewed path: node_modules, dist, out and *.map are reviewed like any file', async () => {
		const r = rig();
		const out = await commitShellChanges([W('/ws/dist/app.js', 'x'), W('/ws/node_modules/a/i.js', 'y'), W('/ws/app.js.map', '{}')], r.ctx, r.io);
		assert.strictEqual(out.refused, false);
		assert.strictEqual(r.edits.length, 3);
		assert.deepStrictEqual(out.rest, []);
	});

	await test('protected paths are refused in both directions, under any folder, case-insensitively for the instruction files', async () => {
		for (const p of ['.git/config', 'a/.git/hooks/pre-commit', '.vscode/settings.json', '.levelcode/mcp.json', '.cursor/rules/x.mdc', '.husky/pre-commit', '.github/workflows/ci.yml', 'AGENTS.md', 'sub/CLAUDE.md', '.cursorrules', 'Agents.md']) {
			assert.ok(isProtected(p), p + ' should be protected');
			const w = rig();
			const out = await commitShellChanges([W('/ws/' + p, 'x')], w.ctx, w.io);
			assert.strictEqual(out.refused, true, p);
			const d = rig({ ['/ws/' + p]: 'x' });
			const outD = await commitShellChanges([D('/ws/' + p, 'x')], d.ctx, d.io);
			assert.strictEqual(outD.refused, true, p + ' (delete)');
		}
		for (const p of ['gitlab.md', 'src/vscode.js', 'docs/AGENTS.txt', '.github/ISSUE_TEMPLATE/bug.md', 'README.md']) { assert.ok(!isProtected(p), p + ' is not protected'); }
	});

	await test('outside the workspace folders: refused', async () => {
		const r = rig();
		const out = await commitShellChanges([W('/etc/passwd', 'x')], r.ctx, r.io);
		assert.strictEqual(out.refused, true);
		assert.match(out.notes[0], /outside the workspace folders/);
	});

	await test('plain text only: binary, NUL, invalid UTF-8, a byte-order mark and over 1 MiB are refused', async () => {
		assert.ok(isPlainText(enc('héllo 世界\n')));
		assert.ok(!isPlainText(new Uint8Array([0x61, 0, 0x62])));
		assert.ok(!isPlainText(new Uint8Array([0xe9, 0x0a])));                       // latin1 é
		assert.ok(!isPlainText(new Uint8Array([0xef, 0xbb, 0xbf, 0x61])));            // BOM
		assert.ok(isPlainText(new Uint8Array(0)));
		for (const after of [new Uint8Array([0x61, 0, 0x62]), new Uint8Array([0xe9, 0x0a]), new Uint8Array([0xef, 0xbb, 0xbf, 0x61]), new Uint8Array(MAX_REVIEW_BYTES + 1).fill(0x61)]) {
			const r = rig();
			const out = await commitShellChanges([W('/ws/f.txt', after)], r.ctx, r.io);
			assert.strictEqual(out.refused, true);
		}
		const edge = rig();
		assert.strictEqual((await commitShellChanges([W('/ws/f.txt', new Uint8Array(MAX_REVIEW_BYTES).fill(0x61))], edge.ctx, edge.io)).refused, false, 'exactly the limit is fine');
	});

	await test('an existing file that is not plain text is not modified or deleted from a command (Undo would write mangled bytes)', async () => {
		const latin = new Uint8Array([0x43, 0x41, 0x46, 0xe9, 0x0a]);
		const r = rig({ '/ws/menu.txt': latin });
		assert.strictEqual((await commitShellChanges([W('/ws/menu.txt', 'x\n', latin)], r.ctx, r.io)).refused, true);
		assert.strictEqual((await commitShellChanges([D('/ws/menu.txt', latin)], r.ctx, r.io)).refused, true);
	});

	await test('line endings: the review keeps a file\'s style, so a change of style is refused rather than silently not happening', async () => {
		assert.strictEqual(eolStyle('a\r\nb\r\n'), 'crlf');
		assert.strictEqual(eolStyle('a\nb\n'), 'lf');
		assert.strictEqual(eolStyle('a'), 'none');
		assert.strictEqual(eolStyle('a\r\nb\n'), 'mixed');
		const crlf = 'a\r\nb\r\n';
		let r = rig({ '/ws/f.txt': crlf });
		assert.strictEqual((await commitShellChanges([W('/ws/f.txt', 'a\nb\n', crlf)], r.ctx, r.io)).refused, true, 'tr -d \\r on a CRLF file');
		r = rig({ '/ws/f.txt': crlf });
		assert.strictEqual((await commitShellChanges([W('/ws/f.txt', 'a\r\nb\r\nc\r\n', crlf)], r.ctx, r.io)).refused, false, 'CRLF stays CRLF');
		r = rig({ '/ws/f.txt': 'a\nb\n' });
		assert.strictEqual((await commitShellChanges([W('/ws/f.txt', 'a\r\nb\r\n', 'a\nb\n')], r.ctx, r.io)).refused, true, 'unix2dos');
		r = rig({ '/ws/f.txt': 'one line' });
		assert.strictEqual((await commitShellChanges([W('/ws/f.txt', 'one\r\nline\r\n', 'one line')], r.ctx, r.io)).refused, false, 'a file with no line break has no style to keep');
		r = rig();
		assert.strictEqual((await commitShellChanges([W('/ws/new.txt', 'a\r\nb\r\n')], r.ctx, r.io)).refused, true, 'new files are LF');
		r = rig();
		assert.strictEqual((await commitShellChanges([W('/ws/new.txt', 'a\rb')], r.ctx, r.io)).refused, true, 'a bare CR');
		r = rig({ '/ws/m.txt': 'a\r\nb\n' });
		assert.strictEqual((await commitShellChanges([W('/ws/m.txt', 'x\n', 'a\r\nb\n')], r.ctx, r.io)).refused, true, 'mixed is not touched');
	});

	await test('unsaved changes in the editor: refused, for a modify and for a delete', async () => {
		let r = rig({ '/ws/a.txt': 'old' }, { dirty: ['/ws/a.txt'] });
		let out = await commitShellChanges([W('/ws/a.txt', 'new', 'old')], r.ctx, r.io);
		assert.strictEqual(out.refused, true);
		assert.match(out.notes[0], /unsaved changes/);
		out = await commitShellChanges([D('/ws/a.txt', 'old')], r.ctx, r.io);
		assert.strictEqual(out.refused, true);
		r = rig({}, { dirty: ['/ws/new.txt'] });
		assert.strictEqual((await commitShellChanges([W('/ws/new.txt', 'x')], r.ctx, r.io)).refused, false, 'a file that did not exist has no buffer to lose');
	});

	await test('a file that changed on disk since the command read it is not overwritten, and not deleted', async () => {
		let r = rig({ '/ws/a.txt': 'SOMEONE ELSE' });
		let out = await commitShellChanges([W('/ws/a.txt', 'new', 'old')], r.ctx, r.io);
		assert.strictEqual(out.refused, true);
		assert.match(out.notes[0], /changed while the command ran/);
		out = await commitShellChanges([D('/ws/a.txt', 'old')], r.ctx, r.io);
		assert.strictEqual(out.refused, true);
		r = rig({ '/ws/new.txt': 'appeared' });
		assert.strictEqual((await commitShellChanges([W('/ws/new.txt', 'mine')], r.ctx, r.io)).refused, true, 'a file the command thought it created now exists');
	});

	await test('case: a case-only rename, and two paths that differ only in case, are refused', async () => {
		const r = rig({ '/ws/Foo.txt': 'x' });
		let out = await commitShellChanges([W('/ws/foo.txt', 'x'), D('/ws/Foo.txt', 'x')], r.ctx, r.io);
		assert.strictEqual(out.refused, true);
		assert.match(out.notes.join('\n'), /letter case/);
		out = await commitShellChanges([W('/ws/A.txt', 'a'), W('/ws/a.txt', 'b')], rig().ctx, rig().io);
		assert.strictEqual(out.refused, true);
	});

	await test('more than 300 files: nothing is applied, and the note says how many', async () => {
		const changes = [];
		for (let i = 0; i < MAX_REVIEWED_FILES + 1; i++) { changes.push(W('/ws/f' + i + '.txt', 'x')); }
		const r = rig();
		const out = await commitShellChanges(changes, r.ctx, r.io);
		assert.strictEqual(out.refused, true);
		assert.deepStrictEqual(r.edits, []);
		assert.match(out.notes[0], /would change 301 files/);
		const ok = rig();
		assert.strictEqual((await commitShellChanges(changes.slice(0, MAX_REVIEWED_FILES), ok.ctx, ok.io)).refused, false, 'exactly 300 is fine');
	});

	await test('directories are the shell\'s: mkdir always, rmdir only when every file in it went', async () => {
		const files = D('/ws/d/a.txt', 'a', '/ws/d');
		const r = rig({ '/ws/d/a.txt': 'a' });
		const out = await commitShellChanges([files, { kind: 'mkdir', path: '/ws/n' }, { kind: 'rmdir', path: '/ws/d' }], r.ctx, r.io);
		assert.deepStrictEqual(out.rest.map((c) => c.kind + ':' + c.path), ['mkdir:/ws/n', 'rmdir:/ws/d']);
		const failing = rig({ '/ws/d/a.txt': 'a' }, { refuseDelete: true });
		const out2 = await commitShellChanges([files, { kind: 'mkdir', path: '/ws/n' }, { kind: 'rmdir', path: '/ws/d' }], failing.ctx, failing.io);
		assert.deepStrictEqual(out2.rest.map((c) => c.kind + ':' + c.path), ['mkdir:/ws/n'], 'the directory is kept because its file was not deleted');
	});

	await test('a review call that throws or says no is a failure that is reported, not a rejection, and not "exit 0"', async () => {
		const r = rig({}, { throwOn: 'b.txt' });
		const out = await commitShellChanges([W('/ws/a.txt', 'a'), W('/ws/b.txt', 'b'), W('/ws/c.txt', 'c')], r.ctx, r.io);
		assert.strictEqual(out.refused, false);
		assert.deepStrictEqual(r.edits.map((e) => e.path), ['a.txt', 'c.txt'], 'the ones after it were still tried');
		assert.deepStrictEqual(ids(out), ['/ws/b.txt']);
		assert.match(out.notes.join('\n'), /NOT applied: b\.txt — the editor failed: openTextDocument failed/);
		assert.match(out.notes.join('\n'), /PARTLY applied — 2 of 3 file changes/);
		assert.strictEqual(r.ctx.editCount, 2);
		const no = rig({}, { refuseEdit: true });
		const out2 = await commitShellChanges([W('/ws/a.txt', 'a')], no.ctx, no.io);
		assert.strictEqual(out2.failed.length, 1);
	});

	await test('with no review wired (a host without one) nothing is silently written: it is reported as failed', async () => {
		const out = await commitShellChanges([W('/ws/a.txt', 'a')], { touched: new Set() }, rig().io);
		assert.strictEqual(out.failed.length, 1);
		assert.strictEqual(out.applied.length, 0);
	});

	console.log(`\nshellCommit: ${n} tests passed.`);
})().catch((e) => { console.error(e); process.exit(1); });
