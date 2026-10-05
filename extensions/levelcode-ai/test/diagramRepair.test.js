/*---------------------------------------------------------------------------------------------
 *  Rich diagrams — the repair ladder — run: node test/diagramRepair.test.js
 *
 *  docs/RICH-DIAGRAMS.md, "Validation and repair". Two things are tested here:
 *
 *  1. THE GOLDEN CORPUS (test/fixtures/diagrams/corpus.json): every recorded way a model gets a
 *     spec wrong, with the outcome the ladder must reach — the exact errors returned to the model,
 *     the fixes shown to the user, and what is drawn once the one repair pass is spent. A change to
 *     the validator or the auto-fixer must keep every case green.
 *
 *  2. THE RULES THAT ORDER THE RUNGS, as properties of prepare() itself: a deterministic fix never
 *     costs a model call; a fix that changes what the diagram SAYS is never applied before the
 *     model's one pass; nothing loops; truncated output is re-requested, never repaired.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const R = require('../diagram/repair');
const V = require('../diagram/validate');
const schema = require('../diagram/schema');

let n = 0;
function test(name, fn) { fn(); n++; console.log('  ok - ' + name); }

const corpus = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'diagrams', 'corpus.json'), 'utf8'));
const jev = () => JSON.parse(JSON.stringify(corpus.find((c) => c.name === 'spec-example').input));

/** What the fixture records about one attempt, recomputed from the live code. */
function outcome(input) {
	const a = R.prepare(input), b = R.prepare(input, { final: true });
	const first = { status: a.status };
	if (a.errors.length) { first.errors = V.formatErrors(a.errors).split('\n'); }
	const shown = R.visibleFixes(a.fixes).map((f) => (f.pointer || '/') + ': ' + f.message);
	if (shown.length) { first.shown = shown; }
	const tidied = Array.from(new Set(a.fixes.filter((f) => !f.show && !f.lossy).map((f) => f.cls))).sort();
	if (tidied.length) { first.tidied = tidied; }
	const final = { status: b.status };
	if (b.notes.length) { final.notes = b.notes; }
	if (b.spec) { final.drawn = { nodes: b.spec.nodes.length, edges: b.spec.edges.length, groups: (b.spec.groups || []).length }; }
	return { first, final, a, b };
}

test('CORPUS: it exists, every case says why it is there, and names are unique', () => {
	assert.ok(corpus.length >= 30, 'a corpus of ' + corpus.length + ' is not a corpus');
	const names = new Set();
	for (const c of corpus) {
		assert.ok(c.name && !names.has(c.name), 'duplicate or missing name: ' + c.name);
		names.add(c.name);
		assert.ok(typeof c.why === 'string' && c.why.length > 15, c.name + ' needs a `why`');
		assert.ok(c.first && c.final, c.name + ' records both attempts');
	}
});

for (const c of corpus) {
	test('CORPUS · ' + c.name + ' — ' + c.first.status + ' → ' + c.final.status, () => {
		const o = outcome(c.input);
		assert.deepStrictEqual(o.first, c.first, 'first attempt');
		assert.deepStrictEqual(o.final, c.final, 'after the repair pass');
	});
}

test('LADDER: whatever prepare() hands the renderer is valid — every corpus case, both attempts', () => {
	for (const c of corpus) {
		const { a, b } = outcome(c.input);
		for (const r of [a, b]) {
			if (r.status === 'ok' || r.status === 'fixed') { assert.deepStrictEqual(V.validate(r.spec), { ok: true, errors: [] }, c.name + ': ' + r.status + ' must meet the HOUSE limits'); }
			else if (r.status === 'degraded') { assert.deepStrictEqual(V.validate(r.spec, { tier: 'hard' }), { ok: true, errors: [] }, c.name + ': degraded must meet the HARD limits'); }
			else { assert.strictEqual(r.spec, undefined, c.name + ': ' + r.status + ' carries no spec to draw'); }
		}
	}
});

