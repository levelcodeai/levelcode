/*---------------------------------------------------------------------------------------------
 *  Rich diagrams — the counters behind the rollout gates — run: node test/diagramStats.test.js
 *
 *  docs/RICH-DIAGRAMS.md, "Telemetry and evaluation": first-pass valid rate, fix share by rung, top
 *  error classes, render time, diagram tokens, ASCII leaks, code-link use — "Telemetry records
 *  formats, error classes, timings and token counts; never labels, paths or code."
 *
 *  These counters are local (the host keeps them in the editor's own storage). The tests pin the
 *  arithmetic the gates are read from, and the one promise that matters more than the arithmetic:
 *  nothing a diagram SAYS can end up in them.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

const assert = require('assert');
const S = require('../diagram/stats');
const { createDiagrams } = require('../diagram/service');

let n = 0;
function test(name, fn) { fn(); n++; console.log('  ok - ' + name); }

const call = (model, outcome, extra) => Object.assign({ type: 'call', model, format: 'graph', outcome }, extra);
const fold = (events) => events.reduce((s, ev) => S.record(s, ev), S.empty('2026-10-04'));

test('RATES: first-pass valid, auto-fixed, model-repaired and degraded — as shares of the calls that reached a verdict', () => {
	const events = [];
	for (let i = 0; i < 90; i++) { events.push(call('model-a', 'clean', { tokens: 250 })); }
	for (let i = 0; i < 4; i++) { events.push(call('model-a', 'tidied')); }
	for (let i = 0; i < 2; i++) { events.push(call('model-a', 'fixed')); }
	for (let i = 0; i < 3; i++) { events.push(call('model-a', 'bounced', { errorClasses: { 'accent-count': 1 } })); events.push(call('model-a', 'repaired')); }
	events.push(call('model-a', 'bounced', { errorClasses: { 'unknown-node': 2 } }), call('model-a', 'degraded', { errorClasses: { 'unknown-node': 2 } }));
	const sum = S.summarize(fold(events));
	assert.strictEqual(sum.calls, 104, 'every call is counted');
	assert.strictEqual(sum.overall.verdicts, 100, 'a bounce is not a verdict — the call that answers it is');
	assert.deepStrictEqual([sum.overall.firstPassValid, sum.overall.autoFixed, sum.overall.modelRepaired, sum.overall.degraded], [90, 6, 3, 1]);
	assert.deepStrictEqual(sum.topErrors, [{ cls: 'accent-count', count: 3 }, { cls: 'unknown-node', count: 2 }], 'classes are counted once per call they appear in, most frequent first');
	assert.deepStrictEqual(sum.byModel.map((m) => m.model), ['model-a']);
});

test('RATES: kept per model — the eval compares models, not an average of them', () => {
	const sum = S.summarize(fold([call('good', 'clean'), call('good', 'clean'), call('weak', 'bounced', { errorClasses: { count: 1 } }), call('weak', 'degraded', { errorClasses: { count: 1 } }), call('weak', 'failed')]));
	const by = Object.fromEntries(sum.byModel.map((m) => [m.model, m]));
	assert.strictEqual(by.good.firstPassValid, 100);
	assert.strictEqual(by.weak.firstPassValid, 0);
	assert.strictEqual(by.weak.degraded, 100, 'failed counts with degraded: both ended without the diagram the model meant');
	assert.deepStrictEqual(by.weak.topErrors, [{ cls: 'count', count: 2 }]);
	assert.deepStrictEqual(by.good.topErrors, []);
	assert.strictEqual(S.summarize(S.empty()).overall.firstPassValid, null, 'no calls, no rate — not 0%, and not 100%');
});

test('TOKENS and RENDER TIME: histograms, read back as the bucket a quantile falls in', () => {
	const events = [];
	for (const t of [120, 180, 240, 260, 310, 330, 350, 380, 420, 1500]) { events.push(call('m', 'clean', { tokens: t })); }
	for (const ms of [3, 4, 5, 6, 7, 9, 12, 14, 40, 280]) { events.push({ type: 'render', ok: true, ms }); }
	events.push({ type: 'render', ok: false, message: 'boom' }, { type: 'render', ok: true, ms: 5, flipped: true });
	const sum = S.summarize(fold(events));
	assert.deepStrictEqual(sum.tokens, { median: 400, p95: 2000 }, 'median in the 301–400 bucket; the outlier sets p95');
	assert.strictEqual(sum.renderMs.p50, 8);
	assert.strictEqual(sum.renderMs.p95, 300);
	assert.deepStrictEqual([sum.renderMs.rendered, sum.renderMs.failed, sum.renderMs.flipped], [11, 1, 1]);
	assert.strictEqual(S.quantile([0, 0, 0], [1, 2], 0.5), null);
	assert.strictEqual(S.quantile([0, 0, 5], [1, 2], 0.5), Infinity, 'past the last bound is "more", not a made-up number');
});

test('LEAKS, LINKS, EXPORTS: counted', () => {
	const sum = S.summarize(fold([{ type: 'answer', asciiArt: false }, { type: 'answer', asciiArt: true }, { type: 'answer', asciiArt: false }, { type: 'link' }, { type: 'link' }, { type: 'export', format: 'svg' }, { type: 'export', format: 'png' }, { type: 'export', format: 'svg' }, { type: 'export', format: 'exe' }]));
	assert.deepStrictEqual(sum.asciiLeaks, { answers: 3, leaks: 1 });
	assert.strictEqual(sum.linkClicks, 2);
	assert.deepStrictEqual(sum.exports, { svg: 2, png: 1 }, 'an unknown format is not a format');
});

test('PRIVACY: nothing a diagram says can reach the counters — whatever the event carries', () => {
	const secret = 'ACME-INTERNAL-payments-ledger';
	const nosy = call('m', 'degraded', {
		title: secret, labels: [secret], path: '/Users/x/' + secret + '.rb', spec: { title: secret, nodes: [{ id: 'a', label: secret }] }, source: secret, message: secret,
		errorClasses: { 'unknown-node': 1, [secret]: 1, ['unknown node "' + secret + '"']: 1, 'UPPER': 1, 'a b': 1 },
		fixClasses: { length: 1, [secret + '.rb']: 1 },
		tokens: 300
	});
	let s = fold([nosy, { type: 'render', ok: false, message: secret }, { type: 'export', format: secret }, { type: 'answer', asciiArt: true, text: secret }, { type: 'link', path: secret, node: secret }]);
	const dump = JSON.stringify(s) + JSON.stringify(S.summarize(s));
	assert.ok(!dump.includes(secret), 'the title/label/path leaked into the stats');
	assert.ok(!/ACME|payments|ledger/i.test(dump));
	assert.deepStrictEqual(Object.keys(s.errors), ['unknown-node'], 'only class names shaped like class names are kept');
	assert.deepStrictEqual(Object.keys(s.fixes), ['length']);
	// and the real service sends nothing but enums and numbers in the first place
	const events = [];
	const service = createDiagrams({ onStat: (ev) => events.push(ev) });
	service.beginRun();
	service.render({ title: secret, nodes: [{ id: 'a', label: secret, link: { path: secret + '.rb' } }], edges: [{ from: 'a', to: 'nowhere-' + secret }] }, { key: 'k', model: 'm' });
	service.endRun();
	service.noteAnswer('A plain answer mentioning ' + secret);
	assert.ok(events.length >= 3);
	assert.ok(!JSON.stringify(events).includes(secret), 'an event from the service carried text: ' + JSON.stringify(events));
	for (const ev of events) { for (const [k, v] of Object.entries(ev)) { assert.ok(['string', 'number', 'boolean', 'undefined'].includes(typeof v) || k === 'errorClasses' || k === 'fixClasses', k + ' is a ' + typeof v); } }
});

test('BOUNDED: a flood of model ids or class names cannot grow the store without limit', () => {
	let s = S.empty();
	for (let i = 0; i < 500; i++) { s = S.record(s, call('model-' + i, 'clean', { errorClasses: { ['cls-' + i]: 1 } })); }
	assert.ok(Object.keys(s.byModel).length <= 40, String(Object.keys(s.byModel).length));
	assert.ok(Object.keys(s.errors).length <= 60);
	s = S.record(S.empty(), call('x'.repeat(5000), 'clean'));
	assert.ok(Object.keys(s.byModel)[0].length <= 80);
	assert.ok(JSON.stringify(s).length < 2000);
});

test('ROBUST: junk events are ignored; an unknown outcome is not counted; an old store starts over', () => {
	let s = S.empty('2026-10-04');
	for (const junk of [null, undefined, 3, 'call', {}, { type: 'call' }, { type: 'call', outcome: 'exploded' }, { type: 'render', ms: NaN }, { type: 'render', ms: -4 }, { type: 'nope' }]) { s = S.record(s, junk); }
	assert.strictEqual(s.calls, 0);
	assert.strictEqual(s.rendered, 2, 'a render with a nonsense duration still happened; only the duration is dropped');
	assert.strictEqual(s.renderMs.reduce((a, b) => a + b, 0), 0);
	const old = { v: 0, since: '2025-01-01', calls: 99, byModel: 'corrupt' };
	const fresh = S.record(old, call('m', 'clean'));
	assert.strictEqual(fresh.v, S.VERSION); assert.strictEqual(fresh.calls, 1); assert.strictEqual(fresh.since, '2025-01-01');
	assert.doesNotThrow(() => S.summarize(null)); assert.doesNotThrow(() => S.summarize({ v: 99 }));
});

test('END TO END: what the service reports adds up to the spec\'s table', () => {
	let s = S.empty('2026-10-04');
	const service = createDiagrams({ onStat: (ev) => { s = S.record(s, ev); } });
	const good = { title: 'T', nodes: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], edges: [{ from: 'a', to: 'b' }] };
	const sloppy = { title: 'T2', rankdir: 'LR', nodes: [{ id: 'a', label: 'A', shape: 'diamond' }], edges: [] };
	const long = { title: 'T3', nodes: [{ id: 'a', label: 'A label that is far longer than twenty-eight characters' }], edges: [] };
	const bad = { title: 'T4', nodes: [{ id: 'x', label: 'X' }], edges: [{ from: 'x', to: 'ghost' }] };
	service.beginRun(); service.render(good, { key: '1', model: 'm' }); service.endRun();
	service.beginRun(); service.render(sloppy, { key: '2', model: 'm' }); service.endRun();
	service.beginRun(); service.render(long, { key: '3', model: 'm' }); service.endRun();
	service.beginRun(); service.render(bad, { key: '4', model: 'm' }); service.render(Object.assign({}, bad, { edges: [] }), { key: '5', model: 'm' }); service.endRun();   // bounced, then repaired
	service.beginRun(); service.render(bad, { key: '6', model: 'm' }); service.render(bad, { key: '7', model: 'm' }); service.endRun();                                   // bounced, then degraded
	service.beginRun(); service.render(bad, { key: '8', model: 'm' }); service.endRun();                                                                                    // bounced, never answered → settled
	const sum = S.summarize(s);
	const m = s.byModel.m.outcomes;
	assert.deepStrictEqual(m, { clean: 1, tidied: 1, fixed: 1, bounced: 3, repaired: 1, degraded: 2 });
	assert.strictEqual(sum.overall.verdicts, 6);
	assert.deepStrictEqual([sum.overall.firstPassValid, sum.overall.autoFixed, sum.overall.modelRepaired, sum.overall.degraded], [16.7, 33.3, 16.7, 33.3]);
	assert.strictEqual(sum.topErrors[0].cls, 'unknown-node');
	assert.ok(sum.tokens.median <= 100, 'these are tiny specs: ' + sum.tokens.median);
});

console.log('diagramStats: ' + n + ' tests passed');
