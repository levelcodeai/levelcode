/*---------------------------------------------------------------------------------------------
 *  What the model is told when a command ends — run: node test/agentCommandResult.test.js
 *
 *  The bug this locks down: the tool result was `(output + status).slice(0, 8000)`. The status line —
 *  `[exit 1]`, `[timed out]`, `[stopped by user]` — and the end of the output, which is where a failing
 *  test run puts its failure, sit at the END, so the longer the output the surer it was to be cut. A
 *  failing command with 30 000 characters of output came back as its first 8000, with no exit code at
 *  all, and the model had no way to know it had failed.
 *
 *  Output that fits is unchanged, byte for byte. Output that does not keeps its start and its end.
 *  The real runAgent → runTool → run_command → runCommand chain runs, with a fake child.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const { EventEmitter } = require('events');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-result-'));
const vscodeMock = { workspace: { workspaceFolders: [{ uri: { fsPath: root }, name: 'app' }] } };
let child;
const childProcessMock = Object.assign({}, require('child_process'), {
	// kill() ends the child the way a real one does: it closes.
	spawn() { child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), kill() { setImmediate(() => child.emit('close', null)); return true; } }); return child; },
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

let n = 0;
async function test(name, fn) { seen.length = 0; await fn(); n++; console.log('  ok - ' + name); }
const settle = () => new Promise((r) => setTimeout(r, 5));

/** Run one command to its end. `drive(child)` plays the process; `ctxOver` can set the timeout or stop it. */
async function result(drive, ctxOver) {
	seen.length = 0;
	script = [
		{ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name: 'run_command', input: { command: 'x', explanation: 'x' } }] },
		{ stop_reason: 'end_turn', content: [{ type: 'text', text: 'Done: x' }] },
	];
	const ctx = Object.assign({ messages: [{ role: 'user', content: 'go' }], maxSteps: 4, post() {}, dbg() {}, approve: async () => true, commandRuns: new Map(), commandStops: new Map(), signal: new AbortController().signal }, ctxOver);
	const p = runAgent(ctx);
	await settle(); await settle();
	await drive(child, ctx);
	await p;
	for (const m of seen) { const u = m[m.length - 1]; if (u.role === 'user' && Array.isArray(u.content)) { const r = u.content.find((c) => c.tool_use_id === 't1'); if (r) { return r.content; } } }
	throw new Error('no tool result');
}
const line = (i) => 'line ' + String(i).padStart(4, '0') + ' ' + 'x'.repeat(20) + '\n';

(async () => {
	try {
		await test('SHORT OUTPUT IS UNCHANGED: output, then the exit note', async () => {
			assert.strictEqual(await result((c) => { c.stdout.emit('data', Buffer.from('ok')); c.emit('close', 2); }), 'ok\n[exit 2]');
			assert.strictEqual(await result((c) => { c.stdout.emit('data', Buffer.from('fine\n')); c.emit('close', 0); }), 'fine\n');
			assert.strictEqual(await result((c) => { c.emit('close', 0); }), '(no output)');
		});

		await test('LONG OUTPUT: the exit code and the failure at the end are what the model sees', async () => {
			const r = await result((c) => {
				for (let i = 0; i < 1000; i++) { c.stdout.emit('data', Buffer.from(line(i))); }
				c.stderr.emit('data', Buffer.from('FAIL test/foo.test.js: 3 assertions failed\n'));
				c.emit('close', 1);
			});
			assert.ok(r.length <= 8000, 'still bounded: ' + r.length);
			assert.ok(r.endsWith('\n[exit 1]'), 'the exit code is last: ' + JSON.stringify(r.slice(-30)));
			assert.ok(r.includes('FAIL test/foo.test.js: 3 assertions failed'), 'the failure is there');
			assert.ok(r.startsWith('line 0000 '), 'and so is the start');
			assert.match(r, /\n… \[\d+ characters of output omitted\] …\n/, 'the gap is said out loud');
			const omitted = Number(/\[(\d+) characters of output omitted\]/.exec(r)[1]);
			const total = 1000 * line(0).length + 'FAIL test/foo.test.js: 3 assertions failed\n'.length;
			assert.strictEqual(r.length - '\n[exit 1]'.length - (r.match(/\n… \[\d+ characters of output omitted\] …\n/)[0].length) + omitted, total, 'nothing is lost silently: kept + omitted = everything');
		});

		await test('OUTPUT OVER 256 KiB: the start is the command\'s real start, and the omitted count is everything that is not shown', async () => {
			// runCommand keeps only the last 256 KiB of the output in memory; a 2 MB `cat` used to come back with a "start"
			// from the middle of the file and "[~254000 characters of output omitted]" for about two million.
			let total = 0;
			const r = await result((c) => {
				const first = 'BEGIN of the output\n';
				c.stdout.emit('data', Buffer.from(first)); total += first.length;
				for (let k = 0; k < 70; k++) {
					let chunk = '';
					for (let i = 0; i < 1000; i++) { chunk += line(k * 1000 + i); }
					c.stdout.emit('data', Buffer.from(chunk)); total += chunk.length;
				}
				const last = 'FAIL at the very end\n';
				c.stderr.emit('data', Buffer.from(last)); total += last.length;
				c.emit('close', 1);
			});
			assert.ok(total > 2000000, 'about 2 MB: ' + total);
			assert.ok(r.length <= 8000, 'still bounded: ' + r.length);
			assert.ok(r.startsWith('BEGIN of the output\nline 0000 '), 'the start is the real start: ' + JSON.stringify(r.slice(0, 60)));
			assert.ok(r.endsWith('FAIL at the very end\n\n[exit 1]'), 'the end and the status: ' + JSON.stringify(r.slice(-40)));
			const gap = /\n… \[(\d+) characters of output omitted\] …\n/.exec(r);
			assert.ok(gap, 'the gap is said out loud');
			assert.strictEqual(r.length - '\n[exit 1]'.length - gap[0].length + Number(gap[1]), total, 'kept + omitted = everything the command wrote');
		});

		await test('a timeout and a stop are still said, however much came before', async () => {
			const noisy = (c) => { for (let i = 0; i < 1000; i++) { c.stdout.emit('data', Buffer.from(line(i))); } };
			const t = await result((c) => { noisy(c); }, { commandTimeout: 30 });
			assert.ok(t.endsWith('\n[timed out]') && t.length <= 8000, JSON.stringify(t.slice(-40)));
			const s = await result((c, ctx) => { noisy(c); for (const [, stop] of ctx.commandStops) { stop(); } });
			assert.ok(s.endsWith('\n[stopped by user]') && s.length <= 8000, JSON.stringify(s.slice(-40)));
		});

		await test('output of exactly the limit is still returned whole', async () => {
			const body = 'y'.repeat(8000 - '\n[exit 3]'.length);
			assert.strictEqual(await result((c) => { c.stdout.emit('data', Buffer.from(body)); c.emit('close', 3); }), body + '\n[exit 3]');
		});

		console.log('\nagentCommandResult: ' + n + ' tests passed.');
	} finally {
		Module._load = origLoad;
		fs.rmSync(root, { recursive: true, force: true });
	}
})().catch((e) => { console.error(e); process.exit(1); });
