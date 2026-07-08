/*---------------------------------------------------------------------------------------------
 *  Unit tests for extensions/levelcode-ai/importVscode.js (pure helpers) — run: node importVscode.test.js
 *  Heavy on the string-aware JSONC scanner — that's the data-safety-critical part.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

const assert = require('assert');
const I = require('../importVscode');

let n = 0;
function test(name, fn) { fn(); n++; console.log('  ok - ' + name); }

// --- jsoncParse: real comments/commas are stripped ---
test('jsoncParse: strips // and /* */ comments and trailing commas (outside strings)', () => {
	assert.deepStrictEqual(I.jsoncParse('{\n  // a\n  "a": 1, /* inline */ "b": 2,\n}'), { a: 1, b: 2 });
	assert.deepStrictEqual(I.jsoncParse('[ 1, 2, ]'), [1, 2]);
	assert.deepStrictEqual(I.jsoncParse('{ "a": 1, /* c */ }'), { a: 1 });
});

// --- jsoncParse: must NEVER corrupt comment-looking text INSIDE strings (the blocker class) ---
test('jsoncParse: preserves /* */ inside a string value (no silent corruption)', () => {
	assert.deepStrictEqual(I.jsoncParse('{"k":"a /* keep */ b"}'), { k: 'a /* keep */ b' });
	assert.deepStrictEqual(I.jsoncParse('{"s":"start /* mid */ end","keep":true}'), { s: 'start /* mid */ end', keep: true });
});
test('jsoncParse: preserves // inside a string value', () => {
	assert.deepStrictEqual(I.jsoncParse('{"comment":"use a // here"}'), { comment: 'use a // here' });
	assert.deepStrictEqual(I.jsoncParse('{"url":"https://levelcode.ai/x","n":1}'), { url: 'https://levelcode.ai/x', n: 1 });
	assert.deepStrictEqual(I.jsoncParse('{"u":"//cdn/x"}'), { u: '//cdn/x' });
});
test('jsoncParse: preserves trailing-comma-looking text inside strings', () => {
	assert.deepStrictEqual(I.jsoncParse('{"s":"a,}"}'), { s: 'a,}' });
	assert.deepStrictEqual(I.jsoncParse('{"s":"x,]"}'), { s: 'x,]' });
});
test('jsoncParse: honors escaped quotes (string does not end early)', () => {
	assert.deepStrictEqual(I.jsoncParse('{"s":"a\\"b // c","keep":1}'), { s: 'a"b // c', keep: 1 });
});
test('jsoncParse: returns null on genuinely unparseable input', () => {
	assert.strictEqual(I.jsoncParse('{ not json'), null);
	assert.strictEqual(I.jsoncParse(null), null);
});

// --- mergeSettings ---
test('mergeSettings: incoming (VS Code) wins, base-only keys kept', () => {
	const merged = JSON.parse(I.mergeSettings('{ "editor.fontSize": 12, "levelcode.ai.claude.model": "claude-opus-4-8" }', '{ "editor.fontSize": 15, "editor.tabSize": 2 }'));
	assert.strictEqual(merged['editor.fontSize'], 15);
	assert.strictEqual(merged['editor.tabSize'], 2);
	assert.strictEqual(merged['levelcode.ai.claude.model'], 'claude-opus-4-8');
});
test('mergeSettings: empty/missing base merges incoming; output ends with newline', () => {
	assert.deepStrictEqual(JSON.parse(I.mergeSettings(null, '{ "x": 1 }')), { x: 1 });
	assert.deepStrictEqual(JSON.parse(I.mergeSettings('   ', '{ "x": 1 }')), { x: 1 });
	assert.ok(I.mergeSettings('{}', '{ "a": 1 }').endsWith('\n'));
});
test('mergeSettings: NON-EMPTY but unparseable base → null (skip, never clobber)', () => {
	assert.strictEqual(I.mergeSettings('{ "fontSize": 13  "missingComma": true }', '{ "tabSize": 4 }'), null);
});
test('mergeSettings: unparseable incoming → null; array incoming → null', () => {
	assert.strictEqual(I.mergeSettings('{}', 'not json'), null);
	assert.strictEqual(I.mergeSettings('{}', '[1,2]'), null);
});

// --- mergeKeybindings ---
test('mergeKeybindings: appends incoming after base (later wins)', () => {
	const merged = JSON.parse(I.mergeKeybindings('[ { "key": "cmd+d", "command": "levelcode.file.duplicate" } ]', '[ { "key": "cmd+d", "command": "editor.action.copyLinesDownAction" } ]'));
	assert.strictEqual(merged.length, 2);
	assert.strictEqual(merged[1].command, 'editor.action.copyLinesDownAction');
});
test('mergeKeybindings: missing base → incoming only; non-empty unparseable base → null; non-array incoming → null', () => {
	assert.deepStrictEqual(JSON.parse(I.mergeKeybindings(null, '[ { "key": "a" } ]')), [{ key: 'a' }]);
	assert.strictEqual(I.mergeKeybindings('[ { bad ', '[ { "key": "a" } ]'), null);
	assert.strictEqual(I.mergeKeybindings('[]', '{ "not": "array" }'), null);
});

// --- IO exports + the dest-dir derivation (the wrong-dir blocker fix) ---
test('userDirFromContext derives <userData>/User from globalStorageUri', () => {
	const ctx = { globalStorageUri: { fsPath: '/Users/me/Library/Application Support/code-oss-dev/User/globalStorage/levelcode.levelcode-ai' } };
	assert.strictEqual(I.userDirFromContext(ctx), '/Users/me/Library/Application Support/code-oss-dev/User');
});
test('exports the IO entry points', () => {
	assert.strictEqual(typeof I.importFromVscode, 'function');
	assert.strictEqual(typeof I.vscodeCandidates, 'function');
	assert.strictEqual(typeof I.stripJsonc, 'function');
});

console.log('\nimportVscode.js: ' + n + ' tests passed.');
