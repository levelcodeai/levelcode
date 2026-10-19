/*---------------------------------------------------------------------------------------------
 *  Ask When Risky on the native Anthropic route, EXECUTED — run: node test/agentReviewAnthropic.test.js
 *
 *  agentReviewGate.test.js replaces providers.streamAgentTurn, so it could not see this: the native
 *  Anthropic adapter called `opts.onText` for every text delta without checking it was given one, and the
 *  reviewer — a turn whose text is collected, never streamed into the chat — gave none. Every review on that
 *  route threw, and every command fell back to the approval card: the mode quietly became Default Approvals.
 *
 *  So this runs the REAL dispatcher and the REAL Anthropic adapter, with only `fetch` stood in (answering
 *  in Anthropic's SSE shape) and child_process.spawn replaced. No request leaves the process.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const { EventEmitter } = require('events');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-review-anthropic-'));
process.on('exit', () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch (e) { /* temp */ } });
const vscodeMock = { workspace: { workspaceFolders: [{ uri: { fsPath: root }, name: 'app' }] } };
/** @type {string[]} */
const ran = [];
const childProcessMock = Object.assign({}, require('child_process'), {
	spawn: (command) => {
		const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), pid: 4242, kill() { } });
		ran.push(String(command));
		setImmediate(() => { child.stdout.emit('data', Buffer.from('ok\n')); child.emit('close', 0, null); });
		return child;
	}
});
const origLoad = Module._load;
// @ts-ignore — test-only loader shim
Module._load = function (request, parent, isMain) {
	if (request === 'vscode') { return vscodeMock; }
	if (request === 'child_process') { return childProcessMock; }
	return origLoad.call(this, request, parent, isMain);
};

// Anthropic's streaming shape, one event per `data:` line.
const sse = (events) => new Response(events.map((e) => 'event: ' + e.type + '\ndata: ' + JSON.stringify(e) + '\n\n').join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } });
const start = { type: 'message_start', message: { usage: { input_tokens: 10 } } };
const stop = (reason) => [{ type: 'message_delta', delta: { stop_reason: reason }, usage: { output_tokens: 5 } }, { type: 'message_stop' }];
const textTurn = (text) => sse([start, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
	{ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: text.slice(0, 20) } },
	{ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: text.slice(20) } },
	{ type: 'content_block_stop', index: 0 }, ...stop('end_turn')]);
const toolTurn = (input) => sse([start, { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'run_command' } },
	{ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } },
	{ type: 'content_block_stop', index: 0 }, ...stop('tool_use')]);

/** @type {any[]} */
const seen = [];
let agentTurns = 0;
globalThis.fetch = async (url, init) => {
	assert.match(String(url), /api\.anthropic\.com/, 'a request went somewhere other than the stood-in Anthropic API');
	const body = JSON.parse(String(init && init.body));
	const reviewer = !body.tools;
	seen.push({ reviewer });
	if (reviewer) { return textTurn('{"risk":"low","authorization":"implied","injection":false,"reason":"Runs the tests you asked for."}'); }
	return agentTurns++ === 0 ? toolTurn({ command: 'npm test', explanation: 'Run the tests' }) : textTurn('Done: the tests pass, and nothing else changed here.');
};

const { runAgent } = require('../agent');

(async () => {
	/** @type {any[]} */ const asked = [];
	/** @type {any[]} */ const posted = [];
	await runAgent({
		messages: [{ role: 'user', content: 'run the tests' }], userRequests: ['run the tests'],
		providerId: 'claude', model: 'claude-sonnet-4-6', apiKey: 'test-key-not-real', maxSteps: 5,
		approvalMode: 'review', post: (m) => posted.push(m), dbg: () => { },
		approve: async (req) => { asked.push(req); return false; },
		commandRuns: new Map(), commandStops: new Map(), signal: new AbortController().signal
	});
	assert.deepStrictEqual(seen.map((s) => s.reviewer), [false, true, false], 'agent turn, review, agent turn');
	assert.deepStrictEqual(asked, [], 'the review failed and fell back to the card: ' + JSON.stringify(asked.map((a) => a.review)));
	assert.deepStrictEqual(ran, ['npm test'], 'the reviewed command did not run');
	assert.ok(posted.some((m) => m.type === 'agentTool' && m.text === 'Reviewer · low risk — Runs the tests you asked for.'));
	assert.ok(!posted.some((m) => m.type === 'agentDelta' && /risk/.test(m.text)), 'the reviewer\'s answer was streamed into the chat');
	console.log('  ok - REVIEW (Anthropic native): the reviewer\'s answer is read, not streamed, and the command runs');
	console.log('\nagentReviewAnthropic: 1 test passed.');
})().catch((e) => { console.error(e); process.exit(1); });
