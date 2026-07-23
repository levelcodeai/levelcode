/*---------------------------------------------------------------------------------------------
 *  LevelCode — AI (M2, feature 1: Chat with Claude)
 *
 *  A native chat side panel. Requests go directly from the editor to the provider
 *  (Anthropic or local Ollama) — there is no LevelCode server in the middle. The Anthropic
 *  API key is stored in VS Code SecretStorage (encrypted by the OS keychain).
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const cp = require('child_process');
const crypto = require('crypto');
const providers = require('./providers/index');
const catalog = require('./providers/catalog');
const { resolveGateway } = require('./providers/gateway');
const { registerAiEdit } = require('./aiEdit');
const { registerLmProvider } = require('./lmProvider');
const { registerInlineComplete } = require('./inlineComplete');
const { runAgent } = require('./agent');
const { findCompactionCut, estimateMsgTokens } = require('./agentMemory');
const { registerReview } = require('./reviewSession');
const { formatDiagnosticLines, diagKey } = require('./verify');
const { loadSkills, skillsMenu, getSkillBody } = require('./skills');
const { openCustomize } = require('./customize');
const { importFromVscode } = require('./importVscode');
const { reapMcp } = require('./mcpClient');

const SECRET_KEY = 'levelcode.ai.anthropicKey';   // legacy Anthropic key location (kept for back-compat)
const FILE_EXCLUDES = '{**/node_modules/**,**/.git/**,**/out/**,**/dist/**,**/.vscode-test/**,**/*.map}';
const STOPWORDS = new Set(['the','and','for','with','that','this','how','does','what','where','when','why','from','into','your','you','are','was','were','will','can','could','should','would','about','have','has','its','it','the','file','code','function','please','show','tell','explain','using','use','used','there','their','then','than','they','them','some','any','all','not','but','get','set']);
const SYSTEM_PROMPT =
	'You are LevelCode\'s built-in AI assistant, helping the user write and understand code inside their editor. ' +
	'Be concise and practical. Use Markdown and fenced code blocks. When given a code selection as context, focus your answer on it.';

/** @type {vscode.ExtensionContext} */
let ctx;
/** @type {vscode.Webview | undefined} */
let activeWebview;
/** @type {{role:string,content:string}[]} */
let conversation = [];
/** @type {string | null} */
let pendingContext = null;
/** Files pinned as chat context (whole codebase-wide context). @type {{id:string,uri:vscode.Uri,name:string,rel:string}[]} */
let contextFiles = [];
/** @type {AbortController | null} */
let abort = null;
/** Cached "signed in to LevelCode Cloud" flag — the gateway only routes when signed in, so the footer/
 *  model chip must gate on this too (kept in sync by currentAccount / storeSession / accountSignOut). */
let cloudSignedIn = false;
/** Agent mode: sending runs the autonomous tool loop instead of plain chat. */
let agentMode = true;
/** Autopilot: the agent runs commands without asking (except the danger set — see commandSafety.js)
 *  and prefers self-verifying over pausing to ask. Initialized from config on 'ready', toggled live,
 *  and persisted so an explicit opt-in survives a restart. */
let autopilot = false;
/** Apply-then-review session (Keep/Undo for applied agent edits). Set in activate(). */
let review;
/** Persistent agent transcript for the session (tool calls + results), so follow-up goals
 *  remember prior runs. Reset by New Chat. */
let agentMessages = [];

function post(msg) { if (activeWebview) { activeWebview.postMessage(msg); } }

function aiConfig() { return vscode.workspace.getConfiguration('levelcode.ai'); }

/** Inline debug trace — prints a 🐛 DEBUG line in the chat (gated by levelcode.ai.debug). */
function dbg(label, data) { if (aiConfig().get('debug', false)) { post({ type: 'debug', label, data: data != null ? data : null }); } }

/** The currently selected provider id (settings value; `claude` is the default/legacy Anthropic). */
function currentProviderId() { return providers.normId(aiConfig().get('provider', 'claude')); }

/** SecretStorage key for a provider (Anthropic keeps its legacy location; others namespaced; noKey → null). */
function secretKeyFor(providerId) { return providers.secretStorageKey(providerId); }

/** The active model id for a provider — per-provider settings for the two legacy ones, generic `model` otherwise. */
function activeModel(cfg, providerId) {
	const id = providers.normId(providerId);
	if (id === 'claude') { return cfg.get('claude.model', 'claude-sonnet-4-6'); }
	if (id === 'ollama') { return cfg.get('ollama.model', 'llama3.1'); }
	const m = cfg.get('model', '');
	if (m) { return m; }
	const p = providers.getProvider(id);
	return (p && p.models && p.models[0]) ? p.models[0].id : '';
}

/** The base URL for a provider — Ollama honors `ollama.url`, `custom` uses `levelcode.ai.baseURL`, else the registry default. */
function baseUrlFor(cfg, providerId) {
	const id = providers.normId(providerId);
	if (id === 'ollama') { return String(cfg.get('ollama.url', 'http://localhost:11434')).replace(/\/+$/, '') + '/v1'; }
	if (id === 'custom') { return String(cfg.get('baseURL', '') || '').replace(/\/+$/, ''); }
	const p = providers.getProvider(id);
	return p ? p.baseURL : null;
}

/** Max output tokens for chat/edit (shared across providers; keeps the existing Claude setting name). */
function maxOutputTokens(cfg) { return cfg.get('claude.maxTokens', 4096); }

/** An explicitly-set `levelcode.ai.contextWindow` (user override, e.g. the Claude 1M-token beta), or undefined. */
function explicitContextWindow() {
	const insp = aiConfig().inspect('contextWindow');
	if (!insp) { return undefined; }
	return insp.globalValue != null ? insp.globalValue
		: insp.workspaceValue != null ? insp.workspaceValue
		: insp.workspaceFolderValue != null ? insp.workspaceFolderValue
		: undefined;
}

/** Effective context window (tokens): an explicit user override wins; otherwise the model's real window. */
function contextLimitFor(providerId, model) {
	const explicit = explicitContextWindow();
	if (explicit != null) { return explicit; }
	return catalog.contextWindowFor(providerId, model, 200000);
}

/** The active model's context window (tokens) — drives the chat context-usage meter. */
function currentContextLimit() {
	const cfg = aiConfig();
	if (providerMode() === 'gateway' && cloudSignedIn) {
		return contextLimitFor('openai', capsModel(gatewayModel())); // Auto → flagship window (widest it could route to)
	}
	const pid = currentProviderId();
	return contextLimitFor(pid, activeModel(cfg, pid));
}

/** Prompt for — and store — the API key for a provider. Provider-aware copy. `noKey`/unknown → undefined. */
async function promptForKey(providerId) {
	const id = (typeof providerId === 'string' && providerId) ? providerId : currentProviderId();
	const p = providers.getProvider(id) || providers.getProvider('claude');
	if (p.noKey) { vscode.window.showInformationMessage('LevelCode AI: ' + p.label + ' needs no API key.'); return undefined; }
	const skey = secretKeyFor(p.id);
	const key = await vscode.window.showInputBox({
		title: 'LevelCode AI — ' + p.label + ' API Key',
		prompt: 'Paste your ' + p.label + ' API key. Stored encrypted in your OS keychain — it never leaves your machine except to ' + p.label + '.',
		password: true,
		ignoreFocusOut: true,
		placeHolder: p.kind === 'anthropic' ? 'sk-ant-…' : 'sk-…'
	});
	if (key && skey) { await ctx.secrets.store(skey, key.trim()); }
	return key ? key.trim() : undefined;
}

/** Look up a provider's key from SecretStorage; optionally prompt if missing.
 *  Returns '' for a `noKey` provider (Ollama), or `undefined` if the key is missing/declined. */
async function getProviderKey(providerId, opts) {
	const skey = secretKeyFor(providerId);
	if (!skey) { return ''; }   // noKey provider (e.g. Ollama)
	let key = await ctx.secrets.get(skey);
	if (!key && opts && opts.prompt) { key = await promptForKey(providerId); }
	return key || undefined;
}

/** User-facing message for a failed prepProviderRequest (shared by chat + edit). */
function providerErrorMessage(req) {
	if (req.reason === 'baseURL') { return 'Set a base URL for the custom OpenAI-compatible provider first (levelcode.ai.baseURL).'; }
	if (req.reason === 'insecureBaseURL') { return 'Refusing to send your API key over plain http to a non-local host. Use an https base URL (or a localhost endpoint) for the custom provider.'; }
	if (req.reason === 'insecureGateway') { return 'Refusing to send your LevelCode Cloud token over plain http. Set "levelcode.cloud.endpoint" to an https URL to use gateway mode.'; }
	return 'No API key set for ' + req.label + '. Use the key button or “LevelCode: AI: Set API Key”.';
}

/** The configured provider routing mode ('byok' default | 'gateway'). NOTE: the key is
 *  `levelcode.ai.providerMode`, NOT `provider.mode` — the latter collides with the scalar
 *  `levelcode.ai.provider` (VS Code navigates into the string → always undefined). */
function providerMode() { return aiConfig().get('providerMode', 'gateway'); }

// ── LevelCode Cloud gateway model entitlement (mirrors backend LevelCode.gateway_model) ──────────
// The free plan runs the cheap open-weights engine; a paid plan runs the flagship. The BACKEND
// is the source of truth — it forces the model per the user's wallet — so these are the CLIENT
// reflection: they drive which model the picker/footer show and let the free tier surface an
// "Upgrade" CTA. Selecting a model here never overrides the server's plan-based decision.
const GATEWAY_FREE_MODEL = 'openai/gpt-oss-120b';
const GATEWAY_FREE_LABEL = 'gpt-oss-120b';
const GATEWAY_PRO_MODEL = 'moonshotai/kimi-k2.7-code';
const GATEWAY_PRO_LABEL = 'Kimi K2.7 Code';
// "Auto" pseudo-model: the gateway routes each turn to the cheapest engine that fits (trivial →
// open-weights, standard/agent → flagship). The backend does the routing; the client just requests it.
const GATEWAY_AUTO_MODEL = 'auto';
const GATEWAY_AUTO_LABEL = 'Auto';

/** True for a paid LevelCode Cloud plan — anything managed that isn't the free tier. */
function isPaidCloudPlan(plan) {
	const p = String(plan || '').trim().toLowerCase();
	return p !== '' && p !== 'free';
}

/** The stored LevelCode Cloud plan name (from the cached profile); '' when signed out/unknown. */
function cloudPlanName() {
	const p = (ctx && ctx.globalState.get(ACCOUNT_PROFILE_KEY)) || {};
	return p.plan || '';
}

/** The active gateway model. Free plan → the open-weights engine (only option). Paid plan → the
 *  user's chosen engine (`levelcode.ai.cloudModel`: flagship OR open-weights), defaulting to the
 *  flagship. The backend re-checks entitlement, so this can never over-reach the plan. */
function gatewayModel() {
	if (!isPaidCloudPlan(cloudPlanName())) { return GATEWAY_FREE_MODEL; } // free can't pick the flagship
	// Paid: the user's chosen roster model (the picker only offers LIVE ones), else the flagship.
	// The backend re-checks entitlement + price-confirmation, so this can never over-reach the plan.
	return aiConfig().get('cloudModel', '') || GATEWAY_PRO_MODEL;
}

/** The model id to use for CAPABILITY lookups (context window, tool support). "Auto" is a routing
 *  pseudo-model resolved per-turn on the server, so for caps we use the flagship — the widest window
 *  it could route to (avoids under-reporting the context meter). Any real id passes through. */
function capsModel(id) {
	return id === GATEWAY_AUTO_MODEL ? GATEWAY_PRO_MODEL : id;
}

/** The plan model roster from the last GET /account/models fetch — powers the picker + footer labels. */
let cloudRoster = [];

