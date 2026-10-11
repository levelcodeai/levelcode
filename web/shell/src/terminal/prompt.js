// The prompt line: where the shell is, and how the last command ended. Pure.
// @ts-check
'use strict';

const { strWidth, stripEscapes } = require('./width');

const ESC = '\x1b';
const RED = ESC + '[31m';
const RESET = ESC + '[0m';

/** @typedef {{ name: string, root: string, uri?: string }} FolderRef */

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
	let best = null;
	for (const f of folders) {
		if (!f || typeof f.root !== 'string') { continue; }
		const root = f.root.replace(/\/+$/, '');
		if (cwd === root || cwd === f.root || cwd.startsWith(root + '/')) {
			if (!best || root.length > best.root.length) { best = { root, name: String(f.name || '') }; }
		}
	}
	let parts;
	if (best) {
		const rel = cwd.slice(best.root.length).split('/').filter(Boolean);
		parts = [best.name || best.root.split('/').pop() || '/'].concat(rel);
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
