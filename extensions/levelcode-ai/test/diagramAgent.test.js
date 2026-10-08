/*---------------------------------------------------------------------------------------------
 *  Rich diagrams in the agent loop, EXECUTED — run: node test/diagramAgent.test.js
 *
 *  docs/RICH-DIAGRAMS.md: FR-2 (Graph JSON arrives through a `render_diagram` tool call), FR-4 (auto-
 *  fix, ONE model pass, graceful degrade — no automatic second repair, no blank output) and FR-8 (the
 *  capability flag is respected in every session).
 *
 *  This runs the real runAgent → runTool → diagram service chain, the way agentRunCommand.test.js
 *  does: `vscode` is a stand-in and the provider is a script of turns. Nothing here asserts from
 *  source text — a tool that is present in the file but never reached would pass that and fail this.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-diagram-'));
const vscodeMock = { workspace: { workspaceFolders: [{ uri: { fsPath: root }, name: 'app' }] } };
const origLoad = Module._load;
// @ts-ignore — test-only loader shim
Module._load = function (request, parent, isMain) {
	if (request === 'vscode') { return vscodeMock; }
	return origLoad.call(this, request, parent, isMain);
};

const providers = require('../providers/index');
let script = [];
const calls = [];
providers.streamAgentTurn = async (opts) => {
	calls.push(opts);
	const turn = script.shift();
	if (!turn) { throw new Error('the agent asked for a turn the script does not have'); }
	return typeof turn === 'function' ? turn(opts) : turn;
};

const { runAgent } = require('../agent');
const { createDiagrams } = require('../diagram/service');
const tool = require('../diagram/tool');
const stats = require('../diagram/stats');

let n = 0;
async function testAsync(name, fn) { await fn(); n++; console.log('  ok - ' + name); }

const jev = () => ({
	title: 'Jev classifies; your code decides the action',
	nodes: [{ id: 'in', label: 'Customer message', sub: 'plus account details' }, { id: 'jev', label: 'Jev', sub: 'returns probabilities', accent: true }, { id: 'bill', label: 'Route to billing' }, { id: 'rev', label: 'Human review' }],
	edges: [{ from: 'in', to: 'jev' }, { from: 'jev', to: 'bill', label: '0.90 or more' }, { from: 'jev', to: 'rev', label: 'under 0.90' }]
});
const broken = () => { const s = jev(); s.edges[1].to = 'billing'; s.nodes[2].accent = true; return s; };
const call = (id, input) => ({ stop_reason: 'tool_use', content: [{ type: 'text', text: 'Here is the flow.' }, { type: 'tool_use', id, name: 'render_diagram', input }] });
const say = (text) => ({ stop_reason: 'end_turn', content: [{ type: 'text', text }] });
/** The same call when its arguments did not parse as JSON: the provider hands over the text it received. */
const sloppyCall = (id, argsText) => ({ stop_reason: 'tool_use', content: [{ type: 'text', text: 'Here is the flow.' }, { type: 'tool_use', id, name: 'render_diagram', input: {} }], malformed: new Set([id]), raw: new Map([[id, argsText]]) });
/** A spec as a model writes it on a bad day: every list and the object itself end in a comma. */
const loose = (spec) => JSON.stringify(spec).replace(/\]/g, ',]').replace(/\}$/, ',}');

/** Run one goal against a script of turns. Returns what was posted, what the model was sent, and the service. */
async function run(turns, overrides) {
	script = turns.slice();
	calls.length = 0;
	const posted = [], events = [];
	const diagrams = createDiagrams({
		resolveLink: (link) => (link.path === 'agent.js' ? { ok: true, path: 'agent.js' } : { ok: false, reason: 'no such file in this workspace' }),
		onStat: (ev) => events.push(ev)
	});
	const ctx = Object.assign({
		messages: [{ role: 'user', content: 'explain the routing' }],
		maxSteps: 8, model: 'test-model',
		post: (m) => posted.push(m),
		approve: async () => { throw new Error('render_diagram asked for approval — it is read-only'); },
		diagrams, client: { render: 'rich' },
		signal: new AbortController().signal
	}, overrides);
	await runAgent(ctx);
	const end = posted.filter((m) => m.type === 'agentError' || m.type === 'agentDone');
	assert.deepStrictEqual(end.map((m) => m.reason || m.message), ['done'], 'the scripted run did not finish cleanly: ' + JSON.stringify(end));
	assert.deepStrictEqual(script, [], 'the agent stopped before the script ended');
	const results = [];
	for (const m of ctx.messages) { if (m.role === 'user' && Array.isArray(m.content)) { for (const b of m.content) { if (b.type === 'tool_result') { results.push(b); } } } }
	return { posted, results, diagrams, events, sent: calls.slice(), ctx, shown: posted.filter((m) => m.type === 'diagram' || m.type === 'diagramPending') };
}

