#!/usr/bin/env node
// Records what GNU bash 5.1 and coreutils 8.32 (the golden suite's container, `--network none`, LC_ALL=C.UTF-8) answer
// to tables of command lines that have a grammar of their own, where a handful of hand-written cases would say little:
//
//   tr        120 programs, drawn from a seeded generator (escapes, ranges, classes, [c*n], equivalence classes,
//             -c -d -s -t, one to three sets, bytes that are not text), run on ten inputs
//   sortk     the key grammar of `sort -k` (90 specifications), and --key=
//   spelling  the ways of typing a path through `..` of a folder that is or is not there, for the commands that
//             read, make, move, copy and remove (cp, mv, mkdir, touch, rm, a redirection)
//   date      GNU's date -d strings: relative forms with a date as the anchor (the clock is never asked), absolute forms
//   tz        TZ as the path of a zone file, an offset alone, a POSIX string
//   xargst    `xargs -t` quoting of one word: every ASCII character alone and in a word, and the odd ones
//   options   which options of 26 programs take a value, found by asking GNU's getopt about every letter and every
//             long option of --help, and the wording of GNU's answer for each one that does
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
	for (let i = 0; i < 100; i++) {
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
	const rows = lines.map((l) => ['UTC', sq(l)]);
	// the zone of the command, with the date given in full
	const { rnd, pick } = prng(5);
	const dates = ['2024-07-04', '2023-12-31', '1999-01-01', '2024-02-29', 'Jul 4 2024', '4 Jul 2024', '07/04/2024', '20240704', 'July 4, 2024'];
	const times = ['12:00', '00:00', '23:59:59', '3pm', '11:30 pm', '12am', '6:05:07', '9 am', '18:00:00'];
	const rel2 = ['+1 day', '1 day', '-1 day', '2 days ago', '1 week', '3 weeks ago', '1 month', '2 months ago', '1 year', '5 hours', '90 minutes', '45 seconds ago', 'next day', 'last day', 'next week', 'next month', 'yesterday', 'tomorrow', 'next monday', 'last friday', 'this thursday', 'monday', '36 hours ago'];
	// (a named zone with a relative part, under a TZ that has daylight saving time, is "invalid date" in GNU for a reason
	// of its own, which the engine does not have: those are drawn with the offsets only)
	const zones = ['UTC', 'EST', 'EDT', '+0200', '-0500', '+05:30'];
	for (let i = 0; i < 100; i++) {
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

const PROGRAMS = ['xargs', 'grep', 'cp', 'mv', 'rm', 'mkdir', 'sed', 'paste', 'head', 'tail', 'stat', 'uniq', 'wc', 'touch', 'ls', 'sort', 'du', 'awk', 'date', 'od', 'realpath', 'cmp', 'nproc', 'basename', 'comm', 'join'];
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
const generated = { tr: trTable(), sortk: sortkTable(), spelling: spellingTable(), date: dateTable(), tz: tzTable(), xargst: xargstTable() };
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
