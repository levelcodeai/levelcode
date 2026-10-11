// Stand-ins for the terminal tests: a `vscode` with just what the terminal code touches, a session whose runs the
// test completes by hand, and a harness that drives a ShellPty with bytes and reads a terminal model back.
// @ts-check
'use strict';

const path = require('path');
const crypto = require('crypto');

const TERMINAL = path.join(__dirname, '..', '..', '..', 'shell', 'src', 'terminal');
const { VT } = require('./shell-terminal-vt');

class EventEmitter {
	constructor() {
		/** @type {Array<(e: any) => void>} */
		this.listeners = [];
		this.event = (/** @type {(e: any) => void} */ listener) => {
			this.listeners.push(listener);
			return { dispose: () => { this.listeners = this.listeners.filter((l) => l !== listener); } };
		};
	}
	fire(/** @type {any} */ data) { for (const l of this.listeners.slice()) { l(data); } }
	dispose() { this.listeners = []; }
}

class ThemeIcon { constructor(id) { this.id = id; } }
class ThemeColor { constructor(id) { this.id = id; } }
class TerminalProfile { constructor(options) { this.options = options; } }
class Position { constructor(line, character) { this.line = line; this.character = character; } }
class Range { constructor(start, end) { this.start = start; this.end = end; } }
/** The part of vscode.Uri the link provider uses: parse, path, with, toString. */
class Uri {
	constructor(scheme, authority, p) { this.scheme = scheme; this.authority = authority; this.path = p; }
	static parse(/** @type {string} */ s) {
		const m = /^([a-z][a-z0-9+.-]*):\/\/([^/]*)(.*)$/i.exec(s);
		if (!m) { throw new Error('not a uri: ' + s); }
		return new Uri(m[1], m[2], m[3] || '/');
	}
	with(/** @type {{ path?: string }} */ change) { return new Uri(this.scheme, this.authority, change.path === undefined ? this.path : change.path); }
	toString() { return this.scheme + '://' + this.authority + this.path; }
}

/**
 * The parts of `vscode` the terminal support uses. `terminals` records what was created and shown.
 * @param {{ settings?: Record<string, any> }} [o]
 */
function fakeVscode(o) {
	const settings = (o && o.settings) || {};
	const opened = new EventEmitter();
	const closed = new EventEmitter();
	const activeChanged = new EventEmitter();
	const configChanged = new EventEmitter();
	const state = {
		/** @type {any[]} */ terminals: [],
		/** @type {Record<string, Function>} */ commands: {},
		/** @type {Record<string, any>} */ providers: {},
		/** @type {string[]} */ messages: [],
		/** @type {any} */ active: undefined,
		/** @type {any} */ linkProvider: null,
		/** What was opened in an editor: { uri, options }. @type {any[]} */ opened: [],
		/** The uris the fake file system was asked about. @type {string[]} */ stats: [],
		/** What the fake file system has: uri string -> vscode.FileType (0 unknown, 1 file, 2 folder, 64 link, and sums). @type {Record<string, number>} */ files: {},
		/** Commands run through executeCommand. @type {string[]} */ executed: [],
	};
	/** @param {any} options */
	const makeTerminal = (options) => {
		const t = {
			name: options.name,
			creationOptions: options,
			shown: /** @type {boolean[]} */ ([]),
			disposed: false,
			show(/** @type {boolean} */ preserveFocus) { t.shown.push(!!preserveFocus); if (!preserveFocus) { state.active = t; } },
			hide() { /* no-op */ },
			dispose() { t.disposed = true; state.terminals = state.terminals.filter((x) => x !== t); closed.fire(t); },
			sendText() { /* no-op */ },
		};
		return t;
	};
	const vscode = {
		EventEmitter, ThemeIcon, ThemeColor, TerminalProfile, Uri, Position, Range,
		window: {
			createTerminal(/** @type {any} */ options) {
				const t = makeTerminal(options);
				state.terminals.push(t);
				// like the workbench: the pty is opened when the terminal exists
				opened.fire(t);
				return t;
			},
			registerTerminalProfileProvider(/** @type {string} */ id, /** @type {any} */ provider) {
				state.providers[id] = provider;
				return { dispose() { delete state.providers[id]; } };
			},
			registerTerminalLinkProvider(/** @type {any} */ provider) {
				state.linkProvider = provider;
				return { dispose() { state.linkProvider = null; } };
			},
			showTextDocument(/** @type {any} */ uri, /** @type {any} */ options) {
				state.opened.push({ uri: String(uri), options });
				return Promise.resolve({});
			},
			onDidOpenTerminal: opened.event,
			onDidCloseTerminal: closed.event,
			onDidChangeActiveTerminal: activeChanged.event,
			get activeTerminal() { return state.active; },
			get terminals() { return state.terminals; },
			showInformationMessage(/** @type {string} */ m) { state.messages.push(m); return Promise.resolve(undefined); },
		},
		commands: {
			registerCommand(/** @type {string} */ id, /** @type {Function} */ fn) {
				state.commands[id] = fn;
				return { dispose() { delete state.commands[id]; } };
			},
			executeCommand(/** @type {string} */ id, /** @type {any[]} */ ...args) {
				state.executed.push(id + ' ' + args.map(String).join(' '));
				return Promise.resolve(undefined);
			},
		},
		workspace: {
			fs: {
				stat(/** @type {any} */ uri) {
					const key = String(uri);
					state.stats.push(key);
					if (Object.prototype.hasOwnProperty.call(state.files, key)) { return Promise.resolve({ type: state.files[key], size: 1 }); }
					return Promise.reject(Object.assign(new Error('not found'), { code: 'FileNotFound' }));
				},
			},
			getConfiguration(/** @type {string} */ section) {
				return { get: (/** @type {string} */ k, /** @type {any} */ d) => (settings[section + '.' + k] !== undefined ? settings[section + '.' + k] : d) };
			},
			onDidChangeConfiguration: configChanged.event,
		},
	};
	return {
		vscode,
		state,
		settings,
		/** What the workbench does when a terminal made from the profile appears. */
		openProfileTerminal(/** @type {any} */ profile) {
			const t = makeTerminal(profile.options);
			state.terminals.push(t);
			opened.fire(t);
			return t;
		},
		setActive(/** @type {any} */ t) { state.active = t; activeChanged.fire(t); },
		configChanged: (/** @type {string} */ key) => configChanged.fire({ affectsConfiguration: (/** @type {string} */ k) => k === key }),
	};
}

