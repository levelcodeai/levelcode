#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  LevelCode — the task list, the next-step box and the queue, checked in the REAL editor
 *  (docs/PLAN-PROGRESS.md, "How to check it")
 *
 *  The unit suites run the pieces: turnPlan.test.js the rules, agentPlanProgress.test.js the agent loop,
 *  planProgressUi.test.js the chat page's decisions. This runs the whole thing in the editor: the dev
 *  build (vscode/.build/electron) as a second, throwaway instance with THIS checkout's extension, a
 *  stand-in model on localhost that a script drives turn by turn — and holds, at three points, so the
 *  page can be looked at and typed into while the agent "works" — all driven over the DevTools protocol.
 *
 *  What it proves, with no key and no cost:
 *    • the task list appears as the last thing in the transcript, the step in progress spinning, and
 *      moves as the model advances it
 *    • Enter while the agent works QUEUES (two messages fold into "2 messages queued · Next: …"), and the
 *      run is not stopped
 *    • the stack opens, a message is reordered from the keyboard, one is removed from its menu, and
 *      "Send now" hands the other to the running agent: the model's next request carries it, and it
 *      shows in the transcript as your message
 *    • the run hands back with a question: the list goes, the next-step box shows the recap, the question
 *      and two replies — and the run made no further model call
 *    • a reply button sends its message as your next turn
 *    • a message queued during that run sends itself when the run ends
 *    • ■ on a run with a message queued stops it, and the message comes back into the message box
 *    • nothing throws in the page; screenshots in LevelCode One Dark and LevelCode One Light
 *
 *  RUN:   node extensions/levelcode-ai/scripts/plan-progress-editor-check.js [--vscode <dir>] [--out <dir>] [--keep]
 *         From a worktree, pass the main checkout's vscode/:  --vscode ../../../vscode   (or LEVELCODE_VSCODE_DIR)
 *  NEEDS: the dev build (./scripts/run-dev.sh has been run once), macOS or Linux, Node 22+.
 *  NOTE:  an editor window opens on your screen for about a minute. It is a separate instance with its own
 *         profile in a temp folder; it does not join an editor you already have open.
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
const OUT = path.resolve(opt('--out') || fs.mkdtempSync(path.join(os.tmpdir(), 'lc-pp-out-')));
const KEEP = argv.includes('--keep');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- the stand-in model: OpenAI-compatible, one scripted reply per streamed request ----------------
// A reply can wait on a gate the harness opens, so the page can be looked at mid-run.
function gate() { let open; const p = new Promise((r) => { open = r; }); return { p, open }; }
const G1 = gate(), G2 = gate(), G3 = gate();
const PLAN = [
	{ content: 'Read the date parser', status: 'in_progress' },
	{ content: 'Find the `parseDate` helpers', status: 'pending' },
	{ content: 'Add the ISO week rule', status: 'pending' },
	{ content: 'Check the result', status: 'pending' }
];
const SCRIPT = [
	{ text: 'I will read the parser first, then add the rule.', tools: [['update_plan', { items: PLAN }], ['read_file', { path: 'src/parse.js', explanation: 'Read the date parser' }]] },
	{ wait: G1, tools: [['update_plan', { advance: true }], ['search', { query: 'parseDate', explanation: 'Find the date helpers' }]] },
	{ text: 'Noted: ISO weeks too.', tools: [['update_plan', { advance: true }], ['read_file', { path: 'src/parse.js', explanation: 'Read the parser again' }]] },
	{ tools: [['update_plan', { advance: true }], ['wrap_up', { recap: 'The parser now reads ISO weeks as well as plain dates. The tests were not run.', ask: 'Run the date tests now?', actions: [{ label: 'Yes, run them', message: 'Run the date tests.' }, { label: 'Not now', message: 'Not now, thanks.' }] }]] },
	{ wait: G2, text: 'Running them now.', tools: [['wrap_up', { recap: 'The date tests pass.' }]] },
	{ text: 'Done: the date tests pass.' },
	{ text: 'Done: the README now lists ISO weeks.' },
	{ wait: G3, text: 'This reply is never read: the run was stopped.' }
];
const requests = [];
function startProvider() {
	return new Promise((resolve) => {
		const server = http.createServer((req, res) => {
			let body = '';
			req.on('data', (c) => { body += c; });
			req.on('end', () => {
				let j = {}; try { j = JSON.parse(body || '{}'); } catch (e) { /* not JSON */ }
				if (req.method === 'GET') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ data: [{ id: 'stand-in' }] })); return; }
				if (!j.stream) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Date parsing' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 3 } })); return; }
				const msgs = Array.isArray(j.messages) ? j.messages : [];
				const n = requests.length;
				requests.push({ tools: (j.tools || []).map((t) => t.function && t.function.name), last: msgs.slice(-3).map((m) => ({ role: m.role, content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) })), system: (msgs[0] && msgs[0].role === 'system') ? String(msgs[0].content).length : 0 });
				const step = SCRIPT[n] || { text: 'Done: (the script ran out).' };
				res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
				const send = (o) => { try { res.write('data: ' + JSON.stringify(o) + '\n\n'); } catch (e) { /* the run was stopped */ } };
				const chunk = (delta, finish) => send({ id: 'c' + n, object: 'chat.completion.chunk', model: j.model, choices: [{ index: 0, delta, finish_reason: finish || null }] });
				(async () => {
					if (step.wait) { await step.wait.p; }
					if (step.text) { for (let i = 0; i < step.text.length; i += 9) { chunk({ content: step.text.slice(i, i + 9) }); await sleep(10); } }
					(step.tools || []).forEach(([name, input], k) => {
						chunk({ tool_calls: [{ index: k, id: 'call_' + n + '_' + k, type: 'function', function: { name, arguments: JSON.stringify(input) } }] });
					});
					chunk({}, step.tools ? 'tool_calls' : 'stop');
					send({ id: 'c' + n, object: 'chat.completion.chunk', model: j.model, choices: [], usage: { prompt_tokens: 1500, completion_tokens: 60 } });
					try { res.write('data: [DONE]\n\n'); res.end(); } catch (e) { /* stopped */ }
				})();
			});
		});
		server.listen(0, '127.0.0.1', () => resolve(server));
	});
}

