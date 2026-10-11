#!/usr/bin/env node
// Applies LevelCode's patches to the unmodified npm file just-bash@3.6.0 dist/bundle/browser.js.
//
//   node apply-patches.mjs [--in browser.js] [--out patched.js] [--check]
//
// The file is minified and ships without sources, so every patch is an ANCHOR edit. Two rules make a version bump
// loud instead of silent: the input must hash to UNPATCHED_SHA256, and every anchor must occur EXACTLY ONCE in the
// original text. Nothing here reads the network or the clock; the output is a pure function of the input.
//
// Modified by LevelCode (Apache-2.0 section 4(b)): the patched file starts with a notice that says so.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** just-bash@3.6.0 dist/bundle/browser.js, as published (npm integrity sha512-2COjEgcH...RQ6xw==). */
export const UNPATCHED_SHA256 = '38f1ad1e3283980ecdf68cede8a4eed028c6dff6e8c31793dec1e0af529c446e';

/** Prepended once. `__lcUtf8` is the only identifier it adds: nothing in the (mangled) file can collide with it. */
/** The notice and helpers that go in front of the file. */
export const HEADER = `/*! LevelCode: this is just-bash@3.6.0 dist/bundle/browser.js (Apache-2.0, Copyright 2025 Vercel Inc.) MODIFIED by LevelCode:
 *  patches LC-1 .. LC-9 of web/shell/engine/vendor/just-bash/3.6.0/apply-patches.mjs (Apache-2.0 section 4(b)).
 *  Unmodified input sha256 ${UNPATCHED_SHA256}. */
var __lcUtf8=(()=>{let d=new TextDecoder("utf-8",{fatal:!0});return s=>{if(!s)return s;let h=!1;for(let i=0;i<s.length;i++){let c=s.charCodeAt(i);if(c>255)return s;c>127&&(h=!0)}if(!h)return s;let b=new Uint8Array(s.length);for(let i=0;i<s.length;i++)b[i]=s.charCodeAt(i);try{return d.decode(b)}catch{return s}}})();
var __lcOpenError=l=>{let c=l&&l.code;return c==="ENOENT"?"No such file or directory":c==="EACCES"||c==="EPERM"?"Permission denied":c==="EISDIR"?"Is a directory":c==="ENOTDIR"?"Not a directory":c==="EROFS"?"Read-only file system":c==="ENOSPC"?"No space left on device":"cannot open redirect target"};
var __lcCmp=(a,b)=>a<b?-1:a>b?1:0;
var __lcMode=s=>{let m=typeof s.mode=="number"?s.mode:s.isDirectory?493:420,r=s.isDirectory?"d":"-";for(let i=8;i>=0;i--)r+=m>>i&1?"rwxrwxrwx"[8-i]:"-";return r};
`;

/**
 * @typedef {{ name: string, from: string, to: string }} Edit
 * @typedef {{ id: string, title: string, edits: Edit[] }} Patch
 */

