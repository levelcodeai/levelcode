/*---------------------------------------------------------------------------------------------
 *  Which app the editor is, to the operating system — run: node test/editorIdentity.test.js
 *
 *  A LevelCode run from source and the LevelCode in /Applications were one app to macOS: the same
 *  bundle identifier, the same levelcode:// scheme. A sign-in started in the dev editor was
 *  therefore handed back to the installed one. scripts/editor-identity.mjs gives the dev run an
 *  identity of its own, and refuses to let that identity be packaged. Pinned here:
 *
 *    - the two identities differ in BOTH parts, and the dev scheme is one a server can accept
 *    - product.overrides.json gains the identity and keeps whatever else the developer put there
 *    - the dev bundle's Info.plist changes in its identifier and its URL scheme — and nowhere else
 *    - doing it twice changes nothing
 *    - the two files change as ONE change: a write that fails leaves both as they were, and a
 *      rename that fails half-way is undone
 *    - the step fails unless macOS will route the dev scheme to this bundle — told is not routed
 *    - a built app with a dev identity, or with an overrides file in it, fails the release check
 *    - the sign-in callback is built from the editor's OWN scheme: the reason no auth code changed
 *
 *  Everything runs on fixtures in a temp directory, on any OS — nothing here touches a real
 *  checkout, a real bundle, or LaunchServices. macOS itself is a stand-in (`system`): what the
 *  script DOES with its answers is pinned here, the answers are not. And where a failure cannot be
 *  provoked for real — a rename that fails after an earlier one went through — the filesystem is
 *  handed in with that one step failing.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { pathToFileURL } = require('url');

const EXT_DIR = path.join(__dirname, '..');
const REPO = path.join(EXT_DIR, '..', '..');
const SCRIPT = path.join(REPO, 'scripts', 'editor-identity.mjs');
const read = (...p) => fs.readFileSync(path.join(REPO, ...p), 'utf8');

let n = 0;
async function test(name, fn) { await fn(); n++; console.log('  ok - ' + name); }

// ── fixtures ─────────────────────────────────────────────────────────────────────────────────────
const SHIPPED = { urlProtocol: 'levelcode', darwinBundleIdentifier: 'ai.levelcode.app' };
const DEV = { urlProtocol: 'levelcode-dev', darwinBundleIdentifier: 'ai.levelcode.app.dev' };

/** An Info.plist shaped like the one the Electron bundle is generated with: other bundle keys, a
 *  document-type list full of arrays and strings BEFORE the URL types, and one URL type. */
function infoPlist(identity = SHIPPED, schemes = [identity.urlProtocol]) {
	return [
		'<?xml version="1.0" encoding="UTF-8"?>',
		'<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
		'<plist version="1.0">',
		'  <dict>',
		'    <key>CFBundleDisplayName</key>',
		'    <string>LevelCode</string>',
		'    <key>CFBundleExecutable</key>',
		'    <string>LevelCode</string>',
		'    <key>CFBundleIdentifier</key>',
		'    <string>' + identity.darwinBundleIdentifier + '</string>',
		'    <key>CFBundleName</key>',
		'    <string>LevelCode</string>',
		'    <key>CFBundleDocumentTypes</key>',
		'    <array>',
		'      <dict>',
		'        <key>CFBundleTypeExtensions</key>',
		'        <array>',
		'          <string>js</string>',
		'          <string>levelcode</string>',
		'        </array>',
		'        <key>CFBundleTypeName</key>',
		'        <string>levelcode document</string>',
		'      </dict>',
		'    </array>',
		'    <key>CFBundleURLTypes</key>',
		'    <array>',
		'      <dict>',
		'        <key>CFBundleTypeRole</key>',
		'        <string>Viewer</string>',
		'        <key>CFBundleURLName</key>',
		'        <string>LevelCode</string>',
		'        <key>CFBundleURLSchemes</key>',
		'        <array>',
		...schemes.map((s) => '          <string>' + s + '</string>'),
		'        </array>',
		'      </dict>',
		'    </array>',
		'  </dict>',
		'</plist>',
		''
	].join('\n');
}

const made = [];
function tmp() { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'levelcode-identity-')); made.push(d); return d; }
function write(file, text) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); return file; }

/** A stand-in Code-OSS checkout: product.json, and the dev Electron bundle run-dev.sh launches. */
function checkout({ bundle = true, overrides = null } = {}) {
	const dir = tmp();
	write(path.join(dir, 'product.json'), JSON.stringify({ nameLong: 'LevelCode', nameShort: 'LevelCode', ...SHIPPED }, null, '\t'));
	const plist = path.join(dir, '.build', 'electron', 'LevelCode.app', 'Contents', 'Info.plist');
	if (bundle) { write(plist, infoPlist()); }
	if (overrides !== null) { write(path.join(dir, 'product.overrides.json'), overrides); }
	return { dir, plist, overrides: path.join(dir, 'product.overrides.json') };
}

