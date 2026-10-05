/*---------------------------------------------------------------------------------------------
 *  LevelCode — AI · rich diagrams · the webview's copy  (docs/RICH-DIAGRAMS.md, "Architecture")
 *
 *  The chat renders diagrams itself — it has the real font to measure text with and the live theme
 *  to paint with — using the SAME modules the extension host validates with. There is one copy of
 *  that code, in this folder; this file hands it to the webview as source text, which extension.js
 *  inlines into chat.html under the page's own script nonce.
 *
 *  Inlined, not linked: every document this extension serves is self-contained (webviewCsp() allows
 *  no remote anything), and one nonce'd inline block keeps it that way — no extra origin in the CSP,
 *  no file to fetch, and the page behaves identically in the test harness.
 *
 *  Host-only. Never shipped to the webview itself: tool.js (what the model is told), service.js
 *  (conversation state), stats.js and this file stay on the host side.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

const fs = require('fs');
const path = require('path');
const theme = require('./theme');

/** In dependency order: each module's factory reads the ones before it off `LCDiagram`. */
const FILES = ['theme.js', 'schema.js', 'validate.js', 'repair.js', 'layout.js', 'scene.js', 'text.js', 'ascii.js'];

/**
 * A script block ends at the first "</script" the HTML parser sees, and "<!--" changes how the rest
 * is tokenised — whatever JavaScript thinks they are. None of these files contains either; if one
 * ever does, refuse to build the page rather than ship a script that ends early.
 */
const BREAKS_SCRIPT = /<\/script|<!--|<script/i;

let cached = null;
/** The modules, concatenated, ready to sit inside one <script> element. */
function webviewSource() {
	if (cached !== null) { return cached; }
	const parts = FILES.map((f) => {
		const src = fs.readFileSync(path.join(__dirname, f), 'utf8');
		if (BREAKS_SCRIPT.test(src)) { throw new Error('diagram/' + f + ' contains a sequence that would end an inline <script> block'); }
		return '// ---- diagram/' + f + '\n' + src;
	});
	cached = parts.join('\n;\n');
	return cached;
}
/** The stylesheet for the live view: every rule reads an editor theme token. */
function webviewCss() { return theme.css(); }

/**
 * Put both into the page. chat.html carries two placeholders; a function replacer is used so no "$"
 * in the source is read as a replacement pattern.
 * @param {string} html
 */
function inject(html) {
	return String(html)
		.replace('/*__LCD_CSS__*/', () => webviewCss())
		.replace('/*__LCD_JS__*/', () => webviewSource());
}

module.exports = { FILES, webviewSource, webviewCss, inject, BREAKS_SCRIPT };
