/*---------------------------------------------------------------------------------------------
 *  host.js — run: node web/test/unit/host.test.js
 *
 *  Two promises. On the desktop every function does what the call site used to do (same fs call,
 *  same answer), and every capability is on. In the browser, workspace paths map back to the
 *  workspace folder's scheme, reads go through the editor's file system, the capabilities the
 *  agent's tools depend on are off, and a loader written for synchronous reads is served.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

// ---- a vscode stand-in with just what host.js touches ---------------------------------------
class Uri {
	constructor(scheme, p, query = '') { this.scheme = scheme; this.path = p; this.fsPath = p; this.query = query; }
	static file(p) { return new Uri('file', p); }
	with(o) { return new Uri(o.scheme || this.scheme, o.path != null ? o.path : this.path, o.query != null ? o.query : this.query); }
	// Enough of vscode.Uri for the sign-in address: toString(true) keeps `=` and `&` and encodes only `?` and `#`.
	toString(skipEncoding) { return this.scheme + '://' + this.path + (this.query ? '?' + (skipEncoding ? this.query.replace(/[?#]/g, (c) => (c === '?' ? '%3F' : '%23')) : encodeURIComponent(this.query)) : ''); }
}
/** What the sign-in tests watch: commands run, and what was handed to the system browser. */
const signIn = { commands: /** @type {string[]} */ ([]), executed: /** @type {any[][]} */ ([]), external: /** @type {any[]} */ ([]), getCommandsThrows: false };
const vsFiles = new Map();           // path -> Uint8Array, for the browser-side `workspace.fs`
const reads = [];
const vscodeMock = {
	Uri,
	FileType: { File: 1, Directory: 2, SymbolicLink: 64 },
	workspace: {
		workspaceFolders: /** @type {any[]} */ ([]),
		fs: {
			async readFile(uri) { reads.push(uri.toString()); if (!vsFiles.has(uri.path)) { throw new Error('FileNotFound'); } return vsFiles.get(uri.path); },
			async stat(uri) {
				if (vsFiles.has(uri.path)) { return { type: 1, size: vsFiles.get(uri.path).length }; }
				if ([...vsFiles.keys()].some((k) => k.startsWith(uri.path + '/'))) { return { type: 2, size: 0 }; }
				throw new Error('FileNotFound');
			},
		},
		findFiles: (...a) => ['findFiles', ...a],
	},
	commands: {
		async getCommands() { if (signIn.getCommandsThrows) { throw new Error('no ext host'); } return signIn.commands; },
		async executeCommand(...a) { signIn.executed.push(a); },
	},
	env: { async openExternal(u) { signIn.external.push(u); return true; } },
};
const origLoad = Module._load;
// @ts-ignore
Module._load = function (request, parent, isMain) { return request === 'vscode' ? vscodeMock : origLoad.call(this, request, parent, isMain); };

const HOST = require.resolve('../../../extensions/levelcode-ai/host.js');
const load = () => { delete require.cache[HOST]; return require(HOST); };

let n = 0;
async function test(name, fn) { await fn(); n++; console.log('  ok - ' + name); }
const enc = (s) => new TextEncoder().encode(s);

