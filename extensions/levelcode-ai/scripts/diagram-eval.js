#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  LevelCode — the diagram eval  (docs/RICH-DIAGRAMS.md, "Telemetry and evaluation")
 *
 *  "For each registry model, 30 prompts that should produce a diagram and 10 that should not, scored
 *  on format choice, first-pass validity, node count and title quality. Models below the bar get the
 *  fallback."
 *
 *  This runs the REAL agent loop — the same system prompt, the same tool list, the same repair
 *  ladder — once per prompt in test/fixtures/diagrams/eval-prompts.json, and reports the spec's table
 *  for the model: first-pass valid rate, fix share by rung, degraded rate, top error classes, tokens
 *  per diagram, ASCII leaks — plus whether it drew when it should have and stayed quiet when it
 *  should not. The numbers come from the same counters the editor keeps (diagram/stats.js).
 *
 *  USAGE
 *    node extensions/levelcode-ai/scripts/diagram-eval.js --dry-run
 *        No network, no key. A scripted "model" drives the loop, to check the harness itself.
 *    node extensions/levelcode-ai/scripts/diagram-eval.js --run --model <id> [--provider <id>] [--limit N] [--json out.json]
 *        Calls the provider. --provider defaults to openrouter; the key is read from DIAGRAM_EVAL_KEY,
 *        else the provider's usual variable (OPENROUTER_API_KEY, ANTHROPIC_API_KEY, OPENAI_API_KEY …).
 *
 *  COST: --run makes real, billed calls on your key — up to MAX_STEPS (6) model turns per prompt, 40
 *  prompts by default (so at most 240; a model that answers directly uses about 70), each carrying the
 *  agent's full system prompt and tool list. It prints the plan and the model before the first call.
 *  Use --limit to try a few first. Nothing is sent without --run.
 *
 *  It never runs a command or edits a file: the workspace is an empty temporary folder, and every
 *  approval is answered "no".
 *
 *  EXIT: 0 the model meets the bar · 1 it does not · 2 usage or configuration error.
 *--------------------------------------------------------------------------------------------*/
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const EXT = path.join(__dirname, '..');

/** Model turns one prompt may use. Enough to look around, draw, take one repair pass and answer. */
const MAX_STEPS = 6;
/** One prompt may take this long before it is stopped and counted as an error. */
const PROMPT_TIMEOUT_MS = 180000;

/** The bar a model has to clear to be given the tool (the spec's proposed targets). */
const BAR = Object.freeze({ firstPassValid: 90, degraded: 2, formatChoice: 90, asciiLeaks: 0 });

/**
 * Does a title name a TOPIC rather than state a takeaway? The style guide's first rule is the
 * opposite ("Every steer has two routes into the run", not "Steering"). A heuristic, reported as a
 * rate — it is a signal for the prompt examples, not a gate.
 */
function looksLikeTopic(title) {
	const t = String(title || '').trim();
	const words = t.split(/\s+/).filter(Boolean);
	if (words.length <= 3) { return true; }
	return /\b(flow|diagram|architecture|overview|lifecycle|pipeline|process|structure|states?|components?|pattern)\s*$/i.test(t) && words.length <= 6;
}

/**
 * agent.js outside the editor: `vscode` becomes an empty workspace in a temporary folder. Loaded once
 * per process — the module keeps the `vscode` it was first given, so the folder has to outlive it.
 */
let host = null;
function loadAgent() {
	if (host) { return host; }
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-diagram-eval-'));
	process.on('exit', () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch (e) { /* a temp folder */ } });
	const vscodeMock = { workspace: { workspaceFolders: [{ uri: { fsPath: root }, name: 'eval' }], findFiles: async () => [], asRelativePath: (u) => String(u && u.fsPath || u) }, env: { appRoot: root } };
	const origLoad = Module._load;
	// @ts-ignore — a loader shim, for the two requires below only
	Module._load = function (request, parent, isMain) { return request === 'vscode' ? vscodeMock : origLoad.call(this, request, parent, isMain); };
	try {
		host = { providers: require(path.join(EXT, 'providers', 'index')), runAgent: require(path.join(EXT, 'agent')).runAgent, root };
	} finally {
		// @ts-ignore
		Module._load = origLoad;
	}
	return host;
}

