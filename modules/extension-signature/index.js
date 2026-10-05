/*---------------------------------------------------------------------------------------------
 *  LevelCode — extension signature verification for Open VSX
 *
 *  The editor verifies an extension before installing or updating it by loading a module named
 *  `@vscode/vsce-sign` and calling its verify(). That module is Microsoft's: closed, licensed for use
 *  "only with" Microsoft's own products, and so absent from every build made from the open source.
 *  With nothing to load, the editor could not verify, said "Signature verification was not executed",
 *  and refused — every signed extension on install, and every automatic update, silently.
 *
 *  This is LevelCode's own module for that slot. scripts/extension-signature.mjs installs it into a
 *  built app under the name the editor asks for; nothing in the editor's source is changed.
 *
 *  WHAT IS VERIFIED
 *
 *  Open VSX signs each extension file with an Ed25519 key and serves the signature in an archive
 *  beside it: `.signature.sig` (the 64-byte signature over the .vsix bytes), `.signature.manifest`
 *  (sizes and digests, of the package and of every file in it) and an empty `.signature.p7s`, the
 *  slot Microsoft's format uses. (The editor's downloader insists that entry is present before it
 *  calls any verifier; this module does not read it.) The check is one call — crypto.verify over
 *  the whole file — and it passes only for a file the registry signed, byte for byte.
 *
 *  THE KEY IS NOT ASKED FOR, IT IS KNOWN
 *
 *  The registry serves its public key too. A verifier that fetched it would be asking the server it
 *  is checking for the answer: whoever can swap the file can swap the key. The keys this module
 *  trusts ship with it (keys.json) and are read from nowhere else. docs/EXTENSION-SIGNATURES.md is
 *  what to do when Open VSX changes its key.
 *
 *  WHAT IT DOES NOT MEAN
 *
 *  A repository signature: the file is what Open VSX published. Not that the publisher signed it, and
 *  not that the extension is safe.
 *
 *  THE ARCHIVE IS UNTRUSTED INPUT
 *
 *  It arrives from the network and is parsed before anything about it has been verified, so the
 *  reader below takes nothing on trust: every offset and length is checked against the buffer, the
 *  signature must be exactly 64 bytes, nothing is inflated past a stated cap, and the archive
 *  features that exist to surprise a parser (zip64, encryption, multiple disks, duplicate names) are
 *  refused rather than handled: sizes and offsets are taken at their 32-bit word, and one that
 *  does not fit the archive is the end of it. No path from the archive ever touches the filesystem.
 *
 *  Plain Node, no dependencies: it runs in the editor's shared process, in its command line, and in
 *  modules/extension-signature/test/extensionSignature.test.js.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const SIGNATURE_ENTRY = '.signature.sig';
const MANIFEST_ENTRY = '.signature.manifest';
/** An Ed25519 signature is 64 bytes. Always. */
const SIGNATURE_BYTES = 64;
/** Open VSX writes three entries. */
const MAX_ENTRIES = 8;
/** The manifest lists every file in the package, so the archive grows with the extension — some 50
 *  bytes a file, compressed. 64 MB is room for over a million files, and a ceiling on what is read
 *  on a server's say-so. */
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
/** The same ceiling on the manifest once inflated. It is read for a message, never for a verdict. */
const MAX_MANIFEST_BYTES = 64 * 1024 * 1024;

/**
 * The result codes the editor understands (ExtensionSignatureVerificationCode in its source). Only
 * these may be returned: the editor shows the code to the user and chooses its dialog by it.
 */
const Code = Object.freeze({
	Success: 'Success',
	PackageIsUnreadable: 'PackageIsUnreadable',
	SignatureArchiveIsUnreadable: 'SignatureArchiveIsUnreadable',
	SignatureArchiveIsInvalidZip: 'SignatureArchiveIsInvalidZip',
	SignatureArchiveHasTooManyEntries: 'SignatureArchiveHasTooManyEntries',
	SignatureArchiveHasSameSignatureFile: 'SignatureArchiveHasSameSignatureFile',
	SignatureIsMissing: 'SignatureIsMissing',
	SignatureIsUnreadable: 'SignatureIsUnreadable',
	SignatureIsInvalid: 'SignatureIsInvalid',
	PackageIntegrityCheckFailed: 'PackageIntegrityCheckFailed',
	Untrusted: 'Untrusted'
});

