/*---------------------------------------------------------------------------------------------
 *  The browser manifest of levelcode-ai — run: node web/test/unit/manifest.test.js
 *
 *  The browser build removes what a tab cannot do. These tests keep the removal honest: nothing
 *  the browser manifest still contributes may point at a command it dropped, the welcome page may
 *  only link to commands that exist, and the desktop manifest is never modified.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..', '..');
const desktop = JSON.parse(fs.readFileSync(path.join(ROOT, 'extensions', 'levelcode-ai', 'package.json'), 'utf8'));
const web = require('../../ai-extension/manifest.js');
const scratch = JSON.parse(fs.readFileSync(path.join(ROOT, 'web', 'workspace', 'package.json'), 'utf8'));

let n = 0;
function test(name, fn) { fn(); n++; console.log('  ok - ' + name); }

const before = JSON.stringify(desktop);
const m = web.toWebManifest(desktop);

test('the desktop manifest is not modified, and the browser one has its own entry', () => {
	assert.strictEqual(JSON.stringify(desktop), before);
	assert.strictEqual(m.browser, './extension.web.js');
	assert.strictEqual(desktop.browser, undefined);
	assert.strictEqual(m.name, desktop.name);
	assert.strictEqual(m.publisher, desktop.publisher, 'the extension id (publisher.name) is what the sign-in callback names');
});

test('removed commands are gone from commands, menus, keybindings and activation events', () => {
	const mentioned = new Set();
	const c = m.contributes;
	for (const x of c.commands) { mentioned.add(x.command); }
	for (const items of Object.values(c.menus)) { for (const i of items) { mentioned.add(i.command); } }
	for (const k of c.keybindings) { mentioned.add(k.command); }
	for (const e of m.activationEvents || []) { if (e.startsWith('onCommand:')) { mentioned.add(e.slice(10)); } }
	for (const removed of web.REMOVED_COMMANDS) {
		assert.ok(!mentioned.has(removed), removed + ' is still referenced');
		assert.ok(desktop.contributes.commands.some((x) => x.command === removed), removed + ' is not a desktop command, so removing it hides nothing');
	}
});

test('every command the browser manifest binds is one it declares', () => {
	const declared = new Set(m.contributes.commands.map((x) => x.command));
	for (const items of Object.values(m.contributes.menus)) {
		for (const i of items) { assert.ok(declared.has(i.command), 'menu item for undeclared ' + i.command); }
	}
	for (const k of m.contributes.keybindings) { assert.ok(declared.has(k.command), 'keybinding for undeclared ' + k.command); }
});

test('the welcome page links only to commands that exist, here or in the editor', () => {
	const known = new Set([...m.contributes.commands.map((x) => x.command), ...scratch.contributes.commands.map((x) => x.command)]);
	const builtIn = /^workbench\./;
	const w = m.contributes.walkthroughs;
	assert.strictEqual(w.length, 1);
	for (const step of w[0].steps) {
		for (const [, cmd] of step.description.matchAll(/\]\(command:([\w.]+)\)/g)) {
			assert.ok(known.has(cmd) || builtIn.test(cmd), `${step.id} links to ${cmd}`);
		}
		for (const ev of step.completionEvents || []) {
			const cmd = ev.replace(/^onCommand:/, '');
			assert.ok(known.has(cmd) || builtIn.test(cmd), `${step.id} completes on ${cmd}`);
		}
	}
});

test('the welcome page says nothing the browser cannot do', () => {
	const text = JSON.stringify(m.contributes.walkthroughs).toLowerCase();
	for (const banned of ['hackable', 'runs commands', 'notepad++', 'keymap', 'check for updates', 'happy hacking']) {
		assert.ok(!text.includes(banned), 'the welcome page still says "' + banned + '"');
	}
});

test('settings that need a shell, a disk or a local model server are not offered', () => {
	const props = Object.assign({}, ...(Array.isArray(m.contributes.configuration) ? m.contributes.configuration : [m.contributes.configuration]).map((s) => s.properties));
	for (const removed of web.REMOVED_SETTINGS) {
		assert.ok(!(removed in props), removed + ' is still offered');
	}
	const dprops = Object.assign({}, ...(Array.isArray(desktop.contributes.configuration) ? desktop.contributes.configuration : [desktop.contributes.configuration]).map((s) => s.properties));
	for (const removed of web.REMOVED_SETTINGS) { assert.ok(removed in dprops, removed + ' is not a desktop setting: stale entry in REMOVED_SETTINGS'); }
	assert.ok('levelcode.cloud.endpoint' in props && 'levelcode.ai.providerMode' in props, 'the settings the sign-in depends on are still here');
});

test('the browser binds a key the browser lets through', () => {
	assert.ok(m.contributes.keybindings.some((k) => k.command === 'levelcode.ai.focus' && k.key === 'ctrl+alt+i' && /isWeb/.test(k.when)));
});

test('the scratch workspace extension declares what it uses', () => {
	assert.strictEqual(scratch.browser, './extension.js');
	assert.deepStrictEqual(scratch.enabledApiProposals.slice().sort(), ['fileSearchProvider', 'textSearchProvider']);
	assert.ok(scratch.activationEvents.includes('onFileSystem:levelcode-scratch'));
});

console.log(`\n${n} tests passed`);
