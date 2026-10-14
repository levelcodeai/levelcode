/*---------------------------------------------------------------------------------------------
 *  LevelCode Shell - writing a run's change set straight to the workspace (README section 5.2).
 *
 *  The engine never writes: a run ends with a CHANGE SET, and this is what turns it into files for the
 *  visitor's own terminal (an agent run goes through levelcode-ai's review instead, and only its leftovers,
 *  the folders, come here). Three rules, all of them about not doing the wrong thing quietly:
 *
 *    1. The whole set is judged BEFORE anything is written. A path outside a workspace folder, a file over its
 *       cap, too many entries, or a file that is no longer what the command read (somebody saved it, another
 *       tab, a second terminal) refuses the whole set: nothing is applied, and every reason is listed. The
 *       visitor can run the line again; they cannot un-write a half-applied `mv`.
 *    2. Writes go in an order that cannot lose data: folders, then files, then deletes (deepest first), then
 *       folders removed (deepest first). `mv a b` is "write b, delete a", so a failure part-way leaves both,
 *       never neither.
 *    3. A write that fails part-way is reported as what it is: "applied N of M", where it stopped and why.
 *       It is not atomic across files (a series of awaits) and the text does not pretend it is.
 *
 *  Stopping is asked in two ways. `cancelled()` is looked at while the set is being JUDGED (reading is harmless):
 *  before each file is checked and once more before the first write; after that this module does not look at it,
 *  because a half-applied set is only as safe as the ORDER above makes it, and finishing is better. What can end
 *  the writing early is the `io` itself: a call that ran out of time, or that was given up on because the run was
 *  stopped, rejects, and a rejection is a failure part-way (rule 3) like any other. A write that was given up on
 *  was not cancelled - a provider has no way to - and the note says it may still land.
 *
 *  Time is the io's business, not this module's: it has no clock. An io call that is out of time rejects with an
 *  error whose `timedOut` is true (its own bound, or the budget of the whole phase), one that was given up on
 *  because of a Stop with `abandoned: true`; `mayStillLand: true` says the call had been made, so its effect is
 *  unknown. While the set is being checked the first such error ends the check: a provider that does not answer
 *  does not answer the next file either, and the whole set is refused once, with how far the check got.
 *
 *  Pure: every file-system call, and the question "is this path inside a folder", is injected (`io`), so it is
 *  tested with plain node. A path is judged by `io.resolve`, never by string tests of its own.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

const { forNote, safeMessage, safeGet } = require('./sanitize');

/** How many reasons a note spells out; the rest are counted. */
const SHOWN = 6;
const KINDS = new Set(['write', 'delete', 'mkdir', 'rmdir']);
/** A path with a dot segment, an empty segment or a trailing slash is not the one the engine normalised. */
const UNNORMALISED = /(^|\/)\.\.?(\/|$)|\/\/|.\/$/;

/**
 * @typedef {{ kind: 'write', path: string, existed: boolean, before: Uint8Array|null, after: Uint8Array }
 *   | { kind: 'delete', path: string, before: Uint8Array|null, viaDir?: string }
 *   | { kind: 'mkdir', path: string }
 *   | { kind: 'rmdir', path: string }} Change
 *
 * @typedef {object} CommitIO
 * @property {(path: string) => any} resolve
 *     engine path -> what the other calls take (a Uri), or null/undefined when the path is in no workspace folder
 * @property {(target: any) => Promise<{ isDirectory: boolean, size: number } | null>} stat   null when nothing is there
 * @property {(target: any) => Promise<Uint8Array>} readFile
 * @property {(target: any, bytes: Uint8Array) => Promise<void>} writeFile
 * @property {(target: any) => Promise<void>} createDirectory   mkdir -p; the parents too
 * @property {(target: any) => Promise<void>} remove            one file, or one EMPTY folder
 *
 * @typedef {{ writeFile: number, writeRun: number, entries: number }} Caps
 * @typedef {{ total: number, applied: number, failed: number, refused: boolean, cancelled?: boolean, notes: string[] }} CommitResult
 *     `cancelled`: it was asked to stop before it had written anything; nothing was applied and it has no note
 * @typedef {{ phase: string, applied: number, total: number }} Progress
 *     The caller's own record of a commit, which it may read at any moment (to say what is known when it stops
 *     waiting): `phase` is 'check' until the first write is made, then 'write' (a caller that is committing what
 *     a review left sets its own name for the phase before the call); `applied` counts the changes that are
 *     confirmed done, STARTING from what it holds - a review that applied files already says how many - and
 *     `total` is the size of the whole command's change set, which the notes count against.
 */