/** Friendly label for a gateway model id (footer chip). Prefers the fetched roster; falls back to the
 *  built-in flagship/free labels, then the raw id. */
function gatewayModelLabel(id) {
	if (id === GATEWAY_AUTO_MODEL) { return GATEWAY_AUTO_LABEL; }
	const m = cloudRoster.find((x) => x.id === id);
	if (m) { return m.label; }
	if (id === GATEWAY_PRO_MODEL) { return GATEWAY_PRO_LABEL; }
	if (id === GATEWAY_FREE_MODEL) { return GATEWAY_FREE_LABEL; }
	return id;
}

/** Fetch the plan's model roster (entitled models + credits + ≈ turns-left). Caches it for the
 *  footer/picker. Best-effort; returns null when signed out / offline / not gateway. */
async function fetchCloudRoster() {
	if (providerMode() !== 'gateway' || !cloudSignedIn || !ctx) { return null; }
	const token = await ctx.secrets.get(ACCOUNT_TOKEN_KEY);
	if (!token) { return null; }
	const api = cloudApiUrl();
	if (!/^https:\/\//i.test(api) && !/^http:\/\/(localhost|127\.0\.0\.1)([:/]|$)/i.test(api)) { return null; }
	try {
		const res = await fetch(api + '/api/levelcode/v1/account/models', { headers: { authorization: 'Bearer ' + token } });
		if (!res.ok) { dbg('cloud.roster', { ok: false, status: res.status }); return null; }
		const data = await res.json().catch(() => null);
		if (data && Array.isArray(data.models)) {
			cloudRoster = data.models;
			// The roster carries each model's short label — refresh the footer chip so it shows
			// "Opus 4.8" instead of the raw id it fell back to before the roster finished loading.
			sendConfigToWebview();
		}
		return data;
	} catch (e) { dbg('cloud.roster', { error: String((e && e.message) || e) }); return null; }
}

/**
 * Report a 👍/👎 reaction to LevelCode Cloud as a per-model quality signal — but ONLY on the
 * metered gateway when signed in. BYOK stays fully private: the reaction is a local toggle
 * and nothing leaves the machine. Best-effort + fire-and-forget (feedback is low-stakes).
 */
async function recordFeedback(rating, turnModel) {
	if (rating !== 'up' && rating !== 'down') { return; }
	if (providerMode() !== 'gateway' || !cloudSignedIn) { return; }   // BYOK / signed out → local only
	const token = ctx ? await ctx.secrets.get(ACCOUNT_TOKEN_KEY) : null;
	if (!token) { return; }
	const api = cloudApiUrl();
	if (!/^https:\/\//i.test(api) && !/^http:\/\/(localhost|127\.0\.0\.1)([:/]|$)/i.test(api)) { return; }
	// The model the RATED turn actually ran on (stamped by the webview), falling back to the
	// current entitlement — so a mid-session plan change can't misattribute the vote.
	const model = (typeof turnModel === 'string' && turnModel) ? turnModel : gatewayModel();
	try {
		await fetch(api + '/api/levelcode/v1/feedback', {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
			body: JSON.stringify({ rating, model })
		});
		dbg('feedback.post', { rating, model });
	} catch (e) { dbg('feedback.post', { error: String((e && e.message) || e) }); }
}

/** True when an error thrown by a provider adapter is an auth failure (HTTP 401) — used to trigger
 *  a single gateway-token refresh + retry. The openai adapter throws `<label> API 401: <body>`. */
function isAuthError(e) { return /\bAPI 401\b|\b401\b.*unauthor/i.test(String((e && e.message) || e)); }

/**
 * Refresh the LevelCode Cloud access token in gateway mode: POST the stored refresh token to
 * {apiUrl}/api/levelcode/v1/auth/refresh (the Rails backend), store the new access token, return true.
 * No-op (returns false) when not applicable (byok, signed out, no refresh token, or non-https apiUrl).
 */
async function refreshCloudToken() {
	if (!ctx) { return false; }
	const endpoint = cloudApiUrl();
	if (!/^https:\/\//i.test(endpoint) && !/^http:\/\/(localhost|127\.0\.0\.1)([:/]|$)/i.test(endpoint)) { return false; }
	const refresh = await ctx.secrets.get(ACCOUNT_REFRESH_KEY);
	if (!refresh) { return false; }
	try {
		const res = await fetch(endpoint + '/api/levelcode/v1/auth/refresh', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ refresh })
		});
		if (!res.ok) { dbg('cloud.refresh', { ok: false, status: res.status }); return false; }
		const data = await res.json().catch(() => null);
		const access = data && (data.access || data.token);
		if (!access) { return false; }
		await ctx.secrets.store(ACCOUNT_TOKEN_KEY, access);
		dbg('cloud.refresh', { ok: true });
		return true;
	} catch (e) { dbg('cloud.refresh', { error: String((e && e.message) || e) }); return false; }
}

/** Gateway-mode token refresh (the streaming 401 retry path). Delegates to refreshCloudToken. */
async function refreshGatewayToken() {
	if (providerMode() !== 'gateway') { return false; }
	return refreshCloudToken();
}

/**
 * Resolve everything needed to call the active provider: id, key, model, baseURL, maxTokens.
 * Returns { ok:false, reason } when a required key/baseURL is missing (after optional prompting) or
 * a custom endpoint would leak the key over plaintext — the caller renders providerErrorMessage().
 * @returns {Promise<{ok:boolean, providerId?:string, apiKey?:string, model?:string, baseURL?:string, maxTokens?:number, label?:string, reason?:string}>}
 */
async function prepProviderRequest(opts) {
	const cfg = aiConfig();
	// Gateway mode: when signed in (a cloud token is present) and mode==='gateway', route AI through the
	// LevelCode Cloud metered gateway (an openai-kind endpoint) instead of the user's own provider/key. Falls
	// back to the BYOK path below when signed out or in byok mode — the default is untouched.
	const token = ctx ? await ctx.secrets.get(ACCOUNT_TOKEN_KEY) : null;
	const gw = resolveGateway({ mode: providerMode(), endpoint: cloudApiUrl(), token: token || '' });
	if (gw.use) {
		if (!gw.ok) { return { ok: false, providerId: 'openai', label: 'LevelCode Cloud', reason: gw.reason }; }
		return {
			ok: true, providerId: gw.providerId, apiKey: gw.apiKey,
			// Plan-scoped model (free → gpt-oss-120b, paid → Kimi K2.7 Code). The backend
			// re-forces this per the wallet, so we send the entitled model, not the BYOK one.
			model: gatewayModel(),
			baseURL: gw.baseURL,
			maxTokens: maxOutputTokens(cfg),
			label: 'LevelCode Cloud',
			gateway: true
		};
	}
	const providerId = currentProviderId();
	const p = providers.getProvider(providerId) || providers.getProvider('claude');
	const baseURL = baseUrlFor(cfg, providerId);
	if (providerId === 'custom' && !baseURL) {
		return { ok: false, providerId, label: p.label, reason: 'baseURL' };
	}
	let apiKey = '';
	if (!p.noKey) {
		apiKey = await getProviderKey(providerId, opts);
		if (!apiKey) { return { ok: false, providerId, label: p.label, reason: 'key' }; }
	}
	if (providerId === 'custom' && apiKey && providers.isInsecureCustomUrl(baseURL)) {
		return { ok: false, providerId, label: p.label, reason: 'insecureBaseURL' };
	}
	return {
		ok: true, providerId, apiKey,
		model: activeModel(cfg, providerId),
		baseURL,
		maxTokens: maxOutputTokens(cfg),
		label: p.label
	};
}

function captureSelection() {
	const ed = vscode.window.activeTextEditor;
	if (!ed || ed.selection.isEmpty) { return null; }
	const text = ed.document.getText(ed.selection);
	const lang = ed.document.languageId || '';
	const name = ed.document.uri.scheme === 'file' ? path.basename(ed.document.uri.fsPath) : 'selection';
	const lines = ed.selection.end.line - ed.selection.start.line + 1;
	return {
		block: 'Context from `' + name + '`:\n```' + lang + '\n' + text + '\n```',
		label: name + ' · ' + lines + ' line' + (lines === 1 ? '' : 's')
	};
}

function addSelection() {
	const sel = captureSelection();
	if (!sel) { vscode.window.showInformationMessage('LevelCode AI: select some code first.'); return; }
	pendingContext = sel.block;
	vscode.commands.executeCommand('levelcodeAi.chat.focus');
	post({ type: 'context', label: sel.label });
}

function postContextFiles() {
	post({ type: 'contextFiles', files: contextFiles.map((f) => ({ id: f.id, name: f.name, rel: f.rel })) });
}

function removeFileContext(id) {
	contextFiles = contextFiles.filter((f) => f.id !== id);
	postContextFiles();
}

/** Unified "+ Add context" picker: choose the current selection and/or files from the workspace. */
async function addContext() {
	/** @type {any[]} */
	const items = [];
	const sel = captureSelection();
	if (sel) { items.push({ label: '$(selection) Selected code', description: sel.label, _kind: 'sel', _sel: sel }); }

	const uris = await vscode.workspace.findFiles('**/*', FILE_EXCLUDES, 5000);
	if (sel && uris.length) { items.push({ label: 'Workspace files', kind: vscode.QuickPickItemKind.Separator }); }
	for (const u of uris) {
		items.push({ label: '$(file) ' + path.basename(u.fsPath), description: vscode.workspace.asRelativePath(u), _kind: 'file', _uri: u });
	}
	if (!items.length) { vscode.window.showInformationMessage('LevelCode AI: no workspace files to add.'); return; }

	const picks = await vscode.window.showQuickPick(items, {
		canPickMany: true,
		matchOnDescription: true,
		placeHolder: 'Add context — pick the selection and/or files (type to filter)'
	});
	if (!picks || !picks.length) { return; }

	for (const p of picks) {
		if (p._kind === 'sel') {
			pendingContext = p._sel.block;
			post({ type: 'context', label: p._sel.label });
		} else if (p._kind === 'file') {
			const id = p._uri.fsPath;
			if (!contextFiles.find((f) => f.id === id)) {
				contextFiles.push({ id, uri: p._uri, name: path.basename(id), rel: vscode.workspace.asRelativePath(p._uri) });
			}
		}
	}
	vscode.commands.executeCommand('levelcodeAi.chat.focus');
	postContextFiles();
}

/** Read pinned context files as content blocks, capped to protect the context window. */
async function contextFileBlocks() {
	const PER_FILE = 80 * 1024;
	const TOTAL = 250 * 1024;
	const blocks = [];
	let used = 0;
	for (const f of contextFiles) {
		try {
			const doc = await vscode.workspace.openTextDocument(f.uri);
			let body = doc.getText();
			if (body.length > PER_FILE) { body = body.slice(0, PER_FILE) + '\n…(file truncated for context)…'; }
			if (used + body.length > TOTAL) { blocks.push('…(some pinned files omitted to fit the context window)…'); break; }
			used += body.length;
			blocks.push('File `' + f.rel + '`:\n```' + (doc.languageId || '') + '\n' + body + '\n```');
		} catch { /* unreadable/binary file — skip */ }
	}
	return blocks;
}

/** List workspace files once (cached per send), respecting the standard excludes. */
async function listWorkspaceFiles() {
	if (!vscode.workspace.workspaceFolders || !vscode.workspace.workspaceFolders.length) { return []; }
	return vscode.workspace.findFiles('**/*', FILE_EXCLUDES, 5000);
}

/** Identifiers/keywords from a question, minus common stop-words. */
function extractKeywords(text) {
	const raw = text.match(/[A-Za-z_][A-Za-z0-9_]{2,}/g) || [];
	const seen = new Set();
	const out = [];
	for (const w of raw) {
		const lw = w.toLowerCase();
		if (STOPWORDS.has(lw) || seen.has(lw)) { continue; }
		seen.add(lw);
		out.push(w);
		if (out.length >= 12) { break; }
	}
	return out;
}

