/*---------------------------------------------------------------------------------------------
 *  Rich diagrams — the Graph JSON schema and the validator — run: node test/diagramSchema.test.js
 *
 *  docs/RICH-DIAGRAMS.md: "The validator is the one gate every format passes." These tests pin the
 *  contract a model is shown (the wire schema), the contract it is held to (validate), and the one
 *  thing that makes a broken spec cheap to fix: every error at once, each naming what was expected.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

const assert = require('assert');
const schema = require('../diagram/schema');
const V = require('../diagram/validate');

let n = 0;
function test(name, fn) { fn(); n++; console.log('  ok - ' + name); }

/** The worked example from the spec, verbatim. */
const jev = () => ({
	v: 1, title: 'Jev classifies; your code decides the action', direction: 'right',
	nodes: [
		{ id: 'in', label: 'Customer message', sub: 'plus account details' },
		{ id: 'jev', label: 'Jev', sub: 'returns probabilities', accent: true },
		{ id: 'bill', label: 'Route to billing' },
		{ id: 'rev', label: 'Human review' }
	],
	edges: [{ from: 'in', to: 'jev' }, { from: 'jev', to: 'bill', label: '0.90 or more' }, { from: 'jev', to: 'rev', label: 'under 0.90' }]
});
const lines = (r) => V.formatErrors(r.errors).split('\n');

test('LIMITS: the numbers are the ones in the spec\'s field tables', () => {
	const H = schema.HOUSE;
	assert.strictEqual(H.title, 80);
	assert.strictEqual(H.label, 28);
	assert.strictEqual(H.sub, 32);
	assert.strictEqual(H.edgeLabel, 20);
	assert.strictEqual(H.nodesMin, 1);
	assert.strictEqual(H.nodesMax, 12);
	assert.strictEqual(H.groupDepth, 2);
	assert.deepStrictEqual(schema.SHAPES, ['box', 'decision', 'store', 'actor']);
	assert.deepStrictEqual(schema.DIRECTIONS, ['right', 'down']);
	assert.deepStrictEqual(schema.EDGE_STYLES, ['solid', 'dashed']);
	assert.strictEqual(schema.VERSION, 1);
});

test('LIMITS: the hard tier only ever RELAXES counts — text limits hold even for a degraded spec', () => {
	const H = schema.HOUSE, X = schema.HARD;
	assert.ok(X.nodesMax > H.nodesMax && X.edgesMax > H.edgesMax && X.groupsMax > H.groupsMax);
	for (const k of ['title', 'label', 'sub', 'edgeLabel', 'groupLabel', 'groupDepth', 'id']) {
		assert.strictEqual(X[k], H[k], k + ' must not relax');
	}
	assert.ok(X.nodesMax <= 32, 'the hard ceiling exists to bound layout time and DOM size');
});

test('WIRE: the schema sent to providers uses plain JSON Schema and nothing a provider could reject', () => {
	const ALLOWED = new Set(['type', 'properties', 'required', 'items', 'enum', 'minLength', 'maxLength', 'minItems', 'maxItems', 'pattern', 'minimum', 'description']);
	const walk = (node, where) => {
		for (const k of Object.keys(node)) { assert.ok(ALLOWED.has(k), 'keyword "' + k + '" at ' + where + ' is not plain JSON Schema'); }
		for (const [k, v] of Object.entries(node.properties || {})) { walk(v, where + '/' + k); }
		if (node.items) { walk(node.items, where + '[]'); }
	};
	walk(schema.SCHEMAS[1].house, '');
	const wire = JSON.stringify(schema.SCHEMAS[1].house);
	assert.ok(!/additionalProperties/.test(wire), 'a stray field is tidied, not failed — so it is never forbidden on the wire');
	assert.ok(!/"tip"/.test(wire), '`tip` is the renderer\'s, never the model\'s');
	assert.ok(/"tip"/.test(JSON.stringify(schema.SCHEMAS[1].hard)), 'the render-ready shape carries tooltips');
	assert.deepStrictEqual(schema.SCHEMAS[1].house.required, ['title', 'nodes', 'edges']);
});

