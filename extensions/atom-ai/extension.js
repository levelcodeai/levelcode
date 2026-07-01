/*---------------------------------------------------------------------------------------------
 *  Atom++ — AI (M2, feature 1: Chat with Claude)
 *
 *  A native chat side panel. Requests go directly from the editor to the provider
 *  (Anthropic or local Ollama) — there is no Atom++ server in the middle. The Anthropic
 *  API key is stored in VS Code SecretStorage (encrypted by the OS keychain).
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const cp = require('child_process');
const providers = require('./providers/index');
const catalog = require('./providers/catalog');
const { registerAiEdit } = require('./aiEdit');
const { registerLmProvider } = require('./lmProvider');
const { registerInlineComplete } = require('./inlineComplete');
const { runAgent } = require('./agent');
const { registerReview } = require('./reviewSession');
const { formatDiagnosticLines, diagKey } = require('./verify');
const { loadSkills, skillsMenu, getSkillBody } = require('./skills');
const { openCustomize } = require('./customize');
const { importFromVscode } = require('./importVscode');

const SECRET_KEY = 'atompp.ai.anthropicKey';   // legacy Anthropic key location (kept for back-compat)
const FILE_EXCLUDES = '{**/node_modules/**,**/.git/**,**/out/**,**/dist/**,**/.vscode-test/**,**/*.map}';
const STOPWORDS = new Set(['the','and','for','with','that','this','how','does','what','where','when','why','from','into','your','you','are','was','were','will','can','could','should','would','about','have','has','its','it','the','file','code','function','please','show','tell','explain','using','use','used','there','their','then','than','they','them','some','any','all','not','but','get','set']);
const SYSTEM_PROMPT =
	'You are Atom++\'s built-in AI assistant, helping the user write and understand code inside their editor. ' +
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
/** Agent mode: sending runs the autonomous tool loop instead of plain chat. */
let agentMode = true;
/** Apply-then-review session (Keep/Undo for applied agent edits). Set in activate(). */
let review;
/** Persistent agent transcript for the session (tool calls + results), so follow-up goals
 *  remember prior runs. Reset by New Chat. */
let agentMessages = [];

function post(msg) { if (activeWebview) { activeWebview.postMessage(msg); } }

function aiConfig() { return vscode.workspace.getConfiguration('atompp.ai'); }

/** Inline debug trace — prints a 🐛 DEBUG line in the chat (gated by atompp.ai.debug). */
function dbg(label, data) { if (aiConfig().get('debug', true)) { post({ type: 'debug', label, data: data != null ? data : null }); } }

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

/** The base URL for a provider — Ollama honors `ollama.url`, `custom` uses `atompp.ai.baseURL`, else the registry default. */
function baseUrlFor(cfg, providerId) {
	const id = providers.normId(providerId);
	if (id === 'ollama') { return String(cfg.get('ollama.url', 'http://localhost:11434')).replace(/\/+$/, '') + '/v1'; }
	if (id === 'custom') { return String(cfg.get('baseURL', '') || '').replace(/\/+$/, ''); }
	const p = providers.getProvider(id);
	return p ? p.baseURL : null;
}

/** Max output tokens for chat/edit (shared across providers; keeps the existing Claude setting name). */
function maxOutputTokens(cfg) { return cfg.get('claude.maxTokens', 4096); }

/** An explicitly-set `atompp.ai.contextWindow` (user override, e.g. the Claude 1M-token beta), or undefined. */
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
	const pid = currentProviderId();
	return contextLimitFor(pid, activeModel(cfg, pid));
}