test('LADDER: a fix that changes MEANING is never applied before the model has had its pass', () => {
	for (const c of corpus) {
		const { a, b } = outcome(c.input);
		assert.ok(!a.fixes.some((f) => f.lossy), c.name + ': a lossy fix on the first attempt');
		if (a.status === 'ok' || a.status === 'fixed') {
			// what is drawn has exactly as many nodes and edges as when nothing lossy is allowed
			assert.strictEqual(a.spec.nodes.length, b.spec.nodes.length, c.name);
			assert.strictEqual(a.spec.edges.length, b.spec.edges.length, c.name);
			assert.deepStrictEqual(a.spec, b.spec, c.name + ': `final` changes nothing when the first attempt was fine');
		}
		if (b.status === 'degraded') { assert.ok(b.notes.length > 0, c.name + ': a degraded diagram always says what it lost'); }
	}
});

test('LADDER: the first attempt never degrades, and the final attempt never asks again', () => {
	for (const c of corpus) {
		const { a, b } = outcome(c.input);
		assert.ok(['ok', 'fixed', 'errors', 'truncated'].includes(a.status), c.name + ': first=' + a.status);
		assert.ok(['ok', 'fixed', 'degraded', 'failed', 'truncated'].includes(b.status), c.name + ': final=' + b.status + ' — "no automatic second repair"');
		if (a.status === 'errors') { assert.ok(a.errors.length > 0, c.name + ': `errors` with no errors would be a blank result'); }
	}
});

test('LADDER: truncated output is re-requested, never repaired — even on the final attempt', () => {
	for (const cut of ['{"title":"T","nodes":[{"id":"a","label":"A"},{"id":"b","la', '{"title":"T","nodes":[', '{"title":"T","nodes":[{"id":"a","label":"A"}],"edges":[{"from":"a"', '{"title": "T" /* comment never closed']) {
		for (const final of [false, true]) {
			const r = R.prepare(cut, { final });
			assert.strictEqual(r.status, 'truncated', JSON.stringify(cut));
			assert.strictEqual(r.spec, undefined, 'nothing is drawn from a guess');
		}
	}
	// ...but a complete object followed by chatter is complete
	assert.strictEqual(R.prepare('{"title":"T","nodes":[{"id":"a","label":"A"}],"edges":[]} Hope that helps!').status, 'ok');
});

test('LADDER: it is idempotent — a prepared spec passes again untouched, with nothing to fix', () => {
	for (const c of corpus) {
		const { b } = outcome(c.input);
		if (!b.spec) { continue; }
		const again = R.prepare(b.spec, { final: true });
		// a degraded spec may exceed the HOUSE counts by design; everything else must come back clean
		if (b.status !== 'degraded') { assert.strictEqual(again.status, 'ok', c.name + ': ' + JSON.stringify(again.errors)); }
		assert.deepStrictEqual(R.visibleFixes(again.fixes), [], c.name + ': a second pass found something to fix');
		assert.deepStrictEqual(again.spec, b.spec, c.name + ': a second pass changed the spec');
	}
});

test('FIXED vs DEGRADED: shortening a label keeps the whole text, as a tooltip', () => {
	const r = R.prepare({ title: 'T', nodes: [{ id: 'a', label: 'Validate the incoming request payload', sub: 'and then hand the whole thing to the next stage' }], edges: [] });
	assert.strictEqual(r.status, 'fixed');
	assert.strictEqual(r.spec.nodes[0].label, 'Validate the incoming…');
	assert.ok(Array.from(r.spec.nodes[0].label).length <= schema.HOUSE.label);
	assert.ok(Array.from(r.spec.nodes[0].sub).length <= schema.HOUSE.sub);
	assert.strictEqual(r.spec.nodes[0].tip, 'Validate the incoming request payload — and then hand the whole thing to the next stage');
	assert.deepStrictEqual(r.notes, ['2 labels shortened']);
	assert.ok(r.fixes.every((f) => !f.lossy), 'nothing was lost, so nothing is lossy');
});

