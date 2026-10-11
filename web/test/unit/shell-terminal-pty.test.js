/*---------------------------------------------------------------------------------------------
 *  LevelCode Shell terminal: the Pseudoterminal - run: node web/test/unit/shell-terminal-pty.test.js
 *
 *  A ShellPty is driven the way the workbench drives one (open, handleInput, setDimensions, close) over a fake
 *  session, and what it writes is read back through a terminal model. Bytes in, bytes out:
 *    - the prompt, the banner, history, multi-line input, paste, Ctrl+C, `exit`;
 *    - the shell-integration marks, with a nonce that is different in every terminal and appears in two places only;
 *    - the engine's 126 and 124 and its notes as a human line;
 *    - hostile output (a file full of escapes) makes the terminal type nothing and change no mode: checked against the
 *      real xterm.js when it is around, with the unfiltered text as the control;
 *    - output is written in 16 KiB macrotask chunks, in order, capped at 1 MiB with a visible notice;
 *    - Ctrl+C: the terminal is put back whatever was queued, `^C` has its own line break, only Ctrl+C interrupts, and
 *      a run that does not end (applying its changes) is let go of by a second Ctrl+C after it has been said;
 *    - a line is not scanned for secrets for longer than a bounded part of it, and once.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

const assert = require('assert');
const path = require('path');

const { makePty, fakeSession, settle, TERMINAL } = require('./helpers/shell-terminal-fakes');
const { needXterm } = require('./helpers/shell-terminal-xterm');
const { everyShape } = require('./helpers/shell-terminal-timing');
const { exitRule, outcomeLine } = require(path.join(TERMINAL, 'pty.js'));
const { cwdLabel, promptFor } = require(path.join(TERMINAL, 'prompt.js'));
const sanitize = require(path.join(TERMINAL, '..', 'sanitize.js'));

const queue = [];
const test = (name, fn) => queue.push([name, fn]);
const E = '\x1b';
const ST = E + '\\';
const DIM = E + '[2m';
const RESET = E + '[0m';
const paste = (s) => E + '[200~' + s + E + '[201~';
const OSC633 = /\x1b\]633;([A-Z]+)(?:;([^\x1b]*))?\x1b\\/g;

/** The shell-integration sequences in what was written, in order: [letter, argument]. */
function marks(text) {
	const out = [];
	for (const m of text.matchAll(OSC633)) { out.push([m[1], m[2]]); }
	return out;
}

test('open with no dimensions uses 80x24 until they arrive; the banner says what exists and what does not', () => {
	const h = makePty({ open: undefined, cols: 80, rows: 24 });
	// makePty passes dims by default; open again is a no-op, so build one that is opened by hand
	const g = makePty({ open: false });
	g.pty.open(undefined);
	const text = g.all();
	assert.ok(text.startsWith(E + '[?2004h'), 'bracketed paste is switched on first, for the life of the tab');
	assert.ok(/bash over the files of this workspace/.test(text));
	assert.ok(/no node, npm, git or python, no network, no background jobs/.test(text));
	assert.ok(/Type help/.test(text));
	assert.deepStrictEqual(g.vt.text().slice(-1), ['scratch $'], 'the prompt: the workspace folder by name');
	// setDimensions after open redraws at the real size
	g.pty.setDimensions({ columns: 40, rows: 10 });
	assert.deepStrictEqual(g.vt.text().slice(-1), ['scratch $']);
	assert.ok(h.pty);
});

test('a line is run in the session with the terminal width; its output, then the next prompt, then the status marker', async () => {
	const h = makePty();
	h.type('echo hi', '\r');
	assert.strictEqual(h.session.calls.length, 1);
	assert.strictEqual(h.session.calls[0].script, 'echo hi');
	assert.strictEqual(h.session.calls[0].o.cols, 60);
	h.session.pending.o.onStdout('hi\n');
	h.timers.drain();
	assert.deepStrictEqual(h.screen().slice(-2), ['scratch $ echo hi', 'hi']);
	h.session.finish({ exitCode: 0 });
	await settle(); h.timers.drain();
	assert.deepStrictEqual(h.screen().slice(-3), ['scratch $ echo hi', 'hi', 'scratch $']);
	h.type('false', '\r');
	h.session.finish({ exitCode: 1 });
	await settle(); h.timers.drain();
	assert.strictEqual(h.screen().slice(-1)[0], 'scratch [1] $', 'a failed command is marked in the prompt');
	h.type('true', '\r');
	h.session.finish({ exitCode: 0 });
	await settle(); h.timers.drain();
	assert.strictEqual(h.screen().slice(-1)[0], 'scratch $', 'and the mark goes away with the next success');
});

test('the prompt names the folder, collapses a long path, shows a path outside every folder, and never trusts the name', () => {
	const f = [{ name: 'proj', root: '/proj' }, { name: 'other', root: '/other' }];
	assert.strictEqual(cwdLabel('/proj', f, 80, sanitize), 'proj');
	assert.strictEqual(cwdLabel('/proj/src/lib', f, 80, sanitize), 'proj/src/lib');
	assert.strictEqual(cwdLabel('/other/docs', f, 80, sanitize), 'other/docs', 'a second folder of the workspace');
	assert.strictEqual(cwdLabel('/tmp/x', f, 80, sanitize), '/tmp/x', 'outside every folder: the absolute path');
	assert.strictEqual(cwdLabel('/proj/aaaa/bbbb/cccc/dddd/eeee', f, 40, sanitize), '.../dddd/eeee');
	// a directory name is untrusted: an escape in it is shown as a picture, never sent
	const hostile = cwdLabel('/proj/' + E + '[6n' + '‮', f, 80, sanitize);
	assert.ok(!hostile.includes(E) && !hostile.includes('‮'), JSON.stringify(hostile));
	assert.ok(hostile.includes('␛'));
	// a name with a newline stays on one row
	assert.ok(!/[\r\n]/.test(cwdLabel('/proj/a\nb', f, 80, sanitize)));
	// the prompt always fits: a terminal narrower than the label gets the short one
	const tiny = promptFor({ cwd: '/proj/aaaaaaaaaaaaaaaa', folders: f, status: 0, columns: 8, sanitize });
	assert.strictEqual(tiny, '$ ');
});

test('a prompt that is too wide for the terminal falls back instead of wrapping', () => {
	const h = makePty({ cwd: '/scratch/' + 'd'.repeat(80), cols: 20 });
	h.type('echo x', '\r');
	h.session.finish({ cwd: '/scratch/' + 'd'.repeat(80) });
	return settle().then(() => {
		h.timers.drain();
		const last = h.screen().slice(-1)[0];
		assert.ok(last.length <= 19, last);
	});
});

