/*---------------------------------------------------------------------------------------------
 *  web/workspace/extension.js — run: node web/test/unit/workspace.test.js
 *
 *  The scratch-workspace extension is evaluated as ONE file by the web extension host, so it cannot be split into
 *  modules; this test loads that file against a stand-in for `vscode` and runs what it exports.
 *
 *    openLocalFolder   must ask the dialog from the `file` scheme. From the scratch scheme the workbench shows its
 *                      own file browser instead of the browser's picker (the command did nothing useful until
 *                      it was run in a real browser).
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
const fsError = (code) => (uri) => Object.assign(new Error(code + ': ' + (uri && uri.path)), { code });
const vscodeMock = {
	Uri,
	window: {
		async showOpenDialog(o) { calls.dialogs.push(o); return nextPick; },
		showWarningMessage(m) { calls.warnings.push(m); },
		createStatusBarItem() { return { show() {}, hide() {}, dispose() {} }; },
	},
	commands: { async executeCommand(...a) { calls.commands.push(a); }, registerCommand(id) { calls.registered.push(id); return { dispose() {} }; } },
	workspace: {
		workspaceFolders: [],
		registerFileSystemProvider(_scheme, p) { calls.providers.push(p); return { dispose() {} }; },
		onDidChangeWorkspaceFolders() { return { dispose() {} }; },
	},
	EventEmitter: class { constructor() { this.event = () => ({ dispose() {} }); } fire() {} },
	Disposable: class { constructor(f) { this.dispose = f; } },
	FileType: { File: 1, Directory: 2 },
	FileChangeType: { Changed: 1, Created: 2, Deleted: 3 },
	FileSystemError: { FileNotFound: fsError('FileNotFound'), FileExists: fsError('FileExists'), FileIsADirectory: fsError('FileIsADirectory'),
		FileNotADirectory: fsError('FileNotADirectory'), NoPermissions: fsError('NoPermissions') },
	StatusBarAlignment: { Left: 1 },
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

	/* ---- activation, and the file system itself ---------------------------------------------------- */
	const { createIndexedDB } = require('./fake-idb');
	const ctx = () => ({ subscriptions: [] });
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
