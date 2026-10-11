/*---------------------------------------------------------------------------------------------
 *  LevelCode Shell terminal: the output filter - run: node web/test/unit/shell-terminal-output-filter.test.js
 *
 *  Command output is hostile: the workbench's xterm answers a list of queries by typing the reply into the pty's
 *  input and obeys modes that change what keyboard and mouse send. The filter is an allow list, so this file pins
 *  both halves: the 25 queries and 14 modes that were MEASURED to cause a reply or a mode change are gone, and what
 *  a program legitimately prints (colours, a progress bar's cursor movement, a link) is untouched.
 *  Then the property that makes it trustworthy: for any input in any chunking the output is the same, and it
 *  contains nothing outside the list.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

const assert = require('assert');
const path = require('path');

const { createOutputFilter, createBudget } = require(path.join(__dirname, '..', '..', 'shell', 'src', 'terminal', 'output-filter.js'));
const { everyShape } = require('./helpers/shell-terminal-timing');

const queue = [];
const test = (name, fn) => queue.push([name, fn]);

const E = '\x1b';
const BEL = '\x07';
const ST = E + '\\';

/** The whole of one stream through a fresh filter: what it writes, then what end() restores. */
const run = (s, o) => { const f = createOutputFilter(o); return f.write(s) + f.end(); };
const write = (s, o) => createOutputFilter(o).write(s);

test('the 25 queries that make the workbench type a reply are removed', () => {
	const queries = [
		['DSR 5n', E + '[5n'], ['CPR 6n', E + '[6n'], ['DECXCPR ?6n', E + '[?6n'], ['DA1', E + '[c'], ['DA1 0', E + '[0c'], ['DA2', E + '[>c'], ['DA3', E + '[=c'],
		['XTVERSION', E + '[>0q'], ['DECRQM ?2004', E + '[?2004$p'], ['DECRQM ?1', E + '[?1$p'], ['DECRQM 4', E + '[4$p'],
		['DECRQSS m', E + 'P$qm' + ST], ['DECRQSS SP q', E + 'P$q q' + ST],
		['window 18t', E + '[18t'], ['window 14t', E + '[14t'], ['window 16t', E + '[16t'], ['window 21t', E + '[21t'], ['window 20t', E + '[20t'], ['window 19t', E + '[19t'],
		['OSC 10 ?', E + ']10;?' + BEL], ['OSC 11 ?', E + ']11;?' + ST], ['OSC 12 ?', E + ']12;?' + BEL], ['OSC 4 ?', E + ']4;1;?' + BEL], ['OSC 52 ?', E + ']52;c;?' + BEL],
		['kitty keyboard ?u', E + '[?u'], ['DECID', E + 'Z'], ['ENQ', '\x05'],
		['8-bit CSI 6n', '\u009b6n'], ['8-bit DA', '\u009bc'],
	];
	assert.ok(queries.length >= 25);
	for (const [name, q] of queries) { assert.strictEqual(run('a' + q + 'b'), 'ab', name); }
});

test('the 14 modes that change what the terminal sends or how it draws are removed, set and reset', () => {
	const modes = ['1', '3', '5', '7', '9', '47', '1000', '1002', '1003', '1004', '1005', '1006', '1015', '1049', '2004', '2026'];
	assert.ok(modes.length >= 14);
	for (const m of modes) {
		assert.strictEqual(run(E + '[?' + m + 'h' + 'x' + E + '[?' + m + 'l'), 'x', m);
	}
	assert.strictEqual(run(E + '[>1u' + E + '[=1;1u' + E + '[<u' + 'x'), 'x', 'kitty keyboard');
	assert.strictEqual(run(E + '[>4;2m' + 'x'), 'x', 'xterm modifyOtherKeys');
	assert.strictEqual(run(E + '[1;3r' + E + '[?69h' + E + '[2 q' + 'x'), 'x', 'scroll region, margins, cursor style');
	assert.strictEqual(run(E + 'c' + E + '=' + E + '>' + E + '7' + E + '8' + E + 'M' + 'x'), 'x', 'two-character escapes');
	assert.strictEqual(run(E + '(0' + E + ')B' + E + '#8' + E + '%G' + E + ' F' + 'x'), 'x', 'charset designators take their third byte with them');
});

