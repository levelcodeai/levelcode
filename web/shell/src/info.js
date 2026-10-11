/*---------------------------------------------------------------------------------------------
 *  LevelCode Shell - what the shell says about itself.
 *
 *  The agent's prompt and its tool list are built from this (levelcode-ai/host.js ShellInfo), so it has to be
 *  TRUE: a program named here that the engine does not have is a command the model will keep trying. The
 *  program list that counts is the one the engine reports when it starts (its `ready` message); PROGRAMS is
 *  only what the shell asks the engine for, and what the prompt says before the first run has started one.
 *
 *  Pure; no vscode.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

const MiB = 1024 * 1024;

/**
 * Every number the shell enforces or hands to the engine (README section 7). One table so a test can assert
 * the whole of it, and so a change shows in one place. Frozen all the way down.
 */
const LIMITS = deepFreeze({
	/** Handed to the engine as just-bash `executionLimits`. Names are just-bash's own. */
	engine: {
		maxCommandCount: 100000, maxLoopIterations: 100000, maxCallDepth: 100,
		maxOutputSize: 8 * MiB, maxStringLength: 16 * MiB, maxLiveBytes: 64 * MiB, maxInputBytes: 32 * MiB,
		/** A backstop: the host's own timer (engine.maxExecutionTimeMs + workers.deadlineGraceMs) is the real one. */
		maxExecutionTimeMs: 600000,
	},
	/**
	 * What the host lets the engine read. `file` and `run` are README section 7's, handed to the engine, which
	 * counts what a script asks to read. `served` is the host's own backstop on everything it sends in one run: it
	 * has room for what the engine reads for itself (the original of a file it is about to change), which is not the
	 * script's. Every read is checked with a stat BEFORE the file is read.
	 */
	read: { file: 4 * MiB, run: 16 * MiB, served: 32 * MiB },
	/** What a run may leave staged: one file, all of the run, and the number of entries. */
	agent: { writeFile: 1 * MiB, writeRun: 8 * MiB, entries: 2000 },
	terminal: { writeFile: 8 * MiB, writeRun: 32 * MiB, entries: 2000 },
	workers: {
		/** Live engine workers, in all. */
		max: 4,
		/** An idle worker is terminated after this; the next run spawns a new one (about 45 ms). */
		idleMs: 60000,
		/** How long a new worker has to answer `init`. */
		readyMs: 20000,
		/** How long one call to the file system may take (a read for the engine, a write of the commit). */
		fsMs: 60000,
		/**
		 * How long the read-only check of a change set may take in all (the terminal's: has anything changed on disk since
		 * the command read it?), counted from its first call, and how that grows with the set: `checkMs` is for a set of up
		 * to `checkEntries` entries, a larger one gets the same time per entry, and no set gets more than `checkMaxMs` (see
		 * checkBudgetMs). A check is up to two calls an entry (a stat, and the bytes of a file the command read): 60 s is
		 * 250 ms a call for 120 entries, which is what a slow network folder needs, and 2 minutes are 30 ms a call at the cap
		 * of 2000 entries. A provider that does not answer is not waited for that long: its first call that is not answered
		 * in `fsMs` ends the check and the set is refused whole, once ("could not be checked in time"). The budget bounds the
		 * one that answers every call just before fsMs, and is why it is not "for ever".
		 */
		checkMs: 60000, checkEntries: 120, checkMaxMs: 120000,
		/**
		 * How long the part of a commit that WRITES may take in all, counted from its first call: levelcode-ai's review
		 * of a change set and then the folders it left to the shell (one budget, for the agent), or the shell's own
		 * writes (the terminal, after its check, which has checkMs). Each call is also bound by fsMs. What is not done
		 * when this runs out is not started, and the one call in flight may still land: the result says so.
		 */
		commitMs: 120000,
		/** The host's deadline for a run is the engine's backstop plus this. */
		deadlineGraceMs: 15000,
		/** Path completion: names and time. */
		completeMax: 200, completeMs: 2000,
	},
});

