/*---------------------------------------------------------------------------------------------
 *  Atom++ — Notepad++ Pack
 *  Feature: Macro record & replay (M1, feature 1).
 *
 *  Recording model (reliable within the extension API):
 *   - Typed text is captured by temporarily overriding the `type` command while
 *     recording, and forwarding to `default:type` so insertion still happens.
 *   - Cursor moves / deletions / newline / tab are captured via thin "recordable"
 *     commands that are bound to the normal keys ONLY while the
 *     `atompp.macroRecording` context is true (see keybindings in package.json),
 *     so normal editing is never disturbed when not recording.
 *
 *  Replay re-dispatches the recorded steps at the current cursor. Inserts use
 *  edits with undo stops disabled, so a macro made of motions + inserts replays
 *  as a single undo unit.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

const vscode = require('vscode');
const { registerFileOps } = require('./fileOps');
const { registerLineOps } = require('./lineOps');
const { registerColumnOps } = require('./columnOps');
const { registerEncodingEol } = require('./encodingEol');
const { registerBigFile } = require('./bigFile');

const CTX_RECORDING = 'atompp.macroRecording';
const KEY_LAST = 'atompp.macros.last';
const KEY_SAVED = 'atompp.macros.saved';

/** Recordable cursor/delete commands: our command id suffix -> built-in command. */
const RECORDABLE_COMMANDS = {
	cursorDown: 'cursorDown',
	cursorUp: 'cursorUp',
	cursorLeft: 'cursorLeft',
	cursorRight: 'cursorRight',
	cursorHome: 'cursorHome',
	cursorEnd: 'cursorEnd',
	cursorWordLeft: 'cursorWordLeft',
	cursorWordRight: 'cursorWordRight',
	deleteLeft: 'deleteLeft',
	deleteRight: 'deleteRight',
	deleteWordLeft: 'deleteWordLeft'
};

/** @typedef {{k:'insert',text:string}|{k:'cmd',id:string}} Step */

let recording = false;
let replaying = false;
/** @type {Step[]} */
let currentSteps = [];
/** @type {vscode.Disposable|undefined} */
let typeOverride;
/** @type {vscode.StatusBarItem} */
let statusItem;
/** @type {vscode.ExtensionContext} */
let ctx;

function cfg() {
	return vscode.workspace.getConfiguration('atompp.macros');
}

function setRecordingContext(on) {
	return vscode.commands.executeCommand('setContext', CTX_RECORDING, on);
}

function updateStatus() {
	if (recording) {
		statusItem.text = `$(record) Recording macro (${currentSteps.length})`;
		statusItem.tooltip = 'Atom++: recording a macro — press Cmd+Shift+R to stop';
		statusItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
		statusItem.show();
	} else {
		statusItem.hide();
	}
}

/** Record a step, enforcing the safety cap. */
function pushStep(step) {
	const max = cfg().get('maxSteps', 5000);
	if (currentSteps.length >= max) {
		vscode.window.showWarningMessage(`Atom++: macro hit the ${max}-step cap; recording stopped.`);
		stopRecording();
		return;
	}
	currentSteps.push(step);
	updateStatus();
}

function startRecording() {
	if (replaying) { return; }
	recording = true;
	currentSteps = [];

	// Override `type` only while recording, so a bug here can never affect
	// normal typing outside a recording session.
	try {
		typeOverride = vscode.commands.registerCommand('type', (args) => {
			if (recording && args && typeof args.text === 'string') {
				pushStep({ k: 'insert', text: args.text });
			}
			return vscode.commands.executeCommand('default:type', args);
		});
	} catch (e) {
		typeOverride = undefined;
		vscode.window.showWarningMessage(
			'Atom++: could not capture typed text (another extension owns `type`). Cursor moves and deletes will still record.'
		);
	}

	setRecordingContext(true);
	updateStatus();
}

function stopRecording() {
	if (!recording) { return; }
	recording = false;
	if (typeOverride) { typeOverride.dispose(); typeOverride = undefined; }
	setRecordingContext(false);
	updateStatus();

	if (currentSteps.length > 0) {
		ctx.globalState.update(KEY_LAST, currentSteps);
		vscode.window.setStatusBarMessage(`$(check) Atom++: macro recorded (${currentSteps.length} steps)`, 2500);
	} else {
		vscode.window.setStatusBarMessage('Atom++: empty macro (nothing recorded)', 2000);
	}
}

function toggleRecording() {
	recording ? stopRecording() : startRecording();
}

/** Apply one insert at every cursor, as a single (stop-free) edit. */
async function applyInsert(editor, text) {
	await editor.edit(
		(eb) => { for (const sel of editor.selections) { eb.insert(sel.active, text); } },
		{ undoStopBefore: false, undoStopAfter: false }
	);
}

