#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  LevelCode — the extension signature verifier, in a built app.
 *
 *  Usage:  node scripts/extension-signature.mjs install  <app-code-folder> [--replace]
 *          node scripts/extension-signature.mjs check    <app-code-folder>
 *          node scripts/extension-signature.mjs smoke    <LevelCode.app> [--strict]
 *          node scripts/extension-signature.mjs registry [--strict]
 *
 *  <app-code-folder> is the folder that holds the built editor's code and its node_modules —
 *  LevelCode.app/Contents/Resources/app.
 *
 *  WHY THIS EXISTS
 *
 *  Before installing or updating an extension the editor loads a module named `@vscode/vsce-sign`
 *  and asks it to verify the download. The module is Microsoft's and may not be shipped, so a build
 *  from the open source had nothing to load: every install from Open VSX ended in "Signature
 *  verification was not executed", and every automatic update failed the same way without a word.
 *  modules/extension-signature is LevelCode's module for that slot. It verifies Open VSX's own
 *  signatures against keys that ship with it. See its index.js for what that does and does not
 *  mean, and docs/EXTENSION-SIGNATURES.md for the whole of it.
 *
 *  `install` puts the module where a built app looks for it — the same move as
 *  strip-proprietary.mjs, on the built app and never on the source checkout. Nothing in the
 *  editor's source is patched; there is nothing to re-apply when Code-OSS is bumped.
 *
 *  `check` is what makes that safe to rely on. It fails unless the built editor still asks for the
 *  module by that name, the name resolves to LevelCode's module from the very files that ask, and
 *  the module — loaded the way the editor loads it — accepts a real Open VSX package and refuses a
 *  changed one. An upstream change that would bring "not executed" back fails the build instead.
 *
 *  `smoke` asks the app itself: it installs one small extension from Open VSX through the built
 *  app's own command line, into throwaway folders, and reads the app's log. It needs the network,
 *  so a registry that cannot be reached is a warning; an app that cannot verify is a failure.
 *
 *  `registry` is the watch on Open VSX's signing key. The keys are pinned, so the day the registry
 *  signs with another one, no shipped LevelCode can install or update anything until a release
 *  carries it. This asks the registry which key its newest extensions name and verifies some of
 *  them for real. It exits 1 only on evidence — a key that is not pinned, or signatures that no
 *  longer verify. Not reaching the registry is not evidence: a warning, or exit 2 with --strict.
 *  It asks the registry and the one host the registry keeps its files on, and nobody else: a
 *  redirect is followed by hand, and only to a place named in this file.
 *
 *  The functions are exported so modules/extension-signature/test/ can run them on fixtures, with
 *  the network and the app replaced by stand-ins.
 *--------------------------------------------------------------------------------------------*/
import * as fs from 'node:fs';
import * as os from 'node:os';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** The module's source: what `install` copies from. */
export const MODULE_SOURCE = join(REPO, 'modules', 'extension-signature');
/** The name the editor imports. It is the editor's, not ours to choose. */
export const MODULE_NAME = '@vscode/vsce-sign';
/** What ships: these three files and nothing else. The module's tests and fixtures stay in the repo. */
export const MODULE_FILES = ['index.js', 'keys.json', 'package.json'];
/** How the module's package.json says it is LevelCode's. */
export const MODULE_MARK = 'modules/extension-signature';
/** A real Open VSX package and its signature archive: what an installed module must accept. */
export const FIXTURE = {
	vsix: join(MODULE_SOURCE, 'test', 'fixtures', 'perrinjerome.git-rebase-syntax-0.0.1.vsix'),
	signature: join(MODULE_SOURCE, 'test', 'fixtures', 'perrinjerome.git-rebase-syntax-0.0.1.sigzip')
};
/** The extension `smoke` installs: the fixture's — four kilobytes, published in 2020. */
export const SMOKE_EXTENSION = 'perrinjerome.git-rebase-syntax';
/**
 * Where Open VSX keeps its files. The registry answers every download with a redirect to this host,
 * so `registry` has to follow one — and this is the only place it follows one to. It is named here
 * rather than taken from the answer: a host the check is merely told about is a host anyone who can
 * answer for the registry could choose. If Open VSX moves its files, `registry` says where to and
 * stops being able to check; add the new host here once you know it is theirs.
 */
