/*---------------------------------------------------------------------------------------------
 *  Atom++ — Notepad++ Pack
 *  Feature: Big-file mode (M1, feature 2 — headline).
 *
 *  The editor engine already handles large files well: it streams them into a piece-tree
 *  buffer (no giant single string), auto-disables tokenization / heavy features past 20 MB,
 *  and on desktop opens local files up to ~1 GB without prompting. This module:
 *    - makes the state visible (a "Big-file mode" status badge + a one-time notice),
 *    - raises the open-confirmation threshold (see package.json configurationDefaults) so
 *      large files open without friction.
 *
 *  Detection is by file size via stat() — we never read the content here.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

const vscode = require('vscode');
const path = require('path');

/** @type {vscode.StatusBarItem} */
let statusItem;
const notified = new Set();

function cfg() {
	return vscode.workspace.getConfiguration('atompp.bigFile');
}

async function fileSizeBytes(uri) {
	try {
		const stat = await vscode.workspace.fs.stat(uri);
		return stat.size;
	} catch {
		return -1;
	}
}

async function refresh() {
	const ed = vscode.window.activeTextEditor;
	if (!ed || ed.document.uri.scheme !== 'file') { statusItem.hide(); return; }

	const thresholdMB = Math.max(1, cfg().get('thresholdMB', 256));
	const size = await fileSizeBytes(ed.document.uri);
	if (size < 0) { statusItem.hide(); return; }

	const mb = size / (1024 * 1024);
	if (mb < thresholdMB) { statusItem.hide(); return; }

	const mbLabel = mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${mb.toFixed(0)} MB`;
	statusItem.text = '$(zap) Big-file mode';
	statusItem.tooltip = `Atom++: large file (${mbLabel}). Syntax highlighting and other heavy features are reduced for speed — editing, scrolling and find still work.`;
	statusItem.show();

	const key = ed.document.uri.toString();
	if (cfg().get('notify', true) && !notified.has(key)) {
		notified.add(key);
		vscode.window.showInformationMessage(
			`Atom++: opened ${path.basename(ed.document.uri.fsPath)} (${mbLabel}) in Big-file mode — some features reduced for performance.`
		);
	}
}

/** @param {vscode.ExtensionContext} context */
function registerBigFile(context) {
	// Far-right, high priority so it's prominent and not crowded by git/problems items.
	statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 1000);
	context.subscriptions.push(statusItem);
	context.subscriptions.push(
		vscode.window.onDidChangeActiveTextEditor(() => { refresh(); }),
		vscode.window.onDidChangeVisibleTextEditors(() => { refresh(); }),
		vscode.workspace.onDidOpenTextDocument(() => { refresh(); }),
		vscode.workspace.onDidChangeConfiguration((e) => {
			if (e.affectsConfiguration('atompp.bigFile')) { refresh(); }
		})
	);
	refresh();
	// Re-check shortly after startup to catch editors restored by hot exit.
	setTimeout(() => { refresh(); }, 1500);
}

module.exports = { registerBigFile };
