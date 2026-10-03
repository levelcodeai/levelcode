/*---------------------------------------------------------------------------------------------
 *  An ended cloud session, as the OTHER callers of prepProviderRequest say it
 *  — run: node test/sessionExpiredCallers.test.js
 *
 *  Chat and the agent turn an ended LevelCode Cloud session into a sign-in card (that is
 *  sessionExpiredHost.test.js). Two more surfaces ask prepProviderRequest for a provider and word
 *  a refusal themselves, and neither knew the `signedOut` reason:
 *
 *    - inline edit (aiEdit.js) said "No API key set for LevelCode Cloud." — a key the user never
 *      needed and never had
 *    - Agent Sketch (sketch.js: Run, the board command, Generate flow) said "Provider not ready
 *      (signedOut)." or just "Provider not ready."
 *
 *  Both now say the session expired — the sentence chat and the agent send with 'session_expired',
 *  kept in providers/session.js — and the inline edit offers the sign-in next to it. Every other
 *  reason keeps the wording it had; that is pinned here too, being the other half of the change.
 *
 *  This RUNS both modules, for the reason sessionExpiredHost.test.js gives: the strings can all be
 *  present in code that never reaches them. Both require `vscode` at load, so a minimal mock goes
 *  in through the module loader, the way workspacePaths.test.js does it for agent.js. They are
 *  driven as the editor drives them — the registered command, the panel's message handler.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Module = require('module');
const { SESSION_EXPIRED_MESSAGE } = require('../providers/session');

const EXT_DIR = path.join(__dirname, '..');

// --- what the user is shown, and what they do about it -----------------------------------------
const ui = {
	/** @type {{message:string, items:string[]}[]} every error toast: its text and the buttons on it */
	errors: [],
	/** @type {string|undefined} the toast button the user presses; undefined dismisses the toast */
	press: undefined,
	/** @type {any[][]} */
	commands: []
};
/** @type {Map<string, Function>} */
const registered = new Map();
/** @type {any[]} */
const sketchPosted = [];
/** @type {(m:any) => Promise<void>} */
let sketchReceive = async () => { assert.fail('the Agent Sketch panel never subscribed to its webview'); };
const disposable = { dispose() { } };

// --- minimal vscode mock: only what the two modules touch between "invoked" and "request sent" ---
const vscodeMock = {
	ProgressLocation: { Notification: 15 },
	ViewColumn: { Active: -1 },
	Range: class { constructor(...a) { this.a = a; } },
	Uri: { parse: (s) => ({ scheme: String(s).split(':')[0], toString: () => String(s) }) },
	workspace: { registerTextDocumentContentProvider: () => disposable },
	commands: {
		registerCommand: (id, fn) => { registered.set(id, fn); return disposable; },
		executeCommand: async (...args) => { ui.commands.push(args); }
	},
	window: {
		activeTextEditor: {
			selection: { isEmpty: false, start: { line: 0, character: 0 }, end: { line: 0, character: 12 } },
			document: {
				languageId: 'javascript', uri: { fsPath: '/work/a.js' },
				getText: () => 'const a = 1;', lineAt: () => ({ text: 'const a = 1;' })
			}
		},
		tabGroups: { all: [], activeTabGroup: undefined, onDidChangeTabGroups: () => disposable, onDidChangeTabs: () => disposable },
		showInputBox: async () => 'add a comment',
		showInformationMessage: async () => undefined,
		showWarningMessage: async () => undefined,
		// As the editor does it: resolves to the button pressed, and only a button that was offered can be.
		showErrorMessage: async (message, ...items) => {
			ui.errors.push({ message, items });
			return items.includes(ui.press) ? ui.press : undefined;
		},
		withProgress: (_opts, task) => task({}, { onCancellationRequested: () => disposable }),
		createWebviewPanel: () => ({
			webview: {
				html: '',
				postMessage: (m) => { sketchPosted.push(m); },
				onDidReceiveMessage: (fn) => { sketchReceive = fn; return disposable; }
			},
			onDidDispose: () => disposable,
			reveal() { }
		})
	}
};
const origLoad = Module._load;
// @ts-ignore — test-only loader shim
Module._load = function (request, parent, isMain) {
	if (request === 'vscode') { return vscodeMock; }
	return origLoad.call(this, request, parent, isMain);
};

const { registerAiEdit } = require('../aiEdit');
const { openSketch } = require('../sketch');

// sketch.js calls the provider registry directly. A refused request must never get that far, and
// nothing in this file may reach the network — so the two calls it makes are recorded instead.
const providers = /** @type {any} */ (require('../providers/index'));
/** @type {{call:string, apiKey:string}[]} */
const sent = [];
for (const call of ['complete', 'streamAgentTurn']) {
	assert.strictEqual(typeof providers[call], 'function', 'providers/index.js no longer exports ' + call + '()');
	providers[call] = async (o) => { sent.push({ call, apiKey: o.apiKey }); return ''; };
}

