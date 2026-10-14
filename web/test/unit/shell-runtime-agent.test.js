/*---------------------------------------------------------------------------------------------
 *  web/shell/src/runtime.js, spawnAgent - run: node web/test/unit/shell-runtime-agent.test.js
 *
 *  What the agent's run_command gets (README section 3, host.js ChildLike) and what the mirror tab hears
 *  (onAgentRun, section 3b). The ChildLike contract is checked by web/test/helpers/shell-conformance.js - the
 *  same checker levelcode-ai's tests can run on any shell they register - against the REAL runtime with a
 *  fake engine, and then rule by rule where the checker would only say that one was broken.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

// A promise that never settles ends the process with status 0 and no output: a suite that did not finish fails.
let finished = false;
process.on('exit', (code) => { if (!finished && code === 0) { console.error('not ok - the tests did not finish'); process.exitCode = 1; } });

const assert = require('assert');
const path = require('path');

const { createRig, flush } = require(path.join(__dirname, '..', 'helpers', 'shell-runtime-fakes.js'));
const { checkChildLike, observe } = require(path.join(__dirname, '..', 'helpers', 'shell-conformance.js'));

const te = new TextEncoder();
let n = 0;
async function test(/** @type {string} */ name, /** @type {() => Promise<void>} */ fn) { await fn(); n++; console.log('  ok - ' + name); }

/** An engine that understands a few command words, so the conformance checker has something to run. */
function wordEngine(/** @type {any} */ r) {
	r.engines.state.onRun = async (/** @type {any} */ run, /** @type {any} */ w, /** @type {any} */ h) => {
		const cmd = run.script;
		if (cmd === 'echo hello') { h.out(run.id, 'stdout', 'hello\n'); await flush(); h.done({ exitCode: 0 }); }
		else if (cmd === 'false') { h.out(run.id, 'stderr', 'it failed\n'); await flush(); h.done({ exitCode: 1 }); }
		else if (cmd === 'noisy') { for (let i = 0; i < 5; i++) { h.out(run.id, i % 2 ? 'stderr' : 'stdout', 'line ' + i + '\n'); } await flush(); h.done({ exitCode: 0 }); }
		else if (cmd === 'sleep') { await new Promise(() => { }); }
		else if (cmd === 'writes') { h.out(run.id, 'stdout', 'writing\n'); await flush(); h.done({ exitCode: 0, changes: [{ kind: 'write', path: '/scratch/out.txt', existed: false, before: null, after: te.encode('o') }] }); }
		else { h.done({ exitCode: 127 }); }
	};
}

