#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  LevelCode — rich diagrams, checked in the REAL editor  (docs/RICH-DIAGRAMS.md, "How to check it")
 *
 *  The unit suites run the pieces; diagram-browser-check.js runs the chat page in a plain browser.
 *  Neither is the editor. This one is: it starts the dev build (vscode/.build/electron) as a second,
 *  throwaway instance — its own profile, its own sessions folder, an empty workspace — with THIS
 *  checkout's extension loaded in place of the built-in one, points it at a stand-in for a provider
 *  running on localhost, and drives the chat through the DevTools protocol. Then it asks the real
 *  webview what it drew.
 *
 *  What it proves, end to end, with no key and no cost:
 *    • the editor is running this checkout's extension, and the chat page has its renderer
 *    • the model is offered render_diagram, with the rules, and gets {"ok":true,"id":…} back
 *    • the diagram is painted in the real webview, in the editor's theme, from the painter's elements
 *    • a linked node opens its file at the symbol; the session on disk holds the diagram
 *    • a wider column re-lays the diagram out; nothing throws in the page
 *    • the answer around it renders as Markdown — including backticks quoted inside backticks,
 *      which used to shred the paragraph one streamed fragment per line
 *
 *  It exists because of a mistake: the feature was first reported "done" having only ever run in a
 *  browser, with instructions for trying it that could not have worked. A checkout that is not the
 *  one holding vscode/ (a git worktree, say) cannot be launched with run-dev.sh — but its extension
 *  can be loaded into the build that is there, which is all this script and the tip below do.
 *
 *  RUN:   node extensions/levelcode-ai/scripts/diagram-editor-check.js [--vscode <dir>] [--out <dir>] [--keep]
 *         --vscode  the built vscode/ checkout (default: <repo>/vscode, else $LEVELCODE_VSCODE_DIR).
 *                   From a worktree, pass the main checkout's:  --vscode ../../../vscode
 *         --keep    leave the editor open afterwards, to look around (its profile is a temp folder)
 *  NEEDS: the dev build (./scripts/run-dev.sh has been run once), macOS or Linux, Node 22+.
 *  NOTE:  an editor window opens on your screen for about a minute. It is a separate instance: it does
 *         not join an editor you already have open, and it touches neither your profile nor your sessions.
 *  EXIT:  0 all checks pass · 1 a check failed · 2 could not run (no build, no window).
 *
 *  TO TRY IT BY HAND with your own account or key, from the checkout that has vscode/:
 *    ./scripts/run-dev.sh --extensionDevelopmentPath=/absolute/path/to/this/checkout/extensions/levelcode-ai
 *  (quit a dev editor that is already open first — a running one is joined, not replaced).
 *
 *  Not part of scripts/test-extensions.sh: that gate is plain Node, and stays that way.
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
const OUT = path.resolve(opt('--out') || fs.mkdtempSync(path.join(os.tmpdir(), 'lc-diagram-editor-')));
const KEEP = argv.includes('--keep');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const T = String.fromCharCode(96);

/** What the stand-in model draws, and says. The answer quotes three backticks inside four — the text from the report. */
const SPEC = {
	title: 'Jev classifies; your code decides the action',
	nodes: [{ id: 'in', label: 'Customer message', sub: 'plus account details' }, { id: 'jev', label: 'Jev', sub: 'returns probabilities', accent: true, link: { path: 'src/router.js', symbol: 'route' } }, { id: 'bill', label: 'Route to billing' }, { id: 'rev', label: 'Human review' }],
	edges: [{ from: 'in', to: 'jev' }, { from: 'jev', to: 'bill', label: '0.90 or more' }, { from: 'jev', to: 'rev', label: 'under 0.90' }]
};
const ANSWER = 'Done: Jev only scores the message; the 0.90 threshold lives in ' + T + 'src/router.js' + T + '. A fence is closed by a plain ' + T.repeat(4) + ' ' + T.repeat(3) + ' ' + T.repeat(4) + '. The rest of this sentence used to arrive one fragment per line.';