/**
 * Run the eval.
 * @param {{ prompts: Array<{id:string, expect:'draw'|'none', text:string}>, model: string, providerId?: string, apiKey?: string, baseURL?: string,
 *           turn?: (opts:any, prompt:any) => Promise<any>, onProgress?: (row:any) => void, maxSteps?: number }} o
 *        turn: a stand-in for the provider (dry run / tests). Without it the real provider is called.
 */
async function evaluate(o) {
	const { createDiagrams } = require(path.join(EXT, 'diagram', 'service'));
	const stats = require(path.join(EXT, 'diagram', 'stats'));
	const { providers, runAgent } = loadAgent();
	const realTurn = providers.streamAgentTurn;
	let s = stats.empty(new Date().toISOString().slice(0, 10));
	const rows = [];
	let current = null, modelTurns = 0;
	// agent.js calls providers.streamAgentTurn through the module, so this is the one seam needed: it
	// counts the turns (the cost) and, in a dry run, answers them.
	providers.streamAgentTurn = async (opts) => {
		modelTurns++;
		return o.turn ? o.turn(opts, current) : realTurn(opts);
	};
	try {
		for (const p of o.prompts) {
			current = p;
			const events = [];
			const diagrams = createDiagrams({ resolveLink: () => ({ ok: false, reason: 'no workspace in the eval' }), onStat: (ev) => { events.push(ev); s = stats.record(s, ev); } });
			const posted = [];
			const before = modelTurns;
			const ac = new AbortController();
			let timedOut = false;
			const timer = setTimeout(() => { timedOut = true; ac.abort(); }, o.timeoutMs || PROMPT_TIMEOUT_MS);
			try {
				await runAgent({
					messages: [{ role: 'user', content: p.text }],
					providerId: o.providerId || 'openrouter', apiKey: o.apiKey || '', baseURL: o.baseURL, model: o.model,
					maxSteps: o.maxSteps || MAX_STEPS, maxTokens: 2048,
					post: (m) => posted.push(m), approve: async () => false, ask: async () => null,
					applyEdit: async () => false, applyDelete: async () => false,
					diagrams, client: { render: 'rich' }, signal: ac.signal
				});
			} finally { clearTimeout(timer); }
			const records = diagrams.list();
			const calls = events.filter((e) => e.type === 'call');
			const verdict = calls.map((e) => e.outcome).filter((x) => x !== 'bounced' && x !== 'truncated').pop() || null;
			const drew = records.some((r) => r.spec);
			const leaked = events.some((e) => e.type === 'answer' && e.asciiArt);
			const last = records.filter((r) => r.spec).pop();
			const error = posted.find((m) => m.type === 'agentError');
			const done = posted.filter((m) => m.type === 'agentDone').pop();
			const row = {
				id: p.id, expect: p.expect, drew, leaked,
				formatOk: p.expect === 'draw' ? drew : (!drew && !leaked),
				firstAttempt: calls.length ? calls[0].outcome : null, verdict,
				nodes: last ? last.spec.nodes.length : null,
				overLimit: calls.some((e) => e.errorClasses && e.errorClasses.count),
				title: last ? last.spec.title : null,
				titleIsTopic: last ? looksLikeTopic(last.spec.title) : null,
				turns: modelTurns - before,
				ended: done ? done.reason : null,
				error: timedOut ? 'timed out' : error ? String(error.message).slice(0, 200) : null
			};
			rows.push(row);
			if (o.onProgress) { o.onProgress(row); }
		}
	} finally {
		providers.streamAgentTurn = realTurn;
	}
	const sum = stats.summarize(s);
	const pct = (a, b) => (b ? Math.round(1000 * a / b) / 10 : null);
	const drawn = rows.filter((r) => r.drew);
	const report = {
		model: o.model, prompts: rows.length, errors: rows.filter((r) => r.error).length, modelTurns,
		formatChoice: pct(rows.filter((r) => r.formatOk).length, rows.length),
		drewWhenItShould: pct(rows.filter((r) => r.expect === 'draw' && r.drew).length, rows.filter((r) => r.expect === 'draw').length),
		quietWhenItShould: pct(rows.filter((r) => r.expect === 'none' && !r.drew && !r.leaked).length, rows.filter((r) => r.expect === 'none').length),
		firstPassValid: sum.overall.firstPassValid, autoFixed: sum.overall.autoFixed, modelRepaired: sum.overall.modelRepaired, degraded: sum.overall.degraded,
		topErrors: sum.topErrors, tokens: sum.tokens, asciiLeaks: sum.asciiLeaks.leaks,
		overLimit: rows.filter((r) => r.overLimit).length,
		largest: drawn.reduce((a, r) => Math.max(a, r.nodes), 0),
		titlesThatAreTopics: pct(drawn.filter((r) => r.titleIsTopic).length, drawn.length),
		rows
	};
	const misses = [];
	if (report.firstPassValid === null || report.firstPassValid < BAR.firstPassValid) { misses.push('first-pass valid ' + report.firstPassValid + '% (bar: ' + BAR.firstPassValid + '%)'); }
	if (report.degraded === null || report.degraded >= BAR.degraded) { misses.push('degraded ' + report.degraded + '% (bar: under ' + BAR.degraded + '%)'); }
	if (report.formatChoice < BAR.formatChoice) { misses.push('format choice ' + report.formatChoice + '% (bar: ' + BAR.formatChoice + '%)'); }
	if (report.asciiLeaks > BAR.asciiLeaks) { misses.push(report.asciiLeaks + ' ASCII leak(s) (bar: 0)'); }
	if (report.errors) { misses.push(report.errors + ' prompt(s) ended in an error — the run is incomplete'); }
	report.misses = misses;
	report.meetsBar = misses.length === 0;
	return report;
}

