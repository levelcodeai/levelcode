/*---------------------------------------------------------------------------------------------
 *  sessions — the live-session lifecycle manager — run: node test/sessions.test.js
 *
 *  Drives the manager the way extension.js will: recordTurn(this turn's messages), seal on New Chat, list
 *  for the panel. Asserts a turn is persisted + derives the right card, the FULL transcript rebuilds
 *  verbatim (not the trimmed live window), seal writes the terminal state and clears the pointer, and a
 *  turn after seal opens a fresh session (old one stays in History). Real store, temp dir, fake pointer.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const store = require('../sessionStore');
const events = require('../sessionEvents');
const { createSessions } = require('../sessions');

let n = 0;
function test(name, fn) { fn(); n++; console.log('  ok - ' + name); }

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-sessmgr-'));
process.on('exit', () => { try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best effort */ } });
let seq = 0;
const freshRoot = () => path.join(tmpRoot, 'r' + (seq++));
const fakeState = () => { const s = {}; return { store: s, get: (k) => s[k], set: (k, v) => { s[k] = v; } }; };

const turn = (prompt, editPath) => [
	{ role: 'user', content: prompt },
	{ role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 'edit_file', input: { path: editPath } }] },
	{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a' }] },
	{ role: 'assistant', content: 'Done.' }
];

test('MANAGER: the first turn creates + persists a session and lists it with the derived row', () => {
	const root = freshRoot(), slug = store.projectSlug('/proj'), st = fakeState();
	const m = createSessions({ root, slug, projectPath: '/proj', state: st });
	assert.strictEqual(m.liveId(), null, 'no session before the first turn');

	m.recordTurn(turn('Add idempotency to refunds', 'refund.rb'), 'anthropic/claude-opus-5');
	assert.ok(m.liveId(), 'a session is live after the first turn');
	assert.strictEqual(st.store.liveSessionId, m.liveId(), 'the workspaceState pointer tracks it');

	const entries = m.list();
	assert.strictEqual(entries.length, 1);
	const e = entries[0];
	assert.match(e.title, /Add idempotency/, 'title falls back to the first user message');
	assert.strictEqual(e.turns, 1);
	assert.strictEqual(e.model, 'anthropic/claude-opus-5');
	assert.deepStrictEqual(e.filesEdited, ['refund.rb'], 'files-edited derives from the agent event');
	assert.deepStrictEqual(e.spark, [1]);
	assert.strictEqual(e.state, 'active', 'a live session is active until sealed');
});

test('MANAGER: the persisted transcript rebuilds VERBATIM (full history, not the trimmed window)', () => {
	const root = freshRoot(), slug = store.projectSlug('/p2');
	const m = createSessions({ root, slug, projectPath: '/p2' });
	const t1 = [{ role: 'user', content: 'one' }, { role: 'assistant', content: 'a1' }];
	const t2 = [{ role: 'user', content: 'two' }, { role: 'assistant', content: 'a2' }];
	m.recordTurn(t1, 'm');
	m.recordTurn(t2, 'm');
	const rebuilt = events.eventsToMessages(store.readSession(store.sessionFile(root, slug, m.liveId())).events);
	assert.deepStrictEqual(rebuilt, t1.concat(t2), 'both turns, in order, byte-identical — the append-only history');
	assert.strictEqual(m.list()[0].turns, 2, 'two user turns counted');
});

test('MANAGER: seal writes the terminal state, clears the pointer, and a new turn opens a fresh session', () => {
	const root = freshRoot(), slug = store.projectSlug('/p3'), st = fakeState();
	const m = createSessions({ root, slug, projectPath: '/p3', state: st });
	m.recordTurn([{ role: 'user', content: 'hi' }], 'm');
	const first = m.liveId();

	m.seal('done');
	assert.strictEqual(m.liveId(), null, 'no live session after seal');
	assert.strictEqual(st.store.liveSessionId, null, 'pointer cleared on seal');
	assert.strictEqual(m.list().find((x) => x.id === first).state, 'done', 'the sealed session records its terminal state');

	m.recordTurn([{ role: 'user', content: 'a new chat' }], 'm');
	assert.notStrictEqual(m.liveId(), first, 'New Chat starts a fresh session; the old one stays in History');
	assert.strictEqual(m.list().length, 2);
});

test('CALLER CONTRACT: recordTurn(slice-from-goal) captures exactly this turn as the live window grows + trims', () => {
	// Mirrors extension.js: agentMessages persists across turns and is trimmed to a tail each turn; the caller
	// snapshots indexOf(goal) post-trim and records agentMessages.slice(from). This proves the persisted
	// session stays the FULL history even after the live window drops older turns.
	const root = freshRoot(), slug = store.projectSlug('/p5');
	const m = createSessions({ root, slug, projectPath: '/p5' });
	let win = [];
	const turnFlow = (goalText, reply) => {
		const goal = { role: 'user', content: goalText };
		win.push(goal);
		if (win.length > 3) { win = win.slice(win.length - 3); } // a real trim keeps the tail incl. the just-pushed goal
		const from = win.indexOf(goal);
		win.push({ role: 'assistant', content: reply }); // runAgent appends the agent's messages
		m.recordTurn(win.slice(from), 'm');
	};
	turnFlow('first goal', 'a1');
	turnFlow('second goal', 'a2'); // by now the window has trimmed 'first goal' away
	turnFlow('third goal', 'a3');
	const rebuilt = events.eventsToMessages(store.readSession(store.sessionFile(root, slug, m.liveId())).events);
	assert.deepStrictEqual(rebuilt, [
		{ role: 'user', content: 'first goal' }, { role: 'assistant', content: 'a1' },
		{ role: 'user', content: 'second goal' }, { role: 'assistant', content: 'a2' },
		{ role: 'user', content: 'third goal' }, { role: 'assistant', content: 'a3' }
	], 'the session is the full append-only history even though the live window only ever held 3 messages');
	assert.strictEqual(m.list()[0].turns, 3);
});

test('MANAGER: an interrupted run seals as interrupted (honest history)', () => {
	const root = freshRoot(), slug = store.projectSlug('/p4');
	const m = createSessions({ root, slug, projectPath: '/p4' });
	m.recordTurn([{ role: 'user', content: 'go' }], 'm');
	const id = m.liveId();
	m.seal('interrupted');
	assert.strictEqual(m.list().find((x) => x.id === id).state, 'interrupted');
});

console.log('sessions: ' + n + ' tests passed');
