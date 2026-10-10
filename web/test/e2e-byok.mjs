#!/usr/bin/env node
// Bring-your-own-key in a tab: set a key through the real command, ask the agent for something, and see
// that the request went from the browser straight to the provider with that key — and that no LevelCode
// account token was involved. Uses the same stand-in backend as e2e.mjs, as an OpenAI-compatible provider.
//
//   node web/test/e2e-byok.mjs --static <vscode-web dir> --extensions <dir>
//
// The provider settings (custom, OpenAI-compatible, at the stand-in's address) are configuration defaults of
// the development server; a release bakes its own defaults, so this runs against the development layout.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startStub } from './stub-backend.mjs';
import { Chrome, sleep } from './cdp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, all) => { if (v.startsWith('--')) { a.push([v.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : 'true']); } return a; }, []));
const STATIC = path.resolve(args.static || process.env.LEVELCODE_WEB_STATIC || '');
const EXTS = path.resolve(args.extensions || process.env.LEVELCODE_WEB_EXTENSIONS || '');
const PORT = Number(args.port || 8805);
const editorOrigin = `http://localhost:${PORT}`;
const KEY = ['sk', 'byok', 'test', '0123456789'].join('-');
const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };

const stub = await startStub({ editorOrigin, port: args['stub-port'] ? Number(args['stub-port']) : 0 });
const defaults = JSON.stringify({ 'levelcode.ai.providerMode': 'byok', 'levelcode.ai.provider': 'custom', 'levelcode.ai.baseURL': stub.origin + '/v1' });
const server = spawn(process.execPath, [path.join(HERE, '..', 'serve.mjs'), '--port', String(PORT),
	'--static', STATIC, '--extensions', EXTS, '--extension-names', 'levelcode-ai,levelcode-web', '--account', stub.origin, '--config-defaults', defaults], { stdio: 'inherit' });
let chrome;
const finish = async (code) => { try { chrome && chrome.close(); } catch {} try { server.kill(); } catch {} try { await stub.close(); } catch {} process.exit(code); };

try {
	for (let i = 0; i < 50; i++) { try { if ((await fetch(editorOrigin + '/')).ok) { break; } } catch {} await sleep(100); }
	chrome = await Chrome.launch({ port: Number(args['debug-port'] || 9556), args: ['--ignore-certificate-errors'] });
	const page = await chrome.newPage(editorOrigin + '/');
	await page.waitFor(() => page.eval(`!!document.querySelector('.monaco-workbench .part.editor')`), { ms: 90000, label: 'workbench' });
	await page.waitFor(async () => (await page.eval(`[...document.querySelectorAll('.tabs-container .tab')].some((e) => /LevelCode AI/.test(e.getAttribute('aria-label') || ''))`)), { ms: 60000, label: 'chat tab' });
	await sleep(2500);

	const palette = async (text) => {
		await page.key('F1', 'F1');
		await page.waitFor(() => page.eval(`!!document.querySelector('.quick-input-widget:not([style*="display: none"]) .quick-input-box input')`), { ms: 8000, label: 'command palette' });
		await page.type(text);
		await sleep(900);
		await page.key('Enter', 'Enter');
	};

	await palette('Set API Key');
	await page.waitFor(() => page.eval(`!!document.querySelector('.quick-input-widget:not([style*="display: none"]) .quick-input-box input[type=password]')`), { ms: 10000, label: 'key prompt' });
	const prompt = await page.eval(`(document.querySelector('.quick-input-widget .quick-input-message') || {}).textContent`);
	check('the key prompt says where the key is kept, truthfully for a tab', /this browser/i.test(String(prompt)) && !/keychain/i.test(String(prompt)), JSON.stringify(prompt));
	await page.type(KEY);
	await page.key('Enter', 'Enter');
	await sleep(800);

	// the chat webview
	const activate = async () => {
		const r = await page.eval(`(() => { const t = [...document.querySelectorAll('.tabs-container .tab')].find((e) => /LevelCode AI/.test(e.getAttribute('aria-label') || '')); const b = t.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`);
		await page.click(r.x, r.y);
		await sleep(700);
	};
	await activate();
	const inChat = async (expr) => {
		for (const [id, s] of page.sessions) {
			if (s.type !== 'iframe') { continue; }
			try {
				const v = await page.eval(`(() => { const f = document.getElementById('active-frame'); if (!f || !f.contentDocument || !f.contentDocument.getElementById('input')) { return { __no: true }; } const d = f.contentDocument; return { v: (${expr}) }; })()`, { sessionId: id });
				if (v && !v.__no) { return v.v; }
			} catch { /* another frame */ }
		}
		return undefined;
	};
	await page.waitFor(async () => (await inChat('!!d.getElementById("send")')) === true, { ms: 30000, label: 'chat' });
	const label = await inChat(`(d.getElementById('st-key') || {}).textContent`);
	check('the chat shows that it is using a key of the user\'s own', /BYO|key/i.test(String(label)), JSON.stringify(label));
	await inChat(`(() => { const i = d.getElementById('input'); i.focus(); if ('value' in i) { i.value = 'Please create a hello file'; } else { i.textContent = 'Please create a hello file'; } i.dispatchEvent(new Event('input', { bubbles: true })); d.getElementById('send').click(); return true; })()`);
	await page.waitFor(() => stub.state.chats >= 2, { ms: 60000, label: 'two model turns' }).catch(() => null);
	check('the agent reached the provider straight from the tab', stub.state.chats >= 2, 'turns: ' + stub.state.chats);
	const auth = stub.state.byokAuth || [];
	check('the request carried the user\'s key, and only that', auth.length > 0 && auth.every((a) => a === 'Bearer ' + KEY), JSON.stringify(auth.slice(0, 2)));
	check('no LevelCode account call was made (no sign-in, no gateway)', !stub.state.log.some((e) => /^\/api\/levelcode\/v1\/(ai|auth)\//.test(e.path)), JSON.stringify(stub.state.log.filter((e) => e.path.startsWith('/api')).map((e) => e.path).slice(0, 4)));
} catch (e) {
	check('the run completed', false, String((e && e.stack) || e));
}
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
await finish(failed ? 1 : 0);
