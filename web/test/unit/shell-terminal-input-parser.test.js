/*---------------------------------------------------------------------------------------------
 *  LevelCode Shell terminal: the input parser - run: node web/test/unit/shell-terminal-input-parser.test.js
 *
 *  What Pseudoterminal.handleInput receives is keys, and the REPORTS the workbench's xterm types on its own
 *  (cursor position, device attributes, window size, mode status, mouse, focus). The parser has to tell them apart
 *  without a pattern that eats a key: Shift+Tab, Delete, PageUp, PageDown and the bracketed-paste markers all end in
 *  a letter or tilde that a "drop anything that looks like a reply" regex also matches. This file pins:
 *    - the byte table (measured on macOS in the release build) -> key events;
 *    - every reply shape that was observed is swallowed and never becomes text, in any chunking;
 *    - the keys that a sloppy pattern would eat still arrive;
 *    - paste: one event, split chunks, the cap, and a chunk of plain text that carries a line end;
 *    - noise cannot make it throw, hang, or produce a control character as text.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

const assert = require('assert');
const path = require('path');

const { createInputParser } = require(path.join(__dirname, '..', '..', 'shell', 'src', 'terminal', 'input-parser.js'));
const { everyShape } = require('./helpers/shell-terminal-timing');

const queue = [];
const test = (name, fn) => queue.push([name, fn]);

const E = '\x1b';
const BEL = '\x07';
const ST = E + '\\';

/** Feed chunks, then flush (as the pty's timer does); every event. */
function parse(...chunks) {
	const p = createInputParser();
	const out = [];
	for (const c of chunks) { out.push(...p.feed(c)); }
	out.push(...p.flush());
	return out;
}
const one = (s) => { const r = parse(s); assert.strictEqual(r.length, 1, JSON.stringify([s, r])); return r[0]; };
const key = (k, mods) => Object.assign({ t: 'key', key: k }, mods);

test('the byte table, as the release build sends it on macOS', () => {
	const table = [
		['\r', key('enter')],                       // Enter, Shift+Enter and Ctrl+Enter all send CR
		['\n', key('enter')],                       // Ctrl+J
		['\x7f', key('backspace')],
		['\b', key('backspace', { ctrl: true })],   // Ctrl+Backspace and Ctrl+H
		['\t', key('tab')],
		[E + '[Z', key('tab', { shift: true })],
		[E + '[3~', key('delete')],
		[E + '[3;5~', key('delete', { ctrl: true })],
		[E + 'd', key('d', { alt: true })],         // Alt+Delete on macOS
		[E + '[A', key('up')], [E + '[B', key('down')], [E + '[C', key('right')], [E + '[D', key('left')],
		[E + 'OA', key('up')], [E + 'OB', key('down')], [E + 'OC', key('right')], [E + 'OD', key('left')],   // after DECCKM
		[E + '[1;5D', key('left', { ctrl: true })], [E + '[1;5C', key('right', { ctrl: true })],
		[E + '[1;3D', key('left', { alt: true })], [E + '[1;2A', key('up', { shift: true })],
		[E + 'b', key('b', { alt: true })], [E + 'f', key('f', { alt: true })],   // Option+Left / Option+Right
		[E + '[H', key('home')], [E + '[F', key('end')], [E + 'OH', key('home')], [E + 'OF', key('end')],
		[E + '[1~', key('home')], [E + '[4~', key('end')], [E + '[7~', key('home')], [E + '[8~', key('end')],
		[E + '[2~', key('insert')], [E + '[5~', key('pageup')], [E + '[6~', key('pagedown')],
		['\x01', key('a', { ctrl: true })], ['\x03', key('c', { ctrl: true })], ['\x04', key('d', { ctrl: true })],
		['\x05', key('e', { ctrl: true })], ['\x0b', key('k', { ctrl: true })], ['\x0c', key('l', { ctrl: true })],
		['\x15', key('u', { ctrl: true })],         // Ctrl+U and Cmd+Backspace
		['\x17', key('w', { ctrl: true })],         // Ctrl+W and Option+Backspace
		[E + '\x7f', key('backspace', { alt: true })],
		[E, key('escape')],
	];
	for (const [bytes, want] of table) { assert.deepStrictEqual(one(bytes), want, JSON.stringify(bytes)); }
});

