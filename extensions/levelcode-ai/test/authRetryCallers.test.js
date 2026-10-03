/*---------------------------------------------------------------------------------------------
 *  A LAPSED cloud token, as everything outside the chat meets it
 *  — run: node test/authRetryCallers.test.js
 *
 *  The access token lives 8 hours; the session behind it outlives it. The chat and the agent renew
 *  a lapsed token and send the request again (sessionExpiredHost.test.js). Seven other requests go
 *  out on a provider prepProviderRequest resolved, and each was sent exactly once:
 *
 *    - inline edit (aiEdit.js)                          "LevelCode AI edit failed: … API 401: …"
 *    - Agent Sketch (sketch.js): Run, the board command, Generate flow
 *    - inline completion (inlineComplete.js)            silently nothing, on every keystroke
 *    - Compact and the session-memory summary (extension.js)
 *
 *  In gateway mode — the default — a token that lapsed while the window stayed focused therefore
 *  failed all of them, for a request the chat would have carried through. They now go through
 *  providers/authRetry.js. What is pinned here, for every one of them:
 *
 *    - a 401 whose renewal succeeds is retried once, on the new token
 *    - a 401 whose renewal merely failed keeps the session and is shown as the error it is
 *    - a 401 whose renewal the server REFUSED ends the session — by the refresh, once — and is
 *      shown as the session sentence the chat uses
 *    - a BYOK request is never refreshed and never retried
 *    - nobody is ever asked for a key, and what was silent stays silent
 *
 *  And, where it takes a real sign-in or a real setting to show it: a request stays with the
 *  session and the cloud host it was sent on — a token stored by someone else's sign-in, or for
 *  another host, is never put on it.
 *
 *  This RUNS the shipped code end to end, for the reason sessionExpiredHost.test.js gives: the
 *  callers are the real modules, driven as the editor drives them (the registered command, the
 *  panel's message handler, the completion provider) behind a minimal `vscode` mock; the provider
 *  adapters are the real ones; and the host — prepProviderRequest, the refresh, the session's end,
 *  and authRetry built from them — is sliced out of extension.js. Only the network is a stand-in:
 *  a gateway that answers 401 to a lapsed token, and a refresh endpoint.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Module = require('module');
const session = require('../providers/session');
const { resolveGateway, GATEWAY_PATH } = require('../providers/gateway');
const { createAuthRetry } = require('../providers/authRetry');
const { findCompactionCut, estimateMsgTokens } = require('../agentMemory');

const EXT_DIR = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(EXT_DIR, 'extension.js'), 'utf8');

// ── the host: its own functions, sliced out of extension.js ──────────────────────────────────────
// Slice a top-level `[async] function <name>(...) {…}` by matching its braces, skipping the ones in
// strings and comments (as sessionExpiredHost.test.js and mcpManage.test.js do).
function extract(name) {
	let start = src.indexOf('function ' + name + '(');
	assert.ok(start >= 0, 'extension.js no longer defines ' + name + '()');
	const open = src.indexOf('{', start);
	if (src.slice(start - 6, start) === 'async ') { start -= 6; }
	let depth = 0, str = '', comment = '';
	for (let i = open; i < src.length; i++) {
		const ch = src[i], next = src[i + 1];
		if (comment === 'line') { if (ch === '\n') { comment = ''; } continue; }
		if (comment === 'block') { if (ch === '*' && next === '/') { comment = ''; i++; } continue; }
		if (str) {
			if (ch === '\\') { i++; }
			else if (ch === str) { str = ''; }
			continue;
		}
		if (ch === '/' && next === '/') { comment = 'line'; i++; continue; }
		if (ch === '/' && next === '*') { comment = 'block'; i++; continue; }
		if (ch === '"' || ch === "'" || ch === '`') { str = ch; continue; }
		if (ch === '{') { depth++; }
		else if (ch === '}' && --depth === 0) { return src.slice(start, i + 1); }
	}
	assert.fail('no matching closing brace found for ' + name + '()');
}

/** A one-line top-level declaration, taken from the source so nothing here can drift from it. */
function decl(name) {
	const m = new RegExp('^(?:const|let) ' + name + ' = [^;\\n]*;', 'm').exec(src);
	assert.ok(m, 'extension.js no longer declares ' + name);
	return m[0];
}

const HOST_FUNCTIONS = [
	'providerMode', 'isAuthError', 'cloudEndpoint', 'cloudApiUrl', 'refreshCloudToken', 'renewSession', 'withSessionLock', 'sameSession',
	'sessionExpired', 'postSessionExpired', 'sessionExpiredPending', 'isEndedSessionError', 'clearSessionExpired', 'refreshGatewayToken',
	'prepProviderRequest', 'accountSignOut', 'storeSession', 'summarizeSessionOutcome', 'compactAgentMemory'
].concat(
	// The refresh is still being reviewed (#92), and this file is stacked on it. What its later
	// revisions have renewSession call is sliced as soon as extension.js has it; anything this list
	// does not foresee is reported by name (sliceErrors, below) rather than passed off as a failure.
	['storedToken', 'catchUpWithStoredSession'].filter((name) => src.includes('function ' + name + '('))
);
// eslint-disable-next-line no-new-func
const makeHost = new Function('env', [
	"'use strict';",
	'const { vscode, session, providers, catalog, resolveGateway, createAuthRetry, fetch, ctx, dbg, aiConfig, post, postAccount,',
	'  sendConfigToWebview, gatewayModel, maxOutputTokens, currentProviderId, baseUrlFor, getProviderKey, activeModel,',
	'  findCompactionCut, estimateMsgTokens, meterModel, checkpoints, serializeMsgForSummary, parseOutcome } = env;',
	// The prompts themselves are beside the point here.
	"const OUTCOME_SYSTEM = 'system', OUTCOME_FORMAT = 'format', OUTCOME_SUPERSEDES_FORMAT = '', COMPACT_SYSTEM = 'system', COMPACT_INSTRUCTIONS = 'Summarize:\\n';",
	'let cloudSignedIn = env.signedIn, abort = null, agentMessages = [];',
	decl('ACCOUNT_TOKEN_KEY'), decl('ACCOUNT_REFRESH_KEY'), decl('ACCOUNT_PROFILE_KEY'), decl('ACCOUNT_EXPIRED_KEY'),
	decl('sessionQueue'), decl('sessionGeneration'),
	...HOST_FUNCTIONS.map(extract),
	decl('authRetry'),   // built exactly as the extension builds it — from the functions and the count sliced above
	'return { ' + HOST_FUNCTIONS.join(', ') + ', authRetry,',
	'  KEY: { token: ACCOUNT_TOKEN_KEY, refresh: ACCOUNT_REFRESH_KEY, profile: ACCOUNT_PROFILE_KEY, expired: ACCOUNT_EXPIRED_KEY },',
	'  signedIn: () => cloudSignedIn, setAgentMessages: (m) => { agentMessages = m; }, agentMessages: () => agentMessages };'
].join('\n'));

// ── what the user sees, and does ─────────────────────────────────────────────────────────────────
const ui = {
	/** @type {{kind:string, message:string, items:string[]}[]} every toast, of any kind, and the buttons on it */
	toasts: [],
	/** @type {string|undefined} the toast button the user presses; undefined dismisses the toast */
	press: undefined,
	/** @type {any[][]} the arguments of each accountSignIn() call */
	signIns: [],
	/** How many input boxes were opened. The inline edit opens one, for its instruction; nothing else may. */
	inputs: 0,
	/** @type {string[]} status-bar flashes */
	status: [],
	/** @type {any[][]} */
	commands: [],
	/** @type {(() => void)|null} the Cancel button on the inline edit's progress notification */
	cancel: null
};
/** @type {Map<string, Function>} */
const registered = new Map();
/** @type {any} the provider behind the diff's two virtual documents */
let diffContent = null;
/** @type {any} */
let inlineProvider = null;
/** @type {any[]} */
const sketchPosted = [];
/** @type {(m:any) => Promise<void>} */
let sketchReceive = async () => { assert.fail('the Agent Sketch panel never subscribed to its webview'); };
const disposable = { dispose() { } };

