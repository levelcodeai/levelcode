/*---------------------------------------------------------------------------------------------
 *  Unit tests for verify.js's output sniffers — run: node test/verify.test.js
 *
 *  These read a background command's STDOUT, which is whatever a repo's dev script chose to print —
 *  i.e. untrusted text. One direction is load-bearing:
 *
 *    sniffPreviewUrl decides what the editor's built-in browser is pointed at, automatically. If it
 *    ever returns a REMOTE url, a hostile repo can navigate the user's editor anywhere just by logging
 *    a line. Every "remote" case below must return null (or the local url found elsewhere in the text).
 *    Erring toward opening nothing is always safe; erring toward opening is not.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

const assert = require('assert');
const { sniffPreviewUrl, sniffPort, looksReady } = require('../verify');

let n = 0;
function test(name, fn) { fn(); n++; console.log('  ok - ' + name); }

// ---- 1. the security bound: only LOCAL addresses may ever be opened ---------------------------

// Real-looking lines a hostile or merely misconfigured repo could print. None may be opened.
const REMOTE = [
	'Local:  http://evil.example.com:3000/',
	'  ➜  Network: https://attacker.test:8080/pwn',
	'Server started at http://169.254.169.254:80/latest/meta-data',   // cloud metadata endpoint
	'listening: http://10.0.0.5:3000',
	'open http://sub.domain.co.uk:4200 to view',
	'http://localhost.evil.com:3000',        // suffix trick — the host is NOT localhost
	'http://127.0.0.1.evil.com:3000'         // same trick with the loopback literal
];

test('SECURITY: a remote url in command output is never opened', () => {
	for (const line of REMOTE) {
		const got = sniffPreviewUrl(line);
		assert.ok(
			got === null || /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::|\/|$)/.test(got),
			'opened a non-local address from ' + JSON.stringify(line) + ' -> ' + JSON.stringify(got)
		);
	}
});

test('SECURITY: a local url still wins when a remote one is printed alongside it', () => {
	// Vite prints both; we must take the Local line and ignore Network, whatever its host.
	const out = sniffPreviewUrl('  ➜  Local:   http://localhost:5173/\n  ➜  Network: http://192.168.1.14:5173/');
	assert.strictEqual(out, 'http://localhost:5173/');
});

// ---- 2. finding the address the user actually wants -------------------------------------------

test('PREVIEW: prefers the full printed url, keeping scheme, port and base path', () => {
	assert.strictEqual(sniffPreviewUrl('  ➜  Local:   http://localhost:5173/'), 'http://localhost:5173/');
	assert.strictEqual(sniffPreviewUrl('ready - started server on http://localhost:3000/app'), 'http://localhost:3000/app');
	assert.strictEqual(sniffPreviewUrl('https://localhost:8443/'), 'https://localhost:8443/');
	assert.strictEqual(sniffPreviewUrl('running at http://127.0.0.1:4200'), 'http://127.0.0.1:4200');
});

test('PREVIEW: bind addresses are rewritten to something a browser can actually resolve', () => {
	// 0.0.0.0 / [::] mean "every interface", not a destination — opening them literally often fails.
	assert.strictEqual(sniffPreviewUrl('Listening on http://0.0.0.0:8000'), 'http://localhost:8000');
	assert.strictEqual(sniffPreviewUrl('serving on http://[::]:9000/'), 'http://localhost:9000/');
});

test('PREVIEW: falls back to localhost when only a port is announced', () => {
	// Plenty of servers never print a url — the Express boilerplate is exactly this line.
	assert.strictEqual(sniffPreviewUrl('Server running on port 3000'), 'http://localhost:3000');
	assert.strictEqual(sniffPreviewUrl('listening on :8080'), 'http://localhost:8080');
});

test('PREVIEW: silence when nothing resembles a server', () => {
	for (const quiet of ['', '   ', 'building...', 'Compiled 42 modules', 'error TS2304: cannot find name', null, undefined]) {
		assert.strictEqual(sniffPreviewUrl(quiet), null, JSON.stringify(quiet) + ' should not open anything');
	}
});

test('PREVIEW: garbage input returns null instead of throwing', () => {
	// This runs inside a stdout handler — a throw here would take down a live command stream.
	for (const junk of [{}, [], 42, true, Symbol.iterator.toString()]) {
		assert.doesNotThrow(() => sniffPreviewUrl(/** @type {any} */(junk)));
	}
});

// ---- 3. the sniffers the preview builds on (previously untested) ------------------------------

test('PORT: the most specific pattern wins, so later logs cannot masquerade as the server', () => {
	assert.strictEqual(sniffPort('http://localhost:5173/'), '5173');
	assert.strictEqual(sniffPort('Server running on port 3000'), '3000');
	assert.strictEqual(sniffPort('no port here'), null);
	// A url earlier in the text takes precedence over a bare "port N" mentioned later.
	assert.strictEqual(sniffPort('http://localhost:5173/ ... connected to db on port 5432'), '5173');
});

test('READY: recognises the common "it is up" lines, and nothing else', () => {
	for (const up of ['compiled successfully', 'Listening on :3000', 'server is running', 'ready in 412 ms', '  Local:  http://x']) {
		assert.strictEqual(looksReady(up), true, JSON.stringify(up));
	}
	for (const notUp of ['', 'building...', 'error: failed to compile']) {
		assert.strictEqual(looksReady(notUp), false, JSON.stringify(notUp));
	}
});

// ---- 4. source hygiene ------------------------------------------------------------------------

test('SOURCE: verify.js contains no raw control bytes', () => {
	// It shipped with a raw NUL in the diagKey separator, which made `file` report "data" and made grep
	// and diff skip the whole module in silence — you could not search your own source, and a reviewer
	// saw only "Binary file matches". The runtime value of an escape is identical, so nothing else
	// catches this. (Same defect was caught by review in the MCP modules.)
	const buf = require('fs').readFileSync(require('path').join(__dirname, '..', 'verify.js'));
	const bad = [];
	for (let i = 0; i < buf.length; i++) {
		const b = buf[i];
		if (b < 9 || (b > 13 && b < 32)) { bad.push(i); }
	}
	assert.deepStrictEqual(bad, [], 'raw control bytes at ' + bad.slice(0, 5).join(', ') + ' — use an escape');
});

console.log('\nverify.js: ' + n + ' tests passed.');
