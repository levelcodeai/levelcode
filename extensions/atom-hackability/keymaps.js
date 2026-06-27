/*---------------------------------------------------------------------------------------------
 *  Atom++ — Hackability: keymap presets
 *
 *  Apply an Atom or Notepad++ keybinding preset so muscle memory transfers. A preset is
 *  written into the user's keybindings.json (backed up first); VS Code live-reloads it, so
 *  no restart is needed. We only override the bindings that DIFFER from the defaults — the
 *  many shortcuts Atom/NPP already share with VS Code are left untouched.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');

const EDIT = 'editorTextFocus && !editorReadonly';

// Atom keymap — only the bindings that differ from VS Code's mac defaults.
const ATOM = [
	{ key: 'cmd+t', command: 'workbench.action.quickOpen' },
	{ key: 'cmd+\\', command: 'workbench.action.toggleSidebarVisibility' },
	{ key: 'cmd+k cmd+up', command: 'workbench.action.splitEditorUp' },
	{ key: 'cmd+k cmd+down', command: 'workbench.action.splitEditorDown' },
	{ key: 'cmd+k cmd+left', command: 'workbench.action.splitEditorLeft' },
	{ key: 'cmd+k cmd+right', command: 'workbench.action.splitEditorRight' },
	{ key: 'cmd+r', command: 'workbench.action.gotoSymbol' },
	{ key: 'cmd+shift+r', command: 'workbench.action.showAllSymbols' },
	{ key: 'ctrl+cmd+up', command: 'editor.action.moveLinesUpAction', when: EDIT },
	{ key: 'ctrl+cmd+down', command: 'editor.action.moveLinesDownAction', when: EDIT },
	{ key: 'cmd+shift+d', command: 'editor.action.copyLinesDownAction', when: EDIT }
];

// Notepad++ keymap — Windows-style Ctrl bindings (scoped to the editor so they don't
// fight macOS text navigation outside it).
const NPP = [
	{ key: 'ctrl+d', command: 'editor.action.copyLinesDownAction', when: EDIT },
	{ key: 'ctrl+shift+up', command: 'editor.action.moveLinesUpAction', when: EDIT },
	{ key: 'ctrl+shift+down', command: 'editor.action.moveLinesDownAction', when: EDIT },
	{ key: 'ctrl+g', command: 'workbench.action.gotoLine' },
	{ key: 'ctrl+q', command: 'editor.action.commentLine', when: EDIT },
	{ key: 'ctrl+shift+q', command: 'editor.action.blockComment', when: EDIT },
	{ key: 'ctrl+j', command: 'editor.action.joinLines', when: EDIT },
	{ key: 'ctrl+h', command: 'editor.action.startFindReplaceAction', when: 'editorFocus' },
	{ key: 'ctrl+shift+f', command: 'workbench.action.findInFiles' },
	{ key: 'f3', command: 'editor.action.nextMatchFindAction', when: 'editorFocus' },
	{ key: 'shift+f3', command: 'editor.action.previousMatchFindAction', when: 'editorFocus' },
	{ key: 'ctrl+w', command: 'workbench.action.closeActiveEditor' }
];

const PRESETS = {
	atom: { label: 'Atom', bindings: ATOM, note: '' },
	npp: { label: 'Notepad++', bindings: NPP, note: 'Uses Windows-style Ctrl bindings — they apply inside the editor, so macOS Ctrl text-navigation still works elsewhere.' },
	default: { label: 'VS Code default', bindings: [], note: 'Cleared the preset — your keybindings.json is now empty (defaults apply).' }
};

/** keybindings.json lives next to globalStorage, two levels up: <userData>/User/keybindings.json */
function keybindingsPath(context) {
	const userDir = path.dirname(path.dirname(context.globalStorageUri.fsPath));
	return { userDir, file: path.join(userDir, 'keybindings.json') };
}

/** @param {vscode.ExtensionContext} context */
async function applyKeymap(context) {
	/** @type {any[]} */
	const items = [
		{ label: '$(star) Atom', description: '⌘T finder · ⌘\\ tree · ⌃⌘↑↓ move lines · ⌘R symbols · ⌘⇧D duplicate', _key: 'atom' },
		{ label: '$(keyboard) Notepad++', description: 'Windows-style Ctrl bindings (Ctrl+D, Ctrl+G, Ctrl+Q, F3, …)', _key: 'npp' },
		{ label: '$(discard) VS Code default', description: 'Clear the preset (empty keybindings.json)', _key: 'default' }
	];
	const pick = await vscode.window.showQuickPick(items, {
		placeHolder: 'Apply a keymap preset — overwrites keybindings.json (a backup is saved first)'
	});
	if (!pick) { return; }
	const preset = PRESETS[pick._key];

	const proceed = await vscode.window.showWarningMessage(
		`Apply the ${preset.label} keymap? This replaces your keybindings.json. A timestamped backup is saved first.`,
		{ modal: true }, 'Apply'
	);
	if (proceed !== 'Apply') { return; }

	const { userDir, file } = keybindingsPath(context);
	try {
		fs.mkdirSync(userDir, { recursive: true });
		// Back up any existing non-empty keybindings.
		if (fs.existsSync(file)) {
			const cur = fs.readFileSync(file, 'utf8').trim();
			if (cur && cur !== '[]') {
				fs.copyFileSync(file, path.join(userDir, 'keybindings.backup-' + Date.now() + '.json'));
			}
		}
		const header = '// Atom++ — ' + preset.label + ' keymap preset.\n' +
			'// Applied via "Atom++: Apply Keymap Preset". Edit freely; re-apply any time.\n';
		fs.writeFileSync(file, header + JSON.stringify(preset.bindings, null, 2) + '\n', 'utf8');
	} catch (e) {
		vscode.window.showErrorMessage('Atom++: could not write keybindings.json: ' + ((e && e.message) || e));
		return;
	}

	const open = 'Open Keybindings';
	const msg = `Atom++: applied the ${preset.label} keymap.` + (preset.note ? ' ' + preset.note : '');
	vscode.window.showInformationMessage(msg, open).then((c) => {
		if (c === open) { vscode.commands.executeCommand('workbench.action.openGlobalKeybindingsFile'); }
	});
}

function registerKeymaps(context) {
	context.subscriptions.push(
		vscode.commands.registerCommand('atompp.keymap.apply', () => applyKeymap(context))
	);
}

module.exports = { registerKeymaps };
