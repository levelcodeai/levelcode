/*---------------------------------------------------------------------------------------------
 *  LevelCode Shell terminal: the line log - run: node web/test/unit/shell-terminal-line-log.test.js
 *
 *  A file link is a path relative to the folder the command ran in, and the workbench hands the link provider only the
 *  text of a line. So what was written is remembered here with the folder it was about, by the text the line has on
 *  the screen. Pinned: how that text is made from the bytes (tabs, wide characters, marks, carriage returns, erases,
 *  escape sequences), what is kept (lines with a path in them, the newest 400, the first 4,000 characters), and what
 *  the latest of two equal lines does.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

const assert = require('assert');
const path = require('path');

const dir = path.join(__dirname, '..', '..', 'shell', 'src', 'terminal');
const { createLineLog, MAX_LINES } = require(path.join(dir, 'line-log.js'));
const { MAX_LINE } = require(path.join(dir, 'links.js'));
const { everyShape } = require('./helpers/shell-terminal-timing');
const { needXterm } = require('./helpers/shell-terminal-xterm');
const { findCandidates } = require(path.join(dir, 'links.js'));

const queue = [];
const test = (name, fn) => queue.push([name, fn]);
const E = '\x1b';

const scope = (...cwds) => ({ cwds });

test('a line is known by the text it has on the screen, and by the folders of the stretch of output it was in', () => {
	const log = createLineLog();
	const a = scope('/scratch/a');
	log.write('src/x.js:3: error\r\nsee lib/y.js\r\n', a);
	assert.deepStrictEqual(log.find('src/x.js:3: error'), ['/scratch/a']);
	assert.deepStrictEqual(log.find('see lib/y.js'), ['/scratch/a']);
	assert.strictEqual(log.find('src/x.js:4: error'), undefined);
	// a plain LF ends a line too, and a line that has not ended is not there yet
	log.write('b/z.js\nhalf/w.js', a);
	assert.deepStrictEqual(log.find('b/z.js'), ['/scratch/a']);
	assert.strictEqual(log.find('half/w.js'), undefined);
	log.write(' and the rest\n', a);
	assert.deepStrictEqual(log.find('half/w.js and the rest'), ['/scratch/a'], 'a line written in pieces');
	// the answer is a copy: what the caller does to it is not done to the log
	const got = /** @type {string[]} */ (log.find('b/z.js'));
	got.push('/other');
	assert.deepStrictEqual(log.find('b/z.js'), ['/scratch/a']);
});

test('a folder that becomes known later (where a command ended) is added once for every line of the stretch', () => {
	const log = createLineLog();
	const s = scope('/scratch');
	log.write('lib/a.js\nlib/b.js\n', s);
	s.cwds.unshift('/scratch/src');
	assert.deepStrictEqual(log.find('lib/a.js'), ['/scratch/src', '/scratch']);
	assert.deepStrictEqual(log.find('lib/b.js'), ['/scratch/src', '/scratch']);
});

test('the latest of two equal lines wins, and is the newest in the order of forgetting', () => {
	const log = createLineLog({ max: 3 });
	log.write('a/x.js\n', scope('/one'));
	log.write('b/x.js\n', scope('/two'));
	log.write('a/x.js\n', scope('/three'));          // the same text again: it is now the newest, in another folder
	assert.deepStrictEqual(log.find('a/x.js'), ['/three']);
	log.write('c/x.js\n', scope('/four'));
	log.write('d/x.js\n', scope('/five'));           // 4 lines for 3 places: the oldest, which is b, goes
	assert.strictEqual(log.find('b/x.js'), undefined);
	assert.deepStrictEqual(log.find('a/x.js'), ['/three'], 'it was written after b');
	assert.strictEqual(log.size(), 3);
});

