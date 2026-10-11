/*---------------------------------------------------------------------------------------------
 *  The engine worker, as built — run: node web/test/unit/shell-engine-build.test.js
 *
 *  build.mjs bundles worker.js, the core, the overlay, compat and the patched just-bash into one classic script. This
 *  checks the rules the build enforces (on synthetic input, always), and — when esbuild is there, which it is only
 *  next to a Code-OSS checkout — builds it for real and runs the result in a context that has what a Worker has and
 *  nothing a Node process has: no `process`, no `require`, no `Buffer` of its own.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { spawnSync } = require('child_process');
const { pathToFileURL } = require('url');

const REPO = path.join(__dirname, '..', '..', '..');
const ENGINE = path.join(REPO, 'web', 'shell', 'engine');

/** @type {Array<{ name: string, fn: () => Promise<void> | void }>} */
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

/**
 * A Code-OSS checkout whose esbuild RUNS here (a checkout made on another platform has the other platform's binary),
 * with `buffer`: its path, or why there is none (CI has none; a worktree is next to the main checkout).
 * @returns {Promise<{ dir: string } | { why: string }>}
 */
async function findVscode(build) {
	const candidates = [process.env.LEVELCODE_VSCODE, path.join(REPO, 'vscode'), path.join(REPO, '..', '..', '..', 'vscode')].filter(Boolean);
	const tried = [];
	for (const c of candidates) {
		if (!fs.existsSync(path.join(c, 'node_modules', 'buffer'))) { tried.push(c + ': no node_modules/buffer'); continue; }
		const entry = build.locate('esbuild', c);
		if (!entry) { tried.push(c + ': no esbuild'); continue; }
		try {
			const esbuild = await import(pathToFileURL(entry).href);
			await esbuild.transform('1', {});
			return { dir: c };
		} catch (e) {
			tried.push(c + ': esbuild does not run here (' + String(e && e.message || e).split('\n')[0].slice(0, 100) + ')');
		}
	}
	return { why: tried.length ? tried.join('; ') : 'no candidate (set LEVELCODE_VSCODE to a Code-OSS checkout)' };
}

