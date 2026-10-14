/*---------------------------------------------------------------------------------------------
 *  LevelCode Shell - the extension's entry: wires the runtime to this extension host and to the editor.
 *
 *  Small on purpose. The logic is in runtime.js (engine workers, file-system RPC, commit), commit.js, info.js
 *  and sanitize.js, all of which run under plain node; this file is only what has to be done with `vscode`
 *  and the browser's own Worker, which a unit test cannot stand in for.
 *
 *  Activation has no events (package.json): levelcode-ai activates the extension through
 *  getExtension(...).activate() the first time a run wants a shell, and the contributed commands and the
 *  terminal profile activate it implicitly. So nothing here may be needed before that.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

const vscode = require('vscode');
const { createRuntime } = require('./runtime');
const { forDisplay, safeMessage } = require('./sanitize');

/** The engine worker's script, next to this extension's package.json (the build puts it there). */
const ENGINE_ASSET = 'engine.worker.js';
/** Routine events are not worth an Output channel; only what a person might need to report is written to it. */
const QUIET = new Set(['worker-spawned', 'worker-terminated']);
const MAX_LOG_LINES = 200;

/** @type {{ dispose(): void } | null} */
let current = null;

/** A nested classic Worker can be made from a Blob here (CSP worker-src blob:, and the browser allows it). */
function canMakeWorkers() {
	return typeof Worker === 'function' && typeof Blob === 'function' && typeof URL === 'function' && typeof URL.createObjectURL === 'function';
}

/**
 * The engine's Worker, from a Blob URL of its script. One URL serves every worker started from the same script
 * (about 1.3 MB: made once) and is released with the extension.
 * @param {vscode.ExtensionContext} context
 * @param {(event: string, data?: any) => void} log
 */
function createProductionDeps(context, log) {
	/** @type {string|null} */ let url = null;
	/** @type {string|null} */ let urlSource = null;
	const release = () => {
		if (url !== null) { try { URL.revokeObjectURL(url); } catch { /* already gone */ } }
		url = null; urlSource = null;
	};
	return {
		release,
		deps: {
			vscode,
			async loadEngineSource() {
				const uri = vscode.Uri.joinPath(context.extensionUri, ENGINE_ASSET);
				/** @type {Uint8Array} */ let bytes;
				try {
					bytes = await vscode.workspace.fs.readFile(uri);
				} catch (e) {
					// The extension's own folder is an http(s) address in a tab. If this host has no file-system
					// provider for it (not measured: only the scratch scheme was driven), it is still a static
					// file of this origin, and fetch reads it. Both reasons are kept when both fail.
					if (typeof fetch !== 'function') { throw e; }
					const said = (/** @type {any} */ x) => safeMessage(x, 300);
					try {
						const r = await fetch(uri.toString());
						if (!r.ok) { throw new Error('status ' + r.status); }
						bytes = new Uint8Array(await r.arrayBuffer());
					} catch (e2) {
						throw new Error(said(e) + '; fetching ' + ENGINE_ASSET + ' instead failed too: ' + said(e2));
					}
				}
				return new TextDecoder('utf-8').decode(bytes);
			},
			/** @param {string} source */
			createWorker(source) {
				if (!canMakeWorkers()) { throw new Error('this browser cannot start the shell engine (no workers from a Blob)'); }
				if (url === null || urlSource !== source) {
					release();
					url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
					urlSource = source;
				}
				return new Worker(url, { name: 'levelcode-shell-engine' });
			},
			now: () => Date.now(),
			setTimeout: (/** @type {() => void} */ fn, /** @type {number} */ ms) => setTimeout(fn, ms),
			clearTimeout: (/** @type {any} */ h) => clearTimeout(h),
			log,
		},
	};
}

/** @param {vscode.ExtensionContext} context */
function activate(context) {
	/** @type {vscode.OutputChannel|null} */ let channel = null;
	let lines = 0;
	const log = (/** @type {string} */ event, /** @type {any} */ data) => {
		if (QUIET.has(event) || lines >= MAX_LOG_LINES) { return; }
		try {
			channel = channel || vscode.window.createOutputChannel('LevelCode Shell');
			channel.appendLine(event + (data === undefined ? '' : ' ' + JSON.stringify(data)));
			lines++;
		} catch { /* logging is never the reason a command fails */ }
	};

	const production = createProductionDeps(context, log);
	const runtime = createRuntime(production.deps);

	/** @type {{ dispose(): void } | null} */ let terminal = null;
	try {
		// A missing or broken terminal is no terminal, not a shell that fails to activate: the agent's run_command
		// does not depend on it.
		terminal = require('./terminal').createTerminalSupport({
			vscode, runtime, context, config: { info: runtime.info, limits: runtime.limits },
		});
	} catch (e) {
		log('terminal-unavailable', { message: safeMessage(e, 300) });
	}

	const disposable = {
		dispose() {
			if (current === disposable) { current = null; }
			try { if (terminal) { terminal.dispose(); } } catch { /* on the way out */ }
			runtime.dispose();
			production.release();
			if (channel) { channel.dispose(); }
		},
	};
	current = disposable;
	context.subscriptions.push(disposable);

	// Without workers there is no engine, and no shell to offer the agent (it then keeps its tools withheld).
	if (!canMakeWorkers()) { return { apiVersion: 1 }; }
	return {
		apiVersion: 1,
		agent: {
			info: runtime.info,
			spawn: (/** @type {string} */ command, /** @type {any} */ opts) => runtime.spawnAgent(command, opts),
			// What the model wrote reaches an approval card and the terminal's history as text a person reads, not as
			// something a terminal or a bidi-aware renderer obeys: host.displaySafe() is this when it is present.
			forDisplay,
		},
	};
}

function deactivate() {
	if (current) { current.dispose(); }
}

module.exports = { activate, deactivate };
