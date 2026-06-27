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
const { streamClaude, streamOllama, completeClaude, completeOllama, listOllamaModels } = require('./providers');
const { registerAiEdit } = require('./aiEdit');
const { registerLmProvider } = require('./lmProvider');
const { registerInlineComplete } = require('./inlineComplete');
const { runAgent } = require('./agent');
const { registerReview } = require('./reviewSession');

const CLAUDE_MODELS = [
	{ label: 'Claude Opus 4.8', id: 'claude-opus-4-8', detail: 'Most capable' },
	{ label: 'Claude Sonnet 4.6', id: 'claude-sonnet-4-6', detail: 'Balanced (default)' },
	{ label: 'Claude Haiku 4.5', id: 'claude-haiku-4-5-20251001', detail: 'Fastest' }
];

const SECRET_KEY = 'atompp.ai.anthropicKey';
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
let agentMode = false;
/** Apply-then-review session (Keep/Undo for applied agent edits). Set in activate(). */
let review;
/** Persistent agent transcript for the session (tool calls + results), so follow-up goals
 *  remember prior runs. Reset by New Chat. */
let agentMessages = [];

function post(msg) { if (activeWebview) { activeWebview.postMessage(msg); } }

function aiConfig() { return vscode.workspace.getConfiguration('atompp.ai'); }

