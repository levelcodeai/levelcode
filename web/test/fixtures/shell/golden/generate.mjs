#!/usr/bin/env node
// Produces golden.json: what GNU bash 5.1 and coreutils 8.32 do with every case in cases/*.mjs.
//
//   node web/test/fixtures/shell/golden/generate.mjs [--out golden.json] [--runs 2]
//
// It needs docker and the image catthehacker/ubuntu:act-latest (Ubuntu 22.04) already pulled; the container runs with
// --network none and LC_ALL=C.UTF-8. Every case runs `--runs` times and a case whose stdout, exit status or file tree
// differs between runs (a pid, a clock) is left out and listed under `meta.flaky`: the test compares what is stable.
//
// The unit test never runs docker: it reads golden.json. Regenerate it only when cases change, and review the diff.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
const OUT = path.resolve(opt('--out', path.join(HERE, 'golden.json')));
const RUNS = Number(opt('--runs', '2'));
const IMAGE = 'catthehacker/ubuntu:act-latest';

/** files bigger than this are compared by length and sha256, not stored */
export const INLINE_MAX = 4096;

export function encodeBytes(buf) {
	if (buf.length > INLINE_MAX) { return { len: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex') }; }
	try {
		const s = new TextDecoder('utf-8', { fatal: true }).decode(buf);
		if (!s.includes('\0')) { return s; }
	} catch { /* binary */ }
	return { b64: buf.toString('base64') };
}

async function loadCases() {
	const { FIXTURE, CASES: b1 } = await import('./cases/battery-1.mjs');
	const { CASES: b2 } = await import('./cases/battery-2.mjs');
	const { CASES: extra } = await import('./cases/extra.mjs');
	const { CASES: round2 } = await import('./cases/round2.mjs');
	const { CASES: round3 } = await import('./cases/round3.mjs');
	const { CASES: round4 } = await import('./cases/round4.mjs');
	const { CASES: round5 } = await import('./cases/round5.mjs');
	const { CASES: round6 } = await import('./cases/round6.mjs');
	const all = [];
	const seen = new Set();
	const add = (list, source, fixture) => {
		for (const [name, script, o] of list) {
			// the case files are written to a directory that may be case-insensitive (macOS): c-cp-t and c-cp-T are one file
			if (seen.has(name.toLowerCase())) { throw new Error('duplicate case name (compared without case) ' + name); }
			seen.add(name.toLowerCase());
			all.push({ name, script, fixture: o && 'fixture' in o ? !!o.fixture : fixture, source });
		}
	};
	add(b1, 'battery-1', true);
	add(b2, 'battery-2', true);
	add(extra, 'extra', false);
	add(round2, 'round2', false);
	add(round3, 'round3', false);
	add(round4, 'round4', false);
	add(round5, 'round5', false);
	add(round6, 'round6', false);
	return { FIXTURE, cases: all };
}

/**
 * The tree a case left, read from a manifest the container wrote (not copied onto this machine's file system, which
 * may not tell `a` from `A`): path -> Buffer for a file, null for a directory. Lines are `d PATH` and `f BASE64 PATH`.
 */
function readManifest(file) {
	const out = new Map();
	for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
		if (!line) { continue; }
		if (line.startsWith('d ')) { out.set(line.slice(2), null); continue; }
		const m = /^f (\S*) (.*)$/s.exec(line);
		if (m) { out.set(m[2], Buffer.from(m[1], 'base64')); }
	}
	return out;
}

function runReference(dir, names) {
	fs.rmSync(path.join(dir, 'out'), { recursive: true, force: true });
	fs.mkdirSync(path.join(dir, 'out'));
	const r = spawnSync('docker', ['run', '--rm', '--pull', 'never', '--network', 'none', '-e', 'LC_ALL=C.UTF-8',
		'-v', path.join(dir, 'cases') + ':/c:ro', '-v', path.join(dir, 'driver.sh') + ':/d.sh:ro', '-v', path.join(dir, 'out') + ':/o', IMAGE, 'bash', '/d.sh'], { encoding: 'utf8', maxBuffer: 1 << 28 });
	if (r.status !== 0) { throw new Error('docker failed: ' + (r.stderr || r.stdout).slice(0, 500)); }
	const res = new Map();
	for (const n of names) {
		const o = path.join(dir, 'out', n);
		res.set(n, {
			stdout: fs.readFileSync(o + '.stdout'),
			stderr: fs.readFileSync(o + '.stderr'),
			exit: Number(fs.readFileSync(o + '.rc', 'utf8').trim()),
			tree: readManifest(o + '.manifest'),
		});
	}
	return res;
}

const { FIXTURE, cases } = await loadCases();
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-golden-'));
try {
	fs.mkdirSync(path.join(dir, 'cases'));
	const names = [];
	const files = [{ name: '__fixture__', body: FIXTURE + '\n' }];
	for (const c of cases) { files.push({ name: c.name, body: (c.fixture ? FIXTURE + '\n' : '') + c.script + '\n' }); }
	for (const f of files) { fs.writeFileSync(path.join(dir, 'cases', f.name + '.sh'), f.body); names.push(f.name); }
	fs.writeFileSync(path.join(dir, 'driver.sh'), `#!/bin/bash
for f in /c/*.sh; do
  n=$(basename $f .sh)
  rm -rf /tmp/* /w; mkdir -p /w; cd /w
  timeout 20 bash --noprofile --norc "$f" > /o/$n.stdout 2> /o/$n.stderr; echo $? > /o/$n.rc
  ( cd /w; find . -mindepth 1 -type d | LC_ALL=C sort | while IFS= read -r p; do printf 'd %s\\n' "\${p#./}"; done
    find . -type f | LC_ALL=C sort | while IFS= read -r p; do printf 'f %s %s\\n' "$(base64 -w0 "$p")" "\${p#./}"; done ) > /o/$n.manifest
done
`);
	const runs = [];
	for (let i = 0; i < RUNS; i++) { process.stderr.write(`reference run ${i + 1}/${RUNS}\n`); runs.push(runReference(dir, names)); }

	const same = (a, b) => a.exit === b.exit && Buffer.compare(a.stdout, b.stdout) === 0 && a.tree.size === b.tree.size && [...a.tree].every(([k, v]) => b.tree.has(k) && ((v === null && b.tree.get(k) === null) || (v !== null && b.tree.get(k) !== null && Buffer.compare(v, b.tree.get(k)) === 0)));
	const first = runs[0];
	const fixtureTree = first.get('__fixture__').tree;
	const flaky = [];
	const out = [];
	for (const c of cases) {
		const a = first.get(c.name);
		if (runs.slice(1).some((r) => !same(a, r.get(c.name)))) { flaky.push(c.name); continue; }
		/** @type {Record<string, any>} */
		const files = {};
		const dirs = [];
		for (const [p, v] of a.tree) {
			const f = c.fixture ? fixtureTree.get(p) : undefined;
			if (v === null) { if (f !== null) { dirs.push(p); } continue; }
			if (f === undefined || f === null || Buffer.compare(f, v) !== 0) { files[p] = encodeBytes(v); }
		}
		// what it removed from the fixture it started with: a case that has none removed nothing (listing the fixture's
		// files as gone for every bare-workspace case was a third of the file)
		const gone = c.fixture ? [...fixtureTree.keys()].filter((p) => !a.tree.has(p) || (fixtureTree.get(p) === null) !== (a.tree.get(p) === null)) : [];
		out.push({ name: c.name, source: c.source, fixture: c.fixture, script: c.script, stdout: encodeBytes(a.stdout), stderr: a.stderr.toString('utf8'), exit: a.exit, tree: { files, dirs: dirs.sort(), gone: gone.sort() } });
	}
	const meta = {
		reference: 'GNU bash 5.1.16 and coreutils 8.32 (Ubuntu 22.04, ' + IMAGE + '), LC_ALL=C.UTF-8, docker --network none, run as root in /w',
		runs: RUNS,
		flaky,
		inlineMax: INLINE_MAX,
		cases: out.length,
	};
	const fixtureEntries = {};
	for (const [p, v] of fixtureTree) { fixtureEntries[p] = v === null ? null : encodeBytes(v); }
	fs.writeFileSync(OUT, JSON.stringify({ meta, fixture: { script: FIXTURE, tree: fixtureEntries }, cases: out }, null, '\t') + '\n');
	process.stderr.write(`wrote ${OUT}: ${out.length} cases, ${flaky.length} left out as flaky${flaky.length ? ' (' + flaky.join(', ') + ')' : ''}\n`);
} finally {
	fs.rmSync(dir, { recursive: true, force: true });
}
