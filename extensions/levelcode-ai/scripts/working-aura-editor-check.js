#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  LevelCode — the working aura, checked in the REAL editor
 *
 *  test/workingAura.test.js runs the aura's decisions. This runs the product: the dev build
 *  (vscode/.build/electron) as a throwaway instance with THIS checkout's extension, a stand-in model on
 *  localhost, driven through the DevTools protocol (the harness of diagram-editor-check.js). It reads the
 *  light round the message box from the chat page's own computed style, in each state, and takes a
 *  picture of each:
 *    working   the model "thinks" for a while: the ring shows, animates, and its angle moves
 *    waiting   a command waits for approval: the ring is whole and still
 *    idle      the run is over: nothing on the box
 *    reduced   with reduced motion emulated: a still ring while working
 *    off       with levelcode.ai.chat.workingAura false: nothing, even while working
 *
 *  RUN:   node extensions/levelcode-ai/scripts/working-aura-editor-check.js [--vscode <dir>] [--out <dir>] [--theme <name>] [--keep]
 *         --theme   a colour theme to look at it in, e.g. "LevelCode One Light" (default: the build's own)
 *         From a worktree, pass the main checkout's build:  --vscode <main checkout>/vscode
 *  NEEDS: the dev build (./scripts/run-dev.sh has been run once), macOS or Linux, Node 22+.
 *  NOTE:  an editor window opens for about a minute: a separate instance with its own profile.
 *  EXIT:  0 all checks pass · 1 a check failed · 2 could not run (no build, no window).
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
const OUT = path.resolve(opt('--out') || fs.mkdtempSync(path.join(os.tmpdir(), 'lc-aura-editor-')));
const KEEP = argv.includes('--keep');
const THEME = opt('--theme');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- the stand-in model: holds each turn until the check releases it ---------------------------------
// Every streamed request waits on a gate; the check opens it when it has looked at the page. Goals:
//   "think"  → one held turn, then "Done: thought."
//   "run"    → held turn, then run_command `echo aura` (an approval card in Default Approvals), then Done.
const requests = [];
let release = null;
const gate = () => new Promise((r) => { release = r; });
function startProvider() {
	return new Promise((resolve) => {
		const server = http.createServer((req, res) => {
			let body = '';
			req.on('data', (c) => { body += c; });
			req.on('end', async () => {
				let j = {}; try { j = JSON.parse(body || '{}'); } catch (e) { /* not JSON */ }
				if (req.method === 'GET') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ data: [{ id: 'stand-in' }] })); return; }
				if (!j.stream) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Aura check' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 3 } })); return; }
				const msgs = Array.isArray(j.messages) ? j.messages : [];
				const text = (m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content));
				const users = msgs.filter((m) => m.role === 'user').map(text);
				const lastGoal = users.filter((u) => /^(think|run)\b/.test(u)).pop() || '';
				const afterTool = msgs.length && msgs[msgs.length - 1].role === 'tool';
				requests.push({ goal: lastGoal, afterTool });
				res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
				const send = (o) => res.write('data: ' + JSON.stringify(o) + '\n\n');
				const chunk = (delta, finish) => send({ id: 'c1', object: 'chat.completion.chunk', model: j.model, choices: [{ index: 0, delta, finish_reason: finish || null }] });
				if (!afterTool) { await gate(); }   // held until the check has looked at "working"
				if (/^run\b/.test(lastGoal) && !afterTool) {
					chunk({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'run_command', arguments: JSON.stringify({ command: 'echo aura', explanation: 'Print a word' }) } }] });
					chunk({}, 'tool_calls');
				} else {
					chunk({ content: 'Done: ' + (afterTool ? 'ran it.' : 'thought.') }); chunk({}, 'stop');
				}
				send({ id: 'c1', object: 'chat.completion.chunk', model: j.model, choices: [], usage: { prompt_tokens: 50, completion_tokens: 5 } });
				res.write('data: [DONE]\n\n'); res.end();
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
	// A webview the workbench has replaced never answers: bound every call, so the run fails instead of hanging.
	const r = await Promise.race([
		c.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }),
		new Promise((_, reject) => setTimeout(() => reject(new Error('the page did not answer in 15 s (was it replaced?)')), 15000))
	]);
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
	catch (e) { console.error('No editor build at ' + VSCODE_DIR + '. Run ./scripts/run-dev.sh once in the checkout that has vscode/, then pass that folder with --vscode.'); return 2; }
	const exe = process.platform === 'darwin'
		? path.join(VSCODE_DIR, '.build', 'electron', product.nameLong + '.app', 'Contents', 'MacOS', product.nameShort)
		: path.join(VSCODE_DIR, '.build', 'electron', product.applicationName);
	if (!fs.existsSync(exe)) { console.error('The editor has not been built yet (' + exe + ' is missing). Run ./scripts/run-dev.sh once.'); return 2; }

	fs.mkdirSync(OUT, { recursive: true });
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-aura-check-'));
	const profile = path.join(tmp, 'profile'), exts = path.join(tmp, 'extensions'), workspace = path.join(tmp, 'workspace'), sessions = path.join(tmp, 'sessions');
	for (const d of [path.join(profile, 'User'), exts, workspace, sessions]) { fs.mkdirSync(d, { recursive: true }); }
	fs.writeFileSync(path.join(workspace, 'README.md'), '# aura\n');
	const provider = await startProvider();
	const settingsFile = path.join(profile, 'User', 'settings.json');
	const settings = {
		'levelcode.ai.providerMode': 'byok', 'levelcode.ai.provider': 'custom', 'levelcode.ai.baseURL': 'http://127.0.0.1:' + provider.address().port + '/v1', 'levelcode.ai.model': 'stand-in',
		'levelcode.ai.sessions.dir': sessions, 'levelcode.ai.verify.enabled': false, 'workbench.startupEditor': 'none', 'telemetry.telemetryLevel': 'off', 'window.restoreWindows': 'none'
	};
	if (THEME) { settings['workbench.colorTheme'] = THEME; }
	fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
	const debugPort = 9300 + Math.floor(Math.random() * 600);
	const args = ['.', '--user-data-dir=' + profile, '--extensions-dir=' + exts, '--extensionDevelopmentPath=' + EXT, '--remote-debugging-port=' + debugPort,
		'--disable-extension=GitHub.copilot-chat', '--disable-extension=vscode.vscode-api-tests', '--new-window', '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust',
		'--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-features=CalculateNativeWinOcclusion', workspace];
	console.log('Starting the editor (a window will open): ' + path.relative(process.cwd(), exe));
	const child = cp.spawn(exe, args, { cwd: VSCODE_DIR, env: Object.assign({}, process.env, { NODE_ENV: 'development', VSCODE_DEV: '1', VSCODE_CLI: '1' }), stdio: 'ignore' });

	const failures = []; let passed = 0;
	const check = (name, ok, detail) => { if (ok) { passed++; console.log('  ✓ ' + name); } else { failures.push(name + (detail ? ' — ' + detail : '')); console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); } };
	let wb = null, chat = null, chatTarget = null, code = 0;
	try {
		const page = await until('the editor window', async () => (await targets(debugPort)).find((t) => t.type === 'page' && /workbench/.test(t.url)), 120000);
		wb = await connect(page.webSocketDebuggerUrl);
		await wb.send('Runtime.enable'); await wb.send('Page.enable');
		await until('the workbench', () => evalIn(wb, '!!document.querySelector(".monaco-workbench .part.editor")'), 60000);
		const findChat = async () => {
			for (const t of (await targets(debugPort)).filter((x) => /^vscode-webview:/.test(x.url))) {
				let c; try { c = await connect(t.webSocketDebuggerUrl); } catch (e) { continue; }
				try { await c.send('Runtime.enable'); if (await evalIn(c, '(() => { const f = document.getElementById("active-frame"); const d = f && f.contentDocument; return !!(d && d.getElementById("input") && d.getElementById("log") && d.getElementById("composer")); })()')) { chatTarget = t; return c; } } catch (e) { /* not ready */ }
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
		const W = 'document.getElementById("active-frame").contentWindow';
		const front = async () => {
			const tab = await evalIn(wb, `(() => { const t = Array.from(document.querySelectorAll('.tabs-container .tab')).find((e) => /LevelCode AI/.test(e.getAttribute('aria-label') || e.textContent || '')); if (!t || t.classList.contains('active')) { return null; } const r = t.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
			if (tab) { for (const type of ['mousePressed', 'mouseReleased']) { await wb.send('Input.dispatchMouseEvent', { type, x: tab.x, y: tab.y, button: 'left', clickCount: 1 }); } await sleep(700); }
		};
		// The composer's corner, close up: what the eye sees of the ring.
		const shot = async (name) => {
			await front();
			const s = await wb.send('Page.captureScreenshot', { format: 'png' });
			fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(s.data, 'base64'));
		};
		const key = async (k, codeName, vk) => { for (const type of ['keyDown', 'keyUp']) { await wb.send('Input.dispatchKeyEvent', { type, key: k, code: codeName, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk === 13 ? 36 : undefined, text: type === 'keyDown' && k === 'Enter' ? '\r' : undefined }); } };
		const send = (goal) => evalIn(chat, `(() => { const d = ${D}; const i = d.getElementById('input'); i.focus(); i.value = ${JSON.stringify(goal)}; i.dispatchEvent(new Event('input', { bubbles: true })); d.getElementById('send').click(); return true; })()`);
		// The ring as the page draws it: the body's state class, and the line (::after) and glow (::before).
		const ring = () => evalIn(chat, `(() => { const d = ${D}, w = ${W}, c = d.getElementById('composer');
			const a = w.getComputedStyle(c, '::after'), b = w.getComputedStyle(c, '::before');
			return { cls: ['aura-working', 'aura-waiting'].filter((x) => d.body.classList.contains(x)), lineOpacity: +a.opacity, glowOpacity: +b.opacity,
				anim: a.animationName, angle: a.getPropertyValue('--aura-angle').trim(), turn: c.style.getPropertyValue('--aura-turn'), bg: a.backgroundImage.slice(0, 40) }; })()`);
		// The box itself: whether it has the focus, and the focus ring it draws.
		const box = () => evalIn(chat, `(() => { const d = ${D}, w = ${W}, c = d.getElementById('composer'), s = w.getComputedStyle(c);
			return { focused: c.classList.contains('focused'), shadow: s.boxShadow, border: s.borderTopColor }; })()`);
		await front();

		// ---- working ----
		await send('think about it');
		const first = await until('the key prompt, or the first request', async () => {
			if (requests.length) { return 'request'; }
			return (await evalIn(wb, '(() => { const q = document.querySelector(".quick-input-widget"); return !!(q && q.style.display !== "none" && q.querySelector("input")); })()')) ? 'prompt' : null;
		}, 30000);
		if (first === 'prompt') {
			const box = '(() => { const q = document.querySelector(".quick-input-widget"); const i = q && q.style.display !== "none" ? q.querySelector("input") : null; if (!i) { return null; } i.focus(); return { typed: i.value.length }; })()';
			await until('the key to be accepted', async () => {
				const st = await evalIn(wb, box);
				if (!st) { return true; }
				if (!st.typed) { await wb.send('Input.insertText', { text: 'stand-in-key-for-a-local-provider' }); await sleep(200); return false; }
				await key('Enter', 'Enter', 13); await sleep(500); return false;
			}, 30000);
		}
		await until('the held first turn', () => requests.length >= 1 || null, 30000);
		await sleep(700);   // the ring fades in over 0.4 s
		const w1 = await ring(); await sleep(350); const w2 = await ring();
		check('working: the ring is on, visible and animating', w1.cls.join() === 'aura-working' && w1.lineOpacity === 1 && w1.glowOpacity === 1 && w1.anim === 'aura-turn', JSON.stringify(w1));
		check('…and it is moving: its angle changed in 0.35 s', !!w1.angle && !!w2.angle && w1.angle !== w2.angle, w1.angle + ' → ' + w2.angle);
		check('…at a speed set from the box (1.6–3 s a turn)', /^(1\.[6-9]\d|2\.\d\d|3\.00)s$/.test(w1.turn), w1.turn);
		await shot('aura-1-working');
		await sleep(800);
		await shot('aura-1-working-later');   // the same run 0.8 s on: the light has moved round the box
		// In real use the message box keeps the focus after Enter (here the key prompt took it). Its accent
		// focus ring would swallow a 1px line, so while the light turns the ring steps back.
		await evalIn(chat, `(() => { ${D}.getElementById('input').focus(); return true; })()`);
		await sleep(300);
		const wf = await box();
		check('…and with the box focused, its focus ring steps back so the line shows', wf.focused && wf.shadow === 'none', JSON.stringify(wf));
		await shot('aura-1-working-focused');
		release();
		await until('the run to end', () => evalIn(chat, `(() => /Done: thought/.test(${D}.getElementById('log').innerText))()`), 30000);
		await sleep(700);
		const idle = await ring();
		check('idle: when the run is over the ring is gone', idle.cls.length === 0 && idle.lineOpacity === 0 && idle.glowOpacity === 0, JSON.stringify(idle));
		const idleBox = await box();
		check('…and a focused box has its full focus ring back', idleBox.focused && idleBox.shadow !== 'none', JSON.stringify(idleBox));

		// ---- waiting ----
		await send('run something');
		await until('the held turn', () => requests.filter((r) => /^run/.test(r.goal)).length >= 1 || null, 30000);
		await sleep(600);
		release();
		await until('the approval card', () => evalIn(chat, `(() => !!${D}.querySelector('.tl-ask.asking'))()`), 30000);
		await sleep(700);
		const wt = await ring();
		check('waiting: on an approval card the ring is whole and still', wt.cls.join() === 'aura-waiting' && wt.lineOpacity === 1 && wt.anim === 'none' && !/conic/.test(wt.bg), JSON.stringify(wt));
		await shot('aura-2-waiting');
		await evalIn(chat, `(() => { ${D}.querySelector('.tl-ask.asking .approve').click(); return true; })()`);
		await until('the command to run and the run to end', () => evalIn(chat, `(() => /Done: ran it/.test(${D}.getElementById('log').innerText))()`), 30000);
		await sleep(700);
		const after = await ring();
		check('…and after the approval and the end of the run, gone again', after.cls.length === 0 && after.lineOpacity === 0, JSON.stringify(after));

		// ---- reduced motion ----
		await chat.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
		await send('think again');
		await until('the held turn', () => requests.filter((r) => /^think again/.test(r.goal)).length >= 1 || null, 30000);
		await sleep(700);
		const rm = await ring();
		check('reduced motion: working is a still, whole ring', rm.cls.join() === 'aura-working' && rm.lineOpacity === 1 && rm.anim === 'none' && !/conic/.test(rm.bg), JSON.stringify(rm));
		await shot('aura-3-reduced-motion');
		release();
		await until('the run to end', () => evalIn(chat, `(() => (${D}.getElementById('log').innerText.match(/Done: thought/g) || []).length >= 2)()`), 30000);
		await chat.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });

		// ---- off ----
		fs.writeFileSync(settingsFile, JSON.stringify(Object.assign({}, settings, { 'levelcode.ai.chat.workingAura': false }), null, 2));
		await sleep(1500);   // the editor picks the file up and the host sends the config message
		await send('think once more');
		await until('the held turn', () => requests.filter((r) => /^think once more/.test(r.goal)).length >= 1 || null, 30000);
		await sleep(700);
		const off = await ring();
		check('setting off: nothing on the box, even while working', off.cls.length === 0 && off.lineOpacity === 0, JSON.stringify(off));
		release();
		await until('the run to end', () => evalIn(chat, `(() => (${D}.getElementById('log').innerText.match(/Done: thought/g) || []).length >= 3)()`), 30000);

		const thrown = chat.events.filter((e) => e.method === 'Runtime.exceptionThrown').map((e) => ((e.params.exceptionDetails.exception && e.params.exceptionDetails.exception.description) || e.params.exceptionDetails.text).slice(0, 200));
		check('nothing threw in the chat page', thrown.length === 0, thrown.join(' | '));
		fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify({ w1, w2, idle, wt, after, rm, off, requests }, null, 2));
	} catch (e) {
		failures.push('the run did not finish: ' + (e && e.message || e));
		console.log('  ✗ the run did not finish: ' + (e && e.message || e));
		try { if (release) { release(); } } catch (e2) { /* nothing held */ }
		try { if (wb) { const s = await wb.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(OUT, 'editor-failed.png'), Buffer.from(s.data, 'base64')); } } catch (e2) { /* no picture */ }
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
		provider.close();
	}
	console.log(passed + ' checks passed' + (failures.length ? ', ' + failures.length + ' FAILED' : '.'));
	console.log('Screenshots and report: ' + OUT);
	return failures.length ? (code || 1) : 0;
}

main().then((c) => process.exit(c), (e) => { console.error(e); process.exit(2); });
