/*---------------------------------------------------------------------------------------------
 *  Tables against GNU — run: node web/test/unit/shell-engine-tables.test.js
 *
 *  web/test/fixtures/shell/tables/tables.json holds what GNU bash 5.1 and coreutils 8.32 answered to tables of command
 *  lines that have a grammar of their own (generate.mjs there says how each was drawn, and runs docker; this test does
 *  not). Every row runs through the engine, over an empty workspace, and must give GNU's standard output, status and
 *  (with GNU's curly quotes read as straight ones, which is the one thing a UTF-8 locale changes and the engine does
 *  not) standard error:
 *
 *    tr        814 programs: a seeded generator over escapes, ranges, classes, [c*n], [=c=], -c -d -s -t, bytes
 *    sortk     the grammar of `sort -k` (114 specifications), its words and its status
 *    spelling  a path typed through `..` of a folder that is there or not, for cp, mv, mkdir, touch, rm, `>`
 *    date      date -d strings: relative forms with a date as the anchor, absolute forms, a fraction of a second
 *    tz        TZ as a zone file's path, an offset alone, a POSIX string
 *    xargst    `xargs -t`: how one word is quoted when the command is echoed
 *    options   which options of 27 programs take a value (asked of GNU's getopt, letter by letter), against
 *              OPTION_VALUES, and GNU's wording for each one that is the last thing on a line
 *    sedre     400 random basic and extended patterns through `sed s` and a sed address (the quantifier where it has
 *              nothing to quantify, groups, brackets, intervals, escapes), with GNU's output, status and message
 *    grepre    the same patterns through grep, -c and -o
 *    sedidiom  the one-liners written every day: escaping a string for another sed, case conversion, a bracket with a
 *              backslash or the delimiter in it, groups swapped, \< and \>, \xHH \oNNN \dNNN \cX
 *    sedaddr   sed addresses: any delimiter, I and M, `1,/re/`, `0,/re/`, `a,~N`, `a,+N`, `!`, steps and blocks
 *    sedgram   1343 sed scripts at the edges of the grammar: numeric escapes, \\c, bracket elements, word edges, intervals,
 *              `[:space:]` written without its brackets, a command followed by something else, the flags of s
 *    difft     1151 diff command lines (every option it has and some it has not, over files that differ in several ways, and folders)
 *    sedlist   19 sed `l` programs on lines with characters that are not ASCII, bytes that are not text, controls and long lines
 *    grepgram  562 grep patterns (the same, and the `[:space:]` mistake), -c and -o, basic and extended
 *    awk       155 everyday awk programs on three inputs (gawk 5.1), pipes and output redirections among them
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

require('../helpers/shell-exit-guard.js');

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..', '..', '..');
const { loadEngine, makeTree, makeHost } = require('./shell-engine-support.js');
const compat = require(path.join(REPO, 'web', 'shell', 'engine', 'compat.js'));

const FIXTURE = path.join(REPO, 'web', 'test', 'fixtures', 'shell', 'tables', 'tables.json');
const data = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
const fill = (tpl, a) => tpl.replace(/\{(\d+)\}/g, (_, i) => a[Number(i)]);
/** GNU's quotes in a UTF-8 locale are curly; the engine's straight (README §4: wording only) */
const straight = (s) => s.replace(/[‘’]/g, "'");
const bytesOf = (v) => (typeof v === 'string' ? Buffer.from(v, 'utf8') : Buffer.from(v.b64, 'base64'));
/** the program's name and "line N:" that bash puts in front of its own words, and the script's path */
const normaliseStderr = (s) => straight(s).split('\n').map((l) => l.replace(/^(\/c\/[^:]+|bash|sh|\/bin\/bash|\/bin\/sh|\/usr\/bin\/bash): (line \d+: )?/, '').replace(/^line \d+: /, '')).join('\n').trim();

/**
 * Rows in which the engine and GNU differ, and why (known.json next to tables.json): a row listed here must still differ
 * (one that starts to match fails until it is removed), and the list may only shrink.
 * @type {Record<string, string>}
 */
const KNOWN = JSON.parse(fs.readFileSync(path.join(REPO, 'web', 'test', 'fixtures', 'shell', 'tables', 'known.json'), 'utf8'));
// 27 rows of sed and 30 of grep regular expressions (out of 800) that RE2 cannot do or GNU treats by a rule of its own,
// 105 rows of diff with an option it does not have, 75 rows of sed and 14 of grep at the edges of the grammar (a word edge beside a quantifier or an anchor, a numeric escape that makes a
// metacharacter, `\\c` at the end, RE2's repeat limit, a back-reference, an interval after an interval, the words of a rare script
// error), and 7 awk programs of 155 whose answer is gawk's own (hash order, a fatal error, hex literals)
const MAX_KNOWN = 258;

