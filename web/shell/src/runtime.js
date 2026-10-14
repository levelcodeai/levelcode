/*---------------------------------------------------------------------------------------------
 *  LevelCode Shell - the extension-host half: engine workers, the read-only file-system RPC they are served
 *  by, the commit of what a run changed, and the two things that use all of that: a persistent terminal
 *  Session and the one-shot ChildLike the agent's run_command gets. README sections 3, 3b, 4, 5 and 7.
 *
 *  The engine (a JavaScript bash) lives in a nested classic Worker, because it never yields the thread and
 *  ignores AbortSignal while a script is CPU-bound: Stop is `terminate()` and the next run spawns a new one.
 *  So this side owns everything that has to survive that: cwd and env of a session, the commit, the budgets.
 *
 *  Everything environment-specific comes in through `deps`, so this file runs under plain node:
 *    vscode               the part of the API used: workspace.fs, workspace.workspaceFolders,
 *                         workspace.onDidChangeWorkspaceFolders (optional), Uri.parse
 *    loadEngineSource()   Promise<string>   the engine worker's script
 *    createWorker(src)    WorkerLike        { postMessage, terminate, onmessage, onerror, onmessageerror }
 *    now, setTimeout, clearTimeout          the clock; every timer here goes through them
 *    limits               partial override of info.js LIMITS (tests; never the product)
 *    log(event, data)     optional, for the output channel
 *
 *  What is always true, and pinned by test/unit/shell-runtime*.test.js:
 *    - the engine can READ the workspace and nothing else: a path is mapped by the mounts of its run, `..` is
 *      resolved first, and a path in no mount is EACCES;
 *    - a run never stays pending: a dead worker, a failed postMessage, a read that never answers, a stuck
 *      engine each settle it, with a message;
 *    - what a run changed is applied ONLY when the script ran to its end (how 'exit'). Stopped, timed out,
 *      over a limit or failed: nothing, and a note says so;
 *    - once the engine has said `done`, the commit is what ends the run, with the count of what it really
 *      applied, and it is BOUNDED: a provider call by fsMs, the read-only check by checkMs for a set of up to
 *      checkEntries entries and in proportion above that (at most checkMaxMs; refused whole when it runs out,
 *      nothing applied), the writing by twice that and never less than commitMs - the agent's review, and the
 *      folders it leaves, by commitMs - so that what the check lets through can be written (never a set half
 *      applied while the provider keeps answering); a worker that dies changes the wording of the result and
 *      never what is on disk;
 *    - a Stop or a dispose() during the commit ends it AT ONCE: every wait is given up and no further call is
 *      made, a set that was only being checked applies nothing, and one that was being written says how many
 *      changes were confirmed and that the one in flight cannot be cancelled and may still land - after
 *      what the run already knew once its engine had finished (a moved folder, the engine's notes, output that
 *      was cut, variables left out), which every ending says;
 *    - the shell's own give-up on the agent's review (commitMs) is a cancellation too: the review's
 *      `control.cancelled()` is true from then on, so a review that looks before each change stops applying
 *      once the model has been told the command failed;
 *    - every read of the engine is answered, whatever the provider threw, and a size that is not a number
 *      is an error, never "no limit";
 *    - a message from a terminated worker is dropped (the generation guard);
 *    - a terminal's /tmp and /home/user live in its engine's memory and die with it: the line after a replaced
 *      engine says so, once, naming the place that held something, and an engine that holds anything there - an
 *      empty folder is something - is kept twice as long when idle;
 *    - planMounts returns for any set of folders (one rooted at /mnt included), and what it returns is what the
 *      engine would plan for the same folders: mounts that are normalised paths the engine never moves again.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

const { PROGRAMS, BUILTINS, createInfo, checkBudgetMs, writeBudgetMs } = require('./info');
const { commitChanges, checkChangeSet, note } = require('./commit');
const { forNote, safeMessage, safeGet } = require('./sanitize');

/** vscode.FileType.Directory (a stable bit of the API). */
const DIR = 2;
/** vscode.FileType.File. */
const FILE = 1;
const HOWS = new Set(['exit', 'limit', 'deadline', 'aborted', 'error']);
/** The exit status of a run that did not run to its end, by how it ended. */
const EXIT_FOR_HOW = /** @type {Record<string, number>} */ ({ limit: 126, deadline: 124, aborted: 130, error: 1 });
const MAX_NOTES = 20;
const MAX_NOTE_LENGTH = 2000;
/** The longest `explanation` an agent run event carries. */
const MAX_EXPLANATION = 500;
/** The longest delay setTimeout takes: a larger one is read as 1 ms. */
const MAX_TIMER_MS = 2147483647;
const MAX_ENV_ENTRIES = 512;
const MAX_ENV_BYTES = 256 * 1024;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Top-level names of the engine's own in-memory root (engine/overlay-fs.js RESERVED): a folder there would shadow them. */
const RESERVED_TOP = new Set(['bin', 'dev', 'home', 'proc', 'tmp', 'usr']);
/** Directories that exist in a fresh engine and so may be a session's cwd after its worker was replaced. */
const ENGINE_DIRS = new Set(['/', '/tmp', '/home/user']);

/**
 * @typedef {{ name: string, root: string, uri: string }} FolderRef
 * @typedef {{ id: string, name: string, root: string, mount: string, uri: string, reason: string|null }} Mount
 * @typedef {import('./commit').Change} Change
 * @typedef {{ exitCode: number, how: 'exit'|'limit'|'deadline'|'aborted'|'error', notes: string[], cwd: string, applied: number, durationMs: number }} RunResult
 * @typedef {{ type: 'start', id: number, command: string, cwd: string, explanation?: string }
 *   | { type: 'chunk', id: number, stream: 'stdout'|'stderr', text: string }
 *   | { type: 'end', id: number, exitCode: number, how: string, notes: string[] }} AgentRunEvent
 * @typedef {{ postMessage(m: any, transfer?: any[]): void, terminate(): void, onmessage: any, onerror: any, onmessageerror?: any }} WorkerLike
 */

/* ===== paths and mounts =============================================================================== */

/**
 * An absolute posix path with `.` and `..` resolved, or null when it is not one (relative, NUL, absurdly long).
 * @param {unknown} p
 * @returns {string|null}
 */
function normalizePath(p) {
	if (typeof p !== 'string' || p.length === 0 || p.length > 4096 || p[0] !== '/' || p.indexOf('\0') !== -1) { return null; }
	/** @type {string[]} */ const out = [];
	for (const seg of p.split('/')) {
		if (seg === '' || seg === '.') { continue; }
		if (seg === '..') { out.pop(); continue; }
		out.push(seg);
	}
	return '/' + out.join('/');
}

/** @param {string} p @param {string} root */
function isInside(p, root) { return p === root || p.startsWith(root === '/' ? '/' : root + '/'); }

/** The longest name a relocated folder is given under /mnt (and the longest one a note shows): a longer one cannot be typed, and a path is at most 4096 characters. */
const MOUNT_NAME_MAX = 100;

/** @param {string} p */
function baseName(p) { return p.slice(p.lastIndexOf('/') + 1); }

/**
 * The leaf a relocated folder is mounted at: the engine's own rule (engine/overlay-fs.js planMounts), so that a plan
 * made here is one the engine takes as it is and never moves again. Whatever is not [A-Za-z0-9._-] is `_`, and so are
 * leading dots: a folder called '.' or '..' must not become '/mnt/..', which is no normalised path (this side could
 * never match it, and the engine would normalise it to '/' and relocate it a second time).
 * @param {string} name
 */
function mountLeaf(name) {
	return name.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+/, '_').slice(0, MOUNT_NAME_MAX);
}

/**
 * Where each workspace folder is mounted in the engine. Normally at its own root, so the paths a person or the
 * model sees are the paths the shell sees. A mount the engine cannot hold is moved under /mnt: the root itself,
 * a folder that would shadow the engine's own /tmp, /bin, /home..., and a folder equal to or nested with an
 * earlier one (the engine's mount table refuses to be built with any of them, which would take the whole shell
 * down for one oddly named folder).
 *
 * It is the engine's own plan (engine/overlay-fs.js planMounts), in the same two steps and with the same names, so
 * the engine - which is handed these mounts, not the folders - never has anything left to move; the unit tests run
 * both over the same folders. First every folder that can stay where it is does, in order; then the others go under
 * the base, in order, each at its own name or that and -2, -3... The base is /mnt, unless a folder that stayed is
 * AT or ABOVE it (one rooted at /mnt would swallow every name below it, and a search for a free one would never
 * end), then /lc-mnt, /lc-mnt-2... So a folder is never moved because of another folder that was itself moved.
 *
 * It always returns: every search below is over finitely many names, each of which one taken mount spoils at most once.
 * @param {FolderRef[]} folders
 * @returns {Mount[]}
 */
function planMounts(folders) {
	/** @type {Mount[]} */ const out = [];
	/** @type {Mount[]} */ const moved = [];
	/** @type {string[]} */ const taken = [];
	const clashes = (/** @type {string} */ p) => taken.some((t) => isInside(p, t) || isInside(t, p));
	folders.forEach((f, i) => {
		if (!f || typeof f.uri !== 'string') { return; }
		const root = normalizePath(f.root);
		if (root === null) { return; }
		// (the engine's name for a folder with none is the last segment of its path)
		const name = f.name ? String(f.name) : baseName(root) || 'folder';
		/** @type {string|null} */ let reason = null;
		if (root === '/') { reason = 'it is the root of the file system'; }
		else if (RESERVED_TOP.has(root.split('/')[1])) { reason = 'that path is one the shell uses for itself'; }
		else if (clashes(root)) { reason = 'it overlaps another folder'; }
		/** @type {Mount} */ const m = { id: 'ws' + i, name, root, mount: root, uri: f.uri, reason };
		out.push(m);
		if (reason) { moved.push(m); } else { taken.push(root); }
	});
	let base = '/mnt';
	for (let b = 1; taken.some((t) => isInside(base, t)); b++) { base = '/lc-mnt' + (b > 1 ? '-' + b : ''); }
	for (const m of moved) {
		const leaf = mountLeaf(m.name);
		let n = 1;
		do { m.mount = base + '/' + leaf + (n > 1 ? '-' + n : ''); n++; } while (clashes(m.mount));
		taken.push(m.mount);
	}
	return out;
}

