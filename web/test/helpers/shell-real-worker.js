/*---------------------------------------------------------------------------------------------
 *  A REAL worker for web/shell/src/runtime.js, under plain node: the engine's protocol handler (engine/core.js
 *  over the patched just-bash) running in a node:worker_threads thread, behind the same four members a browser
 *  Worker has (postMessage, terminate, onmessage, onerror, onmessageerror).
 *
 *  Everything else in the runtime suites runs a fake engine, or the real one on the host's own thread. Neither
 *  can show what the design stands on: that `terminate()` ends a script that never yields while the host goes
 *  on, that a message really is structured-cloned and its buffers transferred, and that nothing is left alive.
 *  This does. It is the browser's Worker as far as node has one: not the browser (no Blob URL, no CSP, no
 *  nested worker inside an extension host), and the suite says so where it matters.
 *
 *      const real = createRealWorkers(engineDir);
 *      if (!real.available) { ...skip, loudly... }
 *      const runtime = createRuntime({ ..., createWorker: real.createWorker });
 *
 *  Test code only: nothing here is the product.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

const fs = require('fs');
const path = require('path');

/** What the worker thread runs: boot the engine, then speak the protocol on the parent port. */
const BOOT = `
const { parentPort, workerData } = require('worker_threads');
const { pathToFileURL } = require('url');
(async () => {
	const { loadEngine } = await import(pathToFileURL(workerData.engineDir + '/load.mjs').href);
	const { createCore } = require(workerData.engineDir + '/core.js');
	const Engine = await loadEngine();
	const core = createCore({ Engine, now: Date.now, post: (m, t) => parentPort.postMessage(m, t || []) });
	parentPort.on('message', (m) => { core.handle(m).catch(() => { }); });
	parentPort.postMessage({ t: '__booted' });
})().catch((e) => { parentPort.postMessage({ t: '__bootfailed', message: String(e && e.message || e) }); });
`;

/**
 * @param {string} engineDir  web/shell/engine
 * @returns {{
 *   available: boolean, why: string,
 *   createWorker: (source: string) => any,
 *   threads: Array<{ exited: boolean, thread: any, posts: number, transfers: number, lastDone: any }>,
 *   allExited: (ms: number) => Promise<boolean>,
 *   probe: () => Promise<boolean>
 * }}
 */
function createRealWorkers(engineDir) {
	/** @type {any} */ let wt = null;
	let why = '';
	try { wt = require('worker_threads'); } catch (e) { why = 'node:worker_threads is not available: ' + String((e && /** @type {any} */ (e).message) || e); }
	if (wt && !fs.existsSync(path.join(engineDir, 'load.mjs'))) { why = 'the engine is not in this tree (' + engineDir + ')'; }
	if (!why && !fs.existsSync(path.join(engineDir, 'core.js'))) { why = 'the engine is not in this tree (' + engineDir + ')'; }

	/** @type {Array<{ exited: boolean, thread: any, posts: number, transfers: number, lastDone: any }>} */
	const threads = [];

	/** @param {string} _source the engine script a browser would have been given: not used, the thread loads the engine from its files */
	function createWorker(_source) {
		const thread = new wt.Worker(BOOT, { eval: true, workerData: { engineDir } });
		const rec = { exited: false, thread, posts: 0, transfers: 0, lastDone: /** @type {any} */ (null) };
		threads.push(rec);
		/** @type {any} */
		const shim = {
			onmessage: null, onerror: null, onmessageerror: null, terminated: false, booted: false, queue: /** @type {any[]} */ ([]),
			postMessage(/** @type {any} */ m, /** @type {any[]} */ transfer) {
				rec.posts++;
				rec.transfers += transfer ? transfer.length : 0;
				if (shim.terminated) { return; }
				if (!shim.booted) { shim.queue.push([m, transfer]); return; }
				thread.postMessage(m, transfer || []);
			},
			terminate() { shim.terminated = true; thread.terminate(); },
		};
		thread.on('message', (/** @type {any} */ d) => {
			if (d && d.t === '__booted') {
				shim.booted = true;
				for (const [m, t] of shim.queue.splice(0)) { thread.postMessage(m, t || []); }
				return;
			}
			if (d && d.t === '__bootfailed') {
				if (typeof shim.onerror === 'function') { shim.onerror({ message: 'the engine did not boot: ' + d.message, preventDefault() { } }); }
				return;
			}
			if (d && d.t === 'done') { rec.lastDone = d; }
			if (typeof shim.onmessage === 'function') { shim.onmessage({ data: d }); }
		});
		thread.on('error', (/** @type {any} */ e) => { if (typeof shim.onerror === 'function') { shim.onerror({ message: e && e.message, preventDefault() { } }); } });
		thread.on('messageerror', () => { if (typeof shim.onmessageerror === 'function') { shim.onmessageerror({}); } });
		thread.on('exit', () => { rec.exited = true; });
		return shim;
	}

	/** Can a thread be started here, and does it answer? Not asked of the engine: a bare worker, five seconds at most. */
	function probe() {
		if (why) { return Promise.resolve(false); }
		return new Promise((resolve) => {
			let t;
			try {
				const w = new wt.Worker('require("worker_threads").parentPort.postMessage("up")', { eval: true });
				const done = (/** @type {boolean} */ ok, /** @type {string} */ reason) => { clearTimeout(t); if (!ok) { why = reason; } w.terminate(); resolve(ok); };
				t = setTimeout(() => done(false, 'a worker thread did not start within 5 s'), 5000);
				w.on('message', () => done(true, ''));
				w.on('error', (/** @type {any} */ e) => done(false, 'a worker thread failed to start: ' + String((e && e.message) || e)));
			} catch (e) {
				why = 'a worker thread cannot be created: ' + String((e && /** @type {any} */ (e).message) || e);
				resolve(false);
			}
		});
	}

	return {
		get available() { return why === ''; },
		get why() { return why; },
		createWorker,
		threads,
		/** Resolves true when every thread made so far has exited, false after `ms`. */
		allExited(ms) {
			return new Promise((resolve) => {
				const t0 = Date.now();
				const tick = () => {
					if (threads.every((x) => x.exited)) { resolve(true); return; }
					if (Date.now() - t0 > ms) { resolve(false); return; }
					setTimeout(tick, 10);
				};
				tick();
			});
		},
		probe,
	};
}

module.exports = { createRealWorkers };
