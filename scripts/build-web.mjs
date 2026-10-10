#!/usr/bin/env node
// Build LevelCode in your browser: one static directory, dist-web/, that any static host can serve.
//
//   node scripts/build-web.mjs [--vscode vscode] [--out dist-web] [--account https://levelcode.ai] [--api-url <origin>]
//                              [--webview-origin 'https://{{uuid}}.view.example.com']
//                              [--ext-host-origin 'https://{{uuid}}.ext.example.com']
//                              [--static <prebuilt vscode-web dir>] [--id <build id>]
//
// What it does, in order (docs/WEB.md has the reasoning):
//   1. builds Code-OSS's web client from the bootstrapped checkout (gulp vscode-web-min-ci, about a
//      minute), or takes a prebuilt one with --static;
//   2. bundles levelcode-ai for the web worker extension host (web/ai-extension), copies the scratch
//      workspace extension (web/workspace) and every declarative built-in (grammars, themes, icons);
//   3. lays everything out under a build-addressed prefix (/_/<id>/...), renders index.html with the
//      configuration baked in, and writes the HTTP policy for the host (_headers, nginx).
//
// It changes nothing outside --out. It does not deploy.
import { spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { webConfig, renderIndex } from '../web/lib/config.mjs';
import { stageDeclarativeExtensions, copyExtension } from '../web/lib/extensions.mjs';
import { policy, toHeadersFile, toNginx } from '../web/lib/headers.mjs';
import { hashTree } from '../web/lib/fingerprint.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB = path.join(REPO, 'web');

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, all) => {
	if (v.startsWith('--')) { a.push([v.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : 'true']); }
	return a;
}, []));
const vscodeDir = path.resolve(REPO, args.vscode || 'vscode');
const outDir = path.resolve(REPO, args.out || 'dist-web');
const account = String(args.account || process.env.LEVELCODE_WEB_ACCOUNT || 'https://levelcode.ai').replace(/\/+$/, '');
// Only for a deployment whose API is not on the account origin (production has one host for both).
const apiUrl = String(args['api-url'] || process.env.LEVELCODE_WEB_API_URL || '').replace(/\/+$/, '');
const webviewOrigin = args['webview-origin'] || process.env.LEVELCODE_WEB_WEBVIEW_ORIGIN || '';
const extHostOrigin = args['ext-host-origin'] || process.env.LEVELCODE_WEB_EXTHOST_ORIGIN || '';

const log = (m) => console.log('[build-web] ' + m);
const die = (m) => { console.error('[build-web] ' + m); process.exit(1); };
const sizeOf = (p) => { let n = 0; const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); e.isDirectory() ? walk(f) : (n += fs.statSync(f).size); } }; walk(p); return n; };
const mb = (n) => (n / 1048576).toFixed(1) + ' MB';

