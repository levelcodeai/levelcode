/*---------------------------------------------------------------------------------------------
 *  web/shell/src/extension.js - run: node web/test/unit/shell-runtime-extension.test.js
 *
 *  The entry is small, and this pins what it must do with `vscode` and the browser's Worker:
 *    - activate() starts NOTHING (no worker, no read of the engine script): it is activated by levelcode-ai's
 *      first run or by a command, and the visitor may never run a command;
 *    - it returns README section 3's API, and only that;
 *    - a terminal module that is missing, or breaks, is no terminal - never a failed activation;
 *    - the engine's Worker is made from a Blob URL of the script read through workspace.fs from the extension's
 *      own folder, one URL for all workers of one script, revoked with the extension;
 *    - without workers there is no `agent` in the API, so levelcode-ai keeps its shell tools withheld.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

// A promise that never settles ends the process with status 0 and no output: a suite that did not finish fails.
let finished = false;
process.on('exit', (code) => { if (!finished && code === 0) { console.error('not ok - the tests did not finish'); process.exitCode = 1; } });

const assert = require('assert');
const path = require('path');
const Module = require('module');

const { flush } = require(path.join(__dirname, '..', 'helpers', 'shell-runtime-fakes.js'));
const { observe } = require(path.join(__dirname, '..', 'helpers', 'shell-conformance.js'));

const EXT = path.join(__dirname, '..', '..', 'shell', 'src', 'extension.js');

/* ----- the stand-ins ---------------------------------------------------------------------------- */

/** @type {any} */ let terminalModule;
/** @type {{ reads: string[], channels: any[], workers: any[], urls: string[], revoked: string[], blobs: any[] }} */
let seen;
const SCRIPT = '/* the engine: caf\u{E9} \u{65E5}\u{672C} \u{1F680} */ self.onmessage = function () {};';

class FakeWorker {
	constructor(/** @type {string} */ url, /** @type {any} */ opts) {
		this.url = url; this.opts = opts; this.terminated = false; this.onmessage = null; this.onerror = null; this.sent = [];
		seen.workers.push(this);
	}
	postMessage(/** @type {any} */ m) {
		this.sent.push(m);
		Promise.resolve().then(() => {
			if (this.terminated || !this.onmessage) { return; }
			if (m.t === 'init') { this.onmessage({ data: { t: 'ready', gen: m.gen, commands: ['echo'] } }); }
			if (m.t === 'run') { this.onmessage({ data: { t: 'out', id: m.id, stream: 'stdout', text: 'ran ' + m.script + '\n' } }); this.onmessage({ data: { t: 'done', id: m.id, exitCode: 0, how: 'exit', cwd: m.cwd, env: {}, changes: [], denied: [], notes: [] } }); }
		});
	}
	terminate() { this.terminated = true; }
}

function installGlobals(/** @type {{ workers: boolean }} */ o) {
	/** @type {any} */ const g = globalThis;
	g.__saved = { Worker: g.Worker, Blob: g.Blob, createObjectURL: URL.createObjectURL, revokeObjectURL: URL.revokeObjectURL };
	if (o.workers) { g.Worker = FakeWorker; } else { delete g.Worker; }
	URL.createObjectURL = (/** @type {any} */ blob) => { const u = 'blob:fake/' + seen.urls.length; seen.urls.push(u); seen.blobs.push(blob); return u; };
	URL.revokeObjectURL = (/** @type {string} */ u) => { seen.revoked.push(u); };
}
function restoreGlobals() {
	/** @type {any} */ const g = globalThis;
	const s = g.__saved;
	if (s.Worker) { g.Worker = s.Worker; } else { delete g.Worker; }
	URL.createObjectURL = s.createObjectURL;
	URL.revokeObjectURL = s.revokeObjectURL;
}

