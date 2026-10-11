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
 *    - output is written in 16 KiB macrotask chunks, in order, capped at 1 MiB with a visible notice.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

const assert = require('assert');
const path = require('path');

const { makePty, fakeSession, settle, TERMINAL } = require('./helpers/shell-terminal-fakes');
const { findXterm } = require('./helpers/shell-terminal-xterm');
const { exitRule, outcomeLine } = require(path.join(TERMINAL, 'pty.js'));
const { cwdLabel, promptFor } = require(path.join(TERMINAL, 'prompt.js'));
const sanitize = require(path.join(TERMINAL, '..', 'sanitize.js'));

const queue = [];
const test = (name, fn) => queue.push([name, fn]);
const E = '\x1b';
const ST = E + '\\';
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
	const xt = findXterm();
	if (!xt) { console.log('    (the real-xterm half is skipped: no xterm checkout)'); return; }
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

(async () => {
	let n = 0;
	for (const [name, fn] of queue) { await fn(); n++; console.log('  ok - ' + name); }
	console.log(`\n${n} tests passed`);
})().catch((e) => { console.error(e); process.exit(1); });