test('FIXED vs DEGRADED: an edge to nowhere goes to the model first; only then is it dropped, loudly', () => {
	const spec = { title: 'T', nodes: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], edges: [{ from: 'a', to: 'b' }, { from: 'a', to: 'ghost' }] };
	const first = R.prepare(spec);
	assert.strictEqual(first.status, 'errors');
	assert.deepStrictEqual(V.formatErrors(first.errors), '/edges/1/to: unknown node "ghost". Known ids: a, b.');
	const last = R.prepare(spec, { final: true });
	assert.strictEqual(last.status, 'degraded');
	assert.deepStrictEqual(last.spec.edges, [{ from: 'a', to: 'b' }]);
	assert.deepStrictEqual(last.notes, ['1 edge dropped: unknown nodes']);
});

test('TIDY: an edge that names a node by its label is a lookup, not a guess — unless two nodes share it', () => {
	const one = R.prepare({ title: 'T', nodes: [{ id: 'n1', label: 'Load balancer' }, { id: 'n2', label: 'API' }], edges: [{ from: 'load balancer', to: 'API' }] });
	assert.strictEqual(one.status, 'ok');
	assert.deepStrictEqual(one.spec.edges, [{ from: 'n1', to: 'n2' }]);
	const two = R.prepare({ title: 'T', nodes: [{ id: 'n1', label: 'API' }, { id: 'n2', label: 'API' }, { id: 'n3', label: 'DB' }], edges: [{ from: 'API', to: 'DB' }] });
	assert.strictEqual(two.status, 'errors', 'two nodes are called "API": which one is a question for the model');
	assert.match(V.formatErrors(two.errors), /unknown node "api"\. Known ids: n1, n2, n3\./);
});

test('TIDY: ids are slugged, and every edge follows its node to the new id', () => {
	const r = R.prepare({ title: 'T', nodes: [{ id: 'Auth Service', label: 'Auth' }, { id: 'Müller & Söhne', label: 'M' }, { id: '  ', label: 'Blank id' }], edges: [{ from: 'Auth Service', to: 'Müller & Söhne' }, { from: 'auth service', to: 'Blank id' }] });
	assert.strictEqual(r.status, 'ok', JSON.stringify(r.errors));
	assert.deepStrictEqual(r.spec.nodes.map((x) => x.id), ['auth-service', 'muller-sohne', 'blank-id']);
	assert.deepStrictEqual(r.spec.edges, [{ from: 'auth-service', to: 'muller-sohne' }, { from: 'auth-service', to: 'blank-id' }]);
	for (const x of r.spec.nodes) { assert.match(x.id, schema.ID_RE); }
});

test('TIDY: defaults are not fixes — the plain example comes back byte-for-byte, with none recorded', () => {
	const r = R.prepare(jev());
	assert.strictEqual(r.status, 'ok');
	assert.deepStrictEqual(r.fixes, []);
	assert.strictEqual(JSON.stringify(r.spec), JSON.stringify(jev()));
	const bare = R.prepare({ title: 'T', nodes: [{ id: 'a', label: 'A' }] });
	assert.strictEqual(bare.status, 'ok');
	assert.deepStrictEqual(bare.spec, { v: 1, title: 'T', direction: 'right', nodes: [{ id: 'a', label: 'A' }], edges: [] });
});

test('TIDY: prepare() never mutates what it was given', () => {
	for (const c of corpus) {
		if (typeof c.input !== 'object') { continue; }
		const before = JSON.stringify(c.input);
		R.prepare(c.input); R.prepare(c.input, { final: true });
		assert.strictEqual(JSON.stringify(c.input), before, c.name);
	}
});

