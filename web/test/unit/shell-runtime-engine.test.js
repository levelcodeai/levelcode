/*---------------------------------------------------------------------------------------------
 *  The runtime against the REAL engine core - run: node web/test/unit/shell-runtime-engine.test.js
 *
 *  The other suites speak README section 4 to a fake engine that was written from the same text as the runtime,
 *  so they can agree with each other and both be wrong. This one wires web/shell/src/runtime.js to the engine's
 *  own protocol handler (engine/core.js createCore over the patched just-bash) through structured clone, the way
 *  a Worker would carry the messages, and runs real scripts over the Map-backed workspace:
 *
 *    - what a script prints and exits with arrives, and a file it wrote is on the workspace afterwards;
 *    - what it reads is read through the host's guards (outside the folders is not there);
 *    - cwd and env carry from one line to the next, /tmp and aliases too for a terminal, and not for the agent;
 *    - a limit applies nothing (Stop is not here: the engine runs on THIS thread, and what Stop needs is a thread
 *      that is not the host's - the Worker - so it is tested with the fake engine);
 *    - the agent's review is handed the engine's real change set.
 *
 *  Not run when the engine is not in the tree. Only what the engine core exports is used, nothing of its files.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

// A promise that never settles ends the process with status 0 and no output: a suite that did not finish fails.
let finished = false;
process.on('exit', (code) => { if (!finished && code === 0) { console.error('not ok - the tests did not finish'); process.exitCode = 1; } });

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const { createRig } = require(path.join(__dirname, '..', 'helpers', 'shell-runtime-fakes.js'));
const { observe } = require(path.join(__dirname, '..', 'helpers', 'shell-conformance.js'));
const { createRuntime } = require(path.join(__dirname, '..', '..', 'shell', 'src', 'runtime.js'));

const ENGINE_DIR = path.join(__dirname, '..', '..', 'shell', 'engine');

let n = 0;
async function test(/** @type {string} */ name, /** @type {() => Promise<void>} */ fn) { await fn(); n++; console.log('  ok - ' + name); }