test('shell integration: A B before the prompt, E C around the run, D and the cwd after it; the nonce in two places only', async () => {
	const h = makePty();
	const nonce = h.pty.nonce;
	assert.ok(/^[0-9a-f]{32}$/.test(nonce), nonce);
	h.type('echo a;b', '\r');
	h.session.finish({ exitCode: 3, cwd: '/scratch/src' });
	await settle(); h.timers.drain();
	const m = marks(h.all());
	const letters = m.map((x) => x[0]);
	// the opening prompt (A B), then property lines, then the run
	assert.deepStrictEqual(letters.filter((l) => l !== 'P'), ['A', 'B', 'E', 'C', 'D', 'A', 'B']);
	const e = m.find((x) => x[0] === 'E');
	assert.strictEqual(e && e[1], 'echo\\x20a\\x3bb;' + nonce, 'the line is escaped as the workbench reads it; the nonce is last');
	assert.deepStrictEqual(m.find((x) => x[0] === 'D'), ['D', '3']);
	const cwds = m.filter((x) => x[0] === 'P' && /^Cwd=/.test(x[1] || ''));
	assert.strictEqual(cwds[cwds.length - 1][1], 'Cwd=/scratch/src;' + nonce);
	// everywhere else the nonce is nowhere
	const without = h.all().split(nonce).length - 1;
	assert.strictEqual(without, 1 + cwds.length, 'one in E, and one in each Cwd');
	assert.ok(!h.all().replace(OSC633, '').includes(nonce));
	// and the properties the workbench is told once
	assert.ok(h.all().includes(E + ']633;P;HasRichCommandDetection=True' + ST));
	assert.ok(h.all().includes(E + ']633;P;ContinuationPrompt=>\\x20' + ST));
});

test('the nonce is random per terminal, from getRandomValues, and is never a constant', () => {
	let calls = 0;
	const rv = (a) => { calls++; for (let i = 0; i < a.length; i++) { a[i] = (calls * 37 + i * 11) & 255; } return a; };
	const a = makePty({ getRandomValues: rv });
	const b = makePty({ getRandomValues: rv });
	assert.strictEqual(calls, 2);
	assert.notStrictEqual(a.pty.nonce, b.pty.nonce);
	// with the real generator: a hundred terminals, a hundred nonces
	const seen = new Set();
	for (let i = 0; i < 100; i++) { seen.add(makePty().pty.nonce); }
	assert.strictEqual(seen.size, 100);
});

test('a command line with escapes in it cannot end its own sequence: control characters and ; are escaped', async () => {
	const h = makePty();
	h.type(paste('echo "\u001b]633;D;0\u0007"\necho x;y\\z'));
	h.type('\r');
	await settle();
	const e = marks(h.all()).find((x) => x[0] === 'E');
	assert.ok(e && !/[\x00-\x1f\x7f-\x9f]/.test(e[1] || ''), JSON.stringify(e));
	assert.strictEqual(h.session.calls[0].script.includes('\n'), true, 'the script itself goes to the engine whole');
});

test('a command that looks like it carries a secret is announced to the workbench without its text', async () => {
	const h = makePty();
	const secret = 'export API_' + 'KEY=' + 'hunter2hunter2';
	h.type(secret, '\r');
	h.session.finish();
	await settle(); h.timers.drain();
	const e = marks(h.all()).find((x) => x[0] === 'E');
	assert.strictEqual(e && e[1], ';' + h.pty.nonce, 'an empty command line');
	assert.ok(!marks(h.all()).some((m) => (m[1] || '').includes('hunter2')), 'nowhere in a sequence');
	assert.strictEqual(h.session.calls[0].script, secret, 'the engine still gets it');
	assert.deepStrictEqual(h.history.list(), [secret], 'Up still finds it in this session');
});

test('Up recalls the previous line; a line that starts with a space is not remembered; `history` and `clear` are the terminal\'s', async () => {
	const h = makePty();
	for (const line of ['echo one', ' echo hidden', 'echo two']) {
		h.type(line, '\r');
		h.session.finish();
		await settle(); h.timers.drain();
	}
	h.type(E + '[A');
	assert.strictEqual(h.screen().slice(-1)[0], 'scratch $ echo two');
	h.type(E + '[A');
	assert.strictEqual(h.screen().slice(-1)[0], 'scratch $ echo one');
	h.type('\x15', 'history', '\r');
	assert.strictEqual(h.session.calls.length, 3, 'history is answered here, not sent to the engine');
	await settle(); h.timers.drain();
	const s = h.screen().join('\n');
	assert.ok(/ 1  echo one/.test(s) && / 2  echo two/.test(s) && !/hidden/.test(s.replace(/echo hidden/, '')) , s);
	h.type('history -c', '\r');
	await settle(); h.timers.drain();
	assert.deepStrictEqual(h.history.list(), []);
	h.type('clear', '\r');
	await settle(); h.timers.drain();
	assert.deepStrictEqual(h.screen(), ['scratch $'], 'the screen is cleared and the prompt is at the top');
	assert.strictEqual(h.session.calls.length, 3);
});

test('a paste is never run by itself; Enter runs it as ONE script; an unfinished quote continues on the next line', async () => {
	const h = makePty();
	h.type(paste('echo a\necho b'));
	assert.strictEqual(h.session.calls.length, 0);
	assert.deepStrictEqual(h.screen().slice(-2), ['scratch $ echo a', '> echo b']);
	h.type('\r');
	assert.deepStrictEqual(h.session.calls.map((c) => c.script), ['echo a\necho b']);
	h.session.finish();
	await settle(); h.timers.drain();
	h.type('echo "open', '\r');
	assert.strictEqual(h.session.calls.length, 1, 'held back: the quote is open');
	assert.strictEqual(h.screen().slice(-1)[0], '>');
	h.type('close"', '\r');
	assert.deepStrictEqual(h.session.calls[1].script, 'echo "open\nclose"');
	// a trailing pipe and a here-document too
	h.session.finish();
	await settle(); h.timers.drain();
	h.type('cat <<EOF', '\r', 'hi', '\r');
	assert.strictEqual(h.session.calls.length, 2);
	h.type('EOF', '\r');
	assert.strictEqual(h.session.calls[2].script, 'cat <<EOF\nhi\nEOF');
});

