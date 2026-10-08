/*---------------------------------------------------------------------------------------------
 *  The agent recognises a "Done:" line written in markdown — run: node test/agentDone.test.js
 *
 *  The bug this locks down: a FINISHED run was pushed to keep going. The loop takes a turn with no
 *  tool call for the end of the run when a line starts with "Done:", and it read the text literally —
 *  so the answer
 *
 *      **Done:** created a styled, renderable workflow diagram of how a chat message becomes a reply.
 *
 *  did not count: the `**` sits between the line start and the word. The turn then fell through to the
 *  stall check, where a "next " anywhere in the answer reads as a promise of more work, and the model
 *  was sent "Stop planning. … Make your next edit_file (or write_file) call NOW". It replied with a
 *  second "Done:", and the user watched the agent finish twice.
 *
 *  Two halves, both asserted. saysDone() is the verdict, and is called directly. That runAgent ASKS it
 *  is a separate fact — a verdict the loop does not consult fixes nothing — so the real loop runs here
 *  on scripted turns, with `vscode` and the provider replaced as agentRunCommand.test.js replaces them.
 *  No scripted turn calls a tool, so no process is started; and runAgent resolves only once the run is
 *  over, so there is nothing left to wait for when it returns.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

// ---- the outside world, replaced --------------------------------------------------------------

// vscode: one EMPTY workspace folder — no rules file and no .levelcode/mcp.json, so the run has nothing
// to load and no MCP server to start.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-done-'));
const vscodeMock = { workspace: { workspaceFolders: [{ uri: { fsPath: root }, name: 'app' }] } };

const origLoad = Module._load;
// @ts-ignore — test-only loader shim
Module._load = function (request, parent, isMain) {
	if (request === 'vscode') { return vscodeMock; }
	return origLoad.call(this, request, parent, isMain);
};

// The provider: scripted turns instead of a network call. Patched on the module object agent.js shares,
// and BEFORE agent.js loads, so it holds however agent.js chooses to import it. `asked` counts the
// turns the loop requested — one more than a finished run needs is the whole bug.
const providers = require('../providers/index');
let script = [];
let asked = 0;
providers.streamAgentTurn = async () => {
	asked++;
	const turn = script.shift();
	if (!turn) { throw new Error('the agent asked for a turn the script does not have'); }
	return turn;
};

const { runAgent, saysDone } = require('../agent');

// ---- harness ----------------------------------------------------------------------------------

let n = 0;
function test(name, fn) { fn(); n++; console.log('  ok - ' + name); }
async function testAsync(name, fn) { await fn(); n++; console.log('  ok - ' + name); }

/**
 * Run one goal to the end of the RUN. Every scripted turn is text with no tool call, which is the
 * only kind of turn the Done test and the stall check ever see.
 * @param {string[]} texts what the model says, one entry per turn it is asked for
 */
async function run(texts) {
	const posted = [], logged = [];
	script = texts.map((text) => ({ stop_reason: 'end_turn', content: [{ type: 'text', text }] }));
	asked = 0;
	const messages = [{ role: 'user', content: 'draw how a chat message becomes a reply' }];
	await runAgent({
		messages,
		maxSteps: 5,
		post: (m) => posted.push(m),
		dbg: (label, data) => logged.push({ label, data }),
		signal: new AbortController().signal
	});
	return {
		asked,
		roles: messages.map((m) => m.role),
		nudges: logged.filter((l) => l.label === 'nudge').length,
		end: posted.filter((m) => m.type === 'agentError' || m.type === 'agentDone').map((m) => m.reason || m.message)
	};
}

// The answer from the bug report. It is a Done line AND it holds a "next " — the second is what turned
// an unrecognised ending into a nudge.
const REPORTED = '**Done:** created a styled, renderable workflow diagram of how a chat message becomes a reply.\n'
	+ '\n'
	+ 'The last box reads:\n'
	+ '“Your next message updates context—not model weights”';

// A real stall: an edit announced, and no tool call to make it.
const PROMISE = 'I found the validator. Now I’ll update it to cover subdomains:';

// Another stall: a command pasted where a run_command call belonged. Its last word is the shell's own
// "done", behind a closing fence.
const PASTED_LOOP = 'Let me run this to rename them:\n'
	+ '```bash\n'
	+ 'for f in *.txt; do\n'
	+ '  mv "$f" "${f%.txt}.md"\n'
	+ 'done\n'
	+ '```';

// And a file pasted where a write_file call belonged. `_done` is a key: one mark, and nothing closes it.
const PASTED_FILE = 'Let me write config.yaml:\n'
	+ '```yaml\n'
	+ '_done: false\n'
	+ '```';

