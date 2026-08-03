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

test('MANAGER: resume reopens a past session live, rebuilds the transcript verbatim, and continues it', () => {
	const root = freshRoot(), slug = store.projectSlug('/pr'), st = fakeState();
	const m = createSessions({ root, slug, projectPath: '/pr', state: st });
	m.recordTurn(turn('Build the parser', 'parser.js'), 'anthropic/claude-opus-5');
	const id = m.liveId();
	m.seal('done');
	assert.strictEqual(m.liveId(), null, 'sealed → nothing live');

	const r = m.resume(id, { contextWindow: 200000 }); // roomy window → tier 1, verbatim
	assert.ok(r, 'resume returns a plan');
	assert.strictEqual(r.plan.tier, 1, 'fits the window → verbatim');
	assert.strictEqual(r.note, '', 'nothing to apologize for on a verbatim resume');
	assert.deepStrictEqual(r.messages, turn('Build the parser', 'parser.js'), 'the model resumes with the exact transcript');
	assert.deepStrictEqual(r.full, r.messages, 'full == messages when verbatim');
	assert.strictEqual(m.liveId(), id, 're-attached: this session is live again');
	assert.strictEqual(st.store.liveSessionId, id, 'the pointer follows the resume');

	m.recordTurn([{ role: 'user', content: 'add error recovery' }, { role: 'assistant', content: 'done' }], 'm');
	assert.strictEqual(m.list().length, 1, 'still one session — resume continued it, did not fork');
	assert.strictEqual(m.list()[0].turns, 2, 'the new turn appended to the same session');
});

test('MANAGER: resume on a session too big for the window plans a compacted load + an honest note', () => {
	const root = freshRoot(), slug = store.projectSlug('/pr2');
	const m = createSessions({ root, slug, projectPath: '/pr2' });
	for (let i = 0; i < 6; i++) {
		m.recordTurn([{ role: 'user', content: 'turn ' + i + ' ' + 'x'.repeat(400) }, { role: 'assistant', content: 'ok ' + 'y'.repeat(400) }], 'm');
	}
	const id = m.liveId(); m.seal('done');
	// ~400-token budget, transcript far bigger → compacts; keepTailTurns:2 keeps the last two turns verbatim
	const r = m.resume(id, { contextWindow: 1000, budgetPct: 40, keepTailTurns: 2 });
	assert.ok(r.plan.tier >= 2, 'too big to load verbatim → a compacted tier');
	assert.ok(r.messages.length < r.full.length, 'the model gets only the recent tail, not the whole history');
	assert.match(r.note, /Resumed from/, 'and the user is told it was summarized');
});

test('MANAGER: resume of a missing session returns null (deleted out from under us)', () => {
	const root = freshRoot(), slug = store.projectSlug('/pr3');
	const m = createSessions({ root, slug, projectPath: '/pr3' });
	assert.strictEqual(m.resume('nope-does-not-exist', { contextWindow: 1000 }), null);
});

test('MANAGER: archive / rename / trash are append-only edits that update the index row', () => {
	const root = freshRoot(), slug = store.projectSlug('/pl');
	const m = createSessions({ root, slug, projectPath: '/pl' });
	m.recordTurn([{ role: 'user', content: 'original prompt' }], 'm');
	const id = m.liveId();
	assert.strictEqual(m.list()[0].lifecycle, 'active');

	assert.ok(m.rename(id, '  Refund idempotency  '));
	assert.strictEqual(m.list().find((e) => e.id === id).title, 'Refund idempotency', 'rename trims + overrides the derived title');
	assert.ok(!m.rename(id, '   '), 'a blank rename is refused');

	assert.ok(m.archive(id));
	assert.strictEqual(m.list().find((e) => e.id === id).lifecycle, 'archived', 'Done archives (reversible), never deletes');
	assert.ok(m.trash(id));
	assert.strictEqual(m.list().find((e) => e.id === id).lifecycle, 'trashed', 'the latest label event wins');
});

test('MANAGER: autoArchiveStale fades stale, non-pinned sessions and exempts pinned + recent', () => {
	const root = freshRoot(), slug = store.projectSlug('/aa');
	const DAY = 86400000;
	const T0 = Date.parse('2026-06-01T12:00:00Z');   // "now" for the sweep
	// stamp a whole session at a chosen wall-clock time (clock injected), optionally pinned at that same time
	const sessionAt = (ms, prompt, pin) => {
		const mm = createSessions({ root, slug, projectPath: '/aa', now: () => new Date(ms) });
		mm.recordTurn([{ role: 'user', content: prompt }], 'm');
		const id = mm.liveId();
		if (pin) { mm.setPinned(id, true); }         // pin stamped old too, so it's genuinely old AND pinned
		mm.seal('done');
		return id;
	};
	const oldId = sessionAt(T0 - 40 * DAY, 'ancient');            // 40d old, unpinned → stale
	const recentId = sessionAt(T0 - 5 * DAY, 'recent');          // 5d old → kept
	const pinnedOldId = sessionAt(T0 - 90 * DAY, 'kept', true);  // 90d old but pinned → exempt

	const m = createSessions({ root, slug, projectPath: '/aa', now: () => new Date(T0) });
	assert.strictEqual(m.autoArchiveStale({ days: 30, nowMs: T0 }), 1, 'only the stale, non-pinned session faded');
	const byId = (id) => m.list().find((e) => e.id === id);
	assert.strictEqual(byId(oldId).lifecycle, 'archived', 'the 40-day-old session auto-archived');
	assert.strictEqual(byId(recentId).lifecycle, 'active', 'the 5-day-old session stayed');
	assert.strictEqual(byId(pinnedOldId).lifecycle, 'active', 'a pinned session is exempt however old');
	assert.strictEqual(m.autoArchiveStale({ days: 30, nowMs: T0 }), 0, 'idempotent — already-archived are skipped');
});

console.log('sessions: ' + n + ' tests passed');
