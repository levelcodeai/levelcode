/*---------------------------------------------------------------------------------------------
 *  The chat's browser skin — run: node web/test/unit/skin.test.js
 *
 *  The skin is a stylesheet, a class on <body> and a script, inserted into the copy of media/chat.html that goes
 *  into the browser bundle. What matters:
 *    - the desktop's chat.html is untouched, and nothing of the skin lives under extensions/;
 *    - the insertions are exactly the three, and taking them out gives the original back;
 *    - every rule of the skin is under body.lc-web, so a stray rule cannot restyle the page without the class;
 *    - the script only sends messages the page already sends;
 *    - the build says so when chat.html stops having the places the skin is cut into.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..', '..', '..');
const { skinChat, ANCHORS } = require(path.join(REPO, 'web', 'ai-extension', 'skin.js'));
const { applyCopy } = require(path.join(REPO, 'web', 'ai-extension', 'copy.js'));

const desktop = fs.readFileSync(path.join(REPO, 'extensions', 'levelcode-ai', 'media', 'chat.html'), 'utf8');
const base = applyCopy('media/chat.html', desktop);
const css = fs.readFileSync(path.join(REPO, 'web', 'ai-extension', 'skin', 'chat.css'), 'utf8');
const js = fs.readFileSync(path.join(REPO, 'web', 'ai-extension', 'skin', 'chat.js'), 'utf8');

let n = 0;
function test(name, fn) { fn(); n++; console.log('  ok - ' + name); }
const count = (text, needle) => text.split(needle).length - 1;

test('the desktop page has no trace of the skin, and no file of it is under extensions/', () => {
	assert.ok(!/lc-web|lcw-/.test(desktop), 'chat.html names the skin');
	const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
		const p = path.join(d, e.name);
		if (e.name === 'node_modules' || e.name === '.git') { return []; }
		return e.isDirectory() ? walk(p) : [p];
	});
	const strays = walk(path.join(REPO, 'extensions')).filter((f) => /skin/i.test(path.basename(f)) || (/\.(js|css|html)$/.test(f) && fs.readFileSync(f, 'utf8').includes('lcw-skin')));
	assert.deepStrictEqual(strays, []);
});

test('the skinned page is the original plus the three insertions, and nothing else', () => {
	const out = skinChat(base);
	assert.strictEqual(count(out, 'id="lcw-skin"'), 1);
	assert.strictEqual(count(out, '<body class="lc-web">'), 1);
	assert.strictEqual(count(out, '<script nonce="__NONCE__">'), count(base, '<script nonce="__NONCE__">') + 1);
	const back = out
		.replace(`</style>\n<style id="lcw-skin">\n${css}</style>\n</head>`, ANCHORS.STYLE_END)
		.replace('</head>\n<body class="lc-web">\n', ANCHORS.BODY_OPEN)
		.replace(`</script>\n<script nonce="__NONCE__">\n${js}</script>\n</body>`, ANCHORS.SCRIPT_END);
	assert.strictEqual(back, base);
});

test('the skin script is the last thing to run, after the page\'s own', () => {
	const out = skinChat(base);
	const own = out.lastIndexOf('vscode.postMessage({ type: \'ready\' });');
	assert.ok(own > 0, 'the page\'s own ready message');
	assert.ok(out.indexOf(js.slice(0, 80)) > own, 'the skin script comes after it');
});

test('every rule of the stylesheet is under body.lc-web', () => {
	const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
	let depth = 0; let head = '';
	const bad = [];
	for (const ch of text) {
		if (ch === '{') {
			const sel = head.trim();
			if (depth === 0 && !sel.startsWith('@')) { sel.split(',').forEach((s) => { if (!s.trim().startsWith('body.lc-web')) { bad.push(s.trim()); } }); }
			else if (depth === 1 && !sel.startsWith('@')) { sel.split(',').forEach((s) => { if (!s.trim().startsWith('body.lc-web')) { bad.push(s.trim()); } }); }
			depth++; head = '';
		} else if (ch === '}') { depth--; head = ''; }
		else if (ch === ';' && depth > 0) { head = ''; }
		else if (depth === 0 || (depth === 1 && head !== undefined)) { head += ch; }
	}
	assert.strictEqual(depth, 0, 'balanced braces');
	assert.deepStrictEqual(bad.filter((s) => s && !/^\d/.test(s)), []);
});

test('neither file can end its own block early', () => {
	for (const text of [css, js]) {
		assert.ok(!/<\/(script|style)/i.test(text));
		assert.ok(!text.includes('<!--'));
	}
});

test('the script is valid and sends only messages the page already sends', () => {
	assert.doesNotThrow(() => new Function(js));
	const sent = new Set([...js.matchAll(/type:\s*'([A-Za-z]+)'/g)].map((m) => m[1]));
	assert.ok(sent.size > 0);
	for (const t of sent) {
		assert.ok(new RegExp(`vscode\\.postMessage\\(\\{\\s*type:\\s*'${t}'`).test(desktop), `the page itself never sends ${t}`);
	}
});

/* ----- the script, run against a small stand-in for the page ----------------------------------- */
function makePage({ railMatches }) {
	class El {
		constructor(tag) { this.tag = tag; this.children = []; this.attrs = {}; this.listeners = {}; this.style = {}; this.className = ''; this.textContent = ''; this.value = ''; this.classes = new Set(); }
		setAttribute(k, v) { this.attrs[k] = String(v); }
		getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
		removeAttribute(k) { delete this.attrs[k]; }
		appendChild(c) { this.children.push(c); return c; }
		addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); }
		dispatchEvent() { return true; }
		cloneNode() { return new El('svg'); }
		focus() {}
		querySelector(sel) { return this.found && this.found[sel] || null; }
		get classList() { const c = this.classes; return { contains: (x) => c.has(x), add: (x) => c.add(x) }; }
	}
	const ids = {};
	for (const id of ['empty', 'log', 'input', 'sessOverlay', 'sessList', 'lcLogo']) { ids[id] = new El('div'); }
	ids.empty.found = {};
	const panel = new El('div');
	const bar = new El('div');
	bar.found = {};
	const body = new El('body'); body.classes.add('lc-web');
	const posted = [];
	const mq = { matches: railMatches, listeners: [], addEventListener(t, f) { this.listeners.push(f); } };
	const windowListeners = {};
	const timers = [];
	const document = {
		body, getElementById: (id) => ids[id] || null,
		createElement: (t) => new El(t),
		querySelector: (sel) => (sel === '#sessOverlay .sesspanel' ? panel : sel === '#sessOverlay .sessbar' ? bar : null),
	};
	const window = { matchMedia: () => mq, addEventListener: (t, f) => { (windowListeners[t] = windowListeners[t] || []).push(f); } };
	const run = new Function('document', 'window', 'vscode', 'MutationObserver', 'setTimeout', 'clearTimeout', 'Event', js);
	run(document, window, { postMessage: (m) => posted.push(m) }, function () { this.observe = () => {}; }, (f) => { timers.push(f); return timers.length; }, () => {}, function Event() {});
	return { ids, panel, bar, mq, posted, windowListeners, timers };
}

