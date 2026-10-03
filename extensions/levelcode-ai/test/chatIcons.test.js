/*---------------------------------------------------------------------------------------------
 *  Every icon anyone names is one the chat can draw — run: node test/chatIcons.test.js
 *
 *  WHY THIS EXISTS. media/chat.html draws its icons from an inline table (`IC`) through
 *  codicon(name), and a name the table lacks is not an error — it is PRINTED. The incident: the chat
 *  moved to an editor tab and its banner read "layout MOVED TO THE EDITOR <title>", the word where
 *  the glyph belongs. `globe` (the preview chip) and `history` (the recall and project-memory chips)
 *  had been printing into the timeline rail the same way.
 *
 *  Nothing failed, because the contract has two halves in two files and neither can see the other:
 *  the HOST names an icon as the `icon:` on a message (extension.js, agent.js) and the WEBVIEW owns
 *  the table. A name can be added on one side, or dropped from the other, and both still compile.
 *
 *  So this runs the REAL table through the REAL codicon() — lifted out of the shipped chat.html the
 *  way narrativeUi and sessionsUi lift theirs, not a copy that can drift — over every name written
 *  down on either side, and fails on any that comes back as text instead of an <svg>.
 *
 *  WHAT IT CANNOT SEE: a name computed at run time. A literal is the only thing a source reader can
 *  check, so a host `icon:` built from a variable is invisible here. §3 closes that from the
 *  webview's side, where it can be closed: every codicon() call must take its name from somewhere
 *  this file reads, so a new source of names fails until it is taught to this file.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'media', 'chat.html'), 'utf8');

let n = 0;
function test(name, fn) { fn(); n++; console.log('  ok - ' + name); }

// The webview's one inline <script> — the same slice narrativeUi compiles.
const scriptOpen = html.lastIndexOf('<script');
const scriptStart = html.indexOf('>', scriptOpen) + 1;
const scriptEnd = html.indexOf('</script>', scriptStart);
assert.ok(scriptOpen >= 0 && scriptEnd > scriptStart, 'no <script> block found in chat.html');
const script = html.slice(scriptStart, scriptEnd);

/** 1-based line of `index` in `text` — every failure below points at a line. */
const lineOf = (text, index) => text.slice(0, index).split('\n').length;
const scriptLine = (index) => lineOf(html, scriptStart + index);

/** Every match of a global `re` in `text`, each with exec()'s `index`. */
function all(re, text) {
	const out = [];
	let m;
	while ((m = re.exec(text))) { out.push(m); }
	return out;
}

// ---- The real table and the real lookup, lifted out of the shipped file ---------------------------

/** A one-line helper, whole: from `marker` to the end of its line. */
function oneLiner(marker) {
	const at = script.indexOf(marker);
	assert.ok(at >= 0, 'chat.html no longer has `' + marker + '`');
	return script.slice(at, script.indexOf('\n', at));
}
const tableAt = script.indexOf('const IC = {');
const tableEnd = script.indexOf('\n  };', tableAt);
assert.ok(tableAt >= 0 && tableEnd > tableAt, 'chat.html no longer defines the inline icon table `IC`');
let W;
try {
	// eslint-disable-next-line no-new-func
	W = new Function(
		oneLiner('function esc(') + '\n' + script.slice(tableAt, tableEnd + 5) + '\n' + oneLiner('function codicon(')
		+ '\nreturn { IC: IC, codicon: codicon };'
	)();
} catch (e) {
	assert.fail('could not lift `IC` and codicon() out of chat.html (' + String((e && e.message) || e)
		+ ') — this file expects esc() and codicon() to stay one-line helpers');
}
const SET = Object.keys(W.IC);

/** What the webview would put on screen for `name`: true for a glyph, false for the bug — the name, as text. */
const draws = (name) => Object.prototype.hasOwnProperty.call(W.IC, name) && /^<svg /.test(W.codicon(name));

// ---- Everywhere a name is written down ------------------------------------------------------------

/**
 * Every codicon(…) CALL in the script, as { arg, line } — `arg` is the text of its first argument.
 * Scanned outward from each call's own "(" rather than by tokenising the whole script: the script
 * holds regex literals (`/"/g`) that a string-tracking pass over the file would trip on.
 */
