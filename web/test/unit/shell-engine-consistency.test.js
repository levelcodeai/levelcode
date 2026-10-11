/*---------------------------------------------------------------------------------------------
 *  The change set against GNU bash, applied the way the host applies it — run:
 *  node web/test/unit/shell-engine-consistency.test.js
 *
 *  The engine never writes: a run ends with a change set (creates, writes, deletes, removed folders), and the host
 *  replays it with plain calls (web/shell/src/commit.js: a delete removes one FILE, a rmdir one EMPTY folder). A set
 *  that is not consistent with itself — a write below a folder that is also removed — stops the host half way.
 *
 *  web/test/fixtures/shell/consistency/consistency.json holds 300 seeded random scripts over a nested tree (writes
 *  two to four levels down in folders that exist, rm -rf and mv of an ancestor, cp -r, sed -i, touch, rmdir), and
 *  the tree GNU bash 5.1 left for each, recorded once in a container. For every one of them this runs the script
 *  through the engine core, applies its change set with the real commit.js over a map, and compares the tree.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const REPO = path.join(__dirname, '..', '..', '..');
const { loadEngine, makeTree, makeHost } = require('./shell-engine-support.js');
const { commitChanges } = require(path.join(REPO, 'web', 'shell', 'src', 'commit.js'));

/** @type {Array<{ name: string, fn: () => Promise<void> | void }>} */
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

const CAPS = { writeFile: 1 << 20, writeRun: 8 << 20, entries: 2000 };
const enc = new TextEncoder();
const dec = new TextDecoder();

/** A workspace in a map, with the calls commit.js makes (a delete takes a file or an EMPTY folder, as a real one does). */
function mapWorkspace(tree) {
	/** @type {Map<string, Uint8Array | null>} */
	const ws = new Map(tree.nodes);
	const kids = (t) => [...ws.keys()].filter((k) => k.startsWith(t + '/'));
	const err = (code, p) => Object.assign(new Error(`${code}: ${p}`), { code });
	const mkdirp = (t) => {
		for (let q = t; q !== '/' && q !== ''; q = q.slice(0, q.lastIndexOf('/'))) {
			if (ws.get(q) === undefined) { ws.set(q, null); } else if (ws.get(q) !== null) { throw err('ENOTDIR', q); }
		}
	};
	const io = {
		resolve: (p) => (p === '/w' || p.startsWith('/w/') ? p : null),
		stat: async (t) => { const v = ws.get(t); return v === undefined ? null : { isDirectory: v === null, size: v ? v.length : 0 }; },
		readFile: async (t) => { const v = ws.get(t); if (!v) { throw err('ENOENT', t); } return v; },
		writeFile: async (t, b) => { if (ws.get(t.slice(0, t.lastIndexOf('/'))) !== null) { throw err('ENOENT', t); } ws.set(t, b.slice()); },
		createDirectory: async (t) => { mkdirp(t); },
		remove: async (t) => {
			const v = ws.get(t);
			if (v === undefined) { throw err('ENOENT', t); }
			if (v === null && kids(t).length) { throw err('ENOTEMPTY', t); }
			ws.delete(t);
		},
	};
	return { ws, io };
}

/** the lines of a manifest: `d path` and `f path "content"`, sorted */
function dumpOf(ws) {
	const out = [];
	for (const [k, v] of ws) {
		if (k === '/w') { continue; }
		const rel = k.slice(3);
		out.push(v === null ? 'd ' + rel : 'f ' + rel + ' ' + JSON.stringify(dec.decode(v)));
	}
	return out.sort();
}

