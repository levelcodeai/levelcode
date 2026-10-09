/*---------------------------------------------------------------------------------------------
 *  LevelCode in your browser — the scratch workspace.
 *
 *  A browser has no project folder to open until the user picks one (and only Chromium can).
 *  The scratch workspace is a folder that always exists: files live in this browser's IndexedDB,
 *  survive reloads, and are shared by every tab of this origin. A signed-in user can ask LevelCode
 *  to build something with no further setup, then move the files out (download, or copy into a
 *  real folder opened from their computer).
 *
 *  It is a FileSystemProvider for the scheme `levelcode-scratch`. Plain JS: the web extension
 *  host evaluates this one file, no bundler involved.
 *--------------------------------------------------------------------------------------------*/
'use strict';

const vscode = require('vscode');

const SCHEME = 'levelcode-scratch';
const DB_NAME = 'levelcode-scratch';
const STORE = 'nodes';
const CHANNEL = 'levelcode-scratch-changes';
const FILE = 1, DIR = 2; // vscode.FileType.File / Directory

const WELCOME = [
	'# Scratch workspace',
	'',
	'This folder lives in your browser. It is saved on this computer, in this browser,',
	'and nowhere else.',
	'',
	'- Ask LevelCode to build something and the files appear here.',
	'- To work on a real project, use **LevelCode: Open Folder from Your Computer** (Chrome and Edge).',
	'- To keep these files, download them from the Explorer (right-click, Download).',
	'',
].join('\n');

/* ----- IndexedDB -------------------------------------------------------------------------- */

function openDb() {
	return new Promise((resolve, reject) => {
		const req = indexedDB.open(DB_NAME, 1);
		req.onupgradeneeded = () => { req.result.createObjectStore(STORE, { keyPath: 'path' }); };
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
	});
}
function request(r) { return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); }
function done(tx) { return new Promise((res, rej) => { tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error); }); }

const norm = (p) => { const s = '/' + String(p || '/').split('/').filter(Boolean).join('/'); return s; };
const parentOf = (p) => (p === '/' ? '/' : norm(p.slice(0, p.lastIndexOf('/'))));
const under = (p) => (p === '/' ? '/' : p + '/');

class ScratchFileSystem {
	constructor(db) {
		this.db = db;
		this._emitter = new vscode.EventEmitter();
		this.onDidChangeFile = this._emitter.event;
		this.channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel(CHANNEL) : null;
		if (this.channel) {
			this.channel.onmessage = (e) => {
				const events = (e.data || []).map((c) => ({ type: c.type, uri: vscode.Uri.from({ scheme: SCHEME, path: c.path }) }));
				if (events.length) { this._emitter.fire(events); }
			};
		}
	}

	_changed(list) {
		this._emitter.fire(list.map((c) => ({ type: c.type, uri: vscode.Uri.from({ scheme: SCHEME, path: c.path }) })));
		if (this.channel) { this.channel.postMessage(list); }
	}

	async _get(path) {
		return request(this.db.transaction(STORE).objectStore(STORE).get(path));
	}
	async _range(path) {
		const lo = under(path);
		return request(this.db.transaction(STORE).objectStore(STORE).getAll(IDBKeyRange.bound(lo, lo + '￿')));
	}
	async _isDir(path) {
		if (path === '/') { return true; }
		const n = await this._get(path);
		return !!n && n.type === DIR;
	}

	watch() { return new vscode.Disposable(() => { }); }

	async stat(uri) {
		const path = norm(uri.path);
		if (path === '/') { const t = Date.now(); return { type: vscode.FileType.Directory, ctime: t, mtime: t, size: 0 }; }
		const n = await this._get(path);
		if (!n) { throw vscode.FileSystemError.FileNotFound(uri); }
		return { type: n.type === DIR ? vscode.FileType.Directory : vscode.FileType.File, ctime: n.ctime, mtime: n.mtime, size: n.size || 0 };
	}

