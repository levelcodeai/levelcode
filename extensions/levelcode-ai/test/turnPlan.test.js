/*---------------------------------------------------------------------------------------------
 *  The task list and the hand-back, decided — run: node test/turnPlan.test.js
 *
 *  turnPlan.js is everything update_plan and wrap_up decide (docs/PLAN-PROGRESS.md), with no model,
 *  editor or webview: how a list is read, how a small update moves it, what the model is told back,
 *  and which replies a click may send. agentPlanProgress.test.js runs the same tools inside the real
 *  agent loop; this file pins the rules themselves.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

const assert = require('assert');
const tp = require('../turnPlan');

let n = 0;
function test(name, fn) { fn(); n++; console.log('  ok - ' + name); }

const S = (content, status) => ({ content, status });
const statuses = (steps) => steps.map((s) => s.status).join(' ');
const list = (...st) => st.map((s, i) => S('step ' + (i + 1), s));

// ── reading a list ──────────────────────────────────────────────────────────────────────────────

test('LIST: items are read as written, in order', () => {
	assert.deepStrictEqual(tp.readSteps({ items: [S('Read the code', 'completed'), S('Fix it', 'in_progress'), S('Test it', 'pending')] }),
		[S('Read the code', 'completed'), S('Fix it', 'in_progress'), S('Test it', 'pending')]);
});

test('LIST: a conversation from an older build still works — todos, title, "done"', () => {
	assert.deepStrictEqual(tp.readSteps({ todos: [{ title: 'Read', status: 'done' }, { title: 'Fix', status: 'in_progress' }] }),
		[S('Read', 'completed'), S('Fix', 'in_progress')]);
});

test('LIST: an unknown status is pending; a step with no words is skipped', () => {
	assert.deepStrictEqual(tp.readSteps({ items: [S('a', 'blocked'), S('   ', 'pending'), { status: 'pending' }, null, 'x', S('b', 'completed')] }),
		[S('a', 'pending'), S('b', 'completed')]);
});

test('LIST: at most ' + tp.MAX_STEPS + ' steps; a step is cut at ' + tp.STEP_CHARS + ' characters and kept on one line', () => {
	const many = Array.from({ length: 20 }, (_, i) => S('step ' + i, 'pending'));
	assert.strictEqual(tp.readSteps({ items: many }).length, tp.MAX_STEPS);
	const [long] = tp.readSteps({ items: [S('word '.repeat(80), 'pending')] });
	assert.ok(long.content.length <= tp.STEP_CHARS);
	assert.strictEqual(tp.readSteps({ items: [S('two\nlines​ here ', 'pending')] })[0].content, 'two lines here');
});

// ── moving it ───────────────────────────────────────────────────────────────────────────────────

test('ADVANCE: completes the step in progress and starts the next pending one', () => {
	assert.strictEqual(statuses(tp.applyUpdate(list('completed', 'in_progress', 'pending', 'pending'), { advance: true })), 'completed completed in_progress pending');
});

test('ADVANCE: with no pending step after it, the first pending one starts; with none at all, the list is done', () => {
	assert.strictEqual(statuses(tp.applyUpdate(list('pending', 'completed', 'in_progress'), { advance: true })), 'in_progress completed completed');
	assert.strictEqual(statuses(tp.applyUpdate(list('completed', 'in_progress'), { advance: true })), 'completed completed');
	assert.strictEqual(statuses(tp.applyUpdate(list('pending', 'pending'), { advance: true })), 'in_progress pending', 'nothing in progress: the first pending one starts');
});

test('DONE / START: by number, from 1 — done first, then start, then advance', () => {
	assert.strictEqual(statuses(tp.applyUpdate(list('in_progress', 'pending', 'pending', 'pending'), { done: [1, 2], start: 4 })), 'completed completed pending in_progress');
	assert.strictEqual(statuses(tp.applyUpdate(list('pending', 'pending'), { advance: 'true' })), 'in_progress pending', 'a stringly true still advances');
});

test('THE WORDS NEVER MOVE: an update changes statuses only', () => {
	const before = [S('Read', 'in_progress'), S('Fix', 'pending')];
	const after = tp.applyUpdate(before, { advance: true });
	assert.deepStrictEqual(after.map((s) => s.content), ['Read', 'Fix']);
	assert.strictEqual(before[0].status, 'in_progress', 'and the old list is not changed in place');
});

// ── the tool, as the model meets it ─────────────────────────────────────────────────────────────

test('TOOL: a whole list is shown, and the reply says how many steps', () => {
	const plan = { steps: null };
	const r = tp.planTool({ items: [S('a', 'in_progress'), S('b', 'pending')] }, plan);
	assert.ok(r.changed);
	assert.strictEqual(r.text, 'Task list shown (2 steps).');
	assert.strictEqual(plan.steps.length, 2);
});

test('TOOL: two steps in progress draw a warning; an update sent WITH a list changes nothing and says so', () => {
	const plan = { steps: null };
	assert.match(tp.planTool({ items: [S('a', 'in_progress'), S('b', 'in_progress')] }, plan).text, /Keep only one step in_progress/);
	const r = tp.planTool({ items: [S('a', 'in_progress'), S('b', 'pending')], advance: true }, plan);
	assert.match(r.text, /changed nothing/);
	assert.strictEqual(statuses(plan.steps), 'in_progress pending');
});

test('TOOL: an update says where the list stands', () => {
	const plan = { steps: list('completed', 'in_progress', 'pending') };
	assert.strictEqual(tp.planTool({ advance: true }, plan).text, 'Task list updated: step 3 of 3 is in progress.');
	assert.strictEqual(tp.planTool({ advance: true }, plan).text, 'Task list updated: every step is done.');
	assert.match(tp.planTool({ start: 1, done: [] }, { steps: list('in_progress', 'pending') }).text, /step 1 of 2/);
	assert.match(tp.planTool({ start: 2 }, { steps: list('in_progress', 'pending') }).text, /steps 1, 2 of 2 are in progress; keep one/);
	assert.match(tp.planTool({ done: [1] }, { steps: list('in_progress', 'pending') }).text, /no step is in progress \(1 of 2 done\); \{"start": n\} starts one/);
});

test('TOOL: a step that does not exist changes nothing, and the reply says how many there are', () => {
	const plan = { steps: list('in_progress', 'pending') };
	for (const bad of [{ done: [3] }, { start: 0 }, { done: [1.5] }, { start: '2' }, { done: [1], start: 9 }]) {
		const r = tp.planTool(bad, plan);
		assert.ok(!r.changed, JSON.stringify(bad));
		assert.match(r.text, /^ERROR: nothing changed\. Steps are numbered from 1, and the list has 2 steps\./);
	}
	assert.strictEqual(statuses(plan.steps), 'in_progress pending', 'the list is as it was');
});

test('TOOL: an update with no list yet, an empty list, and an empty call are refused', () => {
	assert.match(tp.planTool({ advance: true }, { steps: null }).text, /^ERROR: there is no task list yet/);
	assert.match(tp.planTool({ items: [] }, { steps: null }).text, /^ERROR: the list needs at least one step/);
	assert.match(tp.planTool({}, { steps: list('pending') }).text, /^ERROR: send \{"items"/);
	assert.match(tp.planTool(null, { steps: null }).text, /^ERROR/);
});

test('END OF A RUN: wrap_up checks every step off; a clean end without it completes only a lone last step', () => {
	assert.strictEqual(statuses(tp.completeAll(list('completed', 'in_progress', 'pending'))), 'completed completed completed');
	assert.strictEqual(statuses(tp.completeOnCleanEnd(list('completed', 'completed', 'in_progress')) || []), 'completed completed completed');
	assert.strictEqual(tp.completeOnCleanEnd(list('completed', 'in_progress', 'pending')), null, 'open work is not quietly checked off');
	assert.strictEqual(tp.completeOnCleanEnd(list('in_progress', 'completed')), null);
	assert.strictEqual(tp.completeOnCleanEnd(list('completed', 'completed')), null, 'nothing to change');
	assert.strictEqual(tp.completeOnCleanEnd([]), null);
});

// ── the hand-back ───────────────────────────────────────────────────────────────────────────────

const Y = { label: 'Yes, ship it', message: 'Ship it.' };
const N = { label: 'Not yet' };

test('WRAP-UP: recap is required', () => {
	assert.match(tp.readWrapUp({}).error || '', /^ERROR: recap is required/);
	assert.match(tp.readWrapUp({ recap: '  ​ ' }).error || '', /^ERROR: recap is required/);
});

test('WRAP-UP: a recap alone shows no box', () => {
	const r = tp.readWrapUp({ recap: 'The parser now reads dates. Tests pass.' });
	assert.deepStrictEqual(r.wrap, { recap: 'The parser now reads dates. Tests pass.', ask: '', actions: [], blocked: false });
	assert.deepStrictEqual(r.advice, []);
	assert.ok(!tp.showsBox(r.wrap));
	assert.match(tp.wrapUpResult(r.wrap, r.advice), /no box is shown: write your closing answer now/);
});

test('WRAP-UP: a question with replies shows the box, and the run ends with the call', () => {
	const r = tp.readWrapUp({ recap: 'Done.', ask: 'Ship it?', actions: [Y, N] });
	assert.deepStrictEqual(r.wrap.actions, [{ label: 'Yes, ship it', message: 'Ship it.' }, { label: 'Not yet', message: 'Not yet' }], 'a reply with no message sends its label');
	assert.ok(tp.showsBox(r.wrap));
	assert.match(tp.wrapUpResult(r.wrap, r.advice), /The run ends with this call: write nothing after it/);
});

test('WRAP-UP: blocked shows the box even with no question; a question with no replies does not', () => {
	assert.ok(tp.showsBox(tp.readWrapUp({ recap: 'Stuck on the key.', blocked: true }).wrap));
	assert.ok(tp.showsBox(tp.readWrapUp({ recap: 'x', blocked: 'true' }).wrap));
	const lone = tp.readWrapUp({ recap: 'x', ask: 'Which one?' });
	assert.ok(!tp.showsBox(lone.wrap));
	assert.strictEqual(lone.wrap.ask, '', 'a question nobody can click an answer to is not shown');
	assert.match(lone.advice.join(' '), /needs at least one reply/);
	const noAsk = tp.readWrapUp({ recap: 'x', actions: [Y] });
	assert.deepStrictEqual(noAsk.wrap.actions, []);
	assert.match(noAsk.advice.join(' '), /this call had no ask/);
});

test('WRAP-UP: a reply that would run a chat command or hide what it sends is dropped', () => {
	const r = tp.readWrapUp({ recap: 'x', ask: 'Next?', actions: [{ label: 'Skills', message: '/skills' }, { label: '!rm', message: 'go' }, { label: 'Go', message: 'go‎ on' }, N] });
	assert.deepStrictEqual(r.wrap.actions.map((a) => a.label), ['Not yet']);
	assert.match(r.advice.join(' '), /starts with "\/" or "!", or holds an invisible character, is dropped/);
	const multi = tp.readWrapUp({ recap: 'x', ask: 'Next?', actions: [{ label: 'Both', message: 'Do this.\nThen that.' }] });
	assert.strictEqual(multi.wrap.actions[0].message, 'Do this.\nThen that.', 'a message may have lines');
});

test('WRAP-UP: past the limits it says so — two buttons shown, long labels and messages reported', () => {
	const r = tp.readWrapUp({ recap: 'r'.repeat(400), ask: 'q'.repeat(120) + '?', actions: [{ label: 'Yes please go ahead now', message: 'm'.repeat(400) }, N, Y] });
	assert.strictEqual(r.wrap.actions.length, tp.MAX_ACTIONS);
	assert.strictEqual(r.wrap.actions[0].message.length, tp.MESSAGE_CHARS);
	const said = r.advice.join(' ');
	for (const want of [/this one ran 400/, /this one ran 121/, /this call had 3/, /"Yes please go ahead now" is too long/, /cut at 300 characters/]) { assert.match(said, want); }
	assert.match(tp.wrapUpResult(r.wrap, r.advice), /For next time: /);
});

console.log('turnPlan: ' + n + ' tests passed');
