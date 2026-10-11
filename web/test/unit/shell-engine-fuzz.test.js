/*---------------------------------------------------------------------------------------------
 *  A few thousand broken scripts — run: node web/test/unit/shell-engine-fuzz.test.js
 *
 *  The engine is a large piece of minified code that runs whatever a model or a person types. This feeds it the
 *  recorded cases mutated (spans cut, doubled, wrapped, joined, quoted) and token soup, from a SEEDED generator, so a
 *  failure is a script you can run again. For every one: the run answers exactly once, with a status and a `how` from
 *  the contract, never a stack, never an unhandled rejection, and inside two seconds under limits tightened to make
 *  that possible.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

// the zone of the process is the visitor's, and the shell does not ask it: the first run is in UTC, the others in two
// that are not (a smaller count each, from other seeds)
const ZONES = [['UTC', 3000, 20261011], ['America/New_York', 800, 20261012], ['Asia/Tokyo', 800, 20261013]];
const PROCESS_TZ = process.env.TZ;

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..', '..', '..');
const { loadEngine, makeTree, makeHost } = require('./shell-engine-support.js');
const golden = JSON.parse(fs.readFileSync(path.join(REPO, 'web', 'test', 'fixtures', 'shell', 'golden', 'golden.json'), 'utf8'));

/** mulberry32: a small seeded generator, the same sequence on every machine */
function rng(seed) {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6D2B79F5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const POOL = ['$(', ')', '))', '$((', '((', '${', '}', '{', '[[', ']]', '`', '"', "'", '\\', '|', '||', '&&', '&', ';', ';;', '<', '>', '>>', '<<EOF\n', '\nEOF\n', '2>&1', '&>', '*', '**/', '?', '[a-', '!', '$', '$$', '$?', '$@', '$#', '$0', '~', '#', '\n', ' ', '\t', '\0', '́', '日本語', '%s', '%n', '-', '--', 'case x in', 'esac', 'if', 'then', 'else', 'fi', 'for i in', 'do', 'done', 'while', 'until', 'function f', '!(a|b)', '@(a|b)', '{1..99999}', '{a,b}{c,d}{e,f}', 'x'.repeat(3000), '9'.repeat(30), '$(printf %05000d 0)', ' /dev/null ', ' /etc/passwd ', ' ../../.. ', ' /w/proj ', ' proj/src ', ' - ', 'cat', 'ls', 'rm -rf', 'cp -r', 'mv', 'find .', 'grep -r', 'sed -i', 'awk', 'sort', 'xargs', 'echo', 'printf', 'read', 'mapfile', 'od', 'head -n -1', 'wc', 'tee', 'seq 1 100000', 'yes', 'sleep 0.2', 'eval', 'exec', 'source', 'trap', 'set -e', 'set -u', 'set -o pipefail', 'shopt -s globstar', 'shopt -s extglob', 'alias x=y', 'unset', 'export', 'declare -A', 'local', 'return', 'exit 3', 'break', 'continue', 'wait', 'cd /', 'cd', 'pwd'];

function mutate(r, script, corpus) {
	const pick = (n) => Math.floor(r() * n);
	let s = script;
	const rounds = 1 + pick(3);
	for (let k = 0; k < rounds; k++) {
		const op = pick(12);
		const len = s.length;
		const at = len ? pick(len) : 0;
		switch (op) {
			case 0: s = s.slice(0, at) + s.slice(at + 1 + pick(20)); break;
			case 1: { const span = s.slice(at, at + 1 + pick(30)); s = s.slice(0, at) + span + span + s.slice(at); break; }
			case 2: s = s.slice(0, at) + POOL[pick(POOL.length)] + s.slice(at); break;
			case 3: s = s.slice(0, at) + String.fromCharCode(32 + pick(95)) + s.slice(at + 1); break;
			case 4: s = s.slice(0, Math.max(1, at)); break;
			case 5: s = s + [';', '|', '&&', '||', '\n', ' & '][pick(6)] + corpus[pick(corpus.length)]; break;
			case 6: s = [`$( ${s} )`, `( ${s} )`, `{ ${s}; }`, `"${s}"`, `'${s}'`, `<( ${s} )`, `eval "${s.replace(/"/g, '\\"')}"`, `bash -c '${s.replace(/'/g, "'\\''")}'`, `for i in 1 2 3; do ${s}; done`, `while :; do ${s}; done`, `f() { ${s}; }; f`, `cat <<EOF\n${s}\nEOF`][pick(12)]; break;
			case 7: s = (s + '\n').repeat(1 + pick(40)); break;
			case 8: { const j = pick(Math.max(1, len)); s = s.slice(j) + s.slice(0, j); break; }
			case 9: s = s.split(' ').filter(() => r() > 0.15).join(' '); break;
			case 10: s = s.replace(/[a-z]/g, (c) => (r() < 0.05 ? c.toUpperCase() : c)); break;
			default: s = s.replace(/\//g, () => (r() < 0.3 ? '//' : '/')); break;
		}
	}
	return s;
}

function soup(r) {
	const n = 1 + Math.floor(r() * 25);
	const out = [];
	for (let i = 0; i < n; i++) { out.push(POOL[Math.floor(r() * POOL.length)]); }
	return out.join(r() < 0.5 ? ' ' : '');
}

async function main() {
	const unhandled = [];
	process.on('unhandledRejection', (e) => { unhandled.push(String(e && /** @type {any} */ (e).stack || e)); });
	const E = await loadEngine();
	let ran = 0;
	try {
		for (const [zoneName, count, seed] of ZONES) {
			process.env.TZ = zoneName;
			ran += await fuzz(E, zoneName, count, seed, unhandled);
		}
	} finally {
		if (PROCESS_TZ === undefined) { delete process.env.TZ; } else { process.env.TZ = PROCESS_TZ; }
	}
	assert.deepStrictEqual(unhandled, [], 'unhandled rejections');
	console.log(`\n${ZONES.length} tests passed (${ran} scripts)`);
}

async function fuzz(E, zoneName, COUNT, SEED, unhandled) {
	// the recorded workspace, once; every run reads it and none applies
	const tree = makeTree({ '/w': null });
	const h = await makeHost({ Engine: E, tree, start: false });
	await h.core.handle({
		t: 'init', gen: 1, folders: [{ id: 'f', path: '/w', name: 'w' }],
		limits: { maxCommandCount: 2500, maxLoopIterations: 2500, maxCallDepth: 40, maxExecutionTimeMs: 1500, maxOutputSize: 1 << 20, maxStringLength: 1 << 20, maxLiveBytes: 8 << 20, maxInputBytes: 4 << 20 },
	});
	await h.run(golden.fixture.script, { apply: true });
	const corpus = golden.cases.map((c) => c.script).filter((s) => !/sleep|timeout|yes\b/.test(s));
	const r = rng(SEED);
	const hows = {};
	let slowest = { ms: 0, script: '' };
	let failures = [];
	const t0 = Date.now();
	for (let i = 0; i < COUNT; i++) {
		const script = i % 3 === 2 ? soup(r) : mutate(r, corpus[Math.floor(r() * corpus.length)], corpus);
		const started = Date.now();
		let res;
		try {
			res = await h.run(script, { cwd: '/w', apply: false, caps: { readRun: 2 << 20, writeRun: 1 << 20, entries: 200 } });
		} catch (e) {
			failures.push({ i, script, why: 'the run threw: ' + (e && /** @type {any} */ (e).message) });
			continue;
		}
		const ms = Date.now() - started;
		if (ms > slowest.ms) { slowest = { ms, script }; }
		hows[res.how] = (hows[res.how] || 0) + 1;
		const text = res.stdout + res.stderr;
		if (!['exit', 'limit', 'deadline', 'aborted', 'error'].includes(res.how)) { failures.push({ i, script, why: 'how ' + res.how }); }
		if (!Number.isInteger(res.exitCode) || res.exitCode < 0 || res.exitCode > 255) { failures.push({ i, script, why: 'exit ' + res.exitCode }); }
		if (/(^|\n)\s+at [^\n]*:\d+:\d+\)?(\n|$)|file:\/\/|\bRangeError\b|\bTypeError\b|\bReferenceError\b|\[object Object\]|\bundefined\b: /.test(text)) { failures.push({ i, script, why: 'a stack or a path of ours in the output: ' + text.slice(0, 200) }); }
		if (res.how !== 'exit' && res.done.changes.length) { failures.push({ i, script, why: 'changes from a run that did not end by itself' }); }
		if (ms > 2000) { failures.push({ i, script, why: `took ${ms} ms` }); }
		if (res.done.changes.some((c) => !c.path.startsWith('/w/') && c.path !== '/w')) { failures.push({ i, script, why: 'a change outside the folder: ' + JSON.stringify(res.done.changes.map((c) => c.path)) }); }
	}
	await new Promise((resolve) => setTimeout(resolve, 50));
	if (failures.length && process.env.FUZZ_DUMP) { fs.writeFileSync(process.env.FUZZ_DUMP, JSON.stringify(failures, null, 1)); }
	const show = (f) => `#${f.i}: ${f.why}\n    ${JSON.stringify(f.script).slice(0, 300)}`;
	assert.deepStrictEqual(failures.slice(0, 5).map(show), [], `${failures.length} of ${COUNT} scripts misbehaved (seed ${SEED}, zone ${zoneName})`);
	assert.ok(hows.exit > COUNT / 2, 'most scripts run to their end: ' + JSON.stringify(hows));
	assert.ok(hows.error === undefined || hows.error < COUNT / 50, 'internal errors are rare: ' + JSON.stringify(hows));
	console.log(`  ok - ${COUNT} scripts, seed ${SEED}, zone of the process ${zoneName}: ${JSON.stringify(hows)}, slowest ${slowest.ms} ms, ${((Date.now() - t0) / 1000).toFixed(1)} s`);
	return COUNT;
}

main().catch((e) => { console.error(e); process.exit(1); });
