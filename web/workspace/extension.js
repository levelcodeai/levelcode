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

/* ----- search ----------------------------------------------------------------------------- */

// Quick Open, the Search view and workspace.findFiles (which the agent's list_files uses) ask the
// provider registered for the folder's scheme. Without one they wait forever, so the scratch
// workspace answers its own questions. Everything is in IndexedDB; a scan is cheap at this size.

/** A VS Code glob as a RegExp over a '/'-relative path. A pattern with no '/' matches at any depth. */
function globToRegExp(glob) {
	const src = String(glob);
	const anyDepth = !src.includes('/');
	const conv = (g) => {
		let re = '';
		for (let i = 0; i < g.length;) {
			const c = g[i];
			if (c === '*') {
				if (g[i + 1] === '*') {
					i += 2;
					if (g[i] === '/') { i++; re += '(?:.*/)?'; } else { re += '.*'; }
				} else { re += '[^/]*'; i++; }
			} else if (c === '?') { re += '[^/]'; i++; }
			else if (c === '{') {
				const j = g.indexOf('}', i);
				if (j < 0) { re += '\\{'; i++; }
				else { re += '(?:' + g.slice(i + 1, j).split(',').map(conv).join('|') + ')'; i = j + 1; }
			} else if (c === '[') {
				const j = g.indexOf(']', i + 1);
				if (j < 0) { re += '\\['; i++; }
				else { re += '[' + g.slice(i + 1, j).replace(/^!/, '^').replace(/\\/g, '\\\\') + ']'; i = j + 1; }
			} else { re += c.replace(/[.+^${}()|\\\/]/g, '\\$&'); i++; }
		}
		return re;
	};
	return new RegExp('^' + (anyDepth ? '(?:.*/)?' : '') + conv(src.replace(/^\.\//, '').replace(/^\//, '')) + '$');
}

/** True when `rel` or any directory above it matches one of the globs. */
function matchesAny(rel, res) {
	if (!res.length) { return false; }
	const parts = rel.split('/');
	let cur = '';
	for (const part of parts) {
		cur = cur ? cur + '/' + part : part;
		if (res.some((r) => r.test(cur))) { return true; }
	}
	return false;
}

function subsequence(hay, needle) {
	let j = 0;
	for (let i = 0; i < hay.length && j < needle.length; i++) { if (hay[i] === needle[j]) { j++; } }
	return j === needle.length;
}

class ScratchSearch {
	constructor(fsp) { this.fsp = fsp; }

	async _files(folder, includes, excludes) {
		const root = norm(folder.path);
		const prefix = under(root);
		const inc = (includes || []).map(globToRegExp);
		const exc = (excludes || []).map(globToRegExp);
		const nodes = await this.fsp._range(root);
		const out = [];
		for (const n of nodes) {
			if (n.type !== FILE) { continue; }
			const rel = n.path.slice(prefix.length);
			if (matchesAny(rel, exc)) { continue; }
			if (inc.length && !inc.some((r) => r.test(rel))) { continue; }
			out.push({ rel, node: n });
		}
		return out;
	}

	async provideFileSearchResults(query, options, token) {
		const want = String(query.pattern || '').toLowerCase().replace(/\\/g, '/');
		const files = await this._files(options.folder, options.includes, options.excludes);
		const hits = [];
		for (const f of files) {
			if (token.isCancellationRequested) { break; }
			const hay = f.rel.toLowerCase();
			if (!want || hay.includes(want) || subsequence(hay, want)) { hits.push(f); }
		}
		const max = options.maxResults || 10000;
		return hits.slice(0, max).map((f) => vscode.Uri.from({ scheme: SCHEME, path: f.node.path }));
	}

	async provideTextSearchResults(query, options, progress, token) {
		const files = await this._files(options.folder, options.includes, options.excludes);
		let re;
		try {
			const src = query.isRegExp ? query.pattern : query.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
			re = new RegExp(query.isWordMatch ? '\\b(?:' + src + ')\\b' : src, query.isCaseSensitive ? 'g' : 'gi');
		} catch (e) { return { limitHit: false }; }
		const max = options.maxResults || 10000;
		const maxSize = options.maxFileSize || 1024 * 1024;
		let count = 0;
		const decoder = new TextDecoder('utf-8');
		for (const f of files) {
			if (token.isCancellationRequested) { break; }
			const data = f.node.data;
			if (!data || data.byteLength > maxSize) { continue; }
			if (data.subarray(0, 8000).includes(0)) { continue; }   // binary
			const lines = decoder.decode(data).split('\n');
			const uri = vscode.Uri.from({ scheme: SCHEME, path: f.node.path });
			for (let ln = 0; ln < lines.length; ln++) {
				const line = lines[ln].replace(/\r$/, '');
				re.lastIndex = 0;
				const ranges = [];
				const previews = [];
				let m;
				while ((m = re.exec(line)) !== null) {
					if (m[0].length === 0) { re.lastIndex++; continue; }
					ranges.push(new vscode.Range(ln, m.index, ln, m.index + m[0].length));
					previews.push(new vscode.Range(0, m.index, 0, m.index + m[0].length));
				}
				if (!ranges.length) { continue; }
				progress.report({ uri, ranges, preview: { text: line, matches: previews } });
				count += ranges.length;
				if (count >= max) { return { limitHit: true }; }
			}
		}
		return { limitHit: false };
	}
}

/* ----- activation ------------------------------------------------------------------------- */

const HOME = '/scratch';

async function seedWelcome(fsp) {
	// The workspace folder is /scratch. A brand-new one is created, with one file so the Explorer is not a
	// blank panel. An existing one is left exactly as it is.
	try {
		const dir = vscode.Uri.from({ scheme: SCHEME, path: HOME });
		let exists = true;
		try { await fsp.stat(dir); } catch { exists = false; }
		if (!exists) {
			await fsp.createDirectory(dir);
			await fsp.writeFile(vscode.Uri.from({ scheme: SCHEME, path: HOME + '/README.md' }), new TextEncoder().encode(WELCOME), { create: true, overwrite: false });
			return true;
		}
	} catch (e) { /* seeding is a courtesy */ }
	return false;
}

async function activate(context) {
	// These do not need the scratch store: a browser that refuses IndexedDB (the message below says to open a folder
	// instead) must still have the command that does it, and the layout.
	const startLayout = registerLayout(context);
	context.subscriptions.push(
		vscode.commands.registerCommand('levelcode.web.openLocalFolder', () => openLocalFolder(vscode)),
		vscode.commands.registerCommand('levelcode.web.openScratch', () => vscode.commands.executeCommand(
			'vscode.openFolder', vscode.Uri.from({ scheme: SCHEME, path: HOME }), { forceReuseWindow: true })),
		vscode.commands.registerCommand('levelcode.web.aboutScratch', async () => {
			const open = 'Open folder from your computer';
			const pick = await vscode.window.showInformationMessage(
				'This is your scratch workspace. Its files are saved in this browser on this computer, and nowhere else. To keep them, download them from the Explorer.',
				open);
			if (pick === open) { await vscode.commands.executeCommand('levelcode.web.openLocalFolder'); }
		}),
	);

	let db;
	try { db = await openDb(); }
	catch (e) {
		vscode.window.showWarningMessage('LevelCode could not open browser storage, so the scratch workspace is unavailable. Private windows in some browsers block it. Open a folder from your computer instead.');
		startLayout();
		return;
	}
	const fsp = new ScratchFileSystem(db);
	context.subscriptions.push(vscode.workspace.registerFileSystemProvider(SCHEME, fsp, { isCaseSensitive: true }));

	await seedWelcome(fsp);

	// Search is a proposed API; this extension is built in and declares it (package.json).
	if (typeof vscode.workspace.registerFileSearchProvider === 'function') {
		const search = new ScratchSearch(fsp);
		context.subscriptions.push(
			vscode.workspace.registerFileSearchProvider(SCHEME, search),
			vscode.workspace.registerTextSearchProvider(SCHEME, search),
		);
	}

	const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
	item.text = '$(archive) Scratch';
	item.tooltip = 'Scratch workspace: files are saved in this browser only.';
	item.command = 'levelcode.web.aboutScratch';
	const inScratch = () => (vscode.workspace.workspaceFolders || []).some((f) => f.uri.scheme === SCHEME);
	const refresh = () => { if (inScratch()) { item.show(); } else { item.hide(); } };
	refresh();
	context.subscriptions.push(item, vscode.workspace.onDidChangeWorkspaceFolders(refresh));

	// Last: the layout looks for the scratch workspace's README, so the file system has to be there.
	startLayout();
}

/* ----- layout ----------------------------------------------------------------------------- */

/** The view type the workbench gives LevelCode's chat panel (the key workbench.editor.autoLockGroups is set with). */
const CHAT_VIEW_TYPE = 'mainThreadWebview-levelcode.ai.chat';
const LAYOUTS = ['chatFirst', 'split'];
/** Set once per workspace, when the first layout has been applied (the workbench remembers its own state per workspace). */
const APPLIED_KEY = 'levelcode.web.layoutApplied';
/** How long to wait for the chat tab to exist before arranging around it. */
const CHAT_WAIT_MS = 2500;

/**
 * The tab group holding LevelCode's chat, if it is open.
 * @param {typeof import('vscode')} api
 */
function chatGroup(api) {
	for (const g of api.window.tabGroups.all) {
		for (const t of g.tabs) {
			const input = t.input;
			if (input && typeof input === 'object' && input.viewType === CHAT_VIEW_TYPE) { return g; }
		}
	}
	return undefined;
}

/**
 * The chat's group, waiting for it if it is not there yet. `levelcode.ai.focus` returns before the extension host
 * has been told about the new tab, and on a cold start the chat is opened by another extension a moment after
 * this one is running, so the tab model is read when it changes, not at a guessed time.
 * @param {typeof import('vscode')} api
 * @param {number} ms
 */
function whenChatGroup(api, ms) {
	const now = chatGroup(api);
	const tabs = api.window.tabGroups;
	if (now || !tabs.onDidChangeTabs) { return Promise.resolve(now); }
	return new Promise((resolve) => {
		let sub;
		let timer;
		const finish = () => { clearTimeout(timer); if (sub) { sub.dispose(); } resolve(chatGroup(api)); };
		timer = setTimeout(finish, ms);
		sub = tabs.onDidChangeTabs(() => { if (chatGroup(api)) { finish(); } });
	});
}

/** Whether the chat is the tab on show in the group that has the focus: the editor the move commands act on. */
function chatIsActive(api) {
	const g = api.window.tabGroups.activeTabGroup;
	const t = g && g.activeTab;
	const input = t && t.input;
	return !!(input && typeof input === 'object' && input.viewType === CHAT_VIEW_TYPE);
}

/**
 * Wait for the chat to be the active editor. `levelcode.ai.focus` returns when the panel is revealed, not when the
 * workbench has made it the active editor, and the move commands act on the active editor: moved too early they
 * move the file next to it (or nothing). Gives up after `ms` and goes on — the layout is a courtesy.
 * @param {typeof import('vscode')} api
 * @param {number} ms
 */
function whenChatActive(api, ms) {
	const tabs = api.window.tabGroups;
	if (!tabs.activeTabGroup || chatIsActive(api) || !tabs.onDidChangeTabs) { return Promise.resolve(); }
	return new Promise((resolve) => {
		let timer;
		const subs = [];
		const finish = () => { clearTimeout(timer); subs.forEach((d) => d.dispose()); resolve(); };
		timer = setTimeout(finish, ms);
		const check = () => { if (chatIsActive(api)) { finish(); } };
		subs.push(tabs.onDidChangeTabs(check));
		if (tabs.onDidChangeTabGroups) { subs.push(tabs.onDidChangeTabGroups(check)); }
	});
}

/** Each arrangement takes a number; one that finds a newer number has been overtaken by a later choice and stops. */
let generation = 0;

/**
 * Arrange the window for one of the two ways of working:
 *   chatFirst  the chat alone, in the middle, with its conversation list on its left — the way a chat app is used
 *   split      the Explorer, the files, and the chat docked on the right — the way an editor is used
 * Only existing workbench commands are used, so the layout the user then adjusts by hand is an ordinary one.
 *
 * @param {typeof import('vscode')} api
 * @param {'chatFirst'|'split'} mode
 * @param {{ explorer?: boolean, waitMs?: number }} [opts] explorer: reveal the Explorer in `split` (default; a start-up
 *   passes false so that an Explorer the visitor closed stays closed, and the focus is not taken from the composer)
 */
async function applyLayout(api, mode, opts = {}) {
	// Two arrangements can be in flight (the start-up one is waiting for the chat to appear when the visitor clicks
	// the switch): the later choice wins, and the earlier one must not resume and put things back.
	const mine = ++generation;
	const run = async (id, ...args) => { if (mine === generation) { await api.commands.executeCommand(id, ...args); } };
	await run('levelcode.ai.focus');   // the chat, taking the focus, in whichever group it is (or the active one)
	const waitMs = opts.waitMs === undefined ? CHAT_WAIT_MS : opts.waitMs;
	const group = await whenChatGroup(api, waitMs);
	if (group) { await whenChatActive(api, Math.min(waitMs, 1500)); }
	if (mine !== generation) { return; }
	const columns = () => api.window.tabGroups.all.map((g) => g.viewColumn);
	if (mode === 'chatFirst') {
		// Bring the chat back from a side group, and put the side bars away: the page is the conversation.
		const all = api.window.tabGroups.all;
		if (group && all.length > 1 && group.viewColumn !== Math.min(...columns())) { await run('workbench.action.moveEditorToFirstGroup'); }
		// A reload brings back the groups it had; an empty one would take half the window.
		const left = api.window.tabGroups.all;
		const empty = left.filter((g) => g.tabs.length === 0);
		if (empty.length && empty.length < left.length && api.window.tabGroups.close && mine === generation) { await api.window.tabGroups.close(empty); }
		await run('workbench.action.closeSidebar');
		await run('workbench.action.closePanel');
		await run('workbench.action.closeAuxiliaryBar');
		return;
	}
	// split: the chat in a group of its own on the right (the setting locks it there, so files open beside it),
	// the Explorer on the left, and a file in the group that is left. The file comes FIRST: a group that is
	// emptied by moving the chat out of it is closed, and the chat would be alone again.
	const groups = api.window.tabGroups.all;
	if (group && groups.length < 2) {
		const found = await api.workspace.findFiles('README.md', undefined, 1);
		if (mine !== generation) { return; }
		if (found.length) { await api.window.showTextDocument(found[0], { viewColumn: api.ViewColumn.One, preserveFocus: true, preview: false }); }
		await run('levelcode.ai.focus');
		await run('workbench.action.moveEditorToRightGroup');
	} else if (group && group.tabs.length > 1 && group.viewColumn !== Math.max(...columns())) {
		// A reload brings the two groups back, but the chat is opened again in the first of them, next to a file
		// (the right one is empty and, being empty, not the place the setting that keeps files out of the chat's
		// group has had a chance to claim). Dock it.
		await run('workbench.action.moveEditorToRightGroup');
	}
	if (opts.explorer !== false) { await run('workbench.view.explorer'); }
}

/** @param {typeof import('vscode')} api */
function currentLayout(api) {
	const v = api.workspace.getConfiguration('levelcode.web').get('layout', 'chatFirst');
	return LAYOUTS.includes(v) ? v : 'chatFirst';
}

/**
 * What to do at start-up. The first time in a workspace the chosen layout is applied (the Explorer included); after
 * that only a docked layout is, because the chat panel is not restored by a reload and the workbench remembers
 * everything else — a side bar the visitor closed stays closed.
 *
 * @param {typeof import('vscode')} api
 * @param {{ get(k: string): any, update(k: string, v: any): Thenable<void> }} state the workspace's own state
 * @param {{ waitMs?: number }} [opts]
 */
async function applyAtStart(api, state, opts = {}) {
	const mode = currentLayout(api);
	const first = !state.get(APPLIED_KEY);
	if (mode === 'split' || first) { await applyLayout(api, mode, { explorer: first, waitMs: opts.waitMs }); }
	await state.update(APPLIED_KEY, true);
}

/**
 * The layout switch: a status-bar item and three commands. The commands only change the setting; one listener
 * applies it, so the same thing happens whether it was chosen here, in a menu or in Settings.
 * @param {import('vscode').ExtensionContext} context
 * @returns {() => void} start-up: arranges the window once the rest of the extension is ready
 */
function registerLayout(context) {
	const layoutItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 49);
	layoutItem.command = 'levelcode.web.layout.toggle';
	const showLayout = () => {
		const mode = currentLayout(vscode);
		layoutItem.text = mode === 'split' ? '$(layout-sidebar-right) Editor + chat' : '$(layout-centered) Chat';
		layoutItem.tooltip = mode === 'split'
			? 'Layout: Explorer, files and the chat on the right. Click for the chat on its own.'
			: 'Layout: the chat on its own. Click for Explorer, files and the chat on the right.';
	};
	showLayout();
	layoutItem.show();
	const setLayout = (mode) => vscode.workspace.getConfiguration('levelcode.web').update('layout', mode, vscode.ConfigurationTarget.Global);
	context.subscriptions.push(
		layoutItem,
		vscode.workspace.onDidChangeConfiguration((e) => {
			if (!e.affectsConfiguration('levelcode.web.layout')) { return; }
			showLayout();
			applyLayout(vscode, currentLayout(vscode)).catch(() => undefined);
		}),
		vscode.commands.registerCommand('levelcode.web.layout.chatFirst', async () => {
			if (currentLayout(vscode) === 'chatFirst') { await applyLayout(vscode, 'chatFirst'); } else { await setLayout('chatFirst'); }
		}),
		vscode.commands.registerCommand('levelcode.web.layout.split', async () => {
			if (currentLayout(vscode) === 'split') { await applyLayout(vscode, 'split'); } else { await setLayout('split'); }
		}),
		vscode.commands.registerCommand('levelcode.web.layout.toggle', () => setLayout(currentLayout(vscode) === 'split' ? 'chatFirst' : 'split')),
	);
	return () => { applyAtStart(vscode, context.workspaceState).catch(() => { /* the window is usable as it is */ }); };
}

/**
 * Open a folder from the user's computer: the browser's own directory picker, then that folder as the workspace.
 *
 * The workbench chooses between its own file browser and the browser's picker by the SCHEME of the default
 * location, and from inside the scratch workspace that scheme is this extension's: `File: Open Folder` would show
 * the scratch workspace's own folders and never reach the picker. A dialog that starts from the `file` scheme —
 * which the web workbench serves with the File System Access handles the user picks — does. A browser without
 * File System Access (Safari, Firefox) is told so by the workbench itself, and nothing here runs after that.
 *
 * @param {typeof import('vscode')} api
 * @returns {Promise<boolean>} true when a folder was opened; false when the user cancelled
 */
async function openLocalFolder(api) {
	const picked = await api.window.showOpenDialog({
		canSelectFolders: true,
		canSelectFiles: false,
		canSelectMany: false,
		defaultUri: api.Uri.from({ scheme: 'file', path: '/' }),
		openLabel: 'Open Folder',
		title: 'Open a folder from your computer',
	});
	if (!picked || picked.length === 0) { return false; }
	// Choosing a folder is choosing to work on its files: the window that comes back has the Explorer and the chat
	// beside the files, not the chat alone with the folder out of sight. One click on the status bar undoes it.
	try { await api.workspace.getConfiguration('levelcode.web').update('layout', 'split', api.ConfigurationTarget.Global); } catch { /* the layout is a courtesy */ }
	await api.commands.executeCommand('vscode.openFolder', picked[0], { forceReuseWindow: true });
	return true;
}

function deactivate() { }

module.exports = { activate, deactivate, openLocalFolder, applyLayout, applyAtStart, currentLayout, chatGroup, whenChatGroup, whenChatActive, LAYOUTS, APPLIED_KEY };
