/*---------------------------------------------------------------------------------------------
 *  Rich diagrams — stored with the session — run: node test/diagramSession.test.js
 *
 *  docs/RICH-DIAGRAMS.md, "Storage": "The repaired spec is stored and marked as repaired, so
 *  re-opening a chat never re-runs repair." And NFR-4: old chats keep rendering.
 *
 *  A diagram is the FINAL record — what was drawn, after the ladder — appended to the session as its
 *  own event. Reopening the session hands those records back untouched and replays each one at the
 *  place in the answer where the model drew it. Nothing here validates, fixes, or asks a model.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const E = require('../sessionEvents');
const store = require('../sessionStore');
const { createSessions } = require('../sessions');
const { createDiagrams } = require('../diagram/service');
const tool = require('../diagram/tool');
const text = require('../diagram/text');

let n = 0;
function test(name, fn) { fn(); n++; console.log('  ok - ' + name); }

const jev = () => ({
	title: 'Jev classifies; your code decides the action',
	nodes: [{ id: 'in', label: 'Customer message' }, { id: 'jev', label: 'Jev', accent: true }, { id: 'bill', label: 'Route to billing' }],
	edges: [{ from: 'in', to: 'jev' }, { from: 'jev', to: 'bill', label: '0.90 or more' }]
});
const broken = () => { const s = jev(); s.edges.push({ from: 'jev', to: 'ghost' }); return s; };

/** A turn as the agent loop leaves it: prose, a diagram call, its result, more prose. */
function turnWith(calls) {
	const msgs = [{ role: 'user', content: 'how is a message routed?' }];
	for (const c of calls) {
		msgs.push({ role: 'assistant', content: [{ type: 'text', text: c.before }, { type: 'tool_use', id: c.id, name: 'render_diagram', input: c.input }] });
		msgs.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: c.id, content: c.result }] });
	}
	msgs.push({ role: 'assistant', content: [{ type: 'text', text: 'Done: that is the whole route.' }] });
	return msgs;
}
function fresh() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-dsess-'));
	let t = Date.parse('2026-10-04T10:00:00Z');
	const m = createSessions({ root, slug: 'proj', projectPath: '/proj', memory: false, now: () => new Date(t += 1000) });
	return { root, m };
}
/** Draw with the real service, so the records are exactly what the host would store. */
function draw(service, specs) {
	service.beginRun();
	const calls = specs.map((input, i) => {
		const id = 'toolu_' + (i + 1);
		const out = service.render(input, { key: id, model: 'test-model' });
		return { id, input, result: out.result, before: 'Here is diagram ' + (i + 1) + '.' };
	});
	service.endRun();
	return calls;
}

test('NAME: the session replay looks for the same tool the agent offers', () => {
	assert.strictEqual(E.DIAGRAM_TOOL, tool.RENDER_DIAGRAM.name);
});

test('STORE: a turn\'s diagrams are appended after it, and the conversation itself is untouched', () => {
	const { root, m } = fresh();
	const service = createDiagrams();
	const msgs = turnWith(draw(service, [jev()]));
	const records = service.takeNew();
	assert.strictEqual(records.length, 1);
	m.recordTurn(msgs, 'test-model', { diagrams: records });
	const id = m.liveId();
	const parsed = store.readSession(store.sessionFile(root, 'proj', id));
	assert.deepStrictEqual(parsed.events.map((e) => e.kind), ['user', 'agent', 'diagram']);
	assert.deepStrictEqual(E.eventsToMessages(parsed.events), msgs, 'the rebuilt messages are exactly the conversation — no diagram record leaks into what the model is sent');
	assert.deepStrictEqual(m.diagrams(id), JSON.parse(JSON.stringify(records)));
	const entry = store.deriveEntry(parsed.meta, parsed.events);
	assert.strictEqual(entry.turns, 1, 'a diagram is not a turn');
	assert.strictEqual(entry.title, 'how is a message routed?');
	assert.deepStrictEqual(service.takeNew(), [], 'taken once');
});

