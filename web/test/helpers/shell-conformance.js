/*---------------------------------------------------------------------------------------------
 *  Does this `spawn` behave as the ChildLike contract says? (README section 3; levelcode-ai/host.js ChildLike.)
 *
 *  agent.js's runCommand is written against a Node ChildProcess and uses a small part of one. A shell that is
 *  simulated has to keep every promise that part relies on, and each promise is a rule here:
 *
 *    shape      stdout.on / stderr.on / on / kill are functions; pid is undefined (agent.js then kills with kill())
 *    strings    every 'data' chunk is a string (agent.js calls toString(); a Uint8Array would print as 1,2,3)
 *    close      exactly once, with a non-negative integer status; nothing is emitted after it
 *    order      'close' comes after every 'data', and after the commit callback returned
 *    kill       true while the run is going, idempotent, false once it has closed; a killed run closes once
 *    never      spawn does not throw for a bad cwd, a non-string command or missing options: it is stderr + close(1)
 *
 *  Used by shell-runtime.test.js on the real runtime against a fake engine; written so levelcode-ai's own tests
 *  can run it on whatever shell they register (host.registerShell) with their own command strings:
 *
 *      const { checkChildLike } = require('<repo>/web/test/helpers/shell-conformance.js');
 *      await checkChildLike(shell.spawn, { cwd: '/proj', ok: { command: 'echo hi', stdout: 'hi' }, ... });
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

const assert = require('assert');

/**
 * @typedef {object} Observation
 * @property {Array<{ type: 'data', stream: 'stdout'|'stderr', chunk: unknown } | { type: 'close', code: unknown }>} events
 * @property {string} stdout   the chunks that were strings, joined
 * @property {string} stderr
 * @property {Promise<void>} closed   resolves at the first 'close' (rejects on timeout)
 */

/**
 * Attach to a child the way runCommand does and record what happens.
 * @param {any} child
 * @param {number} [timeoutMs]
 * @param {string[]} [log]   a shared list that gets 'data' and 'close' in the order they happen
 * @returns {Observation}
 */
function observe(child, timeoutMs, log) {
	/** @type {Observation} */
	const obs = { events: [], stdout: '', stderr: '', closed: /** @type {any} */ (null) };
	obs.closed = new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error('the child never closed (' + (timeoutMs || 5000) + ' ms)')), timeoutMs || 5000);
		child.stdout.on('data', (/** @type {unknown} */ chunk) => { obs.events.push({ type: 'data', stream: 'stdout', chunk }); if (log) { log.push('data'); } if (typeof chunk === 'string') { obs.stdout += chunk; } });
		child.stderr.on('data', (/** @type {unknown} */ chunk) => { obs.events.push({ type: 'data', stream: 'stderr', chunk }); if (log) { log.push('data'); } if (typeof chunk === 'string') { obs.stderr += chunk; } });
		child.on('close', (/** @type {unknown} */ code) => { obs.events.push({ type: 'close', code }); if (log) { log.push('close'); } clearTimeout(timer); resolve(); });
	});
	obs.closed.catch(() => { /* reported by whoever awaits it */ });
	return obs;
}

/** Let a closed child show whether it misbehaves afterwards (a second close, a late chunk). */
function settle() { return new Promise((r) => setTimeout(r, 15)); }

/**
 * The rules that hold for ANY finished child.
 * @param {Observation} obs @param {string} what
 */
function assertWellFormed(obs, what) {
	const closes = obs.events.filter((e) => e.type === 'close');
	assert.strictEqual(closes.length, 1, what + ': close must fire exactly once, fired ' + closes.length + ' times');
	const code = /** @type {any} */ (closes[0]).code;
	assert.ok(Number.isInteger(code) && code >= 0, what + ': close code must be a non-negative integer, got ' + String(code));
	const at = obs.events.findIndex((e) => e.type === 'close');
	assert.strictEqual(at, obs.events.length - 1, what + ': nothing may be emitted after close (' + (obs.events.length - 1 - at) + ' events were)');
	for (const e of obs.events) {
		if (e.type === 'data') { assert.strictEqual(typeof e.chunk, 'string', what + ': a ' + e.stream + ' chunk was ' + (e.chunk && /** @type {any} */ (e.chunk).constructor ? /** @type {any} */ (e.chunk).constructor.name : typeof e.chunk) + ', not a string'); }
	}
	return /** @type {number} */ (code);
}

/**
 * @typedef {object} Spec
 * @property {string} cwd                          a folder the shell under test has mounted
 * @property {{ command: string, stdout?: string, stderr?: string }} ok    exits 0
 * @property {{ command: string }} [failing]       exits non-zero
 * @property {{ command: string }} [noisy]         prints at least two chunks and exits 0
 * @property {{ command: string }} [slow]          is still running when kill() is called
 * @property {{ command: string, result?: object }} [commit]
 *     a command that changes files. It is run with a `commit` of the harness's own, which the shell must call
 *     exactly once, with a list of changes, before it closes; `result` is what the callback answers
 * @property {() => object} [opts]                 further options for every spawn (env, folders...); cwd is added
 * @property {number} [timeoutMs]
 *
 * @param {(command: string, opts: any) => any} spawn
 * @param {Spec} spec
 * @returns {Promise<string[]>} the rules that were checked, by name
 */
