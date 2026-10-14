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
const path = require('path');

/** True in the browser build (web/ai-extension/entry.js sets the flag before anything else loads). */
const isBrowser = !!globalThis.__LEVELCODE_BROWSER_HOST__;

/** What this host can do. Tools and prompt text that need a capability are withheld without it. */
const caps = Object.freeze({
	/** Start programs: run_command, background commands, verify commands. */
	shell: !isBrowser,
	/** Start MCP servers as local processes (stdio). */
	mcpStdio: !isBrowser,
	/** Search file contents with the ripgrep binary the editor ships. */
	ripgrep: !isBrowser,
	/**
	 * Take a sign-in result that no sign-in of this editor asked for: the old token-in-the-link form, or a code
	 * with no sign-in pending. The desktop does what it always did. In a browser the callback is a page of the
	 * editor's own site that anyone can link to, so only a code answering a sign-in this browser started counts.
	 */
	unaskedSignIn: !isBrowser,
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

/**
 * Is this document one of the user's own files — the kind inline completion is offered in? On the desktop a
 * `file` or an `untitled` document, as ever. In the browser also a document inside a workspace folder, whatever
 * its scheme: the scratch workspace's files are `levelcode-scratch:` ones.
 * @param {vscode.Uri} uri
 */
function isUserDocument(uri) {
	if (uri.scheme === 'file' || uri.scheme === 'untitled') { return true; }
	if (!isBrowser) { return false; }
	return folders().some((f) => {
		const root = f.uri.path.endsWith('/') ? f.uri.path : f.uri.path + '/';
		return f.uri.scheme === uri.scheme && (f.uri.authority || '') === (uri.authority || '') && (uri.path === f.uri.path || uri.path.startsWith(root));
	});
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

/* ----- checking paths synchronously --------------------------------------------------------- */

/**
 * The part of Node's `fs` a synchronous path check uses — `statSync` and `realpathSync` — answered from `lookup`.
 * In the browser nothing is a symbolic link, so a path's real path is the path.
 * @param {(abs: string) => ({isFile: boolean, isDirectory: boolean}|null)} lookup
 */
function statView(lookup) {
	const missing = (p) => Object.assign(new Error('ENOENT: no such file or directory, ' + p), { code: 'ENOENT' });
	return {
		statSync(p) {
			const s = lookup(String(p));
			if (!s) { throw missing(p); }
			return { isFile: () => s.isFile, isDirectory: () => s.isDirectory };
		},
		realpathSync(p) { if (!lookup(String(p))) { throw missing(p); } return String(p); },
	};
}

/**
 * Run a check written against `fs.statSync` / `fs.realpathSync` (a diagram's code links: diagram/links.js) where
 * files can only be looked at asynchronously. Like withReads: the check runs once to learn which paths it asks
 * about, those are stat'd, and it runs again with the answers (at most four passes).
 * On the desktop it simply runs once against `fs`, as before.
 * @template T
 * @param {(fs: { statSync: Function, realpathSync: Function }) => T} run
 * @returns {Promise<T>}
 */
async function withStats(run) {
	if (!isBrowser) { return run(nodeFs); }
	/** @type {Map<string, {isFile: boolean, isDirectory: boolean}|null>} */
	const known = new Map();
	let result;
	for (let pass = 0; pass < 4; pass++) {
		const asked = new Set();
		result = run(statView((abs) => {
			if (known.has(abs)) { return known.get(abs); }
			asked.add(abs);
			return null;
		}));
		if (asked.size === 0) { break; }
		await Promise.all([...asked].map(async (p) => { known.set(p, await stat(p)); }));
	}
	return result;
}

/**
 * The same view over files already known to exist, for a check that cannot wait for the file system (a diagram's
 * links are checked as it is drawn). Folders are the files' parents. Null on the desktop: the check reads the disk.
 * @param {Iterable<string>} files absolute paths
 */
function knownFilesView(files) {
	if (!isBrowser) { return null; }
	const set = new Set(files);
	const dirs = new Set();
	for (const f of set) { for (let d = f.slice(0, f.lastIndexOf('/')); d; d = d.slice(0, d.lastIndexOf('/'))) { dirs.add(d); } }
	dirs.add('/');
	return statView((abs) => (set.has(abs) ? { isFile: true, isDirectory: false } : dirs.has(abs) ? { isFile: false, isDirectory: true } : null));
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
 * @param {vscode.GlobPattern} glob  a string, or a vscode.RelativePattern to search under one folder
 * @param {string} exclude
 * @param {number} max
 */
function findFiles(glob, exclude, max) {
	return vscode.workspace.findFiles(glob, exclude, max);
}

module.exports = {
	isBrowser, caps,
	uriFor, isUserDocument, readBytes, readText, readTextOrNull, stat, exists, isBinary, withReads, withStats, knownFilesView, findFiles, openAuth,
	// For tests.
	_path: path,
};