/**
 * The dry run's "model": deterministic, offline. It draws for prompts that expect a drawing — cleanly
 * for most, with one of the usual mistakes for a few so every rung of the ladder is walked — and
 * answers in prose for the rest (once, wrongly, with an ASCII box).
 */
function scriptedModel() {
	const state = new Map();
	const spec = (p, flaw) => {
		const s = { title: 'The ' + p.id + ' path has three steps and one decision', nodes: [{ id: 'a', label: 'Start', shape: 'actor' }, { id: 'b', label: 'Check', shape: 'decision', accent: true }, { id: 'c', label: 'Do the work' }, { id: 'd', label: 'Done' }], edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'c', label: 'yes' }, { from: 'b', to: 'd', label: 'no' }, { from: 'c', to: 'd' }] };
		if (flaw === 'long') { s.nodes[2].label = 'Do all of the work that this step is responsible for'; }
		if (flaw === 'synonym') { s.nodes[1].shape = 'diamond'; }
		if (flaw === 'ghost') { s.edges.push({ from: 'c', to: 'nowhere' }); }
		if (flaw === 'accents') { s.nodes[2].accent = true; }
		if (flaw === 'topic') { s.title = 'Checkout flow'; }
		return s;
	};
	const FLAWS = { 'pr-states': 'long', 'ci-pipeline': 'synonym', 'dead-letter': 'ghost', 'k8s-objects': 'accents', 'three-tier': 'topic' };
	// The flaws the editor cannot fix on its own get a second attempt. How many of the two still carry
	// the flaw: one → put right on the repair pass; both → drawn degraded.
	const STILL_WRONG = { ghost: 1, accents: 2 };
	return async (opts, p) => {
		const n = (state.get(p.id) || 0) + 1; state.set(p.id, n);
		const usage = { input_tokens: 1000, output_tokens: 200 };
		if (p.expect !== 'draw') {
			const text = p.id === 'http-409' ? 'Done: it means a conflict.\n+-------+     +-------+\n| PUT a | --> |  409  |\n+-------+     +-------+' : 'Done: here is the answer in a sentence.';
			return { stop_reason: 'end_turn', content: [{ type: 'text', text }], usage };
		}
		const flaw = FLAWS[p.id];
		const twoTries = Object.prototype.hasOwnProperty.call(STILL_WRONG, flaw);
		if (n <= (twoTries ? 2 : 1)) {
			const carries = twoTries ? n <= STILL_WRONG[flaw] : true;
			return { stop_reason: 'tool_use', content: [{ type: 'text', text: 'Here it is.' }, { type: 'tool_use', id: 'toolu_' + p.id + '_' + n, name: 'render_diagram', input: spec(p, carries ? flaw : null) }], usage };
		}
		return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Done: the diagram shows the path.' }], usage };
	};
}

