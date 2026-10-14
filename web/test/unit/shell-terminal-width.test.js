/*---------------------------------------------------------------------------------------------
 *  LevelCode Shell terminal: cell widths - run: node web/test/unit/shell-terminal-width.test.js
 *
 *  The line editor puts the cursor by counting cells. A width that is off by one is a cursor that sits on the wrong
 *  cell for the rest of the line, so the table is xterm's own (Unicode 11, the workbench's default), derived from the
 *  addon. Pinned here: the widths that were measured in the release build with a cursor-position report, and, when an
 *  xterm checkout is around, that the checked-in table still equals what the addon says.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

const assert = require('assert');
const path = require('path');
const { pathToFileURL } = require('url');

const dir = path.join(__dirname, '..', '..', 'shell', 'src', 'terminal');
const { cpWidth, strWidth, stripEscapes } = require(path.join(dir, 'width.js'));
const table = require(path.join(dir, 'width-table.json'));
const { needXterm } = require('./helpers/shell-terminal-xterm');

const queue = [];
const test = (name, fn) => queue.push([name, fn]);

test('the widths measured in the release build with a cursor-position report', () => {
	const measured = {
		'a': 1, '你': 2, '\u{1f680}': 2, '✨': 2, 'é': 1, 'e\u0301': 1, '\u{1f468}\u200d\u{1f469}\u200d\u{1f467}': 6,
		'\u{1f1fa}\u{1f1f8}': 2, 'a\u200bb': 2, '⠋': 1, '┌': 1, 'ｱ': 1, 'Ａ': 2, '❤': 1, '❤\ufe0f': 1,
		'✓': 1, '1\ufe0f\u20e3': 1, '\u{1f44d}\u{1f3fd}': 4, '★': 1, '→': 1, '…': 1, '•': 1, ' ': 1, '。': 2, '한': 2,
	};
	for (const [s, w] of Object.entries(measured)) { assert.strictEqual(strWidth(s), w, JSON.stringify(s)); }
});

test('controls, DEL and C1 take no cell; ASCII and Latin take one', () => {
	for (let cp = 0; cp < 0x20; cp++) { assert.strictEqual(cpWidth(cp), 0, String(cp)); }
	for (let cp = 0x7f; cp < 0xa0; cp++) { assert.strictEqual(cpWidth(cp), 0, String(cp)); }
	for (let cp = 0x20; cp < 0x7f; cp++) { assert.strictEqual(cpWidth(cp), 1, String(cp)); }
	assert.strictEqual(cpWidth(0xe9), 1);
});

test('stripEscapes removes SGR and OSC so a coloured prompt is measured by what shows', () => {
	assert.strictEqual(stripEscapes('\x1b[1;34mproj\x1b[0m $ '), 'proj $ ');
	assert.strictEqual(stripEscapes('\x1b]633;A\x1b\\$ \x1b]633;B\x07'), '$ ');
	assert.strictEqual(strWidth(stripEscapes('\x1b[31m你\x1b[0m')), 2);
});

test('the table is sorted, disjoint and in range, so the binary search is sound', () => {
	for (const list of [table.zero, table.wide]) {
		let prev = -1;
		for (const [lo, hi] of list) {
			assert.ok(lo <= hi && lo > prev && hi <= 0x10ffff, JSON.stringify([lo, hi, prev]));
			prev = hi;
		}
	}
	assert.strictEqual(table.version, '11');
});

test('the checked-in table is what the xterm Unicode 11 addon computes (when an xterm checkout is found)', async () => {
	const xt = needXterm('the width table against the Unicode 11 addon');
	if (!xt) { return; }
	const gen = await import(pathToFileURL(path.join(dir, 'gen-width.mjs')).href);
	const fresh = gen.deriveTable(xt.addonFile);
	assert.deepStrictEqual(fresh, table, 'run: node web/shell/src/terminal/gen-width.mjs <addon-unicode11.js> --write');
	// and the module agrees with the addon code point by code point on every plane that has a width
	const { Terminal } = xt;
	const t = new Terminal({ cols: 80, rows: 2, allowProposedApi: true });
	t.loadAddon(new xt.Unicode11Addon());
	t.unicode.activeVersion = '11';
	let checked = 0;
	for (let cp = 0; cp <= 0x10ffff; cp += 7) {
		if (cp >= 0xd800 && cp <= 0xdfff) { continue; }
		assert.strictEqual(cpWidth(cp), t._core.unicodeService.wcwidth(cp), 'U+' + cp.toString(16));
		checked++;
	}
	assert.ok(checked > 100000);
});

test('the invisible characters the editor keeps (variation selectors, ZWNJ, ZWJ, the keycap) take no cell, as in xterm.js: the cursor ends where the width says (when an xterm checkout is found)', async () => {
	const kept = ['\ufe0f', '\ufe0e', '\u200c', '\u200d', '\u20e3'];
	for (const ch of kept) { const cp = /** @type {number} */ (ch.codePointAt(0)); assert.strictEqual(cpWidth(cp), 0, 'U+' + cp.toString(16)); }
	const xt = needXterm('the kept invisible characters against xterm.js');
	if (!xt) { return; }
	const { Terminal } = xt;
	const samples = [
		'\u2714\ufe0f', '\u2764\ufe0f', '1\ufe0f\u20e3', '\u{1f468}\u200d\u{1f469}\u200d\u{1f467}', '\u2764\ufe0f\u200d\u{1f525}', '\u{1f44d}\u{1f3fd}',
		'\u0645\u06cc\u200c\u0631\u0648\u0645', '\u0915\u094d\u200d\u0937', '\u0995\u09cd\u200c\u09b7', 'a\u2714\ufe0e b',
		'\u2714\ufe0f done.md', 'ab\u{1f468}\u200d\u{1f469}cd',
	];
	for (const text of samples) {
		const t = new Terminal({ cols: 80, rows: 2, allowProposedApi: true });
		t.loadAddon(new xt.Unicode11Addon());
		t.unicode.activeVersion = '11';
		await new Promise((r) => t.write(text, r));
		assert.strictEqual(t.buffer.active.cursorX, strWidth(text), JSON.stringify(text));
		assert.strictEqual(t.buffer.active.getLine(0).translateToString(true), text, 'and the row has the text: nothing was lost or moved');
		t.dispose();
	}
});

