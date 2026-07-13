/*---------------------------------------------------------------------------------------------
 *  LevelCode — AI · native Anthropic Messages adapter
 *
 *  The high-fidelity Claude path: prompt caching (cache_control) and full tool-use streaming,
 *  both of which the agent depends on. This is the default provider — the internal agent
 *  transcript already IS Anthropic-block-shaped, so it needs zero translation. Other providers
 *  go through providers/openaiCompat.js. Calls go DIRECTLY editor → Anthropic (BYO key).
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

const { readLines } = require('./sse');

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
function anthropicHeaders(apiKey) {
	return { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' };
}

/**
 * @param {{apiKey:string, model:string, maxTokens:number, system:string,
 *          messages:{role:string,content:string}[], signal?:AbortSignal,
 *          onDelta:(t:string)=>void}} opts
 */
async function streamClaude(opts) {
	const res = await fetch(ANTHROPIC_URL, {
		method: 'POST',
		headers: anthropicHeaders(opts.apiKey),
		body: JSON.stringify({
			model: opts.model,
			max_tokens: opts.maxTokens,
			system: opts.system,
			messages: opts.messages,
			stream: true
		}),
		signal: opts.signal
	});
	if (!res.ok || !res.body) {
		const text = await res.text().catch(() => '');
		throw new Error(`Anthropic API ${res.status}: ${text || res.statusText}`);
	}
	await readLines(res, (line) => {
		const s = line.trim();
		if (!s.startsWith('data:')) { return; }
		const data = s.slice(5).trim();
		if (!data || data === '[DONE]') { return; }
		let ev;
		try { ev = JSON.parse(data); } catch { return; }
		if (ev.type === 'content_block_delta' && ev.delta && ev.delta.type === 'text_delta') {
			opts.onDelta(ev.delta.text);
		} else if (ev.type === 'error') {
			throw new Error(ev.error && ev.error.message ? ev.error.message : 'Anthropic stream error');
		}
	});
}

/**
 * Non-streaming single completion from Claude. Returns the full text response.
 * Used for inline (ghost-text) completions where we need the whole insertion at once.
 * @param {{apiKey:string, model:string, maxTokens:number, system:string,
 *          messages:{role:string,content:string}[], stop?:string[], signal?:AbortSignal}} opts
 * @returns {Promise<string>}
 */
async function completeClaude(opts) {
	const body = {
		model: opts.model,
		max_tokens: opts.maxTokens,
		system: opts.system,
		messages: opts.messages
	};
	if (opts.stop && opts.stop.length) { body.stop_sequences = opts.stop; }
	const res = await fetch(ANTHROPIC_URL, {
		method: 'POST',
		headers: anthropicHeaders(opts.apiKey),
		body: JSON.stringify(body),
		signal: opts.signal
	});
	if (!res.ok) {
		const text = await res.text().catch(() => '');
		throw new Error(`Anthropic API ${res.status}: ${text || res.statusText}`);
	}
	const data = await res.json();
	const parts = Array.isArray(data.content) ? data.content : [];
	return parts.filter((p) => p && p.type === 'text').map((p) => p.text).join('');
}

/**
 * One turn of a tool-using Claude conversation. Returns the full parsed response
 * (content blocks + stop_reason) so the caller can run an agentic tool loop.
 * @param {{apiKey:string, model:string, maxTokens:number, system:string,
 *          messages:any[], tools?:any[], signal?:AbortSignal}} opts
 * @returns {Promise<any>}
 */
async function claudeAgentTurn(opts) {
	const body = {
		model: opts.model,
		max_tokens: opts.maxTokens,
		system: opts.system,
		messages: opts.messages
	};
	if (opts.tools && opts.tools.length) { body.tools = opts.tools; }
	const res = await fetch(ANTHROPIC_URL, {
		method: 'POST',
		headers: anthropicHeaders(opts.apiKey),
		body: JSON.stringify(body),
		signal: opts.signal
	});
	if (!res.ok) {
		const text = await res.text().catch(() => '');
		throw new Error(`Anthropic API ${res.status}: ${text || res.statusText}`);
	}
	return res.json();
}

/**
 * Turn the raw, mid-stream block accumulators into **API-clean** content blocks (only the fields the
 * Anthropic API accepts: type/id/name/input for tool_use, type/text for text — never internal markers
 * like `_json`, which 400 with "Extra inputs are not permitted"). A tool_use truncated by max_tokens
 * has unparseable partial JSON: it gets `input:{}` so the request stays valid, and its id is reported
 * in the returned `malformed` Set so the caller can answer it with a "retry smaller" error instead of
 * executing it. This is the single source of truth for input resolution + malformed detection.
 * @returns {{content:any[], malformed:Set<string>}}
 */
function finalizeAgentBlocks(blocks) {
	const malformed = new Set();
	const content = [];
	for (const blk of (blocks || [])) {
		if (!blk) { continue; }
		if (blk.type === 'tool_use') {
			let input = blk.input;
			if (input == null) {
				if (blk._json) {
					try {
						const parsed = JSON.parse(blk._json);
						if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) { input = parsed; }
						else { input = {}; malformed.add(blk.id); }   // valid JSON but not a tool-input object
					} catch { input = {}; malformed.add(blk.id); }    // truncated / corrupt partial JSON
				} else { input = {}; }                                // genuinely no args (not "cut off")
			}
			content.push({ type: 'tool_use', id: blk.id, name: blk.name, input: input });
		} else if (blk.type === 'text') {
			content.push({ type: 'text', text: blk.text || '' });
		} else {
			// Unknown block type: pass through only non-internal fields (never `_`-prefixed markers).
			const out = {};
			for (const k of Object.keys(blk)) { if (k[0] !== '_') { out[k] = blk[k]; } }
			content.push(out);
		}
	}
	return { content, malformed };
}

