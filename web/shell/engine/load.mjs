// loadEngine(): the patched just-bash for node tests, built the way the worker bundle is — same anchors, same
// vendored externals — but imported instead of bundled. The patched text is written to a temporary file, imported,
// and deleted again before this resolves, so nothing is left behind however the test ends.
//
//   const Engine = await loadEngine();        // { Bash, defineCommand, getCommandNames, ... , lcSha256 }
import { webcrypto } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { applyPatches, applyEdits, HEADER, PATCHES } from './vendor/just-bash/3.6.0/apply-patches.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// A worker has `crypto` (sha256sum, mktemp and the random devices use it); Node 18 has it only as require('crypto').webcrypto
if (typeof globalThis.crypto === 'undefined') { globalThis.crypto = /** @type {any} */ (webcrypto); }

/**
 * The files browser.js imports without bundling them (build.mjs aliases the same names), and LevelCode's own two
 * modules that the patched file's header imports (engine/text.js and engine/zone.js, see apply-patches.mjs HEADER).
 */
export const EXTERNALS = {
	'node:zlib': path.join(HERE, 'vendor', 'stubs', 'zlib.mjs'),
	'node:module': path.join(HERE, 'vendor', 'stubs', 'module.mjs'),
	diff: path.join(HERE, 'vendor', 'diff', '8.0.4', 'libesm', 'index.js'),
	'sprintf-js': path.join(HERE, 'vendor', 'sprintf-js', '1.1.3', 'sprintf.js'),
	turndown: path.join(HERE, 'vendor', 'stubs', 'turndown.mjs'),
	'lc-text': path.join(HERE, 'text.js'),
	'lc-zone': path.join(HERE, 'zone.js'),
};
export const BROWSER_JS = path.join(HERE, 'vendor', 'just-bash', '3.6.0', 'browser.js');

/** The module specifiers of the static imports in a bundle: `import{a as b}from"x"`, `import*as U from"x"`, `import d from"x"`, `import"x"`. */
export function importSpecifiers(text) {
	const found = new Set();
	const re = /\bimport\s*(?:(?:\{[^}]*\}|\*\s*as\s+[\w$]+|[\w$]+)\s*(?:,\s*(?:\{[^}]*\}|\*\s*as\s+[\w$]+)\s*)?from\s*)?"([^"]+)"/g;
	for (let m = re.exec(text); m; m = re.exec(text)) { found.add(m[1]); }
	return [...found].sort();
}

/** @returns {{ text: string, sha256: string }} the patched source with its bare imports pointing at the vendored files */
export function patchedSource() {
	const r = applyPatches(fs.readFileSync(BROWSER_JS, 'utf8'));
	const unknown = importSpecifiers(r.text).filter((s) => !(s in EXTERNALS));
	if (unknown.length) { throw new Error('browser.js imports something that is not vendored: ' + unknown.join(', ')); }
	let text = r.text;
	for (const [name, file] of Object.entries(EXTERNALS)) {
		text = text.split(`from"${name}"`).join(`from${JSON.stringify(pathToFileURL(file).href)}`);
	}
	return { text, sha256: r.sha256 };
}

/** @type {Promise<any> | null} */
let cached = null;
/** the temporary directory loadEngine used (it is gone again); a test checks that one, not the shared temp dir, which other processes use too */
let usedDir = null;
export function lastTempDir() { return usedDir; }

export function loadEngine() {
	if (!cached) {
		cached = (async () => {
			const { text, sha256 } = patchedSource();
			const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-shell-engine-'));
			usedDir = dir;
			try {
				const file = path.join(dir, 'just-bash.lc.mjs');
				fs.writeFileSync(file, text);
				const mod = await import(pathToFileURL(file).href);
				return Object.assign({}, mod, { lcSha256: sha256 });
			} finally {
				fs.rmSync(dir, { recursive: true, force: true });
			}
		})();
	}
	return cached;
}

/**
 * The engine WITHOUT some patches (a test of the patch itself: what a case does with the fix taken out). Not cached,
 * and never used by the worker. `ids` are patch ids (`LC-61`).
 *
 * @param {string[]} ids
 */
export async function loadEngineWithout(ids) {
	const rest = PATCHES.filter((p) => !ids.includes(p.id));
	if (rest.length !== PATCHES.length - ids.length) { throw new Error('no such patch: ' + ids.join(', ')); }
	let text = HEADER + applyEdits(fs.readFileSync(BROWSER_JS, 'utf8'), rest);
	for (const [name, file] of Object.entries(EXTERNALS)) {
		text = text.split(`from"${name}"`).join(`from${JSON.stringify(pathToFileURL(file).href)}`);
	}
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-shell-engine-'));
	try {
		const file = path.join(dir, 'just-bash.lc.mjs');
		fs.writeFileSync(file, text);
		return await import(pathToFileURL(file).href);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}
