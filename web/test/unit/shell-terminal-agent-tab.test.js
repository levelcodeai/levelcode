/*---------------------------------------------------------------------------------------------
 *  LevelCode Shell terminal: the agent's tab - run: node web/test/unit/shell-terminal-agent-tab.test.js
 *
 *  The tab mirrors what runtime.onAgentRun reports, and has two ways to hurt: it shows text the model wrote (the
 *  command, its explanation) and text from files (the output), and revealing it can take the keyboard away from
 *  someone typing in a terminal (measured: terminal.show(true) from a focused terminal leaves the focus on the page).
 *  So here: the order and shape of what is written, everything untrusted through the filter or forTerminal, and the
 *  reveal policy as a table with its 30 s guard.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

const assert = require('assert');
const path = require('path');

const { fakeVscode, manualTimers, VT, TERMINAL } = require('./helpers/shell-terminal-fakes');
const { needXterm } = require('./helpers/shell-terminal-xterm');
const { createAgentTab, shouldReveal, duration, NAME, UNSEEN_NAME } = require(path.join(TERMINAL, 'agent-tab.js'));
const sanitize = require(path.join(TERMINAL, '..', 'sanitize.js'));

const queue = [];
const test = (name, fn) => queue.push([name, fn]);
const E = '\x1b';
const ST = E + '\\';

/** @param {{ mode?: string, recentInput?: boolean, outputLimit?: number }} [o] */
function setup(o) {
	const opts = o || {};
	const fv = fakeVscode();
	const timers = manualTimers();
	const listeners = new Set();
	const runtime = {
		onAgentRun(l) { listeners.add(l); return { dispose() { listeners.delete(l); } }; },
		folders: () => [{ name: 'scratch', root: '/scratch' }],
	};
	const activity = { lastInput: -Infinity };
	const state = { mode: opts.mode || 'firstRun' };
	const tab = createAgentTab({ vscode: fv.vscode, runtime, sanitize, getMode: () => state.mode, activity, now: timers.now, schedule: timers.schedule, outputLimit: opts.outputLimit });
	const emit = (e) => { for (const l of Array.from(listeners)) { l(e); } };
	const t = {
		fv, timers, tab, emit, activity, state, listeners, runtime,
		terminal: () => fv.state.terminals.find((x) => x.name.startsWith('LevelCode Agent')) || null,
		/** Open the pty the way the workbench does and collect what it writes. */
		attach() {
			const term = fv.state.terminals[fv.state.terminals.length - 1];
			const pty = term.creationOptions.pty;
			const vt = new VT(200, 30);
			const writes = [];
			const names = [];
			pty.onDidWrite((d) => { writes.push(d); vt.write(d); });
			pty.onDidChangeName((n) => names.push(n));
			pty.open();
			timers.drain();
			return { pty, vt, writes, names, term, all: () => writes.join(''), screen: () => vt.text() };
		},
	};
	return t;
}
const run = (id, command, extra) => Object.assign({ type: 'start', id, command, cwd: '/scratch' }, extra);

test('shouldReveal: the policy as a table, with the 30 second guard', () => {
	const rows = [
		// mode,      first,  ms since input, reveal
		['firstRun', true, 100000, true],
		['firstRun', false, 100000, false],
		['firstRun', true, 29999, false],
		['firstRun', true, 30000, true],
		['always', true, 100000, true],
		['always', false, 100000, true],
		['always', false, 5000, false],
		['always', false, 30000, true],
		['never', true, 100000, false],
		['never', false, 100000, false],
		['firstRun', true, Infinity, true],
	];
	for (const [mode, first, ms, want] of rows) {
		assert.strictEqual(shouldReveal({ mode, firstRunThisSession: first, msSinceLastShellInput: ms }), want, JSON.stringify([mode, first, ms]));
	}
	assert.strictEqual(shouldReveal({ mode: 'bogus', firstRunThisSession: true, msSinceLastShellInput: 1e9 }), true, 'an unknown value behaves as the default would for a first run');
});

