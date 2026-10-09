#!/usr/bin/env node
// End-to-end check of LevelCode in the browser, in a real (headless) Chrome:
//
//   boot -> sign in through the real extension code and the real callback page -> ask the agent to
//   create a file -> the file exists in the scratch workspace -> reload and still be signed in.
//
// The backend is the stand-in in ./stub-backend.mjs, which applies the same redirect and CORS rules
// the real one must. It proves the editor's half of the contract; thin.ly's half is its own specs.
//
//   node web/test/e2e.mjs --static <vscode-web dir> --extensions <built extensions dir> [--shots <dir>]
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
const SHOTS = args.shots ? path.resolve(args.shots) : null;
const EDITOR_PORT = Number(args.port || 8801);
const editorOrigin = `http://127.0.0.1:${EDITOR_PORT}`;
if (!fs.existsSync(STATIC) || !fs.existsSync(EXTS)) { console.error('usage: e2e.mjs --static <vscode-web dir> --extensions <dir>'); process.exit(2); }
if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); }

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); return ok; };
const shot = async (page, name) => { if (SHOTS) { await page.screenshot(path.join(SHOTS, name + '.png')); } };

const stub = await startStub({ editorOrigin });
const server = spawn(process.execPath, [path.join(HERE, '..', 'serve.mjs'), '--static', STATIC, '--extensions', EXTS,
	'--extension-names', args['extension-names'] || 'levelcode-ai,levelcode-web', '--account', stub.origin, '--port', String(EDITOR_PORT)], { stdio: 'inherit' });
let chrome;
const finish = async (code) => { try { chrome && chrome.close(); } catch {} try { server.kill(); } catch {} try { await stub.close(); } catch {} process.exit(code); };
process.on('SIGINT', () => finish(130));