export const CONTENT_ORIGINS = ['https://openvsx.eclipsecontent.org'];
/** A download is one redirect. This leaves the registry room for another hop, not for a tour. */
const MAX_REDIRECTS = 3;
const SHIPPED_PRODUCT = join(REPO, 'branding', 'product.overlay.json');
const DOCS = 'docs/EXTENSION-SIGNATURES.md';

const reason = (e) => String((e && e.message) || e);
const isDirectory = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const realPath = (p) => { try { return fs.realpathSync.native(p); } catch { return resolve(p); } };

/** Every file under `dir`, as paths relative to it. */
function filesUnder(dir, prefix = '') {
	const found = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const rel = prefix ? prefix + '/' + entry.name : entry.name;
		if (entry.isDirectory()) { found.push(...filesUnder(join(dir, entry.name), rel)); } else { found.push(rel); }
	}
	return found.sort();
}

/** Where the module lives in a built app. */
export function installedPath(resources) { return join(resources, 'node_modules', ...MODULE_NAME.split('/')); }

/**
 * What is at the module's place in an app: nothing (null), or whether it is LevelCode's and whether
 * it is, byte for byte, the module in `source`.
 */
function installedModule(target, source) {
	if (!fs.existsSync(target)) { return null; }
	if (!isDirectory(target)) { return { ours: false, same: false, listing: [] }; }
	const listing = filesUnder(target);
	let pkg = null;
	try { pkg = JSON.parse(fs.readFileSync(join(target, 'package.json'), 'utf8')); } catch { /* not ours */ }
	const ours = !!pkg && pkg.name === MODULE_NAME && pkg.levelcode === MODULE_MARK;
	const same = listing.length === MODULE_FILES.length && MODULE_FILES.every((f) =>
		listing.includes(f) && fs.readFileSync(join(target, f)).equals(fs.readFileSync(join(source, f))));
	return { ours, same, listing };
}

/**
 * Put the module into a built app. Doing it twice changes nothing.
 *
 * What is already there decides the rest. LevelCode's verifier from ANOTHER commit is left as it
 * was built — an app being signed carries the keys its own build pinned, and swapping them for
 * this checkout's is not a signing step's call (`check` then says whether it works). A module of
 * that name that is not LevelCode's is never left to ship beside ours: that is an error. `replace`
 * settles both the same way — this checkout's module goes in — and is what a build passes.
 * @param {string} resources the app's code folder (…/Contents/Resources/app)
 * @param {{replace?: boolean, source?: string}} [options]
 * @returns {{target: string, changed: boolean, replaced: null|'levelcode'|'foreign', kept: boolean}}
 *          `kept`: a LevelCode verifier that differs from this checkout's was left in place.
 */
export function installModule(resources, { replace = false, source = MODULE_SOURCE } = {}) {
	const nodeModules = join(resources, 'node_modules');
	if (!isDirectory(nodeModules)) { throw new Error(`${nodeModules} is not a folder — expected a built app's code folder (LevelCode.app/Contents/Resources/app)`); }
	const target = installedPath(resources);
	// Everything is read before anything is written: a source that is not whole changes nothing.
	const files = MODULE_FILES.map((name) => ({ name, bytes: fs.readFileSync(join(source, name)) }));
	const found = installedModule(target, source);
	if (found && found.same) { return { target, changed: false, replaced: null, kept: false }; }
	if (found && !replace) {
		if (found.ours) { return { target, changed: false, replaced: null, kept: true }; }
		throw new Error(`${target} holds a module that is not LevelCode's (${found.listing.slice(0, 4).join(', ') || 'not a folder'}). It must not ship in place of the verifier: pass --replace to put LevelCode's there.`);
	}
	// Written beside its place and moved in whole: a build stopped half-way leaves the old module or
	// none, never half of one. The staging folder has one name, so whatever a stopped run left of it
	// is cleared by the next and cannot ship.
	const staging = `${target}.installing`;
	fs.rmSync(staging, { recursive: true, force: true });
	fs.mkdirSync(staging, { recursive: true });
	for (const f of files) { fs.writeFileSync(join(staging, f.name), f.bytes); }
	fs.rmSync(target, { recursive: true, force: true });
	fs.renameSync(staging, target);
	return { target, changed: true, replaced: found ? (found.ours ? 'levelcode' : 'foreign') : null, kept: false };
}

