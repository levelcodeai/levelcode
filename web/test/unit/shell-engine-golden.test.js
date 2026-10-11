/*---------------------------------------------------------------------------------------------
 *  The shell against GNU bash — run: node web/test/unit/shell-engine-golden.test.js
 *
 *  web/test/fixtures/shell/golden/golden.json holds what GNU bash 5.1 and coreutils 8.32 did with every case of
 *  cases/*.mjs (stdout, exit status, the file tree it left), recorded ONCE in a container with no network. This runs
 *  each case through the engine core, over an in-memory workspace, and compares.
 *
 *  A case that legitimately differs is listed below WITH ITS REASON and the fields in which it differs. The list is
 *  closed from both ends: a case that is not listed must match; a case that is listed must differ in exactly those
 *  fields, so one that starts to match (the engine got better, a patch was added) fails here until it is removed from
 *  the list; and the list may not grow. It can only shrink.
 *
 *  stderr is compared with the program name and "line N" prefixes removed; its wording is the engine's own in many
 *  places, and only listed where the difference is more than the wording.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

// The reference ran with TZ unset, which is UTC, and so does the shell: whatever zone the process (the visitor's
// browser) is in is never asked. Every case is run under three of them and must give the same answer.
const ZONES = ['UTC', 'America/New_York', 'Asia/Tokyo'];
const PROCESS_TZ = process.env.TZ;

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..', '..', '..');
const { loadEngine, makeTree, makeHost } = require('./shell-engine-support.js');
const golden = JSON.parse(fs.readFileSync(path.join(REPO, 'web', 'test', 'fixtures', 'shell', 'golden', 'golden.json'), 'utf8'));

/**
 * Where the engine differs from GNU, and why. `fields` are the ones in which the case differs: stdout, exit, tree
 * (the file tree it left), stderr (beyond wording of the program's name).
 *
 * @type {Array<{ why: string, cases: Record<string, string> }>}
 */
