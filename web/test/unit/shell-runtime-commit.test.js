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
 *  review itself throws or is handed something it must not be.
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

	finished = true;
	console.log(`\n${n} tests passed`);
})().catch((e) => { console.error(e); process.exit(1); });
