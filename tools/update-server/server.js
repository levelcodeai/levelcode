/*---------------------------------------------------------------------------------------------
 *  Atom++ — reference update-feed server
 *
 *  A tiny, dependency-free implementation of the Code-OSS update-feed contract that BOTH the
 *  built-in updater and the notify-only atom-updater extension speak:
 *
 *     GET /api/update/{target}/{quality}/{commit}
 *        → 204  if {commit} is already the latest build
 *        → 200  { version, productVersion, url, sha256hash, timestamp }  otherwise
 *
 *  The "latest build" per (target, quality) is read from a releases file (RELEASES_FILE, default
 *  ./releases.json). Use it to dev/test the updater, to self-host an update feed, and as the spec
 *  thin.ly implements for managed releases. See docs/atompp-update-flow.md.
 *
 *  Run:  PORT=9696 RELEASES_FILE=./releases.json node server.js
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = parseInt(process.env.PORT || '9696', 10);
const LOG = require.main === module;

function releasesFile() { return process.env.RELEASES_FILE || path.join(__dirname, 'releases.json'); }

let warnedExample = false;
/** { "<target>": { "<quality>": { commit, productVersion, url, sha256hash, timestamp } } }.
 *  Falls back to the committed releases.example.json (with a warning) so the notify flow works
 *  out of the box in dev — real self-hosts create their own releases.json. */
function readReleases() {
	try { return JSON.parse(fs.readFileSync(releasesFile(), 'utf8')); } catch { /* fall through to the example */ }
	try {
		const data = JSON.parse(fs.readFileSync(path.join(__dirname, 'releases.example.json'), 'utf8'));
		if (LOG && !warnedExample) { warnedExample = true; console.log('[update] no releases.json found — using releases.example.json (edit it, or create releases.json).'); }
		return data;
	} catch { return {}; }
}

/** The latest release for a target+quality, or null. */
function latestRelease(target, quality) {
	const rel = (readReleases()[target] || {})[quality];
	return rel && rel.commit ? rel : null;
}

function send(res, status, body, headers) {
	res.writeHead(status, Object.assign({ 'Cache-Control': 'no-store' }, headers || {}));
	res.end(body);
}

const server = http.createServer((req, res) => {
	if (LOG) {
		res.on('finish', () => {
			const u = req.url || '';
			if (u !== '/' && u !== '/health') { // log everything (incl. misdirected /v1 → 404)
				console.log('[update] ' + (req.method || 'GET') + ' ' + u + ' → ' + res.statusCode);
			}
		});
	}
	const url = (req.url || '').split('?')[0];
	const method = req.method || 'GET';

	if (url === '/' || url === '/health') {
		return send(res, 200, 'Atom++ reference update-feed server\n', { 'Content-Type': 'text/plain' });
	}

	const m = /^\/api\/update\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(url);
	if (m && method === 'GET') {
		const [, target, quality, commit] = m;
		const rel = latestRelease(target, quality);
		if (!rel || rel.commit === commit) { return send(res, 204, ''); } // up to date (or nothing published)
		return send(res, 200, JSON.stringify({
			version: rel.commit,
			productVersion: rel.productVersion,
			url: rel.url,
			sha256hash: rel.sha256hash,
			timestamp: rel.timestamp || 0,
			releaseNotesUrl: rel.releaseNotesUrl
		}), { 'Content-Type': 'application/json' });
	}

	return send(res, 404, 'Not found: ' + method + ' ' + url);
});

if (require.main === module) {
	server.listen(PORT, () => {
		// eslint-disable-next-line no-console
		console.log('Atom++ reference update-feed server on http://localhost:' + PORT + ' (releases: ' + releasesFile() + ')');
		console.log('Watch this terminal — every updater check prints as an [update] line.');
	});
}

module.exports = { server, latestRelease };
