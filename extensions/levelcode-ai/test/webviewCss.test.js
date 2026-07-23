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

// The other way CSS lies about state: a more specific rule quietly outranking the one that should
// win. Collapsing the ask_user card must hide the question on screen, but `.questions.collapsed
// .qblock` is three classes and `.questions.wizard .qblock.cur` is four — so the override has to
// exist AND come later, or a collapsed card keeps showing its current question.
test('collapsing the ask_user card outranks the wizard rule that reveals a question', () => {
	const wizardRule = css.indexOf('.questions.wizard .qblock.cur');
	const override = css.indexOf('.questions.collapsed .qblock.cur');
	assert.ok(wizardRule >= 0, 'wizard reveal rule still present');
	assert.ok(override >= 0, 'missing the collapsed override — collapsing mid-wizard would do nothing');
	assert.ok(override > wizardRule, 'the override must come later to win at equal specificity');
});

// The circle-check glyph is one icon shared by every "done" tick and the menu's selected mark.
// Pin its shape and its reach so a refactor can't quietly drop it back to a bare check.
test('the check-circle glyph is an outline: a ring AND a stroked tick', () => {
	const m = /'check-circle':\s*\{[^}]*p:\s*'([^']*)'/.exec(html);
	assert.ok(m, "IC no longer defines 'check-circle'");
	const p = m[1];
	assert.ok(/<circle[^>]*stroke="currentColor"/.test(p), 'the ring is drawn as a stroke');
	assert.ok(/<path[^>]*fill="none"[^>]*stroke="currentColor"/.test(p), 'the tick is a stroked path, not a fill');
});

test('the menu selected-tick uses the circle-check, not a literal ✓', () => {
	const ticks = html.match(/<span class="mocheck"[^>]*>/g) || [];
	assert.ok(ticks.length >= 2, 'menu tick spans still present');
	assert.ok(ticks.every((t) => /data-ico="check-circle"/.test(t)), 'every mocheck is painted from the glyph');
	assert.ok(!/mocheck[^>]*>&#10003;/.test(html) && !/mocheck[^>]*>\s*✓/.test(html), 'no literal check left in the menu');
	// and the paint pass is broad enough to reach them (not just .moico)
	assert.ok(/querySelectorAll\('\[data-ico\]'\)[\s\S]{0,80}codicon\(/.test(html),
		'the [data-ico] paint pass must cover .mocheck, not only .moico');
});

test('every check migrated to the ring-check — no bare codicon(\'check\') anywhere', () => {
	// Including the group rail node: its own .tl-node border is dropped for the done state
	// (.tl-group.gok/.gfailed border-color: transparent) so the glyph's ring is the only ring.
	const bare = [...html.matchAll(/codicon\('check'\)/g)].length;
	assert.strictEqual(bare, 0, "no plain codicon('check') should remain — use codicon('check-circle')");
	assert.ok(/g\.node\.innerHTML = codicon\(g\.failed \? 'circle-slash' : 'check-circle'\)/.test(html),
		'the group node paints the ring-check');
	assert.ok(/\.tl-group\.gok \.tl-node\b[^}]*border-color:\s*transparent/.test(css),
		'and drops its own border so there is a single ring, not two');
});

console.log('webviewCss: ' + n + ' tests passed');
