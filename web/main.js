/*---------------------------------------------------------------------------------------------
 *  LevelCode in your browser — page entry.
 *
 *  Code-OSS ships a web client (src/vs/code/browser/workbench/workbench.ts) but it is written for
 *  its own server: it reads its configuration from a template the server fills in and assumes a
 *  remote authority. A static host has neither, so this file is the small amount of embedder code
 *  that a static host needs. It follows workbench.ts closely on purpose (MIT, same behaviour for
 *  the URL callback, the workspace URL and the secret store) and differs where LevelCode differs:
 *
 *    - configuration comes from <script id="levelcode-web-config"> written at build time;
 *    - LevelCode's own extensions are loaded as additional built-ins, from this origin;
 *    - secrets are encrypted at rest with a non-extractable key kept in IndexedDB;
 *    - with no folder in the URL the editor opens the scratch workspace, so a signed-in user can
 *      start immediately.
 *
 *  Plain ES module, no build step, no dependencies.
 *--------------------------------------------------------------------------------------------*/

const config = readConfig();
const origin = location.origin;
const staticBase = trimSlash(new URL(config.staticBase || '/static', origin).href);

// The workbench resolves every asset (css, nls, workers, codicon font) against this root.
globalThis._VSCODE_FILE_ROOT = staticBase + '/out/';

const boot = createBootScreen();

try {
	await import(staticBase + '/out/nls.messages.js').catch(() => undefined);
	const api = await import(staticBase + '/out/vs/workbench/workbench.web.main.internal.js');
	const { create, URI } = api;

	const secrets = await createSecretStorage();
	const workspaceProvider = createWorkspaceProvider(URI, config);

	const workbench = create(document.body, {
		windowIndicator: { label: '$(globe) LevelCode Web', tooltip: 'LevelCode in your browser' },
		workspaceProvider,
		urlCallbackProvider: createUrlCallbackProvider(URI, config.callbackRoute || '/callback.html'),
		secretStorageProvider: secrets,
		additionalBuiltinExtensions: (config.extensions || []).map((name) => ({
			scheme: location.protocol.slice(0, -1),
			authority: location.host,
			path: trimSlash(config.extensionsBase || '/extensions') + '/' + name,
		})),
		productConfiguration: config.productConfiguration || {},
		configurationDefaults: config.configurationDefaults || {},
		enableWorkspaceTrust: false,
		// The sign-in page is opened from the editor; it is ours, so it opens without a link-safety prompt.
		additionalTrustedDomains: config.trustedDomains || [],
		settingsSyncOptions: undefined,
		developmentOptions: config.development ? { logLevel: 2 } : undefined,
	});
	// create() resolves once the workbench has been constructed. The splash goes when its DOM exists.
	void workbench;
	boot.whenWorkbenchReady();
} catch (err) {
	console.error('[levelcode-web] failed to start', err);
	boot.fail(err);
}

/* ------------------------------------------------------------------------------------------ */

function readConfig() {
	const el = document.getElementById('levelcode-web-config');
	if (!el) { throw new Error('Missing #levelcode-web-config'); }
	return JSON.parse(el.textContent || '{}');
}

function trimSlash(s) { return s.replace(/\/+$/, ''); }

/** The URL decides the workspace, exactly as Code-OSS's web client does: ?folder= / ?workspace= / ?ew=true. */
function createWorkspaceProvider(URI, cfg) {
	const params = new URL(location.href).searchParams;
	let workspace;
	let found = false;
	let payload = Object.create(null);
	params.forEach((value, key) => {
		if (key === 'folder') { workspace = { folderUri: URI.parse(value) }; found = true; }
		else if (key === 'workspace') { workspace = { workspaceUri: URI.parse(value) }; found = true; }
		else if (key === 'ew') { workspace = undefined; found = true; }
		else if (key === 'payload') { try { payload = JSON.parse(value); } catch (e) { /* ignore a bad payload */ } }
	});
	if (!found && cfg.scratch && cfg.scratch.scheme) {
		workspace = { folderUri: URI.from({ scheme: cfg.scratch.scheme, path: cfg.scratch.path || '/scratch' }) };
	}
	const query = (w) => {
		if (!w) { return 'ew=true'; }
		if (w.folderUri) { return 'folder=' + encodeURIComponent(w.folderUri.toString(true)); }
		return 'workspace=' + encodeURIComponent(w.workspaceUri.toString(true));
	};
	return {
		workspace,
		payload,
		trusted: true,
		async open(target, options) {
			const href = `${location.origin}${location.pathname}?${query(target)}`
				+ (options && options.payload ? `&payload=${encodeURIComponent(JSON.stringify(options.payload))}` : '');
			if (options && options.reuse) { location.href = href; return true; }
			return !!window.open(href);
		},
	};
}

/**
 * Sign-in leaves this page in a second tab and comes back to /callback.html, which writes the
 * result to localStorage; this class is the other half that notices it. Same contract as
 * Code-OSS's LocalStorageURLCallbackProvider.
 */