/** @param {any} base @param {string[]} p */
const joinPath = (base, ...p) => ({ base, parts: p, toString: () => 'ext://' + p.join('/') });
const Uri = { joinPath };
const vscodeMock = {
	Uri,
	window: { createOutputChannel(/** @type {string} */ name) { const c = { name, lines: /** @type {string[]} */ ([]), disposed: false, appendLine(/** @type {string} */ l) { c.lines.push(l); }, dispose() { c.disposed = true; } }; seen.channels.push(c); return c; } },
	workspace: {
		workspaceFolders: [{ name: 'scratch', uri: { scheme: 'levelcode-scratch', path: '/scratch', with(/** @type {any} */ c) { return Object.assign({}, this, c); }, toString() { return 'levelcode-scratch:///scratch'; } } }],
		onDidChangeWorkspaceFolders() { return { dispose() { } }; },
		fs: { async readFile(/** @type {any} */ u) { seen.reads.push(String(u)); return new TextEncoder().encode(SCRIPT); } },
	},
};
// The runtime parses folder URIs with vscode.Uri.parse.
/** @type {any} */ (vscodeMock.Uri).parse = (/** @type {string} */ s) => ({ scheme: 'levelcode-scratch', path: '/scratch', toString: () => s, with(/** @type {any} */ c) { return Object.assign({}, this, c); } });

/** @type {any} */ const M = Module;
const origLoad = M._load;
M._load = function (/** @type {string} */ request, /** @type {any} */ parent, /** @type {boolean} */ isMain) {
	if (request === 'vscode') { return vscodeMock; }
	if (request === './terminal' && parent && parent.filename === EXT) {
		if (terminalModule instanceof Error) { throw terminalModule; }
		return terminalModule;
	}
	return origLoad.call(this, request, parent, isMain);
};

function fresh() { delete require.cache[EXT]; return require(EXT); }
function context() { return { subscriptions: /** @type {any[]} */ ([]), extensionUri: { path: '/ext/levelcode-shell', toString: () => 'vscode-extension://levelcode-shell' } }; }

let n = 0;
async function test(/** @type {string} */ name, /** @type {(ext: any) => Promise<void>} */ fn, /** @type {{ workers?: boolean }} */ o = {}) {
	seen = { reads: [], channels: [], workers: [], urls: [], revoked: [], blobs: [] };
	installGlobals({ workers: o.workers !== false });
	terminalModule = { createTerminalSupport() { return { dispose() { } }; } };
	try { await fn(fresh()); } finally { restoreGlobals(); }
	n++;
	console.log('  ok - ' + name);
}