test('REPLAY: reopening shows each diagram where the model drew it — between the prose before and after', () => {
	const { m } = fresh();
	const service = createDiagrams();
	const two = { title: 'A second picture', nodes: [{ id: 'x', label: 'X' }, { id: 'y', label: 'Y' }], edges: [{ from: 'x', to: 'y' }] };
	const msgs = turnWith(draw(service, [jev(), two]));
	m.recordTurn(msgs, 'test-model', { diagrams: service.takeNew() });
	const id = m.liveId();
	m.seal('done');
	const r = m.resume(id);
	assert.deepStrictEqual(r.turns.map((t) => t.role + (t.text ? ':' + t.text : ':' + t.record.id)), [
		'user:how is a message routed?',
		'assistant:Here is diagram 1.', 'diagram:d-1',
		'assistant:Here is diagram 2.', 'diagram:d-2',
		'assistant:Done: that is the whole route.'
	]);
	assert.strictEqual(r.turns[2].key, 'toolu_1');
	assert.deepStrictEqual(r.diagrams.map((d) => d.id), ['d-1', 'd-2']);
	assert.deepStrictEqual(E.toDisplayTurns(r.full), r.turns.filter((t) => t.role !== 'diagram'), 'without the records the replay is exactly the prose it always was');
});

test('REPLAY: never re-runs repair — a stored record comes back exactly as stored, whatever today\'s rules say', () => {
	const { m } = fresh();
	// A record as an OLDER build might have stored it: degraded, with a note, and a field this build does not know.
	const old = { id: 'd-1', key: 'toolu_1', v: 1, at: '2026-01-01T00:00:00.000Z', status: 'degraded', repaired: false,
		spec: { v: 1, title: 'Drawn long ago', direction: 'right', nodes: Array.from({ length: 15 }, (_, i) => ({ id: 'n' + i, label: 'Step ' + i })), edges: [] },
		fixes: [], notes: ['15 nodes — over the 12-node limit, drawn anyway'], errors: ['/nodes: 15 nodes, max 12.'], legacyField: 'kept' };
	const msgs = turnWith([{ id: 'toolu_1', input: old.spec, result: '{"ok":true,"id":"d-1"}', before: 'Here.' }]);
	m.recordTurn(msgs, 'm', { diagrams: [old] });
	const id = m.liveId(); m.seal('done');
	const r = m.resume(id);
	assert.deepStrictEqual(r.diagrams, [old], 'byte for byte');
	assert.deepStrictEqual(r.turns.find((t) => t.role === 'diagram').record, old);
});

test('REPLAY: a repaired diagram is shown once, at the call that got it right; a failed first try leaves nothing behind', () => {
	const { m } = fresh();
	const service = createDiagrams();
	const msgs = turnWith(draw(service, [broken(), jev()]));
	const records = service.takeNew();
	assert.deepStrictEqual(records.map((r) => [r.key, r.status, !!r.repaired]), [['toolu_2', 'ok', true]], 'one record: the repaired one, marked as repaired');
	m.recordTurn(msgs, 'm', { diagrams: records });
	const id = m.liveId(); m.seal('done');
	const turns = m.resume(id).turns;
	assert.deepStrictEqual(turns.filter((t) => t.role === 'diagram').map((t) => t.key), ['toolu_2']);
	const at = turns.findIndex((t) => t.role === 'diagram');
	assert.strictEqual(turns[at - 1].text, 'Here is diagram 2.', 'under the prose of the call that drew it');
});

test('REPLAY: a drawing that a later one replaced is not replayed — the chat never showed both', () => {
	const { m } = fresh();
	const service = createDiagrams();
	const down = jev(); down.direction = 'down';
	const msgs = turnWith(draw(service, [jev(), down]));
	const records = service.takeNew();
	assert.strictEqual(records[1].replaces, 'd-1');
	m.recordTurn(msgs, 'm', { diagrams: records });
	const id = m.liveId(); m.seal('done');
	const r = m.resume(id);
	assert.deepStrictEqual(r.turns.filter((t) => t.role === 'diagram').map((t) => t.record.id), ['d-2']);
	assert.deepStrictEqual(r.diagrams.map((d) => d.id), ['d-1', 'd-2'], 'but both stay on file — the store is append-only');
});