/** Why an archive was refused: one of the codes above, and a sentence for the log. */
class ArchiveError extends Error {
	/** @param {string} code @param {string} message */
	constructor(code, message) { super(message); this.code = code; }
}
const invalidZip = (/** @type {string} */ why) => new ArchiveError(Code.SignatureArchiveIsInvalidZip, why);
const reason = (/** @type {any} */ e) => String((e && e.message) || e);

/**
 * @typedef {{name: string, method: number, compressedSize: number, size: number, localHeader: number}} Entry
 */

/**
 * The entries of a zip archive, from its central directory — the listing at the end of the file,
 * which is the only one that counts. Nothing is decompressed here.
 * @param {Buffer} zip
 * @returns {Entry[]}
 */
function listEntries(zip) {
	// The end-of-central-directory record is the last thing in the file: 22 bytes and a comment.
	// Found by walking back from the end, and accepted only if its comment runs exactly to the end —
	// a second record hidden in a comment is how two readers come to disagree about one archive.
	const EOCD = 0x06054b50, EOCD_BYTES = 22;
	let eocd = -1;
	for (let at = zip.length - EOCD_BYTES, stop = Math.max(0, zip.length - EOCD_BYTES - 0xffff); at >= stop; at--) {
		if (zip.readUInt32LE(at) === EOCD && at + EOCD_BYTES + zip.readUInt16LE(at + 20) === zip.length) { eocd = at; break; }
	}
	if (eocd < 0) { throw invalidZip('no end-of-central-directory record'); }
	const disk = zip.readUInt16LE(eocd + 4), startDisk = zip.readUInt16LE(eocd + 6);
	const onThisDisk = zip.readUInt16LE(eocd + 8), count = zip.readUInt16LE(eocd + 10);
	const directoryBytes = zip.readUInt32LE(eocd + 12), directory = zip.readUInt32LE(eocd + 16);
	if (disk !== 0 || startDisk !== 0 || onThisDisk !== count) { throw invalidZip('a multi-disk archive'); }
	if (count === 0xffff || directoryBytes === 0xffffffff || directory === 0xffffffff) { throw invalidZip('a zip64 archive'); }
	if (directory + directoryBytes > eocd) { throw invalidZip('the central directory runs past the end of the archive'); }
	if (count > MAX_ENTRIES) { throw new ArchiveError(Code.SignatureArchiveHasTooManyEntries, `${count} entries; a signature archive has three`); }

	const entries = [];
	let at = directory;
	for (let i = 0; i < count; i++) {
		if (at + 46 > directory + directoryBytes || zip.readUInt32LE(at) !== 0x02014b50) { throw invalidZip('a central directory entry is cut short'); }
		const flags = zip.readUInt16LE(at + 8), method = zip.readUInt16LE(at + 10);
		const compressedSize = zip.readUInt32LE(at + 20), size = zip.readUInt32LE(at + 24);
		const nameBytes = zip.readUInt16LE(at + 28), extraBytes = zip.readUInt16LE(at + 30), commentBytes = zip.readUInt16LE(at + 32);
		const localHeader = zip.readUInt32LE(at + 42);
		const end = at + 46 + nameBytes + extraBytes + commentBytes;
		if (end > directory + directoryBytes) { throw invalidZip('a central directory entry is cut short'); }
		if (flags & 0x1) { throw invalidZip('an encrypted entry'); }
		entries.push({ name: zip.toString('utf8', at + 46, at + 46 + nameBytes), method, compressedSize, size, localHeader });
		at = end;
	}
	return entries;
}

/**
 * One entry's bytes — never more than `limit` of them, whatever the archive claims.
 * @param {Buffer} zip
 * @param {Entry} entry
 * @param {number} limit
 * @returns {Buffer}
 */
