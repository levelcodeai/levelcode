/*---------------------------------------------------------------------------------------------
 *  LevelCode — AI · model catalog + per-model capabilities  [P4]
 *
 *  Replaces the flat hard-coded context window (200000 everywhere) and the coarse per-PROVIDER tool
 *  gate with REAL per-MODEL capabilities: context window, tool support, vision, and a "fast" flag for
 *  inline completion. Two sources, merged:
 *    1. a static CAPS table + basename/pattern heuristics (works offline, for models that only return an id)
 *    2. a best-effort dynamic fetch of each provider's /models list (OpenRouter is richest — it returns
 *       context length + modality + supported_parameters; OpenAI-compatible /v1/models returns ids).
 *
 *  Per-model tool support is what lets e.g. deepseek-reasoner be offered for CHAT while the agent stays
 *  gated off it (its tool loop needs reasoning_content round-tripping we don't carry). The pure caps
 *  logic + the raw-response mappers are unit-tested (test/catalog.test.js); the fetch is thin IO.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

const { getProvider, listOllamaModels } = require('./index');
const openai = require('./openaiCompat');

/**
 * Per-model capabilities, keyed by canonical model id (basename — an OpenRouter 'vendor/model' id is
 * matched on its basename too). context = input context window (tokens); tools/vision = native support;
 * fast = good default for inline (ghost-text) completion. A model may set tools:false to opt OUT of the
 * agent even on a tool-capable provider.
 */
const CAPS = {
	// Anthropic
	'claude-opus-4-8':           { context: 200000, tools: true, vision: true, caching: true },
	'claude-sonnet-4-6':         { context: 200000, tools: true, vision: true, caching: true },
	'claude-haiku-4-5-20251001': { context: 200000, tools: true, vision: true, fast: true },
	// OpenAI
	'gpt-4o':      { context: 128000, tools: true, vision: true },
	'gpt-4o-mini': { context: 128000, tools: true, vision: true, fast: true },
	'o3-mini':     { context: 200000, tools: true, reasoning: true },
	'o1':          { context: 200000, tools: true, reasoning: true },
	'o1-mini':     { context: 128000, tools: false, reasoning: true },   // o1-mini has no function calling
	// Groq
	'llama-3.3-70b-versatile': { context: 128000, tools: true },
	'llama-3.1-8b-instant':    { context: 128000, tools: true, fast: true },
	// Together
	'meta-llama/Llama-3.3-70B-Instruct-Turbo': { context: 128000, tools: true },
	// Fireworks
	'accounts/fireworks/models/llama-v3p3-70b-instruct': { context: 128000, tools: true },
	// DeepSeek — reasoner opts OUT of tools (its tool loop needs reasoning_content round-tripping)
	'deepseek-chat':     { context: 64000, tools: true },
	'deepseek-reasoner': { context: 64000, tools: false, reasoning: true },
	// xAI
	'grok-2-latest': { context: 131072, tools: true, vision: true },
	// Mistral
	'mistral-large-latest': { context: 128000, tools: true },
	'codestral-latest':     { context: 256000, tools: true, fast: true },
	// LevelCode Cloud gateway engines (also reachable BYOK via OpenRouter)
	'openai/gpt-oss-120b':       { context: 131072, tools: true },              // free tier
	'moonshotai/kimi-k2.7-code': { context: 262144, tools: true, fast: true }   // Pro flagship
};

/** The basename of a model id ('openai/gpt-4o' → 'gpt-4o', 'gpt-4o' → 'gpt-4o'). */
function baseName(id) {
	const s = String(id || '');
	const i = s.lastIndexOf('/');
	return i >= 0 ? s.slice(i + 1) : s;
}