/** A stand-in BUILT app, as scripts/build-macos.sh leaves it. */
function builtApp({ plist = SHIPPED, product = SHIPPED, overrides = false } = {}) {
	const app = path.join(tmp(), 'LevelCode.app');
	write(path.join(app, 'Contents', 'Info.plist'), infoPlist(plist));
	if (product) { write(path.join(app, 'Contents', 'Resources', 'app', 'product.json'), JSON.stringify({ nameLong: 'LevelCode', ...product })); }
	if (overrides) { write(path.join(app, 'Contents', 'Resources', 'app', 'product.overrides.json'), JSON.stringify(DEV)); }
	return app;
}

/** The real filesystem, with one step replaced. */
const failing = (step, fn) => ({ ...fs, [step]: fn });
const temps = (dir) => fs.readdirSync(dir, { recursive: true }).map(String).filter((f) => /\.tmp$/.test(f));

/** macOS as the script sees it: `handler` is what it says opens the dev scheme. */
function system({ register = () => { }, handler }) {
	const calls = { register: [], handlerOf: [] };
	return {
		calls,
		register: (bundle) => { calls.register.push(bundle); return register(bundle); },
		handlerOf: (scheme) => { calls.handlerOf.push(scheme); return typeof handler === 'function' ? handler() : handler; }
	};
}

const changedLines = (before, after) => {
	const a = before.split('\n'), b = after.split('\n');
	assert.strictEqual(a.length, b.length, 'the file has the same number of lines');
	return a.map((line, i) => (line === b[i] ? null : [line.trim(), b[i].trim()])).filter(Boolean);
};

// ── the sign-in function, sliced out of extension.js ────────────────────────────────────────────
const src = fs.readFileSync(path.join(EXT_DIR, 'extension.js'), 'utf8');
function extract(name) {
	let start = src.indexOf('function ' + name + '(');
	assert.ok(start >= 0, 'extension.js no longer defines ' + name + '()');
	const open = src.indexOf('{', start);
	if (src.slice(start - 6, start) === 'async ') { start -= 6; }
	let depth = 0, str = '', comment = '';
	for (let i = open; i < src.length; i++) {
		const ch = src[i], next = src[i + 1];
		if (comment === 'line') { if (ch === '\n') { comment = ''; } continue; }
		if (comment === 'block') { if (ch === '*' && next === '/') { comment = ''; i++; } continue; }
		if (str) { if (ch === '\\') { i++; } else if (ch === str) { str = ''; } continue; }
		if (ch === '/' && next === '/') { comment = 'line'; i++; continue; }
		if (ch === '/' && next === '*') { comment = 'block'; i++; continue; }
		if (ch === '"' || ch === "'" || ch === '`') { str = ch; continue; }
		if (ch === '{') { depth++; }
		else if (ch === '}' && --depth === 0) { return src.slice(start, i + 1); }
	}
	assert.fail('no matching closing brace found for ' + name + '()');
}
function decl(name) {
	const m = new RegExp('^(?:const|let) ' + name + ' = [^\\n]*', 'm').exec(src);
	assert.ok(m, 'extension.js no longer declares ' + name);
	return m[0];
}
/** A function written on ONE line. extract() matches braces and skips comments, and would read the
 *  `//` inside a regex literal such as /\//g as the start of one. */
function oneLine(name) {
	const m = new RegExp('^function ' + name + '\\([^\\n]*\\}$', 'm').exec(src);
	assert.ok(m, 'extension.js no longer defines ' + name + '() on one line');
	return m[0];
}
// eslint-disable-next-line no-new-func
const makeSignIn = new Function('env', [
	"'use strict';",
	'const { vscode, crypto, ctx, dbg, postAccount } = env;',
	decl('ACCOUNT_VERIFIER_KEY'),
	oneLine('b64url'), extract('pkcePair'), oneLine('cloudEndpoint'), extract('accountSignIn'),
	'return { accountSignIn };'
].join('\n'));

/** Run the real accountSignIn() in an editor whose product scheme is `uriScheme`; returns the URL it opens. */
async function signInUrl(uriScheme) {
	const opened = [];
	const Uri = { parse: (s) => ({ toString: () => String(s) }) };
	const host = makeSignIn({
		crypto: require('crypto'),
		ctx: { secrets: { store: async () => { } } },
		dbg: () => { },
		postAccount: async () => { },
		vscode: {
			Uri,
			workspace: { getConfiguration: () => ({ get: (key, fallback) => (key === 'endpoint' ? 'https://cloud.test' : fallback) }) },
			window: { showInformationMessage: () => { } },
			env: {
				uriScheme,
				// As the editor does it: the same address, with the window to route the callback to.
				asExternalUri: async (uri) => Uri.parse(uri.toString() + '?windowId=1'),
				openExternal: async (uri) => { opened.push(uri.toString()); return true; }
			}
		}
	});
	await host.accountSignIn();
	assert.strictEqual(opened.length, 1, 'one browser page is opened');
	return new URL(opened[0]);
}