test('only a line with something in it that could be a path is kept; at most MAX_LINES of them', () => {
	assert.strictEqual(MAX_LINES, 400);
	const log = createLineLog();
	log.write('nothing to see here\nhello world\n12:30\n\n   \nsrc/a.js\n', scope('/s'));
	assert.strictEqual(log.size(), 1);
	for (let i = 0; i < 1000; i++) { log.write('dir/f' + i + '.js\n', scope('/s')); }
	assert.strictEqual(log.size(), MAX_LINES);
	assert.strictEqual(log.find('dir/f0.js'), undefined, 'the oldest went');
	assert.deepStrictEqual(log.find('dir/f999.js'), ['/s']);
	assert.deepStrictEqual(log.find('dir/f600.js'), ['/s']);
	assert.strictEqual(log.find('dir/f599.js'), undefined);
});

test('the text is the cells of the row: tabs move over blanks, wide characters take two cells but are one character, marks join the one before', () => {
	const log = createLineLog();
	const s = scope('/s');
	log.write('a\tb/c.js\n', s);
	assert.deepStrictEqual(log.find('a       b/c.js'), ['/s'], 'to the next multiple of 8');
	log.write('你好 src/w.js\n', s);
	assert.deepStrictEqual(log.find('你好 src/w.js'), ['/s']);
	log.write('é src/m.js\n', s);
	assert.deepStrictEqual(log.find('é src/m.js'), ['/s']);
	log.write('x/\u{1f600}.js\n', s);
	assert.deepStrictEqual(log.find('x/\u{1f600}.js'), ['/s'], 'a character outside the BMP is one');
	// a tab that moves over cells that were not written is a run of blanks; at the end of a line it is nothing
	log.write('a/b.js\t\n', s);
	assert.deepStrictEqual(log.find('a/b.js'), ['/s']);
});

test('what the terminal does to a row: a carriage return and what is written after it, backspace, erase to the end of the row', () => {
	const log = createLineLog();
	const s = scope('/s');
	log.write('abc src/old.js\rXY\n', s);
	assert.deepStrictEqual(log.find('XYc src/old.js'), ['/s'], 'written over from the first column');
	log.write('src/a.js\b\bb.js\n', s);
	assert.deepStrictEqual(log.find('src/a.b.js'), ['/s'], 'backspace moves, it does not erase: the new text is written over the old from there');
	log.write('src/erase.js tail/x.js\b\b\b\b\b\b\b\b' + E + '[K\n', s);
	assert.deepStrictEqual(log.find('src/erase.js t'), ['/s'], 'erase to the end of the row, from where the cursor is');
	assert.strictEqual(log.find('src/erase.js tail/x.js'), undefined);
	// a movement it does not follow leaves what was written as it was: the line is not found as the screen has it, and the
	// caller falls back to the folder the terminal is in
	log.write('movers/a.js' + E + '[5D' + 'Z\n', s);
	assert.strictEqual(log.find('movers/Z.js'), undefined);
	log.write('src/all.js' + E + '[2K\r' + 'new/one.js\n', s);
	assert.deepStrictEqual(log.find('new/one.js'), ['/s'], 'the whole row');
	assert.strictEqual(log.find('src/all.js'), undefined);
	// the cursor stays where it is when the row is erased: what is written next is that far from the start
	// erasing from the second half of a wide character takes the first half too
	log.write('x/a.js\u4f60\b' + E + '[KZ\n', s);
	assert.deepStrictEqual(log.find('x/a.js Z'), ['/s']);
	log.write('src/stay.js' + E + '[2K' + 'next/one.js\n', s);
	assert.deepStrictEqual(log.find(' '.repeat('src/stay.js'.length) + 'next/one.js'), ['/s']);
});

test('escape sequences are not text: colours, links and the terminal\'s own marks vanish, in one piece or across writes', () => {
	const log = createLineLog();
	const s = scope('/s');
	log.write(E + '[1;31msrc/a.js' + E + '[0m:3 ' + E + ']8;;https://x.test/a' + E + '\\link' + E + ']8;;' + E + '\\\n', s);
	assert.deepStrictEqual(log.find('src/a.js:3 link'), ['/s']);
	log.write(E + '[2mdim/b.js', s);
	log.write(E + '[0m' + E + ']633;D;0' + E + '\\\r\n', s);
	assert.deepStrictEqual(log.find('dim/b.js'), ['/s']);
	log.write('cut/c.js' + E, s);
	log.write('[31m' + E + ']0;title\x07 more\n', s);
	assert.deepStrictEqual(log.find('cut/c.js more'), ['/s'], 'a sequence that began at the end of one write and ended in the next');
	// a bare escape and a control are dropped
	log.write('a/\x07\x00b.js\n', s);
	assert.deepStrictEqual(log.find('a/b.js'), ['/s']);
});

