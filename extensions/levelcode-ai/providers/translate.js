/*---------------------------------------------------------------------------------------------
 *  LevelCode — AI · tool-use translation (Anthropic ↔ OpenAI)  [P2]
 *
 *  The agent keeps ONE internal transcript, and it is Anthropic-block-shaped (assistant messages
 *  carry {type:'text'} / {type:'tool_use', id, name, input} blocks; tool results come back as a user
 *  message of {type:'tool_result', tool_use_id, content} blocks). agent.js, finalizeAgentBlocks and
 *  repairAgentMemory all depend on that shape and its id-pairing. To run the agent on OpenAI-shaped
 *  providers we translate ONLY at the adapter boundary — here — and never touch agent.js's transcript.
 *
 *  Everything in this file is PURE and unit-tested (test/translate.test.js). The fetch/SSE loop that
 *  drives it lives in openaiCompat.streamOpenAIAgentTurn.
 *
 *  The mapping (see docs/levelcode-multiprovider-design.md §3.1):
 *    tool defs      {name,description,input_schema}        → {type:'function',function:{name,description,parameters}}
 *    assistant call {type:'tool_use',id,name,input} block  → message.tool_calls:[{id,type:'function',function:{name,arguments:JSON}}]
 *    tool result    user{tool_result,tool_use_id,content}  → a separate {role:'tool',tool_call_id,content} message
 *    text+tools     assistant content:[{text},{tool_use}]  → {role:'assistant',content:text||null,tool_calls:[…]}
 *    stop_reason    end_turn/tool_use/max_tokens           ← finish_reason stop/tool_calls/length (normalized back)
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

/** Anthropic tool defs → OpenAI function tools (field rename: input_schema → parameters). */
function toOpenAITools(tools) {
	if (!Array.isArray(tools) || !tools.length) { return undefined; }
	return tools.map((t) => ({
		type: 'function',
		function: {
			name: t.name,
			description: t.description || '',
			parameters: t.input_schema || { type: 'object', properties: {} }
		}
	}));
}

/**
 * Anthropic image block → OpenAI `image_url` part.
 *
 * Anthropic carries the bytes in `source` (base64 + media_type, or a url); OpenAI-compatible APIs take
 * one `url` field that is either a real URL or a `data:` URI. Everything else about the block is ours.
 */
function toOpenAIImagePart(b) {
	const src = b && b.source;
	if (!src) { throw new Error('translate: image block has no source'); }
	if (src.type === 'url') {
		if (!src.url) { throw new Error('translate: image block has a url source with no url'); }
		return { type: 'image_url', image_url: { url: src.url } };
	}
	if (src.type === 'base64') {
		if (!src.media_type || !src.data) {
			throw new Error('translate: image block is missing media_type or data');
		}
		return { type: 'image_url', image_url: { url: 'data:' + src.media_type + ';base64,' + src.data } };
	}
	// `file` (Files API) is Anthropic-only — there is no OpenAI equivalent to translate it to, so
	// refuse rather than send a request whose subject is missing.
	throw new Error('translate: image source type not supported on this provider: ' + String(src.type));
}

/** Coerce a tool_result's content (string | array of blocks | other) to a plain string for OpenAI. */
function toolResultText(content) {
	if (typeof content === 'string') { return content; }
	if (Array.isArray(content)) {
		return content.map((b) => {
			if (typeof b === 'string') { return b; }
			if (b && b.type === 'text') { return b.text || ''; }
			if (b && b.type === 'tool_result') { return toolResultText(b.content); }
			return (b && typeof b.text === 'string') ? b.text : '';
		}).join('\n');
	}
	if (content == null) { return ''; }
	try { return JSON.stringify(content); } catch { return String(content); }
}

/**
 * Anthropic-shaped transcript (system string + messages[]) → OpenAI chat messages[].
 * Splits a user message that carries tool_result blocks into one {role:'tool'} message per result
 * (OpenAI requires the tool responses to immediately follow the assistant's tool_calls), then a
 * trailing {role:'user'} for any plain text in the same message.
 */
function toOpenAIMessages(system, messages, opts) {
	// [LevelCode] opts.cache adds Anthropic-style cache_control breakpoints (system + last message). Only
	// set for Anthropic-family upstreams (see openaiCompat.isAnthropicFamily) — OpenRouter/the gateway
	// forward it to Claude; other providers auto-cache and would ignore or reject it.
	const cache = !!(opts && opts.cache);
	const out = [];
	if (system) {
		out.push(cache
			? { role: 'system', content: [{ type: 'text', text: String(system), cache_control: { type: 'ephemeral' } }] }
			: { role: 'system', content: system });
	}
	for (const m of (messages || [])) {
		if (!m) { continue; }
		if (m.role === 'assistant') {
			if (typeof m.content === 'string') { out.push({ role: 'assistant', content: m.content }); continue; }
			const blocks = Array.isArray(m.content) ? m.content : [];
			let text = '';
			const toolCalls = [];
			for (const b of blocks) {
				if (!b) { continue; }
				if (b.type === 'text') { text += b.text || ''; }
				else if (b.type === 'tool_use') {
					toolCalls.push({
						id: b.id,
						type: 'function',
						function: { name: b.name, arguments: JSON.stringify(b.input == null ? {} : b.input) }
					});
				}
			}
			const msg = { role: 'assistant', content: text ? text : null };
			if (toolCalls.length) { msg.tool_calls = toolCalls; }
			out.push(msg);
			continue;
		}
		// user (or any non-assistant) message
		if (typeof m.content === 'string') { out.push({ role: 'user', content: m.content }); continue; }
		const blocks = Array.isArray(m.content) ? m.content : [];
		let trailingText = '';
		const images = [];
		for (const b of blocks) {
			if (!b) { continue; }
			if (b.type === 'tool_result') {
				out.push({ role: 'tool', tool_call_id: b.tool_use_id, content: toolResultText(b.content) });
			} else if (b.type === 'text') {
				trailingText += (trailingText ? '\n' : '') + (b.text || '');
			} else if (b.type === 'image') {
				images.push(toOpenAIImagePart(b));
			} else {
				// Loudly, not silently. This loop used to fall through on anything it did not
				// recognise, so a block type it had never seen vanished between the composer and
				// the wire with no error and no log line — the model would then answer confidently
				// about content it was never sent. A type we do not understand is a bug in us.
				throw new Error('translate: unsupported content block in a user message: ' + String(b.type));
			}
		}
		// Images first: the model reads them best before the text that asks about them, and it keeps
		// markLastOpenAICacheable's breakpoint on a text block rather than on an image.
		if (images.length) {
			const content = images.slice();
			if (trailingText) { content.push({ type: 'text', text: trailingText }); }
			out.push({ role: 'user', content });
		} else if (trailingText) {
			// No image — keep the plain string. Widening every text-only turn to a block array would
			// change the bytes of every cached prefix for no gain.
			out.push({ role: 'user', content: trailingText });
		}
	}
	if (cache) { markLastOpenAICacheable(out); }
	return out;
}