test('printable text keeps whole code points; control characters split it', () => {
	assert.deepStrictEqual(parse('héllo 你好 \u{1f680}'), [{ t: 'text', s: 'héllo 你好 \u{1f680}' }]);
	assert.deepStrictEqual(parse('a\x01b'), [{ t: 'text', s: 'a' }, key('a', { ctrl: true }), { t: 'text', s: 'b' }]);
	const rocket = '\u{1f680}';
	assert.deepStrictEqual(parse(rocket[0], rocket[1]), [{ t: 'text', s: rocket }], 'a surrogate pair split across chunks');
	assert.deepStrictEqual(parse('a\ud83d'), [{ t: 'text', s: 'a' }], 'a lone surrogate is never text');
});

test('every report the workbench was seen to type is swallowed, whatever the chunking', () => {
	const reports = [
		E + '[1;1R', E + '[24;80R', E + '[?1;1R',                 // cursor position
		E + '[0n', E + '[3n',                                      // status
		E + '[?1;2c', E + '[>0;276;0c', E + '[?62;4c',             // device attributes
		E + '[8;17;192t', E + '[4;300;800t', E + '[6;17;9t',      // window size reports
		E + '[?2004;2$y', E + '[?1;2$y', E + '[4;1$y',             // mode status
		E + 'P>|xterm.js(6.1.0-beta.285)' + ST,                    // XTVERSION
		E + 'P1$r0m' + ST,                                         // DECRQSS
		E + ']10;rgb:1b1b/1c1c/2222' + ST, E + ']11;rgb:ffff/ffff/ffff' + BEL, E + ']4;1;rgb:cc/00/00' + ST,
		E + ']52;c;aGVsbG8=' + BEL,                                 // OSC 52 read-back
		E + '[?0u',                                                // kitty keyboard
		E + '[<0;42;3M', E + '[<0;42;3m', E + '[<64;10;5M',      // SGR mouse
		E + '[M !!',                                               // X10 mouse (three bytes after ESC[M)
		E + '[I', E + '[O',                                        // focus in and out
	];
	for (const r of reports) {
		const ev = parse(r);
		assert.ok(ev.length > 0 && ev.every((e) => e.t === 'ignored'), JSON.stringify([r, ev]));
		// cut in two at every position: still nothing but ignored events, and never text
		for (let i = 1; i < r.length; i++) {
			const cut = parse(r.slice(0, i), r.slice(i));
			assert.ok(cut.every((e) => e.t === 'ignored'), JSON.stringify([r, i, cut]));
		}
	}
	// what is typed right after one is still typed
	assert.deepStrictEqual(parse(E + '[1;1Rls'), [{ t: 'ignored', kind: 'reply' }, { t: 'text', s: 'ls' }]);
	assert.deepStrictEqual(parse(E + ']0;pwned' + BEL + 'x'), [{ t: 'ignored', kind: 'reply' }, { t: 'text', s: 'x' }]);
});

test('the keys a "drop what looks like a reply" pattern would eat arrive: Shift+Tab, Delete, PageUp, PageDown, paste markers', () => {
	assert.deepStrictEqual(parse(E + '[Z'), [key('tab', { shift: true })]);
	assert.deepStrictEqual(parse(E + '[3~'), [key('delete')]);
	assert.deepStrictEqual(parse(E + '[5~'), [key('pageup')]);
	assert.deepStrictEqual(parse(E + '[6~'), [key('pagedown')]);
	assert.deepStrictEqual(parse(E + '[200~hi' + E + '[201~'), [{ t: 'paste', s: 'hi', size: 2 }]);
	// a cursor-position report and a key in one chunk: the report goes, the key stays
	assert.deepStrictEqual(parse(E + '[5;9R' + E + '[3~'), [{ t: 'ignored', kind: 'reply' }, key('delete')]);
});

