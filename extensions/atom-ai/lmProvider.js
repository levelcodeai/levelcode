/*---------------------------------------------------------------------------------------------
 *  Atom++ — AI: Claude as a native Language Model provider.
 *
 *  Registering a LanguageModelChatProvider makes Claude a first-class model inside the editor:
 *  VS Code's native chat, model picker, inline edits and agent flows can all use it. This is
 *  the foundation that lets the built-in chat-editing review (per-hunk Keep/Undo, overview)
 *  run on Claude. Calls go directly to Anthropic with the user's key — no middle-man.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

const vscode = require('vscode');
const { streamClaude } = require('./providers');

const VENDOR = 'atompp';

const MODELS = [
	{ id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', version: '4.6', maxOut: 8192 },
	{ id: 'claude-opus-4-8', name: 'Claude Opus 4.8', version: '4.8', maxOut: 8192 },
	{ id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5', version: '4.5', maxOut: 8192 }
];

/** Convert the editor's LM messages to Anthropic {role,content} pairs. */
function toAnthropic(messages) {
	const out = [];
	for (const msg of messages) {
		const role = msg.role === vscode.LanguageModelChatMessageRole.Assistant ? 'assistant' : 'user';
		let text = '';
		for (const part of msg.content || []) {
			if (part instanceof vscode.LanguageModelTextPart) { text += part.value; }
			else if (typeof part === 'string') { text += part; }
			else if (part && typeof part.value === 'string') { text += part.value; }
		}
		if (text) { out.push({ role, content: text }); }
	}
	// Anthropic requires the first message to be from the user.
	while (out.length && out[0].role !== 'user') { out.shift(); }
	return out;
}

/** @param {(silent:boolean)=>Promise<string|undefined>} getKey */
function makeProvider(getKey) {
	return {
		async provideLanguageModelChatInformation(options, _token) {
			const key = await getKey(!!options.silent);
			if (!key) { return []; }
			return MODELS.map((m) => ({
				id: m.id,
				name: m.name,
				family: 'claude',
				version: m.version,
				maxInputTokens: 200000,
				maxOutputTokens: m.maxOut,
				capabilities: { imageInput: false, toolCalling: false }
			}));
		},

		async provideLanguageModelChatResponse(model, messages, _options, progress, token) {
			const key = await getKey(true);
			if (!key) { throw new Error('Atom++ AI: no Anthropic API key set.'); }
			const ac = new AbortController();
			token.onCancellationRequested(() => ac.abort());
			await streamClaude({
				apiKey: key,
				model: model.id,
				maxTokens: model.maxOutputTokens || 8192,
				system: '',
				messages: toAnthropic(messages),
				signal: ac.signal,
				onDelta: (d) => progress.report(new vscode.LanguageModelTextPart(d))
			});
		},

		async provideTokenCount(_model, text, _token) {
			const s = typeof text === 'string' ? text : JSON.stringify(text || '');
			return Math.ceil(s.length / 4); // rough estimate
		}
	};
}

/** @param {vscode.ExtensionContext} context @param {(silent:boolean)=>Promise<string|undefined>} getKey */
function registerLmProvider(context, getKey) {
	if (!vscode.lm || typeof vscode.lm.registerLanguageModelChatProvider !== 'function') {
		console.warn('[atom-ai] lm.registerLanguageModelChatProvider unavailable in this build.');
		return;
	}
	try {
		context.subscriptions.push(vscode.lm.registerLanguageModelChatProvider(VENDOR, makeProvider(getKey)));
	} catch (e) {
		console.error('[atom-ai] LM provider registration failed:', e);
	}
}

module.exports = { registerLmProvider, VENDOR };
