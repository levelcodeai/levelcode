/*---------------------------------------------------------------------------------------------
 *  web/workspace/extension.js — run: node web/test/unit/workspace.test.js
 *
 *  The scratch-workspace extension is evaluated as ONE file by the web extension host, so it cannot be split into
 *  modules; this test loads that file against a stand-in for `vscode` and runs what it exports.
 *
 *    openLocalFolder   must ask the dialog from the `file` scheme. From the scratch scheme the workbench shows its
 *                      own file browser instead of the browser's picker (the command did nothing useful until
 *                      it was run in a real browser).
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

const assert = require('assert');
const path = require('path');
const Module = require('module');

class Uri {
	constructor(scheme, p) { this.scheme = scheme; this.path = p; }
	static from(c) { return new Uri(c.scheme, c.path || '/'); }
	toString() { return this.scheme + '://' + this.path; }
}
const calls = { dialogs: /** @type {any[]} */ ([]), commands: /** @type {any[][]} */ ([]) };
let nextPick = /** @type {any} */ (undefined);
const vscodeMock = {
	Uri,
	window: { async showOpenDialog(o) { calls.dialogs.push(o); return nextPick; } },
	commands: { async executeCommand(...a) { calls.commands.push(a); } },
};
const origLoad = Module._load;
// @ts-ignore
Module._load = function (request, parent, isMain) { return request === 'vscode' ? vscodeMock : origLoad.call(this, request, parent, isMain); };
const ext = require(path.join(__dirname, '..', '..', 'workspace', 'extension.js'));

let n = 0;
async function test(name, fn) { calls.dialogs.length = 0; calls.commands.length = 0; await fn(); n++; console.log('  ok - ' + name); }

(async () => {
	await test('the picker is asked for a folder, starting from the file scheme, not the scratch scheme', async () => {
		nextPick = [new Uri('file', '/my-project')];
		await ext.openLocalFolder(vscodeMock);
		assert.strictEqual(calls.dialogs.length, 1);
		const o = calls.dialogs[0];
		assert.strictEqual(o.defaultUri.scheme, 'file', 'a default location in another scheme gets the workbench\'s own file browser');
		assert.strictEqual(o.canSelectFolders, true);
		assert.strictEqual(o.canSelectFiles, false);
		assert.strictEqual(o.canSelectMany, false);
	});
	await test('the folder that was picked becomes the workspace, in this tab', async () => {
		const picked = new Uri('file', '/my-project');
		nextPick = [picked];
		assert.strictEqual(await ext.openLocalFolder(vscodeMock), true);
		assert.deepStrictEqual(calls.commands, [['vscode.openFolder', picked, { forceReuseWindow: true }]]);
	});
	await test('cancelling the picker does nothing', async () => {
		for (const none of [undefined, []]) {
			nextPick = none;
			calls.commands.length = 0;
			assert.strictEqual(await ext.openLocalFolder(vscodeMock), false);
			assert.deepStrictEqual(calls.commands, []);
		}
	});
	console.log(`\n${n} tests passed`);
})().catch((e) => { console.error(e); process.exit(1); });
