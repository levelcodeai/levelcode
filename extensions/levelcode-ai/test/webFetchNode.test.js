/*---------------------------------------------------------------------------------------------
 *  Reading a web page from the desktop — run: node test/webFetchNode.test.js
 *
 *  webFetchNode.js opens the pages the agent found, from this machine, and must never open one on this machine or
 *  its network. The guard is exercised with addresses alone; the reading (compression, redirects, character sets,
 *  the size cap, the deadline) against a real HTTP server on 127.0.0.1, which only `allowPrivate` — a test's switch
 *  that the extension never sets — lets it reach.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

const assert = require('assert');
const http = require('http');
const zlib = require('zlib');
const { fetchPage, isPrivateAddress } = require('../webFetchNode');

let n = 0;
const queue = [];
function test(name, fn) { queue.push([name, fn]); }

test('GUARD: loopback, private, link-local, carrier-grade, multicast, reserved and mapped addresses are refused; public ones are not', () => {
	const refused = ['127.0.0.1', '127.255.255.254', '10.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0',
		'224.0.0.251', '240.0.0.1', '255.255.255.255', '198.18.0.1', '192.0.2.10', '::', '::1', '[::1]', 'fe80::1%en0', 'fd00::1', 'fc00::1', 'ff02::1',
		'::ffff:127.0.0.1', '::ffff:10.0.0.1', '64:ff9b::a00:1', '2001:db8::1', 'not-an-address'];
	for (const a of refused) { assert.strictEqual(isPrivateAddress(a), true, a); }
	for (const a of ['8.8.8.8', '1.1.1.1', '104.16.132.229', '172.32.0.1', '172.15.255.255', '100.128.0.1', '2606:4700::6810:84e5', '2a00:1450:4001::200e', '::ffff:8.8.8.8']) {
		assert.strictEqual(isPrivateAddress(a), false, a);
	}
});

test('GUARD: a page on this machine is refused before any connection — by name, by IP, and by IP spelled as a number', async () => {
	let hits = 0;
	const srv = http.createServer((req, res) => { hits++; res.end('secret'); });
	await new Promise((r) => srv.listen(0, '127.0.0.1', r));
	const port = /** @type {any} */ (srv.address()).port;
	try {
		for (const u of ['http://localhost:' + port + '/', 'http://127.0.0.1:' + port + '/', 'http://2130706433:' + port + '/', 'http://0x7f000001:' + port + '/', 'http://[::1]:' + port + '/', 'http://169.254.169.254/latest/meta-data']) {
			await assert.rejects(fetchPage(u, { timeoutMs: 3000 }), /** @param {any} e */ (e) => e.code === 'EBLOCKED' && /private or local network/.test(e.message));
		}
		assert.strictEqual(hits, 0, 'nothing reached the server');
		await assert.rejects(fetchPage('ftp://example.org/x', { timeoutMs: 1000 }), /only http and https/);
	} finally { srv.close(); }
});

/** A local server for the reading tests: each path is one behaviour. */
function server() {
	return http.createServer((req, res) => {
		const u = new URL(req.url || '/', 'http://x');
		if (u.pathname === '/gzip') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-encoding': 'gzip' }); res.end(zlib.gzipSync('<title>Zipped</title><p>Grüße aus Kyiv</p>')); return; }
		if (u.pathname === '/br') { res.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'br' }); res.end(zlib.brotliCompressSync('brotli body')); return; }
		if (u.pathname === '/latin1') { res.writeHead(200, { 'content-type': 'text/plain; charset=ISO-8859-1' }); res.end(Buffer.from([0x63, 0x61, 0x66, 0xe9])); return; }
		if (u.pathname.startsWith('/hop')) { const k = Number(u.pathname.slice(4) || 0); res.writeHead(302, { location: k >= 6 ? '/end' : '/hop' + (k + 1) }); res.end(); return; }
		if (u.pathname === '/redirect') { res.writeHead(301, { location: '/end?from=redirect' }); res.end(); return; }
		if (u.pathname === '/end') { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<p>the end ' + (u.searchParams.get('from') || '') + '</p>'); return; }
		if (u.pathname === '/big') { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('x'.repeat(300000)); return; }
		if (u.pathname === '/slow') { res.writeHead(200, { 'content-type': 'text/plain' }); res.write('start'); return; /* never ends */ }
		if (u.pathname === '/ua') { res.writeHead(200, { 'content-type': 'text/plain' }); res.end(String(req.headers['user-agent'])); return; }
		res.writeHead(404, { 'content-type': 'text/html' }); res.end('<p>missing</p>');
	});
}

test('READ: gzip and brotli are decoded, the charset is honoured, the status and type come back', async () => {
	const srv = server(); await new Promise((r) => srv.listen(0, '127.0.0.1', r));
	const base = 'http://127.0.0.1:' + /** @type {any} */ (srv.address()).port;
	const o = { timeoutMs: 3000, allowPrivate: true };
	try {
		const g = await fetchPage(base + '/gzip', o);
		assert.deepStrictEqual([g.status, g.contentType, g.body, g.truncated], [200, 'text/html; charset=utf-8', '<title>Zipped</title><p>Grüße aus Kyiv</p>', false]);
		assert.strictEqual((await fetchPage(base + '/br', o)).body, 'brotli body');
		assert.strictEqual((await fetchPage(base + '/latin1', o)).body, 'café');
		assert.strictEqual((await fetchPage(base + '/nope', o)).status, 404);
		assert.match((await fetchPage(base + '/ua', o)).body, /LevelCode/, 'it says who it is');
	} finally { srv.close(); }
});

test('READ: redirects are followed (the final address comes back), four at most; the body is cut at the size cap; the deadline holds', async () => {
	const srv = server(); await new Promise((r) => srv.listen(0, '127.0.0.1', r));
	const base = 'http://127.0.0.1:' + /** @type {any} */ (srv.address()).port;
	const o = { timeoutMs: 3000, allowPrivate: true };
	try {
		const r = await fetchPage(base + '/redirect', o);
		assert.strictEqual(r.finalUrl, base + '/end?from=redirect');
		assert.match(r.body, /the end redirect/);
		assert.strictEqual((await fetchPage(base + '/hop3', o)).finalUrl, base + '/end', 'three more hops is within the limit');
		await assert.rejects(fetchPage(base + '/hop0', o), /too many redirects/);
		const big = await fetchPage(base + '/big', Object.assign({}, o, { maxBytes: 1000 }));
		assert.deepStrictEqual([big.body.length, big.truncated], [1000, true]);
		const t0 = Date.now();
		await assert.rejects(fetchPage(base + '/slow', Object.assign({}, o, { timeoutMs: 300 })), /timed out/);
		assert.ok(Date.now() - t0 < 2000, 'stopped at the deadline');
		const ac = new AbortController();
		const p = fetchPage(base + '/slow', Object.assign({}, o, { signal: ac.signal }));
		setTimeout(() => ac.abort(), 50);
		await assert.rejects(p, /stopped/);
	} finally { srv.close(); }
});

(async () => {
	for (const [name, fn] of queue) { await fn(); n++; console.log('  ok - ' + name); }
	console.log('\nwebFetchNode: ' + n + ' tests passed.');
})().catch((e) => { console.error(e); process.exit(1); });