// --- the host: what extension.js hands both modules --------------------------------------------
const host = {
	/** @type {any} what prepProviderRequest answers */
	req: null,
	/** The provider adapter the inline edit streams through. */
	stream: async (r) => { r.onDelta('const a = 1; // one'); },
	/** @type {any[]} */
	streamed: [],
	/** @type {any[][]} the arguments of each accountSignIn() call */
	signIns: []
};
const deps = {
	aiConfig: () => ({ get: (_k, d) => d }),
	prepProviderRequest: async () => host.req,
	streamChat: async (r) => { host.streamed.push(r); return host.stream(r); },
	accountSignIn: async (...args) => { host.signIns.push(args); },
	currentProviderId: () => 'claude'
};
registerAiEdit(/** @type {any} */ ({ subscriptions: [] }), deps);
openSketch(/** @type {any} */ ({ extensionPath: EXT_DIR }), deps);
const editSelection = registered.get('levelcode.ai.editSelection');
assert.ok(editSelection, 'aiEdit.js no longer registers levelcode.ai.editSelection');

// What prepProviderRequest returns — the refusals in the shapes sessionExpiredHost.test.js pins.
const ENDED = { ok: false, providerId: 'openai', label: 'LevelCode Cloud', reason: 'signedOut', gateway: true };
const NO_KEY = { ok: false, providerId: 'claude', label: 'Claude', reason: 'key' };
const NO_BASE_URL = { ok: false, providerId: 'custom', label: 'Custom', reason: 'baseURL' };
const INSECURE_URL = { ok: false, providerId: 'custom', label: 'Custom', reason: 'insecureBaseURL' };
const READY = { ok: true, providerId: 'claude', apiKey: 'sk-own', model: 'claude-model', baseURL: '', maxTokens: 4096, label: 'Claude' };

const EDIT_FAILED = 'LevelCode AI edit failed: ';

/** Run "Edit selection" with prepProviderRequest answering `req`; `press` is the toast button the user picks. */
async function edit(req, press) {
	host.req = req; host.streamed.length = 0; host.signIns.length = 0;
	ui.errors.length = 0; ui.commands.length = 0; ui.press = press;
	await editSelection();
	return {
		errors: ui.errors.slice(), streamed: host.streamed.slice(), signIns: host.signIns.slice(),
		diffs: ui.commands.filter((c) => c[0] === 'vscode.diff')
	};
}

const FLOW = { goal: 'ship it', nodes: [{ id: 'a', agentId: 'coder', x: 0, y: 0 }], edges: [] };
/** The three things in the Agent Sketch panel that ask for a provider: [name, webview message, error type]. */
const SKETCH_ACTIONS = /** @type {[string, any, string][]} */ ([
	['Run', { type: 'run', sketch: FLOW }, 'runError'],
	['the board command', { type: 'command', text: 'add a reviewer', sketch: FLOW }, 'uiError'],
	['Generate flow', { type: 'generate', text: 'review a pull request' }, 'uiError']
]);

/** Send the Agent Sketch panel a webview message with prepProviderRequest answering `req`; returns what it posted back. */
async function sketch(req, message) {
	host.req = req; sketchPosted.length = 0; sent.length = 0;
	await sketchReceive(message);
	return sketchPosted.slice();
}

let n = 0;
async function test(name, fn) { await fn(); n++; console.log('  ok - ' + name); }

