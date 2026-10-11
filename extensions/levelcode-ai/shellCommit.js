/*---------------------------------------------------------------------------------------------
 *  LevelCode — AI: a shell command's file changes, routed through the SAME review as edit_file,
 *  write_file and delete_file.
 *
 *  A host whose shell is simulated (LevelCode in the browser) hands back, when a command has run to its end,
 *  the files it left changed. This decides what happens to them, and the rule is one sentence:
 *
 *      EVERYTHING IS REVIEWED OR THE WHOLE COMMAND IS REFUSED.
 *
 *  Each change that can be shown as text goes through ctx.applyEdit / ctx.applyDelete — which is what gives a
 *  command Keep/Undo, a per-turn checkpoint (recordTouch) and a place in the verify step (ctx.touched,
 *  ctx.editCount). There is no second, unreviewed path for "build output" or "binary": a shell that can
 *  silently write or delete files the review cannot restore is a way round everything edit_file refuses
 *  (found by the stage-1 review; the first draft had one). A command is validated as a WHOLE first — if any
 *  one change is refused, nothing is applied and every refusal is listed — and only then applied. The apply
 *  itself cannot be atomic across files (a series of awaits), so a failure part-way is reported as exactly
 *  what it is: "N of M applied".
 *
 *  What is refused, and why:
 *    - outside the workspace folders                          (a mount is the boundary)
 *    - repository / tool metadata and instruction files       (a script can hide `rm -rf .git`, or write
 *                                                              .vscode/settings.json or AGENTS.md, which later
 *                                                              steer the agent with the user's authority)
 *    - binary, non-UTF-8, BOM or over 1 MiB                   (the review snapshots text; Undo would write
 *                                                              mangled bytes back)
 *    - line endings the review would rewrite                  (applyEdit normalises to the document's EOL, so a
 *                                                              `tr -d '\r'` would silently not happen)
 *    - a file with unsaved changes in the editor              (the review replaces the whole buffer)
 *    - a file that changed on disk since the command read it  (never overwrite what someone else saved)
 *    - a case-only rename, or two paths that differ only in case (a case-insensitive disk would lose the file)
 *    - more than 300 reviewed files                           (a card and a snapshot each; it has gone wrong)
 *
 *  Pure and vscode-free, like verify.js and commandSafety.js, so it is unit-tested with plain node
 *  (test/shellCommit.test.js).
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

/**
 * Never changed by a command, in either direction. Matched against the path RELATIVE to its workspace folder.
 * The user's own terminal is not held to this (it is the user typing); an agent's command is.
 */
const PROTECTED = [
	/(^|\/)\.git(\/|$)/,
	/(^|\/)\.vscode(\/|$)/,
	/(^|\/)\.levelcode(\/|$)/,
	/(^|\/)\.cursor(\/|$)/,
	/(^|\/)\.husky(\/|$)/,
	/(^|\/)\.github\/workflows(\/|$)/,
	/(^|\/)(AGENTS\.md|CLAUDE\.md|\.cursorrules|\.windsurfrules)$/i,
];
/** Larger than this is not shown as a diff card (snapshots are kept in workspaceState). */
const MAX_REVIEW_BYTES = 1024 * 1024;
/**
 * More reviewed files than this from one command and NOTHING is applied: a card per file, a snapshot per file
 * and an editor round trip per file is what the user would have to wade through, and a command that rewrites
 * hundreds of files has usually gone wrong. (A choice, not a measurement: 60 files took 215 ms through the real
 * review in headless Chrome.)
 */
const MAX_REVIEWED_FILES = 300;
const utf8 = new TextDecoder('utf-8', { fatal: true });

/**
 * Plain UTF-8 text the review can round-trip: valid UTF-8, no NUL in it, no byte-order mark.
 * @param {Uint8Array|null|undefined} bytes
 */
function isPlainText(bytes) {
	if (!bytes) { return false; }
	if (bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) { return false; }
	for (let i = 0; i < bytes.length; i++) { if (bytes[i] === 0) { return false; } }
	try { utf8.decode(bytes); return true; } catch { return false; }
}
/** @param {Uint8Array|null|undefined} a @param {Uint8Array|null|undefined} b */
function same(a, b) {
	if (a === null || a === undefined) { return b === null || b === undefined; }
	if (b === null || b === undefined || a.length !== b.length) { return false; }
	for (let i = 0; i < a.length; i++) { if (a[i] !== b[i]) { return false; } }
	return true;
}

