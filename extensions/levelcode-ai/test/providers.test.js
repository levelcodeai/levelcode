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
	assert.strictEqual(reg.secretStorageKey('claude'), 'levelcode.ai.anthropicKey');
	assert.strictEqual(reg.secretStorageKey('anthropic'), 'levelcode.ai.anthropicKey');
	assert.strictEqual(reg.secretStorageKey('openai'), 'levelcode.ai.key.openai');
	assert.strictEqual(reg.secretStorageKey('openrouter'), 'levelcode.ai.key.openrouter');
	assert.strictEqual(reg.secretStorageKey('custom'), 'levelcode.ai.key.custom');
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

// --- extractApiError: pull a clean message from an error body; '' when there's nothing worth showing ---
test('extractApiError: JSON {error:{message}} -> the message (OpenAI/OpenRouter shape)', () => {
	assert.strictEqual(oc.extractApiError('{"error":{"message":"model is overloaded","type":"server_error"}}'), 'model is overloaded');
});
test('extractApiError: {error:"str"} and {message} shapes both yield the text', () => {
	assert.strictEqual(oc.extractApiError('{"error":"nope"}'), 'nope');
	assert.strictEqual(oc.extractApiError('{"message":"bad key"}'), 'bad key');
});
test('extractApiError: an HTML proxy page yields "" — never dump nginx/Cloudflare markup', () => {
	const nginx502 = '<html>\r\n<head><title>502 Bad Gateway</title></head>\r\n<body>\r\n<center><h1>502 Bad Gateway</h1></center>\r\n</body>\r\n</html>';
	assert.strictEqual(oc.extractApiError(nginx502), '');
	assert.strictEqual(oc.extractApiError('<!DOCTYPE html><html><body>down</body></html>'), '');
});
test('extractApiError: empty / whitespace / null -> ""', () => {
	assert.strictEqual(oc.extractApiError(''), '');
	assert.strictEqual(oc.extractApiError('   \n  '), '');
	assert.strictEqual(oc.extractApiError(null), '');
});
test('extractApiError: short plain text kept as-is; an over-long body is hard-capped', () => {
	assert.strictEqual(oc.extractApiError('rate limited, retry soon'), 'rate limited, retry soon');
	const out = oc.extractApiError('x'.repeat(1000));
	assert.strictEqual(out.length, 301);                       // 300 chars + one ellipsis
	assert.strictEqual(out.charCodeAt(300), 0x2026);
});
test('extractApiError: malformed JSON falls through to capped text instead of throwing', () => {
	assert.strictEqual(oc.extractApiError('{not valid json'), '{not valid json');
});

// --- httpError: "<label> API <status>: <detail>" — precisely the reported "OpenAI API 502: <html>" bug ---
test('httpError: nginx 502 HTML collapses to "<label> API 502: Bad Gateway", no markup', () => {
	const html = '<html><head><title>502 Bad Gateway</title></head><body><center><h1>502 Bad Gateway</h1></center></body></html>';
	const e = oc.httpError('LevelCode Cloud', { status: 502, statusText: 'Bad Gateway' }, html);
	assert.strictEqual(e.message, 'LevelCode Cloud API 502: Bad Gateway');
	assert.strictEqual(e.status, 502);
	assert.ok(!/[<>]/.test(e.message), 'no HTML leaks into the surfaced message');
});
test('httpError: the label names the ROUTE — a gateway failure is not attributed to OpenAI', () => {
	const e = oc.httpError('LevelCode Cloud', { status: 502, statusText: 'Bad Gateway' }, '<html>502</html>');
	assert.ok(e.message.startsWith('LevelCode Cloud API 502'));
	assert.ok(!/OpenAI/.test(e.message));
});
test('httpError: empty statusText falls back to the canonical reason phrase', () => {
	const e = oc.httpError('OpenRouter', { status: 503, statusText: '' }, '<html>x</html>');
	assert.strictEqual(e.message, 'OpenRouter API 503: Service Unavailable');
});
test('httpError: a genuine JSON API error keeps the provider message verbatim', () => {
	const e = oc.httpError('OpenRouter', { status: 429, statusText: 'Too Many Requests' }, '{"error":{"message":"rate limit exceeded"}}');
	assert.strictEqual(e.message, 'OpenRouter API 429: rate limit exceeded');
});

