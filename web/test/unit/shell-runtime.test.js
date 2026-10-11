/*---------------------------------------------------------------------------------------------
 *  web/shell/src/runtime.js, the engine half - run: node web/test/unit/shell-runtime.test.js
 *
 *  Worker lifecycle and the read-only file-system RPC, against a FAKE ENGINE that speaks README section 4
 *  (web/test/helpers/shell-runtime-fakes.js) and a Map-backed workspace.fs with the real error shapes:
 *
 *    lazy spawn, init and run messages, the worker cap, idle termination and respawn, Stop, the host deadline,
 *    a worker that dies, a postMessage that throws, a read that never answers, a worker that is not ready;
 *    the generation guard (late and foreign messages are dropped);
 *    reads: a path outside every mount is EACCES and never touches the workspace, `..` is resolved first,
 *    FileSystemError -> POSIX code, the per-file cap is checked with a stat BEFORE the read, the per-run
 *    budget cannot be beaten by reading in parallel.
 *
 *  The commit of what a run changed is shell-runtime-commit.test.js; Session and Tab completion are
 *  shell-runtime-session.test.js; the agent's ChildLike is shell-runtime-agent.test.js.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

// A promise that never settles ends the process with status 0 and no output: a suite that did not finish fails.
let finished = false;
process.on('exit', (code) => { if (!finished && code === 0) { console.error('not ok - the tests did not finish'); process.exitCode = 1; } });

const assert = require('assert');
const path = require('path');

const { createRig, flush, FileSystemError } = require(path.join(__dirname, '..', 'helpers', 'shell-runtime-fakes.js'));
const { planMounts, toMountPath, toRootPath, normalizePath, posixCode } = require(path.join(__dirname, '..', '..', 'shell', 'src', 'runtime.js'));
const { PROGRAMS } = require(path.join(__dirname, '..', '..', 'shell', 'src', 'info.js'));

const MiB = 1024 * 1024;
let n = 0;
async function test(/** @type {string} */ name, /** @type {() => Promise<void>} */ fn) { await fn(); n++; console.log('  ok - ' + name); }

/** The engine's side of a run that reads `reads` in order and then ends the script with `done`. */
function readsThenDone(/** @type {Array<[string, string]>} */ reads, /** @type {any} */ done, /** @type {any[]} */ out) {
	return async (/** @type {any} */ run, /** @type {any} */ w, /** @type {any} */ h) => {
		for (const [op, p] of reads) { out.push(await h.fs(op, p)); }
		h.done(done || { exitCode: 0, how: 'exit' });
	};
}

