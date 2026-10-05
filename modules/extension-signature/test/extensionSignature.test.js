/*---------------------------------------------------------------------------------------------
 *  Extension signature verification — run: node modules/extension-signature/test/extensionSignature.test.js
 *
 *  A LevelCode built from the open source could not verify an extension: the editor loads a module
 *  only Microsoft's products may ship, found none, and refused every signed extension from Open VSX
 *  ("Signature verification was not executed"). modules/extension-signature is LevelCode's module
 *  for that slot. Pinned here:
 *
 *    - a package verifies if, and only if, a key this build trusts signed exactly those bytes
 *    - every other outcome is a refusal the editor has a code for — never an exception
 *    - the signature archive is untrusted input: truncated, altered, oversized, or built to
 *      surprise a zip reader, it is refused; nothing inflates past what it declares
 *    - the keys are the ones that ship, for the gallery the product points at, and nothing is fetched
 *    - real packages, as Open VSX serves them, verify with the shipped key — and not when changed
 *
 *  Keys are generated here and archives are written by hand, so each lie an archive can tell is
 *  told on purpose. The two real packages are in fixtures/. The network is refused.
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

const MODULE_DIR = path.join(__dirname, '..');
const REPO = path.join(MODULE_DIR, '..', '..');
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

(async () => {
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

	console.log('\nextensionSignature: ' + n + ' tests passed.');
})().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => {
	for (const d of made) { fs.rmSync(d, { recursive: true, force: true }); }
});