	async readDirectory(uri) {
		const path = norm(uri.path);
		if (!(await this._isDir(path))) {
			throw (await this._get(path)) ? vscode.FileSystemError.FileNotADirectory(uri) : vscode.FileSystemError.FileNotFound(uri);
		}
		const prefix = under(path);
		const out = new Map();
		for (const n of await this._range(path)) {
			const rest = n.path.slice(prefix.length);
			const i = rest.indexOf('/');
			const name = i < 0 ? rest : rest.slice(0, i);
			if (!name) { continue; }
			out.set(name, i >= 0 || n.type === DIR ? vscode.FileType.Directory : vscode.FileType.File);
		}
		return [...out.entries()];
	}

	async readFile(uri) {
		const path = norm(uri.path);
		const n = await this._get(path);
		if (!n) { throw vscode.FileSystemError.FileNotFound(uri); }
		if (n.type === DIR) { throw vscode.FileSystemError.FileIsADirectory(uri); }
		return n.data instanceof Uint8Array ? n.data : new Uint8Array(n.data || 0);
	}

	/** Make every missing ancestor of `path` a directory, in the same transaction. */
	async _mkdirs(store, path, created) {
		const missing = [];
		let cur = parentOf(path);
		while (cur !== '/') {
			const n = await request(store.get(cur));
			if (n) { if (n.type !== DIR) { throw vscode.FileSystemError.FileNotADirectory(vscode.Uri.from({ scheme: SCHEME, path: cur })); } break; }
			missing.push(cur);
			cur = parentOf(cur);
		}
		const t = Date.now();
		for (const d of missing.reverse()) { store.put({ path: d, type: DIR, ctime: t, mtime: t, size: 0 }); created.push({ type: vscode.FileChangeType.Created, path: d }); }
	}

	async writeFile(uri, content, options) {
		const path = norm(uri.path);
		if (path === '/') { throw vscode.FileSystemError.FileIsADirectory(uri); }
		const tx = this.db.transaction(STORE, 'readwrite');
		const store = tx.objectStore(STORE);
		const existing = await request(store.get(path));
		if (existing && existing.type === DIR) { tx.abort(); throw vscode.FileSystemError.FileIsADirectory(uri); }
		if (!existing && !options.create) { tx.abort(); throw vscode.FileSystemError.FileNotFound(uri); }
		if (existing && options.create && !options.overwrite) { tx.abort(); throw vscode.FileSystemError.FileExists(uri); }
		const changes = [];
		await this._mkdirs(store, path, changes);
		const t = Date.now();
		store.put({ path, type: FILE, ctime: existing ? existing.ctime : t, mtime: t, size: content.byteLength, data: content });
		await done(tx);
		changes.push({ type: existing ? vscode.FileChangeType.Changed : vscode.FileChangeType.Created, path });
		this._changed(changes);
	}

	async createDirectory(uri) {
		const path = norm(uri.path);
		if (path === '/') { return; }
		const tx = this.db.transaction(STORE, 'readwrite');
		const store = tx.objectStore(STORE);
		const existing = await request(store.get(path));
		if (existing) { tx.abort(); throw vscode.FileSystemError.FileExists(uri); }
		const changes = [];
		await this._mkdirs(store, path, changes);
		const t = Date.now();
		store.put({ path, type: DIR, ctime: t, mtime: t, size: 0 });
		await done(tx);
		changes.push({ type: vscode.FileChangeType.Created, path });
		this._changed(changes);
	}

	async delete(uri, options) {
		const path = norm(uri.path);
		const tx = this.db.transaction(STORE, 'readwrite');
		const store = tx.objectStore(STORE);
		const n = await request(store.get(path));
		if (!n && path !== '/') { tx.abort(); throw vscode.FileSystemError.FileNotFound(uri); }
		const changes = [];
		if (n && n.type === DIR) {
			const kids = await request(store.getAllKeys(IDBKeyRange.bound(under(path), under(path) + '￿')));
			if (kids.length && !(options && options.recursive)) { tx.abort(); throw vscode.FileSystemError.NoPermissions(uri); }
			for (const k of kids) { store.delete(k); changes.push({ type: vscode.FileChangeType.Deleted, path: k }); }
		}
		if (n) { store.delete(path); changes.push({ type: vscode.FileChangeType.Deleted, path }); }
		await done(tx);
		this._changed(changes);
	}

