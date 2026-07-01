/*---------------------------------------------------------------------------------------------
 *  Atom++ — AI (M2, feature 2: inline tab-completion)
 *
 *  Ghost-text completions as you type, accepted with Tab. Uses VS Code's stable
 *  InlineCompletionItemProvider API (no core patches). Requests go directly to the
 *  provider (Claude / Ollama) — debounced, and cancelled the moment you keep typing.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

const vscode = require('vscode');

const PREFIX_MAX = 2500; // chars of context before the cursor (smaller = faster first token)
const SUFFIX_MAX = 1000; // chars of context after the cursor
const MAX_TOKENS = 160;  // keep completions short & snappy

const SYSTEM_PROMPT =
	'You are a code completion engine inside the Atom++ editor. You are given the code ' +
	'before the cursor and the code after it, with the insertion point marked <CURSOR>. ' +
	'Reply with ONLY the raw code that should be inserted at <CURSOR> to continue the code ' +
	'naturally. Do NOT repeat code that already exists before or after the cursor. Do NOT ' +
	'wrap your answer in markdown fences. Do NOT add explanations. If no completion is ' +
	'appropriate, reply with an empty string.';

/** @param {vscode.CancellationToken} token */
function sleep(ms, token) {
	return new Promise((resolve) => {
		const t = setTimeout(resolve, ms);
		token.onCancellationRequested(() => { clearTimeout(t); resolve(undefined); });
	});
}

/** Build prefix/suffix context windows around the cursor. */
function buildContext(document, position) {
	const start = new vscode.Position(0, 0);
	const lastLine = document.lineAt(document.lineCount - 1);
	const end = lastLine.range.end;
	const pre = document.getText(new vscode.Range(start, position));
	const suf = document.getText(new vscode.Range(position, end));
	return { prefix: pre.slice(-PREFIX_MAX), suffix: suf.slice(0, SUFFIX_MAX) };
}

/** Strip accidental markdown fences / leading language tags the model may add. */
function clean(text) {
	if (!text) { return ''; }
	let t = text;
	const fence = String.fromCharCode(96, 96, 96);
	if (t.indexOf(fence) >= 0) {
		// Take the content of the first fenced block if the whole thing got wrapped.
		const m = t.match(new RegExp(fence + '[a-zA-Z0-9_+-]*\\n?([\\s\\S]*?)' + fence));
		if (m) { t = m[1]; }
		else { t = t.split(fence).join(''); }
	}
	return t;
}

/**
 * @param {vscode.ExtensionContext} context
 * @param {{ aiConfig: () => vscode.WorkspaceConfiguration,
 *           prepProviderRequest: (o?:any) => Promise<any>,
 *           complete: Function, fastCompletionModel: (providerId:string)=>(string|null) }} deps
 */
function registerInlineComplete(context, deps) {
	const { aiConfig, prepProviderRequest, complete, fastCompletionModel } = deps;

	// --- status bar toggle ---------------------------------------------------
	const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 50);
	status.command = 'atompp.ai.toggleCompletions';
	function refreshStatus() {
		const on = aiConfig().get('completions.enabled', true);
		status.text = on ? '$(sparkle) AI' : '$(circle-slash) AI';
		status.tooltip = on
			? 'Atom++ AI inline completions: ON (click to disable)'
			: 'Atom++ AI inline completions: OFF (click to enable)';
		status.show();
	}
	refreshStatus();

	context.subscriptions.push(
		status,
		vscode.commands.registerCommand('atompp.ai.toggleCompletions', async () => {
			const cfg = aiConfig();
			const next = !cfg.get('completions.enabled', true);
			await cfg.update('completions.enabled', next, vscode.ConfigurationTarget.Global);
			refreshStatus();
			vscode.window.setStatusBarMessage('Atom++ AI completions ' + (next ? 'enabled' : 'disabled'), 2000);
		}),
		vscode.workspace.onDidChangeConfiguration((e) => {
			if (e.affectsConfiguration('atompp.ai.completions')) { refreshStatus(); }
		})
	);

	// --- the provider --------------------------------------------------------
	/** @type {vscode.InlineCompletionItemProvider} */
	const provider = {
		async provideInlineCompletionItems(document, position, ctx, token) {
			const cfg = aiConfig();
			if (!cfg.get('completions.enabled', true)) { return null; }
			if (document.uri.scheme !== 'file' && document.uri.scheme !== 'untitled') { return null; }

			// Debounce: if the user keeps typing, this token is cancelled and we bail.
			const debounce = Math.max(0, cfg.get('completions.debounce', 150));
			await sleep(debounce, token);
			if (token.isCancellationRequested) { return null; }

			const { prefix, suffix } = buildContext(document, position);
			if (!prefix.trim() && !suffix.trim()) { return null; }

			const userContent =
				'Language: ' + (document.languageId || 'plaintext') + '\n' +
				'Insert code at <CURSOR>. Reply with ONLY the text to insert.\n\n' +
				prefix + '<CURSOR>' + suffix;

			const ac = new AbortController();
			const sub = token.onCancellationRequested(() => ac.abort());

			let text = '';
			try {
				// Silent (prompt:false): never pop a key dialog while the user is typing.
				const req = await prepProviderRequest({ prompt: false });
				if (!req.ok || token.isCancellationRequested) { return null; }
				// Claude uses the configurable completions model; other providers use their curated fast
				// model (gpt-4o-mini, llama-3.1-8b-instant, …) when one exists, else the active chat model.
				const model = req.providerId === 'claude'
					? cfg.get('completions.model', 'claude-haiku-4-5-20251001')
					: (fastCompletionModel(req.providerId) || req.model);
				text = await complete({
					providerId: req.providerId, apiKey: req.apiKey, baseURL: req.baseURL,
					model, maxTokens: MAX_TOKENS, system: SYSTEM_PROMPT,
					messages: [{ role: 'user', content: userContent }], signal: ac.signal
				});
			} catch (e) {
				// Network/abort/key errors are silent — inline completion must never nag.
				return null;
			} finally {
				sub.dispose();
			}

			if (token.isCancellationRequested) { return null; }
			const insert = clean(text);
			if (!insert.trim()) { return null; }
			// Avoid suggesting text that just duplicates what's already after the cursor.
			if (suffix.startsWith(insert)) { return null; }

			const item = new vscode.InlineCompletionItem(insert, new vscode.Range(position, position));
			return [item];
		}
	};

	context.subscriptions.push(
		vscode.languages.registerInlineCompletionItemProvider({ pattern: '**' }, provider)
	);
}

module.exports = { registerInlineComplete };
