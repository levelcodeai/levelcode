// Derives width-table.json from xterm.js itself: the cell width of every code point as the workbench's terminal
// computes it with its Unicode 11 provider (terminal.integrated.unicodeVersion, default '11').
//
//   node web/shell/src/terminal/gen-width.mjs <path to addon-unicode11.js> [--write]
//
// Without --write it prints a summary and exits 1 when the checked-in table differs. shell-terminal-width.test.js
// runs the same comparison whenever an xterm checkout is found, so a bump of the workbench that changes widths
// shows up as a red test instead of a cursor that drifts on screen.
// @ts-check
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const TABLE = fileURLToPath(new URL('./width-table.json', import.meta.url));

/**
 * @param {string} addonFile  path to xterm's addon-unicode11.js
 * @returns {{ version: string, zero: number[][], wide: number[][] }}
 */
export function deriveTable(addonFile) {
	const { Unicode11Addon } = require(addonFile);
	let provider = null;
	// The addon registers its provider on activate(); a stand-in terminal is enough to catch it.
	const register = (/** @type {any} */ p) => { provider = p; };
	new Unicode11Addon().activate({ _core: { unicodeService: { register } }, unicode: { register, activeVersion: '6' } });
	if (!provider) { throw new Error('the addon did not register a provider'); }
	const p = /** @type {any} */ (provider);
	/** @type {{ 0: number[][], 2: number[][] }} */
	const ranges = { 0: [], 2: [] };
	/** @type {{ w: number, lo: number, hi: number } | null} */
	let cur = null;
	for (let cp = 0; cp <= 0x10ffff; cp++) {
		if (cp >= 0xd800 && cp <= 0xdfff) { continue; }
		const w = p.wcwidth(cp);
		if (w === 1) { cur = null; continue; }
		if (cur && cur.w === w && cur.hi === cp - 1) { cur.hi = cp; ranges[/** @type {0|2} */ (w)][ranges[/** @type {0|2} */ (w)].length - 1][1] = cp; continue; }
		cur = { w, lo: cp, hi: cp };
		ranges[/** @type {0|2} */ (w)].push([cp, cp]);
	}
	return { version: p.version, zero: ranges[0], wide: ranges[2] };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	const addon = process.argv[2];
	if (!addon) { console.error('usage: gen-width.mjs <addon-unicode11.js> [--write]'); process.exit(2); }
	const next = JSON.stringify(deriveTable(addon));
	const same = readFileSync(TABLE, 'utf8').trim() === next;
	console.log(same ? 'width-table.json is current' : 'width-table.json differs');
	if (!same && process.argv.includes('--write')) { writeFileSync(TABLE, next + '\n'); console.log('written'); }
	process.exit(same || process.argv.includes('--write') ? 0 : 1);
}
