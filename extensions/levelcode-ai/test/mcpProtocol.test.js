/*---------------------------------------------------------------------------------------------
 *  Unit tests for extensions/levelcode-ai/mcpProtocol.js  —  run: node test/mcpProtocol.test.js
 *
 *  Two directions worth protecting:
 *    FRAMING  — a pipe does not respect message boundaries. A message split across chunks must still
 *               arrive exactly once, and a stray non-JSON line (servers do log to stdout) must be
 *               skipped rather than desynchronising the stream.
 *    RESULTS  — a tool result becomes a plain string in the transcript, so every content shape must
 *               degrade readably, failures must carry the agent's `ERROR: ` prefix, and the whole
 *               thing must be capped (nothing else in the tool path bounds size).
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

const assert = require('assert');
const P = require('../mcpProtocol');

let n = 0;
function test(name, fn) { fn(); n++; console.log('  ok - ' + name); }

// ---- framing ---------------------------------------------------------------------------------

test('FRAMING: one whole message in one chunk', () => {
	const f = P.createFramer();
	assert.deepStrictEqual(f.push('{"jsonrpc":"2.0","id":1,"result":{}}\n'), [{ jsonrpc: '2.0', id: 1, result: {} }]);
});

test('FRAMING: a message SPLIT across chunks arrives once, when completed', () => {
	const f = P.createFramer();
	assert.deepStrictEqual(f.push('{"jsonrpc":"2.0","id":'), []);       // nothing yet
	assert.deepStrictEqual(f.push('7,"result":{"ok":true}}'), []);      // still no newline
	const out = f.push('\n');
	assert.strictEqual(out.length, 1);
	assert.strictEqual(out[0].id, 7);
	assert.strictEqual(f.pending, 0);
});

test('FRAMING: several messages in one chunk all arrive, in order', () => {
	const f = P.createFramer();
	const out = f.push('{"id":1}\n{"id":2}\n{"id":3}\n');
	assert.deepStrictEqual(out.map((m) => m.id), [1, 2, 3]);
});

test('FRAMING: a stray non-JSON log line is skipped, not fatal, and does not desync', () => {
	const f = P.createFramer();
	const out = f.push('listening on stdio…\n{"id":1}\nanother log\n{"id":2}\n');
	assert.deepStrictEqual(out.map((m) => m.id), [1, 2]);
});

test('FRAMING: blank lines and \\r\\n are tolerated', () => {
	const f = P.createFramer();
	const out = f.push('\n\n{"id":1}\r\n\n{"id":2}\n');
	assert.deepStrictEqual(out.map((m) => m.id), [1, 2]);
});

test('FRAMING: a line past the cap throws (peer is not speaking the protocol)', () => {
	const f = P.createFramer({ maxLine: 64 });
	assert.throws(() => f.push('x'.repeat(200)), /no newline/);
});

test('FRAMING: encode is newline-terminated single-line JSON', () => {
	const s = P.encode({ a: 1, b: 'two\nlines' });
	assert.strictEqual(s.slice(-1), '\n');
	assert.strictEqual(s.trim().split('\n').length, 1, 'embedded newlines must stay escaped');
	assert.deepStrictEqual(JSON.parse(s), { a: 1, b: 'two\nlines' });
});

// ---- results ---------------------------------------------------------------------------------

test('RESULTS: text blocks are joined', () => {
	assert.strictEqual(P.flattenContent({ content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }), 'a\nb');
});

test('RESULTS: isError gets the agent\'s ERROR: prefix', () => {
	const out = P.flattenContent({ content: [{ type: 'text', text: 'it broke' }], isError: true });
	assert.ok(out.startsWith('ERROR: '), out);
	assert.ok(out.includes('it broke'));
});

test('RESULTS: non-text blocks degrade to a readable placeholder', () => {
	const out = P.flattenContent({ content: [
		{ type: 'image', mimeType: 'image/png', data: 'AAAA' },
		{ type: 'audio', data: 'BBBB' },
		{ type: 'resource', resource: { uri: 'file:///x', text: 'inline text' } },
		{ type: 'resource', resource: { uri: 'file:///y' } },
		{ type: 'weird-future-type' }
	] });
	assert.ok(out.includes('[image image/png omitted'));
	assert.ok(out.includes('[audio omitted'));
	assert.ok(out.includes('inline text'), 'a resource WITH text should contribute its text');
	assert.ok(out.includes('[resource file:///y omitted]'));
	assert.ok(out.includes('[weird-future-type content omitted]'));
	assert.ok(!out.includes('AAAA'), 'base64 payloads must never reach the transcript');
});

test('RESULTS: structuredContent is used when there are no text blocks', () => {
	assert.strictEqual(P.flattenContent({ content: [], structuredContent: { ok: 1 } }), '{"ok":1}');
});

test('RESULTS: output is capped with a marker', () => {
	const out = P.flattenContent({ content: [{ type: 'text', text: 'x'.repeat(5000) }] }, { cap: 100 });
	assert.ok(out.length < 200, 'should be capped, got ' + out.length);
	assert.ok(/truncated at 100 chars/.test(out));
});

test('RESULTS: empty / malformed results never return empty-string', () => {
	for (const r of [null, undefined, {}, { content: [] }, { content: 'nope' }, 42]) {
		// @ts-expect-error — deliberately wrong shapes
		const out = P.flattenContent(r);
		assert.ok(typeof out === 'string' && out.length > 0, JSON.stringify(r) + ' → ' + JSON.stringify(out));
	}
});

test('errorText renders a JSON-RPC error object on one line', () => {
	assert.strictEqual(P.errorText({ code: -32601, message: 'method not found' }), 'method not found (-32601)');
	assert.strictEqual(P.errorText(null), 'unknown error');
});

test('initializeParams asks for the pinned revision and claims no capabilities', () => {
	const p = P.initializeParams('LevelCode', '1.2.3');
	assert.strictEqual(p.protocolVersion, P.PROTOCOL_VERSION);
	assert.deepStrictEqual(p.capabilities, {}, 'we consume tools only — claiming more invites server→client requests');
	assert.strictEqual(p.clientInfo.version, '1.2.3');
});

console.log('\nmcpProtocol.js: ' + n + ' tests passed.');
