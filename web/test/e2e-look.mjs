#!/usr/bin/env node
// What a visitor sees: the look of the browser edition, in a real (headless) Chrome.
//
//   - the page follows the system's light/dark setting, with the build's own two themes;
//   - the chat is the first thing there is: a centred greeting with starters, a pill composer, and the list
//     of conversations docked on its left when the window is wide, folded away when it is narrow;
//   - nothing opens in front of it (no Welcome page, no second chat from the workbench, no source-control /
//     run / extensions icons that lead to things this edition does not have);
//   - the layout switch in the status bar moves between "the chat on its own" and "Explorer, files and the
//     chat docked on the right", and a docked layout is docked again after a reload.
//
// The sign-in is the stand-in's (?signin=1), exactly as in e2e-signin-tab.mjs; the chat's empty state is what
// a signed-in visitor sees.
//
//   node web/test/e2e-look.mjs --dist <release dir> --stub-port <the account port it was built with> [--shots <dir>]
//
// Release only: the look is a property of what the build ships (the theme package, chrome.css, the skinned chat
// page), and the development server's pieces do not include them.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startStub } from './stub-backend.mjs';
import { Chrome, sleep } from './cdp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, all) => { if (v.startsWith('--')) { a.push([v.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : 'true']); } return a; }, []));
const DIST = args.dist ? path.resolve(args.dist) : null;
const SHOTS = args.shots ? path.resolve(args.shots) : null;
const PORT = Number(args.port || 8807);
const editorOrigin = `http://localhost:${PORT}`;
if (!DIST || !fs.existsSync(DIST)) {
	console.error('usage: e2e-look.mjs --dist <release dir> [--stub-port N] [--shots dir]');
	process.exit(2);
}
if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); }

const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); return ok; };

const stub = await startStub({ editorOrigin, port: args['stub-port'] ? Number(args['stub-port']) : 0 });
const server = spawn(process.execPath, [path.join(HERE, '..', 'serve.mjs'), '--port', String(PORT), '--dist', DIST], { stdio: 'inherit' });
let chrome;
const finish = async (code) => { try { chrome && chrome.close(); } catch {} try { server.kill(); } catch {} try { await stub.close(); } catch {} process.exit(code); };
process.on('SIGINT', () => finish(130));

