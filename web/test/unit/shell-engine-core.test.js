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

	for (const t of tests) {
		await t.fn();
		console.log('  ok - ' + t.name);
	}
	console.log(`\n${tests.length} tests passed`);
}

main().catch((e) => { console.error(e); process.exit(1); });
