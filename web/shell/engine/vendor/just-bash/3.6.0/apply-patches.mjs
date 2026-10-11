#!/usr/bin/env node
// Applies LevelCode's patches to the unmodified npm file just-bash@3.6.0 dist/bundle/browser.js.
//
//   node apply-patches.mjs [--in browser.js] [--out patched.js]
//   node apply-patches.mjs --check [--in browser.js]      verifies the hash and every anchor, writes nothing
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

/**
 * Prepended once: the notice (Apache-2.0 section 4(b)), two imports of LevelCode's own modules (engine/text.js and
 * engine/zone.js: load.mjs and build.mjs map the names `lc-text` and `lc-zone` to those files), the module's own
 * `Date`, and the helpers the edits call. Every identifier added here starts with `__lc`: nothing in the (mangled)
 * file can collide with one. `Nu` is the file's own function (a sed range's key), a hoisted declaration, so it is there.
 */
export const HEADER = `/*! LevelCode: this is just-bash@3.6.0 dist/bundle/browser.js (Apache-2.0, Copyright 2025 Vercel Inc.) MODIFIED by LevelCode:
 *  patches LC-1 .. LC-18 of web/shell/engine/vendor/just-bash/3.6.0/apply-patches.mjs (Apache-2.0 section 4(b)).
 *  Unmodified input sha256 ${UNPATCHED_SHA256}. */
import __lcText from"lc-text";
import __lcZone from"lc-zone";
const Date=__lcZone.LcDate;
var __lcUtf8=__lcText.decodeByteString;
var __lcOpenError=l=>{let c=l&&l.code;return c==="ENOENT"?"No such file or directory":c==="EACCES"||c==="EPERM"?"Permission denied":c==="EISDIR"?"Is a directory":c==="ENOTDIR"?"Not a directory":c==="EROFS"?"Read-only file system":c==="ENOSPC"?"No space left on device":"cannot open redirect target"};
var __lcCmp=(a,b)=>{if(a===b)return 0;let n=a.length<b.length?a.length:b.length,i=0;for(;i<n&&a.charCodeAt(i)===b.charCodeAt(i);)i++;if(i===n)return a.length<b.length?-1:a.length>b.length?1:0;let x=a.charCodeAt(i),y=b.charCodeAt(i);x>=55296&&y>=55296&&(x+=x>=57344?-2048:8192,y+=y>=57344?-2048:8192);return x<y?-1:1};
var __lcMode=s=>{let m=typeof s.mode=="number"?s.mode:s.isDirectory?493:420,r=s.isDirectory?"d":"-";for(let i=8;i>=0;i--)r+=m>>i&1?"rwxrwxrwx"[8-i]:"-";return r};
var __lcRangeOpen=(a,l,n,st)=>{if(!a||a.negated||a.start===void 0||a.end===void 0)return!1;let o=a.start,e=a.end;if(typeof o=="object"||typeof e=="object"){let p=st.get(Nu(a));return!!(p&&p.active)}let d=typeof o=="number"?o:o==="$"?n:1,q=typeof e=="number"?e:n;return d<=q&&l<q};
var __lcBuiltinNames=new Set(["alias","echo","history","printf","pwd","unalias"]);
var __lcNoBuiltin=new Set(["bg","caller","disown","enable","fc","fg","jobs","kill","suspend","times","trap","ulimit","umask"]);
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
		title: 'every string comparison that orders output is by code point (UTF-8 byte order, which is what LANG=C.UTF-8 in the shell\'s environment says): `sort`, `sort -V`, the order a walk visits a directory (find, du, grep -r, rg), glob results, `tree`, `$SHELLOPTS` and jq\'s sort, sort_by, group_by, min, max, unique and object keys; all of them used the browser\'s locale collation (localeCompare), so the order of "B a A _x 1" depended on the visitor\'s language; and jq\'s unique and group_by, which have to be sorted by their key and were not sorted at all',
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

			{
				name: 'sort -V: the parts of a version that are not numbers',
				from: 'else if(o!==l)return o.localeCompare(l)}return 0}functio',
				to: 'else if(o!==l)return __lcCmp(o,l)}return 0}functio',
			},
			{
				name: 'the walk every recursive program uses (find, du, grep -r, rg, tree): the order of a directory\'s entries',
				from: 't(),u.sort((f,d)=>f.localeCompare(d));for(let f=u.len',
				to: 't(),u.sort((f,d)=>__lcCmp(f,d));for(let f=u.len',
			},
			{
				name: 'the glob helper: the order of what a pattern matched',
				from: '.sort((a,c)=>a.path.localeCompare(c.path))}async func',
				to: '.sort((a,c)=>__lcCmp(a.path,c.path))}async func',
			},
			{
				name: 'tree: the order of a directory\'s entries (with -a)',
				from: '.sort((c,u)=>c.name.localeCompare(u.name));for(let c=',
				to: '.sort((c,u)=>__lcCmp(c.name,u.name));for(let c=',
			},
			{
				name: 'tree: the order of a directory\'s entries',
				from: '.sort((a,c)=>a.name.localeCompare(c.name));for(let a=',
				to: '.sort((a,c)=>__lcCmp(a.name,c.name));for(let a=',
			},
			{
				name: 'jq: string order of a plain comparison',
				from: 'ypeof t=="string"?e.localeCompare(t):0}function Jg(e,',
				to: 'ypeof t=="string"?__lcCmp(e,t):0}function Jg(e,',
			},
			{
				name: 'jq: the comparator behind sort, sort_by, group_by, min, max, unique',
				from: '=="string")return e.localeCompare(t);if(typeof e=="bo',
				to: '=="string")return __lcCmp(e,t);if(typeof e=="bo',
			},
			{
				name: 'jq: the order of the keys of two objects',
				from: 'th);c++){let u=l[c].localeCompare(a[c]);if(u!==0)retu',
				to: 'th);c++){let u=__lcCmp(l[c],a[c]);if(u!==0)retu',
			},
			{
			name: '$SHELLOPTS: the order of the option names',
			from: '.sort((r,s)=>r.name.localeCompare(s.name));for(let r ',
			to: '.sort((r,s)=>__lcCmp(r.name,s.name));for(let r ',
			},
			{
			name: 'jq unique: the result is sorted (it kept the order of first appearance)',
			from: 'let i=new Set,o=[];for(let l of e){let a=JSON.stringify(l);i.has(a)||(i.add(a),o.push(l))}return[o]}return[null];case"tojson"',
			to: 'let i=new Set,u=[];for(let l of e){let a=JSON.stringify(l);i.has(a)||(i.add(a),u.push(l))}return[u.sort(Ga)]}return[null];case"tojson"',
			},
			{
			name: 'jq group_by: the groups are sorted by their key (they were in the order of first appearance)',
			from: 'u.has(d)||u.set(d,[]),u.get(d)?.push(f)}return[[...u.values()]]}case"max"',
			to: 'u.has(d)||u.set(d,[]),u.get(d)?.push(f)}return[[...u.entries()].sort((p,h)=>o(p[0]===void 0?null:JSON.parse(p[0]),h[0]===void 0?null:JSON.parse(h[0]))).map(p=>p[1])]}case"max"',
			},
		],
	},
	{
		id: 'LC-10',
		title: 'text and bytes: a byte that is not valid UTF-8 is kept (decoded to U+DC80..U+DCFF, encoded back to the byte) wherever the engine turns the BYTES of a file or a pipe into text and text back into bytes, and a BOM is kept; the engine left the whole string as latin-1 characters (which came out as UTF-8 of those characters), so `sort -o`, `$(cat f)` and a pipe through grep or awk changed bytes they were not asked to change. A result that is TEXT (it has characters of U+0080..U+00FF in it) is not touched: that is why the decoder of the final result is not patched',
		edits: [
			{
				name: 'the decoder of byte strings keeps a BOM',
				from: 'M8=new TextDecoder("utf-8",{fatal:!0}),_8=new TextEncoder,',
				to: 'M8=new TextDecoder("utf-8",{fatal:!0,ignoreBOM:!0}),_8=new TextEncoder,',
			},
			{
				name: 'a byte string that is not UTF-8 is decoded with its bad bytes escaped (not left as latin-1)',
				from: 'try{return M8.decode(s)}catch{return n}}function Pn(e,t=_c){',
				to: 'try{return M8.decode(s)}catch{return __lcText.decodeBytes(s)}}function Pn(e,t=_c){',
			},
			{
				name: 'text to a byte string: an escaped byte goes back to the byte',
				from: 'let n=_8.encode(e),r="";for(let s=0;s<n.length;s++)r+=String.fromCharCode(n[s]);return r}function B8(',
				to: 'let n=__lcText.encodeText(e),r="";for(let s=0;s<n.length;s++)r+=String.fromCharCode(n[s]);return r}function B8(',
			},
			{
				name: 'the decoder of a command\'s result keeps a BOM',
				from: 'var h$=new TextDecoder("utf-8",{fatal:!0});function x8(',
				to: 'var h$=new TextDecoder("utf-8",{fatal:!0,ignoreBOM:!0});function x8(',
			},
		],
	},
	{
		id: 'LC-11',
		title: 'sed: `a\\`, `i\\` and `c\\` with no text after the backslash (the end of the script) have empty text and print nothing, as in GNU: `$a\\` is the idiom that adds a missing final newline; the engine printed a line holding one backslash',
		edits: [
			{
				name: 'the text commands: a backslash that ends the script is not text',
				from: 'readTextCommand(t,n,r){for(;this.peek()===" "||this.peek()==="\t";)this.advance();this.peek()==="\\\\"&&this.pos+1<this.input.length&&(',
				to: 'readTextCommand(t,n,r){for(;this.peek()===" "||this.peek()==="\t";)this.advance();this.peek()==="\\\\"&&this.pos+1===this.input.length&&this.advance();this.peek()==="\\\\"&&this.pos+1<this.input.length&&(',
			},
			{
				name: 'text inserted before the line: empty text prints no line',
				from: 'for(let D of B)y(`${D}\n`);let L=!1;',
				to: 'for(let D of B)D!==""&&y(`${D}\n`);let L=!1;',
			},
			{
				name: 'text that replaces the line, and text appended after it: empty text prints no line',
				from: '$.changedText!==void 0&&(y(`${$.changedText}\n`),L=!0);for(let D of U)y(`${D}\n`);',
				to: '$.changedText!==void 0&&$.changedText!==""&&(y(`${$.changedText}\n`),L=!0);for(let D of U)D!==""&&y(`${D}\n`);',
			},
		],
	},
	{
		id: 'LC-12',
		title: 'sed: `c` on a range of lines prints its text once, at the end of the range, as in GNU (it printed it for every line); on a single line, with `!`, and inside `{}` it is unchanged',
		edits: [
			{
				name: 'change: the text is set only when the range this command matched is not still open',
				from: 'case"change":t.deleted=!0,t.changedText=e.text;break;',
				to: 'case"change":t.deleted=!0,__lcRangeOpen(e.address,r,s,t.rangeStates)||(t.changedText=e.text);break;',
			},
		],
	},
	{
		id: 'LC-13',
		title: 'awk: a bare `length` (no parentheses) is length($0), as in every awk (`awk \'{print length}\'`, `awk \'length > 5\'`); it was an empty variable',
		edits: [
			{
				name: 'a name that is not followed by ( or [ : `length` is a call with no arguments',
				from: 'return{type:"variable",name:t}}throw new Error(`Unexpected token: ${this.current().type} at line',
				to: 'return t==="length"?{type:"call",name:t,args:[]}:{type:"variable",name:t}}throw new Error(`Unexpected token: ${this.current().type} at line',
			},
		],
	},
	{
		id: 'LC-14',
		title: 'grep -o (and -c with -o) with a pattern that can match nothing (`[0-9]*`, `a*`): an empty match is skipped, not printed, the next position is looked at (it was skipped), and the end of a line no longer fails with "start index out of bounds" (shown as "No such file or directory" for a file that is there)',
		edits: [
			{
				name: 'the regex adapter: a search that starts past the end of the text finds nothing (as RegExp.exec does)',
				from: 'exec(t){let n=this.acquireMatcher(t),r=this._global?this._lastIndex:0;if(!n.find(r))',
				to: 'exec(t){let n=this.acquireMatcher(t),r=this._global?this._lastIndex:0;if(r>t.length)return this._global&&(this._lastIndex=0),null;if(!n.find(r))',
			},
			{
				name: 'the only-matching loop of the plain case: the adapter has stepped over an empty match already, and an empty match prints nothing',
				from: 'N(D,re+ie),pe[0].length===0&&t.lastIndex++}else if(h)for(',
				to: 'pe[0].length>0&&N(D,re+ie),pe[0].length===0&&t.lastIndex<=pe.index&&t.lastIndex++}else if(h)for(',
			},
			{
				name: 'the vimgrep loop: the same step',
				from: 'N(D,De+Se),pe[0].length===0&&t.lastIndex++}else{let pe=Oe?',
				to: 'N(D,De+Se),pe[0].length===0&&t.lastIndex<=pe.index&&t.lastIndex++}else{let pe=Oe?',
			},
			{
				name: 'the only-matching loop with context lines',
				from: 'N(O,Ae+Oe),ee[0].length===0&&t.lastIndex++}}else{let ee=Y;',
				to: 'ee[0].length>0&&N(O,Ae+Oe),ee[0].length===0&&t.lastIndex<=ee.index&&t.lastIndex++}}else{let ee=Y;',
			},
			{
				name: 'counting matches: an empty match is not one',
				from: 'R(),D++,Se[0].length===0&&t.lastIndex++;else t.test(ee)!==r&&D++}',
				to: 'R(),Se[0].length>0&&D++,Se[0].length===0&&t.lastIndex<=Se.index&&t.lastIndex++;else t.test(ee)!==r&&D++}',
			},
		],
	},
	{
		id: 'LC-15',
		title: 'cut -f: a line that has no delimiter is printed whole (unless -s), as in GNU; the engine printed an empty line when the field asked for was not 1',
		edits: [
			{
				name: 'the field loop: a line without the delimiter',
				from: '{if(i&&!h.includes(n))continue;let m=h.split(n);for(let b of u)',
				to: '{if(!h.includes(n)){if(i)continue;f.append(`${h}\n`);continue}let m=h.split(n);for(let b of u)',
			},
		],
	},
	{
		id: 'LC-16',
		title: 'time: every `Date` of the engine is LcDate (engine/zone.js), whose local time is the zone of the command\'s TZ and UTC when there is none; local time was the visitor\'s zone, so `date -u -d`, `touch -d`, `ls -l` and `stat` gave a different answer to every visitor. The zone is set from the command\'s own TZ before it runs',
		edits: [
			{
				name: 'command execution: the zone of this command is its TZ',
				from: '()=>u.execute(n,w))',
				to: '()=>(__lcZone.setZone(m.env?.get?.("TZ")),u.execute(n,w)))',
			},
		],
	},
	{
		id: 'LC-17',
		title: 'echo, printf, pwd, alias, unalias and history are shell builtins in bash and work with any PATH; they are programs in /usr/bin here, so `PATH=/x; echo a` was "command not found"',
		edits: [
			{
				name: 'program lookup: a name that is a builtin in bash is looked for in the shell\'s own bin directories when PATH has nothing',
				from: 'c=await B3(i,t,s?"/usr/bin:/bin":void 0);',
				to: 'c=await B3(i,t,s?"/usr/bin:/bin":void 0);c||(c=__lcBuiltinNames.has(t)?await B3(i,t,"/usr/bin:/bin"):c);',
			},
		],
	},
	{
		id: 'LC-18',
		title: '`help`, `command -v`, `type` and `builtin` list thirteen builtins the engine declares and does not implement (trap, umask, kill, jobs ...) as if they were there; running one is "command not found"',
		edits: [
			{
				name: 'the set of builtin names (command -v, type, builtin)',
				from: '"type","hash","ulimit","umask","trap","times","wait","kill","jobs","fg","bg","disown","suspend","fc","history","help","enable","builtin","caller"]',
				to: '"type","hash","wait","history","help","builtin"]',
			},
			{
				name: 'the topics of help',
				from: 'I3=[...N3.keys()].sort()',
				to: 'I3=[...N3.keys()].filter(k=>!__lcNoBuiltin.has(k)).sort()',
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

/**
 * The anchors of a text, without applying them: how many times each occurs. Used by `--check` and the tests.
 * @param {string} text
 * @returns {Array<{ id: string, name: string, count: number }>}
 */
export function checkAnchors(text) {
	const out = [];
	for (const patch of PATCHES) {
		for (const edit of patch.edits) { out.push({ id: patch.id, name: edit.name, count: occurrences(text, edit.from).length }); }
	}
	return out;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
	const args = process.argv.slice(2);
	const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
	try {
		const input = fs.readFileSync(opt('--in', path.join(HERE, 'browser.js')), 'utf8');
		if (args.includes('--check')) {
			const hash = sha256(input);
			const problems = [];
			if (hash !== UNPATCHED_SHA256) { problems.push(`sha256 is ${hash}, expected ${UNPATCHED_SHA256}`); }
			for (const a of checkAnchors(input)) {
				if (a.count !== 1) { problems.push(`${a.id} anchor "${a.name}" occurs ${a.count} times (expected exactly 1)`); }
			}
			if (problems.length) {
				process.stderr.write(problems.join('\n') + '\n');
				process.exit(1);
			}
			const edits = PATCHES.reduce((n, p) => n + p.edits.length, 0);
			process.stdout.write(JSON.stringify({ check: 'ok', patches: PATCHES.length, edits, sha256: hash }) + '\n');
		} else {
			const r = applyPatches(input);
			const out = opt('--out', null);
			if (out) { fs.writeFileSync(out, r.text); }
			process.stdout.write(JSON.stringify({ patches: r.patches.length, edits: r.patches.reduce((n, p) => n + p.edits, 0), bytes: r.text.length, sha256: r.sha256, out: out || null }) + '\n');
		}
	} catch (e) {
		process.stderr.write(String(e && e.message || e) + '\n');
		process.exit(1);
	}
}
