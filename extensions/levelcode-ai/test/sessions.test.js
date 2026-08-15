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

test('MANAGER: restore reverses Done/Delete (the Undo behind them)', () => {
	const root = freshRoot(), slug = store.projectSlug('/pu');
	const m = createSessions({ root, slug, projectPath: '/pu' });
	m.recordTurn([{ role: 'user', content: 'x' }], 'm');
	const id = m.liveId();
	m.archive(id);
	assert.strictEqual(m.list().find((e) => e.id === id).lifecycle, 'archived');
	m.restore(id);
	assert.strictEqual(m.list().find((e) => e.id === id).lifecycle, 'active', 'restore brings an archived session back');
	m.trash(id);
	m.restore(id);
	assert.strictEqual(m.list().find((e) => e.id === id).lifecycle, 'active', 'and a trashed one too');
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

test('MEMORY: sealing a session writes one journal line (the cross-session outcome record)', () => {
	const memory = require('../sessionMemory');
	const root = freshRoot(), slug = store.projectSlug('/pm');
	const m = createSessions({ root, slug, projectPath: '/pm' });
	m.recordTurn(turn('Tidy the CHANGELOG for v1.0.4', 'RELEASE-NOTES.md'), 'anthropic/claude-opus-5');
	const id = m.liveId();
	assert.deepStrictEqual(memory.readJournal(root, slug), [], 'nothing journaled until the session seals');
	m.seal('done');
	const j = memory.readJournal(root, slug);
	assert.strictEqual(j.length, 1, 'one journal line per sealed session');
	assert.strictEqual(j[0].id, id, 'sourced back to the session');
	assert.match(j[0].title, /Tidy the CHANGELOG/);
	assert.deepStrictEqual(j[0].files, ['RELEASE-NOTES.md'], 'the outcome carries the files it touched');
	assert.strictEqual(j[0].state, 'done');
	// seal also consolidates the always-on artifact + the on-the-fly digest reflects it
	assert.ok(fs.existsSync(memory.memoryMdFile(root, slug)), 'MEMORY.md is written on seal');
	assert.match(fs.readFileSync(memory.memoryMdFile(root, slug), 'utf8'), /Tidy the CHANGELOG/, 'the digest carries the outcome');
	const d = m.digest();
	assert.strictEqual(d.recently.length, 1, 'the welcome-back digest surfaces the just-finished session');
	assert.match(d.recently[0].text, /Tidy the CHANGELOG/);
});

test('MEMORY: opts.memory=false disables journaling on seal', () => {
	const memory = require('../sessionMemory');
	const root = freshRoot(), slug = store.projectSlug('/pm2');
	const m = createSessions({ root, slug, projectPath: '/pm2', memory: false });
	m.recordTurn([{ role: 'user', content: 'x' }], 'm');
	m.seal('done');
	assert.deepStrictEqual(memory.readJournal(root, slug), [], 'no journal when memory is off');
});

test('MEMORY: refineSummary supersedes the deterministic outcome (model enrichment) + re-consolidates', () => {
	const memory = require('../sessionMemory');
	const root = freshRoot(), slug = store.projectSlug('/pref');
	const m = createSessions({ root, slug, projectPath: '/pref' });
	m.recordTurn(turn('Add idempotency to refunds', 'refund.rb'), 'm');
	const id = m.liveId();
	m.seal('done');
	assert.match(m.digest().recently[0].text, /Add idempotency to refunds/, 'starts as the goal headline');
	assert.ok(m.transcript(id).length >= 4, 'the full transcript is readable for the summarizer');

	assert.ok(m.refineSummary(id, 'Made refunds idempotent with a Redis lock; added a regression spec.'));
	assert.strictEqual(m.digest().recently[0].text, 'Made refunds idempotent with a Redis lock; added a regression spec.', 'the model outcome supersedes the headline');
	assert.match(fs.readFileSync(memory.memoryMdFile(root, slug), 'utf8'), /Redis lock/, 'MEMORY.md follows the refinement');
	assert.ok(!m.refineSummary(id, '   '), 'a blank refinement is refused');
});

test('MEMORY: recall finds a past session by a query over its outcome + files', () => {
	const root = freshRoot(), slug = store.projectSlug('/prc');
	const m = createSessions({ root, slug, projectPath: '/prc' });
	m.recordTurn(turn('Add idempotency to refunds', 'refund.rb'), 'm'); m.seal('done');
	m.recordTurn(turn('Tidy the CHANGELOG', 'RELEASE-NOTES.md'), 'm'); m.seal('done');
	const hits = m.recall('refund');
	assert.strictEqual(hits.length, 1, 'only the refunds session matches');
	assert.match(hits[0].title, /idempotency to refunds/);
	assert.deepStrictEqual(m.recall('zzz-nomatch'), [], 'no match → empty');
});

test('MEMORY: recall DEEP-scans transcripts — finds a match that lives only in the conversation, with a snippet', () => {
	const root = freshRoot(), slug = store.projectSlug('/pdeep');
	const m = createSessions({ root, slug, projectPath: '/pdeep' });
	// "kubernetes" appears in the conversation but NOT in the title / summary / files
	m.recordTurn([
		{ role: 'user', content: 'Set up the deploy' },
		{ role: 'assistant', content: 'I configured the Kubernetes ingress and a health probe.' }
	], 'm');
	m.seal('done');
	assert.strictEqual(m.recall('deploy').length, 1, 'metadata match (title) still works');
	const deep = m.recall('kubernetes');
	assert.strictEqual(deep.length, 1, 'found by the deep transcript scan, not the metadata');
	assert.match(deep[0].snippet, /Kubernetes ingress/, 'and returns a cited snippet from the conversation');
});

test('MEMORY: forget drops a session from memory (digest/recall/panel) but keeps it in History', () => {
	const root = freshRoot(), slug = store.projectSlug('/pfg');
	const m = createSessions({ root, slug, projectPath: '/pfg' });
	m.recordTurn(turn('Add idempotency to refunds', 'refund.rb'), 'm'); m.seal('done');
	assert.strictEqual(m.memoryItems().length, 1, 'the outcome is in memory');
	const id = m.memoryItems()[0].id;
	assert.ok(m.forget(id));
	assert.deepStrictEqual(m.memoryItems(), [], 'forgotten → gone from the panel');
	assert.deepStrictEqual(m.digest().recently, [], 'and from the welcome-back digest');
	assert.deepStrictEqual(m.recall('refund'), [], 'and from recall');
	assert.strictEqual(m.list().length, 1, 'but the session itself stays in History (resumable)');
});

test('MEMORY: facts — repeat promotes, confirm promotes, digest injects, not-true removes', () => {
	const memory = require('../sessionMemory');
	const root = freshRoot(), slug = store.projectSlug('/pfacts');
	const m = createSessions({ root, slug, projectPath: '/pfacts' });
	m.recordFacts('s1', ['The changelog is RELEASE-NOTES.md']);
	assert.deepStrictEqual(m.digest().facts, [], 'a once-seen fact is not injected yet (inferred)');
	m.recordFacts('s2', ['the changelog is release-notes.md']);   // 2nd source, same key → active
	assert.strictEqual(m.digest().facts.length, 1, 'seen in two sessions → active + injected');
	assert.match(fs.readFileSync(memory.memoryMdFile(root, slug), 'utf8'), /## Facts/, 'MEMORY.md gains a Facts section');

	m.recordFacts('s3', ['Tabs, not spaces']);
	const inferred = m.factsList().find((f) => /Tabs/.test(f.text));
	assert.ok(inferred && !inferred.active, 'the tabs fact is inferred until confirmed');
	m.factAction(inferred.key, 'confirm');
	assert.ok(m.digest().facts.some((f) => /Tabs/.test(f.text)), 'confirm promotes it into the digest');
	m.factAction(inferred.key, 'remove');
	assert.ok(!m.digest().facts.some((f) => /Tabs/.test(f.text)), 'not-true drops it');
});

test('MEMORY: supersedeFact drops a stale fact from the digest but keeps it (restorable) in the panel', () => {
	const memory = require('../sessionMemory');
	const root = freshRoot(), slug = store.projectSlug('/psup');
	const m = createSessions({ root, slug, projectPath: '/psup' });
	m.recordFacts('s1', ['Uses Redis for idempotency']);
	m.recordFacts('s2', ['Uses Redis for idempotency']);   // seen 2× → active
	const key = memory.normalizeFactKey('Uses Redis for idempotency');
	assert.strictEqual(m.digest().facts.length, 1, 'the fact is injected');
	assert.ok(m.supersedeFact(key, 'Moved idempotency to Postgres'));
	assert.deepStrictEqual(m.digest().facts, [], 'superseded → out of the injected digest');
	const panel = m.factsList().find((f) => /Redis/.test(f.text));
	assert.ok(panel && panel.superseded && panel.supersededBy === 'Moved idempotency to Postgres', 'still in the panel, marked superseded, with the one-line history');
	m.factAction(key, 'confirm');
	assert.strictEqual(m.digest().facts.length, 1, 'Keep/Confirm restores it to the digest');
});

// ---- Fork (experience doc §6, "the what-if-I'd-told-it-to-do-X-instead branch") -----------------

/** A sealed, archived, pinned session with two turns — every state a fork must NOT inherit. */
function forkFixture() {
	const root = freshRoot(), slug = 'proj';
	const m = createSessions({ root, slug, projectPath: '/proj', memory: false });
	m.ensure();
	m.recordTurn(turn('add idempotency', 'refund.rb'), 'opus');
	m.recordTurn(turn('now add retries', 'retry.rb'), 'opus');
	const id = m.liveId();
	m.rename(id, 'Idempotent refunds');
	m.archive(id);
	m.setPinned(id, true);
	m.seal('done');
	return { root, slug, m, id };
}

test('FORK: the copy carries the conversation and the original is left completely alone', () => {
	const { m, id } = forkFixture();
	const before = JSON.stringify(m.list().find((e) => e.id === id));

	const forkId = m.fork(id);
	assert.ok(forkId && forkId !== id, 'fork must produce a NEW session, not reuse the id');

	const fork = m.list().find((e) => e.id === forkId);
	assert.strictEqual(fork.turns, 2, 'the conversation did not come across');
	assert.deepStrictEqual(fork.filesEdited, ['refund.rb', 'retry.rb'], 'the derived work came across too');

	assert.strictEqual(JSON.stringify(m.list().find((e) => e.id === id)), before,
		'forking mutated the original — the whole promise is that it does not');
});

test('FORK: state, lifecycle and pinning belong to the ORIGINAL and do not travel', () => {
	// The event-selection rules, which are the entire design of fork(). A copied `end` would make a
	// live fork render as `done` while you typed into it; a copied `label` would have a fork of an
	// archived session born invisible in the default Active scope, or silently taking a second pin.
	const { m, id } = forkFixture();
	const forkId = m.fork(id);                       // hoisted: inside find() this runs once per row
	const fork = m.list().find((e) => e.id === forkId);
	assert.strictEqual(fork.state, 'active', "the original's terminal state was copied");
	assert.strictEqual(fork.lifecycle, 'active', 'a fork of an archived session must arrive visible');
	assert.strictEqual(fork.pinned, false, 'pinning is the original\'s, not the copy\'s');
});

test('FORK: the copy is recognisable in a list, and marked only once', () => {
	const { m, id } = forkFixture();
	const firstId = m.fork(id);
	const first = m.list().find((e) => e.id === firstId);
	assert.strictEqual(first.title, 'Idempotent refunds (fork)', 'two identical rows would be unreadable');

	// Forking a fork must not stutter into "x (fork) (fork)".
	const secondId = m.fork(first.id);
	const second = m.list().find((e) => e.id === secondId);
	assert.strictEqual(second.title, 'Idempotent refunds (fork)');
});

test('FORK: provenance is recorded, and only on a fork', () => {
	const { root, slug, m, id } = forkFixture();
	const forkId = m.fork(id);
	const meta = (f) => store.readSession(store.sessionFile(root, slug, f)).meta;
	assert.strictEqual(meta(forkId).forkedFrom, id, 'a fork must know where it came from (§4 provenance)');
	assert.ok(!('forkedFrom' in meta(id)),
		'an ordinary session gained the key — every existing file must stay byte-identical');
});

test('FORK: the copy becomes live, so the next turn appends to it and not the original', () => {
	const { m, id } = forkFixture();
	const forkId = m.fork(id);
	assert.strictEqual(m.liveId(), forkId, 'a fork IS a resume, into a copy');

	m.recordTurn(turn('try it differently', 'other.rb'), 'opus');
	assert.strictEqual(m.list().find((e) => e.id === forkId).turns, 3, 'the new turn landed on the fork');
	assert.strictEqual(m.list().find((e) => e.id === id).turns, 2, 'and NOT on the original');
});

test('FORK: a missing source fails soft, and an empty session forks without inventing turns', () => {
	const { m } = forkFixture();
	assert.strictEqual(m.fork('does-not-exist'), null, 'a gone session must not throw into the UI');
	assert.strictEqual(m.fork(''), null);

	const root2 = freshRoot();
	const m2 = createSessions({ root: root2, slug: 'p', projectPath: '/p', memory: false });
	m2.ensure();
	const emptyId = m2.liveId();
	const forkId = m2.fork(emptyId);
	assert.ok(forkId, 'a session with no turns is still forkable');
	assert.strictEqual(m2.list().find((e) => e.id === forkId).turns, 0);
});

console.log('sessions: ' + n + ' tests passed');
