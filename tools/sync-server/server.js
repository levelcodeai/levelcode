/*---------------------------------------------------------------------------------------------
 *  Atom++ — reference Settings Sync server
 *
 *  A tiny, dependency-free implementation of the Code-OSS user-data-sync REST contract
 *  (the same protocol the editor's built-in Settings Sync speaks). Use it to:
 *    • develop/test Atom++ Sync end-to-end with no cloud backend, and
 *    • self-host the FREE sync tier (BYO storage).
 *  Atom++ Cloud (thin.ly) implements the same contract for managed Pro sync.
 *
 *  Storage is file-backed and isolated per bearer token (account). Bodies are opaque text —
 *  the server never parses settings, so client-side E2E encryption is trivial to add later.
 *  Supports user-scoped resources AND profile collections (/v1/collection/{id}/resource/...).
 *
 *  Run:  PORT=9595 DATA_DIR=./.data node server.js
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = parseInt(process.env.PORT || '9595', 10);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '.data');
const LOG = require.main === module; // log requests only when run as a server (quiet under tests)

function shortHash(s) { return crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 16); }
function accountDir(token) { return path.join(DATA_DIR, shortHash(token)); }
function ensureDir(d) { fs.mkdirSync(d, { recursive: true }); }

/** Read the persisted session id for an account, or null (none until the first write). */
function getSession(acct) {
	try { return fs.readFileSync(path.join(acct, 'session'), 'utf8') || null; } catch { return null; }
}

/** Ensure a session id exists (created at first write, rotated by clear()); returns it. */
function ensureSession(acct) {
	let s = getSession(acct);
	if (!s) {
		s = crypto.randomBytes(8).toString('hex');
		ensureDir(acct);
		fs.writeFileSync(path.join(acct, 'session'), s, 'utf8');
	}
	return s;
}

// Resources live under a BASE dir: the account root (user resources) or a collection dir.

/** Read a resource's {ref, content} under `base`, or null. */
function readResource(base, type) {
	try { return JSON.parse(fs.readFileSync(path.join(base, 'resource', type + '.json'), 'utf8')); } catch { return null; }
}

/** Write a resource under `base`, bumping its ref. Returns the new ref (string). */
function writeResource(base, type, content) {
	const prev = readResource(base, type);
	const nextRef = String((prev ? parseInt(prev.ref, 10) : 0) + 1);
	ensureDir(path.join(base, 'resource'));
	fs.writeFileSync(path.join(base, 'resource', type + '.json'), JSON.stringify({ ref: nextRef, content }), 'utf8');
	// keep history so GET /resource/:type/:ref works (a self-host superset of the core contract)
	ensureDir(path.join(base, 'history', type));
	fs.writeFileSync(path.join(base, 'history', type, nextRef), content, 'utf8');
	return nextRef;
}

function deleteResource(base, type) {
	fs.rmSync(path.join(base, 'resource', type + '.json'), { force: true });
	fs.rmSync(path.join(base, 'history', type), { recursive: true, force: true });
}

/** Map of {type: ref} for every resource currently stored under `base`. */
function latestOf(base) {
	const out = {};
	const rdir = path.join(base, 'resource');
	if (fs.existsSync(rdir)) {
		for (const f of fs.readdirSync(rdir)) {
			if (!f.endsWith('.json')) { continue; }
			const t = f.slice(0, -5);
			const r = readResource(base, t);
			if (r) { out[t] = r.ref; }
		}
	}
	return out;
}

function collectionsDir(acct) { return path.join(acct, 'collections'); }
function collectionDir(acct, id) { return path.join(collectionsDir(acct), id); }

function listCollections(acct) {
	try { return fs.readdirSync(collectionsDir(acct)).filter(id => fs.statSync(collectionDir(acct, id)).isDirectory()); }
	catch { return []; }
}

/** Build the manifest for an account, or null if it has never been written (→ 204). */
function buildManifest(acct) {
	const session = getSession(acct);
	if (!session) { return null; }
	const latest = latestOf(acct);
	const collections = {};
	for (const id of listCollections(acct)) { collections[id] = { latest: latestOf(collectionDir(acct, id)) }; }
	const ref = shortHash(session + ':' + JSON.stringify(latest) + ':' + JSON.stringify(collections));
	return { session, ref, latest, collections };
}

/** Build the bulk "download all" payload (IDownloadLatestDataType shape). */
function buildDownload(acct) {
	const dump = (base) => {
		const resources = {};
		for (const t of Object.keys(latestOf(base))) {
			const r = readResource(base, t);
			if (r) { resources[t] = [{ ref: r.ref, content: r.content }]; }
		}
		return resources;
	};
	const collections = {};
	for (const id of listCollections(acct)) { collections[id] = { resources: dump(collectionDir(acct, id)) }; }
	return { resources: dump(acct), collections };
}

function send(res, status, body, headers) {
	res.writeHead(status, Object.assign({ 'Cache-Control': 'no-store' }, headers || {}));
	res.end(body);
}

function readBody(req) {
	return new Promise((resolve) => {
		let data = '';
		req.on('data', (c) => { data += c; });
		req.on('end', () => resolve(data));
	});
}

/** GET a resource under `base`: ref='latest' → current (204+ETag '0' if none); else a historical ref. */
function resourceGet(req, res, base, type, ref) {
	if (ref === 'latest') {
		const rec = readResource(base, type);
		if (!rec) { return send(res, 204, '', { 'ETag': '0' }); }
		const inm = req.headers['if-none-match'];
		if (inm && inm === rec.ref) { return send(res, 304, '', { 'ETag': rec.ref }); }
		return send(res, 200, rec.content, { 'Content-Type': 'text/plain', 'ETag': rec.ref });
	}
	try { return send(res, 200, fs.readFileSync(path.join(base, 'history', type, ref), 'utf8'), { 'Content-Type': 'text/plain', 'ETag': ref }); }
	catch { return send(res, 404, 'No such ref'); }
}