async function promptForKey() {
	const key = await vscode.window.showInputBox({
		title: 'Atom++ AI — Anthropic API Key',
		prompt: 'Paste your Anthropic API key (from console.anthropic.com). Stored encrypted in your OS keychain.',
		password: true,
		ignoreFocusOut: true,
		placeHolder: 'sk-ant-…'
	});
	if (key) { await ctx.secrets.store(SECRET_KEY, key.trim()); }
	return key ? key.trim() : undefined;
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
	pendingContext = null;
	contextFiles = [];
	if (abort) { abort.abort(); }
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

/** Pending in-chat approval requests, keyed by id, resolved by the webview. */
const pendingApprovals = new Map();
let approvalSeq = 0;

/** Ask the webview to approve an action; resolves true/false. */
function requestApproval(req) {
	const id = String(++approvalSeq);
	return new Promise((resolve) => {
		pendingApprovals.set(id, resolve);
		post(Object.assign({ type: 'agentApproval', id }, req));
	});
}
function resolveApproval(id, approved) {
	const r = pendingApprovals.get(id);
	if (r) { pendingApprovals.delete(id); r(!!approved); }
}
function clearApprovals() {
	for (const [, r] of pendingApprovals) { r(false); }
	pendingApprovals.clear();
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
function trimAgentMemory() {
	const MAX = 80, KEEP = 60;
	if (agentMessages.length <= MAX) { return; }
	let cut = agentMessages.length - KEEP;
	while (cut < agentMessages.length && !(agentMessages[cut].role === 'user' && typeof agentMessages[cut].content === 'string')) { cut++; }
	if (cut > 0 && cut < agentMessages.length) { agentMessages.splice(0, cut); }
}

async function agentFlow(text) {
	const cfg = aiConfig();
	if (cfg.get('provider', 'claude') !== 'claude') {
		post({ type: 'agentError', message: 'Agent mode currently requires the Claude provider.' });
		post({ type: 'agentDone', reason: 'error' });
		return;
	}
	let key = await ctx.secrets.get(SECRET_KEY);
	if (!key) { key = await promptForKey(); }
	if (!key) { post({ type: 'agentError', message: 'No Anthropic API key set.' }); post({ type: 'agentDone', reason: 'error' }); return; }

	post({ type: 'agentStart' });
	abort = new AbortController();
	repairAgentMemory();
	agentMessages.push({ role: 'user', content: text });
	trimAgentMemory();
	try {
		await runAgent({
			messages: agentMessages, // persists across runs → the agent remembers the session
			apiKey: key,
			model: cfg.get('claude.model', 'claude-sonnet-4-6'),
			maxSteps: Math.max(1, cfg.get('agent.maxSteps', 25)),
			post,
			approve: requestApproval,           // run_command only
			applyEdit: (req) => review.applyEdit(req), // file edits: apply-then-review
			signal: abort.signal
		});
	} finally {
		clearApprovals();
		abort = null;
	}
}

async function handleSend(text) {
	if (!text || !text.trim()) { return; }
	if (agentMode) { await agentFlow(text); return; }
	const cfg = aiConfig();
	const provider = cfg.get('provider', 'claude');

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
		if (provider === 'claude') {
			let key = await ctx.secrets.get(SECRET_KEY);
			if (!key) { key = await promptForKey(); }
			if (!key) {
				conversation.pop();
				post({ type: 'assistantError', message: 'No Anthropic API key set. Use the key button or “Atom++: AI: Set Anthropic API Key”.' });
				return;
			}
			await streamClaude({
				apiKey: key,
				model: cfg.get('claude.model', 'claude-sonnet-4-6'),
				maxTokens: cfg.get('claude.maxTokens', 4096),
				system: SYSTEM_PROMPT,
				messages: conversation,
				signal: abort.signal,
				onDelta
			});
		} else {
			await streamOllama({
				url: cfg.get('ollama.url', 'http://localhost:11434'),
				model: cfg.get('ollama.model', 'llama3.1'),
				system: SYSTEM_PROMPT,
				messages: conversation,
				signal: abort.signal,
				onDelta
			});
		}
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

async function pickModel() {
	const cfg = aiConfig();
	/** @type {any[]} */
	const items = CLAUDE_MODELS.map((m) => ({ label: m.label, description: m.id, detail: m.detail, _id: m.id, _provider: 'claude' }));

	const ollama = await listOllamaModels(cfg.get('ollama.url', 'http://localhost:11434'));
	items.push({ label: 'Local (Ollama)', kind: vscode.QuickPickItemKind.Separator });
	if (ollama.length) {
		for (const name of ollama) { items.push({ label: name, description: 'Ollama', _id: name, _provider: 'ollama' }); }
	} else {
		const current = cfg.get('ollama.model', 'llama3.1');
		items.push({ label: current, description: 'Ollama (start Ollama to list installed models)', _id: current, _provider: 'ollama' });
	}

	const curProvider = cfg.get('provider', 'claude');
	const curModel = curProvider === 'claude' ? cfg.get('claude.model', 'claude-sonnet-4-6') : cfg.get('ollama.model', 'llama3.1');
	const pick = await vscode.window.showQuickPick(items, {
		placeHolder: `Select AI model (current: ${curModel})`,
		matchOnDescription: true
	});
	if (!pick || !pick._id) { return; }

	await cfg.update('provider', pick._provider, vscode.ConfigurationTarget.Global);
	if (pick._provider === 'claude') {
		await cfg.update('claude.model', pick._id, vscode.ConfigurationTarget.Global);
	} else {
		await cfg.update('ollama.model', pick._id, vscode.ConfigurationTarget.Global);
	}
	sendConfigToWebview();
}

function sendConfigToWebview() {
	const cfg = aiConfig();
	const provider = cfg.get('provider', 'claude');
	const model = provider === 'claude' ? cfg.get('claude.model', 'claude-sonnet-4-6') : cfg.get('ollama.model', 'llama3.1');
	post({ type: 'config', provider, model });
}

class ChatViewProvider {
	/** @param {vscode.WebviewView} view */
	resolveWebviewView(view) {
		activeWebview = view.webview;
		view.webview.options = { enableScripts: true, localResourceRoots: [ctx.extensionUri] };
		view.webview.html = getHtml();
		view.webview.onDidReceiveMessage(async (msg) => {
			switch (msg.type) {
				case 'ready': sendConfigToWebview(); postActiveFile(); postContextFiles(); post({ type: 'mode', agent: agentMode }); break;
				case 'setMode': agentMode = !!msg.agent; post({ type: 'mode', agent: agentMode }); break;
				case 'send': await handleSend(msg.text); break;
				case 'stop': if (abort) { abort.abort(); } clearApprovals(); break;
				case 'approvalResponse': resolveApproval(msg.id, msg.approved); break;
				case 'reviewKeepFile': review.keepFile(msg.id, 'kept'); break;
				case 'reviewUndoFile': await review.undoFile(msg.id); break;
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

function activate(context) {
	ctx = context;
	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider('atomAi.chat', new ChatViewProvider(), {
			webviewOptions: { retainContextWhenHidden: true }
		}),
		vscode.window.onDidChangeActiveTextEditor(() => postActiveFile()),
		vscode.commands.registerCommand('atompp.ai.focus', () => vscode.commands.executeCommand('atomAi.chat.focus')),
		vscode.commands.registerCommand('atompp.ai.newChat', newChat),
		vscode.commands.registerCommand('atompp.ai.pickModel', pickModel),
		vscode.commands.registerCommand('atompp.ai.addSelection', addSelection),
		vscode.commands.registerCommand('atompp.ai.addFileContext', addContext),
		vscode.commands.registerCommand('atompp.ai.setApiKey', promptForKey),
		vscode.commands.registerCommand('atompp.ai.clearApiKey', async () => {
			await context.secrets.delete(SECRET_KEY);
			vscode.window.showInformationMessage('Atom++ AI: Anthropic API key cleared.');
		}),
		vscode.workspace.onDidChangeConfiguration((e) => {
			if (e.affectsConfiguration('atompp.ai')) { sendConfigToWebview(); }
		})
	);

	// AI edit-with-diff (select code → instruct → review diff → apply)
	registerAiEdit(context, {
		aiConfig,
		getClaudeKey: async () => {
			let key = await context.secrets.get(SECRET_KEY);
			if (!key) { key = await promptForKey(); }
			return key;
		},
		streamClaude,
		streamOllama
	});

	// Claude as a native Language Model provider (powers VS Code's built-in chat/edit UI).
	registerLmProvider(context, async (silent) => {
		let key = await context.secrets.get(SECRET_KEY);
		if (!key && !silent) { key = await promptForKey(); }
		return key;
	});

	// Apply-then-review: agent edits land immediately and are reviewed with Keep/Undo (editor + panel).
	review = registerReview(context, post);

	// Inline (ghost-text) tab-completion. Silent key lookup — it must never prompt mid-typing.
	registerInlineComplete(context, {
		aiConfig,
		getKeySilent: () => context.secrets.get(SECRET_KEY),
		completeClaude,
		completeOllama
	});

	// AI-first: reveal the chat (in the secondary side bar) on first launch. We do this once
	// and then defer to VS Code's own per-workspace layout persistence, so if the user later
	// closes the panel we don't keep forcing it back open.
	if (!context.globalState.get('atompp.ai.didAutoOpen')) {
		context.globalState.update('atompp.ai.didAutoOpen', true);
		setTimeout(() => { vscode.commands.executeCommand('atomAi.chat.focus'); }, 600);
	}
}

function deactivate() { if (abort) { abort.abort(); } }

module.exports = { activate, deactivate };