(async () => {
	try {
		// ---- 1. the verdict --------------------------------------------------------------------------

		test('VERDICT: a Done line counts, however markdown dresses it', () => {
			const done = [
				REPORTED,
				'Done: created the workflow diagram in docs/flow.html.',
				'## Done: shipped',
				'> Done: quoted',
				'- Done: in a list',
				'1. Done: numbered',
				'__Done:__ underscore',
				'`Done:` code'
			];
			for (const text of done) {
				assert.strictEqual(saysDone(text), true, 'not read as finished: ' + JSON.stringify(text));
			}
		});

		test('VERDICT: the marks may be stacked, and the emphasis may hold the word or the whole sentence', () => {
			const done = [
				// #102 review: one mark was taken off the line start, where a model may stack several.
				'> ## **Done:** quote, heading and bold',
				'- > **Done:** list, quote and bold',
				'> - Done: a quoted list item',
				// Emphasis is unwrapped as a pair, so every way of closing it has to be found.
				'**Done**: the colon outside the bold',
				'**Done: the whole sentence in bold.**',
				'_Done: the whole sentence in italics._',
				'**_Done:_** two kinds at once',
				// And the line may still sit below blank ones, indented — with marks or without.
				'The suite passes.\n\n\n\t Done: after blank lines, behind a tab and a space.',
				'The suite passes.\n\n   **Done:** indented, and in no list.'
			];
			for (const text of done) {
				assert.strictEqual(saysDone(text), true, 'not read as finished: ' + JSON.stringify(text));
			}
		});

		test('VERDICT: a lone mark belongs to a name — it is not emphasis', () => {
			// #102 review: every `_` used to be deleted, and that made a Done line of a key in a pasted file.
			// The second text is here for its later `_`: inside a word, it closes nothing.
			const names = [
				PASTED_FILE,
				'_done: bool = field(default_factory=bool)',
				'*done: x'
			];
			for (const text of names) {
				assert.strictEqual(saysDone(text), false, 'read as finished: ' + JSON.stringify(text));
			}
		});

		test('VERDICT: the word alone, or no word at all, is not a Done line', () => {
			// Stripping marks must not turn "done" somewhere in a sentence into the line the prompt asks for.
			const notDone = [
				'Not done: two tests fail',
				'The validator runs before save. It lives in app/models/link.rb.',
				PROMISE
			];
			for (const text of notDone) {
				assert.strictEqual(saysDone(text), false, 'read as finished: ' + JSON.stringify(text));
			}
		});

		test('VERDICT: an answer that simply ends in "done" still counts, as it did before', () => {
			// The second clause of the test, older than this fix: plain text whose last word is "done".
			assert.strictEqual(saysDone('The diagram is in docs/flow.html and it renders. All done.'), true);
		});

		test('VERDICT: a "done" that is code is not the model saying it', () => {
			// The shell's own keyword, closing a pasted loop — and the same keyword quoted on a turn's last
			// line. The second is why that clause reads the text as written: the marks come off to find a
			// LINE, and taken off here as well they would leave this turn ending in the word.
			assert.strictEqual(saysDone(PASTED_LOOP), false);
			assert.strictEqual(saysDone('Let me check how the loop is closed. Its last line is:\n`done`'), false);
		});

		// ---- 2. the loop asks it ---------------------------------------------------------------------

		await testAsync('LOOP: the reported answer ends the run — the model is not asked again', async () => {
			// Scripted the way the bug played out: had the loop asked again, the model's second "Done:" is
			// waiting for it. It must never be requested.
			const r = await run([REPORTED, 'Done: created the workflow diagram.']);
			assert.strictEqual(r.asked, 1, 'a finished run was asked to keep going');
			assert.strictEqual(r.nudges, 0);
			assert.deepStrictEqual(r.roles, ['user', 'assistant'], 'something was sent to the model after it had finished');
			assert.deepStrictEqual(r.end, ['done']);
		});

		await testAsync('LOOP: a promise with no tool call is still nudged', async () => {
			// The stall check is deliberately untouched, and this is the case it exists for. If the fix ever
			// reads this text as finished, the edit it announces is never made.
			const r = await run([PROMISE, 'Done: the validator covers subdomains.']);
			assert.strictEqual(r.nudges, 1, 'the stalled turn was not nudged');
			assert.deepStrictEqual(r.roles, ['user', 'assistant', 'user', 'assistant'], 'the nudge never reached the transcript');
			assert.strictEqual(r.asked, 2);
			assert.deepStrictEqual(r.end, ['done']);
		});

		await testAsync('LOOP: code pasted in a fence is still nudged, whatever word or key it holds', async () => {
			for (const pasted of [PASTED_LOOP, PASTED_FILE]) {
				const r = await run([pasted, 'Done: it is on disk now.']);
				assert.strictEqual(r.nudges, 1, 'pasted code passed for a finished run: ' + JSON.stringify(pasted));
				assert.strictEqual(r.asked, 2);
				assert.deepStrictEqual(r.end, ['done']);
			}
		});

		// ---- 3. the cost of asking -------------------------------------------------------------------

		test('SOURCE: the line test does not read on across blank lines', () => {
			// `(^|\n)\s*done` and `(^|\n)[^\S\n]*done` accept exactly the same texts. The first one reads from
			// every line start through all the blank lines below it, so its work grows with the square of
			// their number: a turn that is mostly line breaks — or mostly lines of bare marks, once those are
			// stripped — took seconds at 64,000 lines. No verdict can tell the two apart, and a clock in a
			// test is a flake; so the pattern itself is read out of the source, as agentNoWorkspace.test.js
			// reads NEEDS_ROOT.
			const src = fs.readFileSync(path.join(__dirname, '..', 'agent.js'), 'utf8');
			const m = /\/\(\^\|\\n\)(.*?)done\\s\*:\/i\.test\(plain\)/.exec(src);
			assert.ok(m, 'agent.js no longer tests for the Done line where this suite looks');
			assert.ok(!m[1].includes('\\s'), 'the line test may match whitespace across lines again: ' + m[1]);
		});
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
	console.log('\nagentDone: ' + n + ' tests passed.');
})().catch((e) => { console.error(e); process.exit(1); });