test('a paste over 100 KB is refused with a notice, not cut', () => {
	const h = makePty({ cols: 120 });
	h.type('keep', paste('x'.repeat(100001)));
	const s = h.screen().join('\n');
	assert.ok(/paste not inserted: 100001 characters is over the limit of 100000/.test(s), s);
	assert.strictEqual(h.screen().slice(-1)[0], 'scratch $ keep');
	h.type(paste('y'.repeat(100000)));
	assert.ok(h.screen().join('').includes('yyyyyyyyyy'), 'exactly the cap is accepted');
});

test('Ctrl+C while a command runs stops the session at once, shows ^C, drops queued output, and ignores late output', async () => {
	const h = makePty();
	h.type('yes', '\r');
	h.session.pending.o.onStdout('y\n'.repeat(40000));            // 120 KB: queued behind the macrotask
	assert.ok(h.timers.queued() > 0);
	h.pty.handleInput('\x03');                                    // not through type(): that would run the queue
	assert.strictEqual(h.session.stops, 1, 'Ctrl+C is session.stop(), not an abort signal');
	const written = h.writes.length;
	h.timers.drain();
	assert.strictEqual(h.writes.length, written, 'what had not been written is dropped');
	h.type('\x03');
	assert.strictEqual(h.session.stops, 1, 'once');
	assert.ok(h.all().includes('^C'));
	// the engine's late output after the stop is ignored; the run settles as aborted
	const p = h.session.pending;
	h.session.finish({ exitCode: 130, how: 'aborted', notes: ['[LevelCode Shell: the command was stopped. Any file changes it had made were NOT applied.]'] });
	await settle(); h.timers.drain();
	p.o.onStdout('too late\n');
	h.timers.drain();
	assert.ok(!h.all().includes('too late'));
	const s = h.screen();
	assert.strictEqual(s[s.length - 1], 'scratch [130] $');
	assert.ok(s.some((l) => /command was stopped/.test(l)));
	// and the next line runs normally
	h.type('echo ok', '\r');
	assert.strictEqual(h.session.calls.length, 2);
});

test('while a command runs only Ctrl+C is heard: typing is dropped, not kept for the next prompt', async () => {
	const h = makePty();
	h.type('sleep 5', '\r');
	h.type('typed while running', E + '[A', '\x04', '\x0c', paste('pasted'));
	h.session.finish();
	await settle(); h.timers.drain();
	assert.strictEqual(h.screen().slice(-1)[0], 'scratch $');
	assert.strictEqual(h.session.stops, 0);
});

test('Ctrl+C and Ctrl+D at the prompt: ^C and a new prompt; EOF closes the terminal with the last status', async () => {
	const h = makePty();
	h.type('abc', '\x03');
	assert.deepStrictEqual(h.screen().slice(-2), ['scratch $ abc^C', 'scratch $']);
	assert.strictEqual(h.session.stops, 0, 'nothing was running');
	h.type('exit 0'.slice(0, 0));
	h.type('false', '\r');
	h.session.finish({ exitCode: 4 });
	await settle(); h.timers.drain();
	h.type('\x04');
	assert.deepStrictEqual(h.closed, [4]);
	assert.strictEqual(h.session.disposed, true);
	// after it closed, nothing is written and nothing is read
	const n = h.writes.length;
	h.type('echo late', '\r');
	assert.strictEqual(h.writes.length, n);
});

test('`exit` is a rule about the line: bare exit or exit N closes the terminal; exit inside anything else is the engine\'s', () => {
	assert.deepStrictEqual(exitRule('exit'), { code: null });
	assert.deepStrictEqual(exitRule('  exit  '), { code: null });
	assert.deepStrictEqual(exitRule('exit 3'), { code: 3 });
	assert.deepStrictEqual(exitRule('exit 3;'), { code: 3 });
	assert.deepStrictEqual(exitRule('exit 256'), { code: 0 });
	assert.deepStrictEqual(exitRule('exit -1'), { code: 255 });
	for (const not of ['exit foo', 'exit 1 2', 'true; exit', '(exit 3)', 'echo exit', 'exit; echo after', 'exitx', 'x exit', 'if true; then exit; fi']) {
		assert.strictEqual(exitRule(not), null, not);
	}
	const h = makePty();
	h.type('(exit 3)', '\r');
	assert.strictEqual(h.session.calls.length, 1, 'a subshell exit goes to the engine');
	assert.deepStrictEqual(h.closed, []);
	h.session.finish({ exitCode: 3 });
	return settle().then(() => {
		h.timers.drain();
		h.type('exit 7', '\r');
		assert.deepStrictEqual(h.closed, [7]);
		assert.strictEqual(h.session.calls.length, 1, 'and exit 7 never reached the engine');
	});
});

test('an engine limit (126) and a deadline (124) get a human line when the runtime gave none; its own notes are shown as they are', async () => {
	assert.ok(/limit of this shell/.test(outcomeLine('limit', 126)));
	assert.ok(/ran for too long/.test(outcomeLine('deadline', 124)));
	assert.strictEqual(outcomeLine('exit', 3), '');
	assert.strictEqual(outcomeLine('aborted', 130), '');

	const h = makePty({ cols: 120 });
	h.type('while :; do :; done', '\r');
	h.session.finish({ exitCode: 126, how: 'limit', notes: [] });
	await settle(); h.timers.drain();
	let s = h.screen().join('\n');
	assert.ok(/the command was stopped: it reached a limit of this shell \(exit 126\)/.test(s), s);
	assert.strictEqual(h.screen().slice(-1)[0], 'scratch [126] $');

	h.type('sleep 999', '\r');
	h.session.finish({ exitCode: 124, how: 'deadline', notes: ['[LevelCode Shell: the command ran out of time and was stopped.]'] });
	await settle(); h.timers.drain();
	s = h.screen().join('\n');
	assert.ok(/ran out of time and was stopped/.test(s));
	assert.ok(!/exit 124\)/.test(s), 'the runtime already said it: not said twice');

	h.type('x', '\r');
	h.session.finish({ exitCode: 1, how: 'error', notes: ['[LevelCode Shell: a note with ' + E + '[6n in it]'] });
	await settle(); h.timers.drain();
	s = h.all();
	assert.ok(!s.includes(E + '[6n'), 'a note is untrusted text');
});