/** Prompt for — and store — the API key for a provider. Provider-aware copy. `noKey`/unknown → undefined. */
async function promptForKey(providerId) {
	const id = (typeof providerId === 'string' && providerId) ? providerId : currentProviderId();
	const p = providers.getProvider(id) || providers.getProvider('claude');
	if (p.noKey) { vscode.window.showInformationMessage('Atom++ AI: ' + p.label + ' needs no API key.'); return undefined; }
	const skey = secretKeyFor(p.id);
	const key = await vscode.window.showInputBox({
		title: 'Atom++ AI — ' + p.label + ' API Key',
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
	if (req.reason === 'baseURL') { return 'Set a base URL for the custom OpenAI-compatible provider first (atompp.ai.baseURL).'; }
	if (req.reason === 'insecureBaseURL') { return 'Refusing to send your API key over plain http to a non-local host. Use an https base URL (or a localhost endpoint) for the custom provider.'; }
	return 'No API key set for ' + req.label + '. Use the key button or “Atom++: AI: Set API Key”.';
}

/**
 * Resolve everything needed to call the active provider: id, key, model, baseURL, maxTokens.
 * Returns { ok:false, reason } when a required key/baseURL is missing (after optional prompting) or
 * a custom endpoint would leak the key over plaintext — the caller renders providerErrorMessage().
 * @returns {Promise<{ok:boolean, providerId?:string, apiKey?:string, model?:string, baseURL?:string, maxTokens?:number, label?:string, reason?:string}>}
 */
async function prepProviderRequest(opts) {
	const cfg = aiConfig();
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
	if (!sel) { vscode.window.showInformationMessage('Atom++ AI: select some code first.'); return; }
	pendingContext = sel.block;
	vscode.commands.executeCommand('atomAi.chat.focus');
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
	if (!items.length) { vscode.window.showInformationMessage('Atom++ AI: no workspace files to add.'); return; }

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
	vscode.commands.executeCommand('atomAi.chat.focus');
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
	const wf = vscode.workspace.workspaceFolders;
	const cwd = (wf && wf[0]) ? wf[0].name : '~';
	dbg('approval.request', { id, kind: req.kind, cmd: req.command });
	return new Promise((resolve) => {
		pendingApprovals.set(id, resolve);
		post(Object.assign({ type: 'agentApproval', id, cwd }, req));
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

let lastAgentGoal = null;   // remembered so the response bar's Retry can re-run it
async function agentFlow(text) {
	if (text && text.trim()) { lastAgentGoal = text; }
	const cfg = aiConfig();
	const providerId = currentProviderId();
	const agentModel = activeModel(cfg, providerId);
	if (!catalog.supportsToolsForModel(providerId, agentModel)) {
		const p = providers.getProvider(providerId);
		const who = agentModel ? '“' + agentModel + '”' : ((p && p.label) || 'This provider');
		post({ type: 'agentError', message: 'Agent mode needs a tool-capable model. ' + who + ' isn’t set up for tool use in Atom++ — it still works for chat, inline completion and edits. Pick a tool-capable model (Claude, GPT-4o, or most OpenRouter / Groq / DeepSeek / Mistral models) via “Atom++: AI: Select Model…”.' });
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
			post, dbg,
			approve: requestApproval,           // run_command only
			ask: requestQuestions,              // ask_user — clickable clarifying questions
			skills: skillsObj,                  // M6.5: implicit skills (name+desc menu in SYSTEM + use_skill resolver)
			contextLimit: contextLimitFor(req.providerId, req.model), // explicit override, else the model's real window → usage meter
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
		await providers.streamChat({
			providerId: req.providerId, apiKey: req.apiKey, baseURL: req.baseURL,
			model: req.model, maxTokens: req.maxTokens, system: SYSTEM_PROMPT,
			messages: conversation, signal: abort.signal, onDelta
		});
		conversation.push({ role: 'assistant', content: assistant });
		post({ type: 'assistantDone' });
	} catch (e) {
		if (abort && abort.signal.aborted) {
			if (assistant) { conversation.push({ role: 'assistant', content: assistant }); }
			post({ type: 'assistantDone' });
		} else {
			conversation.pop();
			post({ type: 'assistantError', message: String((e && e.message) || e) });
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

async function pickModel() {
	const cfg = aiConfig();
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
	items.push({ label: '$(globe) OpenAI-compatible endpoint…', description: 'Point Atom++ at any /v1 server (vLLM, LM Studio, LiteLLM…)', _action: 'customEndpoint' });

	const curId = currentProviderId();
	const curModel = activeModel(cfg, curId);
	const pick = await vscode.window.showQuickPick(items, {
		placeHolder: `Select AI model (current: ${curModel} · ${(providers.getProvider(curId) || {}).label})`,
		matchOnDescription: true
	});
	if (!pick) { return; }

	if (pick._action === 'browse') { await browseProviderModels(cfg, curId); return; }
	if (pick._action === 'manualModel') {
		const id = await vscode.window.showInputBox({ title: 'Atom++ AI — Model ID', prompt: 'Model id for ' + (providers.getProvider(curId) || {}).label, ignoreFocusOut: true, value: curModel });
		if (!id) { return; }
		await setModelSetting(cfg, curId, id.trim());
		sendConfigToWebview();
		return;
	}
	if (pick._action === 'customEndpoint') {
		const url = await vscode.window.showInputBox({ title: 'Atom++ AI — OpenAI-compatible base URL', prompt: 'Base URL ending in /v1 (e.g. http://localhost:8000/v1)', placeHolder: 'https://…/v1', ignoreFocusOut: true, value: cfg.get('baseURL', '') });
		if (!url) { return; }
		const model = await vscode.window.showInputBox({ title: 'Atom++ AI — Model ID', prompt: 'Model id served by that endpoint', ignoreFocusOut: true });
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
		{ location: vscode.ProgressLocation.Notification, title: 'Atom++ AI: fetching ' + p.label + ' models…' },
		() => catalog.getModelChoices(providerId, { dynamic: true, apiKey, baseURL, ollamaUrl: cfg.get('ollama.url', 'http://localhost:11434') })
	);
	if (!choices.length) { vscode.window.showInformationMessage('Atom++ AI: no models returned for ' + p.label + ' (offline, or the provider needs an API key set first).'); return; }
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
				case 'ready': sendConfigToWebview(); postActiveFile(); postContextFiles(); post({ type: 'mode', agent: agentMode }); postAccount(); buildFileIndex(); post({ type: 'contextUsage', input: 0, limit: currentContextLimit() }); if (review) { review.resync(); } break;
				case 'setMode': agentMode = !!msg.agent; post({ type: 'mode', agent: agentMode }); break;
				case 'send': await handleSend(msg.text); break;
				case 'stop': dbg('stop.clicked', { running: commandStops.size }); for (const [, stop] of commandStops) { try { stop(); } catch (e) { /* gone */ } } if (abort) { abort.abort(); } clearApprovals(); clearQuestions(); break;
				case 'stopCommand': { dbg('stopCommand', { id: msg.id }); const s = commandStops.get(msg.id); if (s) { try { s(); } catch (e) { /* gone */ } } break; }
				case 'approvalResponse': resolveApproval(msg.id, msg.approved); break;
				case 'questionsResponse': resolveQuestions(msg.id, msg.answers, msg.notes); break;
				case 'accountSignIn': await accountSignIn(msg.provider, msg.create); break;
				case 'accountSignOut': await accountSignOut(); break;
				case 'accountManage': await accountManage(); break;
				case 'copy': try { await vscode.env.clipboard.writeText(String(msg.text || '')); } catch (e) { /* clipboard unavailable */ } break;
				case 'retry': if (lastAgentGoal && !abort) { dbg('retry', { goalChars: lastAgentGoal.length }); await agentFlow(lastAgentGoal); } break;
				case 'continueAgent': if (!abort) { const g = lastAgentGoal; dbg('continue', { transcriptMsgs: agentMessages.length }); await agentFlow('Continue from where you left off and finish the task. Pick up exactly where you stopped — do not restart or repeat work that is already done.'); lastAgentGoal = g; } break;
				case 'restoreCheckpoint': dbg('restoreCheckpoint', { turnId: msg.turnId, running: !!abort }); await restoreCheckpoint(msg.turnId); break;
				case 'listSkills': { const en = aiConfig().get('skills.enabled', true); const idx = en ? loadSkills(ctx.extensionPath, dbg) : new Map(); dbg('listSkills', { enabled: en, count: idx.size }); post({ type: 'skillsList', enabled: en, skills: skillsMenu(idx) }); break; }
				case 'feedback': dbg('feedback', { value: msg.value }); break;
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
				case 'setKey': await promptForKey(); break;
				case 'pickModel': await pickModel(); break;
				case 'openSettings': vscode.commands.executeCommand('workbench.action.openSettings', '@ext:atompp.atom-ai'); break;
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

// ---- Atom++ Cloud account (sign-in + sync) -------------------------------------------------
// IMPORTANT: this is a SEPARATE, optional layer. The AI path stays BYO-key / no-backend — the
// account only syncs settings/skills/profile, never proxies AI or sees your provider keys.
// It is gated on a configured `atompp.cloud.endpoint`; with none set, sign-in is honestly inert.
const ACCOUNT_TOKEN_KEY = 'atompp.cloud.token';     // session token → SecretStorage
const ACCOUNT_PROFILE_KEY = 'atompp.cloud.profile'; // {name,email,plan} → globalState
function cloudEndpoint() { return String(vscode.workspace.getConfiguration('atompp.cloud').get('endpoint', '') || '').replace(/\/+$/, ''); }
async function currentAccount() {
	const token = ctx ? await ctx.secrets.get(ACCOUNT_TOKEN_KEY) : null;
	if (token) {
		const p = (ctx && ctx.globalState.get(ACCOUNT_PROFILE_KEY)) || {};
		return { signedIn: true, name: p.name || p.email || 'Atom++ user', email: p.email || '', plan: p.plan || '' };
	}
	return { signedIn: false, status: cloudEndpoint() ? 'signedout' : 'unconfigured' };
}
async function postAccount(open) {
	const a = await currentAccount();
	post(Object.assign({ type: 'account', open: !!open }, a));
}
async function accountSignIn(provider, create) {
	const endpoint = cloudEndpoint();
	if (!endpoint) {
		dbg('account.signin', { unconfigured: true });
		await postAccount(true);
		vscode.window.showInformationMessage('Atom++ Cloud isn’t connected yet. Set "atompp.cloud.endpoint" to your account server to sign in. (Accounts + sync are on the roadmap — M9.)');
		return;
	}
	// Canonical editor OAuth callback: open the server's auth page with a redirect back to us.
	const cb = await vscode.env.asExternalUri(vscode.Uri.parse(`${vscode.env.uriScheme}://atompp.atom-ai/auth/callback`));
	const path = create ? 'signup' : (provider ? 'oauth/' + encodeURIComponent(provider) : 'login');
	const url = `${endpoint}/auth/${path}?redirect_uri=${encodeURIComponent(cb.toString())}`;
	dbg('account.signin', { provider: provider || 'browser', create: !!create });
	await vscode.env.openExternal(vscode.Uri.parse(url));
}
async function accountSignOut() {
	if (ctx) { await ctx.secrets.delete(ACCOUNT_TOKEN_KEY); await ctx.globalState.update(ACCOUNT_PROFILE_KEY, undefined); }
	dbg('account.signout');
	await postAccount();
}
async function accountManage() {
	const endpoint = cloudEndpoint();
	if (endpoint) { await vscode.env.openExternal(vscode.Uri.parse(endpoint + '/account')); }
	else { await postAccount(true); }
}
// The browser redirects to atom-plus-plus://atompp.atom-ai/auth/callback?token=…&name=…&email=…
async function handleAuthCallback(uri) {
	try {
		const q = new URLSearchParams(uri.query || '');
		const token = q.get('token');
		if (!token) { return; }
		if (ctx) {
			await ctx.secrets.store(ACCOUNT_TOKEN_KEY, token);
			await ctx.globalState.update(ACCOUNT_PROFILE_KEY, { name: q.get('name') || '', email: q.get('email') || '', plan: q.get('plan') || '' });
		}
		dbg('account.callback', { ok: true });
		await postAccount(true);
		vscode.window.showInformationMessage('Signed in to Atom++.');
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
	if (!uri) { vscode.window.showWarningMessage('Atom++: could not locate ' + rel); return; }
	try {
		await vscode.commands.executeCommand('revealInExplorer', uri);   // reveal in the (nested) Explorer tree
		await vscode.window.showTextDocument(uri, { preview: false });   // open in the main editor
		dbg('openFile', { rel: rel });
	} catch (e) { dbg('openFile.error', { msg: String((e && e.message) || e) }); }
}

function activate(context) {
	ctx = context;
	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider('atomAi.chat', new ChatViewProvider(), {
			webviewOptions: { retainContextWhenHidden: true }
		}),
		vscode.window.onDidChangeActiveTextEditor(() => postActiveFile()),
		vscode.commands.registerCommand('atompp.ai.focus', () => vscode.commands.executeCommand('atomAi.chat.focus')),
		vscode.commands.registerCommand('atompp.customize', () => openCustomize(context)),
		vscode.commands.registerCommand('atompp.import.vscode', () => importFromVscode(context)),
		vscode.commands.registerCommand('atompp.ai.newChat', newChat),
		vscode.commands.registerCommand('atompp.ai.pickModel', pickModel),
		vscode.commands.registerCommand('atompp.ai.addSelection', addSelection),
		vscode.commands.registerCommand('atompp.ai.addFileContext', addContext),
		vscode.commands.registerCommand('atompp.ai.setApiKey', () => promptForKey()),
		vscode.commands.registerCommand('atompp.ai.clearApiKey', async () => {
			const id = currentProviderId();
			const skey = secretKeyFor(id);
			const label = (providers.getProvider(id) || {}).label || 'provider';
			if (!skey) { vscode.window.showInformationMessage('Atom++ AI: ' + label + ' uses no API key.'); return; }
			await context.secrets.delete(skey);
			vscode.window.showInformationMessage('Atom++ AI: ' + label + ' API key cleared.');
		}),
		vscode.commands.registerCommand('atompp.ai.account', () => postAccount(true)),
		vscode.window.registerUriHandler({ handleUri(uri) { if (uri.path === '/auth/callback') { handleAuthCallback(uri); } } }),
		vscode.workspace.onDidCreateFiles(scheduleFileIndex),
		vscode.workspace.onDidDeleteFiles(scheduleFileIndex),
		vscode.workspace.onDidRenameFiles(scheduleFileIndex),
		vscode.workspace.onDidChangeWorkspaceFolders(scheduleFileIndex),
		vscode.workspace.onDidChangeConfiguration((e) => {
			if (e.affectsConfiguration('atompp.ai')) { sendConfigToWebview(); }
			if (e.affectsConfiguration('atompp.cloud')) { postAccount(); }
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

	// AI-first: reveal the chat (in the secondary side bar) on first launch. We do this once
	// and then defer to VS Code's own per-workspace layout persistence, so if the user later
	// closes the panel we don't keep forcing it back open.
	if (!context.globalState.get('atompp.ai.didAutoOpen')) {
		context.globalState.update('atompp.ai.didAutoOpen', true);
		setTimeout(() => { vscode.commands.executeCommand('atomAi.chat.focus'); }, 600);
	}

	// First-launch onboarding: open the Welcome walkthrough once.
	if (!context.globalState.get('atompp.ai.didShowWelcome')) {
		context.globalState.update('atompp.ai.didShowWelcome', true);
		setTimeout(() => { vscode.commands.executeCommand('workbench.action.openWalkthrough', 'atompp.atom-ai#welcome', false).then(undefined, () => {}); }, 900);
	}
}

function deactivate() { if (abort) { abort.abort(); } reapCommands(); }

module.exports = { activate, deactivate };
