/*---------------------------------------------------------------------------------------------
 *  The engine's protocol — run: node web/test/unit/shell-engine-core.test.js
 *
 *  README.md §4 and §7, on the real (patched) engine, with a host that answers reads from memory:
 *    init -> ready; run -> out* -> done (exactly once); abort; fsr (a late one is ignored).
 *  What this pins, because the rest of the shell relies on it:
 *    - a run never rejects and never prints a stack, whatever the engine throws;
 *    - the limits in force are the table of limits.js, all of them, as the engine itself reports them;
 *    - output is streamed per top-level statement, decoded, in order;
 *    - a run that did not end by itself, or in which a write was refused, applies nothing;
 *    - cwd and env come back for the next line; a folder that had to be relocated comes back under its own path.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

// A test that waits for something that never happens must fail the suite, not end it silently with status 0.
require('../helpers/shell-exit-guard.js');

const assert = require('assert');
const path = require('path');

const { loadEngine, makeTree, makeHost, ENGINE_DIR } = require('./shell-engine-support.js');
const { createCore, describeException, humaniseLimit, decodeBytes, DEFAULT_ENV, EXCLUDED, LIMIT_LINE, DEADLINE_LINE } = require(path.join(ENGINE_DIR, 'core.js'));
const { LIMITS } = require(path.join(ENGINE_DIR, 'limits.js'));
const compat = require(path.join(ENGINE_DIR, 'compat.js'));

/** @type {Array<{ name: string, fn: () => Promise<void> | void }>} */
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

const MiB = 1024 * 1024;
const dec = new TextDecoder();

