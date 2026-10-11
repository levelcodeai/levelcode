/*---------------------------------------------------------------------------------------------
 *  The runtime against a REAL worker thread - run: node web/test/unit/shell-runtime-worker.test.js
 *
 *  The design stands on one fact the other suites can only assume: the engine never yields the thread (a script
 *  in a CPU-bound loop does not even hear an abort), so Stop is `terminate()` of a thread of its own, and the
 *  host goes on. Here the engine's protocol handler runs in a node:worker_threads thread behind the shape of a
 *  browser Worker (web/test/helpers/shell-real-worker.js), the workspace is the Map-backed one, and the
 *  clocks are real. What that proves, and the fake engines cannot:
 *
 *    - Stop, a deadline and an agent's SIGKILL end a script that would never end, within a fraction of a
 *      second, while a timer on the host keeps ticking (the host's own thread was never blocked);
 *    - 130 / 124 / 137, nothing the script staged is applied, and the session carries on with a new worker;
 *    - messages really are structured-cloned and buffers really are transferred (a read hands the engine a
 *      COPY: the workspace's own bytes are intact afterwards);
 *    - every thread that was started has exited when the runtime is disposed, and the process has nothing
 *      left that keeps it alive.
 *
 *  It is node's Worker, not the browser's: no Blob URL, no CSP, no worker nested in an extension host. Where a
 *  thread cannot be had the suite says SKIPPED and why, loudly; LEVELCODE_REQUIRE_WORKER=1 makes that a
 *  failure (CI sets it).
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

// A promise that never settles ends the process with status 0 and no output: a suite that did not finish fails.
let finished = false;
process.on('exit', (code) => { if (!finished && code === 0) { console.error('not ok - the tests did not finish'); process.exitCode = 1; } });

const assert = require('assert');
const path = require('path');

const { createWorkspace } = require(path.join(__dirname, '..', 'helpers', 'shell-runtime-fakes.js'));
const { createRealWorkers } = require(path.join(__dirname, '..', 'helpers', 'shell-real-worker.js'));
const { observe } = require(path.join(__dirname, '..', 'helpers', 'shell-conformance.js'));
const { createRuntime } = require(path.join(__dirname, '..', '..', 'shell', 'src', 'runtime.js'));

const ENGINE_DIR = path.join(__dirname, '..', '..', 'shell', 'engine');
const REQUIRED = process.env.LEVELCODE_REQUIRE_WORKER === '1';

let n = 0;
/** A test that returns 'skipped' has said so itself, loudly; it is not counted as passed. */
async function test(/** @type {string} */ name, /** @type {() => Promise<void|'skipped'>} */ fn) { if ((await fn()) === 'skipped') { return; } n++; console.log('  ok - ' + name); }

/** The limits that let a loop run for as long as the host lets it: the engine's own are what would end it otherwise. */
const NO_ENGINE_LIMITS = { engine: { maxCommandCount: 1e12, maxLoopIterations: 1e12, maxExecutionTimeMs: 600000 } };
const SPIN = 'i=0; while true; do i=$((i+1)); done';

/**
 * A runtime wired to real threads, the real clock and a Map workspace.
 * @param {{ limits?: any, folders?: any }} [o]
 */
function setup(o) {
	const real = /** @type {ReturnType<typeof createRealWorkers>} */ (setup.real);
	const ws = createWorkspace(o && o.folders ? { folders: o.folders } : undefined);
	const first = real.threads.length;
	const runtime = createRuntime({
		vscode: ws.vscode, loadEngineSource: async () => 'unused: the thread loads the engine from its files', createWorker: real.createWorker,
		now: Date.now, setTimeout: (/** @type {() => void} */ f, /** @type {number} */ ms) => setTimeout(f, ms), clearTimeout: (/** @type {any} */ h) => clearTimeout(h),
		limits: o && o.limits,
	});
	return { rt: runtime, ws, real, threads: () => real.threads.slice(first) };
}
setup.real = /** @type {any} */ (null);

/** @param {any} s @param {string} script @param {any} [opts] */
async function line(s, script, opts) {
	const out = [], err = [];
	const t0 = Date.now();
	const r = await s.run(script, Object.assign({ onStdout: (/** @type {string} */ t) => out.push(t), onStderr: (/** @type {string} */ t) => err.push(t) }, opts || {}));
	return Object.assign({}, r, { out: out.join(''), err: err.join(''), ms: Date.now() - t0 });
}

/**
 * Tick every 10 ms on the host's thread and say how long the longest silence was. A thread that is blocked cannot
 * tick: the engine run on this thread would show a gap as long as the script.
 */
function heartbeat() {
	let last = Date.now();
	let maxGap = 0;
	let ticks = 0;
	const h = setInterval(() => { const t = Date.now(); maxGap = Math.max(maxGap, t - last); last = t; ticks++; }, 10);
	return { stop() { clearInterval(h); return { maxGap: Math.max(maxGap, Date.now() - last), ticks }; } };
}

