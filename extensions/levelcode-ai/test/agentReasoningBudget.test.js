/*---------------------------------------------------------------------------------------------
 *  A reasoning model gets the whole per-turn output ceiling, and its effort — run: node test/agentReasoningBudget.test.js
 *
 *  Gemini 4 Argon reasons on every turn, and its reasoning comes out of the same max_tokens as the answer.
 *  At the 8,192 default a hard turn could spend it all thinking and stop with nothing said. A model whose
 *  caps say it reasons now asks for 32,768 (the ceiling, and the LevelCode gateway's own limit for a paid
 *  request), and a model whose row names an effort sends it. Everything else keeps the user's setting.
 *
 *  This drives the real agent loop with a stand-in for the provider and reads what each turn asked for.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-reasoning-budget-'));
const vscodeMock = { workspace: { workspaceFolders: [{ uri: { fsPath: root }, name: 'app' }] } };
const origLoad = Module._load;
// @ts-ignore
Module._load = function (request, parent, isMain) {
	if (request === 'vscode') { return vscodeMock; }
	return origLoad.call(this, request, parent, isMain);
};
const providers = require('../providers/index');
/** @type {any[]} */
const asked = [];
providers.streamAgentTurn = async (o) => {
	asked.push({ model: o.model, maxTokens: o.maxTokens, reasoningEffort: o.reasoningEffort });
	return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Done: nothing to change.' }] };
};
const { runAgent } = require('../agent');

let n = 0;
async function test(name, fn) { await fn(); n++; console.log('  ok - ' + name); }

/** One single-turn run on `model` with the user's `maxTokens` setting; returns what that turn asked for. */
async function turnFor(model, maxTokens) {
	asked.length = 0;
	await runAgent({
		providerId: 'openrouter', model, maxTokens, messages: [{ role: 'user', content: 'go' }], maxSteps: 2,
		post() {}, dbg() {}, approve: async () => true, commandRuns: new Map(), commandStops: new Map(), signal: new AbortController().signal,
	});
	assert.strictEqual(asked.length, 1, 'one turn');
	return asked[0];
}

(async () => {
	try {
		await test('Gemini 4 Argon through OpenRouter or the gateway: 32,768 per turn and medium effort', async () => {
			assert.deepStrictEqual(await turnFor('google/gemini-4-argon', 8192), { model: 'google/gemini-4-argon', maxTokens: 32768, reasoningEffort: 'medium' });
		});
		await test('the bare Argon id also gets the ceiling, but asks for no effort', async () => {
			const t = await turnFor('gemini-4-argon', 8192);
			assert.strictEqual(t.maxTokens, 32768);
			assert.strictEqual(t.reasoningEffort, null);
		});
		await test('other reasoning models get the ceiling too (their reasoning shares the budget the same way)', async () => {
			assert.strictEqual((await turnFor('moonshotai/kimi-k3', 8192)).maxTokens, 32768);
			assert.strictEqual((await turnFor('o3-mini', 4096)).maxTokens, 32768);
		});
		await test('a model that does not reason keeps the user\'s setting, its clamp, and sends no effort', async () => {
			assert.deepStrictEqual(await turnFor('moonshotai/kimi-k2.7-code', 8192), { model: 'moonshotai/kimi-k2.7-code', maxTokens: 8192, reasoningEffort: null });
			assert.strictEqual((await turnFor('moonshotai/kimi-k2.7-code', 100000)).maxTokens, 32768, 'still clamped to 32,768');
			assert.strictEqual((await turnFor('moonshotai/kimi-k2.7-code', 10)).maxTokens, 1024, 'still at least 1,024');
			assert.strictEqual((await turnFor('anthropic/claude-opus-5', 0)).maxTokens, 8192, 'the default when nothing is set');
		});
		console.log('\nagentReasoningBudget: ' + n + ' tests passed.');
	} finally {
		Module._load = origLoad;
		fs.rmSync(root, { recursive: true, force: true });
	}
})().catch((e) => { console.error(e); process.exit(1); });
