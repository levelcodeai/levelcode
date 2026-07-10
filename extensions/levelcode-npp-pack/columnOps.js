/*---------------------------------------------------------------------------------------------
 *  LevelCode — Notepad++ Pack
 *  Feature: Column editor (M1, feature 4) — insert incrementing numbers + column fill.
 *
 *  Use a box selection (Shift+Alt+drag) or multiple cursors, then "Insert Incrementing
 *  Numbers": each cursor (top→bottom) gets start, start+step, start+2*step, …
 *
 *  The start token doubles as the format spec, Notepad++-style:
 *    1      → 1, 2, 3 …
 *    001    → 001, 002, 003 …      (leading zeros set the padding width)
 *    0x0a   → 0x.. hex, padded to 2 hex digits, lowercase
 *    0xFF   → hex, uppercase
 *  Optional second token is the step (may be negative), e.g. "10 -2".
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

const vscode = require('vscode');

/**
 * Parse the "start [step]" spec into formatting parameters.
 * @param {string} input
 * @returns {{start:number, step:number, base:number, pad:number, upper:boolean, prefix:string}|null}
 */
function parseSpec(input) {
	const parts = String(input).trim().split(/\s+/).filter(Boolean);
	if (parts.length === 0) { return null; }
	const startTok = parts[0];
	let step = 1;
	if (parts[1] !== undefined) {
		const s = parseInt(parts[1], 10);
		if (Number.isNaN(s)) { return null; }
		step = s;
	}

	const hex = /^[+-]?0x[0-9a-f]+$/i.test(startTok);
	if (hex) {
		const neg = startTok.startsWith('-');
		const digits = startTok.replace(/^[+-]?0x/i, '');
		const start = (neg ? -1 : 1) * parseInt(digits, 16);
		const upper = /[A-F]/.test(digits) && !/[a-f]/.test(digits);
		return { start, step, base: 16, pad: digits.length, upper, prefix: '0x' };
	}

	if (!/^[+-]?\d+$/.test(startTok)) { return null; }
	const neg = startTok.startsWith('-');
	const digits = startTok.replace(/^[+-]?/, '');
	const start = parseInt(startTok, 10);
	const pad = digits.length > 1 && digits.startsWith('0') ? digits.length : 0; // leading zero ⇒ pad
	return { start, step, base: 10, pad, upper: false, prefix: '' };
}

/** @param {number} n */
function formatNum(n, spec) {
	const neg = n < 0;
	let s = Math.abs(n).toString(spec.base);
	if (spec.upper) { s = s.toUpperCase(); }
	if (spec.pad > 0) { s = s.padStart(spec.pad, '0'); }
	return (neg ? '-' : '') + spec.prefix + s;
}

async function insertIncrementingNumbers() {
	const editor = vscode.window.activeTextEditor;
	if (!editor) { vscode.window.showWarningMessage('LevelCode: open a text editor first.'); return; }

	const input = await vscode.window.showInputBox({
		title: 'Insert Incrementing Numbers',
		prompt: 'start [step] — leading zeros pad (001), 0x for hex (0x0a). Example: 1   or   001   or   0x00 1',
		value: '1',
		validateInput: (v) => parseSpec(v) ? undefined : 'Format: <start> [step], e.g. "1", "001", "10 -2", "0x0a"'
	});
	if (input === undefined) { return; }
	const spec = parseSpec(input);
	if (!spec) { return; }

	// Apply top→bottom so the numbering follows visual order, not selection order.
	const selections = [...editor.selections].sort((a, b) =>
		a.start.line - b.start.line || a.start.character - b.start.character);

	await editor.edit((eb) => {
		selections.forEach((sel, i) => {
			eb.replace(sel, formatNum(spec.start + i * spec.step, spec));
		});
	});
	vscode.window.setStatusBarMessage(`$(list-ordered) LevelCode: inserted ${selections.length} numbers`, 2000);
}

async function columnFill() {
	const editor = vscode.window.activeTextEditor;
	if (!editor) { vscode.window.showWarningMessage('LevelCode: open a text editor first.'); return; }
	const text = await vscode.window.showInputBox({ title: 'Column Fill', prompt: 'Text to insert at every cursor / selection' });
	if (text === undefined) { return; }
	await editor.edit((eb) => {
		for (const sel of editor.selections) { eb.replace(sel, text); }
	});
	vscode.window.setStatusBarMessage(`$(symbol-string) LevelCode: filled ${editor.selections.length} positions`, 2000);
}

/** @param {vscode.ExtensionContext} context */
function registerColumnOps(context) {
	context.subscriptions.push(
		vscode.commands.registerCommand('levelcode.column.insertNumbers', insertIncrementingNumbers),
		vscode.commands.registerCommand('levelcode.column.fill', columnFill)
	);
}

module.exports = { registerColumnOps, parseSpec, formatNum };