test('REPLAY: a diagram the run had to settle on its own (the model never answered) is stored and replayed too', () => {
	const { m } = fresh();
	const service = createDiagrams();
	service.beginRun();
	const out = service.render(broken(), { key: 'toolu_1', model: 'm' });
	assert.match(out.result, /^ERROR/);
	const settled = service.endRun();
	assert.strictEqual(settled[0].record.status, 'degraded');
	const msgs = [{ role: 'user', content: 'draw it' },
		{ role: 'assistant', content: [{ type: 'text', text: 'Drawing.' }, { type: 'tool_use', id: 'toolu_1', name: 'render_diagram', input: broken() }] },
		{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: out.result }] },
		{ role: 'assistant', content: [{ type: 'text', text: 'Done: in words instead.' }] }];
	m.recordTurn(msgs, 'm', { diagrams: service.takeNew() });
	const id = m.liveId(); m.seal('done');
	const turns = m.resume(id).turns;
	assert.deepStrictEqual(turns.map((t) => t.role), ['user', 'assistant', 'diagram', 'assistant']);
	assert.deepStrictEqual(turns[2].record.notes, ['1 edge dropped: unknown nodes']);
});

test('RELOAD: the service takes the stored records back — ids carry on, links and get_diagram work', () => {
	const { m } = fresh();
	const first = createDiagrams();
	m.recordTurn(turnWith(draw(first, [jev()])), 'm', { diagrams: first.takeNew() });
	const id = m.liveId(); m.seal('done');
	const second = createDiagrams();
	second.load(m.resume(id).diagrams);
	assert.strictEqual(second.get('d-1').spec.title, 'Jev classifies; your code decides the action');
	assert.strictEqual(second.byToolUse('toolu_1').id, 'd-1');
	assert.strictEqual(JSON.parse(second.fetch('d-1')).nodes.length, 3);
	second.beginRun();
	assert.strictEqual(JSON.parse(second.render({ title: 'Next', nodes: [{ id: 'a', label: 'A' }], edges: [] }, { key: 'toolu_9' }).result).id, 'd-2', 'a new diagram does not reuse an id');
	assert.deepStrictEqual(second.takeNew().map((r) => r.id), ['d-2'], 'and only the new one is new');
	second.load([{ id: 'not-an-id' }, null, { id: 'd-7', key: 'k', spec: null, status: 'failed' }]);
	assert.deepStrictEqual(second.list().map((r) => r.id), ['d-7'], 'junk in a session file is skipped, not trusted');
	assert.match(second.fetch('d-7'), /^ERROR: diagram d-7 was never drawn/);
});

test('FORK: a forked session carries its diagrams with it', () => {
	const { m } = fresh();
	const service = createDiagrams();
	m.recordTurn(turnWith(draw(service, [jev()])), 'm', { diagrams: service.takeNew() });
	const id = m.liveId(); m.seal('done');
	const forked = m.fork(id);
	assert.ok(forked && forked !== id);
	assert.deepStrictEqual(m.diagrams(forked).map((d) => d.id), ['d-1']);
	assert.deepStrictEqual(m.diagrams(id).map((d) => d.id), ['d-1'], 'the original is untouched');
});

test('STUBS: at compaction a spec is replaced by one line — and only for diagrams that were drawn', () => {
	const service = createDiagrams();
	const msgs = turnWith(draw(service, [jev(), { title: 'Nothing', nodes: [], edges: [] }]));
	assert.deepStrictEqual(service.stubsFor(msgs), ['diagram: Jev classifies; your code decides the action, 3 nodes, id d-1']);
	assert.deepStrictEqual(service.stubsFor(msgs.slice(0, 1)), [], 'none in a stretch with no diagram');
	assert.deepStrictEqual(service.stubsFor(null), []);
});

