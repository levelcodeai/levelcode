// The file system the engine gets: a copy-on-write overlay over a READ-ONLY, ASYNC base (the host's `fs` RPC), plus an
// in-memory scratch area. It is just-bash's IFileSystem, implemented from scratch (README.md §1, §4, §5, §7):
//
//   workspace folders   mounted at their own paths. A folder that cannot be (at '/', on a path the shell uses for
//                       itself, inside or around another folder) is mounted at /mnt/<name> and reported as relocated
//   /tmp, /home/user    memory, writable, never a change; cleared per run unless the session asks to keep them
//   /dev/fd             memory, writable: the engine puts process substitutions (<(cmd)) there
//   /bin, /usr/bin      one stub per program (the engine writes them: it looks programs up here), read-only
//   /dev/null ...       sinks; /dev/stderr and /dev/stdout are collected and handed to the caller
//   anything else       does not exist and cannot be written
//
// Nothing here ever writes to the base. A run's effect is `changes()`: the NET difference between what the command
// left and what the base held, minimal (a rewrite with the same bytes is nothing; create-then-delete is nothing).
//
// What the engine forces on this file:
//   * The content write at the end of a REDIRECTION can never throw: just-bash rejects the whole exec() for an error
//     from it, and the script's output is lost. The redirection OPENED its target first (an empty write, encoding
//     'binary'); this file remembers which paths it opened in the run, and when the command itself then removed or
//     replaced the parent or the target (`{ rm -rf d; echo hi; } > d/f`) the content is dropped without a word,
//     because in GNU the open descriptor outlives the name and the write succeeds. A content write that the SHELL
//     refuses (outside the folders, a protected path, a cap) is dropped and recorded in `denied`.
//   * The OPENING of a redirection (`writeFile(p, '', 'binary')`) can throw, and patch LC-5 makes the engine answer
//     `bash: p: <reason>` with status 1 and not run the command, exactly as bash does. So a redirection to a missing
//     folder or to /etc fails the way it would in a real shell, visibly, and is not a silent drop.
//   * A write that had NO opening (`touch`, `tee`, `sort -o`, `split`, cp) is a call the command made itself and gets
//     the errno of a real file system, thrown: those programs report it the way GNU's do.
//   * Every thrown error has a message that STARTS with '<CODE>: ' and a `.code` (the engine tests both).
//   * Which of them are `denied`: only what the shell REFUSES (a path outside the folders, a protected path, a cap).
//     An ordinary failure of the same call (the parent is missing or is a file, the target is a directory) is what
//     the command was going to get from a real file system: it is thrown, the command reports it as GNU would, and the
//     rest of the script's changes still apply.
//   * Text is lossless: a file that is not valid UTF-8 is decoded with its bad bytes escaped (U+DC80..U+DCFF, Python's
//     surrogateescape) and encoded back to the same bytes, so a command that reads a file as text and writes it back
//     (`sed -i` with no match, `tee`, `sort -o`) changes nothing it was not asked to change.
//
// And one thing this file adds: a refused read says so in `notes`, because the engine renders EVERY read error as
// "No such file or directory", which would make the model believe that a file that is there is not.
'use strict';
// @ts-check

const { decodeBytes: decodeText, encodeText, displayText, hasLoneSurrogate } = require('./text.js');
/** the times a stat hands out are Dates whose local fields are the shell's zone (engine/zone.js), not the visitor's */
const { LcDate } = require('./zone.js');

const dec = new TextDecoder('utf-8');

/** The numbers README §7 gives for an agent run; a caller passes its own. */
const DEFAULT_CAPS = Object.freeze({ readFile: 4 << 20, readRun: 16 << 20, writeFile: 1 << 20, writeRun: 8 << 20, entries: 2000 });

/**
 * The caps a host asked for, each one only if it is a finite number above zero; anything else (undefined, NaN, a
 * string, 0, a negative number) is the default. A comparison with NaN is false for every number, so an unvalidated
 * cap that was mistyped would not be a smaller limit but no limit at all.
 * @param {any} given
 * @returns {{ readFile: number, readRun: number, writeFile: number, writeRun: number, entries: number }}
 */
function validCaps(given) {
	/** @type {any} */
	const out = {};
	for (const k of Object.keys(DEFAULT_CAPS)) {
		const v = given && typeof given === 'object' ? given[k] : undefined;
		out[k] = typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : /** @type {any} */ (DEFAULT_CAPS)[k];
	}
	return out;
}

/** The shell's own mount point for a folder that cannot sit at its own path (the first one nothing is mounted on). */
const MOUNT_BASES = ['/mnt', '/lc-mnt'];

/** Paths that belong to the shell itself. A workspace folder that would sit on one of them is relocated. */
const RESERVED = ['/tmp', '/home', '/bin', '/usr', '/dev', '/proc'];

/** The only memory areas a command may write to. */
const SCRATCH = ['/tmp', '/home/user', '/dev/fd'];

/** Device paths that swallow what is written (stdout and stderr are handed to the caller instead). */
const SINKS = new Set(['/dev/null', '/dev/zero', '/dev/urandom', '/dev/random', '/dev/stdin', '/dev/stdout', '/dev/stderr']);

/**
 * /dev/zero and /dev/urandom are endless in a real shell. Here a read is this many bytes (the engine reads a file
 * whole), which is enough for `head -c N /dev/zero` and `head -c N /dev/urandom` with N up to a mebibyte.
 */
const ENDLESS_BYTES = 1 << 20;

/** Directories report this size, as they do on the file systems people compare with. */
const DIR_SIZE = 4096;

/** A script gets the exec bit from its first line. Bounded: finding out is a whole-file read. */
const SHEBANG_MAX_SIZE = 32 * 1024;
const SHEBANG_MAX_PROBES = 32;

const ERROR_TEXT = {
	ENOENT: 'no such file or directory',
	EEXIST: 'file already exists',
	ENOTDIR: 'not a directory',
	EISDIR: 'illegal operation on a directory',
	ENOTEMPTY: 'directory not empty',
	EPERM: 'operation not permitted',
	EACCES: 'permission denied',
	EINVAL: 'invalid argument',
	EFBIG: 'file too large',
	ENOSPC: 'no space left',
	EIO: 'i/o error',
	EBUSY: 'resource busy or locked',
};

/** The words a shell uses for the same errors (what the user sees on a refused write). */
const SHELL_TEXT = {
	ENOENT: 'No such file or directory',
	ENOTDIR: 'Not a directory',
	EISDIR: 'Is a directory',
	EACCES: 'Permission denied',
	EPERM: 'Operation not permitted',
	EEXIST: 'File exists',
	ENOSPC: 'No space left on device',
	EFBIG: 'File too large',
};

/**
 * @param {string} code
 * @param {string} syscall
 * @param {string} p
 * @param {string} [text]
 */
function fsError(code, syscall, p, text) {
	const e = /** @type {Error & { code: string, syscall: string, path: string }} */ (new Error(`${code}: ${text || ERROR_TEXT[code] || code}, ${syscall} '${p}'`));
	e.code = code;
	e.syscall = syscall;
	e.path = p;
	return e;
}

/** Posix normalisation: '.', '..' (clamped at '/'), repeated and trailing slashes. */
function norm(p) {
	const out = [];
	for (const seg of String(p).split('/')) {
		if (seg === '' || seg === '.') { continue; }
		if (seg === '..') { out.pop(); } else { out.push(seg); }
	}
	return '/' + out.join('/');
}
function parentOf(p) { return p === '/' ? '/' : (p.slice(0, p.lastIndexOf('/')) || '/'); }
function baseName(p) { return p.slice(p.lastIndexOf('/') + 1); }
function join(dir, name) { return dir === '/' ? '/' + name : dir + '/' + name; }
function isUnder(p, dir) { return dir === '/' ? p !== '/' : p.startsWith(dir + '/'); }
function isSelfOrUnder(p, dir) { return p === dir || isUnder(p, dir); }