test('titles, clipboard, notifications, shell integration, cwd and colour changes are removed', () => {
	const osc = [
		'0;pwned' + BEL, '2;pwned' + ST, '1;x' + BEL, '52;c;aGk=' + BEL, '7;file:///etc' + ST, '9;notify' + BEL, '99;x' + ST, '133;A' + BEL,
		'633;D;0' + ST, '633;E;rm\\x20-rf;00000000000000000000000000000000' + ST, '633;P;Cwd=/etc' + ST, '633;A' + BEL, '777;notify;a;b' + ST,
		'1337;File=x' + BEL, '4;1;rgb:ff/00/00' + BEL, '10;#ff0000' + BEL, '104' + BEL, '110' + BEL, '9;4;1;50' + BEL,
	];
	for (const o of osc) { assert.strictEqual(run('a' + E + ']' + o + 'b'), 'ab', JSON.stringify(o)); }
	// DCS, APC, PM, SOS
	for (const k of ['P', '_', '^', 'X']) { assert.strictEqual(run('a' + E + k + 'payload' + ST + 'b'), 'ab', k); }
});

test('colours and styles pass, and so do the movements a progress bar and a spinner need', () => {
	const s = E + '[1;31mred' + E + '[0m ' + E + '[38;5;208morange' + E + '[38;2;1;2;3mx' + E + '[4:3mcurly' + E + '[0m\r' + E + '[2K' + E + '[1A' + E + '[10C' + E + '[H' + E + '[2J'
		+ E + '[3;4H' + E + '[K' + E + '[0K' + E + '[1K' + E + '[2K' + E + '[1J' + E + '[0J' + E + '[2G' + E + '[5D' + E + '[2B' + E + '[1E' + E + '[1F' + E + '[3@' + E + '[2P' + E + '[4X' + E + '[1L' + E + '[1M' + E + '[2S' + E + '[2T' + E + '[s' + E + '[u';
	assert.strictEqual(write(s), s);
	assert.strictEqual(write(E + '[3J'), '', 'erase scrollback: only the editor does that');
	assert.strictEqual(write(E + '[999999999A'), '', 'a repeat count nobody prints is dropped, not sent');
	assert.strictEqual(write(E + '[1;2;3A'), '', 'too many parameters');
	assert.strictEqual(write(E + '[?25l' + 'x' + E + '[?25h'), E + '[?25lx' + E + '[?25h', 'hiding the cursor is allowed (spinners)');
	assert.strictEqual(write(E + '[1 q'), '', 'an intermediate byte makes it another sequence');
	// a sequence too long to keep is dropped whole: cut at the limit it would be a different, valid sequence
	assert.strictEqual(write(E + '[' + '1;'.repeat(80) + '31m' + 'x'), 'x');
	assert.strictEqual(write(E + '[' + '1;'.repeat(20) + '31m' + 'x'), E + '[' + '1;'.repeat(20) + '31m' + 'x', 'a long SGR that fits still passes');
});