/** POST a resource under `base` with If-Match optimistic concurrency ('0' = non-existing ref). */
async function resourcePost(req, res, base, type) {
	const prev = readResource(base, type);
	const cur = prev ? prev.ref : '0';
	const ifMatch = req.headers['if-match'];
	if (ifMatch !== undefined && ifMatch !== '*' && ifMatch !== cur) {
		return send(res, 412, 'Precondition Failed', { 'ETag': cur });
	}
	const content = await readBody(req);
	return send(res, 200, '', { 'ETag': writeResource(base, type, content) });
}

const server = http.createServer(async (req, res) => {
	if (LOG) {
		res.on('finish', () => {
			const u = req.url || '';
			if (u !== '/' && u !== '/health') { // log everything (incl. misdirected /api/update → 404)
				console.log('[sync] ' + (req.method || 'GET') + ' ' + u + ' → ' + res.statusCode);
			}
		});
	}
	const url = (req.url || '').split('?')[0];
	const method = req.method || 'GET';

	if (url === '/' || url === '/health') {
		return send(res, 200, 'Atom++ reference sync server\n', { 'Content-Type': 'text/plain' });
	}

	const auth = req.headers['authorization'] || '';
	const tok = /^Bearer\s+(.+)$/i.exec(String(auth));
	if (!url.startsWith('/v1')) { return send(res, 404, 'Not found'); }
	if (!tok) { return send(res, 401, 'Missing bearer token'); }
	const acct = accountDir(tok[1]);

	// GET /v1/manifest  (204 with no body until the first write creates a session)
	if (url === '/v1/manifest' && method === 'GET') {
		const manifest = buildManifest(acct);
		if (!manifest) { return send(res, 204, '', { 'ETag': '0' }); }
		const inm = req.headers['if-none-match'];
		if (inm && inm === manifest.ref) { return send(res, 304, ''); }
		return send(res, 200, JSON.stringify(manifest), { 'Content-Type': 'application/json', 'ETag': manifest.ref });
	}

	// GET /v1/download/latest  (bulk snapshot; 204 before any data)
	if (url === '/v1/download/latest' && method === 'GET') {
		if (!getSession(acct)) { return send(res, 204, ''); }
		return send(res, 200, JSON.stringify(buildDownload(acct)), { 'Content-Type': 'application/json' });
	}

	// Collection-scoped resource: /v1/collection/{cid}/resource/{type}[/{ref}]
	let m = /^\/v1\/collection\/([^/]+)\/resource\/([^/]+)(?:\/([^/]+))?$/.exec(url);
	if (m) {
		const base = collectionDir(acct, m[1]);
		if (!fs.existsSync(base)) { return send(res, 404, 'No such collection'); }
		if (method === 'GET' && m[3]) { return resourceGet(req, res, base, m[2], m[3]); }
		if (method === 'POST' && !m[3]) { ensureSession(acct); return resourcePost(req, res, base, m[2]); }
		if (method === 'DELETE') { deleteResource(base, m[2]); return send(res, 200, ''); }
		return send(res, 404, 'Not found');
	}

	// Collections (user-data profiles): list / create / delete
	if (url === '/v1/collection' && method === 'GET') {
		return send(res, 200, JSON.stringify(listCollections(acct).map(id => ({ id }))), { 'Content-Type': 'application/json' });
	}
	if (url === '/v1/collection' && method === 'POST') {
		ensureSession(acct);
		const id = shortHash(crypto.randomBytes(8).toString('hex'));
		ensureDir(collectionDir(acct, id));
		return send(res, 200, id, { 'Content-Type': 'text/plain' });
	}
	if (url === '/v1/collection' && method === 'DELETE') {
		fs.rmSync(collectionsDir(acct), { recursive: true, force: true });
		return send(res, 200, '');
	}
	m = /^\/v1\/collection\/([^/]+)$/.exec(url);
	if (m && method === 'DELETE') {
		fs.rmSync(collectionDir(acct, m[1]), { recursive: true, force: true });
		return send(res, 200, '');
	}

	// DELETE /v1/resource  (clear all — the client's clear() / resetRemote()). Rotates the session.
	if (url === '/v1/resource' && method === 'DELETE') {
		fs.rmSync(path.join(acct, 'resource'), { recursive: true, force: true });
		fs.rmSync(path.join(acct, 'history'), { recursive: true, force: true });
		fs.rmSync(collectionsDir(acct), { recursive: true, force: true });
		fs.rmSync(path.join(acct, 'session'), { force: true });
		return send(res, 204, '');
	}

	// Top-level resource: /v1/resource/{type}[/{ref}]
	m = /^\/v1\/resource\/([^/]+)(?:\/([^/]+))?$/.exec(url);
	if (m) {
		if (method === 'GET' && m[2]) { return resourceGet(req, res, acct, m[1], m[2]); }
		if (method === 'POST' && !m[2]) { ensureSession(acct); return resourcePost(req, res, acct, m[1]); }
		if (method === 'DELETE') { deleteResource(acct, m[1]); return send(res, 200, ''); }
	}

	return send(res, 404, 'Not found: ' + method + ' ' + url);
});

if (require.main === module) {
	ensureDir(DATA_DIR);
	server.listen(PORT, () => {
		// eslint-disable-next-line no-console
		console.log('Atom++ reference sync server on http://localhost:' + PORT + ' (data: ' + DATA_DIR + ')');
		console.log('Watch this terminal — every editor sync request prints as a [sync] line.');
	});
}

module.exports = { server, buildManifest, buildDownload, readResource, writeResource, accountDir };
