/*---------------------------------------------------------------------------------------------
 *  LevelCode — AI · reading a web page from this machine (the desktop's web_fetch; docs/WEB-SEARCH.md)
 *
 *  The agent opens pages it found on the web, so a page must not be able to point it at this machine or the
 *  network it sits on: an address that resolves to a loopback, private, link-local or otherwise local range is
 *  refused. The check happens inside the connection's own DNS lookup, so the address that was checked is the
 *  address that is connected to, and every redirect is checked again the same way.
 *
 *  Node only. The browser build aliases http/https/dns/zlib to stubs; there, pages are read through LevelCode Cloud.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

const http = require('http');
const https = require('https');
const dns = require('dns');
const net = require('net');
const zlib = require('zlib');

const MAX_REDIRECTS = 4;
const USER_AGENT = 'Mozilla/5.0 (compatible; LevelCode/1.4; +https://levelcode.ai)';

/** IPv4 dotted quad → 32-bit number, or null. */
function v4num(ip) {
	const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
	if (!m) { return null; }
	const p = m.slice(1).map(Number);
	if (p.some((x) => x > 255)) { return null; }
	return ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3];
}
const V4_BLOCKED = [
	['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
	['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
	['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]
].map(([a, bits]) => ({ base: /** @type {number} */ (v4num(a)), mask: (~0 << (32 - /** @type {number} */ (bits))) >>> 0 }));

/** True for an address the agent must not connect to: anything that is not the public internet. */
function isPrivateAddress(ip) {
	const s = String(ip || '').trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/%.*$/, '');
	const n = v4num(s);
	if (n != null) { return V4_BLOCKED.some((r) => ((n & r.mask) >>> 0) === r.base); }
	if (!s.includes(':')) { return true; }                         // not an address we understand: refuse
	if (s === '::' || s === '::1') { return true; }
	const mapped = /^(?:0{0,4}:){0,4}:?(?:ffff:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s) || /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
	if (mapped) { return isPrivateAddress(mapped[1]); }
	if (/^64:ff9b::/.test(s)) { return true; }                     // NAT64 can reach anything; refuse rather than decode
	const first = parseInt(s.split(':')[0] || '0', 16);
	if ((first & 0xfe00) === 0xfc00) { return true; }              // fc00::/7 unique local
	if ((first & 0xffc0) === 0xfe80) { return true; }              // fe80::/10 link-local
	if ((first & 0xff00) === 0xff00) { return true; }              // ff00::/8 multicast
	if (first === 0x2001 && /^2001:0?db8:/.test(s)) { return true; } // documentation
	return false;
}

/** A dns.lookup for http(s).request that answers only public addresses. */
function guardedLookup(allowPrivate) {
	return (hostname, options, callback) => {
		const opts = typeof options === 'object' && options ? options : {};
		dns.lookup(hostname, { all: true, family: opts.family || 0, hints: opts.hints }, (err, addresses) => {
			if (err) { return callback(err); }
			const list = /** @type {{address:string,family:number}[]} */ (addresses || []);
			const ok = allowPrivate ? list : list.filter((a) => !isPrivateAddress(a.address));
			if (!ok.length) {
				const e = /** @type {any} */ (new Error(hostname + ' is on a private or local network; the agent only opens public pages'));
				e.code = 'EBLOCKED';
				return callback(e);
			}
			if (opts.all) { return callback(null, ok); }
			return callback(null, ok[0].address, ok[0].family);
		});
	};
}

function charsetOf(contentType) {
	const m = /charset\s*=\s*"?([\w.:-]+)/i.exec(String(contentType || ''));
	return m ? m[1].toLowerCase() : 'utf-8';
}
function decodeBody(buf, contentType) {
	try { return new TextDecoder(charsetOf(contentType), { fatal: false }).decode(buf); }
	catch (e) { return new TextDecoder('utf-8').decode(buf); }
}

/** One request, no redirects followed: { status, headers, body (Buffer), truncated }. */
function requestOnce(url, o) {
	return new Promise((resolve, reject) => {
		const u = new URL(url);
		const mod = u.protocol === 'https:' ? https : http;
		// An address written as an IP is connected to directly: Node never calls `lookup` for it, so check it here.
		const literal = u.hostname.replace(/^\[|\]$/g, '');
		if (net.isIP(literal) && !o.allowPrivate && isPrivateAddress(literal)) {
			const e = /** @type {any} */ (new Error(literal + ' is on a private or local network; the agent only opens public pages'));
			e.code = 'EBLOCKED';
			return reject(e);
		}
		let settled = false;
		const done = (fn, v) => { if (!settled) { settled = true; clearTimeout(timer); if (o.signal) { o.signal.removeEventListener('abort', onAbort); } fn(v); } };
		const req = mod.request(u, {
			method: 'GET',
			headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,application/json;q=0.8,*/*;q=0.5', 'accept-encoding': 'gzip, deflate, br', 'accept-language': 'en;q=0.9, *;q=0.5' },
			lookup: /** @type {any} */ (guardedLookup(o.allowPrivate)),
		}, (res) => {
			const status = res.statusCode || 0;
			if (status >= 300 && status < 400 && res.headers.location) { res.resume(); return done(resolve, { status, headers: res.headers, body: Buffer.alloc(0), truncated: false }); }
			const enc = String(res.headers['content-encoding'] || '').toLowerCase();
			/** @type {NodeJS.ReadableStream} */
			let stream = res;
			if (enc === 'gzip' || enc === 'x-gzip') { stream = res.pipe(zlib.createGunzip()); }
			else if (enc === 'deflate') { stream = res.pipe(zlib.createInflate()); }
			else if (enc === 'br') { stream = res.pipe(zlib.createBrotliDecompress()); }
			const chunks = [];
			let size = 0, truncated = false;
			stream.on('data', (c) => {
				if (truncated) { return; }
				size += c.length;
				if (size > o.maxBytes) { chunks.push(c.subarray(0, c.length - (size - o.maxBytes))); truncated = true; req.destroy(); done(resolve, { status, headers: res.headers, body: Buffer.concat(chunks), truncated }); return; }
				chunks.push(c);
			});
			stream.on('end', () => done(resolve, { status, headers: res.headers, body: Buffer.concat(chunks), truncated }));
			stream.on('error', (e) => done(reject, e));
		});
		const timer = setTimeout(() => { const e = /** @type {any} */ (new Error('timed out after ' + Math.round(o.timeoutMs / 1000) + ' s')); e.code = 'ETIMEDOUT'; req.destroy(e); done(reject, e); }, o.timeoutMs);
		const onAbort = () => { const e = new Error('stopped'); req.destroy(e); done(reject, e); };
		if (o.signal) { if (o.signal.aborted) { return onAbort(); } o.signal.addEventListener('abort', onAbort, { once: true }); }
		req.on('error', (e) => done(reject, e));
		req.end();
	});
}

/**
 * Read a page from this machine, following up to four redirects (each checked again). Answers what
 * webSearch.fetchPage expects: { finalUrl, status, contentType, body (text), truncated }.
 * `allowPrivate` exists for tests that serve pages from this machine; the extension never sets it.
 */
async function fetchPage(url, opts) {
	const o = Object.assign({ timeoutMs: 12000, maxBytes: 2 * 1024 * 1024, allowPrivate: false }, opts || {});
	const deadline = Date.now() + o.timeoutMs;
	let current = url;
	for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
		const u = new URL(current);
		if (u.protocol !== 'http:' && u.protocol !== 'https:') { throw new Error('only http and https pages can be opened'); }
		const left = Math.max(500, deadline - Date.now());
		const r = await requestOnce(current, Object.assign({}, o, { timeoutMs: left }));
		if (r.status >= 300 && r.status < 400 && r.headers.location) {
			current = new URL(String(r.headers.location), current).toString();
			continue;
		}
		const contentType = String(r.headers['content-type'] || '');
		return { finalUrl: current, status: r.status, contentType, body: decodeBody(r.body, contentType), truncated: r.truncated };
	}
	throw new Error('too many redirects');
}

module.exports = { fetchPage, isPrivateAddress, guardedLookup };
