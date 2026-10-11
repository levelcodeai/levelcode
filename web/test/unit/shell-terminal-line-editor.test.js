/*---------------------------------------------------------------------------------------------
 *  LevelCode Shell terminal: the line editor - run: node web/test/unit/shell-terminal-line-editor.test.js
 *
 *  The editor draws by bytes, so what is asserted here is the SCREEN and the CURSOR of a terminal model
 *  (helpers/shell-terminal-vt.js, itself checked against the real xterm.js: wrap pending in the last column, wide
 *  characters, reflow that leaves the cursor's own line alone), never the bytes.
 *
 *    - the keys: editing, the kill ring, words, history with the draft, multi-line buffers, paste, continuation,
 *      Ctrl+C / Ctrl+D / Ctrl+L, Tab completion and a late answer to it;
 *    - the cursor lands on a newline of a multi-line buffer without throwing (the reference editor crashed there);
 *    - a paste over the cap is REJECTED with a notice, not cut;
 *    - layout at the edges: a full row, wide characters, combining marks and joined emoji, tabs, a prompt with colours;
 *    - resize, and a buffer taller than the panel;
 *    - a differential: seeded random sessions at three widths, after EVERY step the screen and the cursor equal what a
 *      terminal shows for the same text written once, from scratch. Zero mismatches, zero crashes.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

const assert = require('assert');
const path = require('path');

const dir = path.join(__dirname, '..', '..', 'shell', 'src', 'terminal');
const { LineEditor } = require(path.join(dir, 'line-editor.js'));
const { createInputParser } = require(path.join(dir, 'input-parser.js'));
const { strWidth, stripEscapes } = require(path.join(dir, 'width.js'));
const { VT } = require('./helpers/shell-terminal-vt');
const { findXterm } = require('./helpers/shell-terminal-xterm');

const queue = [];
const test = (name, fn) => queue.push([name, fn]);
const E = '\x1b';
const plainPrompt = '$ ';
const colourPrompt = E + '[1;34mproj/src' + E + '[0m $ ';

/**
 * An editor on a model terminal.
 * @param {{ cols?: number, rows?: number, prompt?: string, history?: string[], isComplete?: (s: string) => { complete: boolean }, complete?: any, maxPaste?: number, marks?: any }} [o]
 */
function session(o = {}) {
	const cols = o.cols || 40;
	const rows = o.rows || 12;
	const vt = new VT(cols, rows);
	const parser = createInputParser({ maxPaste: o.maxPaste });
	const submitted = [];
	const writes = [];
	const ed = new LineEditor({
		write: (s) => { writes.push(s); vt.write(s); },
		prompt: () => (o.prompt === undefined ? plainPrompt : o.prompt),
		columns: cols,
		rows,
		history: () => o.history || [],
		isComplete: o.isComplete,
		complete: o.complete,
		onSubmit: (src) => { submitted.push(src); },
		onEof: () => { submitted.push('<eof>'); },
		maxPaste: o.maxPaste,
		marks: o.marks,
	});
	ed.start();
	const send = (...chunks) => { for (const c of chunks) { ed.input(parser.feed(c)); } };
	return { vt, ed, send, submitted, writes, cols, rows };
}
const wait = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const key = {
	left: E + '[D', right: E + '[C', up: E + '[A', down: E + '[B', home: E + '[H', end: E + '[F', del: E + '[3~',
	ctrlLeft: E + '[1;5D', ctrlRight: E + '[1;5C',
};
const paste = (s) => E + '[200~' + s + E + '[201~';

/* ------------------------------------------------------------------------------------------------ the keys */

test('typing, Backspace, arrows, Home, End and Delete edit the line and the cursor follows', () => {
	const s = session();
	s.send('echo hello wor', '\x7f', 'rd');
	assert.deepStrictEqual(s.vt.text(), ['$ echo hello word']);
	s.send(key.left, key.left, 'x');
	assert.deepStrictEqual(s.vt.text(), ['$ echo hello woxrd']);
	s.send(key.home, '>');
	assert.deepStrictEqual(s.vt.text(), ['$ >echo hello woxrd']);
	assert.deepStrictEqual(s.vt.cursor(), { row: 0, col: 3 });
	s.send(key.end, key.left, key.del);
	assert.deepStrictEqual(s.vt.text(), ['$ >echo hello woxr']);
	assert.strictEqual(s.vt.cursor().col, 2 + '>echo hello woxr'.length);
});

