// `fs` for the browser build of the extension.
//
// The extension keeps private state (sessions, memory, images, sketches) and reads its own
// resources (media/chat.html, skills/, diagram modules) through synchronous Node `fs`. A browser
// has no such file system, and a synchronous API cannot sit on top of IndexedDB. So this is a
// small in-memory tree with the synchronous surface the extension uses, made durable by writing
// changes behind to IndexedDB, and loaded back once before the extension activates (`ready`).
//
//   - private state   lives under os.homedir() ("/home/levelcode"); it survives reloads.
//   - the extension's own files are mounted read-only at ctx.extensionPath (mountAssets), from
//     the files the build embedded.
//   - the USER'S WORKSPACE is not here and must never be: it is reached through
//     vscode.workspace.fs (host.js), which is asynchronous because the real files are.
//
// Only what the extension calls is implemented. Anything else throws ENOSYS so a new call fails
// loudly in a test rather than quietly returning nothing.
'use strict';

const { Buffer } = require('buffer');
const pathMod = require('./path');

const DB_NAME = 'levelcode-ai-fs';
const DB_VERSION = 1;
const STORE = 'files';
const FLUSH_MS = 150;

/** @type {Map<string, {data: Uint8Array, mtimeMs: number, ctimeMs: number, readonly?: boolean}>} */
const files = new Map();
/** @type {Set<string>} */
const dirs = new Set(['/']);
const dirty = new Set();
const removed = new Set();
let flushTimer = null;
let db = null;
let persistent = false;

function err(code, syscall, p, extra) {
	const text = {
		ENOENT: 'no such file or directory',
		EEXIST: 'file already exists',
		ENOTDIR: 'not a directory',
		EISDIR: 'illegal operation on a directory',
		ENOTEMPTY: 'directory not empty',
		EROFS: 'read-only file system',
		ENOSYS: 'function not implemented',
	}[code] || code;
	const e = new Error(`${code}: ${text}, ${syscall} '${p}'${extra ? ' -> ' + extra : ''}`);
	e.code = code;
	e.syscall = syscall;
	e.path = p;
	e.errno = { ENOENT: -2, EEXIST: -17, ENOTDIR: -20, EISDIR: -21, ENOTEMPTY: -39, EROFS: -30, ENOSYS: -38 }[code];
	return e;
}

function abs(p) {
	if (p && typeof p === 'object' && typeof p.pathname === 'string') { p = decodeURIComponent(p.pathname); } // file: URL
	if (typeof p !== 'string' || p === '') { throw err('ENOENT', 'open', String(p)); }
	return pathMod.resolve('/', p);
}

function toBytes(data, encoding) {
	if (typeof data === 'string') { return Buffer.from(data, encoding || 'utf8'); }
	if (data instanceof Uint8Array) { return data; }
	if (data instanceof ArrayBuffer) { return new Uint8Array(data); }
	if (ArrayBuffer.isView(data)) { return new Uint8Array(data.buffer, data.byteOffset, data.byteLength); }
	return Buffer.from(String(data));
}

function encodingOf(opts) { return typeof opts === 'string' ? opts : (opts && opts.encoding) || null; }

function parentOf(p) { return pathMod.dirname(p); }

function ensureDirs(p) {
	// Every ancestor of `p` (not p itself) becomes a directory.
	let cur = parentOf(p);
	const chain = [];
	while (!dirs.has(cur)) { chain.push(cur); cur = parentOf(cur); }
	for (const d of chain) {
		if (files.has(d)) { throw err('ENOTDIR', 'mkdir', d); }
		dirs.add(d);
	}
}

function markDirty(p) { removed.delete(p); dirty.add(p); scheduleFlush(); }
function markRemoved(p) { dirty.delete(p); removed.add(p); scheduleFlush(); }

/* ----- sync API ---------------------------------------------------------------------------- */

function existsSync(p) {
	try { const a = abs(p); return files.has(a) || dirs.has(a); } catch { return false; }
}