test('the engine refusing a line (busy, disposed) is a line of text and a prompt, not a hang', async () => {
	const session = fakeSession();
	session.run = () => Promise.reject(new Error('busy'));
	const h = makePty({ session });
	h.type('echo x', '\r');
	await settle(); h.timers.drain();
	assert.ok(/busy/.test(h.screen().join('\n')));
	assert.strictEqual(h.screen().slice(-1)[0], 'scratch [1] $');
	const throwing = fakeSession();
	throwing.run = () => { throw new Error('engine gone'); };
	const g = makePty({ session: throwing });
	g.type('echo x', '\r');
	await settle(); g.timers.drain();
	assert.ok(/engine gone/.test(g.screen().join('\n')));
});

test('replies the workbench types are never text, at the prompt or while a command runs', async () => {
	const h = makePty();
	h.type(E + '[1;1R', E + '[?1;2c', E + ']10;rgb:0/0/0' + ST, E + '[<0;4;5M', E + '[I');
	assert.strictEqual(h.screen().slice(-1)[0], 'scratch $');
	h.type('ls', '\r');
	h.type(E + '[1;1R', 'junk');
	h.session.finish();
	await settle(); h.timers.drain();
	assert.strictEqual(h.screen().slice(-1)[0], 'scratch $');
	// a sequence cut by the end of a chunk is finished by the timer, and what it was is dropped
	h.type(E + '[12;');
	assert.strictEqual(h.timers.timers(), 1);
	h.timers.advance(60);
	h.type('x');
	assert.strictEqual(h.screen().slice(-1)[0], 'scratch $ x');
	h.type(E);
	h.timers.advance(60);
	assert.strictEqual(h.screen().slice(-1)[0], 'scratch $ x');
});

test('onInput hears keys, pastes and text, and not the reports the workbench types', () => {
	let n = 0;
	const h = makePty({ onInput: () => { n++; } });
	h.type(E + '[1;1R', E + '[I');
	assert.strictEqual(n, 0);
	h.type('a');
	assert.strictEqual(n, 1);
	h.type('\x7f');
	assert.strictEqual(n, 2);
});

test('hostile output: a file full of escapes makes the terminal type nothing and change no mode', async () => {
	const hostile = [
		E + '[6n', E + '[5n', E + '[c', E + '[>c', E + '[>0q', E + '[?2004$p', E + '[18t', E + '[14t', E + ']10;?\x07', E + ']11;?' + ST, E + ']52;c;?\x07',
		E + 'P$qm' + ST, E + '[?u', '\u009b6n',
		E + '[?1h', E + '[?1000h', E + '[?1006h', E + '[?1004h', E + '[?2004l', E + '[?7l', E + '[?1049h',
		E + ']0;pwned\x07', E + ']633;D;0' + ST, E + ']633;P;Cwd=/etc;00000000000000000000000000000000' + ST, E + ']7;file:///etc' + ST,
		E + 'c',
	].join('') + 'visible text\n';
	const h = makePty();
	h.type('cat evil.txt', '\r');
	h.session.pending.o.onStdout(hostile);
	h.session.pending.o.onStderr(hostile);
	h.session.finish();
	await settle(); h.timers.drain();
	const out = h.all();
	// the forged sequences are not in what was written (the real ones are ours, with our nonce)
	const real = marks(out).filter((m) => m[0] === 'D' || m[0] === 'P');
	assert.ok(real.every((m) => m[0] === 'D' ? m[1] === '0' : /^(Cwd=\/scratch;[0-9a-f]{32}|HasRichCommandDetection=True|ContinuationPrompt=>\\x20)$/.test(m[1] || '')), JSON.stringify(real));
	assert.ok(!out.includes('/etc'), 'no forged cwd');
	assert.ok(!/\x1b\[\?(1|1000|1006|1004|2004l|7|1049)[hl]/.test(out.replace(E + '[?2004h', '')), 'no mode switch');
	assert.ok(!/\x1b\](?!633;|8;)/.test(out) && !/\x1bP|\x1b_|\x1bc/.test(out));
	assert.ok(!/[\u0080-\u009f]/.test(out));
	assert.ok(out.includes('visible text'));

	// the real thing: feed what was written to xterm.js and count what it types back
	const xt = needXterm('hostile output against xterm.js');
	if (!xt) { return; }
	const make = () => {
		const t = new xt.Terminal({ cols: 60, rows: 12, allowProposedApi: true });
		t.loadAddon(new xt.Unicode11Addon());
		t.unicode.activeVersion = '11';
		const replies = [];
		t.onData((d) => replies.push(d));
		return { t, replies };
	};
	const control = make();
	await new Promise((r) => control.t.write(hostile, r));
	assert.ok(control.replies.length > 5, 'the unfiltered text DOES make xterm type replies (the test can fail): ' + control.replies.length);
	const filtered = make();
	await new Promise((r) => filtered.t.write(out, r));
	assert.deepStrictEqual(filtered.replies, [], 'through the filter: xterm typed nothing');
	const m = filtered.t.modes;
	assert.strictEqual(m.applicationCursorKeysMode, false);
	assert.strictEqual(m.mouseTrackingMode, 'none');
	assert.strictEqual(m.sendFocusMode, false);
	assert.strictEqual(m.wraparoundMode, true, 'auto-wrap is still on');
	assert.strictEqual(m.bracketedPasteMode, true, 'bracketed paste is the one mode we turn on');
	assert.strictEqual(filtered.t.buffer.active.type, 'normal', 'no alternate screen');
});

test('output is written in chunks of at most 16 KiB per macrotask, in order, and the prompt comes last', async () => {
	const h = makePty();
	h.type('seq 1 100000', '\r');
	const big = Array.from({ length: 20000 }, (_, i) => 'line ' + i).join('\n') + '\n';   // about 200 KB
	h.session.pending.o.onStdout(big);
	const before = h.writes.length;
	assert.ok(h.timers.queued() >= 1);
	let tasks = 0;
	while (h.timers.step()) { tasks++; }
	assert.ok(tasks >= 10, 'spread over many macrotasks: ' + tasks);
	for (const w of h.writes.slice(before)) { assert.ok(w.length <= 16384, 'a fire of ' + w.length); }
	h.session.finish();
	await settle(); h.timers.drain();
	const text = h.all();
	const first = text.indexOf('line 0\r\n');
	const last = text.lastIndexOf('line 19999\r\n');
	assert.ok(first >= 0 && last > first);
	assert.ok(text.lastIndexOf('scratch') > last, 'the prompt after the last line');
	// in order
	let prev = -1;
	for (const m of text.matchAll(/line (\d+)\r\n/g)) { const n = Number(m[1]); assert.strictEqual(n, prev + 1); prev = n; }
});

