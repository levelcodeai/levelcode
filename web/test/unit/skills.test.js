/*---------------------------------------------------------------------------------------------
 *  The playbooks in the browser build — run: node web/test/unit/skills.test.js
 *
 *  Each SKILL.md gets one preamble that says what is true in a tab; the desktop's files are never edited.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { browserSkill, PREAMBLE } = require('../../ai-extension/skills.js');

const SKILLS = path.join(__dirname, '..', '..', '..', 'extensions', 'levelcode-ai', 'skills');
let n = 0;
function test(name, fn) { fn(); n++; console.log('  ok - ' + name); }

const names = fs.readdirSync(SKILLS).filter((d) => fs.existsSync(path.join(SKILLS, d, 'SKILL.md')));

test('there are skills to treat, and each keeps its front matter as the first lines (that is the menu entry)', () => {
	assert.ok(names.length >= 3);
	for (const name of names) {
		const src = fs.readFileSync(path.join(SKILLS, name, 'SKILL.md'), 'utf8');
		const out = browserSkill('skills/' + name + '/SKILL.md', src);
		const front = /^---\r?\n[\s\S]*?\r?\n---\r?\n/.exec(src)[0];
		assert.ok(out.startsWith(front), name + ': the front matter moved');
		assert.ok(out.includes(PREAMBLE), name + ': no preamble');
		assert.strictEqual(out.split(PREAMBLE).length - 1, 1, name + ': more than one preamble');
		assert.ok(out.endsWith(src.slice(front.length)), name + ': the steps changed');
	}
});

test('the preamble forbids claiming a result that never ran, and names what is missing', () => {
	const flat = PREAMBLE.replace(/\n> /g, ' ');
	for (const word of ['git', 'npm', 'node', 'python', 'test runner', 'do not claim a result', 'Never write "passing"']) {
		assert.ok(flat.includes(word), 'the preamble does not say: ' + word);
	}
	assert.ok(!/hackable/i.test(PREAMBLE));
});

test('only SKILL.md bodies are touched; a text without front matter gets the preamble on top', () => {
	assert.strictEqual(browserSkill('media/chat.html', 'x'), 'x');
	assert.strictEqual(browserSkill('skills/a/README.md', 'x'), 'x');
	assert.ok(browserSkill('skills/a/SKILL.md', 'no front matter').startsWith(PREAMBLE));
});

test('the desktop sources are not modified by it', () => {
	for (const name of names) {
		const src = fs.readFileSync(path.join(SKILLS, name, 'SKILL.md'), 'utf8');
		assert.ok(!src.includes('BROWSER EDITION'), name);
	}
});

console.log(`\n${n} tests passed`);
