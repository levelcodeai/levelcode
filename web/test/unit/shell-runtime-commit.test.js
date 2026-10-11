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
 *  And what is never said falsely while a commit is going on: a worker that dies, a dispose() and a Stop that
 *  arrive after the engine said `done` do not settle the run with "nothing was applied" over files that land;
 *  a Stop that arrives while the set is only being CHECKED applies nothing; a folder that gained a file after
 *  the command ran is not removed with it.
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

	await test('Stop while the changes are being applied does not leave half of them: they finish, and the run says it was stopped', async () => {
		const r = createRig();
		ending(r, { exitCode: 0, changes: [wr('/scratch/a', 'a', null), wr('/scratch/b', 'b', null)] });
		/** @type {any} */ let child;
		let release = () => { };
		const hold = new Promise((res) => { release = () => res(undefined); });
		const killed = new Promise((res) => {
			child = r.rt.spawnAgent('x', {
				cwd: '/scratch',
				commit: async (/** @type {any[]} */ changes) => { res(undefined); await hold; return { rest: [], notes: ['[LevelCode Shell: 2 files changed]'], failed: 0 }; },
			});
		});
		const obs = observe(child, 3000);
		await killed;
		assert.strictEqual(child.kill('SIGTERM'), true);
		release();
		await obs.closed;
		const close = /** @type {any} */ (obs.events.find((e) => e.type === 'close'));
		assert.strictEqual(close.code, 130);
		assert.ok(/stopped while its file changes were being applied; 2 of them were applied/.test(obs.stderr), obs.stderr);
		r.rt.dispose();
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
		assert.ok(/stopped at \/scratch\/a: timed out/.test(res.notes.join('')), res.notes.join(''));
		r.rt.dispose();
	});

	await test('a stat that never answers while the change set is checked is a conflict after 60 s, not a hang', async () => {
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
		assert.ok(/could not be checked: timed out/.test(res.notes.join('')), res.notes.join(''));
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

	await test('dispose() while the changes are being written: the run ends when the writes do, "stopped while ... 2 of them were applied", and the files are there', async () => {
		for (const what of ['runtime.dispose', 'session.dispose', 'session.stop']) {
			const r = createRig();
			const g = gatedWrites(r);
			r.engines.state.onRun = async (run, w, h) => { h.done({ exitCode: 0, how: 'exit', changes: TWO }); };
			const s = r.rt.createSession();
			const p = watch(s.run('x'));
			await g.reached;
			if (what === 'runtime.dispose') { r.rt.dispose(); } else if (what === 'session.dispose') { s.dispose(); } else { s.stop(); }
			await flush();
			assert.strictEqual(p.done, false, what + ': settled while writing');
			g.open();
			await until(() => p.done);
			const res = p.value;
			assert.strictEqual(res.how, 'aborted', what);
			assert.strictEqual(res.exitCode, what === 'session.stop' ? 130 : 137, what);
			assert.strictEqual(res.applied, 2, what);
			assert.ok(/stopped while its file changes were being applied; 2 of them were applied/.test(res.notes.join('\n')), what + ': ' + res.notes.join('\n'));
			assert.ok(!/were NOT applied|Any file changes .* NOT applied/.test(res.notes.join('\n')), what);
			assert.deepStrictEqual(r.ws.list('/scratch'), ['a.txt', 'b.txt'], what);
			r.rt.dispose();
			assert.strictEqual(r.clock.pending, 0, what + ': a timer was left behind');
		}
	});

	await test('dispose() of the runtime while an agent\'s review is going on: close (137) comes when the review is done, with its count', async () => {
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
		await flush();
		assert.strictEqual(o.events.some((e) => e.type === 'close'), false);
		release();
		await o.closed;
		assert.strictEqual(/** @type {any} */ (o.events[o.events.length - 1]).code, 137);
		assert.ok(/stopped while its file changes were being applied; 1 of them were applied/.test(o.stderr), o.stderr);
		assert.strictEqual(r.ws.exists('/scratch/d'), false, 'the folders are not made after a stop: the review\'s file change was its own');
		assert.ok(!/NOT applied\.$/m.test(o.stderr));
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
		assert.strictEqual(p.done, false, 'the check is not interrupted mid-read; the answer is waited for');
		g.open();
		await until(() => p.done);
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
		assert.strictEqual(p.value.applied, 0);
		assert.ok(!r.ws.calls.some((c) => c === 'stat levelcode-scratch:/scratch/b'), 'b was not even looked at: ' + r.ws.calls.join(','));
		r.rt.dispose();
	});

	await test('an agent\'s SIGKILL during the review: the review finishes, the folders it left are NOT made, and the status is 137', async () => {
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
		release();
		await o.closed;
		assert.strictEqual(/** @type {any} */ (o.events[o.events.length - 1]).code, 137);
		assert.strictEqual(r.ws.exists('/scratch/d'), false);
		assert.ok(/1 of them were applied/.test(o.stderr), o.stderr);
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

	finished = true;
	console.log(`\n${n} tests passed`);
})().catch((e) => { console.error(e); process.exit(1); });
