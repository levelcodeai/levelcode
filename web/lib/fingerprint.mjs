// What identifies a build. A release puts everything under /_/<id>/ and tells browsers it never changes, so the id has to
// change whenever anything under it does: a file of the extension that was edited but not named here would be served
// stale, from cache, for a year.
import fs from 'node:fs';
import path from 'node:path';

/**
 * Feed every file under `dir` — its path relative to `dir`, then its bytes — into `hash`, in a stable order.
 * Files and folders whose NAME is in `skip` are left out wherever they are.
 * @param {import('node:crypto').Hash} hash
 * @param {string} dir
 * @param {{ skip?: string[] }} [opts]
 * @returns {import('node:crypto').Hash}
 */
export function hashTree(hash, dir, { skip = [] } = {}) {
	const skipped = new Set(skip);
	const walk = (d, rel) => {
		const entries = fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
		for (const e of entries) {
			if (skipped.has(e.name)) { continue; }
			const full = path.join(d, e.name);
			const r = rel ? rel + '/' + e.name : e.name;
			if (e.isDirectory()) { walk(full, r); }
			else if (e.isFile()) { hash.update('\0' + r + '\0'); hash.update(fs.readFileSync(full)); }
		}
	};
	walk(dir, '');
	return hash;
}
