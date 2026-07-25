/*---------------------------------------------------------------------------------------------
 *  LevelCode — AI · provider registry + dispatch facade
 *
 *  The "many providers, little code" core: a data table (PROVIDERS) where every OpenAI-kind row
 *  shares ONE adapter (openaiCompat.js) and differs only by baseURL + auth + capabilities. Adding
 *  Cerebras / Moonshot / Qwen / Perplexity later is a new row, zero code. Anthropic keeps its own
 *  native adapter (anthropic.js) for prompt caching + full tool-use fidelity.
 *
 *  streamChat()/complete() dispatch on the row's `kind`. For plain chat both Anthropic and OpenAI
 *  accept the same {role,content:string} message shape, so no translation is needed here — the
 *  tool-use translation for the AGENT is the separate P2 layer (providers/translate.js).
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

const anthropic = require('./anthropic');
const openai = require('./openaiCompat');

/**
 * The registry. `id` is the value stored in `levelcode.ai.provider`. `kind` drives dispatch/translation.
 * `keyId` is the SecretStorage namespace (see secretStorageKey). `noKey` providers skip auth.
 * `models` are built-in defaults for the picker until the dynamic catalog (P4) lands.
 */
const PROVIDERS = {
	claude: {
		id: 'claude', kind: 'anthropic', label: 'Anthropic (Claude)', keyId: 'anthropic',
		caps: { tools: true, caching: true, vision: true }, agent: true,
		models: [
			{ id: 'claude-opus-4-8', label: 'Claude Opus 4.8', detail: 'Most capable' },
			{ id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', detail: 'Balanced (default)' },
			{ id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5', detail: 'Fastest' }
		]
	},
	openai: {
		id: 'openai', kind: 'openai', label: 'OpenAI', baseURL: 'https://api.openai.com/v1', keyId: 'openai',
		caps: { tools: true, vision: true },
		models: [
			{ id: 'gpt-4o', label: 'GPT-4o' },
			{ id: 'gpt-4o-mini', label: 'GPT-4o mini', detail: 'Fast & cheap' },
			{ id: 'o3-mini', label: 'o3-mini', detail: 'Reasoning' }
		]
	},
	openrouter: {
		id: 'openrouter', kind: 'openai', label: 'OpenRouter', baseURL: 'https://openrouter.ai/api/v1', keyId: 'openrouter',
		caps: { tools: true, vision: true }, headers: { 'HTTP-Referer': 'https://levelcode.ai', 'X-Title': 'LevelCode' },
		models: [
			{ id: 'moonshotai/kimi-k2.7-code', label: 'Kimi K2.7 Code', detail: 'Moonshot · coding, 262K · via OpenRouter' },
			{ id: 'anthropic/claude-opus-5', label: 'Claude Opus 5', detail: 'Anthropic · frontier, 1M · via OpenRouter' },
			{ id: 'anthropic/claude-sonnet-4-6', label: 'Claude Sonnet 4.6', detail: 'via OpenRouter' },
			{ id: 'openai/gpt-4o', label: 'GPT-4o', detail: 'via OpenRouter' },
			{ id: 'google/gemini-2.0-flash-001', label: 'Gemini 2.0 Flash', detail: 'via OpenRouter' },
			{ id: 'meta-llama/llama-3.3-70b-instruct', label: 'Llama 3.3 70B', detail: 'via OpenRouter' },
			{ id: 'deepseek/deepseek-chat', label: 'DeepSeek V3', detail: 'via OpenRouter' }
		]
	},
	groq: {
		id: 'groq', kind: 'openai', label: 'Groq', baseURL: 'https://api.groq.com/openai/v1', keyId: 'groq',
		caps: { tools: true },
		models: [
			{ id: 'llama-3.3-70b-versatile', label: 'Llama 3.3 70B' },
			{ id: 'llama-3.1-8b-instant', label: 'Llama 3.1 8B', detail: 'Instant' }
		]
	},
	together: {
		id: 'together', kind: 'openai', label: 'Together', baseURL: 'https://api.together.xyz/v1', keyId: 'together',
		caps: { tools: true },
		models: [{ id: 'meta-llama/Llama-3.3-70B-Instruct-Turbo', label: 'Llama 3.3 70B Turbo' }]
	},
	fireworks: {
		id: 'fireworks', kind: 'openai', label: 'Fireworks', baseURL: 'https://api.fireworks.ai/inference/v1', keyId: 'fireworks',
		caps: { tools: true },
		models: [{ id: 'accounts/fireworks/models/llama-v3p3-70b-instruct', label: 'Llama 3.3 70B' }]
	},
	deepseek: {
		id: 'deepseek', kind: 'openai', label: 'DeepSeek', baseURL: 'https://api.deepseek.com/v1', keyId: 'deepseek',
		caps: { tools: true },
		// Both are offered for CHAT; the catalog marks deepseek-reasoner tools:false so the per-model agent
		// gate (catalog.supportsToolsForModel) blocks it from the tool loop (its loop needs reasoning_content
		// round-tripping the boundary doesn't carry) while deepseek-chat remains the agent's DeepSeek target.
		models: [
			{ id: 'deepseek-chat', label: 'DeepSeek V3', detail: 'Chat' },
			{ id: 'deepseek-reasoner', label: 'DeepSeek R1', detail: 'Reasoner (chat only)' }
		]
	},
	xai: {
		id: 'xai', kind: 'openai', label: 'xAI (Grok)', baseURL: 'https://api.x.ai/v1', keyId: 'xai',
		caps: { tools: true, vision: true },
		models: [{ id: 'grok-2-latest', label: 'Grok 2' }]
	},
	mistral: {
		id: 'mistral', kind: 'openai', label: 'Mistral', baseURL: 'https://api.mistral.ai/v1', keyId: 'mistral',
		caps: { tools: true },
		models: [
			{ id: 'mistral-large-latest', label: 'Mistral Large' },
			{ id: 'codestral-latest', label: 'Codestral', detail: 'Code' }
		]
	},
	ollama: {
		id: 'ollama', kind: 'openai', label: 'Ollama (local)', baseURL: 'http://localhost:11434/v1', noKey: true,
		caps: { tools: false }, models: []
	},
	custom: {
		id: 'custom', kind: 'openai', label: 'OpenAI-compatible (custom)', baseURL: null /* user-supplied */, keyId: 'custom',
		caps: { tools: true }, models: []
	}
};

/** Accept the doc/registry synonym `anthropic` for the settings value `claude`. */
const ALIASES = { anthropic: 'claude' };
function normId(id) { return ALIASES[id] || id || 'claude'; }

/** @returns {any|null} the registry row for a provider id (or null if unknown). */
function getProvider(id) { return PROVIDERS[normId(id)] || null; }

/** @returns {any[]} all rows, in registry order. */
function listProviders() { return Object.keys(PROVIDERS).map((k) => PROVIDERS[k]); }

/**
 * True if attaching a Bearer key to this URL would leak it over plaintext to a non-local host.
 * Used to gate the user-supplied `custom` provider base URL. https anywhere is fine; http is only
 * allowed to localhost/loopback. Pure — unit-tested.
 */
function isInsecureCustomUrl(url) {
	const u = String(url || '');
	if (/^https:\/\//i.test(u)) { return false; }
	if (/^http:\/\/(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)([:/]|$)/i.test(u)) { return false; }
	return true;
}

/**
 * SecretStorage key for a provider. Anthropic keeps its LEGACY location so existing users don't
 * lose their key; every other provider is namespaced under levelcode.ai.key.<keyId>. `noKey` → null.
 * Pure — unit-tested.
 */
function secretStorageKey(id) {
	const p = getProvider(id);
	if (!p || p.noKey) { return null; }
	if (p.kind === 'anthropic') { return 'levelcode.ai.anthropicKey'; }   // legacy — do not change
	return 'levelcode.ai.key.' + p.keyId;
}

/**
 * Unified streaming chat across providers. `messages` is the shared {role,content:string} shape
 * (valid for both Anthropic and OpenAI). Anthropic → native adapter; everything else → openaiCompat.
 * @param {{providerId:string, apiKey?:string, baseURL?:string, model:string, maxTokens?:number,
 *          system:string, messages:any[], signal?:AbortSignal, onDelta:(t:string)=>void}} o
 */
async function streamChat(o) {
	const p = getProvider(o.providerId);
	if (!p) { throw new Error('Unknown AI provider: ' + o.providerId); }
	if (p.kind === 'anthropic') {
		return anthropic.streamClaude({
			apiKey: o.apiKey, model: o.model, maxTokens: o.maxTokens, system: o.system,
			messages: o.messages, signal: o.signal, onDelta: o.onDelta
		});
	}
	return openai.streamOpenAI({
		baseURL: o.baseURL || p.baseURL, apiKey: o.apiKey, headers: p.headers, label: p.label,
		model: o.model, maxTokens: o.maxTokens, system: o.system, messages: o.messages,
		signal: o.signal, onDelta: o.onDelta
	});
}

/**
 * Unified one-shot completion across providers (inline ghost-text / edit). Returns full text.
 * @param {{providerId:string, apiKey?:string, baseURL?:string, model:string, maxTokens?:number,
 *          system:string, messages:any[], stop?:string[], signal?:AbortSignal}} o
 * @returns {Promise<string>}
 */
async function complete(o) {
	const p = getProvider(o.providerId);
	if (!p) { throw new Error('Unknown AI provider: ' + o.providerId); }
	if (p.kind === 'anthropic') {
		return anthropic.completeClaude({
			apiKey: o.apiKey, model: o.model, maxTokens: o.maxTokens, system: o.system,
			messages: o.messages, stop: o.stop, signal: o.signal
		});
	}
	return openai.completeOpenAI({
		baseURL: o.baseURL || p.baseURL, apiKey: o.apiKey, headers: p.headers, label: p.label,
		model: o.model, maxTokens: o.maxTokens, system: o.system, messages: o.messages,
		stop: o.stop, signal: o.signal
	});
}

/** Whether the agent (tool-use loop) can run on this provider. Coarse per-provider gate for P2;
 *  a specific model that lacks native tools will surface an API error, which the agent reports. */
function supportsTools(id) {
	const p = getProvider(id);
	return !!(p && p.caps && p.caps.tools);
}

/**
 * Unified streaming tool-using agent turn. Anthropic → native (Anthropic-block-shaped, zero
 * translation); every other provider → the OpenAI adapter, which translates the Anthropic-shaped
 * transcript/tools in and the streamed tool-calls back out. Returns the SAME
 * {content, stop_reason, usage, malformed} shape for both, so agent.js is provider-agnostic.
 * @param {{providerId:string, apiKey?:string, baseURL?:string, model:string, maxTokens?:number,
 *          system:string, messages:any[], tools?:any[], signal?:AbortSignal,
 *          onText?:(t:string)=>void, onToolStart?:(name:string)=>void}} o
 */
async function streamAgentTurn(o) {
	const p = getProvider(o.providerId);
	if (!p) { throw new Error('Unknown AI provider: ' + o.providerId); }
	if (p.kind === 'anthropic') {
		return anthropic.streamClaudeAgentTurn({
			apiKey: o.apiKey, model: o.model, maxTokens: o.maxTokens, system: o.system,
			messages: o.messages, tools: o.tools, signal: o.signal, onText: o.onText, onToolStart: o.onToolStart
		});
	}
	return openai.streamOpenAIAgentTurn({
		baseURL: o.baseURL || p.baseURL, apiKey: o.apiKey, headers: p.headers, label: p.label,
		model: o.model, maxTokens: o.maxTokens, system: o.system, messages: o.messages, tools: o.tools,
		signal: o.signal, onText: o.onText, onToolStart: o.onToolStart
	});
}

/** Best-effort list of locally available Ollama models via /api/tags. Returns [] if unreachable. */
async function listOllamaModels(url) {
	try {
		const base = String(url || 'http://localhost:11434').replace(/\/+$/, '');
		const ac = new AbortController();
		const t = setTimeout(() => ac.abort(), 5000);   // don't hang if the host accepts but never answers
		let res;
		try { res = await fetch(base + '/api/tags', { signal: ac.signal }); }
		finally { clearTimeout(t); }
		if (!res.ok) { return []; }
		const data = await res.json();
		return Array.isArray(data.models) ? data.models.map((m) => m.name).filter(Boolean) : [];
	} catch {
		return [];
	}
}

module.exports = {
	PROVIDERS, getProvider, listProviders, normId, secretStorageKey, isInsecureCustomUrl, supportsTools,
	streamChat, complete, streamAgentTurn, listOllamaModels,
	// re-export the native/low-level adapters for the back-compat shim + agent/lmProvider
	anthropic, openai
};