// ---- the stand-in provider: OpenAI-compatible, streams one render_diagram call, then the answer ----
const requests = [];
function startProvider() {
	return new Promise((resolve) => {
		const server = http.createServer((req, res) => {
			let body = '';
			req.on('data', (c) => { body += c; });
			req.on('end', () => {
				let j = {}; try { j = JSON.parse(body || '{}'); } catch (e) { /* not JSON */ }
				const msgs = Array.isArray(j.messages) ? j.messages : [];
				const sys = msgs.filter((m) => m.role === 'system').map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n');
				const lastTool = msgs.filter((m) => m.role === 'tool').pop();
				requests.push({ stream: !!j.stream, tools: (j.tools || []).map((t) => t.function && t.function.name), rules: /DIAGRAMS\. This client renders real diagrams/.test(sys), toolResult: lastTool ? String(lastTool.content) : null });
				if (req.method === 'GET') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ data: [{ id: 'stand-in' }] })); return; }
				if (!j.stream) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Message routing' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 3 } })); return; }
				res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
				const send = (o) => res.write('data: ' + JSON.stringify(o) + '\n\n');
				const chunk = (delta, finish) => send({ id: 'c1', object: 'chat.completion.chunk', model: j.model, choices: [{ index: 0, delta, finish_reason: finish || null }] });
				(async () => {
					if (lastTool) {
						// a few characters at a time, as a model streams — the way the shredded paragraph arrived
						for (let i = 0; i < ANSWER.length; i += 7) { chunk({ content: ANSWER.slice(i, i + 7) }); await sleep(8); }
						chunk({}, 'stop');
					} else {
						for (const t of ['Here is how a message ', 'is routed.']) { chunk({ content: t }); await sleep(30); }
						const args = JSON.stringify(SPEC);
						chunk({ tool_calls: [{ index: 0, id: 'call_diagram_1', type: 'function', function: { name: 'render_diagram', arguments: '' } }] });
						for (let i = 0; i < args.length; i += 40) { chunk({ tool_calls: [{ index: 0, function: { arguments: args.slice(i, i + 40) } }] }); await sleep(20); }
						chunk({}, 'tool_calls');
					}
					send({ id: 'c1', object: 'chat.completion.chunk', model: j.model, choices: [], usage: { prompt_tokens: 1200, completion_tokens: 150 } });
					res.write('data: [DONE]\n\n'); res.end();
				})();
			});
		});
		server.listen(0, '127.0.0.1', () => resolve(server));
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
	const r = await c.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
	if (r.exceptionDetails) { throw new Error('the page threw: ' + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text)); }
	return r.result.value;
}
const targets = async (port) => { try { return await (await fetch('http://127.0.0.1:' + port + '/json/list')).json(); } catch (e) { return []; } };
/** Wait for a RESULT, with a deadline — never for a length of time. */
async function until(what, fn, ms) {
	const end = Date.now() + (ms || 30000);
	for (;;) { const v = await fn(); if (v) { return v; } if (Date.now() > end) { throw new Error('timed out waiting for ' + what); } await sleep(200); }
}

