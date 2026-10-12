#!/usr/bin/env node
// Records what GNU bash 5.1 and coreutils 8.32 (the golden suite's container, `--network none`, LC_ALL=C.UTF-8) answer
// to tables of command lines that have a grammar of their own, where a handful of hand-written cases would say little:
//
//   tr        781 programs, drawn from a seeded generator (escapes, ranges, classes, [c*n], equivalence classes,
//             -c -d -s -t, one to three sets, bytes that are not text), run on ten inputs, with the edge of every
//             class (all 255 bytes through each) and what a message shows of a bad operand
//   sortk     the key grammar of `sort -k` (90 specifications), and --key=
//   spelling  the ways of typing a path through `..` of a folder that is or is not there, for the commands that
//             read, make, move, copy and remove (cp, mv, mkdir, touch, rm, a redirection)
//   date      GNU's date -d strings: relative forms with a date as the anchor (the clock is never asked), absolute forms
//   tz        TZ as the path of a zone file, an offset alone, a POSIX string
//   xargst    `xargs -t` quoting of one word: every ASCII character alone and in a word, and the odd ones
//   options   which options of 27 programs take a value, found by asking GNU's getopt about every letter and every
//             long option of --help, and the wording of GNU's answer for each one that does
//   sedre     sed's regular expressions, basic and extended, in an s command and in an address: 400 patterns from a
//             seeded generator (quantifiers where they have nothing to quantify, groups, brackets, intervals, escapes)
//   grepre    the same patterns through grep, -c and -o, basic and extended
//   sedidiom  the one-liners that are written every day: escaping a string for another sed, case conversion, the
//             bracket with a backslash or the delimiter in it, groups swapped, `\<` and `\>`
//   awk       155 everyday awk programs (fields, printf, arrays, functions, getline, pipes, redirections) on three inputs
//   sedaddr   sed addresses: a regular expression with I and M and any delimiter, ranges (`1,/re/`, `0,/re/`, `a,~N`,
//             `a,+N`), `!`, steps and blocks
//
//   node web/test/fixtures/shell/tables/generate.mjs [--out tables.json]
//
// The unit test (web/test/unit/shell-engine-tables.test.js) never runs docker: it reads tables.json and compares the
// engine, row by row, with what is recorded. Every script runs twice; one that differs between the runs is left out.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const IMAGE = 'catthehacker/ubuntu:act-latest';
const args = process.argv.slice(2);
const OUT = path.resolve(args.includes('--out') ? args[args.indexOf('--out') + 1] : path.join(HERE, 'tables.json'));

