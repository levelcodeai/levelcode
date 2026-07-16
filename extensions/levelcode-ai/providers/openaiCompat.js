/*---------------------------------------------------------------------------------------------
 *  LevelCode — AI · the universal OpenAI-compatible adapter
 *
 *  ONE fetch-based /v1/chat/completions streamer, parameterized by { baseURL, apiKey, headers }.
 *  This single file unlocks the long tail of providers — OpenAI, OpenRouter (one key → hundreds
 *  of models), Groq, Together, Fireworks, DeepSeek, xAI, Mistral, LM Studio, vLLM, and Ollama
 *  (via its /v1 endpoint) — because they all speak the same wire protocol. Adding a provider is
 *  a data row in providers/index.js, not new code here.
 *
 *  The body builder (buildChatBody) and stream-delta extractor (deltaFromEvent) are pure and
 *  unit-tested (test/providers.test.js); the fetch/SSE plumbing is the only IO.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

const { readLines } = require('./sse');
const translate = require('./translate');

/** Trim a trailing slash so `${base}/chat/completions` is always well-formed. */
function baseUrl(opts) { return String(opts.baseURL || '').replace(/\/+$/, ''); }

/**
 * [LevelCode] Is this an Anthropic/Claude model reached through an OpenAI-shaped endpoint (OpenRouter
 * `anthropic/claude-…`, the LevelCode Cloud gateway, or a bare `claude-…`)? Only these honor an explicit
 * cache_control breakpoint; every other provider auto-caches and would ignore or reject the field, so we
 * gate the prefix-caching write on this. Cache-hit READ accounting (cached_tokens) is done regardless.
 */