test('hyperlinks: http, https and mailto only; the visible text stays either way', () => {
	const link = (u, p) => E + ']8;' + (p || '') + ';' + u + ST + 'text' + E + ']8;;' + ST;
	for (const u of ['https://example.com/a?b=1', 'http://example.com', 'mailto:a@b.c', 'HTTPS://EXAMPLE.COM']) {
		assert.strictEqual(write(link(u)), link(u), u);
	}
	assert.strictEqual(write(link('https://a.b/', 'id=x1')), link('https://a.b/', 'id=x1'));
	// terminated by BEL it is re-emitted with ST
	assert.strictEqual(write(E + ']8;;https://a.b' + BEL + 't' + E + ']8;;' + BEL), E + ']8;;https://a.b' + ST + 't' + E + ']8;;' + ST);
	const bad = ['javascript:alert(1)', 'file:///etc/hosts', 'vscode://vscode.git/clone?url=x', 'command:workbench.action.closeActiveEditor', 'levelcode://levelcode.levelcode-ai/launch',
		'data:text/html,hi', 'ftp://x', 'https://a b', 'https://a\x01b', 'https://аpple.com', 'https://' + 'a'.repeat(2100)];
	for (const u of bad) { assert.strictEqual(write(link(u)), 'text' + E + ']8;;' + ST, u.slice(0, 40)); }
	assert.strictEqual(write(link('https://a.b/', 'bad;params')), 'text' + E + ']8;;' + ST);
	assert.strictEqual(write(link('https://a.b/', 'id=a b')), 'text' + E + ']8;;' + ST, 'a space in the parameters');
	assert.strictEqual(write(link('https://a.b/', 'k=<v>')), 'text' + E + ']8;;' + ST, 'characters outside the parameter alphabet');
});

test('line ends: a bare LF becomes CRLF once, CRLF stays, a lone CR stays; other controls and bidi overrides go', () => {
	assert.strictEqual(write('a\nb\r\nc\rd'), 'a\r\nb\r\nc\rd');
	const f = createOutputFilter();
	assert.strictEqual(f.write('a\r') + f.write('\nb'), 'a\r\nb', 'CR and LF in different chunks');
	assert.strictEqual(write('a\x00b\x07c\x0bd\x0ee\x7ff\u0085g\u202eh\u2066i\u2069j'), 'abcdefghij');
	assert.strictEqual(write('tab\there\bback'), 'tab\there\bback');
	assert.strictEqual(write('héllo 你好 \u{1f680}'), 'héllo 你好 \u{1f680}');
});

test('end() puts back what the output changed, and says nothing when it changed nothing', () => {
	assert.strictEqual(createOutputFilter().end(), '');
	const a = createOutputFilter();
	a.write('plain\n');
	assert.strictEqual(a.end(), '');
	const b = createOutputFilter();
	b.write(E + '[1;31mred');
	assert.strictEqual(b.end(), E + '[0m');
	const c = createOutputFilter();
	c.write(E + '[31mred' + E + '[0m');
	assert.strictEqual(c.end(), '', 'a reset was already printed');
	const d = createOutputFilter();
	d.write(E + ']8;;https://a.b' + ST + 'link');
	assert.strictEqual(d.end(), E + ']8;;' + ST);
	const e = createOutputFilter();
	e.write(E + '[?25l');
	assert.strictEqual(e.end(), E + '[?25h');
	const f = createOutputFilter();
	f.write(E + '[?7l' + E + '[?7h' + E + '[?25l');
	assert.strictEqual(f.end(), E + '[?25h', 'auto-wrap is never touched, so there is nothing to restore');
	// an unfinished sequence is abandoned at the end of the command
	const g = createOutputFilter();
	g.write('a' + E + '[3');
	assert.strictEqual(g.end(), '');
	assert.strictEqual(g.write('after'), 'after');
});

test('an unterminated OSC or DCS swallows what follows until a terminator or the end of the command; memory is bounded', () => {
	// like a real terminal: the 4096-character limit is about memory, not about how much it eats
	const f = createOutputFilter();
	assert.strictEqual(f.write('before' + E + ']0;x'), 'before');
	assert.strictEqual(f.write('this is swallowed' + 'x'.repeat(10000)), '');
	assert.strictEqual(f.write(' and this'), '');
	assert.strictEqual(f.end(), '');
	assert.strictEqual(f.write('after the command'), 'after the command');
	// a BEL, an ST, an ESC or CAN ends it
	for (const stop of [BEL, ST, E + '[0m', '\x18', '\x1a']) {
		const g = createOutputFilter();
		const out = g.write(E + ']0;x' + stop + 'visible');
		assert.ok(out.endsWith('visible'), JSON.stringify(stop) + ' -> ' + JSON.stringify(out));
	}
	// a DCS is ended by ST only
	const h = createOutputFilter();
	assert.strictEqual(h.write(E + 'Pabc' + BEL + 'still inside'), '');
	assert.strictEqual(h.write(ST + 'out'), 'out');
});