test('WIRE: the schema the model sees and the schema it is checked against are one object', () => {
	// If these ever diverge, a spec could satisfy what the model was told and still be rejected.
	const r = { errors: [] };
	schema.check(schema.SCHEMAS[1].house, jev(), '', r.errors);
	assert.deepStrictEqual(r.errors, []);
	assert.deepStrictEqual(V.validate(jev()), { ok: true, errors: [] });
});

test('EXAMPLE: the spec\'s worked example is valid, and validating it does not change it', () => {
	const spec = jev(), before = JSON.stringify(spec);
	assert.strictEqual(V.validate(spec).ok, true);
	assert.strictEqual(JSON.stringify(spec), before, 'validate() is read-only');
});

test('ERROR FORMAT: the three lines the spec prints, word for word', () => {
	const bad = jev();
	bad.edges[1].to = 'billing';
	bad.nodes[0].sub = 'x'.repeat(46);
	bad.nodes[2].accent = true;
	const out = lines(V.validate(bad));
	assert.ok(out.includes('/edges/1/to: unknown node "billing". Known ids: in, jev, bill, rev.'), out.join('\n'));
	assert.ok(out.includes('/nodes/0/sub: 46 chars, max 32. Shorten or move detail to prose.'), out.join('\n'));
	assert.ok(out.some((l) => l.startsWith('/nodes: 2 nodes have accent=true, max 1 (jev, bill).')), out.join('\n'));
	assert.strictEqual(out.length, 3, 'EVERY error at once — and no extras');
});

test('ERROR FORMAT: each error is a JSON Pointer, what was expected, and the valid options', () => {
	const r = V.validate({ title: 'T', direction: 'sideways', nodes: [{ id: 'a', label: 'A', shape: 'blob' }], edges: [{ from: 'a', to: 'a', style: 'wavy' }] });
	const out = lines(r);
	assert.ok(out.includes('/direction: "sideways" is not allowed. Use one of: right, down.'), out.join('\n'));
	assert.ok(out.includes('/nodes/0/shape: "blob" is not allowed. Use one of: box, decision, store, actor.'), out.join('\n'));
	assert.ok(out.includes('/edges/0/style: "wavy" is not allowed. Use one of: solid, dashed.'), out.join('\n'));
	for (const e of r.errors) {
		assert.ok(e.pointer === '' || e.pointer[0] === '/', 'pointer: ' + e.pointer);
		assert.ok(typeof e.cls === 'string' && e.cls, 'every error has a class for telemetry');
		assert.ok(/[.]$/.test(e.message), 'a sentence, not a code: ' + e.message);
	}
});

test('ERROR FORMAT: a pointer escapes "/" and "~" (RFC 6901)', () => {
	assert.strictEqual(schema.seg('a/b~c'), 'a~1b~0c');
});

test('ERROR FORMAT: the list of known ids is capped, so one error cannot carry a whole spec back', () => {
	const many = { title: 'T', nodes: Array.from({ length: 24 }, (_, i) => ({ id: 'n' + i, label: 'L' })), edges: [{ from: 'n0', to: 'ghost' }] };
	const line = lines(V.validate(many, { tier: 'hard' })).find((l) => l.startsWith('/edges/0/to'));
	assert.ok(line, 'reported');
	assert.match(line, /Known ids: n0, n1, .*n15, … \(8 more\)\.$/);
	assert.ok(line.length < 220, 'bounded: ' + line.length);
});