/**
 * [LevelCode] Put a cache_control breakpoint on the last cacheable message so the transcript prefix is
 * cached on the next turn. Converts string content to a single text block; skips assistant messages that
 * carry only tool_calls (content:null). Mutates `out` (freshly built here, so safe).
 */
function markLastOpenAICacheable(out) {
	for (let i = out.length - 1; i >= 0; i--) {
		const m = out[i];
		if (!m) { continue; }
		if (typeof m.content === 'string' && m.content) {
			m.content = [{ type: 'text', text: m.content, cache_control: { type: 'ephemeral' } }];
			return;
		}
		if (Array.isArray(m.content) && m.content.length) {
			const last = m.content.length - 1;
			m.content[last] = { ...m.content[last], cache_control: { type: 'ephemeral' } };
			return;
		}
		// content:null (assistant tool_calls-only) → fall through to the previous message
	}
}

/** OpenAI finish_reason → Anthropic stop_reason. */
function fromOpenAIFinishReason(reason) {
	if (reason === 'tool_calls' || reason === 'function_call') { return 'tool_use'; }
	if (reason === 'length') { return 'max_tokens'; }
	if (reason === 'content_filter') { return 'stop_sequence'; }
	return 'end_turn';
}

/**
 * Fold one streamed delta.tool_calls[] fragment array into an accumulator keyed by tool-call index.
 * OpenAI sends id + function.name only on the FIRST fragment per index, then incremental
 * function.arguments string fragments. `acc` is a sparse array indexed by tool-call index.
 * onNew(name) fires the first time an index gains a name (drives onToolStart). Mutates + returns acc.
 */
function accumulateToolCalls(acc, deltaToolCalls, onNew) {
	for (const tc of (deltaToolCalls || [])) {
		if (!tc) { continue; }
		const i = (tc.index != null) ? tc.index : acc.length;
		let slot = acc[i];
		if (!slot) { slot = acc[i] = { id: tc.id || '', name: '', args: '' }; }
		if (tc.id && !slot.id) { slot.id = tc.id; }
		const fn = tc.function || {};
		if (fn.name && !slot.name) { slot.name = fn.name; if (onNew) { onNew(fn.name); } }
		if (typeof fn.arguments === 'string') { slot.args += fn.arguments; }
	}
	return acc;
}

/**
 * Turn accumulated assistant text + the tool-call accumulator into canonical Anthropic-shaped content
 * blocks + a `malformed` id Set — mirroring anthropic.finalizeAgentBlocks so agent.js is fully
 * provider-agnostic. Truncated/invalid tool arguments → input:{} and the id is added to `malformed`
 * (the caller answers it with a "retry smaller" error instead of executing it). Empty args (a tool
 * with no inputs) → input:{} and is NOT malformed.
 * @returns {{content:any[], malformed:Set<string>}}
 */
function finalizeOpenAIBlocks(text, acc) {
	const malformed = new Set();
	const content = [];
	if (text) { content.push({ type: 'text', text: text }); }
	let n = 0;
	for (const slot of (acc || [])) {
		if (!slot) { continue; }
		// A tool call whose name never arrived (mid-stream truncation before the first fragment's name)
		// is unusable AND would re-serialize as an illegal function.name:'' on the next request. Skip it —
		// pairing stays valid because there's no tool_call to answer.
		if (!slot.name) { continue; }
		// Synthetic fallback id when a provider omits one: keep it Mistral-legal ([a-zA-Z0-9]{9}).
		const id = slot.id || ('call' + String(n).padStart(5, '0'));
		n++;
		let input;
		const raw = slot.args != null ? String(slot.args).trim() : '';
		if (!raw) {
			input = {};                                            // genuinely no args
		} else {
			try {
				const parsed = JSON.parse(raw);
				if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) { input = parsed; }
				else { input = {}; malformed.add(id); }            // valid JSON but not an args object
			} catch { input = {}; malformed.add(id); }             // truncated / corrupt partial JSON
		}
		content.push({ type: 'tool_use', id: id, name: slot.name || '', input: input });
	}
	return { content, malformed };
}

module.exports = {
	toOpenAITools, toOpenAIMessages, fromOpenAIFinishReason,
	accumulateToolCalls, finalizeOpenAIBlocks, toolResultText
};
