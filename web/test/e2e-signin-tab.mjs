#!/usr/bin/env node
// Signing in without a second window.
//
// A pop-up opened from a chain that began in a webview is the first thing a strict browser (Safari, a
// phone) refuses, so the editor takes its own tab to the account site and the sign-in comes back to it:
//
//   /?signin=1  ->  the editor starts the sign-in by itself (the account site's "Open in browser" link)
//               ->  the tab goes to <account>/ai/login            (stand-in, already signed in there)
//               ->  /callback.html writes the result and returns the tab to /
//               ->  the editor delivers it to the extension, which exchanges the code
//
// What this proves, in a real (headless) Chrome:
//   - no second window is ever opened, and the tab ends on a clean address;
//   - the sign-in completes across the page reload (the PKCE verifier survived it) and is not repeated;
//   - ?signin=1 on a signed-in editor does not sign in again;
//   - a result left by a callback page whose editor is gone is delivered when the editor next starts,
//     and an old one is not.
//
//   node web/test/e2e-signin-tab.mjs --static <vscode-web dir> --extensions <built extensions dir> [--product <json>]
//   node web/test/e2e-signin-tab.mjs --dist <release dir> --stub-port <the account port it was built with>
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startStub } from './stub-backend.mjs';
import { Chrome, sleep } from './cdp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, all) => { if (v.startsWith('--')) { a.push([v.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : 'true']); } return a; }, []));
const DIST = args.dist ? path.resolve(args.dist) : null;
const STATIC = path.resolve(args.static || process.env.LEVELCODE_WEB_STATIC || '');
const EXTS = path.resolve(args.extensions || process.env.LEVELCODE_WEB_EXTENSIONS || '');
const PORT = Number(args.port || 8806);
// `localhost`, not 127.0.0.1: the extension host's own iframe policy admits https: and http://localhost:*.
const editorOrigin = `http://localhost:${PORT}`;
if (DIST ? !fs.existsSync(DIST) : (!fs.existsSync(STATIC) || !fs.existsSync(EXTS))) {
	console.error('usage: e2e-signin-tab.mjs --dist <release dir>   |   e2e-signin-tab.mjs --static <vscode-web dir> --extensions <dir>   [--stub-port N]');
	process.exit(2);
}

const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); return ok; };

const stub = await startStub({ editorOrigin, port: args['stub-port'] ? Number(args['stub-port']) : 0 });
const server = spawn(process.execPath, [path.join(HERE, '..', 'serve.mjs'), '--port', String(PORT), ...(DIST
	? ['--dist', DIST]
	: ['--static', STATIC, '--extensions', EXTS, '--extension-names', 'levelcode-ai,levelcode-web', '--account', stub.origin,
		...(args.product ? ['--product', args.product] : [])])], { stdio: 'inherit' });
