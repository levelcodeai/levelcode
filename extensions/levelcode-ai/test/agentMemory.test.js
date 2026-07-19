/*---------------------------------------------------------------------------------------------
 *  Unit tests for context-compaction transcript surgery — run: node test/agentMemory.test.js
 *    The property that matters: after compaction splices [summary, ack] in place of messages[0..cut),
 *    the transcript is still VALID for the next API call — no tool_use left without its tool_result,
 *    and role alternation holds across the seam. A bug here 400s the very next turn.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

const assert = require('assert');
const { isGoalBoundary, findCompactionCut, estimateMsgTokens } = require('../agentMemory');

let n = 0;
function test(name, fn) { fn(); n++; console.log('  ok - ' + name); }

// --- builders that mirror what agent.js actually pushes ---
const goal = (t) => ({ role: 'user', content: String(t) });                       // a user STRING turn
const asstText = (t) => ({ role: 'assistant', content: [{ type: 'text', text: t }] });
const asstTool = (id, name) => ({ role: 'assistant', content: [{ type: 'tool_use', id, name, input: {} }] });
const toolResult = (id) => ({ role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] });

// The compaction splice, exactly as compactAgentMemory does it (summary user + ack assistant).
function compact(msgs, keepRecent) {
	const cut = findCompactionCut(msgs, keepRecent);
	if (cut < 0) { return { cut, out: msgs.slice() }; }
	const out = msgs.slice();
	out.splice(0, cut, goal('[summary]'), { role: 'assistant', content: 'ack' });
	return { cut, out };
}

// Structural validity: every tool_use has its tool_result in the immediately-following user message,
// and no assistant tool-call is left dangling (the two conditions Anthropic/the adapter enforce).
function assertValidTranscript(msgs, label) {
	for (let i = 0; i < msgs.length; i++) {
		const m = msgs[i];
		if (m.role !== 'assistant' || !Array.isArray(m.content)) { continue; }
		const useIds = m.content.filter((c) => c.type === 'tool_use').map((c) => c.id);
		if (!useIds.length) { continue; }
		const next = msgs[i + 1];
		assert.ok(next && next.role === 'user' && Array.isArray(next.content),
			label + ': tool_use at ' + i + ' has no following tool_result user message');
		const haveIds = new Set(next.content.filter((c) => c.type === 'tool_result').map((c) => c.tool_use_id));
		for (const id of useIds) { assert.ok(haveIds.has(id), label + ': tool_use ' + id + ' left without its tool_result'); }
	}
	// No tool_result may reference a tool_use that is not present (orphan on the other side of the cut).
	const allUseIds = new Set();
	for (const m of msgs) { if (Array.isArray(m.content)) { for (const c of m.content) { if (c.type === 'tool_use') { allUseIds.add(c.id); } } } }
	for (const m of msgs) { if (Array.isArray(m.content)) { for (const c of m.content) { if (c.type === 'tool_result') { assert.ok(allUseIds.has(c.tool_use_id), label + ': orphaned tool_result ' + c.tool_use_id); } } } }
}

// A realistic multi-goal session: goal → (assistant tool_use → user tool_result) → assistant text, ×N.
function session(goals) {
	const out = [];
	for (let g = 0; g < goals; g++) {
		out.push(goal('goal ' + g));
		out.push(asstTool('t' + g, 'read_file'));
		out.push(toolResult('t' + g));
		out.push(asstText('did goal ' + g));
	}
	return out;
}

// --- boundary detection ---
test('isGoalBoundary: only user STRING messages qualify', () => {
	assert.strictEqual(isGoalBoundary(goal('hi')), true);
	assert.strictEqual(isGoalBoundary(toolResult('t0')), false);   // user, but content is an array
	assert.strictEqual(isGoalBoundary(asstText('x')), false);
	assert.strictEqual(isGoalBoundary(asstTool('t', 'n')), false);
	assert.strictEqual(isGoalBoundary(null), false);
});

// --- refuses to cut when there is nothing safe to do ---
test('short transcript: no cut', () => {
	assert.strictEqual(findCompactionCut(session(1), 8), -1);
});
test('empty / non-array: no cut', () => {
	assert.strictEqual(findCompactionCut([], 8), -1);
	assert.strictEqual(findCompactionCut(null, 8), -1);
});
test('one giant goal, no interior boundary: no cut (better than an unsafe split)', () => {
	const msgs = [goal('start')];
	for (let i = 0; i < 40; i++) { msgs.push(asstTool('t' + i, 'run_command'), toolResult('t' + i)); }
	assert.strictEqual(findCompactionCut(msgs, 8), -1);
});

// --- the cut always lands on a goal boundary ---
test('cut lands on a goal boundary', () => {
	const msgs = session(10);
	const cut = findCompactionCut(msgs, 8);
	assert.ok(cut > 0, 'expected a cut');
	assert.ok(isGoalBoundary(msgs[cut]), 'cut did not land on a goal boundary');
});

// --- the load-bearing property, over many shapes ---
test('spliced transcript is valid for every goal count 3..40', () => {
	for (let g = 3; g <= 40; g++) {
		const { cut, out } = compact(session(g), 8);
		if (cut < 0) { continue; }
		assertValidTranscript(out, 'session(' + g + ')');
		// role alternation across the seam: summary(user) → ack(assistant) → kept goal(user)
		assert.strictEqual(out[0].role, 'user');
		assert.strictEqual(out[1].role, 'assistant');
		assert.strictEqual(out[2].role, 'user');
		assert.ok(isGoalBoundary(out[2]), 'kept tail must start at a goal boundary');
	}
});

test('spliced transcript keeps recent turns and shrinks the head', () => {
	const msgs = session(20);
	const { cut, out } = compact(msgs, 8);
	assert.ok(cut > 0);
	assert.ok(out.length < msgs.length, 'compaction did not shrink the transcript');
	// the last message is preserved verbatim
	assert.deepStrictEqual(out[out.length - 1], msgs[msgs.length - 1]);
});

test('multi-tool_use in one assistant turn stays paired after the cut', () => {
	// goal, then an assistant turn calling TWO tools, both results in the next user message.
	const msgs = [];
	for (let g = 0; g < 12; g++) {
		msgs.push(goal('g' + g));
		msgs.push({ role: 'assistant', content: [{ type: 'tool_use', id: 'a' + g, name: 'read_file', input: {} }, { type: 'tool_use', id: 'b' + g, name: 'search', input: {} }] });
		msgs.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a' + g, content: 'x' }, { type: 'tool_result', tool_use_id: 'b' + g, content: 'y' }] });
	}
	const { cut, out } = compact(msgs, 8);
	assert.ok(cut > 0);
	assertValidTranscript(out, 'multi-tool');
});

// --- token estimate ---
test('estimateMsgTokens is a positive, monotonic chars/4', () => {
	assert.strictEqual(estimateMsgTokens([]), 0);
	const small = estimateMsgTokens(session(2));
	const big = estimateMsgTokens(session(8));
	assert.ok(big > small, 'more messages should estimate more tokens');
});

console.log(n + ' passing');