/**
 * The first `limit` prompts of a trial run, keeping the file's mix: three that should draw for each
 * one that should not. (The file lists the 30 first, so a plain slice would never test restraint.)
 */
function sample(prompts, limit) {
	if (!limit || limit >= prompts.length) { return prompts.slice(); }
	const draw = prompts.filter((p) => p.expect === 'draw'), none = prompts.filter((p) => p.expect !== 'draw');
	const out = [];
	while (out.length < limit && (draw.length || none.length)) {
		const wantNone = out.length % 4 === 3;
		const next = (wantNone ? none.shift() || draw.shift() : draw.shift() || none.shift());
		out.push(next);
	}
	return out;
}

function printReport(r) {
	const line = (k, v) => console.log('  ' + (k + ':').padEnd(30) + v);
	const n = (v, unit) => (v === null || v === undefined ? 'n/a' : v + (unit || ''));
	console.log('\nDiagram eval — ' + r.model + ' — ' + r.prompts + ' prompts, ' + r.modelTurns + ' model turns');
	line('format choice', n(r.formatChoice, '%') + '   (drew when it should: ' + n(r.drewWhenItShould, '%') + ', stayed quiet when it should: ' + n(r.quietWhenItShould, '%') + ')');
	line('first-pass valid', n(r.firstPassValid, '%'));
	line('fixed without a model call', n(r.autoFixed, '%'));
	line('needed the repair pass', n(r.modelRepaired, '%'));
	line('degraded or failed', n(r.degraded, '%'));
	line('top error classes', r.topErrors.length ? r.topErrors.map((e) => e.cls + ' ×' + e.count).join(', ') : 'none');
	line('tokens per diagram', r.tokens.median === null ? 'n/a' : 'median ≤ ' + r.tokens.median + ', p95 ≤ ' + r.tokens.p95);
	line('asked for too much', r.overLimit + ' prompt(s) went over a count limit; the largest drawn has ' + r.largest + ' nodes');
	line('titles that are topics', n(r.titlesThatAreTopics, '%'));
	line('ASCII leaks', String(r.asciiLeaks));
	const wrong = r.rows.filter((x) => !x.formatOk || x.error);
	if (wrong.length) {
		console.log('\n  Misjudged or failed prompts:');
		for (const x of wrong) { console.log('    ' + x.id + ' (expected ' + x.expect + '): ' + (x.error ? 'error — ' + x.error : x.drew ? 'drew a diagram' : x.leaked ? 'drew with characters' : x.ended === 'limit' ? 'ran out of turns without drawing' : 'did not draw')); }
	}
	console.log('\n' + (r.meetsBar ? '  MEETS THE BAR.' : '  BELOW THE BAR: ' + r.misses.join('; ') + '.'));
}

const USAGE = [
	'Usage:',
	'  diagram-eval.js --dry-run [--limit N]',
	'  diagram-eval.js --run --model <id> [--provider <id>] [--limit N] [--json out.json]',
	'',
	'--dry-run uses a scripted model: no network, no key.',
	'--run makes billed calls on your key: up to ' + MAX_STEPS + ' model turns per prompt.',
	'Key: DIAGRAM_EVAL_KEY, else the provider\'s own variable (OPENROUTER_API_KEY, ANTHROPIC_API_KEY, …).',
	'Base URL override (required for --provider custom): DIAGRAM_EVAL_BASE.'
].join('\n');

