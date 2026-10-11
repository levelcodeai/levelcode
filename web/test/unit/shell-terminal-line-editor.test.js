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
 *    - resize, and a buffer taller than the panel: the editor follows xterm.js's own re-wrapping (reflowCursorLine off,
 *      as VS Code sets it), in both directions, including what it does to the cursor row; the test model terminal does
 *      the same (it is checked against xterm.js here), and every case that matters is run through both;
 *    - what may enter the buffer: nothing the screen cannot show;
 *    - a differential: seeded random sessions at three widths, after EVERY step the screen and the cursor equal what a
 *      terminal shows for the same text written once, from scratch. Zero mismatches, zero crashes.
 *    - real xterm.js (when a checkout is found; LEVELCODE_REQUIRE_XTERM=1 makes not finding one a failure): the
 *      editor's output equals xterm's, and with resizes at random points, widening and narrowing, the editor knows
 *      where the cursor is and leaves the prompt on the screen exactly once.
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
const { needXterm } = require('./helpers/shell-terminal-xterm');

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

test('combining marks are one step for the cursor and one Backspace; the joiners of an emoji sequence are not typed', () => {
	const s = session();
	s.send('e\u0301x');
	assert.strictEqual(s.vt.cursor().col, 2 + 1 + 1);
	s.send(key.left, key.left);
	assert.strictEqual(s.ed.cur, 0, 'one Left over the letter and its accent');
	s.send(key.end, '\x7f', '\x7f');
	assert.strictEqual(s.ed.text(), '', 'Backspace removes the accent with its letter');
	// a family is three emoji and two zero-width joiners: the joiners are invisible, so they are not kept (see below)
	const family = '\u{1f468}\u200d\u{1f469}\u200d\u{1f467}';
	s.send(family + 'a');
	assert.strictEqual(s.ed.text(), '\u{1f468}\u{1f469}\u{1f467}a');
	assert.strictEqual(s.vt.cursor().col, 2 + 6 + 1);
	s.send(key.left, key.left, key.left, key.left);
	assert.strictEqual(s.ed.cur, 0, 'each emoji is one step');
	s.send(key.end, '\x7f', '\x7f', '\x7f', '\x7f');
	assert.strictEqual(s.ed.text(), '');
});

test('nothing the screen cannot show enters the buffer: what is drawn is what runs', () => {
	const hidden = {
		'zero-width space': '\u200b', 'zero-width non-joiner': '\u200c', 'zero-width joiner': '\u200d', 'word joiner': '\u2060',
		'byte order mark': '\ufeff', 'soft hyphen': '\u00ad', 'left-to-right mark': '\u200e', 'right-to-left mark': '\u200f',
		'arabic letter mark': '\u061c', 'invisible times': '\u2062', 'hangul filler': '\u3164', 'halfwidth hangul filler': '\uffa0',
		'variation selector 16': '\ufe0f', 'variation selector 1': '\ufe00', 'tag latin a': '\u{e0061}', 'cancel tag': '\u{e007f}',
		'line separator': '\u2028', 'paragraph separator': '\u2029', 'blank braille': '\u2800', 'interlinear anchor': '\ufff9',
		'lone high surrogate': '\ud800', 'lone low surrogate': '\udc00',
		// the bidi controls: what makes `rm a<RLO>txt.b` read as `rm a b.txt`
		'right-to-left override': '\u202e', 'left-to-right override': '\u202d', 'left-to-right embedding': '\u202a',
		'right-to-left embedding': '\u202b', 'pop directional formatting': '\u202c', 'left-to-right isolate': '\u2066',
		'right-to-left isolate': '\u2067', 'first strong isolate': '\u2068', 'pop directional isolate': '\u2069',
	};
	for (const [name, ch] of Object.entries(hidden)) {
		const s = session();
		s.send(paste('rm a' + ch + 'b.txt'));
		assert.strictEqual(s.ed.text(), 'rm ab.txt', name + ' is not in the buffer');
		assert.deepStrictEqual(s.vt.text(), ['$ rm ab.txt'], name);
		// typed, from history and from a completion: the same rule
		const t = session({ history: ['echo a' + ch + 'b'] });
		t.send(ch + 'x', key.up);
		assert.strictEqual(t.ed.text(), 'echo ab', name + ' from history');
	}
	// what has a glyph stays: accents, emoji, CJK, a no-break space (it is drawn, as a blank, and is not a separator)
	const s = session();
	s.send(paste('caf\u00e9 e\u0301 \u{1f600} \u4f60\u597d a\u00a0b'));
	assert.strictEqual(s.ed.text(), 'caf\u00e9 e\u0301 \u{1f600} \u4f60\u597d a\u00a0b');
	// a completion cannot put one in either
	return (async () => {
		const c = session({ complete: async () => ({ start: 0, candidates: [{ text: 'a\u200bb\u202ec', display: 'x' }] }) });
		c.send('a', '\t');
		await wait();
		assert.strictEqual(c.ed.text(), 'abc ');
	})();
});