test('SCHEMA: required fields, types, lengths and counts', () => {
	assert.ok(lines(V.validate({ nodes: [{ id: 'a', label: 'A' }], edges: [] })).includes('/title: missing. This field is required.'));
	assert.ok(lines(V.validate({ title: 'T', nodes: 'a,b', edges: [] })).includes('/nodes: expected an array, got string.'));
	assert.ok(lines(V.validate({ title: 'T', nodes: [], edges: [] })).includes('/nodes: 0 nodes, min 1.'));
	assert.ok(lines(V.validate({ title: 'T', nodes: [{ id: 'a' }], edges: [] })).includes('/nodes/0/label: missing. This field is required.'));
	assert.ok(lines(V.validate({ title: 'T', nodes: [{ id: 'a', label: 7 }], edges: [] })).includes('/nodes/0/label: expected a string, got integer.'));
	assert.ok(lines(V.validate({ title: 'T', nodes: [{ id: 'a', label: '' }], edges: [] })).includes('/nodes/0/label: must not be empty.'));
	assert.ok(lines(V.validate({ title: 'x'.repeat(81), nodes: [{ id: 'a', label: 'A' }], edges: [] })).includes('/title: 81 chars, max 80. Say the takeaway in fewer words.'));
	assert.ok(lines(V.validate({ title: 'T', nodes: [{ id: 'a', label: 'A' }], edges: [{ from: 'a', to: 'a', label: 'x'.repeat(21) }] })).includes('/edges/0/label: 21 chars, max 20. Shorten or move detail to prose.'));
	assert.ok(lines(V.validate({ title: 'T', nodes: [{ id: 'Not A Slug', label: 'A' }], edges: [] }))[0].startsWith('/nodes/0/id: "Not A Slug" is not a lowercase slug'));
	assert.ok(lines(V.validate({ title: 'T', nodes: [{ id: 'a', label: 'A', link: { path: 'a.js', line: 0 } }], edges: [] })).includes('/nodes/0/link/line: 0 is below the minimum 1.'));
	assert.ok(lines(V.validate({ title: 'T', nodes: [{ id: 'a', label: 'A', link: {} }], edges: [] })).includes('/nodes/0/link/path: missing. This field is required.'));
});

test('SCHEMA: over twelve nodes is an error that tells the model what to do instead', () => {
	const spec = { title: 'T', nodes: Array.from({ length: 13 }, (_, i) => ({ id: 'n' + i, label: 'L' })), edges: [] };
	assert.deepStrictEqual(lines(V.validate(spec)), ['/nodes: 13 nodes, max 12. Draw an overview, then one diagram per sub-flow.']);
	assert.strictEqual(V.validate(spec, { tier: 'hard' }).ok, true, 'the renderer can still draw it — that is what degrading relies on');
	spec.nodes = Array.from({ length: schema.HARD.nodesMax + 1 }, (_, i) => ({ id: 'n' + i, label: 'L' }));
	assert.strictEqual(V.validate(spec, { tier: 'hard' }).ok, false, 'but never past the hard ceiling');
});

test('SCHEMA: length is counted in characters, not UTF-16 units', () => {
	const spec = { title: 'T', nodes: [{ id: 'a', label: '🙂'.repeat(28) }], edges: [] };
	assert.strictEqual(V.validate(spec).ok, true, '28 emoji are 28 characters');
	spec.nodes[0].label = '🙂'.repeat(29);
	assert.ok(lines(V.validate(spec)).includes('/nodes/0/label: 29 chars, max 28. Shorten or move detail to prose.'));
});

test('SEMANTICS: ids are unique — nodes and groups each', () => {
	const r = V.validate({ title: 'T', groups: [{ id: 'g', label: 'G' }, { id: 'g', label: 'H' }], nodes: [{ id: 'a', label: 'A', group: 'g' }, { id: 'a', label: 'B' }], edges: [] });
	const out = lines(r);
	assert.ok(out.includes('/nodes/1/id: duplicate id "a" (already used by /nodes/0). Every node needs its own id.'), out.join('\n'));
	assert.ok(out.includes('/groups/1/id: duplicate group id "g" (already used by /groups/0).'), out.join('\n'));
	assert.deepStrictEqual(V.errorClasses(r.errors), { 'duplicate-id': 2 });
});

