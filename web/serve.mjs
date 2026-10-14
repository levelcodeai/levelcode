#!/usr/bin/env node
// Development / end-to-end server for LevelCode in the browser. Dependency-free.
//
//   node web/serve.mjs --static <vscode-web dir> --extensions <dir of built extensions> [--port 8800]
//
// It serves exactly what a static host serves in production (see scripts/build-web.mjs), with
// the Code-OSS web build mounted at /static and the LevelCode extensions at /extensions.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { webConfig, renderIndex, WEB_DIR } from './lib/config.mjs';
import { parseHeadersFile, headersFor } from './lib/headers.mjs';

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, all) => {
	if (v.startsWith('--')) { a.push([v.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : 'true']); }
	return a;
}, []));
const PORT = Number(args.port || process.env.PORT || 8800);
const HOST = args.host || '127.0.0.1';
// --dist <dir>: serve a built release (scripts/build-web.mjs) exactly as a static host would, with its _headers.
const DIST = args.dist ? path.resolve(args.dist) : null;
const STATIC_DIR = path.resolve(args.static || process.env.LEVELCODE_WEB_STATIC || '');
const EXT_DIR = path.resolve(args.extensions || process.env.LEVELCODE_WEB_EXTENSIONS || '');
if (!DIST && !args.static && !process.env.LEVELCODE_WEB_STATIC) { console.error('missing --static <vscode-web dir> (or --dist <built release>)'); process.exit(2); }
const RULES = DIST && fs.existsSync(path.join(DIST, '_headers')) ? parseHeadersFile(fs.readFileSync(path.join(DIST, '_headers'), 'utf8')) : { rules: [] };

const config = webConfig({
	account: args.account || process.env.LEVELCODE_ACCOUNT_ORIGIN,
	extensions: (args['extension-names'] ?? 'levelcode-ai,levelcode-web').split(',').filter(Boolean),
	development: true,
	productConfiguration: args.product ? JSON.parse(args.product) : undefined,
	configurationDefaults: args['config-defaults'] ? JSON.parse(args['config-defaults']) : undefined,
});

const TYPES = {
	'.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
	'.png': 'image/png', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
	'.wasm': 'application/wasm', '.map': 'application/json', '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
	'.nls': 'application/json',
};

function within(root, rel) {
	const p = path.normalize(path.join(root, rel));
	return p === root || p.startsWith(root + path.sep) ? p : null;
}

const server = http.createServer((req, res) => {
	const url = new URL(req.url, 'http://x');
	let pathname;
	try { pathname = decodeURIComponent(url.pathname); } catch { res.writeHead(400).end('bad path'); return; }

	let file = null;
	if (DIST) {
		file = within(DIST, pathname === '/' ? 'index.html' : pathname.slice(1));
		if (file && fs.existsSync(file) && fs.statSync(file).isDirectory()) { file = path.join(file, 'index.html'); }
	} else {
		if (pathname === '/' || pathname === '/index.html') {
			res.writeHead(200, { 'content-type': TYPES['.html'], 'cache-control': 'no-cache' });
			res.end(renderIndex(config));
			return;
		}
		if (pathname.startsWith('/static/')) { file = within(STATIC_DIR, pathname.slice('/static/'.length)); }
		else if (pathname.startsWith('/extensions/')) { file = within(EXT_DIR, pathname.slice('/extensions/'.length)); }
		else { file = within(WEB_DIR, pathname.slice(1)); }
		if (!file || file.includes(`${path.sep}lib${path.sep}`) || file.endsWith('serve.mjs')) { res.writeHead(404).end('not found'); return; }
	}
	if (!file) { res.writeHead(404).end('not found'); return; }

	fs.stat(file, (err, st) => {
		if (err || !st.isFile()) { res.writeHead(404, { 'content-type': 'text/plain' }).end('not found: ' + pathname); return; }
		const base = {
			'content-type': TYPES[path.extname(file)] || 'application/octet-stream',
			'content-length': st.size,
		};
		const extra = DIST ? headersFor(RULES, pathname === '/index.html' ? '/' : pathname) : {
			'cache-control': 'no-cache',
			// The extension host and the webviews run on origins of their own and fetch these files.
			// They are public static assets and are never requested with credentials.
			'access-control-allow-origin': '*',
			'cross-origin-resource-policy': 'cross-origin',
		};
		if (extra['Content-Type']) { delete base['content-type']; }
		res.writeHead(200, { ...base, ...extra });
		if (req.method === 'HEAD') { res.end(); return; }
		fs.createReadStream(file).pipe(res);
	});
});
server.listen(PORT, HOST, () => console.log(DIST ? `LevelCode web: http://${HOST}:${PORT}/  (release ${DIST})` : `LevelCode web: http://${HOST}:${PORT}/  (static ${STATIC_DIR}, extensions ${EXT_DIR})`));
