/*---------------------------------------------------------------------------------------------
 *  LevelCode — AI · rich diagrams · measurement  (docs/RICH-DIAGRAMS.md, "Telemetry and evaluation")
 *
 *  The spec's rollout is gated on numbers: how often a spec is valid first time, how the fixes split
 *  across the rungs of the ladder, which errors each model makes, how long a render takes, how many
 *  tokens a diagram costs, and whether an answer ever drew with characters.
 *
 *  This is the counter behind those numbers. It is LOCAL — a plain object the host keeps in the
 *  editor's own storage and shows on request; nothing here is sent anywhere.
 *
 *  What it records: formats, outcome classes, error classes, timings and token counts, per model.
 *  What it never records: a label, a title, a path, a symbol, or any other text from a spec. record()
 *  takes an event made of enums and numbers, and copies nothing else out of it.
 *
 *  Pure: no clock, no storage, no vscode. The host supplies the date and persists the object.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

const VERSION = 1;
/** How one call ended. `clean` is the spec's "first-pass valid": every layer passed with no fix at all. */
const OUTCOMES = ['clean', 'tidied', 'fixed', 'repaired', 'degraded', 'failed', 'truncated', 'bounced'];
/** Upper bounds of the histogram buckets (the last bucket is "more"). */
const TOKEN_BUCKETS = [100, 200, 300, 400, 600, 800, 1200, 2000];
const MS_BUCKETS = [8, 16, 33, 50, 100, 200, 300, 1000];
/** A model id is kept as written but bounded, so a pathological id cannot bloat the store. */
const MAX_MODELS = 40, MAX_CLASSES = 60;
const CLASS_RE = /^[a-z][a-z0-9-]{0,39}$/;

function empty(since) {
	return { v: VERSION, since: since || null, calls: 0, byModel: {}, errors: {}, fixes: {}, tokens: TOKEN_BUCKETS.map(() => 0).concat([0]), renderMs: MS_BUCKETS.map(() => 0).concat([0]), rendered: 0, renderFailed: 0, flipped: 0, asciiLeaks: 0, answers: 0, linkClicks: 0, exports: {} };
}
const bucket = (bounds, value) => { let i = 0; while (i < bounds.length && value > bounds[i]) { i++; } return i; };
const inc = (obj, key, cap) => { if (obj[key] !== undefined || Object.keys(obj).length < cap) { obj[key] = (obj[key] || 0) + 1; } };

/**
 * Fold one event in.
 *   { type: 'call', model, format, outcome, errorClasses?, fixClasses?, tokens? }
 *   { type: 'render', ms, ok, flipped? }      reported by the webview once the picture is on screen
 *   { type: 'answer', asciiArt }              one assistant answer to a rich client
 *   { type: 'link' } / { type: 'export', format }
 * Anything it does not recognise is ignored; nothing but the fields named above is ever read.
 */
function record(stats, ev) {
	const s = stats && stats.v === VERSION ? stats : empty(stats && stats.since);
	if (!ev || typeof ev !== 'object') { return s; }
	if (ev.type === 'call') {
		const outcome = OUTCOMES.indexOf(ev.outcome) >= 0 ? ev.outcome : null;
		if (!outcome) { return s; }
		s.calls++;
		const model = String(ev.model || 'unknown').slice(0, 80);
		if (!s.byModel[model] && Object.keys(s.byModel).length >= MAX_MODELS) { return s; }
		const m = s.byModel[model] || (s.byModel[model] = { calls: 0, outcomes: {}, errors: {} });
		m.calls++;
		m.outcomes[outcome] = (m.outcomes[outcome] || 0) + 1;
		for (const cls of Object.keys(ev.errorClasses || {})) { if (CLASS_RE.test(cls)) { inc(s.errors, cls, MAX_CLASSES); inc(m.errors, cls, MAX_CLASSES); } }
		for (const cls of Object.keys(ev.fixClasses || {})) { if (CLASS_RE.test(cls)) { inc(s.fixes, cls, MAX_CLASSES); } }
		if (Number.isFinite(ev.tokens) && ev.tokens > 0) { s.tokens[bucket(TOKEN_BUCKETS, ev.tokens)]++; }
	} else if (ev.type === 'render') {
		if (ev.ok === false) { s.renderFailed++; return s; }
		s.rendered++;
		if (ev.flipped) { s.flipped++; }
		if (Number.isFinite(ev.ms) && ev.ms >= 0) { s.renderMs[bucket(MS_BUCKETS, ev.ms)]++; }
	} else if (ev.type === 'answer') {
		s.answers++;
		if (ev.asciiArt) { s.asciiLeaks++; }
	} else if (ev.type === 'link') {
		s.linkClicks++;
	} else if (ev.type === 'export') {
		const f = String(ev.format || '');
		if (['svg', 'png', 'source', 'mermaid', 'markdown'].indexOf(f) >= 0) { s.exports[f] = (s.exports[f] || 0) + 1; }
	}
	return s;
}

/** The value below which `q` of a histogram's samples fall — reported as its bucket's upper bound. */
function quantile(hist, bounds, q) {
	const total = hist.reduce((a, b) => a + b, 0);
	if (!total) { return null; }
	let seen = 0;
	for (let i = 0; i < hist.length; i++) {
		seen += hist[i];
		if (seen >= total * q) { return i < bounds.length ? bounds[i] : Infinity; }
	}
	return Infinity;
}
const pct = (num, den) => (den ? Math.round(1000 * num / den) / 10 : null);

/**
 * The table from the spec's "Telemetry and evaluation", computed. Rates are percentages of the calls
 * that reached a verdict (a `bounced` call — one sent back for its repair pass — is not a verdict:
 * the call that answers it is).
 */
function summarize(stats) {
	const s = stats && stats.v === VERSION ? stats : empty();
	const rows = (map) => {
		const o = Object.assign({}, map);
		const verdicts = OUTCOMES.filter((k) => k !== 'bounced' && k !== 'truncated').reduce((a, k) => a + (o[k] || 0), 0);
		return {
			verdicts,
			firstPassValid: pct(o.clean || 0, verdicts),
			autoFixed: pct((o.tidied || 0) + (o.fixed || 0), verdicts),
			modelRepaired: pct(o.repaired || 0, verdicts),
			degraded: pct((o.degraded || 0) + (o.failed || 0), verdicts),
			truncated: o.truncated || 0
		};
	};
	const all = {};
	for (const m of Object.values(s.byModel)) { for (const [k, v] of Object.entries(m.outcomes)) { all[k] = (all[k] || 0) + v; } }
	const top = (map) => Object.entries(map).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 8).map(([cls, count]) => ({ cls, count }));
	return {
		since: s.since, calls: s.calls,
		overall: rows(all),
		byModel: Object.keys(s.byModel).sort().map((model) => Object.assign({ model, topErrors: top(s.byModel[model].errors) }, rows(s.byModel[model].outcomes))),
		topErrors: top(s.errors),
		tokens: { median: quantile(s.tokens, TOKEN_BUCKETS, 0.5), p95: quantile(s.tokens, TOKEN_BUCKETS, 0.95) },
		renderMs: { p50: quantile(s.renderMs, MS_BUCKETS, 0.5), p95: quantile(s.renderMs, MS_BUCKETS, 0.95), rendered: s.rendered, failed: s.renderFailed, flipped: s.flipped },
		asciiLeaks: { answers: s.answers, leaks: s.asciiLeaks },
		linkClicks: s.linkClicks, exports: Object.assign({}, s.exports)
	};
}

module.exports = { VERSION, OUTCOMES, TOKEN_BUCKETS, MS_BUCKETS, empty, record, summarize, quantile };
