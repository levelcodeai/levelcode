#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  LevelCode — which app the editor is, to the operating system.
 *
 *  Usage:  node scripts/editor-identity.mjs dev <path-to-vscode-checkout> [--no-register]
 *          node scripts/editor-identity.mjs check-release <path-to-LevelCode.app>
 *
 *  WHY THIS EXISTS
 *
 *  A LevelCode run from source (scripts/run-dev.sh) and the LevelCode in /Applications were the same
 *  app as far as macOS could tell: one bundle identifier, one URL scheme. Sign-in ends with the
 *  browser opening levelcode://…/auth/callback, and macOS decides which app that belongs to. It
 *  picked the installed one. The dev editor that had asked never heard back, and the installed
 *  editor was handed a callback for a sign-in it had not started.
 *
 *  The sign-in code needs no change for this: it builds its callback from the editor's own scheme
 *  (vscode.env.uriScheme). What was missing is a scheme — and a bundle identifier — of the dev
 *  run's own. A scheme alone is not enough: with one shared identifier macOS can still hand a
 *  launch, or a link, to whichever copy is running.
 *
 *  `dev` gives the checkout that identity, in the two places it lives:
 *
 *    1. vscode/product.overrides.json — what the editor believes at RUNTIME. Code-OSS reads this
 *       file only when running from source, and never packages it, so product.json stays the
 *       product that ships. Keys a developer has put there themselves are kept.
 *    2. The dev Electron bundle's Info.plist — what MACOS believes. The bundle is generated from
 *       product.json, and regenerated only when the Electron version changes, so its identifier
 *       and URL scheme are set here, and set again after a regeneration. Then the bundle is
 *       registered with LaunchServices, which is what actually routes the link.
 *
 *  Both, or neither works: with only (1) the browser is sent to a scheme nothing claims; with only
 *  (2) the editor still asks to be called back on the installed app's.
 *
 *  `check-release` is the other direction: a BUILT app must carry the shipped identity, and no
 *  overrides file. scripts/build-macos.sh runs it, so a dev identity cannot be packaged by accident.
 *
 *  A server has to be told to accept the dev scheme (LEVELCODE_EXTRA_EDITOR_SCHEMES, thin.ly). When a
 *  dev sign-in ends on the account page in the browser and the editor hears nothing, that is why.
 *
 *  The functions are exported so test/editorIdentity.test.js can run them — on a fixture, on any OS.
 *--------------------------------------------------------------------------------------------*/
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const DEV_IDENTITY_FILE = join(REPO, 'branding', 'product.dev.json');
export const SHIPPED_IDENTITY_FILE = join(REPO, 'branding', 'product.overlay.json');
const LSREGISTER = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';

/** The only shape a dev scheme may have: it is also the only shape a server can be told to accept. */
export const DEV_SCHEME = /^levelcode-[a-z0-9]+(?:[.-][a-z0-9]+)*$/;

/** @param {string} file @returns {{urlProtocol: string, darwinBundleIdentifier: string}} */
function identityIn(file) {
	const json = JSON.parse(readFileSync(file, 'utf8'));
	const { urlProtocol, darwinBundleIdentifier } = json;
	if (typeof urlProtocol !== 'string' || typeof darwinBundleIdentifier !== 'string' || !urlProtocol || !darwinBundleIdentifier) {
		throw new Error(`${file} must name both urlProtocol and darwinBundleIdentifier`);
	}
	return { urlProtocol, darwinBundleIdentifier };
}

/** The identity of the product that ships. */
export function shippedIdentity(file = SHIPPED_IDENTITY_FILE) { return identityIn(file); }

/**
 * The identity of a run from source. It has to differ from the shipped one in BOTH parts — sharing
 * either is the bug this file exists for — and its scheme has to be one a server can accept.
 */
export function devIdentity(file = DEV_IDENTITY_FILE, shipped = shippedIdentity()) {
	const dev = identityIn(file);
	if (!DEV_SCHEME.test(dev.urlProtocol)) {
		throw new Error(`the dev urlProtocol must look like levelcode-dev, not ${JSON.stringify(dev.urlProtocol)}`);
	}
	if (dev.urlProtocol === shipped.urlProtocol || dev.darwinBundleIdentifier === shipped.darwinBundleIdentifier) {
		throw new Error('the dev identity must differ from the shipped one in both urlProtocol and darwinBundleIdentifier');
	}
	return dev;
}

/**
 * product.overrides.json with the dev identity in it. Whatever else the developer keeps there stays.
 * A file that is not JSON is theirs to fix, not ours to overwrite.
 * @param {string|null} existing the file's text, or null when there is none
 * @returns {{text: string, changed: boolean}}
 */
