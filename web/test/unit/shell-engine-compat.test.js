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
			[['-I'], ['-I', 'undefined']],
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
		assert.deepStrictEqual(t(['-i.bak', 's/a/b/', 'f']), { args: ['-i', 's/a/b/', 'f'], suffix: '.bak', files: ['f'] });
		assert.deepStrictEqual(t(['--in-place=.orig', '-e', 's/a/b/', 'f', 'g']), { args: ['-i', '-e', 's/a/b/', 'f', 'g'], suffix: '.orig', files: ['f', 'g'] });
		assert.deepStrictEqual(t(['-i', 's/a/b/', 'f']), { args: ['-i', 's/a/b/', 'f'], suffix: '', files: ['f'] });
		assert.deepStrictEqual(t(['-n', '-i', '-e', 'p', 'f']), { args: ['-n', '-i', '-e', 'p', 'f'], suffix: '', files: ['f'] });
		assert.deepStrictEqual(t(['--quiet', '--expression=2p', 'f']), { args: ['-n', '-e', '2p', 'f'], suffix: null, files: ['f'] });
		assert.deepStrictEqual(t(['-ne', 'p', 'f']), { args: ['-n', '-e', 'p', 'f'], suffix: null, files: ['f'] });
		assert.deepStrictEqual(t(['-E', '-f', 'prog.sed', 'f']), { args: ['-E', '-f', 'prog.sed', 'f'], suffix: null, files: ['f'] });
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
		assert.deepStrictEqual(c.parseTouch(['-d', '@100', 'f']), { args: ['f'], time: 100000, files: ['f'], reference: null });
		assert.deepStrictEqual(c.parseTouch(['--date=@-5', 'f']).time, -5000);
		assert.deepStrictEqual(c.parseTouch(['-d', '2020-01-01', 'f']), { args: ['-d', '2020-01-01', 'f'], time: null, files: ['f'], reference: null });
		// -r REF is taken out of the line (the engine ignored it) and handed to the wrapper, which reads REF's time
		assert.deepStrictEqual(c.parseTouch(['-r', 'ref', 'f']), { args: ['f'], time: null, files: ['f'], reference: 'ref' });
		assert.deepStrictEqual(c.parseTouch(['--reference=ref', 'f', 'g']), { args: ['f', 'g'], time: null, files: ['f', 'g'], reference: 'ref' });
		assert.deepStrictEqual(c.parseTouch(['--reference', 'ref', '-c', 'f']), { args: ['-c', 'f'], time: null, files: ['f'], reference: 'ref' });
		assert.deepStrictEqual(c.parseTouch(['-rref', 'f']), { args: ['f'], time: null, files: ['f'], reference: 'ref' });
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
		assert.strictEqual(await run('sort -t: -k2,2n -r d'), 'b:2\na:2\nc:1\n');
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
		assert.strictEqual(c.parseTouch(['-t', '1', 'f']).time, null, 'not a stamp: the engine says so');
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
		const r = await sh("touch -d '@86400' a; touch -r a b; touch --reference=a c; touch --reference a d; touch -ra e; stat -c '%n %Y' b c d e; touch -r nofile f 2>&1; echo \"rc=$?\"; ls f 2>&1 | head -1; echo x > g; touch -d @5 h; touch -r h g; stat -c %Y g; cat g; touch -c -r a nothere; ls nothere 2>&1 | head -1; touch -t 202001020304 -r a i; stat -c %Y i");
		assert.strictEqual(r.stdout, "b 86400\nc 86400\nd 86400\ne 86400\ntouch: failed to get attributes of 'nofile': No such file or directory\nrc=1\nls: cannot access 'f': No such file or directory\n5\nx\nls: cannot access 'nothere': No such file or directory\n1577934240\n");
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
		assert.deepStrictEqual(p('-I{}', 'echo', '{}'), { opts: { nul: false, delim: null, replace: '{}', eof: null, maxLines: null, maxArgs: null, verbose: false, noRun: false, argFile: null }, command: ['echo', '{}'], warnings: [] });
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
		const batches = (ls, o) => c.xargsBatches(lines(...ls), Object.assign({ replace: null, maxLines: null, maxArgs: null }, o));
		assert.deepStrictEqual(batches([{ words: ['a', 'b'] }, { words: ['c'] }], {}), [['a', 'b', 'c']]);
		assert.deepStrictEqual(batches([{ words: ['a', 'b'] }, { words: ['c'] }], { maxArgs: 2 }), [['a', 'b'], ['c']]);
		assert.deepStrictEqual(batches([{ words: ['a', 'b'] }, { words: ['c'] }], { maxLines: 1 }), [['a', 'b'], ['c']]);
		assert.deepStrictEqual(batches([{ words: ['a'] }, { words: ['b'] }, { words: ['c'] }], { maxLines: 2 }), [['a', 'b'], ['c']]);
		assert.deepStrictEqual(batches([{ words: ['a'], cont: true }, { words: ['b'] }, { words: ['c'] }], { maxLines: 1 }), [['a', 'b'], ['c']], 'a line that ends in a blank continues');
		assert.deepStrictEqual(batches([{ words: ['a b'] }, { words: ['c'] }], { replace: '{}' }), [['a b'], ['c']]);
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