test('the keyboard: Enter and Space on a conversation card resume it; other keys and the card\'s own buttons are left alone', () => {
	const { ids } = makePage({ railMatches: true });
	const [onKey] = ids.sessList.listeners.keydown;
	const card = { classList: { contains: (c) => c === 'sesscard' }, click() { this.clicked = (this.clicked || 0) + 1; } };
	const inner = { classList: { contains: () => false }, click() { this.clicked = (this.clicked || 0) + 1; } };
	let prevented = 0;
	const ev = (key, target) => ({ key, target, preventDefault() { prevented++; } });
	onKey(ev('Enter', card)); onKey(ev(' ', card));
	assert.strictEqual(card.clicked, 2);
	assert.strictEqual(prevented, 2, 'Space would otherwise scroll the list');
	onKey(ev('a', card)); onKey(ev('Tab', card)); onKey(ev('Enter', inner));
	assert.strictEqual(card.clicked, 2);
	assert.strictEqual(inner.clicked, undefined, 'a real button already does its own thing');
});

test('docked: the list is a complementary region with no aria-modal; narrow: a modal dialog, closed until asked for', () => {
	const wide = makePage({ railMatches: true });
	assert.strictEqual(wide.panel.getAttribute('role'), 'complementary');
	assert.strictEqual(wide.panel.getAttribute('aria-modal'), null, 'aria-modal="false" on a non-dialog is not valid');
	const narrow = makePage({ railMatches: false });
	assert.strictEqual(narrow.panel.getAttribute('role'), 'dialog');
	assert.strictEqual(narrow.panel.getAttribute('aria-modal'), 'true');
	assert.strictEqual(narrow.ids.sessOverlay.style.display, 'none');
	// the window is widened, the list is opened with /sessions (the page sets display inline), and then narrowed again
	const p = makePage({ railMatches: true });
	p.ids.sessOverlay.style.display = 'flex';
	p.mq.matches = false;
	p.mq.listeners.forEach((f) => f());
	assert.strictEqual(p.ids.sessOverlay.style.display, 'none', 'no modal the visitor did not ask for');
	assert.strictEqual(p.panel.getAttribute('role'), 'dialog');
	assert.strictEqual(p.panel.getAttribute('aria-modal'), 'true');
});

