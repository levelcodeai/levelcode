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

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
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

	const IDS = ['LC-1', 'LC-2', 'LC-3', 'LC-4', 'LC-5', 'LC-6', 'LC-7', 'LC-8', 'LC-9'];

	test('there are nine patches, and every anchor occurs exactly once in the original (counted here, not by the script)', () => {
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
		assert.strictEqual(r.inputSha256, vendorJson.fileSha256);
		assert.ok(r.text.startsWith('/*! LevelCode: this is just-bash@3.6.0'));
		assert.ok(r.text.includes('MODIFIED by LevelCode'));
		assert.ok(r.text.includes('Apache-2.0'));
		assert.ok(r.text.includes('section 4(b)'));
		assert.deepStrictEqual(r.patches.map((p) => p.id), IDS);
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
		assert.deepStrictEqual(Object.keys(E).filter((k) => k !== 'lcSha256').sort(), ['Bash', 'InMemoryFs', 'MountableFs', 'NetworkAccessDeniedError', 'RedirectNotAllowedError', 'TooManyRedirectsError', 'createCommandContext', 'defineCommand', 'getCommandNames', 'getNetworkCommandNames']);
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
		const { sh } = bash({});
		const seen = [];
		const r = await sh.exec("printf 'caf\\303\\251\\n'; echo plain", { onStatement: async (res) => { seen.push(res.stdout); } });
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

	for (const t of tests) {
		await t.fn();
		console.log('  ok - ' + t.name);
	}
	console.log(`\n${tests.length} tests passed`);
}

main().catch((e) => { console.error(e); process.exit(1); });