async function main() {
	const build = await import(pathToFileURL(path.join(ENGINE, 'build.mjs')).href);

	test('the checks: a node: built-in, a package that must not ship, a missing notice — each refuses the build, with the name', () => {
		const ok = '/*! LevelCode: MODIFIED by LevelCode */ (()=>{ var s = "application/zstd and text/typescript are only words" })()';
		assert.deepStrictEqual(build.problemsOf(ok, ['web/shell/engine/core.js', 'web/shell/engine/vendor/diff/8.0.4/libesm/index.js']), []);
		assert.ok(build.problemsOf(ok + '; require("node:fs")', []).some((p) => /node: built-in/.test(p)));
		assert.ok(build.problemsOf(ok + '; import("node:zlib")', []).some((p) => /node: built-in/.test(p)));
		assert.ok(build.problemsOf(ok + '; import x from"node:module"', []).some((p) => /node: built-in/.test(p)));
		for (const pkg of ['node-liblzma', '@mongodb-js/zstd', 'typescript', 'undici', 'guarded-fetch', 'sql.js', 'fflate', 'turndown']) {
			assert.ok(build.problemsOf(ok + `; require("${pkg}")`, []).some((p) => p.includes(pkg)), pkg + ' required');
			assert.ok(build.problemsOf(ok, [`/vscode/node_modules/${pkg}/lib/index.js`]).some((p) => p.includes(pkg)), pkg + ' bundled');
		}
		assert.ok(build.problemsOf('(()=>{})()', []).some((p) => /notice/.test(p)), 'the notice that the file was modified');
		assert.ok(build.FORBIDDEN_PACKAGES.includes('node-liblzma') && build.FORBIDDEN_PACKAGES.includes('guarded-fetch'));
	});

	test('the command line: --out is a directory or a file that ends in .js, --minify and --no-minify (the last wins), nothing else is accepted', () => {
		const d = { out: '/dflt', vscode: '/vs' };
		assert.deepStrictEqual(build.parseArgs([], d), { out: '/dflt', vscode: '/vs', minify: true });
		assert.deepStrictEqual(build.parseArgs(['--out', '/o', '--vscode', '/v'], d), { out: '/o', vscode: '/v', minify: true });
		assert.deepStrictEqual(build.parseArgs(['--out=/o', '--vscode=/v', '--no-minify'], d), { out: '/o', vscode: '/v', minify: false });
		assert.strictEqual(build.parseArgs(['--no-minify', '--minify'], d).minify, true);
		assert.strictEqual(build.parseArgs(['--minify', '--no-minify'], d).minify, false);
		assert.deepStrictEqual(build.parseArgs(['--minify'], d), { out: '/dflt', vscode: '/vs', minify: true });
		for (const bad of [['--bogus'], ['--out'], ['--out', '--minify'], ['--vscode='], ['--minify=false'], ['out'], ['--no-minify=1']]) {
			assert.ok('error' in build.parseArgs(bad, d), JSON.stringify(bad));
		}
		assert.deepStrictEqual(build.outputPaths('/x/dir'), { dir: '/x/dir', file: '/x/dir/engine.worker.js', notice: '/x/dir/engine.worker.THIRD_PARTY.md' });
		assert.deepStrictEqual(build.outputPaths('/x/dir/'), { dir: '/x/dir', file: '/x/dir/engine.worker.js', notice: '/x/dir/engine.worker.THIRD_PARTY.md' });
		assert.deepStrictEqual(build.outputPaths('/x/y/custom.js'), { dir: '/x/y', file: '/x/y/custom.js', notice: '/x/y/custom.THIRD_PARTY.md' });
		assert.deepStrictEqual(build.outputPaths('/x/y/Engine.JS'), { dir: '/x/y', file: '/x/y/Engine.JS', notice: '/x/y/Engine.THIRD_PARTY.md' });
		assert.strictEqual(build.outputPaths('/x/jsdir').file, '/x/jsdir/engine.worker.js', 'a name that merely contains js is a folder');
	});

	test('a bad argument ends the build with status 2 and the usage, before anything is written', () => {
		const out = path.join(os.tmpdir(), 'lc-build-never-' + process.pid);
		for (const bad of [['--out', out, '--bogus'], ['--out'], ['--minify=no']]) {
			const r = spawnSync(process.execPath, [path.join(ENGINE, 'build.mjs'), ...bad], { encoding: 'utf8' });
			assert.strictEqual(r.status, 2, JSON.stringify(bad) + ' ' + r.stderr);
			assert.ok(/usage: node web\/shell\/engine\/build\.mjs --out/.test(r.stderr), r.stderr);
		}
		assert.strictEqual(fs.existsSync(out), false);
	});

	// (the copy of this file that the test below starts is not asked to start another one)
	if (!process.env.LC_BUILD_TEST_COPY) test('with no checkout the build tests say so in a line that starts !! SKIPPED, and LEVELCODE_REQUIRE_BUILD=1 makes that a failure', () => {
		// this file, copied (with the engine it builds) to where no checkout is beside it
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-build-skip-'));
		try {
			fs.mkdirSync(path.join(root, 'web', 'test', 'unit'), { recursive: true });
			fs.cpSync(ENGINE, path.join(root, 'web', 'shell', 'engine'), { recursive: true });
			fs.copyFileSync(__filename, path.join(root, 'web', 'test', 'unit', 'shell-engine-build.test.js'));
			const run = (env) => spawnSync(process.execPath, [path.join(root, 'web', 'test', 'unit', 'shell-engine-build.test.js')], { encoding: 'utf8', env: Object.assign({}, process.env, { LEVELCODE_VSCODE: '', LEVELCODE_REQUIRE_BUILD: '', LC_BUILD_TEST_COPY: '1' }, env) });
			const quiet = run({});
			assert.strictEqual(quiet.status, 0, quiet.stdout + quiet.stderr);
			assert.ok(/^  !! SKIPPED - the real build, its run in a worker-like context, and the shell build end to end did NOT run: /m.test(quiet.stdout), quiet.stdout);
			assert.ok(/LEVELCODE_REQUIRE_BUILD=1/.test(quiet.stdout));
			const strict = run({ LEVELCODE_REQUIRE_BUILD: '1' });
			assert.notStrictEqual(strict.status, 0);
			assert.ok(/LEVELCODE_REQUIRE_BUILD=1 and the real build/.test(strict.stderr), strict.stderr);
			assert.ok(!/SKIPPED/.test(strict.stdout));
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	const found = await findVscode(build);
	if ('why' in found) {
		const line = 'the real build, its run in a worker-like context, and the shell build end to end did NOT run: ' + found.why;
		if (process.env.LEVELCODE_REQUIRE_BUILD === '1') {
			throw new Error('LEVELCODE_REQUIRE_BUILD=1 and ' + line);
		}
		// loud on purpose: a green run that built nothing must not look like one that did
		console.log('  !! SKIPPED - ' + line + ' (set LEVELCODE_VSCODE to a Code-OSS checkout; LEVELCODE_REQUIRE_BUILD=1 makes this a failure)');
	} else {
		const vscodeDir = found.dir;
		/** @type {any} */
		let built = null;
		test('the build: one IIFE, the licence notice kept, and nothing it must not contain', async () => {
			built = await build.buildEngine({ vscodeDir, minify: true });
			assert.ok(built.bytes > 900 * 1024 && built.bytes < 2 * 1024 * 1024, 'size ' + built.bytes);
			assert.ok(built.gzip < 500 * 1024, 'gzip ' + built.gzip);
			assert.ok(built.code.includes('MODIFIED by LevelCode'));
			assert.ok(built.code.includes('Copyright 2025 Vercel Inc.'));
			assert.ok(/^\(\(\)=>\{|^"use strict";\(\(\)=>\{|^\(function/.test(built.code), 'an IIFE: ' + built.code.slice(0, 40));
			assert.ok(!/\bimport\.meta\b/.test(built.code) && !/^\s*export\s/m.test(built.code), 'a classic script: no module syntax');
			assert.ok(/MIT License|BSD-3-Clause/.test(built.code), 're2js and ieee754 keep their notices');
			// the only npm packages in it: `buffer` (what just-bash's own Buffer paths run on, as they do under node, where
			// the tests ran) and the two it needs; everything else is vendored, stubbed or inlined by upstream
			assert.deepStrictEqual(built.packages, ['base64-js', 'buffer', 'ieee754']);
			assert.ok(built.code.includes('Feross Aboukhadijeh'), 'the notice of the buffer package');
			assert.deepStrictEqual(built.warnings, []);
			// the same bytes twice: a build is a function of its inputs
			const again = await build.buildEngine({ vscodeDir, minify: true });
			assert.strictEqual(again.code, built.code);
			assert.strictEqual(again.patchedSha256, JSON.parse(fs.readFileSync(path.join(ENGINE, 'vendor', 'just-bash', '3.6.0', 'VENDOR.json'), 'utf8')).patched.sha256);
		});

		test('the worker runs where only a Worker\'s globals exist: init, a script, files read through the host, a change set back', async () => {
			const posted = [];
			const timers = new Set();
			const nodeCrypto = require('crypto').webcrypto;
			/** @type {any} */
			const self = { postMessage: (m) => { posted.push(m); } };
			/** @type {any} */
			const sandbox = {
				self,
				console: { log() { /* a worker has a console; the engine writes nothing */ }, warn() { /* idem */ }, error() { /* idem */ } },
				setTimeout: (f, ms) => { const t = setTimeout(f, ms); timers.add(t); return t; },
				clearTimeout,
				setInterval, clearInterval, queueMicrotask,
				TextEncoder, TextDecoder, URL, URLSearchParams, AbortController, AbortSignal, performance, MessageChannel,
				structuredClone, atob, btoa, crypto: nodeCrypto, Uint8Array, ArrayBuffer, DataView,
			};
			sandbox.globalThis = sandbox;
			sandbox.window = undefined;
			const ctx = vm.createContext(sandbox);
			assert.strictEqual(vm.runInContext('typeof process + typeof require + typeof Buffer + typeof module', ctx), 'undefinedundefinedundefinedundefined');
			vm.runInContext(built.code, ctx, { filename: 'engine.worker.js' });
			assert.strictEqual(typeof self.onmessage, 'function', 'the worker listens');
			assert.strictEqual(vm.runInContext('typeof Buffer', ctx), 'undefined', 'the bundle does not leak a global Buffer');

			const files = new Map([['/w/a.txt', new TextEncoder().encode('hello\nworld\n')]]);
			const deliver = (m) => self.onmessage({ data: m });
			const answer = () => {
				for (const m of posted.splice(0)) {
					if (m.t === 'fs') {
						setImmediate(() => {
							if (m.op === 'stat') { files.has(m.path) ? deliver({ t: 'fsr', rid: m.rid, ok: true, value: { type: 'file', size: files.get(m.path).length, mtime: 1 } }) : (m.path === '/w' ? deliver({ t: 'fsr', rid: m.rid, ok: true, value: { type: 'dir', size: 0, mtime: 1 } }) : deliver({ t: 'fsr', rid: m.rid, ok: false, error: { code: 'ENOENT', message: 'no' } })); }
							if (m.op === 'readFile') { deliver({ t: 'fsr', rid: m.rid, ok: true, value: files.get(m.path) }); }
							if (m.op === 'readDir') { deliver({ t: 'fsr', rid: m.rid, ok: true, value: [['a.txt', 'file']] }); }
						});
					} else { seen.push(m); }
				}
			};
			const seen = [];
			const pump = setInterval(answer, 1);
			try {
				deliver({ t: 'init', gen: 3, folders: [{ id: 'f', path: '/w', name: 'w' }] });
				await new Promise((r) => setTimeout(r, 30));
				answer();
				const ready = seen.find((m) => m.t === 'ready');
				assert.ok(ready && ready.gen === 3 && ready.commands.includes('grep') && ready.commands.includes('od') && !ready.commands.includes('gzip'));
				deliver({ t: 'run', id: 1, script: "cat a.txt | wc -l; printf 'gP8=' | base64 -d | od -An -tu1; read x <<< 'café'; echo \"$x\" > out.txt; echo $(( $ )); ls", cwd: '/w', env: {}, stdin: '' });
				for (let i = 0; i < 200 && !seen.some((m) => m.t === 'done'); i++) { await new Promise((r) => setTimeout(r, 10)); answer(); }
				const done = seen.find((m) => m.t === 'done');
				assert.ok(done, 'the run ended');
				const out = seen.filter((m) => m.t === 'out').map((m) => m.text).join('');
				assert.ok(out.includes('2\n'), out);
				assert.ok(out.includes(' 128 255\n'), 'base64 -d: ' + out);
				assert.ok(out.includes('a.txt\nout.txt\n') || out.includes('a.txt\nout.txt'), out);
				assert.deepStrictEqual([done.id, done.how], [1, 'exit']);
				const w = done.changes.find((c) => c.path === '/w/out.txt');
				assert.ok(w && new TextDecoder().decode(w.after) === 'café\n', 'read gives UTF-8 text in the bundle too');
			} finally {
				clearInterval(pump);
				for (const t of timers) { clearTimeout(t); }
			}
		});

		test('the command line builds a directory or a named file, minified or not, and writes the notice next to it', () => {
			const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-build-cli-'));
			try {
				const run = (args) => spawnSync(process.execPath, [path.join(ENGINE, 'build.mjs'), '--vscode', vscodeDir, ...args], { encoding: 'utf8' });
				const a = run(['--out', path.join(dir, 'dist')]);
				assert.strictEqual(a.status, 0, a.stderr);
				assert.deepStrictEqual(fs.readdirSync(path.join(dir, 'dist')).sort(), ['engine.worker.THIRD_PARTY.md', 'engine.worker.js']);
				assert.ok(fs.statSync(path.join(dir, 'dist', 'engine.worker.js')).isFile(), 'a FILE, not a folder');
				const b = run(['--out', path.join(dir, 'named', 'my-engine.js'), '--no-minify']);
				assert.strictEqual(b.status, 0, b.stderr);
				assert.deepStrictEqual(fs.readdirSync(path.join(dir, 'named')).sort(), ['my-engine.THIRD_PARTY.md', 'my-engine.js']);
				assert.ok(fs.statSync(path.join(dir, 'named', 'my-engine.js')).isFile());
				const min = fs.statSync(path.join(dir, 'dist', 'engine.worker.js')).size;
				const readable = fs.statSync(path.join(dir, 'named', 'my-engine.js')).size;
				assert.ok(readable > min * 1.3, `--no-minify is bigger: ${readable} against ${min}`);
				const c = run(['--out', path.join(dir, 'explicit.js'), '--no-minify', '--minify']);
				assert.strictEqual(c.status, 0, c.stderr);
				assert.strictEqual(fs.statSync(path.join(dir, 'explicit.js')).size, min, '--minify is the minified bundle (the last of the two wins)');
				assert.ok(/engine\.worker\.js: \d+ bytes raw/.test(a.stdout) && /my-engine\.js: \d+ bytes raw/.test(b.stdout), a.stdout + b.stdout);
				assert.strictEqual(fs.readFileSync(path.join(dir, 'dist', 'engine.worker.THIRD_PARTY.md'), 'utf8'), fs.readFileSync(path.join(ENGINE, 'vendor', 'just-bash', '3.6.0', 'THIRD_PARTY.md'), 'utf8'));
			} finally {
				fs.rmSync(dir, { recursive: true, force: true });
			}
		});

		test('the shell build, end to end (web/shell/build.mjs): the extension, the engine worker as a FILE, the notices, and the same bytes as the engine build', async () => {
			const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-build-shell-'));
			try {
				const r = spawnSync(process.execPath, [path.join(REPO, 'web', 'shell', 'build.mjs'), '--out', dir, '--vscode', vscodeDir, '--minify'], { encoding: 'utf8' });
				assert.strictEqual(r.status, 0, r.stdout + r.stderr);
				const out = path.join(dir, 'levelcode-shell');
				for (const f of ['package.json', 'package.nls.json', 'extension.js', 'engine.worker.js', 'engine.worker.THIRD_PARTY.md', 'THIRD_PARTY_NOTICES.md']) {
					assert.ok(fs.existsSync(path.join(out, f)), f + ' is there: ' + fs.readdirSync(out).join(' '));
				}
				assert.ok(fs.statSync(path.join(out, 'engine.worker.js')).isFile(), 'engine.worker.js is a file (it was a folder when --out was a path)');
				assert.ok(fs.statSync(path.join(out, 'extension.js')).size > 1000);
				const direct = await build.buildEngine({ vscodeDir, minify: true });
				assert.strictEqual(fs.readFileSync(path.join(out, 'engine.worker.js'), 'utf8'), direct.code, '--minify reaches the engine build');
				const plain = spawnSync(process.execPath, [path.join(REPO, 'web', 'shell', 'build.mjs'), '--out', dir, '--vscode', vscodeDir], { encoding: 'utf8' });
				assert.strictEqual(plain.status, 0, plain.stdout + plain.stderr);
				assert.ok(fs.statSync(path.join(out, 'engine.worker.js')).size > direct.bytes * 1.3, 'without --minify the engine is readable');
				assert.ok(/MODIFIED by LevelCode/.test(fs.readFileSync(path.join(out, 'engine.worker.js'), 'utf8')));
				assert.ok(/just-bash 3\.6\.0 \(Apache-2\.0, Copyright 2025 Vercel Inc\.\), \*\*modified by LevelCode\*\*/.test(fs.readFileSync(path.join(out, 'THIRD_PARTY_NOTICES.md'), 'utf8')));
			} finally {
				fs.rmSync(dir, { recursive: true, force: true });
			}
		});
	}

	for (const t of tests) {
		await t.fn();
		console.log('  ok - ' + t.name);
	}
	console.log(`\n${tests.length} tests passed`);
}

main().catch((e) => { console.error(e); process.exit(1); });
