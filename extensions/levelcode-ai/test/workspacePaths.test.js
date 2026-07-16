/*---------------------------------------------------------------------------------------------
 *  Unit tests for multi-root workspace path resolution — run: node test/workspacePaths.test.js
 *    - resolveWorkspacePath: single-root behavior unchanged; multi-root folder-name prefixes;
 *      existence probing across folders; create-mode targeting; sandbox containment (union of
 *      workspace folders, never outside); folders added MID-SESSION are picked up live (the
 *      "level . locked me to the first folder" bug).
 *  agent.js imports 'vscode', so a minimal mock is injected via the module loader.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

// --- minimal vscode mock: only what agent.js touches at load + what the resolver reads live ---
const workspaceFolders = [];
const vscodeMock = {
	workspace: { get workspaceFolders() { return workspaceFolders.length ? workspaceFolders : undefined; } },
	env: { appRoot: '' },
	Uri: { file: (p) => ({ fsPath: p }) }
};
const origLoad = Module._load;
// @ts-ignore — test-only loader shim
Module._load = function (request, parent, isMain) {
	if (request === 'vscode') { return vscodeMock; }
	return origLoad.call(this, request, parent, isMain);
};

const { resolveWorkspacePath } = require('../agent');

let n = 0;
function test(name, fn) { fn(); n++; console.log('  ok - ' + name); }
function addFolder(root, name) { workspaceFolders.push({ uri: { fsPath: root }, name }); }

// --- fixture: two disjoint roots, like `level .` in thin.ly + "Add Folder" of levelcode ---
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-ws-'));
const rootA = path.join(tmp, 'thin.ly');
const rootB = path.join(tmp, 'levelcode');
fs.mkdirSync(path.join(rootA, 'app'), { recursive: true });
fs.mkdirSync(path.join(rootB, 'docs'), { recursive: true });
fs.writeFileSync(path.join(rootA, 'app', 'link.rb'), 'a');
fs.writeFileSync(path.join(rootA, 'README.md'), 'a-readme');
fs.writeFileSync(path.join(rootB, 'docs', 'RELEASING.md'), 'b-releasing');
fs.writeFileSync(path.join(rootB, 'only-in-b.txt'), 'b');

// --- single root (the pre-multi-root world) ---
addFolder(rootA, 'thin.ly');

test('single root: plain relative path resolves against it', () => {
	assert.strictEqual(resolveWorkspacePath('app/link.rb', { mustExist: true }), path.join(rootA, 'app', 'link.rb'));
});
test('single root: missing file → null (mustExist)', () => {
	assert.strictEqual(resolveWorkspacePath('docs/RELEASING.md', { mustExist: true }), null);
});
test('single root: escape via ../ is rejected', () => {
	assert.strictEqual(resolveWorkspacePath('../outside.txt', { mustExist: false }), null);
});
test('single root: create-mode resolves inside the root', () => {
	assert.strictEqual(resolveWorkspacePath('new/file.txt'), path.join(rootA, 'new', 'file.txt'));
});

// --- THE BUG: a folder added mid-session must be visible on the very next call ---
test('mid-session Add Folder: the new folder is usable immediately (live, not cached)', () => {
	assert.strictEqual(resolveWorkspacePath('levelcode/docs/RELEASING.md', { mustExist: true }), null); // before
	addFolder(rootB, 'levelcode');                                                                      // user adds it
	assert.strictEqual(resolveWorkspacePath('levelcode/docs/RELEASING.md', { mustExist: true }),
		path.join(rootB, 'docs', 'RELEASING.md'));                                                        // after — no restart
});

// --- multi-root resolution rules ---
test('multi-root: folder-name prefix targets that folder (asRelativePath convention)', () => {
	assert.strictEqual(resolveWorkspacePath('thin.ly/app/link.rb', { mustExist: true }), path.join(rootA, 'app', 'link.rb'));
});
test('multi-root: unprefixed path still resolves against the FIRST folder', () => {
	assert.strictEqual(resolveWorkspacePath('README.md', { mustExist: true }), path.join(rootA, 'README.md'));
});
test('multi-root: unprefixed path existing only in a later folder is FOUND by probing', () => {
	assert.strictEqual(resolveWorkspacePath('only-in-b.txt', { mustExist: true }), path.join(rootB, 'only-in-b.txt'));
});
test('multi-root: create-mode without prefix targets the first folder', () => {
	assert.strictEqual(resolveWorkspacePath('brand-new.txt'), path.join(rootA, 'brand-new.txt'));
});
test('multi-root: create-mode WITH prefix targets the named folder', () => {
	assert.strictEqual(resolveWorkspacePath('levelcode/brand-new.txt'), path.join(rootB, 'brand-new.txt'));
});
test('multi-root: missing everywhere → null (mustExist)', () => {
	assert.strictEqual(resolveWorkspacePath('nope/nothing.txt', { mustExist: true }), null);
});
test('multi-root: escape through a named folder ("levelcode/../..") is rejected', () => {
	assert.strictEqual(resolveWorkspacePath('levelcode/../../etc/passwd', { mustExist: false }), null);
	assert.strictEqual(resolveWorkspacePath('levelcode/../../etc/passwd', { mustExist: true }), null);
});
test('multi-root: absolute path outside every folder is rejected', () => {
	assert.strictEqual(resolveWorkspacePath('/etc/passwd', { mustExist: true }), null);
});

// --- no workspace at all ---
test('no folders: resolves to null', () => {
	workspaceFolders.length = 0;
	assert.strictEqual(resolveWorkspacePath('x.txt'), null);
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(n + ' passing');
