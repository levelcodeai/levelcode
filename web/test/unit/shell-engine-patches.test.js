/*---------------------------------------------------------------------------------------------
 *  The vendored just-bash and the patches on it — run: node web/test/unit/shell-engine-patches.test.js
 *
 *  The engine is one minified npm file, 1.26 MB, without sources. What this suite pins:
 *    - the file in the repository IS the published one (its sha256, its npm integrity string);
 *    - every patch anchor occurs exactly once in it, so a version bump that moves one fails here, loudly;
 *    - taking the patches out gives the original back, byte for byte, and what they add is the notice that the file
 *      was modified (Apache-2.0 section 4(b));
 *    - each patch does what it says, on the real engine: statement hook, glob, arithmetic, read/mapfile, redirection
 *      open, raw result, not-found, ls -l modes.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

// A test that waits for something that never happens must fail the suite, not end it silently with status 0.
require('../helpers/shell-exit-guard.js');

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { pathToFileURL } = require('url');

const REPO = path.join(__dirname, '..', '..', '..');
const ENGINE = path.join(REPO, 'web', 'shell', 'engine');
const VENDOR = path.join(ENGINE, 'vendor', 'just-bash', '3.6.0');
const { loadEngine } = require('./shell-engine-support.js');

/** @type {Array<{ name: string, fn: () => Promise<void> | void }>} */
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const count = (text, needle) => text.split(needle).length - 1;