// --- postChat: one pre-stream retry on a transient 502/503/504 (async — driven by a stubbed fetch) ---
// fetch is stubbed per-test with a minimal Response-like object. The retry is pre-stream, so these never
// reach readLines; they assert whether the request IS or is NOT re-issued and that the final error is clean.
// The plain test() helper does not await, so async cases use testAsync inside an awaited IIFE — otherwise a
// rejected assertion would count as a silent pass (the exact false-green trap these tests exist to avoid).
const savedFetch = global.fetch;
function fakeRes(status, body) {
	return { ok: status >= 200 && status < 300, status, statusText: '', body: {}, text: async () => (body || ''), json: async () => ({}) };
}
async function testAsync(name, fn) { await fn(); n++; console.log('  ok - ' + name); }

(async () => {
	await testAsync('postChat: a 502 then 200 recovers — the run survives one transient blip', async () => {
		let calls = 0;
		global.fetch = async () => { calls++; return calls === 1 ? fakeRes(502, '<html>502</html>') : fakeRes(200, ''); };
		const res = await oc.postChat({ baseURL: 'https://x/v1', label: 'LevelCode Cloud', retryDelayMs: 0 }, { model: 'm', messages: [] });
		assert.strictEqual(res.status, 200);
		assert.strictEqual(calls, 2, 'exactly one retry');
	});
	await testAsync('postChat: a persistent 503 throws a clean error after the single retry', async () => {
		let calls = 0;
		global.fetch = async () => { calls++; return fakeRes(503, '<html>503</html>'); };
		await assert.rejects(
			oc.postChat({ baseURL: 'https://x/v1', label: 'LevelCode Cloud', retryDelayMs: 0 }, { model: 'm', messages: [] }),
			(e) => e.message === 'LevelCode Cloud API 503: Service Unavailable' && e.status === 503
		);
		assert.strictEqual(calls, 2, 'first try + one retry, then give up');
	});
	await testAsync('postChat: a non-transient 400 is NOT retried', async () => {
		let calls = 0;
		global.fetch = async () => { calls++; return fakeRes(400, '{"error":{"message":"bad request"}}'); };
		await assert.rejects(
			oc.postChat({ baseURL: 'https://x/v1', label: 'OpenRouter', retryDelayMs: 0 }, { model: 'm', messages: [] }),
			(e) => e.message === 'OpenRouter API 400: bad request'
		);
		assert.strictEqual(calls, 1, 'no retry on 4xx');
	});
	await testAsync('postChat: onRetry fires once, before the backoff, with the failing status', async () => {
		let calls = 0; const seen = [];
		global.fetch = async () => { calls++; return calls === 1 ? fakeRes(504, '') : fakeRes(200, ''); };
		await oc.postChat({ baseURL: 'https://x/v1', label: 'L', retryDelayMs: 0, onRetry: (i) => seen.push(i) }, { model: 'm', messages: [] });
		assert.deepStrictEqual(seen, [{ attempt: 1, retries: 1, status: 504 }]);
	});
	await testAsync('postChat: a clean 200 never retries and never calls onRetry', async () => {
		let calls = 0; let retried = false;
		global.fetch = async () => { calls++; return fakeRes(200, ''); };
		await oc.postChat({ baseURL: 'https://x/v1', retryDelayMs: 0, onRetry: () => { retried = true; } }, { model: 'm', messages: [] });
		assert.strictEqual(calls, 1); assert.strictEqual(retried, false);
	});
	await testAsync('postChat: an aborted signal surfaces AbortError and is never retried as transient', async () => {
		const ac = new AbortController(); ac.abort();
		let calls = 0;
		global.fetch = async (url, init) => { calls++; if (init && init.signal && init.signal.aborted) { const e = new Error('aborted'); e.name = 'AbortError'; throw e; } return fakeRes(200, ''); };
		await assert.rejects(
			oc.postChat({ baseURL: 'https://x/v1', retryDelayMs: 0, signal: ac.signal }, { model: 'm', messages: [] }),
			(e) => e.name === 'AbortError'
		);
		assert.strictEqual(calls, 1, 'AbortError propagates immediately — never retried');
	});

	global.fetch = savedFetch;
	console.log('\nproviders: ' + n + ' tests passed.');
})().catch((e) => { console.error(e); process.exit(1); });