test('STUBS: a drawing that a later one replaced is not handed back to the model — it sees what the user sees', () => {
	const { m } = fresh();
	const service = createDiagrams();
	const down = jev(); down.direction = 'down';
	const again = jev(); again.nodes.push({ id: 'rev', label: 'Human review' });
	const msgs = turnWith(draw(service, [jev(), down, again]));
	assert.deepStrictEqual(service.list().map((r) => r.id + ':' + (r.replaces || '-')), ['d-1:-', 'd-2:d-1', 'd-3:d-2']);
	// compaction: one line, for the drawing that is on screen
	assert.deepStrictEqual(service.stubsFor(msgs), ['diagram: Jev classifies; your code decides the action, 4 nodes, id d-3']);
	// the cut can fall between a drawing and the one that replaced it: the replaced one still leaves no stub
	assert.deepStrictEqual(service.stubsFor(msgs.slice(0, 3)), [], 'd-1 is gone from the chat even though d-2 is not in this stretch');
	// an id the model remembers from before the redraw leads to the drawing that took its place
	assert.strictEqual(service.fetch('d-1'), 'ERROR: diagram d-1 was replaced by d-3 — the chat shows d-3. Call get_diagram with "d-3".');
	assert.strictEqual(service.fetch('d-2'), 'ERROR: diagram d-2 was replaced by d-3 — the chat shows d-3. Call get_diagram with "d-3".');
	assert.strictEqual(JSON.parse(service.fetch('d-3')).nodes.length, 4);
	assert.strictEqual(service.fetch('d-9'), 'ERROR: no diagram with id "d-9" in this session. Known ids: d-3.', 'and it is not offered as one to ask for');
	// the same after the session is reopened: the records come back, replaced ones included
	m.recordTurn(msgs, 'm', { diagrams: service.takeNew() });
	const id = m.liveId(); m.seal('done');
	const second = createDiagrams();
	second.load(m.resume(id).diagrams);
	assert.deepStrictEqual(second.list().map((r) => r.id), ['d-1', 'd-2', 'd-3'], 'the store is append-only: all three are on file');
	assert.deepStrictEqual(second.stubsFor(msgs), ['diagram: Jev classifies; your code decides the action, 4 nodes, id d-3']);
	assert.match(second.fetch('d-1'), /^ERROR: diagram d-1 was replaced by d-3/);
	// a record that says it replaces ITSELF, or two that name each other, is a damaged file — not a reason to hang
	second.load([{ id: 'd-1', key: 'a', spec: jev(), status: 'ok', replaces: 'd-2' }, { id: 'd-2', key: 'b', spec: jev(), status: 'ok', replaces: 'd-1' }, { id: 'd-3', key: 'c', spec: jev(), status: 'ok', replaces: 'd-3' }]);
	assert.match(second.fetch('d-1'), /^ERROR: diagram d-1 was replaced by d-2 /);
	assert.match(second.fetch('d-2'), /^ERROR: diagram d-2 was replaced by d-1 /);
	assert.deepStrictEqual(second.stubsFor([{ role: 'assistant', content: ['a', 'b', 'c'].map((id) => ({ type: 'tool_use', id, name: 'render_diagram', input: {} })) }]), ['diagram: Jev classifies; your code decides the action, 3 nodes, id d-3']);
	assert.strictEqual(JSON.parse(second.fetch('d-3')).nodes.length, 3, 'a drawing cannot replace itself');
});

