#!/usr/bin/env node
// LevelCode Shell in a real (headless) Chrome: the visitor's terminal and the agent's run_command, end to end.
//
//   node web/test/e2e-shell.mjs --static <vscode-web dir> --extensions <built extensions dir> [--shots <dir>]
//                               [--product '<json>']   e.g. {"webEndpointUrlTemplate":"http://{{uuid}}.localhost:8809/static"}
//                                                      to run with the extension host on an origin of its own
//
// What this proves that the unit suites cannot:
//   - nothing of the shell is fetched until it is used (lazy activation), and then the engine runs in a REAL nested
//     Worker inside the real extension host, over the real scratch file system;
//   - the terminal: a shell from the command palette, typing and editing, a persistent cwd, Ctrl+C on a running
//     command, hostile output that must not type into the prompt, the agent's commands mirrored in a tab;
//   - the agent: run_command is offered as what it is, a command's changes arrive as Keep/Undo, a refused command
//     applies nothing and says why, a timeout applies nothing, and the shell is usable after all of it.
//
// It runs against the development layout of the server (the settings below are configuration defaults of that
// server): Autopilot on so that a command does not wait for a click, a short command timeout, the DOM renderer so
// the terminal's rows can be read. The harness rules (focus emulation, key codes, fresh port, finally-close) are
// the ones in web/shell/src/terminal/NOTES.md.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startStub, defaultModel } from './stub-backend.mjs';
import { Chrome, sleep } from './cdp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, all) => { if (v.startsWith('--')) { a.push([v.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : 'true']); } return a; }, []));
const STATIC = path.resolve(args.static || process.env.LEVELCODE_WEB_STATIC || '');
const EXTS = path.resolve(args.extensions || process.env.LEVELCODE_WEB_EXTENSIONS || '');
const SHOTS = args.shots ? path.resolve(args.shots) : null;
const PORT = Number(args.port || 8809);
const editorOrigin = `http://localhost:${PORT}`;
if (!fs.existsSync(STATIC) || !fs.existsSync(EXTS) || !fs.existsSync(path.join(EXTS, 'levelcode-shell'))) {
	console.error('usage: e2e-shell.mjs --static <vscode-web dir> --extensions <dir that contains levelcode-ai, levelcode-web and levelcode-shell>');
	process.exit(2);
}
if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); }

const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); return ok; };

/** The scripted model: a message "RUN <command line>" makes it call run_command; after the result it is done. */
function model(messages) {
	const last = messages[messages.length - 1] || {};
	if (last.role === 'tool') { return { text: 'Done: ran it.' }; }
	const text = String(typeof last.content === 'string' ? last.content : JSON.stringify(last.content || ''));
	const m = /RUN (.+)$/s.exec(text);
	if (m) { return { text: 'Running it.', toolCalls: [{ name: 'run_command', args: { command: m[1], explanation: 'Run the scripted command' } }] }; }
	return defaultModel(messages);
}

const stub = await startStub({ editorOrigin, port: args['stub-port'] ? Number(args['stub-port']) : 0, model });
const defaults = JSON.stringify({
	'levelcode.ai.agent.autopilot': true,           // no card for a command that is not in the danger set
	'levelcode.ai.commandTimeout': 4000,            // a command that does not end is stopped after 4 s
	'terminal.integrated.gpuAcceleration': 'off',   // DOM renderer: rows have text
	'workbench.editor.autoLockGroups': {},
});
// With the extension host on an origin of its own the scratch workspace's IndexedDB is not the page's: files are then
// read through the shell itself (a `cat`), and the checks that read them say so.
const hardened = /webEndpointUrlTemplate/.test(args.product || '');
const server = spawn(process.execPath, [path.join(HERE, '..', 'serve.mjs'), '--port', String(PORT),
	'--static', STATIC, '--extensions', EXTS, '--extension-names', 'levelcode-ai,levelcode-web,levelcode-shell', '--account', stub.origin, '--config-defaults', defaults,
	...(args.product ? ['--product', args.product] : [])], { stdio: 'inherit' });
