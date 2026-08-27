/*---------------------------------------------------------------------------------------------
 *  The run's context is announced when it CHANGES, not every turn.
 *  run: node test/contextAnnounce.test.js
 *
 *  Source-extraction: agent.js requires `vscode`, so the rule is pinned against the source rather
 *  than by running runAgent.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const agent = fs.readFileSync(path.join(__dirname, '..', 'agent.js'), 'utf8');
const ext = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');

let n = 0;
function test(name, fn) { fn(); n++; console.log('  ok - ' + name); }

test('COLLECTED, not posted: nothing is announced until the whole picture is known', () => {
	// The MCP part of the picture is not known until setupMcp has run, so posting rules and memory
	// before it would make the decision on incomplete information.
	assert.match(agent, /const contextChips = \[\]/, 'the context chips must be collected');
	assert.match(agent, /contextChips\.push\(\{ type: 'agentTool', icon: 'file', text: '📋 project rules/,
		'rules must be collected, not posted directly');
	assert.match(agent, /contextChips\.push\(\{ type: 'agentTool', icon: 'history', text: '🧠 project memory/,
		'memory must be collected, not posted directly');
	assert.match(agent, /if \(mcp\.announce\) \{ contextChips\.push\(mcp\.announce\); \}/,
		'the MCP line must join the same decision');
	assert.match(agent, /built\.announce = \{/, 'setupMcp must hand its line back rather than post it');
});

test('SIGNATURE, not a flag: the announcement returns the moment anything moves', () => {
	// A boolean would go quiet forever after the first run — a server dropping out, a rules file
	// appearing, or memory arriving for the first time would all pass unmentioned.
	assert.match(agent, /let lastContextSig = ''/, 'the memo must hold a signature');
	assert.match(agent, /const sig = contextChips\.map\(\(c\) => c\.text\)\.join\('\|'\)/,
		'the signature must be built from what would actually be shown');
	assert.match(agent, /if \(sig && sig !== lastContextSig\)/, 'and compared before announcing');
	assert.ok(!/let announcedContext = (true|false)/.test(agent), 'a boolean memo is the bug this avoids');
});

test('FAILURES are news every time', () => {
	// A server that broke must not be suppressed by a signature that happens to match.
	const setup = agent.slice(agent.indexOf('async function setupMcp'), agent.indexOf('async function runAgent'));
	for (const failing of ['setup failed', 'failed to start']) {
		const at = setup.indexOf(failing);
		assert.ok(at > 0, 'expected a failure path mentioning: ' + failing);
		const line = setup.slice(setup.lastIndexOf('\n', at), setup.indexOf('\n', at));
		assert.match(line, /ctx\.post\(/, 'a failure must post immediately, not be collected: ' + failing);
	}
});

test('A NEW CHAT hears it again', () => {
	// The suppression is about repetition WITHIN a conversation. A fresh conversation is a fresh
	// slate and the context is news again.
	assert.match(agent, /function resetContextAnnounce\(\) \{ lastContextSig = ''; \}/, 'no reset');
	assert.match(agent, /module\.exports = \{ resetContextAnnounce,/, 'the reset must be exported');
	assert.match(ext, /const \{ runAgent, resetContextAnnounce \} = require\('\.\/agent'\)/, 'and imported');
	const reset = ext.slice(ext.indexOf('function resetConversationState'), ext.indexOf('function resetConversationState') + 900);
	assert.match(reset, /resetContextAnnounce\(\)/, 'a conversation teardown must clear the memo');
});

test('EMPTY context does not pin the memo shut', () => {
	// A run with no rules, no memory and no MCP must not leave a stale signature that suppresses the
	// announcement once those things DO appear.
	assert.match(agent, /\} else if \(!sig\) \{[\s\S]{0,120}lastContextSig = ''/,
		'an empty picture must clear the memo, not keep the last one');
});

console.log('\ncontextAnnounce: ' + n + ' tests passed.');
