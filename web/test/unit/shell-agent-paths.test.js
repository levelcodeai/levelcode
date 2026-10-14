/*---------------------------------------------------------------------------------------------
 *  The agent's run_command over the REAL LevelCode Shell runtime — run: node web/test/unit/shell-agent-paths.test.js
 *
 *  agent.js (extensions/levelcode-ai) has always named workspace files by `Uri.fsPath`. The shell
 *  (web/shell/src/runtime.js) mounts each folder at its URI path and refuses a working directory that is not inside
 *  one. On a Mac or Linux the two are the same string. In a browser on Windows they are not: VS Code takes the
 *  platform from the user agent (src/vs/base/common/platform.ts), and `uriToFsPath` (src/vs/base/common/uri.ts) turns
 *  every `/` into `\` for any scheme — `file:///proj`, a folder opened from the computer, has the fsPath `\proj`. The
 *  shell was handed that, and every command answered "the working directory \proj is not inside a workspace folder".
 *
 *  So this runs the real thing end to end — runAgent → run_command → runCommand → host.spawn → the runtime's
 *  spawnAgent → a fake engine (web/test/helpers/shell-runtime-fakes.js) and back through agent.js's commit hook —
 *  with the folders' fsPath computed as VS Code computes it on Windows. A scripted provider stands in for the model.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

// A promise that never settles ends the process with status 0 and no output: a suite that did not finish fails.
let finished = false;
process.on('exit', (code) => { if (!finished && code === 0) { console.error('not ok - the tests did not finish'); process.exitCode = 1; } });

const assert = require('assert');
const path = require('path');
const Module = require('module');

const { createRig, flush, Uri } = require(path.join(__dirname, '..', 'helpers', 'shell-runtime-fakes.js'));
const { planMounts, toMountPath } = require(path.join(__dirname, '..', '..', 'shell', 'src', 'runtime.js'));

const AI = path.join(__dirname, '..', '..', '..', 'extensions', 'levelcode-ai');
const te = new TextEncoder();

/** The `vscode` agent.js and host.js are given: the rig's workspace, and the few members they read besides. */
const vscodeMock = /** @type {any} */ ({});
const origLoad = Module._load;
// @ts-ignore — test-only loader shim
Module._load = function (request, parent, isMain) {
	if (request === 'vscode') { return vscodeMock; }
	return origLoad.call(this, request, parent, isMain);
};
const providers = require(path.join(AI, 'providers', 'index'));
/** @type {any[]} */ let script = [];
/** @type {any[]} */ const turns = [];
providers.streamAgentTurn = async (/** @type {any} */ o) => { turns.push({ messages: JSON.parse(JSON.stringify(o.messages)) }); const t = script.shift(); if (!t) { throw new Error('script exhausted'); } return t; };

/**
 * Uri.fsPath as VS Code computes it in a browser on Windows: uri.ts uriToFsPath with isWindows true.
 * @param {any} u
 */
