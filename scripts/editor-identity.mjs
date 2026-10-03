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
 *  (2) the editor still asks to be called back on the installed app's. So the two files are replaced
 *  as one change (replaceTogether), and the step FAILS — run-dev.sh stops before launching — unless
 *  macOS then says the dev scheme opens this bundle. Being told about the bundle is not the same as
 *  agreeing to use it: one under a temporary folder is registered and never chosen.
 *
 *  `check-release` is the other direction: a BUILT app must carry the shipped identity, and no
 *  overrides file. scripts/build-macos.sh runs it, so a dev identity cannot be packaged by accident.
 *
 *  A server has to be told to accept the dev scheme (LEVELCODE_EXTRA_EDITOR_SCHEMES, thin.ly). When a
 *  dev sign-in ends on the account page in the browser and the editor hears nothing, that is why.
 *
 *  The functions are exported so test/editorIdentity.test.js can run them — on a fixture, on any OS.
 *--------------------------------------------------------------------------------------------*/
import * as fs from 'node:fs';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const DEV_IDENTITY_FILE = join(REPO, 'branding', 'product.dev.json');
export const SHIPPED_IDENTITY_FILE = join(REPO, 'branding', 'product.overlay.json');
const LSREGISTER = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';

/** The only shape a dev scheme may have: it is also the only shape a server can be told to accept. */
export const DEV_SCHEME = /^levelcode-[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
/** A bundle identifier: reverse-DNS, letters, digits, dots and hyphens. */
const BUNDLE_IDENTIFIER = /^[A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)+$/;

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
	// Both values are written into an Info.plist as they are. Neither pattern admits a character
	// XML would read as markup.
	if (!BUNDLE_IDENTIFIER.test(dev.darwinBundleIdentifier)) {
		throw new Error(`the dev darwinBundleIdentifier must look like ai.levelcode.app.dev, not ${JSON.stringify(dev.darwinBundleIdentifier)}`);
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
 * Replace several files as ONE change: all of them, or none.
 *
 * Staged first. Each new text goes to a temporary file beside its target, so everything that can
 * stop a write — a directory that cannot be written, a full disk — is met while every target is
 * still as it was. Only then is each temporary file renamed over its target, which either happens
 * or does not: a target is never left half written.
 *
 * That leaves one way to end up half done — a rename failing after an earlier one succeeded — and
 * it is undone: the earlier targets get their old contents back, or are removed if they were not
 * there. If even that fails, the error says which file was left changed.
 *
 * (A process KILLED between the renames can still leave one file ahead of the other. The next run
 * finishes the job, and run-dev.sh never launches without a run that finished.)
 *
 * @param {{path: string, text: string}[]} files
 * @param {typeof fs} [io] the filesystem — replaced in tests, to fail a step that cannot be made to fail for real
 */
export function replaceTogether(files, io = fs) {
	/** @type {{target: string, temp: string, before: string|null}[]} */
	const staged = [];
	const discard = (temp) => { try { io.rmSync(temp, { force: true }); } catch { /* a stray temp file is not worth a second error */ } };
	try {
		for (const file of files) {
			// A symlinked target is replaced where it really is, so the link survives.
			const target = io.existsSync(file.path) ? io.realpathSync(file.path) : file.path;
			const before = io.existsSync(target) ? io.readFileSync(target, 'utf8') : null;
			const temp = `${target}.identity-${process.pid}.tmp`;
			staged.push({ target, temp, before });
			io.writeFileSync(temp, file.text, 'utf8');
			if (before !== null) { io.chmodSync(temp, io.statSync(target).mode); }
		}
	} catch (e) {
		staged.forEach((s) => discard(s.temp));
		throw e;
	}
	/** @type {typeof staged} */
	const replaced = [];
	try {
		for (const s of staged) { io.renameSync(s.temp, s.target); replaced.push(s); }
	} catch (e) {
		const stuck = [];
		for (const s of replaced.reverse()) {
			try {
				if (s.before === null) { io.rmSync(s.target, { force: true }); }
				else { io.writeFileSync(s.target, s.before, 'utf8'); }
			} catch (again) { stuck.push(`${s.target} (${String((again && again.message) || again)})`); }
		}
		staged.forEach((s) => discard(s.temp));
		const why = String((e && e.message) || e);
		throw new Error(stuck.length
			? `${why} — and the change could NOT be undone: ${stuck.join('; ')} is left carrying the dev identity. Run this again once the cause is fixed.`
			: `${why} — nothing was changed`, { cause: e });
	}
}

const HANDLER_OF = 'ObjC.import("AppKit"); function run(argv) { const app = $.NSWorkspace.sharedWorkspace.URLForApplicationToOpenURL($.NSURL.URLWithString(argv[0] + "://probe")); return app.isNil() ? "" : ObjC.unwrap(app.path); }';

/** macOS, as far as this script deals with it. Replaced in tests: a fixture is nothing to tell LaunchServices about. */
export const macOS = {
	/** Tell LaunchServices about `bundle`. Throws when it could not be told. */
	register(bundle) {
		const r = spawnSync(LSREGISTER, ['-f', bundle], { encoding: 'utf8', timeout: 30_000 });
		if (r.status !== 0) {
			throw new Error(`lsregister ${r.error ? 'could not be run (' + r.error.message + ')' : 'failed' + (r.signal ? ' (' + r.signal + ')' : '')}: ${((r.stdout || '') + (r.stderr || '')).trim() || 'no output'}`);
		}
	},
	/** The app macOS opens a `scheme://` link with: its path, '' when there is none, null when macOS could not be asked. */
	handlerOf(scheme) {
		const r = spawnSync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', HANDLER_OF, scheme], { encoding: 'utf8', timeout: 30_000 });
		return r.status === 0 ? r.stdout.trim() : null;
	}
};

/**
 * Do two paths name the same place? `/tmp` and `/private/tmp` do — and so, on the volume a Mac
 * ships with, do `~/Code` and `~/code`: macOS answers with a path as it is on disk, while the
 * checkout's is as someone typed it into `cd`. The native realpath settles both; the JS one keeps
 * the case it was given, and would call the bundle's own path "another copy".
 */
function samePlace(a, b) {
	const real = (p) => { try { return fs.realpathSync.native(p); } catch { return resolve(p); } };
	return real(a) === real(b);
}

/**
 * Give the Code-OSS checkout at `vscodeDir` the dev identity. Idempotent — and all or nothing:
 * everything that can refuse is asked BEFORE anything is written, and the two files are then
 * replaced as one change, because one half without the other is worse than neither (see the header).
 *
 * It THROWS unless macOS ends up routing the dev scheme to this bundle. The caller is about to
 * launch an editor that will ask to be called back on that scheme; launching one that will not
 * hear the answer is the failure this script exists to remove.
 *
 * @param {{vscodeDir: string, identity?: any, register?: boolean, platform?: string,
 *          log?: (line: string) => void, io?: typeof fs, system?: typeof macOS}} o
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

	const changes = [];
	if (overrides.changed) { changes.push({ path: overridesPath, text: overrides.text }); }
	if (plist && plist.changed) { changes.push({ path: plistPath, text: plist.xml }); }
	replaceTogether(changes, o.io);

	log(`product.overrides.json: ${identity.urlProtocol}:// (${overrides.changed ? 'written' : 'already set'})`);
	if (!plist) {
		log(`not macOS (${platform}): the URL scheme is not registered with the system — the callback will not reach this editor`);
		return { identity, overridesChanged: overrides.changed, bundle: null, bundleChanged: false, registered: false };
	}
	log(`${name}.app: ${identity.darwinBundleIdentifier} (${plist.changed ? 'was ' + plist.was.darwinBundleIdentifier + ', ' + (plist.was.urlSchemes.join(', ') || 'no scheme') + '://' : 'already set'})`);

	// Registered every time, not only after a change: it is what routes the link, it is cheap, and a
	// rebuilt LaunchServices database forgets a bundle that was only ever launched from a shell.
	//
	// The two files are left as they are when this fails. They agree with each other, the next run
	// registers again, and undoing them would only hand the next launch the installed app's scheme.
	let registered = false;
	if (o.register !== false) {
		const system = o.system || macOS;
		const scheme = identity.urlProtocol;
		try { system.register(bundle); }
		catch (e) { throw new Error(`${bundle} could not be registered for ${scheme}:// — ${String((e && e.message) || e)}. Run this again; the editor was not started.`, { cause: e }); }
		// Registered is not routed. Ask macOS what it will actually do with the link.
		const handler = system.handlerOf(scheme);
		if (handler === null) {
			log(`registered with LaunchServices — could not ask macOS which app opens ${scheme}://, so that is unconfirmed`);
		} else if (handler === '') {
			throw new Error(`macOS has no app for ${scheme}:// even after registering ${bundle}. A bundle under a temporary folder is registered and never chosen — is the checkout in one?`);
		} else if (!samePlace(handler, bundle)) {
			throw new Error(`macOS opens ${scheme}:// with ${handler}, not with ${bundle}. Another copy claims the scheme; quit it and unregister it:\n  ${LSREGISTER} -u "${handler}"`);
		} else {
			log(`macOS opens ${scheme}:// with this bundle`);
		}
		registered = true;
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
		let product = null;
		try { product = JSON.parse(readFileSync(productPath, 'utf8')); }
		catch (e) { problems.push(`product.json cannot be read: ${String((e && e.message) || e)}`); }
		for (const key of product ? ['urlProtocol', 'darwinBundleIdentifier'] : []) {
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