/** Family heuristics for a model we don't have an exact CAPS row for. Returns null if nothing matches. */
function heuristicCaps(id) {
	const b = baseName(id).toLowerCase();
	if (/^o[1-9]/.test(b)) {
		// The o1-mini / o1-preview families (incl. dated snapshots like o1-mini-2024-09-12) have NO function
		// calling and a 128k window; o1 / o3 / o4 (and o3-mini) do support tools. Demote only the former.
		const noTools = /^o1-(mini|preview)/.test(b);
		return { context: noTools ? 128000 : 200000, tools: !noTools, reasoning: true };
	}
	if (b.startsWith('claude-')) { return { context: 200000, tools: true, vision: true }; }
	if (b.startsWith('gpt-4') || b.startsWith('gpt-5') || b.startsWith('chatgpt')) { return { context: 128000, tools: true, vision: true }; }
	if (b.includes('gemini')) { return { context: 1000000, tools: true, vision: true }; }
	if (b.includes('codestral')) { return { context: 256000, tools: true, fast: true }; }
	if (b.includes('deepseek')) { return { context: 64000, tools: true }; }
	if (b.includes('llama') || b.includes('mixtral') || b.includes('mistral') || b.includes('qwen') || b.includes('gemma') || b.includes('command') || b.includes('grok')) { return { context: 128000, tools: true }; }
	return null;
}

/** Resolve caps for a model id: exact → basename-exact → family heuristic → permissive default (tools:true). */
function modelCaps(id) {
	if (!id) { return { tools: true }; }
	if (CAPS[id]) { return CAPS[id]; }
	const b = baseName(id);
	if (CAPS[b]) { return CAPS[b]; }
	const h = heuristicCaps(id);
	if (h) { return h; }
	return { tools: true };   // unknown model: most modern chat models support tools; context unknown
}

/**
 * Whether the AGENT (tool loop) may run on this provider+model. Combines the provider-level gate
 * (Ollama off) with the per-model opt-out (a model may set tools:false, e.g. deepseek-reasoner).
 */
function supportsToolsForModel(providerId, modelId) {
	const p = getProvider(providerId);
	if (!p || !(p.caps && p.caps.tools)) { return false; }
	return modelCaps(modelId).tools !== false;
}

/** The model's context window (tokens), or `fallback` (then 200000) when unknown. */
function contextWindowFor(providerId, modelId, fallback) {
	return modelCaps(modelId).context || fallback || 200000;
}

/** A per-provider fast model for inline (ghost-text) completion, or null → use the active model. */
const FAST_COMPLETION = {
	claude: 'claude-haiku-4-5-20251001',
	openai: 'gpt-4o-mini',
	openrouter: 'openai/gpt-4o-mini',
	groq: 'llama-3.1-8b-instant',
	mistral: 'codestral-latest'
};
function fastCompletionModel(providerId) {
	const p = getProvider(providerId);
	return (p && FAST_COMPLETION[p.id]) || null;
}

/** Format a caps object as a compact QuickPick detail string, e.g. "128k ctx · tools · vision". */
function fmtContext(n) { return n >= 1000 ? Math.round(n / 1000) + 'k ctx' : n + ' ctx'; }
function describeCaps(c) {
	if (!c) { return ''; }
	const parts = [];
	if (c.context) { parts.push(fmtContext(c.context)); }
	if (c.reasoning) { parts.push('reasoning'); }
	if (c.tools) { parts.push('tools'); }
	if (c.vision) { parts.push('vision'); }
	if (c.fast) { parts.push('fast'); }
	return parts.join(' · ');
}
function describeModel(id) { return describeCaps(modelCaps(id)); }

// ---- dynamic /models mappers (PURE — unit-tested) ------------------------------------------

/** OpenRouter /api/v1/models raw response → [{id,label,context,tools,vision}] (richest source). */
function mapOpenRouterModels(data) {
	const arr = Array.isArray(data && data.data) ? data.data : [];
	return arr.map((m) => {
		const arch = m.architecture || {};
		// OpenRouter's legacy `modality` string is "input+parts->output" (e.g. "text+image->text") — take the
		// input side only. The modern `input_modalities` array is preferred when present.
		const inMod = Array.isArray(arch.input_modalities) ? arch.input_modalities : (typeof arch.modality === 'string' ? arch.modality.split('->')[0].split('+') : []);
		return {
			id: m.id,
			label: m.name || m.id,
			context: m.context_length || undefined,
			tools: Array.isArray(m.supported_parameters) ? m.supported_parameters.includes('tools') : undefined,
			vision: inMod.length ? inMod.includes('image') : undefined
		};
	}).filter((m) => m.id);
}

