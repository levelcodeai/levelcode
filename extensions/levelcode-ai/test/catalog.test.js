/*---------------------------------------------------------------------------------------------
 *  Unit tests for providers/catalog.js (P4) — pure caps logic + raw-response mappers.
 *  run: node test/catalog.test.js   (the dynamic fetch itself needs the network, so it's not exercised)
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

const assert = require('assert');
const C = require('../providers/catalog');

let n = 0;
function test(name, fn) { fn(); n++; console.log('  ok - ' + name); }

// ---- modelCaps: exact → basename → heuristic → default ----
test('modelCaps: exact table hit', () => {
	assert.deepStrictEqual(C.modelCaps('gpt-4o'), { context: 128000, tools: true, vision: true });
	assert.strictEqual(C.modelCaps('deepseek-reasoner').tools, false);
});
test('modelCaps: OpenRouter vendor/model matches on basename', () => {
	assert.deepStrictEqual(C.modelCaps('openai/gpt-4o'), C.modelCaps('gpt-4o'));
});
test('modelCaps: family heuristics for unknown ids', () => {
	assert.strictEqual(C.modelCaps('o4-mini').reasoning, true);       // o-series
	assert.strictEqual(C.modelCaps('claude-3-5-haiku-latest').vision, true);
	assert.strictEqual(C.modelCaps('gpt-4.1').tools, true);
	assert.strictEqual(C.modelCaps('google/gemini-2.0-pro').context, 1000000);
	assert.strictEqual(C.modelCaps('qwen2.5-coder:7b').tools, true);
});
test('modelCaps: dated o1-mini/o1-preview snapshots stay tools:false 128k; o1/o3/o4 keep tools:true', () => {
	// dated snapshots (what /v1/models actually returns) must NOT be flipped tool-capable by the heuristic
	for (const m of ['o1-mini-2024-09-12', 'o1-preview', 'o1-preview-2024-09-12', 'openai/o1-mini']) {
		assert.strictEqual(C.modelCaps(m).tools, false, m + ' should be tools:false');
		assert.strictEqual(C.modelCaps(m).context, 128000, m + ' should be 128k');
		assert.strictEqual(C.supportsToolsForModel('openai', m), false, m + ' must be agent-blocked');
	}
	for (const m of ['o1', 'o1-2024-12-17', 'o1-pro', 'o3-mini', 'o3-mini-2025-01-31', 'o4-mini']) {
		assert.strictEqual(C.modelCaps(m).tools, true, m + ' should be tools:true');
	}
});
test('modelCaps: unknown model → permissive default (tools:true, no context)', () => {
	const c = C.modelCaps('some-brand-new-model-x');
	assert.strictEqual(c.tools, true);
	assert.strictEqual(c.context, undefined);
});

// ---- supportsToolsForModel: provider gate + per-model opt-out ----
test('supportsToolsForModel: provider gate blocks Ollama; per-model opt-out blocks deepseek-reasoner', () => {
	assert.strictEqual(C.supportsToolsForModel('claude', 'claude-opus-4-8'), true);
	assert.strictEqual(C.supportsToolsForModel('openai', 'gpt-4o'), true);
	assert.strictEqual(C.supportsToolsForModel('openai', 'o3-mini'), true);
	assert.strictEqual(C.supportsToolsForModel('deepseek', 'deepseek-chat'), true);
	assert.strictEqual(C.supportsToolsForModel('deepseek', 'deepseek-reasoner'), false);   // agent blocked, chat still works
	assert.strictEqual(C.supportsToolsForModel('ollama', 'llama3.1'), false);               // provider-level gate
	assert.strictEqual(C.supportsToolsForModel('nope', 'x'), false);
});

// ---- contextWindowFor ----
test('contextWindowFor: known model wins; fallback then 200000 when unknown', () => {
	assert.strictEqual(C.contextWindowFor('openai', 'gpt-4o', 200000), 128000);
	assert.strictEqual(C.contextWindowFor('openai', 'unknown-x', 55555), 55555);
	assert.strictEqual(C.contextWindowFor('openai', 'unknown-x'), 200000);
	// Gateway Kimi K3 — its 1M window must beat the 200000 fallback, or the meter warns 5× too early.
	assert.strictEqual(C.contextWindowFor('openai', 'moonshotai/kimi-k3', 200000), 1048576);
	// Same trap for Opus 5: the `claude-` heuristic would hand back 200K and shrink a 1M window.
	assert.strictEqual(C.contextWindowFor('openai', 'anthropic/claude-opus-5', 200000), 1000000);
	// …and the heuristic is still what covers Claude ids we DON'T list (200K is the right default).
	assert.strictEqual(C.contextWindowFor('openai', 'anthropic/claude-opus-4-8', 200000), 200000);
});

// ---- fastCompletionModel ----
test('fastCompletionModel: per provider, null when none', () => {
	assert.strictEqual(C.fastCompletionModel('claude'), 'claude-haiku-4-5-20251001');
	assert.strictEqual(C.fastCompletionModel('openai'), 'gpt-4o-mini');
	assert.strictEqual(C.fastCompletionModel('groq'), 'llama-3.1-8b-instant');
	assert.strictEqual(C.fastCompletionModel('together'), null);   // no curated fast model → caller uses active model
	assert.strictEqual(C.fastCompletionModel('nope'), null);
});

// ---- describeModel / describeCaps ----
test('describeCaps: compact detail string', () => {
	assert.strictEqual(C.describeCaps({ context: 128000, tools: true, vision: true }), '128k ctx · tools · vision');
	assert.strictEqual(C.describeCaps({ context: 64000, tools: true }), '64k ctx · tools');
	assert.strictEqual(C.describeModel('o3-mini'), '200k ctx · reasoning · tools');
	assert.strictEqual(C.describeCaps(null), '');
});

// ---- mapOpenRouterModels: rich response → choices ----
test('mapOpenRouterModels: extracts id/label/context/tools/vision', () => {
	const out = C.mapOpenRouterModels({ data: [
		{ id: 'anthropic/claude-sonnet-4-6', name: 'Claude Sonnet 4.6', context_length: 200000, supported_parameters: ['tools', 'temperature'], architecture: { input_modalities: ['text', 'image'] } },
		{ id: 'meta-llama/llama-3.3-70b', name: 'Llama 3.3 70B', context_length: 131072, supported_parameters: ['temperature'], architecture: { input_modalities: ['text'] } }
	] });
	assert.strictEqual(out.length, 2);
	assert.deepStrictEqual(out[0], { id: 'anthropic/claude-sonnet-4-6', label: 'Claude Sonnet 4.6', context: 200000, tools: true, vision: true });
	assert.strictEqual(out[1].tools, false);   // no 'tools' in supported_parameters
	assert.strictEqual(out[1].vision, false);
});
test('mapOpenRouterModels: tolerates missing fields / non-array', () => {
	assert.deepStrictEqual(C.mapOpenRouterModels({}), []);
	assert.deepStrictEqual(C.mapOpenRouterModels(null), []);
	const out = C.mapOpenRouterModels({ data: [{ id: 'x/y' }] });   // no name/context/params
	assert.strictEqual(out[0].id, 'x/y');
	assert.strictEqual(out[0].label, 'x/y');
	assert.strictEqual(out[0].tools, undefined);
});
test('mapOpenRouterModels: legacy modality string "input->output" → vision from the INPUT side only', () => {
	// real OpenRouter legacy shape is "text+image->text"; splitting on '+' alone would mangle it
	const out = C.mapOpenRouterModels({ data: [
		{ id: 'a/vis', architecture: { modality: 'text+image->text' } },
		{ id: 'b/img-in', architecture: { modality: 'image->text' } },
		{ id: 'c/txt', architecture: { modality: 'text->text' } }
	] });
	assert.strictEqual(out[0].vision, true);
	assert.strictEqual(out[1].vision, true);
	assert.strictEqual(out[2].vision, false);
});

// ---- mapModelIds: plain id list → choices with static caps ----
test('mapModelIds: fills caps from the static table', () => {
	const out = C.mapModelIds(['gpt-4o', 'gpt-4o-mini', 'weird-model']);
	assert.strictEqual(out[0].context, 128000);
	assert.strictEqual(out[1].context, 128000);
	assert.strictEqual(out[2].tools, true);        // unknown → permissive default
	assert.strictEqual(out[2].context, undefined);
});

console.log('\ncatalog: ' + n + ' tests passed.');