/**
 * Streaming tool-using turn. Streams assistant text via onText, assembles tool_use blocks,
 * and returns the full content + stop_reason for the agent loop.
 * @param {{apiKey:string, model:string, maxTokens:number, system:string,
 *          messages:any[], tools?:any[], signal?:AbortSignal, onText:(t:string)=>void,
 *          onToolStart?:(name:string)=>void}} opts
 * @returns {Promise<{content:any[], stop_reason:string}>}
 */
/**
 * [LevelCode] Return a shallow copy of the transcript with a cache_control breakpoint on the LAST
 * message's last content block. Combined with the cached system block below, this caches the whole
 * growing transcript: turn N writes it, turn N+1 reads it (cached input bills ~0.1x). Anthropic allows
 * 4 breakpoints; we use 2 (system + this). Messages with empty content are skipped.
 */
function withRollingCacheBreakpoint(messages) {
	const arr = Array.isArray(messages) ? messages.slice() : [];
	for (let i = arr.length - 1; i >= 0; i--) {
		const m = arr[i];
		if (!m) { continue; }
		let content = m.content;
		if (typeof content === 'string') {
			if (!content) { continue; }
			content = [{ type: 'text', text: content, cache_control: { type: 'ephemeral' } }];
		} else if (Array.isArray(content) && content.length) {
			content = content.slice();
			content[content.length - 1] = { ...content[content.length - 1], cache_control: { type: 'ephemeral' } };
		} else {
			continue;
		}
		arr[i] = { ...m, content };
		break;
	}
	return arr;
}

async function streamClaudeAgentTurn(opts) {
	// [LevelCode] Prompt caching — the real token/$ saver. tools + system are byte-identical every turn
	// and the transcript only grows, so cache them: a breakpoint on the system block caches tools+system;
	// a rolling breakpoint on the last message caches the prior transcript. Cached input bills ~0.1x vs
	// full price. Without this an agent loop re-pays FULL input for the entire prefix on every turn.
	const system = [{ type: 'text', text: String(opts.system || ''), cache_control: { type: 'ephemeral' } }];
	const messages = withRollingCacheBreakpoint(opts.messages);
	const body = { model: opts.model, max_tokens: opts.maxTokens, system, messages, stream: true };
	if (opts.tools && opts.tools.length) { body.tools = opts.tools; }
	const res = await fetch(ANTHROPIC_URL, {
		method: 'POST',
		headers: anthropicHeaders(opts.apiKey),
		body: JSON.stringify(body),
		signal: opts.signal
	});
	if (!res.ok || !res.body) {
		const text = await res.text().catch(() => '');
		throw new Error(`Anthropic API ${res.status}: ${text || res.statusText}`);
	}
	/** @type {any[]} */
	const blocks = [];
	let stopReason = 'end_turn';
	const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
	await readLines(res, (line) => {
		const s = line.trim();
		if (!s.startsWith('data:')) { return; }
		const data = s.slice(5).trim();
		if (!data || data === '[DONE]') { return; }
		let ev;
		try { ev = JSON.parse(data); } catch { return; }
		if (ev.type === 'message_start') {
			const u = (ev.message && ev.message.usage) || {};
			usage.input_tokens = u.input_tokens || 0;
			usage.cache_read_input_tokens = u.cache_read_input_tokens || 0;
			usage.cache_creation_input_tokens = u.cache_creation_input_tokens || 0;
		} else if (ev.type === 'content_block_start') {
			const b = ev.content_block || {};
			if (b.type === 'tool_use') {
				blocks[ev.index] = { type: 'tool_use', id: b.id, name: b.name, _json: '' };
				if (opts.onToolStart) { opts.onToolStart(b.name); }
			} else {
				blocks[ev.index] = { type: 'text', text: '' };
			}
		} else if (ev.type === 'content_block_delta') {
			const blk = blocks[ev.index];
			if (!blk) { return; }
			if (ev.delta.type === 'text_delta') { blk.text += ev.delta.text; opts.onText(ev.delta.text); }
			else if (ev.delta.type === 'input_json_delta') { blk._json += ev.delta.partial_json || ''; }
		} else if (ev.type === 'message_delta') {
			if (ev.delta && ev.delta.stop_reason) { stopReason = ev.delta.stop_reason; }
			if (ev.usage && ev.usage.output_tokens) { usage.output_tokens = ev.usage.output_tokens; }
		} else if (ev.type === 'error') {
			throw new Error(ev.error && ev.error.message ? ev.error.message : 'Anthropic stream error');
		}
	});
	// Build API-clean content + the malformed-id set in one pass (the only place input is resolved).
	const { content, malformed } = finalizeAgentBlocks(blocks);
	return { content: content, stop_reason: stopReason, usage: usage, malformed: malformed };
}

module.exports = { streamClaude, completeClaude, claudeAgentTurn, streamClaudeAgentTurn, finalizeAgentBlocks };
