/*---------------------------------------------------------------------------------------------
 *  The agent's background run_command, EXECUTED — run: node test/agentRunCommand.test.js
 *
 *  The bug this locks down: runTool logged through a bare `dbg(...)`, but `dbg` was only ever declared
 *  inside runAgent — a different function. An out-of-scope name is not an error until the line runs,
 *  so nothing failed until a background command printed a local address:
 *
 *      entry.previewUrl = url;
 *      dbg('preview.detected', …);                  // ReferenceError: dbg is not defined
 *      Promise.resolve(ctx.openPreview(url))…       // never reached
 *
 *  The built-in browser therefore never opened when the agent started a dev server, and the exception
 *  escaped into the child's live stdout handler. Two more calls sat behind the same missing name: the
 *  `.catch` on that openPreview promise, and the `catch` of the fire-and-forget background launcher —
 *  where it turned a HANDLED start failure into an unhandled rejection.
 *
 *  Why this file runs the code when its neighbours (agentMaxSteps, agentNoWorkspace) assert from
 *  source: a name that is out of scope is invisible to a regex and to `node --check`, and this repo has
 *  no type-check gate — so only executing the line finds it. runTool is not exported, and going in
 *  through runAgent is the point anyway: it proves the logger the HOST passes is the one runTool ends
 *  up with. So the real runAgent → runTool → run_command → runCommand → onChunk chain runs here, with
 *  the three things it needs from outside replaced: `vscode` (as workspacePaths.test.js does), the
 *  provider (two scripted turns instead of a network call), and child_process.spawn (a fake child the
 *  test feeds stdout into — no process is ever started).
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const { EventEmitter } = require('events');

// ---- the outside world, replaced --------------------------------------------------------------

// vscode: one EMPTY workspace folder — no rules file and no .levelcode/mcp.json, so the run has nothing
// to load and no MCP server to start.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-run-'));
const vscodeMock = { workspace: { workspaceFolders: [{ uri: { fsPath: root }, name: 'app' }] } };

// child_process: spawn hands back a child the test drives by hand. Until it is asked to stop one,
// runCommand only LISTENS on a child (stdout/stderr 'data', then 'close' / 'error'), so three emitters
// are the whole surface.
const spawned = [];
function fakeSpawn() {
	const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter() });
	spawned.push(child);
	return child;
}
const childProcessMock = Object.assign({}, require('child_process'), { spawn: fakeSpawn });

const origLoad = Module._load;
// @ts-ignore — test-only loader shim
Module._load = function (request, parent, isMain) {
	if (request === 'vscode') { return vscodeMock; }
	if (request === 'child_process') { return childProcessMock; }
	return origLoad.call(this, request, parent, isMain);
};

// The provider: scripted turns instead of a network call. Patched on the module object agent.js shares,
// and BEFORE agent.js loads, so it holds however agent.js chooses to import it.
const providers = require('../providers/index');
let script = [];
providers.streamAgentTurn = async () => {
	const turn = script.shift();
	if (!turn) { throw new Error('the agent asked for a turn the script does not have'); }
	return turn;
};

const { runAgent } = require('../agent');

// ---- harness ----------------------------------------------------------------------------------

let n = 0;
async function testAsync(name, fn) { await fn(); n++; console.log('  ok - ' + name); }

// A rejection nobody handles is how two of the three call sites failed, and left alone it would kill
// this process with a stack and no test name. Collect them, so the test that caused one is the one
// that fails.
const unhandled = [];
process.on('unhandledRejection', (e) => { unhandled.push(e); });
/** One full turn of the event loop: long enough for a promise chain to settle AND for Node to have
 *  reported any rejection left unhandled. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

let seq = 0;
/**
 * Run one agent goal whose only action is a background `run_command`, to the end of the RUN. The
 * command does not end — that is what background means — so the returned `child` is still live, and
 * the test plays the dev server by emitting on `child.stdout`.
 */
async function startBackground(overrides) {
	const id = 'toolu_bg' + (++seq);
	const posted = [], logged = [];
	const before = spawned.length;
	script = [
		{ stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name: 'run_command', input: { command: 'npm run dev', background: true, explanation: 'Start the dev server' } }] },
		{ stop_reason: 'end_turn', content: [{ type: 'text', text: 'Done: the dev server is starting.' }] }
	];
	const ctx = Object.assign({
		messages: [{ role: 'user', content: 'start the dev server' }],
		maxSteps: 5,
		post: (m) => posted.push(m),
		dbg: (label, data) => logged.push({ label, data }),
		approve: async () => true,                 // manual mode asks before every command — say yes
		commandRuns: new Map(), commandStops: new Map(),
		signal: new AbortController().signal
	}, overrides);
	await runAgent(ctx);
	const end = posted.filter((m) => m.type === 'agentError' || m.type === 'agentDone');
	assert.deepStrictEqual(end.map((m) => m.reason || m.message), ['done'], 'the scripted run did not finish cleanly');
	assert.strictEqual(spawned.length, before + 1, 'run_command did not reach the fake spawn exactly once');
	return { id, logged, child: spawned[before] };
}

