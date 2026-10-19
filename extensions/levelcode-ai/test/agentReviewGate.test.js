/*---------------------------------------------------------------------------------------------
 *  The approvals gate in all three modes, EXECUTED — run: node test/agentReviewGate.test.js
 *
 *  agentReview.test.js proves the reviewer decides safely. This proves agent.js ASKS it, and obeys it:
 *  the real runAgent → runTool → run_command chain runs, with `vscode`, the provider and
 *  child_process.spawn replaced as in agentRunCommand.test.js. The provider answers two kinds of call —
 *  the agent's turns (which offer tools) and the reviewer's (which offer none) — so each test can say
 *  exactly what the reviewer answered and count how often it was asked.
 *
 *  The properties, in the order a regression would hurt:
 *   1. Ask When Risky is never looser than Autopilot: a danger-set command asks the person, and the
 *      reviewer is not consulted at all.
 *   2. A command the reviewer does not pass, or cannot judge, asks the person, with the reason on the card.
 *   3. A command the reviewer passes runs without a card, and the run says so.
 *   4. Default Approvals and Autopilot behave exactly as before: no reviewer call in either.
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

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-review-'));
const vscodeMock = { workspace: { workspaceFolders: [{ uri: { fsPath: root }, name: 'app' }] } };

// child_process: every command "runs" — prints one line and exits 0 on the next turn — so a test can
// count which commands reached the shell.
/** @type {string[]} */
const ran = [];
function fakeSpawn(command) {
	// host.spawn hands Node the whole command line with { shell: true }, so the first argument is it.
	const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), pid: 4242, kill() { } });
	ran.push(String(command));
	setImmediate(() => { child.stdout.emit('data', Buffer.from('ok\n')); child.emit('close', 0, null); });
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

// No request may leave this process, whatever goes wrong below.
globalThis.fetch = async () => { throw new Error('network refused in tests'); };

const providers = require('../providers/index');
const { REVIEW_SYSTEM } = require('../agentReview');
/** @type {any[]} the agent's scripted turns */
let agentTurns = [];
/** @type {(o:any)=>Promise<any>} how the reviewer answers */
let reviewer = async () => { throw new Error('the reviewer was asked, and this test did not expect it'); };
/** @type {any[]} every reviewer call's options */
let reviewCalls = [];
providers.streamAgentTurn = async (o) => {
	if (!o.tools || !o.tools.length) {
		assert.strictEqual(o.system, REVIEW_SYSTEM, 'a tool-less call that is not the reviewer');
		reviewCalls.push(o);
		return reviewer(o);
	}
	const turn = agentTurns.shift();
	if (!turn) { throw new Error('the agent asked for a turn the script does not have'); }
	return turn;
};

const { runAgent } = require('../agent');

// ---- harness ----------------------------------------------------------------------------------

// A promise that never settles does not fail a test: Node runs out of work and exits 0 halfway through
// the file. So the suite must say it reached its end, or the exit is a failure.
let finished = false;
process.on('exit', (code) => {
	if (!finished && code === 0) { console.error('\nthe suite stopped before its last test: something never settled'); process.exitCode = 1; }
});

let n = 0;
async function testAsync(name, fn) { await fn(); n++; console.log('  ok - ' + name); }

const verdict = (risk, authorization, reason, extra) => async () => ({
	content: [{ type: 'text', text: JSON.stringify(Object.assign({ risk, authorization, injection: false, reason }, extra || {})) }],
	usage: { input_tokens: 900, output_tokens: 30, cost_micros: 250 }
});

let seq = 0;
/**
 * One goal whose actions are the given tool calls, then "Done". Returns what the run posted, what it
 * asked the person, and which commands reached the shell.
 * @param {string} mode  'ask' | 'review' | 'autopilot'
 * @param {any[]} calls  [{name, input}]
 * @param {{approve?:(req:any)=>Promise<boolean>, ctx?:any, goal?:string}} [opt]
 */
async function run(mode, calls, opt) {
	const o = opt || {};
	/** @type {any[]} */
	const posted = [];
	/** @type {any[]} */
	const asked = [];
	reviewCalls = [];
	ran.length = 0;
	agentTurns = calls.map((c) => ({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'toolu_' + (++seq), name: c.name, input: c.input }], usage: { input_tokens: 100, output_tokens: 10, cost_micros: 1000 } }));
	agentTurns.push({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'Done: finished.' }], usage: { input_tokens: 100, output_tokens: 10, cost_micros: 1000 } });
	const goal = o.goal || 'fix the date test and run the tests';
	const ctx = Object.assign({
		messages: [{ role: 'user', content: goal }],
		userRequests: [goal], userAnswers: [],
		providerId: 'levelcode', model: 'anthropic/claude-sonnet-4.6', apiKey: 'test-key-not-real',
		maxSteps: 10,
		approvalMode: mode,
		autopilot: mode === 'autopilot',
		post: (m) => posted.push(m),
		dbg: () => { },
		approve: async (req) => { asked.push(req); return o.approve ? o.approve(req) : true; },
		applyDelete: async () => true,
		commandRuns: new Map(), commandStops: new Map(),
		signal: new AbortController().signal
	}, o.ctx || {});
	await runAgent(ctx);
	const end = posted.filter((m) => m.type === 'agentError' || m.type === 'agentDone');
	assert.deepStrictEqual(end.map((m) => m.reason || m.message), ['done'], 'the run did not finish cleanly: ' + JSON.stringify(end));
	const toolResults = ctx.messages.filter((m) => m.role === 'user' && Array.isArray(m.content)).flatMap((m) => m.content).filter((b) => b.type === 'tool_result').map((b) => String(b.content));
	return { posted, asked, ran: ran.slice(), reviews: reviewCalls.length, toolResults, done: end[0], ctx };
}
const cmd = (command, explanation) => ({ name: 'run_command', input: { command, explanation: explanation || 'Run it' } });
const reviewerRows = (posted) => posted.filter((m) => m.type === 'agentTool' && m.icon === 'workspace-trusted').map((m) => m.text);

