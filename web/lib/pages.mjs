// How Cloudflare Pages answers a request for a release (scripts/build-web.mjs), for web/serve.mjs --pages. A release
// that only ever ran under serve.mjs's plain file server went live on Pages without its terminal: Pages had never
// been sent the client's node_modules, and answered every one of those scripts with the page. This is what Pages
// does differently from a plain file server, so a release can be checked the way it will be served there.
//
//   1. What `wrangler pages deploy` does not upload is not there: any path with a segment named node_modules or .git,
//      .DS_Store, and _worker.js, _redirects, _headers, _routes.json and functions/ at the root (its IGNORE_LIST, in
//      workers-sdk packages/wrangler/src/pages/validate.ts). Symbolic links are skipped too.
//   2. _redirects comes first, whatever the files: the first rule that matches applies. 200 serves another path of the
//      site in place (a rewrite); 301, 302, 303, 307 and 308 redirect. `:name` stands for one segment, `*` for the rest.
//   3. An .html address is redirected to the same address without it (/a.html -> /a, /x/index.html -> /x/), and
//      /a serves a.html, /x/ serves x/index.html.
//   4. An address that matches no file is answered with /index.html and 200 (what Pages does when there is no
//      404.html): a missing script comes back as the page, which is the failure this is here to show.
// Pure: no file system access. Callers say whether a path exists.

/**
 * The release's own answer to (1) for the client's node_modules (scripts/build-web.mjs): the same files are staged
 * again under this name, and _redirects serves them from there at the address the client asks for.
 */
export const NODE_MODULES_COPY = 'node-modules';

/** The release's _redirects. One rule for every build folder (:id), so a previous build kept online is served too. */
export function toRedirectsFile() {
	return `/_/:id/static/node_modules/* /_/:id/static/${NODE_MODULES_COPY}/:splat 200\n`;
}

/** Is this path (relative to the release, `/`-separated) one that `wrangler pages deploy` uploads? */
export function uploaded(rel) {
	const parts = rel.split('/').filter(Boolean);
	if (parts.some((p) => p === 'node_modules' || p === '.git' || p === '.DS_Store')) { return false; }
	if (parts.length === 1 && ['_worker.js', '_redirects', '_headers', '_routes.json'].includes(parts[0])) { return false; }
	return parts[0] !== 'functions';
}

/**
 * The rules of a _redirects file, in order: `from to [status]`, blank lines and `#` comments skipped.
 * @param {string} text
 * @returns {Array<{ from: string, to: string, status: number }>}
 */
export function parseRedirects(text) {
	const rules = [];
	for (const line of text.split('\n')) {
		const t = line.trim();
		if (!t || t.startsWith('#')) { continue; }
		const [from, to, status] = t.split(/\s+/);
		if (from && to) { rules.push({ from, to, status: status ? Number(status) : 302 }); }
	}
	return rules;
}

/**
 * The first rule that matches `pathname`, with its destination filled in, or null.
 * @param {Array<{ from: string, to: string, status: number }>} rules
 * @param {string} pathname
 * @returns {{ to: string, status: number } | null}
 */
export function matchRedirect(rules, pathname) {
	for (const r of rules) {
		const names = [];
		const pattern = r.from.split('/').map((seg, i, all) => {
			if (seg === '*' && i === all.length - 1) { names.push('splat'); return '(.*)'; }
			if (seg.startsWith(':')) { names.push(seg.slice(1)); return '([^/]+)'; }
			return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		}).join('/');
		const m = new RegExp('^' + pattern + '$').exec(pathname);
		if (!m) { continue; }
		const values = Object.fromEntries(names.map((n, i) => [n, m[i + 1]]));
		const to = r.to.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, (all, n) => (n in values ? values[n] : all));
		return { to, status: r.status };
	}
	return null;
}

/**
 * What Pages does with an address before it looks for a file: redirect an .html one, or name the file an
 * extensionless one stands for.
 * @param {string} pathname
 * @param {(rel: string) => boolean} isFile  is there an uploaded file at this release-relative path?
 * @returns {{ redirect: string } | { file: string } | null}  null: no such page; serve the fallback
 */
export function resolvePage(pathname, isFile) {
	if (pathname.endsWith('/index.html')) { return { redirect: pathname.slice(0, -'index.html'.length) }; }
	if (pathname.endsWith('.html') && isFile(pathname.slice(1))) { return { redirect: pathname.slice(0, -'.html'.length) }; }
	const rel = pathname.slice(1);
	if (pathname.endsWith('/')) { return isFile(rel + 'index.html') ? { file: rel + 'index.html' } : null; }
	if (isFile(rel)) { return { file: rel }; }
	if (isFile(rel + '.html')) { return { file: rel + '.html' }; }
	return null;
}
