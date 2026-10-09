// A minimal Chrome DevTools Protocol driver for the browser edition's end-to-end check.
// Node 22+ (built-in WebSocket), headless Chrome, no dependencies. Set CHROME to use another binary.
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const CHROME = process.env.CHROME || [
	'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
	'/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser',
].find((p) => fs.existsSync(p)) || 'google-chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Chrome {
	static async launch({ port = 9444, profile, width = 1440, height = 900, dpr = 1, args = [] } = {}) {
		profile = profile || `/tmp/lc-chrome-${port}`;
		fs.rmSync(profile, { recursive: true, force: true });
		const proc = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
			'--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--mute-audio',
			'--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
			`--window-size=${width},${height}`, ...args, 'about:blank'], { stdio: 'ignore' });
		const c = new Chrome(proc, port, { width, height, dpr });
		for (let i = 0; i < 100; i++) { try { const r = await fetch(`http://127.0.0.1:${port}/json/version`); if (r.ok) { break; } } catch {} await sleep(150); }
		return c;
	}
	constructor(proc, port, view) { this.proc = proc; this.port = port; this.view = view; }
	async newPage(url) {
		const r = await fetch(`http://127.0.0.1:${this.port}/json/new?${encodeURIComponent('about:blank')}`, { method: 'PUT' });
		const t = await r.json();
		const p = new Page(t.webSocketDebuggerUrl, this.port, this.view);
		await p.open();
		if (url) { await p.goto(url); }
		return p;
	}
	close() { try { this.proc.kill('SIGTERM'); } catch {} }
}

export class Page {
	constructor(wsUrl, port, view) {
		this.wsUrl = wsUrl; this.port = port; this.view = view; this.id = 0; this.pend = new Map();
		this.logs = []; this.errors = []; this.failed = []; this.requests = []; this.listeners = [];
		this.sessions = new Map();
	}
	async open() {
		this.ws = new WebSocket(this.wsUrl);
		await new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = rej; });
		this.ws.onmessage = (m) => this.onMessage(JSON.parse(m.data));
		await this.send('Page.enable'); await this.send('Runtime.enable'); await this.send('Network.enable'); await this.send('Log.enable');
		await this.send('Emulation.setDeviceMetricsOverride', { width: this.view.width, height: this.view.height, deviceScaleFactor: this.view.dpr, mobile: false });
		await this.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
	}
	onMessage(d) {
		if (d.id && this.pend.has(d.id)) { const { res, rej } = this.pend.get(d.id); this.pend.delete(d.id); d.error ? rej(new Error(JSON.stringify(d.error))) : res(d.result); return; }
		const tag = d.sessionId ? this.sessions.get(d.sessionId)?.url || 'child' : 'page';
		switch (d.method) {
			case 'Runtime.consoleAPICalled': {
				const text = d.params.args.map((a) => a.value ?? a.description ?? (a.preview ? JSON.stringify(a.preview.properties?.map((p) => p.name + ':' + p.value)) : '')).join(' ');
				this.logs.push({ t: Date.now(), tag, type: d.params.type, text: text.slice(0, 1500) });
				break; }
			case 'Runtime.exceptionThrown':
				this.errors.push({ tag, text: (d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text || '').slice(0, 1500), url: d.params.exceptionDetails.url });
				break;
			case 'Log.entryAdded':
				if (d.params.entry.level === 'error') { this.logs.push({ t: Date.now(), tag, type: 'log-error', text: `${d.params.entry.text} ${d.params.entry.url || ''}`.slice(0, 500) }); }
				break;
			case 'Network.responseReceived':
				this.requests.push({ url: d.params.response.url, status: d.params.response.status, type: d.params.type });
				if (d.params.response.status >= 400) { this.failed.push(`${d.params.response.status} ${d.params.response.url}`); }
				break;
			case 'Network.loadingFailed':
				this.failed.push(`FAILED ${d.params.errorText} ${d.params.requestId}`);
				break;
			case 'Target.targetInfoChanged':
				for (const v of this.sessions.values()) { if (v.targetId === d.params.targetInfo.targetId) { v.url = d.params.targetInfo.url; v.type = d.params.targetInfo.type; } }
				break;
			case 'Target.attachedToTarget':
				this.sessions.set(d.params.sessionId, { url: d.params.targetInfo.url, type: d.params.targetInfo.type, targetId: d.params.targetInfo.targetId });
				this.sendTo(d.params.sessionId, 'Runtime.enable').catch(() => {});
				this.sendTo(d.params.sessionId, 'Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }).catch(() => {});
				break;
		}
		for (const l of this.listeners) { l(d); }
	}
	send(method, params = {}) { return this.sendTo(undefined, method, params); }
	sendTo(sessionId, method, params = {}) {
		const id = ++this.id;
		return new Promise((res, rej) => {
			this.pend.set(id, { res, rej });
			this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
			setTimeout(() => { if (this.pend.has(id)) { this.pend.delete(id); rej(new Error('timeout ' + method)); } }, 30000);
		});
	}
	async goto(url) { await this.send('Page.navigate', { url }); await sleep(300); }
	async eval(expr, { sessionId, awaitPromise = true } = {}) {
		const r = await this.sendTo(sessionId, 'Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise });
		if (r.exceptionDetails) { throw new Error('eval: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text)); }
		return r.result.value;
	}
	async waitFor(fn, { ms = 30000, every = 250, label = 'condition' } = {}) {
		const t0 = Date.now();
		while (Date.now() - t0 < ms) { try { const v = await fn(); if (v) { return v; } } catch {} await sleep(every); }
		throw new Error('timeout waiting for ' + label);
	}
	async targets() { return (await (await fetch(`http://127.0.0.1:${this.port}/json/list`)).json()); }
	async screenshot(file) { const r = await this.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(file, Buffer.from(r.data, 'base64')); return file; }
	async click(x, y) {
		for (const type of ['mousePressed', 'mouseReleased']) { await this.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 }); }
	}
	async type(text) { await this.send('Input.insertText', { text }); }
	async key(key, code, modifiers = 0) {
		await this.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, modifiers });
		await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, modifiers });
	}
	close() { try { this.ws.close(); } catch {} }
}
export { sleep };

/** Find the CDP session id of the first attached target whose URL matches. */
Page.prototype.sessionFor = function (re) {
	for (const [id, s] of this.sessions) { if (re.test(s.url || '')) { return id; } }
	return null;
};
