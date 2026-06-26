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

module.exports = { streamClaude, streamOllama, listOllamaModels };
