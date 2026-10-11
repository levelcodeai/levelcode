/*---------------------------------------------------------------------------------------------
 *  LevelCode Shell terminal: what is wired to the workbench - run: node web/test/unit/shell-terminal-index.test.js
 *
 *  createTerminalSupport against a stand-in `vscode`: the profile and the four commands that package.json contributes,
 *  the terminals they make (with a nonce of their own), the focus rules that were measured in the release build, and
 *  the agent's tab coming up from runtime.onAgentRun. The manifest is read, so the commands it names and the ones
 *  that are registered cannot drift apart.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { fakeVscode, fakeSession, manualTimers, settle, TERMINAL } = require('./helpers/shell-terminal-fakes');
const { createTerminalSupport, PROFILE_ID } = require(path.join(TERMINAL, 'index.js'));
const { KEY } = require(path.join(TERMINAL, 'history.js'));

const queue = [];
const test = (name, fn) => queue.push([name, fn]);

const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'shell', 'package.json'), 'utf8'));

function memento(initial) {
	const m = new Map(Object.entries(initial || {}));
	return { m, get: (k, d) => (m.has(k) ? m.get(k) : d), update: (k, v) => { m.set(k, v); return Promise.resolve(); } };
}

/** @param {{ settings?: Record<string, any>, global?: Record<string, any>, workspace?: Record<string, any>, folders?: any[], context?: any }} [o] */
function setup(o) {
	const opts = o || {};
	const fv = fakeVscode({ settings: opts.settings });
	const timers = manualTimers();
	const listeners = new Set();
	/** @type {any[]} */ const sessions = [];
	const folders = opts.folders || [{ name: 'scratch', root: '/scratch', uri: 'file:///scratch' }];
	const runtime = {
		folders: () => folders,
		createSession(/** @type {any} */ so) { const s = fakeSession({ cwd: (so && so.cwd) || folders[0].root }); s.created = so; sessions.push(s); return s; },
		onAgentRun(l) { listeners.add(l); return { dispose() { listeners.delete(l); } }; },
	};
	const context = opts.context || { globalState: memento(opts.global), workspaceState: memento(opts.workspace), subscriptions: [] };
	const support = createTerminalSupport({
		vscode: fv.vscode,
		runtime,
		context,
		config: { info: { commands: ['ls', 'cat'] } },
		getRandomValues: (a) => crypto.webcrypto.getRandomValues(a),
		timers,
	});
	return { fv, timers, runtime, context, support, sessions, listeners, emit: (e) => { for (const l of Array.from(listeners)) { l(e); } } };
}

test('what is registered is exactly what package.json contributes', () => {
	const t = setup();
	const contributed = manifest.contributes.commands.map((c) => c.command).sort();
	assert.deepStrictEqual(Object.keys(t.fv.state.commands).sort(), contributed);
	assert.deepStrictEqual(Object.keys(t.fv.state.providers), [PROFILE_ID]);
	assert.strictEqual(manifest.contributes.terminal.profiles[0].id, PROFILE_ID, 'the profile is the FIRST contributed one: Split Terminal uses it');
	assert.ok(!('activationEvents' in manifest), 'lazy: no activation event, ever');
	t.support.dispose();
	assert.deepStrictEqual(Object.keys(t.fv.state.commands), []);
	assert.deepStrictEqual(Object.keys(t.fv.state.providers), []);
});

test('levelcode.shell.new makes a terminal with its own nonce, shows it, and takes the focus again after 250 ms', () => {
	const t = setup();
	t.fv.state.commands['levelcode.shell.new']();
	assert.strictEqual(t.fv.state.terminals.length, 1);
	const term = t.fv.state.terminals[0];
	const o = term.creationOptions;
	assert.strictEqual(o.name, 'LevelCode Shell');
	assert.ok(/^[0-9a-f]{32}$/.test(o.shellIntegrationNonce));
	assert.strictEqual(o.shellIntegrationNonce, o.pty.nonce, 'the terminal and the pty agree on the nonce');
	assert.deepStrictEqual(term.shown, [false], 'shown now, with the focus');
	t.timers.advance(249);
	assert.deepStrictEqual(term.shown, [false]);
	t.timers.advance(1);
	assert.deepStrictEqual(term.shown, [false, false], 'and again at 250 ms: the immediate form alone lost the focus about one run in five');
	// a second one: its own name and its own nonce
	t.fv.state.commands['levelcode.shell.new']();
	const second = t.fv.state.terminals[1];
	assert.strictEqual(second.name, 'LevelCode Shell (2)');
	assert.notStrictEqual(second.creationOptions.shellIntegrationNonce, o.shellIntegrationNonce);
	assert.strictEqual(t.sessions.length, 2, 'a session each');
});