function readEntry(zip, entry, limit) {
	if (entry.size > limit) { throw invalidZip(`${entry.name} claims ${entry.size} bytes; at most ${limit} are read`); }
	const header = entry.localHeader;
	if (header + 30 > zip.length || zip.readUInt32LE(header) !== 0x04034b50) { throw invalidZip(`${entry.name} has no local header where the directory says`); }
	// The name and extra field are measured from the LOCAL header: the two copies may differ in length.
	const start = header + 30 + zip.readUInt16LE(header + 26) + zip.readUInt16LE(header + 28);
	if (start + entry.compressedSize > zip.length) { throw invalidZip(`${entry.name} runs past the end of the archive`); }
	const stored = zip.subarray(start, start + entry.compressedSize);
	if (entry.method === 0) {
		if (entry.compressedSize !== entry.size) { throw invalidZip(`${entry.name} is stored, with two different sizes`); }
		return stored;
	}
	if (entry.method !== 8) { throw invalidZip(`${entry.name} uses compression method ${entry.method}`); }
	let inflated;
	// maxOutputLength is the guard that matters: a few bytes of deflate can describe gigabytes.
	try { inflated = zlib.inflateRawSync(stored, { maxOutputLength: Math.max(1, entry.size) }); }
	catch (e) { throw invalidZip(`${entry.name} does not inflate: ${reason(e)}`); }
	if (inflated.length !== entry.size) { throw invalidZip(`${entry.name} inflates to ${inflated.length} bytes, not the ${entry.size} it declares`); }
	return inflated;
}

/**
 * What a signature archive holds that this module uses: the signature, and a way to ask for the
 * manifest — which is not inflated unless it is asked for.
 * @param {Buffer} zip
 * @returns {{signature: Buffer, manifest: () => Buffer|null}}
 */
function readSignatureArchive(zip) {
	const entries = listEntries(zip);
	const signatures = entries.filter((e) => e.name === SIGNATURE_ENTRY);
	if (signatures.length > 1) { throw new ArchiveError(Code.SignatureArchiveHasSameSignatureFile, `${signatures.length} entries named ${SIGNATURE_ENTRY}`); }
	if (!signatures.length) { throw new ArchiveError(Code.SignatureIsMissing, `no ${SIGNATURE_ENTRY} in the archive`); }
	// Checked BEFORE reading: the declared size is all the reader will inflate to.
	if (signatures[0].size !== SIGNATURE_BYTES) { throw new ArchiveError(Code.SignatureIsUnreadable, `${SIGNATURE_ENTRY} is ${signatures[0].size} bytes; an Ed25519 signature is ${SIGNATURE_BYTES}`); }
	const signature = readEntry(zip, signatures[0], SIGNATURE_BYTES);

	// The manifest is not signed and is never a reason to trust anything. It is read only to say
	// WHY a signature did not verify, and a manifest that cannot be read just leaves that unsaid.
	const manifests = entries.filter((e) => e.name === MANIFEST_ENTRY);
	const manifest = () => {
		if (manifests.length !== 1) { return null; }
		try { return readEntry(zip, manifests[0], MAX_MANIFEST_BYTES); } catch { return null; }
	};
	return { signature, manifest };
}

/**
 * Is the package the one the archive's own manifest describes — by its SHA-256? null when the
 * manifest does not say. This is NOT verification (the manifest is as untrusted as the package); it
 * tells a download that was damaged apart from one that is intact and signed by a key not trusted here.
 * @param {Buffer} vsix
 * @param {Buffer|null} manifest
 * @returns {boolean|null}
 */
function packageMatchesManifest(vsix, manifest) {
	if (!manifest) { return null; }
	try {
		const described = JSON.parse(manifest.toString('utf8')).package;
		const sha256 = described && described.digests && described.digests.sha256;
		if (typeof sha256 !== 'string') { return null; }
		return sha256 === crypto.createHash('sha256').update(vsix).digest('base64');
	} catch { return null; }
}

/**
 * A key the verifier trusts: `id` is how Open VSX names it (the last segment of the public-key URL
 * it serves), `publicKey` the key itself — base64 of its SPKI DER, the body of the PEM.
 * @typedef {{id: string, publicKey: string}} TrustedKey
 */

/**
 * @param {TrustedKey[]} keys
 * @returns {{id: string, key: crypto.KeyObject}[]}
 */
function loadKeys(keys) {
	if (!Array.isArray(keys) || !keys.length) { throw new Error('no trusted signing keys: nothing could ever verify'); }
	return keys.map((k) => {
		if (!k || typeof k.id !== 'string' || !k.id || typeof k.publicKey !== 'string') { throw new Error('a trusted key needs an id and a publicKey'); }
		const key = crypto.createPublicKey({ key: Buffer.from(k.publicKey, 'base64'), format: 'der', type: 'spki' });
		if (key.asymmetricKeyType !== 'ed25519') { throw new Error(`trusted key ${k.id} is ${key.asymmetricKeyType}, not ed25519`); }
		return { id: k.id, key };
	});
}