/** The editor's code files under `out` that name `needle` — the ones that will import the module. */
function bundlesNaming(out, needle) {
	if (!isDirectory(out)) { return []; }
	return filesUnder(out).filter((f) => f.endsWith('.js')).map((f) => join(out, f)).filter((f) => fs.readFileSync(f).includes(needle));
}

/**
 * Load the module the way the editor does and put two packages to it. The editor's code does
 * `import('@vscode/vsce-sign')` from the folder its bundle sits in; this does the same, in a
 * process of its own, from that folder — so what is found is what the editor would find, and a
 * module that Node loads but whose verify() an ES import cannot see fails here, not in the app.
 */
const PROBE = `
const name = process.argv[1];
const loaded = await import(name);
if (typeof loaded.verify !== 'function') { console.log(JSON.stringify({ error: 'it has no verify() an import can see' })); process.exit(0); }
const good = await loaded.verify(process.argv[2], process.argv[3], false);
const changed = await loaded.verify(process.argv[4], process.argv[3], false);
console.log(JSON.stringify({ good, changed, keys: loaded.trustedKeyIds }));
`;
function probeFrom(folder, fixture, changedPackage) {
	const run = spawnSync(process.execPath, ['--input-type=module', '-e', PROBE, MODULE_NAME, fixture.vsix, fixture.signature, changedPackage],
		{ cwd: folder, encoding: 'utf8', timeout: 60000 });
	if (run.status !== 0) { return { error: (run.stderr || run.stdout || String(run.error || 'no output')).trim().split('\n').slice(0, 3).join(' | ') }; }
	try { return JSON.parse(run.stdout.trim().split('\n').pop()); } catch { return { error: 'unreadable answer: ' + run.stdout.slice(0, 200) }; }
}

/**
 * Everything that would stop a built app verifying extensions — an empty `problems` is a pass.
 * @param {string} resources the app's code folder (…/Contents/Resources/app)
 * @param {{fixture?: {vsix: string, signature: string}}} [options]
 * @returns {{problems: string[], keys: string[], askedBy: string[]}}
 */
export function installedModuleProblems(resources, { fixture = FIXTURE } = {}) {
	const problems = [];
	const target = installedPath(resources);
	const found = installedModule(target, MODULE_SOURCE);
	if (!found || !found.listing.length) {
		return { problems: [`no verifier: ${target} is missing. Without it the app refuses every signed extension ("Signature verification was not executed"). Install it: node scripts/extension-signature.mjs install "${resources}"`], keys: [], askedBy: [] };
	}
	if (!found.ours) { problems.push(`${target} is not LevelCode's module — its package.json does not say "levelcode": "${MODULE_MARK}"`); }
	for (const f of MODULE_FILES) { if (!found.listing.includes(f)) { problems.push(`the module is missing ${f}`); } }
	for (const f of found.listing) { if (!MODULE_FILES.includes(f)) { problems.push(`the module carries a file that is not part of it: ${f}`); } }

	// Who asks, and what they would get. Zero askers is the upstream change this check exists for.
	const out = join(resources, 'out');
	const askers = bundlesNaming(out, MODULE_NAME);
	const askedBy = askers.map((f) => relative(resources, f));
	if (!askers.length) {
		problems.push(`nothing under ${out} asks for ${MODULE_NAME}: the editor no longer loads its verifier by that name, so this module would never run. See ${DOCS} ("When Code-OSS is bumped").`);
	}
	const index = realPath(join(target, 'index.js'));
	for (const asker of askers) {
		let resolved = null;
		try { resolved = realPath(createRequire(asker).resolve(MODULE_NAME)); } catch { /* reported below */ }
		if (resolved !== index) { problems.push(`${relative(resources, asker)} would load ${resolved || 'nothing'} for ${MODULE_NAME}, not ${index}`); }
	}
	if (problems.length) { return { problems, keys: [], askedBy }; }

	// It is the right module in the right place. Does it work — from where the editor stands?
	const scratch = fs.mkdtempSync(join(os.tmpdir(), 'levelcode-signature-check-'));
	let keys = [];
	try {
		const changedPackage = join(scratch, 'changed.vsix');
		const bytes = Buffer.from(fs.readFileSync(fixture.vsix));
		bytes[bytes.length >> 1] ^= 0x01;
		fs.writeFileSync(changedPackage, bytes);
		for (const folder of [...new Set(askers.map((f) => dirname(f)))]) {
			const where = relative(resources, folder);
			const answer = probeFrom(folder, fixture, changedPackage);
			if (answer.error) { problems.push(`loaded from ${where}, the module fails: ${answer.error}`); continue; }
			keys = answer.keys || [];
			if (answer.good.code !== 'Success' || answer.good.didExecute !== true) {
				problems.push(`loaded from ${where}, the module does not accept a real Open VSX package: ${answer.good.code} — ${answer.good.output}. Its keys (${keys.join(', ')}) did not sign this checkout's fixture.`);
			}
			if (answer.changed.code === 'Success') { problems.push(`loaded from ${where}, the module ACCEPTS a package with one byte changed`); }
		}
	} finally { fs.rmSync(scratch, { recursive: true, force: true }); }
	return { problems, keys, askedBy };
}

