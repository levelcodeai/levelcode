/*---------------------------------------------------------------------------------------------
 *  Extension signature verification — run: node modules/extension-signature/test/extensionSignature.test.js
 *
 *  A LevelCode built from the open source could not verify an extension: the editor loads a module
 *  only Microsoft's products may ship, found none, and refused every signed extension from Open VSX
 *  ("Signature verification was not executed"). modules/extension-signature is LevelCode's module
 *  for that slot, and scripts/extension-signature.mjs puts it into a built app. Pinned here:
 *
 *    - a package verifies if, and only if, a key this build trusts signed exactly those bytes
 *    - every other outcome is a refusal the editor has a code for — never an exception
 *    - the signature archive is untrusted input: truncated, altered, oversized, or built to
 *      surprise a zip reader, it is refused; nothing inflates past what it declares
 *    - the keys are the ones that ship, for the gallery the product points at, and nothing is fetched
 *    - real packages, as Open VSX serves them, verify with the shipped key — and not when changed
 *    - the build step installs exactly the module, and `check` fails for each way a built app
 *      could end up unable to verify: no module, another module, a module the editor would not
 *      find or could not call, or an editor that no longer asks for it
 *    - `smoke` reads the app's own words, and `registry` tells a changed signing key (evidence)
 *      from a registry that could not be asked (not evidence)
 *
 *  Keys are generated here and archives are written by hand, so each lie an archive can tell is
 *  told on purpose. The two real packages are in fixtures/. The network is refused: the registry
 *  and the app are stand-ins, and what the script DOES with their answers is what is pinned.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { spawnSync } = require('child_process');
const { pathToFileURL } = require('url');

const MODULE_DIR = path.join(__dirname, '..');
const REPO = path.join(MODULE_DIR, '..', '..');
const SCRIPT = path.join(REPO, 'scripts', 'extension-signature.mjs');
const FIXTURES = path.join(__dirname, 'fixtures');
const read = (/** @type {string[]} */ ...p) => fs.readFileSync(path.join(REPO, ...p), 'utf8');

globalThis.fetch = () => { throw new Error('this suite must not use the network'); };

const signing = require(MODULE_DIR);
const Code = signing.ExtensionSignatureVerificationCode;

/** ExtensionSignatureVerificationCode as the editor declares it (Code-OSS 1.126,
 *  src/vs/platform/extensionManagement/common/extensionManagement.ts). A result outside this list
 *  is one the editor has no words for. */
const EDITOR_CODES = ['NotSigned', 'Success', 'RequiredArgumentMissing', 'InvalidArgument', 'PackageIsUnreadable',
	'UnhandledException', 'SignatureManifestIsMissing', 'SignatureManifestIsUnreadable', 'SignatureIsMissing',
	'SignatureIsUnreadable', 'CertificateIsUnreadable', 'SignatureArchiveIsUnreadable', 'FileAlreadyExists',
	'SignatureArchiveIsInvalidZip', 'SignatureArchiveHasSameSignatureFile', 'PackageIntegrityCheckFailed',
	'SignatureIsInvalid', 'SignatureManifestIsInvalid', 'SignatureIntegrityCheckFailed', 'EntryIsMissing',
	'EntryIsTampered', 'Untrusted', 'CertificateRevoked', 'SignatureIsNotValid', 'UnknownError', 'PackageIsInvalidZip',
	'SignatureArchiveHasTooManyEntries'];
const REFUSALS = Object.values(Code).filter((c) => c !== Code.Success);

let n = 0;
/** @param {string} name @param {() => any} fn */
async function test(name, fn) { await fn(); n++; console.log('  ok - ' + name); }

// ── scratch space ───────────────────────────────────────────────────────────────────────────
const made = [];
function tmp() { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'levelcode-signature-')); made.push(d); return d; }
const scratch = tmp();
let seq = 0;
/** @param {Buffer|string} bytes @param {string} ext */
function file(bytes, ext) { const p = path.join(scratch, (seq++) + ext); fs.writeFileSync(p, bytes); return p; }
/** Put a package and an archive on disk and ask `verify` about them, as the editor does: by path. */
const ask = (verify, vsix, archive) => verify(file(vsix, '.vsix'), file(archive, '.sigzip'), false);
const listing = (dir) => fs.readdirSync(dir).sort();

// ── a registry of our own ───────────────────────────────────────────────────────────────────
/** A signing key, and the form of it a verifier is told to trust. */
function signer(id) {
	const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
	return { id, privateKey, trusted: { id, publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64') } };
}
const sign = (bytes, by) => crypto.sign(null, bytes, by.privateKey);
const manifestOf = (vsix) => Buffer.from(JSON.stringify({
	package: { size: vsix.length, digests: { sha256: crypto.createHash('sha256').update(vsix).digest('base64') } },
	entries: {}
}));

const CRC_TABLE = Array.from({ length: 256 }, (_, i) => { let c = i; for (let k = 0; k < 8; k++) { c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; } return c >>> 0; });
const crc32 = (bytes) => { let c = 0xffffffff; for (const b of bytes) { c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8); } return (c ^ 0xffffffff) >>> 0; };

/**
 * A zip archive, written by hand so that an entry can be made to lie: `raw` is what is stored in
 * place of the deflated data, `size` / `compressedSize` what the directory claims, `localHeader`
 * where it says the entry starts. `localExtra` / `centralExtra` / `entryComment` are the optional
 * fields a real archive may carry. `eocd` edits the end-of-central-directory record.
 * @param {{name: string, data: Buffer, method?: number, raw?: Buffer, size?: number, compressedSize?: number, flags?: number, localHeader?: number, localSignature?: number, centralSignature?: number, localExtra?: Buffer, centralExtra?: Buffer, entryComment?: Buffer}[]} entries
 * @param {{eocd?: (record: Buffer, archiveLength: number) => void, comment?: Buffer}} [options]
 */
function zip(entries, { eocd, comment = Buffer.alloc(0) } = {}) {
	const locals = [], centrals = [];
	let offset = 0;
	for (const e of entries) {
		const name = Buffer.from(e.name, 'utf8');
		const method = e.method === undefined ? 8 : e.method;
		const stored = e.raw || (method === 8 ? zlib.deflateRawSync(e.data) : e.data);
		const size = e.size === undefined ? e.data.length : e.size;
		const compressedSize = e.compressedSize === undefined ? stored.length : e.compressedSize;
		const localExtra = e.localExtra || Buffer.alloc(0), centralExtra = e.centralExtra || Buffer.alloc(0), entryComment = e.entryComment || Buffer.alloc(0);
		const local = Buffer.alloc(30);
		local.writeUInt32LE(e.localSignature === undefined ? 0x04034b50 : e.localSignature, 0);
		local.writeUInt16LE(20, 4); local.writeUInt16LE(e.flags || 0, 6); local.writeUInt16LE(method, 8);
		local.writeUInt32LE(crc32(e.data), 14); local.writeUInt32LE(compressedSize, 18); local.writeUInt32LE(size, 22);
		local.writeUInt16LE(name.length, 26); local.writeUInt16LE(localExtra.length, 28);
		const central = Buffer.alloc(46);
		central.writeUInt32LE(e.centralSignature === undefined ? 0x02014b50 : e.centralSignature, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
		central.writeUInt16LE(e.flags || 0, 8); central.writeUInt16LE(method, 10);
		central.writeUInt32LE(crc32(e.data), 16); central.writeUInt32LE(compressedSize, 20); central.writeUInt32LE(size, 24);
		central.writeUInt16LE(name.length, 28); central.writeUInt16LE(centralExtra.length, 30); central.writeUInt16LE(entryComment.length, 32);
		central.writeUInt32LE(e.localHeader === undefined ? offset : e.localHeader, 42);
		locals.push(local, name, localExtra, stored); centrals.push(central, name, centralExtra, entryComment);
		offset += 30 + name.length + localExtra.length + stored.length;
	}
	const directory = Buffer.concat(centrals);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
	end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16); end.writeUInt16LE(comment.length, 20);
	if (eocd) { eocd(end, offset + directory.length + 22 + comment.length); }
	return Buffer.concat([...locals, directory, end, comment]);
}

/**
 * A signature archive as Open VSX lays it out: the manifest, the empty slot Microsoft's format
 * uses, and the signature.
 * @param {Buffer} vsix @param {ReturnType<typeof signer>} by
 * @param {{manifest?: Buffer|null, method?: number, signature?: Buffer}} [options]
 */
function archiveFor(vsix, by, { manifest = manifestOf(vsix), method = 8, signature = sign(vsix, by) } = {}) {
	const entries = [];
	if (manifest) { entries.push({ name: '.signature.manifest', data: manifest, method }); }
	entries.push({ name: '.signature.p7s', data: Buffer.alloc(0), method: 0 });
	entries.push({ name: '.signature.sig', data: signature, method });
	return zip(entries);
}

// ── a built app, as far as this step can tell ───────────────────────────────────────────────
/** The editor's code names the module in two bundles and imports it by that name; so do these. */
const ASKS = 'const mod = "@vscode/vsce-sign";\nexport const load = () => import(mod);\n';
function builtApp({ asks = true } = {}) {
	const app = path.join(tmp(), 'app');
	fs.mkdirSync(path.join(app, 'node_modules', '@vscode'), { recursive: true });
	for (const [folder, name] of [[['vs', 'code', 'electron-utility', 'sharedProcess'], 'sharedProcessMain.js'], [['vs', 'code', 'node'], 'cliProcessMain.js']]) {
		const dir = path.join(app, 'out', ...folder);
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, name), asks ? ASKS : 'export const load = () => null;\n');
	}
	fs.writeFileSync(path.join(app, 'out', 'main.js'), 'export {};\n');
	return app;
}
const ASKERS = ['out/vs/code/electron-utility/sharedProcess/sharedProcessMain.js', 'out/vs/code/node/cliProcessMain.js'];

