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
 *    budget cannot be beaten by reading in parallel, a size that is not a number is EIO and not "unlimited",
 *    and every read is answered whatever the provider threw;
 *    planMounts always returns (a folder rooted at /mnt included), nested roots map to the longest one, and its
 *    plan is the ENGINE's own: the same mounts as engine/overlay-fs.js planMounts for the same folders (a fuzz of
 *    6000 sets), every mount a normalised path, and the engine never moves a mount the host planned;
 *    runtime.resolve / runtime.stat: what the terminal's links ask of the mounts;
 *    a worker that fails is logged as `worker-failed`; the idle timer never kills a worker that is running.
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
const vm = require('vm');

const { createRig, flush, FileSystemError } = require(path.join(__dirname, '..', 'helpers', 'shell-runtime-fakes.js'));
const { observe } = require(path.join(__dirname, '..', 'helpers', 'shell-conformance.js'));
const { planMounts, toMountPath, toRootPath, normalizePath, posixCode } = require(path.join(__dirname, '..', '..', 'shell', 'src', 'runtime.js'));
const { PROGRAMS } = require(path.join(__dirname, '..', '..', 'shell', 'src', 'info.js'));
const enginePlan = require(path.join(__dirname, '..', '..', 'shell', 'engine', 'overlay-fs.js')).planMounts;

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

	await test('a run that lasts longer than the idle time is not an idle worker: the timer armed by the run before it must not kill it', async () => {
		const r = createRig();
		/** @type {() => void} */ let finish = () => { };
		r.engines.state.onRun = async (run, w, h) => {
			if (run.script === 'long') { await new Promise((res) => { finish = () => res(undefined); }); }
			h.done({ exitCode: run.script === 'long' ? 9 : 0, how: 'exit' });
		};
		const s = r.rt.createSession();
		await s.run('short');                        // arms the idle timer (60 s)
		await r.clock.advance(10000);
		const p = s.run('long');                     // 50 s of that timer are left
		await r.clock.advance(100000);               // the run lasts 100 s: past the timer, and past a second one
		assert.strictEqual(r.engines.workers.length, 1);
		assert.strictEqual(r.engines.workers[0].terminated, false, 'a worker with a run is not idle');
		finish();
		const res = await p;
		assert.deepStrictEqual({ how: res.how, exitCode: res.exitCode }, { how: 'exit', exitCode: 9 }, 'the run ended by itself, not by a kill');
		assert.strictEqual(r.engines.workers[0].terminated, false);
		await r.clock.advance(60000);
		assert.strictEqual(r.engines.workers[0].terminated, true, 'and it is idle after, for the usual time');
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

	await test('timeoutMs: a number setTimeout cannot hold is the default deadline, not "now"; the largest it holds and the smallest are used as given', async () => {
		const DEFAULT = 600000 + 15000;
		for (const bad of [Infinity, -Infinity, NaN, 2 ** 31, 1e12, 0, -5, 0.5, '1000', null]) {
			const r = createRig();
			r.engines.state.onRun = async () => { await new Promise(() => { }); };
			const s = r.rt.createSession();
			let how = 'pending';
			const p = s.run('x', { timeoutMs: bad }).then((v) => { how = v.how; });
			await flush();
			await r.clock.advance(DEFAULT - 1);
			assert.strictEqual(how, 'pending', 'timeoutMs ' + String(bad) + ' fired early');
			await r.clock.advance(1);
			await p;
			assert.strictEqual(how, 'deadline', 'timeoutMs ' + String(bad) + ' is the default deadline');
			r.rt.dispose();
		}
		// the default itself is held to what a timer can hold, however large the engine's backstop is made
		{
			const r = createRig({ limits: { engine: { maxExecutionTimeMs: 2 ** 31 - 1 } } });
			r.engines.state.onRun = async () => { await new Promise(() => { }); };
			let how = 'pending';
			const p = r.rt.createSession().run('x').then((v) => { how = v.how; });
			await flush();
			await r.clock.advance(2 ** 31 - 2);
			assert.strictEqual(how, 'pending');
			await r.clock.advance(1);
			await p;
			assert.strictEqual(how, 'deadline', 'at 2^31-1 ms, not 15 s after');
			r.rt.dispose();
		}
		for (const [good, at] of [[1, 1], [2 ** 31 - 1, 2 ** 31 - 1], [1500, 1500]]) {
			const r = createRig();
			r.engines.state.onRun = async () => { await new Promise(() => { }); };
			const s = r.rt.createSession();
			let how = 'pending';
			const p = s.run('x', { timeoutMs: good }).then((v) => { how = v.how; });
			await flush();
			if (at > 1) { await r.clock.advance(at - 1); assert.strictEqual(how, 'pending', 'timeoutMs ' + good + ' fired one ms early'); }
			await r.clock.advance(1);
			await p;
			assert.strictEqual(how, 'deadline', 'timeoutMs ' + good);
			r.rt.dispose();
		}
	});

	await test('the same through the agent: an absurd timeoutMs is the default, a real one is kept', async () => {
		const r = createRig();
		r.engines.state.onRun = async () => { await new Promise(() => { }); };
		const c = r.rt.spawnAgent('x', { cwd: '/scratch', timeoutMs: Infinity });
		const o = observe(c, 10 * 60 * 1000);
		await flush();
		await r.clock.advance(600000);
		assert.strictEqual(o.events.some((e) => e.type === 'close'), false, 'not an immediate deadline');
		await r.clock.advance(15000);
		await o.closed;
		assert.strictEqual(/** @type {any} */ (o.events[o.events.length - 1]).code, 124);
		r.rt.dispose();
	});

	await test('a run stopped in the instant its (reused) worker is being handed over starts no deadline timer and posts nothing', async () => {
		const r = createRig();
		const s = r.rt.createSession();
		await s.run('warm up');                           // the worker is ready and idle: handing it over takes microtask turns, not time
		const before = r.engines.workers[0].sent.length;
		const p = s.run('x');
		queueMicrotask(() => s.stop());
		const res = await p;
		assert.strictEqual(res.how, 'aborted');
		await flush();
		assert.strictEqual(r.engines.workers[0].sent.length, before, 'the script was not posted to a worker that was stopped');
		assert.strictEqual(r.clock.pending, 0, 'and no deadline timer was started for a run that is over (nor an idle one for a worker that is gone)');
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

	await test('a message the host cannot read (messageerror) ends the run at once, not at the deadline', async () => {
		const r = createRig();
		r.engines.state.onRun = async (run, w) => { w.onmessageerror({ data: null }); };
		const s = r.rt.createSession();
		const res = await s.run('x');
		assert.deepStrictEqual({ how: res.how, exitCode: res.exitCode }, { how: 'error', exitCode: 1 });
		assert.ok(/sent a message that could not be read/.test(res.notes.join('\n')), res.notes.join('\n'));
		assert.strictEqual(r.engines.workers[0].terminated, true);
		assert.strictEqual(r.clock.pending, 0, 'no deadline timer is left');
		r.engines.state.onRun = async (run, w, h) => { h.done({}); };
		assert.strictEqual((await s.run('again')).how, 'exit');
		r.rt.dispose();
	});

	await test('a worker that fails is logged as `worker-failed` with the reason - for an error event, a messageerror, a postMessage that throws and an engine that never starts', async () => {
		const failed = (/** @type {any} */ r) => r.logs.filter((/** @type {any} */ l) => l[0] === 'worker-failed').map((/** @type {any} */ l) => l[1].reason);
		let r = createRig();
		r.engines.state.onRun = async (run, w) => { w.crash('out of memory'); };
		await r.rt.createSession().run('x');
		assert.strictEqual(failed(r).length, 1);
		assert.ok(/stopped unexpectedly: out of memory/.test(failed(r)[0]), failed(r)[0]);
		assert.ok(/** @type {any} */ (r.logs.find((l) => l[0] === 'worker-failed'))[1].gen >= 1);
		r.rt.dispose();

		r = createRig();
		r.engines.state.onRun = async (run, w) => { w.onmessageerror({}); };
		await r.rt.createSession().run('x');
		assert.ok(/could not be read/.test(failed(r).join('|')), failed(r).join('|'));
		r.rt.dispose();

		r = createRig();
		r.engines.state.noReady = true;
		const p = r.rt.createSession().run('x');
		await r.clock.advance(20000);
		await p;
		assert.ok(/did not start in 20 s/.test(failed(r).join('|')), failed(r).join('|'));
		r.rt.dispose();

		r = createRig();
		const orig = r.engines.create;
		const { createRuntime } = require(path.join(__dirname, '..', '..', 'shell', 'src', 'runtime.js'));
		/** @type {any[]} */ const seen = [];
		const rt = createRuntime({
			vscode: r.ws.vscode, loadEngineSource: async () => 'src',
			createWorker: (/** @type {string} */ src) => { const w = orig(src); const post = w.postMessage.bind(w); w.postMessage = (/** @type {any} */ m, /** @type {any} */ t) => { if (m.t === 'run') { throw new Error('DataCloneError'); } post(m, t); }; return w; },
			now: r.clock.now, setTimeout: r.clock.setTimeout, clearTimeout: r.clock.clearTimeout, log: (/** @type {string} */ e, /** @type {any} */ d) => seen.push([e, d]),
		});
		await rt.createSession().run('x');
		assert.ok(seen.some((l) => l[0] === 'worker-failed' && /DataCloneError/.test(l[1].reason)), JSON.stringify(seen));
		rt.dispose();
		r.rt.dispose();

		// a worker that is only stopped (Ctrl+C, idle, a deadline) is not a failure
		r = createRig();
		r.engines.state.onRun = async () => { await new Promise(() => { }); };
		const s = r.rt.createSession();
		const q = s.run('x');
		await flush();
		s.stop();
		await q;
		assert.deepStrictEqual(failed(r), []);
		r.rt.dispose();
	});

	await test('what a worker or a provider says about a failure is shown in the note, not passed: an escape sequence in it is made visible', async () => {
		const bad = '\x1b]0;pwned\x07\x1b[2J\x9b6n';
		const safe = (/** @type {string} */ t) => !/[\x00-\x08\x0B-\x1F\x7F-\x9F]/.test(t);
		let r = createRig();
		r.engines.state.onRun = async (run, w) => { w.crash('boom ' + bad); };
		let res = await r.rt.createSession().run('x');
		assert.ok(safe(res.notes.join('\n')) && res.notes.join('').includes('boom \u{241B}]0;pwned'), JSON.stringify(res.notes));
		r.rt.dispose();

		r = createRig();
		r.state.loadError = new Error('engine.worker.js: 404 ' + bad);
		res = await r.rt.createSession().run('x');
		assert.ok(safe(res.notes.join('\n')) && res.notes.join('').includes('404 \u{241B}]0;pwned'), JSON.stringify(res.notes));
		r.rt.dispose();

		r = createRig();
		r.engines.state.failCreate = new Error('no workers ' + bad);
		res = await r.rt.createSession().run('x');
		assert.ok(safe(res.notes.join('\n')), JSON.stringify(res.notes));
		r.rt.dispose();

		// the log keeps the same text the person sees
		r = createRig();
		r.engines.state.onRun = async (run, w) => { w.crash('boom ' + bad); };
		await r.rt.createSession().run('x');
		assert.ok(r.logs.filter((l) => l[0] === 'worker-failed').every((l) => safe(l[1].reason)), JSON.stringify(r.logs));
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

	await test('a path is at most 4096 characters: exactly that is served, one more is not a path (and the workspace is not asked)', async () => {
		assert.strictEqual(normalizePath('/' + 'a'.repeat(4095)), '/' + 'a'.repeat(4095), '4096 characters');
		assert.strictEqual(normalizePath('/' + 'a'.repeat(4096)), null, '4097');
		assert.strictEqual(normalizePath('/' + 'a/'.repeat(2047) + 'a'), '/' + 'a/'.repeat(2047) + 'a', 'long and deep, 4096');
		const r = createRig();
		/** @type {any[]} */ const out = [];
		const longRoot = '/scratch/' + 'a'.repeat(4096 - '/scratch/'.length);
		r.engines.state.onRun = readsThenDone([['stat', longRoot], ['stat', longRoot + 'a']], null, out);
		await r.rt.createSession().run('x');
		assert.strictEqual(longRoot.length, 4096);
		assert.deepStrictEqual(out.map((m) => m.error.code), ['ENOENT', 'EACCES'], 'the one at the cap is looked for; the one over it is outside everything');
		assert.deepStrictEqual(r.ws.calls, ['stat levelcode-scratch:' + longRoot]);
		r.rt.dispose();
	});

	await test('a directory read as a file is EISDIR whatever the provider would do with it: the engine is never handed a "file" that is a folder', async () => {
		const r = createRig();
		r.ws.mkdir('/scratch/dir');
		r.ws.fs.readFile = async () => new Uint8Array(0);     // a provider that does not check
		/** @type {any[]} */ const out = [];
		r.engines.state.onRun = readsThenDone([['readFile', '/scratch/dir']], null, out);
		await r.rt.createSession().run('x');
		assert.deepStrictEqual({ ok: out[0].ok, code: out[0].error.code }, { ok: false, code: 'EISDIR' });
		r.rt.dispose();
	});

	await test('what a provider says that was not classified is trimmed to 160 characters for the engine, and a failure message to 200 for the note', async () => {
		const r = createRig();
		r.ws.put('/scratch/a', 'x');
		r.ws.fail('stat', () => true, new Error('X'.repeat(1000)));
		/** @type {any[]} */ const out = [];
		r.engines.state.onRun = readsThenDone([['stat', '/scratch/a']], null, out);
		await r.rt.createSession().run('x');
		assert.strictEqual(out[0].error.code, 'EIO');
		assert.strictEqual(out[0].error.message, 'input/output error: ' + 'X'.repeat(160));
		const c = createRig();
		c.engines.state.onRun = async (run, w) => { w.crash('Y'.repeat(1000)); };
		const res = await c.rt.createSession().run('x');
		assert.ok(res.notes[0].includes('stopped unexpectedly: ' + 'Y'.repeat(200) + ']'), res.notes[0]);
		r.rt.dispose();
		c.rt.dispose();
	});

	await test('posixCode: the shapes measured in the web workbench', () => {
		assert.strictEqual(posixCode({ name: 'NoModificationAllowedError' }), 'EACCES', 'what a File System Access folder says of a locked file');
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

	await test('a size that is not a number is EIO, not "no limit": the budget cannot be switched off by a provider that does not say', async () => {
		const r = createRig({ limits: { read: { file: 100, run: 250, served: 250 } } });
		for (const f of ['a', 'b', 'c', 'd', 'e']) { r.ws.put('/scratch/' + f, 'x'.repeat(100)); }
		r.ws.mkdir('/scratch/dir');
		const realStat = r.ws.fs.stat.bind(r.ws.fs);
		/** @type {(s: any) => any} */ let shape = (s) => ({ type: s.type, mtime: s.mtime });   // no size at all
		r.ws.fs.stat = async (/** @type {any} */ u) => shape(await realStat(u));
		/** @type {any[]} */ const out = [];
		r.engines.state.onRun = async (run, w, h) => {
			for (const f of ['a', 'b', 'c', 'd', 'e']) { out.push(await h.fs('readFile', '/scratch/' + f)); }
			out.push(await h.fs('stat', '/scratch/a'));
			out.push(await h.fs('stat', '/scratch/dir'));
			h.done({});
		};
		await r.rt.createSession().run('x');
		assert.deepStrictEqual(out.slice(0, 5).map((m) => (m.ok ? 'ok' : m.error.code)), ['EIO', 'EIO', 'EIO', 'EIO', 'EIO'], 'not ok,ok,ok,ok,ok');
		assert.deepStrictEqual(out[5].error.code, 'EIO', 'and a stat of a file says so too');
		assert.deepStrictEqual({ ok: out[6].ok, type: out[6].value.type, size: out[6].value.size }, { ok: true, type: 'dir', size: 0 }, 'a folder\'s size is nothing the engine counts with');
		assert.ok(!r.ws.calls.some((c) => c.startsWith('readFile')), 'no file was read on the strength of a size nobody gave: ' + r.ws.calls.join(','));
		// every shape that is not a count
		for (const bad of [NaN, -1, Infinity, '5', null, {}, [5]]) {
			shape = (s) => ({ type: s.type, mtime: s.mtime, size: bad });
			out.length = 0;
			await r.rt.createSession().run('x');
			assert.strictEqual(out[0].error.code, 'EIO', JSON.stringify(bad));
		}
		// ...and a zero is a size
		r.ws.put('/scratch/empty', '');
		shape = (s) => s;
		/** @type {any[]} */ const out2 = [];
		r.engines.state.onRun = readsThenDone([['readFile', '/scratch/empty'], ['stat', '/scratch/empty']], null, out2);
		await r.rt.createSession().run('x');
		assert.deepStrictEqual([out2[0].ok, out2[1].value.size], [true, 0]);
		r.rt.dispose();
	});

	await test('whatever the provider throws, the engine gets an answer: a string, undefined, an object with no text - and nothing is left unhandled', async () => {
		const r = createRig();
		r.ws.put('/scratch/a', 'x');
		let unhandled = 0;
		const count = () => { unhandled++; };
		process.on('unhandledRejection', count);
		try {
			const hostile = Object.create(null);
			const getter = Object.defineProperty({}, 'message', { get() { throw new Error('getter'); } });
			const revoked = Proxy.revocable({}, {});
			revoked.revoke();
			const cases = [['a string', 'boom'], ['undefined', undefined], ['no prototype', hostile], ['a throwing toString', { toString() { throw new Error('no'); } }],
				['a throwing message getter', getter], ['a number', 42], ['null', null],
				['a Proxy that throws on every read', new Proxy({}, new Proxy({}, { get() { throw new Error('trap'); } }))], ['a revoked Proxy', revoked.proxy],
				['a Symbol', Symbol('s')], ['a BigInt', 7n], ['a throwing code getter', Object.defineProperty(new Error('c'), 'code', { get() { throw new Error('code'); } })],
				['a throwing name getter', Object.defineProperty(new Error('n'), 'name', { get() { throw new Error('name'); } })]];
			/** @type {any[]} */ const out = [];
			r.engines.state.onRun = async (run, w, h) => {
				for (const [, err] of cases) {
					r.ws.clearRules();
					r.ws.fail('stat', () => true, err);
					out.push(await Promise.race([h.fs('readFile', '/scratch/a'), new Promise((res) => setTimeout(() => res('NO ANSWER'), 500))]));
				}
				h.done({});
			};
			await r.rt.createSession().run('x');
			await new Promise((res) => setTimeout(res, 20));
			assert.deepStrictEqual(out.map((m) => (m === 'NO ANSWER' ? m : m.ok ? 'ok' : m.error.code)), cases.map(() => 'EIO'));
			assert.ok(/boom/.test(out[0].error.message), 'a string keeps its text: ' + out[0].error.message);
			assert.strictEqual(unhandled, 0, 'unhandled rejections');
			assert.ok(!r.logs.some((l) => l[0] === 'fs-failed'), 'every one of these was answered in the ordinary way, not by the last resort');
		} finally { process.off('unhandledRejection', count); }
		r.rt.dispose();
	});

	await test('a read whose answer cannot even be made ready (a buffer that throws on copy) is still answered, with EIO, once', async () => {
		const r = createRig();
		r.ws.put('/scratch/a', 'x');
		r.ws.fs.readFile = async () => Object.assign(new Uint8Array(1), { slice: () => { throw new Error('no copy for you'); } });
		/** @type {any[]} */ const out = [];
		r.engines.state.onRun = readsThenDone([['readFile', '/scratch/a']], null, out);
		await r.rt.createSession().run('x');
		assert.deepStrictEqual({ ok: out[0].ok, code: out[0].error.code }, { ok: false, code: 'EIO' });
		assert.strictEqual(r.engines.workers[0].sent.filter((/** @type {any} */ m) => m.t === 'fsr').length, 1, 'exactly one answer');
		assert.ok(r.logs.some((l) => l[0] === 'fs-failed'));
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

	await test('an empty chunk is nothing: no listener of the terminal is called with it', async () => {
		const r = createRig();
		r.engines.state.onRun = async (run, w, h) => { w.emit({ t: 'out', id: run.id, stream: 'stdout', text: '' }); h.out(run.id, 'stderr', ''); h.out(run.id, 'stdout', 'x'); await flush(); h.done({}); };
		const got = [];
		await r.rt.createSession().run('x', { onStdout: (t) => got.push(['out', t]), onStderr: (t) => got.push(['err', t]) });
		assert.deepStrictEqual(got, [['out', 'x']]);
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
		// the engine's own rule for a name (engine/overlay-fs.js): case is kept, a run of anything else is one `_`
		assert.deepStrictEqual(mounts([f('My Project!', '/'), f('My Project!', '/tmp')]), ['/mnt/My_Project_', '/mnt/My_Project_-2']);
		assert.deepStrictEqual(mounts([f('a', '/a//b/../c/'), f('rel', 'relative'), { name: 'nouri', root: '/z' }, null]), ['/a/c'], 'a bad entry is skipped, not fatal');
		assert.deepStrictEqual(planMounts([f('a', '/a'), f('b', '/b')]).map((m) => m.id), ['ws0', 'ws1']);
	});


	await test('a worker\'s error event whose message is a getter that throws is a failure like any other: the run ends with an error, the host is not broken', async () => {
		const r = createRig();
		r.engines.state.onRun = async (run, w) => {
			const ev = { preventDefault() { }, get message() { throw new Error('getter-boom'); } };
			w.onerror(ev);
		};
		const res = await r.rt.createSession().run('x');
		assert.deepStrictEqual({ how: res.how, exit: res.exitCode }, { how: 'error', exit: 1 });
		assert.ok(/the shell engine stopped unexpectedly/.test(res.notes.join('')), res.notes.join(''));
		r.rt.dispose();
	});

	/* ===== the host's plan is the engine's plan ================================================ */

	await test('planMounts: a folder called "." or ".." is mounted at a leaf that is a name (_), never at /mnt/.. - which no path matches and the engine would move again', async () => {
		const f = (/** @type {string} */ name, /** @type {string} */ root) => ({ name, root, uri: 'file://' + root });
		const mounts = (/** @type {any[]} */ list) => planMounts(list).map((m) => m.mount);
		assert.deepStrictEqual(mounts([f('..', '/'), f('x', '/tmp/q')]), ['/mnt/_', '/mnt/x'], 'the verifier\'s own case');
		assert.deepStrictEqual(mounts([f('.', '/home')]), ['/mnt/_']);
		assert.deepStrictEqual(mounts([f('...', '/'), f('..', '/tmp'), f('.', '/home')]), ['/mnt/_', '/mnt/_-2', '/mnt/_-3'], 'and they are kept apart');
		assert.deepStrictEqual(mounts([f('.git', '/'), f('.config', '/tmp')]), ['/mnt/_git', '/mnt/_config'], 'a leading dot is `_`, the engine\'s rule');
		assert.deepStrictEqual(mounts([f('a.b', '/'), f('c..d', '/tmp')]), ['/mnt/a.b', '/mnt/c..d'], 'a dot inside a name is a dot');
		// every mount is a path the host can match: what the engine reads at /mnt/_ reaches the folder
		const m = planMounts([f('..', '/')]);
		assert.strictEqual(normalizePath(m[0].mount), m[0].mount);
		assert.strictEqual(toRootPath(m, '/mnt/_/etc/hosts'), '/etc/hosts');
		assert.strictEqual(toMountPath(m, '/etc/hosts'), '/mnt/_/etc/hosts');
	});

	/** A fixed pseudo-random sequence: the same sets on every machine. */
	function rng(/** @type {number} */ seed) { let x = seed >>> 0; return (/** @type {number} */ n2) => { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; return (x >>> 8) % n2; }; }
	const FUZZ_NAMES = ['proj', 'My Project!', '.', '..', '...', '.hidden', '.git', 'a b', 'caf\u{E9}', '\u{65E5}\u{672C}\u{8A9E}', '\u{1F600}', '', ' ', 'a/b', 'a\0b', 'mnt', 'lc-mnt', 'dup', 'dup', '_', '-', 'tmp', 'Foo', 'foo', 'x'.repeat(99), 'x'.repeat(100), 'a\nb', '\u{202E}rtl'];
	const FUZZ_ROOTS = ['/', '/mnt', '/mnt/a', '/mnt/mnt', '/lc-mnt', '/lc-mnt/x', '/lc-mnt-2', '/lc-mnt-3', '/tmp', '/tmp/x', '/home', '/home/user/p', '/bin', '/usr/lib', '/dev', '/proc', '/a', '/a/b', '/a/b/c', '/work', '/work/', '/a//b/../c', '/mnt/_', '/mnt/My_Project_', '/mnt/proj', '/mnt/_-2', '/lc-mnt/_'];
	/** One random folder set (valid roots and uris: the host skips the invalid ones, which the older tests cover). */
	function fuzzSet(/** @type {(n: number) => number} */ pick) {
		const segs = ['a', 'b', 'mnt', 'tmp', 'x', 'lc-mnt', '..', '.', '_', 'My_Project_'];
		return Array.from({ length: 1 + pick(8) }, () => {
			const root = pick(4) === 0 ? '/' + Array.from({ length: 1 + pick(3) }, () => segs[pick(segs.length)]).join('/') : FUZZ_ROOTS[pick(FUZZ_ROOTS.length)];
			return { name: FUZZ_NAMES[pick(FUZZ_NAMES.length)], root, uri: 'file://' + (root.startsWith('/') ? root : '/' + root) };
		});
	}
	/** The engine's plan of the same folders, as the mounts it would make. */
	const engineAt = (/** @type {any[]} */ list) => enginePlan(list.map((f, i) => ({ id: 'ws' + i, path: f.root, name: f.name }))).map((m) => m.at);

	await test('parity: for 6000 random sets (dots, spaces, unicode, empty and long names, duplicates, /mnt and /lc-mnt roots) the host plans the engine\'s own mounts, every mount is a normal path, and the engine never moves a mount the host planned', async () => {
		const pick = rng(20261011);
		const sets = Array.from({ length: 6000 }, () => fuzzSet(pick));
		// one watchdog over the whole run: a search that never ends fails here, it does not hang the suite
		const plans = /** @type {any[][]} */ (JSON.parse(vm.runInNewContext('JSON.stringify(sets.map((s) => planMounts(s)))', { planMounts, sets: JSON.parse(JSON.stringify(sets)) }, { timeout: 20000 })));
		assert.strictEqual(plans.length, 6000);
		let relocated = 0;
		sets.forEach((list, i) => {
			const host = plans[i];
			const where = JSON.stringify(list.map((f) => [f.name.length > 20 ? f.name.slice(0, 8) + '...' : f.name, f.root]));
			assert.deepStrictEqual(host.map((m) => m.id), list.map((_, j) => 'ws' + j), where);
			assert.deepStrictEqual(host.map((m) => m.mount), engineAt(list), 'the host and the engine disagree: ' + where);
			for (const m of host) {
				assert.strictEqual(normalizePath(m.mount), m.mount, 'a mount is a normalised path: ' + m.mount + ' for ' + where);
				assert.notStrictEqual(m.mount, '/', where);
				if (m.reason) { relocated++; }
			}
			for (let a = 0; a < host.length; a++) {
				for (let b = a + 1; b < host.length; b++) {
					const x = host[a].mount, y = host[b].mount;
					assert.ok(x !== y && !x.startsWith(y + '/') && !y.startsWith(x + '/'), 'mounts overlap: ' + x + ' ' + y + ' for ' + where);
				}
			}
			// what the engine is handed is these mounts: it has nothing left to move, so it prints no second relocation note
			const again = enginePlan(host.map((m) => ({ id: m.id, path: m.mount, name: m.name })));
			assert.deepStrictEqual(again.map((m) => m.relocated), host.map(() => false), 'the engine moved a mount the host had planned: ' + where);
			assert.deepStrictEqual(again.map((m) => m.at), host.map((m) => m.mount), where);
		});
		assert.ok(relocated > 3000, 'the fuzz really relocates folders: ' + relocated);
	});

	await test('parity: a name the host would have to cut (over 100 characters) still gives a readable mount, and the engine takes it as it is', async () => {
		const f = (/** @type {string} */ name, /** @type {string} */ root) => ({ name, root, uri: 'file://' + root });
		const long = 'p'.repeat(5000);
		const m = planMounts([f(long, '/'), f(long, '/tmp'), f('q'.repeat(100), '/home'), f('r'.repeat(101), '/bin')]);
		assert.deepStrictEqual(m.map((x) => x.mount), [
			'/mnt/' + 'p'.repeat(100), '/mnt/' + 'p'.repeat(100) + '-2', '/mnt/' + 'q'.repeat(100), '/mnt/' + 'r'.repeat(100),
		], 'exactly 100 is a name; 101 is cut to it');
		for (const x of m) { assert.strictEqual(normalizePath(x.mount), x.mount); assert.ok(x.mount.length < 120); }
		assert.deepStrictEqual(enginePlan(m.map((x) => ({ id: x.id, path: x.mount, name: x.name }))).map((x) => x.relocated), [false, false, false, false]);
		// and a path under it is one the runtime reads (a mount of 5000 characters would put every file past the 4096 it accepts)
		const deep = toMountPath(m, '/x/file.txt');
		assert.strictEqual(deep, '/mnt/' + 'p'.repeat(100) + '/x/file.txt');
		assert.strictEqual(normalizePath(deep), deep);
	});

	await test('a folder with no name is called by the last segment of its path (the engine\'s rule), or "folder" at the root', async () => {
		const m = planMounts([{ name: '', root: '/', uri: 'file:///' }, { name: '', root: '/work/proj', uri: 'file:///work/proj' }, { name: '', root: '/tmp/site', uri: 'file:///tmp/site' }]);
		assert.deepStrictEqual(m.map((x) => [x.name, x.mount]), [['folder', '/mnt/folder'], ['proj', '/work/proj'], ['site', '/mnt/site']]);
	});

	await test('a very long folder name is cut in the relocation note too: a note is not a place to put 100,000 characters', async () => {
		const name = 'N'.repeat(100000);
		const r = createRig({ workspace: { folders: [{ name, uri: 'file:///home' }] } });
		const res = await r.rt.createSession().run('pwd');
		assert.strictEqual(res.notes.length, 1);
		assert.ok(res.notes[0].length < 400, String(res.notes[0].length));
		assert.ok(res.notes[0].includes('"' + 'N'.repeat(100) + '..."'), res.notes[0].slice(0, 200));
		r.rt.dispose();
	});

	/* ===== runtime.resolve and runtime.stat (what the terminal's links ask) ====================== */

	await test('runtime.resolve: an engine path as a command prints it, mapped by the mounts as of now, to the Uri behind it; null outside them', async () => {
		const r = createRig({ workspace: { folders: [{ name: 'home', uri: 'file:///home' }, { name: 'scratch', uri: 'levelcode-scratch:///scratch' }] } });
		const u = r.rt.resolve('/mnt/home/src/a.js');
		assert.deepStrictEqual([u.scheme, u.path], ['file', '/home/src/a.js']);
		assert.strictEqual(r.rt.resolve('/mnt/home').path, '/home');
		const v = r.rt.resolve('/scratch/x/../y.txt');
		assert.deepStrictEqual([v.scheme, v.path], ['levelcode-scratch', '/scratch/y.txt'], '.. is resolved first');
		for (const outside of ['/etc/passwd', '/home/a.txt', '/mnt', '/mnt/home/../../etc', '/', 'relative/path', '', '/a\0b', '/x'.repeat(2100), undefined, null, 5, {}]) {
			assert.strictEqual(r.rt.resolve(/** @type {any} */ (outside)), null, JSON.stringify(outside));
		}
		r.ws.setFolders([{ name: 'other', uri: 'file:///other' }]);
		assert.strictEqual(r.rt.resolve('/scratch/y.txt'), null, 'live: the folder is gone');
		assert.strictEqual(r.rt.resolve('/other/z').path, '/other/z');
		assert.deepStrictEqual(r.ws.calls, [], 'a mapping asks the file system nothing');
		r.rt.dispose();
	});

	await test('runtime.stat: { type, size } of what is there, null for nothing or for a path outside the mounts (which the file system is not asked about); it never throws', async () => {
		const r = createRig({ workspace: { folders: [{ name: 'home', uri: 'file:///home' }] } });
		r.ws.put('file:/home/a.txt', 'abc');
		r.ws.mkdir('file:/home/d');
		assert.deepStrictEqual(await r.rt.stat('/mnt/home/a.txt'), { type: 'file', size: 3 });
		assert.deepStrictEqual(await r.rt.stat('/mnt/home/d'), { type: 'dir', size: 0 });
		// a provider that does not say how large a file is: 0, as the engine's own stat has it (a number, never undefined)
		const real = r.ws.fs.stat.bind(r.ws.fs);
		r.ws.fs.stat = async (/** @type {any} */ u) => { const x = await real(u); return /a\.txt$/.test(u.path) ? { type: x.type, mtime: x.mtime } : x; };
		assert.deepStrictEqual(await r.rt.stat('/mnt/home/a.txt'), { type: 'file', size: 0 });
		r.ws.fs.stat = real;
		assert.strictEqual(await r.rt.stat('/mnt/home/missing'), null);
		assert.strictEqual(await r.rt.stat('/mnt/home/a.txt/under'), null, 'ENOTDIR is nothing too');
		r.ws.calls.length = 0;
		assert.strictEqual(await r.rt.stat('/etc/passwd'), null);
		assert.strictEqual(await r.rt.stat('relative'), null);
		assert.deepStrictEqual(r.ws.calls, [], 'a path outside the mounts never reaches the file system');
		for (const thrown of [new Error('boom'), undefined, 'text', Object.create(null), Object.defineProperty({}, 'message', { get() { throw new Error('g'); } }), Symbol('s')]) {
			r.ws.clearRules();
			r.ws.fail('stat', () => true, thrown);
			assert.strictEqual(await r.rt.stat('/mnt/home/a.txt'), null);
		}
		r.rt.dispose();
	});

	await test('runtime.stat is bounded by fsMs: a provider that never answers is null at 60 s, not a promise that never settles', async () => {
		const r = createRig();
		r.ws.put('/scratch/a.txt', 'x');
		r.ws.hang('stat', (k) => k.endsWith('/a.txt'));
		let got = /** @type {any} */ ('pending');
		r.rt.stat('/scratch/a.txt').then((v) => { got = v; });
		await r.clock.advance(59999);
		assert.strictEqual(got, 'pending');
		await r.clock.advance(1);
		assert.strictEqual(got, null);
		r.rt.dispose();
		assert.strictEqual(r.clock.pending, 0);
	});

	/* ===== planMounts always returns ======================================================= */

	/** planMounts under a watchdog: a loop that never ends is a failed test, not a suite that hangs. */
	function planWithin(/** @type {any[]} */ list) {
		try {
			return JSON.parse(vm.runInNewContext('JSON.stringify(planMounts(list))', { planMounts, list: JSON.parse(JSON.stringify(list)) }, { timeout: 2000 }));
		} catch (e) {
			return assert.fail('planMounts did not return for ' + JSON.stringify(list.map((f) => f.root)) + ': ' + (e && /** @type {any} */ (e).message));
		}
	}
	const folder = (/** @type {string} */ name, /** @type {string} */ root) => ({ name, root, uri: 'file://' + root });

	await test('planMounts: a folder rooted at /mnt takes /mnt away as a place to move others to; they go under /lc-mnt', async () => {
		const mounts = (/** @type {any[]} */ list) => planWithin(list).map((/** @type {any} */ m) => m.mount);
		assert.deepStrictEqual(mounts([folder('mnt', '/mnt'), folder('root', '/')]), ['/mnt', '/lc-mnt/root'], 'the root after /mnt (it never returned)');
		assert.deepStrictEqual(mounts([folder('mnt', '/mnt'), folder('t', '/tmp/x')]), ['/mnt', '/lc-mnt/t'], 'a reserved name after /mnt');
		assert.deepStrictEqual(mounts([folder('t', '/tmp/x'), folder('mnt', '/mnt')]), ['/lc-mnt/t', '/mnt'], 'the other way round: a folder stays at its own path, and what had to move goes where there is room (it is never the folder that was fine that moves)');
		assert.deepStrictEqual(mounts([folder('mnt', '/mnt'), folder('mnt', '/tmp')]), ['/mnt', '/lc-mnt/mnt'], 'two folders named mnt');
		assert.deepStrictEqual(mounts([folder('mnt', '/mnt'), folder('mnt', '/mnt')]), ['/mnt', '/lc-mnt/mnt'], 'the same /mnt twice (two schemes)');
		assert.deepStrictEqual(mounts([folder('a', '/mnt'), folder('b', '/lc-mnt'), folder('r', '/')]), ['/mnt', '/lc-mnt', '/lc-mnt-2/r'], 'both bases taken');
		assert.deepStrictEqual(mounts([folder('a', '/mnt'), folder('b', '/lc-mnt'), folder('c', '/lc-mnt-2'), folder('r', '/'), folder('s', '/tmp')]),
			['/mnt', '/lc-mnt', '/lc-mnt-2', '/lc-mnt-3/r', '/lc-mnt-3/s'], 'and three');
		assert.deepStrictEqual(mounts([folder('x', '/mnt/x'), folder('x', '/')]), ['/mnt/x', '/mnt/x-2'], 'a folder UNDER /mnt does not take the base away');
		assert.deepStrictEqual(mounts([folder('mnt', '/mnt'), folder('r', '/'), folder('r', '/home')]), ['/mnt', '/lc-mnt/r', '/lc-mnt/r-2'], 'and what moves is kept apart');
	});

	await test('planMounts: whatever the folders are, it returns, nothing is nested, nothing is at / and the first folder stays first', async () => {
		const roots = ['/', '/mnt', '/mnt/a', '/mnt/mnt', '/lc-mnt', '/lc-mnt/mnt', '/lc-mnt-2', '/tmp', '/tmp/x', '/home', '/bin', '/a', '/a/b', '/mnt/lc-mnt'];
		const names = ['mnt', 'a', 'x', 'lc-mnt', 'My Project!', ''];
		let seed = 20261011;
		const rnd = (/** @type {number} */ n) => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed % n; };
		for (let round = 0; round < 400; round++) {
			const list = Array.from({ length: 1 + rnd(9) }, () => folder(names[rnd(names.length)], roots[rnd(roots.length)]));
			const out = planWithin(list);
			assert.strictEqual(out.length, list.length);
			const m = out.map((/** @type {any} */ x) => x.mount);
			for (let i = 0; i < m.length; i++) {
				assert.notStrictEqual(m[i], '/', JSON.stringify(list));
				for (let j = i + 1; j < m.length; j++) {
					assert.ok(m[i] !== m[j] && !m[i].startsWith(m[j] + '/') && !m[j].startsWith(m[i] + '/'), 'overlap ' + m[i] + ' ' + m[j] + ' for ' + JSON.stringify(list.map((f) => f.root)));
				}
			}
			assert.deepStrictEqual(out.map((/** @type {any} */ x) => x.id), list.map((_, i) => 'ws' + i));
		}
	});

	await test('runtime.mounts() is the plan as of now: what the terminal\'s prompt shows and what the next run starts with', async () => {
		const r = createRig({ workspace: { folders: [{ name: 'home', uri: 'file:///home' }, { name: 'scratch', uri: 'levelcode-scratch:///scratch' }] } });
		assert.deepStrictEqual(r.rt.mounts().map((m) => [m.name, m.root, m.mount, m.reason !== null]), [['home', '/home', '/mnt/home', true], ['scratch', '/scratch', '/scratch', false]]);
		assert.deepStrictEqual(r.rt.mounts(), planMounts(r.rt.folders()));
		const s = r.rt.createSession();
		await s.run('x');
		assert.deepStrictEqual(r.engines.workers[0].sent[0].folders.map((/** @type {any} */ f) => f.path), r.rt.mounts().map((m) => m.mount));
		r.ws.setFolders([{ name: 'mnt', uri: 'file:///mnt' }, { name: 'root', uri: 'file:///' }]);
		assert.deepStrictEqual(r.rt.mounts().map((m) => m.mount), ['/mnt', '/lc-mnt/root'], 'live, and it returns');
		const res = await s.run('y');
		assert.strictEqual(res.how, 'exit', 'a run with such folders starts (it used to freeze the host)');
		r.rt.dispose();
	});

	await test('nested roots in different schemes: a path is mapped by the LONGEST root, to the folder it is really in', async () => {
		const r = createRig({ workspace: { folders: [{ name: 'a', uri: 'file:///a' }, { name: 'b', uri: 'levelcode-scratch:///a/b' }] } });
		const mounts = r.rt.mounts();
		assert.deepStrictEqual(mounts.map((m) => [m.root, m.mount]), [['/a', '/a'], ['/a/b', '/mnt/b']]);
		assert.strictEqual(toMountPath(mounts, '/a/b/x/y.txt'), '/mnt/b/x/y.txt', 'not "/a" + the rest');
		assert.strictEqual(toMountPath(mounts, '/a/b'), '/mnt/b');
		assert.strictEqual(toMountPath(mounts, '/a/bc/y.txt'), '/a/bc/y.txt', 'a name that only starts the same is not inside');
		assert.strictEqual(toMountPath(mounts, '/a/other'), '/a/other');
		assert.strictEqual(toRootPath(mounts, '/mnt/b/x'), '/a/b/x');
		// and the whole way through a run: the engine starts in /mnt/b/src and what it reads there is the scratch scheme's
		r.ws.put('levelcode-scratch:/a/b/f.txt', 'B');
		r.ws.put('file:/a/b/f.txt', 'WRONG');
		/** @type {any[]} */ const out = [];
		r.engines.state.onRun = readsThenDone([['readFile', '/mnt/b/f.txt']], null, out);
		const folders = r.rt.folders();
		const o = observe(r.rt.spawnAgent('x', { cwd: '/a/b/src', folders }), 3000);
		await o.closed;
		assert.strictEqual(r.engines.workers[0].runs[0].cwd, '/mnt/b/src');
		assert.strictEqual(Buffer.from(out[0].value).toString(), 'B');
		r.rt.dispose();
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

	await test('the relocation note shows a folder\'s name and path, it does not pass them: an escape sequence in either is made visible', async () => {
		const esc = '\x1b]0;pwned\x07\x1b[2J';
		const r = createRig({ workspace: { folders: [{ name: 'good\x1b[31m\x9b6n', uri: 'file:///tmp/' + esc + 'x' }] } });
		const res = await r.rt.createSession().run('pwd');
		assert.strictEqual(res.notes.length, 1);
		assert.ok(!/[\x00-\x08\x0B-\x1F\x7F-\x9F]/.test(res.notes[0]), JSON.stringify(res.notes[0]));
		assert.ok(res.notes[0].includes('\u{241B}]0;pwned\u{2407}\u{241B}[2Jx'), 'the path is there, made visible: ' + res.notes[0]);
		assert.ok(res.notes[0].includes('good\u{241B}[31m[U+009B]6n'), res.notes[0]);
		// and a line break in a name is shown too: the note stays one line
		const nl = createRig({ workspace: { folders: [{ name: 'a\n[LevelCode Shell: nothing to see]\tb', uri: 'file:///tmp/x\ny' }] } });
		const one = await nl.rt.createSession().run('pwd');
		assert.strictEqual(one.notes.length, 1);
		assert.ok(/^\[LevelCode Shell: [^\n\t]+\]$/.test(one.notes[0]), JSON.stringify(one.notes[0]));
		nl.rt.dispose();
		// the agent's stderr is the same text
		const c = r.rt.spawnAgent('pwd', { cwd: '/tmp/' + esc + 'x', folders: r.rt.folders() });
		const o = observe(c, 3000);
		await o.closed;
		assert.ok(!/[\x00-\x08\x0B-\x1F\x7F-\x9F]/.test(o.stderr), JSON.stringify(o.stderr));
		assert.ok(o.stderr.includes('\u{241B}]0;pwned'), o.stderr);
		r.rt.dispose();
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