(async () => {
	if (!fs.existsSync(path.join(ENGINE_DIR, 'load.mjs')) || !fs.existsSync(path.join(ENGINE_DIR, 'core.js'))) {
		finished = true;
		console.log('  skipped - the engine is not in this tree\n\n0 tests passed');
		return;
	}
	const { loadEngine } = await import(pathToFileURL(path.join(ENGINE_DIR, 'load.mjs')).href);
	const { createCore } = require(path.join(ENGINE_DIR, 'core.js'));
	const Engine = await loadEngine();

	/** A runtime whose workers are the engine's protocol handler on this thread, with messages cloned each way. */
	function setup(/** @type {any} */ o) {
		const r = createRig(o);
		/** @type {any[]} */ const workers = [];
		const createWorker = () => {
			/** @type {any} */
			const w = {
				onmessage: null, onerror: null, terminated: false, sent: [],
				postMessage(/** @type {any} */ m) { if (w.terminated) { return; } w.sent.push(m); const c = structuredClone(m); Promise.resolve().then(() => core.handle(c)); },
				terminate() { w.terminated = true; },
			};
			const core = createCore({
				Engine, now: Date.now,
				post: (/** @type {any} */ msg) => { const c = structuredClone(msg); Promise.resolve().then(() => { if (!w.terminated && typeof w.onmessage === 'function') { w.onmessage({ data: c }); } }); },
			});
			workers.push(w);
			return w;
		};
		const rt = createRuntime({
			vscode: r.ws.vscode, loadEngineSource: async () => 'unused: the worker is in this thread', createWorker,
			now: Date.now, setTimeout, clearTimeout, limits: o && o.limits,
		});
		return { rt, ws: r.ws, workers };
	}
	/** @param {any} s @param {string} script */
	async function line(s, script) {
		const out = [], err = [];
		const r = await s.run(script, { onStdout: (/** @type {string} */ t) => out.push(t), onStderr: (/** @type {string} */ t) => err.push(t) });
		return Object.assign({}, r, { out: out.join(''), err: err.join('') });
	}

	await test('output, status and a file the script wrote: through the protocol and onto the workspace', async () => {
		const x = setup();
		x.ws.put('/scratch/a.txt', 'hello\nworld\n');
		const s = x.rt.createSession();
		let r = await line(s, 'echo hi');
		assert.deepStrictEqual({ out: r.out, exit: r.exitCode, how: r.how, applied: r.applied }, { out: 'hi\n', exit: 0, how: 'exit', applied: 0 });
		r = await line(s, 'cat a.txt | wc -l');
		assert.strictEqual(r.out.trim(), '2');
		r = await line(s, 'echo new > b.txt; ls');
		assert.deepStrictEqual({ out: r.out, applied: r.applied }, { out: 'a.txt\nb.txt\n', applied: 1 });
		assert.strictEqual(x.ws.text('/scratch/b.txt'), 'new\n');
		r = await line(s, 'sed -i s/hello/HELLO/ a.txt && rm b.txt');
		assert.strictEqual(r.applied, 2);
		assert.strictEqual(x.ws.text('/scratch/a.txt'), 'HELLO\nworld\n');
		assert.strictEqual(x.ws.exists('/scratch/b.txt'), false);
		x.rt.dispose();
	});

	await test('what is outside the folders is not there, and a write there is refused and fails the command', async () => {
		const x = setup();
		x.ws.put('/etc/passwd', 'root:x:0:0');
		const s = x.rt.createSession();
		let r = await line(s, 'cat /etc/passwd');
		assert.ok(r.exitCode !== 0 && /No such file or directory/.test(r.err), JSON.stringify(r));
		assert.ok(!x.ws.calls.some((c) => c.includes('/etc')), 'the host was never asked: ' + x.ws.calls.join(','));
		r = await line(s, 'echo owned > /etc/passwd');
		assert.strictEqual(r.exitCode, 1, 'a refused write fails the command: ' + JSON.stringify(r));
		assert.ok(/Permission denied/.test(r.err), r.err);
		r = await line(s, 'echo owned > /etc/passwd; echo after');
		assert.deepStrictEqual({ out: r.out, applied: r.applied }, { out: 'after\n', applied: 0 }, 'bash goes on, as it does: the status is the last command\'s');
		assert.strictEqual(x.ws.text('/etc/passwd'), 'root:x:0:0');
		x.rt.dispose();
	});

	await test('cwd and env carry between lines; a terminal keeps /tmp and its aliases, the agent starts from nothing', async () => {
		const x = setup();
		const s = x.rt.createSession();
		await line(s, 'mkdir -p d/e && cd d/e && export KEPT=yes');
		assert.strictEqual(s.cwd, '/scratch/d/e');
		let r = await line(s, 'pwd; echo $KEPT');
		assert.strictEqual(r.out, '/scratch/d/e\nyes\n');
		await line(s, 'echo x > /tmp/t; alias ll="ls -a"');
		r = await line(s, 'cat /tmp/t; ll');
		assert.strictEqual(r.exitCode, 0, 'the alias made on the line before is there: ' + r.err);
		assert.ok(r.out.startsWith('x\n'), r.out);

		// the agent: a fresh shell each time
		const folders = [{ name: 'scratch', root: '/scratch', uri: 'levelcode-scratch:///scratch' }];
		const a1 = observe(x.rt.spawnAgent('echo agent > /tmp/a; export Z=1', { cwd: '/scratch', folders }), 5000);
		await a1.closed;
		const a2 = observe(x.rt.spawnAgent('cat /tmp/a; echo "[$Z]"; pwd', { cwd: '/scratch', folders }), 5000);
		await a2.closed;
		assert.strictEqual(a2.stdout, '[]\n/scratch\n');
		assert.ok(/No such file or directory/.test(a2.stderr), a2.stderr);
		x.rt.dispose();
	});

	await test('a limit is how \'limit\' with status 126 and applies nothing, even what the script had written before it', async () => {
		const x = setup();
		const s = x.rt.createSession();
		const r = await line(s, 'echo kept-out > f.txt; while true; do :; done');
		assert.deepStrictEqual({ how: r.how, exit: r.exitCode, applied: r.applied }, { how: 'limit', exit: 126, applied: 0 });
		assert.strictEqual(x.ws.exists('/scratch/f.txt'), false);
		assert.ok(/limit of this shell/.test(r.err), r.err);
		assert.ok(/NOT applied/.test(r.notes.join('')) || r.notes.length > 0, JSON.stringify(r.notes));
		x.rt.dispose();
	});

	await test('the agent\'s review is handed the engine\'s real change set, in the agent\'s paths', async () => {
		const x = setup();
		x.ws.put('/scratch/old.txt', 'one\n');
		/** @type {any[]} */ let seen = [];
		const folders = [{ name: 'scratch', root: '/scratch', uri: 'levelcode-scratch:///scratch' }];
		const o = observe(x.rt.spawnAgent('sed -i s/one/two/ old.txt; echo n > new.txt; mkdir sub; rm -f nothing', {
			cwd: '/scratch', folders,
			commit: async (/** @type {any[]} */ changes) => { seen = changes; return { rest: changes.filter((c) => c.kind === 'mkdir'), notes: ['[LevelCode Shell: reviewed]'], failed: 0 }; },
		}), 5000);
		await o.closed;
		const brief = seen.map((c) => c.kind + ' ' + c.path + (c.kind === 'write' ? ' existed=' + c.existed + ' ' + JSON.stringify(Buffer.from(c.after).toString()) + ' was=' + JSON.stringify(c.before && Buffer.from(c.before).toString()) : '')).sort();
		assert.deepStrictEqual(brief, [
			'mkdir /scratch/sub',
			'write /scratch/new.txt existed=false "n\\n" was=null',
			'write /scratch/old.txt existed=true "two\\n" was="one\\n"',
		]);
		assert.strictEqual(x.ws.isDir('/scratch/sub'), true, 'the folder the review left is made by the shell');
		assert.strictEqual(x.ws.text('/scratch/old.txt'), 'one\n', 'a reviewed file is the review\'s to write');
		assert.ok(o.stderr.includes('[LevelCode Shell: reviewed]'));
		x.rt.dispose();
	});

	await test('a folder the engine would put somewhere else works from the host\'s side too', async () => {
		const x = setup({ workspace: { folders: [{ name: 'home', uri: 'file:///home' }] } });
		x.ws.put('file:/home/a.txt', 'A');
		const s = x.rt.createSession({ cwd: '/home' });
		const r = await line(s, 'pwd; cat a.txt; echo B > b.txt');
		assert.strictEqual(r.out, '/mnt/home\nA');
		assert.strictEqual(r.applied, 1);
		assert.strictEqual(x.ws.text('file:/home/b.txt'), 'B\n');
		assert.ok(/mounted at \/mnt\/home, not at \/home/.test(r.notes.join('')), JSON.stringify(r.notes));
		x.rt.dispose();
	});

	await test('a folder at /mnt and the root of a file system together: the engine takes the layout (they were a hang of the host)', async () => {
		const x = setup({ workspace: { folders: [{ name: 'mnt', uri: 'file:///mnt' }, { name: 'root', uri: 'file:///' }] } });
		x.ws.put('file:/mnt/m.txt', 'M');
		x.ws.put('file:/etc/hostname', 'host');
		const s = x.rt.createSession({ cwd: '/etc' });
		assert.strictEqual(s.cwd, '/lc-mnt/root/etc');
		const r = await line(s, 'pwd; cat /mnt/m.txt; cat hostname; echo new > /lc-mnt/root/made.txt');
		assert.strictEqual(r.out, '/lc-mnt/root/etc\nMhost');
		assert.strictEqual(r.applied, 1);
		assert.strictEqual(x.ws.text('file:/made.txt'), 'new\n');
		assert.ok(/mounted at \/lc-mnt\/root, not at \//.test(r.notes.join('')), JSON.stringify(r.notes));
		x.rt.dispose();
	});

	await test('non-ASCII text and file names survive the round trip', async () => {
		const x = setup();
		x.ws.put('/scratch/caf\u{E9}.txt', 'cr\u{E8}me \u{65E5}\u{672C}\n');
		const s = x.rt.createSession();
		const r = await line(s, 'cat caf\u{E9}.txt; echo "\u{2713} done" > \u{65E5}.txt');
		assert.strictEqual(r.out, 'cr\u{E8}me \u{65E5}\u{672C}\n');
		assert.strictEqual(x.ws.text('/scratch/\u{65E5}.txt'), '\u{2713} done\n');
		x.rt.dispose();
	});

	await test('the engine\'s own program list is what info reports after the first run, and Tab completes from it', async () => {
		const x = setup();
		const s = x.rt.createSession();
		await line(s, 'true');
		const names = x.rt.info.commands;
		assert.ok(names.length > 60 && names.includes('grep') && names.includes('realpath'), names.join(' '));
		assert.ok(!names.includes('git') && !names.includes('node'));
		assert.deepStrictEqual(await s.complete('command', 'gre'), ['grep']);
		x.rt.dispose();
	});

	await test('a folder that ignores case (macOS, Windows): in the terminal a case-only rename of a file or a folder is refused whole and nothing moves; one spelling, and the rename in two commands, work as that disk does them', async () => {
		const x = setup({ workspace: { ignoreCase: true } });
		x.ws.put('/scratch/a.txt', 'keep me\n');
		x.ws.put('/scratch/d/f.txt', 'f\n');
		const s = x.rt.createSession();
		// the file: it was deleted
		let r = await line(s, 'mv a.txt A.txt');
		assert.deepStrictEqual({ how: r.how, exit: r.exitCode, applied: r.applied }, { how: 'exit', exit: 1, applied: 0 });
		assert.deepStrictEqual(x.ws.list('/scratch'), ['a.txt', 'd']);
		assert.strictEqual(x.ws.text('/scratch/a.txt'), 'keep me\n');
		assert.ok(/None of its file changes were applied: \/scratch\/A\.txt and \/scratch\/a\.txt are one name here/.test(r.notes.join('\n')), r.notes.join('\n'));
		assert.ok(!x.ws.calls.some((c) => /^(delete|writeFile|createDirectory) /.test(c)), x.ws.calls.join('\n'));
		// the folder: the engine sees D as there and moves d INTO it; that was applied 3 of 4, as d/d/f.txt
		r = await line(s, 'mv d D');
		assert.deepStrictEqual({ exit: r.exitCode, applied: r.applied }, { exit: 1, applied: 0 });
		assert.deepStrictEqual([x.ws.list('/scratch'), x.ws.list('/scratch/d')], [['a.txt', 'd'], ['f.txt']]);
		assert.ok(/\/scratch\/D and \/scratch\/d are one name here/.test(r.notes.join('\n')), r.notes.join('\n'));
		// one spelling of an entry is what that disk does with it: the write lands in a.txt, whose name stays
		r = await line(s, 'echo new > A.txt');
		assert.deepStrictEqual({ exit: r.exitCode, applied: r.applied }, { exit: 0, applied: 1 });
		assert.deepStrictEqual(x.ws.list('/scratch'), ['a.txt', 'd']);
		assert.strictEqual(x.ws.text('/scratch/a.txt'), 'new\n');
		// what the note advises: two commands
		r = await line(s, 'mv a.txt t.txt');
		assert.deepStrictEqual({ exit: r.exitCode, applied: r.applied }, { exit: 0, applied: 2 });
		r = await line(s, 'mv t.txt A.txt');
		assert.deepStrictEqual({ exit: r.exitCode, applied: r.applied }, { exit: 0, applied: 2 });
		assert.deepStrictEqual(x.ws.list('/scratch'), ['A.txt', 'd']);
		assert.strictEqual(x.ws.text('/scratch/A.txt'), 'new\n');
		x.rt.dispose();
	});

	await test('a folder that ignores case: an agent\'s mv a.txt A.txt never reaches the review as a deletion; the status is 1 and the model is told why', async () => {
		const x = setup({ workspace: { ignoreCase: true } });
		x.ws.put('/scratch/a.txt', 'keep me\n');
		/** @type {string[][]} */ const asked = [];
		const folders = [{ name: 'scratch', root: '/scratch', uri: 'levelcode-scratch:///scratch' }];
		const o = observe(x.rt.spawnAgent('mv a.txt A.txt', {
			cwd: '/scratch', folders,
			commit: async (/** @type {any[]} */ changes) => { asked.push(changes.map((c) => c.kind + ' ' + c.path)); return { rest: [], notes: [], failed: 0 }; },
		}), 5000);
		await o.closed;
		assert.deepStrictEqual(asked, [], 'the review is given nothing to apply');
		assert.strictEqual(/** @type {any} */ (o.events.find((e) => e.type === 'close')).code, 1);
		assert.ok(/None of its file changes were applied: \/scratch\/A\.txt and \/scratch\/a\.txt are one name here/.test(o.stderr), o.stderr);
		assert.deepStrictEqual(x.ws.list('/scratch'), ['a.txt']);
		x.rt.dispose();
	});

	finished = true;
	console.log(`\n${n} tests passed`);
})().catch((e) => { console.error(e); process.exit(1); });
