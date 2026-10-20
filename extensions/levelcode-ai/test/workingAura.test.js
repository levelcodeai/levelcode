/*---------------------------------------------------------------------------------------------
 *  The working aura — run: node test/workingAura.test.js
 *
 *  A light travels round the message box while LevelCode works, stands still as a whole ring while it
 *  waits on the person, and is gone when nothing is happening (media/chat.html, "the working aura").
 *  The decision, the speed and the switching are lifted out of the shipped chat.html and run here, the way
 *  planProgressUi.test.js runs the queue; the CSS and the wiring are pinned from source, since a stylesheet
 *  and a message switch have nothing to execute outside a browser. The look itself is checked in the real
 *  editor (scripts/working-aura-editor-check.js).
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'media', 'chat.html'), 'utf8');
const ext = fs.readFileSync(path.join(ROOT, 'extension.js'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const scriptOpen = html.lastIndexOf('<script');
const script = html.slice(html.indexOf('>', scriptOpen) + 1, html.indexOf('</script>', scriptOpen));
const css = html.slice(html.indexOf('<style'), html.indexOf('</style>'));

/** A function written over several lines: from `function name(` to its closing brace at two spaces. */
function extract(name) {
	const start = script.indexOf('  function ' + name + '(');
	assert.ok(start >= 0, 'chat.html no longer defines ' + name + '()');
	const first = script.slice(start, script.indexOf('\n', start));
	if (/\}\s*$/.test(first) && !/\{\s*$/.test(first)) { return first; }
	const end = script.indexOf('\n  }', start);
	assert.ok(end >= 0, 'no closing brace found for ' + name + '()');
	return script.slice(start, end + 4);
}

let n = 0;
function test(name, fn) { fn(); n++; console.log('  ok - ' + name); }

// ---- the decision ---------------------------------------------------------------------------------
// eslint-disable-next-line no-new-func
const { auraState, auraDuration } = new Function(extract('auraState') + '\n' + extract('auraDuration') + '\nreturn { auraState, auraDuration };')();

test('STATE: off when idle or turned off; working while busy; waiting while busy but on the person', () => {
	assert.strictEqual(auraState(false, false, true), 'off', 'idle');
	assert.strictEqual(auraState(false, true, true), 'off', 'a leftover card with no run is not "waiting"');
	assert.strictEqual(auraState(true, false, true), 'working');
	assert.strictEqual(auraState(true, true, true), 'waiting');
	assert.strictEqual(auraState(true, false, false), 'off', 'turned off in settings');
	assert.strictEqual(auraState(true, true, false), 'off');
	assert.strictEqual(auraState(true, false, undefined), 'off', 'before the config arrives (a hoisted var) it stays off');
});

test('SPEED: one turn takes 1.6–3 s, longer for a bigger box but slower than the box grows', () => {
	assert.strictEqual(auraDuration(0, 0), 1.6);
	assert.strictEqual(auraDuration(100000, 100000), 3);
	assert.strictEqual(auraDuration(NaN, undefined), 1.6, 'an unmeasured box gets the floor, not NaN');
	const narrow = auraDuration(320, 90), wide = auraDuration(1200, 110);
	assert.ok(narrow < wide, 'a wider box takes longer per turn');
	assert.ok(wide / narrow < 1200 / 320, 'but not in proportion: the light moves faster round a wide box');
	assert.ok(narrow >= 1.6 && wide <= 3);
});

// ---- the switching ------------------------------------------------------------------------------------
/** syncAura with a stand-in page: the body's classes, the box's style, and the busy / parked state. */
function page(state) {
	const classes = new Set(), style = {}, env = Object.assign({ busy: false, parked: false, width: 700, height: 100, throws: false }, state);
	const document = { body: { classList: { toggle: (c, on) => { if (on) { classes.add(c); } else { classes.delete(c); } } } } };
	const composer = {
		getBoundingClientRect: () => { if (env.throws) { throw new Error('not laid out'); } return { width: env.width, height: env.height }; },
		style: { setProperty: (k, v) => { style[k] = v; } }
	};
	// eslint-disable-next-line no-new-func
	const sync = new Function('env', 'document', 'composer',
		'var auraEnabled = true; var auraShown = "off";\n'
		+ 'function busy(){ return env.busy; } function agentParked(){ return env.parked; }\n'
		+ extract('auraState') + '\n' + extract('auraDuration') + '\n' + extract('syncAura')
		+ '\nreturn { sync: syncAura, enable: (v) => { auraEnabled = v; }, shown: () => auraShown };')(env, document, composer);
	return Object.assign(sync, { env, classes, style });
}