test('a sequence cut by the end of a chunk waits for the rest; a lone ESC becomes Escape only when flushed', () => {
	const p = createInputParser();
	assert.deepStrictEqual(p.feed(E + '[1;'), []);
	assert.strictEqual(p.hasPending(), true);
	assert.deepStrictEqual(p.feed('5D'), [key('left', { ctrl: true })]);
	assert.strictEqual(p.hasPending(), false);
	assert.deepStrictEqual(p.feed(E), []);
	assert.strictEqual(p.hasPending(), true);
	assert.deepStrictEqual(p.flush(), [key('escape')]);
	// ESC followed by more input in the next chunk is an Alt key, not Escape
	assert.deepStrictEqual(parse(E, 'b'), [key('b', { alt: true })]);
	// noise left by a sequence that never finished is dropped
	assert.deepStrictEqual(parse(E + '[12;3'), [{ t: 'ignored', kind: 'unknown' }]);
	assert.deepStrictEqual(parse(E + ']0;title'), [{ t: 'ignored', kind: 'unknown' }]);
});

test('bracketed paste: one event, however the chunks split it, and keys inside it are text', () => {
	assert.deepStrictEqual(parse(E + '[200~one\rtwo\rthree' + E + '[201~'), [{ t: 'paste', s: 'one\rtwo\rthree', size: 13 }]);
	assert.deepStrictEqual(parse(E + '[200~one\r', 'two' + E + '[20', '1~x'), [{ t: 'paste', s: 'one\rtwo', size: 7 }, { t: 'text', s: 'x' }]);
	assert.deepStrictEqual(parse(E + '[200~' + E + '[A' + E + '[201~'), [{ t: 'paste', s: E + '[A', size: 3 }]);
	const whole = E + '[200~a b\tc' + E + '[201~';
	for (let i = 1; i < whole.length; i++) {
		assert.deepStrictEqual(parse(whole.slice(0, i), whole.slice(i)), [{ t: 'paste', s: 'a b\tc', size: 5 }], 'cut at ' + i);
	}
	assert.deepStrictEqual(parse(E + '[201~'), [], 'a stray end marker is nothing');
	// the paste ends at the first end marker: what follows is typed, not pasted
	assert.deepStrictEqual(parse(E + '[200~a' + E + '[201~' + E + '[200~b' + E + '[201~'), [{ t: 'paste', s: 'a', size: 1 }, { t: 'paste', s: 'b', size: 1 }]);
});

test('a paste over the cap arrives as its size only: the bytes are not kept', () => {
	const p = createInputParser({ maxPaste: 10 });
	assert.deepStrictEqual(p.feed(E + '[200~' + 'x'.repeat(10) + E + '[201~'), [{ t: 'paste', s: 'x'.repeat(10), size: 10 }]);
	assert.deepStrictEqual(p.feed(E + '[200~' + 'x'.repeat(11) + E + '[201~'), [{ t: 'paste', s: '', size: 11 }]);
	// over the cap across chunks: the size is still counted
	assert.deepStrictEqual(p.feed(E + '[200~' + 'x'.repeat(8)), []);
	assert.deepStrictEqual(p.feed('y'.repeat(8) + E + '[201~'), [{ t: 'paste', s: '', size: 16 }]);
});

test('a chunk of plain characters that carries a line end is a paste, never a typed line', () => {
	assert.deepStrictEqual(parse('rm -rf x\r'), [{ t: 'paste', s: 'rm -rf x\r', size: 9 }]);
	assert.deepStrictEqual(parse('a\nb'), [{ t: 'paste', s: 'a\nb', size: 3 }]);
	// one key is one chunk: a lone Enter is still Enter
	assert.deepStrictEqual(parse('\r'), [key('enter')]);
	// a chunk with an escape in it is parsed as keys
	assert.deepStrictEqual(parse('ab\r' + E + '[A'), [{ t: 'text', s: 'ab' }, key('enter'), key('up')]);
});

test('8-bit C1 introducers are read like their 7-bit forms; no C1 character is ever text', () => {
	assert.deepStrictEqual(parse('\u009b6;1R' + 'x'), [{ t: 'ignored', kind: 'reply' }, { t: 'text', s: 'x' }]);
	assert.deepStrictEqual(parse('\u009d0;t\u009c' + 'x'), [{ t: 'ignored', kind: 'reply' }, { t: 'text', s: 'x' }]);
	for (let c = 0x80; c <= 0x9f; c++) {
		assert.ok(parse('a' + String.fromCharCode(c) + 'b').every((e) => e.t !== 'text' || !/[\u0080-\u009f]/.test(e.s)));
	}
});