test('a run is shown up to 1 MiB; the rest is dropped and said so', async () => {
	const h = makePty({ outputLimit: 1000 });
	h.type('yes', '\r');
	h.session.pending.o.onStdout('y\n'.repeat(2000));
	h.session.pending.o.onStderr('e'.repeat(500));
	h.session.finish();
	await settle(); h.timers.drain();
	const s = h.all();
	assert.ok(/\[output limit reached: \d+ more characters were not shown\]/.test(s), s.slice(-300));
	const shown = (s.match(/y\r\n/g) || []).length;
	assert.ok(shown >= 330 && shown <= 334, 'shown ' + shown + ' (each line is 3 characters on the wire, the cap is 1000)');
	assert.ok(!s.includes('eeeee'), 'the other stream shares the one cap');
	assert.strictEqual(h.screen().slice(-1)[0], 'scratch $');
});

test('a resize while a command runs applies to the next run and the prompt; the width goes to the engine', async () => {
	const h = makePty();
	h.type('echo x', '\r');
	h.pty.setDimensions({ columns: 33, rows: 9 });
	h.session.finish();
	await settle(); h.timers.drain();
	h.type('echo y', '\r');
	assert.strictEqual(h.session.calls[1].o.cols, 33);
	assert.strictEqual(h.session.calls[1].o.rows, 9);
});

test('closing the tab disposes the session, and nothing the engine says after that is written', async () => {
	const h = makePty();
	h.type('sleep 9', '\r');
	const p = h.session.pending;
	h.pty.close();
	assert.strictEqual(h.session.disposed, true);
	const n = h.writes.length;
	p.o.onStdout('late');
	p.resolve({ exitCode: 0, how: 'exit', notes: [], cwd: '/scratch' });
	await settle(); h.timers.drain();
	assert.strictEqual(h.writes.length, n);
	assert.deepStrictEqual(h.closed, [], 'a close the workbench asked for is not announced back');
});

test('Tab: completion goes to the session; quoting is repaired; file names that cannot be typed are left out and the list is sanitised', async () => {
	const names = ['my file.txt', 'my notes.md', 'plain.txt', 'bad' + E + '[6nname', 'sub/'];
	const h = makePty({ complete: (kind, prefix) => names.filter((n) => n.startsWith(prefix)) });
	h.type('cat pl', '\t');
	await settle(); h.timers.drain();
	assert.strictEqual(h.screen().slice(-1)[0], 'scratch $ cat plain.txt');
	h.type('\x15', 'cat my\\ f', '\t');
	await settle(); h.timers.drain();
	assert.strictEqual(h.screen().slice(-1)[0], 'scratch $ cat my\\ file.txt');
	h.type('\x15', 'cat "my n', '\t');
	await settle(); h.timers.drain();
	assert.strictEqual(h.screen().slice(-1)[0], 'scratch $ cat "my notes.md"');
	h.type('\x15', 'cat b', '\t');
	await settle(); h.timers.drain();
	assert.strictEqual(h.screen().slice(-1)[0], 'scratch $ cat b', 'the one candidate has an escape in its name: it is not offered');
	h.type('\x15', 'cat m', '\t');
	await settle(); h.timers.drain();
	assert.strictEqual(h.screen().slice(-1)[0], 'scratch $ cat my\\', 'the common prefix of the two, as the shell writes it (a backslash and a space; the model trims the space)');
	h.type('\t');
	await settle(); h.timers.drain();
	const screen = h.screen().join('\n');
	assert.ok(/my file\.txt\s+my notes\.md/.test(screen), 'the second Tab lists them by their real names:\n' + screen);
	assert.strictEqual(h.screen().slice(-1)[0], 'scratch $ cat my\\', 'and the line is back under the list');
	assert.ok(!h.all().includes(E + '[6n'));
});

test('help lists the commands the engine has and says what the shell is not', async () => {
	const h = makePty({ info: { commands: ['cat', 'ls', 'grep' + E + '[6n'] }, cols: 100 });
	h.type('help', '\r');
	await settle(); h.timers.drain();
	const s = h.screen().join('\n');
	assert.ok(/cat ls grep/.test(s));
	assert.ok(/no node, npm, git, python/.test(s) || /does not run programs/.test(s));
	assert.ok(/no network/.test(s));
	assert.ok(!h.all().includes(E + '[6n'), 'a command name is data too');
	assert.strictEqual(h.session.calls.length, 0, 'help is the terminal\'s own');
});


/* ------------------------------------------------------------------------------------------------ Ctrl+C in detail */

const NOTE_STOPPED = '[LevelCode Shell: stopped. Any file changes the command had made were NOT applied.]';

test('Ctrl+C puts the terminal back whatever the filter believes it wrote: colours, a link and the cursor come back, then ^C', async () => {
	const h = makePty({ cols: 120 });
	h.type('cat big', '\r');
	// delivered: a colour, a hidden cursor and an open link. Queued, and so dropped by Ctrl+C: the text and the sequences
	// that close all three (the filter has "written" them, and thinks the terminal is back to normal)
	h.session.pending.o.onStdout(E + '[31m' + E + '[?25l' + E + ']8;;http://example.com' + ST + 'x');
	const delivered = h.writes.length;
	h.session.pending.o.onStdout('x'.repeat(40000) + E + ']8;;' + ST + E + '[?25h' + E + '[0m');
	assert.ok(h.timers.queued() > 0, 'the rest of it is still queued');
	h.pty.handleInput('\x03');
	assert.strictEqual(h.writes.slice(delivered).join(''), RESET + E + ']8;;' + ST + E + '[?25h' + DIM + '^C' + RESET, 'unconditional, and then ^C');
	h.timers.drain();
	assert.strictEqual(h.writes.slice(delivered).join('').includes('xxxx'), false, 'what was queued is gone');
	h.session.finish({ exitCode: 130, how: 'aborted', notes: [NOTE_STOPPED] });
	await settle(); h.timers.drain();
	const screen = h.screen();
	assert.deepStrictEqual(screen.slice(-4), ['scratch $ cat big', 'x^C', NOTE_STOPPED, 'scratch [130] $'], 'the note has a row of its own');

	// the real thing: xterm.js ends with the cursor shown and no link open; what it had been given before Ctrl+C left both on
	const xt = needXterm('Ctrl+C against xterm.js');
	if (!xt) { return; }
	const feed = async (text) => {
		const t = new xt.Terminal({ cols: 60, rows: 12, allowProposedApi: true });
		await new Promise((r) => t.write(text, r));
		return { hidden: t._core.coreService.isCursorHidden, link: t._core._inputHandler._curAttrData.extended.urlId };
	};
	const before = await feed(h.writes.slice(0, delivered).join(''));
	assert.deepStrictEqual(before, { hidden: true, link: 1 }, 'the control: without the tail the terminal is left like that');
	assert.deepStrictEqual(await feed(h.all()), { hidden: false, link: 0 });
});