async function main() {
	const E = await loadEngine();
	const host = (files, o) => makeHost(Object.assign({ Engine: E, tree: makeTree(Object.assign({ '/w': null }, files || {})) }, o || {}));
	const kinds = (r) => r.done.changes.map((c) => c.kind + ':' + c.path);

	/* ---------------------------------------------------------------------------------------- handshake */

	test('init is answered by exactly one ready: the generation, the programs that exist, and where each folder is', async () => {
		const h = await host({}, { folders: [{ id: 'a', path: '/w', name: 'w' }, { id: 'b', path: '/tmp', name: 'tmp' }] });
		const ready = h.messages.filter((m) => m.t === 'ready');
		assert.strictEqual(ready.length, 1);
		assert.strictEqual(ready[0].gen, 1);
		assert.deepStrictEqual(ready[0].mounts, [
			{ id: 'a', name: 'w', path: '/w', at: '/w', relocated: false },
			{ id: 'b', name: 'tmp', path: '/tmp', at: '/mnt/tmp', relocated: true },
		]);
		assert.ok(Array.isArray(ready[0].commands) && ready[0].commands.every((c) => typeof c === 'string'));
		assert.deepStrictEqual(ready[0].commands, [...ready[0].commands].sort());
	});

	test('the programs are what just-bash has, minus what is not offered, plus what compat.js adds: pinned name by name', async () => {
		const h = await host();
		const ready = h.messages.find((m) => m.t === 'ready');
		const engineNames = E.getCommandNames();
		assert.deepStrictEqual([...EXCLUDED].sort(), ['gunzip', 'gzip', 'html-to-markdown', 'zcat']);
		const expected = [...new Set([...engineNames.filter((n) => !EXCLUDED.has(n)), ...compat.ADDED])].sort();
		assert.deepStrictEqual(ready.commands, expected);
		assert.deepStrictEqual(ready.commands, ('alias awk base64 basename bash cat chmod clear cmp column comm cp cut date diff dirname du echo egrep env expand expr false fgrep file find fold grep head help history hostname id join jq ln ls md5sum mkdir mktemp mv nl nproc od paste printenv printf pwd readlink realpath rev rg rm rmdir sed seq sh sha1sum sha256sum sleep sort split stat strings tac tail tee time timeout touch tr tree true unalias uname unexpand uniq wc which whoami xargs yes').split(' '));
		for (const gone of ['gzip', 'gunzip', 'zcat', 'html-to-markdown', 'tar', 'yq', 'xan', 'python3', 'sqlite3', 'curl', 'wget', 'js-exec', 'git', 'node', 'npm']) {
			assert.ok(!ready.commands.includes(gone), gone + ' is not a program of this shell');
		}
		for (const w of compat.WRAPPED) { assert.ok(ready.commands.includes(w), w); }
	});

	test('the shell itself agrees: /usr/bin and /bin list the programs, command -v finds them, the missing ones are not found', async () => {
		const h = await host();
		const ready = h.messages.find((m) => m.t === 'ready');
		const r = await h.run('ls /usr/bin | tr "\\n" " "; echo; ls /bin | wc -l; command -v grep tar git python3 gzip; echo "rc=$?"; which od xargs; which tar; echo "rc=$?"');
		assert.strictEqual(r.stdout.split('\n')[0].trim(), ready.commands.join(' '));
		assert.strictEqual(r.stdout.split('\n')[1], String(ready.commands.length));
		assert.ok(r.stdout.includes('/usr/bin/grep\nrc=1\n'), r.stdout);
		assert.ok(r.stdout.includes('/usr/bin/od\n/usr/bin/xargs\nrc=1\n'), r.stdout);
		assert.ok(!r.stdout.includes('/tar'));
	});

	test('init may name the programs it wants (it never grants more than the engine\'s own list), and re-init replaces the state', async () => {
		const h = await host({}, { start: false });
		await h.core.handle({ t: 'init', gen: 7, folders: [{ id: 'f', path: '/w', name: 'w' }], commands: ['echo', 'ls', 'tar', 'not-a-program', 'gzip'] });
		const ready = h.messages.find((m) => m.t === 'ready');
		assert.strictEqual(ready.gen, 7);
		assert.ok(ready.commands.includes('echo') && ready.commands.includes('ls'));
		assert.ok(!ready.commands.includes('tar') && !ready.commands.includes('gzip') && !ready.commands.includes('not-a-program'));
		const r = await h.run('echo hi; cat /nope; echo done');
		assert.strictEqual(r.stdout, 'hi\ndone\n');
		assert.ok(/command not found/.test(r.stderr));
	});

	test('before init, a run answers with one done and says why; garbage messages are ignored', async () => {
		const h = await host({}, { start: false });
		const r = await h.run('echo hi');
		assert.strictEqual(r.how, 'error');
		assert.strictEqual(r.exitCode, 1);
		assert.strictEqual(r.stderr, 'bash: the shell has not been started\n');
		for (const junk of [null, undefined, 42, 'run', [], {}, { t: 'nope' }, { t: 'fsr' }, { t: 'fsr', rid: 99999, ok: true }, { t: 'abort', id: 12345 }]) {
			await h.core.handle(/** @type {any} */ (junk));
		}
		assert.strictEqual(h.messages.filter((m) => m.t === 'done').length, 1);
	});

	/* ---------------------------------------------------------------------------------------- the run */

	test('a run is out* then exactly one done, its last message; the done has the documented shape', async () => {
		const h = await host({ '/w/a.txt': 'hello\n' });
		const r = await h.run('echo one; cat a.txt; echo err >&2; echo x > n.txt');
		const mine = h.messages.filter((m) => m.t !== 'fs' && m.t !== 'ready');
		assert.strictEqual(mine[mine.length - 1].t, 'done');
		assert.strictEqual(mine.filter((m) => m.t === 'done').length, 1);
		assert.ok(mine.slice(0, -1).every((m) => m.t === 'out' && m.id === r.id && (m.stream === 'stdout' || m.stream === 'stderr') && m.text.length > 0));
		assert.deepStrictEqual(Object.keys(r.done).sort(), ['changes', 'cwd', 'denied', 'env', 'exitCode', 'how', 'id', 'notes', 'stats', 't']);
		assert.deepStrictEqual([r.done.t, r.done.id, r.done.exitCode, r.done.how, r.done.cwd], ['done', r.id, 0, 'exit', '/w']);
		assert.strictEqual(r.stdout, 'one\nhello\n');
		assert.strictEqual(r.stderr, 'err\n');
		assert.deepStrictEqual(kinds(r), ['write:/w/n.txt']);
		const c = r.done.changes[0];
		assert.deepStrictEqual([c.existed, c.before, dec.decode(c.after)], [false, null, 'x\n']);
		for (const k of ['durationMs', 'changes', 'discarded', 'filesRead', 'bytesRead', 'stagedBytes']) { assert.strictEqual(typeof r.done.stats[k], 'number', k); }
		assert.strictEqual(r.done.stats.changes, 1);
		assert.strictEqual(r.done.stats.withheld, null);
	});

	test('output is streamed per top-level statement, in order, stdout and stderr where they happened', async () => {
		const h = await host();
		const r = await h.run('echo a; echo b >&2; for i in 1 2; do echo l$i; done; { echo c; echo d >&2; }; echo $(echo e)');
		assert.deepStrictEqual(r.outs.map((m) => m.stream[3] + ':' + m.text), ['o:a\n', 'e:b\n', 'o:l1\nl2\n', 'o:c\n', 'e:d\n', 'o:e\n']);
	});

	test('a run with many statements lets the host\'s messages through: an abort is heard between statements', async () => {
		const h = await host();
		// CPU-bound statements that never await anything: only the yield after each lets the host's message in
		const script = 'seq 1 4000 | sort -rn > /dev/null\n'.repeat(400) + 'echo never-reached\n';
		const id = 77;
		const t0 = Date.now();
		const running = h.core.handle({ t: 'run', id, script, cwd: '/w', env: {} });
		setTimeout(() => { void h.core.handle({ t: 'abort', id }); }, 60);
		await running;
		const done = h.messages.filter((m) => m.t === 'done' && m.id === id)[0];
		assert.strictEqual(done.how, 'aborted');
		assert.strictEqual(done.exitCode, 124);
		assert.ok(Date.now() - t0 < 4000, 'it stopped in ' + (Date.now() - t0) + ' ms');
		assert.ok(done.stats.durationMs >= 40, 'it did run for a while first');
		assert.ok(!h.messages.some((m) => m.t === 'out' && m.text.includes('never-reached')));
	});

	test('text is decoded: UTF-8 from a file, from printf escapes, and from the last statement\'s tail', async () => {
		const h = await host({ '/w/u.txt': 'café ✓\n' });
		const r = await h.run("cat u.txt; printf 'caf\\303\\251\\n'; { echo 'naïve'; exit 4; }");
		assert.strictEqual(r.stdout, 'café ✓\ncafé\nnaïve\n');
		assert.strictEqual(r.exitCode, 4);
		// all of it byte-shaped, and the script ends inside a group: what the hook did not show is the tail, found by
		// the raw length of what it did show, not the decoded one
		const r2 = await h.run("printf 'caf\\303\\251\\n'; { printf '\\303\\274\\n'; printf '\\303\\266\\n' >&2; exit 3; }");
		assert.deepStrictEqual([r2.stdout, r2.stderr, r2.exitCode], ['café\nü\n', 'ö\n', 3]);
		// stderr of a statement the hook did show
		const r3 = await h.run("printf '\\303\\266\\n' >&2; echo ok");
		assert.deepStrictEqual([r3.stdout, r3.stderr], ['ok\n', 'ö\n']);
		assert.strictEqual(decodeBytes('cafÃ©'), 'café');
		assert.strictEqual(decodeBytes('café'), 'café', 'one byte that is not UTF-8 stays one character');
		assert.strictEqual(decodeBytes('日本語'), '日本語');
		assert.strictEqual(decodeBytes(''), '');
	});

	test('an abort for another run id is not for this one', async () => {
		const h = await host();
		const running = h.core.handle({ t: 'run', id: 7, script: 'echo a; sleep 0.15; echo b', cwd: '/w', env: {} });
		await new Promise((r) => setTimeout(r, 40));
		await h.core.handle({ t: 'abort', id: 999 });
		await running;
		const done = h.messages.find((m) => m.t === 'done' && m.id === 7);
		assert.deepStrictEqual([done.how, done.exitCode], ['exit', 0]);
		assert.ok(h.messages.some((m) => m.t === 'out' && m.id === 7 && m.text === 'b\n'));
	});

	test('a second run while one is pending is refused without disturbing it', async () => {
		const h = await host({ '/w/a': 'x' });
		const first = h.core.handle({ t: 'run', id: 1, script: 'sleep 0.2; echo first', cwd: '/w', env: {} });
		await h.core.handle({ t: 'run', id: 2, script: 'echo second', cwd: '/w', env: {} });
		await first;
		const d1 = h.messages.find((m) => m.t === 'done' && m.id === 1);
		const d2 = h.messages.find((m) => m.t === 'done' && m.id === 2);
		assert.deepStrictEqual([d1.how, d1.exitCode], ['exit', 0]);
		assert.deepStrictEqual([d2.how, d2.exitCode], ['error', 1]);
		assert.ok(h.messages.some((m) => m.t === 'out' && m.id === 1 && m.text === 'first\n'));
		assert.ok(h.messages.some((m) => m.t === 'out' && m.id === 2 && /busy/.test(m.text)));
	});

	/* ---------------------------------------------------------------------------------------- reads */

	test('the engine only asks to read, with absolute paths inside a folder, and nothing after done', async () => {
		const h = await host({ '/w/a.txt': 'x\n', '/w/d/b.txt': 'y\n' });
		await h.run('ls; cat a.txt d/b.txt; grep -r y . ; find . -name "*.txt"; cd d && ls ..; test -f a.txt');
		assert.ok(h.reads.length > 0);
		assert.ok(h.reads.every((r) => ['stat', 'readFile', 'readDir'].includes(r.op)), JSON.stringify(h.reads.map((r) => r.op)));
		assert.ok(h.reads.every((r) => /^\/w(\/|$)/.test(r.path)), h.reads.map((r) => r.path).join(' '));
		const n = h.reads.length;
		await new Promise((r) => setTimeout(r, 20));
		assert.strictEqual(h.reads.length, n);
	});

	test('a host that refuses or fails a read: the script goes on with status 1, and the run\'s notes say what the engine\'s "No such file" line hides', async () => {
		const posts = [];
		const core = createCore({
			Engine: E,
			post: (m) => {
				posts.push(m);
				if (m.t !== 'fs') { return; }
				setImmediate(() => {
					if (m.op === 'stat' && m.path === '/w/locked') { core.handle({ t: 'fsr', rid: m.rid, ok: false, error: { code: 'EACCES', message: 'denied' } }); } else if (m.op === 'stat' && m.path === '/w/weird') { core.handle({ t: 'fsr', rid: m.rid, ok: false, error: { code: 'EWHATEVER', message: 'huh' } }); } else if (m.op === 'stat') { core.handle({ t: 'fsr', rid: m.rid, ok: false, error: { code: 'ENOENT', message: 'no' } }); } else { core.handle({ t: 'fsr', rid: m.rid, ok: true, value: [] }); }
				});
			},
		});
		await core.handle({ t: 'init', gen: 1, folders: [{ id: 'f', path: '/w', name: 'w' }] });
		await core.handle({ t: 'run', id: 1, script: 'cat locked; echo "rc=$?"; cat weird; echo "rc=$?"; cat missing; echo "rc=$?"; echo ok', cwd: '/w', env: {} });
		const out = posts.filter((m) => m.t === 'out').map((m) => m.text).join('');
		assert.strictEqual(out.split('rc=1').length - 1, 3);
		assert.ok(out.endsWith('ok\n'), out);
		const done = posts.filter((m) => m.t === 'done');
		assert.strictEqual(done.length, 1);
		assert.strictEqual(done[0].notes.length, 2, 'one for each that was not a plain "not there": ' + JSON.stringify(done[0].notes));
		assert.ok(/"\/w\/locked" could not be looked at: the editor answered EACCES \(denied\)/.test(done[0].notes[0]), done[0].notes[0]);
		assert.ok(/"\/w\/weird" could not be looked at: the editor answered EIO \(huh\)/.test(done[0].notes[1]), done[0].notes[1]);
	});

	/* ---------------------------------------------------------------------------------------- limits */

	test('the limits in force are the table, every key, as the engine itself reports them to a running command', async () => {
		/** @type {any} */
		let seen = null;
		class Spy extends E.Bash {
			constructor(o) {
				const dump = E.defineCommand('dumpctx', async (_a, ctx) => { seen = Object.assign({}, ctx.limits); return { stdout: '', stderr: '', exitCode: 0 }; });
				super(Object.assign({}, o, { customCommands: [...(o.customCommands || []), dump] }));
				/** @type {any} */ (globalThis).__spyOptions = o;
			}
		}
		const Engine = Object.assign({}, E, { Bash: Spy });
		const h = await makeHost({ Engine, tree: makeTree({ '/w': null }) });
		await h.run('dumpctx');
		assert.ok(seen, 'the command ran');
		assert.deepStrictEqual(Object.keys(seen).sort(), Object.keys(LIMITS).sort(), 'the engine has no limit that is not pinned, and none is pinned that the engine ignores');
		assert.deepStrictEqual(seen, Object.assign({}, LIMITS));
		// README.md §7, in its own words
		assert.deepStrictEqual([seen.maxCommandCount, seen.maxLoopIterations, seen.maxCallDepth], [100000, 100000, 100]);
		assert.deepStrictEqual([seen.maxOutputSize, seen.maxStringLength, seen.maxLiveBytes, seen.maxInputBytes], [8 * MiB, 16 * MiB, 64 * MiB, 32 * MiB]);
		assert.strictEqual(seen.maxExecutionTimeMs, 600000);
		const o = /** @type {any} */ (globalThis).__spyOptions;
		assert.strictEqual(o.executionLimitProfile, undefined, 'no profile name: the numbers are given');
		assert.strictEqual(o.network, undefined);
		assert.strictEqual(o.python, undefined);
		assert.strictEqual(o.javascript, undefined);
		assert.strictEqual(o.fetch, undefined);
		assert.strictEqual(o.defenseInDepth, false);
		assert.ok(Array.isArray(o.commands) && !o.commands.some((c) => EXCLUDED.has(c)), 'an explicit program list, without what is not offered');
		delete /** @type {any} */ (globalThis).__spyOptions;
	});

	test('init may tighten a known limit; an unknown key, a string and a zero are ignored', async () => {
		/** @type {any} */
		let seen = null;
		class Spy extends E.Bash {
			constructor(o) {
				super(Object.assign({}, o, { customCommands: [...(o.customCommands || []), E.defineCommand('dumpctx', async (_a, ctx) => { seen = Object.assign({}, ctx.limits); return { stdout: '', stderr: '', exitCode: 0 }; })] }));
			}
		}
		const h = await makeHost({ Engine: Object.assign({}, E, { Bash: Spy }), tree: makeTree({ '/w': null }), start: false });
		await h.core.handle({ t: 'init', gen: 1, folders: [{ id: 'f', path: '/w', name: 'w' }], limits: { maxCommandCount: 777, maxNoSuchThing: 5, maxLoopIterations: '9', maxCallDepth: 0 } });
		await h.run('dumpctx');
		assert.strictEqual(seen.maxCommandCount, 777);
		assert.strictEqual(seen.maxLoopIterations, LIMITS.maxLoopIterations);
		assert.strictEqual(seen.maxCallDepth, LIMITS.maxCallDepth);
		assert.ok(!('maxNoSuchThing' in seen));
	});

	test('a limit ends the run as 126 with a message that names it and gives no advice about options', async () => {
		/** @type {Array<[Record<string, number>, string, RegExp]>} */
		const cases = [
			[{ maxCommandCount: 50 }, 'while true; do :; done', /too many commands executed \(>50\)/],
			[{ maxLoopIterations: 20 }, 'while true; do :; done', /too many iterations \(20\)/],
			[{ maxCallDepth: 5 }, 'f() { f; }; f', /maximum recursion depth \(5\) exceeded/],
			[{ maxOutputSize: 1000 }, 'seq 1 2000', /output size/i],
			[{ maxStringLength: 100 }, 'x=$(seq 1 200); echo ${#x}', /size limit exceeded \(100 bytes\)/],
			[{}, 'seq 1 100001', /iteration limit exceeded \(100000\)/],
			[{}, "for i in 1 2 3 4 5 6 7 8 9 10; do head -c 1000000 /dev/zero | tr '\\0' x; done", /total output size exceeded \(>8388608 bytes\)/],
		];
		for (const [limits, script, re] of cases) {
			const h = await host({}, { start: false });
			await h.core.handle({ t: 'init', gen: 1, folders: [{ id: 'f', path: '/w', name: 'w' }], limits });
			const r = await h.run('echo started; echo staged > staged.txt; ' + script);
			assert.strictEqual(r.how, 'limit', script + ' -> ' + r.how + ' ' + r.stderr);
			assert.strictEqual(r.exitCode, 126, script);
			assert.ok(/(^|\n)bash: stopped by a limit of this shell: /.test(r.stderr), r.stderr);
			assert.ok(re.test(r.stderr), script + ': ' + r.stderr);
			assert.ok(!/executionLimits|increase|option/i.test(r.stderr), r.stderr);
			assert.ok(r.stdout.startsWith('started\n'), 'what ran before is shown');
			assert.deepStrictEqual(r.done.changes, [], 'a limit applies nothing');
			assert.ok(r.done.stats.discarded >= 1, 'and says how much it did not apply');
			assert.ok(r.done.notes.includes('None of its file changes were applied: it was stopped by a limit of this shell.'), JSON.stringify(r.done.notes));
		}
		// the wordings that make an exit 126 a limit: each of the engine's, and what must not be taken for one
		for (const line of ['bash: seq: iteration limit exceeded (100000)', 'bash: sed: command execution exceeded maximum iterations (100000)', 'bash: f: maximum recursion depth (100) exceeded', 'bash: tr: expanded SET exceeds string length limit (16777216)', 'bash: too many commands executed (>100000), increase executionLimits.maxCommandCount', 'bash: pipeline: total output size exceeded (>8388608 bytes), increase executionLimits.maxOutputSize']) {
			assert.ok(LIMIT_LINE.test(line), line);
		}
		for (const line of ['bash: foo: command not found', 'bash: ./x: Permission denied', 'bash: line 2: syntax error near unexpected token `)\'', 'bash: cd: too many arguments', 'bash: sleep: invalid time interval']) {
			assert.ok(!LIMIT_LINE.test(line), line);
		}
		assert.ok(DEADLINE_LINE.test('bash: sleep exceeded its execution deadline') && DEADLINE_LINE.test('bash: while exceeded execution deadline (250ms)'));
		assert.ok(!DEADLINE_LINE.test('bash: sed: command execution exceeded maximum iterations (5)'));
		assert.strictEqual(humaniseLimit('bash: too many commands executed (>10), increase executionLimits.maxCommandCount'), 'bash: stopped by a limit of this shell: too many commands executed (>10)');
		assert.strictEqual(humaniseLimit('bash: source: maximum nesting depth (100) exceeded, increase executionLimits.maxSourceDepth'), 'bash: stopped by a limit of this shell: source: maximum nesting depth (100) exceeded');
	});

	test('exit 126 that is not a limit stays an ordinary exit: a script that cannot be executed', async () => {
		const h = await host({ '/w/noexec': 'echo hi\n' });
		const r = await h.run('./noexec; echo "rc=$?"');
		assert.strictEqual(r.how, 'exit');
		assert.strictEqual(r.stdout, 'rc=126\n');
		assert.ok(/Permission denied/.test(r.stderr));
	});

	test('a deadline ends the run as 124, in time, with what had been printed, and applies nothing', async () => {
		const h = await host({}, { start: false });
		await h.core.handle({ t: 'init', gen: 1, folders: [{ id: 'f', path: '/w', name: 'w' }], limits: { maxExecutionTimeMs: 250 } });
		const t0 = Date.now();
		const r = await h.run('echo before; echo x > f.txt; sleep 5; echo after');
		assert.strictEqual(r.how, 'deadline');
		assert.strictEqual(r.exitCode, 124);
		assert.ok(Date.now() - t0 < 2500, 'took ' + (Date.now() - t0));
		assert.ok(r.stdout.startsWith('before\n') && !r.stdout.includes('after'));
		assert.strictEqual(r.stderr, 'bash: stopped: the command ran for longer than this shell allows\n');
		assert.deepStrictEqual(r.done.changes, []);
		assert.strictEqual(r.done.stats.discarded, 1);
		assert.deepStrictEqual(r.done.notes, ['None of its file changes were applied: it ran for longer than this shell allows.']);
		const timeout = await h.run('timeout 0.1 sleep 3; echo "rc=$?"');
		assert.strictEqual(timeout.how, 'exit', 'a command that was timed out by `timeout` is an ordinary 124');
		assert.strictEqual(timeout.stdout, 'rc=124\n');
	});

	test('an abort from the host ends the run as aborted, 124, nothing applied, what was printed kept', async () => {
		const h = await host();
		const id = 5;
		const running = h.core.handle({ t: 'run', id, script: 'echo first; echo w > w.txt; sleep 5; echo second', cwd: '/w', env: {} });
		await new Promise((r) => setTimeout(r, 100));
		await h.core.handle({ t: 'abort', id });
		await running;
		const done = h.messages.find((m) => m.t === 'done' && m.id === id);
		assert.deepStrictEqual([done.how, done.exitCode, done.changes.length], ['aborted', 124, 0]);
		assert.deepStrictEqual(done.notes, ['None of its file changes were applied: it was stopped.']);
		assert.ok(h.messages.some((m) => m.t === 'out' && m.id === id && m.stream === 'stderr' && m.text === 'bash: stopped\n'), 'the engine\'s "execution aborted" is the shell\'s own words');
		assert.ok(h.messages.some((m) => m.t === 'out' && m.id === id && m.text === 'first\n'));
		assert.ok(!h.messages.some((m) => m.t === 'out' && m.text.includes('second')));
		const r = await h.run('echo again');
		assert.strictEqual(r.stdout, 'again\n', 'the next run is clean');
	});

	/* ---------------------------------------------------------------------------------------- contract with a stand-in engine */

	/** an engine that does what a test tells it to: `exec` is the script's whole run */
	const standIn = (exec) => ({
		getCommandNames: () => ['echo'],
		defineCommand: (name, fn) => ({ name, fn }),
		Bash: class { async exec(script, opts) { return exec(script, opts); } },
	});

	test('nothing is sent after done: a statement hook that fires late is ignored', async () => {
		/** @type {any} */
		let hook = null;
		const posts = [];
		const core = createCore({
			Engine: standIn(async (_s, opts) => { hook = opts.onStatement; return { stdout: 'x', stderr: '', exitCode: 0, env: {} }; }),
			post: (m) => { posts.push(m); if (m.t === 'fs') { setImmediate(() => core.handle({ t: 'fsr', rid: m.rid, ok: true, value: { type: 'dir', size: 0, mtime: 1 } })); } },
		});
		await core.handle({ t: 'init', gen: 1, folders: [{ id: 'f', path: '/w', name: 'w' }] });
		await core.handle({ t: 'run', id: 1, script: 'echo x', cwd: '/w', env: {} });
		await hook({ stdout: 'late', stderr: '', exitCode: 0 });
		const last = posts[posts.length - 1];
		assert.strictEqual(last.t, 'done');
		assert.strictEqual(posts.filter((m) => m.t === 'done').length, 1);
		assert.ok(!posts.some((m) => m.t === 'out' && m.text === 'late'));
	});

	test('a result the host cannot take is answered with a smaller one, exactly once', async () => {
		const posts = [];
		let first = true;
		const core = createCore({
			Engine: standIn(async () => ({ stdout: 'x\n', stderr: '', exitCode: 0, env: {} })),
			post: (m) => {
				if (m.t === 'done' && first) { first = false; throw Object.assign(new Error('Failed to execute postMessage: ArrayBuffer at index 0 is already detached.'), { name: 'DataCloneError' }); }
				posts.push(m);
				if (m.t === 'fs') { setImmediate(() => core.handle({ t: 'fsr', rid: m.rid, ok: true, value: { type: 'dir', size: 0, mtime: 1 } })); }
			},
		});
		await core.handle({ t: 'init', gen: 1, folders: [{ id: 'f', path: '/w', name: 'w' }] });
		await core.handle({ t: 'run', id: 1, script: 'echo x', cwd: '/w', env: {} });
		const dones = posts.filter((m) => m.t === 'done');
		assert.strictEqual(dones.length, 1);
		assert.deepStrictEqual([dones[0].how, dones[0].exitCode, dones[0].changes], ['error', 1, []]);
		assert.strictEqual(dones[0].notes[0], 'The result of this command could not be sent (Failed to execute postMessage: ArrayBuffer at index 0 is already detached.). Nothing was changed.');
	});

	/* ---------------------------------------------------------------------------------------- never rejects */

	test('whatever the engine throws, the run answers once, with a line of the shell\'s, and no stack', async () => {
		const throwing = (make) => {
			class Boom extends E.Bash { async exec() { throw make(); } }
			return Object.assign({}, E, { Bash: Boom });
		};
		const cases = [
			[() => Object.assign(new RangeError('Maximum call stack size exceeded'), { stack: 'RangeError: Maximum call stack size exceeded\n    at t.exec (file:///x/y.js:1:2)' }), 'bash: the command is nested too deeply to run\n'],
			[() => new RangeError('Invalid array length'), 'bash: a value became too large to hold\n'],
			[() => new Error('first line\n    at evil (file:///secret/path.js:9:9)\nsecond'), 'bash: first line\n'],
			[() => 'a thrown string', 'bash: a thrown string\n'],
			[() => undefined, 'bash: internal error\n'],
			[() => new Error('x'.repeat(1000)), 'bash: ' + 'x'.repeat(200) + '\n'],
		];
		for (const [make, line] of cases) {
			const h = await makeHost({ Engine: throwing(make), tree: makeTree({ '/w': null }) });
			const r = await h.run('echo hi');
			assert.strictEqual(r.how, 'error');
			assert.strictEqual(r.exitCode, 1);
			assert.strictEqual(r.stderr, line);
			assert.ok(!/\n\s+at \S+ \(|file:\/\/|\.js:\d/.test(r.stderr), 'no stack');
			assert.deepStrictEqual(r.done.changes, []);
			assert.strictEqual(h.messages.filter((m) => m.t === 'done').length, 1);
		}
		assert.strictEqual(describeException(new Error('Array buffer allocation failed')), 'bash: a value became too large to hold');
	});

	test('an engine that fails to start is answered with a ready that says so; a read it starts after its run is never sent', async () => {
		const broken = Object.assign({}, E, { getCommandNames() { throw new Error('the registry is gone'); } });
		const posts = [];
		const core = createCore({ Engine: broken, post: (m) => posts.push(m) });
		await core.handle({ t: 'init', gen: 4, folders: [{ id: 'f', path: '/w', name: 'w' }] });
		assert.deepStrictEqual(posts, [{ t: 'ready', gen: 4, commands: [], mounts: [], error: 'the registry is gone' }]);
		await core.handle({ t: 'run', id: 1, script: 'echo hi', cwd: '/w', env: {} });
		assert.strictEqual(posts[posts.length - 1].how, 'error');
		// a promise the engine leaves behind: it calls the file system once its run is over
		class Lingering extends E.Bash {
			async exec() {
				setTimeout(() => { void this.fs.stat('/w/late').catch(() => { /* never answered */ }); }, 10);
				return { stdout: 'x\n', stderr: '', exitCode: 0, env: {} };
			}
		}
		const h = await makeHost({ Engine: Object.assign({}, E, { Bash: Lingering }), tree: makeTree({ '/w': null }) });
		await h.run('anything');
		const before = h.messages.filter((m) => m.t === 'fs').length;
		await new Promise((r) => setTimeout(r, 60));
		assert.strictEqual(h.messages.filter((m) => m.t === 'fs').length, before, 'no read after done');
	});

	test('a run message that is wrong in any field still ends in one done', async () => {
		const h = await host();
		const bad = [
			{ t: 'run', id: 1 },
			{ t: 'run', id: 2, script: 42, cwd: 7, env: 'x', stdin: {}, caps: 'big' },
			{ t: 'run', id: 3, script: 'echo ok', cwd: '/definitely/not/here', env: { A: 1, B: null, C: 'c' }, caps: { readFile: NaN, writeFile: -1 } },
			{ t: 'run', id: 4, script: '', cwd: '/w', env: {} },
			{ t: 'run', id: 5, script: 'echo \'unterminated', cwd: '/w', env: {} },
			{ t: 'run', id: 6, script: 'echo $(', cwd: '/w', env: {} },
			{ t: 'run', id: 7, script: '))) ;; fi done', cwd: '/w', env: {} },
		];
		for (const m of bad) {
			await h.core.handle(/** @type {any} */ (m));
			assert.strictEqual(h.messages.filter((x) => x.t === 'done' && x.id === m.id).length, 1, JSON.stringify(m));
		}
		const d3 = h.messages.find((m) => m.t === 'done' && m.id === 3);
		assert.strictEqual(d3.exitCode, 0);
		assert.ok(d3.notes.some((n) => /does not exist; the command started in \/w/.test(n)), JSON.stringify(d3.notes));
		for (const id of [5, 6, 7]) {
			const d = h.messages.find((m) => m.t === 'done' && m.id === id);
			assert.ok(d.exitCode !== 0 || d.how !== 'exit', 'a syntax error is a failure: ' + id);
			assert.ok(!/\n\s+at \S+ \(|file:\/\//.test(h.messages.filter((m) => m.t === 'out' && m.id === id).map((m) => m.text).join('')), 'no stack');
		}
	});

	test('a late answer to a read of a finished run is ignored, and ids are never reused', async () => {
		const h = await host({ '/w/a': 'x' });
		await h.run('cat a');
		const rids = h.messages.filter((m) => m.t === 'fs').map((m) => m.rid);
		await h.core.handle({ t: 'fsr', rid: rids[0], ok: true, value: new TextEncoder().encode('POISON') });
		const before = h.messages.length;
		await h.core.handle({ t: 'fsr', rid: rids[rids.length - 1], ok: false, error: { code: 'EIO', message: 'late' } });
		assert.strictEqual(h.messages.length, before, 'nothing happened');
		const r = await h.run('cat a; echo done');
		assert.strictEqual(r.stdout, 'x' + 'done\n'.replace(/^/, ''));
		const all = h.messages.filter((m) => m.t === 'fs').map((m) => m.rid);
		assert.strictEqual(new Set(all).size, all.length, 'every read has its own id');
		assert.ok(all.slice(rids.length).every((rid) => rid > rids[rids.length - 1]));
	});

	/* ---------------------------------------------------------------------------------------- cwd, env, session state */

	test('the environment a script starts with is README §3\'s, under what the host gives, and PWD is the cwd', async () => {
		const h = await host({ '/w/sub': null });
		const r = await h.run('env | sort | grep -E "^(HOME|PATH|PWD|TERM|CI|NO_COLOR|LANG|FOO)="', { cwd: '/w/sub', env: { FOO: 'bar', TERM: 'xterm' } });
		assert.strictEqual(r.stdout, 'CI=1\nFOO=bar\nHOME=/home/user\nLANG=C.UTF-8\nNO_COLOR=1\nPATH=/usr/bin:/bin\nPWD=/w/sub\nTERM=xterm\n');
		assert.deepStrictEqual(DEFAULT_ENV, { HOME: '/home/user', PATH: '/usr/bin:/bin', TERM: 'dumb', CI: '1', NO_COLOR: '1', LANG: 'C.UTF-8' });
	});

	test('cwd and env come back for the next line: cd, export, OLDPWD; and not the exit status, not the option variables', async () => {
		const h = await host({ '/w/sub/deep': null });
		const r1 = await h.run('cd sub/deep; export KEEP=1; LOCAL=2; false', { cwd: '/w' });
		assert.strictEqual(r1.done.cwd, '/w/sub/deep');
		assert.strictEqual(r1.done.env.KEEP, '1');
		assert.strictEqual(r1.done.env.PWD, '/w/sub/deep');
		assert.strictEqual(r1.done.env.OLDPWD, '/w');
		assert.ok(!('?' in r1.done.env) && !('SHELLOPTS' in r1.done.env) && !('BASHOPTS' in r1.done.env));
		assert.ok(Object.values(r1.done.env).every((v) => typeof v === 'string'));
		const r2 = await h.run('pwd; echo "$KEEP"; cd -; pwd', { cwd: r1.done.cwd, env: r1.done.env });
		assert.strictEqual(r2.stdout, '/w/sub/deep\n1\n/w\n/w\n');
		assert.strictEqual(r2.done.cwd, '/w');
	});

	test('aliases come back as variables and work on the next line when the run asks for expand_aliases', async () => {
		const h = await host();
		const r1 = await h.run("alias hi='echo hello'");
		const r2 = await h.run('hi there', { env: r1.done.env, expandAliases: true });
		assert.strictEqual(r2.stdout, 'hello there\n');
		const r3 = await h.run('hi there', { env: r1.done.env });
		assert.strictEqual(r3.exitCode, 127);
		assert.ok(/hi: command not found/.test(r3.stderr));
		assert.strictEqual((await h.run("#!/bin/sh\necho line two", { expandAliases: true })).stdout, 'line two\n', 'a comment line first is still a comment');
	});

	test('stdin is the script\'s standard input', async () => {
		const h = await host();
		assert.strictEqual((await h.run('wc -l', { stdin: 'a\nb\nc\n' })).stdout, '3\n');
		assert.strictEqual((await h.run('cat', { stdin: '' })).stdout, '');
	});

	test('/tmp is cleared per run unless the session asks to keep it; /home/user the same', async () => {
		const h = await host();
		await h.run('echo kept > /tmp/f; echo h > /home/user/f', { keepTmp: true });
		assert.strictEqual((await h.run('cat /tmp/f /home/user/f', { keepTmp: true })).stdout, 'kept\nh\n');
		const r = await h.run('cat /tmp/f 2>&1; echo "rc=$?"');
		assert.ok(/No such file/.test(r.stdout), r.stdout);
		assert.strictEqual((await h.run('ls /tmp | wc -l', { keepTmp: true })).stdout, '0\n');
	});

	test('where a line starts: a file or a missing folder is not a working directory (the first folder is, and the note says so)', async () => {
		const h = await host({ '/w/a.txt': 'x\n' });
		const file = await h.run('pwd', { cwd: '/w/a.txt' });
		assert.strictEqual(file.stdout, '/w\n');
		assert.ok(file.done.notes.some((n) => /working directory \/w\/a\.txt does not exist; the command started in \/w/.test(n)), JSON.stringify(file.done.notes));
		const missing = await h.run('pwd', { cwd: '/w/nope' });
		assert.strictEqual(missing.stdout, '/w\n');
		assert.strictEqual(missing.done.cwd, '/w');
	});

	test('the previous directory of an earlier line, a path the host knows, is the same folder under /mnt (cd - works)', async () => {
		const tree = makeTree({ '/tmp': null, '/tmp/src/a': 'x\n' });
		const h = await makeHost({ Engine: E, tree, folders: [{ id: 'f', path: '/tmp', name: 'tmp' }] });
		const r = await h.run('cd -; pwd', { cwd: '/tmp', env: { OLDPWD: '/tmp/src' } });
		assert.strictEqual(r.stdout, '/mnt/tmp/src\n/mnt/tmp/src\n', '`cd -` prints the directory it goes to');
		assert.strictEqual(r.done.cwd, '/tmp/src');
		assert.strictEqual(r.done.env.OLDPWD, '/tmp');
	});

	test('a folder that had to be relocated is seen under /mnt and comes back under its own path', async () => {
		const tree = makeTree({ '/tmp': null, '/tmp/a.txt': 'in the folder\n' });
		const h = await makeHost({ Engine: E, tree, folders: [{ id: 'f', path: '/tmp', name: 'tmp' }] });
		const r = await h.run('pwd; cat a.txt; echo n > new.txt; echo x > /tmp/scratch; ls /tmp', { cwd: '/tmp' });
		assert.strictEqual(r.stdout, '/mnt/tmp\nin the folder\nscratch\n');
		assert.deepStrictEqual(kinds(r), ['write:/tmp/new.txt']);
		assert.strictEqual(r.done.cwd, '/tmp');
		assert.ok(r.done.notes.some((n) => /"tmp" is mounted at \/mnt\/tmp, not at \/tmp/.test(n)), JSON.stringify(r.done.notes));
		assert.ok(h.reads.every((x) => x.path === '/tmp' || x.path.startsWith('/tmp/')), 'the host is asked by its own paths');
		const cd = await h.run('cd /mnt/tmp; pwd', { cwd: '/tmp' });
		assert.strictEqual(cd.done.cwd, '/tmp');
	});

	/* ---------------------------------------------------------------------------------------- what is applied */

	test('a run that ends by itself hands over the net change set; one with a refused write hands over nothing and says so', async () => {
		const h = await host({ '/w/a.txt': 'old\n', '/w/d/x': '1\n' }, { start: false });
		await h.core.handle({ t: 'init', gen: 1, folders: [{ id: 'f', path: '/w', name: 'w' }] });
		const ok = await h.run('echo new > a.txt; rm -r d; mkdir e; echo y > e/f; echo same > /w/z; rm /w/z', { apply: false });
		assert.deepStrictEqual(kinds(ok), ['mkdir:/w/e', 'write:/w/a.txt', 'write:/w/e/f', 'delete:/w/d/x', 'rmdir:/w/d']);
		assert.strictEqual(ok.done.changes.find((c) => c.path === '/w/d/x').viaDir, '/w/d');
		// a content write that no cap allows: nothing is applied, the exit status is not 0, the model is told
		const h2 = await host({}, { start: false });
		await h2.core.handle({ t: 'init', gen: 1, folders: [{ id: 'f', path: '/w', name: 'w' }] });
		const big = await h2.run('echo fine > small.txt; seq 1 5000 > big.txt; echo after', { caps: { writeFile: 1000 } });
		assert.strictEqual(big.how, 'exit');
		assert.strictEqual(big.exitCode, 1);
		assert.deepStrictEqual(big.done.changes, []);
		assert.strictEqual(big.done.denied.length, 1);
		assert.deepStrictEqual([big.done.denied[0].path, big.done.denied[0].reason], ['/w/big.txt', 'cap-file']);
		assert.ok(big.stdout.endsWith('after\n'));
		assert.ok(/^bash: \/w\/big\.txt: not written: it would be .+, over the 1000 bytes/m.test(big.stderr), big.stderr);
		assert.ok(big.done.notes.some((n) => /None of its file changes were applied/.test(n)));
		assert.strictEqual(big.done.stats.withheld, 'denied');
		assert.strictEqual(big.done.stats.discarded, 2, 'small.txt, and big.txt as the empty file its opening made: not applied');
		// a change set that cannot be represented (a folder that becomes a file): nothing is applied, and the status says so
		const h3 = await host({ '/w/d/x': '1\n' }, { start: false });
		await h3.core.handle({ t: 'init', gen: 1, folders: [{ id: 'f', path: '/w', name: 'w' }] });
		const swap = await h3.run('echo y > keep.txt; rm -r d; echo z > d; echo end', { apply: false });
		assert.deepStrictEqual([swap.how, swap.exitCode, swap.stdout, swap.done.changes.length, swap.done.stats.withheld], ['exit', 1, 'end\n', 0, 'incomplete']);
		assert.deepStrictEqual(swap.done.notes, ['None of its file changes were applied: /w/d is a folder and would become a file: remove the folder in one command and write the file in the next.']);
		assert.deepStrictEqual(swap.done.denied, []);
	});

	test('the buffers of a change set are handed over, each once, whole', async () => {
		const posts = [];
		const core = createCore({
			Engine: E,
			post: (m, transfer) => {
				posts.push([m, transfer]);
				if (m.t !== 'fs') { return; }
				setImmediate(() => {
					if (m.op === 'readDir') { core.handle({ t: 'fsr', rid: m.rid, ok: true, value: [] }); } else if (m.path === '/w') { core.handle({ t: 'fsr', rid: m.rid, ok: true, value: { type: 'dir', size: 0, mtime: 1 } }); } else { core.handle({ t: 'fsr', rid: m.rid, ok: false, error: { code: 'ENOENT', message: 'no' } }); }
				});
			},
		});
		await core.handle({ t: 'init', gen: 1, folders: [{ id: 'f', path: '/w', name: 'w' }] });
		await core.handle({ t: 'run', id: 1, script: 'echo abc > a; echo def > b; printf "%s" "$(seq 1 5000)" > c', cwd: '/w', env: {} });
		const [done, transfer] = posts.filter(([m]) => m.t === 'done')[0];
		assert.strictEqual(done.changes.length, 3);
		assert.ok(Array.isArray(transfer) && transfer.length === 3 && transfer.every((b) => b instanceof ArrayBuffer));
		assert.strictEqual(new Set(transfer).size, 3);
		for (const c of done.changes) { assert.ok(transfer.includes(c.after.buffer)); assert.strictEqual(c.after.byteOffset, 0); assert.strictEqual(c.after.byteLength, c.after.buffer.byteLength); }
	});

	test('a buffer two changes share is handed over once, and a view into a larger buffer as its own bytes', async () => {
		const pool = new Uint8Array(64);
		pool.set(new TextEncoder().encode('POOLED-BYTES'), 10);
		const view = pool.subarray(10, 22);
		const shared = new TextEncoder().encode('shared\n');
		const size = { '/w/p': 12, '/w/q': 7, '/w/r': 7 };
		const posts = [];
		const core = createCore({
			Engine: E,
			post: (m, transfer) => {
				posts.push([m, transfer]);
				if (m.t !== 'fs') { return; }
				setImmediate(() => {
					const ok = (value) => core.handle({ t: 'fsr', rid: m.rid, ok: true, value });
					if (m.op === 'readDir') { ok([['p', 'file'], ['q', 'file'], ['r', 'file']]); } else if (m.path === '/w') { ok({ type: 'dir', size: 0, mtime: 1 }); } else if (!(m.path in size)) { core.handle({ t: 'fsr', rid: m.rid, ok: false, error: { code: 'ENOENT', message: 'no' } }); } else if (m.op === 'stat') { ok({ type: 'file', size: size[m.path], mtime: 1 }); } else { ok(m.path === '/w/p' ? view : shared); }
				});
			},
		});
		await core.handle({ t: 'init', gen: 1, folders: [{ id: 'f', path: '/w', name: 'w' }] });
		await core.handle({ t: 'run', id: 1, script: 'echo x >> p; echo y >> q; echo z >> r', cwd: '/w', env: {} });
		const [done, transfer] = posts.filter(([m]) => m.t === 'done')[0];
		assert.strictEqual(done.how, 'exit');
		assert.deepStrictEqual(done.changes.map((c) => [c.path, new TextDecoder().decode(c.before), new TextDecoder().decode(c.after)]), [['/w/p', 'POOLED-BYTES', 'POOLED-BYTESx\n'], ['/w/q', 'shared\n', 'shared\ny\n'], ['/w/r', 'shared\n', 'shared\nz\n']]);
		assert.strictEqual(new Set(transfer).size, transfer.length, 'no buffer twice: a second transfer of one is an error in a real postMessage');
		assert.ok(!transfer.includes(pool.buffer), 'the pool the view lives in stays where it is');
		for (const c of done.changes) {
			for (const b of [c.before, c.after]) { assert.ok(transfer.includes(b.buffer)); assert.strictEqual(b.byteOffset, 0); assert.strictEqual(b.byteLength, b.buffer.byteLength); }
		}
	});

	test('a run that only reads has nothing to apply and nothing discarded', async () => {
		const h = await host({ '/w/a.txt': 'hello\n' });
		const r = await h.run('cat a.txt | wc -c; ls > /dev/null; echo x > /tmp/scratch; cat /tmp/scratch');
		assert.deepStrictEqual([r.done.changes, r.done.denied, r.done.notes, r.done.stats.discarded], [[], [], [], 0]);
		assert.strictEqual(r.stdout, '6\nx\n');
	});

	test('a refused read is explained in notes: the file exists, the engine\'s "no such file" is wrong', async () => {
		const h = await host({ '/w/big.bin': new Uint8Array(3000), '/w/ok': 'fine\n' });
		const r = await h.run('cat big.bin | wc -c; cat ok', { caps: { readFile: 1000 } });
		assert.ok(/big\.bin: No such file or directory/.test(r.stderr), 'the engine\'s own (wrong) line');
		assert.ok(r.done.notes.some((n) => /"\/w\/big\.bin" was NOT read: it is 2\.9 KiB, over the 1000 bytes this shell reads from one file/.test(n) && /the file exists/.test(n)), JSON.stringify(r.done.notes));
		assert.strictEqual(r.stdout, '0\nfine\n');
	});

	/* ---------------------------------------------------------------------------------------- round 2: what was found missing */

	test('a second init that fails leaves the engine un-started: a run is answered "has not been started", not run with the old list', async () => {
		let broken = false;
		class Flaky extends E.Bash {}
		const Engine = Object.assign({}, E, { Bash: Flaky, getCommandNames() { if (broken) { throw new Error('the registry is gone'); } return E.getCommandNames(); } });
		const h = await makeHost({ Engine, tree: makeTree({ '/w': null }) });
		assert.strictEqual((await h.run('echo hi')).stdout, 'hi\n');
		broken = true;
		await h.core.handle({ t: 'init', gen: 2, folders: [{ id: 'f', path: '/w', name: 'w' }] });
		const ready = h.messages.filter((m) => m.t === 'ready');
		assert.deepStrictEqual([ready[1].gen, ready[1].commands, ready[1].error], [2, [], 'the registry is gone']);
		const r = await h.run('echo hi');
		assert.deepStrictEqual([r.how, r.exitCode, r.stderr], ['error', 1, 'bash: the shell has not been started\n']);
		assert.deepStrictEqual(h.core.commands, [...h.core.commands]);
		broken = false;
		await h.core.handle({ t: 'init', gen: 3, folders: [{ id: 'f', path: '/w', name: 'w' }] });
		assert.strictEqual((await h.run('echo again')).stdout, 'again\n', 'a good init starts it again');
	});

	test('how a run ended is decided by status AND words: 124 and the deadline text, 126 and a limit line that starts with "bash: "', async () => {
		const h = await host();
		// the words of the engine, printed by a script that ends inside a group (what the statement hook has not seen is
		// the tail, and only the tail is classified); the status has to agree
		const a = await h.run("{ echo 'bash: sleep exceeded its execution deadline' >&2; exit 3; }");
		assert.deepStrictEqual([a.how, a.exitCode], ['exit', 3]);
		const b = await h.run("{ echo 'bash: sleep exceeded its execution deadline' >&2; exit 124; }");
		assert.deepStrictEqual([b.how, b.exitCode], ['deadline', 124], 'the engine\'s own words and 124 are a deadline');
		assert.strictEqual(b.stderr, 'bash: stopped: the command ran for longer than this shell allows\n');
		const c = await h.run("{ echo 'seq: iteration limit exceeded (3)' >&2; exit 126; }");
		assert.deepStrictEqual([c.how, c.exitCode], ['exit', 126], 'no \"bash: \" in front: not a line of the engine');
		const d = await h.run("{ echo 'bash: seq: iteration limit exceeded (3), increase executionLimits.maxLoopIterations' >&2; exit 126; }");
		assert.deepStrictEqual([d.how, d.exitCode], ['limit', 126]);
		assert.strictEqual(d.stderr, 'bash: stopped by a limit of this shell: seq: iteration limit exceeded (3)\n');
		const e = await h.run("{ echo 'bash: seq: iteration limit exceeded (3)' >&2; exit 125; }");
		assert.deepStrictEqual([e.how, e.exitCode], ['exit', 125], 'the status decides too');
		const f = await h.run("{ echo 'bash: execution aborted' >&2; exit 124; }");
		assert.deepStrictEqual([f.how, f.exitCode], ['exit', 124], 'an abort is a message from the host, not the script\'s words');
		assert.strictEqual(f.stderr, 'bash: execution aborted\n', 'and it is not reworded');
	});

	test('a script that leaves through exit still has /dev/stdout, /dev/stderr and its refused writes shown', async () => {
		const h = await host({}, { start: false });
		await h.core.handle({ t: 'init', gen: 1, folders: [{ id: 'f', path: '/w', name: 'w' }] });
		// tee writes the path /dev/stdout through the file system (a redirection to it is the engine's own): a device the
		// overlay collects, and the group that exits is a statement the hook never sees finish
		const r = await h.run("{ echo to-stdout | tee /dev/stdout > /dev/null; echo to-stderr | tee /dev/stderr > /dev/null; seq 1 5000 > big.txt; exit 3; }", { caps: { writeFile: 1000 } });
		assert.deepStrictEqual([r.how, r.exitCode], ['exit', 3]);
		assert.strictEqual(r.stdout, 'to-stdout\n');
		assert.ok(r.stderr.includes('to-stderr\n'), r.stderr);
		assert.ok(/bash: \/w\/big\.txt: not written: it would be .+, over the 1000 bytes/.test(r.stderr), r.stderr);
		assert.strictEqual(r.done.stats.withheld, 'denied');
		assert.deepStrictEqual(r.done.changes, []);
		// at the end of a script that does not exit, the same
		const s = await h.run("echo a | tee /dev/stdout > /dev/null; seq 1 5000 > big2.txt", { caps: { writeFile: 1000 } });
		assert.strictEqual(s.stdout, 'a\n');
		assert.ok(/not written/.test(s.stderr));
	});

	test('the limits table has exactly these numbers (the ones README §7 does not name included)', () => {
		const KiB = 1024;
		assert.deepStrictEqual(Object.assign({}, LIMITS), {
			maxCommandCount: 100000, maxLoopIterations: 100000, maxCallDepth: 100,
			maxOutputSize: 8 * MiB, maxStringLength: 16 * MiB, maxLiveBytes: 64 * MiB, maxInputBytes: 32 * MiB, maxExecutionTimeMs: 600000,
			maxAwkIterations: 100000, maxSedIterations: 100000, maxJqIterations: 1000000, maxWorkUnits: 100000000,
			maxSourceBytes: 8 * MiB, maxExecDepth: 64, maxSubstitutionDepth: 50, maxSourceDepth: 100, maxHeredocSize: 16 * MiB, maxArrayElements: 100000, maxBraceExpansionResults: 100000, maxFileDescriptors: 1024,
			maxTraversalEntries: 100000, maxTraversalDepth: 256, maxTraversalWork: 100000, maxGlobOperations: 100000,
			maxQueryTokens: 25000, maxQueryDepth: 256, maxQueryElements: 100000, maxAwkParserTokens: 25000, maxAwkParserDepth: 128, maxAwkParserOperations: 100000, maxCsvRows: 100000, maxCsvCells: 1000000,
			maxFileSystemBytes: 128 * MiB, maxDatabaseBytes: 64 * MiB, maxDatabaseResultBytes: 16 * MiB, maxArchiveBytes: 128 * MiB, maxArchiveCompressedBytes: 64 * MiB, maxArchiveEntryBytes: 64 * MiB, maxArchiveEntries: 100000,
			maxWorkerMessageBytes: 16 * MiB, maxSqliteTimeoutMs: 5000, maxPythonTimeoutMs: 10000, maxJsTimeoutMs: 10000, maxJsBridgeRequests: 100000, maxExtensionCleanupTimeMs: 100,
		});
		assert.strictEqual(Object.keys(LIMITS).length, 45);
		assert.ok(Object.isFrozen(LIMITS));
		void KiB;
	});

	test('caps in a run message that are not numbers above zero are the defaults: a typo in the host does not remove a limit', async () => {
		const h = await host();
		// 1 MiB + 1 to one file: over the default cap whatever the host wrote
		for (const caps of [{ writeFile: undefined }, { writeFile: NaN }, { writeFile: '1000000000' }, { writeFile: 0 }, { writeFile: -1 }, 'unlimited', null]) {
			const r = await h.run('{ head -c 1048576 /dev/zero; head -c 1 /dev/zero; } | tr "\\0" x > big.bin; echo end', { caps: /** @type {any} */ (caps) });
			assert.strictEqual(r.stdout, 'end\n', JSON.stringify(caps));
			assert.strictEqual(r.done.denied.length, 1, JSON.stringify(caps));
			assert.strictEqual(r.done.denied[0].reason, 'cap-file');
			assert.deepStrictEqual(r.done.changes, []);
		}
		const ok = await h.run('head -c 100 /dev/zero | tr "\\0" x > small.bin', { caps: { writeFile: 100 } });
		assert.strictEqual(ok.done.denied.length, 0);
		const tight = await h.run('head -c 101 /dev/zero | tr "\\0" x > small.bin', { caps: { writeFile: 100 } });
		assert.strictEqual(tight.done.denied.length, 1);
	});

	test('init.commands narrows compat.js too: a wrapper is there only with its program, an added program only when named', async () => {
		const h = await host({ '/w/a.txt': 'hello\n' }, { start: false });
		await h.core.handle({ t: 'init', gen: 1, folders: [{ id: 'f', path: '/w', name: 'w' }], commands: ['echo', 'cat', 'cmp', 'sort'] });
		const ready = h.messages.find((m) => m.t === 'ready');
		assert.deepStrictEqual(ready.commands, ['cat', 'cmp', 'echo', 'sort']);
		const r = await h.run('grep hello a.txt; echo "rc=$?"; id; echo "rc=$?"; cat a.txt; cmp a.txt a.txt; echo "rc=$?"');
		assert.ok(/grep: command not found/.test(r.stderr) && /id: command not found/.test(r.stderr), r.stderr);
		assert.ok(!/internal error/.test(r.stderr), 'no wrapper without its program');
		assert.strictEqual(r.stdout, 'rc=127\nrc=127\nhello\nrc=0\n');
		const all = await host({}, {});
		const names = all.messages.find((m) => m.t === 'ready').commands;
		for (const n of ['grep', 'id', 'cmp', 'od', 'realpath', 'du', 'sort']) { assert.ok(names.includes(n), n); }
		// a program named but not in the engine is not made up
		const h2 = await host({}, { start: false });
		await h2.core.handle({ t: 'init', gen: 1, folders: [{ id: 'f', path: '/w', name: 'w' }], commands: ['grep', 'nonexistent'] });
		assert.deepStrictEqual(h2.messages.find((m) => m.t === 'ready').commands, ['grep']);
	});

	test('a session that keeps /tmp is told how many files it holds, and one that does not says none', async () => {
		const h = await host();
		const a = await h.run('echo 1 > /tmp/a; echo 2 > /tmp/b; mkdir /tmp/d; echo 3 > /tmp/d/c; echo 4 > /home/user/h', { keepTmp: true });
		assert.deepStrictEqual([a.done.stats.tmpFiles, a.done.stats.homeFiles], [3, 1]);
		const b = await h.run('rm /tmp/a; echo 5 > /tmp/e', { keepTmp: true });
		assert.deepStrictEqual([b.done.stats.tmpFiles, b.done.stats.homeFiles], [3, 1]);
		const c = await h.run('echo 1 > /tmp/a');
		assert.deepStrictEqual([c.done.stats.tmpFiles, c.done.stats.homeFiles], [0, 0], 'nothing is kept: nothing to lose');
	});

	test('the same session is told how many files AND folders it holds (tmpEntries, homeEntries): a /tmp that holds only empty folders is lost as well', async () => {
		const h = await host();
		const a = await h.run('echo 1 > /tmp/a; mkdir -p /tmp/d/e; echo 3 > /tmp/d/e/c; mkdir /tmp/empty; mkdir -p /home/user/x/y', { keepTmp: true });
		const s = a.done.stats;
		assert.deepStrictEqual([s.tmpFiles, s.tmpEntries, s.homeFiles, s.homeEntries], [2, 5, 0, 2], 'a, d, d/e, d/e/c, empty; x, x/y');
		const b = await h.run('rm -r /tmp/d /tmp/a; rmdir /home/user/x/y /home/user/x', { keepTmp: true });
		assert.deepStrictEqual([b.done.stats.tmpFiles, b.done.stats.tmpEntries, b.done.stats.homeEntries], [0, 1, 0], 'only the empty folder is left, and it is something to lose');
		const c = await h.run('mkdir /tmp/z');
		assert.deepStrictEqual([c.done.stats.tmpEntries, c.done.stats.homeEntries], [0, 0], 'nothing is kept: nothing to lose');
		const d = await h.run('echo hi', { keepTmp: true });
		assert.deepStrictEqual([d.done.stats.tmpEntries, d.done.stats.homeEntries], [0, 0], 'a fresh /tmp is empty: /tmp itself is not an entry');
	});

	test('text that is not UTF-8 goes through the engine untouched, and what is shown is U+FFFD, never a lone surrogate', async () => {
		const bin = (...b) => Uint8Array.from(b);
		const h = await host({ '/w/lat': bin(0x63, 0x61, 0x66, 0xe9, 0x0a), '/w/two': bin(0xc3, 0xa9, 0xff, 0x0a), '/w/bom': bin(0xef, 0xbb, 0xbf, 0x68, 0x69, 0x0a), '/w/utf': 'café ñ ü 日本\n' });
		const r = await h.run('sed -i "s/zzz/y/" lat two bom utf; cat lat | cat > c1; x=$(cat two); printf "%s\\n" "$x" > c2; sort -o s1 lat; tee t1 < lat > /dev/null; echo "$(cat bom)" > b2; cat lat; cat utf | sort; cut -f1 utf');
		assert.deepStrictEqual(r.done.changes.map((c) => c.path).sort(), ['/w/b2', '/w/c1', '/w/c2', '/w/s1', '/w/t1'], 'sed -i with no match changes nothing');
		const by = Object.fromEntries(r.done.changes.map((c) => [c.path, [...c.after]]));
		assert.deepStrictEqual(by['/w/c1'], [0x63, 0x61, 0x66, 0xe9, 0x0a]);
		assert.deepStrictEqual(by['/w/c2'], [0xc3, 0xa9, 0xff, 0x0a]);
		assert.deepStrictEqual(by['/w/s1'], [0x63, 0x61, 0x66, 0xe9, 0x0a]);
		assert.deepStrictEqual(by['/w/t1'], [0x63, 0x61, 0x66, 0xe9, 0x0a]);
		assert.deepStrictEqual(by['/w/b2'], [0xef, 0xbb, 0xbf, 0x68, 0x69, 0x0a]);
		assert.strictEqual(r.stdout, 'caf\ufffd\ncaf\u00e9 \u00f1 \u00fc \u65e5\u672c\ncaf\u00e9 \u00f1 \u00fc \u65e5\u672c\n');
		assert.ok(!/[\udc80-\udcff]/.test(r.stdout + r.stderr), 'no lone surrogate reaches the host');
		for (const m of r.outs) { assert.ok(!/[\udc80-\udcff]/.test(m.text)); }
		// two commands that each print half of a character, in ONE statement (one chunk): what is shown is the character
		// (the halves are escapes in the engine, joined for the eye), in stdout and in stderr; a lone half is U+FFFD. Two
		// statements are two chunks, each shown as it arrives, and cannot be joined
		const j = await (await host({})).run("{ printf '\\303'; printf '\\251\\n'; }; { printf '\\303' >&2; printf '\\251\\n' >&2; }; printf '\\303\\n'; printf 'a\\251b\\n'");
		assert.strictEqual(j.stdout, '\u00e9\n\ufffd\na\ufffdb\n');
		assert.strictEqual(j.stderr, '\u00e9\n');
	});

	test('a host that cannot list or stat something below a removed folder: the run is withheld as incomplete with a reason, status 1, nothing after the output', async () => {
		const tree = makeTree({ '/w': null, '/w/d/a.txt': 'a\n', '/w/d/sub/f.txt': 'f\n', '/w/ok.txt': 'ok\n' });
		for (const fail of [{ op: 'readDir', path: '/w/d/sub', code: 'EACCES' }, { op: 'stat', path: '/w/d/sub/f.txt', code: 'EIO' }]) {
			const posts = [];
			const core = createCore({
				Engine: E,
				post: (m) => {
					posts.push(m);
					if (m.t !== 'fs') { return; }
					setImmediate(() => {
						if (m.op === fail.op && m.path === fail.path) { core.handle({ t: 'fsr', rid: m.rid, ok: false, error: { code: fail.code, message: 'the editor said ' + fail.code } }); return; }
						const n = tree.nodes.get(m.path);
						if (m.op === 'stat') { core.handle(n === undefined ? { t: 'fsr', rid: m.rid, ok: false, error: { code: 'ENOENT', message: 'no' } } : { t: 'fsr', rid: m.rid, ok: true, value: { type: n === null ? 'dir' : 'file', size: n ? n.length : 0, mtime: 1 } }); } else if (m.op === 'readDir') { core.handle({ t: 'fsr', rid: m.rid, ok: true, value: tree.list(m.path) }); } else { core.handle({ t: 'fsr', rid: m.rid, ok: true, value: n.slice() }); }
					});
				},
			});
			await core.handle({ t: 'init', gen: 1, folders: [{ id: 'f', path: '/w', name: 'w' }] });
			await core.handle({ t: 'run', id: 1, script: 'echo new > new.txt; rm -rf d; echo "rc=$?"', cwd: '/w', env: {} });
			const done = posts.filter((m) => m.t === 'done')[0];
			const out = posts.filter((m) => m.t === 'out').map((m) => m.text).join('');
			assert.strictEqual(posts.filter((m) => m.t === 'done').length, 1);
			assert.strictEqual(out, 'rc=0\n', JSON.stringify(fail) + ': ' + out);
			assert.deepStrictEqual([done.how, done.exitCode, done.changes.length, done.stats.withheld], ['exit', 1, 0, 'incomplete'], JSON.stringify(fail));
			assert.ok(done.notes.some((n) => /^None of its file changes were applied: /.test(n)), JSON.stringify(done.notes));
			assert.ok(done.notes.some((n) => /editor/.test(n)), 'what failed is said: ' + JSON.stringify(done.notes));
			assert.ok(!/bash: EIO|bash: EACCES/.test(out), 'no raw error line');
		}
	});

	test('PATH replaced does not take away the builtins that are programs here (echo, printf, pwd), and the others are not found, as in bash', async () => {
		const h = await host({ '/w/f': 'x\n' });
		const r = await h.run('PATH=/nonexistent; echo a; printf "b\\n"; pwd; cat f; echo "rc=$?"; type echo');
		assert.strictEqual(r.stdout, 'a\nb\n/w\nrc=127\necho is a shell builtin\n');
		assert.ok(/cat: command not found/.test(r.stderr), r.stderr);
		const u = await h.run('unset PATH; echo a; printf "b\\n"; pwd');
		assert.strictEqual(u.stdout, 'a\nb\n/w\n');
	});

	test('the builtins the engine declares and has not are not offered: help does not list them, command -v and type do not find them', async () => {
		const h = await host();
		const r = await h.run('help | tr -s " " "\\n" | grep -x -e trap -e umask -e kill -e jobs -e ulimit | wc -l; help | grep -c -e "^echo" ; command -v trap umask kill jobs; echo "rc=$?"; type trap; echo "rc=$?"; command -v cd export echo; help trap; echo "rc=$?"');
		const lines = r.stdout.split('\n');
		assert.strictEqual(lines[0], '0', 'not in the list of help');
		assert.ok(r.stdout.includes('rc=1\n'), r.stdout);
		assert.ok(r.stdout.includes('cd\nexport\n') || r.stdout.includes('cd\nexport\necho'), 'real builtins are found: ' + r.stdout);
		assert.ok(/no help topics match `trap'/.test(r.stderr), r.stderr);
		// running one is still "command not found", and the script goes on
		const t = await h.run('trap "echo x" EXIT; echo after; umask 022; echo "rc=$?"');
		assert.strictEqual(t.stdout, 'after\nrc=127\n');
	});

	test('a command that fails on a missing folder is reported as GNU does and the rest of the script still applies', async () => {
		const h = await host({ '/w/a.txt': 'b\na\n' });
		const r = await h.run('echo kept > ok.txt; touch nodir/f; echo "touch=$?"; echo x | tee nodir/x > /dev/null; echo "tee=$?"; sort a.txt -o nodir/o; echo "sort=$?"; touch a.txt/x; echo "file=$?"; mkdir d; echo y | tee d > /dev/null; echo "dir=$?"; split -l 1 a.txt nodir/p; echo "split=$?"; echo a | awk \'{print > "nodir/x"}\'; echo "awk=$?"; echo end');
		assert.strictEqual(r.how, 'exit', 'the engine\'s exec() was not rejected by any of them');
		assert.ok(r.stdout.endsWith('end\n'), r.stdout);
		for (const k of ['touch', 'tee', 'sort', 'file', 'dir', 'split', 'awk']) { assert.ok(new RegExp(k + '=[1-9]').test(r.stdout), k + ' failed: ' + r.stdout); }
		assert.deepStrictEqual(r.done.denied, [], 'nothing was refused by the shell');
		assert.strictEqual(r.done.stats.withheld, null);
		assert.deepStrictEqual(r.done.changes.map((c) => c.kind + ':' + c.path).sort(), ['mkdir:/w/d', 'write:/w/ok.txt']);
		assert.ok(/No such file or directory/.test(r.stderr), r.stderr);
	});

	test('the engine\'s limit messages from sed and awk carry the program name once', async () => {
		const h = await host();
		const r = await h.run('echo a | sed ":a;ba"; echo "rc=$?"; echo a | awk "BEGIN{while(1){}}"; echo "rc=$?"');
		assert.strictEqual(r.stdout, 'rc=126\nrc=126\n');
		assert.ok(/^sed: command execution exceeded maximum iterations \(100000\)$/m.test(r.stderr), r.stderr);
		assert.ok(/^awk: while loop exceeded maximum iterations \(100000\)$/m.test(r.stderr), r.stderr);
		assert.ok(!/sed: sed:|awk: awk:/.test(r.stderr));
		assert.strictEqual(r.how, 'exit', 'a program-level limit leaves the script going');
	});

	test('the local time of a shell is UTC whatever the zone of the process, and the script\'s TZ when it has one', async () => {
		const was = process.env.TZ;
		try {
			for (const zone of ['UTC', 'America/New_York', 'Asia/Tokyo', 'Australia/Sydney']) {
				process.env.TZ = zone;
				const h = await host();
				const r = await h.run("date -u -d '2020-02-29 12:00:00' '+%F %T %Z'; touch -d '2020-01-02 03:04:05' t; stat -c '%y %Y' t; touch -t 202001020304.05 u; stat -c %Y u; ls -l t | awk '{print $6, $7, $8}'; TZ=Asia/Tokyo date -d '2020-02-29 12:00:00' '+%F %T'; TZ=America/New_York date -d '2020-06-01 12:00' '+%Z %z'; date -d @1583000000 '+%F %T'; touch -d @1580000000 /tmp/m; ls -l /tmp/m | awk '{print $6, $7, $8}'; TZ=America/New_York ls -l /tmp/m | awk '{print $6, $7, $8}'");
				assert.strictEqual(r.stdout, '2020-02-29 12:00:00 UTC\n2020-01-02 03:04:05.000000000 +0000 1577934245\n1577934245\nJan 2 2020\n2020-02-29 12:00:00\nEDT -0400\n2020-02-29 18:13:20\nJan 26 2020\nJan 25 2020\n', zone + '\n' + r.stdout);
			}
		} finally {
			if (was === undefined) { delete process.env.TZ; } else { process.env.TZ = was; }
		}
	});

	test('a redirection whose target the command itself removes or replaces ends the redirection, not the run: the output and what follows are kept (GNU writes to the open descriptor)', async () => {
		const shapes = [
			'echo before; { rm -rf d; echo hi; } > d/f; echo "after rc=$?"',
			'f() { rm -rf d; echo hi; }; f > d/log; echo "after rc=$?"',
			'( rm -rf d; echo hi ) > d/f 2>&1; echo "after rc=$?"',
			'for i in 1 2; do rm -rf d; echo $i; done > d/f; echo "after rc=$?"',
			'{ rm -rf d; echo hi; } >> d/f; echo "after rc=$?"',
			'{ rm -rf d; echo hi; echo there; } > d/f 2> d/e; echo "after rc=$?"',
			'exec > d/log; rm -rf d; echo hi; echo there',
		];
		for (const script of shapes) {
			const h = await host({ '/w/d/x': 'x\n', '/w/keep': 'k\n' });
			const r = await h.run(script);
			assert.strictEqual(r.how, 'exit', script + ' -> ' + r.how + ' ' + r.stderr);
			assert.strictEqual(r.stderr, '', script);
			assert.ok(r.stdout.endsWith('after rc=0\n') || script.startsWith('exec'), script + ' -> ' + JSON.stringify(r.stdout));
			assert.deepStrictEqual(r.done.denied, [], script);
			assert.strictEqual(r.done.stats.withheld, null, script);
			assert.deepStrictEqual(kinds(r).sort(), ['delete:/w/d/x', 'rmdir:/w/d'], 'the folder is gone and nothing was written to it: ' + script);
		}
		// the folder the command made again is a new folder: the descriptor was the old one's, and its name is the new one's
		const h = await host({ '/w/d/x': 'x\n' });
		const r = await h.run('{ rm -rf d; mkdir d; echo hi; } > d/f; echo "after rc=$?"');
		assert.strictEqual(r.how, 'exit');
		assert.ok(r.stdout.endsWith('after rc=0\n'), r.stdout);
		// a file replaced by a folder: the shell cannot say that in one change set, and says so (the run is not lost)
		const g = await host({ '/w/f': 'old\n' });
		const q = await g.run('{ rm f; mkdir f; echo hi; } > f; echo "after rc=$?"');
		assert.strictEqual(q.how, 'exit');
		assert.strictEqual(q.stdout, 'after rc=0\n');
		assert.strictEqual(q.stderr, '');
	});

	test('a program that writes with no redirection of its own gets the errno of a real file system, whatever a redirection did to the SAME path before it', async () => {
		const h = await host({ '/w/d/x': 'x\n' });
		const r = await h.run('{ rm -rf d; echo hi; } > d/f; echo "rc=$?"; touch d/t; echo "touch=$?"; echo y | tee d/u > /dev/null; echo "tee=$?"; echo end');
		assert.strictEqual(r.how, 'exit');
		assert.strictEqual(r.stdout, 'rc=0\ntouch=1\ntee=1\nend\n');
		assert.ok(/touch: cannot touch 'd\/t'/.test(r.stderr) && /tee: d\/u: No such file or directory/.test(r.stderr), r.stderr);
		// the same paths: a redirection wrote d/f, the folder is removed, and then a program writes d/f (the path-keyed
		// memory of an opened path made all of these silent, with status 0)
		const same = await h.run([
			'mkdir e; echo a > e/f; rm -rf e',
			'echo b | tee e/f; echo "tee=$?"',
			'echo b | tee -a e/f; echo "teea=$?"',
			`awk 'BEGIN { print "x" > "e/f" }' 2>/dev/null; echo "awk=$?"`,
			'echo b | sort -o e/f; echo "sort=$?"',
			'touch e/f; echo "touch=$?"',
			'echo a > g; rm g; mkdir g; echo b | tee g; echo "teedir=$?"',
			'mkdir q; { rm -rf q; echo hi; } > q/z; echo "redir=$?"; echo c | tee q/z; echo "tee2=$?"',
		].join('\n'), { apply: false });
		assert.strictEqual(same.stdout, 'b\ntee=1\nb\nteea=1\nawk=2\nsort=2\ntouch=1\nb\nteedir=1\nredir=0\nc\ntee2=1\n');
		assert.ok(/tee: e\/f: No such file or directory/.test(same.stderr) && /tee: g: Is a directory/.test(same.stderr) && /sort: open failed: e\/f: No such file or directory/.test(same.stderr) && /touch: cannot touch 'e\/f': No such file or directory/.test(same.stderr), same.stderr);
		assert.strictEqual(same.how, 'exit');
		assert.deepStrictEqual(same.done.denied, [], 'a failed write of a program is its own error, not a refusal by the shell');
	});

	test('cd up to the root and down again, `.` and `..` in a path: the working directory is a canonical path (it was `//w`), for pwd, PWD, OLDPWD, cd -, and what the host is told', async () => {
		const h = await host({ '/w/src/a': 'x\n' });
		const r = await h.run('cd /w/../w/./src && pwd; echo $PWD; cd /; cd /w/../w; pwd; echo "$OLDPWD"; cd /w/./src/..; pwd; cd - >/dev/null; pwd; cd /w/src/../src/.; pwd; echo "$PWD|$OLDPWD"; pushd /w/../w/src > /dev/null; pwd; realpath /w/../w//src/./a; readlink -f ../src/a');
		assert.strictEqual(r.stdout, '/w/src\n/w/src\n/w\n/\n/w\n/w\n/w/src\n/w/src|/w\n/w/src\n/w/src/a\n/w/src/a\n');
		assert.strictEqual(r.done.cwd, '/w/src');
		assert.strictEqual(r.done.env.PWD, '/w/src');
		// a script that assigns PWD a path with dots: what the host is told is canonical
		const p = await h.run('PWD=/w/./src/../src; echo hi');
		assert.strictEqual(p.done.cwd, '/w/src');
		assert.strictEqual(p.done.env.PWD, '/w/src');
		// the next line starts there
		const next = await host({ '/w/src/a': 'x\n' });
		const first = await next.run('cd /w/../w/src');
		const second = await next.run('pwd', { cwd: first.done.cwd, env: first.done.env });
		assert.strictEqual(second.stdout, '/w/src\n');
	});

	test('a name made of bytes that are not UTF-8 refuses the change set with the name shown as U+FFFD; no lone surrogate is in anything the host is told', async () => {
		const bin = (...b) => Uint8Array.from(b);
		const files = { '/w/x': bin(0xff), '/w/names': bin(0x61, 0xe9, 0x0a) };
		const scripts = [
			'touch "$(cat x)"; echo ok',
			'cat names | xargs touch; ls',
			'mkdir "d$(cat x)"; echo done',
			'echo hi | tee "/etc/$(cat x)"; echo after',
			'echo hi > "/etc/$(cat x)"; echo after',
			"echo '😀' | awk '{print substr($0,1,1)}'",
			'mkdir "d$(cat x)"; cd "d$(cat x)"; pwd',
			'mkdir -p "d$(cat x)/sub"; cd "d$(cat x)/sub"; echo ok',
			'mkdir "d$(cat x)"; cd "d$(cat x)"; cd ..; cd - > /dev/null; echo ok',
		];
		for (const script of scripts) {
			const h = await host(files);
			const r = await h.run(script);
			// everything the host is told, as strings: the output, the notes, what was denied, the paths of the changes, the
			// working directory, the names of the variables it keeps (the VALUES of done.env may hold an escape: bytes it
			// carries to the next line, which nothing shows)
			const everything = [r.stdout, r.stderr, r.done.cwd, ...Object.keys(r.done.env), ...Object.values(r.done.stats).filter((v) => typeof v === 'string'), r.done.how, ...r.done.notes, ...r.done.denied.flatMap((d) => [d.path, d.message, d.reason]), ...r.done.changes.map((c) => c.path), ...r.outs.map((m) => m.text)].join('\n');
			assert.ok(!/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(everything), 'a lone surrogate in the output of: ' + script);
			assert.strictEqual(r.how, 'exit', script);
		}
		const h = await host(files);
		const r = await h.run('touch "ok$(cat x)b"; echo ok');
		assert.deepStrictEqual(r.done.changes, []);
		assert.strictEqual(r.done.stats.withheld, 'incomplete');
		assert.strictEqual(r.exitCode, 1, 'a script that "succeeded" and changed nothing must not look as if it had');
		assert.ok(r.done.notes.includes('None of its file changes were applied: /w/ok�b has a name that is not valid UTF-8, which the editor cannot address.'), JSON.stringify(r.done.notes));
		const a = await (await host(files)).run('echo hi | tee "/etc/$(cat x)"');
		assert.strictEqual(a.stderr, 'bash: /etc/�: Permission denied\n');
		assert.deepStrictEqual(a.done.denied.map((d) => d.path), ['/etc/�']);
		// (awk counts characters since LC-33: `substr($0,1,1)` of an emoji is the emoji; printf's precision still cuts a UTF-16 pair)
		const e = await (await host(files)).run("printf '%.1s\\n' '😀'; echo '😀' | awk '{print substr($0,1,1)}'");
		assert.strictEqual(e.stdout, '�\n😀\n', 'half of an emoji is U+FFFD, not a lone surrogate; awk takes the whole character');
		// a script that ends inside a folder whose name is not UTF-8 (its change set is refused): the session is handed the
		// nearest folder above it that has a name, not '/w/\udcff'
		const d = await (await host(files)).run('mkdir "d$(cat x)"; cd "d$(cat x)"; pwd');
		assert.strictEqual(d.exitCode, 1);
		assert.strictEqual(d.done.cwd, '/w');
		assert.strictEqual(d.done.env.PWD, '/w');
		assert.ok(d.done.notes.includes('The directory /w/d� has a name that is not valid UTF-8, which the editor cannot address; the session stays in /w.'), JSON.stringify(d.done.notes));
		const deep = await (await host(files)).run('mkdir -p ok/"$(cat x)"/sub; cd ok/"$(cat x)"/sub; pwd');
		assert.strictEqual(deep.done.cwd, '/w/ok', 'the nearest folder above that has a name');
		// bytes that ARE UTF-8 (printf '\303\251' is the two bytes of é) make that name: the folder, the change and the
		// working directory the host is told are `dé`, and the session is in it (it is not one of the names above)
		const utf8 = await (await host({})).run('mkdir "d$(printf \'\\303\\251\')"; cd "d$(printf \'\\303\\251\')"; pwd; echo hi > f');
		assert.strictEqual(utf8.stdout, '/w/dé\n');
		assert.strictEqual(utf8.done.cwd, '/w/dé');
		assert.deepStrictEqual(utf8.done.changes.map((c) => c.path).sort(), ['/w/dé', '/w/dé/f']);
		assert.deepStrictEqual(utf8.done.notes, []);
	});

	test('du is bounded like find: past maxTraversalEntries the script ends as a limit, with the engine\'s wording; exactly the limit is fine', async () => {
		const files = { '/w/big': null };
		for (let i = 0; i < 19; i++) { files['/w/big/f' + i] = 'x'; }
		const init = async (f) => {
			const h = await host(f, { start: false });
			await h.core.handle({ t: 'init', gen: 1, folders: [{ id: 'f', path: '/w', name: 'w' }], limits: { maxTraversalEntries: 20 } });
			return h;
		};
		// the folder and its 19 files are 20 entries
		const ok = await (await init(files)).run('du -s big; du -a big | wc -l');
		assert.strictEqual(ok.how, 'exit');
		assert.strictEqual(ok.stdout, '80\tbig\n20\n');
		files['/w/big/one-more'] = 'x';
		for (const script of ['du -s big', 'du -a big | wc -l', 'du big; echo after', 'cd big; du .']) {
			const h = await init(files);
			const r = await h.run('echo started; ' + script);
			assert.strictEqual(r.how, 'limit', script + ' -> ' + r.how + ' ' + r.stderr);
			assert.strictEqual(r.exitCode, 126);
			assert.ok(/(^|\n)bash: stopped by a limit of this shell: du: filesystem traversal entry limit exceeded \(20\)\n/.test(r.stderr), r.stderr);
			assert.ok(!/after/.test(r.stdout), 'the script ended there');
			assert.ok(r.stdout.startsWith('started\n'));
		}
		// the same bound for cp -u of a tree
		const c = await (await init(files)).run('cp -ru big copy; echo after');
		assert.strictEqual(c.how, 'limit');
		assert.ok(/cp: filesystem traversal entry limit exceeded \(20\)/.test(c.stderr), c.stderr);
	});

	for (const t of tests) {
		await t.fn();
		console.log('  ok - ' + t.name);
	}
	console.log(`\n${tests.length} tests passed`);
}

main().catch((e) => { console.error(e); process.exit(1); });