async function main() {
	const E = await loadEngine();
	const tests = [];
	const test = (name, fn) => tests.push({ name, fn });

	async function runRow(script) {
		const h = await makeHost({ Engine: E, tree: makeTree({}) });
		return h.run(script + '\n', { cwd: '/w' });
	}

	/** runs one table; `compareStderr` false for rows whose standard error is in the standard output already */
	async function replay(name, { stderr = true } = {}) {
		const t = data.tables[name];
		const problems = [];
		const seen = new Set();
		for (const row of t.rows) {
			const script = fill(t.tpl, row.a);
			const key = name + ' ' + JSON.stringify(row.a);
			let r;
			try { r = await runRow(script); } catch (e) { problems.push(`${key}: the run itself failed: ${e.message}`); continue; }
			const want = { stdout: bytesOf(row.o), stderr: row.e === undefined ? Buffer.alloc(0) : bytesOf(row.e), exit: 0 };
			const fields = [];
			// GNU's curly quotes land in the output of the rows that merge the error into it (2>&1)
			const gotOut = Buffer.from(straight(r.stdout), 'utf8');
			const wantOut = Buffer.from(straight(want.stdout.toString('utf8')), 'utf8');
			if (!gotOut.equals(wantOut) && !Buffer.from(r.stdout, 'latin1').equals(want.stdout)) { fields.push('stdout'); }
			if (stderr) {
				const got = normaliseStderr(r.stderr);
				let said = normaliseStderr(want.stderr.toString('utf8'));
				// sed and awk answer with their whole usage text (40 lines of options and examples) and this shell with the
				// first line of it: GNU's is cut after its first `Usage:` line, which is what the engine's must be
				if (name === 'wording' && /^(sed|awk) /.test(row.a[0])) {
					const lines = said.split('\n');
					lines.length = lines.findIndex((l) => l.startsWith('Usage:')) + 1;
					said = lines.join('\n');
				}
				if (got !== said) { fields.push('stderr'); }
			}
			// the status of the script is the status of its last command, which the rows end with an `echo rc=` of
			if (fields.length) {
				seen.add(key);
				if (!(key in KNOWN)) {
					problems.push(`${key}: differs in ${fields.join('+')}\n    script: ${JSON.stringify(script).slice(0, 240)}\n    gnu:  ${JSON.stringify(want.stdout.toString('utf8')).slice(0, 240)} err ${JSON.stringify(want.stderr.toString('utf8')).slice(0, 160)}\n    here: ${JSON.stringify(r.stdout).slice(0, 240)} err ${JSON.stringify(r.stderr).slice(0, 160)}`);
				}
			} else if (key in KNOWN) { problems.push(`${key}: now matches GNU; remove it from KNOWN (it was: ${KNOWN[key]})`); }
		}
		assert.deepStrictEqual(problems, [], name + ': ' + problems.length + ' rows differ');
		return t.rows.length;
	}

	test('the recording: GNU bash 5.1 and coreutils 8.32, run twice, nothing left out as not repeatable', () => {
		assert.ok(/GNU bash 5\.1\.16 and coreutils 8\.32/.test(data.meta.reference));
		assert.strictEqual(data.meta.runs, 2);
		assert.deepStrictEqual(data.meta.flaky, []);
		const size = fs.statSync(FIXTURE).size;
		assert.ok(size < 1280 * 1024, 'the fixture stays small: ' + size);
		assert.ok(Object.keys(KNOWN).length <= MAX_KNOWN);
	});

	test('tr: 814 programs, GNU\'s output and error for each (NUL, escapes, ranges, classes, [c*n], equivalence classes, -c -d -s -t, bytes that are not text, what a message shows of an operand)', async () => {
		const n = await replay('tr');
		assert.ok(n >= 810, 'at least 780 programs: ' + n);
		// the rows that found the NUL bug are in the table, first
		const first = data.tables.tr.rows.slice(0, 5).map((r) => r.a);
		assert.deepStrictEqual(first[0], ['a\\nb\\n', "'\\n' '\\0'"]);
	});

	test('sort -k: 114 specifications and the --key= forms, GNU\'s words and status for each', async () => { assert.ok(await replay('sortk') >= 72); });

	test('a path typed through `..`: cp, mv, mkdir, touch, rm and a redirection, for the folders that are there and those that are not', async () => { assert.ok(await replay('spelling', { stderr: false }) >= 150); });

	test('date -d: relative and absolute strings, a fraction of a second, a zone of the command, blanks of every kind, military zones, offsets, two-digit years, am and pm, weekdays with counts, a time as digits, @ with blanks, years before 1000', async () => { assert.ok(await replay('date') >= 1060); });

	test('TZ: a zone file\'s path, an offset alone, a POSIX string, a name that is not a zone', async () => { assert.ok(await replay('tz') >= 50); });

	test('xargs -t: how one word is quoted when the command is echoed', async () => { assert.ok(await replay('xargst') >= 250); });

	test('sed regular expressions: 400 rows of random basic and extended patterns, in an s command and in an address (27 differ and are listed)', async () => { assert.ok(await replay('sedre') >= 400); });

	test('grep regular expressions: the same patterns, -c and -o, basic and extended', async () => { assert.ok(await replay('grepre') >= 400); });

	test('sed one-liners: escaping a string for another sed, case conversion, brackets with a backslash or the delimiter in them, \\< and \\>', async () => { assert.ok(await replay('sedidiom') >= 180); });

	test('sed addresses: any delimiter, I and M, ranges with a regular expression, a number, +N and ~N, steps, blocks', async () => { assert.ok(await replay('sedaddr') >= 170); });

	test('sed at the edges of its grammar: numeric escapes with and without digits (in a bracket and out), \\c, class / collating / equivalence elements in a bracket and as the neighbour of the delimiter, \\< and \\> beside a character that is not a word character, intervals that are not closed or not valid, `[:space:]` without its brackets, a command followed by something else, the flags of s, a script of several -e and of several lines (which expression and which character)', async () => { assert.ok(await replay('sedgram') >= 1340); });

	test('grep with the same patterns, basic and extended, -c and -o', async () => { assert.ok(await replay('grepgram') >= 550); });

	test('diff: 1151 command lines on files that differ in several ways and on folders (an option GNU has and this shell has not is listed)', async () => { assert.ok(await replay('difft') >= 1150); });

	test('sed l: a character that is not ASCII is its UTF-8 bytes in octal, a byte that is not text is its own, controls by name, a line is wrapped at 70 and at `l N`, `l 0` and `l 1`', async () => { assert.ok(await replay('sedlist') >= 19); });

	test('awk: 155 everyday programs on three inputs (fields, printf, arrays, functions, getline, pipes, redirections), gawk\'s output for each', async () => { assert.ok(await replay('awk') >= 155); });

	test('options with a value: the table of the engine is the one GNU\'s getopt answers with, letter by letter and name by name', () => {
		const table = compat.OPTION_VALUES;
		const problems = [];
		for (const p of data.tables.options.programs) {
			const mine = table[p.program];
			if (!mine) { problems.push(`${p.program}: not in OPTION_VALUES`); continue; }
			const have = [...new Set((mine.short || '').split(''))].sort().join('');
			if (have !== p.shortRequired) { problems.push(`${p.program}: short options with a value are "${p.shortRequired}" in GNU, "${have}" here`); }
			const longHave = new Set(mine.long || []);
			const longWant = new Set(p.longRequired);
			for (const l of longWant) { if (!longHave.has(l)) { problems.push(`${p.program}: ${l} takes a value in GNU and is not in the table`); } }
			for (const l of longHave) {
				// a name the table has that GNU's --help does not list: GNU must still know it as taking a value
				if (!longWant.has(l) && p.longOk.includes(l)) { problems.push(`${p.program}: ${l} takes no value in GNU and is in the table`); }
			}
		}
		assert.deepStrictEqual(problems, []);
		assert.strictEqual(data.tables.options.programs.length, 27);
	});

	test('options with a value, last on the line: GNU\'s own words and status, for every one of them', async () => {
		const n = await replay('wording');
		assert.ok(n >= 150, 'a row for every option of the table: ' + n);
	});

	for (const t of tests) {
		const t0 = Date.now();
		await t.fn();
		console.log('  ok - ' + t.name + ` (${Date.now() - t0} ms)`);
	}
	console.log(`\n${tests.length} tests passed (${Object.entries(data.tables).map(([k, v]) => k + ' ' + (v.rows ? v.rows.length : v.programs.length)).join(', ')})`);
}

main().catch((e) => { console.error(e); process.exit(1); });
