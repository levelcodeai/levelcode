#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  LevelCode — web_search and web_fetch, checked in the REAL editor (docs/WEB-SEARCH.md)
 *
 *  The tests run the decisions; this runs the product: the dev build (vscode/.build/electron) as a throwaway
 *  instance with THIS checkout's extension, driven through the DevTools protocol (the harness of
 *  working-aura-editor-check.js). One local server stands in for three things:
 *    the model        an OpenAI-compatible stream: search with two queries, open a result, answer with a link
 *    Brave Search     /brave, the API's own response shape, and it records each query and when it came
 *    two web pages    /page/openeox and /page/csaf
 *  The key is set the way a person sets it (the command palette: "Set Web Search Key"), and the goal is the one
 *  in the shape the owner compared with ChatGPT.app. It checks what the model was offered and told, what the search API was
 *  asked, what the model read back, and what the chat shows; then turns web search off and checks the model is
 *  told why.
 *
 *  Pages on 127.0.0.1 are refused by the extension (they are this machine); the editor is started with
 *  LEVELCODE_WEB_ALLOW_PRIVATE=1 so it can read the stand-in's, and LEVELCODE_WEB_BRAVE_URL points Brave at it.
 *
 *  RUN:   node extensions/levelcode-ai/scripts/web-search-editor-check.js [--vscode <dir>] [--out <dir>] [--keep]
 *         From a worktree, pass the main checkout's build:  --vscode <main checkout>/vscode
 *  NEEDS: the dev build (./scripts/run-dev.sh has been run once), macOS or Linux, Node 22+.
 *  EXIT:  0 all checks pass · 1 a check failed · 2 could not run (no build, no window).
 *--------------------------------------------------------------------------------------------*/
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const cp = require('child_process');

const EXT = path.join(__dirname, '..');
const REPO = path.join(EXT, '..', '..');
const argv = process.argv.slice(2);
const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const VSCODE_DIR = path.resolve(opt('--vscode') || process.env.LEVELCODE_VSCODE_DIR || path.join(REPO, 'vscode'));
const OUT = path.resolve(opt('--out') || fs.mkdtempSync(path.join(os.tmpdir(), 'lc-web-editor-')));
const KEEP = argv.includes('--keep');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const GOAL = 'Please investigate about the Dana Okafor from Northwind Systems';
const KEY = 'stand-in-brave-key';
const QUERIES = ['"Dana Okafor" Northwind', '"Dana Okafor" OpenEoX'];

