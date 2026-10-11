// The prompt line: where the shell is, and how the last command ended. Pure.
// @ts-check
'use strict';

const { strWidth, stripEscapes } = require('./width');

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

/**
 * What names a workspace folder in the prompt: its name, and when another folder of the workspace has the same name,
 * enough of the folders it is in to tell them apart (`a/proj` and `b/proj`).
 * @param {FolderRef} folder
 * @param {FolderRef[]} folders
 * @returns {string[]}
 */
function folderParts(folder, folders) {
	const name = String(folder.name || '');
	const where = (/** @type {FolderRef} */ f) => components(typeof f.origin === 'string' ? f.origin : f.root);
	const others = folders.filter((f) => f && f !== folder && String(f.name || '') === name);
	if (others.length === 0) { return [name]; }
	const mine = where(folder);
	// the fewest enclosing folders that make the label differ from every other folder's of this name
	for (let up = 1; up <= mine.length; up++) {
		const label = mine.slice(-up - 1, -1).concat(name).join('/');
		if (others.every((f) => where(f).slice(-up - 1, -1).concat(name).join('/') !== label)) { return mine.slice(-up - 1, -1).concat(name); }
	}
	return mine.slice(0, -1).concat(name);
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
		const root = f.root.replace(/\/+$/, '');
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
		const cps = Array.from(label);
		while (cps.length > 4 && strWidth(cps.join('')) > max - 1) { cps.splice(cps.length - 2, 1); }
		label = cps.join('') + '…';
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