function latin1(u8) {
	let s = '';
	for (let i = 0; i < u8.length; i += 0x2000) { s += String.fromCharCode.apply(null, /** @type {any} */ (u8.subarray(i, i + 0x2000))); }
	return s;
}

/** Content as the engine hands it over (a string with an encoding, or bytes) to bytes. */
function toBytes(content, encoding) {
	if (typeof content !== 'string') { return content instanceof Uint8Array ? content : Uint8Array.from(content || []); }
	const e = encoding && typeof encoding === 'object' ? encoding.encoding : encoding;
	switch (e) {
		case 'binary': case 'latin1': case 'ascii': {
			const u = new Uint8Array(content.length);
			for (let i = 0; i < content.length; i++) { u[i] = content.charCodeAt(i) & 0xff; }
			return u;
		}
		case 'base64': {
			return Uint8Array.from(atob(content), (c) => c.charCodeAt(0));
		}
		case 'hex': {
			const u = new Uint8Array(content.length >> 1);
			for (let i = 0; i < u.length; i++) { u[i] = parseInt(content.substr(i * 2, 2), 16); }
			return u;
		}
		default: return encodeText(content);
	}
}

function fromBytes(u8, encoding) {
	const e = encoding && typeof encoding === 'object' ? encoding.encoding : encoding;
	switch (e) {
		case 'binary': case 'latin1': case 'ascii': return latin1(u8);
		case 'base64': return btoa(latin1(u8));
		case 'hex': return Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('');
		default: return decodeText(u8);
	}
}

function randomBytes(n) {
	const out = new Uint8Array(n);
	// getRandomValues takes at most 65536 bytes at a time
	for (let i = 0; i < n; i += 65536) { globalThis.crypto.getRandomValues(out.subarray(i, Math.min(n, i + 65536))); }
	return out;
}

function bytesEqual(a, b) {
	if (a.length !== b.length) { return false; }
	for (let i = 0; i < a.length; i++) { if (a[i] !== b[i]) { return false; } }
	return true;
}

function human(n) {
	if (n >= 1 << 20) { return (n / (1 << 20)).toFixed(n % (1 << 20) ? 1 : 0) + ' MiB'; }
	if (n >= 1 << 10) { return (n / (1 << 10)).toFixed(n % (1 << 10) ? 1 : 0) + ' KiB'; }
	return n + ' bytes';
}

/**
 * A script the shell can run: it starts with `#!` and names a shell. The engine runs an executable file as shell
 * text whatever its first line says, so a `#!/usr/bin/env node` file must not look executable (it would be run as
 * bash and print a parse error that names the wrong problem).
 */
function isShellScript(b) {
	if (b.length < 3 || b[0] !== 0x23 || b[1] !== 0x21) { return false; }
	let end = 2;
	while (end < b.length && end < 200 && b[end] !== 0x0a) { end++; }
	const words = dec.decode(b.subarray(2, end)).trim().split(/\s+/);
	const name = (w) => (w || '').slice((w || '').lastIndexOf('/') + 1);
	const shells = ['sh', 'bash', 'dash', 'ash', 'ksh', 'zsh'];
	if (name(words[0]) === 'env') {
		const rest = words.slice(1).filter((w) => !w.startsWith('-'));
		return shells.includes(name(rest[0]));
	}
	return shells.includes(name(words[0]));
}

/* ------------------------------------------------------------------------------------------------------------ */

/**
 * A growable byte buffer: appending is amortised O(1) (`echo x >> f` in a loop must not rewrite the file each time).
 * The bytes below `len` are never modified in place, so a view handed out earlier stays what it was.
 */
class Bytes {
	/** @param {Uint8Array} [initial] */
	constructor(initial) {
		this.buf = initial || new Uint8Array(0);
		this.len = this.buf.length;
	}
	get view() { return this.buf.subarray(0, this.len); }
	/** @param {Uint8Array} add */
	append(add) {
		if (this.len + add.length > this.buf.length) {
			const next = new Uint8Array(Math.max(this.len + add.length, this.buf.length * 2, 64));
			next.set(this.buf.subarray(0, this.len), 0);
			this.buf = next;
		}
		this.buf.set(add, this.len);
		this.len += add.length;
	}
}

/**
 * @typedef {{ k: 'dir', mode: number, mtime: number }} MemDir
 * @typedef {{ k: 'file', data: Bytes, mode: number, mtime: number }} MemFile
 */

/** The scratch/system area: plain synchronous maps, never a change, optionally kept between runs. */
class MemoryFs {
	constructor() {
		/** @type {Map<string, MemDir | MemFile>} */
		this.nodes = new Map();
		/** @type {Map<string, Set<string>>} */
		this.kids = new Map();
		this.bytes = 0;
		this.nodes.set('/', { k: 'dir', mode: 0o755, mtime: Date.now() });
		this.kids.set('/', new Set());
	}
	get(p) { return this.nodes.get(p); }
	/** @param {string} p @param {number} [mode] */
	mkdirp(p, mode = 0o755) {
		if (this.nodes.has(p)) { return; }
		this.mkdirp(parentOf(p), mode);
		this.nodes.set(p, { k: 'dir', mode, mtime: Date.now() });
		this.kids.set(p, new Set());
		this.kids.get(parentOf(p))?.add(baseName(p));
	}
	/** @param {string} p @param {Uint8Array} bytes @param {number} [mode] */
	put(p, bytes, mode) {
		const old = this.nodes.get(p);
		if (old && old.k === 'file') { this.bytes -= old.data.len; }
		this.mkdirp(parentOf(p));
		const copy = bytes.slice();
		this.nodes.set(p, { k: 'file', data: new Bytes(copy), mode: mode !== undefined ? mode : (old && old.k === 'file' ? old.mode : 0o644), mtime: Date.now() });
		this.bytes += copy.length;
		this.kids.get(parentOf(p))?.add(baseName(p));
	}
	/** @param {string} p @param {Uint8Array} add */
	append(p, add) {
		const n = this.nodes.get(p);
		if (!n || n.k !== 'file') { this.put(p, add); return; }
		n.data.append(add);
		n.mtime = Date.now();
		this.bytes += add.length;
	}
	/** Removes p and everything under it. */
	remove(p) {
		const n = this.nodes.get(p);
		if (!n) { return; }
		if (n.k === 'dir') { for (const k of [...(this.kids.get(p) || [])]) { this.remove(join(p, k)); } this.kids.delete(p); } else { this.bytes -= n.data.len; }
		this.nodes.delete(p);
		this.kids.get(parentOf(p))?.delete(baseName(p));
	}
	/** @param {string} p @returns {string[]} */
	list(p) { return [...(this.kids.get(p) || [])].sort(); }
	get size() { return this.nodes.size; }
	/** How many files are in p, or under it. */
	countFiles(p) {
		let n = 0;
		for (const [k, v] of this.nodes) { if (v.k === 'file' && isSelfOrUnder(k, p)) { n++; } }
		return n;
	}
}

/* ------------------------------------------------------------------------------------------------------------ */

/**
 * Decide where each workspace folder is mounted.
 *
 * @param {Array<{ id: string, path: string, name?: string }>} folders in the order the host gave them
 * @returns {Array<{ id: string, name: string, host: string, at: string, relocated: boolean, reason?: string }>}
 *   `host` is the path the host knows the folder by (RPC and change paths); `at` is where the shell sees it.
 */