/** @type {Record<string, any>} the settings in force — replaced by every boot() */
let settings = {};
// As the editor does it: a toast resolves to the button pressed, and only a button that was offered can be.
const toast = (kind) => async (message, ...items) => { ui.toasts.push({ kind, message, items }); return items.includes(ui.press) ? ui.press : undefined; };
function clearUi() {
	ui.toasts.length = 0; ui.press = undefined; ui.signIns.length = 0; ui.inputs = 0; ui.status.length = 0; ui.commands.length = 0; ui.cancel = null;
	sketchPosted.length = 0;
}

// ── minimal vscode mock: what the three modules touch between "invoked" and "answer shown" ───────
const vscodeMock = {
	ProgressLocation: { Notification: 15 },
	ViewColumn: { Active: -1 },
	StatusBarAlignment: { Right: 2 },
	ConfigurationTarget: { Global: 1 },
	Position: class { constructor(line, character) { this.line = line; this.character = character; } },
	Range: class { constructor(...a) { this.a = a; } },
	InlineCompletionItem: class { constructor(insertText, range) { this.insertText = insertText; this.range = range; } },
	Uri: { parse: (s) => ({ scheme: String(s).split(':')[0], toString: () => String(s) }) },
	workspace: {
		getConfiguration: (section) => ({ get: (k, d) => (settings[section + '.' + k] === undefined ? d : settings[section + '.' + k]) }),
		registerTextDocumentContentProvider: (_scheme, provider) => { diffContent = provider; return disposable; },
		onDidChangeConfiguration: () => disposable
	},
	commands: {
		registerCommand: (id, fn) => { registered.set(id, fn); return disposable; },
		executeCommand: async (...args) => { ui.commands.push(args); }
	},
	languages: { registerInlineCompletionItemProvider: (_selector, provider) => { inlineProvider = provider; return disposable; } },
	window: {
		activeTextEditor: {
			selection: { isEmpty: false, start: { line: 0, character: 0 }, end: { line: 0, character: 12 } },
			document: {
				languageId: 'javascript', uri: { fsPath: '/work/a.js' },
				getText: () => 'const a = 1;', lineAt: () => ({ text: 'const a = 1;' })
			}
		},
		tabGroups: { all: [], activeTabGroup: undefined, onDidChangeTabGroups: () => disposable, onDidChangeTabs: () => disposable },
		showInputBox: async () => { ui.inputs++; return 'add a comment'; },
		showInformationMessage: toast('info'),
		showWarningMessage: toast('warning'),
		showErrorMessage: toast('error'),
		setStatusBarMessage: (message) => { ui.status.push(message); return disposable; },
		withProgress: (_opts, task) => task({}, { onCancellationRequested: (fn) => { ui.cancel = fn; return disposable; } }),
		createStatusBarItem: () => ({ show() { }, dispose() { } }),
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

const providers = require('../providers/index');
const catalog = require('../providers/catalog');
const { registerAiEdit } = require('../aiEdit');
const { openSketch } = require('../sketch');
const { registerInlineComplete } = require('../inlineComplete');

// ── the network: the only stand-in ───────────────────────────────────────────────────────────────
const tick = () => new Promise((resolve) => setImmediate(resolve));
/** How long anything here is given to happen. Reached only by what never does. */
const PATIENCE_MS = 2000;
/**
 * Wait for `cond` — by the CLOCK, not by counting turns of the event loop. Inline completion waits
 * out its debounce on a real timer, a millisecond even when the setting is 0, and how many turns fit
 * into a millisecond is the machine's business: a few dozen on a Mac, well over a thousand on
 * Linux, where the release gate runs. A count that was plenty on one ran out on the other before
 * the timer had fired.
 */
async function until(cond, what) {
	const deadline = Date.now() + PATIENCE_MS;
	while (!cond()) {
		if (Date.now() > deadline) { assert.fail('never happened: ' + what); }
		await tick();
	}
}
/** Let everything already in motion get as far as it can. Turns, not time — so only for what no timer stands in the way of. */
async function settle() { for (let i = 0; i < 40; i++) { await tick(); } }
function deferred() { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; }
function within(promise, ms, what) {
	let timer;
	const late = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(what + ' did not finish within ' + ms + ' ms')), ms); });
	return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

const net = {
	/** @type {Set<string>} bearer tokens the model endpoint answers 401 to */
	refused: new Set(),
	/** The 401's message: the gateway's for a lapsed token, a provider's for a wrong key. */
	refusal: 'Signature has expired',
	/** What POST /auth/refresh answers: 'offline', { status, body }, or a function returning either (or a promise of one). */
	refreshReply: /** @type {any} */ ('offline'),
	/** What the model says: text, or a function of the request returning text or a whole Response. */
	answer: /** @type {any} */ ('ok'),
	/** @type {{url:string, bearer:string, stream:boolean}[]} every chat request, in order */
	model: [],
	/** @type {{refresh:string}[]} the body of every POST /auth/refresh */
	refresh: [],
	/** The model endpoint waits on this before it answers: a promise, or a function of the request's index returning one (or nothing). */
	hold: /** @type {any} */ (null),
	/** @type {string[]} anything else that tried to leave */
	unexpected: []
};
/**
 * What the sliced host tripped over that is this FILE's fault: a name extension.js now uses and
 * HOST_FUNCTIONS (or the stand-ins) does not supply. refreshCloudToken never rejects, so without
 * this a missing function would pass itself off as "the renewal failed".
 * @type {string[]}
 */
const sliceErrors = [];
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
/** A streamed reply: one SSE frame per event. */
const sse = (events) => new Response(events.map((e) => 'data: ' + JSON.stringify(e) + '\n\n').join('') + 'data: [DONE]\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } });
const delta = (text) => ({ choices: [{ delta: { content: text } }] });
const abortError = () => Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });

async function fakeFetch(url, init) {
	const u = String(url), signal = init && init.signal;
	const body = JSON.parse(init.body);
	if (u.endsWith('/api/levelcode/v1/auth/refresh')) {
		net.refresh.push(body);
		const reply = typeof net.refreshReply === 'function' ? net.refreshReply(body) : net.refreshReply;
		const r = await new Promise((resolve, reject) => {
			if (signal) { signal.addEventListener('abort', () => reject(abortError())); }
			Promise.resolve(reply).then(resolve);
		});
		if (r === 'offline') { throw new TypeError('fetch failed'); }
		return json(r.status, r.body);
	}
	if (u.endsWith('/chat/completions')) {
		const call = { url: u, bearer: String(init.headers.authorization || '').replace(/^Bearer /, ''), stream: !!body.stream };
		net.model.push(call);
		await tick();
		const held = typeof net.hold === 'function' ? net.hold(net.model.length - 1) : net.hold;
		if (held) { await held; }
		if (signal && signal.aborted) { throw abortError(); }
		if (net.refused.has(call.bearer)) { return json(401, { error: { code: 'token_expired', message: net.refusal } }); }
		const out = typeof net.answer === 'function' ? net.answer(call) : net.answer;
		if (out instanceof Response) { return out; }
		return call.stream
			? sse([delta(out), { choices: [{ delta: {}, finish_reason: 'stop' }] }])
			: json(200, { choices: [{ message: { content: out } }] });
	}
	net.unexpected.push(u);
	throw new TypeError('fetch failed');
}
globalThis.fetch = /** @type {any} */ (fakeFetch);   // the adapters' fetch; the host is handed the same one

