/*---------------------------------------------------------------------------------------------
 *  Round-trip test for the reference update-feed server  —  run: node test.js
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

const assert = require('assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const RELEASES_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'atompp-upd-')), 'releases.json');
fs.writeFileSync(RELEASES_FILE, JSON.stringify({
	'darwin-arm64': { stable: { commit: 'NEWSHA', productVersion: '0.2.0', url: 'https://cdn/Atom++-0.2.0-arm64.zip', sha256hash: 'abc', timestamp: 123 } }
}));
process.env.RELEASES_FILE = RELEASES_FILE;
const { server } = require('./server');

function req(p) {
	return new Promise((resolve, reject) => {
		http.get({ host: '127.0.0.1', port: server.address().port, path: p }, (res) => {
			let body = '';
			res.on('data', (c) => { body += c; });
			res.on('end', () => resolve({ status: res.statusCode, body }));
		}).on('error', reject);
	});
}

async function main() {
	await new Promise((res) => server.listen(0, res));
	let pass = 0;
	const ok = (name) => { pass++; console.log('  ok - ' + name); };

	// old commit → 200 with the release
	let r = await req('/api/update/darwin-arm64/stable/OLDSHA');
	assert.strictEqual(r.status, 200);
	const feed = JSON.parse(r.body);
	assert.strictEqual(feed.version, 'NEWSHA');
	assert.strictEqual(feed.productVersion, '0.2.0');
	assert.strictEqual(feed.url, 'https://cdn/Atom++-0.2.0-arm64.zip'); ok('old commit → 200 with the latest release');

	// already-latest commit → 204
	r = await req('/api/update/darwin-arm64/stable/NEWSHA');
	assert.strictEqual(r.status, 204); ok('latest commit → 204 (up to date)');

	// unknown target → 204 (nothing published)
	r = await req('/api/update/win32-x64/stable/OLDSHA');
	assert.strictEqual(r.status, 204); ok('unpublished target → 204');

	// unknown quality → 204
	r = await req('/api/update/darwin-arm64/insider/OLDSHA');
	assert.strictEqual(r.status, 204); ok('unpublished quality → 204');

	// health
	r = await req('/health');
	assert.strictEqual(r.status, 200); ok('health endpoint ok');

	// fallback: with no releases.json, the server uses the committed releases.example.json
	const savedRF = process.env.RELEASES_FILE;
	process.env.RELEASES_FILE = path.join(os.tmpdir(), 'atompp-missing-' + Date.now() + '.json');
	r = await req('/api/update/darwin-arm64/stable/ffffffffdifferentcommit');
	assert.strictEqual(r.status, 200); ok('falls back to releases.example.json when releases.json is absent');
	process.env.RELEASES_FILE = savedRF;

	server.close();
	fs.rmSync(path.dirname(RELEASES_FILE), { recursive: true, force: true });
	console.log('\nupdate-server: ' + pass + ' tests passed.');
}

main().catch((e) => { console.error(e); try { server.close(); } catch { } process.exit(1); });
