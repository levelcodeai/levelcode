// The playbooks (extensions/levelcode-ai/skills/*/SKILL.md) as the browser build ships them.
//
// They were written for a machine with git, a test runner and a build: "run git diff", "npm test", "the suite is
// green". In a tab the shell is a simulated bash over the workspace's files, and a model that follows those steps
// literally either burns turns on commands that answer "not found" or — worse — ends with "all tests passing" for
// tests that never ran. One preamble at the top of each body says what is true here; the steps stay as written and
// the desktop's files are untouched (this is applied to the embedded copy, like copy.js and skin.js).
//
// Plain CommonJS; web/test/unit/skills.test.js pins it.
// @ts-check
'use strict';

const PREAMBLE = [
	'> **BROWSER EDITION.** The shell here is a simulated bash over the workspace files: no git, npm, node, python, pytest or any test runner,',
	'> and it cannot run your code. Where the steps below say to run git, tests, a linter, a build or a script: skip that step, do not try it, and do not',
	'> claim a result for it. Use read_file, search and the editor\'s diagnostics instead, and end your summary by saying which checks were not run and the',
	'> exact command the user can run on their own computer. Never write "passing", "green" or "builds" unless a command you ran in this shell, or the',
	'> editor\'s diagnostics, actually showed it.',
	'',
].join('\n');

const FRONT = /^---\r?\n[\s\S]*?\r?\n---\r?\n/;

/**
 * @param {string} rel path relative to extensions/levelcode-ai, forward slashes
 * @param {string} text
 * @returns {string}
 */
function browserSkill(rel, text) {
	if (!/^skills\/[^/]+\/SKILL\.md$/.test(rel)) { return text; }
	const m = FRONT.exec(text);
	// The front matter (name, description) is the skill's menu entry and must stay the first thing in the file.
	if (!m) { return PREAMBLE + '\n' + text; }
	return text.slice(0, m[0].length) + '\n' + PREAMBLE + text.slice(m[0].length);
}

module.exports = { browserSkill, PREAMBLE };
