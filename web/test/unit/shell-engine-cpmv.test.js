/*---------------------------------------------------------------------------------------------
 *  cp and mv against GNU, shape by shape — run: node web/test/unit/shell-engine-cpmv.test.js
 *
 *  web/test/fixtures/shell/cpmv/cpmv.json holds what GNU cp and mv (coreutils 8.32) did with 1652 command lines made of
 *  every source shape (a trailing slash, `.`, a glob, a file written with a slash, a path through `..`) against every
 *  destination shape (nothing, `x/`, a file, a folder, inside the source, `e/..`, `x//`), for `cp`, `cp -r` and `mv`,
 *  and a seeded sample of the other options and of two sources: the status, what -v printed, the folders and files that
 *  were added and removed, what each file that is new or different holds, and what they said. The independent checks of
 *  two rounds found this class nine examples at a time; a matrix pins it. cases.mjs makes the list (deterministic) and
 *  generate.mjs records it (docker, once).
 *
 *  A case that differs from GNU is listed below with its reason; the list is closed from both ends (a case that is not
 *  listed must match, one that is listed must differ) and may only shrink. The lines -v prints are compared as a SET:
 *  GNU lists a folder's entries in the order of the file system, which no file system fixes.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const { loadEngine, makeTree, makeHost } = require('./shell-engine-support.js');

const FIXTURES = path.join(__dirname, '..', 'fixtures', 'shell', 'cpmv');

/**
 * Where the engine differs from GNU, and why: [reason, ...the command lines].
 * @type {Array<[string, ...string[]]>}
 */
const KNOWN_DIFFERENCES = [
	['a folder copied into a folder that is inside it: GNU copies part of the tree (the entries that were listed before the destination, in the order of the file system) and then says it cannot copy into itself; this shell copies nothing and says so. What GNU copied depends on the file system\'s order, which nothing fixes',
		'cp -r d d/sub', 'cp -r d d', 'cp -r d/ d/sub', 'cp -r d/ d', 'cp -r emp emp', 'cp -r emp emp/', 'cp -r d/sub d/sub', 'cp -r d/. d/sub', 'cp -r d/* d/sub',
		'cp -r ws/a\\ b ws/"a b"/', 'cp -r "ws/a b" ws/"a b"/', 'cp -a d d', 'cp -ru d/ d/sub', 'cp -ru d/ ./f d/sub',
		'cp -rn d d', 'cp -rn d d/sub', 'cp -rn d/sub d/sub', 'cp -ru d d', 'cp -ru d d/sub', 'cp -ru d/sub d/sub'],
	['`mv -T` of a folder onto `e/..` (a folder that has something in it): GNU says busy, the engine that the directory is not empty (the status and the tree are the same)',
		'mv -T d e/..', 'mv -T ws/a\\ b e/..'],
	['two things to say about two sources of `mv -u`: GNU says them in the order of the operands, this shell says the one about a file written with a slash first',
		'mv -u d/ f/ d'],
	['`cp -rv ./f x/` where x is not there: GNU names the copy it could not make (`./f -> x/`) before it fails; this shell says only that it failed',
		'cp -rv ./f x/'],
];

