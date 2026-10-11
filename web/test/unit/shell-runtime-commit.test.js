/*---------------------------------------------------------------------------------------------
 *  web/shell/src/runtime.js, what is done with a run's change set - run: node web/test/unit/shell-runtime-commit.test.js
 *
 *  README section 5. The engine never writes; when a run ends it says what it would have changed, and the host
 *  decides. The rule that matters most is the first:
 *
 *    NOTHING IS APPLIED unless the script ran to its end (how 'exit'). Stopped, over a limit, past a deadline or
 *    failed: the staged writes are dropped and a note says so.
 *
 *  Then the order for an agent run (levelcode-ai's commit, then what it leaves to the shell, then the notes,
 *  then 'close'), the exit status that is raised when something could not be applied, and what happens when the
 *  review itself throws or is handed something it must not be - or hands back something it must not.
 *
 *  And what is never said falsely while a commit is going on: a worker that dies does not settle the run with
 *  "nothing was applied" over files that land; a folder that gained a file after the command ran is not removed
 *  with it. A commit is BOUNDED, in both routes, and a Stop does not wait for it:
 *
 *    - a call to the file system is waited for fsMs at most, the read-only CHECK of a set checkMs in all for up to
 *      checkEntries entries and in proportion above that, never more than checkMaxMs (refused whole, once, with how
 *      far it got; a provider that does not answer ends it at fsMs whatever the size of the set), the part that
 *      WRITES commitMs in all for the agent (its review and the folders it leaves share one budget) and, for the
 *      terminal's own writes, twice the check's of the same set (never less than commitMs): a folder is one call to
 *      check and two to write, so what the check lets through the writing can finish - applied whole or refused
 *      whole, never half a project while the provider keeps answering;
 *    - a Stop or a dispose() ends the run AT ONCE: a set that was only being checked applied nothing, one that
 *      was being written says how many changes are confirmed, that the write in flight cannot be cancelled and
 *      may still land, and nothing more is started - after what the run already knew (a moved folder, the
 *      engine's notes, output that was cut, variables left out), which every ending says;
 *    - the shell's own give-up on a review that does not answer is a cancellation the review can see
 *      (control.cancelled()), and only that: a read of the folders it left that is not answered is a refusal;
 *    - what a provider throws is never able to turn a commit into "error, applied 0" over files that landed.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

// A promise that never settles ends the process with status 0 and no output: a suite that did not finish fails.
let finished = false;
process.on('exit', (code) => { if (!finished && code === 0) { console.error('not ok - the tests did not finish'); process.exitCode = 1; } });

const assert = require('assert');
const path = require('path');

const { createRig, flush } = require(path.join(__dirname, '..', 'helpers', 'shell-runtime-fakes.js'));
const { observe } = require(path.join(__dirname, '..', 'helpers', 'shell-conformance.js'));

const te = new TextEncoder();
/** @param {string} p @param {string} after @param {string|null} before */
const wr = (p, after, before) => ({ kind: 'write', path: p, existed: before !== null, before: before === null ? null : te.encode(before), after: te.encode(after) });
const del = (/** @type {string} */ p, /** @type {string} */ before) => ({ kind: 'delete', path: p, before: te.encode(before) });
const mkdir = (/** @type {string} */ p) => ({ kind: 'mkdir', path: p });
const rmdir = (/** @type {string} */ p) => ({ kind: 'rmdir', path: p });

let n = 0;
async function test(/** @type {string} */ name, /** @type {() => Promise<void>} */ fn) { await fn(); n++; console.log('  ok - ' + name); }

/**
 * An engine whose every run ends with `done`, after printing `say` to stdout.
 * @param {any} rig @param {any} done @param {string} [say]
 */
function ending(rig, done, say) {
	rig.engines.state.onRun = async (/** @type {any} */ run, /** @type {any} */ w, /** @type {any} */ h) => {
		if (say) { h.out(run.id, 'stdout', say); }
		await flush();
		h.done(done);
	};
}

/** Let things settle until `cond()` holds (a few real turns of the event loop at most). */
async function until(/** @type {() => boolean} */ cond) {
	for (let i = 0; i < 50 && !cond(); i++) { await flush(); }
	assert.ok(cond(), 'the condition never held');
}

/**
 * Spawn the agent's command and collect what its ChildLike did, in order.
 * @param {any} rig @param {string} command @param {any} [opts]
 */
async function agent(rig, command, opts) {
	/** @type {string[]} */ const log = [];
	const child = rig.rt.spawnAgent(command, Object.assign({ cwd: '/scratch' }, opts));
	const obs = observe(child, 3000, log);
	await obs.closed;
	await flush();
	const close = /** @type {any} */ (obs.events.find((e) => e.type === 'close'));
	return { child, stdout: obs.stdout, stderr: obs.stderr, code: /** @type {number} */ (close.code), log, events: obs.events };
}

