// The engine worker's brain: README.md §4, without the Worker. `createCore({ Engine, post, now })` returns an object
// whose `handle(message)` takes what the host posts and answers through `post` — so the protocol is tested in a plain
// node process, and worker.js is five lines.
//
//   host -> engine   init, run, abort, fsr
//   engine -> host   ready, fs (a read), out (per top-level statement), done (exactly once per run)
//
// What this file does NOT do: write anything. The overlay holds every effect of a run until `done`, and `done`
// carries them as a change set the host decides about.
//
// Properties the rest of the shell relies on, each pinned by a test:
//   * a run NEVER rejects and never prints a stack: every engine exception is { how: 'error' } with a shell-style line
//   * a run that did not END on its own (limit, deadline, abort, error), or in which a write was refused, or whose
//     change set cannot be represented, applies nothing: `changes` is empty and `stats.discarded` says how many there
//     were. A script that ended with status 0 and had its changes withheld ends with status 1
//   * the limits are the full table of limits.js, passed explicitly: a library default is never what is in force
//   * a late `fsr` (an answer to a read of an earlier run) is ignored
'use strict';
// @ts-check

const { createOverlay, createMemory, planMounts, norm } = require('./overlay-fs.js');
const compat = require('./compat.js');
const { LIMITS } = require('./limits.js');
const { decodeIfBytes, displayText, joinEscapes, hasLoneSurrogate } = require('./text.js');

/** README §3: what a script starts with, under whatever the host gives. */
const DEFAULT_ENV = Object.freeze({
	HOME: '/home/user',
	PATH: '/usr/bin:/bin',
	TERM: 'dumb',
	CI: '1',
	NO_COLOR: '1',
	LANG: 'C.UTF-8',
});

/** Keys of the engine's result env that are not the user's to carry to the next line. */
const ENV_DROP = new Set(['?', 'SHELLOPTS', 'BASHOPTS']);

/** Programs that are not offered although the engine has them. */
const EXCLUDED = new Set(compat.EXCLUDED);

/**
 * An engine message that says a limit stopped the script (the exit status is 126). The wordings are the ones
 * just-bash 3.6.0 has: "seq: iteration limit exceeded (N)", "sed: command execution exceeded maximum iterations (N)",
 * "f: maximum recursion depth (N) exceeded", "tr: expanded SET exceeds string length limit (N)", and every one that
 * ends in "increase executionLimits.maxX" (too many commands, total output size, ...). Each is pinned by a test.
 */
const LIMIT_LINE = /(limit exceeded|exceeded maximum|maximum [a-z ]*\(?\d*\)? ?exceeded|exceeds|increase executionLimits)/i;
/** The engine's deadline text, "bash: sleep exceeded its execution deadline" (the exit status is 124). */
const DEADLINE_LINE = /execution deadline/i;
const ABORT_LINE = /execution aborted/i;

/** Why a run that did not end by itself applied nothing, for the note that says so (only when something was staged). */
const NOT_APPLIED_BECAUSE = Object.freeze({
	limit: 'it was stopped by a limit of this shell',
	deadline: 'it ran for longer than this shell allows',
	aborted: 'it was stopped',
	error: 'it failed inside the shell',
});

/** One macrotask, without the 4 ms clamp a nested setTimeout gets in a browser. */
function yieldNow() {
	return new Promise((resolve) => {
		if (typeof MessageChannel === 'function') {
			const ch = new MessageChannel();
			ch.port1.onmessage = () => { ch.port1.close(); resolve(undefined); };
			ch.port2.postMessage(0);
		} else {
			setTimeout(resolve, 0);
		}
	});
}

/**
 * What the engine printed, as text for a person (or a model): a string that is the bytes of valid UTF-8 is decoded
 * (the same rule the engine applies to its own final result), escapes of bytes that make UTF-8 together (two
 * statements that each printed half of a character, `printf '\\303'; printf '\\251'`, in ONE chunk) are the character,
 * and a byte that is not UTF-8, which the engine's text keeps as an escape (that is for files, not for eyes), is
 * shown as U+FFFD.
 */
function decodeBytes(s) {
	return displayText(decodeIfBytes(joinEscapes(s)));
}

