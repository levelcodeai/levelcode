// The cp and mv operand-shape matrix (every source shape against every destination shape, for three verbs, and a seeded
// sample of the options and of two-source lines), run against GNU coreutils 8.32 once and compared with the engine by
// shell-engine-cpmv.test.js. The shapes are the ones the independent checks of two rounds found one by one:
// a trailing slash, `.` and `..` components, a source that is a file with a slash, a destination that is a file, a
// folder, nothing, or inside the source.
//
// `casesOf()` is deterministic: the same list on every machine and under every Node.

/**
 * the tree every case starts from. The times are set (`-u` compares them, and files made in one breath have times that
 * are the same or not by the clock of the machine): everything is at 1000000000 but e/one, which is 100 seconds later
 */
export const FIXTURE = `mkdir -p d/sub e emp lone/in ws
echo F > f; echo G > g; echo H > h
echo d1 > d/one; echo d2 > d/sub/two
echo e1 > e/one; echo eg > e/ex
mkdir -p ws/"a b"; echo sp > "ws/a b/c d"
touch -d @1000000000 f g h d/one d/sub/two e/ex "ws/a b/c d"; touch -d @1000000100 e/one`;

const SOURCES = ['f', 'd', 'd/', 'm', 'f/', 'emp', 'd/sub', 'd/.', 'd/*', 'ws/a\\ b', '"ws/a b"', 'e/one', './f', '../w/f'];
const DESTINATIONS = ['x', 'x/', 'e', 'e/', 'g', 'g/', 'y/z', 'y/z/', 'g/x', 'g/x/', '.', './', 'e/one', 'e/ex', 'd/sub', 'emp', 'emp/', 'f', 'd', 'x//', 'e//', '"new dir/"', 'e/..', 'lone/in/', 'ws/"a b"/'];
const VERBS = ['cp', 'cp -r', 'cp -R', 'cp -a', 'cp -rT', 'cp -T', 'cp -n', 'cp -rn', 'cp -rv', 'cp -ru', 'cp -f', 'cp -rf', 'cp -p', 'mv', 'mv -n', 'mv -T', 'mv -v', 'mv -f', 'mv -u', 'mv -nv'];

/** @returns {string[]} the command of each case (the script is FIXTURE and scriptOf) */
export function casesOf() {
	let seed = 5;
	const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
	const pick = (a) => a[Math.floor(rnd() * a.length)];
	const out = [];
	const seen = new Set();
	// every source against every destination for the three main verbs
	for (const v of ['cp -r', 'mv', 'cp']) { for (const s of SOURCES) { for (const d of DESTINATIONS) { const c = `${v} ${s} ${d}`; seen.add(c); out.push(c); } } }
	// a seeded sample of the other options, and of two sources
	for (let i = 0; i < 700; i++) {
		const v = pick(VERBS);
		const multi = rnd() < 0.2;
		const s = multi ? pick(SOURCES) + ' ' + pick(SOURCES) : pick(SOURCES);
		const c = `${v} ${s} ${pick(DESTINATIONS)}`;
		if (seen.has(c)) { continue; }
		seen.add(c);
		out.push(c);
	}
	// the same file, and a source that an earlier source of the same command took away, under -u and -n (the ones the
	// per-file paths of the engine decide, and the matrix above reaches only by luck of the seed)
	const SAME = ['f f', 'f ./f', 'f ./f e', 'f ../w/f e', 'e/one ./e/one e', 'f f e', 'f g e', 'd d', 'd d/sub', 'd/sub d/sub', 'f e/one', 'e/one f', 'd e', 'm e', 'f m e', 'g f e/'];
	for (const v of ['cp -u', 'cp -un', 'cp -rn', 'cp -ru', 'mv -u', 'mv -un', 'mv -nu', 'mv -uv']) {
		for (const a of SAME) {
			const c = `${v} ${a}`;
			if (seen.has(c)) { continue; }
			seen.add(c);
			out.push(c);
		}
	}
	return out;
}

/**
 * the script of one case: the command, its status, the listing it left, and what each file holds (every file of the tree
 * holds one line, so a copy that overwrote one, or a move that went to the wrong name, shows)
 */
export const scriptOf = (command) => `${command}; echo "rc=$?"; find . | sort; echo "--files"; find . -type f | sort | while IFS= read -r p; do printf '%s=%s\\n' "$p" "$(cat "$p")"; done`;
