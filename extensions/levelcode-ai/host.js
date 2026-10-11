/*---------------------------------------------------------------------------------------------
 *  LevelCode — AI: the machine this extension runs on.
 *
 *  The extension was written for a Node extension host: the user's project is a directory it can
 *  read with `fs`, and programs can be started. LevelCode also runs in a browser tab (docs/WEB.md),
 *  where the project is whatever the editor's file system provider says it is, every read is
 *  asynchronous, and there is no shell. This module is the one place that difference lives.
 *
 *  Two rules keep the desktop app exactly as it was:
 *    1. On the desktop every function here does what the call site did before — the same `fs`
 *       call, the same error — only behind `await`.
 *    2. Nothing outside this file asks "am I in a browser?". Call sites ask for a capability
 *       (`caps.shell`) or call a function that already knows.
 *
 *  Paths are the absolute strings the extension has always used for workspace files
 *  (`Uri.fsPath` of a workspace folder, joined). In the browser they are URI paths, and `uriFor`
 *  maps one back to the workspace folder it belongs to, so the scheme (`file`, `levelcode-scratch`)
 *  is never guessed.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

const vscode = require('vscode');
const nodeFs = require('fs');
const nodeCp = require('child_process');   // the desktop's spawn; in the browser build this is a shim that always throws ENOSYS
const path = require('path');

/** True in the browser build (web/ai-extension/entry.js sets the flag before anything else loads). */
const isBrowser = !!globalThis.__LEVELCODE_BROWSER_HOST__;

/**
 * A shell the browser build can borrow: a LevelCode-owned extension (web/shell) that exports one. It is
 * connected lazily (connectShell), once, the first time a run needs to know whether there is one.
 * @type {{ info: ShellInfo, spawn: (command: string, opts: SpawnOptions) => ChildLike, forDisplay?: (text: string) => string } | null}
 */
let shell = null;

/** What this host can do. Tools and prompt text that need a capability are withheld without it. */
const caps = Object.freeze({
	/** Run command lines: run_command and verify commands. A real shell on the desktop; a registered one in the browser. */
	get shell() { return !isBrowser || shell !== null; },
	/** Start MCP servers as local processes (stdio). */
	mcpStdio: !isBrowser,
	/** Search file contents with the ripgrep binary the editor ships. */
	ripgrep: !isBrowser,
});

const TEXT_SNIFF_BYTES = 8000;

/* ----- paths and URIs ------------------------------------------------------------------------ */

function folders() { return vscode.workspace.workspaceFolders || []; }

/**
 * The URI for a workspace path. On the desktop that is `Uri.file`, as ever. In the browser the
 * workspace folder that contains the path supplies scheme and authority; a path inside none of
 * them falls back to `Uri.file`, which is right for a folder opened from the user's computer.
 * @param {string} abs
 * @returns {vscode.Uri}
 */
function uriFor(abs) {
	if (!isBrowser) { return vscode.Uri.file(abs); }
	let best = null;
	for (const f of folders()) {
		const root = f.uri.path;
		const prefix = root.endsWith('/') ? root : root + '/';
		if (abs === root || abs.startsWith(prefix)) {
			if (!best || root.length > best.uri.path.length) { best = f; }
		}
	}
	return best ? best.uri.with({ path: abs }) : vscode.Uri.file(abs);
}

/* ----- reading and probing ------------------------------------------------------------------- */

/** @param {string} abs @returns {Promise<Uint8Array>} rejects when the file is missing or unreadable. */
async function readBytes(abs) {
	if (!isBrowser) { return nodeFs.promises.readFile(abs); }
	return vscode.workspace.fs.readFile(uriFor(abs));
}

/** @param {string} abs @returns {Promise<string>} UTF-8 text; a leading BOM is left for the caller to strip. */
async function readText(abs) {
	if (!isBrowser) { return nodeFs.promises.readFile(abs, 'utf8'); }
	return new TextDecoder('utf-8').decode(await vscode.workspace.fs.readFile(uriFor(abs)));
}

/** @param {string} abs @returns {Promise<string|null>} null when it cannot be read — never throws. */
async function readTextOrNull(abs) {
	try { return await readText(abs); } catch { return null; }
}

/**
 * @param {string} abs
 * @returns {Promise<{isFile: boolean, isDirectory: boolean, size: number}|null>} null when absent.
 */
async function stat(abs) {
	try {
		if (!isBrowser) {
			const s = await nodeFs.promises.stat(abs);
			return { isFile: s.isFile(), isDirectory: s.isDirectory(), size: s.size };
		}
		const s = await vscode.workspace.fs.stat(uriFor(abs));
		return { isFile: (s.type & vscode.FileType.File) !== 0, isDirectory: (s.type & vscode.FileType.Directory) !== 0, size: s.size };
	} catch { return null; }
}

/** @param {string} abs @returns {Promise<boolean>} */
async function exists(abs) { return (await stat(abs)) !== null; }

/** A NUL byte in the first 8 KB means it is not text we should round-trip as UTF-8. Unreadable counts as text. */
async function isBinary(abs) {
	try {
		const buf = await readBytes(abs);
		const n = Math.min(buf.length, TEXT_SNIFF_BYTES);
		for (let i = 0; i < n; i++) { if (buf[i] === 0) { return true; } }
		return false;
	} catch { return false; }
}