// ── one editor window ────────────────────────────────────────────────────────────────────────────
// The defaults a fresh install runs with come from package.json: "gateway mode" below means the
// mode nobody chose.
const pkg = require('../package.json');
const settingDefaults = Object.assign({}, ...[].concat(pkg.contributes.configuration).map((c) => c.properties || {}));
function shippedDefault(key) { return settingDefaults[key] ? settingDefaults[key].default : undefined; }

/** @type {any} the window the callers below are talking to */
let win = null;

/**
 *   settings — overrides on top of the shipped defaults
 *   access/refresh/profile — what SecretStorage and globalState hold at the start
 *   byokKey  — the user's own provider key ('' = none saved)
 */
function boot(over) {
	const o = Object.assign({ settings: {}, access: null, refresh: null, profile: null, byokKey: '' }, over);
	settings = Object.assign({
		'levelcode.ai.providerMode': shippedDefault('levelcode.ai.providerMode'),
		'levelcode.cloud.endpoint': shippedDefault('levelcode.cloud.endpoint'),
		'levelcode.ai.completions.debounce': 0   // nobody here waits out a typing pause
	}, o.settings);
	clearUi();
	net.refused.clear(); net.refusal = 'Signature has expired'; net.refreshReply = 'offline'; net.answer = 'ok'; net.hold = null;
	net.model.length = 0; net.refresh.length = 0;

	const secrets = new Map(), state = new Map(), posted = [];
	/** onRead(key): called as the host starts each SecretStorage read — the hook for landing something while one is out. */
	const t = /** @type {any} */ ({ secrets, state, posted, keyPrompts: 0, account: 0, retries: [], byokKey: o.byokKey, onRead: null });
	t.host = makeHost({
		vscode: vscodeMock, session, providers, catalog, resolveGateway, createAuthRetry, fetch: fakeFetch, signedIn: !!o.access,
		// The stores answer a turn of the event loop later, as the real ones do — and SecretStorage takes strings only.
		ctx: {
			secrets: {
				get: async (k) => { if (t.onRead) { t.onRead(k); } await tick(); return secrets.get(k); },
				store: async (k, v) => {
					await tick();
					if (typeof v !== 'string') { throw new TypeError('SecretStorage: the value must be a string'); }
					secrets.set(k, v);
				},
				delete: async (k) => { await tick(); secrets.delete(k); }
			},
			globalState: {
				get: (k) => state.get(k),
				update: async (k, v) => { await tick(); if (v === undefined) { state.delete(k); } else { state.set(k, v); } }
			}
		},
		dbg: (label, data) => {
			if (label === 'auth.retry') { t.retries.push(data.outcome); }
			const went = String((data && (data.error || data.msg)) || '');
			if (/is not defined|is not a function/.test(went)) { sliceErrors.push(label + ': ' + went); }
		},
		post: (m) => { posted.push(m); },   // the chat webview
		postAccount: async () => { t.account++; }, sendConfigToWebview: () => { },
		aiConfig: () => vscodeMock.workspace.getConfiguration('levelcode.ai'),
		gatewayModel: () => 'cloud-model', maxOutputTokens: () => 4096,
		currentProviderId: () => 'openai', baseUrlFor: () => '', activeModel: () => 'gpt-own',
		getProviderKey: async (_id, opts) => {
			if (!t.byokKey && opts && opts.prompt) { t.keyPrompts++; }
			return t.byokKey || undefined;
		},
		findCompactionCut, estimateMsgTokens, meterModel: () => 'cloud-model', checkpoints: [],
		serializeMsgForSummary: (m) => m.role + ': ' + m.content,
		parseOutcome: (out) => ({ summary: String(out).replace(/^SUMMARY:\s*/, ''), facts: [], supersedes: [] })
	});
	t.K = t.host.KEY;
	if (o.access) { secrets.set(t.K.token, o.access); }
	if (o.refresh) { secrets.set(t.K.refresh, o.refresh); }
	if (o.profile) { state.set(t.K.profile, o.profile); }
	win = t;
	return t;
}

// ── the three modules, registered once, with the deps activate() hands them ──────────────────────
// (That activate() really does hand each of them authRetry is pinned at the bottom of this file.)
const aiConfig = () => vscodeMock.workspace.getConfiguration('levelcode.ai');
const prepProviderRequest = (o) => win.host.prepProviderRequest(o);
const authRetry = (req, send, opts) => win.host.authRetry(req, send, opts);
const accountSignIn = async (...args) => { ui.signIns.push(args); };
registerAiEdit(/** @type {any} */ ({ subscriptions: [] }), { aiConfig, authRetry, prepProviderRequest, streamChat: providers.streamChat, accountSignIn });
openSketch(/** @type {any} */ ({ extensionPath: EXT_DIR }), { prepProviderRequest, aiConfig, currentProviderId: () => 'openai', authRetry });
registerInlineComplete(/** @type {any} */ ({ subscriptions: [] }), { aiConfig, authRetry, prepProviderRequest, complete: providers.complete, fastCompletionModel: catalog.fastCompletionModel });
const editSelection = registered.get('levelcode.ai.editSelection');
assert.ok(editSelection, 'aiEdit.js no longer registers levelcode.ai.editSelection');
assert.ok(inlineProvider, 'inlineComplete.js no longer registers a completion provider');

// ── driving them ─────────────────────────────────────────────────────────────────────────────────
/** Run "Edit selection". */
async function edit() {
	await editSelection();
	const diffs = ui.commands.filter((c) => c[0] === 'vscode.diff');
	return {
		errors: ui.toasts.filter((x) => x.kind === 'error').map((x) => x.message),
		/** The buttons on each of those toasts. */
		buttons: ui.toasts.filter((x) => x.kind === 'error').map((x) => x.items),
		diffs: diffs.length,
		/** The proposed side of the diff, as the editor would read it. */
		proposed: diffs.length ? diffContent.provideTextDocumentContent(diffs[diffs.length - 1][2]) : null
	};
}

/** Send the Agent Sketch panel a webview message; returns what it posted back. */
async function sketch(message) {
	await sketchReceive(message);
	return sketchPosted.slice();
}
const node = (id) => ({ id, agentId: 'coder', x: 0, y: 0 });
const FLOW = { goal: 'ship it', nodes: [node('a')], edges: [] };

/** Somebody typing: the token VS Code cancels on the next keystroke. */
function typing() {
	const listeners = [];
	const token = { isCancellationRequested: false, onCancellationRequested: (fn) => { listeners.push(fn); return disposable; } };
	return { token, keystroke() { token.isCancellationRequested = true; listeners.splice(0).forEach((fn) => fn()); } };
}
const DOC = {
	uri: { scheme: 'file' }, languageId: 'javascript', lineCount: 1,
	lineAt: () => ({ range: { end: new vscodeMock.Position(0, 11) } }),
	// Two ranges are read: start of file → cursor (the prefix), and cursor → end (nothing: the cursor is at the end).
	getText: (range) => (range.a[0].character === 0 ? 'const a = 1' : '')
};
/** Ask for ghost text at the cursor; returns the suggestions, or null. */
async function ghostText(typed) {
	const items = await inlineProvider.provideInlineCompletionItems(DOC, new vscodeMock.Position(0, 11), {}, (typed || typing()).token);
	return items ? items.map((i) => i.insertText) : null;
}

/** A transcript long enough to compact / summarize. */
const transcript = (n) => Array.from({ length: n }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: 'turn ' + i }));

/**
 * Everything that sends a provider request outside the chat and the agent.
 *   answer — what the model says when the request gets through
 *   run    — do it, as the editor does; `done` = it worked, `said` = every error text the user was shown
 *   failed — this caller's own wording in front of an error; absent for the ones that fail silently
 */