/** An exception from the engine, as one line a person can read. Never a stack, never a minified name. */
function describeException(e) {
	let msg = '';
	if (e !== undefined && e !== null) {
		const m = typeof e === 'object' ? e.message : e;
		msg = typeof m === 'string' ? m : (typeof m === 'number' || typeof m === 'boolean' ? String(m) : '');
	}
	if ((e && e.name === 'RangeError' && /call stack/i.test(msg)) || /Maximum call stack|too much recursion/i.test(msg)) {
		return 'bash: the command is nested too deeply to run';
	}
	if (/Invalid (array|string|typed array) length|out of memory|Array buffer allocation failed|Invalid count value/i.test(msg)) {
		return 'bash: a value became too large to hold';
	}
	const first = msg.split('\n')[0].replace(/\s+/g, ' ').trim().slice(0, 200);
	return 'bash: ' + (first || 'internal error');
}

/**
 * The engine's limit message with the developer's advice taken out, and the name of what was exceeded kept.
 * @param {string} line
 */
function humaniseLimit(line) {
	const text = line.replace(/^bash: /, '').replace(/,?\s*increase executionLimits\.\w+/g, '').replace(/\s+/g, ' ').trim();
	return `bash: stopped by a limit of this shell: ${text}`;
}

/**
 * @param {object} deps
 * @param {{ Bash: any, defineCommand: any, getCommandNames: () => string[], LimitError?: any }} deps.Engine the patched just-bash
 * @param {(message: any, transfer?: ArrayBuffer[]) => void} deps.post
 * @param {() => number} [deps.now]
 */