function codiconCalls() {
	const out = [];
	for (const m of all(/\bcodicon\(/g, script)) {
		const before = script.slice(script.lastIndexOf('\n', m.index) + 1, m.index);
		if (/^\s*\/\//.test(before) || /function\s+$/.test(before)) { continue; }   // a comment about it, or its definition
		const from = m.index + m[0].length;
		let depth = 1, i = from, str = '', end = -1;
		for (; i < script.length && depth > 0; i++) {
			const c = script[i];
			if (str) { if (c === str && script[i - 1] !== '\\') { str = ''; } continue; }
			if (c === "'" || c === '"' || c === '`') { str = c; }
			else if (c === '(' || c === '[' || c === '{') { depth++; }
			else if (c === ')' || c === ']' || c === '}') { depth--; }
			else if (c === ',' && depth === 1 && end < 0) { end = i; }   // codicon(name, cls): the name is the first argument
		}
		assert.strictEqual(depth, 0, 'unbalanced codicon( at chat.html:' + scriptLine(m.index));
		out.push({ arg: script.slice(from, end < 0 ? i - 1 : end).trim(), line: scriptLine(m.index) });
	}
	return out;
}

/** The string literals in an expression, minus any that sit inside a nested call's parentheses. */
function literals(expr) {
	let flat = expr, prev;
	do { prev = flat; flat = flat.replace(/\([^()]*\)/g, ''); } while (flat !== prev);
	return all(/'([^'\\]*)'|"([^"\\]*)"/g, flat).map((m) => m[1] !== undefined ? m[1] : m[2]);
}

/** Every name chat.html writes down itself, with where. */
function webviewNames() {
	const out = [];
	for (const c of codiconCalls()) {
		for (const name of literals(c.arg)) { out.push({ name, where: 'chat.html:' + c.line + '  codicon(' + c.arg + ')' }); }
	}
	// A name chosen first and drawn a line later: `icon = ok ? 'check-circle' : 'circle-slash'; … codicon(icon)`.
	for (const m of all(/\bicon = ([^;\n]+);/g, script)) {
		for (const name of literals(m[1])) { out.push({ name, where: 'chat.html:' + scriptLine(m.index) + '  icon = ' + m[1] }); }
	}
	// A name in the markup, drawn at startup by the [data-ico] sweep.
	for (const m of all(/data-ico="([^"]*)"/g, html)) {
		out.push({ name: m[1], where: 'chat.html:' + lineOf(html, m.index) + '  ' + m[0] });
	}
	return out;
}

// Host files whose `icon:` fields are NOT messages to this webview, and why. Everything else is
// checked: an `icon:` this file cannot place fails, rather than passing because nobody looked.
const NOT_CHAT = new Map([
	['sketch/agentCatalog.js', 'palette groups for the Sketch canvas (media/sketch.html), which shows their label and draws no glyph'],
]);

/** Every .js file the extension ships, relative to its root. The webview (media/) and the tests are not host code. */
function hostFiles(dir, rel) {
	let out = [];
	for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
		const r = rel ? rel + '/' + e.name : e.name;
		if (e.isDirectory()) {
			if (!['test', 'media', 'node_modules'].includes(e.name)) { out = out.concat(hostFiles(path.join(dir, e.name), r)); }
		} else if (e.name.endsWith('.js')) { out.push(r); }
	}
	return out.sort();
}