test('^C has a line break of its own: after output that ended a line, after a partial line, and after none at all', async () => {
	/** @type {Array<[string, string, string[]]>} */
	const cases = [
		['a line start', 'done\n', ['scratch $ yes', 'done', '^C', NOTE_STOPPED, 'scratch [130] $']],
		['a partial line', 'partial', ['scratch $ yes', 'partial^C', NOTE_STOPPED, 'scratch [130] $']],
		['no output', '', ['scratch $ yes', '^C', NOTE_STOPPED, 'scratch [130] $']],
	];
	for (const [name, out, want] of cases) {
		const h = makePty({ cols: 120 });
		h.type('yes', '\r');
		if (out) { h.session.pending.o.onStdout(out); h.timers.drain(); }
		h.pty.handleInput('\x03');
		h.timers.drain();
		h.session.finish({ exitCode: 130, how: 'aborted', notes: [NOTE_STOPPED] });
		await settle(); h.timers.drain();
		assert.deepStrictEqual(h.screen().slice(-want.length), want, String(name));
	}
});

test('only Ctrl+C interrupts a running command: Alt+C is a key like any other, and is not heard', async () => {
	const h = makePty();
	h.type('sleep 5', '\r');
	h.type(E + 'c', E + 'C', E + '[99;3u');
	assert.strictEqual(h.session.stops, 0);
	h.type('\x03');
	assert.strictEqual(h.session.stops, 1);
});

test('a blank line is not run: no engine, no marks of a command, and the status in the prompt stays', async () => {
	const h = makePty();
	h.type('false', '\r');
	h.session.finish({ exitCode: 1 });
	await settle(); h.timers.drain();
	assert.strictEqual(h.screen().slice(-1)[0], 'scratch [1] $');
	const from = h.all().length;
	h.type('\r');
	h.type('   ', '\r');
	h.type('\r');
	assert.strictEqual(h.session.calls.length, 1);
	const letters = marks(h.all().slice(from)).map((m) => m[0]);
	assert.ok(letters.length > 0 && letters.every((l) => l === 'A' || l === 'B'), 'only prompts: ' + letters.join(''));
	assert.strictEqual(h.screen().slice(-1)[0], 'scratch [1] $', 'the status of the last real command');
	assert.deepStrictEqual(h.history.list(), ['false'], 'and nothing blank is remembered');
});

test('`history N` shows the last N lines with their numbers; `history` output is text from a store, so it is sanitised', async () => {
	const h = makePty();
	for (const l of ['echo one', 'echo two', 'echo three', 'echo four']) { h.history.add(l); }
	h.type('history 2', '\r');
	await settle(); h.timers.drain();
	let s = h.screen().join('\n');
	assert.ok(/ 5  history 2/.test(s) && / 4  echo four/.test(s), s);
	assert.ok(!/echo three|echo two|echo one/.test(s), 'only the last 2: ' + s);

	// a hostile line in the store (it came from globalState, which another window or an older build wrote)
	h.history.add('echo ' + E + ']0;pwned\x07' + E + '[6n hi');
	h.type('history', '\r');
	await settle(); h.timers.drain();
	assert.ok(!h.all().includes(E + ']0;pwned'), 'no title sequence');
	assert.ok(!h.all().includes(E + '[6n'), 'no query');
	s = h.screen().join('\n');
	assert.ok(/echo ␛\]0;pwned␇␛\[6n hi/.test(s), s);
});

test('the working folder after a command is reported (it is what the next terminal starts in), also for the terminal\'s own commands', async () => {
	const seen = [];
	const h = makePty({ onCwd: (c) => seen.push(c) });
	h.type('cd src', '\r');
	h.session.finish({ cwd: '/scratch/src' });
	await settle(); h.timers.drain();
	assert.deepStrictEqual(seen, ['/scratch/src']);
	h.type('help', '\r');
	await settle(); h.timers.drain();
	assert.deepStrictEqual(seen, ['/scratch/src', '/scratch/src']);
});

test('a sequence completed in time cancels the timer that would have given up on it', () => {
	const h = makePty();
	h.type(E + '[1;');
	assert.strictEqual(h.timers.timers(), 1, 'waiting for the rest');
	h.type('5D');
	assert.strictEqual(h.timers.timers(), 0, 'it came: nothing is waited for any more');
	h.type(E);
	assert.strictEqual(h.timers.timers(), 1);
	h.type('[A');
	assert.strictEqual(h.timers.timers(), 0);
	h.timers.advance(100);
	assert.strictEqual(h.screen().slice(-1)[0], 'scratch $', 'and nothing was typed by a late timer');
});

test('at most 8 of the runtime\'s notes are shown after a command', async () => {
	const h = makePty({ cols: 100 });
	h.type('x', '\r');
	h.session.finish({ exitCode: 0, notes: Array.from({ length: 12 }, (_, i) => '[note ' + (i + 1) + ']') });
	await settle(); h.timers.drain();
	const s = h.screen().join('\n');
	for (let i = 1; i <= 8; i++) { assert.ok(s.includes('[note ' + i + ']'), 'note ' + i); }
	assert.ok(!s.includes('[note 9]'));
});

test('dimensions below 2 are never taken (a hidden panel reports 0): the previous ones stay and are what a command is told', async () => {
	const h = makePty({ cols: 60, rows: 12 });
	for (const bad of [{ columns: 1, rows: 1 }, { columns: 0, rows: 0 }, { columns: NaN, rows: undefined }, { columns: -5, rows: 9 }]) {
		h.pty.setDimensions(bad);
		h.type('echo x', '\r');
		const call = h.session.calls[h.session.calls.length - 1];
		assert.strictEqual(call.o.cols, bad.columns === -5 ? 60 : 60, JSON.stringify(bad));
		assert.strictEqual(call.o.rows, bad.rows === 9 ? 9 : 12, JSON.stringify(bad));
		h.session.finish();
		await settle(); h.timers.drain();
	}
	h.pty.setDimensions({ columns: 2, rows: 2 });
	h.type('echo y', '\r');
	const last = h.session.calls[h.session.calls.length - 1];
	assert.deepStrictEqual([last.o.cols, last.o.rows], [2, 2], 'exactly 2 is the smallest that is taken');
});