/** @param {string} p */
function depth(p) { return p.split('/').length; }
/** @param {string} p */
function dirOf(p) { const i = p.lastIndexOf('/'); return i <= 0 ? '/' : p.slice(0, i); }
/** @param {string} a @param {string} b */
function byPath(a, b) { return a < b ? -1 : a > b ? 1 : 0; }
/** What was thrown, as a note's reason. Total: `e.message` is read inside safeMessage, where a getter that throws is only a reason. @param {unknown} e */
function reasonOf(e) { return safeMessage(e, 160); }
/** Did this io call run out of time, or get given up on? (The io's own words: see the header.) @param {unknown} e */
function isEnded(e) { return safeGet(e, 'timedOut') === true || safeGet(e, 'abandoned') === true; }
/** Was the call made, so that its effect is unknown? @param {unknown} e */
function mayStillLand(e) { return safeGet(e, 'mayStillLand') === true; }
/** @param {Uint8Array} a @param {Uint8Array} b */
function sameBytes(a, b) {
	if (a.length !== b.length) { return false; }
	for (let i = 0; i < a.length; i++) { if (a[i] !== b[i]) { return false; } }
	return true;
}
/** @param {string} text */
function note(text) { return '[LevelCode Shell: ' + text + ']'; }

/**
 * Everything that can be told without touching the disk. Returns the reasons the set cannot be applied (empty:
 * it can). Never throws, whatever the engine sent.
 * @param {unknown} changes
 * @param {Pick<CommitIO, 'resolve'>} io
 * @param {Caps} caps
 * @returns {string[]}
 */
function checkChangeSet(changes, io, caps) {
	if (!Array.isArray(changes)) { return ['the change set is not a list']; }
	/** @type {string[]} */ const out = [];
	if (changes.length > caps.entries) {
		return ['this command changed ' + changes.length + ' files and folders; at most ' + caps.entries + ' can be applied from one command'];
	}
	/** @type {Map<string, string>} the path with case and accent form folded away -> the first one that had it */
	const folded = new Map();
	let bytes = 0;
	for (const c of changes) {
		if (!c || typeof c !== 'object' || !KINDS.has(c.kind) || typeof c.path !== 'string') { out.push('an entry of the change set is malformed'); continue; }
		const p = forNote(c.path);
		if (c.path[0] !== '/' || UNNORMALISED.test(c.path)) { out.push(p + ' is not a normal absolute path'); continue; }
		if (!io.resolve(c.path)) { out.push(p + ' is outside the workspace folders'); continue; }
		// A disk that ignores case (macOS, Windows: the usual File System Access folder) cannot tell two paths apart
		// that differ only in case or in how an accent is written: a rename that only changes case is "write the new
		// name, delete the old", and the delete removes the file that was just written.
		const key = c.path.normalize('NFC').toLowerCase();
		const first = folded.get(key);
		if (first !== undefined) {
			out.push(first === c.path
				? p + ' appears twice in the change set'
				: p + ' differs from ' + forNote(first) + ' only in letter case or accent form. A disk that ignores case cannot keep the two apart'
					+ ' (a move would become a deletion), and this shell cannot tell which kind of disk the folder is on, so it refuses on every one'
					+ ' (a case-sensitive disk, like the scratch workspace, would have kept both): use one spelling, or rename in a command of its own');
			continue;
		}
		folded.set(key, c.path);
		if (c.kind === 'write') {
			if (!(c.after instanceof Uint8Array) || typeof c.existed !== 'boolean' || !(c.before === null || c.before instanceof Uint8Array)) { out.push('the entry for ' + p + ' is malformed'); continue; }
			if (c.after.length > caps.writeFile) { out.push(p + ' would be ' + c.after.length + ' bytes; at most ' + caps.writeFile + ' per file'); }
			bytes += c.after.length;
		} else if (c.kind === 'delete' && !(c.before === null || c.before instanceof Uint8Array)) {
			out.push('the entry for ' + p + ' is malformed');
		}
	}
	if (bytes > caps.writeRun) { out.push('the files this command wrote total ' + bytes + ' bytes; at most ' + caps.writeRun + ' per command'); }
	return out;
}