/** Every `icon: '<name>'` literal in host code, with where. */
function hostNames() {
	const out = [];
	for (const rel of hostFiles(ROOT, '')) {
		if (NOT_CHAT.has(rel)) { continue; }
		const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
		for (const m of all(/\bicon:\s*(['"])([^'"\n]*)\1/g, src)) {
			out.push({ name: m[2], where: rel + ':' + lineOf(src, m.index) + '  ' + m[0] });
		}
	}
	return out;
}

/** Fail with EVERY undrawable name at once — one run should state the whole problem, not its first line. */
function assertDrawn(found, who) {
	const bad = found.filter((f) => !draws(f.name));
	assert.ok(!bad.length,
		who + ' an icon the inline set does not define — the chat would PRINT the name where the glyph belongs:\n'
		+ bad.map((f) => '    "' + f.name + '"  <-  ' + f.where).join('\n')
		+ '\n  Add it to `IC` in media/chat.html (viewBox + path from @vscode/codicons), or use one the set has: '
		+ SET.join(', '));
}

// ---- 1. The set ---------------------------------------------------------------------------------

test('SET: every entry is something codicon() can draw', () => {
	// narrativeUi proves the table PARSES. This is the next thing a bad paste breaks: an entry that is
	// valid JavaScript and an empty picture.
	assert.ok(SET.length > 0, 'the inline icon table is empty');
	for (const name of SET) {
		const i = W.IC[name];
		assert.match(String(i.vb), /^[\d.]+( [\d.]+){3}$/, name + ' has no usable viewBox');
		assert.match(String(i.p), /^<\w[\s\S]*>$/, name + ' has no markup to draw');
		assert.ok(draws(name), name + ' is in the table but codicon() does not draw it');
	}
});

// ---- 2. Both sides of the contract ---------------------------------------------------------------

test('WEBVIEW: every name chat.html writes down is in the set', () => {
	assertDrawn(webviewNames(), 'chat.html names');
});

test('HOST: every icon the host puts on a message is in the set', () => {
	// The half the webview cannot see. `layout`, `globe` and `history` all came through here.
	assertDrawn(hostNames(), 'the host posts');
});

// ---- 3. The limits of a source reader ------------------------------------------------------------

// A call that does not spell its name out takes it from somewhere else. Each such shape is listed
// with where that somewhere is read above. (`m.icon || 'sync'` needs no entry: it spells its default,
// and `m.icon` is the host's half.)
const INDIRECT = new Map([
	['icon', 'a local set from literals a line above (webviewNames), or the host\'s `icon:` handed to addAgentLine (hostNames)'],
	["s.getAttribute('data-ico')", 'a data-ico="…" attribute in the markup (webviewNames)'],
]);

test('SHAPE: no codicon() call takes its name from somewhere this file does not read', () => {
	const unread = codiconCalls().filter((c) => !literals(c.arg).length && !INDIRECT.has(c.arg));
	assert.ok(!unread.length,
		'codicon() is called with a name this test cannot trace to a literal:\n'
		+ unread.map((c) => '    chat.html:' + c.line + '  codicon(' + c.arg + ')').join('\n')
		+ '\n  Spell the name in the call, or add the shape to INDIRECT and read its names in webviewNames()/hostNames().');
});

test('EXEMPT: a host file excused from the check really is not talking to the chat', () => {
	// An exemption is where a guard goes quiet, so each one has to keep earning it.
	for (const [rel, why] of NOT_CHAT) {
		const file = path.join(ROOT, rel);
		assert.ok(fs.existsSync(file), rel + ' is exempt but no longer exists — drop the exemption');
		const src = fs.readFileSync(file, 'utf8');
		assert.ok(/\bicon:/.test(src), rel + ' is exempt but names no icon any more — drop the exemption');
		assert.ok(!/\bpost(Message)?\(/.test(src), rel + ' is exempt as "' + why + '" but now posts messages — check its icons instead');
	}
});

test('ALIVE: the scans found what they exist to check', () => {
	// Every assertion above passes on an empty list, so a scan that silently stopped matching — a
	// renamed helper, a restyled literal — would turn this whole file into a no-op.
	assert.ok(codiconCalls().length > 0, 'found no codicon() call in chat.html');
	assert.ok(hostNames().length > 0, 'found no `icon:` literal in any host file');
	// …and the host scan is reading the field the webview draws: both renderers take `m.icon`.
	assert.match(script, /addAgentLine\(m\.icon,/, 'agentTool no longer hands m.icon to the timeline — hostNames() reads the wrong field');
	assert.match(script, /\bcodicon\(m\.icon\b/, 'the banner no longer draws m.icon — hostNames() reads the wrong field');
});

console.log('chatIcons: ' + n + ' tests passed');