test('a string that never ends cannot hold the keyboard for ever', () => {
	const p = createInputParser();
	const ev = p.feed(E + ']0;' + 'x'.repeat(5000) + 'after');
	assert.ok(ev.some((e) => e.t === 'ignored'));
	assert.ok(!p.hasPending(), 'the string state was abandoned');
	// and an over-long CSI is swallowed whole, not cut into a different sequence
	const long = E + '[' + '1;'.repeat(100) + 'm';
	assert.deepStrictEqual(parse(long).filter((e) => e.t !== 'ignored'), []);
});

test('noise cannot throw, hang or make a control character text (seeded)', () => {
	let seed = 20261011;
	const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
	const pieces = [E, '[', ']', 'P', 'O', '?', ';', '0', '1', '2', '5', '~', 'R', 'c', 'n', 't', 'y', '$', BEL, ST, '\r', '\n', '\x7f', '\u009b', '\u009c', 'a', ' ', '你', '\u{1f600}', '200~', '201~', '<', 'M', 'm'];
	for (let round = 0; round < 400; round++) {
		const p = createInputParser();
		let data = '';
		for (let i = 0; i < 40; i++) { data += pieces[Math.floor(rnd() * pieces.length)]; }
		const events = [];
		let i = 0;
		while (i < data.length) {
			const step = 1 + Math.floor(rnd() * 5);
			events.push(...p.feed(data.slice(i, i + step)));
			i += step;
		}
		events.push(...p.flush());
		for (const e of events) {
			if (e.t === 'text') { assert.ok(!/[\u0000-\u001f\u007f-\u009f]/.test(e.s), JSON.stringify([data, e])); }
		}
		assert.strictEqual(p.hasPending(), false);
	}
});

test('a CSI longer than 64 parameter bytes is ignored whole, never dispatched as the key its last byte names', () => {
	const params = (n) => '1;'.repeat(Math.floor(n / 2)) + (n % 2 ? '1' : '');
	for (const [final, name] of [['A', 'up'], ['Z', 'tab'], ['D', 'left'], ['H', 'home']]) {
		assert.strictEqual(parse(E + '[' + params(64) + final).filter((e) => e.t === 'key').length, 1, name + ' with exactly 64: it is a key');
		assert.deepStrictEqual(parse(E + '[' + params(65) + final), [{ t: 'ignored', kind: 'unknown' }], name + ' with 65: not');
		assert.deepStrictEqual(parse(E + '[' + params(500) + final), [{ t: 'ignored', kind: 'unknown' }], name + ' with 500: not');
	}
	assert.deepStrictEqual(parse(E + '[' + params(100) + '~'), [{ t: 'ignored', kind: 'unknown' }]);
});

test('ESC ESC is Escape and the start of an escape; ESC O ESC drops the SS3 and starts one', () => {
	assert.deepStrictEqual(parse(E + E), [key('escape'), key('escape')]);
	assert.deepStrictEqual(parse(E + E + '[A'), [key('escape'), key('up')]);
	assert.deepStrictEqual(parse(E + 'O' + E + '[A'), [{ t: 'ignored', kind: 'unknown' }, key('up')], 'the keys after a cut-off SS3 are not lost');
	assert.deepStrictEqual(parse(E + 'OA'), [key('up')]);
});

test('input of any shape is parsed in linear time: as typed text, as a paste, and in single characters', () => {
	everyShape('the parser', (text) => {
		createInputParser({ maxPaste: 1e9 }).feed(text);
		createInputParser({ maxPaste: 1e9 }).feed(E + '[200~' + text + E + '[201~');
	});
	everyShape('the parser, a character at a time', (text) => {
		const p = createInputParser({ maxPaste: 1e9 });
		for (const ch of text.slice(0, 50000)) { p.feed(ch); }
		p.flush();
	});
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