test('the profile provider makes the terminal; showing it waits for the workbench to open it, then shows it and re-focuses', () => {
	const t = setup();
	const profile = t.fv.state.providers[PROFILE_ID].provideTerminalProfile();
	assert.ok(profile.options.pty && /^[0-9a-f]{32}$/.test(profile.options.shellIntegrationNonce));
	assert.strictEqual(profile.options.name, 'LevelCode Shell');
	const term = t.fv.openProfileTerminal(profile);
	assert.deepStrictEqual(term.shown, [false]);
	t.timers.advance(250);
	assert.deepStrictEqual(term.shown, [false, false]);
	// the one the command made is not shown twice by the hook
	t.fv.state.commands['levelcode.shell.new']();
	const made = t.fv.state.terminals[t.fv.state.terminals.length - 1];
	assert.deepStrictEqual(made.shown, [false]);
	// somebody else's terminal is left alone
	const foreign = t.fv.vscode.window.createTerminal({ name: 'other', pty: { onDidWrite() { }, open() { }, close() { } } });
	assert.deepStrictEqual(foreign.shown, []);
	t.timers.advance(1000);
	assert.deepStrictEqual(foreign.shown, []);
});

test('toggle: shows and focuses the active LevelCode terminal, else the first, else makes one', () => {
	const t = setup();
	const toggle = t.fv.state.commands['levelcode.shell.toggle'];
	toggle();
	assert.strictEqual(t.fv.state.terminals.length, 1);
	const first = t.fv.state.terminals[0];
	toggle();
	assert.strictEqual(t.fv.state.terminals.length, 1, 'one is enough');
	assert.ok(first.shown.length >= 2);
	t.fv.state.commands['levelcode.shell.new']();
	const second = t.fv.state.terminals[1];
	t.fv.setActive(second);
	const n = second.shown.length;
	toggle();
	assert.strictEqual(second.shown.length, n + 1, 'the active one');
	for (const s of [first, second]) { assert.ok(s.shown.every((x) => x === false), 'always with the focus'); }
});

test('a new shell starts where the active one is, else where the last one was', () => {
	const t = setup({ workspace: { 'levelcode.shell.cwd': '/scratch/remembered' } });
	t.fv.state.commands['levelcode.shell.new']();
	assert.strictEqual(t.sessions[0].created.cwd, '/scratch/remembered', 'from workspaceState');
	t.sessions[0].cwd = '/scratch/src';
	t.fv.setActive(t.fv.state.terminals[0]);
	t.fv.state.commands['levelcode.shell.new']();
	assert.strictEqual(t.sessions[1].created.cwd, '/scratch/src', 'the active shell\'s working folder');
});

test('the prompt names a folder the engine had to mount elsewhere by its own name', () => {
	// a folder at the root of the file system cannot be mounted there: the runtime puts it under /mnt, and the cwd is
	// a path in that mount. The terminal asks the runtime's own mount plan, so the label still says "site".
	const fv = fakeVscode();
	const runtime = {
		folders: () => [{ name: 'site', root: '/', uri: 'file:///' }],
		createSession: () => fakeSession({ cwd: '/mnt/site/src' }),
		onAgentRun: () => ({ dispose() { } }),
	};
	const support = createTerminalSupport({ vscode: fv.vscode, runtime, context: { globalState: memento(), workspaceState: memento() }, getRandomValues: (a) => crypto.webcrypto.getRandomValues(a), timers: manualTimers() });
	fv.state.commands['levelcode.shell.new']();
	const pty = fv.state.terminals[0].creationOptions.pty;
	const written = [];
	pty.onDidWrite((d) => written.push(d));
	pty.open({ columns: 80, rows: 24 });
	const visible = written.join('').replace(/\x1b\]633;[^\x1b]*\x1b\\/g, '');      // what shows, without the marks
	assert.ok(visible.includes('site/src'), JSON.stringify(visible.slice(-80)));
	assert.ok(!visible.includes('/mnt/site'));
	support.dispose();
});