test('SWITCH: busy turns the light on, a card stops it, the answer starts it again, the end turns it off', () => {
	const p = page({});
	p.sync();
	assert.deepStrictEqual([...p.classes], []);
	p.env.busy = true; p.sync();
	assert.deepStrictEqual([...p.classes], ['aura-working']);
	p.env.parked = true; p.sync();
	assert.deepStrictEqual([...p.classes], ['aura-waiting'], 'an approval card: still, not spinning');
	p.env.parked = false; p.sync();
	assert.deepStrictEqual([...p.classes], ['aura-working']);
	p.env.busy = false; p.sync();
	assert.deepStrictEqual([...p.classes], [], 'the run is over: nothing left on the box');
});

test('SWITCH: the speed is set from the box when the light starts, and not touched while it turns', () => {
	const p = page({ busy: true, width: 320, height: 90 });
	p.sync();
	assert.strictEqual(p.style['--aura-turn'], auraDuration(320, 90).toFixed(2) + 's');
	p.env.width = 1400; p.sync();
	assert.strictEqual(p.style['--aura-turn'], auraDuration(320, 90).toFixed(2) + 's', 'a change mid-turn would only apply on a restart: it is not made');
	p.env.parked = true; p.sync(); p.env.parked = false; p.sync();
	assert.strictEqual(p.style['--aura-turn'], auraDuration(1400, 90).toFixed(2) + 's', 'the next start measures the box again');
});

test('SWITCH: turned off in settings, nothing shows — and turning it back on mid-run shows it at once', () => {
	const p = page({ busy: true });
	p.enable(false); p.sync();
	assert.deepStrictEqual([...p.classes], []);
	p.enable(true); p.sync();
	assert.deepStrictEqual([...p.classes], ['aura-working']);
});

test('SWITCH: a page not laid out yet does not throw — a decoration must never stop the chat', () => {
	const p = page({ busy: true, throws: true });
	assert.doesNotThrow(() => p.sync());
	assert.strictEqual(p.shown(), 'off', 'nothing was half-applied');
	p.env.throws = false; p.sync();
	assert.deepStrictEqual([...p.classes], ['aura-working'], 'the next change draws it');
});