function readFileSync(p, opts) {
	const a = abs(p);
	const f = files.get(a);
	if (!f) { throw dirs.has(a) ? err('EISDIR', 'read', a) : err('ENOENT', 'open', a); }
	const enc = encodingOf(opts);
	const buf = Buffer.from(f.data.buffer, f.data.byteOffset, f.data.byteLength);
	return enc ? buf.toString(enc) : Buffer.from(buf); // a copy: callers may mutate
}

function writeFileSync(p, data, opts) {
	const a = abs(p);
	if (dirs.has(a)) { throw err('EISDIR', 'open', a); }
	const existing = files.get(a);
	if (existing && existing.readonly) { throw err('EROFS', 'open', a); }
	ensureDirs(a);
	const now = Date.now();
	const bytes = toBytes(data, encodingOf(opts));
	files.set(a, { data: Uint8Array.from(bytes), mtimeMs: now, ctimeMs: existing ? existing.ctimeMs : now });
	markDirty(a);
}

function appendFileSync(p, data, opts) {
	const a = abs(p);
	const existing = files.get(a);
	if (!existing) { return writeFileSync(a, data, opts); }
	if (existing.readonly) { throw err('EROFS', 'open', a); }
	const add = toBytes(data, encodingOf(opts));
	const merged = new Uint8Array(existing.data.length + add.length);
	merged.set(existing.data, 0);
	merged.set(add, existing.data.length);
	existing.data = merged;
	existing.mtimeMs = Date.now();
	markDirty(a);
}

function mkdirSync(p, opts) {
	const a = abs(p);
	const recursive = !!(opts && typeof opts === 'object' && opts.recursive);
	if (files.has(a)) { throw err('EEXIST', 'mkdir', a); }
	if (dirs.has(a)) { if (recursive) { return undefined; } throw err('EEXIST', 'mkdir', a); }
	if (!recursive && !dirs.has(parentOf(a))) { throw err('ENOENT', 'mkdir', a); }
	ensureDirs(a);
	dirs.add(a);
	markDirty(a + '/');
	return recursive ? a : undefined;
}

function childrenOf(a) {
	const prefix = a === '/' ? '/' : a + '/';
	const names = new Map();
	for (const f of files.keys()) {
		if (f.startsWith(prefix)) { const rest = f.slice(prefix.length); const i = rest.indexOf('/'); const n = i < 0 ? rest : rest.slice(0, i); if (n) { names.set(n, i < 0 ? 'file' : 'dir'); } }
	}
	for (const d of dirs) {
		if (d !== a && d.startsWith(prefix)) { const rest = d.slice(prefix.length); const i = rest.indexOf('/'); const n = i < 0 ? rest : rest.slice(0, i); if (n) { names.set(n, 'dir'); } }
	}
	return names;
}

function readdirSync(p, opts) {
	const a = abs(p);
	if (!dirs.has(a)) { throw files.has(a) ? err('ENOTDIR', 'scandir', a) : err('ENOENT', 'scandir', a); }
	const names = [...childrenOf(a).entries()].sort((x, y) => (x[0] < y[0] ? -1 : 1));
	if (opts && typeof opts === 'object' && opts.withFileTypes) {
		return names.map(([name, kind]) => ({ name, isFile: () => kind === 'file', isDirectory: () => kind === 'dir', isSymbolicLink: () => false }));
	}
	return names.map(([name]) => name);
}

function makeStats(kind, f) {
	const m = f ? f.mtimeMs : 0;
	const c = f ? f.ctimeMs : 0;
	return {
		size: f ? f.data.length : 0,
		mode: kind === 'dir' ? 0o40755 : 0o100644,
		mtimeMs: m, ctimeMs: c, atimeMs: m, birthtimeMs: c,
		mtime: new Date(m), ctime: new Date(c), atime: new Date(m), birthtime: new Date(c),
		isFile: () => kind === 'file',
		isDirectory: () => kind === 'dir',
		isSymbolicLink: () => false,
	};
}
function statSync(p, opts) {
	const a = abs(p);
	const f = files.get(a);
	if (f) { return makeStats('file', f); }
	if (dirs.has(a)) { return makeStats('dir', null); }
	if (opts && opts.throwIfNoEntry === false) { return undefined; }
	throw err('ENOENT', 'stat', a);
}