// ---- the stand-in: model, search API and pages on one port ----------------------------------------------
const modelCalls = [];     // { tools, system, lastTool, toolResult }
const braveCalls = [];     // { q, token, at }
const pageHits = [];
let base = '';
function page(title, body) { return '<!doctype html><html><head><title>' + title + '</title><script>window.steal=1</script></head><body><nav>Home · Docs</nav><main><h1>' + title + '</h1>' + body + '</main><footer>© OASIS</footer></body></html>'; }
const PAGES = {
	'/page/openeox': page('OpenEoX technical report', '<p>Published 24 April 2025.</p><p>Coauthors: Dana Okafor (Northwind Systems), Omar Santos (Northwind Systems), and others.</p><p>' + 'The report covers end-of-life data exchange. '.repeat(40) + '</p><p>See also the <a href="/page/csaf">CSAF 2.1 specification</a>.</p>'),
	'/page/csaf': page('CSAF 2.1 specification', '<p>Acknowledgments: Dana Okafor, Northwind Systems.</p>'),
};
function startServer() {
	return new Promise((resolve) => {
		const server = http.createServer((req, res) => {
			const u = new URL(req.url, 'http://x');
			if (req.method === 'GET' && u.pathname === '/brave') {
				braveCalls.push({ q: u.searchParams.get('q'), token: req.headers['x-subscription-token'], extra: u.searchParams.get('extra_snippets'), at: Date.now() });
				setTimeout(() => {
					res.writeHead(200, { 'content-type': 'application/json' });
					res.end(JSON.stringify({ web: { results: [
						{ title: 'OpenEoX technical report', url: base + '/page/openeox', description: 'Coauthors include Dana Okafor (Northwind Systems).', page_age: '2025-04-24T00:00:00', extra_snippets: ['OASIS OpenEoX TC'] },
						{ title: 'CSAF 2.1 specification', url: base + '/page/csaf', description: 'Acknowledgments list Northwind Systems contributors.' },
					] } }));
				}, 300);   // a search API takes a moment; two queries in parallel take one moment, not two
				return;
			}
			if (req.method === 'GET' && PAGES[u.pathname]) { pageHits.push(u.pathname); res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(PAGES[u.pathname]); return; }
			let body = '';
			req.on('data', (c) => { body += c; });
			req.on('end', () => {
				let j = {}; try { j = JSON.parse(body || '{}'); } catch (e) { /* not JSON */ }
				if (req.method === 'GET') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ data: [{ id: 'stand-in' }] })); return; }
				if (!j.stream) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Web check' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 3 } })); return; }
				const msgs = Array.isArray(j.messages) ? j.messages : [];
				const tools = (j.tools || []).map((t) => t.function && t.function.name);
				const system = msgs.length && msgs[0].role === 'system' ? String(msgs[0].content) : '';
				const last = msgs[msgs.length - 1] || {};
				let lastTool = null;
				if (last.role === 'tool') { const call = [...msgs].reverse().find((m) => m.role === 'assistant' && m.tool_calls); lastTool = call ? call.tool_calls[0].function.name : null; }
				modelCalls.push({ tools, system, lastTool, toolResult: last.role === 'tool' ? String(last.content) : null });
				res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
				const send = (o) => res.write('data: ' + JSON.stringify(o) + '\n\n');
				const chunk = (delta, finish) => send({ id: 'c1', object: 'chat.completion.chunk', model: j.model, choices: [{ index: 0, delta, finish_reason: finish || null }] });
				const call = (name, args) => { chunk({ tool_calls: [{ index: 0, id: 'call_' + modelCalls.length, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }); chunk({}, 'tool_calls'); };
				if (!tools.includes('web_search')) { chunk({ content: 'Done: there is no web access in this session.' }); chunk({}, 'stop'); }
				else if (!lastTool) { chunk({ content: 'I will search public records first.' }); call('web_search', { queries: QUERIES }); }
				else if (lastTool === 'web_search') { call('web_fetch', { url: base + '/page/openeox', find: 'Okafor' }); }
				else { chunk({ content: '## Summary\n\nDana Okafor coauthored the [OpenEoX technical report](' + base + '/page/openeox) (24 April 2025) as a Northwind Systems contributor, and the [CSAF 2.1 specification](' + base + '/page/csaf) acknowledges him.' }); chunk({}, 'stop'); }
				send({ id: 'c1', object: 'chat.completion.chunk', model: j.model, choices: [], usage: { prompt_tokens: 50, completion_tokens: 5 } });
				res.write('data: [DONE]\n\n'); res.end();
			});
		});
		server.listen(0, '127.0.0.1', () => { base = 'http://127.0.0.1:' + /** @type {import('net').AddressInfo} */ (server.address()).port; resolve(server); });
	});
}

// ---- a minimal DevTools-protocol client (Node's own WebSocket and fetch) ----
function connect(wsUrl) {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(wsUrl);
		let id = 0; const pending = new Map(); const events = [];
		ws.onopen = () => resolve({
			send: (method, params) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params: params || {} })); }),
			events, close: () => { try { ws.close(); } catch (e) { /* closed */ } }
		});
		ws.onerror = () => reject(new Error('could not connect to ' + wsUrl));
		ws.onmessage = (m) => {
			const o = JSON.parse(m.data);
			if (o.id && pending.has(o.id)) { const p = pending.get(o.id); pending.delete(o.id); if (o.error) { p.rej(new Error(o.error.message)); } else { p.res(o.result); } }
			else if (o.method) { events.push(o); }
		};
	});
}
async function evalIn(c, expression) {
	const r = await Promise.race([
		c.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }),
		new Promise((_, reject) => setTimeout(() => reject(new Error('the page did not answer in 15 s (was it replaced?)')), 15000))
	]);
	if (r.exceptionDetails) { throw new Error('the page threw: ' + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text)); }
	return r.result.value;
}
const targets = async (port) => { try { return await (await fetch('http://127.0.0.1:' + port + '/json/list')).json(); } catch (e) { return []; } };
async function until(what, fn, ms) {
	const end = Date.now() + (ms || 30000);
	for (;;) { const v = await fn(); if (v) { return v; } if (Date.now() > end) { throw new Error('timed out waiting for ' + what); } await sleep(200); }
}