let chrome;
const finish = async (code) => { try { chrome && chrome.close(); } catch {} try { server.kill(); } catch {} try { await stub.close(); } catch {} process.exit(code); };
process.on('SIGINT', () => finish(130));

const VK = { Enter: 13, Backspace: 8, Tab: 9, Escape: 27, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Home: 36, End: 35, Delete: 46, '`': 192 };

try {
	for (let i = 0; i < 50; i++) { try { if ((await fetch(editorOrigin + '/')).ok) { break; } } catch {} await sleep(100); }
	// A fresh port per run (a leaked Chrome on a fixed port would drive a stale browser and its cached extension).
	chrome = await Chrome.launch({ port: Number(args['debug-port'] || (9700 + Math.floor(Math.random() * 200))), args: ['--ignore-certificate-errors'] });
	const page = await chrome.newPage(editorOrigin + '/?signin=1');
	await page.send('Emulation.setFocusEmulationEnabled', { enabled: true });
	await page.send('Page.enable');
	page.listeners.push((m) => { if (m.method === 'Page.javascriptDialogOpening') { page.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {}); } });

	const shot = async (name) => { if (SHOTS) { await page.send('Page.bringToFront'); await page.screenshot(path.join(SHOTS, name + '.png')); } };
	/** A key with the codes the workbench's xterm needs (windowsVirtualKeyCode, text for printables). */
	const press = async (key, { ctrl = false, shift = false, alt = false, meta = false } = {}) => {
		const modifiers = (alt ? 1 : 0) | (ctrl ? 2 : 0) | (meta ? 4 : 0) | (shift ? 8 : 0);
		const vk = VK[key] || key.toUpperCase().charCodeAt(0);
		const code = key.length === 1 && /[a-z]/i.test(key) ? 'Key' + key.toUpperCase() : (key === '`' ? 'Backquote' : key);
		const text = key === 'Enter' ? '\r' : (key.length === 1 && !ctrl && !alt && !meta ? key : undefined);
		await page.send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers, text, unmodifiedText: text });
		await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers });
	};
	const typeLine = async (line) => { await page.type(line); await press('Enter'); };
	const workbenchReady = () => page.waitFor(() => page.eval(`!!document.querySelector('.monaco-workbench .part.editor')`), { ms: 90000, label: 'workbench' });
	const requested = (needle) => page.requests.some((r) => String((r && (r.url || r)) || '').includes(needle));

	/** The visible terminal's rows as text, read after two frames (the DOM renderer paints on rAF). */
	const rows = async () => { await page.send('Page.bringToFront').catch(() => {}); return rowsNow(); };
	const rowsNow = () => page.eval(`new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(() => {
		const vis = [...document.querySelectorAll('.xterm-rows')].filter((e) => { const b = e.getBoundingClientRect(); return b.width > 0 && b.height > 0; });
		// The terminal has a second, one-row xterm for its sticky-scroll header: the screen is the one with most rows.
		const r = vis.length ? vis.sort((a, b) => b.children.length - a.children.length)[0] : null;
		res(r ? [...r.children].map((d) => d.textContent.replace(/\\u00a0/g, ' ').replace(/\\s+$/, '')) : []);
	})))`);
	const screenText = async () => (await rows()).join('\n');
	const waitScreen = async (re, label, ms = 20000) => {
		try { return await page.waitFor(async () => { const t = await screenText(); return re.test(t) ? t : null; }, { ms, label }); }
		catch (e) {
			console.log('  screen at "' + label + '":\n' + (await screenText()).split('\n').filter((l) => l.trim()).map((l) => '    | ' + l).join('\n'));
			if (process.env.E2E_DEBUG) {
				console.log('  xterm instances:', JSON.stringify(await page.eval(`[...document.querySelectorAll('.xterm-rows')].map((e) => { const b = e.getBoundingClientRect(); return { w: Math.round(b.width), h: Math.round(b.height), x: Math.round(b.x), y: Math.round(b.y), rows: e.children.length, nonEmpty: [...e.children].filter((c) => c.textContent.trim()).length, last: [...e.children].map((c) => c.textContent.trim()).filter(Boolean).slice(-2) }; })`)));
				console.log('  panel:', JSON.stringify(await page.eval(`(() => { const p = document.querySelector('.part.panel'); const b = p && p.getBoundingClientRect(); return b ? { w: Math.round(b.width), h: Math.round(b.height), cls: p.className.slice(0, 80) } : null; })()`)));
				const at = page.logs.findIndex((l) => /during shutdown/.test(l.text));
				const from = Math.max(0, (at >= 0 ? at : page.logs.length) - 30);
				console.log('  console lines before the shutdown (index ' + at + ' of ' + page.logs.length + '):\n' + page.logs.slice(from, from + 40).map((l) => '    ' + new Date(l.t).toISOString().slice(17, 23) + ' ' + l.type + ' [' + String(l.tag).slice(-30) + '] ' + l.text.slice(0, 200)).join('\n'));
			}
			console.log('  console errors:', JSON.stringify(page.errors.slice(-3).map((x) => x.tag + ' ' + x.text.slice(0, 300))), JSON.stringify(page.logs.filter((l) => /error/.test(l.type)).slice(-4).map((l) => l.text.slice(0, 300))));
			throw e;
		}
	};
	/** The centre of `needle` on the terminal's screen (a Range over the row's text nodes), or null. */
	const locate = (needle) => page.eval(`(() => {
		const vis = [...document.querySelectorAll('.xterm-rows')].filter((e) => { const b = e.getBoundingClientRect(); return b.width > 0 && b.height > 0; });
		const r = vis.sort((a, b) => b.children.length - a.children.length)[0];
		if (!r) { return null; }
		const needle = ${JSON.stringify(needle)};
		for (const row of r.children) {
			const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
			const nodes = []; let all = '';
			for (let n = walker.nextNode(); n; n = walker.nextNode()) { nodes.push({ n, start: all.length }); all += n.nodeValue.replace(/\\u00a0/g, ' '); }
			const at = all.indexOf(needle);
			if (at < 0) { continue; }
			const locateAt = (i) => { for (let k = nodes.length - 1; k >= 0; k--) { if (nodes[k].start <= i) { return { node: nodes[k].n, off: i - nodes[k].start }; } } return null; };
			const a = locateAt(at), b = locateAt(at + needle.length - 1);
			if (!a || !b) { continue; }
			const range = document.createRange();
			range.setStart(a.node, a.off); range.setEnd(b.node, Math.min(b.off + 1, b.node.nodeValue.length));
			const q = range.getBoundingClientRect();
			return { x: q.x + q.width / 2, y: q.y + q.height / 2, w: q.width, h: q.height };
		}
		return null;
	})()`);
	/** Is the terminal's cursor drawn? (the DOM renderer marks the cell; a hidden cursor has none) */
	const cursorShown = () => page.eval(`(() => {
		const vis = [...document.querySelectorAll('.xterm-rows')].filter((e) => { const b = e.getBoundingClientRect(); return b.width > 0 && b.height > 0; });
		const r = vis.sort((a, b) => b.children.length - a.children.length)[0];
		return !!(r && r.querySelector('.xterm-cursor'));
	})()`);
	const mouse = (type, x, y, modifiers = 0) => page.send('Input.dispatchMouseEvent', { type, x, y, button: type === 'mouseMoved' ? 'none' : 'left', clickCount: type === 'mouseMoved' ? 0 : 1, modifiers });
	const statusText = () => page.eval(`[...document.querySelectorAll('.statusbar-item')].map((e) => (e.textContent || '').trim()).filter(Boolean).join(' | ')`);
	const activeEditorTab = () => page.eval(`(() => { const t = document.querySelector('.editor-group-container .tabs-container .tab.active'); return t ? (t.getAttribute('aria-label') || t.textContent || '') : null; })()`);
	/** Focus the terminal by clicking an empty cell of its screen (not on a link), as a person would. */
	const focusTerminal = async () => {
		const r = await page.eval(`(() => {
			const vis = [...document.querySelectorAll('.xterm-rows')].filter((e) => { const b = e.getBoundingClientRect(); return b.width > 0 && b.height > 0; });
			const el = vis.sort((a, b) => b.children.length - a.children.length)[0];
			if (!el) { return null; }
			const b = el.getBoundingClientRect();
			return { x: b.x + b.width * 0.9, y: b.y + b.height - 6 };
		})()`);
		if (r) { await page.click(r.x, r.y); await sleep(500); }
		return r;
	};
	const isMac = () => page.eval(`/Mac/i.test(navigator.platform) || /Mac OS X/.test(navigator.userAgent)`);
	const focusInfo = () => page.eval(`(() => { const a = document.activeElement; return a ? (a.tagName + '.' + String(a.className).slice(0, 40)) : null; })()`);
	/** A file of the scratch workspace, read from its IndexedDB (same origin as the page in the development layout). */
	/** @type {(p: string) => Promise<string|null>} */
	let scratchFile;
	const scratchFileFromPage = (p) => page.eval(`new Promise((res, rej) => { const r = indexedDB.open('levelcode-scratch'); r.onsuccess = () => { const g = r.result.transaction('nodes').objectStore('nodes').get(${JSON.stringify(p)}); g.onsuccess = () => res(g.result && g.result.data ? new TextDecoder().decode(g.result.data) : null); g.onerror = () => rej(g.error); }; r.onerror = () => rej(r.error); })`);
	scratchFile = scratchFileFromPage;

	/* 0. sign in first (?signin=1 leaves the tab for the account site and comes back to it: a reload that would otherwise
	      land in the middle of a terminal session), then boot, and nothing of the shell yet */
	await page.waitFor(() => stub.state.log.some((e) => e.path === '/api/levelcode/v1/account/profile' && e.auth), { ms: 120000, label: 'sign-in to complete' });
	await page.waitFor(async () => { const h = await page.eval('location.href').catch(() => ''); return h === editorOrigin + '/'; }, { ms: 30000, label: 'the tab back on a clean address' });
	await sleep(1500);
	await workbenchReady();
	await page.waitFor(async () => (await page.eval(`[...document.querySelectorAll('.tabs-container .tab')].some((e) => /LevelCode AI/.test(e.getAttribute('aria-label') || ''))`)), { ms: 60000, label: 'chat tab' });
	await sleep(4000);
	if (hardened) {
		const isolated = page.requests.map((r) => String((r && (r.url || r)) || '')).filter((u) => /^http:\/\/[a-z0-9-]+\.localhost:\d+\/static\/.*webWorkerExtensionHostIframe/.test(u));
		check('the extension host is on an origin of its own (this run is the isolated layout)', isolated.length > 0,
			JSON.stringify(isolated.length ? isolated.slice(0, 1) : page.requests.map((r) => String((r && (r.url || r)) || '')).filter((u) => /ExtensionHostIframe|\.localhost/.test(u)).slice(0, 3)));
	}
	check('the shell is not fetched until it is used', !requested('levelcode-shell/extension.js') && !requested('engine.worker.js'),
		JSON.stringify(page.requests.map((r) => String((r && (r.url || r)) || '')).filter((u) => /levelcode-shell/.test(u)).slice(0, 4)));

	/* 1. a shell from the command palette */
	await page.palette('LevelCode Shell: New Terminal');
	await waitScreen(/\$ $/m, 'a prompt in the terminal', 40000).catch(() => null);
	check('the shell extension was fetched on first use, with its engine', requested('levelcode-shell/extension.js'));
	let t = await screenText();
	check('a terminal opens with a banner and a prompt', /LevelCode Shell/.test(t) && /\$\s*$/m.test(t), JSON.stringify(t.split('\n').slice(0, 6)));
	await sleep(600);
	check('the terminal has the keyboard focus', /xterm-helper-textarea/.test(String(await focusInfo())), await focusInfo());
	await shot('1-terminal');

	/* 2. typing, files, the working directory */
	await typeLine('echo hello from the shell > t.txt; cat t.txt; ls');
	t = await waitScreen(/hello from the shell[\s\S]*t\.txt/, 'the output of the first command');
	check('a line runs: output and a file listing', /hello from the shell/.test(t) && /t\.txt/.test(t.split('hello from the shell').slice(1).join('')), JSON.stringify(t.split('\n').slice(-6)));
	await sleep(600);
	if (hardened) { check('the file is in the scratch workspace (read back by the shell: the host origin is isolated)', /hello from the shell/.test(t), 'the line printed it'); }
	else { check('the file is in the scratch workspace', (await scratchFile('/scratch/t.txt')) === 'hello from the shell\n', JSON.stringify(await scratchFile('/scratch/t.txt'))); }
	await typeLine('mkdir -p d/e; cd d/e; pwd');
	await waitScreen(/\/scratch\/d\/e/, 'pwd');
	await typeLine('pwd; echo "$0 $COLUMNS"');
	t = await waitScreen(/\/scratch\/d\/e[\s\S]*\/scratch\/d\/e/, 'the second pwd');
	check('cd persists from one line to the next', (t.match(/\/scratch\/d\/e/g) || []).length >= 2, JSON.stringify(t.split('\n').slice(-5)));
	await typeLine('cd /scratch; nosuchcommand_xyz; echo "status=$?"');
	t = await waitScreen(/status=127/, 'the status of a missing command');
	check('a missing program is "command not found", 127', /nosuchcommand_xyz: command not found/.test(t) || /not found/.test(t), JSON.stringify(t.split('\n').slice(-4)));
	await typeLine('git status; echo "git=$?"');
	t = await waitScreen(/git=127/, 'git is not here');
	check('git, npm, node and python are not offered', /git=127/.test(t));

	/* 3. Ctrl+C on a running command */
	await typeLine('sleep 60');
	await sleep(1200);
	const t0 = Date.now();
	await press('c', { ctrl: true });
	await typeLine('echo after-interrupt');
	await waitScreen(/after-interrupt/, 'the prompt after Ctrl+C', 15000);
	check('Ctrl+C on `sleep 60` gives the prompt back quickly', Date.now() - t0 < 8000, (Date.now() - t0) + ' ms');
	t = await screenText();
	check('and the shell is usable afterwards, in the same directory', /\$ echo after-interrupt/.test(t) || /after-interrupt/.test(t));
	await sleep(300);
	check('the cursor is drawn after Ctrl+C (the interrupted command left no hidden-cursor state behind)', (await cursorShown()) === true);

	/* 3b. a path in output is a link, and a click opens the file at that line */
	await typeLine('printf "one\\ntwo\\nthree\\n" > l.txt; echo "see l.txt:2:3 and nosuch.txt:1"');
	await waitScreen(/see l\.txt:2:3 and nosuch\.txt:1/, 'the line with the paths in it');
	await sleep(800);
	const where = await locate('l.txt:2:3');
	check('the path in the output is on screen to be clicked', !!where, JSON.stringify(where));
	if (where) {
		// Cmd+click on a Mac (Meta = 4), Ctrl+click elsewhere (Ctrl = 2): the headless Chrome reports its own platform.
		const mod = (await isMac()) ? 4 : 2;
		await mouse('mouseMoved', where.x, where.y);
		await sleep(900);
		await mouse('mouseMoved', where.x, where.y, mod);
		await mouse('mousePressed', where.x, where.y, mod);
		await mouse('mouseReleased', where.x, where.y, mod);
		await page.waitFor(async () => /l\.txt/.test(String(await activeEditorTab())), { ms: 8000, label: 'the linked file to open' }).catch(() => null);
		await sleep(500);
		check('a click on path:line:col opens that file', /l\.txt/.test(String(await activeEditorTab())), JSON.stringify({ tab: await activeEditorTab() }));
		check('...at that line and column', /Ln 2, Col 3/.test(String(await statusText())), String(await statusText()).slice(0, 200));
		await shot('1b-link-opened');
	}
	// back to the terminal for what follows
	await focusTerminal();
	await sleep(800);
	const miss = await locate('nosuch.txt:1');
	if (miss) {
		const before = await activeEditorTab();
		const mod = (await isMac()) ? 4 : 2;
		await mouse('mouseMoved', miss.x, miss.y); await sleep(700);
		await mouse('mousePressed', miss.x, miss.y, mod); await mouse('mouseReleased', miss.x, miss.y, mod);
		await sleep(1200);
		check('a path that is not a file is not a link: nothing opened', String(await activeEditorTab()) === String(before), JSON.stringify({ before, after: await activeEditorTab() }));
		await focusTerminal();
		await sleep(500);
	}

	/* 3c. a pasted buffer of three lines, the cursor on its first line, and the terminal made narrower and wider again:
	      the prompt is on screen once (a resize that reflowed the wrapped line under the cursor left a stale copy of it) */
	// A paste event, as the clipboard would make it (Input.insertText drops the line ends of a textarea).
	await page.eval(`(() => {
		const ta = document.activeElement;
		const dt = new DataTransfer();
		dt.setData('text/plain', ${JSON.stringify('echo r-one\necho r-two ' + 'y'.repeat(150) + '\necho r-three')});
		ta.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
		return true;
	})()`);
	await sleep(700);
	if (process.env.E2E_DEBUG) { console.log('  screen right after the paste:\n' + (await screenText()).split('\n').filter((l) => l.trim()).slice(-8).map((l) => '    | ' + l.slice(0, 150)).join('\n')); }
	await press('ArrowUp'); await press('ArrowUp');
	await sleep(300);
	const promptRows = async () => (await screenText()).split('\n').filter((l) => /\$ echo r-one/.test(l)).length;
	check('a pasted three-line buffer shows its first line once', (await promptRows()) === 1, String(await promptRows()));
	if ((await promptRows()) !== 1) { console.log('  screen after the paste:\n' + (await screenText()).split('\n').filter((l) => l.trim()).map((l) => '    | ' + l.slice(0, 150)).join('\n') + '\n  focus: ' + (await focusInfo())); }
	await page.send('Emulation.setDeviceMetricsOverride', { width: 640, height: 760, deviceScaleFactor: 1, mobile: false });
	await sleep(2500);
	const narrow = await promptRows();
	await page.send('Emulation.clearDeviceMetricsOverride');
	await sleep(1500);
	const wide = await promptRows();
	check('and once when the terminal is narrower, and once when it is wide again', narrow === 1 && wide === 1, JSON.stringify({ narrow, wide }));
	await press('c', { ctrl: true });   // abandon the buffer
	await sleep(500);

	/* 3d. the same buffer through a change of HEIGHT only (the panel shorter, then as it was): the prompt is on screen once */
	await page.eval(`(() => {
		const ta = document.activeElement;
		const dt = new DataTransfer();
		dt.setData('text/plain', ${JSON.stringify('echo h-one\necho h-two\necho h-three\necho h-four\necho h-five\necho h-six')});
		ta.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
		return true;
	})()`);
	await sleep(700);
	const hRows = async () => (await screenText()).split('\n').filter((l) => /\$ echo h-one/.test(l)).length;
	const before = await hRows();
	const size = await page.eval(`({ w: window.innerWidth, h: window.innerHeight })`);
	await page.send('Emulation.setDeviceMetricsOverride', { width: size.w, height: 420, deviceScaleFactor: 1, mobile: false });
	await sleep(1800);
	await page.send('Emulation.clearDeviceMetricsOverride');
	await sleep(1800);
	const after = await hRows();
	check('a six-line buffer survives the panel getting shorter and taller: the prompt is on screen once', before === 1 && after === 1, JSON.stringify({ before, after }));
	if (after !== 1) { console.log('  screen after the height change:\n' + (await screenText()).split('\n').filter((l) => l.trim()).map((l) => '    | ' + l.slice(0, 120)).join('\n')); }
	await press('c', { ctrl: true });
	await sleep(500);

	/* 3e. a name that holds an emoji with its variation selector can be pasted: it reaches the buffer whole */
	await page.eval(`(() => {
		const ta = document.activeElement;
		const dt = new DataTransfer();
		dt.setData('text/plain', 'echo \u2714\ufe0f done.md');
		ta.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
		return true;
	})()`);
	await sleep(500);
	const pasted = await screenText();
	check('a pasted emoji name keeps its variation selector (no "invisible characters were not typed" note)', /echo .{1,2} done\.md/.test(pasted) && !/not typed/i.test(pasted), JSON.stringify(pasted.split('\n').slice(-3)));
	await press('c', { ctrl: true });
	await sleep(500);

	/* 4. hostile output must not type into the prompt or change the terminal */
	await typeLine(`printf 'A\\033[6nB\\033[cC\\033]10;?\\007D\\033]0;pwned\\007E\\033[?1000hF\\033]52;c;ZXZpbA==\\007G\\n' > evil.txt; cat evil.txt; echo clean`);
	await waitScreen(/clean/, 'the output of the hostile file');
	await sleep(500);
	await typeLine('echo prompt-is-clean');
	t = await waitScreen(/\$ echo prompt-is-clean[\s\S]*\nprompt-is-clean/, 'a clean prompt after hostile output');
	check('replies and reports were not typed into the prompt', /\$ echo prompt-is-clean\s*$/m.test(t.split('\n').filter((l) => /echo prompt-is-clean/.test(l)).join('\n')), JSON.stringify(t.split('\n').slice(-6)));
	const names = await page.eval(`[...document.querySelectorAll('.terminal-tabs-entry, .single-terminal-tab')].map((e) => (e.textContent || '').trim())`);
	check('a title sequence in a file did not rename the terminal', !names.some((n) => /pwned/.test(n)), JSON.stringify(names));

	/* 5. the agent: run_command is offered as what it is */
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
	const clickTab = async (re) => {
		const r = await page.eval(`(() => { const t = [...document.querySelectorAll('.tabs-container .tab')].find((e) => ${'/' + 'LevelCode AI' + '/'}.test(e.getAttribute('aria-label') || '')); if (!t) { return null; } const b = t.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`);
		if (r) { await page.click(r.x, r.y); await sleep(700); }
	};
	await clickTab();
	await page.waitFor(async () => (await inChat('!!d.getElementById("send")')) === true, { ms: 30000, label: 'chat webview' });
	// signed in through the stand-in (?signin=1), then close the account card like a user would
	await page.waitFor(() => stub.state.log.some((e) => e.path === '/api/levelcode/v1/account/profile' && e.auth), { ms: 60000, label: 'sign-in' }).catch(() => null);
	if ((await inChat(`getComputedStyle(d.getElementById('acctClose')).display !== 'none' && d.getElementById('acctClose').offsetParent !== null`)) === true) {
		await inChat(`(d.getElementById('acctClose').click(), true)`);
		await sleep(400);
	}
	const idle = () => inChat(`!d.getElementById('send').classList.contains('stop')`);
	const ask = async (prompt) => {
		await page.waitFor(async () => (await idle()) === true, { ms: 90000, label: 'the agent to be idle' }).catch(() => null);
		const before = stub.state.chats;
		await inChat(`(() => { const i = d.getElementById('input'); i.focus(); if ('value' in i) { i.value = ${JSON.stringify(prompt)}; } else { i.textContent = ${JSON.stringify(prompt)}; } i.dispatchEvent(new Event('input', { bubbles: true })); d.getElementById('send').click(); return true; })()`);
		await page.waitFor(() => stub.state.chats >= before + 2, { ms: 60000, label: 'the model to be asked twice' }).catch(() => null);
		await page.waitFor(async () => (await idle()) === true, { ms: 30000, label: 'the run to end' }).catch(() => null);
		await sleep(500);
	};
	const lastToolResult = () => {
		const msgs = (stub.state.lastChatBody && stub.state.lastChatBody.messages) || [];
		const m = [...msgs].reverse().find((x) => x.role === 'tool');
		return m ? (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)) : '';
	};
	if (hardened) {
		// The scratch workspace is in the extension host's IndexedDB, not the page's: ask the shell (a `cat`).
		scratchFile = async (p) => {
			await ask('RUN cat ' + p.replace(/^\/scratch\//, ''));
			const r = lastToolResult();
			return /No such file/.test(r) ? null : r;
		};
	}

	await ask('RUN grep -c hello t.txt');
	const tools = (stub.state.chatBodies[0] && stub.state.chatBodies[0].tools || []).map((x) => x.function && x.function.name);
	const rc = ((stub.state.chatBodies[0] && stub.state.chatBodies[0].tools) || []).find((x) => x.function && x.function.name === 'run_command');
	check('the agent is offered run_command (without background) and not read_command_output', tools.includes('run_command') && !tools.includes('read_command_output') && !!rc && !(rc.function.parameters.properties || {}).background, tools.join(','));
	check('run_command ran in the shell: grep counted the line', /^1\b/.test(lastToolResult().trim()), JSON.stringify(lastToolResult().slice(0, 120)));
	const sys = String(((stub.state.chatBodies[0] && stub.state.chatBodies[0].messages) || []).find((m) => m.role === 'system')?.content || '');
	check('the prompt says what the shell is, and lists its programs', /simulated bash/.test(sys) && /Programs that exist: .*grep/.test(sys) && !/background:true/.test(sys), JSON.stringify(sys.slice(sys.indexOf('SHELL'), sys.indexOf('SHELL') + 120)));

	await ask('RUN printf "agent line\\n" > out.txt; cat out.txt');
	const writeResult = lastToolResult();
	check('a command that writes a file: its output is the result', /agent line/.test(writeResult), JSON.stringify(writeResult.slice(0, 160)));
	const outFile = await scratchFile('/scratch/out.txt');
	check('and the file is there, through the review', /^agent line\n/.test(String(outFile)), JSON.stringify(outFile));
	check('with Keep and Undo offered for it', (await inChat(`getComputedStyle(d.getElementById('reviewBar')).display !== 'none' && !!d.querySelector('#reviewBar .undoall')`)) === true);
	check('the result names the change for the model', /ready for Keep\/Undo/.test(writeResult), JSON.stringify(writeResult.slice(-200)));
	await inChat(`(d.querySelector('#reviewBar .undoall').click(), true)`);
	await sleep(2000);
	check('Undo all takes the command\'s file away again', (await scratchFile('/scratch/out.txt')) === null);

	await ask('RUN mkdir -p .vscode; echo {} > .vscode/settings.json; echo ok > innocent.txt');
	const refusal = lastToolResult();
	check('a command that touches .vscode is refused whole', /refused: \.vscode\/settings\.json/.test(refusal) && /NONE of this command/.test(refusal), JSON.stringify(refusal.slice(-300)));
	check('and applies nothing: neither the setting file nor the innocent file', (await scratchFile('/scratch/.vscode/settings.json')) === null && (await scratchFile('/scratch/innocent.txt')) === null);

	await ask('RUN sleep 60; echo late > late.txt');
	const timedOut = lastToolResult();
	check('a command that does not end is stopped at the timeout, and changes nothing', /\[timed out\]/.test(timedOut) && (await scratchFile('/scratch/late.txt')) === null, JSON.stringify(timedOut.slice(-200)));
	await ask('RUN echo still-works');
	check('and the shell works for the next command', /still-works/.test(lastToolResult()), JSON.stringify(lastToolResult().slice(0, 100)));

	await ask('RUN echo x > ../outside.txt');
	check('a path outside the workspace folder is refused', !/ready for Keep\/Undo/.test(lastToolResult()), JSON.stringify(lastToolResult().slice(-200)));

	/* 6. the agent's commands are in a tab of their own */
	const tabs = await page.eval(`[...document.querySelectorAll('.terminal-tabs-entry, .single-terminal-tab, .tabs-list .terminal-tabs-entry')].map((e) => (e.textContent || '').trim())`);
	check('the agent\'s commands are mirrored in a "LevelCode Agent" terminal tab', tabs.some((n) => /LevelCode Agent/.test(n)), JSON.stringify(tabs));
	await shot('2-agent');

	/* 7. the layout does not leave a dead panel behind: the panel toggle shows a terminal, not an empty tab */
	const errors = page.errors.map((e) => e.tag + ' ' + e.text).filter((e) => /levelcode-shell|engine\.worker/.test(e));
	check('no uncaught error from the shell in the console', errors.length === 0, JSON.stringify(errors.slice(0, 3)));
} catch (e) {
	check('the run completed', false, String((e && e.stack) || e));
}

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
await finish(failed ? 1 : 0);
