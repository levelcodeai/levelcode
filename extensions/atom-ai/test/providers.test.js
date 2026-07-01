/*---------------------------------------------------------------------------------------------
 *  Unit tests for the multi-provider layer (pure parts only) — run: node test/providers.test.js
 *    - openaiCompat: buildChatBody (system→message, max_tokens/stream/stop) + deltaFromEvent
 *    - registry: getProvider/alias, secretStorageKey (legacy Anthropic vs namespaced), listProviders
 *  The fetch/SSE IO is not exercised here (that needs a live endpoint).
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

const assert = require('assert');
const oc = require('../providers/openaiCompat');
const reg = require('../providers/index');

let n = 0;
function test(name, fn) { fn(); n++; console.log('  ok - ' + name); }

// --- buildChatBody: system becomes a leading {role:'system'} message (OpenAI has no top-level system) ---
test('buildChatBody: prepends system as a message; carries model/messages', () => {
	const b = oc.buildChatBody({ model: 'gpt-4o', system: 'You are helpful.', messages: [{ role: 'user', content: 'hi' }] });
	assert.strictEqual(b.model, 'gpt-4o');
	assert.strictEqual(b.messages.length, 2);
	assert.deepStrictEqual(b.messages[0], { role: 'system', content: 'You are helpful.' });
	assert.deepStrictEqual(b.messages[1], { role: 'user', content: 'hi' });
});
test('buildChatBody: no system → messages passed through unchanged', () => {
	const msgs = [{ role: 'user', content: 'hi' }];
	const b = oc.buildChatBody({ model: 'm', messages: msgs });
	assert.strictEqual(b.messages.length, 1);
	assert.strictEqual(b.messages[0].content, 'hi');
	assert.ok(!('system' in b));
});
test('buildChatBody: max_tokens/stream/stop/temperature only included when set', () => {
	const bare = oc.buildChatBody({ model: 'm', messages: [] });
	assert.ok(!('max_tokens' in bare) && !('stream' in bare) && !('stop' in bare) && !('temperature' in bare));
	const full = oc.buildChatBody({ model: 'm', messages: [], maxTokens: 100, stream: true, stop: ['\n\n'], temperature: 0.2 });
	assert.strictEqual(full.max_tokens, 100);
	assert.strictEqual(full.stream, true);
	assert.deepStrictEqual(full.stop, ['\n\n']);
	assert.strictEqual(full.temperature, 0.2);
});

// --- reasoning models (o1/o3/o4) need max_completion_tokens + no temperature (else a hard 400) ---
test('isReasoningModel: matches o1/o3/o4 (incl. openrouter-prefixed), NOT gpt-4o or others', () => {
	for (const m of ['o1', 'o1-preview', 'o3-mini', 'o4-mini', 'openai/o3-mini']) { assert.strictEqual(oc.isReasoningModel(m), true, m); }
	for (const m of ['gpt-4o', 'gpt-4o-mini', 'openai/gpt-4o', 'codestral-latest', 'grok-2-latest', 'meta-llama/llama-3.3-70b-instruct', 'deepseek-chat']) { assert.strictEqual(oc.isReasoningModel(m), false, m); }
});
test('buildChatBody: reasoning model → max_completion_tokens (no max_tokens) and temperature dropped', () => {
	const o = oc.buildChatBody({ model: 'o3-mini', messages: [], maxTokens: 8192, temperature: 0.2 });
	assert.strictEqual(o.max_completion_tokens, 8192);
	assert.ok(!('max_tokens' in o));
	assert.ok(!('temperature' in o));   // o-series reject a non-default temperature
	const g = oc.buildChatBody({ model: 'gpt-4o', messages: [], maxTokens: 8192 });
	assert.strictEqual(g.max_tokens, 8192);
	assert.ok(!('max_completion_tokens' in g));
});

// --- deltaFromEvent: OpenAI streaming shape choices[0].delta.content ---
test('deltaFromEvent: extracts choices[0].delta.content', () => {
	assert.strictEqual(oc.deltaFromEvent({ choices: [{ delta: { content: 'abc' } }] }), 'abc');
});
test('deltaFromEvent: returns "" when no text (role-only chunk, empty, missing)', () => {
	assert.strictEqual(oc.deltaFromEvent({ choices: [{ delta: { role: 'assistant' } }] }), '');
	assert.strictEqual(oc.deltaFromEvent({ choices: [] }), '');
	assert.strictEqual(oc.deltaFromEvent({}), '');
	assert.strictEqual(oc.deltaFromEvent(null), '');
});

// --- registry: getProvider + alias ---
test('getProvider: known ids resolve; anthropic is an alias for claude; unknown → null', () => {
	assert.strictEqual(reg.getProvider('claude').kind, 'anthropic');
	assert.strictEqual(reg.getProvider('anthropic').id, 'claude');   // alias
	assert.strictEqual(reg.getProvider('openrouter').baseURL, 'https://openrouter.ai/api/v1');
	assert.strictEqual(reg.getProvider('ollama').noKey, true);
	assert.strictEqual(reg.getProvider('nope'), null);
});
test('getProvider: openai-kind rows share the adapter (kind==="openai")', () => {
	for (const id of ['openai', 'openrouter', 'groq', 'together', 'fireworks', 'deepseek', 'xai', 'mistral', 'ollama', 'custom']) {
		assert.strictEqual(reg.getProvider(id).kind, 'openai', id + ' should be openai-kind');
	}
});

// --- registry: secretStorageKey (legacy Anthropic vs namespaced vs none) ---
test('secretStorageKey: Anthropic keeps its LEGACY location; others namespaced; noKey → null', () => {
	assert.strictEqual(reg.secretStorageKey('claude'), 'atompp.ai.anthropicKey');
	assert.strictEqual(reg.secretStorageKey('anthropic'), 'atompp.ai.anthropicKey');
	assert.strictEqual(reg.secretStorageKey('openai'), 'atompp.ai.key.openai');
	assert.strictEqual(reg.secretStorageKey('openrouter'), 'atompp.ai.key.openrouter');
	assert.strictEqual(reg.secretStorageKey('custom'), 'atompp.ai.key.custom');
	assert.strictEqual(reg.secretStorageKey('ollama'), null);   // noKey
	assert.strictEqual(reg.secretStorageKey('nope'), null);
});

// --- registry: listProviders is complete + ordered claude-first ---
test('listProviders: claude first, includes the long tail', () => {
	const ids = reg.listProviders().map((p) => p.id);
	assert.strictEqual(ids[0], 'claude');
	for (const want of ['openai', 'openrouter', 'groq', 'ollama', 'custom']) { assert.ok(ids.includes(want), 'missing ' + want); }
	// every openai-kind row (except the user-supplied custom) ships a baseURL
	for (const p of reg.listProviders()) {
		if (p.kind === 'openai' && p.id !== 'custom') { assert.ok(p.baseURL, p.id + ' needs a baseURL'); }
	}
});

// --- registry: isInsecureCustomUrl (the custom-provider key-leak guard) ---
test('isInsecureCustomUrl: https anywhere ok; http only to localhost/loopback; remote http insecure', () => {
	// safe
	assert.strictEqual(reg.isInsecureCustomUrl('https://api.example.com/v1'), false);
	assert.strictEqual(reg.isInsecureCustomUrl('http://localhost:8000/v1'), false);
	assert.strictEqual(reg.isInsecureCustomUrl('http://127.0.0.1:1234/v1'), false);
	assert.strictEqual(reg.isInsecureCustomUrl('http://[::1]:11434/v1'), false);
	assert.strictEqual(reg.isInsecureCustomUrl('http://0.0.0.0:8080/v1'), false);
	// insecure — plaintext to a remote host would leak the Bearer key
	assert.strictEqual(reg.isInsecureCustomUrl('http://api.example.com/v1'), true);
	assert.strictEqual(reg.isInsecureCustomUrl('http://192.168.1.50:8000/v1'), true);
	// a "localhost"-looking host that is actually a remote domain must NOT be treated as local
	assert.strictEqual(reg.isInsecureCustomUrl('http://localhost.evil.com/v1'), true);
});

console.log('\nproviders: ' + n + ' tests passed.');
