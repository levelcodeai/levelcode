#!/usr/bin/env node
// Builds the engine worker: ONE classic script that the shell extension turns into a Blob and starts as a Worker
// (README.md §1).
//
//   node web/shell/engine/build.mjs --out <dir | file.js> --vscode <Code-OSS checkout> [--minify | --no-minify]
//
//   --out DIR       writes DIR/engine.worker.js and DIR/engine.worker.THIRD_PARTY.md (what web/shell/build.mjs passes)
//   --out FILE.js   writes that file and FILE.THIRD_PARTY.md next to it (a name that ends in .js is a file)
//   --minify        the default; --no-minify keeps the output readable. The last one given wins.
//   anything else   is an error (exit 2): a flag that is ignored silently is how `--minify` once did nothing
//
// Input: worker.js, core.js, overlay-fs.js, compat.js, zone.js, limits.js, and the vendored just-bash with its patches
// applied IN MEMORY (apply-patches.mjs; a changed anchor stops the build) plus the vendored diff / sprintf-js and three
// stubs. esbuild and the `buffer` package come from the Code-OSS checkout, which already depends on both.
//
// The build FAILS when the output
//   - requires or imports a `node:` built-in (a worker cannot have one), or
//   - bundles or requires liblzma, zstd, typescript, undici or guarded-fetch (code README.md §9 says never to ship;
//     the NAMES appear in just-bash's own strings, as MIME types and error texts, which is not the code), or
//   - lost the notice that it is a modified Apache-2.0 file.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { applyPatches } from './vendor/just-bash/3.6.0/apply-patches.mjs';
import { EXTERNALS, BROWSER_JS } from './load.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..', '..');

/** Packages that must not be in the worker (README.md §9). */
export const FORBIDDEN_PACKAGES = ['node-liblzma', 'liblzma', '@mongodb-js/zstd', 'zstd', 'typescript', 'undici', 'guarded-fetch', 'sql.js', 'fflate', 'turndown'];

/**
 * What is wrong with a bundle, as sentences. `inputs` are the files esbuild bundled (the metafile).
 * @param {string} code
 * @param {string[]} inputs
 * @returns {string[]}
 */