/**
 * What is wrong with one path of the set, or null: it is no longer what the command saw.
 * @param {Change} c @param {CommitIO} io @returns {Promise<string|null>}
 */
async function conflictOf(c, io) {
	const t = io.resolve(c.path);
	const p = forNote(c.path);
	const st = await io.stat(t);
	if (c.kind === 'write' || c.kind === 'delete') {
		const expectedHere = c.kind === 'delete' || c.existed;
		if (!expectedHere) { return st ? p + ' was created while the command ran' : null; }
		if (!st) { return p + ' was removed while the command ran'; }
		if (st.isDirectory) { return p + ' is a folder now'; }
		const before = c.before;
		if (before && (st.size !== before.length || !sameBytes(await io.readFile(t), before))) { return p + ' changed while the command ran'; }
		return null;
	}
	return st && !st.isDirectory ? p + ' is a file now' : null;
}

/**
 * Is anything on disk no longer what the command saw? Reads each path once, and a file's bytes only when its
 * size still matches. A path that cannot be checked is a conflict, not a pass - except one the file system did
 * not ANSWER in time: that ends the check (`late` says where and why), because the next path will not be answered
 * either and the answer is the same whatever else is found. Stops looking, and returns what it has, as soon as
 * `cancelled()` says so (the caller then discards the answer).
 * @param {Change[]} changes @param {CommitIO} io @param {() => boolean} [cancelled]
 * @returns {Promise<{ conflicts: string[], late: string|null }>}
 */
async function findConflicts(changes, io, cancelled) {
	/** @type {string[]} */ const conflicts = [];
	let looked = 0;
	for (const c of changes) {
		if (cancelled && cancelled()) { break; }
		try {
			const why = await conflictOf(c, io);
			if (why) { conflicts.push(why); }
		} catch (e) {
			if (isEnded(e)) {
				return { conflicts, late: 'the changes could not be checked in time: ' + forNote(c.path) + ': ' + reasonOf(e) + ' (' + looked + ' of ' + changes.length + ' were checked)' };
			}
			conflicts.push(forNote(c.path) + ' could not be checked: ' + reasonOf(e));
		}
		looked++;
	}
	return { conflicts, late: null };
}

/**
 * Apply a run's change set to the workspace.
 * @param {Change[]} changes
 * @param {CommitIO} io
 * @param {Caps} caps
 * @param {() => boolean} [cancelled]  true: stop, before anything is written (see the header)
 * @param {Progress} [progress]  kept up to date as the commit goes (see the type); the notes count against its numbers
 * @returns {Promise<CommitResult>}
 */
