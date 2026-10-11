#!/usr/bin/env node
// Records what GNU bash 5.1 / coreutils 8.32 leaves for each script of scripts.mjs (docker, no network, once):
//
//   node web/test/fixtures/shell/consistency/generate.mjs [--seed 20261011] [--count 300] [--out consistency.json]
//
// The test never runs docker: it reads consistency.json, and checks that the scripts in it are the ones the seed makes.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { FIXTURE_SCRIPT, scripts } from './scripts.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
const SEED = Number(opt('--seed', '20261011'));
const COUNT = Number(opt('--count', '300'));
const OUT = path.resolve(opt('--out', path.join(HERE, 'consistency.json')));
const IMAGE = 'catthehacker/ubuntu:act-latest';

const list = scripts(SEED, COUNT);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-consistency-'));
try {
	fs.mkdirSync(path.join(dir, 'cases'));
	fs.mkdirSync(path.join(dir, 'out'));
	list.forEach((s, i) => fs.writeFileSync(path.join(dir, 'cases', `${String(i).padStart(4, '0')}.sh`), s + '\n'));
	fs.writeFileSync(path.join(dir, 'fixture.sh'), FIXTURE_SCRIPT + '\n');
	fs.writeFileSync(path.join(dir, 'driver.sh'), `#!/bin/bash
for f in /c/*.sh; do
  n=$(basename $f .sh)
  rm -rf /w; mkdir -p /w; cd /w
  bash --noprofile --norc /fixture.sh
  timeout 20 bash --noprofile --norc "$f" > /dev/null 2> /dev/null
  ( cd /w; find . -mindepth 1 -type d | LC_ALL=C sort | while IFS= read -r p; do printf 'd %s\\n' "\${p#./}"; done
    find . -type f | LC_ALL=C sort | while IFS= read -r p; do printf 'f %s %s\\n' "\${p#./}" "$(base64 -w0 "$p")"; done ) > /o/$n.manifest
done
`);
	const r = spawnSync('docker', ['run', '--rm', '--pull', 'never', '--network', 'none', '-e', 'LC_ALL=C.UTF-8',
		'-v', path.join(dir, 'cases') + ':/c:ro', '-v', path.join(dir, 'fixture.sh') + ':/fixture.sh:ro', '-v', path.join(dir, 'driver.sh') + ':/d.sh:ro', '-v', path.join(dir, 'out') + ':/o', IMAGE, 'bash', '/d.sh'], { encoding: 'utf8', maxBuffer: 1 << 28 });
	if (r.status !== 0) { throw new Error('docker failed: ' + (r.stderr || r.stdout).slice(0, 500)); }
	const cases = list.map((script, i) => {
		const lines = fs.readFileSync(path.join(dir, 'out', `${String(i).padStart(4, '0')}.manifest`), 'utf8').split('\n').filter(Boolean);
		const tree = lines.map((l) => (l.startsWith('d ') ? l : 'f ' + l.slice(2).replace(/^(\S+) (.*)$/s, (_m, p, b64) => p + ' ' + JSON.stringify(Buffer.from(b64, 'base64').toString('utf8')))));
		return { script, tree };
	});
	const meta = { seed: SEED, count: COUNT, reference: 'GNU bash 5.1.16 / coreutils 8.32 (' + IMAGE + '), LC_ALL=C.UTF-8, docker --network none', fixture: FIXTURE_SCRIPT };
	// one case per line: the file is read by people when a script fails
	fs.writeFileSync(OUT, '{\n"meta": ' + JSON.stringify(meta) + ',\n"cases": [\n' + cases.map((c) => JSON.stringify(c)).join(',\n') + '\n]\n}\n');
	process.stderr.write(`wrote ${OUT}: ${cases.length} scripts\n`);
} finally {
	fs.rmSync(dir, { recursive: true, force: true });
}
