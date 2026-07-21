/*---------------------------------------------------------------------------------------------
 *  LevelCode — Notepad++ Pack
 *  Feature: JSON beautify-on-paste.
 *
 *  Paste JSON — minified, escaped, one giant line — into ANY editor buffer (a .json file, a .txt, an
 *  untitled scratch tab) and it lands pretty-printed. Implemented as a DocumentPasteEditProvider for
 *  text/plain: when the whole pasted blob is valid JSON (see jsonBeautify.analyzePaste), the paste is
 *  replaced with the formatted text; every other paste falls through untouched.
 *
 *  Why a paste provider and not `editor.formatOnPaste`: formatOnPaste only fires in a buffer the editor
 *  already knows is JSON. This works regardless of the buffer's language — the common "paste a blob
 *  into a scratch tab" case — which was the whole point.
 *
 *  The kind is `text.json.beautify` (nested under the generic `text` paste), so on a normal paste the
 *  editor prefers this more-specific edit and applies it automatically, offering a small paste-options
 *  affordance to switch back to a plain paste. Toggle the whole feature with `levelcode.jsonPaste.enabled`.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

const vscode = require('vscode');
const { analyzePaste } = require('./jsonBeautify');

function registerJsonPaste(context) {
	const kind = vscode.DocumentDropOrPasteEditKind.Empty.append('text', 'json', 'beautify');

	/** @type {vscode.DocumentPasteEditProvider} */
	const provider = {
		async provideDocumentPasteEdits(document, _ranges, dataTransfer, _ctx, token) {
			const cfg = vscode.workspace.getConfiguration('levelcode.jsonPaste', document);
			if (!cfg.get('enabled', true)) { return undefined; }

			const item = dataTransfer.get('text/plain');
			if (!item) { return undefined; }
			const text = await item.asString();
			if (token.isCancellationRequested) { return undefined; }

			const res = analyzePaste(text, { indent: resolveIndent(cfg, document) });
			if (!res.beautify || res.output == null) { return undefined; }

			return [new vscode.DocumentPasteEdit(res.output, 'Beautify JSON', kind)];
		}
	};

	context.subscriptions.push(vscode.languages.registerDocumentPasteEditProvider(
		'*', // any language / scheme — files AND untitled scratch buffers
		provider,
		{ providedPasteEditKinds: [kind], pasteMimeTypes: ['text/plain'] }
	));
}

/**
 * Indent for the pretty-print. `levelcode.jsonPaste.indent`: a number (spaces), "tab", or "editor"
 * (default) → follow the buffer's own tabSize / insertSpaces so beautified JSON matches its surroundings.
 */
function resolveIndent(cfg, document) {
	const setting = cfg.get('indent', 'editor');
	if (setting === 'tab') { return '\t'; }
	if (typeof setting === 'number' && setting > 0) { return Math.min(setting, 8); }
	const ed = vscode.workspace.getConfiguration('editor', document);
	return ed.get('insertSpaces', true) ? (ed.get('tabSize', 2) || 2) : '\t';
}

module.exports = { registerJsonPaste };
