// Finds a real xterm.js (the headless build and the Unicode 11 addon) for the tests that can use one. Not a
// dependency: the repository does not carry it, the Code-OSS checkout does, so a test that wants the real thing asks
// here and says "skipped" when it is not there. LEVELCODE_XTERM_DIR names the @xterm folder to use.
// @ts-check
'use strict';

const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..', '..', '..', '..');

/** @returns {{ Terminal: any, Unicode11Addon: any, addonFile: string, dir: string } | null} */
function findXterm() {
	const candidates = [
		process.env.LEVELCODE_XTERM_DIR,
		path.join(REPO, 'vscode', 'node_modules', '@xterm'),
		// a worktree lives in <checkout>/.claude/worktrees/<name>: the checkout's own vscode/ is three folders up
		path.join(REPO, '..', '..', '..', 'vscode', 'node_modules', '@xterm'),
	].filter(Boolean);
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

module.exports = { findXterm };