/** @type {Patch[]} */
export const PATCHES = [
	{
		id: 'LC-1',
		title: 'statement hook: ExecOptions.onStatement(result) is awaited after each TOP-LEVEL statement (live output, and what ran before a deadline survives)',
		edits: [
			{
				name: 'execInScope hands the caller\'s onStatement to the depth-0 script only (not to $(...), bash -c, source)',
				from: 'R=await new ia(E,m).executeScript(x);return S&&(R.metadata=S),a(R)',
				to: 'R=await new ia(E,m).executeScript(x,s===0?n?.onStatement:void 0);return S&&(R.metadata=S),a(R)',
			},
			{
				name: 'executeScript awaits the hook after the statement\'s result is appended',
				from: 'async executeScript(t){this.assertDefenseContext("execution");let n=0,r=new gn(this.ctx.executionScope,"script");for(let s of t.statements)try{let i=await this.executeStatement(s);r.appendResult(i,Uc(i)),n=i.exitCode',
				to: 'async executeScript(t,h){this.assertDefenseContext("execution");let n=0,r=new gn(this.ctx.executionScope,"script");for(let s of t.statements)try{let i=await this.executeStatement(s);r.appendResult(i,Uc(i)),h&&await h(i),n=i.exitCode',
			},
			{
				name: 'a statement that failed in expansion (arithmetic, bad substitution) is shown at its place, not at the end',
				from: 'if(i instanceof Ve){r.append("stdout",i.stdout,i.internalOutputAccounting.stdout),r.append("stderr",i.stderr,i.internalOutputAccounting.stderr),n=1,',
				to: 'if(i instanceof Ve){r.append("stdout",i.stdout,i.internalOutputAccounting.stdout),r.append("stderr",i.stderr,i.internalOutputAccounting.stderr),h&&await h({stdout:i.stdout,stderr:i.stderr,exitCode:1}),n=1,',
			},
			{
				name: 'the same for the other error class that lets the script go on with the next statement',
				from: 'if(i instanceof si){r.append("stdout",i.stdout,i.internalOutputAccounting.stdout),r.append("stderr",i.stderr,i.internalOutputAccounting.stderr),n=1,',
				to: 'if(i instanceof si){r.append("stdout",i.stdout,i.internalOutputAccounting.stdout),r.append("stderr",i.stderr,i.internalOutputAccounting.stderr),h&&await h({stdout:i.stdout,stderr:i.stderr,exitCode:1}),n=1,',
			},
		],
	},
	{
		id: 'LC-2',
		title: 'glob: a pattern that ends in "/" matches directories only, and keeps the slash (`echo */`, `for d in */`)',
		edits: [
			{
				name: 'expandSimple filters the expansion of a trailing-slash pattern',
				from: 'let l=r.slice(s);return(await this.expandSegments(i,o,l)).sort()}',
				to: 'let l=r.slice(s),R=(await this.expandSegments(i,o,l)).sort();if(t.length>1&&t.endsWith("/")){let Q=[];for(let p of R){try{if((await this.fs.stat(p.startsWith("/")?p:this.fs.resolvePath(this.cwd,p))).isDirectory)Q.push(p+"/")}catch{}}R=Q}return R}',
			},
		],
	},
	{
		id: 'LC-3',
		title: 'arithmetic: a `$` that is followed by a character that cannot start a name spun the ArithConcat loop forever, growing an array (echo $(( $ )), (( x = $ )))',
		edits: [
			{
				name: 'the concat loop stops when the parser did not advance',
				from: 'for(;DN(t,s);){let{expr:l,pos:a}=q7(e,t,s,!0);i.push(l),s=a}',
				to: 'for(;DN(t,s);){let{expr:l,pos:a}=q7(e,t,s,!0);if(a<=s)break;i.push(l),s=a}',
			},
		],
	},
	{
		id: 'LC-4',
		title: '`read` and `mapfile` assign what they read as UTF-8 text (they assigned one char per BYTE: a non-ASCII line written back was double-encoded)',
		edits: [
			{
				name: 'read: after the trailing delimiter is removed, before the line is split',
				from: 'x===`\n`&&S.endsWith(`\n`)&&(S=S.slice(0,-1));',
				to: 'x===`\n`&&S.endsWith(`\n`)&&(S=S.slice(0,-1));S=__lcUtf8(S);',
			},
			{
				name: 'mapfile / readarray: each element as it is pushed',
				from: 'string length limit exceeded (${e.limits.maxStringLength} bytes)`,"string_length");f.push(y)};for(;d<u.length;)',
				to: 'string length limit exceeded (${e.limits.maxStringLength} bytes)`,"string_length");f.push(__lcUtf8(y))};for(;d<u.length;)',
			},
		],
	},
	{
		id: 'LC-5',
		title: 'redirection: a write that cannot OPEN the target (no such folder, no permission, a directory) is `bash: f: <reason>` with status 1 and the command is not run, for every redirection form; it used to reject the whole exec() and lose all output',
		edits: [
			{
				name: 'the opening write of a redirection no longer rethrows',
				from: 'catch(l){if(!s)throw l;return{error:X("",`bash: ${t}: cannot open redirect target',
				to: 'catch(l){return{error:X("",`bash: ${t}: ${__lcOpenError(l)}',
			},
		],
	},
	{
		id: 'LC-6',
		title: 'the result of exec() keeps the raw (byte-shaped) stdout/stderr as `lcRaw`: what a statement hook did not see can be told from what it did, exactly',
		edits: [
			{
				name: 'logResult stores the bytes before it decodes them',
				from: 't.stdout=x8(t.stdout),t.stderr=x8(t.stderr),t}async exec(t,n){',
				to: 't.lcRaw={stdout:t.stdout,stderr:t.stderr},t.stdout=x8(t.stdout),t.stderr=x8(t.stderr),t}async exec(t,n){',
			},
		],
	},
	{
		id: 'LC-7',
		title: 'a program the engine knows it does not have (tar, yq, xan, python3, sqlite3) answers "command not found" like any other missing program, not "use the Node.js bundle"',
		edits: [
			{
				name: 'the not-found branch of command resolution',
				from: 'if(!c)return V4(t)?K(`bash: ${t}: command not available in browser environments. Exclude \'${t}\' from your commands or use the Node.js bundle.\n`,127):K(`bash: ${t}: command not found\n`,127);',
				to: 'if(!c)return K(`bash: ${t}: command not found\n`,127);',
			},
		],
	},
	{
		id: 'LC-8',
		title: '`ls -l` shows the mode the file system reports (it printed -rw-r--r-- and drwxr-xr-x whatever the mode was, so `chmod +x f; ls -l f` looked as if chmod did nothing)',
		edits: [
			{
				name: 'ls -l of a file operand',
				from: '{stdout:`-rw-r--r-- 1 user user ${$} ${_} ${e}${R}',
				to: '{stdout:`${__lcMode(y)} 1 user user ${$} ${_} ${e}${R}',
			},
			{
				name: 'ls -l of the entries of a directory',
				from: 'W=L.isDirectory?"drwxr-xr-x":"-rw-r--r--"',
				to: 'W=__lcMode(L)',
			},
			{
				name: 'ls -ld of a directory operand',
				from: 'I=A.isDirectory?"drwxr-xr-x":"-rw-r--r--"',
				to: 'I=__lcMode(A)',
			},
		],
	},
	{
		id: 'LC-9',
		title: '`sort` compares as the C locale does (byte order, which is what LANG=C.UTF-8 in the shell\'s environment says); it used the browser\'s locale collation, so the order of "B a A _x 1" depended on the visitor\'s language',
		edits: [
			{
				name: 'the comparison of two lines (no key, no flags)',
				from: 'return i-o}return r.localeCompare(s)}function k0(e){',
				to: 'return i-o}return __lcCmp(r,s)}function k0(e){',
			},
			{
				name: 'the last-resort comparison of whole lines when the sort has no keys',
				from: 'if(!f){let y=d.localeCompare(p);return i?-y:y}return 0}for(let g of t)',
				to: 'if(!f){let y=__lcCmp(d,p);return i?-y:y}return 0}for(let g of t)',
			},
			{
				name: 'the last-resort comparison of whole lines after the keys',
				from: 'if(!f){let g=d.localeCompare(p);return i?-g:g}return 0}}function N0(e,t){',
				to: 'if(!f){let g=__lcCmp(d,p);return i?-g:g}return 0}}function N0(e,t){',
			},
		],
	},
];

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function occurrences(text, needle) {
	const at = [];
	for (let i = text.indexOf(needle); i !== -1; i = text.indexOf(needle, i + needle.length)) { at.push(i); }
	return at;
}

