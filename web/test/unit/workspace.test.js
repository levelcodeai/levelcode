/*---------------------------------------------------------------------------------------------
 *  web/workspace/extension.js — run: node web/test/unit/workspace.test.js
 *
 *  The scratch-workspace extension is evaluated as ONE file by the web extension host, so it cannot be split into
 *  modules; this test loads that file against a stand-in for `vscode` and runs what it exports.
 *
 *    openLocalFolder   must ask the dialog from the `file` scheme. From the scratch scheme the workbench shows its
 *                      own file browser instead of the browser's picker (the command did nothing useful until
 *                      it was run in a real browser).
 *    applyLayout       arranges the window for the chat on its own or for the editor with the chat docked. It is
 *                      only workbench commands, so what is pinned here is WHICH ones and in WHAT ORDER: a group
 *                      that is emptied by moving the chat out of it is closed, so the file has to be opened first.
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
const CHAT = 'mainThreadWebview-levelcode.ai.chat';
/** What the window has open: groups of tabs, each tab `{ input: { viewType } | { uri } }`. */
let groupsNow = /** @type {any[]} */ ([]);
let config = /** @type {Record<string, any>} */ ({});
let found = /** @type {any[]} */ ([]);
const shown = /** @type {any[][]} */ ([]);
const vscodeMock = {
	Uri,
	ViewColumn: { One: 1, Two: 2 },
	window: {
		async showOpenDialog(o) { calls.dialogs.push(o); return nextPick; },
		get tabGroups() { return { all: groupsNow }; },
		async showTextDocument(...a) { shown.push(a); calls.commands.push(['(show)', a[0] && a[0].path]); },
	},
	workspace: {
		getConfiguration(section) { return { get: (k, d) => (config[section + '.' + k] !== undefined ? config[section + '.' + k] : d) }; },
		async findFiles() { return found; },
	},
	commands: { async executeCommand(...a) { calls.commands.push(a); } },
};
const chatTab = { input: { viewType: CHAT } };
const fileTab = { input: { uri: new Uri('levelcode-scratch', '/README.md') } };
const origLoad = Module._load;
// @ts-ignore
Module._load = function (request, parent, isMain) { return request === 'vscode' ? vscodeMock : origLoad.call(this, request, parent, isMain); };
const ext = require(path.join(__dirname, '..', '..', 'workspace', 'extension.js'));