function realpathSync(p) { const a = abs(p); if (!files.has(a) && !dirs.has(a)) { throw err('ENOENT', 'realpath', a); } return a; }

function unlinkSync(p) {
	const a = abs(p);
	const f = files.get(a);
	if (!f) { throw dirs.has(a) ? err('EISDIR', 'unlink', a) : err('ENOENT', 'unlink', a); }
	if (f.readonly) { throw err('EROFS', 'unlink', a); }
	files.delete(a);
	markRemoved(a);
}

function rmSync(p, opts) {
	const a = abs(p);
	const recursive = !!(opts && opts.recursive);
	const force = !!(opts && opts.force);
	if (files.has(a)) { return unlinkSync(a); }
	if (dirs.has(a)) {
		const kids = childrenOf(a);
		if (kids.size && !recursive) { throw err('ENOTEMPTY', 'rm', a); }
		const prefix = a === '/' ? '/' : a + '/';
		for (const f of [...files.keys()]) { if (f.startsWith(prefix)) { if (files.get(f).readonly) { throw err('EROFS', 'rm', f); } files.delete(f); markRemoved(f); } }
		for (const d of [...dirs]) { if (d === a || d.startsWith(prefix)) { if (d !== '/') { dirs.delete(d); markRemoved(d + '/'); } } }
		return undefined;
	}
	if (force) { return undefined; }
	throw err('ENOENT', 'rm', a);
}

function renameSync(from, to) {
	const a = abs(from);
	const b = abs(to);
	const f = files.get(a);
	if (f) {
		if (f.readonly) { throw err('EROFS', 'rename', a); }
		if (dirs.has(b)) { throw err('EISDIR', 'rename', b); }
		ensureDirs(b);
		files.delete(a); markRemoved(a);
		files.set(b, Object.assign({}, f, { mtimeMs: Date.now() }));
		markDirty(b);
		return;
	}
	if (dirs.has(a)) {
		const prefix = a + '/';
		ensureDirs(b);
		for (const k of [...files.keys()]) { if (k.startsWith(prefix)) { const v = files.get(k); files.delete(k); markRemoved(k); files.set(b + '/' + k.slice(prefix.length), v); markDirty(b + '/' + k.slice(prefix.length)); } }
		for (const d of [...dirs]) { if (d === a || d.startsWith(prefix)) { dirs.delete(d); markRemoved(d + '/'); const n = b + d.slice(a.length); dirs.add(n); markDirty(n + '/'); } }
		return;
	}
	throw err('ENOENT', 'rename', a, b);
}

function copyFileSync(from, to) {
	const data = readFileSync(from);
	writeFileSync(to, data);
}

/* ----- promises + callbacks, derived from the sync core ----------------------------------- */

const promises = {};
const callbacks = {};
const SYNCS = { readFile: readFileSync, writeFile: writeFileSync, appendFile: appendFileSync, mkdir: mkdirSync, readdir: readdirSync, stat: statSync, lstat: statSync, realpath: realpathSync, unlink: unlinkSync, rm: rmSync, rename: renameSync, copyFile: copyFileSync };
for (const [name, fn] of Object.entries(SYNCS)) {
	promises[name] = (...args) => new Promise((resolve, reject) => { try { resolve(fn(...args)); } catch (e) { reject(e); } });
	callbacks[name] = (...args) => {
		const cb = args.pop();
		if (typeof cb !== 'function') { throw new TypeError('The "cb" argument must be of type function'); }
		let result, error = null;
		try { result = fn(...args); } catch (e) { error = e; }
		setTimeout(() => (error ? cb(error) : cb(null, result)), 0);
	};
}
promises.access = (p) => new Promise((resolve, reject) => (existsSync(p) ? resolve() : reject(err('ENOENT', 'access', abs(p)))));

/* ----- durability --------------------------------------------------------------------------- */