/**
 * Run a loader that reads files synchronously (project rules, MCP config) against files this host can
 * only read asynchronously. The loader runs once to learn which paths it asks for, those are read,
 * and it runs again with the answers. A path the loader only asks for after seeing another file's
 * content is picked up by the next pass (at most four). A path never read in time is absent.
 *
 * On the desktop the loader simply runs once against `fs`, as before.
 * @template T
 * @param {(readFile: (abs: string) => string|null) => T} run
 * @returns {Promise<T>}
 */
async function withReads(run) {
	if (!isBrowser) {
		return run((abs) => { try { return nodeFs.readFileSync(abs, 'utf8'); } catch { return null; } });
	}
	/** @type {Map<string, string|null>} */
	const known = new Map();
	let result;
	for (let pass = 0; pass < 4; pass++) {
		const asked = new Set();
		result = run((abs) => {
			if (known.has(abs)) { return known.get(abs); }
			asked.add(abs);
			return null;
		});
		if (asked.size === 0) { break; }
		await Promise.all([...asked].map(async (p) => { known.set(p, await readTextOrNull(p)); }));
	}
	return result;
}

/* ----- running a command line ---------------------------------------------------------------- */

/** The extension (browser build) that provides the shell, and the export agent.js reads from it. */
const SHELL_EXTENSION_ID = 'levelcode.levelcode-shell';
const SHELL_API_VERSION = 1;

/**
 * @typedef {object} ShellInfo  What a shell says about itself; the prompt and the tool list are built from it.
 * @property {string} label           shown on the command's card instead of "zsh"
 * @property {boolean} background     run_command background:true works (a command that outlives its tool call)
 * @property {boolean} programs       real programs (node, npm, git, python …) can be started
 * @property {boolean} network        the network is reachable from a command
 * @property {string[]} commands      command names, for the prompt
 * @property {string[]} [missing]     commands the model is likely to try that are NOT here (node, npm, git …)
 * @property {{ commandCount?: number, loopIterations?: number, outputBytes?: number, fileReadBytes?: number, runReadBytes?: number }} [limits]
 *     what stops a command, so the prompt can say so
 *
 * @typedef {{ name: string, root: string, uri: string }} WorkspaceFolderRef
 * @typedef {{ kind: 'write'|'delete'|'mkdir'|'rmdir', path: string, existed?: boolean, before?: Uint8Array|null, after?: Uint8Array, viaDir?: string }} Change
 *
 * @typedef {object} SpawnOptions
 * @property {string} cwd                       absolute path of a workspace folder, or inside one
 * @property {WorkspaceFolderRef[]} [folders]   the workspace folders, live and in order (a shell mounts each at its root)
 * @property {Record<string,string>} [env]      extra environment
 * @property {string} [explanation]             the model's own label for the command (at most 300 characters), for a tab that mirrors it
 * @property {(changes: Change[], control?: { cancelled(): boolean }) => Promise<{ rest: Change[], notes: string[], failed?: number, refused?: boolean }>} [commit]
 *     Agent runs only. Called once, after the command has run to its END (never after Stop, a timeout or an engine
 *     limit: those apply nothing) and BEFORE 'close', with the files the command left changed. The caller validates
 *     the whole set and reviews it, or refuses it whole; it returns what the shell still has to do itself (make and
 *     remove directories), lines to append to the command's output, and how many changes it could NOT apply (the
 *     shell then does not report success). Without it the shell writes the changes straight to the workspace (the
 *     user's own terminal). `control.cancelled()` turns true when the run was stopped while the set was being
 *     checked: the caller then applies nothing (once the first write has begun nothing interrupts it).
 *
 * @typedef {object} ChildLike  The part of a Node ChildProcess that agent.js's runCommand uses.
 * @property {number} [pid]     leave undefined: agent.js then kills with child.kill(signal)
 * @property {{ on: (ev: 'data', cb: (chunk: string|Uint8Array) => void) => any }} stdout   strings (or Buffers)
 * @property {{ on: (ev: 'data', cb: (chunk: string|Uint8Array) => void) => any }} stderr
 * @property {(ev: 'close'|'error', cb: Function) => any} on   'close'(code) once, after every 'data'
 * @property {(signal?: string) => boolean} kill
 *     'SIGTERM' (Stop) and 'SIGKILL' (the timeout, or a Stop that was not heard within 1.5 s): the command is stopped
 *     and NONE of its file changes are applied — they were only ever staged — and the result says so. 'close' is
 *     emitted once. agent.js reports 130 for a stop and 124 for a timeout whatever the code of 'close'.
 */

/**
 * Start a command line. The desktop does what runCommand always did — a `sh -c` in its own process group — and
 * nothing else; the browser hands the line to the shell that registered itself. With none registered the browser's
 * child_process shim throws ENOSYS, as it did before there was a shell (callers withhold the tool first: caps.shell).
 * @param {string} command
 * @param {SpawnOptions} opts
 * @returns {ChildLike}
 */