/* ----- 1. Code-OSS's web client ---------------------------------------------------------------- */
let staticDir;
if (args.static) {
	staticDir = path.resolve(args.static);
	log('using the prebuilt web client at ' + staticDir);
} else {
	if (!fs.existsSync(path.join(vscodeDir, 'node_modules'))) { die('no bootstrapped checkout at ' + vscodeDir + ' — run scripts/bootstrap.sh first'); }
	const product = JSON.parse(fs.readFileSync(path.join(vscodeDir, 'product.json'), 'utf8'));
	if (product.nameShort !== 'LevelCode') { die('the checkout is not branded (product.json nameShort is "' + product.nameShort + '") — run scripts/apply-branding.mjs'); }
	log('building the web client (gulp vscode-web-min-ci) in ' + vscodeDir);
	const r = spawnSync('npm', ['run', 'gulp', '--', 'vscode-web-min-ci'], { cwd: vscodeDir, stdio: 'inherit', env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=8192' } });
	if (r.status !== 0) { die('the web client build failed'); }
	staticDir = path.resolve(vscodeDir, '..', 'vscode-web');
}
for (const must of ['out/vs/workbench/workbench.web.main.internal.js', 'out/vs/workbench/workbench.web.main.internal.css', 'out/nls.messages.js',
	'out/vs/workbench/services/extensions/worker/webWorkerExtensionHostIframe.html', 'out/vs/workbench/contrib/webview/browser/pre/index.html']) {
	if (!fs.existsSync(path.join(staticDir, must))) { die('the web client is missing ' + must); }
}

/* ----- 2. identity of this build ---------------------------------------------------------------- */
const fingerprint = createHash('sha256');
fingerprint.update(fs.readFileSync(path.join(staticDir, 'out/vs/workbench/workbench.web.main.internal.js')));
for (const f of ['main.js', 'boot.css', 'index.html']) { fingerprint.update(fs.readFileSync(path.join(WEB, f))); }
// Everything that goes into /_/<id>/ and is not the web client itself: the extension (its sources, media and skills),
// its browser build, the scratch workspace, and the page's own configuration code.
const aiDir = path.join(REPO, 'extensions', 'levelcode-ai');
hashTree(fingerprint, aiDir, { skip: ['test', 'node_modules', 'scripts', '.DS_Store'] });
hashTree(fingerprint, path.join(WEB, 'ai-extension'), { skip: ['assets.generated.js', 'node_modules', '.DS_Store'] });
hashTree(fingerprint, path.join(WEB, 'workspace'), { skip: ['node_modules', '.DS_Store'] });
hashTree(fingerprint, path.join(WEB, 'lib'), { skip: ['.DS_Store'] });
const id = String(args.id || fingerprint.digest('hex').slice(0, 12));
let gitHead = 'unknown';
try { gitHead = execFileSync('git', ['-C', REPO, 'rev-parse', '--short=10', 'HEAD'], { encoding: 'utf8' }).trim(); } catch { /* not a checkout */ }
log('build id ' + id + ' (levelcode ' + gitHead + ')');

/* ----- 3. assemble ------------------------------------------------------------------------------- */
fs.rmSync(outDir, { recursive: true, force: true });
const prefix = `/_/${id}`;
const root = path.join(outDir, '_', id);
fs.mkdirSync(root, { recursive: true });

log('copying the web client');
fs.cpSync(staticDir, path.join(root, 'static'), { recursive: true, filter: (src) => !/\.(js|css)\.map$/.test(src) });
const baked = new Set(fs.existsSync(path.join(staticDir, 'extensions')) ? fs.readdirSync(path.join(staticDir, 'extensions')) : []);

const extOut = path.join(root, 'extensions');
fs.mkdirSync(extOut, { recursive: true });

log('bundling levelcode-ai for the web worker extension host');
const r = spawnSync(process.execPath, [path.join(WEB, 'ai-extension', 'build.mjs'), '--out', extOut, '--vscode', vscodeDir, '--minify'], { stdio: 'inherit' });
if (r.status !== 0) { die('the levelcode-ai browser build failed'); }

log('staging the scratch workspace and the declarative built-ins');
const scratchOut = path.join(extOut, 'levelcode-web');
copyExtension(path.join(WEB, 'workspace'), scratchOut);
fs.writeFileSync(path.join(scratchOut, 'package.nls.json'), '{}\n');
const extensionsSource = path.join(vscodeDir, 'extensions');
if (!fs.existsSync(extensionsSource)) { die('no extensions/ in ' + vscodeDir + ' to take the declarative built-ins from'); }
const declarative = stageDeclarativeExtensions(extensionsSource, extOut, { exclude: [...baked, 'levelcode-ai', 'levelcode-web'] });
// A checkout that has not had LevelCode's extensions copied in still builds; the themes are then absent.
if (!declarative.includes('levelcode-themes')) {
	const themes = path.join(REPO, 'extensions', 'levelcode-themes');
	if (fs.existsSync(themes)) { copyExtension(themes, path.join(extOut, 'levelcode-themes')); declarative.push('levelcode-themes'); }
}
const extensions = ['levelcode-ai', 'levelcode-web', ...declarative.sort()];
log(`${extensions.length} extensions: levelcode-ai, levelcode-web and ${declarative.length} declarative (${declarative.slice(0, 6).join(', ')}, ...)`);

log('writing the page');
// main.js and boot.css are addressed by the build id like everything else; the page names them.
for (const f of ['main.js', 'boot.css']) { fs.copyFileSync(path.join(WEB, f), path.join(root, f)); }

const productConfiguration = {
	// No gallery: nothing is installed from the Internet into the page's own origin.
	extensionsGallery: null,
};
if (!webviewOrigin) {
	// Code-OSS publishes each stable commit's webview host pages to its CDN. product.json pins an older insider commit,
	// whose service worker is a version behind this build's; the template below names this build's own commit.
	productConfiguration.webviewContentExternalBaseUrlTemplate = 'https://{{uuid}}.vscode-cdn.net/{{quality}}/{{commit}}/out/vs/workbench/contrib/webview/browser/pre/';
	console.warn('[build-web] note: no --webview-origin, so the chat panel loads its host page from Code-OSS\'s CDN (*.vscode-cdn.net, this build\'s own commit).\n'
		+ '            That works with no setup. To serve it yourself give a wildcard origin, e.g. --webview-origin \'https://{{uuid}}.view.example.com\'\n'
		+ '            (each webview needs its own subdomain; see docs/WEB.md).');
}
if (webviewOrigin) { productConfiguration.webviewContentExternalBaseUrlTemplate = `${webviewOrigin}${prefix}/static/out/vs/workbench/contrib/webview/browser/pre/`; }
if (extHostOrigin) { productConfiguration.webEndpointUrlTemplate = `${extHostOrigin}${prefix}/static`; }
const config = webConfig({
	account,
	apiUrl,
	extensions,
	base: prefix,
	staticBase: `${prefix}/static`,
	extensionsBase: `${prefix}/extensions`,
	productConfiguration,
});
fs.writeFileSync(path.join(outDir, 'index.html'), renderIndex(config));
for (const f of ['callback.html', 'callback.js', 'callback.css', 'icon.svg', 'icon-192.png', 'icon-512.png', 'manifest.webmanifest']) {
	fs.copyFileSync(path.join(WEB, f), path.join(outDir, f));
}

/* ----- 4. the host's half ------------------------------------------------------------------------ */
const toPattern = (o) => (o ? o.replace('{{uuid}}', '*') : '');
const pol = policy({ account, webviewOrigin: toPattern(webviewOrigin), extHostOrigin: toPattern(extHostOrigin), base: '/_' });
fs.writeFileSync(path.join(outDir, '_headers'), toHeadersFile(pol));
fs.mkdirSync(path.join(outDir, 'deploy'), { recursive: true });
fs.writeFileSync(path.join(outDir, 'deploy', 'nginx.conf'), toNginx(pol));
const info = {
	id, levelcode: gitHead, builtAt: new Date().toISOString(), account, apiUrl: apiUrl || '(the account origin)',
	webviewOrigin: webviewOrigin || '(Code-OSS default: *.vscode-cdn.net)',
	extHostOrigin: extHostOrigin || '(same origin as the editor)',
	extensions,
};
fs.writeFileSync(path.join(outDir, 'build.json'), JSON.stringify(info, null, 2) + '\n');

/* ----- 5. check what was written ----------------------------------------------------------------- */
const html = fs.readFileSync(path.join(outDir, 'index.html'), 'utf8');
const m = html.match(/<script type="application\/json" id="levelcode-web-config">([\s\S]*?)<\/script>/);
if (!m) { die('index.html has no configuration'); }
JSON.parse(m[1]);
if (/\{\{[A-Z]+\}\}/.test(html)) { die('index.html still has an unfilled placeholder'); }
for (const must of [`${prefix}/main.js`, `${prefix}/boot.css`, `${prefix}/static/out/nls.messages.js`, `${prefix}/extensions/levelcode-ai/extension.web.js`,
	`${prefix}/extensions/levelcode-ai/package.json`, `${prefix}/extensions/levelcode-web/extension.js`]) {
	if (!fs.existsSync(path.join(outDir, must))) { die('missing ' + must); }
}
log(`done: ${outDir}  ${mb(sizeOf(outDir))}  (client ${mb(sizeOf(path.join(root, 'static')))}, extensions ${mb(sizeOf(extOut))})`);
log('serve it with:  node web/serve.mjs --dist ' + path.relative(process.cwd(), outDir));