/**
 * How long the read-only check of a change set of `entries` entries has in all: `checkMs` for up to `checkEntries` of
 * them, in proportion above that, never more than `checkMaxMs` - and never less than `checkMs`, whatever the others
 * say. The budget is a bound on a provider that is slow but alive, so it has to go with the work: a constant that
 * is right for 20 entries refuses a set of 2000 that a provider answering in 30 ms a call would have had applied.
 * @param {{ checkMs: number, checkEntries: number, checkMaxMs: number }} w  limits.workers
 * @param {number} entries
 */
function checkBudgetMs(w, entries) {
	const n = typeof entries === 'number' && Number.isFinite(entries) && entries > 0 ? entries : 0;
	return Math.max(w.checkMs, Math.min(w.checkMaxMs, Math.ceil(w.checkMs * n / w.checkEntries)));
}

/** @template T @param {T} o @returns {T} */
function deepFreeze(o) {
	if (o && typeof o === 'object') { Object.values(o).forEach(deepFreeze); Object.freeze(o); }
	return o;
}

/**
 * Overlay a partial limits table on the defaults, group by group; unknown groups and keys are ignored so a
 * misspelt override cannot loosen anything silently. Values must be positive finite numbers.
 * @param {any} [over]
 * @returns {typeof LIMITS}
 */
function mergeLimits(over) {
	/** @type {any} */ const out = {};
	for (const group of Object.keys(LIMITS)) {
		out[group] = Object.assign({}, /** @type {any} */ (LIMITS)[group]);
		const o = over && over[group];
		if (!o || typeof o !== 'object') { continue; }
		for (const k of Object.keys(out[group])) {
			if (typeof o[k] === 'number' && Number.isFinite(o[k]) && o[k] > 0) { out[group][k] = o[k]; }
		}
	}
	return deepFreeze(out);
}

/**
 * The programs the shell asks the engine for (init.commands: the engine offers its built-ins that are named here,
 * so a program that a vendor bump adds is NOT offered until it is named) and says in the prompt until an engine
 * has told what it really has. Sorted. It is the engine's offer exactly: just-bash's commands that need node:zlib
 * or a DOM are not in it (gzip gunzip zcat html-to-markdown), and the six the engine defines itself are (od,
 * realpath, uname, id, nproc, cmp). shell-runtime-info.test.js loads the engine and fails when the two differ.
 * Bash's own builtins are not programs and are not in it.
 */
const PROGRAMS = Object.freeze([
	'alias', 'awk', 'base64', 'basename', 'bash', 'cat', 'chmod', 'clear', 'cmp', 'column', 'comm', 'cp', 'cut', 'date',
	'diff', 'dirname', 'du', 'echo', 'egrep', 'env', 'expand', 'expr', 'false', 'fgrep', 'file', 'find', 'fold', 'grep',
	'head', 'help', 'history', 'hostname', 'id', 'join', 'jq', 'ln', 'ls', 'md5sum', 'mkdir', 'mktemp', 'mv', 'nl',
	'nproc', 'od', 'paste', 'printenv', 'printf', 'pwd', 'readlink', 'realpath', 'rev', 'rg', 'rm', 'rmdir', 'sed',
	'seq', 'sh', 'sha1sum', 'sha256sum', 'sleep', 'sort', 'split', 'stat', 'strings', 'tac', 'tail', 'tee', 'time',
	'timeout', 'touch', 'tr', 'tree', 'true', 'unalias', 'uname', 'unexpand', 'uniq', 'wc', 'which', 'whoami', 'xargs',
	'yes',
]);

/**
 * What a model reaches for that this shell does not have. The prompt names these so it does not try them one
 * by one. Anything the engine really reports is taken out again (`missing` is computed, never stored), and the
 * engine's own list of what it knows to be missing (engine/compat.js LIKELY_MISSING) is a subset of this one:
 * the info test checks it.
 */