(async () => {
	/* ===== lifecycle ===================================================================== */

	await test('nothing is started until a run needs it: no worker, no script read', async () => {
		const r = createRig();
		const s = r.rt.createSession();
		assert.strictEqual(r.engines.workers.length, 0);
		assert.strictEqual(r.state.loads, 0);
		assert.strictEqual(r.clock.pending, 0, 'no timer either');
		await s.run('echo hi');
		assert.strictEqual(r.engines.workers.length, 1);
		assert.strictEqual(r.state.loads, 1);
		assert.strictEqual(r.engines.workers[0].source, 'engine-source');
		r.rt.dispose();
	});

	await test('the engine is told its mounts, limits and command list once, then its run', async () => {
		const r = createRig({ workspace: { folders: [{ name: 'scratch', uri: 'levelcode-scratch:///scratch' }, { name: 'proj', uri: 'file:///proj' }] } });
		const s = r.rt.createSession();
		await s.run('ls -la');
		const sent = r.engines.workers[0].sent;
		assert.deepStrictEqual(sent.map((/** @type {any} */ m) => m.t), ['init', 'run']);
		const init = sent[0];
		assert.strictEqual(typeof init.gen, 'number');
		assert.deepStrictEqual(init.folders, [{ id: 'ws0', path: '/scratch', name: 'scratch' }, { id: 'ws1', path: '/proj', name: 'proj' }]);
		assert.deepStrictEqual(init.commands, PROGRAMS);
		assert.deepStrictEqual(init.limits, {
			maxCommandCount: 100000, maxLoopIterations: 100000, maxCallDepth: 100,
			maxOutputSize: 8 * MiB, maxStringLength: 16 * MiB, maxLiveBytes: 64 * MiB, maxInputBytes: 32 * MiB, maxExecutionTimeMs: 600000,
		});
		const run = sent[1];
		assert.strictEqual(run.script, 'ls -la');
		assert.strictEqual(run.cwd, '/scratch', 'the first folder');
		assert.strictEqual(run.stdin, '');
		assert.deepStrictEqual(run.caps, { readFile: 4 * MiB, readRun: 16 * MiB, writeFile: 8 * MiB, writeRun: 32 * MiB, entries: 2000 });
		assert.deepStrictEqual(run.env, { HOME: '/home/user', PATH: '/usr/bin:/bin', PWD: '/scratch', TERM: 'dumb', CI: '1', NO_COLOR: '1', LANG: 'C.UTF-8' });
		r.rt.dispose();
	});

	await test('a terminal line asks the engine to keep /tmp and aliases from line to line; an agent command does not', async () => {
		const r = createRig();
		await r.rt.createSession().run('alias ll=ls');
		await new Promise((res) => { const c = r.rt.spawnAgent('echo', { cwd: '/scratch' }); c.on('close', res); });
		const term = r.engines.workers[0].runs[0];
		const agent = r.engines.workers[1].runs[0];
		assert.strictEqual(term.keepTmp, true);
		assert.strictEqual(term.expandAliases, true);
		assert.ok(!('keepTmp' in agent) && !('expandAliases' in agent), 'fresh, like sh -c');
		r.rt.dispose();
	});

	await test('the program list that counts is the engine\'s: info.commands follows `ready`, sorted and without duplicates', async () => {
		const r = createRig({ engines: { commands: ['zeta', 'cat', 'alpha', 'cat', 'git'] } });
		assert.deepStrictEqual(r.rt.info.commands, PROGRAMS, 'the constant, until an engine has started');
		assert.ok(r.rt.info.missing.includes('git'));
		await r.rt.createSession().run('x');
		assert.deepStrictEqual(r.rt.info.commands, ['alpha', 'cat', 'git', 'zeta']);
		assert.ok(!r.rt.info.missing.includes('git'), 'a program the engine really has is not "missing"');
		assert.ok(r.rt.info.missing.includes('npm'));
		r.rt.dispose();
	});

	await test('a session keeps ONE worker across its runs', async () => {
		const r = createRig();
		const s = r.rt.createSession();
		for (let i = 0; i < 3; i++) { await s.run('echo ' + i); }
		assert.strictEqual(r.engines.workers.length, 1);
		assert.deepStrictEqual(r.engines.workers[0].sent.map((/** @type {any} */ m) => m.t), ['init', 'run', 'run', 'run']);
		r.rt.dispose();
	});

	await test('an idle worker is terminated after 60 s and the next run spawns another; cwd and env are the session\'s, so nothing is lost', async () => {
		const r = createRig();
		r.engines.state.onRun = async (run, w, h) => { h.done({ exitCode: 0, how: 'exit', cwd: '/scratch/sub', env: { KEPT: run.script } }); };
		r.ws.mkdir('/scratch/sub');
		const s = r.rt.createSession();
		await s.run('first');
		await r.clock.advance(59999);
		assert.strictEqual(r.engines.workers[0].terminated, false);
		await r.clock.advance(1);
		assert.strictEqual(r.engines.workers[0].terminated, true);
		const seen = [];
		r.engines.state.onRun = async (run, w, h) => { seen.push({ cwd: run.cwd, kept: run.env.KEPT }); h.done({ exitCode: 0, how: 'exit', cwd: run.cwd, env: run.env }); };
		await s.run('second');
		assert.strictEqual(r.engines.workers.length, 2);
		assert.deepStrictEqual(seen, [{ cwd: '/scratch/sub', kept: 'first' }]);
		r.rt.dispose();
	});

	await test('use resets the idle clock', async () => {
		const r = createRig();
		const s = r.rt.createSession();
		await s.run('a');
		await r.clock.advance(50000);
		await s.run('b');
		await r.clock.advance(50000);
		assert.strictEqual(r.engines.workers[0].terminated, false, '100 s after the first run but 50 s after the last');
		await r.clock.advance(10000);
		assert.strictEqual(r.engines.workers[0].terminated, true);
		assert.strictEqual(r.engines.workers.length, 1);
		r.rt.dispose();
	});

	await test('no timer is left running for an idle runtime that has nothing to terminate', async () => {
		const r = createRig();
		const s = r.rt.createSession();
		await s.run('a');
		s.dispose();
		assert.strictEqual(r.clock.pending, 0);
		r.rt.dispose();
	});

	/* ===== the cap ======================================================================= */

	await test('at most 4 workers: a fifth busy run is refused with a message, no fifth worker is made', async () => {
		const r = createRig();
		/** @type {Array<() => void>} */ const release = [];
		r.engines.state.onRun = async (run, w, h) => { await new Promise((res) => release.push(() => { h.done({}); res(undefined); })); };
		const sessions = [1, 2, 3, 4, 5].map(() => r.rt.createSession());
		const first = sessions.slice(0, 4).map((s) => s.run('sleep'));
		await flush();
		assert.strictEqual(r.engines.workers.length, 4);
		const fifth = await sessions[4].run('echo too many');
		assert.strictEqual(r.engines.workers.length, 4);
		assert.strictEqual(fifth.how, 'error');
		assert.strictEqual(fifth.exitCode, 1);
		assert.ok(/too many commands are running at once \(4\)/.test(fifth.notes.join('\n')), fifth.notes.join('\n'));
		release.forEach((f) => f());
		const done = await Promise.all(first);
		assert.deepStrictEqual(done.map((d) => d.how), ['exit', 'exit', 'exit', 'exit']);
		r.rt.dispose();
	});

	await test('when all four exist but one is idle, that one is replaced for the new run (the least recently used)', async () => {
		const r = createRig();
		const sessions = [1, 2, 3, 4].map(() => r.rt.createSession());
		for (const s of sessions) { await s.run('x'); await r.clock.advance(1000); }
		assert.strictEqual(r.engines.workers.length, 4);
		const fifth = r.rt.createSession();
		const res = await fifth.run('y');
		assert.strictEqual(res.how, 'exit');
		assert.strictEqual(r.engines.workers.length, 5, 'one more was created...');
		assert.strictEqual(r.engines.workers.filter((w) => !w.terminated).length, 4, '...and one was terminated: never more than 4 alive');
		assert.strictEqual(r.engines.workers[0].terminated, true, 'the one used longest ago');
		// the evicted session simply gets a new worker at its next run
		assert.strictEqual((await sessions[0].run('z')).how, 'exit');
		r.rt.dispose();
	});

	/* ===== stop, deadline, a worker that fails =============================================== */

	await test('Stop terminates the worker and settles the run as aborted; what it said before is kept, a late `done` is not heard', async () => {
		const r = createRig();
		let started;
		const got = new Promise((res) => { started = res; });
		r.engines.state.onRun = async (run, w, h) => { h.out(run.id, 'stdout', 'before stop\n'); started(w); await new Promise(() => { }); };
		const s = r.rt.createSession();
		const chunks = [];
		const p = s.run('sleep 99', { onStdout: (t) => chunks.push(t) });
		const w = await got;
		await flush();
		s.stop();
		const res = await p;
		assert.deepStrictEqual({ how: res.how, exitCode: res.exitCode, applied: res.applied }, { how: 'aborted', exitCode: 130, applied: 0 });
		assert.ok(/NOT applied/.test(res.notes.join('\n')), res.notes.join('\n'));
		assert.deepStrictEqual(chunks, ['before stop\n']);
		assert.strictEqual(w.terminated, true);
		w.emitAlways({ t: 'done', id: w.currentRun, exitCode: 0, how: 'exit', cwd: '/x', env: { LATE: '1' }, changes: [{ kind: 'write', path: '/scratch/late.txt', existed: false, before: null, after: new Uint8Array(1) }] });
		await flush();
		assert.strictEqual(r.ws.exists('/scratch/late.txt'), false, 'nothing a dead worker says reaches the workspace');
		assert.ok(!('LATE' in s.env));
		r.rt.dispose();
	});

	await test('the session works after a Stop: a new worker, same cwd and env', async () => {
		const r = createRig();
		r.engines.state.onRun = async (run, w, h) => { if (run.script === 'hang') { await new Promise(() => { }); } h.done({ exitCode: 7, how: 'exit', cwd: '/scratch', env: { OK: '1' } }); };
		const s = r.rt.createSession();
		const p = s.run('hang');
		await flush();
		s.stop();
		await p;
		const res = await s.run('after');
		assert.deepStrictEqual({ how: res.how, exitCode: res.exitCode }, { how: 'exit', exitCode: 7 });
		assert.strictEqual(r.engines.workers.length, 2);
		assert.strictEqual(s.env.OK, '1');
		r.rt.dispose();
	});

	await test('Stop with nothing running does nothing', async () => {
		const r = createRig();
		const s = r.rt.createSession();
		s.stop();
		await s.run('x');
		s.stop();
		assert.strictEqual(r.engines.workers[0].terminated, false);
		r.rt.dispose();
	});

	await test('a run that outlives the host deadline is terminated and settles as a deadline, nothing applied', async () => {
		const r = createRig({ limits: { engine: { maxExecutionTimeMs: 1000 }, workers: { deadlineGraceMs: 500 } } });
		r.engines.state.onRun = async (run, w, h) => {
			h.out(run.id, 'stdout', 'working\n');
			await new Promise(() => { });
		};
		const s = r.rt.createSession();
		const p = s.run('while true; do :; done');
		await r.clock.advance(1499);
		assert.strictEqual(r.engines.workers[0].terminated, false);
		await r.clock.advance(1);
		const res = await p;
		assert.deepStrictEqual({ how: res.how, exitCode: res.exitCode, applied: res.applied }, { how: 'deadline', exitCode: 124, applied: 0 });
		assert.strictEqual(r.engines.workers[0].terminated, true);
		assert.ok(/ran out of time/.test(res.notes.join('\n')));
		r.rt.dispose();
	});

	await test('the deadline can be asked for per run, and a finished run does not leave its timer behind', async () => {
		const r = createRig();
		const s = r.rt.createSession();
		await s.run('quick', { timeoutMs: 5000 });
		assert.strictEqual(r.clock.pending, 1, 'only the idle timer');
		r.engines.state.onRun = async () => { await new Promise(() => { }); };
		const p = s.run('slow', { timeoutMs: 2000 });
		await r.clock.advance(2000);
		assert.strictEqual((await p).how, 'deadline');
		r.rt.dispose();
	});

	await test('a worker that dies under a run: the run ends as an error with the reason, and a new worker serves the next', async () => {
		const r = createRig();
		r.engines.state.onRun = async (run, w) => { w.crash('out of memory'); };
		const s = r.rt.createSession();
		const res = await s.run('boom');
		assert.deepStrictEqual({ how: res.how, exitCode: res.exitCode }, { how: 'error', exitCode: 1 });
		assert.ok(/stopped unexpectedly: out of memory/.test(res.notes.join('\n')), res.notes.join('\n'));
		assert.strictEqual(r.engines.workers[0].terminated, true);
		r.engines.state.onRun = async (run, w, h) => { h.done({ exitCode: 0, how: 'exit' }); };
		assert.strictEqual((await s.run('again')).how, 'exit');
		assert.strictEqual(r.engines.workers.length, 2);
		r.rt.dispose();
	});

	await test('a postMessage that throws does not leave the run pending', async () => {
		const r = createRig();
		const orig = r.engines.create;
		let armed = false;
		const rt2 = require(path.join(__dirname, '..', '..', 'shell', 'src', 'runtime.js')).createRuntime({
			vscode: r.ws.vscode, loadEngineSource: async () => 'src',
			createWorker: (/** @type {string} */ src) => {
				const w = orig(src);
				const post = w.postMessage.bind(w);
				w.postMessage = (/** @type {any} */ m, /** @type {any} */ t) => { if (armed && m.t === 'run') { throw new Error('DataCloneError'); } post(m, t); };
				return w;
			},
			now: r.clock.now, setTimeout: r.clock.setTimeout, clearTimeout: r.clock.clearTimeout,
		});
		const s = rt2.createSession();
		await s.run('warm up');
		armed = true;
		const res = await s.run('x');
		assert.strictEqual(res.how, 'error');
		assert.ok(/could not be reached: DataCloneError/.test(res.notes.join('\n')), res.notes.join('\n'));
		rt2.dispose();
		r.rt.dispose();
	});

	await test('an engine that cannot even be sent its init is an error that says why, and no worker is left', async () => {
		const r = createRig();
		const orig = r.engines.create;
		const rt2 = require(path.join(__dirname, '..', '..', 'shell', 'src', 'runtime.js')).createRuntime({
			vscode: r.ws.vscode, loadEngineSource: async () => 'src',
			createWorker: (/** @type {string} */ src) => {
				const w = orig(src);
				w.postMessage = () => { throw new Error('the port is closed'); };
				return w;
			},
			now: r.clock.now, setTimeout: r.clock.setTimeout, clearTimeout: r.clock.clearTimeout,
		});
		const res = await rt2.createSession().run('x');
		assert.deepStrictEqual({ how: res.how, exitCode: res.exitCode }, { how: 'error', exitCode: 1 });
		assert.ok(/could not be reached: the port is closed/.test(res.notes.join('\n')), res.notes.join('\n'));
		assert.strictEqual(r.engines.workers[0].terminated, true);
		rt2.dispose();
		r.rt.dispose();
	});

	await test('a worker that cannot be created is an error with the reason - and is tried again next time', async () => {
		const r = createRig();
		const s = r.rt.createSession();
		r.engines.state.failCreate = new Error('Worker is not defined');
		const res = await s.run('a');
		assert.deepStrictEqual({ how: res.how, exitCode: res.exitCode }, { how: 'error', exitCode: 1 });
		assert.ok(/Worker is not defined/.test(res.notes.join('\n')));
		assert.strictEqual(r.engines.workers.length, 0);
		r.engines.state.failCreate = null;
		assert.strictEqual((await s.run('b')).how, 'exit');
		r.rt.dispose();
	});

	await test('a script that cannot be loaded is an error with the reason; a failure is not kept, a success is', async () => {
		const r = createRig();
		const s = r.rt.createSession();
		r.state.loadError = new Error('engine.worker.js: 404');
		let res = await s.run('a');
		assert.deepStrictEqual({ how: res.how, exitCode: res.exitCode }, { how: 'error', exitCode: 1 });
		assert.ok(/engine\.worker\.js: 404/.test(res.notes.join('\n')), res.notes.join('\n'));
		assert.strictEqual(r.engines.workers.length, 0);
		r.state.loadError = null;
		assert.strictEqual((await s.run('b')).how, 'exit');
		assert.strictEqual((await s.run('c')).how, 'exit');
		assert.strictEqual(r.state.loads, 2, 'one failure and ONE success: a loaded script is kept');
		// two runs asking at the same moment share one load
		const r2 = createRig();
		await Promise.all([r2.rt.createSession().run('a'), r2.rt.createSession().run('b')]);
		assert.strictEqual(r2.state.loads, 1);
		r.rt.dispose();
		r2.rt.dispose();
	});

	await test('a script load that never answers is given 20 s; then the run is an error and the next run loads again', async () => {
		const r = createRig();
		let hang = true;
		const { createRuntime } = require(path.join(__dirname, '..', '..', 'shell', 'src', 'runtime.js'));
		const rt = createRuntime({
			vscode: r.ws.vscode, loadEngineSource: () => (hang ? new Promise(() => { }) : Promise.resolve('src')),
			createWorker: r.engines.create, now: r.clock.now, setTimeout: r.clock.setTimeout, clearTimeout: r.clock.clearTimeout,
		});
		const s = rt.createSession();
		const p = s.run('x');
		await r.clock.advance(20000);
		const res = await p;
		assert.strictEqual(res.how, 'error');
		assert.ok(/could not be loaded in 20 s/.test(res.notes.join('')), res.notes.join(''));
		assert.strictEqual(r.engines.workers.length, 0);
		hang = false;
		assert.strictEqual((await s.run('y')).how, 'exit');
		rt.dispose();
		r.rt.dispose();
	});

	await test('a file system that answers with something that is not bytes, and a stat without a time, are handled', async () => {
		const r = createRig();
		r.ws.put('/scratch/a', 'x');
		const realStat = r.ws.fs.stat.bind(r.ws.fs);
		r.ws.fs.stat = async (/** @type {any} */ u) => { const s = await realStat(u); return { type: s.type, size: s.size }; };
		const out = [];
		r.engines.state.onRun = readsThenDone([['stat', '/scratch/a'], ['readFile', '/scratch/a']], null, out);
		r.ws.fs.readFile = async () => /** @type {any} */ ('not bytes');
		await r.rt.createSession().run('x');
		assert.deepStrictEqual(out[0].value, { type: 'file', size: 1, mtime: 0 });
		assert.deepStrictEqual({ ok: out[1].ok, code: out[1].error.code }, { ok: false, code: 'EIO' });
		r.rt.dispose();
	});

	await test('an engine that never says `ready` is given 20 s, then the run is an error and its worker is gone', async () => {
		const r = createRig();
		r.engines.state.noReady = true;
		const s = r.rt.createSession();
		const p = s.run('x');
		await r.clock.advance(19999);
		assert.strictEqual(r.engines.workers[0].terminated, false);
		await r.clock.advance(1);
		const res = await p;
		assert.strictEqual(res.how, 'error');
		assert.ok(/did not start in 20 s/.test(res.notes.join('\n')), res.notes.join('\n'));
		assert.strictEqual(r.engines.workers[0].terminated, true);
		r.rt.dispose();
	});

	/* ===== the generation guard ============================================================ */

	await test('a `ready` stamped with another generation is not this worker\'s: it never becomes ready', async () => {
		const r = createRig();
		r.engines.state.readyGen = 9999;
		const s = r.rt.createSession();
		const p = s.run('x');
		await r.clock.advance(20000);
		assert.strictEqual((await p).how, 'error');
		r.rt.dispose();
	});

	await test('messages from an older worker of the same session are dropped: out, fs and done', async () => {
		const r = createRig();
		r.ws.put('/scratch/secret.txt', 'x');
		/** @type {any} */ let first;
		r.engines.state.onRun = async (run, w, h) => {
			if (run.script === 'one') { first = w; await new Promise(() => { }); }
			// the second run's worker is quiet for a moment while the first one's ghost talks
			first.emitAlways({ t: 'out', id: run.id, stream: 'stdout', text: 'GHOST' });
			first.emitAlways({ t: 'fs', rid: 77, op: 'readFile', path: '/scratch/secret.txt' });
			first.emitAlways({ t: 'done', id: run.id, exitCode: 99, how: 'exit', cwd: '/', env: {}, changes: [] });
			await flush();
			h.out(run.id, 'stdout', 'real\n');
			h.done({ exitCode: 0, how: 'exit' });
		};
		const s = r.rt.createSession();
		const p1 = s.run('one');
		await flush();
		s.stop();
		await p1;
		const got = [];
		const res = await s.run('two', { onStdout: (t) => got.push(t) });
		assert.deepStrictEqual(got, ['real\n']);
		assert.strictEqual(res.exitCode, 0);
		assert.ok(!r.ws.calls.some((c) => c.includes('secret.txt')), 'a dead worker cannot make the host read: ' + r.ws.calls.join(','));
		assert.ok(!first.sent.some((/** @type {any} */ m) => m.t === 'fsr'), 'and gets no answer');
		r.rt.dispose();
	});

	await test('a message stamped with a generation that is not the worker\'s is dropped, whatever it says', async () => {
		const r = createRig();
		r.engines.state.onRun = async (run, w, h) => {
			w.emit({ t: 'done', gen: w.gen + 1, id: run.id, exitCode: 99, how: 'exit', cwd: '/', env: {}, changes: [] });
			await flush();
			h.done({ exitCode: 4, how: 'exit' });
		};
		const res = await r.rt.createSession().run('x');
		assert.strictEqual(res.exitCode, 4);
		r.rt.dispose();
	});

	await test('garbage from an engine is ignored: not objects, unknown types, ids that are not the run\'s', async () => {
		const r = createRig();
		const seen = [];
		r.engines.state.onRun = async (run, w, h) => {
			for (const m of [null, 'done', 7, [], {}, { t: 'what' }, { t: 'out', id: run.id + 1000, stream: 'stdout', text: 'WRONG RUN' },
				{ t: 'out', id: run.id, stream: 'stdout', text: 12 }, { t: 'done', id: run.id + 1000, exitCode: 55, how: 'exit' }, { t: 'fs', rid: 1 }]) {
				w.emit(m);
			}
			await flush();
			h.out(run.id, 'stdout', 'right\n');
			h.done({ exitCode: 0, how: 'exit' });
		};
		const res = await r.rt.createSession().run('x', { onStdout: (t) => seen.push(t) });
		assert.deepStrictEqual(seen, ['right\n']);
		assert.strictEqual(res.exitCode, 0);
		assert.strictEqual(r.engines.errors.length, 0);
		r.rt.dispose();
	});

	/* ===== reads ======================================================================== */

	await test('stat, readFile and readDir answer in the shapes of README section 4', async () => {
		const r = createRig();
		r.ws.put('/scratch/a.txt', 'hello');
		r.ws.put('/scratch/sub/b.txt', 'b');
		/** @type {any[]} */ const out = [];
		r.engines.state.onRun = readsThenDone([['stat', '/scratch/a.txt'], ['stat', '/scratch/sub'], ['readFile', '/scratch/a.txt'], ['readDir', '/scratch']], null, out);
		await r.rt.createSession().run('x');
		assert.strictEqual(out[0].ok, true);
		assert.deepStrictEqual({ type: out[0].value.type, size: out[0].value.size, hasMtime: typeof out[0].value.mtime === 'number' }, { type: 'file', size: 5, hasMtime: true });
		assert.strictEqual(out[1].value.type, 'dir');
		assert.ok(out[2].value instanceof Uint8Array);
		assert.strictEqual(Buffer.from(out[2].value).toString(), 'hello');
		assert.deepStrictEqual(out[3].value.slice().sort(), [['a.txt', 'file'], ['sub', 'dir']]);
		assert.deepStrictEqual(out.map((m) => m.t), ['fsr', 'fsr', 'fsr', 'fsr']);
		r.rt.dispose();
	});

	await test('file bytes are a copy that is transferred: changing what the host sent cannot change what the workspace holds', async () => {
		const r = createRig();
		r.ws.put('/scratch/a.txt', 'hello');
		/** @type {any[]} */ const out = [];
		r.engines.state.onRun = readsThenDone([['readFile', '/scratch/a.txt']], null, out);
		await r.rt.createSession().run('x');
		out[0].value[0] = 0x58;
		assert.strictEqual(r.ws.text('/scratch/a.txt'), 'hello');
		assert.strictEqual(r.engines.workers[0].transfers, 1, 'the copy went in the transfer list');
		r.rt.dispose();
	});

	await test('a path outside every mount is EACCES and the workspace is never asked', async () => {
		const r = createRig({ workspace: { folders: [{ name: 'scratch', uri: 'levelcode-scratch:///scratch' }] } });
		r.ws.mkdir('/scratchy');
		r.ws.put('/scratchy/x.txt', 'x');
		r.ws.put('/etc/passwd', 'root');
		const paths = ['/etc/passwd', '/scratch/../etc/passwd', '/scratch/../../etc/passwd', '/scratchy/x.txt', '/', '', 'scratch/a.txt', './a.txt', '/scratch\0/x', 42, null, undefined];
		/** @type {any[]} */ const out = [];
		r.engines.state.onRun = readsThenDone(paths.map((p) => /** @type {[string, string]} */ (['readFile', /** @type {any} */ (p)])), null, out);
		await r.rt.createSession().run('x');
		assert.strictEqual(out.length, paths.length);
		for (const m of out) { assert.deepStrictEqual({ ok: m.ok, code: m.error && m.error.code }, { ok: false, code: 'EACCES' }); }
		assert.deepStrictEqual(r.ws.calls, [], 'not one workspace call: ' + r.ws.calls.join(','));
		r.rt.dispose();
	});

	await test('`..` inside a mount is resolved before the mount is looked up', async () => {
		const r = createRig();
		r.ws.put('/scratch/b.txt', 'b');
		/** @type {any[]} */ const out = [];
		r.engines.state.onRun = readsThenDone([['readFile', '/scratch/a/../b.txt'], ['readFile', '/scratch/./b.txt'], ['readFile', '/scratch//b.txt']], null, out);
		await r.rt.createSession().run('x');
		assert.deepStrictEqual(out.map((m) => m.ok), [true, true, true]);
		assert.deepStrictEqual(r.ws.calls.filter((c) => c.startsWith('readFile')), ['readFile levelcode-scratch:/scratch/b.txt', 'readFile levelcode-scratch:/scratch/b.txt', 'readFile levelcode-scratch:/scratch/b.txt']);
		r.rt.dispose();
	});

	await test('every folder is its own scheme: a path goes to the folder it is in, by longest prefix', async () => {
		const r = createRig({ workspace: { folders: [{ name: 'scratch', uri: 'levelcode-scratch:///scratch' }, { name: 'proj', uri: 'file:///proj' }] } });
		r.ws.put('levelcode-scratch:/scratch/a.txt', 'S');
		r.ws.put('file:/proj/a.txt', 'P');
		/** @type {any[]} */ const out = [];
		r.engines.state.onRun = readsThenDone([['readFile', '/scratch/a.txt'], ['readFile', '/proj/a.txt']], null, out);
		await r.rt.createSession().run('x');
		assert.deepStrictEqual(out.map((m) => Buffer.from(m.value).toString()), ['S', 'P']);
		r.rt.dispose();
	});

	await test('FileSystemError and the browser\'s own errors are told to the engine as POSIX codes, with plain text', async () => {
		const r = createRig();
		r.ws.put('/scratch/f.txt', 'x');
		r.ws.mkdir('/scratch/d');
		const dom = (/** @type {string} */ name) => Object.assign(new Error('provider text with levelcode-scratch:///secret/path'), { name });
		const cases = [
			['stat', '/scratch/missing', null, 'ENOENT'],
			['readFile', '/scratch/d', null, 'EISDIR'],
			['readDir', '/scratch/f.txt', null, 'ENOTDIR'],
			['readFile', '/scratch/f.txt', new FileSystemError('NoPermissions', 'NoPermissions', 'nope'), 'EACCES'],
			['readFile', '/scratch/f.txt', new FileSystemError('FileExists', 'EntryExists', 'dup'), 'EEXIST'],
			['readFile', '/scratch/f.txt', dom('NotFoundError'), 'ENOENT'],
			['readFile', '/scratch/f.txt', dom('NotAllowedError'), 'EACCES'],
			['readFile', '/scratch/f.txt', dom('SecurityError'), 'EACCES'],
			['readFile', '/scratch/f.txt', dom('TypeMismatchError'), 'ENOTDIR'],
			['readFile', '/scratch/f.txt', new Error('the disk caught fire'), 'EIO'],
		];
		/** @type {any[]} */ const out = [];
		let i = 0;
		r.engines.state.onRun = async (run, w, h) => {
			for (const [op, p, err] of cases) {
				r.ws.clearRules();
				if (err) { r.ws.fail(op === 'readFile' ? 'stat' : /** @type {string} */ (op), (k) => k.endsWith(/** @type {string} */ (p)), err); }
				out.push(await h.fs(/** @type {string} */ (op), /** @type {string} */ (p)));
				i++;
			}
			h.done({});
		};
		await r.rt.createSession().run('x');
		assert.deepStrictEqual(out.map((m) => m.error.code), cases.map((c) => c[3]));
		for (const m of out) { assert.ok(!/levelcode-scratch:|secret/.test(m.error.message), 'a provider\'s own text is not passed on: ' + m.error.message); }
		assert.ok(/the disk caught fire/.test(out[9].error.message), 'only what could not be classified keeps (a trimmed copy of) its text');
		r.rt.dispose();
	});

	await test('posixCode: the shapes measured in the web workbench', () => {
		assert.strictEqual(posixCode({ code: 'FileNotFound', name: 'EntryNotFound (FileSystemError)' }), 'ENOENT');
		assert.strictEqual(posixCode({ name: 'EntryNotFound (FileSystemError)' }), 'ENOENT');
		assert.strictEqual(posixCode({ name: 'NoPermissions (FileSystemError)' }), 'EACCES');
		assert.strictEqual(posixCode({ name: 'EntryIsADirectory (FileSystemError)' }), 'EISDIR');
		assert.strictEqual(posixCode({ code: 'ENOENT' }), 'ENOENT', 'a Node-style code passes through');
		assert.strictEqual(posixCode({ code: 'EWHATEVER' }), 'EIO');
		assert.strictEqual(posixCode(null), 'EIO');
		return Promise.resolve();
	});

	await test('one file over the per-file cap is EFBIG and is never read: the size is asked first', async () => {
		const r = createRig();
		r.ws.put('/scratch/big', new Uint8Array(4 * MiB + 1));
		r.ws.put('/scratch/exact', new Uint8Array(4 * MiB));
		/** @type {any[]} */ const out = [];
		r.engines.state.onRun = readsThenDone([['readFile', '/scratch/big'], ['readFile', '/scratch/exact']], null, out);
		await r.rt.createSession().run('x');
		assert.deepStrictEqual({ ok: out[0].ok, code: out[0].error.code }, { ok: false, code: 'EFBIG' });
		assert.strictEqual(out[1].ok, true, 'exactly the cap is allowed');
		assert.deepStrictEqual(r.ws.calls.filter((c) => /big$/.test(c)), ['stat levelcode-scratch:/scratch/big'], 'stat only');
		r.rt.dispose();
	});

	await test('a provider that lies about size is caught after the read: the bytes are not sent', async () => {
		const r = createRig({ limits: { read: { file: 10, run: 1000, served: 1000 } } });
		r.ws.put('/scratch/liar', 'x'.repeat(50));
		const realStat = r.ws.fs.stat.bind(r.ws.fs);
		r.ws.fs.stat = async (/** @type {any} */ u) => { const s = await realStat(u); return /liar/.test(u.path) ? Object.assign(s, { size: 0 }) : s; };
		/** @type {any[]} */ const out = [];
		r.engines.state.onRun = readsThenDone([['readFile', '/scratch/liar']], null, out);
		await r.rt.createSession().run('x');
		assert.deepStrictEqual({ ok: out[0].ok, code: out[0].error.code }, { ok: false, code: 'EFBIG' });
		r.rt.dispose();
	});

	await test('the per-run read budget: files are refused (EFBIG, as the engine itself says it) once it is spent, and it starts again with the next run', async () => {
		const r = createRig({ limits: { read: { file: 100, run: 250, served: 250 } } });
		for (const f of ['a', 'b', 'c']) { r.ws.put('/scratch/' + f, 'x'.repeat(100)); }
		/** @type {any[]} */ const out = [];
		r.engines.state.onRun = readsThenDone([['readFile', '/scratch/a'], ['readFile', '/scratch/b'], ['readFile', '/scratch/c'], ['readFile', '/scratch/a']], null, out);
		const s = r.rt.createSession();
		await s.run('x');
		assert.deepStrictEqual(out.map((m) => (m.ok ? 'ok' : m.error.code)), ['ok', 'ok', 'EFBIG', 'EFBIG']);
		out.length = 0;
		await s.run('y');
		assert.deepStrictEqual(out.map((m) => (m.ok ? 'ok' : m.error.code)), ['ok', 'ok', 'EFBIG', 'EFBIG'], 'a new run, a new budget');
		r.rt.dispose();
	});

	await test('the host\'s backstop is bigger than the engine\'s budget: the engine\'s own reads of the originals it keeps are served', async () => {
		const r = createRig({ limits: { read: { file: 100, run: 100, served: 300 } } });
		for (const f of ['a', 'b', 'c', 'd']) { r.ws.put('/scratch/' + f, 'x'.repeat(100)); }
		/** @type {any[]} */ const out = [];
		r.engines.state.onRun = readsThenDone(['a', 'b', 'c', 'd'].map((f) => /** @type {[string, string]} */ (['readFile', '/scratch/' + f])), null, out);
		await r.rt.createSession().run('x');
		assert.deepStrictEqual(out.map((m) => (m.ok ? 'ok' : m.error.code)), ['ok', 'ok', 'ok', 'EFBIG']);
		assert.strictEqual(r.engines.workers[0].runs[0].caps.readRun, 100, 'the engine is told ITS budget');
		r.rt.dispose();
	});

	await test('reads issued at the same time cannot beat the budget: it is reserved before the read starts', async () => {
		const r = createRig({ limits: { read: { file: 100, run: 250, served: 250 } } });
		for (const f of ['a', 'b', 'c', 'd']) { r.ws.put('/scratch/' + f, 'x'.repeat(100)); }
		/** @type {any[]} */ const out = [];
		r.engines.state.onRun = async (run, w, h) => {
			out.push(...await Promise.all(['a', 'b', 'c', 'd'].map((f) => h.fs('readFile', '/scratch/' + f))));
			h.done({});
		};
		await r.rt.createSession().run('x');
		assert.strictEqual(out.filter((m) => m.ok).length, 2, '250 bytes of budget, 100-byte files');
		assert.strictEqual(out.filter((m) => !m.ok && m.error.code === 'EFBIG').length, 2);
		r.rt.dispose();
	});

	await test('a read that fails gives its reservation back', async () => {
		const r = createRig({ limits: { read: { file: 100, run: 150, served: 150 } } });
		r.ws.put('/scratch/a', 'x'.repeat(100));
		r.ws.put('/scratch/b', 'x'.repeat(100));
		r.ws.fail('readFile', (k) => k.endsWith('/a'), new FileSystemError('NoPermissions', 'NoPermissions', 'x'));
		/** @type {any[]} */ const out = [];
		r.engines.state.onRun = readsThenDone([['readFile', '/scratch/a'], ['readFile', '/scratch/b']], null, out);
		await r.rt.createSession().run('x');
		assert.deepStrictEqual(out.map((m) => (m.ok ? 'ok' : m.error.code)), ['EACCES', 'ok']);
		r.rt.dispose();
	});

	await test('an operation that is not a read is refused as invalid: the engine has no way to write through this', async () => {
		const r = createRig();
		r.ws.put('/scratch/a', 'x');
		/** @type {any[]} */ const out = [];
		r.engines.state.onRun = readsThenDone([['writeFile', '/scratch/a'], ['delete', '/scratch/a'], ['rename', '/scratch/a'], ['mkdir', '/scratch/z']], null, out);
		await r.rt.createSession().run('x');
		assert.deepStrictEqual(out.map((m) => m.error && m.error.code), ['EINVAL', 'EINVAL', 'EINVAL', 'EINVAL']);
		assert.ok(r.ws.calls.every((c) => /^(stat|readFile|readDirectory) /.test(c)), r.ws.calls.join(','));
		assert.strictEqual(r.ws.text('/scratch/a'), 'x');
		r.rt.dispose();
	});

	await test('a read that never answers is told ETIMEDOUT after 60 s and the run goes on; the late answer is not sent', async () => {
		const r = createRig();
		r.ws.put('/scratch/slow', 'x');
		/** @type {any[]} */ const out = [];
		r.ws.hang('readFile', (k) => k.endsWith('/slow'));
		r.engines.state.onRun = readsThenDone([['readFile', '/scratch/slow']], null, out);
		const p = r.rt.createSession().run('x');
		await r.clock.advance(59999);
		assert.strictEqual(out.length, 0);
		await r.clock.advance(1);
		const res = await p;
		assert.deepStrictEqual({ ok: out[0].ok, code: out[0].error.code }, { ok: false, code: 'ETIMEDOUT' });
		assert.strictEqual(res.how, 'exit');
		r.rt.dispose();
	});

	await test('a read after `done` is dropped: no answer, and the workspace is not touched', async () => {
		const r = createRig();
		r.ws.put('/scratch/a', 'x');
		r.engines.state.onRun = async (run, w, h) => {
			h.done({ exitCode: 0, how: 'exit' });
			await flush();
			h.fsNoWait('readFile', '/scratch/a');
		};
		await r.rt.createSession().run('x');
		await flush();
		assert.ok(!r.engines.workers[0].sent.some((/** @type {any} */ m) => m.t === 'fsr'));
		assert.deepStrictEqual(r.ws.calls, []);
		r.rt.dispose();
	});

	await test('output beyond twice the engine\'s own cap is dropped, and the run says so', async () => {
		const r = createRig({ limits: { engine: { maxOutputSize: 100 } } });
		r.engines.state.onRun = async (run, w, h) => {
			for (let i = 0; i < 10; i++) { h.out(run.id, 'stdout', 'x'.repeat(50)); }
			await flush();
			h.done({});
		};
		let got = 0;
		const res = await r.rt.createSession().run('yes', { onStdout: (t) => { got += t.length; } });
		assert.strictEqual(got, 200);
		assert.ok(/wrote more than 200 characters/.test(res.notes.join('\n')), res.notes.join('\n'));
		r.rt.dispose();
	});

	await test('a listener that throws does not break the run or the ones after it', async () => {
		const r = createRig();
		r.engines.state.onRun = async (run, w, h) => { h.out(run.id, 'stdout', 'a'); h.out(run.id, 'stderr', 'b'); await flush(); h.done({}); };
		const got = [];
		const res = await r.rt.createSession().run('x', { onStdout: () => { throw new Error('boom'); }, onStderr: (t) => got.push(t) });
		assert.strictEqual(res.how, 'exit');
		assert.deepStrictEqual(got, ['b']);
		r.rt.dispose();
	});

	/* ===== mounts ======================================================================= */

	await test('planMounts: each folder at its own root; what the engine cannot hold is moved under /mnt, in order', async () => {
		const f = (/** @type {string} */ name, /** @type {string} */ root) => ({ name, root, uri: 'file://' + root });
		const mounts = (/** @type {any[]} */ list) => planMounts(list).map((m) => m.mount);
		assert.deepStrictEqual(mounts([f('a', '/a'), f('b', '/b')]), ['/a', '/b']);
		assert.deepStrictEqual(mounts([f('root', '/')]), ['/mnt/root'], 'the engine cannot mount at /');
		assert.deepStrictEqual(mounts([f('tmp', '/tmp'), f('home', '/home'), f('bin', '/bin')]), ['/mnt/tmp', '/mnt/home', '/mnt/bin'], 'they would shadow its own');
		assert.deepStrictEqual(mounts([f('etc', '/etc'), f('opt', '/opt'), f('var', '/var/www'), f('x', '/mnt/x'), f('usr', '/usrx')]), ['/etc', '/opt', '/var/www', '/mnt/x', '/usrx'], 'only what the engine itself has is in the way');
		assert.deepStrictEqual(mounts([f('a', '/a'), f('b', '/a/b')]), ['/a', '/mnt/b'], 'nested');
		assert.deepStrictEqual(mounts([f('b', '/a/b'), f('a', '/a')]), ['/a/b', '/mnt/a'], 'nested the other way');
		assert.deepStrictEqual(mounts([f('x', '/x'), f('x', '/x')]), ['/x', '/mnt/x'], 'the same root twice (two schemes)');
		assert.deepStrictEqual(mounts([f('My Project!', '/'), f('My Project!', '/tmp')]), ['/mnt/my-project', '/mnt/my-project-2']);
		assert.deepStrictEqual(mounts([f('a', '/a//b/../c/'), f('rel', 'relative'), { name: 'nouri', root: '/z' }, null]), ['/a/c'], 'a bad entry is skipped, not fatal');
		assert.deepStrictEqual(planMounts([f('a', '/a'), f('b', '/b')]).map((m) => m.id), ['ws0', 'ws1']);
	});

	await test('toMountPath and toRootPath: identity for a normal mount, and the translation for a moved one', async () => {
		const mounts = planMounts([{ name: 'tmp', root: '/tmp', uri: 'file:///tmp' }, { name: 'p', root: '/proj', uri: 'file:///proj' }]);
		assert.strictEqual(toMountPath(mounts, '/proj/src/a.js'), '/proj/src/a.js');
		assert.strictEqual(toMountPath(mounts, '/tmp'), '/mnt/tmp');
		assert.strictEqual(toMountPath(mounts, '/tmp/x/y'), '/mnt/tmp/x/y');
		assert.strictEqual(toMountPath(mounts, '/elsewhere'), null);
		assert.strictEqual(toRootPath(mounts, '/mnt/tmp/x/y'), '/tmp/x/y');
		assert.strictEqual(toRootPath(mounts, '/mnt/tmp'), '/tmp');
		assert.strictEqual(toRootPath(mounts, '/not/mounted'), '/not/mounted');
		const rootMount = planMounts([{ name: 'r', root: '/', uri: 'file:///' }]);
		assert.strictEqual(toMountPath(rootMount, '/a/b'), '/mnt/r/a/b');
		assert.strictEqual(toMountPath(rootMount, '/'), '/mnt/r');
		assert.strictEqual(toRootPath(rootMount, '/mnt/r/a/b'), '/a/b');
		assert.strictEqual(toRootPath(rootMount, '/mnt/r'), '/');
		assert.strictEqual(normalizePath('/a/./b/../c//d/'), '/a/c/d');
		assert.strictEqual(normalizePath('a/b'), null);
	});

	await test('a folder the engine cannot hold is mounted under /mnt and served from there', async () => {
		const r = createRig({ workspace: { folders: [{ name: 'home', uri: 'file:///home' }] } });
		r.ws.put('file:/home/a.txt', 'A');
		/** @type {any[]} */ const out = [];
		r.engines.state.onRun = readsThenDone([['readFile', '/mnt/home/a.txt'], ['readFile', '/home/a.txt']], null, out);
		const s = r.rt.createSession({ cwd: '/home' });
		await s.run('x');
		assert.deepStrictEqual(r.engines.workers[0].sent[0].folders, [{ id: 'ws0', path: '/mnt/home', name: 'home' }]);
		assert.strictEqual(r.engines.workers[0].sent[1].cwd, '/mnt/home');
		assert.strictEqual(Buffer.from(out[0].value).toString(), 'A');
		assert.strictEqual(out[1].ok, false, 'the engine has no /home mount, so it is not served');
		r.rt.dispose();
	});

	await test('a folder that is not where its own path says is said so, on every run, with the reason', async () => {
		const r = createRig({ workspace: { folders: [{ name: 'home', uri: 'file:///home' }, { name: 'scratch', uri: 'levelcode-scratch:///scratch' }] } });
		const s = r.rt.createSession();
		for (let i = 0; i < 2; i++) {
			const res = await s.run('pwd');
			assert.deepStrictEqual(res.notes, ['[LevelCode Shell: The folder "home" is mounted at /mnt/home, not at /home: that path is one the shell uses for itself.]']);
		}
		const plain = createRig();
		assert.deepStrictEqual((await plain.rt.createSession().run('pwd')).notes, []);
		r.rt.dispose();
		plain.rt.dispose();
	});

	await test('folders that change: idle workers started for the old set go at once, and the next run mounts the new set', async () => {
		const r = createRig();
		const s = r.rt.createSession();
		await s.run('a');
		assert.strictEqual(r.ws.folderListeners, 1);
		r.ws.setFolders([{ name: 'other', uri: 'file:///other' }]);
		assert.strictEqual(r.engines.workers[0].terminated, true);
		const res = await s.run('b');
		assert.strictEqual(res.how, 'exit');
		assert.strictEqual(r.engines.workers.length, 2);
		assert.deepStrictEqual(r.engines.workers[1].sent[0].folders, [{ id: 'ws0', path: '/other', name: 'other' }]);
		r.rt.dispose();
		assert.strictEqual(r.ws.folderListeners, 0, 'the subscription goes with the runtime');
	});

	await test('a folder added while a worker is idle: even without the event, the next run notices and re-initialises', async () => {
		const r = createRig();
		const s = r.rt.createSession();
		await s.run('a');
		r.ws.vscode.workspace.workspaceFolders = r.ws.vscode.workspace.workspaceFolders.concat([{ name: 'extra', uri: r.ws.vscode.Uri.parse('file:///extra') }]);
		await s.run('b');
		assert.strictEqual(r.engines.workers.length, 2);
		assert.strictEqual(r.engines.workers[1].sent[0].folders.length, 2);
		r.rt.dispose();
	});

	await test('runtime.folders() is the live list: name, root, uri', async () => {
		const r = createRig({ workspace: { folders: [{ name: 'scratch', uri: 'levelcode-scratch:///scratch' }, { name: 'p', uri: 'file:///my/proj' }] } });
		assert.deepStrictEqual(r.rt.folders(), [
			{ name: 'scratch', root: '/scratch', uri: 'levelcode-scratch:///scratch' },
			{ name: 'p', root: '/my/proj', uri: 'file:///my/proj' },
		]);
		r.ws.setFolders([{ name: 'n', uri: 'file:///n' }]);
		assert.deepStrictEqual(r.rt.folders().map((f) => f.name), ['n']);
		r.rt.dispose();
	});

	finished = true;
	console.log(`\n${n} tests passed`);
})().catch((e) => { console.error(e); process.exit(1); });