(async () => {
	/* ===== the visitor's terminal: straight to the workspace ======================================= */

	await test('a script that ran to its end has its changes written, and the result counts them', async () => {
		const r = createRig();
		r.ws.put('/scratch/a.txt', 'old');
		r.ws.put('/scratch/gone.txt', 'bye');
		ending(r, { changes: [wr('/scratch/a.txt', 'new', 'old'), wr('/scratch/sub/b.txt', 'fresh', null), del('/scratch/gone.txt', 'bye'), mkdir('/scratch/empty')] });
		const res = await r.rt.createSession().run('x');
		assert.deepStrictEqual({ how: res.how, exitCode: res.exitCode, applied: res.applied, notes: res.notes }, { how: 'exit', exitCode: 0, applied: 4, notes: [] });
		assert.strictEqual(r.ws.text('/scratch/a.txt'), 'new');
		assert.strictEqual(r.ws.text('/scratch/sub/b.txt'), 'fresh');
		assert.strictEqual(r.ws.exists('/scratch/gone.txt'), false);
		assert.strictEqual(r.ws.isDir('/scratch/empty'), true);
		r.rt.dispose();
	});

	await test('a worker the deadline terminated has a `done` in flight: it reaches the host after the run was settled, and applies nothing', async () => {
		const r = createRig({ limits: { engine: { maxExecutionTimeMs: 1000 }, workers: { deadlineGraceMs: 500 } } });
		/** @type {any} */ let worker;
		r.engines.state.onRun = async (run, w) => { worker = w; await new Promise(() => { }); };
		const p = r.rt.createSession().run('x');
		await flush();
		await r.clock.advance(1500);
		const res = await p;
		assert.strictEqual(res.how, 'deadline');
		worker.emitAlways({ t: 'done', id: worker.currentRun, exitCode: 0, how: 'exit', cwd: '/scratch', env: { LATE: '1' }, changes: [wr('/scratch/late.txt', 'late', null)], denied: [], notes: [], stats: {} });
		await flush();
		await flush();
		assert.strictEqual(r.ws.exists('/scratch/late.txt'), false, 'a result that arrives after the run ended is not applied');
		assert.deepStrictEqual(r.ws.calls, [], 'and the workspace is not even asked');
		r.rt.dispose();
	});

	await test('the order on the workspace: folders, files, then deletes deepest first, then folders removed deepest first', async () => {
		const r = createRig();
		r.ws.put('/scratch/old/sub/x.txt', 'x');
		r.ws.put('/scratch/old/y.txt', 'y');
		ending(r, { changes: [rmdir('/scratch/old'), rmdir('/scratch/old/sub'), del('/scratch/old/y.txt', 'y'), del('/scratch/old/sub/x.txt', 'x'), wr('/scratch/new/z.txt', 'z', null), mkdir('/scratch/new')] });
		await r.rt.createSession().run('x');
		const ops = r.ws.calls.filter((c) => /^(writeFile|createDirectory|delete) /.test(c)).map((c) => c.replace('levelcode-scratch:', ''));
		assert.deepStrictEqual(ops, [
			'createDirectory /scratch/new', 'writeFile /scratch/new/z.txt',
			'delete /scratch/old/sub/x.txt', 'delete /scratch/old/y.txt', 'delete /scratch/old/sub', 'delete /scratch/old',
		]);
		r.rt.dispose();
	});

	/** @type {Array<[string, number]>} */
	const NOT_EXIT = [['limit', 126], ['deadline', 124], ['aborted', 130], ['error', 1]];
	for (const [how, status] of NOT_EXIT) {
		await test('how ' + how + ': nothing is applied, the status is ' + status + ', and the note says the changes were not applied', async () => {
			const r = createRig();
			r.ws.put('/scratch/a.txt', 'old');
			ending(r, { how, exitCode: 0, changes: [wr('/scratch/a.txt', 'NEW', 'old'), wr('/scratch/b.txt', 'B', null)] }, 'partial output\n');
			const out = [];
			const res = await r.rt.createSession().run('x', { onStdout: (t) => out.push(t) });
			assert.deepStrictEqual({ how: res.how, exitCode: res.exitCode, applied: res.applied }, { how, exitCode: status, applied: 0 });
			assert.ok(/Its 2 file changes were NOT applied\./.test(res.notes.join('\n')), res.notes.join('\n'));
			assert.strictEqual(r.ws.text('/scratch/a.txt'), 'old');
			assert.strictEqual(r.ws.exists('/scratch/b.txt'), false);
			assert.deepStrictEqual(r.ws.calls.filter((c) => /^(writeFile|createDirectory|delete) /.test(c)), []);
			assert.deepStrictEqual(out, ['partial output\n'], 'what it had printed stays');
			r.rt.dispose();
		});
	}

	await test('a run with no changes that is stopped by a limit says the limit, not "changes were not applied"', async () => {
		const r = createRig();
		ending(r, { how: 'limit', exitCode: 126, changes: [] });
		const res = await r.rt.createSession().run('seq 1 999999');
		assert.ok(/limit of this shell stopped the command\.$/.test(res.notes[0].replace(/\]$/, '')), res.notes[0]);
		assert.ok(!/NOT applied/.test(res.notes.join('')));
		r.rt.dispose();
	});

	await test('a script\'s own failing status is kept, and its changes ARE applied (it ran to its end)', async () => {
		const r = createRig();
		ending(r, { exitCode: 3, how: 'exit', changes: [wr('/scratch/out.txt', 'partial', null)] });
		const res = await r.rt.createSession().run('x');
		assert.deepStrictEqual({ exitCode: res.exitCode, applied: res.applied }, { exitCode: 3, applied: 1 });
		assert.strictEqual(r.ws.text('/scratch/out.txt'), 'partial');
		r.rt.dispose();
	});

	await test('a file that changed on disk while the command ran: nothing is applied and the status is raised from 0 to 1', async () => {
		const r = createRig();
		r.ws.put('/scratch/a.txt', 'SAVED BY SOMEONE');
		ending(r, { exitCode: 0, changes: [wr('/scratch/a.txt', 'mine', 'what the command read'), wr('/scratch/b.txt', 'b', null)] });
		const res = await r.rt.createSession().run('x');
		assert.deepStrictEqual({ how: res.how, exitCode: res.exitCode, applied: res.applied }, { how: 'exit', exitCode: 1, applied: 0 });
		assert.ok(/a\.txt changed while the command ran/.test(res.notes.join('\n')));
		assert.strictEqual(r.ws.exists('/scratch/b.txt'), false);
		r.rt.dispose();
	});

	await test('the raise is only from 0: a script that exited 5 and whose commit was refused still says 5', async () => {
		const r = createRig();
		ending(r, { exitCode: 5, changes: [wr('/etc/x', 'x', null)] });
		const res = await r.rt.createSession().run('x');
		assert.strictEqual(res.exitCode, 5);
		assert.strictEqual(res.applied, 0);
		r.rt.dispose();
	});

	await test('a change set that fails part-way is "N of M applied", and the status is raised', async () => {
		const r = createRig();
		r.ws.put('/scratch/a', 'a');
		r.ws.put('/scratch/b', 'b');
		r.ws.fail('writeFile', (k) => k.endsWith('/b'), new Error('quota'));
		ending(r, { changes: [wr('/scratch/a', 'A', 'a'), wr('/scratch/b', 'B', 'b')] });
		const res = await r.rt.createSession().run('x');
		assert.deepStrictEqual({ exitCode: res.exitCode, applied: res.applied }, { exitCode: 1, applied: 1 });
		assert.ok(/applied 1 of 2 file changes; stopped at \/scratch\/b: quota/.test(res.notes.join('\n')), res.notes.join('\n'));
		r.rt.dispose();
	});

	await test('what the engine refused to do (denied) raises the status; the engine already said it on stderr, so the host does not say it twice', async () => {
		const r = createRig();
		ending(r, {
			exitCode: 0,
			notes: ['None of its file changes were applied: it tried to change something this shell does not change (see above).'],
			denied: [{ path: '/etc/hosts', op: 'write', reason: 'outside', code: 'EACCES', message: '/etc/hosts: outside the workspace' }],
		}, 'bash: /etc/hosts: outside the workspace\n');
		const out = [];
		const res = await r.rt.createSession().run('echo x > /etc/hosts', { onStdout: (t) => out.push(t) });
		assert.strictEqual(res.exitCode, 1);
		assert.deepStrictEqual(res.notes, ['[LevelCode Shell: None of its file changes were applied: it tried to change something this shell does not change (see above).]']);
		assert.strictEqual(res.applied, 0);
		r.rt.dispose();
	});

	await test('at most 20 notes of the engine are kept (and a note is cut at 2000 characters)', async () => {
		const r = createRig();
		ending(r, { notes: Array.from({ length: 25 }, (_, i) => 'note ' + i) });
		let res = await r.rt.createSession().run('x');
		assert.strictEqual(res.notes.length, 20);
		assert.strictEqual(res.notes[19], '[LevelCode Shell: note 19]');
		ending(r, { notes: Array.from({ length: 20 }, (_, i) => 'note ' + i) });
		res = await r.rt.createSession().run('x');
		assert.strictEqual(res.notes.length, 20, 'exactly 20 are all kept');
		ending(r, { notes: ['n'.repeat(2000), 'm'.repeat(2001)] });
		res = await r.rt.createSession().run('x');
		assert.ok(res.notes[0].length === 2000 + '[LevelCode Shell: ]'.length && res.notes[1].length === 2000 + '[LevelCode Shell: ]'.length, res.notes.map((t) => t.length).join(','));
		r.rt.dispose();
	});

	await test('the engine\'s notes are kept, bounded and made safe; a note that is not text is dropped', async () => {
		const r = createRig();
		ending(r, { notes: ['plain note', '[LevelCode Shell: already formatted]', 'esc \x1b[2J here', 42, null, '', 'x'.repeat(5000)] });
		const res = await r.rt.createSession().run('x');
		assert.strictEqual(res.notes[0], '[LevelCode Shell: plain note]');
		assert.strictEqual(res.notes[1], '[LevelCode Shell: already formatted]');
		assert.ok(res.notes[2].includes('\u{241B}[2J') && !res.notes[2].includes('\x1b'));
		assert.strictEqual(res.notes.length, 4);
		assert.ok(res.notes[3].length < 2100);
		r.rt.dispose();
	});

	await test('a change set whose cwd is not a path: the session keeps its own; one that is, comes back normalised', async () => {
		const r = createRig();
		r.ws.mkdir('/scratch/b');
		const s = r.rt.createSession();
		ending(r, { cwd: '/scratch/a/../b//' });
		await s.run('x');
		assert.strictEqual(s.cwd, '/scratch/b');
		for (const bad of ['relative/path', '', 42, null, '/scratch\0x']) {
			ending(r, { cwd: bad });
			await s.run('x');
			assert.strictEqual(s.cwd, '/scratch/b', JSON.stringify(bad));
		}
		r.rt.dispose();
	});

	await test('a file where the command wrote below a folder is not a conflict, it is a failure to write: "stopped at", not "could not be checked"', async () => {
		const r = createRig();
		r.ws.put('/scratch/f', 'a file now');
		ending(r, { exitCode: 0, changes: [wr('/scratch/f/g.txt', 'x', null)] });
		const res = await r.rt.createSession().run('x');
		assert.strictEqual(res.applied, 0);
		assert.ok(/stopped at \/scratch\/f/.test(res.notes.join('')), res.notes.join(''));
		assert.ok(!/could not be checked/.test(res.notes.join('')), res.notes.join(''));
		assert.strictEqual(r.ws.text('/scratch/f'), 'a file now');
		r.rt.dispose();
	});

	await test('a malformed change set from the engine is refused, not thrown', async () => {
		const r = createRig();
		for (const changes of [[null], [{ kind: 'write' }], 'nope', [{ kind: 'write', path: '/scratch/a', existed: false, before: null, after: [1, 2, 3] }]]) {
			ending(r, { changes });
			const res = await r.rt.createSession().run('x');
			assert.strictEqual(res.how, 'exit');
			assert.ok(res.applied === 0);
		}
		assert.ok(!r.ws.exists('/scratch/a'));
		r.rt.dispose();
	});

	await test('the caps of a terminal line: 8 MiB a file, 32 MiB a run, 2000 entries', async () => {
		const r = createRig();
		const MiB = 1024 * 1024;
		const big = (/** @type {string} */ p, /** @type {number} */ size) => ({ kind: 'write', path: p, existed: false, before: null, after: new Uint8Array(size) });
		ending(r, { changes: [big('/scratch/a', 8 * MiB + 1)] });
		let res = await r.rt.createSession().run('x');
		assert.ok(/at most 8388608 per file/.test(res.notes.join('')), res.notes.join(''));
		ending(r, { changes: [big('/scratch/a', 8 * MiB), big('/scratch/b', 8 * MiB), big('/scratch/c', 8 * MiB), big('/scratch/d', 8 * MiB), big('/scratch/e', 1)] });
		res = await r.rt.createSession().run('x');
		assert.ok(/at most 33554432 per command/.test(res.notes.join('')), res.notes.join(''));
		ending(r, { changes: Array.from({ length: 2001 }, (_, i) => mkdir('/scratch/d' + i)) });
		res = await r.rt.createSession().run('x');
		assert.ok(/changed 2001 files and folders; at most 2000/.test(res.notes.join('')), res.notes.join(''));
		assert.strictEqual(res.applied, 0);
		r.rt.dispose();
	});

	/* ===== an agent run: levelcode-ai's review decides ================================================ */

	await test('the review gets the change set in the paths the agent uses, once; what it hands back is applied; its notes end the stderr; THEN close', async () => {
		const r = createRig({ workspace: { folders: [{ name: 'scratch', uri: 'levelcode-scratch:///scratch' }] } });
		r.ws.put('/scratch/a.txt', 'old');
		ending(r, { exitCode: 0, changes: [wr('/scratch/a.txt', 'new', 'old'), mkdir('/scratch/made'), rmdir('/scratch/empty')] }, 'ran\n');
		r.ws.mkdir('/scratch/empty');
		/** @type {any[]} */ const seen = [];
		const res = await agent(r, 'x', {
			folders: [{ name: 'scratch', root: '/scratch', uri: 'levelcode-scratch:///scratch' }],
			commit: async (/** @type {any[]} */ changes) => {
				seen.push(changes.map((c) => c.kind + ' ' + c.path));
				// the review applies the file change itself (through the editor) and leaves the folders to the shell
				await r.ws.fs.writeFile(r.ws.vscode.Uri.parse('levelcode-scratch:///scratch/a.txt'), te.encode('new'));
				return { rest: changes.filter((c) => c.kind === 'mkdir' || c.kind === 'rmdir'), notes: ['[LevelCode Shell: 1 file changed, ready for Keep/Undo: ~a.txt]'], failed: 0 };
			},
		});
		assert.deepStrictEqual(seen, [['write /scratch/a.txt', 'mkdir /scratch/made', 'rmdir /scratch/empty']]);
		assert.strictEqual(res.code, 0);
		assert.strictEqual(res.stdout, 'ran\n');
		assert.strictEqual(res.stderr, '[LevelCode Shell: 1 file changed, ready for Keep/Undo: ~a.txt]\n');
		assert.strictEqual(r.ws.isDir('/scratch/made'), true, 'the folders the review leaves are made by the shell');
		assert.strictEqual(r.ws.exists('/scratch/empty'), false);
		assert.deepStrictEqual(res.log, ['data', 'data', 'close'], 'stdout, then the notes as stderr, then close');
		r.rt.dispose();
	});

	await test('the review is not the terminal\'s commit: a file change it does not take is not written by the shell', async () => {
		const r = createRig();
		r.ws.put('/scratch/a.txt', 'old');
		ending(r, { changes: [wr('/scratch/a.txt', 'new', 'old')] });
		const res = await agent(r, 'x', { commit: async () => ({ rest: [], notes: [], failed: 0 }) });
		assert.strictEqual(res.code, 0);
		assert.strictEqual(r.ws.text('/scratch/a.txt'), 'old', 'only the review writes a reviewed file');
		r.rt.dispose();
	});

	await test('a review that reports failures: the status is raised from 0, and the leftovers are not trusted to the shell when it refused whole', async () => {
		const r = createRig();
		ending(r, { exitCode: 0, changes: [wr('/scratch/a', 'a', null), mkdir('/scratch/d')] });
		let res = await agent(r, 'x', { commit: async () => ({ rest: [mkdir('/scratch/d')], notes: ['[LevelCode Shell: NOT applied: a]'], failed: 1 }) });
		assert.strictEqual(res.code, 1);
		assert.strictEqual(r.ws.isDir('/scratch/d'), true, 'a partial review still leaves its folders to the shell');
		r.ws.fail('createDirectory', () => true, new Error('no'));
		ending(r, { exitCode: 0, changes: [wr('/scratch/a', 'a', null), mkdir('/scratch/e')] });
		res = await agent(r, 'x', { commit: async () => ({ rest: [mkdir('/scratch/e')], notes: [], refused: true, failed: 2 }) });
		assert.strictEqual(res.code, 1);
		assert.ok(!r.ws.calls.some((c) => c.endsWith('/scratch/e') && c.startsWith('createDirectory')), 'refused whole: nothing left for the shell to do');
		r.rt.dispose();
	});

	await test('a review that THROWS: the status is 1, one honest note, and the shell applies nothing of its own', async () => {
		const r = createRig();
		ending(r, { exitCode: 0, changes: [wr('/scratch/a', 'a', null), mkdir('/scratch/d')] });
		const res = await agent(r, 'x', { commit: async () => { throw new Error('openTextDocument failed'); } });
		assert.strictEqual(res.code, 1);
		assert.ok(/could not be applied \(openTextDocument failed\); some of them may have been/.test(res.stderr), res.stderr);
		assert.strictEqual(r.ws.exists('/scratch/d'), false);
		r.rt.dispose();
	});

	await test('a change set with a path outside every folder never reaches the review', async () => {
		const r = createRig();
		ending(r, { exitCode: 0, changes: [wr('/scratch/a', 'a', null), wr('/home/user/.ssh/authorized_keys', 'k', null)] });
		let called = 0;
		const res = await agent(r, 'x', { commit: async () => { called++; return { rest: [], notes: [], failed: 0 }; } });
		assert.strictEqual(called, 0);
		assert.strictEqual(res.code, 1);
		assert.ok(/authorized_keys is outside the workspace folders/.test(res.stderr), res.stderr);
		assert.ok(/NONE of this command's file changes were applied/.test(res.stderr));
		r.rt.dispose();
	});

	await test('a second signal while the changes are being applied does not change the first: SIGTERM then SIGKILL is 130', async () => {
		const r = createRig();
		ending(r, { exitCode: 0, changes: [wr('/scratch/a', 'a', null)] });
		let release = () => { };
		const hold = new Promise((res) => { release = () => res(undefined); });
		let asked = () => { };
		const reviewed = new Promise((res) => { asked = () => res(undefined); });
		const child = r.rt.spawnAgent('x', { cwd: '/scratch', commit: async () => { asked(); await hold; return { rest: [], notes: [], failed: 0 }; } });
		const o = observe(child, 3000);
		await reviewed;
		assert.strictEqual(child.kill('SIGTERM'), true);
		assert.strictEqual(child.kill('SIGKILL'), true);
		release();
		await o.closed;
		assert.strictEqual(/** @type {any} */ (o.events[o.events.length - 1]).code, 130);
		r.rt.dispose();
	});

	await test('a spawn with no review (no opts.commit) is committed like the terminal\'s', async () => {
		const r = createRig();
		ending(r, { changes: [wr('/scratch/direct.txt', 'd', null)] });
		const res = await agent(r, 'x', {});
		assert.strictEqual(res.code, 0);
		assert.strictEqual(r.ws.text('/scratch/direct.txt'), 'd');
		r.rt.dispose();
	});

	await test('an agent run is held to the smaller caps: 1 MiB a file, 8 MiB a run', async () => {
		const r = createRig();
		const MiB = 1024 * 1024;
		let called = 0;
		ending(r, { changes: [{ kind: 'write', path: '/scratch/a', existed: false, before: null, after: new Uint8Array(MiB + 1) }] });
		const res = await agent(r, 'x', { commit: async () => { called++; return { rest: [], notes: [], failed: 0 }; } });
		assert.strictEqual(called, 0);
		assert.ok(/at most 1048576 per file/.test(res.stderr), res.stderr);
		assert.strictEqual(r.engines.workers[0].runs[0].caps.writeFile, MiB);
		assert.strictEqual(r.engines.workers[0].runs[0].caps.writeRun, 8 * MiB);
		r.rt.dispose();
	});

	await test('every how but exit: the review is not called at all, and the status is the how\'s', async () => {
		for (const [how, status] of NOT_EXIT) {
			const r = createRig();
			ending(r, { how, exitCode: 0, changes: [wr('/scratch/a', 'a', null)] });
			let called = 0;
			const res = await agent(r, 'x', { commit: async () => { called++; return { rest: [], notes: [], failed: 0 }; } });
			assert.strictEqual(called, 0, how);
			assert.strictEqual(res.code, status, how);
			assert.ok(/NOT applied/.test(res.stderr), how + ': ' + res.stderr);
			r.rt.dispose();
		}
	});

	await test('Stop while the agent\'s review is going on ends the run AT ONCE: a review cannot be interrupted, so it is given up on, and what it answers later is not applied', async () => {
		const r = createRig();
		ending(r, { exitCode: 0, changes: [wr('/scratch/a', 'a', null), mkdir('/scratch/d')] });
		/** @type {any} */ let child;
		let release = () => { };
		const hold = new Promise((res) => { release = () => res(undefined); });
		const killed = new Promise((res) => {
			child = r.rt.spawnAgent('x', {
				cwd: '/scratch',
				commit: async (/** @type {any[]} */ changes) => { res(undefined); await hold; return { rest: [mkdir('/scratch/d')], notes: ['[LevelCode Shell: 2 files changed]'], failed: 0 }; },
			});
		});
		const obs = observe(child, 3000);
		await killed;
		assert.strictEqual(child.kill('SIGTERM'), true);
		await obs.closed;                       // before the review has answered
		const close = /** @type {any} */ (obs.events.find((e) => e.type === 'close'));
		assert.strictEqual(close.code, 130);
		assert.ok(/stopped while the review of its file changes was going on\. A review cannot be interrupted: it may still apply some of them, and how many it applied is not known\./.test(obs.stderr), obs.stderr);
		assert.ok(!/were NOT applied/.test(obs.stderr), 'it does not say nothing was applied: it does not know');
		release();
		await flush();
		await flush();
		assert.strictEqual(r.ws.exists('/scratch/d'), false, 'the folders the late review leaves are not made');
		assert.strictEqual(obs.events.filter((e) => e.type === 'close').length, 1);
		r.rt.dispose();
		assert.strictEqual(r.clock.pending, 0, 'no timer is left behind');
	});

	await test('a read that arrives while the change set is being applied is not answered and does not touch the workspace', async () => {
		const r = createRig();
		r.ws.put('/scratch/a.txt', 'x');
		let release = () => { };
		const hold = new Promise((res) => { release = () => res(undefined); });
		r.engines.state.onRun = async (run, w, h) => { h.done({ changes: [wr('/scratch/new.txt', 'n', null)] }); await flush(); h.fsNoWait('readFile', '/scratch/a.txt'); };
		const child = r.rt.spawnAgent('x', { cwd: '/scratch', commit: async () => { await hold; return { rest: [], notes: [], failed: 0 }; } });
		const o = observe(child, 3000);
		await flush();
		await flush();
		assert.ok(!r.engines.workers[0].sent.some((/** @type {any} */ m) => m.t === 'fsr'), 'no answer while it is committing');
		assert.ok(!r.ws.calls.some((c) => c.includes('a.txt')), r.ws.calls.join(','));
		release();
		await o.closed;
		r.rt.dispose();
	});

	await test('a write that never answers does not hold the run for ever: 60 s, then "stopped at", and the status is raised', async () => {
		const r = createRig();
		r.ws.put('/scratch/a', 'a');
		r.ws.hang('writeFile', (k) => k.endsWith('/a'));
		ending(r, { changes: [wr('/scratch/a', 'A', 'a')] });
		const p = r.rt.createSession().run('x');
		await until(() => r.ws.calls.some((c) => c.startsWith('writeFile ')));
		await r.clock.advance(59999);
		await r.clock.advance(1);
		const res = await p;
		assert.deepStrictEqual({ exit: res.exitCode, applied: res.applied }, { exit: 1, applied: 0 });
		assert.ok(/stopped at \/scratch\/a: timed out\. That call was not answered and cannot be cancelled: it may still land\. The rest were not applied\./.test(res.notes.join('')), res.notes.join(''));
		r.rt.dispose();
	});

	await test('a stat that never answers while the change set is checked refuses the set after 60 s ("could not be checked in time"), not a hang', async () => {
		const r = createRig();
		r.ws.put('/scratch/a', 'a');
		let hung = false;
		ending(r, { changes: [wr('/scratch/a', 'A', 'a')] });
		r.ws.hang('stat', (k) => { if (k.endsWith('/a')) { hung = true; return true; } return false; });
		const p = r.rt.createSession().run('x');
		await until(() => hung);
		await r.clock.advance(60000);
		const res = await p;
		assert.deepStrictEqual({ exit: res.exitCode, applied: res.applied }, { exit: 1, applied: 0 });
		assert.ok(/could not be checked in time: \/scratch\/a: timed out \(0 of 1 were checked\)/.test(res.notes.join('')), res.notes.join(''));
		assert.strictEqual(r.ws.text('/scratch/a'), 'a');
		r.rt.dispose();
	});

	await test('a review that never answers is given 120 s, then the run is closed with what is known', async () => {
		const r = createRig();
		ending(r, { changes: [wr('/scratch/a', 'A', null)] });
		let asked = false;
		const child = r.rt.spawnAgent('x', { cwd: '/scratch', commit: () => { asked = true; return new Promise(() => { }); } });
		const o = observe(child, 3000);
		await until(() => asked);
		await r.clock.advance(119999);
		assert.strictEqual(o.events.some((e) => e.type === 'close'), false);
		await r.clock.advance(1);
		await o.closed;
		assert.strictEqual(/** @type {any} */ (o.events[o.events.length - 1]).code, 1);
		assert.ok(/could not be applied \(timed out\); some of them may have been/.test(o.stderr), o.stderr);
		r.rt.dispose();
	});

	await test('a folder the engine cannot hold: the review is handed paths in the agent\'s own terms, not the mount\'s', async () => {
		const r = createRig({ workspace: { folders: [{ name: 'tmp', uri: 'file:///tmp' }] } });
		ending(r, { exitCode: 0, changes: [wr('/mnt/tmp/a.txt', 'a', null)] });
		/** @type {any[]} */ let seen = [];
		const res = await agent(r, 'x', {
			cwd: '/tmp', folders: [{ name: 'tmp', root: '/tmp', uri: 'file:///tmp' }],
			commit: async (/** @type {any[]} */ changes) => { seen = changes.map((c) => c.path); return { rest: [], notes: [], failed: 0 }; },
		});
		assert.deepStrictEqual(seen, ['/tmp/a.txt']);
		assert.strictEqual(res.code, 0);
		assert.strictEqual(r.engines.workers[0].runs[0].cwd, '/mnt/tmp');
		r.rt.dispose();
	});

	/* ===== a commit that is going on is never reported as something else ================================ */

	/** A workspace whose writes wait at a gate until it is opened; `reached` says when the first one is waiting. */
	function gatedWrites(/** @type {any} */ r) {
		let open = () => { };
		const gate = new Promise((res) => { open = () => res(undefined); });
		let reached = () => { };
		const first = new Promise((res) => { reached = () => res(undefined); });
		const real = r.ws.fs.writeFile.bind(r.ws.fs);
		r.ws.fs.writeFile = async (/** @type {any} */ u, /** @type {Uint8Array} */ b) => { reached(); await gate; return real(u, b); };
		return { open, reached: first };
	}
	const TWO = [wr('/scratch/a.txt', 'A', null), wr('/scratch/b.txt', 'B', null)];
	/** @param {Promise<any>} p */
	function watch(p) { const o = { done: false, value: /** @type {any} */ (null) }; p.then((v) => { o.done = true; o.value = v; }); return o; }

	await test('a worker that dies after `done` while its changes are being written: the run waits for them and says what it really applied', async () => {
		/** @type {Array<[string, (w: any) => void]>} */
		const ways = [['an error event', (w) => w.crash('late exception')], ['a messageerror', (w) => w.onmessageerror({})]];
		for (const [how, kill] of ways) {
			const r = createRig();
			const g = gatedWrites(r);
			/** @type {any} */ let worker;
			r.engines.state.onRun = async (run, w, h) => { worker = w; h.done({ exitCode: 0, how: 'exit', changes: TWO }); };
			const s = r.rt.createSession();
			const p = watch(s.run('x'));
			await g.reached;
			kill(worker);
			await flush();
			assert.strictEqual(p.done, false, how + ': settled while the commit was still going on');
			assert.strictEqual(worker.terminated, true, 'the dead worker is forgotten at once');
			g.open();
			await until(() => p.done);
			const res = p.value;
			assert.deepStrictEqual({ how: res.how, exitCode: res.exitCode, applied: res.applied }, { how: 'exit', exitCode: 0, applied: 2 }, how);
			assert.ok(!/NOT applied/.test(res.notes.join('\n')), 'the files are on disk: ' + res.notes.join('\n'));
			assert.ok(/stopped unexpectedly|could not be read/.test(res.notes.join('\n')) && /after the command had finished/.test(res.notes.join('\n')), res.notes.join('\n'));
			assert.deepStrictEqual(r.ws.list('/scratch'), ['a.txt', 'b.txt']);
			assert.ok(r.logs.some((l) => l[0] === 'worker-failed'));
			// the session goes on, with a new worker
			r.engines.state.onRun = async (run, w, h) => { h.done({}); };
			assert.strictEqual((await s.run('again')).how, 'exit');
			assert.strictEqual(r.engines.workers.length, 2);
			r.rt.dispose();
		}
	});

	await test('the same for an agent run: close comes after the review, with its notes, and its status is the script\'s', async () => {
		const r = createRig();
		/** @type {any} */ let worker;
		let release = () => { };
		const hold = new Promise((res) => { release = () => res(undefined); });
		let asked = () => { };
		const reviewed = new Promise((res) => { asked = () => res(undefined); });
		r.engines.state.onRun = async (run, w, h) => { worker = w; h.done({ exitCode: 3, how: 'exit', changes: TWO }); };
		const child = r.rt.spawnAgent('x', {
			cwd: '/scratch',
			commit: async () => { asked(); await hold; return { rest: [], notes: ['[LevelCode Shell: 2 files changed]'], failed: 0 }; },
		});
		const o = observe(child, 3000);
		await reviewed;
		worker.crash('segfault');
		await flush();
		assert.strictEqual(o.events.some((e) => e.type === 'close'), false, 'still waiting for the review');
		release();
		await o.closed;
		assert.strictEqual(/** @type {any} */ (o.events[o.events.length - 1]).code, 3);
		assert.ok(o.stderr.includes('[LevelCode Shell: 2 files changed]') && /after the command had finished/.test(o.stderr) && !/NOT applied/.test(o.stderr), o.stderr);
		r.rt.dispose();
	});

	await test('Stop and dispose() while the changes are being written end the run AT ONCE: what is confirmed is counted, the write in flight may still land, and nothing more is started', async () => {
		for (const what of ['runtime.dispose', 'session.dispose', 'session.stop']) {
			const r = createRig();
			const g = gatedWrites(r);
			r.engines.state.onRun = async (run, w, h) => { h.done({ exitCode: 0, how: 'exit', changes: TWO }); };
			const s = r.rt.createSession();
			const p = watch(s.run('x'));
			await g.reached;                   // a.txt is being written and has not been answered
			if (what === 'runtime.dispose') { r.rt.dispose(); } else if (what === 'session.dispose') { s.dispose(); } else { s.stop(); }
			await flush();
			assert.strictEqual(p.done, true, what + ': the run did not wait for the write');
			const res = p.value;
			assert.strictEqual(res.how, 'aborted', what);
			assert.strictEqual(res.exitCode, what === 'session.stop' ? 130 : 137, what);
			assert.strictEqual(res.applied, 0, what + ': nothing is CONFIRMED');
			assert.deepStrictEqual(res.notes, ['[LevelCode Shell: stopped while its file changes were being applied: 0 of 2 were applied. The change being made at that moment cannot be cancelled and may still land; nothing more was started.]'], what);
			g.open();                           // the write the provider was holding now lands
			await flush();
			await flush();
			assert.deepStrictEqual(r.ws.list('/scratch'), ['a.txt'], what + ': the one in flight landed (it cannot be taken back), the second was never started');
			assert.deepStrictEqual(r.ws.calls.filter((c) => /^(writeFile|createDirectory|delete) /.test(c)), ['writeFile levelcode-scratch:/scratch/a.txt'], what + ': no write was started after the stop');
			assert.strictEqual(p.value, res, what + ': and the result does not change');
			r.rt.dispose();
			assert.strictEqual(r.clock.pending, 0, what + ': a timer was left behind');
		}
	});

	await test('a Stop after some writes were answered counts them: "1 of 3 were applied", and the session is free at once', async () => {
		const r = createRig();
		const real = r.ws.fs.writeFile.bind(r.ws.fs);
		/** @type {() => void} */ let release = () => { };
		let writes = 0;
		r.ws.fs.writeFile = async (/** @type {any} */ u, /** @type {Uint8Array} */ b) => {
			writes++;
			if (writes === 2) { await new Promise((res) => { release = () => res(undefined); }); }
			return real(u, b);
		};
		const three = [wr('/scratch/a.txt', 'A', null), wr('/scratch/b.txt', 'B', null), wr('/scratch/c.txt', 'C', null)];
		r.engines.state.onRun = async (run, w, h) => { h.done({ exitCode: 0, how: 'exit', changes: run.script === 'again' ? [] : three }); };
		const s = r.rt.createSession();
		const p = watch(s.run('x'));
		await until(() => writes === 2);
		s.stop();
		await flush();
		assert.strictEqual(p.done, true);
		assert.strictEqual(p.value.applied, 1);
		assert.ok(/stopped while its file changes were being applied: 1 of 3 were applied\./.test(p.value.notes[0]), p.value.notes[0]);
		const again = await s.run('again');        // not 'busy': the line is free
		assert.strictEqual(again.how, 'exit');
		release();
		await flush();
		assert.deepStrictEqual(r.ws.list('/scratch'), ['a.txt', 'b.txt']);
		r.rt.dispose();
	});

	await test('dispose() of the runtime while an agent\'s review is going on: close (137) comes at once, and the review\'s late answer changes nothing', async () => {
		const r = createRig();
		r.engines.state.onRun = async (run, w, h) => { h.done({ exitCode: 0, how: 'exit', changes: [wr('/scratch/a', 'a', null), mkdir('/scratch/d')] }); };
		let release = () => { };
		const hold = new Promise((res) => { release = () => res(undefined); });
		let asked = () => { };
		const reviewed = new Promise((res) => { asked = () => res(undefined); });
		const child = r.rt.spawnAgent('x', { cwd: '/scratch', commit: async () => { asked(); await hold; return { rest: [mkdir('/scratch/d')], notes: ['[LevelCode Shell: 1 file changed]'], failed: 0 }; } });
		const o = observe(child, 3000);
		await reviewed;
		r.rt.dispose();
		await o.closed;                        // not waiting for the review
		assert.strictEqual(/** @type {any} */ (o.events[o.events.length - 1]).code, 137);
		assert.ok(/stopped while the review of its file changes was going on/.test(o.stderr), o.stderr);
		release();
		await flush();
		await flush();
		assert.strictEqual(r.ws.exists('/scratch/d'), false, 'the folders are not made after a stop: the review\'s file change was its own');
		assert.ok(!/NOT applied\.$/m.test(o.stderr));
		assert.strictEqual(o.events.filter((e) => e.type === 'close').length, 1);
	});

	/** Hold every stat of a path until released. */
	function gatedStat(/** @type {any} */ r, /** @type {RegExp} */ re) {
		let open = () => { };
		const gate = new Promise((res) => { open = () => res(undefined); });
		let reached = () => { };
		const first = new Promise((res) => { reached = () => res(undefined); });
		const real = r.ws.fs.stat.bind(r.ws.fs);
		r.ws.fs.stat = async (/** @type {any} */ u) => { if (re.test(u.path)) { reached(); await gate; } return real(u); };
		return { open, reached: first };
	}

	await test('Stop while the change set is only being CHECKED: nothing is written, and the run says it was stopped before anything was applied', async () => {
		const r = createRig();
		r.ws.put('/scratch/old.txt', 'old');
		const g = gatedStat(r, /old\.txt$/);
		r.engines.state.onRun = async (run, w, h) => { h.done({ exitCode: 0, how: 'exit', changes: [wr('/scratch/old.txt', 'new', 'old'), wr('/scratch/other.txt', 'o', null), mkdir('/scratch/d')] }); };
		const s = r.rt.createSession();
		const p = watch(s.run('x'));
		await g.reached;                    // the conflict check is reading old.txt
		s.stop();
		await flush();
		assert.strictEqual(p.done, true, 'a read is harmless to give up on: the Stop does not wait for it');
		g.open();
		await flush();
		const res = p.value;
		assert.deepStrictEqual({ how: res.how, exitCode: res.exitCode, applied: res.applied }, { how: 'aborted', exitCode: 130, applied: 0 });
		assert.ok(/stopped before anything was applied/.test(res.notes.join('\n')), res.notes.join('\n'));
		assert.ok(!/while its file changes were being applied/.test(res.notes.join('\n')));
		assert.deepStrictEqual(r.ws.calls.filter((c) => /^(writeFile|createDirectory|delete) /.test(c)), [], 'not one write');
		assert.strictEqual(r.ws.text('/scratch/old.txt'), 'old');
		r.rt.dispose();
	});

	await test('Stop between the checks of two files stops the checking there: the second is never read', async () => {
		const r = createRig();
		r.ws.put('/scratch/a', 'a');
		r.ws.put('/scratch/b', 'b');
		const g = gatedStat(r, /\/a$/);
		r.engines.state.onRun = async (run, w, h) => { h.done({ exitCode: 0, how: 'exit', changes: [wr('/scratch/a', 'A', 'a'), wr('/scratch/b', 'B', 'b')] }); };
		const s = r.rt.createSession();
		const p = watch(s.run('x'));
		await g.reached;
		s.stop();
		g.open();
		await until(() => p.done);
		await flush();
		assert.strictEqual(p.value.applied, 0);
		assert.ok(!r.ws.calls.some((c) => c === 'stat levelcode-scratch:/scratch/b'), 'b was not even looked at: ' + r.ws.calls.join(','));
		r.rt.dispose();
	});

	await test('an agent\'s SIGKILL during the review: close (137) at once, the folders the review leaves later are NOT made, and the review can see it was stopped', async () => {
		const r = createRig();
		r.engines.state.onRun = async (run, w, h) => { h.done({ exitCode: 0, how: 'exit', changes: [wr('/scratch/a', 'a', null), mkdir('/scratch/d')] }); };
		let release = () => { };
		const hold = new Promise((res) => { release = () => res(undefined); });
		let asked = () => { };
		const reviewed = new Promise((res) => { asked = () => res(undefined); });
		/** @type {boolean[]} */ const asks = [];
		const child = r.rt.spawnAgent('x', {
			cwd: '/scratch',
			commit: async (/** @type {any} */ cs, /** @type {any} */ control) => { asks.push(control.cancelled()); asked(); await hold; asks.push(control.cancelled()); return { rest: [mkdir('/scratch/d')], notes: [], failed: 0 }; },
		});
		const o = observe(child, 3000);
		await reviewed;
		assert.strictEqual(child.kill('SIGKILL'), true);
		await o.closed;                        // the review has not answered
		assert.strictEqual(/** @type {any} */ (o.events[o.events.length - 1]).code, 137);
		assert.ok(/stopped while the review of its file changes was going on/.test(o.stderr), o.stderr);
		release();
		await flush();
		await flush();
		assert.strictEqual(r.ws.exists('/scratch/d'), false);
		assert.deepStrictEqual(asks, [false, true], 'the review can ask whether the command was stopped: no before, yes after');
		r.rt.dispose();
	});

	await test('a folder that gained a file after the command ran is NOT removed with it: rmdir is not recursive (a data-loss guard, pinned at the workspace call)', async () => {
		/** @type {any[]} */ const deletes = [];
		for (const route of ['terminal', 'agent']) {
			const r = createRig();
			r.ws.mkdir('/scratch/d');
			r.ws.put('/scratch/d/late.txt', 'written by someone else after the command ran');
			const real = r.ws.fs.delete.bind(r.ws.fs);
			r.ws.fs.delete = async (/** @type {any} */ u, /** @type {any} */ opts) => { deletes.push(opts); return real(u, opts); };
			ending(r, { exitCode: 0, changes: [rmdir('/scratch/d')] });
			let res;
			if (route === 'terminal') {
				const x = await r.rt.createSession().run('rmdir d');
				res = { code: x.exitCode, applied: x.applied, text: x.notes.join('\n') };
			} else {
				const x = await agent(r, 'rmdir d', { commit: async (/** @type {any[]} */ cs) => ({ rest: cs, notes: [], failed: 0 }) });
				res = { code: x.code, applied: -1, text: x.stderr };
			}
			assert.strictEqual(res.code, 1, route);
			assert.ok(/stopped at \/scratch\/d/.test(res.text), route + ': ' + res.text);
			assert.strictEqual(r.ws.text('/scratch/d/late.txt'), 'written by someone else after the command ran', route + ': the file is still there');
			assert.strictEqual(r.ws.isDir('/scratch/d'), true);
			r.rt.dispose();
		}
		assert.ok(deletes.length >= 2 && deletes.every((o) => o && o.recursive === false), 'every delete says recursive: false: ' + JSON.stringify(deletes));
	});

	await test('deleting a file is not recursive either, and says no trash: the file system is asked for exactly that', async () => {
		const r = createRig();
		r.ws.put('/scratch/gone.txt', 'bye');
		/** @type {any[]} */ const opts = [];
		const real = r.ws.fs.delete.bind(r.ws.fs);
		r.ws.fs.delete = async (/** @type {any} */ u, /** @type {any} */ o) => { opts.push(o); return real(u, o); };
		ending(r, { changes: [del('/scratch/gone.txt', 'bye')] });
		await r.rt.createSession().run('rm gone.txt');
		assert.deepStrictEqual(opts, [{ recursive: false, useTrash: false }]);
		r.rt.dispose();
	});


	/* ===== a commit is bounded, and a Stop does not wait for it ======================================== */

	/** Every `op` of the workspace answers after `ms` of the rig's own clock (the paths `only` says yes to). */
	function slow(/** @type {any} */ r, /** @type {string} */ op, /** @type {number} */ ms, /** @type {(p: string) => boolean} */ only) {
		const real = r.ws.fs[op].bind(r.ws.fs);
		r.ws.fs[op] = async (/** @type {any} */ ...a) => {
			if (!only || only(a[0].path)) { await new Promise((res) => r.clock.setTimeout(() => res(undefined), ms)); }
			return real(...a);
		};
	}
	/** Let a run get as far as it can without the clock moving: the fake engine's own turns are macrotasks. */
	async function settle() { for (let i = 0; i < 5; i++) { await flush(); } }
	const FIVE = ['a', 'b', 'c', 'd', 'e'];
	const checkFive = (/** @type {any} */ r) => { for (const f of FIVE) { r.ws.put('/scratch/' + f, f); } return FIVE.map((f) => wr('/scratch/' + f, f.toUpperCase(), f)); };
	const writes = (/** @type {any} */ r) => r.ws.calls.filter((/** @type {string} */ c) => /^(writeFile|createDirectory|delete) /.test(c));

	await test('a provider that never answers costs ONE wait for the whole check, not one per file: five files, refused at 60 s (not 300), one stat asked, how far it got', async () => {
		const r = createRig();
		const changes = checkFive(r);
		r.ws.hang('stat', (k) => /\/scratch\/[a-e]$/.test(k));
		ending(r, { changes });
		const p = watch(r.rt.createSession().run('x'));
		await until(() => r.ws.calls.some((c) => /^stat .*\/scratch\/a$/.test(c)));
		await r.clock.advance(59999);
		assert.strictEqual(p.done, false);
		await r.clock.advance(1);
		assert.strictEqual(p.done, true, 'settled at 60 s');
		assert.deepStrictEqual({ how: p.value.how, exit: p.value.exitCode, applied: p.value.applied }, { how: 'exit', exit: 1, applied: 0 });
		assert.deepStrictEqual(p.value.notes, [
			'[LevelCode Shell: refused: the changes could not be checked in time: /scratch/a: timed out (0 of 5 were checked)]',
			'[LevelCode Shell: NONE of this command\'s file changes were applied.]',
		]);
		assert.deepStrictEqual(r.ws.calls.filter((c) => /^stat .*\/scratch\/[a-e]$/.test(c)), ['stat levelcode-scratch:/scratch/a'], 'the other four were not asked');
		assert.deepStrictEqual(writes(r), []);
		r.rt.dispose();
		assert.strictEqual(r.clock.pending, 0);
	});

	await test('a provider that is slow but alive has checkMs IN ALL: 25 s a file, five files, refused at 60 s (not 125 s) after two were checked', async () => {
		const r = createRig();
		const changes = checkFive(r);
		slow(r, 'stat', 25000, (p) => /\/scratch\/[a-e]$/.test(p));
		ending(r, { changes });
		const p = watch(r.rt.createSession().run('x'));
		await settle();                       // the run has reached its first stat (the clock does not move before it)
		await r.clock.advance(59999);
		assert.strictEqual(p.done, false);
		await r.clock.advance(1);
		assert.strictEqual(p.done, true, 'at 60 s: ' + r.clock.now());
		assert.strictEqual(p.value.notes[0], '[LevelCode Shell: refused: the changes could not be checked in time: /scratch/c: ran out of time: the check gets 60 s in all (2 of 5 were checked)]');
		assert.deepStrictEqual(writes(r), []);
		assert.strictEqual(r.ws.text('/scratch/a'), 'a');
		r.rt.dispose();
	});

	await test('the check budget is exact: four 25 ms files fit in 100 ms and the fifth is refused before it is asked', async () => {
		for (const [count, ok] of /** @type {Array<[number, boolean]>} */ ([[4, true], [5, false]])) {
			const r = createRig({ limits: { workers: { checkMs: 100, fsMs: 1000 } } });
			const names = FIVE.slice(0, count);
			for (const f of names) { r.ws.put('/scratch/' + f, f); }
			slow(r, 'stat', 25, (p) => /\/scratch\/[a-e]$/.test(p));
			// (existed, nothing read of it: the check is one stat a file)
			ending(r, { changes: names.map((f) => ({ kind: 'write', path: '/scratch/' + f, existed: true, before: null, after: te.encode(f.toUpperCase()) })) });
			const p = watch(r.rt.createSession().run('x'));
			await settle();
			await r.clock.advance(200);
			assert.strictEqual(p.done, true, count + ' files');
			if (ok) {
				assert.deepStrictEqual({ exit: p.value.exitCode, applied: p.value.applied }, { exit: 0, applied: 4 }, 'exactly the budget passes');
				assert.strictEqual(r.ws.text('/scratch/d'), 'D');
			} else {
				assert.strictEqual(p.value.applied, 0);
				assert.ok(/could not be checked in time: \/scratch\/e: ran out of time: the check gets 100 ms in all \(4 of 5 were checked\)/.test(p.value.notes[0]), p.value.notes[0]);
				assert.strictEqual(r.ws.calls.filter((c) => c === 'stat levelcode-scratch:/scratch/e').length, 0, 'the fifth was never asked: the budget was spent');
			}
			r.rt.dispose();
		}
	});

	await test('Stop while a provider that never answers is being asked in the check: the run ends AT ONCE, nothing is written, and the line is free', async () => {
		const r = createRig();
		const changes = checkFive(r);
		r.ws.hang('stat', (k) => /\/scratch\/[a-e]$/.test(k));
		let first = true;
		r.engines.state.onRun = async (run, w, h) => { h.done({ exitCode: 0, how: 'exit', changes: first ? changes : [] }); first = false; };
		const s = r.rt.createSession();
		const p = watch(s.run('x'));
		await until(() => r.ws.calls.some((c) => /^stat .*\/scratch\/a$/.test(c)));
		await r.clock.advance(1000);
		s.stop();
		await flush();
		assert.strictEqual(p.done, true, 'one second after the run started: the Stop did not wait for the 60 s');
		assert.deepStrictEqual({ how: p.value.how, exit: p.value.exitCode, applied: p.value.applied }, { how: 'aborted', exit: 130, applied: 0 });
		assert.deepStrictEqual(p.value.notes, ['[LevelCode Shell: stopped before anything was applied: the command\'s file changes were being checked, and were NOT applied.]']);
		assert.deepStrictEqual(writes(r), []);
		assert.strictEqual((await s.run('again')).how, 'exit', 'not busy');
		r.rt.dispose();
		assert.strictEqual(r.clock.pending, 0, 'the 60 s timer of the call that was given up on is gone');
	});

	await test('a write that never answers: stopped at 60 s with the count that is confirmed, "may still land", the line is free; the same through the rig the terminal used', async () => {
		const r = createRig();
		const two = [wr('/scratch/a', 'A', null), wr('/scratch/b', 'B', null)];
		r.ws.hang('writeFile', (k) => k.endsWith('/b'));
		let n = 0;
		r.engines.state.onRun = async (run, w, h) => { h.done({ exitCode: 0, how: 'exit', changes: n++ === 0 ? two : [] }); };
		const s = r.rt.createSession();
		const p = watch(s.run('x'));
		await until(() => r.ws.calls.some((c) => /^writeFile .*\/scratch\/b$/.test(c)));
		await r.clock.advance(59999);
		assert.strictEqual(p.done, false);
		await r.clock.advance(1);
		assert.strictEqual(p.done, true, 'settled at 60 s, not "busy for ever"');
		assert.deepStrictEqual({ how: p.value.how, exit: p.value.exitCode, applied: p.value.applied }, { how: 'exit', exit: 1, applied: 1 });
		assert.strictEqual(p.value.notes[0], '[LevelCode Shell: applied 1 of 2 file changes; stopped at /scratch/b: timed out. That call was not answered and cannot be cancelled: it may still land. The rest were not applied.]');
		assert.strictEqual(r.ws.text('/scratch/a'), 'A');
		assert.strictEqual((await s.run('next')).how, 'exit', 'the session is free');
		r.rt.dispose();
	});

	await test('a hung folder removal or creation of the terminal commit is bounded the same way', async () => {
		for (const [op, change, setup] of /** @type {Array<[string, any, (r: any) => void]>} */ ([
			['delete', rmdir('/scratch/d'), (r) => { r.ws.mkdir('/scratch/d'); }],
			['createDirectory', mkdir('/scratch/e'), () => { }],
		])) {
			const r = createRig();
			setup(r);
			r.ws.hang(op, () => true);
			ending(r, { changes: [change] });
			const p = watch(r.rt.createSession().run('x'));
			await until(() => r.ws.calls.some((c) => c.startsWith(op + ' ')));
			await r.clock.advance(60000);
			assert.strictEqual(p.done, true, op);
			assert.ok(/applied 0 of 1 file changes; stopped at \/scratch\/[de]: timed out\. That call was not answered and cannot be cancelled: it may still land\./.test(p.value.notes[0]), op + ': ' + p.value.notes[0]);
			r.rt.dispose();
		}
	});

	await test('a READ that never answers in the writing phase (the stat of the folder a file goes into) is a stop at that folder - and does not claim it may still land', async () => {
		const r = createRig();
		r.ws.hang('stat', (k) => k.endsWith('/scratch/sub'));
		ending(r, { changes: [wr('/scratch/sub/a', 'A', null)] });
		const p = watch(r.rt.createSession().run('x'));
		await until(() => r.ws.calls.some((c) => /^stat .*\/scratch\/sub$/.test(c)));
		await r.clock.advance(60000);
		assert.strictEqual(p.done, true);
		assert.strictEqual(p.value.notes[0], '[LevelCode Shell: applied 0 of 1 file changes; stopped at /scratch/sub: timed out. The rest were not applied.]');
		assert.deepStrictEqual(writes(r), []);
		r.rt.dispose();
	});

	await test('a Stop while only a READ is in flight in the writing phase counts what is applied and says nothing may land; so does one in the check of the folders a review left', async () => {
		// the terminal: the read of the folder is in flight, the first file is not written yet
		const r = createRig();
		r.ws.hang('stat', (k) => k.endsWith('/scratch/sub'));
		ending(r, { changes: [wr('/scratch/sub/a', 'A', null)] });
		const s = r.rt.createSession();
		const p = watch(s.run('x'));
		await until(() => r.ws.calls.some((c) => /^stat .*\/scratch\/sub$/.test(c)));
		s.stop();
		await flush();
		assert.deepStrictEqual(p.value.notes, ['[LevelCode Shell: stopped while its file changes were being applied: 0 of 1 were applied. Nothing more was started.]']);
		r.rt.dispose();
		// the agent: the review applied n.txt, and the shell is checking the folder it left
		const q = createRig();
		q.ws.mkdir('/scratch/d');
		q.ws.hang('stat', (k) => k.endsWith('/scratch/d'));
		ending(q, { changes: [wr('/scratch/n.txt', 'N', null), rmdir('/scratch/d')] });
		/** @type {string[]} */ const out = [];
		let code = null;
		const child = q.rt.spawnAgent('x', { cwd: '/scratch', commit: async (/** @type {any[]} */ cs) => ({ rest: cs.filter((c) => c.kind === 'rmdir'), notes: [], failed: 0 }) });
		child.stderr.on('data', (/** @type {string} */ t) => out.push(t));
		child.on('close', (/** @type {number} */ c) => { code = c; });
		await until(() => q.ws.calls.some((c) => /^stat .*\/scratch\/d$/.test(c)));
		child.kill('SIGTERM');
		await flush();
		assert.strictEqual(code, 130);
		assert.strictEqual(out.join(''), '[LevelCode Shell: stopped while its file changes were being applied: 1 of 2 were applied. Nothing more was started.]\n', 'the review\'s count, and no write in flight');
		q.rt.dispose();
	});

	await test('the writing has its budget IN ALL too: five writes answered after 50 s each end at 120 s (commitMs, which is twice the check\'s 60 s for five entries) with two confirmed, the third in flight, the rest not started', async () => {
		const r = createRig();
		const five = FIVE.map((f) => wr('/scratch/' + f, f.toUpperCase(), null));
		slow(r, 'writeFile', 50000, (p) => /\/scratch\/[a-e]$/.test(p));
		ending(r, { changes: five });
		const p = watch(r.rt.createSession().run('x'));
		await settle();
		await r.clock.advance(119999);
		assert.strictEqual(p.done, false);
		await r.clock.advance(1);
		assert.strictEqual(p.done, true, 'at 120 s, not at 250 s');
		assert.deepStrictEqual({ exit: p.value.exitCode, applied: p.value.applied }, { exit: 1, applied: 2 });
		assert.strictEqual(p.value.notes[0], '[LevelCode Shell: applied 2 of 5 file changes; stopped at /scratch/c: ran out of time: the changes get 120 s in all. That call was not answered and cannot be cancelled: it may still land. The rest were not applied.]');
		await r.clock.advance(60000);
		assert.deepStrictEqual(r.ws.list('/scratch').filter((n) => FIVE.includes(n)), ['a', 'b', 'c'], 'the one in flight did land, and d and e were never started');
		r.rt.dispose();
		assert.strictEqual(r.clock.pending, 0);
	});

	await test('a Stop in the writing with a write that never answers: at once, "1 of 2", and the write may still land; a late landing changes nothing', async () => {
		const r = createRig();
		const two = [wr('/scratch/a', 'A', null), wr('/scratch/b', 'B', null)];
		r.ws.hang('writeFile', (k) => k.endsWith('/b'));
		ending(r, { changes: two });
		const s = r.rt.createSession();
		const p = watch(s.run('x'));
		await until(() => r.ws.calls.some((c) => /^writeFile .*\/scratch\/b$/.test(c)));
		await r.clock.advance(2000);
		s.stop();
		await flush();
		assert.strictEqual(p.done, true);
		assert.deepStrictEqual({ how: p.value.how, exit: p.value.exitCode, applied: p.value.applied }, { how: 'aborted', exit: 130, applied: 1 });
		assert.deepStrictEqual(p.value.notes, ['[LevelCode Shell: stopped while its file changes were being applied: 1 of 2 were applied. The change being made at that moment cannot be cancelled and may still land; nothing more was started.]']);
		await r.clock.advance(120000);
		assert.deepStrictEqual(r.ws.list('/scratch'), ['a'], 'nothing happened after the stop');
		r.rt.dispose();
		assert.strictEqual(r.clock.pending, 0);
	});

	await test('the agent: a review that takes 119 s and then a folder that never answers - one budget, the run ends at 120 s, not at 179', async () => {
		const r = createRig();
		r.ws.hang('createDirectory', () => true);
		ending(r, { changes: [wr('/scratch/a', 'A', null), mkdir('/scratch/d')] });
		/** @type {string[]} */ let out = [];
		let code = null;
		const child = r.rt.spawnAgent('x', {
			cwd: '/scratch',
			commit: () => new Promise((res) => r.clock.setTimeout(() => res({ rest: [mkdir('/scratch/d')], notes: [], failed: 0 }), 119000)),
		});
		child.stderr.on('data', (/** @type {string} */ t) => out.push(t));
		child.on('close', (/** @type {number} */ c) => { code = c; });
		await settle();
		await r.clock.advance(119999);
		assert.strictEqual(code, null);
		await r.clock.advance(1);
		assert.strictEqual(code, 1, 'at 120 s in all');
		assert.strictEqual(out.join(''), '[LevelCode Shell: applied 1 of 2 file changes; stopped at /scratch/d: ran out of time: the changes get 120 s in all. That call was not answered and cannot be cancelled: it may still land. The rest were not applied.]\n');
		r.rt.dispose();
	});

	await test('the agent: a hung rmdir of `rest` is bounded by fsMs, and a Stop in it ends the run at once with what the review applied', async () => {
		for (const stop of [false, true]) {
			const r = createRig();
			r.ws.mkdir('/scratch/d');
			r.ws.hang('delete', () => true);
			ending(r, { changes: [wr('/scratch/n.txt', 'N', null), rmdir('/scratch/d')] });
			/** @type {string[]} */ const out = [];
			let code = null;
			const child = r.rt.spawnAgent('x', {
				cwd: '/scratch',
				commit: async (/** @type {any[]} */ cs) => { await r.ws.fs.writeFile(r.ws.vscode.Uri.parse('levelcode-scratch:///scratch/n.txt'), te.encode('N')); return { rest: cs.filter((c) => c.kind === 'rmdir'), notes: ['[LevelCode Shell: 1 file changed]'], failed: 0 }; },
			});
			child.stderr.on('data', (/** @type {string} */ t) => out.push(t));
			child.on('close', (/** @type {number} */ c) => { code = c; });
			await until(() => r.ws.calls.some((c) => c.startsWith('delete ')));
			if (stop) {
				await r.clock.advance(1000);
				assert.strictEqual(child.kill('SIGTERM'), true);
				await flush();
				assert.strictEqual(code, 130, 'at once');
				assert.ok(out.join('').includes('stopped while its file changes were being applied: 1 of 2 were applied. The change being made at that moment cannot be cancelled and may still land; nothing more was started.'), out.join(''));
			} else {
				await r.clock.advance(60000);
				assert.strictEqual(code, 1);
				// the number is the whole command's: the review applied n.txt and the rmdir is the second change
				assert.ok(out.join('').includes('applied 1 of 2 file changes; stopped at /scratch/d: timed out. That call was not answered and cannot be cancelled: it may still land. The rest were not applied.'), out.join(''));
			}
			assert.strictEqual(r.ws.text('/scratch/n.txt'), 'N');
			r.rt.dispose();
		}
	});

	await test('the agent: what the shell cannot do of `rest` is counted against the WHOLE set, not only the folders ("applied 0 of 1" over a file the review wrote)', async () => {
		const r = createRig();
		r.ws.mkdir('/scratch/d');
		r.ws.put('/scratch/d/late.txt', 'a file that appeared after the command ran');
		ending(r, { changes: [wr('/scratch/n.txt', 'N', null), rmdir('/scratch/d')] });
		const x = await agent(r, 'x', { commit: async (/** @type {any[]} */ cs) => ({ rest: cs.filter((c) => c.kind === 'rmdir'), notes: [], failed: 0 }) });
		assert.strictEqual(x.code, 1);
		assert.ok(/applied 1 of 2 file changes; stopped at \/scratch\/d: /.test(x.stderr) && !/applied 0 of 1/.test(x.stderr), x.stderr);
		assert.strictEqual(r.ws.text('/scratch/d/late.txt'), 'a file that appeared after the command ran');
		// and a refusal of what is left says how much had been applied
		const q = createRig();
		q.ws.put('/scratch/e', 'a file where the command made a folder');
		ending(q, { changes: [wr('/scratch/n.txt', 'N', null), mkdir('/scratch/e')] });
		const y = await agent(q, 'x', { commit: async (/** @type {any[]} */ cs) => ({ rest: cs.filter((c) => c.kind === 'mkdir'), notes: [], failed: 0 }) });
		assert.ok(/\/scratch\/e is a file now/.test(y.stderr), y.stderr);
		assert.ok(/NONE of the remaining 1 change was applied \(1 of 2 had already been\)\./.test(y.stderr) && !/NONE of this command's file changes were applied/.test(y.stderr), y.stderr);
		r.rt.dispose();
		q.rt.dispose();
	});

	/* ===== what a provider throws cannot change what a commit reports ============================== */

	/**
	 * What a provider can throw that has broken a naive `e.message` / `e.code`; the third is what the reason must say.
	 * @returns {Array<[string, any, RegExp]>}
	 */
	function hostile() {
		const revoked = Proxy.revocable({}, {});
		revoked.revoke();
		return [
			['a message getter that throws', Object.defineProperty({}, 'message', { get() { throw new Error('getter-boom'); } }), /\[object Object\]/],
			['a Proxy that throws on every read', new Proxy({}, new Proxy({}, { get() { throw new Error('trap-boom'); } })), /\[unprintable value\]/],
			['a revoked Proxy', revoked.proxy, /\[unprintable value\]/],
			['an object with no prototype', Object.create(null), /\[unprintable value\]/],
			['a Symbol', Symbol('s'), /Symbol\(s\)/],
			['a BigInt', 7n, /\b7\b/],
			['undefined', undefined, /no reason was given/],
			['an Error whose `code` getter throws', Object.defineProperty(new Error('code-boom'), 'code', { get() { throw new Error('inner'); } }), /code-boom/],
			['an Error whose `name` getter throws', Object.defineProperty(new Error('name-boom'), 'name', { get() { throw new Error('inner'); } }), /name-boom/],
		];
	}

	await test('the terminal: whatever a write throws, the run says "applied 1 of 3, stopped at b" and exits 1 - never "error, applied 0" over the file that landed', async () => {
		for (const [what, thrown, said] of hostile()) {
			const r = createRig();
			r.ws.fail('writeFile', (k) => k.endsWith('/b.txt'), thrown);
			ending(r, { changes: [wr('/scratch/a.txt', 'A', null), wr('/scratch/b.txt', 'B', null), wr('/scratch/c.txt', 'C', null)] });
			const res = await r.rt.createSession().run('x');
			assert.deepStrictEqual({ how: res.how, exit: res.exitCode, applied: res.applied }, { how: 'exit', exit: 1, applied: 1 }, what);
			assert.ok(/^\[LevelCode Shell: applied 1 of 3 file changes; stopped at \/scratch\/b\.txt: .+\. The rest were not applied\.\]$/.test(res.notes[0]), what + ': ' + res.notes[0]);
			assert.ok(said.test(res.notes[0]), what + ': the reason is what the thing says (' + said + '): ' + res.notes[0]);
			assert.ok(!/could not finish the command/.test(res.notes.join('')), what);
			assert.strictEqual(r.ws.text('/scratch/a.txt'), 'A', what);
			r.rt.dispose();
		}
	});

	await test('the terminal: a check that throws something hostile is a refusal with a reason; so is a stat in the folder step', async () => {
		for (const [what, thrown, said] of hostile()) {
			const r = createRig();
			r.ws.put('/scratch/a.txt', 'a');
			r.ws.fail('stat', (k) => k.endsWith('/a.txt'), thrown);
			ending(r, { changes: [wr('/scratch/a.txt', 'A', 'a')] });
			const res = await r.rt.createSession().run('x');
			assert.deepStrictEqual({ how: res.how, applied: res.applied }, { how: 'exit', applied: 0 }, what);
			assert.ok(/refused: \/scratch\/a\.txt could not be checked: .+/.test(res.notes[0]), what + ': ' + res.notes[0]);
			assert.ok(said.test(res.notes[0]), what + ': ' + res.notes[0]);
			r.rt.dispose();
		}
	});

	await test('the agent: a review that throws or rejects with something hostile is "could not be applied (...); some of them may have been", and the shell goes on', async () => {
		for (const [what, thrown, said] of hostile()) {
			for (const how of ['throws', 'rejects']) {
				const r = createRig();
				ending(r, { changes: [wr('/scratch/a', 'A', null)] });
				const res = await agent(r, 'x', { commit: how === 'throws' ? () => { throw thrown; } : () => Promise.reject(thrown) });
				assert.strictEqual(res.code, 1, what + ' ' + how);
				assert.ok(/^\[LevelCode Shell: the command's file changes could not be applied \(.+\); some of them may have been\]\n$/.test(res.stderr), what + ' ' + how + ': ' + JSON.stringify(res.stderr));
				assert.ok(said.test(res.stderr), what + ' ' + how + ': ' + res.stderr);
				r.rt.dispose();
			}
		}
	});

	await test('the agent: the folders the review leaves are applied by the same step(): a hostile throw there is a stop at that folder with the review\'s count', async () => {
		for (const [what, thrown, said] of hostile()) {
			const r = createRig();
			r.ws.fail('createDirectory', () => true, thrown);
			ending(r, { changes: [wr('/scratch/a', 'A', null), mkdir('/scratch/d')] });
			const res = await agent(r, 'x', { commit: async (/** @type {any[]} */ cs) => ({ rest: cs.filter((c) => c.kind === 'mkdir'), notes: [], failed: 0 }) });
			assert.strictEqual(res.code, 1, what);
			assert.ok(/applied 1 of 2 file changes; stopped at \/scratch\/d: /.test(res.stderr), what + ': ' + res.stderr);
			assert.ok(said.test(res.stderr), what + ': ' + res.stderr);
			r.rt.dispose();
		}
	});

	/* ===== what the review hands back is not believed beyond the contract ================================== */

	await test('a review whose answer is not an object with a `rest` list gave no answer: status 1, one honest note, nothing of its own applied by the shell', async () => {
		/** @type {Array<[string, () => any]>} */
		const shapes = [['undefined', () => undefined], ['null', () => null], ['a string', () => 'ok'], ['a number', () => 7], ['{}', () => ({})],
			['no rest', () => ({ notes: ['x'], failed: 0 })], ['rest is not a list', () => ({ rest: 'x', notes: [], failed: 0 })], ['an array', () => [mkdir('/scratch/d')]]];
		for (const [name, make] of shapes) {
			const r = createRig();
			ending(r, { exitCode: 0, changes: [wr('/scratch/a', 'a', null), mkdir('/scratch/d')] });
			const res = await agent(r, 'x', { commit: async () => /** @type {any} */ (make)() });
			assert.strictEqual(res.code, 1, name);
			assert.ok(/gave no answer, so none of them can be counted as applied; some of them may have been/.test(res.stderr), name + ': ' + res.stderr);
			assert.strictEqual(r.ws.exists('/scratch/d'), false, name + ': the shell does not guess');
			r.rt.dispose();
		}
	});

	await test('`rest` is folders the command made or removed and nothing else: a write, a delete, a folder it never touched are not applied, and the status says so', async () => {
		const r = createRig();
		r.ws.put('/scratch/victim.txt', 'keep me');
		ending(r, { exitCode: 0, changes: [wr('/scratch/a', 'a', null), mkdir('/scratch/d'), rmdir('/scratch/old')] });
		r.ws.mkdir('/scratch/old');
		const res = await agent(r, 'x', {
			commit: async () => ({
				rest: [mkdir('/scratch/d'), rmdir('/scratch/old'), wr('/scratch/sneak.txt', 'SNEAK', null), del('/scratch/victim.txt', 'keep me'), mkdir('/scratch/never-asked'), null, { kind: 'mkdir' }],
				notes: [], failed: 0,
			}),
		});
		assert.strictEqual(res.code, 1);
		assert.strictEqual(r.ws.isDir('/scratch/d'), true, 'the folders that were the command\'s are made');
		assert.strictEqual(r.ws.exists('/scratch/old'), false, '...and removed');
		assert.strictEqual(r.ws.exists('/scratch/sneak.txt'), false, 'a write in `rest` bypasses the review: it is not applied');
		assert.strictEqual(r.ws.text('/scratch/victim.txt'), 'keep me');
		assert.strictEqual(r.ws.exists('/scratch/never-asked'), false);
		assert.ok(/5 entries the review handed back to the shell are not folders the command made or removed, and were NOT applied/.test(res.stderr), res.stderr);
		r.rt.dispose();
	});

	await test('a failure count that is not a count is not believed: the status is raised and the note says so; a count that is one is used', async () => {
		/** @type {Array<[string, any, number, boolean]>} */  // name, `failed`, the status, whether the note about a bad count is expected
		const cases = [['Infinity', Infinity, 1, true], ['NaN', NaN, 1, true], ['negative', -5, 1, true], ['a string', '2', 1, true], ['an object', {}, 1, true],
			['zero', 0, 0, false], ['one', 1, 1, false], ['more than there are', 99, 1, false], ['absent', undefined, 0, false], ['fractional', 1.9, 1, false]];
		for (const [name, failed, code, said] of cases) {
			const r = createRig();
			ending(r, { exitCode: 0, changes: [wr('/scratch/a', 'a', null), wr('/scratch/b', 'b', null)] });
			const x = await agent(r, 'x', { commit: async () => (failed === undefined ? { rest: [], notes: [] } : { rest: [], notes: [], failed }) });
			assert.strictEqual(x.code, code, name);
			assert.strictEqual(/count of changes it could not apply that is not a number/.test(x.stderr), said, name + ': ' + x.stderr);
			r.rt.dispose();
		}
	});

	await test('Change.viaDir is in the agent\'s paths like path is: a delete that went through a folder of a relocated mount', async () => {
		const r = createRig({ workspace: { folders: [{ name: 'tmp', uri: 'file:///tmp' }] } });
		ending(r, { exitCode: 0, changes: [
			{ kind: 'delete', path: '/mnt/tmp/d/a.txt', before: te.encode('a'), viaDir: '/mnt/tmp/d' },
			{ kind: 'delete', path: '/mnt/tmp/other.txt', before: te.encode('o') },
			rmdir('/mnt/tmp/d'),
		] });
		r.ws.put('file:/tmp/d/a.txt', 'a');
		r.ws.put('file:/tmp/other.txt', 'o');
		/** @type {any[]} */ let seen = [];
		const res = await agent(r, 'x', {
			cwd: '/tmp', folders: [{ name: 'tmp', root: '/tmp', uri: 'file:///tmp' }],
			commit: async (/** @type {any[]} */ cs) => { seen = cs; return { rest: [], notes: [], failed: 0 }; },
		});
		assert.strictEqual(res.code, 0);
		assert.deepStrictEqual(seen.map((c) => [c.kind, c.path, c.viaDir]), [
			['delete', '/tmp/d/a.txt', '/tmp/d'],
			['delete', '/tmp/other.txt', undefined],
			['rmdir', '/tmp/d', undefined],
		]);
		assert.ok(!('viaDir' in seen[1]), 'a delete with no viaDir has none');
		r.rt.dispose();
	});

	await test('the terminal\'s own commit: a conflict path with an escape sequence in it is shown, not passed', async () => {
		const r = createRig();
		const evil = '/scratch/a\x1b]0;x\x07.txt';
		r.ws.put(evil, 'SAVED ELSEWHERE');
		ending(r, { exitCode: 0, changes: [wr(evil, 'mine', 'what it read')] });
		const res = await r.rt.createSession().run('x');
		assert.strictEqual(res.applied, 0);
		assert.ok(/changed while the command ran/.test(res.notes.join('')), res.notes.join(''));
		assert.ok(!/[\x00-\x08\x0B-\x1F\x7F-\x9F]/.test(res.notes.join('\n')), JSON.stringify(res.notes));
		assert.ok(res.notes.join('').includes('a\u{241B}]0;x\u{2407}.txt'), res.notes.join(''));
		r.rt.dispose();
	});

	/* ===== fix round 3: a Stop does not lose what the run already knew ======================================== */

	// What the run knows once its engine has said `done`, before the commit is waited for: a folder that was moved, the
	// engine's own notes, output that was cut, variables that were left out. A Stop ends the run at once; these are
	// true of it as much as of a run that went on to its end.
	const MOVED = '[LevelCode Shell: The folder "rootfs" is mounted at /mnt/rootfs, not at /: it is the root of the file system.]';
	const ENGINE_SAID = '[LevelCode Shell: the engine says: 2 variables were not carried]';
	const CAPPED = '[LevelCode Shell: the command wrote more than 20 characters; the rest was dropped]';
	const NOT_KEPT = '[LevelCode Shell: 1 environment variable was not kept: this shell carries at most 512 variables and 256 KiB of them]';
	const HEAD = [MOVED, ENGINE_SAID, CAPPED, NOT_KEPT];
	const TWO_FOLDERS = [{ name: 'scratch', uri: 'levelcode-scratch:///scratch' }, { name: 'rootfs', uri: 'file:///' }];
	/** An engine that writes more than the host's cap of output (20 characters here), hands back one variable too many, and ends with notes of its own. */
	function sayingMuch(/** @type {any} */ r, /** @type {any[]} */ changes) {
		/** @type {Record<string, string>} */ const env = {};
		for (let i = 0; i < 513; i++) { env['V' + i] = 'x'; }
		r.engines.state.onRun = async (/** @type {any} */ run, /** @type {any} */ w, /** @type {any} */ h) => {
			h.out(run.id, 'stdout', 'x'.repeat(30));
			await flush();
			h.done({ exitCode: 0, how: 'exit', changes, env, notes: ['the engine says: 2 variables were not carried'] });
		};
	}
	const TOO_MUCH = { engine: { maxOutputSize: 10 } };

	await test('a Stop or dispose() while the set is being CHECKED or WRITTEN keeps the folder, engine, output and variable notes, in front of the stop note', async () => {
		for (const [phase, how] of /** @type {Array<[string, string]>} */ ([
			['check', 'session.stop'], ['check', 'session.dispose'], ['check', 'runtime.dispose'],
			['write', 'session.stop'], ['write', 'session.dispose'], ['write', 'runtime.dispose'],
		])) {
			const what = phase + ' / ' + how;
			const r = createRig({ workspace: { folders: TWO_FOLDERS }, limits: TOO_MUCH });
			r.ws.put('/scratch/old.txt', 'old');
			if (phase === 'check') { r.ws.hang('stat', (k) => k.endsWith('/old.txt')); } else { r.ws.hang('writeFile', (k) => k.endsWith('/b.txt')); }
			sayingMuch(r, phase === 'check' ? [wr('/scratch/old.txt', 'new', 'old')] : TWO);
			const s = r.rt.createSession();
			const p = watch(s.run('x'));
			await until(() => r.ws.calls.some((c) => (phase === 'check' ? /^stat .*old\.txt$/ : /^writeFile .*b\.txt$/).test(c)));
			if (how === 'session.stop') { s.stop(); } else if (how === 'session.dispose') { s.dispose(); } else { r.rt.dispose(); }
			await flush();
			assert.strictEqual(p.done, true, what);
			assert.strictEqual(p.value.how, 'aborted', what);
			const tail = phase === 'check'
				? '[LevelCode Shell: stopped before anything was applied: the command\'s file changes were being checked, and were NOT applied.]'
				: '[LevelCode Shell: stopped while its file changes were being applied: 1 of 2 were applied. The change being made at that moment cannot be cancelled and may still land; nothing more was started.]';
			assert.deepStrictEqual(p.value.notes, HEAD.concat(tail), what);
			r.rt.dispose();
		}
	});

	await test('the same for an agent that is killed while its review is going on, and for a worker that died after done on top of it', async () => {
		const r = createRig({ workspace: { folders: TWO_FOLDERS }, limits: TOO_MUCH });
		sayingMuch(r, [wr('/scratch/a.txt', 'A', null)]);
		let asked = false;
		const child = r.rt.spawnAgent('x', { cwd: '/scratch', folders: [{ name: 'scratch', root: '/scratch', uri: 'levelcode-scratch:///scratch' }, { name: 'rootfs', root: '/', uri: 'file:///' }], commit: () => { asked = true; return new Promise(() => { }); } });
		const o = observe(child, 3000);
		await until(() => asked);
		r.engines.workers[0].crash('segfault');
		await flush();
		assert.strictEqual(child.kill('SIGTERM'), true);
		await o.closed;
		assert.strictEqual(/** @type {any} */ (o.events[o.events.length - 1]).code, 130);
		assert.deepStrictEqual(o.stderr.split('\n').slice(0, -1), HEAD.concat([
			'[LevelCode Shell: stopped while the review of its file changes was going on. A review cannot be interrupted: it may still apply some of them, and how many it applied is not known.]',
			'[LevelCode Shell: the shell engine stopped unexpectedly: segfault, after the command had finished]',
		]));
		r.rt.dispose();
	});

	await test('a worker that dies after `done` and then a Stop: both are true and both are said - the stop first, as the commit\'s own notes come, then the failure', async () => {
		/** @type {Array<[string, (w: any) => void, string]>} */
		const deaths = [['an error event', (w) => w.crash('late exception'), 'the shell engine stopped unexpectedly: late exception'],
			['a messageerror', (w) => w.onmessageerror({}), 'the shell engine sent a message that could not be read']];
		for (const [death, kill, failure] of deaths) {
			for (const how of ['session.stop', 'session.dispose', 'runtime.dispose']) {
				const r = createRig();
				const g = gatedWrites(r);
				/** @type {any} */ let worker;
				r.engines.state.onRun = async (run, w, h) => { worker = w; h.done({ exitCode: 0, how: 'exit', changes: TWO }); };
				const s = r.rt.createSession();
				const p = watch(s.run('x'));
				await g.reached;
				kill(worker);
				await flush();
				assert.strictEqual(p.done, false, death + ': the commit is still going on');
				if (how === 'session.stop') { s.stop(); } else if (how === 'session.dispose') { s.dispose(); } else { r.rt.dispose(); }
				await flush();
				assert.strictEqual(p.done, true, death + ' / ' + how);
				assert.deepStrictEqual(p.value.notes, [
					'[LevelCode Shell: stopped while its file changes were being applied: 0 of 2 were applied. The change being made at that moment cannot be cancelled and may still land; nothing more was started.]',
					'[LevelCode Shell: ' + failure + ', after the command had finished]',
				], death + ' / ' + how);
				g.open();
				r.rt.dispose();
			}
		}
	});

	await test('a Stop that comes with nothing to carry says only that it stopped: no note is invented, and none is said twice', async () => {
		const r = createRig();
		const g = gatedWrites(r);
		r.engines.state.onRun = async (run, w, h) => { h.done({ exitCode: 0, how: 'exit', changes: TWO }); };
		const s = r.rt.createSession();
		const p = watch(s.run('x'));
		await g.reached;
		s.stop();
		await flush();
		assert.strictEqual(p.value.notes.length, 1, p.value.notes.join('\n'));
		g.open();
		r.rt.dispose();
	});

	/* ===== fix round 3: the shell's own give-up on a review is a cancellation the review can see ============== */

	await test('the shell gave up on the review at commitMs: cancelled() is true from then on, and a review that looks before each change applies no more', async () => {
		const r = createRig();
		const many = [];
		for (let i = 0; i < 10; i++) { many.push(wr('/scratch/f' + i + '.txt', 'x', null)); }
		ending(r, { changes: many });
		const t0 = r.clock.now();
		/** @type {Array<[number, boolean]>} */ const polls = [];
		// one change per 20 s of the rig's clock, asking before each (as levelcode-ai's own review does)
		const commit = async (/** @type {any[]} */ cs, /** @type {{ cancelled(): boolean }} */ control) => {
			for (const c of cs) {
				await new Promise((res) => r.clock.setTimeout(() => res(undefined), 20000));
				const stop = control.cancelled();
				polls.push([Math.round((r.clock.now() - t0) / 1000), stop]);
				if (stop) { break; }
				await r.ws.fs.writeFile(r.ws.vscode.Uri.parse('levelcode-scratch://' + c.path), c.after);
			}
			return { rest: [], notes: [], failed: 0 };
		};
		/** @type {string[]} */ const err = [];
		let code = null;
		const child = r.rt.spawnAgent('x', { cwd: '/scratch', commit });
		child.stderr.on('data', (/** @type {string} */ t) => err.push(t));
		child.on('close', (/** @type {number} */ c) => { code = c; });
		await settle();
		await r.clock.advance(119999);
		assert.strictEqual(code, null, 'still waiting for the review at 119.999 s');
		await r.clock.advance(1);
		assert.strictEqual(code, 1, 'the shell closed the run at 120 s');
		assert.ok(/could not be applied \(timed out\); some of them may have been/.test(err.join('')), err.join(''));
		const onDisk = r.ws.list('/scratch').length;
		assert.strictEqual(onDisk, 5, 'five changes landed in the 100 s the review had before the shell gave up');
		await r.clock.advance(200000);
		assert.strictEqual(r.ws.list('/scratch').length, onDisk, 'nothing landed after the shell had told the model the command failed');
		assert.deepStrictEqual(polls, [[20, false], [40, false], [60, false], [80, false], [100, false], [120, true]], 'it asked at every change, and was told at the first after the give-up');
		r.rt.dispose();
	});

	await test('a provider that does not answer a READ is not a cancellation: the folders a review left time out as a refusal with its note, never silently', async () => {
		const r = createRig();
		r.ws.mkdir('/scratch/d');
		r.ws.hang('stat', (k) => k.endsWith('/scratch/d'));
		ending(r, { changes: [wr('/scratch/n.txt', 'N', null), rmdir('/scratch/d')] });
		/** @type {string[]} */ const err = [];
		let code = null;
		const child = r.rt.spawnAgent('x', { cwd: '/scratch', commit: async (/** @type {any[]} */ cs) => ({ rest: cs.filter((c) => c.kind === 'rmdir'), notes: [], failed: 0 }) });
		child.stderr.on('data', (/** @type {string} */ t) => err.push(t));
		child.on('close', (/** @type {number} */ c) => { code = c; });
		await until(() => r.ws.calls.some((c) => /^stat .*\/scratch\/d$/.test(c)));
		await r.clock.advance(60000);
		assert.strictEqual(code, 1);
		assert.deepStrictEqual(err.join('').split('\n').slice(0, -1), [
			'[LevelCode Shell: refused: the changes could not be checked in time: /scratch/d: timed out (0 of 1 were checked)]',
			'[LevelCode Shell: NONE of the remaining 1 change was applied (1 of 2 had already been).]',
		]);
		r.rt.dispose();
	});

	/* ===== fix round 3: the check's budget goes with the size of the set =================================== */

	/**
	 * A set of `n` files that exist, each changed, against a provider that answers every stat, read and write after
	 * `latency` ms of the rig's clock. `reads`: the command read each file (the check then asks for its bytes too: two
	 * calls an entry); not: one call an entry.
	 * @param {number} n @param {number} latency @param {{ limits?: any, reads?: boolean }} [o]
	 */
	async function slowSet(n, latency, o) {
		const r = createRig(o && o.limits ? { limits: o.limits } : undefined);
		const reads = !o || o.reads !== false;
		/** @type {any[]} */ const changes = [];
		for (let i = 0; i < n; i++) {
			const p = '/scratch/f' + i + '.txt';
			r.ws.put(p, 'old');
			changes.push(reads ? wr(p, 'new', 'old') : { kind: 'write', path: p, existed: true, before: null, after: te.encode('new') });
		}
		ending(r, { changes });
		for (const op of ['stat', 'readFile', 'writeFile']) { slow(r, op, latency, () => true); }
		const t0 = r.clock.now();
		const p = watch(r.rt.createSession().run('x'));
		await settle();
		for (let i = 0; i < 1000 && !p.done; i++) { await r.clock.advance(1000); }
		assert.strictEqual(p.done, true, 'the run never ended');
		return { r, res: p.value, took: r.clock.now() - t0 };
	}

	await test('a provider that is slow but alive still has a large set applied: 200 files at 200 ms, 1000 at 40 ms, 2000 at 20 ms a call (80 s of checking each), as before the gate', async () => {
		for (const [n, latency] of [[200, 200], [1000, 40], [2000, 20], [2000, 10], [200, 100]]) {
			const x = await slowSet(n, latency);
			const what = n + ' files at ' + latency + ' ms';
			assert.deepStrictEqual({ how: x.res.how, exit: x.res.exitCode, applied: x.res.applied, notes: x.res.notes }, { how: 'exit', exit: 0, applied: n, notes: [] }, what);
			assert.strictEqual(x.r.ws.text('/scratch/f' + (n - 1) + '.txt'), 'new', what);
			x.r.rt.dispose();
		}
	});

	await test('the check has checkMs up to checkEntries entries, its share of that in proportion above, and never more than checkMaxMs: exactly the budget passes, a millisecond a call over is refused', async () => {
		const L = { workers: { checkMs: 1000, checkEntries: 10, checkMaxMs: 5000, fsMs: 60000 } };
		// [files, ms a call, passes?, how many of the files were checked when it ran out]
		/** @type {Array<[number, number, boolean, number]>} */
		const table = [
			[5, 200, true, 5], [5, 201, false, 4],         // fewer than checkEntries: checkMs itself (1 s)
			[10, 100, true, 10], [10, 101, false, 9],      // exactly checkEntries: checkMs
			[11, 100, true, 11], [11, 101, false, 10],     // one more: 1100 ms
			[20, 100, true, 20], [20, 101, false, 19],     // twice: 2 s
			[60, 80, true, 60], [60, 90, false, 55],       // six times would be 6 s: the ceiling, 5 s
			[100, 50, true, 100], [100, 51, false, 98],    // exactly the ceiling passes, a millisecond a call over does not
		];
		for (const [n, latency, passes, checked] of table) {
			const what = n + ' files at ' + latency + ' ms';
			const x = await slowSet(n, latency, { limits: L, reads: false });
			if (passes) {
				assert.deepStrictEqual({ how: x.res.how, exit: x.res.exitCode, applied: x.res.applied }, { how: 'exit', exit: 0, applied: n }, what);
			} else {
				assert.strictEqual(x.res.applied, 0, what);
				assert.ok(new RegExp('could not be checked in time: /scratch/f' + checked + '\\.txt: ran out of time: the check gets [\\d.]+ s in all \\(' + checked + ' of ' + n + ' were checked\\)').test(x.res.notes[0]), what + ': ' + x.res.notes[0]);
				assert.deepStrictEqual(writes(x.r), [], what + ': nothing was written');
			}
			x.r.rt.dispose();
		}
	});

	await test('the budget a set gets is said in the note: 1.1 s for eleven entries, the ceiling 5 s for sixty', async () => {
		const L = { workers: { checkMs: 1000, checkEntries: 10, checkMaxMs: 5000, fsMs: 60000 } };
		const eleven = await slowSet(11, 101, { limits: L, reads: false });
		assert.ok(/the check gets 1\.1 s in all \(10 of 11 were checked\)/.test(eleven.res.notes[0]), eleven.res.notes[0]);
		const sixty = await slowSet(60, 90, { limits: L, reads: false });
		assert.ok(/the check gets 5 s in all \(55 of 60 were checked\)/.test(sixty.res.notes[0]), sixty.res.notes[0]);
		eleven.r.rt.dispose();
		sixty.r.rt.dispose();
	});

	await test('a hung provider is bounded at fsMs whatever the size of the set: 2000 files, refused at 60 s with one stat asked - not at the ceiling', async () => {
		const r = createRig();
		/** @type {any[]} */ const changes = [];
		for (let i = 0; i < 2000; i++) { r.ws.put('/scratch/f' + i, 'a'); changes.push(wr('/scratch/f' + i, 'A', 'a')); }
		r.ws.hang('stat', (k) => /\/scratch\/f\d+$/.test(k));
		ending(r, { changes });
		const p = watch(r.rt.createSession().run('x'));
		await until(() => r.ws.calls.some((c) => /^stat .*\/scratch\/f0$/.test(c)));
		await r.clock.advance(59999);
		assert.strictEqual(p.done, false);
		await r.clock.advance(1);
		assert.strictEqual(p.done, true, 'at 60 s');
		assert.deepStrictEqual(p.value.notes, [
			'[LevelCode Shell: refused: the changes could not be checked in time: /scratch/f0: timed out (0 of 2000 were checked)]',
			'[LevelCode Shell: NONE of this command\'s file changes were applied.]',
		]);
		assert.strictEqual(r.ws.calls.filter((c) => c.startsWith('stat ')).length, 1, 'the other 1999 were not asked');
		r.rt.dispose();
		assert.strictEqual(r.clock.pending, 0);
	});

	await test('a provider that answers every call just before fsMs is not waited for for 2000 of them: the ceiling, 120 s, ends the check of a large set', async () => {
		const x = await slowSet(2000, 59000, { reads: false });
		assert.strictEqual(x.res.applied, 0);
		assert.strictEqual(x.took, 120000, 'refused at exactly the ceiling');
		assert.ok(/ran out of time: the check gets 120 s in all \(2 of 2000 were checked\)/.test(x.res.notes[0]), x.res.notes[0]);
		assert.deepStrictEqual(writes(x.r), []);
		await x.r.clock.advance(59000);              // (the provider's own timer of the call that was given up on)
		assert.deepStrictEqual(writes(x.r), [], 'and the late answer of that call changed nothing');
		x.r.rt.dispose();
		assert.strictEqual(x.r.clock.pending, 0, 'the runtime left no timer behind');
	});

	/* ===== fix round 4: what the check lets through, the writing can finish ================================= */

	// A folder is ONE call to check (a stat) and TWO to write (a stat, then the create); a file is one and one (plus
	// the stat of its folder, which is shared). So a scaffold needs up to twice the calls to write that it needed to
	// check, and a check budget that grows with the set while the writing keeps a constant lets through sets that
	// cannot be written in time: a half-made project where the checkpoint refused the whole set with nothing on disk.
	// The writing of the terminal's set therefore has twice the check's budget (and never less than commitMs).

	/** The small table of these tests: the check of n entries has clamp(100 ms x n, 1 s, 5 s); commitMs is below what twice that is. */
	const L4 = { workers: { checkMs: 1000, checkEntries: 10, checkMaxMs: 5000, commitMs: 1000, fsMs: 60000 } };

	/**
	 * `dirs` new folders and `files` new files spread over them, as a scaffold's change set is, against a provider that
	 * answers each kind of call after the given time of the rig's clock (a number: every kind).
	 * @param {number} dirs @param {number} files @param {number|Record<string, number>} latency @param {{ limits?: any }} [o]
	 */
	async function scaffold(dirs, files, latency, o) {
		const r = createRig(o && o.limits ? { limits: o.limits } : undefined);
		/** @type {any[]} */ const changes = [];
		for (let i = 0; i < dirs; i++) { changes.push(mkdir('/scratch/d' + i)); }
		for (let j = 0; j < files; j++) { changes.push(wr('/scratch/d' + (j % dirs) + '/f' + j + '.txt', 'new', null)); }
		ending(r, { changes });
		/** @type {Record<string, number>} */
		const per = typeof latency === 'number' ? { stat: latency, readFile: latency, writeFile: latency, createDirectory: latency } : latency;
		for (const op of Object.keys(per)) { slow(r, op, per[op], () => true); }
		const t0 = r.clock.now();
		const p = watch(r.rt.createSession().run('x'));
		await settle();
		for (let i = 0; i < 2000 && !p.done; i++) { await r.clock.advance(1000); }
		assert.strictEqual(p.done, true, 'the run never ended');
		let madeDirs = 0, madeFiles = 0;
		for (let i = 0; i < dirs; i++) { madeDirs += r.ws.isDir('/scratch/d' + i) ? 1 : 0; }
		for (let j = 0; j < files; j++) { madeFiles += r.ws.exists('/scratch/d' + (j % dirs) + '/f' + j + '.txt') ? 1 : 0; }
		return { r, res: p.value, took: r.clock.now() - t0, madeDirs, madeFiles };
	}

	await test('a scaffold the check lets through is WRITTEN whole, and one it does not is refused whole with nothing on disk - never half a project (exactly the check\'s budget passes, a ms a call over is refused)', async () => {
		// [dirs, files, ms a call, passes?]: n = dirs + files; the check makes n calls (a stat each), the writing 2 x dirs + files
		/** @type {Array<[number, number, number, boolean]>} */
		const table = [
			[40, 0, 100, true], [40, 0, 101, false],        // folders only: n calls to check, 2n to write - exactly twice the budget
			[20, 20, 100, true], [20, 20, 101, false],      // a scaffold: 40 to check, 60 to write
			[100, 0, 50, true], [100, 0, 51, false],        // at the ceiling: 5 s to check, 10 s to write
			[100, 100, 25, true], [100, 100, 26, false],
			[3, 30, 100, true], [3, 30, 101, false],      // 33 entries: 3.3 s to check, 6.6 s to write
			[1, 0, 1000, true], [1, 0, 1001, false],        // one folder: checkMs itself
		];
		for (const [dirs, files, latency, passes] of table) {
			const what = dirs + ' folders + ' + files + ' files at ' + latency + ' ms a call';
			const n = dirs + files;
			const x = await scaffold(dirs, files, latency, { limits: L4 });
			if (passes) {
				assert.deepStrictEqual({ how: x.res.how, exit: x.res.exitCode, applied: x.res.applied, notes: x.res.notes }, { how: 'exit', exit: 0, applied: n, notes: [] }, what);
				assert.deepStrictEqual([x.madeDirs, x.madeFiles], [dirs, files], what);
			} else {
				assert.strictEqual(x.res.applied, 0, what);
				assert.ok(/could not be checked in time: .*ran out of time: the check gets [\d.]+ s in all \(\d+ of \d+ were checked\)/.test(x.res.notes[0]), what + ': ' + x.res.notes[0]);
				assert.deepStrictEqual([x.madeDirs, x.madeFiles], [0, 0], what + ': nothing is on disk');
				assert.deepStrictEqual(writes(x.r), [], what + ': not one write was made');
			}
			x.r.rt.dispose();
		}
	});

	await test('the same at the default limits: 200 folders + 200 files at 250 ms a call (100 s to check, 150 s to write) is applied whole, as are 400 + 400 at 150 ms; 200 + 200 at 350 ms is refused whole', async () => {
		/** @type {Array<[number, number, number, boolean]>} */
		const table = [[200, 200, 250, true], [400, 400, 150, true], [1000, 1000, 60, true], [200, 200, 350, false], [1000, 1000, 61, false]];
		for (const [dirs, files, latency, passes] of table) {
			const what = dirs + ' + ' + files + ' at ' + latency + ' ms';
			const x = await scaffold(dirs, files, latency);
			if (passes) {
				assert.deepStrictEqual({ exit: x.res.exitCode, applied: x.res.applied, notes: x.res.notes }, { exit: 0, applied: dirs + files, notes: [] }, what);
				assert.deepStrictEqual([x.madeDirs, x.madeFiles], [dirs, files], what);
			} else {
				assert.strictEqual(x.res.applied, 0, what);
				assert.deepStrictEqual([x.madeDirs, x.madeFiles], [0, 0], what + ': nothing is on disk');
			}
			x.r.rt.dispose();
		}
	});

	await test('the writing has TWICE the check\'s budget in all, exactly: 40 folders whose create takes 200 ms fit in 8 s, at 201 ms the last is out of time - "applied 39 of 40"', async () => {
		for (const [latency, ok] of /** @type {Array<[number, boolean]>} */ ([[200, true], [201, false]])) {
			const x = await scaffold(40, 0, { createDirectory: latency }, { limits: L4 });    // (the check is instant: the whole of the 4 s is unspent)
			if (ok) {
				assert.deepStrictEqual({ exit: x.res.exitCode, applied: x.res.applied, notes: x.res.notes, took: x.took }, { exit: 0, applied: 40, notes: [], took: 8000 }, 'exactly the budget passes');
			} else {
				assert.strictEqual(x.res.applied, 39);
				assert.ok(/^\[LevelCode Shell: applied 39 of 40 file changes; stopped at \/scratch\/d\d+: ran out of time: the changes get 8 s in all\. That call was not answered and cannot be cancelled: it may still land\. The rest were not applied\.\]$/.test(x.res.notes[0]), x.res.notes[0]);
				assert.strictEqual(x.res.exitCode, 1);
			}
			x.r.rt.dispose();
		}
	});

	await test('the writing is never given less than commitMs: three files whose write takes 1.6 s fit in a 5 s commitMs although twice the check\'s 1 s is 2 s; at 1.7 s the third is out of time', async () => {
		const L = { workers: { checkMs: 1000, checkEntries: 10, checkMaxMs: 5000, commitMs: 5000, fsMs: 60000 } };
		for (const [latency, ok] of /** @type {Array<[number, boolean]>} */ ([[1600, true], [1700, false]])) {
			const x = await scaffold(1, 3, { writeFile: latency }, { limits: L });
			if (ok) {
				assert.deepStrictEqual({ exit: x.res.exitCode, applied: x.res.applied }, { exit: 0, applied: 4 });
			} else {
				assert.strictEqual(x.res.applied, 3, 'the folder and two files');
				assert.ok(/applied 3 of 4 file changes; stopped at \/scratch\/d0\/f\d+\.txt: ran out of time: the changes get 5 s in all\./.test(x.res.notes[0]), x.res.notes[0]);
			}
			x.r.rt.dispose();
		}
	});

	await test('the writing of a large set is still bounded: 240 folders at the ceiling get 240 s in all - a create answered at 59 s each ends at exactly 240 s, one that never answers at 60 s', async () => {
		const slowOne = await scaffold(240, 0, { createDirectory: 59000 });
		assert.strictEqual(slowOne.took, 240000, 'twice the 120 s ceiling of the check');
		assert.ok(/applied 4 of 240 file changes; stopped at \/scratch\/d\d+: ran out of time: the changes get 240 s in all\./.test(slowOne.res.notes[0]), slowOne.res.notes[0]);
		slowOne.r.rt.dispose();
		const r = createRig();
		/** @type {any[]} */ const changes = [];
		for (let i = 0; i < 240; i++) { changes.push(mkdir('/scratch/d' + i)); }
		r.ws.hang('createDirectory', () => true);
		ending(r, { changes });
		const p = watch(r.rt.createSession().run('x'));
		await settle();
		await r.clock.advance(59999);
		assert.strictEqual(p.done, false);
		await r.clock.advance(1);
		assert.strictEqual(p.done, true, 'at fsMs, whatever the size of the set');
		assert.ok(/applied 0 of 240 file changes; stopped at \/scratch\/d0: timed out\. That call was not answered and cannot be cancelled: it may still land\./.test(p.value.notes[0]), p.value.notes[0]);
		r.rt.dispose();
		assert.strictEqual(r.clock.pending, 0);
	});

	await test('the agent\'s writing keeps commitMs however large the set is: a review that answers at 119 s with a folder that never answers ends the run at 120 s for 240 entries too', async () => {
		const r = createRig();
		r.ws.hang('createDirectory', () => true);
		/** @type {any[]} */ const many = [mkdir('/scratch/d')];
		for (let i = 0; i < 239; i++) { many.push(wr('/scratch/f' + i, 'x', null)); }
		ending(r, { changes: many });
		/** @type {string[]} */ const out = [];
		let code = null;
		const child = r.rt.spawnAgent('x', {
			cwd: '/scratch',
			commit: () => new Promise((res) => r.clock.setTimeout(() => res({ rest: [mkdir('/scratch/d')], notes: [], failed: 0 }), 119000)),
		});
		child.stderr.on('data', (/** @type {string} */ t) => out.push(t));
		child.on('close', (/** @type {number} */ c) => { code = c; });
		await settle();
		await r.clock.advance(119999);
		assert.strictEqual(code, null);
		await r.clock.advance(1);
		assert.strictEqual(code, 1, 'at 120 s in all - the review\'s answer left it one second, not the 60 s of a call and not 240 s');
		assert.ok(out.join('').includes('ran out of time: the changes get 120 s in all'), out.join(''));
		r.rt.dispose();
	});

	/* ===== fix round 4: two combinations that were pinned by nothing ===================================== */

	await test('a worker that dies after `done` and then a Stop while the set is only being CHECKED: nothing is applied, both are said - the stop first, as the commit\'s own notes come, then the failure', async () => {
		/** @type {Array<[string, (w: any) => void, string]>} */
		const deaths = [['an error event', (w) => w.crash('late exception'), 'the shell engine stopped unexpectedly: late exception'],
			['a messageerror', (w) => w.onmessageerror({}), 'the shell engine sent a message that could not be read']];
		for (const [death, kill, failure] of deaths) {
			for (const how of ['session.stop', 'session.dispose', 'runtime.dispose']) {
				const r = createRig();
				r.ws.put('/scratch/old.txt', 'old');
				r.ws.hang('stat', (k) => k.endsWith('/old.txt'));
				/** @type {any} */ let worker;
				r.engines.state.onRun = async (run, w, h) => { worker = w; h.done({ exitCode: 0, how: 'exit', changes: [wr('/scratch/old.txt', 'new', 'old')] }); };
				const s = r.rt.createSession();
				const p = watch(s.run('x'));
				await until(() => r.ws.calls.some((c) => /^stat .*old\.txt$/.test(c)));
				kill(worker);
				await flush();
				assert.strictEqual(p.done, false, death + ': the check is still going on');
				if (how === 'session.stop') { s.stop(); } else if (how === 'session.dispose') { s.dispose(); } else { r.rt.dispose(); }
				await flush();
				assert.strictEqual(p.done, true, death + ' / ' + how);
				assert.deepStrictEqual(p.value.notes, [
					'[LevelCode Shell: stopped before anything was applied: the command\'s file changes were being checked, and were NOT applied.]',
					'[LevelCode Shell: ' + failure + ', after the command had finished]',
				], death + ' / ' + how);
				assert.strictEqual(r.ws.text('/scratch/old.txt'), 'old');
				assert.deepStrictEqual(writes(r), [], 'not one write');
				r.rt.dispose();
			}
		}
	});

	await test('a run stopped BEFORE its engine said done says that it was stopped, and what was true when it began - not the moved folder, not what the engine would have said, not that its output was cut', async () => {
		const FOLDERS = [{ name: 'scratch', root: '/scratch', uri: 'levelcode-scratch:///scratch' }, { name: 'rootfs', root: '/', uri: 'file:///' }];
		const STOPPED = '[LevelCode Shell: stopped. Any file changes the command had made were NOT applied.]';
		const TIMED_OUT = '[LevelCode Shell: the command ran out of time and was stopped. Any file changes it had made were NOT applied.]';
		/** An engine that writes more than the host's cap and never says `done` (it would have said a moved folder and notes of its own with it). */
		const hanging = (/** @type {any} */ r) => {
			r.engines.state.onRun = async (/** @type {any} */ run, /** @type {any} */ w, /** @type {any} */ h) => { h.out(run.id, 'stdout', 'x'.repeat(30)); await flush(); await new Promise(() => { }); };
		};
		for (const how of ['session.stop', 'session.dispose', 'runtime.dispose', 'a deadline']) {
			const r = createRig({ workspace: { folders: TWO_FOLDERS }, limits: TOO_MUCH });
			hanging(r);
			const s = r.rt.createSession();
			const p = watch(s.run('x', how === 'a deadline' ? { timeoutMs: 1000 } : undefined));
			await until(() => r.engines.workers.length > 0 && r.engines.workers[0].runs.length > 0);
			await flush();
			assert.strictEqual(r.rt.mounts().some((m) => m.reason), true, how + ': a folder IS moved');
			if (how === 'session.stop') { s.stop(); } else if (how === 'session.dispose') { s.dispose(); } else if (how === 'runtime.dispose') { r.rt.dispose(); } else { await r.clock.advance(1000); }
			await flush();
			assert.strictEqual(p.done, true, how);
			assert.deepStrictEqual(p.value.notes, [how === 'a deadline' ? TIMED_OUT : STOPPED], how);
			r.rt.dispose();
		}
		for (const [signal, code] of /** @type {Array<[string, number]>} */ ([['SIGTERM', 130], ['SIGKILL', 137]])) {
			const r = createRig({ workspace: { folders: TWO_FOLDERS }, limits: TOO_MUCH });
			hanging(r);
			const child = r.rt.spawnAgent('x', { cwd: '/scratch', folders: FOLDERS });
			const o = observe(child, 3000);
			await until(() => r.engines.workers.length > 0 && r.engines.workers[0].runs.length > 0);
			await flush();
			assert.strictEqual(child.kill(signal), true);
			await o.closed;
			assert.strictEqual(/** @type {any} */ (o.events[o.events.length - 1]).code, code);
			assert.strictEqual(o.stderr, STOPPED + '\n', signal);
			r.rt.dispose();
		}
		// What was already true when the run STARTED is the one thing it does carry: variables it was handed that were not kept.
		const r = createRig({ limits: TOO_MUCH });
		hanging(r);
		/** @type {Record<string, string>} */ const env = {};
		for (let i = 0; i < 513; i++) { env['V' + i] = 'x'; }
		const o = observe(r.rt.spawnAgent('x', { cwd: '/scratch', env }), 3000);
		await until(() => r.engines.workers.length > 0 && r.engines.workers[0].runs.length > 0);
		await flush();
		r.rt.dispose();
		await o.closed;
		assert.strictEqual(o.stderr, NOT_KEPT + '\n' + STOPPED + '\n');
	});

	finished = true;
	console.log(`\n${n} tests passed`);
})().catch((e) => { console.error(e); process.exit(1); });
