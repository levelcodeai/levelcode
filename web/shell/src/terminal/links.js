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
//   4. it EXISTS, as a file, relative to the working folder the line was printed in (line-log.js remembers it; a line
//      it has not seen is resolved against the folder the terminal is in now). That is the check that makes
//      everything above safe to be generous with, and it is bounded: at most MAX_STATS distinct paths per line, each in
//      the folder the line was printed in first and in the folder the command began in only if it is not there, and the
//      answers are waited for at most STAT_MS in all. A line that cannot be checked in time has no links for the rest.
// Words that are neither (`Makefile`, `LICENSE`) are linked only with a `:line`; a folder is not linked.
//
// The text of a link is the terminal's output, so everything about it is untrusted: it is only ever used as a path
// relative to a mount, resolved with `..` first, and the tooltip is a constant.
// @ts-check
'use strict';

/** At most this many distinct paths of one line are asked for (each in at most the folders the line may be about). */
const MAX_STATS = 5;
/** How long the answers are waited for, in all. */
const STAT_MS = 500;
/** Longer lines are scanned for their first part only; a word the cut goes through is not read. */
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
/** What ends a word of TOKEN (the characters it does not take, but ':', which can go on with `:line`). */
const ENDS_WORD = /[\s"'`<>()[\]{}|;,*?\\=]/;

/**
 * The candidates of a line: where they are, the path as written, and the line and column if there were any. A pure
 * function (the existence check comes after).
 * @param {string} text
 * @returns {Array<{ startIndex: number, length: number, path: string, line: number | null, col: number | null }>}
 */
function findCandidates(text) {
	const cut = text.length > MAX_LINE;
	const s = cut ? text.slice(0, MAX_LINE) : text;
	/** @type {Array<{ startIndex: number, length: number, path: string, line: number | null, col: number | null }>} */
	const out = [];
	TOKEN.lastIndex = 0;
	let m;
	while ((m = TOKEN.exec(s)) !== null && out.length < MAX_CANDIDATES) {
		const whole = m[0];
		// a word that the cut went through is half a word, and half of `src/a.js` is another file's name
		if (cut && m.index + whole.length >= s.length && !ENDS_WORD.test(text[MAX_LINE])) { break; }
		const hasLine = m[1] !== undefined;
		const written = hasLine ? whole.slice(0, whole.indexOf(':')) : whole;
		// the dots that end a sentence are not the path's (`see src/a.js.`); with a `:line` after them it is not a path
		let end = written.length;
		while (end > 0 && written.charCodeAt(end - 1) === 46) { end--; }     // a loop: /\.+$/ is quadratic in a run of dots
		const path = written.slice(0, end);
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
 *   resolve: (path: string) => any,
 *   stat: (path: string) => Promise<{ type: string } | null>,
 *   cwdsOf: (terminal: any, line: string) => string[] | undefined,
 *   setTimeout?: (fn: () => void, ms: number) => any,
 *   clearTimeout?: (h: any) => void,
 * }} deps
 *   resolve, stat: the runtime's own (runtime.resolve, runtime.stat): the workspace Uri behind an engine path, or null
 *     when it is in no mount; and what is at it, `{ type: 'file' | 'dir', size }`, or null when nothing is, when it is
 *     in no mount or when the file system did not answer in time. The mounts are the runtime's business;
 *   cwdsOf: the working folders (engine paths, the likeliest first) a line of a terminal that is one of ours was
 *     printed in; undefined for any other terminal, which is not looked at at all.
 */
function createLinkProvider(deps) {
	const vscode = deps.vscode;
	const setTimer = deps.setTimeout || ((/** @type {() => void} */ fn, /** @type {number} */ ms) => setTimeout(fn, ms));
	const clearTimer = deps.clearTimeout || ((/** @type {any} */ h) => clearTimeout(h));

	/** The Uri of an engine path, or null when it is in no mount. @param {string} abs */
	function uriOf(abs) {
		try { return deps.resolve(abs) || null; } catch (e) { return null; }
	}

	/** Whether there is a file at the path; false for anything else, an error included. @param {string} abs @returns {Promise<boolean>} */
	async function isFile(abs) {
		try {
			const st = await deps.stat(abs);
			return !!st && st.type === 'file';
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
			if (typeof context.line !== 'string') { return []; }
			const known = deps.cwdsOf(context.terminal, context.line);
			const cwds = Array.isArray(known) ? known.filter((c) => typeof c === 'string') : [];
			if (cwds.length === 0) { return []; }
			const candidates = findCandidates(context.line);
			if (candidates.length === 0) { return []; }

			// Where each candidate may be: in the folder the line was printed in, then in the one the command began in (a
			// path in no mount is nowhere, and costs nothing). The budget is for DISTINCT paths, not for the places they are
			// looked for in: two spellings of one file are one path, and so is a path asked for in both folders.
			/** @type {Map<string, { places: string[] }>} */
			const paths = new Map();
			/** @type {Array<{ c: ReturnType<typeof findCandidates>[number], places: string[] }>} */
			const plan = [];
			for (const c of candidates) {
				/** @type {string[]} */
				const places = [];
				for (const cwd of cwds) {
					const abs = resolvePath(cwd, c.path);
					if (uriOf(abs)) { places.push(abs); }
				}
				if (places.length === 0) { continue; }
				const key = places.join('\0');
				if (!paths.has(key)) {
					if (paths.size >= MAX_STATS) { continue; }
					paths.set(key, { places });
				}
				plan.push({ c, places });
			}
			if (plan.length === 0) { return []; }

			// One round per folder: every path in the first folder, and then in the next only the ones that were not there.
			// The answers are waited for STAT_MS in all, whatever the number of rounds.
			/** @type {Map<string, boolean>} */
			const exists = new Map();
			let timedOut = false;
			let timer;
			const clock = new Promise((resolve) => { timer = setTimer(() => { timedOut = true; resolve(undefined); }, STAT_MS); });
			for (let round = 0; round < cwds.length && !timedOut; round++) {
				/** @type {Map<string, Promise<void>>} */
				const asked = new Map();
				for (const slot of paths.values()) {
					if (slot.places.some((p) => exists.get(p) === true)) { continue; }
					const abs = slot.places[round];
					if (abs === undefined || exists.has(abs) || asked.has(abs)) { continue; }
					asked.set(abs, isFile(abs).then((ok) => { exists.set(abs, ok); }));
				}
				if (asked.size === 0) { break; }
				await Promise.race([Promise.all(asked.values()), clock]);
			}
			clearTimer(timer);
			if (token && token.isCancellationRequested) { return []; }

			const links = [];
			for (const { c, places } of plan) {
				// the first folder that has it: the folder the line was printed in, then the one the command began in
				const abs = places.find((p) => exists.get(p) === true);
				const uri = abs === undefined ? null : uriOf(abs);
				if (!uri) { continue; }
				links.push({ startIndex: c.startIndex, length: c.length, tooltip: 'Open in the editor', uri, line: c.line, col: c.col });
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

module.exports = { createLinkProvider, findCandidates, resolvePath, MAX_STATS, STAT_MS, MAX_LINE };
