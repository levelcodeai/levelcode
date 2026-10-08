/*---------------------------------------------------------------------------------------------
 *  The diagram eval harness — run: node test/diagramEval.test.js
 *
 *  docs/RICH-DIAGRAMS.md, "Telemetry and evaluation": "For each registry model, 30 prompts that should
 *  produce a diagram and 10 that should not, scored on format choice, first-pass validity, node count
 *  and title quality. Models below the bar get the fallback."
 *
 *  scripts/diagram-eval.js is that eval. It decides whether a model is given the tool, and a --run
 *  spends money, so two things are pinned here: the SCORE is right (a scripted model whose mistakes
 *  are known, run through the real agent loop, must come out at exactly the numbers its script
 *  implies), and NOTHING IS SENT unless --run, a model and a key were all given.
 *
 *  No network: every model here is a script.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ev = require('../scripts/diagram-eval');
const providers = require('../providers/index');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'diagram-eval.js');
const prompts = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'diagrams', 'eval-prompts.json'), 'utf8')).prompts;

let n = 0;
function test(name, fn) { fn(); n++; console.log('  ok - ' + name); }
async function testAsync(name, fn) { await fn(); n++; console.log('  ok - ' + name); }

const good = (p) => ({ title: 'A request is checked once, then served', nodes: [{ id: 'a', label: 'Client' }, { id: 'b', label: 'Gate', accent: true }, { id: 'c', label: 'Service' }], edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'c', label: p.id.slice(0, 12) }] });
const draws = (id, input) => ({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name: 'render_diagram', input }], usage: { input_tokens: 10, output_tokens: 10 } });
const says = (text) => ({ stop_reason: 'end_turn', content: [{ type: 'text', text }], usage: { input_tokens: 10, output_tokens: 10 } });
/** A model that does everything right: draws once when it should, answers in a sentence otherwise. */
const perfect = () => { const seen = new Set(); return async (opts, p) => { if (p.expect === 'draw' && !seen.has(p.id)) { seen.add(p.id); return draws('t_' + p.id, good(p)); } return says('Done: that is the answer.'); }; };
const plan = (args, env) => ev.plan(args, env || {}, providers.getProvider);

