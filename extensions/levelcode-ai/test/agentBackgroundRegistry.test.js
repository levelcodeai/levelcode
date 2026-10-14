/*---------------------------------------------------------------------------------------------
 *  A background command's registry keeps up with the command — run: node test/agentBackgroundRegistry.test.js
 *
 *  The bug this locks down: the registry that read_command_output serves (its output ring, byte count, the
 *  port and readiness sniffers, the preview trigger) was fed from inside the callback that draws the live
 *  card — and runCommand stops calling that callback once the CARD is full (100 000 characters). So a dev
 *  server that logged 100 KB before it printed "listening on :4000" was never seen to be listening: port
 *  null, ready false, the byte count frozen, and the ring ending in the card's own "[output truncated in
 *  view]". The model polled a command that looked stuck for ever.
 *
 *  The registry now sees every chunk; the live card is capped exactly as before.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const { EventEmitter } = require('events');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-registry-'));
const vscodeMock = { workspace: { workspaceFolders: [{ uri: { fsPath: root }, name: 'app' }] } };
let child;
const childProcessMock = Object.assign({}, require('child_process'), {
	spawn() { child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), kill() { return true; } }); return child; },
});
const origLoad = Module._load;
// @ts-ignore
Module._load = function (request, parent, isMain) {
	if (request === 'vscode') { return vscodeMock; }
	if (request === 'child_process') { return childProcessMock; }
	return origLoad.call(this, request, parent, isMain);
};
const providers = require('../providers/index');
let script = [];
const seen = [];
providers.streamAgentTurn = async (o) => { seen.push(JSON.parse(JSON.stringify(o.messages))); const t = script.shift(); if (!t) { throw new Error('script exhausted'); } return t; };
const { runAgent } = require('../agent');

(async () => {
	try {
		const posted = [];
		const runs = new Map();
		script = [
			{ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'b1', name: 'run_command', input: { command: 'npm run dev', background: true, explanation: 'Start the dev server' } }] },
			{ stop_reason: 'end_turn', content: [{ type: 'text', text: 'Done: started.' }] },
		];
		const opened = [];
		await runAgent({
			messages: [{ role: 'user', content: 'go' }], maxSteps: 4, post: (m) => posted.push(m), dbg() {}, approve: async () => true,
			commandRuns: runs, commandStops: new Map(), signal: new AbortController().signal, openPreview: async (u) => { opened.push(u); },
		});
		// 114 000 characters of noise — more than the live card keeps — and only THEN the server says where it is.
		for (let i = 0; i < 114; i++) { child.stdout.emit('data', Buffer.from('y'.repeat(1000))); }
		child.stdout.emit('data', Buffer.from('\nServer listening on http://localhost:4000\n'));

		const e = runs.get('b1');
		assert.strictEqual(e.port, '4000', 'the port the server announced after the card filled up');
		assert.strictEqual(e.ready, true);
		assert.strictEqual(e.totalBytes, 114000 + '\nServer listening on http://localhost:4000\n'.length, 'the byte count did not freeze at the card\'s cap');
		assert.ok(e.ring.endsWith('Server listening on http://localhost:4000\n'), 'the ring ends with what the server said last');
		assert.ok(!e.ring.includes('[output truncated in view]'), 'the card\'s own marker is not command output');
		assert.deepStrictEqual(opened, ['http://localhost:4000'], 'and the preview was offered');

		// …while the live card is capped exactly as it was.
		const viewed = posted.filter((m) => m.type === 'termOutput').map((m) => m.chunk).join('');
		assert.ok(viewed.length <= 100000 + '\n[output truncated in view]'.length, 'the card must stay capped: ' + viewed.length);
		assert.strictEqual(viewed.split('[output truncated in view]').length - 1, 1, 'the marker is said once');
		assert.ok(!viewed.includes('listening'), 'what came after the cap is not drawn');
		assert.ok(posted.some((m) => m.type === 'bgTask' && m.port === '4000'), 'the tray learned the port');

		// read_command_output serves the registry, so the model can see it.
		script = [
			{ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'r1', name: 'read_command_output', input: { id: 'b1', lines: 5 } }] },
			{ stop_reason: 'end_turn', content: [{ type: 'text', text: 'Done: it is up.' }] },
		];
		seen.length = 0;
		await runAgent({
			messages: [{ role: 'user', content: 'check it' }], maxSteps: 4, post() {}, dbg() {}, approve: async () => true,
			commandRuns: runs, commandStops: new Map(), signal: new AbortController().signal,
		});
		const last = seen[seen.length - 1];
		const r = last[last.length - 1].content.find((c) => c.tool_use_id === 'r1').content;
		assert.match(r, /^\[running on :4000\] npm run dev\n/);
		assert.match(r, /Server listening on http:\/\/localhost:4000/);
		console.log('  ok - the registry sees what the live card no longer shows, and the card is still capped');
		console.log('\nagentBackgroundRegistry: 1 test passed.');
	} finally {
		Module._load = origLoad;
		fs.rmSync(root, { recursive: true, force: true });
	}
})().catch((e) => { console.error(e); process.exit(1); });
