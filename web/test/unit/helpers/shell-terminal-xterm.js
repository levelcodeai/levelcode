// Finds a real xterm.js (the headless build and the Unicode 11 addon) for the tests that can use one. Not a
// dependency: the repository does not carry it, the Code-OSS checkout does, so a test that wants the real thing asks
// here and says "SKIPPED" when it is not there. LEVELCODE_XTERM_DIR names the @xterm folder to use (and is then the
// only place looked in); LEVELCODE_REQUIRE_XTERM=1 turns a skip into a failure, which is what a CI that has the
// checkout must set, or it is green with the staleness guard and the editor differentials not run.
// @ts-check
'use strict';

const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..', '..', '..', '..');

/** @returns {{ Terminal: any, Unicode11Addon: any, addonFile: string, dir: string } | null} */
function findXterm() {
	const candidates = process.env.LEVELCODE_XTERM_DIR ? [process.env.LEVELCODE_XTERM_DIR] : [
		path.join(REPO, 'vscode', 'node_modules', '@xterm'),
		// a worktree lives in <checkout>/.claude/worktrees/<name>: the checkout's own vscode/ is three folders up
		path.join(REPO, '..', '..', '..', 'vscode', 'node_modules', '@xterm'),
	];
	for (const dir of /** @type {string[]} */ (candidates)) {
		try {
			const headless = path.join(dir, 'headless');
			const addonFile = path.join(dir, 'addon-unicode11', 'lib', 'addon-unicode11.js');
			if (!fs.existsSync(path.join(headless, 'package.json')) || !fs.existsSync(addonFile)) { continue; }
			const { Terminal } = require(headless);
			const { Unicode11Addon } = require(addonFile);
			return { Terminal, Unicode11Addon, addonFile, dir };
		} catch (e) { /* not usable on this Node: try the next */ }
	}
	return null;
}

/**
 * The real xterm.js for a test's real-xterm half, or null after saying loudly that the half did not run. Throws instead
 * when LEVELCODE_REQUIRE_XTERM=1.
 * @param {string} what  the half that wants it, for the message
 */
function needXterm(what) {
	const xt = findXterm();
	if (xt) { return xt; }
	if (process.env.LEVELCODE_REQUIRE_XTERM === '1') {
		throw new Error('LEVELCODE_REQUIRE_XTERM=1, and no xterm.js was found for: ' + what + ' (set LEVELCODE_XTERM_DIR=<checkout>/vscode/node_modules/@xterm)');
	}
	const msg = 'SKIPPED: the real-xterm half of "' + what + '" did not run, no xterm.js was found (LEVELCODE_XTERM_DIR=<checkout>/vscode/node_modules/@xterm; LEVELCODE_REQUIRE_XTERM=1 makes this a failure)';
	console.log('    ' + msg);
	console.log('::warning::' + msg);
	return null;
}

module.exports = { findXterm, needXterm };
