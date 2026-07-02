/*---------------------------------------------------------------------------------------------
 *  Atom++ — Agent Sketch · model pricing  [SK1]
 *
 *  $ per MILLION tokens (input/output), used by the sketch's per-node cost meter and the
 *  "what-if: recalculate this flow on a different model" comparison. Anthropic prices are from
 *  Anthropic's published table (2026-06); other providers are PUBLISHED LIST PRICES AS OF THE
 *  SAME DATE and may drift — the UI labels every figure "est." and nothing bills from this table
 *  (BYOK: the provider bills the user directly; this is purely a planning aid).
 *
 *  Matching mirrors providers/catalog.js: exact id → basename (so OpenRouter's
 *  'anthropic/claude-sonnet-4-6' resolves to the same row) → prefix family → null (unknown).
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

const { baseName } = require('../providers/catalog');

/** @type {Record<string, {inM:number, outM:number}>} $/MTok in, out */
const PRICING = {
	// Anthropic (published)
	'claude-opus-4-8':           { inM: 5.00, outM: 25.00 },
	'claude-sonnet-4-6':         { inM: 3.00, outM: 15.00 },
	'claude-haiku-4-5':          { inM: 1.00, outM: 5.00 },
	'claude-haiku-4-5-20251001': { inM: 1.00, outM: 5.00 },
	// OpenAI (list)
	'gpt-4o':      { inM: 2.50, outM: 10.00 },
	'gpt-4o-mini': { inM: 0.15, outM: 0.60 },
	'o3-mini':     { inM: 1.10, outM: 4.40 },
	// DeepSeek (list)
	'deepseek-chat':     { inM: 0.27, outM: 1.10 },
	'deepseek-reasoner': { inM: 0.55, outM: 2.19 },
	// Groq (list)
	'llama-3.3-70b-versatile': { inM: 0.59, outM: 0.79 },
	'llama-3.1-8b-instant':    { inM: 0.05, outM: 0.08 },
	// Meta via aggregators (typical)
	'llama-3.3-70b-instruct': { inM: 0.12, outM: 0.30 },
	'Llama-3.3-70B-Instruct-Turbo': { inM: 0.88, outM: 0.88 },
	'llama-v3p3-70b-instruct': { inM: 0.90, outM: 0.90 },
	// Google via OpenRouter (list)
	'gemini-2.0-flash-001': { inM: 0.10, outM: 0.40 },
	// xAI (list)
	'grok-2-latest': { inM: 2.00, outM: 10.00 },
	// Mistral (list)
	'mistral-large-latest': { inM: 2.00, outM: 6.00 },
	'codestral-latest':     { inM: 0.30, outM: 0.90 }
};

/** Family fallbacks when neither the exact id nor its basename has a row. */
function familyPricing(b) {
	if (b.startsWith('claude-opus')) { return PRICING['claude-opus-4-8']; }
	if (b.startsWith('claude-sonnet')) { return PRICING['claude-sonnet-4-6']; }
	if (b.startsWith('claude-haiku')) { return PRICING['claude-haiku-4-5']; }
	if (b.startsWith('gpt-4o-mini')) { return PRICING['gpt-4o-mini']; }
	if (b.startsWith('gpt-')) { return PRICING['gpt-4o']; }
	if (/^o[1-9]/.test(b)) { return PRICING['o3-mini']; }
	if (b.startsWith('deepseek')) { return PRICING['deepseek-chat']; }
	if (b.includes('llama')) { return PRICING['llama-3.3-70b-instruct']; }
	if (b.includes('gemini')) { return PRICING['gemini-2.0-flash-001']; }
	if (b.includes('grok')) { return PRICING['grok-2-latest']; }
	if (b.includes('codestral')) { return PRICING['codestral-latest']; }
	if (b.includes('mistral') || b.includes('mixtral')) { return PRICING['mistral-large-latest']; }
	return null;
}

/** Pricing row for a model id, or null when genuinely unknown (UI shows "n/a", never guesses $0). */
function modelPricing(id) {
	if (!id) { return null; }
	if (PRICING[id]) { return PRICING[id]; }
	const b = baseName(id);
	if (PRICING[b]) { return PRICING[b]; }
	return familyPricing(b.toLowerCase());
}

/** Dollar cost of a call: tokens are raw counts (not millions). null when the model is unpriced. */
function costOf(modelId, inputTokens, outputTokens) {
	const p = modelPricing(modelId);
	if (!p) { return null; }
	return (Math.max(0, inputTokens || 0) * p.inM + Math.max(0, outputTokens || 0) * p.outM) / 1e6;
}

/** Compact money formatter for meters: $0.0042, $0.13, $2.40. */
function fmtUsd(n) {
	if (n == null) { return 'n/a'; }
	if (n === 0) { return '$0'; }
	if (n < 0.01) { return '$' + n.toFixed(4); }
	if (n < 1) { return '$' + n.toFixed(3); }
	return '$' + n.toFixed(2);
}

module.exports = { PRICING, modelPricing, costOf, fmtUsd };