const LOCAL = 'http://localhost:5173/';
const BANNER = '  ➜  Local:   ' + LOCAL + '\n';   // the line Vite prints once it is serving

(async () => {
	try {
		// ---- 1. the reported bug: the preview must open ----------------------------------------------

		await testAsync('PREVIEW: a local address in background output opens the built-in browser', async () => {
			const opened = [];
			const run = await startBackground({ openPreview: async (url) => { opened.push(url); } });
			assert.deepStrictEqual(opened, [], 'nothing has been printed yet');

			// Emitted the way a real child does it: synchronously, from its stdout 'data' event. This is
			// the call that threw `dbg is not defined` — and it threw BEFORE openPreview was reached.
			assert.doesNotThrow(() => run.child.stdout.emit('data', Buffer.from(BANNER)),
				'the stdout handler of a live command threw');
			assert.deepStrictEqual(opened, [LOCAL], 'the address the server advertised never reached openPreview');

			// …and it is logged through the logger the RUN was given. runAgent hands its ctx to runTool, so
			// ctx.dbg is the one logger both share; a private no-op in runTool would pass the line above
			// and still leave `levelcode.ai.debug` blind to every preview.
			assert.deepStrictEqual(run.logged.filter((l) => l.label === 'preview.detected'),
				[{ label: 'preview.detected', data: { id: run.id, url: LOCAL } }]);
		});

		await testAsync('PREVIEW: a failed open is logged, not left as an unhandled rejection', async () => {
			// The second call site: the .catch on the openPreview promise. Its whole job is to keep a
			// preview failure away from a running command — but with `dbg` out of scope the handler itself
			// threw, so the rejection it existed to absorb came straight back as an unhandled one.
			const run = await startBackground({ openPreview: async () => { throw new Error('simple browser is disabled'); } });
			run.child.stdout.emit('data', Buffer.from(BANNER));
			await settle();
			assert.deepStrictEqual(unhandled, [], 'a rejected preview escaped as an unhandled rejection');
			assert.deepStrictEqual(run.logged.filter((l) => l.label === 'preview.rejected'),
				[{ label: 'preview.rejected', data: { id: run.id, error: 'simple browser is disabled' } }]);
		});

		// ---- 2. the same missing name, in the background launcher ------------------------------------

		await testAsync('BACKGROUND: a failed start is logged, not left as an unhandled rejection', async () => {
			// The third call site: the catch of the fire-and-forget launcher around runCommand. It is purely
			// defensive — runCommand resolves even when spawn itself throws — so the only way in is a failure
			// while the child is being wired up. A stop registry that throws is the smallest such failure.
			const run = await startBackground({ commandStops: { set() { throw new Error('stop registry unavailable'); } } });
			await settle();
			assert.deepStrictEqual(unhandled, [], 'the handler for a failed start threw, making a handled error an unhandled one');
			assert.deepStrictEqual(run.logged.filter((l) => l.label === 'bg.error'),
				[{ label: 'bg.error', data: { id: run.id, msg: 'stop registry unavailable' } }]);
		});

		// ---- 3. the logger is optional ---------------------------------------------------------------

		await testAsync('LOGGER: a host that passes no dbg still gets its preview', async () => {
			// runAgent already treats ctx.dbg as optional. runTool has to match, or putting the name in scope
			// only trades `dbg is not defined` for `dbg is not a function` in any host without a debug sink.
			const opened = [];
			const run = await startBackground({ dbg: undefined, openPreview: async (url) => { opened.push(url); } });
			assert.doesNotThrow(() => run.child.stdout.emit('data', Buffer.from(BANNER)));
			assert.deepStrictEqual(opened, [LOCAL]);
		});

		await settle();
		assert.deepStrictEqual(unhandled, [], 'an unhandled rejection surfaced after its test had passed');
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
	console.log('\nagentRunCommand: ' + n + ' tests passed.');
})().catch((e) => { console.error(e); process.exit(1); });
