#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  LevelCode — rich diagrams, checked in a real browser  (docs/RICH-DIAGRAMS.md, acceptance criteria)
 *
 *  The unit suites prove the pieces: the validator, the ladder, the layout's geometry, the painter's
 *  allow-lists. What they cannot prove is the thing the spec actually asks for — that in the CHAT, in
 *  a browser, under the page's real Content-Security-Policy, a diagram is drawn, looks right in both
 *  themes, and that a hostile spec executes nothing and fetches nothing.
 *
 *  So this loads the shipped media/chat.html in headless Chrome exactly as the editor would build it
 *  (the same bundle injection, the same CSP, a stand-in for acquireVsCodeApi), plays host messages at
 *  it — records made by the real diagram service — and then asks the page what happened:
 *
 *    • every diagram became an <svg> made only of the painter's elements; no script, link, image or
 *      foreignObject exists anywhere inside a diagram card, and no element carries an event handler
 *    • the hostile labels are on the page AS TEXT
 *    • zero CSP violations, zero resource requests, zero uncaught errors
 *    • the placeholder → picture swap, the auto-fixed badge, the degraded banner, the failed view
 *    • a clicked node asks the host to open a link by NODE ID only
 *    • SVG and PNG export produce data the host's own structural check accepts
 *    • with the diagram modules MISSING from the page, each diagram is shown as the host's text
 *      version of the same spec — the spec's fallback — and still nothing runs
 *
 *  …and it writes a screenshot per theme, because "house style in light and dark" is finally a thing
 *  someone has to look at.
 *
 *  RUN:    node extensions/levelcode-ai/scripts/diagram-browser-check.js [--out <dir>]
 *  NEEDS:  Google Chrome or Chromium (set CHROME=/path/to/binary if it is somewhere unusual).
 *  EXIT:   0 all checks pass · 1 a check failed · 2 no browser found (nothing was checked).
 *
 *  Not part of scripts/test-extensions.sh: that gate is plain Node, and stays that way.
 *--------------------------------------------------------------------------------------------*/
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const EXT = path.join(__dirname, '..');
const bundle = require(path.join(EXT, 'diagram', 'bundle'));
const { createDiagrams } = require(path.join(EXT, 'diagram', 'service'));
const exportCheck = require(path.join(EXT, 'diagram', 'exportCheck'));
const repair = require(path.join(EXT, 'diagram', 'repair'));
const ascii = require(path.join(EXT, 'diagram', 'ascii'));

