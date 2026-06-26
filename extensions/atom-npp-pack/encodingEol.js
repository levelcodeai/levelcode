/*---------------------------------------------------------------------------------------------
 *  Atom++ — Notepad++ Pack
 *  Feature: Encoding & line-ending controls (M1, feature 3).
 *
 *  VS Code already shows encoding/EOL in the status bar, but converting line endings there
 *  is a multi-step picker. We add:
 *    - a one-click EOL toggle in the status bar (LF ⇄ CRLF),
 *    - direct one-step commands (Convert to LF / CRLF / Toggle),
 *    - a shortcut to the built-in encoding picker (reopen / save with encoding).
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

const vscode = require('vscode');

/** @type {vscode.StatusBarItem} */
let eolStatus;

function isCRLF(doc) {
	return doc.eol === vscode.EndOfLine.CRLF;
}

function refreshEol() {
	const ed = vscode.window.activeTextEditor;
	if (!ed) { eolStatus.hide(); return; }
	eolStatus.text = isCRLF(ed.document) ? '$(arrow-swap) CRLF · Windows' : '$(arrow-swap) LF · macOS/Unix';
	eolStatus.tooltip = isCRLF(ed.document)
		? 'Atom++: Windows line endings (CRLF). Click to switch to macOS/Unix (LF).'
		: 'Atom++: macOS/Unix line endings (LF). Click to switch to Windows (CRLF).';
	eolStatus.command = 'atompp.eol.toggle';
	eolStatus.show();
}

/** @param {vscode.EndOfLine} target */
async function setEol(target) {
	const ed = vscode.window.activeTextEditor;
	if (!ed) { vscode.window.showWarningMessage('Atom++: open a text editor first.'); return; }
	if (ed.document.eol === target) {
		vscode.window.setStatusBarMessage('Atom++: line endings already set', 1500);
		return;
	}
	await ed.edit((eb) => eb.setEndOfLine(target));
	refreshEol();
	vscode.window.setStatusBarMessage(
		`$(check) Atom++: converted line endings to ${target === vscode.EndOfLine.CRLF ? 'CRLF' : 'LF'}`, 2000);
}

function toggleEol() {
	const ed = vscode.window.activeTextEditor;
	if (!ed) { vscode.window.showWarningMessage('Atom++: open a text editor first.'); return; }
	return setEol(isCRLF(ed.document) ? vscode.EndOfLine.LF : vscode.EndOfLine.CRLF);
}

/** @param {vscode.ExtensionContext} context */
function registerEncodingEol(context) {
	eolStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
	context.subscriptions.push(eolStatus);

	context.subscriptions.push(
		vscode.commands.registerCommand('atompp.eol.toLF', () => setEol(vscode.EndOfLine.LF)),
		vscode.commands.registerCommand('atompp.eol.toCRLF', () => setEol(vscode.EndOfLine.CRLF)),
		vscode.commands.registerCommand('atompp.eol.toggle', toggleEol),
		// Built-in encoding picker (Reopen with Encoding / Save with Encoding).
		vscode.commands.registerCommand('atompp.encoding.change',
			() => vscode.commands.executeCommand('workbench.action.editor.changeEncoding'))
	);

	// Keep the status item in sync.
	context.subscriptions.push(
		vscode.window.onDidChangeActiveTextEditor(refreshEol),
		vscode.workspace.onDidChangeTextDocument((e) => {
			if (vscode.window.activeTextEditor && e.document === vscode.window.activeTextEditor.document) {
				refreshEol();
			}
		})
	);

	refreshEol();
}

module.exports = { registerEncodingEol };
