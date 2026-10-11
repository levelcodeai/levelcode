/*---------------------------------------------------------------------------------------------
 *  Stand-ins for what web/shell/src/runtime.js is given, so its suites run under plain node:
 *
 *    createClock()      a clock whose timers only fire when the test advances it (the runtime's every timer
 *                       goes through deps.setTimeout)
 *    createWorkspace()  a Map-backed vscode.workspace.fs with the error shapes of the real one (FileSystemError
 *                       with `code` 'FileNotFound' and `name` 'EntryNotFound (FileSystemError)'), failure and
 *                       hang injection, a call log, and workspaceFolders with the change event
 *    createEngines()    a factory of fake engine workers that speak README section 4: they answer `init`, run a
 *                       script the test writes with the engine-side helpers (fs read, out, done), and can
 *                       crash, hang, or keep talking after they were terminated
 *
 *  Test code only: nothing here is the product.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

/** Let promises and immediates settle. */
async function flush() {
	for (let i = 0; i < 10; i++) { await Promise.resolve(); }
	await new Promise((r) => setImmediate(r));
	for (let i = 0; i < 10; i++) { await Promise.resolve(); }
}

function createClock() {
	let t = 1000000;
	let seq = 0;
	/** @type {Map<number, { at: number, fn: () => void }>} */ const timers = new Map();
	return {
		now: () => t,
		setTimeout(/** @type {() => void} */ fn, /** @type {number} */ ms) { const id = ++seq; timers.set(id, { at: t + ms, fn }); return id; },
		clearTimeout(/** @type {any} */ id) { timers.delete(id); },
		/** How many timers are waiting. */
		get pending() { return timers.size; },
		/** Move time forward, running what falls due in order, and let what that sets off settle. */
		async advance(/** @type {number} */ ms) {
			const end = t + ms;
			for (;;) {
				await flush();
				/** @type {[number, { at: number, fn: () => void }]|null} */ let next = null;
				for (const e of timers) { if (e[1].at <= end && (!next || e[1].at < next[1].at)) { next = e; } }
				if (!next) { break; }
				timers.delete(next[0]);
				t = Math.max(t, next[1].at);
				next[1].fn();
			}
			t = end;
			await flush();
		},
	};
}

/* ----- vscode ---------------------------------------------------------------------------------- */

