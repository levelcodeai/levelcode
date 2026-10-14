/*---------------------------------------------------------------------------------------------
 *  Searching file contents without ripgrep (LevelCode in a browser) — run: node web/test/unit/search-scope.test.js
 *
 *    scanSearch    extensions/levelcode-ai/agent.js       the agent's search tool, under one folder
 *    contentHits   extensions/levelcode-ai/extension.js   the chat's automatic context, under one folder
 *
 *  Both list files and then read them, with a cap on how many are listed. The cap has to be applied to the folder
 *  being searched: listed across the whole workspace first, another folder's files use it up and the folder asked
 *  about yields nothing. The functions are sliced out of the shipped files and run against a stand-in for the
 *  editor's file search that keeps the same promise as the real one: `max` results, of what the pattern asked for.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..', '..', 'extensions', 'levelcode-ai');
function extract(file, name) {
	const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
	let start = src.indexOf('function ' + name + '(');
	assert.ok(start >= 0, file + ' no longer defines ' + name + '()');
	const open = src.indexOf('{', start);
	if (src.slice(start - 6, start) === 'async ') { start -= 6; }
	let depth = 0, str = '', comment = '';
	for (let i = open; i < src.length; i++) {
		const ch = src[i], next = src[i + 1];
		if (comment === 'line') { if (ch === '\n') { comment = ''; } continue; }
		if (comment === 'block') { if (ch === '*' && next === '/') { comment = ''; i++; } continue; }
		if (str) { if (ch === '\\') { i++; } else if (ch === str) { str = ''; } continue; }
		if (ch === '/' && next === '/') { comment = 'line'; i++; continue; }
		if (ch === '/' && next === '*') { comment = 'block'; i++; continue; }
		if (ch === '"' || ch === "'" || ch === '`') { str = ch; continue; }
		if (ch === '{') { depth++; }
		else if (ch === '}' && --depth === 0) { return src.slice(start, i + 1); }
	}
	assert.fail('no end for ' + name);
}
const decl = (file, name) => {
	const m = new RegExp('^const ' + name + ' = [^\\n]*;', 'm').exec(fs.readFileSync(path.join(ROOT, file), 'utf8'));
	assert.ok(m, file + ' has no ' + name);
	return m[0];
};

let n = 0;
async function test(name, fn) { await fn(); n++; console.log('  ok - ' + name); }

// A two-folder workspace in the browser: a big one listed first, and the small one the search is about.
const files = new Map();
for (let i = 0; i < 2600; i++) { files.set('/big/src/file' + i + '.js', 'nothing to see ' + i); }
files.set('/app/src/needle.js', 'const PaymentRouter = 1;');
files.set('/app/README.md', 'routes payments');

class RelativePattern { constructor(base, pattern) { this.baseUri = base; this.pattern = pattern; } }
const asked = [];
const vscode = { RelativePattern };
const host = {
	caps: { ripgrep: false },
	uriFor: (abs) => ({ path: abs, scheme: 'levelcode-scratch' }),
	findFiles: async (glob, _exclude, max) => {
		asked.push(glob);
		const base = glob instanceof RelativePattern ? glob.baseUri.path.replace(/\/?$/, '/') : '/';
		return [...files.keys()].filter((p) => p.startsWith(base)).slice(0, max).map((p) => ({ path: p }));
	},
	stat: async (abs) => (files.has(abs) ? { isFile: true, isDirectory: false, size: files.get(abs).length } : null),
	readBytes: async (abs) => new TextEncoder().encode(files.get(abs)),
};

(async () => {
	// eslint-disable-next-line no-new-func
	const scanSearch = new Function('vscode', 'host', decl('agent.js', 'FILE_EXCLUDES') + '\n' + extract('agent.js', 'scanSearch') + '\nreturn scanSearch;')(vscode, host);
	// eslint-disable-next-line no-new-func
	const contentHits = new Function('vscode', 'host', 'rgFiles', extract('extension.js', 'contentHits') + '\nreturn contentHits;')(vscode, host, null);

	await test('the agent\'s search finds the match in the folder it was asked about, whatever the other folder holds', async () => {
		asked.length = 0;
		const out = await scanSearch('paymentrouter', '/app');
		assert.match(out, /^\.\/src\/needle\.js:1:const PaymentRouter = 1;$/m);
		assert.ok(asked[0] instanceof RelativePattern && asked[0].baseUri.path === '/app', 'the listing is asked for under the folder');
	});
	await test('the chat\'s context scan finds it too', async () => {
		asked.length = 0;
		const hits = await contentHits(['PaymentRouter', 'payments'], '/app');
		assert.deepStrictEqual(hits, [['/app/src/needle.js'], ['/app/README.md']]);
		assert.ok(asked[0] instanceof RelativePattern && asked[0].baseUri.path === '/app');
	});

	console.log(`\n${n} tests passed`);
})().catch((e) => { console.error(e); process.exit(1); });
