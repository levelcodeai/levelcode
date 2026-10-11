// The scripts of the change-set consistency check (web/test/unit/shell-engine-consistency.test.js): small random
// programs over a nested tree — writes two to four levels down in directories that exist, `rm -rf` and `mv` of an
// ancestor of what was just written, `cp -r`, `touch`, `sed -i`, `rmdir`. They are made from a seed, so a failing one
// is a number you can run again; generate.mjs records what GNU bash left for each (docker, once).
//
// The point of them: the engine hands the host a CHANGE SET, and the host applies it with plain create/delete calls. If
// the set mentions a file below a directory that is also being removed, the host stops half way. GNU is the oracle for
// "what should the tree look like"; the real src/commit.js over a map is the one that applies the set.

/** The workspace each script starts from: [path, content | null for a directory], paths relative to /w. */
export const FIXTURE = [
	['a', null], ['a/x', '1\n'], ['a/b', null], ['a/b/y', '2\n'], ['a/b/c', null], ['a/b/c/z', '3\n'],
	['a/b/d', null], ['a/b/d/w', '4\n'], ['a/e', null], ['a/e/v', '5\n'],
	['f', null], ['f/g', null], ['f/g/u', '6\n'], ['f/t', '7\n'],
	['m', null], ['m/n', null], ['m/n/o', '8\n'], ['top', '9\n'],
];

/** The shell commands that build FIXTURE. */
export const FIXTURE_SCRIPT = FIXTURE.map(([p, c]) => (c === null ? `mkdir -p ${p}` : `printf '${c.replace(/\n/g, '\\n')}' > ${p}`)).join('\n');

const DIRS = ['a', 'a/b', 'a/b/c', 'a/b/d', 'a/e', 'f', 'f/g', 'm', 'm/n', 'n', 'n/k', 'q/r/s'];
const FILES = ['a/x', 'a/b/y', 'a/b/c/z', 'a/b/d/w', 'a/e/v', 'f/g/u', 'f/t', 'm/n/o', 'top', 'a/b/c/new1', 'a/b/new2', 'f/g/new3', 'm/new4', 'a/e/new5', 'a/b/c/deep/file', 'f/g/h/i', 'new6'];

/** mulberry32: the same sequence on every machine */
export function rng(seed) {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6D2B79F5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/**
 * @param {number} seed
 * @param {number} count
 * @returns {string[]} scripts, to be run in /w after FIXTURE_SCRIPT
 */
export function scripts(seed, count) {
	const r = rng(seed);
	const pick = (list) => list[Math.floor(r() * list.length)];
	const out = [];
	for (let i = 0; i < count; i++) {
		const n = 3 + Math.floor(r() * 7);
		const lines = [];
		for (let k = 0; k < n; k++) {
			const v = `v${i}_${k}`;
			const any = () => pick(r() < 0.6 ? FILES : DIRS);
			// a copy of a directory into itself (cp -r a a/e) is done in directory order and then fails, whatever
			// was reached by then: not a thing the order of a file system should decide in a test
			const outside = (src) => {
				for (let t = 0; t < 8; t++) { const d = any(); if (d !== src && !d.startsWith(src + '/') && !src.startsWith(d + '/')) { return d; } }
				return 'new7';
			};
			switch (Math.floor(r() * 12)) {
				case 0: case 1: lines.push(`echo ${v} > ${pick(FILES)}`); break;
				case 2: lines.push(`echo ${v} >> ${pick(FILES)}`); break;
				case 3: lines.push(`mkdir -p ${pick(DIRS)}`); break;
				case 4: lines.push(`rm -f ${pick(FILES)}`); break;
				case 5: case 6: lines.push(`rm -rf ${pick(DIRS)}`); break;
				case 7: case 8: lines.push(`mv ${any()} ${any()}`); break;
				case 9: { const src = any(); lines.push(`cp -r ${src} ${outside(src)}`); break; }
				case 10: lines.push(r() < 0.5 ? `touch ${pick(FILES)}` : `sed -i s/v/w/ ${pick(FILES)}`); break;
				default: { const src = pick(FILES); lines.push(r() < 0.5 ? `rmdir ${pick(DIRS)}` : `cp ${src} ${outside(src)}`); break; }
			}
		}
		out.push(lines.join('\n'));
	}
	return out;
}