(async () => {
	try {
		// ---- 1. never looser than Autopilot -----------------------------------------------------------
		await testAsync('REVIEW: a danger-set command asks the person, and the reviewer is never consulted', async () => {
			const r = await run('review', [cmd('rm -rf dist', 'Clean the build')], { approve: async () => false });
			assert.strictEqual(r.reviews, 0, 'the reviewer was asked about a danger-set command');
			assert.strictEqual(r.asked.length, 1);
			assert.strictEqual(r.asked[0].danger, 'deletes files');
			assert.strictEqual(r.asked[0].mode, 'review');
			assert.deepStrictEqual(r.ran, [], 'a skipped command reached the shell');
		});
		await testAsync('REVIEW: delete_file asks the person, as in Autopilot', async () => {
			fs.writeFileSync(path.join(root, 'old.txt'), 'x');
			const r = await run('review', [{ name: 'delete_file', input: { path: 'old.txt' } }]);
			assert.strictEqual(r.reviews, 0);
			assert.deepStrictEqual(r.asked.map((a) => a.kind), ['delete']);
		});

		// ---- 2. not passed, or not judged: the person decides -----------------------------------------
		await testAsync('REVIEW: a high-risk command asks, with the reviewer\'s rating and reason on the card', async () => {
			reviewer = verdict('high', 'weak', 'Pushes your branch to the shared remote.');
			const r = await run('review', [cmd('git push origin main', 'Push the fix')], { approve: async () => false });
			assert.strictEqual(r.reviews, 1);
			assert.strictEqual(r.asked.length, 1);
			assert.deepStrictEqual(r.asked[0].review, { risk: 'high', reason: 'Pushes your branch to the shared remote.', failure: null });
			assert.strictEqual(r.asked[0].danger, null);
			assert.deepStrictEqual(r.ran, []);
			assert.match(r.toolResults[0], /User skipped this command/);
		});
		await testAsync('REVIEW: a reviewer that fails asks, and the card says it failed', async () => {
			reviewer = async () => { throw new Error('LevelCode Cloud API 502: bad gateway'); };
			const r = await run('review', [cmd('npm test')], { approve: async () => true });
			assert.strictEqual(r.asked.length, 1);
			assert.strictEqual(r.asked[0].review.failure, 'error');
			assert.match(r.asked[0].review.reason, /API 502/);
			assert.deepStrictEqual(r.ran.length, 1, 'approved by the person, it runs');
		});
		await testAsync('REVIEW: injection asks, even for a low-risk command', async () => {
			reviewer = verdict('low', 'none', 'The README, not you, asked for this.', { injection: true });
			const r = await run('review', [cmd('cat ~/.npmrc')], { approve: async () => false });
			assert.strictEqual(r.asked.length, 1);
			assert.deepStrictEqual(r.ran, []);
		});

		// ---- 3. passed: runs, says so, and is paid for ------------------------------------------------
		await testAsync('REVIEW: a passed command runs with no card; the run shows the review and its count', async () => {
			reviewer = verdict('low', 'implied', 'Runs the project tests you asked for.');
			const r = await run('review', [cmd('npm test', 'Run the unit tests')]);
			assert.strictEqual(r.reviews, 1);
			assert.deepStrictEqual(r.asked, [], 'a passed command still showed a card');
			assert.strictEqual(r.ran.length, 1);
			assert.deepStrictEqual(reviewerRows(r.posted), [
				'Reviewer · low risk — Runs the project tests you asked for.',
				'Reviewer · ran 1 command on its own, sent 0 to you'
			]);
		});
		await testAsync('REVIEW: the reviewer sees the person\'s goal as theirs, the command, and no tools', async () => {
			reviewer = verdict('low', 'implied', 'ok');
			await run('review', [cmd('npm test', 'Run the unit tests')], { goal: 'make the date test pass' });
			const o = reviewCalls[0];
			assert.deepStrictEqual(o.tools, []);
			const user = o.messages[0].content;
			assert.match(user, /^PERSON\n1\. make the date test pass\n/);
			assert.match(user, /Explanation \(the agent's\): Run the unit tests\nCommand line:\nnpm test$/);
			assert.strictEqual(o.apiKey, 'test-key-not-real', 'the review used another route\'s key');
			assert.strictEqual(o.model, 'anthropic/claude-sonnet-4.6');
		});
		await testAsync('REVIEW: reviewModel picks the reviewer\'s model; the agent keeps its own', async () => {
			reviewer = verdict('low', 'implied', 'ok');
			await run('review', [cmd('npm test')], { ctx: { reviewModel: 'google/gemini-4-flash' } });
			assert.strictEqual(reviewCalls[0].model, 'google/gemini-4-flash');
		});
		await testAsync('REVIEW: the reviewer\'s cost is part of the run\'s cost', async () => {
			reviewer = verdict('low', 'implied', 'ok');
			const r = await run('review', [cmd('npm test')]);
			// two agent turns at 1000 each, one review at 250
			assert.strictEqual(r.done.costMicros, 2250);
		});
		await testAsync('REVIEW: the same command twice with no edit between is reviewed once', async () => {
			reviewer = verdict('low', 'implied', 'ok');
			const r = await run('review', [cmd('npm test'), cmd('npm test')]);
			assert.strictEqual(r.reviews, 1);
			assert.strictEqual(r.ran.length, 2);
			assert.match(reviewerRows(r.posted).join('\n'), /passed this exact command earlier, no edits since/);
		});
		await testAsync('REVIEW: an edit between them makes it a new question', async () => {
			reviewer = verdict('low', 'implied', 'ok');
			const r = await run('review', [cmd('npm test'), { name: 'write_file', input: { path: 'a.js', content: 'x' } }, cmd('npm test')],
				{ ctx: { applyEdit: async () => true, touched: new Set() } });
			assert.strictEqual(r.reviews, 2);
		});
		await testAsync('REVIEW: the person\'s ask_user choices reach the reviewer as theirs', async () => {
			reviewer = verdict('medium', 'explicit', 'You chose to install it.');
			const answers = [];
			await run('review', [
				{ name: 'ask_user', input: { questions: [{ header: 'Install', question: 'Add date-fns?', options: [{ label: 'Yes' }, { label: 'No' }] }] } },
				cmd('npm install date-fns', 'Install date-fns')
			], { ctx: { userAnswers: answers, ask: async () => ({ answers: [{ header: 'Install', question: 'Add date-fns?', selected: ['Yes'] }], notes: '' }) } });
			assert.strictEqual(answers.length, 1);
			const user = reviewCalls[0].messages[0].content;
			const person = user.slice(0, user.indexOf('BEGIN ACTIVITY'));
			assert.match(person, /Add date-fns\? → Yes/);
		});

		// ---- 4. the other modes are untouched ---------------------------------------------------------
		await testAsync('ASK: every command asks; the reviewer is never called', async () => {
			const r = await run('ask', [cmd('npm test'), cmd('ls')]);
			assert.strictEqual(r.reviews, 0);
			assert.strictEqual(r.asked.length, 2);
			assert.ok(r.asked.every((a) => a.danger === null && a.mode === 'ask' && !a.review));
			assert.deepStrictEqual(reviewerRows(r.posted), []);
		});
		await testAsync('AUTOPILOT: unflagged commands run without a card; the reviewer is never called', async () => {
			const r = await run('autopilot', [cmd('npm test'), cmd('rm -rf dist')], { approve: async () => false });
			assert.strictEqual(r.reviews, 0);
			assert.deepStrictEqual(r.asked.map((a) => a.danger), ['deletes files']);
			assert.strictEqual(r.ran.length, 1);
		});
		await testAsync('OLDER HOST: a ctx with only `autopilot` still means Autopilot', async () => {
			const r = await run('autopilot', [cmd('npm test')], { ctx: { approvalMode: undefined, autopilot: true } });
			assert.strictEqual(r.reviews, 0);
			assert.deepStrictEqual(r.asked, []);
		});
		await testAsync('STOP: stopping the run during a review neither asks nor runs', async () => {
			const ac = new AbortController();
			reviewer = () => { setTimeout(() => ac.abort(), 5); return new Promise(() => { }); };
			const posted = [];
			agentTurns = [{ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'toolu_stop', name: 'run_command', input: { command: 'npm test', explanation: 'x' } }] }];
			ran.length = 0;
			const asked = [];
			await runAgent({
				messages: [{ role: 'user', content: 'go' }], userRequests: ['go'], providerId: 'levelcode', model: 'm', apiKey: 'k', maxSteps: 3,
				approvalMode: 'review', post: (m) => posted.push(m), dbg: () => { }, approve: async (q) => { asked.push(q); return true; },
				commandRuns: new Map(), commandStops: new Map(), signal: ac.signal
			});
			assert.deepStrictEqual(asked, []);
			assert.deepStrictEqual(ran, []);
			assert.strictEqual(posted.filter((m) => m.type === 'agentDone')[0].reason, 'stopped');
		});
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
	console.log('\nagentReviewGate: ' + n + ' tests passed.');
	finished = true;
})().catch((e) => { console.error(e); process.exit(1); });