/** A plain list of model ids (OpenAI-compatible /v1/models) → choices, caps filled from the static table. */
function mapModelIds(ids) {
	return (ids || []).filter(Boolean).map((id) => {
		const c = modelCaps(id);
		return { id, label: id, context: c.context, tools: c.tools, vision: c.vision };
	});
}

// ---- dynamic fetch (thin IO around the pure mappers) ---------------------------------------

/** fetch() with a hard timeout so a host that accepts the connection but never responds can't hang the picker. */
async function fetchWithTimeout(url, opts, ms) {
	const ac = new AbortController();
	const t = setTimeout(() => ac.abort(), ms || 8000);
	try { return await fetch(url, Object.assign({}, opts || {}, { signal: ac.signal })); }
	finally { clearTimeout(t); }
}

/** Best-effort live model list for a provider. Returns [] on any failure (offline/no key/unsupported/timeout). */
async function fetchModels(providerId, opts) {
	const p = getProvider(providerId);
	if (!p) { return []; }
	const o = opts || {};
	try {
		if (p.id === 'openrouter') {
			const res = await fetchWithTimeout('https://openrouter.ai/api/v1/models', { headers: p.headers || {} }, 8000);
			if (!res.ok) { return []; }
			return mapOpenRouterModels(await res.json());
		}
		if (p.id === 'ollama') {
			// /api/tags lives at the server ROOT, not under /v1 — use the raw ollama url (strip a /v1 baseURL).
			const url = o.ollamaUrl || String(o.baseURL || 'http://localhost:11434').replace(/\/v1\/?$/, '');
			const list = await listOllamaModels(url);
			return list.map((id) => ({ id, label: id }));   // Ollama tool support is model-specific; leave caps unknown
		}
		if (p.kind === 'openai') {
			const ids = await openai.listOpenAIModels({ baseURL: o.baseURL || p.baseURL, apiKey: o.apiKey, headers: p.headers });
			return mapModelIds(ids);
		}
		return [];   // anthropic: stable curated built-ins (no dynamic fetch here)
	} catch {
		return [];
	}
}

/**
 * The merged model list for a provider's picker: the registry built-ins first (always, works offline),
 * then any dynamically-fetched models not already listed. Each choice carries a `detail` caps string.
 * @returns {Promise<Array<{id:string,label:string,detail:string,context?:number,tools?:boolean,vision?:boolean}>>}
 */
async function getModelChoices(providerId, opts) {
	const p = getProvider(providerId);
	if (!p) { return []; }
	const choices = (p.models || []).map((m) => ({
		id: m.id, label: m.label, detail: [m.detail, describeModel(m.id)].filter(Boolean).join(' · '),
		context: modelCaps(m.id).context, tools: modelCaps(m.id).tools, vision: modelCaps(m.id).vision
	}));
	const seen = new Set(choices.map((c) => c.id));
	if (opts && opts.dynamic) {
		for (const d of await fetchModels(providerId, opts)) {
			if (seen.has(d.id)) { continue; }
			seen.add(d.id);
			choices.push({ id: d.id, label: d.label || d.id, detail: describeCaps({ context: d.context, tools: d.tools, vision: d.vision }) || describeModel(d.id), context: d.context, tools: d.tools, vision: d.vision });
		}
	}
	return choices;
}

module.exports = {
	CAPS, modelCaps, baseName, heuristicCaps,
	supportsToolsForModel, contextWindowFor, fastCompletionModel,
	describeCaps, describeModel,
	mapOpenRouterModels, mapModelIds, fetchModels, getModelChoices
};