/** Resolve the ripgrep binary bundled with the editor (dev and packaged paths differ). */
let _rgPath; // cached: string | null
function rgPath() {
	if (_rgPath !== undefined) { return _rgPath; }
	const root = vscode.env.appRoot;
	const candidates = [
		path.join(root, 'node_modules', '@vscode', 'ripgrep', 'bin', 'rg'),
		path.join(root, 'node_modules', '@vscode', 'ripgrep-universal', 'bin', process.platform + '-' + process.arch, 'rg'),
		path.join(root, 'node_modules.asar.unpacked', '@vscode', 'ripgrep', 'bin', 'rg')
	];
	_rgPath = candidates.find((c) => { try { return fs.existsSync(c); } catch { return false; } }) || null;
	return _rgPath;
}

/** Files (absolute paths) under cwd whose CONTENT contains the literal term. Empty on any failure. */
function rgFiles(term, cwd) {
	return new Promise((resolve) => {
		const bin = rgPath();
		if (!bin || !cwd) { resolve([]); return; }
		const args = [
			'--files-with-matches', '--no-messages', '--no-config', '-i', '-F',
			'--max-filesize', '1M', '--max-count', '1',
			'-g', '!**/node_modules/**', '-g', '!**/.git/**', '-g', '!**/out/**',
			'-g', '!**/dist/**', '-g', '!**/*.map', '-g', '!**/*.min.*',
			'-e', term, '.'
		];
		let out = '';
		let done = false;
		const finish = (paths) => { if (!done) { done = true; resolve(paths); } };
		try {
			const child = cp.spawn(bin, args, { cwd });
			const timer = setTimeout(() => { try { child.kill(); } catch { /* noop */ } finish([]); }, 4000);
			child.stdout.on('data', (d) => { out += d.toString(); });
			child.on('error', () => { clearTimeout(timer); finish([]); });
			child.on('close', () => {
				clearTimeout(timer);
				finish(out.split('\n').map((s) => s.trim()).filter(Boolean).map((rel) => path.resolve(cwd, rel)));
			});
		} catch { finish([]); }
	});
}

/** Scope retrieval to the active file's top-level sub-project, so unrelated sibling trees
 *  (e.g. a vendored source dump) don't pollute results. Returns the search dir + rel prefix. */
function activeProjectScope() {
	const folders = vscode.workspace.workspaceFolders || [];
	const fallback = { dir: folders.length ? folders[0].uri.fsPath : '', prefix: '' };
	if (!aiConfig().get('chat.scopeToActiveProject', true)) { return fallback; }
	const ed = vscode.window.activeTextEditor;
	if (!ed || ed.document.uri.scheme !== 'file') { return fallback; }
	const wsFolder = vscode.workspace.getWorkspaceFolder(ed.document.uri);
	if (!wsFolder) { return fallback; }
	const rel = path.relative(wsFolder.uri.fsPath, ed.document.uri.fsPath);
	if (!rel || rel.startsWith('..')) { return fallback; }
	const top = rel.split(path.sep)[0];
	const topPath = path.join(wsFolder.uri.fsPath, top);
	try { if (!fs.statSync(topPath).isDirectory()) { return fallback; } } catch { return fallback; }
	return { dir: topPath, prefix: top + '/' };
}

/** A specific identifier (long or camelCase) is a much stronger relevance signal than a common word. */
function contentWeight(kw) {
	return (kw.length >= 8 || /[A-Z]/.test(kw.slice(1))) ? 6 : 3;
}

/**
 * Auto-discover files relevant to the question via ripgrep content search (primary),
 * filename matches, and workspace symbols — scoped to the active sub-project. Returns their
 * contents as context blocks (capped). Skips the active & pinned files; thresholds out noise.
 * @returns {Promise<{blocks:string[], names:string[]}>}
 */
async function gatherAutoContext(question, allFiles) {
	const cfg = aiConfig();
	const keywords = extractKeywords(question);
	if (!keywords.length) { return { blocks: [], names: [] }; }
	const scope = activeProjectScope();
	const inScope = (uri) => !scope.prefix || vscode.workspace.asRelativePath(uri).startsWith(scope.prefix);

	/** @type {Map<string,{uri:vscode.Uri,score:number}>} */
	const score = new Map();
	const bump = (uri, s) => {
		const k = uri.fsPath;
		const cur = score.get(k);
		if (cur) { cur.score += s; } else { score.set(k, { uri, score: s }); }
	};

	// 1. CONTENT search via ripgrep (primary signal — finds files by what's inside them).
	const terms = keywords.slice(0, 6);
	const hits = await Promise.all(terms.map((kw) => rgFiles(kw, scope.dir)));
	for (let i = 0; i < terms.length; i++) {
		for (const abs of hits[i]) { bump(vscode.Uri.file(abs), contentWeight(terms[i])); }
	}

	// 2. filename matches (scoped).
	for (const u of allFiles) {
		if (!inScope(u)) { continue; }
		const base = path.basename(u.fsPath).toLowerCase();
		for (const kw of keywords) { if (kw.length >= 3 && base.includes(kw.toLowerCase())) { bump(u, 4); } }
	}

	// 3. workspace symbols (scoped; uses language-server indexes when present).
	for (const kw of terms) {
		let syms = [];
		try { syms = await vscode.commands.executeCommand('vscode.executeWorkspaceSymbolProvider', kw) || []; } catch { syms = []; }
		for (const sym of syms.slice(0, 20)) {
			const uri = sym && sym.location && sym.location.uri;
			if (!uri || !inScope(uri)) { continue; }
			const exact = sym.name && sym.name.toLowerCase() === kw.toLowerCase();
			bump(uri, exact ? 5 : 2);
		}
	}

	const MIN_SCORE = 4; // a single common-word match (3) is not enough on its own.
	const activeUri = vscode.window.activeTextEditor ? vscode.window.activeTextEditor.document.uri.fsPath : null;
	const pinned = new Set(contextFiles.map((f) => f.id));
	const max = Math.max(0, cfg.get('chat.autoContextMaxFiles', 4));
	const ranked = [...score.values()]
		.filter((e) => e.score >= MIN_SCORE && e.uri.fsPath !== activeUri && !pinned.has(e.uri.fsPath))
		.sort((a, b) => b.score - a.score)
		.slice(0, max);

	const blocks = [];
	const names = [];
	let used = 0;
	const PER = 60 * 1024, TOTAL = 180 * 1024;
	for (const e of ranked) {
		try {
			const doc = await vscode.workspace.openTextDocument(e.uri);
			let body = doc.getText();
			if (body.length > PER) { body = body.slice(0, PER) + '\n…(truncated)…'; }
			if (used + body.length > TOTAL) { break; }
			used += body.length;
			const rel = vscode.workspace.asRelativePath(e.uri);
			blocks.push('Possibly relevant file `' + rel + '`:\n```' + (doc.languageId || '') + '\n' + body + '\n```');
			names.push(rel);
		} catch { /* unreadable/binary — skip */ }
	}
	return { blocks, names };
}

/** A compact list of project file paths, so the model knows the repo structure. */
function workspaceMapBlock(allFiles) {
	if (!allFiles.length) { return null; }
	const rels = allFiles.map((u) => vscode.workspace.asRelativePath(u)).sort();
	const CAP = 400;
	let list = rels.slice(0, CAP).join('\n');
	if (rels.length > CAP) { list += '\n…(' + (rels.length - CAP) + ' more files)…'; }
	return 'Project files (paths only, for orientation):\n```\n' + list + '\n```';
}

function newChat() {
	conversation = [];
	agentMessages = [];
	checkpoints.length = 0; currentCheckpoint = null;   // drop the per-turn restore stack
	pendingContext = null;
	contextFiles = [];
	if (abort) { abort.abort(); }
	reapCommands();                        // kill any background servers/watchers from the old session
	reapMcp();                             // …and any MCP servers: they are detached children too
	if (review) { review.finalizeAll(); } // drop review UI without reverting the user's files
	post({ type: 'reset' });
	postContextFiles();
}

/** The currently open file as a context block (capped), or null. */
/** True only for real files inside the workspace (excludes temp diff files, output, etc.). */
function isWorkspaceFile(uri) {
	return uri && uri.scheme === 'file' && !!vscode.workspace.getWorkspaceFolder(uri);
}

function activeFileBlock() {
	const ed = vscode.window.activeTextEditor;
	if (!ed || !isWorkspaceFile(ed.document.uri)) { return null; }
	if (!aiConfig().get('includeActiveFile', true)) { return null; }
	const name = path.basename(ed.document.uri.fsPath);
	const lang = ed.document.languageId || '';
	let body = ed.document.getText();
	const MAX = 120 * 1024;
	if (body.length > MAX) { body = body.slice(0, MAX) + '\n…(file truncated for context)…'; }
	return 'Currently open file `' + name + '` (full contents):\n```' + lang + '\n' + body + '\n```';
}

/** Tell the webview which file is open, to show as a context chip. */
function postActiveFile() {
	const ed = vscode.window.activeTextEditor;
	if (!ed || !isWorkspaceFile(ed.document.uri) || !aiConfig().get('includeActiveFile', true)) {
		post({ type: 'activeFile', label: null });
		return;
	}
	post({ type: 'activeFile', label: path.basename(ed.document.uri.fsPath) + ' · ' + ed.document.lineCount + ' lines' });
}

/** Running approved commands: runId → stop() that kills the command's process group. */
const commandStops = new Map();
// Background command registry (runId → {command,status,ring,port,…}) so the agent can read a server's
// output across turns via read_command_output. Module-scoped so it survives between agent runs; reaped
// on New Chat + extension unload (servers hold ports — orphaning them breaks the next run).
const bgRuns = new Map();
/** Kill every running command and drop all command state (servers must not survive New Chat/unload). */
function reapCommands() {
	for (const [, stop] of commandStops) { try { stop(); } catch (e) { /* already gone */ } }
	commandStops.clear();
	bgRuns.clear();
}

// Workspace checkpoints: a per-user-turn stack of file pre-images so the user can roll the workspace back
// to before any turn ran. In-memory per chat session (reset on New Chat); NOT routed through reapCommands
// (these are pure data, not process state — restoring files must not kill running servers).
const checkpoints = [];        // oldest-first: { turnId, label, ts, goalMsg, files: Map<key,{before,created}> }
let currentCheckpoint = null;
let checkpointSeq = 0;
/** First-touch hook handed to reviewSession.applyEdit — record a file's pre-image into the open turn. */
function recordCheckpointTouch(key, before, created) {
	if (currentCheckpoint && !currentCheckpoint.files.has(key)) { currentCheckpoint.files.set(key, { before: before, created: created }); }
}
/** Restore the workspace to before `turnId` ran — reverting that turn AND every turn after it. */
async function restoreCheckpoint(turnId) {
	if (abort) { post({ type: 'checkpointBusy', turnId: turnId }); return; }   // never restore under a live turn
	const idx = checkpoints.findIndex((c) => c.turnId === turnId);
	if (idx < 0) { post({ type: 'checkpointBusy', turnId: turnId, reason: 'gone' }); return; }
	const cp = checkpoints[idx];
	const cutIdx = agentMessages.indexOf(cp.goalMsg);                        // by identity → survives trimAgentMemory
	// Union of files across this checkpoint + every later one; EARLIEST pre-image wins (true pre-turn state).
	const union = new Map();
	for (let i = idx; i < checkpoints.length; i++) {
		for (const [k, v] of checkpoints[i].files) { if (!union.has(k)) { union.set(k, v); } }
	}
	let restored = 0;
	for (const k of [...union.keys()].reverse()) {                          // reverse for interdependency safety
		const v = union.get(k);
		try { if (await review.restoreOne(k, v.before, v.created)) { restored++; } } catch (e) { dbg('checkpoint.restoreErr', { key: k, msg: String((e && e.message) || e) }); }
	}
	review.finalizeAll();                                                   // pending Keep/Undo cards now reference stale snapshots
	if (cutIdx >= 0) { agentMessages.length = cutIdx; }                     // truncate transcript at the goal boundary
	checkpoints.length = idx;                                              // drop restored + all later checkpoints (no redo)
	dbg('checkpoint.restore', { turnId: turnId, files: restored, truncatedAt: cutIdx });
	post({ type: 'checkpointRestored', turnId: turnId, filesRestored: restored });
}