const CALLERS = [
	{
		name: 'inline edit', answer: 'const a = 1; // one', failed: 'LevelCode AI edit failed: ',
		run: async () => { const r = await edit(); return { done: r.diffs === 1, said: r.errors }; }
	},
	{
		name: 'Agent Sketch, Run', answer: 'done', failed: '',
		run: async () => {
			const posted = await sketch({ type: 'run', sketch: FLOW });
			const end = posted.filter((m) => m.type === 'runDone').pop();
			return {
				done: !!end && !end.failed && !end.aborted && posted.some((m) => m.type === 'nodeDone'),
				said: posted.filter((m) => m.type === 'runError' || (m.type === 'nodeStatus' && m.status === 'error')).map((m) => m.message)
			};
		}
	},
	{
		name: 'Agent Sketch, the board command', answer: '{"ops":[]}', failed: 'Command failed: ',
		run: async () => {
			const posted = await sketch({ type: 'command', text: 'add a reviewer', sketch: FLOW });
			return { done: posted.some((m) => m.type === 'commandResult'), said: posted.filter((m) => m.type === 'uiError').map((m) => m.message) };
		}
	},
	{
		name: 'Agent Sketch, Generate flow', answer: '{"goal":"review","nodes":[{"agent":"coder","label":"c1","task":"t"}],"edges":[]}', failed: 'Flow generation failed: ',
		run: async () => {
			const posted = await sketch({ type: 'generate', text: 'review a pull request' });
			return { done: posted.some((m) => m.type === 'generatedFlow'), said: posted.filter((m) => m.type === 'uiError').map((m) => m.message) };
		}
	},
	{
		name: 'inline completion', answer: ' + 1;', silent: true,
		run: async () => ({ done: !!(await ghostText()), said: [] })
	},
	{
		// Reports `{ ok:false, reason }`; the chat words the failure itself.
		name: 'Compact', answer: 'A briefing.', silent: true,
		run: async () => {
			win.host.setAgentMessages(transcript(12));
			const r = await win.host.compactAgentMemory();
			return { done: !!r.ok, said: [], reason: r.reason };
		}
	},
	{
		name: 'the session-memory summary', answer: 'SUMMARY: Added a comment.', silent: true,
		run: async () => ({ done: !!(await win.host.summarizeSessionOutcome(transcript(6), [])).summary, said: [] })
	}
];

/** Run one of them; whatever happens, nobody may be asked for a key, and the quiet ones stay quiet. */
async function run(caller) {
	clearUi();
	net.answer = caller.answer;
	const r = await caller.run();
	assert.strictEqual(win.keyPrompts, 0, 'nobody is asked for an API key');
	if (caller.silent) {
		assert.deepStrictEqual({ toasts: ui.toasts, inputs: ui.inputs, status: ui.status }, { toasts: [], inputs: 0, status: [] }, caller.name + ' said something');
	}
	return r;
}

/** An unsigned JWT with the given payload. The tokens here say who they are for, as real ones do. */
function jwt(payload) {
	const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
	return b64({ alg: 'HS256', typ: 'JWT' }) + '.' + b64(payload) + '.sig';
}
const LAPSED = jwt({ sub: 'ada', exp: 1 });            // Ada's access token, eight hours and a bit after she signed in
const FRESH = jwt({ sub: 'ada', exp: 4102444800 });    // …and what a renewal of her session brings back
const RENEWS = { status: 200, body: { access: FRESH, refresh: 'r2' } };
const REFUSES = { status: 401, body: { error: { code: 'refresh_expired' } } };
const bearers = () => net.model.map((c) => c.bearer);
/** The gateway's answer to a lapsed token, as the adapter throws it — for asking the host what IT makes of one. */
const gateway401 = () => new Error('LevelCode Cloud API 401: Signature has expired');
/** How the chat and the agent would answer "did the session end?" right now (extension.js: isEndedSessionError). */
const chatCallsItEnded = (t) => t.host.isEndedSessionError({ gateway: true }, gateway401());
const cards = (t) => t.posted.filter((m) => m.type === 'sessionExpired');

/** Gateway mode, signed in, and the access token has lapsed. The session itself is still renewable. */
function lapsed(over) {
	const t = boot(Object.assign({ access: LAPSED, refresh: 'r1', profile: { name: 'Ada' } }, over));
	net.refused.add(LAPSED);
	net.refreshReply = RENEWS;
	return t;
}
function sessionKept(t) {
	assert.strictEqual(t.secrets.get(t.K.token), LAPSED, 'access token kept');
	assert.strictEqual(t.secrets.get(t.K.refresh), 'r1', 'refresh token kept');
	assert.strictEqual(t.host.signedIn(), true, 'still signed in');
	assert.strictEqual(t.state.get(t.K.expired), undefined, 'no expiry recorded');
	assert.deepStrictEqual(cards(t), [], 'no sign-in card');
}
/** Wait out a renewal the test held back. The host writes the access token, then the rotated refresh token: wait for the last. */
async function renewalLanded(t) {
	await until(() => t.secrets.get(t.K.refresh) === 'r2', 'the renewal landing');
	assert.strictEqual(t.secrets.get(t.K.token), FRESH);
}
function sessionEnded(t) {
	assert.strictEqual(t.secrets.get(t.K.token), undefined, 'access token forgotten');
	assert.strictEqual(t.secrets.get(t.K.refresh), undefined, 'refresh token forgotten');
	assert.strictEqual(t.host.signedIn(), false);
	assert.strictEqual(t.state.get(t.K.expired), true, 'the expiry is recorded');
	assert.deepStrictEqual(cards(t), [{ type: 'sessionExpired', name: 'Ada', message: session.SESSION_EXPIRED_MESSAGE }], 'the chat gets its sign-in card, once');
}

let n = 0;
async function test(name, fn) {
	try { await fn(); }
	finally {
		// Reported first: a hole in the slice is the cause of whatever assertion it tripped.
		if (sliceErrors.length) { throw new Error('this file\'s slice of extension.js is out of date — ' + sliceErrors.join('; ')); }
	}
	assert.deepStrictEqual(net.unexpected, [], 'a request went somewhere this test does not know');
	n++; console.log('  ok - ' + name);
}