function planMounts(folders) {
	const taken = [];
	const out = [];
	const waiting = [];
	for (const f of folders) {
		const host = norm(f.path);
		const name = f.name || baseName(host) || 'folder';
		let reason = null;
		if (host === '/') { reason = 'a folder at the root of the file system'; } else if (RESERVED.some((r) => isSelfOrUnder(host, r))) { reason = 'a folder on a path the shell uses for itself'; } else if (taken.some((t) => isSelfOrUnder(host, t) || isUnder(t, host))) { reason = 'a folder that overlaps another one'; }
		if (reason) { waiting.push({ f, host, name, reason }); continue; }
		taken.push(host);
		out.push({ id: f.id, name, host, at: host, relocated: false });
	}
	// Where relocated folders go: /mnt, unless a folder is mounted AT or ABOVE it (a folder rooted at /mnt would swallow
	// every name below it, and the search for a free one would never end), then /lc-mnt, /lc-mnt-2 ...
	const clash = (p) => taken.some((t) => isSelfOrUnder(p, t) || isUnder(t, p));
	let base = '';
	for (let i = 0; i <= taken.length + 1 && !base; i++) {
		const cand = i < MOUNT_BASES.length ? MOUNT_BASES[i] : MOUNT_BASES[1] + '-' + (i - MOUNT_BASES.length + 2);
		if (!taken.some((t) => isSelfOrUnder(cand, t))) { base = cand; }
	}
	for (const w of waiting) {
		const slug = w.name.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+/, '_') || 'folder';
		let at = base + '/' + slug;
		for (let i = 2; clash(at); i++) { at = base + '/' + slug + '-' + i; }
		taken.push(at);
		out.push({ id: w.f.id, name: w.name, host: w.host, at, relocated: true, reason: w.reason });
	}
	// keep the host's order, so that "the first folder" stays the first
	const order = new Map(folders.map((f, i) => [f.id, i]));
	return out.sort((a, b) => (order.get(a.id) || 0) - (order.get(b.id) || 0));
}

/* ------------------------------------------------------------------------------------------------------------ */

/**
 * @typedef {{ type: 'file' | 'dir', size: number, mtime: number }} BaseStat
 * @typedef {{
 *   stat(path: string): Promise<BaseStat>,
 *   readFile(path: string): Promise<Uint8Array>,
 *   readDir(path: string): Promise<Array<[string, 'file' | 'dir']>>,
 * }} Base
 * @typedef {{ readFile: number, readRun: number, writeFile: number, writeRun: number, entries: number }} Caps
 * @typedef {{ k: 'file', data: Bytes, mtime: number, mode?: number } | { k: 'dir', mtime: number } | { k: 'gone' }} Staged
 * @typedef {{ path: string, op: string, reason: string, code: string, message: string }} Denied
 * @typedef {{ kind: 'write', path: string, existed: boolean, before: Uint8Array | null, after: Uint8Array }
 *   | { kind: 'delete', path: string, before: Uint8Array | null, viaDir?: string }
 *   | { kind: 'mkdir', path: string }
 *   | { kind: 'rmdir', path: string }} Change
 * @typedef {{ code: string, reason: string, policy: boolean, text: string }} Refusal
 */

/**
 * @param {object} o
 * @param {Array<{ id: string, path: string, name?: string }>} o.folders
 * @param {Base} o.base
 * @param {Partial<Caps>} [o.caps]
 * @param {MemoryFs} [o.memory] kept between runs by a session that wants /tmp to last
 * @param {() => number} [o.now]
 */