// ---- the stylesheet --------------------------------------------------------------------------------
/** The declarations of one rule, by its exact selector. */
// The aura's own block of the stylesheet: #composer has an earlier rule (its layout) that is not the aura's.
const auraCss = css.slice(css.indexOf('/* ---- the working aura'), css.indexOf('@media (forced-colors: active) { #composer') + 80);
function rule(selector) {
	const i = auraCss.indexOf('\n  ' + selector.trim() + ' {');   // at the start of a line, so "a, b {" is not "b {"
	assert.ok(i >= 0, 'no rule for ' + selector);
	return auraCss.slice(i, auraCss.indexOf('}', i));
}
test('CSS: the angle is a typed property, so it can be animated; the two rings turn on it together', () => {
	assert.match(css, /@property --aura-angle \{ syntax: '<angle>'; inherits: false; initial-value: 0deg; \}/);
	assert.match(css, /@keyframes aura-turn \{ to \{ --aura-angle: 360deg; \} \}/);
	assert.match(rule('#composer::before'), /conic-gradient\(from var\(--aura-angle\)/);
	assert.match(rule('#composer::after'), /conic-gradient\(from var\(--aura-angle\)/);
	assert.match(rule('body.aura-working #composer::before, body.aura-working #composer::after'), /animation: aura-turn var\(--aura-turn, 2\.4s\) linear infinite/);
});
test('CSS: the rings never take a click, and are cut to the edge so the box\'s inside is untouched', () => {
	const both = rule('#composer::before, #composer::after');
	assert.match(both, /pointer-events: none/);
	assert.match(both, /opacity: 0/, 'hidden unless a state class is on');
	assert.match(both, /mask: linear-gradient\(#000 0 0\) content-box, linear-gradient\(#000 0 0\); mask-composite: exclude/);
	assert.match(both, /-webkit-mask-composite: xor/);
	assert.match(rule('  #composer'), /position: relative/);
	assert.ok(!/#composer \{[^}]*(isolation|z-index)/.test(css), 'a stacking context on the box would trap the mode menu under the transcript');
});
test('CSS: waiting does not move; reduced motion never moves; high contrast draws no glow', () => {
	assert.ok(!/body\.aura-waiting[^{]*\{[^}]*animation/.test(css), 'the waiting ring animates');
	const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce) {\n    /* No motion'));
	assert.match(reduced.slice(0, 600), /body\.aura-working #composer::before, body\.aura-working #composer::after \{ animation: none; \}/);
	assert.match(css, /@media \(forced-colors: active\) \{ #composer::before, #composer::after \{ display: none; \} \}/);
});
test('CSS: colours come from the theme — progress while working, focus while waiting — never a fixed hue', () => {
	assert.match(rule('  #composer'), /--aura-color: var\(--vscode-progressBar-background, var\(--accent\)\)/);
	assert.match(rule('body.aura-waiting #composer::after'), /var\(--accent\)/);
	assert.ok(!/body\.aura-waiting #composer::before/.test(auraCss), 'waiting has a glow: it should read as paused, not busy');
	const colours = auraCss.replace(/linear-gradient\(#000 0 0\)/g, '');
	assert.ok(!/#[0-9a-f]{3,8}\b|rgba?\(/i.test(colours), 'a fixed colour in the aura');
});
test('CSS: thin and quiet — a 1px line on the border, a 2px soft edge, a short arc, no ring or white head of its own', () => {
	assert.match(rule('#composer::before, #composer::after'), /inset: -1px;/, 'both rings sit on the box\'s 1px border');
	assert.match(rule('#composer::after'), /padding: 1px;/, 'the line is a hairline');
	const glow = rule('#composer::before');
	assert.ok(Number((glow.match(/padding: ([\d.]+)px/) || [])[1]) <= 2, 'the soft edge is at most 2px wide');
	assert.ok(Number((glow.match(/filter: blur\(([\d.]+)px\)/) || [])[1]) <= 2, 'and blurred at most 2px');
	for (const sel of ['#composer::before', '#composer::after']) {
		const dark = rule(sel).match(/conic-gradient\(from var\(--aura-angle\), transparent 0deg (\d+)deg/);
		assert.ok(dark, sel + ': the gradient is clear round the box, not a ring of its own');
		assert.ok(360 - Number(dark[1]) <= 90, sel + ': the lit arc is at most a quarter turn');
	}
	assert.ok(!/--vscode-foreground/.test(auraCss), 'the arc is the theme colour, not mixed toward white');
	const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce) {\n    /* No motion'));
	assert.match(reduced.slice(0, 600), /body\.aura-working #composer::before \{ opacity: 0; \}/, 'reduced motion: a still border, no glow');
});
test('CSS: while the light turns the focus ring steps back — a hairline on an accent border is lost (desktop and browser)', () => {
	const desk = rule('body.aura-working #composer.focused');
	assert.match(desk, /box-shadow: none/);
	assert.match(desk, /border-color: color-mix\(in srgb, var\(--accent\) 40%, var\(--border\)\)/);
	const skin = fs.readFileSync(path.join(ROOT, '..', '..', 'web', 'ai-extension', 'skin', 'chat.css'), 'utf8');
	const i = skin.indexOf('body.lc-web.aura-working #composer:focus-within, body.lc-web.aura-working #composer.focused {');
	assert.ok(i >= 0, 'the browser skin\'s own focus halo (3px) is not stepped back while working');
	const block = skin.slice(i, skin.indexOf('}', i));
	assert.ok(!/0 0 0 3px/.test(block), 'the 3px halo is still drawn while working');
	assert.ok(skin.indexOf('body.lc-web #composer:focus-within, body.lc-web #composer.focused {') < i, 'it must come after the halo it steps back');
});

// ---- the wiring -------------------------------------------------------------------------------------
test('WIRING: every change of "busy" reaches the aura — the run starting and ending, a message on its way', () => {
	assert.match(extract('setStreaming'), /syncAura\(\);/);
	assert.match(extract('syncSendBtn'), /syncAura\(\);/);
	assert.match(script, /new MutationObserver\(function\(\)\{ if \(auraShown !== 'off' \|\| busy\(\)\) \{ syncAura\(\); \} \}\)\n\s*\.observe\(log, \{ childList: true, subtree: true, attributes: true, attributeFilter: \['class'\] \}\);/,
		'an approval card or a question appearing / answered must reach the aura without each card calling it');
	assert.match(script, /var auraEnabled = true;/, 'var, not let: syncSendBtn can reach syncAura before its line has run');
});
test('WIRING: the setting reaches the page on every config message, and the page obeys it', () => {
	assert.match(ext, /const workingAura = cfg\.get\('chat\.workingAura', true\) !== false;/);
	const posts = ext.match(/type: 'config'[\s\S]*?\}\);/g) || [];
	assert.ok(posts.length >= 2, 'both config messages found');
	for (const p of posts) { assert.match(p, /workingAura/, 'a config message without workingAura'); }
	assert.match(script, /if \(typeof m\.workingAura === 'boolean'\)\{ auraEnabled = m\.workingAura; syncAura\(\); \}/);
});
test('SETTING: on by default, and the user\'s own (a folder cannot switch it)', () => {
	const sections = Array.isArray(pkg.contributes.configuration) ? pkg.contributes.configuration : [pkg.contributes.configuration];
	const props = Object.assign({}, ...sections.map((s) => s.properties || {}));
	const s = props['levelcode.ai.chat.workingAura'];
	assert.ok(s, 'the setting is declared');
	assert.deepStrictEqual([s.type, s.default, s.scope], ['boolean', true, 'application']);
});

console.log('\nworkingAura: ' + n + ' tests passed.');
