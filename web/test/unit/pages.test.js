/*---------------------------------------------------------------------------------------------
 *  web/lib/pages.mjs — run: node web/test/unit/pages.test.js
 *
 *  How Cloudflare Pages answers for a release, as web/serve.mjs --pages answers: what wrangler uploads, the _redirects
 *  rules, the .html redirects and the page for anything else. And the release's own answer to the one that broke the
 *  terminal: every file of the client's node_modules, which Pages is never sent, is served from the copy it is sent.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

const assert = require('assert');
const path = require('path');
const { pathToFileURL } = require('url');

let n = 0;
async function test(name, fn) { await fn(); n++; console.log('  ok - ' + name); }

(async () => {
	const { uploaded, parseRedirects, matchRedirect, resolvePage, toRedirectsFile, NODE_MODULES_COPY } =
		await import(pathToFileURL(path.join(__dirname, '..', '..', 'lib', 'pages.mjs')).href);

	await test('what wrangler uploads: nothing in a folder named node_modules or .git, anywhere, and not its own files at the root', async () => {
		for (const rel of ['_/abc/static/node_modules/@xterm/xterm/lib/xterm.js', 'node_modules/x.js', '_/abc/extensions/x/node_modules/y.js',
			'_/abc/.git/HEAD', '_/abc/static/.DS_Store', '_headers', '_redirects', '_worker.js', '_routes.json', 'functions/api.js']) {
			assert.strictEqual(uploaded(rel), false, rel);
		}
		for (const rel of ['index.html', 'callback.html', '_/abc/static/node-modules/@xterm/xterm/lib/xterm.js', '_/abc/static/out/nls.messages.js',
			'_/abc/extensions/levelcode-ai/package.json', '_/abc/functions/x.js', '_/abc/static/node_modules_x/y.js']) {
			assert.strictEqual(uploaded(rel), true, rel);
		}
	});

	await test('_redirects: rules in order, comments and blank lines skipped, 302 when no status is given', async () => {
		const rules = parseRedirects('# a comment\n\n/old /new 301\n/a/:x/* /b/:x/:splat 200\n/plain /there\n');
		assert.deepStrictEqual(rules, [{ from: '/old', to: '/new', status: 301 }, { from: '/a/:x/*', to: '/b/:x/:splat', status: 200 }, { from: '/plain', to: '/there', status: 302 }]);
		assert.deepStrictEqual(matchRedirect(rules, '/a/one/two/three.js'), { to: '/b/one/two/three.js', status: 200 });
		assert.strictEqual(matchRedirect(rules, '/a/one'), null, 'a splat needs the slash before it');
		assert.deepStrictEqual(matchRedirect(parseRedirects('/x /first 200\n/x /second 200\n'), '/x'), { to: '/first', status: 200 }, 'the first match wins');
	});

	await test('the release\'s rule serves every node_modules file from the copy that was uploaded, in this build and in a kept one', async () => {
		const rules = parseRedirects(toRedirectsFile());
		for (const id of ['5bfb4df6caa1', 'ae34c91f6d37']) {
			for (const file of ['@xterm/xterm/lib/xterm.js', 'vscode-textmate/release/main.js', 'vscode-oniguruma/release/onig.wasm', '@vscode/codicons/dist/codicon.ttf']) {
				const asked = `/_/${id}/static/node_modules/${file}`;
				const r = matchRedirect(rules, asked);
				assert.ok(r && r.status === 200, asked + ' is rewritten, not redirected');
				assert.strictEqual(r.to, `/_/${id}/static/${NODE_MODULES_COPY}/${file}`);
				assert.ok(uploaded(r.to.slice(1)), r.to + ' is a path Pages is sent');
			}
		}
		assert.strictEqual(matchRedirect(rules, '/_/abc/static/out/vs/workbench/workbench.web.main.internal.js'), null, 'nothing else is rewritten');
		assert.strictEqual(matchRedirect(rules, '/_/abc/def/static/node_modules/x.js'), null, 'a build id is one segment');
	});

	await test('.html addresses: redirected without it; the address without it serves the page', async () => {
		const files = new Set(['index.html', 'callback.html', 'callback.js', '_/abc/static/out/x/frame.html', '_/abc/static/out/x/index.html']);
		const isFile = (rel) => files.has(rel);
		assert.deepStrictEqual(resolvePage('/', isFile), { file: 'index.html' });
		assert.deepStrictEqual(resolvePage('/index.html', isFile), { redirect: '/' });
		assert.deepStrictEqual(resolvePage('/callback.html', isFile), { redirect: '/callback' });
		assert.deepStrictEqual(resolvePage('/callback', isFile), { file: 'callback.html' });
		assert.deepStrictEqual(resolvePage('/callback.js', isFile), { file: 'callback.js' });
		assert.deepStrictEqual(resolvePage('/_/abc/static/out/x/frame.html', isFile), { redirect: '/_/abc/static/out/x/frame' });
		assert.deepStrictEqual(resolvePage('/_/abc/static/out/x/frame', isFile), { file: '_/abc/static/out/x/frame.html' });
		assert.deepStrictEqual(resolvePage('/_/abc/static/out/x/index.html', isFile), { redirect: '/_/abc/static/out/x/' });
		assert.deepStrictEqual(resolvePage('/_/abc/static/out/x/', isFile), { file: '_/abc/static/out/x/index.html' });
		assert.strictEqual(resolvePage('/missing.js', isFile), null, 'no such file: the caller answers with the page');
	});

	console.log(`\n${n} tests passed`);
})().catch((e) => { console.error(e); process.exit(1); });