test('Shift+Tab is not completion: nothing is asked and nothing changes', async () => {
	let asked = 0;
	const complete = async (line) => { asked++; return { start: 0, candidates: [{ text: line + 'X', display: line + 'X' }] }; };
	const s = session({ complete });
	s.send('ab', E + '[Z');
	await wait();
	assert.strictEqual(asked, 0);
	assert.strictEqual(s.ed.text(), 'ab');
	assert.deepStrictEqual(s.vt.text(), ['$ ab']);
	s.send('\t');
	await wait();
	assert.strictEqual(asked, 1, 'Tab is');
	assert.strictEqual(s.ed.text(), 'abX ');
});

test('Ctrl+K at the end of a line joins the next one; at the end of the buffer it does nothing', () => {
	const s = session();
	s.send(paste('one\ntwo\nthree'));
	s.send(key.up, key.up, key.end);                      // the end of the first line
	s.send('\x0b');
	assert.strictEqual(s.ed.text(), 'onetwo\nthree');
	assert.deepStrictEqual(s.vt.text(), ['$ onetwo', '> three']);
	s.send('\x0b');                                       // now there is text to the right: it is killed
	assert.strictEqual(s.ed.text(), 'one\nthree', 'the cursor was between one and two: two goes');
	s.send(key.down, key.end, '\x0b');
	assert.strictEqual(s.ed.text(), 'one\nthree', 'the end of the buffer');
	s.send(key.up, key.end, '\x0b');
	assert.strictEqual(s.ed.text(), 'onethree');
});

