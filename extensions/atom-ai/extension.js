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
const { streamClaude, streamOllama, listOllamaModels } = require('./providers');
const { registerAiEdit } = require('./aiEdit');
const { registerLmProvider } = require('./lmProvider');

const CLAUDE_MODELS = [
	{ label: 'Claude Opus 4.8', id: 'claude-opus-4-8', detail: 'Most capable' },
	{ label: 'Claude Sonnet 4.6', id: 'claude-sonnet-4-6', detail: 'Balanced (default)' },
	{ label: 'Claude Haiku 4.5', id: 'claude-haiku-4-5-20251001', detail: 'Fastest' }
];

const SECRET_KEY = 'atompp.ai.anthropicKey';
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
/** @type {AbortController | null} */
let abort = null;

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

function newChat() {
	conversation = [];
	pendingContext = null;
	if (abort) { abort.abort(); }
	post({ type: 'reset' });
}

async function handleSend(text) {
	if (!text || !text.trim()) { return; }
	const cfg = aiConfig();
	const provider = cfg.get('provider', 'claude');

	const userContent = pendingContext ? (pendingContext + '\n\n' + text) : text;
	conversation.push({ role: 'user', content: userContent });
	post({ type: 'userMessage', text });
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
				case 'ready': sendConfigToWebview(); break;
				case 'send': await handleSend(msg.text); break;
				case 'stop': if (abort) { abort.abort(); } break;
				case 'addSelection': addSelection(); break;
				case 'newChat': newChat(); break;
				case 'setKey': await promptForKey(); break;
				case 'pickModel': await pickModel(); break;
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
		vscode.commands.registerCommand('atompp.ai.focus', () => vscode.commands.executeCommand('atomAi.chat.focus')),
		vscode.commands.registerCommand('atompp.ai.newChat', newChat),
		vscode.commands.registerCommand('atompp.ai.pickModel', pickModel),
		vscode.commands.registerCommand('atompp.ai.addSelection', addSelection),
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
}

function deactivate() { if (abort) { abort.abort(); } }

module.exports = { activate, deactivate };