const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
	const real = createRealWorkers(ENGINE_DIR);
	setup.real = real;
	if (!(await real.probe())) {
		finished = true;
		const why = real.why;
		if (REQUIRED) { console.error('not ok - LEVELCODE_REQUIRE_WORKER=1 and a real worker cannot be had: ' + why); process.exitCode = 1; return; }
		console.log('  SKIPPED - the real-worker tests did not run: ' + why + '\n  (set LEVELCODE_REQUIRE_WORKER=1 to make this a failure)\n\n0 tests passed');
		return;
	}

	await test('a real thread runs a real script: output, status, a file written; and a read is a COPY (the workspace\'s own bytes are not detached by the transfer)', async () => {
		const x = setup();
		x.ws.put('/scratch/a.txt', 'hello\nworld\n');
		const before = x.ws.bytes('/scratch/a.txt');
		const s = x.rt.createSession();
		let r = await line(s, 'cat a.txt | wc -l; echo made > b.txt; ls');
		assert.deepStrictEqual({ how: r.how, exit: r.exitCode, applied: r.applied }, { how: 'exit', exit: 0, applied: 1 });
		assert.strictEqual(r.out.replace(/\s+/g, ' ').trim(), '2 a.txt b.txt');
		assert.strictEqual(x.ws.text('/scratch/b.txt'), 'made\n');
		assert.strictEqual(/** @type {Uint8Array} */ (x.ws.bytes('/scratch/a.txt')).length, 12, 'the provider\'s buffer is whole');
		assert.strictEqual(/** @type {Uint8Array} */ (before).byteLength, 12, 'and was not neutered by the transfer');
		const thread = x.threads()[0];
		assert.ok(thread.transfers >= 1, 'a buffer travelled in a transfer list: ' + thread.transfers);
		r = await line(s, 'cat nothere; echo after');
		assert.deepStrictEqual({ how: r.how, out: r.out.trim() }, { how: 'exit', out: 'after' });
		x.rt.dispose();
		assert.ok(await real.allExited(5000), 'every thread exited');
	});

	await test('Stop ends a CPU-bound loop at once with the host still ticking; nothing it had staged is applied; the session goes on with a new thread, same cwd and env', async () => {
		const x = setup({ limits: NO_ENGINE_LIMITS });
		x.ws.mkdir('/scratch/sub');
		const s = x.rt.createSession();
		await line(s, 'cd sub; export KEPT=yes');
		assert.strictEqual(s.cwd, '/scratch/sub');
		const beat = heartbeat();
		const t0 = Date.now();
		const p = line(s, 'echo start; echo staged > made.txt; ' + SPIN);
		await sleep(400);                          // the loop has been running for a good while
		const stopAt = Date.now();
		s.stop();
		const r = await p;
		const settled = Date.now() - stopAt;
		const hb = beat.stop();
		assert.deepStrictEqual({ how: r.how, exit: r.exitCode, applied: r.applied }, { how: 'aborted', exit: 130, applied: 0 });
		assert.ok(/NOT applied/.test(r.notes.join('\n')), r.notes.join('\n'));
		assert.strictEqual(r.out, 'start\n', 'what it printed before is kept');
		assert.strictEqual(x.ws.exists('/scratch/sub/made.txt'), false);
		assert.ok(settled < 2000, 'Stop took ' + settled + ' ms');
		assert.ok(Date.now() - t0 >= 400, 'the loop really ran');
		// 10 ms ticks over 400+ ms: a thread that is blocked by the script cannot tick at all
		assert.ok(hb.maxGap < 1000 && hb.ticks >= 10, 'the host thread was never blocked: longest silence ' + hb.maxGap + ' ms, ' + hb.ticks + ' ticks');
		// and on
		const after = await line(s, 'echo "$KEPT"; pwd');
		assert.strictEqual(after.out, 'yes\n/scratch/sub\n');
		assert.strictEqual(x.threads().length, 2, 'one thread served the first line and the loop; a new one after Stop');
		x.rt.dispose();
		assert.ok(await real.allExited(5000));
	});

	await test('the host deadline ends a loop that never ends: how deadline, 124, on time, nothing applied, the host not blocked', async () => {
		const x = setup({ limits: NO_ENGINE_LIMITS });
		const s = x.rt.createSession();
		await line(s, 'true');                     // a warm thread, so the clock below is the loop's
		const beat = heartbeat();
		const r = await line(s, 'echo staged > made.txt; ' + SPIN, { timeoutMs: 600 });
		const hb = beat.stop();
		assert.deepStrictEqual({ how: r.how, exit: r.exitCode, applied: r.applied }, { how: 'deadline', exit: 124, applied: 0 });
		assert.ok(/ran out of time/.test(r.notes.join('\n')), r.notes.join('\n'));
		assert.ok(r.ms >= 580 && r.ms < 3000, 'the deadline was 600 ms; the run lasted ' + r.ms);
		assert.ok(hb.maxGap < 1000 && hb.ticks >= 10, 'the host thread was never blocked: ' + hb.maxGap + ' ms, ' + hb.ticks + ' ticks');
		assert.strictEqual(x.ws.exists('/scratch/made.txt'), false);
		assert.strictEqual((await line(s, 'echo ok')).out, 'ok\n');
		x.rt.dispose();
		assert.ok(await real.allExited(5000));
	});

	await test('an agent\'s kill(SIGKILL) closes with 137 at once; kill(SIGTERM) with 130; the child closes once and the thread is gone', async () => {
		for (const [signal, code] of [['SIGKILL', 137], ['SIGTERM', 130]]) {
			const x = setup({ limits: NO_ENGINE_LIMITS });
			const folders = [{ name: 'scratch', root: '/scratch', uri: 'levelcode-scratch:///scratch' }];
			const child = x.rt.spawnAgent('echo begun; echo staged > made.txt; ' + SPIN, { cwd: '/scratch', folders });
			const o = observe(child, 20000);
			for (let waited = 0; !o.stdout.includes('begun') && waited < 10000; waited += 20) { await sleep(20); }   // the thread has booted and the script is in its loop
			assert.strictEqual(o.stdout, 'begun\n');
			await sleep(100);
			const t0 = Date.now();
			assert.strictEqual(child.kill(signal), true);
			await o.closed;
			assert.ok(Date.now() - t0 < 2000, 'closed ' + (Date.now() - t0) + ' ms after the kill');
			await sleep(20);
			const closes = o.events.filter((e) => e.type === 'close');
			assert.strictEqual(closes.length, 1);
			assert.strictEqual(/** @type {any} */ (closes[0]).code, code);
			assert.strictEqual(o.stdout, 'begun\n');
			assert.strictEqual(x.ws.exists('/scratch/made.txt'), false);
			assert.strictEqual(child.kill(signal), false, 'false after close');
			x.rt.dispose();
			assert.ok(await real.allExited(5000), 'the thread exited');
		}
	});

	await test('a script that hangs the engine in one long statement (sleep) is ended by Stop as well: it does not have to be a loop', async () => {
		const x = setup();
		const s = x.rt.createSession();
		const p = line(s, 'sleep 30; echo never');
		await sleep(300);
		s.stop();
		const r = await p;
		assert.strictEqual(r.how, 'aborted');
		assert.strictEqual(r.out, '');
		x.rt.dispose();
		assert.ok(await real.allExited(5000));
	});

	await test('two sessions are two threads: one can be spinning while the other answers, and Stop of one leaves the other alone', async () => {
		const x = setup({ limits: NO_ENGINE_LIMITS });
		const spinning = x.rt.createSession();
		const other = x.rt.createSession();
		const p = line(spinning, SPIN);
		await sleep(300);
		const r = await line(other, 'echo still here');
		assert.strictEqual(r.out, 'still here\n');
		spinning.stop();
		assert.strictEqual((await p).how, 'aborted');
		assert.strictEqual((await line(other, 'echo and again')).out, 'and again\n');
		x.rt.dispose();
		assert.ok(await real.allExited(5000));
	});

	await test('a terminal\'s /tmp that was lost with a replaced thread is said on the next line (needs the engine to report stats.tmpFiles)', async () => {
		const x = setup({ limits: { workers: { idleMs: 600 } } });
		const s = x.rt.createSession();
		let r = await line(s, 'echo scratch > /tmp/work.txt; cat /tmp/work.txt');
		assert.strictEqual(r.out, 'scratch\n');
		const done = x.threads()[0].lastDone;
		if (!done || !done.stats || typeof done.stats.tmpFiles !== 'number') {
			console.log('  SKIPPED - the /tmp note: this engine does not report stats.tmpFiles yet, so there is nothing for the note to be built on');
			x.rt.dispose();
			return 'skipped';
		}
		assert.ok(done.stats.tmpFiles >= 1, JSON.stringify(done.stats));
		await sleep(850);                                   // past the idle time, inside twice of it: still the same thread
		r = await line(s, 'cat /tmp/work.txt');
		assert.strictEqual(r.out, 'scratch\n', 'a worker that holds /tmp files is kept for twice the idle time');
		assert.strictEqual(x.threads().length, 1);
		await sleep(1500);                                  // past twice the idle time: replaced
		r = await line(s, 'cat /tmp/work.txt');
		assert.ok(r.notes.some((t) => /\/tmp was emptied when the shell restarted/.test(t)), JSON.stringify(r.notes));
		assert.ok(/No such file or directory/.test(r.err), r.err);
		x.rt.dispose();
		assert.ok(await real.allExited(5000));
	});

	// Nothing is left alive. A watchdog that does not itself keep the process up fires only if something does.
	const leak = setTimeout(() => { console.error('not ok - something is still alive: the process did not exit'); process.exit(1); }, 15000);
	leak.unref();
	assert.ok(await real.allExited(5000), 'every thread of the whole suite has exited');
	finished = true;
	console.log(`\n${n} tests passed`);
})().catch((e) => { console.error(e); process.exit(1); });
