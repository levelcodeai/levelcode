#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  LevelCode — Kimi K3 reasoning-loop spike (docs/KIMI-K3.md §3)
 *
 *  THE QUESTION: Kimi K3 is an always-on reasoning model, and LevelCode's OpenAI-compat agent path
 *  (openaiCompat.streamOpenAIAgentTurn) reads only delta.content + delta.tool_calls — it DROPS the
 *  separate reasoning field. So the stored transcript carries no reasoning, and the next turn echoes
 *  none back. `deepseek-reasoner` is `tools:false` for exactly this reason: "its tool loop needs
 *  reasoning_content round-tripping the boundary doesn't carry." K3 has NO non-reasoning variant, so if
 *  it has the same requirement, it cannot be an agent model via the naive adapter — and we must know
 *  BEFORE it's a selectable Pro pick people run agent tasks on.
 *
 *  THIS SCRIPT drives the REAL adapter, not an approximation: it calls streamOpenAIAgentTurn twice,
 *  building the second turn's transcript exactly as agent.js does (assistant tool_use block with NO
 *  reasoning, then a tool_result). If K3 rejects that second request, the loop is broken.
 *
 *  Path B routes K3 through OpenRouter (moonshotai/kimi-k3) on thin.ly's OPENROUTER_API_KEY, so that's
 *  the default target — it validates the exact production path. Override via env to test elsewhere.
 *
 *  RUN:
 *    export OPENROUTER_API_KEY=...        # from thin.ly: bundle exec rails credentials:show, or EB env
 *    node extensions/levelcode-ai/scripts/kimi-k3-spike.js
 *
 *  Optional overrides:
 *    KIMI_SPIKE_BASE   (default https://openrouter.ai/api/v1)
 *    KIMI_SPIKE_MODEL  (default moonshotai/kimi-k3)
 *    KIMI_SPIKE_KEY    (default $OPENROUTER_API_KEY)   — e.g. a direct Moonshot key + base to test Path A
 *
 *  EXIT: 0 PASS (loop survives → tools:true is safe) · 1 FAIL (reasoning round-trip required → adapter
 *  work or chat-only) · 2 config error · 3 inconclusive (429 capacity / model didn't call the tool).
 *
 *  COST: ~3 short K3 calls per run. K3 bills its hidden reasoning at the full $15/M output rate, so this
 *  is a few cents, not free. Safe to re-run.
 *--------------------------------------------------------------------------------------------*/
'use strict';

const oc = require('../providers/openaiCompat');
const translate = require('../providers/translate');
const { readLines } = require('../providers/sse');

const BASE = process.env.KIMI_SPIKE_BASE || 'https://openrouter.ai/api/v1';
const MODEL = process.env.KIMI_SPIKE_MODEL || 'moonshotai/kimi-k3';
const KEY = process.env.KIMI_SPIKE_KEY || process.env.OPENROUTER_API_KEY || '';
// OpenRouter attribution headers, matching thin.ly's OpenRouterAdapter. Harmless against other bases.
const HEADERS = { 'HTTP-Referer': 'https://levelcode.ai', 'X-Title': 'LevelCode (K3 spike)' };
const LABEL = 'K3-spike';

// The one tool. A single call round-trip is the minimal reproduction of the multi-turn boundary.
const TOOLS = [{
	name: 'add',
	description: 'Add two integers and return their sum.',
	input_schema: { type: 'object', properties: { a: { type: 'integer' }, b: { type: 'integer' } }, required: ['a', 'b'] }
}];

function hr(t) { console.log('\n' + '─'.repeat(4) + ' ' + t + ' ' + '─'.repeat(Math.max(0, 66 - t.length))); }
function die(code, msg) { console.error('\n' + msg); process.exit(code); }
function withTimeout(ms) { const ac = new AbortController(); const t = setTimeout(() => ac.abort(), ms); return { signal: ac.signal, done: () => clearTimeout(t) }; }

/**
 * STAGE 1 — raw wire probe. Confirms the PREMISE: does K3 emit reasoning as a SEPARATE field (which the
 * adapter drops), and do tool_calls stream? Inspects delta keys the adapter hides. Also flags any
 * `<think>` leaking into content (that path is already stripped in agent.js, so it's fine — just noted).
 */
async function stage1RawProbe() {
	hr('STAGE 1 — raw wire probe (what the adapter drops)');
	const body = {
		model: MODEL, stream: true, max_tokens: 512,
		messages: [{ role: 'user', content: 'Use the add tool to compute 17 + 25.' }],
		tools: translate.toOpenAITools(TOOLS),
		stream_options: { include_usage: true }
	};
	const tally = { content: 0, reasoning: 0, reasoning_content: 0, tool_calls: 0, thinkTag: false, sample: '' };
	const to = withTimeout(60000);
	try {
		const res = await fetch(BASE + '/chat/completions', {
			method: 'POST', signal: to.signal,
			headers: Object.assign({ 'content-type': 'application/json', authorization: 'Bearer ' + KEY }, HEADERS),
			body: JSON.stringify(body)
		});
		if (!res.ok) { return { ok: false, status: res.status, text: await res.text().catch(() => '') }; }
		await readLines(res, (line) => {
			const s = line.trim();
			if (!s.startsWith('data:')) { return; }
			const data = s.slice(5).trim();
			if (!data || data === '[DONE]') { return; }
			let ev; try { ev = JSON.parse(data); } catch { return; }
			const d = ev.choices && ev.choices[0] && ev.choices[0].delta;
			if (!d) { return; }
			if (typeof d.content === 'string' && d.content) { tally.content++; if (/<think\b/i.test(d.content)) { tally.thinkTag = true; } }
			if (d.reasoning != null && d.reasoning !== '') { tally.reasoning++; if (!tally.sample) { tally.sample = String(d.reasoning).slice(0, 60); } }
			if (d.reasoning_content != null && d.reasoning_content !== '') { tally.reasoning_content++; if (!tally.sample) { tally.sample = String(d.reasoning_content).slice(0, 60); } }
			if (Array.isArray(d.tool_calls) && d.tool_calls.length) { tally.tool_calls++; }
		});
		return { ok: true, tally };
	} finally {
		// Always clear the 60s timer — on a fetch throw (DNS/auth), an early !ok return, or a normal end.
		// Without this a pending timer could outlive the probe and its abort could fire spuriously.
		to.done();
	}
}

/**
 * STAGE 2 — the verdict. Faithful two-turn agent loop through the REAL adapter. Turn 2's request is
 * built exactly as agent.js builds it: the assistant's tool_use block (reasoning already dropped) then
 * a tool_result. If K3 needs its prior reasoning echoed back, this is where it 400s.
 */
async function stage2RoundTrip() {
	hr('STAGE 2 — faithful two-turn tool loop (the verdict)');
	const base = { baseURL: BASE, apiKey: KEY, headers: HEADERS, label: LABEL, model: MODEL, maxTokens: 1024, tools: TOOLS };

	// --- Turn 1: ask for a tool call.
	let messages = [{ role: 'user', content: [{ type: 'text', text: 'Use the add tool to compute 17 + 25, then reply with only the number.' }] }];
	let t1;
	const to1 = withTimeout(90000);
	try {
		t1 = await oc.streamOpenAIAgentTurn(Object.assign({}, base, {
			system: 'You are a precise assistant. When a tool is provided, call it rather than computing yourself.',
			messages, signal: to1.signal,
			onToolStart: (n) => console.log('  turn 1 → tool call: ' + n)
		}));
	} catch (e) { to1.done(); return classify('turn 1', e); } finally { to1.done(); }

	const toolUse = t1.content.find((b) => b.type === 'tool_use');
	console.log('  turn 1 stop_reason: ' + t1.stop_reason + ' · blocks: ' + t1.content.map((b) => b.type).join(',') +
		(toolUse ? ' · args: ' + JSON.stringify(toolUse.input) : ''));
	if (!toolUse) {
		return { verdict: 'INCONCLUSIVE', code: 3, why: 'Turn 1 never called the add tool, so the multi-turn boundary was not exercised. Re-run; if it persists, K3 may need a stronger tool-forcing prompt (or tool_choice).' };
	}

	// --- Build turn 2's transcript EXACTLY as agent.js does: store the assistant blocks (no reasoning —
	//     it was dropped by the adapter), then answer the tool. This is the §3 condition under test.
	const sum = Number(toolUse.input && toolUse.input.a) + Number(toolUse.input && toolUse.input.b);
	messages.push({ role: 'assistant', content: t1.content });
	messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUse.id, content: String(sum) }] });

	let answer = '';
	let t2;
	const to2 = withTimeout(90000);
	try {
		t2 = await oc.streamOpenAIAgentTurn(Object.assign({}, base, {
			system: 'You are a precise assistant. When a tool is provided, call it rather than computing yourself.',
			messages, signal: to2.signal,
			onText: (t) => { answer += t; }
		}));
	} catch (e) { to2.done(); return classify('turn 2 (the round-trip)', e); } finally { to2.done(); }

	const finalText = t2.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
	console.log('  turn 2 stop_reason: ' + t2.stop_reason + ' · answer: ' + JSON.stringify((finalText || answer).slice(0, 80)));
	// Exact numeric output, not a substring: the prompt asks for ONLY the number, so require 42 to be the
	// sole number in the answer. `/42/` would false-positive on "142", "420", or "…in 42 steps"; `^\D*42\D*$`
	// accepts "42", "42.", "= **42**" but rejects any answer containing a different digit.
	const looksRight = /^\D*42\D*$/.test((finalText || answer).trim());
	if (t2.stop_reason === 'tool_use') {
		return { verdict: 'PASS*', code: 0, why: 'Turn 2 succeeded but called a tool again instead of answering — the loop is NOT rejected by the missing reasoning (the key §3 risk is cleared). Multi-step chains work; just noting it did not stop here.' };
	}
	return looksRight
		? { verdict: 'PASS', code: 0, why: 'Turn 2 completed with the correct answer, with NO reasoning echoed back in the assistant turn. K3 does not require reasoning round-tripping → tools:true is safe.' }
		: { verdict: 'PASS?', code: 0, why: 'Turn 2 completed without error (the §3 rejection did NOT happen), but the answer was not exactly "42" — likely right but verbose. Loop mechanics are fine; eyeball the answer above.' };
}