test('a run is mirrored as: explanation, the command, where, its output, then the result', () => {
	const t = setup();
	t.emit(run(1, 'ls -la', { explanation: 'List the files' }));
	const a = t.attach();
	t.emit({ type: 'chunk', id: 1, stream: 'stdout', text: 'a.txt\nb.txt\n' });
	t.emit({ type: 'chunk', id: 1, stream: 'stderr', text: 'warn\n' });
	t.emit({ type: 'end', id: 1, exitCode: 0, how: 'exit', notes: [] });
	t.timers.drain();
	assert.deepStrictEqual(a.screen(), ['List the files', '$ ls -la', 'in scratch', 'a.txt', 'b.txt', 'warn', '✓ exit 0 · 0ms']);
	// one tab, with the name, an icon and a colour, and NO shell integration (a command the model wrote is not a "recent command")
	assert.strictEqual(t.fv.state.terminals.length, 1);
	const o = a.term.creationOptions;
	assert.strictEqual(o.name, NAME);
	assert.strictEqual(o.shellIntegrationNonce, undefined);
	assert.ok(o.iconPath && o.color);
	assert.ok(!/\x1b\]633/.test(a.all()));
});

test('the result line says how it ended: a failure, a stop, a timeout, a limit, an error; notes follow the output', () => {
	const t = setup();
	const cases = [
		[{ exitCode: 2, how: 'exit' }, '✗ exit 2 · 0ms'],
		[{ exitCode: 130, how: 'aborted' }, '■ stopped · 0ms'],
		[{ exitCode: 124, how: 'deadline' }, '■ timed out · 0ms'],
		[{ exitCode: 126, how: 'limit' }, '■ stopped: a limit of the shell was reached · 0ms'],
		[{ exitCode: 1, how: 'error' }, '✗ could not run · 0ms'],
	];
	t.emit(run(0, 'first'));
	const a = t.attach();
	t.emit({ type: 'end', id: 0, exitCode: 0, how: 'exit', notes: [] });
	cases.forEach(([r, line], i) => {
		t.emit(run(i + 1, 'cmd' + i));
		t.emit(Object.assign({ type: 'end', id: i + 1, notes: ['[LevelCode Shell: note ' + i + ']'] }, r));
		t.timers.drain();
		const s = a.screen();
		assert.strictEqual(s[s.length - 1], line);
		assert.strictEqual(s[s.length - 2], '[LevelCode Shell: note ' + i + ']');
	});
	t.timers.advance(0);
	assert.strictEqual(duration(0), '0ms');
	assert.strictEqual(duration(1400), '1.4s');
	assert.strictEqual(duration(72000), '1m 12s');
});

test('runs are separated by a blank line and share one tab; output of a run that has not ended is not mixed with the next', () => {
	const t = setup();
	t.emit(run(1, 'echo one'));
	const a = t.attach();
	t.emit({ type: 'chunk', id: 1, stream: 'stdout', text: 'one\n' });
	t.emit(run(2, 'echo two'));                                 // started while 1 is still going
	t.emit({ type: 'chunk', id: 2, stream: 'stdout', text: 'two\n' });
	t.emit({ type: 'chunk', id: 1, stream: 'stdout', text: 'one more\n' });
	t.emit({ type: 'end', id: 1, exitCode: 0, how: 'exit', notes: [] });
	t.emit({ type: 'end', id: 2, exitCode: 1, how: 'exit', notes: [] });
	t.timers.drain();
	assert.deepStrictEqual(a.screen(), [
		'$ echo one', 'in scratch', 'one', 'one more', '✓ exit 0 · 0ms',
		'', '$ echo two', 'in scratch', 'two', '✗ exit 1 · 0ms',
	]);
	assert.strictEqual(t.fv.state.terminals.length, 1);
});

test('a multi-line command shows its first line and how many more; a long one is cut', () => {
	const t = setup();
	t.emit(run(1, 'cat <<EOF\nline\nEOF'));
	const a = t.attach();
	t.emit({ type: 'end', id: 1, exitCode: 0, how: 'exit', notes: [] });
	t.emit(run(2, 'echo ' + 'x'.repeat(500)));
	t.emit({ type: 'end', id: 2, exitCode: 0, how: 'exit', notes: [] });
	t.timers.drain();
	const s = a.screen().join('\n');
	assert.ok(/\$ cat <<EOF \(\+2 more lines\)/.test(s), s);
	assert.ok(/x{200}…/.test(a.screen().join('').replace(/\s/g, '')), 'cut with an ellipsis');
	assert.ok(!a.screen().join('').includes('x'.repeat(400)));
});

