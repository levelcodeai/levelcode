/*---------------------------------------------------------------------------------------------
 *  sessionResume — the three-tier resume rule + a tool-pair-safe cut — run: node test/sessionResume.test.js
 *
 *  The two things that must not break:
 *    • the tier decision at the budget boundary (verbatim ≤ budget < compact), and
 *    • the cut that summarization uses NEVER orphans a tool_use from its tool_result — the failure that
 *      makes the very next API call 400. We assert pair-integrity structurally: every tool_use id on one
 *      side of the cut has its tool_result on the SAME side.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

const assert = require('assert');
const R = require('../sessionResume');

let n = 0;
function test(name, fn) { fn(); n++; console.log('  ok - ' + name); }

// A realistic transcript: three user turns, two of them with a tool_use/tool_result pair.
function transcript() {
	return [
		{ role: 'user', content: 'turn 1 — add idempotency' },                         // 0 turn start
		{ role: 'assistant', content: [{ type: 'text', text: 'reading' }, { type: 'tool_use', id: 'a', name: 'read_file' }] },
		{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: '…' }] }, // 2 NOT a turn start
		{ role: 'assistant', content: 'done turn 1' },
		{ role: 'user', content: 'turn 2 — now the tests' },                            // 4 turn start
		{ role: 'assistant', content: [{ type: 'tool_use', id: 'b', name: 'edit_file' }] },
		{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'b', content: '…' }] }, // 6 NOT a turn start
		{ role: 'assistant', content: 'done turn 2' },
		{ role: 'user', content: 'turn 3 — ship it' },                                 // 8 turn start
		{ role: 'assistant', content: 'done turn 3' }
	];
}

const idsOf = (msgs, type) => {
	const s = new Set();
	for (const m of msgs) { if (Array.isArray(m.content)) { for (const b of m.content) { if (b && b.type === type) { s.add(type === 'tool_use' ? b.id : b.tool_use_id); } } } }
	return s;
};
const eqSet = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));

// ── estimate + budget ────────────────────────────────────────────────────────────────────────────

test('ESTIMATE: chars/4 over message content; budget is a share of the window', () => {
	assert.strictEqual(R.estimateTokens([{ role: 'user', content: 'x'.repeat(400) }]), 100);
	assert.strictEqual(R.estimateTokens([]), 0);
	assert.strictEqual(R.estimateTokens(null), 0, 'never throws on junk');
	assert.strictEqual(R.resumeBudget(200000, 40), 80000);
	assert.strictEqual(R.resumeBudget(1000, 10), 100);
	assert.strictEqual(R.resumeBudget(0, 40), 0);
});

// ── turn detection + cut boundary ──────────────────────────────────────────────────────────────────

test('TURN: a string user message starts a turn; a tool_result-only user message does NOT', () => {
	assert.strictEqual(R.isTurnStart({ role: 'user', content: 'hi' }), true);
	assert.strictEqual(R.isTurnStart({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a' }] }), false);
	assert.strictEqual(R.isTurnStart({ role: 'assistant', content: 'x' }), false);
	assert.deepStrictEqual(R.turnStartIndices(transcript()), [0, 4, 8]);
});

test('CUT: lands on a turn start, keeps the last N turns, and NEVER orphans a tool pair', () => {
	const msgs = transcript();

	const cut1 = R.pickCutBoundary(msgs, 1);
	assert.strictEqual(cut1, 8, 'keepTail=1 → cut before the last turn start');
	assert.ok(R.isTurnStart(msgs[cut1]), 'the tail begins at a real prompt, never a tool_result');

	const cut2 = R.pickCutBoundary(msgs, 2);
	assert.strictEqual(cut2, 4);

	// the load-bearing property: at ANY cut, each side is self-contained — no tool_use without its result
	for (const cut of [cut1, cut2]) {
		const head = msgs.slice(0, cut), tail = msgs.slice(cut);
		assert.ok(eqSet(idsOf(head, 'tool_use'), idsOf(head, 'tool_result')), 'head: every tool_use has its result');
		assert.ok(eqSet(idsOf(tail, 'tool_use'), idsOf(tail, 'tool_result')), 'tail: every tool_use has its result');
	}

	// nothing safe to cut → keep everything
	assert.strictEqual(R.pickCutBoundary(msgs, 8), 0, 'fewer turns than the tail budget → cut nothing');
	assert.strictEqual(R.pickCutBoundary([], 4), 0);
});

// ── the tier decision ──────────────────────────────────────────────────────────────────────────────

test('TIER 1: at or under budget resumes verbatim (boundary is inclusive)', () => {
	const at = [{ role: 'user', content: 'x'.repeat(400) }];   // 100 tokens
	const over = [{ role: 'user', content: 'x'.repeat(404) }]; // 101 tokens
	const opts = { contextWindow: 1000, budgetPct: 10 };        // budget = 100
	assert.strictEqual(R.planResume(at, opts).tier, 1, '100 ≤ 100 → verbatim');
	assert.strictEqual(R.planResume(at, opts).load, 'verbatim');
	assert.strictEqual(R.planResume(over, opts).tier, 3, '101 > 100 → must summarize');
});

test('TIER 3: over budget, no prior briefing → compact the head, keep the tail verbatim', () => {
	const msgs = transcript();
	const plan = R.planResume(msgs, { contextWindow: 40, budgetPct: 40, keepTailTurns: 1 }); // budget 16, way under
	assert.strictEqual(plan.tier, 3);
	assert.strictEqual(plan.load, 'compact');
	assert.strictEqual(plan.cutIndex, 8);
	assert.strictEqual(plan.head.length + plan.tail.length, msgs.length, 'head+tail partition the transcript');
	assert.ok(R.isTurnStart(plan.tail[0]), 'the verbatim tail starts at a real prompt');
	// pair-integrity of the actual plan slices
	assert.ok(eqSet(idsOf(plan.head, 'tool_use'), idsOf(plan.head, 'tool_result')));
});

test('TIER 2: over budget WITH a prior briefing → reuse it and load the tail', () => {
	const plan = R.planResume(transcript(), { contextWindow: 40, budgetPct: 40, keepTailTurns: 1, hasCompact: true });
	assert.strictEqual(plan.tier, 2);
	assert.strictEqual(plan.load, 'incremental');
	assert.strictEqual(plan.reusePriorBriefing, true);
	assert.ok(Array.isArray(plan.tail) && plan.tail.length > 0);
});

test('COST: tier 3 flags a paid compact only when the head crosses the confirm threshold', () => {
	const msgs = transcript();
	const cheap = R.planResume(msgs, { contextWindow: 40, keepTailTurns: 1, confirmCompactOverTokens: 100000 });
	const paid = R.planResume(msgs, { contextWindow: 40, keepTailTurns: 1, confirmCompactOverTokens: 1 });
	assert.strictEqual(cheap.needsPaidCompact, false, 'a tiny head under the threshold does not prompt');
	assert.strictEqual(paid.needsPaidCompact, true, 'a head over the threshold asks before spending');
});

// ── the honest UI line ─────────────────────────────────────────────────────────────────────────────

test('DESCRIBE: verbatim says nothing; a summarized resume says so, with the turn count', () => {
	assert.strictEqual(R.describeResume({ tier: 1 }), '', 'a verbatim resume has nothing to confess');
	assert.strictEqual(R.describeResume({ tier: 3 }, 41), 'Resumed from a summary of 41 earlier turns · view full transcript');
	assert.strictEqual(R.describeResume({ tier: 3 }, 1), 'Resumed from a summary of 1 earlier turn · view full transcript');
	assert.match(R.describeResume({ tier: 2 }, 12), /earlier summary of 12 earlier turns/);
});

console.log('sessionResume: ' + n + ' tests passed');