(async () => {
	/* ---- the desktop ---- */
	delete globalThis.__LEVELCODE_BROWSER_HOST__;
	let host = load();
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-host-'));
	fs.writeFileSync(path.join(tmp, 'a.txt'), '﻿hello');
	fs.writeFileSync(path.join(tmp, 'bin.dat'), Buffer.from([1, 2, 0, 3]));
	fs.mkdirSync(path.join(tmp, 'dir'));

	await test('desktop: every capability is on', () => {
		assert.deepStrictEqual({ ...host.caps }, { shell: true, mcpStdio: true, ripgrep: true });
		assert.strictEqual(host.isBrowser, false);
	});
	await test('desktop: reads are the fs reads, errors included', async () => {
		assert.strictEqual(await host.readText(path.join(tmp, 'a.txt')), '﻿hello', 'the BOM is the caller\'s to strip, as before');
		assert.deepStrictEqual([...await host.readBytes(path.join(tmp, 'bin.dat'))], [1, 2, 0, 3]);
		await assert.rejects(host.readText(path.join(tmp, 'none')), (e) => e.code === 'ENOENT');
		assert.strictEqual(await host.readTextOrNull(path.join(tmp, 'none')), null);
		assert.strictEqual(await host.exists(path.join(tmp, 'a.txt')), true);
		assert.strictEqual(await host.exists(path.join(tmp, 'none')), false);
		assert.deepStrictEqual(await host.stat(path.join(tmp, 'dir')), { isFile: false, isDirectory: true, size: (await fs.promises.stat(path.join(tmp, 'dir'))).size });
		assert.strictEqual((await host.stat(path.join(tmp, 'a.txt'))).isFile, true);
		assert.strictEqual(await host.stat(path.join(tmp, 'none')), null);
	});
	await test('desktop: binary sniff looks at the first 8000 bytes for a NUL', async () => {
		assert.strictEqual(await host.isBinary(path.join(tmp, 'bin.dat')), true);
		assert.strictEqual(await host.isBinary(path.join(tmp, 'a.txt')), false);
		assert.strictEqual(await host.isBinary(path.join(tmp, 'none')), false, 'unreadable counts as text, as before');
		fs.writeFileSync(path.join(tmp, 'late-nul'), Buffer.concat([Buffer.alloc(8000, 65), Buffer.from([0])]));
		assert.strictEqual(await host.isBinary(path.join(tmp, 'late-nul')), false, 'a NUL after byte 8000 is not looked for');
	});
	await test('desktop: uriFor is Uri.file; withReads runs the loader once against the disk', async () => {
		assert.strictEqual(host.uriFor('/x/y').scheme, 'file');
		let runs = 0;
		const out = await host.withReads((read) => { runs++; return [read(path.join(tmp, 'a.txt')), read(path.join(tmp, 'none'))]; });
		assert.strictEqual(runs, 1);
		assert.deepStrictEqual(out, ['﻿hello', null]);
	});

	await test('desktop: openAuth hands the address to the system browser and runs no command', async () => {
		signIn.commands = ['levelcode.web.openAuthUrl'];   // even if one were registered
		signIn.executed.length = 0; signIn.external.length = 0;
		const uri = new Uri('https', '/ai/login', 'redirect_uri=a&code_challenge=b');
		await host.openAuth(uri);
		assert.deepStrictEqual(signIn.external, [uri]);
		assert.deepStrictEqual(signIn.executed, []);
	});

	/* ---- the browser ---- */
	globalThis.__LEVELCODE_BROWSER_HOST__ = true;
	host = load();
	vscodeMock.workspace.workspaceFolders = [
		{ uri: new Uri('levelcode-scratch', '/'), name: 'scratch' },
		{ uri: new Uri('file', '/my-project'), name: 'my-project' },
	];
	vsFiles.set('/notes.md', enc('# notes'));
	vsFiles.set('/my-project/src/a.js', enc('const a = 1;'));
	vsFiles.set('/blob.bin', new Uint8Array([7, 0, 7]));

	await test('browser: no shell, no local MCP, no ripgrep', () => {
		assert.deepStrictEqual({ ...host.caps }, { shell: false, mcpStdio: false, ripgrep: false });
		assert.strictEqual(host.isBrowser, true);
	});
	await test('browser: a path maps back to the folder that contains it, longest match wins', () => {
		assert.strictEqual(host.uriFor('/notes.md').toString(), 'levelcode-scratch:///notes.md');
		assert.strictEqual(host.uriFor('/my-project/src/a.js').toString(), 'file:///my-project/src/a.js');
		assert.strictEqual(host.uriFor('/my-project').toString(), 'file:///my-project');
		assert.strictEqual(host.uriFor('/my-projectile/x').toString(), 'levelcode-scratch:///my-projectile/x', 'a name that merely starts with a folder\'s is not inside it');
	});
	await test('browser: a path inside no folder is a file URI, which is right for a folder opened from the computer', () => {
		vscodeMock.workspace.workspaceFolders = [{ uri: new Uri('file', '/only'), name: 'only' }];
		assert.strictEqual(host.uriFor('/elsewhere/x').toString(), 'file:///elsewhere/x');
		vscodeMock.workspace.workspaceFolders = [
			{ uri: new Uri('levelcode-scratch', '/'), name: 'scratch' }, { uri: new Uri('file', '/my-project'), name: 'my-project' }];
	});
	await test('browser: reads go through the editor and keep the folder\'s scheme', async () => {
		reads.length = 0;
		assert.strictEqual(await host.readText('/notes.md'), '# notes');
		assert.strictEqual(await host.readText('/my-project/src/a.js'), 'const a = 1;');
		assert.deepStrictEqual(reads, ['levelcode-scratch:///notes.md', 'file:///my-project/src/a.js']);
		assert.strictEqual(await host.readTextOrNull('/missing'), null);
		assert.strictEqual(await host.exists('/notes.md'), true);
		assert.strictEqual(await host.exists('/missing'), false);
		assert.deepStrictEqual(await host.stat('/notes.md'), { isFile: true, isDirectory: false, size: 7 });
		assert.strictEqual((await host.stat('/my-project/src')).isDirectory, true);
		assert.strictEqual(await host.isBinary('/blob.bin'), true);
		assert.strictEqual(await host.isBinary('/notes.md'), false);
	});
	await test('browser: withReads serves a loader that reads files synchronously, including ones it learns of from others', async () => {
		vsFiles.set('/rules/index.json', enc('{"next":"/rules/more.md"}'));
		vsFiles.set('/rules/more.md', enc('MORE'));
		let runs = 0;
		const out = await host.withReads((read) => {
			runs++;
			const idx = read('/rules/index.json');
			const more = idx ? read(JSON.parse(idx).next) : null;
			return { idx: !!idx, more, absent: read('/rules/none.md') };
		});
		assert.deepStrictEqual(out, { idx: true, more: 'MORE', absent: null });
		assert.ok(runs >= 2 && runs <= 4, 'ran ' + runs + ' passes');
	});
	await test('browser: a loader that keeps asking for new paths is stopped, not looped', async () => {
		let i = 0;
		let runs = 0;
		const out = await host.withReads((read) => { runs++; return read('/never/' + (i++)); });
		assert.strictEqual(out, null);
		assert.ok(runs <= 4, 'ran ' + runs + ' passes');
	});
	await test('browser: findFiles is the editor\'s own search', () => {
		assert.deepStrictEqual(host.findFiles('**/*', 'x', 5), ['findFiles', '**/*', 'x', 5]);
	});
	await test('browser: openAuth takes the tab there, with the address the editor\'s own opener would have used', async () => {
		signIn.commands = ['workbench.action.files.save', 'levelcode.web.openAuthUrl']; signIn.getCommandsThrows = false;
		signIn.executed.length = 0; signIn.external.length = 0;
		const uri = new Uri('https', '/ai/login', 'redirect_uri=https://e.example/callback.html?x=1&code_challenge=b');
		await host.openAuth(uri);
		assert.strictEqual(signIn.external.length, 0, 'no pop-up');
		assert.deepStrictEqual(signIn.executed, [['levelcode.web.openAuthUrl', encodeURI(uri.toString(true))]]);
		const sent = signIn.executed[0][1];
		assert.ok(/[?]redirect_uri=https:\/\/e\.example\/callback\.html%253Fx=1&code_challenge=b$/.test(sent), 'a query a server can split: ' + sent);
	});
	await test('browser: without the page\'s command, or when the command list cannot be had, it opens as before', async () => {
		const uri = new Uri('https', '/ai/login', 'a=b');
		signIn.commands = ['workbench.action.files.save']; signIn.executed.length = 0; signIn.external.length = 0;
		await host.openAuth(uri);
		assert.deepStrictEqual(signIn.executed, []);
		assert.deepStrictEqual(signIn.external, [uri]);
		signIn.commands = ['levelcode.web.openAuthUrl']; signIn.getCommandsThrows = true; signIn.external.length = 0;
		await host.openAuth(uri);
		assert.deepStrictEqual(signIn.external, [uri]);
		signIn.getCommandsThrows = false;
	});

	console.log(`\n${n} tests passed`);
})().catch((e) => { console.error(e); process.exit(1); });
