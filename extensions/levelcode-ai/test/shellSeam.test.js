/*---------------------------------------------------------------------------------------------
 *  The shell seam, EXECUTED — run: node test/shellSeam.test.js
 *
 *  agent.js starts a command through host.spawn. On the desktop that is child_process.spawn with the
 *  options it has always had; in the browser build it is whatever shell registered itself (LevelCode
 *  Shell, a web extension), and when there is none the shell tools are not offered at all.
 *
 *  Two things are pinned here and nowhere else:
 *    1. THE DESKTOP DID NOT CHANGE: the same spawn options, the whole tool list, the same prompt.
 *    2. THE BROWSER'S CONTRACT: what a shell is handed, what the model is told about it, and that a
 *       command's file changes go through the SAME review as edit_file / write_file / delete_file.
 *
 *  Real runAgent → runTool → run_command → runCommand → host.spawn; `vscode`, the provider (scripted
 *  turns) and child_process (a fake child the test drives) are replaced, as agentRunCommand.test.js does.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const { EventEmitter } = require('events');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-seam-'));
const folder = (name, p) => ({ name, uri: { fsPath: p, path: p, toString: () => 'file://' + p, with: (o) => ({ fsPath: o.path, path: o.path, toString: () => 'file://' + o.path }) } });
const vscodeMock = {
	workspace: { workspaceFolders: [folder('app', root)], findFiles: async () => [], asRelativePath: (u) => String(u.fsPath || u),
		// the browser build reads through vscode.workspace.fs; here that is the temp directory
		fs: { readFile: async (u) => fs.promises.readFile(u.fsPath),
			stat: async (u) => { const s = await fs.promises.stat(u.fsPath); return { type: s.isDirectory() ? 2 : 1, size: s.size }; } } },
	FileType: { File: 1, Directory: 2 },
	env: { appRoot: '' },
	Uri: { file: (p) => ({ fsPath: p, path: p }) },
	extensions: { getExtension: () => undefined },
};
const spawnedFake = [];
function fakeChild() { return Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), kill() { return true; } }); }
const childProcessMock = Object.assign({}, require('child_process'), {
	spawn(command, options) { const c = fakeChild(); spawnedFake.push({ command, options, child: c }); return c; },
});
const origLoad = Module._load;
// @ts-ignore — test-only loader shim
Module._load = function (request, parent, isMain) {
	if (request === 'vscode') { return vscodeMock; }
	if (request === 'child_process') { return childProcessMock; }
	return origLoad.call(this, request, parent, isMain);
};
const AI = path.join(__dirname, '..');
const providers = require('../providers/index');
let script = [];
const turns = [];
providers.streamAgentTurn = async (o) => { turns.push({ system: o.system, tools: o.tools, messages: JSON.parse(JSON.stringify(o.messages)) }); const t = script.shift(); if (!t) { throw new Error('script exhausted'); } return t; };

/** A clean module graph for agent.js/host.js, with or without the browser flag. */
function load(browser) {
	for (const k of Object.keys(require.cache)) { if (k.startsWith(AI + path.sep) && !k.includes(path.sep + 'test' + path.sep) && !k.endsWith(path.join('providers', 'index.js')) && !k.includes(path.sep + 'providers' + path.sep)) { delete require.cache[k]; } }
	if (browser) { globalThis.__LEVELCODE_BROWSER_HOST__ = true; } else { delete globalThis.__LEVELCODE_BROWSER_HOST__; }
	return { agent: require('../agent'), host: require('../host') };
}

const tool = (id, name, input) => ({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name, input }] });
const say = (text) => ({ stop_reason: 'end_turn', content: [{ type: 'text', text }] });
const resultFor = (id) => { for (const t of turns) { for (const m of t.messages) { if (m.role === 'user' && Array.isArray(m.content)) { const r = m.content.find((c) => c.tool_use_id === id); if (r) { return r.content; } } } } return null; };

let n = 0;
async function test(name, fn) { turns.length = 0; spawnedFake.length = 0; await fn(); n++; console.log('  ok - ' + name); }
const settle = () => new Promise((r) => setTimeout(r, 5));
function ctxFor(over) {
	const posted = [];
	return Object.assign({
		messages: [{ role: 'user', content: 'go' }], maxSteps: 6, post: (m) => posted.push(m), dbg: () => {},
		approve: async () => true, commandRuns: new Map(), commandStops: new Map(), signal: new AbortController().signal, posted,
	}, over);
}

