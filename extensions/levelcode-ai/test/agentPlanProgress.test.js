/*---------------------------------------------------------------------------------------------
 *  The task list, the hand-back and "Send now", in the real agent loop — run: node test/agentPlanProgress.test.js
 *
 *  docs/PLAN-PROGRESS.md. turnPlan.test.js pins what the two tools decide; this file pins that the LOOP
 *  acts on it, because a decision the loop does not act on fixes nothing:
 *
 *    • update_plan draws the list and keeps it for the conversation — the next run's {"advance": true}
 *      moves what the last run left
 *    • wrap_up with a question ends the run on the spot: no further model call, and the history still
 *      pairs every tool call with its result
 *    • wrap_up is where the run's edits are checked: a failing check hides the box and hands the
 *      problems back; the closing answer after a good wrap-up is not checked a second time
 *    • the closing answer after wrap_up ends the run, whatever it says — it is never "nudged"
 *    • a "Send now" message reaches the model at the next step: after a step's tool results (in the
 *      same message), or after an answer with no tool call (and the run goes on); one the run never
 *      reached goes back before the run says it is over
 *    • a clean end without wrap_up completes a list that only had its last step open
 *
 *  The real runAgent runs on scripted turns, with `vscode` and the provider replaced as agentDone.test.js
 *  replaces them. No scripted turn edits a file or runs a command; verification is fed its diagnostics.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-plan-'));
const vscodeMock = { workspace: { workspaceFolders: /** @type {any} */ ([{ uri: { fsPath: root }, name: 'app' }]) } };
const origLoad = Module._load;
// @ts-ignore — test-only loader shim
Module._load = function (request, parent, isMain) {
	if (request === 'vscode') { return vscodeMock; }
	return origLoad.call(this, request, parent, isMain);
};

const providers = require('../providers/index');
/** @type {any[]} */
let script = [];
/** @type {any[]} */
let requests = [];
providers.streamAgentTurn = async (o) => {
	requests.push({ system: o.system, tools: o.tools.map((t) => t.name), toolDefs: o.tools, messages: o.messages.length });
	let turn = script.shift();
	if (typeof turn === 'function') { turn = await turn(); }
	if (!turn) { throw new Error('the agent asked for a turn the script does not have'); }
	return turn;
};

const { runAgent } = require('../agent');

let n = 0;
async function test(name, fn) { await fn(); n++; console.log('  ok - ' + name); }

let seq = 0;
const call = (name, input) => ({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't' + (++seq), name, input }] });
const say = (text) => ({ stop_reason: 'end_turn', content: [{ type: 'text', text }] });

/**
 * Run one goal on scripted turns. `extra` is merged into the run's ctx (plan, verify, takeSteers …).
 * @param {any[]} turns
 * @param {any} [extra]
 */
async function run(turns, extra) {
	const posted = [], logged = [];
	script = turns.slice();
	requests = [];
	const messages = (extra && extra.messages) || [{ role: 'user', content: 'make the parser read dates' }];
	const ctx = Object.assign({
		messages, maxSteps: 12,
		post: (m) => posted.push(m),
		dbg: (label, data) => logged.push({ label, data }),
		signal: new AbortController().signal
	}, extra || {});
	ctx.messages = messages;
	await runAgent(ctx);
	return {
		ctx, posted, logged, messages,
		asked: requests.length,
		types: posted.map((m) => m.type),
		plans: posted.filter((m) => m.type === 'plan').map((m) => m.steps.map((s) => s.status).join(' ')),
		wraps: posted.filter((m) => m.type === 'wrapUp'),
		done: posted.filter((m) => m.type === 'agentDone').map((m) => m.reason),
		nudges: logged.filter((l) => l.label === 'nudge').length,
		results: messages.filter((m) => m.role === 'user' && Array.isArray(m.content)).flatMap((m) => m.content.filter((b) => b.type === 'tool_result').map((b) => b.content))
	};
}
const ITEMS = { items: [{ content: 'Read the parser', status: 'in_progress' }, { content: 'Add the date rule', status: 'pending' }, { content: 'Run the tests', status: 'pending' }] };