function createCore(deps) {
	const { Engine, post } = deps;
	const now = deps.now || (() => Date.now());

	let gen = 0;
	let folders = [];
	let limits = Object.assign({}, LIMITS);
	/** @type {string[] | null} built-in programs in force */
	let allowed = null;
	/** @type {Set<string>} the names of compat.js's commands in force (its wrappers need the program they wrap) */
	let customNames = new Set();
	let started = false;
	let nextRid = 1;
	/** @type {Map<number, { resolve: (v: any) => void, reject: (e: any) => void }>} */
	const pending = new Map();
	/** @type {{ id: any, controller: AbortController, aborted: boolean } | null} */
	let active = null;
	let memory = null;

	/** the host's read-only file system, as the overlay's base */
	const base = {
		stat: (path) => rpc('stat', path),
		readFile: (path) => rpc('readFile', path),
		readDir: (path) => rpc('readDir', path),
	};

	function rpc(op, path) {
		// a read that the engine starts after its run was answered (it was stopped, a promise of its was left over)
		// is never sent and never answered
		if (!active) { return new Promise(() => { /* never */ }); }
		return new Promise((resolve, reject) => {
			const rid = nextRid++;
			pending.set(rid, { resolve, reject });
			post({ t: 'fs', rid, op, path });
		});
	}

	/** the built-ins in force: what the engine has, minus what is not offered (and minus what the host did not name) */
	function programList(host) {
		const names = Engine.getCommandNames().filter((n) => !EXCLUDED.has(n));
		if (Array.isArray(host) && host.length) {
			const want = new Set(host);
			return names.filter((n) => want.has(n));
		}
		return names;
	}

	function init(msg) {
		gen = Number.isFinite(msg.gen) ? msg.gen : gen;
		started = false;
		folders = Array.isArray(msg.folders) ? msg.folders.filter((f) => f && typeof f.path === 'string') : [];
		limits = Object.assign({}, LIMITS);
		if (msg.limits && typeof msg.limits === 'object') {
			for (const k of Object.keys(LIMITS)) {
				if (typeof msg.limits[k] === 'number' && msg.limits[k] > 0) { limits[k] = msg.limits[k]; }
			}
		}
		allowed = programList(msg.commands);
		// A host that named the programs it wants gets only those: a wrapper (grep, sed ...) is there only when what it
		// wraps is, and a program compat.js adds (cmp, id ...) only when it was named
		const named = Array.isArray(msg.commands) && msg.commands.length ? new Set(msg.commands) : null;
		const have = allowed;
		customNames = new Set(compat.commands(Engine.defineCommand, Engine.LimitError).map((c) => c.name).filter((n) => (
			compat.WRAPPED.includes(n) ? have.includes(n) : (!named || named.has(n))
		)));
		started = true;
		const commands = [...new Set([...allowed, ...customNames])].sort();
		post({ t: 'ready', gen, commands, mounts: planMounts(folders).map((m) => ({ id: m.id, name: m.name, path: m.host, at: m.at, relocated: m.relocated })) });
	}

	/** init, whatever goes wrong in it: a host that waits for `ready` is told, not left waiting */
	function safeInit(msg) {
		try {
			init(msg);
		} catch (e) {
			// `started` is false already: init() clears it first and sets it last
			post({ t: 'ready', gen, commands: [], mounts: [], error: describeException(e).replace(/^bash: /, '') });
		}
	}

	/** @param {any} msg */
	function fsr(msg) {
		const p = pending.get(msg.rid);
		if (!p) { return; }                                  // a read of an earlier run, or of one that was dropped
		pending.delete(msg.rid);
		if (msg.ok) { p.resolve(msg.value); } else { p.reject(Object.assign(new Error((msg.error && msg.error.message) || 'read failed'), { code: msg.error && msg.error.code })); }
	}

	function abort(msg) {
		if (active && (msg.id === undefined || msg.id === active.id)) {
			active.aborted = true;
			active.controller.abort();
		}
	}

	/** @param {any} msg */
	async function run(msg) {
		const id = msg.id;
		const t0 = now();
		let doneSent = false;
		const say = (stream, text) => { if (text && !doneSent) { post({ t: 'out', id, stream, text }); } };
		const finish = (r, transfer) => {
			if (doneSent) { return; }
			doneSent = true;
			const failed = { t: 'done', id, exitCode: 1, how: 'error', cwd: msg.cwd || '/', env: {}, changes: [], denied: [], notes: [], stats: { durationMs: now() - t0, discarded: 0 } };
			try {
				post(Object.assign({}, failed, r), transfer);
			} catch (e) {
				// the host could not take the result (a DataCloneError for a buffer it cannot transfer): a run that is
				// never answered would hang whoever waits for it, so a smaller answer goes instead
				try {
					post(Object.assign({}, failed, { notes: [`The result of this command could not be sent (${describeException(e).replace(/^bash: /, '')}). Nothing was changed.`] }));
				} catch { /* nothing more can be said */ }
			}
		};
		if (!started || !allowed) {
			say('stderr', 'bash: the shell has not been started\n');
			finish({});
			return;
		}
		if (active) {
			say('stderr', 'bash: the shell is busy with another command\n');
			finish({});
			return;
		}
		const controller = new AbortController();
		active = { id, controller, aborted: false };
		try {
			await execute(msg, controller, t0, say, finish);
		} catch (e) {
			// execute() answers for itself; this is the last line of defence, and it still answers exactly once
			say('stderr', describeException(e) + '\n');
			finish({});
		} finally {
			active = null;
			pending.clear();
		}
	}

	async function execute(msg, controller, t0, say, finish) {
		if (!msg.keepTmp || !memory) { memory = createMemory(); }
		// the caps are the host's, each one only when it is a number above zero (overlay-fs.js validCaps)
		const overlay = createOverlay({ folders, base, caps: msg.caps, memory, now });
		/** @type {string[]} */
		const notes = [];
		for (const m of overlay.mounts) {
			if (m.relocated) { notes.push(`The folder "${m.name}" is mounted at ${m.at}, not at ${m.host}: ${m.reason}.`); }
		}

		// where the script starts
		let cwd = overlay.fromHost(typeof msg.cwd === 'string' && msg.cwd ? msg.cwd : (overlay.mounts[0] ? overlay.mounts[0].at : '/'));
		try {
			const st = await overlay.fs.stat(cwd);
			if (!st.isDirectory) { throw new Error('not a directory'); }
		} catch {
			const fallback = overlay.mounts[0] ? overlay.mounts[0].at : '/';
			notes.push(`The working directory ${String(msg.cwd)} does not exist; the command started in ${fallback}.`);
			cwd = fallback;
		}
		/** @type {Record<string, string>} */
		const env = {};
		Object.assign(env, DEFAULT_ENV);
		if (msg.env && typeof msg.env === 'object') {
			for (const k of Object.keys(msg.env)) { if (typeof msg.env[k] === 'string') { env[k] = msg.env[k]; } }
		}
		env.PWD = cwd;                                      // the engine sets it too; this does not rest on that
		// a path from an earlier line that is now relocated or gone must not leak in as OLDPWD
		if (typeof env.OLDPWD === 'string') { env.OLDPWD = overlay.fromHost(env.OLDPWD); }

		const bash = new Engine.Bash({
			fs: overlay.fs,
			cwd,
			env,
			executionLimits: limits,
			commands: allowed,
			customCommands: compat.commands(Engine.defineCommand, Engine.LimitError).filter((c) => customNames.has(c.name)),
			defenseInDepth: false,
		});

		// streaming: one `out` per top-level statement; what a statement printed is shown at its end
		let rawOut = '';
		let rawErr = '';
		let lastYield = now();
		let shownDenied = 0;
		const flushDenied = () => {
			for (; shownDenied < overlay.denied.length; shownDenied++) { say('stderr', displayText('bash: ' + overlay.denied[shownDenied].message + '\n')); }
		};
		const flushDevices = () => {
			if (overlay.device.stdout) { say('stdout', overlay.device.stdout); overlay.device.stdout = ''; }
			if (overlay.device.stderr) { say('stderr', overlay.device.stderr); overlay.device.stderr = ''; }
		};
		const onStatement = async (res) => {
			try {
				const o = typeof res.stdout === 'string' ? res.stdout : '';
				const e = typeof res.stderr === 'string' ? res.stderr : '';
				rawOut += o;
				rawErr += e;
				say('stdout', decodeBytes(o));
				say('stderr', decodeBytes(e));
				flushDevices();
				flushDenied();
				if (now() - lastYield > 15) {
					await yieldNow();            // lets an `abort` that is waiting in the queue be heard
					lastYield = now();
				}
			} catch { /* a hook that throws makes exec() reject: it never does */ }
		};

		const script = (msg.expandAliases ? 'shopt -s expand_aliases; ' : '') + String(msg.script || '');
		let result = null;
		let thrown = null;
		let threw = false;
		try {
			const opts = { signal: controller.signal, onStatement };
			if (typeof msg.stdin === 'string' && msg.stdin !== '') { opts.stdin = msg.stdin; }
			// `cd -` reads the previous directory from here, not from the variable the constructor was given
			if (typeof env.OLDPWD === 'string') { opts.env = { OLDPWD: env.OLDPWD }; }
			result = await bash.exec(script, opts);
		} catch (e) {
			thrown = e;
			threw = true;               // `throw undefined` is a throw too
		}

		// what the statements did not show: the output of a statement that left the script (exit, a limit, an error)
		const raw = result && result.lcRaw ? result.lcRaw : { stdout: result ? result.stdout : '', stderr: result ? result.stderr : '' };
		let tailOut = typeof raw.stdout === 'string' ? raw.stdout.slice(rawOut.length) : '';
		let tailErr = typeof raw.stderr === 'string' ? raw.stderr.slice(rawErr.length) : '';

		// how it ended
		let how = 'exit';
		let exitCode = result ? Number(result.exitCode) : 1;
		if (!Number.isFinite(exitCode)) { exitCode = 1; }
		if (threw) {
			how = 'error';
			exitCode = 1;
			tailOut = '';
			tailErr = describeException(thrown) + '\n';
		} else if (exitCode === 124 && active && active.aborted) {
			how = 'aborted';        // the engine says 124 either way; whether it also printed "execution aborted" depends on where it was
		} else if (exitCode === 124 && DEADLINE_LINE.test(tailErr)) {
			how = 'deadline';
		} else if (exitCode === 126 && tailErr.split('\n').some((l) => /^bash: /.test(l) && LIMIT_LINE.test(l))) {
			how = 'limit';
		}
		if (how === 'limit') {
			tailErr = tailErr.split('\n').map((l) => (/^bash: /.test(l) && LIMIT_LINE.test(l) ? humaniseLimit(l) : l)).join('\n');
		} else if (how === 'deadline') {
			tailErr = tailErr.split('\n').map((l) => (DEADLINE_LINE.test(l) ? 'bash: stopped: the command ran for longer than this shell allows' : l)).join('\n');
		} else if (how === 'aborted') {
			tailErr = tailErr.split('\n').map((l) => (ABORT_LINE.test(l) ? 'bash: stopped' : l)).join('\n');
		}
		say('stdout', decodeBytes(tailOut));
		say('stderr', decodeBytes(tailErr));
		flushDevices();
		flushDenied();

		// the change set: only a script that ran to its end, in which nothing was refused, may have one
		let changes = [];
		let discarded = 0;
		let withheld = null;
		// what the overlay says about a path may hold the escape of a byte that is not UTF-8: shown as U+FFFD, like the output
		const denied = overlay.denied.map((d) => Object.assign({}, d, { path: displayText(d.path), message: displayText(d.message) }));
		if (how === 'exit') {
			if (denied.length) {
				withheld = 'denied';
				notes.push('None of its file changes were applied: it tried to change something this shell does not change (see above).');
			}
			const r = await overlay.changes();
			if (r.refused && !withheld) {
				withheld = 'incomplete';
				notes.push(`None of its file changes were applied: ${r.refused}.`);
			}
			if (withheld) { discarded = r.changes.length; } else { changes = r.changes; }
		} else {
			try { discarded = (await overlay.changes()).changes.length; } catch { discarded = 0; }
			if (discarded > 0) { notes.push(`None of its file changes were applied: ${NOT_APPLIED_BECAUSE[how] || 'it did not end by itself'}.`); }
		}
		// a script that "succeeded" and changed nothing must not look as if it had: the status says so
		if (how === 'exit' && exitCode === 0 && withheld) { exitCode = 1; }
		for (const n of overlay.notes) { notes.push(n); }
		for (let i = 0; i < notes.length; i++) { notes[i] = displayText(notes[i]); }

		// carried to the next line of a terminal session
		const outEnv = {};
		const src = result && result.env ? result.env : env;
		for (const k of Object.keys(src)) {
			if (ENV_DROP.has(k) || typeof src[k] !== 'string') { continue; }
			outEnv[k] = src[k];
		}
		// where the session is left: a path in canonical form (a script's own `PWD=/a/../b` is not one), and one the host
		// can address. A directory whose name is not UTF-8 (`cd "$(cat latin1)"`) exists only in this run and its change
		// set is refused, so the session stays in the nearest directory above it that has a name
		const settle = (p) => {
			let q = norm(p);
			while (q !== '/' && hasLoneSurrogate(q)) { q = norm(q + '/..'); }
			if (q !== norm(p)) { notes.push(displayText(`The directory ${p} has a name that is not valid UTF-8, which the editor cannot address; the session stays in ${q}.`)); }
			return q;
		};
		outEnv.PWD = overlay.toHost(settle(typeof outEnv.PWD === 'string' ? outEnv.PWD : cwd));
		if (typeof outEnv.OLDPWD === 'string') { outEnv.OLDPWD = overlay.toHost(settle(outEnv.OLDPWD)); }

		/** @type {ArrayBuffer[]} */
		const transfer = [];
		const seen = new Set();
		const own = (u8) => {
			if (!u8) { return u8; }
			let b = u8;
			if (b.byteOffset !== 0 || b.byteLength !== b.buffer.byteLength) { b = b.slice(); }
			if (!seen.has(b.buffer)) { seen.add(b.buffer); transfer.push(b.buffer); }
			return b;
		};
		for (const c of changes) {
			if (c.kind === 'write') { c.after = own(c.after); c.before = own(c.before); }
			if (c.kind === 'delete') { c.before = own(c.before); }
		}

		const stats = Object.assign({}, overlay.stats, {
			durationMs: now() - t0,
			changes: changes.length,
			discarded,
			withheld,
			mounts: overlay.mounts.length,
			// what a session keeps in memory and loses when it is stopped (the host says so once); a run that keeps
			// nothing reports none
			tmpFiles: msg.keepTmp ? overlay.memory.countFiles('/tmp') : 0,
			homeFiles: msg.keepTmp ? overlay.memory.countFiles('/home/user') : 0,
			// files AND folders: a /tmp that holds only empty folders is lost as well
			tmpEntries: msg.keepTmp ? overlay.memory.countEntries('/tmp') : 0,
			homeEntries: msg.keepTmp ? overlay.memory.countEntries('/home/user') : 0,
		});
		if (!msg.keepTmp) { memory = null; }
		finish({ exitCode, how, cwd: outEnv.PWD, env: outEnv, changes, denied, notes, stats }, transfer);
	}

	/** @param {any} msg */
	function handle(msg) {
		if (!msg || typeof msg !== 'object') { return Promise.resolve(); }
		switch (msg.t) {
			case 'init': safeInit(msg); return Promise.resolve();
			case 'fsr': fsr(msg); return Promise.resolve();
			case 'abort': abort(msg); return Promise.resolve();
			case 'run': return run(msg);
			default: return Promise.resolve();
		}
	}

	return { handle, get commands() { return allowed ? [...new Set([...allowed, ...customNames])].sort() : []; } };
}

module.exports = { createCore, DEFAULT_ENV, EXCLUDED, LIMIT_LINE, DEADLINE_LINE, ABORT_LINE, describeException, humaniseLimit, decodeBytes, yieldNow };
