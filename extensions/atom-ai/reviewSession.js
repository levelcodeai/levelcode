/*---------------------------------------------------------------------------------------------
 *  Atom++ — AI (M4: agent edit-review, apply-then-review with Keep/Undo)
 *
 *  Cursor-style review of edits the agent has ALREADY applied. The agent never blocks: each
 *  file edit lands immediately on the real file (and is saved, so run_command sees fresh
 *  content), then the user reviews it after — in the editor (green decoration + a Keep/Undo
 *  CodeLens) and/or in the chat panel (a per-file card + a sticky Keep all / Undo all bar).
 *  Undo restores a one-time pre-run snapshot. Per-FILE granularity (drift-free). No temp files.
 *
 *  Honest limits (verified against vscode/src): removed lines can't be shown as inline phantom
 *  rows and the actions render as a CodeLens row (not a floating widget) — both are core-only.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

const vscode = require('vscode');
const path = require('path');
const { makeDiff } = require('./agent');

const SNAPSHOT_SCHEME = 'atompp-snapshot';

function workspaceRoot() {
	const f = vscode.workspace.workspaceFolders;
	return f && f.length ? f[0].uri.fsPath : null;
}

/** First/last changed line indices in newStr (common prefix/suffix trimmed). Whole file if all changed. */
function changedSpan(oldStr, newStr) {
	const a = oldStr.length ? oldStr.split('\n') : [];
	const b = newStr.split('\n');
	let p = 0;
	while (p < a.length && p < b.length && a[p] === b[p]) { p++; }
	let s = 0;
	while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) { s++; }
	const start = Math.min(p, Math.max(0, b.length - 1));
	const end = Math.max(start, b.length - 1 - s);
	return { start, end };
}

function countDiff(diff) {
	let add = 0, del = 0;
	for (const d of diff) { if (d.type === 'add') { add++; } else if (d.type === 'del') { del++; } }
	return { add, del };
}

/**
 * @param {vscode.ExtensionContext} context
 * @param {(m:any)=>void} post  Send a message to the chat webview.
 */
