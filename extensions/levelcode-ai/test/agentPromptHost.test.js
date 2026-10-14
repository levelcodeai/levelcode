/*---------------------------------------------------------------------------------------------
 *  The prompt a run sends is the HOST's prompt, with or without a skills menu — run: node test/agentPromptHost.test.js
 *
 *  runAgent built its system prompt as (ctx.skills ? buildSystem(menu) : SYSTEM_BASE). buildSystem answers a run
 *  with no menu with the host's base prompt, but the fallback bypassed it and sent SYSTEM_BASE: in the browser
 *  build, with levelcode.ai.skills.enabled off, the model was told about run_command, background:true and
 *  "EVERY run_command" while run_command itself was withheld.
 *
 *  Real runAgent with the browser flag, `vscode` and the provider replaced (the harness of agentRunCommand.test.js).
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-prompt-'));
const vscodeMock = {
	workspace: { workspaceFolders: [{ name: 'app', uri: { fsPath: root, path: root, toString: () => 'file://' + root } }], findFiles: async () => [], asRelativePath: (u) => String(u.fsPath || u) },
	env: { appRoot: '' },
	Uri: { file: (p) => ({ fsPath: p, path: p }) },
	extensions: { getExtension: () => undefined },
};
const origLoad = Module._load;
// @ts-ignore — test-only loader shim
Module._load = function (request, parent, isMain) { return request === 'vscode' ? vscodeMock : origLoad.call(this, request, parent, isMain); };
const AI = path.join(__dirname, '..');
const providers = require('../providers/index');
const turns = [];
providers.streamAgentTurn = async (o) => { turns.push({ system: o.system, tools: o.tools }); return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Done: x' }] }; };

function load(browser) {
	for (const k of Object.keys(require.cache)) { if (k.startsWith(AI + path.sep) && !k.includes(path.sep + 'test' + path.sep) && !k.includes(path.sep + 'providers' + path.sep)) { delete require.cache[k]; } }
	if (browser) { globalThis.__LEVELCODE_BROWSER_HOST__ = true; } else { delete globalThis.__LEVELCODE_BROWSER_HOST__; }
	return require('../agent');
}
const ctxFor = (over) => Object.assign({ messages: [{ role: 'user', content: 'go' }], maxSteps: 3, post: () => {}, dbg: () => {}, approve: async () => true, commandRuns: new Map(), commandStops: new Map(), signal: new AbortController().signal }, over);
const MENU = [{ name: 'code-review', description: 'review a diff' }];

let n = 0;
async function test(name, fn) { turns.length = 0; await fn(); n++; console.log('  ok - ' + name); }

(async () => {
	try {
		await test('browser, skills off: no run_command promises (this was the leak)', async () => {
			const agent = load(true);
			await agent.runAgent(ctxFor({ skills: null }));
			const { system, tools } = turns[0];
			assert.ok(!tools.some((t) => t.name === 'run_command'), 'run_command is withheld');
			// What the desktop prompt promises: a background flag, a rule about EVERY run_command, approval for commands.
			assert.ok(!/background:true|EVERY run_command|Only run_command still needs approval|run_command accepts an optional/.test(system), 'the desktop prompt leaked');
			assert.match(system, /There is no terminal/);
		});
		await test('browser, skills on: the same host prompt plus the menu', async () => {
			const agent = load(true);
			await agent.runAgent(ctxFor({ skills: { menu: () => MENU, load: async () => '' } }));
			const { system } = turns[0];
			assert.match(system, /There is no terminal/);
			assert.match(system, /Available skills \(call use_skill with the name\):\n- code-review: review a diff/);
		});
		await test('desktop, skills off: the desktop prompt, byte for byte what it was', async () => {
			const agent = load(false);
			await agent.runAgent(ctxFor({ skills: null }));
			assert.match(turns[0].system, /Commands that do NOT exit on their own \(dev servers, file watchers, tail -f\) MUST be run with run_command background:true/);
			assert.ok(!/There is no terminal/.test(turns[0].system));
		});
		console.log(`\n${n} tests passed`);
	} finally { fs.rmSync(root, { recursive: true, force: true }); }
})().catch((e) => { console.error(e); process.exit(1); });
