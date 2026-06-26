/*---------------------------------------------------------------------------------------------
 *  Atom++ — AI: inline per-hunk edit review (Keep / Undo), built in-extension.
 *
 *  After the model rewrites a selection we diff it line-by-line into hunks and show the
 *  result INLINE: changed lines highlighted green. Controls (within the limits of the public
 *  extension API):
 *    - hover over a changed section → clickable ✓ Keep / ✗ Undo for that hunk,
 *    - an always-on status-bar bar while reviewing: Keep / Undo current, "i/n", ◀ ▶,
 *      and Keep All / Undo All.
 *
 *  (The floating button widget and red "removed line" rows in editors like Copilot are core
 *  chat-editing UI; extensions can't draw overlay widgets or phantom rows.)
 *
 *  State model: the region is rendered from segments (unchanged runs + hunks with a
 *  decision). Every action re-renders the whole region — no incremental range math.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

const vscode = require('vscode');

const CTX_ACTIVE = 'atompp.ai.reviewActive';

/** @type {vscode.TextEditorDecorationType} */
let greenDecoration;
/** @type {vscode.StatusBarItem[]} */
let bar = [];

/** @type {null | { uri: vscode.Uri, startLine: number, lineCount: number, segments: any[], pending: {segIndex:number, absLine:number, lineCount:number}[] }} */
let review = null;

// ---- pure diff/render -----------------------------------------------------
function diffSegments(a, b) {
	const n = a.length, m = b.length;
	const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
	for (let i = n - 1; i >= 0; i--)
		for (let j = m - 1; j >= 0; j--)
			dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
	const segs = [];
	const pushSame = (l) => { const t = segs[segs.length - 1]; if (t && t.type === 'same') t.lines.push(l); else segs.push({ type: 'same', lines: [l] }); };
	const pushHunk = (o, e) => { const t = segs[segs.length - 1]; if (t && t.type === 'hunk') { t.orig.push(...o); t.neu.push(...e); } else segs.push({ type: 'hunk', orig: [...o], neu: [...e], decision: 'pending' }); };
	let i = 0, j = 0;
	while (i < n && j < m) {
		if (a[i] === b[j]) { pushSame(a[i]); i++; j++; }
		else if (dp[i + 1][j] >= dp[i][j + 1]) { pushHunk([a[i]], []); i++; }
		else { pushHunk([], [b[j]]); j++; }
	}
	while (i < n) { pushHunk([a[i]], []); i++; }
	while (j < m) { pushHunk([], [b[j]]); j++; }
	return segs;
}
function renderRegion(segments) {
	const lines = []; const pending = [];
	segments.forEach((seg, idx) => {
		if (seg.type === 'same') { for (const l of seg.lines) lines.push(l); }
		else {
			const segLines = seg.decision === 'undo' ? seg.orig : seg.neu;
			const startLine = lines.length;
			for (const l of segLines) lines.push(l);
			if (seg.decision === 'pending') pending.push({ segIndex: idx, relLine: startLine, lineCount: segLines.length });
		}
	});
	return { lines, pending };
}

// ---- editor integration ---------------------------------------------------
function eol(doc) { return doc.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n'; }
function activeReviewEditor() {
	if (!review) { return undefined; }
	return vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === review.uri.toString());
}

async function rerender(collapseTo) {
	if (!review) { return; }
	const editor = activeReviewEditor();
	if (!editor) { return; }
	const doc = editor.document;
	const { lines, pending } = renderRegion(review.segments);

	const lastLine = review.startLine + review.lineCount - 1;
	const regionRange = new vscode.Range(review.startLine, 0, lastLine, doc.lineAt(lastLine).text.length);
	const we = new vscode.WorkspaceEdit();
	we.replace(doc.uri, regionRange, lines.join(eol(doc)));
	await vscode.workspace.applyEdit(we);

	review.lineCount = lines.length;
	review.pending = pending.map((p) => ({ segIndex: p.segIndex, absLine: review.startLine + p.relLine, lineCount: p.lineCount }));

	// green highlight on pending changed lines
	editor.setDecorations(greenDecoration, review.pending.filter((p) => p.lineCount > 0)
		.map((p) => new vscode.Range(p.absLine, 0, p.absLine + p.lineCount - 1, 0)));

	// collapse selection so the region isn't shown as one big highlighted block
	if (typeof collapseTo === 'number') {
		editor.selection = new vscode.Selection(collapseTo, 0, collapseTo, 0);
	}

	if (review.pending.length === 0) { finalize(editor); return; }
	updateBar();
}

