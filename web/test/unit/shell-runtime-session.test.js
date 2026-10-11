/*---------------------------------------------------------------------------------------------
 *  web/shell/src/runtime.js, Session - run: node web/test/unit/shell-runtime-session.test.js
 *
 *  README section 3b: what the terminal consumes. A session keeps what must survive a worker's death (cwd,
 *  env), runs one script at a time, stops with Ctrl+C, and completes for Tab from the workspace itself.
 *
 *  What it cannot keep it says: when a terminal's engine is replaced and its /tmp held anything (files, or only
 *  folders: stats.tmpEntries), the next line carries one note that /tmp was emptied; variables over the bounds
 *  are named, not silently lost.
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
const { PROGRAMS, BUILTINS } = require(path.join(__dirname, '..', '..', 'shell', 'src', 'info.js'));

let n = 0;
async function test(/** @type {string} */ name, /** @type {() => Promise<void>} */ fn) { await fn(); n++; console.log('  ok - ' + name); }

(async () => {
	await test('a session starts in the first folder, or where it is asked to if that is inside one', async () => {
		const r = createRig({ workspace: { folders: [{ name: 'a', uri: 'file:///a' }, { name: 'b', uri: 'file:///b' }] } });
		assert.strictEqual(r.rt.createSession().cwd, '/a');
		assert.strictEqual(r.rt.createSession({ cwd: '/b' }).cwd, '/b');
		assert.strictEqual(r.rt.createSession({ cwd: '/b/deep/er' }).cwd, '/b/deep/er');
		assert.strictEqual(r.rt.createSession({ cwd: '/not/a/folder' }).cwd, '/a');
		assert.strictEqual(r.rt.createSession({ cwd: 'relative' }).cwd, '/a');
		r.rt.dispose();
		const empty = createRig({ workspace: { folders: [] } });
		assert.strictEqual(empty.rt.createSession().cwd, '/', 'no folder: the engine\'s own root');
		empty.rt.dispose();
	});

	await test('cwd and env are taken back from the engine after a run, and given to the next; PWD is always the cwd', async () => {
		const r = createRig();
		r.ws.mkdir('/scratch/src');
		const seen = [];
		r.engines.state.onRun = async (run, w, h) => {
			seen.push({ cwd: run.cwd, pwd: run.env.PWD, a: run.env.A });
			if (run.script === 'cd src; export A=1') { h.done({ cwd: '/scratch/src', env: { A: '1', B: '2', PWD: '/stale' } }); } else { h.done({}); }
		};
		const s = r.rt.createSession();
		const first = await s.run('cd src; export A=1');
		assert.strictEqual(first.cwd, '/scratch/src');
		assert.strictEqual(s.cwd, '/scratch/src');
		assert.deepStrictEqual({ ...s.env }, { A: '1', B: '2', PWD: '/stale' });
		await s.run('echo $A');
		assert.deepStrictEqual(seen[1], { cwd: '/scratch/src', pwd: '/scratch/src', a: '1' });
		r.rt.dispose();
	});

	await test('only a script that ran to its end changes the session: a stopped or failed one leaves cwd and env as they were', async () => {
		const r = createRig();
		const s = r.rt.createSession();
		r.engines.state.onRun = async (run, w, h) => { h.done({ cwd: '/scratch/x', env: { KEPT: 'yes' } }); };
		await s.run('good');
		for (const how of ['limit', 'deadline', 'aborted', 'error']) {
			r.engines.state.onRun = async (run, w, h) => { h.done({ how, cwd: '/elsewhere', env: { KEPT: 'NO' } }); };
			await s.run(how);
			assert.strictEqual(s.cwd, '/scratch/x', how);
			assert.strictEqual(s.env.KEPT, 'yes', how);
		}
		r.rt.dispose();
	});

	await test('env is clean: only plain names with string values, and not without bound', async () => {
		const r = createRig();
		const huge = {};
		for (let i = 0; i < 2000; i++) { huge['V' + i] = 'x'; }
		r.engines.state.onRun = async (run, w, h) => {
			h.done({ env: Object.assign({ GOOD: 'ok', 'BAD NAME': 'x', '1ST': 'x', NUM: 5, OBJ: {}, '': 'x', 'A-B': 'x', '__proto__x': 'x' }, huge) });
		};
		const s = r.rt.createSession();
		await s.run('x');
		assert.strictEqual(s.env.GOOD, 'ok');
		for (const bad of ['BAD NAME', '1ST', 'NUM', 'OBJ', '', 'A-B']) { assert.ok(!(bad in s.env), bad); }
		assert.ok(Object.keys(s.env).length <= 512);
		r.rt.dispose();
	});

	await test('a variable over the bounds is left out - that one, not everything after it - and the line says so, once', async () => {
		const r = createRig();
		const KiB = 1024;
		/** @type {Record<string, string>} */ let toCarry = {};
		r.engines.state.onRun = async (run, w, h) => { h.done({ env: toCarry }); };
		const s = r.rt.createSession();
		// `export BIG=<300 KiB>; export A=1`
		toCarry = { FIRST: '1', BIG: 'x'.repeat(300 * KiB), A: '1', LAST: '2' };
		let res = await s.run('export BIG=...; export A=1');
		assert.deepStrictEqual(Object.keys(s.env).sort(), ['A', 'FIRST', 'LAST']);
		assert.deepStrictEqual(res.notes, ['[LevelCode Shell: 1 environment variable was not kept: this shell carries at most 512 variables and 256 KiB of them]']);
		// the byte bound: name + value, exactly 256 KiB is kept, one more is not
		toCarry = { EXACT: 'y'.repeat(256 * KiB - 'EXACT'.length) };
		res = await s.run('x');
		assert.strictEqual(Object.keys(s.env).join(','), 'EXACT');
		assert.deepStrictEqual(res.notes, []);
		toCarry = { OVER: 'y'.repeat(256 * KiB - 'OVER'.length + 1), SMALL: 's' };
		res = await s.run('x');
		assert.strictEqual(Object.keys(s.env).join(','), 'SMALL');
		assert.strictEqual(res.notes.length, 1);
		// two that fit separately and not together: the first stays
		toCarry = { P: 'p'.repeat(200 * KiB), Q: 'q'.repeat(100 * KiB), R: 'r' };
		res = await s.run('x');
		assert.deepStrictEqual(Object.keys(s.env), ['P', 'R']);
		assert.ok(/1 environment variable was not kept/.test(res.notes[0]));
		// the count bound: 512 are kept, the 513th and the ones after it are counted
		toCarry = {};
		for (let i = 0; i < 512; i++) { toCarry['V' + i] = 'v'; }
		res = await s.run('x');
		assert.strictEqual(Object.keys(s.env).length, 512);
		assert.deepStrictEqual(res.notes, [], 'exactly 512 is allowed');
		toCarry['V512'] = 'v';
		toCarry['V513'] = 'v';
		res = await s.run('x');
		assert.strictEqual(Object.keys(s.env).length, 512);
		assert.ok(!('V512' in s.env));
		assert.deepStrictEqual(res.notes, ['[LevelCode Shell: 2 environment variables were not kept: this shell carries at most 512 variables and 256 KiB of them]']);
		// names that are not names are not variables, and are not "left out"
		toCarry = { 'BAD NAME': 'x', OK: 'y', NUM: /** @type {any} */ (5) };
		res = await s.run('x');
		assert.deepStrictEqual(res.notes, []);
		r.rt.dispose();
	});

	await test('the same for an agent\'s opts.env: the one that does not fit is named on stderr, the rest are in the engine\'s environment', async () => {
		const r = createRig();
		const seen = [];
		r.engines.state.onRun = async (run, w, h) => { seen.push(run.env); h.done({}); };
		const env = /** @type {Record<string, string>} */ ({ BIG: 'x'.repeat(300 * 1024), SMALL: 's' });
		for (let i = 0; i < 520; i++) { env['W' + i] = 'w'; }
		const o = observe(r.rt.spawnAgent('x', { cwd: '/scratch', env }), 3000);
		await o.closed;
		assert.strictEqual(seen[0].SMALL, 's');
		assert.ok(!('BIG' in seen[0]));
		assert.ok(/\[LevelCode Shell: \d+ environment variables were not kept/.test(o.stderr), o.stderr);
		assert.strictEqual(o.stderr.split('were not kept').length - 1, 1, 'once');
		r.rt.dispose();
	});

	await test('session.env cannot be used to change the session: it is a frozen copy', async () => {
		const r = createRig();
		const s = r.rt.createSession();
		const e = s.env;
		assert.throws(() => { 'use strict'; /** @type {any} */ (e).HOME = '/etc'; }, TypeError);
		assert.strictEqual(s.env.HOME, '/home/user');
		r.rt.dispose();
	});

	await test('the width of the terminal reaches the engine as COLUMNS, only when it is a sensible number', async () => {
		const r = createRig();
		const cols = [];
		r.engines.state.onRun = async (run, w, h) => { cols.push(run.env.COLUMNS); h.done({}); };
		const s = r.rt.createSession();
		await s.run('a', { cols: 120 });
		await s.run('b', { cols: 0 });
		await s.run('c', { cols: /** @type {any} */ ('wide') });
		await s.run('d', { cols: 80.7 });
		await s.run('e');
		assert.deepStrictEqual(cols, ['120', undefined, undefined, '80', undefined]);
		r.rt.dispose();
	});

	await test('its height reaches the engine as LINES the same way; the bounds are 1 and 9999, and a fraction below 1 is nothing', async () => {
		const r = createRig();
		/** @type {Array<[string|undefined, string|undefined]>} */ const seen = [];
		r.engines.state.onRun = async (run, w, h) => { seen.push([run.env.COLUMNS, run.env.LINES]); h.done({}); };
		const s = r.rt.createSession();
		/** @type {any[]} */
		const sizes = [[120, 30], [1, 1], [9999, 9999], [10000, 10000], [0, 0], [0.5, 0.5], [-3, -3], [NaN, NaN], [Infinity, Infinity], ['40', '12'], [80.9, 24.9], [undefined, undefined]];
		for (const [cols, rows] of sizes) { await s.run('x', { cols, rows }); }
		await s.run('only rows', { rows: 40 });
		assert.deepStrictEqual(seen, [
			['120', '30'], ['1', '1'], ['9999', '9999'], [undefined, undefined], [undefined, undefined], [undefined, undefined], [undefined, undefined],
			[undefined, undefined], [undefined, undefined], [undefined, undefined], ['80', '24'], [undefined, undefined], [undefined, '40'],
		]);
		r.rt.dispose();
	});

	await test('the terminal\'s size is a fact of ONE run: the engine hands COLUMNS and LINES back in the env, and they are not carried to a run that is not told its own', async () => {
		const r = createRig();
		/** @type {Array<[string|undefined, string|undefined]>} */ const seen = [];
		r.engines.state.onRun = async (run, w, h) => {
			seen.push([run.env.COLUMNS, run.env.LINES]);
			h.done({ env: Object.assign({}, run.env, run.script === 'export COLUMNS=50' ? { COLUMNS: '50' } : {}) });   // what the real engine returns: the whole env
		};
		const s = r.rt.createSession();
		await s.run('a', { cols: 100, rows: 30 });
		assert.strictEqual('COLUMNS' in s.env || 'LINES' in s.env, false, 'not state of the session');
		await s.run('b');
		await s.run('c', { cols: 120 });
		await s.run('d');
		assert.deepStrictEqual(seen, [['100', '30'], [undefined, undefined], ['120', undefined], [undefined, undefined]]);
		// a value the script itself set is the script's, and stays (the same as in bash)
		await s.run('export COLUMNS=50', { cols: 100 });
		assert.strictEqual(s.env.COLUMNS, '50');
		await s.run('e');
		assert.deepStrictEqual(seen[seen.length - 1], ['50', undefined]);
		r.rt.dispose();
	});

	await test('run() never throws: a script that is not text, a disposed or busy session are rejections, whatever the script is', async () => {
		const r = createRig();
		r.engines.state.onRun = async () => { await new Promise(() => { }); };
		const s = r.rt.createSession();
		const hostile = Object.create(null);
		for (const bad of [42, undefined, null, {}, [], hostile, { toString() { throw new Error('no'); } }, Symbol('x'), () => 'echo']) {
			/** @type {any} */ let p;
			assert.doesNotThrow(() => { p = s.run(/** @type {any} */ (bad)); }, 'threw synchronously for ' + typeof bad);
			assert.ok(p instanceof Promise);
			await assert.rejects(p, (e) => e instanceof Error && e.message === 'script must be text');
		}
		assert.strictEqual(r.engines.workers.length, 0, 'nothing was started for any of them');
		const first = s.run('hang');
		await flush();
		/** @type {any} */ let busy;
		assert.doesNotThrow(() => { busy = s.run('x'); });
		await assert.rejects(busy, (e) => e instanceof Error && e.message === 'busy');
		s.stop();
		assert.strictEqual((await first).how, 'aborted');
		s.dispose();
		await assert.rejects(s.run('x'), (e) => e instanceof Error && e.message === 'disposed');
		r.rt.dispose();
	});

	await test('one script at a time: a second run while one is pending rejects with busy, and the first is untouched', async () => {
		const r = createRig();
		/** @type {() => void} */ let finish = () => { };
		r.engines.state.onRun = async (run, w, h) => { await new Promise((res) => { finish = () => res(undefined); }); h.done({ exitCode: 9 }); };
		const s = r.rt.createSession();
		const first = s.run('slow');
		await flush();
		await assert.rejects(s.run('second'), (e) => e instanceof Error && e.message === 'busy');
		finish();
		assert.strictEqual((await first).exitCode, 9);
		r.engines.state.onRun = async (run, w, h) => { h.done({}); };
		assert.strictEqual((await s.run('third')).how, 'exit');
		r.rt.dispose();
	});

	await test('"busy" is per session: two sessions run at once, each with its own worker', async () => {
		const r = createRig();
		/** @type {Array<() => void>} */ const gates = [];
		r.engines.state.onRun = async (run, w, h) => { await new Promise((res) => gates.push(() => res(undefined))); h.done({ exitCode: run.script === 'a' ? 1 : 2 }); };
		const a = r.rt.createSession();
		const b = r.rt.createSession();
		const pa = a.run('a');
		const pb = b.run('b');
		await flush();
		assert.strictEqual(r.engines.workers.length, 2);
		gates.forEach((g) => g());
		assert.deepStrictEqual([(await pa).exitCode, (await pb).exitCode], [1, 2]);
		r.rt.dispose();
	});

	await test('a cwd that lived in the engine\'s own memory is not carried across a replaced worker: back to the first folder, said so', async () => {
		const r = createRig();
		r.engines.state.onRun = async (run, w, h) => { h.done({ cwd: run.script === 'cd /tmp/work' ? '/tmp/work' : run.cwd }); };
		const s = r.rt.createSession();
		await s.run('cd /tmp/work');
		assert.strictEqual(s.cwd, '/tmp/work');
		const same = await s.run('echo still here');
		assert.deepStrictEqual(same.notes, [], 'the same worker still has that folder');
		await r.clock.advance(60000);
		assert.strictEqual(r.engines.workers[0].terminated, true);
		const res = await s.run('pwd');
		assert.strictEqual(r.engines.workers[1].runs[0].cwd, '/scratch');
		assert.ok(/\/tmp\/work is gone .* starting in \/scratch/.test(res.notes[0]), res.notes.join('\n'));
		assert.strictEqual(s.cwd, '/scratch');
		r.rt.dispose();
	});

	await test('the note that a folder in the engine\'s memory is gone shows its name, it does not pass it', async () => {
		const r = createRig();
		const evil = '/tmp/\x1b]0;pwned\x07\x1b[2J\x9b6n';
		r.engines.state.onRun = async (run, w, h) => { h.done({ cwd: run.script === 'cd' ? evil : run.cwd }); };
		const s = r.rt.createSession();
		await s.run('cd');
		await r.clock.advance(60000);
		const res = await s.run('pwd');
		assert.strictEqual(res.notes.length, 1);
		assert.ok(!/[\x00-\x08\x0B-\x1F\x7F-\x9F]/.test(res.notes[0]), JSON.stringify(res.notes[0]));
		assert.ok(res.notes[0].includes('/tmp/\u{241B}]0;pwned\u{2407}\u{241B}[2J[U+009B]6n is gone'), res.notes[0]);
		r.rt.dispose();
		// and the folder it starts in again is the visitor's own, with whatever its path holds
		const odd = createRig({ workspace: { folders: [{ name: 'w', uri: 'file:///work/\x1b[2Jdir' }] } });
		odd.engines.state.onRun = async (run, w, h) => { h.done({ cwd: run.script === 'cd' ? '/tmp/x' : run.cwd }); };
		const t = odd.rt.createSession();
		await t.run('cd');
		await odd.clock.advance(60000);
		const back = await t.run('pwd');
		assert.ok(!/[\x00-\x08\x0B-\x1F\x7F-\x9F]/.test(back.notes.join('\n')), JSON.stringify(back.notes));
		assert.ok(back.notes[0].includes('starting in /work/\u{241B}[2Jdir'), back.notes[0]);
		odd.rt.dispose();
	});

	await test('the engine\'s own /tmp survives a replaced worker as a place to start: it is always there in a new one', async () => {
		const r = createRig();
		r.engines.state.onRun = async (run, w, h) => { h.done({ cwd: '/tmp' }); };
		const s = r.rt.createSession();
		await s.run('cd /tmp');
		await r.clock.advance(60000);
		const seen = [];
		r.engines.state.onRun = async (run, w, h) => { seen.push(run.cwd); h.done({ cwd: run.cwd }); };
		const res = await s.run('pwd');
		assert.deepStrictEqual(seen, ['/tmp']);
		assert.deepStrictEqual(res.notes, []);
		r.rt.dispose();
	});

	await test('stop() settles the pending run as aborted (130) and a later run on the same session works', async () => {
		const r = createRig();
		r.engines.state.onRun = async (run, w, h) => { if (run.script === 'loop') { await new Promise(() => { }); } h.done({}); };
		const s = r.rt.createSession();
		const p = s.run('loop');
		await flush();
		s.stop();
		const res = await p;
		assert.deepStrictEqual({ how: res.how, exitCode: res.exitCode }, { how: 'aborted', exitCode: 130 });
		assert.strictEqual((await s.run('ok')).how, 'exit');
		r.rt.dispose();
	});

	await test('dispose() stops what is running, terminates the session\'s worker and refuses further runs', async () => {
		const r = createRig();
		r.engines.state.onRun = async () => { await new Promise(() => { }); };
		const s = r.rt.createSession();
		const p = s.run('loop');
		await flush();
		s.dispose();
		assert.strictEqual((await p).how, 'aborted');
		assert.strictEqual(r.engines.workers[0].terminated, true);
		await assert.rejects(s.run('again'), (e) => e instanceof Error && e.message === 'disposed');
		s.dispose();
		r.rt.dispose();
	});

	await test('disposing the runtime stops every session and terminates every worker; a session cannot be made to run after', async () => {
		const r = createRig();
		r.engines.state.onRun = async () => { await new Promise(() => { }); };
		const a = r.rt.createSession();
		const b = r.rt.createSession();
		const pa = a.run('x');
		const pb = b.run('y');
		await flush();
		r.rt.dispose();
		assert.deepStrictEqual([(await pa).how, (await pb).how], ['aborted', 'aborted']);
		assert.ok(r.engines.workers.every((w) => w.terminated));
		await assert.rejects(a.run('z'), /disposed/);
		assert.strictEqual(r.clock.pending, 0, 'and no timer is left behind');
	});

	/* ===== a terminal's /tmp does not outlive its engine, and it says so ===================================== */

	/** The engine's side: it keeps `files` in /tmp and says so in `done`, as the real one does for a terminal run. */
	function holdsTmp(/** @type {any} */ r, /** @type {() => number} */ files) {
		r.engines.state.onRun = async (/** @type {any} */ run, /** @type {any} */ w, /** @type {any} */ h) => {
			if (run.script === 'hang') { await new Promise(() => { }); }
			h.done({ exitCode: 0, how: 'exit', cwd: run.cwd, stats: { tmpFiles: files() } });
		};
	}
	const EMPTIED = /^\[LevelCode Shell: \/tmp was emptied when the shell restarted \(it held (\d+) files?\)/;

	await test('a replaced worker whose /tmp held files: the NEXT line says /tmp was emptied, once; with nothing in /tmp, nothing is said', async () => {
		const r = createRig();
		let files = 3;
		holdsTmp(r, () => files);
		const s = r.rt.createSession();
		assert.deepStrictEqual((await s.run('echo x > /tmp/a')).notes, [], 'the first line has nothing to say');
		assert.deepStrictEqual((await s.run('cat /tmp/a')).notes, [], 'the same worker: /tmp is there');
		await r.clock.advance(120000);                     // (twice the idle time: see the next test)
		assert.strictEqual(r.engines.workers[0].terminated, true);
		const after = await s.run('cat /tmp/a');
		assert.strictEqual(after.notes.length, 1, after.notes.join('\n'));
		const m = EMPTIED.exec(after.notes[0]);
		assert.ok(m && m[1] === '3', after.notes[0]);
		assert.ok(/Keep what matters in a workspace folder\]$/.test(after.notes[0]), after.notes[0]);
		assert.deepStrictEqual((await s.run('echo again')).notes, [], 'said once');
		// an empty /tmp (or an engine that does not say) is not worth a line
		files = 0;
		await s.run('rm -r /tmp/*');
		await r.clock.advance(60000);
		assert.strictEqual(r.engines.workers[r.engines.workers.length - 1].terminated, true, 'with nothing in /tmp the usual minute is enough');
		assert.deepStrictEqual((await s.run('x')).notes, []);
		r.rt.dispose();
	});

	await test('the /tmp note comes FIRST among a run\'s notes: before the folder that was moved and before what the engine said', async () => {
		const r = createRig({ workspace: { folders: [{ name: 'home', uri: 'file:///home' }, { name: 'scratch', uri: 'levelcode-scratch:///scratch' }] } });
		r.engines.state.onRun = async (run, w, h) => { h.done({ exitCode: 0, how: 'exit', cwd: run.cwd, notes: ['from the engine'], stats: { tmpFiles: 2 } }); };
		const s = r.rt.createSession();
		const first = await s.run('echo x > /tmp/a');
		assert.deepStrictEqual(first.notes, ['[LevelCode Shell: The folder "home" is mounted at /mnt/home, not at /home: that path is one the shell uses for itself.]', '[LevelCode Shell: from the engine]']);
		await r.clock.advance(120000);
		const after = await s.run('ls /tmp');
		assert.strictEqual(after.notes.length, 3, after.notes.join('\n'));
		assert.ok(EMPTIED.test(after.notes[0]), 'first: ' + after.notes[0]);
		assert.ok(/is mounted at \/mnt\/home/.test(after.notes[1]) && /from the engine/.test(after.notes[2]), after.notes.join('\n'));
		r.rt.dispose();
	});

	await test('the /tmp note comes before what the commit says too: a replaced worker, then a line whose changes are refused', async () => {
		const r = createRig();
		const te = new TextEncoder();
		/** @type {any[]} */ let changes = [];
		r.engines.state.onRun = async (run, w, h) => { h.done({ exitCode: 0, how: 'exit', cwd: run.cwd, changes, stats: { tmpFiles: 2 } }); };
		const s = r.rt.createSession();
		await s.run('echo x > /tmp/a');
		await r.clock.advance(120000);
		r.ws.put('/scratch/a.txt', 'changed meanwhile');
		changes = [{ kind: 'write', path: '/scratch/a.txt', existed: true, before: te.encode('old'), after: te.encode('new') }];
		const res = await s.run('sed -i s/old/new/ a.txt');
		assert.strictEqual(res.notes.length, 3, res.notes.join('\n'));
		assert.ok(EMPTIED.test(res.notes[0]), 'first: ' + res.notes[0]);
		assert.ok(/refused: \/scratch\/a\.txt changed while the command ran/.test(res.notes[1]), res.notes[1]);
		assert.ok(/NONE of this command's file changes were applied/.test(res.notes[2]), res.notes[2]);
		r.rt.dispose();
	});

	await test('at the worker cap the one replaced is the least recently used idle worker WITHOUT /tmp files: the files are the one thing that cannot be made again', async () => {
		const r = createRig({ limits: { workers: { max: 2 } } });
		/** @type {Record<string, number>} */ const files = { keeper: 3, plain: 0 };
		r.engines.state.onRun = async (run, w, h) => { h.done({ exitCode: 0, how: 'exit', cwd: run.cwd, stats: { tmpFiles: files[run.script.split(' ')[0]] || 0 } }); };
		const keeper = r.rt.createSession();
		const plain = r.rt.createSession();
		await keeper.run('keeper');                  // the older one, and it holds files
		await r.clock.advance(1000);
		await plain.run('plain');                    // the newer one, holding none
		await r.clock.advance(1000);
		const third = r.rt.createSession();
		await third.run('plain');
		assert.deepStrictEqual(r.engines.workers.map((w) => w.terminated), [false, true, false], 'the newer, empty one was replaced; the older one that holds files was not');
		assert.deepStrictEqual((await keeper.run('keeper')).notes, [], 'its /tmp is there');
		// when every idle worker holds files, it is the least recently used after all
		const q = createRig({ limits: { workers: { max: 2 } } });
		q.engines.state.onRun = async (run, w, h) => { h.done({ exitCode: 0, how: 'exit', cwd: run.cwd, stats: { tmpFiles: 1 } }); };
		const a = q.rt.createSession();
		const b = q.rt.createSession();
		await a.run('x');
		await q.clock.advance(1000);
		await b.run('x');
		await q.clock.advance(1000);
		await q.rt.createSession().run('x');
		assert.deepStrictEqual(q.engines.workers.map((w) => w.terminated), [true, false, false]);
		r.rt.dispose();
		q.rt.dispose();
	});

	await test('a worker that holds /tmp files is kept for TWICE the idle time; one that holds none, for once', async () => {
		const r = createRig();
		holdsTmp(r, () => 1);
		const s = r.rt.createSession();
		await s.run('x');
		await r.clock.advance(60000);
		assert.strictEqual(r.engines.workers[0].terminated, false, 'a minute is not enough for one that holds files');
		await r.clock.advance(59999);
		assert.strictEqual(r.engines.workers[0].terminated, false);
		await r.clock.advance(1);
		assert.strictEqual(r.engines.workers[0].terminated, true, 'two minutes are');
		// and the clock restarts with use
		const t = createRig();
		holdsTmp(t, () => 1);
		const u = t.rt.createSession();
		await u.run('a');
		await t.clock.advance(100000);
		await u.run('b');
		await t.clock.advance(100000);
		assert.strictEqual(t.engines.workers[0].terminated, false, '100 s after the last line is still inside 120 s');
		await t.clock.advance(20000);
		assert.strictEqual(t.engines.workers[0].terminated, true);
		r.rt.dispose();
		t.rt.dispose();
	});

	await test('every way a terminal\'s worker is replaced says the same on the next line: Ctrl+C, a deadline, a crash, an eviction, other folders', async () => {
		const ways = /** @type {Array<[string, (r: any, s: any) => Promise<void>]>} */ ([
			['Ctrl+C', async (r, s) => { const p = s.run('hang'); await flush(); s.stop(); await p; }],
			['a deadline', async (r, s) => { const p = s.run('hang', { timeoutMs: 1000 }); await flush(); await r.clock.advance(1000); await p; }],
			['a crash', async (r, s) => { r.engines.state.onRun = async (run, w) => { w.crash('out of memory'); }; await s.run('boom'); holdsTmp(r, () => 5); }],
			['an eviction', async (r) => {
				const others = [1, 2, 3, 4].map(() => r.rt.createSession());
				for (const o of others) { await r.clock.advance(1000); await o.run('x'); }
			}],
			['other folders', async (r) => { r.ws.setFolders([{ name: 'other', uri: 'file:///other' }]); }],
		]);
		for (const [way, replace] of ways) {
			const r = createRig({ limits: way === 'an eviction' ? { workers: { max: 4 } } : undefined });
			holdsTmp(r, () => 5);
			const s = r.rt.createSession();
			assert.deepStrictEqual((await s.run('echo x > /tmp/a')).notes, [], way);
			await replace(r, s);
			const res = await s.run('ls /tmp');
			const emptied = res.notes.filter((t) => EMPTIED.test(t));
			assert.strictEqual(emptied.length, 1, way + ': ' + res.notes.join('\n'));
			assert.ok(/held 5 files/.test(emptied[0]), way);
			assert.deepStrictEqual((await s.run('ls /tmp')).notes.filter((t) => EMPTIED.test(t)), [], way + ': said once');
			r.rt.dispose();
		}
	});

	await test('the note travels with the run that has the new worker, even if that run is stopped; it is not lost and not said twice', async () => {
		const r = createRig();
		holdsTmp(r, () => 2);
		const s = r.rt.createSession();
		await s.run('echo x > /tmp/a');
		await r.clock.advance(120000);
		const p = s.run('hang');
		await flush();
		s.stop();
		const stopped = await p;
		assert.strictEqual(stopped.how, 'aborted');
		assert.strictEqual(stopped.notes.filter((t) => EMPTIED.test(t)).length, 1, 'the stopped run says it: ' + stopped.notes.join('\n'));
		assert.deepStrictEqual((await s.run('ls /tmp')).notes.filter((t) => EMPTIED.test(t)), []);
		r.rt.dispose();
	});

	await test('a run that never got as far as a new worker has not said it yet: the next one does', async () => {
		const r = createRig();
		holdsTmp(r, () => 4);
		const s = r.rt.createSession();
		await s.run('x');
		await r.clock.advance(120000);
		// no worker can be had: the cap is taken by four busy runs of others
		const others = [1, 2, 3, 4].map(() => r.rt.createSession());
		r.engines.state.onRun = async () => { await new Promise(() => { }); };
		others.forEach((o) => { o.run('hang'); });
		await flush();
		const refused = await s.run('x');
		assert.strictEqual(refused.how, 'error');
		assert.deepStrictEqual(refused.notes.filter((t) => EMPTIED.test(t)), [], 'nothing was replaced yet');
		others.forEach((o) => o.dispose());
		holdsTmp(r, () => 0);
		const ok = await s.run('x');
		assert.strictEqual(ok.notes.filter((t) => EMPTIED.test(t)).length, 1);
		r.rt.dispose();
	});

	await test('an engine that does not report its /tmp (no stats.tmpFiles) never gets the note; an agent run never does either', async () => {
		const r = createRig();
		r.engines.state.onRun = async (run, w, h) => { h.done({ stats: { durationMs: 3 } }); };
		const s = r.rt.createSession();
		await s.run('x');
		await r.clock.advance(60000);
		assert.strictEqual(r.engines.workers[0].terminated, true, 'and the usual minute applies');
		assert.deepStrictEqual((await s.run('x')).notes, []);
		const rr = createRig();
		holdsTmp(rr, () => 9);
		for (let i = 0; i < 2; i++) {
			const o = observe(rr.rt.spawnAgent('x', { cwd: '/scratch' }), 3000);
			await o.closed;
			await rr.clock.advance(60000);
			assert.strictEqual(rr.engines.workers[rr.engines.workers.length - 1].terminated, true, 'an agent\'s worker is idle for the usual minute, whatever its /tmp held');
			assert.ok(!/\/tmp was emptied/.test(o.stderr), o.stderr);
		}
		const nonsense = createRig();
		const t = nonsense.rt.createSession();
		for (const bad of [-1, NaN, Infinity, '3', null, {}, 0.4]) {
			nonsense.engines.state.onRun = async (run, w, h) => { h.done({ stats: { tmpFiles: bad } }); };
			await t.run('x');
			await nonsense.clock.advance(60000);
			const last = nonsense.engines.workers[nonsense.engines.workers.length - 1];
			assert.strictEqual(last.terminated, true, JSON.stringify(bad) + ' is not a count of files: the usual minute applies');
			assert.deepStrictEqual((await t.run('x')).notes, [], JSON.stringify(bad));
		}
		r.rt.dispose();
		rr.rt.dispose();
		nonsense.rt.dispose();
	});

	/* ===== fix round 3: what /tmp holds is files AND folders ================================================ */

	/**
	 * The engine's side as the current one reports it for a terminal run: `stats` exactly as given (tmpFiles, and
	 * tmpEntries: the files and the folders). It is read at every run, so a test can change what /tmp "holds".
	 * @param {any} r @param {() => any} stats
	 */
	function reports(r, stats) {
		r.engines.state.onRun = async (/** @type {any} */ run, /** @type {any} */ w, /** @type {any} */ h) => {
			if (run.script === 'hang') { await new Promise(() => { }); }
			h.done({ exitCode: 0, how: 'exit', cwd: run.cwd, stats: stats() });
		};
	}
	/** Every note about /tmp in `notes`. @param {string[]} notes */
	const tmpNotes = (notes) => notes.filter((t) => /\/tmp was emptied/.test(t)).map((t) => (/\(it held ([^)]*)\)/.exec(t) || [])[1]);

	await test('a /tmp that holds only an empty folder is something: the worker is kept twice as long, and the loss is said, as "1 file or folder"', async () => {
		const r = createRig();
		reports(r, () => ({ tmpFiles: 0, tmpEntries: 1 }));
		const s = r.rt.createSession();
		await s.run('mkdir /tmp/emptydir');
		await r.clock.advance(60000);
		assert.strictEqual(r.engines.workers[0].terminated, false, 'a minute is not enough for a /tmp that holds a folder');
		await r.clock.advance(59999);
		assert.strictEqual(r.engines.workers[0].terminated, false);
		await r.clock.advance(1);
		assert.strictEqual(r.engines.workers[0].terminated, true, 'two minutes are');
		const after = await s.run('ls /tmp');
		assert.deepStrictEqual(tmpNotes(after.notes), ['1 file or folder']);
		assert.deepStrictEqual(tmpNotes((await s.run('ls /tmp')).notes), [], 'said once');
		r.rt.dispose();
	});

	await test('the note says "N files and folders" with the engine\'s own number: five entries of which two are files', async () => {
		const r = createRig();
		reports(r, () => ({ tmpFiles: 2, tmpEntries: 5 }));
		const s = r.rt.createSession();
		await s.run('x');
		await r.clock.advance(120000);
		const after = await s.run('ls /tmp');
		assert.strictEqual(after.notes.length, 1, after.notes.join('\n'));
		assert.ok(/^\[LevelCode Shell: \/tmp was emptied when the shell restarted \(it held 5 files and folders\): /.test(after.notes[0]), after.notes[0]);
		assert.ok(/Keep what matters in a workspace folder\]$/.test(after.notes[0]), after.notes[0]);
		r.rt.dispose();
	});

	await test('an engine that reports only stats.tmpFiles is believed as before: files, and the old wording', async () => {
		for (const [files, said] of /** @type {Array<[number, string]>} */ ([[3, '3 files'], [1, '1 file']])) {
			const r = createRig();
			reports(r, () => ({ tmpFiles: files }));
			const s = r.rt.createSession();
			await s.run('x');
			await r.clock.advance(120000);
			assert.deepStrictEqual(tmpNotes((await s.run('x')).notes), [said]);
			r.rt.dispose();
		}
	});

	await test('a tmpEntries that is not a count is as good as none: the files count is used, with the wording of files', async () => {
		for (const bad of [-1, NaN, Infinity, '3', null, {}, true]) {
			const r = createRig();
			reports(r, () => ({ tmpFiles: 3, tmpEntries: bad }));
			const s = r.rt.createSession();
			await s.run('x');
			await r.clock.advance(120000);
			assert.deepStrictEqual(tmpNotes((await s.run('x')).notes), ['3 files'], JSON.stringify(bad));
			r.rt.dispose();
		}
	});

	await test('both counts present and in disagreement (fewer entries than files): the larger is believed - a loss of files is not to go unsaid', async () => {
		const r = createRig();
		reports(r, () => ({ tmpFiles: 4, tmpEntries: 1 }));
		const s = r.rt.createSession();
		await s.run('x');
		await r.clock.advance(120000);
		assert.deepStrictEqual(tmpNotes((await s.run('x')).notes), ['4 files and folders']);
		r.rt.dispose();
	});

	await test('an empty /tmp, or counts that are not counts, say nothing and keep the worker for the usual minute', async () => {
		for (const stats of [{ tmpFiles: 0, tmpEntries: 0 }, { tmpEntries: 0 }, { tmpEntries: -3, tmpFiles: NaN }, { tmpEntries: '2' }, { tmpEntries: 0.4 }, {}]) {
			const r = createRig();
			reports(r, () => stats);
			const s = r.rt.createSession();
			await s.run('x');
			await r.clock.advance(60000);
			assert.strictEqual(r.engines.workers[0].terminated, true, JSON.stringify(stats) + ': the usual minute');
			assert.deepStrictEqual((await s.run('x')).notes, [], JSON.stringify(stats));
			r.rt.dispose();
		}
	});

	await test('at the worker cap a worker whose /tmp holds only a folder is kept in preference to an empty one, like one that holds files', async () => {
		const r = createRig({ limits: { workers: { max: 2 } } });
		/** @type {Record<string, any>} */ const by = { keeper: { tmpFiles: 0, tmpEntries: 1 }, plain: { tmpFiles: 0, tmpEntries: 0 } };
		r.engines.state.onRun = async (run, w, h) => { h.done({ exitCode: 0, how: 'exit', cwd: run.cwd, stats: by[run.script.split(' ')[0]] || {} }); };
		const keeper = r.rt.createSession();
		const plain = r.rt.createSession();
		await keeper.run('keeper');                  // the older one, and it holds a folder
		await r.clock.advance(1000);
		await plain.run('plain');
		await r.clock.advance(1000);
		await r.rt.createSession().run('plain');
		assert.deepStrictEqual(r.engines.workers.map((w) => w.terminated), [false, true, false], 'the newer, empty one was replaced');
		assert.deepStrictEqual((await keeper.run('keeper')).notes, [], 'its /tmp is there');
		r.rt.dispose();
	});

	await test('an agent\'s worker never remembers its /tmp, folders or not: the usual minute, and no note', async () => {
		const r = createRig();
		reports(r, () => ({ tmpFiles: 2, tmpEntries: 9 }));
		for (let i = 0; i < 2; i++) {
			const o = observe(r.rt.spawnAgent('x', { cwd: '/scratch' }), 3000);
			await o.closed;
			await r.clock.advance(60000);
			assert.strictEqual(r.engines.workers[r.engines.workers.length - 1].terminated, true);
			assert.ok(!/\/tmp was emptied/.test(o.stderr), o.stderr);
		}
		r.rt.dispose();
	});

	/* ===== completion =============================================================================== */

	await test('complete(command): what exists, by prefix, sorted, the engine\'s own list once it has started, builtins too', async () => {
		const r = createRig({ engines: { commands: ['cat', 'cp', 'curl-not-really', 'ls'] } });
		const s = r.rt.createSession();
		const before = await s.complete('command', 'c');
		assert.deepStrictEqual(before, PROGRAMS.concat(BUILTINS).filter((x, i, a) => a.indexOf(x) === i && x.startsWith('c')).sort());
		await s.run('x');
		assert.deepStrictEqual(await s.complete('command', 'c'), ['cat', 'cd', 'command', 'continue', 'cp', 'curl-not-really']);
		assert.deepStrictEqual(await s.complete('command', 'zzz'), []);
		assert.deepStrictEqual(await s.complete('command', './x'), [], 'a path is not a command name');
		const all = await s.complete('command', '');
		assert.deepStrictEqual(all, all.slice().sort());
		assert.ok(all.includes('ls') && all.includes('export'));
		r.rt.dispose();
	});

	await test('complete(path): the entries of the folder in the workspace, folders end with /, dotfiles only when asked for', async () => {
		const r = createRig();
		for (const f of ['src/app.js', 'src/apps/x.js', 'src/b.js', 'README.md', 'notes.txt', '.hidden', '.git/config']) { r.ws.put('/scratch/' + f, 'x'); }
		const s = r.rt.createSession();
		assert.deepStrictEqual(await s.complete('path', ''), ['README.md', 'notes.txt', 'src/']);
		assert.deepStrictEqual(await s.complete('path', 'src/ap'), ['src/app.js', 'src/apps/']);
		assert.deepStrictEqual(await s.complete('path', 's'), ['src/']);
		assert.deepStrictEqual(await s.complete('path', '.'), ['.git/', '.hidden']);
		assert.deepStrictEqual(await s.complete('path', 'src/'), ['src/app.js', 'src/apps/', 'src/b.js']);
		assert.deepStrictEqual(await s.complete('path', './src/b'), ['./src/b.js']);
		assert.deepStrictEqual(await s.complete('path', 'src/../R'), ['src/../README.md']);
		assert.deepStrictEqual(await s.complete('path', '/scratch/sr'), ['/scratch/src/']);
		assert.deepStrictEqual(await s.complete('path', 'nothing/'), []);
		assert.deepStrictEqual(await s.complete('path', '~/x'), []);
		r.ws.put('/scratch/~/inside.txt', 'x');
		assert.deepStrictEqual(await s.complete('path', '~/'), [], 'a name that starts with ~ is the shell\'s home, not a folder of that name');
		assert.deepStrictEqual(await s.complete('path', '../../../etc/'), [], 'above the mounts there is nothing of the workspace');
		r.rt.dispose();
	});

	await test('complete(path) relative to the session\'s own cwd, and at / the folders themselves', async () => {
		const r = createRig({ workspace: { folders: [{ name: 'scratch', uri: 'levelcode-scratch:///scratch' }, { name: 'proj', uri: 'file:///proj' }] } });
		r.ws.put('/scratch/sub/a.txt', 'x');
		r.ws.put('file:/proj/p.txt', 'x');
		const s = r.rt.createSession({ cwd: '/scratch/sub' });
		assert.deepStrictEqual(await s.complete('path', ''), ['a.txt']);
		assert.deepStrictEqual(await s.complete('path', '/'), ['/proj/', '/scratch/']);
		assert.deepStrictEqual(await s.complete('path', '/p'), ['/proj/']);
		assert.deepStrictEqual(await s.complete('path', '/proj/'), ['/proj/p.txt']);
		r.rt.dispose();
	});

	await test('complete(path) is bounded: 200 names, and 2 s', async () => {
		const r = createRig();
		for (let i = 0; i < 300; i++) { r.ws.put('/scratch/f' + String(i).padStart(3, '0'), ''); }
		const s = r.rt.createSession();
		const names = await s.complete('path', 'f');
		assert.strictEqual(names.length, 200);
		assert.deepStrictEqual(names, names.slice().sort());
		r.ws.hang('readDirectory', (k) => k.endsWith('/slowdir'));
		r.ws.mkdir('/scratch/slowdir');
		let result;
		const p = s.complete('path', 'slowdir/').then((v) => { result = v; });
		await r.clock.advance(1999);
		assert.strictEqual(result, undefined);
		await r.clock.advance(1);
		await p;
		assert.deepStrictEqual(result, []);
		r.rt.dispose();
	});

	await test('complete(path) never reaches outside the mounts and never throws', async () => {
		const r = createRig();
		r.ws.put('/etc/passwd', 'x');
		const s = r.rt.createSession();
		r.ws.clearRules();
		r.ws.fail('readDirectory', () => true, new Error('boom'));
		assert.deepStrictEqual(await s.complete('path', 'sr'), []);
		r.ws.clearRules();
		assert.deepStrictEqual(await s.complete('path', '/etc/'), []);
		assert.ok(!r.ws.calls.some((c) => c.includes('/etc')));
		assert.deepStrictEqual(await s.complete('path', undefined), ['README.md'].filter((x) => r.ws.exists('/scratch/' + x)));
		assert.deepStrictEqual(await s.complete('bogus', 'x'), []);
		r.rt.dispose();
	});

	finished = true;
	console.log(`\n${n} tests passed`);
})().catch((e) => { console.error(e); process.exit(1); });
