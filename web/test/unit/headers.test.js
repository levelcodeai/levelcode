/*---------------------------------------------------------------------------------------------
 *  web/lib/headers.mjs — run: node web/test/unit/headers.test.js
 *
 *  The host's half of a deployment: the same rules as `_headers` (Netlify, Cloudflare Pages) and as an nginx
 *  `server` block. nginx is not run here; these pin what the generated block tells it, in the cases where the
 *  difference is a site that answers 404 at its front door.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

const assert = require('assert');
const path = require('path');
const { pathToFileURL } = require('url');

let n = 0;
async function test(name, fn) { await fn(); n++; console.log('  ok - ' + name); }

/** The body of `location <match> { ... }` in an nginx block. */
const block = (conf, match) => {
	const at = conf.indexOf('  location ' + match + ' {');
	assert.ok(at >= 0, 'no `location ' + match + '`');
	return conf.slice(at, conf.indexOf('\n  }', at));
};

(async () => {
	const { policy, toNginx, toHeadersFile, headersFor } = await import(pathToFileURL(path.join(__dirname, '..', '..', 'lib', 'headers.mjs')).href);
	const p = policy({ account: 'https://levelcode.example', base: '/_' });
	const conf = toNginx(p);

	await test('nginx: the site\'s root serves the editor page — `try_files $uri` would look for a FILE named "/" and answer 404', async () => {
		const root = block(conf, '= /');
		assert.match(root, /try_files \/index\.html =404;/);
		assert.ok(!/try_files \$uri/.test(root));
		assert.match(root, /add_header Content-Security-Policy /, 'with the editor page\'s own headers');
	});
	await test('nginx: every other exact path is served as itself, and the build prefix by prefix', async () => {
		assert.match(block(conf, '= /index.html'), /try_files \$uri =404;/);
		assert.match(block(conf, '= /callback.html'), /try_files \$uri =404;/);
		assert.match(block(conf, '^~ /_/'), /try_files \$uri =404;/);
		assert.match(block(conf, '^~ /_/'), /immutable/);
		assert.match(conf, /location \/ \{ try_files \$uri \$uri\/ =404; \}/);
	});
	await test('the same rules for Netlify / Cloudflare: the root and index.html have the page\'s policy', async () => {
		const text = toHeadersFile(p);
		assert.match(text, /^\/\n {2}X-Content-Type-Options: nosniff/m);
		assert.strictEqual(headersFor(p, '/')['Content-Security-Policy'], headersFor(p, '/index.html')['Content-Security-Policy']);
	});

	await test('Cloudflare Pages: the sign-in page keeps its headers at /callback, where Pages serves callback.html', async () => {
		const { parseHeadersFile } = await import(pathToFileURL(path.join(__dirname, '..', '..', 'lib', 'headers.mjs')).href);
		const read = parseHeadersFile(toHeadersFile(p));
		const at = (address) => (read.rules.find((r) => r.path === address) || { headers: {} }).headers;
		assert.deepStrictEqual(at('/callback'), at('/callback.html'), 'the same rule under both addresses');
		assert.match(at('/callback')['Content-Security-Policy'] || '', /^default-src 'none'/);
		assert.strictEqual(at('/callback')['Cache-Control'], 'no-store');
		assert.ok(!read.rules.some((r) => r.path === '/index'), '/index.html is served at /, which has its own rule');
		assert.ok(!/location = \/callback \{/.test(conf), 'nginx serves callback.html as named and needs no second address');
	});

	console.log(`\n${n} tests passed`);
})().catch((e) => { console.error(e); process.exit(1); });