const KNOWN_DIFFERENCES = [
	{
		why: 'by design: a file that starts with a shell shebang is executable (README §7: a bare ./x.sh must work, because nothing can keep a mode between commands)',
		cases: { 'ls-la-modes': 'stdout', 'chmod-x-run': 'stdout', 'run-no-exec': 'stdout+stderr' },
	},
	{
		why: 'a limit that README §7 fixes: the engine\'s function nesting is 100 deep, GNU\'s is not limited',
		cases: { 'deep-recursion-150': 'stdout+exit+tree+stderr' },
	},
	{
		why: 'the engine says "No such file or directory" for a directory that is read (the run\'s notes say what it is)',
		cases: { 'cat-dir': 'stderr' },
	},
	{
		why: 'wording only: GNU puts curly quotes in a UTF-8 locale (‘x’), the engine straight ones',
		cases: { 'mkdir-exists': 'stderr', 'mkdir-noparent': 'stderr', 'c-mkdir-m-fails': 'stderr' },
	},
	{
		why: '-i and -I ask a question: with nobody to answer, GNU answers no and does nothing, and so does this shell (the option is refused, the file state is the same); only the message differs',
		cases: { 'c-cp-i': 'stderr', 'c-rm-i': 'stderr', 'c-rm-rI': 'stderr', 'c-cp-i-refused': 'stderr', 'c-rm-i-refused': 'stderr' },
	},
	{
		why: 'regular expressions are RE2 (linear time, no back-references, no lookaround)',
		cases: { 'grep-backref': 'stdout+stderr', 'x-grep-E-backref': 'stdout+exit+stderr', 'grep-P': 'stdout+stderr', 'sed-backref-pattern': 'stdout', 'x-sed-E-backref': 'stdout' },
	},
	{
		why: 'engine: sed has no \\U \\L \\E case conversion in the replacement',
		cases: { 'sed-case-flag': 'stdout', 'sed-regex-extensions': 'stdout' },
	},
	{
		why: 'engine: find -regex matches a part of the path, GNU the whole path',
		cases: { 'find-regex': 'stdout' },
	},
	{
		why: 'engine: find -perm takes no symbolic mode (-u+x)',
		cases: { 'find-perm-delete': 'stderr' },
	},
	{
		why: 'engine: awk printf pads with %05.1f differently and prints the exponent of %e with fewer digits',
		cases: { 'awk-builtins': 'stdout', 'awk-printf-pad': 'stdout' },
	},
	{
		why: 'engine: awk reads /dev/stdin as an empty file, and system() is not allowed',
		cases: { 'awk-environ-vars': 'stdout', 'awk-system-getline-file': 'stdout+exit+stderr' },
	},
	{
		why: 'engine: expr\'s \\( \\) in a match returns 0, not the captured text',
		cases: { 'expr-let-arith': 'stdout' },
	},
	{
		why: 'engine: arithmetic is double precision, not 64-bit integers (large values print rounded, no wrap-around)',
		cases: { 'arith-overflow': 'stdout', 'x-arith-bigint': 'stdout' },
	},
	{
		why: 'engine: an arithmetic expression that holds a command substitution with its own $(( )) is a syntax error',
		cases: { 'fn-recursion': 'stdout+exit+stderr' },
	},
	{
		why: 'engine: a $ with nothing after it in arithmetic is an error that lets the script go on; GNU ends the script (the engine used to spin until the heap ran out: patch LC-3)',
		cases: { 'p-arith-dollar': 'stdout+exit+stderr', 'p-arith-dollar-assign': 'stderr' },
	},
	{
		why: 'engine: the whole script is parsed before any of it runs, so a syntax error late in it stops everything (GNU runs the lines before)',
		cases: { 'glob-extglob': 'tree+stderr' },
	},
	{
		why: 'engine: the order of standard output and standard error under 2>&1 is the order of statements, not of writes',
		cases: { 'stderr-ordering': 'stdout', 'r3-gap-xargs-t-order': 'stdout' },
	},
	{
		why: 'engine: `cmd &` runs the command to its end before the next statement (nothing runs in the background)',
		cases: { 'bg-wait': 'stdout' },
	},
	{
		why: 'engine: trap, jobs, kill, umask, ulimit are declared and not implemented (`bash: trap: command not found`; the script goes on)',
		cases: { 'trap-exit': 'stdout+stderr', 'trap-err-int': 'stdout+stderr', 'trap-cleanup': 'stderr', 'jobs-ps-kill': 'stdout+stderr', 'umask-ulimit': 'stdout+stderr' },
	},
	{
		why: 'engine: `declare -f NAME` prints nothing, ${BASH_SOURCE[0]} is empty, `env -i` prints PWD, `printf %d abc` prints 0 with no complaint',
		cases: { 'indirect-decl': 'stdout', 'bash-source': 'stdout', 'env-vars': 'stdout', 'printf-v': 'stdout' },
	},
	{
		why: 'engine: the options are not there: wc -L, cut --output-delimiter, uniq -f, tail -f, diff -r and -w',
		cases: { 'wc-multi-ops': 'stdout', 'x-wc-L': 'stdout+exit+stderr', 'cut-variants': 'stdout+exit+stderr', 'uniq-flags': 'stdout+stderr', 'tail-f-follow': 'stdout', 'diff-r': 'stdout+stderr', 'diff-context-ignore': 'stdout+stderr' },
	},
	{
		why: 'engine: rm -v lists the directory it was given, not each file under it',
		cases: { 'rm-rv': 'stdout' },
	},
	{
		why: 'engine: cut -c and tr work on characters; coreutils 8.32 works on bytes (`cut -c1-2` of "héllo" is "h" and the first byte of "é"; `tr é e` makes "ee" of "é"). Here the engine is the better one',
		cases: { 'wc-c-utf8-file': 'stdout', 'unicode': 'stdout' },
	},
	{
		why: 'not offered or not possible here: symbolic links (EPERM), tar, gzip, gunzip, shasum, cksum',
		cases: { 'ln-s': 'stdout+stderr', 'tar-roundtrip': 'stdout+tree+stderr', 'gzip-pipe': 'stdout+stderr', 'shasum-cksum': 'stdout' },
	},
	{
		why: 'the reference container has no ripgrep, no column and no tree (and has git, node and friends, which this shell does not)',
		cases: { 'rg-basic': 'stdout+stderr', 'rg-glob-type': 'stdout+stderr', 'paste-col': 'stdout+exit+stderr', 'x-column-t': 'stdout+exit+stderr', 'tree': 'stdout', 'tools-absent': 'stdout' },
	},
	{
		why: 'wording: a command that is not there is named with the script\'s path by the reference, with bash: by this shell',
		cases: { 'od-xxd': 'stdout' },
	},
	{
		why: 'the owner is `user` here and root in the reference container',
		cases: { 'x-stat-c-y': 'stdout', 'x-ls-l-fmt': 'stdout' },
	},
	{
		why: 'engine: into a file under &> or 2>&1 a command\'s standard output comes before its standard error (GNU ls reports the missing name first); the file holds the same lines in the other order (see 2>&1 above)',
		cases: { 'redir-amp-gt': 'tree' },
	},
	// Found by the third round's differencing, not before it (round3.mjs, `r3-gap-*`): new entries, each with its reason
	{
		why: 'engine: date -d reads @N, now, yesterday, tomorrow and a wall clock (with or without a zone); a relative form (`+1 day`, `1 month`, `next friday`) or `1 Jan 2020 3pm` is "invalid date"',
		cases: { 'r3-gap-date-relative': 'stdout+exit+stderr' },
	},
	{
		why: 'engine: sed q and Q take no exit status (`2q5` is a syntax error) and sed has no -z',
		cases: { 'r3-gap-sed-q-exit-and-z': 'stdout+exit+stderr' },
	},
	{
		why: 'engine: rm has no -d (remove an empty directory)',
		cases: { 'r3-gap-rm-d': 'stdout+stderr+tree' },
	},
	{
		why: 'engine: sort has no -z (records ended by NUL)',
		cases: { 'r3-gap-sort-z': 'stdout+stderr' },
	},
	{
		why: 'engine: grep has no -b (byte offset)',
		cases: { 'r3-gap-grep-b': 'stdout+exit+stderr' },
	},
	{
		why: 'engine: find -printf prints %y (the type) as typed; it knows the names, sizes, modes and times',
		cases: { 'r3-gap-find-printf-type': 'stdout' },
	},
	{
		why: 'by design: hard links cannot be made (the engine says so in its own words), as symbolic ones cannot',
		cases: { 'r3-gap-ln-hard': 'stdout+stderr+tree' },
	},
	// Found by the fourth round, each with its reason
	{
		why: 'wording only: GNU sort says which part of a key is wrong (`field number is zero`, `character offset is zero`, `invalid count at start of`), the engine that the specification is invalid; the status is the same',
		cases: { 'r4-sort-k-invalid': 'stderr' },
	},
];

