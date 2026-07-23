/*---------------------------------------------------------------------------------------------
 *  Static CSS invariants for the chat webview — run: node test/webviewCss.test.js
 *
 *  These are the bugs no DOM test can see. groupReducer.test.js proves the reducer sets
 *  `el.hidden = true`; it cannot prove the browser then paints nothing, because the fake DOM has
 *  no stylesheet. That gap shipped a stop button which sat next to a finished group offering to
 *  stop a command that had already exited — `hidden` was inert the whole time.
 *
 *  The trap: the UA stylesheet's `[hidden] { display: none }` is a plain element-level rule, so
 *  ANY class rule that sets `display` outclasses it. Toggling `.hidden` on such an element does
 *  nothing at all. chat.html already carried four hand-written escapes for this (#workbar,
 *  .modewrap, .modemenu, .st-approvals) — proof it is easy to hit and easy to forget.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'media', 'chat.html'), 'utf8');
const css = html.slice(html.indexOf('<style'), html.indexOf('</style>'));

let n = 0;
function test(name, fn) { fn(); n++; console.log('  ok - ' + name); }

// Every class/id on a tag that ships the `hidden` attribute — i.e. every element that declares
// "I get shown and hidden at runtime".
function tokensDeclaredHidden() {
	const toks = new Set();
	for (const t of html.matchAll(/<\w+([^>]*?)\shidden(?=[\s>])([^>]*)>/g)) {
		const attrs = t[1] + ' ' + t[2];
		const cls = /class="([^"]+)"/.exec(attrs);
		if (cls) { cls[1].split(/\s+/).filter(Boolean).forEach((c) => toks.add('.' + c)); }
		const id = /id="([^"]+)"/.exec(attrs);
		if (id) { toks.add('#' + id[1]); }
	}
	return [...toks];
}

// Rules whose selector mentions `tok`, split into the ones that set `display` unconditionally and
// the `[hidden]`-qualified escape that would restore the UA behaviour.
function displayRulesFor(tok) {
	const esc = tok.replace(/[.#]/g, '\\$&');
	const rules = [...css.matchAll(new RegExp('^\\s*([^{}\\n]*' + esc + '[^{}\\n]*)\\{([^}]*)\\}', 'gm'))];
	return {
		unconditional: rules.filter((r) => /display\s*:/.test(r[2]) && !/\[hidden\]/.test(r[1])).map((r) => r[1].trim()),
		hasEscape: rules.some((r) => /\[hidden\]/.test(r[1]) && /display\s*:\s*none/.test(r[2]))
	};
}

test('the hidden attribute is never defeated by an explicit display', () => {
	const toks = tokensDeclaredHidden();
	assert.ok(toks.length >= 4, 'expected to find the runtime-toggled elements, found ' + toks.length);
	const broken = [];
	for (const tok of toks) {
		const { unconditional, hasEscape } = displayRulesFor(tok);
		if (unconditional.length && !hasEscape) { broken.push(tok + ' — set by: ' + unconditional.join(' | ')); }
	}
	assert.deepStrictEqual(broken, [],
		'these elements toggle `hidden` but a class rule forces `display`, so hiding them is a no-op.\n'
		+ 'Add a `<selector>[hidden] { display: none; }` rule, as #workbar and .modemenu already do:\n  '
		+ broken.join('\n  '));
});

// The guard above only bites if the group's stop button is still a hidden-toggled element, so pin
// the pairing directly: the reducer hides it on finalize, and the CSS must let that mean something.
test('the group stop button is hideable, and the reducer hides it when the group closes', () => {
	assert.ok(/class="groupstop"[^>]*\shidden/.test(html), 'groupstop still ships the hidden attribute');
	assert.ok(/\.groupstop\[hidden\]\s*\{[^}]*display\s*:\s*none/.test(css), 'groupstop has its [hidden] escape');
	assert.ok(/g\.stopBtn\.hidden\s*=\s*true/.test(html), 'finalizeGroup still hides it');
});

console.log('webviewCss: ' + n + ' tests passed');