test('`clear;` and `help;` are the terminal\'s too, with the semicolon', async () => {
	const h = makePty({ cols: 120 });
	h.type('echo old', '\r');
	h.session.finish();
	await settle(); h.timers.drain();
	h.type('clear;', '\r');
	await settle(); h.timers.drain();
	assert.deepStrictEqual(h.screen(), ['scratch $']);
	h.type('help;', '\r');
	await settle(); h.timers.drain();
	assert.strictEqual(h.session.calls.length, 1, 'neither went to the engine');
	assert.ok(/LevelCode Shell runs shell scripts/.test(h.screen().join('\n')));
});

test('a run stuck applying its changes: Ctrl+C stops what can be stopped, the terminal says so after 5 s, and a second Ctrl+C gives the prompt back', async () => {
	// the runtime does not interrupt a commit (half of a `mv` is worse than all of it): stop() returns and nothing settles
	const session = fakeSession();
	let pendingRuns = 0;
	session.run = (script, o) => {
		session.calls.push({ script, o });
		if (pendingRuns > 0) { return Promise.reject(new Error('busy')); }
		pendingRuns++;
		return new Promise((resolve) => { session.release = resolve; });
	};
	const h = makePty({ session, cols: 200 });
	h.type('mv a b', '\r');
	h.pty.handleInput('\x03');
	assert.strictEqual(session.stops, 1);
	h.type('\x03');
	assert.strictEqual(h.screen().slice(-1)[0], '^C', 'a second Ctrl+C at once is the same one: still running, nothing said');
	assert.strictEqual(session.stops, 1);
	h.timers.advance(4999);
	assert.ok(!/still applying/.test(h.screen().join('\n')));
	h.timers.advance(1);
	h.timers.drain();
	assert.ok(/still applying the changes of this command. Ctrl\+C again gives the prompt back/.test(h.screen().join('\n')), h.screen().join('\n'));
	h.type('\x03');
	await settle(); h.timers.drain();
	assert.strictEqual(h.screen().slice(-1)[0], 'scratch [130] $', 'the prompt is back');
	assert.strictEqual(session.stops, 1, 'the engine was not asked again');
	const marksAfter = marks(h.all()).filter((m) => m[0] === 'D');
	assert.deepStrictEqual(marksAfter[marksAfter.length - 1], ['D', '130']);

	// the run settles later: its result is not heard
	const n = h.writes.length;
	session.release({ exitCode: 0, how: 'exit', notes: ['[LevelCode Shell: 1 of 1 applied]'], cwd: '/scratch/elsewhere' });
	await settle(); h.timers.drain();
	assert.strictEqual(h.writes.length, n, 'nothing written');
	assert.strictEqual(h.screen().slice(-1)[0], 'scratch [130] $');

	// and the prompt is a prompt: the next line goes to the session, which says it is busy, in words
	h.type('echo next', '\r');
	await settle(); h.timers.drain();
	assert.ok(/the shell is busy: the previous command is still applying its changes/.test(h.screen().join('\n')), h.screen().join('\n'));
	assert.strictEqual(h.screen().slice(-1)[0], 'scratch [1] $');
});

test('a run that does end after Ctrl+C is not "stuck": no notice, and a late second Ctrl+C has nothing to give back', async () => {
	const h = makePty();
	h.type('sleep 9', '\r');
	h.pty.handleInput('\x03');
	h.session.finish({ exitCode: 130, how: 'aborted', notes: [NOTE_STOPPED] });
	await settle(); h.timers.drain();
	assert.strictEqual(h.timers.timers(), 0, 'the notice is not waiting');
	h.timers.advance(10000);
	assert.ok(!/still applying/.test(h.all()));
	h.type('echo ok', '\r');
	assert.strictEqual(h.session.calls.length, 2);
});

/* ------------------------------------------------------------------------------------------------ what is read of a line */

test('a line of 100,000 characters is accepted at once: nothing about it is quadratic', () => {
	const shapes = [
		['plain text', 'a'.repeat(100000)],
		['the shape of a JWT, over and over', 'eyJ-'.repeat(25000)],
		['the scheme of a URL, over and over', 'a://'.repeat(25000)],
		['a private key header and a long run', '-----BEGIN ' + 'A'.repeat(99000)],
		['a secret name and a long run of blanks', 'token' + ' '.repeat(99000)],
	];
	for (const [name, text] of shapes) {
		const h = makePty({ cols: 120 });
		h.type(paste(text));
		const t0 = process.hrtime.bigint();
		h.pty.handleInput('\r');
		const ms = Number(process.hrtime.bigint() - t0) / 1e6;
		assert.strictEqual(h.session.calls.length, 1, name);
		assert.ok(ms < 500, name + ': Enter took ' + ms.toFixed(0) + ' ms (it took seconds when the whole line was scanned)');
	}
});

test('Enter on a line of any shape is quick: runs of blanks, line ends, marks and unfinished sequences are not a stall', () => {
	// the largest paste that is taken (100,000): every pattern of the line's way in and out sees the text once
	everyShape('a line of ~90,000 characters', (text) => {
		const h = makePty({ cols: 120 });
		h.pty.handleInput(paste(text));
		h.timers.drain();
		h.pty.handleInput('\r');
		h.timers.drain();
	}, { n: 90000 });
	// `exit` and `history` have patterns of their own over the whole line
	for (const t of ['exit' + ' '.repeat(90000) + 'x', 'exit 1' + ' '.repeat(45000) + '1'.repeat(45000) + 'x', 'history' + '\t'.repeat(90000) + 'x']) {
		const h = makePty({ cols: 120 });
		h.pty.handleInput(paste(t));
		h.timers.drain();
		const t0 = process.hrtime.bigint();
		h.pty.handleInput('\r');
		const ms = Number(process.hrtime.bigint() - t0) / 1e6;
		assert.ok(ms < 500, JSON.stringify(t.slice(0, 12)) + ' took ' + ms.toFixed(0) + ' ms');
	}
});

