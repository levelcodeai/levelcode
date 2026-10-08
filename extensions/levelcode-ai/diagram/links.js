/*---------------------------------------------------------------------------------------------
 *  LevelCode — AI · rich diagrams · code links  (docs/RICH-DIAGRAMS.md, "Safe rendering → Link safety")
 *
 *  "openLink only resolves paths inside the current workspace, after normalizing `..` segments and
 *  symlinks. Anything else is shown as plain text."
 *
 *  A node's link is model output — possibly copied from a file or a web page the model read — so the
 *  path in it is a claim, not a location. resolveLink() is the only thing that turns one into a file:
 *
 *    • it must be a plain path. Anything with a URL scheme (http:, file:, javascript:, vscode:) is
 *      refused before the file system is touched;
 *    • it is resolved against the workspace folders, which collapses every `..`;
 *    • the result must exist and be a regular file;
 *    • and its REAL path — every symlink followed — must still be inside the real path of a workspace
 *      folder. A link inside the repo that points at ~/.ssh is refused here.
 *
 *  It runs twice: when a diagram is drawn (a link that fails is dropped, so the node is plain text)
 *  and again at the moment of a click (the file may have moved, or become a symlink, since).
 *
 *  Host-only, vscode-free: the workspace folders and the file system are passed in.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

const nodeFs = require('fs');
const path = require('path');

const inside = (root, p) => p === root || p.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
/** "C:\x" and "C:/x" are paths; "http://x", "file:///x", "javascript:x", "vscode://x" are not. */
const hasScheme = (s) => /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(s) && !/^[a-zA-Z]:[\\/]/.test(s);

/**
 * @param {{ path?: any }} link
 * @param {Array<{ name: string, root: string }>} folders  the workspace folders
 * @param {{ fs?: any }} [opts]  fs: a stand-in for tests
 * @returns {{ ok: true, path: string, abs: string } | { ok: false, reason: string }}
 */
function resolveLink(link, folders, opts) {
	const fs = (opts && opts.fs) || nodeFs;
	const raw = link && typeof link.path === 'string' ? link.path.trim() : '';
	if (!raw) { return { ok: false, reason: 'no path' }; }
	if (raw.indexOf('\u0000') >= 0) { return { ok: false, reason: 'not a path' }; }
	if (hasScheme(raw)) { return { ok: false, reason: 'not a file path' }; }
	const list = (Array.isArray(folders) ? folders : []).filter((f) => f && typeof f.root === 'string' && f.root);
	if (!list.length) { return { ok: false, reason: 'no folder is open' }; }

	// The same reading the agent's own file tools give a path: in a multi-root workspace a leading
	// folder NAME picks that folder; otherwise the first folder that has the file wins.
	const candidates = [];
	if (path.isAbsolute(raw)) { candidates.push(path.resolve(raw)); }
	else {
		const seg = raw.split(/[\\/]/)[0];
		const named = list.length > 1 ? list.find((f) => f.name === seg) : null;
		if (named) { candidates.push(path.resolve(named.root, raw.slice(seg.length).replace(/^[\\/]+/, ''))); }
		for (const f of list) { candidates.push(path.resolve(f.root, raw)); }
	}
	let sawOutside = false;
	for (const abs of candidates) {
		const home = list.find((f) => inside(path.resolve(f.root), abs));
		if (!home) { sawOutside = true; continue; }           // `..` walked out of the workspace
		let stat;
		try { stat = fs.statSync(abs); } catch (e) { continue; }
		if (!stat.isFile()) { continue; }
		let real;
		try { real = fs.realpathSync(abs); } catch (e) { continue; }
		const realHome = list.find((f) => { try { return inside(fs.realpathSync(f.root), real); } catch (e) { return false; } });
		if (!realHome) { return { ok: false, reason: 'it is a link to somewhere outside this workspace' }; }
		const rel = path.relative(path.resolve(home.root), abs).split(path.sep).join('/');
		return { ok: true, path: list.length > 1 ? home.name + '/' + rel : rel, abs };
	}
	return { ok: false, reason: sawOutside ? 'outside this workspace' : 'no such file in this workspace' };
}

/**
 * Where in a file a symbol is, by plain text search — the fallback when the language has no symbol
 * provider. Prefers a line that DEFINES the name over one that merely mentions it.
 * @param {string} content
 * @param {string} symbol
 * @returns {number | null}  1-based line, or null
 */
function findSymbolLine(content, symbol) {
	// "Agent.runAgent()" names runAgent. Only identifier characters ever reach the pattern below.
	const name = String(symbol || '').split(/[^\w$]+/).filter(Boolean).pop();
	if (!name) { return null; }
	const lines = String(content).split('\n');
	const esc = name.replace(/\$/g, '\\$');
	const word = new RegExp('(^|[^\\w$])' + esc + '($|[^\\w$])');
	// A definition: a declaring keyword DIRECTLY before the name, the name assigned a function, or a
	// method written as `name(args) {`. "const x = name" mentions the name; it does not define it.
	const defines = new RegExp(
		'\\b(function\\*?|class|def|fn|func|interface|type|struct|enum|module|const|let|var)\\s+\\*?\\s*' + esc + '(?![\\w$])'
		+ '|(^|[^\\w$.])' + esc + '\\s*[:=]\\s*(async\\s*)?(function\\b|\\(|[\\w$]+\\s*=>)'
		+ '|^\\s*((async|static|public|private|protected|export)\\s+)*' + esc + '\\s*\\([^)]*\\)\\s*\\{');
	let first = null;
	for (let i = 0; i < lines.length; i++) {
		if (!word.test(lines[i])) { continue; }
		if (defines.test(lines[i])) { return i + 1; }
		if (first === null) { first = i + 1; }
	}
	return first;
}

module.exports = { resolveLink, findSymbolLine, hasScheme };