try {
	for (let i = 0; i < 50; i++) { try { if ((await fetch(editorOrigin + '/')).ok) { break; } } catch {} await sleep(100); }
	chrome = await Chrome.launch({ port: Number(args['debug-port'] || 9558), width: 1440, height: 900, args: ['--ignore-certificate-errors'] });
	const page = await chrome.newPage(editorOrigin + '/?signin=1');

	const shot = async (name) => { if (SHOTS) { await page.screenshot(path.join(SHOTS, name + '.png')); } };
	const resize = async (w, h) => { await page.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false }); await sleep(900); };
	const scheme = async (value) => { await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value }] }); await sleep(1800); };
	const workbenchReady = () => page.waitFor(() => page.eval(`!!document.querySelector('.monaco-workbench .part.editor')`), { ms: 90000, label: 'workbench' });
	/** Evaluate in the chat webview's document (`d`), whichever frame it is. */
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
	const chatReady = () => page.waitFor(async () => (await inChat(`!!d.getElementById('send')`)) === true, { ms: 90000, label: 'the chat page' });
	/** The groups of the editor area: how many, and which of them holds the chat. */
	const groups = () => page.eval(`(() => {
		const gs = [...document.querySelectorAll('.editor-group-container')].filter((g) => g.getBoundingClientRect().width > 0);
		return gs.map((g) => { const b = g.getBoundingClientRect(); return { x: Math.round(b.x), w: Math.round(b.width), chat: [...g.querySelectorAll('.tab')].some((t) => /LevelCode AI/.test(t.getAttribute('aria-label') || '')), tabs: [...g.querySelectorAll('.tab')].map((t) => t.getAttribute('aria-label') || '') }; }).sort((a, b) => a.x - b.x);
	})()`);
	const visible = (sel) => page.eval(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) { return false; } const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden'; })()`);
	const layoutItemText = () => page.eval(`(() => { const a = [...document.querySelectorAll('.statusbar-item')].find((x) => /Chat\\s*$|Editor \\+ chat/.test((x.textContent || '').trim())); return a ? (a.textContent || '').trim() : null; })()`);
	const clickLayoutItem = async () => {
		const r = await page.waitFor(() => page.eval(`(() => { const a = [...document.querySelectorAll('.statusbar-item')].find((x) => /Chat\\s*$|Editor \\+ chat/.test((x.textContent || '').trim())); if (!a) { return null; } const b = a.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`), { ms: 20000, label: 'the layout item in the status bar' });
		await page.click(r.x, r.y);
	};

	/* 1. the first screen */
	await workbenchReady();
	await chatReady();
	await sleep(5000);   // the layout is applied by the extension a moment after start
	await shot('1-first-screen');
	const chat = await inChat(`({
		lcWeb: d.body.classList.contains('lc-web'),
		hero: (d.querySelector('.lcw-hero') || {}).textContent || null,
		starters: [...d.querySelectorAll('.starter')].map((b) => b.textContent),
		railDisplay: getComputedStyle(d.getElementById('sessOverlay')).display,
		railPosition: getComputedStyle(d.getElementById('sessOverlay')).position,
		panelRole: (d.querySelector('#sessOverlay .sesspanel') || {}).getAttribute && d.querySelector('#sessOverlay .sesspanel').getAttribute('role'),
		newChat: !!d.querySelector('#sessOverlay .lcw-new'),
		width: innerWidth,
		composer: (() => { const b = d.getElementById('composer').getBoundingClientRect(); return { x: Math.round(b.x), w: Math.round(b.width) }; })(),
	})`);
	check('the chat page carries the browser skin', chat && chat.lcWeb === true, JSON.stringify(chat && chat.lcWeb));
	check('the empty chat greets with one question and four starters', !!chat && chat.hero === 'What do you want to build?' && chat.starters.length === 4, JSON.stringify(chat && { hero: chat.hero, starters: chat.starters }));
	check('wide window: the conversations are docked on the left, as part of the page', !!chat && chat.width >= 1000 && chat.railDisplay !== 'none' && chat.railPosition === 'fixed' && chat.panelRole === 'complementary' && chat.newChat, JSON.stringify(chat && { w: chat.width, d: chat.railDisplay, p: chat.railPosition, r: chat.panelRole, n: chat.newChat }));
	check('the composer sits in the reading column, not edge to edge', !!chat && chat.composer.w <= 800 && chat.composer.w > 300, JSON.stringify(chat && chat.composer));

	const tabs = await page.eval(`[...document.querySelectorAll('.tabs-container .tab')].map((e) => e.getAttribute('aria-label') || '')`);
	check('nothing was opened in front of the chat: no Welcome page, no second chat', Array.isArray(tabs) && !tabs.some((t) => /Welcome|Get Started|Walkthrough/i.test(t)) && tabs.filter((t) => /LevelCode AI/.test(t)).length === 1, JSON.stringify(tabs));
	const g1 = await groups();
	check('the first layout is the chat on its own: one editor group, side bars away', g1.length === 1 && !(await visible('.part.sidebar')) && !(await visible('.part.auxiliarybar')), JSON.stringify(g1.map((g) => g.w)));
	check('the status bar offers the switch', (await layoutItemText()) === 'Chat', JSON.stringify(await layoutItemText()));

	/* 2. a starter fills the composer and does not send it */
	const before = stub.state.chats;
	await inChat(`(() => { const b = d.querySelector('.starter'); b.click(); return true; })()`);
	await sleep(400);
	const filled = await inChat(`({ value: d.getElementById('input').value || d.getElementById('input').textContent })`);
	check('a starter writes its prompt into the composer and leaves the sending to the visitor', !!filled && /index\.html/.test(filled.value) && stub.state.chats === before, JSON.stringify(filled));
	await inChat(`(() => { const i = d.getElementById('input'); if ('value' in i) { i.value = ''; } else { i.textContent = ''; } i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);

	/* 3. light and dark follow the system */
	// The theme is a class of the workbench element (`vs` / `vs-dark` and the theme's own id); the colours are on its parts.
	const theme = () => page.eval(`(() => {
		const wb = document.querySelector('.monaco-workbench');
		const bg = (s) => { const e = document.querySelector(s); return e ? getComputedStyle(e).backgroundColor : null; };
		return { light: wb.classList.contains('vs'), dark: wb.classList.contains('vs-dark'),
			id: [...wb.classList].find((c) => /web-(dark|light)-json$/.test(c)) || null,
			chrome: bg('.part.sidebar'), editor: bg('.part.editor > .content') };
	})()`);
	const chatVar = () => inChat(`getComputedStyle(d.documentElement).getPropertyValue('--vscode-editor-background').trim()`);
	await scheme('light');
	const light = await theme();
	const chatLight = await chatVar();
	await shot('2-light');
	await scheme('dark');
	const dark = await theme();
	const chatDark = await chatVar();
	await shot('3-dark');
	check('the workbench follows the system: this build\'s light theme, then its dark one', light.light && !light.dark && /web-light-json$/.test(light.id) && dark.dark && !dark.light && /web-dark-json$/.test(dark.id), JSON.stringify({ light: light.id, dark: dark.id }));
	check('dark: the editor is one step above the chrome', dark.editor === 'rgb(27, 28, 34)' && dark.chrome === 'rgb(21, 22, 27)', JSON.stringify(dark));
	check('light: the editor is white on a pale chrome', light.editor === 'rgb(255, 255, 255)' && light.chrome === 'rgb(243, 243, 246)', JSON.stringify(light));
	check('the chat page, a webview of its own, is handed the same palette', chatDark === '#1b1c22' && chatLight === '#ffffff', JSON.stringify({ light: chatLight, dark: chatDark }));

	/* 4. narrow: the conversations fold away, the chat stays usable */
	await resize(900, 800);
	await sleep(600);
	const narrow = await inChat(`({ docked: getComputedStyle(d.getElementById('sessOverlay')).display !== 'none', role: d.querySelector('#sessOverlay .sesspanel').getAttribute('role'), modal: d.querySelector('#sessOverlay .sesspanel').getAttribute('aria-modal') })`);
	await shot('4-900');
	check('below 1000 px the conversation list is a dialog again, closed until it is asked for', !!narrow && narrow.role === 'dialog' && narrow.modal === 'true' && narrow.docked === false, JSON.stringify(narrow));
	await resize(1440, 900);

	/* 5. the layout switch */
	await clickLayoutItem();
	const split = await page.waitFor(async () => { const g = await groups(); return g.length === 2 ? g : null; }, { ms: 30000, label: 'two editor groups' }).catch(() => null);
	await sleep(1500);
	await shot('5-split');
	check('the switch gives files on the left and the chat docked on the right', !!split && !split[0].chat && split[1].chat && split[0].tabs.some((t) => /README/.test(t)), JSON.stringify(split));
	check('with the Explorer open on the left', (await visible('.explorer-folders-view')) === true);
	check('the status item now says which one it is', (await layoutItemText()) === 'Editor + chat', JSON.stringify(await layoutItemText()));
	const hidden = await page.eval(`(() => {
		const icons = ['source-control-view-icon', 'run-view-icon', 'extensions-view-icon'].map((c) => {
			const a = document.querySelector('a.action-label.codicon-' + c);
			if (!a) { return { c, found: false }; }
			const li = a.closest('li') || a;
			return { c, found: true, shown: li.getBoundingClientRect().width > 0 && getComputedStyle(li).display !== 'none' };
		});
		const explorer = document.querySelector('a.action-label.codicon-explorer-view-icon');
		return { icons, explorer: !!explorer && explorer.closest('li').getBoundingClientRect().width > 0 };
	})()`);
	check('source control, run and extensions are not offered; the Explorer is', hidden.icons.every((i) => !i.shown) && hidden.explorer, JSON.stringify(hidden));
	check('the chat stays out of the secondary side bar (the workbench\'s own chat is not shown)', !(await visible('.part.auxiliarybar')), '');

	/* 6. a docked layout is docked again after a reload; switching back puts the chat on its own */
	await page.goto(editorOrigin + '/');
	await workbenchReady();
	const again = await page.waitFor(async () => { const g = await groups(); return g.length === 2 && g[1].chat ? g : null; }, { ms: 60000, label: 'the docked layout after reload' }).catch(() => null);
	check('after a reload the chat is docked on the right again', !!again, JSON.stringify(again));
	await clickLayoutItem();
	const single = await page.waitFor(async () => { const g = await groups(); return g.length === 1 && g[0].chat ? g : null; }, { ms: 30000, label: 'the chat on its own' }).catch(() => null);
	check('switching back puts the chat in a single group again, as the tab on show', !!single, JSON.stringify(single));
	check('and the side bar is put away', !(await visible('.part.sidebar')));
	await shot('6-back');
} catch (e) {
	check('the run completed', false, String((e && e.stack) || e));
}

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
await finish(failed ? 1 : 0);
