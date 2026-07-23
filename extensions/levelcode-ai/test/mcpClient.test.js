/*---------------------------------------------------------------------------------------------
 *  Integration tests for extensions/levelcode-ai/mcpClient.js  —  run: node test/mcpClient.test.js
 *
 *  These spawn a REAL subprocess (test/fixtures/mock-mcp-server.js) and drive the real protocol, so
 *  the handshake, framing over a live pipe, timeouts and process teardown are actually exercised —
 *  not mocked. The directions that matter:
 *    • call() NEVER throws — a failing/hanging/unknown tool comes back as an `ERROR: ` string, because
 *      agent.js runs tools sequentially and one bad server must not break the turn loop.
 *    • a server may not drive us — a server→client sampling request is REFUSED.
 *    • nothing is orphaned — dispose()/reapMcp() actually kill the process.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

const assert = require('assert');
const path = require('path');
const C = require('../mcpClient');

const FIXTURE = path.join(__dirname, 'fixtures', 'mock-mcp-server.js');
const server = (extraArgs) => ({ name: 'mock', command: process.execPath, args: [FIXTURE].concat(extraArgs || []), source: 'settings', origin: 'test' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** True while the OS still knows this pid. */
function isRunning(pid) {
	try { process.kill(pid, 0); return true; } catch { return false; }
}

const tests = [];
function test(name, fn) { tests.push([name, fn]); }

// ---- happy path ------------------------------------------------------------------------------

test('connects, completes the handshake, and lists the server\'s tools', async () => {
	const h = await C.connect(server());
	try {
		assert.strictEqual(h.alive, true);
		assert.deepStrictEqual(h.tools.map((t) => t.name).sort(), ['boom', 'echo', 'hang']);
		assert.ok(h.tools[0].inputSchema, 'inputSchema must survive — it becomes the agent\'s input_schema');
		assert.deepStrictEqual(C.listActive().map((s) => s.name), ['mock']);
	} finally { h.dispose(); }
});

test('calls a tool and returns the flattened string', async () => {
	const h = await C.connect(server());
	try { assert.strictEqual(await h.call('echo', { text: 'hi' }), 'echo: hi'); }
	finally { h.dispose(); }
});

test('tolerates a server that logs non-JSON to stdout', async () => {
	const h = await C.connect(server(['--noise']));
	try {
		assert.strictEqual(h.alive, true);
		assert.strictEqual(await h.call('echo', { text: 'still works' }), 'echo: still works');
	} finally { h.dispose(); }
});

// ---- failures come back as ERROR strings, never throws ----------------------------------------

test('a tool that reports isError returns an ERROR: string (does not throw)', async () => {
	const h = await C.connect(server());
	try {
		const out = await h.call('boom', {});
		assert.ok(out.startsWith('ERROR: '), out);
		assert.ok(out.includes('it broke'));
	} finally { h.dispose(); }
});

test('a hanging tool times out into an ERROR: string rather than wedging the loop', async () => {
	const h = await C.connect(server());
	try {
		const started = Date.now();
		const out = await h.call('hang', {}, { timeoutMs: 300 });
		assert.ok(out.startsWith('ERROR: '), out);
		assert.ok(/timed out/.test(out), out);
		assert.ok(Date.now() - started < 3000, 'must return promptly, not hang');
	} finally { h.dispose(); }
});

test('an unknown tool returns an ERROR: string from the server\'s JSON-RPC error', async () => {
	const h = await C.connect(server());
	try {
		const out = await h.call('does_not_exist', {});
		assert.ok(out.startsWith('ERROR: '), out);
	} finally { h.dispose(); }
});

test('calling after dispose returns an ERROR: string, not a crash', async () => {
	const h = await C.connect(server());
	h.dispose();
	const out = await h.call('echo', { text: 'x' });
	assert.ok(out.startsWith('ERROR: '), out);
});

// ---- the server may not drive us --------------------------------------------------------------

test('a server→client sampling request is REFUSED (a server cannot drive our model)', async () => {
	const h = await C.connect(server(['--sample']));
	try {
		await sleep(300);   // let the refusal round-trip; the fixture logs it to stderr
		assert.ok(/REFUSED/.test(h.stderrTail()), 'expected the server to see a refusal, got: ' + h.stderrTail());
		assert.ok(/sampling\/createMessage/.test(h.stderrTail()));
	} finally { h.dispose(); }
});

// ---- startup failures -------------------------------------------------------------------------

test('a server that dies during the handshake rejects connect() and surfaces its stderr', async () => {
	await assert.rejects(
		() => C.connect(server(['--crash']), { connectTimeoutMs: 4000 }),
		(e) => /failed to start/.test(e.message) && /crashing on purpose|exited/.test(e.message)
	);
	assert.deepStrictEqual(C.listActive(), [], 'a failed server must not linger in the registry');
});

test('a command that does not exist rejects connect() with a readable reason', async () => {
	await assert.rejects(
		() => C.connect({ name: 'nope', command: 'levelcode-no-such-binary-xyz', args: [] }, { connectTimeoutMs: 4000 }),
		(e) => /nope/.test(e.message)
	);
});

// ---- lifecycle: nothing orphaned ---------------------------------------------------------------

test('dispose() actually kills the process and clears the registry', async () => {
	const h = await C.connect(server());
	const pid = h.pid;
	assert.ok(isRunning(pid), 'fixture should be running');
	h.dispose();
	assert.strictEqual(h.alive, false);
	assert.deepStrictEqual(C.listActive(), []);
	for (let i = 0; i < 40 && isRunning(pid); i++) { await sleep(100); }   // SIGTERM → SIGKILL grace
	assert.ok(!isRunning(pid), 'process ' + pid + ' survived dispose() — that is an orphan');
});

test('reapMcp() kills every server (New Chat / deactivate path)', async () => {
	const a = await C.connect(server());
	const pid = a.pid;
	assert.strictEqual(C.listActive().length, 1);
	C.reapMcp();
	assert.deepStrictEqual(C.listActive(), []);
	for (let i = 0; i < 40 && isRunning(pid); i++) { await sleep(100); }
	assert.ok(!isRunning(pid), 'reapMcp left an orphan');
});

test('connectAll tolerates a broken server without denying the good one', async () => {
	const { handles, problems } = await C.connectAll(
		[server(), { name: 'broken', command: 'levelcode-no-such-binary-xyz', args: [] }],
		{ connectTimeoutMs: 4000 }
	);
	try {
		assert.strictEqual(handles.length, 1);
		assert.strictEqual(handles[0].name, 'mock');
		assert.strictEqual(problems.length, 1);
		assert.strictEqual(problems[0].server, 'broken');
	} finally { C.reapMcp(); }
});

// ---- runner ------------------------------------------------------------------------------------

(async () => {
	let n = 0;
	try {
		for (const [name, fn] of tests) { await fn(); n++; console.log('  ok - ' + name); }
	} catch (e) {
		console.error('\n  FAILED: ' + ((e && e.stack) || e));
		C.reapMcp();
		process.exit(1);
	}
	C.reapMcp();
	console.log('\nmcpClient.js: ' + n + ' tests passed.');
	process.exit(0);
})();
