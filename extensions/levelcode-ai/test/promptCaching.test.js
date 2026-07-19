/*---------------------------------------------------------------------------------------------
 *  Regression tests for prompt caching (P4/P4.5):
 *    - openaiCompat.splitOutCachedTokens splits OpenAI-style cached_tokens out of prompt_tokens.
 *    - anthropic.withRollingCacheBreakpoint places breakpoints on system + last message.
 *    - The two-breakpoint agent pattern survives a round-trip through translate.js on Anthropic-family.
 *
 *  run: node test/promptCaching.test.js
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

const assert = require('assert');
const A = require('../providers/anthropic');
const O = require('../providers/openaiCompat');
const T = require('../providers/translate');

let n = 0;
function test(name, fn) { fn(); n++; console.log('  ok - ' + name); }

// ---- Anthropic: the native two-breakpoint pattern ----

test('withRollingCacheBreakpoint: marks only the last non-empty message/block', () => {
	const msgs = [
		{ role: 'user', content: 'goal' },
		{ role: 'assistant', content: 'ok' },
		{ role: 'user', content: 'result' }
	];
	const out = A.withRollingCacheBreakpoint(msgs);
	// first two unchanged
	assert.deepStrictEqual(out[0], msgs[0]);
	assert.deepStrictEqual(out[1], msgs[1]);
	// last message's last block has cache_control
	const last = out[2];
	assert.ok(Array.isArray(last.content));
	assert.deepStrictEqual(last.content[0].cache_control, { type: 'ephemeral' });
});

test('withRollingCacheBreakpoint: skips empty trailing messages and lands on the prior real one', () => {
	const msgs = [
		{ role: 'user', content: 'goal' },
		{ role: 'assistant', content: '' },                  // empty string → skipped
		{ role: 'assistant', content: [{ type: 'text', text: '' }] }  // empty block → skipped
	];
	const out = A.withRollingCacheBreakpoint(msgs);
	// Empty trailing messages are skipped: the breakpoint lands on msgs[0].
	assert.strictEqual(out.length, 3);
	assert.deepStrictEqual(out[0].content, [{ type: 'text', text: 'goal', cache_control: { type: 'ephemeral' } }]);
	assert.strictEqual(out[1].content, '');
	assert.deepStrictEqual(out[2].content, [{ type: 'text', text: '' }]);
});

test('withRollingCacheBreakpoint: handles block-array content on the last message', () => {
	const msgs = [
		{ role: 'user', content: [
			{ type: 'text', text: 'step 1' },
			{ type: 'tool_result', tool_use_id: 'a', content: 'ok' }
		] }
	];
	const out = A.withRollingCacheBreakpoint(msgs);
	const arr = out[0].content;
	assert.strictEqual(arr.length, 2);
	assert.ok(!('cache_control' in arr[0]));
	assert.deepStrictEqual(arr[1].cache_control, { type: 'ephemeral' });
});

// ---- OpenAI-compatible: split cached_tokens out of prompt_tokens ----

test('splitOutCachedTokens: subtracts cached from prompt, records cache_read, preserves output', () => {
	const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 };
	const ev = { usage: { prompt_tokens: 10339, completion_tokens: 60, prompt_tokens_details: { cached_tokens: 10318 } } };
	O.splitOutCachedTokens(usage, ev);
	assert.strictEqual(usage.input_tokens, 21);                  // fresh = prompt - cached
	assert.strictEqual(usage.cache_read_input_tokens, 10318);
	assert.strictEqual(usage.output_tokens, 60);
});

test('splitOutCachedTokens: leaves values untouched when no cached_tokens detail', () => {
	const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 };
	const ev = { usage: { prompt_tokens: 100, completion_tokens: 12 } };
	O.splitOutCachedTokens(usage, ev);
	assert.strictEqual(usage.input_tokens, 100);
	assert.strictEqual(usage.cache_read_input_tokens, 0);
	assert.strictEqual(usage.output_tokens, 12);
});

test('splitOutCachedTokens: zero cached_tokens does not subtract', () => {
	const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 };
	const ev = { usage: { prompt_tokens: 2500, completion_tokens: 30, prompt_tokens_details: { cached_tokens: 0 } } };
	O.splitOutCachedTokens(usage, ev);
	assert.strictEqual(usage.input_tokens, 2500);
	assert.strictEqual(usage.cache_read_input_tokens, 0);
});

// ---- Anthropic-family gating for OpenRouter explicit caching ----

test('isAnthropicFamily: identifies Claude upstreams on OpenRouter, IDs only Anthropic routes', () => {
	for (const id of ['claude-opus-4-8', 'anthropic/claude-sonnet-4-6', 'claude-sonnet-4-6']) {
		assert.strictEqual(O.isAnthropicFamily(id), true, id);
	}
	for (const id of ['openai/gpt-4o', 'deepseek/deepseek-chat', 'gpt-4o', 'moonshotai/kimi-k2.7-code', '']) {
		assert.strictEqual(O.isAnthropicFamily(id), false, id);
	}
});

// ---- End-to-end: Anthropic-family OpenRouter message shape carries cache_control ----

test('toOpenAIMessages(cache:true) yields the two-breakpoint OpenRouter shape', () => {
	const out = T.toOpenAIMessages('SYS', [{ role: 'user', content: 'hello' }, { role: 'assistant', content: 'hi' }], { cache: true });
	assert.strictEqual(out[0].role, 'system');
	assert.ok(Array.isArray(out[0].content));
	assert.deepStrictEqual(out[0].content[0].cache_control, { type: 'ephemeral' });
	const last = out[out.length - 1];
	assert.strictEqual(last.role, 'assistant');
	assert.ok(Array.isArray(last.content));
	assert.deepStrictEqual(last.content[last.content.length - 1].cache_control, { type: 'ephemeral' });
});

test('toOpenAIMessages(cache:false) keeps legacy string shape for non-Claude upstreams', () => {
	const out = T.toOpenAIMessages('SYS', [{ role: 'user', content: 'hello' }, { role: 'assistant', content: 'hi' }], { cache: false });
	assert.strictEqual(out[0].content, 'SYS');
	assert.strictEqual(out[out.length - 1].content, 'hi');
});

test('cache write is gated: only Anthropic-family should produce cache_control blocks', () => {
	const model = 'openai/gpt-4o';
	const out = T.toOpenAIMessages('SYS', [{ role: 'user', content: 'hello' }], { cache: O.isAnthropicFamily(model) });
	assert.strictEqual(out[0].content, 'SYS');   // cache:false → no block form, no cache_control
});

console.log('\npromptCaching: ' + n + ' tests passed.');