test('REPLAY: a picture drawn between two pieces of prose in ONE message comes back between them', () => {
	const { m } = fresh();
	const service = createDiagrams();
	service.beginRun();
	const out = service.render(jev(), { key: 'toolu_1', model: 'm' });
	const other = service.render({ title: 'A second picture', nodes: [{ id: 'x', label: 'X' }], edges: [] }, { key: 'toolu_2', model: 'm' });
	service.endRun();
	const msgs = [{ role: 'user', content: 'how is a message routed?' },
		{ role: 'assistant', content: [{ type: 'text', text: 'First, the route.' }, { type: 'text', text: 'It has three stops.' }, { type: 'tool_use', id: 'toolu_1', name: 'render_diagram', input: jev() },
			{ type: 'text', text: 'Now the same thing as a list.' }, { type: 'tool_use', id: 'toolu_7', name: 'read_file', input: { path: 'a.js' } }, { type: 'text', text: 'And one more picture.' },
			{ type: 'tool_use', id: 'toolu_2', name: 'render_diagram', input: {} }] },
		{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: out.result }, { type: 'tool_result', tool_use_id: 'toolu_7', content: 'x' }, { type: 'tool_result', tool_use_id: 'toolu_2', content: other.result }] },
		{ role: 'assistant', content: [{ type: 'text', text: 'Done: that is the whole route.' }] }];
	m.recordTurn(msgs, 'm', { diagrams: service.takeNew() });
	const id = m.liveId(); m.seal('done');
	const r = m.resume(id);
	assert.deepStrictEqual(r.turns.map((t) => t.role + (t.cont ? '+' : '') + ':' + (t.text !== undefined ? t.text : t.record.id)), [
		'user:how is a message routed?',
		'assistant:First, the route.\n\nIt has three stops.',
		'diagram+:d-1',
		'assistant+:Now the same thing as a list.\n\nAnd one more picture.',   // another tool's call is plumbing: it splits nothing
		'diagram+:d-2',
		'assistant:Done: that is the whole route.'
	], 'prose, picture, prose, picture — the order the model wrote them in; "+" is the same message going on');
	// the words are the same words: only where the pictures stand has changed
	const prose = (turns) => turns.filter((t) => t.role === 'assistant').map((t) => t.text).join('\n\n');
	assert.strictEqual(prose(r.turns), prose(E.toDisplayTurns(r.full)));
	assert.deepStrictEqual(E.toDisplayTurns(r.full).map((t) => t.role), ['user', 'assistant', 'assistant'], 'and without the records it is the prose it always was, one turn per message');
	// a call that drew nothing (sent back, replaced, somebody else's) does not cut the prose around it
	const quiet = [{ role: 'assistant', content: [{ type: 'text', text: 'one' }, { type: 'tool_use', id: 'toolu_404', name: 'render_diagram', input: {} }, { type: 'text', text: 'two' }] }];
	assert.deepStrictEqual(E.toDisplayTurns(quiet, service.list()), [{ role: 'assistant', text: 'one\n\ntwo' }]);
	const redrawn = [{ id: 'd-1', key: 'toolu_404', spec: jev(), status: 'ok' }, { id: 'd-2', key: 'toolu_405', spec: jev(), status: 'ok', replaces: 'd-1' }];
	assert.deepStrictEqual(E.toDisplayTurns(quiet, redrawn), [{ role: 'assistant', text: 'one\n\ntwo' }], 'a replaced drawing is not on screen, so it is not a place in the answer either');
	// a record that names ITSELF as what it replaces is a damaged file, not a reason to hide the picture
	const itself = [{ id: 'd-1', key: 'toolu_404', spec: jev(), status: 'ok', replaces: 'd-1' }];
	assert.deepStrictEqual(E.toDisplayTurns(quiet, itself).map((t) => t.role), ['assistant', 'diagram', 'assistant']);
	// a picture that opens the message, and one that closes it
	const edges = E.toDisplayTurns([{ role: 'assistant', content: [{ type: 'text', text: '   ' }, { type: 'tool_use', id: 'toolu_1', name: 'render_diagram', input: {} }, { type: 'text', text: 'after' },
		{ type: 'tool_use', id: 'toolu_2', name: 'render_diagram', input: {} }, { type: 'text', text: '\n' }] }], service.list());
	assert.deepStrictEqual(edges.map((t) => t.role + (t.cont ? '+' : '') + ':' + (t.text || t.record.id)), ['diagram:d-1', 'assistant+:after', 'diagram+:d-2'], 'blank text is still no turn, before a picture or after one');
});

