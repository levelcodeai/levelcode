/*---------------------------------------------------------------------------------------------
 *  The browser build's stand-ins for Node (path, crypto, fs, os, child_process) — run:
 *  node web/test/unit/shims.test.js
 *
 *  The extension was written against Node and the browser build swaps these in, so what matters
 *  is that they answer the way Node does. path and crypto are compared with Node itself over many
 *  inputs; fs is checked for the behaviours the extension depends on (and for the errors it
 *  catches by code); the rest is the contract the build relies on.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

const assert = require('assert');
const nodePath = require('path');
const nodeCrypto = require('crypto');

const SHIMS = nodePath.join(__dirname, '..', '..', 'ai-extension', 'shims');
const shimPath = require(nodePath.join(SHIMS, 'path.js'));
const shimCrypto = require(nodePath.join(SHIMS, 'crypto.js'));
const shimOs = require(nodePath.join(SHIMS, 'os.js'));
const shimCp = require(nodePath.join(SHIMS, 'child_process.js'));

let n = 0;
function test(name, fn) { fn(); n++; console.log('  ok - ' + name); }

// ---- path: the same answers as path.posix ------------------------------------------------------
const PATHS = ['', '.', '..', '/', '//', 'a', 'a/b', '/a/b', '/a/b/', 'a//b', './a', '../a', 'a/../b', '/a/../..', '/a/./b/../c.txt',
	'a/b/c.d.e', '.hidden', '/.hidden/file', 'dir.d/file', 'trailing/', '/x/y/z.tar.gz', 'C:\\win', '\u00e9/\u4e2d', '  spaced  /name '];
test('path: normalize, dirname, basename, extname, isAbsolute match path.posix', () => {
	for (const p of PATHS) {
		assert.strictEqual(shimPath.normalize(p), nodePath.posix.normalize(p), 'normalize ' + JSON.stringify(p));
		assert.strictEqual(shimPath.dirname(p), nodePath.posix.dirname(p), 'dirname ' + JSON.stringify(p));
		assert.strictEqual(shimPath.basename(p), nodePath.posix.basename(p), 'basename ' + JSON.stringify(p));
		assert.strictEqual(shimPath.basename(p, '.txt'), nodePath.posix.basename(p, '.txt'), 'basename ext ' + JSON.stringify(p));
		assert.strictEqual(shimPath.extname(p), nodePath.posix.extname(p), 'extname ' + JSON.stringify(p));
		assert.strictEqual(shimPath.isAbsolute(p), nodePath.posix.isAbsolute(p), 'isAbsolute ' + JSON.stringify(p));
	}
});
test('path: join and resolve match path.posix over pairs and triples', () => {
	const parts = ['', '/', 'a', 'b/c', '../x', './y', '/abs', 'trail/', '..'];
	for (const a of parts) {
		for (const b of parts) {
			assert.strictEqual(shimPath.join(a, b), nodePath.posix.join(a, b), `join(${JSON.stringify(a)}, ${JSON.stringify(b)})`);
			// resolve() reads the process cwd in Node; the shim's cwd is "/". Compare with an absolute first part.
			assert.strictEqual(shimPath.resolve('/', a, b), nodePath.posix.resolve('/', a, b), `resolve(/, ${JSON.stringify(a)}, ${JSON.stringify(b)})`);
		}
	}
	assert.strictEqual(shimPath.resolve('a/b'), '/a/b', 'a relative path resolves against "/"');
});
test('path: relative matches path.posix for absolute pairs', () => {
	const abs = ['/', '/a', '/a/b', '/a/b/c', '/x', '/a/x/y'];
	for (const a of abs) { for (const b of abs) { assert.strictEqual(shimPath.relative(a, b), nodePath.posix.relative(a, b), `relative(${a}, ${b})`); } }
});
test('path: parse and format round-trip like path.posix', () => {
	for (const p of ['/a/b/c.txt', 'c.txt', '/a/b/', '.gitignore', '/a/b.c/d']) {
		const mine = shimPath.parse(p), node = nodePath.posix.parse(p);
		assert.deepStrictEqual(mine, node, 'parse ' + p);
		assert.strictEqual(shimPath.format(mine), nodePath.posix.format(node), 'format ' + p);
	}
});
test('path: sep, posix, win32 are what callers read', () => {
	assert.strictEqual(shimPath.sep, '/');
	assert.strictEqual(shimPath.posix, shimPath);
});

// ---- crypto: SHA-256 is computed here because WebCrypto's is asynchronous ---------------------
test('crypto: sha256 matches Node for every length around the block boundaries, hex and raw', () => {
	for (let len = 0; len <= 200; len++) {
		const buf = Buffer.alloc(len, len % 251);
		assert.strictEqual(shimCrypto.createHash('sha256').update(buf).digest('hex'), nodeCrypto.createHash('sha256').update(buf).digest('hex'), 'length ' + len);
	}
	const text = 'caf\u00e9 \u4e2d\u6587 \ud83d\ude80';
	assert.strictEqual(shimCrypto.createHash('sha256').update(text).digest('hex'), nodeCrypto.createHash('sha256').update(text).digest('hex'));
	assert.deepStrictEqual([...shimCrypto.createHash('sha256').update('abc').digest()], [...nodeCrypto.createHash('sha256').update('abc').digest()]);
});
test('crypto: updates may be chunked, and a PKCE challenge comes out as RFC 7636 says', () => {
	const h = shimCrypto.createHash('sha256');
	h.update('hello ').update(Buffer.from('wor')).update('ld');
	assert.strictEqual(h.digest('hex'), nodeCrypto.createHash('sha256').update('hello world').digest('hex'));
	// RFC 7636 appendix B
	const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
	const b64url = (b) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
	assert.strictEqual(b64url(shimCrypto.createHash('sha256').update(verifier).digest()), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
});
test('crypto: a digest is single use, an unknown algorithm says so, randomness is random', () => {
	const h = shimCrypto.createHash('sha256'); h.digest();
	assert.throws(() => h.digest(), /already called/);
	assert.throws(() => shimCrypto.createHash('md5'), (e) => e.code === 'ERR_CRYPTO_INVALID_DIGEST');
	const a = shimCrypto.randomBytes(32), b = shimCrypto.randomBytes(32);
	assert.strictEqual(a.length, 32);
	assert.notDeepStrictEqual([...a], [...b]);
	assert.strictEqual(shimCrypto.randomBytes(3).toString('hex').length, 6);
	assert.match(shimCrypto.randomUUID(), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

// ---- os and child_process --------------------------------------------------------------------
test('os: a home directory under which private state lives, and nothing that needs a machine', () => {
	assert.strictEqual(shimOs.homedir(), '/home/levelcode');
	assert.strictEqual(shimOs.EOL, '\n');
	assert.strictEqual(typeof shimOs.tmpdir(), 'string');
});
test('child_process: every way of starting a program fails the way an unsupported syscall does', () => {
	for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
		assert.throws(() => shimCp[name]('ls'), (e) => e.code === 'ENOSYS', name);
	}
});

// ---- fs ----------------------------------------------------------------------------------------
const fs = require(nodePath.join(SHIMS, 'fs.js'));
const code = (fn) => { try { fn(); } catch (e) { return e.code; } return null; };

test('fs: write, read (string and bytes), append, overwrite', () => {
	fs.writeFileSync('/home/levelcode/.levelcode/a.txt', 'one');
	assert.strictEqual(fs.readFileSync('/home/levelcode/.levelcode/a.txt', 'utf8'), 'one');
	assert.deepStrictEqual([...fs.readFileSync('/home/levelcode/.levelcode/a.txt')], [111, 110, 101]);
	fs.appendFileSync('/home/levelcode/.levelcode/a.txt', '+two');
	assert.strictEqual(fs.readFileSync('/home/levelcode/.levelcode/a.txt', { encoding: 'utf8' }), 'one+two');
	fs.writeFileSync('/home/levelcode/.levelcode/a.txt', Buffer.from([0, 1, 2]));
	assert.deepStrictEqual([...fs.readFileSync('/home/levelcode/.levelcode/a.txt')], [0, 1, 2]);
	assert.strictEqual(fs.readFileSync('/home/levelcode/.levelcode/a.txt').length, 3);
});
test('fs: writing creates the directories above it, as the extension\'s mkdirSync-then-write calls expect', () => {
	fs.writeFileSync('/p/q/r/file.json', '{}');
	assert.strictEqual(fs.existsSync('/p/q/r'), true);
	assert.strictEqual(fs.statSync('/p/q').isDirectory(), true);
	assert.strictEqual(fs.statSync('/p/q/r/file.json').isFile(), true);
	assert.strictEqual(fs.statSync('/p/q/r/file.json').size, 2);
});
test('fs: errors carry the codes the extension catches', () => {
	assert.strictEqual(code(() => fs.readFileSync('/nope/missing')), 'ENOENT');
	assert.strictEqual(code(() => fs.statSync('/nope/missing')), 'ENOENT');
	assert.strictEqual(code(() => fs.readdirSync('/nope')), 'ENOENT');
	assert.strictEqual(code(() => fs.readFileSync('/p/q')), 'EISDIR');
	assert.strictEqual(code(() => fs.readdirSync('/p/q/r/file.json')), 'ENOTDIR');
	assert.strictEqual(code(() => fs.mkdirSync('/p/q')), 'EEXIST');
	assert.strictEqual(code(() => fs.mkdirSync('/p/q', { recursive: true })), null);
	assert.strictEqual(code(() => fs.mkdirSync('/m/n/o')), 'ENOENT');
	assert.strictEqual(code(() => fs.unlinkSync('/p/q')), 'EISDIR');
	assert.strictEqual(code(() => fs.rmdirSync('/p/q')), 'ENOTEMPTY');
});
test('fs: existsSync never throws, statSync can answer "absent" without throwing', () => {
	assert.strictEqual(fs.existsSync('/p/q/r/file.json'), true);
	assert.strictEqual(fs.existsSync('/nope'), false);
	assert.strictEqual(fs.existsSync(''), false);
	assert.strictEqual(fs.statSync('/nope', { throwIfNoEntry: false }), undefined);
});
test('fs: readdir lists names sorted, with types on request', () => {
	fs.writeFileSync('/d/b.txt', '1'); fs.writeFileSync('/d/a.txt', '2'); fs.mkdirSync('/d/sub', { recursive: true }); fs.writeFileSync('/d/sub/deep.txt', '3');
	assert.deepStrictEqual(fs.readdirSync('/d'), ['a.txt', 'b.txt', 'sub']);
	assert.deepStrictEqual(fs.readdirSync('/d', { withFileTypes: true }).map((e) => [e.name, e.isFile(), e.isDirectory()]),
		[['a.txt', true, false], ['b.txt', true, false], ['sub', false, true]]);
});
test('fs: rename moves a file and a directory with what is under it; unlink and rm remove', () => {
	fs.renameSync('/d/b.txt', '/d/c.txt');
	assert.strictEqual(fs.existsSync('/d/b.txt'), false);
	assert.strictEqual(fs.readFileSync('/d/c.txt', 'utf8'), '1');
	fs.renameSync('/d/sub', '/e');
	assert.strictEqual(fs.readFileSync('/e/deep.txt', 'utf8'), '3');
	assert.strictEqual(fs.existsSync('/d/sub'), false);
	fs.unlinkSync('/d/c.txt');
	assert.strictEqual(fs.existsSync('/d/c.txt'), false);
	assert.strictEqual(code(() => fs.rmSync('/e')), 'ENOTEMPTY');
	fs.rmSync('/e', { recursive: true });
	assert.strictEqual(fs.existsSync('/e'), false);
	assert.strictEqual(code(() => fs.rmSync('/e')), 'ENOENT');
	assert.strictEqual(code(() => fs.rmSync('/e', { force: true })), null);
});
test('fs: copyFileSync copies bytes; a returned Buffer is a copy', () => {
	fs.writeFileSync('/c/src.bin', Buffer.from([9, 8, 7]));
	fs.copyFileSync('/c/src.bin', '/c/dst.bin');
	const got = fs.readFileSync('/c/dst.bin');
	got[0] = 0;
	assert.deepStrictEqual([...fs.readFileSync('/c/dst.bin')], [9, 8, 7]);
});
test('fs: the promise and callback forms agree with the sync one', async () => {
	await fs.promises.writeFile('/pr/a.txt', 'promised');
	assert.strictEqual(await fs.promises.readFile('/pr/a.txt', 'utf8'), 'promised');
	await assert.rejects(fs.promises.readFile('/pr/none'), (e) => e.code === 'ENOENT');
	await new Promise((resolve, reject) => fs.writeFile('/cb/a.txt', 'called', (err) => (err ? reject(err) : resolve())));
	await new Promise((resolve, reject) => fs.stat('/cb/a.txt', (err, st) => (err ? reject(err) : (assert.strictEqual(st.size, 6), resolve()))));
});
test('fs: mounted assets are readable and read-only, and survive being listed', () => {
	fs.__levelcode.mountAssets('/ext/levelcode-ai', { 'media/chat.html': '<p>hi</p>', 'skills/a/SKILL.md': '# a', 'media/x.bin': { base64: Buffer.from([1, 2, 3]).toString('base64') } });
	assert.strictEqual(fs.readFileSync('/ext/levelcode-ai/media/chat.html', 'utf8'), '<p>hi</p>');
	assert.deepStrictEqual([...fs.readFileSync('/ext/levelcode-ai/media/x.bin')], [1, 2, 3]);
	assert.deepStrictEqual(fs.readdirSync('/ext/levelcode-ai/skills'), ['a']);
	assert.strictEqual(code(() => fs.writeFileSync('/ext/levelcode-ai/media/chat.html', 'x')), 'EROFS');
	assert.strictEqual(code(() => fs.unlinkSync('/ext/levelcode-ai/media/chat.html')), 'EROFS');
});
test('fs: where there is no IndexedDB the tree is simply session-only, and flush is harmless', async () => {
	assert.strictEqual(await fs.__levelcode.ready, false);
	await fs.__levelcode.flush();
	assert.strictEqual(fs.__levelcode.isPersistent(), false);
});

console.log(`\n${n} tests passed`);
