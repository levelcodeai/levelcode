// The xargs command lines of limits.json (recorded) and shell-engine-xargs.test.js (replayed). Deterministic.
//
// A command line is `printf INPUT | xargs MODE -s S BASE` for S = 1..LIMIT: the sizes at which GNU xargs changes what it
// does are the ones a small -s makes visible (the argument that does not fit, the command that cannot fit, a line that is
// too long, the list that is too long). -s 1..30 against words of 1 to 9 bytes puts every one of them on a boundary.
//
// What this pins that nothing else does: that the same size is measured the same way for -I (the command word is never
// replaced, a line is measured against the limit less the command once a command is waiting) and for -n/-L/-x.

export const LIMIT = 30;

/** printf formats of the input: one item, two items, three, and none. */
export const INPUTS = [
	'', 'a\\n', 'aaaa\\n', 'a a\\n', 'aaaa aaaa\\n',
	...['a', 'aa', 'aaaa'].flatMap((x) => ['a', 'aaa', 'aaaaaa'].map((y) => `${x}\\n${y}\\n`)),
	'a\\nb\\naaaaaa\\n', 'a\\naaaa\\nb\\n', 'a\\nb\\nc\\nd\\ne\\nf\\n',
];

/** [mode, the words after it]: -I with a replace string, and the plain forms that measure the same line */
export const REPLACE_BASES = ['echo {}', 'echo X{}Y', 'echo {} {}', 'echo {} zzzzzzzz', 'echo zzzzzzzz {}', 'echo {}{}', 'echo', '{} x', 'echo q {} r', 'echo q {}', 'echo {} q', 'echo X{} zzzz', 'echo q'];
export const PLAIN_MODES = ['', '-L1', '-L2', '-n1', '-n2', '-n1 -x', '-n2 -x'];

/**
 * Input with a quote that is never closed (GNU runs what was complete before it, and says so), with no -s.
 * Written with `\047` for the quote, which printf makes.
 */
export const QUOTE_INPUTS = [
	"a b \\047c\\n", "a\\nb \\047c\\nd\\n", "a\\n\"b c\\n", "a b c d\\ne \\047f\\n", "\\047a\\n", "a b\\nc d\\ne \\047f g\\n",
];
export const QUOTE_OPTIONS = ['', '-n1', '-n2', '-n3', '-n1 -x', '-n2 -x', '-n3 -x', '-L1', '-L2', '-L3', '-I{}', '-I{} -x'];

/** @returns {Array<{ input: string, options: string, command: string, sized: boolean }>} */
export function groups() {
	const out = [];
	for (const input of INPUTS) {
		for (const b of REPLACE_BASES) { out.push({ input, options: '-I{}', command: b, sized: true }); }
		for (const m of PLAIN_MODES) { out.push({ input, options: m, command: 'echo', sized: true }); }
	}
	for (const input of QUOTE_INPUTS) {
		for (const m of QUOTE_OPTIONS) { out.push({ input, options: m, command: m.startsWith('-I') ? 'echo X{}' : 'echo', sized: false }); }
	}
	return out;
}

/** The sizes a group is run at: -s 1..LIMIT, or once with no -s. */
export function sizesOf(g) {
	return g.sized ? Array.from({ length: LIMIT }, (_x, i) => i + 1) : [0];
}

/** The command line of one group at one size (0: no -s). */
export function lineOf(g, s) {
	return `printf '${g.input}' | xargs ${g.options ? g.options + ' ' : ''}${s ? `-s ${s} ` : ''}${g.command}`;
}
