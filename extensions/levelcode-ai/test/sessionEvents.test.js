/*---------------------------------------------------------------------------------------------
 *  sessionEvents — message ⇄ event translation — run: node test/sessionEvents.test.js
 *
 *  Two guarantees: (1) VERBATIM — messages → events → messages is byte-identical, so a verbatim resume
 *  sees exactly what it left; (2) the card stats (sparkline, files-edited) are DERIVED from the turn's
 *  own messages, not hand-passed — so they can't drift from the transcript. The last test wires this to
 *  sessionStore.deriveEntry to prove the two modules agree end-to-end.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

const assert = require('assert');
const E = require('../sessionEvents');
const S = require('../sessionStore');

let n = 0;
function test(name, fn) { fn(); n++; console.log('  ok - ' + name); }

// A realistic agent turn: read one file, then edit two, then answer.
function conversation() {
	return [
		{ role: 'user', content: 'add idempotency to refunds' },
		{ role: 'assistant', content: [{ type: 'text', text: 'reading' }, { type: 'tool_use', id: 'a', name: 'read_file', input: { path: 'refund.rb' } }] },
		{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: '…' }] },
		{ role: 'assistant', content: [
			{ type: 'tool_use', id: 'b', name: 'edit_file', input: { path: 'refund.rb' } },
			{ type: 'tool_use', id: 'c', name: 'write_file', input: { path: 'redis_lock.rb' } }
		] },
		{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'b' }, { type: 'tool_result', tool_use_id: 'c' }] },
		{ role: 'assistant', content: 'Done: idempotent refunds via Redis keys' }
	];
}

test('STATS: tool count is the sparkline; only edit_file/write_file count as files edited', () => {
	const { tools, edits } = E.toolStatsFromMessages(conversation());
	assert.strictEqual(tools, 3, 'read_file + edit_file + write_file = 3 tool calls');
	assert.deepStrictEqual(edits, [{ path: 'refund.rb' }, { path: 'redis_lock.rb' }], 'the read is not an edit');
	assert.deepStrictEqual(E.toolStatsFromMessages(null), { tools: 0, edits: [] }, 'never throws on junk');
});

test('BUILD: user/agent events carry content + verbatim messages + derived stats', () => {
	const msgs = conversation();
	const u = E.userTurnEvent(msgs[0], 't1');
	assert.strictEqual(u.kind, 'user');
	assert.strictEqual(u.content, 'add idempotency to refunds');
	assert.deepStrictEqual(u.messages, [msgs[0]]);

	const a = E.agentTurnEvent(msgs.slice(1), 'anthropic/claude-opus-5', 't2');
	assert.strictEqual(a.kind, 'agent');
	assert.strictEqual(a.model, 'anthropic/claude-opus-5');
	assert.strictEqual(a.tools, 3);
	assert.deepStrictEqual(a.messages, msgs.slice(1), 'the turn is stored verbatim');
});

test('VERBATIM: messages → events → eventsToMessages is byte-identical (lossless resume)', () => {
	const msgs = conversation();
	const events = [E.userTurnEvent(msgs[0], 't1'), E.agentTurnEvent(msgs.slice(1), 'm', 't2')];
	assert.deepStrictEqual(E.eventsToMessages(events), msgs, 'rebuild == original, exactly');
	// non-transcript events contribute nothing to the rebuild
	const withMeta = events.concat([E.titleEvent('T', 't3'), E.labelEvent({ pinned: true }, 't4'), E.endEvent('done', 't5')]);
	assert.deepStrictEqual(E.eventsToMessages(withMeta), msgs, 'title/label/end carry no messages');
});

test('TAIL: only the new messages since the stored count are appended (incremental, not the whole lot)', () => {
	const msgs = conversation();
	assert.deepStrictEqual(E.tailFrom(msgs, 3), msgs.slice(3));
	assert.deepStrictEqual(E.tailFrom(msgs, 0), msgs);
	assert.deepStrictEqual(E.tailFrom(msgs, msgs.length), []);
});

test('LABEL: archiving/pinning is an append-only event, never a rewrite', () => {
	assert.deepStrictEqual(E.labelEvent({ lifecycle: 'archived' }, 't'), { kind: 'label', t: 't', lifecycle: 'archived' });
	assert.deepStrictEqual(E.labelEvent({ pinned: true }, 't'), { kind: 'label', t: 't', pinned: true });
});

// ── cross-module: sessionEvents output feeds sessionStore.deriveEntry correctly ───────────────────

test('END-TO-END: events built here derive the right card in sessionStore (one source of truth)', () => {
	const msgs = conversation();
	const meta = { kind: 'meta', v: 1, id: 's1', project: '/p', createdAt: 'c0', title: null };
	const events = [
		E.userTurnEvent(msgs[0], 't1'),
		E.agentTurnEvent(msgs.slice(1), 'anthropic/claude-opus-5', 't2'),
		E.titleEvent('Idempotent refunds via Redis keys', 't3'),
		E.endEvent('done', 't4')
	];
	const card = S.deriveEntry(meta, events);
	assert.strictEqual(card.title, 'Idempotent refunds via Redis keys');
	assert.strictEqual(card.turns, 1);
	assert.strictEqual(card.model, 'anthropic/claude-opus-5');
	assert.strictEqual(card.state, 'done');
	assert.deepStrictEqual(card.spark, [3], 'the sparkline came from the turn messages via the agent event');
	assert.deepStrictEqual(card.filesEdited, ['refund.rb', 'redis_lock.rb'], 'and so did the files-edited chips');
});

console.log('sessionEvents: ' + n + ' tests passed');