function registerReview(context, post) {
	/** @type {Map<string,{uri:vscode.Uri, rel:string, exists:boolean, snapshot:string, range:vscode.Range, add:number, del:number}>} */
	const pending = new Map();
	/** Last text WE wrote per uri — onDidChangeTextDocument ignores any event whose text matches. */
	const expected = new Map();

	const greenType = vscode.window.createTextEditorDecorationType({
		isWholeLine: true,
		backgroundColor: new vscode.ThemeColor('diffEditor.insertedLineBackground'),
		overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.addedForeground'),
		overviewRulerLane: vscode.OverviewRulerLane.Full
	});

	const lensChanged = new vscode.EventEmitter();
	function refreshLenses() { lensChanged.fire(); }

	function visibleEditors(uri) {
		return vscode.window.visibleTextEditors.filter((e) => e.document.uri.toString() === uri.toString());
	}
	function decorate(fr) {
		for (const ed of visibleEditors(fr.uri)) { ed.setDecorations(greenType, [fr.range]); }
	}
	function undecorate(uri) {
		for (const ed of visibleEditors(uri)) { ed.setDecorations(greenType, []); }
	}
	function postState() { post({ type: 'reviewState', count: pending.size }); }

	// Prominent in-editor controls (CodeLens is small; these are the noticeable surfaces).
	const keepStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
	keepStatus.text = '$(check) Keep edit';
	keepStatus.tooltip = 'Keep the agent edit in this file';
	keepStatus.command = 'atompp.ai.review.keepActive';
	keepStatus.color = new vscode.ThemeColor('gitDecoration.addedResourceForeground');
	const undoStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
	undoStatus.text = '$(discard) Undo edit';
	undoStatus.tooltip = 'Undo the agent edit in this file';
	undoStatus.command = 'atompp.ai.review.undoActive';

	function activePendingKey() {
		const ed = vscode.window.activeTextEditor;
		return ed && pending.has(ed.document.uri.toString()) ? ed.document.uri.toString() : null;
	}
	function updateActiveUi() {
		const key = activePendingKey();
		vscode.commands.executeCommand('setContext', 'atompp.ai.reviewActive', !!key); // editor title-bar buttons
		if (key) { keepStatus.show(); undoStatus.show(); } else { keepStatus.hide(); undoStatus.hide(); }
	}

	/** Apply an edit to the real file (and save), then register it for review. Returns true on success. */
	async function applyEdit(req) {
		const root = workspaceRoot();
		if (!root) { return false; }
		const abs = path.resolve(root, req.path || '');
		if (abs !== root && !abs.startsWith(root + path.sep)) { return false; }
		const uri = vscode.Uri.file(abs);
		const key = uri.toString();
		const proposed = String(req.proposed != null ? req.proposed : '');

		// Snapshot the pre-run content ONCE (so a single Undo reverts the whole run's changes to this file).
		let snapshot = pending.has(key) ? pending.get(key).snapshot : '';
		if (!pending.has(key) && req.exists) {
			try { snapshot = (await vscode.workspace.openTextDocument(uri)).getText(); } catch { snapshot = ''; }
		}

		const edit = new vscode.WorkspaceEdit();
		if (req.exists) {
			const doc = await vscode.workspace.openTextDocument(uri);
			edit.replace(uri, doc.validateRange(new vscode.Range(0, 0, doc.lineCount + 1, 0)), proposed);
		} else {
			edit.createFile(uri, { ignoreIfExists: true });
			edit.insert(uri, new vscode.Position(0, 0), proposed);
		}
		expected.set(key, proposed); // guard the change listener against our own edit (robust across the async boundary)
		const ok = await vscode.workspace.applyEdit(edit);
		if (!ok) { if (!pending.has(key)) { expected.delete(key); } return false; }

		// Save so run_command / disk reads see the new content (not a stale unsaved doc).
		try { const doc = await vscode.workspace.openTextDocument(uri); if (doc.isDirty) { await doc.save(); } } catch { /* */ }

		const diff = makeDiff(snapshot, proposed);
		const { add, del } = countDiff(diff);
		const span = changedSpan(snapshot, proposed);
		const range = new vscode.Range(span.start, 0, span.end, 0);
		const existed = pending.has(key) ? pending.get(key).exists : req.exists;
		const fr = { uri, rel: vscode.workspace.asRelativePath(uri), exists: existed, snapshot, range, add, del };
		pending.set(key, fr);

		decorate(fr);
		for (const ed of visibleEditors(uri)) { ed.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport); }
		refreshLenses();
		post({ type: 'editApplied', id: key, path: fr.rel, exists: existed, add, del, diff });
		postState();
		updateActiveUi();
		return true;
	}

	function clearReview(key) {
		const fr = pending.get(key);
		if (fr) { undecorate(fr.uri); }
		pending.delete(key);
		expected.delete(key);
		refreshLenses();
		updateActiveUi();
	}

	function keepFile(key, verdict) {
		if (!pending.has(key)) { return; }
		clearReview(key);
		post({ type: 'editResolved', id: key, verdict: verdict || 'kept' });
		postState();
	}

	async function undoFile(key) {
		const fr = pending.get(key);
		if (!fr) { return; }
		const edit = new vscode.WorkspaceEdit();
		if (fr.exists) {
			const doc = await vscode.workspace.openTextDocument(fr.uri);
			edit.replace(fr.uri, doc.validateRange(new vscode.Range(0, 0, doc.lineCount + 1, 0)), fr.snapshot);
			expected.set(key, fr.snapshot);
		} else {
			edit.deleteFile(fr.uri, { ignoreIfNotExists: true });
		}
		const ok = await vscode.workspace.applyEdit(edit);
		if (ok && fr.exists) { try { const doc = await vscode.workspace.openTextDocument(fr.uri); if (doc.isDirty) { await doc.save(); } } catch { /* */ } }
		clearReview(key);
		post({ type: 'editResolved', id: key, verdict: 'undone' });
		postState();
	}

	function keepAll() { for (const key of [...pending.keys()]) { keepFile(key, 'kept'); } }
	async function undoAll() { for (const key of [...pending.keys()].reverse()) { await undoFile(key); } }
	/** New chat: drop all review state WITHOUT reverting the user's files. */
	function finalizeAll() {
		for (const key of [...pending.keys()]) { clearReview(key); }
		postState();
	}

	async function openDiff(key) {
		const fr = pending.get(key);
		if (!fr) { return; }
		try {
			await vscode.commands.executeCommand('vscode.diff',
				vscode.Uri.parse(SNAPSHOT_SCHEME + ':' + encodeURIComponent(key)), fr.uri,
				fr.rel + ' (before ↔ after)', { preview: true });
		} catch { /* */ }
	}
	async function revealEdit(key) {
		const fr = pending.get(key);
		if (!fr) { return; }
		const ed = await vscode.window.showTextDocument(fr.uri, { preview: false });
		ed.revealRange(fr.range, vscode.TextEditorRevealType.InCenter);
		decorate(fr);
	}

	// --- providers / listeners -------------------------------------------------
	const lensProvider = {
		onDidChangeCodeLenses: lensChanged.event,
		provideCodeLenses(doc) {
			const fr = pending.get(doc.uri.toString());
			if (!fr) { return []; }
			const r = new vscode.Range(fr.range.start.line, 0, fr.range.start.line, 0);
			const key = doc.uri.toString();
			return [
				new vscode.CodeLens(r, { title: '$(check) Keep  (Atom++ +' + fr.add + ' -' + fr.del + ')', command: 'atompp.ai.review.keepFile', arguments: [key] }),
				new vscode.CodeLens(r, { title: '$(discard) Undo', command: 'atompp.ai.review.undoFile', arguments: [key] })
			];
		}
	};
	const snapshotProvider = {
		provideTextDocumentContent(uri) {
			const fr = pending.get(decodeURIComponent(uri.path));
			return fr ? fr.snapshot : '';
		}
	};

	context.subscriptions.push(
		greenType, lensChanged, keepStatus, undoStatus,
		vscode.window.onDidChangeActiveTextEditor(() => updateActiveUi()),
		vscode.commands.registerCommand('atompp.ai.review.keepActive', () => { const k = activePendingKey(); if (k) { keepFile(k, 'kept'); } }),
		vscode.commands.registerCommand('atompp.ai.review.undoActive', () => { const k = activePendingKey(); if (k) { undoFile(k); } }),
		vscode.languages.registerCodeLensProvider({ scheme: 'file' }, lensProvider),
		vscode.workspace.registerTextDocumentContentProvider(SNAPSHOT_SCHEME, snapshotProvider),
		vscode.window.onDidChangeVisibleTextEditors(() => { for (const fr of pending.values()) { decorate(fr); } }),
		vscode.workspace.onDidChangeTextDocument((e) => {
			if (e.document.uri.scheme !== 'file') { return; }
			const key = e.document.uri.toString();
			if (!pending.has(key)) { return; }
			if (expected.get(key) === e.document.getText()) { return; } // our own apply — ignore
			if (e.reason === vscode.TextDocumentChangeReason.Undo || e.reason === vscode.TextDocumentChangeReason.Redo) {
				// User pressed Cmd+Z/Cmd+Shift+Z — the doc already reverted; just drop review state.
				clearReview(key);
				post({ type: 'editResolved', id: key, verdict: 'undone' });
				postState();
			} else {
				// User typed in a pending file — they own it now (Cursor behavior): auto-Keep.
				keepFile(key, 'kept-user-edited');
			}
		}),
		vscode.commands.registerCommand('atompp.ai.review.keepFile', (k) => keepFile(k, 'kept')),
		vscode.commands.registerCommand('atompp.ai.review.undoFile', (k) => undoFile(k)),
		vscode.commands.registerCommand('atompp.ai.review.keepAll', keepAll),
		vscode.commands.registerCommand('atompp.ai.review.undoAll', undoAll),
		vscode.commands.registerCommand('atompp.ai.review.openDiff', (k) => openDiff(k)),
		vscode.commands.registerCommand('atompp.ai.review.revealEdit', (k) => revealEdit(k)),
		{ dispose: () => { for (const fr of pending.values()) { undecorate(fr.uri); } pending.clear(); } }
	);

	return { applyEdit, keepFile, undoFile, keepAll, undoAll, finalizeAll, openDiff, pendingCount: () => pending.size };
}

module.exports = { registerReview };
