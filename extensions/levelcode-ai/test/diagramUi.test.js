/*---------------------------------------------------------------------------------------------
 *  Rich diagrams — the chat page's part — run: node test/diagramUi.test.js
 *
 *  The page cannot be booted here (no DOM), so what CAN be pinned from the source is pinned: that
 *  the diagram code in media/chat.html has no way to turn a label into markup, asks the host for
 *  exactly the actions the spec allows, validates before it lays out, and falls back instead of
 *  going blank. `scripts/diagram-browser-check.js` is the other half — it loads this same page in
 *  headless Chrome and checks what actually happens.
 *
 *  Two parts ARE run here, sliced out of the page: which card a diagram lands in (bookkeeping over a
 *  handful of DOM calls, against a stand-in for them — CARDS), and where Tab goes in the full-size
 *  view (a pure function — MODAL). Both went wrong once with every source pin in this file green.
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

/**
 * One function and nothing after it — for code that is RUN, where `fn()`'s "up to the next function"
 * would bring along whatever statements follow. Braces are counted outside string literals.
 */
const exact = (name) => {
	const at = code.indexOf('function ' + name + '(');
	assert.ok(at >= 0, name + '() is gone');
	let depth = 0, quote = '';
	for (let i = code.indexOf('{', at); i < code.length; i++) {
		const c = code[i];
		if (quote) { if (c === '\\') { i++; } else if (c === quote) { quote = ''; } continue; }
		if (c === "'" || c === '"' || c === '`') { quote = c; }
		else if (c === '{') { depth++; }
		else if (c === '}' && --depth === 0) { return code.slice(at, i + 1); }
	}
	throw new Error('no end found for ' + name + '()');
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
	// The picture is not itself a control: its linked nodes are, and a control inside a control has
	// no single thing to be announced as. Full size is a button of its own, in the toolbar.
	assert.ok(!/stage\.(tabIndex|setAttribute\('(role|tabindex|aria-label)')/.test(draw), 'the stage is given a role, a tab stop or a name again');
	assert.ok(!/\.lcd-stage:focus/.test(css), 'and it has no focus style, because it cannot have the focus');
	assert.match(fn('lcdTools'), /if \(!textOnly\)\{ bar\.appendChild\(lcdBtn\('Full size', '[^']+', function\(\)\{ lcdZoomOpen\(card\); \}\)\); \}\s*const copy = /, 'the picture is opened from the keyboard with a real button, first in the toolbar — and only when there is a picture');
	assert.match(code, /log\.addEventListener\('keydown', function\(e\)\{ if \(\(e\.key === 'Enter' \|\| e\.key === ' '\) && e\.target && e\.target\.closest && e\.target\.closest\('\[data-lc-link\]'\) && lcdActivate\(e\)\)/, 'and a linked node is opened with Enter or Space');
	assert.match(fn('lcdPending'), /card\.setAttribute\('role', 'status'\); card\.setAttribute\('aria-live', 'polite'\)/);
	assert.match(code, /e\.key === 'Escape'\)\{ e\.stopPropagation\(\); e\.preventDefault\(\); lcdZoomClose\(\); \}/);
});

test('MODAL: the full-size view says it is modal, and is — the page behind it is inert and Tab goes round inside', () => {
	const open = fn('lcdZoomOpen'), close = fn('lcdZoomClose');
	// opening: remember where the focus was, put everything else on the page out of reach, focus the dialog
	assert.match(open, /if \(lcdZ\.el\.hidden\)\{\s*lcdZ\.back = document\.activeElement;\s*lcdZ\.behind = Array\.prototype\.filter\.call\(document\.body\.children, function\(n\)\{ return n !== lcdZ\.el && !n\.inert && /, 'every other child of the body, except what was inert already');
	assert.match(open, /lcdZ\.behind\.forEach\(function\(n\)\{ n\.inert = true; \}\);/);
	assert.match(open, /lcdZ\.el\.hidden = false;[\s\S]*close\.focus\(\);/);
	// closing: the page comes back BEFORE the focus does — an inert element cannot take it
	const back = close.indexOf('n.inert = false'), focus = close.indexOf('lcdZ.back.focus()');
	assert.ok(back > 0 && focus > back, 'the focus is handed back while its target is still inert');
	assert.match(close, /lcdZ\.behind = \[\];/, 'and only what THIS opening made inert is released');
	assert.match(fn('lcdZoomStops'), /querySelectorAll\('button:not\(\[disabled\]\), \[data-lc-link\]'\)/);
	assert.match(code, /else if \(e\.key === 'Tab'\)\{ const to = lcdZoomTab\(lcdZoomStops\(\), document\.activeElement, e\.shiftKey\); if \(to\)\{ e\.preventDefault\(\); to\.focus\(\); \} \}/);
	assert.match(code, /else if \(\(e\.key === 'Enter' \|\| e\.key === ' '\) && link && lcdZ\.card\)\{ e\.preventDefault\(\); lcdAct\(lcdZ\.card\.dataset\.id, 'openLink', \{ node: link\.getAttribute\('data-lc-link'\) \}\); \}/, 'a linked node works from the keyboard in here too');

	// …and where Tab goes, run: the page's own function
	// eslint-disable-next-line no-new-func
	const tab = new Function(exact('lcdZoomTab') + '\nreturn lcdZoomTab;')();
	const [out, zin, fit, one, x, node] = ['out', 'in', 'fit', 'one', 'close', 'node'].map((name) => ({ name }));
	const stops = [out, zin, fit, one, x, node], body = { name: 'body' };
	assert.strictEqual(tab(stops, node, false), out, 'Tab on the last stop goes round to the first');
	assert.strictEqual(tab(stops, out, true), node, 'Shift+Tab on the first goes round to the last');
	for (const mid of [zin, fit, one, x]) { assert.strictEqual(tab(stops, mid, false), null); assert.strictEqual(tab(stops, mid, true), null); }
	assert.strictEqual(tab(stops, out, false), null, 'in the middle, the browser moves the focus — its next stop is inside');
	assert.strictEqual(tab(stops, node, true), null);
	assert.strictEqual(tab(stops, body, false), out, 'a focus that got outside is brought back in');
	assert.strictEqual(tab(stops, body, true), node);
	assert.strictEqual(tab([x], x, false), x, 'one stop: Tab stays on it');
	assert.strictEqual(tab([x], x, true), x);
	assert.strictEqual(tab([], body, false), body, 'nothing to stop at: Tab still goes nowhere else');
});

// ---- which card a diagram lands in, RUN ---------------------------------------------------------------
// The page's own lcdHost / lcdPending / lcdShow / lcdDrop / lcdSweep, over just enough of a DOM for them:
// a tree, `dataset`, `isConnected`. What is under test is the bookkeeping — one diagram, one card, the
// same cards a reopened session shows — not the drawing, which is a stub that marks the card as drawn.
function cardsPage() {
	class El {
		constructor(tag) { this.tagName = String(tag).toUpperCase(); this.children = []; this.parentElement = null; this.dataset = {}; this.className = ''; this.own = ''; this.attrs = {}; }
		get isConnected() { let e = this; while (e.parentElement) { e = e.parentElement; } return e === log; }
		appendChild(c) { c.remove(); c.parentElement = this; this.children.push(c); return c; }
		remove() { const p = this.parentElement; if (p) { p.children.splice(p.children.indexOf(this), 1); this.parentElement = null; } }
		get childElementCount() { return this.children.length; }
		get textContent() { return this.own + this.children.map((c) => c.textContent).join(''); }
		set textContent(v) { for (const c of this.children.slice()) { c.remove(); } this.own = String(v); }
		setAttribute(k, v) { this.attrs[k] = String(v); }
		removeAttribute(k) { delete this.attrs[k]; }
		get classList() { return { contains: (c) => this.className.split(/\s+/).includes(c) }; }
	}
	const log = new El('div');
	const add = (role) => { const msg = new El('div'); msg.className = 'msg ' + role; const body = new El('div'); body.className = 'body'; msg.appendChild(body); log.appendChild(msg); return body; };
	const lcdDraw = (card, record) => { card.className = 'lcd'; card.textContent = ''; card.dataset.id = record.id; delete card.dataset.state; card.drawn = (card.drawn || 0) + 1; };
	const decl = /const lcdCards = [^;\n]+;/.exec(code);
	assert.ok(decl, 'the table of cards is gone');
	// eslint-disable-next-line no-new-func
	const page = new Function('document', 'add', 'finishAgentBubble', 'lcdDraw', 'scrollIfStuck',
		[decl[0]].concat(['lcdEl', 'lcdHost', 'lcdPending', 'lcdDrop', 'lcdShow', 'lcdSweep'].map(exact), ['return { lcdPending, lcdShow, lcdSweep, lcdCards };']).join('\n')
	)({ createElement: (tag) => new El(tag) }, add, () => {}, lcdDraw, () => {});
	const cards = () => { const out = []; const walk = (e) => { if (/(^| )lcd( |$)/.test(e.className)) { out.push(e); } e.children.forEach(walk); }; walk(log); return out; };
	return Object.assign(page, {
		log,
		/** What is on screen: one entry per card — the id of the diagram it shows, or the state of its placeholder. */
		shown: () => cards().map((c) => c.dataset.id || '(' + c.dataset.state + ')'),
		/** The transcript, bubble by bubble: a card by what it shows, prose by its words. */
		layout: () => log.children.map((msg) => { const c = cards().find((x) => x.parentElement && x.parentElement.parentElement === msg); return c ? (c.dataset.id || '(' + c.dataset.state + ')') : msg.textContent; }),
		bubbles: () => log.children.length,
		say: (text) => { add('assistant').own = text; },
		pending: (key, state) => page.lcdPending({ key, state: state || 'drawing', title: '' }),
		record: (key, id, extra) => page.lcdShow(Object.assign({ key, record: Object.assign({ id, key, status: 'ok' }, (extra && extra.record) || {}) }, extra && extra.replacesKey ? { replacesKey: extra.replacesKey } : {}))
	});
}

test('CARDS: a diagram is drawn in the placeholder that was holding its place', () => {
	const p = cardsPage();
	p.pending('toolu_1'); p.pending('toolu_1');
	assert.deepStrictEqual(p.shown(), ['(drawing)'], 'one placeholder, however many times it is announced');
	p.record('toolu_1', 'd-1');
	assert.deepStrictEqual(p.shown(), ['d-1']);
	p.pending('toolu_1');
	assert.deepStrictEqual(p.shown(), ['d-1'], 'a late placeholder never blanks a picture');
	// with no placeholder at all (a replayed session), a record makes its own card
	p.record('toolu_2', 'd-2');
	assert.deepStrictEqual(p.shown(), ['d-1', 'd-2']);
	// a card that went with a wiped transcript is not drawn into: nobody would see it
	const gone = cardsPage();
	gone.pending('toolu_1'); gone.log.children[0].remove();
	assert.deepStrictEqual(gone.shown(), []);
	gone.record('toolu_1', 'd-1');
	assert.deepStrictEqual(gone.shown(), ['d-1']);
});

test('CARDS: a repair is drawn where the failed attempt was waiting — one card', () => {
	const p = cardsPage();
	p.pending('toolu_1'); p.pending('toolu_1', 'repairing');
	p.pending('toolu_2');   // the model starts its second go: no new card
	assert.deepStrictEqual(p.shown(), ['(repairing)']);
	p.record('toolu_2', 'd-1', { replacesKey: 'toolu_1', record: { repaired: true } });
	assert.deepStrictEqual(p.shown(), ['d-1']);
	// …and it is drawn IN that place, whether or not the second call announced itself first
	for (const announced of [true, false]) {
		const r = cardsPage();
		r.say('Here is the flow.'); r.pending('toolu_1'); r.pending('toolu_1', 'repairing'); r.say('One edge was wrong.');
		if (announced) { r.pending('toolu_2'); }
		r.record('toolu_2', 'd-1', { replacesKey: 'toolu_1' });
		assert.deepStrictEqual(r.layout(), ['Here is the flow.', 'd-1', 'One edge was wrong.'], 'announced: ' + announced);
	}
	// two calls in ONE turn, the second repairing the first: each had a placeholder, one picture is left
	const q = cardsPage();
	q.pending('toolu_1'); q.pending('toolu_2'); q.pending('toolu_1', 'repairing');
	assert.deepStrictEqual(q.shown(), ['(repairing)', '(drawing)']);
	q.record('toolu_2', 'd-1', { replacesKey: 'toolu_1' });
	assert.deepStrictEqual(q.shown(), ['d-1']);
	assert.strictEqual(q.bubbles(), 1, 'and the bubble that only held the other placeholder went with it');
});

test('CARDS: a redraw leaves ONE picture on screen — what a reopened session shows', () => {
	// as a real run sends it: every call announces itself before its record arrives
	const p = cardsPage();
	p.say('Here is the flow.'); p.pending('toolu_1'); p.record('toolu_1', 'd-1');
	p.say('Top to bottom reads better.'); p.pending('toolu_2');
	assert.deepStrictEqual(p.shown(), ['d-1', '(drawing)']);
	p.record('toolu_2', 'd-2', { replacesKey: 'toolu_1', record: { replaces: 'd-1' } });
	assert.deepStrictEqual(p.shown(), ['d-2'], 'the earlier drawing is gone, as sessionEvents.toDisplayTurns leaves it out');
	assert.strictEqual(p.bubbles(), 3, 'its empty bubble went too; the prose stayed');
	assert.deepStrictEqual(Object.keys(p.lcdCards), ['toolu_2'], 'and nothing still points at the card that was removed');
	assert.deepStrictEqual(p.layout(), ['Here is the flow.', 'Top to bottom reads better.', 'd-2'], 'it stands where the model drew it again');
	// …and in the same place when the second call never announced itself
	const q = cardsPage();
	q.say('Here is the flow.'); q.record('toolu_1', 'd-1'); q.say('Top to bottom reads better.');
	q.record('toolu_2', 'd-2', { replacesKey: 'toolu_1', record: { replaces: 'd-1' } });
	assert.deepStrictEqual(q.layout(), ['Here is the flow.', 'Top to bottom reads better.', 'd-2']);
});

test('CARDS: a DIFFERENT diagram never takes over a card that shows another one', () => {
	// One was sent back; the model moved on. Its next call took the placeholder over when it began —
	// then the host settled the first diagram into that card. The second needs a card of its own.
	const p = cardsPage();
	p.pending('toolu_1'); p.pending('toolu_1', 'repairing'); p.pending('toolu_2');
	p.record('toolu_1', 'd-1', { record: { status: 'degraded' } });
	p.record('toolu_2', 'd-2');
	assert.deepStrictEqual(p.shown(), ['d-1', 'd-2'], 'two diagrams on file, two cards — the settled one is not painted over');
	// a record that points at a card it has no claim on: neither painted over nor removed
	const q = cardsPage();
	q.record('toolu_1', 'd-1');
	q.record('toolu_2', 'd-2', { replacesKey: 'toolu_1' });
	assert.deepStrictEqual(q.shown(), ['d-1', 'd-2']);
	q.pending('toolu_3'); q.record('toolu_3', 'd-3', { replacesKey: 'toolu_1', record: { replaces: 'd-9' } });
	assert.deepStrictEqual(q.shown(), ['d-1', 'd-2', 'd-3']);
	// the same record again (the column changed width, the chat moved) is drawn in its own card
	q.record('toolu_3', 'd-3');
	assert.deepStrictEqual(q.shown(), ['d-1', 'd-2', 'd-3']);
});

test('CARDS: a tool call may be called anything — names every object answers to are just keys', () => {
	const p = cardsPage();
	const keys = ['__proto__', 'constructor', 'parentNode', 'toString', 'hasOwnProperty', 'isConnected', 'dataset'];
	keys.forEach((key, i) => { p.pending(key); p.record(key, 'd-' + (i + 1)); });
	assert.deepStrictEqual(p.shown(), keys.map((_, i) => 'd-' + (i + 1)), 'one card each, in order — none lost, none drawn over another');
	assert.deepStrictEqual(Object.keys(p.lcdCards), keys);
	assert.strictEqual(Object.getPrototypeOf(p.lcdCards), null, 'the table inherits nothing to collide with');
	assert.strictEqual(({}).drawn, undefined, 'and nothing was written through to every object');
});

test('CARDS: when the run ends, a placeholder that never got its picture goes — and only that', () => {
	const p = cardsPage();
	p.say('Here.'); p.pending('toolu_1'); p.record('toolu_1', 'd-1');
	p.pending('orphan'); p.pending('second'); p.pending('second', 'repairing');
	assert.deepStrictEqual(p.shown(), ['d-1', '(drawing)', '(repairing)']);
	p.lcdSweep();
	assert.deepStrictEqual(p.shown(), ['d-1']);
	assert.strictEqual(p.bubbles(), 2, 'the prose and the picture; the two empty bubbles are gone');
	p.lcdSweep();
	assert.deepStrictEqual(p.shown(), ['d-1']);
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