test('a line is judged by its first 4,000 characters, and the rest of it is not kept', () => {
	const log = createLineLog();
	const s = scope('/s');
	const head = 'src/a.js ' + ' '.repeat(MAX_LINE - 9);
	log.write(head + 'x'.repeat(50000) + '\n', s);
	assert.deepStrictEqual(log.find(head + 'something else entirely'), ['/s'], 'it is known by the part that is kept: the lookup is cut at the same place');
	assert.deepStrictEqual(log.find('src/a.js'), ['/s'], 'with no blanks that end it');
});

test('when the stretch of output changes, the line that was being written is finished first', () => {
	const log = createLineLog();
	log.write('a/first.js', scope('/one'));
	log.write('b/second.js\n', scope('/two'));
	assert.deepStrictEqual(log.find('a/first.js'), ['/one']);
	assert.deepStrictEqual(log.find('b/second.js'), ['/two']);
});

test('what is written is read in linear time: runs of blanks, line ends, marks, unfinished sequences', () => {
	const worst = everyShape('the line log', (text) => {
		const log = createLineLog();
		log.write(text, scope('/s'));
		log.write('\n', scope('/s'));
		log.find(text);
	});
	assert.ok(worst < 500);
});

test('the text of a line is what xterm.js has in the row: seeded lines of text, tabs, marks, overwrites, erases and colours (when xterm is found)', async () => {
	const xt = needXterm('the line log against xterm.js');
	if (!xt) { return; }
	let seed = 8080;
	const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
	const pick = (a) => a[Math.floor(rnd() * a.length)];
	const parts = ['src/a.js', 'lib/b.ts:12', ' ', '  ', 'x', 'foo', '\t', '\r', '\b', E + '[K', E + '[1K', E + '[2K', E + '[1;31m', E + '[0m', '你', 'e\u0301', '\u{1f600}', '\u2714\ufe0f', E + ']8;;https://x.test' + E + '\\', 'dir/c.md'];
	const lines = [];
	for (let k = 0; k < 300; k++) {
		let text = '';
		for (let i = 0, n = 1 + Math.floor(rnd() * 10); i < n; i++) { text += pick(parts); }
		lines.push(text);
	}
	const rows = 60;
	let compared = 0;
	for (let from = 0; from < lines.length; from += rows - 1) {
		const batch = lines.slice(from, from + rows - 1);
		const term = new xt.Terminal({ cols: 200, rows, allowProposedApi: true, scrollback: 0 });
		term.loadAddon(new xt.Unicode11Addon());
		term.unicode.activeVersion = '11';
		const log = createLineLog();
		const text = batch.map((l) => l + '\r\n').join('');
		log.write(text, scope('/s'));
		await new Promise((r) => term.write(text, r));
		const b = term.buffer.active;
		for (let y = 0; y < batch.length; y++) {
			const shown = b.getLine(y).translateToString(true);
			if (findCandidates(shown).length === 0) { continue; }
			assert.ok(log.find(shown), 'the row of ' + JSON.stringify(batch[y]) + ' is ' + JSON.stringify(shown) + ', and the log does not have it');
			compared++;
		}
		term.dispose();
	}
	assert.ok(compared > 100, 'rows compared: ' + compared);
});

(async () => {
	let n = 0;
	for (const [name, fn] of queue) { await fn(); n++; console.log('  ok - ' + name); }
	console.log(`\n${n} tests passed`);
})().catch((e) => { console.error(e); process.exit(1); });
