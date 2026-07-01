/*---------------------------------------------------------------------------------------------
 *  Atom++ — Customize
 *
 *  One product surface for everything: AI key/model, appearance + keymap, sync, updates, and
 *  power-editing/hackability. A self-contained webview whose buttons run the same commands the
 *  Command Palette exposes — just gathered in one place with live status.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

const vscode = require('vscode');
const { getProvider, secretStorageKey, normId } = require('./providers/index');
const { describeModel, supportsToolsForModel } = require('./providers/catalog');

/** @type {vscode.WebviewPanel | undefined} */
let panel;

function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

/** Active model id for a provider — per-provider settings for the two legacy ones, generic `model` otherwise. */
function activeModelId(ai, providerId) {
	const id = normId(providerId);
	if (id === 'claude') { return ai.get('claude.model', 'claude-sonnet-4-6'); }
	if (id === 'ollama') { return ai.get('ollama.model', 'llama3.1'); }
	const m = ai.get('model', '');
	if (m) { return m; }
	const p = getProvider(id);
	return (p && p.models && p.models[0]) ? p.models[0].id : '';
}

async function gatherStatus(context) {
	const ai = vscode.workspace.getConfiguration('atompp.ai');
	const providerId = normId(ai.get('provider', 'claude'));
	const p = getProvider(providerId) || getProvider('claude');
	const skey = secretStorageKey(providerId);
	let keySet = false;
	if (skey) { try { keySet = !!(await context.secrets.get(skey)); } catch { /* */ } }
	const model = activeModelId(ai, providerId);
	return {
		providerLabel: p.label,
		noKey: !!p.noKey,
		keySet,
		provider: providerId,
		model,
		modelCaps: describeModel(model),
		agentReady: supportsToolsForModel(providerId, model),
		completions: ai.get('completions.enabled', true),
		theme: vscode.workspace.getConfiguration('workbench').get('colorTheme', ''),
		syncEnabled: !!vscode.workspace.getConfiguration().get('configurationSync.keybindingsPerPlatform') || undefined,
		updates: vscode.workspace.getConfiguration('atompp.update').get('enabled', true)
	};
}

function row(label, value, ok) {
	const dot = ok == null ? '' : '<span class="dot ' + (ok ? 'on' : 'off') + '"></span>';
	return '<div class="kv">' + dot + '<span class="k">' + esc(label) + '</span><span class="v">' + esc(value) + '</span></div>';
}

function btn(label, command, primary) {
	return '<button class="b' + (primary ? ' primary' : '') + '" data-cmd="' + esc(command) + '">' + esc(label) + '</button>';
}

function section(icon, title, body) {
	return '<section><h2>' + icon + ' ' + esc(title) + '</h2>' + body + '</section>';
}