(async () => {
	// ── the premise ──────────────────────────────────────────────────────────────────────────────
	await test('premise: a fresh install is in gateway mode, and a signed-in request goes to the gateway on the stored token', async () => {
		assert.strictEqual(shippedDefault('levelcode.ai.providerMode'), 'gateway');
		const t = lapsed();
		const req = await t.host.prepProviderRequest({ prompt: true });
		assert.deepStrictEqual({ ok: req.ok, gateway: req.gateway, apiKey: req.apiKey }, { ok: true, gateway: true, apiKey: LAPSED });
		assert.strictEqual(req.baseURL, shippedDefault('levelcode.cloud.endpoint') + GATEWAY_PATH);
		assert.deepStrictEqual(net.refresh, [], 'asking for a provider reads the stored token — it renews nothing');
	});

	await test('premise: the adapters do not renew either — a 401 is thrown straight through', async () => {
		const t = lapsed();
		const req = await t.host.prepProviderRequest({ prompt: true });
		const call = { providerId: req.providerId, apiKey: req.apiKey, baseURL: req.baseURL, model: req.model, system: 's', messages: [{ role: 'user', content: 'hi' }] };
		await assert.rejects(providers.complete(call), /API 401: Signature has expired$/);
		await assert.rejects(providers.streamChat(Object.assign({ onDelta: () => { } }, call)), /API 401: Signature has expired$/);
		await assert.rejects(providers.streamAgentTurn(call), /API 401: Signature has expired$/);
		assert.deepStrictEqual({ refresh: net.refresh, sent: bearers() }, { refresh: [], sent: [LAPSED, LAPSED, LAPSED] });
		assert.ok(t.host.isAuthError(await providers.complete(call).catch((e) => e)), 'and it is what the host calls an auth error');
	});

	// ── every caller, the same four ways ─────────────────────────────────────────────────────────
	for (const caller of CALLERS) {
		await test(caller.name + ': a lapsed token is renewed and the request sent once more, on the new token', async () => {
			const t = lapsed();
			const r = await run(caller);
			assert.deepStrictEqual({ done: r.done, said: r.said }, { done: true, said: [] });
			assert.deepStrictEqual(net.refresh, [{ refresh: 'r1' }], 'one renewal, with the stored refresh token');
			assert.deepStrictEqual(bearers(), [LAPSED, FRESH], 'sent twice: refused, then on the new token');
			assert.strictEqual(t.secrets.get(t.K.token), FRESH);
			assert.strictEqual(t.secrets.get(t.K.refresh), 'r2', 'the rotated refresh token is stored');
			assert.deepStrictEqual(cards(t), [], 'and the chat hears nothing of it');
			assert.deepStrictEqual(t.retries, ['renewed']);
		});
	}

	for (const [label, reply] of [['offline', 'offline'], ['a 503', { status: 503, body: null }]]) {
		for (const caller of CALLERS) {
			await test(caller.name + ': a 401 whose renewal fails (' + label + ') keeps the session and is shown as the error it is', async () => {
				const t = lapsed();
				net.refreshReply = reply;
				const r = await run(caller);
				assert.strictEqual(r.done, false);
				if (caller.silent) { assert.deepStrictEqual(r.said, []); }
				else {
					assert.strictEqual(r.said.length, 1, 'one error: ' + JSON.stringify(r.said));
					assert.ok(r.said[0].startsWith(caller.failed) && /API 401: Signature has expired$/.test(r.said[0]), r.said[0]);
				}
				assert.strictEqual(net.refresh.length, 1, 'one renewal attempt');
				assert.deepStrictEqual(bearers(), [LAPSED], 'no retry without a fresh token');
				sessionKept(t);
				assert.strictEqual(chatCallsItEnded(t), false, 'and the chat would not call it an expiry either');
			});
		}
	}

	for (const caller of CALLERS) {
		await test(caller.name + ': a 401 whose renewal is REFUSED ends the session — by the refresh, once — and says the session expired', async () => {
			const t = lapsed();
			net.refreshReply = REFUSES;
			const r = await run(caller);
			assert.strictEqual(r.done, false);
			assert.deepStrictEqual(r.said, caller.silent ? [] : [caller.failed + session.SESSION_EXPIRED_MESSAGE]);
			assert.deepStrictEqual(bearers(), [LAPSED], 'nothing is sent again');
			assert.strictEqual(net.refresh.length, 1);
			sessionEnded(t);
			assert.deepStrictEqual(t.retries, ['ended']);
			assert.strictEqual(chatCallsItEnded(t), true, 'the chat and the agent would call it the same');

			// From here on it is prepProviderRequest that stops the request: nothing more goes out, and
			// what was said about the request that found out is what is said about the ones refused after it.
			const next = await run(caller);
			assert.deepStrictEqual({ sent: net.model.length, refresh: net.refresh.length, cards: cards(t).length }, { sent: 1, refresh: 1, cards: 1 });
			if (!caller.silent) { assert.ok(next.said.length === 1 && next.said[0].endsWith(session.SESSION_EXPIRED_MESSAGE), JSON.stringify(next.said)); }
		});
	}

	for (const [label, over] of /** @type {[string, any][]} */ ([
		['BYOK mode, beside a cloud session that WOULD renew', { settings: { 'levelcode.ai.providerMode': 'byok' }, access: LAPSED, refresh: 'r1', byokKey: 'sk-own' }],
		['the default mode, on your own key with no account', { byokKey: 'sk-own' }]
	])) {
		for (const caller of CALLERS) {
			await test(caller.name + ' — ' + label + ': a 401 from your own provider is never refreshed, never retried', async () => {
				const t = boot(over);
				net.refused.add('sk-own'); net.refusal = 'Incorrect API key provided';
				net.refreshReply = RENEWS;   // it would work, if anything asked
				const r = await run(caller);
				assert.strictEqual(r.done, false);
				if (!caller.silent) {
					assert.strictEqual(r.said.length, 1);
					assert.ok(r.said[0].startsWith(caller.failed) && /API 401: Incorrect API key provided$/.test(r.said[0]), r.said[0]);
				}
				assert.deepStrictEqual(net.refresh, [], 'no refresh');
				assert.deepStrictEqual(bearers(), ['sk-own'], 'sent once');
				assert.ok(net.model[0].url.startsWith('https://api.openai.com/'), 'to the user\'s own provider: ' + net.model[0].url);
				assert.deepStrictEqual({ cards: cards(t), retries: t.retries, token: t.secrets.get(t.K.token) }, { cards: [], retries: [], token: over.access });
			});
		}
	}

	for (const caller of CALLERS) {
		await test(caller.name + ': a gateway error that is not a 401 is not a reason to renew', async () => {
			const t = lapsed();
			net.refused.clear();
			net.answer = () => json(402, { error: { code: 'cap_reached', message: 'You have used this month\'s credits' } });
			const r = await caller.run();
			assert.strictEqual(r.done, false);
			if (!caller.silent) { assert.ok(r.said.length === 1 && /API 402: You have used this month's credits$/.test(r.said[0]), JSON.stringify(r.said)); }
			assert.deepStrictEqual({ refresh: net.refresh, sent: bearers() }, { refresh: [], sent: [LAPSED] });
			sessionKept(t);
		});
	}

	// ── inline edit ──────────────────────────────────────────────────────────────────────────────
	await test('inline edit: the renewed edit is the diff — one answer, not the refused attempt plus another', async () => {
		lapsed();
		net.answer = 'const a = 1; // one';
		const r = await edit();
		assert.strictEqual(r.proposed, 'const a = 1; // one');
	});

	await test('inline edit: a session found over mid-request gets the toast an up-front refusal gets — "Sign in" and all', async () => {
		lapsed();
		net.refreshReply = REFUSES;
		ui.press = 'Sign in';
		const r = await edit();
		assert.deepStrictEqual(r.errors, ['LevelCode AI edit failed: ' + session.SESSION_EXPIRED_MESSAGE]);
		assert.deepStrictEqual(r.buttons, [['Sign in']], 'the fix is a click away');
		assert.deepStrictEqual(ui.signIns, [[]], 'and the click starts the sign-in the chat card starts');
		assert.deepStrictEqual(bearers(), [LAPSED], 'the edit is not re-sent behind the user\'s back');
	});

	await test('inline edit: a renewal that merely failed offers no "Sign in" — nothing expired', async () => {
		lapsed();
		net.refreshReply = 'offline';
		ui.press = 'Sign in';
		const r = await edit();
		assert.deepStrictEqual(r.buttons, [[]]);
		assert.deepStrictEqual(ui.signIns, []);
	});

	await test('inline edit: signed out while the request was out — its own error, not "your session has expired"', async () => {
		const t = lapsed();
		const gate = deferred();
		net.hold = gate.promise;
		const running = edit();
		await until(() => net.model.length === 1, 'the request');
		await t.host.accountSignOut();   // the user presses Sign out; the gateway's 401 arrives after it
		gate.resolve();
		const r = await within(running, 2000, 'the edit');
		assert.strictEqual(r.errors.length, 1);
		assert.ok(/^LevelCode AI edit failed: .*API 401: Signature has expired$/.test(r.errors[0]), r.errors[0]);
		assert.deepStrictEqual(r.buttons, [[]], 'no "Sign in" on it');
		assert.deepStrictEqual(net.refresh, [], 'there is no refresh token left to renew with');
		assert.deepStrictEqual({ cards: cards(t), marker: t.state.get(t.K.expired), sent: bearers() }, { cards: [], marker: undefined, sent: [LAPSED] });
		assert.strictEqual(chatCallsItEnded(t), false, 'as the chat and the agent see it');
	});

	await test('inline edit: once part of the edit has arrived, an auth error is not answered with a second send', async () => {
		const t = lapsed();
		net.refused.clear();
		net.answer = () => sse([delta('const a'), { error: { message: '401 Unauthorized' } }]);
		const r = await edit();
		assert.deepStrictEqual(r.errors, ['LevelCode AI edit failed: 401 Unauthorized']);
		assert.ok(t.host.isAuthError(new Error('401 Unauthorized')), 'premise: the host would call this an auth error');
		assert.deepStrictEqual({ refresh: net.refresh, sent: bearers() }, { refresh: [], sent: [LAPSED] });
	});

	await test('inline edit: Cancel during the renewal does not wait for it — and the renewal still lands', async () => {
		const t = lapsed();
		const reply = deferred();
		net.refreshReply = () => reply.promise;
		const running = edit();
		await until(() => net.refresh.length === 1, 'the renewal');
		ui.cancel();
		const r = await within(running, 2000, 'the cancelled edit');   // …with the refresh still unanswered
		assert.strictEqual(r.diffs, 0);
		assert.deepStrictEqual(bearers(), [LAPSED], 'nothing is sent after Cancel');
		reply.resolve(RENEWS);
		await renewalLanded(t);
	});

	// ── Agent Sketch ─────────────────────────────────────────────────────────────────────────────
	const FAN = { goal: 'ship it', nodes: [node('a'), node('b'), node('c'), node('d')], edges: ['a', 'b', 'c'].map((from) => ({ from, to: 'd' })) };
	const finished = (posted) => posted.filter((m) => m.type === 'nodeDone').map((m) => m.id).sort();

	await test('Agent Sketch: the nodes of a level fail together and share ONE renewal; the level after them never sees the 401', async () => {
		const t = lapsed();
		net.answer = 'done';
		const posted = await sketch({ type: 'run', sketch: FAN });
		assert.deepStrictEqual(finished(posted), ['a', 'b', 'c', 'd']);
		assert.deepStrictEqual(net.refresh, [{ refresh: 'r1' }], 'one refresh for three refused nodes — not three racing for one refresh token');
		assert.deepStrictEqual(bearers(), [LAPSED, LAPSED, LAPSED, FRESH, FRESH, FRESH, FRESH], 'a, b, c refused and re-sent; d sent once, on the new token');
		const end = posted.filter((m) => m.type === 'runDone').pop();
		assert.deepStrictEqual({ failed: end.failed, aborted: end.aborted }, { failed: false, aborted: false });
		assert.strictEqual(t.secrets.get(t.K.refresh), 'r2');
	});

	await test('Agent Sketch: three nodes, a renewal the server refuses — the session ends ONCE, and every node says so', async () => {
		const t = lapsed();
		net.refreshReply = REFUSES;
		const posted = await sketch({ type: 'run', sketch: FAN });
		const errors = posted.filter((m) => m.type === 'nodeStatus' && m.status === 'error');
		assert.deepStrictEqual(errors.map((m) => m.id).sort(), ['a', 'b', 'c']);
		assert.deepStrictEqual([...new Set(errors.map((m) => m.message))], [session.SESSION_EXPIRED_MESSAGE]);
		assert.strictEqual(net.refresh.length, 1, 'one refresh');
		assert.deepStrictEqual(bearers(), [LAPSED, LAPSED, LAPSED], 'd is never started');
		sessionEnded(t);
		assert.strictEqual(t.account, 1, 'the account popover is resynced once');
	});

	await test('Agent Sketch: a turn that has already produced text is not sent again', async () => {
		lapsed();
		net.refused.clear();
		net.answer = () => sse([delta('half an ans'), { error: { message: '401 Unauthorized' } }]);
		const posted = await sketch({ type: 'run', sketch: FLOW });
		assert.deepStrictEqual(posted.filter((m) => m.type === 'nodeStatus' && m.status === 'error').map((m) => m.message), ['401 Unauthorized']);
		assert.deepStrictEqual({ refresh: net.refresh, sent: bearers() }, { refresh: [], sent: [LAPSED] });
	});

	await test('Agent Sketch: Stop during the renewal stops the run without waiting for it', async () => {
		const t = lapsed();
		const reply = deferred();
		net.refreshReply = () => reply.promise;
		const running = sketch({ type: 'run', sketch: FLOW });
		await until(() => net.refresh.length === 1, 'the renewal');
		await sketchReceive({ type: 'stop' });
		const posted = await within(running, 2000, 'the stopped run');
		assert.ok(posted.some((m) => m.type === 'nodeStatus' && m.status === 'stopped'), 'the node is stopped, not failed');
		const end = posted.filter((m) => m.type === 'runDone').pop();
		assert.deepStrictEqual({ aborted: end.aborted, failed: end.failed }, { aborted: true, failed: false });
		assert.deepStrictEqual(bearers(), [LAPSED]);
		reply.resolve(RENEWS);
		await renewalLanded(t);
	});

	// ── inline completion ────────────────────────────────────────────────────────────────────────
	await test('inline completion: the suggestion that comes back after a renewal is the model\'s', async () => {
		lapsed();
		net.answer = ' + 1;';
		assert.deepStrictEqual(await ghostText(), [' + 1;']);
	});

	await test('inline completion: typing does not become a stream of refreshes — an inline edit still tries', async () => {
		const t = lapsed();
		net.refreshReply = { status: 503, body: null };
		for (let i = 0; i < 4; i++) { assert.strictEqual(await ghostText(), null); }
		assert.strictEqual(net.refresh.length, 1, 'four pauses in typing, one renewal attempt');
		assert.deepStrictEqual(t.retries, ['failed', 'throttled', 'throttled', 'throttled']);
		assert.deepStrictEqual({ toasts: ui.toasts, inputs: ui.inputs }, { toasts: [], inputs: 0 });

		net.refreshReply = RENEWS;   // the refresh endpoint is back
		net.answer = 'const a = 1; // one';
		const r = await edit();      // the user ASKED for this one
		assert.deepStrictEqual({ errors: r.errors, diffs: r.diffs, refresh: net.refresh.length }, { errors: [], diffs: 1, refresh: 2 });
		net.answer = ' + 1;';
		assert.deepStrictEqual(await ghostText(), [' + 1;'], 'and ghost text is back, on the token the edit renewed');
		assert.strictEqual(net.refresh.length, 2);
	});

	await test('inline completion: a keystroke during the renewal drops the request — nothing is re-sent for text that has moved on', async () => {
		const t = lapsed();
		const reply = deferred();
		net.refreshReply = () => reply.promise;
		const typed = typing();
		const running = ghostText(typed);
		await until(() => net.refresh.length === 1, 'the renewal');
		typed.keystroke();
		assert.strictEqual(await within(running, 2000, 'the cancelled completion'), null);
		assert.deepStrictEqual(bearers(), [LAPSED]);
		reply.resolve(RENEWS);
		await renewalLanded(t);
		net.answer = ' + 1;';
		assert.deepStrictEqual(await ghostText(), [' + 1;'], 'the next pause in typing is answered');
		assert.deepStrictEqual({ sent: bearers(), refresh: net.refresh.length }, { sent: [LAPSED, FRESH], refresh: 1 });
	});

	await test('inline completion: a keystroke while the stored session is being read starts no renewal, and leaves the minute unspent', async () => {
		const t = lapsed();
		net.refreshReply = { status: 503, body: null };   // a renewal, were one started, would fail — and use up ghost text's minute
		const typed = typing();
		let reads = 0;
		// The first read of the token is the request being prepared; the second is authRetry looking at what is stored, after the 401.
		t.onRead = (key) => { if (key === t.K.token && ++reads === 2) { typed.keystroke(); } };
		assert.strictEqual(await ghostText(typed), null);
		await settle();
		assert.deepStrictEqual({ refresh: net.refresh.length, retries: t.retries }, { refresh: 0, retries: ['aborted'] }, 'the cancelled completion started nothing');
		t.onRead = null;
		assert.strictEqual(await ghostText(), null);   // the next pause…
		assert.deepStrictEqual({ refresh: net.refresh.length, retries: t.retries }, { refresh: 1, retries: ['aborted', 'failed'] }, '…may still start the minute\'s one renewal');
		assert.deepStrictEqual({ toasts: ui.toasts, inputs: ui.inputs }, { toasts: [], inputs: 0 });
	});

	await test('inline completion: the next pause, arriving while the cancelled one\'s renewal is still out, waits for it and is answered', async () => {
		const t = lapsed();
		const reply = deferred();
		net.refreshReply = () => reply.promise;
		const first = typing();
		const cancelled = ghostText(first);
		await until(() => net.refresh.length === 1, 'the renewal');
		first.keystroke();   // the completion that started the renewal is gone; the renewal is not
		assert.strictEqual(await within(cancelled, 2000, 'the cancelled completion'), null);

		net.answer = ' + 1;';
		const next = ghostText();   // sent on the old token, a moment later: the store has nothing newer yet
		await until(() => net.model.length === 2, 'the next request');
		await settle();             // refused, and now waiting on the renewal that is still out
		reply.resolve(RENEWS);
		assert.deepStrictEqual(await within(next, 2000, 'the next completion'), [' + 1;'], 'not "one renewal a minute, so nothing"');
		assert.deepStrictEqual({ sent: bearers(), refresh: net.refresh.length }, { sent: [LAPSED, LAPSED, FRESH], refresh: 1 });
		assert.deepStrictEqual(t.retries, ['aborted', 'renewed'], 'it waited on the renewal; it started none');
		assert.deepStrictEqual({ toasts: ui.toasts, inputs: ui.inputs }, { toasts: [], inputs: 0 });
	});

	// ── a request stays with the session and the cloud host it was sent on ───────────────────────
	const OTHER = jwt({ sub: 'bo', exp: 4102444800 });   // somebody else's access token
	/** What a sign-in in ANOTHER window leaves behind: the stores every window shares have changed, and nothing this one counts. */
	const anotherWindowSignsIn = (t, access, refresh, profile) => {
		t.secrets.set(t.K.token, access); t.secrets.set(t.K.refresh, refresh); t.state.set(t.K.profile, profile);
	};

	await test('inline edit: someone else signs in while the request is out — the edit is not replayed as them', async () => {
		const t = lapsed();
		const gate = deferred();
		net.hold = gate.promise;
		const running = edit();
		await until(() => net.model.length === 1, 'the request');
		await t.host.storeSession(OTHER, 'rB', { name: 'Bo' });   // the sign-in lands; the gateway's 401 for Ada's token arrives after it
		gate.resolve();
		const r = await within(running, 2000, 'the edit');
		assert.strictEqual(r.errors.length, 1);
		assert.ok(/^LevelCode AI edit failed: .*API 401: Signature has expired$/.test(r.errors[0]), r.errors[0]);
		assert.deepStrictEqual(r.buttons, [[]], 'nothing expired: no "Sign in"');
		assert.deepStrictEqual(bearers(), [LAPSED], 'Ada\'s selection is not sent again on Bo\'s token');
		assert.deepStrictEqual(net.refresh, [], 'and Bo\'s session is not refreshed on its behalf');
		assert.deepStrictEqual({ token: t.secrets.get(t.K.token), refresh: t.secrets.get(t.K.refresh) }, { token: OTHER, refresh: 'rB' }, 'the new session is exactly as the sign-in left it');
		assert.deepStrictEqual({ retries: t.retries, diffs: r.diffs, cards: cards(t) }, { retries: ['superseded'], diffs: 0, cards: [] });
	});

	await test('inline edit: the cloud host changes while the request is out — the new host\'s token never reaches the old one', async () => {
		const t = lapsed();
		const gate = deferred();
		net.hold = gate.promise;
		const running = edit();
		await until(() => net.model.length === 1, 'the request');
		// As another window would leave things: a new host in Settings, and a session for it in the store.
		// The SAME person signed in there, so the token names the same subject and this window counts no
		// new session — only where the gateway is tells the two apart.
		const elsewhere = jwt({ sub: 'ada', iss: 'https://other.test', exp: 4102444800 });
		settings['levelcode.cloud.endpoint'] = 'https://other.test';
		t.secrets.set(t.K.token, elsewhere); t.secrets.set(t.K.refresh, 'rB');
		gate.resolve();
		const r = await within(running, 2000, 'the edit');
		assert.ok(r.errors.length === 1 && /API 401: Signature has expired$/.test(r.errors[0]), JSON.stringify(r.errors));
		const oldHost = new URL(shippedDefault('levelcode.cloud.endpoint')).host;
		assert.deepStrictEqual(net.model.map((c) => c.bearer + ' → ' + new URL(c.url).host), [LAPSED + ' → ' + oldHost], 'one request: the old token, to the old host');
		assert.deepStrictEqual(net.refresh, [], 'and the other host\'s refresh token is not spent on it');
		assert.deepStrictEqual(t.retries, ['superseded']);
		assert.strictEqual((await t.host.prepProviderRequest({ prompt: false })).baseURL, 'https://other.test' + GATEWAY_PATH, 'premise: the next request does go to the new host');
	});

	await test('Agent Sketch: a run stays in the session it started in — a sign-in half-way is not used for the nodes still to come', async () => {
		const t = boot({ access: FRESH, refresh: 'r1', profile: { name: 'Ada' } });
		const gate = deferred();
		net.hold = (index) => (index === 0 ? gate.promise : null);   // hold node a's answer…
		// …which is the last thing Ada's token is good for: every request after it is refused.
		net.answer = () => (net.model.length >= 2 ? json(401, { error: { code: 'token_expired', message: 'Signature has expired' } }) : 'done');
		const running = sketch({ type: 'run', sketch: { goal: 'ship it', nodes: [node('a'), node('d')], edges: [{ from: 'a', to: 'd' }] } });
		await until(() => net.model.length === 1, 'node a\'s request');
		await t.host.storeSession(OTHER, 'rB', { name: 'Bo' });   // Bo signs in while node a is still out
		gate.resolve();
		const posted = await within(running, 2000, 'the run');
		assert.deepStrictEqual(posted.filter((m) => m.type === 'nodeDone').map((m) => m.id), ['a']);
		const failed = posted.filter((m) => m.type === 'nodeStatus' && m.status === 'error');
		assert.ok(failed.length === 1 && failed[0].id === 'd' && /API 401: Signature has expired$/.test(failed[0].message), JSON.stringify(failed));
		assert.deepStrictEqual(bearers(), [FRESH, FRESH], 'node d went out on the run\'s own token, and was not sent again as Bo');
		assert.deepStrictEqual({ refresh: net.refresh, retries: t.retries, token: t.secrets.get(t.K.token) }, { refresh: [], retries: ['superseded'], token: OTHER });
	});

	// The same three, when the sign-in happens in ANOTHER window: same host, and nothing this window
	// counts has moved. The stored token names another subject, and that is what stops the replay.
	await test('inline edit: another WINDOW signs in as someone else while the request is out — still not replayed as them', async () => {
		const t = lapsed();
		const gate = deferred();
		net.hold = gate.promise;
		const running = edit();
		await until(() => net.model.length === 1, 'the request');
		anotherWindowSignsIn(t, OTHER, 'rB', { name: 'Bo', email: '', plan: '' });
		gate.resolve();
		const r = await within(running, 2000, 'the edit');
		assert.strictEqual(t.host.signedIn(), true, 'premise: this window has seen no sign-in, no sign-out');
		assert.strictEqual(r.errors.length, 1);
		assert.ok(/^LevelCode AI edit failed: .*API 401: Signature has expired$/.test(r.errors[0]), r.errors[0]);
		assert.deepStrictEqual(bearers(), [LAPSED], 'Ada\'s selection is not sent again on Bo\'s token');
		assert.deepStrictEqual(net.refresh, [], 'and Bo\'s session is not refreshed on its behalf');
		assert.deepStrictEqual({ token: t.secrets.get(t.K.token), refresh: t.secrets.get(t.K.refresh) }, { token: OTHER, refresh: 'rB' });
		assert.deepStrictEqual({ retries: t.retries, diffs: r.diffs }, { retries: ['superseded'], diffs: 0 });
	});

	await test('inline edit: another window RENEWS the same session while the request is out — the edit goes out again on that token', async () => {
		const t = lapsed();
		const gate = deferred();
		net.hold = gate.promise;
		net.answer = 'const a = 1; // one';
		const running = edit();
		await until(() => net.model.length === 1, 'the request');
		t.secrets.set(t.K.token, FRESH); t.secrets.set(t.K.refresh, 'r2');   // the other window's refresh landed: Ada's token, renewed
		gate.resolve();
		const r = await within(running, 2000, 'the edit');
		assert.deepStrictEqual({ errors: r.errors, diffs: r.diffs }, { errors: [], diffs: 1 });
		assert.deepStrictEqual(bearers(), [LAPSED, FRESH]);
		assert.deepStrictEqual({ refresh: net.refresh, retries: t.retries }, { refresh: [], retries: ['already-renewed'] }, 'no second refresh of a token another window just rotated');
	});

	await test('Agent Sketch: a sign-in in another window half-way through a run is not used for the nodes still to come either', async () => {
		const t = boot({ access: FRESH, refresh: 'r1', profile: { name: 'Ada' } });
		const gate = deferred();
		net.hold = (index) => (index === 0 ? gate.promise : null);
		net.answer = () => (net.model.length >= 2 ? json(401, { error: { code: 'token_expired', message: 'Signature has expired' } }) : 'done');
		const running = sketch({ type: 'run', sketch: { goal: 'ship it', nodes: [node('a'), node('d')], edges: [{ from: 'a', to: 'd' }] } });
		await until(() => net.model.length === 1, 'node a\'s request');
		anotherWindowSignsIn(t, OTHER, 'rB', { name: 'Bo', email: '', plan: '' });
		gate.resolve();
		const posted = await within(running, 2000, 'the run');
		assert.deepStrictEqual(posted.filter((m) => m.type === 'nodeDone').map((m) => m.id), ['a']);
		const failed = posted.filter((m) => m.type === 'nodeStatus' && m.status === 'error');
		assert.ok(failed.length === 1 && failed[0].id === 'd' && /API 401: Signature has expired$/.test(failed[0].message), JSON.stringify(failed));
		assert.deepStrictEqual(bearers(), [FRESH, FRESH], 'node d was not sent again as Bo');
		assert.deepStrictEqual({ refresh: net.refresh, retries: t.retries }, { refresh: [], retries: ['superseded'] });
	});

	// ── Compact ──────────────────────────────────────────────────────────────────────────────────
	await test('Compact: the renewed summary replaces the head of the transcript; a failed one still reports "failed"', async () => {
		const ok = lapsed();
		const done = await run(CALLERS.find((c) => c.name === 'Compact'));
		assert.strictEqual(done.done, true);
		assert.ok(/^\[Summary of the earlier conversation/.test(ok.host.agentMessages()[0].content) && /A briefing\.$/.test(ok.host.agentMessages()[0].content));

		const bad = lapsed();
		net.refreshReply = 'offline';
		const failed = await run(CALLERS.find((c) => c.name === 'Compact'));
		assert.deepStrictEqual({ done: failed.done, reason: failed.reason }, { done: false, reason: 'failed' });
		assert.strictEqual(bad.host.agentMessages().length, 12, 'the transcript is untouched');
	});

	// ── what can only be read ────────────────────────────────────────────────────────────────────
	await test('host: authRetry is built from the host\'s own functions and session count, and handed to all three modules', () => {
		assert.ok(/^const authRetry = createAuthRetry\(\{ prepProviderRequest, refreshGatewayToken, isAuthError, sessionGeneration: \(\) => sessionGeneration, dbg \}\);$/m.test(src));
		const handed = {
			registerAiEdit: /registerAiEdit\(context, \{([\s\S]*?)\n\t\}\);/.exec(src),
			registerInlineComplete: /registerInlineComplete\(context, \{([\s\S]*?)\n\t\}\);/.exec(src),
			openSketch: /openSketch\(context, \{([^}]*)\}\)/.exec(src)
		};
		for (const [call, m] of Object.entries(handed)) {
			assert.ok(m, 'extension.js no longer calls ' + call + '(context, { … })');
			assert.ok(/(^|[\s,{])authRetry\b/.test(m[1]), call + ' is not handed authRetry');
		}
	});

	await test('every provider send outside the chat and the agent goes through it', () => {
		const read = (file) => fs.readFileSync(path.join(EXT_DIR, file), 'utf8');
		const count = (text, re) => (text.match(re) || []).length;
		const sketchSrc = read('sketch.js'), editSrc = read('aiEdit.js'), inlineSrc = read('inlineComplete.js');
		assert.strictEqual(count(sketchSrc, /providers\.(complete|streamChat|streamAgentTurn)\(/g), 3, 'sketch.js: Run, the board command, Generate flow');
		assert.strictEqual(count(sketchSrc, /sendWithAuthRetry\(\s*deps,\s*req,\s*\(r\) =>\s*providers\.(complete|streamAgentTurn)\(/g), 3, 'sketch.js sends one of them directly');
		assert.strictEqual(count(editSrc, /deps\.streamChat\(/g), 1);
		assert.strictEqual(count(editSrc, /sendWithAuthRetry\(deps, req, \(r\) => deps\.streamChat\(/g), 1, 'aiEdit.js sends directly');
		assert.strictEqual(count(inlineSrc, /[^.\w]complete\(\{/g), 1);
		assert.strictEqual(count(inlineSrc, /sendWithAuthRetry\(deps, req, \(r\) => complete\(/g), 1, 'inlineComplete.js sends directly');
		// In the host: Compact and the session-memory summary. (The chat's own send is streamChat, with its own retry.)
		assert.strictEqual(count(src, /providers\.complete\(/g), 2);
		assert.strictEqual(count(src, /authRetry\(req, \(r\) => providers\.complete\(/g), 2, 'extension.js sends one of them directly');
	});

	await test('nothing here can end a session: authRetry and the three modules hold no credentials to forget', () => {
		for (const file of ['providers/authRetry.js', 'aiEdit.js', 'sketch.js', 'inlineComplete.js']) {
			const code = fs.readFileSync(path.join(EXT_DIR, file), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');
			assert.ok(!/sessionExpired\s*\(|\bsecrets\b|globalState/.test(code), file + ' reaches for the stored session');
		}
	});

	console.log('\nauthRetryCallers: ' + n + ' tests passed.');
})().catch((e) => { console.error(e); process.exit(1); });
