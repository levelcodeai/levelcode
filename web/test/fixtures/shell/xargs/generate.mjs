#!/usr/bin/env node
// Records what GNU xargs (findutils 4.8.0, the golden suite's container, `--network none`) does with every command line of
// cases.mjs: its status, what it wrote to standard output, what it wrote to standard error. A size of 0 is a case with
// no -s (the input with a quote that is never closed).
//
//   node web/test/fixtures/shell/xargs/generate.mjs      (docker with catthehacker/ubuntu:act-latest already pulled)
//
// Every case is run twice; one that differs between the runs is left out and named. limits.json holds, per group of
// cases (the same input, options and command at -s 1..LIMIT), the runs of consecutive sizes that did the same thing.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { LIMIT, groups, lineOf, sizesOf } from './cases.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const IMAGE = 'catthehacker/ubuntu:act-latest';
const all = groups();
/** @type {Array<{ g: number, s: number, line: string }>} */
const cases = [];
all.forEach((g, gi) => { for (const s of sizesOf(g)) { cases.push({ g: gi, s, line: lineOf(g, s) }); } });

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-xargs-'));
try {
	// one script: a marker, the status, the output, the error of each command
	let script = '';
	cases.forEach((c, i) => {
		script += `( ${c.line} ) 2>/tmp/e >/tmp/o; r=$?\necho "###${i}"; echo "rc=$r"; echo "--out"; cat /tmp/o; echo "--err"; cat /tmp/e; echo "--end"\n`;
	});
	fs.writeFileSync(path.join(dir, 'cases.sh'), script);
	const run = () => {
		const r = spawnSync('docker', ['run', '--rm', '--pull', 'never', '--network', 'none', '-e', 'LC_ALL=C.UTF-8', '-v', dir + ':/c:ro', IMAGE, 'bash', '--noprofile', '--norc', '/c/cases.sh'], { encoding: 'utf8', maxBuffer: 1 << 28 });
		if (r.status !== 0) { throw new Error('docker failed: ' + (r.stderr || r.stdout).slice(0, 500)); }
		const result = new Array(cases.length);
		for (const block of r.stdout.split(/^###/m).slice(1)) {
			const nl = block.indexOf('\n');
			const idx = Number(block.slice(0, nl));
			const rest = block.slice(nl + 1);
			const rc = Number(/^rc=(\d+)\n/.exec(rest)[1]);
			const out = rest.slice(rest.indexOf('--out\n') + 6, rest.indexOf('--err\n'));
			const err = rest.slice(rest.indexOf('--err\n') + 6, rest.lastIndexOf('--end\n'));
			result[idx] = [rc, out, err];
		}
		return result;
	};
	const first = run();
	const second = run();
	const flaky = [];
	/** @type {Map<number, Array<[number, number, number, string, string]>>} */
	const runs = new Map();
	cases.forEach((c, i) => {
		const a = first[i];
		const b = second[i];
		if (!a || !b || a[0] !== b[0] || a[1] !== b[1] || a[2] !== b[2]) { flaky.push(c.line); return; }
		if (!runs.has(c.g)) { runs.set(c.g, []); }
		const list = /** @type {Array<[number, number, number, string, string]>} */ (runs.get(c.g));
		const last = list[list.length - 1];
		if (last && last[2] + 1 === c.s && last[0] === a[0] && last[3] === a[1] && last[4] === a[2]) { last[2] = c.s; } else { list.push([a[0], c.s, c.s, a[1], a[2]]); }
	});
	const rows = all.map((g, gi) => [g.input, g.options, g.command, (runs.get(gi) || []).map(([rc, from, to, out, err]) => [from, to, rc, out, err])]);
	const meta = { reference: 'GNU xargs of findutils 4.8.0, bash 5.1 (Ubuntu 22.04, ' + IMAGE + '), LC_ALL=C.UTF-8, --network none', runs: 2, limit: LIMIT, flaky };
	fs.writeFileSync(path.join(HERE, 'limits.json'), JSON.stringify({ meta, groups: rows }) + '\n');
	process.stderr.write(`wrote limits.json: ${rows.length} groups, ${cases.length} cases, ${flaky.length} left out as flaky\n`);
} finally {
	fs.rmSync(dir, { recursive: true, force: true });
}
