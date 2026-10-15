/*---------------------------------------------------------------------------------------------
 *  Compaction on a reasoning model — run: node test/compactReasoningHost.test.js
 *
 *  Compact summarizes the head of the agent's transcript on the active model, with 1,500 tokens of
 *  output. A model that always reasons (Gemini 4 Argon) thinks out of those same tokens, and could
 *  spend them all before writing a word: an empty summary, and Compact reports "empty". A reasoning
 *  model now gets 8,192 tokens and, where its row names an effort, is asked for a low one. Every other
 *  model keeps 1,500 and sends no effort.
 *
 *  compactAgentMemory is sliced out of extension.js and run with stand-ins around it.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const catalog = require('../providers/catalog');
const { findCompactionCut, estimateMsgTokens } = require('../agentMemory');

const src = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');

/** Slice a top-level `[async] function <name>(…) {…}`, skipping braces in strings and comments. */
function extract(name) {
	let start = src.indexOf('function ' + name + '(');
	assert.ok(start >= 0, 'extension.js no longer defines ' + name + '()');
	const open = src.indexOf('{', start);
	if (src.slice(start - 6, start) === 'async ') { start -= 6; }
	let depth = 0, str = '', comment = '';
	for (let i = open; i < src.length; i++) {
		const ch = src[i], next = src[i + 1];
		if (comment === 'line') { if (ch === '\n') { comment = ''; } continue; }
		if (comment === 'block') { if (ch === '*' && next === '/') { comment = ''; i++; } continue; }
		if (str) { if (ch === '\\') { i++; } else if (ch === str) { str = ''; } continue; }
		if (ch === '/' && next === '/') { comment = 'line'; i++; continue; }
		if (ch === '/' && next === '*') { comment = 'block'; i++; continue; }
		if (ch === '"' || ch === "'" || ch === '`') { str = ch; continue; }
		if (ch === '{') { depth++; }
		else if (ch === '}' && --depth === 0) { return src.slice(start, i + 1); }
	}
	throw new Error('no matching closing brace found for ' + name + '()');
}

// eslint-disable-next-line no-new-func
const makeHost = new Function('env', [
	"'use strict';",
	'const { providers, catalog, findCompactionCut, estimateMsgTokens, prepProviderRequest } = env;',
	"const COMPACT_SYSTEM = 'system', COMPACT_INSTRUCTIONS = 'Summarize:\\n';",
	'const dbg = () => {}, meterModel = () => env.model, serializeMsgForSummary = (m) => JSON.stringify(m);',
	'const authRetry = (req, fn) => fn(req);',
	'const checkpoints = [], diagrams = { stubsFor: () => [] };',
	'let abort = null, agentMessages = [], diagramsStubbed = false;',
	extract('compactAgentMemory'),
	'return { compactAgentMemory, setAgentMessages: (m) => { agentMessages = m; } };'
].join('\n'));

/** A transcript long enough to compact: alternating goals and answers. */
function transcript(len) {
	const out = [];
	for (let i = 0; i < len; i++) { out.push(i % 2 ? { role: 'assistant', content: 'answer ' + i } : { role: 'user', content: 'goal ' + i }); }
	return out;
}

let n = 0;
async function test(name, fn) { await fn(); n++; console.log('  ok - ' + name); }

/** Compact once on `model`; returns what the summary request asked for. */
async function compactOn(model) {
	/** @type {any[]} */
	const asked = [];
	const providers = { complete: async (o) => { asked.push({ model: o.model, maxTokens: o.maxTokens, reasoningEffort: o.reasoningEffort }); return 'A briefing.'; } };
	const prepProviderRequest = async () => ({ ok: true, providerId: 'openrouter', apiKey: 'k', model });
	const host = makeHost({ providers, catalog, findCompactionCut, estimateMsgTokens, prepProviderRequest, model });
	host.setAgentMessages(transcript(14));
	const r = await host.compactAgentMemory();
	assert.strictEqual(r.ok, true, 'compacted: ' + JSON.stringify(r));
	assert.strictEqual(asked.length, 1);
	return asked[0];
}

(async () => {
	await test('Gemini 4 Argon summarizes with 8,192 tokens and a low effort', async () => {
		assert.deepStrictEqual(await compactOn('google/gemini-4-argon'), { model: 'google/gemini-4-argon', maxTokens: 8192, reasoningEffort: 'low' });
	});
	await test('other reasoning models get the room, but no effort they were not checked for', async () => {
		assert.deepStrictEqual(await compactOn('o3-mini'), { model: 'o3-mini', maxTokens: 8192, reasoningEffort: null });
		assert.deepStrictEqual(await compactOn('gemini-4-argon'), { model: 'gemini-4-argon', maxTokens: 8192, reasoningEffort: null });
	});
	await test('a model that does not reason keeps 1,500 tokens and sends no effort', async () => {
		assert.deepStrictEqual(await compactOn('moonshotai/kimi-k2.7-code'), { model: 'moonshotai/kimi-k2.7-code', maxTokens: 1500, reasoningEffort: null });
		assert.deepStrictEqual(await compactOn('anthropic/claude-opus-5'), { model: 'anthropic/claude-opus-5', maxTokens: 1500, reasoningEffort: null });
	});
	console.log('\ncompactReasoningHost: ' + n + ' tests passed.');
})().catch((e) => { console.error(e); process.exit(1); });
