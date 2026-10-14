#!/usr/bin/env node
// Build LevelCode Shell for the browser: the extension (one file the web extension host can evaluate), the engine
// worker (one file the extension turns into a Blob worker), and the manifest. Writes nothing into web/.
//
//   node web/shell/build.mjs --out <dir> --vscode <Code-OSS checkout> [--minify]
//
// Output (<dir>/levelcode-shell): package.json, package.nls.json, extension.js, engine.worker.js, THIRD_PARTY_NOTICES.md
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, all) => {
	if (v.startsWith('--')) { a.push([v.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : 'true']); }
	return a;
}, []));
const outRoot = path.resolve(args.out || path.join(REPO, 'dist-web', 'extensions'));
const vscodeDir = path.resolve(args.vscode || path.join(REPO, 'vscode'));
const minify = args.minify === 'true';
const outDir = path.join(outRoot, 'levelcode-shell');

function locate(name, bases) {
	for (const b of bases) {
		try { return createRequire(path.join(b, 'noop.js')).resolve(name); } catch { /* next */ }
	}
	return null;
}
const esbuildEntry = locate('esbuild', [path.join(vscodeDir, 'build'), path.join(vscodeDir, 'extensions'), vscodeDir, REPO]);
if (!esbuildEntry) { console.error('esbuild not found under ' + vscodeDir + ' (run scripts/bootstrap.sh first)'); process.exit(2); }
const esbuild = await import(esbuildEntry);

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

/* ----- the extension host half -------------------------------------------------------------- */
await esbuild.build({
	entryPoints: [path.join(HERE, 'src', 'extension.js')],
	outfile: path.join(outDir, 'extension.js'),
	bundle: true,
	platform: 'browser',
	format: 'cjs',
	target: 'es2022',
	external: ['vscode'],
	minify,
	legalComments: 'none',
	logLevel: 'warning',
});

/* ----- the engine worker -------------------------------------------------------------------- */
// engine/build.mjs takes a DIRECTORY and writes engine.worker.js (and its third-party notice) into it; it minifies
// unless told not to.
const r = spawnSync(process.execPath, [path.join(HERE, 'engine', 'build.mjs'), '--out', outDir, '--vscode', vscodeDir, ...(minify ? [] : ['--no-minify'])], { stdio: 'inherit' });
if (r.status !== 0) { console.error('the engine worker build failed'); process.exit(1); }
if (!fs.statSync(path.join(outDir, 'engine.worker.js')).isFile()) { console.error('engine.worker.js is not a file'); process.exit(1); }

/* ----- manifest, notices -------------------------------------------------------------------- */
fs.copyFileSync(path.join(HERE, 'package.json'), path.join(outDir, 'package.json'));
fs.writeFileSync(path.join(outDir, 'package.nls.json'), '{}\n');
// Apache-2.0 §4: the licence of what is shipped, and a notice that the file was modified. The engine's own
// vendor directory carries the texts; they travel with the build.
const notices = [];
const vend = path.join(HERE, 'engine', 'vendor');
if (fs.existsSync(vend)) {
	const walk = (d) => {
		for (const e of fs.readdirSync(d, { withFileTypes: true })) {
			const p = path.join(d, e.name);
			if (e.isDirectory()) { walk(p); }
			else if (/^(LICENSE|LICENCE|NOTICE|THIRD_PARTY)/i.test(e.name) && !/\.mjs$|\.js$/.test(e.name)) { notices.push('## ' + path.relative(vend, p) + '\n\n' + fs.readFileSync(p, 'utf8').trim() + '\n'); }
		}
	};
	walk(vend);
}
fs.writeFileSync(path.join(outDir, 'THIRD_PARTY_NOTICES.md'),
	'# Third-party notices — LevelCode Shell\n\nengine.worker.js contains just-bash 3.6.0 (Apache-2.0, Copyright 2025 Vercel Inc.), **modified by LevelCode** (see web/shell/engine/vendor/just-bash/3.6.0/apply-patches.mjs for the changes), and the libraries below.\n\n'
	+ notices.join('\n---\n\n'));

const size = (f) => { const b = fs.readFileSync(path.join(outDir, f)); return `${f} ${(b.length / 1024).toFixed(0)} KB (gzip ${(zlib.gzipSync(b).length / 1024).toFixed(0)} KB)`; };
console.log('[shell] ' + size('extension.js') + ', ' + size('engine.worker.js'));
