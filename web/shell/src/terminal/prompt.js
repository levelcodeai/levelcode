// The prompt line: where the shell is, and how the last command ended. Pure.
// @ts-check
'use strict';

const { cpWidth, strWidth, stripEscapes } = require('./width');

const ESC = '\x1b';
const RED = ESC + '[31m';
const RESET = ESC + '[0m';

/**
 * `root` is where the folder is in the path space of `cwd`; `origin` is where it is in the workspace, when that is not
 * the same place (a folder the engine had to mount elsewhere). It is what tells two folders of one name apart.
 * @typedef {{ name: string, root: string, uri?: string, origin?: string }} FolderRef
 */

/** @param {string} p */
const components = (p) => String(p).split('/').filter(Boolean);

/** A path without the slashes at its end; a loop, not `/\/+$/`, which is quadratic in a run of slashes that is not at the end. @param {string} p */
function withoutTrailingSlashes(p) {
	let end = p.length;
	while (end > 0 && p.charCodeAt(end - 1) === 47) { end--; }
	return p.slice(0, end);
}

/**
 * What names a workspace folder in the prompt: its name, and when another folder of the workspace has the same name,
 * enough of the folders it is in to tell them apart (`a/proj` and `b/proj`): the fewest that make the label differ
 * from every other folder's of this name.
 *
 * A label of `up` enclosing folders is the last `up` of them and the name, so two folders have the same one up to
 * the number of enclosing folders they share counted from the folder itself, and the first one more tells them apart.
 * That is a walk from the end of each path, not a label built and compared for every `up` (which is quadratic in the
 * depth of a path that shares its end with another).
 * @param {FolderRef} folder
 * @param {FolderRef[]} folders
 * @returns {string[]}
 */
function folderParts(folder, folders) {
	const name = String(folder.name || '');
	const where = (/** @type {FolderRef} */ f) => components(typeof f.origin === 'string' ? f.origin : f.root);
	const others = folders.filter((f) => f && f !== folder && String(f.name || '') === name);
	if (others.length === 0) { return [name]; }
	const mine = where(folder).slice(0, -1);
	let up = 1;
	for (const f of others) {
		const theirs = where(f).slice(0, -1);
		let shared = 0;
		while (shared < mine.length && shared < theirs.length && mine[mine.length - 1 - shared] === theirs[theirs.length - 1 - shared]) { shared++; }
		up = Math.max(up, shared + 1);
	}
	// no more than there are: two folders that are in the same place are not told apart by any of it
	return mine.slice(mine.length - Math.min(up, mine.length)).concat(name);
}

/**
 * The cwd as the prompt shows it: relative to the workspace folder it is in, named by that folder; outside every
 * folder, the absolute path. Long paths collapse to `.../a/b` when they take more than 40% of the width.
 *
 * Not `~`: the shell's HOME is /home/user and `cd ~` goes there, so a `~` that meant "the workspace" would lie.
 * @param {string} cwd
 * @param {FolderRef[]} folders
 * @param {number} columns
 * @param {{ forTerminal(text: string): string }} sanitize
 */
function cwdLabel(cwd, folders, columns, sanitize) {
	/** @type {{ root: string, folder: FolderRef } | null} */
	let best = null;
	for (const f of folders) {
		if (!f || typeof f.root !== 'string') { continue; }
		const root = withoutTrailingSlashes(f.root);
		if (cwd === root || cwd === f.root || cwd.startsWith(root + '/')) {
			if (!best || root.length > best.root.length) { best = { root, folder: f }; }
		}
	}
	let parts;
	if (best) {
		const rel = cwd.slice(best.root.length).split('/').filter(Boolean);
		const named = folderParts(best.folder, folders);
		parts = (named.join('') ? named : [best.root.split('/').pop() || '/']).concat(rel);
	} else {
		parts = cwd.split('/').filter(Boolean);
		if (parts.length === 0) { return '/'; }
		parts[0] = '/' + parts[0];
	}
	const safe = parts.map((p) => sanitize.forTerminal(p).replace(/[\r\n]+/g, '↵').replace(/\t/g, ' '));
	const max = Math.max(8, Math.floor(columns * 0.4));
	let label = safe.join('/');
	if (strWidth(label) > max && safe.length > 2) { label = '.../' + safe.slice(-2).join('/'); }
	if (strWidth(label) > max && safe.length > 1) { label = '.../' + safe[safe.length - 1]; }
	if (strWidth(label) > max) {
		// Characters are taken out just before the last one until what is left fits in max - 1 cells (and is no less than
		// four characters), then the ellipsis. Done by counting, not by cutting and measuring the label over and over.
		const cps = Array.from(label);
		let keep = cps.length - 1;                       // the characters kept in front of the last one
		let width = strWidth(label);
		while (keep + 1 > 4 && width > max - 1) {
			keep--;
			width -= cpWidth(/** @type {number} */ (cps[keep].codePointAt(0)));
		}
		label = cps.slice(0, keep).join('') + cps[cps.length - 1] + '…';
	}
	return label;
}

/**
 * The prompt: colours from SGR only (so both themes apply), the status of the last command when it was not 0.
 * Never wider than the terminal: a prompt that does not fit would wrap, and the editor measures one that does not.
 * @param {{ cwd: string, folders: FolderRef[], status: number, columns: number, sanitize: { forTerminal(text: string): string } }} o
 */
function promptFor(o) {
	const label = cwdLabel(o.cwd, o.folders, o.columns, o.sanitize);
	const text = ESC + '[1;34m' + label + RESET + (o.status ? ' ' + RED + '[' + o.status + ']' + RESET : '') + ' $ ';
	if (strWidth(stripEscapes(text)) >= o.columns - 1) { return '$ '; }
	return text;
}


module.exports = { cwdLabel, promptFor };