// ---- smoke: the built app, asked directly ---------------------------------------------------

/**
 * Read what the app said after being asked to install `extension`.
 * @param {{status: number|null, output: string, log: string, extension: string}} run
 * @returns {{verdict: 'pass'|'fail'|'unknown', why: string}}
 */
export function smokeVerdict({ status, output, log, extension }) {
	const said = output + '\n' + log;
	if (/Signature verification was not executed/i.test(said)) {
		return { verdict: 'fail', why: 'the app could not run its verifier ("Signature verification was not executed") — the module is missing from it, or does not load' };
	}
	const failed = /Signature verification failed with '([A-Za-z]+)' error/.exec(said);
	if (failed) { return { verdict: 'fail', why: `the app refused ${extension}: signature verification failed with '${failed[1]}' — see the result codes in ${DOCS}` }; }
	const result = new RegExp(`Extension signature verification result for ${extension.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: ([A-Za-z]+)\\. .*?Executed: (true|false)`, 'i').exec(said);
	if (status === 0 && result && result[1] === 'Success' && result[2] === 'true') { return { verdict: 'pass', why: `the app verified ${extension} and installed it` }; }
	if (status === 0) { return { verdict: 'fail', why: `the app installed ${extension} but its log shows no successful signature check — it is installing extensions unverified` }; }
	const last = output.trim().split('\n').filter(Boolean).slice(-2).join(' | ') || `exit ${status}`;
	return { verdict: 'unknown', why: `the install did not finish, for a reason that is not a signature: ${last}` };
}

/** The executable inside a macOS app bundle, by what its Info.plist names. */
function bundleExecutable(app) {
	const plist = fs.readFileSync(join(app, 'Contents', 'Info.plist'), 'utf8');
	const named = /<key>CFBundleExecutable<\/key>\s*<string>([^<]+)<\/string>/.exec(plist);
	if (!named) { throw new Error(`${app} names no CFBundleExecutable`); }
	return join(app, 'Contents', 'MacOS', named[1]);
}

/**
 * Install one extension through a built app's own command line and say what happened. The app runs
 * as a command-line process — no window — with its own data and extension folders, so nothing of
 * the machine's real LevelCode is read or changed.
 * @param {{app?: string, electron?: string, cli?: string, extension?: string, timeoutMs?: number}} options
 *        `app` is LevelCode.app; `electron` and `cli` name its executable and out/cli.js directly.
 * @returns {{verdict: 'pass'|'fail'|'unknown', why: string}}
 */
