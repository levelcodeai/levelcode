/*---------------------------------------------------------------------------------------------
 *  xargs against GNU, size by size — run: node web/test/unit/shell-engine-xargs.test.js
 *
 *  web/test/fixtures/shell/xargs/limits.json holds what GNU xargs (findutils 4.8.0) did with 12,102 command lines: every
 *  input of cases.mjs (none, one item, two, three) with -I and a replace string in thirteen commands, and with -L, -n and
 *  -x (plain -x, with no batch size, too), and `--replace=` with nothing to replace, at -s 1..30. What it does at those sizes is what separates "argument line too long" from "argument list too long",
 *  "command too long" and "cannot fit single argument within argument list size limit", from what runs, from what runs
 *  before the message. Each run of sizes that did the same thing is replayed at its first size, its last and its middle.
 *
 *  Every command line is the same as GNU's in status, standard output and standard error: there is no list of known
 *  differences. (`-p`, `-o`, the environment's part of the limit and `-s` above 128 KiB are not here: they are pinned by
 *  shell-engine-compat.test.js, with the numbers the recording gave.)
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

// A test that waits for something that never happens must fail the suite, not end it silently with status 0.
require('../helpers/shell-exit-guard.js');

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const { loadEngine, makeTree, makeHost } = require('./shell-engine-support.js');

const FIXTURES = path.join(__dirname, '..', 'fixtures', 'shell', 'xargs');

async function main() {
	const cases = await import(pathToFileURL(path.join(FIXTURES, 'cases.mjs')).href);
	const rec = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'limits.json'), 'utf8'));
	const E = await loadEngine();

	const tests = [];
	const test = (name, fn) => tests.push({ name, fn });

	test('the recording: every group of cases.mjs, none left out, each size 1..LIMIT said exactly once', () => {
		const groups = cases.groups();
		assert.deepStrictEqual(rec.groups.map((g) => [g[0], g[1], g[2]]), groups.map((g) => [g.input, g.options, g.command]));
		assert.strictEqual(groups.length, 473);
		assert.deepStrictEqual(rec.meta.flaky, []);
		assert.strictEqual(rec.meta.limit, cases.LIMIT);
		assert.ok(/GNU xargs of findutils 4\.8\.0/.test(rec.meta.reference));
		rec.groups.forEach(([, , , ranges], i) => {
			const sizes = cases.sizesOf(groups[i]);
			let next = sizes[0];
			for (const [from, to] of ranges) { assert.strictEqual(from, next); next = to + 1; }
			assert.strictEqual(next, sizes[sizes.length - 1] + 1);
		});
		const size = fs.statSync(path.join(FIXTURES, 'limits.json')).size;
		assert.ok(size < 128 * 1024, 'the fixture stays small: ' + size);
	});

	test('every group, at the first size, the last and the middle of each run: the status, the output and the message are GNU\'s', async () => {
		const h = await makeHost({ Engine: E, tree: makeTree({}) });
		const problems = [];
		let checked = 0;
		for (const [input, options, command, ranges] of rec.groups) {
			const g = { input, options, command, sized: true };
			for (const [from, to, rc, out, err] of ranges) {
				for (const s of new Set([from, Math.floor((from + to) / 2), to])) {
					const r = await h.run(cases.lineOf(g, s) + '\n', { cwd: '/w' });
					checked++;
					if (r.exitCode !== rc || r.stdout !== out || r.stderr !== err || r.how !== 'exit') {
						problems.push(`${cases.lineOf(g, s)}\n    gnu : ${JSON.stringify([rc, out, err])}\n    here: ${JSON.stringify([r.exitCode, r.stdout, r.stderr, r.how])}`);
					}
				}
			}
		}
		assert.deepStrictEqual(problems, [], `${problems.length} of ${checked} command lines`);
		assert.ok(checked > 2000, 'what was replayed: ' + checked);
	});

	for (const t of tests) {
		await t.fn();
		console.log('  ok - ' + t.name);
	}
	console.log(`\n${tests.length} tests passed (${rec.groups.length} groups against GNU)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