async function main() {
	const patchMod = await import(pathToFileURL(path.join(VENDOR, 'apply-patches.mjs')).href);
	const loader = await import(pathToFileURL(path.join(ENGINE, 'load.mjs')).href);
	const original = fs.readFileSync(path.join(VENDOR, 'browser.js'), 'utf8');
	const vendorJson = JSON.parse(fs.readFileSync(path.join(VENDOR, 'VENDOR.json'), 'utf8'));
	const E = await loadEngine();

	/** a fresh bash over an in-memory file system, with the files given */
	const bash = (files, opts) => {
		const fsys = new E.InMemoryFs();
		for (const [p, v] of Object.entries(files || {})) {
			fsys.mkdirSync(path.posix.dirname(p), { recursive: true });
			fsys.writeFileSync(p, v);
		}
		return { fs: fsys, sh: new E.Bash(Object.assign({ fs: fsys, cwd: '/w' }, opts || {})) };
	};

	/** a bash over the engine's real file system (the overlay), the way the worker has it: text is read losslessly */
	const { makeTree } = require('./shell-engine-support.js');
	const { createOverlay } = require(path.join(ENGINE, 'overlay-fs.js'));
	const overlayBash = (files, opts) => {
		const tree = makeTree(Object.assign({ '/w': null }, files || {}));
		const err = (code) => Object.assign(new Error(code), { code });
		const base = {
			async stat(p) { if (!tree.nodes.has(p)) { throw err('ENOENT'); } const n = tree.nodes.get(p); return { type: n === null ? 'dir' : 'file', size: n ? n.length : 0, mtime: 1700000000000 }; },
			async readFile(p) { const n = tree.nodes.get(p); if (n === undefined) { throw err('ENOENT'); } if (n === null) { throw err('EISDIR'); } return n.slice(); },
			async readDir(p) { if (tree.nodes.get(p) !== null) { throw err('ENOENT'); } return tree.list(p); },
		};
		const ov = createOverlay({ folders: [{ id: 'f', path: '/w', name: 'w' }], base });
		return { ov, fs: ov.fs, sh: new E.Bash(Object.assign({ fs: ov.fs, cwd: '/w' }, opts || {})) };
	};

	/* ------------------------------------------------------------------------------------------ the file */

	test('the vendored file is the published one: size, sha256, and the integrity string of the tarball it came from', () => {
		assert.strictEqual(sha256(original), '38f1ad1e3283980ecdf68cede8a4eed028c6dff6e8c31793dec1e0af529c446e');
		assert.strictEqual(sha256(original), vendorJson.fileSha256);
		assert.strictEqual(Buffer.byteLength(original), vendorJson.fileBytes);
		assert.strictEqual(patchMod.UNPATCHED_SHA256, vendorJson.fileSha256);
		assert.strictEqual(vendorJson.version, '3.6.0');
		assert.strictEqual(vendorJson.npmTarballIntegritySha512, 'sha512-2COjEgcHdqKXeQSiNfPAHmpwQx4S8wATaIwog83g2t645U5tom6FED4CBBdr3M+0ioX4xZ26eODw3/nD6RQ6xw==');
		assert.ok(fs.readFileSync(path.join(VENDOR, 'LICENSE'), 'utf8').includes('Copyright 2025 Vercel Inc.'));
		assert.ok(fs.readFileSync(path.join(VENDOR, 'LICENSE'), 'utf8').includes('Apache License'));
	});

	test('it imports exactly four things it does not bundle, and all four are vendored or stubbed', () => {
		assert.deepStrictEqual(loader.importSpecifiers(original), ['diff', 'node:zlib', 'sprintf-js', 'turndown']);
		for (const name of ['diff', 'node:zlib', 'sprintf-js', 'turndown', 'node:module']) {
			assert.ok(fs.existsSync(loader.EXTERNALS[name]), name + ' is vendored at ' + loader.EXTERNALS[name]);
		}
		for (const f of ['diff/8.0.4/LICENSE', 'sprintf-js/1.1.3/LICENSE', 'just-bash/3.6.0/THIRD_PARTY.md']) {
			assert.ok(fs.existsSync(path.join(ENGINE, 'vendor', f)), f);
		}
	});

	/* ------------------------------------------------------------------------------------------ the patches */

	const IDS = ['LC-1', 'LC-2', 'LC-3', 'LC-4', 'LC-5', 'LC-6', 'LC-7', 'LC-8', 'LC-9', 'LC-10', 'LC-11', 'LC-12', 'LC-13', 'LC-14', 'LC-15', 'LC-16', 'LC-17', 'LC-18', 'LC-19', 'LC-20', 'LC-21', 'LC-22', 'LC-23', 'LC-24', 'LC-25', 'LC-26', 'LC-27', 'LC-28', 'LC-29', 'LC-30', 'LC-31', 'LC-32', 'LC-33', 'LC-34', 'LC-35', 'LC-36', 'LC-37', 'LC-38', 'LC-39', 'LC-40', 'LC-41', 'LC-42', 'LC-43', 'LC-44', 'LC-45', 'LC-46', 'LC-47', 'LC-48', 'LC-49', 'LC-50', 'LC-51', 'LC-52', 'LC-53', 'LC-54', 'LC-55', 'LC-56', 'LC-57', 'LC-58', 'LC-59', 'LC-60', 'LC-61', 'LC-62', 'LC-63', 'LC-64', 'LC-65', 'LC-66', 'LC-67', 'LC-68', 'LC-69', 'LC-70', 'LC-71'];

	test('there are seventy patches, and every anchor occurs exactly once in the original (counted here, not by the script)', () => {
		assert.deepStrictEqual(patchMod.PATCHES.map((p) => p.id), IDS);
		let edits = 0;
		for (const p of patchMod.PATCHES) {
			assert.ok(p.title.length > 20, p.id + ' says what it is for');
			for (const e of p.edits) {
				assert.strictEqual(count(original, e.from), 1, `${p.id}: ${e.name}`);
				assert.notStrictEqual(e.from, e.to);
				edits++;
			}
		}
		assert.strictEqual(edits, vendorJson.patched.edits);
	});

	test('the patched file hashes to what VENDOR.json says, and carries the notice that it was modified', () => {
		const r = patchMod.applyPatches(original);
		assert.strictEqual(r.sha256, vendorJson.patched.sha256);
		assert.strictEqual(Buffer.byteLength(r.text), vendorJson.patched.bytes);
		assert.strictEqual(vendorJson.patched.patches, IDS.length);
		assert.strictEqual(r.inputSha256, vendorJson.fileSha256);
		assert.ok(r.text.startsWith('/*! LevelCode: this is just-bash@3.6.0'));
		assert.ok(r.text.includes('MODIFIED by LevelCode'));
		assert.ok(r.text.includes('Apache-2.0'));
		assert.ok(r.text.includes('section 4(b)'));
		assert.ok(r.text.includes('LC-1 .. LC-71'), 'the notice says how many patches there are');
		assert.deepStrictEqual(r.patches.map((p) => p.id), IDS);
	});

	test('the header imports LevelCode\'s own two modules by names the loader and the build both map, and nothing else', () => {
		const head = patchMod.HEADER;
		assert.deepStrictEqual(loader.importSpecifiers(head), ['lc-text', 'lc-zone']);
		assert.ok(fs.existsSync(loader.EXTERNALS['lc-text']) && fs.existsSync(loader.EXTERNALS['lc-zone']));
		assert.deepStrictEqual(loader.importSpecifiers(patchMod.applyPatches(original).text), ['diff', 'lc-text', 'lc-zone', 'node:zlib', 'sprintf-js', 'turndown']);
		// every identifier the header adds starts with __lc, apart from Date, which it shadows on purpose
		const added = [...head.matchAll(/\b(?:var|const|import)\s+([A-Za-z_$][\w$]*)/g)].map((m) => m[1]);
		assert.deepStrictEqual(added.filter((n) => !n.startsWith('__lc')), ['Date']);
	});

	test('--check verifies the hash and every anchor and writes nothing; a changed file fails it and names what is wrong', () => {
		const run = (extra) => spawnSync(process.execPath, [path.join(VENDOR, 'apply-patches.mjs'), '--check', ...extra], { encoding: 'utf8' });
		const ok = run([]);
		assert.strictEqual(ok.status, 0, ok.stderr);
		const summary = JSON.parse(ok.stdout);
		assert.deepStrictEqual([summary.check, summary.patches, summary.edits, summary.sha256], ['ok', IDS.length, vendorJson.patched.edits, vendorJson.fileSha256]);
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-check-'));
		try {
			// one anchor gone, and so a different hash: both are said
			const edited = original.replace('function Os(e,t,n,r,s,i){let o=q9(', 'function Os(e,t,n,r,s,i){let o=q8(');
			assert.notStrictEqual(edited, original);
			fs.writeFileSync(path.join(dir, 'x.js'), edited);
			const bad = run(['--in', path.join(dir, 'x.js')]);
			assert.strictEqual(bad.status, 1);
			assert.ok(/sha256 is [0-9a-f]{64}, expected 38f1ad1e/.test(bad.stderr), bad.stderr);
			// a copy with an anchor broken in one place (the first one: it is not the anchor of the patch under test)
			const first = patchMod.PATCHES[0].edits[0];
			const anchorless = original.replace(first.from, first.from.slice(0, -1) + 'X');
			assert.notStrictEqual(anchorless, original);
			fs.writeFileSync(path.join(dir, 'y.js'), anchorless);
			const bad2 = run(['--in', path.join(dir, 'y.js')]);
			assert.strictEqual(bad2.status, 1);
			assert.ok(/LC-1 anchor "[^"]+" occurs 0 times \(expected exactly 1\)/.test(bad2.stderr), bad2.stderr);
			assert.deepStrictEqual(fs.readdirSync(dir).sort(), ['x.js', 'y.js'], 'nothing was written');
			assert.ok(patchMod.checkAnchors(original).every((a) => a.count === 1));
			assert.strictEqual(patchMod.checkAnchors(original).length, vendorJson.patched.edits);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test('taking the patches out gives the original back, byte for byte', () => {
		const r = patchMod.applyPatches(original);
		let back = r.text.slice(patchMod.HEADER.length);
		for (const p of patchMod.PATCHES) {
			for (const e of p.edits) {
				assert.strictEqual(count(back, e.to), 1, `${p.id}: the replacement is there once`);
				back = back.replace(e.to, () => e.from);
			}
		}
		assert.strictEqual(back, original);
	});

	test('a file that is not the pinned one is refused, with its hash in the message', () => {
		assert.throws(() => patchMod.applyPatches(original + ' '), /not the just-bash 3\.6\.0 file/);
		assert.throws(() => patchMod.applyPatches(original.replace('export{', 'export {')), (e) => /sha256 [0-9a-f]{64}/.test(/** @type {Error} */ (e).message));
		assert.throws(() => patchMod.applyPatches(''), /not the just-bash 3\.6\.0 file/);
	});

	test('an anchor that is not there, is there twice, or overlaps another one stops the build, naming it', () => {
		const patch = (from, to) => [{ id: 'LC-T', title: 't', edits: [{ name: 'the anchor', from, to }] }];
		assert.throws(() => patchMod.applyEdits('a b c', patch('zzz', 'x')), /LC-T anchor "the anchor" occurs 0 times \(expected exactly 1\)/);
		assert.throws(() => patchMod.applyEdits('a b a', patch('a', 'x')), /occurs 2 times/);
		assert.throws(() => patchMod.applyEdits('abcdef', [{ id: 'LC-T', title: 't', edits: [{ name: 'a', from: 'abcd', to: 'x' }, { name: 'b', from: 'cdef', to: 'y' }] }]), /overlap/);
		assert.strictEqual(patchMod.applyEdits('abcdef', patch('bcd', '$&$1')), 'a$&$1ef', 'String.replace patterns do not apply to a replacement');
		assert.strictEqual(patchMod.applyEdits('x a y', patch('a', 'a a')), 'x a a y', 'a replacement that contains its anchor is not matched again');
	});

	test('loadEngine imports the patched file once per process and leaves nothing in the temporary directory', async () => {
		const again = await loader.loadEngine();
		assert.strictEqual(again, E);
		assert.strictEqual(E.lcSha256, vendorJson.patched.sha256);
		// the directory this process used, not the shared temp directory: other test processes have their own there
		const used = loader.lastTempDir();
		assert.ok(used && path.dirname(used) === os.tmpdir() && path.basename(used).startsWith('lc-shell-engine-'), String(used));
		assert.strictEqual(fs.existsSync(used), false);
		assert.deepStrictEqual(Object.keys(E).filter((k) => k !== 'lcSha256').sort(), ['Bash', 'InMemoryFs', 'LimitError', 'MountableFs', 'NetworkAccessDeniedError', 'RedirectNotAllowedError', 'TooManyRedirectsError', 'createCommandContext', 'defineCommand', 'getCommandNames', 'getNetworkCommandNames']);
	});

	/* ------------------------------------------------------------------------------------------ LC-1 */

	test('LC-1: the statement hook runs after each TOP-LEVEL statement, in order, with what that statement printed', async () => {
		const { sh } = bash({});
		const seen = [];
		const r = await sh.exec('echo one; echo two >&2; f() { echo in-f; }; f; echo $(echo sub); bash -c "echo inner"; echo three', { onStatement: async (res) => { seen.push([res.stdout, res.stderr, res.exitCode]); } });
		assert.deepStrictEqual(seen, [
			['one\n', '', 0],
			['', 'two\n', 0],
			['', '', 0],            // the definition
			['in-f\n', '', 0],
			['sub\n', '', 0],
			['inner\n', '', 0],
			['three\n', '', 0],
		]);
		assert.strictEqual(r.stdout, 'one\nin-f\nsub\ninner\nthree\n');
	});

	test('LC-1: the hook is awaited (a slow one holds the next statement back) and a script without it is unchanged', async () => {
		const { sh } = bash({});
		const order = [];
		await sh.exec('echo a; echo b', { onStatement: async (res) => { await new Promise((r) => setTimeout(r, 20)); order.push('hook:' + res.stdout.trim()); } });
		assert.deepStrictEqual(order, ['hook:a', 'hook:b']);
		const r = await sh.exec('echo a; echo b');
		assert.strictEqual(r.stdout, 'a\nb\n');
	});

	test('LC-1: a statement that failed in expansion is shown to the hook where it happened, before the next one', async () => {
		const { sh } = bash({});
		const seen = [];
		await sh.exec('echo $(( $ )); echo after', { onStatement: async (res) => { seen.push(res.stderr ? 'E' : 'O:' + res.stdout.trim()); } });
		assert.deepStrictEqual(seen, ['E', 'O:after']);
		// the other class that lets the script go on: an invalid brace sequence
		const braces = [];
		await sh.exec('echo before; echo {a..Z}; echo after', { onStatement: async (res) => { braces.push(res.stderr ? 'E:' + res.stderr.trim() : 'O:' + res.stdout.trim()); } });
		assert.deepStrictEqual(braces, ['O:before', 'E:bash: {a..Z}: invalid sequence', 'O:after']);
	});

	test('LC-1: what ran before a deadline has been shown, and `exit` leaves nothing to the hook that it did not print', async () => {
		const { sh } = bash({}, { executionLimits: { maxCommandCount: 50 } });
		const seen = [];
		const r = await sh.exec('echo before; while true; do :; done; echo never', { onStatement: async (res) => { seen.push(res.stdout); } });
		assert.deepStrictEqual(seen, ['before\n']);
		assert.strictEqual(r.exitCode, 126);
		const { sh: sh2 } = bash({});
		const seen2 = [];
		const r2 = await sh2.exec('echo a; exit 3; echo b', { onStatement: async (res) => { seen2.push(res.stdout); } });
		assert.deepStrictEqual(seen2, ['a\n']);
		assert.strictEqual(r2.exitCode, 3);
	});

	/* ------------------------------------------------------------------------------------------ LC-2 */

	test('LC-2: a glob that ends in a slash matches directories only, and keeps the slash', async () => {
		const { sh } = bash({ '/w/a/f': '1', '/w/b/g': '2', '/w/c.txt': '3' });
		const r = await sh.exec('echo */; for d in */; do echo "[$d]"; done; echo *.txt; echo */ | wc -w');
		assert.strictEqual(r.stdout, 'a/ b/\n[a/]\n[b/]\nc.txt\n2\n');
	});

	/* ------------------------------------------------------------------------------------------ LC-3 */

	test('LC-3: a `$` in arithmetic that cannot start a name is a syntax error, at once, in every form', async () => {
		const { sh } = bash({});
		for (const s of ['echo $(( $ ))', 'echo $(( 1 + $ ))', '(( x = $ ))', 'echo $(( $ + 1 ))', 'let "y = $"']) {
			const t0 = Date.now();
			const r = await sh.exec(s + '; echo after');
			assert.ok(Date.now() - t0 < 1500, s + ' took ' + (Date.now() - t0) + ' ms');
			assert.ok(/syntax error/.test(r.stderr), s + ': ' + JSON.stringify(r.stderr));
			assert.ok(r.stdout.endsWith('after\n'), s);
		}
		const ok = await sh.exec('x=7; echo $(( 2 + 3 * 4 )) $(( x * 2 )) $(( $x + 1 ))');
		assert.strictEqual(ok.stdout, '14 14 8\n');
	});

	/* ------------------------------------------------------------------------------------------ LC-4 */

	test('LC-4: read, while-read and mapfile give UTF-8 text, and writing it back is the same bytes', async () => {
		const { fs: fsys, sh } = bash({ '/w/in.txt': 'café\nnaïve\n日本語\n' });
		const r = await sh.exec(`
			read -r l < in.txt; echo "\${#l}"; [ "$l" = café ] && echo equal
			while IFS= read -r line; do echo "$line" >> out.txt; done < in.txt
			diff -q in.txt out.txt && echo same
			mapfile -t a < in.txt; echo "\${#a[0]} \${a[2]}"; printf '%s\\n' "\${a[@]}" > out2.txt
			readarray -t b < in.txt; echo "\${b[1]}"
			read -r -a w <<< 'é ü'; echo "\${#w[@]} \${w[1]}"
			echo ${'${l^^}'}
		`);
		assert.strictEqual(r.stderr, '');
		assert.strictEqual(r.stdout, '4\nequal\nsame\n4 日本語\nnaïve\n2 ü\nCAFÉ\n');
		const bytes = (p) => Buffer.from(fsys.readFileSync ? fsys.readFileSync(p) : '');
		void bytes;
		assert.strictEqual(await fsys.readFile('/w/out.txt'), 'café\nnaïve\n日本語\n');
		assert.strictEqual(await fsys.readFile('/w/out2.txt'), 'café\nnaïve\n日本語\n');
	});

	test('LC-4: bytes that are not UTF-8 stay one character per byte (the decode is all or nothing)', async () => {
		const { sh } = bash({ '/w/bin': new Uint8Array([0x63, 0xe9, 0x0a]), '/w/ok': 'c\u00e9\n' });
		const r = await sh.exec('read -r x < bin; echo "${#x}"; read -r y < ok; echo "${#y}"; read -r z <<< abc; echo "$z"');
		assert.strictEqual(r.stdout, '2\n2\nabc\n');
		const { sh: sh2 } = bash({ '/w/two': new Uint8Array([0xc3, 0xa9, 0x0a]) });
		assert.strictEqual((await sh2.exec('read -r x < two; echo "${#x}"')).stdout, '1\n');
	});

	/* ------------------------------------------------------------------------------------------ LC-5 */

	class ReadOnly extends E.InMemoryFs {
		constructor(code) { super(); this.code = code; }
		async writeFile(p, c, e) { if (p.startsWith('/ro/')) { throw Object.assign(new Error(this.code + ': refused, open \'' + p + '\''), { code: this.code }); } return super.writeFile(p, c, e); }
		async appendFile(p, c, e) { if (p.startsWith('/ro/')) { throw Object.assign(new Error(this.code + ': refused, open \'' + p + '\''), { code: this.code }); } return super.appendFile(p, c, e); }
	}

	test('LC-5: a redirection that cannot open its target is `bash: f: reason`, status 1, the command not run, the script going on', async () => {
		for (const [code, text] of [['ENOENT', 'No such file or directory'], ['EACCES', 'Permission denied'], ['EPERM', 'Permission denied'], ['EISDIR', 'Is a directory'], ['ENOTDIR', 'Not a directory'], ['EROFS', 'Read-only file system'], ['ENOSPC', 'No space left on device'], ['EIO', 'cannot open redirect target']]) {
			const fsys = new ReadOnly(code);
			fsys.mkdirSync('/w', { recursive: true });
			const sh = new E.Bash({ fs: fsys, cwd: '/w' });
			// every form that opens a file
			const r = await sh.exec('echo before; echo x > /ro/f; echo "rc=$?"; echo y >> /ro/f; echo "rc=$?"; echo z &> /ro/g; echo "rc=$?"; touch /w/ran; echo after');
			assert.strictEqual(r.stdout, 'before\nrc=1\nrc=1\nrc=1\nafter\n', code);
			assert.strictEqual(r.stderr, `bash: /ro/f: ${text}\nbash: /ro/f: ${text}\nbash: /ro/g: ${text}\n`, code);
			assert.strictEqual(r.exitCode, 0, code);
			assert.ok(await fsys.exists('/w/ran'), code);
		}
	});

	test('LC-5: the command of a refused redirection does not run (nothing printed, no side effect)', async () => {
		const fsys = new ReadOnly('EACCES');
		fsys.mkdirSync('/w', { recursive: true });
		const sh = new E.Bash({ fs: fsys, cwd: '/w' });
		const r = await sh.exec('touch /w/a > /ro/x; ls /w; rm -f /w/nothing > /ro/y; echo done');
		assert.strictEqual(r.stdout, 'done\n');
		assert.deepStrictEqual(await fsys.readdir('/w'), []);
	});

	/* ------------------------------------------------------------------------------------------ LC-6 */

	test('LC-6: the result keeps the raw bytes the statement hook saw, which the final stdout has decoded', async () => {
		// a command that returns BYTES, one character each (the UTF-8 of "é"): printf and the rest make the character itself
		// since LC-29, so one is made here, the way a program of a later version might
		const { sh } = bash({}, { customCommands: [E.defineCommand('rawbytes', async () => ({ stdout: 'caf\u00c3\u00a9\n', stderr: '', exitCode: 0 }))] });
		const seen = [];
		const r = await sh.exec('rawbytes; echo plain', { onStatement: async (res) => { seen.push(res.stdout); } });
		assert.strictEqual(r.stdout, 'caf\u00e9\nplain\n', 'the final stdout is decoded UTF-8 text');
		assert.strictEqual(r.lcRaw.stdout, 'caf\u00c3\u00a9\nplain\n', 'the raw string is one character per byte');
		assert.strictEqual(seen.join(''), r.lcRaw.stdout, 'what the hook saw, joined, is the raw string');
		const e = await sh.exec('echo err >&2; cat /nope');
		assert.strictEqual(e.lcRaw.stderr, e.stderr);
		assert.strictEqual((await sh.exec('')).lcRaw, undefined, 'an empty script has nothing to keep');
	});

	test('LC-6: what a statement that ends the script printed is in the raw result and not in the hook', async () => {
		const { sh } = bash({});
		const seen = [];
		const r = await sh.exec('echo a; { echo b; exit 2; }; echo c', { onStatement: async (res) => { seen.push(res.stdout); } });
		assert.deepStrictEqual(seen, ['a\n']);
		assert.strictEqual(r.lcRaw.stdout, 'a\nb\n');
		assert.strictEqual(r.exitCode, 2);
	});

	/* ------------------------------------------------------------------------------------------ LC-7 */

	test('LC-7: tar, yq, xan, python3, sqlite3 are "command not found" like git, with the shell\'s own words and 127', async () => {
		const { sh } = bash({});
		for (const name of ['tar', 'yq', 'xan', 'python3', 'python', 'sqlite3', 'git', 'curl', 'js-exec', 'node']) {
			const r = await sh.exec(`${name} --version; echo "rc=$?"`);
			assert.strictEqual(r.stderr, `bash: ${name}: command not found\n`, name);
			assert.strictEqual(r.stdout, 'rc=127\n', name);
		}
		assert.ok(!/Node\.js|browser environments|Exclude/.test((await sh.exec('python3')).stderr));
	});

	/* ------------------------------------------------------------------------------------------ LC-8 */

	test('LC-8: ls -l shows the mode the file system reports, for files, directories and a named file', async () => {
		const { sh } = bash({ '/w/f': 'x', '/w/s.sh': '#!/bin/sh\n', '/w/d/g': 'y' });
		const r = await sh.exec('chmod 700 f; chmod 755 s.sh; chmod 511 d; ls -l | awk \'{print $1, $NF}\'; ls -ld d f | awk \'{print $1, $NF}\'; ls -l f | awk \'{print $1}\'');
		assert.strictEqual(r.stdout, 'total 3\ndr-x--x--x d\n-rwx------ f\n-rwxr-xr-x s.sh\ndr-x--x--x d\n-rwx------ f\n-rwx------\n');
		const fresh = bash({}).sh;
		const plain = await fresh.exec('touch n; mkdir m; ls -l | awk \'{print $1, $NF}\' | tail -n 2');
		assert.strictEqual(plain.stdout, 'drwxr-xr-x m\n-rw-r--r-- n\n');
	});

	test('LC-9: sort compares in byte order, in every path that compares whole lines (the browser\'s locale is not asked)', async () => {
		const { sh } = bash({});
		const run = async (script) => (await sh.exec(script)).stdout;
		assert.strictEqual(await run("printf 'b\\nB\\na\\nA\\n_x\\n1\\n' | sort"), '1\nA\nB\n_x\na\nb\n');
		assert.strictEqual(await run("printf 'b\\nB\\na\\nA\\n' | sort -r"), 'b\na\nB\nA\n');
		assert.strictEqual(await run("printf '1 b\\n1 B\\n1 a\\n2 A\\n' | sort -n"), '1 B\n1 a\n1 b\n2 A\n', 'a tie on the number is broken by the whole line');
		assert.strictEqual(await run("printf 'b 1\\na 1\\nB 1\\nA 1\\n' | sort -k2,2"), 'A 1\nB 1\na 1\nb 1\n', 'a tie on the key too');
		assert.strictEqual(await run("printf 'b 1\\na 1\\nB 1\\nA 1\\n' | sort -r -k2,2"), 'b 1\na 1\nB 1\nA 1\n');
		assert.strictEqual(await run("printf 'b\\nB\\nb\\n' | sort -u"), 'B\nb\n');
	});

	/* ------------------------------------------------------------------------------------------ LC-9, extended */

	/** String.prototype.localeCompare as a Swedish-like collation: case-insensitive first, "ä" after "z" */
	const withCollation = async (fn) => {
		const real = String.prototype.localeCompare;
		const key = (s) => s.toLowerCase().replace(/[äå]/g, '{').replace(/ö/g, '|');
		String.prototype.localeCompare = function (o) { const a = key(String(this)); const b = key(String(o)); return a < b ? -1 : a > b ? 1 : 0; };
		try { return await fn(); } finally { String.prototype.localeCompare = real; }
	};

	test('LC-10: the file has 14 TextDecoders and 8 TextEncoders, and which of them see bytes of a file or a pipe has been looked at (a bump that adds one fails here)', () => {
		assert.strictEqual(count(original, 'new TextDecoder'), 14);
		assert.strictEqual(count(original, 'new TextEncoder'), 8);
		const r = patchMod.applyPatches(original);
		// a BOM is kept by the decoder of byte strings (M8), by that of a command's result (h$), and by curl's, which had it
		assert.strictEqual(count(r.text, 'ignoreBOM:!0'), 3);
		// the uses of the module: the byte-string decoder (`__lcUtf8` of `read` and `mapfile`), the lossless decoder and the
		// encoder of the patched `fe` and `Pn`, and in the header what LC-29 added: `__lcBytes` (a run of escaped bytes) and
		// `__lcHeal` (the escapes of one string that are UTF-8 together), LC-41's `__lcVer` (the version comparison) and
		// LC-52's `__lcDev` (what a command wrote to /dev/stdout, as the bytes a binary result holds) and LC-59's `__lcList`
		// (the bytes of the pattern space, which `l` shows in octal)
		assert.strictEqual(count(r.text, '__lcText.'), 8);
	});

	test('LC-9: the patched file has no localeCompare left at all (a new one in a bumped file fails here)', () => {
		const r = patchMod.applyPatches(original);
		assert.strictEqual(count(original, 'localeCompare'), 12, 'what the published file has');
		assert.strictEqual(count(r.text, 'localeCompare'), 0);
	});

	test('LC-9: the order of everything the engine sorts is by code point, whatever the collation of the process', async () => {
		const files = { '/w/B': 'b', '/w/a': 'a', '/w/A': 'a', '/w/_x': 'x', '/w/z': 'z', '/w/ä': 'ae', '/w/sub/b': 'b', '/w/sub/A': 'a', '/w/sub/a': 'a', '/w/sub/Z': 'z', '/w/sub/.h': 'h' };
		// each line: what it prints, in code point order (a collation that ignores case would put A a b Z, and ä after z)
		const steps = [
			['a glob', 'echo *', 'A B _x a sub z ä'],
			['find', "find . -type f | tr '\n' ' '", './A ./B ./_x ./a ./sub/.h ./sub/A ./sub/Z ./sub/a ./sub/b ./z ./ä '],
			// (LC-61: grep -r reads the dot entries too, as GNU grep does: `.h` is the first by code point)
			['grep -r', "grep -r '' sub | tr '\n' ' '", 'sub/.h:h sub/A:a sub/Z:z sub/a:a sub/b:b '],
			['a pattern grep expands itself', "grep '' 'sub/[a-zA-Z]' | tr '\n' ' '", 'sub/A:a sub/Z:z sub/a:a sub/b:b '],
			['sort -V', "printf 'v10\nv2\nV2\nv1\n' | sort -V | tr '\n' ' '", 'V2 v1 v2 v10 '],
			['tree', "tree sub | head -n 5 | tr '\n' ' '", 'sub |-- A |-- Z |-- a `-- b '],
			['tree -a', "tree -a sub | head -n 3 | tr '\n' ' '", 'sub |-- .h |-- A '],
			['jq sort', "echo '[\"z\",\"B\",\"a\",\"A\",\"ä\",\"_\"]' | jq -c sort", '["A","B","_","a","z","ä"]'],
			['jq unique', "echo '[\"z\",\"B\",\"a\",\"A\",\"ä\",\"_\"]' | jq -c unique", '["A","B","_","a","z","ä"]'],
			['jq min max', "echo '[\"z\",\"B\",\"a\",\"A\",\"ä\",\"_\"]' | jq -c 'min, max' | tr '\n' ' '", '"A" "ä" '],
			['jq keys', "echo '{\"b\":1,\"B\":2,\"a\":3,\"ä\":4}' | jq -c keys", '["B","a","b","ä"]'],
			['jq to_entries is in insertion order', "echo '{\"b\":1,\"B\":2,\"a\":3,\"ä\":4}' | jq -c 'to_entries|map(.key)'", '["b","B","a","ä"]'],
			['jq sort_by group_by unique_by', "echo '[{\"k\":\"b\"},{\"k\":\"B\"},{\"k\":\"a\"}]' | jq -c 'sort_by(.k)|map(.k), (group_by(.k)|map(.[0].k)), (unique_by(.k)|map(.k))' | tr '\n' ' '", '["B","a","b"] ["B","a","b"] ["B","a","b"] '],
			['jq string comparison', "jq -n '\"a\" < \"B\", \"B\" < \"a\", (\"Z\" < \"a\"), (\"b\" >= \"B\")' | tr '\n' ' '", 'false true true true '],
			['jq sort of objects (by their keys)', "echo '[{\"a\":1},{\"B\":2},{\"A\":3}]' | jq -c sort", '[{"A":3},{"B":2},{"a":1}]'],
		];
		const run = async (script) => {
			const { sh } = bash(files);
			const r = await sh.exec(script);
			assert.strictEqual(r.stderr, '', script);
			return r.stdout.replace(/\n$/, '');
		};
		for (const [what, script, want] of steps) {
			assert.strictEqual(await run(script), want, what);
			assert.strictEqual(await withCollation(() => run(script)), want, what + ' (collation of the process: Swedish)');
		}
		const opts = await run('echo $SHELLOPTS');
		assert.ok(/^braceexpand:/.test(opts), opts);
	});

	test('LC-9: jq\'s sort, unique and group_by are sorted by key (unique kept the order of appearance, group_by too)', async () => {
		const { sh } = bash({});
		const run = async (q, input) => (await sh.exec(`echo '${input}' | jq -c '${q}'`)).stdout;
		assert.strictEqual(await run('unique', '["z","B","a","A","_","1","b","a"]'), '["1","A","B","_","a","b","z"]\n');
		assert.strictEqual(await run('unique', '[3,1,2,1,null,"a",true,[1],{"a":1}]'), '[null,true,1,2,3,"a",[1],{"a":1}]\n');
		assert.strictEqual(await run('group_by(.)', '["b","A","a","B","b"]'), '[["A"],["B"],["a"],["b","b"]]\n');
		assert.strictEqual(await run('group_by(.k)|map(map(.n))', '[{"k":"y","n":1},{"k":"x","n":2},{"k":"y","n":3}]'), '[[2],[1,3]]\n');
		assert.strictEqual(await run('group_by(.[0:1])|length', '["ab","Ac","ad","Ae"]'), '2\n');
		// the order of code points, not of UTF-16 units: U+FF5E is below U+1F600 although its units are above
		assert.strictEqual(await run('sort', '["\\uff5e","\\ud83d\\ude00","z"]'), '["z","\\uff5e","\\ud83d\\ude00"]\n'.replace('\\uff5e', '\uff5e').replace('\\ud83d\\ude00', '\ud83d\ude00'));
	});

	test('LC-9: a process whose own locale is not English orders the same (the locale of this process is asked of ICU, in a child)', () => {
		const probe = spawnSync(process.execPath, ['-e', "console.log(['z','ä','a','B'].sort((a,b)=>a.localeCompare(b)).join(''))"], { encoding: 'utf8', env: Object.assign({}, process.env, { LC_ALL: 'sv_SE.UTF-8', LANG: 'sv_SE.UTF-8', LANGUAGE: 'sv' }) });
		const swedish = probe.stdout.trim() === 'aBzä';
		if (!swedish) {
			console.log('  note - this node does not take its default locale from LC_ALL (' + JSON.stringify(probe.stdout.trim()) + '); the collation was replaced by a stand-in above');
			return;
		}
		const script = path.join(os.tmpdir(), 'lc-locale-' + process.pid + '.js');
		fs.writeFileSync(script, `
			const { loadEngine } = require(${JSON.stringify(path.join(__dirname, 'shell-engine-support.js'))});
			(async () => {
				const E = await loadEngine();
				const fsys = new E.InMemoryFs();
				fsys.mkdirSync('/w', { recursive: true });
				for (const n of ['B', 'a', 'A', 'z', 'ä']) { fsys.writeFileSync('/w/' + n, 'x'); }
				const sh = new E.Bash({ fs: fsys, cwd: '/w' });
				const r = await sh.exec("echo *; printf 'z\\\\nB\\\\na\\\\nA\\\\nä\\\\n' | sort | tr '\\\\n' ' '; echo; echo '[\\"z\\",\\"B\\",\\"a\\",\\"ä\\"]' | jq -c sort");
				process.stdout.write(r.stdout);
			})();
		`);
		try {
			const out = spawnSync(process.execPath, [script], { encoding: 'utf8', env: Object.assign({}, process.env, { LC_ALL: 'sv_SE.UTF-8', LANG: 'sv_SE.UTF-8' }) });
			assert.strictEqual(out.stdout, 'A B a z ä\nA B a z ä \n["B","a","z","ä"]\n', out.stderr);
		} finally {
			fs.rmSync(script, { force: true });
		}
	});

	/* ------------------------------------------------------------------------------------------ LC-10 */

	test('LC-10: bytes that are not UTF-8 go through cat, a pipe, $(...), sort, tee, grep, awk, tr, cut and back out unchanged', async () => {
		const lat = new Uint8Array([0x63, 0x61, 0x66, 0xe9, 0x0a, 0x61, 0x62, 0x63, 0x0a]);
		const { fs: fsys, sh } = overlayBash({ '/w/lat': lat });
		const r = await sh.exec('cat lat | cat > c1; x=$(cat lat); printf "%s\\n" "$x" > c2; sort -o s1 lat; tee t1 < lat > /dev/null; grep a lat > g1; awk "{print}" lat > a1; tr a-z A-Z < lat > r1; cut -c1-4 lat > u1; paste lat > p1; head -n 1 lat > h1; tail -n 1 lat > l1; sed -n 1p lat > e1; rev lat > v1; uniq lat > q1; cat lat > c3; wc -c lat');
		assert.strictEqual(r.stderr, '');
		const bytes = async (p) => [...await fsys.readFileBuffer(p)];
		const first = [0x63, 0x61, 0x66, 0xe9, 0x0a];
		assert.deepStrictEqual(await bytes('/w/c1'), [...lat]);
		assert.deepStrictEqual(await bytes('/w/c3'), [...lat]);
		assert.deepStrictEqual(await bytes('/w/c2'), [...lat]);
		assert.deepStrictEqual(await bytes('/w/s1'), [0x61, 0x62, 0x63, 0x0a, 0x63, 0x61, 0x66, 0xe9, 0x0a]);
		assert.deepStrictEqual(await bytes('/w/t1'), [...lat]);
		assert.deepStrictEqual(await bytes('/w/g1'), [...lat]);
		assert.deepStrictEqual(await bytes('/w/a1'), [...lat]);
		assert.deepStrictEqual(await bytes('/w/r1'), [0x43, 0x41, 0x46, 0xe9, 0x0a, 0x41, 0x42, 0x43, 0x0a]);
		assert.deepStrictEqual(await bytes('/w/u1'), [...lat]);
		assert.deepStrictEqual(await bytes('/w/p1'), [...lat]);
		assert.deepStrictEqual(await bytes('/w/h1'), first);
		assert.deepStrictEqual(await bytes('/w/e1'), first);
		assert.deepStrictEqual(await bytes('/w/q1'), [...lat]);
		assert.strictEqual(r.stdout.trim(), '9 lat');
	});

	test('LC-10: a UTF-8 BOM and a NUL are kept; text with letters of U+0080..U+00FF is not mistaken for bytes', async () => {
		const bom = new Uint8Array([0xef, 0xbb, 0xbf, 0x68, 0x69, 0x0a]);
		const { fs: fsys, sh } = overlayBash({ '/w/bom': bom, '/w/nul': new Uint8Array([0x61, 0x00, 0x62, 0x0a]), '/w/utf': 'café ñ ü\n' });
		const r = await sh.exec('cat bom | cat > b1; echo "$(cat bom)" > b2; sed -i s/zzz/y/ bom nul utf; cat nul | cat > n1; cat utf | cat; cat utf | sort; echo naïve; echo "$(cat utf)"; cut -f1 utf');
		assert.deepStrictEqual([...await fsys.readFileBuffer('/w/b1')], [...bom]);
		assert.deepStrictEqual([...await fsys.readFileBuffer('/w/b2')], [...bom]);
		assert.deepStrictEqual([...await fsys.readFileBuffer('/w/n1')], [0x61, 0x00, 0x62, 0x0a]);
		assert.strictEqual(r.stdout, 'café ñ ü\ncafé ñ ü\nnaïve\ncafé ñ ü\ncafé ñ ü\n');
		assert.deepStrictEqual([...await fsys.readFileBuffer('/w/bom')], [...bom], 'sed -i with no match writes the same bytes');
	});

	test('LC-10: the escape of a byte is a lone U+DC80..U+DCFF in the engine\'s text, and only there (it goes back to the byte)', async () => {
		const { sh } = overlayBash({ '/w/lat': new Uint8Array([0x61, 0xe9, 0x0a]) });
		const r = await sh.exec('x=$(cat lat); echo "${#x}"; y="${x}z"; printf "%s" "$y" | od -An -b');
		assert.strictEqual(r.stdout, '2\n 141 351 172\n', 'two characters (a and the byte), and the byte is back after a string operation');
	});

	/* ------------------------------------------------------------------------------------------ LC-11, LC-12 */

	test('LC-11: `$a\\`, `a\\`, `i\\` and `c\\` with no text print nothing and add a missing newline, as GNU does', async () => {
		const { sh } = bash({});
		const run = async (input, script) => (await sh.exec(`printf '${input}' | sed '${script}' | od -An -c | tr -s ' ' | tr '\\n' ' '`)).stdout;
		assert.strictEqual(await run('x', '$a\\'), ' x \\n ');
		assert.strictEqual(await run('a\\nb\\n', '$a\\'), ' a \\n b \\n ');
		assert.strictEqual(await run('a\\nb\\n', 'a\\'), ' a \\n b \\n ');
		assert.strictEqual(await run('a\\nb', '1a\\'), ' a \\n b ', 'the last line was not touched: still no newline');
		assert.strictEqual(await run('a\\nb\\n', 'i\\'), ' a \\n b \\n ');
		assert.strictEqual(await run('a\\nb\\nc\\nd\\n', '2,3c\\'), ' a \\n d \\n ');
		assert.strictEqual(await run('a\\nb', '$c\\'), ' a \\n ');
		// with a text after the backslash, on the line (GNU one-liner) or the next, nothing changes
		assert.strictEqual(await run('a\\n', '$a\\\nTAIL'), ' a \\n T A I L \\n ');
		assert.strictEqual(await run('a\\n', '1i\\\nHEAD'), ' H E A D \\n a \\n ');
		// -e pieces: a trailing `a\\` takes the next -e as its text, as GNU does
		const e = await sh.exec("printf 'a\\n' | sed -e '$a\\' -e 'TAIL'");
		assert.strictEqual(e.stdout, 'a\nTAIL\n');
		// -i: the idiom that gives a file its final newline
		const { fs: fsys, sh: sh2 } = bash({ '/w/f': 'x', '/w/g': 'x\n' });
		await sh2.exec("sed -i -e '$a\\' f g");
		assert.strictEqual(await fsys.readFile('/w/f'), 'x\n');
		assert.strictEqual(await fsys.readFile('/w/g'), 'x\n');
	});

	test('LC-12: `c` on a range prints its text once, at the end of the range; once per line when negated, in a block or on a step', async () => {
		const { sh } = bash({});
		const run = async (input, script) => (await sh.exec(`printf '${input}' | sed '${script}' | tr '\\n' ' '`)).stdout;
		const abcd = 'a\\nb\\nc\\nd\\n';
		assert.strictEqual(await run(abcd, '2,3c X'), 'a X d ');
		assert.strictEqual(await run(abcd, '/b/,/c/c X'), 'a X d ');
		assert.strictEqual(await run(abcd, '2,$c X'), 'a X ');
		assert.strictEqual(await run(abcd, '3,2c X'), 'a b X d ');
		assert.strictEqual(await run(abcd, '/b/,/zzz/c X'), 'a ', 'a range that never ends never prints');
		assert.strictEqual(await run(abcd, '2,100c X'), 'a ');
		assert.strictEqual(await run(abcd, '2,3!c X'), 'X b c X ');
		assert.strictEqual(await run(abcd, '2,3{c X\n}'), 'a X X d ');
		assert.strictEqual(await run(abcd, '2c X'), 'a X c d ');
		assert.strictEqual(await run(abcd, '/b/c X'), 'a X c d ');
		assert.strictEqual(await run(abcd, '1,2c X'), 'X c d ');
		assert.strictEqual(await run(abcd, '2,+1c X'), 'a X d ');
		// two ranges, one after the other
		assert.strictEqual(await run(abcd, '1,2c X\n3,4c Y'), 'X Y ');
	});

	/* ------------------------------------------------------------------------------------------ LC-13, LC-14, LC-15 */

	test('LC-13: a bare `length` is length($0) in every place an expression is', async () => {
		const { sh } = bash({});
		const run = async (prog, input = 'foo bar\\nHello\\nHello World\\n') => (await sh.exec(`printf '${input}' | awk '${prog}' | tr '\\n' ' '`)).stdout;
		assert.strictEqual(await run('{print length}'), '7 5 11 ');
		assert.strictEqual(await run('length > 5'), 'foo bar Hello World ');
		assert.strictEqual(await run('{ n += length } END { print n }'), '23 ');
		assert.strictEqual(await run('{print length()}'), '7 5 11 ');
		assert.strictEqual(await run('{print length($0)}'), '7 5 11 ');
		assert.strictEqual(await run('{print length($1)}'), '3 5 5 ');
		assert.strictEqual(await run('BEGIN{print length("abcd")}', ''), '4 ');
		assert.strictEqual(await run('length == 0 { print NR }', 'a\\n\\nb\\n'), '2 ');
		assert.strictEqual(await run('{ if (length > 5) print "long"; else print "short" }'), 'long short long ');
		assert.strictEqual(await run('{ print length * 2 }'), '14 10 22 ');
		assert.strictEqual(await run('{ x = length; print x }'), '7 5 11 ');
	});

	test('LC-14: grep -o with a pattern that can match nothing prints the non-empty matches, skips the empty ones, and never fails at the end of a line', async () => {
		const { sh } = bash({ '/w/a.txt': 'abc\nxyz\n123\n', '/w/b.txt': 'ab\n', '/w/f.txt': 'abb\nxyz\nbab\n' });
		const run = async (script) => (await sh.exec(script)).stdout;
		const both = async (script) => { const r = await sh.exec(script); return [r.stdout, r.stderr]; };
		assert.strictEqual(await run("printf 'abb\\n' | grep -o 'b*'"), 'bb\n');
		assert.strictEqual(await run("printf 'aab\\n' | grep -o 'a*'"), 'aa\n');
		assert.strictEqual(await run("printf 'abc\\n' | grep -o '[0-9]*'; echo rc=$?"), 'rc=0\n', 'the line matched (with nothing): status 0, nothing printed');
		assert.strictEqual(await run("printf 'x1y22\\n' | grep -oE '[0-9]*'"), '1\n22\n');
		assert.strictEqual(await run("printf 'hello\\n' | grep -o 'l*'"), 'll\n');
		assert.strictEqual(await run('grep -o "[0-9]*" a.txt; echo rc=$?'), '123\nrc=0\n');
		assert.strictEqual(await run('grep -on "[a-c]*" a.txt'), '1:abc\n');
		assert.strictEqual(await run('grep -o "x*" a.txt b.txt; echo rc=$?'), 'a.txt:xyz\n'.replace('a.txt:xyz', 'a.txt:x') + 'rc=0\n');
		assert.strictEqual(await run('grep -c "b*" a.txt'), '3\n');
		assert.strictEqual(await run("printf 'abab\\n' | grep -o 'ab*'"), 'ab\nab\n');
		assert.strictEqual(await run("printf 'aXbX\\n' | grep -o 'X*'"), 'X\nX\n');
		// the other loops that step over an empty match: with context lines, counting matches, rg's vimgrep format
		assert.deepStrictEqual(await both("grep -o -A1 'b*' f.txt"), ['bb\nxyz\nbab\n', ''], 'the matches, then the context line, no failure at the end of a line');
		assert.deepStrictEqual(await both("grep -on -C1 'b*' f.txt | head -n 1"), ['1:bb\n', '']);
		assert.deepStrictEqual(await both("rg --count-matches 'b*' f.txt b.txt"), ['b.txt:1\nf.txt:3\n', ''], 'empty matches are not counted');
		const vim = await both("rg --vimgrep 'b*' f.txt");
		assert.strictEqual(vim[1], '');
		assert.ok(vim[0].startsWith('1:1:abb\n1:2:abb\n1:4:abb\n2:1:xyz\n'), 'every position is looked at once, the "bb" at column 2 is not stepped over: ' + vim[0]);
	});

	test('LC-15: cut -f prints a line without the delimiter whole, unless -s', async () => {
		const { sh } = bash({});
		const run = async (script) => (await sh.exec(script)).stdout;
		assert.strictEqual(await run("printf 'a,b\\nx\\n' | cut -d, -f2"), 'b\nx\n');
		assert.strictEqual(await run("printf 'a,b\\nx\\n' | cut -s -d, -f2"), 'b\n');
		assert.strictEqual(await run("printf 'a,b\\nx\\n' | cut -d, -f1"), 'a\nx\n');
		assert.strictEqual(await run("printf 'a\\tb\\nx\\n' | cut -f2"), 'b\nx\n');
		assert.strictEqual(await run("printf 'a,b,c\\nxyz\\n' | cut -d, -f1,3"), 'a,c\nxyz\n');
		assert.strictEqual(await run("printf 'a,b\\n\\n' | cut -d, -f2"), 'b\n\n', 'an empty line has no delimiter either');
	});

	/* ------------------------------------------------------------------------------------------ LC-16, LC-17, LC-18 */

	test('LC-16: every Date of the engine is the shell\'s: the zone of the process is never asked, the command\'s TZ is', async () => {
		const was = process.env.TZ;
		try {
			for (const zone of ['UTC', 'America/New_York', 'Asia/Tokyo']) {
				process.env.TZ = zone;
				const { fs: fsys, sh } = bash({ '/w/f': 'x', '/w/old': 'o', '/w/new': 'n' });
				// the times a stat hands out are LcDate, as the overlay's are
				const D = require(path.join(ENGINE, 'zone.js')).LcDate;
				await fsys.utimes('/w/f', new D(1580000000000), new D(1580000000000));
				await fsys.utimes('/w/old', new D(1000000), new D(1000000));
				await fsys.utimes('/w/new', new D(2000000), new D(2000000));
				const r = await sh.exec("date -u -d '2020-02-29 12:00:00' '+%F %T'; date -d '2020-02-29 12:00:00' +%s; date -d 'Feb 29 2020 12:00' '+%F %T'; date -d '2020-02-29 12:00:00 +0100' +%s; TZ=Asia/Tokyo date -d '2020-02-29 12:00:00' +%s; TZ=Asia/Tokyo date -d '@0' '+%F %T'; ls -l f | awk '{print $6, $7, $8}'; TZ=America/New_York ls -l f | awk '{print $6, $7, $8}'; find . -type f -newer old | sort | tr '\n' ' '; echo; echo $(( $(date -d '2020-01-01' +%s) % 86400 ))");
				assert.strictEqual(r.stderr, '', zone);
				assert.strictEqual(r.stdout, [
					'2020-02-29 12:00:00', '1582977600', '2020-02-29 12:00:00', '1582974000',
					'1582945200', '1970-01-01 09:00:00',
					'Jan 26 2020', 'Jan 25 2020',
					'./f ./new ', '0',
				].join('\n') + '\n', zone + ': ' + r.stdout);
			}
		} finally {
			if (was === undefined) { delete process.env.TZ; } else { process.env.TZ = was; }
		}
	});

	test('LC-17: echo, printf, pwd, alias, unalias and history are found without PATH, like the builtins of bash; cat is not', async () => {
		const { sh } = bash({ '/w/f': 'x\n' });
		const r = await sh.exec('PATH=/nonexistent; echo a; printf "b\\n"; pwd; alias foo=bar; unalias foo; history | wc -l; cat f; echo "rc=$?"');
		assert.ok(r.stdout.startsWith('a\nb\n/w\n'), r.stdout);
		assert.ok(r.stdout.includes('rc=127'), r.stdout);
		assert.ok(/cat: command not found/.test(r.stderr), r.stderr);
		const q = await sh.exec('PATH=/x:/y; command -v echo; echo "rc=$?"; echo hi | cat');
		assert.ok(/echo/.test(q.stdout), q.stdout);
	});

	test('LC-18: the thirteen builtins that are declared and not implemented are not found, listed or documented', async () => {
		const names = ['bg', 'caller', 'disown', 'enable', 'fc', 'fg', 'jobs', 'kill', 'suspend', 'times', 'trap', 'ulimit', 'umask'];
		const { sh } = bash({});
		const r = await sh.exec(`command -v ${names.join(' ')}; echo "found=$?"; type trap umask 2>&1; help | tr -s ' ' '\\n' | grep -c -x -e ${names.join(' -e ')}; help cd | head -1; command -v cd read wait history help builtin`);
		const lines = r.stdout.split('\n');
		assert.strictEqual(lines[0], 'found=1');
		assert.ok(/not found/.test(lines[1]) && /not found/.test(lines[2]), r.stdout);
		assert.strictEqual(lines[3], '0');
		assert.ok(lines[4].startsWith('cd:'), lines[4]);
		assert.deepStrictEqual(lines.slice(5, 11), ['cd', 'read', 'wait', 'history', 'help', 'builtin']);
		for (const n of names) {
			const x = await sh.exec(`${n} 2>&1 </dev/null; echo "rc=$?"`);
			assert.strictEqual(x.stdout, `bash: ${n}: command not found\nrc=127\n`, n);
		}
	});

	/* ------------------------------------------------------------------------------------------ LC-19 .. LC-25 */

	/** each of the three zones a PROCESS may be in (the visitor's, in a browser): the answer must not move */
	const inProcessZones = async (fn) => {
		const was = process.env.TZ;
		try {
			for (const zone of ['UTC', 'America/New_York', 'Asia/Tokyo']) {
				process.env.TZ = zone;
				await fn(zone);
			}
		} finally {
			if (was === undefined) { delete process.env.TZ; } else { process.env.TZ = was; }
		}
	};

	test('LC-19: printf \'%(fmt)T\' formats in the command\'s zone, never the process\'s; %Z is GNU\'s abbreviation (JST, EDT), not Intl\'s GMT+9', async () => {
		await inProcessZones(async (zone) => {
			const { sh } = bash({});
			const r = await sh.exec(`printf '%(%F %T %Z %z)T\\n' 1600000000; TZ=Asia/Tokyo printf '%(%F %T %Z %z)T\\n' 1600000000; export TZ=America/New_York; printf '%(%F %T %Z)T\\n' 1600000000; printf '%(%F %T %Z)T\\n' 1610000000; export TZ=Asia/Tokyo; printf '%(%Z)T\\n' -1; printf '%(%Z)T\\n' -2; export TZ=Asia/Kolkata; printf '%(%Z)T\\n' 0; export TZ=Asia/Dubai; printf '%(%Z)T\\n' 0`);
			assert.strictEqual(r.stderr, '', zone);
			assert.strictEqual(r.stdout, ['2020-09-13 12:26:40 UTC +0000', '2020-09-13 21:26:40 JST +0900', '2020-09-13 08:26:40 EDT', '2021-01-07 01:13:20 EST', 'JST', 'JST', 'IST', '+04'].join('\n') + '\n', zone + ': ' + r.stdout);
		});
	});

	test('LC-20: date -u reads the string in UTC even when TZ names a zone, -I prints what GNU does, and a TZ that is not exported is not the zone', async () => {
		await inProcessZones(async (zone) => {
			const { sh } = bash({});
			const r = await sh.exec(`export TZ=America/New_York; date -u -d '2020-02-29 12:00:00' '+%F %T %Z'; date -d '2020-02-29 12:00:00' '+%F %T %Z'; date -u -d @0 '+%F %T %Z'; date -d @1600000000 -I; date -d @1600000000 -Iseconds; date -d @1600000000 --iso-8601=hours; date -d @1600000000 --iso-8601=minutes; date -u -d @1600000000 -Idate; date -d @1600000000 -R; unset TZ; TZ=Asia/Tokyo; date -d @0 '+%F %T %Z'; export TZ; date -d @0 '+%F %T %Z'; TZ=JST-9 date -d @0 '+%F %T %Z %z'`);
			assert.strictEqual(r.stderr, '', zone);
			assert.strictEqual(r.stdout, [
				'2020-02-29 12:00:00 UTC', '2020-02-29 12:00:00 EST', '1970-01-01 00:00:00 UTC',
				'2020-09-13', '2020-09-13T08:26:40-04:00', '2020-09-13T08-04:00', '2020-09-13T08:26-04:00', '2020-09-13', 'Sun, 13 Sep 2020 08:26:40 -0400',
				'1970-01-01 00:00:00 UTC', '1970-01-01 09:00:00 JST', '1970-01-01 09:00:00 JST +0900',
			].join('\n') + '\n', zone + ': ' + r.stdout);
		});
	});

	test('LC-21: what the script exported reaches the commands that start commands (xargs, timeout, find -exec, env), and a variable given to a child is exported there', async () => {
		const { sh } = bash({ '/w/f': 'x' });
		const r = await sh.exec(`export FOO=1 TZ=Asia/Tokyo; NOTEXPORTED=2; echo x | xargs -I {} sh -c 'echo [$FOO][$NOTEXPORTED]'; timeout 5 sh -c 'echo [$FOO]'; find . -maxdepth 0 -exec sh -c 'echo [$FOO]' ';'; echo @0 | xargs -I {} date -d {} +%T; timeout 5 date -d @0 +%T; env BAR=3 sh -c 'echo [$BAR]'; BAZ=4 sh -c 'echo [$BAZ]'; env -i sh -c 'echo [$FOO]'; env -i TZ=Asia/Tokyo date -d @0 +%T; env TZ=America/New_York date -d @0 +%T; cd /; echo x | xargs -I {} sh -c 'echo $PWD'`);
		assert.strictEqual(r.stderr, '');
		assert.strictEqual(r.stdout, '[1][]\n[1]\n[1]\n09:00:00\n09:00:00\n[3]\n[4]\n[]\n09:00:00\n19:00:00\n/\n');
	});

	test('LC-22: grep and sed: \\+ and \\? after an atom are quantifiers, \\< and \\> are word boundaries (basic and extended), grep -c -o counts lines', async () => {
		const { sh } = bash({ '/w/f': 'abc 12 def345 a+b\ncolour color colr\nthe cat concatenate\n' });
		const r = await sh.exec(`grep -o '[0-9]\\+' f | tr '\\n' ' '; echo; grep -o 'a\\+' f | tr '\\n' ' '; echo; grep -o 'colou\\?r' f | tr '\\n' ' '; echo; grep -o '\\<cat\\>' f; grep -c '\\<cat' f; grep -oE '\\<cat\\>' f; grep -o 'cat\\>' f | tr '\\n' ' '; echo; grep -oc a f; grep -c a f; grep -o '\\(ab\\|de\\)\\+' f | tr '\\n' ' '; echo; echo 'abc abcd xabc' | sed 's/\\<abc\\>/X/g'; echo 'abc abcd' | sed -E 's/\\<abc/X/'; echo 'abc 12' | sed 's/[0-9]\\+/N/'; printf 'a+b\\n' | grep -c 'a+b'; printf '+a\\n' | grep -c '\\+a'; printf 'x<y\\n' | grep -c '\\<y'`);
		assert.strictEqual(r.stderr, '');
		assert.strictEqual(r.stdout, ['12 345 ', 'a a a a a ', 'colour color ', 'cat', '1', 'cat', 'cat ', '2', '2', 'ab de ', 'X abcd xabc', 'X abcd', 'abc N', '1', '1', '1'].join('\n') + '\n');
	});

	test('LC-23: sort: a key with no end runs to the end of the line, a field takes the blanks before it, -u keeps the first of equal lines, -cu is strict', async () => {
		const { sh } = bash({});
		const r = await sh.exec(`printf 'a 1 z\\nb 1 y\\nc 1 x\\n' | sort -k2; echo -; printf 'x,3,b\\ny,1,a\\nz,2,c\\nw,2,d\\n' | sort -t, -u -k2,2; echo -; printf '1\\n01\\n1.0\\n2\\n' | sort -un; echo -; printf 'b\\nA\\na\\nB\\n' | sort -uf; echo -; printf 'a   b\\nc b\\nd  a\\n' | sort -k2b; echo -; printf 'a   b\\nc b\\nd  a\\n' | sort -k2; echo -; printf 'a 11\\nb 12\\nc 21\\nd 02\\n' | sort -k2.2,2.2; echo -; printf 'a\\na\\nb\\n' | sort -cu; echo "rc=$?"`);
		assert.strictEqual(r.stdout, ['c 1 x', 'b 1 y', 'a 1 z', '-', 'y,1,a', 'z,2,c', 'x,3,b', '-', '1', '2', '-', 'A', 'b', '-', 'd  a', 'a   b', 'c b', '-', 'a   b', 'd  a', 'c b', '-', 'd 02', 'a 11', 'b 12', 'c 21', '-', 'rc=1'].join('\n') + '\n');
		assert.ok(/sort: -:2: disorder: a/.test(r.stderr), r.stderr);
	});

	test('LC-24: sed: s///w FILE writes the lines that were substituted, a range whose numeric end is not after its start is one line', async () => {
		const { fs: fsys, sh } = bash({ '/w/in': 'a\nx\nb\nx\n', '/w/five': 'one\ntwo\nthree\nfour\nfive\n' });
		const r = await sh.exec(`sed 's/x/y/w out' in; echo -; sed -n 's/x/z/gpw out2' in; echo -; sed '/four/,3c X' five; echo -; sed -n '/four/,3p' five; echo -; sed '/four/,3d' five; echo -; sed '/two/,/four/c X' five`);
		assert.strictEqual(r.stderr, '');
		assert.strictEqual(r.stdout, ['a', 'y', 'b', 'y', '-', 'z', 'z', '-', 'one', 'two', 'three', 'X', 'five', '-', 'four', '-', 'one', 'two', 'three', 'five', '-', 'one', 'X', 'five'].join('\n') + '\n');
		assert.strictEqual(await fsys.readFile('/w/out'), 'y\ny\n');
		assert.strictEqual(await fsys.readFile('/w/out2'), 'z\nz\n');
	});

	test('LC-25: the engine\'s own limit error is exported, so a program of ours can end a script the way its find does', () => {
		assert.strictEqual(typeof E.LimitError, 'function');
		const e = new E.LimitError('du: filesystem traversal entry limit exceeded (3)', 'iterations');
		assert.strictEqual(e.name, 'ExecutionLimitError');
		assert.strictEqual(E.LimitError.EXIT_CODE, 126);
		assert.ok(e instanceof Error && e.stderr.startsWith('bash: du: filesystem'));
	});

	test('LC-22 (the second half): a quantifier after a quantifier is GNU\'s `(a*)+` (`a*\\+` was an error), and after an assertion (`\\b`, `\\<`) it is a plain character', async () => {
		const { sh } = bash({ '/w/f': 'aaa b\nx+y a+\nab\naaab\n' });
		const r = await sh.exec(`grep -o 'a*\\+' f | head -1; grep -c 'a*\\+' f; grep -o 'a\\+\\?' f | head -2 | tr '\\n' ' '; echo; grep -o '\\b\\+' f; sed 's/a*\\+/X/' f | tail -1; sed -E 's/a*+/X/' f | tail -1; sed -E 's/a+?/X/' f | tail -1; grep -oE 'a*?' f | head -1; grep -o '\\(ab\\)*\\+' f | head -1; printf 'a{2}b\\n' | grep -o 'a{2}'; printf 'aab\\n' | grep -oE 'a{2}*'; printf 'a.b\\n' | grep -o '[a.]*\\+'`);
		assert.strictEqual(r.stderr, '');
		assert.strictEqual(r.stdout, ['aaa', '4', 'aaa a ', '+', '+', 'Xb', 'Xb', 'Xb', 'aaa', 'ab', 'a{2}', 'aa', 'a.'].join('\n') + '\n');
	});

	test('LC-26: the content write of a redirection is marked, a program\'s own write to the same path is not: tee, awk >, sort -o after `> f` and `rm -rf` report the error GNU does, a redirection of a path that was taken away still writes nothing and says nothing', async () => {
		const { ov, sh } = overlayBash({});
		const seen = [];
		const raw = ov.fs.writeFile.bind(ov.fs);
		ov.fs.writeFile = async (p, c, e) => { seen.push([p, typeof c === 'string' ? c.slice(0, 6) : '', e && typeof e === 'object' ? JSON.stringify(e) : String(e)]); return raw(p, c, e); };
		const r = await sh.exec(`echo hi > f; echo b | tee g > /dev/null; { rm -rf d; echo x; } > d/z; echo "rc=$?"`);
		// the opening is `writeFile(p, '', 'binary')`, the content of a redirection carries { encoding, lcRedirect }, tee's does not
		assert.deepStrictEqual(seen.filter((x) => x[0] === '/w/f'), [['/w/f', '', 'binary'], ['/w/f', 'hi\n', '{"encoding":"utf8","lcRedirect":true}']]);
		assert.deepStrictEqual(seen.filter((x) => x[0] === '/w/g'), [['/w/g', 'b\n', 'binary']], 'tee: a plain encoding');
		assert.strictEqual(r.stdout, 'rc=1\n', 'the opening of d/z failed: bash: d/z: No such file or directory');
		const q = overlayBash({});
		const r2 = await q.sh.exec(`mkdir d; echo a > d/f; rm -rf d; echo b | tee d/f; echo "tee=$?"; echo b | tee -a d/f; echo "teea=$?"; mkdir e; { rm -rf e; echo hi; } > e/f; echo "redir=$?"; ls`);
		assert.strictEqual(r2.stdout, 'b\ntee=1\nb\nteea=1\nredir=0\nd\n'.replace('\nd\n', '\n') + (await q.sh.exec('ls')).stdout);
		assert.ok(/tee: d\/f: No such file or directory/.test(r2.stderr), r2.stderr);
	});

	test('LC-27: cd through `..` to the root and back down is /w/src, not //w/src (pwd, PWD, OLDPWD, cd -)', async () => {
		const { sh } = bash({ '/w/src/a': 'x\n', '/w2/q': 'y\n' });
		const r = await sh.exec('cd /w/../w/./src && pwd; echo $PWD; cd /; cd /w/../w2; pwd; echo "$OLDPWD"; cd ..; pwd; cd ../w/src; pwd; cd -; cd /w/src/../src; pwd; cd /..; pwd; cd /w/../..//w; pwd');
		assert.strictEqual(r.stderr, '');
		assert.strictEqual(r.stdout, '/w/src\n/w/src\n/w2\n/\n/\n/w/src\n/\n/w/src\n/\n/w\n');
	});

	test('LC-28: sort -k reads its letters where they are written: a b after the end position is the end\'s, after the start position the start\'s; the start character of -kF.C counts', async () => {
		const { sh } = bash({});
		const r = await sh.exec(`printf '   c,FOO,0,foo\\naa,Foo,007\\n9,Foo,é,B\\n' | sort -k1.1,1b -k3,4; echo -; printf 'xb\\nya\\nzc\\n' | sort -k1.2; echo -; printf ' b\\na\\n  c\\n' | sort -k1b; echo -; printf 'b  x\\na  y\\n c z\\n' | sort -k2b; echo -; printf 'a b\\n c\\n' | sort -k1.1b,1.1; echo -; printf '10\\n9\\n 8\\n' | sort -k1,1bn`);
		assert.strictEqual(r.stderr, '');
		assert.strictEqual(r.stdout, ['   c,FOO,0,foo', '9,Foo,é,B', 'aa,Foo,007', '-', 'ya', 'xb', 'zc', '-', 'a', ' b', '  c', '-', 'b  x', 'a  y', ' c z', '-', ' c', 'a b', '-', ' 8', '9', '10'].join('\n') + '\n');
	});

	test('LC-29: an escape that is not ASCII is that byte: printf \\xff, printf \\377, echo -e \\xff and $\'\\xff\' write one byte; a run that is UTF-8 is the character; the text round-trips a file, cat, od, base64, wc -c', async () => {
		const { fs: fsys, sh } = overlayBash({});
		const r = await sh.exec(`printf '\\xff\\xfe' > f; wc -c < f; printf '\\377' > g; wc -c < g; echo -e '\\xff' > h; wc -c < h; echo $'\\xff\\xfe' > i; wc -c < i; printf '\\303\\251' > j; wc -c < j; base64 f; printf '\\xe9' | base64; printf '\\xc3\\xa9\\xe2\\x9c\\x93' | base64; x=$(printf '\\303\\251'); echo "\${#x}"; printf '\\000\\001\\377\\376' > b; cp b c; diff b c > /dev/null && echo same; cat b | wc -c; printf '\\xff' | sha256sum | cut -c1-16`);
		assert.strictEqual(r.stderr, '');
		assert.strictEqual(r.stdout, ['2', '1', '2', '3', '2', '//4=', '6Q==', 'w6ninJM=', '1', 'same', '4', 'a8100ae6aa1940d0'].join('\n') + '\n');
		assert.deepStrictEqual([...(await fsys.readFileBuffer('/w/f'))], [0xff, 0xfe]);
		assert.deepStrictEqual([...(await fsys.readFileBuffer('/w/j'))], [0xc3, 0xa9]);
		assert.deepStrictEqual([...(await fsys.readFileBuffer('/w/b'))], [0, 1, 0xff, 0xfe]);
		// the escapes in text that is shown or compared: a run is joined, a lone byte stays an escape
		const t = await sh.exec(`printf '\\xc3'; printf '\\xa9\\n'; printf '\\xff\\n' | base64; [ "$(printf '\\xc3\\xa9')" = "é" ] && echo equal`);
		assert.strictEqual(t.stdout, '\udcc3\udca9\n/wo=\nequal\n', 'two statements that each printed half a character: the engine leaves the escapes, the core joins them for what is shown');
	});

	test('LC-29: every place that makes an escape makes the same bytes: echo -e, printf %b (\\NNN, \\0NNN, \\xHH, \\c) and $\'\\NNN\' (a lone byte is one byte, a run that is UTF-8 is the character, in a variable too)', async () => {
		const { sh } = overlayBash({});
		/** [script, stdout]: `wc -c` of what a form makes, and `${#x}` of what it is as a value */
		const cases = [
			// echo -e: \xHH, \0NNN, \NNN; a stop with \c; the end of the text
			["echo -ne '\\xff' | wc -c; echo -ne '\\0377' | wc -c; echo -e '\\xc3\\xa9' | wc -c; x=$(echo -e '\\xc3\\xa9'); echo ${#x}", '1\n1\n3\n1\n'],
			["x=$(echo -ne '\\xc3\\xa9\\c'); echo ${#x}; echo -ne '\\xff\\c' | wc -c; x=$(echo -ne '\\0303\\0251\\cignored'); echo ${#x}", '1\n1\n1\n'],
			// printf %b: the same escapes in an argument
			["printf %b '\\xff' | wc -c; printf %b '\\xc3\\xa9' | wc -c; x=$(printf %b '\\xc3\\xa9'); echo ${#x}; x=$(printf %b 'a\\xc3\\xa9b'); echo ${#x}", '1\n2\n1\n3\n'],
			["printf %b '\\0377' | wc -c; printf %b '\\0303\\0251' | wc -c; x=$(printf %b '\\0303\\0251'); echo ${#x}", '1\n2\n1\n'],
			["printf %b '\\377' | wc -c; printf %b '\\303\\251' | wc -c; x=$(printf %b '\\303\\251'); echo ${#x}; x=$(printf %b 'a\\303\\251'); echo ${#x}", '1\n2\n1\n2\n'],
			["x=$(printf %b '\\303\\251\\c'); echo ${#x}; x=$(printf %b '\\xc3\\xa9\\cabc'); echo ${#x}; printf %b '\\xff\\c' | wc -c", '1\n1\n1\n'],
			// $'..'
			["x=$'\\303\\251'; echo ${#x}; printf %s $'\\377' | wc -c; x=$'\\xc3\\xa9'; echo ${#x}; printf %s $'a\\303\\251b' | wc -c", '1\n1\n1\n4\n'],
			// the format of printf itself (`\\c` is not special there: it is two characters, as in bash)
			["printf '\\303\\251' | wc -c; x=$(printf '\\303\\251'); echo ${#x}; x=$(printf 'a\\xc3\\xa9\\cb'); echo ${#x}; printf '\\xff\\c' | wc -c", '2\n1\n5\n3\n'],
		];
		for (const [script, want] of cases) {
			const r = await sh.exec(script);
			assert.strictEqual(r.stderr, '', script);
			assert.strictEqual(r.stdout, want, script);
		}
	});

	test('LC-31: a command word that is only expansions is split into words and globbed as bash does: `c="ls -l"; $c`, `$(echo echo hi)`, `${c} arg`; a quoted one is one word; a variable that is only blanks is no command', async () => {
		const { sh } = overlayBash({ '/w/a.txt': 'x\n', '/w/b.txt': 'y\n' });
		/** [script, stdout, stderr]: each recorded from bash 5.1 (docker, LC_ALL=C.UTF-8) */
		const cases = [
			["c='echo a b'; $c", 'a b\n', ''],
			["c='echo a'; $c b c", 'a b c\n', ''],
			["c=' echo  a   b '; $c", 'a b\n', ''],
			["c='printf %s-%s\\n x y'; $c", 'x-y\n', ''],
			["x=' '; $x echo hi", 'hi\n', ''],
			["x=''; $x echo hi", 'hi\n', ''],
			["c='echo a'; ${c} z", 'a z\n', ''],
			['$(echo echo hi from sub)', 'hi from sub\n', ''],
			["c='exit 3'; ($c); echo \"rc=$?\"", 'rc=3\n', ''],
			["c='cd /tmp'; $c; pwd", '/tmp\n', ''],
			["c='echo'; $c -n x; echo", 'x\n', ''],
			["c='true && echo no'; $c; echo \"rc=$?\"", 'rc=0\n', ''],
			["c='echo *.txt'; $c", 'a.txt b.txt\n', ''],
			["c='echo *.nothing'; $c", '*.nothing\n', ''],
			["c=$'echo x\\ny'; $c", 'x y\n', ''],
			["c='echo \"a b\"'; $c", '\"a b\"\n', ''],
			['c="echo \'a b\'"; $c', "'a b'\n", ''],
			["c='echo $HOME'; $c", '$HOME\n', ''],
			["c='echo a'; for i in 1 2; do $c $i; done", 'a 1\na 2\n', ''],
			["f() { echo \"f:$*\"; }; c='f 1 2'; $c", 'f:1 2\n', ''],
			["c='echo a'; \"$c\"; echo \"rc=$?\"", 'rc=127\n', 'bash: echo a: command not found\n'],
			["c='FOO=1 env'; $c; echo \"rc=$?\"", 'rc=127\n', 'bash: FOO=1: command not found\n'],
		];
		for (const [script, stdout, stderr] of cases) {
			const r = await sh.exec(script);
			assert.strictEqual(r.stdout, stdout, script);
			assert.strictEqual(r.stderr, stderr, script);
		}
		// the IFS in force splits it (the same expansion as for arguments): `:` makes `echo:a:b` three words, an empty IFS makes
		// `echo a` one
		const odd = await sh.exec("IFS=:; c='echo:a:b'; $c; echo \"rc=$?\"; IFS=; c='echo a'; $c; echo \"rc=$?\"");
		assert.strictEqual(odd.stdout, 'a b\nrc=0\nrc=127\n');
		assert.strictEqual(odd.stderr, 'bash: echo a: command not found\n');
	});

	test('LC-30: tee and touch say why a write failed in GNU\'s words (tee said "No such file or directory" for everything; touch said ENOENT: ..., open \'/w/d/f\')', async () => {
		const { sh } = overlayBash({});
		const r = await sh.exec(`mkdir g; echo b | tee g; echo "rc=$?"; echo b | tee nodir/x; echo "rc=$?"; touch nodir/y; echo "rc=$?"; echo a > f; touch f/y; echo "rc=$?"`);
		assert.strictEqual(r.stderr, "tee: g: Is a directory\ntee: nodir/x: No such file or directory\ntouch: cannot touch 'nodir/y': No such file or directory\ntouch: cannot touch 'f/y': Not a directory\n");
		assert.strictEqual(r.stdout, 'b\nrc=1\nb\nrc=1\nrc=1\nrc=1\n');
	});

	test("LC-32: the target of an output redirection is looked at as it was typed: a slash at the end is a directory (`> f/` wrote a file f), a path up through a folder that is not there or through a file is not there (`> x/../n` wrote n)", async () => {
		const { sh } = overlayBash({});
		// the expected output is GNU bash 5.1 / coreutils 8.32's own (docker, LC_ALL=C.UTF-8), recorded once
		const r = await sh.exec("touch f; mkdir d; echo x >> f/; echo \"rc=$?\"; echo x > nodir/; echo \"rc=$?\"; echo x > d/; echo \"rc=$?\"; echo x > f//; echo \"rc=$?\"; echo x > f/.; echo \"rc=$?\"; echo x > d/.; echo \"rc=$?\"; echo x > ''; echo \"rc=$?\"; echo x > x/../n; echo \"rc=$?\"; echo x > f/../n; echo \"rc=$?\"; echo x > d/../ok; echo \"rc=$?\"; ls; cat ok");
		assert.strictEqual(r.stdout, "rc=1\nrc=1\nrc=1\nrc=1\nrc=1\nrc=1\nrc=1\nrc=1\nrc=1\nrc=0\nd\nf\nok\nx\n");
		assert.strictEqual(r.stderr, "bash: f/: Is a directory\nbash: nodir/: Is a directory\nbash: d/: Is a directory\nbash: f//: Is a directory\nbash: f/.: Not a directory\nbash: d/.: Is a directory\nbash: : No such file or directory\nbash: x/../n: No such file or directory\nbash: f/../n: Not a directory\n");
	});

	test("LC-33: awk counts characters, not UTF-16 units: length, substr, index and RSTART/RLENGTH of an emoji and of accented letters (a code point is one)", async () => {
		const { sh } = overlayBash({});
		// the expected output is GNU bash 5.1 / coreutils 8.32's own (docker, LC_ALL=C.UTF-8), recorded once
		const r = await sh.exec("echo '😀 é ab' | awk '{print length($1), length($2), length($0), substr($0,1,2), index($0,\"a\"), toupper($2)}'; echo 'x😀y' | awk '{match($0,/y/); print RSTART, RLENGTH}'; echo 'ñandú' | awk '{print length, substr($0,2,3)}'; echo '😀😀' | awk '{print length($0), substr($0,2,1)}'");
		assert.strictEqual(r.stdout, "1 1 6 😀  5 É\n3 1\n5 and\n2 😀\n");
		assert.strictEqual(r.stderr, "");
	});

	test("LC-34: sed H appends to an empty hold space with the newline in front (the hold space is \"\\na\\nb\"), so `H;x;s/\\n/,/g` has its leading comma", async () => {
		const { sh } = overlayBash({});
		// the expected output is GNU bash 5.1 / coreutils 8.32's own (docker, LC_ALL=C.UTF-8), recorded once
		const r = await sh.exec("x=$(printf 'a\\nb\\n' | sed -n 'H;${x;p}'); echo \"[$x]\"; printf 'a\\nb\\n' | sed -n 'H;${x;s/\\n/,/g;p}'; printf 'a\\nb\\n' | sed 'H;$!d;x'; printf 'a\\nb\\nc\\n' | sed -n '1h;1!H;${g;p}'; x=$(printf 'a\\nb\\n' | sed -n 'H;x;p'); echo \"[$x]\"");
		assert.strictEqual(r.stdout, "[\na\nb]\n,a,b\n\na\nb\na\nb\nc\n[\na\na\nb]\n");
		assert.strictEqual(r.stderr, "");
	});

	test("LC-35: sed: `.` matches the newline of a pattern space made by N (and `s/./X/g` over it), in s and in addresses, basic and extended", async () => {
		const { sh } = overlayBash({});
		// the expected output is GNU bash 5.1 / coreutils 8.32's own (docker, LC_ALL=C.UTF-8), recorded once
		const r = await sh.exec("printf 'a\\nb\\n' | sed 'N;s/a.b/X/'; printf 'a\\nb\\n' | sed -n 'N;/a.b/p'; printf 'a\\nb\\n' | sed -E 'N;s/a.+b/X/'; printf '1\\n2\\n3\\n' | sed ':a;N;$!ba;s/1.*3/X/'; printf 'a\\nb\\n' | sed 'N;s/./X/g'; printf 'ab\\n' | sed 's/./X/2'; printf 'a.b\\n' | sed 's/\\./-/'");
		assert.strictEqual(r.stdout, "X\na\nb\nX\nX\nXXX\naX\na-b\n");
		assert.strictEqual(r.stderr, "");
	});

	test("LC-36: the array literal of a declaration is made of the words its elements expand to: `local a=(\"$@\")`, `($x)`, `(\"${arr[@]}\")`, `\"$*\"` with IFS, and a wrapper that runs `\"${cmd[@]}\"`", async () => {
		const { sh } = overlayBash({});
		// the expected output is GNU bash 5.1 / coreutils 8.32's own (docker, LC_ALL=C.UTF-8), recorded once
		const r = await sh.exec("f() { local a=(\"$@\"); echo \"${#a[@]}\"; printf '[%s]' \"${a[@]}\"; echo; }; f x y z; f; f \"a b\" c; w() { local cmd=(\"$@\"); \"${cmd[@]}\"; }; w printf '[%s]\\n' a 'b c'; w echo 'p\\q' \"r s\"; g() { local c=($@); echo \"${#c[@]}\"; local d=(\"$*\"); echo \"${#d[@]}\"; local IFS=,; local e=(\"$*\"); echo \"${e[0]}\"; }; g x y z; declare -a h=(\"$@\"); echo \"${#h[@]}\"; k=(p q); l() { local m=(\"${k[@]}\" r); echo \"${#m[@]}\"; }; l");
		assert.strictEqual(r.stdout, "3\n[x][y][z]\n0\n[]\n2\n[a b][c]\n[a]\n[b c]\np\\q r s\n3\n1\nx,y,z\n0\n3\n");
		assert.strictEqual(r.stderr, "");
	});

	test("LC-37: sed: a `*` with nothing before it is a plain asterisk in a basic expression (at the start, after the group and alternation marks, after `^`), and GNU's error in an extended one", async () => {
		const { sh } = overlayBash({});
		// the expected output is GNU bash 5.1 / coreutils 8.32's own (docker, LC_ALL=C.UTF-8), recorded once
		const r = await sh.exec("printf 'a*b\\nab\\n*b\\n' > f; sed 's/*b/X/' f; echo --; sed 's/\\(*b\\)/X/' f; echo --; sed 's/^*b/X/' f; echo --; sed 's/a\\|*b/X/' f; echo --; sed -E 's/*b/X/' f; echo \"rc=$?\"; sed 's/*//g' f");
		assert.strictEqual(r.stdout, "aX\nab\nX\n--\naX\nab\nX\n--\na*b\nab\nX\n--\nX*b\nXb\nX\n--\nrc=1\nab\nab\nb\n");
		assert.strictEqual(r.stderr, "sed: -e expression #1, char 7: Invalid preceding regular expression\n");
	});

	test("LC-38: awk reads RS: one character, a NUL, the empty string (paragraphs), a regular expression", async () => {
		const { sh } = overlayBash({});
		// the expected output is GNU bash 5.1 / coreutils 8.32's own (docker, LC_ALL=C.UTF-8), recorded once
		const r = await sh.exec("printf 'a,b\\n' | awk -v RS=, '{print NR\":\"$0}'; printf 'a b\\n\\nc d\\ne\\n\\n\\nf\\n' | awk -v RS= '{print NR\": \"$0\" NF=\"NF}'; printf 'a;b;c' | awk 'BEGIN{RS=\";\"}{print}'; printf 'a1b22c' | awk -v RS='[0-9]+' '{print NR\":\"$0}'; printf 'x\\0y\\0z\\0' | awk -v RS='\\0' '{print NR\":\"$0}'; printf 'a|b|c\\n' | awk 'BEGIN{RS=\"|\"} NR==2'");
		assert.strictEqual(r.stdout, "1:a\n2:b\n\n1: a b NF=2\n2: c d\ne NF=3\n3: f NF=1\na\nb\nc\n1:a\n2:b\n3:c\n1:x\n2:y\n3:z\nb\n");
		assert.strictEqual(r.stderr, "");
	});

	test("LC-39: the elements of a declared array keep their command substitutions, arithmetic and parameter operations (the parser wrote the NAME of the part: `CommandSubstitution`)", async () => {
		const { sh } = overlayBash({});
		// the expected output is GNU bash 5.1 / coreutils 8.32's own (docker, LC_ALL=C.UTF-8), recorded once
		const r = await sh.exec("declare -a g=($(echo 1 2 3)); echo \"${#g[@]}\"; f() { local e=(\"$(echo 1 2)\" `echo x` \"${@:2}\" \"${y:-dd}\" $((1+2)) \"${#e[@]}\"); printf '<%s>' \"${e[@]}\"; echo; }; f A B C; declare -a z=(\"pre$(echo 1 2)post\" $(echo a b)c); printf '<%s>' \"${z[@]}\"; echo; readonly -a ro=($(echo 1 2)); echo ${#ro[@]}; declare -a c=(\"$(printf 'x\\ny')\"); echo \"${#c[@]}\"");
		assert.strictEqual(r.stdout, "3\n<1 2><x><B><C><dd><3><0>\n<pre1 2post><a><bc>\n2\n1\n");
		assert.strictEqual(r.stderr, "");
	});

	test("LC-40: a command that is a directory is \"Is a directory\" (126), not \"Permission denied\"; a file that is not executable still is", async () => {
		const { sh } = overlayBash({});
		// the expected output is GNU bash 5.1 / coreutils 8.32's own (docker, LC_ALL=C.UTF-8), recorded once
		const r = await sh.exec("d=/tmp; \"$d\"/; echo \"rc=$?\"; /usr/bin/; echo \"rc=$?\"; mkdir sub; ./sub; echo \"rc=$?\"; \"$d\"/nosuch; echo \"rc=$?\"; echo hi > f; ./f; echo \"rc=$?\"");
		assert.strictEqual(r.stdout, "rc=126\nrc=126\nrc=126\nrc=127\nrc=126\n");
		assert.strictEqual(r.stderr, "bash: /tmp/: Is a directory\nbash: /usr/bin/: Is a directory\nbash: ./sub: Is a directory\nbash: /tmp/nosuch: No such file or directory\nbash: ./f: Permission denied\n");
	});

	test("LC-31 (the quoted list): `\"$@\"` and `\"${cmd[@]}\"` in the command position are several words (none: no command), a prefix or suffix joins the first or last, `\"$*\"` and `\"$c\"` are one word", async () => {
		const { sh } = overlayBash({});
		// the expected output is GNU bash 5.1 / coreutils 8.32's own (docker, LC_ALL=C.UTF-8), recorded once
		const r = await sh.exec("set -- echo a b; x\"$@\"; echo \"rc=$?\"; \"$@\"x; echo \"rc=$?\"; \"$@\"; \"$@\" c; set --; \"$@\"; echo \"rc=$?\"; \"$@\" echo none; set -- echo; \"$@\" a; run() { echo \"+ $*\"; \"$@\"; }; run echo hi there; retry() { for i in 1 2; do \"$@\" && return 0; done; return 1; }; retry echo ok; retry false; echo \"rc=$?\"; cmd=(printf '[%s]\\n' \"x y\" z); \"${cmd[@]}\"; cmd=(); \"${cmd[@]}\"; echo \"rc=$?\"; f() { \"x$@\"; }; f ec ho; set -- \"echo a\" b; \"$@\"; echo \"rc=$?\"; set -- echo a; \"$*\" b; echo \"rc=$?\"; d=/tmp; p=ec; ${p}ho hi; ec\"ho\" hi");
		assert.strictEqual(r.stdout, "rc=127\na bx\nrc=0\na b\na b c\nrc=0\nnone\na\n+ echo hi there\nhi there\nok\nrc=1\n[x y]\n[z]\nrc=0\nrc=127\nrc=127\nhi\nhi\n");
		assert.strictEqual(r.stderr, "bash: xecho: command not found\nbash: xec: command not found\nbash: echo a: command not found\nbash: echo a: command not found\n");
	});

	test("LC-22 (intervals and leading quantifiers): `\\{,2\\}` and `{,2}` are `{0,2}`, a leading `*` in an extended grep is nothing, in a basic one a plain character, after `\\(` `\\|` and `^` too", async () => {
		const { sh } = overlayBash({});
		// the expected output is GNU bash 5.1 / coreutils 8.32's own (docker, LC_ALL=C.UTF-8), recorded once
		const r = await sh.exec("printf 'a\\naa\\naaa\\n' | grep -E '^a{,2}$'; printf 'a\\naa\\naaa\\n' | grep '^a\\{,2\\}$'; printf 'aab\\n' | sed 's/a\\{,1\\}/X/'; printf 'ab\\n' | sed -E 's/a{,2}/X/'; printf 'a\\n*a\\n' | grep -E '*a'; printf 'ab\\n' | grep -E 'x|*a'; printf 'a*b\\n' | grep '\\(*b\\)'; printf '*b\\n' | grep '^*b'; printf 'a{1\\n' | grep -E 'a{1'");
		assert.strictEqual(r.stdout, "a\naa\na\naa\nXab\nXb\na\n*a\nab\na*b\n*b\na{1\n");
		assert.strictEqual(r.stderr, "");
	});

	test("LC-41 (sort -V): GNU's filevercmp: leading zeros are no difference to a number and equal numbers fall back to the bytes (`w0 w00 w000`; `sort -Vu` keeps `file01.txt` and `file1.txt`), `~` before the end, a letter before any mark, the file suffix out of the comparison, leading dots first", async () => {
		const { sh } = overlayBash({});
		// the expected output is GNU bash 5.1 / coreutils 8.32's own (docker, LC_ALL=C.UTF-8), recorded once
		const r = await sh.exec("printf '%s\\n' '1.2' '1.10' '1.9' '1.1' | sort -V | tr '\\n' ' '; echo; printf '%s\\n' '1.2' '1.10' '1.9' '1.1' | sort -rV | tr '\\n' ' '; echo; printf '%s\\n' '1.2' '1.10' '1.9' '1.1' | sort -Vu | wc -l\nprintf '%s\\n' '1.0' '1.0-rc1' '1.0~rc1' '1.0.1' '1.0a' | sort -V | tr '\\n' ' '; echo; printf '%s\\n' '1.0' '1.0-rc1' '1.0~rc1' '1.0.1' '1.0a' | sort -rV | tr '\\n' ' '; echo; printf '%s\\n' '1.0' '1.0-rc1' '1.0~rc1' '1.0.1' '1.0a' | sort -Vu | wc -l\nprintf '%s\\n' 'file1.txt' 'file10.txt' 'file2.txt' 'file01.txt' | sort -V | tr '\\n' ' '; echo; printf '%s\\n' 'file1.txt' 'file10.txt' 'file2.txt' 'file01.txt' | sort -rV | tr '\\n' ' '; echo; printf '%s\\n' 'file1.txt' 'file10.txt' 'file2.txt' 'file01.txt' | sort -Vu | wc -l\nprintf '%s\\n' 'a-1.tar.gz' 'a-10.tar.gz' 'a-2.tar.gz' 'a-1.tar.bz2' | sort -V | tr '\\n' ' '; echo; printf '%s\\n' 'a-1.tar.gz' 'a-10.tar.gz' 'a-2.tar.gz' 'a-1.tar.bz2' | sort -rV | tr '\\n' ' '; echo; printf '%s\\n' 'a-1.tar.gz' 'a-10.tar.gz' 'a-2.tar.gz' 'a-1.tar.bz2' | sort -Vu | wc -l\nprintf '%s\\n' 'img001.jpg' 'img1.jpg' 'img01.jpg' 'img10.jpg' 'img2.jpg' | sort -V | tr '\\n' ' '; echo; printf '%s\\n' 'img001.jpg' 'img1.jpg' 'img01.jpg' 'img10.jpg' 'img2.jpg' | sort -rV | tr '\\n' ' '; echo; printf '%s\\n' 'img001.jpg' 'img1.jpg' 'img01.jpg' 'img10.jpg' 'img2.jpg' | sort -Vu | wc -l\nprintf '%s\\n' 'release-1.2.3-beta' 'release-1.2.3' 'release-1.2.3-alpha' 'release-1.2.10' | sort -V | tr '\\n' ' '; echo; printf '%s\\n' 'release-1.2.3-beta' 'release-1.2.3' 'release-1.2.3-alpha' 'release-1.2.10' | sort -rV | tr '\\n' ' '; echo; printf '%s\\n' 'release-1.2.3-beta' 'release-1.2.3' 'release-1.2.3-alpha' 'release-1.2.10' | sort -Vu | wc -l\nprintf '%s\\n' '10' '9' '100' '1' '08' '8' | sort -V | tr '\\n' ' '; echo; printf '%s\\n' '10' '9' '100' '1' '08' '8' | sort -rV | tr '\\n' ' '; echo; printf '%s\\n' '10' '9' '100' '1' '08' '8' | sort -Vu | wc -l\nprintf '%s\\n' 'a' 'B' 'a1' 'A1' 'b' '_x' '-y' '.hidden' '.z1' | sort -V | tr '\\n' ' '; echo; printf '%s\\n' 'a' 'B' 'a1' 'A1' 'b' '_x' '-y' '.hidden' '.z1' | sort -rV | tr '\\n' ' '; echo; printf '%s\\n' 'a' 'B' 'a1' 'A1' 'b' '_x' '-y' '.hidden' '.z1' | sort -Vu | wc -l\nprintf '%s\\n' '1.2.3' '1.2.3.1' '1.2' '1.2.3a' '1.2.3-1' | sort -V | tr '\\n' ' '; echo; printf '%s\\n' '1.2.3' '1.2.3.1' '1.2' '1.2.3a' '1.2.3-1' | sort -rV | tr '\\n' ' '; echo; printf '%s\\n' '1.2.3' '1.2.3.1' '1.2' '1.2.3a' '1.2.3-1' | sort -Vu | wc -l\nprintf '%s\\n' '1' '1.0' '1.00' '1.0.0' '01' '1.' | sort -V | tr '\\n' ' '; echo; printf '%s\\n' '1' '1.0' '1.00' '1.0.0' '01' '1.' | sort -rV | tr '\\n' ' '; echo; printf '%s\\n' '1' '1.0' '1.00' '1.0.0' '01' '1.' | sort -Vu | wc -l\nprintf '%s\\n' 'w0' 'w00' 'w000' 'w1' 'w01' | sort -V | tr '\\n' ' '; echo; printf '%s\\n' 'w0' 'w00' 'w000' 'w1' 'w01' | sort -rV | tr '\\n' ' '; echo; printf '%s\\n' 'w0' 'w00' 'w000' 'w1' 'w01' | sort -Vu | wc -l\nprintf '%s\\n' '..~100x' '.a1' '.~a01' '.txt' 'x' | sort -V | tr '\\n' ' '; echo; printf '%s\\n' '..~100x' '.a1' '.~a01' '.txt' 'x' | sort -rV | tr '\\n' ' '; echo; printf '%s\\n' '..~100x' '.a1' '.~a01' '.txt' 'x' | sort -Vu | wc -l");
		assert.strictEqual(r.stdout, "1.1 1.2 1.9 1.10 \n1.10 1.9 1.2 1.1 \n4\n1.0~rc1 1.0 1.0a 1.0-rc1 1.0.1 \n1.0.1 1.0-rc1 1.0a 1.0 1.0~rc1 \n5\nfile01.txt file1.txt file2.txt file10.txt \nfile10.txt file2.txt file1.txt file01.txt \n4\na-1.tar.bz2 a-1.tar.gz a-2.tar.gz a-10.tar.gz \na-10.tar.gz a-2.tar.gz a-1.tar.gz a-1.tar.bz2 \n4\nimg001.jpg img01.jpg img1.jpg img2.jpg img10.jpg \nimg10.jpg img2.jpg img1.jpg img01.jpg img001.jpg \n5\nrelease-1.2.3 release-1.2.3-alpha release-1.2.3-beta release-1.2.10 \nrelease-1.2.10 release-1.2.3-beta release-1.2.3-alpha release-1.2.3 \n4\n1 08 8 9 10 100 \n100 10 9 8 08 1 \n6\n.hidden .z1 A1 B a a1 b -y _x \n_x -y b a1 a B A1 .z1 .hidden \n9\n1.2 1.2.3 1.2.3a 1.2.3-1 1.2.3.1 \n1.2.3.1 1.2.3-1 1.2.3a 1.2.3 1.2 \n5\n01 1 1. 1.0 1.00 1.0.0 \n1.0.0 1.00 1.0 1. 1 01 \n6\nw0 w00 w000 w01 w1 \nw1 w01 w000 w00 w0 \n5\n.~a01 ..~100x .a1 .txt x \nx .txt .a1 ..~100x .~a01 \n5\n");
		assert.strictEqual(r.stderr, "");
	});

	test("LC-42 (find -size): sizes count in whole units, rounded up, as GNU's do: `-size -1M` is the empty files, `-size 2k` is 1025 to 2048 bytes, `-size 1` is one block of 512, `-size 1w` is two bytes", async () => {
		const { sh } = overlayBash({});
		// the expected output is GNU bash 5.1 / findutils 4.8's own (docker, LC_ALL=C.UTF-8), recorded once
		const r = await sh.exec("for n in 0 1 511 512 513 1023 1024 1025 2048 4097; do head -c $n /dev/zero > s$n; done; printf '%s: ' \"0\"; find . -type f -size 0 | sort | tr '\\n' ' '; echo\nprintf '%s: ' \"1\"; find . -type f -size 1 | sort | tr '\\n' ' '; echo\nprintf '%s: ' \"-1\"; find . -type f -size -1 | sort | tr '\\n' ' '; echo\nprintf '%s: ' \"+0\"; find . -type f -size +0 | sort | tr '\\n' ' '; echo\nprintf '%s: ' \"+1\"; find . -type f -size +1 | sort | tr '\\n' ' '; echo\nprintf '%s: ' \"1k\"; find . -type f -size 1k | sort | tr '\\n' ' '; echo\nprintf '%s: ' \"-1k\"; find . -type f -size -1k | sort | tr '\\n' ' '; echo\nprintf '%s: ' \"2k\"; find . -type f -size 2k | sort | tr '\\n' ' '; echo\nprintf '%s: ' \"+1k\"; find . -type f -size +1k | sort | tr '\\n' ' '; echo\nprintf '%s: ' \"1b\"; find . -type f -size 1b | sort | tr '\\n' ' '; echo\nprintf '%s: ' \"-1b\"; find . -type f -size -1b | sort | tr '\\n' ' '; echo\nprintf '%s: ' \"1024c\"; find . -type f -size 1024c | sort | tr '\\n' ' '; echo\nprintf '%s: ' \"+1024c\"; find . -type f -size +1024c | sort | tr '\\n' ' '; echo\nprintf '%s: ' \"-1024c\"; find . -type f -size -1024c | sort | tr '\\n' ' '; echo\nprintf '%s: ' \"1M\"; find . -type f -size 1M | sort | tr '\\n' ' '; echo\nprintf '%s: ' \"-1M\"; find . -type f -size -1M | sort | tr '\\n' ' '; echo\nprintf '%s: ' \"+1M\"; find . -type f -size +1M | sort | tr '\\n' ' '; echo\nprintf '%s: ' \"1w\"; find . -type f -size 1w | sort | tr '\\n' ' '; echo\nprintf '%s: ' \"5k\"; find . -type f -size 5k | sort | tr '\\n' ' '; echo");
		assert.strictEqual(r.stdout, "0: ./s0 \n1: ./s1 ./s511 ./s512 \n-1: ./s0 \n+0: ./s1 ./s1023 ./s1024 ./s1025 ./s2048 ./s4097 ./s511 ./s512 ./s513 \n+1: ./s1023 ./s1024 ./s1025 ./s2048 ./s4097 ./s513 \n1k: ./s1 ./s1023 ./s1024 ./s511 ./s512 ./s513 \n-1k: ./s0 \n2k: ./s1025 ./s2048 \n+1k: ./s1025 ./s2048 ./s4097 \n1b: ./s1 ./s511 ./s512 \n-1b: ./s0 \n1024c: ./s1024 \n+1024c: ./s1025 ./s2048 ./s4097 \n-1024c: ./s0 ./s1 ./s1023 ./s511 ./s512 ./s513 \n1M: ./s1 ./s1023 ./s1024 ./s1025 ./s2048 ./s4097 ./s511 ./s512 ./s513 \n-1M: ./s0 \n+1M: \n1w: ./s1 \n5k: ./s4097 \n");
		assert.strictEqual(r.stderr, "");
	});

	test("LC-43: a regular expression that does not compile ends the script with GNU's message and status 1 (it was swallowed: the line unchanged, status 0), for s and for an address, basic and extended", async () => {
		const { sh } = overlayBash({});
		// the expected output is GNU sed 4.8's own (docker, LC_ALL=C.UTF-8), recorded once
		const r = await sh.exec("echo abc | sed 's/a\\(/X/' 2>&1; echo \"rc=$?\"\necho abc | sed 's/a\\)/X/' 2>&1; echo \"rc=$?\"\necho abc | sed -E 's/(a/X/' 2>&1; echo \"rc=$?\"\necho abc | sed -E 's/a)/X/' 2>&1; echo \"rc=$?\"\necho abc | sed -E 's/a{2,1}/X/' 2>&1; echo \"rc=$?\"\necho abc | sed 's/a\\{2,1\\}/X/' 2>&1; echo \"rc=$?\"\necho abc | sed -n '/a\\(/p' 2>&1; echo \"rc=$?\"\necho abc | sed -E -n '/(a/p' 2>&1; echo \"rc=$?\"\necho abc | sed 's/[[:foo:]]/X/' 2>&1; echo \"rc=$?\"\necho abc | sed 's/[z-a]/X/' 2>&1; echo \"rc=$?\"");
		assert.strictEqual(r.stdout, "sed: -e expression #1, char 8: Unmatched ( or \\(\nrc=1\nsed: -e expression #1, char 8: Unmatched ) or \\)\nrc=1\nsed: -e expression #1, char 7: Unmatched ( or \\(\nrc=1\nsed: -e expression #1, char 7: Unmatched ) or \\)\nrc=1\nsed: -e expression #1, char 11: Invalid content of \\{\\}\nrc=1\nsed: -e expression #1, char 13: Invalid content of \\{\\}\nrc=1\nsed: -e expression #1, char 5: Unmatched ( or \\(\nrc=1\nsed: -e expression #1, char 4: Unmatched ( or \\(\nrc=1\nsed: -e expression #1, char 14: Invalid character class name\nrc=1\nsed: -e expression #1, char 10: Invalid range end\nrc=1\n");
		assert.strictEqual(r.stderr, "");
	});

	test("LC-44: with -E and -r an address /re/ is an extended regular expression (`/(a|b)/`, `/a|c/`, `/o+/`, `/[0-9]{2}/`); without them it is a basic one and `|` is a plain character", async () => {
		const { sh } = overlayBash({});
		// the expected output is GNU sed 4.8's own (docker, LC_ALL=C.UTF-8), recorded once
		const r = await sh.exec("printf 'a\\nb\\nc\\nfoo1\\nbar22\\n' > f\nsed -E -n '/(a|b)/p' f | tr '\\n' ' '; echo\nsed -E '/^(foo|bar)[0-9]+$/d' f | tr '\\n' ' '; echo\nsed -nE '/a|c/p' f | tr '\\n' ' '; echo\nsed -E -n '/o+/p' f | tr '\\n' ' '; echo\nsed -E '/(b)/,/(foo)/d' f | tr '\\n' ' '; echo\nsed -r -n '/[0-9]{2}/p' f | tr '\\n' ' '; echo\nsed -n '/\\(a\\|b\\)/p' f | tr '\\n' ' '; echo\nsed -n '/a|b/p' f | tr '\\n' ' '; echo\nsed -E -n '/a\\|b/p' f | tr '\\n' ' '; echo");
		assert.strictEqual(r.stdout, "a b bar22 \na b c \na c bar22 \nfoo1 \na \nbar22 \na b bar22 \n\n\n");
		assert.strictEqual(r.stderr, "");
	});

	test("LC-45: the replacement as GNU reads it: `\\\\&` is a backslash and the match (the escape idiom `s/[\\/&]/\\\\&/g`), \\U \\L \\u \\l \\E change the case, \\xHH \\oNNN \\dNNN \\cX \\a \\f \\v are the characters, and a group the pattern does not have is GNU's error", async () => {
		const { sh } = overlayBash({});
		// the expected output is GNU sed 4.8's own (docker, LC_ALL=C.UTF-8), recorded once
		const r = await sh.exec("echo 'a/b&c.d\\e' | sed 's/[\\/&]/\\\\&/g'\necho 'a/b' | sed 's/\\//\\\\&/'\necho abc | sed 's/b/\\\\n/'\necho abc | sed 's/b/\\\\\\\\&/'\necho abc | sed 's/b/x\\ny/'\necho abc | sed 's/b/\\&/'\necho foo bar | sed 's/\\w\\+/\\u&/g'\necho 'hello WORLD' | sed 's/.*/\\L\\u&/'\necho 'foo bar' | sed -E 's/(\\w+) (\\w+)/\\U\\1\\E \\2/'\necho abc | sed 's/\\(a\\)\\(b\\)/\\u\\1\\U\\2x\\Ey/'\necho abc | sed 's/b/\\x41\\o102\\d67/'\nx=$(echo abc | sed 's/b/\\cA/'); [ \"$x\" = \"$(printf 'a\\001c')\" ] && echo cA-ok\nx=$(echo abc | sed 's/b/\\a\\f\\v\\t/'); [ \"$x\" = \"$(printf 'a\\a\\f\\v\\tc')\" ] && echo avft-ok\necho abc | sed 's/b/\\1/' 2>&1; echo \"rc=$?\"\necho abc | sed -E 's/(b)/\\2/' 2>&1; echo \"rc=$?\"\necho abc | sed -E 's/(b)(c)/\\2\\1\\0/'");
		assert.strictEqual(r.stdout, "a\\/b\\&c.d\\\\e\na\\/b\na\\nc\na\\\\bc\nax\nyc\na&c\nFoo Bar\nHello world\nFOO bar\nABXyc\naABCc\ncA-ok\navft-ok\nsed: -e expression #1, char 7: invalid reference \\1 on `s' command's RHS\nrc=1\nsed: -e expression #1, char 9: invalid reference \\2 on `s' command's RHS\nrc=1\nacbbc\n");
		assert.strictEqual(r.stderr, "");
	});

	test("LC-46: a backslash in a bracket expression is a backslash (`[\\.]` has it, `[^\\]` is everything else, `[a\\]b]` ends at the first `]`), `\\o` and `\\d` of a pattern are characters, and `\\<` `\\>` next to a `.` or a `[^x]` only match a word character", async () => {
		const { sh } = overlayBash({});
		// the expected output is GNU sed 4.8's own (docker, LC_ALL=C.UTF-8), recorded once
		const r = await sh.exec("printf 'a.b\\\\c/d\\n' > f\nsed 's/[\\.]/X/g' f; sed 's/[\\\\]/X/g' f; sed 's/[\\/]/X/g' f; sed 's/[^\\]/X/g' f; sed 's|[\\|]|X|g' f; sed -E 's/[\\.]/X/g' f; sed 's/[a\\]b]/X/g' f\nsed 's/\\o142/X/;s/\\d99/Y/' f\necho 'a\tb' | sed 's/[\\t]/X/'\necho foo bar | sed 's/\\<./\\U&/g'\necho 'foo bar' | sed 's/\\<\\(.\\)/\\u\\1/g'\necho 'foo bar' | sed -E 's/.\\>/X/g'\necho 'foo bar' | sed 's/\\<[^ ]/X/g'");
		assert.strictEqual(r.stdout, "aXbXc/d\na.bXc/d\na.bXcXd\nXXX\\XXX\na.bXc/d\naXbXc/d\na.b\\c/d\na.X\\Y/d\naXb\nFoo Bar\nFoo Bar\nfoX baX\nXoo Xar\n");
		assert.strictEqual(r.stderr, "");
	});

	test("LC-47: addresses: `\\cREGEXc` with any delimiter, the flags I and M, `addr,~N`, and an end that is a regular expression is looked for from the next line (`1,/e/d`) except for `0,/re/`", async () => {
		const { sh } = overlayBash({});
		// the expected output is GNU sed 4.8's own (docker, LC_ALL=C.UTF-8), recorded once
		const r = await sh.exec("printf 'one\\nTwo\\nthree\\nFour\\nfive\\n/usr/x\\nsix\\n' > in\nsed -n '/two/Ip' in | tr '\\n' ' '; echo\nsed '/TWO/I,/FOUR/Id' in | tr '\\n' ' '; echo\nsed '\\,/usr,d' in | tr '\\n' ' '; echo\nsed -n '\\#usr#p' in | tr '\\n' ' '; echo\nsed -n '\\|usr|p' in | tr '\\n' ' '; echo\nsed -n '\\,u\\,,p' in | tr '\\n' ' '; echo\nsed -n '2,~4p' in | tr '\\n' ' '; echo\nsed -n '4,~4p' in | tr '\\n' ' '; echo\nsed '1,/e/d' in | tr '\\n' ' '; echo\nsed '0,/e/d' in | tr '\\n' ' '; echo\nsed -n '/t/,/f/p' in | tr '\\n' ' '; echo\nsed '/one/I{n;d}' in | tr '\\n' ' '; echo\nsed -n '/x/I,$p' in | tr '\\n' ' '; echo");
		assert.strictEqual(r.stdout, "Two \none five /usr/x six \none Two three Four five six \n/usr/x \n/usr/x \n\nTwo three Four \nFour five /usr/x six \nFour five /usr/x six \nTwo three Four five /usr/x six \nthree Four five \none three Four five /usr/x six \n/usr/x six \n");
		assert.strictEqual(r.stderr, "");
	});

	test("LC-50 (grep): a backslash in a bracket is a backslash (`[\\.]`, `[^\\]`), in an extended expression a `)` with nothing open and a `{` that starts no interval are plain characters, and a pattern that does not compile is said in GNU's words with status 2", async () => {
		const { sh } = overlayBash({});
		// the expected output is GNU grep 3.7's own (docker, LC_ALL=C.UTF-8), recorded once
		const r = await sh.exec("printf 'a.b\\\\c\\n*x\\nfoo)\\nab\\n{x\\n' > f\ngrep '[\\.]' f | tr '\\n' ' '; echo\ngrep -c '[^\\]' f\ngrep -E ')' f | tr '\\n' ' '; echo\ngrep -E 'o)' f | tr '\\n' ' '; echo\ngrep -E '{x' f | tr '\\n' ' '; echo\ngrep -E -c 'a{1,2}b' f\ngrep -E -o '[\\.]+' f | tr '\\n' ' '; echo\ngrep '\\(a' f 2>&1; echo \"rc=$?\"\ngrep -E '(a' f 2>&1; echo \"rc=$?\"\ngrep 'a\\)' f 2>&1; echo \"rc=$?\"\ngrep -E 'a{2,1}' f 2>&1; echo \"rc=$?\"\ngrep '[[:foo:]]' f 2>&1; echo \"rc=$?\"\ngrep '[z-a]' f 2>&1; echo \"rc=$?\"\ngrep -e 'a' -e '\\(' f 2>&1; echo \"rc=$?\"");
		assert.strictEqual(r.stdout, "a.b\\c \n5\nfoo) \nfoo) \n{x \n1\n. \\ \ngrep: Unmatched ( or \\(\nrc=2\ngrep: Unmatched ( or \\(\nrc=2\ngrep: Unmatched ) or \\)\nrc=2\ngrep: Invalid content of \\{\\}\nrc=2\ngrep: Invalid character class name\nrc=2\ngrep: Invalid range end\nrc=2\ngrep: Unmatched ( or \\(\nrc=2\n");
		assert.strictEqual(r.stderr, "");
	});

	test("LC-51 (sed q and Q): the number after them is the exit status (`q5`, `2q7`, `q 3`), and the pattern space is printed for q and not for Q", async () => {
		const { sh } = overlayBash({});
		// the expected output is GNU sed 4.8's own (docker, LC_ALL=C.UTF-8), recorded once
		const r = await sh.exec("printf 'a\\nb\\nc\\n' > f\nsed q5 f; echo \"rc=$?\"\nsed Q5 f; echo \"rc=$?\"\nsed '2q7' f; echo \"rc=$?\"\nsed -n '2{p;q 3}' f; echo \"rc=$?\"\nsed 2q f; echo \"rc=$?\"\nsed -n '/b/Q9' f; echo \"rc=$?\"");
		assert.strictEqual(r.stdout, "a\nrc=5\nrc=5\na\nb\nrc=7\nb\nrc=3\na\nb\nrc=0\nrc=9\n");
		assert.strictEqual(r.stderr, "");
	});

	test("LC-53 (awk): split on blanks and of an empty string, length of an array, int, %e and %g, a one-character FS, FS=\"\", NF rebuilds $0, print > name concatenated, print | \"cmd\" (at close() or the end, before awk's own output)", async () => {
		const { sh } = overlayBash({});
		// the expected output is GNU awk 5.1's own (docker, LC_ALL=C.UTF-8), recorded once
		const r = await sh.exec("printf 'alice 30 NY\\nbob 25 LA\\ncarol 35 NY\\n' > d; printf 'a|b|c\\n  x  y  \\n' > p\nawk '{n=split($0,q,\" \");print n, q[1]}' p\nawk 'BEGIN{n=split(\"\",q);print n; n=split(\"  a  b \",q,\" \");print n, q[1], q[2]; n=split(\"a:b\",q,\":\");print n}'\nawk 'BEGIN{x[1]=1;x[2]=2;x[3]=3;delete x[2];print length(x), length(\"abc\"), length()}'\nawk 'BEGIN{print int(3.9), int(-3.9), int(\"4abc\"), int(-0.5)}'\nawk 'BEGIN{printf \"%e|%E|%g|%g|%.2e\\n\", 5.5, 12345.678, 0.00001234, 1e10, 100}'\nawk -F'|' '{print $2}' p; awk -F. '{print NF}' d; awk 'BEGIN{FS=\"|\"}{print $3}' p; awk -F'|' 'BEGIN{OFS=\"-\"}{$1=$1;print}' p\nprintf 'ab\\n' | awk 'BEGIN{FS=\"\"}{print NF, $1, $2}'\nprintf '  a  b  \\n' | awk '{NF=2; print}'; printf 'a b c\\n' | awk '{NF=2; print; NF=4; print; print NF}'\nawk '{print $1 > \"out_\" $3 \".txt\"}' d; cat out_NY.txt out_LA.txt\nawk '{print $2, $1 | \"sort -n\"}' d\nawk '{print $1 | \"sort -r\"} END{print \"end\"}' d\nawk '{print $1 | \"sort -r\"} END{close(\"sort -r\"); print \"end\"}' d\nawk 'BEGIN{print \"b\\na\" | \"sort\"}'\nawk '{c[$3]++}END{for(k in c)print k, c[k] | \"sort\"}' d\nawk 'BEGIN{printf \"%s\\n\", \"z\" | \"cat\"; print \"y\" | \"cat\"}'");
		assert.strictEqual(r.stdout, "1 a|b|c\n2 x\n0\n2 a b\n2\n2 3 0\n3 -3 4 0\n5.500000e+00|1.234568E+04|1.234e-05|1e+10|1.00e+02\nb\n\n1\n1\n1\nc\n\na-b-c\n  x  y  \n2 a b\na b\na b\na b  \n4\nalice\ncarol\nbob\n25 bob\n30 alice\n35 carol\ncarol\nbob\nalice\nend\ncarol\nbob\nalice\nend\na\nb\nLA 1\nNY 2\nz\ny\n");
		assert.strictEqual(r.stderr, "");
	});

	test("LC-52: what a command writes to /dev/stderr is its own output: `2>&1` and `2>/dev/null` and a pipe apply to it", async () => {
		const { sh } = overlayBash({});
		// the expected output is GNU awk 5.1's own (docker, LC_ALL=C.UTF-8), recorded once
		const r = await sh.exec("awk 'BEGIN{print \"x\" > \"/dev/stderr\"}' 2>&1; awk 'BEGIN{print \"y\" > \"/dev/stderr\"}' 2>/dev/null; echo done\necho hi | tee /dev/stderr 2>&1 | cat");
		assert.strictEqual(r.stdout, "x\ndone\nhi\nhi\n");
		assert.strictEqual(r.stderr, "");
	});

	test("LC-48 (sed): the messages of a script that cannot be read are GNU's: unknown command, unterminated `s', missing command, `y` with sets of different lengths, an unmatched `{`, an unexpected `}`", async () => {
		const { sh } = overlayBash({});
		// the expected output is GNU sed 4.8's own (docker, LC_ALL=C.UTF-8), recorded once
		const r = await sh.exec("echo abc | sed 'k' 2>&1; echo \"rc=$?\"\necho abc | sed ';us;p' 2>&1; echo \"rc=$?\"\necho abc | sed '2' 2>&1; echo \"rc=$?\"\necho abc | sed '2,3' 2>&1; echo \"rc=$?\"\necho abc | sed 's/a/b' 2>&1; echo \"rc=$?\"\necho abc | sed 's/[a/X/' 2>&1; echo \"rc=$?\"\necho abc | sed 'p;k' 2>&1; echo \"rc=$?\"\necho abc | sed 'y/abc/xy/' 2>&1; echo \"rc=$?\"\necho abc | sed '1,2!' 2>&1; echo \"rc=$?\"\necho abc | sed '{p' 2>&1; echo \"rc=$?\"\necho abc | sed 'p}' 2>&1; echo \"rc=$?\"\necho abc | sed 's/a/b/\n' 2>&1; echo \"rc=$?\"\necho abc | sed '/a/' 2>&1; echo \"rc=$?\"\necho abc | sed '1~' 2>&1; echo \"rc=$?\"");
		assert.strictEqual(r.stdout, "sed: -e expression #1, char 1: unknown command: `k'\nrc=1\nsed: -e expression #1, char 2: unknown command: `u'\nrc=1\nsed: -e expression #1, char 1: missing command\nrc=1\nsed: -e expression #1, char 3: missing command\nrc=1\nsed: -e expression #1, char 5: unterminated `s' command\nrc=1\nsed: -e expression #1, char 7: unterminated `s' command\nrc=1\nsed: -e expression #1, char 3: unknown command: `k'\nrc=1\nsed: -e expression #1, char 9: strings for `y' command are different lengths\nrc=1\nsed: -e expression #1, char 4: missing command\nrc=1\nsed: -e expression #1, char 0: unmatched `{'\nrc=1\nsed: -e expression #1, char 2: unexpected `}'\nrc=1\nbbc\nrc=0\nsed: -e expression #1, char 3: missing command\nrc=1\nsed: -e expression #1, char 2: missing command\nrc=1\n");
		assert.strictEqual(r.stderr, "");
	});

	test("LC-49 (sed): `s/x/y/2g` replaces the second match and every one after it", async () => {
		const { sh } = overlayBash({});
		// the expected output is GNU sed 4.8's own (docker, LC_ALL=C.UTF-8), recorded once
		const r = await sh.exec("echo 'foo foo foo foo' | sed 's/o/0/2g'\necho 'foo foo foo foo' | sed 's/foo/X/3g'\necho 'foo foo foo foo' | sed 's/foo/X/3'\necho 'aaaa' | sed 's/a/b/2g'\necho 'aaaa' | sed 's/a/b/5g'\necho 'abab' | sed -E 's/(a)(b)/\\2\\1/2g'");
		assert.strictEqual(r.stdout, "fo0 f00 f00 f00\nfoo foo X X\nfoo foo X foo\nabbb\naaaa\nabba\n");
		assert.strictEqual(r.stderr, "");
	});

	test("LC-54 (find -printf): the type, the starting point, the links and blocks, a link's target, and the conversions of a time with the ten digits of fraction GNU prints (`%T@`, `%TT`, `%t`) and the rest of them", async () => {
		const { sh } = overlayBash({});
		// the expected output is GNU find 4.8's own (docker, LC_ALL=C.UTF-8), recorded once
		const r = await sh.exec("mkdir -p d/s; printf 'hello\\n' > d/f; printf 'x' > d/s/g; : > d/e; export TZ=UTC; touch -d '2020-09-13 12:26:40' d/f d/s/g d/s d d/e; touch -d '2023-11-14 22:13:27' d/f\nfind d -mindepth 1 -printf '%p\\n' | sort | tr '\\n' ' '; echo\nfind d -mindepth 1 -printf '%P\\n' | sort | tr '\\n' ' '; echo\nfind d -mindepth 1 -printf '%f\\n' | sort | tr '\\n' ' '; echo\nfind d -mindepth 1 -printf '%h\\n' | sort | tr '\\n' ' '; echo\nfind d -mindepth 1 -printf '%H\\n' | sort | tr '\\n' ' '; echo\nfind d -mindepth 1 -printf '%s\\n' | sort | tr '\\n' ' '; echo\nfind d -mindepth 1 -printf '%y\\n' | sort | tr '\\n' ' '; echo\nfind d -mindepth 1 -printf '%m\\n' | sort | tr '\\n' ' '; echo\nfind d -mindepth 1 -printf '%M\\n' | sort | tr '\\n' ' '; echo\nfind d -mindepth 1 -printf '%d\\n' | sort | tr '\\n' ' '; echo\nfind d -mindepth 1 -printf '%n\\n' | sort | tr '\\n' ' '; echo\nfind d -mindepth 1 -printf '%l\\n' | sort | tr '\\n' ' '; echo\nfind d -mindepth 1 -printf '%b\\n' | sort | tr '\\n' ' '; echo\nfind d -mindepth 1 -printf '%k\\n' | sort | tr '\\n' ' '; echo\nfind d -mindepth 1 -printf '%T@\\n' | sort | tr '\\n' ' '; echo\nfind d -mindepth 1 -printf '%t\\n' | sort | tr '\\n' ' '; echo\nfind d -mindepth 1 -printf '%Tc\\n' | sort | tr '\\n' ' '; echo\nfind d -mindepth 1 -printf '%TY-%Tm-%Td\\n' | sort | tr '\\n' ' '; echo\nfind d -mindepth 1 -printf '%TT\\n' | sort | tr '\\n' ' '; echo\nfind d -mindepth 1 -printf '%TS\\n' | sort | tr '\\n' ' '; echo\nfind d -mindepth 1 -printf '%TH:%TM\\n' | sort | tr '\\n' ' '; echo\nfind d -mindepth 1 -printf '%TD\\n' | sort | tr '\\n' ' '; echo\nfind d -mindepth 1 -printf '%Ty\\n' | sort | tr '\\n' ' '; echo\nfind d -mindepth 1 -printf '%Te\\n' | sort | tr '\\n' ' '; echo\nfind d -mindepth 1 -printf '%Tj\\n' | sort | tr '\\n' ' '; echo\nfind d -mindepth 1 -printf '%Ta\\n' | sort | tr '\\n' ' '; echo\nfind d -mindepth 1 -printf '%TA\\n' | sort | tr '\\n' ' '; echo\nfind d -mindepth 1 -printf '%Tb\\n' | sort | tr '\\n' ' '; echo\nfind d -mindepth 1 -printf '%TB\\n' | sort | tr '\\n' ' '; echo\nfind d -mindepth 1 -printf '%TR\\n' | sort | tr '\\n' ' '; echo\nfind d -mindepth 1 -printf '%Tp\\n' | sort | tr '\\n' ' '; echo\nfind d -mindepth 1 -printf '%TI\\n' | sort | tr '\\n' ' '; echo\nfind d -mindepth 1 -printf '%Tu\\n' | sort | tr '\\n' ' '; echo\nfind d -mindepth 1 -printf '%Tw\\n' | sort | tr '\\n' ' '; echo\nfind d -mindepth 1 -printf '%%\\n' | sort | tr '\\n' ' '; echo\nfind d -mindepth 1 -printf '%-5s|\\n' | sort | tr '\\n' ' '; echo\nfind d -mindepth 1 -printf '%5s|\\n' | sort | tr '\\n' ' '; echo\nfind d -mindepth 1 -printf '%.3s|\\n' | sort | tr '\\n' ' '; echo\nfind d -mindepth 1 -printf '%p %s %y\\n' | sort | tr '\\n' ' '; echo");
		assert.strictEqual(r.stdout, "d/e d/f d/s d/s/g \ne f s s/g \ne f g s \nd d d d/s \nd d d d \n0 1 4096 6 \nd f f f \n644 644 644 755 \n-rw-r--r-- -rw-r--r-- -rw-r--r-- drwxr-xr-x \n1 1 1 2 \n1 1 1 2 \n    \n0 8 8 8 \n0 4 4 4 \n1600000000.0000000000 1600000000.0000000000 1600000000.0000000000 1700000007.0000000000 \nSun Sep 13 12:26:40.0000000000 2020 Sun Sep 13 12:26:40.0000000000 2020 Sun Sep 13 12:26:40.0000000000 2020 Tue Nov 14 22:13:27.0000000000 2023 \nSun Sep 13 12:26:40 2020 Sun Sep 13 12:26:40 2020 Sun Sep 13 12:26:40 2020 Tue Nov 14 22:13:27 2023 \n2020-09-13 2020-09-13 2020-09-13 2023-11-14 \n12:26:40.0000000000 12:26:40.0000000000 12:26:40.0000000000 22:13:27.0000000000 \n27.0000000000 40.0000000000 40.0000000000 40.0000000000 \n12:26 12:26 12:26 22:13 \n09/13/20 09/13/20 09/13/20 11/14/23 \n20 20 20 23 \n13 13 13 14 \n257 257 257 318 \nSun Sun Sun Tue \nSunday Sunday Sunday Tuesday \nNov Sep Sep Sep \nNovember September September September \n12:26 12:26 12:26 22:13 \nPM PM PM PM \n10 12 12 12 \n2 7 7 7 \n0 0 0 2 \n% % % % \n0    | 1    | 4096 | 6    | \n    0|     1|     6|  4096| \n0| 1| 409| 6| \nd/e 0 f d/f 6 f d/s 4096 d d/s/g 1 f \n");
		assert.strictEqual(r.stderr, "");
	});

	test("LC-55 (printf): an escape in the format that makes a `%` (`\\045`, `\\x25`) is a character of the output and not the start of a conversion", async () => {
		const { sh } = overlayBash({});
		// the expected output is GNU bash 5.1's own (docker, LC_ALL=C.UTF-8), recorded once
		const r = await sh.exec("printf '\\045\\n'; printf '\\045s\\n'; printf '\\x25d\\n'; printf 'a\\045b\\046c\\n'; printf '\\045\\045\\n'; printf '%s\\n' '\\045'; printf '%b\\n' '\\045s'; printf '\\0452\\n'; x=$(printf '\\045d'); echo \"$x\"; printf '%%\\n'; printf '\\134n\\n'; printf '\\1341\\n'; printf '\\u0025d|\\U00000025d|\\u0041\\n'; printf '\\x\\045d\\n'; printf '\\q\\045d\\n'");
		assert.strictEqual(r.stdout, "%\n%s\n%d\na%b&c\n%%\n\\045\n%s\n%2\n%d\n%\n\\n\n\\1\n%d|%d|A\n\\x%d\n\\q%d\n");
		assert.strictEqual(r.stderr, "");
	});

	test("LC-56 (sed script grammar): a command is followed by `;`, a newline, `}` or the end (\"extra characters after command\"), an s flag that is not one is \"unknown option to `s'\", the repeats of a flag and a zero count are said, blanks between the flags are skipped, line address 0 is for `0,/re/` only, a label that is not there is \"can't find label\" with status 4", async () => {
		const { sh } = overlayBash({});
		// the expected output is GNU's own (sed 4.8, grep 3.7: docker, LC_ALL=C.UTF-8), recorded once
		const r = await sh.exec("printf 'a\\nb\\nab\\n' > f\nsed -n 'p x' f 2>&1; echo \"rc=$?\"\nsed -n 'dp' f 2>&1; echo \"rc=$?\"\nsed '{p}p' f 2>&1; echo \"rc=$?\"\nsed 's/a/b/gx' f 2>&1; echo \"rc=$?\"\nsed -n 's/a/b/ p' f 2>&1; echo \"rc=$?\"\nsed -n 's/a/b/g p' f 2>&1; echo \"rc=$?\"\nsed -n 's/a/b/;p' f 2>&1; echo \"rc=$?\"\nsed -n 's/a/b/gg' f 2>&1; echo \"rc=$?\"\nsed -n 's/a/b/pp' f 2>&1; echo \"rc=$?\"\nsed -n 's/a/b/0' f 2>&1; echo \"rc=$?\"\nsed -n 's/a/b/2 3' f 2>&1; echo \"rc=$?\"\nsed -n 'y/a/b/x' f 2>&1; echo \"rc=$?\"\nsed -n '0p' f 2>&1; echo \"rc=$?\"\nsed -n '0,2p' f 2>&1; echo \"rc=$?\"\nsed '0,/b/d' f 2>&1; echo \"rc=$?\"\nsed 'b nolabel' f 2>&1; echo \"rc=$?\"\nsed -n '$!{p;p}' f 2>&1; echo \"rc=$?\"\nsed -n '/a/{p;p};$p' f 2>&1; echo \"rc=$?\"");
		assert.strictEqual(r.stdout, "sed: -e expression #1, char 3: extra characters after command\nrc=1\nsed: -e expression #1, char 2: extra characters after command\nrc=1\nsed: -e expression #1, char 4: extra characters after command\nrc=1\nsed: -e expression #1, char 8: unknown option to `s'\nrc=1\nb\nbb\nrc=0\nb\nbb\nrc=0\nb\nb\nbb\nrc=0\nsed: -e expression #1, char 8: multiple `g' options to `s' command\nrc=1\nsed: -e expression #1, char 8: multiple `p' options to `s' command\nrc=1\nsed: -e expression #1, char 7: number option to `s' command may not be zero\nrc=1\nsed: -e expression #1, char 9: multiple number options to `s' command\nrc=1\nsed: -e expression #1, char 7: extra characters after command\nrc=1\nsed: -e expression #1, char 2: invalid usage of line address 0\nrc=1\nsed: -e expression #1, char 4: invalid usage of line address 0\nrc=1\nab\nrc=0\nsed: can't find label for jump to `nolabel'\nrc=4\na\na\nb\nb\nrc=0\na\na\nab\nab\nab\nrc=0\n");
		assert.strictEqual(r.stderr, "");
	});

	test("LC-56 (regular expressions are read when the script is read, and the way GNU reads them): a class or collating element in a bracket does not end it (`[[:alpha:]/]`), a bracket that is not closed is \"unterminated\", `[:space:]` is the mistake GNU names (sed 4, grep 2), an invalid expression is said before any line is read (in a command that never runs, at the end of a range), an interval that is not closed or not valid, a collating element of more than one character, a back-reference to a group that is not there", async () => {
		const { sh } = overlayBash({});
		// the expected output is GNU's own (sed 4.8, grep 3.7: docker, LC_ALL=C.UTF-8), recorded once
		const r = await sh.exec("printf 'a/b&c:d\\nx]y\\n:a:\\n' > f\nsed 's/[[:alpha:]/]/X/g' f 2>&1; echo \"rc=$?\"\nsed -n '/[[:alpha:]/]/p' f 2>&1; echo \"rc=$?\"\nsed 's/[[.].]/]/X/' f 2>&1; echo \"rc=$?\"\nsed 's/[[:alpha:]/X/' f 2>&1; echo \"rc=$?\"\nsed -n '/a[/p' f 2>&1; echo \"rc=$?\"\nsed 's/[[:]/X/]/Y/' f 2>&1; echo \"rc=$?\"\nsed 's/[:alpha:]/X/' f 2>&1; echo \"rc=$?\"\nsed -n '/x/s/[:a:]/y/p' f 2>&1; echo \"rc=$?\"\nsed -n '/nothing/s/\\(/y/p' f 2>&1; echo \"rc=$?\"\nsed -n '2,/\\(/p' f 2>&1; echo \"rc=$?\"\nsed -E -n '/a{1/p' f 2>&1; echo \"rc=$?\"\nsed -n '/a\\{1/p' f 2>&1; echo \"rc=$?\"\nsed -n '/a\\{x\\}/p' f 2>&1; echo \"rc=$?\"\nsed -E -n '/{1}/p' f 2>&1; echo \"rc=$?\"\nsed 's/[[.space.]]/X/' f 2>&1; echo \"rc=$?\"\nsed 's/[[=ab=]]/X/' f 2>&1; echo \"rc=$?\"\nsed -E 's/(a)\\2/X/' f 2>&1; echo \"rc=$?\"\ngrep -c '[:alpha:]' f 2>&1; echo \"rc=$?\"\ngrep -c '[[:alpha:]' f 2>&1; echo \"rc=$?\"\ngrep -c 'a\\{1' f 2>&1; echo \"rc=$?\"\ngrep -E -c 'a{1' f 2>&1; echo \"rc=$?\"\ngrep -c '[\\n]' f 2>&1; echo \"rc=$?\"\ngrep -c '\\x2e' f 2>&1; echo \"rc=$?\"");
		assert.strictEqual(r.stdout, "XXX&X:X\nX]X\n:X:\nrc=0\na/b&c:d\nx]y\n:a:\nrc=0\naXb&c:d\nxXy\n:a:\nrc=0\nsed: -e expression #1, char 15: unterminated `s' command\nrc=1\nsed: -e expression #1, char 5: unterminated address regex\nrc=1\nsed: -e expression #1, char 13: unterminated `s' command\nrc=1\nsed: character class syntax is [[:space:]], not [:space:]\nrc=4\nsed: character class syntax is [[:space:]], not [:space:]\nrc=4\nsed: -e expression #1, char 17: Unmatched ( or \\(\nrc=1\nsed: -e expression #1, char 6: Unmatched ( or \\(\nrc=1\nsed: -e expression #1, char 5: Unmatched \\{\nrc=1\nsed: -e expression #1, char 6: Unmatched \\{\nrc=1\nsed: -e expression #1, char 8: Invalid content of \\{\\}\nrc=1\nsed: -e expression #1, char 5: Invalid preceding regular expression\nrc=1\nsed: -e expression #1, char 16: Invalid collation character\nrc=1\nsed: -e expression #1, char 13: Invalid collation character\nrc=1\nsed: -e expression #1, char 10: Invalid back reference\nrc=1\ngrep: character class syntax is [[:space:]], not [:space:]\nrc=2\ngrep: Unmatched [, [^, [:, [., or [=\nrc=2\ngrep: Unmatched \\{\nrc=2\n0\nrc=1\n0\nrc=1\n0\nrc=1\n");
		assert.strictEqual(r.stderr, "");
	});

	test("LC-57 (s///N): when the line has fewer than N matches nothing is substituted: no `p`, `t` does not branch, `w` writes nothing", async () => {
		const { sh } = overlayBash({});
		// the expected output is GNU's own (sed 4.8, grep 3.7: docker, LC_ALL=C.UTF-8), recorded once
		const r = await sh.exec("printf 'aXa\\nb\\naaa\\nXa\\n' > f\nsed -n 's/a/Y/2p' f 2>&1; echo \"rc=$?\"\nsed -n 's/a/Y/3p' f 2>&1; echo \"rc=$?\"\nsed 's/a/Y/2;t done;s/$/!/;:done' f 2>&1; echo \"rc=$?\"\nsed -n 's/a/Y/2gp' f 2>&1; echo \"rc=$?\"\nsed 's/a/Y/3g;t;s/$/?/' f 2>&1; echo \"rc=$?\"\nsed -n 's/a/Y/2w out' f; cat out");
		assert.strictEqual(r.stdout, "aXY\naYa\nrc=0\naaY\nrc=0\naXY\nb!\naYa\nXa!\nrc=0\naXY\naYY\nrc=0\naXa?\nb?\naaY\nXa?\nrc=0\naXY\naYa\n");
		assert.strictEqual(r.stderr, "");
	});

	test("LC-58 (sed, basic expressions): `{` and `}` are plain characters (`s/a{1}/X/`)", async () => {
		const { sh } = overlayBash({});
		// the expected output is GNU's own (sed 4.8, grep 3.7: docker, LC_ALL=C.UTF-8), recorded once
		const r = await sh.exec("printf 'a{1}\\naa\\n{x}\\n' > f\nsed -n 's/a{1}/X/p' f 2>&1; echo \"rc=$?\"\nsed -n '/a{1}/p' f 2>&1; echo \"rc=$?\"\nsed 's/{x}/Y/' f 2>&1; echo \"rc=$?\"\nsed -E 's/a{1}/X/' f 2>&1; echo \"rc=$?\"\nsed -n 's/{/(/gp' f 2>&1; echo \"rc=$?\"\nsed 's/a\\{2\\}/X/' f 2>&1; echo \"rc=$?\"");
		assert.strictEqual(r.stdout, "X\nrc=0\na{1}\nrc=0\na{1}\naa\nY\nrc=0\nX{1}\nXa\n{x}\nrc=0\na(1}\n(x}\nrc=0\na{1}\nX\n{x}\nrc=0\n");
		assert.strictEqual(r.stderr, "");
	});

	test("the numeric escapes of a pattern are characters only with their digits (`\\\\d` is the letter d, `[\\\\d]` the same, `\\\\x61` and `\\\\o141` are `a`), `\\\\L \\\\U \\\\E` clear a one-shot `\\\\u` or `\\\\l`, the last of `\\\\u \\\\l` wins, `\\\\<` and `\\\\>` beside a character that is not a word character match nothing, and grep reads none of the sed escapes", async () => {
		const { sh } = overlayBash({});
		// the expected output is GNU's own (sed 4.8, grep 3.7: docker, LC_ALL=C.UTF-8), recorded once
		const r = await sh.exec("printf 'a.b d1 x2 ab\\n' > f\nsed 's/\\d/X/g' f 2>&1\nsed 's/[\\d]/X/g' f 2>&1\nsed 's/\\x/X/g' f 2>&1\nsed 's/\\d049/X/g' f 2>&1\nsed 's/\\x61/X/g' f 2>&1\nsed 's/\\o141/X/g' f 2>&1\nsed 's/[\\x61\\o142]/X/g' f 2>&1\nsed 's/\\(a\\)\\(b\\)/\\u\\L\\1\\2/' f 2>&1\nsed 's/a/\\l\\Uab/' f 2>&1\nsed 's/ab/\\u\\L&X/' f 2>&1\nsed 's/a/\\u\\lA/' f 2>&1\nsed 's/b/\\l\\ub/' f 2>&1\nsed 's/\\<./X/g' f 2>&1\nsed 's/.\\>/X/g' f 2>&1\nsed 's/\\.\\>/X/g' f 2>&1\nsed 's/\\<\\./X/g' f 2>&1\nsed 's/\\<[ab]/X/g' f 2>&1\ngrep -o '\\d' f 2>&1\ngrep -c '\\.\\>' f 2>&1");
		assert.strictEqual(r.stdout, "a.b X1 x2 ab\na.b X1 x2 ab\na.b d1 X2 ab\na.b dX x2 ab\nX.b d1 x2 Xb\nX.b d1 x2 Xb\nX.X d1 x2 XX\na.b d1 x2 ab\nAB.b d1 x2 ab\na.b d1 x2 abx\na.b d1 x2 ab\na.B d1 x2 ab\nX.X X1 X2 Xb\nX.X dX xX aX\na.b d1 x2 ab\na.b d1 x2 ab\nX.X d1 x2 Xb\nd\n0\n");
		assert.strictEqual(r.stderr, "");
	});

	test("what the engine says where GNU does something it cannot (its own words, pinned so that they do not change by accident): a repeat count over 1000 or a back-reference in a pattern is said, status 1 (grep 2), `s///e` and `-l` and `L` are refused, and the `\\c` that ends a pattern or a replacement is the letter", async () => {
		const { sh } = overlayBash({});
		const r = await sh.exec("printf 'a\\nb\\n' > f\nsed -E 's/a{1001}/X/' f 2>&1; echo \"rc=$?\"\nsed -E 's/a{1001,}/X/' f 2>&1; echo \"rc=$?\"\nsed -E 's/a{1001,1001}/X/' f 2>&1; echo \"rc=$?\"\nsed -E 's/a{32767}/X/' f 2>&1; echo \"rc=$?\"\nsed -E 's/a{32768}/X/' f 2>&1; echo \"rc=$?\"\nsed -E 's/a{1,32768}/X/' f 2>&1; echo \"rc=$?\"\nsed -E 's/a{2,1}/X/' f 2>&1; echo \"rc=$?\"\nsed 's/\\(a\\)\\1/X/' f 2>&1; echo \"rc=$?\"\nsed -E 's/(a)\\1/X/' f 2>&1; echo \"rc=$?\"\nsed 's/a\\c/X/' f 2>&1; echo \"rc=$?\"\nsed 's/a/b/e' f 2>&1; echo \"rc=$?\"\nsed -n 's/a/\\c/p' f 2>&1; echo \"rc=$?\"\nsed -n 's/a/[\\cA]/p' f 2>&1 | od -An -c; echo \"rc=$?\"\ngrep -E -c 'a{1001}' f 2>&1; echo \"rc=$?\"\ngrep -c '\\(a\\)\\1' f 2>&1; echo \"rc=$?\"\nsed -n -l 5 l f 2>&1; echo \"rc=$?\"\nsed --line-length=5 -n l f 2>&1; echo \"rc=$?\"\nsed -n 'L' f 2>&1; echo \"rc=$?\"");
		assert.strictEqual(r.stdout, "sed: -e expression #1, char 12: a repeat count over 1000 is not supported by this shell\nrc=1\nsed: -e expression #1, char 13: a repeat count over 1000 is not supported by this shell\nrc=1\nsed: -e expression #1, char 17: a repeat count over 1000 is not supported by this shell\nrc=1\nsed: -e expression #1, char 13: a repeat count over 1000 is not supported by this shell\nrc=1\nsed: -e expression #1, char 13: Regular expression too big\nrc=1\nsed: -e expression #1, char 15: Regular expression too big\nrc=1\nsed: -e expression #1, char 11: Invalid content of \\{\\}\nrc=1\nsed: -e expression #1, char 12: back-references in a pattern are not supported by this shell\nrc=1\nsed: -e expression #1, char 10: back-references in a pattern are not supported by this shell\nrc=1\na\nb\nrc=0\nsed: e command (shell execution) is not supported in sandboxed environment\nrc=1\nc\nrc=0\n   [ 001   ]  \\n\nrc=0\ngrep: a repeat count over 1000 is not supported by this shell\nrc=2\ngrep: back-references in a pattern are not supported by this shell\nrc=2\nsed: invalid option -- 'l'\nrc=1\nsed: unrecognized option '--line-length=5'\nrc=1\nsed: -e expression #1, char 1: unknown command: `L'\nrc=1\n");
		assert.strictEqual(r.stderr, "");
	});

	test("LC-60 (date): a year before 1000 has four digits in %F, %Y and %G (`0100-01-02`), and the ISO year of a date before the year 100 is its own (`new Date(6, ...)` was 1906)", async () => {
		const { sh } = overlayBash({});
		// the expected output is GNU date 8.32's own (docker, LC_ALL=C.UTF-8), recorded once
		const r = await sh.exec("export TZ=UTC; for d in @-59011372800 @-30610310400 @-30610224000 @-62135510400 @-46374422400 @-61965475200 @-59011545600 @-62135596800; do date -d \"$d\" '+%F|%Y|%C|%y|%G|%m'; done; date -d @-59011459200 '+%a %b %e %Y'");
		assert.strictEqual(r.stdout, "0100-01-02|0100|01|00|0099|01\n0999-12-31|0999|09|99|1000|12\n1000-01-01|1000|10|00|1000|01\n0001-01-02|0001|00|01|0001|01\n0500-06-15|0500|05|00|0500|06\n0006-05-24|0006|00|06|0006|05\n0099-12-31|0099|00|99|0099|12\n0001-01-01|0001|00|01|0001|01\nFri Jan  1 0100\n");
		assert.strictEqual(r.stderr, "");
	});

	test('LC-61 .. LC-71 (round 6): with a patch taken out the cases GNU answered are different from GNU again, and with it every one is GNU\'s', async () => {
		const { makeHost } = require('./shell-engine-support.js');
		const golden = JSON.parse(fs.readFileSync(path.join(REPO, 'web', 'test', 'fixtures', 'shell', 'golden', 'golden.json'), 'utf8'));
		const byName = new Map(golden.cases.map((c) => [c.name, c]));
		const CASES = {
			'LC-61': ['r6-grep-r-dot-entries'],
			'LC-62': ['r6-arith-assoc-default', 'r6-arith-default-forms', 'r6-arith-assoc-quoted-subscript', 'r6-arith-element-assign-and-plus'],
			'LC-63': ['r6-for-no-in'],
			'LC-64': ['r6-date-flags-numbers', 'r6-date-flags-text', 'r6-date-flags-grid', 'r6-date-colon-z'],
			'LC-65': ['r6-find-exec-status', 'r6-find-mtime-days', 'r6-find-mmin'],
			'LC-66': ['r6-printf-quote-escapes'],
			'LC-67': ['r6-sort-numeric-reading'],
			'LC-68': ['r6-split-edge-blanks', 'r6-split-edge-command-word', 'r6-split-edge-grid', 'r6-split-edge-ifs-and-arrays'],
			'LC-69': ['r6-tee-slash-names'],
			'LC-71': ['r6-jq-csv-sh-formats'],
		};
		const differs = async (Engine, name) => {
			const c = byName.get(name);
			assert.ok(c && typeof c.stdout === 'string', 'a recorded case: ' + name);
			const tree = makeTree({});
			const h = await makeHost({ Engine, tree });
			const r = await h.run(c.script + '\n', { cwd: '/w' });
			return r.stdout !== c.stdout || r.exitCode !== c.exit;
		};
		for (const [id, names] of Object.entries(CASES)) {
			const without = await loader.loadEngineWithout([id]);
			let red = 0;
			for (const n of names) {
				if (await differs(without, n)) { red++; }
				assert.strictEqual(await differs(E, n), false, `${id}: ${n} is GNU's with the patch`);
			}
			assert.ok(red > 0, `${id}: with the patch taken out none of ${names.join(', ')} differs from GNU: the patch is pinned by nothing`);
		}
	});

	test('LC-70 (awk printf): n calls take n times as long, not n squared (the room left was counted in bytes over everything printed, by every call)', async () => {
		const { makeHost } = require('./shell-engine-support.js');
		const script = "seq 1 16000 | awk '{printf \"%5d %e %s\\n\", NR, NR*1.5, $1}' | tail -1";
		const time = async (Engine) => {
			const h = await makeHost({ Engine, tree: makeTree({}) });
			const t0 = process.hrtime.bigint();
			const r = await h.run(script, { cwd: '/w' });
			assert.strictEqual(r.stdout, '16000 2.400000e+04 16000\n');
			return Number(process.hrtime.bigint() - t0) / 1e6;
		};
		const fast = await time(E);
		const slow = await time(await loader.loadEngineWithout(['LC-70']));
		assert.ok(fast < 1500, `16,000 printf calls took ${fast} ms`);
		assert.ok(slow > fast * 4, `without the patch ${slow} ms, with it ${fast} ms`);
		// the cap on what a program prints is still there
		const h = await makeHost({ Engine: E, tree: makeTree({}) });
		const r = await h.run("awk 'BEGIN { while (1) printf \"%s\", \"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\" }' | wc -c; echo \"rc=$?\"", { cwd: '/w' });
		assert.ok(r.how === 'exit' && /rc=0/.test(r.stdout), r.stdout.slice(0, 100));
	});

	test("LC-35 (sed, the M flag): with it `.` and a list that starts `[^` do not match the newline of a joined pattern space and `^` and `$` match at it; without it `.` matches it; the flag is read whatever flags come with it (`gM`, `Mg`, `gm`, `mg`, `MI`)", async () => {
		const { sh } = overlayBash({});
		// the expected output is GNU sed 4.8's own (docker, LC_ALL=C.UTF-8), recorded once
		const r = await sh.exec("printf 'one\ntwo\nthree\nfour\nfive\n' | sed  'N;N;s/e.t/<&>/' 2>&1; echo \"rc=$?\"\nprintf 'one\ntwo\nthree\nfour\nfive\n' | sed  'N;N;s/e.t/<&>/M' 2>&1; echo \"rc=$?\"\nprintf 'one\ntwo\nthree\nfour\nfive\n' | sed  'N;N;s/e.t/<&>/gM' 2>&1; echo \"rc=$?\"\nprintf 'one\ntwo\nthree\nfour\nfive\n' | sed  'N;N;s/o[^x]t/<&>/' 2>&1; echo \"rc=$?\"\nprintf 'one\ntwo\nthree\nfour\nfive\n' | sed  'N;N;s/o[^x]t/<&>/M' 2>&1; echo \"rc=$?\"\nprintf 'one\ntwo\nthree\nfour\nfive\n' | sed  'N;N;s/e.*t/<&>/M' 2>&1; echo \"rc=$?\"\nprintf 'one\ntwo\nthree\nfour\nfive\n' | sed  'N;N;s/e\\nt/<&>/M' 2>&1; echo \"rc=$?\"\nprintf 'one\ntwo\nthree\nfour\nfive\n' | sed  'N;N;s/[^[:alpha:]]*/<&>/gM' 2>&1; echo \"rc=$?\"\nprintf 'one\ntwo\nthree\nfour\nfive\n' | sed  'N;N;s/^o/<&>/M' 2>&1; echo \"rc=$?\"\nprintf 'one\ntwo\nthree\nfour\nfive\n' | sed  'N;N;s/e$/<&>/gM' 2>&1; echo \"rc=$?\"\nprintf 'one\ntwo\nthree\nfour\nfive\n' | sed  'N;N;s/^t/X/gm' 2>&1; echo \"rc=$?\"\nprintf 'one\ntwo\nthree\nfour\nfive\n' | sed  'N;N;s/^t/X/Mg' 2>&1; echo \"rc=$?\"\nprintf 'one\ntwo\nthree\nfour\nfive\n' | sed  'N;N;s/^t/X/mg' 2>&1; echo \"rc=$?\"\nprintf 'one\ntwo\nthree\nfour\nfive\n' | sed  'N;N;s/$/X/gm' 2>&1; echo \"rc=$?\"\nprintf 'one\ntwo\nthree\nfour\nfive\n' | sed  'N;N;s/^t.*/X/Mg' 2>&1; echo \"rc=$?\"\nprintf 'one\ntwo\nthree\nfour\nfive\n' | sed  'N;N;s/e$/X/pM' 2>&1; echo \"rc=$?\"\nprintf 'one\ntwo\nthree\nfour\nfive\n' | sed  'N;N;s/e$/X/gpM' 2>&1; echo \"rc=$?\"\nprintf 'one\ntwo\nthree\nfour\nfive\n' | sed -n 'N;N;s/^t/X/gmp' 2>&1; echo \"rc=$?\"\nprintf 'one\ntwo\nthree\nfour\nfive\n' | sed -n 'N;N;s/^t/X/MIp' 2>&1; echo \"rc=$?\"\nprintf 'one\ntwo\nthree\nfour\nfive\n' | sed -n 'N;N;s/^t/X/IMp' 2>&1; echo \"rc=$?\"\nprintf 'one\ntwo\nthree\nfour\nfive\n' | sed -n 'N;N;s/^t/X/mp' 2>&1; echo \"rc=$?\"\nprintf 'one\ntwo\nthree\nfour\nfive\n' | sed -n 'N;N;/e.t/Mp' 2>&1; echo \"rc=$?\"\nprintf 'one\ntwo\nthree\nfour\nfive\n' | sed -n 'N;N;/e.t/p' 2>&1; echo \"rc=$?\"\nprintf 'one\ntwo\nthree\nfour\nfive\n' | sed -n 'N;N;\\,e.t,Mp' 2>&1; echo \"rc=$?\"\nprintf 'one\ntwo\nthree\nfour\nfive\n' | sed -n 'N;N;/e.*t/Mp' 2>&1; echo \"rc=$?\"\nprintf 'one\ntwo\nthree\nfour\nfive\n' | sed -n 'N;N;/o[^x]t/Mp' 2>&1; echo \"rc=$?\"\nprintf 'one\ntwo\nthree\nfour\nfive\n' | sed -n 'N;N;/o[^x]t/p' 2>&1; echo \"rc=$?\"\nprintf 'one\ntwo\nthree\nfour\nfive\n' | sed -n 'N;N;/e$/Mp' 2>&1; echo \"rc=$?\"\nprintf 'one\ntwo\nthree\nfour\nfive\n' | sed -n 'N;N;/e$/p' 2>&1; echo \"rc=$?\"\nprintf 'one\ntwo\nthree\nfour\nfive\n' | sed -n 'N;N;/^o/Mp' 2>&1; echo \"rc=$?\"\nprintf 'one\ntwo\nthree\nfour\nfive\n' | sed -n 'N;N;/e\\nt/Mp' 2>&1; echo \"rc=$?\"");
		assert.strictEqual(r.stdout, "on<e\nt>wo\nthree\nfour\nfive\nrc=0\none\ntwo\nthree\nfour\nfive\nrc=0\none\ntwo\nthree\nfour\nfive\nrc=0\none\ntw<o\nt>hree\nfour\nfive\nrc=0\none\ntwo\nthree\nfour\nfive\nrc=0\none\ntwo\nthree\nfour\nfive\nrc=0\non<e\nt>wo\nthree\nfour\nfive\nrc=0\n<>o<>n<>e<>\n<>t<>w<>o<>\n<>t<>h<>r<>e<>e<>\nfour\nfive\nrc=0\n<o>ne\ntwo\nthree\nfour\nfive\nrc=0\non<e>\ntwo\nthre<e>\nfour\nfive\nrc=0\none\nXwo\nXhree\nfour\nfive\nrc=0\none\nXwo\nXhree\nfour\nfive\nrc=0\none\nXwo\nXhree\nfour\nfive\nrc=0\noneX\ntwoX\nthreeX\nfour\nfive\nrc=0\none\nX\nX\nfour\nfive\nrc=0\nonX\ntwo\nthree\nonX\ntwo\nthree\nfour\nfive\nrc=0\nonX\ntwo\nthreX\nonX\ntwo\nthreX\nfour\nfive\nrc=0\none\nXwo\nXhree\nrc=0\none\nXwo\nthree\nrc=0\none\nXwo\nthree\nrc=0\none\nXwo\nthree\nrc=0\nrc=0\none\ntwo\nthree\nrc=0\nrc=0\nrc=0\nrc=0\none\ntwo\nthree\nrc=0\none\ntwo\nthree\nrc=0\none\ntwo\nthree\nrc=0\none\ntwo\nthree\nrc=0\none\ntwo\nthree\nrc=0\n");
		assert.strictEqual(r.stderr, "");
	});

	test("LC-56 (sed, what follows an address): GNU takes only blanks between an address or a `!` and its command, so a `;` or a newline there is an unknown command, an address and a number is an unknown command, a second `!` and line address 0 are said at once, a range with no end is \"unexpected `,'\", a leading comma is an unknown command, `+N` is not a first address, and an address that nothing follows is a missing command", async () => {
		const { sh } = overlayBash({});
		// the expected output is GNU sed 4.8's own (docker, LC_ALL=C.UTF-8), recorded once
		const r = await sh.exec("printf 'one\ntwo\nthree\nfour\nfive\n' | sed -n '1;p' 2>&1; echo \"rc=$?\"\nprintf 'one\ntwo\nthree\nfour\nfive\n' | sed -n '1,2;p' 2>&1; echo \"rc=$?\"\nprintf 'one\ntwo\nthree\nfour\nfive\n' | sed -n '/a/;p' 2>&1; echo \"rc=$?\"\nprintf 'one\ntwo\nthree\nfour\nfive\n' | sed -n '1!;p' 2>&1; echo \"rc=$?\"\nprintf 'one\ntwo\nthree\nfour\nfive\n' | sed -n '1;' 2>&1; echo \"rc=$?\"\nprintf 'one\ntwo\nthree\nfour\nfive\n' | sed -n '1\n' 2>&1; echo \"rc=$?\"\nprintf 'one\ntwo\nthree\nfour\nfive\n' | sed -n '1,2\n' 2>&1; echo \"rc=$?\"\nprintf 'one\ntwo\nthree\nfour\nfive\n' | sed -n '1 2p' 2>&1; echo \"rc=$?\"\nprintf 'one\ntwo\nthree\nfour\nfive\n' | sed -n '1,2 3p' 2>&1; echo \"rc=$?\"\nprintf 'one\ntwo\nthree\nfour\nfive\n' | sed -n '1!!p' 2>&1; echo \"rc=$?\"\nprintf 'one\ntwo\nthree\nfour\nfive\n' | sed -n '0' 2>&1; echo \"rc=$?\"\nprintf 'one\ntwo\nthree\nfour\nfive\n' | sed -n ',3p' 2>&1; echo \"rc=$?\"\nprintf 'one\ntwo\nthree\nfour\nfive\n' | sed -n '1,p' 2>&1; echo \"rc=$?\"\nprintf 'one\ntwo\nthree\nfour\nfive\n' | sed -n '/a/,p' 2>&1; echo \"rc=$?\"\nprintf 'one\ntwo\nthree\nfour\nfive\n' | sed -n '1,' 2>&1; echo \"rc=$?\"\nprintf 'one\ntwo\nthree\nfour\nfive\n' | sed -n '+1p' 2>&1; echo \"rc=$?\"\nprintf 'one\ntwo\nthree\nfour\nfive\n' | sed -n '~2p' 2>&1; echo \"rc=$?\"\nprintf 'one\ntwo\nthree\nfour\nfive\n' | sed -n '1~2~3p' 2>&1; echo \"rc=$?\"\nprintf 'one\ntwo\nthree\nfour\nfive\n' | sed -n '1' 2>&1; echo \"rc=$?\"\nprintf 'one\ntwo\nthree\nfour\nfive\n' | sed -n '1,2' 2>&1; echo \"rc=$?\"\nprintf 'one\ntwo\nthree\nfour\nfive\n' | sed -n '$' 2>&1; echo \"rc=$?\"");
		assert.strictEqual(r.stdout, "sed: -e expression #1, char 2: unknown command: `;'\nrc=1\nsed: -e expression #1, char 4: unknown command: `;'\nrc=1\nsed: -e expression #1, char 4: unknown command: `;'\nrc=1\nsed: -e expression #1, char 3: unknown command: `;'\nrc=1\nsed: -e expression #1, char 2: unknown command: `;'\nrc=1\nsed: -e expression #1, char 2: unknown command: `\n'\nrc=1\nsed: -e expression #1, char 4: unknown command: `\n'\nrc=1\nsed: -e expression #1, char 3: unknown command: `2'\nrc=1\nsed: -e expression #1, char 5: unknown command: `3'\nrc=1\nsed: -e expression #1, char 3: multiple `!'s\nrc=1\nsed: -e expression #1, char 1: invalid usage of line address 0\nrc=1\nsed: -e expression #1, char 1: unknown command: `,'\nrc=1\nsed: -e expression #1, char 3: unexpected `,'\nrc=1\nsed: -e expression #1, char 5: unexpected `,'\nrc=1\nsed: -e expression #1, char 2: unexpected `,'\nrc=1\nsed: -e expression #1, char 2: invalid usage of +N or ~N as first address\nrc=1\nsed: -e expression #1, char 2: invalid usage of +N or ~N as first address\nrc=1\nsed: -e expression #1, char 4: unknown command: `~'\nrc=1\nsed: -e expression #1, char 1: missing command\nrc=1\nsed: -e expression #1, char 3: missing command\nrc=1\nsed: -e expression #1, char 1: missing command\nrc=1\n");
		assert.strictEqual(r.stderr, "");
	});

	test("LC-56 (sed, a backslash in a bracket): it is a backslash, so a `[` after it starts an element that the scan for the closing delimiter must find the end of (`[\\[:,]` is not closed, GNU says \"unterminated\"), and a script that ends in a backslash is unterminated where its last character is", async () => {
		const { sh } = overlayBash({});
		// the expected output is GNU sed 4.8's own (docker, LC_ALL=C.UTF-8), recorded once
		const r = await sh.exec("printf 'a\nb\n[\n\\\n]\n,\nx\n:\n.\n=\n/\nab\n' | sed -n '\\,[\\[:,]x,p' 2>&1; echo \"rc=$?\"\nprintf 'a\nb\n[\n\\\n]\n,\nx\n:\n.\n=\n/\nab\n' | sed -n '\\,[\\[.,]x,p' 2>&1; echo \"rc=$?\"\nprintf 'a\nb\n[\n\\\n]\n,\nx\n:\n.\n=\n/\nab\n' | sed -n '\\,[\\[=,]x,p' 2>&1; echo \"rc=$?\"\nprintf 'a\nb\n[\n\\\n]\n,\nx\n:\n.\n=\n/\nab\n' | sed -n '\\,[\\[:a,]x,p' 2>&1; echo \"rc=$?\"\nprintf 'a\nb\n[\n\\\n]\n,\nx\n:\n.\n=\n/\nab\n' | sed -n '/a\\' 2>&1; echo \"rc=$?\"\nprintf 'a\nb\n[\n\\\n]\n,\nx\n:\n.\n=\n/\nab\n' | sed -n '\\,a\\' 2>&1; echo \"rc=$?\"\nprintf 'a\nb\n[\n\\\n]\n,\nx\n:\n.\n=\n/\nab\n' | sed -n '\\,[\\],]x,p' 2>&1; echo \"rc=$?\"\nprintf 'a\nb\n[\n\\\n]\n,\nx\n:\n.\n=\n/\nab\n' | sed -n '/[\\]]/p' 2>&1; echo \"rc=$?\"\nprintf 'a\nb\n[\n\\\n]\n,\nx\n:\n.\n=\n/\nab\n' | sed -n '\\,[a\\,b],p' 2>&1; echo \"rc=$?\"\nprintf 'a\nb\n[\n\\\n]\n,\nx\n:\n.\n=\n/\nab\na,b\na/b\n' | sed -n 's,[\\[:,]x,y,p' 2>&1; echo \"rc=$?\"\nprintf 'a\nb\n[\n\\\n]\n,\nx\n:\n.\n=\n/\nab\na,b\na/b\n' | sed -n 's,[\\[.,]x,y,p' 2>&1; echo \"rc=$?\"\nprintf 'a\nb\n[\n\\\n]\n,\nx\n:\n.\n=\n/\nab\na,b\na/b\n' | sed -n 's,[\\[=,]x,y,p' 2>&1; echo \"rc=$?\"\nprintf 'a\nb\n[\n\\\n]\n,\nx\n:\n.\n=\n/\nab\na,b\na/b\n' | sed -n 's,[a\\,b],y,p' 2>&1; echo \"rc=$?\"\nprintf 'a\nb\n[\n\\\n]\n,\nx\n:\n.\n=\n/\nab\na,b\na/b\n' | sed -n 's/[\\/]/y/p' 2>&1; echo \"rc=$?\"\nprintf 'a\nb\n[\n\\\n]\n,\nx\n:\n.\n=\n/\nab\na,b\na/b\n' | sed -n 's/[\\]]/y/p' 2>&1; echo \"rc=$?\"\nprintf 'a\nb\n[\n\\\n]\n,\nx\n:\n.\n=\n/\nab\na,b\na/b\n' | sed -n 's/[\\n]/y/p' 2>&1; echo \"rc=$?\"");
		assert.strictEqual(r.stdout, "sed: -e expression #1, char 11: unterminated address regex\nrc=1\nsed: -e expression #1, char 11: unterminated address regex\nrc=1\nsed: -e expression #1, char 11: unterminated address regex\nrc=1\nsed: -e expression #1, char 12: unterminated address regex\nrc=1\nsed: -e expression #1, char 3: unterminated address regex\nrc=1\nsed: -e expression #1, char 4: unterminated address regex\nrc=1\nsed: -e expression #1, char 7: unknown command: `]'\nrc=1\nrc=0\na\nb\n\\\n,\nab\nrc=0\nsed: -e expression #1, char 13: unterminated `s' command\nrc=1\nsed: -e expression #1, char 13: unterminated `s' command\nrc=1\nsed: -e expression #1, char 13: unterminated `s' command\nrc=1\ny\ny\ny\ny\nyb\ny,b\ny/b\nrc=0\ny\ny\nayb\nrc=0\nrc=0\nrc=0\n");
		assert.strictEqual(r.stderr, "");
	});


	for (const t of tests) {
		await t.fn();
		console.log('  ok - ' + t.name);
	}
	console.log(`\n${tests.length} tests passed`);
}

main().catch((e) => { console.error(e); process.exit(1); });