async function main() {
	if (typeof WebSocket !== 'function' || typeof fetch !== 'function') { console.error('Needs Node 22 or newer (for its built-in WebSocket).'); return 2; }
	let product;
	try { product = JSON.parse(fs.readFileSync(path.join(VSCODE_DIR, 'product.json'), 'utf8')); }
	catch (e) { console.error('No editor build at ' + VSCODE_DIR + '. Run ./scripts/run-dev.sh once in the checkout that has vscode/, then pass that folder with --vscode.'); return 2; }
	const exe = process.platform === 'darwin'
		? path.join(VSCODE_DIR, '.build', 'electron', product.nameLong + '.app', 'Contents', 'MacOS', product.nameShort)
		: path.join(VSCODE_DIR, '.build', 'electron', product.applicationName);
	if (!fs.existsSync(exe)) { console.error('The editor has not been built yet (' + exe + ' is missing). Run ./scripts/run-dev.sh once.'); return 2; }

	fs.mkdirSync(OUT, { recursive: true });
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-web-check-'));
	const profile = path.join(tmp, 'profile'), exts = path.join(tmp, 'extensions'), workspace = path.join(tmp, 'workspace'), sessions = path.join(tmp, 'sessions');
	for (const d of [path.join(profile, 'User'), exts, workspace, sessions]) { fs.mkdirSync(d, { recursive: true }); }
	fs.writeFileSync(path.join(workspace, 'README.md'), '# web\n');
	const server = await startServer();
	const settingsFile = path.join(profile, 'User', 'settings.json');
	const settings = {
		'levelcode.ai.providerMode': 'byok', 'levelcode.ai.provider': 'custom', 'levelcode.ai.baseURL': base + '/v1', 'levelcode.ai.model': 'stand-in',
		'levelcode.ai.web.searchProvider': 'levelcode',   // the command below switches it to Brave, as a person would
		'levelcode.ai.sessions.dir': sessions, 'levelcode.ai.verify.enabled': false, 'workbench.startupEditor': 'none', 'telemetry.telemetryLevel': 'off', 'window.restoreWindows': 'none'
	};
	fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
	const debugPort = 9300 + Math.floor(Math.random() * 600);
	const args = ['.', '--user-data-dir=' + profile, '--extensions-dir=' + exts, '--extensionDevelopmentPath=' + EXT, '--remote-debugging-port=' + debugPort,
		'--disable-extension=GitHub.copilot-chat', '--disable-extension=vscode.vscode-api-tests', '--new-window', '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust',
		'--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-features=CalculateNativeWinOcclusion', workspace];
	console.log('Starting the editor (a window will open): ' + path.relative(process.cwd(), exe));
	const env = Object.assign({}, process.env, { NODE_ENV: 'development', VSCODE_DEV: '1', VSCODE_CLI: '1', LEVELCODE_WEB_ALLOW_PRIVATE: '1', LEVELCODE_WEB_BRAVE_URL: base + '/brave' });
	const child = cp.spawn(exe, args, { cwd: VSCODE_DIR, env, stdio: 'ignore' });

	const failures = []; let passed = 0;
	const check = (name, ok, detail) => { if (ok) { passed++; console.log('  ✓ ' + name); } else { failures.push(name + (detail ? ' — ' + detail : '')); console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); } };
	let wb = null, chat = null, code = 0;
	const report = {};
	try {
		const pg = await until('the editor window', async () => (await targets(debugPort)).find((t) => t.type === 'page' && /workbench/.test(t.url)), 120000);
		wb = await connect(pg.webSocketDebuggerUrl);
		await wb.send('Runtime.enable'); await wb.send('Page.enable');
		await until('the workbench', () => evalIn(wb, '!!document.querySelector(".monaco-workbench .part.editor")'), 60000);
		const findChat = async () => {
			for (const t of (await targets(debugPort)).filter((x) => /^vscode-webview:/.test(x.url))) {
				let c; try { c = await connect(t.webSocketDebuggerUrl); } catch (e) { continue; }
				try { await c.send('Runtime.enable'); if (await evalIn(c, '(() => { const f = document.getElementById("active-frame"); const d = f && f.contentDocument; return !!(d && d.getElementById("input") && d.getElementById("log")); })()')) { return c; } } catch (e) { /* not ready */ }
				c.close();
			}
			return null;
		};
		let asked = 0;
		chat = await until('the chat', async () => {
			const c = await findChat(); if (c) { return c; }
			if (asked++ % 10 === 9) { for (const type of ['keyDown', 'keyUp']) { await wb.send('Input.dispatchKeyEvent', { type, modifiers: process.platform === 'darwin' ? 6 : 3, key: 'i', code: 'KeyI', windowsVirtualKeyCode: 73 }); } }
			return null;
		}, 90000);
		const D = 'document.getElementById("active-frame").contentDocument';
		const key = async (k, codeName, vk, modifiers) => { for (const type of ['keyDown', 'keyUp']) { await wb.send('Input.dispatchKeyEvent', { type, modifiers: modifiers || 0, key: k, code: codeName, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk === 13 ? 36 : undefined, text: type === 'keyDown' && k === 'Enter' ? '\r' : undefined }); } };
		const quickInput = () => evalIn(wb, '(() => { const q = document.querySelector(".quick-input-widget"); const i = q && q.style.display !== "none" ? q.querySelector("input") : null; if (!i) { return null; } i.focus(); return { value: i.value, type: i.type, rows: Array.from(q.querySelectorAll(".quick-input-list .monaco-list-row")).map((r) => r.textContent.trim()).slice(0, 6) }; })()');
		const typeIn = async (text) => { await wb.send('Input.insertText', { text }); await sleep(350); };

		// ---- the key, set the way a person sets it ----
		// The walkthrough opens a moment after start-up and takes the focus, closing a palette that is open by then: wait for
		// it, and if the palette closes anyway, start the steps again.
		await sleep(4000);
		const setKey = async () => {
			await key('Escape', 'Escape', 27);
			await key('P', 'KeyP', 80, process.platform === 'darwin' ? 4 | 8 : 2 | 8);   // Cmd/Ctrl+Shift+P
			await until('the command palette', quickInput, 10000);
			await typeIn('Set Web Search Key');
			await until('the command in the palette', async () => { const q = await quickInput(); return q && q.rows.some((r) => /Set Web Search Key/.test(r)); }, 10000);
			await key('Enter', 'Enter', 13);
			await until('the provider list', async () => { const q = await quickInput(); return q && q.rows.some((r) => /Brave Search/.test(r)); }, 10000);
			await typeIn('Brave');
			await key('Enter', 'Enter', 13);
			await until('the key box', async () => { const q = await quickInput(); return q && q.type === 'password'; }, 10000);
			await typeIn(KEY);
			await key('Enter', 'Enter', 13);
			await until('the setting to switch to Brave', () => /"brave"/.test(fs.readFileSync(settingsFile, 'utf8')) || null, 10000);
		};
		for (let attempt = 1; ; attempt++) {
			try { await setKey(); break; } catch (e) { if (attempt >= 3) { throw e; } console.log('  (the palette closed: ' + e.message + '; trying again)'); await sleep(1500); }
		}
		check('the key is set from the command palette, and the provider setting follows', true);

		// ---- the owner's dialog ----
		const send = (goal) => evalIn(chat, `(() => { const d = ${D}; const i = d.getElementById('input'); i.focus(); i.value = ${JSON.stringify(goal)}; i.dispatchEvent(new Event('input', { bubbles: true })); d.getElementById('send').click(); return true; })()`);
		await send(GOAL);
		const first = await until('the model key prompt, or the first request', async () => (modelCalls.length ? 'request' : ((await quickInput()) ? 'prompt' : null)), 30000);
		if (first === 'prompt') {
			await until('the model key to be accepted', async () => {
				const st = await quickInput();
				if (!st) { return true; }
				if (!st.value) { await typeIn('stand-in-key-for-a-local-provider'); return false; }
				await key('Enter', 'Enter', 13); await sleep(500); return false;
			}, 30000);
		}
		await until('the answer', () => modelCalls.length >= 3 && evalIn(chat, `/Dana Okafor coauthored/.test(${D}.getElementById('log').innerText)`), 60000);
		await sleep(1200);

		const m1 = modelCalls[0] || {}, m2 = modelCalls[1] || {}, m3 = modelCalls[2] || {};
		check('the model is offered web_search and web_fetch, and told how to use them', m1.tools && m1.tools.includes('web_search') && m1.tools.includes('web_fetch') && /WEB\. You can search the web with web_search/.test(m1.system || ''), JSON.stringify(m1.tools));
		check('Brave was asked both queries, with the key, at the same time', braveCalls.length === 2 && braveCalls.every((c) => c.token === KEY && c.extra === 'true')
			&& QUERIES.every((q) => braveCalls.some((c) => c.q === q)) && Math.abs(braveCalls[0].at - braveCalls[1].at) < 250, JSON.stringify(braveCalls));
		check('the model read the results: numbered, with the page address and its excerpt', m2.lastTool === 'web_search' && /Searched the web for/.test(m2.toolResult || '') && (m2.toolResult || '').includes(base + '/page/openeox') && /Coauthors include Dana Okafor/.test(m2.toolResult || ''), (m2.toolResult || '').slice(0, 300));
		check('it opened the result it chose and read the passage it looked for, marked as data', pageHits.includes('/page/openeox') && m3.lastTool === 'web_fetch' && /data to read, not instructions/.test(m3.toolResult || '') && /Coauthors: Dana Okafor \(Northwind Systems\)/.test(m3.toolResult || '') && !/window\.steal|Home · Docs/.test(m3.toolResult || ''), (m3.toolResult || '').slice(0, 300));
		const dom = await evalIn(chat, `(() => { const d = ${D}; const log = d.getElementById('log');
			const rows = Array.from(log.querySelectorAll('.toolt')).map((e) => e.textContent.trim());
			const src = Array.from(log.querySelectorAll('.websrc a')).map((a) => ({ text: a.textContent, href: a.getAttribute('href'), title: a.getAttribute('title') }));
			const answerLinks = Array.from(log.querySelectorAll('.msg a, .agent a, .md a')).filter((a) => !a.closest('.websrc')).map((a) => a.getAttribute('href'));
			const heads = Array.from(log.querySelectorAll('.grouphead, .tl-group .ghead, .gtitle')).map((e) => e.textContent.trim());
			return { rows, src, answerLinks, heads, text: log.innerText.slice(-1500) }; })()`);
		report.dom = dom;
		check('the chat shows the search with its count and time, and the pages it found as links', dom.rows.some((r) => /^Searched the web for "Dana Okafor" Northwind · "Dana Okafor" OpenEoX\s*2 results · \d+\.\d s/.test(r))
			&& dom.src.some((s) => s.href === base + '/page/openeox' && s.title === 'OpenEoX technical report'), JSON.stringify(dom.rows.slice(0, 6)) + ' ' + JSON.stringify(dom.src.slice(0, 3)));
		check('…and the page it read', dom.rows.some((r) => /^Looked for "Okafor" in OpenEoX technical report/.test(r)), JSON.stringify(dom.rows));
		check('the answer cites the page with a working link', dom.answerLinks.includes(base + '/page/openeox'), JSON.stringify(dom.answerLinks));
		const timing = (dom.rows.find((r) => /results · /.test(r)) || '').match(/(\d+\.\d) s/);
		report.searchSeconds = timing ? Number(timing[1]) : null;
		check('one search of two queries took about one search\'s time (the stand-in answers in 0.3 s)', report.searchSeconds != null && report.searchSeconds < 1.5, String(report.searchSeconds));
		// The walkthrough's Welcome tab opens over the chat at start-up: bring the chat to the front for the picture.
		const tab = await evalIn(wb, `(() => { const t = Array.from(document.querySelectorAll('.tabs-container .tab')).find((e) => /LevelCode AI/.test(e.getAttribute('aria-label') || e.textContent || '')); if (!t || t.classList.contains('active')) { return null; } const r = t.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
		if (tab) { for (const type of ['mousePressed', 'mouseReleased']) { await wb.send('Input.dispatchMouseEvent', { type, x: tab.x, y: tab.y, button: 'left', clickCount: 1 }); } await sleep(900); }
		const s1 = await wb.send('Page.captureScreenshot', { format: 'png' });
		fs.writeFileSync(path.join(OUT, 'web-1-answer.png'), Buffer.from(s1.data, 'base64'));
		// …and with the activity group open: the search row, its count and time, and the pages as links.
		await evalIn(chat, `(() => { const h = Array.from(${D}.querySelectorAll('.tl-group .grouphead')).find((e) => /Searched the web/.test(e.textContent)); if (h) { h.click(); } return !!h; })()`);
		await sleep(600);
		const s2 = await wb.send('Page.captureScreenshot', { format: 'png' });
		fs.writeFileSync(path.join(OUT, 'web-2-activity.png'), Buffer.from(s2.data, 'base64'));

		// ---- off: the model is told why, and gets no tools ----
		const cur = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
		cur['levelcode.ai.web.search'] = false;
		fs.writeFileSync(settingsFile, JSON.stringify(cur, null, 2));
		await sleep(1500);
		const before = modelCalls.length;
		await send('Is the web on?');
		await until('the answer with web off', () => modelCalls.length > before && evalIn(chat, `/there is no web access in this session/.test(${D}.getElementById('log').innerText)`), 30000);
		const off = modelCalls[modelCalls.length - 1];
		check('with web search off, no web tools — and the model is told why and how to turn it on', !off.tools.includes('web_search') && /WEB SEARCH IS NOT AVAILABLE in this session \(turned off in settings: levelcode\.ai\.web\.search\)/.test(off.system), off.system.slice(-400));

		const thrown = chat.events.filter((e) => e.method === 'Runtime.exceptionThrown').map((e) => ((e.params.exceptionDetails.exception && e.params.exceptionDetails.exception.description) || e.params.exceptionDetails.text).slice(0, 200));
		check('nothing threw in the chat page', thrown.length === 0, thrown.join(' | '));
		report.modelCalls = modelCalls.map((c) => ({ tools: c.tools, lastTool: c.lastTool, toolResult: c.toolResult && c.toolResult.slice(0, 600) }));
		report.braveCalls = braveCalls; report.pageHits = pageHits;
		fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
	} catch (e) {
		failures.push('the run did not finish: ' + (e && e.message || e));
		console.log('  ✗ the run did not finish: ' + (e && e.message || e));
		try { if (wb) { const s = await wb.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(OUT, 'editor-failed.png'), Buffer.from(s.data, 'base64')); } } catch (e2) { /* no picture */ }
		try { fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(Object.assign(report, { modelCalls, braveCalls, pageHits }), null, 2)); } catch (e2) { /* no report */ }
		if (!wb) { code = 2; }
	} finally {
		try { if (chat) { chat.close(); } if (wb) { wb.close(); } } catch (e) { /* closed */ }
		if (KEEP) { console.log('--keep: the editor is left open. Its profile, sessions and workspace are in ' + tmp); }
		else {
			try { child.kill('SIGTERM'); } catch (e) { /* gone */ }
			await sleep(1500);
			try { child.kill('SIGKILL'); } catch (e) { /* gone */ }
			try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* a temp folder */ }
		}
		server.close();
	}
	console.log(passed + ' checks passed' + (failures.length ? ', ' + failures.length + ' FAILED' : '.'));
	console.log('Screenshots and report: ' + OUT);
	return failures.length ? (code || 1) : 0;
}

main().then((c) => process.exit(c), (e) => { console.error(e); process.exit(2); });
