/*---------------------------------------------------------------------------------------------
 *  LevelCode Shell terminal: shell-integration bytes and the output sink - run: node web/test/unit/shell-terminal-sink.test.js
 *
 *  Two small modules every terminal tab depends on:
 *    shell-integration.js   the OSC 633 sequences, escaped the way the workbench unescapes them, with a nonce that is
 *                           random and goes into two sequences only;
 *    output-sink.js         the ordered queue (16 KiB per macrotask) and one run's output: a filter per stream,
 *                           one cap, a newline before whatever comes next.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

const assert = require('assert');
const path = require('path');

const dir = path.join(__dirname, '..', '..', 'shell', 'src', 'terminal');
const si = require(path.join(dir, 'shell-integration.js'));
const { createWriter, createRunOutput, CHUNK, OUTPUT_LIMIT, RESET_TAIL } = require(path.join(dir, 'output-sink.js'));

const queue = [];
const test = (name, fn) => queue.push([name, fn]);
const E = '\x1b';
const ST = E + '\\';

/** The workbench's own reader (shellIntegrationAddon.ts deserializeVSCodeOscMessage). */
const deserialize = (m) => m.replace(/\\(\\|x([0-9a-f]{2}))/gi, (_x, op, hex) => (hex ? String.fromCharCode(parseInt(hex, 16)) : op));

test('values are escaped so that the workbench reads back exactly what was meant, and cannot be ended early', () => {
	const samples = ['plain', 'a b', 'a;b', 'a\\b', 'line1\nline2', 'tab\there', 'esc' + E + '[0m', 'bell\x07', 'del\x7f', 'c1\u009c', '\\x41', 'multi\r\nline', '', ';;;', '\\\;'];
	for (const v of samples) {
		const e = si.escapeValue(v);
		assert.ok(!/[;\x00-\x20\x7f-\x9f]/.test(e), JSON.stringify(e) + ' still has a character that could end the field');
		assert.strictEqual(deserialize(e), v, JSON.stringify(v));
	}
	assert.strictEqual(si.escapeValue('a b;c\\d\n'), 'a\\x20b\\x3bc\\\\d\\x0a');
});

test('the sequences are written exactly as the workbench documents them', () => {
	const nonce = '0123456789abcdef0123456789abcdef';
	assert.strictEqual(si.promptStart(), E + ']633;A' + ST);
	assert.strictEqual(si.promptEnd(), E + ']633;B' + ST);
	assert.strictEqual(si.executed(), E + ']633;C' + ST);
	assert.strictEqual(si.finished(3), E + ']633;D;3' + ST);
	assert.strictEqual(si.finished(NaN), E + ']633;D;0' + ST);
	assert.strictEqual(si.commandLine('echo a;b', nonce), E + ']633;E;echo\\x20a\\x3bb;' + nonce + ST);
	assert.strictEqual(si.cwd('/scratch/my dir', nonce), E + ']633;P;Cwd=/scratch/my\\x20dir;' + nonce + ST);
	assert.strictEqual(si.property('HasRichCommandDetection', 'True'), E + ']633;P;HasRichCommandDetection=True' + ST);
	// a very long command is cut for the sequence
	const long = si.commandLine('x'.repeat(5000), nonce);
	assert.ok(long.length < 2200);
});

