/*---------------------------------------------------------------------------------------------
 *  web/lib/fingerprint.mjs — run: node web/test/unit/fingerprint.test.js
 *
 *  A release is cached for a year under /_/<id>/. The id is a hash of what goes into it, so a changed file that the
 *  hash did not see is a stale file for a year. These tests are about what the hash sees.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createHash } = require('crypto');
const { pathToFileURL } = require('url');

let n = 0;
async function test(name, fn) { await fn(); n++; console.log('  ok - ' + name); }
const write = (root, rel, text) => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };

(async () => {
	const { hashTree } = await import(pathToFileURL(path.join(__dirname, '..', '..', 'lib', 'fingerprint.mjs')).href);
	const digest = (dir, opts) => hashTree(createHash('sha256'), dir, opts).digest('hex');
	const make = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-fp-')); write(d, 'a.js', 'A'); write(d, 'sub/b.json', '{"b":1}'); write(d, 'sub/deep/c.txt', 'C'); return d; };

	await test('the same files give the same hash, wherever they are and in whatever order they were written', () => {
		const one = make();
		const two = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-fp-'));
		write(two, 'sub/deep/c.txt', 'C'); write(two, 'sub/b.json', '{"b":1}'); write(two, 'a.js', 'A');
		assert.strictEqual(digest(one), digest(two));
	});
	await test('a changed byte in any file, at any depth, changes it', () => {
		const d = make();
		const before = digest(d);
		for (const rel of ['a.js', 'sub/b.json', 'sub/deep/c.txt']) {
			const original = fs.readFileSync(path.join(d, rel), 'utf8');
			fs.writeFileSync(path.join(d, rel), original + 'x');
			assert.notStrictEqual(digest(d), before, rel + ' was not seen');
			fs.writeFileSync(path.join(d, rel), original);
		}
		assert.strictEqual(digest(d), before);
	});
	await test('a new file, a removed file and a renamed file change it', () => {
		const d = make();
		const before = digest(d);
		write(d, 'new.js', '');
		assert.notStrictEqual(digest(d), before);
		fs.rmSync(path.join(d, 'new.js'));
		assert.strictEqual(digest(d), before);
		fs.renameSync(path.join(d, 'a.js'), path.join(d, 'z.js'));
		assert.notStrictEqual(digest(d), before, 'the same bytes under another name are another build');
	});
	await test('where the bytes end and the name begins cannot be confused', () => {
		const one = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-fp-')); write(one, 'ab', 'c');
		const two = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-fp-')); write(two, 'a', 'bc');
		assert.notStrictEqual(digest(one), digest(two));
	});
	await test('skipped names are left out wherever they are, and nothing else is', () => {
		const d = make();
		write(d, 'test/x.test.js', 't'); write(d, 'sub/node_modules/y.js', 'y');
		const without = digest(d, { skip: ['test', 'node_modules'] });
		write(d, 'test/x.test.js', 'changed'); write(d, 'sub/node_modules/y.js', 'changed');
		assert.strictEqual(digest(d, { skip: ['test', 'node_modules'] }), without);
		assert.notStrictEqual(digest(d), without);
	});
	console.log(`\n${n} tests passed`);
})().catch((e) => { console.error(e); process.exit(1); });