/**
 * The line-ending style of a text: 'lf', 'crlf', 'none' (no line break at all) or 'mixed' (the review would
 * normalise it, which changes bytes the command did not mean to change).
 * @param {string} text
 */
function eolStyle(text) {
	let crlf = 0, lf = 0;
	for (let i = 0; i < text.length; i++) {
		if (text.charCodeAt(i) === 10) { if (i > 0 && text.charCodeAt(i - 1) === 13) { crlf++; } else { lf++; } }
	}
	if (crlf && lf) { return 'mixed'; }
	if (crlf) { return 'crlf'; }
	return lf ? 'lf' : 'none';
}
/** A lone CR (old Mac) is not a line break the editor keeps: refuse it with the same reason as mixed. */
function hasLoneCr(text) { return /\r(?!\n)/.test(text); }

/**
 * The path a review call takes for an absolute path: relative to its workspace folder, and — with more than
 * one folder — prefixed with the folder's name, which is how resolveWorkspacePath finds the folder
 * deterministically (an unprefixed path means "the first folder").
 * @param {string} abs
 * @param {Array<{name:string, root:string}>} folders
 * @returns {{ review: string, rel: string }|null} null when `abs` is in none of them
 */
function reviewPathFor(abs, folders) {
	let best = null;
	for (const f of folders) {
		const inside = abs === f.root || abs.startsWith(f.root === '/' ? '/' : f.root + '/');
		if (inside && (!best || f.root.length > best.root.length)) { best = f; }
	}
	if (!best) { return null; }
	const rel = abs.slice(best.root === '/' ? 1 : best.root.length + 1);
	return { rel, review: folders.length > 1 ? best.name + '/' + rel : rel };
}

/** @param {string} rel */
function isProtected(rel) { return PROTECTED.some((re) => re.test(rel)); }

/**
 * @typedef {import('./host').Change} Change
 * @typedef {{ c: Change, why: string }} Refusal
 *
 * @param {Change[]} changes
 * @param {{ applyEdit?: Function, applyDelete?: Function, touched?: Set<string>, editCount?: number }} ctx
 * @param {{ folders: () => Array<{name:string, root:string}>, readNow: (abs: string) => Promise<Uint8Array|null>, isDirty?: (abs: string) => boolean, cancelled?: () => boolean }} io
 *   `cancelled` is asked between the read-only checks and once more before the first write: a Stop that arrives
 *   while the files are being compared applies nothing. Once the first write has begun nothing interrupts it.
 * @returns {Promise<{ rest: Change[], applied: Change[], failed: Refusal[], notes: string[], refused: boolean }>}
 *   `rest` is what the SHELL itself still has to do (create and remove directories). `refused` is true when
 *   nothing was applied because the set as a whole was refused.
 */