test('the nonce is 128 random bits from getRandomValues, once, and there is no fallback', () => {
	const calls = [];
	const rv = (a) => { calls.push(a.length); a.fill(0xab); return a; };
	assert.strictEqual(si.createNonce(rv), 'ab'.repeat(16));
	assert.deepStrictEqual(calls, [16]);
	assert.throws(() => si.createNonce(() => { throw new Error('no crypto'); }), /no crypto/);
	const src = require('fs').readFileSync(path.join(dir, 'shell-integration.js'), 'utf8');
	assert.ok(!/Math\.random\s*\(/.test(src), 'a guessable nonce is worth nothing');
});

test('the writer keeps order: a small write waits behind a large one, and a write while idle is immediate', () => {
	const fired = [];
	const tasks = [];
	const w = createWriter({ fire: (s) => fired.push(s), schedule: (f) => tasks.push(f), chunk: 8 });
	w.write('ab');
	assert.deepStrictEqual(fired, ['ab']);
	w.write('0123456789ABCDEF');                        // 16: two chunks
	w.write('xy');                                      // small, but there is a queue
	assert.deepStrictEqual(fired, ['ab']);
	assert.strictEqual(tasks.length, 1);
	while (tasks.length) { tasks.shift()(); }
	assert.deepStrictEqual(fired, ['ab', '01234567', '89ABCDEF', 'xy']);
	w.write('0123456789');
	w.clear();
	while (tasks.length) { tasks.shift()(); }
	assert.deepStrictEqual(fired, ['ab', '01234567', '89ABCDEF', 'xy'], 'what was cleared is not written');
});

test('the writer never splits a surrogate pair between two fires', () => {
	const fired = [];
	const tasks = [];
	const w = createWriter({ fire: (s) => fired.push(s), schedule: (f) => tasks.push(f), chunk: 4 });
	w.write('abc\u{1f680}\u{1f680}def');               // a pair would straddle the cut after 'abc'
	while (tasks.length) { tasks.shift()(); }
	assert.strictEqual(fired.join(''), 'abc\u{1f680}\u{1f680}def');
	for (const f of fired) { assert.ok(!/[\ud800-\udbff]$/.test(f) && !/^[\udc00-\udfff]/.test(f), JSON.stringify(f)); }
	assert.strictEqual(CHUNK, 16384);
	assert.strictEqual(OUTPUT_LIMIT, 1048576);
});

test('a run\'s output: LF to CRLF, a newline before what follows, resets at the end, and one cap for both streams', () => {
	const out = [];
	const r = createRunOutput({ write: (s) => out.push(s) });
	r.write('stdout', 'one\ntwo');
	r.write('stderr', E + '[31merr');
	assert.strictEqual(out.join(''), 'one\r\ntwo' + E + '[31merr');
	assert.strictEqual(r.end(), E + '[0m' + '\r\n');
	const clean = createRunOutput({ write: () => { } });
	clean.write('stdout', 'done\n');
	assert.strictEqual(clean.end(), '', 'nothing to put back, already at a line start');
	const none = createRunOutput({ write: () => { } });
	assert.strictEqual(none.end(), '', 'a command that printed nothing');

	const capped = createRunOutput({ write: () => { }, limit: 20 });
	capped.write('stdout', 'x'.repeat(15));
	capped.write('stderr', 'y'.repeat(15));
	assert.ok(/\[output limit reached: 10 more characters were not shown\]/.test(capped.end()));
});

test('one stream\'s unfinished escape cannot swallow the other stream, and ends with the command', () => {
	const out = [];
	const r = createRunOutput({ write: (s) => out.push(s) });
	r.write('stdout', 'before' + E + ']0;never terminated');
	r.write('stderr', 'error: still visible\n');
	r.write('stdout', 'swallowed');
	assert.strictEqual(out.join(''), 'beforeerror: still visible\r\n');
	r.end();
});

test('the line break at the end follows the writer that wrote last: stderr after a stdout that ended a line', () => {
	const out = [];
	const r = createRunOutput({ write: (s) => out.push(s) });
	r.write('stdout', 'one\n');
	r.write('stderr', 'partial');
	assert.strictEqual(r.end(), '\r\n', 'the prompt would otherwise erase the unfinished line of stderr');
	const back = createRunOutput({ write: () => { } });
	back.write('stderr', 'err\n');
	back.write('stdout', 'partial');
	assert.strictEqual(back.end(), '\r\n');
	const clean = createRunOutput({ write: () => { } });
	clean.write('stdout', 'partial');
	clean.write('stderr', 'whole\n');
	assert.strictEqual(clean.end(), '', 'the last text shown ended a line');
});

test('say(): the terminal\'s own words in the middle of a run, and the line state follows them', () => {
	const out = [];
	const r = createRunOutput({ write: (s) => out.push(s) });
	r.say('');
	assert.deepStrictEqual(out, []);
	r.write('stdout', 'a\n');
	r.say('\x1b[2mnote\x1b[0m');
	assert.strictEqual(r.end(), '\r\n', 'a notice that did not end its line is followed by a break');
	const t = createRunOutput({ write: () => { } });
	t.write('stdout', 'partial');
	t.say('\r\nnotice\r\n');
	assert.strictEqual(t.end(), '', 'and one that did, is not');
});

test('interrupt(): the terminal is put back unconditionally, ^C is where the output stopped, nothing more is shown, and one break follows', () => {
	assert.strictEqual(RESET_TAIL, E + '[0m' + E + ']8;;' + ST + E + '[?25h');
	const out = [];
	const r = createRunOutput({ write: (s) => out.push(s) });
	r.write('stdout', 'abc' + E + '[31m' + E + ']8;;http://example.com' + ST + E + '[?25l' + 'def' + E + ']0;never ended');
	out.length = 0;
	r.interrupt();
	assert.deepStrictEqual(out, [RESET_TAIL, E + '[2m^C' + E + '[0m']);
	r.write('stdout', 'late');
	r.write('stderr', 'late');
	assert.strictEqual(out.length, 2, 'what comes after is not shown');
	assert.strictEqual(r.end(), '\r\n', 'what the filters had open was dropped with them: only the break');
	// an interrupt before any output: the same
	const empty = createRunOutput({ write: () => { } });
	empty.interrupt();
	assert.strictEqual(empty.end(), '\r\n');
});

test('charge(): text shown outside the filters counts against the run\'s cap', () => {
	const r = createRunOutput({ write: () => { }, limit: 100 });
	assert.strictEqual(r.charge('x'.repeat(60)), 'x'.repeat(60));
	r.write('stdout', 'y'.repeat(60));
	assert.ok(/\[output limit reached: 20 more characters were not shown\]/.test(r.end()), 'the output had 40 characters left, not 100');
});

(async () => {
	let n = 0;
	for (const [name, fn] of queue) { await fn(); n++; console.log('  ok - ' + name); }
	console.log(`\n${n} tests passed`);
})().catch((e) => { console.error(e); process.exit(1); });
