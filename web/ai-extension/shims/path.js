// POSIX `path` for the browser build of the extension. The editor's browser workspaces are
// URI paths ("/src/a.js"), so only the posix flavour exists here. Behaviour follows Node's
// path.posix for the members the extension uses; test/webShims.test.js compares them to Node's.
'use strict';

function assertPath(p) { if (typeof p !== 'string') { throw new TypeError('The "path" argument must be of type string. Received ' + typeof p); } }

/** Resolve '.' and '..' segments. `allowAboveRoot` keeps leading '..' for relative paths. */
function normalizeString(p, allowAboveRoot) {
	const out = [];
	for (const seg of p.split('/')) {
		if (seg === '' || seg === '.') { continue; }
		if (seg === '..') {
			if (out.length && out[out.length - 1] !== '..') { out.pop(); }
			else if (allowAboveRoot) { out.push('..'); }
			continue;
		}
		out.push(seg);
	}
	return out.join('/');
}

const path = {
	sep: '/',
	delimiter: ':',

	isAbsolute(p) { assertPath(p); return p.length > 0 && p[0] === '/'; },

	normalize(p) {
		assertPath(p);
		if (p.length === 0) { return '.'; }
		const abs = p[0] === '/';
		const trailing = p[p.length - 1] === '/';
		let out = normalizeString(p, !abs);
		if (out.length === 0) { if (abs) { return '/'; } return trailing ? './' : '.'; }
		if (trailing) { out += '/'; }
		return abs ? '/' + out : out;
	},

	join(...parts) {
		const nonEmpty = [];
		for (const a of parts) { assertPath(a); if (a.length) { nonEmpty.push(a); } }
		if (!nonEmpty.length) { return '.'; }
		return path.normalize(nonEmpty.join('/'));
	},

	resolve(...parts) {
		let resolved = '';
		let abs = false;
		for (let i = parts.length - 1; i >= -1 && !abs; i--) {
			const p = i >= 0 ? parts[i] : '/';
			assertPath(p);
			if (p.length === 0) { continue; }
			resolved = p + '/' + resolved;
			abs = p[0] === '/';
		}
		resolved = normalizeString(resolved, !abs);
		return abs ? '/' + resolved : (resolved.length ? resolved : '.');
	},

	// Node's scan, so odd inputs ('a//b' is 'a/', '//x' is '//') are answered as Node answers them.
	dirname(p) {
		assertPath(p);
		if (p.length === 0) { return '.'; }
		const hasRoot = p[0] === '/';
		let end = -1;
		let matchedSlash = true;
		for (let i = p.length - 1; i >= 1; --i) {
			if (p[i] === '/') {
				if (!matchedSlash) { end = i; break; }
			} else { matchedSlash = false; }
		}
		if (end === -1) { return hasRoot ? '/' : '.'; }
		if (hasRoot && end === 1) { return '//'; }
		return p.slice(0, end);
	},

	basename(p, ext) {
		assertPath(p);
		let end = p.length;
		while (end > 1 && p[end - 1] === '/') { end--; }
		if (p === '/' || end === 0) { return ''; }
		const start = p.lastIndexOf('/', end - 1) + 1;
		let base = p.slice(start, end);
		if (ext && base.endsWith(ext) && base !== ext) { base = base.slice(0, -ext.length); }
		return base;
	},

	// Node's own scan, so '..', '.', '.hidden', 'a.' and '..x' all come out as they do there.
	extname(p) {
		assertPath(p);
		let startDot = -1;
		let startPart = 0;
		let end = -1;
		let matchedSlash = true;
		let preDotState = 0;   // 0: no char before the dot yet, 1: only dots, -1: some other char
		for (let i = p.length - 1; i >= 0; --i) {
			const ch = p[i];
			if (ch === '/') {
				if (!matchedSlash) { startPart = i + 1; break; }
				continue;
			}
			if (end === -1) { matchedSlash = false; end = i + 1; }
			if (ch === '.') {
				if (startDot === -1) { startDot = i; } else if (preDotState !== 1) { preDotState = 1; }
			} else if (startDot !== -1) { preDotState = -1; }
		}
		if (startDot === -1 || end === -1 || preDotState === 0 || (preDotState === 1 && startDot === end - 1 && startDot === startPart + 1)) { return ''; }
		return p.slice(startDot, end);
	},

	relative(from, to) {
		assertPath(from); assertPath(to);
		if (from === to) { return ''; }
		const f = path.resolve(from).split('/').filter(Boolean);
		const t = path.resolve(to).split('/').filter(Boolean);
		let i = 0;
		while (i < f.length && i < t.length && f[i] === t[i]) { i++; }
		return [...f.slice(i).map(() => '..'), ...t.slice(i)].join('/');
	},

	// Node's scan, as for extname.
	parse(p) {
		assertPath(p);
		const ret = { root: '', dir: '', base: '', ext: '', name: '' };
		if (p.length === 0) { return ret; }
		const isAbs = p[0] === '/';
		const start = isAbs ? 1 : 0;
		if (isAbs) { ret.root = '/'; }
		let startDot = -1, startPart = 0, end = -1, matchedSlash = true, preDotState = 0;
		for (let i = p.length - 1; i >= start; --i) {
			const ch = p[i];
			if (ch === '/') {
				if (!matchedSlash) { startPart = i + 1; break; }
				continue;
			}
			if (end === -1) { matchedSlash = false; end = i + 1; }
			if (ch === '.') {
				if (startDot === -1) { startDot = i; } else if (preDotState !== 1) { preDotState = 1; }
			} else if (startDot !== -1) { preDotState = -1; }
		}
		if (end !== -1) {
			const from = startPart === 0 && isAbs ? 1 : startPart;
			if (startDot === -1 || preDotState === 0 || (preDotState === 1 && startDot === end - 1 && startDot === startPart + 1)) {
				ret.base = ret.name = p.slice(from, end);
			} else {
				ret.name = p.slice(from, startDot);
				ret.base = p.slice(from, end);
				ret.ext = p.slice(startDot, end);
			}
		}
		if (startPart > 0) { ret.dir = p.slice(0, startPart - 1); } else if (isAbs) { ret.dir = '/'; }
		return ret;
	},

	format(o) {
		const dir = o.dir || o.root;
		const ext = o.ext ? (o.ext[0] === '.' ? o.ext : '.' + o.ext) : '';
		const base = o.base || `${o.name || ''}${ext}`;
		if (!dir) { return base; }
		return dir === o.root ? `${dir}${base}` : `${dir}/${base}`;
	},
};

path.posix = path;
path.win32 = path;
module.exports = path;