(async () => {
	try {
		test('the prompt set is the one the spec asks for: 30 that should draw, 10 that should not', () => {
			assert.strictEqual(prompts.filter((p) => p.expect === 'draw').length, 30);
			assert.strictEqual(prompts.filter((p) => p.expect === 'none').length, 10);
			assert.strictEqual(new Set(prompts.map((p) => p.id)).size, 40, 'ids are unique');
			assert.strictEqual(new Set(prompts.map((p) => p.text)).size, 40, 'so are the prompts');
			for (const p of prompts) { assert.ok(/^[a-z0-9-]+$/.test(p.id) && p.text.length > 15, p.id); }
			// a prompt that SAYS "diagram" tests obedience, not judgement — the set should be mostly the other kind
			const told = prompts.filter((p) => p.expect === 'draw' && /\b(diagram|draw)\b/i.test(p.text)).length;
			assert.ok(told <= 3, told + ' of the 30 ask for a diagram by name');
		});

		test('NOTHING IS SENT without --run, a model and a key', () => {
			assert.strictEqual(plan([]).mode, 'usage');
			assert.strictEqual(plan(['--model', 'x/y'], { OPENROUTER_API_KEY: 'k' }).mode, 'usage', 'a model and a key, but no --run');
			assert.strictEqual(plan(['--run'], { OPENROUTER_API_KEY: 'k' }).mode, 'usage', 'no model');
			assert.strictEqual(plan(['--run', '--model'], { OPENROUTER_API_KEY: 'k' }).mode, 'usage');
			assert.strictEqual(plan(['--run', '--model', '--json'], { OPENROUTER_API_KEY: 'k' }).mode, 'usage', 'a flag is not a model id');
			assert.match(plan(['--run', '--model', 'x/y'], {}).problem, /No API key: set DIAGRAM_EVAL_KEY or OPENROUTER_API_KEY/);
			assert.match(plan(['--run', '--model', 'x', '--provider', 'claude'], { OPENROUTER_API_KEY: 'k' }).problem, /ANTHROPIC_API_KEY/, 'another provider\'s key is not borrowed');
			assert.match(plan(['--run', '--model', 'x', '--provider', 'nope'], { DIAGRAM_EVAL_KEY: 'k' }).problem, /Unknown provider "nope"/);
			assert.match(plan(['--run', '--model', 'x', '--provider', 'custom'], { DIAGRAM_EVAL_KEY: 'k' }).problem, /set DIAGRAM_EVAL_BASE/);
			assert.strictEqual(plan(['--run', '--dry-run', '--model', 'x'], { DIAGRAM_EVAL_KEY: 'k' }).mode, 'usage', 'both at once is a mistake, not a run');
			for (const bad of ['0', '-3', '2.5', 'ten']) { assert.strictEqual(plan(['--dry-run', '--limit', bad]).mode, 'usage', '--limit ' + bad); }
		});

		test('a complete command line is a run, on the provider and key it names', () => {
			assert.deepStrictEqual(plan(['--run', '--model', 'x/y'], { OPENROUTER_API_KEY: 'k1' }), { mode: 'run', model: 'x/y', providerId: 'openrouter', apiKey: 'k1', baseURL: undefined, limit: null, json: null });
			assert.strictEqual(plan(['--run', '--model', 'x/y'], { OPENROUTER_API_KEY: 'k1', DIAGRAM_EVAL_KEY: 'k2' }).apiKey, 'k2', 'the eval\'s own variable wins');
			const c = plan(['--run', '--model', 'm', '--provider', 'claude', '--limit', '8', '--json', 'out.json'], { ANTHROPIC_API_KEY: 'k3' });
			assert.deepStrictEqual([c.providerId, c.apiKey, c.limit, c.json], ['claude', 'k3', 8, 'out.json']);
			assert.strictEqual(plan(['--run', '--model', 'llama', '--provider', 'ollama'], {}).mode, 'run', 'a local provider needs no key');
			assert.strictEqual(plan(['--run', '--model', 'm', '--provider', 'custom'], { DIAGRAM_EVAL_KEY: 'k', DIAGRAM_EVAL_BASE: 'http://localhost:9/v1' }).baseURL, 'http://localhost:9/v1');
			assert.deepStrictEqual(plan(['--dry-run']), { mode: 'dry', limit: null });
		});

		test('a trial run keeps the mix: three that should draw for each one that should not', () => {
			const eight = ev.sample(prompts, 8);
			assert.deepStrictEqual(eight.map((p) => p.expect), ['draw', 'draw', 'draw', 'none', 'draw', 'draw', 'draw', 'none']);
			assert.strictEqual(ev.sample(prompts, null).length, 40);
			assert.strictEqual(ev.sample(prompts, 400).length, 40);
			assert.strictEqual(new Set(ev.sample(prompts, 39).map((p) => p.id)).size, 39, 'never the same prompt twice');
		});

		await testAsync('THE SCORE: a scripted model with known mistakes comes out at exactly the numbers its script implies', async () => {
			const r = await ev.evaluate({ prompts, model: 'scripted', turn: ev.scriptedModel() });
			// 30 drawings: 26 clean (one of them with a topic for a title), 2 the editor fixed alone (a long
			// label, a shape synonym), 1 the model put right on its repair pass, 1 still wrong → degraded.
			assert.strictEqual(r.firstPassValid, 86.7);
			assert.strictEqual(r.autoFixed, 6.7);
			assert.strictEqual(r.modelRepaired, 3.3);
			assert.strictEqual(r.degraded, 3.3);
			assert.deepStrictEqual(r.topErrors, [{ cls: 'accent-count', count: 2 }, { cls: 'unknown-node', count: 1 }]);
			// 10 that should not draw: 9 answered in prose, 1 drew a box out of characters
			assert.strictEqual(r.drewWhenItShould, 100);
			assert.strictEqual(r.quietWhenItShould, 90);
			assert.strictEqual(r.formatChoice, 97.5);
			assert.strictEqual(r.asciiLeaks, 1);
			assert.deepStrictEqual(r.rows.filter((x) => !x.formatOk).map((x) => x.id), ['http-409']);
			assert.strictEqual(r.titlesThatAreTopics, 3.3, 'one title of thirty names a topic');
			// the cost: 30 × (draw + answer) + 2 second attempts + 10 answers
			assert.strictEqual(r.modelTurns, 72);
			assert.strictEqual(r.rows.find((x) => x.id === 'dead-letter').turns, 3);
			assert.deepStrictEqual([r.rows.find((x) => x.id === 'dead-letter').firstAttempt, r.rows.find((x) => x.id === 'dead-letter').verdict], ['bounced', 'repaired']);
			assert.strictEqual(r.rows.find((x) => x.id === 'k8s-objects').verdict, 'degraded');
			assert.strictEqual(r.meetsBar, false);
			assert.strictEqual(r.misses.length, 3, r.misses.join(' | '));
		});

		await testAsync('a model that does everything right meets the bar', async () => {
			const r = await ev.evaluate({ prompts, model: 'perfect', turn: perfect() });
			assert.deepStrictEqual([r.formatChoice, r.firstPassValid, r.degraded, r.asciiLeaks, r.errors], [100, 100, 0, 0, 0]);
			assert.deepStrictEqual(r.misses, []);
			assert.strictEqual(r.meetsBar, true);
			assert.strictEqual(r.modelTurns, 70);
			assert.strictEqual(r.titlesThatAreTopics, 0);
		});

		await testAsync('a model that never draws is below the bar — "no diagrams, so none invalid" is not a pass', async () => {
			const r = await ev.evaluate({ prompts, model: 'prose-only', turn: async () => says('Done: here it is in words.') });
			assert.strictEqual(r.drewWhenItShould, 0);
			assert.strictEqual(r.quietWhenItShould, 100);
			assert.strictEqual(r.formatChoice, 25);
			assert.strictEqual(r.firstPassValid, null, 'no verdicts, so no rate');
			assert.strictEqual(r.meetsBar, false);
			assert.ok(r.misses.some((m) => /first-pass valid/.test(m)) && r.misses.some((m) => /format choice 25%/.test(m)), r.misses.join(' | '));
		});

		await testAsync('a model that draws for everything fails on format choice alone', async () => {
			const seen = new Set();
			const r = await ev.evaluate({ prompts, model: 'draws-always', turn: async (opts, p) => { if (!seen.has(p.id)) { seen.add(p.id); return draws('t_' + p.id, good(p)); } return says('Done.'); } });
			assert.deepStrictEqual([r.drewWhenItShould, r.quietWhenItShould, r.formatChoice, r.firstPassValid], [100, 0, 75, 100]);
			assert.deepStrictEqual(r.misses, ['format choice 75% (bar: 90%)']);
		});

		await testAsync('a spec over the node limit is counted as asking for too much, whatever is drawn in the end', async () => {
			const big = (p) => { const s = good(p); for (let i = 0; i < 12; i++) { s.nodes.push({ id: 'x' + i, label: 'Extra ' + i }); } return s; };
			const tries = new Map();
			const r = await ev.evaluate({ prompts: prompts.slice(0, 2), model: 'sprawling', turn: async (opts, p) => { const k = (tries.get(p.id) || 0) + 1; tries.set(p.id, k); return k === 1 ? draws('t1_' + p.id, big(p)) : k === 2 ? draws('t2_' + p.id, good(p)) : says('Done.'); } });
			assert.strictEqual(r.overLimit, 2);
			assert.strictEqual(r.largest, 3, 'the redraw is what is on screen');
			assert.strictEqual(r.modelRepaired, 100);
			assert.deepStrictEqual(r.topErrors, [{ cls: 'count', count: 2 }]);
		});

		await testAsync('a call that puts no picture on screen is not a drawing', async () => {
			// nothing drawable, twice: the user is shown the source and the error, not a diagram
			const tries = new Map();
			const r = await ev.evaluate({ prompts: prompts.slice(0, 1), model: 'empty-handed', turn: async (opts, p) => { const k = (tries.get(p.id) || 0) + 1; tries.set(p.id, k); return k <= 2 ? draws('t' + k, { title: 'Nothing to see' }) : says('Done.'); } });
			assert.deepStrictEqual([r.rows[0].firstAttempt, r.rows[0].verdict, r.rows[0].drew, r.rows[0].formatOk], ['bounced', 'failed', false, false]);
			assert.strictEqual(r.drewWhenItShould, 0);
			assert.strictEqual(r.degraded, 100, 'and it counts against the degraded rate');
		});

		await testAsync('a provider error is reported per prompt, the run goes on, and the result is not called a pass', async () => {
			const inner = perfect();
			const r = await ev.evaluate({ prompts: prompts.slice(0, 4), model: 'flaky', turn: async (opts, p) => { if (p.id === prompts[1].id) { throw new Error('HTTP 429: rate limited'); } return inner(opts, p); } });
			assert.strictEqual(r.errors, 1);
			assert.match(r.rows[1].error, /429/);
			assert.strictEqual(r.rows[2].drew, true, 'the prompt after the failure still ran');
			assert.strictEqual(r.meetsBar, false);
			assert.ok(r.misses.some((m) => /ended in an error — the run is incomplete/.test(m)));
		});

		await testAsync('a prompt that hangs is stopped, and counted as an error rather than as "did not draw"', async () => {
			const r = await ev.evaluate({ prompts: prompts.slice(0, 1), model: 'stuck', timeoutMs: 40, turn: (opts) => new Promise((resolve, reject) => { opts.signal.addEventListener('abort', () => reject(new Error('aborted'))); }) });
			assert.strictEqual(r.rows[0].error, 'timed out');
			assert.strictEqual(r.errors, 1);
		});

		await testAsync('the eval gives the model the same tool and rules the editor does, and can run nothing', async () => {
			let sent = null;
			await ev.evaluate({ prompts: prompts.slice(0, 1), model: 'peek', turn: async (opts) => { sent = sent || opts; return says('Done.'); } });
			assert.ok(sent.tools.some((t) => t.name === 'render_diagram'), 'the tool is offered');
			assert.ok(String(sent.system).includes(require('../diagram/tool').PROMPT), 'with the shipped prompt block, not a copy of it');
			assert.strictEqual(sent.messages[0].content, prompts[0].text, 'and the prompt is sent as written, with no coaching added');
			// a model that asks to run a command or write a file is told no — the eval approves nothing
			const mark = path.join(os.tmpdir(), 'lc-eval-ran-' + process.pid);
			const told = [];
			let step = 0;
			const r = await ev.evaluate({
				prompts: prompts.slice(0, 1), model: 'runs-things', turn: async (opts) => {
					step++;
					if (step === 1) { return { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name: 'run_command', input: { command: 'touch ' + mark } }, { type: 'tool_use', id: 't2', name: 'write_file', input: { path: 'x.txt', content: 'hi' } }], usage: {} }; }
					told.push(opts.messages[opts.messages.length - 1].content);
					return says('Done.');
				}
			});
			assert.strictEqual(r.rows[0].turns, 2);
			assert.strictEqual(fs.existsSync(mark), false, 'the command did not run');
			assert.match(told[0][0].content, /^User skipped this command/);
			assert.match(told[0][1].content, /^ERROR: could not write x\.txt/);
		});

		await testAsync('the provider seam is put back afterwards', async () => {
			const before = providers.streamAgentTurn;
			await ev.evaluate({ prompts: prompts.slice(0, 1), model: 'x', turn: async () => says('Done.') });
			assert.strictEqual(providers.streamAgentTurn, before);
			await ev.evaluate({ prompts: prompts.slice(0, 1), model: 'x', turn: async () => { throw new Error('boom'); } });
			assert.strictEqual(providers.streamAgentTurn, before, 'also when a prompt failed');
		});

		test('title quality: a topic is told from a takeaway', () => {
			for (const t of ['Steering', 'Checkout flow', 'Request lifecycle', 'OAuth 2.0 PKCE authorization flow', 'System architecture overview', 'Kubernetes objects', 'The agent loop', 'Two-phase commit']) { assert.strictEqual(ev.looksLikeTopic(t), true, t); }
			for (const t of ['Every steer has two routes into the run', 'Jev classifies; your code decides the action', 'A miss fills the cache on the way back', 'Traffic switches at the router, not the servers']) { assert.strictEqual(ev.looksLikeTopic(t), false, t); }
		});

		test('THE COMMAND LINE: a dry run finishes with the network refused; a bare call and a keyless --run exit 2 having sent nothing', () => {
			// Every way out of the process is replaced by something that fails loudly.
			const guard = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lc-eval-guard-')), 'nonet.js');
			fs.writeFileSync(guard, [
				"const die = (what) => { process.stderr.write('NETWORK USED: ' + what + '\\n'); process.exit(97); };",
				"globalThis.fetch = () => die('fetch');",
				"const net = require('net'); net.Socket.prototype.connect = function () { die('net.connect'); };",
				"const dns = require('dns'); dns.lookup = () => die('dns.lookup');",
				"for (const m of ['http', 'https']) { const mod = require(m); mod.request = () => die(m + '.request'); mod.get = () => die(m + '.get'); }"
			].join('\n'));
			const env = Object.assign({}, process.env);
			for (const k of Object.keys(env)) { if (/_API_KEY$|^DIAGRAM_EVAL_/.test(k)) { delete env[k]; } }
			const run = (args) => spawnSync(process.execPath, ['-r', guard, SCRIPT].concat(args), { env, encoding: 'utf8' });
			try {
				const dry = run(['--dry-run']);
				assert.strictEqual(dry.status, 0, dry.stderr);
				assert.match(dry.stdout, /40 prompts, 72 model turns/);
				assert.match(dry.stdout, /Dry run: a scripted model, no network/);
				assert.ok(!/NETWORK USED/.test(dry.stderr));
				const bare = run([]);
				assert.strictEqual(bare.status, 2);
				assert.match(bare.stderr, /--run makes billed calls on your key/);
				const keyless = run(['--run', '--model', 'some/model']);
				assert.strictEqual(keyless.status, 2);
				assert.match(keyless.stderr, /No API key/);
				assert.ok(!/NETWORK USED/.test(keyless.stderr + bare.stderr));
				// and the guard itself works — a real --run against it is stopped at the first request
				const live = spawnSync(process.execPath, ['-r', guard, SCRIPT, '--run', '--model', 'some/model', '--limit', '1'], { env: Object.assign({}, env, { DIAGRAM_EVAL_KEY: 'not-a-key' }), encoding: 'utf8' });
				assert.strictEqual(live.status, 97, 'the guard should have fired: ' + live.stdout + live.stderr);
				assert.match(live.stdout, /About to run 1 prompts on openrouter \/ some\/model — up to 6 billed model turns on your key\./, 'the plan is printed before the first call');
			} finally {
				try { fs.rmSync(path.dirname(guard), { recursive: true, force: true }); } catch (e) { /* temp dir */ }
			}
		});

		console.log('diagramEval: ' + n + ' tests passed');
	} catch (e) {
		console.error(e);
		process.exitCode = 1;
	}
})();