/** The environment variable each provider's key is conventionally kept in. */
const KEY_VARS = { openrouter: 'OPENROUTER_API_KEY', claude: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY', groq: 'GROQ_API_KEY', deepseek: 'DEEPSEEK_API_KEY', mistral: 'MISTRAL_API_KEY', xai: 'XAI_API_KEY', together: 'TOGETHER_API_KEY', fireworks: 'FIREWORKS_API_KEY' };

/**
 * Work out what a command line asks for, WITHOUT doing it. Returns { mode: 'dry' | 'run' | 'usage', … }.
 * Split from main() so the "nothing is sent without --run, a model and a key" rule can be tested.
 */
function plan(argv, env, providerOf) {
	const flag = (name) => argv.includes(name);
	const value = (name) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : undefined; };
	const limit = value('--limit') === undefined ? null : Number(value('--limit'));
	if (limit !== null && !(Number.isInteger(limit) && limit > 0)) { return { mode: 'usage', problem: '--limit takes a whole number above zero.' }; }
	if (flag('--dry-run') && flag('--run')) { return { mode: 'usage', problem: 'Pick one of --dry-run and --run.' }; }
	if (flag('--dry-run')) { return { mode: 'dry', limit }; }
	if (!flag('--run')) { return { mode: 'usage' }; }
	const model = value('--model');
	if (!model) { return { mode: 'usage', problem: '--run needs --model <id>.' }; }
	const providerId = value('--provider') || 'openrouter';
	const p = providerOf(providerId);
	if (!p) { return { mode: 'usage', problem: 'Unknown provider "' + providerId + '".' }; }
	const baseURL = env.DIAGRAM_EVAL_BASE || undefined;
	if (!p.baseURL && p.kind !== 'anthropic' && !baseURL) { return { mode: 'usage', problem: 'Provider "' + providerId + '" has no base URL of its own: set DIAGRAM_EVAL_BASE.' }; }
	const apiKey = env.DIAGRAM_EVAL_KEY || env[KEY_VARS[providerId] || ''] || '';
	if (!apiKey && !p.noKey) { return { mode: 'usage', problem: 'No API key: set DIAGRAM_EVAL_KEY' + (KEY_VARS[providerId] ? ' or ' + KEY_VARS[providerId] : '') + '.' }; }
	return { mode: 'run', model, providerId, apiKey, baseURL, limit, json: value('--json') || null };
}

async function main() {
	const all = JSON.parse(fs.readFileSync(path.join(EXT, 'test', 'fixtures', 'diagrams', 'eval-prompts.json'), 'utf8')).prompts;
	// The registry is plain data; reading it needs no editor.
	const todo = plan(process.argv.slice(2), process.env, (id) => require(path.join(EXT, 'providers', 'index')).getProvider(id));
	if (todo.mode === 'usage') {
		if (todo.problem) { console.error(todo.problem + '\n'); }
		console.error(USAGE);
		return 2;
	}
	const prompts = sample(all, todo.limit);
	if (todo.mode === 'dry') {
		const r = await evaluate({ prompts, model: 'scripted (dry run)', turn: scriptedModel() });
		printReport(r);
		console.log('\n  Dry run: a scripted model, no network. It makes the usual mistakes ON PURPOSE so every rung of\n  the repair ladder is walked — the verdict above describes the script, not a model.');
		return 0;
	}
	console.log('About to run ' + prompts.length + ' prompts on ' + todo.providerId + ' / ' + todo.model + ' — up to ' + prompts.length * MAX_STEPS + ' billed model turns on your key.');
	const r = await evaluate({
		prompts, model: todo.model, providerId: todo.providerId, apiKey: todo.apiKey, baseURL: todo.baseURL,
		onProgress: (row) => console.log('  ' + (row.error ? '!' : row.formatOk ? '✓' : '✗') + ' ' + row.id.padEnd(22) + (row.error ? 'ERROR ' + row.error : row.drew ? row.verdict + ', ' + row.nodes + ' nodes' : row.leaked ? 'ASCII art' : 'prose'))
	});
	printReport(r);
	if (!r.meetsBar) { console.log('  To withhold the tool from this model, add `diagrams: false` to its row in providers/catalog.js CAPS.'); }
	if (todo.json) { fs.writeFileSync(path.resolve(todo.json), JSON.stringify(r, null, 2)); console.log('\n  Written to ' + todo.json); }
	return r.meetsBar ? 0 : 1;
}

if (require.main === module) {
	main().then((code) => process.exit(code), (e) => { console.error(e); process.exit(2); });
}

module.exports = { evaluate, scriptedModel, looksLikeTopic, plan, sample, BAR, MAX_STEPS };