/** The mount an engine path (already normalised) is in. @param {Mount[]} mounts @param {string} p */
function findMount(mounts, p) {
	/** @type {Mount|null} */ let best = null;
	for (const m of mounts) { if (isInside(p, m.mount) && (!best || m.mount.length > best.mount.length)) { best = m; } }
	return best;
}

/**
 * A workspace path (as levelcode-ai knows it, under a folder's `root`) as the engine sees it, or null.
 * @param {Mount[]} mounts @param {string} abs
 */
function toMountPath(mounts, abs) {
	/** @type {Mount|null} */ let best = null;
	for (const m of mounts) { if (isInside(abs, m.root) && (!best || m.root.length > best.root.length)) { best = m; } }
	if (!best) { return null; }
	const rest = abs === best.root ? '' : abs.slice(best.root === '/' ? 0 : best.root.length);
	return best.mount === '/' ? (rest || '/') : best.mount + rest;
}

/** The inverse, for paths handed back to levelcode-ai. A path in no mount is returned as it is. @param {Mount[]} mounts @param {string} p */
function toRootPath(mounts, p) {
	const m = findMount(mounts, p);
	if (!m) { return p; }
	const rest = p === m.mount ? '' : p.slice(m.mount.length);
	return m.root === '/' ? (rest || '/') : m.root + rest;
}

/* ===== errors the engine is told about ================================================================ */

const POSIX_TEXT = /** @type {Record<string, string>} */ ({
	ENOENT: 'no such file or directory', EEXIST: 'file exists', ENOTDIR: 'not a directory', EISDIR: 'is a directory',
	EACCES: 'permission denied', EFBIG: 'file too large', ETIMEDOUT: 'timed out', EINVAL: 'invalid argument',
	EIO: 'input/output error',
});

/**
 * vscode.FileSystemError -> a POSIX code. Its `code` is the factory name ('FileNotFound') and its `name`
 * 'EntryNotFound (FileSystemError)' (measured in the web workbench); a File System Access folder can throw a
 * DOMException with the browser's own names instead.
 * @param {any} e
 */
function posixCode(e) {
	// (read totally: what a provider throws may have a getter that throws)
	const code = safeGet(e, 'code');
	const name = safeGet(e, 'name');
	const c = typeof code === 'string' ? code : '';
	const n = typeof name === 'string' ? name : '';
	if (c === 'FileNotFound' || /^EntryNotFound/.test(n) || n === 'NotFoundError') { return 'ENOENT'; }
	if (c === 'FileExists' || /^EntryExists/.test(n)) { return 'EEXIST'; }
	if (c === 'FileNotADirectory' || /^EntryNotADirectory/.test(n) || n === 'TypeMismatchError') { return 'ENOTDIR'; }
	if (c === 'FileIsADirectory' || /^EntryIsADirectory/.test(n)) { return 'EISDIR'; }
	if (c === 'NoPermissions' || /^NoPermissions/.test(n) || n === 'NotAllowedError' || n === 'SecurityError' || n === 'NoModificationAllowedError') { return 'EACCES'; }
	if (Object.prototype.hasOwnProperty.call(POSIX_TEXT, c)) { return c; }
	return 'EIO';
}

/** An error this runtime raises itself, in the engine's terms. @param {string} code @param {string} [more] */
function fsError(code, more) {
	return Object.assign(new Error(POSIX_TEXT[code] + (more ? ': ' + more : '')), { code, ours: true });
}

/**
 * What the engine is told about a failed read: a POSIX code and plain text. A provider's own message is not
 * passed on (it carries URIs); only an error it did not classify keeps a trimmed copy of it.
 * @param {any} e @returns {{ code: string, message: string }}
 */
function toWireError(e) {
	const code = posixCode(e);
	if (safeGet(e, 'ours') === true) { return { code, message: safeMessage(e, 200) }; }
	if (code !== 'EIO') { return { code, message: POSIX_TEXT[code] }; }
	return { code, message: POSIX_TEXT.EIO + ': ' + safeMessage(e, 160) };
}

/* ===== small helpers ================================================================================== */

/** @param {unknown} n @param {number} dflt */
function toExit(n, dflt) {
	return typeof n === 'number' && Number.isFinite(n) ? ((Math.trunc(n) % 256) + 256) % 256 : dflt;
}

/**
 * Strings only, sensible names, bounded: what is carried between runs and handed to the engine. A variable
 * that would take it over a bound is left out - that one, not everything after it - and counted, so the
 * caller can say so.
 * @param {unknown} o
 * @returns {{ env: Record<string, string>, dropped: number }}
 */
function cleanEnv(o) {
	/** @type {Record<string, string>} */ const env = {};
	let dropped = 0;
	if (!o || typeof o !== 'object') { return { env, dropped }; }
	let bytes = 0, count = 0;
	for (const k of Object.keys(o)) {
		const v = /** @type {any} */ (o)[k];
		if (!ENV_NAME.test(k) || typeof v !== 'string') { continue; }
		const size = k.length + v.length;
		if (count >= MAX_ENV_ENTRIES || bytes + size > MAX_ENV_BYTES) { dropped++; continue; }
		count++;
		bytes += size;
		env[k] = v;
	}
	return { env, dropped };
}

/** The note for variables that were left out by cleanEnv. @param {number} n */
function droppedEnvNote(n) {
	return note(n + ' environment variable' + (n === 1 ? ' was' : 's were') + ' not kept: this shell carries at most ' + MAX_ENV_ENTRIES + ' variables and ' + MAX_ENV_BYTES / 1024 + ' KiB of them');
}

/** A duration for a note: '60 s', '1.5 s', '100 ms'. @param {number} ms */
function span(ms) { return ms >= 1000 ? Math.round(ms / 100) / 10 + ' s' : Math.round(ms) + ' ms'; }

/** The first `max` UTF-16 units of `text`, without half of a surrogate pair at the end. @param {string} text @param {number} max */
function cut(text, max) {
	const t = text.slice(0, max);
	const last = t.charCodeAt(t.length - 1);
	return text.length > max && last >= 0xD800 && last <= 0xDBFF ? t.slice(0, -1) : t;
}

/** A terminal size for COLUMNS / LINES: a whole number from 1 to 9999, else nothing. @param {unknown} n @returns {string|undefined} */
function sizeVar(n) {
	if (typeof n !== 'number' || !Number.isFinite(n)) { return undefined; }
	const whole = Math.trunc(n);
	return whole >= 1 && whole < 10000 ? String(whole) : undefined;
}

/** A count the engine reports, or null when it is not one (absent, negative, not finite, not a number). @param {unknown} n @returns {number|null} */
function countOf(n) { return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? Math.trunc(n) : null; }

/**
 * What one of the engine's in-memory folders holds, from the two counts its `done` gives for it: how many, and whether
 * the count has FOLDERS in it. `<name>Entries` is files and folders (an empty folder is something that cannot be made
 * again too); `<name>Files` is what an engine that does not say that reports, and is files only. The larger of the two
 * is believed when both are there (a count of entries below the count of files cannot be true, and the loss of files is
 * the thing that must not go unsaid); one that is not a count is the same as one that is not there.
 * @param {any} stats @param {'tmp'|'home'} name
 * @returns {{ n: number, folders: boolean }}
 */
function heldIn(stats, name) {
	const entries = countOf(stats[name + 'Entries']);
	const files = countOf(stats[name + 'Files']) || 0;
	const n = entries === null ? files : Math.max(entries, files);
	return { n, folders: entries !== null && n > 0 };
}

/**
 * What the `done` of an engine that was asked to keep a terminal's memory says it holds there: /tmp and /home/user - the
 * visitor reaches the second by `~`, `$HOME` or a bare `cd` - and both go with the engine. `n` is the two together: what
 * the idle time and the choice of the worker to replace are decided by.
 * @param {any} msg
 * @returns {Held}
 */
function heldOf(msg) {
	const stats = msg && msg.stats && typeof msg.stats === 'object' ? msg.stats : null;
	if (!stats) { return NOTHING_HELD; }
	const tmp = heldIn(stats, 'tmp');
	const home = heldIn(stats, 'home');
	return { n: tmp.n + home.n, tmp, home };
}

/** @param {{ n: number, folders: boolean }} h  '1 file or folder', '5 files and folders', '3 files', '1 file' */
function countText(h) {
	const n = h.n;
	return h.folders ? (n === 1 ? '1 file or folder' : n + ' files and folders') : n + ' file' + (n === 1 ? '' : 's');
}

/**
 * The note for an engine that was replaced while it held something: what, and where. Only the place that held something
 * is named (a /tmp that was empty is not "emptied"), and when both did there is one note, not two.
 * @param {Held} held  with n > 0
 */
function emptiedNote(held) {
	const keep = 'which a minute or two of idle time, Ctrl+C or a timeout ends. Keep what matters in a workspace folder';
	if (held.tmp.n > 0 && held.home.n > 0) {
		return note('/tmp and /home/user were emptied when the shell restarted (/tmp held ' + countText(held.tmp) + ', /home/user held ' + countText(held.home) + '): they live in the engine\'s memory, ' + keep);
	}
	const where = held.tmp.n > 0 ? '/tmp' : '/home/user';
	return note(where + ' was emptied when the shell restarted (it held ' + countText(held.tmp.n > 0 ? held.tmp : held.home) + '): ' + where + ' lives in the engine\'s memory, ' + keep);
}

/** @param {unknown} list @returns {string[]} */
function cleanNotes(list) {
	if (!Array.isArray(list)) { return []; }
	return list.filter((n) => typeof n === 'string' && n.length > 0).slice(0, MAX_NOTES).map((n) => {
		const t = forNote(n.slice(0, MAX_NOTE_LENGTH));
		return t[0] === '[' ? t : note(t);
	});
}

