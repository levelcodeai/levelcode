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
 *                      that is emptied by moving the chat out of it is closed, so the file has to be opened first;
 *                      the move commands act on the ACTIVE editor, so they run only once the chat is it.
 *    the switch        the status item and the commands, driven through `activate`: they write the setting where
 *                      it takes effect.
 *    activate          registers the way out to a folder from the computer even when browser storage is refused
 *    rename / copy     over an existing file or folder replace it whole — in IndexedDB (a stand-in: fake-idb.js)
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
const calls = { dialogs: /** @type {any[]} */ ([]), commands: /** @type {any[][]} */ ([]), registered: /** @type {string[]} */ ([]), warnings: /** @type {string[]} */ ([]), providers: /** @type {any[]} */ ([]) };
let nextPick = /** @type {any} */ (undefined);
const CHAT = 'mainThreadWebview-levelcode.ai.chat';
/** What the window has open: groups of tabs, each tab `{ input: { viewType } | { uri } }`. */
let groupsNow = /** @type {any[]} */ ([]);
/** The user's settings, and the workspace's (`.vscode/settings.json`), which outrank them. */
let config = /** @type {Record<string, any>} */ ({});
let wsConfig = /** @type {Record<string, any>} */ ({});
let found = /** @type {any[]} */ ([]);
const shown = /** @type {any[][]} */ ([]);
const closed = /** @type {any[]} */ ([]);
const updates = /** @type {any[][]} */ ([]);
let tabListeners = /** @type {Function[]} */ ([]);
/** The group that has the focus, pinned by a test whatever the commands do. */
let activeGroup = /** @type {any} */ (undefined);
/** Not pinned: a file shown by showTextDocument is the one on show in column one until the chat is revealed again;
 *  otherwise the chat is on show in its group (what levelcode.ai.focus leads to). */
let shownActive = /** @type {any} */ (undefined);
/** The chat's reveal reaches the tab model only when the test says so (shownActive = undefined; fireTabs()). */
let focusLate = false;
let untitledFails = false;
const isChat = (t) => !!(t && t.input && t.input.viewType === CHAT);
const activeNow = () => {
	if (activeGroup !== undefined) { return activeGroup; }
	if (shownActive) { return shownActive; }
	const g = groupsNow.find((x) => x.tabs.some(isChat));
	return g ? { ...g, activeTab: g.tabs.find(isChat) } : groupsNow[0];
};
const registered = /** @type {Record<string, Function>} */ ({});
const fireTabs = () => tabListeners.slice().forEach((f) => f());
const fsError = (code) => (uri) => Object.assign(new Error(code + ': ' + (uri && uri.path)), { code });
const vscodeMock = {
	Uri,
	ViewColumn: { One: 1, Two: 2 },
	window: {
		async showOpenDialog(o) { calls.dialogs.push(o); return nextPick; },
		get tabGroups() {
			return {
				all: groupsNow,
				activeTabGroup: activeNow(),
				onDidChangeTabGroups: (fn) => { tabListeners.push(fn); return { dispose() { tabListeners = tabListeners.filter((x) => x !== fn); } }; },
				onDidChangeTabs: (fn) => { tabListeners.push(fn); return { dispose() { tabListeners = tabListeners.filter((x) => x !== fn); } }; },
				close: async (g) => { closed.push(g); },
			};
		},
		async showTextDocument(...a) {
			shown.push(a); calls.commands.push(['(show)', a[0] && (a[0].path || a[0].uri.path)]);
			shownActive = { viewColumn: 1, tabs: [], activeTab: { input: { uri: a[0].uri || a[0] } } };
		},
		createStatusBarItem() { return { show() { }, hide() { }, dispose() { } }; },
		async showWarningMessage(m) { calls.warnings.push(m); return undefined; },
	},
	StatusBarAlignment: { Left: 1, Right: 2 },
	ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
	workspace: {
		getConfiguration(section) {
			const pick = (k) => (wsConfig[section + '.' + k] !== undefined ? wsConfig[section + '.' + k] : config[section + '.' + k]);
			return {
				get: (k, d) => (pick(k) !== undefined ? pick(k) : d),
				inspect: (k) => ({ key: section + '.' + k, globalValue: config[section + '.' + k], workspaceValue: wsConfig[section + '.' + k] }),
				update: async (k, v, t) => { updates.push([section + '.' + k, v, t]); },
			};
		},
		async findFiles() { return found; },
		async openTextDocument() {
			calls.commands.push(['(untitled)']);
			if (untitledFails) { throw new Error('no'); }
			return { uri: new Uri('untitled', 'Untitled-1') };
		},
		onDidChangeConfiguration() { return { dispose() { } }; },
		workspaceFolders: [],
		registerFileSystemProvider(_scheme, p) { calls.providers.push(p); return { dispose() {} }; },
		onDidChangeWorkspaceFolders() { return { dispose() {} }; },
	},
	commands: {
		async executeCommand(...a) { calls.commands.push(a); if (a[0] === 'levelcode.ai.focus' && !focusLate) { shownActive = undefined; } },
		registerCommand(id, fn) { registered[id] = fn; calls.registered.push(id); return { dispose() { } }; },
	},
	EventEmitter: class { constructor() { this.event = () => ({ dispose() {} }); } fire() {} },
	Disposable: class { constructor(f) { this.dispose = f; } },
	FileType: { File: 1, Directory: 2 },
	FileChangeType: { Changed: 1, Created: 2, Deleted: 3 },
	FileSystemError: { FileNotFound: fsError('FileNotFound'), FileExists: fsError('FileExists'), FileIsADirectory: fsError('FileIsADirectory'),
		FileNotADirectory: fsError('FileNotADirectory'), NoPermissions: fsError('NoPermissions') },
};
const chatTab = { input: { viewType: CHAT } };
const fileTab = { input: { uri: new Uri('levelcode-scratch', '/README.md') } };
const origLoad = Module._load;
// @ts-ignore
Module._load = function (request, parent, isMain) { return request === 'vscode' ? vscodeMock : origLoad.call(this, request, parent, isMain); };
const ext = require(path.join(__dirname, '..', '..', 'workspace', 'extension.js'));

