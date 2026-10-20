/*---------------------------------------------------------------------------------------------
 *  Which settings a folder can set  —  run: node test/settingsScope.test.js
 *
 *  A setting with no "scope" is read from the open folder's .vscode/settings.json too, and the
 *  folder's value wins over the user's. Workspace Trust does not change that here: VS Code applies
 *  `restrictedConfigurations` only for an extension whose `untrustedWorkspaces.supported` is
 *  'limited', and this one says true. Measured in the real editor on 2026-10-19
 *  (scripts/folder-settings-editor-check.js): a folder turned Autopilot on, sent the chat and the
 *  user's key to its own server, and had its own verify command run after an edit, with no approval
 *  card, whether the folder was trusted or open in Restricted Mode.
 *
 *  'application' scope makes the editor ignore the folder's value, so only the user's own settings
 *  count. Default-deny: every setting is application-scoped except an explicit list of display
 *  preferences, the same list the browser edition opens (web/ai-extension/manifest.js,
 *  WORKSPACE_SETTINGS_OK). A setting added later is folder-settable only if someone puts it on
 *  that list, and the first test here fails until they do.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
const sections = Array.isArray(pkg.contributes.configuration) ? pkg.contributes.configuration : [pkg.contributes.configuration];
/** @type {Record<string, any>} */
const props = Object.assign({}, ...sections.map((s) => s.properties || {}));
const web = require('../../../web/ai-extension/manifest.js');

let n = 0;
function test(name, fn) { fn(); n++; console.log('  ok - ' + name); }

// Scopes a folder's .vscode/settings.json cannot set. 'machine' is user (or remote) settings only,
// like 'application', but kept per profile.
const USER_ONLY = new Set(['application', 'machine']);
const KNOWN_SCOPES = new Set(['application', 'machine', 'window', 'resource', 'language-overridable', 'machine-overridable']);

// Written out here on purpose: opening a setting to folders is a decision, and this is where it is made.
const FOLDER_OK = [
	'levelcode.ai.chat.autoContext', 'levelcode.ai.chat.autoContextMaxFiles', 'levelcode.ai.chat.fontSize', 'levelcode.ai.chat.groupActivity',
	'levelcode.ai.chat.maxImagesPerMessage', 'levelcode.ai.chat.proseWidth', 'levelcode.ai.chat.scopeToActiveProject', 'levelcode.ai.chat.startLocation',
	'levelcode.ai.chat.workspaceMap', 'levelcode.ai.diagrams.enabled', 'levelcode.ai.includeActiveFile',
];

test('a folder can set only the listed display preferences', () => {
	const open = Object.keys(props).filter((k) => !USER_ONLY.has(props[k].scope)).sort();
	assert.deepStrictEqual(open, FOLDER_OK, 'a setting a folder can set that is not on the list: ' + open.filter((k) => !FOLDER_OK.includes(k)).join(', '));
	for (const k of FOLDER_OK) { assert.ok(k in props, k + ' is on the list but is not a setting: stale entry'); }
});

test('every scope is one the editor knows (it reads anything else as "window", which a folder can set)', () => {
	for (const [k, def] of Object.entries(props)) {
		if (def.scope !== undefined) { assert.ok(KNOWN_SCOPES.has(def.scope), k + ' has scope ' + JSON.stringify(def.scope)); }
	}
});

test('where requests and the key go, what runs without asking, and what it may spend are user settings only', () => {
	for (const k of [
		'levelcode.cloud.endpoint', 'levelcode.cloud.apiUrl',                                       // the session token is sent here
		'levelcode.ai.provider', 'levelcode.ai.providerMode', 'levelcode.ai.baseURL', 'levelcode.ai.ollama.url',   // the key and the code are sent here
		'levelcode.ai.agent.autopilot', 'levelcode.ai.verify.enabled', 'levelcode.ai.verify.command',   // commands that run with no card
		'levelcode.ai.agent.maxSteps', 'levelcode.ai.agent.maxTokens', 'levelcode.ai.cloudModel', 'levelcode.ai.contextWindow',
		'levelcode.ai.completions.enabled', 'levelcode.ai.mcp.servers', 'levelcode.ai.mcp.toolPolicy', 'levelcode.ai.skills.enabled',
	]) {
		assert.ok(k in props, k + ' is not a setting');
		assert.strictEqual(props[k].scope, 'application', k);
	}
});

test('the desktop and the browser edition open the same settings to a folder', () => {
	assert.deepStrictEqual([...web.WORKSPACE_SETTINGS_OK].sort(), FOLDER_OK);
	const m = web.toWebManifest(pkg);
	const wsections = Array.isArray(m.contributes.configuration) ? m.contributes.configuration : [m.contributes.configuration];
	/** @type {Record<string, any>} */
	const wprops = Object.assign({}, ...wsections.map((s) => s.properties || {}));
	assert.deepStrictEqual(Object.keys(wprops).filter((k) => !USER_ONLY.has(wprops[k].scope)).sort(), FOLDER_OK);
});

console.log(`\n${n} tests passed`);