/** @param {Step[]} steps @param {number} times */
async function replay(steps, times) {
	if (!steps || steps.length === 0) {
		vscode.window.showInformationMessage('Atom++: no macro to play. Record one with Cmd+Shift+R.');
		return;
	}
	const editor = vscode.window.activeTextEditor;
	if (!editor) {
		vscode.window.showWarningMessage('Atom++: open a text editor to play a macro.');
		return;
	}
	if (recording) { stopRecording(); }
	replaying = true;
	try {
		// One leading undo stop so the whole replay collapses into a single undo.
		await editor.edit(() => { }, { undoStopBefore: true, undoStopAfter: false });
		for (let i = 0; i < times; i++) {
			for (const step of steps) {
				if (step.k === 'insert') {
					await applyInsert(editor, step.text);
				} else if (step.k === 'cmd') {
					await vscode.commands.executeCommand(step.id);
				}
			}
		}
	} catch (e) {
		vscode.window.showErrorMessage('Atom++: macro playback failed: ' + (e && e.message ? e.message : String(e)));
	} finally {
		replaying = false;
	}
}

function getLast() {
	return /** @type {Step[]|undefined} */ (ctx.globalState.get(KEY_LAST));
}

function getSaved() {
	return /** @type {Record<string, Step[]>} */ (ctx.globalState.get(KEY_SAVED) || {});
}

async function playLast() {
	await replay(getLast(), 1);
}

async function playNTimes() {
	const last = getLast();
	if (!last) { vscode.window.showInformationMessage('Atom++: no macro recorded yet.'); return; }
	const maxN = cfg().get('maxReplayCount', 100000);
	const input = await vscode.window.showInputBox({
		prompt: 'Play the last macro how many times?',
		value: '10',
		validateInput: (v) => {
			const n = Number(v);
			if (!Number.isInteger(n) || n < 1) { return 'Enter a whole number ≥ 1'; }
			if (n > maxN) { return `Maximum is ${maxN}`; }
			return undefined;
		}
	});
	if (input === undefined) { return; }
	await replay(last, Number(input));
}

async function saveLast() {
	const last = getLast();
	if (!last) { vscode.window.showInformationMessage('Atom++: no macro to save yet.'); return; }
	const name = await vscode.window.showInputBox({ prompt: 'Name this macro', placeHolder: 'e.g. comment-line' });
	if (!name) { return; }
	const saved = getSaved();
	saved[name] = last;
	await ctx.globalState.update(KEY_SAVED, saved);
	vscode.window.setStatusBarMessage(`$(save) Atom++: saved macro “${name}”`, 2500);
}

async function runSaved() {
	const saved = getSaved();
	const names = Object.keys(saved);
	if (names.length === 0) { vscode.window.showInformationMessage('Atom++: no saved macros yet.'); return; }
	const pick = await vscode.window.showQuickPick(names, { placeHolder: 'Run which saved macro?' });
	if (!pick) { return; }
	await ctx.globalState.update(KEY_LAST, saved[pick]); // make it the "last" too
	await replay(saved[pick], 1);
}

async function deleteSaved() {
	const saved = getSaved();
	const names = Object.keys(saved);
	if (names.length === 0) { vscode.window.showInformationMessage('Atom++: no saved macros to delete.'); return; }
	const pick = await vscode.window.showQuickPick(names, { placeHolder: 'Delete which saved macro?' });
	if (!pick) { return; }
	delete saved[pick];
	await ctx.globalState.update(KEY_SAVED, saved);
	vscode.window.setStatusBarMessage(`Atom++: deleted macro “${pick}”`, 2000);
}

function activate(context) {
	ctx = context;
	statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
	context.subscriptions.push(statusItem);

	const reg = (id, fn) => context.subscriptions.push(vscode.commands.registerCommand(id, fn));

	reg('atompp.macro.toggleRecording', toggleRecording);
	reg('atompp.macro.play', playLast);
	reg('atompp.macro.playNTimes', playNTimes);
	reg('atompp.macro.saveLast', saveLast);
	reg('atompp.macro.runSaved', runSaved);
	reg('atompp.macro.deleteSaved', deleteSaved);

	// Recordable cursor/delete wrappers: record (if recording) then run the built-in.
	for (const [suffix, builtin] of Object.entries(RECORDABLE_COMMANDS)) {
		reg('atompp.macro.rec.' + suffix, async () => {
			if (recording) { pushStep({ k: 'cmd', id: builtin }); }
			await vscode.commands.executeCommand(builtin);
		});
	}

	// Newline / tab while recording: record an insert and perform it via default:type
	// (bypasses our `type` override so it isn't double-recorded).
	reg('atompp.macro.rec.insertNewline', async () => {
		if (recording) { pushStep({ k: 'insert', text: '\n' }); }
		await vscode.commands.executeCommand('default:type', { text: '\n' });
	});
	reg('atompp.macro.rec.insertTab', async () => {
		if (recording) { pushStep({ k: 'insert', text: '\t' }); }
		await vscode.commands.executeCommand('default:type', { text: '\t' });
	});

	// File operations (Duplicate, …)
	registerFileOps(context);

	// Line operations (sort, dedup, case, …)
	registerLineOps(context);

	// Column editor (incrementing numbers, fill)
	registerColumnOps(context);

	// Encoding / line-ending controls
	registerEncodingEol(context);

	// Big-file mode (status badge + notice)
	registerBigFile(context);

	// Make sure recording context starts false (also clears a stale state after reload).
	setRecordingContext(false);
}

function deactivate() {
	if (typeOverride) { typeOverride.dispose(); typeOverride = undefined; }
}

module.exports = { activate, deactivate };
