/*---------------------------------------------------------------------------------------------
 *  Unit tests for extensions/levelcode-npp-pack/jsonBeautify.js  —  run: node test/jsonBeautify.test.js
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

const assert = require('assert');
const { analyzePaste, MAX_BYTES } = require('../jsonBeautify');

let n = 0;
function test(name, fn) { fn(); n++; console.log('  ok - ' + name); }

test('beautifies a minified object, and the result parses back to the same value', () => {
	const r = analyzePaste('{"a":1,"b":[2,3],"c":{"d":true}}');
	assert.strictEqual(r.beautify, true);
	assert.ok(r.output.includes('\n'), 'output should be multi-line');
	assert.deepStrictEqual(JSON.parse(r.output), { a: 1, b: [2, 3], c: { d: true } });
	assert.strictEqual(r.output, '{\n  "a": 1,\n  "b": [\n    2,\n    3\n  ],\n  "c": {\n    "d": true\n  }\n}');
});

test('beautifies a minified array', () => {
	assert.strictEqual(analyzePaste('[1,{"x":2}]').beautify, true);
});

test('leaves already-formatted (canonical 2-space) JSON alone — idempotent', () => {
	const once = analyzePaste('{"a":1,"b":2}').output;
	const twice = analyzePaste(once);
	assert.strictEqual(twice.beautify, false);
	assert.strictEqual(twice.reason, 'already-formatted');
});

test('ignores bare JSON scalars — a pasted number/string/bool must NOT be transformed', () => {
	for (const s of ['5', '3.14', '"hello"', 'true', 'false', 'null']) {
		assert.strictEqual(analyzePaste(s).beautify, false, s);
	}
});

test('ignores invalid JSON (unquoted key, trailing comma, JSONC)', () => {
	for (const s of ['{a:1}', '{"a":1,}', '{"a":1 /* c */}']) {
		const r = analyzePaste(s);
		assert.strictEqual(r.beautify, false, s);
		assert.strictEqual(r.reason, 'invalid-json', s);
	}
});

test('ignores a JSON value with trailing junk (whole blob must be JSON)', () => {
	const r = analyzePaste('{"a":1} and then some prose');
	assert.strictEqual(r.beautify, false);
	assert.strictEqual(r.reason, 'invalid-json');
});

test('ignores ordinary prose / code that is not JSON', () => {
	for (const s of ['hello world', 'const x = 1;', 'function f(){}', '']) {
		assert.strictEqual(analyzePaste(s).beautify, false, JSON.stringify(s));
	}
});

test('trims surrounding whitespace and beautifies the inner JSON', () => {
	const r = analyzePaste('\n\t  {"a":1}  \n');
	assert.strictEqual(r.beautify, true);
	assert.strictEqual(r.output, '{\n  "a": 1\n}');
});

test('respects a numeric indent and a tab indent', () => {
	assert.strictEqual(analyzePaste('{"a":1}', { indent: 4 }).output, '{\n    "a": 1\n}');
	assert.strictEqual(analyzePaste('{"a":1}', { indent: '\t' }).output, '{\n\t"a": 1\n}');
});

test('empty object / empty array are a no-op (already canonical)', () => {
	assert.strictEqual(analyzePaste('{}').beautify, false);
	assert.strictEqual(analyzePaste('[]').beautify, false);
});

test('rejects non-string input without throwing', () => {
	// @ts-expect-error — deliberately wrong types
	assert.strictEqual(analyzePaste(null).beautify, false);
	// @ts-expect-error
	assert.strictEqual(analyzePaste(42).beautify, false);
	// @ts-expect-error
	assert.strictEqual(analyzePaste(undefined).beautify, false);
});

test('honors the size guard (parses nothing past maxBytes)', () => {
	const r = analyzePaste('[1,2,3,4,5]', { maxBytes: 4 });
	assert.strictEqual(r.beautify, false);
	assert.strictEqual(r.reason, 'too-large');
	assert.ok(MAX_BYTES >= 1024 * 1024, 'default cap should be sizeable');
});

console.log('\njsonBeautify.js: ' + n + ' tests passed.');
