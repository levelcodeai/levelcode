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
 *  patches LC-1 .. LC-31 of web/shell/engine/vendor/just-bash/3.6.0/apply-patches.mjs (Apache-2.0 section 4(b)).
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
var __lcWordB=e=>{if(!e.includes("\\\\<")&&!e.includes("\\\\>"))return e;let t="",n=!1;for(let r=0;r<e.length;r++){let s=e[r];if(s==="\\\\"&&r+1<e.length){let i=e[++r];t+=!n&&(i==="<"||i===">")?"\\\\b":s+i;continue}if(n)s==="]"&&(n=!1);else if(s==="["){n=!0,t+=s,e[r+1]==="^"&&(t+="^",r++),e[r+1]==="]"&&(t+="]",r++);continue}t+=s}return t};
var __lcQuant=e=>{if(!/[*+?}][*+?{]/.test(e))return e;let o="",at=-1,q=!1,st=[],i=0;for(;i<e.length;){let c=e[i];if(c==="\\\\"){o+=c+(e[i+1]===void 0?"":e[i+1]),at=o.length-(e[i+1]===void 0?1:2),q=!1,i+=2;continue}if(c==="["){let j=i+1;for(e[j]==="^"&&j++,e[j]==="]"&&j++;j<e.length&&e[j]!=="]";){if(e[j]==="["&&(e[j+1]===":"||e[j+1]==="."||e[j+1]==="=")){let k=e.indexOf(e[j+1]+"]",j+2);j=k<0?e.length:k+2}else e[j]==="\\\\"?j+=2:j++}let w=e.slice(i,j+1);at=o.length,o+=w,q=!1,i=j+1;continue}if(c==="("){if(st.push(o.length),o+=c,i++,e[i]==="?"){for(;i<e.length&&e[i]!==":"&&e[i]!==")"&&e[i]!==">";)o+=e[i++];i<e.length&&(o+=e[i++])}at=-1,q=!1;continue}if(c===")"){o+=c,at=st.length?st.pop():-1,q=!1,i++;continue}if(c==="|"||c==="^"||c==="$"){o+=c,at=-1,q=!1,i++;continue}let m=c==="{"?/^\\{\\d+(?:,\\d*)?\\}/.exec(e.slice(i)):null;if(c==="*"||c==="+"||c==="?"||m){let t=m?m[0]:c;at>=0&&q&&(o=o.slice(0,at)+"(?:"+o.slice(at)+")"),o+=t,at>=0&&(q=!0),i+=t.length;continue}at=o.length,o+=c,q=!1,i++}return o};
var __lcRe=e=>__lcQuant(__lcWordB(e));
var __lcKey=(e,t,n,g)=>{let l=e.length,a=n===null?null:n[0],b=c=>c===" "||c==="\\t",f=(p,k)=>{if(a!==null){for(;p<l&&k--;){for(;p<l&&e[p]!==a;)p++;p<l&&p++}}else{for(;p<l&&k--;){for(;p<l&&b(e[p]);)p++;for(;p<l&&!b(e[p]);)p++}}return p},sb=t.ignoreLeading||g,eb=t.ignoreLeadingEnd||g,s=f(0,t.startField-1);if(sb)for(;s<l&&b(e[s]);)s++;if(s=Math.min(l,s+(t.startChar===void 0?0:t.startChar-1)),t.endField===void 0)return e.slice(s);let w=t.endField-1,c=t.endChar===void 0?0:t.endChar,p=0;if(c===0&&w++,a!==null){for(;p<l&&w--;){for(;p<l&&e[p]!==a;)p++;p<l&&(w||c)&&p++}}else{for(;p<l&&w--;){for(;p<l&&b(e[p]);)p++;for(;p<l&&!b(e[p]);)p++}}if(c!==0){if(eb)for(;p<l&&b(e[p]);)p++;p=Math.min(l,p+c)}return e.slice(s,Math.max(s,p))};
var __lcKeySpec=e=>{let t={},p=e.split(","),fl=(f,end)=>{f.includes("n")&&(t.numeric=!0),f.includes("r")&&(t.reverse=!0),f.includes("f")&&(t.ignoreCase=!0),f.includes("b")&&(t[end?"ignoreLeadingEnd":"ignoreLeading"]=!0),f.includes("h")&&(t.humanNumeric=!0),f.includes("V")&&(t.versionSort=!0),f.includes("d")&&(t.dictionaryOrder=!0),f.includes("M")&&(t.monthSort=!0)},pos=s=>{let m=/^(\\d*)(?:\\.(\\d*))?([A-Za-z]*)$/.exec(s);return m?{f:m[1]===""?NaN:parseInt(m[1],10),c:m[2]?parseInt(m[2],10):void 0,o:m[3]}:null},a=pos(p[0]);if(p.length>2||!a||!(a.f>=1))return null;if(t.startField=a.f,a.c>=1&&(t.startChar=a.c),fl(a.o,!1),p.length>1&&p[1]!==""){let b=pos(p[1]);if(!b)return null;b.f>=1&&(t.endField=b.f,b.c>=1&&(t.endChar=b.c)),fl(b.o,!0)}return t};
var __lcBytes=a=>__lcText.decodeBytes(Uint8Array.from(a));
var __lcByte=v=>{v&=255;return v<128?String.fromCharCode(v):String.fromCharCode(56320+v)};
var __lcHeal=s=>__lcText.joinEscapes(s);
var __lcErrno=l=>{let c=l&&l.code;return c==="ENOENT"?"No such file or directory":c==="EACCES"||c==="EPERM"?"Permission denied":c==="EISDIR"?"Is a directory":c==="ENOTDIR"?"Not a directory":c==="EROFS"?"Read-only file system":c==="ENOSPC"?"No space left on device":null};
var __lcInherit=(h,e)=>{let q={...h};delete q.PWD;delete q.OLDPWD;return{...q,...e}};
var __lcIso=(p,u,a,d)=>{let f=p==="date"?"%Y-%m-%d":p==="hours"?"%Y-%m-%dT%H":p==="minutes"?"%Y-%m-%dT%H:%M":p==="ns"?"%Y-%m-%dT%H:%M:%S,000000000":"%Y-%m-%dT%H:%M:%S",s=As(f,u,a,d);if(p==="date")return s;let z=As("%z",u,a,d);return s+z.slice(0,3)+":"+z.slice(3)};
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
		title: 'time: every `Date` of the engine is LcDate (engine/zone.js), whose local time is the zone of the command\'s TZ and UTC when there is none; local time was the visitor\'s zone, so `date -u -d`, `touch -d`, `ls -l` and `stat` gave a different answer to every visitor. The zone is set before each command from the TZ it is GIVEN (an exported variable or a prefix assignment, as GNU: `TZ=Asia/Tokyo; date` is not in Tokyo)',
		edits: [
			{
				name: 'command execution: the zone of this command is the TZ in its environment (exported, or a prefix assignment)',
				from: '()=>u.execute(n,w))',
				to: '()=>(__lcZone.setZone(m.exportedEnv?.TZ),u.execute(n,w)))',
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
	{
		id: 'LC-19',
		title: 'strftime (printf \'%(fmt)T\', and what date shares with it): the zone of a time the script gave no TZ for is the command\'s own (UTC), never the process\'s: `printf \'%(%F %T %Z)T\' 1600000000` printed the visitor\'s clock; and %Z is the abbreviation GNU prints (JST, EDT, CEST, +04) where Intl said GMT+9',
		edits: [
			{
				name: 'the wall clock of strftime: the command\'s zone when no TZ was handed over',
				from: 'weekday:"short",hour12:!1,timeZone:t};try{let s=new Intl.DateTimeFormat("en-US",n)',
				to: 'weekday:"short",hour12:!1,timeZone:t||__lcZone.getZone()};try{let s=new Intl.DateTimeFormat("en-US",n)',
			},
			{
				name: '%Z: the short name from the module\'s table, else tzdata\'s digits',
				from: 'function J8(e,t){try{return new Intl.DateTimeFormat("en-US",{timeZone:t,timeZoneName:"short"}).formatToParts(e).find(i=>i.type==="timeZoneName")?.value??"UTC"}catch{return"UTC"}}',
				to: 'function J8(e,t){return __lcZone.abbreviation(e.getTime(),t)}',
			},
			{
				name: 'printf: no zone of its own, so strftime uses the command\'s (the variable TZ, which may be one that was not exported, is not read)',
				from: 'p=t.env.get("TZ");do{let{result:h',
				to: 'p=void 0;do{let{result:h',
			},
		],
	},
	{
		id: 'LC-20',
		title: 'date: -u applies BEFORE the date string is read (`date -u -d \'2020-02-29 12:00:00\'` with TZ in the environment read the wall clock in TZ and printed it in UTC), the zone is the command\'s own (a TZ that is not exported, or not a zone, is UTC), and -I / --iso-8601[=date|hours|minutes|seconds|ns] print what GNU does (a date, not a full timestamp; the offset with a colon)',
		edits: [
			{
				name: 'the zone: -u first, then what the command has; the string is read in it',
				from: 'let l=t.env.get("TZ");l&&!gC(l)&&(l=void 0);let a=n?"UTC":l??"UTC",c=r!==null?bC(r,l):new Date;',
				to: 'n&&__lcZone.setZone("UTC");let l=__lcZone.getZone();l==="UTC"&&(l=void 0);let a=l??"UTC",c=r!==null?bC(r,l):new Date;',
			},
			{
				name: 'the option: -I and --iso-8601 take date, hours, minutes, seconds, ns',
				from: 'else if(h==="-I"||h==="--iso-8601")i=!0;',
				to: 'else if(h==="-I"||h==="--iso-8601"||/^(?:-I|--iso-8601=)(?:date|hours|minutes|seconds|ns)$/.test(h))i=h.replace(/^(?:-I|--iso-8601=?)/,"")||"date";',
			},
			{
				name: 'the output of -I',
				from: 'i?f=As("%Y-%m-%dT%H:%M:%S%z",u,a,d)',
				to: 'i?f=__lcIso(i===!0?"date":i,u,a,d)',
			},
		],
	},
	{
		id: 'LC-21',
		title: 'the environment of a command that runs commands: what the script exported is inherited by programs that start others through the shell (xargs, timeout, find -exec; they ran their children with the top-level variables only: `export TZ=Asia/Tokyo; timeout 5 date` was UTC, `export FOO=1; xargs sh -c \'echo $FOO\'` empty), and a variable handed to a child (`env TZ=X cmd`, `bash -c`) is exported there, so that the child\'s own children and its `date` see it',
		edits: [
			{
				name: 'the context\'s exec: the exported variables are the child\'s environment (a replaced environment is the caller\'s own)',
				from: 'exec:(S,E)=>i.execFn(S,E,!1),',
				to: 'exec:(S,E)=>i.execFn(S,E?.replaceEnv?E:{...E,env:__lcInherit(h,E?.env)},!1),',
			},
			{
				name: 'the child\'s state: the variables it was given are exported in it',
				from: 'let m={...this.state,env:h,arrays:u.replaceEnv?new Map:qn(this.state.arrays),',
				to: 'let m={...this.state,env:h,exportedVars:new Set([...(u.replaceEnv?[]:this.state.exportedVars||[]),...Object.keys(u.env||{})]),arrays:u.replaceEnv?new Map:qn(this.state.arrays),',
			},
		],
	},
	{
		id: 'LC-22',
		title: 'regular expressions of grep and sed, GNU escapes the translation left as literal characters: in a basic expression `\\+` and `\\?` are quantifiers (`grep -o \'[0-9]\\+\'` printed nothing, `colou\\?r` found no colour), `\\<` and `\\>` are word boundaries (grep and sed, basic and extended; they matched a literal `<`); and `grep -c -o` counts LINES (it counted matches)',
		edits: [
			{
				name: 'grep, basic expression: \\+ and \\? after an atom are quantifiers (at the start, and after \\b \\< \\> \\B, they stay literal, as in GNU)',
				from: 'if(o==="}"){t+="\\\\}",n+=2,r=!1;continue}t+=i+o,n+=2,r=!1;continue}',
				to: 'if(o==="}"){t+="\\\\}",n+=2,r=!1;continue}if((o==="+"||o==="?")&&!r){t+=o,n+=2;continue}t+=i+o,n+=2,r=o==="b"||o==="B"||o==="<"||o===">"||o==="`"||o==="\'";continue}',
			},
			{
				name: 'grep, basic and extended: \\< and \\> outside a bracket expression are word boundaries',
				from: 't.wholeWord&&(n=`\\\\b(?:${n})\\\\b`),t.lineRegexp&&(n=`^(?:${n})$`);let s=',
				to: 't.mode!=="fixed"&&t.mode!=="perl"&&(n=__lcRe(n)),t.wholeWord&&(n=`\\\\b(?:${n})\\\\b`),t.lineRegexp&&(n=`^(?:${n})$`);let s=',
			},
			{
				name: 'sed, basic and extended (the substitution and its addresses): the same word boundaries',
				from: 'function ku(e){let t="",n=!1;for(let r=0;r<e.length;r++)',
				to: 'function ku(e){return __lcRe(__lcKu(e))}function __lcKu(e){let t="",n=!1;for(let r=0;r<e.length;r++)',
			},
			{
				name: 'grep -c -o, standard input: the count is of lines',
				from: 'countOnly:i,filename:"",onlyMatching:h,beforeContext:y',
				to: 'countOnly:i,filename:"",onlyMatching:h&&!i,beforeContext:y',
			},
			{
				name: 'grep -c -o, files: the count is of lines',
				from: 'countOnly:i,filename:Ae?Fe:"",onlyMatching:h,beforeContext:y',
				to: 'countOnly:i,filename:Ae?Fe:"",onlyMatching:h&&!i,beforeContext:y',
			},
		],
	},
	{
		id: 'LC-23',
		title: 'sort: a key without an end (`-k2`) runs to the END OF THE LINE (it was field 2 alone), fields and the characters counted in them are found the way coreutils does (a field takes the blanks before it; with -t every separator counts), and -u keeps the first line of each run of lines that compare equal under the keys and flags (it dropped all but the first line with an equal key of the first key, after a sort that put the whole line last: `sort -u -k2,2`, `sort -nu`, `sort -uf` kept another line than GNU)',
		edits: [
			{
				name: 'the text of a key: coreutils begfield / limfield',
				from: 'function Hu(e,t,n){let r=n!==null?n:/\\s+/,s=e.split(r),i=t.startField-1;',
				to: 'function Hu(e,t,n,g){return __lcKey(e,t,n,g)}function __lcHu(e,t,n){let r=n!==null?n:/\\s+/,s=e.split(r),i=t.startField-1;',
			},
			{
				name: 'the comparator hands -b to the key (it is applied to every key that has no flags of its own)',
				from: 'let b=Hu(h,g,n),y=Hu(m,g,n);g.ignoreLeading',
				to: 'let b=Hu(h,g,n,u),y=Hu(m,g,n,u);g.ignoreLeading',
			},
			{
				name: 'with -u the last-resort comparison of whole lines is off, as with -s',
				from: 'let l=k0(n);if(n.checkOnly)',
				to: 'let l=k0(n.unique?{...n,stable:!0}:n);if(n.checkOnly)',
			},
			{
				name: '-u: of each run of lines that compare equal, the first',
				from: 'o.sort(l),n.unique&&(o=N0(o,n));',
				to: 'o.sort(l),n.unique&&(o=o.filter((x,i)=>i===0||l(o[i-1],x)!==0));',
			},
			{
				name: '-c -u: a line equal to the one before it is out of order',
				from: 'for(let u=1;u<o.length;u++)if(l(o[u-1],o[u])>0)return{',
				to: 'for(let u=1;u<o.length;u++)if(n.unique?l(o[u-1],o[u])>=0:l(o[u-1],o[u])>0)return{',
			},
		],
	},	{
		id: 'LC-24',
		title: 'sed: the `w FILE` flag of `s` writes only the lines the substitution changed (it was parsed as a separate `w` command that wrote every line), and a range whose end is a line number that is not after the line its start matched is that one line (`/four/,3d` deleted to the end of the input, `/four/,3c X` printed nothing)',
		edits: [
			{
				name: 'the flags of s: w takes the rest of the line as the file name and belongs to the substitution',
				from: 'if(a==="g"||a==="i"||a==="p"||a==="I"||this.isDigit(a))l+=this.advance();else break}return{type:ce.SUBSTITUTE,value:`s${r}${s}${r}${o}${r}${l}`,pattern:s,replacement:o,flags:l,line:t,column:n}}',
				to: 'if(a==="g"||a==="i"||a==="p"||a==="I"||this.isDigit(a))l+=this.advance();else if(a==="w"){this.advance();for(;this.peek()===" "||this.peek()==="\\t";)this.advance();let f="";for(;this.pos<this.input.length&&this.peek()!=="\\n";)f+=this.advance();return{type:ce.SUBSTITUTE,value:`s${r}${s}${r}${o}${r}${l}w`,pattern:s,replacement:o,flags:l,wfile:f,line:t,column:n}}else break}return{type:ce.SUBSTITUTE,value:`s${r}${s}${r}${o}${r}${l}`,pattern:s,replacement:o,flags:l,line:t,column:n}}',
			},
			{
				name: 'the command carries the file',
				from: 'printOnMatch:r.includes("p"),nthOccurrence:s,extendedRegex:this.extendedRegex}}}',
				to: 'printOnMatch:r.includes("p"),nthOccurrence:s,writeFile:t.wfile,extendedRegex:this.extendedRegex}}}',
			},
			{
				name: 'a substitution that was made writes the pattern space to the file',
				from: 'o.printOnMatch&&t.lineNumberOutput.push(t.patternSpace)}}catch{}break}case"print":',
				to: 'o.printOnMatch&&t.lineNumberOutput.push(t.patternSpace),o.writeFile!==void 0&&t.pendingFileWrites.push({filename:o.writeFile,content:`${t.patternSpace}\\n`})}}catch{}break}case"print":',
			},
			{
				name: 'a range that starts on a line at or after its numeric end is closed on that line',
				from: 'h?(p.active=!0,p.startLine=t,s.set(d,p),yi(l,t,n,r,i)&&(p.active=!1,typeof o=="number"&&(p.completed=!0),s.set(d,p)),!0):!1',
				to: 'h?(p.active=!0,p.startLine=t,s.set(d,p),(yi(l,t,n,r,i)||typeof l=="number"&&l<=t)&&(p.active=!1,typeof o=="number"&&(p.completed=!0),s.set(d,p)),!0):!1',
			},
		],
	},	{
		id: 'LC-25',
		title: 'the engine\'s ExecutionLimitError is exported (as LimitError): a program that LevelCode adds (du) stops a script the way the engine\'s own find, ls -R and grep -r do at maxTraversalEntries, with how=limit, and not as a program that failed',
		edits: [
			{
				name: 'the export list',
				from: 'export{ch as Bash,ir as InMemoryFs,',
				to: 'export{C as LimitError,ch as Bash,ir as InMemoryFs,',
			},
		],
	},
	{
		id: 'LC-26',
		title: 'the content write of a redirection is marked (`{ encoding, lcRedirect: true }` where the encoding was): the file system cannot tell it from `tee`\'s or `sort -o`\'s own write to the same path by its arguments (`tee f` and `echo x > f` both end in `writeFile(f, text, \'binary\')`), and a write that is a redirection\'s must never throw (it would reject the whole exec() and lose the output) while a program\'s must (`tee`, `awk \'>\'` and `sort -o` report the errno as GNU\'s do)',
		edits: [
			{
				name: 'the content write of a file redirection',
				from: 'let E=async(A,I,R)=>{A.append?await e.fs.appendFile(A.path,I,R):await e.fs.writeFile(A.path,I,R)};',
				to: 'let E=async(A,I,R)=>{R={encoding:R,lcRedirect:!0};A.append?await e.fs.appendFile(A.path,I,R):await e.fs.writeFile(A.path,I,R)};',
			},
			{
				name: 'the content write to a descriptor that a redirection opened (`exec 3> f; echo x >&3`)',
				from: 'async function lp(e,t,n,r,s){if(t.kind==="output")return',
				to: 'async function lp(e,t,n,r,s){s={encoding:s,lcRedirect:!0};if(t.kind==="output")return',
			},
		],
	},
	{
		id: 'LC-27',
		title: 'cd: going up (`..`) to the root and down again made `//name` (`cd /w/../w` set PWD to `//w`, which `pwd` printed and the next line was handed as its working directory); the path is built from "/" and a component, and "/" is not a prefix to which another "/" is added',
		edits: [
			{
				name: 'the walk of the components: `..` leaves "" at the root, which the first name below it starts again as "/name"',
				from: 'for(let f of a)if(f==="..")c=c.split("/").slice(0,-1).join("/")||"/";else{',
				to: 'for(let f of a)if(f==="..")c=c.split("/").slice(0,-1).join("/");else{',
			},
		],
	},
	{
		id: 'LC-28',
		title: 'sort -k: the letters of a key are read where they are written: a `b` after the START position (`-k2b,3`) skips the blanks in front of the start field and one after the END position (`-k1.1,1b`, `-k2.3,3.0bn`) in front of the end field only, as in coreutils (skipsblanks, skipeblanks). The parser took the letters at the very end of the whole specification as the START\'s and lost the ones after the start position, so lines with a different number of leading blanks sorted another way',
		edits: [
			{
				name: 'the key specification: its letters are read where they are written (after the start position, after the end position)',
				from: 'function za(e){let t={startField:1},n="",r=e,s=r.match(/([bdfhMnrV]+)$/);',
				to: 'function za(e){return __lcKeySpec(e)}function __lcZa(e){let t={startField:1},n="",r=e,s=r.match(/([bdfhMnrV]+)$/);',
			},
		],
	},
	{
		id: 'LC-29',
		title: 'a byte that is not ASCII, written as an escape (printf \'\\377\', printf \'\\xff\', echo -e \'\\xff\', $\'\\xff\'), is that byte: the escapes made the character U+00FF (so `printf \'\\xff\' > f` wrote the two bytes of "ÿ", and `wc -c` said 2 for one byte of GNU\'s output). A run of them that is UTF-8 (`\\303\\251`) is the character, an invalid byte is held as the escape of text.js (U+DC80..U+DCFF), which goes back to the byte wherever the text becomes bytes (a file, a pipe)',
		edits: [
			{
				name: 'echo -e / printf %b (the escape processor of the shared helper): an octal escape is one byte',
				from: 'n+=String.fromCharCode(parseInt(i,8)),r=o;break}case"x":{let i=[],o=r;for(;o+3<e.length',
				to: 'n+=__lcByte(parseInt(i,8)),r=o;break}case"x":{let i=[],o=r;for(;o+3<e.length',
			},
			{
				name: 'the same helper: a run of \\xHH is decoded as UTF-8 where it is, and an invalid byte is kept as the byte',
				from: 'try{let l=new TextDecoder("utf-8",{fatal:!0});n+=l.decode(new Uint8Array(i))}catch{for(let l of i)n+=String.fromCharCode(l)}',
				to: 'n+=__lcBytes(i);',
			},
			{
				name: 'the same helper: what it returns has its escapes joined where they make UTF-8',
				from: ';return n}var zc,At=F(',
				to: ';return __lcHeal(n)}var zc,At=F(',
			},
			{
				name: 'echo -e: \\0NNN is a byte',
				from: 'let o=parseInt(s,8)%256;t+=String.fromCharCode(o)',
				to: 'let o=parseInt(s,8)%256;t+=__lcByte(o)',
			},
			{
				name: 'echo -e: \\xHH is a byte',
				from: 'let o=parseInt(s,16);t+=String.fromCharCode(o),n=i}break}case"u":',
				to: 'let o=parseInt(s,16);t+=__lcByte(o),n=i}break}case"u":',
			},
			{
				name: 'echo -e: what it prints has its escapes joined (the end of the text, and \\c)',
				from: 'return{output:t,stop:!1}',
				to: 'return{output:__lcHeal(t),stop:!1}',
			},
			{
				name: 'echo -e: \\c ends the text, with its escapes joined',
				from: 'return{output:t,stop:!0}',
				to: 'return{output:__lcHeal(t),stop:!0}',
			},
			{
				name: 'printf: a run of \\xHH is decoded as UTF-8 where it is, an invalid byte is kept as the byte',
				from: 'n+=tb(i),r=o',
				to: 'n+=__lcBytes(i),r=o',
			},
			{
				name: 'printf: \\0NNN is a byte',
				from: 'i?n+=String.fromCharCode(parseInt(i,8)):n+="\\0",r=o;break}',
				to: 'i?n+=__lcByte(parseInt(i,8)):n+="\\0",r=o;break}',
			},
			{
				name: 'printf: \\NNN is a byte, and what the format makes has its escapes joined',
				from: 'n+=String.fromCharCode(parseInt(i,8)),r=o;break}default:n+=e[r],r++}else n+=e[r],r++;return{value:n,stopped:!1}}',
				to: 'n+=__lcByte(parseInt(i,8)),r=o;break}default:n+=e[r],r++}else n+=e[r],r++;return{value:__lcHeal(n),stopped:!1}}',
			},
			{
				name: 'printf: \\c ends the output, with its escapes joined',
				from: 'case"c":return{value:n,stopped:!0};case"x":{let i=[],o=r;for(;o+1<e.length',
				to: 'case"c":return{value:__lcHeal(n),stopped:!0};case"x":{let i=[],o=r;for(;o+1<e.length',
			},
			{
				name: '$\'...\': a run of \\xHH is decoded as UTF-8 where it is, an invalid byte is kept as the byte',
				from: 'r+=FN(l),s=a',
				to: 'r+=__lcBytes(l),s=a',
			},
			{
				name: '$\'...\': \\NNN is a byte, and the word has its escapes joined',
				from: 'let c=parseInt(l,8);r+=String.fromCharCode(c),s=a;break}default:r+=i,s++}else r+=i,s++}return s<t.length&&t[s]==="\'"&&s++,{part:J.literal(r),endIndex:s}}',
				to: 'let c=parseInt(l,8);r+=__lcByte(c),s=a;break}default:r+=i,s++}else r+=i,s++}return s<t.length&&t[s]==="\'"&&s++,{part:J.literal(__lcHeal(r)),endIndex:s}}',
			},
		],
	},
	{
		id: 'LC-30',
		title: 'tee and touch say why in GNU\'s words when a write fails (`tee: d/f: Is a directory`, `touch: cannot touch \'d/f\': No such file or directory`): tee said "No such file or directory" for every reason, and touch printed the error as the engine raised it (`ENOENT: No such file or directory, open \'/w/d/f\'`)',
		edits: [
			{
				name: 'tee: the reason of the failed write',
				from: 'catch{o+=`tee: ${a}: No such file or directory\n`,l=1}',
				to: 'catch(__e){o+=`tee: ${a}: ${__lcErrno(__e)||"No such file or directory"}\n`,l=1}',
			},
			{
				name: 'touch: the reason of the failed write',
				from: 'catch(c){o+=`touch: cannot touch \'${a}\': ${lt(c)}\n`,l=1}',
				to: 'catch(c){o+=`touch: cannot touch \'${a}\': ${__lcErrno(c)||lt(c)}\n`,l=1}',
			},
		],
	},
	{
		id: 'LC-31',
		title: 'a command word that is an unquoted expansion is split into words (and globbed) as bash splits it (`c="ls -l"; $c` ran a command named "ls -l" and said "command not found"): the first word is the command and the rest are its first arguments',
		edits: [
			{
				name: 'simple command: the command name is expanded with field splitting when it is only expansions',
				from: 'let u=await Be(this.ctx,t.name),f=[],d=[],p=(N,$)=>{',
				to: 'let __nm=t.name.parts.every(N=>N.type==="CommandSubstitution"||N.type==="ParameterExpansion"||N.type==="ArithmeticExpansion"),__ex=__nm?await dr(this.ctx,t.name):null,u=__ex?__ex.values[0]??"":await Be(this.ctx,t.name),f=[],d=[],p=(N,$)=>{',
			},
			{
				name: 'simple command: the words after the first one of such a name are the first arguments',
				from: 'f.push(N),d.push($)};if(Jp(t.name,["local","declare","typeset","export","readonly"])&&(u==="local"',
				to: 'f.push(N),d.push($)};if(__ex)for(let __x of __ex.values.slice(1))p(__x,__ex.quoted);if(Jp(t.name,["local","declare","typeset","export","readonly"])&&(u==="local"',
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