function createOverlay(o) {
	const caps = validCaps(o.caps);
	const base = o.base;
	const clock = o.now || (() => Date.now());
	/**
	 * Staged files and folders get a time that is later than any before it in the run: GNU tools have nanoseconds,
	 * and `cp -u`, `ls -t`, `find -newer` must see what was written last as the newest.
	 */
	let lastTick = 0;
	const now = () => { lastTick = Math.max(clock(), lastTick + 1); return lastTick; };
	const memory = o.memory || new MemoryFs();
	const mounts = planMounts(o.folders || []);

	/** @type {Map<string, Staged>} overlay entries, by effective path, mounts only */
	const entries = new Map();
	/**
	 * directory -> the names below it that lead to an entry. Every ancestor of an entry is linked, up to the mount, even
	 * one that has no entry of its own (a file written in a directory the base has): what `rm -rf` and `mv` of an
	 * ancestor have to find is everything staged under it, however deep.
	 * @type {Map<string, Set<string>>}
	 */
	const kids = new Map();
	/** @type {Map<string, BaseStat | null>} what the base said, once, for the whole run */
	const baseStats = new Map();
	/** @type {Map<string, Array<[string, 'file' | 'dir']>>} */
	const baseDirs = new Map();
	/** @type {Map<string, Uint8Array>} */
	const baseBytes = new Map();
	/** @type {Map<string, number>} chmod / utimes: per run, there is no place to keep them */
	const modes = new Map();
	const mtimes = new Map();

	/** @type {Denied[]} */
	const denied = [];
	/** @type {string[]} */
	const notes = [];
	const noted = new Set();
	/** the paths a redirection opened in this run: the content written to one later never throws (see writeOrAppend) */
	const opened = new Set();
	const device = { stdout: '', stderr: '' };
	const stats = { filesRead: 0, bytesRead: 0, probes: 0, statCalls: 0, readCalls: 0, listCalls: 0, stagedBytes: 0, stagedEntries: 0, memoryBytesAtStart: memory.bytes };
	let probes = 0;
	let stagedBytes = 0;
	let created = 0;

	/** the ancestors of mounts ('/', '/mnt', ...): directories that only exist to lead somewhere */
	/** @type {Map<string, Set<string>>} */
	const vdirs = new Map([['/', new Set()]]);
	for (const m of mounts) {
		for (let p = m.at; p !== '/'; p = parentOf(p)) {
			const par = parentOf(p);
			if (!vdirs.has(par)) { vdirs.set(par, new Set()); }
			vdirs.get(par)?.add(baseName(p));
		}
	}

	// the layout the engine expects to find even before it writes its own stubs
	for (const d of ['/tmp', '/home/user', '/bin', '/usr/bin', '/dev', '/dev/fd', '/proc']) { memory.mkdirp(d); }
	for (const d of ['/dev/urandom', '/dev/random']) { if (!memory.get(d)) { memory.put(d, new Uint8Array(0), 0o666); } }

	const MEMORY_ENTRIES_MAX = Math.max(caps.entries * 10, 20000);

	/* ----- bookkeeping ------------------------------------------------------------------------------------ */

	function note(text) {
		if (noted.has(text) || notes.length >= 20) { return; }
		noted.add(text);
		notes.push(text);
	}
	/**
	 * The error a failed host call becomes. The engine prints every read error as "No such file or directory", so a
	 * refusal or a failure of the editor says what it was in `notes`; an unknown code is an I/O error.
	 */
	function hostError(e, syscall, p, doing) {
		const code = e && e.code && ERROR_TEXT[e.code] ? e.code : 'EIO';
		const message = e && e.message ? String(e.message).slice(0, 160) : undefined;
		if (code !== 'ENOENT' && code !== 'ENOTDIR') {
			note(`"${p}" could not be ${doing}: the editor answered ${code}${message ? ` (${message})` : ''}. A "No such file or directory" line for it is wrong: it may exist.`);
		}
		return fsError(code, syscall, p, message);
	}
	/** a write that was dropped: the run is flagged, because nothing the command could see said so */
	function deny(path, op, reason, code, message) {
		if (!denied.some((d) => d.path === path && d.op === op && d.reason === reason)) { denied.push({ path, op, reason, code, message }); }
	}

	/** @returns {{ m: typeof mounts[number], host: string } | null} */
	function mountOf(p) {
		for (const m of mounts) {
			if (isSelfOrUnder(p, m.at)) { return { m, host: m.host + p.slice(m.at.length) }; }
		}
		return null;
	}
	/** effective path -> the path the host knows it by (or the path itself outside the mounts) */
	function toHost(p) {
		const r = mountOf(p);
		return r ? r.host : p;
	}

	function isScratch(p) { return SCRATCH.some((s) => isSelfOrUnder(p, s)); }

	/** The three worlds. mount: inside a workspace folder; mem: memory (it may or may not exist); virt: leads to a mount. */
	function route(p) {
		const r = mountOf(p);
		if (r) { return { t: /** @type {'mount'} */ ('mount'), m: r.m, host: r.host }; }
		if (vdirs.has(p) && !memory.get(p)) { return { t: /** @type {'virt'} */ ('virt') }; }
		return { t: /** @type {'mem'} */ ('mem') };
	}

	/* ----- the base, read once per run, with the caps applied before anything is read --------------------- */

	/** @returns {Promise<BaseStat | null>} null when the base has nothing there */
	async function baseStat(p, host) {
		if (baseStats.has(p)) { return baseStats.get(p) || null; }
		stats.statCalls++;
		let s;
		try {
			s = await base.stat(host);
		} catch (e) {
			const code = e && e.code;
			if (code === 'ENOENT' || code === 'ENOTDIR') { baseStats.set(p, null); return null; }
			throw hostError(e, 'stat', p, 'looked at');
		}
		baseStats.set(p, s);
		return s;
	}

	async function baseList(p, host) {
		const hit = baseDirs.get(p);
		if (hit) { return hit; }
		stats.listCalls++;
		let list;
		try {
			list = await base.readDir(host);
		} catch (e) {
			throw hostError(e, 'scandir', p, 'listed');
		}
		baseDirs.set(p, list);
		return list;
	}

	/** The bytes of a base file, under the caps. The size comes from stat FIRST: a file over the cap is never fetched. */
	async function readBase(p, host, syscall) {
		const hit = baseBytes.get(p);
		if (hit) { return hit; }
		const s = await baseStat(p, host);
		if (!s) { throw fsError('ENOENT', syscall, p); }
		if (s.type === 'dir') { throw fsError('EISDIR', 'read', p); }
		if (s.size > caps.readFile) {
			note(`"${p}" was NOT read: it is ${human(s.size)}, over the ${human(caps.readFile)} this shell reads from one file. A "No such file or directory" line for it is wrong: the file exists.`);
			throw fsError('EFBIG', syscall, p, 'file too large for this shell');
		}
		if (stats.bytesRead + s.size > caps.readRun) {
			note(`"${p}" was NOT read: this command has already read ${human(stats.bytesRead)} and the limit is ${human(caps.readRun)} per command. A "No such file or directory" line for it is wrong: the file exists.`);
			throw fsError('EFBIG', syscall, p, 'read limit of this shell reached');
		}
		stats.readCalls++;
		let bytes;
		try {
			bytes = await base.readFile(host);
		} catch (e) {
			const code = e && e.code;
			if (code === 'ENOENT') { baseStats.set(p, null); throw fsError('ENOENT', syscall, p); }
			throw hostError(e, syscall, p, 'read');
		}
		stats.filesRead++;
		stats.bytesRead += bytes.length;
		baseBytes.set(p, bytes);
		return bytes;
	}

	/* ----- the overlay's own bookkeeping ------------------------------------------------------------------ */

	/** `stagedBytes` and `created` follow every change to `entries`, so a cap check never has to count. */
	function account(old, next) {
		if (old && old.k === 'file') { stagedBytes -= old.data.len; }
		if (old && old.k !== 'gone') { created--; }
		if (next && next.k === 'file') { stagedBytes += next.data.len; }
		if (next && next.k !== 'gone') { created++; }
	}
	/** where the chain of ancestors of p stops: the mount it is in */
	function topOf(p) {
		const r = mountOf(p);
		return r ? r.m.at : '/';
	}
	function setEntry(p, e) {
		account(entries.get(p), e);
		entries.set(p, e);
		const top = topOf(p);
		for (let q = p; q !== top && q !== '/';) {
			const par = parentOf(q);
			let s = kids.get(par);
			if (!s) { s = new Set(); kids.set(par, s); }
			const had = s.has(baseName(q));
			s.add(baseName(q));
			if (had) { break; }                  // the rest of the chain is linked already
			q = par;
		}
	}
	/**
	 * The link to p stays in its parent's set: p may have entries below it (a directory whose own entry is gone, a file
	 * under it is staged), and every reader skips a name that has no entry.
	 */
	function delEntry(p) {
		account(entries.get(p), null);
		entries.delete(p);
	}
	/** Drops every entry under p, at any depth (not p itself). */
	function dropBelow(p) {
		const ks = kids.get(p);
		if (!ks) { return; }
		for (const k of [...ks]) {
			const c = join(p, k);
			dropBelow(c);
			if (entries.has(c)) {
				account(entries.get(c), null);
				entries.delete(c);
			}
		}
		kids.delete(p);
	}
	function dropSticky(p) {
		for (const m of [modes, mtimes]) {
			for (const k of [...m.keys()]) { if (isSelfOrUnder(k, p)) { m.delete(k); } }
		}
	}

	/**
	 * What is at p, for p inside a mount, as the command should see it.
	 * @returns {Promise<{ type: 'file' | 'dir', size: number, mtime: number, src: 'ov' | 'base', node?: Staged & { k: 'file' } } | null>}
	 */
	async function lookup(m, p, host) {
		const own = entries.get(p);
		if (own) {
			if (own.k === 'gone') { return null; }
			if (own.k === 'dir') { return { type: 'dir', size: DIR_SIZE, mtime: own.mtime, src: 'ov' }; }
			return { type: 'file', size: own.data.len, mtime: own.mtime, src: 'ov', node: own };
		}
		// an ancestor that was removed, replaced by a file, or re-created (opaque) hides everything the base has below it
		for (let q = parentOf(p); ; q = parentOf(q)) {
			if (entries.has(q)) { return null; }
			if (q === m.at || q === '/') { break; }
		}
		if (p === m.at) { return { type: 'dir', size: DIR_SIZE, mtime: now(), src: 'base' }; }
		const s = await baseStat(p, host);
		return s ? { type: s.type, size: s.type === 'dir' ? DIR_SIZE : s.size, mtime: s.mtime, src: 'base' } : null;
	}

	/** True when the base's listing of directory p is visible (nothing in the overlay replaced it or an ancestor). */
	function baseVisible(m, p) {
		for (let q = p; ; q = parentOf(q)) {
			if (entries.has(q)) { return false; }
			if (q === m.at || q === '/') { return true; }
		}
	}

	/* ----- what a path looks like ------------------------------------------------------------------------- */

	function memStat(p) {
		const n = memory.get(p);
		if (n) { return { isFile: n.k === 'file', isDirectory: n.k === 'dir', isSymbolicLink: false, mode: modes.has(p) ? /** @type {number} */ (modes.get(p)) : n.mode, size: n.k === 'file' ? n.data.len : DIR_SIZE, mtime: new LcDate(mtimes.has(p) ? /** @type {number} */ (mtimes.get(p)) : n.mtime), identity: 'mem:' + p }; }
		if (vdirs.has(p)) { return { isFile: false, isDirectory: true, isSymbolicLink: false, mode: 0o755, size: DIR_SIZE, mtime: new LcDate(0), identity: 'virt:' + p }; }
		return null;
	}

	function stBase(info, p, mode) {
		return { isFile: info.type === 'file', isDirectory: info.type === 'dir', isSymbolicLink: false, mode, size: info.size, mtime: new LcDate(mtimes.has(p) ? /** @type {number} */ (mtimes.get(p)) : info.mtime), identity: 'ws:' + p };
	}

	async function modeOfFile(p, host, info, probe) {
		const set = modes.get(p);
		if (set !== undefined) { return set; }
		if (info.src === 'ov' && info.node && info.node.k === 'file') {
			if (info.node.mode !== undefined) { return info.node.mode; }
			return isShellScript(info.node.data.view) ? 0o755 : 0o644;
		}
		if (probe && info.size > 1 && info.size <= SHEBANG_MAX_SIZE && probes < SHEBANG_MAX_PROBES && !baseBytes.has(p)) {
			probes++;
			stats.probes++;
			try { return isShellScript(await readBase(p, host, 'open')) ? 0o755 : 0o644; } catch { return 0o644; }
		}
		const cached = baseBytes.get(p);
		return cached && isShellScript(cached) ? 0o755 : 0o644;
	}

	async function statPath(p, syscall, probe) {
		const r = route(p);
		if (r.t === 'virt') { return memStat(p); }
		if (r.t === 'mem') {
			const s = memStat(p);
			if (!s) { throw fsError('ENOENT', syscall, p); }
			return s;
		}
		const info = await lookup(r.m, p, r.host);
		if (!info) { throw fsError('ENOENT', syscall, p); }
		if (info.type === 'dir') { return stBase(info, p, modes.has(p) ? /** @type {number} */ (modes.get(p)) : 0o755); }
		return stBase(info, p, await modeOfFile(p, r.host, info, probe));
	}

	/** The engine says "No such file or directory" for a directory that is read: it is there, and it is a directory. */
	function noteDirectory(p) {
		note(`"${p}" is a directory. A "No such file or directory" line for it is wrong: use ls, or name a file in it.`);
	}

	/** @returns {Promise<Uint8Array>} */
	async function readBytes(p, syscall) {
		const r = route(p);
		if (r.t === 'virt') { noteDirectory(p); throw fsError('EISDIR', 'read', p); }
		if (r.t === 'mem') {
			if (p === '/dev/zero') { return new Uint8Array(ENDLESS_BYTES); }
			if (p === '/dev/urandom' || p === '/dev/random') { return randomBytes(ENDLESS_BYTES); }
			if (SINKS.has(p)) { return new Uint8Array(0); }
			const n = memory.get(p);
			if (!n) { throw fsError('ENOENT', syscall, p); }
			if (n.k === 'dir') { noteDirectory(p); throw fsError('EISDIR', 'read', p); }
			return n.data.view;
		}
		const info = await lookup(r.m, p, r.host);
		if (!info) { throw fsError('ENOENT', syscall, p); }
		if (info.type === 'dir') { noteDirectory(p); throw fsError('EISDIR', 'read', p); }
		if (info.src === 'ov' && info.node && info.node.k === 'file') { return info.node.data.view; }
		return readBase(p, r.host, syscall);
	}

	/** @returns {Promise<Array<{ name: string, isFile: boolean, isDirectory: boolean, isSymbolicLink: boolean }>>} */
	async function listDir(p, syscall) {
		const r = route(p);
		const names = new Map();
		if (r.t === 'virt' || (r.t === 'mem' && (memory.get(p)?.k === 'dir' || vdirs.has(p)))) {
			if (r.t === 'mem') { for (const k of memory.list(p)) { const c = memory.get(join(p, k)); names.set(k, c ? c.k : 'dir'); } }
			for (const k of vdirs.get(p) || []) { names.set(k, 'dir'); }
		} else if (r.t === 'mem') {
			throw fsError(memory.get(p) ? 'ENOTDIR' : 'ENOENT', syscall, p);
		} else {
			const info = await lookup(r.m, p, r.host);
			if (!info) { throw fsError('ENOENT', syscall, p); }
			if (info.type !== 'dir') { throw fsError('ENOTDIR', syscall, p); }
			if (baseVisible(r.m, p)) {
				for (const [name, type] of await baseList(p, r.host)) { names.set(name, type); }
			}
			for (const k of kids.get(p) || []) {
				const e = entries.get(join(p, k));
				if (!e) { continue; }
				if (e.k === 'gone') { names.delete(k); } else { names.set(k, e.k); }
			}
		}
		return [...names.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([name, t]) => ({ name, isFile: t === 'file', isDirectory: t === 'dir', isSymbolicLink: false }));
	}

	/* ----- writing ---------------------------------------------------------------------------------------- */

	/**
	 * May a file be written at p? What is wrong with it, or where it goes.
	 * @returns {Promise<{ t: 'sink' | 'mem' | 'mount', r: any, cur: any } | { error: Refusal }>}
	 */
	async function writeTarget(p) {
		const r = route(p);
		const bad = (code, reason, policy) => ({ error: /** @type {Refusal} */ ({ code, reason, policy, text: SHELL_TEXT[code] || code }) });
		if (r.t === 'virt') { return bad('EISDIR', 'is-dir', false); }
		if (r.t === 'mem') {
			if (SINKS.has(p)) { return { t: 'sink', r, cur: null }; }
			if (!isScratch(p)) { return bad('EACCES', memory.get(p) || vdirs.has(p) ? 'readonly' : 'outside', true); }
			const cur = memory.get(p);
			if (cur && cur.k === 'dir') { return bad('EISDIR', 'is-dir', false); }
			const par = memory.get(parentOf(p));
			if (!par) { return bad('ENOENT', 'missing-parent', false); }
			if (par.k !== 'dir') { return bad('ENOTDIR', 'not-dir', false); }
			return { t: 'mem', r, cur };
		}
		if (p === r.m.at) { return bad('EISDIR', 'is-dir', false); }
		const cur = await lookup(r.m, p, r.host);
		if (cur && cur.type === 'dir') { return bad('EISDIR', 'is-dir', false); }
		const par = parentOf(p);
		const pinfo = par === r.m.at ? { type: 'dir' } : await lookup(r.m, par, mountOf(par)?.host || par);
		if (!pinfo) { return bad('ENOENT', 'missing-parent', false); }
		if (pinfo.type !== 'dir') { return bad('ENOTDIR', 'not-dir', false); }
		return { t: 'mount', r, cur };
	}

	/** Said once, for the model: the shell's "Permission denied" is a policy, not a mystery. */
	function explainPolicy(p) {
		note(`${p} is ${memory.get(p) ? 'part of the shell' : 'outside the workspace folders'}: a command here can change the workspace folders, /tmp and /home/user, nothing else.`);
	}

	/**
	 * Writes (or appends) bytes at p. The target has been checked. Returns why when a cap refused the write.
	 * @returns {Promise<{ code: string, reason: string, message: string } | null>}
	 */
	async function put(t, p, bytes, append, mode) {
		if (t.t === 'sink') {
			if (p === '/dev/stdout' || p === '/dev/stderr') { device[p === '/dev/stdout' ? 'stdout' : 'stderr'] += dec.decode(bytes); }
			return null;
		}
		if (t.t === 'mem') {
			const cur = t.cur;
			const growth = append ? bytes.length : bytes.length - (cur && cur.k === 'file' ? cur.data.len : 0);
			if (memory.bytes + stagedBytes + growth > caps.writeRun) { return { code: 'ENOSPC', reason: 'cap-run', message: `${p}: not written: this command would hold more than ${human(caps.writeRun)} in memory and staged files` }; }
			if (!cur && memory.size >= MEMORY_ENTRIES_MAX) { return { code: 'ENOSPC', reason: 'cap-entries', message: `${p}: not written: too many files in ${p.startsWith('/dev/fd') ? '/dev/fd' : '/tmp'}` }; }
			if (append) { memory.append(p, bytes); } else { memory.put(p, bytes, mode); }
			return null;
		}
		const { host } = t.r;
		const existing = entries.get(p);
		const stagedFile = existing && existing.k === 'file' ? existing : null;
		let content = bytes;
		if (append && t.cur) {
			if (stagedFile) {
				content = null;                           // appended in place below
			} else {
				// first touch of a base file by an append: its bytes become the start of the staged file
				let prior;
				try { prior = await readBase(p, host, 'open'); } catch (e) { return { code: e.code || 'EIO', reason: 'unreadable', message: `${p}: not written: ${String(e.message).replace(/^[A-Z]+: /, '')}` }; }
				content = new Uint8Array(prior.length + bytes.length);
				content.set(prior, 0);
				content.set(bytes, prior.length);
			}
		}
		const newLen = content === null ? /** @type {any} */ (stagedFile).data.len + bytes.length : content.length;
		if (newLen > caps.writeFile) { return { code: 'EFBIG', reason: 'cap-file', message: `${p}: not written: it would be ${human(newLen)}, over the ${human(caps.writeFile)} one command may write to one file here` }; }
		const oldLen = stagedFile ? stagedFile.data.len : 0;
		if (stagedBytes - oldLen + newLen + memory.bytes > caps.writeRun) { return { code: 'ENOSPC', reason: 'cap-run', message: `${p}: not written: this command would write more than ${human(caps.writeRun)} in total` }; }
		if (!stagedFile && created + 1 > caps.entries) { return { code: 'ENOSPC', reason: 'cap-entries', message: `${p}: not written: this command would create more than ${caps.entries} files and folders` }; }
		if (content === null) {
			const f = /** @type {any} */ (stagedFile);
			f.data.append(bytes);
			f.mtime = now();
			stagedBytes += bytes.length;
		} else {
			setEntry(p, { k: 'file', data: new Bytes(content.slice()), mtime: now(), mode: mode !== undefined ? mode : (stagedFile ? stagedFile.mode : undefined) });
		}
		return null;
	}

	/**
	 * writeFile / appendFile as the engine calls them. The OPENING of a redirection is `writeFile(p, '', 'binary')` (or
	 * appendFile): a refusal throws, and patch LC-5 turns that into bash's own `bash: p: Permission denied`. The write
	 * of the CONTENT comes later, at the end of the redirected command, and never rejects exec() (a throw there loses
	 * the whole script's output):
	 *   * the shell refuses it (outside the folders, a protected path, a cap): dropped and recorded in `denied`;
	 *   * the path was opened by this run and the command has since removed or replaced its parent or the file itself
	 *     (`{ rm -rf d; echo hi; } > d/f`): dropped silently, as GNU's write to an unlinked descriptor is;
	 *   * the call had no opening (`touch`, `tee`, `sort -o`, `split`, cp): the errno of a real file system is thrown,
	 *     and the command reports it the way GNU's does.
	 */
	async function writeOrAppend(path, content, encoding, append) {
		const p = norm(path);
		const bytes = toBytes(content, encoding);
		const opening = bytes.length === 0 && encoding === 'binary';
		const op = append ? 'append' : 'write';
		const t = await writeTarget(p);
		if ('error' in t) {
			if (t.error.policy) { explainPolicy(p); }
			if (opening) { throw fsError(t.error.code, 'open', p, t.error.text); }
			if (!t.error.policy) {
				if (opened.has(p)) { return; }
				throw fsError(t.error.code, 'open', p, t.error.text);
			}
			deny(p, op, t.error.reason, t.error.code, `${p}: ${t.error.text}`);
			return;
		}
		if (opening) { opened.add(p); }
		if (opening && append && t.cur) { return; }          // `>>` of nothing onto what is there
		const refused = await put(t, p, bytes, append, undefined);
		if (refused) { deny(p, op, refused.reason, refused.code, refused.message); }
	}

	/** Stages directory p inside a mount (its parent exists). @returns {Refusal | null} */
	function stageDir(p) {
		const was = entries.get(p);
		if ((!was || was.k !== 'dir') && created + 1 > caps.entries) {
			return { code: 'ENOSPC', reason: 'cap-entries', policy: false, text: `would create more than ${caps.entries} files and folders` };
		}
		setEntry(p, { k: 'dir', mtime: now() });
		return null;
	}

	/** A refusal of a mutating call that the engine may swallow (`rm -f`): the policy ones are recorded. */
	function refuse(p, syscall, e) {
		if (e.policy) {
			explainPolicy(p);
			deny(p, syscall, e.reason, e.code, `${p}: ${e.text}`);
		}
		return fsError(e.code, syscall, p, e.text);
	}

	const OUTSIDE = (p) => ({ code: 'EACCES', reason: memory.get(p) ? 'readonly' : 'outside', policy: true, text: SHELL_TEXT.EACCES });

	/** Writes made by cp and mv: they are the engine's own calls, so a refusal is an error they print. */
	async function strictWrite(p, bytes, syscall) {
		const t = await writeTarget(p);
		if ('error' in t) { throw refuse(p, syscall, t.error); }
		const refused = await put(t, p, bytes, false, undefined);
		if (refused) {
			deny(p, syscall, refused.reason, refused.code, refused.message);
			throw fsError(refused.code, syscall, p, refused.message.replace(p + ': ', ''));
		}
	}

	function dirOverflow(d, over) {
		deny(d, 'mkdir', over.reason, over.code, `${d}: not created: this command ${over.text}`);
		return fsError(over.code, 'mkdir', d, over.text);
	}

	/* ----- the file system the engine sees ---------------------------------------------------------------- */

	/** @type {any} */
	const fs = {
		resolvePath(basePath, p) { return p.startsWith('/') ? norm(p) : norm(basePath + '/' + p); },
		getAllPaths() { return []; },

		async stat(p) { return statPath(norm(p), 'stat', true); },
		async lstat(p) { return statPath(norm(p), 'lstat', false); },
		async exists(p) {
			try { await statPath(norm(p), 'stat', false); return true; } catch (e) { return false; }
		},
		async realpath(p) { p = norm(p); await statPath(p, 'realpath', false); return p; },

		async readFileBuffer(p) { return readBytes(norm(p), 'open'); },
		async readFile(p, encoding) { return fromBytes(await readBytes(norm(p), 'open'), encoding); },
		async readFileBytes(p) { return latin1(await readBytes(norm(p), 'open')); },

		async writeFile(p, content, encoding) { return writeOrAppend(p, content, encoding, false); },
		async appendFile(p, content, encoding) { return writeOrAppend(p, content, encoding, true); },

		async mkdir(p, options) {
			p = norm(p);
			const recursive = !!(options && options.recursive);
			const r = route(p);
			if (r.t === 'virt' || (r.t === 'mem' && memory.get(p))) {
				if (recursive && memory.get(p)?.k !== 'file') { return; }
				throw fsError('EEXIST', 'mkdir', p, memory.get(p)?.k === 'file' ? 'file already exists' : 'directory already exists');
			}
			if (r.t === 'mem') {
				if (!isScratch(p)) { throw refuse(p, 'mkdir', OUTSIDE(p)); }
				const par = memory.get(parentOf(p));
				if (!recursive && (!par || par.k !== 'dir')) { throw fsError('ENOENT', 'mkdir', p); }
				for (let q = parentOf(p); q !== '/'; q = parentOf(q)) { const n = memory.get(q); if (n && n.k === 'file') { throw fsError('ENOTDIR', 'mkdir', p); } if (n) { break; } }
				memory.mkdirp(p);
				return;
			}
			const cur = await lookup(r.m, p, r.host);
			if (cur) {
				if (recursive && cur.type === 'dir') { return; }
				throw fsError('EEXIST', 'mkdir', p, cur.type === 'dir' ? 'directory already exists' : 'file already exists');
			}
			const todo = [p];
			if (parentOf(p) !== r.m.at) {
				for (let q = parentOf(p); ;) {
					const info = q === r.m.at ? { type: 'dir' } : await lookup(r.m, q, mountOf(q)?.host || q);
					if (info) {
						if (info.type !== 'dir') { throw fsError('ENOTDIR', 'mkdir', p); }
						break;
					}
					if (!recursive) { throw fsError('ENOENT', 'mkdir', p); }
					todo.push(q);
					q = parentOf(q);
				}
			}
			for (const d of todo.reverse()) {
				const over = stageDir(d);
				if (over) { throw dirOverflow(d, over); }
			}
		},
		async createExclusive(p, options) {
			p = norm(p);
			const syscall = options && options.directory ? 'mkdir' : 'open';
			const r = route(p);
			if (r.t === 'virt' || (r.t === 'mem' && memory.get(p))) { throw fsError('EEXIST', syscall, p); }
			if (r.t === 'mem') {
				if (!isScratch(p)) { throw refuse(p, syscall, OUTSIDE(p)); }
				const par = memory.get(parentOf(p));
				if (!par || par.k !== 'dir') { throw fsError('ENOENT', syscall, p); }
				if (options && options.directory) { memory.mkdirp(p, options.mode); } else { memory.put(p, new Uint8Array(0), options && options.mode); }
				return;
			}
			if (await lookup(r.m, p, r.host)) { throw fsError('EEXIST', syscall, p); }
			const par = parentOf(p);
			const pinfo = par === r.m.at ? { type: 'dir' } : await lookup(r.m, par, mountOf(par)?.host || par);
			if (!pinfo) { throw fsError('ENOENT', syscall, p); }
			if (pinfo.type !== 'dir') { throw fsError('ENOTDIR', syscall, p); }
			if (options && options.directory) {
				const over = stageDir(p);
				if (over) { throw dirOverflow(p, over); }
				if (options.mode !== undefined) { modes.set(p, options.mode); }
			} else {
				const t = await writeTarget(p);
				if ('error' in t) { throw refuse(p, syscall, t.error); }
				const refused = await put(t, p, new Uint8Array(0), false, options && options.mode);
				if (refused) { deny(p, 'write', refused.reason, refused.code, refused.message); throw fsError(refused.code, 'open', p, refused.message.replace(p + ': ', '')); }
			}
		},

		async readdirWithFileTypes(p) { return listDir(norm(p), 'scandir'); },
		async readdir(p) { return (await listDir(norm(p), 'scandir')).map((d) => d.name); },

		async rm(p, options) {
			p = norm(p);
			const recursive = !!(options && options.recursive);
			const force = !!(options && options.force);
			const r = route(p);
			if (r.t === 'virt') { throw fsError('EPERM', 'rm', p, 'a workspace folder cannot be removed'); }
			if (r.t === 'mem') {
				const n = memory.get(p);
				if (!n) { if (force) { return; } throw fsError('ENOENT', 'rm', p); }
				if (!isScratch(p) || p === '/tmp' || p === '/home/user' || p === '/dev/fd') { throw refuse(p, 'rm', OUTSIDE(p)); }
				if (n.k === 'dir' && !recursive && memory.list(p).length) { throw fsError('ENOTEMPTY', 'rm', p); }
				memory.remove(p);
				dropSticky(p);
				return;
			}
			if (p === r.m.at) {
				deny(p, 'rm', 'mount-root', 'EPERM', `${p}: not removed: it is a workspace folder`);
				throw fsError('EPERM', 'rm', p, 'a workspace folder cannot be removed');
			}
			const info = await lookup(r.m, p, r.host);
			if (!info) { if (force) { return; } throw fsError('ENOENT', 'rm', p); }
			if (info.type === 'dir' && !recursive && (await listDir(p, 'rm')).length) { throw fsError('ENOTEMPTY', 'rm', p); }
			dropBelow(p);
			dropSticky(p);
			// the base keeps what it has: a tombstone hides it. Nothing to hide when an ancestor already does, or when
			// the base never had the path (a file this very command created).
			let hiddenAbove = false;
			for (let q = parentOf(p); ; q = parentOf(q)) {
				if (entries.has(q)) { hiddenAbove = true; break; }
				if (q === r.m.at || q === '/') { break; }
			}
			if (hiddenAbove) { delEntry(p); return; }
			const inBase = await baseStat(p, r.host);
			if (inBase) { setEntry(p, { k: 'gone' }); } else { delEntry(p); }
		},

		/** `options.keepTimes` (what mv passes) gives each copy the modification time of its source. */
		async cp(src, dst, options) {
			src = norm(src); dst = norm(dst);
			const recursive = !!(options && options.recursive);
			const info = await statPath(src, 'cp', false);
			const was = await statPath(dst, 'cp', false).then((x) => x, () => null);
			if (info.isDirectory) {
				if (!recursive) { throw fsError('EISDIR', 'cp', src, 'is a directory'); }
				if (isSelfOrUnder(dst, src)) { throw fsError('EINVAL', 'cp', src, 'cannot copy a directory into itself'); }
				if (was && !was.isDirectory) { throw fsError('ENOTDIR', 'cp', dst, 'cannot overwrite non-directory with directory'); }
				if (!was) { await fs.mkdir(dst, { recursive: false }); }
				for (const d of await listDir(src, 'cp')) { await fs.cp(join(src, d.name), join(dst, d.name), options); }
				return;
			}
			if (was && was.isDirectory) { throw fsError('EISDIR', 'cp', dst, 'cannot overwrite directory with non-directory'); }
			await strictWrite(dst, await readBytes(src, 'cp'), 'cp');
			if (options && options.keepTimes) { mtimes.set(dst, +info.mtime); }
		},
		/**
		 * rename(2): a file replaces a file, a directory takes the place of a missing or EMPTY directory. A directory
		 * onto a directory that has anything in it, a directory onto a file and a file onto a directory are errors, and
		 * nothing has changed when they are.
		 */
		async mv(src, dst) {
			src = norm(src); dst = norm(dst);
			if (src === dst) { return; }
			const rs = route(src);
			if (rs.t === 'virt' || (rs.t === 'mount' && src === rs.m.at)) { throw fsError('EPERM', 'mv', src, 'a workspace folder cannot be moved'); }
			if (rs.t === 'mem' && !isScratch(src)) { throw refuse(src, 'mv', OUTSIDE(src)); }
			const info = await statPath(src, 'mv', false);
			if (info.isDirectory && isSelfOrUnder(dst, src)) { throw fsError('EINVAL', 'mv', src, 'cannot move a directory into itself'); }
			// a directory onto a file, and a file onto a directory, are cp's errors (it is called below, before anything is
			// removed); a directory onto one that has something in it is rename's own
			const was = await statPath(dst, 'mv', false).then((x) => x, () => null);
			if (was && info.isDirectory && was.isDirectory && (await listDir(dst, 'mv')).length > 0) { throw fsError('ENOTEMPTY', 'mv', dst, 'directory not empty'); }
			// what chmod gave the source (and everything below it) goes with it; removing the source forgets it
			/** @type {Array<[string, number]>} */
			const carried = [];
			for (const [k, v] of modes) { if (isSelfOrUnder(k, src)) { carried.push([dst + k.slice(src.length), v]); } }
			await fs.cp(src, dst, { recursive: true, keepTimes: true });
			await fs.rm(src, { recursive: true, force: false });
			for (const [k, v] of carried) { modes.set(k, v); }
		},

		async chmod(p, mode) {
			p = norm(p);
			await statPath(p, 'chmod', false);
			modes.set(p, mode);
		},
		async utimes(p, _atime, mtime) {
			p = norm(p);
			await statPath(p, 'utimes', false);
			if (mtime) { mtimes.set(p, +mtime); }
		},
		async symlink(_target, linkPath) { throw fsError('EPERM', 'symlink', norm(linkPath), 'symbolic links are not available in this shell'); },
		async link(_existing, newPath) { throw fsError('EPERM', 'link', norm(newPath), 'hard links are not available in this shell'); },
		async readlink(p) { p = norm(p); await statPath(p, 'readlink', false); throw fsError('EINVAL', 'readlink', p); },

		/** The engine writes its program stubs (/bin/<name>, /usr/bin/<name>) and /dev, /proc here when it starts. */
		mkdirSync(p, options) { memory.mkdirp(norm(p)); void options; },
		writeFileSync(p, content) {
			p = norm(p);
			const exe = p.startsWith('/bin/') || p.startsWith('/usr/bin/');
			memory.put(p, toBytes(content), exe ? 0o755 : (p === '/dev/null' || p === '/dev/zero' ? 0o666 : 0o644));
		},
	};

	/* ----- the result ------------------------------------------------------------------------------------- */

	/**
	 * The net change set, in the host's namespace, minimal and in an order that can be applied as it stands: new
	 * directories, writes, then deletes (deepest first), then removed directories (deepest first).
	 *
	 * @returns {Promise<{ changes: Change[], refused: string | null }>}
	 *   `refused` says why the set cannot be complete or representable (too many deletions under a removed folder, a
	 *   folder replaced by a file, a folder below a removed one that could not be listed, the editor failing while it
	 *   was worked out); the changes returned are then only the part that was worked out. Never throws.
	 */
	async function changes() {
		try {
			return await workOutChanges();
		} catch (e) {
			const why = String(e && /** @type {any} */ (e).message || e).replace(/^[A-Z]+: /, '').slice(0, 160);
			stats.stagedBytes = stagedBytes;
			stats.stagedEntries = entries.size;
			return { changes: [], refused: `the editor could not be read while the changes were worked out (${why})` };
		}
	}

	async function workOutChanges() {
		/** @type {Change[]} */
		const mk = [];
		/** @type {Change[]} */
		const writes = [];
		/** @type {Change[]} */
		const dels = [];
		/** @type {Change[]} */
		const rmdirs = [];
		/** @type {string | null} */
		let refused = null;
		let beforeBudget = caps.readRun;
		let count = 0;
		const room = () => {
			if (count >= caps.entries) { refused = refused || `it would change more than ${caps.entries} files and folders`; return false; }
			return true;
		};
		const walkLimit = caps.entries * 4;

		/** the base's bytes for a change's `before`: lazily, only for what stays a change, under its own budget */
		async function before(p, host, size) {
			if (baseBytes.has(p)) { return baseBytes.get(p) || null; }
			if (size > caps.readFile || size > beforeBudget) { return null; }
			try {
				stats.readCalls++;
				const b = await base.readFile(host);
				beforeBudget -= b.length;
				baseBytes.set(p, b);
				return b;
			} catch { return null; }
		}

		/** the first directory under a removed one that the base would not list */
		let unlistable = null;

		/** everything the base has below directory p: the overlay is not consulted */
		async function walkBase(p, host, out) {
			let list;
			try { list = await baseList(p, host); } catch { unlistable = unlistable || p; return; }
			for (const [name, type] of list) {
				if (out.length > walkLimit) { return; }
				const c = join(p, name);
				out.push({ p: c });
				if (type === 'dir') { await walkBase(c, host + '/' + name, out); }
			}
		}

		const paths = [...entries.keys()].sort();
		/** @type {Set<string>} */
		const seen = new Set();
		/** @type {Array<{ p: string, via?: string }>} */
		const candidates = [];
		for (const p of paths) {
			if (!seen.has(p)) { seen.add(p); candidates.push({ p }); }
			const e = entries.get(p);
			const r = mountOf(p);
			if (!r || !e || e.k === 'file') { continue; }
			// everything the base has below a removed or re-created directory is part of the change
			let hiddenAbove = false;
			for (let q = parentOf(p); q !== r.m.at && q !== '/'; q = parentOf(q)) { if (entries.has(q)) { hiddenAbove = true; break; } }
			if (hiddenAbove) { continue; }
			const bs = await baseStat(p, r.host);
			if (bs && bs.type === 'dir') {
				const found = [];
				await walkBase(p, r.host, found);
				if (unlistable) { refused = refused || `${unlistable} could not be listed, so what removing ${p} takes with it is not known`; break; }
				if (found.length > walkLimit) { refused = refused || `${p} holds more than ${walkLimit} files and folders`; break; }
				for (const f of found) { if (!seen.has(f.p)) { seen.add(f.p); candidates.push({ p: f.p, via: p }); } }
			}
		}

		for (const c of candidates) {
			if (refused) { break; }
			const p = c.p;
			const r = mountOf(p);
			if (!r) { continue; }
			// A name made of bytes that are not UTF-8 (`touch "$(cat latin1)"`) is a string with a lone surrogate in it: no
			// editor path or URI can hold it, and a rewritten name would be a different file. The whole set is refused, and
			// the command is told which name it was.
			if (hasLoneSurrogate(p)) {
				refused = `${displayText(p)} has a name that is not valid UTF-8, which the editor cannot address`;
				break;
			}
			const info = await lookup(r.m, p, r.host);           // what the command left
			const bs = p === r.m.at ? { type: /** @type {'dir'} */ ('dir'), size: 0, mtime: 0 } : await baseStat(p, r.host);   // what was there
			const hp = r.host;
			if (info && info.type === 'file') {
				const node = /** @type {any} */ (info.node);
				if (bs && bs.type === 'dir') { refused = `${p} is a folder and would become a file: remove the folder in one command and write the file in the next`; continue; }
				if (bs) {
					const prior = await before(p, hp, bs.size);
					if (prior && node && bytesEqual(prior, node.data.view)) { continue; }   // same bytes: not a change
					if (!room()) { continue; }
					count++;
					writes.push({ kind: 'write', path: hp, existed: true, before: prior, after: node.data.view.slice() });
				} else {
					if (!room()) { continue; }
					count++;
					writes.push({ kind: 'write', path: hp, existed: false, before: null, after: node.data.view.slice() });
				}
			} else if (info && info.type === 'dir') {
				if (bs && bs.type === 'file') { refused = `${p} is a file and would become a folder: remove the file in one command and make the folder in the next`; continue; }
				if (!bs) {
					if (!room()) { continue; }
					count++;
					mk.push({ kind: 'mkdir', path: hp });
				}
			} else if (bs) {
				if (!room()) { continue; }
				count++;
				if (bs.type === 'file') {
					/** @type {Change} */
					const d = { kind: 'delete', path: hp, before: await before(p, hp, bs.size) };
					if (c.via) { d.viaDir = toHost(c.via); }
					dels.push(d);
				} else {
					rmdirs.push({ kind: 'rmdir', path: hp });
				}
			}
		}
		const depth = (c) => c.path.split('/').length;
		mk.sort((a, b) => depth(a) - depth(b) || (a.path < b.path ? -1 : 1));
		writes.sort((a, b) => (a.path < b.path ? -1 : 1));
		dels.sort((a, b) => depth(b) - depth(a) || (a.path < b.path ? -1 : 1));
		rmdirs.sort((a, b) => depth(b) - depth(a) || (a.path < b.path ? -1 : 1));
		stats.stagedBytes = stagedBytes;
		stats.stagedEntries = entries.size;
		return { changes: [...mk, ...writes, ...dels, ...rmdirs], refused };
	}

	return {
		fs,
		changes,
		denied,
		notes,
		device,
		stats,
		mounts,
		memory,
		caps,
		toHost,
		/** the shell's path for a path the host named (a relocated folder is seen under /mnt) */
		fromHost(p) {
			p = norm(p);
			for (const m of mounts) { if (isSelfOrUnder(p, m.host)) { return m.at + p.slice(m.host.length); } }
			return p;
		},
		/** true when p is inside a workspace folder */
		inMount(p) { return mountOf(norm(p)) !== null; },
	};
}

module.exports = { createOverlay, createMemory: () => new MemoryFs(), planMounts, validCaps, DEFAULT_CAPS, RESERVED, SCRATCH, MOUNT_BASES, DIR_SIZE, norm, fsError, isShellScript };
