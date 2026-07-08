/*---------------------------------------------------------------------------------------------
 *  LevelCode — Notepad++ Pack
 *  Feature: Duplicate file/folder from the Explorer context menu (and Cmd+D in the tree).
 *
 *  Mirrors Finder/Notepad++ "Duplicate": creates "name copy.ext" next to the original,
 *  with collision-safe numbering ("name copy 2.ext"). Works on files and folders
 *  (folders copy recursively) and on multi-selection.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

const vscode = require('vscode');
const path = require('path');

/** @param {string} fsPath */
async function pathExists(fsPath) {
	try {
		await vscode.workspace.fs.stat(vscode.Uri.file(fsPath));
		return true;
	} catch {
		return false;
	}
}

/**
 * Build a non-colliding duplicate path: "base copy.ext", then "base copy 2.ext", …
 * @param {string} srcFsPath
 */
async function nextCopyPath(srcFsPath) {
	const dir = path.dirname(srcFsPath);
	const ext = path.extname(srcFsPath);          // '' for dotfiles like .env
	const base = path.basename(srcFsPath, ext);
	let candidate = path.join(dir, `${base} copy${ext}`);
	let n = 2;
	while (await pathExists(candidate)) {
		candidate = path.join(dir, `${base} copy ${n}${ext}`);
		n++;
	}
	return candidate;
}

/**
 * @param {vscode.Uri|undefined} clickedUri
 * @param {vscode.Uri[]|undefined} selectedUris
 */
async function duplicate(clickedUri, selectedUris) {
	// Explorer passes (clickedResource, [allSelectedResources]). Fall back to the
	// active editor's file when invoked without an explorer target.
	let targets = (selectedUris && selectedUris.length) ? selectedUris
		: (clickedUri ? [clickedUri] : []);
	if (targets.length === 0 && vscode.window.activeTextEditor) {
		targets = [vscode.window.activeTextEditor.document.uri];
	}
	targets = targets.filter(u => u && u.scheme === 'file');
	if (targets.length === 0) {
		vscode.window.showInformationMessage('LevelCode: nothing to duplicate (select a file or folder in the Explorer).');
		return;
	}

	/** @type {vscode.Uri|undefined} */
	let lastNew;
	for (const src of targets) {
		try {
			const target = vscode.Uri.file(await nextCopyPath(src.fsPath));
			await vscode.workspace.fs.copy(src, target, { overwrite: false });
			lastNew = target;
		} catch (e) {
			vscode.window.showErrorMessage(
				`LevelCode: could not duplicate ${path.basename(src.fsPath)}: ${e && e.message ? e.message : String(e)}`
			);
		}
	}

	if (lastNew) {
		// Select the new item in the Explorer so it's easy to rename next.
		try { await vscode.commands.executeCommand('revealInExplorer', lastNew); } catch { /* noop */ }
		const label = path.basename(lastNew.fsPath);
		vscode.window.setStatusBarMessage(
			`$(files) LevelCode: duplicated → ${label}${targets.length > 1 ? ` (+${targets.length - 1} more)` : ''}`,
			2500
		);
	}
}

/** @param {vscode.ExtensionContext} context */
function registerFileOps(context) {
	context.subscriptions.push(
		vscode.commands.registerCommand('levelcode.file.duplicate', duplicate)
	);
}

module.exports = { registerFileOps };
