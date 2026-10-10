/*---------------------------------------------------------------------------------------------
 *  web/lib/extensions.mjs — run: node web/test/unit/extensions.test.js
 *
 *  Which of Code-OSS's extensions the browser edition carries, how they are staged, and what the build id is made
 *  of for them. The id must see exactly what is staged: a grammar that changed and an id that did not is a stale
 *  file for a year under an immutable prefix.
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
	const lib = path.join(__dirname, '..', '..', 'lib');
	const { declarativeExtensionNames, stageDeclarativeExtensions, copyExtension, COPY_SKIP } = await import(pathToFileURL(path.join(lib, 'extensions.mjs')).href);
	const { hashTree } = await import(pathToFileURL(path.join(lib, 'fingerprint.mjs')).href);

	const checkout = () => {
		const d = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-ext-'));
		write(d, 'json/package.json', JSON.stringify({ name: 'json', contributes: { grammars: [{ language: 'json' }] } }));
		write(d, 'json/syntaxes/json.tmLanguage.json', '{}');
		write(d, 'json/test/fixture.json', '{}');
		write(d, 'json/package.nls.de.json', '{}');
		write(d, 'themes/package.json', JSON.stringify({ name: 'themes', contributes: { themes: [{ label: 'T' }] } }));
		write(d, 'typescript-language-features/package.json', JSON.stringify({ name: 'ts', main: './out/extension', browser: './dist/browser/extension' }));
		write(d, 'debuggy/package.json', JSON.stringify({ name: 'debuggy', contributes: { debuggers: [{ type: 'x' }] } }));
		write(d, 'copilot/package.json', JSON.stringify({ name: 'copilot', contributes: {} }));
		write(d, 'baked/package.json', JSON.stringify({ name: 'baked', contributes: {} }));
		write(d, 'not-an-extension/readme.txt', 'x');
		write(d, 'broken/package.json', '{ nope');
		return d;
	};

	await test('the declarative extensions are the ones with no code, not dev-only, not already baked in', () => {
		const d = checkout();
		try {
			assert.deepStrictEqual(declarativeExtensionNames(d, ['baked']), ['json', 'themes']);
			assert.deepStrictEqual(declarativeExtensionNames(d), ['baked', 'json', 'themes']);
		} finally { fs.rmSync(d, { recursive: true, force: true }); }
	});

	await test('staging copies exactly those, without tests and translations, and answers with the same names', () => {
		const d = checkout();
		const out = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-ext-out-'));
		try {
			const staged = stageDeclarativeExtensions(d, out, { exclude: ['baked'] });
			assert.deepStrictEqual(staged, declarativeExtensionNames(d, ['baked']));
			assert.deepStrictEqual(fs.readdirSync(out).sort(), ['json', 'themes']);
			assert.ok(fs.existsSync(path.join(out, 'json', 'syntaxes', 'json.tmLanguage.json')));
			assert.ok(!fs.existsSync(path.join(out, 'json', 'test')));
			assert.ok(!fs.existsSync(path.join(out, 'json', 'package.nls.de.json')));
			assert.ok(fs.existsSync(path.join(out, 'themes', 'package.nls.json')), 'the workbench asks every extension for one');
		} finally { fs.rmSync(d, { recursive: true, force: true }); fs.rmSync(out, { recursive: true, force: true }); }
	});

	await test('the build id sees a changed grammar, a new extension and a removed one — and not a test file', () => {
		const d = checkout();
		const id = () => {
			const h = createHash('sha256');
			for (const name of declarativeExtensionNames(d, ['baked'])) { h.update('\0ext\0' + name); hashTree(h, path.join(d, name), { skip: [...COPY_SKIP, '.DS_Store'] }); }
			return h.digest('hex');
		};
		try {
			const base = id();
			write(d, 'json/syntaxes/json.tmLanguage.json', '{"changed":true}');
			const changed = id();
			assert.notStrictEqual(changed, base, 'a grammar');
			write(d, 'extra/package.json', JSON.stringify({ name: 'extra', contributes: {} }));
			const added = id();
			assert.notStrictEqual(added, changed, 'a new extension');
			fs.rmSync(path.join(d, 'extra'), { recursive: true });
			assert.strictEqual(id(), changed, 'and back');
			write(d, 'json/test/fixture.json', '{"more":1}');
			assert.strictEqual(id(), changed, 'a test file is not staged, so it is not part of the build');
		} finally { fs.rmSync(d, { recursive: true, force: true }); }
	});

	await test('what the id skips is what the copy skips', () => {
		for (const name of ['node_modules', 'test', 'src', '.git']) { assert.ok(COPY_SKIP.includes(name), name); }
		const d = checkout();
		const out = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-ext-out-'));
		try {
			write(d, 'json/node_modules/x/index.js', 'x');
			copyExtension(path.join(d, 'json'), path.join(out, 'json'));
			assert.ok(!fs.existsSync(path.join(out, 'json', 'node_modules')));
		} finally { fs.rmSync(d, { recursive: true, force: true }); fs.rmSync(out, { recursive: true, force: true }); }
	});

	console.log(`\n${n} tests passed`);
})().catch((e) => { console.error(e); process.exit(1); });
