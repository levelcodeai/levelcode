/*---------------------------------------------------------------------------------------------
 *  web/shell/src/runtime.js, the commit of a finished run against a provider that is slow but alive, over many random
 *  sets - run: node web/test/unit/shell-runtime-commit-fuzz.test.js
 *
 *  The unit tests pin each rule of the commit once; this one pins what they must add up to, over 400 seeds of a
 *  set (new files, a scaffold of folders and files, edits, a mix with deletes and folders removed) of 3 to 400
 *  entries against a provider that answers every call after 0 to 400 ms of a fake clock - a third of the seeds
 *  exactly at, one under and one over the speed at which the check of that set runs out of its budget - with a
 *  Stop at a random moment in a third of the runs, and with levelcode-ai's review standing in for the commit in
 *  a third (applying one change per 10, 250 or 600 ms).
 *
 *    - the run ends, and a set is never HALF applied while the provider keeps answering: it is applied whole or
 *      refused whole with not one write made (the terminal's route: the check and the writing cannot cross);
 *    - an exit status of 0 with no note means that everything is on disk;
 *    - what a Stop confirmed as applied is on disk;
 *    - no call to the provider is STARTED after the run has ended, and no timer is left behind;
 *    - the agent's commit ends within commitMs, and a review that was given up on applies nothing more afterwards
 *      than the one change it had begun (it looks at cancelled() before each).
 *
 *  Deterministic: the same seeds make the same runs, and the clock is the fake one, so 400 runs take seconds.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

// A promise that never settles ends the process with status 0 and no output: a suite that did not finish fails.
let finished = false;
process.on('exit', (code) => { if (!finished && code === 0) { console.error('not ok - the tests did not finish'); process.exitCode = 1; } });

const assert = require('assert');
const path = require('path');

const { createRig, flush } = require(path.join(__dirname, '..', 'helpers', 'shell-runtime-fakes.js'));
const { LIMITS, checkBudgetMs } = require(path.join(__dirname, '..', '..', 'shell', 'src', 'info.js'));

const te = new TextEncoder();
const SEEDS = 400;

/** @param {number} seed a small, fixed pseudo-random generator (mulberry32) */
function rng(seed) {
	let s = seed >>> 0;
	return () => {
		s = (s + 0x6D2B79F5) >>> 0;
		let t = s;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}
/** @template T @param {() => number} r @param {T[]} list @returns {T} */
function pick(r, list) { return list[Math.floor(r() * list.length)]; }

const WRITES = /^(writeFile|createDirectory|delete) /;

/**
 * One seed. Returns the violations it found (empty: none) and what kind of run it was.
 * @param {number} seed
 */
async function runSeed(seed) {
	const r = rng(seed * 7919);
	const rig = createRig();
	const N = pick(r, [3, 20, 119, 121, 240, 400]);
	const mix = pick(r, ['new', 'scaffold', 'modify', 'mixed']);
	const review = r() < 0.35;
	const reviewMs = pick(r, [10, 250, 600]);
	const dirs = Math.max(1, Math.floor(N / 2));

	/** @type {any[]} */ const changes = [];
	/** Calls the check makes: a stat for each, and the bytes of what the command read. */
	let checkCalls = 0;
	for (let i = 0; i < N; i++) {
		const kind = mix === 'new' ? 'file' : mix === 'scaffold' ? (i < dirs ? 'dir' : 'file') : mix === 'modify' ? 'mod' : pick(r, ['file', 'dir', 'mod', 'del', 'rmdir']);
		checkCalls++;
		if (kind === 'dir') {
			changes.push({ kind: 'mkdir', path: '/scratch/d' + i });
		} else if (kind === 'rmdir') {
			rig.ws.mkdir('/scratch/r' + i);
			changes.push({ kind: 'rmdir', path: '/scratch/r' + i });
		} else if (kind === 'mod') {
			const p = '/scratch/m' + i + '.txt';
			rig.ws.put(p, 'old');
			changes.push({ kind: 'write', path: p, existed: true, before: te.encode('old'), after: te.encode('new') });
			checkCalls++;
		} else if (kind === 'del') {
			const p = '/scratch/x' + i + '.txt';
			rig.ws.put(p, 'old');
			changes.push({ kind: 'delete', path: p, before: te.encode('old') });
			checkCalls++;
		} else {
			const parent = mix === 'scaffold' ? '/scratch/d' + (i % dirs) : '/scratch';
			changes.push({ kind: 'write', path: parent + '/f' + i + '.txt', existed: false, before: null, after: te.encode('new') });
		}
	}
	// The speed at which the check of this set just passes, one under and one over; the others are round numbers.
	const edge = Math.floor(checkBudgetMs(LIMITS.workers, N) / checkCalls);
	const latency = r() < 0.34 ? Math.max(0, edge + pick(r, [-1, 0, 1])) : pick(r, [0, 5, 50, 100, 250, 400]);
	const stopAt = r() < 0.3 ? Math.floor(r() * 200000) : null;

	const tag = 'seed ' + seed + ' N=' + N + ' mix=' + mix + ' L=' + latency + ' ms' + (review ? ' review@' + reviewMs : '') + (stopAt !== null ? ' stop@' + stopAt : '');
	/** @type {string[]} */ const bad = [];
	/** @type {string[]} */ const started = [];
	rig.engines.state.onRun = async (run, w, h) => { h.done({ exitCode: 0, how: 'exit', changes }); };
	for (const op of ['stat', 'readFile', 'writeFile', 'createDirectory', 'delete']) {
		const real = /** @type {any} */ (rig.ws.fs)[op].bind(rig.ws.fs);
		/** @type {any} */ (rig.ws.fs)[op] = async (/** @type {any} */ ...a) => {
			started.push(op + ' ' + (a[0] && a[0].path));
			if (latency > 0) { await new Promise((res) => rig.clock.setTimeout(() => res(undefined), latency)); }
			return real(...a);
		};
	}

	/** @type {{ exitCode: number, how: string, applied: number|null, notes: string[] }|null} */ let res = null;
	let settledAt = -1;
	let startedAtSettle = -1;
	let lateWrites = 0;
	const t0 = rig.clock.now();
	const ended = (/** @type {any} */ x) => { res = x; settledAt = rig.clock.now(); startedAtSettle = started.length; };
	const session = rig.rt.createSession();
	if (review) {
		// An agent run whose review applies one change per `reviewMs` and looks at cancelled() before each, as levelcode-ai's does.
		let reviewApplied = 0;
		const commit = async (/** @type {any[]} */ chs, /** @type {{ cancelled(): boolean }} */ control) => {
			/** @type {any[]} */ const rest = [];
			for (const c of chs) {
				if (c.kind === 'mkdir' || c.kind === 'rmdir') { rest.push(c); continue; }
				if (control.cancelled()) { break; }
				await new Promise((res2) => rig.clock.setTimeout(() => res2(undefined), reviewMs));
				if (settledAt >= 0) { lateWrites++; }
				const u = rig.ws.vscode.Uri.parse('levelcode-scratch://' + c.path);
				if (c.kind === 'write') { await rig.ws.fs.writeFile(u, c.after); } else { await rig.ws.fs.delete(u, {}); }
				reviewApplied++;
			}
			return { rest, notes: [], failed: 0 };
		};
		let err = '';
		const child = rig.rt.spawnAgent('x', { cwd: '/scratch', commit });
		child.stderr.on('data', (/** @type {string} */ d) => { err += d; });
		child.on('close', (/** @type {number} */ code) => { ended({ exitCode: code, how: code === 130 || code === 137 ? 'aborted' : 'exit', applied: null, notes: err.split('\n').filter(Boolean) }); });
		if (stopAt !== null) { rig.clock.setTimeout(() => { child.kill('SIGTERM'); }, stopAt); }
	} else {
		session.run('x').then(ended);
		if (stopAt !== null) { rig.clock.setTimeout(() => { session.stop(); }, stopAt); }
	}
	await flush();
	// (a step of a second: a timer is run at its own time whatever the step, and the clock reads that time when the run ends)
	for (let i = 0; i < 2000 && res === null; i++) { await rig.clock.advance(1000); }
	if (res === null) {
		bad.push(tag + ': the run never ended in 2000 s');
		rig.rt.dispose();
		return { bad, kind: 'hung' };
	}
	const out = /** @type {{ exitCode: number, how: string, applied: number|null, notes: string[] }} */ (res);
	const took = settledAt - t0;
	await rig.clock.advance(600000);           // everything the provider was still doing, and whatever a late landing could change

	const text = out.notes.join('\n');
	const onDisk = changes.filter((c) => {
		if (c.kind === 'mkdir') { return rig.ws.isDir(c.path); }
		if (c.kind === 'rmdir') { return !rig.ws.exists(c.path); }
		if (c.kind === 'delete') { return !rig.ws.exists(c.path); }
		return rig.ws.text(c.path) === 'new';
	}).length;
	const wroteAnything = rig.ws.calls.some((c) => WRITES.test(c));
	const stopped = out.how === 'aborted';

	if (startedAtSettle >= 0 && started.length > startedAtSettle && !review) {
		bad.push(tag + ': ' + (started.length - startedAtSettle) + ' provider calls were started after the run ended (' + started.slice(startedAtSettle, startedAtSettle + 2).join(' | ') + ')');
	}
	if (!review && !stopped) {
		// The terminal's own route, never stopped, every call answered: whole or not at all.
		if (out.applied === N && out.exitCode === 0) {
			if (onDisk !== N) { bad.push(tag + ': ' + N + ' applied, ' + onDisk + ' on disk'); }
		} else if (/NONE of this command's file changes were applied/.test(text)) {
			if (onDisk !== 0 || wroteAnything) { bad.push(tag + ': refused whole, yet ' + onDisk + ' changes are on disk and ' + rig.ws.calls.filter((c) => WRITES.test(c)).length + ' writes were made'); }
		} else {
			bad.push(tag + ': half applied - applied ' + out.applied + ' of ' + N + ', ' + onDisk + ' on disk, exit ' + out.exitCode + ': ' + text.slice(0, 200));
		}
		// ...and the two never disagree: a set the check let through is a set the writing finishes
		const passed = latency <= edge;
		if (passed && out.applied !== N) { bad.push(tag + ': the check\'s own speed (' + edge + ' ms a call) passes, and the set was not applied: ' + text.slice(0, 160)); }
	}
	if (out.exitCode === 0 && out.notes.length === 0 && out.how === 'exit' && onDisk !== N && !review) {
		bad.push(tag + ': exit 0 and no note, but ' + (N - onDisk) + ' changes are not on disk');
	}
	if (stopped && !review && out.applied !== null && onDisk < out.applied) {
		bad.push(tag + ': a Stop said ' + out.applied + ' were applied, ' + onDisk + ' are on disk');
	}
	if (review) {
		if (stopAt === null && took > LIMITS.workers.commitMs) { bad.push(tag + ': the agent\'s commit took ' + took + ' ms; commitMs is ' + LIMITS.workers.commitMs); }
		// (the one change it had begun when the run ended is in flight: a review cannot be interrupted, and the note says it may land)
		if (lateWrites > 1) { bad.push(tag + ': the review applied ' + lateWrites + ' changes after the run had ended'); }
	}
	rig.rt.dispose();
	await rig.clock.advance(600000);
	if (rig.clock.pending !== 0) { bad.push(tag + ': ' + rig.clock.pending + ' timers left after dispose'); }
	return { bad, kind: review ? 'review' : stopped ? 'stopped' : /NONE of/.test(text) ? 'refused' : 'applied' };
}

(async () => {
	/** @type {string[]} */ const bad = [];
	/** @type {Record<string, number>} */ const kinds = {};
	const t0 = Date.now();
	for (let seed = 1; seed <= SEEDS; seed++) {
		const x = await runSeed(seed);
		bad.push(...x.bad);
		kinds[x.kind] = (kinds[x.kind] || 0) + 1;
	}
	assert.deepStrictEqual(bad.slice(0, 12), [], bad.length + ' of ' + SEEDS + ' seeds broke an invariant');
	// (the seeds must reach every kind of ending, or the invariants above are about nothing)
	for (const k of ['applied', 'refused', 'stopped', 'review']) { assert.ok((kinds[k] || 0) >= 10, 'too few ' + k + ' runs: ' + JSON.stringify(kinds)); }
	console.log('  ok - ' + SEEDS + ' seeded runs: ' + JSON.stringify(kinds) + ' in ' + (Date.now() - t0) + ' ms');
	finished = true;
	console.log(`\n1 tests passed`);
})().catch((e) => { console.error(e); process.exit(1); });
