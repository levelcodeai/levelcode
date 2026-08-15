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

test('DISPLAY: toDisplayTurns folds a raw transcript into the readable prompts + prose to replay', () => {
	const turns = E.toDisplayTurns(conversation());
	assert.deepStrictEqual(turns, [
		{ role: 'user', text: 'add idempotency to refunds' },   // the user's typed prompt
		{ role: 'assistant', text: 'reading' },                 // the text block, not the read_file tool_use
		{ role: 'assistant', text: 'Done: idempotent refunds via Redis keys' }
	], 'tool_result user messages and tool_use-only assistant turns are dropped');
});

test('DISPLAY: toDisplayTurns is tolerant of junk and joins multiple text blocks', () => {
	assert.deepStrictEqual(E.toDisplayTurns(null), []);
	assert.deepStrictEqual(E.toDisplayTurns([null, { role: 'system', content: 'x' }, { role: 'user', content: '' }]), [], 'empty/other roles skipped');
	const joined = E.toDisplayTurns([{ role: 'assistant', content: [{ type: 'text', text: 'one' }, { type: 'tool_use', id: 'a', name: 'x' }, { type: 'text', text: 'two' }] }]);
	assert.deepStrictEqual(joined, [{ role: 'assistant', text: 'one\n\ntwo' }]);
});

// ---- Export: "Copy as Markdown" -----------------------------------------------------------------

const META = {
	id: 's1', title: 'Idempotent refunds via Redis keys', model: 'anthropic/claude-opus-5',
	createdAt: '2026-07-28T09:00:00Z', updatedAt: '2026-07-28T10:00:00Z',
	filesEdited: ['refund.rb', 'redis_lock.rb']
};

test('EXPORT: a session renders as a transcript with provenance and one block per turn', () => {
	const md = E.toMarkdown(META, conversation());
	assert.match(md, /^# Idempotent refunds via Redis keys\n/, 'the title is the H1');
	assert.match(md, /_LevelCode session · 2026-07-28 · 3 turns · `anthropic\/claude-opus-5` · `refund\.rb`, `redis_lock\.rb`_/,
		'one subtitle line carries date, turn count, model and files');
	// Roles read in order, and the plumbing toDisplayTurns drops stays dropped.
	assert.deepStrictEqual(md.match(/\*\*(You|LevelCode)\*\*/g), ['**You**', '**LevelCode**', '**LevelCode**']);
	assert.match(md, /add idempotency to refunds/);
	assert.ok(!/tool_result|tool_use/.test(md), 'raw tool plumbing leaked into a shareable document');
});

test('EXPORT: roles are BOLD, never headings — a turn owns the heading levels', () => {
	// A reply that opens with "# Plan" would visually outrank an "### LevelCode" label, and the
	// document would read as though the model had written the section title.
	const md = E.toMarkdown(META, [{ role: 'assistant', content: '# Plan\n\n## Step one\n\n```js\nconst x = 1;\n```' }]);
	assert.ok(!/^#{2,6} (You|LevelCode)/m.test(md), 'a role was rendered as a heading');
	assert.match(md, /\n---\n\n\*\*LevelCode\*\*\n/, 'turns are separated by a rule');
	assert.match(md, /```js\nconst x = 1;\n```/, 'fenced code survives verbatim');
	assert.match(md, /^## Step one$/m, "the turn's own headings are untouched");
});

test('EXPORT: turn text is VERBATIM — indented code + a trailing hard-break survive (not trimmed)', () => {
	// Trimming the turn would de-indent a leading 4-space (killing an indented code block) and eat the two
	// trailing spaces of a Markdown hard line break. Export must preserve the text as written, save redaction.
	const turn = '    indented = code()\n\nfinal line ends with a hard break  ';
	const md = E.toMarkdown(META, [{ role: 'assistant', content: turn }]);
	assert.match(md, /\*\*LevelCode\*\*\n\n {4}indented = code\(\)/, 'the leading 4-space indent survives (indented code block)');
	assert.match(md, /hard break {2}\n/, 'the trailing two-space hard line break survives');
});

test('EXPORT: scrubs, because export is the first surface that SHARES a session', () => {
	// chat-sessions-design §10: "anything that later shares a session must scrub — that is that
	// feature's burden." A token pasted into chat must not ride into a pull request.
	const M = require('../sessionMemory');
	const pat = ['ghp', '_', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'].join('');   // split: push protection
	const md = E.toMarkdown(
		Object.assign({}, META, { title: 'Why is ' + pat + ' rejected?', filesEdited: ['key-' + pat + '.txt'] }),
		[{ role: 'user', content: 'my token is ' + pat + ' — why 401?' }],
		{ redact: M.redactSecrets }
	);
	assert.ok(!md.includes(pat), 'a credential reached the exported document: ' + md);
	assert.ok(md.includes('[redacted]'), 'scrubbed invisibly — the reader cannot tell something was removed');
	assert.match(md, /why 401\?/, 'redaction ate the surrounding message');
});

test('EXPORT: redaction is OPT-IN at the call site, so the scrub is never accidental', () => {
	// No `redact` → identity. The caller must ask for it, which is what makes the wiring auditable
	// rather than a property you have to remember this module has.
	const md = E.toMarkdown(META, [{ role: 'user', content: 'plain text' }]);
	assert.match(md, /plain text/);
});

test('EXPORT: degenerate sessions still produce a truthful document', () => {
	const empty = E.toMarkdown({ title: 'Nothing happened' }, []);
	assert.match(empty, /^# Nothing happened\n/, 'a header with no turns beats an empty string');
	assert.match(empty, /0 turns/);
	assert.ok(!/undefined|NaN|null/.test(empty), 'missing metadata leaked as a placeholder: ' + empty);

	const bare = E.toMarkdown(null, null);
	assert.match(bare, /^# Untitled session\n/);
	assert.ok(!/undefined|NaN|null/.test(bare), bare);

	assert.match(E.toMarkdown({ title: '   ' }, []), /^# Untitled session\n/, 'a whitespace title is no title');
	// Also pins the no-blanks rule: with no model and no files, "1 turn" is simply the last bit —
	// there is no trailing separator dangling where a value would have been.
	assert.match(E.toMarkdown({ title: 'One', updatedAt: '2026-07-28T10:00:00Z' },
		[{ role: 'user', content: 'hi' }]), /_LevelCode session · 2026-07-28 · 1 turn_/, 'singular, and no empty fields');
});

console.log('sessionEvents: ' + n + ' tests passed');
