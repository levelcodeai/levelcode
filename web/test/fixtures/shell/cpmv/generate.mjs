#!/usr/bin/env node
// Records what GNU cp and mv (coreutils 8.32, bash 5.1, the golden suite's container, `--network none`) do with every
// case of cases.mjs: the lines they printed with -v, their status, the folder listing they left, what they said.
//
//   node web/test/fixtures/shell/cpmv/generate.mjs        (docker with catthehacker/ubuntu:act-latest already pulled)
//
// Each case is recorded twice and a case that differs between the runs is left out and named. cpmv.json holds, per
// case, [status, verbose lines, entries the command added to the listing, entries it removed, what it said, the files
// that are new or hold something else than they did, as `path=content`].
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { FIXTURE, casesOf, scriptOf } from './cases.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const IMAGE = 'catthehacker/ubuntu:act-latest';
const commands = casesOf();

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-cpmv-'));
try {
	fs.mkdirSync(path.join(dir, 'cases'));
	fs.mkdirSync(path.join(dir, 'out'));
	const names = ['base', ...commands.map((_c, i) => 'c' + String(i).padStart(4, '0'))];
	fs.writeFileSync(path.join(dir, 'cases', 'base.sh'), `${FIXTURE}\n${scriptOf('true')}\n`);
	commands.forEach((c, i) => { fs.writeFileSync(path.join(dir, 'cases', names[i + 1] + '.sh'), `${FIXTURE}\n${scriptOf(c)}\n`); });
	fs.writeFileSync(path.join(dir, 'driver.sh'), `#!/bin/bash
for f in /c/*.sh; do
  n=$(basename $f .sh)
  rm -rf /tmp/* /w; mkdir -p /w; cd /w
  timeout 20 bash --noprofile --norc "$f" > /o/$n.stdout 2> /o/$n.stderr
done
`);
	const run = () => {
		fs.rmSync(path.join(dir, 'out'), { recursive: true, force: true });
		fs.mkdirSync(path.join(dir, 'out'));
		const r = spawnSync('docker', ['run', '--rm', '--pull', 'never', '--network', 'none', '-e', 'LC_ALL=C.UTF-8', '-v', path.join(dir, 'cases') + ':/c:ro', '-v', path.join(dir, 'driver.sh') + ':/d.sh:ro', '-v', path.join(dir, 'out') + ':/o', IMAGE, 'bash', '/d.sh'], { encoding: 'utf8', maxBuffer: 1 << 28 });
		if (r.status !== 0) { throw new Error('docker failed: ' + (r.stderr || r.stdout).slice(0, 500)); }
		return names.map((n) => [fs.readFileSync(path.join(dir, 'out', n + '.stdout'), 'utf8'), fs.readFileSync(path.join(dir, 'out', n + '.stderr'), 'utf8')]);
	};
	const first = run();
	const second = run();
	/** the stdout of a script of scriptOf: [status, verbose lines, the listing, the `path=content` lines] */
	const split = (stdout) => {
		const lines = stdout.split('\n');
		const at = lines.findIndex((l) => /^rc=\d+$/.test(l));
		const files = lines.indexOf('--files');
		return { verbose: lines.slice(0, at).join('\n'), rc: Number(lines[at].slice(3)), listing: lines.slice(at + 1, files).filter(Boolean), contents: lines.slice(files + 1).filter(Boolean) };
	};
	const base = split(first[0][0]);
	const baseList = base.listing;
	const baseSet = new Set(baseList);
	const baseContents = new Set(base.contents);
	const flaky = [];
	const cases = [];
	commands.forEach((c, i) => {
		if (first[i + 1][0] !== second[i + 1][0] || first[i + 1][1] !== second[i + 1][1]) { flaky.push(c); return; }
		const r = split(first[i + 1][0]);
		const listing = new Set(r.listing);
		const added = [...listing].filter((p) => !baseSet.has(p)).sort();
		const removed = baseList.filter((p) => !listing.has(p));
		const changed = r.contents.filter((l) => !baseContents.has(l));
		cases.push([c, r.rc, r.verbose, added, removed, first[i + 1][1], changed]);
	});
	const meta = { reference: 'GNU cp and mv of coreutils 8.32, bash 5.1 (Ubuntu 22.04, ' + IMAGE + '), LC_ALL=C.UTF-8, --network none', runs: 2, flaky, base: baseList };
	fs.writeFileSync(path.join(HERE, 'cpmv.json'), JSON.stringify({ meta, cases }) + '\n');
	process.stderr.write(`wrote cpmv.json: ${cases.length} cases, ${flaky.length} left out as flaky${flaky.length ? ' (' + flaky.join('; ') + ')' : ''}\n`);
} finally {
	fs.rmSync(dir, { recursive: true, force: true });
}