test('what a terminal printed is remembered with the folder it was printed in, for the file links: the end of a command, then where it began', async () => {
	const h = makePty({ cwd: '/scratch' });
	// a command in /scratch
	h.type('grep -n b lib/b.js', '\r');
	h.session.pending.o.onStdout('lib/b.js:7: b\n');
	h.session.finish({});
	await settle(); h.timers.drain();
	assert.deepStrictEqual(h.pty.cwdsFor('lib/b.js:7: b'), ['/scratch']);
	// the line that was typed is about the folder the prompt named
	assert.deepStrictEqual(h.pty.cwdsFor('scratch $ grep -n b lib/b.js'), ['/scratch']);
	// `cd src` changes the folder, and what a command prints after it is about the new one
	h.type('cd src', '\r');
	h.session.finish({ cwd: '/scratch/src' });
	await settle(); h.timers.drain();
	h.type('ls', '\r');
	h.session.pending.o.onStdout('util.js:2: x\n');
	h.session.finish({});
	await settle(); h.timers.drain();
	assert.deepStrictEqual(h.pty.cwdsFor('util.js:2: x'), ['/scratch/src']);
	assert.deepStrictEqual(h.pty.cwdsFor('lib/b.js:7: b'), ['/scratch'], 'the older line is still about the folder it was printed in');
	// one command that goes somewhere and prints: where it ended first, where it began second
	h.type('cd .. && grep x lib', '\r');
	h.session.pending.o.onStdout('lib/c.js:1: x\n');
	h.session.finish({ cwd: '/scratch' });
	await settle(); h.timers.drain();
	assert.deepStrictEqual(h.pty.cwdsFor('lib/c.js:1: x'), ['/scratch', '/scratch/src']);
	// the same text in two folders: the latest
	h.type('ls', '\r');
	h.session.pending.o.onStdout('util.js:2: x\n');
	h.session.finish({});
	await settle(); h.timers.drain();
	assert.deepStrictEqual(h.pty.cwdsFor('util.js:2: x'), ['/scratch']);
	// what the terminal says itself (help) and a line it never wrote are nobody's
	h.type('help', '\r');
	await settle(); h.timers.drain();
	const said = h.screen().find((l) => l.includes('Up/Down'));
	assert.ok(said, 'help was shown');
	assert.strictEqual(h.pty.cwdsFor(said), undefined);
	assert.strictEqual(h.pty.cwdsFor('something else.js:1'), undefined);
	// a multi-line command: every line of it as it stands on the screen, the continuation prompt first
	h.type(paste('echo a\ncat src/x.js'), '\r');
	h.session.finish({});
	await settle(); h.timers.drain();
	assert.deepStrictEqual(h.pty.cwdsFor('> cat src/x.js'), ['/scratch']);
	// what the runtime says about a run (its notes) is about the folder the command ended in, and then the one it began in
	h.type('cd src && make', '\r');
	h.session.finish({ cwd: '/scratch/src', notes: ['kept lib/n.js unchanged'] });
	await settle(); h.timers.drain();
	assert.deepStrictEqual(h.pty.cwdsFor('kept lib/n.js unchanged'), ['/scratch/src', '/scratch']);
	h.type('cd ..', '\r');
	h.session.finish({ cwd: '/scratch' });
	await settle(); h.timers.drain();
	// a line that is overwritten (a carriage return) is what is left of it on the screen
	h.type('make', '\r');
	h.session.pending.o.onStdout('abc src/old.js\rXY\n');
	h.session.finish({});
	await settle(); h.timers.drain();
	assert.deepStrictEqual(h.pty.cwdsFor('XYc src/old.js'), ['/scratch']);
	assert.strictEqual(h.pty.cwdsFor('abc src/old.js'), undefined);
});

test('a line that looks like a secret is judged once, and the history and the workbench are told the same thing', async () => {
	const adds = [];
	const history = { list: () => [], add: (line, secret) => { adds.push([line, secret]); return true; }, clear() { } };
	const h = makePty({ history });
	const secret = 'export API_' + 'KEY=' + 'hunter2hunter2';
	h.type(secret, '\r');
	h.session.finish();
	await settle(); h.timers.drain();
	h.type('echo hi', '\r');
	h.session.finish();
	await settle(); h.timers.drain();
	assert.deepStrictEqual(adds, [[secret, true], ['echo hi', false]], 'the verdict goes with the line');
	const e = marks(h.all()).filter((m) => m[0] === 'E');
	assert.deepStrictEqual(e.map((m) => m[1]), [';' + h.pty.nonce, 'echo\\x20hi;' + h.pty.nonce]);
});

test('a pasted line that nests a command substitution 5,000 deep is run (the engine reports it); Enter never does nothing', async () => {
	const h = makePty({ cols: 120 });
	h.type(paste('echo ' + '$('.repeat(5000)));
	h.type('\r');
	assert.strictEqual(h.session.calls.length, 1, 'it was run, not held back');
	h.session.finish({ exitCode: 2, notes: ['[syntax error]'] });
	await settle(); h.timers.drain();
	assert.strictEqual(h.screen().slice(-1)[0], 'scratch [2] $');
});

test('two workspace folders of one name are told apart in the prompt by the folder they are in', () => {
	const folders = [{ name: 'proj', root: '/a/proj', uri: 'file:///a/proj' }, { name: 'proj', root: '/b/proj', uri: 'file:///b/proj' }];
	const a = makePty({ folders, cwd: '/a/proj/src' });
	assert.strictEqual(a.screen().slice(-1)[0], 'a/proj/src $');
	const b = makePty({ folders, cwd: '/b/proj' });
	assert.strictEqual(b.screen().slice(-1)[0], 'b/proj $');
	// one of them alone is just its name
	const c = makePty({ folders: [folders[0]], cwd: '/a/proj' });
	assert.strictEqual(c.screen().slice(-1)[0], 'proj $');
	assert.strictEqual(cwdLabel('/x/a/proj/lib', [{ name: 'proj', root: '/x/a/proj' }, { name: 'proj', root: '/y/a/proj' }], 80, sanitize), 'x/a/proj/lib', 'as many folders as it takes');
	assert.strictEqual(cwdLabel('/mnt/site', [{ name: 'site', root: '/mnt/site', origin: '/' }, { name: 'site', root: '/work/site' }], 80, sanitize), 'site');
	// the deepest folder that holds the cwd names it (roots that nest: not what the runtime mounts, but a pure function)
	assert.strictEqual(cwdLabel('/proj/sub/x', [{ name: 'proj', root: '/proj' }, { name: 'sub', root: '/proj/sub' }], 80, sanitize), 'sub/x');
});

test('the status the terminal closes with is 0..255, whatever the runtime said', async () => {
	const h = makePty();
	h.type('x', '\r');
	h.session.finish({ exitCode: 300 });
	await settle(); h.timers.drain();
	h.type('exit', '\r');
	assert.deepStrictEqual(h.closed, [44]);
	const g = makePty();
	g.type('exit -1', '\r');
	assert.deepStrictEqual(g.closed, [255]);
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
