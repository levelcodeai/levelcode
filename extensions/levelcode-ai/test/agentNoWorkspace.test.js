/*---------------------------------------------------------------------------------------------
 *  The agent runs without a folder open — run: node test/agentNoWorkspace.test.js
 *
 *  What this replaces: runAgent used to open with a blanket refusal —
 *
 *      if (!root) { post({ type: 'agentError', message: 'Open a folder first — …' }); return; }
 *
 *  written for the file tools, but placed where it failed the ENTIRE run. So with no folder open you
 *  could not ask what an error meant, could not reach a single MCP server (the GitHub server does not
 *  care whether you have a folder open), and could not ask about the file sitting in the editor in
 *  front of you. The reported case was exactly that: "Explain what the current file does" — refused,
 *  for a request that never needed a workspace.
 *
 *  The root still gates the tools that resolve a path or a cwd against it. It no longer gates the agent.
 *
 *  Asserted from SOURCE: standing up a real runAgent needs a live VS Code host and a provider, which
 *  this pure-unit suite deliberately does not stand up — the same approach agentMaxSteps.test.js takes.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const agent = fs.readFileSync(path.join(__dirname, '..', 'agent.js'), 'utf8');

let n = 0;
function test(name, fn) { fn(); n++; console.log('  ok - ' + name); }

/** The `NEEDS_ROOT` set as shipped, read out of the source rather than restated here. */
function needsRoot() {
	const m = /const NEEDS_ROOT = new Set\(\[([\s\S]*?)\]\);/.exec(agent);
	assert.ok(m, 'agent.js no longer declares NEEDS_ROOT');
	return (m[1].match(/'([a-z_]+)'/g) || []).map((s) => s.replace(/'/g, ''));
}

/** Every built-in tool name, from the TOOLS array. */
function allToolNames() {
	const start = agent.indexOf('const TOOLS = [');
	assert.ok(start > 0, 'agent.js no longer declares TOOLS');
	const block = agent.slice(start, agent.indexOf('\n];', start));
	return (block.match(/\{ name: '([a-z_]+)'/g) || []).map((s) => s.replace(/.*'([a-z_]+)'.*/, '$1'));
}

test('the blanket refusal is gone', () => {
	assert.ok(!/Open a folder first/.test(agent),
		'runAgent still refuses outright when no folder is open — that guard belongs on the tools, not the run');
	// And the root is still READ — the tools need it, and losing it would silently disable them everywhere.
	assert.match(agent, /const root = workspaceRoot\(\);\s*\n\s*ctx\.root = root;/,
		'runAgent must still resolve and carry the root, even when it is null');
});

test('the tools that need a root are withheld, and only those', () => {
	const gated = needsRoot();
	// Everything that resolves a path or a cwd. Miss one and it is offered rootless, then fails on the
	// model's first call — which is worse than not offering it, because the model retries.
	// read_command_output is in this list because run_command is: it reads the output of a background
	// command, so rootless it can only ever refer to a run that could not have started. Review caught it
	// missing — the un-gating it guards against is a plausible edit, since the tool takes no path and
	// reads as portable at a glance.
	for (const name of ['list_files', 'read_file', 'search', 'edit_file', 'write_file', 'delete_file',
		'run_command', 'read_command_output']) {
		assert.ok(gated.includes(name), name + ' resolves a workspace path but is not in NEEDS_ROOT');
	}
	// …and nothing that works fine without one. Gating these would rebuild the old refusal a tool at a
	// time: they are the entire reason a rootless run is still useful.
	for (const name of ['update_plan', 'ask_user', 'use_skill']) {
		assert.ok(!gated.includes(name), name + ' needs no workspace — gating it removes the point of the change');
	}
	// The set must name real tools, or a rename silently un-gates one.
	const known = allToolNames();
	const unknown = gated.filter((g) => !known.includes(g));
	assert.deepStrictEqual(unknown, [], 'NEEDS_ROOT names tools that no longer exist: ' + unknown.join(', '));
});

test('the portable subset is what a rootless run actually offers', () => {
	assert.match(agent, /const PORTABLE_TOOLS = TOOLS\.filter\(\(t\) => !NEEDS_ROOT\.has\(t\.name\)\)/,
		'PORTABLE_TOOLS must be derived from NEEDS_ROOT, not maintained as a second hand-written list');
	assert.match(agent, /const builtins = root \? TOOLS : PORTABLE_TOOLS;/,
		'the run no longer switches its tool list on the root');
	// Both assemblies must use it. baseTools feeds the context-usage split; if it kept the full TOOLS the
	// popover would bill the user for tools that were never sent.
	assert.match(agent, /let tools = mcp\.tools\.length \? builtins\.concat\(mcp\.tools\) : builtins;/,
		'the model is still handed the unfiltered TOOLS');
	assert.match(agent, /const baseTools = ctx\.recallSessions \? builtins\.concat\(\[RECALL_TOOL\]\) : builtins;/,
		'baseTools still counts the full TOOLS — the context popover would report tools that were not sent');
});

test('the context popover is billed for the list that was actually sent', () => {
	// Review found this one line below the baseTools fix, which is the same bug: the token estimate fell
	// back to a module constant built from the FULL tool list, so a rootless run with no MCP reported the
	// cost of eight schemas it never sent — ~1000 tokens, about two thirds of the tool budget, charged
	// against a window that never spent it. Worse than a missing feature: it is a meter reading high.
	assert.match(agent, /const PORTABLE_TOOLS_TOKENS_EST = Math\.round\(JSON\.stringify\(PORTABLE_TOOLS\)\.length \/ 4\);/,
		'no rootless token estimate — the popover reports the full tool cost for a list that was not sent');
	assert.match(agent, /const builtinsTokensEst = root \? TOOLS_TOKENS_EST : PORTABLE_TOOLS_TOKENS_EST;/,
		'the estimate no longer switches on the root');
	assert.match(agent, /const toolsTokensEst = \(mcp\.tools\.length \|\| ctx\.recallSessions\)[\s\S]{0,120}: builtinsTokensEst;/,
		'the plain path still falls back to the full-TOOLS constant');

	// The two constants must actually differ, or the guard above passes on a list that gates nothing —
	// the vacuous-pass this whole change would otherwise be measured by.
	assert.ok(/PORTABLE_TOOLS = TOOLS\.filter/.test(agent), 'PORTABLE_TOOLS is no longer a strict subset');
	const gated = needsRoot();
	assert.ok(gated.length > 0, 'NEEDS_ROOT is empty — the two estimates would be identical and this test vacuous');
});

test('MCP is unaffected by a missing root — that is half the point', () => {
	// The GitHub server, the filesystem server pointed somewhere else, anything stdio: none of them need
	// the editor to have a folder open. But they are spawned with a cwd, so a null one has to resolve to
	// something real rather than being passed through.
	assert.match(agent, /connectAll\(trusted, \{ cwd: ctx\.root \|\| os\.homedir\(\) \}\)/,
		'MCP servers are spawned with a null cwd when no folder is open');
	assert.match(agent, /^const os = require\('os'\);/m, "agent.js does not require 'os'");
	assert.ok(!/NEEDS_ROOT[\s\S]{0,400}mcp/i.test(agent.slice(agent.indexOf('const NEEDS_ROOT'), agent.indexOf('const PORTABLE_TOOLS'))),
		'MCP tools must not be filtered by NEEDS_ROOT — they are not workspace tools');
});

test('the model is told WHY the tools are missing', () => {
	// Without this it sees a tool list with no read_file and improvises: answering about files it cannot
	// see, or apologising at length for a limit it cannot name.
	const m = /const noWorkspaceNote = root[\s\S]*?;\n/.exec(agent);
	assert.ok(m, 'no rootless system-prompt note — the model gets a truncated tool list and no explanation');
	const note = m[0];
	assert.match(note, /NO FOLDER IS OPEN/, 'the note must state the condition plainly');
	assert.match(note, /MCP/, 'the note must point at what DOES still work, not only at what does not');
	assert.match(note, /Open Folder/, 'the note must tell the user the way out when the request really needs files');
	assert.match(note, /^\s*const noWorkspaceNote = root\s*\n?\s*\? ''/m,
		'the note must be empty when a folder IS open, or every normal run pays for it');

	// And it has to reach the prompt. A note that is built and never concatenated is the classic version
	// of this bug — it looks right in review and does nothing.
	assert.match(agent, /\+ multiRootNote \+ noWorkspaceNote \+ autopilotNote/,
		'noWorkspaceNote is never added to the system prompt');
});

console.log('\nagentNoWorkspace: ' + n + ' tests passed.');
