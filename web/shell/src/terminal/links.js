// File links in the terminals of LevelCode Shell: `src/a.js`, `src/a.js:12`, `src/a.js:12:5` and `(src/a.js:12)` in
// what a terminal shows become links that open the file at that line and column.
//
// This is the ONLY file-link path: the workbench's own file links are switched off for the browser edition
// (`terminal.integrated.enableFileLinks: off`), because its resolver stats paths through the extension host for every
// word that could be one and has no idea of the engine's working folder.
//
// What makes a link, in order (each rule was chosen against a false positive that a terminal full of command output
// actually has):
//   1. a run of characters that may be in a path (not blanks, quotes, brackets, `: ; , | * ? \ =`), optionally followed
//      by `:line` or `:line:col`, that does not start in the middle of something else: not after a path character,
//      `:` (so `https://x/y.js`, `C:/x/y.js` and `a:b.js` are not read), `\` (a Windows path) or `~`;
//   2. trailing dots are not part of the path (`see src/a.js.`);
//   3. it looks like a path: it has a `/`, or an extension, or a `:line` after it; it has a letter (not `12:30`); it
//      does not start with `~` (the shell's HOME is not the workspace);
//   4. it EXISTS, as a file, relative to the working folder of the terminal it is in. That is the check that makes
//      everything above safe to be generous with, and it is bounded: at most MAX_STATS distinct paths per line, and
//      the answers are waited for at most STAT_MS. A line that cannot be checked in time has no links.
// Words that are neither (`Makefile`, `LICENSE`) are linked only with a `:line`; a folder is not linked.
//
// The text of a link is the terminal's output, so everything about it is untrusted: it is only ever used as a path
// relative to a mount, resolved with `..` first, and the tooltip is a constant.
// @ts-check
'use strict';

/** At most this many distinct paths of one line are asked for. */
const MAX_STATS = 5;
/** How long the answers are waited for, in all. */
const STAT_MS = 500;
/** Longer lines are scanned for their first part only. */
const MAX_LINE = 4000;
/** More candidates than this on one line are not considered. */
const MAX_CANDIDATES = 100;
/** A run of characters longer than this is not a path (a minified line, a base64 blob). */
const MAX_PATH = 1024;
/** vscode.FileType.File */
const FILE = 1;