/** The most entries the list may have: it can only shrink (79 before the fourth round: 3 closed by it, 1 found by it). */
const MAX_DIFFERENCES = 77;

const INLINE_MAX = golden.meta.inlineMax;
function encodeBytes(buf) {
	if (buf.length > INLINE_MAX) { return { len: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex') }; }
	try {
		const s = new TextDecoder('utf-8', { fatal: true }).decode(buf);
		if (!s.includes('\0')) { return s; }
	} catch { /* binary */ }
	return { b64: Buffer.from(buf).toString('base64') };
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
/** a line of stderr without the program or script name and "line N:" that bash puts in front */
const normaliseStderr = (s) => s.split('\n').map((l) => l.replace(/^(\/c\/[^:]+|bash|sh|\/bin\/bash|\/bin\/sh|\/usr\/bin\/bash): (line \d+: )?/, '').replace(/^line \d+: /, '')).join('\n').trim();

/** The tree GNU left for a case: the fixture's tree (when the case ran on it) with the case's delta applied. */
function referenceTree(c) {
	const t = new Map(c.fixture ? Object.entries(golden.fixture.tree) : []);
	for (const g of c.tree.gone) { t.delete(g); }
	for (const d of c.tree.dirs) { t.set(d, null); }
	for (const [p, v] of Object.entries(c.tree.files)) { t.set(p, v); }
	return t;
}

async function main() {
	const E = await loadEngine();
	const table = new Map();
	for (const group of KNOWN_DIFFERENCES) {
		for (const [name, fields] of Object.entries(group.cases)) {
			assert.ok(!table.has(name), 'listed twice: ' + name);
			assert.ok(group.why.length > 20, 'a reason for ' + name);
			table.set(name, { fields: fields.split('+').sort(), why: group.why });
		}
	}
	const byName = new Map(golden.cases.map((c) => [c.name, c]));
	let matched = 0;
	const problems = [];
	const t0 = Date.now();

	const tests = [];
	const test = (name, fn) => tests.push({ name, fn });

	async function everyCase(zoneName) {
		matched = 0;
		problems.length = 0;
		for (const c of golden.cases) {
			const tree = makeTree({});
			const h = await makeHost({ Engine: E, tree });
			const script = (c.fixture ? golden.fixture.script + '\n' : '') + c.script + '\n';
			let r;
			try { r = await h.run(script, { cwd: '/w' }); } catch (e) { problems.push(c.name + ': the run itself failed: ' + e.message); continue; }
			const fields = [];
			const refOut = typeof c.stdout === 'string' ? c.stdout : null;
			if (refOut !== null) { if (r.stdout !== refOut) { fields.push('stdout'); } } else if (c.stdout.b64 && Buffer.from(r.stdout, 'utf8').toString('base64') !== c.stdout.b64 && Buffer.from(r.stdout, 'latin1').toString('base64') !== c.stdout.b64) { fields.push('stdout'); }
			if (r.exitCode !== c.exit) { fields.push('exit'); }
			const ours = new Map();
			for (const [p, v] of tree.nodes) { if (p === '/w' || !p.startsWith('/w/')) { continue; } ours.set(p.slice(3), v === null ? null : encodeBytes(Buffer.from(v))); }
			const ref = referenceTree(c);
			let treeSame = ours.size === ref.size;
			if (treeSame) { for (const [k, v] of ref) { if (!ours.has(k) || !same(ours.get(k), v)) { treeSame = false; break; } } }
			if (!treeSame) { fields.push('tree'); }
			if (normaliseStderr(r.stderr) !== normaliseStderr(c.stderr)) { fields.push('stderr'); }
			fields.sort();
			const known = table.get(c.name);
			if (!known) {
				if (fields.length) { problems.push(`${c.name}: differs from GNU in ${fields.join('+')} and is not listed.\n    script: ${JSON.stringify(c.script).slice(0, 200)}\n    gnu:  ${JSON.stringify(c.stdout).slice(0, 200)} exit ${c.exit}\n    here: ${JSON.stringify(r.stdout).slice(0, 200)} exit ${r.exitCode}`); } else { matched++; }
				continue;
			}
			if (!fields.length) { problems.push(`${c.name}: now matches GNU. Remove it from KNOWN_DIFFERENCES (it was: ${known.why})`); continue; }
			if (!same(fields, known.fields)) { problems.push(`${c.name}: differs in ${fields.join('+')}, listed as ${known.fields.join('+')} (${known.why})`); }
		}
		assert.deepStrictEqual(problems, [], 'process zone ' + zoneName);
		assert.strictEqual(matched + table.size, golden.cases.length);
	}



	test('the recording: GNU bash 5.1 and coreutils 8.32, run twice, with what was left out because it was not repeatable', () => {
		assert.ok(/GNU bash 5\.1\.16 and coreutils 8\.32/.test(golden.meta.reference));
		assert.strictEqual(golden.meta.runs, 2);
		assert.deepStrictEqual(golden.meta.flaky, ['patch', 'tar-gz', 'whoami-uname']);
		assert.strictEqual(golden.meta.cases, golden.cases.length);
		assert.ok(golden.cases.length >= 500, 'the batteries and the added cases: ' + golden.cases.length);
		assert.deepStrictEqual([...new Set(golden.cases.map((c) => c.source))].sort(), ['battery-1', 'battery-2', 'extra', 'round2', 'round3', 'round4']);
		const size = fs.statSync(path.join(REPO, 'web', 'test', 'fixtures', 'shell', 'golden', 'golden.json')).size;
		// what grows with the cases is a case's script, its output and the files it left; a case that ran on a bare workspace
		// lists no `gone` (it used to list the fixture's 18 paths: a third of the file)
		assert.ok(size < 400 * 1024, 'fixtures stay small: ' + size);
	});

	test('the list of known differences names only cases that exist, and may only shrink', () => {
		for (const name of table.keys()) { assert.ok(byName.has(name), 'listed but not in golden.json: ' + name); }
		assert.ok(table.size <= MAX_DIFFERENCES, `the list has ${table.size} entries, it may have ${MAX_DIFFERENCES}`);
	});

	test('every case, in each of three zones of the process: the engine does what GNU did, or is listed as differing in exactly the listed fields', async () => {
		try {
			for (const zoneName of ZONES) {
				process.env.TZ = zoneName;
				await everyCase(zoneName);
			}
		} finally {
			if (PROCESS_TZ === undefined) { delete process.env.TZ; } else { process.env.TZ = PROCESS_TZ; }
		}
		assert.ok(matched / golden.cases.length > 0.84, 'the share that is identical: ' + matched + ' of ' + golden.cases.length);
	});

	test('what is said about the differences is true for the cases that decide the shell\'s behaviour', async () => {
		// by design, and not a bug: pinned by name so that a change of the rule is a decision, not an accident
		const h = await makeHost({ Engine: E, tree: makeTree({ '/w/run.sh': '#!/bin/sh\necho ran\n', '/w/app.js': '#!/usr/bin/env node\nconsole.log(1)\n', '/w/plain': 'echo plain\n' }) });
		const r = await h.run('./run.sh; echo "rc=$?"; ./app.js; echo "rc=$?"; ./plain; echo "rc=$?"');
		assert.strictEqual(r.stdout, 'ran\nrc=0\nrc=126\nrc=126\n');
		assert.ok((r.stderr.match(/Permission denied/g) || []).length === 2);
		assert.ok(table.has('run-no-exec') && table.has('chmod-x-run'));
	});

	for (const t of tests) {
		await t.fn();
		console.log('  ok - ' + t.name);
	}
	console.log(`\n${tests.length} tests passed (${golden.cases.length} cases against GNU: ${matched} identical, ${table.size} listed, ${((Date.now() - t0) / 1000).toFixed(1)} s)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
