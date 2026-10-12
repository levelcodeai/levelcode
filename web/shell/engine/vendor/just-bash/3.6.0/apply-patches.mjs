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
 *  patches LC-1 .. LC-60 of web/shell/engine/vendor/just-bash/3.6.0/apply-patches.mjs (Apache-2.0 section 4(b)).
 *  Unmodified input sha256 ${UNPATCHED_SHA256}. */
import __lcText from"lc-text";
import __lcZone from"lc-zone";
const Date=__lcZone.LcDate;
var __lcUtf8=__lcText.decodeByteString;
var __lcVer=__lcText.versionCompare;
var __lcOpenError=l=>{let c=l&&l.code;return c==="ENOENT"?"No such file or directory":c==="EACCES"||c==="EPERM"?"Permission denied":c==="EISDIR"?"Is a directory":c==="ENOTDIR"?"Not a directory":c==="EROFS"?"Read-only file system":c==="ENOSPC"?"No space left on device":"cannot open redirect target"};
var __lcCmp=(a,b)=>{if(a===b)return 0;let n=a.length<b.length?a.length:b.length,i=0;for(;i<n&&a.charCodeAt(i)===b.charCodeAt(i);)i++;if(i===n)return a.length<b.length?-1:a.length>b.length?1:0;let x=a.charCodeAt(i),y=b.charCodeAt(i);x>=55296&&y>=55296&&(x+=x>=57344?-2048:8192,y+=y>=57344?-2048:8192);return x<y?-1:1};
var __lcMode=s=>{let m=typeof s.mode=="number"?s.mode:s.isDirectory?493:420,r=s.isDirectory?"d":"-";for(let i=8;i>=0;i--)r+=m>>i&1?"rwxrwxrwx"[8-i]:"-";return r};
var __lcRangeOpen=(a,l,n,st)=>{if(!a||a.negated||a.start===void 0||a.end===void 0)return!1;let o=a.start,e=a.end;if(typeof o=="object"||typeof e=="object"){let p=st.get(Nu(a));return!!(p&&p.active)}let d=typeof o=="number"?o:o==="$"?n:1,q=typeof e=="number"?e:n;return d<=q&&l<q};
var __lcBuiltinNames=new Set(["alias","echo","history","printf","pwd","unalias"]);
var __lcNoBuiltin=new Set(["bg","caller","disown","enable","fc","fg","jobs","kill","suspend","times","trap","ulimit","umask"]);
var __lcWordB=e=>{if(!e.includes("\\\\<")&&!e.includes("\\\\>"))return e;let t="",n=!1;for(let r=0;r<e.length;r++){let s=e[r];if(s==="\\\\"&&r+1<e.length){let i=e[++r];t+=!n&&(i==="<"||i===">")?"\\\\b":s+i;continue}if(n)s==="]"&&(n=!1);else if(s==="["){n=!0,t+=s,e[r+1]==="^"&&(t+="^",r++),e[r+1]==="]"&&(t+="]",r++);continue}t+=s}return t};
var __lcQuant=e=>{if(!/[*+?}][*+?{]|^[*+?{]|[(|][*+?{]|\\{,/.test(e))return e;let o="",at=-1,q=!1,st=[],i=0;for(;i<e.length;){let c=e[i];if(c==="\\\\"){o+=c+(e[i+1]===void 0?"":e[i+1]),at=o.length-(e[i+1]===void 0?1:2),q=!1,i+=2;continue}if(c==="["){let j=i+1;for(e[j]==="^"&&j++,e[j]==="]"&&j++;j<e.length&&e[j]!=="]";){if(e[j]==="["&&(e[j+1]===":"||e[j+1]==="."||e[j+1]==="=")){let k=e.indexOf(e[j+1]+"]",j+2);j=k<0?e.length:k+2}else e[j]==="\\\\"?j+=2:j++}let w=e.slice(i,j+1);at=o.length,o+=w,q=!1,i=j+1;continue}if(c==="("){if(st.push(o.length),o+=c,i++,e[i]==="?"){for(;i<e.length&&e[i]!==":"&&e[i]!==")"&&e[i]!==">";)o+=e[i++];i<e.length&&(o+=e[i++])}at=-1,q=!1;continue}if(c===")"){o+=c,at=st.length?st.pop():-1,q=!1,i++;continue}if(c==="|"||c==="^"||c==="$"){o+=c,at=-1,q=!1,i++;continue}let m=c==="{"?/^\\{(?:\\d+(?:,\\d*)?|,\\d*)\\}/.exec(e.slice(i)):null;if(c==="*"||c==="+"||c==="?"||m){let t=m?m[0]:c,n=t.length;if(at<0){i+=n;continue}t[0]==="{"&&t[1]===","&&(t="{0"+t.slice(1)),at>=0&&q&&(o=o.slice(0,at)+"(?:"+o.slice(at)+")"),o+=t,at>=0&&(q=!0),i+=n;continue}at=o.length,o+=c,q=!1,i++}return o};
var __lcRe=e=>__lcQuant(__lcWordB(e));
var __lcAwkRecords=(e,r)=>{if(r===void 0||r==="\\n")return e.split("\\n");if(r==="")return e.replace(/^\\n+/,"").replace(/\\n+$/,"").split(/\\n\\n+/);if(r.length===1)return e.split(r);try{return oe(r).split(e)}catch{return e.split("\\n")}};
var __lcLead=e=>{let a=!0;for(let i=0;i<e.length;i++){let c=e[i];if(c==="\\\\"){a=!1;i++;continue}if(c==="["){let j=i+1;for(e[j]==="^"&&j++,e[j]==="]"&&j++;j<e.length&&e[j]!=="]";){if(e[j]==="["&&(e[j+1]===":"||e[j+1]==="."||e[j+1]==="=")){let k=e.indexOf(e[j+1]+"]",j+2);j=k<0?e.length:k+2}else j++}i=j,a=!1;continue}if(a&&(c==="*"||c==="+"||c==="?"))throw Object.assign(new Error("Invalid preceding regular expression"),{lcRegex:!0});a=c==="("||c==="|"||c==="^"&&a}};
var __lcReMsg=e=>{if(e&&e.lcRegex)return e.message;let m=String(e&&e.message||""),g=/invalid repeat count: .\\{(\\d+)(?:,(\\d*))?\\}./.exec(m);return/__lcccs/.test(m)?"character class syntax is [[:space:]], not [:space:]":/missing closing \\)/.test(m)?"Unmatched ( or \\\\(":/unexpected \\)/.test(m)?"Unmatched ) or \\\\)":/missing closing \\]/.test(m)?"Unmatched [, [^, [:, [., or [=":g?+g[1]>32767||g[2]&&+g[2]>32767?"Regular expression too big":g[2]&&+g[2]<+g[1]?"Invalid content of \\\\{\\\\}":"a repeat count over 1000 is not supported by this shell":/Backreferences/.test(m)?"back-references in a pattern are not supported by this shell":/invalid character class range: .\\[:/.test(m)?"Invalid character class name":/invalid character class range/.test(m)?"Invalid range end":"Invalid regular expression"};
var __lcRepl=(e,t,n)=>{let r="",s=0,m="",o="",f=x=>{if(x==="")return;if(o){let c=x[0];c=o==="u"?c.toUpperCase():c.toLowerCase();o="";x=c+(m==="U"?x.slice(1).toUpperCase():m==="L"?x.slice(1).toLowerCase():x.slice(1))}else if(m)x=m==="U"?x.toUpperCase():x.toLowerCase();r+=x},hx=c=>/[0-9a-fA-F]/.test(c||"");for(;s<e.length;){let c=e[s];if(c==="\\\\"&&s+1<e.length){let i=e[s+1];if(i==="&"){f("&");s+=2;continue}if(i==="n"){f("\\n");s+=2;continue}if(i==="t"){f("\\t");s+=2;continue}if(i==="r"){f("\\r");s+=2;continue}if(i==="a"){f("\\x07");s+=2;continue}if(i==="f"){f("\\f");s+=2;continue}if(i==="v"){f("\\v");s+=2;continue}if(i==="L"||i==="U"){m=i;o="";s+=2;continue}if(i==="l"||i==="u"){o=i;s+=2;continue}if(i==="E"){m="";o="";s+=2;continue}if(i==="c"&&s+2<e.length){f(__lcByte(e[s+2].toUpperCase().charCodeAt(0)^64));s+=3;continue}if(i==="x"&&hx(e[s+2])){let h=e[s+2]+(hx(e[s+3])?e[s+3]:"");f(__lcByte(parseInt(h,16)));s+=2+h.length;continue}if(i==="o"&&/[0-7]/.test(e[s+2]||"")){let h=/^[0-7]{1,3}/.exec(e.slice(s+2))[0];f(__lcByte(parseInt(h,8)));s+=2+h.length;continue}if(i==="d"&&/[0-9]/.test(e[s+2]||"")){let h=/^[0-9]{1,3}/.exec(e.slice(s+2))[0];f(__lcByte(parseInt(h,10)));s+=2+h.length;continue}let d=parseInt(i,10);if(d===0){f(t);s+=2;continue}if(d>=1&&d<=9){f(n[d-1]||"");s+=2;continue}f(i);s+=2;continue}if(c==="&"){f(t);s++;continue}f(c);s++}return r};
var __lcIv=(p,x,g)=>{if(p.indexOf("{")<0&&!/\\\\[1-9]/.test(p))return"";let a=!1,i=0,n=p.length,cl=0;for(;i<n;){let c=p[i];if(c==="["){let j=i+1;p[j]==="^"&&j++;p[j]==="]"&&j++;for(;j<n&&p[j]!=="]";){if(p[j]==="["&&(p[j+1]===":"||p[j+1]==="."||p[j+1]==="=")){let k=p.indexOf(p[j+1]+"]",j+2);j=k<0?n:k+2}else j++}i=j+1;a=!0;continue}if(c==="\\\\"){let d=p[i+1];if(!x&&d==="{"){if(!a){if(g){a=!0;i+=2;continue}return"Invalid preceding regular expression"}let k=p.indexOf("\\\\}",i+2);if(k<0)return"Unmatched \\\\{";let b=p.slice(i+2,k);if(b===""||!/^\\d*(,\\d*)?$/.test(b))return"Invalid content of \\\\{\\\\}";i=k+2;continue}if(!x&&(d==="("||d==="|")){a=!1;i+=2;continue}if(!x&&d===")"){a=!0;cl++;i+=2;continue}if(d>="1"&&d<="9"&&+d>cl)return"Invalid back reference";a=!0;i+=2;continue}if(x&&c==="{"){if(!a){if(g){a=!0;i++;continue}return"Invalid preceding regular expression"}let k=p.indexOf("}",i+1);if(k<0){if(g){i++;continue}return"Unmatched \\\\{"}let b=p.slice(i+1,k);if(/^[0-9,]*$/.test(b)){if(b===""||!/^\\d*(,\\d*)?$/.test(b))return"Invalid content of \\\\{\\\\}"}else if(!g)return"Invalid content of \\\\{\\\\}";i=k+1;continue}if(x&&c===")"){a=!0;cl++;i++;continue}if(x&&(c==="("||c==="|")||c==="^"&&(x||!a)){a=!1;i++;continue}a=!0;i++}return""};
var __lcPat=(e,x,g)=>{{let __v=__lcIv(e,x,g);if(__v)throw Object.assign(new Error(__v),{lcRegex:!0})}if(e.indexOf("\\\\")<0&&!(g&&x&&/[){]/.test(e))&&!/\\[[.=:]/.test(e)&&!/(^|[^[])\\[\\^?:/.test(e))return e;let T=[],i=0,sp=c=>/[.^$*+?(){}|[\\]\\\\\\/-]/.test(c)?"\\\\"+c:c,num=(re,b,k)=>{let h=re.exec(e.slice(k));return h?[String.fromCharCode(parseInt(h[0],b)),h[0].length]:null};for(;i<e.length;){let c=e[i];if(c==="["){let j=i+1,ng=!1,body="";e[j]==="^"&&(ng=!0,j++);e[j]==="]"&&(body="]",j++);for(;j<e.length&&e[j]!=="]";){if(e[j]==="["&&(e[j+1]===":"||e[j+1]==="."||e[j+1]==="=")){let k=e.indexOf(e[j+1]+"]",j+2);if(k>=0){let w=e.slice(j+2,k);if(e[j+1]!==":"&&w.length!==1)throw Object.assign(new Error("Invalid collation character"),{lcRegex:!0});if(e[j+1]!==":"&&w.length===1){body+=/[\\]\\\\^-]/.test(w)?"\\\\"+w:w}else body+=e.slice(j,k+2);j=k+2;continue}throw Object.assign(new Error("Unmatched [, [^, [:, [., or [="),{lcRegex:!0})}if(e[j]==="\\\\"&&j+1<e.length){let d=e[j+1];if(!g&&"ntrfva".includes(d)){body+="\\\\"+d,j+=2;continue}if(!g&&(d==="o"||d==="d"||d==="x")){let m=num(d==="o"?/^[0-7]{1,3}/:d==="x"?/^[0-9a-fA-F]{1,2}/:/^[0-9]{1,3}/,d==="o"?8:d==="x"?16:10,j+2);if(m){body+=m[0]==="\\\\"?"\\\\\\\\":m[0],j+=2+m[1];continue}body+=d,j+=2;continue}body+="\\\\\\\\",j++;continue}body+=e[j],j++}if(j>=e.length)throw Object.assign(new Error("Unmatched [, [^, [:, [., or [="),{lcRegex:!0});{let __r=e.slice(i+1+(ng?1:0),j);if(__r.length>2&&__r[0]===":"&&__r[__r.length-1]===":"&&/[^:]/.test(__r)&&__r.indexOf("-")<0&&!/\\[[:.=]/.test(__r))return"[[:__lcccs:]]"}T.push({t:ng?"neg":"br",b:body}),i=j+1;continue}if(c==="\\\\"&&i+1>=e.length)throw Object.assign(new Error("Trailing backslash"),{lcRegex:!0});if(c==="\\\\"&&i+1<e.length){let d=e[i+1];if(d==="<"){T.push({t:"ws"}),i+=2;continue}if(d===">"){T.push({t:"we"}),i+=2;continue}if(!x&&d==="("){T.push({t:"open",s:"\\\\("}),i+=2;continue}if(!x&&d===")"){T.push({t:"close",s:"\\\\)"}),i+=2;continue}if(!x&&d==="|"){T.push({t:"bar",s:"\\\\|"}),i+=2;continue}if(!g&&(d==="o"||d==="d"||d==="x")){let m=num(d==="o"?/^[0-7]{1,3}/:d==="x"?/^[0-9a-fA-F]{1,2}/:/^[0-9]{1,3}/,d==="o"?8:d==="x"?16:10,i+2);if(m){T.push({t:"lit",s:m[0]==="\\\\"?"\\\\\\\\":m[0]}),i+=2+m[1];continue}T.push({t:"lit",s:d}),i+=2;continue}if(!g&&d==="c"&&i+2<e.length){let q=String.fromCharCode(e[i+2].toUpperCase().charCodeAt(0)^64);T.push({t:"lit",s:q==="\\\\"?"\\\\\\\\":q}),i+=3;continue}T.push(/[A-Za-z]/.test(d)&&!(g?"wWsSbB":"wWsSbBntrfva").includes(d)?{t:"lit",s:d}:{t:"esc",s:"\\\\"+d}),i+=2;continue}if(c==="."){T.push({t:"dot"}),i++;continue}if(x&&c==="("){T.push({t:"open",s:c}),i++;continue}if(x&&c===")"){T.push({t:"close",s:c}),i++;continue}if(g&&x&&c==="{"&&!/^\\{(\\d+(,\\d*)?|,\\d*)\\}/.test(e.slice(i))){T.push({t:"lit",s:"\\\\{"}),i++;continue}if(x&&c==="|"){T.push({t:"bar",s:c}),i++;continue}T.push({t:"lit",s:c}),i++}if(g&&x){let dp=0;for(let o of T){if(o.t==="open")dp++;else if(o.t==="close"){if(dp>0)dp--;else o.s="\\\\)"}}}let nwb=b=>{let c=b.replace(/^-|-$/g,"");return c!==""&&!/[A-Za-z0-9_\\\\[\\]-]/.test(c)},nw=o=>o&&(o.t==="lit"&&/^[^A-Za-z0-9_]$/.test(o.s)&&!(o.s==="*"||o.s==="{"||o.s==="}"||o.s==="^"||o.s==="$"||x&&(o.s==="+"||o.s==="?"))||o.t==="esc"&&/^\\\\[^A-Za-z0-9_]$/.test(o.s)&&!(!x&&/^\\\\[+?{}]$/.test(o.s))||o.t==="br"&&nwb(o.b)),nq=o=>o&&(o.t==="lit"&&(o.s==="*"||o.s==="{"||x&&(o.s==="+"||o.s==="?"))||o.t==="esc"&&!x&&/^\\\\[+?{]$/.test(o.s));for(let k=0;k<T.length;k++){let o=T[k];if(o.t==="ws"){let q=k+1;for(;T[q]&&T[q].t==="open";)q++;if(nw(T[q])||nq(T[q])||T[q]&&T[q].t==="we")o.t="never"}else if(o.t==="we"){let q=k-1;for(;T[q]&&T[q].t==="close";)q--;if(nw(T[q])||T[q]&&T[q].t==="ws")o.t="never"}}let w=!1;for(let k=0;k<T.length;k++){let o=T[k];if(o.t==="ws"){w=!0;continue}if(o.t==="we"){let p=T[k-1];p&&(p.t==="dot"?p.t="wordchar":p.t==="neg"&&(p.w=!0));continue}if(w){if(o.t==="open")continue;o.t==="dot"?o.t="wordchar":o.t==="neg"&&(o.w=!0);w=!1}}let r="";for(let o of T)r+=o.t==="never"?"\\\\b\\\\B":o.t==="ws"||o.t==="we"?"\\\\b":o.t==="dot"?".":o.t==="wordchar"?"\\\\w":o.t==="br"?"["+o.b+"]":o.t==="neg"?"[^"+o.b+(o.w?"\\\\W":"")+"]":o.s;return r};
var __lcRef=(r,p,x)=>{let g=0;for(let i=0;i<p.length;i++){let c=p[i];if(c==="\\\\"){x||p[i+1]!=="("||g++;i++;continue}if(c==="["){let j=i+1;for(p[j]==="^"&&j++,p[j]==="]"&&j++;j<p.length&&p[j]!=="]";){if(p[j]==="["&&(p[j+1]===":"||p[j+1]==="."||p[j+1]==="=")){let k=p.indexOf(p[j+1]+"]",j+2);j=k<0?p.length:k+2}else j++}i=j;continue}x&&c==="("&&g++}for(let i=0;i<r.length;i++)if(r[i]==="\\\\"){let d=r.charCodeAt(i+1)-48;if(d>g&&d<=9)return d;i++}return 0};
var __lcOff=(l,t)=>l.multiple!==void 0?l.multiple>0?l.multiple-t%l.multiple:0:l.offset;
var __lcDev=(A,f,m)=>{let d=m&&f.__lcTake(m);if(!d||!d.stdout&&!d.stderr)return A;let b=A.stdoutEncoding==="binary"?x=>Array.from(__lcText.encodeText(x),c=>String.fromCharCode(c)).join(""):x=>x;return{...A,stdout:(A.stdout||"")+b(d.stdout),stderr:(A.stderr||"")+d.stderr}};
var __lcWs=(r,m)=>{r=r.replace(/^[ \\t\\n]+|[ \\t\\n]+$/g,"");return r===""?[]:r.split(/[ \\t\\n]+/,m)};
var __lcRedir=e=>{let t=e.parsePrimary();for(;e.match(le.NUMBER,le.STRING,le.IDENT,le.DOLLAR,le.LPAREN);){let n=e.parsePrimary();t={type:"binary",operator:" ",left:t,right:n}}return t};
var __lcPipe=async(e,n,r)=>{let c=et(await ke(e,n)),m=e.__lcPipes||(e.__lcPipes=new Map);m.has(c)||(e.__lcF=e.output.length);m.set(c,(m.get(c)||"")+r)};
var __lcRun=async(e,c,x)=>{if(!e.exec)return;let r=await e.exec(c,x),f=e.__lcF||0,o=r.stdout||"";e.output=e.output.slice(0,f)+o+e.output.slice(f);e.__lcF=f+o.length;r.stderr&&(e.__lcErr=(e.__lcErr||"")+r.stderr)};
var __lcFlush=async e=>{let m=e.__lcPipes;if(!m||m.size===0)return;let a=[...m];m.clear();for(let[c,x]of a)await __lcRun(e,c,x);zu(e)};
var __lcFrac=ms=>String(((ms%1e3)+1e3)%1e3).padStart(3,"0")+"0000000";
var __lcPct=e=>e.indexOf("\\\\")<0?e:e.replace(/\\\\(?:[0-7]{1,3}|x[0-9a-fA-F]{1,2}|u[0-9a-fA-F]{1,4}|U[0-9a-fA-F]{1,8}|[^0-7xuU])/g,m=>{let c=m[1];return(c==="x"||c==="u"||c==="U"?parseInt(m.slice(2),16):parseInt(m.slice(1),8))===37?"%%":m});
var __lcBrk=L=>{let c=L.input[L.pos+1],e=L.input.indexOf(c+"]",L.pos+2),n=L.input.indexOf("\\n",L.pos),s="";e=e>=0&&(n<0||e<n)?e+2:n<0?L.input.length:n;for(;L.pos<e;)s+=L.advance();return s};
var __lcSedFail=(t,e,c)=>{t.errorMessage="sed: -e expression #1, char "+c+": "+__lcReMsg(e);t.quit=!0};
var __lcWhere2=(ps,a,m,z)=>{ps=ps||[0];let o=0,k=0;for(;k<ps.length-1&&a>o+ps[k];k++)o+=ps[k]+1;return"-e expression #"+(k+1)+", char "+(z?0:a-o)+": "+m};
var __lcWhere=(P,a,m,z)=>__lcWhere2(P.__lcP,a,m,z);
var __lcAbs=(P,t)=>{let a=(P.scripts[0]||"").split("\\n"),o=0;for(let k=1;k<t.line&&k<=a.length;k++)o+=a[k-1].length+1;return o+t.column};
var __lcB=(P,t)=>{if(!t||t.type!=="NEWLINE")return-1;let a=__lcAbs(P,t),ps=P.__lcP||[0],o=0;for(let k=0;k<ps.length-1;k++){if(a===o+ps[k]+1)return o+ps[k];o+=ps[k]+1}return-1};
var __lcAt=(P,t)=>{if(!t||t.type==="EOF")return(P.scripts[0]||"").length;let b=__lcB(P,t);return b>=0?b:__lcAbs(P,t)};
var __lcUnk=P=>{let t=P.peek(),a=__lcAbs(P,t),c=(P.scripts[0]||"")[a-1];return __lcWhere(P,a,c?"unknown command: "+String.fromCharCode(96)+c+"'":"missing command")};
var __lcBrace=P=>{let d=0;for(let k=0;k<P.pos;k++){let t=P.tokens[k].type;t==="LBRACE"?d++:t==="RBRACE"&&d--}return d};
var __lcAfter=(P,t)=>{let b=__lcB(P,t);return b>=0?__lcWhere(P,b,"missing command"):__lcWhere(P,__lcAbs(P,t),"unknown command: "+String.fromCharCode(96)+(t.type==="NEWLINE"?"\\n":";")+"'")};
var __lcNl=s=>{let o="",i=0,n=s.length;for(;i<n;){let c=s[i];if(c==="\\\\"){o+=c+(s[i+1]===void 0?"":s[i+1]);i+=2;continue}if(c!=="["){o+=c;i++;continue}o+="[";i++;if(s[i]==="^"){o+="^\\\\n";i++}if(s[i]==="]"){o+="]";i++}for(;i<n&&s[i]!=="]";){let d=s[i];if(d==="\\\\"){o+=d+(s[i+1]===void 0?"":s[i+1]);i+=2}else if(d==="["&&s[i+1]===":"){let k=s.indexOf(":]",i+2);k<0?(o+=s.slice(i),i=n):(o+=s.slice(i,k+2),i=k+2)}else{o+=d;i++}}if(i<n){o+="]";i++}}return o};
var __lcList=(s,w)=>{let b=__lcText.encodeText(s),n=w===void 0?70:w,o="",c=0,N={7:"\\\\a",8:"\\\\b",12:"\\\\f",10:"\\\\n",13:"\\\\r",9:"\\\\t",11:"\\\\v"};for(let i=0;i<b.length;i++){let x=b[i],t=x===92?"\\\\\\\\":N[x]||(x>=32&&x<127?String.fromCharCode(x):"\\\\"+x.toString(8).padStart(3,"0"));if(n>0&&c+t.length>n-1){o+="\\\\\\n";c=0}o+=t;c+=t.length}return o+"$"};
var __lcY4=y=>y>=0&&y<1000?String(y).padStart(4,"0"):String(y);
var __lcXtra=(P,s)=>{let L=P.tokens[P.pos-1],N=P.tokens[P.pos];if(P.pos<=s||!L||!N||N.type==="EOF")return"";if(!(L.type==="COMMAND"||L.type==="SUBSTITUTE"||L.type==="TRANSLITERATE"||L.type==="RBRACE"))return"";if(N.type==="NEWLINE"||N.type==="SEMICOLON"||N.type==="RBRACE")return"";if(L.type==="SUBSTITUTE"&&(N.type==="FILE_WRITE"||N.type==="EXECUTE"))return"";return __lcWhere(P,__lcAbs(P,N),"extra characters after command")};
var __lcChk=(cs,pc)=>{for(let c of cs){let ps=[],a=c.address;if(a)for(let x of[a.start,a.end])x&&typeof x=="object"&&typeof x.pattern=="string"&&x.pattern!==""&&ps.push([x.pattern,x.extendedRegex,x.end,null]);c.type==="substitute"&&c.pattern!==""&&ps.push([c.pattern,c.extendedRegex,c.__lcEnd,c.replacement]);for(let[p,x,en,rp]of ps){let at=en||p.length+2,m="";try{let k=ku(x?__lcPat(p,!0):vu(__lcPat(p,!1)));x&&__lcLead(p);oe(k,"")}catch(e){if(e&&e.lcRegex)m=e.message;else if(String(e&&e.message).startsWith("Invalid regular expression")){m=__lcReMsg(e);if(/^(back-references|a repeat count over|Invalid regular expression)/.test(m))m=""}}if(m)return m.startsWith("character class syntax")?m:__lcWhere2(pc,at,m);if(rp!==null){let d=__lcRef(rp,p,x);if(d)return __lcWhere2(pc,at,"invalid reference \\\\"+d+" on "+String.fromCharCode(96)+"s' command's RHS")}}if(c.type==="group"){let r=__lcChk(c.commands,pc);if(r)return r}}return""};
var __lcKey=(e,t,n,g)=>{let l=e.length,a=n===null?null:n[0],b=c=>c===" "||c==="\\t",f=(p,k)=>{if(a!==null){for(;p<l&&k--;){for(;p<l&&e[p]!==a;)p++;p<l&&p++}}else{for(;p<l&&k--;){for(;p<l&&b(e[p]);)p++;for(;p<l&&!b(e[p]);)p++}}return p},sb=t.ignoreLeading||g,eb=t.ignoreLeadingEnd||g,s=f(0,t.startField-1);if(sb)for(;s<l&&b(e[s]);)s++;if(s=Math.min(l,s+(t.startChar===void 0?0:t.startChar-1)),t.endField===void 0)return e.slice(s);let w=t.endField-1,c=t.endChar===void 0?0:t.endChar,p=0;if(c===0&&w++,a!==null){for(;p<l&&w--;){for(;p<l&&e[p]!==a;)p++;p<l&&(w||c)&&p++}}else{for(;p<l&&w--;){for(;p<l&&b(e[p]);)p++;for(;p<l&&!b(e[p]);)p++}}if(c!==0){if(eb)for(;p<l&&b(e[p]);)p++;p=Math.min(l,p+c)}return e.slice(s,Math.max(s,p))};
var __lcKeySpec=e=>{let t={},p=e.split(","),fl=(f,end)=>{f.includes("n")&&(t.numeric=!0),f.includes("r")&&(t.reverse=!0),f.includes("f")&&(t.ignoreCase=!0),f.includes("b")&&(t[end?"ignoreLeadingEnd":"ignoreLeading"]=!0),f.includes("h")&&(t.humanNumeric=!0),f.includes("V")&&(t.versionSort=!0),f.includes("d")&&(t.dictionaryOrder=!0),f.includes("M")&&(t.monthSort=!0)},pos=s=>{let m=/^(\\d*)(?:\\.(\\d*))?([A-Za-z]*)$/.exec(s);return m?{f:m[1]===""?NaN:parseInt(m[1],10),c:m[2]?parseInt(m[2],10):void 0,o:m[3]}:null},a=pos(p[0]);if(p.length>2||!a||!(a.f>=1))return null;if(t.startField=a.f,a.c>=1&&(t.startChar=a.c),fl(a.o,!1),p.length>1&&p[1]!==""){let b=pos(p[1]);if(!b)return null;b.f>=1&&(t.endField=b.f,b.c>=1&&(t.endChar=b.c)),fl(b.o,!0)}return t};
var __lcBytes=a=>__lcText.decodeBytes(Uint8Array.from(a));
var __lcByte=v=>{v&=255;return v<128?String.fromCharCode(v):String.fromCharCode(56320+v)};
var __lcHeal=s=>__lcText.joinEscapes(s);
var __lcErrno=l=>{let c=l&&l.code;return c==="ENOENT"?"No such file or directory":c==="EACCES"||c==="EPERM"?"Permission denied":c==="EISDIR"?"Is a directory":c==="ENOTDIR"?"Not a directory":c==="EROFS"?"Read-only file system":c==="ENOSPC"?"No space left on device":null};
var __lcRedirectName=async(e,n)=>{if(n==="")return"No such file or directory";if(n.length>1&&n.endsWith("/"))return"Is a directory";if(n.includes("..")||n.endsWith("/.")){let c=n[0]==="/"?"/":e.state.cwd,p=n.split("/").filter(s=>s!==""&&s!==".");for(let k=0;k<p.length;k++){let st;try{st=await e.fs.stat(c)}catch{return"No such file or directory"}if(!st.isDirectory)return"Not a directory";c=e.fs.resolvePath(c,p[k])}if(n.endsWith("/.")){try{if(!(await e.fs.stat(c)).isDirectory)return"Not a directory"}catch{return"No such file or directory"}}}return null};
var __lcCpLen=s=>{let n=0;for(let i=0;i<s.length;i++){let c=s.charCodeAt(i);if(c>=55296&&c<=56319&&i+1<s.length&&(s.charCodeAt(i+1)&64512)===56320)i++;n++}return n};
var __lcCpSub=(s,a,l)=>{let r="",k=0,i=0;for(;i<s.length;){let c=s.charCodeAt(i),w=c>=55296&&c<=56319&&i+1<s.length&&(s.charCodeAt(i+1)&64512)===56320?2:1;if(k>=a&&(l===void 0||k<a+l))r+=s.slice(i,i+w);k++;i+=w;if(l!==void 0&&k>=a+l)break}return r};
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
				name: 'grep, basic expression: an interval with no lower bound, \\{,2\\}, is \\{0,2\\}',
				from: 'if(o==="{"){let a=e.slice(n).match(/^\\\\{(\\d+)(,(\\d*)?)?\\\\}/);if(a){let c=a[1],u=a[2]!==void 0,f=a[3]||"";',
				to: 'if(o==="{"){let a=e.slice(n).match(/^\\\\{(\\d*)(,(\\d*)?)?\\\\}/);if(a&&(a[1]!==""||a[2]!==void 0)){let c=a[1]||"0",u=a[2]!==void 0,f=a[3]||"";',
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
				to: 'if(a==="g"||a==="p"){if(l.includes(a))return{type:ce.ERROR,value:"multiple `"+a+"\' options to `s\' command",line:t,column:this.pos+1,abs:!0};l+=this.advance()}else if(a==="i"||a==="I"||a==="m"||a==="M")l+=this.advance();else if(this.isDigit(a)){if(/\\d/.test(l))return{type:ce.ERROR,value:"multiple number options to `s\' command",line:t,column:this.pos+1,abs:!0};let q="";for(;this.isDigit(this.peek());)q+=this.advance();if(+q===0)return{type:ce.ERROR,value:"number option to `s\' command may not be zero",line:t,column:this.pos,abs:!0};l+=q}else if(a===" "||a==="\\t")this.advance();else if(a==="w"){this.advance();for(;this.peek()===" "||this.peek()==="\\t";)this.advance();let f="";for(;this.pos<this.input.length&&this.peek()!=="\\n";)f+=this.advance();return{type:ce.SUBSTITUTE,value:`s${r}${s}${r}${o}${r}${l}w`,pattern:s,replacement:o,flags:l,wfile:f,end:this.pos,line:t,column:n}}else break}let __c=this.peek();if(__c&&!";\\n}#\\r wWeE".includes(__c))return{type:ce.ERROR,value:"unknown option to `s\'",line:t,column:this.pos+1,abs:!0};return{type:ce.SUBSTITUTE,value:`s${r}${s}${r}${o}${r}${l}`,pattern:s,replacement:o,flags:l,end:this.pos,line:t,column:n}}',
			},
			{
				name: 'the command carries the file',
				from: 'printOnMatch:r.includes("p"),nthOccurrence:s,extendedRegex:this.extendedRegex}}}',
				to: 'printOnMatch:r.includes("p"),nthOccurrence:s,writeFile:t.wfile,multiline:r.includes("m")||r.includes("M"),extendedRegex:this.extendedRegex,__lcEnd:t.end}}}',
			},
			{
				name: 'a substitution that was made writes the pattern space to the file',
				from: 'o.printOnMatch&&t.lineNumberOutput.push(t.patternSpace)}}',
				to: '__no?t.substitutionMade=__sm:(o.printOnMatch&&t.lineNumberOutput.push(t.patternSpace),o.writeFile!==void 0&&t.pendingFileWrites.push({filename:o.writeFile,content:`${t.patternSpace}\\n`}))}}',
			},
			{
				name: 'a range that starts on a line at or after its numeric end is closed on that line',
				from: 'h?(p.active=!0,p.startLine=t,s.set(d,p),yi(l,t,n,r,i)&&(p.active=!1,typeof o=="number"&&(p.completed=!0),s.set(d,p)),!0):!1',
				to: 'h?(p.active=!0,p.startLine=t,s.set(d,p),(((typeof l!="object"||!("pattern"in l)||o===0)&&yi(l,t,n,r,i))||typeof l=="number"&&l<=t)&&(p.active=!1,typeof o=="number"&&(p.completed=!0),s.set(d,p)),!0):!1',
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
		title: 'a command word that has an expansion in it is split into words (and globbed) as bash splits it (`c="ls -l"; $c` ran a command named "ls -l" and said "command not found"): the first word is the command and the rest are its first arguments. A quoted list is words too (`"$@"`, `"${cmd[@]}"`, `"x$@"`, `x"$@"`: `run() { "$@"; }` could not run what it was given), and one that is empty is no command at all',
		edits: [
			{
				name: 'simple command: the command name is expanded with field splitting when it is only expansions',
				from: 'let u=await Be(this.ctx,t.name),f=[],d=[],p=(N,$)=>{',
				to: 'let __xp=P=>P.type==="CommandSubstitution"||P.type==="ParameterExpansion"||P.type==="ArithmeticExpansion",__nm=t.name.parts.some(N=>__xp(N)||N.type==="DoubleQuoted"&&N.parts.some(__xp)),__ex=__nm?await dr(this.ctx,t.name):null,__z=__ex!==null&&__ex.values.length===0,u=__ex?__ex.values[0]??"":await Be(this.ctx,t.name),f=[],d=[],p=(N,$)=>{',
			},
			{
				name: 'simple command: the words after the first one of such a name are the first arguments',
				from: 'f.push(N),d.push($)};if(Jp(t.name,["local","declare","typeset","export","readonly"])&&(u==="local"',
				to: 'f.push(N),d.push($)};if(__ex)for(let __x of __ex.values.slice(1))p(__x,__ex.quoted);if(Jp(t.name,["local","declare","typeset","export","readonly"])&&(u==="local"',
			},
			{
				name: 'simple command: an expansion that made no word at all (an empty `"$@"`) is no command, and the next word is the command, as for an unquoted one',
				from: 'let m=t.name.parts.every(N=>N.type==="CommandSubstitution"||N.type==="ParameterExpansion"||N.type==="ArithmeticExpansion");!u&&m&&f.length>0&&(u=f.shift(),d.shift());',
				to: 'let m=__z||t.name.parts.every(N=>N.type==="CommandSubstitution"||N.type==="ParameterExpansion"||N.type==="ArithmeticExpansion");!u&&m&&f.length>0&&(u=f.shift(),d.shift());',
			},
		],
	},
	{
		id: 'LC-32',
		title: 'the target of an output redirection is looked at as it was typed: a name that ends in a slash is a directory (`echo x > f/` wrote a file named f), an empty one is no such file, and a path that goes up through a folder that is not there (`> x/../n`) or through a file is not there (`> x/../n` wrote `n`)',
		edits: [
			{
				name: 'the check of an output target (exists? is a directory? noclobber?) first asks about the name as typed',
				from: 'async function FO(e,t,n,r){try{if(!await e.fs.exists(t))return null;',
				to: 'async function FO(e,t,n,r){try{let __m=await __lcRedirectName(e,n);if(__m)return`bash: ${n}: ${__m}\n`;if(!await e.fs.exists(t))return null;',
			},
		],
	},
	{
		id: 'LC-33',
		title: 'awk counts characters, not UTF-16 units: length, substr, index and the RSTART/RLENGTH of match are in code points (`length("😀")` was 2, GNU awk in a UTF-8 locale says 1)',
		edits: [
			{
				name: 'length()',
				from: 'function rE(e,t,n){return e.length===0?t.line.length:jt(await n.evalExpr(e[0])).length}',
				to: 'function rE(e,t,n){return e.length>0&&e[0].type==="variable"&&t.arrays[yo(t,e[0].name)]!==void 0?Object.keys(t.arrays[yo(t,e[0].name)]).length:__lcCpLen(e.length===0?t.line:jt(await n.evalExpr(e[0])))}',
			},
			{
				name: 'substr(): the slice of code points',
				from: 'return r.substr(Math.max(0,s),i)}return r.substr(Math.max(0,s))}',
				to: 'return __lcCpSub(r,Math.max(0,s),i)}return __lcCpSub(r,Math.max(0,s))}',
			},
			{
				name: 'index(): the code points before the match',
				from: 'i=r.indexOf(s);return i===-1?0:i+1}async function oE(',
				to: 'i=r.indexOf(s);return i===-1?0:__lcCpLen(r.slice(0,i))+1}async function oE(',
			},
			{
				name: 'match(): RSTART and RLENGTH',
				from: 'return t.RSTART=o.index+1,t.RLENGTH=o[0].length,t.RSTART',
				to: 'return t.RSTART=__lcCpLen(r.slice(0,o.index))+1,t.RLENGTH=__lcCpLen(o[0]),t.RSTART',
			},
		],
	},
	{
		id: 'LC-34',
		title: 'sed: `H` appends a newline and the pattern space to the hold space whatever it holds (with the hold space empty it stored the pattern space alone, so `sed -n \'H;${x;s/\\n/,/g;p}\'` had no leading comma, and `x;G` and `H;x` made other lines than GNU\'s)',
		edits: [
			{
				name: 'H: the newline comes first even when the hold space is empty',
				from: 'case"holdAppend":t.holdSpace?t.holdSpace+=`\n${t.patternSpace}`:t.holdSpace=t.patternSpace,Rm(',
				to: 'case"holdAppend":t.holdSpace+=`\n${t.patternSpace}`,Rm(',
			},
		],
	},
	{
		id: 'LC-35',
		title: 'sed: `.` matches a newline in the pattern space, as it does in a POSIX regular expression without REG_NEWLINE (`N;s/a.b/X/` and `/a.b/` on two joined lines, `:a;N;$!ba;s/foo.*bar/X/` across lines, found nothing)',
		edits: [
			{
				name: 's: the regular expression is compiled with the dot-all flag',
				from: 'case"substitute":{let o=e,l="";o.global&&(l+="g"),o.ignoreCase&&(l+="i");',
				to: 'case"substitute":{let o=e,l=o.multiline?"m":"s";o.global&&(l+="g"),o.ignoreCase&&(l+="i");',
			},
			{
				name: 's with a number: the global copy it counts matches with has the flag too',
				from: 'p=o.nthOccurrence,h=oe(c,`g${o.ignoreCase?"i":""}`);t.patternSpace=h.replace(',
				to: 'p=o.nthOccurrence,h=oe(c,`g${o.multiline?"m":"s"}${o.ignoreCase?"i":""}`);t.patternSpace=h.replace(',
			},
			{
				name: 's with g: the same',
				from: 'let d=oe(c,`g${o.ignoreCase?"i":""}`);t.patternSpace=G9(',
				to: 'let d=oe(c,`g${o.multiline?"m":"s"}${o.ignoreCase?"i":""}`);t.patternSpace=G9(',
			},
			{
				name: 'an address /re/',
				from: 'return oe(o).test(r)}',
				to: 'return oe(/M/.test(e.flags||"")?__lcNl(o):o,(/M/.test(e.flags||"")?"m":"s")+(e.flags||"").replace(/I/g,"i").replace(/M/g,"")).test(r)}',
			},
		],
	},
	{
		id: 'LC-36',
		title: 'the array literal of a declaration (`local a=("$@")`, `declare -a c=($x "${b[@]}")`, `readonly`, `export`) is made of the words the elements expand to, as `a=("$@")` was: each element was expanded to one string (`"$@"` joined, an unquoted `$x` not split or globbed, `("${arr[@]}")` one element), so `local args=("$@"); "${args[@]}"` ran a command named `echo hi there`',
		edits: [
			{
				name: 'the state of the scan: the parts of the element that is being read',
				from: 'p=!1,h=!0,m=E=>{let A=M(E);',
				to: 'p=!1,h=!0,__lcE=[],m=E=>{let A=M(E);',
			},
			{
				name: 'the end of an element: an element that has an expansion in it is expanded as an argument is (several words, none, split, globbed)',
				from: 'b=()=>{g(u,h),u="",f=0,p=!1,h=!0};',
				to: 'b=async()=>{if(__lcE.length>0){u!==""&&__lcE.push({type:"Literal",value:u});let __w=await dr(e,{type:"Word",parts:__lcE});__lcE=[],u="",f=0,p=!1,h=!0;for(let __v of __w.values)g(__v);return}g(u,h),u="",f=0,p=!1,h=!0};',
			},
			{
				name: 'a blank ends the element (the end is awaited now)',
				from: '/\\s/.test(I)?(u||p)&&b():m(I)',
				to: '/\\s/.test(I)?(u||p)&&await b():m(I)',
			},
			{
				name: 'a part that is not text is kept with the element, to be expanded when it ends; the last element is ended with an await',
				from: 'else{(u||p)&&b();let I=await dr(e,{type:"Word",parts:[E]});for(let R of I.values)g(R)}else{(E.type==="SingleQuoted"||E.type==="DoubleQuoted"||E.type==="Escaped")&&(p=!0),h=!1;let A=await Be(e,{type:"Word",parts:[E]});m(A)}(u||p)&&b();let y=l.splice(0)',
				to: 'else{(u||p)&&await b();let I=await dr(e,{type:"Word",parts:[E]});for(let R of I.values)g(R)}else{p=!0,h=!1,u!==""&&(__lcE.push({type:"Literal",value:u}),u="",f=0),__lcE.push(E)}(u||p)&&await b();let y=l.splice(0)',
			},
			{
				name: 'the reader of the elements: a backslash inside single quotes is a backslash (the elements are written in single quotes, and `local a=(\'x\\ny\')` lost it)',
				from: 'if(o){r+=a,o=!1,l=!0;continue}if(a==="\\\\"){o=!0;continue}if(a==="\'"&&!i)',
				to: 'if(o){r+=a,o=!1,l=!0;continue}if(a==="\\\\"&&!s){o=!0;continue}if(a==="\'"&&!i)',
			},
		],
	},
	{
		id: 'LC-37',
		title: 'sed: a `*` that has nothing before it in a basic regular expression (at the start, after `\\(`, after `\\|`, after `^`) is a plain asterisk (`s/*//g` took it for nothing and used the last regular expression), and one in an extended expression (`sed -E \'s/*b/X/\'`) is GNU\'s error: "Invalid preceding regular expression", status 1, where the substitution was silently not made',
		edits: [
			{
				name: 'the basic-to-extended translation: the star that quantifies nothing is escaped',
				from: 'if(!s&&!i){t+="\\\\$",n++;continue}}t+=e[n],n++}return t}',
				to: 'if(!s&&!i){t+="\\\\$",n++;continue}}if(e[n]==="*"&&(t===""||t==="^"||/(^|[^\\\\])[(|]\\^?$/.test(t))){t+="\\\\*",n++;continue}t+=e[n],n++}return t}',
			},
			{
				name: 's: the regular expression is looked at for a quantifier with nothing before it, and the script ends with the message',
				from: 'let c=ku(o.extendedRegex?a:vu(a));try{let u=oe(c,l),f=u.test(t.patternSpace);',
				to: 'let c;try{c=ku(o.extendedRegex?__lcPat(a,!0):vu(__lcPat(a,!1))),o.extendedRegex&&__lcLead(a),o.multiline&&(c=__lcNl(c))}catch(__e){if(__e&&__e.lcRegex){t.errorMessage=`sed: -e expression #1, char ${4+o.pattern.length+o.replacement.length+(o.global?1:0)+(o.printOnMatch?1:0)+(o.ignoreCase?1:0)}: ${__e.message}`,t.quit=!0;break}throw __e}{let __d=__lcRef(o.replacement,a,o.extendedRegex);if(__d){t.errorMessage="sed: -e expression #1, char "+(4+o.pattern.length+o.replacement.length+(o.global?1:0)+(o.printOnMatch?1:0)+(o.ignoreCase?1:0))+": invalid reference \\\\"+__d+" on `s\' command\'s RHS",t.quit=!0;break}}try{let u=oe(c,l),f=u.test(t.patternSpace);',
			},
		],
	},
	{
		id: 'LC-38',
		title: 'awk: the record separator RS is read: one character (`RS=","`, `RS=";"`, `RS="\\0"`), the empty string (paragraphs: records are separated by blank lines), or a regular expression of more than one character (`-v RS=\'[0-9]+\'`); the records were always lines',
		edits: [
			{
				name: 'the input is cut into records by RS (read after BEGIN, where it may be set)',
				from: 'let R=E.split(`\n`);if(R.length>0&&R[R.length-1]===""&&R.pop(),R.length>y)',
				to: 'let R=__lcAwkRecords(E,p.vars.RS);if(R.length>0&&R[R.length-1]===""&&R.pop(),R.length>y)',
			},
		],
	},
	{
		id: 'LC-39',
		title: 'the elements of an array literal in a declaration (`local a=($(cmd))`, `declare -a b=("$(cmd)" "${x:-d}" $((1+2)))`, `readonly`) keep what they expand: the parser wrote the text of each element back with the NAME of a part it had no case for (`CommandSubstitution`, `ArithmeticExpansion`), dropped a command substitution inside double quotes and the operation of `${x:-d}`, `${#a[@]}`, `${@:2}`',
		edits: [
			{
				name: 'an element is written back as the source text of each of its parts',
				from: 'case"Escaped":n+=r.value;break;case"DoubleQuoted":n+=\'"\';for(let s of r.parts)s.type==="Literal"||s.type==="Escaped"?n+=s.value:s.type==="ParameterExpansion"&&(n+=`\\${${s.parameter}}`);n+=\'"\';break;case"ParameterExpansion":n+=`\\${${r.parameter}}`;break;case"Glob":',
				to: 'case"Escaped":n+=Ll(r,!1);break;case"DoubleQuoted":n+=Ll(r,!1);break;case"ParameterExpansion":n+=Ll(r,!1);break;case"Glob":',
			},
			{
				name: 'and a part it knows no case for as its own source text',
				from: 'default:n+=r.type}return n}function ew(',
				to: 'default:n+=Ll(r,!1)}return n}function ew(',
			},
		],
	},
	{
		id: 'LC-40',
		title: 'a command given by a path that is a directory is `bash: /tmp/: Is a directory`, status 126 (it was "Permission denied": `"$dir"/` , `/usr/bin/`, `./src`)',
		edits: [
			{
				name: 'the lookup says why: a directory',
				from: 'try{let l=await e.fs.stat(o);if(l.isDirectory)return{error:"permission_denied",path:o};',
				to: 'try{let l=await e.fs.stat(o);if(l.isDirectory)return{error:"is_directory",path:o};',
			},
			{
				name: 'and the message says it',
				from: 'if("error"in c)return c.error==="permission_denied"?K(`bash: ${t}: Permission denied\n`,126):',
				to: 'if("error"in c)return c.error==="is_directory"?K(`bash: ${t}: Is a directory\n`,126):c.error==="permission_denied"?K(`bash: ${t}: Permission denied\n`,126):',
			},
		],
	},
	{
		id: 'LC-41',
		title: 'sort -V is GNU\'s `filevercmp` (coreutils 8.32): numbers by value with leading zeros ignored, equal numbers by their bytes (`sort -Vu` kept one of `file01.txt` and `file1.txt`), `~` before the end of a name, a letter before any other mark, the file suffix out of the comparison unless the rest is the same, leading dots first; `ls -v` is the same function (compat.js)',
		edits: [
			{
				name: 'the version comparison of two strings',
				from: 'if(n.versionSort)return fS(r,s);',
				to: 'if(n.versionSort)return __lcVer(r,s);',
			},
		],
	},
	{
		id: 'LC-42',
		title: 'find -size counts in whole units, rounded UP, as GNU does: `-size -1M` is the empty files (it was every file under a mebibyte), `-size 2k` is a file of 1025 to 2048 bytes (it was exactly 2048), `-size 1` is one 512-byte block, and `w` (two bytes) is a unit; the size of what `-size +1M` finds is as before',
		edits: [
			{
				name: 'the argument: a unit may be w',
				from: 'let f=u.match(/^(\\d+)([ckMGb])?$/);if(!f)return i(l,a);',
				to: 'let f=u.match(/^(\\d+)([ckMGbw])?$/);if(!f)return i(l,a);',
			},
			{
				name: 'the test: the size in units of the unit, rounded up, against the number',
				from: 'case"size":{let n=e.value;switch(e.unit){case"c":n=e.value;break;case"k":n=e.value*1024;break;case"M":n=e.value*1024*1024;break;case"G":n=e.value*1024*1024*1024;break;case"b":n=e.value*512;break}let r;return e.comparison==="more"?r=t.size>n:e.comparison==="less"?r=t.size<n:e.unit==="b"?r=Math.ceil(t.size/512)===e.value:r=t.size===n,{matches:r,pruned:!1,printed:!1}}',
				to: 'case"size":{let n=Math.ceil(t.size/({c:1,w:2,k:1024,M:1048576,G:1073741824}[e.unit]||512)),r=e.comparison==="more"?n>e.value:e.comparison==="less"?n<e.value:n===e.value;return{matches:r,pruned:!1,printed:!1}}',
			},
		],
	},
	{
		id: 'LC-43',
		title: 'sed: a regular expression that does not compile ends the script with a message and status 1, as GNU\'s does (`sed \'s/\\(a/X/\'`, `sed -E \'s/a{2,1}/X/\'`, `/\\(/p`): the engine swallowed the failure and went on as if nothing had matched, status 0, the line unchanged. A pattern with a back-reference (RE2 has none) says so',
		edits: [
			{
				name: 's: the failure of the compile or the replace ends the script',
				from: 'catch{}break}case"print"',
				to: 'catch(__e){String(__e&&__e.message).startsWith("Invalid regular expression")&&__lcSedFail(t,__e,4+o.pattern.length+o.replacement.length+(o.global?1:0)+(o.printOnMatch?1:0)+(o.ignoreCase?1:0))}break}case"print"',
			},
			{
				name: 'an address /re/: the same',
				from: 'catch{return!1}return!1}function Nu(e){',
				to: 'catch(__e){s&&String(__e&&__e.message).startsWith("Invalid regular expression")&&__lcSedFail(s,__e,e.pattern.length+2);return!1}return!1}function Nu(e){',
			},
		],
	},
	{
		id: 'LC-44',
		title: 'sed -E and -r: an address /re/ is an extended regular expression (the address was always a basic one: `sed -E \'/^(foo|bar)/d\'` deleted nothing, `sed -nE \'/a|b/p\'` printed nothing, and `sed -E \'/a+/p\'` looked for a plus sign)',
		edits: [
			{
				name: 'the address carries the mode the script was parsed in',
				from: 'case ce.PATTERN:return this.advance(),{pattern:t.pattern||t.value};',
				to: 'case ce.PATTERN:return this.advance(),{pattern:t.pattern||t.value,extendedRegex:this.extendedRegex,flags:t.flags||"",end:t.end};',
			},
			{
				name: 'and the match reads it as the s command does',
				from: 'let o=ku(vu(i));',
				to: 'let o=ku(e.extendedRegex?__lcPat(i,!0):vu(__lcPat(i,!1)));',
			},
		],
	},
	{
		id: 'LC-45',
		title: 'sed s: the replacement is read as GNU reads it: `\\\\` is a backslash and what follows is not escaped again (`s/[\\/&]/\\\\&/g`, the idiom that escapes a string for another sed, made `&` of every match: the reader took the pair `\\\\` for one backslash and `\\&` was then a literal ampersand), `\\U \\L \\u \\l \\E` change the case (`s/\\w\\+/\\u&/g`; they were `U` and `L`), and `\\xHH \\oNNN \\dNNN \\cX \\a \\f \\v` are the characters they name',
		edits: [
			{
				name: 'the reader of the replacement keeps the pair `\\\\` (the escapes are read once, where the text is used)',
				from: '(o+=`\n`,this.advance()):o+="\\\\"):a===',
				to: '(o+=`\n`,this.advance()):o+="\\\\\\\\"):a===',
			},
			{
				name: 'the use of the replacement: the header\'s reader (the one of the file stays, unused)',
				from: 'function Iu(e,t,n){let r="",s=0;for(;s<e.length;){',
				to: 'function Iu(e,t,n){return __lcRepl(e,t,n)}function __lcIuOld(e,t,n){let r="",s=0;for(;s<e.length;){',
			},
		],
	},
	{
		id: 'LC-46',
		title: 'sed: a backslash inside a bracket expression is a backslash (POSIX; `s/[\\.]/X/g` and `[^\\]` skipped the backslashes of the text, `[a\\]` was an unterminated command and `\\]` could not end a bracket), `\\n \\t` in it are the control characters, and the `\\oNNN`, `\\dNNN` and `\\cX` of a pattern are the characters they name (RE2 has none of them); `\\/` in a bracket of an s command keeps both characters, as GNU does, and `^` and `$` are anchors next to `\\|` (`s/^a\\|^b/X/`)',
		edits: [
			{
				name: 'the pattern of s: a backslash before the `]` that closes a bracket is the backslash of the set',
				from: 'this.peek()===r&&!i?s+=this.advance():(s+="\\\\",s+=this.advance())',
				to: 'this.peek()===r&&!i?s+=this.advance():(s+="\\\\",i||(s+=this.advance()))',
			},
			{
				name: '`^` is an anchor after `\\|` too (`s/^a\\|^b/X/`: the second `^` was a plain character)',
				from: 'if(e[n]==="^"&&!(t===""||t.endsWith("("))){',
				to: 'if(e[n]==="^"&&!(t===""||t.endsWith("(")||t.endsWith("|")&&!t.endsWith("\\\\|"))){',
			},
			{
				name: 'and `$` before `\\|` is one',
				from: 'i=n+2<e.length&&e[n+1]==="\\\\"&&e[n+2]===")";',
				to: 'i=n+2<e.length&&e[n+1]==="\\\\"&&(e[n+2]===")"||e[n+2]==="|");',
			},
		],
	},
	{
		id: 'LC-47',
		title: 'sed addresses: `\\cREGEXc` with any delimiter (`\\,/usr,d`, `\\#etc#p`: "invalid command: \\"), the flags `I` and `M` after `/re/` (`/error/Ip` was "invalid command: I"), `addr1,~N`, and a range whose end is a regular expression does not look at the line it started on (`1,/e/d` ended at once when line 1 had an e)',
		edits: [
			{
				name: 'the tokens: `~N` after a comma, and `\\cREGEXc` with any delimiter c',
				from: 'r==="+"&&this.isDigit(this.input[this.pos+1]||"")?this.readRelativeOffset():r==="/"?this.readPattern():',
				to: '(r==="+"||r==="~")&&this.isDigit(this.input[this.pos+1]||"")?this.readRelativeOffset():r==="/"?this.readPattern():r==="\\\\"&&this.pos+1<this.input.length&&this.input[this.pos+1]!==`\n`&&this.input[this.pos+1]!=="\\\\"?this.readPattern(!0):',
			},
			{
				name: '`~N` is read with the sign it has',
				from: 'readRelativeOffset(){let t=this.line,n=this.column;this.advance();let r="";for(;this.isDigit(this.peek());)r+=this.advance();let s=parseInt(r,10)||0;return{type:ce.RELATIVE_OFFSET,value:`+${s}`,offset:s,line:t,column:n}}',
				to: 'readRelativeOffset(){let t=this.line,n=this.column,m=this.advance()==="~";let r="";for(;this.isDigit(this.peek());)r+=this.advance();let s=parseInt(r,10)||0;return{type:ce.RELATIVE_OFFSET,value:`+${s}`,offset:m?0:s,multiple:m?s:void 0,line:t,column:n}}',
			},
			{
				name: 'the address regex: any delimiter, the flags I and M, and a backslash before the `]` that closes a bracket',
				from: 'readPattern(){let t=this.line,n=this.column;this.advance();let r="",s=!1;for(;this.pos<this.input.length;){let i=this.peek();if(i==="/"&&!s)break;if(i==="\\\\")r+=this.advance(),this.pos<this.input.length&&this.peek()!==`\n`&&(r+=this.advance());else{if(i===`\n`)break;i==="["&&!s?(s=!0,r+=this.advance(),this.peek()==="^"&&(r+=this.advance()),this.peek()==="]"&&(r+=this.advance())):i==="]"&&s?(s=!1,r+=this.advance()):r+=this.advance()}}return this.peek()==="/"&&this.advance(),{type:ce.PATTERN,value:r,pattern:r,line:t,column:n}}',
				to: 'readPattern(u){let t=this.line,n=this.column,d="/";u?(this.advance(),d=this.advance()):this.advance();let r="",s=!1;for(;this.pos<this.input.length;){let i=this.peek();if(i===d&&!s)break;if(i==="\\\\"){this.advance();if(this.pos<this.input.length&&this.peek()!==`\n`){let c=this.peek();c===d&&d!=="/"&&!s?r+=this.advance():s?r+="\\\\":r+="\\\\"+this.advance()}else this.pos<this.input.length?r+=this.advance():r+="\\\\"}else{if(i===`\n`)break;i==="["&&!s?(s=!0,r+=this.advance(),this.peek()==="^"&&(r+=this.advance()),this.peek()==="]"&&(r+=this.advance())):i==="["&&s&&":.=".includes(this.input[this.pos+1]||"-")?r+=__lcBrk(this):i==="]"&&s?(s=!1,r+=this.advance()):r+=this.advance()}}if(this.peek()!==d)return{type:ce.ERROR,value:"unterminated address regex",line:t,column:this.pos,abs:!0};this.advance();let f="";for(;this.peek()==="I"||this.peek()==="M";)f+=this.advance();return{type:ce.PATTERN,value:r,pattern:r,flags:f,end:this.pos,line:t,column:n}}',
			},
			{
				name: 'the address: `addr,~N`',
				from: 'case ce.RELATIVE_OFFSET:return this.advance(),{offset:t.offset||0};',
				to: 'case ce.RELATIVE_OFFSET:return this.advance(),{offset:t.offset||0,multiple:t.multiple};',
			},
			{
				name: 'and its end is the next multiple of N',
				from: 'return t>=h+l.offset&&(p.active=!1,s.set(d,p)),!0}',
				to: 'return t>=h+__lcOff(l,h)&&(p.active=!1,s.set(d,p)),!0}',
			},
			{
				name: 'and a start that is a multiple runs to the next multiple (GNU: `4,~4` is line 4 to line 8)',
				from: 'l.offset===0&&(p.active=!1,s.set(d,p))',
				to: '__lcOff(l,t)===0&&(p.active=!1,s.set(d,p))',
			},
		],
	},
	{
		id: 'LC-48',
		title: 'sed: the messages of a script that cannot be read are GNU\'s: `-e expression #N, char C: unknown command: `X\'`, `unterminated `s\' command`, `missing command` (the engine said `invalid command: X`, `unterminated substitution pattern`, `command expected`, with no place)',
		edits: [
			{
				name: 'the number of the expression (-e) being read',
				from: 'parse(){let t=[];for(let n of this.scripts){let r=new Oa(n,',
				to: 'parse(){let t=[],__i=0;for(let n of this.scripts){this.__lcK=++__i;let r=new Oa(n,',
			},
			{
				name: 'a `}` that has an address, in a block',
				from: 'case ce.RBRACE:return{command:null};',
				to: 'case ce.RBRACE:return n&&__lcBrace(this)>0?{command:null,error:__lcWhere(this,__lcAbs(this,r),"`}\' doesn\'t want any addresses")}:{command:null};',
			},
			{
				name: 'an unknown command and an unterminated s, as GNU says them, with the expression and the character',
				from: 'case ce.ERROR:return{command:null,error:`invalid command: ${r.value}`};',
				to: 'case ce.ERROR:{let __v=r.value;return{command:null,error:__lcWhere(this,r.abs?r.column:__lcAbs(this,r),__v==="unterminated substitution pattern"?"unterminated `s\' command":__v.length===1?"unknown command: `"+__v+"\'":__v)}}',
			},
			{
				name: 'an s command that ends before its closing delimiter is unterminated',
				from: 'this.peek()===r&&this.advance();let l="";',
				to: 'if(this.peek()!==r)return{type:ce.ERROR,value:"unterminated substitution pattern",line:t,column:this.pos,abs:!0};this.advance();let l="";',
			},
			{
				name: 'y with sets of different lengths',
				from: 'error:"transliteration sets must have same length"',
				to: 'error:__lcWhere(this,(this.scripts[0]||"").length,"strings for `y\' command are different lengths")',
			},
			{
				name: 'the place of the `{` that opens a group is kept (where its "unmatched" is said)',
				from: 'parseGroup(t){this.advance();let n=[];',
				to: 'parseGroup(t){let __b=__lcAbs(this,this.peek());this.advance();let n=[];',
			},
			{
				name: 'an `{` that is never closed',
				from: 'error:"unmatched brace in grouped commands"',
				to: 'error:__lcWhere(this,__b,"unmatched `{\'",1)',
			},
			{
				name: 'a `}` with no `{`',
				from: 'this.pos===s&&!this.isAtEnd())return{commands:[],error:`unknown command: \'${this.peek()?.value??this.peek()?.type}\'`}}}return{commands:t}}parseCommand(){',
				to: 'this.pos===s&&!this.isAtEnd())return{commands:[],error:this.check(ce.RBRACE)?__lcWhere(this,__lcAbs(this,this.peek()),"unexpected `}\'"):__lcUnk(this)}}}return{commands:t}}parseCommand(){',
			},
			{
				name: 'a token that is neither a command nor an address inside a block',
				from: 'this.pos===r&&!this.isAtEnd())return{command:null,error:`unknown command: \'${this.peek()?.value??this.peek()?.type}\'`}}',
				to: 'this.pos===r&&!this.isAtEnd())return{command:null,error:__lcUnk(this)}}',
			},
			{
				name: 'an address with no command',
				from: 'return n&&(n.start!==void 0||n.end!==void 0)?{command:null,error:"command expected"}:{command:null};let r=this.peek();',
				to: 'return n?{command:null,error:__lcWhere(this,(this.scripts[0]||"").length,"missing command")}:{command:null};let r=this.peek();',
			},
			{
				name: 'and one that is followed by something that is not a command',
				from: 'default:return n&&(n.start!==void 0||n.end!==void 0)?{command:null,error:"command expected"}:{command:null}}}parseSimpleCommand(t,n){',
				to: 'default:return n?{command:null,error:__lcUnk(this)}:{command:null}}}parseSimpleCommand(t,n){',
			},
		],
	},
	{
		id: 'LC-49',
		title: 'sed: `s/x/y/2g` replaces the second match and every one after it (the number was ignored: it replaced all of them)',
		edits: [
			{
				name: 's///Ng: the first N-1 matches stay',
				from: '(p,h)=>Iu(o.replacement,p,h))',
				to: '(p,h)=>++__cn.n<(o.nthOccurrence||1)?p:Iu(o.replacement,p,h)),__no=__cn.n<(o.nthOccurrence||1)',
			},
		],
	},
	{
		id: 'LC-50',
		title: 'grep: the pattern is read as GNU reads it before it is translated for RE2: a backslash inside a bracket is a backslash (`grep \'[\\\\.]\'` and `\'[^\\\\]\'`: the second was "invalid regular expression"), in an extended expression a `)` with nothing open is a plain character and a `{` that starts no interval is one, and a pattern that does not compile is said in GNU\'s words with status 2 (`grep: Unmatched ( or \\\\(`)',
		edits: [
			{
				name: 'the expression is read before it is translated: a backslash in a bracket is a backslash, a `)` with nothing open and a `{` that starts no interval are plain characters in an extended one',
				from: 'function mi(e,t){let n,r;switch(t.mode){',
				to: 'function mi(e,t){t.mode!=="fixed"&&t.mode!=="perl"&&(e=__lcPat(e,t.mode==="extended",!0));let n,r;switch(t.mode){',
			},
			{
				name: 'a pattern that does not compile is said in GNU\'s words (`Unmatched ( or \\(`)',
				from: 'catch{return{stdout:"",stderr:`grep: invalid regular expression: ${A.join(`\n`)}\n`,exitCode:2}}',
				to: 'catch(__e){return{stdout:"",stderr:`grep: ${__lcReMsg(__e)}\n`,exitCode:2}}',
			},
			{
				name: 'and one of several patterns the same',
				from: 'catch{return{stdout:"",stderr:`grep: invalid regular expression: ${ie}\n`,exitCode:2}}',
				to: 'catch(__e){return{stdout:"",stderr:`grep: ${__lcReMsg(__e,ie)}\n`,exitCode:2}}',
			},
		],
	},
	{
		id: 'LC-51',
		title: 'sed: `q5` and `Q5` quit with that exit status (the number was an address with no command: "missing command")',
		edits: [
			{
				name: 'q and Q read the exit status after them (`q5`, `Q 3`)',
				from: 'case"F":return{type:ce.COMMAND,value:r,line:t,column:n};case"v":return this.readVersion(t,n);',
				to: 'case"F":return((__x)=>({type:ce.COMMAND,value:r,exitCode:__x,line:t,column:n}))(r==="q"||r==="Q"||r==="l"?(()=>{let k=this.pos;for(;this.input[k]===" "||this.input[k]==="\\t";)k++;if(!this.isDigit(this.input[k]||""))return;for(;this.pos<k;)this.advance();let d="";for(;this.isDigit(this.peek());)d+=this.advance();return parseInt(d,10)})():void 0);case"v":return this.readVersion(t,n);',
			},
			{
				name: 'and the command carries it (the executor had it)',
				from: 'case"q":return{command:{type:"quit",address:n}};case"Q":return{command:{type:"quitSilent",address:n}};',
				to: 'case"q":return{command:{type:"quit",address:n,exitCode:t.exitCode}};case"Q":return{command:{type:"quitSilent",address:n,exitCode:t.exitCode}};',
			},
		],
	},
	{
		id: 'LC-52',
		title: 'what a command writes to `/dev/stderr` or `/dev/stdout` (`awk \'{print > "/dev/stderr"}\'`, `tee /dev/stderr`) is part of its own output: `2>/dev/null`, `2>&1` and a pipe apply to it (it was added to the output of the whole statement, after everything)',
		edits: [
			{
				name: 'a command is marked in the device buffers before it runs',
				from: 'try{let S=()=>rn(i.requireDefenseContext,"command",`${t} execution`,',
				to: 'try{let __m=i.fs&&i.fs.__lcMark&&i.fs.__lcMark(),S=()=>rn(i.requireDefenseContext,"command",`${t} execution`,',
			},
			{
				name: 'and its result takes what it wrote to /dev/stdout and /dev/stderr since',
				from: ',E=()=>LT(S,w,x,t,i.executionScope,i.state.signal),A=u.trusted?await St.runTrustedAsync(E):await E();return{...A,internalStdinConsumed:A.internalStdinConsumed??(p?r.length:0)}',
				to: ',E=()=>LT(S,w,x,t,i.executionScope,i.state.signal),A=u.trusted?await St.runTrustedAsync(E):await E();return{...__lcDev(A,i.fs,__m),internalStdinConsumed:A.internalStdinConsumed??(p?r.length:0)}',
			},
		],
	},
	{
		id: 'LC-53',
		title: 'awk: `split(s, a)` and `split(s, a, " ")` ignore the blanks at the ends and an empty string has no elements, `length(array)` counts, `int(-3.9)` is -3, `%e` and `%g` have two digits of exponent, a one-character FS (`-F\'|\'`, `-F.`) is that character, `FS=""` is a field for each character, assigning NF rebuilds `$0`, `print > $1 ".txt"` names a file by the whole expression, and `print | "sort"` is a pipe whose command runs at `close()` or the end (it was a syntax error)',
		edits: [
			{
				name: 'assigning NF always rebuilds $0 (also to the number it has)',
				from: 'else if(r>e.NF){for(;e.fields.length<r;)e.fields.push("");e.line=e.fields.join(e.OFS)}e.NF=r;return}',
				to: 'else{for(;e.fields.length<r;)e.fields.push("");e.line=e.fields.join(e.OFS)}e.NF=r;return}',
			},
			{
				name: 'int() truncates toward zero',
				from: 'return e.length===0?0:Math.floor(Un(await n.evalExpr(e[0])))}async function mE',
				to: 'return e.length===0?0:Math.trunc(Un(await n.evalExpr(e[0])))}async function mE',
			},
			{
				name: 'split: the separator " " (also the default) is runs of blanks with the ends ignored',
				from: 'let i=s.name,o=t.FS;if(e.length>=3){',
				to: 'let i=s.name,o=t.FS,__w=e.length<3&&t.FS===" ";if(e.length>=3){',
			},
			{
				name: '(the separator given)',
				from: 'o=f===" "?oe("\\\\s+"):f}}else t.FS===" "&&(o=oe("\\\\s+"));',
				to: 'f===" "&&(__w=!0),o=f===" "?oe("\\\\s+"):f}}else t.FS===" "&&(o=oe("\\\\s+"));',
			},
			{
				name: 'and an empty string has no elements',
				from: 'c=typeof o=="string"?r.split(o,a+1):o.split(r,a+1);if(c.length>a)',
				to: 'c=r===""?[]:__w?__lcWs(r,a+1):typeof o=="string"?r.split(o,a+1):o.split(r,a+1);if(c.length>a)',
			},
			{
				name: '%e: the exponent has two digits at least',
				from: 'let S=w.toExponential(x);if(g==="E"&&(S=S.toUpperCase()),f){',
				to: 'let S=w.toExponential(x).replace(/e([+-])(\\d)$/,(m,a,b)=>"e"+a+"0"+b);if(g==="E"&&(S=S.toUpperCase()),f){',
			},
			{
				name: '%g: the same',
				from: 'E=w.toExponential(x-1),g==="G"&&(E=E.toUpperCase())',
				to: 'E=w.toExponential(x-1).replace(/e([+-])(\\d)$/,(m,a,b)=>"e"+a+"0"+b),g==="G"&&(E=E.toUpperCase())',
			},
			{
				name: 'FS of one character is that character (`|`, `.`), whatever it means in a regular expression: -F',
				from: 'if(/[[\\](){}.*+?^$|\\\\]/.test(e))try{return oe(e)}catch{return oe(b0(e))}return oe(b0(e))}',
				to: 'if(e.length>1&&/[[\\](){}.*+?^$|\\\\]/.test(e))try{return oe(e)}catch{return oe(b0(e))}return oe(b0(e))}',
			},
			{
				name: 'and FS=',
				from: 'else try{e.fieldSep=oe(t)}catch{e.fieldSep=oe(t.replace(',
				to: 'else try{e.fieldSep=oe(t.length===1?t.replace(/[.*+?^${}()|[\\]\\\\]/g,"\\\\$&"):t)}catch{e.fieldSep=oe(t.replace(',
			},
			{
				name: 'FS="" is one field for each character',
				from: 'function Ym(e,t){return t===""?[]:e.FS===" "?',
				to: 'function Ym(e,t){return t===""?[]:e.FS===""?Array.from(t):e.FS===" "?',
			},
			{
				name: 'print > expr: the file name is a concatenation (`print > "out_" $1 ".txt"`), and `print | "cmd"` is a pipe',
				from: 'return e.check(le.GT)?(e.advance(),n={redirect:">",file:e.parsePrimary()}):e.check(le.APPEND)&&(e.advance(),n={redirect:">>",file:e.parsePrimary()}),{type:"print",args:t,output:n}}',
				to: 'return e.check(le.GT)?(e.advance(),n={redirect:">",file:__lcRedir(e)}):e.check(le.APPEND)?(e.advance(),n={redirect:">>",file:__lcRedir(e)}):e.check(le.PIPE)&&(e.advance(),n={redirect:"|",file:__lcRedir(e)}),{type:"print",args:t,output:n}}',
			},
			{
				name: '(printf the same)',
				from: 'return e.check(le.GT)?(e.advance(),s={redirect:">",file:e.parsePrimary()}):e.check(le.APPEND)&&(e.advance(),s={redirect:">>",file:e.parsePrimary()}),{type:"printf",format:n,args:r,output:s}}',
				to: 'return e.check(le.GT)?(e.advance(),s={redirect:">",file:__lcRedir(e)}):e.check(le.APPEND)?(e.advance(),s={redirect:">>",file:__lcRedir(e)}):e.check(le.PIPE)&&(e.advance(),s={redirect:"|",file:__lcRedir(e)}),{type:"printf",format:n,args:r,output:s}}',
			},
			{
				name: 'a write to a pipe is kept until close() or the end, then the command runs with it as its input',
				from: 'async function i0(e,t,n,r){rr(e,"file write execution");',
				to: 'async function i0(e,t,n,r){if(t==="|"){await __lcPipe(e,n,r);return}rr(e,"file write execution");',
			},
			{
				name: 'the command gets its input',
				from: 'exec:d?b=>n("command pipe exec",()=>d(b,{cwd:t.cwd,signal:t.signal})):void 0',
				to: 'exec:d?(b,__i)=>n("command pipe exec",()=>d(b,{cwd:t.cwd,signal:t.signal,...__i===void 0?{}:{stdin:__i}})):void 0',
			},
			{
				name: 'close(command) runs it now',
				from: '["close",()=>0]',
				to: '["close",async(e,t,n)=>{if(e.length===0)return 0;let c=jt(await n.evalExpr(e[0])),m=t.__lcPipes;if(m&&m.has(c)){let x=m.get(c);m.delete(c);t.__lcF=t.output.length;await __lcRun(t,c,x)}return 0}]',
			},
			{
				name: 'and what is still open runs at the end',
				from: 'this.ctx.inEndBlock=!1}}getOutput(){',
				to: 'this.ctx.inEndBlock=!1}await __lcFlush(this.ctx)}getOutput(){',
			},
			{
				name: 'what a command of a pipe wrote to its standard error is the standard error of awk (also for a program with no END)',
				from: 'return await n("END execution after BEGIN exit",()=>h.executeEnd()),{stdout:h.getOutput(),stderr:"",exitCode:h.getExitCode()};if(!m&&!g)return{stdout:h.getOutput(),stderr:"",exitCode:h.getExitCode()};',
				to: 'return await n("END execution after BEGIN exit",()=>h.executeEnd()),{stdout:h.getOutput(),stderr:p.__lcErr||"",exitCode:h.getExitCode()};if(!m&&!g)return await __lcFlush(p),{stdout:h.getOutput(),stderr:p.__lcErr||"",exitCode:h.getExitCode()};',
			},
			{
				name: '(the end of a run)',
				from: 'return await n("END execution",()=>h.executeEnd()),{stdout:h.getOutput(),stderr:"",exitCode:h.getExitCode()}}catch(b)',
				to: 'return await n("END execution",()=>h.executeEnd()),{stdout:h.getOutput(),stderr:p.__lcErr||"",exitCode:h.getExitCode()}}catch(b)',
			},
			{
				name: '%g: the zeros of the exponent are not trailing zeros',
				from: 'E.includes(".")&&(E=E.replace(/\\.?0+$/,"").replace(/\\.?0+e/,"e")),E.includes("e")&&(E=E.replace(/\\.?0+e/,"e")),f){',
				to: 'E.includes("e")?E=E.replace(/\\.?0+e/,"e"):E.includes(".")&&(E=E.replace(/\\.?0+$/,"")),f){',
			},
		],
	},
	{
		id: 'LC-54',
		title: 'find -printf: `%y %H %u %g %U %G %n %l %b %k` and the conversions of a time GNU has (`%T@` and `%TT` with the ten digits of fraction, `%t`, `%Tc %TD %Ty %Te %Tj %Ta %TA %Tb %TB %TR %Tp %TI`): they were printed as written (`%y`)',
		edits: [
			{
				name: '-printf: the type (`%y`), the starting point (`%H`), the owner and the group (`%u %g %U %G`), the links (`%n`), a link\'s target (`%l`), the blocks (`%b` of 512, `%k` of 1024, in the 4 KiB blocks the shell\'s `du` has), and `%t` with its fraction',
				from: 'case"t":{let u=new Date(t.mtime);c=j5(u),s++;break}case"T":',
				to: 'case"t":{let u=new Date(t.mtime);c=j5(u).replace(/(\\d\\d:\\d\\d:\\d\\d) /,"$1."+__lcFrac(t.mtime)+" "),s++;break}case"y":c=t.isDirectory?"d":"f",s++;break;case"H":c=t.startingPoint,s++;break;case"u":case"g":c="user",s++;break;case"U":case"G":c="1000",s++;break;case"n":c=t.isDirectory?"2":"1",s++;break;case"l":c="",s++;break;case"b":c=String(Math.ceil(t.size/4096)*8),s++;break;case"k":c=String(Math.ceil(t.size/4096)*4),s++;break;case"T":',
			},
			{
				name: '-printf: the fraction GNU prints with `%T@`, `%TS`, `%TT`, and the rest of the conversions of a time (`%Tc %TD %Ty %Te %Tj %Ta %TA %Tb %TB %TR %Tp %TI %Tu %Tw`)',
				from: 'function q5(e,t){switch(t){case"@":return String(e.getTime()/1e3);',
				to: 'function q5(e,t){switch(t){case"@":return Math.floor(e.getTime()/1e3)+"."+__lcFrac(e.getTime());case"c":return j5(e);case"D":return String(e.getMonth()+1).padStart(2,"0")+"/"+String(e.getDate()).padStart(2,"0")+"/"+String(e.getFullYear()%100).padStart(2,"0");case"y":return String(e.getFullYear()%100).padStart(2,"0");case"e":return String(e.getDate()).padStart(2," ");case"j":return String(Math.floor((Date.UTC(e.getFullYear(),e.getMonth(),e.getDate())-Date.UTC(e.getFullYear(),0,1))/864e5)+1).padStart(3,"0");case"a":return["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][e.getDay()];case"A":return["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"][e.getDay()];case"b":case"h":return["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][e.getMonth()];case"B":return["January","February","March","April","May","June","July","August","September","October","November","December"][e.getMonth()];case"R":return String(e.getHours()).padStart(2,"0")+":"+String(e.getMinutes()).padStart(2,"0");case"p":return e.getHours()<12?"AM":"PM";case"I":return String(e.getHours()%12||12).padStart(2,"0");case"u":return String(e.getDay()||7);case"w":return String(e.getDay());case"n":return"\\n";case"t":return"\\t";',
			},
			{
				name: '`%TT` has the fraction of the seconds too',
				from: 'case"S":return String(e.getSeconds()).padStart(2,"0");case"T":return`${String(e.getHours()).padStart(2,"0")}:${String(e.getMinutes()).padStart(2,"0")}:${String(e.getSeconds()).padStart(2,"0")}`;',
				to: 'case"S":return String(e.getSeconds()).padStart(2,"0")+"."+__lcFrac(e.getTime());case"T":return`${String(e.getHours()).padStart(2,"0")}:${String(e.getMinutes()).padStart(2,"0")}:${String(e.getSeconds()).padStart(2,"0")}.${__lcFrac(e.getTime())}`;',
			},
			{
				name: 'the size is looked up for `%b` and `%k` too',
				from: 'return/%[-+]?[0-9]*\\.?[0-9]*(s|m|M|t|T)/.test(O)}',
				to: 'return/%[-+]?[0-9]*\\.?[0-9]*(s|m|M|t|T|b|k)/.test(O)}',
			},
		],
	},
	{
		id: 'LC-55',
		title: 'printf: an escape in the format that makes a `%` (`printf \'\\045s\'`, `\'\\x25d\'`) is a percent sign and nothing more: the escapes were read first and the result then read for directives (`\\045s` was an error and `\\045d` printed 0)',
		edits: [
			{
				name: 'the format of printf: an escape that makes a `%` (`\\045`, `\\x25`) is a plain percent sign, not the start of a directive',
				from: 'l=da(s,o),a="",c=0,u=0,f=!1,d="",',
				to: 'l=da(__lcPct(s),o),a="",c=0,u=0,f=!1,d="",',
			},
		],
	},
	{
		id: 'LC-56',
		title: 'sed: the grammar of a script is read as GNU reads it: a command is followed by `;`, a newline, `}` or the end (`sed \'p x\'`, `\'dp\'`, `\'{p}p\'`: "extra characters after command", the engine ran both), an `s` flag that is not one is "unknown option to `s\'" (`s/a/b/gx` ran an `x`), blanks between the flags are skipped (`s/a/b/ p` is `s/a/b/p`), a class or collating element in a bracket (`[[:alpha:]/]`, `[[.].]/]`) does not end it, a regular expression that is not closed is "unterminated address regex", line address 0 is for `0,/re/` only, a label that is not there is "can\'t find label for jump to `x\'" with status 4, a bracket written `[:space:]` is GNU\'s "character class syntax is [[:space:]], not [:space:]" (status 4 in sed, 2 in grep), and every regular expression of the script is compiled when the script is read, so an invalid one is said before any line is read, in a command that never runs and at the end of a range',
		edits: [
			{
				name: 'an s pattern: a class, collating or equivalence element in a bracket does not end it',
				from: 'a==="]"&&i?(i=!1,s+=this.advance()):s+=this.advance()}}',
				to: 'a==="["&&i&&":.=".includes(this.input[this.pos+1]||"-")?s+=__lcBrk(this):a==="]"&&i?(i=!1,s+=this.advance()):s+=this.advance()}}',
			},
			{
				name: 'the top level: a command is followed by a separator',
				from: 'let s=this.pos,i=this.parseCommand();if(i.error)return{commands:[],error:i.error};',
				to: 'let s=this.pos,i=this.parseCommand(),__x;if(i.error)return{commands:[],error:i.error};if(__x=__lcXtra(this,s))return{commands:[],error:__x};',
			},
			{
				name: 'and inside a block',
				from: 'let r=this.pos,s=this.parseCommand();if(s.error)return{command:null,error:s.error};',
				to: 'let r=this.pos,s=this.parseCommand(),__x;if(s.error)return{command:null,error:s.error};if(__x=__lcXtra(this,r))return{command:null,error:__x};',
			},
			{
				name: 'y: what follows its last delimiter',
				from: '{type:ce.ERROR,value:"extra text at the end of a transform command",line:t,column:n}',
				to: '{type:ce.ERROR,value:"extra characters after command",line:t,column:this.pos+1,abs:!0}',
			},
			{
				name: 'a label that is not there',
				from: 'if(n)return`undefined label \'${n}\'`',
				to: 'if(n)return"can\'t find label for jump to "+String.fromCharCode(96)+n+"\'"',
			},
			{
				name: 'the script is compiled when it is read, and what GNU says is said before any line',
				from: 'let c=X9(a.commands);',
				to: 'let c=__lcChk(a.commands,i.map(x=>x.length))||X9(a.commands);',
			},
			{
				name: 'an s whose pattern is not closed says where the script ended',
				from: 'if(this.peek()!==r)return{type:ce.ERROR,value:"unterminated substitution pattern",line:t,column:n};this.advance();let o="";',
				to: 'if(this.peek()!==r)return{type:ce.ERROR,value:"unterminated substitution pattern",line:t,column:this.pos,abs:!0};this.advance();let o="";',
			},
			{
				name: 'y that is not closed (source) is unterminated, at the end of the script',
				from: '{type:ce.ERROR,value:"unterminated transliteration source",line:t,column:n}',
				to: '{type:ce.ERROR,value:"unterminated `y\' command",line:t,column:Math.min(this.pos,this.input.length),abs:!0,part:"source"}',
			},
			{
				name: 'y that is not closed (dest) is unterminated, at the end of the script',
				from: '{type:ce.ERROR,value:"unterminated transliteration dest",line:t,column:n}',
				to: '{type:ce.ERROR,value:"unterminated `y\' command",line:t,column:Math.min(this.pos,this.input.length),abs:!0,part:"dest"}',
			},
			{
				name: 'the pattern of s: a backslash before a newline is the newline',
				from: ':s+="\\\\";else{if(a===`\n`)break;a==="["&&!i?(i=!0,',
				to: ':this.pos<this.input.length?s+=this.advance():s+="\\\\";else{if(a===`\n`)break;a==="["&&!i?(i=!0,',
			},
			{
				name: 'what follows an address: line address 0 is for `0,/re/` only (said before anything else of the command), `!` with no address negates "every line" (the command is never run), a second `!`, and a `;` or a newline right after an address or a `!` are errors, as GNU has them (the end of an expression, `-e 1 -e p`, is a missing command)',
				from: 'for(this.check(ce.NEGATION)&&(this.advance(),n&&(n.negated=!0));this.check(ce.NEWLINE)||this.check(ce.SEMICOLON);)this.advance();',
				to: 'let __t0=this.peek();if(n&&n.start===0&&!(n.end&&typeof n.end=="object"&&"pattern"in n.end))return{command:null,error:__lcWhere(this,__lcAt(this,__t0),"invalid usage of line address 0")};if(this.check(ce.NEGATION)){this.advance(),n?n.negated=!0:n={start:-1};if(this.check(ce.NEGATION))return{command:null,error:__lcWhere(this,__lcAbs(this,this.peek()),"multiple `!\'s")}}if(n&&(this.check(ce.NEWLINE)||this.check(ce.SEMICOLON)))return{command:null,error:__lcAfter(this,this.peek())};for(;this.check(ce.NEWLINE)||this.check(ce.SEMICOLON);)this.advance();',
			},
			{
				name: 'an address range: a `,` with nothing before it is an unknown command, one with no address after it is "unexpected `,\'", a `+N` or `~N` is not a first address, and an address needs a comma before its end (`1+2p` is an address and an unknown command `+\'`)',
				from: 'parseAddressRange(){if(this.check(ce.COMMA))return{error:"expected context address"};let t=this.parseAddress();if(t===void 0)return;let n;if(this.check(ce.RELATIVE_OFFSET))n={offset:this.advance().offset||0};else if(this.check(ce.COMMA)&&(this.advance(),n=this.parseAddress(),n===void 0))return{error:"expected context address"};',
				to: 'parseAddressRange(){if(this.check(ce.COMMA))return;let __k=this.peek(),t=this.parseAddress();if(t===void 0)return;if(typeof t=="object"&&"offset"in t){let a=__lcAbs(this,__k);return{error:__lcWhere(this,a-1+/^[+~]\\d*/.exec((this.scripts[0]||"").slice(a-1))[0].length,"invalid usage of +N or ~N as first address")}}let n;if(this.check(ce.COMMA)&&(this.advance(),n=this.parseAddress(),n===void 0))return{error:__lcWhere(this,__lcAt(this,this.peek()),"unexpected `,\'")};',
			},
			{
				name: 'the lengths of the expressions (-e) are known to the parser, which says `#N, char C` as GNU counts them',
				from: 'a=new Tu([o],t||s,n).parse();',
				to: 'a=((__t)=>(__t.__lcP=i.map(x=>x.length),__t.parse()))(new Tu([o],t||s,n));',
			},
			{
				name: 'the status of the two messages that are not about an expression',
				from: 'if(u)return{stdout:"",stderr:`sed: ${u}\n`,exitCode:1};let d=!!(i||f);',
				to: 'if(u)return{stdout:"",stderr:`sed: ${u}\n`,exitCode:/^(can\'t find label|character class syntax)/.test(u)?4:1};let d=!!(i||f);',
			},
		],
	},
	{
		id: 'LC-57',
		title: 'sed: `s/x/y/N` and `s/x/y/Ng` when the line has fewer than N matches change nothing: no `p` print, `t` does not branch (the engine counted a line that has any match as substituted)',
		edits: [
			{
				name: 'the count of matches is kept, and the substitution is not "made" when the N-th is not there',
				from: 'if(u.lastIndex=0,f){if(t.substitutionMade=!0,o.nthOccurrence&&o.nthOccurrence>0&&!o.global){let d=0,',
				to: 'if(u.lastIndex=0,f){let __sm=t.substitutionMade,__no=!1,__cn={n:0};if(t.substitutionMade=!0,o.nthOccurrence&&o.nthOccurrence>0&&!o.global){let d=0,',
			},
			{
				name: 's///N: the N-th was not there',
				from: 'return Iu(o.replacement,m,b)}return m})}else if(o.global){',
				to: 'return Iu(o.replacement,m,b)}return m}),__no=d<p}else if(o.global){',
			},
		],
	},
	{
		id: 'LC-58',
		title: 'sed (basic expressions): `{` and `}` are plain characters (`s/a{1}/X/` made an interval of the extended expression it is translated to, so `a{2}` in the text was not found and `a` was)',
		edits: [
			{
				name: 'the basic-to-extended translation escapes a brace that is not `\\{` or `\\}`',
				from: 'if(e[n]==="+"||e[n]==="?"||e[n]==="|"||e[n]==="("||e[n]===")"){t+=`\\\\${e[n]}`,n++;continue}',
				to: 'if(e[n]==="+"||e[n]==="?"||e[n]==="|"||e[n]==="("||e[n]===")"||e[n]==="{"||e[n]==="}"){t+=`\\\\${e[n]}`,n++;continue}',
			},
		],
	},
	{
		id: 'LC-59',
		title: 'sed `l`: the output is GNU\'s: bytes (a character that is not ASCII is its UTF-8 bytes in octal, `\\\\303\\\\251`, and a byte that is not text is its own `\\\\377`: the engine printed the code point, or the surrogate it keeps such a byte in, as `\\\\156377`), and a line is wrapped at 70 characters with a `\\\\` (`l N` wraps at N, `l 0` does not): the engine printed the whole line',
		edits: [
			{
				name: 'the command carries its line length',
				from: 'case"l":return{command:{type:"list",address:n}};',
				to: 'case"l":return{command:{type:"list",address:n,width:t.exitCode}};',
			},
			{
				name: 'and the listing is made by LevelCode\'s own function',
				from: 'case"list":{let o=Tm(t.patternSpace);',
				to: 'case"list":{let o=__lcList(t.patternSpace,e.width);',
			},
		],
	},
	{
		id: 'LC-60',
		title: 'date: a year before 1000 is written with four digits by `%Y`, `%F` and `%G` (`date -d 0100-01-02 +%F` printed `100-01-02`, GNU `0100-01-02`)',
		edits: [
			{
				name: '`%F` writes a year before 1000 with four digits',
				from: 'case"F":return`${t.year}-${s(t.month)}-${s(t.day)}`;',
				to: 'case"F":return`${__lcY4(t.year)}-${s(t.month)}-${s(t.day)}`;',
			},
			{
				name: '`%G` the same',
				from: 'case"G":return String(Ph(t.year,t.month,t.day));',
				to: 'case"G":return __lcY4(Ph(t.year,t.month,t.day));',
			},
			{
				name: '`%Y` the same',
				from: 'case"Y":return String(t.year);case"z":return Y8(e,r)',
				to: 'case"Y":return __lcY4(t.year);case"z":return Y8(e,r)',
			},
			{
				name: 'the ISO year of a date before the year 100 (`new Date(6, ...)` is 1906)',
				from: 'function Ph(e,t,n){let r=new Date(e,t-1,n,12,0,0);',
				to: 'function Ph(e,t,n){let r=new Date(2e3,0,1,12,0,0);r.setFullYear(e,t-1,n);',
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