test('SEMANTICS: groups — unknown parent, self parent, a circle, and nesting past two', () => {
	const base = (groups, nodes) => ({ title: 'T', groups, nodes: nodes || [{ id: 'x', label: 'X', group: groups[0].id }], edges: [] });
	assert.ok(lines(V.validate(base([{ id: 'a', label: 'A', parent: 'zz' }]))).includes('/groups/0/parent: unknown group "zz". Known groups: a.'));
	assert.ok(lines(V.validate(base([{ id: 'a', label: 'A', parent: 'a' }]))).includes('/groups/0/parent: a group cannot contain itself. Remove "parent" or name another group.'));
	const circle = V.validate(base([{ id: 'a', label: 'A', parent: 'b' }, { id: 'b', label: 'B', parent: 'a' }]));
	assert.deepStrictEqual(V.errorClasses(circle.errors), { 'group-cycle': 2 });
	const deep = V.validate(base([{ id: 'a', label: 'A' }, { id: 'b', label: 'B', parent: 'a' }, { id: 'c', label: 'C', parent: 'b' }]));
	assert.deepStrictEqual(lines(deep), ['/groups/2/parent: nested 3 deep, max 2. Flatten it.']);
	assert.strictEqual(V.validate(base([{ id: 'a', label: 'A' }, { id: 'b', label: 'B', parent: 'a' }])).ok, true, 'depth 2 is allowed');
	assert.ok(lines(V.validate({ title: 'T', groups: [{ id: 'a', label: 'A' }], nodes: [{ id: 'x', label: 'X', group: 'nope' }], edges: [] })).includes('/nodes/0/group: unknown group "nope". Known groups: a.'));
});

test('SEMANTICS: a self-loop and a cycle are legal — a state machine needs both', () => {
	const r = V.validate({ title: 'T', nodes: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], edges: [{ from: 'a', to: 'a' }, { from: 'a', to: 'b' }, { from: 'b', to: 'a' }] });
	assert.deepStrictEqual(r, { ok: true, errors: [] });
});

test('VERSION: an unknown version is refused by name; no version reads as v1', () => {
	const future = jev(); future.v = 3;
	assert.deepStrictEqual(lines(V.validate(future)), ['/v: unknown schema version 3. This editor reads: 1.']);
	const none = jev(); delete none.v;
	assert.strictEqual(V.validate(none).ok, true);
	assert.strictEqual(V.migrate(none).v, 1);
	assert.strictEqual(none.v, undefined, 'migrate() returns a copy');
});

test('VERSION: every schema version in the registry has both tiers and still reads the example (NFR-4)', () => {
	assert.ok(schema.KNOWN_VERSIONS.includes(schema.VERSION));
	for (const v of schema.KNOWN_VERSIONS) {
		assert.ok(schema.SCHEMAS[v].house && schema.SCHEMAS[v].hard, 'v' + v + ' has both tiers');
		const spec = V.migrate(Object.assign(jev(), { v }));
		assert.strictEqual(V.validate(spec, { tier: 'hard' }).ok, true, 'a v' + v + ' spec still renders');
	}
	assert.ok(Object.isFrozen(schema.SCHEMAS) && Object.isFrozen(schema.SCHEMAS[1]), 'a stored chat points at v1; v1 must not be edited in place');
});

test('ROBUST: validate() never throws, whatever it is handed', () => {
	const junk = [null, undefined, 0, 'x', [], [1, 2], true, {}, { nodes: null }, { nodes: [null, 1, 'a', [], {}] }, { title: {}, nodes: {}, edges: {} },
		{ title: 'T', nodes: [{ id: 'a', label: 'A', link: 'x' }], edges: [null, 3, { from: {}, to: [] }] }, { title: 'T', nodes: [{ id: 'a', label: 'A' }], edges: [], groups: [null, { id: 4 }, 'g'] }];
	for (const j of junk) {
		const r = V.validate(j);
		assert.strictEqual(typeof r.ok, 'boolean');
		assert.ok(Array.isArray(r.errors));
		assert.strictEqual(r.ok, r.errors.length === 0);
		assert.strictEqual(typeof V.formatErrors(r.errors), 'string');
	}
	assert.strictEqual(lines(V.validate('nope'))[0], '/: expected an object with "title", "nodes" and "edges", got string.');
});

console.log('diagramSchema: ' + n + ' tests passed');
