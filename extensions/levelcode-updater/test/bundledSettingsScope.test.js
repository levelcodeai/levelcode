/*---------------------------------------------------------------------------------------------
 *  Which settings of the OTHER bundled extensions a folder can set  —  run: node test/bundledSettingsScope.test.js
 *
 *  levelcode-ai keeps its own list (extensions/levelcode-ai/test/settingsScope.test.js). This covers
 *  every other extension LevelCode ships: levelcode-updater, levelcode-hackability (the init script)
 *  and levelcode-npp-pack. The same mechanism applies. A setting with no "scope" is read from the open
 *  folder's .vscode/settings.json too, and the folder's value wins over the user's; Workspace Trust
 *  does not change that for an extension that says untrustedWorkspaces.supported = true.
 *
 *  Why it matters here: `levelcode.update.url` overrides the update feed, so a folder that sets it makes
 *  the editor's update check offer a download from the folder's own address. `levelcode.update.enabled`
 *  and `.intervalHours` switch that check off or change how often it asks, and `levelcode.init.enabled`
 *  decides whether the user's ~/.levelcode/init.js runs at start.
 *
 *  Default-deny, as in levelcode-ai: every setting is application-scoped except an explicit list of
 *  editing preferences below. A setting added later is folder-settable only if someone puts it on that
 *  list, and the first test here fails until they do.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const extensionsDir = path.join(__dirname, '..', '..');

/** Every contributed setting of every bundled extension except levelcode-ai, with the extension it came from. */
function bundledSettings(dir = extensionsDir) {
	/** @type {Record<string, { ext: string, scope: string | undefined }>} */
	const out = {};
	for (const ext of fs.readdirSync(dir).sort()) {
		if (ext === 'levelcode-ai') { continue; }
		const file = path.join(dir, ext, 'package.json');
		if (!fs.existsSync(file)) { continue; }
		const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
		const conf = pkg.contributes && pkg.contributes.configuration;
		if (!conf) { continue; }
		for (const section of Array.isArray(conf) ? conf : [conf]) {
			for (const [key, def] of Object.entries(section.properties || {})) { out[key] = { ext, scope: def.scope }; }
		}
	}
	return out;
}
const props = bundledSettings();

let n = 0;
function test(name, fn) { fn(); n++; console.log('  ok - ' + name); }

// Scopes a folder's .vscode/settings.json cannot set. 'machine' is user (or remote) settings only,
// like 'application', but kept per profile.
const USER_ONLY = new Set(['application', 'machine']);
const KNOWN_SCOPES = new Set(['application', 'machine', 'window', 'resource', 'language-overridable', 'machine-overridable']);

// Written out here on purpose: opening a setting to folders is a decision, and this is where it is made.
// These shape how the editor treats text and big files. None of them decides where anything is sent,
// what runs, or what is trusted.
const FOLDER_OK = [
	'levelcode.bigFile.notify', 'levelcode.bigFile.thresholdMB',
	'levelcode.jsonPaste.enabled', 'levelcode.jsonPaste.indent',
	'levelcode.macros.maxReplayCount', 'levelcode.macros.maxSteps',
];

test('a folder can set only the listed editing preferences', () => {
	const open = Object.keys(props).filter((k) => !USER_ONLY.has(String(props[k].scope))).sort();
	assert.deepStrictEqual(open, FOLDER_OK, 'a setting a folder can set that is not on the list: ' + open.filter((k) => !FOLDER_OK.includes(k)).join(', '));
	for (const k of FOLDER_OK) { assert.ok(k in props, k + ' is on the list but is not a setting: stale entry'); }
});

test('every scope is one the editor knows (it reads anything else as "window", which a folder can set)', () => {
	for (const [k, def] of Object.entries(props)) {
		if (def.scope !== undefined) { assert.ok(KNOWN_SCOPES.has(def.scope), k + ' has scope ' + JSON.stringify(def.scope)); }
	}
});

test('the update feed and the update check are user settings only', () => {
	for (const k of ['levelcode.update.url', 'levelcode.update.enabled', 'levelcode.update.intervalHours']) {
		assert.ok(k in props, k + ' is not a setting');
		assert.strictEqual(props[k].ext, 'levelcode-updater', k);
		assert.strictEqual(props[k].scope, 'application', k + ' can be set by a folder');
	}
});

test('whether the user init script runs is a user setting only', () => {
	assert.ok('levelcode.init.enabled' in props, 'levelcode.init.enabled is not a setting');
	assert.strictEqual(props['levelcode.init.enabled'].scope, 'application', 'levelcode.init.enabled can be set by a folder');
});

test('the check sees a setting added to any bundled extension (default-deny is not just for the ones known today)', () => {
	// A throwaway extensions tree with one new, unscoped setting: the collector must report it as folder-settable.
	const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'lc-scope-'));
	try {
		fs.mkdirSync(path.join(tmp, 'levelcode-newthing'));
		fs.writeFileSync(path.join(tmp, 'levelcode-newthing', 'package.json'),
			JSON.stringify({ contributes: { configuration: { properties: { 'levelcode.newthing.url': { type: 'string' } } } } }));
		const found = bundledSettings(tmp);
		assert.deepStrictEqual(Object.keys(found), ['levelcode.newthing.url']);
		assert.ok(!USER_ONLY.has(String(found['levelcode.newthing.url'].scope)), 'an unscoped setting must count as folder-settable');
	} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

console.log(`\n${n} tests passed`);