/** Pending in-chat approval requests, keyed by id, resolved by the webview. */
const pendingApprovals = new Map();
let approvalSeq = 0;

/** Ask the webview to approve an action; resolves true/false. */
function requestApproval(req) {
	const id = String(++approvalSeq);
	dbg('approval.request', { id, kind: req.kind, cmd: req.command });
	return new Promise((resolve) => {
		pendingApprovals.set(id, resolve);
		post(Object.assign({ type: 'agentApproval', id }, req));
	});
}
function resolveApproval(id, approved) {
	dbg('approval.response', { id, approved: !!approved });
	const r = pendingApprovals.get(id);
	if (r) { pendingApprovals.delete(id); r(!!approved); }
}
function clearApprovals() {
	for (const [, r] of pendingApprovals) { r(false); }
	pendingApprovals.clear();
}

/** Pending in-chat clarifying-question prompts (ask_user), keyed by id, resolved by the webview. */
const pendingQuestions = new Map();
let questionSeq = 0;

/** Ask the webview to present clickable multiple-choice questions; resolves with {answers, notes} or null. */
function requestQuestions(req) {
	const id = String(++questionSeq);
	dbg('ask.request', { id, questions: (req.questions || []).length });
	return new Promise((resolve) => {
		pendingQuestions.set(id, resolve);
		post({ type: 'agentQuestions', id, questions: req.questions || [] });
	});
}
function resolveQuestions(id, answers, notes) {
	dbg('ask.response', { id, answered: Array.isArray(answers) ? answers.length : 0, notes: !!notes });
	const r = pendingQuestions.get(id);
	if (r) { pendingQuestions.delete(id); r({ answers: answers || [], notes: notes || '' }); }
}
function clearQuestions() {
	for (const [, r] of pendingQuestions) { r(null); }
	pendingQuestions.clear();
}

/** Heal any dangling tool_use (e.g. from a run the user stopped mid-tool) by inserting the
 *  missing tool_result blocks, so the next API call doesn't 400. */
function repairAgentMemory() {
	for (let i = 0; i < agentMessages.length; i++) {
		const m = agentMessages[i];
		if (m.role !== 'assistant' || !Array.isArray(m.content)) { continue; }
		const ids = m.content.filter((c) => c.type === 'tool_use').map((c) => c.id);
		if (!ids.length) { continue; }
		const next = agentMessages[i + 1];
		const have = (next && next.role === 'user' && Array.isArray(next.content))
			? new Set(next.content.filter((c) => c.type === 'tool_result').map((c) => c.tool_use_id)) : new Set();
		const missing = ids.filter((id) => !have.has(id)).map((id) => ({ type: 'tool_result', tool_use_id: id, content: 'Cancelled.' }));
		if (!missing.length) { continue; }
		if (next && next.role === 'user' && Array.isArray(next.content)) { next.content.unshift(...missing); }
		else { agentMessages.splice(i + 1, 0, { role: 'user', content: missing }); }
	}
}

/** Keep agent memory bounded. Trim oldest messages, but only at a goal boundary (a
 *  string-content user message) so we never orphan a tool_use/tool_result pair. */
// --- M5 auto-verify: editor-diagnostics gathering (vscode glue; pure formatting lives in verify.js) ---
/** Pre-run snapshot of every diagnostic so we only ever report problems the agent NEWLY introduced
 *  (keyed by severity+message, not position, so they survive the line shifts an edit causes). */
function snapshotDiagnostics() {
	const base = new Map();
	for (const [uri, diags] of vscode.languages.getDiagnostics()) {
		const set = new Set();
		for (const d of diags) { set.add(diagKey(d.severity, d.message)); }
		base.set(uri.toString(), set);
	}
	return base;
}
/** Language servers publish diagnostics asynchronously after a save — wait until they settle (a quiet
 *  period after the last relevant change) or a hard cap, so we don't read stale/empty results. */
function waitForDiagnostics(uris, maxMs) {
	return new Promise((resolve) => {
		if (!uris.length) { resolve(); return; }
		const want = new Set(uris.map((u) => u.toString()));
		let done = false, quiet = null;
		const finish = () => { if (done) { return; } done = true; if (quiet) { clearTimeout(quiet); } clearTimeout(hard); sub.dispose(); resolve(); };
		const sub = vscode.languages.onDidChangeDiagnostics((e) => {
			if (e.uris.some((u) => want.has(u.toString()))) { if (quiet) { clearTimeout(quiet); } quiet = setTimeout(finish, 250); }
		});
		const hard = setTimeout(finish, maxMs);
	});
}
async function collectNewDiagnostics(uris, baseline, includeWarnings) {
	if (!uris.length) { return { text: '', count: 0 }; }
	await waitForDiagnostics(uris, 1500);
	const perFile = uris.map((uri) => ({
		rel: vscode.workspace.asRelativePath(uri),
		uriKey: uri.toString(),
		diags: (vscode.languages.getDiagnostics(uri) || []).map((d) => ({
			severity: d.severity, message: d.message, source: d.source,
			line: d.range.start.line, character: d.range.start.character
		}))
	}));
	return formatDiagnosticLines(perFile, baseline, includeWarnings, 40);
}

function trimAgentMemory() {
	const MAX = 80, KEEP = 60;
	if (agentMessages.length <= MAX) { return; }
	let cut = agentMessages.length - KEEP;
	while (cut < agentMessages.length && !(agentMessages[cut].role === 'user' && typeof agentMessages[cut].content === 'string')) { cut++; }
	if (cut > 0 && cut < agentMessages.length) { agentMessages.splice(0, cut); }
}

/** Flatten one transcript message to a compact plain-text line for the summarizer. Per-item caps keep
 *  a single giant file read or command dump from dominating (or blowing) the summary call's own input. */
function serializeMsgForSummary(m) {
	const who = m.role === 'assistant' ? 'Assistant' : 'User';
	if (typeof m.content === 'string') { return who + ': ' + m.content.slice(0, 4000); }
	if (!Array.isArray(m.content)) { return who + ': ' + JSON.stringify(m.content).slice(0, 2000); }
	const parts = [];
	for (const c of m.content) {
		if (c.type === 'text' && c.text) { parts.push(c.text.slice(0, 4000)); }
		else if (c.type === 'tool_use') { parts.push('[calls ' + c.name + ' ' + JSON.stringify(c.input || {}).slice(0, 400) + ']'); }
		else if (c.type === 'tool_result') { const t = typeof c.content === 'string' ? c.content : JSON.stringify(c.content); parts.push('[tool result: ' + String(t).slice(0, 800) + ']'); }
	}
	return who + ': ' + parts.join('\n');
}

const COMPACT_SYSTEM = 'You compress a coding-agent conversation into a durable briefing so the agent can continue in a fresh, shorter context. Preserve everything future work depends on; drop everything it does not.';
const COMPACT_INSTRUCTIONS = [
	'Summarize the conversation below into a compact briefing the agent will read INSTEAD of the full history.',
	'Use tight bullet lists under clear headings, keeping:',
	'- The user’s goal(s) and any explicit constraints or preferences.',
	'- Decisions and approaches chosen — and rejected, with why.',
	'- Files created/edited and what changed; key file/function names and paths.',
	'- Commands run and their outcomes; anything currently broken or pending.',
	'- The exact current task state — what is done, and what is next.',
	'Omit chit-chat, resolved dead-ends, and raw file/command dumps. Be specific (names, paths, numbers). Invent nothing not present below.',
	'',
	'--- CONVERSATION ---',
	''
].join('\n');

/** Manually compact the session transcript: summarize the bulky head (everything up to a recent goal
 *  boundary) into one message and keep recent turns verbatim, so a long session can continue instead of
 *  hitting the model’s context window. Provider-agnostic: it flattens the head to text and asks the model
 *  for a briefing, so no tool_use/tool_result pairing or tool defs are involved. Cutting only at a goal
 *  boundary (a user STRING message) is the one splice point that can’t orphan a tool_use/tool_result pair.
 *  NOTE: rewriting the prefix invalidates prompt caching — the next turn pays one cache write. That is the
 *  intended trade: a one-off rebuild on a much shorter base beats re-sending the whole transcript forever. */
async function compactAgentMemory() {
	if (abort) { return { ok: false, reason: 'running' }; }
	const msgs = agentMessages;
	const KEEP_RECENT = 8;
	const beforeMsgTokens = estimateMsgTokens(msgs);
	if (msgs.length <= KEEP_RECENT + 2) { return { ok: false, reason: 'small' }; }
	const cut = findCompactionCut(msgs, KEEP_RECENT);
	if (cut < 0) { return { ok: false, reason: 'noboundary' }; }

	// Cap the summarizer input, but keep BOTH ends when it's too long: the opening (the original goal +
	// early constraints, first in the transcript) AND the most recent pre-cut decisions (closest to the
	// kept tail). Those are the two highest-value regions — a plain head slice would drop the recent
	// decisions. Only the lower-value middle is dropped, with a marker.
	const flatFull = msgs.slice(0, cut).map(serializeMsgForSummary).join('\n\n');
	const CAP = 60000, HEAD = 20000;
	const flat = flatFull.length <= CAP
		? flatFull
		: flatFull.slice(0, HEAD) + '\n\n…[older turns omitted for length]…\n\n' + flatFull.slice(flatFull.length - (CAP - HEAD));
	const anchor = msgs[cut];   // identity of the boundary we'll cut at — see the recheck after the await
	const req = await prepProviderRequest({ prompt: true });
	if (!req.ok) { return { ok: false, reason: 'provider' }; }

	let summary;
	try {
		summary = await providers.complete({
			providerId: req.providerId, apiKey: req.apiKey, baseURL: req.baseURL,
			model: req.model, maxTokens: 1500,
			system: COMPACT_SYSTEM,
			messages: [{ role: 'user', content: COMPACT_INSTRUCTIONS + flat }]
		});
	} catch (e) { dbg('compact.error', { msg: String((e && e.message) || e) }); return { ok: false, reason: 'failed' }; }
	if (!summary || !summary.trim()) { return { ok: false, reason: 'empty' }; }

	// The summary call awaited for seconds; the transcript may have moved under us — refuse rather than
	// splice at a stale place. Three ways it moves: New chat reassigns agentMessages; a checkpoint restore
	// or a started turn's trimAgentMemory splices the HEAD (caught by the anchor identity check); and a
	// turn STARTED mid-await (`abort` now set) may be streaming from this very array — splicing its prefix
	// would inject this (billed) summary and blow its cache mid-run. In every case, yield: the transcript
	// is unharmed and the user can compact again once the turn ends.
	if (agentMessages !== msgs || msgs[cut] !== anchor || abort) { dbg('compact.stale', { cut, running: !!abort }); return { ok: false, reason: 'changed' }; }

	// Replace the head with [summary(user) → ack(assistant)]; the kept tail begins with the user goal at
	// `cut`, so role alternation (user → assistant → user …) holds across the seam.
	msgs.splice(0, cut,
		{ role: 'user', content: '[Summary of the earlier conversation, compacted to save context]\n\n' + summary.trim() },
		{ role: 'assistant', content: 'Got it — I have that summary of the work so far and will continue from here.' }
	);
	// Drop checkpoints whose goal message was summarized away: restoreCheckpoint can no longer truncate the
	// transcript for them (it guards on indexOf), so keeping them would offer a half-working rollback.
	for (let i = checkpoints.length - 1; i >= 0; i--) { if (msgs.indexOf(checkpoints[i].goalMsg) < 0) { checkpoints.splice(i, 1); } }

	const afterMsgTokens = estimateMsgTokens(msgs);
	dbg('compact.done', { cut, beforeMsgTokens, afterMsgTokens, msgs: msgs.length });
	return { ok: true, beforeMsgTokens, afterMsgTokens };
}