async function main() {
	if (typeof WebSocket !== 'function' || typeof fetch !== 'function') { console.error('Needs Node 22 or newer (for its built-in WebSocket).'); return 2; }
	let product;
	try { product = JSON.parse(fs.readFileSync(path.join(VSCODE_DIR, 'product.json'), 'utf8')); }
	catch (e) { console.error('No editor build at ' + VSCODE_DIR + '.\nRun ./scripts/run-dev.sh once in the checkout that has vscode/, then pass that folder with --vscode (a git worktree has none of its own).'); return 2; }
	const exe = process.platform === 'darwin'
		? path.join(VSCODE_DIR, '.build', 'electron', product.nameLong + '.app', 'Contents', 'MacOS', product.nameShort)
		: path.join(VSCODE_DIR, '.build', 'electron', product.applicationName);
	if (!fs.existsSync(exe)) { console.error('The editor has not been built yet (' + exe + ' is missing). Run ./scripts/run-dev.sh once.'); return 2; }

	fs.mkdirSync(OUT, { recursive: true });
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-editor-check-'));
	const profile = path.join(tmp, 'profile'), exts = path.join(tmp, 'extensions'), workspace = path.join(tmp, 'workspace'), sessions = path.join(tmp, 'sessions');
	for (const d of [path.join(profile, 'User'), exts, path.join(workspace, 'src'), sessions]) { fs.mkdirSync(d, { recursive: true }); }
	fs.writeFileSync(path.join(workspace, 'src', 'router.js'), '// routing\nfunction score(m) { return 0.5; }\n\nfunction route(message) {\n  return score(message) >= 0.9 ? "billing" : "review";\n}\nmodule.exports = { route };\n');
	const provider = await startProvider();
	fs.writeFileSync(path.join(profile, 'User', 'settings.json'), JSON.stringify({
		'levelcode.ai.providerMode': 'byok', 'levelcode.ai.provider': 'custom', 'levelcode.ai.baseURL': 'http://127.0.0.1:' + provider.address().port + '/v1', 'levelcode.ai.model': 'stand-in',
		'levelcode.ai.sessions.dir': sessions, 'workbench.startupEditor': 'none', 'telemetry.telemetryLevel': 'off', 'window.restoreWindows': 'none'
	}, null, 2));
	const debugPort = 9300 + Math.floor(Math.random() * 600);
	const args = ['.', '--user-data-dir=' + profile, '--extensions-dir=' + exts, '--extensionDevelopmentPath=' + EXT, '--remote-debugging-port=' + debugPort,
		'--disable-extension=GitHub.copilot-chat', '--disable-extension=vscode.vscode-api-tests', '--new-window', '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust',
		// keep painting when the window is behind others: the screenshots come from the page, not the screen
		'--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-features=CalculateNativeWinOcclusion', workspace];
	console.log('Starting the editor (a window will open): ' + path.relative(process.cwd(), exe));
	const child = cp.spawn(exe, args, { cwd: VSCODE_DIR, env: Object.assign({}, process.env, { NODE_ENV: 'development', VSCODE_DEV: '1', VSCODE_CLI: '1' }), stdio: 'ignore' });

	const failures = []; let passed = 0;
	const check = (name, ok, detail) => { if (ok) { passed++; } else { failures.push(name + (detail ? ' — ' + detail : '')); } };
	let wb = null, wv = null, code = 0;
	try {
		const page = await until('the editor window', async () => (await targets(debugPort)).find((t) => t.type === 'page' && /workbench/.test(t.url)), 120000);
		wb = await connect(page.webSocketDebuggerUrl);
		await wb.send('Runtime.enable'); await wb.send('Page.enable');
		await until('the workbench', () => evalIn(wb, '!!document.querySelector(".monaco-workbench .part.editor")'), 60000);

		// the chat: it opens by itself in a new profile; ask for it (Ctrl+Cmd+I / Ctrl+Alt+I) if it has not
		const findChat = async () => {
			for (const t of (await targets(debugPort)).filter((x) => /^vscode-webview:/.test(x.url))) {
				let c; try { c = await connect(t.webSocketDebuggerUrl); } catch (e) { continue; }
				try {
					await c.send('Runtime.enable');
					if (await evalIn(c, '(() => { const f = document.getElementById("active-frame"); const d = f && f.contentDocument; return !!(d && d.getElementById("input") && d.getElementById("log")); })()')) { return c; }
				} catch (e) { /* not ready yet */ }
				c.close();
			}
			return null;
		};
		let asked = 0;
		wv = await until('the chat', async () => {
			const c = await findChat(); if (c) { return c; }
			if (asked++ % 10 === 9) { for (const type of ['keyDown', 'keyUp']) { await wb.send('Input.dispatchKeyEvent', { type, modifiers: process.platform === 'darwin' ? 6 : 3, key: 'i', code: 'KeyI', windowsVirtualKeyCode: 73 }); } }
			return null;
		}, 90000);
		const D = 'document.getElementById("active-frame").contentDocument', W = 'document.getElementById("active-frame").contentWindow';

		const pageInfo = await evalIn(wv, `(() => { const w = ${W}, d = ${D}; return { modules: w.LCDiagram ? Object.keys(w.LCDiagram).sort() : null, mode: (d.getElementById('modeLabel') || {}).textContent, csp: (d.querySelector('meta[http-equiv="Content-Security-Policy"]') || {}).content || '' }; })()`);
		check('the editor is running THIS checkout\'s extension — the chat page has the diagram renderer', Array.isArray(pageInfo.modules) && pageInfo.modules.join() === 'ascii,layout,repair,scene,schema,text,theme,validate', JSON.stringify(pageInfo.modules));
		check('the chat page\'s policy still allows no network and only its own scripts', /default-src 'none'/.test(pageInfo.csp) && /script-src 'nonce-[^']+'$/.test(pageInfo.csp.trim()) && !/https?:|connect-src|\*/.test(pageInfo.csp), pageInfo.csp);
		check('the chat opens in Agent mode', pageInfo.mode === 'Agent', pageInfo.mode);

		await evalIn(wv, `(() => { const d = ${D}; const i = d.getElementById('input'); i.focus(); i.value = 'How is a customer message routed?'; i.dispatchEvent(new Event('input', { bubbles: true })); d.getElementById('send').click(); return true; })()`);
		// a new profile has no key: the editor asks for one, and gets a stand-in (kept in the temp profile only)
		const first = await until('the key prompt, or the first request', async () => {
			if (requests.some((r) => r.stream)) { return 'request'; }
			return (await evalIn(wb, '(() => { const q = document.querySelector(".quick-input-widget"); return !!(q && q.style.display !== "none" && q.querySelector("input")); })()')) ? 'prompt' : null;
		}, 30000);
		if (first === 'prompt') {
			// Something else may take the focus while this happens (a new profile opens its Welcome page
			// when it feels like it), so: focus the box, type if it is empty, press Enter, and look —
			// until the box has gone.
			const box = '(() => { const q = document.querySelector(".quick-input-widget"); const i = q && q.style.display !== "none" ? q.querySelector("input") : null; if (!i) { return null; } i.focus(); return { typed: i.value.length, focused: document.activeElement === i }; })()';
			await until('the key to be accepted', async () => {
				const state = await evalIn(wb, box);
				if (!state) { return true; }
				if (!state.typed) { await wb.send('Input.insertText', { text: 'stand-in-key-for-a-local-provider' }); await sleep(200); return false; }
				for (const type of ['keyDown', 'keyUp']) { await wb.send('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 36, text: type === 'keyDown' ? '\r' : undefined }); }
				await sleep(500);
				return false;
			}, 30000);
		}

		await until('the diagram', () => evalIn(wv, `(() => !!${D}.querySelector('figure.lcd[data-id]'))()`), 60000);
		await until('the answer', async () => requests.filter((r) => r.stream).length >= 2 && await evalIn(wv, `(() => /one fragment per line/.test(${D}.getElementById('log').innerText) && !!${D}.querySelector('.msgcopy'))()`), 45000);

		const first1 = requests.filter((r) => r.stream)[0] || {}, second = requests.filter((r) => r.stream)[1] || {};
		check('the model is offered render_diagram', (first1.tools || []).includes('render_diagram'), JSON.stringify(first1.tools));
		check('…together with the rules for using it', first1.rules === true);
		check('the call is answered with the diagram\'s id', second.toolResult === '{"ok":true,"id":"d-1"}', String(second.toolResult));

		// bring the chat's tab forward if it is an editor tab, so the pictures below show it
		const tab = await evalIn(wb, `(() => { const t = Array.from(document.querySelectorAll('.tabs-container .tab')).find((e) => /LevelCode AI/.test(e.getAttribute('aria-label') || e.textContent || '')); if (!t) { return null; } const r = t.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
		const narrow = await evalIn(wv, `(() => { const d = ${D}; const s = d.querySelector('figure.lcd .lcd-stage svg'); return { column: d.documentElement.clientWidth, box: s ? s.getAttribute('viewBox') : null }; })()`);
		if (tab) { for (const type of ['mousePressed', 'mouseReleased']) { await wb.send('Input.dispatchMouseEvent', { type, x: tab.x, y: tab.y, button: 'left', clickCount: 1 }); } }
		await until('the chat to be in view', () => evalIn(wv, `(() => ${D}.visibilityState === 'visible' && ${D}.documentElement.clientWidth > 0)()`), 20000).catch(() => null);
		await sleep(1200);

		const chat = await evalIn(wv, `(() => {
			const d = ${D};
			const c = d.querySelector('figure.lcd'); const svg = c && c.querySelector('.lcd-stage svg'); const tags = {};
			if (svg) { svg.querySelectorAll('*').forEach((el) => { tags[el.localName] = (tags[el.localName] || 0) + 1; }); }
			const r = svg ? svg.getBoundingClientRect() : null;
			const last = Array.from(d.querySelectorAll('.msg.assistant')).pop();
			const paras = last ? Array.from(last.querySelectorAll('p')).map((p) => p.innerHTML) : [];
			return { column: d.documentElement.clientWidth, id: c && c.dataset.id, status: c && c.dataset.status, pending: d.querySelectorAll('figure.lcd.lcd-pending').length, title: c && (c.querySelector('.lcd-title-text') || {}).textContent,
				svg: !!svg, tags, width: r ? Math.round(r.width) : 0, box: svg ? svg.getAttribute('viewBox') : null, texts: svg ? Array.from(svg.querySelectorAll('text')).map((t) => t.textContent) : [],
				links: c ? c.querySelectorAll('[data-lc-link]').length : 0, textColour: svg ? getComputedStyle(svg.querySelector('text')).fill : '', accentStroke: svg && svg.querySelector('.lcd-accent rect') ? getComputedStyle(svg.querySelector('.lcd-accent rect')).stroke : '',
				paras, pres: last ? last.querySelectorAll('pre').length : -1, divs: last ? last.querySelectorAll('div').length : -1 };
		})()`);
		check('the diagram is drawn: one card, finished, titled', chat.id === 'd-1' && chat.status === 'ok' && chat.pending === 0 && chat.title === SPEC.title, JSON.stringify({ id: chat.id, status: chat.status, pending: chat.pending, title: chat.title }));
		check('…as an SVG made only of the painter\'s elements', chat.svg && Object.keys(chat.tags).every((t) => ['g', 'rect', 'path', 'text', 'title'].includes(t)), JSON.stringify(chat.tags));
		check('…with every label on it', ['Customer message', 'plus account details', 'Jev', 'returns probabilities', 'Route to billing', 'Human review', '0.90 or more', 'under 0.90'].every((t) => chat.texts.includes(t)), JSON.stringify(chat.texts));
		check('…in the editor\'s colours (the theme\'s text colour, and an accent)', /^rgb|^color/.test(chat.textColour) && chat.accentStroke && chat.accentStroke !== chat.textColour && chat.accentStroke !== 'none', JSON.stringify([chat.textColour, chat.accentStroke]));
		check('…never wider than the chat column', chat.width > 0 && chat.width <= chat.column, chat.width + ' in ' + chat.column);
		check('a wider column re-lays it out (it was drawn for ' + narrow.column + 'px, the column is now ' + chat.column + 'px)', chat.column <= narrow.column + 40 || chat.box !== narrow.box, narrow.box + ' → ' + chat.box);
		const answer = chat.paras.find((p) => /Done: Jev only scores/.test(p)) || '';
		check('the answer is ONE paragraph, with the quoted fence as inline code — not a code block, not a line per fragment', chat.pres === 0 && /closed by a plain <code>```<\/code>\. The rest of this sentence used to arrive one fragment per line\.$/.test(answer), JSON.stringify({ pres: chat.pres, answer: answer.slice(0, 260) }));

		const shot = async (name) => { const s = await wb.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(OUT, name), Buffer.from(s.data, 'base64')); };
		await shot('editor-chat.png');

		// a click on the linked node: the editor opens the file at the symbol
		await evalIn(wv, `(() => { const d = ${D}; const n = d.querySelector('figure.lcd [data-lc-link]'); if (!n) { return false; } n.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: d.defaultView })); return true; })()`);
		const opened = await until('router.js to open', () => evalIn(wb, '(() => { const t = Array.from(document.querySelectorAll(".tabs-container .tab")).map((e) => (e.getAttribute("aria-label") || e.textContent || "").trim()); if (!t.some((x) => /router\\.js/.test(x))) { return null; } const s = document.querySelector(".statusbar [id=\\"status.editor.selection\\"]"); return { tabs: t, cursor: s ? s.textContent.trim() : "" }; })()'), 20000).catch(() => null);
		check('clicking the linked node opens src/router.js', !!opened, 'no router.js tab appeared');
		const cursor = opened ? await until('the cursor', () => evalIn(wb, '(() => { const s = document.querySelector(".statusbar [id=\\"status.editor.selection\\"]"); const t = s ? s.textContent.trim() : ""; return /Ln \\d+/.test(t) ? t : null; })()'), 10000).catch(() => '') : '';
		check('…at the symbol: line 4, where function route begins', /^Ln 4,/.test(cursor), JSON.stringify(cursor));
		await sleep(500);
		await shot('editor-link.png');

		const files = []; (function walk(dir) { for (const f of fs.readdirSync(dir)) { const p = path.join(dir, f); if (fs.statSync(p).isDirectory()) { walk(p); } else { files.push(p); } } })(sessions);
		const kinds = files.filter((f) => /\.jsonl$/.test(f)).map((f) => fs.readFileSync(f, 'utf8').trim().split('\n').map((l) => { try { return JSON.parse(l).kind; } catch (e) { return '?'; } }));
		check('the session on disk holds the diagram, after the turn that drew it', kinds.length === 1 && kinds[0].indexOf('diagram') > kinds[0].indexOf('agent') && kinds[0].indexOf('agent') > 0, JSON.stringify(kinds));
		const thrown = wv.events.filter((e) => e.method === 'Runtime.exceptionThrown').map((e) => ((e.params.exceptionDetails.exception && e.params.exceptionDetails.exception.description) || e.params.exceptionDetails.text).slice(0, 200));
		check('nothing threw in the chat page', thrown.length === 0, thrown.join(' | '));
		fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify({ pageInfo, chat, narrow, opened, cursor, kinds, requests }, null, 2));
	} catch (e) {
		failures.push('the run did not finish: ' + (e && e.message || e));
		try { if (wb) { const s = await wb.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(OUT, 'editor-failed.png'), Buffer.from(s.data, 'base64')); } } catch (e2) { /* no picture */ }
		if (!wb) { code = 2; }
	} finally {
		try { if (wv) { wv.close(); } if (wb) { wb.close(); } } catch (e) { /* closed */ }
		if (KEEP) { console.log('--keep: the editor is left open. Its profile, sessions and workspace are in ' + tmp); }
		else {
			try { child.kill('SIGTERM'); } catch (e) { /* gone */ }
			await sleep(1500);
			try { child.kill('SIGKILL'); } catch (e) { /* gone */ }
			try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* a temp folder */ }
		}
		provider.close();
	}
	console.log(passed + ' checks passed' + (failures.length ? ', ' + failures.length + ' FAILED:' : '.'));
	for (const f of failures) { console.log('  ✗ ' + f); }
	console.log('Screenshots and report: ' + OUT);
	return failures.length ? (code || 1) : 0;
}

main().then((c) => process.exit(c), (e) => { console.error(e); process.exit(2); });
