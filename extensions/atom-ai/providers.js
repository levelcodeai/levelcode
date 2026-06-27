/*---------------------------------------------------------------------------------------------
 *  Atom++ — AI
 *  Streaming chat providers. Calls go DIRECTLY from the editor to the provider — there is no
 *  Atom++ backend in between. Two providers:
 *    - Claude (Anthropic Messages API, bring-your-own key)
 *    - Ollama (local models, no key)
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

/**
 * Read a fetch Response body as UTF-8 lines, invoking onLine for each complete line.
 * Works with the Node (undici) fetch body used by the VS Code extension host.
 */
async function readLines(res, onLine) {
	let buf = '';
	for await (const chunk of res.body) {
		buf += Buffer.from(chunk).toString('utf8');
		let idx;
		while ((idx = buf.indexOf('\n')) >= 0) {
			const line = buf.slice(0, idx);
			buf = buf.slice(idx + 1);
			onLine(line);
		}
	}
	if (buf.length) { onLine(buf); }
}

/**
 * @param {{apiKey:string, model:string, maxTokens:number, system:string,
 *          messages:{role:string,content:string}[], signal?:AbortSignal,
 *          onDelta:(t:string)=>void}} opts
 */
async function streamClaude(opts) {
	const res = await fetch('https://api.anthropic.com/v1/messages', {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			'x-api-key': opts.apiKey,
			'anthropic-version': '2023-06-01'
		},
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
 * @param {{url:string, model:string, system:string,
 *          messages:{role:string,content:string}[], signal?:AbortSignal,
 *          onDelta:(t:string)=>void}} opts
 */
async function streamOllama(opts) {
	const base = opts.url.replace(/\/+$/, '');
	const msgs = opts.system ? [{ role: 'system', content: opts.system }, ...opts.messages] : opts.messages;
	const res = await fetch(base + '/api/chat', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ model: opts.model, messages: msgs, stream: true }),
		signal: opts.signal
	});
	if (!res.ok || !res.body) {
		const text = await res.text().catch(() => '');
		throw new Error(`Ollama ${res.status}: ${text || res.statusText} (is Ollama running at ${base}?)`);
	}
	await readLines(res, (line) => {
		const s = line.trim();
		if (!s) { return; }
		let ev;
		try { ev = JSON.parse(s); } catch { return; }
		if (ev.message && typeof ev.message.content === 'string') { opts.onDelta(ev.message.content); }
		if (ev.error) { throw new Error(String(ev.error)); }
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
	const res = await fetch('https://api.anthropic.com/v1/messages', {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			'x-api-key': opts.apiKey,
			'anthropic-version': '2023-06-01'
		},
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
 * Non-streaming single completion from Ollama (collects the streamed chat response).
 * @param {{url:string, model:string, system:string,
 *          messages:{role:string,content:string}[], signal?:AbortSignal}} opts
 * @returns {Promise<string>}
 */
async function completeOllama(opts) {
	let out = '';
	await streamOllama({ ...opts, onDelta: (t) => { out += t; } });
	return out;
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
	const res = await fetch('https://api.anthropic.com/v1/messages', {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			'x-api-key': opts.apiKey,
			'anthropic-version': '2023-06-01'
		},
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
 * Streaming tool-using turn. Streams assistant text via onText, assembles tool_use blocks,
 * and returns the full content + stop_reason for the agent loop.
 * @param {{apiKey:string, model:string, maxTokens:number, system:string,
 *          messages:any[], tools?:any[], signal?:AbortSignal, onText:(t:string)=>void}} opts
 * @returns {Promise<{content:any[], stop_reason:string}>}
 */
async function streamClaudeAgentTurn(opts) {
	const body = { model: opts.model, max_tokens: opts.maxTokens, system: opts.system, messages: opts.messages, stream: true };
	if (opts.tools && opts.tools.length) { body.tools = opts.tools; }
	const res = await fetch('https://api.anthropic.com/v1/messages', {
		method: 'POST',
		headers: { 'content-type': 'application/json', 'x-api-key': opts.apiKey, 'anthropic-version': '2023-06-01' },
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
	await readLines(res, (line) => {
		const s = line.trim();
		if (!s.startsWith('data:')) { return; }
		const data = s.slice(5).trim();
		if (!data || data === '[DONE]') { return; }
		let ev;
		try { ev = JSON.parse(data); } catch { return; }
		if (ev.type === 'content_block_start') {
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
		} else if (ev.type === 'content_block_stop') {
			const blk = blocks[ev.index];
			if (blk && blk.type === 'tool_use') { try { blk.input = blk._json ? JSON.parse(blk._json) : {}; } catch { blk.input = {}; } delete blk._json; }
		} else if (ev.type === 'message_delta') {
			if (ev.delta && ev.delta.stop_reason) { stopReason = ev.delta.stop_reason; }
		} else if (ev.type === 'error') {
			throw new Error(ev.error && ev.error.message ? ev.error.message : 'Anthropic stream error');
		}
	});
	return { content: blocks.filter(Boolean), stop_reason: stopReason };
}

/** Best-effort list of locally available Ollama models. Returns [] if unreachable. */
async function listOllamaModels(url) {
	try {
		const base = url.replace(/\/+$/, '');
		const res = await fetch(base + '/api/tags');
		if (!res.ok) { return []; }
		const data = await res.json();
		return Array.isArray(data.models) ? data.models.map((m) => m.name).filter(Boolean) : [];
	} catch {
		return [];
	}
}

module.exports = { streamClaude, streamOllama, completeClaude, completeOllama, claudeAgentTurn, streamClaudeAgentTurn, listOllamaModels };