export function problemsOf(code, inputs) {
	const problems = [];
	if (/\b(?:require|import)\(\s*["']node:/.test(code) || /\bfrom\s*["']node:/.test(code)) { problems.push('the worker loads a node: built-in'); }
	for (const pkg of FORBIDDEN_PACKAGES) {
		const esc = pkg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		if (new RegExp('\\b(?:require|import)\\(\\s*["\']' + esc + '["\']').test(code) || new RegExp('\\bfrom\\s*["\']' + esc + '["\']').test(code)) { problems.push(`the worker loads ${pkg}`); }
		if (inputs.some((i) => i.split('/').includes('node_modules') && new RegExp('node_modules/' + esc + '(/|$)').test(i))) { problems.push(`the worker bundles ${pkg}`); }
	}
	if (!code.includes('MODIFIED by LevelCode')) { problems.push('the notice that just-bash was modified is gone from the output'); }
	return problems;
}

/** Find a package in the Code-OSS checkout, which already depends on esbuild and buffer. */
export function locate(name, vscodeDir) {
	const bases = [path.join(vscodeDir, 'build'), path.join(vscodeDir, 'extensions'), vscodeDir, REPO];
	for (const b of bases) {
		try { return createRequire(path.join(b, 'noop.js')).resolve(name); } catch { /* next */ }
	}
	return null;
}

/**
 * @param {{ vscodeDir: string, minify?: boolean }} o
 * @returns {Promise<{ code: string, bytes: number, gzip: number, brotli: number, inputSha256: string, patchedSha256: string, packages: string[], warnings: string[] }>}
 *   `packages` are the npm packages the bundle contains (from node_modules), sorted
 */
export async function buildEngine(o) {
	const vscodeDir = path.resolve(o.vscodeDir);
	const esbuildEntry = locate('esbuild', vscodeDir);
	if (!esbuildEntry) { throw new Error('esbuild not found under ' + vscodeDir + ' (run scripts/bootstrap.sh first)'); }
	const esbuild = await import(pathToFileURL(esbuildEntry).href);
	const nodePaths = [path.join(vscodeDir, 'node_modules'), path.join(vscodeDir, 'build', 'node_modules')].filter((p) => fs.existsSync(p));
	if (!nodePaths.some((p) => fs.existsSync(path.join(p, 'buffer')))) { throw new Error('the "buffer" package is missing from ' + vscodeDir + '/node_modules'); }

	const patched = applyPatches(fs.readFileSync(BROWSER_JS, 'utf8'));
	const lcPlugin = {
		name: 'lc-just-bash',
		setup(b) {
			b.onResolve({ filter: /^lc-just-bash$/ }, () => ({ path: 'lc-just-bash', namespace: 'lc' }));
			b.onLoad({ filter: /.*/, namespace: 'lc' }, () => ({ contents: patched.text, loader: 'js', resolveDir: HERE }));
		},
	};
	const result = await esbuild.build({
		entryPoints: [path.join(HERE, 'worker.js')],
		bundle: true,
		write: false,
		platform: 'browser',
		format: 'iife',
		target: 'es2022',
		minify: o.minify !== false,
		legalComments: 'eof',
		logLevel: 'silent',
		absWorkingDir: HERE,
		nodePaths,
		alias: { ...EXTERNALS },
		inject: [path.join(HERE, 'shims', 'buffer.mjs')],
		plugins: [lcPlugin],
		outfile: 'engine.worker.js',
		metafile: true,
	});
	const code = result.outputFiles[0].text;
	const inputs = Object.keys(result.metafile.inputs);
	const problems = problemsOf(code, inputs);
	if (problems.length) { throw new Error('engine worker refused: ' + problems.join('; ')); }
	const buf = Buffer.from(code, 'utf8');
	return {
		code,
		bytes: buf.length,
		gzip: zlib.gzipSync(buf, { level: 9 }).length,
		brotli: zlib.brotliCompressSync(buf, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } }).length,
		inputSha256: patched.inputSha256,
		patchedSha256: patched.sha256,
		packages: [...new Set(inputs.map((i) => /node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(i)).filter(Boolean).map((m) => /** @type {RegExpExecArray} */ (m)[1]))].sort(),
		warnings: result.warnings.map((w) => w.text),
	};
}

/**
 * The command line, parsed strictly.
 * @param {string[]} argv the arguments after the script name
 * @param {{ out: string, vscode: string }} defaults
 * @returns {{ out: string, vscode: string, minify: boolean } | { error: string }}
 */
export function parseArgs(argv, defaults) {
	const o = { out: defaults.out, vscode: defaults.vscode, minify: true };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		const eq = a.startsWith('--') ? a.indexOf('=') : -1;
		const name = eq < 0 ? a : a.slice(0, eq);
		if (name === '--minify' && eq < 0) { o.minify = true; continue; }
		if (name === '--no-minify' && eq < 0) { o.minify = false; continue; }
		if (name === '--out' || name === '--vscode') {
			const v = eq >= 0 ? a.slice(eq + 1) : argv[++i];
			if (!v || (eq < 0 && v.startsWith('--'))) { return { error: name + ' needs a value' }; }
			o[name.slice(2)] = v;
			continue;
		}
		return { error: 'unknown argument ' + JSON.stringify(a) };
	}
	return o;
}

/**
 * Where the bundle and its notice go: a name that ends in .js is the file, anything else is a directory.
 * @param {string} out
 * @returns {{ dir: string, file: string, notice: string }}
 */
export function outputPaths(out) {
	const p = path.resolve(out);
	if (/\.js$/i.test(p)) {
		return { dir: path.dirname(p), file: p, notice: p.replace(/\.js$/i, '.THIRD_PARTY.md') };
	}
	return { dir: p, file: path.join(p, 'engine.worker.js'), notice: path.join(p, 'engine.worker.THIRD_PARTY.md') };
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
	const parsed = parseArgs(process.argv.slice(2), { out: path.join(REPO, 'dist-web', 'shell'), vscode: path.join(REPO, 'vscode') });
	if ('error' in parsed) {
		process.stderr.write(parsed.error + '\nusage: node web/shell/engine/build.mjs --out <dir | file.js> --vscode <Code-OSS checkout> [--minify | --no-minify]\n');
		process.exit(2);
	}
	const target = outputPaths(parsed.out);
	try {
		const r = await buildEngine({ vscodeDir: path.resolve(parsed.vscode), minify: parsed.minify });
		fs.mkdirSync(target.dir, { recursive: true });
		fs.writeFileSync(target.file, r.code);
		fs.copyFileSync(path.join(HERE, 'vendor', 'just-bash', '3.6.0', 'THIRD_PARTY.md'), target.notice);
		for (const w of r.warnings) { process.stderr.write('warning: ' + w + '\n'); }
		process.stdout.write(`${path.basename(target.file)}: ${r.bytes} bytes raw, ${r.gzip} gzip, ${r.brotli} brotli (just-bash 3.6.0 patched sha256 ${r.patchedSha256.slice(0, 12)})\n`);
	} catch (e) {
		process.stderr.write(String(e && e.message || e) + '\n');
		process.exit(1);
	}
}