function openDb() {
	return new Promise((resolve, reject) => {
		const req = indexedDB.open(DB_NAME, DB_VERSION);
		req.onupgradeneeded = () => { req.result.createObjectStore(STORE, { keyPath: 'path' }); };
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
	});
}

/**
 * Load what an earlier session saved. The extension must not touch the file system before this
 * resolves, or it would see an empty home directory and overwrite what is stored. Never rejects:
 * where IndexedDB is unavailable (some private windows) the tree is simply session-only.
 */
const ready = (async () => {
	if (typeof indexedDB === 'undefined') { return false; }
	try {
		db = await openDb();
		const rows = await new Promise((resolve, reject) => {
			const req = db.transaction(STORE).objectStore(STORE).getAll();
			req.onsuccess = () => resolve(req.result);
			req.onerror = () => reject(req.error);
		});
		for (const row of rows) {
			if (row.path.endsWith('/')) { dirs.add(row.path.slice(0, -1) || '/'); continue; }
			if (files.has(row.path) && files.get(row.path).readonly) { continue; }
			files.set(row.path, { data: row.data, mtimeMs: row.mtimeMs || 0, ctimeMs: row.ctimeMs || row.mtimeMs || 0 });
			ensureDirs(row.path);
		}
		persistent = true;
		return true;
	} catch (e) {
		db = null;
		return false;
	}
})();

function scheduleFlush() {
	if (!persistent || flushTimer) { return; }
	flushTimer = setTimeout(() => { flushTimer = null; void flush(); }, FLUSH_MS);
}

/** Write pending changes to IndexedDB. Resolves when they are stored (or if there is nowhere to store). */
function flush() {
	if (!persistent || !db) { dirty.clear(); removed.clear(); return Promise.resolve(); }
	const puts = [...dirty];
	const dels = [...removed];
	dirty.clear(); removed.clear();
	if (!puts.length && !dels.length) { return Promise.resolve(); }
	return new Promise((resolve) => {
		try {
			const tx = db.transaction(STORE, 'readwrite');
			const store = tx.objectStore(STORE);
			for (const p of puts) {
				if (p.endsWith('/')) { store.put({ path: p }); continue; }
				const f = files.get(p);
				if (f && !f.readonly) { store.put({ path: p, data: f.data, mtimeMs: f.mtimeMs, ctimeMs: f.ctimeMs }); }
			}
			for (const p of dels) { store.delete(p); }
			tx.oncomplete = () => resolve();
			tx.onerror = () => resolve();
			tx.onabort = () => resolve();
		} catch (e) { resolve(); }
	});
}

/**
 * Mount read-only files under `base`. `assets` maps a path relative to `base` to its content
 * (a string, or {base64}). Called at activation with ctx.extensionPath.
 */
function mountAssets(base, assets) {
	const root = abs(base);
	for (const [rel, value] of Object.entries(assets)) {
		const p = pathMod.join(root, rel);
		const data = typeof value === 'string' ? Buffer.from(value, 'utf8') : Buffer.from(value.base64, 'base64');
		ensureDirs(p);
		files.set(p, { data: Uint8Array.from(data), mtimeMs: 0, ctimeMs: 0, readonly: true });
	}
	dirs.add(root);
}

module.exports = {
	existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync, readdirSync, statSync, lstatSync: statSync,
	realpathSync, unlinkSync, rmSync, rmdirSync: (p, o) => rmSync(p, Object.assign({ recursive: false }, o)), renameSync, copyFileSync,
	promises,
	readFile: callbacks.readFile, writeFile: callbacks.writeFile, appendFile: callbacks.appendFile, mkdir: callbacks.mkdir,
	readdir: callbacks.readdir, stat: callbacks.stat, lstat: callbacks.lstat, unlink: callbacks.unlink, rm: callbacks.rm,
	rename: callbacks.rename, copyFile: callbacks.copyFile,
	// Not part of Node's `fs`: the build's own handles.
	__levelcode: { ready, flush, mountAssets, isPersistent: () => persistent, snapshot: () => ({ files: files.size, dirs: dirs.size }) },
};
