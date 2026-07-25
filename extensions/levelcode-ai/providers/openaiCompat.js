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

// Fallback reason phrases for when fetch leaves res.statusText empty (some HTTP/2 responses do). Not
// exhaustive — just what a model endpoint or the proxy in front of it realistically returns.
const STATUS_REASON = {
	400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found',
	408: 'Request Timeout', 413: 'Payload Too Large', 429: 'Too Many Requests',
	500: 'Internal Server Error', 502: 'Bad Gateway', 503: 'Service Unavailable', 504: 'Gateway Timeout'
};

/**
 * Pull a human-readable message out of an error response body, or '' when there isn't one worth showing.
 * The body is UNTRUSTED and provider-shaped: a JSON `{error:{message}}` on a normal API rejection, but a
 * raw HTML page when a proxy IN FRONT of the model (nginx/Cloudflare) returns a 5xx — dumping that page
 * into a chat transcript is pure noise. Return '' for HTML so the caller falls back to the status reason;
 * cap anything else so a stray multi-KB body can't flood the UI. Pure — unit-tested.
 */
function extractApiError(body) {
	const s = String(body || '').trim();
	if (!s) { return ''; }
	if (s[0] === '<' || /<html[\s>]/i.test(s)) { return ''; }              // HTML proxy page — no useful message
	if (s[0] === '{' || s[0] === '[') {
		try {
			const j = JSON.parse(s);
			const m = (j && j.error && (j.error.message || (typeof j.error === 'string' ? j.error : ''))) || (j && j.message) || '';
			if (m) { return String(m).slice(0, 500); }
		} catch { /* not valid JSON after all — fall through to the capped-text path */ }
	}
	return s.length > 300 ? s.slice(0, 300) + '…' : s;     // short plain text: keep it, capped
}

/**
 * Build a clean Error for a failed (`!res.ok`) response: `"<label> API <status>: <detail>"`, where detail
 * is the provider's own message when it gave one, else the HTTP status reason — never a dumped HTML page.
 * `label` names the ROUTE (e.g. "LevelCode Cloud", "OpenRouter"), so the failure is attributed correctly
 * rather than blamed on whichever adapter happens to carry it. Sets `.status` for retry/refresh logic.
 */
function httpError(label, res, body) {
	const detail = extractApiError(body) || res.statusText || STATUS_REASON[res.status] || 'request failed';
	const e = new Error(`${label} API ${res.status}: ${detail}`);
	e.status = res.status;
	return e;
}

// Upstream statuses worth ONE automatic retry: a proxy in front of the model (nginx/Cloudflare/the gateway)
// briefly couldn't reach a healthy backend. These almost always clear within a second. Deliberately NOT
// retried: 429 (rate limit — needs Retry-After, and hammering makes it worse), 500 (usually a real request
// error, not a blip), and every other 4xx. A thrown fetch error (network drop, abort) is not retried either
// — only an HTTP response whose status is in this set.
const TRANSIENT_STATUS = new Set([502, 503, 504]);
const TRANSIENT_RETRIES = 1;      // one extra attempt after the first — a single pre-stream retry
const RETRY_DELAY_MS = 700;       // backoff before the retry (RETRY_DELAY_MS * attempt); overridable per call

/**
 * A backoff that wakes early the instant the turn is aborted, so Stop stays responsive. Resolves — never
 * rejects: the caller's next `fetch` sees the aborted signal and rejects with the native AbortError, which
 * is exactly how a normal aborted request already surfaces. Works with no signal too.
 */
function retryDelay(ms, signal) {
	return new Promise((resolve) => {
		if (signal && signal.aborted) { return resolve(); }
		const timer = setTimeout(done, ms);
		function done() { clearTimeout(timer); if (signal) { signal.removeEventListener('abort', done); } resolve(); }
		if (signal) { signal.addEventListener('abort', done, { once: true }); }
	});
}

/**
 * POST /chat/completions with a single pre-stream retry on a transient upstream status (502/503/504).
 *
 * This is the ONLY place a chat request is retried, and it is safe precisely because it runs BEFORE any SSE
 * line is read: on a transient status the response carries no model output, so nothing has been shown to the
 * user or metered, and re-issuing the request cannot duplicate output or double-bill the UI. A failure that
 * happens mid-stream is a different code path and is never retried here. A 401 is not transient, so it is
 * thrown straight through for the agent's token-refresh path. Non-transient statuses and an exhausted retry
 * throw a clean httpError. `opts.onRetry({attempt,retries,status})` fires just before each backoff (for a
 * visible "retrying…" hint); `opts.retryDelayMs` overrides the backoff (0 in tests). Returns res.ok===true.
 */
