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
const path = require('path');
const vm = require('vm');
const { pathToFileURL } = require('url');

const REPO = path.join(__dirname, '..', '..', '..');
const ENGINE = path.join(REPO, 'web', 'shell', 'engine');

/** @type {Array<{ name: string, fn: () => Promise<void> | void }>} */
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

/** A Code-OSS checkout with esbuild and buffer, or null (CI has none; a worktree is next to the main checkout). */
function findVscode(build) {
	const candidates = [process.env.LEVELCODE_VSCODE, path.join(REPO, 'vscode'), path.join(REPO, '..', '..', '..', 'vscode')].filter(Boolean);
	for (const c of candidates) {
		if (fs.existsSync(path.join(c, 'node_modules', 'buffer')) && build.locate('esbuild', c)) { return c; }
	}
	return null;
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

	const vscodeDir = findVscode(build);
	if (!vscodeDir) {
		console.log('  skipped - the real build and run: no Code-OSS checkout with esbuild and buffer (set LEVELCODE_VSCODE)');
	} else {
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
	}

	for (const t of tests) {
		await t.fn();
		console.log('  ok - ' + t.name);
	}
	console.log(`\n${tests.length} tests passed`);
}

main().catch((e) => { console.error(e); process.exit(1); });
