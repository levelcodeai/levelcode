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

	dirname(p) {
		assertPath(p);
		if (p.length === 0) { return '.'; }
		let end = p.length;
		while (end > 1 && p[end - 1] === '/') { end--; }          // trailing slashes do not count
		const i = p.lastIndexOf('/', end - 1);
		if (i === -1) { return '.'; }
		if (i === 0) { return '/'; }
		let j = i;
		while (j > 1 && p[j - 1] === '/') { j--; }                // collapse the slashes before the name
		return p.slice(0, j);
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

	extname(p) {
		const base = path.basename(p);
		const i = base.lastIndexOf('.');
		return i <= 0 ? '' : base.slice(i);
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

	parse(p) {
		assertPath(p);
		const root = p[0] === '/' ? '/' : '';
		const base = path.basename(p);
		const ext = path.extname(p);
		let dir = path.dirname(p);
		if (dir === '.' && !p.startsWith('.')) { dir = ''; }
		return { root, dir, base, ext, name: ext ? base.slice(0, -ext.length) : base };
	},

	format(o) {
		const dir = o.dir || o.root || '';
		const base = o.base || (o.name || '') + (o.ext || '');
		if (!dir) { return base; }
		return dir === o.root ? dir + base : dir + '/' + base;
	},
};

path.posix = path;
path.win32 = path;
module.exports = path;