/** a deterministic generator: the table is the same on every run */
function prng(seed) {
	let s = seed;
	const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
	const pick = (a) => a[Math.floor(rnd() * a.length)];
	return { rnd, pick };
}
const sq = (s) => "'" + s.replace(/'/g, "'\\''") + "'";

/** a table: `tpl` has `{0}`, `{1}` for the words of a row's `a`, which are shell text already quoted */
const table = (tpl, rows) => ({ tpl, rows });
const fill = (tpl, a) => tpl.replace(/\{(\d+)\}/g, (_, i) => a[Number(i)]);

function trTable() {
	const { rnd, pick } = prng(20241011);
	const lit = ['a', 'b', 'c', 'x', 'y', 'z', 'A', 'B', '0', '1', '5', ' ', '-', '[', ']', '*', ':', '=', '.', ',', '_', 'é', 'l', 'o', 'h'];
	const esc = ['\\n', '\\t', '\\\\', '\\a', '\\b', '\\f', '\\r', '\\v', '\\0', '\\00', '\\000', '\\1', '\\12', '\\012', '\\101', '\\141', '\\377', '\\400', '\\8', '\\x41', '\\q', '\\-', '\\[', '\\]', '\\*', '\\:'];
	const rng = ['a-c', 'a-z', 'A-Z', '0-9', '0-5', '\\101-\\103', '\\60-\\62', '\\0-\\3', '\\n-\\r', 'a-a', 'x-z', 'A-C', 'b-d', 'z-a', ' -/'];
	const cls = ['[:alpha:]', '[:digit:]', '[:upper:]', '[:lower:]', '[:space:]', '[:punct:]', '[:alnum:]', '[:blank:]', '[:cntrl:]', '[:xdigit:]', '[:graph:]', '[:print:]'];
	const rep = ['[x*3]', '[x*]', '[x*0]', '[x*010]', '[\\n*2]', '[a*5]', '[-*2]', '[\\0*2]', '[y*1]'];
	const bad = ['[:foo:]', '[::]', '[==]', '[=ab=]', '[x*08]', '[x*zz]', '[x*3', '[:alpha', '[=a'];
	const equ = ['[=a=]', '[=b=]', '[=\\n=]', '[=-=]'];
	const atom = () => {
		const r = rnd();
		if (r < 0.40) { return pick(lit); }
		if (r < 0.55) { return pick(esc); }
		if (r < 0.70) { return pick(rng); }
		if (r < 0.80) { return pick(cls); }
		if (r < 0.88) { return pick(rep); }
		if (r < 0.93) { return pick(equ); }
		if (r < 0.95) { return pick(bad); }
		return pick(lit);
	};
	const set = () => { const n = 1 + Math.floor(rnd() * 3); let s = ''; for (let i = 0; i < n; i++) { s += atom(); } return s; };
	const opts = ['', '', '', '-d', '-d', '-s', '-s', '-c', '-t', '-ds', '-cs', '-cd', '-cds', '-C', '--delete', '--squeeze-repeats', '--complement', '--truncate-set1', '-dc', '-ct', '-cst', '-sc', '-cdt', '-st'];
	const inputs = ['abc ABC 123 -a\\n', 'hello world\\nfoo  bar\\n', 'aabbccAABBCC112233\\n', 'a\\0b\\0\\n', '\\377\\376abc\\n\\r\\t\\v', 'x y\\tz\\n\\n\\n', '[a-c]*:=-\\\\ ', 'xxyyzz  \\n\\n\\naaa', 'HELLO wORLD 0123456789 _.,', '\\303\\251\\303\\251e'];
	const rows = [];
	// the cases of the report that found the NUL bug come first
	const fixed = [
		['', '\\n', '\\0', 'a\\nb\\n'], ['', ' ', '\\0', 'a b\\n'], ['-d', '\\0', null, 'a\\0b\\0'], ['', '\\0', '\\n', 'a\\0b\\0'], ['', 'ab', '\\0\\1', 'abc\\n'],
		['', 'a-c', 'A-C', 'abc\\n'], ['', '[:lower:]', '[:upper:]', 'hello\\n'], ['-d', '[:digit:]', null, 'a1b2\\n'], ['-s', ' ', null, 'a  b   c\\n'], ['-cd', 'a-z\\n', null, 'a1b2\\n'],
		['-c', 'a-z', '\\n', 'a1b2'], ['-cs', 'a-zA-Z', '\\n', 'ab, cd. ef'], ['-t', 'abc', 'x', 'abc\\n'], ['', 'abc', 'x', 'abc\\n'], ['', '[=a=]', 'x', 'abc\\n'],
		['', '[x*3]', 'yz', 'x\\n'], ['', 'abcd', '[y*]', 'abcd\\n'], ['', '\\101-\\103', 'a-c', 'ABC\\n'], ['', '\\n', ' ', 'a\\nb\\n'], ['', 'é', 'e', 'é\\n'],
		['', 'a\\n', '\\0\\0', 'a\\nb\\n'], ['-d', '\\n\\0', null, 'a\\nb\\0c'], ['-s', '\\0', null, 'a\\0\\0b\\0'], ['', '[:space:]', '\\0', 'a b\\n'], ['-c', '\\0', 'x', 'a\\0b\\n'],
	];
	for (const [o, a, b, input] of fixed) { rows.push([input, [o, sq(a), ...(b === null ? [] : [sq(b)])].filter(Boolean).join(' ')]); }
	// every byte from 1 to 255 through each class, kept and deleted, and a case conversion over all of them: the edges of
	// each class are the characters on either side of it ('/' ':' '@' '[' '`' '{' 'G' 'g', 0x1f 0x7f)
	const every = Array.from({ length: 255 }, (_, i) => '\\' + (i + 1).toString(8).padStart(3, '0')).join('');
	for (const c of ['alnum', 'alpha', 'blank', 'cntrl', 'digit', 'graph', 'lower', 'print', 'punct', 'space', 'upper', 'xdigit']) {
		rows.push([every, `-d ${sq('[:' + c + ':]')}`]);
		rows.push([every, `-cd ${sq('[:' + c + ':]')}`]);
		rows.push([every, `${sq('[:' + c + ':]')} ${sq('x')}`]);
	}
	rows.push([every, `${sq('[:lower:]')} ${sq('[:upper:]')}`], [every, `${sq('[:upper:]')} ${sq('[:lower:]')}`], [every, `-s ${sq('[:space:]')}`], [every, `-cs ${sq('[:alnum:]')} ${sq('_')}`]);
	// escapes at their edges, and bad class names with characters that are quoted in the message
	for (const a of ['\\7', '\\8', '\\18', '\\78', '\\378', '\\3777', '\\0000', '\\1777', '\\477', '\\00', '\\0012', '\\a\\b', '\\\\', 'a\\', '\\\\\\', '\\x', '\\q\\z']) { rows.push(['abc\\n\\a\\b\\t', sq(a) + ' x']); }
	for (const a of ['[:\\t:]', '[:a\\tb:]', '[:\\n:]', '[:\\377:]', '[:a b:]', '[:\\\\:]', '[:\\0:]', '[=\\t\\t=]', '[=ab=]', '[:upper', '[:upper:', '[:upper:]]', '[[:upper:]', 'a[:upper:]', '[:upper:][:lower:]', '[:lower:][:upper:]', '[a-', '[a-]', '[-a]', 'a-', '-a', 'a-b-c', 'a-c-e', '[a-c]', 'a\\-c']) { rows.push(['abcABC \\t-]', `${sq(a)} ${sq('x')}`]); }
	// what a message shows of an operand (make_printable_str: `\t` by name, `\ooo` for a byte of a multi-byte character, and a
	// class name is quoted afterwards, which doubles the backslash), in the class, equivalence-class and [c*n] messages
	for (const a of ['[:\\1:]', '[:\\177:]', '[:\\033:]', '[:é:]', '[:\\a\\b\\f\\n\\r\\v:]', '[=\\1\\2=]', '[=\\377\\377=]', '[=\\n\\0=]', '[=éé=]', '[=\\\\\\\\=]']) { rows.push(['abcABC \\t-]', `${sq(a)} ${sq('x')}`]); }
	for (const a of ['[b*é]', '[b*9é]', '[b*\\303\\251]', '[b*9a]', '[b*0x1]', '[b*99999999999999999999]', '[b*9\\t]', "[b*']"]) { rows.push(['abcABC \\t-]', `${sq('a')} ${sq(a)}`]); }
	// the messages that name an operand with control characters in it, the endpoints of a range that is reversed, repeat counts at the
	// edge of what GNU takes, [:upper:] and [:lower:] where they must be aligned, the long options (and what an abbreviation
	// of them is), a short option that is not one, and the translations that squeeze
	const pf = (t) => `"$(printf '${t}')"`;
	for (const a of ['a\\tb', 'a\\nb', 'a\\033b', 'a\\177b', 'a\\\\b', 'a\\007b']) { rows.push(['abc\\n', pf(a)]); }
	for (const a of ['a\\tb', 'a\\033b']) { rows.push(['abc\\n', `${sq('a')} ${sq('b')} ${pf(a)}`]); }
	for (const a of ['\\t-\\001', 'z-\\n', '\\377-\\001', 'z-a', '\\177-\\001', ' -\\037', '~-\\177', '\\200-\\177']) { rows.push(['abc\\n', `${sq(a)} x`]); rows.push(['abc\\n', `x ${sq(a)}`]); }
	for (const a of ['[b*2147483647]', '[b*2147483648]', '[b*0x]', '[b*00]', '[b*010]', '[b*08]', '[b*1]', '[b*]', '[b*0]', '[\\n*3]', '[b*9]x', '[b*3]*', '[b*4294967296]', '[b*18446744073709551614]', '[b*18446744073709551615]', '[b*0777777777777777777777]', '[b*01777777777777777777777]']) { rows.push(['abc\\n', `${sq('abcd')} ${sq(a)}`]); }
	for (const [a, b] of [['[:upper:]a', '[:lower:]b'], ['a[:upper:]', 'b[:lower:]'], ['[:lower:]', 'x[:upper:]'], ['[:upper:][:lower:]', '[:lower:][:upper:]'], ['[:upper:]', '[:upper:]'], ['[:lower:]', '[:lower:]'], ['[:upper:]', '[:digit:]'], ['[:alpha:]', '[:lower:]'], ['ab[:upper:]', 'xy[:lower:]'], ['[:upper:]b', 'ab[:lower:]'], ['[:lower:][:upper:]', '[:upper:][:lower:]'], ['a[:lower:]', '[:upper:]'], ['[:upper:]', '[:lower:]a'], ['[:lower:]a', '[:upper:]a'], ['[:lower:]', '[:upper:][:lower:]']]) {
		rows.push(['abcABC \\t-]', `${sq(a)} ${sq(b)}`]);
		rows.push(['abcABC \\t-]', `-c ${sq(a)} ${sq(b)}`]);
		rows.push(['abcABC \\t-]', `-t ${sq(a)} ${sq(b)}`]);
	}
	const everyByte = Array.from({ length: 255 }, (_, i) => '\\' + (i + 1).toString(8).padStart(3, '0')).join('');
	for (const [a, b] of [['a-z[:lower:]', 'A-Z[:lower:]'], ['[:upper:]a-z', '[:upper:]A-Z'], ['[:lower:][:lower:]', '[:lower:][:lower:]'], ['x[:upper:]', 'y[:upper:]'], ['[:upper:][:lower:]', '[:upper:][:lower:]'], ['[:upper:][:upper:]', '[:lower:][:upper:]'], ['[:lower:]', '[:lower:]'], ['[:upper:]', '[:upper:]'], ['[:lower:]x', '[:lower:]y'], ['a[:lower:]', 'b[:lower:]'], ['[:lower:][:upper:]', '[:upper:][:upper:]']]) {
		rows.push([everyByte, `${sq(a)} ${sq(b)}`]);
		rows.push([everyByte, `-c ${sq(a)} ${sq(b)}`]);
		rows.push([everyByte, `-cs ${sq(a)} ${sq(b)}`]);
	}
	for (const o of ['--delete', '--del', '--d', '--squeeze-repeats', '--squeeze', '--s', '--complement', '--com', '--c', '--truncate-set1', '--t', '--delete=x', '--complement=1', '--foo', '--', '--=', '--sq', '-', '-x', '-é', '-\\303', '-ds', '-dd', '-cC', '-dsc', '-s -s', '-c -c']) { rows.push(['abcABC \\t-]', `${o} ${sq('a')} ${sq('b')}`]); rows.push(['abcABC \\t-]', `${o} ${sq('a')}`]); }
	for (const [o, a, b] of [['-s', 'a', 'b'], ['-s', 'ab', 'xy'], ['-s', '[:alpha:]', 'x'], ['-ds', 'a', 'b'], ['-ds', 'a', 'b '], ['-cs', 'a', 'x'], ['-cs', 'a-c', ''], ['-s', ' ', '_'], ['-s', 'a-c', 'A-C'], ['-s', '\\n', ' '], ['-s', '[:space:]', ' '], ['-ct', 'a', 'xyz'], ['-t', 'abcd', 'x'], ['', 'a-z', 'A-C'], ['-c', 'a-z', 'A-C'], ['-C', 'a-z', ' ']]) {
		rows.push(['aabbccAABBCC  \\t\\t--]]\\n\\n', `${o} ${sq(a)}${b === '' ? '' : ' ' + sq(b)}`]);
	}
	// the first hundred are the ones the first recording had; the rest go on with the same generator
	for (let i = 0; i < 500; i++) {
		const o = pick(opts);
		const k = rnd() < 0.7 ? 2 : (rnd() < 0.8 ? 1 : 3);
		const sets = [];
		for (let j = 0; j < k; j++) { sets.push(sq(set())); }
		rows.push([pick(inputs), [o, ...sets].filter(Boolean).join(' ')]);
	}
	return table(`printf '{0}' | tr {1} | od -An -c; echo "rc=\${PIPESTATUS[1]}"`, rows);
}

function sortkTable() {
	const specs = ['1', '1,1', '1,2', '2,1', '1.1', '1.0', '1.2,1.3', '1,1.0', '1.0,1', '1,0', '0,1', '0', '', ',2', '1,', '1,,2', '1,2,3', '1.', '.1', '1.1.1', '1n', '1nr', '1,1n', '1,1nr', '1b', '1,1b', '1bn,1', 'a', '1a', '1,a', '1x', '01', '001,002', '99', '1,99', '1.99', '1M', '1V', '1h', '1g', '1d', '1i', '1f', '1fr,1', '-1', '+1', '1 ', ' 1', '1.1b', '1.2,1.3b', '+2n', ' 2', '\t2', '+ 1', '++1', '+-1', '1,+2', '1,-2', '1, 2', '1.+1', '1.-1', '1,2.+1', '1.1,2.', 'n', '1nM', '1ng', '1nh', '1MV', '1dn', '1,2.0', '1.1.', '99999999999999999999', '1,99999999999999999999', '1n,', '1,.1', '1.5n,2.3bn', 'é', '1é', '+3r', '+1,+2', ' +1', '+1n', '1,1 n', '2,+1'];
	const rows = [];
	for (const sp of specs) { rows.push([`-k ${sq(sp)}`]); }
	for (const sp of specs.slice(0, 24)) { rows.push([`--key=${sq(sp)}`]); }
	rows.push(['-k2n -k1,0'], ['-t, -k2 -n'], ['-k+2n'], ['-k +1'], ['-k " 1"'], ['-k+2n -k+1,+1']);
	return table(`printf 'b 3\\na 10\\nc 2\\n' | sort {0} 2>&1; echo rc=\${PIPESTATUS[1]}`, rows);
}

function spellingTable() {
	const FX = 'mkdir -p d/sub e; echo A > a; echo X > d/x; echo Z > d/sub/z; echo F > f.txt';
	const ops = ['cp a @@', 'cp -r d @@', 'cp -n a @@', 'cp -rn d @@', 'cp -T a @@', 'mv a @@', 'mv -n a @@', 'mv -n d/. @@', 'mv d/. @@', 'mv -n d/.. @@', 'mv -t @@ a', 'cp -t @@ a', 'mkdir @@', 'mkdir -p @@', 'touch @@', 'echo hi > @@', 'echo hi >> @@', 'rm -rf @@', 'rm -r @@', 'mv a @@/'];
	const dests = ['x/../d', 'x/../e', 'x/../nothing', 'x/../a', 'x/y/../../d', 'd/../x/../d', 'a/../d', 'd/sub/../x', 'd/../d', 'd/sub/..'];
	const rows = [];
	for (const op of ops) {
		for (const t of dests) {
			// a folder copied into itself by a spelling that comes back into it: GNU copies until it meets itself, the engine
			// does not start (a known difference of the cp -r d d/sub family, in cpmv's table)
			if (/^cp -rn? d /.test(op) && ['d/../d', 'd/sub/..', 'd/sub/../x'].includes(t)) { continue; }
			rows.push([op.replace(/@@/g, t)]);
		}
	}
	return table(FX + '\n{0}; echo "rc=$?"; find . -mindepth 1 | LC_ALL=C sort; find . -type f | LC_ALL=C sort | while IFS= read -r f; do echo "$f: $(cat "$f")"; done', rows);
}

function dateTable() {
	const B = '2024-07-04 12:34:56'; // a Thursday
	const rels = ['+1 day', '+ 1 day', '1 day', '1day', '-1 day', '- 1 day', '1 day ago', '2 days ago', '3 weeks', '1 week ago', '2 fortnights', '1 month', '1 month ago', '6 months', '1 year', '1 year ago', '2 years ago', '36 hours', '90 minutes ago', '30 seconds', '1 hour', '1 hour ago', 'next day', 'next week', 'next month', 'next year', 'last day', 'last week', 'last month', 'last year', 'this week', 'this month', 'yesterday', 'tomorrow', 'today', 'now', 'noon', 'midnight', 'next monday', 'last monday', 'this monday', 'monday', 'thursday', 'next thursday', 'last thursday', 'friday', 'sat', 'sunday', 'next sun', 'last fri', '2 monday', '1 week 2 days', '1 week 2 days ago', '1 year 2 months 3 days', '+1 week +2 days', '1 day 2 hours ago', 'tomorrow noon', 'yesterday 3pm', 'next month 1 day', 'next friday 10:00', 'last day of next month', 'next hour', 'next minute', 'next second', 'a day', 'an hour ago', 'first day', 'third friday', 'second monday', 'fifth tuesday', 'twelfth day', 'week', 'day', '1 mon', '3 sec', '3 secs', '3 min', '3 mins', '2 hr', '2 hrs', '1 wk', '2 yr', '1 weeks', '1 days', '0 days', '-0 days', '100 days', '1000 days ago', '13 months', '1 fortnight ago', 'next fortnight', '12 months ago', '24 hours', '48 hours ago', '1 day 1 day ago', '1 hour 2 hours ago'];
	const abs = ['2024-07-04', '2024-7-4', '2024/07/04', '07/04/2024', '7/4/2024', '2024-07-04 12:00', '2024-07-04 12:00:30', '2024-07-04T12:00:30', '2024-07-04T12:00', '2024-07-04 12:00 UTC', '2024-07-04 12:00 +0200', '2024-07-04 12:00 -05:00', '2024-07-04 12:00 EST', '2024-07-04 12:00 EDT', '2024-07-04T12:00:00Z', '2024-07-04T12:00:00+02:00', '2024-07-04 3pm', '2024-07-04 3:30pm', '2024-07-04 12am', '2024-07-04 12pm', '2024-07-04 1:05 AM', '20240704', '20240704 1200', '2024-07-04 24:00:00', '2024-07-04 00:00', 'Jul 4 2024', 'Jul 4, 2024', 'July 4, 2024', '4 Jul 2024', '4 July 2024', 'Thu Jul 4 2024', 'Thu, 04 Jul 2024 12:00:00 +0000', 'Thursday, July 4, 2024', '4-Jul-2024', '2024-Jul-04', 'Jul 2024', '2024-07-04 12:00:30.5', '2024-07-04 12:00:30,25', '1 Jan 2020 3pm', 'Feb 29 2020', 'Feb 29 2023', '2023-02-29', '2024-02-30', '2024-13-01', '2024-00-10', '2024-04-31', '2024-07-04 25:00', '2024-07-04 12:60', '1970-01-01', '1969-12-31 23:59:59', '2038-01-19 03:14:08', '2100-02-29', '2000-02-29', '1900-02-29', '9999-12-31', '2024-12-31 23:59:60', '@0', '@1700000000', '@-1', '@1.5', '@-1.5', '@0.000000001', '2024-07-04 garbage', 'garbage'];
	const lines = [];
	for (const r of rels) { lines.push(`${B} ${r}`); }
	for (const r of ['', ...rels.slice(0, 40)]) { lines.push(`${r} ${B}`.trim()); }
	for (const a of abs) { lines.push(a); }
	for (const a of ['2024-07-04', '2024-07-04 18:00']) { for (const r of ['+1 day', '1 month ago', 'next monday', 'last friday', '2 weeks', 'yesterday', 'tomorrow', 'noon', '3 hours', 'next year', 'last month', 'this friday', '1 week 3 days ago']) { lines.push(`${a} ${r}`); } }
	for (const r of ['2024-01-31 +1 month', '2024-03-31 -1 month', '2023-02-28 +1 day', '2024-02-28 +1 day', '2024-02-29 +1 year', '2024-02-29 -1 year', '2024-12-31 +1 day', '2024-01-01 -1 day', '2024-10-27 +1 day', '2024-03-31 +1 day', '2024-05-31 -1 month', '2024-01-30 +1 month']) { lines.push(r); }
	// the fourth fix round: blanks that are not spaces, the military zones, offsets, two-digit years, am and pm, weekdays with
	// their counts, a time given as digits, the T separator, and dst
	const more = [
		'2024-07-04\t12:00', '2024-07-04\n12:00', '2024-07-04\r12:00', '2024-07-04\v12:00', '2024-07-04\f12:00', '2024-07-04 12:00\t1\tday\tago', '2024-07-04 12:00\vnext\vmonday', '2024-07-04 12:00\r', '\f2024-07-04', '(a comment) 2024-07-04', '2024-07-04 (x(y)z) 12:00',
		'2024-07-04 12:00 +05:30', '2024-07-04 12:00 -0530', '2024-07-04 12:00 +5:30', '2024-07-04 12:00 +05', '2024-07-04 12:00 +5', '2024-07-04 12:00 +05:3', '2024-07-04 12:00 +0530', '2024-07-04 12:00 UTC+5', '2024-07-04 12:00 UTC-5', '2024-07-04 12:00 GMT+3', '2024-07-04 12:00 EST5', '2024-07-04 12:00 Z', '2024-07-04 12:00 z', '2024-07-04T12:00:00Z', '2024-07-04T12:00:00z', '2024-07-04 12:00 +14:00', '2024-07-04 12:00 +15:00', '2024-07-04 12:00 -12:00', '2024-07-04 12:00 +24:00',
		'1/2/68', '1/2/69', '1/2/70', '1/2/99', '1/2/00', '1/2/68 12:00', '2/1/06', '1/2/100', '1/2/1', '1/2/001', '1/31/24', '12/31/99', '6-5-24', '24-6-5',
		'2024-07-04 12am', '2024-07-04 12pm', '2024-07-04 1am', '2024-07-04 11pm', '2024-07-04 0am', '2024-07-04 13pm', '2024-07-04 12:30 am', '2024-07-04 12:30 pm', '2024-07-04 0:30 am', '2024-07-04 13:00 pm', '2024-07-04 1 a.m.', '2024-07-04 1 p.m.', '2024-07-04 12 A.M.', '2024-07-04 12:00:00 pm', '2024-07-04 12:00:01 am', '2024-07-04 11:59:59 PM',
		'2024-07-04 1230', '2024-07-04 930', '2024-07-04 0930', '2024-07-04 2359', '2024-07-04 2400', '2024-07-04 12:60', '2024-07-04 25:00', '2024-07-04 24:00', '2024-07-04 24:00:01', '2024-07-04 12:00:60', '2024-07-04 12:00:61', '2024-07-04 1:2:3', '2024-07-04 01:02:03.5', '2024-07-04 12:00.5',
		'2024-07-04t12:00', '2024-07-04T12:00', '2024-07-04 T12:00', '2024-03-10 02:30 dst', '2024-07-04 12:00 dst', '2024-07-04 now dst', '2024-07-04 12:00 UTC dst',
		'@0', '@1', '@-1', '@1.5', '@1720096496', '@ 5', '@5 +1 day', '@5 12:00',
		'2024-07-04 +\t1 day', '2024-07-04 -\n1 day', '2024-07-04 + 1 day', 'Sept 4 2024', '4 sept 2024', 'sept 4 2024', '2024-07-04 12:00 +05 10 minutes', '2024-07-04 12:00 -03 2 hours ago', '2024-07-04 12:00 +0530 1 day', '2024+07+04', '2024-07+04', '2024+07-04', '7/4 2024', '7/4 -2024', '7/4 12:00 2024', '7/4 2024 12:00', '7/4/2024/5', '2024-07-04 monday tuesday', '2024-07-04 2 monday 3 tuesday', '2024-07-04 12:00 1 day ago ago', '2024-07-04 12:00 2 hours ago 1 day', '2024-07-04 12:00 1 day ago 2 hours ago', '2024-07-04T12 00', '2024-07-04T12:', '2024-07-04 T 12:00', '2024-07-04 12', '2024-07-04 9', '2024-07-04 24', '2024-07-04 99', '2024-07-04 120', '2024-07-04 1200', '2024-07-04 12000', '2024-07-04 00', '2024-07-04 0',
	];
	for (const l of more) { lines.push(l); }
	for (const a of 'ABCDEFGHIKLMNOPQRSTUVWXY'.split('')) { lines.push(`${B} ${a}`); lines.push(`${B.slice(0, 16)}${a.toLowerCase()}`); }
	const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sun', 'mon', 'tue', 'tues', 'wed', 'wednes', 'thu', 'thur', 'thurs', 'fri', 'sat'];
	for (const w of dayNames) { for (const k of ['', 'next ', 'last ', 'this ', '2 ', '-1 ', '+1 ', '3 ', '0 ', 'first ', 'second ', 'third ', 'twelfth ', 'previous ']) { lines.push(`${B} ${k}${w}`); } }
	for (const w of ['monday', 'thursday', 'friday']) { for (const k of ['2024-07-01 ', '2024-07-04 ', '2024-07-05 ']) { lines.push(`${k}${w}`); lines.push(`${k}next ${w}`); lines.push(`${k}last ${w}`); lines.push(`${k}${w} 12:00`); } }
	const rows = lines.map((l) => ['UTC', sq(l)]);
	// the zone of the command, with the date given in full
	const { rnd, pick } = prng(5);
	const dates = ['2024-07-04', '2023-12-31', '1999-01-01', '2024-02-29', 'Jul 4 2024', '4 Jul 2024', '07/04/2024', '20240704', 'July 4, 2024'];
	const times = ['12:00', '00:00', '23:59:59', '3pm', '11:30 pm', '12am', '6:05:07', '9 am', '18:00:00'];
	const rel2 = ['+1 day', '1 day', '-1 day', '2 days ago', '1 week', '3 weeks ago', '1 month', '2 months ago', '1 year', '5 hours', '90 minutes', '45 seconds ago', 'next day', 'last day', 'next week', 'next month', 'yesterday', 'tomorrow', 'next monday', 'last friday', 'this thursday', 'monday', '36 hours ago'];
	// (a named zone with a relative part, under a TZ that has daylight saving time, is "invalid date" in GNU for a reason
	// of its own, which the engine does not have: those are drawn with the offsets only)
	const zones = ['UTC', 'EST', 'EDT', '+0200', '-0500', '+05:30'];
	for (let i = 0; i < 400; i++) {
		const tz = pick(['UTC', 'UTC', 'America/New_York', 'Asia/Tokyo', 'Europe/Berlin']);
		const parts = [pick(dates)];
		if (rnd() < 0.6) { parts.push(pick(times)); if (rnd() < 0.25) { const z = pick(zones); parts.push(tz !== 'UTC' && /^[A-Z]/.test(z) && z !== 'UTC' ? '+0200' : z); } }
		parts.push(pick(rel2));
		if (rnd() < 0.15) { parts.push(pick(rel2)); }
		rows.push([tz, sq(parts.join(' '))]);
	}
	return table(`export LC_ALL=C; TZ={0} date -d {1} '+%F %T.%N %z %Z'; echo rc=$?`, rows);
}

// (a POSIX string with a daylight saving part and rules, `EST5EDT,M3.2.0,M11.1.0`, or with a name and the default rule,
// `CET-1CEST`, is read as its standard time here: README §6; it is not in the table)
function tzTable() {
	const zs = ['5', ':5', '-5', '+5', '+09:00', '-0500', '+0530', 'UTC', 'UTC0', 'GMT', 'GMT+3', 'GMT-3', 'EST5EDT', 'JST-9', 'PST8PDT', '<+03>-3', '<-03>3', 'Asia/Tokyo', ':Asia/Tokyo', 'asia/tokyo', 'America/New_York', 'Europe/Berlin', 'Nowhere/Land', '', ':', ' ', 'X', 'ABC', 'ABC5', 'ABC-5:30', 'AB5', '/usr/share/zoneinfo/Asia/Tokyo', ':/usr/share/zoneinfo/Asia/Tokyo', '/usr/share/zoneinfo/posix/Asia/Tokyo', './Asia/Tokyo', 'Asia//Tokyo', 'Asia/./Tokyo', '/usr/share/zoneinfo//Asia/Tokyo', '/usr/share/zoneinfo/../zoneinfo/Asia/Tokyo', '/usr/share/zoneinfo/nonexistent', '/usr/share/zoneinfo/', '/Asia/Tokyo', '/tmp/x', 'a/../Asia/Tokyo', 'Asia/Tokyo/', '/usr/share/zoneinfo/UTC', '/usr/share/zoneinfo/GMT', '/etc/localtime', '/usr/share/zoneinfo/America/New_York', '/usr/share/zoneinfo/asia/tokyo'];
	return table(`export LC_ALL=C; for t in 1600000000 1720000000 0; do TZ={0} date -d @$t '+%F %T %Z %z'; done; echo rc=$?`, zs.map((z) => [sq(z)]));
}

function xargstTable() {
	const words = [];
	for (let c = 32; c < 127; c++) { words.push(String.fromCharCode(c)); }
	for (const ch of ['a', ' ', "'", '"', '\\', '$', '`', '!', '*', '?', '[', ']', '{', '}', '(', ')', '<', '>', '|', '&', ';', '~', '#', '^', '%', '=', ',', ':', '@', '+', '-', '.', '/']) {
		words.push('a' + ch + 'b', ch + 'ab', 'ab' + ch, ch + ch, ch + 'a' + ch);
	}
	words.push('', ' ', '\t', '\n', 'a\nb', '\x01', 'a\x01', '\x7f', 'é', 'aé', 'é b', '😀', '{}', 'a{}b', '^a', 'a^b', "it's", "'a'", '"a"', "a'b'c", '~', 'a~', '~a', 'a b c', '--', '-n', '-', '=a', 'a=', '%s', '%', '\\n', '\\', '\\\\', 'a\\', '$HOME', '${x}', '$(x)', '`x`', '*.txt', '?', '[a-z]', '{a,b}', '#a', 'a#', '!', '!a', 'a!', 'a\\ b');
	// (`$''` is an empty word in bash and no word in the engine, a defect of the vendored parser that is not patched: README §6)
	const ansi = (w) => w === '' ? "''" : "$'" + [...w].map((ch) => {
		const c = ch.codePointAt(0);
		if (ch === "'") { return "\\'"; }
		if (ch === '\\') { return '\\\\'; }
		if (ch === '\n') { return '\\n'; }
		if (ch === '\t') { return '\\t'; }
		if (c < 32 || c === 127) { return '\\x' + c.toString(16).padStart(2, '0'); }
		return ch;
	}).join('') + "'";
	return table(`export LC_ALL=C.UTF-8; printf 'x\\n' | xargs -t echo {0} 2>&1 >/dev/null | od -An -c`, [...new Set(words)].map((w) => [ansi(w)]));
}

const PROGRAMS = ['xargs', 'grep', 'cp', 'mv', 'rm', 'mkdir', 'sed', 'paste', 'head', 'tail', 'stat', 'uniq', 'wc', 'touch', 'ls', 'sort', 'du', 'awk', 'date', 'od', 'realpath', 'cmp', 'nproc', 'basename', 'comm', 'join', 'cut'];
function optionsTable() {
	return table(`p={0}
mkdir -p /tmp/w && cd /tmp/w
for c in $(printf '%s ' {a..z} {A..Z} {0..9}); do
  e=$(timeout 5 $p -$c </dev/null 2>&1 >/dev/null | head -4)
  case "$e" in *"requires an argument"*) echo "S $c req";; *"invalid option"*) echo "S $c inv";; *) echo "S $c ok";; esac
done
for n in $($p --help 2>&1 | grep -o -- '--[a-z][a-z0-9-]*' | sort -u); do
  e=$(timeout 5 $p $n </dev/null 2>&1 >/dev/null | head -4)
  case "$e" in *"requires an argument"*) echo "L $n req";; *"unrecognized option"*|*"invalid option"*) echo "L $n unk";; *) echo "L $n ok";; esac
done`, PROGRAMS.map((p) => [p]));
}

/** the wording GNU answers with to an option that is last on the line and has no value */

const REINPUT = "printf 'a\\nb\\nab\\n*a\\n**\\naab\\nx\\n a*b\\nab*\\n{1\\na{,2}\\n.\\nfoo bar\\n' > in";

/** random patterns, drawn from the pieces of a basic or an extended expression; `ere` says which */
function regexPatterns(seed, n, ere) {
	const { rnd, pick } = prng(seed);
	const bre = ['a', 'b', 'x', '*', '\\(', '\\)', '\\|', '^', '$', '.', '[ab]', '[*]', '[^*]', '\\+', '\\?', '\\{1,2\\}', '\\{2\\}', '\\*', '\\.', '[]a]', '[a-b]', '\\(a\\)', '\\(*\\)', '\\(^a\\)', 'a*', 'b*', ' ', '[[:alpha:]]', '[.]', '\\<', '\\>', '\\b', '\\w', '\\W', '\\1', '\\(a\\|b\\)', 'o\\+', '[\\.]', '[^\\]'];
	const ex = ['a', 'b', 'x', '*', '(', ')', '|', '^', '$', '.', '[ab]', '[*]', '[^*]', '+', '?', '{1,2}', '{2}', '\\*', '\\.', '[]a]', '[a-b]', '(a)', '(*)', '(^a)', 'a*', 'b+', ' ', '[[:alpha:]]', '{', '}', '{1', 'a{,2}', '\\<', '\\>', '\\b', '\\w', '\\W', '\\1', '(a|b)', 'o+', '[\\.]', '[^\\]'];
	const toks = ere ? ex : bre;
	const seen = new Set();
	const out = [];
	while (out.length < n) {
		const k = 1 + Math.floor(rnd() * 4);
		let p = '';
		for (let i = 0; i < k; i++) { p += pick(toks); }
		if (seen.has(p)) { continue; }
		seen.add(p);
		out.push(p);
	}
	return out;
}

function sedreTable() {
	const rows = [];
	for (const [ere, seed] of [[false, 11], [true, 12]]) {
		for (const p of regexPatterns(seed, 100, ere)) {
			rows.push([`${ere ? '-E ' : ''}-n ${sq('s/' + p + '/X/p')}`]);
			rows.push([`${ere ? '-E ' : ''}-n ${sq('/' + p + '/p')}`]);
		}
	}
	return table(REINPUT + "; sed {0} in 2>&1; echo \"rc=$?\"", rows);
}

function grepreTable() {
	const rows = [];
	for (const [ere, seed] of [[false, 21], [true, 22]]) {
		for (const p of regexPatterns(seed, 100, ere)) {
			rows.push([`${ere ? '-E ' : ''}-c -- ${sq(p)}`]);
			rows.push([`${ere ? '-E ' : ''}-o -- ${sq(p)}`]);
		}
	}
	return table(REINPUT + "; grep {0} in 2>&1; echo \"rc=$?\"", rows);
}

function sedidiomTable() {
	const scripts = [
		's/[\\/&]/\\\\&/g', 's/[/]/X/g', 's|[/]|X|g', 's/[.]/X/g', 's/[^/]*$//', 's/[][]/X/g', 's/[]]/X/', 's/[a-z]*\\.//', 's/\\//X/g', 's/a\\/b/X/', 's,a\\,b,X,', 's/[,]/X/',
		's/[\\\\]/X/', 's/\\[/X/', 's/\\]/X/', 's/[[]/X/', 's/\\./X/', 's/\\*/X/', 's/\\$/X/', 's/[\\/]/X/g', 's/[\\.]/X/g', 's/[\\n]/X/g', 's/[\\t]/X/g', 's/\\(foo\\),\\(bar\\)/\\2,\\1/',
		's/[[:alpha:]]\\+/W/g', 's/[^[:alnum:]]/_/g', 's/[0-9]*//', 's@/usr@X@', 's#/#:#g', 's/ *$//', 's/^[ \\t]*//', 's/[aeiou]/\\U&/g', 's/\\(.\\)\\(.\\)/\\2\\1/', 's/a\\|f/X/g', 's/\\(a\\|f\\)/<\\1>/g',
		's/.*\\///', 's/.*\\(.\\)/\\1/', 's/\\&/X/', 's/&/[&]/', 's/a/\\n/', 's/a/\\t/', 's/b/\\//', 's/b/\\&/', 's/c/\\\\/', 's/\\([^,]*\\),\\(.*\\)/\\2 \\1/',
		's/b/\\\\&/', 's/b/\\\\n/', 's/b/\\\\\\\\/', 's/b/[\\\\]/', 's/b/\\x41/', 's/b/\\o101/', 's/b/\\d65/', 's/b/\\cA/', 's/b/\\a/', 's/b/\\f/', 's/b/\\v/', 's/\\x62/X/', 's/\\o142/X/', 's/\\d98/X/',
		's/b/\\L&/', 's/b/\\U&/', 's/B/\\L&/', 's/\\(.*\\)/\\U\\1/', 's/\\(.\\)\\(.*\\)/\\U\\1\\L\\2/', 's/\\w\\+/\\u&/g', 's/\\w\\+/\\l&/g', 's/.*/\\L\\u&/', 's/\\(a\\)\\(b\\)/\\u\\1\\U\\2x\\Ey/',
		's/b/\\Uu\\Ex/', 's/\\(a\\)\\|b/[\\1]/g', 's/\\(x\\)*b/[\\1]/', 's/b/\\0\\0/', 's/b/\\1/', 's/\\(b\\)/\\2/', 's/\\<./\\U&/g', 's/\\<\\(.\\)/\\u\\1/g', 's/.\\>/X/g', 's/\\<[^ ]/X/g',
		'y/ /\\t/;s/\\cI/<T>/g', 's/ /\\x09/g;s/\\o11/T/g', 's/b/\\d66/;s/\\d66/b/', 's/[\\x61]/X/g', 's/\\o141/X/g', 's/\\d97/X/g', 's/[\\o141]/X/g', 's/[\\d97]/X/g', 's/\\cA//', 's/[\\n]x/Y/', 's/\\.\\o56/Z/',
		's/[(]a/\\1/', 's/\\(\\(a\\)\\)/\\2\\1/', 's/\\(a\\)\\(b\\)\\(c\\)/\\3\\2\\1/', 's/\\(a\\)b/\\2/', 's/a\\(b\\)\\?/[\\1]/', 's/[\\(]/\\1/', 's/\\\\(a/\\1/', 's/(a)/\\1/', 's/\\(a\\)\\|b/\\1\\1/g', 's/\\(x\\)*\\(a\\)/\\2\\1/', 's/a/\\0\\0/', 's/\\(a\\)/\\10/', 's/\\(a\\)/\\9/',
		's/[[:alpha:]\\.]/X/g', 's/[^[:alpha:]\\.]/X/g', 's/[[:digit:][:space:]\\\\]/X/g', 's/[[=a=]\\.]/X/g', 's/[[.a.]\\.]/X/g', 's/[\\o141\\d98]/X/g', 's/[a\\o55z]/X/g', 's/\\<[^b]/X/g', 's/\\<\\(.\\)\\(.\\)/\\2\\1/g', 's/[^a]\\>/X/g', 's/[a-c]\\>/X/g', 's/\\<[a-c]/X/g',
		's/\\<\\.//', 's/a\\|\\./X/g', 's/\\.\\|^a/X/g', 's/[[:upper:]\\]]/X/g', 's/[]\\]/X/g', 's/[^]\\]/X/g', 's/\\(\\.\\|a\\)/<\\1>/g', 's/\\d97\\|\\x62/X/g', 's/a\\{1\\}\\.\\?/X/g', 's/[\\.-]/X/g',
		's/[^(]\\(a\\)/\\2/', 's/[]()]\\(a\\)/\\2/', 's/[[:alpha:](]\\(a\\)/\\2/', 's/[[:alpha:](]\\(a\\)/\\1/', 's/[[.(.]]\\(a\\)/\\2/', 's/\\((\\)a/\\2/',
		's/a$\\|b$/X/', 's/^a\\|^b/X/', 's/x\\|^a/Y/g', 's/b$\\|a/Z/g', 's/^\\(a\\|f\\)/<&>/', 's/\\(a$\\|b$\\)/[&]/', 's/\\(^a\\|b$\\)/[&]/',
		's/\\<[a-z]/\\U&/g', 's/\\b./\\u&/g', 's/o\\>/0/g', 's/\\<f/F/g', 's/\\bb/B/g', 's/\\Bo/0/g', 's/[0-9]\\+/<&>/g', 's/\\s\\+/ /g', 's/\\S\\+/<&>/g', 's/\\w*/<&>/', 's/\\W/_/g',
		's/\\(.*\\)\\n/\\1/', 'N;s/\\n/ /', '$!N;s/\\n/,/', ':a;N;$!ba;s/\\n/ /g', 's/a*/X/g', 's/b*/X/2', 's/o/0/2', 's/o/0/2g', 's/O/0/I', 's/a/b/;s/b/c/', 'y/abc/xyz/', 'y/\\n/ /',
	];
	const rows = [];
	for (const sc of scripts) {
		rows.push([`${sq(sc)}`]);
		// the same with -E where the basic text has no group, interval or alternation of its own (those are spelled differently)
		if (!/\\[(){}|+?]/.test(sc)) { rows.push([`-E ${sq(sc)}`]); }
	}
	return table("printf 'a/b&c.d\\\\e[f]g*h$i\\n/usr/local/bin\\nfoo,bar\\nfoo bar baz\\nABC abc 123\\n  indented  \\n' > in; sed {0} in 2>&1; echo \"rc=$?\"", rows);
}

function sedaddrTable() {
	const sc = [
		'/two/Ip', '/TWO/I,/FOUR/Id', '\\,/usr,d', '\\#usr#p', '\\|usr|p', '\\,u\\,,p', '/one/,+2p', '/two/I,+1d', '0,/e/d', '1,/e/d', '2,/e/d', '2,~4p', '4,~4p', '5,~2p', '/t/,/f/p', '/t/,/f/!d', '2,4!d',
		'$!d', '1~2d', '2~2p', '0~3p', '/o/{s/o/0/;p}', '/one/I{n;d}', '/e$/!d', '/^$/d', '/\\//p', '/[/]/p', '/two/Ip;/Four/Ip', '/two/M p', '/x/I,$d', '$p', '/six/,$p', '3,$d', '3,+1d',
		'/nomatch/p', '/th/,/nomatch/p', '2,1p', '2,2p', '/e/,/e/p', '/one/,/one/p', '/ee/,3p', '3,/e/p', '/T/I,/F/Ip', '2!d', '/two/I!d', '1d;$d', '2q', '/three/Q', '/two/,/four/I{/three/d}', '/x/,/y/d',
		'2,~0p', '8,~0p', '\\,a\\.b,p', '\\|a\\.b|p', '\\,a.b,p', '/a\\.b/!d', '\\.a\\.b.p', '\\xa\\.bxp',
		'\\.a.p', '\\|a\\|b|p', '\\,[,],p', '\\,a\\,b,p', '\\%x%p', '\\xaxp', '/a/I,/b/Ip', '/^T/M p', '2,~2p', '1,~3p', '3,~3p', '$,~2p', '/x/,~4p', '6,~4p', '0,/o/p', '0,/^t/Id',
		'1~3p', '2,5{/e/d}', '/o/,+1{s/o/0/}', '/five/,/six/!p', '$!N;P;D', '\\,two,Ip', '/two/,/nothing/p', '5,2p', '/Four/I,3p',
		'\\,a\\.b,p', '\\|a\\.b|p', '\;a\\.b;p', '/[\\]]/p', '\\,[\\],]x,p', '\\.[.].p', '\\#[#]#p', '\\|a\\|b|!p', '/a.b/p', '/a\\.b/p',
		'\\%/usr%I p', '\;us;p', '/[Tt]wo/p', '/^T/p', '/\\(T\\|F\\)/p', '/\\(T\\|F\\)/,+1d', '/e\\+/p', '/o\\{2\\}/p', '/\\<f/Ip', '/x\\>/p',
		'/one/,3p', '/two/,4p', '/o/,3p', '/e/,2p', '/e/,1p', '0,/one/p', '0,/o/d', '/o/,3d', '/e/,4d', '1,/o/d', '/two/I,3p',
		'N;/e.T/Mp', 'N;/e.T/p', 'N;/e[^x]T/Mp', 'N;/e[^x]T/p', 'N;/e\nT/Mp', 'N;/^T/Mp', 'N;/^T/p', 'N;/e$/Mp', 'N;/e$/p', 'N;\\,e.T,Mp', 'N;\\,e.T,p',
		'N;/E.t/MIp', 'N;/e.T/IMp', 'N;/E$/IMp', 'N;/E$/Ip',
	];
	const rows = [];
	for (const s of sc) {
		rows.push(['-n', s]);
		rows.push(['', s]);
		if (!/\\[(){}|+?]/.test(s)) { rows.push(['-E', s]); }
	}
	return {
		tpl: "printf 'one\\nTwo\\nthree\\nFour\\nfive\\n/usr/x\\nsix\\na.b\\naxb\\n' > in; sed {0} {1} in 2>&1; echo \"rc=$?\"",
		rows: rows.map(([f, s]) => [f, sq(s)]),
	};
}


/**
 * What sed and grep do with the regular expressions at the edges of the grammar, and with a script that is not well
 * formed (the batteries of the fourth fix round): numeric escapes (\\xHH \\oNNN \\dNNN with digits and without, in a
 * bracket and out), \\c, the case flags of a replacement, class / collating / equivalence elements in a bracket and
 * the delimiter, \\< and \\> next to a character that is not a word character, intervals, groups, `[:space:]` written
 * without its outer brackets, a command that is followed by something else, the flags of s.
 */
function sedgramTable() {
	const basic = [
		's/\\x2e/X/g', 's/\\x2a/X/g', 's/\\x5b/X/g',
		's/\\x5d/X/g', 's/\\x2f/X/g', 's/\\x4a/X/g',
		's/\\x6a/X/g', 's/\\x7e/X/g', 's/\\x3a/X/g',
		's/\\x5c/X/g', 's/\\d046/X/g', 's/\\d46/X/g',
		's/\\d047/X/g', 's/\\d074/X/g', 's/\\d106/X/g',
		's/\\o056/X/g', 's/\\o56/X/g', 's/\\o152/X/g',
		's/\\o1/X/g', 's/\\x4/X/g', 's/\\x/X/g',
		's/\\xzz/X/g', 's/\\d/X/g', 's/\\o/X/g',
		's/\\o8/X/g', 's/\\dx/X/g', 's/\\x2e*/X/g',
		's/\\x2e\\+/X/g', 's/a\\x2eb/X/', 's/\\x5e/X/g',
		's/\\x24/X/g', 's/\\x5ba/X/g', 's/\\d092/X/g',
		's/\\x4a\\x6f/X/g', 's/[\\x2e]/X/g', 's/[\\d046]/X/g',
		's/[\\o056]/X/g', 's/[\\x2e\\x2a]/X/g', 's/[\\x]/X/g',
		's/[\\d]/X/g', 's/[\\o]/X/g', 's/[\\x5d]/X/g',
		's/[\\x5c]/X/g', 's/[^\\x61]/X/g', 's/[\\x4a]/X/g',
		's/[\\x6a]/X/g', 's/[\\d106]/X/g', 's/[\\o152]/X/g',
		's/[\\x2d]/X/g', 's/[a\\x2dz]/X/g', 's/[\\x5e]/X/g',
		's/[\\xzz]/X/g', 's/[\\q]/X/g', 's/[a\\]/X/g',
		's/[\\n]/X/g', 's/[\\t]/X/g', 's/[\\r]/X/g',
		's/[\\f]/X/g', 's/[\\v]/X/g', 's/[\\a]/X/g',
		's/\\cA/X/', 's/a\\c/X/', 's/\\c/X/',
		's/\\cb/X/', 's/\\c[/X/', 's/a\\cI/X/',
		's/a/\\c/', 's/a/\\cb/', 's/a/\\c\\\\/',
		's/a/\\c[/', 's/a/\\cA/', 's/a/\\x/',
		's/a/\\x4/', 's/a/\\x4a/', 's/a/\\x4aa/',
		's/a/\\o/', 's/a/\\o1/', 's/a/\\o152/',
		's/a/\\o1522/', 's/a/\\d/', 's/a/\\d6/',
		's/a/\\d106/', 's/a/\\d1066/', 's/a/\\xg/',
		's/a/\\o8/', 's/a/\\dz/', 's/a/\\/',
		's/\\(a\\)/\\1\\/', 's/a/\\9/', 's/\\(a\\)/\\1\\1\\1/',
		's/\\(a\\)\\(b\\)\\(c\\)\\(d\\)\\(e\\)\\(f\\)\\(g\\)\\(h\\)\\(i\\)/\\9\\8/', 's/\\(a\\)/\\0/', 's/a/\\r/',
		's/a/\\E/', 's/a/\\Ex/', 's/\\(a\\)/\\u\\1x/',
		's/a/\\ux/', 's/a/\\lA/', 's/A/\\lA/',
		's/a/\\Ua\\Eb/', 's/a/\\U/', 's/a/\\u/',
		's/a/\\l\\Uab/', 's/ab/\\u\\L&X/', 's/[[:a:]]/X/',
		's/[[.a.]]/X/', 's/[[=a=]]/X/', 's/[[.-.]]/X/g',
		's/[[.].]]/X/g', 's/[[=]=]]/X/g', 's/[[.^.]]/X/g',
		's/[a[.-.]z]/X/g', 's/[[.\\.]]/X/', 's/[[:alpha:][.x.]]/X/',
		's/[[.space.]]/X/', 's/[[:alpha:]/X/', 's/[[.a./X/',
		's/[[:alpha:]]*/X/', 's/[a-[.z.]]/X/g', 's/[[=a=]b]/X/g',
		's/[[.a.][.b.]]/X/g', 's/[[:alpha:]-]/X/g', 's/[[:digit:]a]/X/g',
		's/[[:foo:]]/X/', 's/[[.ab.]]/X/', 's/[[=ab=]]/X/',
		's/[z-a]/X/', 's/[a-]/X/g', 's/[]-a]/X/g',
		's/[^]a]/X/g', 's/[[]/X/g', 's/[[a]/X/g',
		's/[[:]/X/g', 's/[[:a]/X/g', 's/[[.]/X/g',
		's/[[=]/X/g', 's/[a[:]/X/g', 's/[\\]/X/g',
		's/[\\]]/X/g', 's/[\\\\]/X/g', 's/[\\.]/X/g',
		's/\\<-/X/g', 's/-\\>/X/g', 's/\\.\\>/X/g',
		's/&\\>/X/g', 's/\\<,/X/g', 's/\\<\\./X/g',
		's/\\>,/X/g', 's/,\\>/X/g', 's/\\<~/X/g',
		's/~\\>/X/g', 's/\\<j/X/g', 's/j\\>/X/g',
		's/\\<\\(-\\)/X/g', 's/\\(-\\)\\>/X/g', 's/\\<[-,]/X/g',
		's/[-,]\\>/X/g', 's/\\<./X/g', 's/.\\>/X/g',
		's/\\<\\>/X/g', 's/\\>\\</X/g', 's/\\</X/g',
		's/\\>/X/g', 's/\\b/X/g', 's/\\B/X/g',
		's/-\\</X/g', 's/\\>-/X/g', 's/ \\</X/g',
		's/\\> /X/g', 's/\\<\\(\\)a/X/g', 's/\\<\\(a\\|-\\)/X/g',
		's/\\<[^a-z]/X/g', 's/[^a-z]\\>/X/g', 's/\\(a\\|b\\)\\{2\\}/X/g',
		's/a\\|b\\|c/X/g', 's/^a\\|b$/X/g', 's/\\(^a\\)/X/',
		's/\\(a$\\)/X/', 's/a\\(^b\\)/X/', 's/\\(a\\)\\(\\)/\\2/',
		's/\\(\\(a\\)\\|b\\)/\\2/g',
	];
	const extended = [
		's/(a|b){2}/X/g', 's/a|b|c/X/g', 's/^a|b$/X/g',
		's/(^a)/X/', 's/(a$)/X/', 's/a(^b)/X/',
		's/(a)()/\\2/', 's/((a)|b)/\\2/g', 's/a{2}/X/g',
		's/a{1,2}/X/g', 's/a{,2}/X/g', 's/a{1/X/g',
		's/{1/X/g', 's/a{/X/g', 's/x{2,1}/X/',
		's/a{40000}/X/', 's/a{1,40000}/X/', 's/a{32767}/X/',
		's/a{32768}/X/', 's/a{1000}/X/', 's/a{1001}/X/',
		's/a{2,1}/X/', 's/a{1,32768}/X/', 's/a{32768,}/X/',
		's/(a/X/', 's/a)/X/', 's/()/X/',
		's/a|/X/', 's/|a/X/', 's/(|a)/X/',
		's/a**/X/', 's/+a/X/', 's/?a/X/',
		's/a+?/X/', 's/(a)\\1/X/', 's/(a)\\2/X/',
		's/a\\1/X/', 's/\\(a\\)/X/', 's/\\{1\\}/X/',
		's/a\\{1\\}/X/', 's/[a-/X/', 's/\\<a/X/g',
		's/a\\>/X/g', 's/\\.\\>/X/g', 's/\\<,/X/g',
		's/-\\>/X/g', 's/\\<-/X/g', 's/[[:alpha:]]+/X/g',
		's/\\x2e/X/g', 's/\\d046/X/g', 's/\\o056/X/g',
		's/[\\x2e]/X/g',
	];
	const bracket = [
		's/[/]/X/g', 's/[[:alpha:]/X/]/Y/', 's/[[:alpha:]/X/', 's/[a-z/]/X/',
		's/[[.a.]/X/]/Y/', 's/[[=a=]/X/]/Y/', 's/[]/]/X/', 's/[^]/]/X/',
		's/a[/b/', 's/[[:alpha:]]/X/', 's/[a[:alpha:]/]/X/', 's/[[:alpha:][:digit:]/]/X/',
		's/[:alpha:]/X/', 's/[[:]/X/]/Y/', 's/[a[:]/]/X/', 's/[a[]/]/X/',
		's/[\\/]/X/', 's/[\\]/]/X/', 's/[[.].]/]/X/', 's/[[=]=]/]/X/',
		's/\\[/]/X/', 's/[[:alpha:]/]/X/g', 's/a\\/b/X/', 's/x[/]y/Z/',
	];
	const grammar = [
		's/a/b/X', 's/a/b/gx', 's/a/b/ ', 's/a/b/ ;p',
		's/a/b/ p', 's/a/b/g p', 's/a/b/;p', '{s/a/b/}',
		's/a/b/#c', 's/a/b/ #c', 's/a/b/M', 's/a/b/m',
		'$!N;s/^b/X/M', '$!N;s/a$/X/M', 's/a/b/2p', 's/a/b/pg',
		's/a/b/gI', 's/a/b/0', 's/a/b/gg', 's/a/b/pp',
		's/a/b/2 3', 'p x', 'p;x',
		'p x;p', 'd x', 'dp', 'px',
		'p p', 'y/a/b/x', 'y/a/b/ p', 'y/a/b/;p',
		'=x', 'q x', 'q5x', 'l x',
		'l 5x', 'a\\', 'p}', 'p;}',
		'{p', '{p;', '{p}', '{p} p',
		'{p};p', '{p}p', 'p # c', 'p#c',
		'ps', 'N x', 'D x', 'G;x x',
		'b x', 'bx', 'b x y', ':a x',
		':a;p', 'b a;:a', 'r', 'w',
		'x;p;x', '1!G;h;$!d', '$!{N;D}', 'n;n',
		's/a/b/;;p', ';p', ';;p', 'p;;',
		'{;p}', '{p;;}', '2,3!p', '2!!p',
		'2! p', '2 !p', '2 p', '2,3 p',
		'2 , 3p', '1,p', ',3p', '3,2p',
		'2,+1p', '0p', '0,2p', '0~2p',
		'2~0p', '$p', '$ p', '$$p',
		'1$p', '/a/ p', '/a/ !p', '/a/,/b/p',
		'/a/I p', '/a/ I p', '/a/Ip', '/a/pI',
		'/a/M p',
	];
	const classes = [
		'[:alpha:]', '[:alpha]', '[alpha:]', '[:a:b]', '[::]', '[:]',
		'[:a]', '[a:]', '[:ab:]x', '[^:a:]', '[:a-z:]', '[:a:]b]',
		'[:a[:digit:]:]', '[[:alpha:]:]', '[:[:alpha:]]', '[:::]', '[:a:b:]', '[: :]',
		'x[:alpha:]', '[:alpha:]*', '[:alpha:]+', 'a|[:alpha:]', '[:digit:][:alpha:]', '[[:alpha:]][:alpha:]',
		'[:a.:]', '[:\\:]', '[:a\\:]', '[:alpha:\\]',
	];
	const rows = [];
	const patternOf = (s) => { const p = s.split('/'); return p.length === 4 && p[0] === 's' && !p[1].includes('\n') ? p[1] : null; };
	for (const s of basic) { rows.push(['', s]); }
	for (const s of extended) { rows.push(['-E', s]); }
	for (const s of basic) { const p = patternOf(s); if (p !== null) { rows.push(['-n', '/' + p + '/p']); } }
	for (const s of extended) { const p = patternOf(s); if (p !== null) { rows.push(['-E -n', '/' + p + '/p']); } }
	for (const s of bracket) { rows.push(['', s]); rows.push(['-E', s]); }
	for (const s of grammar) { rows.push(['-n', s]); }
	// a script of several -e (the expression of the message is the one that has the fault) and of several lines
	const second = ['k', 's/a/b', 'y/ab/c', '{p', '}', '2', '/\\(/p', 'p x', 's/a/b/X', '0p', '/a[/p', 's/\\(a\\)/\\2/', 's/a/b/gg', 'b nolabel', 'p;p x', '/x/s/\\(/y/'];
	for (const t of second) { rows.push(['-n -e p -e', t]); }
	const lines = ['p\np x', 'p\np\n/\\(/p', 's/a/b/\ns/\\(/x/', '{\np\n}\nk', '/a/{\np;p x\n}', 'p\ny/ab/c', 'p\n{p', 'p\n}', 'p\ns/a/b/X', '\n\n0p', 'p\n/a[/p'];
	for (const t of lines) { rows.push(['-n', t]); }
	for (const t of ['p', 'k', '{p', '}', 's/a/b', 'p x']) { rows.push(['-n --expression=k -e', t]); rows.push(['-n --expression=s/a/b/ -e', t]); rows.push(['-n --expression=/a/b -e', t]); }
	for (const t of ['p\ny/a', 'p\ny/a/b']) { rows.push(['-n', t]); }
	// the flags of s on a later line (the character is counted through the lines), repeated flags, a negation with no address, a
	// backslash before a newline in a pattern, and characters of a basic expression that are special in an extended one
	const more = ['p\ns/a/b/0', 'p\ns/a/b/2 3', 'p\ns/a/b/gg', 'p\ns/a/b/pp', 'p\ns/a/b/X', 'p\ns/a', 'p\ny/a/b', 'p\ny/a/b/x', 'p\n/a[/p', 's/a/b/2gg', 's/a/b/g2g', 's/a/b/p2p', 's/a/b/pg2g', 's/a/b/2p', 's/a/b/ p', 's/a/b/ g p'];
	for (const t of more) { rows.push(['-n', t]); }
	for (const t of ['!p', '!d', '!{p}', '! p', '!', '1!', '$!d;p', '/a/!d', '2!{p}', '1,2!d', '/a\\\nb/p', 's/a\\\nb/X/p', '/a\\\nb/,/x/p', 's/a/b\\\nc/']) { rows.push(['-n', t]); }
	// what follows an address: GNU takes only blanks between an address (or `!`) and its command, so a `;` or a newline there is an
	// unknown command (and the end of an -e is a missing command), `0` is an error at once, a second `!`, a range with a missing end
	const afterAddress = [
		'1;p', '1,2;p', '/a/;p', '1!;p', '!;p', '1;', '1,2;', '1\n', '1,2\n', '1\np', '1,2\np', '$;p', '$\np', '1!\np', '/a/\np', '1 2p', '1,2 3p',
		'1!!p', '1! !p', '0', '0;p', '0,5p', '0!p', '0\np', '0,/a/', '0,/a/p', ',', ',p', 'p;,', '+1p', '~2p', '+1', '1~2~3p', '1+2p', '5~2',
		'1', '1,2', '$', '/a/', '1!', '!', '/a/,/b/', '1,+1', '1,~2', '1{', '{1;p}', '{1 2p}', '{,p}', '{1\np}', '1{1}', '1{p;1}', '{p;1}',
		'/a/{;}', '1{\np\n}', '1,2{\n}', '1,2,3p', '/a/,p', '/a/,,p', '1,', '$,', '/a/,', '2,/b/', '\\,a,', '\\,a,p', '\\,a,,p', '1 !', '1 ! 2p',
		'/a/I', '/a/Ip', '/a/M', '1,2!', '1,2!p', '1~2', '0~2', '2,~2', '+2,3p', '~2,3p', '1,3 ;p', '1 ;p',
	];
	for (const t of afterAddress) { rows.push(['-n', t]); }
	for (const [e, t] of [['1', 'p'], ['1,2', 'p'], ['$', 'p'], ['/a/', 'p'], ['0', 'p'], ['1!', 'p'], ['!', 'p'], ['1;', 'p'], ['1,', 'p'], ['1\\', 'p'], ['0,/a/', 'p']]) {
		rows.push([`-n -e ${sq(e)} -e`, t]);
		rows.push([`-n -e p -e ${sq(e)} -e`, t]);
	}
	// the M flag: `.` and a list that starts `[^` do not match the newline of a pattern space that N joined, `^` and `$` match at it
	const mmode = [
		's/i.\\//X/p', 's/i.\\//X/Mp', 's/i[^x]\\//X/Mp', 's/i[^x]\\//X/p', 's/n.f/X/Mp', 's/n.f/X/p', 's/^\\//X/Mgp', 's/^\\//X/gp', 's/i$/X/Mgp',
		's/i$/X/gp', 's/^./X/Mgp', 's/.$/X/Mgp', 's/^./X/gMp', 's/^./X/gmp', 's/^./X/mgp', 's/.$/X/mgp', 's/^./X/Mp', 's/^./X/pM', 's/^./X/pm',
		's/^./X/mp', 's/.*/X/Mp', 's/.*/X/Mgp', 's/[^,]*/X/Mgp', 's/[^,]*/X/gp', 's/i.*b/X/Mp', 's/^[^a]/X/Mgp', 's/^[^a]/X/gp', 's/o$/X/IMp',
		's/O$/X/MIp', 's/O$/X/gIm', 's/^F/X/Imgp', 's/e.f/X/2Mp', 's/e.f/X/Mp2', 's/a.*/X/3Mgp', 's/\\n/X/Mgp', 's/\\n/X/gp', 's/[[:alpha:]]*/X/Mgp',
		's/[^[:alpha:]]*/X/Mgp', 's/\\W\\+/X/Mgp', 's/\\w\\+.\\w\\+/X/Mgp', '/i.\\//Mp', '/i.\\//p', '/i[^x]\\//Mp', '/n.f/Mp', '\\,n.f,Mp', '\\,n.f,p',
		'/^\\//Mp', '/^\\//p', '/i$/Mp', '/i$/p', '/\\n/Mp', '/i\\n\\//Mp', '/I.F/IMp', '/I.F/MIp', '/^F/Ip', '/^F/MIp',
	];
	for (const t of mmode) { rows.push(['-n', 'N;N;' + t]); }
	// a backslash in a bracket is a backslash: it does not hide the `[` of an element or the delimiter from the scan for the end
	const bracketBackslash = [
		'\\,[\\[:,]x,p', '\\,[\\[.,]x,p', '\\,[\\[=,]x,p', '\\,[\\[:a,]x,p', 's,[\\[:,]x,y,', 's,[\\[.,]x,y,', 's,[\\[=,]x,y,', 's,[\\[:,]x,y,p',
		's/[\\[:/]x/y/', '/[\\[:/]x/p', '\\|[\\|]|p', '\\,[a\\,b],p', 's,[a\\,b],X,p', 's/[\\\\]/X/p', '/[\\\\]/p', '/a\\', '\\,a\\', 's/a\\', 's/a/b\\',
		'y/a/b\\', 'y/a\\', '/[a\\', '/[\\', '/[a\\]/p', 's/[a\\]/X/p', '\\,[\\,],p', 's,[\\,],X,p', '/[\\n]/p', 's/[\\n]/X/p', '/[\\]]/p', 's/[\\]]/X/p',
	];
	for (const t of bracketBackslash) { rows.push(['-n', t]); }
	for (const t of ['s/a+/X/', 's/a?/X/', 's/(a)/X/', 's/a|b/X/', 's/a{1}/X/', 's/a{2}/X/', 's/b+$/X/', 's/(/X/', 's/)/X/', 's/a|/X/', 's/+/X/', 's/?/X/', 's/{/X/', 's/}/X/', 's/x*/Y/g', 's/+*/X/']) { rows.push(['', t]); rows.push(['-E', t]); }
	for (const p of classes) { rows.push(['', 's/' + p + '/X/']); rows.push(['-n', '/' + p + '/p']); }
	// brackets that hold what is special outside them (a quantifier, an interval, a group), with a class, collating or
	// equivalence element in front of the end, and a `]` first: the scanners of the translation must skip all of them
	const holders = ['[]*]', '[^]*]', '[[:alpha:]*]', '[a*]', '[*]', '[[.*.]]', '[[=*=]]', '[a[:digit:]*]', '[]+]', '[+]', '[?]', '[[:alpha:]+]a', '[]{1]', '[{]', '[[:alpha:]{]', 'a[{]', '[}]', 'a[}]', '[a{1]', '[a-]{1}', '[a-c]*', '[[:alpha:]]*', '[[:alpha:]]{2}', '[^]a]{1,2}', '[]a]+', '[(]', '[)]', '[|]', '[^(]', '[]()]', '[[:alpha:](]', '[[.(.]]', '[[=(=]]', '[a[:digit:]((]', '[(*]', '[|+]', '[(?]', '[a|*]', '[]|*]', '[^(*]', '[[:alpha:]|*]', '[[.|.]*]', '[[=(=]*]', '[(]{2}', '[|]{1}', '[^|]{1,2}', '[]|]{2}', '[[:alpha:]|]{2}', '[[.].]|*]', '[[=]=]|*]', '[[.].](]', '[[=]=](]', '[[.].]{]', '[[=]=]{]', '[^[.].]|*]', '[[.].]x{]'];
	for (const b of holders) {
		rows.push(['-E', 's/' + b + '/X/g']);
		rows.push(['-E', 's/' + b + '(a)/\\2/']);
		rows.push(['-E', 's/' + b + '(a)/\\1/']);
		rows.push(['-E -n', '/' + b + '/p']);
		rows.push(['', 's/' + b + '\\(a\\)/\\2/']);
		rows.push(['', 's/' + b + '/X/g']);
	}
	// intervals: not closed, empty, not valid, in a bracket, at the start
	const intervals = ['a{1', 'a{', 'a{}', 'a{,}', 'a{1,}', 'a{,2}', 'a{1,2}', 'a{x}', 'a{1,x}', 'a{1,2,3}', 'a{2,1}', '{1}', '({1})', 'a|{1}', 'a{1}{2}', 'a{1}*', 'a{ 1}', 'a{1 }', 'a{1,2', 'a{1,', 'a{1}}', '^{1}', 'a{-1}', 'a{+1}', 'a{0}', 'a{0,0}', 'a{256}', '(a){2}', '[a]{2}', 'a{1}b{2', '[:a]{}', '[:a]{2,1}', '[a-]{}'];
	for (const t of intervals) { rows.push(['-E', 's/' + t + '/X/']); rows.push(['-E -n', '/' + t + '/p']); }
	const brIntervals = ['a\\{1', 'a\\{', 'a\\{\\}', 'a\\{,\\}', 'a\\{1,\\}', 'a\\{,2\\}', 'a\\{1,2\\}', 'a\\{x\\}', 'a\\{1,x\\}', 'a\\{2,1\\}', '\\{1\\}', '\\(\\{1\\}\\)', 'a\\{1\\}\\{2\\}', 'a\\{1,2', 'a{1}', '^\\{1\\}', 'a*\\{1\\}', 'a\\{0\\}', 'a\\{1\\}*', '*\\{1\\}', '\\(*\\)', 'a\\|\\{1\\}', 'x^\\{1,2\\}', '[a]\\{2\\}', '\\(a\\)\\{2\\}', '\\(a\\)\\1', '\\(a\\)\\2', 'a\\1', '\\(\\(a\\)\\)\\2', '\\(a\\1\\)'];
	for (const t of brIntervals) { rows.push(['', 's/' + t + '/X/']); rows.push(['-n', '/' + t + '/p']); }
	// \< and \> next to the quantifiers of a basic and an extended expression, and to the characters that are not a word character
	const edges = ['a\\+\\>', 'a\\?\\>', 'a\\{1\\}\\>', 'a*\\>', 'a\\+\\<', '\\<a\\+', '\\<*a', '*\\>', '{\\>', '}\\>', '^\\>', '$\\>', '+\\>', '?\\>', '\\<*', '\\<{', '\\<+', '\\<?', '\\<\\{1\\}', 'b\\<\\+', '\\(a\\)\\>', '\\<\\(a\\)', 'a\\|b\\>', '\\<a\\|\\<b'];
	for (const t of edges) { rows.push(['', 's/' + t + '/X/g']); rows.push(['-n', '/' + t + '/p']); }
	const edgesE = ['a+\\>', 'a?\\>', 'a{1}\\>', 'a*\\>', 'a+\\<', '\\<a+', '\\<*a', '*\\>', '+\\>', '?\\>', '\\<*', '\\<+', '\\<?', '(a)\\>', '\\<(a)', 'a|b\\>', '\\<a|\\<b', '(a|b)+\\>', '\\<[a-z]+\\>', '-+\\>', '\\<-+'];
	for (const t of edgesE) { rows.push(['-E', 's/' + t + '/X/g']); rows.push(['-E -n', '/' + t + '/p']); }
	// a command that takes a number, followed by something else; and a newline inside an element of a bracket
	for (const t of ['q5x', 'q 5 x', 'Q5 p', 'l 5 x', 'l x', '=x', 'q;p', 'q5;p', '$!N;l 5;p', 'q5', 'L 5', 'l5p']) { rows.push(['-n', t]); }
	for (const t of ['s/[[:a\nb:]/X/', 'p\n/[[.a\nb.]]/p', 's/[[:alpha:]\n]/X/', 's/[[=a\n=]]/X/']) { rows.push(['-n', t]); }
	return {
		tpl: "printf 'a/b&c.d\\\\e[f]g*h$i\\n/usr/local/bin\\nfoo,bar\\nfoo bar baz\\nABC abc 123\\n  indented  \\n-a b-c .x- ,y\\nJoe j~k:l\\nx]y/z\\n:a:\\nab\\n' > in; sed {0} {1} in 2>&1; echo \"rc=$?\"",
		rows: rows.map(([f, s]) => [f, sq(s)]),
	};
}

/** grep with the same patterns, -c and -o, basic and extended, and the `[:space:]` mistake */
function grepgramTable() {
	const patternOf = (s) => { const p = s.split('/'); return p.length === 4 && p[0] === 's' && !p[1].includes('\n') ? p[1] : null; };
	const basic = [
		's/\\x2e/X/g', 's/\\x2a/X/g', 's/\\x5b/X/g',
		's/\\x5d/X/g', 's/\\x2f/X/g', 's/\\x4a/X/g',
		's/\\x6a/X/g', 's/\\x7e/X/g', 's/\\x3a/X/g',
		's/\\x5c/X/g', 's/\\d046/X/g', 's/\\d46/X/g',
		's/\\d047/X/g', 's/\\d074/X/g', 's/\\d106/X/g',
		's/\\o056/X/g', 's/\\o56/X/g', 's/\\o152/X/g',
		's/\\o1/X/g', 's/\\x4/X/g', 's/\\x/X/g',
		's/\\xzz/X/g', 's/\\d/X/g', 's/\\o/X/g',
		's/\\o8/X/g', 's/\\dx/X/g', 's/\\x2e*/X/g',
		's/\\x2e\\+/X/g', 's/a\\x2eb/X/', 's/\\x5e/X/g',
		's/\\x24/X/g', 's/\\x5ba/X/g', 's/\\d092/X/g',
		's/\\x4a\\x6f/X/g', 's/[\\x2e]/X/g', 's/[\\d046]/X/g',
		's/[\\o056]/X/g', 's/[\\x2e\\x2a]/X/g', 's/[\\x]/X/g',
		's/[\\d]/X/g', 's/[\\o]/X/g', 's/[\\x5d]/X/g',
		's/[\\x5c]/X/g', 's/[^\\x61]/X/g', 's/[\\x4a]/X/g',
		's/[\\x6a]/X/g', 's/[\\d106]/X/g', 's/[\\o152]/X/g',
		's/[\\x2d]/X/g', 's/[a\\x2dz]/X/g', 's/[\\x5e]/X/g',
		's/[\\xzz]/X/g', 's/[\\q]/X/g', 's/[a\\]/X/g',
		's/[\\n]/X/g', 's/[\\t]/X/g', 's/[\\r]/X/g',
		's/[\\f]/X/g', 's/[\\v]/X/g', 's/[\\a]/X/g',
		's/\\cA/X/', 's/a\\c/X/', 's/\\c/X/',
		's/\\cb/X/', 's/\\c[/X/', 's/a\\cI/X/',
		's/a/\\c/', 's/a/\\cb/', 's/a/\\c\\\\/',
		's/a/\\c[/', 's/a/\\cA/', 's/a/\\x/',
		's/a/\\x4/', 's/a/\\x4a/', 's/a/\\x4aa/',
		's/a/\\o/', 's/a/\\o1/', 's/a/\\o152/',
		's/a/\\o1522/', 's/a/\\d/', 's/a/\\d6/',
		's/a/\\d106/', 's/a/\\d1066/', 's/a/\\xg/',
		's/a/\\o8/', 's/a/\\dz/', 's/a/\\/',
		's/\\(a\\)/\\1\\/', 's/a/\\9/', 's/\\(a\\)/\\1\\1\\1/',
		's/\\(a\\)\\(b\\)\\(c\\)\\(d\\)\\(e\\)\\(f\\)\\(g\\)\\(h\\)\\(i\\)/\\9\\8/', 's/\\(a\\)/\\0/', 's/a/\\r/',
		's/a/\\E/', 's/a/\\Ex/', 's/\\(a\\)/\\u\\1x/',
		's/a/\\ux/', 's/a/\\lA/', 's/A/\\lA/',
		's/a/\\Ua\\Eb/', 's/a/\\U/', 's/a/\\u/',
		's/a/\\l\\Uab/', 's/ab/\\u\\L&X/', 's/[[:a:]]/X/',
		's/[[.a.]]/X/', 's/[[=a=]]/X/', 's/[[.-.]]/X/g',
		's/[[.].]]/X/g', 's/[[=]=]]/X/g', 's/[[.^.]]/X/g',
		's/[a[.-.]z]/X/g', 's/[[.\\.]]/X/', 's/[[:alpha:][.x.]]/X/',
		's/[[.space.]]/X/', 's/[[:alpha:]/X/', 's/[[.a./X/',
		's/[[:alpha:]]*/X/', 's/[a-[.z.]]/X/g', 's/[[=a=]b]/X/g',
		's/[[.a.][.b.]]/X/g', 's/[[:alpha:]-]/X/g', 's/[[:digit:]a]/X/g',
		's/[[:foo:]]/X/', 's/[[.ab.]]/X/', 's/[[=ab=]]/X/',
		's/[z-a]/X/', 's/[a-]/X/g', 's/[]-a]/X/g',
		's/[^]a]/X/g', 's/[[]/X/g', 's/[[a]/X/g',
		's/[[:]/X/g', 's/[[:a]/X/g', 's/[[.]/X/g',
		's/[[=]/X/g', 's/[a[:]/X/g', 's/[\\]/X/g',
		's/[\\]]/X/g', 's/[\\\\]/X/g', 's/[\\.]/X/g',
		's/\\<-/X/g', 's/-\\>/X/g', 's/\\.\\>/X/g',
		's/&\\>/X/g', 's/\\<,/X/g', 's/\\<\\./X/g',
		's/\\>,/X/g', 's/,\\>/X/g', 's/\\<~/X/g',
		's/~\\>/X/g', 's/\\<j/X/g', 's/j\\>/X/g',
		's/\\<\\(-\\)/X/g', 's/\\(-\\)\\>/X/g', 's/\\<[-,]/X/g',
		's/[-,]\\>/X/g', 's/\\<./X/g', 's/.\\>/X/g',
		's/\\<\\>/X/g', 's/\\>\\</X/g', 's/\\</X/g',
		's/\\>/X/g', 's/\\b/X/g', 's/\\B/X/g',
		's/-\\</X/g', 's/\\>-/X/g', 's/ \\</X/g',
		's/\\> /X/g', 's/\\<\\(\\)a/X/g', 's/\\<\\(a\\|-\\)/X/g',
		's/\\<[^a-z]/X/g', 's/[^a-z]\\>/X/g', 's/\\(a\\|b\\)\\{2\\}/X/g',
		's/a\\|b\\|c/X/g', 's/^a\\|b$/X/g', 's/\\(^a\\)/X/',
		's/\\(a$\\)/X/', 's/a\\(^b\\)/X/', 's/\\(a\\)\\(\\)/\\2/',
		's/\\(\\(a\\)\\|b\\)/\\2/g',
	].map(patternOf).filter((p) => p !== null);
	const extended = [
		's/(a|b){2}/X/g', 's/a|b|c/X/g', 's/^a|b$/X/g',
		's/(^a)/X/', 's/(a$)/X/', 's/a(^b)/X/',
		's/(a)()/\\2/', 's/((a)|b)/\\2/g', 's/a{2}/X/g',
		's/a{1,2}/X/g', 's/a{,2}/X/g', 's/a{1/X/g',
		's/{1/X/g', 's/a{/X/g', 's/x{2,1}/X/',
		's/a{40000}/X/', 's/a{1,40000}/X/', 's/a{32767}/X/',
		's/a{32768}/X/', 's/a{1000}/X/', 's/a{1001}/X/',
		's/a{2,1}/X/', 's/a{1,32768}/X/', 's/a{32768,}/X/',
		's/(a/X/', 's/a)/X/', 's/()/X/',
		's/a|/X/', 's/|a/X/', 's/(|a)/X/',
		's/a**/X/', 's/+a/X/', 's/?a/X/',
		's/a+?/X/', 's/(a)\\1/X/', 's/(a)\\2/X/',
		's/a\\1/X/', 's/\\(a\\)/X/', 's/\\{1\\}/X/',
		's/a\\{1\\}/X/', 's/[a-/X/', 's/\\<a/X/g',
		's/a\\>/X/g', 's/\\.\\>/X/g', 's/\\<,/X/g',
		's/-\\>/X/g', 's/\\<-/X/g', 's/[[:alpha:]]+/X/g',
		's/\\x2e/X/g', 's/\\d046/X/g', 's/\\o056/X/g',
		's/[\\x2e]/X/g',
	].map(patternOf).filter((p) => p !== null);
	const classes = [
		'[:alpha:]', '[:alpha]', '[alpha:]', '[:a:b]', '[::]', '[:]',
		'[:a]', '[a:]', '[:ab:]x', '[^:a:]', '[:a-z:]', '[:a:]b]',
		'[:a[:digit:]:]', '[[:alpha:]:]', '[:[:alpha:]]', '[:::]', '[:a:b:]', '[: :]',
		'x[:alpha:]', '[:alpha:]*', '[:alpha:]+', 'a|[:alpha:]', '[:digit:][:alpha:]', '[[:alpha:]][:alpha:]',
		'[:a.:]', '[:\\:]', '[:a\\:]', '[:alpha:\\]',
	];
	const rows = [];
	for (const p of [...new Set([...basic, ...classes])]) { rows.push(['-c', p]); rows.push(['-o', p]); }
	for (const p of [...new Set([...extended, ...classes])]) { rows.push(['-E -c', p]); rows.push(['-E -o', p]); }
	const greps = ['a\\', '\\', 'a\\\\', '\\\\', '[a\\', 'a{1', 'a{', 'a{}', 'a{,}', 'a{1,}', 'a{,2}', 'a{x}', 'a{1,2,3}', '{1}', '({1})', 'a{1}{2}', '[a]{2}', '\\(a\\)\\1', 'a*\\>', 'a\\+\\>', '\\<*a', '[[:alpha:]*]a', '[]*]', '[{]a', '[(]'];
	for (const t of greps) { rows.push(['-c', t]); rows.push(['-E -c', t]); }
	return {
		tpl: "printf 'a/b&c.d\\\\e[f]g*h$i\\n/usr/local/bin\\nfoo,bar\\nfoo bar baz\\nABC abc 123\\n  indented  \\n-a b-c .x- ,y\\nJoe j~k:l\\nx]y/z\\n:a:\\nab\\n' > in; grep {0} -- {1} in 2>&1; echo \"rc=$?\"",
		rows: rows.map(([f, s]) => [f, sq(s)]),
	};
}

/** sed `l`: bytes that are not ASCII (a character, a byte that is not text), controls, a backslash, and lines that are wrapped */
function sedlistTable() {
	const scripts = ['l', 'l 5', 'l 0', 'l 1', 'l 2', 'l 3', 'l 20', 'l 70', 'l 71', 'l 9;p', '$!N;l 7', 'N;l', 'N;N;l 12', 'G;l', 's/a/\\n/;l', 'l;l 4', '2{l 6}', '/caf/l 8', 'x;l;x'];
	return {
		tpl: "printf 'caf\\303\\251 \\342\\230\\203 \\360\\237\\230\\200 \\302\\205 \\302\\240 x\\\\y \\033[0m \\177 \\200\\n\\001\\377end\\n\\tabc\\tdef\\n\\n' > in; printf 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefghijklmnopqrstuvwxyz\\n\\303\\251\\303\\251\\303\\251\\303\\251\\303\\251\\303\\251\\303\\251\\303\\251\\303\\251\\303\\251\\303\\251\\303\\251\\303\\251\\303\\251\\303\\251\\303\\251\\n' >> in; sed -n {0} in 2>&1; echo \"rc=$?\"",
		rows: scripts.map((t) => [sq(t)]),
	};
}

/** diff on small files: the options it has (and the ones it has not), over files that differ in a few ways, and over folders */
function diffTable() {
	const setups = {
		hunks: "printf 'a\\nb\\nc\\nd\\ne\\nf\\ng\\nh\\n' > x; printf 'a\\nB\\nc\\nd\\ne\\nf\\nG\\nh\\ni\\n' > y; touch -d '2000-01-02 03:04:05' x y",
		nonl: "printf 'a\\nb\\nc\\n' > x; printf 'a\\nb\\nc' > y; touch -d '2000-01-02 03:04:05' x y",
		space: "printf 'a b\\nc  d\\n e\\nf\\n' > x; printf 'a  b\\nc d\\ne\\nf \\n' > y; touch -d '2000-01-02 03:04:05' x y",
		upper: "printf 'A\\nb\\nC\\n' > x; printf 'a\\nB\\nc\\n' > y; touch -d '2000-01-02 03:04:05' x y",
		empty: "printf '' > x; printf 'a\\nb\\n' > y; touch -d '2000-01-02 03:04:05' x y",
		blank: "printf 'a\\n\\n\\nb\\nc\\n' > x; printf 'a\\nb\\n\\nc\\n' > y; touch -d '2000-01-02 03:04:05' x y",
		crlf: "printf 'a\\r\\nb\\r\\nc\\r\\n' > x; printf 'a\\nb\\nc\\n' > y; touch -d '2000-01-02 03:04:05' x y",
		binary: "printf 'a\\000b\\n' > x; printf 'a\\000c\\n' > y; touch -d '2000-01-02 03:04:05' x y",
		nulfirst: "printf '\\000a\\n' > x; printf '\\000b\\n' > y; touch -d '2000-01-02 03:04:05' x y",
		binsame: "printf 'a\\000b\\n' > x; printf 'a\\000b\\n' > y; touch -d '2000-01-02 03:04:05' x y",
		nulone: "printf 'a\\000b\\n' > x; printf 'a\\nb\\n' > y; touch -d '2000-01-02 03:04:05' x y",
		blanklast: "printf 'a\\n\\nb\\nz\\n' > x; printf 'a\\nz\\n' > y; touch -d '2000-01-02 03:04:05' x y",
		same: "printf 'a\\nb\\n' > x; printf 'a\\nb\\n' > y; touch -d '2000-01-02 03:04:05' x y",
		move: "printf '1\\n2\\n3\\n4\\n5\\n6\\n7\\n8\\n9\\n10\\n11\\n12\\n13\\n14\\n15\\n' > x; printf '1\\n2\\nX\\n4\\n5\\n6\\n7\\n8\\n9\\n10\\n11\\nY\\n13\\n14\\n15\\n' > y; touch -d '2000-01-02 03:04:05' x y",
		dirs: "mkdir -p d1/s d2/s; printf 'a\\n' > d1/a; printf 'b\\n' > d1/b; printf 'b2\\n' > d2/b; printf 'c\\n' > d2/c; printf 'x\\n' > d1/s/x; printf 'y\\n' > d2/s/x; printf 'o\\n' > d1/only.o; printf 'k\\n' > d1/keep.c; printf 'k2\\n' > d2/keep.c; printf 'o\\n' > d1/aa.o; printf 'z\\n' > d1/zz.txt; mkdir -p d1/dironly; printf 'q\\n' > d1/dironly/f; printf 'w\\n' > d2/ww.o; printf 'v\\n' > d2/vv.txt; printf '*.o\\n' > pat; touch -d '2000-01-02 03:04:05' d1/a d1/b d2/b d2/c d1/s/x d2/s/x d1/only.o d1/keep.c d2/keep.c d1/s d2/s d1 d2; x=d1; y=d2",
	};
	const common = ['', '-u', '-U0', '-U1', '-U2', '-U5', '-c', '-C0', '-C1', '-C2', '-C5', '-1', '-3', '-u -2', '-c -2', '--unified=1', '--context=1', '--unified', '--context', '-q', '--brief', '-s', '--report-identical-files', '-i', '--ignore-case', '-w', '--ignore-all-space', '-b', '--ignore-space-change', '-B', '--ignore-blank-lines', '-Z', '--ignore-trailing-space', '-a', '--text', '-t', '-T', '--initial-tab', '--normal', '-L one -L two -u', '--label=one --label=two -u', '-L one -u', '--label one --label two -u', '-0', '-9', '-u -0', '-c -9', '-w -b', '-b -Z', '-Z -w', '-B -b', '-i -w', '-u -w -b', '-q -L one -L two', '-q -L one', '-s -L one -L two', '-s -L one', '-L one -L two', '-L a -L b -L c', '--label=A --label=B -s', '--minimal', '--speed-large-files', '-d', '-H', '-u -w', '-u -b', '-u -B', '-u -i', '-u -Z', '-ub', '-uw', '-iw', '-bB', '--strip-trailing-cr', '-u --strip-trailing-cr', '-E', '-e', '-n', '-y', '--side-by-side', '--left-column', '-p', '-F x', '--color', '--minimal', '-d', '--speed-large-files', '-H', '--version', '--help', '-N', '-x x', '-I a', '--ignore-matching-lines=a', '-U', '-C', '-U x', '-ux', '--foo', '-W 5', '--width=5', '--tabsize=4', '-l'];
	const rows = [];
	for (const [name, setup] of Object.entries(setups)) {
		if (name === 'dirs') { continue; }
		const opts = name === 'hunks' ? common : common.filter((o) => !/^(--version|--help|-N|-x x|-I a|--ignore-matching-lines=a|--foo|-W 5|--width=5|--tabsize=4|-l|-d|--minimal|--speed-large-files|-H|--color|-p|-F x|--left-column|-y|--side-by-side|-e|-n|-E)$/.test(o));
		for (const o of opts) { rows.push([setup, `diff ${o} x y`.replace(/  +/g, ' ')]); }
	}
	rows.push([setups.hunks, 'diff x x'], [setups.hunks, 'diff x'], [setups.hunks, 'diff'], [setups.hunks, 'diff x y z'], [setups.hunks, 'diff x nofile'], [setups.hunks, 'diff nofile y'], [setups.hunks, 'diff nofile nofile2'], [setups.hunks, 'diff -u nofile nofile2'], [setups.hunks, 'diff -s nofile x'], [setups.hunks, 'diff -u x nofile'], [setups.hunks, 'diff - y < x'], [setups.hunks, 'diff x - < y'], [setups.hunks, 'diff x .'], [setups.hunks, 'diff . .'], [setups.hunks, 'diff -- x y'], [setups.hunks, 'diff -u -- x y'], [setups.hunks, 'diff x y -u'], [setups.hunks, 'diff -u x y -U1']);
	for (const o of ['', '-q', '-r', '-rq', '-u', '-ur', '-rs', '-N', '-rN', '-rN -x "*.o"', '-rq -x "*.o"', '-rq -N', '-r -x "[ab"', '-r -x "a\\*"', '-r -x "a\\.o"', '-r -x "*.o" -x "*.txt"', '-r -x "zz*"', '-r -x "dironly"', '-rs -x "*.o"', '-x "*.o"', '-rl', '-x "*.o"', '-r -x "*.o"', '-r --exclude="*.c"', '-r -X pat', '-r --exclude-from=pat', '-rq -x s', '-r -x "k*"', '-r -x "?.o"', '-r -x "[ab]"', '-r -x "[!a]"', '-r -x "s"', '-rU0', '-qs', '-s', '-a', '-rc']) {
		rows.push([setups.dirs, `diff ${o} d1 d2`.replace(/  +/g, ' ')]);
	}
	for (const o of ['-N d1/a d2/zzz', '-N d1/zzz d2/c', '-N d1/s d2/zzz', '-N d1/zzz d2/s', '-N d1/zzz d2/zzz2', '-rN d1/dironly d2/dironly', 'd1/dironly d2/vv.txt', 'd1/a d2/s', 'd1/s d2/a', 'd1/a d2/b', 'd1/b d2/b', 'd1 d2/b', 'd1/b d2', 'd1/s d2/s', 'd1/only.o d2', 'd1/s d2/c', '-r d1/a d2', '-u d1/a d2/c']) { rows.push([setups.dirs, `diff ${o}`]); }
	// the setups are functions of the template: a row names one (the text of each is not repeated in every row)
	const functions = Object.entries(setups).map(([name, text]) => `s_${name}() { ${text}; }`).join('; ');
	return { tpl: functions + '; {0}; {1} 2>&1; echo "rc=$?"', rows: rows.map(([a, b]) => [Object.keys(setups).find((k) => setups[k] === a) ? 's_' + Object.keys(setups).find((k) => setups[k] === a) : a, b]) };
}

/** everyday awk programs, on three inputs (a table of records, blank-separated words, comma-separated), through awk (GNU awk 5.1) */
function awkTable() {
	const progs = [
 "{print $1}", "{print $NF}", "{print NF}", "{print NR\": \"$0}", "NR==2", "NR>2{print}", "NR%2==0", "/NY/", "!/NY/", "$2>28", "$2>=30 && $3==\"NY\"", "$3==\"NY\"||$3==\"LA\"", "{print $1, $2}", "{print $1\",\"$2}",
 "{print $1 $2}", "BEGIN{print \"hi\"}", "END{print NR}", "END{print $0}", "{s+=$2}END{print s}", "{s+=$2}END{print s/NR}", "{s+=$4}END{printf \"%.2f\\n\", s}", "{a[$3]++}END{for(k in a)print k, a[k]}",
 "{a[$3]+=$2}END{for(k in a)print k, a[k] | \"sort\"}", "{c[$3]++}END{n=0;for(k in c)n++;print n}", "{print length($1)}", "{print length}", "{print toupper($1)}", "{print tolower($3)}", "{print substr($1,2,3)}", "{print substr($1,2)}",
 "{print index($1,\"a\")}", "{n=split($0,p,\" \");print n, p[1]}", "{gsub(/a/,\"A\");print}", "{sub(/[0-9]+/,\"N\");print}", "{if(match($0,/[0-9]+/))print RSTART, RLENGTH}", "{printf \"%-8s|%5d|%6.2f\\n\",$1,$2,$4}", "{printf \"%s\\n\",$1}",
 "{printf \"%c\",$1; print \"\"}", "{printf \"%5s|%-5s|\\n\",$1,$3}", "{printf \"%x %o %e\\n\",$2,$2,$4}", "{printf \"%03d\\n\",$2}", "{printf \"%+d % d\\n\",$2,$2}", "BEGIN{printf \"%5.1f%%\\n\", 45.678}",
 "{$2=$2+1;print}", "{$2=\"\";print}", "{$5=\"x\";print}", "{NF=2;print}", "{$0=\"a b c\";print $2}", "{print $(NF-1)}", "{print $(1+1)}", "BEGIN{OFS=\"-\"}{print $1,$2}", "BEGIN{OFS=\"-\"}{$1=$1;print}", "BEGIN{FS=\":\"}{print $1}",
 "{print $1}", "BEGIN{ORS=\";\"}{print $1}END{print \"\\n\"}", "{x=x $1}END{print x}", "{x=x\",\"$1}END{print substr(x,2)}", "NR==1{h=$0;next}{print h\"|\"$0}", "NR==1,NR==3", "/bob/,/dave/", "/bob/,/bob/", "NR==2,NR==2{print \"x\"}",
 "{if($2>28)print $1,\"old\";else print $1,\"young\"}", "{print ($2>28?\"old\":\"young\")}", "{for(i=1;i<=NF;i++)print i,$i}", "{for(i=NF;i>0;i--)printf \"%s \",$i;print \"\"}", "{i=1;while(i<=2){print $i;i++}}", "{do{print $1;n++}while(n<2);n=0}",
 "function f(x){return x*2}{print f($2)}", "function g(a,b){return a>b?a:b}{print g($2,30)}", "BEGIN{x[1]=1;x[2]=2;delete x[1];print length(x)}", "BEGIN{if(!(\"a\" in x))print \"no\"}", "{if($1 in seen)next;seen[$1]=1;print}", "!seen[$3]++",
 "BEGIN{print 1/3}", "BEGIN{print 10%3, 2^10, 2**3}", "BEGIN{print int(3.9), int(-3.9)}", "BEGIN{print sqrt(16), exp(0), log(1)}", "BEGIN{print sin(0), cos(0), atan2(0,-1)}", "BEGIN{print 1e3, 0x10, 010}", "BEGIN{print \"10\"+5, \"3x\"+1, \"x\"+1}", "BEGIN{print 1==1.0, \"a\"<\"b\", \"10\"<\"9\", 10<9}",
 "BEGIN{print length()}", "BEGIN{print substr(\"hello\",0,2), substr(\"hello\",-1,3), substr(\"hello\",4,100)}", "BEGIN{print index(\"abc\",\"c\"), index(\"abc\",\"z\")}", "BEGIN{print toupper(\"abc\") tolower(\"DEF\")}", "BEGIN{s=\"a.b.c\";gsub(\".\",\"-\",s);print s}", "BEGIN{s=\"a.b.c\";gsub(/\\./,\"-\",s);print s}",
 "BEGIN{s=\"aaa\";print gsub(/a/,\"b\",s),s}", "BEGIN{s=\"hello\";sub(/l+/,\"[&]\",s);print s}", "BEGIN{s=\"hello\";gsub(/l/,\"\\\\&\",s);print s}", "BEGIN{n=split(\"a:b:c\",p,\":\");print n,p[3]}", "BEGIN{n=split(\"abc\",p,\"\");print n,p[2]}", "BEGIN{n=split(\"\",p);print n}",
 "BEGIN{print match(\"foobar\",/o+/), RSTART, RLENGTH}", "BEGIN{print sprintf(\"%d-%s\",5,\"x\")}", "BEGIN{printf \"%s %s\\n\", \"a\"}", "BEGIN{print 1,2 > \"/dev/stderr\"}", "BEGIN{print \"x\" > \"/tmp/o\";close(\"/tmp/o\");while((getline l < \"/tmp/o\")>0)print \"got\",l}",
 "BEGIN{while((getline l < \"d\")>0)n++;print n}", "BEGIN{\"echo hi\" | getline x;print x}", "NR==1{getline;print}", "NR==1{getline x;print x}", "{print > \"/tmp/out_\" $3}END{close(\"/tmp/out_NY\");while((getline l<\"/tmp/out_NY\")>0)print l}", "BEGIN{print length(\"héllo\")}",
 "BEGIN{printf \"%s\\n\", 1e6; printf \"%s\\n\", 1000000; print 1e6, 123456789, 0.1+0.2, 100000*100000}", "BEGIN{x=0.1+0.2;print x==0.3}", "BEGIN{print 3\" \"4, 3 4}", "BEGIN{print -3%2, 7%-3}", "BEGIN{print substr(12345,2,3)}", "BEGIN{print 1>2?\"y\":\"n\"}",
 "BEGIN{a=\"A\";b=a++;print a,b}", "BEGIN{$0=\"x y z\";print NF,$2}", "BEGIN{$3=\"c\";print NF, $0}", "{$1=\"\";print substr($0,2)}", "{print $1 > \"/dev/stdout\"}", "END{print NR, NF}", "{n=NF}END{print n}", "BEGIN{RS=\"\"}{print NR\":\"$1}", "BEGIN{RS=\"\";FS=\"\\n\"}{print NF}",
 "BEGIN{FS=\",\"}{print $2}", "BEGIN{FS=\",\";OFS=\"|\"}{$1=$1}1", "BEGIN{FS=\"[0-9]\"}{print $1}", "BEGIN{FS=\"\\t\"}{print NF}", "BEGIN{FS=\" +\"}{print NF}", "BEGIN{FS=\"\"}{print NF}", "{print NF}", "{print $0}", "1", "0", "NF", "!NF", "NF>0{n++}END{print n}", "length>5", "length($0)>10{print NR}", "$1~/^[a-c]/", "$1!~/e/", "$3~\"N\"", "$2~/^3/",
 "{print toupper(substr($1,1,1)) substr($1,2)}", "{print $1, ($2>=30?\"senior\":\"junior\")}", "BEGIN{max=0}{if($2>max){max=$2;n=$1}}END{print n,max}", "NR==1{min=$2}$2<min{min=$2}END{print min}", "{a[NR]=$0}END{for(i=NR;i>0;i--)print a[i]}", "{print NR, $0}", "{print FILENAME, FNR}", "END{print FILENAME}",
 'BEGIN{print "x"; print "b\\na" | "sort"; print "y"}', 'BEGIN{print "x" | "cat"; print "y"; close("cat"); print "z"}', '{print $1 | "sort -r"}END{print "n=" NR}', 'BEGIN{print "e" | "cat 1>&2"}', 'BEGIN{printf "%s\\n", "p" | "cat"; print "q" | "cat"}', '{print $2 | "sort -n | head -2"}END{close("sort -n | head -2"); print "done"}', 'BEGIN{while(("echo a; echo b" | getline l)>0) print "got", l; print "z" | "cat"}', 'BEGIN{print "1" | "cat"; close("cat"); print "2" | "cat -n"}',
	];
	const rows = [];
	for (const pr of progs) { rows.push([sq(pr)]); }
	return table("export LC_ALL=C.UTF-8; printf 'alice 30 NY 5.5\\nbob 25 LA 7.25\\ncarol 35 NY 3\\ndave 28 SF 10\\neve 30 LA 4.5\\n' > d; printf 'one  two   three\\n  lead trail  \\n\\nlast line here\\n' > t; printf 'a,b,c\\n1,2,3\\n4,,6\\n' > c; awk {0} d 2>&1 | head -30; echo \"rc=$?\"; awk {0} t 2>&1 | head -12; awk -F, {0} c 2>&1 | head -12", rows);
}

function wordingTable(optionRows) {
	const rows = [];
	for (const r of optionRows) {
		for (const line of r.o.split('\n')) {
			const m = /^([SL]) (\S+) req$/.exec(line);
			if (m) { rows.push([`${r.a[0]} ${m[1] === 'S' ? '-' + m[2] : m[2]}`]); }
		}
	}
	return table(`export LC_ALL=C; mkdir -p /tmp/w && cd /tmp/w; {0} </dev/null; echo "rc=$?"`, rows);
}

/** UTF-8 text as a string; bytes that are not text (or hold a NUL) as { b64 } */
function text(buf) {
	const s = buf.toString('utf8');
	return Buffer.from(s, 'utf8').equals(buf) && !s.includes('\0') ? s : { b64: buf.toString('base64') };
}

function runAll(scripts) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-tables-'));
	try {
		fs.mkdirSync(path.join(dir, 'cases'));
		const names = scripts.map((c, i) => 'c' + String(i).padStart(5, '0'));
		scripts.forEach((c, i) => fs.writeFileSync(path.join(dir, 'cases', names[i] + '.sh'), c + '\n'));
		fs.writeFileSync(path.join(dir, 'driver.sh'), `#!/bin/bash
for f in /c/*.sh; do
  n=$(basename $f .sh)
  rm -rf /tmp/* /w; mkdir -p /w; cd /w
  timeout 20 bash --noprofile --norc "$f" > /o/$n.stdout 2> /o/$n.stderr; echo $? > /o/$n.rc
done
`);
		const run = () => {
			fs.rmSync(path.join(dir, 'out'), { recursive: true, force: true });
			fs.mkdirSync(path.join(dir, 'out'));
			const r = spawnSync('docker', ['run', '--rm', '--pull', 'never', '--network', 'none', '-e', 'LC_ALL=C.UTF-8', '-v', path.join(dir, 'cases') + ':/c:ro', '-v', path.join(dir, 'driver.sh') + ':/d.sh:ro', '-v', path.join(dir, 'out') + ':/o', IMAGE, 'bash', '/d.sh'], { encoding: 'utf8', maxBuffer: 1 << 28 });
			if (r.status !== 0) { throw new Error('docker failed: ' + (r.stderr || r.stdout).slice(0, 500)); }
			return scripts.map((c, i) => {
				const o = path.join(dir, 'out', names[i]);
				return {
					stdout: text(fs.readFileSync(o + '.stdout')),
					stderr: text(fs.readFileSync(o + '.stderr')),
					exit: Number(fs.readFileSync(o + '.rc', 'utf8').trim()),
				};
			});
		};
		return { first: run(), second: run() };
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

/** @returns {{ tpl: string, rows: any[] }} the table with what GNU did to each row (a row that differs between two runs is left out) */
function record(name, t, flaky) {
	const { first, second } = runAll(t.rows.map((a) => fill(t.tpl, a)));
	const rows = [];
	t.rows.forEach((a, i) => {
		const x = first[i];
		const y = second[i];
		if (JSON.stringify(x) !== JSON.stringify(y)) { flaky.push(name + ' ' + JSON.stringify(a)); return; }
		const row = { a, o: x.stdout };
		if (x.stderr !== '') { row.e = x.stderr; }
		if (x.exit) { row.x = x.exit; }
		rows.push(row);
	});
	return { tpl: t.tpl, rows };
}

const flaky = [];
const result = { meta: { reference: 'GNU bash 5.1.16 and coreutils 8.32 (catthehacker/ubuntu:act-latest), LC_ALL=C.UTF-8, --network none', runs: 2, flaky }, tables: {} };
const generated = { tr: trTable(), sortk: sortkTable(), spelling: spellingTable(), date: dateTable(), tz: tzTable(), xargst: xargstTable(), sedre: sedreTable(), grepre: grepreTable(), sedidiom: sedidiomTable(), sedaddr: sedaddrTable(), sedgram: sedgramTable(), sedlist: sedlistTable(), difft: diffTable(), grepgram: grepgramTable(), awk: awkTable() };
for (const [name, t] of Object.entries(generated)) { result.tables[name] = record(name, t, flaky); }
// the options come first among the rest: the wording cases are drawn from what they found
const opt = record('options', optionsTable(), flaky);
// what the engine needs of them is the lists, not the transcript
result.tables.options = {
	programs: opt.rows.map((r) => {
		const lines = r.o.split('\n');
		const pick = (kind, what) => lines.filter((l) => l.startsWith(kind + ' ') && l.endsWith(' ' + what)).map((l) => l.split(' ')[1]);
		return { program: r.a[0], shortRequired: pick('S', 'req').sort().join(''), longRequired: pick('L', 'req').sort(), longOk: pick('L', 'ok').sort() };
	}),
};
result.tables.wording = record('wording', wordingTable(opt.rows), flaky);
const json = JSON.stringify(result);
fs.writeFileSync(OUT, json);
console.log(`wrote ${OUT}: ${Object.entries(result.tables).map(([k, v]) => `${k} ${v.rows ? v.rows.length : v.programs.length}`).join(', ')}; ${flaky.length} flaky (${flaky.join('; ')}); ${json.length} bytes; sha256 ${crypto.createHash('sha256').update(json).digest('hex').slice(0, 12)}`);