test('the kill ring and the words: Ctrl+A/E/U/K/W/Y, Alt+B/F/D, Option+Backspace, Ctrl+Left/Right', () => {
	const s = session();
	s.send('one two three');
	s.send('\x17');                                      // Ctrl+W (and Option+Backspace): back to the blank
	assert.strictEqual(s.ed.text(), 'one two ');
	s.send('\x01', E + 'f');                             // Home, Alt+F
	assert.strictEqual(s.ed.cur, 3);
	s.send(E + 'd');                                     // Alt+D kills the word ahead
	assert.strictEqual(s.ed.text(), 'one ');
	s.send('\x05', '\x15');                              // End, Ctrl+U
	assert.strictEqual(s.ed.text(), '');
	s.send('\x19');                                      // Ctrl+Y yanks what Ctrl+U killed
	assert.strictEqual(s.ed.text(), 'one ');
	s.send('two', key.ctrlLeft, key.ctrlLeft);
	assert.strictEqual(s.ed.cur, 0);
	s.send(key.ctrlRight, E + 'b');
	assert.strictEqual(s.ed.cur, 0);
	s.send('\x0b');                                      // Ctrl+K at the start kills the line
	assert.strictEqual(s.ed.text(), '');
	s.send('foo.bar-baz', E + '\x7f');                   // Alt+Backspace: back to the non-word character
	assert.strictEqual(s.ed.text(), 'foo.bar-');
	s.send('\x08');                                      // Ctrl+Backspace / Ctrl+H: the same rule, the separator and the word before it
	assert.strictEqual(s.ed.text(), 'foo.');
	s.send('\x14');                                      // Ctrl+T transposes the last two characters
	assert.strictEqual(s.ed.text(), 'fo.o');
});

test('Enter submits the line and leaves the cursor on a fresh row; an empty line is not an error', () => {
	const s = session();
	s.send('ls -la', '\r');
	assert.deepStrictEqual(s.submitted, ['ls -la']);
	assert.deepStrictEqual(s.vt.cursor(), { row: 1, col: 0 });
	assert.deepStrictEqual(s.vt.text(), ['$ ls -la']);
	// the editor takes no input until the host starts the next prompt
	s.send('abc');
	assert.deepStrictEqual(s.vt.text(), ['$ ls -la']);
	s.vt.write('output\r\n');
	s.ed.start();
	assert.deepStrictEqual(s.vt.text(), ['$ ls -la', 'output', '$']);
	s.send('\r');
	assert.deepStrictEqual(s.submitted, ['ls -la', '']);
});

test('history: Up and Down walk it, the line being typed is kept, and Down past the end brings it back', () => {
	const s = session({ history: ['ls', 'cat a.txt'] });
	s.send('draft');
	s.send(key.up);
	assert.strictEqual(s.ed.text(), 'cat a.txt');
	s.send(key.up);
	assert.strictEqual(s.ed.text(), 'ls');
	s.send(key.up);
	assert.strictEqual(s.ed.text(), 'ls', 'the oldest entry stays');
	s.send(key.down, key.down);
	assert.strictEqual(s.ed.text(), 'draft');
	s.send(key.down);
	assert.strictEqual(s.ed.text(), 'draft');
	assert.deepStrictEqual(s.vt.text(), ['$ draft']);
	s.send('\x10', '\x0e');                              // Ctrl+P / Ctrl+N
	assert.strictEqual(s.ed.text(), 'draft');
});

test('a history entry is cleaned like typing: an escape stored in it is not written back to the terminal', () => {
	const s = session({ history: ['echo ' + E + '[6n' + E + ']0;t\x07 hi'] });
	s.send(key.up);
	assert.strictEqual(s.ed.text(), 'echo [6n]0;t hi');
	const written = s.writes.join('');
	assert.ok(!written.includes(E + '[6n') && !written.includes(E + ']0;'), 'no stored escape reaches the screen');
});

test('the history is live: a line another terminal added while this prompt waited is the first Up', () => {
	const hist = ['ls'];
	const s = session({ history: hist });
	hist.push('cat a.txt');                                // added from another terminal
	s.send(key.up);
	assert.strictEqual(s.ed.text(), 'cat a.txt');
	hist.length = 0;                                       // cleared while one is shown
	s.send(key.down);
	assert.strictEqual(s.ed.text(), '', 'and Down finds the line that was being typed');
});

