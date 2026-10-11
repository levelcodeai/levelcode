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

	const IDS = ['LC-1', 'LC-2', 'LC-3', 'LC-4', 'LC-5', 'LC-6', 'LC-7', 'LC-8', 'LC-9', 'LC-10', 'LC-11', 'LC-12', 'LC-13', 'LC-14', 'LC-15', 'LC-16', 'LC-17', 'LC-18', 'LC-19', 'LC-20', 'LC-21', 'LC-22', 'LC-23', 'LC-24', 'LC-25', 'LC-26', 'LC-27', 'LC-28', 'LC-29', 'LC-30', 'LC-31'];

	test('there are thirty-one patches, and every anchor occurs exactly once in the original (counted here, not by the script)', () => {
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
		assert.ok(r.text.includes('LC-1 .. LC-31'), 'the notice says how many patches there are');
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
		// `__lcHeal` (the escapes of one string that are UTF-8 together)
		assert.strictEqual(count(r.text, '__lcText.'), 5);
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
			['grep -r', "grep -r '' sub | tr '\n' ' '", 'sub/A:a sub/Z:z sub/a:a sub/b:b '],
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

	for (const t of tests) {
		await t.fn();
		console.log('  ok - ' + t.name);
	}
	console.log(`\n${tests.length} tests passed`);
}

main().catch((e) => { console.error(e); process.exit(1); });