const MISSING = Object.freeze([
	'apt', 'apt-get', 'bc', 'bun', 'bundle', 'bzip2', 'cargo', 'cc', 'cksum', 'cmake', 'curl', 'dd', 'deno', 'docker',
	'docker-compose', 'emacs', 'eslint', 'g++', 'gcc', 'gem', 'git', 'go', 'gradle', 'gunzip', 'gzip', 'hexdump',
	'html-to-markdown', 'iconv', 'install', 'java', 'javac', 'js-exec', 'kill', 'kubectl', 'less', 'make', 'more',
	'mvn', 'nano', 'nc', 'node', 'nodejs', 'npm', 'npx', 'patch', 'perl', 'php', 'pip', 'pip3', 'pipx', 'pkill', 'pnpm',
	'prettier', 'ps', 'pytest', 'python', 'python3', 'rsync', 'ruby', 'rustc', 'scp', 'sha512sum', 'shasum', 'shuf',
	'sqlite3', 'ssh', 'su', 'sudo', 'tar', 'top', 'truncate', 'tsc', 'tsort', 'unzip', 'vi', 'vim', 'wget', 'xan', 'xxd',
	'xz', 'yarn', 'yq', 'zcat', 'zip',
]);

/** Shell builtins, for completion only (they are the engine's, not programs). */
const BUILTINS = Object.freeze([
	'.', ':', '[', 'break', 'cd', 'command', 'continue', 'declare', 'eval', 'exit', 'export', 'getopts', 'local',
	'read', 'readonly', 'return', 'set', 'shift', 'shopt', 'source', 'test', 'type', 'unset',
]);

/**
 * @typedef {object} ShellInfo  README section 3.
 * @property {'LevelCode Shell'} label
 * @property {false} background
 * @property {false} programs
 * @property {false} network
 * @property {string[]} commands   the programs that exist (exact names), sorted
 * @property {string[]} missing    the ones the model is likely to try that do not
 * @property {{ commandCount: number, loopIterations: number, callDepth: number, outputBytes: number, fileReadBytes: number, runReadBytes: number }} limits
 */

/**
 * The ShellInfo the agent reads, and the one function that changes it. `commands` and `missing` are live: the
 * list is the engine's the moment an engine has started, and the constant until then.
 * @param {any} [limitsOver]  see mergeLimits
 * @returns {{ info: ShellInfo, update(names: unknown): void, limits: typeof LIMITS }}
 */
function createInfo(limitsOver) {
	const limits = mergeLimits(limitsOver);
	let commands = /** @type {string[]} */ (PROGRAMS.slice());
	let have = new Set(commands);
	const info = /** @type {ShellInfo} */ ({});
	Object.defineProperties(info, {
		label: { value: 'LevelCode Shell', enumerable: true },
		background: { value: false, enumerable: true },
		programs: { value: false, enumerable: true },
		network: { value: false, enumerable: true },
		commands: { get() { return commands.slice(); }, enumerable: true },
		missing: { get() { return MISSING.filter((n) => !have.has(n)); }, enumerable: true },
		limits: {
			value: Object.freeze({
				commandCount: limits.engine.maxCommandCount, loopIterations: limits.engine.maxLoopIterations,
				callDepth: limits.engine.maxCallDepth, outputBytes: limits.engine.maxOutputSize,
				fileReadBytes: limits.read.file, runReadBytes: limits.read.run,
			}),
			enumerable: true,
		},
	});
	return {
		info,
		limits,
		/** Take the engine's list. Anything that is not a list of plain names is ignored: the old list stays. */
		update(names) {
			if (!Array.isArray(names)) { return; }
			const ok = names.filter((n) => typeof n === 'string' && n.length > 0 && n.length <= 64 && !/[\s\u{0}-\u{1F}\u{7F}]/u.test(n));
			if (ok.length === 0) { return; }
			commands = Array.from(new Set(ok)).sort();
			have = new Set(commands);
		},
	};
}

module.exports = { LIMITS, PROGRAMS, MISSING, BUILTINS, mergeLimits, createInfo, checkBudgetMs };