let lastAgentGoal = null;   // remembered so the response bar's Retry can re-run it
async function agentFlow(text) {
	if (text && text.trim()) { lastAgentGoal = text; }
	const cfg = aiConfig();
	const providerId = currentProviderId();
	const agentModel = activeModel(cfg, providerId);
	if (!catalog.supportsToolsForModel(providerId, agentModel)) {
		const p = providers.getProvider(providerId);
		const who = agentModel ? '“' + agentModel + '”' : ((p && p.label) || 'This provider');
		post({ type: 'agentError', message: 'Agent mode needs a tool-capable model. ' + who + ' isn’t set up for tool use in LevelCode — it still works for chat, inline completion and edits. Pick a tool-capable model (Claude, GPT-4o, or most OpenRouter / Groq / DeepSeek / Mistral models) via “LevelCode: AI: Select Model…”.' });
		post({ type: 'agentDone', reason: 'error' });
		return;
	}
	const req = await prepProviderRequest({ prompt: true });
	if (!req.ok) { post({ type: 'agentError', message: providerErrorMessage(req) }); post({ type: 'agentDone', reason: 'error' }); return; }

	post({ type: 'agentStart' });
	abort = new AbortController();
	repairAgentMemory();
	// Open a workspace checkpoint for this turn (before the goal is pushed) so the user can roll back here.
	const goalMsg = { role: 'user', content: text };
	currentCheckpoint = { turnId: ++checkpointSeq, label: (text || '').slice(0, 60), ts: Date.now(), goalMsg: goalMsg, files: new Map() };
	checkpoints.push(currentCheckpoint);
	post({ type: 'checkpointOpened', turnId: currentCheckpoint.turnId });
	agentMessages.push(goalMsg);
	trimAgentMemory();
	dbg('agent.start', { provider: req.providerId, model: req.model, maxSteps: cfg.get('agent.maxSteps', 25), transcriptMsgs: agentMessages.length, goalChars: text.length });
	// Auto-verify: capture a pre-run diagnostics baseline (so we only flag NEW problems) and a fresh
	// per-run set of edited files to verify afterward.
	const verifyCfg = {
		enabled: cfg.get('verify.enabled', true),
		command: cfg.get('verify.command', ''),
		maxRounds: Math.max(0, cfg.get('verify.maxRounds', 2)),
		includeWarnings: cfg.get('verify.includeWarnings', false)
	};
	const runTouched = new Set();   // abs paths edited this run (agent.js fills it via ctx.touched)
	// M6.5 implicit skills: scan bundled SKILL.md once, expose a tiny menu()/getBody() resolver to the agent.
	let skillsObj = null;
	if (cfg.get('skills.enabled', true)) {
		const skillIndex = loadSkills(ctx.extensionPath, dbg);
		if (skillIndex.size) { skillsObj = { menu: () => skillsMenu(skillIndex), getBody: (name) => getSkillBody(skillIndex, name) }; }
	}
	const diagBaseline = verifyCfg.enabled ? snapshotDiagnostics() : new Map();
	dbg('verify.config', { enabled: verifyCfg.enabled, hasCommand: !!verifyCfg.command, maxRounds: verifyCfg.maxRounds, includeWarnings: verifyCfg.includeWarnings });
	try {
		await runAgent({
			messages: agentMessages, // persists across runs → the agent remembers the session
			providerId: req.providerId,         // Anthropic native, or an OpenAI-shaped provider via translation (P2)
			baseURL: req.baseURL,               // for the custom / Ollama endpoints
			apiKey: req.apiKey,
			model: req.model,
			maxSteps: Math.max(1, cfg.get('agent.maxSteps', 25)),
			maxTokens: Math.max(1024, cfg.get('agent.maxTokens', 8192)),   // per-turn output cap; continued across turns if hit
			post, dbg,
			// LIVE, not a snapshot: agent.js reads ctx.autopilot at each run_command, so flipping the
			// Autopilot toggle mid-run takes effect on the very next command (run commands without asking,
			// except the danger set — commandSafety.js).
			get autopilot() { return autopilot; },
			approve: requestApproval,           // run_command only
			ask: requestQuestions,              // ask_user — clickable clarifying questions
			// Gateway-mode token refresh for the agent loop: on a mid-run 401 (expired access token)
			// agent.js calls this to renew silently + retry the turn. Returns the fresh token, or null
			// (BYOK / signed out / refresh failed → the run surfaces the auth error as before).
			refreshAuth: async () => {
				if (!req.gateway) { return null; }
				return (await refreshGatewayToken()) ? await ctx.secrets.get(ACCOUNT_TOKEN_KEY) : null;
			},
			skills: skillsObj,                  // M6.5: implicit skills (name+desc menu in SYSTEM + use_skill resolver)
			// MCP (docs/MCP.md S3). Config is read HERE and handed in, like verify/commandTimeout, so
			// agent.js keeps doing the loading + connecting + naming without reaching for the editor API.
			mcp: { servers: cfg.get('mcp.servers', {}), toolPolicy: cfg.get('mcp.toolPolicy', {}) },
			contextLimit: contextLimitFor(req.providerId, capsModel(req.model)), // Auto → flagship window; the model SENT stays req.model
			commandStops: commandStops,         // runId → stop() (process-group kill); used by Stop button / ■
			commandRuns: bgRuns,                // runId → background-process registry (read_command_output reads it)
			commandTimeout: cfg.get('commandTimeout', 120000), // backstop before a command is force-killed (0 = off)
			applyEdit: (req) => review.applyEdit(req), // file edits: apply-then-review
			applyDelete: (req) => review.applyDelete(req), // file deletions: apply-then-review
			verify: verifyCfg,                  // M5 auto-verify settings
			touched: runTouched,                // agent.js adds each edited abs path here
			getTouchedUris: () => [...runTouched].map((p) => vscode.Uri.file(p)),
			getNewDiagnostics: () => collectNewDiagnostics([...runTouched].map((p) => vscode.Uri.file(p)), diagBaseline, verifyCfg.includeWarnings),
			signal: abort.signal
		});
	} finally {
		clearApprovals();
		clearQuestions();
		abort = null;
		if (currentCheckpoint) { post({ type: 'checkpointClosed', turnId: currentCheckpoint.turnId, fileCount: currentCheckpoint.files.size }); currentCheckpoint = null; }
	}
}

async function handleSend(text) {
	if (!text || !text.trim()) { return; }
	if (ctx) { ctx.globalState.update('levelcode.ai.hasSentMessage', true); }   // user engaged → stop auto-revealing the panel on launch
	if (agentMode) { await agentFlow(text); return; }
	const cfg = aiConfig();
	const providerId = currentProviderId();
	dbg('chat.send', { provider: providerId, model: activeModel(cfg, providerId), chars: text.length, history: conversation.length });

	const blocks = [];

	// Workspace-derived context (auto-retrieval + optional file map) — one file listing, reused.
	const wantAuto = cfg.get('chat.autoContext', true);
	const wantMap = cfg.get('chat.workspaceMap', false);
	let allFiles = [];
	if (wantAuto || wantMap) { allFiles = await listWorkspaceFiles(); }
	if (wantMap) { const mb = workspaceMapBlock(allFiles); if (mb) { blocks.push(mb); } }

	const fileBlock = activeFileBlock();
	if (fileBlock) { blocks.push(fileBlock); }
	blocks.push(...await contextFileBlocks());

	const auto = wantAuto ? await gatherAutoContext(text, allFiles) : { blocks: [], names: [] };
	blocks.push(...auto.blocks);

	if (pendingContext) { blocks.push(pendingContext); }
	const userContent = blocks.length ? (blocks.join('\n\n') + '\n\n' + text) : text;
	conversation.push({ role: 'user', content: userContent });
	post({ type: 'userMessage', text });
	if (auto.names.length) { post({ type: 'autoContext', names: auto.names }); }
	pendingContext = null;
	post({ type: 'clearContext' });
	post({ type: 'assistantStart' });

	abort = new AbortController();
	let assistant = '';
	const onDelta = (d) => { assistant += d; post({ type: 'assistantDelta', text: d }); };

	try {
		const req = await prepProviderRequest({ prompt: true });
		if (!req.ok) {
			conversation.pop();
			post({ type: 'assistantError', message: providerErrorMessage(req) });
			return;
		}
		const doStream = (r) => providers.streamChat({
			providerId: r.providerId, apiKey: r.apiKey, baseURL: r.baseURL,
			model: r.model, maxTokens: r.maxTokens, system: SYSTEM_PROMPT,
			messages: conversation, signal: abort.signal, onDelta
		});
		try {
			await doStream(req);
		} catch (e) {
			// Gateway token expired mid-request → refresh once and retry (only if nothing streamed yet).
			if (req.gateway && !assistant && isAuthError(e) && !(abort && abort.signal.aborted) && await refreshGatewayToken()) {
				const req2 = await prepProviderRequest({ prompt: true });
				if (req2.ok) { await doStream(req2); } else { throw e; }
			} else { throw e; }
		}
		conversation.push({ role: 'assistant', content: assistant });
		post({ type: 'assistantDone' });
	} catch (e) {
		if (abort && abort.signal.aborted) {
			if (assistant) { conversation.push({ role: 'assistant', content: assistant }); }
			post({ type: 'assistantDone' });
		} else {
			conversation.pop();
			post({ type: 'assistantError', message: String((e && e.message) || e), code: e && e.code });
		}
	} finally {
		abort = null;
	}
}

/** Persist the model id under the right per-provider setting. */
async function setModelSetting(cfg, providerId, id) {
	const pid = providers.normId(providerId);
	if (pid === 'claude') { return cfg.update('claude.model', id, vscode.ConfigurationTarget.Global); }
	if (pid === 'ollama') { return cfg.update('ollama.model', id, vscode.ConfigurationTarget.Global); }
	return cfg.update('model', id, vscode.ConfigurationTarget.Global);
}

/** Open the LevelCode Cloud pricing / upgrade page in the browser (free-tier Upgrade CTA). */
async function openUpgrade() {
	const base = cloudEndpoint() || 'https://levelcode.ai';
	dbg('account.upgrade', { base });
	await vscode.env.openExternal(vscode.Uri.parse(base + '/ai/pricing'));
}

/** Open a LevelCode legal page (Terms / Privacy) from the sign-in modal. Targets are a fixed
 *  allow-list — never a URL from the webview — so this can't be turned into an open-redirect. */
async function openLegal(target) {
	const path = target === 'privacy' ? '/privacy' : target === 'terms' ? '/terms' : null;
	if (!path) { return; }
	await vscode.env.openExternal(vscode.Uri.parse('https://levelcode.ai' + path));
}

/** Human "≈ turns left" formatting (e.g. 8044 → "8k", 375 → "375"). */
function fmtTurns(n) {
	n = Number(n) || 0;
	return n >= 1000 ? (Math.round(n / 100) / 10) + 'k' : String(n);
}