(async () => {
	try {
		await test('OFFERED: both tools, on the desktop and with no folder open, and the prompt says when to use them', async () => {
			const r = await run([say('Done: nothing to do.')]);
			for (const t of ['update_plan', 'wrap_up']) { assert.ok(requests[0].tools.includes(t), t + ' is offered'); }
			const plan = requests[0].toolDefs.find((t) => t.name === 'update_plan');
			assert.deepStrictEqual(Object.keys(plan.input_schema.properties).sort(), ['advance', 'done', 'items', 'start']);
			assert.deepStrictEqual(plan.input_schema.properties.items.items.properties.status.enum, ['pending', 'in_progress', 'completed']);
			assert.deepStrictEqual(requests[0].toolDefs.find((t) => t.name === 'wrap_up').input_schema.required, ['recap']);
			assert.match(requests[0].system, /keep a task list with update_plan/);
			assert.match(requests[0].system, /call wrap_up/);
			assert.match(requests[0].system, /The user can send you a message while you work/);
			assert.deepStrictEqual(r.done, ['done']);
			// An MCP server may never name a tool after a built-in one (mcpConfig.js): every tool this run offered is reserved.
			const { BUILTIN_TOOL_NAMES } = require('../mcpConfig');
			assert.deepStrictEqual(requests[0].tools.filter((t) => !BUILTIN_TOOL_NAMES.includes(t)), [], 'a built-in an MCP tool could shadow');
			const folders = vscodeMock.workspace.workspaceFolders;
			vscodeMock.workspace.workspaceFolders = undefined;
			try {
				await run([say('Done: answered.')]);
				for (const t of ['update_plan', 'wrap_up']) { assert.ok(requests[0].tools.includes(t), t + ' needs no folder'); }
				assert.ok(!requests[0].tools.includes('read_file'), 'and this really was a run with no folder');
			} finally { vscodeMock.workspace.workspaceFolders = folders; }
		});

		await test('LIST: drawn as sent, moved by number, and kept for the conversation — the next run advances it', async () => {
			const plan = { steps: null };
			const r1 = await run([call('update_plan', ITEMS), call('update_plan', { advance: true }), say('Paused here. Done: first two steps underway.')], { plan });
			assert.deepStrictEqual(r1.plans, ['in_progress pending pending', 'completed in_progress pending']);
			assert.deepStrictEqual(r1.results, ['Task list shown (3 steps).', 'Task list updated: step 2 of 3 is in progress.']);
			assert.strictEqual(r1.posted.find((m) => m.type === 'plan').steps[1].content, 'Add the date rule', 'the chat gets the words with the statuses');
			const r2 = await run([call('update_plan', { advance: true }), say('Done: tests ran.')], { plan, messages: r1.messages.concat([{ role: 'user', content: 'go on' }]) });
			assert.deepStrictEqual(r2.plans[0], 'completed completed in_progress', 'the second run moved the first run\'s list');
			assert.deepStrictEqual(r2.plans[r2.plans.length - 1], 'completed completed completed', 'and a clean end completed its lone last step');
		});

		await test('LIST: an update to a step that is not there changes nothing and is not drawn', async () => {
			const r = await run([call('update_plan', ITEMS), call('update_plan', { done: [7] }), say('Done: ok.')], { plan: { steps: null } });
			assert.match(r.results[1], /^ERROR: nothing changed/);
			assert.strictEqual(r.plans.length, 1);
		});

		await test('WRAP-UP WITH A QUESTION: the box is posted, the list checked off, and the run ends with no further call', async () => {
			const plan = { steps: null };
			const r = await run([
				call('update_plan', ITEMS),
				call('wrap_up', { recap: 'Dates parse now; the tests were not run.', ask: 'Run the tests now?', actions: [{ label: 'Yes, run them', message: 'Run the tests.' }, { label: 'Not now' }] }),
				say('this turn must never be asked for')
			], { plan });
			assert.strictEqual(r.asked, 2, 'no model call after the wrap-up whose box holds the question');
			assert.strictEqual(script.length, 1);
			assert.deepStrictEqual(r.wraps.map((w) => [w.recap, w.ask, w.actions.length, w.blocked]), [['Dates parse now; the tests were not run.', 'Run the tests now?', 2, false]]);
			assert.strictEqual(r.plans[r.plans.length - 1], 'completed completed completed');
			assert.strictEqual(r.types[r.types.indexOf('wrapUp') - 1], 'plan', 'the list is checked off just before the box arrives');
			assert.match(r.results[1], /The run ends with this call/);
			const last = r.messages[r.messages.length - 1];
			assert.strictEqual(last.role, 'user');
			assert.strictEqual(last.content[0].type, 'tool_result', 'the history ends with the wrap-up\'s result — every tool call has one');
			assert.deepStrictEqual(r.done, ['done']);
		});

		await test('WRAP-UP WITH A RECAP ONLY: no box; the closing answer ends the run, and is never nudged', async () => {
			const r = await run([
				call('wrap_up', { recap: 'The parser reads dates.' }),
				say('The next step is yours: let me know if you want the README updated too.')   // "next", "let me … update": a stall, read literally
			], { plan: { steps: null } });
			assert.strictEqual(r.asked, 2);
			assert.strictEqual(r.nudges, 0);
			assert.match(r.results[0], /no box is shown: write your closing answer now/);
			assert.deepStrictEqual(r.done, ['done']);
		});

		await test('VERIFY AT WRAP-UP: problems hide the box and go back as the result; the closing answer is not checked again', async () => {
			const diags = [{ text: 'src/parse.js:4  error  Missing semicolon', count: 1 }, { text: '', count: 0 }];
			const ctx = {
				plan: { steps: null }, editCount: 1,
				verify: { enabled: true, maxRounds: 2, command: '' },
				getTouchedUris: () => ['src/parse.js'],
				getNewDiagnostics: async () => diags.shift() || { text: '', count: 0 }
			};
			const r = await run([
				call('wrap_up', { recap: 'Dates parse now.' }),
				() => { ctx.editCount = 2; return call('update_plan', ITEMS); },   // the model fixes it (an edit) …
				call('wrap_up', { recap: 'Dates parse now, and the file is clean.' }),
				say('Done: dates parse.')
			], ctx);
			assert.match(r.results[0], /^Not shown: your changes did not pass verification\.[\s\S]*Missing semicolon[\s\S]*call wrap_up again\.$/);
			assert.deepStrictEqual(r.wraps.map((w) => w.recap), ['Dates parse now, and the file is clean.'], 'only the wrap-up that passed reached the chat');
			assert.strictEqual(r.posted.filter((m) => m.type === 'verifyRun').length, 2, 'checked at each wrap-up, and not again for the "Done:" line');
			assert.deepStrictEqual(r.done, ['done']);
		});

		await test('SEND NOW, AFTER A STEP: the message rides with the tool results, and the chat is told it landed', async () => {
			const inbox = [];
			const r = await run([
				() => { inbox.push({ id: 'q1', text: 'Also handle ISO weeks.' }); return call('update_plan', ITEMS); },
				say('Noted — ISO weeks too. Done: added.')
			], { plan: { steps: null }, takeSteers: () => inbox.splice(0) });
			const carrier = r.messages[2];
			assert.strictEqual(carrier.role, 'user');
			assert.deepStrictEqual(carrier.content.map((b) => b.type), ['tool_result', 'text'], 'results first, then the message — the pair is never split');
			assert.match(carrier.content[1].text, /^\[The user sent this message while you were working\.[^\]]*\]\n\nAlso handle ISO weeks\.$/);
			assert.deepStrictEqual(r.posted.filter((m) => m.type === 'steersDelivered').map((m) => m.ids), [['q1']]);
			assert.deepStrictEqual(r.done, ['done']);
		});

		await test('SEND NOW, AFTER AN ANSWER: the run does not end on it — the model reads it next', async () => {
			const inbox = [];
			const r = await run([
				() => { inbox.push({ id: 'a', text: 'One more: keep the old format working.' }, { id: 'b', text: 'And log a warning.' }); return say('Done: dates parse.'); },
				say('Both kept. Done: old format still works, with a warning.')
			], { takeSteers: () => inbox.splice(0) });
			assert.strictEqual(r.asked, 2);
			const msg = r.messages[2];
			assert.strictEqual(msg.role, 'user');
			assert.match(msg.content, /^\[The user sent these messages, in order, while you were working\.[^\]]*\]\n\nOne more: keep the old format working\.\n\nAnd log a warning\.$/);
			assert.deepStrictEqual(r.posted.filter((m) => m.type === 'steersDelivered').map((m) => m.ids), [['a', 'b']]);
		});

		await test('SEND NOW AFTER A WRAP-UP: the hand-back no longer stands — the run goes on instead of ending', async () => {
			const inbox = [];
			const r = await run([
				() => { inbox.push({ id: 's', text: 'Wait — also the README.' }); return call('wrap_up', { recap: 'Done.', ask: 'Ship it?', actions: [{ label: 'Ship it' }] }); },
				call('wrap_up', { recap: 'Done, README too.' }),
				say('Done: README updated.')
			], { plan: { steps: null }, takeSteers: () => inbox.splice(0) });
			assert.strictEqual(r.asked, 3, 'the question box did not end a run the user had just written to');
			assert.deepStrictEqual(r.done, ['done']);
		});

		await test('SEND NOW NEVER REACHED: a stopped run hands the message back BEFORE it says it is over', async () => {
			const ac = new AbortController();
			const inbox = [];
			const r = await run([
				() => { inbox.push({ id: 'late', text: 'use UTC' }); ac.abort(); return call('update_plan', ITEMS); }
			], { plan: { steps: null }, signal: ac.signal, takeSteers: () => inbox.splice(0) });
			assert.deepStrictEqual(r.done, ['stopped']);
			assert.ok(!r.types.includes('steersDelivered'));
			const back = r.types.indexOf('steersReturned');
			assert.ok(back >= 0 && back < r.types.indexOf('agentDone'), 'returned, and before agentDone — the chat drains its queue on that');
			assert.deepStrictEqual(r.posted[back].ids, ['late']);
			assert.strictEqual(r.results[0], 'Cancelled by the user.', 'and the cancelled call still has its result');
		});

		await test('CLEAN END WITHOUT WRAP-UP: only a list whose last step alone is open is completed', async () => {
			const open = await run([say('Done: stopping early.')], { plan: { steps: [{ content: 'a', status: 'completed' }, { content: 'b', status: 'in_progress' }, { content: 'c', status: 'pending' }] } });
			assert.deepStrictEqual(open.plans, [], 'work still open is not checked off');
			const lone = await run([say('Done: finished.')], { plan: { steps: [{ content: 'a', status: 'completed' }, { content: 'b', status: 'in_progress' }] } });
			assert.deepStrictEqual(lone.plans, ['completed completed']);
		});

		console.log('agentPlanProgress: ' + n + ' tests passed');
	} catch (e) {
		console.error(e);
		process.exit(1);
	}
})();