/**
 * @typedef {{ n: number, tmp: { n: number, folders: boolean }, home: { n: number, folders: boolean } }} Held
 *   what a terminal's engine holds in its own memory, which is lost with it: `n` the two together, `folders`: that count
 *   has folders in it (not only files)
 */

/** @type {Held} */
const NOTHING_HELD = Object.freeze({ n: 0, tmp: Object.freeze({ n: 0, folders: false }), home: Object.freeze({ n: 0, folders: false }) });

/**
 * @typedef {object} Run  one script, from the moment it was asked for to the moment it was settled
 * @property {number} id
 * @property {'agent'|'terminal'} kind
 * @property {'queued'|'running'|'committing'|'settled'} state
 * @property {string} script
 * @property {string} cwd                    engine space
 * @property {Record<string,string>} env
 * @property {Mount[]} mounts
 * @property {{ rec: Rec|null }} owner       where a terminal session keeps its worker; the pool's, for the agent
 * @property {{ readFile: number, readRun: number, writeFile: number, writeRun: number, entries: number }} caps
 * @property {(t: string) => void} onStdout
 * @property {(t: string) => void} onStderr
 * @property {((changes: Change[], control: { cancelled(): boolean }) => Promise<any>)|undefined} commit
 * @property {number} timeoutMs
 * @property {Rec|null} rec
 * @property {'SIGTERM'|'SIGKILL'|null} killed
 * @property {number} readBytes
 * @property {number} outChars
 * @property {boolean} outCapped
 * @property {number} t0
 * @property {any} deadlineTimer
 * @property {string[]} lead                 notes that go first in whatever ends the run (a /tmp or /home/user that was emptied, variables left out; from the engine's `done`
 *     on, what that result already says - a moved folder, the engine's notes, output cut - so that a Stop which does not wait for the commit says it too)
 * @property {boolean} reviewGivenUp         the shell stopped waiting for the agent's review (commitMs): what control.cancelled() answers from then on
 * @property {string|null} workerFailure     why the engine's worker died after it had said `done`, while the commit was going on
 * @property {Progress|null} progress        where the commit is (from the moment the engine said `done`)
 * @property {Gate|null} gate                what the commit's calls to the provider go through
 * @property {(o: Outcome) => void} resolve
 *
 * @typedef {import('./commit').Progress} Progress
 *
 * @typedef {object} Gate
 * @property {<T>(start: () => Promise<T>, o: { writes: boolean, within?: number, onGiveUp?: () => void }) => Promise<T>} call
 *     one provider call: not made at all once the gate is closed or its budget is spent; waited for until the
 *     first of the call's own bound (`within`, else fsMs), the phase's budget and abandon(). `onGiveUp` is called
 *     when the wait ended that way - not when the call answered, or failed by itself
 * @property {() => boolean} abandon   end every wait now, and make no further call; true when a call that changes
 *     things was in flight (it cannot be taken back: it may still land)
 *
 * @typedef {object} Outcome
 * @property {number} exitCode @property {RunResult['how']} how @property {string[]} notes @property {string} cwd
 * @property {Record<string,string>|null} env @property {number} applied @property {number} durationMs @property {number} gen
 *
 * @typedef {object} Rec  one engine worker
 * @property {number} gen
 * @property {WorkerLike} worker
 * @property {string} key                    the mounts it was initialised with
 * @property {'agent'|'terminal'} kind
 * @property {boolean} dead
 * @property {Run|null} run                  the run that has it (from the moment it is taken)
 * @property {any} idleTimer
 * @property {number} lastUsed
 * @property {Held} held                     what the last `done` of a terminal run said its /tmp and /home/user hold (n 0: nothing, or not said)
 * @property {Promise<void>} ready
 * @property {(e?: Error) => void} readyOk @property {(e: Error) => void} readyFail
 * @property {any} readyTimer
 * @property {string} [failure]              why it was terminated, when that was a failure (what a run waiting for it is told)
 */

/**
 * @param {object} deps
 * @param {any} deps.vscode
 * @param {() => Promise<string>} deps.loadEngineSource
 * @param {(source: string) => WorkerLike} deps.createWorker
 * @param {() => number} deps.now
 * @param {(fn: () => void, ms: number) => any} deps.setTimeout
 * @param {(h: any) => void} deps.clearTimeout
 * @param {any} [deps.limits]
 * @param {(event: string, data?: any) => void} [deps.log]
 */
