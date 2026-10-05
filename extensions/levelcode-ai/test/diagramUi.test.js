/*---------------------------------------------------------------------------------------------
 *  Rich diagrams — the chat page's part — run: node test/diagramUi.test.js
 *
 *  The page cannot be booted here (no DOM), so what CAN be pinned from the source is pinned: that
 *  the diagram code in media/chat.html has no way to turn a label into markup, asks the host for
 *  exactly the actions the spec allows, validates before it lays out, and falls back instead of
 *  going blank. `scripts/diagram-browser-check.js` is the other half — it loads this same page in
 *  headless Chrome and checks what actually happens.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'media', 'chat.html'), 'utf8');
const css = html.slice(html.indexOf('<style'), html.indexOf('</style>'));
const scriptOpen = html.lastIndexOf('<script');
const script = html.slice(html.indexOf('>', scriptOpen) + 1, html.indexOf('</script>', scriptOpen));

let n = 0;
function test(name, fn) { fn(); n++; console.log('  ok - ' + name); }

/** The diagram code: from its banner comment to the message listener that follows it. */
const start = script.indexOf('// ── Rich diagrams (docs/RICH-DIAGRAMS.md)');
const end = script.indexOf("window.addEventListener('message'", start);
assert.ok(start > 0 && end > start, 'the diagram block is no longer where this suite looks for it');
const block = script.slice(start, end);
/** Code only — comments say things like "never innerHTML", and must not trip the checks below. */
// Line comments first: one of them may mention a glob, and a block-comment pattern run first would
// take that as an opener and swallow real code up to the next closer.
const code = block.replace(/^\s*\/\/.*$/gm, '').replace(/([;{}),])\s*\/\/[^\n]*$/gm, '$1').replace(/\/\*[\s\S]*?\*\//g, '');
const fn = (name) => {
	const at = code.indexOf('function ' + name + '(');
	assert.ok(at >= 0, name + '() is gone');
	const next = code.indexOf('\n  function ', at + 10);
	return code.slice(at, next > at ? next : code.length);
};

test('SAFE: nothing in the diagram code can turn text into markup, or run it', () => {
	for (const sink of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'eval(', 'new Function', 'srcdoc', 'DOMParser', 'createContextualFragment', 'setHTML']) {
		assert.ok(code.indexOf(sink) < 0, 'the diagram code uses ' + sink + ' — a label must only ever reach the page as a text node');
	}
	assert.ok(!/\.(href|action|formAction)\s*=/.test(code), 'it assigns a URL to something');
	assert.ok(!/location\s*[.=]|window\.open|fetch\(|XMLHttpRequest|WebSocket|importScripts|navigator\.sendBeacon/.test(code), 'it can navigate or reach the network');
	assert.ok(!/setAttribute\(\s*['"]on/i.test(code), 'it sets an event-handler attribute');
	assert.ok(code.length > 6000, 'the block under test is the real one');
});

test('SAFE: the picture is built by the painter alone — the page never creates an SVG element itself', () => {
	assert.ok(code.indexOf('createElementNS') < 0, 'only scene.mount() creates SVG elements; it is the one with the allow-list');
	assert.match(fn('lcdDraw'), /LCD\.scene\.mount\(LCD\.scene\.build\(spec, geo, \{\}\), document\)/);
	assert.match(fn('lcdEl'), /e\.textContent = text/, 'the card chrome sets text with textContent');
	// the only image the page loads is the diagram's own SVG, as a data: URL, to rasterise a PNG
	const srcs = (code.match(/[\w.]+\.src\s*=[^\n]*/g) || []).map((l) => l.trim());
	assert.deepStrictEqual(srcs, ["img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg.text);"]);
});

test('VALIDATE FIRST: a record is accepted by the validator before anything lays it out (FR-3)', () => {
	const draw = fn('lcdDraw');
	const accept = draw.indexOf('LCD.repair.accept(record.spec)'), lay = draw.indexOf('LCD.layout.layout(');
	assert.ok(accept > 0 && lay > accept, 'layout runs before the spec was accepted');
	assert.match(draw, /if \(a\.ok\)\{ spec = a\.spec;/, 'only an accepted spec is used');
	const refused = /if \(!spec\)\{\s*(?:if \(record\.spec && !LCD && !quiet\)\{[^\n]*\}\s*)?lcdFailed\(card, record\);\s*return;\s*\}/.exec(draw);
	assert.ok(refused, 'a refused spec goes to lcdFailed() and nowhere else');
	assert.ok(refused.index > accept && refused.index + refused[0].length < lay, 'and that return comes before the renderer is reached');
});

test('NEVER BLANK: a render that throws becomes an ASCII drawing; a spec that cannot be drawn shows its source', () => {
	const draw = fn('lcdDraw');
	assert.match(draw, /catch \(e\) \{[\s\S]*LCD\.ascii\.render\(spec, \{ maxCols: lcdCols\(card\), title: false \}\)[\s\S]*catch \(e2\) \{ pre\.textContent = LCD\.text\.toSource\(spec\); \}/, 'picture → ASCII → source');
	assert.match(draw, /catch \(e\) \{[\s\S]*'The picture could not be drawn, so a text version is shown instead\.'[\s\S]*card\.insertBefore\(why, stage\);/, 'and the card says that is what happened');
	const failed = fn('lcdFailed');
	assert.match(failed, /'Retry'/); assert.match(failed, /lcd-errors/); assert.match(failed, /'What was sent'/);
	assert.match(code, /const LCD = window\.LCDiagram \|\| null;/, 'the page survives the modules not loading');
});

test('FALLBACK: with no renderer in the page, the host is asked for a text version of the same diagram — and the source stays until it comes', () => {
	const failed = fn('lcdFailed');
	assert.match(failed, /const noRenderer = !!\(record\.spec && !LCD\);/, 'the spec is fine and the page is not: that is the one case');
	assert.match(failed, /if \(noRenderer\)\{[\s\S]*?lcdAct\(record\.id, 'ascii', \{ cols: lcdCols\(card\) \}\);\s*\}/, 'asked for by id, with the width of the card in characters and nothing else');
	assert.match(fn('lcdCols'), /return Math\.max\(40, Math\.min\(200, Math\.floor\(/, 'a whole number in a sane range, whatever the page measured');
	assert.match(failed, /stage\.hidden = true;/, 'the empty block takes no room while the answer is on its way');
	assert.match(failed, /det\.open = !errs\.length;/, 'until then the source is what is shown — never a blank card');
	assert.match(failed, /record\.notes\.join\(' · '\)/, 'a degraded diagram still says what it lost');
	assert.match(failed, /if \(!noRenderer\)\{ ban\.appendChild\(lcdBtn\('Retry'/, 'no Retry here: asking the model again would not load the renderer');
	const show = fn('lcdAscii');
	assert.match(show, /if \(!text\)\{ return; \}/, 'no text from the host: leave the source open');
	assert.match(show, /card\._asciiPre\.textContent = text;/, 'the text goes in as text');
	assert.match(show, /card\.dataset\.id !== String\(m\.id\)/, 'into the card it was asked for, and no other');
	assert.match(show, /det\.open = false;/, 'and the source folds away once there is something better to read');
	assert.match(fn('lcdDraw'), /if \(record\.spec && !LCD && !quiet\)\{ vscode\.postMessage\(\{ type: 'diagramRendered', id: record\.id, ok: false,/, 'and it is counted as a render that failed');
});

test('HOST ACTIONS: the page can ask for exactly openLink, export, retry and the text fallback — and a link is named by its node', () => {
	const actions = new Set();
	for (const m of code.matchAll(/lcdAct\([^,]+,\s*'([a-zA-Z]+)'/g)) { actions.add(m[1]); }
	assert.deepStrictEqual(Array.from(actions).sort(), ['ascii', 'export', 'openLink', 'retry']);
	for (const m of code.matchAll(/lcdAct\(([^)]*)'retry'([^)]*)\)/g)) { assert.strictEqual(m[2], '', 'retry carries an id and nothing else: ' + m[0]); }
	const links = code.match(/'openLink',\s*\{[^}]*\}/g) || [];
	assert.ok(links.length >= 2);
	for (const l of links) { assert.match(l, /^'openLink',\s*\{ node: link\.getAttribute\('data-lc-link'\) \}$/, 'an openLink carries the node id and nothing else: ' + l); }
	// every message type the block posts
	const types = new Set();
	for (const m of code.matchAll(/type:\s*'([a-zA-Z]+)'/g)) { types.add(m[1]); }
	assert.deepStrictEqual(Array.from(types).sort(), ['copy', 'diagramAction', 'diagramRendered', 'notice']);
	// only an image export carries bytes; the rest are produced by the host from its own record
	const withData = (code.match(/format:\s*'([a-z]+)',\s*data:/g) || []).map((s) => /'([a-z]+)'/.exec(s)[1]).sort();
	assert.deepStrictEqual(withData, ['png', 'svg']);
	for (const f of ['source', 'mermaid', 'markdown']) { assert.match(code, new RegExp("\\{ format: '" + f + "' \\}"), f + ' is requested without data'); }
});

test('WIRED: placeholder, picture, the end of a run, a reset and a replayed session all reach the diagram code', () => {
	assert.match(script, /else if \(m\.type === 'diagramPending'\)\{ lcdPending\(m\); \}/);
	assert.match(script, /else if \(m\.type === 'diagram'\)\{ lcdShow\(m\); \}/);
	assert.match(script, /else if \(m\.type === 'diagramAscii'\)\{ lcdAscii\(m\); \}/);
	assert.match(script, /m\.type === 'agentDone'\)\{ clearStatus\(\); finishAgentBubble\(\); lcdSweep\(\);/, 'a placeholder that never got its picture is removed when the run ends');
	assert.match(script, /m\.type === 'agentError'\)\{ clearStatus\(\); finishAgentBubble\(\); closeGroup\(\); lcdSweep\(\);/, '…and when it fails');
	assert.match(script, /curGroup = null; turnLabeled = false;\s*\n\s*lcdReset\(\);/, 'New chat drops the references to cards that went with the log');
	assert.match(script, /if \(t\.role === 'diagram'\)\{ lcdShow\(\{ key: t\.key, record: t\.record \}\); continue; \}/, 'a resumed session replays its diagrams from the stored records');
	assert.match(fn('lcdPending'), /if \(card\.dataset\.id\)\{ return; \}/, 'a late placeholder can never blank a finished picture');
	assert.match(fn('lcdHost'), /finishAgentBubble\(\);\s*const body = add\('assistant', ''\);/, 'a diagram sits in the answer, where the model put it');
});

test('STYLE: the title is the type scale\'s 15 semibold, the picture never outgrows the column, and motion is optional', () => {
	assert.ok(css.includes('/*__LCD_CSS__*/'), 'the house style is injected here from diagram/theme.js');
	assert.match(css, /\.lcd-title-text \{ font-size: 15px; font-weight: 600; line-height: 20px;/);
	assert.match(css, /\.lcd-stage svg \{ display: block; max-width: 100%; height: auto; \}/);
	assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{ \.lcd-skel-bar \{ animation: none; \}/);
	assert.match(css, /#lcdZoom\[hidden\] \{ display: none; \}/);
	assert.match(html, /<div id="lcdZoom" hidden role="dialog" aria-modal="true" aria-label="Diagram, full size">/);
	// no colour of its own inside the card chrome except the two neutral fallbacks every card in this file uses
	const chrome = css.slice(css.indexOf('/*__LCD_CSS__*/'), css.length);
	for (const m of chrome.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) { assert.ok(['#73c991', '#1e1e1e'].includes(m[0]), 'a literal colour in the diagram chrome: ' + m[0]); }
});

test('ACCESSIBLE: the outline is hidden from sight but NOT from a screen reader; pictures and nodes are reachable', () => {
	const rule = /\.lcd-sr \{([^}]*)\}/.exec(css);
	assert.ok(rule, '.lcd-sr is gone');
	assert.match(rule[1], /clip-path: inset\(50%\)/);
	assert.ok(!/display:\s*none|visibility:\s*hidden/.test(rule[1]), 'display:none / visibility:hidden would take the outline out of the accessibility tree too');
	const draw = fn('lcdDraw');
	assert.match(draw, /svg\.setAttribute\('aria-describedby', descId\)/);
	assert.match(draw, /lcdEl\('p', 'lcd-sr', LCD\.text\.outline\(spec\)\.text\)/);
	assert.match(draw, /card\.setAttribute\('aria-label', 'Diagram: ' \+ title\)/);
	assert.match(draw, /stage\.tabIndex = 0; stage\.setAttribute\('role', 'button'\)/, 'the picture can be opened from the keyboard');
	assert.match(code, /e\.key === 'Enter' \|\| e\.key === ' '/, 'and so can a linked node');
	assert.match(fn('lcdPending'), /card\.setAttribute\('role', 'status'\); card\.setAttribute\('aria-live', 'polite'\)/);
	assert.match(code, /e\.key === 'Escape'\)\{ e\.stopPropagation\(\); e\.preventDefault\(\); lcdZoomClose\(\); \}/);
});

test('THEME: export is the only moment a colour is baked in — the live picture keeps its tokens', () => {
	const resolved = fn('lcdResolved');
	assert.match(resolved, /probe\.style\.color = 'var\(--lcd-' \+ name \+ '\)'/);
	assert.match(fn('lcdSvg'), /css: LCD\.theme\.css\(\{ resolved: lcdResolved\(card\) \}\)/);
	assert.match(fn('lcdDraw'), /LCD\.scene\.build\(spec, geo, \{\}\)/, 'no stylesheet and no resolved colours go into the picture on screen');
	assert.ok(!/matchMedia|vscode-dark|vscode-light|onDidChangeTheme/.test(code), 'nothing re-renders on a theme change: the tokens do it');
});

test('MEASURED: boxes are sized with the real font, and never with a font the canvas refused', () => {
	const m = fn('lcdMeasure');
	assert.match(m, /lcdCtx\.font = T\.weight \+ ' ' \+ T\.size \+ 'px ' \+ lcdFont\(\);/);
	assert.match(m, /if \(String\(lcdCtx\.font\)\.indexOf\(T\.size \+ 'px'\) >= 0\)/, 'a rejected font string must not be measured with');
	assert.match(m, /return LCD\.theme\.approxMeasure\(text, role\);/, 'the fallback errs wide');
	assert.match(fn('lcdDraw'), /LCD\.layout\.layout\(spec, \{ measure: lcdMeasure, maxWidth: avail \|\| undefined \}\)/, 'and laid out to the width of the column');
});

console.log('diagramUi: ' + n + ' tests passed');