(async () => {
	// ── inline edit ──────────────────────────────────────────────────────────────────────────────
	await test('inline edit: an ended session says the session expired — not "No API key set for LevelCode Cloud."', async () => {
		const r = await edit(ENDED);
		assert.deepStrictEqual(r.errors, [{ message: EDIT_FAILED + SESSION_EXPIRED_MESSAGE, items: ['Sign in'] }]);
		assert.ok(!/API key/i.test(r.errors[0].message), 'nobody is sent to look for a key');
		assert.strictEqual(r.streamed.length, 0, 'nothing was sent');
		assert.deepStrictEqual(r.signIns, [], 'the toast was dismissed, so nobody is signed in');
	});

	await test('inline edit: "Sign in" starts the sign-in the chat card starts — no provider, no "create"', async () => {
		const r = await edit(ENDED, 'Sign in');
		assert.deepStrictEqual(r.signIns, [[]], 'accountSignIn() once, with no arguments');
		assert.strictEqual(r.errors.length, 1, 'one toast, not a second one after the click');
		assert.strictEqual(r.streamed.length, 0, 'the edit is not retried behind the user\'s back');
	});

	await test('inline edit: a missing key still says "No API key set for <provider>." — and offers no sign-in', async () => {
		const r = await edit(NO_KEY, 'Sign in');
		assert.deepStrictEqual(r.errors, [{ message: EDIT_FAILED + 'No API key set for Claude.', items: [] }]);
		assert.deepStrictEqual(r.signIns, []);
		assert.strictEqual(r.streamed.length, 0, 'nothing was sent');
	});

	await test('inline edit: the custom-endpoint reasons keep their wording', async () => {
		assert.deepStrictEqual((await edit(NO_BASE_URL)).errors,
			[{ message: EDIT_FAILED + 'Set a base URL for the custom OpenAI-compatible provider first (levelcode.ai.baseURL).', items: [] }]);
		assert.deepStrictEqual((await edit(INSECURE_URL)).errors,
			[{ message: EDIT_FAILED + 'Refusing to send your API key over plain http to a non-local host. Use an https (or localhost) base URL.', items: [] }]);
	});

	await test('inline edit: a provider failure is shown as itself, with no sign-in offered', async () => {
		const stream = host.stream;
		host.stream = async () => { throw new Error('Claude API 529: overloaded'); };
		try {
			const r = await edit(READY, 'Sign in');
			assert.deepStrictEqual(r.errors, [{ message: EDIT_FAILED + 'Claude API 529: overloaded', items: [] }]);
			assert.deepStrictEqual(r.signIns, []);
		} finally { host.stream = stream; }
	});

	await test('inline edit: a request that is not refused is sent, and its result opens as a diff', async () => {
		const r = await edit(READY);
		assert.strictEqual(r.streamed.length, 1);
		assert.strictEqual(r.streamed[0].apiKey, 'sk-own');
		assert.deepStrictEqual(r.errors, []);
		assert.strictEqual(r.diffs.length, 1);
	});

	// ── Agent Sketch: Run, the board command, Generate flow ──────────────────────────────────────
	for (const [name, message, type] of SKETCH_ACTIONS) {
		await test('Agent Sketch, ' + name + ': an ended session says the session expired — not "Provider not ready"', async () => {
			assert.deepStrictEqual(await sketch(ENDED, message), [{ type, message: SESSION_EXPIRED_MESSAGE }]);
			assert.deepStrictEqual(sent, [], 'nothing was sent');
		});
	}

	for (const [name, message, type] of SKETCH_ACTIONS) {
		await test('Agent Sketch, ' + name + ': a missing key still says "No API key set for <provider>."', async () => {
			assert.deepStrictEqual(await sketch(NO_KEY, message), [{ type, message: 'No API key set for Claude.' }]);
			assert.deepStrictEqual(sent, [], 'nothing was sent');
		});
	}

	await test('Agent Sketch: any other reason is still "Provider not ready" — Run names the reason, the other two do not', async () => {
		const [run, command, generate] = SKETCH_ACTIONS.map((a) => a[1]);
		assert.deepStrictEqual(await sketch(NO_BASE_URL, run), [{ type: 'runError', message: 'Provider not ready (baseURL).' }]);
		assert.deepStrictEqual(await sketch({ ok: false }, run), [{ type: 'runError', message: 'Provider not ready (unknown).' }]);
		assert.deepStrictEqual(await sketch(NO_BASE_URL, command), [{ type: 'uiError', message: 'Provider not ready.' }]);
		assert.deepStrictEqual(await sketch(NO_BASE_URL, generate), [{ type: 'uiError', message: 'Provider not ready.' }]);
		assert.deepStrictEqual(sent, [], 'nothing was sent');
	});

	await test('Agent Sketch: a request that is not refused reaches the provider', async () => {
		await sketch(READY, SKETCH_ACTIONS[1][1]);
		assert.deepStrictEqual(sent, [{ call: 'complete', apiKey: 'sk-own' }]);
	});

	// ── what can only be read ────────────────────────────────────────────────────────────────────
	await test('host: the inline edit is handed accountSignIn, the function its "Sign in" button calls', () => {
		const ext = fs.readFileSync(path.join(EXT_DIR, 'extension.js'), 'utf8');
		const call = /registerAiEdit\(context, \{([\s\S]*?)\n\t\}\);/.exec(ext);
		assert.ok(call, 'extension.js no longer calls registerAiEdit(context, { … })');
		assert.ok(/^\s*accountSignIn\b/m.test(call[1]), 'accountSignIn is not among the deps');
	});

	await test('neither file keeps its own copy of the sentence — both take it from providers/session', () => {
		for (const file of ['aiEdit.js', 'sketch.js']) {
			const text = fs.readFileSync(path.join(EXT_DIR, file), 'utf8');
			assert.ok(/\{ SESSION_EXPIRED_MESSAGE \} = require\(['"]\.\/providers\/session['"]\)/.test(text), file + ' does not import it');
			assert.ok(!text.includes(SESSION_EXPIRED_MESSAGE), file + ' retypes it');
		}
	});

	console.log('\nsessionExpiredCallers: ' + n + ' tests passed.');
})().catch((e) => { console.error(e); process.exit(1); });