// ── a registry that answers what it is told to ──────────────────────────────────────────────
const REGISTRY = 'https://registry.test';
/**
 * A stand-in for the network: the search listing, and each extension's two files. An extension
 * may claim a length it does not have (`claims`), be listed with a package or a signature that
 * is not there to download (`missing`, `missingSignature`), live somewhere else (`origin`), or
 * name a key.
 */
function registry(extensions, { listingStatus = 200, listingBody } = {}) {
	const requested = [];
	const files = new Map();
	const listed = extensions.map((e, i) => {
		const id = `ext${i}`;
		const base = `${e.origin || REGISTRY}/api/ns/${id}/1.0.0/file/ns.${id}-1.0.0`;
		if (!e.missing) { files.set(base + '.vsix', { bytes: e.vsix, claims: e.claims }); }
		if (e.archive && !e.missingSignature) { files.set(base + '.sigzip', { bytes: e.archive }); }
		return {
			namespace: 'ns', name: id, version: '1.0.0',
			files: { download: base + '.vsix', ...(e.archive ? { signature: base + '.sigzip' } : {}), ...(e.key ? { publicKey: `${REGISTRY}/api/-/public-key/${e.key}` } : {}) }
		};
	});
	const fetch = async (url) => {
		url = String(url);
		requested.push(url);
		if (url.startsWith(REGISTRY + '/api/-/search')) {
			return new Response(listingBody === undefined ? JSON.stringify({ extensions: listed }) : listingBody, { status: listingStatus });
		}
		const found = files.get(url);
		if (!found) { return new Response('not found', { status: 404 }); }
		return new Response(found.bytes, { status: 200, headers: { 'content-length': String(found.claims || found.bytes.length) } });
	};
	return { fetch, requested };
}
/** A copy of the module that pins `keys` — what `registry` is run against in place of the shipped one. */
function moduleTrusting(keys) {
	const dir = path.join(tmp(), 'module');
	fs.mkdirSync(dir);
	for (const f of ['index.js', 'package.json']) { fs.copyFileSync(path.join(MODULE_DIR, f), path.join(dir, f)); }
	fs.writeFileSync(path.join(dir, 'keys.json'), JSON.stringify({ keys }));
	return dir;
}