async function main() {
	const E = await loadEngine();
	const dir = path.join(REPO, 'web', 'test', 'fixtures', 'shell', 'consistency');
	const recorded = JSON.parse(fs.readFileSync(path.join(dir, 'consistency.json'), 'utf8'));
	const gen = await import(pathToFileURL(path.join(dir, 'scripts.mjs')).href);

	const baseFiles = () => {
		/** @type {Record<string, string | null>} */
		const files = { '/w': null };
		for (const [p, c] of gen.FIXTURE) { files['/w/' + p] = c; }
		return files;
	};

	test('the recorded scripts are the ones the seed makes, over the fixture the recording used', () => {
		assert.strictEqual(recorded.meta.fixture, gen.FIXTURE_SCRIPT);
		assert.deepStrictEqual(recorded.cases.map((c) => c.script), gen.scripts(recorded.meta.seed, recorded.meta.count));
		assert.strictEqual(recorded.cases.length, 300);
		assert.ok(/GNU bash 5\.1/.test(recorded.meta.reference));
	});

	test('the generator is a function of its seed, and the scripts reach below a directory they also remove', () => {
		assert.deepStrictEqual(gen.scripts(1, 5), gen.scripts(1, 5));
		assert.notDeepStrictEqual(gen.scripts(1, 5), gen.scripts(2, 5));
		const nested = recorded.cases.filter((c) => /(^|\n)rm -rf (a|f|m)\b/.test(c.script) && /\n(echo|cp|sed)[^\n]*(a\/b\/c|a\/b\/d|f\/g|m\/n)\//.test(c.script));
		assert.ok(nested.length > 20, 'scripts that write deep and remove or move an ancestor: ' + nested.length);
	});

	test('every script: the engine\'s change set, applied by commit.js, leaves the tree GNU left (no half-applied set)', async () => {
		const failures = [];
		/** scripts that turn a folder into a file (or the reverse): a set cannot say that, and the run says so */
		let representable = 0;
		for (const c of recorded.cases) {
			const tree = makeTree(baseFiles());
			const h = await makeHost({ Engine: E, tree });
			const r = await h.run(c.script, { cwd: '/w', apply: false });
			if (r.how !== 'exit') { failures.push(`${c.script}\n   did not end by itself: ${r.how}`); continue; }
			if (r.done.stats.withheld === 'incomplete') {
				assert.ok(r.done.notes.some((n) => /would become a (file|folder)/.test(n)), 'withheld with a reason that says so: ' + JSON.stringify(r.done.notes));
				assert.deepStrictEqual(r.done.changes, []);
				assert.notStrictEqual(r.exitCode, 0);
				continue;
			}
			representable++;
			const { ws, io } = mapWorkspace(tree);
			const res = await commitChanges(r.done.changes, io, CAPS);
			if (res.failed || res.refused || res.applied !== r.done.changes.length) {
				failures.push(`${c.script}\n   commit: applied ${res.applied} of ${res.total}: ${res.notes.join(' ')}\n   changes: ${r.done.changes.map((x) => x.kind + ':' + x.path).join(' ')}`);
				continue;
			}
			const got = dumpOf(ws);
			const want = c.tree.slice().sort();
			if (JSON.stringify(got) !== JSON.stringify(want)) {
				const missing = want.filter((l) => !got.includes(l));
				const extra = got.filter((l) => !want.includes(l));
				failures.push(`${c.script}\n   only GNU has: ${missing.join(' | ')}\n   only here: ${extra.join(' | ')}\n   stderr: ${r.stderr.trim().split('\n').slice(0, 3).join(' / ')}`);
			}
		}
		assert.deepStrictEqual(failures.slice(0, 4), [], `${failures.length} of ${recorded.cases.length} scripts differ`);
		assert.ok(representable >= recorded.cases.length * 0.9, 'most scripts have a change set: ' + representable);
	});

	test('a change set never lists a write below a folder it removes, nor a delete outside the folders (a property of every script)', async () => {
		for (const c of recorded.cases.slice(0, 120)) {
			const tree = makeTree(baseFiles());
			const h = await makeHost({ Engine: E, tree });
			const r = await h.run(c.script, { cwd: '/w', apply: false });
			const removed = r.done.changes.filter((x) => x.kind === 'rmdir').map((x) => x.path);
			for (const x of r.done.changes) {
				if (x.kind === 'write' || x.kind === 'mkdir') {
					assert.ok(!removed.some((d) => x.path === d || x.path.startsWith(d + '/')), `${x.kind} ${x.path} is below a folder this set removes\n${c.script}`);
				}
				assert.ok(x.path.startsWith('/w/'), x.path);
			}
		}
		void enc;
	});

	for (const t of tests) {
		await t.fn();
		console.log('  ok - ' + t.name);
	}
	console.log(`\n${tests.length} tests passed`);
}

main().catch((e) => { console.error(e); process.exit(1); });