(async () => {
	try {
		// ================================ THE DESKTOP ================================
		await test('DESKTOP: run_command spawns exactly what it always did — cwd, shell:true, detached:true, nothing else', async () => {
			const { agent } = load(false);
			script = [tool('t1', 'run_command', { command: 'npm test', explanation: 'x' }), say('Done: x')];
			const p = agent.runAgent(ctxFor({}));
			await settle(); await settle();
			assert.strictEqual(spawnedFake.length, 1);
			assert.strictEqual(spawnedFake[0].command, 'npm test');
			assert.deepStrictEqual(spawnedFake[0].options, { cwd: root, shell: true, detached: true });
			spawnedFake[0].child.stdout.emit('data', Buffer.from('ok\n')); spawnedFake[0].child.emit('close', 0);
			await p;
			assert.strictEqual(resultFor('t1'), 'ok\n');
		});

		await test('DESKTOP: the whole tool list and the desktop prompt are sent; no shell is "registered"', async () => {
			const { agent, host } = load(false);
			script = [say('Done: x')];
			await agent.runAgent(ctxFor({}));
			const t = turns[0];
			assert.strictEqual(host.caps.shell, true);
			assert.strictEqual(host.shellInfo(), null, 'the desktop has no registered shell: its shell is the user\'s own');
			for (const name of ['run_command', 'read_command_output']) { assert.ok(t.tools.some((x) => x.name === name), name + ' must be offered'); }
			const rc = t.tools.find((x) => x.name === 'run_command');
			assert.ok(rc.input_schema.properties.background, 'run_command keeps its background argument on the desktop');
			assert.match(rc.description, /Pass background:true for commands that do not exit on their own/);
			assert.match(t.system, /Commands that do NOT exit on their own \(dev servers, file watchers, tail -f\) MUST be run with run_command background:true/);
			assert.ok(!/LevelCode Shell|There is no terminal/.test(t.system));
		});

		await test('DESKTOP: connectShell touches nothing and background:true still starts a background command', async () => {
			const { agent, host } = load(false);
			assert.strictEqual(await host.connectShell(), false);
			script = [tool('b1', 'run_command', { command: 'npm run dev', background: true, explanation: 'x' }), say('Done: x')];
			const ctx = ctxFor({});
			await agent.runAgent(ctx);
			assert.strictEqual(spawnedFake.length, 1);
			assert.match(resultFor('b1'), /^Started in the background as id "b1"/);
			assert.ok(ctx.commandRuns.has('b1'));
		});

		// ================================ A BROWSER WITH NO SHELL ================================
		await test('BROWSER, no shell: the shell tools are withheld and the prompt does not promise them — even with skills off', async () => {
			const { agent, host } = load(true);
			script = [say('Done: x')];
			await agent.runAgent(ctxFor({ skills: null }));    // skills.enabled=false: the path that used to send the DESKTOP prompt
			const t = turns[0];
			assert.strictEqual(host.caps.shell, false);
			assert.ok(!t.tools.some((x) => /command/.test(x.name)));
			assert.match(t.system, /There is no terminal/);
			assert.ok(!/run_command background:true|EVERY run_command|Only run_command still needs approval/.test(t.system), 'the desktop prompt leaked');
		});

		// ================================ A BROWSER WITH THE SHELL ================================
		/** A shell the test controls: records what it is handed and returns a child it drives. */
		function registerFake(host, over) {
			const calls = [];
			const impl = Object.assign({
				info: { label: 'LevelCode Shell', background: false, programs: false, network: false, commands: ['cat', 'ls', 'grep'], missing: ['node', 'npm', 'git'] },
				spawn(command, opts) { const c = fakeChild(); calls.push({ command, opts, child: c }); return c; },
			}, over);
			host.registerShell(impl);
			return calls;
		}

		await test('BROWSER, shell registered: caps.shell is live, run_command is offered as what it is, read_command_output is not', async () => {
			const { agent, host } = load(true);
			assert.strictEqual(host.caps.shell, false, 'false until a shell registers');
			registerFake(host);
			assert.strictEqual(host.caps.shell, true, 'a getter, not a snapshot taken at load');
			script = [say('Done: x')];
			await agent.runAgent(ctxFor({ skills: null }));
			const t = turns[0];
			const rc = t.tools.find((x) => x.name === 'run_command');
			assert.ok(rc, 'run_command is offered');
			assert.ok(!('background' in rc.input_schema.properties), 'no background argument for a shell that cannot keep a command running');
			assert.ok(!t.tools.some((x) => x.name === 'read_command_output'));
			assert.match(t.system, /run_command runs ONE command line in LevelCode Shell/);
			assert.match(t.system, /Programs that exist: cat ls grep\. Shell builtins work too\. Everything else answers "command not found" \(exit 127\) — node, npm, git …/);
			assert.match(t.system, /There is no network\. Nothing runs in the background/);
			// A Stop, or the time limit, while the command's changes are being reviewed settles the run at once, and what the
			// review had applied stays in Keep/Undo (the shell's note says so): the prompt must not promise that nothing changed.
			assert.ok(!/A stopped command changes nothing/.test(t.system), 'the prompt promises what a Stop during the review does not keep');
			assert.match(t.system, /A command stopped while it runs changes nothing; one stopped while its file changes were being reviewed may have applied some of them \(they are then in the Keep\/Undo review\), and its result says so\./);
			assert.match(t.system, /NONE of that command's changes are applied/);
			assert.ok(!/dev servers|tail -f|There is no terminal|Run the extension unit tests/.test(t.system));
		});

		await test('BROWSER, shell registered: the shell is handed the command, the cwd, the folders and a commit hook — never a process', async () => {
			const { agent, host } = load(true);
			const calls = registerFake(host);
			script = [tool('t1', 'run_command', { command: 'ls', explanation: 'x' }), say('Done: x')];
			const p = agent.runAgent(ctxFor({}));
			await settle(); await settle();
			assert.strictEqual(spawnedFake.length, 0, 'child_process was not used');
			assert.strictEqual(calls.length, 1);
			assert.strictEqual(calls[0].command, 'ls');
			assert.strictEqual(calls[0].opts.cwd, root);
			assert.deepStrictEqual(calls[0].opts.folders, [{ name: 'app', root, uri: 'file://' + root }]);
			assert.strictEqual(typeof calls[0].opts.commit, 'function');
			calls[0].child.stdout.emit('data', 'a.txt\n'); calls[0].child.emit('close', 0);
			await p;
			assert.strictEqual(resultFor('t1'), 'a.txt\n');
		});

		await test('BROWSER, shell registered: background:true is refused before anyone is asked, and nothing starts', async () => {
			const { agent, host } = load(true);
			const calls = registerFake(host);
			let asked = 0;
			script = [tool('b1', 'run_command', { command: 'sleep 1', background: true, explanation: 'x' }), say('Done: x')];
			await agent.runAgent(ctxFor({ approve: async () => { asked++; return true; } }));
			assert.strictEqual(asked, 0);
			assert.strictEqual(calls.length, 0);
			assert.match(resultFor('b1'), /^ERROR: background commands are not available in LevelCode Shell/);
		});

		await test('BROWSER, shell registered: a command\'s file changes go through ctx.applyEdit / ctx.applyDelete, and are verified and counted like edits', async () => {
			const { agent, host } = load(true);
			const calls = registerFake(host);
			const edits = [], deletes = [];
			const enc = (s) => new TextEncoder().encode(s);
			script = [tool('t1', 'run_command', { command: 'make-changes', explanation: 'x' }), say('Done: x')];
			const ctx = ctxFor({
				applyEdit: async (r) => { edits.push(r); return true; },
				applyDelete: async (r) => { deletes.push(r); return true; },
				touched: new Set(['/gone.txt'.replace('/', root + '/')]),
			});
			const p = agent.runAgent(ctx);
			await settle(); await settle();
			const commit = calls[0].opts.commit;
			// the file the command deletes is on disk as the command saw it (readNow reads through host.readBytes)
			fs.writeFileSync(path.join(root, 'gone.txt'), 'bye\n');
			const out = await commit([
				{ kind: 'write', path: root + '/new.txt', existed: false, before: null, after: enc('hi\n') },
				{ kind: 'delete', path: root + '/gone.txt', existed: true, before: enc('bye\n') },
				{ kind: 'write', path: root + '/dist/app.js', existed: false, before: null, after: enc('x') },
				{ kind: 'mkdir', path: root + '/empty' },
			]);
			assert.deepStrictEqual(edits, [{ path: 'dist/app.js', exists: false, proposed: 'x' }, { path: 'new.txt', exists: false, proposed: 'hi\n' }], 'build output is reviewed like any file: there is no unreviewed path');
			assert.deepStrictEqual(deletes, [{ path: 'gone.txt' }]);
			assert.deepStrictEqual(out.rest.map((c) => c.kind + ':' + path.basename(c.path)), ['mkdir:empty'], 'only directories are left to the shell');
			assert.strictEqual(out.failed, 0);
			assert.strictEqual(out.refused, false);
			assert.ok(ctx.touched.has(root + '/new.txt') && !ctx.touched.has(root + '/gone.txt'));
			assert.strictEqual(ctx.editCount, 3, 'each reviewed file is an edit: verification and the "N edits" count see them');
			assert.match(out.notes.join('\n'), /3 files changed, ready for Keep\/Undo: \+dist\/app\.js \+new\.txt -gone\.txt/);
			calls[0].child.emit('close', 0);
			await p;
		});

		await test('BROWSER, shell registered: a file with unsaved changes in the editor is not replaced by a command — the set is refused whole, nothing reaches the review', async () => {
			const { agent, host } = load(true);
			const calls = registerFake(host);
			const edits = [], deletes = [];
			const enc = (s) => new TextEncoder().encode(s);
			// The review replaces the whole buffer and saves it; its Undo restores the file as it was on disk, not what was typed.
			const doc = (p, isDirty) => ({ uri: { fsPath: p, path: p, toString: () => 'file://' + p }, isDirty });
			fs.writeFileSync(path.join(root, 'notes.txt'), 'saved\n');
			script = [tool('t1', 'run_command', { command: 'sed -i s/saved/x/ notes.txt', explanation: 'x' }), say('Done: x')];
			const ctx = ctxFor({ applyEdit: async (r) => { edits.push(r); return true; }, applyDelete: async (r) => { deletes.push(r); return true; } });
			const p = agent.runAgent(ctx);
			await settle(); await settle();
			const commit = calls[0].opts.commit;
			const modify = () => ({ kind: 'write', path: root + '/notes.txt', existed: true, before: enc('saved\n'), after: enc('x\n') });
			try {
				vscodeMock.workspace.textDocuments = [doc(root + '/notes.txt', true)];
				let out = await commit([modify(), { kind: 'write', path: root + '/other.txt', existed: false, before: null, after: enc('o\n') }]);
				assert.strictEqual(out.refused, true);
				assert.deepStrictEqual(edits, [], 'not even the other file: one refusal refuses the set');
				assert.match(out.notes.join('\n'), /refused: notes\.txt — it has unsaved changes in the editor/);
				out = await commit([{ kind: 'delete', path: root + '/notes.txt', before: enc('saved\n') }]);
				assert.strictEqual(out.refused, true);
				assert.deepStrictEqual(deletes, []);
				// On a disk that ignores case the editor has ONE document for both spellings, and the review would replace it.
				vscodeMock.workspace.textDocuments = [doc(root + '/NOTES.txt', true)];
				assert.strictEqual((await commit([modify()])).refused, true, 'the dirty buffer of another spelling of the name');
				// Open and saved is no reason to refuse.
				vscodeMock.workspace.textDocuments = [doc(root + '/notes.txt', false)];
				out = await commit([modify()]);
				assert.strictEqual(out.refused, false);
				assert.deepStrictEqual(edits.map((e) => e.path), ['notes.txt']);
			} finally {
				delete vscodeMock.workspace.textDocuments;
			}
			calls[0].child.emit('close', 0);
			await p;
		});

		await test('BROWSER, two workspace folders called proj: a command\'s change to the second is never written into the first', async () => {
			const { agent, host } = load(true);
			const calls = registerFake(host);
			const enc = (s) => new TextEncoder().encode(s);
			const a = path.join(root, 'a', 'proj'), b = path.join(root, 'b', 'proj');
			fs.mkdirSync(a, { recursive: true }); fs.mkdirSync(b, { recursive: true });
			fs.writeFileSync(path.join(a, 'x.txt'), 'A\n'); fs.writeFileSync(path.join(b, 'x.txt'), 'B\n');
			const saved = vscodeMock.workspace.workspaceFolders;
			vscodeMock.workspace.workspaceFolders = [folder('proj', a), folder('proj', b)];
			try {
				// What reviewSession.applyEdit / applyDelete do to find the file they change: the same resolver, then host.uriFor.
				const written = [];
				const find = async (r, mustExist) => { const abs = await agent.resolveWorkspacePathAsync(r.path, { mustExist }); if (abs) { written.push(host.uriFor(abs).fsPath); } return !!abs; };
				script = [tool('t1', 'run_command', { command: 'make', explanation: 'x' }), say('Done: x')];
				const p = agent.runAgent(ctxFor({ applyEdit: (r) => find(r, !!r.exists), applyDelete: (r) => find(r, true) }));
				await settle(); await settle();
				const commit = calls[0].opts.commit;
				// readNow compares b/proj/x.txt with what the command read (B), which is right: the write is what went wrong.
				const out = await commit([
					{ kind: 'write', path: b + '/x.txt', existed: true, before: enc('B\n'), after: enc('B2\n') },
					{ kind: 'write', path: b + '/new.txt', existed: false, before: null, after: enc('n\n') },
				]);
				assert.deepStrictEqual(written, [], 'nothing is written — and nothing into ' + a);
				assert.strictEqual(out.refused, true);
				assert.match(out.notes.join('\n'), /refused: proj\/x\.txt — another workspace folder is also called "proj"/);
				// The first folder of the name is the one the review finds: a change to it is applied, there.
				const ok = await commit([{ kind: 'write', path: a + '/x.txt', existed: true, before: enc('A\n'), after: enc('A2\n') }]);
				assert.strictEqual(ok.refused, false);
				assert.deepStrictEqual(written, [a + '/x.txt']);
				calls[0].child.emit('close', 0);
				await p;
			} finally {
				vscodeMock.workspace.workspaceFolders = saved;
			}
		});

		await test('BROWSER, the shell says the run was stopped while its changes were being checked: the commit hook applies nothing', async () => {
			const { agent, host } = load(true);
			const calls = registerFake(host);
			const edits = [];
			const enc = (s) => new TextEncoder().encode(s);
			script = [tool('t1', 'run_command', { command: 'make-changes', explanation: 'x' }), say('Done: x')];
			const ctx = ctxFor({ applyEdit: async (r) => { edits.push(r); return true; }, applyDelete: async () => true });
			const p = agent.runAgent(ctx);
			await settle(); await settle();
			const commit = calls[0].opts.commit;
			const out = await commit([{ kind: 'write', path: root + '/new.txt', existed: false, before: null, after: enc('hi\n') }], { cancelled: () => true });
			assert.deepStrictEqual(edits, [], 'nothing was applied');
			assert.strictEqual(out.refused, true);
			assert.match(out.notes.join('\n'), /stopped before any file change was applied/);
			const again = await commit([{ kind: 'write', path: root + '/new.txt', existed: false, before: null, after: enc('hi\n') }]);
			assert.strictEqual(again.refused, false, 'a hook called without a control is not cancelled');
			assert.strictEqual(edits.length, 1);
			calls[0].child.emit('close', 0);
			await p;
		});

		// ---- connecting: the shell extension is found lazily, once per run, and a failure is not remembered ----
		const fakeShellApi = (over) => ({ apiVersion: 1, agent: { info: { label: 'LevelCode Shell', background: false, programs: false, network: false, commands: ['cat'] }, spawn() { return fakeChild(); } }, ...over });

		await test('BROWSER, connect: no extension now, one a moment later — the second run finds it (a failure is not cached)', async () => {
			const { host } = load(true);
			let ext;
			vscodeMock.extensions.getExtension = () => ext;
			assert.strictEqual(await host.connectShell(), false);
			assert.strictEqual(host.caps.shell, false);
			ext = { isActive: true, exports: fakeShellApi() };
			assert.strictEqual(await host.connectShell(), true, 'the second ask must look again');
			assert.strictEqual(host.caps.shell, true);
			vscodeMock.extensions.getExtension = () => undefined;
		});

		await test('BROWSER, connect: an API of another version is no shell — and a right one later is', async () => {
			const { host } = load(true);
			let ext = { isActive: true, exports: fakeShellApi({ apiVersion: 2 }) };
			vscodeMock.extensions.getExtension = () => ext;
			assert.strictEqual(await host.connectShell(), false);
			assert.strictEqual(host.shellInfo(), null);
			ext = { isActive: true, exports: fakeShellApi() };
			assert.strictEqual(await host.connectShell(), true);
			vscodeMock.extensions.getExtension = () => undefined;
		});

		await test('BROWSER, connect: an extension that does not activate in time is no shell for this run, and the run is not held for ever', async () => {
			const { host } = load(true);
			let release;
			const ext = { isActive: false, activate: () => new Promise((r) => { release = r; }), exports: undefined };
			vscodeMock.extensions.getExtension = () => ext;
			const t0 = Date.now();
			assert.strictEqual(await host.connectShell({ timeoutMs: 40 }), false);
			assert.ok(Date.now() - t0 < 1000);
			assert.strictEqual(host.caps.shell, false);
			ext.isActive = true; ext.exports = fakeShellApi(); release(ext.exports);
			assert.strictEqual(await host.connectShell(), true, 'by the next run it has finished activating');
			vscodeMock.extensions.getExtension = () => undefined;
		});

		await test('BROWSER, connect: concurrent asks share one attempt', async () => {
			const { host } = load(true);
			let calls = 0;
			vscodeMock.extensions.getExtension = () => { calls++; return { isActive: true, exports: fakeShellApi() }; };
			const [a, b] = await Promise.all([host.connectShell(), host.connectShell()]);
			assert.deepStrictEqual([a, b], [true, true]);
			assert.strictEqual(calls, 1);
			vscodeMock.extensions.getExtension = () => undefined;
		});

		await test('BROWSER, shell registered: the card and the approval show the command through the shell\'s forDisplay; the shell is still handed the real one', async () => {
			const { agent, host } = load(true);
			const calls = registerFake(host, { forDisplay: (t) => t.replace(/\u202e/g, '[U+202E]') });
			const real = 'echo \u202eevil';
			script = [tool('d1', 'run_command', { command: real, explanation: 'say \u202ehi', }), say('Done: x')];
			const approvals = [];
			const ctx = ctxFor({ approve: async (r) => { approvals.push(r); return true; } });
			const p = agent.runAgent(ctx);
			await settle(); await settle();
			assert.strictEqual(approvals.length, 1);
			assert.strictEqual(approvals[0].command, 'echo [U+202E]evil');
			assert.strictEqual(approvals[0].explanation, 'say [U+202E]hi');
			const card = ctx.posted.find((m) => m.type === 'termRun');
			assert.strictEqual(card.command, 'echo [U+202E]evil');
			assert.strictEqual(calls[0].command, real, 'what runs is what the model wrote');
			assert.strictEqual(calls[0].opts.explanation, 'say \u202ehi', 'the mirror tab gets the label, to make safe itself');
			calls[0].child.emit('close', 0);
			await p;
		});

		await test('DESKTOP: displaySafe is the identity, and nothing is registered', async () => {
			const { host } = load(false);
			assert.strictEqual(host.displaySafe('a\u202eb'), 'a\u202eb');
			const { host: bh } = load(true);
			assert.strictEqual(bh.displaySafe('x'), 'x', 'a browser with no shell, or one without forDisplay, shows text as it is');
		});

		await test('BROWSER, shell registered: the verify command runs in the shell, and its changes are reviewed too', async () => {
			const { agent, host } = load(true);
			const calls = registerFake(host);
			script = [tool('w1', 'write_file', { path: 'a.txt', content: 'x' }), say('Done: x')];
			const ctx = ctxFor({
				applyEdit: async () => true, touched: new Set(),
				verify: { enabled: true, command: 'grep -q x a.txt', maxRounds: 1, includeWarnings: false },
				getNewDiagnostics: async () => ({ text: '', count: 0 }), getTouchedUris: () => [],
			});
			const p = agent.runAgent(ctx);
			for (let i = 0; i < 40 && !calls.length; i++) { await settle(); }
			assert.strictEqual(calls.length, 1, 'the verify command reached the shell');
			assert.strictEqual(calls[0].command, 'grep -q x a.txt');
			assert.strictEqual(typeof calls[0].opts.commit, 'function');
			calls[0].child.emit('close', 0);
			await p;
			assert.ok(ctx.posted.some((m) => m.type === 'verifyDone' && m.ok === true && m.hadCommand === true));
		});

		console.log('\nshellSeam: ' + n + ' tests passed.');
	} finally {
		Module._load = origLoad;
		fs.rmSync(root, { recursive: true, force: true });
	}
})().catch((e) => { console.error(e); process.exit(1); });