(async () => {
	const build = await import(pathToFileURL(SCRIPT).href);

	const openVsx = signer('the-registry');
	const other = signer('someone-else');
	const verify = signing.createVerifier([openVsx.trusted]);
	/** Any bytes will do for a package: the signature is over the file, whatever is in it. */
	const pkg = crypto.randomBytes(257);

	// ── what verifies ───────────────────────────────────────────────────────────────────────
	await test('a package signed by a trusted key verifies — entries stored, or deflated as Open VSX writes them', async () => {
		for (const method of [0, 8]) {
			const r = await ask(verify, pkg, archiveFor(pkg, openVsx, { method }));
			assert.strictEqual(r.code, Code.Success, 'method ' + method + ': ' + r.output);
		}
		const empty = Buffer.alloc(0);
		assert.strictEqual((await ask(verify, empty, archiveFor(empty, openVsx))).code, Code.Success, 'even an empty file, if that is what was signed');
	});

	await test('any one of the trusted keys is enough, and the answer names the key that signed', async () => {
		const both = signing.createVerifier([other.trusted, openVsx.trusted]);
		const a = await ask(both, pkg, archiveFor(pkg, openVsx));
		const b = await ask(both, pkg, archiveFor(pkg, other));
		assert.strictEqual(a.code, Code.Success); assert.match(a.output, /the-registry/);
		assert.strictEqual(b.code, Code.Success); assert.match(b.output, /someone-else/);
	});

	await test('the answer is the one the editor reads: a code it knows, didExecute, some words', async () => {
		for (const archive of [archiveFor(pkg, openVsx), archiveFor(pkg, other), Buffer.from('not a zip')]) {
			const r = await ask(verify, pkg, archive);
			assert.deepStrictEqual(Object.keys(r).sort(), ['code', 'didExecute', 'output']);
			assert.ok(EDITOR_CODES.includes(r.code), r.code);
			assert.strictEqual(r.didExecute, true, 'the check ran — "not executed" is what a missing module means');
			assert.ok(r.output.length > 0);
		}
		for (const [name, code] of Object.entries(Code)) {
			assert.strictEqual(name, code);
			assert.ok(EDITOR_CODES.includes(code), code + ' is not a code the editor knows');
		}
	});

	// ── what does not ───────────────────────────────────────────────────────────────────────
	await test('one changed byte, anywhere in the package, is refused', async () => {
		const archive = file(archiveFor(pkg, openVsx), '.sigzip');
		const changedPath = path.join(scratch, 'changed.vsix');
		for (let i = 0; i < pkg.length; i++) {
			const changed = Buffer.from(pkg);
			changed[i] ^= 0x01;
			fs.writeFileSync(changedPath, changed);
			assert.strictEqual((await verify(changedPath, archive, false)).code, Code.PackageIntegrityCheckFailed, 'byte ' + i);
		}
	});

	await test('a package that grew, shrank or emptied is refused', async () => {
		const archive = archiveFor(pkg, openVsx);
		for (const changed of [Buffer.concat([pkg, Buffer.from([0])]), pkg.subarray(0, pkg.length - 1), Buffer.alloc(0)]) {
			assert.strictEqual((await ask(verify, changed, archive)).code, Code.PackageIntegrityCheckFailed, changed.length + ' bytes');
		}
	});

	await test('a signature by a key that is not trusted is Untrusted — the package is whole, the key is not ours', async () => {
		const r = await ask(verify, pkg, archiveFor(pkg, other));
		assert.strictEqual(r.code, Code.Untrusted);
		assert.match(r.output, /the-registry/, 'and the answer says which keys were tried');
	});

	await test('rewriting the manifest to match a changed package buys nothing', async () => {
		const changed = Buffer.concat([pkg, Buffer.from('something added')]);
		const r = await ask(verify, changed, archiveFor(changed, openVsx, { signature: sign(pkg, openVsx) }));
		assert.strictEqual(r.code, Code.Untrusted, 'the manifest only words the refusal; it never lifts it');
	});

	await test('with no manifest to ask, a signature that does not verify is simply invalid', async () => {
		const sig = sign(pkg, other);
		const withManifest = (...manifests) => zip([...manifests.map((data) => ({ name: '.signature.manifest', data })), { name: '.signature.sig', data: sig }]);
		const cases = {
			'no manifest': withManifest(),
			'not JSON': withManifest(Buffer.from('{ not json')),
			'JSON that says nothing of the package': withManifest(Buffer.from('{"entries":{}}')),
			'a package entry with no digest': withManifest(Buffer.from(JSON.stringify({ package: { size: pkg.length } }))),
			'a digest that is not text': withManifest(Buffer.from(JSON.stringify({ package: { size: pkg.length, digests: { sha256: 42 } } }))),
			'null': withManifest(Buffer.from('null')),
			'two manifests': withManifest(manifestOf(pkg), manifestOf(pkg))
		};
		for (const [what, archive] of Object.entries(cases)) {
			assert.strictEqual((await ask(verify, pkg, archive)).code, Code.SignatureIsInvalid, what);
		}
	});

	await test('a signature for one package does not carry to another', async () => {
		const another = crypto.randomBytes(257);
		assert.strictEqual((await ask(verify, another, archiveFor(pkg, openVsx))).code, Code.PackageIntegrityCheckFailed);
		assert.strictEqual((await ask(verify, another, archiveFor(another, openVsx, { signature: sign(pkg, openVsx) }))).code, Code.Untrusted);
	});

	await test('every byte of the signature counts', async () => {
		const sig = sign(pkg, openVsx);
		for (let i = 0; i < sig.length; i++) {
			const changed = Buffer.from(sig);
			changed[i] ^= 0x01;
			assert.notStrictEqual((await ask(verify, pkg, archiveFor(pkg, openVsx, { signature: changed }))).code, Code.Success, 'byte ' + i);
		}
	});

	// ── the archive is untrusted input ──────────────────────────────────────────────────────
	await test('a signature that is not 64 bytes is not read', async () => {
		for (const length of [0, 1, 63, 65, 128, 70000]) {
			const r = await ask(verify, pkg, archiveFor(pkg, openVsx, { signature: Buffer.alloc(length, 7) }));
			assert.strictEqual(r.code, Code.SignatureIsUnreadable, length + ' bytes');
		}
	});

	await test('the signature is the entry named .signature.sig — exactly that, and once', async () => {
		const sig = sign(pkg, openVsx);
		for (const name of ['.SIGNATURE.SIG', './.signature.sig', '.signature.sig/', 'a/.signature.sig', '.signature.sig\0', ' .signature.sig', '.signature.p7s']) {
			assert.strictEqual((await ask(verify, pkg, zip([{ name, data: sig }]))).code, Code.SignatureIsMissing, JSON.stringify(name));
		}
		assert.strictEqual((await ask(verify, pkg, zip([]))).code, Code.SignatureIsMissing, 'an archive of nothing');
		const twice = zip([{ name: '.signature.sig', data: sign(pkg, other) }, { name: '.signature.sig', data: sig }]);
		assert.strictEqual((await ask(verify, pkg, twice)).code, Code.SignatureArchiveHasSameSignatureFile, 'two, one of them good');
	});

	await test('extra fields and comments are stepped over, each by the count in its own header', async () => {
		// The two headers of one entry each carry an extra field, and need not agree on its length.
		const sig = sign(pkg, openVsx);
		const dressed = zip([
			{ name: '.signature.manifest', data: manifestOf(pkg), localExtra: Buffer.alloc(9, 1), centralExtra: Buffer.alloc(31, 2), entryComment: Buffer.from('a comment') },
			{ name: '.signature.sig', data: sig, localExtra: Buffer.alloc(40, 3), centralExtra: Buffer.alloc(4, 4), entryComment: Buffer.from('another') },
			{ name: '.signature.p7s', data: Buffer.alloc(0), method: 0, centralExtra: Buffer.alloc(12, 5) }
		]);
		assert.strictEqual((await ask(verify, pkg, dressed)).code, Code.Success);
		assert.strictEqual((await ask(verify, Buffer.concat([pkg, pkg]), dressed)).code, Code.PackageIntegrityCheckFailed, 'and the manifest behind them is found too');
	});

	await test('an archive with more entries than a signature archive has is refused', async () => {
		const sig = { name: '.signature.sig', data: sign(pkg, openVsx) };
		const filler = Array.from({ length: 8 }, (_, i) => ({ name: 'file' + i, data: Buffer.from('x') }));
		assert.strictEqual((await ask(verify, pkg, zip([...filler.slice(0, 7), sig]))).code, Code.Success, 'eight entries are still read');
		assert.strictEqual((await ask(verify, pkg, zip([...filler, sig]))).code, Code.SignatureArchiveHasTooManyEntries, 'nine are not');
	});

	await test('a signature entry cannot inflate past the 64 bytes it declares, nor to fewer', async () => {
		const bomb = zlib.deflateRawSync(Buffer.alloc(8 * 1024 * 1024));
		const claiming64 = (raw) => zip([{ name: '.signature.sig', data: Buffer.alloc(64), raw, size: 64 }]);
		const exploded = await ask(verify, pkg, claiming64(bomb));
		assert.strictEqual(exploded.code, Code.SignatureArchiveIsInvalidZip);
		// The verdict is the same whether inflating was capped or merely measured afterwards. The words
		// are not: this is the cap refusing to produce the bytes at all.
		assert.match(exploded.output, /does not inflate/, exploded.output);
		assert.strictEqual((await ask(verify, pkg, claiming64(zlib.deflateRawSync(Buffer.alloc(10))))).code, Code.SignatureArchiveIsInvalidZip, 'ten bytes, declared as 64');
		assert.strictEqual((await ask(verify, pkg, claiming64(Buffer.from('not deflate at all')))).code, Code.SignatureArchiveIsInvalidZip, 'not deflate');
	});

	await test('a manifest that cannot be read — or would inflate without end — decides nothing', async () => {
		const bomb = zlib.deflateRawSync(Buffer.alloc(32 * 1024 * 1024));
		for (const size of [100, 0x7fffffff]) {
			const withBomb = (signature) => zip([{ name: '.signature.manifest', data: Buffer.alloc(0), raw: bomb, size }, { name: '.signature.sig', data: signature, method: 0 }]);
			assert.strictEqual((await ask(verify, pkg, withBomb(sign(pkg, openVsx)))).code, Code.Success, 'a good signature is good whatever the manifest is');
			assert.strictEqual((await ask(verify, pkg, withBomb(sign(pkg, other)))).code, Code.SignatureIsInvalid, 'and a bad one is not explained by it');
		}
	});

	await test('a manifest larger than the reader will inflate is not consulted', async () => {
		// A true manifest for the package, padded past the cap. Consulted, it would say the package is
		// whole and the refusal would read Untrusted; it is not consulted.
		const padded = Buffer.concat([manifestOf(pkg), Buffer.alloc(64 * 1024 * 1024, ' ')]);
		const oversized = zip([{ name: '.signature.manifest', data: padded }, { name: '.signature.sig', data: sign(pkg, other) }]);
		assert.strictEqual((await ask(verify, pkg, oversized)).code, Code.SignatureIsInvalid);
		const underTheCap = zip([{ name: '.signature.manifest', data: Buffer.concat([manifestOf(pkg), Buffer.alloc(1024, ' ')]) }, { name: '.signature.sig', data: sign(pkg, other) }]);
		assert.strictEqual((await ask(verify, pkg, underTheCap)).code, Code.Untrusted, 'the same manifest, small enough to read');
	});

	await test('encrypted, zip64 and multi-disk archives are refused, not handled', async () => {
		const sig = { name: '.signature.sig', data: sign(pkg, openVsx) };
		const cases = {
			'an encrypted entry': zip([{ ...sig, flags: 1 }]),
			'a second disk': zip([sig], { eocd: (e) => e.writeUInt16LE(1, 4) }),
			'a directory on another disk': zip([sig], { eocd: (e) => e.writeUInt16LE(1, 6) }),
			'entries split across disks': zip([sig], { eocd: (e) => e.writeUInt16LE(2, 10) }),
			'a zip64 entry count': zip([sig], { eocd: (e) => { e.writeUInt16LE(0xffff, 8); e.writeUInt16LE(0xffff, 10); } }),
			'a zip64 directory offset': zip([sig], { eocd: (e) => e.writeUInt32LE(0xffffffff, 16) }),
			'a zip64 directory size': zip([sig], { eocd: (e) => e.writeUInt32LE(0xffffffff, 12) }),
			'a zip64 entry': zip([{ ...sig, compressedSize: 0xffffffff }]),
			'a zip64 entry offset': zip([{ ...sig, localHeader: 0xffffffff }])
		};
		assert.strictEqual((await ask(verify, pkg, zip([{ ...sig, size: 0xffffffff }]))).code, Code.SignatureIsUnreadable, 'a zip64 size is just a size that is not 64');
		for (const [what, archive] of Object.entries(cases)) {
			assert.strictEqual((await ask(verify, pkg, archive)).code, Code.SignatureArchiveIsInvalidZip, what);
		}
	});

	await test('an entry that points outside the archive, or is packed some other way, is refused', async () => {
		const sig = { name: '.signature.sig', data: sign(pkg, openVsx) };
		const cases = {
			'a local header past the end': zip([{ ...sig, localHeader: 0x7fffffff }]),
			'a local header that is not one': zip([{ ...sig, localSignature: 0x04034b51 }]),
			'more compressed bytes than the archive holds': zip([{ ...sig, compressedSize: 100000 }]),
			'a directory that starts inside the end record': zip([sig], { eocd: (e, length) => e.writeUInt32LE(length - 10, 16) }),
			'a directory longer than the archive': zip([sig], { eocd: (e) => e.writeUInt32LE(0x7fffffff, 12) }),
			'a directory too short for an entry': zip([sig], { eocd: (e) => e.writeUInt32LE(20, 12) }),
			// 46 bytes of entry fit in 50; its 14-byte name does not.
			'a directory too short for an entry\'s name': zip([sig], { eocd: (e) => e.writeUInt32LE(50, 12) }),
			'a directory entry that is not one': zip([{ ...sig, centralSignature: 0x02014b51 }]),
			'stored, with two different sizes': zip([{ ...sig, method: 0, compressedSize: 60 }]),
			// The bytes ARE the signature, deflated: a reader that inflated whatever it was given would
			// find a good signature here. The entry says bzip2, and this reader does not read bzip2.
			'bzip2': zip([{ ...sig, method: 12, raw: zlib.deflateRawSync(sig.data) }]),
			'deflate64': zip([{ ...sig, method: 9, raw: zlib.deflateRawSync(sig.data) }]),
			'zstd': zip([{ ...sig, method: 93, raw: sig.data }])
		};
		for (const [what, archive] of Object.entries(cases)) {
			assert.strictEqual((await ask(verify, pkg, archive)).code, Code.SignatureArchiveIsInvalidZip, what);
		}
	});

	await test('the end of the archive is where its last record says it is — not a record left in a comment', async () => {
		const good = archiveFor(pkg, openVsx);
		const decoy = archiveFor(pkg, other);
		// A whole second archive in the comment: its own end record does not run to the end of the file.
		const commented = zip([{ name: '.signature.sig', data: sign(pkg, openVsx) }], { comment: Buffer.concat([decoy, Buffer.from('tail')]) });
		assert.strictEqual((await ask(verify, pkg, commented)).code, Code.Success, 'the outer archive is the one that is read');
		assert.strictEqual((await ask(verify, pkg, Buffer.concat([good, Buffer.from('junk after the end')]))).code, Code.SignatureArchiveIsInvalidZip, 'bytes after the end are not ignored');
		assert.strictEqual((await ask(verify, pkg, Buffer.concat([Buffer.from('junk before the start'), good]))).code, Code.SignatureArchiveIsInvalidZip, 'nor is an archive that has been shifted');
	});

	await test('no part of an archive is accepted for the whole, and no changed byte stops the reader', async () => {
		const real = path.join(FIXTURES, 'perrinjerome.git-rebase-syntax-0.0.1');
		const storedArchive = archiveFor(pkg, openVsx, { method: 0 });
		const signatureAt = storedArchive.indexOf(sign(pkg, openVsx));
		assert.ok(signatureAt > 0, 'the stored signature is in the archive as it is');
		const subjects = [
			{ verify, vsix: file(pkg, '.vsix'), archive: storedArchive, signatureAt },
			{ verify: signing.verify, vsix: real + '.vsix', archive: fs.readFileSync(real + '.sigzip'), signatureAt: -1 }
		];
		const at = path.join(scratch, 'sweep.sigzip');
		for (const s of subjects) {
			for (let length = 0; length < s.archive.length; length++) {
				fs.writeFileSync(at, s.archive.subarray(0, length));
				const r = await s.verify(s.vsix, at, false);
				assert.ok(REFUSALS.includes(r.code), `the first ${length} bytes: ${r.code}`);
			}
			// Most bytes of an archive carry nothing the verdict rests on — checksums, dates, the manifest,
			// the empty slot — and changing one of those rightly changes nothing. What is pinned is that
			// the reader always answers, and that no byte of the signature is among the ones that do not matter.
			for (let i = 0; i < s.archive.length; i++) {
				const changed = Buffer.from(s.archive);
				changed[i] ^= 0xff;
				fs.writeFileSync(at, changed);
				const r = await s.verify(s.vsix, at, false);
				assert.ok(Object.values(Code).includes(r.code), `byte ${i}: ${r.code}`);
				if (i >= s.signatureAt && i < s.signatureAt + 64 && s.signatureAt >= 0) { assert.notStrictEqual(r.code, Code.Success, `signature byte ${i - s.signatureAt}`); }
			}
		}
	});

	await test('what is not an archive is refused as one', async () => {
		const cases = {
			'nothing': Buffer.alloc(0),
			'too short to be one': Buffer.alloc(21),
			'zeros': Buffer.alloc(4096),
			'noise': crypto.randomBytes(4096),
			'text': Buffer.from('<html>502 Bad Gateway</html>'),
			'the package itself': fs.readFileSync(path.join(FIXTURES, 'perrinjerome.git-rebase-syntax-0.0.1.vsix'))
		};
		for (const [what, archive] of Object.entries(cases)) {
			assert.ok(REFUSALS.includes((await ask(verify, pkg, archive)).code), what);
		}
	});

	await test('a file that cannot be read is an answer, not an exception', async () => {
		const archive = file(archiveFor(pkg, openVsx), '.sigzip'), vsix = file(pkg, '.vsix');
		const missing = path.join(scratch, 'no-such-file');
		assert.strictEqual((await verify(vsix, missing, false)).code, Code.SignatureArchiveIsUnreadable);
		assert.strictEqual((await verify(vsix, scratch, false)).code, Code.SignatureArchiveIsUnreadable, 'a folder');
		assert.strictEqual((await verify(missing, archive, false)).code, Code.PackageIsUnreadable);
		assert.strictEqual((await verify(scratch, archive, false)).code, Code.PackageIsUnreadable, 'a folder');
		for (const args of [[], [undefined, undefined], [null, archive], [vsix, 42], [{}, {}]]) {
			const r = await verify(...args);
			assert.ok(REFUSALS.includes(r.code), JSON.stringify(args) + ' → ' + r.code);
		}
	});

	await test('an archive larger than the reader will take is refused unread', async () => {
		const big = path.join(scratch, 'big.sigzip');
		fs.writeFileSync(big, '');
		fs.truncateSync(big, 64 * 1024 * 1024 + 1);
		const r = await verify(file(pkg, '.vsix'), big, false);
		assert.strictEqual(r.code, Code.SignatureArchiveIsUnreadable);
		assert.match(r.output, /at most/);
		fs.rmSync(big);
	});

	// ── the keys ────────────────────────────────────────────────────────────────────────────
	await test('a verifier is not built without keys, or with a key that is not Ed25519', () => {
		const spki = (type, options) => crypto.generateKeyPairSync(type, options).publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
		assert.throws(() => signing.createVerifier([]), /no trusted signing keys/);
		assert.throws(() => signing.createVerifier(undefined), /no trusted signing keys/);
		assert.throws(() => signing.createVerifier([{ id: 'rsa', publicKey: spki('rsa', { modulusLength: 2048 }) }]), /rsa, not ed25519/);
		assert.throws(() => signing.createVerifier([{ id: 'p256', publicKey: spki('ec', { namedCurve: 'P-256' }) }]), /ec, not ed25519/);
		assert.throws(() => signing.createVerifier([{ id: 'x25519', publicKey: spki('x25519') }]), /x25519, not ed25519/);
		assert.throws(() => signing.createVerifier([{ id: 'junk', publicKey: 'AAAA' }]));
		assert.throws(() => signing.createVerifier([{ publicKey: openVsx.trusted.publicKey }]), /id and a publicKey/);
		assert.throws(() => signing.createVerifier([openVsx.trusted, null]), /id and a publicKey/);
	});

	await test('the keys that ship are for the gallery the product points the editor at', () => {
		const { keys } = JSON.parse(read('modules', 'extension-signature', 'keys.json'));
		const gallery = new URL(JSON.parse(read('branding', 'product.overlay.json')).extensionsGallery.serviceUrl).origin;
		assert.ok(keys.length >= 1, 'at least one');
		for (const k of keys) {
			assert.strictEqual(k.registry, gallery, `${k.id} is pinned for ${k.registry}, but the editor installs from ${gallery}`);
			assert.strictEqual(k.source, `${gallery}/api/-/public-key/${k.id}`);
			assert.match(k.pinned, /^\d{4}-\d{2}-\d{2}$/);
			assert.ok(k.evidence && k.evidence.length > 40, 'how the key was checked is written down');
			assert.strictEqual(Buffer.from(k.publicKey, 'base64').toString('base64'), k.publicKey, 'the key is canonical base64');
		}
		assert.strictEqual(new Set(keys.map((k) => k.id)).size, keys.length, 'no id twice');
		assert.strictEqual(new Set(keys.map((k) => k.publicKey)).size, keys.length, 'no key twice');
		signing.createVerifier(keys);
		assert.deepStrictEqual(signing.trustedKeyIds, keys.map((k) => k.id), 'and they are the ones the shipped verifier uses');
	});

	await test('nothing is fetched: the shipped verifier works with every socket refused', () => {
		const source = read('modules', 'extension-signature', 'index.js');
		const required = [...source.matchAll(/require\(([^)]*)\)/g)].map((m) => m[1].replace(/['"]/g, '')).sort();
		assert.deepStrictEqual(required, ['node:crypto', 'node:fs', 'node:path', 'node:zlib'], 'no module that could reach a network');

		const preload = file([
			'const net = require("net"), dns = require("dns");',
			'const refuse = () => { throw new Error("NETWORK USED"); };',
			'net.Socket.prototype.connect = refuse; dns.lookup = refuse; dns.promises.lookup = refuse; globalThis.fetch = refuse;'
		].join('\n'), '.cjs');
		const real = path.join(FIXTURES, 'perrinjerome.git-rebase-syntax-0.0.1');
		const run = spawnSync(process.execPath, ['-r', preload, '-e',
			`require(${JSON.stringify(MODULE_DIR)}).verify(${JSON.stringify(real + '.vsix')}, ${JSON.stringify(real + '.sigzip')}).then((r) => console.log(r.code))`], { encoding: 'utf8' });
		assert.strictEqual(run.stdout.trim(), Code.Success, run.stderr);
	});

	// ── real packages, as Open VSX serves them ──────────────────────────────────────────────
	const REAL = ['perrinjerome.git-rebase-syntax-0.0.1', 'coolbear.systemd-unit-file-1.0.6']
		.map((name) => ({ name, vsix: path.join(FIXTURES, name + '.vsix'), archive: path.join(FIXTURES, name + '.sigzip') }));

	await test('the fixtures are the files their README says were downloaded', () => {
		const readme = fs.readFileSync(path.join(FIXTURES, 'README.md'), 'utf8');
		const onDisk = listing(FIXTURES).filter((f) => f !== 'README.md');
		assert.deepStrictEqual(onDisk, REAL.flatMap((f) => [f.name + '.sigzip', f.name + '.vsix']).sort());
		for (const f of onDisk) {
			const sum = crypto.createHash('sha256').update(fs.readFileSync(path.join(FIXTURES, f))).digest('hex');
			assert.ok(readme.includes(`${sum}  ${f}`), `${f} is not the file the README lists (${sum})`);
		}
	});

	await test('the shipped verifier accepts real packages with the key that ships', async () => {
		for (const f of REAL) {
			const r = await signing.verify(f.vsix, f.archive, false);
			assert.strictEqual(r.code, Code.Success, `${f.name}: ${r.output} — if a pinned key was just dropped, the fixtures it signed go with it (fixtures/README.md)`);
			assert.ok(signing.trustedKeyIds.some((id) => r.output.includes(id)), r.output);
		}
	});

	await test('and refuses them changed by a byte, or with each other\'s signature', async () => {
		for (const f of REAL) {
			const bytes = fs.readFileSync(f.vsix);
			for (const i of [0, bytes.length >> 1, bytes.length - 1]) {
				const changed = Buffer.from(bytes);
				changed[i] ^= 0x01;
				assert.strictEqual((await signing.verify(file(changed, '.vsix'), f.archive, false)).code, Code.PackageIntegrityCheckFailed, `${f.name} byte ${i}`);
			}
		}
		assert.strictEqual((await signing.verify(REAL[0].vsix, REAL[1].archive, false)).code, Code.PackageIntegrityCheckFailed);
		assert.strictEqual((await signing.verify(REAL[1].vsix, REAL[0].archive, false)).code, Code.PackageIntegrityCheckFailed);
	});

	await test('a real signature is not accepted by a build that trusts another key', async () => {
		const elsewhere = signing.createVerifier([other.trusted]);
		for (const f of REAL) { assert.strictEqual((await elsewhere(f.vsix, f.archive, false)).code, Code.Untrusted, f.name); }
	});

	// ── the build step: scripts/extension-signature.mjs ─────────────────────────────────────
	const moduleFiles = () => Object.fromEntries(build.MODULE_FILES.map((f) => [f, fs.readFileSync(path.join(MODULE_DIR, f))]));

	await test('install puts the module, and only the module, where a built app looks for it', () => {
		const app = builtApp();
		// What a run stopped half-way would have left beside the module's place.
		const leftover = path.join(app, 'node_modules', '@vscode', 'vsce-sign.installing');
		fs.mkdirSync(leftover);
		fs.writeFileSync(path.join(leftover, 'index.js'), 'half a module');
		fs.writeFileSync(path.join(leftover, 'left-behind.js'), 'and a file the module does not have');
		const result = build.installModule(app);
		const target = path.join(app, 'node_modules', '@vscode', 'vsce-sign');
		assert.deepStrictEqual({ ...result, target: fs.realpathSync(result.target) }, { target: fs.realpathSync(target), changed: true, replaced: null, kept: false });
		assert.deepStrictEqual(listing(target), ['index.js', 'keys.json', 'package.json'], 'no tests, no fixtures');
		for (const [name, bytes] of Object.entries(moduleFiles())) { assert.ok(fs.readFileSync(path.join(target, name)).equals(bytes), name); }
		assert.deepStrictEqual(listing(path.join(app, 'node_modules', '@vscode')), ['vsce-sign'], 'nothing left beside it');
		assert.strictEqual(JSON.parse(fs.readFileSync(path.join(target, 'package.json'), 'utf8')).name, '@vscode/vsce-sign', 'under the name the editor imports');
	});

	await test('installing twice changes nothing', () => {
		const app = builtApp();
		build.installModule(app);
		const target = build.installedPath(app);
		const before = build.MODULE_FILES.map((f) => fs.statSync(path.join(target, f)).ino);
		assert.deepStrictEqual(build.installModule(app), { target, changed: false, replaced: null, kept: false });
		assert.deepStrictEqual(build.MODULE_FILES.map((f) => fs.statSync(path.join(target, f)).ino), before, 'the same files, not rewritten');
	});

	await test('a verifier from another commit is left as it was built — unless the build says replace', () => {
		const app = builtApp();
		build.installModule(app);
		const keys = path.join(build.installedPath(app), 'keys.json');
		const theirs = JSON.stringify({ keys: [other.trusted] });
		fs.writeFileSync(keys, theirs);

		assert.deepStrictEqual(build.installModule(app), { target: build.installedPath(app), changed: false, replaced: null, kept: true });
		assert.strictEqual(fs.readFileSync(keys, 'utf8'), theirs, 'the keys the app was built with are the keys it keeps');

		assert.deepStrictEqual(build.installModule(app, { replace: true }), { target: build.installedPath(app), changed: true, replaced: 'levelcode', kept: false });
		assert.ok(fs.readFileSync(keys).equals(moduleFiles()['keys.json']));
	});

	await test('a module of that name that is not LevelCode\'s never ships in the verifier\'s place', () => {
		const app = builtApp();
		const target = build.installedPath(app);
		fs.mkdirSync(path.join(target, 'bin'), { recursive: true });
		fs.writeFileSync(path.join(target, 'package.json'), JSON.stringify({ name: '@vscode/vsce-sign', version: '2.0.6', main: 'src/main.js' }));
		fs.writeFileSync(path.join(target, 'bin', 'vsce-sign'), 'a binary');

		assert.throws(() => build.installModule(app), /not LevelCode's.*--replace/s);
		assert.deepStrictEqual(listing(target), ['bin', 'package.json'], 'and refusing touched nothing');

		assert.strictEqual(build.installModule(app, { replace: true }).replaced, 'foreign');
		assert.deepStrictEqual(listing(target), ['index.js', 'keys.json', 'package.json'], 'nothing of the other module is left');

		// A file where the folder should be is not ours either.
		const second = builtApp();
		fs.writeFileSync(build.installedPath(second), 'not a folder');
		assert.throws(() => build.installModule(second), /not LevelCode's/);
		assert.strictEqual(build.installModule(second, { replace: true }).replaced, 'foreign');
	});

	await test('a folder that is not a built app, or a module that is not whole, changes nothing', () => {
		assert.throws(() => build.installModule(tmp()), /not a folder — expected a built app's code folder/);

		const app = builtApp();
		const partial = path.join(tmp(), 'module');
		fs.mkdirSync(partial);
		fs.copyFileSync(path.join(MODULE_DIR, 'index.js'), path.join(partial, 'index.js'));
		fs.copyFileSync(path.join(MODULE_DIR, 'package.json'), path.join(partial, 'package.json'));
		assert.throws(() => build.installModule(app, { source: partial }), /keys\.json/);
		assert.deepStrictEqual(listing(path.join(app, 'node_modules', '@vscode')), [], 'nothing was written, and nothing left half-written');
	});

	await test('check passes an app that will verify, and says who loads the module and which keys it trusts', () => {
		const app = builtApp();
		build.installModule(app);
		const { problems, keys, askedBy } = build.installedModuleProblems(app);
		assert.deepStrictEqual(problems, []);
		assert.deepStrictEqual(askedBy.map((f) => f.split(path.sep).join('/')), ASKERS);
		assert.deepStrictEqual(keys, signing.trustedKeyIds);
	});

	await test('check fails for each way a built app could end up unable to verify', () => {
		const installed = () => { const app = builtApp(); build.installModule(app); return app; };
		const at = (app, ...p) => path.join(build.installedPath(app), ...p);
		/** @type {Record<string, [() => string, RegExp]>} */
		const cases = {
			'no module': [() => builtApp(), /no verifier: .* is missing.*install/s],
			'an editor that no longer asks for the module': [() => { const app = builtApp({ asks: false }); build.installModule(app); return app; }, /no longer loads its verifier by that name/],
			'a module that is not LevelCode\'s': [() => { const app = installed(); fs.writeFileSync(at(app, 'package.json'), JSON.stringify({ name: '@vscode/vsce-sign', main: 'index.js' })); return app; }, /is not LevelCode's module/],
			'a file that is not part of the module': [() => { const app = installed(); fs.writeFileSync(at(app, 'postinstall.js'), ''); return app; }, /carries a file that is not part of it: postinstall\.js/],
			'a missing file': [() => { const app = installed(); fs.rmSync(at(app, 'keys.json')); return app; }, /the module is missing keys\.json/],
			'another module nearer to the code that asks': [() => {
				const app = installed();
				const decoy = path.join(app, 'out', 'node_modules', '@vscode', 'vsce-sign');
				fs.mkdirSync(decoy, { recursive: true });
				fs.writeFileSync(path.join(decoy, 'package.json'), JSON.stringify({ name: '@vscode/vsce-sign', main: 'index.js' }));
				fs.writeFileSync(path.join(decoy, 'index.js'), 'exports.verify = async () => ({ code: "Success", didExecute: true });\n');
				return app;
			}, /would load .*out.node_modules.* not .*vsce-sign.index\.js/],
			'keys that are not the registry\'s': [() => { const app = installed(); fs.writeFileSync(at(app, 'keys.json'), JSON.stringify({ keys: [other.trusted] })); return app; }, /does not accept a real Open VSX package: Untrusted.*someone-else/s],
			'no keys': [() => { const app = installed(); fs.writeFileSync(at(app, 'keys.json'), JSON.stringify({ keys: [] })); return app; }, /the module fails: .*no trusted signing keys/s],
			// Node can load this module; an ES import cannot see its verify(). The editor imports.
			'a verify() the editor\'s import cannot see': [() => {
				const app = installed();
				fs.writeFileSync(at(app, 'index.js'), `const real = require(${JSON.stringify(path.join(MODULE_DIR, 'index.js'))});\nmodule.exports = Object.assign({}, real);\n`);
				return app;
			}, /it has no verify\(\) an import can see/],
			'a module that accepts anything': [() => {
				const app = installed();
				fs.writeFileSync(at(app, 'index.js'), 'exports.verify = async () => ({ code: "Success", didExecute: true, output: "" });\nexports.trustedKeyIds = [];\n');
				return app;
			}, /ACCEPTS a package with one byte changed/],
			'a module that says it did not run': [() => {
				const app = installed();
				fs.writeFileSync(at(app, 'index.js'), 'exports.verify = async (a) => ({ code: a.endsWith("changed.vsix") ? "Untrusted" : "Success", didExecute: false, output: "" });\nexports.trustedKeyIds = [];\n');
				return app;
			}, /does not accept a real Open VSX package/]
		};
		for (const [what, [make, expected]] of Object.entries(cases)) {
			const { problems } = build.installedModuleProblems(make());
			assert.ok(problems.length > 0, what + ': passed');
			assert.match(problems.join('\n'), expected, what);
		}
	});

	await test('the command line: install then check is exit 0; an app with no module is exit 1 and told the fix', () => {
		const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
		const app = builtApp();

		const bare = run('check', app);
		assert.strictEqual(bare.status, 1);
		assert.match(bare.stderr, /cannot verify extension signatures[\s\S]*extension-signature\.mjs install/);

		const installed = run('install', app);
		assert.strictEqual(installed.status, 0, installed.stderr);
		assert.match(installed.stdout, /installed the Open VSX signature verifier/);
		assert.match(run('install', app).stdout, /already in place/);

		const checked = run('check', app);
		assert.strictEqual(checked.status, 0, checked.stderr);
		assert.match(checked.stdout, /a real package accepted, a changed one refused/);
		assert.ok(signing.trustedKeyIds.every((id) => checked.stdout.includes(id)), 'and it prints the keys the app trusts');

		fs.writeFileSync(path.join(build.installedPath(app), 'keys.json'), JSON.stringify({ keys: [other.trusted] }));
		assert.match(run('install', app).stdout, /left as built/);
		assert.strictEqual(run('check', app).status, 1, 'an app whose keys are not the registry\'s is not signed off');
		assert.match(run('install', app, '--replace').stdout, /replaced another version/);
		assert.strictEqual(run('check', app).status, 0);

		assert.strictEqual(run('install', tmp()).status, 1);
		for (const args of [[], ['install'], ['check'], ['smoke'], ['verify', app]]) { assert.strictEqual(run(...args).status, 2, 'usage for: ' + args.join(' ')); }
	});

	// ── smoke: the built app, asked directly ────────────────────────────────────────────────
	const ID = build.SMOKE_EXTENSION;
	const SUCCESS_LOG = `2026-10-04 23:18:02.111 [info] Extension signature verification result for ${ID}: Success. Executed: true. Duration: 2ms.`;

	await test('smoke reads the app\'s own words', () => {
		const verdict = (status, output, log = '') => build.smokeVerdict({ status, output, log, extension: ID }).verdict;
		assert.strictEqual(verdict(0, `Extension '${ID}' v0.0.1 was successfully installed.`, SUCCESS_LOG), 'pass');
		assert.strictEqual(verdict(0, 'installed', SUCCESS_LOG.replace(ID, ID.toUpperCase())), 'pass', 'the app lower-cases identifiers; either spelling is the same extension');

		// What every LevelCode build said before this module existed.
		const notExecuted = build.smokeVerdict({ status: 1, output: `Error while installing extension ${ID}: Signature verification was not executed.`, log: 'Could not load vsce-sign module', extension: ID });
		assert.strictEqual(notExecuted.verdict, 'fail');
		assert.match(notExecuted.why, /could not run its verifier/);

		const untrusted = build.smokeVerdict({ status: 1, output: `Signature verification failed with 'Untrusted' error.`, log: '', extension: ID });
		assert.strictEqual(untrusted.verdict, 'fail');
		assert.match(untrusted.why, /'Untrusted'/);

		assert.strictEqual(verdict(0, 'installed', ''), 'fail', 'installed with no signature check in the log: installing unverified');
		assert.strictEqual(verdict(0, 'installed', SUCCESS_LOG.replace('Executed: true', 'Executed: false')), 'fail');
		assert.strictEqual(verdict(0, 'installed', SUCCESS_LOG.replace(ID, 'some.other-extension')), 'fail', 'another extension\'s check is not this one\'s');

		// Not a signature: the registry could not be reached. That is not the app's fault, and not a pass.
		assert.strictEqual(verdict(1, 'getaddrinfo ENOTFOUND open-vsx.org'), 'unknown');
		assert.strictEqual(verdict(1, `Extension '${ID}' not found.`), 'unknown');
		assert.strictEqual(verdict(null, ''), 'unknown', 'killed, or never started');
	});

	await test('smoke runs the app as a command-line process, in folders of its own that it removes', () => {
		// A stand-in for the app's executable: it records how it was run and answers as told.
		const bundle = path.join(tmp(), 'LevelCode.app');
		const executable = path.join(bundle, 'Contents', 'MacOS', 'LevelCode Editor');
		const cli = path.join(bundle, 'Contents', 'Resources', 'app', 'out', 'cli.js');
		fs.mkdirSync(path.dirname(executable), { recursive: true });
		fs.mkdirSync(path.dirname(cli), { recursive: true });
		fs.writeFileSync(cli, '');
		fs.writeFileSync(path.join(bundle, 'Contents', 'Info.plist'), '<plist><dict>\n<key>CFBundleExecutable</key>\n<string>LevelCode Editor</string>\n</dict></plist>');
		const record = path.join(tmp(), 'record.json'), answer = path.join(tmp(), 'answer.json');
		fs.writeFileSync(executable, [
			'#!/usr/bin/env node',
			'const fs = require("fs"), path = require("path");',
			'const args = process.argv.slice(2);',
			'const after = (flag) => args[args.indexOf(flag) + 1];',
			`fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({ args, runAsNode: process.env.ELECTRON_RUN_AS_NODE }));`,
			`const answer = JSON.parse(fs.readFileSync(${JSON.stringify(answer)}, "utf8"));`,
			'const logs = path.join(after("--user-data-dir"), "logs", "20261004T231802");',
			'fs.mkdirSync(logs, { recursive: true }); fs.mkdirSync(after("--extensions-dir"), { recursive: true });',
			'fs.writeFileSync(path.join(logs, "cli.log"), answer.log);',
			'process.stdout.write(answer.output); process.exit(answer.status);'
		].join('\n'));
		fs.chmodSync(executable, 0o755);

		fs.writeFileSync(answer, JSON.stringify({ status: 0, output: 'installed', log: SUCCESS_LOG }));
		assert.strictEqual(build.smokeTest({ app: bundle }).verdict, 'pass');

		const ran = JSON.parse(fs.readFileSync(record, 'utf8'));
		assert.strictEqual(ran.runAsNode, '1', 'as a command-line process — no window opens');
		assert.deepStrictEqual([ran.args[0], ran.args[1], ran.args[2], ran.args[3], ran.args[5]], [cli, '--install-extension', ID, '--user-data-dir', '--extensions-dir']);
		const [data, extensions] = [ran.args[4], ran.args[6]];
		for (const folder of [data, extensions]) {
			assert.ok(fs.realpathSync(path.dirname(path.dirname(folder))) === fs.realpathSync(os.tmpdir()), folder + ' is a throwaway folder, not the machine\'s LevelCode');
			assert.ok(!fs.existsSync(folder), 'and it is gone afterwards');
		}

		fs.writeFileSync(answer, JSON.stringify({ status: 1, output: 'Error while installing extension: Signature verification was not executed.', log: '' }));
		assert.strictEqual(build.smokeTest({ app: bundle }).verdict, 'fail');

		const run = (...args) => spawnSync(process.execPath, [SCRIPT, 'smoke', bundle, ...args], { encoding: 'utf8', env: { ...process.env, GITHUB_ACTIONS: '' } });
		assert.strictEqual(run().status, 1, 'an app that cannot verify fails the step');
		fs.writeFileSync(answer, JSON.stringify({ status: 0, output: 'installed', log: SUCCESS_LOG }));
		assert.strictEqual(run().status, 0);
		fs.writeFileSync(answer, JSON.stringify({ status: 1, output: 'getaddrinfo ENOTFOUND open-vsx.org', log: '' }));
		const offline = run();
		assert.strictEqual(offline.status, 0, 'a registry that cannot be reached does not fail a build');
		assert.match(offline.stdout, /WARNING: could not tell/);
		assert.strictEqual(run('--strict').status, 2);
		assert.throws(() => build.smokeTest({ app: tmp() }), /Info\.plist/);
	});

	// ── registry: is Open VSX still signing with a key this build trusts? ───────────────────
	const pinnedModule = moduleTrusting([openVsx.trusted]);
	const signedBy = (by, { key = by.id, ...rest } = {}) => { const vsix = crypto.randomBytes(300); return { vsix, archive: archiveFor(vsix, by), key, ...rest }; };
	const check = (extensions, options, limits) => {
		const net = registry(extensions, options);
		return build.checkRegistry({ fetch: net.fetch, source: pinnedModule, origin: REGISTRY, ...limits }).then((result) => ({ ...result, requested: net.requested, said: result.lines.join('\n') }));
	};

	await test('registry: a registry that signs with the pinned key is fine, and the check verified real files to say so', async () => {
		const r = await check([signedBy(openVsx), signedBy(openVsx), signedBy(openVsx)]);
		assert.strictEqual(r.status, 'ok', r.said);
		assert.match(r.said, /signs with a pinned key: 2 of its newest packages verified.*3 of 3 name the-registry/s);
		assert.strictEqual(r.requested.filter((u) => u.endsWith('.vsix')).length, 2, 'two packages were downloaded and verified, not the listing taken at its word');
		assert.match(r.requested[0], /\/api\/-\/search\?size=\d+&sortBy=timestamp&sortOrder=desc$/, 'the newest: a new key shows there first');
	});

	await test('registry: a key that is not pinned is a mismatch, and the message says which key and what to do', async () => {
		const r = await check([signedBy(other), signedBy(other), signedBy(other)]);
		assert.strictEqual(r.status, 'mismatch');
		assert.match(r.said, /signing with a key this build does not trust: someone-else, named by 3 of its 3 newest/);
		assert.match(r.said, new RegExp(REGISTRY + '/api/-/public-key/someone-else'));
		assert.match(r.said, /refused with the pinned keys: ns\.ext0 1\.0\.0: Untrusted/);
		assert.match(r.said, /docs\/EXTENSION-SIGNATURES\.md \("When Open VSX changes its key"\)/);
		assert.match(read('docs', 'EXTENSION-SIGNATURES.md'), /^## When Open VSX changes its key$/m, 'and the place it points to exists');
	});

	await test('registry: one new key among the old is already news — and its package is the one put to the test', async () => {
		const r = await check([signedBy(openVsx), signedBy(openVsx), signedBy(openVsx), signedBy(other)]);
		assert.strictEqual(r.status, 'mismatch', 'Open VSX signs new packages with a new key at once, and the old ones again over time');
		assert.match(r.said, /someone-else, named by 1 of its 4 newest/);
		assert.match(r.said, /refused with the pinned keys: ns\.ext3 1\.0\.0: Untrusted/, 'the claim is confirmed on the file, not left to the listing');
	});

	await test('registry: not being able to ask is not evidence of anything', async () => {
		const offline = await build.checkRegistry({ fetch: async () => { throw new Error('getaddrinfo ENOTFOUND registry.test'); }, source: pinnedModule, origin: REGISTRY });
		assert.deepStrictEqual([offline.status, offline.lines.length], ['unknown', 1]);
		assert.match(offline.lines[0], /could not be asked: getaddrinfo ENOTFOUND/);
		for (const [what, options] of Object.entries({
			'503': { listingStatus: 503 },
			'not JSON': { listingBody: '<html>maintenance</html>' },
			'an empty list': { listingBody: '{"extensions":[]}' },
			'no list': { listingBody: '{}' }
		})) {
			assert.strictEqual((await check([signedBy(openVsx)], options)).status, 'unknown', what);
		}
	});

	await test('registry: signatures that stop verifying under a pinned key are a mismatch too', async () => {
		// The listing still names the pinned key; the files are no longer something it verifies.
		const r = await check([signedBy(other, { key: openVsx.id }), signedBy(other, { key: openVsx.id })]);
		assert.strictEqual(r.status, 'mismatch');
		assert.match(r.said, /names a pinned key, but none of the 2 packages checked verifies/);
		const garbled = await check([{ vsix: pkg, archive: Buffer.from('a new format'), key: openVsx.id }]);
		assert.strictEqual(garbled.status, 'mismatch');
		assert.match(garbled.said, /SignatureArchiveIsInvalidZip/);
	});

	await test('registry: one bad package among good ones is a warning, not an alarm', async () => {
		const r = await check([signedBy(other, { key: openVsx.id }), signedBy(openVsx), signedBy(openVsx)]);
		assert.strictEqual(r.status, 'ok');
		assert.match(r.said, /warning — one package did not verify.*ns\.ext0 1\.0\.0: Untrusted/s);
	});

	await test('registry: a package too large to fetch is passed over for the next', async () => {
		const large = 50 * 1024 * 1024;
		const r = await check([signedBy(openVsx, { claims: large }), signedBy(openVsx, { claims: large }), signedBy(openVsx)]);
		assert.strictEqual(r.status, 'ok', r.said);
		assert.match(r.said, /1 of its newest packages verified \(ns\.ext2 1\.0\.0\)/);
		assert.deepStrictEqual(r.requested.filter((u) => u.endsWith('.sigzip')).map((u) => /ext\d/.exec(u)[0]), ['ext2'], 'a package that was not read has no signature fetched for it');

		const allLarge = await check([signedBy(openVsx, { claims: large }), signedBy(openVsx, { claims: large })]);
		assert.strictEqual(allLarge.status, 'unknown', 'nothing verified is not "fine"');
		assert.match(allLarge.said, /none of the 2 newest signed extensions .* could be downloaded/);

		// A length that is not stated truthfully is found out as the bytes arrive.
		const understated = await check([signedBy(openVsx, { claims: 10 }), signedBy(openVsx, { claims: 10 })], undefined, { maxPackageBytes: 100 });
		assert.strictEqual(understated.status, 'unknown', '300 bytes behind a claim of 10 are still over a limit of 100');
	});

	await test('registry: a package that cannot be downloaded is not a package that failed to verify', async () => {
		const r = await check([signedBy(openVsx, { missing: true }), signedBy(openVsx, { missingSignature: true }), signedBy(openVsx), signedBy(openVsx)]);
		assert.strictEqual(r.status, 'ok', r.said);
		assert.doesNotMatch(r.said, /did not verify/, 'a 404 is not evidence about a signature');
		assert.match(r.said, /2 of its newest packages verified \(ns\.ext2 1\.0\.0, ns\.ext3 1\.0\.0\)/);
	});

	await test('registry: only addresses on the registry itself are followed', async () => {
		const r = await check([signedBy(openVsx, { origin: 'https://elsewhere.test' }), signedBy(openVsx), { vsix: pkg, key: openVsx.id }]);
		assert.strictEqual(r.status, 'ok', r.said);
		assert.ok(r.requested.every((u) => u.startsWith(REGISTRY + '/')), r.requested.join('\n'));
		assert.match(r.said, /2 of the 3 newest extensions are listed without a signature/, 'one elsewhere, one with none');
	});

	await test('registry: a registry that has stopped signing is as loud as one that changed its key', async () => {
		// Open VSX has a switch that deletes every signature. The editor requires one for each extension.
		const r = await check([{ vsix: pkg }, { vsix: pkg }, { vsix: pkg }]);
		assert.strictEqual(r.status, 'mismatch');
		assert.match(r.said, /none of the 3 newest extensions .* is listed with a signature.*'NotSigned'/s);
		assert.deepStrictEqual(r.requested.length, 1, 'and nothing was downloaded to learn it');
	});

	await test('registry: a pinned key the registry has stopped naming is pointed out', async () => {
		const both = moduleTrusting([openVsx.trusted, other.trusted]);
		const net = registry([signedBy(openVsx), signedBy(openVsx)]);
		const r = await build.checkRegistry({ fetch: net.fetch, source: both, origin: REGISTRY });
		assert.strictEqual(r.status, 'ok');
		assert.match(r.lines.join('\n'), /pinned key someone-else is named by none of the 2 newest extensions/);
	});

	await test('registry, from the command line: evidence is exit 1, silence is a warning — or exit 2 when asked to be strict', () => {
		const gallery = new URL(JSON.parse(read('branding', 'product.overlay.json')).extensionsGallery.serviceUrl).origin;
		const preloadWith = (body) => file(`globalThis.fetch = async (url) => { ${body} };\n`, '.cjs');
		const run = (preload, ...args) => spawnSync(process.execPath, ['-r', preload, SCRIPT, 'registry', ...args], { encoding: 'utf8', env: { ...process.env, GITHUB_ACTIONS: '' } });

		const offline = preloadWith('throw new Error("offline");');
		const quiet = run(offline);
		assert.strictEqual(quiet.status, 0, quiet.stderr);
		assert.match(quiet.stdout, /WARNING: could not check/);
		assert.strictEqual(run(offline, '--strict').status, 2);

		// The shipped keys against a registry that has moved to a key of its own.
		const listed = JSON.stringify({ extensions: [{ namespace: 'ns', name: 'x', version: '1.0.0', files: {
			download: gallery + '/api/ns/x/1.0.0/file/ns.x-1.0.0.vsix', signature: gallery + '/api/ns/x/1.0.0/file/ns.x-1.0.0.sigzip', publicKey: gallery + '/api/-/public-key/a-new-key' } }] });
		const moved = run(preloadWith(`if (String(url).includes("/api/-/search")) { return new Response(${JSON.stringify(listed)}); } return new Response("", { status: 404 });`));
		assert.strictEqual(moved.status, 1);
		assert.match(moved.stderr, /a-new-key/);
		assert.ok(signing.trustedKeyIds.every((id) => moved.stderr.includes(id)), 'and it prints what IS pinned');

		const onRunner = spawnSync(process.execPath, ['-r', offline, SCRIPT, 'registry'], { encoding: 'utf8', env: { ...process.env, GITHUB_ACTIONS: 'true' } });
		assert.match(onRunner.stdout, /^::warning::/m, 'on a runner a warning is an annotation: nobody reads a green log');
	});

	// ── what can only be read ───────────────────────────────────────────────────────────────
	const position = (text, needle, what) => { const i = text.indexOf(needle); assert.ok(i >= 0, `${what} no longer has: ${needle}`); return i; };

	await test('a build installs the verifier into the app it built, then proves it — and stops if it cannot', () => {
		const sh = read('scripts', 'build-macos.sh');
		const app = '"$BUILT_APP/LevelCode.app/Contents/Resources/app"';
		const order = [
			position(sh, 'npm run gulp -- "$GULP_TARGET"', 'build-macos.sh'),
			position(sh, 'strip-proprietary.mjs" ' + app, 'build-macos.sh'),
			position(sh, `extension-signature.mjs" install ${app} --replace`, 'build-macos.sh'),
			position(sh, `extension-signature.mjs" check ${app}`, 'build-macos.sh')
		];
		assert.deepStrictEqual(order, [...order].sort((a, b) => a - b), 'build, strip, install, check');
		assert.match(sh, /^set -euo pipefail$/m, 'a failing check stops the script');
	});

	await test('an app is not signed until it has a verifier that works — and signing never swaps the one it was built with', () => {
		const sh = read('scripts', 'make-dmg.sh');
		const app = '"$APP/Contents/Resources/app"';
		const install = position(sh, `extension-signature.mjs" install ${app}`, 'make-dmg.sh');
		const check = position(sh, `extension-signature.mjs" check ${app}`, 'make-dmg.sh');
		assert.ok(install < check, 'install, then check');
		assert.ok(check < position(sh, 'notarize.sh" sign "$APP"', 'make-dmg.sh'), 'before Developer ID signing');
		assert.ok(check < position(sh, 'codesign --force --deep --sign - "$APP"', 'make-dmg.sh'), 'and before ad-hoc signing');
		assert.doesNotMatch(sh, /extension-signature\.mjs" install [^\n]*--replace/, 'the keys an app trusts are its build\'s');
		assert.match(sh, /^set -euo pipefail$/m);
	});

	await test('the gate runs this suite, and a release asks the registry and the built app', () => {
		assert.match(read('scripts', 'test-extensions.sh'), /^for t in extensions\/\*\/test\/\*\.test\.js modules\/\*\/test\/\*\.test\.js; do$/m);
		const release = read('.github', 'workflows', 'release.yml');
		const gate = position(release, 'run: ./scripts/test-extensions.sh', 'release.yml');
		const asked = position(release, 'run: node scripts/extension-signature.mjs registry', 'release.yml');
		const built = position(release, 'run: ./scripts/build-macos.sh ${{ matrix.arch }}', 'release.yml');
		const smoked = position(release, 'run: node scripts/extension-signature.mjs smoke "VSCode-darwin-${{ matrix.arch }}/LevelCode.app"', 'release.yml');
		const zipped = position(release, 'ditto -c -k --sequesterRsrc --keepParent', 'release.yml');
		assert.deepStrictEqual([gate, asked, built, smoked, zipped], [gate, asked, built, smoked, zipped].sort((a, b) => a - b));
		assert.match(read('.github', 'workflows', 'openvsx-key.yml'), /node scripts\/extension-signature\.mjs registry --strict/);
	});

	console.log('\nextensionSignature: ' + n + ' tests passed.');
})().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => {
	for (const d of made) { fs.rmSync(d, { recursive: true, force: true }); }
});