async function postChat(opts, body) {
	const label = opts.label || 'OpenAI-compatible';
	const base = opts.retryDelayMs != null ? opts.retryDelayMs : RETRY_DELAY_MS;
	const init = { method: 'POST', headers: authHeaders(opts), body: JSON.stringify(body), signal: opts.signal };
	const url = baseUrl(opts) + '/chat/completions';
	for (let attempt = 0; ; attempt++) {
		const res = await fetch(url, init);
		if (res.ok) { return res; }
		const text = await res.text().catch(() => '');
		if (attempt < TRANSIENT_RETRIES && TRANSIENT_STATUS.has(res.status)) {
			if (typeof opts.onRetry === 'function') { opts.onRetry({ attempt: attempt + 1, retries: TRANSIENT_RETRIES, status: res.status }); }
			await retryDelay(base * (attempt + 1), opts.signal);
			continue;
		}
		throw httpError(label, res, text);
	}
}

/**
 * Streaming chat over /v1/chat/completions. opts.onDelta(text) per chunk; resolves at end.
 * @param {{baseURL:string, apiKey?:string, headers?:object, label?:string, model:string,
 *          maxTokens?:number, system?:string, messages:any[], stop?:string[],
 *          signal?:AbortSignal, onDelta:(t:string)=>void,
 *          onRetry?:(info:{attempt:number,retries:number,status:number})=>void}} opts
 */
async function streamOpenAI(opts) {
	const label = opts.label || 'OpenAI-compatible';
	const res = await postChat(opts, buildChatBody(Object.assign({}, opts, { stream: true })));
	if (!res.body) { throw new Error(label + ' API ' + res.status + ': empty response stream'); }
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
 *          maxTokens?:number, system?:string, messages:any[], stop?:string[], signal?:AbortSignal,
 *          onRetry?:(info:{attempt:number,retries:number,status:number})=>void}} opts
 * @returns {Promise<string>}
 */
async function completeOpenAI(opts) {
	const res = await postChat(opts, buildChatBody(Object.assign({}, opts, { stream: false })));
	const data = await res.json();
	const c = data && data.choices && data.choices[0];
	return (c && c.message && typeof c.message.content === 'string') ? c.message.content : '';
}

/**
 * Best-effort GET /v1/models → array of model ids, for the picker. [] on any failure.
 * @param {{baseURL:string, apiKey?:string, headers?:object}} opts
 * @returns {Promise<string[]>}
 */
/**
 * [LevelCode] Split OpenAI-style cached_tokens out of prompt_tokens so the agent's meter
 * shows fresh input + cache_read exactly as Anthropic does. cached_tokens is included in
 * prompt_tokens, so input_tokens = prompt_tokens - cached_tokens. Pure — unit-tested.
 * @param {{input_tokens:number, output_tokens:number, cache_read_input_tokens:number}} usage
 * @param {{usage:{prompt_tokens?:number, completion_tokens?:number, prompt_tokens_details?:{cached_tokens?:number}}}} ev
 */
function splitOutCachedTokens(usage, ev) {
	const det = ev.usage.prompt_tokens_details || {};
	const cached = det.cached_tokens || 0;
	if (ev.usage.prompt_tokens != null) { usage.input_tokens = Math.max(0, ev.usage.prompt_tokens - cached); }
	if (cached) { usage.cache_read_input_tokens = cached; }
	if (ev.usage.completion_tokens != null) { usage.output_tokens = ev.usage.completion_tokens; }
}

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
 *          onText?:(t:string)=>void, onToolStart?:(name:string)=>void,
 *          onRetry?:(info:{attempt:number,retries:number,status:number})=>void}} opts
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
	const res = await postChat(opts, body);
	if (!res.body) { throw new Error(label + ' API ' + res.status + ': empty response stream'); }
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
			splitOutCachedTokens(usage, ev);
		}
		// [LevelCode] The Cloud gateway's final credits frame, emitted just before [DONE]: what THIS turn
		// cost and what's left, in retail micro-$ (the same basis as GET /account/models). Namespaced and
		// choice-less, so every other OpenAI-shaped provider simply never sends it and this stays inert.
		if (ev.levelcode) {
			if (ev.levelcode.cost_micros != null) { usage.cost_micros = ev.levelcode.cost_micros; }
			if (ev.levelcode.credits_remaining_micros != null) { usage.credits_remaining_micros = ev.levelcode.credits_remaining_micros; }
			return;
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

module.exports = { streamOpenAI, completeOpenAI, listOpenAIModels, streamOpenAIAgentTurn, buildChatBody, deltaFromEvent, isReasoningModel, isAnthropicFamily, splitOutCachedTokens, extractApiError, httpError, postChat };