export function mergeOverrides(existing, identity) {
	let current = {};
	if (existing !== null && existing.trim()) {
		try { current = JSON.parse(existing); }
		catch (e) { throw new Error('product.overrides.json is not valid JSON — fix or delete it: ' + e.message); }
		if (!current || typeof current !== 'object' || Array.isArray(current)) {
			throw new Error('product.overrides.json must hold a JSON object');
		}
	}
	const changed = current.urlProtocol !== identity.urlProtocol || current.darwinBundleIdentifier !== identity.darwinBundleIdentifier;
	const merged = { ...current, urlProtocol: identity.urlProtocol, darwinBundleIdentifier: identity.darwinBundleIdentifier };
	return { text: changed || existing === null ? JSON.stringify(merged, null, '\t') + '\n' : existing, changed: changed || existing === null };
}

const IDENTIFIER = /(<key>CFBundleIdentifier<\/key>\s*<string>)([^<]*)(<\/string>)/g;
const URL_SCHEMES = /(<key>CFBundleURLSchemes<\/key>\s*<array>)([\s\S]*?)(<\/array>)/g;

/**
 * What an Info.plist says the bundle is. Strict on purpose: the file is generated, its shape is
 * known, and anything else — a binary plist, two URL types — is a reason to stop, not to guess.
 * @param {string} xml
 * @returns {{darwinBundleIdentifier: string, urlSchemes: string[]}}
 */
export function plistIdentity(xml) {
	const ids = [...String(xml).matchAll(IDENTIFIER)];
	const schemes = [...String(xml).matchAll(URL_SCHEMES)];
	if (ids.length !== 1) { throw new Error(`Info.plist: expected one CFBundleIdentifier, found ${ids.length}`); }
	if (schemes.length !== 1) { throw new Error(`Info.plist: expected one CFBundleURLSchemes list, found ${schemes.length}`); }
	return {
		darwinBundleIdentifier: ids[0][2].trim(),
		urlSchemes: [...schemes[0][2].matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1].trim())
	};
}

/**
 * The same Info.plist, claiming `identity`: that bundle identifier, and that URL scheme ALONE.
 * @param {string} xml
 * @returns {{xml: string, changed: boolean, was: {darwinBundleIdentifier: string, urlSchemes: string[]}}}
 */
export function withIdentity(xml, identity) {
	const was = plistIdentity(xml);
	const changed = was.darwinBundleIdentifier !== identity.darwinBundleIdentifier
		|| was.urlSchemes.length !== 1 || was.urlSchemes[0] !== identity.urlProtocol;
	if (!changed) { return { xml, changed, was }; }
	const next = String(xml)
		.replace(IDENTIFIER, (_all, open, _id, close) => open + identity.darwinBundleIdentifier + close)
		.replace(URL_SCHEMES, (_all, open, inner, close) => {
			const indent = (/\n([ \t]*)<string>/.exec(inner) || [, ''])[1];
			const tail = (/\n[ \t]*$/.exec(inner) || [''])[0];
			return open + (indent || tail ? '\n' + indent : '') + '<string>' + identity.urlProtocol + '</string>' + tail + close;
		});
	return { xml: next, changed, was };
}

/**
 * Give the Code-OSS checkout at `vscodeDir` the dev identity. Idempotent — and all or nothing:
 * everything that can refuse is asked BEFORE anything is written, because one half without the
 * other is worse than neither (see the header).
 * @param {{vscodeDir: string, identity?: any, register?: boolean, platform?: string, log?: (line: string) => void}} o
 */