// leftmost-longest runs of path characters; the lookbehind keeps a match from starting inside another token
const TOKEN = /(?<![\w./~@:+\\-])[^\s"'`<>()[\]{}|;,:*?\\=]+(?::([0-9]{1,7})(?::([0-9]{1,7}))?)?/gu;
const EXTENSION = /\.[A-Za-z][A-Za-z0-9]{0,15}$/;
const HAS_LETTER = /\p{L}/u;

/**
 * The candidates of a line: where they are, the path as written, and the line and column if there were any. A pure
 * function (the existence check comes after).
 * @param {string} text
 * @returns {Array<{ startIndex: number, length: number, path: string, line: number | null, col: number | null }>}
 */
function findCandidates(text) {
	const s = text.length > MAX_LINE ? text.slice(0, MAX_LINE) : text;
	/** @type {Array<{ startIndex: number, length: number, path: string, line: number | null, col: number | null }>} */
	const out = [];
	TOKEN.lastIndex = 0;
	let m;
	while ((m = TOKEN.exec(s)) !== null && out.length < MAX_CANDIDATES) {
		const whole = m[0];
		const hasLine = m[1] !== undefined;
		const written = hasLine ? whole.slice(0, whole.indexOf(':')) : whole;
		// the dots that end a sentence are not the path's (`see src/a.js.`); with a `:line` after them it is not a path
		const path = written.replace(/\.+$/, '');
		if (path !== written && hasLine) { continue; }
		if (path === '' || path.length > MAX_PATH || /^\.+$/.test(path) || path[0] === '~') { continue; }
		if (!HAS_LETTER.test(path)) { continue; }
		if (!hasLine && !path.includes('/') && !EXTENSION.test(path)) { continue; }
		out.push({
			startIndex: m.index,
			length: hasLine ? whole.length : path.length,        // `:line:col` is part of the link
			path,
			line: hasLine ? Math.max(1, Number(m[1])) : null,
			col: m[2] !== undefined ? Math.max(1, Number(m[2])) : null,
		});
	}
	return out;
}

/** An absolute posix path with `.` and `..` resolved. @param {string} cwd @param {string} p */
function resolvePath(cwd, p) {
	/** @type {string[]} */ const out = [];
	for (const seg of (p[0] === '/' ? p : cwd + '/' + p).split('/')) {
		if (seg === '' || seg === '.') { continue; }
		if (seg === '..') { out.pop(); continue; }
		out.push(seg);
	}
	return '/' + out.join('/');
}

/**
 * The provider for vscode.window.registerTerminalLinkProvider.
 * @param {{
 *   vscode: any,
 *   mounts: () => Array<{ mount: string, uri: string }>,
 *   cwdOf: (terminal: any) => string | undefined,
 *   setTimeout?: (fn: () => void, ms: number) => any,
 *   clearTimeout?: (h: any) => void,
 * }} deps
 *   mounts: where each workspace folder is in the engine, as runtime.planMounts says;
 *   cwdOf: the working folder (an engine path) of a terminal that is one of ours, undefined for any other terminal.
 */
function createLinkProvider(deps) {
	const vscode = deps.vscode;
	const setTimer = deps.setTimeout || ((/** @type {() => void} */ fn, /** @type {number} */ ms) => setTimeout(fn, ms));
	const clearTimer = deps.clearTimeout || ((/** @type {any} */ h) => clearTimeout(h));

	/** The Uri of an engine path, or null when it is in no mount. @param {string} abs */
	function toUri(abs) {
		/** @type {{ mount: string, uri: string } | null} */
		let best = null;
		for (const m of deps.mounts()) {
			const inside = abs === m.mount || abs.startsWith(m.mount === '/' ? '/' : m.mount + '/');
			if (inside && (!best || m.mount.length > best.mount.length)) { best = m; }
		}
		if (!best) { return null; }
		let base;
		try { base = vscode.Uri.parse(best.uri); } catch (e) { return null; }
		const bp = base.path.endsWith('/') ? base.path.slice(0, -1) : base.path;
		return base.with({ path: (bp + (abs === best.mount ? '' : abs.slice(best.mount === '/' ? 0 : best.mount.length))) || '/' });
	}

	/** Whether the uri is a file; false for anything else, an error included. @param {any} uri @returns {Promise<boolean>} */
	async function isFile(uri) {
		try {
			const st = await vscode.workspace.fs.stat(uri);
			return (st.type & FILE) !== 0;
		} catch (e) {
			return false;
		}
	}

	return {
		/**
		 * @param {{ line: string, terminal: any }} context
		 * @param {{ isCancellationRequested?: boolean }} [token]
		 */
		async provideTerminalLinks(context, token) {
			const cwd = deps.cwdOf(context.terminal);
			if (typeof cwd !== 'string' || typeof context.line !== 'string') { return []; }
			const candidates = findCandidates(context.line);
			if (candidates.length === 0) { return []; }

			// one stat per distinct path of the line, the first MAX_STATS of them
			/** @type {Map<string, { uri: any, ok: Promise<boolean> }>} */
			const asked = new Map();
			for (const c of candidates) {
				const abs = resolvePath(cwd, c.path);
				if (asked.has(abs) || asked.size >= MAX_STATS) { continue; }
				const uri = toUri(abs);
				if (uri) { asked.set(abs, { uri, ok: isFile(uri) }); }
			}
			if (asked.size === 0) { return []; }

			/** @type {Map<string, boolean>} */
			const exists = new Map();
			let timer;
			await Promise.race([
				Promise.all(Array.from(asked, async ([abs, a]) => { exists.set(abs, await a.ok); })),
				new Promise((resolve) => { timer = setTimer(() => resolve(undefined), STAT_MS); }),
			]);
			clearTimer(timer);
			if (token && token.isCancellationRequested) { return []; }

			const links = [];
			for (const c of candidates) {
				const abs = resolvePath(cwd, c.path);
				const a = asked.get(abs);
				if (!a || exists.get(abs) !== true) { continue; }
				links.push({ startIndex: c.startIndex, length: c.length, tooltip: 'Open in the editor', uri: a.uri, line: c.line, col: c.col });
			}
			return links;
		},

		/** @param {{ uri: any, line: number | null, col: number | null }} link */
		async handleTerminalLink(link) {
			const line = (link.line === null ? 1 : link.line) - 1;
			const col = (link.col === null ? 1 : link.col) - 1;
			const at = new vscode.Position(line, col);
			try {
				await vscode.window.showTextDocument(link.uri, { selection: new vscode.Range(at, at) });
			} catch (e) {
				// a file that is not text, or that went away: the workbench's own message is the better answer
				try { await vscode.commands.executeCommand('vscode.open', link.uri); } catch (e2) { /* nothing to show */ }
			}
		},
	};
}

module.exports = { createLinkProvider, findCandidates, resolvePath, MAX_STATS, STAT_MS };