test('the history is shared by every terminal, comes from globalState, and clearHistory empties both', async () => {
	const t = setup({ global: { [KEY]: ['old'] } });
	t.fv.state.commands['levelcode.shell.new']();
	t.fv.state.commands['levelcode.shell.new']();
	const [a, b] = t.fv.state.terminals.map((x) => x.creationOptions.pty);
	a.open({ columns: 60, rows: 10 });
	b.open({ columns: 60, rows: 10 });
	a.handleInput('echo shared');
	a.handleInput('\r');
	assert.deepStrictEqual(t.context.globalState.m.get(KEY), ['old', 'echo shared']);
	// the other terminal sees it on its next Up
	const seen = [];
	b.onDidWrite((d) => seen.push(d));
	b.handleInput(String.fromCharCode(0x1b) + '[A');
	assert.ok(seen.join('').includes('echo shared'));
	t.fv.state.commands['levelcode.shell.clearHistory']();
	assert.deepStrictEqual(t.context.globalState.m.get(KEY), []);
	assert.ok(t.fv.state.messages.length === 1);
});

test('levelcode.shell.historySize is read when the history is made and again when it changes', () => {
	const t = setup({ settings: { 'levelcode.shell.historySize': 2 }, global: { [KEY]: ['a', 'b', 'c', 'd'] } });
	t.fv.state.commands['levelcode.shell.new']();
	const pty = t.fv.state.terminals[0].creationOptions.pty;
	pty.open({ columns: 60, rows: 10 });
	pty.handleInput('x');
	pty.handleInput('\r');
	assert.deepStrictEqual(t.context.globalState.m.get(KEY), ['d', 'x'], 'the cap of 2 held');
	t.fv.settings['levelcode.shell.historySize'] = 1;
	t.fv.configChanged('levelcode.shell.historySize');
	assert.deepStrictEqual(t.context.globalState.m.get(KEY), ['x']);
});

test('the agent\'s tab comes up from the runtime, and is not revealed over a terminal someone is typing in', () => {
	const t = setup({ settings: { 'levelcode.shell.revealAgentRuns': 'always' } });
	t.fv.state.commands['levelcode.shell.new']();
	const pty = t.fv.state.terminals[0].creationOptions.pty;
	pty.open({ columns: 60, rows: 10 });
	pty.handleInput('l');                                          // typed just now
	t.emit({ type: 'start', id: 1, command: 'ls', cwd: '/scratch' });
	const agent = t.fv.state.terminals.find((x) => x.name === 'LevelCode Agent');
	assert.ok(agent, 'the tab exists');
	assert.deepStrictEqual(agent.shown, [], 'but the panel was not taken from the shell');
	t.emit({ type: 'end', id: 1, exitCode: 0, how: 'exit', notes: [] });
	t.timers.advance(31000);
	t.emit({ type: 'start', id: 2, command: 'ls', cwd: '/scratch' });
	assert.deepStrictEqual(agent.shown, [true]);
	t.fv.state.commands['levelcode.shell.showAgent']();
	assert.deepStrictEqual(agent.shown, [true, false]);
});

test('a terminal that is closed is forgotten: its name is free again', () => {
	const t = setup();
	t.fv.state.commands['levelcode.shell.new']();
	t.fv.state.commands['levelcode.shell.new']();
	t.fv.state.terminals[0].dispose();
	t.fv.state.commands['levelcode.shell.new']();
	assert.deepStrictEqual(t.fv.state.terminals.map((x) => x.name), ['LevelCode Shell (2)', 'LevelCode Shell']);
});

test('dispose closes what was made and stops listening', () => {
	const t = setup();
	t.fv.state.commands['levelcode.shell.new']();
	const term = t.fv.state.terminals[0];
	t.support.dispose();
	assert.strictEqual(term.disposed, true);
	assert.strictEqual(t.listeners.size, 0);
});

/** Open the pty of the terminal a command made, as the workbench does, and collect what it writes. */
function openShell(t) {
	t.fv.state.commands['levelcode.shell.new']();
	const term = t.fv.state.terminals[t.fv.state.terminals.length - 1];
	const pty = term.creationOptions.pty;
	const written = [];
	pty.onDidWrite((d) => written.push(d));
	pty.open({ columns: 100, rows: 20 });
	return { term, pty, written, text: () => written.join('') };
}

test('the working folder a command ended in is kept in workspaceState, and the next shell starts there', async () => {
	const t = setup();
	const a = openShell(t);
	a.pty.handleInput('cd src');
	a.pty.handleInput('\r');
	t.sessions[0].finish({ cwd: '/scratch/src' });
	await settle();
	assert.strictEqual(t.context.workspaceState.m.get('levelcode.shell.cwd'), '/scratch/src');
	// no LevelCode terminal is the active one: the last working folder is where the new one begins
	t.fv.state.active = undefined;
	t.fv.state.commands['levelcode.shell.new']();
	assert.strictEqual(t.sessions[1].created.cwd, '/scratch/src');
});