async function checkChildLike(spawn, spec) {
	/** @type {string[]} */ const checked = [];
	const opts = (/** @type {object} */ extra) => Object.assign({ cwd: spec.cwd }, spec.opts ? spec.opts() : {}, extra || {});
	const t = spec.timeoutMs;

	// shape, strings, close, order, no output after close
	const child = spawn(spec.ok.command, opts());
	assert.ok(child && typeof child === 'object', 'spawn must return an object');
	for (const [name, fn] of /** @type {Array<[string, unknown]>} */ ([
		['stdout.on', child.stdout && child.stdout.on], ['stderr.on', child.stderr && child.stderr.on], ['on', child.on], ['kill', child.kill],
	])) { assert.strictEqual(typeof fn, 'function', 'shape: ' + name + ' must be a function'); }
	assert.strictEqual(child.pid, undefined, 'shape: pid must be undefined, so agent.js kills with child.kill()');
	checked.push('shape');
	const obs = observe(child, t);
	await obs.closed;
	await settle();
	const code = assertWellFormed(obs, 'ok command');
	checked.push('strings', 'close', 'order');
	assert.strictEqual(code, 0, 'ok command: exit status must be 0, got ' + code + '\nstderr: ' + obs.stderr);
	if (spec.ok.stdout !== undefined) { assert.ok(obs.stdout.includes(spec.ok.stdout), 'ok command: stdout must include ' + JSON.stringify(spec.ok.stdout) + ', got ' + JSON.stringify(obs.stdout)); }
	if (spec.ok.stderr !== undefined) { assert.ok(obs.stderr.includes(spec.ok.stderr), 'ok command: stderr must include ' + JSON.stringify(spec.ok.stderr) + ', got ' + JSON.stringify(obs.stderr)); }
	checked.push('exit status');

	// kill after close
	assert.strictEqual(child.kill('SIGTERM'), false, 'kill: after close it must return false');
	assert.strictEqual(child.kill('SIGKILL'), false, 'kill: after close it must keep returning false');
	await settle();
	assertWellFormed(obs, 'after kill-after-close');
	checked.push('kill after close');

	if (spec.failing) {
		const c = spawn(spec.failing.command, opts());
		const o = observe(c, t);
		await o.closed;
		await settle();
		assert.ok(assertWellFormed(o, 'failing command') > 0, 'failing command: the status must not be 0');
		checked.push('failing status');
	}

	if (spec.noisy) {
		const c = spawn(spec.noisy.command, opts());
		const o = observe(c, t);
		await o.closed;
		await settle();
		assertWellFormed(o, 'noisy command');
		checked.push('output before close');
	}

	if (spec.commit) {
		/** @type {string[]} */ const log = [];
		/** @type {any[]} */ const calls = [];
		const commit = async (/** @type {any} */ changes) => {
			log.push('commit');
			calls.push(changes);
			return spec.commit && spec.commit.result ? spec.commit.result : { rest: [], notes: [], failed: 0 };
		};
		const c = spawn(spec.commit.command, opts({ commit }));
		const o = observe(c, t, log);
		await o.closed;
		await settle();
		assertWellFormed(o, 'command with changes');
		assert.strictEqual(calls.length, 1, 'commit: the callback must be called exactly once, was called ' + calls.length + ' times');
		assert.ok(Array.isArray(calls[0]) && calls[0].every((/** @type {any} */ x) => x && typeof x.path === 'string' && typeof x.kind === 'string'), 'commit: it must be given a list of changes, each with a kind and a path');
		assert.ok(log.indexOf('commit') >= 0 && log.indexOf('commit') < log.lastIndexOf('close'), 'commit: it must be called before close, order was ' + log.join(','));
		checked.push('commit once, before close');
	}

	if (spec.slow) {
		const c = spawn(spec.slow.command, opts());
		const o = observe(c, t);
		await new Promise((r) => setTimeout(r, 5));
		assert.strictEqual(c.kill('SIGTERM'), true, 'kill: while the command runs it must return true');
		let again;
		assert.doesNotThrow(() => { again = c.kill('SIGKILL'); }, 'kill: a second kill must not throw');
		assert.strictEqual(typeof again, 'boolean', 'kill: a second kill must return a boolean');
		await o.closed;
		await settle();
		assertWellFormed(o, 'killed command');
		assert.strictEqual(c.kill('SIGKILL'), false, 'kill: after the killed command closed it must return false');
		checked.push('kill', 'kill idempotent', 'killed command closes once');
	}

	// never throws
	/** @type {Array<[string, () => any]>} */
	const bad = [
		['a working directory in no folder', () => spawn(spec.ok.command, opts({ cwd: '/nowhere/at/all' }))],
		['a non-string command', () => spawn(/** @type {any} */ (undefined), opts())],
		['no options', () => spawn(spec.ok.command, /** @type {any} */ (undefined))],
		['null options', () => spawn(spec.ok.command, /** @type {any} */ (null))],
	];
	for (const [name, make] of bad) {
		/** @type {any} */ let c;
		assert.doesNotThrow(() => { c = make(); }, 'never throws: spawn threw for ' + name);
		const o = observe(c, t);
		await o.closed;
		await settle();
		assert.ok(assertWellFormed(o, name) > 0, 'never throws: ' + name + ' must end with a non-zero status');
		assert.ok(o.stderr.length > 0, 'never throws: ' + name + ' must say what went wrong on stderr');
	}
	checked.push('never throws');
	return checked;
}

module.exports = { checkChildLike, observe, assertWellFormed };