/**
 * What the runtime tells of engine paths (runtime.resolve, runtime.stat), over the fake file system of `fv`: `resolve`
 * is the Uri behind a path (the longest mount that holds it wins; null in no mount) and `stat` is what is at it,
 * `{ type: 'file' | 'dir' | 'other', size }` or null, asked of the fake file system (so `state.stats` lists what was
 * asked). The types are the runtime's: 'dir' for the Directory bit, 'file' for the File bit and for nothing else, and
 * 'other' for what has neither (FileType.Unknown, a link to nothing); a link to a file (File | SymbolicLink) is a 'file'.
 * @param {{ vscode: any }} fv
 * @param {Array<{ mount: string, uri: string }> | (() => Array<{ mount: string, uri: string }>)} mounts
 */
function fakeRuntimeFs(fv, mounts) {
	const list = () => (typeof mounts === 'function' ? mounts() : mounts);
	/** @param {string} p */
	const resolve = (p) => {
		/** @type {{ mount: string, uri: string } | null} */
		let best = null;
		for (const m of list()) {
			const inside = p === m.mount || p.startsWith(m.mount === '/' ? '/' : m.mount + '/');
			if (inside && (!best || m.mount.length > best.mount.length)) { best = m; }
		}
		if (!best) { return null; }
		const base = Uri.parse(best.uri);
		const bp = base.path.endsWith('/') ? base.path.slice(0, -1) : base.path;
		return base.with({ path: (bp + (p === best.mount ? '' : p.slice(best.mount === '/' ? 0 : best.mount.length))) || '/' });
	};
	return {
		resolve,
		/** @param {string} p */
		async stat(p) {
			const uri = resolve(p);
			if (!uri) { return null; }
			try {
				const st = await fv.vscode.workspace.fs.stat(uri);
				return { type: (st.type & 2) !== 0 ? 'dir' : (st.type & 1) !== 0 ? 'file' : 'other', size: st.size };
			} catch (e) {
				return null;
			}
		},
	};
}

/**
 * A session the test completes by hand.
 * @param {{ cwd?: string, complete?: (kind: string, prefix: string) => string[] | Promise<string[]>, onRun?: (p: any, s: any) => void }} [o]
 */
function fakeSession(o) {
	const opts = o || {};
	const s = {
		cwd: opts.cwd || '/scratch',
		env: {},
		/** @type {Array<{ script: string, o: any }>} */ calls: [],
		stops: 0,
		disposed: false,
		/** @type {any} */ pending: null,
		run(/** @type {string} */ script, /** @type {any} */ ro) {
			s.calls.push({ script, o: ro });
			return new Promise((resolve, reject) => {
				s.pending = { resolve, reject, o: ro, script };
				if (opts.onRun) { opts.onRun(s.pending, s); }
			});
		},
		stop() { s.stops++; },
		async complete(/** @type {string} */ kind, /** @type {string} */ prefix) { return opts.complete ? opts.complete(kind, prefix) : []; },
		dispose() { s.disposed = true; },
		/** Finish the pending run. */
		finish(/** @type {Partial<{ exitCode: number, how: string, notes: string[], cwd: string }>} */ r) {
			const p = s.pending;
			s.pending = null;
			if (r && r.cwd) { s.cwd = r.cwd; }
			p.resolve(Object.assign({ exitCode: 0, how: 'exit', notes: [], cwd: s.cwd, applied: 0, durationMs: 1 }, r));
		},
	};
	return s;
}