async function commitShellChanges(changes, ctx, io) {
	const folders = io.folders();
	const files = changes.filter((c) => c.kind === 'write' || c.kind === 'delete');
	/** @type {Refusal[]} */ const refusals = [];
	/** @type {Array<{ c: Change, review: string, rel: string }>} */ const plan = [];
	const label = (/** @type {Change} */ c) => { const p = reviewPathFor(c.path, folders); return p ? p.review : c.path; };

	if (files.length > MAX_REVIEWED_FILES) {
		return {
			rest: [], applied: [], failed: files.map((c) => ({ c, why: 'too many files' })), refused: true,
			notes: ['[LevelCode Shell: this command would change ' + files.length + ' files, more than the ' + MAX_REVIEWED_FILES
				+ ' that can be reviewed from one command. NONE of its file changes were applied. Split it into smaller steps, or ask the user to do it in the Explorer.]'],
		};
	}

	// --- validate the WHOLE set; collect every refusal -----------------------------------------------------
	const seenLower = new Map();
	for (const c of files) {
		const p = reviewPathFor(c.path, folders);
		if (p === null) { refusals.push({ c, why: 'it is outside the workspace folders' }); continue; }
		if (isProtected(p.rel)) { refusals.push({ c, why: 'repository metadata, tool settings and instruction files are not changed by commands — the user does that' }); continue; }
		const key = c.path.toLowerCase();
		if (seenLower.has(key) && seenLower.get(key) !== c.path) { refusals.push({ c, why: 'it differs from ' + seenLower.get(key) + ' only in letter case, which a case-insensitive disk cannot keep apart' }); continue; }
		seenLower.set(key, c.path);
		if (c.kind === 'write') {
			const after = c.after || new Uint8Array(0);
			if (after.length > MAX_REVIEW_BYTES) { refusals.push({ c, why: 'it would be larger than ' + (MAX_REVIEW_BYTES / 1024 / 1024) + ' MiB, too large to review' }); continue; }
			if (!isPlainText(after)) { refusals.push({ c, why: 'it would be binary, not UTF-8, or start with a byte-order mark — only plain text files are changed by commands' }); continue; }
			const text = utf8.decode(after);
			if (hasLoneCr(text)) { refusals.push({ c, why: 'it would contain bare carriage returns, which the editor does not keep' }); continue; }
			const style = eolStyle(text);
			if (c.existed) {
				if (!isPlainText(c.before) || /** @type {Uint8Array} */ (c.before).length > MAX_REVIEW_BYTES) { refusals.push({ c, why: 'the file is binary, not plain UTF-8, or too large to review — edit it in the editor' }); continue; }
				const was = eolStyle(utf8.decode(/** @type {Uint8Array} */ (c.before)));
				if (was === 'mixed') { refusals.push({ c, why: 'the file has mixed line endings, which the review would normalise' }); continue; }
				if (style === 'mixed' || (was !== 'none' && style !== 'none' && style !== was)) { refusals.push({ c, why: 'the review keeps a file\'s line endings (' + was + '), and this would change them' }); continue; }
			} else if (style === 'mixed' || style === 'crlf') {
				refusals.push({ c, why: 'new files are created with LF line endings' }); continue;
			}
			if (c.existed && io.isDirty && io.isDirty(c.path)) { refusals.push({ c, why: 'it has unsaved changes in the editor — save or revert them and run the command again' }); continue; }
			plan.push({ c, review: p.review, rel: p.rel });
		} else {
			if (!isPlainText(c.before) || /** @type {Uint8Array} */ (c.before).length > MAX_REVIEW_BYTES) { refusals.push({ c, why: 'it is binary, not plain UTF-8, or too large to review, so Undo could not bring it back — delete it in the editor' }); continue; }
			if (io.isDirty && io.isDirty(c.path)) { refusals.push({ c, why: 'it has unsaved changes in the editor — save or revert them and run the command again' }); continue; }
			plan.push({ c, review: p.review, rel: p.rel });
		}
	}
	// A case-only rename: a delete and a write whose paths are equal ignoring case but not equal.
	for (const c of files) {
		if (c.kind !== 'delete') { continue; }
		for (const w of files) {
			if (w.kind === 'write' && w.path !== c.path && w.path.toLowerCase() === c.path.toLowerCase() && !refusals.some((r) => r.c === w)) {
				refusals.push({ c: w, why: 'it is a rename of ' + label(c) + ' that only changes letter case, which a case-insensitive disk would turn into a deletion' });
			}
		}
	}
	const stopped = () => ({
		rest: /** @type {Change[]} */ ([]), applied: /** @type {Change[]} */ ([]), failed: /** @type {Refusal[]} */ ([]), refused: true,
		notes: ['[LevelCode Shell: stopped before any file change was applied. NONE of this command\'s file changes were applied.]'],
	});
	const isCancelled = () => { try { return !!(io.cancelled && io.cancelled()); } catch { return false; } };
	// Changed on disk since the command read it (a save, another tab)? Never overwrite what someone else wrote.
	if (!refusals.length) {
		for (const { c } of plan) {
			if (isCancelled()) { return stopped(); }
			const before = c.kind === 'write' ? (c.existed ? c.before : null) : c.before;
			const now = await io.readNow(c.path);
			if (!same(now, before)) { refusals.push({ c, why: 'it changed while the command ran, so the command\'s result is not applied over it' }); }
		}
	}
	if (isCancelled()) { return stopped(); }

	if (refusals.length) {
		/** @type {string[]} */ const notes = [];
		for (const r of refusals.slice(0, 6)) { notes.push('[LevelCode Shell: refused: ' + label(r.c) + ' — ' + r.why + ']'); }
		if (refusals.length > 6) { notes.push('[LevelCode Shell: …and ' + (refusals.length - 6) + ' more refused]'); }
		notes.push('[LevelCode Shell: NONE of this command\'s file changes were applied. Use the file tools for the changes that can be made, and tell the user about the rest.]');
		return { rest: [], applied: [], failed: refusals, notes, refused: true };
	}

	// --- apply: writes, then deletes (so a rename never has a moment with neither), both through the review ----
	/** @type {Change[]} */ const applied = [];
	/** @type {Refusal[]} */ const failed = [];
	const touched = ctx.touched;
	const bump = () => { ctx.editCount = (ctx.editCount || 0) + 1; };
	/** @param {{c: Change}} a @param {{c: Change}} b */
	const byPath = (a, b) => (a.c.path < b.c.path ? -1 : a.c.path > b.c.path ? 1 : 0);
	for (const { c, review } of plan.filter((x) => x.c.kind === 'write').sort(byPath)) {
		try {
			if (typeof ctx.applyEdit !== 'function') { throw new Error('this host has no review'); }
			const ok = await ctx.applyEdit({ path: review, exists: !!c.existed, proposed: utf8.decode(/** @type {Uint8Array} */ (c.after)) });
			if (ok) { bump(); if (touched) { touched.add(c.path); } applied.push(c); }
			else { failed.push({ c, why: 'the editor could not apply it' }); }
		} catch (e) { failed.push({ c, why: 'the editor failed: ' + String((e && /** @type {any} */ (e).message) || e).slice(0, 120) }); }
	}
	for (const { c, review } of plan.filter((x) => x.c.kind === 'delete').sort(byPath)) {
		try {
			if (typeof ctx.applyDelete !== 'function') { throw new Error('this host has no review'); }
			const ok = await ctx.applyDelete({ path: review });
			if (ok) { bump(); if (touched) { touched.delete(c.path); } applied.push(c); }
			else { failed.push({ c, why: 'the editor could not delete it' }); }
		} catch (e) { failed.push({ c, why: 'the editor failed: ' + String((e && /** @type {any} */ (e).message) || e).slice(0, 120) }); }
	}

	// Directories are the shell's own business: made first, removed only when every file in one went.
	const blocked = new Set(failed.map((f) => /** @type {any} */ (f.c).viaDir).filter(Boolean));
	/** @type {Change[]} */ const rest = [];
	for (const c of changes) {
		if (c.kind === 'mkdir') { rest.push(c); }
		else if (c.kind === 'rmdir' && !blocked.has(c.path) && failed.length === 0) { rest.push(c); }
	}

	/** @type {string[]} */ const notes = [];
	const sign = (/** @type {Change} */ c) => (c.kind === 'delete' ? '-' : /** @type {any} */ (c).existed ? '~' : '+');
	if (applied.length) {
		const list = applied.slice(0, 8).map((c) => sign(c) + label(c)).join(' ');
		notes.push('[LevelCode Shell: ' + applied.length + ' file' + (applied.length > 1 ? 's' : '') + ' changed, ready for Keep/Undo: ' + list + (applied.length > 8 ? ' …and ' + (applied.length - 8) + ' more' : '') + ']');
	}
	if (failed.length) {
		for (const f of failed.slice(0, 5)) { notes.push('[LevelCode Shell: NOT applied: ' + label(f.c) + ' — ' + f.why + ']'); }
		notes.push('[LevelCode Shell: PARTLY applied — ' + applied.length + ' of ' + (applied.length + failed.length) + ' file changes; the rest were not made]');
	}
	return { rest, applied, failed, notes, refused: false };
}

module.exports = { commitShellChanges, reviewPathFor, isPlainText, eolStyle, isProtected, PROTECTED, MAX_REVIEW_BYTES, MAX_REVIEWED_FILES };