test('a workspaceState that throws or rejects does not fail a command, and is not an unhandled rejection', async () => {
	const seen = [];
	const onRejection = (e) => seen.push(e);
	process.on('unhandledRejection', onRejection);
	try {
		for (const update of [() => { throw new Error('storage is gone'); }, () => Promise.reject(new Error('quota'))]) {
			const context = { globalState: memento(), workspaceState: { get: () => undefined, update }, subscriptions: [] };
			const t = setup({ context });
			const a = openShell(t);
			a.pty.handleInput('echo hi');
			a.pty.handleInput('\r');
			t.sessions[0].finish({ cwd: '/scratch/src' });
			await settle();
			await settle();
			assert.ok(/Cwd=\/scratch\/src;[0-9a-f]+\x1b\\\r\x1b\[J\x1b\]633;A\x1b\\.*scratch\/src.* \$ /.test(a.text().slice(-200)), 'the prompt came back: ' + JSON.stringify(a.text().slice(-200)));
		}
	} finally {
		process.off('unhandledRejection', onRejection);
	}
	assert.deepStrictEqual(seen, []);
});

test('the profile provider reserves its terminal\'s name before the workbench opens it, so two made at once are not both "LevelCode Shell"', () => {
	const t = setup();
	const first = t.fv.state.providers[PROFILE_ID].provideTerminalProfile();
	const second = t.fv.state.providers[PROFILE_ID].provideTerminalProfile();
	assert.strictEqual(first.options.name, 'LevelCode Shell');
	assert.strictEqual(second.options.name, 'LevelCode Shell (2)');
	t.fv.openProfileTerminal(first);
	t.fv.openProfileTerminal(second);
	t.fv.state.commands['levelcode.shell.new']();
	assert.deepStrictEqual(t.fv.state.terminals.map((x) => x.name), ['LevelCode Shell', 'LevelCode Shell (2)', 'LevelCode Shell (3)']);
});

test('historySize 0 hides what is stored, empties the store, and remembers nothing', () => {
	const t = setup({ settings: { 'levelcode.shell.historySize': 0 }, global: { [KEY]: ['old one', 'old two'] } });
	assert.deepStrictEqual(t.context.globalState.m.get(KEY), [], 'forgotten, not only hidden');
	const a = openShell(t);
	a.pty.handleInput(String.fromCharCode(0x1b) + '[A');
	assert.ok(!/old one|old two/.test(a.text()), 'Up recalls nothing');
	a.pty.handleInput('echo hi');
	a.pty.handleInput('\r');
	assert.deepStrictEqual(t.context.globalState.m.get(KEY), []);
	a.pty.handleInput(String.fromCharCode(0x1b) + '[A');
});