export function smokeTest({ app, electron, cli, extension = SMOKE_EXTENSION, timeoutMs = 180000 }) {
	electron = electron || bundleExecutable(app);
	cli = cli || join(app, 'Contents', 'Resources', 'app', 'out', 'cli.js');
	for (const needed of [electron, cli]) { if (!fs.existsSync(needed)) { throw new Error(`${needed} not found — is this a built LevelCode.app?`); } }
	const scratch = fs.mkdtempSync(join(os.tmpdir(), 'levelcode-signature-smoke-'));
	try {
		const data = join(scratch, 'data'), extensions = join(scratch, 'extensions');
		const run = spawnSync(electron, [cli, '--install-extension', extension, '--user-data-dir', data, '--extensions-dir', extensions],
			{ env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', timeout: timeoutMs });
		const output = (run.stdout || '') + (run.stderr || '') + (run.error ? '\n' + reason(run.error) : '');
		const log = isDirectory(data) ? filesUnder(data).filter((f) => f.endsWith('.log')).map((f) => fs.readFileSync(join(data, f), 'utf8')).join('\n') : '';
		return smokeVerdict({ status: run.status, output, log, extension });
	} finally { fs.rmSync(scratch, { recursive: true, force: true }); }
}

// ---- registry: is Open VSX still signing with a key we trust? -------------------------------

/** The gallery the shipped product points the editor at — the registry the pinned keys are for. */
export function galleryOrigin(productFile = SHIPPED_PRODUCT) {
	return new URL(JSON.parse(fs.readFileSync(productFile, 'utf8')).extensionsGallery.serviceUrl).origin;
}

/** A response body, refused past `limit` bytes — by its stated length, and then by what arrives. */
async function bodyWithin(response, limit) {
	const refuse = async (stream) => { try { await stream?.cancel(); } catch { /* nothing to cancel */ } return null; };
	if (Number(response.headers.get('content-length') || 0) > limit) { return refuse(response.body); }
	if (!response.body) { return Buffer.alloc(0); }
	const reader = response.body.getReader();
	const chunks = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) { return Buffer.concat(chunks); }
		total += value.length;
		if (total > limit) { return refuse(reader); }
		chunks.push(value);
	}
}

/** A redirect that was not followed, and why. Not a network failure: the check chose not to go. */
class NotFollowed extends Error { }

/**
 * GET `url`, going only where `allowed` says. fetch() follows a redirect wherever it leads, so it
 * is told not to, and each redirect is followed here instead: its destination is checked BEFORE
 * anything is sent to it.
 * @param {typeof fetch} fetch
 * @param {string} url
 * @param {string[]} allowed origins a redirect may lead to
 * @returns {Promise<Response>} the answer that is not a redirect
 */
async function getWithin(fetch, url, allowed) {
	const signal = AbortSignal.timeout(60000);
	let at = new URL(url);
	for (let redirects = 0; ; redirects++) {
		const response = await fetch(at.href, { redirect: 'manual', headers: { accept: 'application/json, */*', 'user-agent': 'levelcode-extension-signature-check' }, signal });
		if (![301, 302, 303, 307, 308].includes(response.status)) { return response; }
		try { await response.body?.cancel(); } catch { /* a redirect with nothing to drop */ }
		const location = response.headers.get('location');
		let next = null;
		try { next = location ? new URL(location, at) : null; } catch { /* an address that cannot be read is no address */ }
		if (!next) { throw new NotFollowed(`${at.origin} answered with a redirect that names no usable address`); }
		if (!allowed.includes(next.origin)) {
			const where = next.origin === 'null' ? next.protocol : next.origin;
			throw new NotFollowed(`${at.origin} redirects to ${where}, which is neither the registry nor a host it is known to keep its files on`);
		}
		if (redirects >= MAX_REDIRECTS) { throw new NotFollowed(`${new URL(url).origin} redirects more than ${MAX_REDIRECTS} times`); }
		at = next;
	}
}

/**
 * Ask the registry which key signs its newest extensions, and verify some of them with the pinned keys.
 * @param {{fetch?: typeof fetch, source?: string, origin?: string, contentOrigins?: string[], sample?: number, verifyUpTo?: number, maxPackageBytes?: number}} [options]
 * @returns {Promise<{status: 'ok'|'mismatch'|'unknown', lines: string[]}>}
 *          'mismatch' is evidence that shipped builds cannot verify what the registry serves now.
 */