async function main() {
	const cases = await import(pathToFileURL(path.join(FIXTURES, 'cases.mjs')).href);
	const rec = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'cpmv.json'), 'utf8'));
	const E = await loadEngine();

	const known = new Map();
	for (const [why, ...commands] of KNOWN_DIFFERENCES) {
		assert.ok(why.length > 40);
		for (const c of commands) { assert.ok(!known.has(c), 'listed twice: ' + c); known.set(c, why); }
	}

	const run = async (script) => {
		const h = await makeHost({ Engine: E, tree: makeTree({}) });
		return h.run(script, { cwd: '/w' });
	};
	/** what scriptOf printed: the status, the lines -v wrote, the listing and the `path=content` lines */
	const parse = (stdout) => {
		const lines = stdout.split('\n');
		const at = lines.findIndex((l) => /^rc=\d+$/.test(l));
		const files = lines.indexOf('--files');
		return { at, rc: at < 0 ? -1 : Number(lines[at].slice(3)), verbose: lines.slice(0, Math.max(at, 0)).filter(Boolean).sort().join('\n'), listing: new Set(lines.slice(at + 1, files).filter(Boolean)), contents: lines.slice(files + 1).filter(Boolean) };
	};

	const tests = [];
	const test = (name, fn) => tests.push({ name, fn });

	test('the recording: every case of cases.mjs, none left out, the listing it starts from', async () => {
		const commands = cases.casesOf();
		assert.deepStrictEqual(rec.cases.map((c) => c[0]), commands, 'the list is the recorded one');
		assert.strictEqual(commands.length, 1778);
		assert.deepStrictEqual(rec.meta.flaky, []);
		assert.ok(/GNU cp and mv of coreutils 8\.32/.test(rec.meta.reference));
		const base = await run(`${cases.FIXTURE}\nfind . | sort\n`);
		assert.deepStrictEqual(base.stdout.split('\n').filter(Boolean), rec.meta.base, 'the engine\'s fixture is GNU\'s');
		const withContents = parse((await run(`${cases.FIXTURE}\n${cases.scriptOf('true')}\n`)).stdout);
		assert.strictEqual(withContents.contents.length, 8, 'eight files, each with its one line: ' + withContents.contents.join(' '));
		const size = fs.statSync(path.join(FIXTURES, 'cpmv.json')).size;
		assert.ok(size < 200 * 1024, 'the fixture stays small: ' + size);
	});

	test('every case: the status, the listing it left, what each changed file holds, what -v printed (as a set) and what it said are GNU\'s, or the case is listed with its reason', async () => {
		const problems = [];
		let matched = 0;
		const base = new Set(rec.meta.base);
		const baseContents = new Set(parse((await run(`${cases.FIXTURE}\n${cases.scriptOf('true')}\n`)).stdout).contents);
		for (const [command, rc, verbose, added, removed, said, changed] of rec.cases) {
			const r = await run(`${cases.FIXTURE}\n${cases.scriptOf(command)}\n`);
			const p = parse(r.stdout);
			const got = {
				rc: p.rc,
				verbose: p.verbose,
				added: [...p.listing].filter((q) => !base.has(q)).sort().join(' '),
				removed: rec.meta.base.filter((q) => !p.listing.has(q)).join(' '),
				changed: p.contents.filter((l) => !baseContents.has(l)).join('\n'),
				said: r.stderr.replace(/\n$/, ''),
			};
			const want = { rc, verbose: verbose.split('\n').filter(Boolean).sort().join('\n'), added: added.join(' '), removed: removed.join(' '), changed: changed.join('\n'), said: said.replace(/\n$/, '') };
			const fields = Object.keys(want).filter((k) => got[k] !== want[k]);
			if (r.how !== 'exit') { fields.push('how=' + r.how); }
			const why = known.get(command);
			if (!why) {
				if (fields.length) { problems.push(`${command}: differs from GNU in ${fields.join('+')}\n    gnu : ${JSON.stringify(want)}\n    here: ${JSON.stringify(got)}`); } else { matched++; }
				continue;
			}
			if (!fields.length) { problems.push(`${command}: now matches GNU. Remove it from KNOWN_DIFFERENCES`); }
		}
		assert.deepStrictEqual(problems, [], `${problems.length} cases`);
		assert.strictEqual(matched + known.size, rec.cases.length);
		assert.ok(matched / rec.cases.length > 0.98, 'the share that is GNU\'s: ' + matched + ' of ' + rec.cases.length);
	});

	test('a folder copied into itself: GNU\'s status and message exactly, nothing made inside the source (GNU makes part of it, in the order of its file system), and nothing else touched', async () => {
		const [, ...commands] = KNOWN_DIFFERENCES[0];
		assert.strictEqual(commands.length, 20);
		const base = new Set(rec.meta.base);
		// what this shell makes: nothing, except the files of `d/*` and `./f` that are not the folder (d/sub/one, d/sub/f)
		const made = { 'cp -r d/* d/sub': ['./d/sub/one'], 'cp -ru d/ ./f d/sub': ['./d/sub/f'] };
		for (const command of commands) {
			const want = rec.cases.find((c) => c[0] === command);
			assert.ok(want, command);
			const r = await run(`${cases.FIXTURE}\n${cases.scriptOf(command)}\n`);
			const p = parse(r.stdout);
			assert.strictEqual(r.stderr.replace(/\n$/, ''), want[5].replace(/\n$/, ''), command + ': what it said');
			assert.strictEqual(p.rc, want[1], command + ': status');
			const added = [...p.listing].filter((q) => !base.has(q)).sort();
			assert.deepStrictEqual(added, made[command] || [], command + ': what it made');
			assert.ok(added.every((q) => want[3].includes(q)), command + ': GNU made ' + want[3].join(' '));
			assert.deepStrictEqual(rec.meta.base.filter((q) => !p.listing.has(q)), want[4], command + ': nothing removed');
		}
	});

	test('the list of known differences names only cases that exist, and may only shrink', () => {
		const all = new Set(rec.cases.map((c) => c[0]));
		for (const c of known.keys()) { assert.ok(all.has(c), 'listed but not a case: ' + c); }
		assert.ok(known.size <= 24, `the list has ${known.size} entries, it may have 24`);
	});

	for (const t of tests) {
		await t.fn();
		console.log('  ok - ' + t.name);
	}
	console.log(`\n${tests.length} tests passed (${rec.cases.length} cases against GNU, ${known.size} listed)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
