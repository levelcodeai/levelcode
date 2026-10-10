/*---------------------------------------------------------------------------------------------
 *  The browser build's copy replacements — run: node web/test/unit/copy.test.js
 *
 *  Every replacement must still find its desktop text in the real source (otherwise the browser
 *  build would quietly ship the old claim), and no replacement may say something the browser
 *  cannot stand behind.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { REPLACEMENTS, applyCopy } = require('../../ai-extension/copy.js');

const SRC = path.join(__dirname, '..', '..', '..', 'extensions', 'levelcode-ai');
let n = 0;
function test(name, fn) { fn(); n++; console.log('  ok - ' + name); }

test('every desktop string is still in the source it names', () => {
	for (const [file, from] of REPLACEMENTS) {
		const text = fs.readFileSync(path.join(SRC, file), 'utf8');
		assert.ok(text.includes(from), `${file} no longer contains: ${from}`);
	}
});
test('applying them changes the file and leaves no desktop-only claim about keys behind', () => {
	for (const file of new Set(REPLACEMENTS.map((r) => r[0]))) {
		const text = fs.readFileSync(path.join(SRC, file), 'utf8');
		const out = applyCopy(file, text);
		assert.notStrictEqual(out, text, file + ' came out unchanged');
		for (const [f, from] of REPLACEMENTS) { if (f === file) { assert.ok(!out.includes(from), 'still says: ' + from); } }
	}
});
test('a replacement whose desktop text has gone is an error, not a silent skip', () => {
	assert.throws(() => applyCopy('extension.js', 'nothing relevant here'), /no longer in extension\.js/);
});
test('the browser text claims only what the browser build does', () => {
	for (const [, , to] of REPLACEMENTS) {
		assert.ok(!/keychain|your machine|OS\b/i.test(to), 'the browser text still talks like the desktop: ' + to);
		assert.ok(!/hackable/i.test(to));
	}
});

console.log(`\n${n} tests passed`);