function htmlFor(nonce, s) {
	const keyValue = s.noKey ? 'not required' : (s.keySet ? 'connected' : 'not set');
	const keyOk = s.noKey ? null : s.keySet;
	const keyBtn = s.noKey ? 'API key not needed' : (s.keySet ? 'Update key' : 'Set ' + s.providerLabel + ' key');
	const ai = section('🤖', 'AI',
		row('Provider', s.providerLabel) +
		row(s.providerLabel + ' API key', keyValue, keyOk) +
		row('Model', (s.model || '(default)') + (s.modelCaps ? '  ·  ' + s.modelCaps : '')) +
		row('Agent (tool use)', s.agentReady ? 'available' : 'chat only for this model', s.agentReady) +
		row('Inline completions', s.completions ? 'on' : 'off', s.completions) +
		'<div class="btns">' + btn('Change model / provider', 'atompp.ai.pickModel', true) +
			btn(keyBtn, 'atompp.ai.setApiKey', !s.keySet && !s.noKey) +
			btn('Sign in to Atom++', 'atompp.ai.account') +
			btn('Open chat', 'atompp.ai.focus') + '</div>');

	const look = section('🎨', 'Appearance & keys',
		row('Theme', s.theme || '') +
		'<div class="btns">' + btn('Choose theme', 'workbench.action.selectTheme') +
			btn('Apply keymap preset', 'atompp.keymap.apply') +
			btn('Import from VS Code', 'atompp.import.vscode') + '</div>');

	const sync = section('🔄', 'Sync',
		'<p class="muted">Carry your settings, keybindings, theme, MCP & skills across machines.</p>' +
		'<div class="btns">' + btn('Set up Sync', 'atompp.sync.setUp') + btn('Sync status', 'atompp.sync.status') + '</div>');

	const upd = section('⬆️', 'Updates',
		row('Auto-check', s.updates ? 'on' : 'off', s.updates) +
		'<div class="btns">' + btn('Check for updates', 'atompp.update.check') + '</div>');

	const hack = section('🛠️', 'Hackability',
		'<p class="muted">Make it yours — a user init script and your own packages, hot-reloaded.</p>' +
		'<div class="btns">' + btn('Open init script', 'atompp.init.edit') + btn('Generate a package', 'atompp.package.generate') + '</div>');

	return '<!doctype html><html><head><meta charset="utf-8">' +
		'<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; script-src \'nonce-' + nonce + '\';">' +
		'<style>' +
		'body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);padding:18px 22px;max-width:760px;margin:0 auto;}' +
		'h1{font-size:20px;margin:0 0 2px;}' +
		'.sub{color:var(--vscode-descriptionForeground);font-size:12.5px;margin:0 0 18px;}' +
		'section{border:1px solid var(--vscode-widget-border,rgba(127,127,127,.3));border-radius:10px;padding:13px 15px;margin:0 0 13px;background:var(--vscode-editorWidget-background,rgba(127,127,127,.05));}' +
		'h2{font-size:13.5px;margin:0 0 9px;}' +
		'.kv{display:flex;align-items:center;gap:8px;font-size:12.5px;padding:2px 0;}' +
		'.kv .k{color:var(--vscode-descriptionForeground);min-width:150px;}' +
		'.kv .v{font-variant-numeric:tabular-nums;}' +
		'.dot{width:8px;height:8px;border-radius:50%;display:inline-block;}' +
		'.dot.on{background:var(--vscode-charts-green,#3fb950);}.dot.off{background:var(--vscode-charts-red,#f14c4c);}' +
		'.muted{color:var(--vscode-descriptionForeground);font-size:12.5px;margin:0 0 9px;}' +
		'.btns{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px;}' +
		'.b{cursor:pointer;border:none;border-radius:6px;padding:5px 13px;font-size:12px;background:var(--vscode-button-secondaryBackground,rgba(127,127,127,.22));color:var(--vscode-button-secondaryForeground,var(--vscode-foreground));}' +
		'.b:hover{background:var(--vscode-button-secondaryHoverBackground,rgba(127,127,127,.32));}' +
		'.b.primary{background:var(--vscode-button-background);color:var(--vscode-button-foreground);}' +
		'.b.primary:hover{background:var(--vscode-button-hoverBackground);}' +
		'</style></head><body>' +
		'<h1>Customize Atom++</h1><p class="sub">Everything in one place. Buttons run the matching command.</p>' +
		ai + look + sync + upd + hack +
		'<script nonce="' + nonce + '">const v=acquireVsCodeApi();' +
		'document.querySelectorAll(".b").forEach(b=>b.onclick=()=>v.postMessage({type:"run",command:b.dataset.cmd}));' +
		'</script></body></html>';
}

async function openCustomize(context) {
	if (panel) { panel.reveal(); return; }
	panel = vscode.window.createWebviewPanel('atompp.customize', 'Customize Atom++', vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true });
	panel.onDidDispose(() => { panel = undefined; });
	const nonce = String(Date.now()) + Math.random().toString(36).slice(2);
	const render = async () => { if (panel) { panel.webview.html = htmlFor(nonce, await gatherStatus(context)); } };
	panel.webview.onDidReceiveMessage(async (m) => {
		if (m && m.type === 'run' && m.command) {
			try { await vscode.commands.executeCommand(m.command); } catch (e) { vscode.window.showErrorMessage('Atom++: ' + ((e && e.message) || e)); }
			setTimeout(render, 500); // refresh status after the action
		}
	});
	// refresh status when the panel regains focus / settings change
	context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(() => { if (panel && panel.visible) { render(); } }));
	await render();
}

module.exports = { openCustomize };