(async () => {
	await test('the ChildLike contract holds for the real runtime (the shared conformance checker)', async () => {
		const r = createRig();
		wordEngine(r);
		const checked = await checkChildLike((c, o) => r.rt.spawnAgent(c, o), {
			cwd: '/scratch',
			ok: { command: 'echo hello', stdout: 'hello\n' },
			failing: { command: 'false' },
			noisy: { command: 'noisy' },
			slow: { command: 'sleep' },
			commit: { command: 'writes' },
			opts: () => ({ folders: [{ name: 'scratch', root: '/scratch', uri: 'levelcode-scratch:///scratch' }] }),
		});
		assert.deepStrictEqual(checked, [
			'shape', 'strings', 'close', 'order', 'exit status', 'kill after close', 'failing status', 'output before close',
			'commit once, before close', 'kill', 'kill idempotent', 'killed command closes once', 'never throws',
		]);
		r.rt.dispose();
	});

	await test('the checker is not a rubber stamp: it fails a child that closes twice, emits after close, or sends bytes', async () => {
		const mk = (/** @type {(c: any) => void} */ behave) => (/** @type {string} */ _cmd) => {
			const subs = /** @type {any} */ ({ out: [], err: [], close: [] });
			const child = {
				pid: undefined, stdout: { on: (/** @type {string} */ _e, /** @type {any} */ f) => subs.out.push(f) }, stderr: { on: (/** @type {string} */ _e, /** @type {any} */ f) => subs.err.push(f) },
				on: (/** @type {string} */ e, /** @type {any} */ f) => { if (e === 'close') { subs.close.push(f); } }, kill: () => false,
			};
			Promise.resolve().then(() => behave(subs));
			return child;
		};
		const run = (/** @type {(s: any) => void} */ behave) => checkChildLike(mk(behave), { cwd: '/x', ok: { command: 'ok' }, timeoutMs: 500 });
		const good = (/** @type {any} */ s) => { s.out.forEach((/** @type {any} */ f) => f('x')); s.close.forEach((/** @type {any} */ f) => f(0)); };
		await assert.rejects(run((s) => { s.close.forEach((/** @type {any} */ f) => f(0)); s.close.forEach((/** @type {any} */ f) => f(0)); }), /exactly once/);
		await assert.rejects(run((s) => { s.close.forEach((/** @type {any} */ f) => f(0)); s.out.forEach((/** @type {any} */ f) => f('late')); }), /nothing may be emitted after close/);
		await assert.rejects(run((s) => { s.out.forEach((/** @type {any} */ f) => f(new Uint8Array([104, 105]))); s.close.forEach((/** @type {any} */ f) => f(0)); }), /not a string/);
		await assert.rejects(run((s) => { s.close.forEach((/** @type {any} */ f) => f(-1)); }), /non-negative integer/);
		await assert.rejects(run(() => { /* never closes */ }), /never closed/);
		// a child that is fine until the "never throws" rules: it throws for a bad cwd
		await assert.rejects(checkChildLike((/** @type {string} */ c, /** @type {any} */ o) => { if (o && o.cwd === '/nowhere/at/all') { throw new Error('boom'); } return mk(good)(c); }, { cwd: '/x', ok: { command: 'ok' }, timeoutMs: 500 }), /spawn threw/);
	});

	await test('close, rule by rule: after the last chunk of both streams, once, with the script\'s status', async () => {
		const r = createRig();
		wordEngine(r);
		const log = [];
		const c = r.rt.spawnAgent('noisy', { cwd: '/scratch' });
		const o = observe(c, 3000, log);
		await o.closed;
		await flush();
		assert.deepStrictEqual(log, ['data', 'data', 'data', 'data', 'data', 'close']);
		assert.strictEqual(o.stdout, 'line 0\nline 2\nline 4\n');
		assert.strictEqual(o.stderr, 'line 1\nline 3\n');
		assert.strictEqual(/** @type {any} */ (o.events[o.events.length - 1]).code, 0);
		r.rt.dispose();
	});

	/** @type {Array<[string|number|undefined, number]>} */
	const SIGNALS = [['SIGTERM', 130], ['SIGKILL', 137], [undefined, 130], ['SIGINT', 130], ['SIGHUP', 130], [9, 137], [15, 130]];
	for (const [sig, code] of SIGNALS) {
		await test('kill(' + String(sig) + ') stops a running command at once and closes with ' + code + '; nothing it had staged is applied', async () => {
			const r = createRig();
			r.engines.state.onRun = async (run, w, h) => { h.out(run.id, 'stdout', 'started\n'); await new Promise(() => { }); };
			const c = r.rt.spawnAgent('long', { cwd: '/scratch' });
			const o = observe(c, 3000);
			await flush();
			assert.strictEqual(c.kill(sig), true);
			await o.closed;
			assert.strictEqual(/** @type {any} */ (o.events[o.events.length - 1]).code, code);
			assert.strictEqual(o.stdout, 'started\n');
			assert.ok(/NOT applied/.test(o.stderr), o.stderr);
			assert.strictEqual(r.engines.workers[0].terminated, true);
			r.rt.dispose();
		});
	}

	await test('kill is idempotent while it is closing, and false afterwards; a killed run closes once', async () => {
		const r = createRig();
		r.engines.state.onRun = async () => { await new Promise(() => { }); };
		const c = r.rt.spawnAgent('long', { cwd: '/scratch' });
		const o = observe(c, 3000);
		await flush();
		assert.strictEqual(c.kill('SIGTERM'), true);
		assert.strictEqual(c.kill('SIGKILL'), true, 'a second signal before close is accepted and does nothing more');
		await o.closed;
		await flush();
		assert.strictEqual(o.events.filter((e) => e.type === 'close').length, 1);
		assert.strictEqual(/** @type {any} */ (o.events[o.events.length - 1]).code, 130, 'the first signal decided');
		assert.strictEqual(c.kill('SIGKILL'), false);
		r.rt.dispose();
	});

	await test('kill before the engine has even started: the run is stopped, closes 130, and the worker that was starting is terminated', async () => {
		const r = createRig();
		r.engines.state.noReady = true;
		const c = r.rt.spawnAgent('x', { cwd: '/scratch' });
		const o = observe(c, 3000);
		await flush();
		assert.strictEqual(r.engines.workers.length, 1);
		assert.strictEqual(c.kill('SIGTERM'), true);
		await o.closed;
		assert.strictEqual(/** @type {any} */ (o.events[o.events.length - 1]).code, 130);
		assert.strictEqual(r.engines.workers[0].terminated, true);
		r.rt.dispose();
	});

	await test('kill the instant after spawn, before anything has run: closes 130 and no worker is left', async () => {
		const r = createRig();
		const c = r.rt.spawnAgent('x', { cwd: '/scratch' });
		const o = observe(c, 3000);
		assert.strictEqual(c.kill('SIGKILL'), true);
		await o.closed;
		await flush();
		assert.strictEqual(/** @type {any} */ (o.events[o.events.length - 1]).code, 137);
		assert.ok(r.engines.workers.every((w) => w.terminated), 'a worker that was made is not left behind');
		assert.strictEqual(r.clock.pending, 0);
		r.rt.dispose();
	});

	/* ===== never throws ========================================================================== */

	await test('spawn never throws: a bad cwd, odd commands, odd options, a disposed runtime are stderr and a status of 1', async () => {
		const r = createRig();
		const bad = [
			['x', { cwd: '/not/a/folder' }], ['x', { cwd: 'relative' }], ['x', { cwd: 42 }], ['x', {}], ['x', undefined], ['x', null],
			[undefined, { cwd: '/scratch' }], [{ toString() { throw new Error('no'); } }, { cwd: '/scratch' }],
			['x', { cwd: '/scratch', folders: 'nope' }], ['x', { cwd: '/scratch', folders: [{ nope: 1 }, null] }],
			['x', { cwd: '/scratch', env: 5, commit: 'nope', timeoutMs: 'soon' }],
			['x', { cwd: { toString() { throw new Error('no'); } } }],
			['x', { cwd: '/scratch', folders: [{ get name() { throw new Error('no'); }, root: '/scratch', uri: 'file:///scratch' }, { name: 'b', root: '/b', uri: 'file:///b' }] }],
		];
		for (const [cmd, opts] of bad) {
			/** @type {any} */ let c;
			assert.doesNotThrow(() => { c = r.rt.spawnAgent(/** @type {any} */ (cmd), /** @type {any} */ (opts)); }, 'case ' + bad.findIndex((c) => c[0] === cmd && c[1] === opts) + ' (' + typeof cmd + ')');
			const o = observe(c, 3000);
			await o.closed;
			await flush();
			const close = /** @type {any} */ (o.events[o.events.length - 1]);
			if (opts && /** @type {any} */ (opts).cwd === '/scratch' && cmd !== undefined && typeof cmd === 'string') {
				assert.strictEqual(close.type, 'close');   // these are fine to run; only the options were odd
			} else {
				assert.deepStrictEqual({ type: close.type, bad: close.code !== 0 }, { type: 'close', bad: true }, 'case ' + bad.findIndex((c) => c[0] === cmd && c[1] === opts) + ' (' + typeof cmd + ')');
			}
		}
		r.rt.dispose();
		const after = r.rt.spawnAgent('x', { cwd: '/scratch' });
		const o = observe(after, 3000);
		await o.closed;
		assert.strictEqual(/** @type {any} */ (o.events[o.events.length - 1]).code, 1);
		assert.ok(/shut down/.test(o.stderr), o.stderr);
	});

	await test('a working directory that cannot even be printed (an object with no text) is a refusal that says so, not a failure to start', async () => {
		const r = createRig();
		for (const cwd of [Object.create(null), { toString() { throw new Error('no'); } }]) {
			const o = observe(r.rt.spawnAgent('x', { cwd: /** @type {any} */ (cwd) }), 3000);
			await o.closed;
			assert.strictEqual(/** @type {any} */ (o.events[o.events.length - 1]).code, 1);
			assert.ok(/working directory \[unprintable value\] is not inside a workspace folder/.test(o.stderr), o.stderr);
		}
		r.rt.dispose();
	});

	await test('a working directory outside the folders is said plainly, with the offending path made safe', async () => {
		const r = createRig();
		const o = observe(r.rt.spawnAgent('x', { cwd: '/etc/\x1b[2J' }), 3000);
		await o.closed;
		assert.strictEqual(/** @type {any} */ (o.events[o.events.length - 1]).code, 1);
		assert.ok(/working directory .* is not inside a workspace folder/.test(o.stderr));
		assert.ok(!o.stderr.includes('\x1b'));
		assert.strictEqual(r.engines.workers.length, 0, 'no worker for a run that cannot start');
		r.rt.dispose();
	});

	/* ===== the shell the engine gets ============================================================== */

	await test('each spawn is a fresh shell: cwd and exports of one do not reach the next', async () => {
		const r = createRig();
		r.ws.mkdir('/scratch/sub');
		const seen = [];
		r.engines.state.onRun = async (run, w, h) => { seen.push({ cwd: run.cwd, env: run.env }); h.done({ cwd: '/scratch/sub', env: { LEAK: 'yes', PWD: '/scratch/sub' } }); };
		for (let i = 0; i < 2; i++) { const o = observe(r.rt.spawnAgent('cd sub; export LEAK=yes', { cwd: '/scratch' }), 3000); await o.closed; }
		assert.deepStrictEqual(seen[1].cwd, '/scratch');
		assert.ok(!('LEAK' in seen[1].env));
		r.rt.dispose();
	});

	await test('the environment is exactly the minimal one plus opts.env: no secrets, bad names and non-strings dropped', async () => {
		const r = createRig();
		const seen = [];
		r.engines.state.onRun = async (run, w, h) => { seen.push(run.env); h.done({}); };
		const o = observe(r.rt.spawnAgent('x', { cwd: '/scratch', env: { MY_VAR: 'v', 'BAD NAME': 'x', NUM: /** @type {any} */ (5), PATH: '/custom', PWD: '/somewhere/else' } }), 3000);
		await o.closed;
		assert.deepStrictEqual(seen[0], { HOME: '/home/user', PATH: '/custom', PWD: '/scratch', TERM: 'dumb', CI: '1', NO_COLOR: '1', LANG: 'C.UTF-8', MY_VAR: 'v' });
		const run = r.engines.workers[0].runs[0];
		assert.deepStrictEqual(Object.keys(run).sort(), ['caps', 'cwd', 'env', 'id', 'script', 'stdin', 't']);
		assert.deepStrictEqual(Object.keys(r.engines.workers[0].sent[0]).sort(), ['commands', 'folders', 'gen', 'limits', 't'], 'init carries no secret either');
		r.rt.dispose();
	});

	await test('a working directory inside a folder is the engine\'s cwd; the folders given are the mounts', async () => {
		const r = createRig();
		const folders = [{ name: 'a', root: '/a', uri: 'file:///a' }, { name: 'b', root: '/b', uri: 'file:///b' }];
		const o = observe(r.rt.spawnAgent('x', { cwd: '/b/src/deep', folders }), 3000);
		await o.closed;
		assert.strictEqual(r.engines.workers[0].runs[0].cwd, '/b/src/deep');
		assert.deepStrictEqual(r.engines.workers[0].sent[0].folders, [{ id: 'ws0', path: '/a', name: 'a' }, { id: 'ws1', path: '/b', name: 'b' }]);
		r.rt.dispose();
	});

	await test('chunks that are not strings are not passed on', async () => {
		const r = createRig();
		r.engines.state.onRun = async (run, w, h) => {
			w.emit({ t: 'out', id: run.id, stream: 'stdout', text: new Uint8Array([1, 2, 3]) });
			w.emit({ t: 'out', id: run.id, stream: 'stdout', text: { toString() { return 'obj'; } } });
			h.out(run.id, 'stdout', 'text');
			await flush();
			h.done({});
		};
		const o = observe(r.rt.spawnAgent('x', { cwd: '/scratch' }), 3000);
		await o.closed;
		assert.strictEqual(o.stdout, 'text');
		r.rt.dispose();
	});

	await test('a listener that attaches after the output has arrived still gets all of it, in order, and the close', async () => {
		const r = createRig();
		wordEngine(r);
		const c = r.rt.spawnAgent('echo hello', { cwd: '/scratch' });
		await flush();
		await flush();
		const got = [];
		let closed;
		c.stdout.on('data', (d) => got.push(d));
		c.on('close', (code) => { closed = code; });
		await flush();
		assert.deepStrictEqual(got, ['hello\n']);
		assert.strictEqual(closed, 0);
		r.rt.dispose();
	});

	/* ===== workers ================================================================================ */

	await test('the agent has its own pool: runs one after another reuse one worker; overlapping runs get another; the terminal\'s are separate', async () => {
		const r = createRig();
		/** @type {Array<() => void>} */ const gates = [];
		r.engines.state.onRun = async (run, w, h) => { if (run.script === 'hold') { await new Promise((res) => gates.push(() => res(undefined))); } h.done({}); };
		for (let i = 0; i < 3; i++) { const o = observe(r.rt.spawnAgent('quick', { cwd: '/scratch' }), 3000); await o.closed; }
		assert.strictEqual(r.engines.workers.length, 1);
		const a = observe(r.rt.spawnAgent('hold', { cwd: '/scratch' }), 3000);
		const b = observe(r.rt.spawnAgent('hold', { cwd: '/scratch' }), 3000);
		await flush();
		assert.strictEqual(r.engines.workers.length, 2, 'the first is busy, so the second run has its own');
		gates.forEach((g) => g());
		await Promise.all([a.closed, b.closed]);
		await r.rt.createSession().run('terminal');
		assert.strictEqual(r.engines.workers.length, 3, 'a terminal session does not borrow the agent\'s worker (their /tmp would be shared)');
		r.rt.dispose();
	});

	await test('of several idle agent workers the one used last is reused (its engine is the warmest); the busiest-spawned one is not special', async () => {
		const r = createRig();
		/** @type {Array<() => void>} */ const gates = [];
		r.engines.state.onRun = async (run, w, h) => { if (run.script.startsWith('hold')) { await new Promise((res) => gates.push(() => res(undefined))); } h.done({}); };
		const a = observe(r.rt.spawnAgent('hold a', { cwd: '/scratch' }), 3000);
		const b = observe(r.rt.spawnAgent('hold b', { cwd: '/scratch' }), 3000);
		const c = observe(r.rt.spawnAgent('hold c', { cwd: '/scratch' }), 3000);
		await flush();
		assert.strictEqual(r.engines.workers.length, 3);
		gates[0]();                                // the first worker finishes first...
		await a.closed;
		await r.clock.advance(1000);
		gates[1]();                                // ...the second a second later, and the third (the last started) is still busy
		await b.closed;
		const d = observe(r.rt.spawnAgent('fourth', { cwd: '/scratch' }), 3000);
		await d.closed;
		assert.deepStrictEqual(r.engines.workers.map((w) => w.runs.map((m) => m.script)), [['hold a'], ['hold b', 'fourth'], ['hold c']]);
		gates[2]();
		await c.closed;
		r.rt.dispose();
	});

	await test('exit codes: the script\'s own; 126 for a limit; 124 for the engine\'s deadline; 130 aborted; 1 for an engine failure', async () => {
		const r = createRig();
		const cases = [[{ exitCode: 0, how: 'exit' }, 0], [{ exitCode: 2, how: 'exit' }, 2], [{ exitCode: 256 + 7, how: 'exit' }, 7], [{ exitCode: 'x', how: 'exit' }, 1],
			[{ exitCode: 0, how: 'limit' }, 126], [{ exitCode: 0, how: 'deadline' }, 124], [{ exitCode: 0, how: 'aborted' }, 130],
			[{ exitCode: 0, how: 'error' }, 1], [{ exitCode: 9, how: 'error' }, 9], [{ exitCode: 0, how: 'what' }, 1]];
		for (const [done, want] of cases) {
			r.engines.state.onRun = async (run, w, h) => { h.done(done); };
			const o = observe(r.rt.spawnAgent('x', { cwd: '/scratch' }), 3000);
			await o.closed;
			assert.strictEqual(/** @type {any} */ (o.events[o.events.length - 1]).code, want, JSON.stringify(done));
		}
		r.rt.dispose();
	});

	/* ===== onAgentRun ============================================================================== */

	await test('disposing the runtime ends a pending agent run: closed (137) with a note, its worker gone, no timer left', async () => {
		const r = createRig();
		r.engines.state.onRun = async (run, w, h) => { h.out(run.id, 'stdout', 'working\n'); await new Promise(() => { }); };
		const o = observe(r.rt.spawnAgent('long', { cwd: '/scratch' }), 3000);
		await flush();
		r.rt.dispose();
		await o.closed;
		assert.strictEqual(/** @type {any} */ (o.events[o.events.length - 1]).code, 137);
		assert.ok(/NOT applied/.test(o.stderr), o.stderr);
		assert.strictEqual(r.engines.workers[0].terminated, true);
		assert.strictEqual(r.clock.pending, 0);
	});

	await test('the mirror hears start, every chunk in order, then end with the notes - and then close', async () => {
		const r = createRig();
		r.ws.put('/scratch/a', 'old');
		r.engines.state.onRun = async (run, w, h) => {
			h.out(run.id, 'stdout', 'one\n'); await flush(); h.out(run.id, 'stderr', 'two\n'); await flush();
			h.done({ exitCode: 3, notes: ['an engine note'], changes: [] });
		};
		/** @type {any[]} */ const heard = [];
		const sub = r.rt.onAgentRun((e) => heard.push(e));
		const log = [];
		const c = r.rt.spawnAgent('echo one', { cwd: '/scratch' });
		c.on('close', () => log.push('close'));
		c.stdout.on('data', () => log.push('stdout'));
		c.stderr.on('data', () => log.push('stderr'));
		const unsubscribed = [];
		await new Promise((res) => c.on('close', res));
		assert.deepStrictEqual(heard.map((e) => e.type), ['start', 'chunk', 'chunk', 'end']);
		assert.deepStrictEqual(heard[0], { type: 'start', id: heard[0].id, command: 'echo one', cwd: '/scratch' });
		assert.deepStrictEqual(heard[1], { type: 'chunk', id: heard[0].id, stream: 'stdout', text: 'one\n' });
		assert.deepStrictEqual(heard[2], { type: 'chunk', id: heard[0].id, stream: 'stderr', text: 'two\n' });
		assert.deepStrictEqual(heard[3], { type: 'end', id: heard[0].id, exitCode: 3, how: 'exit', notes: ['[LevelCode Shell: an engine note]'] });
		assert.deepStrictEqual(log, ['stdout', 'stderr', 'stderr', 'close'], 'the notes are the last stderr, and close is after');
		sub.dispose();
		unsubscribed.push(1);
		r.rt.dispose();
	});

	await test('the start event carries the model\'s explanation when there is one, capped at 500 characters; the other events never do', async () => {
		const r = createRig();
		wordEngine(r);
		/** @type {any[]} */ const heard = [];
		r.rt.onAgentRun((e) => heard.push(e));
		const run = async (/** @type {any} */ explanation) => {
			heard.length = 0;
			const o = observe(r.rt.spawnAgent('echo hello', { cwd: '/scratch', explanation }), 3000);
			await o.closed;
			return heard.slice();
		};
		let ev = await run('Run the unit tests');
		assert.deepStrictEqual(ev[0], { type: 'start', id: ev[0].id, command: 'echo hello', cwd: '/scratch', explanation: 'Run the unit tests' });
		assert.deepStrictEqual(ev.slice(1).map((e) => 'explanation' in e), [false, false]);
		ev = await run('x'.repeat(500));
		assert.strictEqual(ev[0].explanation.length, 500, 'exactly the cap is kept whole');
		ev = await run('y'.repeat(501));
		assert.strictEqual(ev[0].explanation.length, 500, 'and one more is cut');
		ev = await run('x'.repeat(499) + '\u{1F600}tail');
		assert.strictEqual(ev[0].explanation, 'x'.repeat(499), 'a pair is not cut in half: no lone surrogate is left at the end');
		ev = await run('x'.repeat(498) + '\u{1F600}tail');
		assert.strictEqual(ev[0].explanation, 'x'.repeat(498) + '\u{1F600}', 'and a pair that fits whole is kept');
		for (const none of [undefined, '', 42, null, {}, ['a']]) {
			ev = await run(none);
			assert.ok(!('explanation' in ev[0]), 'no explanation for ' + JSON.stringify(none));
		}
		// a failed spawn is still a start with the label, so its tab can say what it was for
		heard.length = 0;
		const bad = observe(r.rt.spawnAgent('x', { cwd: '/not/a/folder', explanation: 'Look around' }), 3000);
		await bad.closed;
		assert.strictEqual(heard[0].explanation, 'Look around');
		r.rt.dispose();
	});

	await test('ids are distinct per run, in order; two overlapping runs interleave chunks but each has one start and one end', async () => {
		const r = createRig();
		/** @type {Array<() => void>} */ const gates = [];
		r.engines.state.onRun = async (run, w, h) => { h.out(run.id, 'stdout', run.script); await new Promise((res) => gates.push(() => res(undefined))); h.done({}); };
		/** @type {any[]} */ const heard = [];
		r.rt.onAgentRun((e) => heard.push(e));
		const a = observe(r.rt.spawnAgent('A', { cwd: '/scratch' }), 3000);
		const b = observe(r.rt.spawnAgent('B', { cwd: '/scratch' }), 3000);
		await flush();
		gates.forEach((g) => g());
		await Promise.all([a.closed, b.closed]);
		const starts = heard.filter((e) => e.type === 'start');
		assert.strictEqual(starts.length, 2);
		assert.ok(starts[0].id < starts[1].id);
		assert.strictEqual(heard.filter((e) => e.type === 'end').length, 2);
		for (const s of starts) {
			const mine = heard.filter((e) => e.id === s.id).map((e) => e.type);
			assert.deepStrictEqual(mine, ['start', 'chunk', 'end']);
		}
		assert.strictEqual(heard.find((e) => e.type === 'chunk' && e.id === starts[0].id).text, 'A');
		r.rt.dispose();
	});

	await test('a failed spawn is still a start and an end for the mirror, so its tab is not left open', async () => {
		const r = createRig();
		/** @type {any[]} */ const heard = [];
		r.rt.onAgentRun((e) => heard.push(e));
		const o = observe(r.rt.spawnAgent('x', { cwd: '/not/a/folder' }), 3000);
		await o.closed;
		assert.deepStrictEqual(heard.map((e) => e.type), ['start', 'end']);
		assert.deepStrictEqual({ how: heard[1].how, exitCode: heard[1].exitCode }, { how: 'error', exitCode: 1 });
		r.rt.dispose();
	});

	await test('a stopped run is an end with how aborted; after dispose() of the subscription nothing more is heard', async () => {
		const r = createRig();
		r.engines.state.onRun = async () => { await new Promise(() => { }); };
		/** @type {any[]} */ const heard = [];
		const sub = r.rt.onAgentRun((e) => heard.push(e));
		const c = r.rt.spawnAgent('x', { cwd: '/scratch' });
		const o = observe(c, 3000);
		await flush();
		c.kill('SIGTERM');
		await o.closed;
		assert.deepStrictEqual(heard.map((e) => e.type), ['start', 'end']);
		assert.strictEqual(heard[1].how, 'aborted');
		sub.dispose();
		const o2 = observe(r.rt.spawnAgent('y', { cwd: '/not/a/folder' }), 3000);
		await o2.closed;
		assert.strictEqual(heard.length, 2);
		r.rt.dispose();
	});

	await test('a mirror that throws is not the agent\'s problem; the others still hear', async () => {
		const r = createRig();
		wordEngine(r);
		r.rt.onAgentRun(() => { throw new Error('tab exploded'); });
		/** @type {any[]} */ const heard = [];
		r.rt.onAgentRun((e) => heard.push(e.type));
		const o = observe(r.rt.spawnAgent('echo hello', { cwd: '/scratch' }), 3000);
		await o.closed;
		assert.strictEqual(o.stdout, 'hello\n');
		assert.deepStrictEqual(heard, ['start', 'chunk', 'end']);
		assert.ok(r.logs.some(([e]) => e === 'listener-threw'));
		r.rt.dispose();
	});

	finished = true;
	console.log(`\n${n} tests passed`);
})().catch((e) => { console.error(e); process.exit(1); });