function spawn(command, opts) {
	if (shell !== null) { return shell.spawn(command, opts); }
	return nodeCp.spawn(command, { cwd: opts.cwd, shell: true, detached: true });
}

/** The registered shell's description, or null (always null on the desktop: its shell is the user's own). */
function shellInfo() { return shell ? shell.info : null; }

/**
 * A model-written string as the user is shown it on an approval card or a command card: invisible and
 * direction-changing characters made visible, so what is approved is what runs. The desktop shows text as it
 * always has; a shell that brings its own rules (the browser's) supplies them.
 * @param {string} text
 * @returns {string}
 */
function displaySafe(text) {
	const f = shell && shell.forDisplay;
	if (typeof f !== 'function') { return text; }
	try { const out = f(String(text)); return typeof out === 'string' ? out : text; } catch { return text; }
}

/**
 * Register a shell. Called by connectShell; exported so a test (or a later in-process engine) can register one.
 * @param {{ info: ShellInfo, spawn: Function, forDisplay?: (text: string) => string }} impl
 * @returns {{ dispose(): void }}
 */
function registerShell(impl) {
	if (!impl || typeof impl.spawn !== 'function' || !impl.info) { throw new Error('a shell needs info and spawn'); }
	shell = impl;
	return { dispose() { if (shell === impl) { shell = null; } } };
}

/** @type {Promise<boolean> | null} */
let connecting = null;
/** How long a run waits for the shell extension to activate before it carries on without one. */
const CONNECT_TIMEOUT_MS = 10000;
/**
 * Browser only: find the LevelCode Shell extension, activate it (it is lazily activated, so this is where it
 * first loads), and register what it exports. Idempotent; resolves true when a shell is now available. Never
 * throws and never waits for ever: a missing, broken or slow shell is "no shell" for this run, which is what the
 * browser build was before it existed — and the next run asks again (by then it may have finished activating).
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<boolean>}
 */
function connectShell(opts) {
	if (!isBrowser) { return Promise.resolve(false); }
	if (shell !== null) { return Promise.resolve(true); }
	if (connecting) { return connecting; }
	const timeoutMs = (opts && opts.timeoutMs) || CONNECT_TIMEOUT_MS;
	const attempt = (async () => {
		let timer;
		try {
			const ext = vscode.extensions.getExtension(SHELL_EXTENSION_ID);
			if (!ext) { return false; }
			const api = ext.isActive ? ext.exports : await Promise.race([
				ext.activate(),
				new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('the shell extension did not activate in ' + timeoutMs + ' ms')), timeoutMs); }),
			]);
			if (!api || api.apiVersion !== SHELL_API_VERSION || !api.agent) { return false; }
			registerShell(api.agent);
			return true;
		} catch { return false; }
		finally { if (timer) { clearTimeout(timer); } }
	})();
	// Cleared AFTER it has settled, from outside: an early `return false` above runs the finally block before this
	// assignment, so clearing inside it left a settled promise stored and every later run got its stale answer.
	connecting = attempt;
	attempt.then(() => { if (connecting === attempt) { connecting = null; } });
	return attempt;
}

/* ----- sending the user to sign in ------------------------------------------------------------- */

/** Registered by the page (web/main.js); it takes the tab to the account site and the sign-in comes back to it. */
const OPEN_AUTH_COMMAND = 'levelcode.web.openAuthUrl';

/**
 * Open the account site's sign-in page. The desktop hands it to the system browser, as ever. A browser
 * tab leaves the page for it: a pop-up opened from a chain that began in a webview is the first thing a
 * strict browser (Safari, a phone) refuses, and the sign-in returns to the editor in the same tab. The
 * page's entry script supplies the command that navigates; without it this falls back to openExternal.
 *
 * The string handed over is the one the editor's own opener would have opened — `encodeURI(uri.toString(true))`
 * (src/vs/editor/browser/services/openerService.ts) — so the server sees the same address whichever way
 * the sign-in was started, as it has from the desktop app all along.
 * @param {vscode.Uri} uri
 */
async function openAuth(uri) {
	if (isBrowser) {
		try {
			const known = await vscode.commands.getCommands(true);
			if (known.includes(OPEN_AUTH_COMMAND)) {
				await vscode.commands.executeCommand(OPEN_AUTH_COMMAND, encodeURI(uri.toString(true)));
				return;
			}
		} catch { /* fall through to the pop-up */ }
	}
	await vscode.env.openExternal(uri);
}

/* ----- finding files ------------------------------------------------------------------------- */

/**
 * `vscode.workspace.findFiles`, which is what the editor's own search service answers. The browser
 * build uses it too: LevelCode's scratch workspace registers a file search provider.
 * @param {string} glob
 * @param {string} exclude
 * @param {number} max
 */
function findFiles(glob, exclude, max) {
	return vscode.workspace.findFiles(glob, exclude, max);
}

module.exports = {
	isBrowser, caps,
	spawn, shellInfo, displaySafe, registerShell, connectShell,
	uriFor, readBytes, readText, readTextOrNull, stat, exists, isBinary, withReads, findFiles, openAuth,
	// For tests.
	_path: path,
};
