/*---------------------------------------------------------------------------------------------
 *  Unit tests for the LevelCode Cloud gateway routing decision (pure) — run: node test/gateway.test.js
 *    - resolveGateway: when it engages (signed in + gateway mode + endpoint) vs falls back to BYOK
 *    - baseURL/key selection (openai-kind endpoint under /api/levelcode/v1/ai, cloud token as the key)
 *    - https validation (an http endpoint is refused so the Bearer token can't leak in plaintext)
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

const assert = require('assert');
const { resolveGateway, GATEWAY_PATH } = require('../providers/gateway');

let n = 0;
function test(name, fn) { fn(); n++; console.log('  ok - ' + name); }

// --- fall back to BYOK (use:false) unless ALL of: gateway mode, a token, and an endpoint ---
test('resolveGateway: byok mode never engages (default path untouched)', () => {
	assert.deepStrictEqual(resolveGateway({ mode: 'byok', endpoint: 'https://levelcode.ai', token: 't' }), { use: false });
	assert.deepStrictEqual(resolveGateway({ endpoint: 'https://levelcode.ai', token: 't' }), { use: false });   // mode defaults to byok
	assert.deepStrictEqual(resolveGateway({}), { use: false });
});
test('resolveGateway: gateway mode but signed out (no token) → falls back to BYOK', () => {
	assert.deepStrictEqual(resolveGateway({ mode: 'gateway', endpoint: 'https://levelcode.ai', token: '' }), { use: false });
	assert.deepStrictEqual(resolveGateway({ mode: 'gateway', endpoint: 'https://levelcode.ai' }), { use: false });
});
test('resolveGateway: gateway mode but no endpoint → falls back to BYOK', () => {
	assert.deepStrictEqual(resolveGateway({ mode: 'gateway', endpoint: '', token: 't' }), { use: false });
	assert.deepStrictEqual(resolveGateway({ mode: 'gateway', token: 't' }), { use: false });
});

// --- happy path: openai-kind endpoint under the AI namespace, cloud token as the key ---
test('resolveGateway: signed-in gateway mode → openai endpoint at {endpoint}/api/levelcode/v1/ai with the token', () => {
	const r = resolveGateway({ mode: 'gateway', endpoint: 'https://levelcode.ai', token: 'sekret' });
	assert.deepStrictEqual(r, { use: true, ok: true, providerId: 'openai', baseURL: 'https://levelcode.ai/api/levelcode/v1/ai', apiKey: 'sekret' });
	assert.strictEqual(GATEWAY_PATH, '/api/levelcode/v1/ai');
});
test('resolveGateway: a trailing slash on the endpoint is normalized (no double slash in the path)', () => {
	const r = resolveGateway({ mode: 'gateway', endpoint: 'https://levelcode.ai/', token: 't' });
	assert.strictEqual(r.ok, true);
	assert.strictEqual(r.baseURL, 'https://levelcode.ai/api/levelcode/v1/ai');
});
test('resolveGateway: a self-hosted https endpoint with a port is honored', () => {
	const r = resolveGateway({ mode: 'gateway', endpoint: 'https://cloud.example.com:8443', token: 't' });
	assert.strictEqual(r.ok, true);
	assert.strictEqual(r.baseURL, 'https://cloud.example.com:8443/api/levelcode/v1/ai');
});

// --- https validation: the cloud token is a Bearer credential; refuse plaintext http ---
test('resolveGateway: http endpoint is refused (insecureGateway) so the token never leaks', () => {
	for (const ep of ['http://levelcode.ai', 'http://localhost:3000', 'http://127.0.0.1:3000', 'ftp://levelcode.ai']) {
		const r = resolveGateway({ mode: 'gateway', endpoint: ep, token: 't' });
		assert.deepStrictEqual(r, { use: true, ok: false, reason: 'insecureGateway' }, ep + ' should be refused');
	}
});
test('resolveGateway: https is required even for a localhost endpoint (token is a real credential)', () => {
	const r = resolveGateway({ mode: 'gateway', endpoint: 'https://localhost:3000', token: 't' });
	assert.strictEqual(r.ok, true);
	assert.strictEqual(r.baseURL, 'https://localhost:3000/api/levelcode/v1/ai');
});

console.log('\ngateway: ' + n + ' tests passed.');