// ---- a minimal DevTools-protocol client (Node's own WebSocket and fetch) ----------------------------
function connect(wsUrl) {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(wsUrl);
		let id = 0; const pending = new Map(); const events = [];
		ws.onopen = () => resolve({
			send: (method, params) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params: params || {} })); setTimeout(() => { if (pending.has(i)) { pending.delete(i); rej(new Error(method + ' timed out')); } }, 20000); }),
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
	for (;;) { const v = await fn(); if (v) { return v; } if (Date.now() > end) { throw new Error('timed out waiting for ' + what); } await sleep(150); }
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
	// SHORT: the editor's IPC socket lives in the profile, and macOS refuses a socket path over 103 characters.
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-pp-'));
	const profile = path.join(tmp, 'p'), exts = path.join(tmp, 'x'), workspace = path.join(tmp, 'w'), sessions = path.join(tmp, 's');
	for (const d of [path.join(profile, 'User'), exts, path.join(workspace, 'src'), sessions]) { fs.mkdirSync(d, { recursive: true }); }
	fs.writeFileSync(path.join(workspace, 'src', 'parse.js'), '// dates\nfunction parseDate(s) {\n  return new Date(s);\n}\nmodule.exports = { parseDate };\n');
	const provider = await startProvider();
	const settingsFile = path.join(profile, 'User', 'settings.json');
	const settings = {
		'levelcode.ai.providerMode': 'byok', 'levelcode.ai.provider': 'custom', 'levelcode.ai.baseURL': 'http://127.0.0.1:' + provider.address().port + '/v1', 'levelcode.ai.model': 'stand-in',
		'levelcode.ai.sessions.dir': sessions, 'levelcode.ai.verify.enabled': false,
		'workbench.colorTheme': 'LevelCode One Dark', 'workbench.startupEditor': 'none', 'telemetry.telemetryLevel': 'off', 'window.restoreWindows': 'none'
	};
	const writeSettings = () => fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
	writeSettings();
	const debugPort = 9300 + Math.floor(Math.random() * 600);
	const args = ['.', '--user-data-dir=' + profile, '--extensions-dir=' + exts, '--extensionDevelopmentPath=' + EXT, '--remote-debugging-port=' + debugPort,
		'--disable-extension=GitHub.copilot-chat', '--disable-extension=vscode.vscode-api-tests', '--new-window', '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust',
		'--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-features=CalculateNativeWinOcclusion', workspace];
	console.log('Starting the editor (a window will open): ' + path.relative(process.cwd(), exe));
	const child = cp.spawn(exe, args, { cwd: VSCODE_DIR, env: Object.assign({}, process.env, { NODE_ENV: 'development', VSCODE_DEV: '1', VSCODE_CLI: '1' }), stdio: 'ignore' });

	const failures = []; let passed = 0;
	const check = (name, ok, detail) => { console.log((ok ? '  ✓ ' : '  ✗ ') + name + (ok || !detail ? '' : ' — ' + detail)); if (ok) { passed++; } else { failures.push(name + (detail ? ' — ' + detail : '')); } };
	let wb = null, wv = null, code = 0;
	try {
		const page = await until('the editor window', async () => (await targets(debugPort)).find((t) => t.type === 'page' && /workbench/.test(t.url)), 120000);
		wb = await connect(page.webSocketDebuggerUrl);
		await wb.send('Runtime.enable'); await wb.send('Page.enable');
		await until('the workbench', () => evalIn(wb, '!!document.querySelector(".monaco-workbench .part.editor")'), 60000);
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
		const D = 'document.getElementById("active-frame").contentDocument';
		const inChat = (body) => evalIn(wv, '(() => { const d = ' + D + '; ' + body + ' })()');
		const type = (text) => inChat(`const i = d.getElementById('input'); i.focus(); i.value = ${JSON.stringify(text)}; i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); return true;`);
		const state = () => inChat(`
			const tb = d.getElementById('turnBox'), qb = d.getElementById('queueBar');
			const steps = tb && !tb.hidden ? Array.from(tb.querySelectorAll('.tb-step')).map((li) => ({ status: li.classList[1], text: li.querySelector('.tb-txt').textContent, spin: !!li.querySelector('.tb-spin') })) : [];
			const last = d.getElementById('log').lastElementChild;
			return { steps, boxLast: last === tb, note: (tb && tb.querySelector('.tb-note') || {}).textContent || '',
				recap: tb && tb.querySelector('.tb-recap') ? tb.querySelector('.tb-recap').textContent : '', ask: tb && tb.querySelector('.tb-ask') ? tb.querySelector('.tb-ask').textContent : '',
				replies: tb ? Array.from(tb.querySelectorAll('.tb-act')).map((b) => (b.classList.contains('primary') ? '*' : '') + b.textContent) : [],
				queue: qb && !qb.hidden ? { count: (qb.querySelector('.qb-count') || {}).textContent, peek: (qb.querySelector('.qb-peek') || {}).textContent, items: Array.from(qb.querySelectorAll('.qb-text')).map((x) => x.textContent), sending: qb.querySelectorAll('.sending').length } : null,
				composer: d.getElementById('input').value, sendTitle: d.getElementById('send').title, streaming: !d.getElementById('workbar').hidden,
				users: Array.from(d.querySelectorAll('.msg.user .body')).map((b) => b.textContent.trim()), note2: d.getElementById('imgnote').hidden ? '' : d.getElementById('imgnote').textContent };`);

		// the first message: a new profile asks for a key (a stand-in, kept in the temp profile only)
		await type('Add an ISO week rule to the date parser');
		const first = await until('the key prompt, or the first request', async () => {
			if (requests.length) { return 'request'; }
			return (await evalIn(wb, '(() => { const q = document.querySelector(".quick-input-widget"); return !!(q && q.style.display !== "none" && q.querySelector("input")); })()')) ? 'prompt' : null;
		}, 30000);
		if (first === 'prompt') {
			const box = '(() => { const q = document.querySelector(".quick-input-widget"); const i = q && q.style.display !== "none" ? q.querySelector("input") : null; if (!i) { return null; } i.focus(); return { typed: i.value.length }; })()';
			await until('the key to be accepted', async () => {
				const s = await evalIn(wb, box);
				if (!s) { return true; }
				if (!s.typed) { await wb.send('Input.insertText', { text: 'stand-in-key-for-a-local-provider' }); await sleep(200); return false; }
				for (const t of ['keyDown', 'keyUp']) { await wb.send('Input.dispatchKeyEvent', { type: t, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 36, text: t === 'keyDown' ? '\r' : undefined }); }
				await sleep(500);
				return false;
			}, 30000);
		}
		check('the model is offered update_plan and wrap_up', await until('the first request', () => requests[0] && requests[0].tools.includes('update_plan') && requests[0].tools.includes('wrap_up'), 30000).catch(() => false), JSON.stringify(requests[0] && requests[0].tools));

		// bring the chat forward if it is an editor tab, so the pictures show it
		const tab = await evalIn(wb, `(() => { const t = Array.from(document.querySelectorAll('.tabs-container .tab')).find((e) => /LevelCode AI/.test(e.getAttribute('aria-label') || e.textContent || '')); if (!t) { return null; } const r = t.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
		if (tab) { for (const t of ['mousePressed', 'mouseReleased']) { await wb.send('Input.dispatchMouseEvent', { type: t, x: tab.x, y: tab.y, button: 'left', clickCount: 1 }); } }
		const shot = async (name) => {
			await sleep(450);   // let the card's fade and the band's rise finish
			const full = await wb.send('Page.captureScreenshot', { format: 'png' });
			fs.writeFileSync(path.join(OUT, name + '-window.png'), Buffer.from(full.data, 'base64'));
			const r = await evalIn(wb, `(() => { const f = Array.from(document.querySelectorAll('iframe.webview')).map((e) => e.getBoundingClientRect()).filter((b) => b.width > 200 && b.height > 300).sort((a, b) => b.width * b.height - a.width * a.height)[0]; return f ? { x: f.x, y: f.y, width: f.width, height: f.height } : null; })()`);
			if (r) { const s = await wb.send('Page.captureScreenshot', { format: 'png', clip: Object.assign(r, { scale: 1 }) }); fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(s.data, 'base64')); }
		};
		const theme = async (name) => {
			settings['workbench.colorTheme'] = name; writeSettings();
			await until('the ' + name + ' theme', () => evalIn(wb, `document.body.classList.contains(${JSON.stringify(/Light/.test(name) ? 'vs' : 'vs-dark')})`), 15000).catch(() => null);
			await sleep(600);
		};

		// ── 1. the list while the agent works ─────────────────────────────────────────────────────────
		const s1 = await until('the task list, with the agent held at its second request', async () => { const s = await state(); return requests.length >= 2 && s.steps.length === 4 ? s : null; }, 30000);
		check('the task list shows the four steps, as the last thing in the transcript', s1.boxLast && s1.steps.map((x) => x.text).join(' | ') === 'Read the date parser | Find the parseDate helpers | Add the ISO week rule | Check the result', JSON.stringify(s1));
		check('…`parseDate` drawn as code, the first step in progress and spinning, the rest open', s1.steps[0].status === 'in_progress' && s1.steps[0].spin && s1.steps.slice(1).every((x) => x.status === 'pending' && !x.spin)
			&& await inChat(`return !!d.querySelector('#turnBox .tb-txt code');`), JSON.stringify(s1.steps));
		await shot('1-list-dark');

		// ── 2. Enter while it works: queued, not stopped ──────────────────────────────────────────────
		await type('Also handle ISO weeks in the year boundary');
		await type('Use UTC everywhere');
		const s2 = await until('two queued messages', async () => { const s = await state(); return s.queue && s.queue.count === '2 messages queued' ? s : null; }, 10000);
		check('Enter while the agent works queues the message — and the run goes on', s2.streaming && s2.queue.peek === 'Next: Also handle ISO weeks in the year boundary' && s2.composer === '', JSON.stringify(s2.queue));
		await inChat(`d.getElementById('input').value = 'and keep'; d.getElementById('input').dispatchEvent(new Event('input')); return true;`);
		check('the send button says Queue once you type, and Stop with an empty composer', (await state()).sendTitle.startsWith('Queue') && await inChat(`const i = d.getElementById('input'); i.value = ''; i.dispatchEvent(new Event('input')); return d.getElementById('send').title === 'Stop';`));
		await shot('2-queued-dark');
		await inChat(`d.querySelector('#queueBar [data-q="open"]').click(); return true;`);
		await until('the open stack', () => inChat(`return d.querySelectorAll('#queueBar .qb-item').length === 2;`), 5000);
		await inChat(`const g = d.querySelectorAll('#queueBar [data-q="grip"]')[1]; g.focus(); g.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', altKey: true, bubbles: true })); return true;`);
		const s3 = await state();
		check('the stack opens, and Alt+↑ on a grip moves that message up', s3.queue.items.join(' | ') === 'Use UTC everywhere | Also handle ISO weeks in the year boundary', JSON.stringify(s3.queue));
		await inChat(`d.querySelectorAll('#queueBar [data-q="menu"]')[0].click(); return true;`);
		await shot('3-stack-menu-dark');
		await theme('LevelCode One Light');
		await shot('3-stack-menu-light');
		await theme('LevelCode One Dark');
		const menu = await inChat(`return Array.from(d.querySelectorAll('#queueBar .qb-menu button')).map((b) => { const r = b.getBoundingClientRect(); return b.textContent + (b.disabled ? ' (off)' : '') + (d.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) === b ? '' : ' (hidden)'); });`);
		check('each queued message has a menu — Edit in composer, Send now, Remove from queue — every item in view, none cut off', menu.join(' | ') === 'Edit in composer | Send now | Remove from queue', JSON.stringify(menu));
		await inChat(`d.querySelector('#queueBar .qb-menu [data-q="remove"]').click(); return true;`);
		await until('one message left', async () => { const s = await state(); return s.queue && s.queue.count === '1 message queued'; }, 5000);
		await inChat(`d.querySelector('#queueBar [data-q="send"]').click(); return true;`);
		const s4 = await state();
		check('Remove takes a message out; Send now marks the other as on its way', s4.queue && s4.queue.count === '1 message queued' && s4.queue.sending === 1 && s4.queue.peek === 'Also handle ISO weeks in the year boundary', JSON.stringify(s4.queue));
		G1.open();

		// ── 3. Send now lands at the next step ────────────────────────────────────────────────────────
		await until('the third request', () => requests.length >= 3, 30000);
		const third = requests[2];
		check('the model\'s next request carries the message, marked as sent during the run', third.last.some((m) => m.role === 'user' && /while you were working/.test(m.content) && /Also handle ISO weeks in the year boundary/.test(m.content)), JSON.stringify(third.last));
		const s5 = await until('the message in the transcript', async () => { const s = await state(); return s.users.includes('Also handle ISO weeks in the year boundary') && !s.queue ? s : null; }, 10000);
		check('…and it leaves the queue for the transcript, as your message', s5.users.join(' | ') === 'Add an ISO week rule to the date parser | Also handle ISO weeks in the year boundary', JSON.stringify(s5.users));

		// ── 4. the hand-back ──────────────────────────────────────────────────────────────────────────
		const s6 = await until('the next-step box', async () => { const s = await state(); return !s.streaming && s.ask ? s : null; }, 30000);
		check('the run hands back: the list is gone, the box shows the recap, the question and two replies, the first primary',
			s6.steps.length === 0 && s6.boxLast && s6.recap === 'The parser now reads ISO weeks as well as plain dates. The tests were not run.' && s6.ask === 'Run the date tests now?' && s6.replies.join(' | ') === '*Yes, run them | Not now', JSON.stringify(s6));
		await sleep(800);
		check('…and the run made no model call after the wrap-up whose box holds the question', requests.length === 4, String(requests.length));
		await shot('4-next-step-dark');
		await theme('LevelCode One Light');
		await shot('4-next-step-light');
		await theme('LevelCode One Dark');

		// ── 5. a reply sends; a message queued meanwhile sends itself when the run ends ─────────────────
		await inChat(`d.querySelector('#turnBox .tb-act.primary').click(); return true;`);
		await until('the reply\'s request', () => requests.length >= 5, 20000);
		check('a reply button sends its message as your next turn', requests[4].last.some((m) => m.role === 'user' && m.content === 'Run the date tests.') && (await state()).users.slice(-1)[0] === 'Run the date tests.', JSON.stringify(requests[4].last));
		await type('Then update the README');
		const s7 = await until('one queued', async () => { const s = await state(); return s.queue ? s : null; }, 5000);
		check('a message typed during that run waits as one row', s7.queue.count === '1 message queued' && s7.queue.peek === 'Then update the README', JSON.stringify(s7.queue));
		await shot('5-one-queued-dark');
		G2.open();
		await until('the queued message\'s own request', () => requests.length >= 7, 30000);
		check('when the run ends, the queued message is sent by itself', requests[6].last.some((m) => m.role === 'user' && m.content === 'Then update the README'), JSON.stringify(requests[6].last));
		await until('that run to finish', async () => !(await state()).streaming, 20000);

		// ── 6. ■ with a message queued: stopped, and the message comes back ─────────────────────────────
		await type('Start a long refactor');
		await until('the held request', () => requests.length >= 8, 20000);
		await type('This should come back to me');
		await until('it queued', async () => !!(await state()).queue, 5000);
		await inChat(`d.getElementById('send').click(); return true;`);
		const s8 = await until('the stop', async () => { const s = await state(); return !s.streaming && !s.queue ? s : null; }, 20000);
		check('■ stops the run, and the queued message comes back into the message box with a note', s8.composer === 'This should come back to me' && /back in the message box/.test(s8.note2), JSON.stringify({ composer: s8.composer, note: s8.note2 }));
		G3.open();
		await shot('6-stopped-dark');

		const thrown = wv.events.filter((e) => e.method === 'Runtime.exceptionThrown').map((e) => ((e.params.exceptionDetails.exception && e.params.exceptionDetails.exception.description) || e.params.exceptionDetails.text).slice(0, 200));
		check('nothing threw in the chat page', thrown.length === 0, thrown.join(' | '));
		fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify({ requests }, null, 2));
	} catch (e) {
		failures.push('the run did not finish: ' + (e && e.message || e));
		try { if (wb) { const s = await wb.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(OUT, 'failed.png'), Buffer.from(s.data, 'base64')); } } catch (e2) { /* no picture */ }
		if (!wb) { code = 2; }
	} finally {
		for (const g of [G1, G2, G3]) { g.open(); }
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
