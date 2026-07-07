/*---------------------------------------------------------------------------------------------
 *  LevelCode — AI (M2: edit selection → reviewable diff)
 *
 *  Select code → describe a change → the model rewrites it → review a side-by-side diff →
 *  ✓ Keep / ✗ Discard from the diff editor's toolbar. The proposed text is served through a
 *  virtual document so the diff is syntax-highlighted before/after, and your file isn't
 *  changed until you Keep.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

const vscode = require('vscode');
const path = require('path');

const SCHEME = 'levelcode-ai';
const CTX_DIFF_ACTIVE = 'levelcode.ai.diffActive';

/** @type {Map<string,string>} virtual-doc uri -> content */
const contents = new Map();
/** @type {Map<string,{docUri:vscode.Uri, range:vscode.Range, newText:string, origUri:vscode.Uri}>} keyed by proposed uri */
const pending = new Map();
let counter = 0;
let providerRegistered = false;

const EDIT_SYSTEM =
	'You are a precise code editor. Rewrite the user\'s code so it satisfies their instruction. ' +
	'Output ONLY the rewritten code — no explanations, no commentary, and no Markdown code fences.';

function stripFences(text) {
	let s = text.trim();
	s = s.replace(/^```[a-zA-Z0-9_+\-.]*\n?/, '');
	s = s.replace(/\n?```$/, '');
	return s;
}

function registerProvider(context) {
	if (providerRegistered) { return; }
	providerRegistered = true;
	context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(SCHEME, {
		provideTextDocumentContent(uri) { return contents.get(uri.toString()) || ''; }
	}));
}

/** The proposed-uri of the diff in the currently active tab, if it's one of ours. */
function activeProposedUri() {
	const group = vscode.window.tabGroups.activeTabGroup;
	const input = /** @type {any} */ (group && group.activeTab && group.activeTab.input);
	if (input && input.modified && input.modified.scheme === SCHEME && pending.has(input.modified.toString())) {
		return input.modified;
	}
	return undefined;
}

function updateDiffContext() {
	vscode.commands.executeCommand('setContext', CTX_DIFF_ACTIVE, !!activeProposedUri());
}

function cleanup(propUri) {
	const key = propUri.toString();
	const p = pending.get(key);
	if (p) { contents.delete(p.origUri.toString()); }
	contents.delete(key);
	pending.delete(key);
}

async function closeDiffTab(propUri) {
	for (const group of vscode.window.tabGroups.all) {
		for (const tab of group.tabs) {
			const input = /** @type {any} */ (tab.input);
			if (input && input.modified && input.modified.toString() === propUri.toString()) {
				await vscode.window.tabGroups.close(tab);
			}
		}
	}
}

async function applyEdit() {
	const propUri = activeProposedUri();
	if (!propUri) { return; }
	const p = pending.get(propUri.toString());
	if (!p) { return; }
	const we = new vscode.WorkspaceEdit();
	we.replace(p.docUri, p.range, p.newText);
	await vscode.workspace.applyEdit(we);
	cleanup(propUri);
	await closeDiffTab(propUri);
	updateDiffContext();
	vscode.window.setStatusBarMessage('$(check) LevelCode AI: edit applied', 2000);
}

async function discardEdit() {
	const propUri = activeProposedUri();
	if (!propUri) { return; }
	cleanup(propUri);
	await closeDiffTab(propUri);
	updateDiffContext();
	vscode.window.setStatusBarMessage('LevelCode AI: edit discarded', 1500);
}

/** Whole-line range covering the selection. */
function fullLineRange(editor) {
	const sel = editor.selection;
	let endLine = sel.end.line;
	if (sel.end.character === 0 && endLine > sel.start.line) { endLine -= 1; }
	return new vscode.Range(sel.start.line, 0, endLine, editor.document.lineAt(endLine).text.length);
}

/** @param {{aiConfig:()=>any, prepProviderRequest:(o?:any)=>Promise<any>, streamChat:Function}} deps */
async function editSelection(deps) {
	const ed = vscode.window.activeTextEditor;
	if (!ed || ed.selection.isEmpty) {
		vscode.window.showInformationMessage('LevelCode AI: select the code you want to edit first.');
		return;
	}
	const instruction = await vscode.window.showInputBox({
		title: 'LevelCode AI — Edit selection',
		prompt: 'Describe the change',
		placeHolder: 'e.g. add error handling and a JSDoc comment',
		ignoreFocusOut: true
	});
	if (!instruction) { return; }

	const doc = ed.document;
	const range = fullLineRange(ed);
	const original = doc.getText(range);
	const lang = doc.languageId || '';
	const userMsg = `Instruction: ${instruction}\n\nCode (${lang}):\n${original}`;

	let result = '';
	try {
		await vscode.window.withProgress(
			{ location: vscode.ProgressLocation.Notification, title: 'LevelCode AI is editing…', cancellable: true },
			async (_progress, token) => {
				const ac = new AbortController();
				token.onCancellationRequested(() => ac.abort());
				const onDelta = (d) => { result += d; };
				const req = await deps.prepProviderRequest({ prompt: true });
				if (!req.ok) {
					throw new Error(
						req.reason === 'baseURL' ? 'Set a base URL for the custom OpenAI-compatible provider first (levelcode.ai.baseURL).'
						: req.reason === 'insecureBaseURL' ? 'Refusing to send your API key over plain http to a non-local host. Use an https (or localhost) base URL.'
						: 'No API key set for ' + req.label + '.');
				}
				await deps.streamChat({
					providerId: req.providerId, apiKey: req.apiKey, baseURL: req.baseURL,
					model: req.model, maxTokens: req.maxTokens, system: EDIT_SYSTEM,
					messages: [{ role: 'user', content: userMsg }], signal: ac.signal, onDelta
				});
			}
		);
	} catch (e) {
		vscode.window.showErrorMessage('LevelCode AI edit failed: ' + String((e && e.message) || e));
		return;
	}

	const proposed = stripFences(result);
	if (!proposed.trim()) { vscode.window.showWarningMessage('LevelCode AI: no edit was produced.'); return; }

	const ext = path.extname(doc.uri.fsPath) || '.txt';
	const n = ++counter;
	const origUri = vscode.Uri.parse(`${SCHEME}:/${n}/current${ext}`);
	const propUri = vscode.Uri.parse(`${SCHEME}:/${n}/proposed${ext}`);
	contents.set(origUri.toString(), original);
	contents.set(propUri.toString(), proposed);
	pending.set(propUri.toString(), { docUri: doc.uri, range, newText: proposed, origUri });

	await vscode.commands.executeCommand('vscode.diff', origUri, propUri,
		'LevelCode AI: proposed edit — use ✓ Keep / ✗ Discard above', { preview: true });
	updateDiffContext();
}

/** @param {vscode.ExtensionContext} context @param {object} deps */
function registerAiEdit(context, deps) {
	registerProvider(context);
	context.subscriptions.push(
		vscode.commands.registerCommand('levelcode.ai.editSelection', () => editSelection(deps)),
		vscode.commands.registerCommand('levelcode.ai.applyEdit', applyEdit),
		vscode.commands.registerCommand('levelcode.ai.discardEdit', discardEdit),
		vscode.window.tabGroups.onDidChangeTabGroups(updateDiffContext),
		vscode.window.tabGroups.onDidChangeTabs((e) => {
			for (const tab of e.closed) {
				const input = /** @type {any} */ (tab.input);
				if (input && input.modified && input.modified.scheme === SCHEME) { cleanup(input.modified); }
			}
			updateDiffContext();
		})
	);
}

module.exports = { registerAiEdit };