test('a multi-line buffer: Up and Down move between its lines before they touch the history', () => {
	const s = session({ history: ['old'] });
	s.send(paste('first\nsecond\nthird'));
	assert.deepStrictEqual(s.vt.text(), ['$ first', '> second', '> third']);
	s.send(key.up);
	assert.deepStrictEqual(s.vt.cursor(), { row: 1, col: 2 + 5 });          // same column in the line above
	s.send(key.up, key.up);
	assert.strictEqual(s.ed.text(), 'old', 'from the first line Up is the history');
	s.send(key.down);
	assert.strictEqual(s.ed.text(), 'first\nsecond\nthird');
});

/* ------------------------------------------------------------------------------------------------ newlines, paste, continuation */

test('the cursor can stand on a newline of a multi-line buffer (the reference editor threw there)', () => {
	for (const [pasted, moves] of [
		['a\nb', [key.left, key.left]],
		['a\n', [key.left]],
		['x\n\ny', [key.left, key.left, key.end]],
		['ab\ncd', [key.left, key.left, key.left, key.home, key.end]],
		['a\nb\nc', [key.home, key.left, key.left, key.right, key.right]],
	]) {
		const s = session();
		s.send(paste(pasted), ...moves, 'Z');
		const lines = s.vt.text();
		assert.ok(lines.length >= 2 && lines.join('\n').includes('Z'), JSON.stringify([pasted, lines]));
	}
	const s = session();
	s.send(paste('a\nb'), key.left, key.left);
	assert.deepStrictEqual(s.vt.cursor(), { row: 0, col: 3 }, 'before the newline: the end of the first line');
	s.send(key.left);
	assert.deepStrictEqual(s.vt.cursor(), { row: 0, col: 2 });
	s.send('X');
	assert.deepStrictEqual(s.vt.text(), ['$ Xa', '> b']);
});

test('bracketed paste inserts and never submits; continuation lines show the continuation prompt', () => {
	const s = session();
	s.send(paste('echo a\r\necho b\recho c'));
	assert.strictEqual(s.ed.text(), 'echo a\necho b\necho c');
	assert.deepStrictEqual(s.submitted, []);
	assert.deepStrictEqual(s.vt.text(), ['$ echo a', '> echo b', '> echo c']);
	s.send(paste('\x1b[31mred\x07\x00'));
	assert.strictEqual(s.ed.text(), 'echo a\necho b\necho c[31mred', 'controls are not inserted');
});