let n = 0;
async function test(name, fn) {
	calls.dialogs.length = 0; calls.commands.length = 0; shown.length = 0; closed.length = 0; updates.length = 0; tabListeners = []; activeGroup = undefined;
	shownActive = undefined; focusLate = false; untitledFails = false;
	groupsNow = []; config = {}; wsConfig = {}; found = [];
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
	await test('choosing a folder is choosing to work on its files: the layout becomes the editor one, before the window is reused', async () => {
		nextPick = [new Uri('file', '/my-project')];
		await ext.openLocalFolder(vscodeMock);
		assert.deepStrictEqual(updates, [['levelcode.web.layout', 'split', 1]]);
		assert.deepStrictEqual(ids(), ['vscode.openFolder']);
	});
	await test('a layout setting that cannot be written does not stop the folder from opening', async () => {
		nextPick = [new Uri('file', '/my-project')];
		const real = vscodeMock.workspace.getConfiguration;
		vscodeMock.workspace.getConfiguration = () => ({ get: () => 'chatFirst', update: async () => { throw new Error('read-only'); } });
		try { assert.strictEqual(await ext.openLocalFolder(vscodeMock), true); } finally { vscodeMock.workspace.getConfiguration = real; }
		assert.deepStrictEqual(ids(), ['vscode.openFolder']);
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
	await test('split, chat alone and no README: an empty untitled document keeps the first group, then the chat is moved', async () => {
		// Without it the move takes the chat's only group with it: one group, "Editor + chat" in name only.
		groupsNow = [{ viewColumn: 1, tabs: [chatTab] }];
		found = [];
		await ext.applyLayout(vscodeMock, 'split');
		assert.deepStrictEqual(ids(), ['levelcode.ai.focus', '(untitled)', '(show)', 'levelcode.ai.focus', 'workbench.action.moveEditorToRightGroup', 'workbench.view.explorer']);
		const [doc, opts] = shown[0];
		assert.strictEqual(doc.uri.scheme, 'untitled');
		assert.strictEqual(opts.viewColumn, 1);
		assert.strictEqual(opts.preserveFocus, true);
		assert.strictEqual(opts.preview, false);
	});
	await test('split, no README but another file shares the chat\'s group: nothing is opened, that file keeps the group', async () => {
		groupsNow = [{ viewColumn: 1, tabs: [fileTab, chatTab] }];
		found = [];
		await ext.applyLayout(vscodeMock, 'split');
		assert.deepStrictEqual(ids(), ['levelcode.ai.focus', 'levelcode.ai.focus', 'workbench.action.moveEditorToRightGroup', 'workbench.view.explorer']);
	});
	await test('split, chat alone, no README and no untitled document to be had: the chat is not moved out of its only group', async () => {
		groupsNow = [{ viewColumn: 1, tabs: [chatTab] }];
		found = [];
		untitledFails = true;
		await ext.applyLayout(vscodeMock, 'split');
		assert.deepStrictEqual(ids(), ['levelcode.ai.focus', '(untitled)', 'workbench.view.explorer']);
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
	await test('split with the chat not in the tab model yet: it is waited for, then docked (the status item click on a closed chat)', async () => {
		groupsNow = [{ viewColumn: 1, tabs: [] }];
		found = [new Uri('levelcode-scratch', '/README.md')];
		const run = ext.applyLayout(vscodeMock, 'split', { waitMs: 2000 });
		await new Promise((r) => setTimeout(r, 20));
		assert.strictEqual(tabListeners.length, 1, 'it is listening for the tab');
		groupsNow = [{ viewColumn: 1, tabs: [chatTab] }];   // the host is told about the new tab
		fireTabs();
		await run;
		assert.strictEqual(tabListeners.length, 0, 'and stopped listening');
		assert.deepStrictEqual(ids(), ['levelcode.ai.focus', '(show)', 'levelcode.ai.focus', 'workbench.action.moveEditorToRightGroup', 'workbench.view.explorer']);
	});
	await test('a chat that never comes is given up on after the wait, and the Explorer is still shown', async () => {
		groupsNow = [{ viewColumn: 1, tabs: [] }];
		const t0 = Date.now();
		await ext.applyLayout(vscodeMock, 'split', { waitMs: 60 });
		assert.ok(Date.now() - t0 >= 50 && Date.now() - t0 < 1500);
		assert.deepStrictEqual(ids(), ['levelcode.ai.focus', 'workbench.view.explorer']);
		assert.strictEqual(tabListeners.length, 0);
	});
	await test('a start-up does not reveal the Explorer when it is told not to (a visitor who closed it)', async () => {
		groupsNow = [{ viewColumn: 1, tabs: [fileTab] }, { viewColumn: 2, tabs: [chatTab] }];
		await ext.applyLayout(vscodeMock, 'split', { explorer: false });
		assert.ok(!ids().includes('workbench.view.explorer'));
	});
	await test('chatFirst after a reload: the empty group that was restored is closed, and a window of only empty groups is left alone', async () => {
		const emptyRight = { viewColumn: 2, tabs: [] };
		groupsNow = [{ viewColumn: 1, tabs: [chatTab, fileTab] }, emptyRight];
		await ext.applyLayout(vscodeMock, 'chatFirst');
		assert.deepStrictEqual(closed, [[emptyRight]]);
		closed.length = 0;
		groupsNow = [{ viewColumn: 1, tabs: [] }, { viewColumn: 2, tabs: [] }];
		await ext.applyLayout(vscodeMock, 'chatFirst', { waitMs: 10 });
		assert.deepStrictEqual(closed, [], 'closing every group would leave nothing to put the chat in');
	});
	await test('columns, not the order of the list, say which group is on the left (the list is in creation order)', async () => {
		// the chat's group was created second but sits first on screen
		groupsNow = [{ viewColumn: 2, tabs: [fileTab, chatTab] }, { viewColumn: 1, tabs: [chatTab, fileTab] }];
		const left = groupsNow[1];
		groupsNow = [{ viewColumn: 2, tabs: [fileTab] }, left];
		await ext.applyLayout(vscodeMock, 'chatFirst');
		assert.ok(!ids().includes('workbench.action.moveEditorToFirstGroup'), 'the chat is already in column one');
		calls.commands.length = 0;
		await ext.applyLayout(vscodeMock, 'split');
		assert.ok(ids().includes('workbench.action.moveEditorToRightGroup'), 'column one is not the last column: docked to the right');
	});
	await test('the move commands wait until the chat is the active editor, not just until its tab exists', async () => {
		const chatGroup1 = { viewColumn: 2, tabs: [chatTab], activeTab: { input: fileTab.input } };
		const files = { viewColumn: 1, tabs: [fileTab], activeTab: fileTab };
		groupsNow = [files, chatGroup1];
		activeGroup = files;   // the file's group has the focus: a move now would act on the file
		const run = ext.applyLayout(vscodeMock, 'chatFirst', { waitMs: 1000 });
		await new Promise((r) => setTimeout(r, 30));
		assert.ok(!ids().includes('workbench.action.moveEditorToFirstGroup'), 'it moved before the chat was active');
		activeGroup = { viewColumn: 2, tabs: [chatTab], activeTab: chatTab };
		groupsNow = [files, { ...chatGroup1, activeTab: chatTab }];
		fireTabs();
		await run;
		assert.ok(ids().includes('workbench.action.moveEditorToFirstGroup'));
		assert.ok(ids().indexOf('workbench.action.moveEditorToFirstGroup') > ids().indexOf('levelcode.ai.focus'));
	});
	await test('an arrangement that is overtaken by a later choice stops: the start-up one does not put the chat back on the right', async () => {
		groupsNow = [{ viewColumn: 1, tabs: [] }];
		found = [new Uri('levelcode-scratch', '/README.md')];
		const early = ext.applyLayout(vscodeMock, 'split', { waitMs: 1000 });   // waiting for the chat tab
		await new Promise((r) => setTimeout(r, 20));
		const later = ext.applyLayout(vscodeMock, 'chatFirst', { waitMs: 1000 });
		await new Promise((r) => setTimeout(r, 20));
		groupsNow = [{ viewColumn: 1, tabs: [chatTab] }];
		fireTabs();
		await Promise.all([early, later]);
		assert.ok(!ids().includes('workbench.action.moveEditorToRightGroup'), 'the earlier split resumed and docked the chat');
		assert.ok(!ids().includes('workbench.view.explorer'));
		assert.ok(ids().includes('workbench.action.closeSidebar'), 'the later one was applied');
		assert.strictEqual(shown.length, 0);
	});
	await test('a chat that never becomes active is given up on, and the layout goes on', async () => {
		activeGroup = { viewColumn: 1, tabs: [fileTab], activeTab: fileTab };
		groupsNow = [{ viewColumn: 1, tabs: [fileTab], activeTab: fileTab }, { viewColumn: 2, tabs: [chatTab], activeTab: { input: null } }];
		const t0 = Date.now();
		await ext.applyLayout(vscodeMock, 'chatFirst', { waitMs: 80 });
		assert.ok(Date.now() - t0 < 1500);
		assert.ok(ids().includes('workbench.action.closeSidebar'));
		assert.strictEqual(tabListeners.length, 0);
	});
	await test('chatFirst: a chat that does not become active is not moved — the move would take the file beside it', async () => {
		const files = { viewColumn: 1, tabs: [fileTab], activeTab: fileTab };
		groupsNow = [files, { viewColumn: 2, tabs: [chatTab, fileTab], activeTab: fileTab }];
		activeGroup = files;
		await ext.applyLayout(vscodeMock, 'chatFirst', { waitMs: 80 });
		assert.deepStrictEqual(ids(), ['levelcode.ai.focus', 'workbench.action.closeSidebar', 'workbench.action.closePanel', 'workbench.action.closeAuxiliaryBar']);
		assert.strictEqual(tabListeners.length, 0);
	});
	await test('split: once the README is opened it is the active editor, so the chat is moved only when it is active again', async () => {
		groupsNow = [{ viewColumn: 1, tabs: [chatTab] }];
		found = [new Uri('levelcode-scratch', '/README.md')];
		focusLate = true;
		const run = ext.applyLayout(vscodeMock, 'split', { waitMs: 1000 });
		await new Promise((r) => setTimeout(r, 30));
		assert.deepStrictEqual(ids(), ['levelcode.ai.focus', '(show)', 'levelcode.ai.focus'], 'it moved while the README was the active editor');
		shownActive = undefined;   // the reveal lands
		fireTabs();
		await run;
		assert.deepStrictEqual(ids(), ['levelcode.ai.focus', '(show)', 'levelcode.ai.focus', 'workbench.action.moveEditorToRightGroup', 'workbench.view.explorer']);
		assert.strictEqual(tabListeners.length, 0);
	});
	await test('split: a chat that does not become active again is not moved, after a README or after a reload', async () => {
		groupsNow = [{ viewColumn: 1, tabs: [chatTab] }];
		found = [new Uri('levelcode-scratch', '/README.md')];
		focusLate = true;
		await ext.applyLayout(vscodeMock, 'split', { waitMs: 80 });
		assert.deepStrictEqual(ids(), ['levelcode.ai.focus', '(show)', 'levelcode.ai.focus', 'workbench.view.explorer']);
		calls.commands.length = 0;
		// a reload: the chat beside a file in the first group, the file on show
		const first = { viewColumn: 1, tabs: [fileTab, chatTab], activeTab: fileTab };
		groupsNow = [first, { viewColumn: 2, tabs: [] }];
		activeGroup = first;
		await ext.applyLayout(vscodeMock, 'split', { waitMs: 80 });
		assert.deepStrictEqual(ids(), ['levelcode.ai.focus', 'workbench.view.explorer']);
	});
	await test('the window is read once the chat is the active editor: a group that was only there until then (an editor in front) does not count', async () => {
		// Saving a setting from an editor opened in front of the chat: until the chat is focused that editor's group is
		// still in the model, and read then the window would look like two groups already — nothing would be docked.
		const chatOnly = { viewColumn: 1, tabs: [chatTab] };
		const settings = { viewColumn: 2, tabs: [{ input: { uri: new Uri('levelcode-scratch', '/.vscode/settings.json') } }] };
		settings.activeTab = settings.tabs[0];
		groupsNow = [chatOnly, settings];
		activeGroup = settings;
		found = [new Uri('levelcode-scratch', '/README.md')];
		const run = ext.applyLayout(vscodeMock, 'split', { waitMs: 1000 });
		await new Promise((r) => setTimeout(r, 30));
		groupsNow = [chatOnly];   // the editor in front goes when the chat takes the focus
		activeGroup = undefined;
		fireTabs();
		await run;
		assert.deepStrictEqual(ids(), ['levelcode.ai.focus', '(show)', 'levelcode.ai.focus', 'workbench.action.moveEditorToRightGroup', 'workbench.view.explorer']);
	});
	await test('a move that is waiting for the chat is dropped when a newer layout is asked for meanwhile', async () => {
		groupsNow = [{ viewColumn: 1, tabs: [chatTab] }];
		found = [new Uri('levelcode-scratch', '/README.md')];
		focusLate = true;
		const early = ext.applyLayout(vscodeMock, 'split', { waitMs: 1000 });   // waiting for the chat to be active again
		await new Promise((r) => setTimeout(r, 20));
		const later = ext.applyLayout(vscodeMock, 'chatFirst', { waitMs: 1000 });
		await new Promise((r) => setTimeout(r, 20));
		shownActive = undefined;
		fireTabs();
		await Promise.all([early, later]);
		assert.ok(!ids().includes('workbench.action.moveEditorToRightGroup'), 'the overtaken split docked the chat');
		assert.ok(!ids().includes('workbench.view.explorer'));
	});
	await test('chatFirst: groups that still have files are joined into the chat\'s group (their files stay open, behind the chat), and it is unlocked', async () => {
		const aJs = { input: { uri: new Uri('levelcode-scratch', '/a.js') } };
		const SIDE = ['workbench.action.closeSidebar', 'workbench.action.closePanel', 'workbench.action.closeAuxiliaryBar'];
		// the docked layout plus a file editor split beside the first group
		groupsNow = [{ viewColumn: 1, tabs: [fileTab] }, { viewColumn: 2, tabs: [aJs] }, { viewColumn: 3, tabs: [chatTab] }];
		await ext.applyLayout(vscodeMock, 'chatFirst');
		assert.deepStrictEqual(ids(), ['levelcode.ai.focus', 'workbench.action.moveEditorToFirstGroup', 'workbench.action.joinAllGroups', 'workbench.action.unlockEditorGroup', ...SIDE]);
		assert.deepStrictEqual(closed, [], 'no group with files is closed');
		// the chat already first, a file group beside it
		calls.commands.length = 0;
		groupsNow = [{ viewColumn: 1, tabs: [chatTab] }, { viewColumn: 2, tabs: [aJs] }];
		await ext.applyLayout(vscodeMock, 'chatFirst');
		assert.deepStrictEqual(ids(), ['levelcode.ai.focus', 'workbench.action.joinAllGroups', 'workbench.action.unlockEditorGroup', ...SIDE]);
		// the chat docked beside a file of its own: that file stays behind when the chat moves
		calls.commands.length = 0;
		groupsNow = [{ viewColumn: 1, tabs: [fileTab] }, { viewColumn: 2, tabs: [chatTab, aJs] }];
		await ext.applyLayout(vscodeMock, 'chatFirst');
		assert.deepStrictEqual(ids(), ['levelcode.ai.focus', 'workbench.action.moveEditorToFirstGroup', 'workbench.action.joinAllGroups', 'workbench.action.unlockEditorGroup', ...SIDE]);
	});
	await test('chatFirst: a join is not run when the chat is not the active editor (it would join into the file\'s group)', async () => {
		const files = { viewColumn: 2, tabs: [fileTab], activeTab: fileTab };
		groupsNow = [{ viewColumn: 1, tabs: [chatTab], activeTab: chatTab }, files];
		activeGroup = files;
		await ext.applyLayout(vscodeMock, 'chatFirst', { waitMs: 80 });
		assert.ok(!ids().includes('workbench.action.joinAllGroups'));
		assert.ok(!ids().includes('workbench.action.unlockEditorGroup'));
		assert.ok(ids().includes('workbench.action.closeSidebar'));
	});
	/* ----- start-up ----- */
	const state = () => { const m = new Map(); return { m, get: (k) => m.get(k), update: async (k, v) => { m.set(k, v); } }; };
	await test('first start in a workspace: the chosen layout is applied, with the Explorer, and remembered for that workspace', async () => {
		groupsNow = [{ viewColumn: 1, tabs: [chatTab] }];
		const st = state();
		await ext.applyAtStart(vscodeMock, st, { waitMs: 10 });
		assert.ok(ids().includes('workbench.action.closeSidebar'));
		assert.strictEqual(st.m.get(ext.APPLIED_KEY), true);
	});
	await test('a later start with chatFirst applies nothing: the workbench remembers its own side bars', async () => {
		groupsNow = [{ viewColumn: 1, tabs: [chatTab] }];
		const st = state(); st.m.set(ext.APPLIED_KEY, true);
		await ext.applyAtStart(vscodeMock, st, { waitMs: 10 });
		assert.deepStrictEqual(ids(), []);
	});
	await test('a later start with split docks the chat again and leaves the Explorer as the visitor left it', async () => {
		config['levelcode.web.layout'] = 'split';
		groupsNow = [{ viewColumn: 1, tabs: [fileTab, chatTab] }, { viewColumn: 2, tabs: [] }];
		const st = state(); st.m.set(ext.APPLIED_KEY, true);
		await ext.applyAtStart(vscodeMock, st, { waitMs: 10 });
		assert.deepStrictEqual(ids(), ['levelcode.ai.focus', 'workbench.action.moveEditorToRightGroup']);
	});
	await test('the first start of a workspace in split reveals the Explorer', async () => {
		config['levelcode.web.layout'] = 'split';
		groupsNow = [{ viewColumn: 1, tabs: [fileTab] }, { viewColumn: 2, tabs: [chatTab] }];
		await ext.applyAtStart(vscodeMock, state(), { waitMs: 10 });
		assert.ok(ids().includes('workbench.view.explorer'));
	});
	await test('the switch changes the layout where it takes effect: the workspace\'s value when the workspace sets one', async () => {
		const st = state(); st.m.set(ext.APPLIED_KEY, true);   // a later start in chatFirst: nothing is arranged
		await ext.activate({ subscriptions: [], workspaceState: st });
		assert.ok(registered['levelcode.web.layout.toggle'] && registered['levelcode.web.layout.split'] && registered['levelcode.web.layout.chatFirst']);
		config['levelcode.web.layout'] = 'split';         // the user's preference
		wsConfig['levelcode.web.layout'] = 'chatFirst';   // .vscode/settings.json, which outranks it: the layout is chatFirst
		await registered['levelcode.web.layout.toggle']();
		assert.deepStrictEqual(updates, [['levelcode.web.layout', 'split', vscodeMock.ConfigurationTarget.Workspace]], 'a user setting would leave the window as it is');
		updates.length = 0;
		await registered['levelcode.web.layout.split']();
		assert.deepStrictEqual(updates, [['levelcode.web.layout', 'split', vscodeMock.ConfigurationTarget.Workspace]]);
		updates.length = 0;
		wsConfig['levelcode.web.layout'] = 'split';
		await registered['levelcode.web.layout.chatFirst']();
		assert.deepStrictEqual(updates, [['levelcode.web.layout', 'chatFirst', vscodeMock.ConfigurationTarget.Workspace]]);
	});
	await test('with no workspace value the switch keeps writing the user\'s preference', async () => {
		const st = state(); st.m.set(ext.APPLIED_KEY, true);
		await ext.activate({ subscriptions: [], workspaceState: st });
		config['levelcode.web.layout'] = 'split';
		await registered['levelcode.web.layout.toggle']();
		assert.deepStrictEqual(updates, [['levelcode.web.layout', 'chatFirst', vscodeMock.ConfigurationTarget.Global]]);
		updates.length = 0;
		delete config['levelcode.web.layout'];
		await registered['levelcode.web.layout.toggle']();
		assert.deepStrictEqual(updates, [['levelcode.web.layout', 'split', vscodeMock.ConfigurationTarget.Global]]);
	});
	await test('no layout closes anything in the other: split never closes the side bars, chatFirst never opens the Explorer', async () => {
		groupsNow = [{ viewColumn: 1, tabs: [chatTab] }];
		await ext.applyLayout(vscodeMock, 'split');
		assert.ok(!ids().some((i) => /close/.test(i)));
		calls.commands.length = 0;
		await ext.applyLayout(vscodeMock, 'chatFirst');
		assert.ok(!ids().includes('workbench.view.explorer'));
	});

	/* ---- activation, and the file system itself ---------------------------------------------------- */
	const { createIndexedDB } = require('./fake-idb');
	// The layout was arranged in this workspace before, so activation does not wait for a chat tab to arrange around.
	const ctx = () => ({ subscriptions: [], workspaceState: { get: () => true, update: async () => {} } });
	// The file system tells the other tabs of a change over a BroadcastChannel. Node has one too, and an open channel
	// would keep this process alive after the last test; there are no other tabs here.
	// @ts-ignore
	globalThis.BroadcastChannel = undefined;

	await test('with browser storage refused, the way out the warning names is still there', async () => {
		calls.registered.length = 0; calls.warnings.length = 0;
		Object.assign(globalThis, { indexedDB: { open() { const r = {}; setTimeout(() => { r.error = new Error('denied'); r.onerror && r.onerror(); }, 0); return r; } } });
		await ext.activate(ctx());
		assert.strictEqual(calls.warnings.length, 1, 'the user is told');
		assert.ok(calls.registered.includes('levelcode.web.openLocalFolder'), 'and "Open a folder from your computer" can be run');
	});

	/** A fresh scratch file system on a fresh stand-in IndexedDB. */
	const fresh = async () => {
		Object.assign(globalThis, createIndexedDB());
		calls.providers.length = 0; calls.registered.length = 0;
		await ext.activate(ctx());
		assert.ok(calls.registered.includes('levelcode.web.openLocalFolder'));
		const fsp = calls.providers[0];
		const u = (p) => Uri.from({ scheme: 'levelcode-scratch', path: p });
		const write = (p, text) => fsp.writeFile(u(p), new TextEncoder().encode(text), { create: true, overwrite: true });
		const read = async (p) => new TextDecoder().decode(await fsp.readFile(u(p)));
		const exists = async (p) => { try { await fsp.stat(u(p)); return true; } catch { return false; } };
		const list = async (p) => (await fsp.readDirectory(u(p))).map(([name]) => name).sort();
		return { fsp, u, write, read, exists, list };
	};

	await test('a folder renamed over another replaces it whole: none of the old one\'s files survive under the new name', async () => {
		const t = await fresh();
		await t.write('/scratch/a/x.txt', 'from a');
		await t.write('/scratch/b/old.txt', 'old');
		await t.write('/scratch/b/deep/older.txt', 'older');
		await t.fsp.rename(t.u('/scratch/a'), t.u('/scratch/b'), { overwrite: true });
		assert.deepStrictEqual(await t.list('/scratch/b'), ['x.txt']);
		assert.strictEqual(await t.read('/scratch/b/x.txt'), 'from a');
		assert.strictEqual(await t.exists('/scratch/b/old.txt'), false);
		assert.strictEqual(await t.exists('/scratch/b/deep/older.txt'), false, 'nor deeper ones — which search would still have found');
		assert.strictEqual(await t.exists('/scratch/a'), false, 'a move leaves nothing behind');
	});
	await test('a file written over a folder leaves no children behind it', async () => {
		const t = await fresh();
		await t.write('/scratch/f.txt', 'a file');
		await t.write('/scratch/d/child.txt', 'child');
		await t.fsp.rename(t.u('/scratch/f.txt'), t.u('/scratch/d'), { overwrite: true });
		assert.strictEqual(await t.read('/scratch/d'), 'a file');
		assert.strictEqual(await t.exists('/scratch/d/child.txt'), false);
		assert.deepStrictEqual(await t.list('/scratch'), ['README.md', 'd']);
	});
	await test('a copy over a folder replaces it whole too, and keeps the source', async () => {
		const t = await fresh();
		await t.write('/scratch/a/x.txt', 'x');
		await t.write('/scratch/b/old.txt', 'old');
		await t.fsp.copy(t.u('/scratch/a'), t.u('/scratch/b'), { overwrite: true });
		assert.deepStrictEqual(await t.list('/scratch/b'), ['x.txt']);
		assert.strictEqual(await t.read('/scratch/a/x.txt'), 'x');
	});
	await test('without overwrite nothing changes; over a folder that contains the source, or into itself, it is refused', async () => {
		const t = await fresh();
		await t.write('/scratch/a/x.txt', 'x');
		await t.write('/scratch/b/old.txt', 'old');
		await assert.rejects(t.fsp.rename(t.u('/scratch/a'), t.u('/scratch/b'), { overwrite: false }), (e) => e.code === 'FileExists');
		assert.strictEqual(await t.read('/scratch/b/old.txt'), 'old');
		await assert.rejects(t.fsp.rename(t.u('/scratch/b/old.txt'), t.u('/scratch/b'), { overwrite: true }), (e) => e.code === 'NoPermissions', 'replacing the folder would delete the source first');
		assert.strictEqual(await t.read('/scratch/b/old.txt'), 'old');
		await assert.rejects(t.fsp.rename(t.u('/scratch/a'), t.u('/scratch/a/inner'), { overwrite: true }), (e) => e.code === 'NoPermissions');
		assert.strictEqual(await t.read('/scratch/a/x.txt'), 'x');
	});
	await test('an ordinary rename still works, and a file renamed over a file replaces it', async () => {
		const t = await fresh();
		await t.write('/scratch/one.txt', '1');
		await t.write('/scratch/two.txt', '2');
		await t.fsp.rename(t.u('/scratch/one.txt'), t.u('/scratch/sub/new.txt'), { overwrite: false });
		assert.strictEqual(await t.read('/scratch/sub/new.txt'), '1');
		await t.fsp.rename(t.u('/scratch/sub/new.txt'), t.u('/scratch/two.txt'), { overwrite: true });
		assert.strictEqual(await t.read('/scratch/two.txt'), '1');
		assert.deepStrictEqual(await t.list('/scratch/sub'), []);
	});

	console.log(`\n${n} tests passed`);
})().catch((e) => { console.error(e); process.exit(1); });
