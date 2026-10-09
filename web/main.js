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

// Declared up here, not beside the sign-in code: the block below awaits, and a const further down the module
// is not initialised until it finishes.
/** sessionStorage: this tab went to the account site's sign-in and is expected back (callback.js reads it). */
const RETURN_KEY = 'levelcode-web.return';
/** How long a sign-in result left in localStorage stays deliverable. The one-time code behind it lives for a minute. */
const FRESH_MS = 2 * 60 * 1000;

const boot = createBootScreen();

try {
	await import(staticBase + '/out/nls.messages.js').catch(() => undefined);
	const api = await import(staticBase + '/out/vs/workbench/workbench.web.main.internal.js');
	const { create, URI } = api;

	const secrets = await createSecretStorage();
	const workspaceProvider = createWorkspaceProvider(URI, config);
	const callbacks = createUrlCallbackProvider(URI, config.callbackRoute || '/callback.html');

	const workbench = create(document.body, {
		windowIndicator: { label: '$(globe) LevelCode Web', tooltip: 'LevelCode in your browser' },
		workspaceProvider,
		urlCallbackProvider: callbacks,
		commands: [{
			// The extension asks the page to take the tab to the account site's sign-in. A page opened by
			// script is what a strict browser blocks; leaving the tab and coming back (callback.js) is not.
			id: 'levelcode.web.openAuthUrl',
			handler: (url) => leaveForSignIn(url, config),
		}],
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
	startReturnFromSignIn(callbacks, URI);
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

/* ----- signing in ------------------------------------------------------------------------- */

/**
 * Take this tab to the account site's sign-in page. Only that site's /ai/ pages: this is a command any
 * extension in the page could call, and it must not be a way to send the tab anywhere else.
 */
function leaveForSignIn(url, cfg) {
	let target;
	try { target = new URL(String(url)); } catch { return; }
	let account;
	try { account = new URL(cfg.account); } catch { return; }
	if (target.origin !== account.origin || !target.pathname.startsWith('/ai/')) {
		console.warn('[levelcode-web] refused to navigate to', target.origin + target.pathname);
		return;
	}
	// callback.html is a page of this tab when this is set: it comes straight back instead of closing.
	try { sessionStorage.setItem(RETURN_KEY, '1'); } catch { /* the pop-up path still works without it */ }
	location.assign(target.href);
}

/**
 * Two things can be waiting when the page starts, and both reach the extension as the "URL" the operating
 * system would have given it on the desktop:
 *   - a sign-in that took this tab away and brought it back (callback.html) left its result in
 *     localStorage; it is delivered now. Only a result written in the last two minutes is: an older one is
 *     a code that cannot be exchanged any more, and is dropped;
 *   - ?signin=1 (the account site's "Open in browser") asks for the sign-in itself, once. The parameter is
 *     removed first, so a reload does not start it again.
 */
function startReturnFromSignIn(callbacks, URI) {
	const here = new URL(location.href);
	const launch = here.searchParams.get('signin') === '1';
	if (launch) {
		here.searchParams.delete('signin');
		try { history.replaceState(null, '', here.pathname + here.search + here.hash); } catch { /* cosmetic */ }
	}
	try { sessionStorage.removeItem(RETURN_KEY); } catch { /* nothing to clear */ }
	void callbacks.whenListening().then((listening) => {
		// With nobody listening a result would be taken out of storage and dropped; it stays for the next start.
		if (!listening) { return; }
		// Deliveries made before the extension has registered its handler are held by the workbench and
		// replayed to it (ExtensionUrlBootstrapHandler / uriBuffer), so there is nothing to wait for.
		const delivered = callbacks.drain(FRESH_MS);
		if (launch && delivered === 0) {
			callbacks.fire(URI.from({ scheme: 'levelcode', authority: 'levelcode.levelcode-ai', path: '/launch' }));
		}
	});
}
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
		/** Resolves true once the workbench's URL service is listening (it subscribes while it starts); false if it never did. */
		whenListening() {
			return new Promise((resolve) => {
				const t0 = Date.now();
				const tick = () => {
					if (listeners.size > 0) { resolve(true); }
					else if (Date.now() - t0 > 30000) { resolve(false); }
					else { setTimeout(tick, 100); }
				};
				tick();
			});
		},
		/**
		 * Deliver results a sign-in left in localStorage that this page was not waiting for (it left and came
		 * back). One not written within `maxAgeMs` is removed and not delivered. Returns how many were.
		 */
		drain(maxAgeMs) {
			const keys = [];
			for (let i = 0; i < localStorage.length; i++) {
				const k = localStorage.key(i);
				if (k && k.startsWith('vscode-web.url-callbacks[')) { keys.push(k); }
			}
			let n = 0;
			for (const k of keys) {
				const raw = localStorage.getItem(k);
				localStorage.removeItem(k);
				try {
					const data = JSON.parse(raw);
					if (typeof data.at === 'number' && Date.now() - data.at > maxAgeMs) { continue; }
					const uri = URI.revive(data);
					listeners.forEach((l) => l(uri));
					n++;
				} catch (e) { console.error(e); }
			}
			return n;
		},
		/** Hand the workbench a URL as if the OS had opened it. */
		fire(uri) { listeners.forEach((l) => l(uri)); },
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
 *
 * The store belongs to every tab of this origin, as the desktop's keychain belongs to every window,
 * and the extension relies on that: the refresh token is rotated on use, so a tab that renewed the
 * session has to be seen by the next tab that does, or that one presents a token that is no longer
 * good and ends a session the first just renewed. So nothing is cached here: a read is a read of
 * what is stored now, and a change is read-modify-write of ONE key under a lock shared by the tabs
 * (the Web Locks API; without it, changes from one tab are still applied one at a time).
 */
async function createSecretStorage() {
	const STORE_KEY = 'levelcode-web.secrets.v1';
	const LOCK = 'levelcode-web.secrets';
	let key;
	try { key = await loadOrCreateKey(); } catch (e) { key = undefined; }

	if (!key) {
		const memory = new Map();
		return {
			type: 'in-memory',
			async get(k) { return memory.get(k); },
			async set(k, v) { memory.set(k, v); },
			async delete(k) { memory.delete(k); },
			async keys() { return [...memory.keys()]; },
		};
	}

	/** Everything stored now. Unreadable (key lost, tampered) is dropped: the user signs in again. */
	const read = async () => {
		let sealed = null;
		try { sealed = localStorage.getItem(STORE_KEY); } catch (e) { return {}; }
		if (!sealed) { return {}; }
		try {
			const all = JSON.parse(await unseal(key, sealed));
			return all && typeof all === 'object' ? all : {};
		} catch (e) {
			console.warn('[levelcode-web] the saved session could not be read and was cleared', e);
			try { localStorage.removeItem(STORE_KEY); } catch (e2) { /* ignore */ }
			return {};
		}
	};

	// One change at a time within this tab, and — where the browser has Web Locks — across tabs.
	let queue = Promise.resolve();
	const exclusive = (fn) => {
		const run = () => (globalThis.navigator && navigator.locks && navigator.locks.request
			? navigator.locks.request(LOCK, fn)
			: fn());
		const next = queue.then(run, run);
		queue = next.then(() => undefined, () => undefined);
		return next;
	};
	// When the browser refuses the write (storage disabled or full) this tab keeps the session in memory and
	// the user signs in again after a reload: better than a sign-in that completes and is not there.
	/** @type {Map<string, string> | null} */
	let inMemory = null;
	const change = (mutate) => exclusive(async () => {
		if (inMemory) {
			const all = Object.fromEntries(inMemory);
			mutate(all);
			inMemory = new Map(Object.entries(all));
			return;
		}
		const all = await read();
		mutate(all);
		try { localStorage.setItem(STORE_KEY, await seal(key, JSON.stringify(all))); }
		catch (e) {
			console.error('[levelcode-web] could not persist secrets; keeping them for this tab only', e);
			inMemory = new Map(Object.entries(all));
		}
	});

	return {
		type: 'persisted',
		async get(k) { return inMemory ? inMemory.get(k) : (await read())[k]; },
		async set(k, v) { await change((all) => { all[k] = v; }); },
		async delete(k) { await change((all) => { delete all[k]; }); },
		async keys() { return inMemory ? [...inMemory.keys()] : Object.keys(await read()); },
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
