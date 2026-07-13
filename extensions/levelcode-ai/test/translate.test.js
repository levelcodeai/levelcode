/*---------------------------------------------------------------------------------------------
 *  Unit tests for providers/translate.js — the P2 Anthropic↔OpenAI tool-use translation.
 *  This is the correctness-critical layer: it must round-trip tool_use/tool_result id-pairing and
 *  reproduce the exact canonical {content, malformed} shape agent.js consumes. run: node test/translate.test.js
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

const assert = require('assert');
const T = require('../providers/translate');

let n = 0;
function test(name, fn) { fn(); n++; console.log('  ok - ' + name); }

// ---- toOpenAITools: field rename input_schema → parameters ----
test('toOpenAITools: maps name/description/input_schema → function.{name,description,parameters}', () => {
	const out = T.toOpenAITools([{ name: 'read_file', description: 'Read a file', input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }]);
	assert.strictEqual(out.length, 1);
	assert.strictEqual(out[0].type, 'function');
	assert.strictEqual(out[0].function.name, 'read_file');
	assert.strictEqual(out[0].function.description, 'Read a file');
	assert.deepStrictEqual(out[0].function.parameters, { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] });
});
test('toOpenAITools: empty/undefined → undefined (so no tools field is sent)', () => {
	assert.strictEqual(T.toOpenAITools([]), undefined);
	assert.strictEqual(T.toOpenAITools(null), undefined);
});

// ---- toOpenAIMessages: the core transcript translation ----
test('toOpenAIMessages: system prepended; plain user/assistant strings pass through', () => {
	const out = T.toOpenAIMessages('SYS', [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }]);
	assert.deepStrictEqual(out[0], { role: 'system', content: 'SYS' });
	assert.deepStrictEqual(out[1], { role: 'user', content: 'hi' });
	assert.deepStrictEqual(out[2], { role: 'assistant', content: 'hello' });
});
test('toOpenAIMessages: assistant [text + tool_use] → content + tool_calls (arguments JSON-stringified)', () => {
	const out = T.toOpenAIMessages('', [{ role: 'assistant', content: [
		{ type: 'text', text: 'Reading it.' },
		{ type: 'tool_use', id: 'toolu_1', name: 'read_file', input: { path: 'a.js' } }
	] }]);
	assert.strictEqual(out.length, 1);
	assert.strictEqual(out[0].role, 'assistant');
	assert.strictEqual(out[0].content, 'Reading it.');
	assert.strictEqual(out[0].tool_calls.length, 1);
	assert.strictEqual(out[0].tool_calls[0].id, 'toolu_1');
	assert.strictEqual(out[0].tool_calls[0].type, 'function');
	assert.strictEqual(out[0].tool_calls[0].function.name, 'read_file');
	assert.deepStrictEqual(JSON.parse(out[0].tool_calls[0].function.arguments), { path: 'a.js' });
});
test('toOpenAIMessages: assistant with ONLY tool_use → content:null + tool_calls', () => {
	const out = T.toOpenAIMessages('', [{ role: 'assistant', content: [{ type: 'tool_use', id: 't2', name: 'list_files', input: {} }] }]);
	assert.strictEqual(out[0].content, null);
	assert.strictEqual(out[0].tool_calls[0].function.name, 'list_files');
	assert.strictEqual(out[0].tool_calls[0].function.arguments, '{}');
});
test('toOpenAIMessages: user tool_result blocks → one {role:tool, tool_call_id} each (ids round-trip)', () => {
	const out = T.toOpenAIMessages('', [{ role: 'user', content: [
		{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'file contents' },
		{ type: 'tool_result', tool_use_id: 'toolu_2', content: 'other' }
	] }]);
	assert.strictEqual(out.length, 2);
	assert.deepStrictEqual(out[0], { role: 'tool', tool_call_id: 'toolu_1', content: 'file contents' });
	assert.deepStrictEqual(out[1], { role: 'tool', tool_call_id: 'toolu_2', content: 'other' });
});
test('toOpenAIMessages: user [tool_result + text] → tool message first, then a trailing user message', () => {
	const out = T.toOpenAIMessages('', [{ role: 'user', content: [
		{ type: 'tool_result', tool_use_id: 'x', content: 'ok' },
		{ type: 'text', text: 'Your last turn was cut off. Continue.' }
	] }]);
	assert.strictEqual(out.length, 2);
	assert.strictEqual(out[0].role, 'tool');
	assert.strictEqual(out[0].tool_call_id, 'x');
	assert.deepStrictEqual(out[1], { role: 'user', content: 'Your last turn was cut off. Continue.' });
});
test('toOpenAIMessages: tool_result content given as block array → flattened to a string', () => {
	const out = T.toOpenAIMessages('', [{ role: 'user', content: [
		{ type: 'tool_result', tool_use_id: 'x', content: [{ type: 'text', text: 'line1' }, { type: 'text', text: 'line2' }] }
	] }]);
	assert.strictEqual(out[0].content, 'line1\nline2');
});
test('toOpenAIMessages: OpenAI ordering invariant — assistant(tool_calls) immediately followed by its tool replies', () => {
	// A realistic mini-transcript: goal → assistant makes 2 calls → user returns 2 results → assistant done.
	const transcript = [
		{ role: 'user', content: 'refactor foo' },
		{ role: 'assistant', content: [
			{ type: 'text', text: 'Reading both.' },
			{ type: 'tool_use', id: 'a', name: 'read_file', input: { path: 'foo.js' } },
			{ type: 'tool_use', id: 'b', name: 'read_file', input: { path: 'bar.js' } }
		] },
		{ role: 'user', content: [
			{ type: 'tool_result', tool_use_id: 'a', content: '...foo...' },
			{ type: 'tool_result', tool_use_id: 'b', content: '...bar...' }
		] },
		{ role: 'assistant', content: 'Done: refactored.' }
	];
	const out = T.toOpenAIMessages('SYS', transcript);
	// system, user, assistant(2 tool_calls), tool(a), tool(b), assistant(done)
	assert.strictEqual(out[0].role, 'system');
	assert.strictEqual(out[1].role, 'user');
	assert.strictEqual(out[2].role, 'assistant');
	assert.strictEqual(out[2].tool_calls.length, 2);
	assert.strictEqual(out[3].role, 'tool'); assert.strictEqual(out[3].tool_call_id, 'a');
	assert.strictEqual(out[4].role, 'tool'); assert.strictEqual(out[4].tool_call_id, 'b');
	assert.strictEqual(out[5].role, 'assistant'); assert.strictEqual(out[5].content, 'Done: refactored.');
	// every tool message's id has a matching tool_call in the immediately-preceding assistant message
	const callIds = new Set(out[2].tool_calls.map((t) => t.id));
	assert.ok(callIds.has(out[3].tool_call_id) && callIds.has(out[4].tool_call_id));
});

// ---- fromOpenAIFinishReason ----
test('fromOpenAIFinishReason: normalizes to Anthropic stop_reason', () => {
	assert.strictEqual(T.fromOpenAIFinishReason('tool_calls'), 'tool_use');
	assert.strictEqual(T.fromOpenAIFinishReason('function_call'), 'tool_use');
	assert.strictEqual(T.fromOpenAIFinishReason('length'), 'max_tokens');
	assert.strictEqual(T.fromOpenAIFinishReason('stop'), 'end_turn');
	assert.strictEqual(T.fromOpenAIFinishReason('content_filter'), 'stop_sequence');
	assert.strictEqual(T.fromOpenAIFinishReason(null), 'end_turn');
});

// ---- accumulateToolCalls: streamed fragment assembly by index ----
test('accumulateToolCalls: assembles id/name (first fragment) + concatenated argument fragments by index', () => {
	const acc = [];
	const started = [];
	// OpenAI streams: first fragment carries id+name, then argument string pieces
	T.accumulateToolCalls(acc, [{ index: 0, id: 'call_1', function: { name: 'edit_file', arguments: '{"path":"a.js",' } }], (nm) => started.push(nm));
	T.accumulateToolCalls(acc, [{ index: 0, function: { arguments: '"old_str":"x",' } }], (nm) => started.push(nm));
	T.accumulateToolCalls(acc, [{ index: 0, function: { arguments: '"new_str":"y"}' } }], (nm) => started.push(nm));
	assert.strictEqual(acc.length, 1);
	assert.strictEqual(acc[0].id, 'call_1');
	assert.strictEqual(acc[0].name, 'edit_file');
	assert.deepStrictEqual(JSON.parse(acc[0].args), { path: 'a.js', old_str: 'x', new_str: 'y' });
	assert.deepStrictEqual(started, ['edit_file']);   // onNew fires exactly once per index
});
test('accumulateToolCalls: two parallel tool calls tracked by distinct index', () => {
	const acc = [];
	T.accumulateToolCalls(acc, [
		{ index: 0, id: 'c0', function: { name: 'read_file', arguments: '{"path":' } },
		{ index: 1, id: 'c1', function: { name: 'search', arguments: '{"query":' } }
	]);
	T.accumulateToolCalls(acc, [
		{ index: 0, function: { arguments: '"a.js"}' } },
		{ index: 1, function: { arguments: '"foo"}' } }
	]);
	assert.strictEqual(acc.length, 2);
	assert.deepStrictEqual(JSON.parse(acc[0].args), { path: 'a.js' });
	assert.deepStrictEqual(JSON.parse(acc[1].args), { query: 'foo' });
	assert.strictEqual(acc[0].name, 'read_file');
	assert.strictEqual(acc[1].name, 'search');
});

// ---- finalizeOpenAIBlocks: canonical blocks + malformed set (mirrors anthropic.finalizeAgentBlocks) ----
test('finalizeOpenAIBlocks: text + valid tool args → clean blocks, empty malformed', () => {
	const acc = [{ id: 't1', name: 'read_file', args: '{"path":"a.js"}' }];
	const { content, malformed } = T.finalizeOpenAIBlocks('Some text.', acc);
	assert.deepStrictEqual(content[0], { type: 'text', text: 'Some text.' });
	assert.deepStrictEqual(content[1], { type: 'tool_use', id: 't1', name: 'read_file', input: { path: 'a.js' } });
	assert.strictEqual(malformed.size, 0);
});
test('finalizeOpenAIBlocks: no text → only tool_use blocks (no empty text block)', () => {
	const { content } = T.finalizeOpenAIBlocks('', [{ id: 't1', name: 'list_files', args: '' }]);
	assert.strictEqual(content.length, 1);
	assert.strictEqual(content[0].type, 'tool_use');
});
test('finalizeOpenAIBlocks: empty args → input:{} and NOT malformed (a no-arg tool)', () => {
	const { content, malformed } = T.finalizeOpenAIBlocks('', [{ id: 't1', name: 'list_files', args: '' }]);
	assert.deepStrictEqual(content[0].input, {});
	assert.strictEqual(malformed.size, 0);
});
test('finalizeOpenAIBlocks: truncated JSON args → input:{} AND id added to malformed', () => {
	const { content, malformed } = T.finalizeOpenAIBlocks('', [{ id: 'tX', name: 'edit_file', args: '{"path":"a.js","old_str":"foo' }]);
	assert.deepStrictEqual(content[0].input, {});
	assert.ok(malformed.has('tX'));
});
test('finalizeOpenAIBlocks: valid JSON but not an object (array) → input:{} AND malformed', () => {
	const { content, malformed } = T.finalizeOpenAIBlocks('', [{ id: 'tY', name: 'x', args: '[1,2,3]' }]);
	assert.deepStrictEqual(content[0].input, {});
	assert.ok(malformed.has('tY'));
});
test('finalizeOpenAIBlocks: missing id gets a Mistral-legal 9-char alphanumeric synthetic id', () => {
	const { content } = T.finalizeOpenAIBlocks('', [{ id: '', name: 'x', args: '{}' }]);
	assert.strictEqual(content[0].id, 'call00000');
	assert.ok(/^[a-zA-Z0-9]{9}$/.test(content[0].id));   // Mistral requires exactly [a-zA-Z0-9]{9}
});
test('finalizeOpenAIBlocks: a name-less tool call (truncated before name) is skipped, not emitted as name:""', () => {
	// text-only + a nameless malformed slot → only the text survives; no illegal function.name:'' block
	const { content } = T.finalizeOpenAIBlocks('some text', [{ id: 'x', name: '', args: '{"a":1}' }]);
	assert.strictEqual(content.length, 1);
	assert.strictEqual(content[0].type, 'text');
	// a named call alongside a nameless one → only the named one is emitted, with a clean sequential id
	const r2 = T.finalizeOpenAIBlocks('', [{ id: '', name: '', args: '{}' }, { id: '', name: 'read_file', args: '{"path":"a"}' }]);
	assert.strictEqual(r2.content.length, 1);
	assert.strictEqual(r2.content[0].name, 'read_file');
	assert.strictEqual(r2.content[0].id, 'call00000');
});

// ---- end-to-end: stream deltas → finalize → the shape agent.js expects ----
test('end-to-end: streamed edit_file call assembles into a canonical tool_use block agent.js can run', () => {
	const acc = [];
	let text = '';
	const chunks = [
		{ choices: [{ delta: { content: 'Editing ' } }] },
		{ choices: [{ delta: { content: 'the file.' } }] },
		{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_9', function: { name: 'edit_file', arguments: '{"path":"x.js",' } }] } }] },
		{ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"old_str":"a","new_str":"b"}' } }] } }] },
		{ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }
	];
	let finish = null;
	for (const ev of chunks) {
		const c = ev.choices[0], d = c.delta || {};
		if (typeof d.content === 'string') { text += d.content; }
		if (Array.isArray(d.tool_calls)) { T.accumulateToolCalls(acc, d.tool_calls); }
		if (c.finish_reason) { finish = c.finish_reason; }
	}
	const { content, malformed } = T.finalizeOpenAIBlocks(text, acc);
	assert.strictEqual(T.fromOpenAIFinishReason(finish), 'tool_use');
	assert.deepStrictEqual(content[0], { type: 'text', text: 'Editing the file.' });
	assert.strictEqual(content[1].type, 'tool_use');
	assert.strictEqual(content[1].name, 'edit_file');
	assert.deepStrictEqual(content[1].input, { path: 'x.js', old_str: 'a', new_str: 'b' });
	assert.strictEqual(malformed.size, 0);
	// agent.js will build {type:'tool_result', tool_use_id: content[1].id, ...} — the id must be present
	assert.strictEqual(content[1].id, 'call_9');
});

// ---- [LevelCode] prompt-caching breakpoints (opts.cache) ----
test('toOpenAIMessages: no cache opt → system stays a plain string (legacy shape unchanged)', () => {
	const out = T.toOpenAIMessages('SYS', [{ role: 'user', content: 'hi' }]);
	assert.strictEqual(out[0].content, 'SYS');
	assert.strictEqual(out[1].content, 'hi');
});

test('toOpenAIMessages: cache:true → cache_control on the system block AND the last message', () => {
	const out = T.toOpenAIMessages('SYS', [{ role: 'user', content: 'hi' }], { cache: true });
	assert.ok(Array.isArray(out[0].content));                                  // system → block form
	assert.strictEqual(out[0].content[0].text, 'SYS');
	assert.deepStrictEqual(out[0].content[0].cache_control, { type: 'ephemeral' });   // caches tools+system upstream
	const last = out[out.length - 1];
	assert.ok(Array.isArray(last.content));
	assert.deepStrictEqual(last.content[last.content.length - 1].cache_control, { type: 'ephemeral' }); // rolling transcript breakpoint
});

test('toOpenAIMessages: cache:true → rolling breakpoint lands on the last tool_result message', () => {
	const msgs = [
		{ role: 'user', content: 'do it' },
		{ role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'read_file', input: { path: 'x' } }] },
		{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'file body' }] }
	];
	const out = T.toOpenAIMessages('SYS', msgs, { cache: true });
	const last = out[out.length - 1];
	assert.strictEqual(last.role, 'tool');                                     // tool_result → {role:'tool'}
	assert.deepStrictEqual(last.content[0].cache_control, { type: 'ephemeral' });
});

test('isAnthropicFamily: gates cache_control writes to Claude upstreams only', () => {
	const O = require('../providers/openaiCompat');
	assert.strictEqual(O.isAnthropicFamily('anthropic/claude-sonnet-4-6'), true);
	assert.strictEqual(O.isAnthropicFamily('claude-opus-4-8'), true);
	assert.strictEqual(O.isAnthropicFamily('openai/gpt-4o'), false);
	assert.strictEqual(O.isAnthropicFamily('deepseek/deepseek-chat'), false);
	assert.strictEqual(O.isAnthropicFamily('moonshotai/kimi-k2.7-code'), false);
	assert.strictEqual(O.isAnthropicFamily(''), false);
});

console.log('\ntranslate: ' + n + ' tests passed.');
