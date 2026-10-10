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
const DIST = args.dist ? path.resolve(args.dist) : null;   // a release from scripts/build-web.mjs, served with its own _headers
const STATIC = path.resolve(args.static || process.env.LEVELCODE_WEB_STATIC || '');
const EXTS = path.resolve(args.extensions || process.env.LEVELCODE_WEB_EXTENSIONS || '');
const SHOTS = args.shots ? path.resolve(args.shots) : null;
const EDITOR_PORT = Number(args.port || 8801);
// `localhost`, not 127.0.0.1: the extension host's own iframe policy admits https: and http://localhost:*.
const editorOrigin = `http://localhost:${EDITOR_PORT}`;
if (DIST ? !fs.existsSync(DIST) : (!fs.existsSync(STATIC) || !fs.existsSync(EXTS))) {
	console.error('usage: e2e.mjs --dist <release dir>   |   e2e.mjs --static <vscode-web dir> --extensions <dir>   [--stub-port N] [--shots dir]');
	process.exit(2);
}
if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); }

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); return ok; };
const shot = async (page, name) => { if (SHOTS) { await page.screenshot(path.join(SHOTS, name + '.png')); } };

// A release has its account origin baked into index.html, so the stand-in has to be where it was built to look.
const stub = await startStub({ editorOrigin, port: args['stub-port'] ? Number(args['stub-port']) : 0 });
const server = spawn(process.execPath, [path.join(HERE, '..', 'serve.mjs'), '--port', String(EDITOR_PORT), ...(DIST
	? ['--dist', DIST]
	: ['--static', STATIC, '--extensions', EXTS, '--extension-names', args['extension-names'] || 'levelcode-ai,levelcode-web', '--account', stub.origin,
		...(args.product ? ['--product', args.product] : [])])], { stdio: 'inherit' });
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
	// With the extension host isolated on its own origin (--product with webEndpointUrlTemplate) the scratch
	// workspace's IndexedDB belongs to THAT origin and the page cannot open it; the agent's read_file can.
	let hardened = /webEndpointUrlTemplate/.test(args.product || '');
	if (DIST) { try { hardened = /\(same origin/.test(fs.readFileSync(path.join(DIST, 'build.json'), 'utf8')) ? false : true; } catch { /* keep */ } }
	const scratchFile = hardened ? (async (p) => {
		await ask('Please read ' + p.replace(/^\/scratch\//, ''));
		const t = lastToolResult();
		return /ERROR/.test(t) ? null : t;
	}) : (p) => page.eval(`new Promise((res, rej) => { const r = indexedDB.open('levelcode-scratch'); r.onsuccess = () => { const g = r.result.transaction('nodes').objectStore('nodes').get(${JSON.stringify(p)}); g.onsuccess = () => res(g.result ? new TextDecoder().decode(g.result.data) : null); g.onerror = () => rej(g.error); }; r.onerror = () => rej(r.error); })`);

	/* 1. boot */
	await workbenchReady();
	check('the workbench boots from static files', true);
	const tabs = await page.waitFor(async () => {
		const t = await page.eval(`[...document.querySelectorAll('.tabs-container .tab')].map((e) => e.getAttribute('aria-label') || '')`);
		return t.some((x) => /LevelCode AI/.test(x)) ? t : null;
	}, { ms: 60000, label: 'LevelCode AI tab' }).catch(() => null);
	check('the LevelCode AI extension activates in the web worker and opens its chat', !!tabs, JSON.stringify(tabs));
	// The first layout is the chat on its own, side bars away; the Explorer is one command from there.
	await sleep(3000);
	check('the first screen is the chat on its own, with no side bar', !(await page.eval(`(() => { const s = document.querySelector('.part.sidebar'); return !!s && s.getBoundingClientRect().width > 0; })()`)));
	await page.palette('View: Show Explorer');
	const rows = await page.waitFor(async () => {
		const r = await page.eval(`[...document.querySelectorAll('.explorer-folders-view .monaco-list-row')].map((e) => e.getAttribute('aria-label'))`);
		return r.length ? r : null;
	}, { ms: 30000, label: 'explorer rows' }).catch(() => null);
	check('the scratch workspace is open and has its README', !!rows && rows.includes('README.md'), JSON.stringify(rows));
	const title = await page.waitFor(async () => { const t = await page.eval('document.title'); return /scratch/i.test(t) ? t : null; }, { ms: 10000, label: 'window title' }).catch(() => page.eval('document.title'));
	check('the workspace is called "scratch" (the window title), not "/"', /scratch/i.test(String(title)), JSON.stringify(title));
	await shot(page, '1-boot');

	/* 2. sign in: the user icon in the chat footer opens the account card, which has "Sign in with browser" */
	// The desktop's first-run Welcome page opens a moment after startup and takes the focus; in the browser edition it
	// is switched off (web/ai-extension/copy.js) and the chat is the first thing there is. Give it the time it needs
	// on the desktop (the extension opens it 900 ms after activation), then check that it did not come.
	await sleep(4000);
	check('no Welcome page opens in front of the chat', !(await page.eval(`[...document.querySelectorAll('.tabs-container .tab')].some((e) => /Welcome/.test(e.getAttribute('aria-label') || ''))`)));
	await activateTab(/LevelCode AI/);
	await page.waitFor(async () => (await inChat('!!d.getElementById("acctBtn")')) === true, { ms: 30000, label: 'chat account button' });
	await clickInChat('#acctBtn');
	await page.waitFor(async () => (await inChat('!!d.querySelector("[data-act=signin]")')) === true, { ms: 15000, label: 'sign-in button' });
	await shot(page, '1b-account-card');
	await clickInChat('[data-act="signin"]');
	await page.waitFor(() => stub.state.log.some((e) => e.path === '/api/levelcode/v1/auth/exchange'), { ms: 45000, label: 'code exchange' }).catch(() => null);
	check('the sign-in page accepted the editor callback and returned a code', stub.state.signIns >= 1);
	const exchangeOrigin = (stub.state.log.find((e) => e.path === '/api/levelcode/v1/auth/exchange' && e.method === 'POST') || {}).origin;
	check('the editor exchanged the code across origins (CORS answered)', !!exchangeOrigin, 'from ' + exchangeOrigin);
	await page.waitFor(() => stub.state.log.some((e) => e.path === '/api/levelcode/v1/account/profile' && e.auth), { ms: 20000, label: 'profile call' }).catch(() => null);
	check('the editor used its session token against the account API', stub.state.log.some((e) => e.path === '/api/levelcode/v1/account/profile' && e.auth));
	await shot(page, '2-signed-in');

	/* 3. chat and agent */
	await activateTab(/LevelCode AI/);
	await page.waitFor(async () => (await inChat('!!d.getElementById("send")')) === true, { ms: 30000, label: 'chat webview' });
	// Signing in leaves the account card open over the chat, as it does on the desktop; close it like a user would.
	if ((await inChat(`getComputedStyle(d.getElementById('acctClose')).display !== 'none' && d.getElementById('acctClose').offsetParent !== null`)) === true) {
		await clickInChat('#acctClose');
		await sleep(400);
	}
	check('the chat webview renders from the editor', true);
	/** Send a prompt and wait for the agent to finish its turns (a tool call, then its answer). */
	const idle = () => inChat(`!d.getElementById('send').classList.contains('stop')`);
	const ask = async (prompt, turns = 2) => {
		await page.waitFor(async () => (await idle()) === true, { ms: 90000, label: 'the agent to be idle' }).catch(() => null);
		const start = stub.state.chats;
		await inChat(`(() => { const i = d.getElementById('input'); i.focus(); if ('value' in i) { i.value = ${JSON.stringify(prompt)}; } else { i.textContent = ${JSON.stringify(prompt)}; } i.dispatchEvent(new Event('input', { bubbles: true })); d.getElementById('send').click(); return true; })()`);
		await page.waitFor(() => stub.state.chats >= start + turns, { ms: 60000, label: 'model turns for ' + prompt }).catch(() => null);
		const t0 = Date.now();
		await page.waitFor(async () => (await idle()) === true, { ms: 90000, label: 'the run to finish' }).catch(() => null);
		if (process.env.E2E_DEBUG) { console.log('  run finished ' + (Date.now() - t0) + ' ms after its last model turn'); }
		await sleep(300);
		return stub.state.chats - start;
	};
	/** The tool result the model was handed on its most recent request. */
	const lastToolResult = () => {
		const msgs = (stub.state.lastChatBody && stub.state.lastChatBody.messages) || [];
		const t = [...msgs].reverse().find((m) => m.role === 'tool');
		return t ? (typeof t.content === 'string' ? t.content : JSON.stringify(t.content)) : '';
	};

	const turns = await ask('Please create a hello file');
	check('the agent called the model through the gateway and got the tool result back', turns >= 2, 'turns: ' + turns);
	check('write_file created hello.txt in the scratch workspace', (await scratchFile('/scratch/hello.txt')) === 'hello from the browser\n', JSON.stringify(await scratchFile('/scratch/hello.txt')));
	const tools = (stub.state.lastChatBody && stub.state.lastChatBody.tools || []).map((t) => t.function && t.function.name);
	check('the agent was not offered a shell', tools.length > 0 && !tools.includes('run_command') && !tools.includes('read_command_output') && tools.includes('write_file'), tools.join(','));
	await shot(page, '3-agent');

	await ask('Please list the files');
	const listed = lastToolResult();
	if (process.env.E2E_DEBUG) { console.log('  chat log:', JSON.stringify(((await inChat(`(d.getElementById('log') || {}).innerText`)) || '').slice(-700))); console.log('  turns so far:', stub.state.chats, 'last request tools:', (stub.state.lastChatBody.messages || []).slice(-3).map((m) => m.role + ':' + String(typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).slice(0, 80)).join(' | ')); }
	check('list_files sees the scratch workspace (findFiles is answered by the scratch search provider)', /README\.md/.test(listed) && /hello\.txt/.test(listed), JSON.stringify(listed.slice(0, 120)));
	await ask('Please search the project');
	const found = lastToolResult();
	check('search finds text without ripgrep', /hello\.txt:1:hello from the browser/.test(found), JSON.stringify(found.slice(0, 160)));
	await ask('Please read the greeting');
	check('read_file returns the file', /hello from the browser/.test(lastToolResult()), JSON.stringify(lastToolResult().slice(0, 80)));
	await ask('Please change the greeting');
	check('edit_file edits it in place', (await scratchFile('/scratch/hello.txt')) === 'hello again\n', JSON.stringify(await scratchFile('/scratch/hello.txt')));
	await shot(page, '3b-edited');

	// Quick Open is answered by the same provider.
	await page.key('p', 'KeyP', 4);
	let quick = await page.waitFor(() => page.eval(`!!document.querySelector('.quick-input-widget:not([style*="display: none"]) .quick-input-box')`), { ms: 4000, label: 'quick open' }).catch(() => null);
	if (!quick) { await page.key('p', 'KeyP', 2); quick = await page.waitFor(() => page.eval(`!!document.querySelector('.quick-input-widget:not([style*="display: none"]) .quick-input-box')`), { ms: 4000, label: 'quick open' }).catch(() => null); }
	if (quick) {
		await page.type('hello');
		await sleep(1500);
		const entries = await page.eval(`[...document.querySelectorAll('.quick-input-list .monaco-list-row')].map((e) => e.getAttribute('aria-label') || e.textContent)`);
		check('Quick Open finds files in the scratch workspace', entries.some((t) => /hello\.txt/.test(t)), JSON.stringify(entries.slice(0, 4)));
		await page.key('Escape', 'Escape');
		await page.waitFor(() => page.eval(`(() => { const w = document.querySelector('.quick-input-widget'); return !w || getComputedStyle(w).display === 'none'; })()`), { ms: 5000, label: 'quick open to close' }).catch(() => null);
	} else { check('Quick Open finds files in the scratch workspace', false, 'the quick open widget did not appear'); }
	await activateTab(/LevelCode AI/);   // focus goes back to the chat before it is clicked

	// Review: an agent edit is applied at once and offered for Keep or Undo. Undo of a file the agent created removes it.
	await ask('Please make a notes file');
	check('the agent created notes.md', (await scratchFile('/scratch/notes.md')) === 'notes\n');
	await page.waitFor(async () => (await inChat(`getComputedStyle(d.getElementById('reviewBar')).display !== 'none'`)) === true, { ms: 10000, label: 'review bar' }).catch(() => null);
	check('the chat offers Keep and Undo for it', (await inChat(`getComputedStyle(d.getElementById('reviewBar')).display !== 'none' && !!d.querySelector('#reviewBar .keepall') && !!d.querySelector('#reviewBar .undoall')`)) === true);
	await shot(page, '3c-review');
	await clickInChat('#reviewBar .undoall');
	await sleep(2000);
	check('Undo all removes the file the agent created', (await scratchFile('/scratch/notes.md')) === null);
	check('and everything else still pending: hello.txt, created and edited earlier in the session, is gone too', (await scratchFile('/scratch/hello.txt')) === null);
	await ask('Please make a notes file');
	await page.waitFor(async () => (await inChat(`getComputedStyle(d.getElementById('reviewBar')).display !== 'none'`)) === true, { ms: 10000, label: 'review bar' }).catch(() => null);
	await clickInChat('#reviewBar .keepall');
	await sleep(1500);
	check('Keep all keeps it, and the review bar goes away', (await scratchFile('/scratch/notes.md')) === 'notes\n' && (await inChat(`getComputedStyle(d.getElementById('reviewBar')).display === 'none'`)) === true);

	/* 4. a reload keeps the session and the files */
	const before = stub.state.log.filter((e) => e.path === '/api/levelcode/v1/account/models' || e.path === '/api/levelcode/v1/account/profile').length;
	await page.goto(editorOrigin + '/');
	await workbenchReady();
	await page.waitFor(() => stub.state.log.filter((e) => e.path === '/api/levelcode/v1/account/models' || e.path === '/api/levelcode/v1/account/profile').length > before, { ms: 30000, label: 'account call after reload' }).catch(() => null);
	const after = stub.state.log.filter((e) => e.path === '/api/levelcode/v1/account/models' || e.path === '/api/levelcode/v1/account/profile').length;
	check('after a reload the editor is still signed in', after > before, `${before} -> ${after}`);
	check('after a reload the file that was kept is still there', (await scratchFile('/scratch/notes.md')) === 'notes\n');
	await shot(page, '4-reload');

	/* 5. a folder from "the computer". The OS picker needs a person, so the page's File System Access entry point is
	      replaced by one that hands back a real FileSystemDirectoryHandle (a folder of the origin-private file system);
	      everything after the picker — the command, the workbench's file provider, the agent's reads and writes — is real. */
	await page.eval(`(async () => {
		const root = await navigator.storage.getDirectory();
		try { await root.removeEntry('project', { recursive: true }); } catch (e) {}
		const dir = await root.getDirectoryHandle('project', { create: true });
		const f = await dir.getFileHandle('main.py', { create: true });
		const w = await f.createWritable(); await w.write('print("hello from main.py")\\n'); await w.close();
		window.showDirectoryPicker = async () => { const r = await navigator.storage.getDirectory(); return r.getDirectoryHandle('project', { create: true }); };
		return true;
	})()`);
	await page.palette('Open Folder from Your Computer');
	const folderRows = await page.waitFor(async () => {
		const r = await page.eval(`[...document.querySelectorAll('.explorer-folders-view .monaco-list-row')].map((e) => e.getAttribute('aria-label'))`);
		return r.some((x) => /main\.py/.test(x)) ? r : null;
	}, { ms: 90000, label: 'the folder in the Explorer' }).catch(() => null);
	check('"Open Folder from Your Computer" opens the folder the picker returned, and the Explorer lists its file', !!folderRows, JSON.stringify(folderRows));
	const folderWindow = await page.eval('document.title');
	check('the workspace is that folder (the window title), not the scratch workspace', /project/.test(String(folderWindow)) && !/scratch/i.test(String(folderWindow)), JSON.stringify(folderWindow));
	await shot(page, '5-folder');
	const opfs = (name) => page.eval(`(async () => { try { const root = await navigator.storage.getDirectory(); const dir = await root.getDirectoryHandle('project'); const f = await dir.getFileHandle(${JSON.stringify(name)}); return await (await f.getFile()).text(); } catch (e) { return null; } })()`);
	await activateTab(/LevelCode AI/);
	await page.waitFor(async () => (await inChat('!!d.getElementById("send")')) === true, { ms: 30000, label: 'chat webview' });
	await ask('Please list the files');
	check('list_files sees the folder\'s files (the workbench searches a File System Access folder)', /main\.py/.test(lastToolResult()), JSON.stringify(lastToolResult().slice(0, 120)));
	await ask('Please read main.py');
	check('read_file reads a file of the folder through the browser\'s file handle', /hello from main\.py/.test(lastToolResult()), JSON.stringify(lastToolResult().slice(0, 120)));
	await ask('Please make a notes file');
	let notes = null;
	for (let i = 0; i < 20 && notes === null; i++) { notes = await opfs('notes.md'); if (notes === null) { await sleep(500); } }
	check('write_file creates the file in the folder on "the computer"', notes === 'notes\n', JSON.stringify(notes));
	await shot(page, '5b-folder-agent');
} catch (e) {
	check('the run completed', false, String((e && e.stack) || e));
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
await finish(failed.length ? 1 : 0);
