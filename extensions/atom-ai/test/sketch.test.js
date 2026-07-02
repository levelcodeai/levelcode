/*---------------------------------------------------------------------------------------------
 *  Unit tests for the Agent Sketch pure logic — run: node test/sketch.test.js
 *    - sketch/graph.js: validation (cycles, dangling edges), topo levels, node input building
 *    - sketch/pricing.js: model matching (exact/basename/family), cost math
 *    - sketch/agentCatalog.js: shape sanity
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

const assert = require('assert');
const G = require('../sketch/graph');
const P = require('../sketch/pricing');
const C = require('../sketch/agentCatalog');

let n = 0;
function test(name, fn) { fn(); n++; console.log('  ok - ' + name); }

const N = (id) => ({ id, agentId: 'coder', x: 0, y: 0 });
const E = (from, to) => ({ from, to });

// ---- validateGraph ----
test('validateGraph: empty sketch rejected; single node ok', () => {
	assert.strictEqual(G.validateGraph([], []).ok, false);
	assert.strictEqual(G.validateGraph([N('a')], []).ok, true);
});
test('validateGraph: dangling edge, self-loop, duplicate edge rejected', () => {
	assert.strictEqual(G.validateGraph([N('a')], [E('a', 'ghost')]).ok, false);
	assert.strictEqual(G.validateGraph([N('a')], [E('a', 'a')]).ok, false);
	assert.strictEqual(G.validateGraph([N('a'), N('b')], [E('a', 'b'), E('a', 'b')]).ok, false);
});
test('validateGraph: cycle rejected (a→b→c→a); DAG accepted', () => {
	const nodes = [N('a'), N('b'), N('c')];
	assert.strictEqual(G.validateGraph(nodes, [E('a', 'b'), E('b', 'c'), E('c', 'a')]).ok, false);
	assert.strictEqual(G.validateGraph(nodes, [E('a', 'b'), E('a', 'c'), E('b', 'c')]).ok, true);
});

// ---- topoLevels: parallel waves ----
test('topoLevels: chain → one node per level', () => {
	const lv = G.topoLevels([N('a'), N('b'), N('c')], [E('a', 'b'), E('b', 'c')]);
	assert.deepStrictEqual(lv, [['a'], ['b'], ['c']]);
});
test('topoLevels: fan-out runs in parallel, fan-in waits for all', () => {
	// planner → {coder, tester} → reviewer
	const nodes = [N('plan'), N('code'), N('test'), N('review')];
	const edges = [E('plan', 'code'), E('plan', 'test'), E('code', 'review'), E('test', 'review')];
	const lv = G.topoLevels(nodes, edges);
	assert.deepStrictEqual(lv[0], ['plan']);
	assert.deepStrictEqual(lv[1].sort(), ['code', 'test']);
	assert.deepStrictEqual(lv[2], ['review']);
});
test('topoLevels: disconnected nodes all start in level 0', () => {
	const lv = G.topoLevels([N('a'), N('b')], []);
	assert.deepStrictEqual(lv[0].sort(), ['a', 'b']);
});

// ---- buildNodeInput ----
test('buildNodeInput: goal + upstream outputs + node instructions, in order', () => {
	const node = { id: 'r', agentId: 'reviewer', instructions: 'Review for security.' };
	const outputs = new Map([['c', { label: 'coder', text: 'function add(){}' }]]);
	const msg = G.buildNodeInput('Build a calculator', node, [E('c', 'r')], outputs);
	assert.ok(msg.indexOf('Overall goal') < msg.indexOf('upstream agent "coder"'));
	assert.ok(msg.indexOf('function add()') > 0);
	assert.ok(msg.indexOf('Review for security.') > msg.indexOf('function add()'));
});
test('buildNodeInput: root node with no goal/instructions still gets a prompt', () => {
	const msg = G.buildNodeInput('', { id: 'a', agentId: 'coder' }, [], new Map());
	assert.ok(msg.length > 0);
});

// ---- pricing ----
test('modelPricing: exact, basename (openrouter prefix), family fallback, unknown→null', () => {
	assert.strictEqual(P.modelPricing('claude-opus-4-8').inM, 5.0);
	assert.strictEqual(P.modelPricing('anthropic/claude-sonnet-4-6').outM, 15.0);   // basename via vendor/model
	assert.strictEqual(P.modelPricing('claude-sonnet-4-6-preview').outM, 15.0);     // family prefix
	assert.strictEqual(P.modelPricing('totally-unknown-model'), null);
	assert.strictEqual(P.modelPricing(''), null);
});
test('costOf: math + unknown model returns null (never $0 for unknown)', () => {
	// 10k in + 2k out on sonnet: 10k*3/1e6 + 2k*15/1e6 = 0.03 + 0.03 = 0.06
	assert.strictEqual(P.costOf('claude-sonnet-4-6', 10000, 2000), 0.06);
	assert.strictEqual(P.costOf('unknown-x', 1000, 1000), null);
	assert.strictEqual(P.costOf('gpt-4o-mini', 0, 0), 0);
});
test('fmtUsd: scales sensibly', () => {
	assert.strictEqual(P.fmtUsd(null), 'n/a');
	assert.strictEqual(P.fmtUsd(0.0042), '$0.0042');
	assert.strictEqual(P.fmtUsd(0.06), '$0.060');
	assert.strictEqual(P.fmtUsd(2.4), '$2.40');
});

// ---- agent catalog sanity ----
test('agentCatalog: 90+ agents, every agent in a declared group, core roles present', () => {
	assert.ok(C.AGENTS.length >= 90, 'expected 90+ agents, got ' + C.AGENTS.length);
	const groupIds = new Set(C.AGENT_GROUPS.map((g) => g.id));
	for (const a of C.AGENTS) { assert.ok(groupIds.has(a.group), a.id + ' has unknown group ' + a.group); }
	for (const want of ['coder', 'planner', 'researcher', 'reviewer', 'tester']) {
		assert.ok(C.AGENT_BY_ID.has(want), 'missing core agent ' + want);
	}
	for (const a of C.AGENTS) { assert.ok(['fast', 'balanced', 'powerful'].includes(a.tier), a.id + ' bad tier'); }
});

// ---- templates ----
const T = require('../sketch/templates');
test('templates: every template is a valid DAG built from known agents', () => {
	assert.ok(T.TEMPLATES.length >= 5);
	for (const t of T.TEMPLATES) {
		assert.ok(t.id && t.name && t.sketch, 'template missing fields: ' + t.id);
		const v = G.validateGraph(t.sketch.nodes, t.sketch.edges);
		assert.ok(v.ok, t.id + ' invalid DAG: ' + (v.error || ''));
		for (const nd of t.sketch.nodes) {
			assert.ok(C.AGENT_BY_ID.has(nd.agentId), t.id + ' uses unknown agent ' + nd.agentId);
			assert.strictEqual(typeof nd.instructions, 'string');
		}
	}
});
test('templates: TEMPLATE_INDEX and TEMPLATE_BY_ID stay in sync', () => {
	assert.strictEqual(T.TEMPLATE_INDEX.length, T.TEMPLATES.length);
	for (const t of T.TEMPLATES) { assert.ok(T.TEMPLATE_BY_ID.get(t.id), 'missing in map: ' + t.id); }
});
test('templates: Key-Value Store covers the ByteByteGo aspects with per-node tasks', () => {
	const kv = T.TEMPLATE_BY_ID.get('kv-store');
	assert.ok(kv, 'kv-store template missing');
	const labels = kv.sketch.nodes.map((nd) => nd.label);
	for (const want of ['requirements', 'architecture', 'consistent-hash', 'replication+quorum', 'vector-clocks', 'gossip+failover', 'integrate+server', 'tests', 'review+run-guide']) {
		assert.ok(labels.includes(want), 'kv-store missing node: ' + want);
	}
	for (const nd of kv.sketch.nodes) { assert.ok(nd.instructions.length > 40, nd.label + ' has no real task'); }
	const lv = G.topoLevels(kv.sketch.nodes, kv.sketch.edges);
	assert.ok(lv.length >= 5, 'kv-store should be a multi-stage flow');
	assert.ok(lv.some((l) => l.length >= 4), 'kv-store should fan out to parallel component builders');
});

// ---- catalog description normalization (no mid-word truncation into system prompts) ----
test('normalizeDesc: trims mid-word cut, clean endings, idempotent', () => {
	// capped (>=150) with a sentence boundary past char 80 → keep the last full sentence
	const cutSentence = 'Use this agent when you need to create foundational templates, boilerplate code, or starter configs for new projects and components. This agent excels at generatin';
	assert.ok(cutSentence.length >= 150);
	const s = C.normalizeDesc(cutSentence);
	assert.ok(!/generatin$/.test(s), 'should not end mid-word: ' + s);
	assert.ok(/[.!?…]$/.test(s), 'should end cleanly: ' + s);
	assert.strictEqual(C.normalizeDesc(s), s, 'idempotent');
	// capped with no sentence boundary → drop the partial final word, add an ellipsis
	const cutWord = 'Advanced distributed coordination and orchestration layer that manages large scale multi agent swarms across many worker nodes with adaptive scheduling and loadbalan';
	assert.ok(cutWord.length >= 150);
	const w = C.normalizeDesc(cutWord);
	assert.ok(/…$/.test(w) && !/loadbalan$/.test(w), 'should end with ellipsis, no partial word: ' + w);
	// short + already-clean strings pass through untouched
	assert.strictEqual(C.normalizeDesc('Short clean role.'), 'Short clean role.');
});

console.log('\nsketch: ' + n + ' tests passed.');
