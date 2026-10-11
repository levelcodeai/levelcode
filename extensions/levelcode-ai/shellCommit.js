/*---------------------------------------------------------------------------------------------
 *  LevelCode — AI: a shell command's file changes, routed through the SAME review as edit_file,
 *  write_file and delete_file.
 *
 *  A host whose shell is simulated (LevelCode in the browser) hands back, when a command ends, the files
 *  it left changed. Each one that can be shown as text goes through ctx.applyEdit / ctx.applyDelete —
 *  which is what gives a command Keep/Undo, a per-turn checkpoint (recordTouch) and a place in the
 *  verify step (ctx.touched, ctx.editCount). What cannot be reviewed is applied by the shell itself and
 *  said so, or refused and said so: the shell is never a way around what edit_file refuses.
 *
 *  Pure and vscode-free, like verify.js and commandSafety.js, so it is unit-tested with plain node
 *  (test/shellCommit.test.js).
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

/** The folders agent.js's FILE_EXCLUDES leaves out of list_files and search: written, never reviewed. */
const EXCLUDED = /(^|\/)(node_modules|\.git|out|dist|\.vscode-test)(\/|$)|\.map$/;
/** Larger than this is not shown as a diff card (snapshots are kept in workspaceState). */
const MAX_REVIEW_BYTES = 1024 * 1024;
const utf8 = new TextDecoder('utf-8', { fatal: true });

/** A NUL in the first 8000 bytes is "binary" (host.isBinary); anything else must also decode as UTF-8. */
function isText(bytes) {
	if (!bytes) { return false; }
	const n = Math.min(bytes.length, 8000);
	for (let i = 0; i < n; i++) { if (bytes[i] === 0) { return false; } }
	try { utf8.decode(bytes); return true; } catch { return false; }
}
function same(a, b) {
	if (a === null || a === undefined) { return b === null || b === undefined; }
	if (b === null || b === undefined || a.length !== b.length) { return false; }
	for (let i = 0; i < a.length; i++) { if (a[i] !== b[i]) { return false; } }
	return true;
}

/**
 * The path a review call takes for an absolute path: relative to its workspace folder, and — with more than
 * one folder — prefixed with the folder's name, which is how resolveWorkspacePath finds the folder
 * deterministically (an unprefixed path means "the first folder").
 * @param {string} abs
 * @param {Array<{name:string, root:string}>} folders
 * @returns {string|null} null when `abs` is in none of them
 */
function reviewPathFor(abs, folders) {
	let best = null;
	for (const f of folders) {
		const inside = abs === f.root || abs.startsWith(f.root === '/' ? '/' : f.root + '/');
		if (inside && (!best || f.root.length > best.root.length)) { best = f; }
	}
	if (!best) { return null; }
	const sub = abs.slice(best.root === '/' ? 1 : best.root.length + 1);
	return folders.length > 1 ? best.name + '/' + sub : sub;
}

/**
 * @typedef {import('./host').Change} Change
 * @param {Change[]} changes
 * @param {{ applyEdit?: Function, applyDelete?: Function, touched?: Set<string>, editCount?: number }} ctx
 * @param {{ folders: () => Array<{name:string, root:string}>, readNow: (abs: string) => Promise<Uint8Array|null> }} io
 * @returns {Promise<{ rest: Change[], applied: Change[], failed: Array<{c: Change, why: string}>, notes: string[] }>}
 */