async function commitChanges(changes, io, caps, cancelled, progress) {
	const total = Array.isArray(changes) ? changes.length : 0;
	// A review may have applied files already, and this is what it left: the notes say "3 of 5", not "0 of 2".
	const base = progress ? progress.applied : 0;
	const grand = progress ? Math.max(progress.total, base + total) : total;
	const refuse = (/** @type {string[]} */ reasons) => {
		const notes = reasons.slice(0, SHOWN).map((r) => note('refused: ' + r));
		if (reasons.length > SHOWN) { notes.push(note('and ' + (reasons.length - SHOWN) + ' more refused')); }
		notes.push(note(base === 0
			? 'NONE of this command\'s file changes were applied.'
			: 'NONE of the remaining ' + total + ' change' + (total === 1 ? ' was' : 's were') + ' applied (' + base + ' of ' + grand + ' had already been).'));
		return { total, applied: 0, failed: total, refused: true, notes };
	};
	const problems = checkChangeSet(changes, io, caps);
	if (problems.length) { return refuse(problems); }
	if (total === 0) { return { total: 0, applied: 0, failed: 0, refused: false, notes: [] }; }
	const check = await findConflicts(changes, io, cancelled);
	// Asked again here, after the last await of the check: from this line to the end of the function nothing waits
	// for a decision, and what is written is written whole.
	if (cancelled && cancelled()) { return { total, applied: 0, failed: total, refused: false, cancelled: true, notes: [] }; }
	if (check.late !== null) { return refuse(check.conflicts.concat(check.late)); }
	if (check.conflicts.length) { return refuse(check.conflicts); }
	if (progress) { progress.phase = 'write'; }

	const of = (/** @type {string} */ kind) => /** @type {any[]} */ (changes.filter((c) => c.kind === kind));
	const mkdirs = of('mkdir'), writes = of('write').sort((a, b) => byPath(a.path, b.path));
	const deletes = of('delete').sort((a, b) => depth(b.path) - depth(a.path) || byPath(a.path, b.path));
	const rmdirs = of('rmdir').sort((a, b) => depth(b.path) - depth(a.path) || byPath(a.path, b.path));

	let applied = 0;
	/** @type {{ path: string, reason: string, landing: boolean } | null} */
	let stopped = null;
	/** Run one step unless an earlier one failed; the first failure ends the apply. It never throws: a reason is read totally. */
	const step = async (/** @type {string} */ path, /** @type {boolean} */ counted, /** @type {() => Promise<void>} */ fn) => {
		if (stopped) { return; }
		try {
			await fn();
			if (counted) { applied++; if (progress) { progress.applied++; } }
		} catch (e) { stopped = { path, reason: reasonOf(e), landing: mayStillLand(e) }; }
	};

	// Folders first: the ones the command made, and the parent of every file it wrote. A folder that is already
	// there is left alone (not every provider is idempotent about it).
	/** @type {Map<string, boolean>} path -> a change of its own (counted) */
	const ensure = new Map();
	for (const c of mkdirs) { ensure.set(c.path, true); }
	for (const c of writes) { const d = dirOf(c.path); if (!ensure.has(d)) { ensure.set(d, false); } }
	for (const [path, counted] of Array.from(ensure).sort((a, b) => depth(a[0]) - depth(b[0]) || byPath(a[0], b[0]))) {
		const t = io.resolve(path);
		if (!t) { continue; }   // the parent of a file at a mount's root is no folder of ours: nothing to make
		await step(path, counted, async () => {
			const st = await io.stat(t);
			if (st && st.isDirectory) { return; }
			await io.createDirectory(t);
		});
	}
	for (const c of writes) { await step(c.path, true, () => io.writeFile(io.resolve(c.path), c.after)); }
	for (const c of deletes) { await step(c.path, true, () => io.remove(io.resolve(c.path))); }
	for (const c of rmdirs) {
		await step(c.path, true, async () => {
			const t = io.resolve(c.path);
			if (await io.stat(t)) { await io.remove(t); }
		});
	}

	if (stopped) {
		const s = /** @type {{ path: string, reason: string, landing: boolean }} */ (stopped);
		return {
			total, applied, failed: total - applied, refused: false,
			notes: [note('applied ' + (base + applied) + ' of ' + grand + ' file changes; stopped at ' + forNote(s.path) + ': ' + s.reason + '.'
				+ (s.landing ? ' That call was not answered and cannot be cancelled: it may still land.' : '') + ' The rest were not applied.')],
		};
	}
	return { total, applied, failed: 0, refused: false, notes: [] };
}

module.exports = { commitChanges, checkChangeSet, note };