function finalize(editor) {
	if (editor && greenDecoration) { editor.setDecorations(greenDecoration, []); }
	review = null;
	vscode.commands.executeCommand('setContext', CTX_ACTIVE, false);
	hideBar();
	vscode.window.setStatusBarMessage('$(check) Atom++ AI: review complete', 1500);
}

/** Begin an inline review. range must cover whole lines. */
async function start(editor, range, originalText, proposedText) {
	if (review) { vscode.window.showInformationMessage('Atom++ AI: resolve the current review first (Keep/Undo).'); return; }
	const segments = diffSegments(originalText.split(/\r?\n/), proposedText.split(/\r?\n/));
	if (!segments.some((s) => s.type === 'hunk')) {
		vscode.window.showInformationMessage('Atom++ AI: the suggestion is identical — nothing to review.');
		return;
	}
	review = { uri: editor.document.uri, startLine: range.start.line, lineCount: range.end.line - range.start.line + 1, segments, pending: [] };
	vscode.commands.executeCommand('setContext', CTX_ACTIVE, true);
	await rerender(range.start.line);
	if (review && review.pending.length) {
		const first = review.pending[0].absLine;
		editor.selection = new vscode.Selection(first, 0, first, 0);
		editor.revealRange(new vscode.Range(first, 0, first, 0), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
		updateBar();
	}
}

// ---- decisions / navigation ----------------------------------------------
function setDecision(segIndex, decision) {
	if (!review) { return; }
	const seg = review.segments[segIndex];
	if (seg && seg.type === 'hunk') { seg.decision = decision; }
	rerender();
}
function setAll(decision) {
	if (!review) { return; }
	for (const seg of review.segments) { if (seg.type === 'hunk' && seg.decision === 'pending') { seg.decision = decision; } }
	rerender();
}
function currentHunkIndex() {
	if (!review || !review.pending.length) { return -1; }
	const editor = vscode.window.activeTextEditor;
	const line = editor ? editor.selection.active.line : -1;
	let idx = review.pending.findIndex((p) => line >= p.absLine && line <= p.absLine + Math.max(0, p.lineCount - 1));
	if (idx === -1) { idx = 0; } // default to first pending
	return idx;
}
function keepCurrent() { const i = currentHunkIndex(); if (i >= 0) { setDecision(review.pending[i].segIndex, 'keep'); } }
function undoCurrent() { const i = currentHunkIndex(); if (i >= 0) { setDecision(review.pending[i].segIndex, 'undo'); } }
function gotoHunk(dir) {
	if (!review || !review.pending.length) { return; }
	const editor = vscode.window.activeTextEditor;
	if (!editor) { return; }
	const cur = editor.selection.active.line;
	const lines = review.pending.map((p) => p.absLine).sort((a, b) => a - b);
	let target = dir > 0 ? lines.find((l) => l > cur) : [...lines].reverse().find((l) => l < cur);
	if (target === undefined) { target = dir > 0 ? lines[0] : lines[lines.length - 1]; }
	editor.selection = new vscode.Selection(target, 0, target, 0);
	editor.revealRange(new vscode.Range(target, 0, target, 0), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
	updateBar();
}

// ---- hover with clickable Keep/Undo --------------------------------------
function cmdLink(label, command, args) {
	return `[${label}](command:${command}?${encodeURIComponent(JSON.stringify(args))})`;
}
class ReviewHoverProvider {
	provideHover(document, position) {
		if (!review || document.uri.toString() !== review.uri.toString()) { return undefined; }
		const p = review.pending.find((h) => position.line >= h.absLine && position.line <= h.absLine + Math.max(0, h.lineCount - 1));
		if (!p) { return undefined; }
		const md = new vscode.MarkdownString(
			`**Atom++ AI change** &nbsp;&nbsp; ` +
			cmdLink('$(check) Keep', 'atompp.ai.review.keepHunk', [p.segIndex]) + ' &nbsp; ' +
			cmdLink('$(close) Undo', 'atompp.ai.review.undoHunk', [p.segIndex])
		);
		md.isTrusted = true; md.supportThemeIcons = true;
		const lc = Math.max(1, p.lineCount);
		return new vscode.Hover(md, new vscode.Range(p.absLine, 0, p.absLine + lc - 1, 0));
	}
}

// ---- always-on status-bar bar --------------------------------------------
function makeItem(priority, text, command, tooltip) {
	const it = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, priority);
	it.text = text; if (command) { it.command = command; } if (tooltip) { it.tooltip = tooltip; }
	return it;
}
function buildBar(context) {
	bar = [
		makeItem(1008, '$(sparkle) Atom++ AI', undefined, 'Reviewing AI edit'),
		makeItem(1007, '', undefined, 'Current change'),                       // count i/n
		makeItem(1006, '$(arrow-up)', 'atompp.ai.review.prev', 'Previous change'),
		makeItem(1005, '$(arrow-down)', 'atompp.ai.review.next', 'Next change'),
		makeItem(1004, '$(check) Keep', 'atompp.ai.review.keepCurrent', 'Keep this change'),
		makeItem(1003, '$(close) Undo', 'atompp.ai.review.undoCurrent', 'Undo this change'),
		makeItem(1002, '$(check-all) Keep All', 'atompp.ai.review.keepAll', 'Keep all changes'),
		makeItem(1001, '$(discard) Undo All', 'atompp.ai.review.undoAll', 'Undo all changes')
	];
	bar[4].backgroundColor = new vscode.ThemeColor('statusBarItem.prominentBackground');
	context.subscriptions.push(...bar);
}
function updateBar() {
	if (!review || !review.pending.length) { hideBar(); return; }
	const i = currentHunkIndex();
	bar[1].text = `${i + 1}/${review.pending.length}`;
	for (const it of bar) { it.show(); }
}
function hideBar() { for (const it of bar) { it.hide(); } }

/** @param {vscode.ExtensionContext} context */
function registerInlineReview(context) {
	greenDecoration = vscode.window.createTextEditorDecorationType({
		isWholeLine: true,
		backgroundColor: 'rgba(46,160,67,0.18)',
		overviewRulerColor: 'rgba(46,160,67,0.8)',
		overviewRulerLane: vscode.OverviewRulerLane.Center
	});
	buildBar(context);
	context.subscriptions.push(
		greenDecoration,
		vscode.languages.registerHoverProvider({ scheme: 'file' }, new ReviewHoverProvider()),
		vscode.window.onDidChangeTextEditorSelection(() => { if (review) { updateBar(); } }),
		vscode.commands.registerCommand('atompp.ai.review.keepHunk', (i) => setDecision(i, 'keep')),
		vscode.commands.registerCommand('atompp.ai.review.undoHunk', (i) => setDecision(i, 'undo')),
		vscode.commands.registerCommand('atompp.ai.review.keepCurrent', keepCurrent),
		vscode.commands.registerCommand('atompp.ai.review.undoCurrent', undoCurrent),
		vscode.commands.registerCommand('atompp.ai.review.keepAll', () => setAll('keep')),
		vscode.commands.registerCommand('atompp.ai.review.undoAll', () => setAll('undo')),
		vscode.commands.registerCommand('atompp.ai.review.next', () => gotoHunk(1)),
		vscode.commands.registerCommand('atompp.ai.review.prev', () => gotoHunk(-1))
	);
}

module.exports = { registerInlineReview, start };