test('what the model wrote and what a file printed reach the tab only through forTerminal and the filter', async () => {
	const t = setup();
	const evil = E + '[6n' + E + ']0;title\x07' + E + '[?1000h' + '‮';
	t.emit(run(1, 'echo ' + evil, { explanation: 'looks fine ' + evil, cwd: '/scratch/' + evil }));
	const a = t.attach();
	t.emit({ type: 'chunk', id: 1, stream: 'stdout', text: 'out ' + evil + '\n' });
	t.emit({ type: 'end', id: 1, exitCode: 0, how: 'exit', notes: ['note ' + evil] });
	t.timers.drain();
	const w = a.all();
	// nothing but our own colours: no query, no mode, no title, no bidi
	const stripped = w.replace(/\x1b\[[0-9;]*m/g, '');
	assert.ok(!stripped.includes(E), JSON.stringify(stripped));
	assert.ok(!/‮/.test(w));
	assert.ok(/␛\[6n/.test(w), 'the command shows the escape as a picture, so the visitor can read what it was');
	const xt = needXterm('the agent tab\'s text against xterm.js');
	if (!xt) { return; }
	const term = new xt.Terminal({ cols: 80, rows: 30, allowProposedApi: true });
	const replies = [];
	term.onData((d) => replies.push(d));
	await new Promise((r) => term.write(w, r));
	assert.deepStrictEqual(replies, []);
	assert.strictEqual(term.modes.mouseTrackingMode, 'none');
});

test('reveal: the first run opens the tab without taking the focus; later runs only add; the guard holds it back', () => {
	const t = setup({ mode: 'firstRun' });
	t.emit(run(1, 'a'));
	const term = t.terminal();
	assert.deepStrictEqual(term.shown, [true], 'show(true): preserveFocus');
	t.emit({ type: 'end', id: 1, exitCode: 0, how: 'exit', notes: [] });
	t.emit(run(2, 'b'));
	assert.deepStrictEqual(term.shown, [true], 'not again');

	// someone typed in a shell 5 s ago: no reveal, however the mode is set
	const u = setup({ mode: 'always' });
	u.activity.lastInput = u.timers.now() - 5000;
	u.emit(run(1, 'a'));
	assert.deepStrictEqual(u.terminal().shown, []);
	u.emit({ type: 'end', id: 1, exitCode: 0, how: 'exit', notes: [] });
	u.timers.advance(31000);
	u.emit(run(2, 'b'));
	assert.deepStrictEqual(u.terminal().shown, [true], 'after the guard has passed');
	u.emit({ type: 'end', id: 2, exitCode: 0, how: 'exit', notes: [] });
	u.emit(run(3, 'c'));
	assert.deepStrictEqual(u.terminal().shown, [true, true], 'always: every run');

	const n = setup({ mode: 'never' });
	n.emit(run(1, 'a'));
	assert.deepStrictEqual(n.terminal().shown, []);
});

test('the mode is read at each run, so a change in Settings applies to the next one', () => {
	const t = setup({ mode: 'never' });
	t.emit(run(1, 'a'));
	t.emit({ type: 'end', id: 1, exitCode: 0, how: 'exit', notes: [] });
	t.state.mode = 'always';
	t.emit(run(2, 'b'));
	assert.deepStrictEqual(t.terminal().shown, [true]);
});

test('unseen output marks the tab name with a bullet until the tab becomes active', () => {
	const t = setup({ mode: 'never' });
	t.emit(run(1, 'a'));
	const a = t.attach();
	assert.deepStrictEqual(a.names, [UNSEEN_NAME], 'output arrived and the tab is not the active one');
	t.emit({ type: 'end', id: 1, exitCode: 0, how: 'exit', notes: [] });
	assert.deepStrictEqual(a.names, [UNSEEN_NAME], 'set once');
	t.fv.setActive(a.term);
	assert.deepStrictEqual(a.names, [UNSEEN_NAME, NAME]);
	// an active tab is never marked
	t.emit(run(2, 'b'));
	assert.deepStrictEqual(a.names, [UNSEEN_NAME, NAME]);
});

test('closing the tab only hides it: runs in flight do not throw, and the next run makes a new one', () => {
	const t = setup({ mode: 'never' });
	t.emit(run(1, 'sleep 5'));
	const a = t.attach();
	a.pty.close();
	assert.doesNotThrow(() => {
		t.emit({ type: 'chunk', id: 1, stream: 'stdout', text: 'late\n' });
		t.emit({ type: 'end', id: 1, exitCode: 0, how: 'exit', notes: [] });
	});
	t.fv.state.terminals.length = 0;      // the workbench has dropped it
	t.emit(run(2, 'ls'));
	assert.strictEqual(t.fv.state.terminals.length, 1, 'made again');
	const b = t.attach();
	t.emit({ type: 'end', id: 2, exitCode: 0, how: 'exit', notes: [] });
	t.timers.drain();
	assert.deepStrictEqual(b.screen().slice(0, 2), ['$ ls', 'in scratch'], 'a clean tab: nothing from the run before');
});

test('typing in the tab does nothing destructive: Ctrl+C says where Stop is, other keys say what the tab is, once', () => {
	const t = setup({ mode: 'never' });
	t.emit(run(1, 'sleep 5'));
	const a = t.attach();
	a.pty.handleInput('\x03');
	t.timers.drain();
	assert.ok(/Stop button on its card in the chat/.test(a.screen().join('\n')), a.screen().join('\n'));
	a.pty.handleInput('x');
	a.pty.handleInput('y');
	t.timers.drain();
	const hints = a.screen().filter((l) => /takes no input/.test(l));
	assert.strictEqual(hints.length, 1);
	// reports the workbench types are not "input"
	const before = a.writes.length;
	a.pty.handleInput(E + '[1;1R');
	a.pty.handleInput(E + '[I');
	t.timers.drain();
	assert.strictEqual(a.writes.length, before);
});

test('what is written before the workbench opens the pty is held and delivered on open', () => {
	const t = setup({ mode: 'never' });
	t.emit(run(1, 'ls'));
	t.emit({ type: 'chunk', id: 1, stream: 'stdout', text: 'x\n' });
	t.emit({ type: 'end', id: 1, exitCode: 0, how: 'exit', notes: [] });
	t.timers.drain();
	const a = t.attach();
	assert.deepStrictEqual(a.screen(), ['$ ls', 'in scratch', 'x', '✓ exit 0 · 0ms']);
});

test('output is capped per run and says so', () => {
	const t = setup({ mode: 'never', outputLimit: 200 });
	t.emit(run(1, 'yes'));
	const a = t.attach();
	t.emit({ type: 'chunk', id: 1, stream: 'stdout', text: 'y\n'.repeat(500) });
	t.emit({ type: 'end', id: 1, exitCode: 0, how: 'exit', notes: [] });
	t.timers.drain();
	assert.ok(/output limit reached/.test(a.screen().join('\n')));
	assert.ok(a.screen().filter((l) => l === 'y').length <= 70);
});

test('showAgent makes the tab if it is not there, and takes the focus', () => {
	const t = setup();
	t.tab.show();
	const term = t.terminal();
	assert.deepStrictEqual(term.shown, [false]);
	const a = t.attach();
	assert.ok(/commands appear here as they run/.test(a.screen().join('\n')));
	t.tab.show();
	assert.deepStrictEqual(term.shown, [false, false]);
	assert.strictEqual(t.fv.state.terminals.length, 1);
});

test('dispose stops listening and removes the tab', () => {
	const t = setup();
	t.emit(run(1, 'ls'));
	const term = t.terminal();
	t.tab.dispose();
	assert.strictEqual(t.listeners.size, 0);
	assert.strictEqual(term.disposed, true);
	assert.doesNotThrow(() => t.emit(run(2, 'ls')));
});

test('at most 8 notes of a run are shown', () => {
	const t = setup({ mode: 'never' });
	t.emit(run(1, 'ls'));
	const a = t.attach();
	t.emit({ type: 'end', id: 1, exitCode: 0, how: 'exit', notes: Array.from({ length: 12 }, (_, i) => 'note ' + (i + 1)) });
	t.timers.drain();
	const s = a.screen();
	for (let i = 1; i <= 8; i++) { assert.ok(s.includes('note ' + i), 'note ' + i); }
	assert.ok(!s.includes('note 9'));
});

test('an explanation and every note are cut at 300 characters, whatever they are made of; the explanation counts in the run\'s budget', () => {
	const t = setup({ mode: 'never', outputLimit: 2000 });
	const huge = 'e'.repeat(5000000);
	t.emit(run(1, 'ls', { explanation: huge }));
	const a = t.attach();
	t.emit({ type: 'chunk', id: 1, stream: 'stdout', text: 'o'.repeat(5000) });
	t.emit({ type: 'end', id: 1, exitCode: 0, how: 'exit', notes: ['n'.repeat(3000000), 'second', 'third'] });
	t.timers.drain();
	const s = a.screen();
	assert.ok(s.join('').startsWith('e'.repeat(300) + '…$ ls'), 'exactly 300 characters, then the mark, then the command (the tab is 200 wide: it wrapped)');
	assert.ok(a.writes.join('').length < 6000, 'what was written: ' + a.writes.join('').length);
	// the budget: 2000 characters for the run, and the explanation took 301 of them
	const shown = s.filter((l) => /^o+$/.test(l)).join('').length;
	assert.ok(shown > 0 && shown <= 2000 - 301, 'output shown: ' + shown);
	assert.ok(s.join('').includes('n'.repeat(300) + '…second'));
	assert.ok(/output limit reached/.test(s.join('\n')));

	// what is spelled out longer than it is (an invisible character is [U+XXXX]) is cut on what is shown, and never
	// inside a surrogate pair
	const u = setup({ mode: 'never' });
	u.emit(run(1, 'ls', { explanation: '\u200b'.repeat(200) + '\u{1f600}'.repeat(200) }));
	const b = u.attach();
	u.emit({ type: 'end', id: 1, exitCode: 0, how: 'exit', notes: ['\u{1f600}'.repeat(300).replace(/^(.)/u, 'a$1')] });
	u.timers.drain();
	const first = b.screen().join('').split('$ ls')[0];
	assert.ok(first.length <= 301, first.length + '');
	assert.ok(!/[\ud800-\udbff]…$/.test(first) && !/[\ud800-\udbff]$/.test(first), 'no half of a pair');
	assert.ok(!/[\ud800-\udbff](?![\udc00-\udfff])/.test(b.all()), 'nowhere');
});

test('the tab knows the working folder of the last run, for the file links', () => {
	const t = setup({ mode: 'never' });
	assert.strictEqual(t.tab.cwd(), undefined);
	t.emit(run(1, 'ls', { cwd: '/scratch/src' }));
	assert.strictEqual(t.tab.cwd(), '/scratch/src');
	t.emit({ type: 'end', id: 1, exitCode: 0, how: 'exit', notes: [] });
	t.emit(run(2, 'ls', { cwd: '/scratch' }));
	assert.strictEqual(t.tab.cwd(), '/scratch');
});

test('an explanation is one line: line ends and the blanks around them become one space', () => {
	const t = setup({ mode: 'never' });
	t.emit(run(1, 'ls', { explanation: 'first  \n   second\r\nthird\rfourth' }));
	const a = t.attach();
	t.emit({ type: 'end', id: 1, exitCode: 0, how: 'exit', notes: [] });
	t.timers.drain();
	assert.strictEqual(a.screen()[0], 'first second third fourth');
});

(async () => {
	let n = 0;
	for (const [name, fn] of queue) { await fn(); n++; console.log('  ok - ' + name); }
	console.log(`\n${n} tests passed`);
})().catch((e) => { console.error(e); process.exit(1); });