test('an unfinished command continues on the next line, and runs as one', () => {
	const s = session({ isComplete: (src) => ({ complete: (src.match(/"/g) || []).length % 2 === 0 }) });
	s.send('echo "a', '\r');
	assert.deepStrictEqual(s.submitted, []);
	assert.deepStrictEqual(s.vt.text(), ['$ echo "a', '>']);
	s.send('b"', '\r');
	assert.deepStrictEqual(s.submitted, ['echo "a\nb"']);
	assert.deepStrictEqual(s.vt.text(), ['$ echo "a', '> b"']);
	assert.deepStrictEqual(s.vt.cursor(), { row: 2, col: 0 });
});

test('a paste over the cap is rejected with a notice: nothing is inserted, nothing is cut', () => {
	const s = session({ maxPaste: 20, cols: 100 });
	s.send('keep');
	s.send(paste('x'.repeat(20)));
	assert.strictEqual(s.ed.text(), 'keep' + 'x'.repeat(20), 'exactly the cap is accepted');
	s.send('\x15');
	s.send('keep');
	s.send(paste('y'.repeat(21)));
	assert.strictEqual(s.ed.text(), 'keep', 'one over: the buffer is untouched');
	const screen = s.vt.text().join('\n');
	assert.ok(/paste not inserted: 21 characters is over the limit of 20/.test(screen), screen);
	assert.ok(!screen.includes('yyyy'));
	// the prompt is back under the notice, with the cursor after what was typed
	assert.strictEqual(s.vt.text()[s.vt.cursor().row], '$ keep');
	s.send('!');
	assert.strictEqual(s.ed.text(), 'keep!');
});

test('Ctrl+C at the prompt abandons the line; Ctrl+D is EOF on an empty line and Delete otherwise', () => {
	const s = session();
	s.send('abc', '\x03');
	assert.strictEqual(s.ed.text(), '');
	assert.deepStrictEqual(s.vt.text(), ['$ abc^C', '$']);
	s.send('xy', key.left, '\x04');
	assert.strictEqual(s.ed.text(), 'x', 'Ctrl+D with text deletes the character under the cursor');
	assert.deepStrictEqual(s.submitted, []);
	s.send('\x15', '\x04');
	assert.deepStrictEqual(s.submitted, ['<eof>']);
});

test('the shell-integration marks are written with the first draw of a prompt and again after Ctrl+L, not on every key', () => {
	const marks = { start: E + ']633;A' + E + '\\', end: E + ']633;B' + E + '\\' };
	const s = session({ marks });
	const count = (sub) => s.writes.join('').split(sub).length - 1;
	assert.strictEqual(count(marks.start), 1);
	assert.strictEqual(count(marks.end), 1);
	assert.ok(s.writes[0].indexOf(marks.start) < s.writes[0].indexOf('$ ') && s.writes[0].indexOf('$ ') < s.writes[0].indexOf(marks.end));
	s.send('abc', key.left, 'x', '\x7f');
	assert.strictEqual(count(marks.start), 1, 'typing does not repeat them');
	s.send('\x0c');
	assert.strictEqual(count(marks.start), 2, 'Ctrl+L draws a prompt again');
	assert.deepStrictEqual(s.vt.text(), ['$ abc']);
});

test('Ctrl+L clears the screen and puts the prompt and the line at the top', () => {
	const s = session();
	s.vt.write('older output\r\nmore\r\n');
	s.ed.start();
	s.send('abc', '\x0c');
	assert.deepStrictEqual(s.vt.text(), ['$ abc']);
	assert.deepStrictEqual(s.vt.cursor(), { row: 0, col: 5 });
});

/* ------------------------------------------------------------------------------------------------ layout at the edges */

test('wide characters: the cursor counts cells and one Backspace removes one character', () => {
	const s = session();
	s.send('你好a');
	assert.strictEqual(s.vt.cursor().col, 2 + 2 + 2 + 1);
	s.send(key.left, key.left);
	assert.strictEqual(s.vt.cursor().col, 2 + 2);
	s.send('\x7f');
	assert.strictEqual(s.ed.text(), '好a');
	assert.deepStrictEqual(s.vt.text(), ['$ 好a']);
});

test('combining marks and joined emoji are one step for the cursor and one Backspace', () => {
	const s = session();
	s.send('e\u0301x');
	assert.strictEqual(s.vt.cursor().col, 2 + 1 + 1);
	s.send(key.left, key.left);
	assert.strictEqual(s.ed.cur, 0, 'one Left over the letter and its accent');
	s.send(key.end, '\x7f', '\x7f');
	assert.strictEqual(s.ed.text(), '', 'Backspace removes the accent with its letter');
	const family = '\u{1f468}\u200d\u{1f469}\u200d\u{1f467}';
	s.send(family + 'a');
	assert.strictEqual(s.vt.cursor().col, 2 + 6 + 1);
	s.send(key.left, key.left);
	assert.strictEqual(s.ed.cur, 0, 'the whole family is one step');
	s.send(key.end, '\x7f', '\x7f');
	assert.strictEqual(s.ed.text(), '');
});

test('a line that fills a row exactly puts the cursor on the next row, and Enter leaves no blank row', () => {
	const s = session({ cols: 20 });
	s.send('abcdefghijklmnopqr');                           // 2 + 18 = 20
	assert.deepStrictEqual(s.vt.text(), ['$ abcdefghijklmnopqr']);
	assert.deepStrictEqual(s.vt.cursor(), { row: 1, col: 0 }, 'a row of its own, not pending on the first');
	s.send('s');
	assert.deepStrictEqual(s.vt.text(), ['$ abcdefghijklmnopqr', 's']);
	s.send('\x7f', '\x7f');
	assert.deepStrictEqual(s.vt.text(), ['$ abcdefghijklmnopq']);
	s.send('r', '\r');
	assert.deepStrictEqual(s.submitted, ['abcdefghijklmnopqr']);
	assert.deepStrictEqual(s.vt.cursor(), { row: 1, col: 0 });
	s.vt.write('out\r\n');
	assert.deepStrictEqual(s.vt.text(), ['$ abcdefghijklmnopqr', 'out'], 'the output starts on the row below the line');
});

test('a long line wraps; editing in the middle of the wrapped part keeps text and cursor right', () => {
	const s = session({ cols: 20 });
	s.send('abcdefghijklmnopqrstuvwxyz0123456789');
	assert.deepStrictEqual(s.vt.text(), ['$ abcdefghijklmnopqr', 'stuvwxyz0123456789']);
	assert.deepStrictEqual(s.vt.cursor(), { row: 1, col: 18 });
	s.send(key.left.repeat(25), '_');
	assert.deepStrictEqual(s.vt.text(), ['$ abcdefghijk_lmnopq', 'rstuvwxyz0123456789']);
	assert.deepStrictEqual(s.vt.cursor(), { row: 0, col: 2 + 'abcdefghijk_'.length });
	s.send('\x7f'.repeat(30));
	assert.deepStrictEqual(s.vt.text(), ['$ lmnopqrstuvwxyz012', '3456789']);
	assert.deepStrictEqual(s.vt.cursor(), { row: 0, col: 2 });
});

test('a wide character that does not fit moves to the next row and the cursor follows it', () => {
	const s = session({ cols: 10 });
	s.send('abcdefgh');                                      // 2 + 8 = 10: full
	s.send('你');                                        // does not fit on the first row
	assert.deepStrictEqual(s.vt.text(), ['$ abcdefgh', '你']);
	assert.deepStrictEqual(s.vt.cursor(), { row: 1, col: 2 });
	s.send(key.left);
	assert.deepStrictEqual(s.vt.cursor(), { row: 1, col: 0 });
	s.send(key.left);
	assert.deepStrictEqual(s.vt.cursor(), { row: 0, col: 9 });
});

test('a tab (it can only arrive in a paste: the key is completion) is drawn as spaces to the next multiple of 8', () => {
	const s = session({ cols: 30 });
	s.send(paste('a\tb'));
	assert.deepStrictEqual(s.vt.text(), ['$ a     b']);                 // a at col 2, the tab fills cols 3 to 7, b at col 8
	assert.strictEqual(s.vt.cursor().col, 9);
	s.send(key.left);
	assert.strictEqual(s.vt.cursor().col, 8, 'before the b, after the tab');
	s.send(key.left);
	assert.strictEqual(s.vt.cursor().col, 3, 'before the tab, right after the a');
	s.send(key.del);
	assert.deepStrictEqual(s.vt.text(), ['$ ab']);
	// at the edge a tab wraps like the spaces it is
	const t = session({ cols: 10 });
	t.send(paste('abcdefg\th'));
	assert.deepStrictEqual(t.vt.text(), ['$ abcdefg', '      h'], 'one space in the last cell, the other six on the next row');
});

test('a prompt with colours is measured by what shows', () => {
	const s = session({ prompt: colourPrompt, cols: 30 });
	assert.deepStrictEqual(s.vt.cursor(), { row: 0, col: strWidth(stripEscapes(colourPrompt)) });
	s.send('x'.repeat(30));
	assert.deepStrictEqual(s.vt.text(), ['proj/src $ ' + 'x'.repeat(19), 'x'.repeat(11)]);
	assert.deepStrictEqual(s.vt.cursor(), { row: 1, col: 11 });
});

/* ------------------------------------------------------------------------------------------------ resize and tall buffers */

test('resize: a narrower panel is redrawn from the first row of the editing region, and editing carries on', () => {
	const s = session({ cols: 40 });
	const second = 'second line is a good deal longer than the first one';
	s.send(paste('first line\n' + second));
	assert.deepStrictEqual(s.vt.text(), ['$ first line', ('> ' + second).slice(0, 40), ('> ' + second).slice(40)]);
	s.vt.resize(30, 12);
	s.ed.resize(30, 12);
	assert.deepStrictEqual(s.vt.text(), ['$ first line', ('> ' + second).slice(0, 30), ('> ' + second).slice(30)]);
	assert.deepStrictEqual(s.vt.cursor(), { row: 2, col: ('> ' + second).length - 30 });
	s.send('Z');
	assert.deepStrictEqual(s.vt.text(), ['$ first line', ('> ' + second).slice(0, 30), ('> ' + second).slice(30) + 'Z']);
});

test('resize: the line the cursor is on is left as the terminal has it; the lines above are counted at the new width', () => {
	// the first line wraps at 20 columns and not at 40; the cursor is on the second, so the first IS re-wrapped
	// by the terminal and the editor has to know it moved up a row
	const s = session({ cols: 20 });
	s.send(paste('abcdefghijklmnopqrstuvwxyz\nzz'));
	assert.deepStrictEqual(s.vt.text(), ['$ abcdefghijklmnopqr', 'stuvwxyz', '> zz']);
	s.vt.resize(40, 12);
	s.ed.resize(40, 12);
	assert.deepStrictEqual(s.vt.text(), ['$ abcdefghijklmnopqrstuvwxyz', '> zz']);
	assert.deepStrictEqual(s.vt.cursor(), { row: 1, col: 4 });
	s.send('!');
	assert.deepStrictEqual(s.vt.text(), ['$ abcdefghijklmnopqrstuvwxyz', '> zz!']);
});

test('resize wider and narrower in turn leaves the one line it had', () => {
	const s = session({ cols: 20 });
	s.send('abcdefghijklmnopqrstuvwxyz');
	for (const c of [30, 24, 40, 17, 20]) {
		s.vt.resize(c, 12);
		s.ed.resize(c, 12);
		assert.strictEqual(s.vt.text().join(''), '$ abcdefghijklmnopqrstuvwxyz', 'at ' + c);
	}
});

test('a buffer taller than the panel is drawn as a window that follows the cursor', () => {
	const s = session({ cols: 20, rows: 6 });
	const lines = Array.from({ length: 15 }, (_, i) => 'line' + (i + 1));
	s.send(paste(lines.join('\n')));
	assert.strictEqual(s.vt.text().length, 6, 'no more rows than the panel has');
	assert.strictEqual(s.vt.text()[5], '> line15');
	assert.deepStrictEqual(s.vt.cursor(), { row: 5, col: 2 + 6 });
	s.send(key.up.repeat(10));
	assert.ok(s.vt.text().includes('> line5'), JSON.stringify(s.vt.text()));
	assert.ok(s.vt.cursor().row >= 0 && s.vt.cursor().row < 6);
	s.send(key.up.repeat(4), key.home, 'X');
	assert.strictEqual(s.vt.text()[s.vt.cursor().row], '$ Xline1', JSON.stringify(s.vt.text()));
	s.send(key.down.repeat(14), key.end, 'Y');
	assert.strictEqual(s.vt.text()[s.vt.cursor().row], '> line15Y');
	assert.ok(s.ed.text().startsWith('Xline1\nline2'));
});

/* ------------------------------------------------------------------------------------------------ Tab */

function names(list) {
	return async (line, cursor) => {
		const start = line.lastIndexOf(' ', cursor - 1) + 1;
		const typed = line.slice(start, cursor);
		return { start, candidates: list.filter((n) => n.startsWith(typed)).map((n) => ({ text: n.replace(/\/$/, ''), display: n, dir: n.endsWith('/') })) };
	};
}

test('Tab completes a unique candidate, extends to the common prefix, and lists on the second Tab', async () => {
	const complete = names(['readme.md', 'README.txt', 'src/', 'srv.log']);
	const a = session({ complete });
	a.send('cat rea');
	a.send('\t');
	await wait();
	assert.strictEqual(a.ed.text(), 'cat readme.md ');

	const b = session({ complete, cols: 60 });
	b.send('cat s');
	b.send('\t');
	await wait();
	assert.strictEqual(b.ed.text(), 'cat sr', 'the common prefix of src and srv.log');
	b.send('\t');
	await wait();
	assert.deepStrictEqual(b.vt.text(), ['$ cat sr', 'src/     srv.log', '$ cat sr'], 'listed below, and the prompt is back');
	assert.deepStrictEqual(b.vt.cursor(), { row: 2, col: 8 });
	b.send('c\t');
	await wait();
	assert.strictEqual(b.ed.text(), 'cat src', 'a folder gets no space: the next name can follow');
});

test('an answer to Tab that arrives after the line changed is ignored', async () => {
	let release = () => { };
	const complete = () => new Promise((r) => { release = () => r({ start: 0, candidates: [{ text: 'LATE', display: 'LATE' }] }); });
	const s = session({ complete });
	s.send('ab', '\t');
	s.send('c');
	release();
	await wait();
	assert.strictEqual(s.ed.text(), 'abc');
});

test('a report from the workbench between a Tab and its answer, or between two Tabs, changes nothing', async () => {
	const complete = names(['src/', 'srv.log']);
	const a = session({ complete, cols: 60 });
	a.send('cat s', '\t');
	a.send(E + '[I', E + '[1;1R');                               // focus in, a cursor report
	await wait();
	assert.strictEqual(a.ed.text(), 'cat sr', 'the answer was still current');
	a.send(E + '[O');
	a.send('\t');
	await wait();
	assert.deepStrictEqual(a.vt.text().slice(0, 2), ['$ cat sr', 'src/     srv.log'], 'and it was still the second Tab');
});

test('a completer that answers with a start outside the line completes nothing', async () => {
	for (const start of [99, -1, NaN]) {
		const s = session({ complete: async () => ({ start, candidates: [{ text: 'x', display: 'x' }] }) });
		s.send('abc', '\t');
		await wait();
		assert.strictEqual(s.ed.text(), 'abc', 'start ' + start);
	}
});

test('characters a candidate cannot be typed with are dropped from what Tab inserts', async () => {
	const complete = async () => ({ start: 0, candidates: [{ text: 'a\x1b[31mb', display: 'x' }] });
	const s = session({ complete });
	s.send('a', '\t');
	await wait();
	assert.strictEqual(s.ed.text(), '[31mb '.replace('[31mb ', 'a[31mb '), 'the escape is gone: what is shown is what runs');
});

/* ------------------------------------------------------------------------------------------------ the differential */

// An oracle that shares no layout code with the editor: the prompt and the buffer are written ONCE, from scratch,
// into a terminal model that is tall enough not to scroll. Its rows are the editor's rows; its cursor is the model's
// cursor, adjusted the way the editor documents it (a pending wrap at the end of the buffer is a row of its own, a
// character that will wrap is where it lands, a newline at a full row shows the cursor on the last cell).
function oracle(prompt, cont, text, cur, cols) {
	const vt = new VT(cols, 400);
	const chars = Array.from(text);
	let cursor = null;
	const landing = (w) => {
		const c = vt.cursor();
		if (c.col >= cols || c.col + w > cols) { return { row: c.row + 1, col: 0 }; }
		return c;
	};
	vt.write(prompt);
	for (let i = 0; i <= chars.length; i++) {
		if (i === cur) {
			const c = vt.cursor();
			if (i === chars.length) { cursor = c.col >= cols ? { row: c.row + 1, col: 0 } : c; } else if (chars[i] === '\n') { cursor = { row: c.row, col: Math.min(c.col, cols - 1) }; } else {
				const w = chars[i] === '\t' ? 1 : strWidth(chars[i]);
				cursor = landing(w);
			}
		}
		if (i === chars.length) { break; }
		const ch = chars[i];
		if (ch === '\n') { vt.write('\r\n' + cont); } else if (ch === '\t') {
			const c = vt.cursor();
			const col = c.col >= cols ? 0 : c.col;
			vt.write(' '.repeat(8 - (col % 8)));
		} else { vt.write(ch); }
	}
	return { rows: vt.text(), cursor };
}

const pick = (rnd, list) => list[Math.floor(rnd() * list.length)];
function randomSession(rnd) {
	const words = ['a', 'b', 'x', ' ', 'hello', 'wor ld', '你', '好', '你好', '\u{1f600}', 'é', 'e\u0301', '❤', 'ab-cd', '\t', '\u{1f468}\u200d\u{1f469}\u200d\u{1f467}'];
	const keys = [key.left, key.right, key.home, key.end, '\x7f', key.del, '\x0b', '\x15', '\x17', key.ctrlLeft, key.ctrlRight, '\x01', '\x05', '\x14', E + 'b', E + 'f', E + 'd', '\x19', key.up, key.down, '\x08'];
	const pastes = ['one\ntwo', 'echo a\necho b\nc', 'x'.repeat(25), 'ab\n\ncd', 'a\n', '\nb', '你好\n世界\tx', 'l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8'];
	const steps = [];
	const n = 6 + Math.floor(rnd() * 18);
	for (let i = 0; i < n; i++) {
		const r = rnd();
		if (r < 0.5) { steps.push(pick(rnd, words).repeat(1 + Math.floor(rnd() * 3))); } else if (r < 0.6) { steps.push(paste(pick(rnd, pastes))); } else { steps.push(pick(rnd, keys)); }
	}
	return steps;
}

/** Everything the editor claims to have on screen, against the oracle. */
function checkAgainstOracle(s, prompt, label) {
	const rows = s.rows;
	const o = oracle(prompt, '> ', s.ed.text(), s.ed.cur, s.cols);
	const screen = s.vt.text();
	const cursor = s.vt.cursor();
	if (o.rows.length <= rows) {
		assert.deepStrictEqual(screen, o.rows, label + ': screen');
		assert.deepStrictEqual(cursor, o.cursor, label + ': cursor');
		return;
	}
	// a buffer taller than the panel: the screen is `rows` consecutive rows of the oracle, the cursor inside them
	let found = false;
	for (let top = 0; top + rows <= o.rows.length && !found; top++) {
		if (JSON.stringify(o.rows.slice(top, top + rows)) === JSON.stringify(screen.concat(Array(rows - screen.length).fill('')).slice(0, rows)) && o.cursor.row - top === cursor.row && o.cursor.col === cursor.col) { found = true; }
	}
	assert.ok(found, label + ': a window of ' + rows + ' rows with the cursor in it\n' + JSON.stringify({ screen, cursor, want: o.cursor, rows: o.rows }));
}

test('differential: random sessions at three widths, the screen and the cursor are the text written once (seeded)', () => {
	let seed = 20261011;
	const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
	const prompts = [plainPrompt, colourPrompt, '你好 $ ', 'a@b:~/p$ '];
	let sessions = 0;
	let steps = 0;
	for (const cols of [20, 27, 33]) {
		for (let k = 0; k < 70; k++) {
			const prompt = pick(rnd, prompts);
			const rows = pick(rnd, [24, 12, 6]);
			const history = ['ls -la', 'echo "two\nlines"'];
			const s = session({ cols, rows, prompt, history });
			const script = randomSession(rnd);
			sessions++;
			script.forEach((st, i) => {
				try { s.send(st); } catch (e) { assert.fail('crash at step ' + i + ' ' + JSON.stringify(st) + ' of ' + JSON.stringify(script) + ': ' + e.stack); }
				steps++;
				checkAgainstOracle(s, prompt, 'cols ' + cols + ' rows ' + rows + ' step ' + i + ' ' + JSON.stringify(st) + ' of ' + JSON.stringify(script));
			});
		}
	}
	assert.strictEqual(sessions, 210);
	assert.ok(steps > 2000);
});

test('differential with resizes: the redraw after a new width is the text written once at that width (seeded)', () => {
	let seed = 777;
	const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
	let checked = 0;
	for (let k = 0; k < 120; k++) {
		const prompt = pick(rnd, [plainPrompt, colourPrompt]);
		const cols = pick(rnd, [20, 27, 33]);
		const s = session({ cols, rows: 24, prompt });
		const script = randomSession(rnd);
		let width = cols;
		for (let i = 0; i < script.length; i++) {
			s.send(script[i]);
			if (i % 5 === 4) {
				width = pick(rnd, [20, 27, 33, 40, 24]);
				s.vt.resize(width, 24);
				s.ed.resize(width, 24);
				s.cols = width;
				checkAgainstOracle(s, prompt, 'resize to ' + width + ' after step ' + i + ' of ' + JSON.stringify(script));
				checked++;
			}
		}
	}
	assert.ok(checked > 200);
});

test('differential against the real xterm.js: the model terminal and xterm agree on what the editor wrote (when xterm is found)', async () => {
	const xt = findXterm();
	if (!xt) { console.log('    (skipped: no xterm checkout; set LEVELCODE_XTERM_DIR to the @xterm folder)'); return; }
	let seed = 4242;
	const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
	const trimRows = (rowsList) => { const r = rowsList.map((l) => l.replace(/\s+$/, '')); while (r.length && r[r.length - 1] === '') { r.pop(); } return r; };
	let compared = 0;
	for (const cols of [20, 27, 33]) {
		for (let k = 0; k < 25; k++) {
			const rows = pick(rnd, [24, 8]);
			const prompt = pick(rnd, [plainPrompt, colourPrompt]);
			const s = session({ cols, rows, prompt });
			const term = new xt.Terminal({ cols, rows, allowProposedApi: true, scrollback: 200 });
			term.loadAddon(new xt.Unicode11Addon());
			term.unicode.activeVersion = '11';
			const script = randomSession(rnd);
			let sent = 0;
			for (const st of script) { s.send(st); sent++; }
			await new Promise((r) => term.write(s.writes.join(''), r));
			const b = term.buffer.active;
			const real = [];
			for (let i = 0; i < rows; i++) { const l = b.getLine(b.baseY + i); real.push(l ? l.translateToString(true) : ''); }
			assert.deepStrictEqual(trimRows(real), trimRows(s.vt.lines()), 'screen, cols ' + cols + ' ' + JSON.stringify(script));
			assert.deepStrictEqual({ row: b.cursorY, col: b.cursorX }, s.vt.cursor(), 'cursor, cols ' + cols + ' ' + JSON.stringify(script));
			compared += sent;
			term.dispose();
		}
	}
	assert.ok(compared > 500);
});

(async () => {
	let n = 0;
	for (const [name, fn] of queue) { await fn(); n++; console.log('  ok - ' + name); }
	console.log(`\n${n} tests passed`);
})().catch((e) => { console.error(e); process.exit(1); });