/**
 * Ed25519 over the whole package, off the event loop: the editor's shared process has other work,
 * and a large extension is a few hundred megabytes to hash.
 * @param {Buffer} data @param {crypto.KeyObject} key @param {Buffer} signature
 * @returns {Promise<boolean>}
 */
function signedBy(data, key, signature) {
	return new Promise((resolve, reject) => {
		crypto.verify(null, data, key, signature, (error, valid) => error ? reject(error) : resolve(valid === true));
	});
}

/**
 * The editor's ExtensionSignatureVerificationResult.
 * @typedef {{code: string, didExecute: boolean, output: string}} VerificationResult
 */

/**
 * Build a verify() that trusts exactly `keys`.
 * @param {TrustedKey[]} keys
 * @returns {(vsixFilePath: string, signatureArchiveFilePath: string, verbose?: boolean) => Promise<VerificationResult>}
 */
function createVerifier(keys) {
	const trusted = loadKeys(keys);
	const done = (/** @type {string} */ code, /** @type {string} */ output) => ({ code, didExecute: true, output });

	return async function verify(vsixFilePath, signatureArchiveFilePath) {
		let archive;
		try {
			const { size } = await fs.promises.stat(signatureArchiveFilePath);
			if (size > MAX_ARCHIVE_BYTES) { return done(Code.SignatureArchiveIsUnreadable, `the signature archive is ${size} bytes; at most ${MAX_ARCHIVE_BYTES} are read`); }
			archive = await fs.promises.readFile(signatureArchiveFilePath);
		} catch (e) { return done(Code.SignatureArchiveIsUnreadable, `the signature archive cannot be read: ${reason(e)}`); }

		let signature, manifest;
		try { ({ signature, manifest } = readSignatureArchive(archive)); }
		catch (e) {
			if (e instanceof ArchiveError) { return done(e.code, e.message); }
			// Every read above is checked against the buffer first, so nothing is known to reach this.
			// It is the net under the reader: a mistake in it is then a refusal, not a rejection.
			return done(Code.SignatureArchiveIsInvalidZip, `the signature archive is not a readable zip: ${reason(e)}`);
		}

		let vsix;
		try { vsix = await fs.promises.readFile(vsixFilePath); }
		catch (e) { return done(Code.PackageIsUnreadable, `the extension package cannot be read: ${reason(e)}`); }

		try {
			for (const { id, key } of trusted) {
				if (await signedBy(vsix, key, signature)) { return done(Code.Success, `signed by Open VSX key ${id}`); }
			}
		} catch (e) {
			// The second net: a 64-byte signature and an Ed25519 key are not known to make this throw.
			return done(Code.SignatureIsInvalid, `the signature could not be checked: ${reason(e)}`);
		}

		// No trusted key made this signature over these bytes. Ed25519 cannot say which half is at
		// fault — the bytes or the key — so the archive's own account of the package is asked, for the
		// message only: every answer is a refusal.
		const tried = trusted.map((t) => t.id).join(', ');
		const intact = packageMatchesManifest(vsix, manifest());
		if (intact === false) { return done(Code.PackageIntegrityCheckFailed, `the package is not the one its signature archive describes (its SHA-256 differs): the download was damaged or altered. Keys tried: ${tried}`); }
		if (intact === true) { return done(Code.Untrusted, `the package matches its signature archive, but the signature was not made by a key this build trusts (${tried}). Open VSX may have changed its signing key — a newer LevelCode will carry it — or this did not come from Open VSX`); }
		return done(Code.SignatureIsInvalid, `the signature does not verify with any key this build trusts (${tried})`);
	};
}

/** The keys this build trusts: shipped beside this file, read once, and never fetched. */
const TRUSTED_KEYS = JSON.parse(fs.readFileSync(path.join(__dirname, 'keys.json'), 'utf8')).keys;

/**
 * Verify an extension package against its signature archive. Never rejects: every way of failing is a
 * result code. The name, the arguments and the result are the ones the editor expects of
 * `@vscode/vsce-sign`.
 * @type {(vsixFilePath: string, signatureArchiveFilePath: string, verbose?: boolean) => Promise<VerificationResult>}
 */
const verify = createVerifier(TRUSTED_KEYS);

exports.verify = verify;
exports.createVerifier = createVerifier;
exports.ExtensionSignatureVerificationCode = Code;
exports.trustedKeyIds = TRUSTED_KEYS.map((/** @type {TrustedKey} */ k) => k.id);
