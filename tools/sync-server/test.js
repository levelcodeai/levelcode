/*---------------------------------------------------------------------------------------------
 *  Round-trip test for the reference sync server  —  run: node test.js
 *  Exercises the REST contract the editor's built-in Settings Sync speaks, including the
 *  204/ETag-'0' empty-resource semantics and the clear()/delete-resource flows.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

const assert = require('assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atompp-sync-'));
process.env.DATA_DIR = DATA_DIR;
const { server } = require('./server');

const TOKEN = 'atmps_test.deadbeef';
const AUTH = { 'Authorization': 'Bearer ' + TOKEN };

/** @returns {Promise<{status:number, headers:any, body:string}>} */
function req(method, p, opts) {
	opts = opts || {};
	return new Promise((resolve, reject) => {
		const r = http.request({ host: '127.0.0.1', port: server.address().port, method, path: p, headers: opts.headers || {} }, (res) => {
			let body = '';
			res.on('data', (c) => { body += c; });
			res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
		});
		r.on('error', reject);
		if (opts.body !== undefined) { r.write(opts.body); }
		r.end();
	});
}

async function main() {
	await new Promise((res) => server.listen(0, res));
	let pass = 0;
	const ok = (name) => { pass++; console.log('  ok - ' + name); };
	let r, manifest;

	// auth required
	r = await req('GET', '/v1/manifest');
	assert.strictEqual(r.status, 401); ok('manifest requires a bearer token');

	// brand-new account → 204 (no session yet), not 200 with a session
	r = await req('GET', '/v1/manifest', { headers: AUTH });
	assert.strictEqual(r.status, 204); ok('brand-new account → manifest 204 (no session)');

	// never-written resource → 204 WITH ETag '0' (else the client throws NoRef)
	r = await req('GET', '/v1/resource/settings/latest', { headers: AUTH });
	assert.strictEqual(r.status, 204);
	assert.strictEqual(r.headers['etag'], '0'); ok('missing resource → 204 + ETag 0');

	// If-Match against a non-existent resource must 412 (compared to ref 0)
	r = await req('POST', '/v1/resource/tasks', { headers: Object.assign({ 'If-Match': '5' }, AUTH), body: 'x' });
	assert.strictEqual(r.status, 412); ok('If-Match on non-existent resource → 412');

	// first write (no If-Match) → 200 + ETag, and creates the session
	r = await req('POST', '/v1/resource/settings', { headers: AUTH, body: '{"a":1}' });
	assert.strictEqual(r.status, 200);
	const e1 = r.headers['etag'];
	assert.ok(e1, 'first write returns an ETag'); ok('first write accepted');

	// manifest now exists (200) with a session and the resource
	r = await req('GET', '/v1/manifest', { headers: AUTH });
	assert.strictEqual(r.status, 200);
	manifest = JSON.parse(r.body);
	assert.ok(manifest.session, 'manifest has a session after first write');
	assert.strictEqual(manifest.latest.settings, e1); ok('manifest appears after first write, lists the resource');

	// read it back
	r = await req('GET', '/v1/resource/settings/latest', { headers: AUTH });
	assert.strictEqual(r.body, '{"a":1}');
	assert.strictEqual(r.headers['etag'], e1); ok('read returns the written content + ETag');

	// If-None-Match current ref → 304
	r = await req('GET', '/v1/resource/settings/latest', { headers: Object.assign({ 'If-None-Match': e1 }, AUTH) });
	assert.strictEqual(r.status, 304); ok('If-None-Match current ref → 304');

	// stale write → 412
	r = await req('POST', '/v1/resource/settings', { headers: Object.assign({ 'If-Match': 'wrong' }, AUTH), body: 'x' });
	assert.strictEqual(r.status, 412); ok('stale If-Match → 412');

	// correct conditional write → 200 + new ETag
	r = await req('POST', '/v1/resource/settings', { headers: Object.assign({ 'If-Match': e1 }, AUTH), body: '{"a":2}' });
	assert.strictEqual(r.status, 200);
	const e2 = r.headers['etag'];
	assert.notStrictEqual(e2, e1); ok('conditional write bumps the ETag');

	r = await req('GET', '/v1/resource/settings/latest', { headers: AUTH });
	assert.strictEqual(r.body, '{"a":2}'); ok('latest reflects the newest write');

	// historical ref retrievable
	r = await req('GET', '/v1/resource/settings/' + e1, { headers: AUTH });
	assert.strictEqual(r.status, 200);
	assert.strictEqual(r.body, '{"a":1}'); ok('historical ref is retrievable');

	// collections (profiles): create → write a scoped resource → list → manifest → download
	r = await req('POST', '/v1/collection', { headers: AUTH });
	assert.strictEqual(r.status, 200);
	const cid = r.body.trim();
	assert.ok(cid, 'collection create returns an id'); ok('POST /v1/collection → id');

	r = await req('POST', '/v1/collection/nope/resource/globalState', { headers: AUTH, body: 'x' });
	assert.strictEqual(r.status, 404); ok('write to a non-existent collection → 404');

	r = await req('POST', '/v1/collection/' + cid + '/resource/globalState', { headers: AUTH, body: '{"g":1}' });
	assert.strictEqual(r.status, 200);
	const ce = r.headers['etag']; ok('write a collection-scoped resource → 200');

	r = await req('GET', '/v1/collection/' + cid + '/resource/globalState/latest', { headers: AUTH });
	assert.strictEqual(r.body, '{"g":1}'); ok('read a collection-scoped resource back');

	r = await req('GET', '/v1/collection', { headers: AUTH });
	assert.deepStrictEqual(JSON.parse(r.body), [{ id: cid }]); ok('GET /v1/collection lists the collection');

	r = await req('GET', '/v1/manifest', { headers: AUTH });
	manifest = JSON.parse(r.body);
	assert.strictEqual(manifest.collections[cid].latest.globalState, ce); ok('manifest includes the collection resource');

	r = await req('GET', '/v1/download/latest', { headers: AUTH });
	assert.strictEqual(r.status, 200);
	const dl = JSON.parse(r.body);
	assert.strictEqual(dl.resources.settings[0].content, '{"a":2}');
	assert.strictEqual(dl.collections[cid].resources.globalState[0].content, '{"g":1}'); ok('download/latest returns user + collection data');

	// DELETE /v1/resource/{type} → 200, then reads as empty (204 + ETag 0)
	r = await req('DELETE', '/v1/resource/settings', { headers: AUTH });
	assert.strictEqual(r.status, 200); ok('DELETE resource/{type} → 200');
	r = await req('GET', '/v1/resource/settings/latest', { headers: AUTH });
	assert.strictEqual(r.status, 204);
	assert.strictEqual(r.headers['etag'], '0'); ok('deleted resource reads empty (204 + ETag 0)');

	// DELETE /v1/resource (clear all) → 204, then manifest rotates back to 204 (session gone)
	r = await req('DELETE', '/v1/resource', { headers: AUTH });
	assert.strictEqual(r.status, 204); ok('DELETE /v1/resource (clear all) → 204');
	r = await req('GET', '/v1/manifest', { headers: AUTH });
	assert.strictEqual(r.status, 204); ok('after clear, manifest → 204 (session rotated)');

	r = await req('GET', '/v1/collection', { headers: AUTH });
	assert.deepStrictEqual(JSON.parse(r.body), []); ok('clear-all also wiped collections');

	// per-account isolation: a different token is a fresh (204) account
	r = await req('GET', '/v1/manifest', { headers: { 'Authorization': 'Bearer different.token' } });
	assert.strictEqual(r.status, 204); ok('storage is isolated per account/token');

	server.close();
	fs.rmSync(DATA_DIR, { recursive: true, force: true });
	console.log('\nsync-server: ' + pass + ' tests passed.');
}

main().catch((e) => { console.error(e); try { server.close(); } catch { } process.exit(1); });