function windowsFsPath(u) {
	let v;
	if (u.authority && u.path.length > 1 && u.scheme === 'file') { v = '//' + u.authority + u.path; }
	else if (/^\/[A-Za-z]:/.test(u.path)) { v = u.path[1].toLowerCase() + u.path.slice(2); }
	else { v = u.path; }
	return v.replace(/\//g, '\\');
}

/**
 * A workspace in a browser on Windows, the shell runtime over it, and agent.js + host.js loaded fresh against it,
 * with the runtime registered as the shell exactly as web/shell/src/extension.js exports it.
 * @param {Array<{ name: string, uri: string }>} folders
 */
function setup(folders) {
	const rig = createRig({ workspace: { folders } });
	for (const f of rig.ws.vscode.workspace.workspaceFolders) { Object.defineProperty(f.uri, 'fsPath', { get() { return windowsFsPath(this); } }); }
	const ws = rig.ws.vscode.workspace;
	ws.findFiles = async () => [];
	ws.asRelativePath = (/** @type {any} */ u) => String(u.path || u);
	ws.textDocuments = [];
	for (const k of Object.keys(vscodeMock)) { delete vscodeMock[k]; }
	Object.assign(vscodeMock, {
		Uri: { file: (/** @type {string} */ p) => new Uri('file', '', p), parse: Uri.parse },
		FileType: rig.ws.vscode.FileType,
		workspace: ws,
		env: { appRoot: '' },
		extensions: { getExtension: () => undefined },
	});
	for (const k of Object.keys(require.cache)) { if (k.startsWith(AI + path.sep) && !k.includes(path.sep + 'providers' + path.sep)) { delete require.cache[k]; } }
	/** @type {any} */ (globalThis).__LEVELCODE_BROWSER_HOST__ = true;
	const agent = require(path.join(AI, 'agent'));
	const host = require(path.join(AI, 'host'));
	host.registerShell({ info: rig.rt.info, spawn: (/** @type {string} */ c, /** @type {any} */ o) => rig.rt.spawnAgent(c, o), forDisplay: (/** @type {string} */ t) => t });
	/** @type {any[]} */ const runs = [];
	/** @type {any[]} */ const starts = [];
	rig.rt.onAgentRun((e) => { if (e.type === 'start') { starts.push(e); } });
	return { rig, agent, host, runs, starts };
}

const tool = (/** @type {string} */ id, /** @type {string} */ name, /** @type {any} */ input) => ({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name, input }] });
const say = (/** @type {string} */ text) => ({ stop_reason: 'end_turn', content: [{ type: 'text', text }] });
const resultFor = (/** @type {string} */ id) => { for (const t of turns) { for (const m of t.messages) { if (m.role === 'user' && Array.isArray(m.content)) { const r = m.content.find((/** @type {any} */ c) => c.tool_use_id === id); if (r) { return r.content; } } } } return null; };
/** @param {any} [over] */
function ctxFor(over) {
	/** @type {any[]} */ const posted = [];
	return Object.assign({
		messages: [{ role: 'user', content: 'go' }], maxSteps: 6, post: (/** @type {any} */ m) => posted.push(m), dbg: () => {},
		approve: async () => true, commandRuns: new Map(), commandStops: new Map(), signal: new AbortController().signal, posted,
	}, over);
}

let n = 0;
async function test(/** @type {string} */ name, /** @type {() => Promise<void>} */ fn) { turns.length = 0; await fn(); n++; console.log('  ok - ' + name); }