/**
 * The LevelCode Cloud model menu (gateway mode, signed in). Fetches the plan's roster from the backend
 * (GET /account/models): LIVE models (confirmed price) are selectable with their credit multiplier +
 * ≈ turns-left on the remaining budget; STAGED models (frontier, assumption-priced) are shown 🔒 as
 * "coming soon"; the free tier surfaces an Upgrade CTA. The backend re-checks entitlement, so a
 * client selection can never over-reach the plan.
 */
async function pickCloudModel() {
	const roster = await fetchCloudRoster();
	const plan = (roster && roster.plan) || cloudPlanName() || 'Free';
	const paid = isPaidCloudPlan(plan);
	const models = (roster && Array.isArray(roster.models)) ? roster.models : [];
	const active = gatewayModel();
	const credits = roster && roster.credits_remaining_micros != null
		? ' · $' + (roster.credits_remaining_micros / 1e6).toFixed(2) + ' credits left' : '';

	/** @type {any[]} */
	const items = [{ label: 'LevelCode Cloud · ' + plan, kind: vscode.QuickPickItemKind.Separator }];
	// Auto (paid only): the gateway picks the cheapest engine per turn — free margin for the user.
	if (paid) {
		items.push({
			label: (active === GATEWAY_AUTO_MODEL ? '$(check) ' : '') + '$(sparkle) ' + GATEWAY_AUTO_LABEL,
			description: GATEWAY_AUTO_MODEL,
			detail: 'Routes each turn to the best-value engine · saves credits',
			_cloud: GATEWAY_AUTO_MODEL
		});
	}
	if (models.length) {
		for (const m of models) {
			const ctxK = Math.round((m.context || 0) / 1000) + 'K ctx';
			if (m.live) {
				const turns = (m.turns_left != null) ? ' · ≈' + fmtTurns(m.turns_left) + ' turns left' : '';
				items.push({
					label: (m.id === active ? '$(check) ' : '') + m.label,
					description: m.id,
					detail: m.multiplier + '× credits · ' + ctxK + turns,
					_cloud: m.id
				});
			} else {
				items.push({ label: '$(lock) ' + m.label, description: m.id, detail: m.multiplier + '× credits · ' + ctxK + ' · coming soon', _soon: true });
			}
		}
	} else {
		// Offline / roster unavailable — minimal fallback so the menu still works.
		items.push({ label: (active === GATEWAY_FREE_MODEL ? '$(check) ' : '') + GATEWAY_FREE_LABEL, description: GATEWAY_FREE_MODEL, _cloud: GATEWAY_FREE_MODEL });
		if (paid) { items.push({ label: (active === GATEWAY_PRO_MODEL ? '$(check) ' : '') + GATEWAY_PRO_LABEL, description: GATEWAY_PRO_MODEL, _cloud: GATEWAY_PRO_MODEL }); }
	}
	if (!paid) {
		items.push({ label: '$(rocket) Upgrade to Pro', description: 'Kimi K2.7 Code + the full model roster', _upgrade: true });
	}
	items.push({ label: 'Other', kind: vscode.QuickPickItemKind.Separator });
	items.push({ label: '$(key) Use my own key (BYOK)…', description: 'Turn off the metered gateway in settings', _action: 'byokSettings' });

	const pick = await vscode.window.showQuickPick(items, {
		placeHolder: 'LevelCode Cloud model · Plan: ' + plan + credits,
		matchOnDescription: true
	});
	if (!pick) { return; }
	if (pick._upgrade) { await openUpgrade(); return; }
	if (pick._soon) { vscode.window.showInformationMessage('LevelCode Cloud: ' + (pick.description || 'that model') + ' is coming soon — pricing is being finalized.'); return; }
	if (pick._action === 'byokSettings') { vscode.commands.executeCommand('workbench.action.openSettings', 'levelcode.ai.providerMode'); return; }
	if (pick._cloud) {
		await aiConfig().update('cloudModel', pick._cloud, vscode.ConfigurationTarget.Global);
		sendConfigToWebview();
	}
}

async function pickModel() {
	const cfg = aiConfig();
	// Gateway mode + signed in → a plan-scoped LevelCode Cloud menu (free engine + flagship, the latter
	// locked on the free tier). Signed out / BYOK falls through to the full provider list below.
	if (providerMode() === 'gateway' && ctx && await ctx.secrets.get(ACCOUNT_TOKEN_KEY)) {
		return pickCloudModel();
	}
	/** @type {any[]} */
	const items = [];
	// Built-in models for every provider except Ollama (dynamic below) and custom (prompted below).
	for (const p of providers.listProviders()) {
		if (p.id === 'ollama' || p.id === 'custom') { continue; }
		items.push({ label: p.label, kind: vscode.QuickPickItemKind.Separator });
		for (const m of (p.models || [])) {
			items.push({ label: m.label, description: m.id, detail: [m.detail, catalog.describeModel(m.id)].filter(Boolean).join(' · '), _provider: p.id, _id: m.id });
		}
	}
	// Ollama — list installed models live.
	items.push({ label: 'Ollama (local)', kind: vscode.QuickPickItemKind.Separator });
	const ollama = await providers.listOllamaModels(cfg.get('ollama.url', 'http://localhost:11434'));
	if (ollama.length) {
		for (const name of ollama) { items.push({ label: name, description: 'Ollama', _provider: 'ollama', _id: name }); }
	} else {
		const current = cfg.get('ollama.model', 'llama3.1');
		items.push({ label: current, description: 'Ollama (start Ollama to list installed models)', _provider: 'ollama', _id: current });
	}
	// Escape hatches: browse the current provider's full live catalog, a custom model id, or a full endpoint.
	items.push({ label: 'Other', kind: vscode.QuickPickItemKind.Separator });
	items.push({ label: '$(cloud-download) Browse all models (live)…', description: 'Fetch ' + (providers.getProvider(currentProviderId()) || {}).label + '’s full model list', _action: 'browse' });
	items.push({ label: '$(edit) Enter a model ID…', description: 'For the current provider (' + (providers.getProvider(currentProviderId()) || {}).label + ')', _action: 'manualModel' });
	items.push({ label: '$(globe) OpenAI-compatible endpoint…', description: 'Point LevelCode at any /v1 server (vLLM, LM Studio, LiteLLM…)', _action: 'customEndpoint' });

	const curId = currentProviderId();
	const curModel = activeModel(cfg, curId);
	const pick = await vscode.window.showQuickPick(items, {
		placeHolder: `Select AI model (current: ${curModel} · ${(providers.getProvider(curId) || {}).label})`,
		matchOnDescription: true
	});
	if (!pick) { return; }

	if (pick._action === 'browse') { await browseProviderModels(cfg, curId); return; }
	if (pick._action === 'manualModel') {
		const id = await vscode.window.showInputBox({ title: 'LevelCode AI — Model ID', prompt: 'Model id for ' + (providers.getProvider(curId) || {}).label, ignoreFocusOut: true, value: curModel });
		if (!id) { return; }
		await setModelSetting(cfg, curId, id.trim());
		sendConfigToWebview();
		return;
	}
	if (pick._action === 'customEndpoint') {
		const url = await vscode.window.showInputBox({ title: 'LevelCode AI — OpenAI-compatible base URL', prompt: 'Base URL ending in /v1 (e.g. http://localhost:8000/v1)', placeHolder: 'https://…/v1', ignoreFocusOut: true, value: cfg.get('baseURL', '') });
		if (!url) { return; }
		const model = await vscode.window.showInputBox({ title: 'LevelCode AI — Model ID', prompt: 'Model id served by that endpoint', ignoreFocusOut: true });
		if (!model) { return; }
		await cfg.update('baseURL', url.trim(), vscode.ConfigurationTarget.Global);
		await cfg.update('provider', 'custom', vscode.ConfigurationTarget.Global);
		await setModelSetting(cfg, 'custom', model.trim());
		sendConfigToWebview();
		return;
	}
	if (!pick._id) { return; }
	await cfg.update('provider', pick._provider, vscode.ConfigurationTarget.Global);
	await setModelSetting(cfg, pick._provider, pick._id);
	sendConfigToWebview();
}

/** Live-fetch a provider's full model catalog and let the user pick from it (searchable, with caps). */
async function browseProviderModels(cfg, providerId) {
	const p = providers.getProvider(providerId) || providers.getProvider('claude');
	const skey = secretKeyFor(providerId);
	const apiKey = skey ? await ctx.secrets.get(skey) : undefined;   // silent — the list often needs no key (e.g. OpenRouter)
	const baseURL = baseUrlFor(cfg, providerId);
	const choices = await vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Notification, title: 'LevelCode AI: fetching ' + p.label + ' models…' },
		() => catalog.getModelChoices(providerId, { dynamic: true, apiKey, baseURL, ollamaUrl: cfg.get('ollama.url', 'http://localhost:11434') })
	);
	if (!choices.length) { vscode.window.showInformationMessage('LevelCode AI: no models returned for ' + p.label + ' (offline, or the provider needs an API key set first).'); return; }
	const items = choices.map((c) => ({ label: c.label, description: c.id, detail: c.detail, _id: c.id }));
	const pick = await vscode.window.showQuickPick(items, {
		placeHolder: 'Select a ' + p.label + ' model — ' + choices.length + ' available (type to filter)',
		matchOnDescription: true
	});
	if (!pick || !pick._id) { return; }
	await cfg.update('provider', providerId, vscode.ConfigurationTarget.Global);
	await setModelSetting(cfg, providerId, pick._id);
	sendConfigToWebview();
}

function sendConfigToWebview() {
	const cfg = aiConfig();
	// Gateway mode (signed in — the gateway only routes when authenticated): the footer reflects the
	// LevelCode Cloud plan model (free → gpt-oss, paid → Kimi), not the BYOK provider — with a `paid` flag
	// so the webview can show the free-tier Upgrade CTA.
	if (providerMode() === 'gateway' && cloudSignedIn) {
		const model = gatewayModel();
		post({
			type: 'config', provider: 'gateway', model: gatewayModelLabel(model), modelId: model,
			providerLabel: 'LevelCode Cloud', contextLimit: contextLimitFor('openai', capsModel(model)),
			gateway: true, plan: cloudPlanName() || 'Free', paid: isPaidCloudPlan(cloudPlanName())
		});
		return;
	}
	const providerId = currentProviderId();
	const p = providers.getProvider(providerId) || providers.getProvider('claude');
	// Carry the model's context window so the footer meter updates the moment the model changes.
	post({ type: 'config', provider: providerId, model: activeModel(cfg, providerId), providerLabel: p.label, contextLimit: currentContextLimit() });
}

