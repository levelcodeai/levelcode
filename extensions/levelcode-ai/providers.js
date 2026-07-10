/*---------------------------------------------------------------------------------------------
 *  LevelCode — AI · back-compat shim
 *
 *  `providers` is now a DIRECTORY (providers/index.js registry + anthropic.js + openaiCompat.js).
 *  This file preserves the old flat `require('./providers')` surface so nothing broke mid-migration
 *  (agent.js and lmProvider.js still import from here). New code should require './providers/index'
 *  and use streamChat()/complete()/getProvider(). The legacy Ollama helpers now route through the
 *  universal OpenAI-compatible adapter against Ollama's /v1 endpoint.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

const index = require('./providers/index');
const anthropic = require('./providers/anthropic');
const openai = require('./providers/openaiCompat');

/** Legacy Ollama streaming — now an OpenAI-compatible call against http://host:port/v1. */
function streamOllama(opts) {
	const base = String(opts.url || 'http://localhost:11434').replace(/\/+$/, '') + '/v1';
	return openai.streamOpenAI({
		baseURL: base, label: 'Ollama', model: opts.model, system: opts.system,
		messages: opts.messages, signal: opts.signal, onDelta: opts.onDelta
	});
}
/** Legacy non-streaming Ollama completion. */
function completeOllama(opts) {
	const base = String(opts.url || 'http://localhost:11434').replace(/\/+$/, '') + '/v1';
	return openai.completeOpenAI({
		baseURL: base, label: 'Ollama', model: opts.model, system: opts.system,
		messages: opts.messages, signal: opts.signal
	});
}

module.exports = {
	// native Anthropic (unchanged behavior)
	streamClaude: anthropic.streamClaude,
	completeClaude: anthropic.completeClaude,
	claudeAgentTurn: anthropic.claudeAgentTurn,
	streamClaudeAgentTurn: anthropic.streamClaudeAgentTurn,
	finalizeAgentBlocks: anthropic.finalizeAgentBlocks,
	// legacy Ollama (now via the universal adapter)
	streamOllama, completeOllama,
	listOllamaModels: index.listOllamaModels,
	// the new facade, also reachable straight through the shim
	getProvider: index.getProvider,
	listProviders: index.listProviders,
	secretStorageKey: index.secretStorageKey,
	supportsTools: index.supportsTools,
	streamChat: index.streamChat,
	complete: index.complete,
	streamAgentTurn: index.streamAgentTurn,
	PROVIDERS: index.PROVIDERS
};