function findChrome() {
	const candidates = [process.env.CHROME,
		'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium',
		'/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
	return candidates.find((c) => c && fs.existsSync(c)) || null;
}

// ---- the records, made by the real service ------------------------------------------------------
const gallery = JSON.parse(fs.readFileSync(path.join(EXT, 'test', 'fixtures', 'diagrams', 'gallery.json'), 'utf8'));
const specOf = (name) => JSON.parse(JSON.stringify(gallery.find((g) => g.name === name).spec));
const HOSTILE = {
	title: '</title><script>window.__pwned = 1</script>',
	nodes: [
		{ id: 'a', label: '<img src=x onerror="window.__pwned=2">', sub: '"><script>window.__pwned=3</script>' },
		{ id: 'b', label: "'><svg onload=window.__pwned=4>", link: { path: 'javascript:window.__pwned=5' } },
		{ id: 'c', label: '</text><foreignObject>', sub: '<a href="https://example.invalid/x">x</a>', link: { path: 'agent.js' } },
		{ id: 'd', label: '<iframe src=//example.invalid>', shape: 'decision' }
	],
	edges: [{ from: 'a', to: 'b', label: '<style>*{display:none}' }, { from: 'b', to: 'c', label: '" onmouseover="x' }, { from: 'c', to: 'd' }],
	groups: [{ id: 'g', label: '<object data=//example.invalid>' }]
};
HOSTILE.nodes[0].group = 'g';

function makeRecords() {
	const service = createDiagrams({ resolveLink: (link) => (/^(agent\.js|providers\/index\.js)$/.test(link.path) ? { ok: true, path: link.path } : { ok: false, reason: 'not a file in this workspace' }) });
	const out = {};
	let k = 0;
	const draw = (name, input, twice) => {
		service.beginRun();
		let msgs = service.render(input, { key: 'key-' + name, model: 'check' }).post;
		if (twice) { msgs = msgs.concat(service.render(input, { key: 'key-' + name + '-again', model: 'check' }).post); }
		msgs = msgs.concat(service.endRun());
		out[name] = msgs.filter((m) => m.type === 'diagram').pop();
		k++;
	};
	draw('jev', specOf('jev'));
	draw('arch', specOf('arch'));
	draw('decision', specOf('decision'));
	draw('twelve', specOf('twelve'));
	const long = specOf('jev'); long.title = 'Long labels are shortened, never rejected'; long.nodes[0].label = 'Customer message with the whole account history'; long.nodes[2].shape = 'hexagon';
	draw('fixed', long);
	const bad = specOf('jev'); bad.title = 'A diagram that lost an edge'; bad.edges[1].to = 'billing'; bad.nodes[2].accent = true;
	draw('degraded', bad, true);
	draw('failed', { title: 'Nothing to draw', nodes: [], edges: [] }, true);
	draw('hostile', HOSTILE);
	draw('unpaintable', specOf('pipeline'));   // sent only after the painter has been made to fail
	return out;
}

// ---- the page -------------------------------------------------------------------------------------
const THEMES = {
	light: { '--vscode-foreground': '#3b3b3b', '--vscode-editor-background': '#ffffff', '--vscode-descriptionForeground': '#6b6b6b', '--vscode-focusBorder': '#005fb8', '--vscode-textLink-foreground': '#005fb8', '--vscode-input-background': '#ffffff', '--vscode-input-border': '#cecece', '--vscode-panel-border': '#e5e5e5', '--vscode-toolbar-hoverBackground': 'rgba(184,184,184,.31)', '--vscode-button-background': '#005fb8', '--vscode-button-foreground': '#ffffff', '--vscode-editorWidget-background': '#f8f8f8', '--vscode-inputValidation-warningBackground': '#fff4ce', '--vscode-inputValidation-warningBorder': '#bf8803', '--vscode-inputValidation-warningForeground': '#3b3b3b' },
	dark: { '--vscode-foreground': '#cccccc', '--vscode-editor-background': '#1f1f1f', '--vscode-descriptionForeground': '#9d9d9d', '--vscode-focusBorder': '#0078d4', '--vscode-textLink-foreground': '#4daafc', '--vscode-input-background': '#313131', '--vscode-input-border': '#3c3c3c', '--vscode-panel-border': '#2b2b2b', '--vscode-toolbar-hoverBackground': 'rgba(90,93,94,.31)', '--vscode-button-background': '#0078d4', '--vscode-button-foreground': '#ffffff', '--vscode-editorWidget-background': '#202020', '--vscode-inputValidation-warningBackground': '#352a05', '--vscode-inputValidation-warningBorder': '#b89500', '--vscode-inputValidation-warningForeground': '#cccccc' }
};

/**
 * @param {{ bare?: boolean, driver?: Function, asciiById?: Record<string,string> }} [opts]
 *        bare: leave the diagram modules OUT, as getHtml() does when the bundle cannot be built.
 *        asciiById: what the stand-in host answers an `ascii` request with (the real host's text).
 */
function buildPage(theme, records, opts) {
	const o = opts || {};
	const nonce = 'checknonce';
	// Exactly what extension.js webviewCsp() + getHtml() produce.
	const csp = ["default-src 'none'", 'img-src data:', "style-src 'unsafe-inline'", "script-src 'nonce-" + nonce + "'"].join('; ');
	const raw = fs.readFileSync(path.join(EXT, 'media', 'chat.html'), 'utf8');
	let html = o.bare ? raw : bundle.inject(raw);
	html = html.replace(/__CSP__/g, csp).replace(/__NONCE__/g, nonce);
	const vars = Object.entries(THEMES[theme]).map(([k, v]) => k + ':' + v).join(';');
	const themeCss = '<style>html{' + vars + ';--vscode-font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;--vscode-font-size:13px;--vscode-editor-font-family:Menlo,Consolas,monospace;background:var(--vscode-editor-background);color:var(--vscode-foreground)}</style>';
	html = html.replace('</head>', themeCss + '</head>');
	const stub = '<script nonce="' + nonce + '">'
		+ 'window.__posted=[];window.__report={csp:[],errors:[]};'
		+ 'document.addEventListener("securitypolicyviolation",function(e){window.__report.csp.push(e.violatedDirective+" "+e.blockedURI);});'
		+ 'window.addEventListener("error",function(e){window.__report.errors.push(String(e.message));});'
		+ 'window.__ascii=' + JSON.stringify(o.asciiById || {}).replace(/</g, '\\u003c') + ';'
		// The stand-in host: it records what it is asked, and answers the one request that has an answer.
		+ 'window.acquireVsCodeApi=function(){return{postMessage:function(m){window.__posted.push(m);'
		+ 'if(m&&m.type==="diagramAction"&&m.action==="ascii"){setTimeout(function(){window.postMessage({type:"diagramAscii",id:m.id,text:window.__ascii[m.id]||""},"*");},0);}'
		+ '},getState:function(){return null;},setState:function(){}};};'
		+ '</' + 'script>';
	const at = html.indexOf('<script nonce="' + nonce + '">');
	html = html.slice(0, at) + stub + html.slice(at);
	const driver = '<script nonce="' + nonce + '">(' + (o.driver || drive).toString() + ')(' + JSON.stringify(records).replace(/</g, '\\u003c') + ');</' + 'script>';
	return html.replace('</body>', driver + '</body>');
}

/** Runs IN THE PAGE that has no diagram modules. Plays three records and reports what was shown. */
function driveBare(R) {
	const say = (m) => window.postMessage(m, '*');
	const wait = (ms) => new Promise((r) => setTimeout(r, ms));
	// Wait for a RESULT, never for an amount of time: messages are delivered when the browser gets to them.
	const until = async (cond) => { for (let i = 0; i < 600; i++) { if (cond()) { return true; } await wait(10); } return false; };
	const report = window.__report;
	(async function () {
		try {
			report.hasRenderer = !!window.LCDiagram;
			say({ type: 'config', provider: 'claude', model: 'claude-opus-4-8', providerLabel: 'Claude', contextLimit: 200000, groupActivity: true });
			say({ type: 'agentStart' });
			say({ type: 'agentDelta', text: 'Here is how a message is routed.' });
			say({ type: 'diagramPending', key: R.jev.key, state: 'drawing', title: 'Jev classifies; your code decides the action' });
			say(R.jev);
			say({ type: 'agentTurnEnd' });
			say(R.hostile);
			say(R.degraded);
			say(R.failed);
			say({ type: 'agentDone', reason: 'done', edits: 0 });
			// four cards, and the host's answer has arrived for each of the three it was asked about
			report.settled = await until(() => document.querySelectorAll('figure.lcd').length === 4 && Array.from(document.querySelectorAll('figure.lcd .lcd-ascii pre')).filter((p) => p.textContent).length === 3);
			const cards = Array.from(document.querySelectorAll('figure.lcd'));
			report.cards = cards.map((c) => {
				const pre = c.querySelector('.lcd-ascii pre'), det = c.querySelector('details.lcd-source');
				return {
					id: c.dataset.id, status: c.dataset.status, title: c.querySelector('.lcd-title-text').textContent,
					svg: !!c.querySelector('svg'), banner: (c.querySelector('.lcd-banner-text') || {}).textContent || null,
					ascii: pre ? pre.textContent : null, asciiShown: pre ? !pre.parentElement.hidden && pre.getBoundingClientRect().height > 0 : false,
					mono: pre ? /mono|Menlo|Consolas|Courier/i.test(getComputedStyle(pre).fontFamily) : null, pre: pre ? getComputedStyle(pre).whiteSpace : null,
					sourceOpen: det ? det.open : null, source: !!c.querySelector('.lcd-source pre'),
					retry: !!Array.from(c.querySelectorAll('.lcd-btn')).find((b) => b.textContent === 'Retry'),
					tools: Array.from(c.querySelectorAll('.lcd-tools .lcd-btn')).map((b) => b.textContent)
				};
			});
			report.asked = window.__posted.filter((m) => m.type === 'diagramAction').map((m) => ({ action: m.action, id: m.id, keys: Object.keys(m).sort().join() }));
			report.askedCols = window.__posted.filter((m) => m.type === 'diagramAction').map((m) => m.cols);
			report.renderReports = window.__posted.filter((m) => m.type === 'diagramRendered').map((m) => ({ id: m.id, ok: m.ok, message: m.message }));
			const bad = [];
			cards.forEach((c) => {
				c.querySelectorAll('script, iframe, object, embed, foreignObject, image, img, a, link, use, style, svg').forEach((el) => bad.push(c.dataset.id + ': <' + el.localName + '>'));
				c.querySelectorAll('*').forEach((el) => { for (const a of Array.from(el.attributes)) { if (/^on/i.test(a.name) || /^(href|src|xlink:href|style)$/i.test(a.name)) { bad.push(c.dataset.id + ': ' + el.localName + '[' + a.name + ']'); } } });
			});
			report.forbidden = bad;
			report.pwned = window.__pwned === undefined ? null : window.__pwned;
			report.pending = document.querySelectorAll('figure.lcd.lcd-pending').length;
			report.resources = performance.getEntriesByType('resource').map((e) => e.name);
		} catch (e) {
			report.errors.push('driver: ' + (e && e.stack ? e.stack : e));
		}
		const pre = document.createElement('pre'); pre.id = 'lcd-report'; pre.hidden = true; pre.textContent = JSON.stringify(report);
		document.body.appendChild(pre);
	})();
}

/** Runs IN THE PAGE. Plays host messages, then reports what the page did. */
function drive(R) {
	const say = (m) => window.postMessage(m, '*');
	const wait = (ms) => new Promise((r) => setTimeout(r, ms));
	// Wait for a RESULT, never for an amount of time: messages are delivered when the browser gets to them.
	const until = async (cond) => { for (let i = 0; i < 600; i++) { if (cond()) { return true; } await wait(10); } return false; };
	const stalled = [];
	const need = async (what, cond) => { if (!(await until(cond))) { stalled.push(what); } };
	const report = window.__report;
	(async function () {
		try {
			say({ type: 'config', provider: 'claude', model: 'claude-opus-4-8', providerLabel: 'Claude', contextLimit: 200000, groupActivity: true });
			say({ type: 'agentStart' });
			say({ type: 'agentDelta', text: 'Here is how a message is routed.' });
			say({ type: 'diagramPending', key: R.jev.key, state: 'drawing', title: '' });
			say({ type: 'diagramPending', key: R.jev.key, state: 'drawing', title: 'Jev classifies; your code decides the action' });
			await need('the titled placeholder', () => { const p = document.querySelector('figure.lcd.lcd-pending .lcd-title-text'); return !!p && p.textContent !== 'Diagram'; });
			const ph = document.querySelector('figure.lcd.lcd-pending');
			report.placeholder = ph ? { title: ph.querySelector('.lcd-title-text').textContent, text: ph.querySelector('.lcd-skel-text').textContent, live: ph.getAttribute('aria-live') } : null;
			say(R.jev);
			say({ type: 'agentDelta', text: 'Jev only scores the message; the threshold lives in your code.' });
			say({ type: 'agentTurnEnd' });
			for (const name of ['arch', 'decision', 'twelve', 'fixed', 'degraded', 'failed', 'hostile']) {
				say({ type: 'agentDelta', text: 'Next: ' + name + '.' });
				say({ type: 'diagramPending', key: 'placeholder-' + name, state: 'drawing', title: '' });
				say(Object.assign({}, R[name], { replacesKey: 'placeholder-' + name }));
			}
			// one placeholder whose diagram never arrives: it must be gone when the run ends
			say({ type: 'diagramPending', key: 'orphan', state: 'drawing', title: 'Never drawn' });
			await need('eight drawn cards and the orphan placeholder', () => document.querySelectorAll('figure.lcd[data-id]').length === 8 && document.querySelectorAll('figure.lcd.lcd-pending').length === 1);
			report.pendingBeforeDone = document.querySelectorAll('figure.lcd.lcd-pending').length;
			say({ type: 'agentDone', reason: 'done', edits: 0 });
			await need('the run to end', () => document.querySelectorAll('figure.lcd.lcd-pending').length === 0);

			const cards = Array.from(document.querySelectorAll('figure.lcd'));
			report.renderReports = window.__posted.filter((m) => m.type === 'diagramRendered').map((m) => ({ id: m.id, ok: m.ok, ms: m.ms }));
			report.pendingAfterDone = document.querySelectorAll('figure.lcd.lcd-pending').length;
			report.cards = cards.map((c) => {
				const svg = c.querySelector('.lcd-stage svg');
				const tags = {};
				if (svg) { svg.querySelectorAll('*').forEach((el) => { tags[el.localName] = (tags[el.localName] || 0) + 1; }); }
				const col = c.parentElement.getBoundingClientRect();
				return {
					id: c.dataset.id, status: c.dataset.status, title: c.querySelector('.lcd-title-text').textContent,
					svg: !!svg, tags, role: svg ? svg.getAttribute('role') : null, described: svg ? !!document.getElementById(svg.getAttribute('aria-describedby')) : false,
					fits: svg ? svg.getBoundingClientRect().width <= col.width + 0.5 : null,
					width: svg ? Math.round(svg.getBoundingClientRect().width) : 0,
					badge: (c.querySelector('.lcd-badge') || {}).textContent || null,
					banner: (c.querySelector('.lcd-banner-text') || {}).textContent || null,
					retry: !!Array.from(c.querySelectorAll('.lcd-btn')).find((b) => b.textContent === 'Retry'),
					tools: Array.from(c.querySelectorAll('.lcd-tools .lcd-btn')).map((b) => b.textContent),
					links: c.querySelectorAll('[data-lc-link]').length,
					source: !!c.querySelector('.lcd-source pre'), errors: Array.from(c.querySelectorAll('.lcd-errors li')).map((li) => li.textContent)
				};
			});

			// Safety: nothing executable or fetchable inside any diagram card, and no handler attributes anywhere in one.
			const bad = [];
			cards.forEach((c) => {
				c.querySelectorAll('script, iframe, object, embed, foreignObject, image, img, a, link, use, style').forEach((el) => bad.push(c.dataset.id + ': <' + el.localName + '>'));
				c.querySelectorAll('*').forEach((el) => { for (const a of Array.from(el.attributes)) { if (/^on/i.test(a.name) || /^(href|src|xlink:href|style)$/i.test(a.name)) { bad.push(c.dataset.id + ': ' + el.localName + '[' + a.name + ']'); } } });
			});
			report.forbidden = bad;
			report.pwned = window.__pwned === undefined ? null : window.__pwned;
			const hostile = cards.find((c) => c.dataset.id === R.hostile.record.id);
			report.hostileText = hostile ? Array.from(hostile.querySelectorAll('svg text')).map((t) => t.textContent) : [];
			report.hostileTitle = hostile ? hostile.querySelector('.lcd-title-text').textContent : null;
			report.resources = performance.getEntriesByType('resource').map((e) => e.name);

			// A click on a linked node asks the host for a NODE, never a path.
			window.__posted.length = 0;
			const arch = cards.find((c) => c.dataset.id === R.arch.record.id);
			const linked = arch.querySelector('[data-lc-link]');
			linked.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
			report.linkClick = window.__posted.filter((m) => m.type === 'diagramAction');
			const hostileLink = hostile.querySelector('[data-lc-link]');
			window.__posted.length = 0;
			if (hostileLink) { hostileLink.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); }
			report.hostileLinkClick = window.__posted.filter((m) => m.type === 'diagramAction');
			report.hostileLinks = Array.from(hostile.querySelectorAll('[data-lc-link]')).map((el) => el.getAttribute('data-lc-link'));

			// Full-size view opens on a click on the picture, and closes on Escape.
			arch.querySelector('.lcd-stage').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
			const z = document.getElementById('lcdZoom');
			report.zoomOpen = !z.hidden && !!z.querySelector('.lcdz-view svg');
			report.zoomTitle = z.querySelector('.lcdz-title').textContent;
			document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
			report.zoomClosed = z.hidden;

			// Export: SVG text, and a PNG rasterised from it.
			const jev = cards.find((c) => c.dataset.id === R.jev.record.id);
			const btn = (card, label) => Array.from(card.querySelectorAll('.lcd-tools .lcd-btn')).find((b) => b.textContent === label);
			window.__posted.length = 0;
			btn(jev, 'SVG').click(); btn(jev, 'PNG').click(); btn(jev, 'Copy source').click(); btn(jev, 'Open as Mermaid').click();
			// (the PNG is rasterised asynchronously; a failure reports itself as a notice)
			await need('four exports', () => window.__posted.filter((m) => m.type === 'diagramAction' && m.action === 'export').length === 4 || window.__posted.some((m) => m.type === 'notice'));
			report.exports = window.__posted.filter((m) => m.type === 'diagramAction' && m.action === 'export').map((m) => ({ format: m.format, id: m.id, data: m.data || null }));
			report.notices = window.__posted.filter((m) => m.type === 'notice').map((m) => m.text);

			// The badge opens its details.
			const fixed = cards.find((c) => c.dataset.id === R.fixed.record.id);
			const badge = fixed.querySelector('.lcd-badge'); badge.click();
			report.popover = Array.from(fixed.querySelectorAll('.lcd-pop:not([hidden]) div')).map((d) => d.textContent);
			badge.click();

			// Last: the painter itself fails. The card must fall back to a text drawing of the same spec.
			const realMount = window.LCDiagram.scene.mount;
			window.LCDiagram.scene.mount = function () { throw new Error('painter unavailable'); };
			window.__posted.length = 0;
			say({ type: 'agentStart' });
			say(R.unpaintable);
			say({ type: 'agentDone', reason: 'done', edits: 0 });
			await need('the unpaintable diagram', () => !!Array.from(document.querySelectorAll('figure.lcd')).find((c) => c.dataset.id === R.unpaintable.record.id && c.querySelector('.lcd-ascii pre')));
			window.LCDiagram.scene.mount = realMount;
			const un = Array.from(document.querySelectorAll('figure.lcd')).find((c) => c.dataset.id === R.unpaintable.record.id);
			const unPre = un ? un.querySelector('.lcd-ascii pre') : null;
			report.unpaintable = un ? {
				svg: !!un.querySelector('svg'), text: unPre ? unPre.textContent : null,
				banner: (un.querySelector('.lcd-banner-text') || {}).textContent || null,
				bannerFirst: !!(un.querySelector('.lcd-banner') && unPre && (un.querySelector('.lcd-banner').compareDocumentPosition(unPre) & Node.DOCUMENT_POSITION_FOLLOWING)),
				widest: unPre ? Math.max.apply(null, unPre.textContent.split('\n').map((l) => l.length)) : 0,
				fits: unPre ? unPre.scrollWidth <= unPre.clientWidth + 1 : false,
				tools: Array.from(un.querySelectorAll('.lcd-tools .lcd-btn')).map((b) => b.textContent),
				reports: window.__posted.filter((m) => m.type === 'diagramRendered').map((m) => ({ ok: m.ok, message: m.message })),
				asked: window.__posted.filter((m) => m.type === 'diagramAction').length
			} : null;
			report.stalled = stalled;
		} catch (e) {
			report.errors.push('driver: ' + (e && e.stack ? e.stack : e));
		}
		const pre = document.createElement('pre'); pre.id = 'lcd-report'; pre.hidden = true; pre.textContent = JSON.stringify(report);
		document.body.appendChild(pre);
	})();
}