test('two workspace folders of one name get prompts that tell them apart', () => {
	const t = setup({ folders: [{ name: 'proj', root: '/a/proj', uri: 'file:///a/proj' }, { name: 'proj', root: '/b/proj', uri: 'file:///b/proj' }] });
	t.fv.state.commands['levelcode.shell.new']();
	const pty = t.fv.state.terminals[0].creationOptions.pty;
	const written = [];
	pty.onDidWrite((d) => written.push(d));
	t.sessions[0].cwd = '/b/proj/src';
	pty.open({ columns: 80, rows: 24 });
	const visible = written.join('').replace(/\x1b\][^\x1b]*\x1b\\/g, '').replace(/\x1b\[[0-9;]*m/g, '').replace(/\r\x1b\[\d+C$/, '');
	assert.ok(/b\/proj\/src \$ $/.test(visible), JSON.stringify(visible.slice(-40)));
});

/* ------------------------------------------------------------------------------------------------ file links */

const token = { isCancellationRequested: false };

test('file links: registered once, for our terminals only; a path that exists opens at its line and column', async () => {
	const t = setup();
	assert.ok(t.fv.state.linkProvider, 'registered');
	t.fv.state.files['file:///scratch/src/a.js'] = 1;
	t.fv.state.files['file:///scratch/src'] = 2;
	const a = openShell(t);
	const provider = t.fv.state.linkProvider;
	const line = 'error at src/a.js:12:5 and src/ (see src/missing.js:3)';
	const links = await provider.provideTerminalLinks({ line, terminal: a.term }, token);
	assert.deepStrictEqual(links.map((l) => [line.slice(l.startIndex, l.startIndex + l.length), l.line, l.col]), [['src/a.js:12:5', 12, 5]], 'a file that exists; not a folder, not a file that does not');
	await provider.handleTerminalLink(links[0]);
	assert.strictEqual(t.fv.state.opened.length, 1);
	assert.strictEqual(t.fv.state.opened[0].uri, 'file:///scratch/src/a.js');
	const sel = t.fv.state.opened[0].options.selection;
	assert.deepStrictEqual([sel.start.line, sel.start.character], [11, 4], '0-based');
	// a terminal that is not ours is not looked at at all
	t.fv.state.stats.length = 0;
	const foreign = t.fv.vscode.window.createTerminal({ name: 'bash', pty: { onDidWrite() { }, open() { }, close() { } } });
	assert.deepStrictEqual(await provider.provideTerminalLinks({ line: 'src/a.js:1', terminal: foreign }, token), []);
	assert.deepStrictEqual(t.fv.state.stats, [], 'not even a stat');
	t.support.dispose();
	assert.strictEqual(t.fv.state.linkProvider, null);
});

test('file links are relative to the working folder of the terminal the line is in, and of the agent\'s tab', async () => {
	const t = setup({ settings: { 'levelcode.shell.revealAgentRuns': 'never' } });
	t.fv.state.files['file:///scratch/src/lib/b.js'] = 1;
	t.fv.state.files['file:///scratch/README.md'] = 1;
	const a = openShell(t);
	t.sessions[0].cwd = '/scratch/src';
	const provider = t.fv.state.linkProvider;
	const links = await provider.provideTerminalLinks({ line: 'lib/b.js:2 ../README.md /scratch/README.md', terminal: a.term }, token);
	assert.deepStrictEqual(links.map((l) => String(l.uri)), ['file:///scratch/src/lib/b.js', 'file:///scratch/README.md', 'file:///scratch/README.md']);
	// the agent's tab: the runs are reported in workspace paths, from the folder of the last run
	t.emit({ type: 'start', id: 1, command: 'cat lib/b.js', cwd: '/scratch/src' });
	const agentTab = t.fv.state.terminals.find((x) => x.name === 'LevelCode Agent');
	const fromAgent = await provider.provideTerminalLinks({ line: 'lib/b.js:7', terminal: agentTab }, token);
	assert.deepStrictEqual(fromAgent.map((l) => [String(l.uri), l.line]), [['file:///scratch/src/lib/b.js', 7]]);
	// with the agent's tab there, a terminal that is neither it nor a shell is still nobody's
	const foreign = t.fv.vscode.window.createTerminal({ name: 'bash', pty: { onDidWrite() { }, open() { }, close() { } } });
	t.fv.state.stats.length = 0;
	assert.deepStrictEqual(await provider.provideTerminalLinks({ line: 'lib/b.js:7', terminal: foreign }, token), []);
	assert.deepStrictEqual(t.fv.state.stats, []);
});

test('file links in the agent\'s tab: its folder is a workspace path, and is found in the engine through the mount of a folder that was moved', async () => {
	const t = setup({ folders: [{ name: 'site', root: '/', uri: 'file:///' }], settings: { 'levelcode.shell.revealAgentRuns': 'never' } });
	t.fv.state.files['file:///src/app.js'] = 1;
	t.emit({ type: 'start', id: 1, command: 'cat app.js', cwd: '/src' });
	const agentTab = t.fv.state.terminals.find((x) => x.name === 'LevelCode Agent');
	const links = await t.fv.state.linkProvider.provideTerminalLinks({ line: 'app.js:3', terminal: agentTab }, token);
	assert.deepStrictEqual(links.map((l) => String(l.uri)), ['file:///src/app.js']);
});

test('file links: a folder that is mounted elsewhere (the root of a file system) is found through its mount', async () => {
	const t = setup({ folders: [{ name: 'site', root: '/', uri: 'file:///' }] });
	t.fv.state.files['file:///src/app.js'] = 1;
	t.fv.state.commands['levelcode.shell.new']();
	const term = t.fv.state.terminals[0];
	assert.strictEqual(t.sessions[0].created.cwd, undefined);
	t.sessions[0].cwd = '/mnt/site';
	const links = await t.fv.state.linkProvider.provideTerminalLinks({ line: 'src/app.js:3', terminal: term }, token);
	assert.deepStrictEqual(links.map((l) => String(l.uri)), ['file:///src/app.js']);
	// and a path that leaves every mount is not a link, whatever is there
	t.fv.state.files['file:///etc/passwd'] = 1;
	assert.deepStrictEqual(await t.fv.state.linkProvider.provideTerminalLinks({ line: '../../etc/passwd', terminal: term }, token), []);
});

(async () => {
	let n = 0;
	for (const [name, fn] of queue) { await fn(); n++; console.log('  ok - ' + name); }
	console.log(`\n${n} tests passed`);
})().catch((e) => { console.error(e); process.exit(1); });