export async function checkRegistry({ fetch = globalThis.fetch, source = MODULE_SOURCE, origin = galleryOrigin(), contentOrigins = CONTENT_ORIGINS, sample = 30, verifyUpTo = 2, maxPackageBytes = 20 * 1024 * 1024 } = {}) {
	const pinned = JSON.parse(fs.readFileSync(join(source, 'keys.json'), 'utf8')).keys;
	const pinnedIds = pinned.map((k) => k.id);
	const { createVerifier } = createRequire(import.meta.url)(source);
	const verify = createVerifier(pinned);
	const get = (url) => getWithin(fetch, url, [origin, ...contentOrigins]);
	const unknown = (why) => ({ status: /** @type {'unknown'} */ ('unknown'), lines: [`could not check: ${why}`] });

	let listed;
	try {
		const response = await get(`${origin}/api/-/search?size=${sample}&sortBy=timestamp&sortOrder=desc`);
		if (!response.ok) { return unknown(`${origin} answered ${response.status}`); }
		const body = await bodyWithin(response, 8 * 1024 * 1024);
		if (!body) { return unknown(`${origin} answered with more than a listing`); }
		listed = JSON.parse(body.toString('utf8')).extensions;
	} catch (e) { return unknown(`${origin} could not be asked: ${reason(e)}`); }
	if (!Array.isArray(listed) || !listed.length) { return unknown(`${origin} listed no extensions`); }

	// What the listing says: which key each of the newest extensions names. A request is only ever
	// STARTED at the registry — the listing is a server's answer, not a list of places to go — and
	// where the registry then redirects is checked hop by hop (getWithin).
	const named = new Map();
	const candidates = [];
	let unsigned = 0;
	for (const e of listed) {
		const files = (e && e.files) || {};
		const here = (u) => { try { return new URL(u).origin === origin; } catch { return false; } };
		if (!here(files.signature) || !here(files.download)) { unsigned++; continue; }
		const keyId = here(files.publicKey) ? new URL(files.publicKey).pathname.split('/').pop() : null;
		if (keyId) { named.set(keyId, (named.get(keyId) || 0) + 1); }
		candidates.push({ name: `${e.namespace}.${e.name} ${e.version}`, download: files.download, signature: files.signature, keyId });
	}
	const notPinned = [...named.keys()].filter((id) => !pinnedIds.includes(id));
	if (!candidates.length) {
		// Open VSX can also drop its signatures altogether. The editor requires one for every extension
		// from this gallery, so that is every install and update refused — as loud as a changed key.
		return { status: 'mismatch', lines: [
			`none of the ${listed.length} newest extensions on ${origin} is listed with a signature. LevelCode refuses an extension that has none ('NotSigned'), so no shipped build can install or update from it. See ${DOCS}.`
		] };
	}

	// What the files say. A package naming a key that is not pinned goes first: it is the one to confirm.
	candidates.sort((a, b) => Number(notPinned.includes(b.keyId)) - Number(notPinned.includes(a.keyId)));
	const results = [];
	const notFollowed = new Set();
	const scratch = fs.mkdtempSync(join(os.tmpdir(), 'levelcode-signature-registry-'));
	try {
		for (const c of candidates.slice(0, verifyUpTo * 4)) {
			if (results.length >= verifyUpTo) { break; }
			try {
				const pkg = await get(c.download);
				const vsix = pkg.ok ? await bodyWithin(pkg, maxPackageBytes) : null;
				if (!vsix) { continue; }
				const sig = await get(c.signature);
				const archive = sig.ok ? await bodyWithin(sig, 4 * 1024 * 1024) : null;
				if (!archive) { continue; }
				const a = join(scratch, `${results.length}.vsix`), b = join(scratch, `${results.length}.sigzip`);
				fs.writeFileSync(a, vsix); fs.writeFileSync(b, archive);
				results.push({ ...c, ...(await verify(a, b)) });
			} catch (e) {
				// One package that cannot be fetched is not news, and the next is tried. A redirect this
				// check would not follow is worth saying: it is how a registry that moved its files looks.
				if (e instanceof NotFollowed) { notFollowed.add(e.message); }
			}
		}
	} finally { fs.rmSync(scratch, { recursive: true, force: true }); }
	const verified = results.filter((r) => r.code === 'Success');
	const refused = results.filter((r) => r.code !== 'Success').map((r) => `${r.name}: ${r.code} (it names key ${r.keyId || 'none'})`);

	if (notPinned.length) {
		return { status: 'mismatch', lines: [
			...notPinned.map((id) => `${origin} is signing with a key this build does not trust: ${id}, named by ${named.get(id)} of its ${listed.length} newest extensions — ${origin}/api/-/public-key/${id}`),
			...refused.map((r) => `refused with the pinned keys: ${r}`),
			`pinned: ${pinnedIds.join(', ')}. Every shipped LevelCode will refuse what that key signs. What to do: ${DOCS} ("When Open VSX changes its key").`
		] };
	}
	const moved = notFollowed.size
		? `${[...notFollowed].join('; ')}. Files are fetched only from ${[origin, ...contentOrigins].join(' and ')}; if Open VSX has moved them, add the new host to CONTENT_ORIGINS in scripts/extension-signature.mjs once you know it is theirs (${DOCS})`
		: '';
	if (!results.length) { return unknown(`none of the ${candidates.length} newest signed extensions on ${origin} could be downloaded to verify${moved && ': ' + moved}`); }
	if (!verified.length) {
		return { status: 'mismatch', lines: [
			`${origin} names a pinned key, but none of the ${results.length} packages checked verifies with it:`,
			...refused.map((r) => `  ${r}`),
			`The way Open VSX signs may have changed. See ${DOCS}.`
		] };
	}
	const lines = [`${origin} signs with a pinned key: ${verified.length} of its newest packages verified (${verified.map((r) => r.name).join(', ')}); ${[...named].map(([id, n]) => `${n} of ${listed.length} name ${id}`).join(', ')}`];
	for (const r of refused) { lines.push(`warning — one package did not verify, though the registry as a whole does: ${r}`); }
	if (moved) { lines.push(`warning — a download was not followed: ${moved}`); }
	for (const id of pinnedIds.filter((id) => !named.has(id))) { lines.push(`note — pinned key ${id} is named by none of the ${listed.length} newest extensions. If Open VSX has left it for good, stop trusting it: ${DOCS}.`); }
	if (unsigned) { lines.push(`note — ${unsigned} of the ${listed.length} newest extensions are listed without a signature on the registry itself; LevelCode refuses those ('NotSigned').`); }
	return { status: 'ok', lines };
}