(async () => {
	const identity = await import(pathToFileURL(SCRIPT).href);
	// Nothing in this file may reach the real LaunchServices: a fixture registered there outlives the
	// test that made it. Every example hands in its own stand-in, or asks not to register; one that
	// forgets fails here instead of leaving a temp-folder bundle in the system's database.
	identity.macOS.register = () => { throw new Error('this suite must not register anything with macOS'); };
	identity.macOS.handlerOf = () => { throw new Error('this suite must not ask macOS anything'); };

	// ── the two identities ───────────────────────────────────────────────────────────────────────
	await test('the product that ships is levelcode:// and ai.levelcode.app — the dev identity changes neither', () => {
		assert.deepStrictEqual(identity.shippedIdentity(), SHIPPED);
		const overlay = JSON.parse(read('branding', 'product.overlay.json'));
		assert.strictEqual(overlay.urlProtocol, 'levelcode');
		assert.strictEqual(overlay.darwinBundleIdentifier, 'ai.levelcode.app');
	});

	await test('a run from source differs from it in BOTH parts: its own scheme, its own bundle identifier', () => {
		assert.deepStrictEqual(identity.devIdentity(), DEV);
	});

	await test('the dev scheme has the one shape a server can be told to accept: levelcode-<variant>', () => {
		// thin.ly's Levelcode::EditorCallback::EXTRA_SCHEME is the same expression. A dev scheme that
		// does not fit it can be set here and still never complete a sign-in.
		assert.strictEqual(String(identity.DEV_SCHEME), String(/^levelcode-[a-z0-9]+(?:[.-][a-z0-9]+)*$/));
		assert.ok(identity.DEV_SCHEME.test(identity.devIdentity().urlProtocol));
		for (const no of ['levelcode', 'levelcode-', 'levelcode_dev', 'https', 'dev', 'LevelCode-Dev', 'levelcode--dev']) {
			assert.ok(!identity.DEV_SCHEME.test(no), no);
		}
	});

	await test('a dev identity that shares either part with the shipped one is refused — sharing one IS the bug', () => {
		const dir = tmp();
		const file = (json) => write(path.join(dir, 'dev-' + Math.random().toString(36).slice(2) + '.json'), JSON.stringify(json));
		assert.throws(() => identity.devIdentity(file({ urlProtocol: 'levelcode-dev', darwinBundleIdentifier: 'ai.levelcode.app' }), SHIPPED), /must differ/);
		assert.throws(() => identity.devIdentity(file({ urlProtocol: 'levelcode', darwinBundleIdentifier: 'ai.levelcode.app.dev' }), SHIPPED), /levelcode-dev/);
		assert.throws(() => identity.devIdentity(file({ urlProtocol: 'https', darwinBundleIdentifier: 'ai.levelcode.app.dev' }), SHIPPED), /levelcode-dev/);
		assert.throws(() => identity.devIdentity(file({ urlProtocol: 'levelcode-dev' }), SHIPPED), /must name both/);
		// Both values are written into XML as they are.
		for (const id of ['ai.levelcode.app</string><string>x', 'ai levelcode dev', 'dev', 'ai.levelcode.app.dev.']) {
			assert.throws(() => identity.devIdentity(file({ urlProtocol: 'levelcode-dev', darwinBundleIdentifier: id }), SHIPPED), /must look like ai\.levelcode\.app\.dev/, id);
		}
		assert.deepStrictEqual(identity.devIdentity(file(DEV), SHIPPED), DEV);
	});

	// ── what the editor believes at runtime: product.overrides.json ──────────────────────────────
	await test('overrides: with no file yet, one is written holding the identity', () => {
		const r = identity.mergeOverrides(null, DEV);
		assert.strictEqual(r.changed, true);
		assert.deepStrictEqual(JSON.parse(r.text), DEV);
	});

	await test('overrides: whatever else the developer keeps there stays', () => {
		const theirs = JSON.stringify({ extensionsGallery: { serviceUrl: 'https://example.test' }, urlProtocol: 'something-old' });
		const r = identity.mergeOverrides(theirs, DEV);
		assert.strictEqual(r.changed, true);
		assert.deepStrictEqual(JSON.parse(r.text), { extensionsGallery: { serviceUrl: 'https://example.test' }, ...DEV });
	});

	await test('overrides: already carrying the identity, the file is left exactly as it is', () => {
		const theirs = '{ "darwinBundleIdentifier": "ai.levelcode.app.dev",\n\n  "urlProtocol": "levelcode-dev", "x": 1 }\n';
		const r = identity.mergeOverrides(theirs, DEV);
		assert.deepStrictEqual(r, { text: theirs, changed: false });
	});

	await test('overrides: a file that is not a JSON object is the developer\'s to fix, not ours to overwrite', () => {
		assert.throws(() => identity.mergeOverrides('{ "urlProtocol": ', DEV), /not valid JSON/);
		assert.throws(() => identity.mergeOverrides('[]', DEV), /JSON object/);
		assert.deepStrictEqual(JSON.parse(identity.mergeOverrides('  \n', DEV).text), DEV, 'an empty file is no file');
	});

	// ── what macOS believes: the bundle's Info.plist ─────────────────────────────────────────────
	await test('plist: the bundle identifier and the URL schemes are read from where they are, not from look-alikes', () => {
		// "levelcode" also appears as a document extension and inside a type name.
		assert.deepStrictEqual(identity.plistIdentity(infoPlist()), { darwinBundleIdentifier: 'ai.levelcode.app', urlSchemes: ['levelcode'] });
	});

	await test('plist: the dev identity changes two lines — the identifier and the scheme — and nothing else', () => {
		const before = infoPlist();
		const r = identity.withIdentity(before, DEV);
		assert.strictEqual(r.changed, true);
		assert.deepStrictEqual(r.was, { darwinBundleIdentifier: 'ai.levelcode.app', urlSchemes: ['levelcode'] });
		assert.deepStrictEqual(changedLines(before, r.xml), [
			['<string>ai.levelcode.app</string>', '<string>ai.levelcode.app.dev</string>'],
			['<string>levelcode</string>', '<string>levelcode-dev</string>']
		]);
		assert.deepStrictEqual(identity.plistIdentity(r.xml), { darwinBundleIdentifier: DEV.darwinBundleIdentifier, urlSchemes: [DEV.urlProtocol] });
		assert.strictEqual(r.xml, infoPlist(DEV), 'exactly the file a bundle generated with that identity would have');
	});

	await test('plist: done twice, the second changes nothing', () => {
		const once = identity.withIdentity(infoPlist(), DEV).xml;
		const twice = identity.withIdentity(once, DEV);
		assert.strictEqual(twice.changed, false);
		assert.strictEqual(twice.xml, once);
	});

	await test('plist: a bundle that claims the shipped scheme AS WELL ends up claiming the dev one alone', () => {
		// Claiming both would put the dev bundle back in the running for levelcode:// links.
		const r = identity.withIdentity(infoPlist(DEV, ['levelcode', 'levelcode-dev']), DEV);
		assert.strictEqual(r.changed, true);
		assert.deepStrictEqual(identity.plistIdentity(r.xml).urlSchemes, ['levelcode-dev']);
		assert.strictEqual(r.xml, infoPlist(DEV));
	});

	await test('plist: a file that is not the shape it is generated in is a reason to stop, not to guess', () => {
		assert.throws(() => identity.plistIdentity('bplist00Ô\u0001'), /expected one CFBundleIdentifier, found 0/);
		const noUrlTypes = infoPlist().replace(/<key>CFBundleURLTypes<\/key>[\s\S]*?<\/array>\s*<\/dict>\s*<\/array>\n/, '');
		assert.throws(() => identity.withIdentity(noUrlTypes, DEV), /expected one CFBundleURLSchemes list, found 0/);
		const twoUrlTypes = infoPlist().replace('<key>CFBundleURLTypes</key>', '<key>CFBundleURLSchemes</key>\n    <array>\n      <string>other</string>\n    </array>\n    <key>CFBundleURLTypes</key>');
		assert.throws(() => identity.withIdentity(twoUrlTypes, DEV), /found 2/);
	});

	// ── both halves, on a checkout ───────────────────────────────────────────────────────────────
	await test('dev: a checkout gets both halves — the overrides file and the bundle — and a second run touches neither', () => {
		const c = checkout({ overrides: JSON.stringify({ extensionsGallery: { serviceUrl: 'https://example.test' } }) });
		const log = [];
		const first = identity.applyDevIdentity({ vscodeDir: c.dir, platform: 'darwin', register: false, log: (l) => log.push(l) });
		assert.deepStrictEqual({ overridesChanged: first.overridesChanged, bundleChanged: first.bundleChanged, registered: first.registered }, { overridesChanged: true, bundleChanged: true, registered: false });
		assert.deepStrictEqual(JSON.parse(fs.readFileSync(c.overrides, 'utf8')), { extensionsGallery: { serviceUrl: 'https://example.test' }, ...DEV });
		assert.strictEqual(fs.readFileSync(c.plist, 'utf8'), infoPlist(DEV));
		assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(c.dir, 'product.json'), 'utf8')).urlProtocol, 'levelcode', 'product.json is still the product that ships');
		assert.ok(log.some((l) => /was ai\.levelcode\.app, levelcode:\/\//.test(l)), log.join(' | '));

		const stamp = [c.overrides, c.plist].map((f) => fs.statSync(f).mtimeMs);
		const second = identity.applyDevIdentity({ vscodeDir: c.dir, platform: 'darwin', register: false });
		assert.deepStrictEqual({ overridesChanged: second.overridesChanged, bundleChanged: second.bundleChanged }, { overridesChanged: false, bundleChanged: false });
		assert.deepStrictEqual([c.overrides, c.plist].map((f) => fs.statSync(f).mtimeMs), stamp, 'neither file was rewritten');
	});

	await test('dev: a regenerated bundle (a new Electron) is given the identity again', () => {
		const c = checkout();
		identity.applyDevIdentity({ vscodeDir: c.dir, platform: 'darwin', register: false });
		write(c.plist, infoPlist());   // npm run electron wrote a fresh one, from product.json
		const again = identity.applyDevIdentity({ vscodeDir: c.dir, platform: 'darwin', register: false });
		assert.deepStrictEqual({ overridesChanged: again.overridesChanged, bundleChanged: again.bundleChanged }, { overridesChanged: false, bundleChanged: true });
		assert.strictEqual(fs.readFileSync(c.plist, 'utf8'), infoPlist(DEV));
	});

	await test('dev: all or nothing — when either half cannot be done, nothing is written', () => {
		// One half without the other is worse than neither: the editor would ask to be called back on
		// a scheme nothing claims, or go on asking for the installed app's.
		const noBundle = checkout({ bundle: false });
		assert.throws(() => identity.applyDevIdentity({ vscodeDir: noBundle.dir, platform: 'darwin', register: false }), /no dev Electron bundle at .*preLaunch/);
		assert.strictEqual(fs.existsSync(noBundle.overrides), false, 'no overrides file is left behind');

		const oddBundle = checkout();
		write(oddBundle.plist, 'bplist00');   // not the generated XML
		assert.throws(() => identity.applyDevIdentity({ vscodeDir: oddBundle.dir, platform: 'darwin', register: false }), /expected one CFBundleIdentifier/);
		assert.strictEqual(fs.existsSync(oddBundle.overrides), false);

		const badOverrides = checkout({ overrides: '{ not json' });
		assert.throws(() => identity.applyDevIdentity({ vscodeDir: badOverrides.dir, platform: 'darwin', register: false }), /not valid JSON/);
		assert.strictEqual(fs.readFileSync(badOverrides.plist, 'utf8'), infoPlist(), 'the bundle is left as it was');
		assert.strictEqual(fs.readFileSync(badOverrides.overrides, 'utf8'), '{ not json', 'and so is their file');

		assert.throws(() => identity.applyDevIdentity({ vscodeDir: tmp(), platform: 'darwin', register: false }), /no product\.json/);
	});

	await test('dev: off macOS the runtime half is written and the log says the callback will not arrive', () => {
		const c = checkout();
		const log = [];
		const r = identity.applyDevIdentity({ vscodeDir: c.dir, platform: 'linux', register: false, log: (l) => log.push(l) });
		assert.deepStrictEqual({ bundle: r.bundle, bundleChanged: r.bundleChanged, overridesChanged: r.overridesChanged }, { bundle: null, bundleChanged: false, overridesChanged: true });
		assert.strictEqual(fs.readFileSync(c.plist, 'utf8'), infoPlist(), 'the bundle is not touched');
		assert.ok(log.some((l) => /not macOS \(linux\).*will not reach this editor/.test(l)), log.join(' | '));
	});

	// ── the two files change as one change ───────────────────────────────────────────────────────
	await test('together: every file is replaced, keeping its mode; one that was not there is created; nothing is left behind', () => {
		const dir = tmp();
		const a = write(path.join(dir, 'a.json'), 'old a'), b = write(path.join(dir, 'sub', 'b.plist'), 'old b');
		fs.chmodSync(b, 0o640);
		const c = path.join(dir, 'c.json');
		identity.replaceTogether([{ path: a, text: 'new a' }, { path: b, text: 'new b' }, { path: c, text: 'new c' }]);
		assert.deepStrictEqual([a, b, c].map((f) => fs.readFileSync(f, 'utf8')), ['new a', 'new b', 'new c']);
		assert.strictEqual(fs.statSync(b).mode & 0o777, 0o640);
		assert.deepStrictEqual(temps(dir), []);
	});

	await test('together: a symlinked file is replaced where it really is — the link stays a link', () => {
		const dir = tmp();
		const real = write(path.join(dir, 'shared', 'overrides.json'), 'old');
		const link = path.join(dir, 'product.overrides.json');
		fs.symlinkSync(real, link);
		identity.replaceTogether([{ path: link, text: 'new' }]);
		assert.strictEqual(fs.lstatSync(link).isSymbolicLink(), true);
		assert.strictEqual(fs.readFileSync(real, 'utf8'), 'new');
	});

	await test('together: a file that cannot be written stops it before ANY file has changed', () => {
		const dir = tmp();
		const a = write(path.join(dir, 'a.json'), 'old a');
		const nowhere = path.join(dir, 'no-such-folder', 'b.plist');   // a real failure, no stand-in
		assert.throws(() => identity.replaceTogether([{ path: a, text: 'new a' }, { path: nowhere, text: 'new b' }]), /ENOENT/);
		assert.strictEqual(fs.readFileSync(a, 'utf8'), 'old a');
		assert.deepStrictEqual(temps(dir), []);
	});

	await test('together: a rename that fails after an earlier one went through is undone — old contents back, a new file gone', () => {
		for (const existed of [true, false]) {
			const dir = tmp();
			const a = path.join(dir, 'a.json'), b = write(path.join(dir, 'b.plist'), 'old b');
			if (existed) { write(a, 'old a'); }
			let renames = 0;
			const io = failing('renameSync', (from, to) => { if (++renames === 2) { throw new Error('EXDEV: second rename refused'); } return fs.renameSync(from, to); });
			assert.throws(() => identity.replaceTogether([{ path: a, text: 'new a' }, { path: b, text: 'new b' }], io), /second rename refused — nothing was changed/);
			assert.strictEqual(fs.existsSync(a) ? fs.readFileSync(a, 'utf8') : null, existed ? 'old a' : null, existed ? 'restored' : 'removed again');
			assert.strictEqual(fs.readFileSync(b, 'utf8'), 'old b');
			assert.deepStrictEqual(temps(dir), []);
		}
	});

	await test('together: when even the undo fails, the error says which file was left changed', () => {
		const dir = tmp();
		const a = write(path.join(dir, 'a.json'), 'old a'), b = write(path.join(dir, 'b.plist'), 'old b');
		let renames = 0;
		const io = {
			...failing('renameSync', (from, to) => { if (++renames === 2) { throw new Error('second rename refused'); } return fs.renameSync(from, to); }),
			// Staging writes go to .tmp files; the write that fails here is the one putting a.json back.
			writeFileSync: (file, ...rest) => { if (file === fs.realpathSync(a)) { throw new Error('EROFS: read-only now'); } return fs.writeFileSync(file, ...rest); }
		};
		assert.throws(() => identity.replaceTogether([{ path: a, text: 'new a' }, { path: b, text: 'new b' }], io),
			(e) => /second rename refused/.test(e.message) && /could NOT be undone/.test(e.message) && e.message.includes(fs.realpathSync(a)) && /EROFS/.test(e.message));
	});

	await test('dev: a bundle that cannot be written leaves the overrides file as it was — no half identity', () => {
		// The reviewed order wrote product.overrides.json first: a failure on Info.plist then left the
		// editor advertising a scheme the bundle did not own.
		for (const theirs of [null, JSON.stringify({ extensionsGallery: {} })]) {
			const c = checkout({ overrides: theirs });
			const io = failing('writeFileSync', (file, ...rest) => { if (/Info\.plist\.identity-\d+\.tmp$/.test(file)) { throw new Error('EACCES: permission denied'); } return fs.writeFileSync(file, ...rest); });
			assert.throws(() => identity.applyDevIdentity({ vscodeDir: c.dir, platform: 'darwin', register: false, io }), /EACCES/);
			assert.strictEqual(fs.existsSync(c.overrides) ? fs.readFileSync(c.overrides, 'utf8') : null, theirs);
			assert.strictEqual(fs.readFileSync(c.plist, 'utf8'), infoPlist());
			assert.deepStrictEqual(temps(c.dir), []);
		}
	});

	// ── told is not routed ───────────────────────────────────────────────────────────────────────
	await test('dev: macOS is asked what opens the dev scheme, and the step passes when it names this bundle', () => {
		const c = checkout();
		const bundle = path.join(c.dir, '.build', 'electron', 'LevelCode.app');
		const mac = system({ handler: fs.realpathSync(bundle) });   // as macOS gives it: /private/var/…, not /var/…
		const log = [];
		const r = identity.applyDevIdentity({ vscodeDir: c.dir, platform: 'darwin', system: mac, log: (l) => log.push(l) });
		assert.strictEqual(r.registered, true);
		assert.deepStrictEqual(mac.calls, { register: [bundle], handlerOf: ['levelcode-dev'] });
		assert.ok(log.some((l) => /macOS opens levelcode-dev:\/\/ with this bundle/.test(l)), log.join(' | '));
	});

	await test('dev: the bundle\'s own path in another spelling is still this bundle — macOS answers as on disk, the checkout as typed', () => {
		const c = checkout();
		const bundle = path.join(c.dir, '.build', 'electron', 'LevelCode.app');
		const shouted = path.join(path.dirname(bundle), 'LEVELCODE.APP');
		const run = () => identity.applyDevIdentity({ vscodeDir: c.dir, platform: 'darwin', system: system({ handler: shouted }) });
		if (fs.existsSync(shouted)) {   // the volume folds case, as a Mac's does by default
			assert.strictEqual(run().registered, true);
		} else {                        // it does not: those really are two places
			assert.throws(run, /macOS opens levelcode-dev:\/\/ with .*LEVELCODE\.APP, not with/);
		}
	});

	await test('dev: a registration that fails is fatal — the launcher must not start an editor that cannot hear its callback', () => {
		const c = checkout();
		const mac = system({ register: () => { throw new Error('lsregister failed: failed to scan … -10811'); }, handler: '' });
		assert.throws(() => identity.applyDevIdentity({ vscodeDir: c.dir, platform: 'darwin', system: mac }),
			/could not be registered for levelcode-dev:\/\/ — lsregister failed: failed to scan[\s\S]*the editor was not started/);
		assert.deepStrictEqual(mac.calls.handlerOf, [], 'nothing further is asked');
		// The two files are left in place: they agree with each other, and the next run registers again.
		assert.deepStrictEqual(JSON.parse(fs.readFileSync(c.overrides, 'utf8')), DEV);
		assert.strictEqual(fs.readFileSync(c.plist, 'utf8'), infoPlist(DEV));
		const bundle = path.join(c.dir, '.build', 'electron', 'LevelCode.app');
		const retry = identity.applyDevIdentity({ vscodeDir: c.dir, platform: 'darwin', system: system({ handler: bundle }) });
		assert.deepStrictEqual({ registered: retry.registered, overridesChanged: retry.overridesChanged, bundleChanged: retry.bundleChanged }, { registered: true, overridesChanged: false, bundleChanged: false });
	});

	await test('dev: registered but not ROUTED is fatal too — no app for the scheme, or another copy holding it', () => {
		const none = checkout();
		assert.throws(() => identity.applyDevIdentity({ vscodeDir: none.dir, platform: 'darwin', system: system({ handler: '' }) }),
			/macOS has no app for levelcode-dev:\/\/ even after registering[\s\S]*temporary folder/);

		const other = checkout();
		assert.throws(() => identity.applyDevIdentity({ vscodeDir: other.dir, platform: 'darwin', system: system({ handler: '/Users/dev/other-checkout/vscode/.build/electron/LevelCode.app' }) }),
			/macOS opens levelcode-dev:\/\/ with \/Users\/dev\/other-checkout\/[\s\S]*lsregister -u "\/Users\/dev\/other-checkout\//);
	});

	await test('dev: when macOS cannot be asked, a registration that succeeded stands — and the log says it is unconfirmed', () => {
		const c = checkout();
		const log = [];
		const r = identity.applyDevIdentity({ vscodeDir: c.dir, platform: 'darwin', system: system({ handler: null }), log: (l) => log.push(l) });
		assert.strictEqual(r.registered, true);
		assert.ok(log.some((l) => /could not ask macOS .* unconfirmed/.test(l)), log.join(' | '));
	});

	await test('dev: asked not to register, macOS is not consulted at all', () => {
		const c = checkout();
		const mac = system({ register: () => { throw new Error('must not be called'); }, handler: () => { throw new Error('must not be called'); } });
		const r = identity.applyDevIdentity({ vscodeDir: c.dir, platform: 'darwin', register: false, system: mac });
		assert.strictEqual(r.registered, false);
		assert.deepStrictEqual(mac.calls, { register: [], handlerOf: [] });
	});

	// ── a build must be the app that ships ───────────────────────────────────────────────────────
	await test('release check: an app with the shipped identity passes', () => {
		assert.deepStrictEqual(identity.releaseIdentityProblems(builtApp()), []);
	});

	await test('release check: a dev identity on the bundle, or in its product.json, is named and refused', () => {
		assert.deepStrictEqual(identity.releaseIdentityProblems(builtApp({ plist: DEV })), [
			'bundle identifier is ai.levelcode.app.dev, not ai.levelcode.app',
			'URL schemes are [levelcode-dev], not [levelcode]'
		]);
		assert.deepStrictEqual(identity.releaseIdentityProblems(builtApp({ product: DEV })), [
			'product.json urlProtocol is "levelcode-dev", not "levelcode"',
			'product.json darwinBundleIdentifier is "ai.levelcode.app.dev", not "ai.levelcode.app"'
		]);
	});

	await test('release check: an overrides file inside the app, a missing product.json, a missing Info.plist — each fails', () => {
		assert.deepStrictEqual(identity.releaseIdentityProblems(builtApp({ overrides: true })), ['product.overrides.json was packaged — it is for runs from source only']);
		assert.strictEqual(identity.releaseIdentityProblems(builtApp({ product: null })).length, 1);
		const unreadable = builtApp();
		write(path.join(unreadable, 'Contents', 'Resources', 'app', 'product.json'), '{ "urlProtocol": ');
		assert.match(identity.releaseIdentityProblems(unreadable).join(' | '), /^product\.json cannot be read/);
		assert.match(identity.releaseIdentityProblems(path.join(tmp(), 'Nothing.app'))[0], /no Info\.plist/);
	});

	// ── the command line, as run-dev.sh and build-macos.sh call it ───────────────────────────────
	await test('command line: check-release exits 0 for the shipped identity and 1, naming the problem, for any other', () => {
		const ok = spawnSync(process.execPath, [SCRIPT, 'check-release', builtApp()], { encoding: 'utf8' });
		assert.strictEqual(ok.status, 0, ok.stderr);
		const bad = spawnSync(process.execPath, [SCRIPT, 'check-release', builtApp({ plist: DEV })], { encoding: 'utf8' });
		assert.strictEqual(bad.status, 1);
		assert.match(bad.stderr, /does NOT carry the shipped identity[\s\S]*bundle identifier is ai\.levelcode\.app\.dev/);
	});

	await test('command line: dev applies the identity and says which server setting sign-in needs; no arguments is a usage error', () => {
		const c = checkout();
		// --no-register: a fixture in a temp directory is not something to tell LaunchServices about.
		const run = spawnSync(process.execPath, [SCRIPT, 'dev', c.dir, '--no-register'], { encoding: 'utf8' });
		if (process.platform === 'darwin') {
			assert.strictEqual(run.status, 0, run.stderr);
			assert.strictEqual(fs.readFileSync(c.plist, 'utf8'), infoPlist(DEV));
		}
		assert.deepStrictEqual(JSON.parse(fs.readFileSync(c.overrides, 'utf8')), DEV);
		assert.match(run.stdout, /LEVELCODE_EXTRA_EDITOR_SCHEMES=levelcode-dev/);
		assert.strictEqual(spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' }).status, 2);
		const missing = spawnSync(process.execPath, [SCRIPT, 'dev', tmp(), '--no-register'], { encoding: 'utf8' });
		assert.strictEqual(missing.status, 1);
		assert.match(missing.stderr, /no product\.json/);
	});

	// ── why no auth code had to change ───────────────────────────────────────────────────────────
	await test('sign-in asks to be called back on the editor\'s OWN scheme — whatever the product says it is', async () => {
		for (const scheme of ['levelcode', 'levelcode-dev']) {
			const url = await signInUrl(scheme);
			assert.strictEqual(url.origin + url.pathname, 'https://cloud.test/ai/login');
			assert.strictEqual(url.searchParams.get('redirect_uri'), scheme + '://levelcode.levelcode-ai/auth/callback?windowId=1', scheme);
			assert.ok(url.searchParams.get('code_challenge'), 'bound to a PKCE challenge');
		}
	});

	// ── what can only be read ────────────────────────────────────────────────────────────────────
	await test('run-dev.sh sets the identity after the bundle exists and before the editor starts', () => {
		const sh = read('scripts', 'run-dev.sh');
		const at = (needle) => { const i = sh.indexOf(needle); assert.ok(i >= 0, 'run-dev.sh no longer has: ' + needle); return i; };
		const order = [at('node build/lib/preLaunch.ts'), at('editor-identity.mjs" dev "$VSCODE_DIR"'), at('VSCODE_SKIP_PRELAUNCH=1 ./scripts/code.sh')];
		assert.deepStrictEqual(order, [...order].sort((a, b) => a - b), 'preLaunch, then the identity, then the launch');
	});

	await test('build-macos.sh checks the built app\'s identity before it does anything else to it', () => {
		const sh = read('scripts', 'build-macos.sh');
		const check = sh.indexOf('editor-identity.mjs" check-release "$BUILT_APP/LevelCode.app"');
		assert.ok(check >= 0, 'build-macos.sh no longer runs the release identity check');
		assert.ok(check > sh.indexOf('npm run gulp -- "$GULP_TARGET"'), 'after the build');
		assert.ok(check < sh.indexOf('strip-proprietary.mjs'), 'before the strip steps');
		assert.match(sh, /^set -euo pipefail$/m, 'and a failing check stops the script');
	});

	console.log('\neditorIdentity: ' + n + ' tests passed.');
})().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => {
	for (const d of made) { fs.rmSync(d, { recursive: true, force: true }); }
});