try {
	for (let i = 0; i < 50; i++) { try { if ((await fetch(editorOrigin + '/')).ok) { break; } } catch {} await sleep(100); }
	chrome = await Chrome.launch({ port: Number(args['debug-port'] || 9555), args: ['--ignore-certificate-errors'] });
	const page = await chrome.newPage(editorOrigin + '/');

	const workbenchReady = () => page.waitFor(() => page.eval(`!!document.querySelector('.monaco-workbench .part.editor')`), { ms: 90000, label: 'workbench' });
	const rectOfText = (re) => page.eval(`(() => {
		const re = new RegExp(${JSON.stringify(re.source)}, ${JSON.stringify(re.flags)});
		const els = [...document.querySelectorAll('a, button, span, .monaco-button, .tab, .label-name')].filter((e) => e.children.length === 0 && re.test(e.textContent || ''));
		const e = els.find((x) => x.getBoundingClientRect().width > 0);
		if (!e) { return null; }
		const r = e.getBoundingClientRect();
		return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
	})()`);
	const clickText = async (re, label) => {
		const r = await page.waitFor(() => rectOfText(re), { ms: 30000, label: label || String(re) });
		await page.click(r.x, r.y);
	};
	const activateTab = async (re) => {
		const r = await page.waitFor(() => page.eval(`(() => {
			const re = new RegExp(${JSON.stringify(re.source)}, ${JSON.stringify(re.flags)});
			const t = [...document.querySelectorAll('.tabs-container .tab')].find((e) => re.test(e.getAttribute('aria-label') || ''));
			if (!t) { return null; }
			const b = t.getBoundingClientRect();
			return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
		})()`), { ms: 30000, label: 'tab ' + re });
		await page.click(r.x, r.y);
		await sleep(600);
	};
	const chatSession = () => {
		for (const [id, s] of page.sessions) { if (s.type === 'iframe' && /vscode-cdn\.net|vscode-webview/.test(s.url || '')) { return id; } }
		return null;
	};
	/** Evaluate in the chat webview's document. `d` is that document. */
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
	/** A real mouse click on an element of the chat webview (a script click is not a user gesture, and the sign-in page is a popup). */
	const clickInChat = async (selector) => {
		const inner = await inChat(`(() => { const e = d.querySelector(${JSON.stringify(selector)}); if (!e) { return null; } const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
		if (!inner) { throw new Error('not in the chat: ' + selector); }
		const frame = await page.eval(`(() => { const f = [...document.querySelectorAll('iframe')].find((i) => /vscode-cdn|vscode-webview/.test(i.src) && i.getBoundingClientRect().width > 0); if (!f) { return null; } const r = f.getBoundingClientRect(); return { x: r.x, y: r.y }; })()`);
		if (!frame) { throw new Error('no visible webview frame'); }
		if (process.env.E2E_DEBUG) { console.log('  click', selector, 'inner', JSON.stringify(inner), 'frame', JSON.stringify(frame)); }
		await page.click(frame.x + inner.x, frame.y + inner.y);
		await sleep(400);
	};
	const scratchFile = (p) => page.eval(`new Promise((res, rej) => { const r = indexedDB.open('levelcode-scratch'); r.onsuccess = () => { const g = r.result.transaction('nodes').objectStore('nodes').get(${JSON.stringify(p)}); g.onsuccess = () => res(g.result ? new TextDecoder().decode(g.result.data) : null); g.onerror = () => rej(g.error); }; r.onerror = () => rej(r.error); })`);

	/* 1. boot */
	await workbenchReady();
	check('the workbench boots from static files', true);
	const tabs = await page.waitFor(async () => {
		const t = await page.eval(`[...document.querySelectorAll('.tabs-container .tab')].map((e) => e.getAttribute('aria-label') || '')`);
		return t.some((x) => /LevelCode AI/.test(x)) ? t : null;
	}, { ms: 60000, label: 'LevelCode AI tab' }).catch(() => null);
	check('the LevelCode AI extension activates in the web worker and opens its chat', !!tabs, JSON.stringify(tabs));
	const rows = await page.waitFor(async () => {
		const r = await page.eval(`[...document.querySelectorAll('.explorer-folders-view .monaco-list-row')].map((e) => e.getAttribute('aria-label'))`);
		return r.length ? r : null;
	}, { ms: 30000, label: 'explorer rows' }).catch(() => null);
	check('the scratch workspace is open and has its README', !!rows && rows.includes('README.md'), JSON.stringify(rows));
	await shot(page, '1-boot');

	/* 2. sign in: the user icon in the chat footer opens the account card, which has "Sign in with browser" */
	// First-run Welcome opens a moment after startup and takes the focus; let it settle, then go to the chat.
	await page.waitFor(async () => (await page.eval(`[...document.querySelectorAll('.tabs-container .tab')].some((e) => /Welcome/.test(e.getAttribute('aria-label') || ''))`)), { ms: 30000, label: 'Welcome tab' }).catch(() => null);
	await sleep(1500);
	await activateTab(/LevelCode AI/);
	await page.waitFor(async () => (await inChat('!!d.getElementById("acctBtn")')) === true, { ms: 30000, label: 'chat account button' });
	await clickInChat('#acctBtn');
	await page.waitFor(async () => (await inChat('!!d.querySelector("[data-act=signin]")')) === true, { ms: 15000, label: 'sign-in button' });
	await shot(page, '1b-account-card');
	await clickInChat('[data-act="signin"]');
	await page.waitFor(() => stub.state.log.some((e) => e.path === '/api/levelcode/v1/auth/exchange'), { ms: 45000, label: 'code exchange' }).catch(() => null);
	check('the sign-in page accepted the editor callback and returned a code', stub.state.signIns >= 1);
	const exchanged = stub.state.log.some((e) => e.path === '/api/levelcode/v1/auth/exchange' && e.origin === editorOrigin);
	check('the editor exchanged the code from the editor origin (CORS answered)', exchanged);
	await page.waitFor(() => stub.state.log.some((e) => e.path === '/api/levelcode/v1/account/profile' && e.auth), { ms: 20000, label: 'profile call' }).catch(() => null);
	check('the editor used its session token against the account API', stub.state.log.some((e) => e.path === '/api/levelcode/v1/account/profile' && e.auth));
	await shot(page, '2-signed-in');

	/* 3. chat and agent */
	await activateTab(/LevelCode AI/);
	await page.waitFor(async () => (await inChat('!!d.getElementById("send")')) === true, { ms: 30000, label: 'chat webview' });
	check('the chat webview renders from the editor', true);
	await inChat(`(() => { const i = d.getElementById('input'); i.focus(); if ('value' in i) { i.value = 'Please create a hello file'; } else { i.textContent = 'Please create a hello file'; } i.dispatchEvent(new Event('input', { bubbles: true })); d.getElementById('send').click(); return true; })()`);
	await page.waitFor(() => stub.state.chats >= 2, { ms: 60000, label: 'two model turns' }).catch(() => null);
	check('the agent called the model through the gateway and got the tool result back', stub.state.chats >= 2, 'turns: ' + stub.state.chats);
	const body = await scratchFile('/hello.txt');
	check('write_file created hello.txt in the scratch workspace', body === 'hello from the browser\n', JSON.stringify(body));
	const tools = (stub.state.lastChatBody && stub.state.lastChatBody.tools || []).map((t) => t.function && t.function.name);
	check('the agent was not offered a shell', tools.length > 0 && !tools.includes('run_command') && tools.includes('write_file'), tools.join(','));
	await sleep(1500);
	await shot(page, '3-agent');

	/* 4. a reload keeps the session and the files */
	const before = stub.state.log.filter((e) => e.path === '/api/levelcode/v1/account/models' || e.path === '/api/levelcode/v1/account/profile').length;
	await page.goto(editorOrigin + '/');
	await workbenchReady();
	await page.waitFor(() => stub.state.log.filter((e) => e.path === '/api/levelcode/v1/account/models' || e.path === '/api/levelcode/v1/account/profile').length > before, { ms: 30000, label: 'account call after reload' }).catch(() => null);
	const after = stub.state.log.filter((e) => e.path === '/api/levelcode/v1/account/models' || e.path === '/api/levelcode/v1/account/profile').length;
	check('after a reload the editor is still signed in', after > before, `${before} -> ${after}`);
	check('after a reload the scratch file is still there', (await scratchFile('/hello.txt')) === 'hello from the browser\n');
	await shot(page, '4-reload');
} catch (e) {
	check('the run completed', false, String((e && e.stack) || e));
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
await finish(failed.length ? 1 : 0);
