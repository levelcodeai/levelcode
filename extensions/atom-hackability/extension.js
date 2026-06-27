/*---------------------------------------------------------------------------------------------
 *  Atom++ — Hackability (M3, feature 1: user init script)
 *
 *  Atom's signature "run my own code when the editor starts" hook. On startup we load
 *  ~/.atom-plus-plus/init.js and run it with a small `atompp` convenience API plus the full
 *  `vscode` API in scope. It is live-reloadable ("Atom++: Reload Init Script") — no restart.
 *
 *  This runs the user's OWN file from their home directory (exactly like Atom). It is not
 *  fetched or remote; errors are caught and surfaced so a broken init never breaks startup.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

const vscode = require('vscode');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');
const { registerKeymaps } = require('./keymaps');
const { registerPackages } = require('./packages');

const INIT_DIR = path.join(os.homedir(), '.atom-plus-plus');
const INIT_PATH = path.join(INIT_DIR, 'init.js');

/** @type {vscode.OutputChannel} */
let output;
/** Disposables created by the *current* run of the init script (cleared on reload). */
let userDisposables = [];

const TEMPLATE = `// Atom++ — User Init Script
// This file runs every time Atom++ starts. Edit it, then run
// "Atom++: Reload Init Script" from the Command Palette (no restart needed).
//
// Two things are in scope:
//   • atompp  — a small convenience API (everything you register is auto-cleaned on reload)
//   • vscode  — the full VS Code extension API (the escape hatch for anything else)
//
// Uncomment an example to try it, then reload:

// 1. A custom item in the status bar:
// atompp.addStatusBarItem('🚀 init.js', 'Added from my init script');

// 2. A custom command (run it from the Command Palette):
// atompp.registerCommand('myinit.hello', () => {
//   atompp.showMessage('Hello from your init script!');
// });

// 3. React to saving a file:
// atompp.onDidSave(doc => console.log('Saved:', doc.fileName));

// 4. Anything in the raw VS Code API:
// vscode.window.showInformationMessage('Atom++ init script loaded.');
`;

/** Build the friendly Atom++ API handed to the init script. Returns { api, subs }. */
function makeApi() {
	/** @type {vscode.Disposable[]} */
	const subs = [];
	const track = (d) => { if (d && typeof d.dispose === 'function') { subs.push(d); } return d; };
	const api = {
		version: '0.1.0',
		/** The full VS Code API. */
		vscode,
		/** Disposables registered here are cleaned up automatically on the next reload. */
		subscriptions: subs,
		registerCommand: (id, fn) => track(vscode.commands.registerCommand(id, fn)),
		onDidSave: (fn) => track(vscode.workspace.onDidSaveTextDocument(fn)),
		onDidOpen: (fn) => track(vscode.workspace.onDidOpenTextDocument(fn)),
		onDidChangeEditor: (fn) => track(vscode.window.onDidChangeActiveTextEditor(fn)),
		addStatusBarItem: (text, tooltip, command) => {
			const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
			item.text = String(text);
			if (tooltip) { item.tooltip = String(tooltip); }
			if (command) { item.command = command; }
			item.show();
			subs.push(item);
			return item;
		},
		showMessage: (m) => vscode.window.showInformationMessage(String(m)),
		showError: (m) => vscode.window.showErrorMessage(String(m)),
		getConfig: (section) => vscode.workspace.getConfiguration(section),
		log: (...args) => { output.appendLine(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')); }
	};
	return { api, subs };
}

/** Dispose everything the previous run created. */
function disposeUser() {
	for (const d of userDisposables) { try { d.dispose(); } catch { /* ignore */ } }
	userDisposables = [];
}

/**
 * Load and execute the init script. Returns true if it ran, false if skipped/missing.
 * @param {boolean} interactive  Whether to surface success/errors to the user (vs silent on startup).
 */
function runInit(interactive) {
	if (!vscode.workspace.getConfiguration('atompp').get('init.enabled', true)) { return false; }
	if (!fs.existsSync(INIT_PATH)) {
		if (interactive) { vscode.window.showInformationMessage('Atom++: no init script yet. Use “Atom++: Open Init Script” to create one.'); }
		return false;
	}

	disposeUser();
	let code;
	try { code = fs.readFileSync(INIT_PATH, 'utf8'); }
	catch (e) { output.appendLine('[init] could not read ' + INIT_PATH + ': ' + e); return false; }

	const { api, subs } = makeApi();
	const initRequire = createRequire(INIT_PATH); // so the script can require() its own local/global modules
	try {
		// Run the user's code with atompp/vscode/require/console in scope.
		const fn = new Function('atompp', 'vscode', 'require', 'console', '__dirname', '__filename', code);
		fn(api, vscode, initRequire, console, INIT_DIR, INIT_PATH);
		userDisposables = subs;
		output.appendLine('[init] ran ' + INIT_PATH + ' (' + subs.length + ' disposable(s) registered)');
		if (interactive) { vscode.window.setStatusBarMessage('Atom++ init script reloaded', 2000); }
		return true;
	} catch (e) {
		const msg = (e && e.stack) ? e.stack : String(e);
		output.appendLine('[init] ERROR running init.js:\n' + msg);
		const pick = 'Show Log';
		vscode.window.showErrorMessage('Atom++ init script failed: ' + ((e && e.message) || e), pick)
			.then((c) => { if (c === pick) { output.show(true); } });
		return false;
	}
}

async function openInit() {
	try {
		if (!fs.existsSync(INIT_DIR)) { fs.mkdirSync(INIT_DIR, { recursive: true }); }
		if (!fs.existsSync(INIT_PATH)) { fs.writeFileSync(INIT_PATH, TEMPLATE, 'utf8'); }
	} catch (e) {
		vscode.window.showErrorMessage('Atom++: could not create init script: ' + ((e && e.message) || e));
		return;
	}
	const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(INIT_PATH));
	await vscode.window.showTextDocument(doc);
}

function activate(context) {
	output = vscode.window.createOutputChannel('Atom++ Init');
	context.subscriptions.push(
		output,
		vscode.commands.registerCommand('atompp.init.edit', openInit),
		vscode.commands.registerCommand('atompp.init.reload', () => runInit(true)),
		{ dispose: disposeUser }
	);
	registerKeymaps(context);
	registerPackages(context);
	runInit(false);
}

function deactivate() { disposeUser(); }

module.exports = { activate, deactivate };