// With the extension host on an origin of its own (--product with webEndpointUrlTemplate, or a release built with
// --ext-host-origin) its fetches carry THAT origin, not the editor's.
let hardened = /webEndpointUrlTemplate/.test(args.product || '');
if (DIST) { try { hardened = !/\(same origin/.test(fs.readFileSync(path.join(DIST, 'build.json'), 'utf8')); } catch { /* keep */ } }
let chrome;
const finish = async (code) => { try { chrome && chrome.close(); } catch {} try { server.kill(); } catch {} try { await stub.close(); } catch {} process.exit(code); };
process.on('SIGINT', () => finish(130));

const exchanges = () => stub.state.log.filter((e) => e.path === '/api/levelcode/v1/auth/exchange' && e.method === 'POST').length;
const accountCalls = () => stub.state.log.filter((e) => /^\/api\/levelcode\/v1\/account\/(profile|models)$/.test(e.path) && e.auth).length;

try {
	for (let i = 0; i < 50; i++) { try { if ((await fetch(editorOrigin + '/')).ok) { break; } } catch {} await sleep(100); }
	chrome = await Chrome.launch({ port: Number(args['debug-port'] || 9557), args: ['--ignore-certificate-errors'] });
	/** The tabs and windows the browser has open, other than the blank one it started with. */
	const openPages = async (page) => (await page.targets()).filter((t) => t.type === 'page' && t.url !== 'about:blank');
	const workbenchReady = (page) => page.waitFor(() => page.eval(`!!document.querySelector('.monaco-workbench .part.editor')`), { ms: 90000, label: 'workbench' });

	/* 1. ?signin=1 on a signed-out editor */
	const page = await chrome.newPage(editorOrigin + '/?signin=1');
	await page.waitFor(() => stub.state.signIns >= 1, { ms: 90000, label: 'the sign-in page to be asked' }).catch(() => null);
	check('?signin=1 starts the sign-in with no click', stub.state.signIns >= 1, 'sign-ins asked of the account site: ' + stub.state.signIns);
	await page.waitFor(() => exchanges() >= 1, { ms: 90000, label: 'code exchange' }).catch(() => null);
	check('the code was exchanged, with the verifier that was kept across the reload', exchanges() === 1, 'exchanges: ' + exchanges());
	const exch = stub.state.log.find((e) => e.path === '/api/levelcode/v1/auth/exchange' && e.method === 'POST') || {};
	check(hardened ? 'the exchange came from the extension host\'s own origin (CORS answered)' : 'the exchange came from the editor\'s origin (CORS answered)',
		hardened ? /^https?:\/\/v--[a-z0-9]+\./.test(exch.origin || '') : exch.origin === editorOrigin, 'from ' + exch.origin);
	await workbenchReady(page);
	await page.waitFor(() => accountCalls() >= 1, { ms: 30000, label: 'the account API with the new token' }).catch(() => null);
	check('the editor then used its session against the account API', accountCalls() >= 1, 'calls: ' + accountCalls());

	const pages = await openPages(page);
	check('no second window or tab was opened', pages.length === 1, JSON.stringify(pages.map((t) => t.url.slice(0, 60))));
	const here = new URL(await page.eval('location.href'));
	check('the tab ends on the editor with nothing of the sign-in left in its address', here.origin === editorOrigin && here.pathname === '/' && here.search === '' && here.hash === '', here.href);
	const leftover = await page.eval(`Object.keys(localStorage).filter((k) => k.startsWith('vscode-web.url-callbacks['))`);
	check('the result was taken out of storage', Array.isArray(leftover) && leftover.length === 0, JSON.stringify(leftover));
	const flag = await page.eval(`sessionStorage.getItem('levelcode-web.return')`);
	check('the tab is no longer marked as one expected back', flag === null, JSON.stringify(flag));

	await sleep(6000);
	check('and the sign-in is not repeated', stub.state.signIns === 1 && exchanges() === 1, `sign-ins ${stub.state.signIns}, exchanges ${exchanges()}`);

	/* 2. a signed-in editor opened with ?signin=1 does not sign in again */
	const calls = accountCalls();
	await page.goto(editorOrigin + '/?signin=1');
	await workbenchReady(page);
	await page.waitFor(() => accountCalls() > calls, { ms: 30000, label: 'account call after the reload' }).catch(() => null);
	await sleep(4000);
	check('after a reload the editor is still signed in', accountCalls() > calls, `${calls} -> ${accountCalls()}`);
	check('?signin=1 on a signed-in editor does not sign in again', stub.state.signIns === 1 && exchanges() === 1, `sign-ins ${stub.state.signIns}, exchanges ${exchanges()}`);
	const again = new URL(await page.eval('location.href'));
	check('the parameter is gone from the address', again.search === '', again.search);

	/* 3. a callback page whose editor tab is gone: the result waits, and the next start delivers it */
	const orphan = await chrome.newPage();
	const base = `${editorOrigin}/callback.html?vscode-reqid=7&vscode-scheme=levelcode&vscode-authority=levelcode.levelcode-ai&vscode-path=%2Fauth%2Fcallback`;
	await orphan.goto(base + '&code=left-behind');
	await orphan.waitFor(() => orphan.eval(`document.getElementById('title').textContent`).then((t) => /signed in/i.test(t)), { ms: 15000, label: 'callback page' });
	const text = await orphan.eval(`document.getElementById('text').textContent`);
	check('a callback page that was not opened from the editor says to close the tab', /close this tab/i.test(text), JSON.stringify(text));
	const link = await orphan.eval(`(() => { const m = document.getElementById('more'); return m && !m.hidden ? m.querySelector('a').href : null; })()`);
	check('and offers a way into the editor, for a tab that cannot close itself', link === editorOrigin + '/', JSON.stringify(link));
	const stored = await orphan.eval(`JSON.parse(localStorage.getItem('vscode-web.url-callbacks[7]') || 'null')`);
	check('the result is in storage, dated, without the code in the address bar', !!stored && stored.query === 'code=left-behind' && typeof stored.at === 'number' && !/code=/.test(await orphan.eval('location.href')), JSON.stringify(stored));
	// The editor tab that is already open hears the storage event for an id it is not waiting on and ignores it.
	await sleep(1500);
	check('an editor that is not waiting for it leaves it alone', (await orphan.eval(`localStorage.getItem('vscode-web.url-callbacks[7]') !== null`)) === true);
	const before = exchanges();
	await orphan.goto(editorOrigin + '/');
	await workbenchReady(orphan);
	await orphan.waitFor(() => exchanges() > before, { ms: 60000, label: 'delivery at start-up' }).catch(() => null);
	check('the next start delivers it to the extension (the stand-in refuses the made-up code; the attempt is the proof)', exchanges() === before + 1, `${before} -> ${exchanges()}`);
	check('and it is gone from storage', (await orphan.eval(`localStorage.getItem('vscode-web.url-callbacks[7]')`)) === null);

	// An old one is not delivered. Written here with an age beyond the limit, by hand.
	await orphan.eval(`localStorage.setItem('vscode-web.url-callbacks[8]', JSON.stringify({ scheme: 'levelcode', authority: 'levelcode.levelcode-ai', path: '/auth/callback', query: 'code=too-old', at: Date.now() - 10 * 60 * 1000 }))`);
	const before2 = exchanges();
	await orphan.goto(editorOrigin + '/');
	await workbenchReady(orphan);
	await sleep(8000);
	check('a result older than the code could live is dropped, not delivered', exchanges() === before2 && (await orphan.eval(`localStorage.getItem('vscode-web.url-callbacks[8]')`)) === null, `${before2} -> ${exchanges()}`);
} catch (e) {
	check('the run completed', false, String((e && e.stack) || e));
}

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
await finish(failed ? 1 : 0);