function createUrlCallbackProvider(URI, callbackRoute) {
	const KEYS = ['scheme', 'authority', 'path', 'query', 'fragment'];
	const listeners = new Set();
	let nextId = 0;
	let pending = new Set();
	let timer;
	let last = Date.now();
	let listening = false;

	const check = () => {
		for (const id of [...pending]) {
			const key = `vscode-web.url-callbacks[${id}]`;
			const raw = localStorage.getItem(key);
			if (raw === null) { continue; }
			pending.delete(id);
			localStorage.removeItem(key);
			try {
				const uri = URI.revive(JSON.parse(raw));
				listeners.forEach((l) => l(uri));
			} catch (e) { console.error(e); }
		}
		last = Date.now();
		if (pending.size === 0 && listening) { window.removeEventListener('storage', onStorage); listening = false; }
	};
	const onStorage = () => {
		const elapsed = Date.now() - last;
		if (elapsed > 1000) { check(); }
		else if (timer === undefined) { timer = setTimeout(() => { timer = undefined; check(); }, 1000 - elapsed); }
	};

	return {
		onCallback: (listener) => { listeners.add(listener); return { dispose: () => listeners.delete(listener) }; },
		create(options = {}) {
			const id = ++nextId;
			const query = [`vscode-reqid=${id}`];
			for (const key of KEYS) {
				if (options[key]) { query.push(`vscode-${key}=${encodeURIComponent(options[key])}`); }
			}
			localStorage.removeItem(`vscode-web.url-callbacks[${id}]`);
			pending.add(id);
			if (!listening) { window.addEventListener('storage', onStorage); listening = true; }
			// The callback is always the page at callbackRoute on THIS origin, whatever the current URL is.
			return URI.from({ scheme: location.protocol.slice(0, -1), authority: location.host, path: callbackRoute, query: query.join('&') });
		},
	};
}

/* ----- secrets ---------------------------------------------------------------------------- */

/**
 * Secret storage for the session tokens. Persisted, so a reload does not sign the user out.
 *
 * Values are sealed with AES-GCM using a key that is generated once, kept in IndexedDB as a
 * non-extractable CryptoKey, and never leaves the browser. That keeps tokens out of the
 * localStorage dump, backups and copy-pasted profile folders. It is not a defence against script
 * running on this origin, which can call the same key: the editor therefore loads no third-party
 * extensions (see docs/WEB.md). Where IndexedDB or WebCrypto is unavailable (some private
 * windows), secrets live in memory for the session and the user signs in again after a reload.
 */
async function createSecretStorage() {
	const STORE_KEY = 'levelcode-web.secrets.v1';
	let key;
	try { key = await loadOrCreateKey(); } catch (e) { key = undefined; }

	let cache = {};
	const fromMemoryOnly = !key;
	if (key) {
		try {
			const sealed = localStorage.getItem(STORE_KEY);
			if (sealed) { cache = JSON.parse(await unseal(key, sealed)); }
		} catch (e) {
			// An unreadable store (key lost, tampered) is dropped; the user signs in again.
			console.warn('[levelcode-web] the saved session could not be read and was cleared', e);
			try { localStorage.removeItem(STORE_KEY); } catch (e2) { /* ignore */ }
			cache = {};
		}
	}

	let writing = Promise.resolve();
	const persist = () => {
		if (!key) { return writing; }
		writing = writing.then(async () => {
			try { localStorage.setItem(STORE_KEY, await seal(key, JSON.stringify(cache))); }
			catch (e) { console.error('[levelcode-web] could not persist secrets', e); }
		});
		return writing;
	};

	return {
		type: fromMemoryOnly ? 'in-memory' : 'persisted',
		async get(k) { return cache[k]; },
		async set(k, v) { cache[k] = v; await persist(); },
		async delete(k) { delete cache[k]; await persist(); },
		async keys() { return Object.keys(cache); },
	};
}

function idb() {
	return new Promise((resolve, reject) => {
		const req = indexedDB.open('levelcode-web', 1);
		req.onupgradeneeded = () => req.result.createObjectStore('keys');
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
	});
}
async function loadOrCreateKey() {
	if (!(globalThis.crypto && crypto.subtle)) { throw new Error('WebCrypto unavailable'); }
	const db = await idb();
	const get = () => new Promise((res, rej) => { const r = db.transaction('keys').objectStore('keys').get('secrets'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
	const put = (k) => new Promise((res, rej) => { const tx = db.transaction('keys', 'readwrite'); tx.objectStore('keys').put(k, 'secrets'); tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); });
	let key = await get();
	if (!key) {
		key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
		await put(key);
	}
	db.close();
	return key;
}
// Function declarations, not consts: createSecretStorage() runs during the module's top-level await,
// before a const declared below it would be initialised.
function b64(bytes) { let s = ''; for (let i = 0; i < bytes.length; i++) { s += String.fromCharCode(bytes[i]); } return btoa(s); }
function unb64(text) { return Uint8Array.from(atob(text), (c) => c.charCodeAt(0)); }
async function seal(key, text) {
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const body = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(text)));
	const out = new Uint8Array(iv.length + body.length);
	out.set(iv, 0); out.set(body, iv.length);
	return b64(out);
}
async function unseal(key, sealed) {
	const raw = unb64(sealed);
	const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: raw.slice(0, 12) }, key, raw.slice(12));
	return new TextDecoder().decode(plain);
}

/* ----- boot screen ------------------------------------------------------------------------ */

function createBootScreen() {
	const el = document.getElementById('lc-boot');
	let done = false;
	const finish = () => {
		if (done || !el) { return; }
		done = true;
		document.body.classList.remove('lc-booting');
		el.classList.add('lc-boot-done');
		setTimeout(() => el.remove(), 450);
	};
	return {
		whenWorkbenchReady() {
			const seen = () => document.querySelector('.monaco-workbench .part.editor, .monaco-workbench .part.sidebar');
			if (seen()) { finish(); return; }
			const mo = new MutationObserver(() => { if (seen()) { mo.disconnect(); finish(); } });
			mo.observe(document.body, { childList: true, subtree: true });
			setTimeout(() => { mo.disconnect(); finish(); }, 20000);
		},
		fail(err) {
			if (!el) { return; }
			el.classList.add('lc-boot-failed');
			const msg = el.querySelector('[data-boot-message]');
			if (msg) { msg.textContent = 'LevelCode could not start in this browser. ' + String((err && err.message) || err); }
		},
	};
}