test('EXPORT: a session copied as Markdown carries each diagram as a Mermaid block, where it stood — and scrubbed', () => {
	const service = createDiagrams();
	const secret = jev(); secret.nodes[0].label = 'key sk-live-1234567890';
	const msgs = turnWith(draw(service, [secret]));
	const md = E.toMarkdown({ title: 'Routing', updatedAt: '2026-10-04T10:00:00Z' }, msgs, {
		diagrams: service.list(),
		diagram: (r) => ({ lang: 'mermaid', body: text.toMermaid(r.spec) }),
		redact: (s) => s.replace(/sk-live-\d+/g, '[redacted]')
	});
	assert.match(md, /_LevelCode session · 2026-10-04 · 3 turns_/, 'the diagram is part of an answer, not a turn');
	const at = md.indexOf('```mermaid\n');
	assert.ok(at > md.indexOf('Here is diagram 1.') && at < md.indexOf('Done: that is the whole route.'), 'between the prose before and after');
	assert.match(md, /```mermaid\n---\ntitle: "Jev classifies; your code decides the action"\n---\nflowchart LR\n/);
	assert.ok(md.includes('in["key [redacted]"]'), 'a label is free text: it is scrubbed like the rest');
	assert.ok(!md.includes('sk-live-1234567890'));
	assert.strictEqual((md.match(/^```/gm) || []).length, 2, 'one fence opens, one closes');
	// without a renderer, the diagram is still named rather than silently dropped
	assert.match(E.toMarkdown({ title: 'R' }, msgs, { diagrams: service.list() }), /\n_\[diagram: Jev classifies; your code decides the action\]_\n/);
	// and without the records at all, the export is the prose it always was
	assert.ok(!/mermaid|diagram:/.test(E.toMarkdown({ title: 'R' }, msgs)));
});