function createRuntime(deps) {
	const vscode = deps.vscode;
	const { info, update: updateInfo, limits } = createInfo(deps.limits);
	const log = (/** @type {string} */ event, /** @type {any} */ data) => { try { if (deps.log) { deps.log(event, data); } } catch { /* a logger must not break a run */ } };

	let disposed = false;
	let nextRunId = 0;
	let nextGen = 0;
	/** @type {Set<Rec>} */ const workers = new Set();
	/** @type {Set<Run>} */ const active = new Set();
	/** @type {Set<{ dispose(): void }>} */ const sessions = new Set();
	/** @type {Set<(e: AgentRunEvent) => void>} */ const listeners = new Set();
	/** The agent's pool shares this holder; a terminal session has its own. */
	const agentOwner = { rec: /** @type {Rec|null} */ (null) };
	/** @type {Promise<string>|null} */ let sourceP = null;
	/** @type {Map<string, any>} */ const uris = new Map();

	/* ----- folders and mounts ----------------------------------------------------------------------- */

	/** @returns {FolderRef[]} the workspace folders as they are right now, in order */
	function folders() {
		const list = (vscode.workspace && vscode.workspace.workspaceFolders) || [];
		return list.map((/** @type {any} */ f) => ({ name: f.name, root: f.uri.path, uri: f.uri.toString() }));
	}
	const currentMounts = () => planMounts(folders());
	const keyOf = (/** @type {Mount[]} */ mounts) => JSON.stringify(mounts.map((m) => [m.id, m.mount, m.name, m.uri]));

	/** The Uri of an engine path inside mount `m`, or null when the folder's URI cannot be read. @param {Mount} m @param {string} p */
	function targetFor(m, p) {
		let base = uris.get(m.uri);
		if (!base) {
			try { base = vscode.Uri.parse(m.uri); } catch { return null; }
			uris.set(m.uri, base);
		}
		const bp = base.path.endsWith('/') ? base.path.slice(0, -1) : base.path;
		return base.with({ path: (bp + (p === m.mount ? '' : p.slice(m.mount.length))) || '/' });
	}

	/** Engine path -> Uri, or null when it is in no mount of this run. @param {Mount[]} mounts @param {string} raw */
	function resolveIn(mounts, raw) {
		const p = normalizePath(raw);
		const m = p && findMount(mounts, p);
		return m ? targetFor(m, /** @type {string} */ (p)) : null;
	}

	/**
	 * What every call of a commit to the file system goes through. A provider that never answers (a permission prompt
	 * nobody sees) must not hold a run for ever, and a Stop must not have to wait for it, so:
	 *
	 *    - a call is waited for at most `fsMs` (`within`: the review, which is one call that does a lot, is given the
	 *      whole budget instead);
	 *    - the read-only CHECK of a change set has `budgets.check` in all (checkBudgetMs(its size): `checkMs` up to
	 *      `checkEntries` entries, in proportion above, at most `checkMaxMs`), the part that WRITES has `budgets.write`
	 *      (the agent's review, then the folders it left: commitMs; the shell's own writes: twice the check's, and
	 *      never less than commitMs, so that what the check let through can be written - writeBudgetMs), each counted
	 *      from the first call made in it: a provider that answers every call just before fsMs is not waited for for
	 *      N x fsMs;
	 *    - abandon() ends every wait at once and no call is made after it: a Stop is not an in-flight read's time out.
	 *
	 * A call that is given up on is NOT cancelled - a provider has no way to - it is only no longer waited for, and
	 * if it changes things it may still land; the error says so (`mayStillLand`) and commit.js puts that in the
	 * note. A call that was never made cannot land, and its error says that too. `progress.phase` says which budget
	 * a call is in ('check' is the check's, any other the writing's).
	 * @param {Progress} progress @param {{ check: number, write: number }} budgets @returns {Gate}
	 */
	function createGate(progress, budgets) {
		/** @type {Map<(e: Error) => void, boolean>} every wait there is, and whether it is for a call that changes things */
		const waiting = new Map();
		let abandoned = false;
		/** @type {{ check: number|null, apply: number|null }} */
		const began = { check: null, apply: null };
		const timedOut = (/** @type {string} */ message, /** @type {boolean} */ landing) =>
			Object.assign(new Error(message), { code: 'ETIMEDOUT', timedOut: true, mayStillLand: landing });
		const stopped = () => Object.assign(new Error('stopped'), { abandoned: true });
		return {
			call(start, o) {
				// (unreachable while every wait is a chain of microtasks, since a Stop is a task of its own; it is here so that
				// "no call is made after a Stop" is the gate's own rule and not a consequence of how it is scheduled)
				if (abandoned) { return Promise.reject(stopped()); }
				const family = progress.phase === 'check' ? 'check' : 'apply';
				const budget = family === 'check' ? budgets.check : budgets.write;
				const now = deps.now();
				if (began[family] === null) { began[family] = now; }
				const left = /** @type {number} */ (began[family]) + budget - now;
				const budgetText = 'ran out of time: ' + (family === 'check' ? 'the check gets ' : 'the changes get ') + span(budget) + ' in all';
				if (left <= 0) { return Promise.reject(timedOut(budgetText, false)); }
				const own = o.within === undefined ? limits.workers.fsMs : o.within;
				const ms = Math.min(own, left);
				/** @type {Promise<any>} */ let p;
				try { p = Promise.resolve(start()); } catch (e) { return Promise.reject(e); }
				return new Promise((resolve, reject) => {
					/** @type {any} */ let timer = null;
					const end = () => { deps.clearTimeout(timer); waiting.delete(give); };
					// (only a timer and abandon() come here: a call that answers, or fails, settles by itself and is not given up on)
					const give = (/** @type {Error} */ err) => { end(); if (o.onGiveUp) { o.onGiveUp(); } reject(err); };
					timer = deps.setTimeout(() => give(timedOut(ms < own ? budgetText : 'timed out', o.writes)), ms);
					waiting.set(give, o.writes);
					p.then((v) => { end(); resolve(v); }, (e) => { end(); reject(e); });
				});
			},
			abandon() {
				if (abandoned) { return false; }
				abandoned = true;
				let landing = false;
				for (const [give, writes] of Array.from(waiting)) { landing = landing || writes; give(stopped()); }
				return landing;
			},
		};
	}

	/** @param {Mount[]} mounts @param {Gate} gate */
	function commitIO(mounts, gate) {
		const fs = vscode.workspace.fs;
		const read = { writes: false };
		const write = { writes: true };
		return {
			resolve: (/** @type {string} */ p) => resolveIn(mounts, p),
			async stat(/** @type {any} */ t) {
				try { const s = await gate.call(() => fs.stat(t), read); return { isDirectory: (s.type & DIR) !== 0, size: s.size }; }
				catch (e) { const c = posixCode(e); if (c === 'ENOENT' || c === 'ENOTDIR') { return null; } throw e; }
			},
			readFile: (/** @type {any} */ t) => gate.call(() => fs.readFile(t), read),
			writeFile: (/** @type {any} */ t, /** @type {Uint8Array} */ b) => gate.call(() => fs.writeFile(t, b), write),
			createDirectory: (/** @type {any} */ t) => gate.call(() => fs.createDirectory(t), write),
			remove: (/** @type {any} */ t) => gate.call(() => fs.delete(t, { recursive: false, useTrash: false }), write),
		};
	}

	/* ----- the read RPC: stat, readFile, readDir ---------------------------------------------------- */

	/** vscode.FileType bits -> the engine's word for it. @param {number} t @returns {'dir'|'file'} */
	function kindOf(t) { return (t & DIR) !== 0 ? 'dir' : 'file'; }

	/** A file's size from a stat, or null when it is not a number that can be counted with. @param {any} s */
	function sizeOf(s) { return s && typeof s.size === 'number' && Number.isFinite(s.size) && s.size >= 0 ? s.size : null; }

	/** @param {Promise<any>} p @param {number} ms */
	function withTimeout(p, ms) {
		return new Promise((resolve, reject) => {
			const h = deps.setTimeout(() => reject(fsError('ETIMEDOUT')), ms);
			p.then((v) => { deps.clearTimeout(h); resolve(v); }, (e) => { deps.clearTimeout(h); reject(e); });
		});
	}

	/**
	 * One read, for one run. The size of a file is asked BEFORE it is read, and the run's budget is reserved
	 * before the read starts, so reads issued together cannot add up past it.
	 * @param {Run} run @param {string} op @param {unknown} rawPath
	 * @returns {Promise<unknown>}
	 */
	async function readOp(run, op, rawPath) {
		const uri = resolveIn(run.mounts, /** @type {string} */ (rawPath));
		if (!uri) { throw fsError('EACCES', 'outside the workspace folders'); }
		const fs = vscode.workspace.fs;
		if (op === 'stat') {
			const s = await fs.stat(uri);
			// A folder's size is nothing the engine uses; a file's is what its caps and its budget are measured by.
			const size = sizeOf(s);
			if (size === null && (s.type & DIR) === 0) { throw fsError('EIO', 'the file system did not say how large the file is'); }
			return { type: kindOf(s.type), size: size === null ? 0 : size, mtime: typeof s.mtime === 'number' ? s.mtime : 0 };
		}
		if (op === 'readDir') {
			const list = await fs.readDirectory(uri);
			return list.map((/** @type {[string, number]} */ e) => [e[0], kindOf(e[1])]);
		}
		if (op !== 'readFile') { throw fsError('EINVAL', 'unknown operation'); }
		const s = await fs.stat(uri);
		if ((s.type & DIR) !== 0) { throw fsError('EISDIR'); }
		// Every comparison with NaN is false: a size that is not a number would switch the budget below off.
		const size = sizeOf(s);
		if (size === null) { throw fsError('EIO', 'the file system did not say how large the file is'); }
		if (size > run.caps.readFile) { throw fsError('EFBIG', size + ' bytes; this shell reads at most ' + run.caps.readFile + ' per file'); }
		if (run.readBytes + size > limits.read.served) { throw fsError('EFBIG', 'this command has read its share: at most ' + limits.read.served + ' bytes per command'); }
		run.readBytes += size;
		let bytes;
		try { bytes = await fs.readFile(uri); } catch (e) { run.readBytes -= size; throw e; }
		if (!(bytes instanceof Uint8Array)) { run.readBytes -= size; throw fsError('EIO', 'the file system did not return bytes'); }
		run.readBytes += bytes.length - size;
		if (bytes.length > run.caps.readFile || run.readBytes > limits.read.served) { throw fsError('EFBIG', 'the file is larger than it said it was'); }
		return bytes;
	}

	/**
	 * Answer one read of the engine. Always answers (a read nobody answers holds the run until its deadline): an
	 * error that cannot even be described - a provider threw something with no usable text - is EIO (toWireError is
	 * total).
	 * @param {Rec} rec @param {any} msg
	 */
	async function serveFs(rec, msg) {
		const run = rec.run;
		// A read after `done`, or while this worker has no run, is dropped: there is nobody to answer for.
		if (!run || run.state !== 'running') { return; }
		let reply;
		try {
			const value = await withTimeout(readOp(run, msg.op, msg.path), limits.workers.fsMs);
			reply = { t: 'fsr', rid: msg.rid, ok: true, value };
		} catch (e) {
			reply = { t: 'fsr', rid: msg.rid, ok: false, error: toWireError(e) };
		}
		if (rec.dead || rec.run !== run || run.state !== 'running') { return; }
		if (reply.ok && reply.value instanceof Uint8Array) {
			// The provider may hand back a view of a buffer it keeps: send a copy, and transfer the copy.
			const copy = reply.value.slice();
			reply.value = copy;
			post(rec, reply, [copy.buffer]);
		} else {
			post(rec, reply);
		}
	}

	/**
	 * The last line of defence for serveFs: whatever made it reject, the engine is told EIO (once) and nothing is left
	 * unhandled. @param {Rec} rec @param {any} msg @param {unknown} e
	 */
	function fsFailed(rec, msg, e) {
		log('fs-failed', { gen: rec.gen, message: messageOf(e) });
		const run = rec.run;
		if (rec.dead || !run || run.state !== 'running') { return; }
		post(rec, { t: 'fsr', rid: msg.rid, ok: false, error: { code: 'EIO', message: POSIX_TEXT.EIO } });
	}

	/* ----- workers ---------------------------------------------------------------------------------- */

	/**
	 * The engine's script, loaded once and kept. A load that fails, or that does not answer in the time a worker is
	 * given to start, is not kept: the next run asks again.
	 * @returns {Promise<string>}
	 */
	function engineSource() {
		if (!sourceP) {
			const p = /** @type {Promise<string>} */ (new Promise((resolve, reject) => {
				const h = deps.setTimeout(() => reject(new Error('the shell engine could not be loaded in ' + Math.round(limits.workers.readyMs / 1000) + ' s')), limits.workers.readyMs);
				Promise.resolve().then(() => deps.loadEngineSource()).then((s) => {
					deps.clearTimeout(h);
					if (typeof s !== 'string' || s.length === 0) { reject(new Error('the engine script is empty')); } else { resolve(s); }
				}, (e) => { deps.clearTimeout(h); reject(e); });
			}));
			sourceP = p;
			p.catch(() => { if (sourceP === p) { sourceP = null; } });
		}
		return sourceP;
	}

	/** @param {Rec} rec @param {any} msg @param {any[]} [transfer] @returns {boolean} */
	function post(rec, msg, transfer) {
		if (rec.dead) { return false; }
		try { rec.worker.postMessage(msg, transfer); return true; }
		catch (e) { failRec(rec, 'the shell engine could not be reached: ' + messageOf(e)); return false; }
	}

	/** What was thrown, as text for a note or the log. Total: see sanitize.safeMessage. @param {unknown} e */
	function messageOf(e) { return safeMessage(e, 200); }

	/**
	 * Terminate a worker for good: nothing it sends afterwards is heard. A run that still has it must be
	 * settled by the caller.
	 * @param {Rec} rec @param {string} [why]
	 */
	function terminateRec(rec, why) {
		if (rec.dead) { return; }
		rec.dead = true;
		deps.clearTimeout(rec.idleTimer);
		deps.clearTimeout(rec.readyTimer);
		workers.delete(rec);
		if (agentOwner.rec === rec) { agentOwner.rec = null; }
		try { rec.worker.onmessage = null; rec.worker.onerror = null; rec.worker.onmessageerror = null; } catch { /* a frozen stand-in */ }
		try { rec.worker.terminate(); } catch (e) { log('terminate-failed', { gen: rec.gen, message: messageOf(e) }); }
		rec.readyFail(new Error(rec.failure || 'the shell engine was stopped before it was ready'));
		log('worker-terminated', { gen: rec.gen, why });
	}

	/**
	 * The worker is gone or broken: forget it, and end the run it had with an error. A run whose engine had already
	 * said `done` is the exception: what it changed is being applied, which needs no worker, so the commit ends the
	 * run with its real count (settling here would say "nothing applied" over files that then land).
	 * @param {Rec} rec @param {string} message
	 */
	function failRec(rec, message) {
		if (rec.dead) { return; }
		const run = rec.run;
		rec.failure = message;
		log('worker-failed', { gen: rec.gen, kind: rec.kind, reason: message });
		terminateRec(rec, message);
		if (!run || run.state === 'settled') { return; }
		if (run.state === 'committing') { run.workerFailure = message; return; }
		settleRun(run, finish(run, 'error', 1, [note(message)], null, 0, rec.gen));
	}

	/**
	 * An idle worker is terminated after idleMs - twice that when it is a terminal's and its /tmp or /home/user holds
	 * anything (files, or folders only): an idle engine costs only memory (and there are four at most), what is in
	 * them is the one thing that cannot be made again, and the next line says so when it is gone anyway.
	 * @param {Rec} rec
	 */
	function armIdle(rec) {
		deps.clearTimeout(rec.idleTimer);
		const ms = limits.workers.idleMs * (rec.held.n > 0 ? 2 : 1);
		rec.idleTimer = deps.setTimeout(() => { if (!rec.dead && !rec.run) { terminateRec(rec, 'idle'); } }, ms);
	}

	/**
	 * @param {'agent'|'terminal'} kind @param {Mount[]} mounts @param {string} source
	 * @returns {Rec}
	 */
	function spawnRec(kind, mounts, source) {
		const gen = ++nextGen;
		const worker = deps.createWorker(source);
		/** @type {any} */ const rec = { gen, worker, key: keyOf(mounts), kind, dead: false, run: null, idleTimer: null, lastUsed: deps.now(), held: NOTHING_HELD, readyTimer: null };
		rec.ready = new Promise((resolve, reject) => { rec.readyOk = resolve; rec.readyFail = reject; });
		rec.ready.catch(() => { /* surfaced by whoever awaits it */ });
		workers.add(rec);
		worker.onmessage = (/** @type {any} */ ev) => onMessage(rec, ev && ev.data);
		worker.onerror = (/** @type {any} */ ev) => {
			if (ev && typeof ev.preventDefault === 'function') { ev.preventDefault(); }
			const said = safeGet(ev, 'message');
			failRec(rec, 'the shell engine stopped unexpectedly' + (said ? ': ' + messageOf(said) : ''));
		};
		worker.onmessageerror = () => failRec(rec, 'the shell engine sent a message that could not be read');
		rec.readyTimer = deps.setTimeout(() => failRec(rec, 'the shell engine did not start in ' + Math.round(limits.workers.readyMs / 1000) + ' s'), limits.workers.readyMs);
		post(rec, {
			t: 'init', gen, folders: mounts.map((m) => ({ id: m.id, path: m.mount, name: m.name })),
			limits: Object.assign({}, limits.engine), commands: PROGRAMS.slice(),
		});
		log('worker-spawned', { gen, kind });
		return rec;
	}

	/** @param {Rec} rec @param {any} data */
	function onMessage(rec, data) {
		if (rec.dead || !data || typeof data !== 'object') { return; }
		// The generation guard: a message stamped with another worker's generation is that worker's, late.
		if (data.gen !== undefined && data.gen !== rec.gen) { return; }
		try {
			switch (data.t) {
				case 'ready':
					if (data.gen !== rec.gen) { return; }
					deps.clearTimeout(rec.readyTimer);
					updateInfo(data.commands);
					rec.readyOk();
					return;
				case 'fs': serveFs(rec, data).catch((e) => fsFailed(rec, data, e)); return;
				case 'out': onOut(rec, data); return;
				case 'done': onDone(rec, data); return;
				default: return;
			}
		} catch (e) {
			failRec(rec, 'the shell engine sent something unexpected: ' + messageOf(e));
		}
	}

	/** @param {Rec} rec @param {any} msg */
	function onOut(rec, msg) {
		const run = rec.run;
		// (an empty chunk is nothing: no listener, terminal or mirror is told of it)
		if (!run || run.state !== 'running' || msg.id !== run.id || typeof msg.text !== 'string' || msg.text === '') { return; }
		run.outChars += msg.text.length;
		// The engine's own output cap is per stream; this is the host's, so a broken engine cannot flood the thread.
		if (run.outChars > limits.engine.maxOutputSize * 2) { run.outCapped = true; return; }
		try { (msg.stream === 'stderr' ? run.onStderr : run.onStdout)(msg.text); } catch (e) { log('listener-threw', { message: messageOf(e) }); }
	}

	/* ----- a run ------------------------------------------------------------------------------------ */

	/**
	 * @param {Run} run @param {Outcome['how']} how @param {number} exitCode @param {string[]} notes
	 * @param {Record<string,string>|null} env @param {number} applied @param {number} gen
	 * @returns {Outcome}
	 */
	function finish(run, how, exitCode, notes, env, applied, gen) {
		return { how, exitCode, notes, cwd: run.cwd, env, applied, durationMs: Math.max(0, deps.now() - run.t0), gen };
	}

	/** @param {Run} run @param {Outcome} o */
	function settleRun(run, o) {
		if (run.state === 'settled') { return; }
		run.state = 'settled';
		deps.clearTimeout(run.deadlineTimer);
		active.delete(run);
		if (run.lead.length > 0) { o.notes = run.lead.concat(o.notes); }
		const rec = run.rec;
		if (rec && !rec.dead && rec.run === run) { rec.run = null; rec.lastUsed = deps.now(); armIdle(rec); }
		run.resolve(o);
	}

	/**
	 * Stop a run, now. Still running: the worker is terminated, so nothing it staged is ever heard of, and the result
	 * says so. Already committing: the engine has finished and what is going on is the application of its changes,
	 * which a provider has no way to cancel - so the run does not wait for it. Every wait of the commit is given up and
	 * no further call is made (the gate), and the run ends AT ONCE with what is known: a Stop that came while the set
	 * was only being checked applied nothing, one that came while it was written says how many changes are confirmed
	 * and, when a write was in flight, that it cannot be cancelled and may still land.
	 * @param {Run} run @param {'SIGTERM'|'SIGKILL'} signal @returns {boolean}
	 */
	function killRun(run, signal) {
		if (run.state === 'settled') { return false; }
		run.killed = signal;
		if (run.state === 'committing') {
			const landing = /** @type {Gate} */ (run.gate).abandon();
			settleRun(run, stoppedWhileCommitting(run, signal, landing));
			return true;
		}
		if (run.rec) { terminateRec(run.rec, 'stopped'); }
		settleRun(run, finish(run, 'aborted', signal === 'SIGKILL' ? 137 : 130, [note('stopped. Any file changes the command had made were NOT applied.')], null, 0, run.rec ? run.rec.gen : 0));
		return true;
	}

	/**
	 * The result of a run that was stopped after its engine had finished: what the commit had got to, in words that
	 * are true of that moment. `landing`: a call that changes things was in flight, so it may still land. (What the
	 * engine's result already said - a moved folder, its own notes - is in run.lead, which settleRun puts in front.)
	 * @param {Run} run @param {'SIGTERM'|'SIGKILL'} signal @param {boolean} landing @returns {Outcome}
	 */
	function stoppedWhileCommitting(run, signal, landing) {
		const p = /** @type {Progress} */ (run.progress);
		/** @type {string[]} */ const notes = [];
		let applied = 0;
		if (p.phase === 'check') {
			notes.push(note('stopped before anything was applied: the command\'s file changes were being checked, and were NOT applied.'));
		} else if (p.phase === 'review') {
			// (the review is levelcode-ai's Keep/Undo: what it applied before the Stop stays there, and the model and the visitor are told where)
			notes.push(note('stopped while the review of its file changes was going on. A review cannot be interrupted: it may still apply some of them, and how many it applied is not known. Any it applied are in the Keep/Undo review.'));
		} else {
			applied = p.applied;
			notes.push(note('stopped while its file changes were being applied: ' + applied + ' of ' + p.total + ' were applied.'
				+ (landing ? ' The change being made at that moment cannot be cancelled and may still land; nothing more was started.' : ' Nothing more was started.')));
		}
		// (the engine's worker died after it had finished, and then this: both are true, and the failure comes last as it does when the commit ends the run)
		if (run.workerFailure) { notes.push(note(run.workerFailure + ', after the command had finished')); }
		return finish(run, 'aborted', signal === 'SIGKILL' ? 137 : 130, notes, null, applied, run.rec ? run.rec.gen : 0);
	}

	/**
	 * A worker for this run: its owner's if it is free and has the right mounts, else a free one of the pool,
	 * else a new one, else the least recently used idle one is replaced. Throws a plain Error (its message is
	 * what the visitor reads) when there is none to have.
	 * @param {Run} run @returns {Promise<Rec>}
	 */
	async function acquire(run) {
		const source = await engineSource();
		if (disposed) { throw new Error('the shell has been shut down'); }
		if (run.state === 'settled') { throw new Error('stopped'); }
		const key = keyOf(run.mounts);
		const idle = (/** @type {Rec} */ r) => !r.dead && !r.run;
		let rec = run.owner.rec;
		if (rec && (rec.dead || rec.run)) { rec = null; }
		if (!rec && run.kind === 'agent') {
			for (const r of workers) { if (r.kind === 'agent' && idle(r) && r.key === key && (!rec || r.lastUsed > rec.lastUsed)) { rec = r; } }
		}
		if (rec && rec.key !== key) { terminateRec(rec, 'folders changed'); rec = null; }
		if (!rec) {
			if (workers.size >= limits.workers.max) {
				// The one to replace: the least recently used idle worker - but one that holds anything in /tmp or /home/user
				// only when every idle one does (it is the one thing that cannot be made again; an agent's worker holds none).
				/** @type {Rec|null} */ let lru = null;
				const before = (/** @type {Rec} */ a, /** @type {Rec} */ b) => ((a.held.n > 0) !== (b.held.n > 0) ? b.held.n > 0 : a.lastUsed < b.lastUsed);
				for (const r of workers) { if (idle(r) && (!lru || before(r, lru))) { lru = r; } }
				if (!lru) { throw new Error('too many commands are running at once (' + limits.workers.max + '); try again when one has finished'); }
				terminateRec(lru, 'evicted');
			}
			// This terminal had an engine, with something in its /tmp or /home/user, and it is gone (idle, Ctrl+C, a deadline,
			// a crash, an eviction, other folders): the new one starts with both empty, and the visitor is told once. (Only a
			// terminal's worker remembers them: an agent's command starts from nothing, and so does every worker's.)
			const before = run.owner.rec;
			if (before && before.held.n > 0) { run.lead.push(emptiedNote(before.held)); }
			rec = spawnRec(run.kind, run.mounts, source);
			run.owner.rec = rec;
		}
		deps.clearTimeout(rec.idleTimer);
		rec.run = run;
		run.rec = rec;
		await rec.ready;
		return rec;
	}

	/** @param {Run} run @returns {Promise<Outcome>} never rejects */
	function execute(run) {
		return new Promise((resolve) => {
			run.resolve = resolve;
			active.add(run);
			(async () => {
				let rec;
				try {
					rec = await acquire(run);
				} catch (e) {
					settleRun(run, finish(run, 'error', 1, [note(messageOf(e))], null, 0, 0));
					return;
				}
				if (run.state === 'settled') { return; }   // stopped while the engine was starting
				run.state = 'running';
				run.deadlineTimer = deps.setTimeout(() => {
					if (run.state !== 'running') { return; }
					if (run.rec) { terminateRec(run.rec, 'deadline'); }
					settleRun(run, finish(run, 'deadline', 124, [note('the command ran out of time and was stopped. Any file changes it had made were NOT applied.')], null, 0, rec ? rec.gen : 0));
				}, run.timeoutMs);
				const msg = { t: 'run', id: run.id, script: run.script, cwd: run.cwd, env: run.env, stdin: '', caps: run.caps };
				// A terminal keeps /tmp from one line to the next, and an alias made on one is there on the next (the
				// engine carries them in the environment); an agent's command starts from nothing, like `sh -c`.
				post(rec, run.kind === 'terminal' ? Object.assign(msg, { keepTmp: true, expandAliases: true }) : msg);
			})().catch((e) => settleRun(run, finish(run, 'error', 1, [note(messageOf(e))], null, 0, 0)));
		});
	}

	/** @param {Rec} rec @param {any} msg */
	function onDone(rec, msg) {
		const run = rec.run;
		if (!run || run.state !== 'running' || msg.id !== run.id) { return; }   // late, duplicate, or for a run that was stopped
		run.state = 'committing';
		deps.clearTimeout(run.deadlineTimer);
		// From here the run is ended by its commit, which is bounded (the gate) and which a Stop gives up on at once.
		const total = Array.isArray(msg.changes) ? msg.changes.length : 0;
		run.progress = { phase: 'check', applied: 0, total };
		// Both budgets go with the set. The writing of the terminal's own commit is given twice the check's: what passed the
		// check at some speed a call needs up to twice the calls to write (a folder: a stat, then the create), so a set that
		// the check let through is one the writing can finish - never half a project where the check would have refused
		// the whole set with nothing written. The agent's is its review, one call that is given commitMs, and the folders
		// it leaves out of what is left of that.
		run.gate = createGate(run.progress, {
			check: checkBudgetMs(limits.workers, total),
			write: run.commit ? limits.workers.commitMs : writeBudgetMs(limits.workers, total),
		});
		if (run.kind === 'terminal') { rec.held = heldOf(msg); }
		outcomeOf(run, rec, msg).then(
			(o) => settleRun(run, o),
			(e) => settleRun(run, finish(run, 'error', 1, [note('could not finish the command: ' + messageOf(e))], null, 0, rec.gen)));
	}

	/**
	 * What the engine said, made into the run's outcome - and, when the script ran to its end, the commit.
	 * @param {Run} run @param {Rec} rec @param {any} msg @returns {Promise<Outcome>}
	 */
	async function outcomeOf(run, rec, msg) {
		const how = /** @type {Outcome['how']} */ (HOWS.has(msg.how) ? msg.how : 'error');
		const engineExit = toExit(msg.exitCode, how === 'exit' ? 1 : 0);
		// A folder that is not where its own path says is a surprise to whoever reads `pwd`: said on every run.
		// (a folder's name and path are the visitor's, or a file's: untrusted like everything that is not a constant here)
		const head = run.mounts.filter((m) => m.reason).map((m) => note('The folder "' + forNote(cut(m.name, MOUNT_NAME_MAX)) + (m.name.length > MOUNT_NAME_MAX ? '...' : '') + '" is mounted at ' + forNote(m.mount) + ', not at ' + forNote(m.root) + ': ' + m.reason + '.'))
			.concat(cleanNotes(msg.notes));
		if (run.outCapped) { head.push(note('the command wrote more than ' + limits.engine.maxOutputSize * 2 + ' characters; the rest was dropped')); }
		const changes = Array.isArray(msg.changes) ? msg.changes : [];
		const cwd = normalizePath(msg.cwd) || run.cwd;
		const carried = msg.env && typeof msg.env === 'object' ? cleanEnv(msg.env) : null;
		const env = carried ? carried.env : null;
		if (carried && carried.dropped > 0) { head.push(droppedEnvNote(carried.dropped)); }
		// What the result already says is true of the run however it ends. It goes on the run now, before the commit is waited
		// for, because a Stop settles the run at once (killRun) and what is left to say then is only what it adds: run.lead is
		// what settleRun puts in front of every ending.
		run.lead.push(...head);
		/** What the commit, or the reason there was none, adds after that. @type {string[]} */
		const notes = [];
		const done = (/** @type {number} */ exit, /** @type {number} */ applied) => {
			const o = finish(run, how, exit, notes, env, applied, rec.gen);
			o.cwd = cwd;
			return o;
		};

		if (how !== 'exit') {
			const cause = how === 'limit' ? 'a limit of this shell stopped the command'
				: how === 'deadline' ? 'the command ran out of time and was stopped'
				: how === 'aborted' ? 'the command was stopped'
				: 'the shell engine failed';
			const n = changes.length;
			notes.push(note(cause + '.' + (n > 0 ? ' Its ' + n + ' file change' + (n === 1 ? ' was' : 's were') + ' NOT applied.' : '')));
			return done(how === 'error' ? Math.max(engineExit, 1) : EXIT_FOR_HOW[how], 0);
		}

		// The script ran to its end: what it changed is applied now, and only now.
		let exit = engineExit;
		// What it was refused (a write outside a folder, to a protected path, past a cap) the engine has already said
		// on stderr; the status must not say it went well.
		if (Array.isArray(msg.denied) && msg.denied.length > 0 && exit === 0) { exit = 1; }

		let applied = 0;
		let failed = 0;
		if (changes.length > 0) {
			const r = await applyChanges(run, changes);
			applied = r.applied;
			failed = r.failed;
			notes.push(...r.notes);
		}
		if (failed > 0 && exit === 0) { exit = 1; }
		// The engine died after it had finished (see failRec): the commit above did not need it and is reported as it was.
		if (run.workerFailure) { notes.push(note(run.workerFailure + ', after the command had finished')); }
		// (a run that was stopped meanwhile was settled by killRun, at once; this answer is then dropped)
		return done(exit, applied);
	}

	/**
	 * A change as levelcode-ai knows it: every path in the agent's own terms (a relocated folder is at its root
	 * there, not under /mnt) - the path, and the folder a delete came through, which its review compares with the
	 * paths of the folders it is asked about.
	 * @param {Mount[]} mounts @param {any} c
	 */
	function toAgentChange(mounts, c) {
		const out = Object.assign({}, c, { path: toRootPath(mounts, c.path) });
		if (typeof c.viaDir === 'string') { out.viaDir = toRootPath(mounts, c.viaDir); }
		return out;
	}

	/**
	 * Commit a finished run's change set: levelcode-ai's review for an agent run that brought one, the
	 * workspace directly otherwise. Validated as a whole first in both cases.
	 *
	 * What the review hands back is trusted for what the contract says it is - `rest`, a list of the folders the
	 * command made and removed, which this shell then makes and removes; `notes`; `failed`, the count of file changes
	 * it could not apply - and no more: an entry that is not one of those folders is not applied, an answer that is not
	 * that shape is "no answer", and a count that is not a count is not believed.
	 *
	 * Time is bounded the same way in both routes (the gate): a call to the file system is waited for `fsMs` at most
	 * and the part that writes has a budget in all - for the agent `commitMs` for the review and then the folders it
	 * left, sharing that one budget; for the terminal its own writes, after a read-only check that has a budget of its
	 * own, get twice the check's (and never less than commitMs): the writing of a set must be able to finish whatever
	 * the check let through (writeBudgetMs). Stop is not waited for in either (killRun settles the run; what this
	 * returns after that is dropped).
	 * @param {Run} run @param {Change[]} changes
	 * @returns {Promise<{ applied: number, failed: number, notes: string[] }>}
	 */
	async function applyChanges(run, changes) {
		const progress = /** @type {Progress} */ (run.progress);
		const gate = /** @type {Gate} */ (run.gate);
		const io = commitIO(run.mounts, gate);
		const caps = { writeFile: run.caps.writeFile, writeRun: run.caps.writeRun, entries: run.caps.entries };
		const total = changes.length;
		// Stopped - or the shell has stopped waiting for the review, which is the same to it: the model has been told that
		// the command failed, and a review that looks before each change must not go on applying them.
		const cancelled = () => run.killed !== null || run.reviewGivenUp;
		const review = run.commit;
		if (!review) {
			const r = await commitChanges(changes, io, caps, cancelled, progress);
			return { applied: r.applied, failed: r.failed, notes: r.notes };
		}
		// An agent run: the change set is checked here before levelcode-ai sees it (an engine that sent a path
		// outside every folder is a bug, and its review must not be handed one), then judged by its own rules.
		const problems = checkChangeSet(changes, io, caps);
		if (problems.length > 0) {
			return { applied: 0, failed: total, notes: problems.slice(0, 6).map((p) => note('refused: ' + p)).concat(note('NONE of this command\'s file changes were applied.')) };
		}
		const handed = changes.map((c) => toAgentChange(run.mounts, c));
		/** @type {any} */ let r;
		progress.phase = 'review';
		try {
			// The second argument is what the review may ask while it checks: has the command been stopped? (A Stop does not
			// wait for the review - killRun settles the run - but one that looks between its reads stops applying sooner.)
			// The review is ONE call that does a lot, so it is given the whole budget, not a provider call's. When the shell
			// gives up on it - the budget, or a Stop - that is said to it through `cancelled`; only for this call: a read of
			// the folders it left that is not answered is a refusal with a note, not a cancellation.
			r = await gate.call(() => review(handed, { cancelled }), { writes: true, within: limits.workers.commitMs, onGiveUp: () => { run.reviewGivenUp = true; } });
		} catch (e) {
			return { applied: 0, failed: total, notes: [note('the command\'s file changes could not be applied (' + messageOf(e) + '); some of them may have been')] };
		}
		if (!r || typeof r !== 'object' || !Array.isArray(r.rest)) {
			return { applied: 0, failed: total, notes: [note('the review of the command\'s file changes gave no answer, so none of them can be counted as applied; some of them may have been')] };
		}
		const notes = cleanNotes(r.notes);
		const refused = r.refused === true;
		let failed = 0;
		if (refused) {
			failed = total;
		} else if (r.failed !== undefined) {
			if (typeof r.failed === 'number' && Number.isFinite(r.failed) && r.failed >= 0) { failed = Math.trunc(r.failed); }
			else { failed = total; notes.push(note('the review gave a count of changes it could not apply that is not a number, so none of them are counted as applied')); }
		}
		const handedBack = refused ? [] : r.rest;
		// What the review leaves to the shell is the folders the command made and removed, and only those.
		const folders = new Set(handed.filter((c) => c.kind === 'mkdir' || c.kind === 'rmdir').map((c) => c.kind + ' ' + c.path));
		const rest = handedBack.filter((/** @type {any} */ c) => c && (c.kind === 'mkdir' || c.kind === 'rmdir') && folders.has(c.kind + ' ' + c.path));
		const ignored = handedBack.length - rest.length;
		// What the review applied is the files it was given, less the ones it could not apply and whatever else it handed
		// back (what is handed back is still to be done). Folders are never its to apply: it hands back the ones this shell
		// is to make and remove, and one it keeps back is applied by nobody (shellCommit keeps back the removal of a folder
		// when a file in it could not be deleted), so it is not counted as applied.
		const files = handed.filter((c) => c.kind === 'write' || c.kind === 'delete').length;
		let applied = refused ? 0 : Math.max(0, files - failed - ignored);
		if (ignored > 0) {
			failed += ignored;
			notes.push(note(ignored + ' entr' + (ignored === 1 ? 'y' : 'ies') + ' the review handed back to the shell ' + (ignored === 1 ? 'is' : 'are') + ' not ' + (ignored === 1 ? 'a folder' : 'folders') + ' the command made or removed, and ' + (ignored === 1 ? 'was' : 'were') + ' NOT applied'));
		}
		if (rest.length > 0) {
			const back = rest.map((/** @type {any} */ c) => Object.assign({}, c, { path: toMountPath(run.mounts, c.path) || c.path }));
			// What the review applied is what this phase starts from: a Stop now, or a note, counts against the whole set.
			progress.phase = 'rest';
			progress.applied = applied;
			const rr = await commitChanges(back, io, caps, cancelled, progress);
			applied += rr.applied;
			failed += rr.failed;
			notes.push(...rr.notes);
		}
		return { applied, failed, notes };
	}

	/* ----- what the terminal asks of the mounts ------------------------------------------------------- */

	/**
	 * The workspace Uri behind an engine path (a path as a command prints it: /mnt/site/src/a.js), by the mounts as of now,
	 * or null when the path is in no mount (or is not an absolute path). Total: nothing in it can throw.
	 * @param {string} p
	 * @returns {any}
	 */
	function resolve(p) { return resolveIn(currentMounts(), p); }

	/**
	 * What is at an engine path: { type: 'file'|'dir'|'other', size } - or null when nothing is, when it is in no mount,
	 * or when the file system did not say in `workers.fsMs` or failed. 'other' is what a provider that does not say
	 * (FileType.Unknown) or a link to nothing answers: the engine reads it as a file (kindOf), a link is not made to it.
	 * Never throws and never waits longer: a caller that cannot wait that long (a link under the mouse) races its own
	 * timer, as the answer is cheap to drop.
	 * @param {string} p
	 * @returns {Promise<{ type: 'file'|'dir'|'other', size: number } | null>}
	 */
	async function stat(p) {
		try {
			const uri = resolve(p);
			if (!uri) { return null; }
			const s = await withTimeout(vscode.workspace.fs.stat(uri), limits.workers.fsMs);
			const size = sizeOf(s);
			const type = (s.type & DIR) !== 0 ? 'dir' : (s.type & FILE) !== 0 ? 'file' : 'other';
			return { type, size: size === null ? 0 : size };
		} catch { return null; }
	}

	/* ----- sessions: the visitor's terminal ---------------------------------------------------------- */

	function baseEnv(/** @type {string} */ cwd) {
		return { HOME: '/home/user', PATH: '/usr/bin:/bin', PWD: cwd, TERM: 'dumb', CI: '1', NO_COLOR: '1', LANG: 'C.UTF-8' };
	}

	/** @param {any} [o] @returns {Run} */
	function newRun(/** @type {any} */ o) {
		const k = o.kind === 'agent' ? limits.agent : limits.terminal;
		return {
			id: o.id, kind: o.kind, state: 'queued', script: o.script, cwd: o.cwd, env: o.env, mounts: o.mounts, owner: o.owner,
			caps: { readFile: limits.read.file, readRun: limits.read.run, writeFile: k.writeFile, writeRun: k.writeRun, entries: k.entries },
			onStdout: o.onStdout, onStderr: o.onStderr, commit: o.commit,
			// setTimeout reads anything above 2^31-1 as 1 ms: a number outside what it can hold is the default, not a deadline now.
			timeoutMs: typeof o.timeoutMs === 'number' && o.timeoutMs >= 1 && o.timeoutMs <= MAX_TIMER_MS
				? o.timeoutMs : Math.min(MAX_TIMER_MS, limits.engine.maxExecutionTimeMs + limits.workers.deadlineGraceMs),
			rec: null, killed: null, readBytes: 0, outChars: 0, outCapped: false, t0: deps.now(), deadlineTimer: null, lead: [], reviewGivenUp: false, workerFailure: null, progress: null, gate: null, resolve: () => { },
		};
	}

	/**
	 * A persistent shell for one terminal tab.
	 * @param {{ cwd?: string }} [o]
	 */
	function createSession(o) {
		const owner = { rec: /** @type {Rec|null} */ (null) };
		let cwd = (() => {
			const mounts = currentMounts();
			const want = normalizePath(o && o.cwd);
			if (want) { const m = toMountPath(mounts, want); if (m) { return m; } if (findMount(mounts, want)) { return want; } }
			return mounts.length > 0 ? mounts[0].mount : '/';
		})();
		/** @type {Record<string, string>} */
		let env = baseEnv(cwd);
		/** The worker whose in-memory folders (/tmp/x) a cwd outside the mounts belongs to. */
		let cwdGen = 0;
		/** @type {Run|null} */ let pending = null;
		let closed = false;

		/** @param {string} prefix */
		async function completePath(prefix) {
			const mounts = currentMounts();
			if (prefix[0] === '~') { return []; }
			const i = prefix.lastIndexOf('/');
			const dirPart = i < 0 ? '' : prefix.slice(0, i + 1);
			const namePart = prefix.slice(i + 1);
			const dir = normalizePath(dirPart === '' ? cwd : dirPart[0] === '/' ? dirPart : cwd + '/' + dirPart);
			if (!dir) { return []; }
			/** @type {Array<[string, boolean]>} */ let entries = [];
			const m = findMount(mounts, dir);
			if (m) {
				const uri = targetFor(m, dir);
				if (!uri) { return []; }
				const list = await vscode.workspace.fs.readDirectory(uri);
				entries = list.map((/** @type {[string, number]} */ e) => [e[0], (e[1] & DIR) !== 0]);
			} else {
				// Above the mounts: the folders themselves are what is there to complete.
				const here = dir === '/' ? '/' : dir + '/';
				const seen = new Set();
				for (const mm of mounts) {
					if (mm.mount.startsWith(here)) { const n = mm.mount.slice(here.length).split('/')[0]; if (!seen.has(n)) { seen.add(n); entries.push([n, true]); } }
				}
			}
			const hidden = namePart[0] === '.';
			return entries
				.filter(([n]) => n.startsWith(namePart) && (hidden || n[0] !== '.'))
				.map(([n, isDir]) => dirPart + n + (isDir ? '/' : ''))
				.sort()
				.slice(0, limits.workers.completeMax);
		}

		const session = {
			get cwd() { return cwd; },
			get env() { return Object.freeze(Object.assign({}, env)); },

			/**
			 * `cols` and `rows` are the terminal's size, handed to the script as COLUMNS and LINES. Never throws: every
			 * way this can fail is a rejection (disposed, busy, a script that is not text).
			 * @param {string} script
			 * @param {{ onStdout?(text: string): void, onStderr?(text: string): void, cols?: number, rows?: number, timeoutMs?: number }} [opts]
			 * @returns {Promise<RunResult>}
			 */
			async run(script, opts) {
				if (closed || disposed) { throw new Error('disposed'); }
				if (pending) { throw new Error('busy'); }
				if (typeof script !== 'string') { throw new Error('script must be text'); }
				const o2 = opts || {};
				const mounts = currentMounts();
				/** @type {string[]} */ const lead = [];
				// A folder made in the engine's own memory (/tmp/x) is gone with the worker that had it.
				if (!findMount(mounts, cwd) && !ENGINE_DIRS.has(cwd) && !(owner.rec && !owner.rec.dead && owner.rec.gen === cwdGen)) {
					const to = mounts.length > 0 ? mounts[0].mount : '/';
					lead.push(note(forNote(cwd) + ' is gone (it was in the shell\'s own memory); starting in ' + forNote(to)));
					cwd = to;
				}
				/** @type {Record<string, string>} */
				const env2 = Object.assign({}, env, { PWD: cwd });
				const columns = sizeVar(o2.cols);
				const lines = sizeVar(o2.rows);
				if (columns) { env2.COLUMNS = columns; }
				if (lines) { env2.LINES = lines; }
				const run = newRun({
					id: ++nextRunId, kind: 'terminal', script, cwd, env: env2, mounts, owner,
					onStdout: o2.onStdout || (() => { }), onStderr: o2.onStderr || (() => { }), timeoutMs: o2.timeoutMs,
				});
				pending = run;
				return execute(run).then((out) => {
					pending = null;
					if (out.how === 'exit' && !closed) {
						cwd = out.cwd;
						if (out.env) {
							env = out.env;
							// The size of the terminal is a fact of ONE run (it was passed as COLUMNS and LINES), not state of the
							// session: carried, it would be a stale size for the next run that is not told its own.
							if (columns && env.COLUMNS === columns) { delete env.COLUMNS; }
							if (lines && env.LINES === lines) { delete env.LINES; }
						}
						cwdGen = out.gen;
					}
					return { exitCode: out.exitCode, how: out.how, notes: lead.concat(out.notes), cwd, applied: out.applied, durationMs: out.durationMs };
				});
			},

			/** Ctrl+C: the engine worker is terminated; the pending run settles with how 'aborted'. */
			stop() { if (pending) { killRun(pending, 'SIGTERM'); } },

			/**
			 * Candidates for Tab. Read-only, bounded (200 names, 2 s) and answered by the host: the engine is not asked.
			 * A path candidate keeps what was typed before the name and ends with '/' for a folder.
			 * @param {'path'|'command'} kind @param {string} prefix
			 * @returns {Promise<string[]>}
			 */
			async complete(kind, prefix) {
				const p = typeof prefix === 'string' ? prefix : '';
				if (kind === 'command') {
					if (p.includes('/')) { return []; }
					return Array.from(new Set(info.commands.concat(BUILTINS))).filter((n) => n.startsWith(p)).sort().slice(0, limits.workers.completeMax);
				}
				if (kind !== 'path') { return []; }
				try { return await withTimeout(completePath(p), limits.workers.completeMs); } catch { return []; }
			},

			dispose() {
				if (closed) { return; }
				closed = true;
				if (pending) { killRun(pending, 'SIGKILL'); }
				if (owner.rec) { terminateRec(owner.rec, 'session closed'); }
				sessions.delete(handle);
			},
		};
		const handle = { dispose: () => session.dispose() };
		sessions.add(handle);
		return session;
	}

	/* ----- the agent: run_command -------------------------------------------------------------------- */

	/** @param {AgentRunEvent} e */
	function emitAgent(e) {
		for (const l of Array.from(listeners)) { try { l(e); } catch (err) { log('listener-threw', { message: messageOf(err) }); } }
	}

	/**
	 * A ChildLike. Output that arrives before anyone listens is held and delivered to the first listener, and a
	 * late 'close' listener still hears it: the caller may attach after an await.
	 */
	function createChild() {
		/** @type {Record<string, Array<(c: any) => void>>} */
		const subs = { stdout: [], stderr: [], close: [] };
		/** @type {Record<string, string[]>} */ const held = { stdout: [], stderr: [] };
		/** @type {number|null} */ let closeCode = null;
		const stream = (/** @type {'stdout'|'stderr'} */ name) => ({
			on(/** @type {string} */ ev, /** @type {(c: string) => void} */ cb) {
				if (ev === 'data' && typeof cb === 'function') {
					subs[name].push(cb);
					for (const h of held[name].splice(0)) { try { cb(h); } catch { /* the listener's own */ } }
				}
				return this;
			},
		});
		const child = {
			pid: undefined,
			stdout: stream('stdout'),
			stderr: stream('stderr'),
			/** 'close' once. ('error' is accepted and never fires: a failure is stderr and a status.) */
			on(/** @type {string} */ ev, /** @type {(c: any) => void} */ cb) {
				if (ev === 'close' && typeof cb === 'function') {
					if (closeCode !== null) { const c = closeCode; Promise.resolve().then(() => cb(c)); } else { subs.close.push(cb); }
				}
				return child;
			},
			/** @type {(signal?: string|number) => boolean} */
			kill: () => false,
		};
		return {
			child,
			get closed() { return closeCode !== null; },
			data(/** @type {'stdout'|'stderr'} */ name, /** @type {string} */ text) {
				if (closeCode !== null) { return; }
				if (subs[name].length === 0) { held[name].push(text); return; }
				for (const cb of subs[name].slice()) { try { cb(text); } catch { /* the listener's own */ } }
			},
			close(/** @type {number} */ code) {
				if (closeCode !== null) { return; }
				closeCode = code;
				for (const cb of subs.close.splice(0)) { try { cb(code); } catch { /* the listener's own */ } }
			},
		};
	}

	/**
	 * The shell for run_command. Never throws: whatever goes wrong is text on stderr and a status.
	 * @param {string} command
	 * @param {{ cwd: string, folders?: FolderRef[], env?: Record<string,string>, commit?: (changes: Change[], control: { cancelled(): boolean }) => Promise<any>, timeoutMs?: number, explanation?: string }} opts
	 */
	function spawnAgent(command, opts) {
		const c = createChild();
		const id = ++nextRunId;
		const o = opts && typeof opts === 'object' ? opts : /** @type {any} */ ({});
		const text = typeof command === 'string' ? command : '';
		/** @type {Run|null} */ let run = null;
		/** One end for every way a spawn ends: the events, the notes as the last of stderr, then 'close'. */
		const end = (/** @type {Outcome} */ out) => {
			try {
				if (out.notes.length > 0) { c.data('stderr', out.notes.join('\n') + '\n'); }
				emitAgent({ type: 'end', id, exitCode: out.exitCode, how: out.how, notes: out.notes.slice() });
			} finally {
				c.close(out.exitCode);   // whatever happened above, agent.js is waiting for this
			}
		};
		const failFast = (/** @type {string} */ message) => {
			const out = { how: /** @type {const} */ ('error'), exitCode: 1, notes: [note(message)], cwd: '', env: null, applied: 0, durationMs: 0, gen: 0 };
			Promise.resolve().then(() => end(out));
		};
		try {
			/** @type {AgentRunEvent} */ const start = { type: 'start', id, command: text, cwd: typeof o.cwd === 'string' ? o.cwd : '' };
			// The model's own words for what this command is for (agent.js passes it): a label, kept short. The listener treats it
			// as it treats the command: untrusted.
			if (typeof o.explanation === 'string' && o.explanation.length > 0) { start.explanation = cut(o.explanation, MAX_EXPLANATION); }
			emitAgent(start);
			// True until 'close' has been emitted, however often it is asked: the signal of the first one decides.
			c.child.kill = (signal) => {
				if (c.closed) { return false; }
				if (run) { killRun(run, signal === 'SIGKILL' || signal === 9 ? 'SIGKILL' : 'SIGTERM'); }
				return true;
			};
			if (disposed) { failFast('the shell has been shut down'); return c.child; }
			if (typeof command !== 'string') { failFast('the command must be text'); return c.child; }
			const list = Array.isArray(o.folders) ? o.folders : folders();
			const mounts = planMounts(list);
			const cwdN = normalizePath(o.cwd);
			const cwdMount = cwdN && toMountPath(mounts, cwdN);
			if (!cwdMount) { failFast('the working directory ' + forNote(o.cwd) + ' is not inside a workspace folder'); return c.child; }
			const given = cleanEnv(o.env);
			run = newRun({
				id, kind: 'agent', script: text, cwd: cwdMount, mounts, owner: agentOwner,
				env: Object.assign(baseEnv(cwdMount), given.env, { PWD: cwdMount }),
				onStdout: (/** @type {string} */ t) => { c.data('stdout', t); emitAgent({ type: 'chunk', id, stream: 'stdout', text: t }); },
				onStderr: (/** @type {string} */ t) => { c.data('stderr', t); emitAgent({ type: 'chunk', id, stream: 'stderr', text: t }); },
				commit: typeof o.commit === 'function' ? o.commit : undefined, timeoutMs: o.timeoutMs,
			});
			if (given.dropped > 0) { run.lead.push(droppedEnvNote(given.dropped)); }
			execute(run).then(end);
		} catch (e) {
			failFast('could not start the command: ' + messageOf(e));
		}
		return c.child;
	}

	/* ----- the rest --------------------------------------------------------------------------------- */

	/** Folders changed: a worker that is idle and was started for others is replaced when next needed; free the memory now. */
	const sub = vscode.workspace && typeof vscode.workspace.onDidChangeWorkspaceFolders === 'function'
		? vscode.workspace.onDidChangeWorkspaceFolders(() => {
			const key = keyOf(currentMounts());
			for (const r of Array.from(workers)) { if (!r.dead && !r.run && r.key !== key) { terminateRec(r, 'folders changed'); } }
		})
		: null;

	function dispose() {
		if (disposed) { return; }
		disposed = true;
		// Every run ends now, stopped: one that is still running by terminating its worker, one whose engine had finished
		// by giving up on its commit (killRun knows the difference; the write in flight may still land, and says so).
		for (const run of Array.from(active)) { killRun(run, 'SIGKILL'); }
		for (const s of Array.from(sessions)) { s.dispose(); }
		for (const r of Array.from(workers)) { terminateRec(r, 'disposed'); }
		if (sub && typeof sub.dispose === 'function') { sub.dispose(); }
		listeners.clear();
	}

	return {
		info,
		limits,
		folders,
		/** Where each folder is mounted in the engine, as of now: the plan every run is started with (and what a prompt may show). */
		mounts: currentMounts,
		resolve,
		stat,
		createSession,
		spawnAgent,
		/** @param {(e: AgentRunEvent) => void} listener */
		onAgentRun(listener) {
			listeners.add(listener);
			return { dispose() { listeners.delete(listener); } };
		},
		dispose,
	};
}

module.exports = { createRuntime, planMounts, toMountPath, toRootPath, normalizePath, posixCode };