// ---- run ------------------------------------------------------------------------------------------
function chrome(bin, args) {
	return cp.spawnSync(bin, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--disable-extensions', '--virtual-time-budget=8000'].concat(args), { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function main() {
	const bin = findChrome();
	if (!bin) { console.error('No Chrome or Chromium found (set CHROME=/path/to/binary). Nothing was checked.'); process.exit(2); }
	const outArg = process.argv.indexOf('--out');
	const out = outArg > 0 ? path.resolve(process.argv[outArg + 1]) : fs.mkdtempSync(path.join(os.tmpdir(), 'lc-diagram-check-'));
	fs.mkdirSync(out, { recursive: true });
	const records = makeRecords();
	const failures = [];
	let passed = 0;
	const check = (theme, name, ok, detail) => { if (ok) { passed++; } else { failures.push(theme + ' · ' + name + (detail ? ' — ' + detail : '')); } };

	/** Load one page in the browser, screenshot it, and read back what it reported. */
	const visit = (name, html, size) => {
		const page = path.join(out, name + '.html');
		fs.writeFileSync(page, html);
		chrome(bin, ['--window-size=' + size, '--screenshot=' + path.join(out, name + '.png'), 'file://' + page]);
		const dom = chrome(bin, ['--window-size=' + size, '--dump-dom', 'file://' + page]).stdout || '';
		const m = /<pre id="lcd-report"[^>]*>([\s\S]*?)<\/pre>/.exec(dom);
		if (!m) { return null; }
		const r = JSON.parse(m[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
		fs.writeFileSync(path.join(out, name.replace('chat', 'report') + '.json'), JSON.stringify(r, null, 2));
		return r;
	};

	for (const theme of ['light', 'dark']) {
		const r = visit('chat-' + theme, buildPage(theme, records), '900,3900');
		if (!r) { failures.push(theme + ' · the page never reported (did the script run?)'); continue; }
		const card = (name) => (r.cards || []).find((c) => c.id === records[name].record.id) || {};

		check(theme, 'no uncaught error in the page', r.errors.length === 0, r.errors.join(' | '));
		check(theme, 'every step of the script saw its result arrive', (r.stalled || ['?']).length === 0, 'never happened: ' + (r.stalled || ['the script did not finish']).join(', '));
		check(theme, 'zero CSP violations', r.csp.length === 0, r.csp.join(' | '));
		check(theme, 'zero resource requests', (r.resources || []).length === 0, (r.resources || []).join(' | '));
		check(theme, 'nothing from a label ever ran', r.pwned === null, 'window.__pwned = ' + r.pwned);
		check(theme, 'no script/link/image/foreignObject/handler inside any diagram card', (r.forbidden || []).length === 0, (r.forbidden || []).slice(0, 6).join(' | '));
		check(theme, 'the hostile labels are on the page as text', (r.hostileText || []).includes('</text><foreignObject>') && (r.hostileText || []).some((t) => t.indexOf('<img src=x') === 0), JSON.stringify(r.hostileText));
		check(theme, 'the hostile title is text', r.hostileTitle === '</title><script>window.__pwned = 1</script>', r.hostileTitle);
		check(theme, 'a javascript: link was dropped; only the real file is clickable', JSON.stringify(r.hostileLinks) === '["c"]', JSON.stringify(r.hostileLinks));
		check(theme, 'the placeholder holds the place, titled, and announces politely', r.placeholder && r.placeholder.title === 'Jev classifies; your code decides the action' && r.placeholder.text === 'Drawing…' && r.placeholder.live === 'polite', JSON.stringify(r.placeholder));
		check(theme, 'a placeholder whose diagram never came is removed when the run ends', r.pendingBeforeDone === 1 && r.pendingAfterDone === 0, r.pendingBeforeDone + ' → ' + r.pendingAfterDone);
		check(theme, 'eight cards, one per diagram', (r.cards || []).length === 8, String((r.cards || []).length));
		for (const name of ['jev', 'arch', 'decision', 'twelve', 'fixed', 'degraded', 'hostile']) {
			const c = card(name);
			check(theme, name + ': drawn as an SVG image with a description', c.svg && c.role === 'img' && c.described, JSON.stringify({ svg: c.svg, role: c.role, described: c.described }));
			check(theme, name + ': made only of the painter\'s elements', c.tags && Object.keys(c.tags).every((t) => ['g', 'rect', 'path', 'text', 'title'].includes(t)), JSON.stringify(c.tags));
			check(theme, name + ': never wider than the chat column', c.fits === true, 'width ' + c.width);
			check(theme, name + ': has its toolbar', JSON.stringify(c.tools) === JSON.stringify(['Copy source', 'SVG', 'PNG', 'Open as Mermaid', 'Insert into Markdown…']), JSON.stringify(c.tools));
		}
		check(theme, 'the title is HTML above the picture', card('jev').title === 'Jev classifies; your code decides the action');
		check(theme, 'a clean diagram has no badge and no banner', card('jev').badge === null && card('jev').banner === null);
		check(theme, 'auto-fixed: a quiet badge', /^auto-fixed/.test(card('fixed').badge || '') && card('fixed').banner === null, card('fixed').badge);
		check(theme, 'auto-fixed: the badge opens the details', (r.popover || []).length >= 2 && r.popover.some((l) => /shortened/.test(l)), JSON.stringify(r.popover));
		check(theme, 'degraded: a banner that says what was lost, and Retry', /1 edge dropped: unknown nodes/.test(card('degraded').banner || '') && card('degraded').retry, card('degraded').banner);
		check(theme, 'failed: the errors, the source and Retry — never blank', card('failed').status === 'failed' && !card('failed').svg && card('failed').source && card('failed').retry && card('failed').errors.length === 1, JSON.stringify(card('failed')));
		check(theme, 'arch: its two linked nodes are clickable', card('arch').links === 2, String(card('arch').links));
		check(theme, 'a click on a node names the NODE, never a path', JSON.stringify(r.linkClick) === JSON.stringify([{ type: 'diagramAction', action: 'openLink', id: records.arch.record.id, node: 'agent' }]), JSON.stringify(r.linkClick));
		check(theme, 'the hostile diagram\'s one link also only names its node', JSON.stringify(r.hostileLinkClick) === JSON.stringify([{ type: 'diagramAction', action: 'openLink', id: records.hostile.record.id, node: 'c' }]), JSON.stringify(r.hostileLinkClick));
		check(theme, 'full-size view opens on click with the title, and closes on Escape', r.zoomOpen && r.zoomClosed && r.zoomTitle === 'The agent talks to providers through one registry', JSON.stringify([r.zoomOpen, r.zoomClosed, r.zoomTitle]));
		const reports = r.renderReports || [];
		check(theme, 'each of the seven pictures reported its render once, as a success', reports.length === 7 && reports.every((x) => x.ok === true && typeof x.ms === 'number'), JSON.stringify(reports));
		// (Render TIME is not checked here: under --virtual-time-budget the page's clock does not advance
		//  while script runs, so every measurement reads 0. Layout time is measured for real in
		//  test/diagramLayout.test.js; time-to-picture in the editor is what "Diagram Statistics" records.)
		check(theme, 'the failed card keeps the title the model gave it', card('failed').title === 'Nothing to draw', card('failed').title);
		const ex = (f) => (r.exports || []).find((e) => e.format === f) || {};
		check(theme, 'export: four actions reached the host', (r.exports || []).map((e) => e.format).sort().join() === 'mermaid,png,source,svg', JSON.stringify((r.exports || []).map((e) => e.format)) + ' ' + JSON.stringify(r.notices));
		const svgCheck = exportCheck.checkSvg(ex('svg').data);
		check(theme, 'export: the SVG passes the host\'s structural check', svgCheck.ok, svgCheck.reason);
		check(theme, 'export: the SVG carries its title, a background and resolved colours', /class="lcd-title"/.test(ex('svg').data || '') && /class="lcd-bg"/.test(ex('svg').data || '') && !/var\(/.test(ex('svg').data || ''));
		const pngCheck = exportCheck.checkPng(ex('png').data);
		check(theme, 'export: the PNG is a real PNG', pngCheck.ok, pngCheck.reason);
		check(theme, 'export: source and Mermaid carry no data from the webview', ex('source').data === null && ex('mermaid').data === null);
		const un = r.unpaintable || {};
		const unSpec = records.unpaintable.record.spec;
		check(theme, 'a picture that cannot be painted becomes a text drawing of the same spec — no SVG, every label present', un.svg === false && typeof un.text === 'string' && unSpec.nodes.every((n) => un.text.includes(n.label)) && /\+-+\+/.test(un.text), JSON.stringify(un).slice(0, 300));
		check(theme, 'the text drawing fits the card without scrolling sideways', un.fits === true && un.widest > 20, 'widest line ' + un.widest);
		check(theme, 'and the card says why it is text, above the drawing', un.banner === 'The picture could not be drawn, so a text version is shown instead.' && un.bannerFirst === true, JSON.stringify([un.banner, un.bannerFirst]));
		check(theme, 'its toolbar offers what still works — no image export', JSON.stringify(un.tools) === JSON.stringify(['Copy source', 'Open as Mermaid', 'Insert into Markdown…']), JSON.stringify(un.tools));
		check(theme, 'it is counted as a render that failed, and the host is asked for nothing', (un.reports || []).length === 1 && un.reports[0].ok === false && /painter unavailable/.test(un.reports[0].message) && un.asked === 0, JSON.stringify([un.reports, un.asked]));
		if (svgCheck.ok) { fs.writeFileSync(path.join(out, 'export-' + theme + '.svg'), ex('svg').data); }
		if (pngCheck.ok) { fs.writeFileSync(path.join(out, 'export-' + theme + '.png'), pngCheck.bytes); }
	}

	// ---- the page WITHOUT its diagram modules: the fallback (docs/RICH-DIAGRAMS.md, "UX → Fallback") ----
	{
		const theme = 'no renderer';
		// What extension.js diagramAsciiText() answers — test/diagramHost.test.js pins that it is exactly this.
		// (The stand-in answers at one fixed width; the real host fits the column count the page sends.)
		const textOf = (rec) => (rec.spec ? ascii.render(repair.accept(rec.spec).spec, { maxCols: 110, title: false }) : '');
		const asciiById = {};
		for (const name of ['jev', 'hostile', 'degraded', 'failed']) { asciiById[records[name].record.id] = textOf(records[name].record); }
		const r = visit('chat-no-renderer', buildPage('light', records, { bare: true, driver: driveBare, asciiById }), '900,1500');
		if (!r) { failures.push(theme + ' · the page never reported (did the script run?)'); }
		else {
			const card = (name) => (r.cards || []).find((c) => c.id === records[name].record.id) || {};
			check(theme, 'the page really has no renderer', r.hasRenderer === false, String(r.hasRenderer));
			check(theme, 'the host\'s answers arrived', r.settled === true, 'the page never showed all three text versions');
			check(theme, 'no uncaught error in the page', r.errors.length === 0, r.errors.join(' | '));
			check(theme, 'zero CSP violations', r.csp.length === 0, r.csp.join(' | '));
			check(theme, 'zero resource requests', (r.resources || []).length === 0, (r.resources || []).join(' | '));
			check(theme, 'nothing from a label ever ran', r.pwned === null, 'window.__pwned = ' + r.pwned);
			check(theme, 'no element made from a spec, and no SVG', (r.forbidden || []).length === 0, (r.forbidden || []).slice(0, 6).join(' | '));
			check(theme, 'four cards, and no placeholder left behind', (r.cards || []).length === 4 && r.pending === 0, (r.cards || []).length + ' cards, ' + r.pending + ' pending');
			for (const name of ['jev', 'hostile', 'degraded']) {
				const c = card(name);
				check(theme, name + ': says a text version is shown', (c.banner || '').indexOf('The diagram renderer did not load, so a text version is shown instead.') === 0, c.banner);
				check(theme, name + ': shows the host\'s text version of the same spec, visibly', c.ascii === asciiById[records[name].record.id] && c.ascii.length > 40 && c.asciiShown === true, JSON.stringify({ shown: c.asciiShown, got: (c.ascii || '').slice(0, 80) }));
				check(theme, name + ': in a monospaced block that keeps its columns', c.mono === true && c.pre === 'pre', JSON.stringify([c.mono, c.pre]));
				check(theme, name + ': the source is still there, folded away', c.source === true && c.sourceOpen === false, JSON.stringify([c.source, c.sourceOpen]));
				check(theme, name + ': no Retry — asking the model again would not help', c.retry === false);
			}
			check(theme, 'the hostile labels are in the text version as text', /<img src=x onerror="window\.\.\./.test(card('hostile').ascii || '') && /<iframe src=\/\/example/.test(card('hostile').ascii || '') && /<\/text><foreignObject>/.test(card('hostile').ascii || ''), (card('hostile').ascii || '').slice(0, 200));
			check(theme, 'a diagram with nothing drawable is unchanged: the error, the source, Retry', card('failed').banner === 'This diagram could not be drawn.' && card('failed').retry && card('failed').ascii === null && card('failed').source, JSON.stringify(card('failed')));
			check(theme, 'a clean diagram\'s banner says only that', card('jev').banner === 'The diagram renderer did not load, so a text version is shown instead.', card('jev').banner);
			check(theme, 'a degraded diagram still says what it lost', /shown instead\. 1 edge dropped: unknown nodes/.test(card('degraded').banner || ''), card('degraded').banner);
			const want = ['jev', 'hostile', 'degraded'].map((n) => ({ action: 'ascii', id: records[n].record.id, keys: 'action,cols,id,type' }));
			check(theme, 'the host was asked for text by id, once per drawable diagram, with a column count and nothing else', JSON.stringify(r.asked) === JSON.stringify(want), JSON.stringify(r.asked));
			// a 900px window: the card is about 850px wide, and 12px monospace is about 7px a character
			check(theme, 'the column count is what fits the card', (r.askedCols || []).length === 3 && r.askedCols.every((c) => Number.isInteger(c) && c >= 90 && c <= 130), JSON.stringify(r.askedCols));
			check(theme, 'the card does not repeat its own title inside the text', !(card('jev').ascii || '').includes('Jev classifies; your code decides the action'));
			check(theme, 'each is counted as a render that failed', (r.renderReports || []).length === 3 && r.renderReports.every((x) => x.ok === false && /did not load/.test(x.message)), JSON.stringify(r.renderReports));
		}
	}

	console.log(passed + ' checks passed' + (failures.length ? ', ' + failures.length + ' FAILED:' : '.'));
	for (const f of failures) { console.log('  ✗ ' + f); }
	console.log('Screenshots and reports: ' + out);
	process.exit(failures.length ? 1 : 0);
}

main();