/**
 * Applies edits to a text: each anchor must occur exactly once in the ORIGINAL text, and no two may overlap.
 * Positions are taken from that one pass, so an edit's replacement can neither create a second match for another
 * anchor nor be rewritten by it, and String.replace's `$` patterns never apply.
 *
 * @param {string} text
 * @param {Patch[]} patches
 * @returns {string}
 * @throws {Error} naming the patch and anchor that is not there exactly once
 */
export function applyEdits(text, patches) {
	/** @type {Array<{ at: number, len: number, to: string }>} */
	const sites = [];
	for (const patch of patches) {
		for (const edit of patch.edits) {
			const found = occurrences(text, edit.from);
			if (found.length !== 1) {
				throw new Error(`${patch.id} anchor "${edit.name}" occurs ${found.length} times (expected exactly 1)`);
			}
			sites.push({ at: found[0], len: edit.from.length, to: edit.to });
		}
	}
	sites.sort((a, b) => a.at - b.at);
	let out = '';
	let pos = 0;
	for (const s of sites) {
		if (s.at < pos) { throw new Error('two patch anchors overlap'); }
		out += text.slice(pos, s.at) + s.to;
		pos = s.at + s.len;
	}
	return out + text.slice(pos);
}

/**
 * @param {string} text the contents of the unmodified browser.js
 * @returns {{ text: string, sha256: string, inputSha256: string, patches: Array<{ id: string, title: string, edits: number }> }}
 * @throws {Error} when the input is not the file this set was written for, or an anchor is not there exactly once
 */
export function applyPatches(text) {
	const inputSha256 = sha256(text);
	if (inputSha256 !== UNPATCHED_SHA256) {
		throw new Error(`browser.js is not the just-bash 3.6.0 file this patch set was written for (sha256 ${inputSha256}, expected ${UNPATCHED_SHA256})`);
	}
	const out = HEADER + applyEdits(text, PATCHES);
	return {
		text: out,
		sha256: sha256(out),
		inputSha256,
		patches: PATCHES.map((p) => ({ id: p.id, title: p.title, edits: p.edits.length })),
	};
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
	const args = process.argv.slice(2);
	const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
	try {
		const r = applyPatches(fs.readFileSync(opt('--in', path.join(HERE, 'browser.js')), 'utf8'));
		const out = opt('--out', null);
		if (out) { fs.writeFileSync(out, r.text); }
		process.stdout.write(JSON.stringify({ patches: r.patches.length, edits: r.patches.reduce((n, p) => n + p.edits, 0), bytes: r.text.length, sha256: r.sha256, out: out || null }) + '\n');
	} catch (e) {
		process.stderr.write(String(e && e.message || e) + '\n');
		process.exit(1);
	}
}