class ChatViewProvider {
	/** @param {vscode.WebviewView} view */
	resolveWebviewView(view) {
		activeWebview = view.webview;
		view.webview.options = { enableScripts: true, localResourceRoots: [ctx.extensionUri] };
		view.webview.html = getHtml();
		view.webview.onDidReceiveMessage(async (msg) => {
			switch (msg.type) {
				case 'ready': cloudSignedIn = !!(ctx && await ctx.secrets.get(ACCOUNT_TOKEN_KEY)); autopilot = aiConfig().get('agent.autopilot', false); sendConfigToWebview(); postActiveFile(); postContextFiles(); post({ type: 'mode', agent: agentMode }); post({ type: 'autopilot', on: autopilot }); postAccount(); buildFileIndex(); post({ type: 'contextUsage', input: 0, limit: currentContextLimit() }); if (review) { review.resync(); } break;
				case 'setMode': agentMode = !!msg.agent; post({ type: 'mode', agent: agentMode }); break;
				case 'setAutopilot': autopilot = !!msg.on; aiConfig().update('agent.autopilot', autopilot, vscode.ConfigurationTarget.Global); dbg('autopilot.set', { on: autopilot }); post({ type: 'autopilot', on: autopilot }); break;
				case 'send': await handleSend(msg.text); break;
				case 'stop': dbg('stop.clicked', { running: commandStops.size }); for (const [, stop] of commandStops) { try { stop(); } catch (e) { /* gone */ } } if (abort) { abort.abort(); } clearApprovals(); clearQuestions(); break;
				case 'stopCommand': { dbg('stopCommand', { id: msg.id }); const s = commandStops.get(msg.id); if (s) { try { s(); } catch (e) { /* gone */ } } break; }
				case 'approvalResponse': resolveApproval(msg.id, msg.approved); break;
				case 'questionsResponse': resolveQuestions(msg.id, msg.answers, msg.notes); break;
				case 'accountSignIn': await accountSignIn(msg.provider, msg.create); break;
				case 'accountSignOut': await accountSignOut(); break;
				case 'accountManage': await accountManage(); break;
				case 'accountUpgrade': await openUpgrade(); break;
				case 'openExternal': await openLegal(msg.target); break;
				case 'copy': try { await vscode.env.clipboard.writeText(String(msg.text || '')); } catch (e) { /* clipboard unavailable */ } break;
				case 'retry': if (lastAgentGoal && !abort) { dbg('retry', { goalChars: lastAgentGoal.length }); await agentFlow(lastAgentGoal); } break;
				case 'continueAgent': if (!abort) { const g = lastAgentGoal; dbg('continue', { transcriptMsgs: agentMessages.length }); await agentFlow('Continue from where you left off and finish the task. Pick up exactly where you stopped — do not restart or repeat work that is already done.'); lastAgentGoal = g; } break;
				case 'restoreCheckpoint': dbg('restoreCheckpoint', { turnId: msg.turnId, running: !!abort }); await restoreCheckpoint(msg.turnId); break;
				case 'listSkills': { const en = aiConfig().get('skills.enabled', true); const idx = en ? loadSkills(ctx.extensionPath, dbg) : new Map(); dbg('listSkills', { enabled: en, count: idx.size }); post({ type: 'skillsList', enabled: en, skills: skillsMenu(idx) }); break; }
				case 'feedback': dbg('feedback', { value: msg.value, model: msg.model }); await recordFeedback(msg.value, msg.model); break;
				case 'openFile': await openWorkspaceFile(msg.path); break;
				case 'reviewKeepFile': dbg('review.keep', { id: msg.id }); review.keepFile(msg.id, 'kept'); break;
				case 'reviewUndoFile': dbg('review.undo', { id: msg.id }); await review.undoFile(msg.id); break;
				case 'reviewKeepAll': review.keepAll(); break;
				case 'reviewUndoAll': await review.undoAll(); break;
				case 'reviewOpenDiff': await review.openDiff(msg.id); break;
				case 'addSelection': addSelection(); break;
				case 'addContext': await addContext(); break;
				case 'removeContext': removeFileContext(msg.id); break;
				case 'newChat': newChat(); break;
				case 'compact': {
					dbg('compact.clicked', { running: !!abort, transcriptMsgs: agentMessages.length });
					post({ type: 'compactStart' });
					const r = await compactAgentMemory();
					post({ type: 'compactResult', ok: !!r.ok, reason: r.reason || null, beforeMsgTokens: r.beforeMsgTokens || 0, afterMsgTokens: r.afterMsgTokens || 0 });
					break;
				}
				case 'setKey': await promptForKey(); break;
				case 'pickModel': await pickModel(); break;
				case 'openSettings': vscode.commands.executeCommand('workbench.action.openSettings', '@ext:levelcode.levelcode-ai'); break;
			}
		});
	}
}

function getHtml() {
	const nonce = String(Math.random()).slice(2) + String(Date.now());
	const csp = [
		"default-src 'none'",
		"style-src 'unsafe-inline'",
		"script-src 'nonce-" + nonce + "'"
	].join('; ');
	const html = fs.readFileSync(path.join(ctx.extensionPath, 'media', 'chat.html'), 'utf8');
	return html.replace(/__CSP__/g, csp).replace(/__NONCE__/g, nonce);
}

// ---- LevelCode Cloud account (sign-in + sync) -------------------------------------------------
// IMPORTANT: this is a SEPARATE, optional layer. The AI path stays BYO-key / no-backend — the
// account only syncs settings/skills/profile, never proxies AI or sees your provider keys.
// It is gated on a configured `levelcode.cloud.endpoint`; with none set, sign-in is honestly inert.
const ACCOUNT_TOKEN_KEY = 'levelcode.cloud.token';       // access token → SecretStorage
const ACCOUNT_REFRESH_KEY = 'levelcode.cloud.refresh';   // refresh token → SecretStorage (gateway silent renewal)
const ACCOUNT_VERIFIER_KEY = 'levelcode.cloud.verifier'; // PKCE code_verifier → SecretStorage (per sign-in)
const ACCOUNT_PROFILE_KEY = 'levelcode.cloud.profile';   // {name,email,plan} → globalState