class Uri {
	constructor(scheme, authority, path, query = '', fragment = '') { this.scheme = scheme; this.authority = authority; this.path = path; this.query = query; this.fragment = fragment; }
	static parse(/** @type {string} */ s) {
		const m = /^([a-zA-Z][\w+.-]*):(?:\/\/([^/?#]*))?([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/.exec(s);
		if (!m) { throw new Error('bad uri: ' + s); }
		return new Uri(m[1], m[2] || '', m[3] || '/', m[4] || '', m[5] || '');
	}
	static joinPath(/** @type {Uri} */ base, /** @type {string[]} */ ...parts) { return base.with({ path: base.path.replace(/\/$/, '') + '/' + parts.join('/') }); }
	with(/** @type {any} */ c) {
		return new Uri(c.scheme !== undefined ? c.scheme : this.scheme, c.authority !== undefined ? c.authority : this.authority,
			c.path !== undefined ? c.path : this.path, c.query !== undefined ? c.query : this.query, c.fragment !== undefined ? c.fragment : this.fragment);
	}
	get fsPath() { return this.path; }
	toString() { return this.scheme + '://' + this.authority + this.path + (this.query ? '?' + this.query : '') + (this.fragment ? '#' + this.fragment : ''); }
}

class FileSystemError extends Error {
	constructor(/** @type {string} */ code, /** @type {string} */ providerCode, /** @type {string} */ message) {
		super(message);
		this.code = code;
		this.name = providerCode + ' (FileSystemError)';
	}
}
const fsErrors = {
	FileNotFound: (/** @type {string} */ m) => new FileSystemError('FileNotFound', 'EntryNotFound', 'Unable to read ' + m),
	FileExists: (/** @type {string} */ m) => new FileSystemError('FileExists', 'EntryExists', 'exists: ' + m),
	FileNotADirectory: (/** @type {string} */ m) => new FileSystemError('FileNotADirectory', 'EntryNotADirectory', 'not a directory: ' + m),
	FileIsADirectory: (/** @type {string} */ m) => new FileSystemError('FileIsADirectory', 'EntryIsADirectory', 'is a directory: ' + m),
	NoPermissions: (/** @type {string} */ m) => new FileSystemError('NoPermissions', 'NoPermissions', 'no permissions: ' + m),
};

const File = 1, Directory = 2;
const te = new TextEncoder();
const td = new TextDecoder();

/**
 * @param {{ folders?: Array<{ name: string, uri: string }> }} [o]
 */
function createWorkspace(o) {
	/** @type {Map<string, { type: number, data: Uint8Array, mtime: number }>} */ const nodes = new Map();
	/** @type {string[]} */ const calls = [];
	/** @type {Array<{ op: string, match: (key: string) => boolean, error?: any, hang?: boolean }>} */ const rules = [];
	/** @type {Array<() => void>} */ const folderListeners = [];
	let mtime = 1;
	const key = (/** @type {Uri} */ u) => u.scheme + ':' + (u.path.length > 1 && u.path.endsWith('/') ? u.path.slice(0, -1) : u.path);
	const parentKey = (/** @type {string} */ k) => { const i = k.lastIndexOf('/'); return i <= k.indexOf(':') + 1 ? k.slice(0, k.indexOf(':') + 1) + '/' : k.slice(0, i); };
	const childrenOf = (/** @type {string} */ k) => {
		const pre = k.endsWith('/') ? k : k + '/';
		return Array.from(nodes.keys()).filter((n) => n.startsWith(pre) && !n.slice(pre.length).includes('/'));
	};
	/** Is a file on the way to `k`? (what a real disk answers ENOTDIR for) */
	function underAFile(/** @type {string} */ k) {
		const floor = k.indexOf(':') + 1;
		for (let p = parentKey(k); p.length > floor + 1 && p !== parentKey(p); p = parentKey(p)) {
			const n = nodes.get(p);
			if (n && n.type === File) { return true; }
		}
		return false;
	}
	async function enter(/** @type {string} */ op, /** @type {Uri} */ uri) {
		const k = key(uri);
		calls.push(op + ' ' + k);
		await Promise.resolve();
		for (const r of rules) {
			if (r.op === op && r.match(k)) {
				if (r.hang) { await new Promise(() => { }); }
				if ('error' in r) { throw r.error; }   // whatever it is: `undefined`, a string and a number are thrown too
			}
		}
		return k;
	}
	function mkdirp(/** @type {string} */ k) {
		const scheme = k.slice(0, k.indexOf(':') + 1);
		const path = k.slice(scheme.length);
		if (path === '/' || path === '') { return; }
		const n = nodes.get(k);
		if (n) { if (n.type !== Directory) { throw fsErrors.FileNotADirectory(k); } return; }
		mkdirp(parentKey(k));
		nodes.set(k, { type: Directory, data: new Uint8Array(0), mtime: mtime++ });
	}
	const fs = {
		async stat(/** @type {Uri} */ uri) {
			const k = await enter('stat', uri);
			if (uri.path === '/') { return { type: Directory, ctime: 0, mtime: 0, size: 0 }; }
			if (underAFile(k)) { throw fsErrors.FileNotADirectory(k); }
			const n = nodes.get(k);
			if (!n) { throw fsErrors.FileNotFound(k); }
			return { type: n.type, ctime: n.mtime, mtime: n.mtime, size: n.type === File ? n.data.length : 0 };
		},
		async readDirectory(/** @type {Uri} */ uri) {
			const k = await enter('readDirectory', uri);
			const n = nodes.get(k);
			if (n && n.type !== Directory) { throw fsErrors.FileNotADirectory(k); }
			if (!n && uri.path !== '/') { throw fsErrors.FileNotFound(k); }
			return childrenOf(k).map((c) => /** @type {[string, number]} */ ([c.slice(c.lastIndexOf('/') + 1), /** @type {any} */ (nodes.get(c)).type]));
		},
		async readFile(/** @type {Uri} */ uri) {
			const k = await enter('readFile', uri);
			const n = nodes.get(k);
			if (!n) { throw fsErrors.FileNotFound(k); }
			if (n.type === Directory) { throw fsErrors.FileIsADirectory(k); }
			return n.data;
		},
		async writeFile(/** @type {Uri} */ uri, /** @type {Uint8Array} */ bytes) {
			const k = await enter('writeFile', uri);
			const n = nodes.get(k);
			if (n && n.type === Directory) { throw fsErrors.FileIsADirectory(k); }
			mkdirp(parentKey(k));
			nodes.set(k, { type: File, data: bytes.slice(), mtime: mtime++ });
		},
		async createDirectory(/** @type {Uri} */ uri) {
			const k = await enter('createDirectory', uri);
			mkdirp(k);
		},
		async delete(/** @type {Uri} */ uri, /** @type {{ recursive?: boolean }} */ opts) {
			const k = await enter('delete', uri);
			const n = nodes.get(k);
			if (!n) { throw fsErrors.FileNotFound(k); }
			if (n.type === Directory) {
				const kids = childrenOf(k);
				if (kids.length > 0 && !(opts && opts.recursive)) { throw fsErrors.NoPermissions(k); }
				for (const c of Array.from(nodes.keys())) { if (c.startsWith(k + '/')) { nodes.delete(c); } }
			}
			nodes.delete(k);
		},
	};

	const folders = (o && o.folders ? o.folders : [{ name: 'scratch', uri: 'levelcode-scratch:///scratch' }]).map((f) => ({ name: f.name, uri: Uri.parse(f.uri) }));
	for (const f of folders) { mkdirp(key(f.uri)); }

	const workspace = {
		fs,
		workspaceFolders: /** @type {any[]} */ (folders),
		onDidChangeWorkspaceFolders(/** @type {() => void} */ fn) {
			folderListeners.push(fn);
			return { dispose() { const i = folderListeners.indexOf(fn); if (i >= 0) { folderListeners.splice(i, 1); } } };
		},
	};
	const vscode = { Uri, FileType: { File, Directory, SymbolicLink: 64 }, workspace };

	/** Make `scheme:/path` (default: the first folder's scheme). */
	const where = (/** @type {string} */ p) => (p.includes(':') ? p : (workspace.workspaceFolders[0] ? workspace.workspaceFolders[0].uri.scheme : 'file') + ':' + p);
	return {
		vscode,
		fs,
		/** every call, in order, as 'op scheme:/path' */
		calls,
		/** @param {string} p @param {string|Uint8Array} content */
		put(p, content) {
			const k = where(p);
			mkdirp(parentKey(k));
			nodes.set(k, { type: File, data: typeof content === 'string' ? te.encode(content) : content.slice(), mtime: mtime++ });
		},
		mkdir(/** @type {string} */ p) { mkdirp(where(p)); },
		/** @returns {string|null} */
		text(/** @type {string} */ p) { const n = nodes.get(where(p)); return n && n.type === File ? td.decode(n.data) : null; },
		bytes(/** @type {string} */ p) { const n = nodes.get(where(p)); return n && n.type === File ? n.data : null; },
		exists(/** @type {string} */ p) { return nodes.has(where(p)); },
		isDir(/** @type {string} */ p) { const n = nodes.get(where(p)); return !!n && n.type === Directory; },
		list(/** @type {string} */ p) { return childrenOf(where(p)).map((c) => c.slice(c.lastIndexOf('/') + 1)).sort(); },
		/** Every following `op` on a path that matches fails with `error`, or never answers. */
		fail(/** @type {string} */ op, /** @type {(k: string) => boolean} */ match, /** @type {any} */ error) { rules.push({ op, match, error }); },
		hang(/** @type {string} */ op, /** @type {(k: string) => boolean} */ match) { rules.push({ op, match, hang: true }); },
		clearRules() { rules.length = 0; },
		setFolders(/** @type {Array<{ name: string, uri: string }>} */ list) {
			workspace.workspaceFolders = list.map((f) => ({ name: f.name, uri: Uri.parse(f.uri) }));
			for (const f of workspace.workspaceFolders) { mkdirp(key(f.uri)); }
			for (const fn of folderListeners.slice()) { fn(); }
		},
		get folderListeners() { return folderListeners.length; },
	};
}

/* ----- engines --------------------------------------------------------------------------------- */

/**
 * @typedef {object} FakeWorker
 * @property {string} source
 * @property {any[]} sent                everything the host posted, in order
 * @property {boolean} terminated
 * @property {(m: any) => void} emit     a message to the host (dropped, like a real one, after terminate)
 * @property {(m: any) => void} emitAlways   one that is delivered even after terminate (a late message)
 */

/**
 * @param {{ commands?: string[] }} [o]
 */
function createEngines(o) {
	/** @type {FakeWorker[]} */ const workers = [];
	/** @type {Error[]} */ const errors = [];
	const state = {
		/** What a script does when the host asks for one; set per test. (run, worker, helpers) */
		onRun: /** @type {(run: any, w: any, h: any) => any} */ (async (run, w, h) => { h.done({ exitCode: 0, how: 'exit' }); }),
		commands: (o && o.commands) || ['cat', 'echo', 'ls', 'sed'],
		/** do not answer `init` */
		noReady: false,
		/** a generation to stamp `ready` with instead of the real one */
		readyGen: /** @type {number|null} */ (null),
		/** throw from createWorker */
		failCreate: /** @type {Error|null} */ (null),
		/** make postMessage throw once it was terminated, like a closed port in some hosts */
		throwAfterTerminate: false,
	};
	let rid = 0;

	function create(/** @type {string} */ source) {
		if (state.failCreate) { throw state.failCreate; }
		/** @type {Map<number, (m: any) => void>} */ const waiting = new Map();
		/** @type {any} */
		let current = null;
		const w = {
			source, sent: [], terminated: false, onerror: null, onmessageerror: null, gen: 0, runs: [],
			/** the handler the host installed first, kept even when the host later sets onmessage to null on terminate */
			firstHandler: null,
			get onmessage() { return current; },
			set onmessage(fn) { current = fn; if (fn && !w.firstHandler) { w.firstHandler = fn; } },
			postMessage(/** @type {any} */ m, /** @type {any[]} */ transfer) {
				if (w.terminated) { if (state.throwAfterTerminate) { throw new Error('port closed'); } return; }
				w.sent.push(m);
				w.transfers = (w.transfers || 0) + (transfer ? transfer.length : 0);
				Promise.resolve().then(() => handle(m));
			},
			terminate() { w.terminated = true; },
			emit(/** @type {any} */ m) { Promise.resolve().then(() => { if (!w.terminated && typeof w.onmessage === 'function') { w.onmessage({ data: m }); } }); },
			/** A message that was already in flight when the worker was terminated: it reaches the host's handler anyway. */
			emitAlways(/** @type {any} */ m) { Promise.resolve().then(() => { if (typeof w.firstHandler === 'function') { w.firstHandler({ data: m }); } }); },
			crash(/** @type {string} */ message) { Promise.resolve().then(() => { if (typeof w.onerror === 'function') { w.onerror({ message, preventDefault() { } }); } }); },
		};
		const helpers = {
			/** A read through the host; resolves with the whole `fsr` message. */
			fs(/** @type {string} */ op, /** @type {string} */ path) {
				const id = ++rid;
				return new Promise((resolve) => { waiting.set(id, resolve); w.emit({ t: 'fs', rid: id, op, path }); });
			},
			/** A read whose answer is not waited for (it may never come). */
			fsNoWait(/** @type {string} */ op, /** @type {string} */ path) { const id = ++rid; w.emit({ t: 'fs', rid: id, op, path }); return id; },
			out(/** @type {number} */ id, /** @type {string} */ stream, /** @type {string} */ text) { w.emit({ t: 'out', id, stream, text }); },
			done(/** @type {any} */ d) { w.emit(Object.assign({ t: 'done', id: w.currentRun, exitCode: 0, how: 'exit', cwd: w.currentCwd, env: {}, changes: [], denied: [], notes: [], stats: {} }, d)); },
		};
		function handle(/** @type {any} */ m) {
			if (m.t === 'init') {
				w.gen = m.gen;
				w.init = m;
				if (!state.noReady) { w.emit({ t: 'ready', gen: state.readyGen === null ? m.gen : state.readyGen, commands: state.commands }); }
			} else if (m.t === 'run') {
				w.currentRun = m.id;
				w.currentCwd = m.cwd;
				w.runs.push(m);
				Promise.resolve().then(() => state.onRun(m, w, helpers)).catch((e) => { errors.push(e); });
			} else if (m.t === 'fsr') {
				const r = waiting.get(m.rid);
				if (r) { waiting.delete(m.rid); r(m); }
			}
		}
		w.helpers = helpers;
		workers.push(w);
		return w;
	}

	return { workers, errors, state, create };
}

/**
 * A runtime wired to all three fakes.
 * @param {{ workspace?: any, engines?: any, limits?: any }} [o]
 */
function createRig(o) {
	const { createRuntime } = require('../../shell/src/runtime');
	const clock = createClock();
	const ws = createWorkspace(o && o.workspace);
	const engines = createEngines(o && o.engines);
	/** @type {Array<[string, any]>} */ const logs = [];
	const state = { loads: 0, loadError: /** @type {Error|null} */ (null) };
	const rt = createRuntime({
		vscode: ws.vscode,
		async loadEngineSource() {
			state.loads++;
			if (state.loadError) { throw state.loadError; }
			return 'engine-source';
		},
		createWorker: engines.create,
		now: clock.now,
		setTimeout: clock.setTimeout,
		clearTimeout: clock.clearTimeout,
		limits: o && o.limits,
		log: (/** @type {string} */ e, /** @type {any} */ d) => { logs.push([e, d]); },
	});
	return { rt, ws, engines, clock, state, logs };
}

module.exports = { flush, createClock, createWorkspace, createEngines, createRig, Uri, FileSystemError, fsErrors };