test('DEGRADE: counts relax up to the hard ceiling and no further; what is cut is counted', () => {
	const many = (k) => ({ title: 'T', nodes: Array.from({ length: k }, (_, i) => ({ id: 'n' + i, label: 'L' + i })), edges: Array.from({ length: k - 1 }, (_, i) => ({ from: 'n' + i, to: 'n' + (i + 1) })) });
	const d14 = R.prepare(many(14), { final: true });
	assert.strictEqual(d14.status, 'degraded');
	assert.strictEqual(d14.spec.nodes.length, 14, 'showing 12 of 14 would be a different diagram presented as the answer');
	assert.deepStrictEqual(d14.notes, ['14 nodes — over the 12-node limit, drawn anyway']);
	const d40 = R.prepare(many(40), { final: true });
	assert.strictEqual(d40.spec.nodes.length, schema.HARD.nodesMax);
	assert.ok(d40.spec.edges.every((e) => d40.spec.nodes.some((x) => x.id === e.from) && d40.spec.nodes.some((x) => x.id === e.to)), 'no edge is left pointing at a dropped node');
	assert.match(d40.notes.join(' | '), /16 nodes dropped/);
});

test('DEGRADE: one accent survives — the first; groups past depth two fold into their parent', () => {
	const acc = R.prepare({ title: 'T', nodes: [{ id: 'a', label: 'A', accent: true }, { id: 'b', label: 'B', accent: true }, { id: 'c', label: 'C', accent: true }], edges: [] }, { final: true });
	assert.deepStrictEqual(acc.spec.nodes.filter((x) => x.accent).map((x) => x.id), ['a']);
	assert.deepStrictEqual(acc.notes, ['2 extra accents removed']);
	const deep = R.prepare({ title: 'T', groups: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B', parent: 'a' }, { id: 'c', label: 'C', parent: 'b' }, { id: 'd', label: 'D', parent: 'c' }], nodes: [{ id: 'x', label: 'X', group: 'd' }, { id: 'y', label: 'Y', group: 'c' }, { id: 'z', label: 'Z', group: 'b' }], edges: [] }, { final: true });
	assert.strictEqual(deep.status, 'degraded');
	assert.deepStrictEqual(deep.spec.groups.map((g) => g.id), ['a', 'b']);
	assert.deepStrictEqual(deep.spec.nodes.map((x) => x.group), ['b', 'b', 'b'], 'the nodes move up to the deepest group that is still allowed');
});

test('DEGRADE: whatever part is well-formed is drawn — one good node among junk is a diagram', () => {
	const r = R.prepare({ title: 'T', nodes: [{}, { id: 7 }, null, { id: 'ok', label: 'Fine' }], edges: [{ from: 'ok', to: '7' }, { from: 'ok' }] }, { final: true });
	assert.strictEqual(r.status, 'degraded');
	assert.deepStrictEqual(r.spec.nodes, [{ id: '7', label: '7' }, { id: 'ok', label: 'Fine' }], 'a node with only an id is labelled by it');
	assert.deepStrictEqual(r.spec.edges, [{ from: 'ok', to: '7' }]);
	assert.match(r.notes.join(' | '), /2 nodes dropped/);
});

test('DEGRADE: nothing drawable is `failed` — never an empty picture', () => {
	for (const bad of [{ title: 'T', nodes: [], edges: [] }, { title: 'T', nodes: [{}, { sub: 'no name' }, null, []], edges: [] }, { title: 'T' }, 'prose', 42, null, [], { nodes: 'a,b' }]) {
		const r = R.prepare(bad, { final: true });
		assert.strictEqual(r.status, 'failed', JSON.stringify(bad));
		assert.ok(r.errors.length > 0, 'failed, with the reason');
		assert.strictEqual(r.spec, undefined);
	}
});

test('ACCEPT: the renderer\'s last-moment check — valid passes, old versions migrate, broken is cut down or refused', () => {
	assert.deepStrictEqual(R.accept(jev()), { ok: true, spec: jev(), notes: [] });
	const noV = jev(); delete noV.v;
	assert.strictEqual(R.accept(noV).spec.v, 1);
	const broken = jev(); broken.edges.push({ from: 'jev', to: 'ghost' });
	const cut = R.accept(broken);
	assert.strictEqual(cut.ok, true);
	assert.strictEqual(cut.spec.edges.length, 3);
	assert.deepStrictEqual(cut.notes, ['1 edge dropped: unknown nodes']);
	assert.strictEqual(R.accept({ title: 'T', nodes: [] }).ok, false);
	assert.strictEqual(R.accept(null).ok, false);
	// a degraded spec (over the house count) is accepted as-is: it already went through the ladder
	const big = { v: 1, title: 'T', direction: 'right', nodes: Array.from({ length: 15 }, (_, i) => ({ id: 'n' + i, label: 'L' })), edges: [] };
	assert.deepStrictEqual(R.accept(big), { ok: true, spec: big, notes: [] });
});

test('ACCEPT: what is handed to the renderer is the declared shape and nothing that came along with it', () => {
	// a record from a session file can carry anything; the validator is silent about fields it does not know
	const stored = jev();
	stored.script = 'alert(1)'; stored.onload = 'x()'; stored.nodes[0].onclick = 'alert(2)'; stored.nodes[0].style = 'position:fixed';
	stored.nodes[1].link = { path: 'agent.js', symbol: 'runAgent', href: 'javascript:alert(3)', command: 'rm -rf' };
	stored.edges[0].href = 'https://example.invalid/'; stored.nodes[0].tip = 'the full label';
	const a = R.accept(stored);
	assert.strictEqual(a.ok, true);
	assert.deepStrictEqual(a.notes, [], 'nothing was lost that a picture shows, so there is nothing to tell the user');
	const want = jev(); want.nodes[0].tip = 'the full label'; want.nodes[1].link = { path: 'agent.js', symbol: 'runAgent' };
	assert.deepStrictEqual(a.spec, want);
	assert.ok(!/alert|javascript:|rm -rf|example\.invalid|position:fixed/.test(JSON.stringify(a.spec)));
	assert.strictEqual(stored.script, 'alert(1)', 'the input is not edited in place');
	// a clean spec comes back equal, field for field and in the order it was stored — Copy source does not reshuffle
	const clean = R.prepare(jev()).spec;
	assert.strictEqual(JSON.stringify(R.accept(clean).spec), JSON.stringify(clean));
	// and accepting twice is accepting once
	assert.deepStrictEqual(R.accept(a.spec).spec, a.spec);
	// the version is kept: it is how an old chat is told from a new one
	assert.strictEqual(a.spec.v, 1);
	assert.strictEqual(Object.keys(a.spec)[0], 'v');
	// names every object already answers to are not "declared" just because a lookup finds them
	const sly = JSON.parse('{"v":1,"title":"T","toString":"x","hasOwnProperty":"y","constructor":"z","__proto__":{"polluted":1},"nodes":[{"id":"a","label":"A","constructor":"z","valueOf":"w","__proto__":{"polluted":2}}],"edges":[]}');
	const got = R.accept(sly);
	assert.strictEqual(got.ok, true);
	assert.deepStrictEqual([Object.keys(got.spec), Object.keys(got.spec.nodes[0])], [['v', 'title', 'nodes', 'edges'], ['id', 'label']]);
	assert.strictEqual(got.spec.polluted, undefined); assert.strictEqual(got.spec.nodes[0].polluted, undefined);
	assert.strictEqual(Object.getPrototypeOf(got.spec), Object.prototype); assert.strictEqual(Object.getPrototypeOf(got.spec.nodes[0]), Object.prototype);
	assert.strictEqual(({}).polluted, undefined);
	assert.strictEqual(typeof got.spec.toString, 'function', 'and the real ones are still the real ones');
});

test('LENIENT JSON: what is inside a string is left alone', () => {
	const src = '{"title": "a } b // not a comment, /* nor this */ and a trailing , ]", "nodes": [{"id": "a", "label": "it\'s \\"quoted\\" \\\\ here"}], "edges": [],}';
	const p = R.parseLenient(src);
	assert.strictEqual(p.ok, true, p.error);
	assert.strictEqual(p.value.title, 'a } b // not a comment, /* nor this */ and a trailing , ]');
	assert.strictEqual(p.value.nodes[0].label, 'it\'s "quoted" \\ here');
});

test('LENIENT JSON: strict JSON takes the strict path; numbers, nesting and unicode survive the tolerant one', () => {
	assert.deepStrictEqual(R.parseLenient('{"a":[1,2.5,-3e2,true,null,{"b":"é🙂"}]}'), { ok: true, value: { a: [1, 2.5, -300, true, null, { b: 'é🙂' }] }, lenient: false });
	const p = R.parseLenient("{a: [1, 2.5, -3e2, True, None, {b: 'é🙂'},],}");
	assert.deepStrictEqual(p, { ok: true, value: { a: [1, 2.5, -300, true, null, { b: 'é🙂' }] }, lenient: true });
	assert.strictEqual(R.parseLenient('').ok, false);
	assert.strictEqual(R.parseLenient('no braces here').ok, false);
	assert.strictEqual(R.parseLenient('{"a": }').ok, false, 'garbage is not guessed at');
	assert.strictEqual(R.parseLenient('{"a": }').truncated, undefined, 'and it is not mistaken for truncation');
});

test('TEXT: truncate() cuts at a word when one is near, counts characters, and never exceeds the limit', () => {
	assert.strictEqual(R.truncate('Validate the incoming request payload', 28), 'Validate the incoming…');
	assert.strictEqual(R.truncate('short', 28), 'short');
	assert.strictEqual(R.truncate('Supercalifragilisticexpialidocious', 12), 'Supercalifr…');
	assert.strictEqual(Array.from(R.truncate('🙂'.repeat(40), 10)).length, 10, 'an emoji is one character and is never split');
	for (let max = 2; max < 40; max++) { assert.ok(Array.from(R.truncate('The quick brown fox jumps over the lazy dog, twice.', max)).length <= max); }
});

test('TEXT: control characters, zero-width characters and bidi overrides never reach a label', () => {
	const r = R.prepare({ title: 'a\u0000b\u0007c', nodes: [{ id: 'a', label: 'invoice‮fdp.exe', sub: 'zero​width﻿ and\ttab\nnewline' }], edges: [] });
	assert.strictEqual(r.spec.title, 'abc');
	assert.strictEqual(r.spec.nodes[0].label, 'invoicefdp.exe', 'the right-to-left override is gone, so the label reads as what it is');
	assert.strictEqual(r.spec.nodes[0].sub, 'zerowidth and tab newline');
	// eslint-disable-next-line no-control-regex
	assert.ok(!/[\u0000-\u001f​-‏‪-‮⁦-⁩﻿]/.test(JSON.stringify(r.spec).replace(/\\u/g, '')));
});

test('TEXT: markup in a label is TEXT — kept exactly, never interpreted (the painter escapes it)', () => {
	const r = R.prepare({ title: '<script>alert(1)</script>', nodes: [{ id: 'a', label: '<b onclick=x>hi</b>' }], edges: [] });
	assert.strictEqual(r.spec.title, '<script>alert(1)</script>');
	assert.strictEqual(r.spec.nodes[0].label, '<b onclick=x>hi</b>');
});

test('LINKS: shaped here, never trusted here — the host decides what may be opened', () => {
	const r = R.prepare({ title: 'T', nodes: [
		{ id: 'a', label: 'A', link: { path: 'src/agent.js', symbol: 'runAgent', line: '12' } },
		{ id: 'b', label: 'B', link: 'src/agent.js:890' },
		{ id: 'c', label: 'C', link: 'src/agent.js#runTool' },
		{ id: 'd', label: 'D', link: 'file:///etc/passwd' },
		{ id: 'e', label: 'E', link: { path: '../../secrets.env', line: -4 } },
		{ id: 'f', label: 'F', link: { symbol: 'no path' } },
		{ id: 'g', label: 'G', link: 42 }
	], edges: [] });
	assert.strictEqual(r.status, 'ok', JSON.stringify(r.errors));
	const links = r.spec.nodes.map((x) => x.link);
	assert.deepStrictEqual(links[0], { path: 'src/agent.js', symbol: 'runAgent', line: 12 });
	assert.deepStrictEqual(links[1], { path: 'src/agent.js', line: 890 });
	assert.deepStrictEqual(links[2], { path: 'src/agent.js', symbol: 'runTool' });
	assert.deepStrictEqual(links[3], { path: '/etc/passwd' }, 'kept as a path; refusing it is the host\'s job, and it does');
	assert.deepStrictEqual(links[4], { path: '../../secrets.env' }, 'a bad line number is dropped, the path is not judged here');
	assert.strictEqual(links[5], undefined, 'no path, no link');
	assert.strictEqual(links[6], undefined);
});

test('SAFETY: a spec cannot reach Object.prototype', () => {
	const evil = '{"title":"T","__proto__":{"polluted":1},"constructor":{"prototype":{"polluted":1}},"nodes":[{"id":"a","label":"A","__proto__":{"polluted":1}}],"edges":[{"from":"a","to":"a","__proto__":{"polluted":1}}],"groups":{"__proto__":{"label":"x"}}}';
	const r = R.prepare(evil, { final: true });
	assert.ok(r.spec, r.status);
	assert.strictEqual(({}).polluted, undefined);
	assert.strictEqual(Object.prototype.polluted, undefined);
	assert.strictEqual(Object.getPrototypeOf(r.spec), Object.prototype);
	for (const x of r.spec.nodes) { assert.deepStrictEqual(Object.keys(x).sort(), ['id', 'label']); }
});

test('ROBUST: prepare() never throws and always names a status — seeded junk, both attempts', () => {
	let seed = 20261004;
	const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
	const atoms = [null, undefined, 0, -1, 1e21, NaN, '', 'a', 'right', 'true', true, false, [], {}, [[]], { id: 'a' }, { from: 'a', to: 'b' }, 'a -> b', ['a', 'b'], '\u0000', '🙂', { path: 'x' }];
	const pick = () => atoms[Math.floor(rnd() * atoms.length)];
	const STATUSES = ['ok', 'fixed', 'errors', 'degraded', 'failed', 'truncated'];
	for (let i = 0; i < 1500; i++) {
		const spec = {};
		for (const k of ['v', 'title', 'direction', 'nodes', 'edges', 'groups']) {
			if (rnd() < 0.75) { spec[k] = rnd() < 0.5 ? pick() : Array.from({ length: Math.floor(rnd() * 5) }, () => (rnd() < 0.5 ? pick() : { id: pick(), label: pick(), sub: pick(), shape: pick(), accent: pick(), group: pick(), link: pick(), from: pick(), to: pick(), parent: pick(), style: pick() })); }
		}
		for (const final of [false, true]) {
			const r = R.prepare(rnd() < 0.2 ? JSON.stringify(spec) : spec, { final });
			assert.ok(STATUSES.includes(r.status), r.status);
			assert.ok(Array.isArray(r.fixes) && Array.isArray(r.errors) && Array.isArray(r.notes));
			if (r.spec) { assert.strictEqual(V.validate(r.spec, { tier: 'hard' }).ok, true, 'whatever is drawn is valid: ' + JSON.stringify(spec)); }
			if (final) { assert.notStrictEqual(r.status, 'errors'); }
		}
	}
});

console.log('diagramRepair: ' + n + ' tests passed');
