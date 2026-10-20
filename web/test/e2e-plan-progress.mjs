#!/usr/bin/env node
// The task list, the next-step box and the queue in a tab (docs/PLAN-PROGRESS.md). The browser edition shares
// media/chat.html with the desktop, under its own skin; this drives a scripted model through the real chat in the
// browser build and checks what the desktop's scripts/plan-progress-editor-check.js checks, minus what only the
// desktop has: the list while the agent works, Enter queueing instead of stopping, "Send now" reaching the model
// at its next step, and the hand-back box — in the browser's light and dark looks.
//
//   node web/ai-extension/build.mjs --out <dir> --vscode <checkout> && cp -R web/workspace <dir>/levelcode-web
//   node web/test/e2e-plan-progress.mjs --static <vscode-web dir> --extensions <dir> [--scheme dark|light] [--out <screenshots dir>]
// The page follows the system's light or dark setting when it loads, so --scheme is set before it does: one look per run.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startStub } from './stub-backend.mjs';
import { Chrome, sleep } from './cdp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, all) => { if (v.startsWith('--')) { a.push([v.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : 'true']); } return a; }, []));
const STATIC = path.resolve(args.static || process.env.LEVELCODE_WEB_STATIC || '');
const EXTS = path.resolve(args.extensions || process.env.LEVELCODE_WEB_EXTENSIONS || '');
const OUT = path.resolve(args.out || fs.mkdtempSync(path.join(os.tmpdir(), 'lc-web-pp-')));
const PORT = Number(args.port || 8806);
const SCHEME = args.scheme === 'light' ? 'light' : 'dark';
const editorOrigin = `http://localhost:${PORT}`;
const KEY = ['sk', 'plan', 'test', '0123456789'].join('-');
const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail && !ok ? '  — ' + detail : ''}`); };

// ---- the scripted model: OpenAI-compatible, CORS for the tab, one reply per streamed request ----
function gate() { let open; const p = new Promise((r) => { open = r; }); return { p, open }; }
const G1 = gate();
const SCRIPT = [
	{ text: 'Reading first.', tools: [['update_plan', { items: [{ content: 'Read the notes', status: 'in_progress' }, { content: 'Write the summary', status: 'pending' }, { content: 'Check it', status: 'pending' }] }], ['list_files', {}]] },
	{ wait: G1, tools: [['update_plan', { advance: true }], ['list_files', {}]] },
	{ tools: [['wrap_up', { recap: 'The summary is written. Nothing was checked against the source.', ask: 'Check it against the source?', actions: [{ label: 'Yes, check it', message: 'Check it against the source.' }, { label: 'Not now' }] }]] },
	{ text: 'Done: checked.' }
];
const requests = [];
const provider = http.createServer((req, res) => {
	const cors = { 'access-control-allow-origin': req.headers.origin || '*', 'access-control-allow-headers': 'authorization, content-type, accept, x-stainless-retry-count', 'access-control-allow-methods': 'GET, POST, OPTIONS' };
	if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
	let body = '';
	req.on('data', (c) => { body += c; });
	req.on('end', () => {
		let j = {}; try { j = JSON.parse(body || '{}'); } catch { /* not JSON */ }
		if (req.method === 'GET' || !j.stream) { res.writeHead(200, Object.assign({ 'content-type': 'application/json' }, cors)); res.end(JSON.stringify(req.method === 'GET' ? { data: [{ id: 'stand-in' }] } : { choices: [{ message: { role: 'assistant', content: 'Notes' }, finish_reason: 'stop' }] })); return; }
		const msgs = Array.isArray(j.messages) ? j.messages : [];
		const n = requests.length;
		requests.push({ tools: (j.tools || []).map((t) => t.function && t.function.name), last: msgs.slice(-3).map((m) => ({ role: m.role, content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) })) });
		const step = SCRIPT[n] || { text: 'Done.' };
		res.writeHead(200, Object.assign({ 'content-type': 'text/event-stream', 'cache-control': 'no-cache' }, cors));
		const send = (o) => { try { res.write('data: ' + JSON.stringify(o) + '\n\n'); } catch { /* stopped */ } };
		const chunk = (delta, finish) => send({ id: 'c' + n, object: 'chat.completion.chunk', model: j.model, choices: [{ index: 0, delta, finish_reason: finish || null }] });
		(async () => {
			if (step.wait) { await step.wait.p; }
			if (step.text) { chunk({ content: step.text }); }
			(step.tools || []).forEach(([name, input], k) => chunk({ tool_calls: [{ index: k, id: 'call_' + n + '_' + k, type: 'function', function: { name, arguments: JSON.stringify(input) } }] }));
			chunk({}, step.tools ? 'tool_calls' : 'stop');
			send({ id: 'c' + n, object: 'chat.completion.chunk', model: j.model, choices: [], usage: { prompt_tokens: 900, completion_tokens: 40 } });
			try { res.write('data: [DONE]\n\n'); res.end(); } catch { /* stopped */ }
		})();
	});
});
await new Promise((r) => provider.listen(0, '127.0.0.1', r));
const providerOrigin = 'http://127.0.0.1:' + provider.address().port;

const stub = await startStub({ editorOrigin, port: 0 });
const defaults = JSON.stringify({ 'levelcode.ai.providerMode': 'byok', 'levelcode.ai.provider': 'custom', 'levelcode.ai.baseURL': providerOrigin + '/v1', 'levelcode.ai.model': 'stand-in' });
const server = spawn(process.execPath, [path.join(HERE, '..', 'serve.mjs'), '--port', String(PORT),
	'--static', STATIC, '--extensions', EXTS, '--extension-names', 'levelcode-ai,levelcode-web', '--account', stub.origin, '--config-defaults', defaults], { stdio: 'ignore' });
let chrome;
const finish = async (code) => { G1.open(); try { chrome && chrome.close(); } catch {} try { server.kill(); } catch {} try { await stub.close(); } catch {} provider.close(); process.exit(code); };

try {
	for (let i = 0; i < 50; i++) { try { if ((await fetch(editorOrigin + '/')).ok) { break; } } catch {} await sleep(100); }
	chrome = await Chrome.launch({ port: Number(args['debug-port'] || 9557), width: 1280, height: 860, dpr: 2 });
	const page = await chrome.newPage();
	await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: SCHEME }] });
	await page.goto(editorOrigin + '/');
	await page.waitFor(() => page.eval(`!!document.querySelector('.monaco-workbench .part.editor')`), { ms: 90000, label: 'workbench' });
	await page.waitFor(async () => (await page.eval(`[...document.querySelectorAll('.tabs-container .tab')].some((e) => /LevelCode AI/.test(e.getAttribute('aria-label') || ''))`)), { ms: 60000, label: 'chat tab' });
	await sleep(2000);
	await page.palette('Set API Key');
	await page.waitFor(() => page.eval(`!!document.querySelector('.quick-input-widget:not([style*="display: none"]) .quick-input-box input[type=password]')`), { ms: 10000, label: 'key prompt' });
	await page.type(KEY);
	await page.key('Enter', 'Enter');
	await sleep(800);
	const r = await page.eval(`(() => { const t = [...document.querySelectorAll('.tabs-container .tab')].find((e) => /LevelCode AI/.test(e.getAttribute('aria-label') || '')); const b = t.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`);
	await page.click(r.x, r.y);
	await sleep(700);
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
	const type = (text) => inChat(`(() => { const i = d.getElementById('input'); i.focus(); i.value = ${JSON.stringify(text)}; i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); return true; })()`);
	const state = () => inChat(`(() => { const tb = d.getElementById('turnBox'), qb = d.getElementById('queueBar');
		return { skin: d.body.classList.contains('lc-web'), radius: tb ? getComputedStyle(tb).borderTopLeftRadius : '', boxLast: d.getElementById('log').lastElementChild === tb,
			steps: tb && !tb.hidden ? [...tb.querySelectorAll('.tb-step')].map((li) => li.classList[1] + (li.querySelector('.tb-spin') ? '*' : '')) : [],
			ask: tb && tb.querySelector('.tb-ask') ? tb.querySelector('.tb-ask').textContent : '', replies: tb ? [...tb.querySelectorAll('.tb-act')].map((b) => b.textContent) : [],
			queue: qb && !qb.hidden ? (qb.querySelector('.qb-count') || {}).textContent : '', sending: qb ? qb.querySelectorAll('.sending').length : 0,
			streaming: !d.getElementById('workbar').hidden, users: [...d.querySelectorAll('.msg.user .body')].map((b) => b.textContent.trim()) }; })()`);
	const shot = async (name) => { await sleep(500); await page.screenshot(path.join(OUT, name + '.png')); };

	await type('Summarize the notes');
	const s1 = await page.waitFor(async () => { const s = await state(); return requests.length >= 2 && s.steps.length === 3 ? s : null; }, { ms: 60000, label: 'the list' });
	check('the chat is the browser\'s skinned copy, and the card takes its rounder corners', s1.skin && s1.radius === '14px', JSON.stringify([s1.skin, s1.radius]));
	const look = await page.eval(`(() => { const w = document.querySelector('.monaco-workbench'); return !w ? '?' : w.classList.contains('vs-dark') || w.classList.contains('hc-black') ? 'dark' : w.classList.contains('vs') || w.classList.contains('hc-light') ? 'light' : '?'; })()`);
	check('the workbench is in the ' + SCHEME + ' look', look === SCHEME, look);
	check('the task list shows while the agent works, the first step spinning, as the last thing in the transcript', s1.boxLast && s1.steps.join(' ') === 'in_progress* pending pending', JSON.stringify(s1));
	await type('Keep it under a page');
	const s2 = await page.waitFor(async () => { const s = await state(); return s.queue ? s : null; }, { ms: 10000, label: 'the queue' });
	check('Enter while the agent works queues the message, and the run goes on', s2.queue === '1 message queued' && s2.streaming, JSON.stringify(s2));
	await shot('web-1-list-queued-' + SCHEME);
	await inChat(`(() => { d.querySelector('#queueBar [data-q="send"]').click(); return true; })()`);
	check('Send now marks it as on its way', (await state()).sending === 1);
	G1.open();
	await page.waitFor(() => requests.length >= 3, { ms: 30000, label: 'the third request' });
	check('the model\'s next request carries it', requests[2].last.some((m) => m.role === 'user' && /while you were working/.test(m.content) && /Keep it under a page/.test(m.content)), JSON.stringify(requests[2].last));
	const s3 = await page.waitFor(async () => { const s = await state(); return !s.streaming && s.ask ? s : null; }, { ms: 30000, label: 'the next-step box' });
	check('the run hands back with the box: question and two replies, the list gone', s3.ask === 'Check it against the source?' && s3.replies.join('|') === 'Yes, check it|Not now' && s3.steps.length === 0 && s3.users.includes('Keep it under a page'), JSON.stringify(s3));
	await shot('web-2-next-step-' + SCHEME);
	await inChat(`(() => { d.querySelector('#turnBox .tb-act.primary').click(); return true; })()`);
	await page.waitFor(() => requests.length >= 4, { ms: 30000, label: 'the reply' });
	check('a reply button sends its message', requests[3].last.some((m) => m.role === 'user' && m.content === 'Check it against the source.'), JSON.stringify(requests[3].last));
	const errs = page.errors.filter((e) => /vscode-webview|active-frame|chat/i.test(e.tag + e.url) || /turnBox|queueBar|renderTurnBox|drainQueue/.test(e.text));
	check('nothing threw in the chat page', errs.length === 0, JSON.stringify(errs.slice(0, 3)));
} catch (e) {
	check('the run completed', false, String((e && e.stack) || e));
}
const failed = results.filter((x) => !x).length;
console.log(`\n${results.length - failed}/${results.length} checks passed · screenshots: ${OUT}`);
await finish(failed ? 1 : 0);