async function commitShellChanges(changes, ctx, io) {
	const folders = io.folders();
	/** @type {Change[]} */ const rest = [];
	/** @type {Change[]} */ const applied = [];
	/** @type {Array<{c: Change, why: string}>} */ const failed = [];
	const touched = ctx.touched;
	const bump = () => { ctx.editCount = (ctx.editCount || 0) + 1; };

	for (const c of changes.filter((x) => x.kind === 'write').sort((a, b) => (a.path < b.path ? -1 : 1))) {
		const rel = reviewPathFor(c.path, folders);
		if (rel === null) { failed.push({ c, why: 'outside the workspace folders' }); continue; }
		if (EXCLUDED.test(c.path)) { rest.push(c); continue; }
		const after = c.after || new Uint8Array(0);
		const reviewable = isText(after) && after.length <= MAX_REVIEW_BYTES
			&& (!c.existed || (isText(c.before) && /** @type {Uint8Array} */ (c.before).length <= MAX_REVIEW_BYTES));
		if (!reviewable) {
			if (c.existed) { failed.push({ c, why: 'it is binary or too large to review — edit it in the editor' }); } else { rest.push(c); }
			continue;
		}
		// Changed on disk while the command ran (the user saved, another tab wrote)? Do not overwrite it.
		const now = await io.readNow(c.path);
		if (!same(now, c.existed ? c.before : null)) { failed.push({ c, why: 'it changed while the command ran, so the command\'s result was not applied' }); continue; }
		if (typeof ctx.applyEdit !== 'function') { rest.push(c); continue; }
		const ok = await ctx.applyEdit({ path: rel, exists: !!c.existed, proposed: utf8.decode(after) });
		if (ok) { bump(); if (touched) { touched.add(c.path); } applied.push(c); }
		else { failed.push({ c, why: 'the editor could not apply it' }); }
	}
	for (const c of changes.filter((x) => x.kind === 'delete').sort((a, b) => (a.path < b.path ? -1 : 1))) {
		const rel = reviewPathFor(c.path, folders);
		if (rel === null) { failed.push({ c, why: 'outside the workspace folders' }); continue; }
		if (EXCLUDED.test(c.path)) { rest.push(c); continue; }
		if (!isText(c.before) || /** @type {Uint8Array} */ (c.before).length > MAX_REVIEW_BYTES) { failed.push({ c, why: 'it is binary or too large to review — delete it in the editor' }); continue; }
		if (typeof ctx.applyDelete !== 'function') { rest.push(c); continue; }
		const ok = await ctx.applyDelete({ path: rel });
		if (ok) { bump(); if (touched) { touched.delete(c.path); } applied.push(c); }
		else { failed.push({ c, why: 'the editor could not delete it' }); }
	}
	// A directory goes only when every file in it did.
	const blocked = new Set(failed.map((f) => f.c.viaDir).filter(Boolean));
	for (const c of changes) {
		if (c.kind === 'mkdir') { rest.push(c); }
		else if (c.kind === 'rmdir' && !blocked.has(c.path)) { rest.push(c); }
	}

	/** @type {string[]} */ const notes = [];
	const sign = (c) => (c.kind === 'delete' ? '-' : c.existed ? '~' : '+');
	if (applied.length) {
		const list = applied.slice(0, 8).map((c) => sign(c) + (reviewPathFor(c.path, folders) || c.path)).join(' ');
		notes.push('[LevelCode Shell: ' + applied.length + ' file' + (applied.length > 1 ? 's' : '') + ' changed, ready for Keep/Undo: ' + list + (applied.length > 8 ? ' …and ' + (applied.length - 8) + ' more' : '') + ']');
	}
	const direct = rest.filter((c) => c.kind === 'write' || c.kind === 'delete').length;
	if (direct) { notes.push('[LevelCode Shell: ' + direct + ' file' + (direct > 1 ? 's' : '') + ' in build output or binary form were written without review]'); }
	for (const f of failed.slice(0, 5)) { notes.push('[LevelCode Shell: NOT applied: ' + (reviewPathFor(f.c.path, folders) || f.c.path) + ' — ' + f.why + ']'); }
	if (failed.length > 5) { notes.push('[LevelCode Shell: …and ' + (failed.length - 5) + ' more not applied]'); }
	return { rest, applied, failed, notes };
}

module.exports = { commitShellChanges, reviewPathFor, isText, EXCLUDED, MAX_REVIEW_BYTES };