// ---- command line ------------------------------------------------------------------------------

const USAGE = `usage: node scripts/extension-signature.mjs install <app-code-folder> [--replace]
       node scripts/extension-signature.mjs check <app-code-folder>
       node scripts/extension-signature.mjs smoke <LevelCode.app> [--strict]
       node scripts/extension-signature.mjs registry [--strict]`;

async function main(argv) {
	const [command, ...rest] = argv;
	const flags = rest.filter((a) => a.startsWith('--'));
	const target = rest.find((a) => !a.startsWith('--'));
	const say = (line) => console.log('[extension-signature] ' + line);
	const fail = (line) => console.error('\x1b[31m[extension-signature] ' + line + '\x1b[0m');
	// On a CI runner nobody reads a green log: a warning has to be an annotation to be seen.
	const warn = (line) => console.log((process.env.GITHUB_ACTIONS ? '::warning::' : '') + '[extension-signature] WARNING: ' + line);

	if (command === 'install' && target) {
		const result = installModule(resolve(target), { replace: flags.includes('--replace') });
		say(result.kept ? `left as built: ${result.target} is LevelCode's verifier from another commit than this checkout (--replace would put this checkout's module and keys there)`
			: !result.changed ? `already in place: ${result.target}`
			: result.replaced === 'foreign' ? `replaced a module that was not LevelCode's: ${result.target}`
			: result.replaced ? `replaced another version of the verifier: ${result.target}`
			: `installed the Open VSX signature verifier: ${result.target}`);
		return 0;
	}
	if (command === 'check' && target) {
		const { problems, keys, askedBy } = installedModuleProblems(resolve(target));
		if (!problems.length) {
			say(`the app verifies Open VSX signatures: loaded as ${MODULE_NAME} by ${askedBy.join(' and ')}; a real package accepted, a changed one refused`);
			say(`trusted signing keys: ${keys.join(', ')}`);
			return 0;
		}
		fail(`${target} cannot verify extension signatures:`);
		for (const p of problems) { console.error('  - ' + p); }
		return 1;
	}
	if (command === 'smoke' && target) {
		const { verdict, why } = smokeTest({ app: resolve(target) });
		if (verdict === 'pass') { say(why); return 0; }
		if (verdict === 'fail') { fail(why); return 1; }
		warn(`could not tell whether the app installs extensions — ${why}`);
		return flags.includes('--strict') ? 2 : 0;
	}
	if (command === 'registry') {
		const { status, lines } = await checkRegistry();
		if (status === 'ok') { for (const l of lines) { say(l); } return 0; }
		if (status === 'mismatch') { for (const l of lines) { fail(l); } return 1; }
		for (const l of lines) { warn(l); }
		return flags.includes('--strict') ? 2 : 0;
	}
	console.error(USAGE);
	return 2;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main(process.argv.slice(2)).then(
		(code) => { process.exitCode = code; },
		(e) => { console.error('\x1b[31m[extension-signature] ' + reason(e) + '\x1b[0m'); process.exitCode = 1; });
}