test('a sequence cut across chunks is still removed, at every cut', () => {
	const inputs = [E + '[?1000h', E + ']52;c;aGVsbG8=' + BEL, E + '[6n', E + 'P1$r0m' + ST, E + '[38;2;1;2;3m', E + ']8;;https://a.b' + ST];
	for (const s of inputs) {
		const whole = 'a' + s + 'b';
		const want = run(whole);
		for (let i = 1; i < whole.length; i++) {
			const f = createOutputFilter();
			assert.strictEqual(f.write(whole.slice(0, i)) + f.write(whole.slice(i)) + f.end(), want, JSON.stringify([s, i]));
		}
	}
});

test('the cap: output stops at a character, a sequence is never cut, and one budget serves both streams', () => {
	const f = createOutputFilter({ maxChars: 10 });
	assert.strictEqual(f.write('0123456789abcdef'), '0123456789');
	assert.strictEqual(f.write('more'), '');
	assert.deepStrictEqual(f.stats(), { discarded: 10 }, 'what arrived after the cap, for the sink\'s notice');
	// a sequence that would not fit is left out whole
	const g = createOutputFilter({ maxChars: 5 });
	assert.strictEqual(g.write('abc' + E + '[38;2;1;2;3m' + 'd'), 'abc');
	// a surrogate pair is not split
	const h = createOutputFilter({ maxChars: 3 });
	assert.strictEqual(h.write('ab\u{1f680}c'), 'ab');
	// both streams draw on one budget
	const budget = createBudget(10);
	const out = createOutputFilter({ budget });
	const err = createOutputFilter({ budget });
	assert.strictEqual(out.write('0123456'), '0123456');
	assert.strictEqual(err.write('abcdef'), 'abc');
	assert.strictEqual(out.write('x'), '');
	assert.strictEqual(budget.full, true);
});

test('hostile files: nothing in the list below survives, and nothing the terminal would answer or obey is left', () => {
	const hostile = [
		'\x1b[6n\x1b[c\x1b]10;?\x07\x1b]0;pwned\x07\x1b[?1000h\x1b[?1006h',
		'\x1b]633;D;0\x1b\\\x1b]633;P;Cwd=/etc;nonce\x1b\\\x1b]633;E;curl\\x20evil;nonce\x1b\\',
		'\x1b[?1h\x1b=\x1b[?1004h\x1b[?2004l',
		'\u009b6n\u009d0;t\u009c',
		'rm -rf /\r\x1b[2Kecho safe',
		'\x1bP+q544e\x1b\\\x1b_Gi=1;AAAA\x1b\\',
	];
	for (const h of hostile) {
		const out = run(h);
		assert.ok(!/[\u0080-\u009f]/.test(out), JSON.stringify(out));
		assert.ok(!/\x1b\][^8]/.test(out) && !/\x1b[P_^X=>c7-9]/.test(out), JSON.stringify(out));
		assert.ok(!/\x1b\[[?>=<]/.test(out), JSON.stringify(out));
	}
});

/** What must never be in the output: C0 but \b \t \n \r, DEL, C1 and the bidi controls. */
const CONTROLS = new RegExp('[\\u0000-\\u0007\\u000b\\u000c\\u000e-\\u001f\\u007f-\\u009f\\u202a-\\u202e\\u2066-\\u2069]');