test('an underscore is a word character: Alt+B, Alt+F and Ctrl+Left move over snake_case as one word', () => {
	const s = session();
	s.send('cd my_long_name now');
	s.send(E + 'b');
	assert.strictEqual(s.ed.cur, 'cd my_long_name '.length);
	s.send(E + 'b');
	assert.strictEqual(s.ed.cur, 'cd '.length, 'the underscores did not split it');
	s.send(E + 'f');
	assert.strictEqual(s.ed.cur, 'cd my_long_name'.length);
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

/** A completer whose answers are let go by hand, one at a time. */
function slowCompleter(list) {
	const waiting = [];
	const asked = [];
	const complete = (line, cursor) => new Promise((resolve) => {
		asked.push(line);
		const start = line.lastIndexOf(' ', cursor - 1) + 1;
		const typed = line.slice(start, cursor);
		const answer = { start, candidates: list.filter((n) => n.startsWith(typed)).map((n) => ({ text: n.replace(/\/$/, ''), display: n, dir: n.endsWith('/') })) };
		waiting.push(() => resolve(answer));
	});
	return { complete, asked, release: async () => { const f = waiting.shift(); if (f) { f(); } await wait(); } };
}

test('Tab Tab when the first answer is slow: the second waits for it, so the list still comes (queued, at most one)', async () => {
	const c = slowCompleter(['src/', 'srv.log']);
	const s = session({ complete: c.complete, cols: 60 });
	s.send('cat s', '\t');
	s.send('\t');                                         // before the first answer
	s.send('\t');                                         // a third is not kept: one waits at most
	assert.deepStrictEqual(c.asked, ['cat s'], 'one question at a time');
	await c.release();                                    // the first answer: the common prefix, which is "sr"
	assert.strictEqual(s.ed.text(), 'cat sr');
	assert.deepStrictEqual(c.asked, ['cat s', 'cat sr'], 'the second Tab asked now, about the line as it is');
	await c.release();
	assert.deepStrictEqual(s.vt.text(), ['$ cat sr', 'src/     srv.log', '$ cat sr'], 'and it was the second Tab of a pair: the list');
	assert.strictEqual(c.asked.length, 2, 'the third was dropped');
});

test('a key typed while a Tab waits drops the queued Tab and makes the answer stale', async () => {
	const c = slowCompleter(['readme.md', 'README.txt']);
	const s = session({ complete: c.complete });
	s.send('cat rea', '\t');
	s.send('\t');                                         // queued
	s.send('d');                                          // the line changed: the answer in flight is stale, the queue is gone
	await c.release();
	assert.strictEqual(s.ed.text(), 'cat read', 'the late answer was not applied');
	assert.deepStrictEqual(c.asked, ['cat rea'], 'and the queued Tab never asked');
	// a Tab after that is a fresh one
	s.send('\t');
	assert.deepStrictEqual(c.asked, ['cat rea', 'cat read']);
	await c.release();
	assert.strictEqual(s.ed.text(), 'cat readme.md ');
});

test('a Tab pressed after a key made the answer in flight stale asks at once; it does not wait behind an answer nobody will use', async () => {
	const c = slowCompleter(['readme.md', 'README.txt']);
	const s = session({ complete: c.complete });
	s.send('cat rea', '\t');
	s.send('d');                                          // the line changed: that answer is stale
	s.send('\t');
	assert.deepStrictEqual(c.asked, ['cat rea', 'cat read'], 'both questions are out; the second is not queued');
	await c.release();                                    // the stale one
	assert.strictEqual(s.ed.text(), 'cat read');
	await c.release();
	assert.strictEqual(s.ed.text(), 'cat readme.md ');
});

test('Enter while a Tab waits: nothing the answer says is applied to the next prompt', async () => {
	const c = slowCompleter(['abc']);
	const s = session({ complete: c.complete });
	s.send('a', '\t');
	s.send('\t');
	s.send('\r');
	assert.deepStrictEqual(s.submitted, ['a']);
	s.ed.start();
	await c.release();
	assert.strictEqual(s.ed.text(), '');
	assert.deepStrictEqual(c.asked, ['a']);
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

/** The terminal as VS Code makes it: Unicode 11, and the erase of a screen scrolls what was on it into the scrollback. */
function makeXterm(xt, cols, rows) {
	const term = new xt.Terminal({ cols, rows, allowProposedApi: true, scrollback: 300, scrollOnEraseInDisplay: true });
	term.loadAddon(new xt.Unicode11Addon());
	term.unicode.activeVersion = '11';
	return term;
}
const written = (term, s) => new Promise((r) => term.write(s, r));
const trimRows = (rowsList) => { const r = rowsList.map((l) => l.replace(/\s+$/, '')); while (r.length && r[r.length - 1] === '') { r.pop(); } return r; };
/** The rows of the viewport of a real xterm, as strings. */
function viewport(term, rows) {
	const b = term.buffer.active;
	const out = [];
	for (let i = 0; i < rows; i++) { const l = b.getLine(b.baseY + i); out.push(l ? l.translateToString(true) : ''); }
	return out;
}

test('differential against the real xterm.js: the model terminal and xterm agree on what the editor wrote (when xterm is found)', async () => {
	const xt = needXterm('the model terminal against xterm.js');
	if (!xt) { return; }
	let seed = 4242;
	const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
	let compared = 0;
	for (const cols of [20, 27, 33]) {
		for (let k = 0; k < 25; k++) {
			const rows = pick(rnd, [24, 8]);
			const prompt = pick(rnd, [plainPrompt, colourPrompt]);
			const s = session({ cols, rows, prompt });
			const term = makeXterm(xt, cols, rows);
			const script = randomSession(rnd);
			let sent = 0;
			for (const st of script) { s.send(st); sent++; }
			await written(term, s.writes.join(''));
			const b = term.buffer.active;
			assert.deepStrictEqual(trimRows(viewport(term, rows)), trimRows(s.vt.lines()), 'screen, cols ' + cols + ' ' + JSON.stringify(script));
			assert.deepStrictEqual({ row: b.cursorY, col: b.cursorX }, s.vt.cursor(), 'cursor, cols ' + cols + ' ' + JSON.stringify(script));
			compared += sent;
			term.dispose();
		}
	}
	assert.ok(compared > 500);
});

/* ------------------------------------------------------------------------------------------------ resize, against xterm.js */

// The scenarios: [name, columns before, columns after, what was pasted, the keys that put the cursor where it is]. The
// first six are the ones a reflow that "leaves the cursor's own line alone" gets wrong: it also moves the cursor by the
// rows a line BELOW it gained or lost, so the cursor can be on a different row of the region than the editor thinks.
const L45 = 'x'.repeat(45);
/** @type {Array<[string, number, number, string, string[]]>} */
const SCENARIOS = [
	['one line that wraps, narrower', 50, 30, 'y'.repeat(60), []],
	['two lines, cursor on the last, narrower', 50, 30, 'echo a\n' + L45, []],
	['two lines, cursor on the FIRST, narrower (the last wraps)', 50, 30, 'echo hello\n' + L45, [key.up]],
	['three lines, cursor on the FIRST, narrower (the last wraps)', 50, 30, 'one\ntwo\n' + L45, [key.up, key.up]],
	['three lines, cursor on the middle, narrower (the last wraps)', 50, 30, 'one\n' + 'm'.repeat(10) + '\n' + L45, [key.up]],
	['two lines, cursor on the first, WIDER (the last is joined)', 30, 50, 'echo hello\n' + L45, [key.up]],
	['three lines, cursor on the first, WIDER (both below are joined: the cursor is left ABOVE its region)', 30, 70, 'one\n' + L45 + '\n' + L45, [key.up, key.up]],
	['three lines, cursor on the middle, WIDER', 30, 60, 'one\n' + L45 + '\n' + L45, [key.up]],
	['two lines, cursor on the last, WIDER (its own line is not joined)', 30, 50, 'echo a\n' + L45, []],
	['two short lines, cursor on the first, narrower (nothing wraps)', 50, 40, 'a\nb', [key.up]],
	['first line long, cursor on it, narrower', 50, 30, L45 + '\nb', [key.up]],
	['first line long, cursor on the last, narrower', 50, 30, L45 + '\nb', []],
	['a tab that wraps, cursor above it, narrower then wider', 40, 24, 'a\tb\nc\t' + 'd'.repeat(30) + '\te', [key.up]],
	['a tab keeps the spaces it was drawn with when its line is re-wrapped (8 spaces at 14 columns; at 8 it would be 2)', 14, 8, 'a'.repeat(12) + '\tcccc\nlast', []],
	['wide characters at the edge, narrower', 40, 21, '你好世界你好世界你好\n' + '界'.repeat(15), [key.up]],
	['a last line that fills the row exactly (the cursor is on the row made by forcing a wrap), narrower', 40, 30, 'echo\n' + 'z'.repeat(38), []],
	['a last line that fills the row exactly, wider', 30, 50, 'echo\n' + 'z'.repeat(28), []],
	['a buffer taller than the panel, narrower', 40, 28, Array.from({ length: 7 }, (_, i) => 'line ' + (i + 1) + ' ' + 'w'.repeat(20)).join('\n'), [key.up, key.up]],
	['a buffer taller than the panel, wider', 24, 60, Array.from({ length: 7 }, (_, i) => 'line ' + (i + 1) + ' ' + 'w'.repeat(20)).join('\n'), [key.up, key.up, key.up]],
];

/**
 * What a screen must look like after the editor has redrawn, from the screen's rows alone (so it serves the model
 * terminal and xterm.js alike): the whole region once, from the row the cursor says, with the cursor where the text
 * written once puts it. A region taller than the panel is a window of the written-once rows. Rows above the region are
 * not looked at, except that the region is not there twice in the viewport (a copy that scrolled into the scrollback
 * while the buffer was taller than the panel is history, and `ghostsOk`).
 * @returns {string | null} what is wrong
 */
function screenProblem(view, cursor, s, prompt, rows, ghostsOk) {
	const o = oracle(prompt, '> ', s.ed.text(), s.ed.cur, s.cols);
	while (o.rows.length <= o.cursor.row) { o.rows.push(''); }
	const shown = trimRows(view.slice()).length === 0 ? [] : view.map((l) => l.replace(/\s+$/, ''));
	if (o.rows.length > rows) {
		for (let t = 0; t + rows <= o.rows.length; t++) {
			if (JSON.stringify(o.rows.slice(t, t + rows)) === JSON.stringify(shown) && o.cursor.row - t === cursor.row && o.cursor.col === cursor.col) { return null; }
		}
		return 'the viewport is not a window of the text written once: ' + JSON.stringify({ view: shown, cursor, want: o.cursor, rows: o.rows.length });
	}
	const top = cursor.row - o.cursor.row;
	if (top < 0) { return 'the cursor is above where the region begins: ' + JSON.stringify({ cursor, want: o.cursor }); }
	for (let i = 0; i < o.rows.length; i++) {
		if (shown[top + i] !== o.rows[i]) { return 'the region is not on the screen from row ' + top + ': ' + JSON.stringify({ view: shown, want: o.rows, top }); }
	}
	if (cursor.col !== o.cursor.col) { return 'the cursor is in column ' + cursor.col + ', not ' + o.cursor.col; }
	for (let y = 0; y < top && !ghostsOk; y++) {
		if (shown[y].startsWith(prompt.trim()) || shown[y].startsWith('> ')) { return 'a copy of the region is on the screen above it: ' + JSON.stringify(shown); }
	}
	return null;
}

/** Output that was there before the prompt (a banner, the last command's output), wrapped lines included. */
const EARLIER = ['LevelCode Shell: bash over the files of this workspace.', 'o'.repeat(62), 'a prompt line of output', 'o'.repeat(37)];

/**
 * Run a script on the editor and a terminal, resizing it where the script says. `attach(term)` is what the terminal
 * has to offer: `write`, `resize`, the viewport rows and the cursor; for xterm.js also a marker on the first row of the
 * region, with which the editor's idea of where its cursor is can be compared with the terminal's own.
 * @returns {Promise<string | null>} what is wrong, or null
 */
async function runResizeScript(target, spec) {
	const { cols: cols0, rows, prompt, steps, earlier } = spec;
	const term = target.make(cols0, rows);
	let cols = cols0;
	let out = '';
	const parser = createInputParser();
	const ed = new LineEditor({
		write: (x) => { out += x; },
		prompt: () => prompt, columns: cols, rows, history: () => ['ls -la', 'echo "two\nlines"'],
		isComplete: () => ({ complete: true }), onSubmit() { },
	});
	const flush = async () => { const x = out; out = ''; await term.write(x); };
	await term.write((earlier || []).map((l) => l + '\r\n').join(''));
	ed.start();
	await flush();
	let markerOk = true;      // the marker is on the first row of the region and the cursor can reach it
	let ghostsOk = false;     // the region has been taller than the panel, or its first row has gone into the scrollback
	let marker = term.marker(0);
	const resync = () => {
		const L = ed._layout();
		const fits = L.end.row + 1 + (L.forced && ed.cur === ed.buf.length ? 1 : 0) <= rows;
		if (!fits || ed.lastRow + 1 > rows) { ghostsOk = true; }
		if (term.markerAbove(marker)) { ghostsOk = true; markerOk = false; }
		if (!markerOk && fits) { marker = term.marker(-ed.cursorRow); markerOk = true; }
		if (!fits || ed.winTop > 0) { markerOk = false; }
	};
	for (let i = 0; i < steps.length; i++) {
		const st = steps[i];
		const label = 'step ' + i + ' ' + JSON.stringify(st) + ' (columns ' + cols + ', rows ' + rows + ')';
		if (st.resize !== undefined) {
			const nc = st.resize;
			if (nc === cols) { continue; }
			const windowed = ed.lastRow + 1 > rows;
			await term.resize(nc, rows);
			// where the terminal's cursor is now, in rows below the first row of the region
			const real = markerOk && !windowed && term.markerVisible(marker) ? term.cursorBelow(marker) : null;
			cols = nc;
			ed.resize(nc, rows);
			const m = /^(?:\x1b\[(\d+)([AB]))?\r\x1b\[J/.exec(out);
			const said = m ? (m[1] ? (m[2] === 'A' ? Number(m[1]) : -Number(m[1])) : 0) : null;
			await flush();
			if (real !== null && said !== real) { return label + ': the editor moved ' + said + ' rows up, the terminal had its cursor ' + real + ' rows below the first row of the region'; }
			resync();
		} else {
			ed.input(parser.feed(st.paste !== undefined ? paste(st.paste) : st.send));
			ed.input(parser.flush());
			await flush();
			resync();
		}
		const w = term.view();
		const problem = screenProblem(w.rows, w.cursor, { ed, cols }, prompt, rows, ghostsOk);
		if (problem) { return label + ': ' + problem; }
		if (markerOk && marker && term.markerVisible(marker) && !ed.text().includes('\t')) {
			// the first row of the region is where the editor believes it is, relative to the cursor
			const rel = term.cursorBelow(marker);
			if (rel !== null && rel !== ed.targetRow - ed.winTop && ed.winTop === 0) { return label + ': the cursor is ' + rel + ' rows below the first row of the region, the editor says ' + (ed.targetRow - ed.winTop); }
		}
	}
	term.dispose();
	return null;
}

/** The same script, on the model terminal. */
const modelTarget = {
	make(cols, rows) {
		const vt = new VT(cols, rows);
		return {
			write: async (x) => { vt.write(x); },
			resize: async (c, r) => { vt.resize(c, r); },
			view: () => ({ rows: vt.lines(), cursor: vt.cursor() }),
			marker: () => null, markerAbove: () => false, markerVisible: () => false, cursorBelow: () => null,
			dispose() { },
		};
	},
};

/** The same script, on xterm.js, with a marker on the first row of the region. */
function xtermTarget(xt) {
	return {
		make(cols, rows) {
			const term = makeXterm(xt, cols, rows);
			return {
				write: (x) => written(term, x),
				resize: async (c, r) => { term.resize(c, r); await written(term, ''); },
				view: () => { const b = term.buffer.active; return { rows: viewport(term, term.rows), cursor: { row: b.cursorY, col: b.cursorX } }; },
				marker: (offset) => term.registerMarker(offset),
				markerAbove: (m) => m.line < term.buffer.active.baseY,
				markerVisible: (m) => m.line >= term.buffer.active.baseY,
				cursorBelow: (m) => { const b = term.buffer.active; return b.baseY + b.cursorY - m.line; },
				dispose() { term.dispose(); },
			};
		},
	};
}

/** @typedef {{ paste?: string, send?: string, resize?: number }} Step */

/** @param {typeof SCENARIOS[number]} sc */
function scenarioScript(sc) {
	const [, before, after, pasted, keys] = sc;
	/** @type {Step[]} */
	const steps = [{ paste: pasted }];
	for (const k of keys) { steps.push({ send: k }); }
	steps.push({ resize: after }, { send: 'Z' }, { resize: before }, { send: '!' });
	return { cols: before, rows: 12, prompt: plainPrompt, steps, earlier: EARLIER };
}

test('resize, on the model terminal: every scenario ends with the prompt on the screen once and the cursor where the editor says', async () => {
	for (const sc of SCENARIOS) {
		const spec = scenarioScript(sc);
		if (/** @type {string} */ (sc[0]).startsWith('a buffer taller')) { spec.rows = 6; }
		const problem = await runResizeScript(modelTarget, spec);
		assert.strictEqual(problem, null, sc[0] + ': ' + problem);
	}
});

test('resize, on the model terminal: widening leaves the cursor ABOVE the region when lines under it are joined, and the editor goes down to it', async () => {
	// xterm.js moves its cursor up by every row it takes out, whichever side of the cursor the line was on
	const vt = new VT(30, 12);
	const out = [];
	vt.write('earlier output 1\r\nearlier output 2\r\nearlier output 3\r\n');
	const ed = new LineEditor({ write: (x) => { out.push(x); vt.write(x); }, prompt: () => plainPrompt, columns: 30, rows: 12, onSubmit() { } });
	ed.start();
	const parser = createInputParser();
	ed.input(parser.feed(paste('first\n' + L45 + '\n' + L45)));
	ed.input(parser.feed(key.up + key.up));
	assert.strictEqual(ed.cursorRow, 0);
	vt.resize(70, 12);
	out.length = 0;
	ed.resize(70, 12);
	assert.ok(/^\x1b\[(\d+)B\r\x1b\[J/.test(out[0]), 'down to the first row of the region: ' + JSON.stringify(out[0].slice(0, 20)));
	assert.deepStrictEqual(vt.text(), ['earlier output 1', 'earlier output 2', 'earlier output 3', '$ first', '> ' + L45, '> ' + L45]);
});

test('resize: a tab keeps the spaces it was drawn with when the terminal re-wraps them', async () => {
	const problem = await runResizeScript(modelTarget, { cols: 40, rows: 12, prompt: plainPrompt, earlier: EARLIER, steps: [{ paste: 'ab\tcd\t' + 'e'.repeat(20) + '\tf\nsecond\tline' }, { send: key.up }, { send: key.up }, { resize: 17 }, { send: 'Q' }, { resize: 44 }, { send: 'R' }, { resize: 13 }, { send: 'S' }] });
	assert.strictEqual(problem, null, String(problem));
});

test('the spaces of a tab that wrap below the last row of a window are not written (the screen would scroll and the cursor sit a row low)', async () => {
	const body = 'a\nb\nc\n' + 'z'.repeat(15) + '\tq';        // 5 rows of 20; the tab starts at column 17 of the fourth
	const run = async (target) => {
		const problem = await runResizeScript(target, { cols: 20, rows: 4, prompt: plainPrompt, earlier: [], steps: [{ paste: body }, { send: key.up }, { send: key.up }, { send: key.up }, { send: key.down }, { send: key.down }, { send: key.down }, { send: 'X' }] });
		assert.strictEqual(problem, null, String(problem));
	};
	await run(modelTarget);
	const xt = needXterm('a tab at the bottom of a window against xterm.js');
	if (xt) { await run(xtermTarget(xt)); }
	// and the bytes: the last row drawn ends at its last column, not past it
	const s = session({ cols: 20, rows: 4 });
	s.send(paste(body), key.up, key.up, key.up, key.down, key.down, key.down);
	const drawn = s.writes[s.writes.length - 1];
	assert.ok(!/ {5,}\r/.test(drawn.split('\r\n').pop() || ''), 'no more spaces than the last row has room for: ' + JSON.stringify(drawn.slice(-60)));
	assert.deepStrictEqual(s.vt.text().length, 4);
	assert.strictEqual(s.vt.text()[0], '$ a', 'the window did not scroll');
});

test('resize, against xterm.js: the scenarios, both directions (when xterm is found)', async () => {
	const xt = needXterm('the resize scenarios against xterm.js');
	if (!xt) { return; }
	for (const sc of SCENARIOS) {
		const spec = scenarioScript(sc);
		if (/** @type {string} */ (sc[0]).startsWith('a buffer taller')) { spec.rows = 6; }
		const problem = await runResizeScript(xtermTarget(xt), spec);
		assert.strictEqual(problem, null, sc[0] + ': ' + problem);
	}
});

/**
 * A script made to put the cursor above lines that wrap and then change the width: a pasted buffer of a few lines of
 * different lengths, the cursor taken up some of them, and several widths with a key now and then in between.
 */
function resizeScript(rnd, widths) {
	/** @type {Step[]} */
	const out = [];
	const parts = ['one', 'two words here', 'x'.repeat(20 + Math.floor(rnd() * 40)), 'y'.repeat(5 + Math.floor(rnd() * 30)), '', '你好世界' + 'z'.repeat(Math.floor(rnd() * 25)), 'a\tb', 'w'.repeat(33)];
	const n = 2 + Math.floor(rnd() * 4);
	const lines = [];
	for (let i = 0; i < n; i++) { lines.push(pick(rnd, parts)); }
	const steps = out;
	steps.push({ paste: lines.join('\n') });
	for (let i = 0, ups = Math.floor(rnd() * (n + 1)); i < ups; i++) { steps.push({ send: key.up }); }
	for (let r = 0, count = 3 + Math.floor(rnd() * 4); r < count; r++) {
		steps.push({ resize: pick(rnd, widths) });
		if (rnd() < 0.35) { steps.push({ send: pick(rnd, ['Z', key.down, key.up, key.left, key.home, key.end, '\x0b', 'ab', '\x15']) }); }
	}
	return steps;
}

test('resize, against xterm.js: seeded random sessions with resizes in both directions (when xterm is found)', async () => {
	const xt = needXterm('the random resize sessions against xterm.js');
	if (!xt) { return; }
	let seed = 20261011;
	const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
	const prompts = [plainPrompt, colourPrompt, '你好 $ '];
	let resizes = 0;
	for (let k = 0; k < 90; k++) {
		const prompt = pick(rnd, prompts);
		const widths = [14, 16, 18, 20, 24, 27, 30, 33, 36, 40, 50, 60].filter((w) => w > strWidth(stripEscapes(prompt)) + 2);
		/** @type {Step[]} */
		let steps;
		if (k % 3 === 0) {
			// anything the editor does, with a resize now and then
			steps = [];
			for (const st of randomSession(rnd)) {
				steps.push(st.startsWith(E + '[200~') ? { paste: st.slice((E + '[200~').length, -(E + '[201~').length) } : { send: st });
				if (rnd() < 0.3) { steps.push({ resize: pick(rnd, widths) }); }
			}
		} else {
			steps = resizeScript(rnd, widths);
		}
		resizes += steps.filter((st) => st.resize !== undefined).length;
		const spec = { cols: pick(rnd, [20, 27, 33, 40]), rows: pick(rnd, [8, 12, 24]), prompt, steps, earlier: EARLIER.slice(0, 3 + Math.floor(rnd() * 2)) };
		const problem = await runResizeScript(xtermTarget(xt), spec);
		assert.strictEqual(problem, null, 'session ' + k + ' ' + JSON.stringify(spec) + ': ' + problem);
	}
	assert.ok(resizes > 250, 'resizes: ' + resizes);
});

test('resize, against xterm.js: the model terminal re-wraps the way xterm.js does, rows and cursor, in both directions (when xterm is found)', async () => {
	const xt = needXterm('the model terminal\'s resize against xterm.js');
	if (!xt) { return; }
	let seed = 99173;
	const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
	let resizes = 0;
	for (let k = 0; k < 50; k++) {
		const cols0 = pick(rnd, [20, 27, 33]);
		const rows = pick(rnd, [6, 8, 12, 24]);
		const prompt = pick(rnd, [plainPrompt, colourPrompt]);
		const term = makeXterm(xt, cols0, rows);
		const vt = new VT(cols0, rows);
		let out = '';
		const parser = createInputParser();
		const ed = new LineEditor({ write: (x) => { out += x; vt.write(x); }, prompt: () => prompt, columns: cols0, rows, history: () => ['ls -la', 'echo "two\nlines"'], isComplete: () => ({ complete: true }), onSubmit() { } });
		const earlier = EARLIER.slice(0, Math.floor(rnd() * 5)).map((l) => l + '\r\n').join('');
		vt.write(earlier);
		await written(term, earlier);
		ed.start();
		const flush = async () => { const x = out; out = ''; await written(term, x); };
		await flush();
		const compare = (label) => {
			const b = term.buffer.active;
			assert.deepStrictEqual({ rows: trimRows(vt.lines()), cursor: vt.cursor() }, { rows: trimRows(viewport(term, rows)), cursor: { row: b.cursorY, col: b.cursorX } }, 'session ' + k + ' ' + label);
		};
		for (const st of randomSession(rnd)) {
			ed.input(parser.feed(rnd() < 0.08 ? '\x0c' : st));     // now and then Ctrl+L: what is on the screen goes to the scrollback
			await flush();
			if (rnd() < 0.3) {
				const nc = pick(rnd, [14, 16, 18, 20, 24, 27, 30, 33, 36, 40, 50, 60].filter((w) => w > strWidth(stripEscapes(prompt)) + 2));
				term.resize(nc, rows);
				await written(term, '');
				vt.resize(nc, rows);
				resizes++;
				compare('just after xterm and the model were resized to ' + nc);
				ed.resize(nc, rows);
				await flush();
				compare('after the editor redrew at ' + nc);
			}
		}
		compare('at the end');
		term.dispose();
	}
	assert.ok(resizes > 100, 'resizes: ' + resizes);
});

test('a resize that changes nothing writes nothing; nothing smaller than 2 columns or 2 rows is taken', () => {
	const s = session({ cols: 30, rows: 8 });
	s.send('abc');
	const n = s.writes.length;
	s.ed.resize(30, 8);
	assert.strictEqual(s.writes.length, n, 'no redraw for the same size');
	s.ed.resize(31, 8);
	assert.ok(s.writes.length > n, 'a redraw for another');
	const tiny = new LineEditor({ write() { }, prompt: () => '', columns: 1, rows: 1, onSubmit() { } });
	assert.deepStrictEqual([tiny.cols, tiny.rows], [2, 2], 'at the start');
	tiny.resize(1, 1);
	assert.deepStrictEqual([tiny.cols, tiny.rows], [2, 2], 'and on a resize');
	tiny.resize(0, 0);
	assert.deepStrictEqual([tiny.cols, tiny.rows], [2, 2], 'a panel that reports 0 is not a panel');
	tiny.resize(5, 3);
	assert.deepStrictEqual([tiny.cols, tiny.rows], [5, 3]);
});

(async () => {
	let n = 0;
	for (const [name, fn] of queue) { await fn(); n++; console.log('  ok - ' + name); }
	console.log(`\n${n} tests passed`);
})().catch((e) => { console.error(e); process.exit(1); });