test('EXPORT: prose, picture and more prose from one message are exported in that order, under one speaker', () => {
	const service = createDiagrams();
	service.beginRun();
	const out = service.render(jev(), { key: 'toolu_1', model: 'm' });
	service.endRun();
	const msgs = [{ role: 'user', content: 'how is a message routed?' },
		{ role: 'assistant', content: [{ type: 'text', text: 'First, the route.' }, { type: 'tool_use', id: 'toolu_1', name: 'render_diagram', input: jev() }, { type: 'text', text: 'Now the same thing as a list.' }] },
		{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: out.result }] },
		{ role: 'assistant', content: [{ type: 'text', text: 'Done: that is the whole route.' }] }];
	const opts = { diagrams: service.list(), diagram: () => ({ lang: 'mermaid', body: 'flowchart LR' }) };
	const md = E.toMarkdown({ title: 'Routing', updatedAt: '2026-10-04T10:00:00Z' }, msgs, opts);
	assert.strictEqual(md, [
		'# Routing', '', '_LevelCode session · 2026-10-04 · 3 turns_', '',
		'---', '', '**You**', '', 'how is a message routed?', '',
		'---', '', '**LevelCode**', '', 'First, the route.', '',
		'```mermaid', 'flowchart LR', '```', '',
		'Now the same thing as a list.', '',
		'---', '', '**LevelCode**', '', 'Done: that is the whole route.', ''
	].join('\n'), 'the picture stands where it stood; the prose after it is the same answer, not a new speaker or a fourth turn');
	// A picture with no prose before it opens the ANSWER — it is not the tail of the question.
	const bare = [msgs[0], { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'render_diagram', input: jev() }] }, msgs[2], msgs[3]];
	assert.strictEqual(E.toMarkdown({ title: 'Routing' }, bare, opts), [
		'# Routing', '', '_LevelCode session · 2 turns_', '',
		'---', '', '**You**', '', 'how is a message routed?', '',
		'---', '', '**LevelCode**', '',
		'```mermaid', 'flowchart LR', '```', '',
		'---', '', '**LevelCode**', '', 'Done: that is the whole route.', ''
	].join('\n'), 'under the speaker who drew it');
	// …while a message that is only a picture, after one that spoke, still stands under that answer.
	const after = [msgs[0], { role: 'assistant', content: [{ type: 'text', text: 'Let me draw it.' }, { type: 'tool_use', id: 'toolu_9', name: 'read_file', input: {} }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_9', content: 'x' }] },
		{ role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'render_diagram', input: jev() }] }, msgs[2], msgs[3]];
	assert.ok(E.toMarkdown({ title: 'Routing' }, after, opts).includes(['**LevelCode**', '', 'Let me draw it.', '', '```mermaid', 'flowchart LR', '```', '', '---', '', '**LevelCode**', '', 'Done: that is the whole route.'].join('\n')));
	// A picture that opens a message which then SPEAKS: the message is one answer — label, picture, prose.
	const lead = [msgs[0], { role: 'assistant', content: [{ type: 'text', text: 'Looking.' }] },
		{ role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'render_diagram', input: jev() }, { type: 'text', text: 'That is the route.' }] }, msgs[2]];
	assert.strictEqual(E.toMarkdown({ title: 'Routing' }, lead, opts), [
		'# Routing', '', '_LevelCode session · 3 turns_', '',
		'---', '', '**You**', '', 'how is a message routed?', '',
		'---', '', '**LevelCode**', '', 'Looking.', '',
		'---', '', '**LevelCode**', '',
		'```mermaid', 'flowchart LR', '```', '',
		'That is the route.', ''
	].join('\n'), 'two messages spoke, so two answers — the picture is not pulled up under the first');
	// A diagram that was never drawn exports nothing — and the prose after it is still its own message.
	const failed = createDiagrams();
	failed.beginRun();
	failed.render({ title: 'Nothing', nodes: [], edges: [] }, { key: 'toolu_1', model: 'm' }); failed.render({ title: 'Nothing', nodes: [], edges: [] }, { key: 'toolu_2', model: 'm' });
	failed.endRun();
	assert.deepStrictEqual(failed.list().map((r) => [r.key, r.status, r.spec]), [['toolu_2', 'failed', null]]);
	const none = [msgs[0], { role: 'assistant', content: [{ type: 'text', text: 'Looking.' }] },
		{ role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_2', name: 'render_diagram', input: {} }, { type: 'text', text: 'It could not be drawn.' }] }];
	assert.strictEqual(E.toMarkdown({ title: 'Routing' }, none, { diagrams: failed.list(), diagram: opts.diagram }), [
		'# Routing', '', '_LevelCode session · 3 turns_', '',
		'---', '', '**You**', '', 'how is a message routed?', '',
		'---', '', '**LevelCode**', '', 'Looking.', '',
		'---', '', '**LevelCode**', '', 'It could not be drawn.', ''
	].join('\n'));
});

test('EXPORT: nothing in a label can close the fence early', () => {
	const service = createDiagrams();
	const msgs = turnWith(draw(service, [jev()]));
	const md = E.toMarkdown({ title: 'R' }, msgs, { diagrams: service.list(), diagram: () => ({ lang: 'mermaid', body: 'flowchart LR\n  a["```` four backticks"]' }) });
	assert.match(md, /\n`````mermaid\nflowchart LR\n {2}a\["```` four backticks"\]\n`````\n/, 'the fence is one backtick longer than the longest run inside');
	const odd = E.toMarkdown({ title: 'R' }, msgs, { diagrams: service.list(), diagram: () => ({ lang: 'mer maid`\n# x', body: 'x' }) });
	assert.match(odd, /\n```mermaidx\nx\n```\n/, 'and the language tag is reduced to a plain word');
});

console.log('diagramSession: ' + n + ' tests passed');
