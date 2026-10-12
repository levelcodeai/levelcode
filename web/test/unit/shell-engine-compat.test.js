/*---------------------------------------------------------------------------------------------
 *  What the engine lacks that GNU has — run: node web/test/unit/shell-engine-compat.test.js
 *
 *  compat.js is pure functions from the arguments a person or a model types to the arguments the engine takes, a few
 *  commands the engine does not have (od, realpath, uname, id, nproc, cmp), and wrappers that carry them out. The
 *  golden suite compares the whole of it with GNU; this one pins the argument handling case by case, including the
 *  forms the independent check found broken (`xargs -I {} -P2`, `-n 1 -P4`), and what is NOT dropped.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

// A test that waits for something that never happens must fail the suite, not end it silently with status 0.
require('../helpers/shell-exit-guard.js');

// `touch -t`, `date` and `stat` read local time as GNU does, and the shell's is UTC (or the command's TZ): the process's
// zone, the visitor's in a browser, is never asked. The whole suite is run under three of them.
const ZONES = ['UTC', 'America/New_York', 'Asia/Tokyo'];
const PROCESS_TZ = process.env.TZ;

const assert = require('assert');
const path = require('path');

const { loadEngine, makeTree, makeHost, ENGINE_DIR } = require('./shell-engine-support.js');
const c = require(path.join(ENGINE_DIR, 'compat.js'));

/** @type {Array<{ name: string, fn: () => Promise<void> | void }>} */
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

const bytes = (s) => (typeof s === 'string' ? Uint8Array.from(s, (ch) => ch.charCodeAt(0)) : Uint8Array.from(s));