test('without an xterm.js the real-xterm halves say SKIPPED, loudly, and LEVELCODE_REQUIRE_XTERM=1 makes that a failure', () => {
	const { spawnSync } = require('child_process');
	const helper = path.join(__dirname, 'helpers', 'shell-terminal-xterm.js');
	const code = 'const x = require(' + JSON.stringify(helper) + ').needXterm("the thing"); console.log("RESULT " + (x === null ? "null" : "found"));';
	const run = (env) => spawnSync(process.execPath, ['-e', code], { encoding: 'utf8', env: Object.assign({}, process.env, { LEVELCODE_XTERM_DIR: path.join(__dirname, 'no-such-folder') }, env) });
	const skipped = run({ LEVELCODE_REQUIRE_XTERM: '' });
	assert.strictEqual(skipped.status, 0);
	assert.ok(/RESULT null/.test(skipped.stdout));
	assert.ok(/SKIPPED: the real-xterm half of "the thing" did not run/.test(skipped.stdout), skipped.stdout);
	assert.ok(/::warning::SKIPPED/.test(skipped.stdout), 'and an annotation, for CI');
	const required = run({ LEVELCODE_REQUIRE_XTERM: '1' });
	assert.notStrictEqual(required.status, 0);
	assert.ok(/LEVELCODE_REQUIRE_XTERM=1, and no xterm.js was found for: the thing/.test(required.stderr), required.stderr);
	// LEVELCODE_XTERM_DIR is the only place looked in when it is set: a wrong one is not quietly replaced by another
	const wrong = run({ LEVELCODE_REQUIRE_XTERM: '' });
	assert.ok(/RESULT null/.test(wrong.stdout));
});

let finished = false;
// a test that awaits something that never settles leaves nothing to keep the process alive: it would exit 0, silently
process.on('exit', (code) => { if (code === 0 && !finished) { console.error('the tests did not finish: one of them waits for something that never happens'); process.exitCode = 1; } });
(async () => {
	let n = 0;
	for (const [name, fn] of queue) { await fn(); n++; console.log('  ok - ' + name); }
	finished = true;
	console.log(`\n${n} tests passed`);
})().catch((e) => { console.error(e); process.exit(1); });