test('docked: the list is asked for (never the sample cards), once per burst of events', () => {
	const p = makePage({ railMatches: true });
	assert.strictEqual(p.timers.length, 1, 'once on start');
	p.timers.length = 0; p.posted.length = 0;
	const [onMessage] = p.windowListeners.message;
	for (const type of ['agentDone', 'assistantDone', 'sessionResumed']) { onMessage({ data: { type } }); }
	onMessage({ data: { type: 'somethingElse' } });
	p.timers.forEach((f) => f());
	assert.deepStrictEqual(p.posted.map((m) => m.type), ['listSessions', 'listSessions', 'listSessions'], 'the timers were set per event; the real one is cleared and set again, so the page sees them debounced');
	assert.ok(p.posted.every((m) => m.type !== 'openSessions'));
});

test('the starters make sense in an empty window: none of them names a selection or an open file', () => {
	const m = [...js.matchAll(/\['([^']+)',\s*'([^']+)'\]/g)].map((x) => x.slice(1));
	assert.strictEqual(m.length, 4);
	for (const [title, prompt] of m) {
		assert.ok(!/\b(my selection|the selection|current file|open file|this file|selected)\b/i.test(prompt), title + ': ' + prompt);
	}
});

test('hover reveals the card actions only where there is hover; touch keeps them and gives up the second line', () => {
	const at = css.indexOf('.sesscard .sessacts { display: none; }');
	assert.ok(at > 0);
	const head = css.lastIndexOf('@media', at);
	assert.ok(/@media \(min-width: 1000px\) and \(hover: hover\) and \(pointer: fine\)/.test(css.slice(head, at)), 'the hiding rule is not under the hover media query');
	assert.ok(/@media \(min-width: 1000px\) and \(hover: none\), \(min-width: 1000px\) and \(pointer: coarse\)[^{]*\{\s*body\.lc-web #sessOverlay \.sesscard \.sesssub \{ display: none; \}/.test(css));
});

test('text that was drawn in the translucent focus colour is drawn in the link colour; the empty chat can be scrolled to its top', () => {
	assert.ok(/--lcw-accent-text: var\(--vscode-textLink-foreground, var\(--accent\)\)/.test(css));
	for (const sel of ['.msg .body a', '.filechip .fcname', '.modeopt.active .moname', '#status .stap.autopilot']) {
		assert.ok(new RegExp(`body\\.lc-web ${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^{]*\\{[^}]*color: var\\(--lcw-accent-text\\)`).test(css) || css.includes(`body.lc-web ${sel}, `) || css.includes(`, body.lc-web ${sel}`), sel);
	}
	assert.ok(/body\.lc-web:has\(#empty\) \{ justify-content: safe center; \}/.test(css), 'plain centre clips the top of a window shorter than its content');
	assert.ok(!/#status \{ opacity/.test(css), 'opacity on the footer row dims its popovers too');
});

test('the build refuses a chat.html that is not the shape the skin is cut into', () => {
	for (const anchor of [ANCHORS.STYLE_END, ANCHORS.BODY_OPEN, ANCHORS.SCRIPT_END]) {
		assert.throws(() => skinChat(base.replace(anchor, '')), /expected exactly one/);
		assert.throws(() => skinChat(base + anchor), /expected exactly one/);
	}
});

console.log(`\n${n} tests passed`);