(async () => {
	await test('activate starts nothing: no worker, no read of the engine script, no Output channel, no timer left behind', async (ext) => {
		const ctx = context();
		const api = ext.activate(ctx);
		await flush();
		assert.deepStrictEqual(seen.workers, []);
		assert.deepStrictEqual(seen.reads, []);
		assert.deepStrictEqual(seen.channels, []);
		assert.strictEqual(ctx.subscriptions.length, 1);
		ext.deactivate();
		assert.ok(api);
	});

	await test('the API is README section 3 and no more: apiVersion 1, agent { info, spawn, forDisplay }', async (ext) => {
		const api = ext.activate(context());
		assert.deepStrictEqual(Object.keys(api).sort(), ['agent', 'apiVersion']);
		assert.strictEqual(api.apiVersion, 1);
		assert.deepStrictEqual(Object.keys(api.agent).sort(), ['forDisplay', 'info', 'spawn']);
		assert.strictEqual(api.agent.info.label, 'LevelCode Shell');
		assert.strictEqual(api.agent.info.background, false);
		assert.strictEqual(typeof api.agent.spawn, 'function');
		ext.deactivate();
	});

	await test('agent.forDisplay is the sanitiser levelcode-ai shows a model-written command through: no control or bidi character survives', async (ext) => {
		const api = ext.activate(context());
		const shown = api.agent.forDisplay('echo a\u001b[31mb\u202ec\u0007d\nrm x');
		assert.strictEqual(typeof shown, 'string');
		assert.ok(!/[\u0000-\u0009\u000b-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(shown), JSON.stringify(shown));
		assert.ok(shown.includes('echo a') && shown.includes('rm x'), 'the text itself stays readable: ' + JSON.stringify(shown));
		assert.strictEqual(api.agent.forDisplay('plain text'), 'plain text');
		ext.deactivate();
	});

	await test('the terminal gets { vscode, runtime, context, config }, with the runtime\'s whole surface, once', async (ext) => {
		const got = [];
		terminalModule = { createTerminalSupport(/** @type {any} */ o) { got.push(o); return { dispose() { got.push('disposed'); } }; } };
		const ctx = context();
		const api = ext.activate(ctx);
		assert.strictEqual(got.length, 1);
		const o = got[0];
		assert.deepStrictEqual(Object.keys(o).sort(), ['config', 'context', 'runtime', 'vscode']);
		assert.strictEqual(o.vscode, vscodeMock);
		assert.strictEqual(o.context, ctx);
		for (const f of ['folders', 'mounts', 'resolve', 'stat', 'createSession', 'onAgentRun', 'spawnAgent', 'dispose']) { assert.strictEqual(typeof o.runtime[f], 'function', f); }
		assert.strictEqual(o.config.info, api.agent.info, 'one ShellInfo, the same the agent reads');
		assert.strictEqual(o.config.limits.workers.max, 4);
		ext.deactivate();
		assert.deepStrictEqual(got.slice(1), ['disposed']);
	});

	await test('a terminal module that is missing or broken is no terminal, not a failed activation - and the reason is in the Output channel', async (ext) => {
		for (const failure of [Object.assign(new Error('Cannot find module \'./terminal\''), { code: 'MODULE_NOT_FOUND' }), new Error('syntax error in terminal')]) {
			terminalModule = failure;
			const e = fresh();
			const api = e.activate(context());
			assert.strictEqual(api.apiVersion, 1);
			assert.ok(api.agent && typeof api.agent.spawn === 'function', 'the agent\'s shell does not depend on the terminal');
			e.deactivate();
		}
		terminalModule = { createTerminalSupport() { throw new Error('profile provider already registered'); } };
		const api = fresh().activate(context());
		assert.ok(api.agent);
		assert.strictEqual(seen.channels.length, 3);
		assert.ok(seen.channels.every((c) => c.lines.length === 1 && /^terminal-unavailable /.test(c.lines[0])), JSON.stringify(seen.channels.map((c) => c.lines)));
		assert.ok(/profile provider already registered/.test(seen.channels[2].lines[0]));
		void ext;
	});

	await test('a terminal that fails with something hostile (a message that is a throwing getter), and a script load that fails the same way, are reasons and not exceptions', async (ext) => {
		const hostile = () => Object.defineProperty({}, 'message', { get() { throw new Error('getter-boom'); } });
		terminalModule = { createTerminalSupport() { throw hostile(); } };
		let api;
		assert.doesNotThrow(() => { api = fresh().activate(context()); });
		assert.ok(/** @type {any} */ (api).agent, 'the agent\'s shell does not depend on the terminal');
		assert.ok(seen.channels.length === 1 && /^terminal-unavailable \{"message":"[^"]+"\}$/.test(seen.channels[0].lines[0]), JSON.stringify(seen.channels.map((c) => c.lines)));
		// the script cannot be read, and the address cannot be fetched either, and both say it in the worst way
		const savedRead = vscodeMock.workspace.fs.readFile;
		/** @type {any} */ const g = globalThis;
		const savedFetch = g.fetch;
		vscodeMock.workspace.fs.readFile = async () => { throw hostile(); };
		g.fetch = async () => { throw hostile(); };
		try {
			const api2 = ext.activate(context());
			const o = observe(api2.agent.spawn('a', { cwd: '/scratch', folders: [{ name: 'scratch', root: '/scratch', uri: 'levelcode-scratch:///scratch' }] }), 3000);
			await o.closed;
			assert.strictEqual(/** @type {any} */ (o.events[o.events.length - 1]).code, 1);
			assert.ok(/fetching engine\.worker\.js instead failed too: /.test(o.stderr), o.stderr);
		} finally { vscodeMock.workspace.fs.readFile = savedRead; if (savedFetch) { g.fetch = savedFetch; } else { delete g.fetch; } }
		ext.deactivate();
	});

	await test('a worker that fails is written to the Output channel (routine start and stop are not): support can see a pattern', async (ext) => {
		const api = ext.activate(context());
		const folders = [{ name: 'scratch', root: '/scratch', uri: 'levelcode-scratch:///scratch' }];
		const first = observe(api.agent.spawn('echo a', { cwd: '/scratch', folders }), 3000);
		await first.closed;
		assert.deepStrictEqual(seen.channels, [], 'a worker that started and was reused writes nothing');
		// the engine dies under the next run
		const originalPost = FakeWorker.prototype.postMessage;
		FakeWorker.prototype.postMessage = function (/** @type {any} */ m) {
			if (m.t === 'init') { Promise.resolve().then(() => this.onmessage({ data: { t: 'ready', gen: m.gen, commands: ['echo'] } })); }
			if (m.t === 'run') { Promise.resolve().then(() => this.onerror({ message: 'out of memory', preventDefault() { } })); }
		};
		try {
			ext.deactivate();
			const api2 = fresh().activate(context());
			const o = observe(api2.agent.spawn('echo b', { cwd: '/scratch', folders }), 3000);
			await o.closed;
			assert.strictEqual(/** @type {any} */ (o.events[o.events.length - 1]).code, 1);
			assert.strictEqual(seen.channels.length, 1);
			const lines = seen.channels[0].lines;
			assert.strictEqual(lines.length, 1, lines.join('\n'));
			assert.ok(/^worker-failed /.test(lines[0]) && /out of memory/.test(lines[0]), lines[0]);
		} finally { FakeWorker.prototype.postMessage = originalPost; }
	});

	await test('the Output channel is bounded: after 200 lines it says nothing more', async (ext) => {
		const originalPost = FakeWorker.prototype.postMessage;
		FakeWorker.prototype.postMessage = function (/** @type {any} */ m) {
			if (m.t === 'init') { Promise.resolve().then(() => this.onmessage({ data: { t: 'ready', gen: m.gen, commands: ['echo'] } })); }
			if (m.t === 'run') { Promise.resolve().then(() => this.onerror({ message: 'out of memory #' + m.id, preventDefault() { } })); }
		};
		try {
			const api = ext.activate(context());
			const folders = [{ name: 'scratch', root: '/scratch', uri: 'levelcode-scratch:///scratch' }];
			for (let i = 0; i < 210; i++) { await observe(api.agent.spawn('x', { cwd: '/scratch', folders }), 3000).closed; }
			assert.strictEqual(seen.channels.length, 1);
			assert.strictEqual(seen.channels[0].lines.length, 200);
			assert.ok(seen.channels[0].lines.every((/** @type {string} */ l) => /^worker-failed /.test(l)), 'and only what is worth reporting was in it');
			ext.deactivate();
		} finally { FakeWorker.prototype.postMessage = originalPost; }
	});

	await test('without workers there is no `agent` in the API (the agent keeps its shell tools withheld); the terminal is still offered', async (ext) => {
		let created = 0;
		terminalModule = { createTerminalSupport() { created++; return { dispose() { } }; } };
		const api = ext.activate(context());
		assert.deepStrictEqual(api, { apiVersion: 1 });
		assert.strictEqual(created, 1);
		ext.deactivate();
	}, { workers: false });

	await test('the first run reads the engine script from the extension\'s own folder through workspace.fs and starts ONE worker from a Blob URL', async (ext) => {
		const api = ext.activate(context());
		const o = observe(api.agent.spawn('echo hi', { cwd: '/scratch', folders: [{ name: 'scratch', root: '/scratch', uri: 'levelcode-scratch:///scratch' }] }), 3000);
		await o.closed;
		assert.deepStrictEqual(seen.reads, ['ext://engine.worker.js']);
		assert.strictEqual(seen.urls.length, 1);
		assert.strictEqual(seen.blobs[0].type, 'text/javascript');
		assert.strictEqual(await seen.blobs[0].text(), SCRIPT);
		assert.strictEqual(seen.workers.length, 1);
		assert.strictEqual(seen.workers[0].url, seen.urls[0]);
		assert.deepStrictEqual(seen.workers[0].opts, { name: 'levelcode-shell-engine' });
		assert.strictEqual(o.stdout, 'ran echo hi\n');
		assert.strictEqual(/** @type {any} */ (o.events[o.events.length - 1]).code, 0);
		ext.deactivate();
	});

	await test('workers of one script share one Blob URL; the script is read once; deactivate terminates the workers and revokes the URL', async (ext) => {
		const api = ext.activate(context());
		const folders = [{ name: 'scratch', root: '/scratch', uri: 'levelcode-scratch:///scratch' }];
		// two at once: two workers (the first is busy), one script, one URL
		const a = observe(api.agent.spawn('a', { cwd: '/scratch', folders }), 3000);
		const b = observe(api.agent.spawn('b', { cwd: '/scratch', folders }), 3000);
		await Promise.all([a.closed, b.closed]);
		assert.strictEqual(seen.workers.length, 2);
		assert.strictEqual(seen.urls.length, 1);
		assert.deepStrictEqual(seen.reads.length, 1);
		assert.deepStrictEqual(seen.revoked, []);
		ext.deactivate();
		assert.ok(seen.workers.every((w) => w.terminated));
		assert.deepStrictEqual(seen.revoked, [seen.urls[0]]);
		ext.deactivate();
		assert.deepStrictEqual(seen.revoked, [seen.urls[0]], 'deactivating twice revokes once');
	});

	await test('disposing the subscription the editor holds is the same as deactivate', async (ext) => {
		const ctx = context();
		const api = ext.activate(ctx);
		const o = observe(api.agent.spawn('a', { cwd: '/scratch', folders: [{ name: 'scratch', root: '/scratch', uri: 'levelcode-scratch:///scratch' }] }), 3000);
		await o.closed;
		ctx.subscriptions[0].dispose();
		assert.ok(seen.workers.every((w) => w.terminated));
		assert.strictEqual(seen.revoked.length, 1);
		const after = observe(api.agent.spawn('b', { cwd: '/scratch' }), 3000);
		await after.closed;
		assert.ok(/shut down/.test(after.stderr), after.stderr);
	});

	await test('if workspace.fs cannot read the extension\'s folder, the script is fetched from the same address', async (ext) => {
		const api = ext.activate(context());
		const savedRead = vscodeMock.workspace.fs.readFile;
		/** @type {any} */ const g = globalThis;
		const savedFetch = g.fetch;
		/** @type {string[]} */ const fetched = [];
		vscodeMock.workspace.fs.readFile = async () => { throw new Error('no provider for https'); };
		g.fetch = async (/** @type {string} */ u) => { fetched.push(u); return { ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode(SCRIPT).buffer }; };
		try {
			const o = observe(api.agent.spawn('a', { cwd: '/scratch', folders: [{ name: 'scratch', root: '/scratch', uri: 'levelcode-scratch:///scratch' }] }), 3000);
			await o.closed;
			assert.deepStrictEqual(fetched, ['ext://engine.worker.js']);
			assert.strictEqual(/** @type {any} */ (o.events[o.events.length - 1]).code, 0);
			assert.strictEqual(await seen.blobs[0].text(), SCRIPT);
			// and a failing fetch is the reason, not a hang
			g.fetch = async () => ({ ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) });
			ext.deactivate();
			const api2 = fresh().activate(context());
			const o2 = observe(api2.agent.spawn('a', { cwd: '/scratch', folders: [{ name: 'scratch', root: '/scratch', uri: 'levelcode-scratch:///scratch' }] }), 3000);
			await o2.closed;
			assert.ok(/no provider for https; fetching engine\.worker\.js instead failed too: status 404/.test(o2.stderr), o2.stderr);
		} finally { vscodeMock.workspace.fs.readFile = savedRead; if (savedFetch) { g.fetch = savedFetch; } else { delete g.fetch; } }
	});

	await test('a script that cannot be read is an error with the reason on stderr: spawn does not throw and nothing is left half-started', async (ext) => {
		const api = ext.activate(context());
		const saved = vscodeMock.workspace.fs.readFile;
		vscodeMock.workspace.fs.readFile = async () => { throw new Error('Unable to read engine.worker.js (offline)'); };
		try {
			const o = observe(api.agent.spawn('a', { cwd: '/scratch', folders: [{ name: 'scratch', root: '/scratch', uri: 'levelcode-scratch:///scratch' }] }), 3000);
			await o.closed;
			assert.strictEqual(/** @type {any} */ (o.events[o.events.length - 1]).code, 1);
			assert.ok(/Unable to read engine\.worker\.js \(offline\)/.test(o.stderr), o.stderr);
			assert.deepStrictEqual(seen.workers, []);
			assert.deepStrictEqual(seen.urls, []);
		} finally { vscodeMock.workspace.fs.readFile = saved; }
		ext.deactivate();
	});

	// restore for whoever runs after us in the same process
	M._load = origLoad;
	finished = true;
	console.log(`\n${n} tests passed`);
})().catch((e) => { console.error(e); process.exit(1); });