	async rename(from, to, options) { return this._transfer(from, to, options, true); }
	async copy(from, to, options) { return this._transfer(from, to, options, false); }

	async _transfer(from, to, options, move) {
		const a = norm(from.path);
		const b = norm(to.path);
		if (a === b) { return; }
		if (b.startsWith(under(a))) { throw vscode.FileSystemError.NoPermissions(to); }
		const tx = this.db.transaction(STORE, 'readwrite');
		const store = tx.objectStore(STORE);
		const src = await request(store.get(a));
		if (!src) { tx.abort(); throw vscode.FileSystemError.FileNotFound(from); }
		const dst = await request(store.get(b));
		if (dst && !(options && options.overwrite)) { tx.abort(); throw vscode.FileSystemError.FileExists(to); }
		const changes = [];
		await this._mkdirs(store, b, changes);
		if (dst) { store.delete(b); }
		const t = Date.now();
		const nodes = [src];
		if (src.type === DIR) { nodes.push(...await request(store.getAll(IDBKeyRange.bound(under(a), under(a) + '￿')))); }
		for (const n of nodes) {
			const np = b + n.path.slice(a.length);
			store.put(Object.assign({}, n, { path: np, mtime: move ? n.mtime : t, ctime: move ? n.ctime : t }));
			changes.push({ type: vscode.FileChangeType.Created, path: np });
			if (move) { store.delete(n.path); changes.push({ type: vscode.FileChangeType.Deleted, path: n.path }); }
		}
		await done(tx);
		this._changed(changes);
	}
}

/* ----- activation ------------------------------------------------------------------------- */

async function seedWelcome(fsp) {
	// A brand-new, empty scratch workspace gets one file so the Explorer is not a blank panel.
	try {
		const kids = await fsp.readDirectory(vscode.Uri.from({ scheme: SCHEME, path: '/' }));
		if (kids.length === 0) {
			await fsp.writeFile(vscode.Uri.from({ scheme: SCHEME, path: '/README.md' }), new TextEncoder().encode(WELCOME), { create: true, overwrite: false });
			return true;
		}
	} catch (e) { /* seeding is a courtesy */ }
	return false;
}

async function activate(context) {
	let db;
	try { db = await openDb(); }
	catch (e) {
		vscode.window.showWarningMessage('LevelCode could not open browser storage, so the scratch workspace is unavailable. Private windows in some browsers block it. Open a folder from your computer instead.');
		return;
	}
	const fsp = new ScratchFileSystem(db);
	context.subscriptions.push(vscode.workspace.registerFileSystemProvider(SCHEME, fsp, { isCaseSensitive: true }));

	await seedWelcome(fsp);

	const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
	item.text = '$(archive) Scratch';
	item.tooltip = 'Scratch workspace: files are saved in this browser only.';
	item.command = 'levelcode.web.aboutScratch';
	const inScratch = () => (vscode.workspace.workspaceFolders || []).some((f) => f.uri.scheme === SCHEME);
	const refresh = () => { if (inScratch()) { item.show(); } else { item.hide(); } };
	refresh();
	context.subscriptions.push(item, vscode.workspace.onDidChangeWorkspaceFolders(refresh));

	context.subscriptions.push(
		// The workbench owns the picker (File System Access lives on the window, not in this worker)
		// and tells the user itself when the browser has no support for it.
		vscode.commands.registerCommand('levelcode.web.openLocalFolder', () => vscode.commands.executeCommand('workbench.action.files.openFolder')),
		vscode.commands.registerCommand('levelcode.web.openScratch', () => vscode.commands.executeCommand(
			'vscode.openFolder', vscode.Uri.from({ scheme: SCHEME, path: '/' }), { forceReuseWindow: true })),
		vscode.commands.registerCommand('levelcode.web.aboutScratch', async () => {
			const open = 'Open folder from your computer';
			const pick = await vscode.window.showInformationMessage(
				'This is your scratch workspace. Its files are saved in this browser on this computer, and nowhere else. To keep them, download them from the Explorer.',
				open);
			if (pick === open) { await vscode.commands.executeCommand('levelcode.web.openLocalFolder'); }
		}),
	);
}

function deactivate() { }

module.exports = { activate, deactivate };