let n = 0;
async function test(name, fn) {
	calls.dialogs.length = 0; calls.commands.length = 0; shown.length = 0;
	groupsNow = []; config = {}; found = [];
	await fn(); n++; console.log('  ok - ' + name);
}
const ids = () => calls.commands.map((c) => c[0]);

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

	/* ----- layout ----- */
	await test('the layout is chatFirst unless the setting says split; anything else is chatFirst', async () => {
		assert.strictEqual(ext.currentLayout(vscodeMock), 'chatFirst');
		for (const [v, want] of [['split', 'split'], ['chatFirst', 'chatFirst'], ['sideways', 'chatFirst'], [null, 'chatFirst'], [3, 'chatFirst']]) {
			config['levelcode.web.layout'] = v;
			assert.strictEqual(ext.currentLayout(vscodeMock), want, String(v));
		}
		assert.deepStrictEqual(ext.LAYOUTS, ['chatFirst', 'split']);
	});
	await test('the chat\'s group is found by its view type, and a file\'s group is not it', async () => {
		const left = { viewColumn: 1, tabs: [fileTab] };
		const right = { viewColumn: 2, tabs: [chatTab] };
		groupsNow = [left, right];
		assert.strictEqual(ext.chatGroup(vscodeMock), right);
		groupsNow = [left];
		assert.strictEqual(ext.chatGroup(vscodeMock), undefined);
		groupsNow = [{ viewColumn: 1, tabs: [{ input: { viewType: 'something.else' } }, { input: null }, {}] }];
		assert.strictEqual(ext.chatGroup(vscodeMock), undefined);
	});
	await test('chatFirst, chat already alone: focus it and put the side bars away, nothing is moved', async () => {
		groupsNow = [{ viewColumn: 1, tabs: [chatTab] }];
		await ext.applyLayout(vscodeMock, 'chatFirst');
		assert.deepStrictEqual(ids(), ['levelcode.ai.focus', 'workbench.action.closeSidebar', 'workbench.action.closePanel', 'workbench.action.closeAuxiliaryBar']);
	});
	await test('chatFirst, chat docked on the right: it is brought back to the first group', async () => {
		groupsNow = [{ viewColumn: 1, tabs: [fileTab] }, { viewColumn: 2, tabs: [chatTab] }];
		await ext.applyLayout(vscodeMock, 'chatFirst');
		assert.deepStrictEqual(ids(), ['levelcode.ai.focus', 'workbench.action.moveEditorToFirstGroup', 'workbench.action.closeSidebar', 'workbench.action.closePanel', 'workbench.action.closeAuxiliaryBar']);
	});
	await test('chatFirst with the chat in the first of several groups leaves it where it is', async () => {
		groupsNow = [{ viewColumn: 1, tabs: [chatTab] }, { viewColumn: 2, tabs: [fileTab] }];
		await ext.applyLayout(vscodeMock, 'chatFirst');
		assert.ok(!ids().includes('workbench.action.moveEditorToFirstGroup'));
	});
	await test('split, chat alone: a file is opened FIRST in column one, then the chat is moved right, then the Explorer', async () => {
		groupsNow = [{ viewColumn: 1, tabs: [chatTab] }];
		found = [new Uri('levelcode-scratch', '/README.md')];
		await ext.applyLayout(vscodeMock, 'split');
		assert.deepStrictEqual(ids(), ['levelcode.ai.focus', '(show)', 'levelcode.ai.focus', 'workbench.action.moveEditorToRightGroup', 'workbench.view.explorer']);
		const [doc, opts] = shown[0];
		assert.strictEqual(doc.path, '/README.md');
		assert.strictEqual(opts.viewColumn, 1);
		assert.strictEqual(opts.preserveFocus, true, 'the file must not take the focus: the chat is what is moved');
		assert.strictEqual(opts.preview, false, 'a preview tab is replaced by the next file, which would leave the group empty again');
	});
	await test('split, chat alone and no README: still moves the chat and shows the Explorer', async () => {
		groupsNow = [{ viewColumn: 1, tabs: [chatTab] }];
		found = [];
		await ext.applyLayout(vscodeMock, 'split');
		assert.deepStrictEqual(ids(), ['levelcode.ai.focus', 'levelcode.ai.focus', 'workbench.action.moveEditorToRightGroup', 'workbench.view.explorer']);
	});
	await test('split, already two groups: only the Explorer is shown, nothing is moved or opened', async () => {
		groupsNow = [{ viewColumn: 1, tabs: [fileTab] }, { viewColumn: 2, tabs: [chatTab] }];
		await ext.applyLayout(vscodeMock, 'split');
		assert.deepStrictEqual(ids(), ['levelcode.ai.focus', 'workbench.view.explorer']);
		assert.strictEqual(shown.length, 0);
	});
	await test('split after a reload: the two groups are back but the chat opened in the first, beside a file — it is docked', async () => {
		groupsNow = [{ viewColumn: 1, tabs: [fileTab, chatTab] }, { viewColumn: 2, tabs: [] }];
		await ext.applyLayout(vscodeMock, 'split');
		assert.deepStrictEqual(ids(), ['levelcode.ai.focus', 'workbench.action.moveEditorToRightGroup', 'workbench.view.explorer']);
		assert.strictEqual(shown.length, 0, 'no file is opened: there is one already');
	});
	await test('split with the chat alone in the first group and files on the right is left as the visitor arranged it', async () => {
		groupsNow = [{ viewColumn: 1, tabs: [chatTab] }, { viewColumn: 2, tabs: [fileTab] }];
		await ext.applyLayout(vscodeMock, 'split');
		assert.ok(!ids().includes('workbench.action.moveEditorToRightGroup'), 'moving it would merge it into the files\' group');
	});
	await test('split with the chat already in the last group, beside other chats or files, is not moved again', async () => {
		groupsNow = [{ viewColumn: 1, tabs: [fileTab] }, { viewColumn: 2, tabs: [fileTab, chatTab] }];
		await ext.applyLayout(vscodeMock, 'split');
		assert.ok(!ids().includes('workbench.action.moveEditorToRightGroup'));
	});
	await test('no layout closes anything in the other: split never closes the side bars, chatFirst never opens the Explorer', async () => {
		groupsNow = [{ viewColumn: 1, tabs: [chatTab] }];
		await ext.applyLayout(vscodeMock, 'split');
		assert.ok(!ids().some((i) => /close/.test(i)));
		calls.commands.length = 0;
		await ext.applyLayout(vscodeMock, 'chatFirst');
		assert.ok(!ids().includes('workbench.view.explorer'));
	});

	console.log(`\n${n} tests passed`);
})().catch((e) => { console.error(e); process.exit(1); });