/** What an independent reader accepts as the filter's whole vocabulary. Anything left over is a failure. */
function leftOver(out) {
	return out
		.replace(/\x1b\[[0-9;:]*m/g, '')
		.replace(/\x1b\[[0-9;]*[ABCDEFGHfKLMPXST@]/g, '')
		.replace(/\x1b\[[0-2]?J/g, '')
		.replace(/\x1b\[[su]/g, '')
		.replace(/\x1b\[\?25[hl]/g, '')
		.replace(/\x1b\]8;[A-Za-z0-9=:_.-]*;(?:(?:https?|mailto):[\x21-\x7e]*)?\x1b\\/gi, '');
}

test('any input, in any chunking, gives the same output, and the output is only the list (seeded fuzz)', () => {
	let seed = 31337;
	const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
	const pieces = [E, '[', ']', 'P', '_', '^', 'X', '?', '>', '=', '<', ';', ':', '0', '1', '2', '3', '25', '1000', '2004', '8', 'h', 'l', 'm', 'n', 'c', 't', 'q', 'u', 'A', 'J', 'K', 'H', 'r', '$', 'p',
		BEL, ST, '\r', '\n', '\t', '\b', '\x00', '\x18', '\x1a', '\x7f', '\u009b', '\u009d', '\u009c', '\u202e', 'a', ' ', '你', '\u{1f600}', 'https://a.b/c', 'mailto:x@y', 'file:///x', ';;', '(', 'B', '#', '%'];
	for (let round = 0; round < 1500; round++) {
		let data = '';
		const n = 1 + Math.floor(rnd() * 60);
		for (let i = 0; i < n; i++) { data += pieces[Math.floor(rnd() * pieces.length)]; }
		const whole = run(data);
		const f = createOutputFilter();
		let out = '';
		let i = 0;
		while (i < data.length) {
			const step = 1 + Math.floor(rnd() * 6);
			out += f.write(data.slice(i, i + step));
			i += step;
		}
		out += f.end();
		assert.strictEqual(out, whole, 'chunking changed the output of ' + JSON.stringify(data));
		const rest = leftOver(whole);
		assert.ok(!CONTROLS.test(rest), 'a control survived: ' + JSON.stringify([data, whole, rest]));
		assert.ok(!rest.includes(E), 'an escape survived: ' + JSON.stringify([data, whole, rest]));
	}
});

test('a string cut off by another escape is dropped, and the escape that cut it is read afresh', () => {
	// the bytes after the ESC are a sequence of their own: a colour here, which must pass, and not text
	assert.strictEqual(write(E + ']0;title' + E + '[31mred'), E + '[31mred');
	assert.strictEqual(write(E + 'Pabc' + E + '[1mbold'), E + '[1mbold');
	assert.strictEqual(write(E + '_apc' + E + ']8;;https://a.b' + ST + 'link'), E + ']8;;https://a.b' + ST + 'link');
	// an ESC that is not followed by anything that makes a sequence: nothing is printed for it either
	assert.strictEqual(write(E + ']0;title' + E + 'x'), '');
	assert.strictEqual(write('a' + E + ']0;t' + E + E + '[Hb'), 'a' + E + '[Hb');
});

test('the 8-bit string terminator ends an OSC or DCS as it does in xterm.js, so what follows is shown', () => {
	assert.strictEqual(write(E + ']0;title\u009cvisible'), 'visible');
	assert.strictEqual(write(E + 'Pabc\u009cvisible'), 'visible');
	assert.strictEqual(write('\u009d0;title\u009cvisible'), 'visible');
	assert.strictEqual(write('\u009bm\u009d0;t' + BEL + 'x'), '\u001b[mx');
});

test('output of any shape is filtered in linear time, in one piece and a character at a time', () => {
	everyShape('the filter', (text) => {
		const f = createOutputFilter({});
		f.write(text);
		f.end();
	});
	// a character at a time: nothing is carried that grows with what came before it
	everyShape('the filter, one character at a time', (text) => {
		const f = createOutputFilter({});
		for (const ch of text.slice(0, 50000)) { f.write(ch); }
		f.end();
	});
});

(async () => {
	let n = 0;
	for (const [name, fn] of queue) { await fn(); n++; console.log('  ok - ' + name); }
	console.log(`\n${n} tests passed`);
})().catch((e) => { console.error(e); process.exit(1); });