/** Distinguish the §3 failure (400 needing reasoning) from capacity (429) and other errors. */
function classify(where, e) {
	const msg = String((e && e.message) || e);
	if (/\b429\b|rate|capacity|overloaded/i.test(msg)) {
		return { verdict: 'INCONCLUSIVE', code: 3, why: where + ' hit a 429 / capacity limit (OpenRouter flags K3 supply as tight). Not a reasoning failure — re-run later. Error: ' + msg };
	}
	if (/\b400\b/.test(msg) && /reason/i.test(msg)) {
		return { verdict: 'FAIL', code: 1, why: where + ' was REJECTED for missing reasoning — this is the deepseek-reasoner failure mode. K3 cannot be an agent model via the naive adapter. Options: teach streamOpenAIAgentTurn to capture+re-emit reasoning, or ship K3 chat-only (tools:false). Error: ' + msg };
	}
	if (/\b400\b/.test(msg)) {
		return { verdict: 'FAIL?', code: 1, why: where + ' returned a 400 (not clearly reasoning-related). Inspect before shipping tools:true. Error: ' + msg };
	}
	return { verdict: 'ERROR', code: 2, why: where + ' failed for an unrelated reason (network/auth/model id?). Error: ' + msg };
}

(async () => {
	console.log('Kimi K3 reasoning-loop spike');
	console.log('  base:  ' + BASE);
	console.log('  model: ' + MODEL);
	if (!KEY) {
		die(2, 'CONFIG ERROR: no API key.\n' +
			'  export OPENROUTER_API_KEY=...   (thin.ly: `bundle exec rails credentials:show` → openrouter_api_key, or the EB env)\n' +
			'  then re-run. To test the direct Moonshot endpoint instead:\n' +
			'  KIMI_SPIKE_BASE=https://api.moonshot.ai/v1 KIMI_SPIKE_KEY=$MOONSHOT_API_KEY node extensions/levelcode-ai/scripts/kimi-k3-spike.js');
	}

	const s1 = await stage1RawProbe();
	if (!s1.ok) {
		if (s1.status === 429) { die(3, 'STAGE 1 got 429 (capacity). Not a reasoning failure — re-run later.'); }
		die(2, 'STAGE 1 request failed: HTTP ' + s1.status + ' ' + (s1.text || '').slice(0, 300) +
			'\n(check the key, the base URL, and that "' + MODEL + '" is the exact slug).');
	}
	const t = s1.tally;
	const sep = t.reasoning || t.reasoning_content;
	console.log('  content deltas: ' + t.content + ' · reasoning: ' + t.reasoning + ' · reasoning_content: ' + t.reasoning_content + ' · tool_call deltas: ' + t.tool_calls);
	if (t.sample) { console.log('  reasoning sample: ' + JSON.stringify(t.sample) + '…'); }
	console.log('  → ' + (sep
		? 'K3 emits reasoning as a SEPARATE field the adapter drops — premise confirmed; Stage 2 tests whether that breaks the loop.'
		: 'No separate reasoning field seen this run' + (t.thinkTag ? ', but <think> appeared INLINE in content (agent.js strips that — fine).' : '. If tool_calls also 0, the prompt may not have triggered a call.')));
	if (t.thinkTag && sep) { console.log('  note: <think> ALSO appeared inline in content — agent.js strips it, so harmless.'); }

	const r = await stage2RoundTrip();

	hr('VERDICT');
	console.log('  ' + r.verdict + ' — ' + r.why);
	console.log('\n  Next: ' + (r.code === 0
		? 'keep moonshotai/kimi-k3 at tools:true (catalog.js + the thin.ly row). Safe to announce.'
		: r.code === 1
			? 'do NOT ship K3 as an agent model as-is. Set catalog.js kimi-k3 tools:false (chat-only) OR add reasoning capture to streamOpenAIAgentTurn. Update docs/KIMI-K3.md §3.'
			: 're-run — this run was inconclusive (see above). Nothing to change yet.'));
	process.exit(r.code);
})().catch((e) => die(2, 'Unexpected failure: ' + String((e && e.stack) || e)));