function isAnthropicFamily(model) { return /(?:^|\/)claude|(?:^|\/)anthropic\//i.test(String(model || '')); }

/** Auth + content-type + any per-provider headers (e.g. OpenRouter's HTTP-Referer / X-Title). */
function authHeaders(opts) {
	const h = Object.assign({ 'content-type': 'application/json' }, opts.headers || {});
	if (opts.apiKey) { h['authorization'] = 'Bearer ' + opts.apiKey; }
	return h;
}

/**
 * OpenAI's o-series reasoning models (o1/o3/o4, incl. via OpenRouter as `openai/o3-mini`) reject
 * `max_tokens` (need `max_completion_tokens`) and a non-default `temperature`. `gpt-4o` is NOT
 * matched (its trailing 'o' isn't a family prefix). Pure — unit-tested.
 */
function isReasoningModel(model) {
	return /(^|\/)o[1-9]/i.test(String(model || ''));
}

/**
 * Build the /v1/chat/completions request body. Pure — unit-testable.
 * OpenAI has no top-level `system` field, so a `system` string becomes a leading
 * {role:'system'} message (exactly what the old Ollama path did). The output-token cap is sent as
 * `max_completion_tokens` for reasoning models and `max_tokens` otherwise.
 * @param {{model:string, system?:string, messages:any[], maxTokens?:number,
 *          stream?:boolean, stop?:string[], temperature?:number}} opts
 */
function buildChatBody(opts) {
	const msgs = opts.system
		? [{ role: 'system', content: opts.system }].concat(opts.messages || [])
		: (opts.messages || []);
	/** @type {any} */
	const body = { model: opts.model, messages: msgs };
	const reasoning = isReasoningModel(opts.model);
	if (opts.maxTokens) { body[reasoning ? 'max_completion_tokens' : 'max_tokens'] = opts.maxTokens; }
	if (opts.stream) { body.stream = true; }
	if (opts.stop && opts.stop.length) { body.stop = opts.stop; }
	if (opts.temperature != null && !reasoning) { body.temperature = opts.temperature; }
	return body;
}

/**
 * Extract the streamed text delta from one parsed SSE event (OpenAI streaming shape:
 * choices[0].delta.content). Returns '' when there's no text in this chunk. Pure.
 */
function deltaFromEvent(ev) {
	const c = ev && ev.choices && ev.choices[0];
	if (!c) { return ''; }
	const d = c.delta || {};
	return typeof d.content === 'string' ? d.content : '';
}

/**
 * Streaming chat over /v1/chat/completions. opts.onDelta(text) per chunk; resolves at end.
 * @param {{baseURL:string, apiKey?:string, headers?:object, label?:string, model:string,
 *          maxTokens?:number, system?:string, messages:any[], stop?:string[],
 *          signal?:AbortSignal, onDelta:(t:string)=>void}} opts
 */
async function streamOpenAI(opts) {
	const label = opts.label || 'OpenAI-compatible';
	const res = await fetch(baseUrl(opts) + '/chat/completions', {
		method: 'POST',
		headers: authHeaders(opts),
		body: JSON.stringify(buildChatBody(Object.assign({}, opts, { stream: true }))),
		signal: opts.signal
	});
	if (!res.ok || !res.body) {
		const text = await res.text().catch(() => '');
		throw new Error(`${label} API ${res.status}: ${text || res.statusText}`);
	}
	await readLines(res, (line) => {
		const s = line.trim();
		if (!s.startsWith('data:')) { return; }
		const data = s.slice(5).trim();
		if (!data || data === '[DONE]') { return; }
		let ev;
		try { ev = JSON.parse(data); } catch { return; }
		if (ev.error) { const _e = new Error((ev.error && ev.error.message) ? ev.error.message : (label + ' stream error')); if (ev.error && ev.error.code) { _e.code = ev.error.code; } throw _e; }
		const t = deltaFromEvent(ev);
		if (t) { opts.onDelta(t); }
	});
}

/**
 * Non-streaming single completion (inline ghost-text / edit). Returns the full text.
 * @param {{baseURL:string, apiKey?:string, headers?:object, label?:string, model:string,
 *          maxTokens?:number, system?:string, messages:any[], stop?:string[], signal?:AbortSignal}} opts
 * @returns {Promise<string>}
 */
async function completeOpenAI(opts) {
	const label = opts.label || 'OpenAI-compatible';
	const res = await fetch(baseUrl(opts) + '/chat/completions', {
		method: 'POST',
		headers: authHeaders(opts),
		body: JSON.stringify(buildChatBody(Object.assign({}, opts, { stream: false }))),
		signal: opts.signal
	});
	if (!res.ok) {
		const text = await res.text().catch(() => '');
		throw new Error(`${label} API ${res.status}: ${text || res.statusText}`);
	}
	const data = await res.json();
	const c = data && data.choices && data.choices[0];
	return (c && c.message && typeof c.message.content === 'string') ? c.message.content : '';
}

/**
 * Best-effort GET /v1/models → array of model ids, for the picker. [] on any failure.
 * @param {{baseURL:string, apiKey?:string, headers?:object}} opts
 * @returns {Promise<string[]>}
 */
async function listOpenAIModels(opts) {
	try {
		const ac = new AbortController();
		const t = setTimeout(() => ac.abort(), 8000);   // don't let a wedged host hang the picker
		let res;
		try { res = await fetch(baseUrl(opts) + '/models', { headers: authHeaders(opts), signal: ac.signal }); }
		finally { clearTimeout(t); }
		if (!res.ok) { return []; }
		const data = await res.json();
		const arr = Array.isArray(data.data) ? data.data : (Array.isArray(data.models) ? data.models : []);
		return arr.map((m) => (typeof m === 'string' ? m : (m && (m.id || m.name)))).filter(Boolean);
	} catch { return []; }
}

/**
 * One streaming tool-using turn for OpenAI-shaped providers — the P2 agent path. Returns the SAME
 * canonical shape as anthropic.streamClaudeAgentTurn ({content, stop_reason, usage, malformed}) so
 * agent.js needs no changes. The Anthropic-shaped `system`/`messages`/`tools` are translated in,
 * the streamed OpenAI tool-call fragments are assembled by index, and the result is translated back
 * to {type:'text'} / {type:'tool_use', id, name, input} blocks.
 * @param {{baseURL:string, apiKey?:string, headers?:object, label?:string, model:string,
 *          maxTokens?:number, system:string, messages:any[], tools?:any[], signal?:AbortSignal,
 *          onText?:(t:string)=>void, onToolStart?:(name:string)=>void}} opts
 * @returns {Promise<{content:any[], stop_reason:string, usage:any, malformed:Set<string>}>}
 */
async function streamOpenAIAgentTurn(opts) {
	const label = opts.label || 'OpenAI-compatible';
	// [LevelCode] Prompt caching. Only Claude-family upstreams honor cache_control (via OpenRouter / the
	// LevelCode Cloud gateway); GPT/Gemini/DeepSeek/etc. auto-cache server-side and would ignore or reject
	// the field, so we gate it strictly on the model id. cached_tokens is still read for ALL providers below.
	const messages = translate.toOpenAIMessages(opts.system, opts.messages, { cache: isAnthropicFamily(opts.model) });
	const tools = translate.toOpenAITools(opts.tools);
	const body = buildChatBody({ model: opts.model, messages, maxTokens: opts.maxTokens, stream: true });
	if (tools) { body.tools = tools; }
	// Ask for a final usage chunk (choices:[] + usage) so the agent's context meter isn't stuck at 0
	// on OpenAI-shaped providers — they omit usage from streams unless include_usage is set. Mainstream
	// providers (OpenAI/OpenRouter/Groq/Together/Fireworks/DeepSeek/xAI/Mistral) honor it.
	body.stream_options = { include_usage: true };
	const res = await fetch(baseUrl(opts) + '/chat/completions', {
		method: 'POST',
		headers: authHeaders(opts),
		body: JSON.stringify(body),
		signal: opts.signal
	});
	if (!res.ok || !res.body) {
		const text = await res.text().catch(() => '');
		throw new Error(`${label} API ${res.status}: ${text || res.statusText}`);
	}
	let text = '';
	/** @type {any[]} */
	const acc = [];
	let finish = null;
	const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
	await readLines(res, (line) => {
		const s = line.trim();
		if (!s.startsWith('data:')) { return; }
		const data = s.slice(5).trim();
		if (!data || data === '[DONE]') { return; }
		let ev;
		try { ev = JSON.parse(data); } catch { return; }
		if (ev.error) { const _e = new Error((ev.error && ev.error.message) ? ev.error.message : (label + ' stream error')); if (ev.error && ev.error.code) { _e.code = ev.error.code; } throw _e; }
		if (ev.usage) {   // opportunistic — only some providers include usage in the stream
			// [LevelCode] Surface prompt caching. OpenAI-shaped providers (OpenAI auto-cache, Claude/Gemini
			// via OpenRouter, the LevelCode Cloud gateway) report cache hits under prompt_tokens_details.
			// cached_tokens, and it is INCLUDED in prompt_tokens — so split it out (fresh = prompt - cached)
			// to mirror Anthropic's disjoint fields and keep the context meter's input+cache_read total exact.
			const det = ev.usage.prompt_tokens_details || {};
			const cached = det.cached_tokens || 0;
			if (ev.usage.prompt_tokens) { usage.input_tokens = Math.max(0, ev.usage.prompt_tokens - cached); }
			if (cached) { usage.cache_read_input_tokens = cached; }
			if (ev.usage.completion_tokens) { usage.output_tokens = ev.usage.completion_tokens; }
		}
		const c = ev.choices && ev.choices[0];
		if (!c) { return; }
		const d = c.delta || {};
		if (typeof d.content === 'string' && d.content) { text += d.content; if (opts.onText) { opts.onText(d.content); } }
		if (Array.isArray(d.tool_calls)) { translate.accumulateToolCalls(acc, d.tool_calls, opts.onToolStart); }
		if (c.finish_reason) { finish = c.finish_reason; }
	});
	const { content, malformed } = translate.finalizeOpenAIBlocks(text, acc);
	// If tool calls were assembled, the effective stop is tool_use even when a provider reports 'stop'.
	let stopReason = translate.fromOpenAIFinishReason(finish);
	if (stopReason !== 'max_tokens' && content.some((b) => b.type === 'tool_use')) { stopReason = 'tool_use'; }
	return { content, stop_reason: stopReason, usage, malformed };
}

module.exports = { streamOpenAI, completeOpenAI, listOpenAIModels, streamOpenAIAgentTurn, buildChatBody, deltaFromEvent, isReasoningModel, isAnthropicFamily };