/** base64url without padding — the encoding PKCE (RFC 7636) uses for both verifier and challenge. */
function b64url(buf) { return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
/** A fresh PKCE pair: a high-entropy verifier and its S256 challenge (SHA-256 → base64url). */
function pkcePair() {
	const verifier = b64url(crypto.randomBytes(32));
	const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
	return { verifier, challenge };
}
// The LevelCode Cloud host (Rails on Elastic Beanstalk) — ONE host serves browser sign-in + dashboard + the
// metered gateway (dev: ngrok, prod: levelcode.ai). levelcode.ai is a separate Vercel marketing site, NOT this.
function cloudEndpoint() { return String(vscode.workspace.getConfiguration('levelcode.cloud').get('endpoint', '') || '').replace(/\/+$/, ''); }
// The LevelCode Cloud BACKEND API (Rails) — the metered gateway + token exchange/refresh. ONE host serves the
// whole LevelCode Cloud (sign-in pages + dashboard + API); `apiUrl` defaults to the website host and is only an
// override for the advanced case of splitting web vs API onto different hosts.
function cloudApiUrl() {
	const u = String(vscode.workspace.getConfiguration('levelcode.cloud').get('apiUrl', '') || '').replace(/\/+$/, '');
	return u || cloudEndpoint();
}
async function currentAccount() {
	const mode = providerMode();   // 'byok' | 'gateway' — drives the mode-aware privacy note + plan line
	const token = ctx ? await ctx.secrets.get(ACCOUNT_TOKEN_KEY) : null;
	cloudSignedIn = !!token;   // keep the footer/model gate in sync with the real session
	if (token) {
		const p = (ctx && ctx.globalState.get(ACCOUNT_PROFILE_KEY)) || {};
		return { signedIn: true, mode, name: p.name || p.email || 'LevelCode user', email: p.email || '', plan: p.plan || '' };
	}
	return { signedIn: false, mode, status: cloudEndpoint() ? 'signedout' : 'unconfigured' };
}
/**
 * Best-effort refresh of the cached profile (esp. `plan`) from the backend, so the free-tier lock /
 * Upgrade CTA and the footer model stay accurate after the user upgrades on the web. No-op when
 * signed out, unconfigured, or the API host isn't https (localhost http is allowed for dev). The
 * editor access token carries `account:read`, so GET /account/profile is authorized.
 */
async function refreshCloudProfile() {
	if (!ctx) { return; }
	const token = await ctx.secrets.get(ACCOUNT_TOKEN_KEY);
	if (!token) { return; }
	const api = cloudApiUrl();
	if (!(/^https:\/\//i.test(api) || /^http:\/\/(localhost|127\.0\.0\.1)([:/]|$)/i.test(api))) { return; }
	try {
		const res = await fetch(api + '/api/levelcode/v1/account/profile', { headers: { authorization: 'Bearer ' + token } });
		if (!res.ok) { dbg('account.refreshProfile', { ok: false, status: res.status }); return; }
		const data = await res.json().catch(() => null);
		if (!data) { return; }
		const prev = (ctx.globalState.get(ACCOUNT_PROFILE_KEY)) || {};
		await ctx.globalState.update(ACCOUNT_PROFILE_KEY, {
			name: data.name || prev.name || '', email: data.email || prev.email || '', plan: data.plan || prev.plan || ''
		});
		dbg('account.refreshProfile', { ok: true, plan: data.plan });
	} catch (e) { dbg('account.refreshProfile', { error: String((e && e.message) || e) }); }
}

async function postAccount(open) {
	await refreshCloudProfile();   // keep plan/lock fresh (no-op signed out/offline)
	const a = await currentAccount();
	post(Object.assign({ type: 'account', open: !!open }, a));
	// The plan may have changed the gateway model / free-tier CTA — resync the footer.
	if (providerMode() === 'gateway') {
		fetchCloudRoster();   // best-effort: populate the roster cache for footer labels (fire-and-forget)
		sendConfigToWebview();
	}
}
// Deep-link from the browser "IDE ↗" button (levelcode://levelcode.levelcode-ai/launch — NO credential
// in the URL). Focus the chat; if not signed in, run the editor's normal PKCE sign-in. The already-
// authenticated browser completes it silently (LoginPage auto-mints a PKCE-BOUND code), so there's no
// second login and no interceptable code ever travels through the custom scheme.
async function handleLaunch() {
	dbg('account.launch', {});
	vscode.commands.executeCommand('levelcodeAi.chat.focus');
	const token = ctx ? await ctx.secrets.get(ACCOUNT_TOKEN_KEY) : null;
	if (!token) { await accountSignIn(); }
}

async function accountSignIn(provider, create) {
	const endpoint = cloudEndpoint();
	if (!endpoint) {
		dbg('account.signin', { unconfigured: true });
		await postAccount(true);
		vscode.window.showInformationMessage('LevelCode Cloud isn’t connected yet. Set "levelcode.cloud.endpoint" to your account server to sign in. (Accounts + sync are on the roadmap — M9.)');
		return;
	}
	// Canonical editor OAuth callback: open the server's auth page with a redirect back to us.
	const cb = await vscode.env.asExternalUri(vscode.Uri.parse(`${vscode.env.uriScheme}://levelcode.levelcode-ai/auth/callback`));
	// Provider sign-in hits the Rails host's OAuth start route (/ai/auth/oauth/<provider>); the browser
	// + "create" buttons both land on the account app's login page (/ai/login), which offers email + provider
	// options and threads redirect_uri + the PKCE challenge onward.
	const sub = provider ? ('ai/auth/oauth/' + encodeURIComponent(provider)) : 'ai/login';
	// PKCE (S256): stash a fresh verifier; send only the challenge. The hardened flow returns a one-time
	// `code` we exchange with the verifier. Servers on the legacy flow ignore the challenge and return a token.
	const { verifier, challenge } = pkcePair();
	if (ctx) { await ctx.secrets.store(ACCOUNT_VERIFIER_KEY, verifier); }
	const url = `${endpoint}/${sub}?redirect_uri=${encodeURIComponent(cb.toString())}`
		+ `&code_challenge=${encodeURIComponent(challenge)}&code_challenge_method=S256`;
	dbg('account.signin', { provider: provider || 'browser', create: !!create });
	await vscode.env.openExternal(vscode.Uri.parse(url));
}
async function accountSignOut() {
	cloudSignedIn = false;
	if (ctx) {
		await ctx.secrets.delete(ACCOUNT_TOKEN_KEY);
		await ctx.secrets.delete(ACCOUNT_REFRESH_KEY);
		await ctx.globalState.update(ACCOUNT_PROFILE_KEY, undefined);
	}
	dbg('account.signout');
	await postAccount();
}
async function accountManage() {
	const endpoint = cloudEndpoint();
	if (!endpoint) { await postAccount(true); return; }
	// Hand the editor session to the browser so "Manage account" lands authenticated on
	// /ai/account WITHOUT a second sign-in. Falls back to opening the page directly (which
	// prompts a browser login) if the handoff can't be minted (signed out / offline).
	const url = await webHandoffUrl();
	await vscode.env.openExternal(vscode.Uri.parse(url || (endpoint + '/ai/account')));
}

/**
 * Mint a one-time browser sign-in URL from the editor session (POST /auth/web_handoff):
 * the returned URL redeems into a Devise web session and lands on /ai/account, so the
 * browser is already authenticated. Returns null (caller falls back to the plain page)
 * when signed out, offline, or the host isn't https/localhost. One silent refresh+retry
 * on 401 so a lapsed access token doesn't force a re-login.
 */
async function webHandoffUrl() {
	if (!ctx) { return null; }
	let token = await ctx.secrets.get(ACCOUNT_TOKEN_KEY);
	if (!token) { return null; }
	const api = cloudApiUrl();
	if (!/^https:\/\//i.test(api) && !/^http:\/\/(localhost|127\.0\.0\.1)([:/]|$)/i.test(api)) { return null; }
	const mint = (bearer) => fetch(api + '/api/levelcode/v1/auth/web_handoff', {
		method: 'POST', headers: { authorization: 'Bearer ' + bearer }
	});
	try {
		let res = await mint(token);
		if (res.status === 401 && await refreshCloudToken()) {
			token = await ctx.secrets.get(ACCOUNT_TOKEN_KEY);
			res = await mint(token);
		}
		if (!res.ok) { dbg('account.handoff', { ok: false, status: res.status }); return null; }
		const data = await res.json().catch(() => null);
		return (data && data.url) || null;
	} catch (e) { dbg('account.handoff', { error: String((e && e.message) || e) }); return null; }
}
/** Persist an editor session: access token (required), optional refresh token, and display profile. */
async function storeSession(access, refresh, profile) {
	if (!ctx || !access) { return; }
	cloudSignedIn = true;
	await ctx.secrets.store(ACCOUNT_TOKEN_KEY, access);
	if (refresh) { await ctx.secrets.store(ACCOUNT_REFRESH_KEY, refresh); }
	await ctx.globalState.update(ACCOUNT_PROFILE_KEY, {
		name: (profile && profile.name) || '', email: (profile && profile.email) || '', plan: (profile && profile.plan) || ''
	});
}

// The browser redirects to levelcode://levelcode.levelcode-ai/auth/callback with either:
//   ?code=<one_time>            (hardened PKCE flow — we exchange it for {access,refresh,profile})   [default]
//   ?token=…&refresh=…&name=…&email=…&plan=…   (legacy flow — used as fallback)
async function handleAuthCallback(uri) {
	try {
		const q = new URLSearchParams(uri.query || '');
		const code = q.get('code');
		// Preferred: PKCE code → exchange for tokens using the verifier we stashed at sign-in.
		if (code) {
			const endpoint = cloudApiUrl(); // token exchange is a BACKEND (Rails) call, not the website
			const verifier = ctx ? await ctx.secrets.get(ACCOUNT_VERIFIER_KEY) : null;
			try {
				const res = await fetch(endpoint + '/api/levelcode/v1/auth/exchange', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ code, verifier: verifier || '' })
				});
				if (!res.ok) { throw new Error('exchange ' + res.status); }
				const data = await res.json();
				if (!data || !data.access) { throw new Error('exchange: no access token'); }
				await storeSession(data.access, data.refresh, data.profile);
			} finally {
				if (ctx) { await ctx.secrets.delete(ACCOUNT_VERIFIER_KEY); }   // single-use
			}
			dbg('account.callback', { ok: true, flow: 'code' });
			await postAccount(true);
			vscode.window.showInformationMessage('Signed in to LevelCode.');
			return;
		}
		// Fallback: legacy token-in-query flow.
		const token = q.get('token');
		if (!token) { return; }
		await storeSession(token, q.get('refresh'), { name: q.get('name') || '', email: q.get('email') || '', plan: q.get('plan') || '' });
		dbg('account.callback', { ok: true, flow: 'token' });
		await postAccount(true);
		vscode.window.showInformationMessage('Signed in to LevelCode.');
	} catch (e) { dbg('account.callback', { error: String((e && e.message) || e) }); }
}

// ---- Workspace file index (powers clickable file chips in chat) -------------------------------
let workspaceFiles = new Map();   // relPath -> vscode.Uri
let fileIndexTimer = null;
async function buildFileIndex() {
	try {
		const map = new Map();
		const exclude = '{**/node_modules/**,**/.git/**,**/out/**,**/dist/**,**/build/**,**/.DS_Store}';
		const uris = await vscode.workspace.findFiles('**/*', exclude, 8000);
		const rels = [];
		for (const u of uris) { const rel = vscode.workspace.asRelativePath(u, false); map.set(rel, u); rels.push(rel); }
		workspaceFiles = map;
		post({ type: 'fileIndex', files: rels });
		dbg('fileIndex', { count: rels.length });
	} catch (e) { /* ignore index build errors */ }
}
function scheduleFileIndex() { if (fileIndexTimer) { clearTimeout(fileIndexTimer); } fileIndexTimer = setTimeout(buildFileIndex, 400); }
async function openWorkspaceFile(rel) {
	if (!rel) { return; }
	let uri = workspaceFiles.get(rel);
	if (!uri) {
		for (const f of (vscode.workspace.workspaceFolders || [])) {
			const cand = vscode.Uri.joinPath(f.uri, rel);
			try { await vscode.workspace.fs.stat(cand); uri = cand; break; } catch (e) { /* not here */ }
		}
		if (!uri) { const found = await vscode.workspace.findFiles('**/' + rel.split('/').pop(), '**/node_modules/**', 1); if (found.length) { uri = found[0]; } }
	}
	if (!uri) { vscode.window.showWarningMessage('LevelCode: could not locate ' + rel); return; }
	try {
		await vscode.commands.executeCommand('revealInExplorer', uri);   // reveal in the (nested) Explorer tree
		await vscode.window.showTextDocument(uri, { preview: false });   // open in the main editor
		dbg('openFile', { rel: rel });
	} catch (e) { dbg('openFile.error', { msg: String((e && e.message) || e) }); }
}

function activate(context) {
	ctx = context;
	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider('levelcodeAi.chat', new ChatViewProvider(), {
			webviewOptions: { retainContextWhenHidden: true }
		}),
		vscode.window.onDidChangeActiveTextEditor(() => postActiveFile()),
		vscode.commands.registerCommand('levelcode.ai.focus', () => vscode.commands.executeCommand('levelcodeAi.chat.focus')),
		vscode.commands.registerCommand('levelcode.customize', () => openCustomize(context)),
		// Agent Sketch: the visual multi-agent flow canvas. Lazy require — only loads when opened.
		vscode.commands.registerCommand('levelcode.ai.sketch', () => {
			try {
				require('./sketch').openSketch(context, { prepProviderRequest, aiConfig, currentProviderId });
			} catch (e) {
				vscode.window.showErrorMessage('Agent Sketch failed to load: ' + ((e && e.message) || e));
			}
		}),
		vscode.commands.registerCommand('levelcode.import.vscode', () => importFromVscode(context)),
		vscode.commands.registerCommand('levelcode.ai.newChat', newChat),
		vscode.commands.registerCommand('levelcode.ai.pickModel', pickModel),
		vscode.commands.registerCommand('levelcode.ai.addSelection', addSelection),
		vscode.commands.registerCommand('levelcode.ai.addFileContext', addContext),
		vscode.commands.registerCommand('levelcode.ai.setApiKey', () => promptForKey()),
		vscode.commands.registerCommand('levelcode.ai.clearApiKey', async () => {
			const id = currentProviderId();
			const skey = secretKeyFor(id);
			const label = (providers.getProvider(id) || {}).label || 'provider';
			if (!skey) { vscode.window.showInformationMessage('LevelCode AI: ' + label + ' uses no API key.'); return; }
			await context.secrets.delete(skey);
			vscode.window.showInformationMessage('LevelCode AI: ' + label + ' API key cleared.');
		}),
		vscode.commands.registerCommand('levelcode.ai.account', () => postAccount(true)),
		vscode.window.registerUriHandler({ handleUri(uri) {
			if (uri.path === '/auth/callback') { handleAuthCallback(uri); }
			else if (uri.path === '/launch') { handleLaunch(); }
		} }),
		vscode.workspace.onDidCreateFiles(scheduleFileIndex),
		vscode.workspace.onDidDeleteFiles(scheduleFileIndex),
		vscode.workspace.onDidRenameFiles(scheduleFileIndex),
		vscode.workspace.onDidChangeWorkspaceFolders(scheduleFileIndex),
		vscode.workspace.onDidChangeConfiguration((e) => {
			if (e.affectsConfiguration('levelcode.ai')) { sendConfigToWebview(); }
			if (e.affectsConfiguration('levelcode.ai.providerMode') || e.affectsConfiguration('levelcode.cloud')) { postAccount(); }
		})
	);

	// AI edit-with-diff (select code → instruct → review diff → apply) — provider-agnostic.
	registerAiEdit(context, {
		aiConfig,
		prepProviderRequest,
		streamChat: providers.streamChat
	});

	// Claude as a native Language Model provider (powers VS Code's built-in chat/edit UI).
	registerLmProvider(context, async (silent) => {
		let key = await context.secrets.get(SECRET_KEY);
		if (!key && !silent) { key = await promptForKey(); }
		return key;
	});

	// Apply-then-review: agent edits land immediately and are reviewed with Keep/Undo (editor + panel).
	review = registerReview(context, post, dbg, recordCheckpointTouch);

	// Inline (ghost-text) tab-completion — provider-agnostic. Silent key lookup (prompt:false):
	// it must never pop a key dialog mid-typing.
	registerInlineComplete(context, {
		aiConfig,
		prepProviderRequest,
		complete: providers.complete,
		fastCompletionModel: catalog.fastCompletionModel
	});

	// AI-first: reveal the chat (in the secondary side bar) on EVERY launch until the user has actually
	// engaged (sent their first message). This makes sure new users always see it, instead of it only
	// showing once. Once they've sent a message (handleSend sets the flag) we stop forcing it and defer
	// to VS Code's own per-workspace layout persistence, so closing it stays closed.
	// Fallback guard: if the webview never renders (provider error, missing resource) hasSentMessage
	// is never set, which would otherwise force the panel open forever. Stop after a few launches.
	const AUTO_REVEAL_MAX_LAUNCHES = 5;
	if (!context.globalState.get('levelcode.ai.hasSentMessage')) {
		const launches = (Number(context.globalState.get('levelcode.ai.autoRevealLaunches')) || 0) + 1;
		context.globalState.update('levelcode.ai.autoRevealLaunches', launches);
		if (launches <= AUTO_REVEAL_MAX_LAUNCHES) {
			setTimeout(() => { vscode.commands.executeCommand('levelcodeAi.chat.focus'); }, 600);
		}
	}

	// First-launch onboarding: open the "Welcome to LevelCode" walkthrough once. Only mark it shown
	// AFTER it actually opens (previously the flag was set up-front, so a first-launch race that failed
	// to open the walkthrough would suppress onboarding forever). Retry once at a longer delay so a slow
	// startup still gets it; give up quietly otherwise and try again next launch.
	if (!context.globalState.get('levelcode.ai.didShowWelcome')) {
		const openWelcome = () => vscode.commands.executeCommand('workbench.action.openWalkthrough', 'levelcode.levelcode-ai#welcome', false);
		const markShown = () => context.globalState.update('levelcode.ai.didShowWelcome', true);
		setTimeout(() => {
			openWelcome().then(markShown, () => setTimeout(() => openWelcome().then(markShown, () => {}), 1500));
		}, 900);
	}
}

function deactivate() { if (abort) { abort.abort(); } reapCommands(); reapMcp(); }

module.exports = { activate, deactivate };