(async () => {
	try {
		// ---- capability detection ---------------------------------------------------------------------

		await testAsync('CAPABILITY: a rich client is given the tool and the rules; an ASCII client is given neither', async () => {
			const rich = await run([say('Done: nothing to draw.')]);
			const names = rich.sent[0].tools.map((t) => t.name);
			assert.ok(names.includes('render_diagram'), 'a rich client gets render_diagram');
			assert.ok(rich.sent[0].system.includes(tool.PROMPT), 'and the rules for using it');
			assert.ok(!names.includes('get_diagram'), 'get_diagram is not offered until a spec has left the conversation');

			for (const client of [{ render: 'ascii' }, undefined, { render: 'nonsense' }]) {
				const plain = await run([say('Done: nothing to draw.')], { client });
				assert.ok(!plain.sent[0].tools.some((t) => /diagram/.test(t.name)), 'an ASCII client must not be offered a tool it cannot show: ' + JSON.stringify(client));
				assert.ok(!/DIAGRAMS\./.test(plain.sent[0].system) && !/render_diagram/.test(plain.sent[0].system), 'nor told about it');
			}
			// the other host-gated tool is untouched by all of this: offered when wired, absent when not
			assert.ok(!names.includes('recall_sessions'));
			const recall = await run([say('Done: nothing to draw.')], { recallSessions: () => 'nothing' });
			assert.deepStrictEqual(recall.sent[0].tools.map((t) => t.name).slice(-2), ['recall_sessions', 'render_diagram'], 'extras keep one stable order, so the cached prefix does not churn');
			const noService = await run([say('Done: nothing to draw.')], { diagrams: undefined });
			assert.ok(!noService.sent[0].tools.some((t) => /diagram/.test(t.name)), 'the flag alone is not enough — there must be something to draw with');
		});

		await testAsync('CAPABILITY: get_diagram appears once a diagram has been stubbed out of the conversation — and only then', async () => {
			const r = await run([say('Done: ok.')], { diagramsStubbed: true });
			assert.deepStrictEqual(r.sent[0].tools.map((t) => t.name).filter((x) => /diagram/.test(x)), ['render_diagram', 'get_diagram']);
			const ascii = await run([say('Done: ok.')], { diagramsStubbed: true, client: { render: 'ascii' } });
			assert.ok(!ascii.sent[0].tools.some((t) => /diagram/.test(t.name)));
		});

		await testAsync('CONTEXT METER: the popover is billed for exactly the tools and prompt that were sent', async () => {
			for (const overrides of [{}, { client: { render: 'ascii' } }, { diagramsStubbed: true }]) {
				script = [Object.assign(say('Done: ok.'), { usage: { input_tokens: 10, output_tokens: 2 } })];
				const posted = [];
				calls.length = 0;
				await runAgent(Object.assign({ messages: [{ role: 'user', content: 'hi' }], maxSteps: 3, model: 'm', post: (m) => posted.push(m), approve: async () => true, diagrams: createDiagrams(), client: { render: 'rich' }, signal: new AbortController().signal }, overrides));
				const usage = posted.find((m) => m.type === 'contextUsage');
				assert.ok(usage, 'usage was reported');
				assert.strictEqual(usage.tools, Math.round(JSON.stringify(calls[0].tools).length / 4), 'tools estimate for ' + JSON.stringify(overrides));
				assert.strictEqual(usage.system, Math.round(calls[0].system.length / 4), 'system estimate for ' + JSON.stringify(overrides));
				assert.strictEqual(usage.mcpTools, 0, 'no MCP server contributed anything');
			}
		});

		// ---- the tool -----------------------------------------------------------------------------------

		await testAsync('DRAW: a valid spec is drawn, answered with {"ok":true,"id"}, and asks nobody', async () => {
			const r = await run([call('toolu_1', jev()), say('Done: the diagram shows the routing.')]);
			assert.deepStrictEqual(r.results.map((b) => b.content), ['{"ok":true,"id":"d-1"}']);
			const shown = r.shown.filter((m) => m.type === 'diagram');
			assert.strictEqual(shown.length, 1);
			assert.strictEqual(shown[0].key, 'toolu_1', 'keyed by the tool call, so it lands where the model put it');
			const rec = shown[0].record;
			assert.strictEqual(rec.id, 'd-1'); assert.strictEqual(rec.status, 'ok'); assert.strictEqual(rec.model, 'test-model');
			assert.strictEqual(rec.spec.nodes.length, 4); assert.strictEqual(rec.spec.v, 1);
			assert.deepStrictEqual([rec.fixes, rec.notes, rec.errors], [[], [], []]);
			assert.strictEqual(r.diagrams.get('d-1'), rec, 'and it is on file for links, export and replay');
			// the diagram sits between the text before it and the text after it
			const order = r.posted.filter((m) => m.type === 'diagram' || m.type === 'agentDone').map((m) => m.type);
			assert.deepStrictEqual(order, ['diagram', 'agentDone']);
		});

		await testAsync('DRAW: a link that is not a workspace file becomes plain text — and the model is told which', async () => {
			const spec = jev();
			spec.nodes[1].link = { path: 'agent.js', symbol: 'runAgent' };
			spec.nodes[2].link = { path: '../../etc/passwd' };
			const r = await run([call('toolu_1', spec), say('Done: drawn.')]);
			const rec = r.shown.find((m) => m.type === 'diagram').record;
			assert.deepStrictEqual(rec.spec.nodes[1].link, { path: 'agent.js', symbol: 'runAgent' });
			assert.strictEqual(rec.spec.nodes[2].link, undefined, 'nothing clickable points outside the workspace');
			const answer = JSON.parse(r.results[0].content);
			assert.strictEqual(answer.ok, true);
			assert.deepStrictEqual(answer.unlinked, ['bill: no such file in this workspace']);
		});

		// ---- the repair ladder, end to end ----------------------------------------------------------------

		await testAsync('LADDER rung 2: errors go back ONCE with every problem listed; the fixed spec takes the placeholder\'s place', async () => {
			const r = await run([call('toolu_1', broken()), call('toolu_2', jev()), say('Done: drawn.')]);
			assert.match(r.results[0].content, /^ERROR: the diagram was not drawn — 2 problems in the spec\. Fix them and call render_diagram once more\.\n/);
			assert.ok(r.results[0].content.includes('/edges/1/to: unknown node "billing". Known ids: in, jev, bill, rev.'), r.results[0].content);
			assert.ok(r.results[0].content.includes('/nodes: 2 nodes have accent=true, max 1 (jev, bill).'), r.results[0].content);
			assert.deepStrictEqual(r.shown.map((m) => m.type + ':' + (m.state || m.record.status)), ['diagramPending:repairing', 'diagram:ok']);
			assert.strictEqual(r.shown[0].title, 'Jev classifies; your code decides the action', 'the placeholder already says what is being drawn');
			assert.strictEqual(r.shown[1].replacesKey, 'toolu_1', 'the repaired picture lands where the failed attempt was waiting');
			assert.strictEqual(r.shown[1].record.repaired, true, '"the repaired spec is stored and marked as repaired"');
			assert.strictEqual(r.results[1].content, '{"ok":true,"id":"d-1"}');
			assert.strictEqual(r.diagrams.list().length, 1, 'the failed attempt is not on file as a diagram');
			assert.deepStrictEqual(r.events.filter((e) => e.type === 'call').map((e) => e.outcome), ['bounced', 'repaired']);
		});

		await testAsync('LADDER rung 3: still broken after the one pass — what is valid is drawn, with what was lost, and no second request', async () => {
			const r = await run([call('toolu_1', broken()), call('toolu_2', broken()), say('Done: drawn as far as it could be.')]);
			assert.match(r.results[0].content, /^ERROR:/);
			const second = JSON.parse(r.results[1].content);
			assert.strictEqual(second.ok, true);
			assert.deepStrictEqual(second.degraded, ['1 edge dropped: unknown nodes', '1 extra accent removed']);
			assert.match(second.note, /Do NOT call render_diagram again/, '"no automatic second repair"');
			const rec = r.shown[r.shown.length - 1].record;
			assert.strictEqual(rec.status, 'degraded');
			assert.strictEqual(rec.spec.edges.length, 2, 'the valid subgraph');
			assert.deepStrictEqual(rec.notes, ['1 edge dropped: unknown nodes', '1 extra accent removed'], 'the banner');
			assert.ok(rec.errors.length >= 2, 'and the details behind it');
			assert.strictEqual(r.sent.length, 3, 'three model turns: the call, the one repair, the answer — never a fourth for this diagram');
		});

		await testAsync('NO BLANK OUTPUT: the model gives up after the error list — the run still ends with a picture, not a placeholder', async () => {
			const r = await run([call('toolu_1', broken()), say('Done: I could not draw it; here it is in words.')]);
			const types = r.posted.filter((m) => /^diagram/.test(m.type) || m.type === 'agentDone').map((m) => m.type + (m.state ? ':' + m.state : m.record ? ':' + m.record.status : ''));
			assert.deepStrictEqual(types, ['diagramPending:repairing', 'diagram:degraded', 'agentDone'], 'settled BEFORE the run is declared over');
			const settled = r.shown.find((m) => m.type === 'diagram');
			assert.strictEqual(settled.key, 'toolu_1', 'it fills the placeholder that was waiting');
			assert.strictEqual(r.diagrams.pending, null);
		});

		await testAsync('NO BLANK OUTPUT: a spec with nothing drawable shows its source and its errors — `failed`, never empty', async () => {
			const r = await run([call('toolu_1', { title: 'Empty', nodes: [], edges: [] }), call('toolu_2', { title: 'Empty', nodes: [], edges: [] }), say('Done: nothing to show.')]);
			const rec = r.shown[r.shown.length - 1].record;
			assert.strictEqual(rec.status, 'failed');
			assert.strictEqual(rec.spec, null);
			assert.ok(rec.source.includes('"title": "Empty"'), 'the user can see what was sent');
			assert.deepStrictEqual(rec.errors, ['/nodes: 0 nodes, min 1.']);
			const answer = JSON.parse(r.results[1].content);
			assert.strictEqual(answer.ok, false);
			assert.match(answer.note, /Do NOT call render_diagram again/);
		});

		await testAsync('LADDER: a different diagram after a failed one settles the first and gets a pass of its own', async () => {
			const other = { title: 'A second, unrelated picture', nodes: [{ id: 'x', label: 'X' }, { id: 'y', label: 'Y' }], edges: [{ from: 'x', to: 'y' }] };
			const r = await run([call('toolu_1', broken()), call('toolu_2', other), say('Done: two diagrams.')]);
			const drawn = r.shown.filter((m) => m.type === 'diagram');
			assert.deepStrictEqual(drawn.map((m) => m.key + ':' + m.record.status), ['toolu_1:degraded', 'toolu_2:ok'], 'the abandoned one is settled the moment the model moves on');
			assert.strictEqual(drawn[1].replacesKey, undefined, 'and the new one does not take its place');
		});

		await testAsync('LADDER: a model that keeps sending broken specs runs out of repair passes', async () => {
			// five DIFFERENT diagrams (own title, own nodes), each broken — not five goes at one
			const bad = (k) => ({ title: 'Broken ' + k, nodes: [{ id: 'node' + k, label: 'N' + k }], edges: [{ from: 'node' + k, to: 'ghost' + k }] });
			const turns = [];
			for (let k = 1; k <= 5; k++) { turns.push(call('toolu_' + k, bad(k))); }
			turns.push(say('Done: giving up.'));
			const r = await run(turns, { maxSteps: 10 });
			const outcomes = r.results.map((b) => (/^ERROR/.test(b.content) ? 'bounced' : 'drawn'));
			assert.deepStrictEqual(outcomes, ['bounced', 'bounced', 'bounced', 'drawn', 'drawn'], 'three passes in one run, then every broken spec is simply degraded');
			assert.ok(r.shown.filter((m) => m.type === 'diagram').every((m) => m.record.status === 'degraded'));
			assert.strictEqual(r.shown.filter((m) => m.type === 'diagram').length, 5, 'and all five end up drawn — none is left as a placeholder');
		});

		await testAsync('LADDER: a second go at the SAME diagram is recognised by its nodes even when the title was reworded', async () => {
			const first = broken(), second = broken();
			second.title = 'Routing by confidence';
			const r = await run([call('toolu_1', first), call('toolu_2', second), say('Done: drawn.')]);
			assert.deepStrictEqual(r.results.map((b) => (/^ERROR/.test(b.content) ? 'bounced' : 'drawn')), ['bounced', 'drawn'], 'the reworded retry is the repair pass, so it degrades instead of bouncing again');
			assert.strictEqual(r.shown[r.shown.length - 1].replacesKey, 'toolu_1');
		});

		// The call that corrects a diagram is that diagram's repair in whatever FORM it arrives. Told apart
		// by the raw arguments, a repair written as loose JSON (or wrapped in an envelope) had no title and
		// no nodes: the first attempt was settled as a picture of its own, and the repair drew a second.
		await testAsync('LADDER: a repair that arrives as loosely written JSON is still the repair — one picture, in the placeholder', async () => {
			const r = await run([call('toolu_1', broken()), sloppyCall('toolu_2', loose(jev())), say('Done: drawn.')]);
			assert.match(r.results[0].content, /^ERROR: the diagram was not drawn/);
			assert.deepStrictEqual(r.shown.map((m) => m.type + ':' + (m.state || m.record.status)), ['diagramPending:repairing', 'diagram:ok'], 'the first attempt is not drawn on its own');
			assert.strictEqual(r.shown[1].replacesKey, 'toolu_1', 'the corrected picture lands where the failed attempt was waiting');
			assert.strictEqual(r.shown[1].record.repaired, true);
			assert.strictEqual(r.shown[1].record.spec.edges.length, 3, 'and it is the corrected spec, whole');
			assert.strictEqual(r.diagrams.list().length, 1, 'one diagram on file, so one card on replay too');
			assert.deepStrictEqual(r.events.filter((e) => e.type === 'call').map((e) => e.outcome), ['bounced', 'repaired']);
			assert.strictEqual(r.events.filter((e) => e.type === 'call')[1].fixClasses['lenient-json'], 1, 'and the loose JSON is still counted as the auto-fix it was');
			// with the title reworded too, it is still told by its nodes — read out of the text, like the title
			const reworded = jev(); reworded.title = 'Routing by confidence';
			const byNodes = await run([call('toolu_1', broken()), sloppyCall('toolu_2', loose(reworded)), say('Done: drawn.')]);
			assert.deepStrictEqual(byNodes.shown.map((m) => m.type + ':' + (m.state || m.record.status) + ':' + (m.replacesKey || '-')), ['diagramPending:repairing:-', 'diagram:ok:toolu_1']);
			assert.strictEqual(byNodes.diagrams.list().length, 1);
		});

		await testAsync('LADDER: a FIRST attempt in loose JSON is remembered by what it says, so its repair finds it', async () => {
			const r = await run([sloppyCall('toolu_1', loose(broken())), call('toolu_2', jev()), say('Done: drawn.')]);
			assert.deepStrictEqual(r.shown.map((m) => m.type + ':' + (m.state || m.record.status)), ['diagramPending:repairing', 'diagram:ok']);
			assert.strictEqual(r.shown[0].title, 'Jev classifies; your code decides the action', 'the placeholder is titled from the text, too');
			assert.strictEqual(r.shown[1].replacesKey, 'toolu_1');
			assert.strictEqual(r.shown[1].record.repaired, true);
			assert.strictEqual(r.diagrams.list().length, 1);
			// still broken on the second go: this is the one repair pass, so it degrades — it does not bounce again
			const twice = await run([sloppyCall('toolu_1', loose(broken())), sloppyCall('toolu_2', loose(broken())), say('Done: as far as it goes.')]);
			assert.deepStrictEqual(twice.results.map((b) => (/^ERROR/.test(b.content) ? 'bounced' : 'drawn')), ['bounced', 'drawn'], '"no automatic second repair", whatever the JSON looked like');
			assert.deepStrictEqual(twice.shown.filter((m) => m.type === 'diagram').map((m) => m.record.status + ':' + m.replacesKey), ['degraded:toolu_1']);
		});

		await testAsync('LADDER: a spec inside an envelope, or with its fields renamed, is told by what the ladder reads in it', async () => {
			const renamed = () => { const s = jev(); return { name: s.title, nodes: s.nodes.map((x) => ({ key: x.id, text: x.label })), edges: s.edges }; };
			for (const [first, second] of [[{ diagram: broken() }, { spec: JSON.stringify(jev()) }], [broken(), { graph: jev() }], [{ input: broken() }, renamed()]]) {
				const r = await run([call('toolu_1', first), call('toolu_2', second), say('Done: drawn.')]);
				const shape = JSON.stringify([Object.keys(first), Object.keys(second)]);
				assert.deepStrictEqual(r.shown.map((m) => m.type + ':' + (m.state || m.record.status)), ['diagramPending:repairing', 'diagram:ok'], shape);
				assert.strictEqual(r.shown[0].title, 'Jev classifies; your code decides the action', shape);
				assert.strictEqual(r.shown[1].replacesKey, 'toolu_1', shape);
				assert.strictEqual(r.diagrams.list().length, 1, shape);
			}
		});

		await testAsync('LADDER: reading the text does not make every call the same diagram — a different one in loose JSON is still a different one', async () => {
			const other = { title: 'A second, unrelated picture', nodes: [{ id: 'x', label: 'X' }, { id: 'y', label: 'Y' }], edges: [{ from: 'x', to: 'y' }] };
			const r = await run([sloppyCall('toolu_1', loose(broken())), sloppyCall('toolu_2', loose(other)), say('Done: two diagrams.')]);
			const drawn = r.shown.filter((m) => m.type === 'diagram');
			assert.deepStrictEqual(drawn.map((m) => m.key + ':' + m.record.status), ['toolu_1:degraded', 'toolu_2:ok']);
			assert.strictEqual(drawn[1].replacesKey, undefined);
			assert.strictEqual(drawn[1].record.repaired, undefined, 'a first attempt of its own, not somebody else\'s repair');
		});

		await testAsync('REDRAW: drawing the same diagram again in one run replaces the first instead of stacking a second', async () => {
			const again = jev(); again.direction = 'down';
			const r = await run([call('toolu_1', jev()), call('toolu_2', again), say('Done: redrawn top to bottom.')]);
			const drawn = r.shown.filter((m) => m.type === 'diagram');
			assert.strictEqual(drawn[1].replacesKey, 'toolu_1');
			assert.strictEqual(drawn[1].record.replaces, 'd-1');
			assert.strictEqual(drawn[1].record.id, 'd-2');
			assert.strictEqual(drawn[1].record.spec.direction, 'down');
			// …and it is the same diagram again when the second drawing arrives as loose JSON
			const text = await run([call('toolu_1', jev()), sloppyCall('toolu_2', loose(again)), say('Done: redrawn.')]);
			const shown = text.shown.filter((m) => m.type === 'diagram');
			assert.deepStrictEqual(shown.map((m) => m.record.id + ':' + (m.record.replaces || '-') + ':' + (m.replacesKey || '-')), ['d-1:-:-', 'd-2:d-1:toolu_1']);
		});

		// ---- extraction: truncated vs merely sloppy -------------------------------------------------------

		await testAsync('TRUNCATED: a spec cut off at the token cap is re-requested — never repaired, never drawn', async () => {
			const cut = { stop_reason: 'max_tokens', content: [{ type: 'tool_use', id: 'toolu_1', name: 'render_diagram', input: {} }], malformed: new Set(['toolu_1']), raw: new Map([['toolu_1', '{"title":"Cut off","nodes":[{"id":"a","label":"A"},{"id":"b","la']]) };
			const r = await run([cut, call('toolu_2', jev()), say('Done: drawn.')]);
			assert.match(r.results[0].content, /^ERROR: the diagram spec was cut off before it was complete/);
			assert.match(r.results[0].content, /Send the whole spec again, smaller/);
			assert.deepStrictEqual(r.shown.filter((m) => m.type === 'diagram').map((m) => m.record.id), ['d-1'], 'only the complete one is drawn');
			assert.strictEqual(r.results[1].content, '{"ok":true,"id":"d-1"}', 'and the re-request is a FIRST attempt, not the repair pass');
			assert.deepStrictEqual(r.events.filter((e) => e.type === 'call').map((e) => e.outcome), ['truncated', 'clean']);
		});

		await testAsync('LENIENT JSON: arguments with a trailing comma are a spec, and are drawn without a model call', async () => {
			const sloppy = '{"title":"Requests are cached before they are routed","nodes":[{"id":"a","label":"Request"},{"id":"b","label":"Cache"},],"edges":[{"from":"a","to":"b"},],}';
			const turn = { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'toolu_1', name: 'render_diagram', input: {} }], malformed: new Set(['toolu_1']), raw: new Map([['toolu_1', sloppy]]) };
			const r = await run([turn, say('Done: drawn.')]);
			assert.strictEqual(r.results[0].content, '{"ok":true,"id":"d-1"}');
			assert.strictEqual(r.shown.find((m) => m.type === 'diagram').record.spec.nodes.length, 2);
			assert.deepStrictEqual(r.events.filter((e) => e.type === 'call').map((e) => e.outcome), ['tidied'], 'an auto-fix, counted as one');
			assert.strictEqual(r.sent.length, 2, 'no extra model turn was spent on it');
		});

		await testAsync('MALFORMED: any other tool\'s cut-off arguments still get the generic answer', async () => {
			const cut = { stop_reason: 'max_tokens', content: [{ type: 'tool_use', id: 'toolu_1', name: 'update_plan', input: {} }], malformed: new Set(['toolu_1']), raw: new Map([['toolu_1', '{"todos":[']]) };
			const r = await run([cut, say('Done: ok.')]);
			assert.match(r.results[0].content, /^ERROR: your tool arguments were cut off \(truncated JSON\)/);
		});

		// ---- the placeholder ------------------------------------------------------------------------------

		await testAsync('PLACEHOLDER: the diagram\'s place is held as soon as the model starts writing it, and titled as soon as the title arrives', async () => {
			const streamed = (opts) => {
				opts.onToolStart('render_diagram', 'toolu_1');
				opts.onToolInput('toolu_1', 'render_diagram', '{"ti');
				opts.onToolInput('toolu_1', 'render_diagram', '{"title": "Jev classifies; your \\"code\\" decides');
				opts.onToolInput('toolu_1', 'render_diagram', '{"title": "Jev classifies; your \\"code\\" decides", "nodes": [');
				opts.onToolInput('toolu_1', 'render_diagram', '{"title": "Jev classifies; your \\"code\\" decides", "nodes": [{"id":"a","label":"A"}]');
				opts.onToolStart('read_file', 'toolu_9');
				opts.onToolInput('toolu_9', 'read_file', '{"title": "not a diagram"}');
				return call('toolu_1', jev());
			};
			const r = await run([streamed, say('Done: drawn.')]);
			const pend = r.shown.filter((m) => m.type === 'diagramPending');
			assert.deepStrictEqual(pend.map((m) => [m.key, m.state, m.title]), [['toolu_1', 'drawing', ''], ['toolu_1', 'drawing', 'Jev classifies; your "code" decides']], 'held at once; titled once, when the title is complete; other tools ignored');
			assert.strictEqual(r.shown[r.shown.length - 1].type, 'diagram');
			const ascii = await run([(opts) => { opts.onToolStart('render_diagram', 'toolu_1'); opts.onToolInput('toolu_1', 'render_diagram', '{"title": "x"}'); return say('Done: ok.'); }], { client: { render: 'ascii' } });
			assert.deepStrictEqual(ascii.shown, [], 'an ASCII client is never shown a placeholder');
		});

		// ---- an ASCII client, and the leak counter -------------------------------------------------------

		await testAsync('ASCII CLIENT: a call to render_diagram anyway is refused in words the model can act on', async () => {
			const r = await run([call('toolu_1', jev()), say('Done: explained in prose.')], { client: { render: 'ascii' }, diagrams: undefined });
			assert.match(r.results[0].content, /^ERROR: this client cannot draw diagrams\. Explain it in prose instead/);
			assert.deepStrictEqual(r.shown, []);
		});

		await testAsync('ASCII LEAKS: every answer to a rich client is checked for character drawings, and counted', async () => {
			const art = ['Here is the flow:', '', '+---------+     +-------+', '| Message | --> |  Jev  |', '+---------+     +-------+'].join('\n');
			const r = await run([say('Done: ' + art)]);
			assert.deepStrictEqual(r.events.filter((e) => e.type === 'answer'), [{ type: 'answer', asciiArt: true }]);
			const clean = await run([say('Done: Jev classifies the message and your code picks the route.')]);
			assert.deepStrictEqual(clean.events.filter((e) => e.type === 'answer'), [{ type: 'answer', asciiArt: false }]);
			const ascii = await run([say('Done: ' + art)], { client: { render: 'ascii' } });
			assert.deepStrictEqual(ascii.events, [], 'a terminal client drawing ASCII is not a leak');
			let s = stats.empty('2026-10-04');
			for (const ev of r.events.concat(clean.events)) { s = stats.record(s, ev); }
			assert.deepStrictEqual(stats.summarize(s).asciiLeaks, { answers: 2, leaks: 1 });
		});

		await testAsync('GET_DIAGRAM: returns the stored spec for an id, and names the ids it knows when asked for one it does not', async () => {
			const fetch = (id) => ({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'toolu_g' + id, name: 'get_diagram', input: { id } }] });
			const r = await run([call('toolu_1', jev()), fetch('d-1'), fetch('d-9'), say('Done: fetched.')], { diagramsStubbed: true });
			const got = JSON.parse(r.results[1].content);
			assert.strictEqual(got.title, 'Jev classifies; your code decides the action');
			assert.strictEqual(got.nodes.length, 4);
			assert.strictEqual(r.results[2].content, 'ERROR: no diagram with id "d-9" in this session. Known ids: d-1.');
		});

		// ---- what it costs --------------------------------------------------------------------------------

		await testAsync('BUDGET: the tool and its rules are a standing cost on every request — pinned, so it cannot creep', async () => {
			const toolTokens = Math.round(JSON.stringify(tool.RENDER_DIAGRAM).length / 4);
			const promptTokens = Math.round(tool.PROMPT.length / 4);
			assert.ok(toolTokens <= 520, 'render_diagram schema ≈ ' + toolTokens + ' tokens');
			assert.ok(promptTokens <= 560, 'prompt block ≈ ' + promptTokens + ' tokens');
			assert.ok(Math.round(JSON.stringify(tool.GET_DIAGRAM).length / 4) <= 110);
			// the worked example in the prompt is itself a valid spec — a prompt that teaches an invalid one would be worse than none
			const example = JSON.parse(tool.PROMPT.slice(tool.PROMPT.indexOf('Example call: ') + 'Example call: '.length));
			assert.strictEqual(require('../diagram/repair').prepare(example).status, 'ok');
			assert.deepStrictEqual(require('../diagram/repair').prepare(example).fixes, [], 'and it is clean: no fix of any kind');
			assert.match(tool.PROMPT, /NEVER draw boxes, arrows, trees or bars out of characters/);
			// "generate a diagram" means a picture in the chat. Without the tool the old agent wrote a document
			// full of diagram source instead; with it, that must not be the first thing a model reaches for.
			assert.match(tool.PROMPT, /Asked for a diagram, DRAW it here with render_diagram\. Writing one into a file instead .* is only for when the user asks for a file\./);
			assert.ok(!/mermaid|vega/i.test(tool.PROMPT), 'phase 1 must not tell the model to emit a format the client shows as raw source');
		});

		await testAsync('BUDGET: a diagram is a few hundred tokens (NFR-3: Graph JSON median under 600)', async () => {
			const gallery = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'diagrams', 'gallery.json'), 'utf8'));
			const sizes = gallery.map((g) => Math.round(JSON.stringify(g.spec).length / 4)).sort((a, b) => a - b);
			assert.ok(sizes[Math.floor(sizes.length / 2)] < 600, 'median ' + sizes[Math.floor(sizes.length / 2)]);
			assert.ok(sizes[sizes.length - 1] < 600, 'even the twelve-node one: ' + sizes[sizes.length - 1]);
		});

		console.log('diagramAgent: ' + n + ' tests passed');
	} catch (e) {
		console.error(e);
		process.exitCode = 1;
	} finally {
		// @ts-ignore
		Module._load = origLoad;
		try { fs.rmSync(root, { recursive: true, force: true }); } catch (e) { /* temp dir */ }
	}
})();
