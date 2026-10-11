// A plain-assert suite whose test awaits something that never settles leaves nothing to keep the process alive:
// node exits with status 0 and no output, and the gate calls it green. This makes that a failure.
//
// `require` it at the top of a suite. At exit it looks for the line every suite of this style ends with
// ("N tests passed"); a process that exits 0 without having printed one did not finish its tests.
// @ts-check
'use strict';

let finished = false;
const log = console.log;
console.log = (/** @type {any[]} */ ...args) => {
	if (args.length && /\b\d+ tests? passed\b/.test(String(args[0]))) { finished = true; }
	return log.apply(console, /** @type {any} */ (args));
};

process.on('exit', (code) => {
	if (code === 0 && !finished) {
		console.error('not ok - the suite exited without finishing: a test waits for something that never happens');
		process.exitCode = 1;
	}
});
