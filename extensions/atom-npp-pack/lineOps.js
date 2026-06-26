/*---------------------------------------------------------------------------------------------
 *  Atom++ — Notepad++ Pack
 *  Feature: Line operations (M1, feature 5) — the everyday Notepad++/TextFX set.
 *
 *  Each line op works on the selected lines (selection expanded to whole lines), or the
 *  whole document if there's no selection — matching Notepad++ behavior. Case ops work
 *  per selection (or the word/line under the cursor when the selection is empty) and
 *  support multi-cursor.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

const vscode = require('vscode');

/** Whole-line range covering the active selection, or the whole document if empty. */
function lineRange(editor) {
	const doc = editor.document;
	const sel = editor.selection;
	if (!sel.isEmpty) {
		let endLine = sel.end.line;
		// A selection that ends at column 0 of a line doesn't really include that line.
		if (sel.end.character === 0 && endLine > sel.start.line) { endLine -= 1; }
		return new vscode.Range(sel.start.line, 0, endLine, doc.lineAt(endLine).text.length);
	}
	const last = doc.lineCount - 1;
	return new vscode.Range(0, 0, last, doc.lineAt(last).text.length);
}

function eol(doc) {
	return doc.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
}

/** Run a lines-array transform over the target range as one edit. */
async function transformLines(editorArg, fn, opName) {
	const editor = editorArg || vscode.window.activeTextEditor;
	if (!editor) { vscode.window.showWarningMessage('Atom++: open a text editor first.'); return; }
	const doc = editor.document;
	const range = lineRange(editor);
	const lines = doc.getText(range).split(/\r?\n/);
	const out = fn(lines);
	if (out.join('\n') === lines.join('\n')) {
		vscode.window.setStatusBarMessage(`Atom++: ${opName} — no change`, 1500);
		return;
	}
	await editor.edit((eb) => eb.replace(range, out.join(eol(doc))));
	vscode.window.setStatusBarMessage(`$(check) Atom++: ${opName} (${lines.length}→${out.length} lines)`, 2000);
}

// --- sorting ---------------------------------------------------------------
const collator = new Intl.Collator(undefined, { sensitivity: 'variant' });
const collatorCI = new Intl.Collator(undefined, { sensitivity: 'base' });

function numericKey(s) {
	const m = String(s).trim().match(/^[+-]?\d+(\.\d+)?/);
	return m ? parseFloat(m[0]) : NaN;
}

const sorters = {
	asc: (a) => [...a].sort((x, y) => collator.compare(x, y)),
	desc: (a) => [...a].sort((x, y) => collator.compare(y, x)),
	ci: (a) => [...a].sort((x, y) => collatorCI.compare(x, y)),
	numeric: (a) => [...a].sort((x, y) => {
		const nx = numericKey(x), ny = numericKey(y);
		if (isNaN(nx) && isNaN(ny)) { return collator.compare(x, y); }
		if (isNaN(nx)) { return 1; }
		if (isNaN(ny)) { return -1; }
		return nx - ny;
	})
};

// --- case conversion -------------------------------------------------------
function toTitle(s) {
	return s.replace(/\w\S*/g, (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
}
function toToggle(s) {
	let r = '';
	for (const ch of s) {
		const lo = ch.toLowerCase(), up = ch.toUpperCase();
		r += ch === lo && ch !== up ? up : (ch === up && ch !== lo ? lo : ch);
	}
	return r;
}
const casers = {
	upper: (s) => s.toUpperCase(),
	lower: (s) => s.toLowerCase(),
	title: toTitle,
	toggle: toToggle
};

async function convertCase(mode) {
	const editor = vscode.window.activeTextEditor;
	if (!editor) { vscode.window.showWarningMessage('Atom++: open a text editor first.'); return; }
	const fn = casers[mode];
	await editor.edit((eb) => {
		for (const sel of editor.selections) {
			let range = sel;
			if (sel.isEmpty) {
				range = editor.document.getWordRangeAtPosition(sel.active) || editor.document.lineAt(sel.active.line).range;
			}
			eb.replace(range, fn(editor.document.getText(range)));
		}
	});
}

/** @param {vscode.ExtensionContext} context */
function registerLineOps(context) {
	const reg = (id, fn) => context.subscriptions.push(vscode.commands.registerCommand(id, fn));

	// Sorting
	reg('atompp.lines.sortAsc', () => transformLines(null, sorters.asc, 'sort ascending'));
	reg('atompp.lines.sortDesc', () => transformLines(null, sorters.desc, 'sort descending'));
	reg('atompp.lines.sortCaseInsensitive', () => transformLines(null, sorters.ci, 'sort (case-insensitive)'));
	reg('atompp.lines.sortNumeric', () => transformLines(null, sorters.numeric, 'sort numerically'));

	// Dedup / blank lines / order
	reg('atompp.lines.removeDuplicates', () => transformLines(null, (a) => {
		const seen = new Set(); const out = [];
		for (const l of a) { if (!seen.has(l)) { seen.add(l); out.push(l); } }
		return out;
	}, 'remove duplicate lines'));
	reg('atompp.lines.removeDuplicatesAdjacent', () => transformLines(null, (a) =>
		a.filter((l, i) => i === 0 || l !== a[i - 1]), 'remove consecutive duplicates'));
	reg('atompp.lines.removeEmpty', () => transformLines(null, (a) =>
		a.filter((l) => l.trim().length > 0), 'remove empty lines'));
	reg('atompp.lines.reverse', () => transformLines(null, (a) => [...a].reverse(), 'reverse lines'));

	// Aliases to robust built-ins (selection-aware already)
	reg('atompp.lines.join', () => vscode.commands.executeCommand('editor.action.joinLines'));
	reg('atompp.lines.trimTrailing', () => vscode.commands.executeCommand('editor.action.trimTrailingWhitespace'));

	// Case
	reg('atompp.case.upper', () => convertCase('upper'));
	reg('atompp.case.lower', () => convertCase('lower'));
	reg('atompp.case.title', () => convertCase('title'));
	reg('atompp.case.toggle', () => convertCase('toggle'));
}

module.exports = { registerLineOps };