(async () => {
	try {
		await test('a browser on Windows: run_command runs in the folder — the shell is handed /proj, not \\proj — and its output comes back', async () => {
			const { rig, agent, runs, starts } = setup([{ name: 'proj', uri: 'file:///proj' }]);
			assert.strictEqual(rig.ws.vscode.workspace.workspaceFolders[0].uri.fsPath, '\\proj', 'the premise: the folder\'s fsPath has a backslash');
			rig.engines.state.onRun = async (run, w, h) => { runs.push(run); h.out(run.id, 'stdout', 'hi\n'); await flush(); h.done({ exitCode: 0 }); };
			script = [tool('t1', 'run_command', { command: 'echo hi', explanation: 'x' }), say('Done: x')];
			await agent.runAgent(ctxFor({}));
			assert.strictEqual(resultFor('t1'), 'hi\n');
			assert.strictEqual(runs.length, 1);
			assert.strictEqual(runs[0].cwd, '/proj');
			// The mirror tab hears the same folder, in the terms it resolves a line's links in (terminal/index.js cwdsOf).
			assert.strictEqual(starts[0].cwd, '/proj');
			assert.strictEqual(toMountPath(planMounts(rig.rt.folders()), starts[0].cwd), '/proj');
			rig.rt.dispose();
		});

		await test('a browser on Windows: the folder run_command picks by name is the one it runs in', async () => {
			const { rig, agent, runs } = setup([{ name: 'proj', uri: 'file:///proj' }, { name: 'lib', uri: 'file:///lib' }]);
			rig.engines.state.onRun = async (run, w, h) => { runs.push(run); h.done({ exitCode: 0 }); };
			script = [tool('t1', 'run_command', { command: 'ls', folder: 'lib', explanation: 'x' }), say('Done: x')];
			await agent.runAgent(ctxFor({}));
			assert.strictEqual(runs.length, 1, String(resultFor('t1')));
			assert.strictEqual(runs[0].cwd, '/lib');
			rig.rt.dispose();
		});

		await test('a browser on Windows: what the command changed comes back to the review by folder, read from the right file, and is verified', async () => {
			const { rig, agent, runs } = setup([{ name: 'proj', uri: 'file:///proj' }]);
			rig.ws.put('/proj/old.txt', 'a\n');
			rig.engines.state.onRun = async (run, w, h) => {
				runs.push(run);
				h.done({ exitCode: 0, changes: [
					{ kind: 'write', path: '/proj/old.txt', existed: true, before: te.encode('a\n'), after: te.encode('b\n') },
					{ kind: 'write', path: '/proj/new.txt', existed: false, before: null, after: te.encode('hi\n') },
				] });
			};
			/** @type {any[]} */ const edits = [];
			const ctx = ctxFor({ applyEdit: async (/** @type {any} */ r) => { edits.push(r); return true; }, applyDelete: async () => true, touched: new Set() });
			script = [tool('t1', 'run_command', { command: 'make', explanation: 'x' }), say('Done: x')];
			await agent.runAgent(ctx);
			// old.txt is compared with what is on disk now (read through host.uriFor): a path the folders do not contain
			// would have been "changed while the command ran", or "outside the workspace folders".
			assert.deepStrictEqual(edits, [{ path: 'new.txt', exists: false, proposed: 'hi\n' }, { path: 'old.txt', exists: true, proposed: 'b\n' }], String(resultFor('t1')));
			assert.match(String(resultFor('t1')), /2 files changed, ready for Keep\/Undo/);
			assert.deepStrictEqual([...ctx.touched].sort(), ['/proj/new.txt', '/proj/old.txt'], 'what the verify step looks at, as host.uriFor maps it');
			rig.rt.dispose();
		});

		await test('a browser on Windows: the verify command runs in the folder too', async () => {
			const { rig, agent, runs } = setup([{ name: 'proj', uri: 'file:///proj' }]);
			rig.engines.state.onRun = async (run, w, h) => {
				runs.push(run);
				if (run.script === 'make') { h.done({ exitCode: 0, changes: [{ kind: 'write', path: '/proj/new.txt', existed: false, before: null, after: te.encode('hi\n') }] }); }
				else { h.done({ exitCode: 0 }); }
			};
			const ctx = ctxFor({
				applyEdit: async () => true, applyDelete: async () => true, touched: new Set(),
				verify: { enabled: true, command: 'grep -q hi new.txt', maxRounds: 1, includeWarnings: false },
				getNewDiagnostics: async () => ({ text: '', count: 0 }), getTouchedUris: () => [],
			});
			script = [tool('t1', 'run_command', { command: 'make', explanation: 'x' }), say('Done: x')];
			await agent.runAgent(ctx);
			assert.deepStrictEqual(runs.map((r) => r.script + ' @ ' + r.cwd), ['make @ /proj', 'grep -q hi new.txt @ /proj']);
			assert.ok(ctx.posted.some((/** @type {any} */ m) => m.type === 'verifyDone' && m.ok === true && m.hadCommand === true));
			rig.rt.dispose();
		});

		console.log('\nshell-agent-paths: ' + n + ' tests passed.');
		finished = true;
	} finally {
		Module._load = origLoad;
		delete (/** @type {any} */ (globalThis)).__LEVELCODE_BROWSER_HOST__;
	}
})().catch((e) => { console.error(e); process.exit(1); });