export function applyDevIdentity(o) {
	const log = o.log || (() => { });
	const identity = o.identity || devIdentity();
	const platform = o.platform || process.platform;
	const productPath = join(o.vscodeDir, 'product.json');
	if (!existsSync(productPath)) { throw new Error(`no product.json in ${o.vscodeDir} — is that the Code-OSS checkout?`); }

	// 1. What the editor believes at runtime.
	const overridesPath = join(o.vscodeDir, 'product.overrides.json');
	const overrides = mergeOverrides(existsSync(overridesPath) ? readFileSync(overridesPath, 'utf8') : null, identity);

	// 2. What macOS believes. The scheme of a dev run on other systems is registered differently
	//    (a .desktop file, the registry) and is not handled here.
	let bundle = null, plistPath = null, plist = null, name = '';
	if (platform === 'darwin') {
		name = JSON.parse(readFileSync(productPath, 'utf8')).nameLong;
		bundle = join(o.vscodeDir, '.build', 'electron', name + '.app');
		plistPath = join(bundle, 'Contents', 'Info.plist');
		if (!existsSync(plistPath)) { throw new Error(`no dev Electron bundle at ${bundle} — it is created on first launch (node build/lib/preLaunch.ts)`); }
		plist = withIdentity(readFileSync(plistPath, 'utf8'), identity);
	}

	if (overrides.changed) { writeFileSync(overridesPath, overrides.text, 'utf8'); }
	log(`product.overrides.json: ${identity.urlProtocol}:// (${overrides.changed ? 'written' : 'already set'})`);
	if (!plist) {
		log(`not macOS (${platform}): the URL scheme is not registered with the system — the callback will not reach this editor`);
		return { identity, overridesChanged: overrides.changed, bundle: null, bundleChanged: false, registered: false };
	}
	if (plist.changed) { writeFileSync(plistPath, plist.xml, 'utf8'); }
	log(`${name}.app: ${identity.darwinBundleIdentifier} (${plist.changed ? 'was ' + plist.was.darwinBundleIdentifier + ', ' + (plist.was.urlSchemes.join(', ') || 'no scheme') + '://' : 'already set'})`);

	// Registered every time, not only after a change: it is what routes the link, it is cheap, and a
	// rebuilt LaunchServices database forgets a bundle that was only ever launched from a shell.
	let registered = false;
	if (o.register !== false) {
		const r = spawnSync(LSREGISTER, ['-f', bundle], { encoding: 'utf8' });
		registered = r.status === 0;
		log(registered ? `registered ${identity.urlProtocol}:// with LaunchServices` : `could not register with LaunchServices (${(r.stderr || r.error || 'lsregister failed').toString().trim()})`);
	}
	return { identity, overridesChanged: overrides.changed, bundle, bundleChanged: plist.changed, registered };
}

/**
 * Everything wrong with the identity of a BUILT app — an empty list is a pass.
 * @param {string} app path to LevelCode.app
 * @returns {string[]}
 */
export function releaseIdentityProblems(app, shipped = shippedIdentity()) {
	const problems = [];
	const plistPath = join(app, 'Contents', 'Info.plist');
	const resources = join(app, 'Contents', 'Resources', 'app');
	if (!existsSync(plistPath)) { return [`no Info.plist at ${plistPath}`]; }
	try {
		const is = plistIdentity(readFileSync(plistPath, 'utf8'));
		if (is.darwinBundleIdentifier !== shipped.darwinBundleIdentifier) {
			problems.push(`bundle identifier is ${is.darwinBundleIdentifier}, not ${shipped.darwinBundleIdentifier}`);
		}
		if (is.urlSchemes.length !== 1 || is.urlSchemes[0] !== shipped.urlProtocol) {
			problems.push(`URL schemes are [${is.urlSchemes.join(', ')}], not [${shipped.urlProtocol}]`);
		}
	} catch (e) { problems.push(String(e.message || e)); }
	const productPath = join(resources, 'product.json');
	if (!existsSync(productPath)) { problems.push(`no product.json at ${productPath}`); }
	else {
		const product = JSON.parse(readFileSync(productPath, 'utf8'));
		for (const key of ['urlProtocol', 'darwinBundleIdentifier']) {
			if (product[key] !== shipped[key]) { problems.push(`product.json ${key} is ${JSON.stringify(product[key])}, not ${JSON.stringify(shipped[key])}`); }
		}
	}
	if (existsSync(join(resources, 'product.overrides.json'))) { problems.push('product.overrides.json was packaged — it is for runs from source only'); }
	return problems;
}

// ---- command line ------------------------------------------------------------------------------

function main(argv) {
	const [command, target, ...flags] = argv;
	const say = (line) => console.log('[editor-identity] ' + line);
	if (command === 'dev' && target) {
		const result = applyDevIdentity({ vscodeDir: resolve(target), register: !flags.includes('--no-register'), log: say });
		say(`sign-in needs a server that accepts ${result.identity.urlProtocol}:// — LEVELCODE_EXTRA_EDITOR_SCHEMES=${result.identity.urlProtocol} on the backend`);
		return 0;
	}
	if (command === 'check-release' && target) {
		const problems = releaseIdentityProblems(resolve(target));
		if (!problems.length) { say(`${target} carries the shipped identity`); return 0; }
		console.error('\x1b[31m[editor-identity] ' + target + ' does NOT carry the shipped identity:\x1b[0m');
		for (const p of problems) { console.error('  - ' + p); }
		return 1;
	}
	console.error('usage: node scripts/editor-identity.mjs dev <vscode-checkout> [--no-register]\n       node scripts/editor-identity.mjs check-release <LevelCode.app>');
	return 2;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try { process.exit(main(process.argv.slice(2))); }
	catch (e) { console.error('\x1b[31m[editor-identity] ' + String((e && e.message) || e) + '\x1b[0m'); process.exit(1); }
}