async function main() {
	const E = await loadEngine();
	const host = async (files) => makeHost({ Engine: E, tree: makeTree(Object.assign({ '/w': null }, files || {})) });
	const sh = async (script, files) => (await host(files)).run(script);
	const out = async (script, files) => { const r = await sh(script, files); return r.stdout; };

	/* ------------------------------------------------------------------------------------------ xargs */

	test('xargs: the attached, separated and clustered forms, in any order, become the engine\'s one-option-per-argument', () => {
		const t = [
			[['-I{}', 'echo', 'got-{}'], ['-I', '{}', 'echo', 'got-{}']],
			[['-I', '{}', 'echo', '{}'], ['-I', '{}', 'echo', '{}']],
			[['-I', '{}', '-P2', 'echo', '{}'], ['-I', '{}', 'echo', '{}']],      // found broken by the independent check
			[['-n', '1', '-P4', 'echo'], ['-n', '1', 'echo']],                     // ditto
			[['-n1', '-P', '4', 'echo'], ['-n', '1', 'echo']],
			[['-P4', '-n1', 'echo'], ['-n', '1', 'echo']],
			[['-P', '4', '-I', '%', 'echo', '%'], ['-I', '%', 'echo', '%']],
			[['-L1', 'echo'], ['-n', '1', 'echo']],
			[['-L', '2', 'echo'], ['-n', '2', 'echo']],
			[['-l', 'echo'], ['-n', '1', 'echo']],
			[['-i', 'echo', '{}'], ['-I', '{}', 'echo', '{}']],
			[['-i%', 'echo', '%'], ['-I', '%', 'echo', '%']],
			[['-0r', 'echo'], ['-0', '-r', 'echo']],
			[['-rn1', 'echo'], ['-r', '-n', '1', 'echo']],
			[['-0', '-n', '1', 'rm'], ['-0', '-n', '1', 'rm']],
			[['--null', '--no-run-if-empty', '--verbose', 'echo'], ['-0', '-r', '-t', 'echo']],
			[['--max-args=2', 'echo'], ['-n', '2', 'echo']],
			[['--max-args', '2', 'echo'], ['-n', '2', 'echo']],
			[['--replace', 'echo', '{}'], ['-I', '{}', 'echo', '{}']],
			[['--replace=@', 'echo', '@'], ['-I', '@', 'echo', '@']],
			[['--replace=', 'echo'], ['-I', '', 'echo']],                         // an empty string is the string (it was `{}`)
			[['--max-procs=4', 'echo'], ['echo']],
			[['--max-procs', '4', 'echo'], ['echo']],
			[['-s', '1000', 'echo'], ['echo']],
			[['-s1000', '-E', 'EOF', 'echo'], ['echo']],
			[['-x', 'echo'], ['echo']],
			[['-d', ',', '-n', '1', 'echo'], ['-d', ',', '-n', '1', 'echo']],
			[['-d,', 'echo'], ['-d', ',', 'echo']],
			[['--delimiter=,', 'echo'], ['-d', ',', 'echo']],
			[['echo', '-n', 'is-an-argument-of-echo'], ['echo', '-n', 'is-an-argument-of-echo']],
			[['--', '-n', 'x'], ['--', '-n', 'x']],
			[[], []],
			[['-I'], ['-I']],                                                      // a value that is not there is not the word "undefined"
			[['-n'], ['-n']],
			[['--max-args'], ['-n']],
			[['-d'], ['-d']],
		];
		for (const [input, expected] of t) { assert.deepStrictEqual(c.normaliseXargs(input), expected, JSON.stringify(input)); }
	});

	test('xargs: every form gives GNU\'s answer through the engine', async () => {
		const h = await host();
		const cases = [
			["printf 'a\\nb\\n' | xargs -I{} echo got-{}", 'got-a\ngot-b\n'],
			["printf 'a\\nb\\n' | xargs -I {} -P2 echo got-{}", 'got-a\ngot-b\n'],
			["printf '1 2 3 4\\n' | xargs -n 2 -P4 echo", '1 2\n3 4\n'],
			["printf '1 2 3\\n' | xargs -n1 echo item", 'item 1\nitem 2\nitem 3\n'],
			["printf 'a b\\0c\\0' | xargs -0 -n1 echo item", 'item a b\nitem c\n'],
			["printf '1 2 3\\n' | xargs -rn1 echo n", 'n 1\nn 2\nn 3\n'],
			["printf 'a\\nb\\n' | xargs --max-args=1 echo x", 'x a\nx b\n'],
			["printf 'a,b,c' | xargs -d, -n1 echo item", 'item a\nitem b\nitem c\n'],
			["printf '' | xargs echo ran; echo done", 'ran\ndone\n'],
			["printf '' | xargs -r echo ran; echo done", 'done\n'],
			["printf '' | xargs -I{} echo ran; echo done", 'done\n'],
			["printf ' \\n\\n' | xargs echo blank", 'blank\n'],
			["printf 'a\\n' | xargs sh -c 'echo \"[$1]\"' _", '[a]\n'],
		];
		for (const [script, expected] of cases) {
			const r = await h.run(script);
			assert.strictEqual(r.stdout, expected, script + '\n' + r.stderr);
		}
	});

	/* ------------------------------------------------------------------------------------------ grep */

	test('grep: what means nothing here is dropped (also from clusters), values are never mistaken for options', () => {
		const t = [
			[['-s', 'x', 'f'], ['x', 'f']],
			[['--no-messages', 'x', 'f'], ['x', 'f']],
			[['--color', 'x'], ['x']],
			[['--color=always', 'x'], ['x']],
			[['--colour=never', 'x'], ['x']],
			[['-I', 'x'], ['x']],
			[['--binary-files=without-match', 'x'], ['x']],
			[['--line-buffered', 'x'], ['x']],
			[['-a', '-U', 'x'], ['x']],
			[['-rnIs', 'x', 'd'], ['-rn', 'x', 'd']],
			[['-snr', 'x'], ['-nr', 'x']],
			[['-s'], []],
			[['-e', '-s', 'f'], ['-e', '-s', 'f']],
			[['-e-s', 'f'], ['-e-s', 'f']],
			[['-A', '2', '-s', 'x'], ['-A', '2', 'x']],
			[['-m1', '-I', 'x'], ['-m1', 'x']],
			[['--include=*.js', '-rI', 'x', '.'], ['--include=*.js', '-r', 'x', '.']],
			[['--exclude-dir', 'node_modules', '-s', 'x'], ['--exclude-dir=node_modules', 'x']],
			[['-oP', '\\d+'], ['-oP', '\\d+']],
			[['--', '-s', 'f'], ['--', '-s', 'f']],
			[['x', 'f', '-s'], ['x', 'f']],
		];
		for (const [input, expected] of t) { assert.deepStrictEqual(c.normaliseGrep(input), expected, JSON.stringify(input)); }
		assert.strictEqual(c.grepWantsSilence(['-s', 'x']), true);
		assert.strictEqual(c.grepWantsSilence(['-rns', 'x']), true);
		assert.strictEqual(c.grepWantsSilence(['--no-messages', 'x']), true);
		assert.strictEqual(c.grepWantsSilence(['-e', '-s', 'f']), false);
		assert.strictEqual(c.grepWantsSilence(['-A', '2', 'x']), false);
		assert.strictEqual(c.grepWantsSilence(['--', '-s']), false);
	});

	test('grep: -s silences the missing-file lines only; a recursive search of . names files as GNU does; -r alone searches .', async () => {
		const h = await host({ '/w/d/a': 'foo\n', '/w/d/e/b': 'foo\n', '/w/f': 'foo\n' });
		assert.deepStrictEqual([(await h.run('grep -s foo nofile f; echo rc=$?')).stdout, (await h.run('grep -s foo nofile f')).stderr], ['f:foo\nrc=2\n', '']);
		assert.ok((await h.run('grep foo nofile')).stderr.includes('grep: nofile'));
		assert.strictEqual((await h.run('grep -s -c foo f nofile')).stderr, '');
		assert.strictEqual((await h.run('cd d; grep -rn foo . | sort')).stdout, './a:1:foo\n./e/b:1:foo\n');
		assert.strictEqual((await h.run('cd d; grep -rn foo | sort')).stdout, 'a:1:foo\ne/b:1:foo\n');
		assert.strictEqual((await h.run('cd d; grep -rhn foo . | sort')).stdout, '1:foo\n1:foo\n');
		assert.strictEqual((await h.run('cd d; grep -rn foo e a | sort')).stdout, 'a:1:foo\ne/b:1:foo\n');
		assert.strictEqual((await h.run('grep --color=auto -n foo f')).stdout, '1:foo\n');
		assert.strictEqual((await h.run("printf 'a1\\nb2\\n' | grep -oP '[a-z]\\K\\d'")).stdout, '1\n2\n');
		assert.strictEqual(c.grepDotPrefix(['-rn', 'x', '.']), true);
		assert.strictEqual(c.grepDotPrefix(['-rn', 'x', 'src']), false);
		assert.strictEqual(c.grepDotPrefix(['-rn', 'x']), false);
		assert.strictEqual(c.grepDotPrefix(['-r', '-e', 'x', '.']), true);
		assert.strictEqual(c.grepDotPrefix(['-rq', 'x', '.']), false);
		assert.strictEqual(c.grepNeedsDot(['-rn', 'x']), true);
		assert.strictEqual(c.grepNeedsDot(['-n', 'x']), false);
		assert.strictEqual(c.grepNeedsDot(['-rn', '-e', 'x']), true);
		assert.strictEqual(c.grepNeedsDot(['-rn', 'x', 'd']), false);
	});

	/* ------------------------------------------------------------------------------------------ cp mv rm */

	test('cp: -a is -r -p; -f -L -P -H -d -x -T are dropped; -t moves; -i and -b are NOT dropped; -u is reported', () => {
		const t = [
			[['-a', 'd', 'e'], { args: ['-rp', 'd', 'e'], update: false }],
			[['--archive', 'd', 'e'], { args: ['-p', '-r', 'd', 'e'], update: false }],
			[['-rf', 'd', 'e'], { args: ['-r', 'd', 'e'], update: false }],
			[['-fp', 'a', 'b'], { args: ['-p', 'a', 'b'], update: false }],
			[['-T', 'a', 'b'], { args: ['a', 'b'], update: false }],
			[['--force', '-L', 'a', 'b'], { args: ['a', 'b'], update: false }],
			[['-u', 'a', 'b'], { args: ['a', 'b'], update: true }],
			[['-ru', 'd', 'e'], { args: ['-r', 'd', 'e'], update: true }],
			[['--update', 'a', 'b'], { args: ['a', 'b'], update: true }],
			[['-t', 'dir', 'a', 'b'], { args: ['a', 'b', 'dir'], update: false }],
			[['--target-directory=dir', 'a', 'b'], { args: ['a', 'b', 'dir'], update: false }],
			[['--target-directory', 'dir', 'a', 'b'], { args: ['a', 'b', 'dir'], update: false }],
			[['-rt', 'dir', 'a'], { args: ['-r', 'a', 'dir'], update: false }],
			[['-tdir', 'a'], { args: ['a', 'dir'], update: false }],
			[['-v', 'a', 'b'], { args: ['-v', 'a', 'b'], update: false }],
			[['-i', 'a', 'b'], { args: ['-i', 'a', 'b'], update: false }],
			[['-b', 'a', 'b'], { args: ['-b', 'a', 'b'], update: false }],
			[['--', '-a', 'b'], { args: ['--', '-a', 'b'], update: false }],
		];
		for (const [input, expected] of t) { assert.deepStrictEqual(c.normaliseCp(input), expected, JSON.stringify(input)); }
		assert.deepStrictEqual(c.normaliseMv(['-i', 'a', 'b']), { args: ['-i', 'a', 'b'], update: false });
		assert.deepStrictEqual(c.normaliseMv(['-T', '-u', 'a', 'b']), { args: ['a', 'b'], update: true });
		assert.deepStrictEqual(c.normaliseMv(['-t', 'd', 'a', 'b']), { args: ['a', 'b', 'd'], update: false });
		assert.deepStrictEqual(c.normaliseMv(['-fv', 'a', 'b']), { args: ['-fv', 'a', 'b'], update: false });
		assert.deepStrictEqual(c.normaliseRm(['-rf', 'd']), ['-rf', 'd']);
		assert.deepStrictEqual(c.normaliseRm(['--preserve-root', '-r', 'd']), ['-r', 'd']);
		assert.deepStrictEqual(c.normaliseRm(['-i', 'f']), ['-i', 'f'], 'a question nobody can answer is not dropped');
		assert.deepStrictEqual(c.normaliseRm(['-rI', 'd']), ['-rI', 'd']);
	});

	test('cp -i, mv -i, rm -i, rm -I: refused, and nothing is copied, moved or removed (a shell with no one to answer says no)', async () => {
		const h = await host();
		const r = await h.run("echo a > a; echo b > b; cp -i a b; echo \"cp=$?\"; mv -i a b; echo \"mv=$?\"; rm -i a; echo \"rm=$?\"; rm -rI b; echo \"rmI=$?\"; cat a b");
		assert.strictEqual(r.stdout, 'cp=1\nmv=1\nrm=1\nrmI=1\na\nb\n');
		assert.strictEqual((r.stderr.match(/invalid option/g) || []).length, 4);
	});

	test('cp -u, mv -u: only when the source is newer, for files and for trees, with a time that is strictly later', async () => {
		const h = await host();
		const cases = [
			["echo old > b; echo new > a; touch -d '@100' b; touch -d '@200' a; cp -u a b; cat b", 'new\n'],
			["echo old > b; echo new > a; touch -d '@200' b; touch -d '@100' a; cp -u a b; cat b", 'old\n'],
			["echo old > b; echo new > a; touch -d '@100' b; touch -d '@100' a; cp -u a b; cat b", 'old\n'],
			["echo a > a; cp -u a b; cat b", 'a\n'],
			["echo old > b; echo new > a; cp -u a b; cat b", 'new\n'],
			["mkdir s t; echo old > t/x; echo new > s/x; echo y > s/y; touch -d '@100' t/x; touch -d '@200' s/x; cp -ru s/* t/; cat t/x t/y", 'new\ny\n'],
			["mkdir s t; echo old > t/x; echo new > s/x; touch -d '@200' t/x; touch -d '@100' s/x; cp -ru s/* t/; cat t/x", 'old\n'],
			["mkdir -p s/sub t; echo a > s/sub/f; cp -ru s t; cat t/s/sub/f", 'a\n'],
			["echo old > b; echo new > a; touch -d '@100' b; touch -d '@200' a; mv -u a b; ls; cat b", 'b\nnew\n'],
			["echo old > b; echo new > a; touch -d '@200' b; touch -d '@100' a; mv -u a b; ls; cat b", 'a\nb\nold\n'],
			["echo a > a; echo b > b; mkdir d; cp -uv a b d/; ls d", "'a' -> 'd/a'\n'b' -> 'd/b'\na\nb\n"],
		];
		for (const [script, expected] of cases) {
			const r = await h.run(script);
			assert.strictEqual(r.stdout, expected, script + '\n' + r.stderr);
			await h.run('rm -rf a b c d s t');
		}
		const miss = await h.run('cp -u nope x; echo "rc=$?"');
		assert.ok(/cp: cannot stat 'nope': No such file or directory/.test(miss.stderr));
		assert.strictEqual(miss.stdout, 'rc=1\n');
	});

	test('cp -v and mv -v name the destination as it was typed, not by its resolved path', async () => {
		const r = await sh("echo a > a; mkdir d; cp -v a b; cp -v a d/; mv -v b c; mv -v c d/");
		assert.strictEqual(r.stdout, "'a' -> 'b'\n'a' -> 'd/a'\nrenamed 'b' -> 'c'\nrenamed 'c' -> 'd/c'\n");
		assert.strictEqual(c.relativeVerbose({ stdout: "'a' -> '/w/b'\n" }, '/w').stdout, "'a' -> 'b'\n");
		assert.strictEqual(c.relativeVerbose({ stdout: "'a' -> '/tmp/b'\n" }, '/w').stdout, "'a' -> '/tmp/b'\n");
		assert.strictEqual(c.relativeVerbose({ stdout: "'a' -> '/b'\n" }, '/').stdout, "'a' -> 'b'\n");
	});

	/* ------------------------------------------------------------------------------------------ mkdir, sed, others */

	test('mkdir: -m MODE is taken out (clusters, attached, long, with the value apart) and applied after', async () => {
		assert.deepStrictEqual(c.normaliseMkdir(['-m', '700', 'd']), { args: ['d'], mode: '700', dirs: ['d'] });
		assert.deepStrictEqual(c.normaliseMkdir(['-m755', 'd', 'e']), { args: ['d', 'e'], mode: '755', dirs: ['d', 'e'] });
		assert.deepStrictEqual(c.normaliseMkdir(['-pm', '700', 'a/b']), { args: ['-p', 'a/b'], mode: '700', dirs: ['a/b'] });
		assert.deepStrictEqual(c.normaliseMkdir(['-pm700', 'a/b']), { args: ['-p', 'a/b'], mode: '700', dirs: ['a/b'] });
		assert.deepStrictEqual(c.normaliseMkdir(['--mode=700', 'd']), { args: ['d'], mode: '700', dirs: ['d'] });
		assert.deepStrictEqual(c.normaliseMkdir(['--mode', '700', 'd']), { args: ['d'], mode: '700', dirs: ['d'] });
		assert.deepStrictEqual(c.normaliseMkdir(['-pv', 'd']), { args: ['-pv', 'd'], mode: null, dirs: ['d'] });
		assert.deepStrictEqual(c.normaliseMkdir(['--', '-m']), { args: ['--', '-m'], mode: null, dirs: ['-m'] });
		const r = await sh('mkdir -m 700 d; stat -c %a d; ls -ld d | cut -c1-10; mkdir -pm 711 a/b/c; stat -c %a a/b/c; mkdir -m 700 d; echo "rc=$?"; stat -c %a d');
		assert.strictEqual(r.stdout, '700\ndrwx------\n711\nrc=1\n700\n');
	});

	test('sed: -i.bak keeps a copy, long options are the short ones, and the GNU one-line text commands get their newline', async () => {
		const t = c.normaliseSed;
		assert.deepStrictEqual(t(['-i.bak', 's/a/b/', 'f']), { args: ['-i', 's/a/b/', 'f'], suffix: '.bak', files: ['f'], fileAt: [2] });
		assert.deepStrictEqual(t(['--in-place=.orig', '-e', 's/a/b/', 'f', 'g']), { args: ['-i', '-e', 's/a/b/', 'f', 'g'], suffix: '.orig', files: ['f', 'g'], fileAt: [3, 4] });
		assert.deepStrictEqual(t(['-i', 's/a/b/', 'f']), { args: ['-i', 's/a/b/', 'f'], suffix: '', files: ['f'], fileAt: [2] });
		assert.deepStrictEqual(t(['-n', '-i', '-e', 'p', 'f']), { args: ['-n', '-i', '-e', 'p', 'f'], suffix: '', files: ['f'], fileAt: [4] });
		assert.deepStrictEqual(t(['--quiet', '--expression=2p', 'f']), { args: ['-n', '-e', '2p', 'f'], suffix: null, files: ['f'], fileAt: [3] });
		assert.deepStrictEqual(t(['-ne', 'p', 'f']), { args: ['-n', '-e', 'p', 'f'], suffix: null, files: ['f'], fileAt: [3] });
		assert.deepStrictEqual(t(['-E', '-f', 'prog.sed', 'f']), { args: ['-E', '-f', 'prog.sed', 'f'], suffix: null, files: ['f'], fileAt: [3] });
		assert.deepStrictEqual(t(['1i\\HEAD', 'f']).args, ['1i\\\nHEAD', 'f']);
		assert.strictEqual(c.fixSedOneLiner('$a\\TAIL'), '$a\\\nTAIL');
		assert.strictEqual(c.fixSedOneLiner('/x/,/y/c\\new\ns/a/b/'), '/x/,/y/c\\\nnew\ns/a/b/');
		assert.strictEqual(c.fixSedOneLiner('s/a/b/;3a\\x'), 's/a/b/;3a\\\nx');
		assert.strictEqual(c.fixSedOneLiner('1i\\\nalready'), '1i\\\nalready');
		assert.strictEqual(c.fixSedOneLiner('s/a\\/b/c/'), 's/a\\/b/c/');
		const r = await sh("printf 'a\\nb\\n' > f; sed -i.bak 's/a/X/' f; cat f f.bak; sed --in-place=.orig 's/b/Y/' f; ls | tr '\\n' ' '; echo; printf 'a\\nb\\n' | sed '1i\\H' | tr '\\n' ' '; echo; mkdir bk; sed -i'bk/*.old' 's/X/Z/' f; ls bk; cat f");
		assert.strictEqual(r.stdout, 'X\nb\na\nb\nf f.bak f.orig \nH a b \nf.old\nZ\nY\n');
	});

	test('paste, head, stat, touch, date, awk: what the engine took as an error or as a literal', async () => {
		assert.deepStrictEqual(c.normalisePaste(['-sd,']), ['-sd,', '-']);
		assert.deepStrictEqual(c.normalisePaste(['-s', '-d', ',']), ['-s', '-d', ',', '-']);
		assert.deepStrictEqual(c.normalisePaste(['-d', ',', 'f']), ['-d', ',', 'f']);
		assert.deepStrictEqual(c.normalisePaste(['-']), ['-']);
		assert.strictEqual(await out("printf '1\\n2\\n' | paste -sd,"), '1,2\n');
		assert.strictEqual(await out("printf '1\\n2\\n3\\n' | paste - - -"), '1\t2\t3\n');
		assert.deepStrictEqual(c.parseHeadNegative(['-n', '-2', 'f']), { unit: 'lines', count: 2, negative: true, quiet: false, verbose: false, zero: false, files: ['f'] });
		assert.deepStrictEqual(c.parseHeadNegative(['-z', '-n', '2', 'f']), { unit: 'lines', count: 2, negative: false, quiet: false, verbose: false, zero: true, files: ['f'] });
		assert.deepStrictEqual(c.parseHeadNegative(['-z']), { unit: 'lines', count: 10, negative: false, quiet: false, verbose: false, zero: true, files: [] });
		assert.deepStrictEqual(c.parseHeadNegative(['-n-2']).unit, 'lines');
		assert.deepStrictEqual(c.parseHeadNegative(['--bytes=-3']).unit, 'bytes');
		assert.strictEqual(c.parseHeadNegative(['-n', '2']), null);
		assert.strictEqual(c.parseHeadNegative(['-5']), null);
		assert.strictEqual(c.parseHeadNegative(['-x']), null);
		assert.strictEqual(Buffer.from(c.dropLast(bytes('a\nb\nc'), 'lines', 1, false)).toString(), 'a\nb\n');
		assert.strictEqual(Buffer.from(c.dropLast(bytes('a\nb\nc\n'), 'lines', 1, false)).toString(), 'a\nb\n');
		assert.strictEqual(Buffer.from(c.dropLast(bytes('abc'), 'lines', 5, false)).toString(), '');
		assert.strictEqual(Buffer.from(c.dropLast(bytes('abcdef'), 'bytes', 2, false)).toString(), 'abcd');
		assert.strictEqual(Buffer.from(c.dropLast(bytes('a\0b\0c'), 'lines', 1, true)).toString(), 'a\0b\0');
		assert.strictEqual(await out('seq 1 5 | head -n -2 | tr "\\n" " "'), '1 2 3 ');
		assert.strictEqual(await out("printf 'é\\nü\\nx\\n' > u; head -n -1 u > v; od -An -tx1 v"), ' c3 a9 0a c3 bc 0a\n');
		assert.strictEqual(await out("printf '1\\n2\\n' > p; printf '3\\n4\\n' > q; head -n -1 p q; head -q -n -1 p q; head -v -n -1 p"), '==> p <==\n1\n\n==> q <==\n3\n1\n3\n==> p <==\n1\n');
		assert.strictEqual(c.statTimeFormat('%n|%Y|%y|%%|%X', 1588748889123), '%n|1588748889|2020-05-06 07:08:09.123000000 +0000|%%|1588748889');
		assert.deepStrictEqual(c.parseStat(['-c', '%Y', 'f', 'g']), { format: '%Y', files: ['f', 'g'], other: [] });
		assert.deepStrictEqual(c.parseStat(['--format=%y', 'f']).format, '%y');
		assert.deepStrictEqual(c.parseStat(['-c%Y', 'f']), { format: '%Y', files: ['f'], other: [] });
		assert.deepStrictEqual(c.parseTouch(['-t', '202005060708.09', 'f']).time, Date.UTC(2020, 4, 6, 7, 8, 9));
		assert.deepStrictEqual(c.parseTouch(['-d', '@100', 'f']), { args: ['f'], time: 100000, files: ['f'], reference: null, dateText: null, invalidStamp: null });
		assert.deepStrictEqual(c.parseTouch(['--date=@-5', 'f']).time, -5000);
		// a date string is read by datestr.js, the grammar of `date -d` (it used to be handed to the engine's own reader)
		assert.deepStrictEqual(c.parseTouch(['-d', '2020-01-01', 'f']), { args: ['f'], time: Date.UTC(2020, 0, 1), files: ['f'], reference: null, dateText: '2020-01-01', invalidStamp: null });
		// -r REF is taken out of the line (the engine ignored it) and handed to the wrapper, which reads REF's time
		assert.deepStrictEqual(c.parseTouch(['-r', 'ref', 'f']), { args: ['f'], time: null, files: ['f'], reference: 'ref', dateText: null, invalidStamp: null });
		assert.deepStrictEqual(c.parseTouch(['--reference=ref', 'f', 'g']), { args: ['f', 'g'], time: null, files: ['f', 'g'], reference: 'ref', dateText: null, invalidStamp: null });
		assert.deepStrictEqual(c.parseTouch(['--reference', 'ref', '-c', 'f']), { args: ['-c', 'f'], time: null, files: ['f'], reference: 'ref', dateText: null, invalidStamp: null });
		assert.deepStrictEqual(c.parseTouch(['-rref', 'f']), { args: ['f'], time: null, files: ['f'], reference: 'ref', dateText: null, invalidStamp: null });
		const r = await sh("touch -d '@100' a; touch -t 197001010000 z; stat -c '%n %Y' a z; date -u -r a +%s; printf 'BEGIN{print \"p\"}\\n{print $1}\\n' > p.awk; echo 'x y' | awk -f p.awk");
		assert.strictEqual(r.stdout, 'a 100\nz 0\n100\np\nx\n');
	});

	test('head and tail: a size with a suffix is its multiple (the engine read `1K` as one byte), GNU\'s suffixes, nothing else touched', async () => {
		const n = c.normaliseCounts;
		assert.deepStrictEqual(n(['-c', '1K', 'f']), ['-c', '1024', 'f']);
		assert.deepStrictEqual(n(['-c1K', 'f']), ['-c1024', 'f']);
		assert.deepStrictEqual(n(['--bytes=1KB', 'f']), ['--bytes=1000', 'f']);
		assert.deepStrictEqual(n(['-n', '+2k', 'f']), ['-n', '+2048', 'f']);
		assert.deepStrictEqual(n(['-c', '-1M']), ['-c', '-1048576']);
		assert.deepStrictEqual(n(['-c', '2b']), ['-c', '1024']);
		assert.deepStrictEqual(n(['-c', '5', 'f']), ['-c', '5', 'f']);
		assert.deepStrictEqual(n(['-c', '1Q', 'f']), ['-c', '1Q', 'f'], 'an unknown suffix is left for the engine to refuse');
		assert.deepStrictEqual(n(['--', '-c', '1K']), ['--', '-c', '1K'], 'after -- they are files');
		assert.deepStrictEqual(n(['f', '1K']), ['f', '1K'], 'a file called 1K');
		assert.strictEqual(await out("seq 1 2000 > f; head -c 1K f | wc -c; tail -c 1KB f | wc -c; head -n 1K f | wc -l; head -c -1K f | wc -c; tail -n +1K f | wc -l"), '1024\n1000\n1024\n7869\n977\n');   // seq 1 2000 is 8893 bytes
	});

	test('uniq -c and wc print the widths GNU does; tr sees a NUL', async () => {
		assert.strictEqual(await out("printf 'a\\na\\nb\\n' | uniq -c"), '      2 a\n      1 b\n');
		assert.strictEqual(await out("seq 1 12 | sed 's/.*/x/' | uniq -c"), '     12 x\n');
		assert.strictEqual(await out("printf 'a\\na\\n' | uniq -d"), 'a\n', 'without -c nothing is touched');
		assert.strictEqual(c.wcWidth('  3 a.txt\n  6 words.txt\n  9 total\n', 2, 53), ' 3 a.txt\n 6 words.txt\n 9 total\n');
		assert.strictEqual(c.wcWidth('1 2 4\n', 0, null), '      1       2       4\n');
		assert.strictEqual(c.wcWidth('3\n', 0, null), '3\n');
		assert.strictEqual(c.wcWidth('20 a.txt\n', 1, 20), '20 a.txt\n');
		assert.strictEqual(c.wcWidth('not numbers\n', 1, 5), 'not numbers\n');
		const r = await sh("seq 1 10 > a; seq 1 100 > b; wc -l a b; echo x y | wc; printf 'a b\\n' | wc -w; head -c 20 /dev/zero | tr '\\0' x; echo; printf 'a\\0b' | tr -d '\\0' | wc -c");
		assert.strictEqual(r.stdout, ' 10 a\n100 b\n110 total\n      1       2       4\n2\nxxxxxxxxxxxxxxxxxxxx\n2\n');
	});

	/* ------------------------------------------------------------------------------------------ od */

	const od = async (args, input) => (await c.od(args, async () => bytes(input || ''), async (p) => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT', p }); }));
	const A16 = 'abcdefghijklmnop';

	test('od: the default, a named type, characters, and addresses, as GNU prints them', async () => {
		assert.strictEqual((await od([], 'hi\n')).stdout, '0000000 064550 000012\n0000003\n');
		assert.strictEqual((await od(['-An', '-tx1'], 'hi\n')).stdout, ' 68 69 0a\n');
		assert.strictEqual((await od(['-c'], 'hi\n')).stdout, '0000000   h   i  \\n\n0000003\n');
		assert.strictEqual((await od(['-An', '-a'], 'a\tb\0\x7f')).stdout, '   a  ht   b nul del\n');
		assert.strictEqual((await od(['-An', '-tu1'], '\0\x01\x7f\x80\xff')).stdout, '   0   1 127 128 255\n');
		assert.strictEqual((await od(['-An', '-td1'], '\0\x01\x7f\x80\xff')).stdout, '    0    1  127 -128   -1\n');
		assert.strictEqual((await od(['-An', '-x'], 'hi\n')).stdout, ' 6968 000a\n');
		assert.strictEqual((await od(['-An', '-s'], '\xff\xff')).stdout, '     -1\n');
		assert.strictEqual((await od(['-An', '-d'], 'abcd')).stdout, ' 25185 25699\n');
		assert.strictEqual((await od(['-An', '-b'], 'abc')).stdout, ' 141 142 143\n');
		assert.strictEqual((await od(['-A', 'x', '-t', 'x1'], 'abcdefghijklmnopqrstuvwxyz')).stdout, '000000 61 62 63 64 65 66 67 68 69 6a 6b 6c 6d 6e 6f 70\n000010 71 72 73 74 75 76 77 78 79 7a\n00001a\n');
		assert.strictEqual((await od(['-A', 'd', '-t', 'c'], A16 + 'q')).stdout, '0000000   a   b   c   d   e   f   g   h   i   j   k   l   m   n   o   p\n0000016   q\n0000017\n');
		assert.strictEqual((await od([], '')).stdout, '0000000\n');
		assert.strictEqual((await od(['-An', '-c'], '')).stdout, '');
	});

	test('od: duplicate rows are one star, -v shows them, -j and -N and -w choose the bytes and the row width', async () => {
		const same = 'abcdefgh'.repeat(8);
		assert.strictEqual((await od(['-An', '-c'], same)).stdout, '   a   b   c   d   e   f   g   h   a   b   c   d   e   f   g   h\n*\n');
		assert.strictEqual((await od(['-c'], same)).stdout, '0000000   a   b   c   d   e   f   g   h   a   b   c   d   e   f   g   h\n*\n0000100\n');
		assert.strictEqual((await od(['-v', '-An', '-c'], same)).stdout.split('\n').length, 5);
		assert.strictEqual((await od(['-An', '-c', '-j', '2', '-N', '4'], 'abcdefghij')).stdout, '   c   d   e   f\n');
		assert.strictEqual((await od(['-An', '-tx1', '-w4'], 'abcdefghij')).stdout, ' 61 62 63 64\n 65 66 67 68\n 69 6a\n');
		assert.strictEqual((await od(['-An', '-c', '-w2'], 'abcdef')).stdout, '   a   b\n   c   d\n   e   f\n');
		assert.strictEqual((await od(['-An', '-tx2'], 'abc')).stdout, ' 6261 0063\n', 'a short last unit is padded with zero');
		// GNU does not round a width it cannot use: it says so and takes the width of the widest type
		const w6 = await od(['-An', '-tx4', '-w6'], 'abcdefghij');
		assert.deepStrictEqual([w6.stdout, w6.stderr, w6.exitCode], [' 64636261\n 68676665\n 00006a69\n', 'od: warning: invalid width 6; using 4 instead\n', 0]);
		const w3 = await od(['-An', '-tx1', '-tx2', '-w3'], 'abcd');
		assert.deepStrictEqual([w3.stdout, w3.stderr], [' 61 62\n  6261\n 63 64\n  6463\n', 'od: warning: invalid width 3; using 2 instead\n']);
		assert.strictEqual((await od(['-An', '-tx4', '-w8'], 'abcdefgh')).stderr, '');
		const skip = await od(['-An', '-c', '-j', '5'], 'abc');
		assert.deepStrictEqual([skip.stdout, skip.stderr, skip.exitCode], ['', 'od: cannot skip past end of combined input\n', 1]);
	});

	test('od: several types are printed over one width, the units of each spread over it (as GNU aligns them)', async () => {
		const t = async (types) => (await od(['-An', ...types], A16)).stdout;
		assert.strictEqual(await t(['-tx1', '-to2']), '  61 62  63 64  65 66  67 68  69 6a  6b 6c  6d 6e  6f 70\n 061141 062143 063145 064147 065151 066153 067155 070157\n');
		assert.strictEqual(await t(['-to2', '-tx1']), ' 061141 062143 063145 064147 065151 066153 067155 070157\n  61 62  63 64  65 66  67 68  69 6a  6b 6c  6d 6e  6f 70\n');
		assert.strictEqual(await t(['-tx2', '-tc']), '    6261    6463    6665    6867    6a69    6c6b    6e6d    706f\n   a   b   c   d   e   f   g   h   i   j   k   l   m   n   o   p\n');
		assert.strictEqual(await t(['-tx4', '-tc']), '        64636261        68676665        6c6b6a69        706f6e6d\n   a   b   c   d   e   f   g   h   i   j   k   l   m   n   o   p\n');
		assert.strictEqual(await t(['-tx1', '-tu4']), ' 61 62 63 64 65 66 67 68 69 6a 6b 6c 6d 6e 6f 70\n  1684234849  1751606885  1818978921  1886350957\n');
		assert.strictEqual(await t(['-tx1', '-tx8']), ' 61 62 63 64 65 66 67 68 69 6a 6b 6c 6d 6e 6f 70\n        6867666564636261        706f6e6d6c6b6a69\n');
		assert.strictEqual(await t(['-to1', '-tu2']), ' 141 142 143 144 145 146 147 150 151 152 153 154 155 156 157 160\n   25185   25699   26213   26727   27241   27755   28269   28783\n');
		assert.strictEqual(await t(['-td2', '-to2']), '  25185  25699  26213  26727  27241  27755  28269  28783\n 061141 062143 063145 064147 065151 066153 067155 070157\n');
		assert.strictEqual(await t(['-ta', '-tc', '-tx1']), '   a   b   c   d   e   f   g   h   i   j   k   l   m   n   o   p\n   a   b   c   d   e   f   g   h   i   j   k   l   m   n   o   p\n  61  62  63  64  65  66  67  68  69  6a  6b  6c  6d  6e  6f  70\n');
		const rows = (await od(['-tx1', '-tc'], 'abcdefghijklmnopqrstuvwxyz')).stdout;
		assert.strictEqual(rows, '0000000  61  62  63  64  65  66  67  68  69  6a  6b  6c  6d  6e  6f  70\n          a   b   c   d   e   f   g   h   i   j   k   l   m   n   o   p\n0000020  71  72  73  74  75  76  77  78  79  7a\n          q   r   s   t   u   v   w   x   y   z\n0000032\n');
		assert.strictEqual((await od(['-An', '-tx1z'], 'hello\n')).stdout, ' 68 65 6c 6c 6f 0a                                >hello.<\n');
		assert.strictEqual((await od(['-An', '-tcz'], 'hello\n')).stdout, '   h   e   l   l   o  \\n                                          >hello.<\n');
	});

	test('od: bad options and missing files are errors with GNU\'s words and print no address line', async () => {
		assert.deepStrictEqual(await od(['-t', 'q'], 'x'), { stdout: '', stderr: "od: invalid type string 'q'\n", exitCode: 1 });
		assert.deepStrictEqual(await od(['-A', 'q'], 'x'), { stdout: '', stderr: "od: invalid output address radix 'q'; it must be one character from [doxn]\n", exitCode: 1 });
		assert.deepStrictEqual(await od(['-Z'], 'x'), { stdout: '', stderr: "od: invalid option -- 'Z'\n", exitCode: 1 });
		assert.deepStrictEqual(await od(['nope']), { stdout: '', stderr: 'od: nope: No such file or directory\n', exitCode: 1 });
		assert.ok((await od(['--nonsense'], 'x')).stderr.includes('unrecognized option'));
		const h = await host({ '/w/f': 'ab' });
		assert.strictEqual((await h.run('od -An -c f nope; echo "rc=$?"')).stdout, '   a   b\nrc=1\n');
	});

	/* ------------------------------------------------------------------------------------------ the small commands */

	test('realpath, uname, id, nproc, cmp: what scripts probe a system with', async () => {
		const h = await host({ '/w/a/b': null, '/w/f': 'x' });
		const cases = [
			['cd a; realpath b ../a/b .', '/w/a/b\n/w/a/b\n/w/a\n'],
			['realpath f nope/x; echo "rc=$?"', '/w/f\nrc=1\n'],
			['realpath -e nope; echo "rc=$?"', 'rc=1\n'],
			['realpath -m x/y/../z', '/w/x/z\n'],
			['realpath -q nope/x; echo "rc=$?"', 'rc=1\n'],
			['realpath --relative-to=a a/b', 'b\n'],
			['realpath -s f', '/w/f\n'],
			['uname; uname -s; uname -m; uname -o; uname -sm', 'Linux\nLinux\nx86_64\nGNU/Linux\nLinux x86_64\n'],
			['uname -n', 'localhost\n'],
			['uname -a | cut -d" " -f1,2', 'Linux localhost\n'],
			['id -u; id -g; id -un; id -gn', '1000\n1000\nuser\nuser\n'],
			['id', 'uid=1000(user) gid=1000(user) groups=1000(user)\n'],
			['id nobody; echo "rc=$?"', 'rc=1\n'],
			['nproc; nproc --all', '1\n1\n'],
		];
		for (const [script, expected] of cases) {
			const r = await h.run(script);
			assert.strictEqual(r.stdout, expected, script + '\n' + r.stderr);
		}
		assert.ok(/realpath: nope\/x: No such file or directory/.test((await h.run('realpath nope/x')).stderr));
		assert.ok(/uname: invalid option/.test((await h.run('uname -z')).stderr));
	});

	test('cmp: equal, different at a byte and line, one a prefix of the other, -s, -l, missing', async () => {
		const h = await host({ '/w/a': 'abc\n', '/w/same': 'abc\n', '/w/b': 'abd\n', '/w/l2': 'a\nb\n', '/w/l2x': 'a\nc\n', '/w/short': 'abc', '/w/long': 'abcd' });
		const cases = [
			['cmp a same; echo "rc=$?"', 'rc=0\n', ''],
			['cmp a b; echo "rc=$?"', 'a b differ: byte 3, line 1\nrc=1\n', ''],
			['cmp l2 l2x; echo "rc=$?"', 'l2 l2x differ: byte 3, line 2\nrc=1\n', ''],
			['cmp -s a b; echo "rc=$?"', 'rc=1\n', ''],
			['cmp -l short long; echo "rc=$?"', 'rc=1\n', 'cmp: EOF on short after byte 3\n'],
			['cmp short long; echo "rc=$?"', 'rc=1\n', 'cmp: EOF on short after byte 3, in line 1\n'],
			['cmp a nope; echo "rc=$?"', 'rc=2\n', 'cmp: nope: No such file or directory\n'],
			['cmp a; echo "rc=$?"', 'rc=2\n', "cmp: missing operand after 'a'\n"],
			['printf abc | cmp - a; echo "rc=$?"', 'rc=1\n', 'cmp: EOF on - after byte 3, in line 1\n'],
			['printf abcd | cmp - short; echo "rc=$?"', 'rc=1\n', 'cmp: EOF on short after byte 3, in line 1\n'],
			['printf abc | cmp short -; echo "rc=$?"', 'rc=0\n', ''],
			['printf abd | cmp - short; echo "rc=$?"', '- short differ: byte 3, line 1\nrc=1\n', ''],
		];
		for (const [script, expected, err] of cases) {
			const r = await h.run(script);
			assert.strictEqual(r.stdout, expected, script);
			assert.strictEqual(r.stderr, err, script);
		}
		const l = await h.run("printf 'abc' > p; printf 'axc' > q; cmp -l p q");
		assert.strictEqual(l.stdout, '2 142 170\n');
		// the byte numbers of -l are as wide as the digits of the SMALLER file (10 bytes: two digits)
		const wl = await h.run("printf aaaaXaaaaa > s; (printf aaaaYaaaaa; head -c 5000 /dev/zero | tr '\\0' a) > b; cmp -l s b; cmp -l b s");
		assert.strictEqual(wl.stdout, ' 5 130 131\n 5 131 130\n');
		assert.strictEqual(wl.stderr, 'cmp: EOF on s after byte 10\ncmp: EOF on s after byte 10\n');
	});

	test('the commands compat.js defines are exactly the lists it exports, and the engine\'s programs they shadow exist', async () => {
		const cmds = c.commands(E.defineCommand);
		assert.deepStrictEqual(cmds.map((x) => x.name).sort(), [...c.WRAPPED, ...c.ADDED].sort());
		assert.strictEqual(new Set(cmds.map((x) => x.name)).size, cmds.length);
		const engineNames = E.getCommandNames();
		for (const w of c.WRAPPED) { assert.ok(engineNames.includes(w), w + ' shadows a program the engine has'); }
		for (const a of c.ADDED) { assert.ok(a === 'od' || !engineNames.includes(a), a + ' is not an engine program'); }
		// the lists the host shows the model are data, and a change to one is deliberate: pinned name by name
		assert.deepStrictEqual(c.EXCLUDED, ['gzip', 'gunzip', 'zcat', 'html-to-markdown']);
		assert.deepStrictEqual(c.UNIMPLEMENTED_BUILTINS, ['bg', 'caller', 'disown', 'enable', 'fc', 'fg', 'jobs', 'kill', 'suspend', 'times', 'trap', 'ulimit', 'umask']);
		assert.deepStrictEqual(c.LIKELY_MISSING, ['git', 'npm', 'npx', 'yarn', 'pnpm', 'node', 'deno', 'bun', 'python', 'python3', 'pip', 'pip3', 'ruby', 'perl', 'php', 'java', 'go', 'cargo', 'rustc', 'make', 'cmake', 'gcc', 'cc', 'curl', 'wget', 'ssh', 'scp', 'rsync', 'tar', 'zip', 'unzip', 'gzip', 'gunzip', 'zcat', 'xz', 'bzip2', 'patch', 'less', 'more', 'vi', 'vim', 'nano', 'sudo', 'su', 'ps', 'top', 'docker', 'yq', 'xan', 'sqlite3', 'js-exec', 'html-to-markdown', 'bc', 'shuf', 'tsort', 'iconv', 'dd', 'install', 'truncate', 'sha512sum', 'shasum', 'cksum', 'hexdump', 'xxd']);
		for (const m of c.LIKELY_MISSING) { assert.ok(!c.ADDED.includes(m) && !c.WRAPPED.includes(m), m); }
		for (const m of c.EXCLUDED) { assert.ok(c.LIKELY_MISSING.includes(m)); }
		const h = await host();
		for (const m of c.LIKELY_MISSING) {
			const r = await h.run(`${m} --version; echo "rc=$?"; command -v ${m}; echo "cv=$?"`);
			assert.strictEqual(r.stderr, `bash: ${m}: command not found\n`, m);
			assert.strictEqual(r.stdout, 'rc=127\ncv=1\n', m);
		}
		// builtins the engine names and does not have: found by command -v, 127 when run
		for (const m of c.UNIMPLEMENTED_BUILTINS) {
			const r = await h.run(`${m} 2>&1 </dev/null; echo "rc=$?"`);
			assert.strictEqual(r.stdout, `bash: ${m}: command not found\nrc=127\n`, m);
		}
	});

	/* ------------------------------------------------------------------------------------------ round 2 */

	test('grep: separated values are joined or become the short option; -H and --label are the wrapper\'s, not the engine\'s', () => {
		const n = c.normaliseGrep;
		assert.deepStrictEqual(n(['--include', '*.js', '-r', 'x', '.']), ['--include=*.js', '-r', 'x', '.']);
		assert.deepStrictEqual(n(['--exclude-dir', 'node_modules', 'x']), ['--exclude-dir=node_modules', 'x']);
		assert.deepStrictEqual(n(['--exclude=a', '--exclude', 'b', 'x']), ['--exclude=a', '--exclude=b', 'x']);
		assert.deepStrictEqual(n(['--max-count', '1', 'x']), ['-m', '1', 'x']);
		assert.deepStrictEqual(n(['--max-count=2', 'x']), ['-m', '2', 'x']);
		assert.deepStrictEqual(n(['--after-context', '2', '--before-context=3', '--context', '1', 'x']), ['-A', '2', '-B', '3', '-C', '1', 'x']);
		assert.deepStrictEqual(n(['--regexp', 'a', '--regexp=b', '--file', 'p']), ['-e', 'a', '-e', 'b', '-f', 'p']);
		assert.deepStrictEqual(n(['-H', 'x', 'f']), ['x', 'f']);
		assert.deepStrictEqual(n(['-rnH', 'x']), ['-rn', 'x']);
		assert.deepStrictEqual(n(['--with-filename', 'x', 'f']), ['x', 'f']);
		assert.deepStrictEqual(n(['--label=in', 'x']), ['x']);
		assert.deepStrictEqual(n(['--label', 'in', 'x']), ['x']);
		assert.deepStrictEqual(n(['--include']), ['--include'], 'a missing value is the engine\'s to refuse');
		// operands: where they are, and whether names are asked for
		const g = c.grepOperands(['-rnH', '--include', '*.js', 'pat', 'src', 'lib/']);
		assert.deepStrictEqual([g.recursive, g.withName, g.noName, g.files], [true, true, false, ['src', 'lib/']]);
		assert.deepStrictEqual(g.fileAt, [4, 5]);
		assert.deepStrictEqual(c.grepOperands(['-e', 'a', 'f']).files, ['f']);
		assert.deepStrictEqual(c.grepOperands(['--with-filename', 'a']).withName, true);
		assert.strictEqual(c.grepDotPrefix(['-rn', 'x', './']), true);
	});

	test('grep: -H names the file even for one (also for stdin), -r of one file names none, a trailing slash is not doubled, values may be apart', async () => {
		const h = await host({ '/w/f': 'foo\nbar\n', '/w/src/a.js': 'TODO a\nx\n', '/w/src/b.txt': 'TODO b\n', '/w/src/deep/c.js': 'TODO c\n' });
		const run = async (script) => (await h.run(script)).stdout;
		assert.strictEqual(await run('grep -H foo f'), 'f:foo\n');
		assert.strictEqual(await run('echo foo | grep -H foo'), '(standard input):foo\n');
		assert.strictEqual(await run('grep -Hc foo f'), 'f:1\n', 'the added /dev/null is not counted');
		assert.strictEqual(await run('grep -HL zzz f'), 'f\n');
		assert.strictEqual(await run('grep -nH foo f'), 'f:1:foo\n');
		assert.strictEqual(await run('grep --with-filename foo f'), 'f:foo\n');
		assert.strictEqual(await run('grep -rH TODO src/a.js'), 'src/a.js:TODO a\n');
		assert.strictEqual(await run('grep -rn foo f'), '1:foo\n', 'one file operand, recursive: no name');
		assert.strictEqual(await run('grep -rnh foo f'), '1:foo\n');
		assert.strictEqual(await run('grep -rn TODO src/a.js'), '1:TODO a\n');
		assert.strictEqual(await run('grep -rn TODO src/ | sort'), 'src/a.js:1:TODO a\nsrc/b.txt:1:TODO b\nsrc/deep/c.js:1:TODO c\n');
		assert.strictEqual(await run('grep -rn TODO ./ | sort | head -1'), './src/a.js:1:TODO a\n');
		assert.strictEqual(await run("grep -rl TODO src --include '*.js' | sort"), 'src/a.js\nsrc/deep/c.js\n');
		assert.strictEqual(await run('grep -rl TODO src --exclude-dir deep | sort'), 'src/a.js\nsrc/b.txt\n');
		assert.strictEqual(await run('grep --max-count 1 foo f; grep --after-context 1 foo f | wc -l; grep --regexp bar f'), 'foo\n2\nbar\n');
	});

	test('sort: a cluster that ends in a valued option, long options, and what only matters for huge inputs', async () => {
		const n = c.normaliseSort;
		assert.deepStrictEqual(n(['-nk2', 'f']), ['-n', '-k', '2', 'f']);
		assert.deepStrictEqual(n(['-nrk2', 'f']), ['-nr', '-k', '2', 'f']);
		assert.deepStrictEqual(n(['-rk2,2', 'f']), ['-r', '-k', '2,2', 'f']);
		assert.deepStrictEqual(n(['-rt,', '-k2']), ['-r', '-t', ',', '-k', '2']);
		assert.deepStrictEqual(n(['-t', ',', '-k', '2', 'f']), ['-t', ',', '-k', '2', 'f']);
		assert.deepStrictEqual(n(['-k2n', 'f']), ['-k', '2n', 'f']);
		assert.deepStrictEqual(n(['-nu', 'f']), ['-nu', 'f']);
		assert.deepStrictEqual(n(['-ro', 'out', 'f']), ['-r', '-o', 'out', 'f']);
		assert.deepStrictEqual(n(['--key=2', '--field-separator', ':', '--output=o', 'f']), ['-k', '2', '-t', ':', '-o', 'o', 'f']);
		assert.deepStrictEqual(n(['-S', '1M', '-T', '/tmp', '--parallel=4', '--buffer-size', '2G', 'f']), ['f']);
		assert.deepStrictEqual(n(['-S1M', '-nk2', 'f']), ['-n', '-k', '2', 'f']);
		assert.deepStrictEqual(n(['--', '-nk2']), ['--', '-nk2']);
		const h = await host({ '/w/c': 'x 3\ny 1\nz 2\n', '/w/d': 'b:2\na:2\nc:1\n' });
		const run = async (script) => (await h.run(script)).stdout;
		assert.strictEqual(await run('sort -nk2 c'), 'y 1\nz 2\nx 3\n');
		assert.strictEqual(await run('sort -nrk2 c'), 'x 3\nz 2\ny 1\n');
		assert.strictEqual(await run('sort -rk2,2 c'), 'x 3\nz 2\ny 1\n');
		assert.strictEqual(await run("sort -t' ' -k2 c"), 'y 1\nz 2\nx 3\n');
		// the global -r is not the key's (the key has its own `n`): only the last-resort comparison of the whole line is reversed
		// (GNU sort 8.32, docker: c:1 b:2 a:2; this line used to expect the engine's own answer, b:2 a:2 c:1)
		assert.strictEqual(await run('sort -t: -k2,2n -r d'), 'c:1\nb:2\na:2\n');
		assert.strictEqual(await run('sort -t: -k2n d'), 'c:1\na:2\nb:2\n');
		assert.strictEqual(await run('sort -ro out c; cat out'), 'z 2\ny 1\nx 3\n');
		assert.strictEqual((await h.run('sort -nk2 nope; echo "rc=$?"')).stdout, 'rc=1\n');
	});

	test('ls: --color is dropped, -p is a slash after directories, the total of a long listing is a 4 KiB-block disk usage', async () => {
		const n = c.normaliseLs;
		assert.deepStrictEqual(n(['--color=auto', '-l']), { args: ['-l'], slashOnly: false });
		assert.deepStrictEqual(n(['--color', '-1']), { args: ['-1'], slashOnly: false });
		assert.deepStrictEqual(n(['-p']), { args: ['-F'], slashOnly: true });
		assert.deepStrictEqual(n(['-lp']), { args: ['-lF'], slashOnly: true });
		assert.deepStrictEqual(n(['-pa', 'd']), { args: ['-Fa', 'd'], slashOnly: true });
		assert.deepStrictEqual(n(['-pF']), { args: ['-FF'], slashOnly: false }, '-F asked for as well: its marks stay');
		assert.deepStrictEqual(n(['--indicator-style=slash']), { args: ['-F'], slashOnly: true });
		assert.deepStrictEqual(n(['--', '-p']), { args: ['--', '-p'], slashOnly: false });
		assert.strictEqual(c.lsTotals('total 3\n-rw-r--r-- 1 u u 5000 Jan  1  2020 big\ndrwxr-xr-x 1 u u 4096 Jan  1  2020 d\n-rw-r--r-- 1 u u 2 Jan  1  2020 f\n'), 'total 16\n-rw-r--r-- 1 u u 5000 Jan  1  2020 big\ndrwxr-xr-x 1 u u 4096 Jan  1  2020 d\n-rw-r--r-- 1 u u 2 Jan  1  2020 f\n');
		assert.strictEqual(c.lsTotals('total 1\n-rw-r--r-- 1 u u 0 Jan  1  2020 e\n'), 'total 0\n-rw-r--r-- 1 u u 0 Jan  1  2020 e\n');
		assert.strictEqual(c.lsTotals('a:\ntotal 9\n-rw-r--r-- 1 u u 4096 Jan  1  2020 x\n\nb:\ntotal 9\n-rw-r--r-- 1 u u 4097 Jan  1  2020 y\n'), 'a:\ntotal 4\n-rw-r--r-- 1 u u 4096 Jan  1  2020 x\n\nb:\ntotal 8\n-rw-r--r-- 1 u u 4097 Jan  1  2020 y\n');
		assert.strictEqual(c.lsTotals('total 7\n-rw-r--r-- 1 u u 4.0K Jan  1  2020 x\n'), 'total 7\n-rw-r--r-- 1 u u 4.0K Jan  1  2020 x\n', 'human sizes: the engine\'s line stays');
		assert.strictEqual(c.lsTotals('a.txt\nb.txt\n'), 'a.txt\nb.txt\n');
		const h = await host({ '/w/d/g': 'x', '/w/f': 'abc', '/w/run.sh': '#!/bin/sh\n' });
		const run = async (script) => (await h.run(script)).stdout;
		assert.strictEqual(await run('ls -p'), 'd/\nf\nrun.sh\n');
		assert.strictEqual(await run("ls -lF | awk '{print $NF}'"), '12\nd/\nf\nrun.sh*\n', '-F marks what is executable (a shell script is)');
		assert.strictEqual(await run("ls -lp | awk '{print $NF}'"), '12\nd/\nf\nrun.sh\n', '-p does not');
		assert.strictEqual(await run('ls --color=auto'), 'd\nf\nrun.sh\n');
		assert.strictEqual(await run("ls -l | head -n 1"), 'total 12\n');
		assert.strictEqual(await run("ls -la | head -n 1"), 'total 20\n');
		assert.strictEqual(await run("ls -l d f | grep total"), 'total 4\n');
		assert.strictEqual(await run("ls -lh | head -n 1 | grep -c total"), '1\n');
	});

	test('sed one-liners: a scanner that knows s, y, r, w and labels, and takes linear time', () => {
		const f = c.fixSedOneLiner;
		assert.strictEqual(f('$a\\TAIL'), '$a\\\nTAIL');
		assert.strictEqual(f('/x/,/y/c\\new\ns/a/b/'), '/x/,/y/c\\\nnew\ns/a/b/');
		assert.strictEqual(f('2{i\\HI\n}'), '2{i\\\nHI\n}');
		assert.strictEqual(f('1!G;h;$!d'), '1!G;h;$!d');
		assert.strictEqual(f('/a;b/ a\\X'), '/a;b/ a\\\nX');
		assert.strictEqual(f('1,3 ! i\\X'), '1,3 ! i\\\nX');
		assert.strictEqual(f('\\,x,a\\Y'), '\\,x,a\\\nY', 'an address with its own delimiter');
		assert.strictEqual(f('a\\  indented'), 'a\\\n  indented', 'whitespace after the backslash is the text\'s');
		// what is inside another command is not a command
		assert.strictEqual(f('s/x/;a\\y/'), 's/x/;a\\y/');
		assert.strictEqual(f('s/x/1i\\z/g;p'), 's/x/1i\\z/g;p');
		assert.strictEqual(f('y/;/a/;$a\\T'), 'y/;/a/;$a\\\nT');
		assert.strictEqual(f('s,a,b,;2a\\Q'), 's,a,b,;2a\\\nQ');
		assert.strictEqual(f('r file;a\\x\np'), 'r file;a\\x\np', 'the rest of the line is the file name');
		assert.strictEqual(f('w out;a\\x'), 'w out;a\\x');
		assert.strictEqual(f(':a;N;$!ba;s/\\n/ /g'), ':a;N;$!ba;s/\\n/ /g');
		assert.strictEqual(f('# 1a\\x\n$a\\z'), '# 1a\\x\n$a\\\nz', 'a comment');
		assert.strictEqual(f('1a\\one\\\ntwo'), '1a\\\none\\\ntwo', 'a continued text is left as it is');
		// bare forms and nothing to do
		assert.strictEqual(f('$a\\'), '$a\\');
		assert.strictEqual(f('p'), 'p');
		assert.strictEqual(f(''), '');
		// time: the regular expression this replaces took seconds for 4000 spaces
		const t0 = Date.now();
		assert.strictEqual(f(';' + ' '.repeat(60000) + 'x\\').length, 60003);
		f(';' + ' '.repeat(60000) + 'a\\text');
		f('1' + ',1'.repeat(20000) + 'a\\x');
		f('s/' + 'a\\/'.repeat(20000) + '/b/');
		assert.ok(Date.now() - t0 < 500, 'took ' + (Date.now() - t0) + ' ms');
		assert.strictEqual(f(';' + ' '.repeat(100000) + 'a\\x').length, 100004, 'a script that is not a one-liner is left alone');
	});

	test('du: disk usage in 1 KiB blocks of a file system with 4 KiB blocks, -s -h -k -m -b -a -c -d -B, the way GNU sorts out the same file twice', async () => {
		const tree = {
			'/w': { dir: true }, '/w/d': { dir: true }, '/w/d/a': { size: 6 }, '/w/d/sub': { dir: true }, '/w/d/sub/big': { size: 5000 }, '/w/d/e': { size: 0 }, '/w/f': { size: 4097 },
		};
		const io = (cwd = '/w') => ({
			cwd,
			resolve: (b, p) => (p.startsWith('/') ? p : (b === '/' ? '' : b) + '/' + p).replace(/\/\.$/, '').replace(/\/$/, '') || '/',
			stat: async (p) => { const n = tree[p]; return n ? { isFile: !n.dir, isDirectory: !!n.dir, size: n.size || 0 } : null; },
			readdir: async (p) => Object.keys(tree).filter((k) => k !== p && k.startsWith(p + '/') && !k.slice(p.length + 1).includes('/')).map((k) => k.slice(p.length + 1)).sort(),
		});
		const du = (args) => c.du(args, io());
		assert.deepStrictEqual(await du(['d']), { stdout: '12\td/sub\n20\td\n', stderr: '', exitCode: 0 });
		assert.strictEqual((await du(['-s', 'd'])).stdout, '20\td\n');
		assert.strictEqual((await du(['-sk', 'd'])).stdout, '20\td\n');
		assert.strictEqual((await du(['-sh', 'd'])).stdout, '20K\td\n');
		assert.strictEqual((await du(['-sh', 'f'])).stdout, '8.0K\tf\n');
		assert.strictEqual((await du(['-s', 'f'])).stdout, '8\tf\n');
		assert.strictEqual((await du(['-sb', 'f'])).stdout, '4097\tf\n');
		assert.strictEqual((await du(['-b', 'd'])).stdout, '9096\td/sub\n13198\td\n');
		assert.strictEqual((await du(['-sm', 'd'])).stdout, '1\td\n');
		assert.strictEqual((await du(['-a', 'd'])).stdout, '4\td/a\n0\td/e\n8\td/sub/big\n12\td/sub\n20\td\n');
		assert.strictEqual((await du(['-d0', 'd'])).stdout, '20\td\n');
		assert.strictEqual((await du(['--max-depth=1', 'd'])).stdout, '12\td/sub\n20\td\n');
		assert.strictEqual((await du(['-c', 'd', 'f'])).stdout, '12\td/sub\n20\td\n8\tf\n28\ttotal\n');
		assert.strictEqual((await du(['-c', 'd', 'd/sub'])).stdout, '12\td/sub\n20\td\n20\ttotal\n', 'a folder inside the first operand is not counted twice');
		assert.strictEqual((await du(['-sh', 'd', 'f'])).stdout, '20K\td\n8.0K\tf\n');
		assert.strictEqual((await du(['-h', '-B1', '-s', 'f'])).stdout, '8192\tf\n', 'the last of -h and a block size wins');
		assert.strictEqual((await du(['-k', '-h', '-s', 'f'])).stdout, '8.0K\tf\n');
		assert.strictEqual((await du(['-k', '-m', '-s', 'd'])).stdout, '1\td\n');
		assert.strictEqual((await du(['-m', '-k', '-s', 'd'])).stdout, '20\td\n');
		assert.strictEqual((await du(['-B', '1K', '-s', 'd'])).stdout, '20\td\n');
		assert.strictEqual((await du(['-BM', '-s', 'd'])).stdout, '1\td\n');
		assert.strictEqual((await du(['--block-size=4096', '-s', 'd'])).stdout, '5\td\n');
		assert.strictEqual((await du(['--si', '-s', 'd'])).stdout, '21k\td\n');
		assert.strictEqual((await du(['nope', 'f'])).exitCode, 1);
		assert.strictEqual((await du(['nope', 'f'])).stdout, '8\tf\n');
		assert.strictEqual((await du(['nope'])).stderr, "du: cannot access 'nope': No such file or directory\n");
		assert.strictEqual((await du(['-q'])).stderr, "du: invalid option -- 'q'\n");
		assert.strictEqual((await du(['--bogus'])).stderr, "du: unrecognized option '--bogus'\n");
		assert.strictEqual((await du(['-d', 'x', 'd'])).stderr, "du: invalid maximum depth 'x'\n");
		assert.strictEqual((await du([])).stdout, '12\t./d/sub\n20\t./d\n32\t.\n');
		// the units
		assert.deepStrictEqual([0, 1, 1023, 1024, 1025, 4096, 10239, 10240, 1048576, 1572864, 1073741824].map((n) => c.humanSize(n)), ['0', '1', '1023', '1.0K', '1.1K', '4.0K', '10K', '10K', '1.0M', '1.5M', '1.0G']);
		assert.deepStrictEqual([999, 1000, 1500, 24576, 3000000, 3002368].map((n) => c.humanSize(n, 1000)), ['999', '1.0k', '1.5k', '25k', '3.0M', '3.1M']);
		assert.deepStrictEqual(['1', '1K', '1KB', '1KiB', '4M', 'MB', 'x', '', '0', 'K1'].map((s) => c.parseBlockSize(s)), [1, 1024, 1000, 1024, 4194304, 1000000, null, null, null, null]);
	});

	test('cp and mv say what GNU says: a destination folder that is not there, a directory onto a file, onto a full directory, into itself', async () => {
		const g = c.gnuTransferErrors;
		assert.strictEqual(g("mv: cannot move 'd1': ENOTEMPTY: directory not empty, mv '/w/dst/d1'", 'mv', '/w'), "mv: cannot move 'd1' to 'dst/d1': Directory not empty");
		assert.strictEqual(g("mv: cannot move 'e': ENOTDIR: cannot overwrite non-directory with directory, cp '/w/a.txt'", 'mv', '/w'), "mv: cannot overwrite non-directory 'a.txt' with directory 'e'");
		assert.strictEqual(g("cp: cannot copy 'e': ENOTDIR: cannot overwrite non-directory with directory, cp '/w/a.txt'", 'cp', '/w'), "cp: cannot overwrite non-directory 'a.txt' with directory 'e'");
		assert.strictEqual(g("mv: cannot move 'a': EISDIR: cannot overwrite directory with non-directory, cp '/w/dst/a'", 'mv', '/w'), "mv: cannot overwrite directory 'dst/a' with non-directory");
		assert.strictEqual(g("mv: cannot move 'd': EINVAL: cannot move a directory into itself, mv '/w/d/e'", 'mv', '/w'), "mv: cannot move 'd' to a subdirectory of itself, 'd/e'");
		assert.strictEqual(g("cp: cannot copy 'd': EINVAL: cannot copy a directory into itself, cp '/w/d/e'", 'cp', '/w'), "cp: cannot copy a directory, 'd', into itself, 'd/e'");
		assert.strictEqual(g("mv: cannot move 's' into itself, '/w/s/t/s'", 'mv', '/w'), "mv: cannot move 's' to a subdirectory of itself, 's/t/s'", 'the engine\'s own check, before the file system is asked');
		assert.strictEqual(g("cp: cannot copy 's' into itself, '/w/s/t/s'", 'cp', '/w'), "cp: cannot copy a directory, 's', into itself, 's/t/s'");
		assert.strictEqual(g("cp: cannot stat 'x': No such file or directory", 'cp', '/w'), "cp: cannot stat 'x': No such file or directory");
		const h = await host({ '/w/a.txt': 'a\n', '/w/d1/f': 'new\n', '/w/dst/d1/f': 'OLD\n', '/w/emptyd': null, '/w/dst/emptyd': null });
		const run = async (script) => (await h.run(script)).stdout;
		assert.strictEqual(await run('cp a.txt nodir/x 2>&1; echo "rc=$?"'), "cp: cannot create regular file 'nodir/x': No such file or directory\nrc=1\n");
		assert.strictEqual(await run('mv a.txt nodir/x 2>&1; echo "rc=$?"'), "mv: cannot move 'a.txt' to 'nodir/x': No such file or directory\nrc=1\n");
		assert.strictEqual(await run('cp -r d1 nodir/y 2>&1; echo "rc=$?"'), "cp: cannot create directory 'nodir/y': No such file or directory\nrc=1\n");
		// GNU says "failed to access" when a FILE is on the way (the first expectation here, "cannot create regular file",
		// was a guess that the reference run of the third round contradicts); "cannot create" is for a folder that is not there
		assert.strictEqual(await run('cp a.txt a.txt/x 2>&1; echo "rc=$?"'), "cp: failed to access 'a.txt/x': Not a directory\nrc=1\n");
		assert.strictEqual(await run('cp nope nodir/x 2>&1; echo "rc=$?"'), "cp: cannot stat 'nope': No such file or directory\nrc=1\n");
		assert.strictEqual(await run('echo b > b.txt; cp a.txt b.txt nodir/x 2>&1; echo "rc=$?"; rm b.txt'), "cp: target 'nodir/x' is not a directory\nrc=1\n", 'two sources: the engine\'s message, not the one for a single source');
		assert.strictEqual(await run('cp a.txt nodir/x zzz 2>&1; echo "rc=$?"'), "cp: target 'zzz' is not a directory\nrc=1\n", 'the destination is the LAST operand');
		assert.strictEqual(await run('mv d1 dst 2>&1; echo "rc=$?"; cat dst/d1/f; ls d1'), "mv: cannot move 'd1' to 'dst/d1': Directory not empty\nrc=1\nOLD\nf\n");
		assert.strictEqual(await run('mv emptyd dst 2>&1; echo "rc=$?"; ls'), 'rc=0\na.txt\nd1\ndst\n');
		assert.strictEqual(await run('mkdir e; mv e a.txt 2>&1; echo "rc=$?"; cp -r e a.txt 2>&1; echo "rc=$?"'), "mv: cannot overwrite non-directory 'a.txt' with directory 'e'\nrc=1\ncp: cannot overwrite non-directory 'a.txt' with directory 'e'\nrc=1\n");
		assert.strictEqual(await run('mkdir -p t/a; mv a.txt t 2>&1; echo "rc=$?"; ls t'), 'rc=0\na\na.txt\n');
		assert.strictEqual(await run('echo b > b.txt; mkdir -p u/b.txt; mv b.txt u 2>&1; echo "rc=$?"'), "mv: cannot overwrite directory 'u/b.txt' with non-directory\nrc=1\n");
		assert.strictEqual(await run('mkdir -p s/t; mv s s/t 2>&1; echo "rc=$?"'), "mv: cannot move 's' to a subdirectory of itself, 's/t/s'\nrc=1\n");
		assert.strictEqual(await run('cp -r s s/t 2>&1; echo "rc=$?"'), "cp: cannot copy a directory, 's', into itself, 's/t/s'\nrc=1\n");
	});

	test('touch -t reads its clock in the zone of the command (UTC by default), with GNU\'s two-digit-year pivot; stat prints in that zone', () => {
		const ms = (y, mo, d, h, mi, s) => Date.UTC(y, mo - 1, d, h, mi, s);
		assert.strictEqual(c.parseTouch(['-t', '202001020304.05', 'f']).time, ms(2020, 1, 2, 3, 4, 5));
		assert.strictEqual(c.parseTouch(['-t', '202001020304.05', 'f'], 'Asia/Tokyo').time, ms(2020, 1, 1, 18, 4, 5));
		assert.strictEqual(c.parseTouch(['-t', '202006150304', 'f'], 'America/New_York').time, ms(2020, 6, 15, 7, 4, 0), 'daylight saving time');
		assert.strictEqual(c.parseTouch(['-t', '6901020304', 'f']).time, ms(1969, 1, 2, 3, 4, 0), '69 is 1969');
		assert.strictEqual(c.parseTouch(['-t', '6801020304', 'f']).time, ms(2068, 1, 2, 3, 4, 0), '68 is 2068');
		assert.strictEqual(c.parseTouch(['-t', '0001020304', 'f']).time, ms(2000, 1, 2, 3, 4, 0));
		assert.strictEqual(c.parseTouch(['-t', '01020304', 'f']).time, ms(new Date().getUTCFullYear(), 1, 2, 3, 4, 0), 'the year is this one');
		assert.strictEqual(c.parseTouch(['-t', '1', 'f']).time, null, 'not a stamp: it is said, as GNU says it');
		assert.strictEqual(c.parseTouch(['-t', '1', 'f']).invalidStamp, '1');
		assert.strictEqual(c.statTimeFormat('%y', ms(2020, 1, 2, 3, 4, 5) + 7), '2020-01-02 03:04:05.007000000 +0000');
		assert.strictEqual(c.statTimeFormat('%y', ms(2020, 1, 2, 3, 4, 5), 'Asia/Tokyo'), '2020-01-02 12:04:05.000000000 +0900');
		assert.strictEqual(c.statTimeFormat('%y', ms(2020, 6, 1, 12, 0, 0), 'America/New_York'), '2020-06-01 08:00:00.000000000 -0400');
		assert.strictEqual(c.statTimeFormat('%y', ms(2020, 6, 1, 12, 0, 0), 'Asia/Kolkata'), '2020-06-01 17:30:00.000000000 +0530');
		assert.strictEqual(c.statTimeFormat('%Y|%X|%W|%w|%%', 1588748889123), '1588748889|1588748889|0|-|%%');
		assert.strictEqual(c.statTimeFormat('%y', -1500), '1969-12-31 23:59:58.500000000 +0000');
	});

	test('mkdir -m with four digits, id -G, head -z, tr \'\\0\', awk -f with several files, uname -a, stat %W: the one-line cases that were not pinned', async () => {
		const h = await host({ '/w/p1.awk': 'BEGIN { x = 1 } # the first file ends in a comment', '/w/p2.awk': '{ print x, $1 }' });
		const out = async (script) => (await h.run(script)).stdout;
		assert.strictEqual(await out('mkdir -m 1755 d; stat -c %a d; mkdir -m 0700 e; stat -c %a e; mkdir -m 4 g 2>&1; echo "rc=$?"'), '1755\n700\nrc=0\n'.replace('rc=0', 'rc=0'));
		assert.strictEqual(await out('mkdir -m 7777 h; stat -c %a h'), '7777\n');
		assert.strictEqual(await out('id -G; id -Gn; id -g; id -gn; id -u -n; id -un'), '1000\nuser\n1000\nuser\nuser\nuser\n');
		assert.strictEqual(await out("printf 'a\\0b\\0c\\0' | head -z -n 2 | od -An -c | tr -s ' '"), ' a \\0 b \\0\n');
		assert.strictEqual(await out("printf 'a\\0b\\0c\\0' | head -z -n -1 | od -An -c | tr -s ' '"), ' a \\0 b \\0\n');
		assert.strictEqual(await out("printf 'a\\0b' | tr '\\000' '\\n' | od -An -c | tr -s ' '"), ' a \\n b\n');
		assert.strictEqual(await out("printf 'a\\0b' | tr -d '\\000' | od -An -c | tr -s ' '"), ' a b\n');
		assert.strictEqual(await out("printf 'a\\0b' | tr '\\0' x"), 'axb');
		assert.strictEqual(await out("echo 'q w' | awk -f p1.awk -f p2.awk"), '1 q\n');
		assert.strictEqual(await out('uname -a'), 'Linux localhost 5.15.0 #1 SMP x86_64 x86_64 x86_64 GNU/Linux\n');
		assert.strictEqual(await out('uname -srm'), 'Linux 5.15.0 x86_64\n');
		assert.strictEqual(await out("echo a > f; stat -c '%W %w' f"), '0 -\n');
		assert.strictEqual(await out("echo a > f; stat -c '%Y' f | grep -c '^[0-9]*$'"), '1\n');
	});

	test('a doubled program name in a limit message is taken off once, and only when it is doubled', () => {
		assert.deepStrictEqual(c.withoutDoubledPrefix({ stderr: 'sed: sed: command execution exceeded maximum iterations (5)\n', exitCode: 126 }, 'sed'), { stderr: 'sed: command execution exceeded maximum iterations (5)\n', exitCode: 126 });
		assert.deepStrictEqual(c.withoutDoubledPrefix({ stderr: 'awk: awk: x\nawk: awk: y\n' }, 'awk'), { stderr: 'awk: x\nawk: y\n' });
		const fine = { stderr: 'sed: -e expression #1: unknown command\n' };
		assert.strictEqual(c.withoutDoubledPrefix(fine, 'sed'), fine);
		assert.deepStrictEqual(c.withoutDoubledPrefix({ stderr: 'sed: awk: z\n' }, 'sed'), { stderr: 'sed: awk: z\n' });
		assert.deepStrictEqual(c.withoutDoubledPrefix({ stdout: 'x' }, 'sed'), { stdout: 'x' });
	});

	/* ------------------------------------------------------------------------------------------ the third round */

	test('cp and mv onto `name/` that does not exist: a directory source is copied or renamed to it; only a file cannot be (the commonest way to write either, which the first fix of this broke)', async () => {
		const variants = ['cp -r d d2/', 'cp -r d/ d2/', 'cp -R d d2/', 'cp -a d d2/', 'cp -rT d d2/', 'cp -rv d d2/', 'cp -r d ex/n/', 'mv d d2/', 'mv d/ d2/', 'mv d d2//', 'mv -v d d2/', 'cp -ru d d2/', 'mv -u d d2/'];
		for (const v of variants) {
			const h = await host({ '/w/d/f': 'one\n', '/w/d/h': 'two\n', '/w/ex': null });
			const r = await h.run(`${v}; echo "rc=$?"`);
			assert.strictEqual(r.exitCode, 0, v);
			assert.ok(/(^|\n)rc=0\n$/.test(r.stdout), v + ' -> ' + r.stdout);
			assert.strictEqual(r.stderr, '', v);
			const made = v.includes('ex/n') ? '/w/ex/n' : '/w/d2';
			assert.strictEqual(h.tree.text(made + '/f'), 'one\n', v);
			assert.strictEqual(h.tree.text(made + '/h'), 'two\n', v);
			assert.strictEqual(h.tree.nodes.has('/w/d/f'), v.startsWith('cp'), v + ': a copy keeps the source, a move does not');
		}
		// a directory without -r is still "omitting directory", not "not a directory"
		const noR = await sh('cp d d2/ 2>&1; echo "rc=$?"', { '/w/d/f': 'x' });
		assert.strictEqual(noR.stdout, "cp: -r not specified; omitting directory 'd'\nrc=1\n");
		// a FILE onto a name that ends in a slash: GNU's words, status 1, nothing made
		const f = await sh('cp a.txt n/ 2>&1; echo "rc=$?"; mv a.txt n/ 2>&1; echo "rc=$?"; cp a.txt nodir/n/ 2>&1; echo "rc=$?"; ls', { '/w/a.txt': 'a\n' });
		assert.strictEqual(f.stdout, "cp: cannot create regular file 'n/': Not a directory\nrc=1\nmv: cannot move 'a.txt' to 'n/': Not a directory\nrc=1\ncp: cannot create regular file 'nodir/n/': No such file or directory\nrc=1\na.txt\n");
		// a file on the way: "failed to access", for a file and for a directory, with and without the slash
		const w = await sh("cp a b.txt/x/y 2>&1; mv a b.txt/x/y 2>&1; cp -r d b.txt/x/y 2>&1; cp -r d b.txt/x/y/ 2>&1; cp a b.txt/ 2>&1; mv a b.txt/ 2>&1; echo \"rc=$?\"; cat a b.txt", { '/w/a': 'a\n', '/w/b.txt': 'b\n', '/w/d': null });
		assert.strictEqual(w.stdout, "cp: failed to access 'b.txt/x/y': Not a directory\nmv: failed to access 'b.txt/x/y': Not a directory\ncp: failed to access 'b.txt/x/y': Not a directory\ncp: failed to access 'b.txt/x/y/': Not a directory\ncp: failed to access 'b.txt/': Not a directory\nmv: failed to access 'b.txt/': Not a directory\nrc=1\na\nb\n");
	});

	test('cp and mv: a source written with a slash that is a file is "cannot stat", the other sources go on; a file onto itself is "the same file" (status 1, -n makes it nothing)', async () => {
		const h = await host({ '/w/a': 'a\n', '/w/b': 'b\n', '/w/t': null });
		const r = await h.run('cp a/ b t 2>&1; echo "rc=$?"; ls t; mv a/ x 2>&1; echo "rc=$?"; mv a a 2>&1; echo "rc=$?"; mv a ./a 2>&1; echo "rc=$?"; mv -n a a; echo "rc=$?"; mv a . 2>&1; echo "rc=$?"; cp a a 2>&1; echo "rc=$?"; cp -n a a; echo "rc=$?"; mkdir d; mv d d 2>&1; echo "rc=$?"; mv d/ d 2>&1; echo "rc=$?"; cat a');
		assert.strictEqual(r.stdout, [
			"cp: cannot stat 'a/': Not a directory", 'rc=1', 'b',
			"mv: cannot stat 'a/': Not a directory", 'rc=1',
			"mv: 'a' and 'a' are the same file", 'rc=1',
			"mv: 'a' and './a' are the same file", 'rc=1',
			'rc=0',
			"mv: 'a' and './a' are the same file", 'rc=1',
			"cp: 'a' and 'a' are the same file", 'rc=1',
			'rc=0',
			"mv: cannot move 'd' to a subdirectory of itself, 'd/d'", 'rc=1',
			"mv: cannot move 'd/' to a subdirectory of itself, 'd/d'", 'rc=1',
			'a', '',
		].join('\n'));
	});

	test('cp -T and mv -T: the destination is the target itself, never a folder to go into', async () => {
		const files = { '/w/d/f': '1\n', '/w/e/g': '2\n', '/w/a': 'A\n', '/w/b': 'B\n', '/w/c': null };
		const tree = ' . ./a ./b ./c ./d ./d/f ./e ./e/g';
		const one = async (script) => (await sh(script + '; echo "rc=$?"; find . | sort | tr "\\n" " "', files)).stdout;
		assert.strictEqual(await one('cp -rT d e'), 'rc=0\n. ./a ./b ./c ./d ./d/f ./e ./e/f ./e/g ');
		assert.strictEqual(await one('cp -r --no-target-directory d e'), 'rc=0\n. ./a ./b ./c ./d ./d/f ./e ./e/f ./e/g ');
		assert.strictEqual(await one('cp -rT d n'), 'rc=0\n. ./a ./b ./c ./d ./d/f ./e ./e/g ./n ./n/f ');
		assert.strictEqual(await one('cp -ruT d e'), 'rc=0\n. ./a ./b ./c ./d ./d/f ./e ./e/f ./e/g ', 'with -u as well');
		assert.strictEqual(await one('cp -ru d e'), 'rc=0\n. ./a ./b ./c ./d ./d/f ./e ./e/d ./e/d/f ./e/g ', 'and without -T it goes into the folder');
		assert.strictEqual(await one('cp -T a b; cat b'), 'A\nrc=0\n' + tree.slice(1) + ' ');
		assert.strictEqual(await one('cp -T a c 2>&1'), "cp: cannot overwrite directory 'c' with non-directory\nrc=1\n" + tree.slice(1) + ' ');
		assert.strictEqual(await one('cp -T a b c 2>&1'), "cp: extra operand 'c'\nTry 'cp --help' for more information.\nrc=1\n" + tree.slice(1) + ' ');
		assert.strictEqual(await one('cp -T d e 2>&1'), "cp: -r not specified; omitting directory 'd'\nrc=1\n" + tree.slice(1) + ' ');
		assert.strictEqual(await one('mv -T d c'), 'rc=0\n. ./a ./b ./c ./c/f ./e ./e/g ');
		assert.strictEqual(await one('mv -T d e 2>&1'), "mv: cannot move 'd' to 'e': Directory not empty\nrc=1\n" + tree.slice(1) + ' ');
		assert.strictEqual(await one('mv -T a c 2>&1'), "mv: cannot overwrite directory 'c' with non-directory\nrc=1\n" + tree.slice(1) + ' ');
		assert.strictEqual(await one('mv -vT d c'), "renamed 'd' -> 'c'\nrc=0\n. ./a ./b ./c ./c/f ./e ./e/g ");
		assert.strictEqual(await one('mv -T a b; cat b'), 'A\nrc=0\n. ./b ./c ./d ./d/f ./e ./e/g ');
		assert.strictEqual(c.wantsNoTargetDirectory(['-rT', 'a', 'b']), true);
		assert.strictEqual(c.wantsNoTargetDirectory(['--no-target-directory', 'a', 'b']), true);
		assert.strictEqual(c.wantsNoTargetDirectory(['-t', 'T', 'a']), false, 'the value of -t is not an option');
		assert.strictEqual(c.wantsNoTargetDirectory(['-tT', 'a']), false, 'nor is the value attached to it');
		assert.strictEqual(c.wantsNoTargetDirectory(['-rtT', 'a']), false);
		assert.strictEqual(c.wantsNoTargetDirectory(['-rT', '-t', 'x', 'a']), true);
		assert.strictEqual(c.wantsNoTargetDirectory(['a', '--', '-T']), false);
	});

	test('cp -rv lists every file it copies; mkdir -pv every folder it makes', async () => {
		const files = { '/w/d/f': '1\n', '/w/d/s/g': '2\n' };
		const r = await sh('cp -rv d e | sort; cp -av d x/ 2>&1 | sort; mkdir -pv p/q/r p/q/s; mkdir -v u; mkdir -pv p/q/t', files);
		assert.strictEqual(r.stdout, [
			"'d' -> 'e'", "'d/f' -> 'e/f'", "'d/s' -> 'e/s'", "'d/s/g' -> 'e/s/g'",
			"'d' -> 'x/'", "'d/f' -> 'x/f'", "'d/s' -> 'x/s'", "'d/s/g' -> 'x/s/g'",
			"mkdir: created directory 'p'", "mkdir: created directory 'p/q'", "mkdir: created directory 'p/q/r'", "mkdir: created directory 'p/q/s'",
			"mkdir: created directory 'u'", "mkdir: created directory 'p/q/t'", '',
		].join('\n'));
	});

	test('touch -r REF takes the time of REF (the engine ignored it); a reference that is not there is an error and nothing is made', async () => {
		const r = await sh("touch -d '@86400' a; touch -r a b; touch --reference=a c; touch --reference a d; touch -ra e; stat -c '%n %Y' b c d e; touch -r nofile f 2>&1; echo \"rc=$?\"; ls f 2>&1 | head -1; echo x > g; touch -d @5 h; touch -r h g; stat -c %Y g; cat g; touch -c -r a nothere; ls nothere 2>&1 | head -1; touch -t 202001020304 -r a i 2>&1 | head -1; ls i 2>&1 | head -1");
		// -t with -r is GNU's "cannot specify times from more than one source" and nothing is touched (the engine's
		// first fix combined them: an expectation that was wrong)
		assert.strictEqual(r.stdout, "b 86400\nc 86400\nd 86400\ne 86400\ntouch: failed to get attributes of 'nofile': No such file or directory\nrc=1\nls: cannot access 'f': No such file or directory\n5\nx\nls: cannot access 'nothere': No such file or directory\ntouch: cannot specify times from more than one source\nls: cannot access 'i': No such file or directory\n");
	});

	test('tail -c +N starts at byte N (the engine printed the last N bytes), -c -N is -c N, and the other forms are the engine\'s', async () => {
		assert.deepStrictEqual(c.parseTailFrom(['-c', '+3', 'f']), { from: 3, quiet: false, verbose: false, files: ['f'] });
		assert.deepStrictEqual(c.parseTailFrom(['-qc+2', 'f', 'g']), { from: 2, quiet: true, verbose: false, files: ['f', 'g'] });
		assert.deepStrictEqual(c.parseTailFrom(['--bytes=+1', '-v', 'f']), { from: 1, quiet: false, verbose: true, files: ['f'] });
		assert.strictEqual(c.parseTailFrom(['-c', '3', 'f']), null);
		assert.strictEqual(c.parseTailFrom(['-n', '+3', 'f']), null);
		assert.strictEqual(c.parseTailFrom(['-n', '2', '-c', '+3']), null, 'a line count with it: the engine\'s');
		const r = await sh("printf 'abcdef' | tail -c +1; echo; printf 'abcdef' | tail -c +3; echo; printf 'abcdef' | tail -c +7; echo '|'; printf 'abcdef' > f; printf 'xyz' > g; tail -c +2 f g; echo; tail -qc +2 f g; echo; printf 'abcdef' | tail -c -2; echo; printf 'abcdef' | tail -c2; echo; seq 1 5 | tail -n -2; seq 1 5 | tail -n +4; printf '//4=' | base64 -d | tail -c +2 | od -An -tx1");
		assert.strictEqual(r.stdout, 'abcdef\ncdef\n|\n==> f <==\nbcdef\n==> g <==\nyz\nbcdefyz\nef\nef\n4\n5\n4\n5\n fe\n');
	});

	test('xargs: items, lines and quotes as GNU reads them; -I, -L, -n, -E, -a, -d, -0; its status codes', async () => {
		// the parser of the options: every form, the warnings for options that exclude each other, the errors in GNU's words
		const p = (...a) => c.parseXargs(a);
		const o = (...a) => /** @type {any} */ (p(...a)).opts;
		assert.deepStrictEqual(p('-I{}', 'echo', '{}'), { opts: { nul: false, delim: null, replace: '{}', eof: null, maxLines: null, maxArgs: null, maxChars: null, exitIfExceeded: false, prompt: false, openTty: false, verbose: false, noRun: false, argFile: null }, command: ['echo', '{}'], warnings: [] });
		assert.strictEqual(o('-I', '@', 'x').replace, '@');
		assert.strictEqual(o('-i', 'x').replace, '{}');
		assert.strictEqual(o('-iX', 'x').replace, 'X');
		assert.strictEqual(o('--replace', 'x').replace, '{}');
		assert.strictEqual(o('--replace=%', 'x').replace, '%');
		assert.strictEqual(o('-L', '2', 'x').maxLines, 2);
		assert.strictEqual(o('-l', 'x').maxLines, 1);
		assert.strictEqual(o('-l3', 'x').maxLines, 3);
		assert.strictEqual(o('--max-lines=4', 'x').maxLines, 4);
		assert.strictEqual(o('-n', '5', 'x').maxArgs, 5);
		assert.strictEqual(o('-n5', 'x').maxArgs, 5);
		assert.strictEqual(o('--max-args=6', 'x').maxArgs, 6);
		assert.strictEqual(o('-E', 'END', 'x').eof, 'END');
		assert.strictEqual(o('-E', '', 'x').eof, null);
		assert.strictEqual(o('-e', 'x').eof, null);
		assert.strictEqual(o('-0rt', 'x').nul, true);
		assert.strictEqual(o('-0rt', 'x').noRun, true);
		assert.strictEqual(o('-0rt', 'x').verbose, true);
		assert.strictEqual(o('-d', ',', 'x').delim, ',');
		assert.strictEqual(o('-d', '\\n', 'x').delim, '\n');
		assert.strictEqual(o('-d', '\\t', 'x').delim, '\t');
		assert.strictEqual(o('-a', 'f', 'x').argFile, 'f');
		assert.strictEqual(o('--arg-file=f', 'x').argFile, 'f');
		assert.deepStrictEqual(/** @type {any} */ (p('-P4', '-s', '100', '-x', 'echo')).command, ['echo']);
		assert.deepStrictEqual(/** @type {any} */ (p('--', '-n', 'x')).command, ['-n', 'x'], 'the command starts at the first operand');
		assert.deepStrictEqual(/** @type {any} */ (p('echo', '-n')).command, ['echo', '-n']);
		assert.strictEqual(p('--bogus', 'x'), null, 'an option it does not know is the engine\'s to answer');
		assert.strictEqual(p('-z', 'x'), null);
		assert.deepStrictEqual(p('-n0', 'x'), { error: "xargs: value 0 for -n option should be >= 1\nTry 'xargs --help' for more information.\n" });
		assert.deepStrictEqual(p('-n', 'x', 'y'), { error: "xargs: invalid number \"x\" for -n option\nTry 'xargs --help' for more information.\n" });
		assert.deepStrictEqual(p('-L0', 'x'), { error: "xargs: value 0 for -L option should be >= 1\nTry 'xargs --help' for more information.\n" });
		assert.deepStrictEqual(p('-d', '', 'x'), { error: 'xargs: Invalid input delimiter specification : the delimiter must be either a single character or an escape sequence starting with \\.\n' });
		assert.deepStrictEqual(/** @type {any} */ (p('-I{}', '-L1', 'echo')).warnings, ['xargs: warning: options --replace and -L are mutually exclusive, ignoring previous --replace value\n']);
		assert.deepStrictEqual(/** @type {any} */ (p('-n1', '-L1', 'echo')).warnings, ['xargs: warning: options --max-args and -L are mutually exclusive, ignoring previous --max-args value\n']);
		assert.deepStrictEqual(/** @type {any} */ (p('-L1', '-n1', 'echo')).warnings, ['xargs: warning: options --max-lines and --max-args/-n are mutually exclusive, ignoring previous --max-lines value\n']);
		// the input
		const items = (input, opts) => c.xargsInput(input, Object.assign({ nul: false, delim: null, replace: null, eof: null }, opts)).lines.map((l) => [...l]);
		assert.deepStrictEqual(items('a b\nc\n\nd\n'), [['a', 'b'], ['c'], ['d']]);
		assert.deepStrictEqual(items('"a b" c \'d e\' f\\ g\n'), [['a b', 'c', 'd e', 'f g']]);
		assert.deepStrictEqual(items('a\\\nb\n'), [['a\nb']]);
		assert.deepStrictEqual(items('a\tb\n'), [['a', 'b']]);
		assert.deepStrictEqual(items('""\n'), [['']], 'an empty quoted string is an item');
		assert.deepStrictEqual(items('  a b  \n\n c\n', { replace: '{}' }), [['a b  '], ['c']]);
		assert.deepStrictEqual(items('"a b" c\n', { replace: '{}' }), [['a b c']]);
		assert.deepStrictEqual(items('a b\0c\0', { nul: true }), [['a b'], ['c']]);
		assert.deepStrictEqual(items('a\0\0b\0', { nul: true }), [['a'], [''], ['b']]);
		assert.deepStrictEqual(items('a b,c d,e', { delim: ',' }), [['a b'], ['c d'], ['e']]);
		assert.deepStrictEqual(items('a b\nc d\n', { delim: '\n' }), [['a b'], ['c d']]);
		assert.deepStrictEqual(items('a\nSTOP\nb\n', { eof: 'STOP' }), [['a']]);
		assert.deepStrictEqual(items('a b STOP c\nd\n', { eof: 'STOP' }), [['a', 'b']]);
		const bad = c.xargsInput("a 'b\nc\n", { nul: false, delim: null, replace: null, eof: null });
		assert.deepStrictEqual(bad.lines.map((l) => [...l]), [['a']]);
		assert.strictEqual(bad.error, 'xargs: unmatched single quote; by default quotes are special to xargs unless you use the -0 option\n');
		assert.ok(/unmatched double quote/.test(c.xargsInput('"a\n', { nul: false, delim: null, replace: null, eof: null }).error || ''));
		// the batches
		const lines = (...ls) => ls.map((l) => Object.assign(l.words, { continued: !!l.cont }));
		// with -I the command has a word to put the item in (`x {}`); without, the command is nothing and a run is its items
		const batches = (ls, o) => c.xargsPlan(lines(...ls), Object.assign({ replace: null, maxLines: null, maxArgs: null, noRun: true }, o), o && o.replace ? ['x', '{}'] : []).map((e) => /** @type {any} */ (e).argv);
		assert.deepStrictEqual(batches([{ words: ['a', 'b'] }, { words: ['c'] }], {}), [['a', 'b', 'c']]);
		assert.deepStrictEqual(batches([{ words: ['a', 'b'] }, { words: ['c'] }], { maxArgs: 2 }), [['a', 'b'], ['c']]);
		assert.deepStrictEqual(batches([{ words: ['a', 'b'] }, { words: ['c'] }], { maxLines: 1 }), [['a', 'b'], ['c']]);
		assert.deepStrictEqual(batches([{ words: ['a'] }, { words: ['b'] }, { words: ['c'] }], { maxLines: 2 }), [['a', 'b'], ['c']]);
		assert.deepStrictEqual(batches([{ words: ['a'], cont: true }, { words: ['b'] }, { words: ['c'] }], { maxLines: 1 }), [['a', 'b'], ['c']], 'a line that ends in a blank continues');
		assert.deepStrictEqual(batches([{ words: ['a b'] }, { words: ['c'] }], { replace: '{}' }), [['x', 'a b'], ['x', 'c']]);
		assert.deepStrictEqual(batches([], {}), []);
		assert.strictEqual(c.xargsQuote('a'), 'a');
		assert.strictEqual(c.xargsQuote('a b'), "'a b'");
		assert.strictEqual(c.xargsQuote("it's"), '"it\'s"');
		assert.strictEqual(c.xargsQuote('x=y'), "'x=y'");
		assert.strictEqual(c.xargsQuote(''), "''");
		// through the shell
		const files = { '/w/f s.txt': 'a\n', '/w/g.txt': 'b\n', '/w/in': 'x y\nz\n' };
		const run = async (script) => (await sh(script, files)).stdout;
		assert.strictEqual(await run("ls | xargs -I{} echo file:{}"), 'file:f s.txt\nfile:g.txt\nfile:in\n');
		assert.strictEqual(await run("ls | xargs -L 1 echo"), 'f s.txt\ng.txt\nin\n');
		assert.strictEqual(await run("printf 'a b\\nc d\\ne\\n' | xargs -L 2 echo"), 'a b c d\ne\n');
		assert.strictEqual(await run("printf '\"a b\" c\\n' | xargs -n1 echo"), 'a b\nc\n');
		assert.strictEqual(await run("xargs -a in -n1 echo; xargs --arg-file=in echo"), 'x\ny\nz\nx y z\n');
		assert.strictEqual(await run("xargs -a nofile echo 2>&1; echo \"rc=$?\""), "xargs: Cannot open input file 'nofile': No such file or directory\nrc=1\n");
		assert.strictEqual(await run("printf 'a\\nb\\n' | xargs -n1 sh -c 'exit 3' _; echo \"rc=$?\""), 'rc=123\n');
		assert.strictEqual(await run("printf 'a\\n' | xargs nosuchcmd 2>&1; echo \"rc=$?\""), 'xargs: nosuchcmd: No such file or directory\nrc=127\n');
		assert.strictEqual(await run("printf 'a\\nb\\n' | xargs -n1 sh -c 'echo $0; exit 255' 2>&1; echo \"rc=$?\""), 'a\nxargs: sh: exited with status 255; aborting\nrc=124\n');
		assert.strictEqual(await run("printf \"a 'b\\n\" | xargs echo 2>&1; echo \"rc=$?\""), "a\nxargs: unmatched single quote; by default quotes are special to xargs unless you use the -0 option\nrc=1\n");
		assert.strictEqual(await run("printf 'a\\n' | xargs -t echo 'x y' 2>&1 >/dev/null; printf '' | xargs -r echo none; printf '' | xargs echo once; printf '' | xargs -I{} echo never"), "echo 'x y' a\nonce\n");
		assert.strictEqual(await run("printf 'echo\\n' | xargs -I{} {} hi 2>&1; echo \"rc=$?\""), 'xargs: {}: No such file or directory\nrc=127\n', 'the command word is not replaced');
	});

	test('sed: a label ends at ; (or a blank, or the line), so the one-line a/i/c after it is still rewritten; -f script files are rewritten like -e text, and bounded', async () => {
		assert.strictEqual(c.fixSedOneLiner(':a;N;$!ba;s/\\n/ /g;$a\\END'), ':a;N;$!ba;s/\\n/ /g;$a\\\nEND');
		assert.strictEqual(c.fixSedOneLiner(':a;2a\\foo'), ':a;2a\\\nfoo');
		assert.strictEqual(c.fixSedOneLiner(':a\n1i\\H'), ':a\n1i\\\nH');
		assert.strictEqual(c.fixSedOneLiner(': a;1i\\H'), ': a;1i\\\nH', 'a blank before the name');
		assert.strictEqual(c.fixSedOneLiner(':a b;1i\\H'), ':a b;1i\\\nH', 'a label ends at a blank, as in GNU');
		assert.strictEqual(c.fixSedOneLiner('b end;$a\\X'), 'b end;$a\\\nX');
		const files = { '/w/a.txt': 'a\nb\n', '/w/one.sed': '$a\\END\n1i\\START\n', '/w/two.sed': '1i\\\nHEAD\ns/a/A/\n', '/w/plain.sed': 's/a/Z/\n' };
		const r = await sh("sed -f one.sed a.txt; sed -f two.sed a.txt; sed -f plain.sed a.txt; sed -n -f plain.sed -e '$p' a.txt; sed -f nofile a.txt 2>&1 | head -1; echo; sed ':a;N;$!ba;s/\\n/+/g;$a\\END' a.txt", files);
		assert.strictEqual(r.stdout, ['START', 'a', 'b', 'END', 'HEAD', 'A', 'b', 'Z', 'b', 'b', "sed: couldn't open file nofile: No such file or directory", '', 'a+b', 'END', ''].join('\n'));
		// a script file over the bound is not read by the wrapper: the engine gets the file
		const big = '1i\\X\n' + '#'.repeat(70000) + '\n';
		const r2 = await sh("sed -f big.sed a.txt 2>&1 | head -3", { '/w/a.txt': 'a\n', '/w/big.sed': big });
		assert.strictEqual(r2.stdout, '\\X\na\n', 'the engine got the file, and prints the one-line form as it always did');
		const small = await sh("sed -f s.sed a.txt 2>&1 | head -3", { '/w/a.txt': 'a\n', '/w/s.sed': '1i\\X\n' });
		assert.strictEqual(small.stdout, 'X\na\n', 'the same line in a small file is GNU\'s one-line form');
	});

	test('sed: an option that needs a value and has none is passed on without one (it used to hand the engine the word "undefined")', () => {
		for (const [input, expected] of [[['-f'], ['-f']], [['-e'], ['-e']], [['--file'], ['-f']], [['--expression'], ['-e']], [['-n', '-e'], ['-n', '-e']], [['-nf'], ['-n', '-f']], [['-e', 'p', '-f'], ['-e', 'p', '-f']]]) {
			assert.deepStrictEqual(c.normaliseSed(input).args, expected, JSON.stringify(input));
		}
	});

	test('xargs: the warnings of options that exclude each other are printed, and a count of runs over the loop limit ends the script', async () => {
		const r = await sh("printf 'a\\nb\\n' | xargs -n1 -L1 echo 2>&1 >/dev/null; printf 'a\\n' | xargs -I{} -L1 echo 2>&1 >/dev/null");
		assert.strictEqual(r.stdout, 'xargs: warning: options --max-args and -L are mutually exclusive, ignoring previous --max-args value\nxargs: warning: options --replace and -L are mutually exclusive, ignoring previous --replace value\n');
		// a count of runs over what the engine lets a loop run is the engine's own limit
		const h = await makeHost({ Engine: E, tree: makeTree({ '/w': null }), start: false });
		await h.core.handle({ t: 'init', gen: 1, folders: [{ id: 'f', path: '/w', name: 'w' }], limits: { maxLoopIterations: 3 } });
		const ok = await h.run("printf 'a\\nb\\nc\\n' | xargs -n1 echo");
		assert.strictEqual(ok.how, 'exit', 'exactly the limit is fine');
		assert.strictEqual(ok.stdout, 'a\nb\nc\n');
		const over = await h.run("printf 'a\\nb\\nc\\nd\\n' | xargs -n1 echo; echo after");
		assert.strictEqual(over.how, 'limit');
		assert.ok(/xargs: iteration limit exceeded \(3\)/.test(over.stderr), over.stderr);
		assert.ok(!/after/.test(over.stdout));
	});

	test('du walks a tree with the engine\'s bound: an entry limit that is a limit of the script, and a tree that is deeper than the depth limit', async () => {
		const seen = [];
		const stat = async (p) => { seen.push(p); return p.endsWith('/f') || p === '/d/f' ? { isFile: true, isDirectory: false, size: 1 } : { isFile: false, isDirectory: true, size: 0 }; };
		const io = (traversal) => ({ cwd: '/', stat, readdir: async (p) => (p === '/d' ? ['f', 'g', 'h'].map((n) => n) : []), resolve: (b, p) => (b === '/' ? '/' + p : b + '/' + p), traversal });
		const boom = (m) => Object.assign(new Error(m), { name: 'ExecutionLimitError' });
		await assert.rejects(c.du(['d'], io({ entries: 3, exceeded: boom })), /du: filesystem traversal entry limit exceeded \(3\)/);
		const ok = await c.du(['d'], io({ entries: 4, exceeded: boom }));
		assert.strictEqual(ok.exitCode, 0);
		const deepIo = { cwd: '/', stat: async () => ({ isFile: false, isDirectory: true, size: 0 }), readdir: async () => ['x'], resolve: (b, p) => b + '/' + p, traversal: { entries: 1000, depth: 3, exceeded: boom } };
		await assert.rejects(c.du(['d'], deepIo), /du: filesystem traversal depth limit exceeded \(3\)/);
	});

	/* ------------------------------------------------------------------------------------------ xargs, by size */

	/**
	 * The two lists the batch counts were recorded with (GNU findutils 4.8, `xargs [opts] echo < list | wc -l`, docker with no
	 * network): a deterministic 16000-path list, and 4000 lines of letters, blanks and non-ASCII from an LCG. The numbers
	 * are what GNU printed; the lists are made here the way they were made there.
	 */
	const bigList = () => { let t = ''; for (let i = 0; i < 16000; i++) { t += `./src/main/java/com/example/product/module${i % 200}/impl/Service${i}Impl.java\n`; } return t; };
	const mixedList = () => {
		let seed = 7;
		const r = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
		let t = '';
		for (let i = 0; i < 4000; i++) {
			const n = 1 + Math.floor(r() * 60);
			let w = '';
			for (let k = 0; k < n; k++) { const c = r(); w += c < 0.05 ? 'é' : c < 0.08 ? ' ' : c < 0.1 ? '日' : String.fromCharCode(97 + Math.floor(r() * 26)); }
			t += w + '\n';
		}
		return t;
	};

	test('xargs builds its command lines by size as GNU does: the number of runs of 16000 paths and of 4000 mixed lines is GNU\'s for each of ten option sets (-s counts every word with its NUL)', async () => {
		const gnu = [
			['', 9, 2], ['-s 1000', 1202, 139], ['-s 4096', 284, 34], ['-s 100000', 12, 2], ['-n 100', 160, 76],
			['-n 7 -s 500', 2640, 1072], ['-L 3', 5334, 1281], ['-L 50 -s 90000', 320, 77], ['-I{} -s 200', 16000, 4000], ['-s 70 -n 3', 1, 184],
		];
		const h = await host({ '/w/big': bigList(), '/w/mixed': mixedList() });
		assert.ok(bigList().length > 1000000, 'more than the parser\'s 1,000,000 bytes: the old command line could not be parsed');
		for (const [opt, big, mixed] of gnu) {
			const a = await h.run(`xargs ${opt} echo < big 2>&1 | wc -l`);
			const b = await h.run(`xargs ${opt} echo < mixed 2>&1 | wc -l`);
			assert.strictEqual(a.how, 'exit', opt);
			assert.deepStrictEqual([Number(a.stdout), Number(b.stdout)], [big, mixed], `xargs ${opt}: runs of the big list, of the mixed one`);
		}
	});

	test('xargs over more than 1 MB of items runs, by batches, as it did before the commands were built as one string (a parse error under the parser\'s cap)', async () => {
		const files = {};
		for (let i = 0; i < 16000; i++) { files[`/w/src/main/java/com/example/product/module${i % 200}/impl/Service${i}Impl.java`] = i % 7 === 0 ? 'TODO\n' : 'x\n'; }
		const h = await host(files);
		const r = await h.run("find . -name '*.java' | xargs grep -l TODO | wc -l; find . -type f | xargs wc -l | grep -c total; find . -type f | xargs -n 1000 echo | wc -l");
		assert.strictEqual(r.stderr, '');
		assert.strictEqual(r.stdout, '2286\n9\n16\n');
		// the 40 batches: `seq 1 3000` is 13893 bytes of words; GNU 4.8 made 48, 41, 40 and 36 runs of it for these -s
		const runs = async (n) => Number((await h.run(`seq 1 3000 | xargs -s ${n} echo | wc -l`)).stdout);
		assert.deepStrictEqual([await runs(300), await runs(345), await runs(355), await runs(400)], [48, 41, 40, 36]);
		// every line of -s 350 is at most 344 characters (GNU's longest), and the first one ends where GNU's does
		const lines = (await h.run('seq 1 3000 | xargs -s 350 echo | awk \'{ if (length($0) > m) m = length($0) } END { print m, NR }\'')).stdout;
		assert.strictEqual(lines, '344 41\n');
		const first = (await h.run('seq 1 3000 | xargs -s 350 echo | head -1 | awk \'{ print $NF }\'')).stdout;
		assert.strictEqual(first, '113\n');
	});

	test('xargs: -s counts like GNU (words, their NUL, the command and its own arguments, UTF-8 bytes), and what does not fit is GNU\'s error', async () => {
		/** [stdout, stderr] of the script */
		const both = async (script) => { const r = await sh(script); return [r.stdout, r.stderr]; };
		assert.deepStrictEqual(await both("printf 'aa\\nbb\\ncc\\ndd\\n' | xargs -s 12 echo; printf 'aa\\nbb\\ncc\\ndd\\n' | xargs -s 14 echo; printf 'aa\\nbb\\ncc\\ndd\\n' | xargs -s 17 echo"), ['aa bb\ncc dd\naa bb cc\ndd\naa bb cc dd\n', '']);
		assert.deepStrictEqual(await both("printf 'a b\\n' | xargs -s 10 echo xx; printf 'a b\\n' | xargs -s 12 echo xx"), ['xx a\nxx b\nxx a b\n', '']);
		assert.deepStrictEqual(await both("printf 'é\\nb\\n' | xargs -s 8 echo; printf '日\\nb\\n' | xargs -s 9 echo"), ['é\nb\n日\nb\n', '']);
		// an argument that cannot fit at all: what was read before it runs, then GNU's message, status 1
		assert.deepStrictEqual(await both("printf 'a\\nb\\nzzzzzzzzzzzzzzzzzzzz\\nc\\n' | xargs -s 12 echo; echo \"rc=$?\""), ['a b\nrc=1\n', 'xargs: argument line too long\n']);
		assert.deepStrictEqual(await both("printf 'abcdefgh\\n' | xargs -s 14 echo aaaa; echo \"rc=$?\""), ['rc=1\n', 'xargs: argument line too long\n']);
		assert.deepStrictEqual(await both("printf 'a\\n' | xargs -s 5 echo; echo \"rc=$?\"; xargs -s 1 echo </dev/null; echo \"rc=$?\"; xargs -s 5 echo </dev/null; echo \"rc=$?\""), ['rc=1\nrc=1\n\nrc=0\n', 'xargs: argument line too long\nxargs: cannot fit single argument within argument list size limit\n']);
		// -x with -n, -L (which implies it), -I: the line that is too long is an error and the open batch does not run
		assert.deepStrictEqual(await both("printf 'a\\nbb\\n' | xargs -n 2 -x -s 8 echo; echo \"rc=$?\"; printf 'a b\\n' | xargs -L 1 -s 7 echo; echo \"rc=$?\"; printf 'a b\\n' | xargs -L 1 -s 9 echo; echo \"rc=$?\""), ['rc=1\nrc=1\na b\nrc=0\n', 'xargs: argument list too long\nxargs: argument list too long\n']);
		assert.deepStrictEqual(await both("printf 'aaaa\\n' | xargs -s 14 -I{} echo {} {}; echo \"rc=$?\"; printf 'aaaa\\n' | xargs -s 15 -I{} echo {} {}; echo \"rc=$?\""), ['rc=1\naaaa aaaa\nrc=0\n', 'xargs: argument list too long\n']);
		assert.deepStrictEqual(await both("printf 'aa\\nbb\\ncc\\ndd\\n' | xargs -x -s 12 echo; echo \"rc=$?\""), ['aa bb\ncc dd\nrc=0\n', ''], '-x alone does not stop it: the batches are cut at -s');
		// -s itself
		assert.deepStrictEqual(await both("printf 'a\\n' | xargs -s 0 echo; echo \"rc=$?\""), ['rc=1\n', 'xargs: value 0 for -s option should be >= 1\nxargs: cannot fit single argument within argument list size limit\n']);
		assert.deepStrictEqual(await both("printf 'a\\n' | xargs -s abc echo; echo \"rc=$?\""), ['rc=1\n', "xargs: invalid number \"abc\" for -s option\nTry 'xargs --help' for more information.\n"]);
		const over = await both('seq 1 2 | xargs -s 99999999 echo');
		assert.strictEqual(over[0], '1 2\n');
		assert.ok(/^xargs: value 99999999 for -s option should be <= \d+\n$/.test(over[1]), 'above the limit: a warning, and the limit');
	});

	test('xargs: a number that is negative or signed is a number (GNU\'s "should be >= 1", not "invalid number"); -s above the limit is the limit; a batch holds at most what one command can take', async () => {
		const both = async (script) => { const r = await sh(script); return [r.stdout, r.stderr]; };
		const help = "Try 'xargs --help' for more information.\n";
		// recorded: printf 'a b\n' | xargs OPT echo, GNU findutils 4.8.0
		assert.deepStrictEqual(await both("printf 'a b\\n' | xargs -n -1 echo; echo \"rc=$?\""), ['rc=1\n', 'xargs: value -1 for -n option should be >= 1\n' + help]);
		assert.deepStrictEqual(await both("printf 'a b\\n' | xargs -L -2 echo; echo \"rc=$?\""), ['rc=1\n', 'xargs: value -2 for -L option should be >= 1\n' + help]);
		assert.deepStrictEqual(await both("printf 'a b\\n' | xargs -n -0 echo; echo \"rc=$?\""), ['rc=1\n', 'xargs: value -0 for -n option should be >= 1\n' + help]);
		assert.deepStrictEqual(await both("printf 'a b\\n' | xargs -s -5 echo; echo \"rc=$?\""), ['rc=1\n', 'xargs: value -5 for -s option should be >= 1\nxargs: cannot fit single argument within argument list size limit\n']);
		assert.deepStrictEqual(await both("printf 'a b\\n' | xargs -n +3 echo; echo \"rc=$?\""), ['a b\nrc=0\n', '']);
		assert.deepStrictEqual(await both("printf 'a b\\n' | xargs -n 1x echo; echo \"rc=$?\"; printf 'a b\\n' | xargs -s 5.5 echo; echo \"rc=$?\""), ['rc=1\nrc=1\n', 'xargs: invalid number "1x" for -n option\n' + help + 'xargs: invalid number "5.5" for -s option\n' + help]);
		// the most -s can be is what the environment leaves of 2 MiB (GNU's formula; the exact figure is the shell's own
		// exported variables): above it is a warning and the limit, at it nothing is said
		const over = await both('seq 1 2 | xargs -s 99999999 echo');
		const limit = Number(/should be <= (\d+)\n$/.exec(over[1])[1]);
		assert.ok(limit > 2000000 && limit < 2097152, 'the limit: ' + limit);
		assert.deepStrictEqual(await both(`seq 1 2 | xargs -s ${limit} echo`), ['1 2\n', '']);
		assert.deepStrictEqual(await both(`seq 1 2 | xargs -s ${limit + 1} echo`), ['1 2\n', `xargs: value ${limit + 1} for -s option should be <= ${limit}\n`]);
		assert.deepStrictEqual(await both('seq 1 2 | xargs -s 2200000 echo'), ['1 2\n', `xargs: value 2200000 for -s option should be <= ${limit}\n`]);
		// and it is the limit that is used: 40000 words of 60 bytes are 2.4 MB, two runs (a larger -s would be one)
		const words = "awk 'BEGIN { s = sprintf(\"%60s\", \"\"); gsub(/ /, \"x\", s); for (i = 0; i < 40000; i++) print s }'";
		assert.deepStrictEqual(await both(`${words} | xargs -s 99999999 echo 2>/dev/null | wc -l`), ['2\n', '']);
		assert.deepStrictEqual(await both(`${words} | xargs -s ${limit} echo | wc -l`), ['2\n', '']);
		// the shell takes 100,000 words for one command, the command itself among them (GNU has no such limit: one run)
		const runs = async (n) => (await sh(`awk 'BEGIN { for (i = 0; i < ${n}; i++) print "a" }' | xargs -s 1000000 echo | wc -l`)).stdout;
		assert.deepStrictEqual([await runs(99999), await runs(100000), await runs(150000)], ['1\n', '2\n', '2\n']);
	});

	test('xargs -p, --interactive and -o fail closed (GNU, with no terminal, opens /dev/tty, cannot, and runs nothing); an unmatched quote runs only the items before it; -I with nothing to replace is refused', async () => {
		const both = async (script, files) => { const r = await sh(script, files); return [r.stdout, r.stderr]; };
		const tty = 'xargs: failed to open /dev/tty for reading: No such device or address\n';
		const quote = "xargs: unmatched single quote; by default quotes are special to xargs unless you use the -0 option\n";
		assert.deepStrictEqual(await both("printf 'a b\\nc d\\n' | xargs -p echo; echo \"rc=$?\""), ['rc=1\n', 'echo a b c d' + tty]);
		assert.deepStrictEqual(await both("printf 'a b\\n' | xargs --interactive echo; echo \"rc=$?\"; printf '' | xargs -p -r echo; echo \"rc=$?\""), ['rc=1\nrc=0\n', 'echo a b' + tty]);
		assert.deepStrictEqual(await both("touch f; echo f | xargs -p rm; echo \"rc=$?\"; ls"), ['rc=1\nf\n', 'rm f' + tty], 'nothing was removed');
		assert.deepStrictEqual(await both("printf 'a b\\n' | xargs -o echo; echo \"rc=$?\"; printf '' | xargs -o -r echo; echo \"rc=$?\""), ['rc=125\nrc=0\n', "xargs: '/dev/tty': No such device or address\n"]);
		// the items before the quote, not the word it sits in
		assert.deepStrictEqual(await both("printf \"a b it's c\\n\" | xargs echo; echo \"rc=$?\""), ['a b\nrc=1\n', quote]);
		assert.deepStrictEqual(await both("printf \"a\\nit's\\n\" | xargs -n1 echo; echo \"rc=$?\""), ['a\nrc=1\n', quote]);
		assert.deepStrictEqual(await both("printf \"a b c it's d\\n\" | xargs -n 2 echo; echo \"rc=$?\""), ['a b\nc\nrc=1\n', quote]);
		assert.deepStrictEqual(await both("printf \"a b\\nc d it's\\n\" | xargs -L 1 echo; echo \"rc=$?\""), ['a b\nrc=1\n', quote], 'a line is run whole or not at all');
		assert.deepStrictEqual(await both("printf \"a\\nb it's\\nc\\n\" | xargs -I{} echo x{}; echo \"rc=$?\""), ['xa\nrc=1\n', quote]);
		assert.deepStrictEqual(await both("ls | xargs rm; echo \"rc=$?\"; ls", { '/w/a.txt': '1', "/w/don't.txt": '2' }), ["rc=1\ndon't.txt\n", quote], 'rm a.txt, and not rm a.txt don (a path nobody asked for)');
		assert.deepStrictEqual(await both("ls | xargs rm; echo \"rc=$?\"; ls", { '/w/a.txt': '1', "/w/b'.txt": '2', '/w/c.txt': '3' }), ["rc=1\nb'.txt\nc.txt\n", quote], 'what is before the quote runs, what is after it does not');
		// a command that failed is 123, whatever stopped the reading
		assert.deepStrictEqual(await both("printf \"a b it's c\\n\" | xargs sh -c 'echo \"n=$#\"; exit 1' sh; echo \"rc=$?\""), ['n=2\nrc=123\n', quote]);
		assert.deepStrictEqual(await both("printf 'a\\nb\\n' | xargs -I '' echo x; echo \"rc=$?\"; printf '' | xargs -I '' echo x; echo \"rc=$?\""), ['rc=1\nrc=0\n', 'xargs: command too long\n']);
		assert.deepStrictEqual(await both("printf 'é.txt\\n' | xargs -n1 echo; echo hi > 'é.txt'; ls | xargs cat"), ['é.txt\nhi\n', ''], 'the items are text: a name with an é is a name');
	});

	/* ------------------------------------------------------------------------------------------ options that need a value */

	test('every option of every wrapper that needs a value says so in getopt\'s words when it has none (the sweep): nothing leaks `undefined`, nothing runs', async () => {
		const h = await host({ '/w/f': 'x\n' });
		let swept = 0;
		for (const [program, t] of Object.entries(c.OPTION_VALUES)) {
			const spec = [...[...t.short].map((l) => '-' + l), ...t.long];
			for (const opt of spec) {
				const line = program === 'xargs' ? `${opt}` : `${opt}`;
				const r = await h.run(`${program} ${line}`);
				const said = (r.stdout + r.stderr);
				assert.ok(!/undefined|TypeError|Cannot read|\[object/.test(said), `${program} ${opt}: ${said}`);
				const name = program === 'egrep' || program === 'fgrep' ? 'grep' : program;
				// gawk takes every long option to its letter and says that letter, bare (`awk --file` is "option requires an
				// argument -- f"; recorded from GNU in tables.json, `wording`); the others say the option as typed
				const awkLetter = { '--file': 'f', '--assign': 'v', '--field-separator': 'F', '--source': 'e', '--exec': 'E', '--include': 'i', '--load': 'l' };
				const wording = opt.startsWith('--')
					? (program === 'awk' ? `${name}: option requires an argument -- ${awkLetter[opt]}\n` : `${name}: option '${opt}' requires an argument\n`)
					: `${name}: option requires an argument -- ${t.bare ? opt[1] : `'${opt[1]}'`}\n`;
				assert.ok(r.stderr.startsWith(wording), `${program} ${opt}: ${JSON.stringify(r.stderr)}`);
				assert.strictEqual(r.exitCode, t.status || 1, `${program} ${opt}`);
				swept++;
			}
		}
		assert.ok(swept > 200, 'options swept: ' + swept);
		// a value that is there, whatever it looks like, is the value; `--` ends the options; a cluster takes the rest of itself
		const quiet = async (script) => { const r = await h.run(script); return r.stderr; };
		assert.ok(!/requires an argument/.test(await quiet('printf "a\\n" | sort -k 1,1 -o /dev/null; head -n -1 f; cp -rt . f 2>&1; echo x | xargs -I {} -n 1 echo {}')));
		assert.ok(!/requires an argument/.test(await quiet('touch -- -r; printf "a\\n" | grep -e a -- -n; sed -ne p f')));
		assert.ok(/option requires an argument -- 't'/.test(await quiet('cp -rt')));
	});

	test('the guard is one reader: missingOptionValue answers for the program it is given and for nothing else', () => {
		const m = c.missingOptionValue;
		assert.strictEqual(m('cp', ['-t', 'dir', 'f']), null);
		assert.strictEqual(m('cp', ['f', '-t']).exitCode, 1);
		assert.strictEqual(m('cp', ['--', '-t']), null, 'after -- they are operands');
		assert.strictEqual(m('sort', ['-k']).exitCode, 2);
		assert.strictEqual(m('grep', ['-e']).stderr, "grep: option requires an argument -- 'e'\nUsage: grep [OPTION]... PATTERNS [FILE]...\nTry 'grep --help' for more information.\n");
		assert.strictEqual(m('egrep', ['--regexp']).stderr, "grep: option '--regexp' requires an argument\nUsage: grep [OPTION]... PATTERNS [FILE]...\nTry 'grep --help' for more information.\n");
		assert.strictEqual(m('awk', ['-f']).stderr, 'awk: option requires an argument -- f\nUsage: awk [POSIX or GNU style options] -f progfile [--] file ...\n');
		assert.strictEqual(m('sed', ['-n', '-e']).stderr.split('\n')[0], "sed: option requires an argument -- 'e'");
		assert.strictEqual(m('sed', ['-ie']), null, '-i takes the rest of the cluster as its suffix');
		assert.strictEqual(m('xargs', ['echo', '-n']), null, 'the command starts at the first operand: -n is its argument');
		assert.strictEqual(m('xargs', ['-n']).stderr, "xargs: option requires an argument -- 'n'\nTry 'xargs --help' for more information.\n");
		assert.strictEqual(m('xargs', ['-0rn']).stderr, "xargs: option requires an argument -- 'n'\nTry 'xargs --help' for more information.\n");
		assert.strictEqual(m('xargs', ['-i']), null, '-i takes an optional string');
		assert.strictEqual(m('date', ['-I']), null);
		assert.strictEqual(m('ls', ['-w']).exitCode, 2);
		assert.strictEqual(m('tr', ['-t']), null, 'a program that is not in the table');
		assert.deepStrictEqual(c.parseXargs(['-n']), { error: "xargs: option requires an argument -- 'n'\nTry 'xargs --help' for more information.\n" });
		assert.deepStrictEqual(c.parseXargs(['--arg-file']), { error: "xargs: option '--arg-file' requires an argument\nTry 'xargs --help' for more information.\n" });
	});

	/* ------------------------------------------------------------------------------------------ smaller things */

	test('touch -r REF -d STRING: -d wins over the time of REF (and so does -d @N); -t with -r or -d is GNU\'s error and touches nothing', async () => {
		const r = await sh("touch -d '2001-02-03 04:05:06' ref; touch -r ref -d '2010-01-01' a; stat -c '%y' a; touch -r ref a2; stat -c '%y' a2; touch -d '2010-01-01' -r ref a3; stat -c '%y' a3; touch -r ref -d @86400 a4; stat -c %Y a4; touch -r ref -t 202001020304 a5; echo \"rc=$?\"; touch -d 2010-01-01 -t 202001020304 a6; echo \"rc=$?\"; ls a5 a6 2>&1 | head -2");
		assert.strictEqual(r.stdout, "2010-01-01 00:00:00.000000000 +0000\n2001-02-03 04:05:06.000000000 +0000\n2010-01-01 00:00:00.000000000 +0000\n86400\nrc=1\nrc=1\nls: cannot access 'a5': No such file or directory\nls: cannot access 'a6': No such file or directory\n", 'nothing was touched');
		assert.strictEqual(r.stderr, "touch: cannot specify times from more than one source\nTry 'touch --help' for more information.\ntouch: cannot specify times from more than one source\nTry 'touch --help' for more information.\n");
	});

	test('head and tail take --lines and --bytes joined or apart, with the sign: tail --lines=+4 is from line 4 on (the engine took it for the last 4)', async () => {
		const f = { '/w/f': 'alpha\nbeta\ngamma\ndelta\nepsilon\n' };
		const r = await sh("tail --lines=+4 f; echo --; tail --lines +4 f; echo --; tail -n +4 f; echo --; tail --lines=2 f; echo --; tail --bytes=6 f; echo --; head --lines 2 f; echo --; head --lines=-3 f; echo --; head --bytes 3 f; echo; echo --; tail --lines=-2 f", f);
		assert.strictEqual(r.stdout, 'delta\nepsilon\n--\ndelta\nepsilon\n--\ndelta\nepsilon\n--\ndelta\nepsilon\n--\nsilon\n--\nalpha\nbeta\n--\nalpha\nbeta\n--\nalp\n--\ndelta\nepsilon\n');
		assert.deepStrictEqual(c.parseTailFrom(['--lines=+4', 'f']), null, 'a line count is the engine\'s: the wrapper makes it `-n +4`');
	});

	test('mkdir -pv names every folder it makes as GNU does (the operand as typed up to that segment, the last one with its slashes) and nothing for `.`, `..` or an empty segment', async () => {
		const r = await sh("mkdir -pv a//b; mkdir -pv ./c/./d; mkdir -pv /w/g/h/; mkdir -pv a//b ./c; mkdir -pv ../w/i; mkdir -pv j/./k//l/..//m; mkdir -pv ./; mkdir -pv .; mkdir -pv ..//w//n");
		assert.strictEqual(r.stdout, [
			"mkdir: created directory 'a'", "mkdir: created directory 'a//b'",
			"mkdir: created directory './c'", "mkdir: created directory './c/./d'",
			"mkdir: created directory '/w/g'", "mkdir: created directory '/w/g/h/'",
			"mkdir: created directory '../w/i'",
			"mkdir: created directory 'j'", "mkdir: created directory 'j/./k'", "mkdir: created directory 'j/./k//l'", "mkdir: created directory 'j/./k//l/..//m'",
			"mkdir: created directory '..//w//n'", '',
		].join('\n'));
	});

	test('cp -rv of a tree the engine\'s traversal limit allows lists all of it, and one entry over is the engine\'s limit (a limit of the script), with nothing listed', async () => {
		const files = { '/w/d/a': '1' };
		for (let i = 0; i < 29; i++) { files[`/w/d/f${String(i).padStart(2, '0')}`] = '1'; }
		const at = async (limit, script) => {
			const h = await makeHost({ Engine: E, tree: makeTree(Object.assign({ '/w': null }, files)), start: false });
			await h.core.handle({ t: 'init', gen: 1, folders: [{ id: 'f', path: '/w', name: 'w' }], limits: { maxTraversalEntries: limit } });
			return h.run(script);
		};
		// the folder and its 30 entries are 31: exactly the limit passes, and every entry has its line
		const ok = await at(31, 'cp -rv d e | wc -l; cp -rv d e2 | sort | sed -n \'1,3p;$p\'');
		assert.strictEqual(ok.how, 'exit');
		assert.strictEqual(ok.stdout, "31\n'd' -> 'e2'\n'd/a' -> 'e2/a'\n'd/f00' -> 'e2/f00'\n'd/f28' -> 'e2/f28'\n");
		const over = await at(30, 'echo before; cp -rv d e; echo after');
		assert.strictEqual(over.how, 'limit');
		assert.ok(/cp: filesystem traversal entry limit exceeded \(30\)/.test(over.stderr), over.stderr);
		assert.ok(!/after/.test(over.stdout) && !/->/.test(over.stdout));
	});

	test('sort -k: the letters are read where they are written (a b after the end position is the end\'s), -kF.C starts at the character, an invalid key and a bad -o are GNU\'s errors and status', async () => {
		const r = await sh("printf '   c,FOO,0,foo\\naa,Foo,007\\n9,Foo,é,B\\n' | sort -k1.1,1b -k3,4; echo --; printf 'xb\\nya\\nzc\\n' | sort -k1.2; echo --; printf 'xb\\nya\\nzc\\n' | sort -k1.2,1.2; echo --; printf ' b\\na\\n  c\\n' | sort -k1b");
		assert.strictEqual(r.stdout, '   c,FOO,0,foo\n9,Foo,é,B\naa,Foo,007\n--\nya\nxb\nzc\n--\nya\nxb\nzc\n--\na\n b\n  c\n');
		const e = await sh("printf 'a\\n' | sort -k0; echo \"rc=$?\"; printf 'a\\n' | sort -k1.0; echo \"rc=$?\"; echo b | sort -o nodir/x; echo \"rc=$?\"; mkdir dd; echo b | sort -o dd; echo \"rc=$?\"");
		assert.strictEqual(e.stdout, 'rc=2\nrc=2\nrc=2\nrc=2\n');
		assert.strictEqual(e.stderr, "sort: field number is zero: invalid field specification '0'\nsort: character offset is zero: invalid field specification '1.0'\nsort: open failed: nodir/x: No such file or directory\nsort: open failed: dd: Is a directory\n");
	});

	/* ------------------------------------------------------------------------------------------ second pass: each recorded from GNU */

	// The expected text of the tests of this block is what GNU bash 5.1 / coreutils 8.32 / findutils 4.8 printed for the script
	// (docker, `--network none`, LC_ALL=C.UTF-8), recorded once; their curly quotes are read as straight ones.

	test("xargs: the default -s is 128 KiB: 1310 items of 99 bytes (and the NUL each ends with, and `echo`) are one run, 1311 are two", async () => {
		const r = await sh("n() { { i=0; while [ $i -lt 1310 ]; do printf '%099d\\n' $i; i=$((i+1)); done; } | xargs echo | wc -l; }; n; { i=0; while [ $i -lt 1311 ]; do printf '%099d\\n' $i; i=$((i+1)); done; } | xargs echo | wc -l; { i=0; while [ $i -lt 1309 ]; do printf '%099d\\n' $i; i=$((i+1)); done; } | xargs echo | wc -l");
		assert.strictEqual(r.stdout, "1\n2\n1\n");
	});

	test("xargs -s counts a 4-byte character as 4 bytes: three of them with `echo` are 20 with their NULs, so -s 20 is one run, -s 19 two, -s 14 an item that cannot fit", async () => {
		const r = await sh("for s in 20 19 15 14 10 9; do printf '😀 😀 😀\\n' | xargs -s $s echo 2>&1 | tr '\\n' '|'; echo \"s=$s rc=$?\"; done; for s in 9 10 11; do printf 'é é é\\n' | xargs -s $s echo 2>&1 | tr '\\n' '|'; echo; done");
		assert.strictEqual(r.stdout, "😀 😀 😀|s=20 rc=0\n😀 😀|😀|s=19 rc=0\n😀 😀|😀|s=15 rc=0\n😀|😀|😀|s=14 rc=0\n😀|😀|😀|s=10 rc=0\nxargs: argument line too long|s=9 rc=0\né|é|é|\né|é|é|\né é|é|\n");
	});

	test("xargs -t: the trace of a command is written before the message that the next item does not fit, and plain -x runs nothing after a stop", async () => {
		const r = await sh("printf 'ccc long_long_word ccc\\n' | xargs -s 13 -t echo 2>&1 >/dev/null; printf 'ccc long_long_word ccc\\n' | xargs -s 13 echo 2>/dev/null; printf 'a long_long_word a\\n' | xargs -s 15 -x echo 2>&1; echo \"rc=$?\"; printf \"a b it's c\\n\" | xargs -x echo 2>&1; echo \"rc=$?\"");
		assert.strictEqual(r.stdout, "echo ccc\nxargs: argument line too long\nccc\nxargs: argument line too long\nrc=1\nxargs: unmatched single quote; by default quotes are special to xargs unless you use the -0 option\nrc=1\n");
	});

	test("sort -k: strtol takes a plus sign and blanks, a zero end field is GNU's error, and each key is read as GNU reads it", async () => {
		const r = await sh("export LC_ALL=C; printf 'b 3\\na 10\\nc 2\\n' > f; for k in '+1' ' 1' '+2n' '1,0' '1,+1' '1.+1' ' +2n,2' '0' '1.0' '1,' ',2' '-1' '1nM' 'x'; do printf '%s => ' \"$k\"; sort -k \"$k\" f 2>&1 | tr '\\n' '|'; echo; done");
		assert.strictEqual(r.stdout, "+1 => a 10|b 3|c 2|\n 1 => a 10|b 3|c 2|\n+2n => c 2|b 3|a 10|\n1,0 => sort: field number is zero: invalid field specification '1,0'|\n1,+1 => a 10|b 3|c 2|\n1.+1 => a 10|b 3|c 2|\n +2n,2 => c 2|b 3|a 10|\n0 => sort: field number is zero: invalid field specification '0'|\n1.0 => sort: character offset is zero: invalid field specification '1.0'|\n1, => sort: invalid number after ',': invalid count at start of ''|\n,2 => sort: invalid number at field start: invalid count at start of ',2'|\n-1 => sort: invalid number at field start: invalid count at start of '-1'|\n1nM => sort: options '-Mn' are incompatible|\nx => sort: invalid number at field start: invalid count at start of 'x'|\n");
	});

	test("grep: -l and -L of standard input name it, whatever the pattern did; and -NUM is -C NUM", async () => {
		const r = await sh("printf 'a\\nb\\n' | grep -l a; printf 'a\\nb\\n' | grep -L c; printf 'a\\nb\\n' | grep -c a; seq 1 9 | grep -1 5; seq 1 9 | grep -n1 5; seq 1 9 | grep -c -2 5");
		assert.strictEqual(r.stdout, "(standard input)\n(standard input)\n1\n4\n5\n6\n4-4\n5:5\n6-6\n1\n");
	});

	test("tail -z: each header is a line of its own, ends in a newline, and a blank line comes before the second; a file that is not there has none", async () => {
		const r = await sh("printf 'a\\0b\\0' > f; printf 'x\\0y\\0' > g; tail -z -n1 f g | tr '\\0' '@'; tail -z -n1 f nofile g 2>/dev/null | tr '\\0' '@'; printf 'p\\0q\\0' | tail -z -n1 - f | tr '\\0' '@'");
		assert.strictEqual(r.stdout, "==> f <==\nb@\n==> g <==\ny@==> f <==\nb@\n==> g <==\ny@==> standard input <==\nq@\n==> f <==\nb@");
	});

	test("grep -Z -z: the name ends in NUL on every record, a group separator is a line of its own, -c and -l end in a newline", async () => {
		const r = await sh("printf 'a1\\0x\\0y\\0z\\0a2\\0w\\0' > f; printf 'a b\\n' > g; grep -ZH -z a f g | tr '\\0' '@'; echo; grep -z -A1 a f | tr '\\0' '@'; grep -zc a f g; grep -Zzl a f g | tr '\\0' '@'; echo; grep -zL x f g");
		assert.strictEqual(r.stdout, "f@a1@f@a2@g@a b\n@\na1@x@--\na2@w@f:2\ng:1\nf@g@\ng\n");
	});

	test("sed -z: a newline in a script is the newline of the data (a pattern, a replacement written with a backslash and a newline); a, i, c, l and the M flag are refused", async () => {
		const r = await sh("printf 'a\\0b\\0' | sed -z 's/a/x\\ny/' | tr '\\0' '@'; printf 'a\\0b\\0' | sed -z 's/a/x\\\ny/' | tr '\\0' '@'; printf 'a\\nb\\0' | sed -z 's/\\n/+/' | tr '\\0' '@'; printf 'a\\nb\\0' | sed -z 's/a$/X/' | tr '\\0' '@'; printf 'a\\nb\\0' | sed -z 's/^b/X/' | tr '\\0' '@'; printf 'a\\0b\\0' | sed -z 'N;s/a.b/X/' | tr '\\0' '@'; printf 'a\\0b\\0' | sed -zn '$=' | tr '\\0' '@'");
		assert.strictEqual(r.stdout, "x\ny@b@x\ny@b@a+b@a\nb@a\nb@X@2@");
	});

	test("xargs: a NUL in blank-separated input ends the argument it is in and is said once; with -E and -0 or -d it is said that -E does nothing", async () => {
		const r = await sh("printf 'a\\0b c\\0d e\\n' | xargs -n1 echo 2>/dev/null; { printf 'a\\0b c\\0d e\\n' | xargs -n1 echo >/dev/null; } 2>&1; printf 'x\\0y\\n' | xargs -I{} echo '<{}>' 2>/dev/null; printf 'a\\0b\\0' | xargs -0 -E b echo 2>/dev/null; { printf 'a\\0b\\0' | xargs -0 -E b echo >/dev/null; } 2>&1; printf 'a,b' | xargs -d, -E b echo 2>/dev/null; { printf 'a,b' | xargs -d, -E b echo >/dev/null; } 2>&1; printf 'a b\\n' | xargs -E b echo 2>&1");
		assert.strictEqual(r.stdout, "a\nc\ne\nxargs: WARNING: a NUL character occurred in the input.  It cannot be passed through in the argument list.  Did you mean to use the --null option?\n<x\na b\nxargs: warning: the -E option has no effect if -0 or -d is used.\n\na b\nxargs: warning: the -E option has no effect if -0 or -d is used.\n\na\n");
	});

	test("rm and touch through a name that goes up by `..`: a file on the way is \"Not a directory\", a missing folder \"No such file or directory\"; rm of a file named with a slash is an error and the file stays", async () => {
		const r = await sh("export LC_ALL=C; mkdir -p d; echo F > f; for c in 'rm f/../d' 'rm -r x/../d' 'touch f/../n' 'touch x/../n' 'rm f/' 'rm -d f/' 'rm -f f/' 'rm .' 'rm -r .' 'rm d/..' 'rm -rf d/.' 'rm -d d/.' 'rm -df d/.' 'rm -d ne/.' 'rm -d ne/..'; do mkdir -p ne/sub; printf '%-14s -> ' \"$c\"; $c 2>&1 | tr '\\n' '|'; echo \"rc=$?\"; done; ls");
		assert.strictEqual(r.stdout, "rm f/../d      -> rm: cannot remove 'f/../d': Not a directory|rc=0\nrm -r x/../d   -> rm: cannot remove 'x/../d': No such file or directory|rc=0\ntouch f/../n   -> touch: cannot touch 'f/../n': Not a directory|rc=0\ntouch x/../n   -> touch: cannot touch 'x/../n': No such file or directory|rc=0\nrm f/          -> rm: cannot remove 'f/': Not a directory|rc=0\nrm -d f/       -> rm: cannot remove 'f/': Not a directory|rc=0\nrm -f f/       -> rc=0\nrm .           -> rm: cannot remove '.': Is a directory|rc=0\nrm -r .        -> rm: refusing to remove '.' or '..' directory: skipping '.'|rc=0\nrm d/..        -> rm: cannot remove 'd/..': Is a directory|rc=0\nrm -rf d/.     -> rm: refusing to remove '.' or '..' directory: skipping 'd/.'|rc=0\nrm -d d/.      -> rm: refusing to remove '.' or '..' directory: skipping 'd/.'|rc=0\nrm -df d/.     -> rm: refusing to remove '.' or '..' directory: skipping 'd/.'|rc=0\nrm -d ne/.     -> rm: cannot remove 'ne/.': Directory not empty|rc=0\nrm -d ne/..    -> rm: cannot remove 'ne/..': Directory not empty|rc=0\nd\nf\nne\n");
	});

	test("cp and mv through a file on the way: `f/../d` is not there (\"failed to access\", \"Not a directory\")", async () => {
		const r = await sh("export LC_ALL=C; echo F > f; mkdir d; cp f f/../g; cp -r d f/../g; cp -n f f/../g; mv f f/../g; cp f x/../g; ls");
		assert.strictEqual(r.stdout, "d\nf\n");
	});

	test("mv -n d/. x/../d with x missing is an error, not a quiet success (the name goes through a folder that is not there)", async () => {
		const r = await sh("mkdir d; mv -n d/. x/../d; echo \"rc=$?\"; ls");
		assert.strictEqual(r.stdout, "rc=1\nd\n");
	});

	test("cp -vT names the copy as typed, and -n and -u of a folder against a file say what GNU says", async () => {
		const r = await sh("export LC_ALL=C; echo a > a; cp -vT a b; mkdir d x; echo 1 > d/sub; mkdir d/sub2; echo 2 > x/sub2; cp -rn d/. x 2>&1; echo \"rc=$?\"; cp -ru d/. x 2>&1; echo \"rc=$?\"; ls -R x");
		assert.strictEqual(r.stdout, "'a' -> 'b'\ncp: cannot overwrite non-directory 'x/./sub2' with directory 'd/./sub2'\nrc=1\ncp: cannot overwrite non-directory 'x/./sub2' with directory 'd/./sub2'\nrc=1\nx:\nsub\nsub2\n");
	});

	test("ls: -I, --ignore and --hide take names out (--hide not with -a), -v and --sort=version order a plain listing, -X by extension, -w is accepted, a bad --sort says so", async () => {
		const r = await sh("export LC_ALL=C; touch a.txt b.log c.txt .h f10 f2 f1; ls -I '*.log'; echo --; ls --ignore=b.log -I 'a*'; echo --; ls -a --hide='*.txt'; echo --; ls --hide='*.txt' -a -I '.*'; echo --; ls -v; echo --; ls --sort=version; echo --; ls -X; echo --; ls -w 4 -1; echo --; ls --sort=bogus 2>&1 | head -2; echo --; ls -r -v; ls -t -X a.txt");
		assert.strictEqual(r.stdout, "a.txt\nc.txt\nf1\nf10\nf2\n--\nc.txt\nf1\nf10\nf2\n--\n.\n..\n.h\na.txt\nb.log\nc.txt\nf1\nf10\nf2\n--\na.txt\nb.log\nc.txt\nf1\nf10\nf2\n--\na.txt\nb.log\nc.txt\nf1\nf2\nf10\n--\na.txt\nb.log\nc.txt\nf1\nf2\nf10\n--\nf1\nf10\nf2\nb.log\na.txt\nc.txt\n--\na.txt\nb.log\nc.txt\nf1\nf10\nf2\n--\nls: invalid argument 'bogus' for '--sort'\nValid arguments are:\n--\nf10\nf2\nf1\nc.txt\nb.log\na.txt\na.txt\n");
	});

	test("seq -f with an increment of zero is GNU's error, `tail +Nb` is blocks of 512, `cp --archive` keeps the time, `ls --sort=size`, `ls -v` with leading zeros, `basename -z NAME SUFFIX`", async () => {
		const r = await sh("export LC_ALL=C; seq -f %g 1 0 3 2>&1; echo \"rc=$?\"; head -c 600 /dev/zero | tr '\\0' x > big; tail +1b big | wc -c; touch -d @1600000000 f; cp --archive f g; stat -c '%n %Y' f g; printf 1 > a; printf 12345 > b; ls --sort=size a b; touch v1 v01 v001 v10 v2 w0 w00 w000; ls -v v* w*; basename -z /a/b.txt .txt | od -c | head -1; basename -z -s .txt /a/b.txt | od -c | head -1");
		assert.strictEqual(r.stdout, "seq: invalid Zero increment value: '0'\nTry 'seq --help' for more information.\nrc=1\n89\nf 1600000000\ng 1600000000\nb\na\nv001\nv01\nv1\nv2\nv10\nw0\nw00\nw000\n0000000   b  \\0\n0000000   b  \\0\n");
	});

	test("awk: an operand assignment of a number is a number (x > 10 is numeric), printenv -0 ends each variable in NUL, uniq -z takes an OUTPUT operand, sed -z -i with a * in the suffix, touch -c through a missing folder makes nothing", async () => {
		const r = await sh("export LC_ALL=C; printf 'a\\n' > t; awk '{print (x > 10), x + 1}' x=5 t; awk -v n=5 'BEGIN{OFS=\"-\"} {print (n > 10), $1}' t; export FOO=bar; printenv -0 | tr -d '\\n' | tr '\\0' '\\n' | grep -c '^FOO=bar$'; printf 'a\\0a\\0b\\0' > f; uniq -z f out; od -c out | head -2; printf 'a\\0' > h; sed -z -i'bk_*' 's/a/b/' h; ls; od -c h | head -1; od -c bk_h | head -1; touch -c x/../n; echo \"rc=$?\"; touch -cm x/../n; echo \"rc=$?\"; ls");
		assert.strictEqual(r.stdout, "0 6\n0-a\n1\n0000000   a  \\0   b  \\0\n0000004\nbk_h\nf\nh\nout\nt\n0000000   b  \\0\n0000000   a  \\0\nrc=0\nrc=0\nbk_h\nf\nh\nout\nt\n");
	});

	test("ls -v is GNU's filevercmp: leading zeros are no difference to a number and equal numbers go by their bytes (`w0 w00 w000`, `file01.txt` before `file1.txt`), a file suffix is left out of the comparison, `~` and `.` first, a letter before any other mark; -r reverses all of it", async () => {
		const r = await sh("export LC_ALL=C; touch w0 w00 w000 w01 w1 file01.txt file1.txt file2.txt file10.txt a-1.tar.gz a-10.tar.gz a-2.tar.gz a-1.tar.bz2 .hidden .z1 A1 B a a1 b ./-y _x 1.0 1.0a 1.0-rc1 1.0.1 '1.0~rc1' img001.jpg img01.jpg img1.jpg img10.jpg; ls -va | tr '\\n' ' '; echo; ls -v | tr '\\n' ' '; echo; ls -vr | tr '\\n' ' '; echo; ls --sort=version -A | tr '\\n' ' '; echo; ls -lv w* | awk '{print $NF}' | tr '\\n' ' '; echo");
		assert.strictEqual(r.stdout, ". .. .hidden .z1 1.0~rc1 1.0 1.0a 1.0-rc1 1.0.1 A1 B a a1 a-1.tar.bz2 a-1.tar.gz a-2.tar.gz a-10.tar.gz b file01.txt file1.txt file2.txt file10.txt img001.jpg img01.jpg img1.jpg img10.jpg w0 w00 w000 w01 w1 -y _x \n1.0~rc1 1.0 1.0a 1.0-rc1 1.0.1 A1 B a a1 a-1.tar.bz2 a-1.tar.gz a-2.tar.gz a-10.tar.gz b file01.txt file1.txt file2.txt file10.txt img001.jpg img01.jpg img1.jpg img10.jpg w0 w00 w000 w01 w1 -y _x \n_x -y w1 w01 w000 w00 w0 img10.jpg img1.jpg img01.jpg img001.jpg file10.txt file2.txt file1.txt file01.txt b a-10.tar.gz a-2.tar.gz a-1.tar.gz a-1.tar.bz2 a1 a B A1 1.0.1 1.0-rc1 1.0a 1.0 1.0~rc1 \n.hidden .z1 1.0~rc1 1.0 1.0a 1.0-rc1 1.0.1 A1 B a a1 a-1.tar.bz2 a-1.tar.gz a-2.tar.gz a-10.tar.gz b file01.txt file1.txt file2.txt file10.txt img001.jpg img01.jpg img1.jpg img10.jpg w0 w00 w000 w01 w1 -y _x \nw0 w00 w000 w01 w1 \n");
	});

	test("sort -V is the same function: `sort -Vu` keeps `file01.txt` and `file1.txt` (equal numbers are different names), `~` sorts before the end of a name, an empty line, `.` and `..` first, and the marks around the ASCII letters and digits", async () => {
		const r = await sh("export LC_ALL=C; for l in '1.2 1.10 1.9 1.1' '1.0 1.0-rc1 1.0~rc1 1.0.1 1.0a' 'file1.txt file10.txt file2.txt file01.txt' 'a-1.tar.gz a-10.tar.gz a-2.tar.gz a-1.tar.bz2' 'img001.jpg img1.jpg img01.jpg img10.jpg img2.jpg' 'release-1.2.3-beta release-1.2.3 release-1.2.3-alpha release-1.2.10' '10 9 100 1 08 8' 'a B a1 A1 b _x -y .hidden .z1' '1.2.3 1.2.3.1 1.2 1.2.3a 1.2.3-1' '1 1.0 1.00 1.0.0 01 1.' 'w0 w00 w000 w1 w01' '..~100x .a1 .~a01 .txt x'; do printf '%s\\n' $l | sort -V | tr '\\n' ' '; echo; printf '%s\\n' $l | sort -rV | tr '\\n' ' '; echo; printf '%s\\n' $l | sort -Vu | wc -l; done; printf '%s\\n' a '' .a . .. '~' | sort -V | tr '\\n' '|'; echo; printf '%s\\n' 'a@' 'a[' 'a`' 'a{' aZ aA a0 a9 'a:' a. a- a_ 'a~' a 'a/' 'a|' | sort -V | tr '\\n' '|'; echo; printf 'x v10\\ny v9\\nz v1\\nw v09\\n' | sort -k2V | tr '\\n' '|'; echo; printf 'v1.10\\nv1.9\\nv1.9\\n' | sort -Vu | tr '\\n' '|'; echo");
		assert.strictEqual(r.stdout, "1.1 1.2 1.9 1.10 \n1.10 1.9 1.2 1.1 \n4\n1.0~rc1 1.0 1.0a 1.0-rc1 1.0.1 \n1.0.1 1.0-rc1 1.0a 1.0 1.0~rc1 \n5\nfile01.txt file1.txt file2.txt file10.txt \nfile10.txt file2.txt file1.txt file01.txt \n4\na-1.tar.bz2 a-1.tar.gz a-2.tar.gz a-10.tar.gz \na-10.tar.gz a-2.tar.gz a-1.tar.gz a-1.tar.bz2 \n4\nimg001.jpg img01.jpg img1.jpg img2.jpg img10.jpg \nimg10.jpg img2.jpg img1.jpg img01.jpg img001.jpg \n5\nrelease-1.2.3 release-1.2.3-alpha release-1.2.3-beta release-1.2.10 \nrelease-1.2.10 release-1.2.3-beta release-1.2.3-alpha release-1.2.3 \n4\n1 08 8 9 10 100 \n100 10 9 8 08 1 \n6\n.hidden .z1 A1 B a a1 b -y _x \n_x -y b a1 a B A1 .z1 .hidden \n9\n1.2 1.2.3 1.2.3a 1.2.3-1 1.2.3.1 \n1.2.3.1 1.2.3-1 1.2.3a 1.2.3 1.2 \n5\n01 1 1. 1.0 1.00 1.0.0 \n1.0.0 1.00 1.0 1. 1 01 \n6\nw0 w00 w000 w01 w1 \nw1 w01 w000 w00 w0 \n5\n.~a01 ..~100x .a1 .txt x \nx .txt .a1 ..~100x .~a01 \n5\n|.|..|.a|~|a|\na~|a|a.|a0|a9|aA|aZ|a-|a/|a:|a@|a[|a_|a`|a{|a||\nz v1|w v09|y v9|x v10|\nv1.9|v1.10|\n");
	});

	test("awk: an assignment operand between two readings of the same file is for the second one, and a new FS splits the first record of the file it is for", async () => {
		const r = await sh("export LC_ALL=C; printf 'a,b\\nc,d\\n' > f; printf 'x:y\\n' > g; : > e; awk '{print $1}' FS=, f FS=: f; echo --; awk '{print FILENAME, FNR, x}' x=1 f x=2 f x=3; echo --; awk '{print FILENAME \":\" x}' x=1 f x=2 g x=3 f; echo --; awk 'END{print x, NR}' x=1 f x=9 f x=7; echo --; awk '{print FILENAME, x}' x=1 e x=2 f x=3 f; echo --; awk '{print $2}' FS=, f FS=: g FS=, f");
		assert.strictEqual(r.stdout, "a\nc\na,b\nc,d\n--\nf 1 1\nf 2 1\nf 1 2\nf 2 2\n--\nf:1\nf:1\ng:2\nf:3\nf:3\n--\n7 4\n--\nf 2\nf 2\nf 3\nf 3\n--\nb\nd\ny\nb\nd\n");
	});

	test("ls -v and sort -V: versionCompare is gnulib's filevercmp of coreutils 8.32: six sets of names in the order GNU's `ls -va` gave them, from whatever order they come in", () => {
		// recorded from GNU (docker, LC_ALL=C.UTF-8); picked from 1,000 random sets as the smallest that every branch of the function needs
		const sets = [
		[["éa210", " z", "Aa.tar01", "éa.a199~", "10010-_", ".AA", "é01_", " -_0", "001.5.A", "0000", "~1.5.00", "01.~", "A", "BB", "..a1"], [".", "..", "..a1", ".AA", "~1.5.00", "0000", "01.~", "001.5.A", "10010-_", "A", "Aa.tar01", "BB", " z", " -_0", "é01_", "éa.a199~", "éa210"]],
		[["z100", "10-99A", "..~.A.a1", ".c.A", "99", "2", "éa0071.5", "100"], [".", "..", "..~.A.a1", ".c.A", "2", "10-99A", "99", "100", "z100", "éa0071.5"]],
		[["1.", "b9", "1099b9", "b.0éaB", "01", "10~2-", "01é0.txt", "10", "vab.txt10", "1", "A01é", "ab.gz0.~", "1.5", "v_.~.0"], [".", "..", "01", "1", "1.", "1.5", "01é0.txt", "10~2-", "10", "1099b9", "A01é", "ab.gz0.~", "b9", "b.0éaB", "vab.txt10", "v_.~.0"]],
		[[" .A_", "2", "007é.txt0", "2é.gz", "éa", "0.~b", "99", "xz.c", " 0-", "0.txt", "zB", "_ab007éa", "~", ".tarB"], [".", "..", ".tarB", "~", "0.~b", "0.txt", "2", "2é.gz", "007é.txt0", "99", "xz.c", "zB", " 0-", " .A_", "_ab007éa", "éa"]],
		[["0.gz00", "99 99", "_z", "A", " 1.5", "00~.tar00"], [".", "..", "00~.tar00", "0.gz00", "99 99", "A", " 1.5", "_z"]],
		[["z110", "B", "é", "100aéa_", "~ A01", "0110"], [".", "..", "~ A01", "100aéa_", "0110", "B", "z110", "é"]],
		];
		for (const [names, order] of sets) {
			const all = ['.', '..', ...names];
			assert.deepStrictEqual([...all].sort(c.versionCompare), order);
			assert.deepStrictEqual([...all].reverse().sort(c.versionCompare), order);
			// the same from either side: a pair that compares one way must compare the other way the other way (the empty name,
			// which a file cannot have and `sort -V` reads from an empty line, is before everything: see the sort -V case)
			for (const x of ['', ...all]) {
				for (const y of ['', ...all]) {
					assert.strictEqual(Math.sign(c.versionCompare(x, y)) + Math.sign(c.versionCompare(y, x)), 0, JSON.stringify([x, y]));
				}
			}
			assert.deepStrictEqual(['', ...all].sort(c.versionCompare), ['', ...order]);
		}
		// a total order: equal only for the same name
		assert.strictEqual(c.versionCompare('a', 'a'), 0);
		assert.ok(c.versionCompare('w0', 'w00') < 0 && c.versionCompare('w00', 'w0') > 0);
	});

	test('touch and tee outside the workspace folders say GNU\'s reason, "Permission denied" (touch said "No such file or directory"; the errno row of LC-30 had no test)', async () => {
		// recorded from GNU coreutils 8.32 as an ordinary user (docker --user 1000, `--network none`): /usr and /usr/bin are not
		// writable, /dev/null is. The shell adds its own `bash: PATH: Permission denied` line for each path it refused.
		const own = (r) => r.stderr.split('\n').filter((l) => l !== '' && !l.startsWith('bash: '));
		const shell = (r) => r.stderr.split('\n').filter((l) => l.startsWith('bash: '));
		const a = await sh("touch /usr/x; echo \"rc=$?\"; touch /usr/bin/cat; echo \"rc=$?\"; touch /dev/null; echo \"rc=$?\"; touch -c /usr/x; echo \"rc=$?\"; touch ok /usr/y; echo \"rc=$?\"; ls");
		assert.strictEqual(a.stdout, 'rc=1\nrc=1\nrc=0\nrc=0\nrc=1\nok\n');
		assert.deepStrictEqual(own(a), ["touch: cannot touch '/usr/x': Permission denied", "touch: cannot touch '/usr/bin/cat': Permission denied", "touch: cannot touch '/usr/y': Permission denied"]);
		assert.deepStrictEqual(shell(a), ['bash: /usr/x: Permission denied', 'bash: /usr/bin/cat: Permission denied', 'bash: /usr/y: Permission denied']);
		// tee of nothing opens the file first, and that is refused as GNU's open is; its other files are made
		const b = await sh("printf '' | tee /usr/x; echo \"rc=$?\"; printf '' | tee -a /usr/x; echo \"rc=$?\"; printf '' | tee ok2 /usr/x; echo \"rc=$?\"; ls");
		assert.strictEqual(b.stdout, 'rc=1\nrc=1\nrc=1\nok2\n');
		assert.deepStrictEqual(own(b), ['tee: /usr/x: Permission denied', 'tee: /usr/x: Permission denied', 'tee: /usr/x: Permission denied']);
		assert.deepStrictEqual(shell(b), []);
		// what tee has to write is refused by the shell and not by the open (stdout is GNU's: `hi`; the status and the line are the shell's)
		const c = await sh("echo hi | tee /usr/x; echo \"rc=$?\"");
		assert.strictEqual(c.stdout, 'hi\nrc=0\n');
		assert.deepStrictEqual(shell(c), ['bash: /usr/x: Permission denied']);
		assert.strictEqual(c.exitCode, 1, 'and the command ends with a status that is not 0, its changes withheld');
	});

	test('xargs -s: what is exported takes its bytes from the upper limit (the name, the value in UTF-8, `=` and the NUL), for every size and every character width', async () => {
		const said = async (setup) => {
			const r = await sh(`${setup}xargs -s 99999999 echo < /dev/null`);
			const m = /value 99999999 for -s option should be <= (\d+)/.exec(r.stderr);
			assert.ok(m, r.stderr);
			return Number(m[1]);
		};
		const base = await said('');
		// the limit is ARG_MAX less 2048 less what the environment of the command holds: the shell's own few variables
		// (HOME, PATH, ...) are in `base`, and what is exported takes its bytes from there
		assert.ok(base < 2097152 - 2048 && base > 2097152 - 2048 - 1024, 'the shell\'s own environment is a few bytes: ' + base);
		let seed = 20261011;
		const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
		const widths = ['a', 'é', '€', '😀'];
		for (let round = 0; round < 40; round++) {
			const vars = [];
			let taken = 0;
			let setup = '';
			const n = 1 + Math.floor(rnd() * 4);
			for (let i = 0; i < n; i++) {
				const name = 'V' + round + '_' + i;
				const ch = widths[Math.floor(rnd() * widths.length)];
				const len = Math.floor(rnd() * 3000);
				const value = ch.repeat(len);
				vars.push([name, value]);
				taken += Buffer.byteLength(name) + Buffer.byteLength(value) + 2;
				setup += `export ${name}=${value}; `;
			}
			assert.strictEqual(await said(setup), Math.max(4096, base - taken), JSON.stringify(vars.map(([k, v]) => [k, v.length])));
		}
		// the floor: an environment bigger than the whole of it leaves 4096, and the same variable twice is one
		const twice = await said(`export BIG=${'x'.repeat(2000)}; export BIG=${'y'.repeat(3000)}; `);
		assert.strictEqual(twice, base - (3 + 3000 + 2), 'the same variable twice is one');
		const r = await sh('v=$(printf "%100000s" ""); for i in $(seq 1 25); do export "BIG$i=$v"; done; xargs -s 99999999 echo < /dev/null');
		assert.ok(/should be <= 4096\n/.test(r.stderr), r.stderr);
	});

	test('tee /dev/stdout: what a program writes there is its own output, in bytes (a byte that is not UTF-8 is one byte, twice), and goes through a pipe', async () => {
		// GNU: tee writes the bytes to standard output and to /dev/stdout, which is standard output again
		const r = await sh("printf 'h\\351llo\\n' | tee /dev/stdout | wc -c; printf 'a\\nb\\n' | tee /dev/stdout | sort | uniq -c");
		assert.strictEqual(r.stdout, '12\n      2 a\n      2 b\n');
		assert.strictEqual(r.stderr, '');
	});

	test('ls -n shows the owner and the group as numbers (the shell\'s one user is 1000)', async () => {
		const r = await sh("touch f; ls -n f | awk '{print $3, $4}'; ls -ln f | awk '{print $3, $4}'; ls --numeric-uid-gid f | awk '{print $3}'; ls -l f | awk '{print $3, $4}'");
		assert.strictEqual(r.stdout, '1000 1000\n1000 1000\n1000\nuser user\n');
	});

	test('-z and -Z are refused, with these words, where the exchange of NUL and newline cannot be done: -r for grep (but -Z with -l -L -c is), a, i, c, l, r, w, e and the M flag for sed', async () => {
		const r1 = await sh("printf 'a\\0' > f; grep -zr a .; echo \"rc=$?\"; grep -Zr a .; echo \"rc=$?\"; grep -rlZ a . | od -c | head -1", {});
		assert.strictEqual(r1.stderr, 'grep: -z cannot be used with -r in this shell\ngrep: -Z cannot be used with -r in this shell, except with -l, -L or -c\n');
		assert.strictEqual(r1.stdout, 'rc=2\nrc=2\n0000000   .   /   f  \\0\n');
		for (const [script, what] of [['1i\\\\x', 'the i command'], ['$a\\\\x', 'the a command'], ['c\\\\x', 'the c command'], ['l', 'the l command'], ['r f', 'the r command'], ['w f', 'the w command'], ['s/a/b/M', 'the M flag of the s command'], ['/a/M p', 'the M flag of an address'], ['s/a/b/w f', 'the w flag of the s command']]) {
			const r = await sh(`printf 'a\\0' | sed -z '${script}'`);
			assert.deepStrictEqual([r.stdout, r.stderr, r.exitCode], ['', `sed: -z cannot be combined with ${what} in this shell\n`, 1], script);
		}
	});

	/* ------------------------------------------------------------------------------------------ second pass: the parts */

	const zero = require(path.join(ENGINE_DIR, 'zero.js'));
	const trMod = require(path.join(ENGINE_DIR, 'tr.js'));
	const datestr = require(path.join(ENGINE_DIR, 'datestr.js'));
	const diffMod = require(path.join(ENGINE_DIR, 'diff.js'));
	const zoneMod = require(path.join(ENGINE_DIR, 'zone.js'));
	const runTr = (args, input) => {
		const r = trMod.run(args, Uint8Array.from(Buffer.from(input, 'latin1')));
		return 'passThrough' in r ? r : { out: Buffer.from(r.stdout).toString('latin1'), err: r.stderr, rc: r.exitCode };
	};

	test('zero.plan: the options that mean NUL are taken out of clusters, long names and valued options (a value keeps its place), and the operands are known', () => {
		const sortT = c.OPTION_VALUES.sort;
		const plan = (program, argv, table) => zero.plan(program, argv, table);
		const p1 = plan('sort', ['-zrk2', '-t', ':', '-o', 'out', 'f', 'g'], sortT);
		assert.strictEqual(p1.zero, true);
		assert.deepStrictEqual(p1.args, ['-r', '-k', '2', '-t', ':', '-o', 'out', 'f', 'g']);
		assert.deepStrictEqual(p1.files, [7, 8].map((n) => n));
		assert.strictEqual(p1.outputAt, 6, 'where -o names its file');
		const p2 = plan('sort', ['--zero-terminated', '--output=o', '--', '-z', 'f'], sortT);
		assert.strictEqual(p2.zero, true);
		assert.deepStrictEqual(p2.args, ['--output', 'o', '--', '-z', 'f'], 'after -- -z is a file name');
		assert.strictEqual(plan('sort', ['-r', 'f'], sortT).zero, false);
		const g = plan('grep', ['-zc', '-e', 'a', '-Z', 'f'], c.OPTION_VALUES.grep);
		assert.deepStrictEqual([g.zero, g.nul, g.args, g.files], [true, true, ['-c', '-e', 'a', 'f'], [3]]);
		const g2 = plan('grep', ['-Zl', 'pat', 'f', 'g'], c.OPTION_VALUES.grep);
		assert.deepStrictEqual([g2.zero, g2.nul, g2.files], [false, true, [2, 3]], 'the first operand is the pattern');
		const s = plan('sed', ['-z', '-s', '-n', '-e', 'p', 'f', 'g'], c.OPTION_VALUES.sed);
		assert.deepStrictEqual([s.zero, s.separate, s.scripts, s.files], [true, true, [2], [3, 4]]);
		const s2 = plan('sed', ['-iz.bak', 's/a/b/', 'f'], c.OPTION_VALUES.sed);
		assert.deepStrictEqual([s2.zero, s2.inPlace, s2.suffix], [false, true, 'z.bak'], '-i takes the rest of the cluster: the z is part of the suffix');
		const t = plan('tail', ['-zn', '+2', 'f'], c.OPTION_VALUES.tail);
		assert.deepStrictEqual([t.zero, t.args], [true, ['-n', '+2', 'f']]);
		assert.strictEqual(plan('printenv', ['-0', 'HOME'], undefined).zero, true);
		assert.strictEqual(plan('basename', ['--zero', '/a/b'], undefined).zero, true);
	});

	test('zero.grepOutputKind and grep -z: what a line of grep says it prints (names, counts, nothing, line numbers, context)', () => {
		const k = zero.grepOutputKind;
		assert.deepStrictEqual(k(['-l', 'a', 'f']), { names: true, count: false, quiet: false, lineNumber: false, context: false });
		assert.deepStrictEqual(k(['--files-without-match', 'a']), { names: true, count: false, quiet: false, lineNumber: false, context: false });
		assert.deepStrictEqual(k(['-c', '-n', '-A', '2', 'a']), { names: false, count: true, quiet: false, lineNumber: true, context: true });
		assert.deepStrictEqual(k(['-nC2', 'a']), { names: false, count: false, quiet: false, lineNumber: true, context: true });
		assert.deepStrictEqual(k(['-3', 'a']), { names: false, count: false, quiet: false, lineNumber: false, context: true });
		assert.deepStrictEqual(k(['-e', '-l', 'pat']), { names: false, count: false, quiet: false, lineNumber: false, context: false }, 'the value of -e is not an option');
		assert.deepStrictEqual(k(['-q', 'a']), { names: false, count: false, quiet: true, lineNumber: false, context: false });
		assert.deepStrictEqual(k(['--', '-l']), { names: false, count: false, quiet: false, lineNumber: false, context: false });
	});

	test('tail -z: headers are for several files, -v and -q (the last of them wins), and are taken out of what one file at a time is run with', () => {
		const h = zero.tailHeaders;
		assert.strictEqual(h(['-n', '1'], 1), false);
		assert.strictEqual(h(['-n', '1'], 2), true);
		assert.strictEqual(h(['-q'], 2), false);
		assert.strictEqual(h(['-v'], 1), true);
		assert.strictEqual(h(['-qv'], 1), true);
		assert.strictEqual(h(['-vq'], 2), false);
		assert.strictEqual(h(['--quiet', '--verbose'], 1), true);
		assert.strictEqual(h(['--verbose', '--silent'], 2), false);
		assert.strictEqual(h(['-n', '-q', 'x'], 2), true, 'the value of -n is not an option');
		assert.deepStrictEqual(zero.withoutHeaderOptions(['-qv', '-n', '2', '--verbose', '--', '-v']), ['-n', '2', '--', '-v']);
		assert.deepStrictEqual(zero.withoutHeaderOptions(['-qc', '3']), ['-c', '3']);
	});

	test('sed -z: `\\n` and a backslash before a real newline are the newline of the data, `\\x00` is the record end, and a, i, c, l, r, w, e and the M flag are refused (their output has a newline of its own)', () => {
		assert.strictEqual(zero.sedScriptIn('s/a/x\\ny/', '\u0001'), 's/a/x\u0001y/');
		assert.strictEqual(zero.sedScriptIn('s/a/x\\\ny/', '\u0001'), 's/a/x\u0001y/');
		assert.strictEqual(zero.sedScriptIn('N;s/\\x00/+/', '\u0001'), 'N;s/\\n/+/');
		assert.strictEqual(zero.sedScriptIn('s/\\\\n/N/', '\u0001'), 's/\\\\n/N/', 'an escaped backslash before n is not a newline');
		const refuse = zero.sedZeroRefusal;
		assert.strictEqual(refuse('1i\\HEAD'), 'the i command');
		assert.strictEqual(refuse('$a\\TAIL'), 'the a command');
		assert.strictEqual(refuse('/x/c\\NEW'), 'the c command');
		assert.strictEqual(refuse('l'), 'the l command');
		assert.strictEqual(refuse('r f'), 'the r command');
		assert.strictEqual(refuse('w f'), 'the w command');
		assert.strictEqual(refuse('s/a/b/w f'), 'the w flag of the s command');
		assert.strictEqual(refuse('s/a/b/M'), 'the M flag of the s command');
		assert.strictEqual(refuse('/a/M p'), 'the M flag of an address');
		for (const fine of ['s/a/b/g', 'y/ab/AB/', 'N;P;D', '$!N;s/\\n/ /', '2q', '/a/,/b/d', 's/a/b/;s/c/d/', 'x;G', '-n']) { assert.strictEqual(refuse(fine), null, fine); }
		assert.strictEqual(refuse('s/[a]/ /; # a comment'), null);
		const x = zero.pickPlaceholder(['a\u0001b', 'c']);
		assert.ok(!'a\u0001bc'.includes(x) && x !== '\n' && x !== '\0', 'a character that is not in the data');
		assert.strictEqual(zero.swapOut(zero.swapIn('a\nb\0c', x), x), 'a\nb\0c');
	});

	test('tr (tr.js): GNU\'s own, byte for byte: NUL in either set, every escape, ranges, classes, [c*n], -c -d -s -t, and its messages', () => {
		assert.deepStrictEqual(runTr(['\n', '\\0'], 'a\nb\n').out, 'a\0b\0');
		assert.deepStrictEqual(runTr(['\n', '\\000'], 'a\nb\n').out, 'a\0b\0');
		assert.deepStrictEqual(runTr(['\0', '\n'], 'a\0b\0').out, 'a\nb\n', 'a NUL typed into a set');
		assert.deepStrictEqual(runTr(['hi', '\\0\\1'], 'hi').out, '\0\x01');
		assert.deepStrictEqual(runTr(['-d', '\\0'], 'a\0b\0').out, 'ab');
		assert.deepStrictEqual(runTr(['-s', '\\0'], 'a\0\0b\0').out, 'a\0b\0');
		assert.deepStrictEqual(runTr(['h', '\\x00'], 'hi').out, 'xi', 'there is no \\xHH in GNU tr: the x and the zeros are characters, and the first one is the translation');
		assert.deepStrictEqual(runTr(['a-c', 'A-C'], 'abcd').out, 'ABCd');
		assert.deepStrictEqual(runTr(['[:lower:]', '[:upper:]'], 'abC1').out, 'ABC1');
		assert.deepStrictEqual(runTr(['-cd', '[:alpha:]'], 'a1b2').out, 'ab');
		assert.deepStrictEqual(runTr(['-cs', 'a-z', '\\n'], 'ab, cd').out, 'ab\ncd');
		assert.deepStrictEqual(runTr(['abcd', '[x*]'], 'abcd').out, 'xxxx');
		assert.deepStrictEqual(runTr(['abcd', '[x*2]yz'], 'abcd').out, 'xxyz');
		assert.deepStrictEqual(runTr(['-t', 'abcd', 'xy'], 'abcd').out, 'xycd');
		assert.deepStrictEqual(runTr(['\\101-\\103', 'a-c'], 'ABCD').out, 'abcD');
		assert.deepStrictEqual(runTr(['é', 'e'], '\xc3\xa9').out, 'ee', 'bytes, not characters: é is two bytes, each of them is translated (GNU coreutils 8.32 says ee)');
		const bad = runTr(['z-a', 'x'], 'q');
		assert.deepStrictEqual([bad.rc, bad.err], [1, "tr: range-endpoints of 'z-a' are in reverse collating sequence order\n"]);
		assert.strictEqual(runTr(['[:foo:]', 'x'], 'q').err, "tr: invalid character class 'foo'\n");
		assert.strictEqual(runTr(['a'], 'q').err, "tr: missing operand after 'a'\nTwo strings must be given when translating.\nTry 'tr --help' for more information.\n");
		assert.strictEqual(runTr([], '').err, "tr: missing operand\nTry 'tr --help' for more information.\n");
		assert.strictEqual(runTr(['a', '[:digit:]'], 'q').err, "tr: when translating, the only character classes that may appear in\nstring2 are 'upper' and 'lower'\n");
		assert.deepStrictEqual(runTr(['--help'], ''), { passThrough: true });
	});

	test('date -d (datestr.js): the relative forms, a date and a relative part, a signed number after a time is a zone, `ago`, an offset over a day, and what GNU\'s grammar does not take is an invalid date', () => {
		const at = (s, now = Date.UTC(2024, 6, 4, 12, 0, 0)) => {
			const r = datestr.parse(s, now, 'UTC');
			return 'invalid' in r ? 'invalid' : new Date(r.ms).toISOString().slice(0, 19).replace('T', ' ');
		};
		// GNU date's own answers (coreutils 8.32, TZ=UTC), recorded once; every string has a date, so the clock is never read
		const t = [
			['2024-07-04 +1 week', '2024-07-11 00:00:00'],
			['2024-07-04 12:00 +1 day', '2024-07-05 11:00:00'],
			['2024-07-04 1 day ago', '2024-07-03 00:00:00'],
			['2024-07-04 2 hours ago', '2024-07-03 22:00:00'],
			['20240704', '2024-07-04 00:00:00'],
			['20240704 1530', '2024-07-04 15:30:00'],
			['2024-01-31 +1 month', '2024-03-02 00:00:00'],
			['2024-02-29 +1 year', '2025-03-01 00:00:00'],
			['2024-07-04 next friday', '2024-07-04 00:00:00'],
			['2024-07-04 last monday', '2024-07-04 00:00:00'],
			['2024-07-04 3pm', '2024-07-04 15:00:00'],
			['2024-07-04T12:00:30', '2024-07-04 12:00:30'],
			['Thu, 04 Jul 2024 12:00:00 +0200', '2024-07-04 10:00:00'],
			['2023-02-29', 'invalid'],
			['2024-07-04 18:00 +42 days', 'invalid'],
			['2024-07-04 18:00 +25 days', 'invalid'],
			['2024-07-04 18:00 +15 days', '2024-07-05 03:00:00'],
			['2024-07-04 18:00 +100 days', '2024-07-05 17:00:00'],
			['Jul 4 2024 +1 day ago', 'invalid'],
			['2024-07-04 +1 day ago', '2024-07-03 00:00:00'],
			['Jul 4, 2024 +1 day ago', '2024-07-03 00:00:00'],
			['2024-07-04 18:00 UTC +1 day ago', 'invalid'],
			['2024-07-04 18:00 EDT +1 day ago', '2024-07-03 22:00:00'],
			['ago 2000-02-29', 'invalid'],
			['2024-07-04 last hr', 'invalid'],
			['2024-07-04 ,', 'invalid'],
			['2024-07-04 #1', 'invalid'],
			['2024-07-04 [1]', 'invalid'],
			['2024-07-04 "x"', 'invalid'],
			['garbage', 'invalid'],
			['Thu, 04 Jul 2024', '2024-07-04 00:00:00'],
			['2024-07-04 12:00 EST', '2024-07-04 17:00:00'],
			['2024-07-04 noon', 'invalid'],
			['2024-07-04 tomorrow', '2024-07-05 00:00:00'],
			['2024-07-04 12:00:00.5', '2024-07-04 12:00:00'],
		];
		for (const [s, want] of t) { assert.strictEqual(at(s), want, s); }
	});

	test('diff.js: the number of context lines is the greatest -U/-C value, a bare -u or -c is three unless there is a -NUM, and -NUM is its own', () => {
		const ctx = (args) => { const r = diffMod.parseOptions(args.concat(['a', 'b'])); return 'o' in r ? r.o.context : r; };
		const t = [
			[['-u'], 3], [['-U0'], 0], [['-U1'], 1], [['-U5'], 5], [['--unified'], 3], [['--unified=1'], 1], [['-c'], 3], [['-C1'], 1],
			[['-1'], 1], [['-5'], 5], [['-u', '-1'], 1], [['-1', '-u'], 1], [['-c', '-2'], 2], [['-u', '-U1'], 3], [['-U1', '-u'], 3],
			[['-U0', '-u'], 3], [['-u', '-U0'], 3], [['-U2', '-U0'], 2], [['-U0', '-U2'], 2], [['-U1', '-U', '2'], 2], [['-3', '-U1'], 3],
			[['-1', '-U2'], 2], [['-U0', '-1'], 1], [['-C2', '-C0'], 2], [['-w', '-U1'], 1], [['-w', '-u'], 3], [['-ruU1'], 3], [['-rU0'], 0],
		];
		for (const [args, want] of t) { assert.strictEqual(ctx(args), want, args.join(' ')); }
	});

	test('diff.js shiftBoundaries (analyze.c): a change that can sit in more than one place is where GNU puts it (slid back to meet its neighbour, else forward as far as it goes)', () => {
		const same = (a, b) => (left, i, j) => (left ? a[i] === a[j] : b[i] === b[j]);
		const run = (a, b, changes) => diffMod.shiftBoundaries(changes, a.length, b.length, same(a, b));
		// an added `b` among three: after the last of them (GNU: `3a4`)
		assert.deepStrictEqual(run(['a', 'b', 'b', 'c'], ['a', 'b', 'b', 'b', 'c'], [{ a1: 3, a2: 2, b1: 3, b2: 3 }]), [{ a1: 4, a2: 3, b1: 4, b2: 4 }]);
		// the engine's own comparison put it before an equal line; GNU puts it after (`2a3`)
		assert.deepStrictEqual(run(['ONE', 'end', 'z'], ['ONE', 'end', 'end', 'z'], [{ a1: 2, a2: 1, b1: 2, b2: 2 }]), [{ a1: 3, a2: 2, b1: 3, b2: 3 }]);
		// a change between different lines has nowhere to go
		assert.deepStrictEqual(run(['x', 'y', 'z'], ['x', 'Q', 'z'], [{ a1: 2, a2: 2, b1: 2, b2: 2 }]), [{ a1: 2, a2: 2, b1: 2, b2: 2 }]);
		assert.deepStrictEqual(run(['a'], ['a'], []), []);
	});

	test('sort -k: parseSortKey is strtoumax\'s (blanks, a plus sign), the end field of 0 is the error, the canonical text is what the engine reads', () => {
		const k = (s) => c.parseSortKey(s);
		assert.deepStrictEqual(k('+1'), { spec: '1', start: '', end: '' });
		assert.deepStrictEqual(k(' 1'), { spec: '1', start: '', end: '' });
		assert.deepStrictEqual(k('+2n'), { spec: '2n', start: 'n', end: '' });
		assert.deepStrictEqual(k(' +2n,2'), { spec: '2n,2', start: 'n', end: '' });
		assert.deepStrictEqual(k('1.2,3.4r'), { spec: '1.2,3.4r', start: '', end: 'r' });
		assert.deepStrictEqual(k('1,+1'), { spec: '1,1', start: '', end: '' });
		assert.deepStrictEqual(k('1.1b,1'), { spec: '1.1b,1', start: 'b', end: '' });
		assert.ok(!('error' in k('99999999999999999999,1')), 'a number too big for a long is the greatest one (strtoumax saturates), not an error');
		for (const [spec, message] of [
			['0', "field number is zero: invalid field specification '0'"],
			['1,0', "field number is zero: invalid field specification '1,0'"],
			['1.0', "character offset is zero: invalid field specification '1.0'"],
			['', "invalid number at field start: invalid count at start of ''"],
			['x', "invalid number at field start: invalid count at start of 'x'"],
			['-1', "invalid number at field start: invalid count at start of '-1'"],
			['1,', "invalid number after ',': invalid count at start of ''"],
			['1.', "invalid number after '.': invalid count at start of ''"],
			['1a', "stray character in field spec: invalid field specification '1a'"],
			['1x2', "stray character in field spec: invalid field specification '1x2'"],
		]) { assert.deepStrictEqual(k(spec), { error: message }, JSON.stringify(spec)); }
		assert.deepStrictEqual(c.sortKeys(['-k', '1nM']), { error: "options '-Mn' are incompatible" });
		assert.deepStrictEqual(c.sortKeys(['-n', '-M']), { error: "options '-Mn' are incompatible" });
		assert.deepStrictEqual(c.sortKeys(['-k', '+2']), { args: ['-k', '2'] });
		// the global letters go to a key that has none of its own, and what is left of -r is the last resort (a key `-k1r`)
		assert.deepStrictEqual(c.sortKeys(['-k', '+2', '-r']), { args: ['-k', '2r', '-k', '1r'] });
	});

	test('round 6: a cluster is cut at the letter that takes a value, `--` ends the options, operands are told from values, a key with no letters of its own gets the global ones', () => {
		const split = (p, ...a) => c.splitClusters(p, a);
		assert.deepStrictEqual(split('grep', '-nA1', 'TODO', 'f'), ['-n', '-A', '1', 'TODO', 'f']);
		assert.deepStrictEqual(split('grep', '-iA2'), ['-i', '-A', '2']);
		assert.deepStrictEqual(split('grep', '-rnC', '2'), ['-rn', '-C', '2'], 'the letters before the valued one stay together');
		assert.deepStrictEqual(split('grep', '-cm1'), ['-c', '-m', '1']);
		assert.deepStrictEqual(split('grep', '-A1', '-B1'), ['-A', '1', '-B', '1']);
		assert.deepStrictEqual(split('grep', '-e', '-nA1', 'f'), ['-e', '-nA1', 'f'], 'the value of -e is not an option');
		assert.deepStrictEqual(split('grep', '--', '-nA1'), ['--', '-nA1']);
		assert.deepStrictEqual(split('grep', '--max-count', '-nA1', 'f'), ['--max-count', '-nA1', 'f']);
		assert.deepStrictEqual(split('head', '-qn1', 'f', 'g'), ['-q', '-n', '1', 'f', 'g']);
		assert.deepStrictEqual(split('head', '-n', '-3', 'f'), ['-n', '-3', 'f']);
		assert.deepStrictEqual(split('tail', '-vc3'), ['-v', '-c', '3']);
		assert.deepStrictEqual(split('cut', '-sf1', '-d', ','), ['-s', '-f', '1', '-d', ',']);
		assert.deepStrictEqual(split('cut', '-nc1-3'), ['-c', '1-3'], 'cut -n means nothing and is dropped');
		assert.deepStrictEqual(split('cut', '-sd,', '-f1'), ['-s', '-d', ',', '-f', '1']);
		assert.deepStrictEqual(split('cut', '-n'), []);
		assert.deepStrictEqual(split('touch', '-ct', '202001010000', 'f'), ['-c', '-t', '202001010000', 'f']);
		assert.deepStrictEqual(split('paste', '-sd,', 'f'), ['-s', '-d', ',', 'f']);
		assert.deepStrictEqual(split('sed', '-ni', 'p'), ['-n', '-i', 'p'], 'a letter with an optional value ends the cluster: it and its rest are an argument of their own');
		assert.deepStrictEqual(split('sed', '-ni.bak', 'p'), ['-n', '-i.bak', 'p']);
		assert.deepStrictEqual(split('date', '-uIminutes'), ['-u', '-Iminutes']);
		assert.deepStrictEqual(split('date', '-ur', 'f'), ['-u', '-r', 'f']);
		assert.deepStrictEqual(split('basename', '-as', '.js', 'a.js'), ['-a', '-s', '.js', 'a.js']);
		assert.deepStrictEqual(split('xargs', '-n1', 'echo', '-nA1'), ['-n', '1', 'echo', '-nA1'], 'xargs stops at its command');
		assert.deepStrictEqual(c.endOptions('head', ['-n1', '--', '-x', 'f', '-']), ['-n1', './-x', 'f', '-']);
		assert.deepStrictEqual(c.endOptions('head', ['-n', '--', 'f']), ['-n', '--', 'f'], '`--` is the value of -n here, as in getopt');
		assert.deepStrictEqual(c.endOptions('head', ['-n1', 'f']), ['-n1', 'f']);
		assert.deepStrictEqual(c.operandIndexes('sort', ['-k', '2', '-', 'f']), [2, 3]);
		assert.deepStrictEqual(c.operandIndexes('sort', ['-nk', '2', '--', '-x', '-']), [3, 4]);
		assert.deepStrictEqual(c.operandIndexes('head', ['-qn1', 'a', '-']), [1, 2]);
		const keys = (...a) => c.sortKeys(a).args;
		assert.deepStrictEqual(keys('-n', '-k', '2'), ['-k', '2n']);
		assert.deepStrictEqual(keys('-n', '-k', '1,1r'), ['-k', '1,1r'], 'a key with its own letters takes none');
		assert.deepStrictEqual(keys('-r', '-k', '2n'), ['-k', '2n', '-k', '1r'], 'the last resort is what -r reverses');
		assert.deepStrictEqual(keys('-rs', '-k', '2,2'), ['-s', '-k', '2r,2'], '-s has no last resort');
		assert.deepStrictEqual(keys('-ru', '-k', '2,2n'), ['-u', '-k', '2,2n']);
		assert.deepStrictEqual(keys('-nb', '-k', '2,3'), ['-k', '2nb,3b'], 'b is for the start and the end of the key');
		assert.deepStrictEqual(keys('--reverse', '-t', ',', '-k', '2'), ['-t', ',', '-k', '2r', '-k', '1r']);
		assert.deepStrictEqual(keys('-n'), ['-n'], 'with no key the engine has it as it is');
		assert.strictEqual(diffMod.quoteName('a b'), '"a b"');
		assert.strictEqual(diffMod.quoteName('a"b'), '"a\\"b"');
		assert.strictEqual(diffMod.quoteName('a\\b'), '"a\\\\b"');
		assert.strictEqual(diffMod.quoteName('a\tb'), '"a\\tb"');
		assert.strictEqual(diffMod.quoteName('a\nb'), '"a\\nb"');
		assert.strictEqual(diffMod.quoteName('a\u0001b'), '"a\\001b"');
		for (const plain of ["a'b", 'a$b', 'a*b', 'aéb', 'a#b', 'd1/a-b', '-', '/dev/null']) { assert.strictEqual(diffMod.quoteName(plain), plain, plain); }
	});

	test('round 6: a copy the 8 MiB cap refuses is "memory exhausted" (diff, the -z family), not "no difference" and not an empty file over the real one', async () => {
		const h = await host({});
		const r = await h.run("head -c 900000 /dev/zero | tr '\\0' a > x; echo b >> x; head -c 900000 /dev/zero | tr '\\0' a > y; echo c >> y; for i in 1 2 3 4 5 6 7; do cp x big$i; done; echo keep > small; diff -w x y; echo rc=$?; diff -q -i x y; echo rc=$?; sort -z -o small x y; echo rc=$?; cat small; grep -z -c b x y; echo rc=$?");
		assert.strictEqual(r.stdout, 'rc=2\nrc=2\nrc=2\nkeep\nrc=2\n');
		for (const who of ['diff', 'sort', 'grep']) { assert.ok(r.stderr.includes(`${who}: memory exhausted\n`), who + ': ' + r.stderr); }
		// the copies fit and the output file does not: the real file is left alone, not written over with nothing
		const h2 = await host({});
		const r2 = await h2.run("head -c 450000 /dev/zero | tr '\\0' a > x; echo b >> x; head -c 450000 /dev/zero | tr '\\0' a > y; echo c >> y; head -c 1000000 /dev/zero | tr '\\0' z > b1; for i in 2 3 4 5 6; do cp b1 b$i; done; echo keep > small; sort -z -o small x y; echo rc=$?; cat small");
		assert.strictEqual(r2.stdout, 'rc=2\nkeep\n');
		assert.ok(r2.stderr.includes('sort: memory exhausted\n') && r2.stderr.includes('/out: not written'), r2.stderr);
	});

	test('round 6: a class name or a repeat count of a million characters is said (tr), never a stack overflow; diff -x reads a glob by table', () => {
		const big = 'a'.repeat(1000000);
		const r = trMod.run(['[:' + big + ':]', 'b'], new Uint8Array(0));
		assert.ok(/^tr: invalid character class '/.test(r.stderr) && r.exitCode === 1, r.stderr.slice(0, 80));
		const d = trMod.run(['a', '[b*' + '1'.repeat(1000000) + ']'], new Uint8Array(0));
		assert.ok(/^tr: invalid repeat count '/.test(d.stderr) && d.exitCode === 1, d.stderr.slice(0, 80));
		const m = diffMod.globMatcher('a*a*a*a*a*a*a*a*a*a*a*a*b');
		assert.strictEqual(m.test('a'.repeat(5000) + 'c'), false);
		assert.strictEqual(m.test('a'.repeat(30) + 'b'), true);
		assert.strictEqual(diffMod.globMatcher('[z-a]').test('m'), false);
		assert.strictEqual(diffMod.globMatcher('[!z]*').test('abc'), true);
		assert.strictEqual(diffMod.globMatcher('x\\*').test('x*'), true);
		assert.strictEqual(diffMod.globMatcher('x\\*').test('xy'), false);
	});

	test('seq -f: one conversion of e E f F g G, `%%`, width and precision, and GNU\'s words for the rest', () => {
		const f = (...a) => c.seqFormatted(a);
		assert.deepStrictEqual(f('-f', '%02g', '1', '3'), { stdout: '01\n02\n03\n', stderr: '', exitCode: 0 });
		assert.strictEqual(f('-f', '%.2f', '1', '0.5', '2').stdout, '1.00\n1.50\n2.00\n');
		assert.strictEqual(f('-f', 'n%g', '-s', ',', '1', '3').stdout, 'n1,n2,n3\n');
		assert.strictEqual(f('-f', '%e', '1', '2').stdout, '1.000000e+00\n2.000000e+00\n');
		assert.strictEqual(f('-f', '%%d %g', '1', '2').stdout, '%d 1\n%d 2\n');
		assert.strictEqual(f('-f', '%5.1f', '3', '-1', '1').stdout, '  3.0\n  2.0\n  1.0\n');
		assert.strictEqual(f('-f', '%x', '1', '2').stderr, "seq: format '%x' has unknown %x directive\n");
		assert.strictEqual(f('-f', '%g%g', '1', '2').stderr, "seq: format '%g%g' has too many % directives\n");
		assert.strictEqual(f('-f', 'a', '1', '2').stderr, "seq: format 'a' has no % directive\n");
		assert.strictEqual(f('1', '3'), null, 'no -f: the engine\'s');
	});

	test('zero.js, branch by branch: the options of grep, sed, sort and the rest that mean NUL (clusters, long names with and without `=`, valued options), the placeholder for the newline, what a sed script cannot carry, the script as the exchange needs it, what a grep line prints, and the headers of tail', () => {
		// [program, arguments, what `plan` makes of them: zero, nul, args, files, scripts, scriptFiles, outputAt, suffix, inPlace, separate]
		const plans = [
			["grep", ["-z","one","a"], [true,false,["one","a"],[1],[],[],-1,null,false,false]],
			["egrep", ["-z","one|two","a"], [true,false,["one|two","a"],[1],[],[],-1,null,false,false]],
			["fgrep", ["-z","one","a"], [true,false,["one","a"],[1],[],[],-1,null,false,false]],
			["grep", ["-e","one","a","b"], [false,false,["-e","one","a","b"],[2,3],[],[],-1,null,false,false]],
			["grep", ["-zeone","a"], [true,false,["-e","one","a"],[2],[],[],-1,null,false,false]],
			["grep", ["--regexp","one","a"], [false,false,["--regexp","one","a"],[2],[],[],-1,null,false,false]],
			["grep", ["--regexp=one","a"], [false,false,["--regexp","one","a"],[2],[],[],-1,null,false,false]],
			["grep", ["-f","pat","a"], [false,false,["-f","pat","a"],[2],[],[],-1,null,false,false]],
			["grep", ["--file","pat","a"], [false,false,["--file","pat","a"],[2],[],[],-1,null,false,false]],
			["grep", ["--file=pat","a"], [false,false,["--file","pat","a"],[2],[],[],-1,null,false,false]],
			["grep", ["-zf","pat","a"], [true,false,["-f","pat","a"],[2],[],[],-1,null,false,false]],
			["grep", ["-Z","-l","o","a"], [false,true,["-l","o","a"],[2],[],[],-1,null,false,false]],
			["grep", ["--null","-l","o","a"], [false,true,["-l","o","a"],[2],[],[],-1,null,false,false]],
			["grep", ["--null=1","o","a"], [false,false,["--null=1","o","a"],[2],[],[],-1,null,false,false]],
			["grep", ["--null-data","-c","o","a"], [true,false,["-c","o","a"],[2],[],[],-1,null,false,false]],
			["grep", ["-zZ","o","a"], [true,true,["o","a"],[1],[],[],-1,null,false,false]],
			["grep", ["-ZzL","o","a"], [true,true,["-L","o","a"],[2],[],[],-1,null,false,false]],
			["grep", ["-z","-A","1","o","a"], [true,false,["-A","1","o","a"],[3],[],[],-1,null,false,false]],
			["grep", ["-zA1","o","a"], [true,false,["-A","1","o","a"],[3],[],[],-1,null,false,false]],
			["grep", ["--after-context=1","-z","o","a"], [true,false,["--after-context","1","o","a"],[3],[],[],-1,null,false,false]],
			["grep", ["--after-context","1","-z","o","a"], [true,false,["--after-context","1","o","a"],[3],[],[],-1,null,false,false]],
			["grep", ["-z","--","-x","a"], [true,false,["--","-x","a"],[2],[],[],-1,null,false,false]],
			["grep", ["-z","o","-"], [true,false,["o","-"],[1],[],[],-1,null,false,false]],
			["sed", ["-z","s/o/0/","a"], [true,false,["s/o/0/","a"],[1],[0],[],-1,null,false,false]],
			["sed", ["--null-data","s/o/0/","a"], [true,false,["s/o/0/","a"],[1],[0],[],-1,null,false,false]],
			["sed", ["--zero-terminated","s/o/0/","a"], [true,false,["s/o/0/","a"],[1],[0],[],-1,null,false,false]],
			["sed", ["-z","-e","s/o/0/","-e","s/t/T/","a"], [true,false,["-e","s/o/0/","-e","s/t/T/","a"],[4],[1,3],[],-1,null,false,false]],
			["sed", ["-ze","s/o/0/","a"], [true,false,["-e","s/o/0/","a"],[2],[1],[],-1,null,false,false]],
			["sed", ["--expression","s/o/0/","a"], [false,false,["--expression","s/o/0/","a"],[2],[1],[],-1,null,false,false]],
			["sed", ["--expression=s/o/0/","a"], [false,false,["--expression","s/o/0/","a"],[2],[1],[],-1,null,false,false]],
			["sed", ["-z","-f","s.sed","a"], [true,false,["-f","s.sed","a"],[2],[],[1],-1,null,false,false]],
			["sed", ["-zf","s.sed","a"], [true,false,["-f","s.sed","a"],[2],[],[1],-1,null,false,false]],
			["sed", ["--file=s.sed","-z","a"], [true,false,["--file","s.sed","a"],[2],[],[1],-1,null,false,false]],
			["sed", ["--file","s.sed","-z","a"], [true,false,["--file","s.sed","a"],[2],[],[1],-1,null,false,false]],
			["sed", ["-s","-n","$p","a","b"], [false,false,["-n","$p","a","b"],[2,3],[1],[],-1,null,false,true]],
			["sed", ["-ns","$p","a","b"], [false,false,["-n","$p","a","b"],[2,3],[1],[],-1,null,false,true]],
			["sed", ["-sn","$p","a","b"], [false,false,["-n","$p","a","b"],[2,3],[1],[],-1,null,false,true]],
			["sed", ["--separate","-n","$p","a","b"], [false,false,["-n","$p","a","b"],[2,3],[1],[],-1,null,false,true]],
			["sed", ["-i","s/o/0/","a"], [false,false,["-i","s/o/0/","a"],[2],[1],[],-1,null,true,false]],
			["sed", ["-i.bak","s/o/0/","a"], [false,false,["-i","s/o/0/","a"],[2],[1],[],-1,".bak",true,false]],
			["sed", ["--in-place","s/o/0/","a"], [false,false,["--in-place","s/o/0/","a"],[2],[1],[],-1,null,true,false]],
			["sed", ["--in-place=.bak","s/o/0/","a"], [false,false,["--in-place","s/o/0/","a"],[2],[1],[],-1,".bak",true,false]],
			["sed", ["-zi","s/o/0/","a"], [true,false,["-i","s/o/0/","a"],[2],[1],[],-1,null,true,false]],
			["sed", ["-zni.bak","p","a"], [true,false,["-ni","p","a"],[2],[1],[],-1,".bak",true,false]],
			["sed", ["-n","-z","$p","a","b"], [true,false,["-n","$p","a","b"],[2,3],[1],[],-1,null,false,false]],
			["sed", ["-E","-z","s/(o)/\\1/","a"], [true,false,["-E","s/(o)/\\1/","a"],[2],[1],[],-1,null,false,false]],
			["sort", ["-z","a"], [true,false,["a"],[0],[],[],-1,null,false,false]],
			["sort", ["--zero-terminated","a"], [true,false,["a"],[0],[],[],-1,null,false,false]],
			["sort", ["-zo","out","a"], [true,false,["-o","out","a"],[2],[],[],1,null,false,false]],
			["sort", ["-o","out","-z","a"], [true,false,["-o","out","a"],[2],[],[],1,null,false,false]],
			["sort", ["--output=out","a"], [false,false,["--output","out","a"],[2],[],[],1,null,false,false]],
			["sort", ["--output","out","a"], [false,false,["--output","out","a"],[2],[],[],1,null,false,false]],
			["sort", ["-k2","-z","a"], [true,false,["-k","2","a"],[2],[],[],-1,null,false,false]],
			["sort", ["-t",":","-z","a"], [true,false,["-t",":","a"],[2],[],[],-1,null,false,false]],
			["sort", ["-zrn","a"], [true,false,["-rn","a"],[1],[],[],-1,null,false,false]],
			["uniq", ["-z","a","out"], [true,false,["a","out"],[0,1],[],[],-1,null,false,false]],
			["cut", ["-z","-d",":","-f","1","a"], [true,false,["-d",":","-f","1","a"],[4],[],[],-1,null,false,false]],
			["cut", ["-zd:","-f1","a"], [true,false,["-d",":","-f","1","a"],[4],[],[],-1,null,false,false]],
			["tail", ["-z","-n","2","a","b"], [true,false,["-n","2","a","b"],[2,3],[],[],-1,null,false,false]],
			["tail", ["-zn2","a"], [true,false,["-n","2","a"],[2],[],[],-1,null,false,false]],
			["printenv", ["-0","HOME"], [true,false,["HOME"],[0],[],[],-1,null,false,false]],
			["printenv", ["--null","HOME"], [true,false,["HOME"],[0],[],[],-1,null,false,false]],
			["basename", ["-z","a/b"], [true,false,["a/b"],[0],[],[],-1,null,false,false]],
			["basename", ["--zero","a/b"], [true,false,["a/b"],[0],[],[],-1,null,false,false]],
			["paste", ["-z","a","b"], [true,false,["a","b"],[0,1],[],[],-1,null,false,false]],
			["comm", ["-z","a","b"], [true,false,["a","b"],[0,1],[],[],-1,null,false,false]],
			["join", ["-z","-t",":","a","b"], [true,false,["-t",":","a","b"],[2,3],[],[],-1,null,false,false]],
			["head", ["-z","-n","1","a"], [true,false,["-n","1","a"],[2],[],[],-1,null,false,false]],
		];
		const placeholders = [
			[[""], "\u000b"],
			[["abc"], "\u000b"],
			[["\u0001"], "\u000b"],
			[["\u0001\u0002"], "\u000b"],
			[["\u0001\u0002\u0003\u0004\u0005\u0006\u0007\b\t"], "\u000b"],
			[["\u000b"], "\u0001"],
			[["\u000b\f"], "\u0001"],
			[["\u000b\f\r\u000e\u000f\u0010\u0011\u0012\u0013\u0014\u0015\u0016\u0017\u0018\u0019\u001a\u001b\u001c\u001d\u001e\u001f"], "\u0001"],
			[["\u0001\u000b"], "\u0002"],
			[["\u0005\u000b"], "\u0006"],
			[["\u001f"], "\u000b"],
			[["a\u0000b\nc"], "\u000b"],
			[["\t\u001f"], "\u000b"],
			[["\b"], "\u000b"],
			[["\n\u0000"], "\u000b"],
			[["x","\u0001","\u000b"], "\u0002"],
			[["\ue000"], "\u000b"],
			[["\u0001\u0002\u0003\u0004\u0005\u0006\u0007\b\t\u000b\f\r\u000e\u000f\u0010\u0011\u0012\u0013\u0014\u0015\u0016\u0017\u0018\u0019\u001a\u001b\u001c\u001d\u001e\u001f"], "\ue000"],
		];
		const refusals = [
			["s/a/b/", null],
			["a\\text", "the a command"],
			["a text", "the a command"],
			["$a x", "the a command"],
			["2i x", "the i command"],
			["c\\x", "the c command"],
			["r file", "the r command"],
			["R file", "the R command"],
			["w file", "the w command"],
			["W file", "the W command"],
			["F", "the F command"],
			["e", "the e command"],
			["l", "the l command"],
			["l 5", "the l command"],
			["1!l", "the l command"],
			["y/abc/xyz/", null],
			["s/a/b/M", "the M flag of the s command"],
			["s/a/b/m", "the M flag of the s command"],
			["s/a/b/w out", "the w flag of the s command"],
			["s/a/b/e", "the e flag of the s command"],
			["s/a/b/gp", null],
			["s/a/b/I", null],
			["/x/M p", "the M flag of an address"],
			["/x/I p", null],
			["/x/IM p", "the M flag of an address"],
			["\\,x,M p", "the M flag of an address"],
			["\\,x,Ip", null],
			["1,3d", null],
			["2,~4p", null],
			["$!d", null],
			["/a/,/b/d", null],
			["/a/ , /b/ d", null],
			["1~2p", null],
			["0~3p", null],
			["+2p", null],
			["s|a|b|", null],
			["s/[/]/x/", null],
			["s/a\\/b/x/", null],
			["b end", null],
			[":a;N;$!ba;s/\\n/ /g", null],
			["t end", null],
			["T x", null],
			["b;p", null],
			[":a", null],
			[": a", null],
			["/a/b x;l", "the l command"],
			["q", null],
			["q5", null],
			["Q 3", null],
			["q 5;l", "the l command"],
			["L", null],
			["{p;p}", null],
			["# comment l", null],
			["p # w x", null],
			["p;\n#c\nl", "the l command"],
			["/[a/b]/l", "the l command"],
			["s/a/b/;s/c/d/w", "the w flag of the s command"],
			["y/a/b/;l", "the l command"],
			["1{p;a x}", "the a command"],
			["/a/!{p;i x}", "the i command"],
			["1!G;h;$!d", null],
			["$!N;P;D", null],
			["n;d", null],
			["s/\\(a\\)\\|b/\\1/", null],
			["s/a/\\n/", null],
			["s,a\\,b,c,", null],
			["sxaxbx", null],
			["/a/s//b/", null],
			["s/a/b/;;p", null],
			["p;l;p", "the l command"],
		];
		const scripts = [
			["s/a/\\n/", "s/a/\u0001/"],
			["s/a\\nb/X/", "s/a\u0001b/X/"],
			["s/a/b\\\nc/", "s/a/b\u0001c/"],
			["s/\\x00/X/", "s/\\n/X/"],
			["s/\\o0/X/", "s/\\n/X/"],
			["s/\\d0/X/", "s/\\n/X/"],
			["s/\\x0a/X/", "s/\\x0a/X/"],
			["s/\\x41/X/", "s/\\x41/X/"],
			["s/\\x4/X/", "s/\\x4/X/"],
			["s/\\x000/X/", "s/\\n0/X/"],
			["s/\\o000/X/", "s/\\n/X/"],
			["s/\\d000/X/", "s/\\n/X/"],
			["s/\\d256/X/", "s/\\d256/X/"],
			["y/\\n/ /", "y/\u0001/ /"],
			["s/a\\\\nb/X/", "s/a\\\\nb/X/"],
			["s/a/\\\\n/", "s/a/\\\\n/"],
			["p\np", "p\np"],
			["s/a/\\", "s/a/\\"],
			["\\", "\\"],
			["s/\\q/X/", "s/\\q/X/"],
			["s/\\o/X/", "s/\\o/X/"],
			["s/\\d/X/", "s/\\d/X/"],
			["s/\\x/X/", "s/\\x/X/"],
			["s/\\n\\n/X/", "s/\u0001\u0001/X/"],
		];
		// [arguments, names, count, quiet, lineNumber, context]
		const kinds = [
			[["-c","o"], [false,true,false,false,false]],
			[["--count","o"], [false,true,false,false,false]],
			[["-l","o"], [true,false,false,false,false]],
			[["--files-with-matches","o"], [true,false,false,false,false]],
			[["-L","o"], [true,false,false,false,false]],
			[["--files-without-match","o"], [true,false,false,false,false]],
			[["-q","o"], [false,false,true,false,false]],
			[["--quiet","o"], [false,false,true,false,false]],
			[["--silent","o"], [false,false,true,false,false]],
			[["-n","o"], [false,false,false,true,false]],
			[["--line-number","o"], [false,false,false,true,false]],
			[["-A","2","o"], [false,false,false,false,true]],
			[["-B","2","o"], [false,false,false,false,true]],
			[["-C","2","o"], [false,false,false,false,true]],
			[["-A2","o"], [false,false,false,false,true]],
			[["--after-context=2","o"], [false,false,false,false,true]],
			[["--before-context","2","o"], [false,false,false,false,true]],
			[["--context=2","o"], [false,false,false,false,true]],
			[["-2","o"], [false,false,false,false,true]],
			[["-12","o"], [false,false,false,false,true]],
			[["-c2","o"], [false,true,false,false,true]],
			[["-e","c","o"], [false,false,false,false,false]],
			[["-ec","o"], [false,false,false,false,false]],
			[["-f","n","o"], [false,false,false,false,false]],
			[["-m","1","-c","o"], [false,true,false,false,false]],
			[["--max-count=1","o"], [false,false,false,false,false]],
			[["--max-count","1","o"], [false,false,false,false,false]],
			[["-d","skip","o"], [false,false,false,false,false]],
			[["--include","*.c","o"], [false,false,false,false,false]],
			[["--include=*.c","-l","o"], [true,false,false,false,false]],
			[["--","-c","o"], [false,false,false,false,false]],
			[["-","o"], [false,false,false,false,false]],
			[["o","-c"], [false,true,false,false,false]],
			[["-hc","o"], [false,true,false,false,false]],
			[["-cn","o"], [false,true,false,true,false]],
			[["-lq","o"], [true,false,true,false,false]],
			[["--exclude-dir","x","-n","o"], [false,false,false,true,false]],
			[["--label","x","-c"], [false,true,false,false,false]],
			[["--color","-c"], [false,true,false,false,false]],
			[["-x1","o"], [false,false,false,false,true]],
			[["-i","o"], [false,false,false,false,false]],
			[["-9","o"], [false,false,false,false,true]],
		];
		// [arguments, files, whether tail prints headers, the arguments with -q -v --quiet --silent --verbose taken out]
		const tails = [
			[["-n","2","a","b"], 2, true, ["-n","2","a","b"]],
			[["-q","a","b"], 2, false, ["a","b"]],
			[["--quiet","a","b"], 2, false, ["a","b"]],
			[["--silent","a","b"], 2, false, ["a","b"]],
			[["-v","a"], 1, true, ["a"]],
			[["--verbose","a"], 1, true, ["a"]],
			[["-qv","a","b"], 2, true, ["a","b"]],
			[["-vq","a","b"], 2, false, ["a","b"]],
			[["-n","q","a","b"], 2, true, ["-n","q","a","b"]],
			[["-c","5","a","b"], 2, true, ["-c","5","a","b"]],
			[["-s","1","a","b"], 2, true, ["-s","1","a","b"]],
			[["--lines","v","a"], 1, false, ["--lines","v","a"]],
			[["--","-q","a"], 2, true, ["--","-q","a"]],
			[["a"], 1, false, ["a"]],
			[["a","b"], 2, true, ["a","b"]],
			[["-","a"], 2, true, ["-","a"]],
			[["--lines=2","a"], 1, false, ["--lines=2","a"]],
			[["-z","a"], 1, false, ["-z","a"]],
		];
		for (const [program, argv, want] of plans) {
			const r = zero.plan(program, argv, c.OPTION_VALUES[program]);
			assert.deepStrictEqual([r.zero, r.nul, r.args, r.files, r.scripts, r.scriptFiles, r.outputAt, r.suffix, r.inPlace, r.separate], want, program + ' ' + JSON.stringify(argv));
		}
		for (const [texts, want] of placeholders) { assert.strictEqual(zero.pickPlaceholder(texts), want, JSON.stringify(texts)); }
		// no room among the controls, and none among the private-use characters either
		const controls = Array.from({ length: 31 }, (_, i) => i + 1).filter((n) => n !== 10).map((n) => String.fromCharCode(n)).join('');
		assert.strictEqual(zero.pickPlaceholder([controls]).codePointAt(0), 0xe000);
		const privateUse = Array.from({ length: 0xf8ff - 0xe000 }, (_, i) => String.fromCharCode(0xe000 + i)).join('');
		assert.strictEqual(zero.pickPlaceholder([controls + privateUse]).codePointAt(0), 0xfdd0);
		for (const [script, want] of refusals) { assert.strictEqual(zero.sedZeroRefusal(script), want, JSON.stringify(script)); }
		for (const [script, want] of scripts) { assert.strictEqual(zero.sedScriptIn(script, '\x01'), want, JSON.stringify(script)); }
		for (const [argv, [names, count, quiet, lineNumber, context]] of kinds) {
			assert.deepStrictEqual(zero.grepOutputKind(argv), { names, count, quiet, lineNumber, context }, JSON.stringify(argv));
		}
		for (const [argv, files, headers, rest] of tails) {
			assert.strictEqual(zero.tailHeaders(argv, files), headers, JSON.stringify(argv));
			assert.deepStrictEqual(zero.withoutHeaderOptions(argv), rest, JSON.stringify(argv));
		}
	});

	test('zero.js, the cases that were missing: a placeholder that must see every character, labels that look like commands, a pattern that looks like an option, and a file called q', () => {
		// the order of the characters decides what the scan has seen when it stops
		assert.strictEqual(zero.pickPlaceholder(['\x0b\n\x01']), '\x02');
		assert.strictEqual(zero.pickPlaceholder(['\x0b\0\x01']), '\x02');
		for (const [script, want] of [['T e', null], ['t l', null], ['b w', null], [': r', null], ['1,3l', 'the l command'], ['$l', 'the l command'], ['/a/,/b/l', 'the l command'], ['2~3l', 'the l command'], ['0,/x/l', 'the l command'], ['\\,a,l', 'the l command'], ['/a/!l', 'the l command'], ['1!{l}', 'the l command']]) {
			assert.strictEqual(zero.sedZeroRefusal(script), want, JSON.stringify(script));
		}
		for (const [argv, want] of [[['c', 'f'], false], [['l', 'f'], false], [['n', 'f'], false], [['q', 'f'], false], [['A', 'f'], false]]) {
			const k = zero.grepOutputKind(argv);
			assert.deepStrictEqual([k.count, k.names, k.lineNumber, k.quiet, k.context], [want, want, want, want, want], JSON.stringify(argv));
		}
		assert.strictEqual(zero.grepOutputKind(['-0', 'o']).context, true);
		// a file named q or v is a file, and an option that comes after --lines=2 still counts
		assert.strictEqual(zero.tailHeaders(['q', 'v'], 2), true);
		assert.deepStrictEqual(zero.withoutHeaderOptions(['q', 'v']), ['q', 'v']);
		assert.strictEqual(zero.tailHeaders(['--lines=2', '-q', 'a', 'b'], 2), false);
		assert.deepStrictEqual(zero.withoutHeaderOptions(['--lines=2', '-q', 'a', 'b']), ['--lines=2', 'a', 'b']);
	});

	test('datestr: a weekday with no date is the next one (today is itself), `next` skips today, `last` goes back, a count goes forward by weeks; the time of day is midnight', () => {
		const now = Date.UTC(2024, 6, 4, 12, 34, 56); // a Thursday
		const day = (text) => { const r = datestr.parse(text, now, 'UTC'); return r && !('invalid' in r) ? new Date(r.ms).toISOString() : JSON.stringify(r); };
		const expected = {
			monday: '2024-07-08', tuesday: '2024-07-09', wednesday: '2024-07-10', thursday: '2024-07-04', friday: '2024-07-05', saturday: '2024-07-06', sunday: '2024-07-07',
			'next monday': '2024-07-08', 'next thursday': '2024-07-11', 'next friday': '2024-07-05', 'next sunday': '2024-07-07',
			'last monday': '2024-07-01', 'last thursday': '2024-06-27', 'last friday': '2024-06-28',
			'this thursday': '2024-07-04', 'this monday': '2024-07-08', '0 monday': '2024-07-08', '2 monday': '2024-07-15', '2 thursday': '2024-07-18', '3 friday': '2024-07-19',
		};
		for (const [text, date] of Object.entries(expected)) { assert.strictEqual(day(text), date + 'T00:00:00.000Z', text); }
		assert.strictEqual(day('tomorrow'), '2024-07-05T12:34:56.000Z');
		assert.strictEqual(day('yesterday'), '2024-07-03T12:34:56.000Z');
	});

	for (const t of tests) {
		await t.fn();
		console.log('  ok - ' + t.name);
	}
	console.log(`\n${tests.length} tests passed`);
}

(async () => {
	try {
		for (const zoneName of ZONES) {
			process.env.TZ = zoneName;
			tests.length = 0;
			console.log('--- the zone of the process: ' + zoneName);
			await main();
		}
	} finally {
		if (PROCESS_TZ === undefined) { delete process.env.TZ; } else { process.env.TZ = PROCESS_TZ; }
	}
})().catch((e) => { console.error(e); process.exit(1); });
