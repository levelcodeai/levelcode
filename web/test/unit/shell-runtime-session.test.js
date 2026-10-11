/*---------------------------------------------------------------------------------------------
 *  web/shell/src/runtime.js, Session - run: node web/test/unit/shell-runtime-session.test.js
 *
 *  README section 3b: what the terminal consumes. A session keeps what must survive a worker's death (cwd,
 *  env), runs one script at a time, stops with Ctrl+C, and completes for Tab from the workspace itself.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

// A promise that never settles ends the process with status 0 and no output: a suite that did not finish fails.
let finished = false;
process.on('exit', (code) => { if (!finished && code === 0) { console.error('not ok - the tests did not finish'); process.exitCode = 1; } });

const assert = require('assert');
const path = require('path');

const { createRig, flush } = require(path.join(__dirname, '..', 'helpers', 'shell-runtime-fakes.js'));
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
		await s.run('c', { cols: 'wide' });
		await s.run('d', { cols: 80.7 });
		await s.run('e');
		assert.deepStrictEqual(cols, ['120', undefined, undefined, '80', undefined]);
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