/** A scheduler and a clock the test moves by hand. */
function manualTimers() {
	let now = 1000000;
	/** @type {Array<{ at: number, fn: () => void, id: number, cancelled: boolean }>} */
	const timers = [];
	/** @type {Array<() => void>} */
	const tasks = [];
	let nextId = 1;
	return {
		now: () => now,
		setTimeout(/** @type {() => void} */ fn, /** @type {number} */ ms) { const t = { at: now + ms, fn, id: nextId++, cancelled: false }; timers.push(t); return t; },
		clearTimeout(/** @type {any} */ t) { if (t) { t.cancelled = true; } },
		schedule(/** @type {() => void} */ fn) { tasks.push(fn); },
		/** Run the macrotasks that are queued, until none are (what the event loop does between awaits). */
		drain() { let guard = 0; while (tasks.length && guard++ < 100000) { /** @type {() => void} */ (tasks.shift())(); } },
		/** Run one macrotask. */
		step() { const f = tasks.shift(); if (f) { f(); } return !!f; },
		queued: () => tasks.length,
		advance(/** @type {number} */ ms) {
			now += ms;
			for (;;) {
				const due = timers.filter((t) => !t.cancelled && t.at <= now).sort((a, b) => a.at - b.at)[0];
				if (!due) { break; }
				due.cancelled = true;
				due.fn();
			}
		},
		timers: () => timers.filter((t) => !t.cancelled).length,
	};
}

const settle = () => new Promise((r) => setTimeout(r, 0));

/**
 * A ShellPty on fakes, with a terminal model fed by its output.
 * @param {{ cols?: number, rows?: number, cwd?: string, folders?: any[], info?: any, session?: any, history?: any, open?: boolean | { columns: number, rows: number } | undefined, outputLimit?: number, getRandomValues?: any, onInput?: () => void, onCwd?: (cwd: string) => void, complete?: any }} [o]
 */
function makePty(o) {
	const opts = o || {};
	const { ShellPty } = require(path.join(TERMINAL, 'pty.js'));
	const { createHistory } = require(path.join(TERMINAL, 'history.js'));
	const sanitize = require(path.join(TERMINAL, '..', 'sanitize.js'));
	const fv = fakeVscode();
	const timers = manualTimers();
	const session = opts.session || fakeSession({ cwd: opts.cwd, complete: opts.complete });
	const history = opts.history || createHistory({});
	const cols = opts.cols || 60;
	const rows = opts.rows || 12;
	const folders = opts.folders || [{ name: 'scratch', root: '/scratch', uri: 'file:///scratch' }];
	const pty = new ShellPty({
		vscode: fv.vscode,
		session,
		history,
		sanitize,
		folders: () => folders,
		info: opts.info || { commands: ['cat', 'echo', 'grep', 'ls'] },
		getRandomValues: opts.getRandomValues || ((/** @type {Uint8Array} */ a) => crypto.webcrypto.getRandomValues(a)),
		schedule: timers.schedule,
		setTimeout: timers.setTimeout,
		clearTimeout: timers.clearTimeout,
		outputLimit: opts.outputLimit,
		onInput: opts.onInput,
		onCwd: opts.onCwd,
	});
	const vt = new VT(cols, rows);
	/** @type {string[]} */ const writes = [];
	/** @type {number[]} */ const closed = [];
	pty.onDidWrite((/** @type {string} */ d) => { writes.push(d); vt.write(d); });
	pty.onDidClose((/** @type {number} */ c) => closed.push(c));
	if (opts.open !== false) { pty.open(opts.open === undefined ? { columns: cols, rows } : /** @type {any} */ (opts.open)); }
	return {
		pty, session, history, vt, writes, closed, timers, fv, folders, cols, rows,
		all: () => writes.join(''),
		/** Type: bytes as handleInput gets them, then let the macrotasks run. */
		type(/** @type {string[]} */ ...chunks) { for (const c of chunks) { pty.handleInput(c); } timers.drain(); },
		screen: () => vt.text(),
	};
}

module.exports = { EventEmitter, Uri, fakeVscode, fakeRuntimeFs, fakeSession, manualTimers, makePty, settle, VT, TERMINAL };
