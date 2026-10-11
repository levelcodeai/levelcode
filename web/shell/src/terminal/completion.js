// Tab completion for the line editor: which word is under the cursor, what to ask the session for, and how a
// candidate is written back into the line. Pure of vscode; the session is passed in.
//
// The session answers with names (session.complete): command names for the first word of a command, and for any
// other word the entries of the directory the typed prefix points into, keeping what was typed before the name and
// ending a folder with '/'. What this module adds is the shell's part: the word is read the way the shell reads it
// (quotes and backslashes), and a candidate is written back quoted or escaped so the line still means what it says.
// @ts-check
'use strict';

/** Words after which the next word is a command again. */
const COMMAND_WORDS = new Set(['if', 'then', 'else', 'elif', 'do', 'while', 'until', 'time', '!', '{']);
/** Characters that need a backslash in an unquoted word, wherever they are. */
const ALWAYS_SPECIAL = /[\s"'\\$`&|;()<>*?[\]{}]/;
/** Characters that need one only at the start of a word. */
const START_SPECIAL = /[~#!^]/;
const CONTROL = /[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/;

/**
 * The word the cursor is in (or the empty word it is about to start).
 * @param {string} line
 * @param {number} cursor  in code points
 * @returns {{ start: number, prefix: string, quote: '' | '"' | "'", kind: 'command' | 'path' }}
 */
function wordAt(line, cursor) {
	const chars = Array.from(line).slice(0, cursor);
	const n = chars.length;
	let start = 0;
	let inWord = false;
	let prefix = '';
	let quote = /** @type {'' | '"' | "'"} */ ('');
	let cmdPos = true;          // the word being read is the first of a command
	let redirect = false;       // the word being read is the target of > or <

	const begin = (/** @type {number} */ i) => {
		if (!inWord) { inWord = true; start = i; }
	};

	for (let i = 0; i < n; i++) {
		const c = chars[i];
		if (quote === "'") {
			if (c === "'") { quote = ''; } else { prefix += c; }
			continue;
		}
		if (quote === '"') {
			if (c === '\\' && i + 1 < n && '"\\$`'.includes(chars[i + 1])) { prefix += chars[++i]; } else if (c === '"') { quote = ''; } else { prefix += c; }
			continue;
		}
		if (c === '\\') {
			begin(i);
			if (i + 1 < n) { prefix += chars[++i]; }
			continue;
		}
		if (c === "'" || c === '"') { begin(i); quote = c; continue; }
		if (c === ' ' || c === '\t' || c === '\n') {
			if (inWord) {
				if (cmdPos && !redirect && !COMMAND_WORDS.has(prefix)) { cmdPos = false; }
				redirect = false;
			}
			inWord = false;
			prefix = '';
			continue;
		}
		if (c === ';' || c === '|' || c === '&' || c === '(') {
			inWord = false;
			prefix = '';
			cmdPos = true;
			redirect = false;
			continue;
		}
		if (c === '<' || c === '>') {
			inWord = false;
			prefix = '';
			redirect = true;
			continue;
		}
		begin(i);
		prefix += c;
	}
	if (!inWord) { start = n; prefix = ''; }
	const kind = cmdPos && !redirect && !prefix.includes('/') && !/^[.~]/.test(prefix) ? 'command' : 'path';
	return { start, prefix, quote, kind };
}

/**
 * A name written back into the line.
 * @param {string} name  as the file system has it
 * @param {'' | '"' | "'"} quote  the quote the word is inside, if any
 * @param {boolean} dir  a folder keeps the word open: no closing quote, so the next name can follow
 */
function writeBack(name, quote, dir) {
	if (quote === "'") { return "'" + name.replace(/'/g, "'\\''") + (dir ? '' : "'"); }
	if (quote === '"') { return '"' + name.replace(/["\\$`]/g, '\\$&') + (dir ? '' : '"'); }
	let out = '';
	let i = 0;
	for (const ch of name) {
		out += ALWAYS_SPECIAL.test(ch) || (i === 0 && START_SPECIAL.test(ch)) ? '\\' + ch : ch;
		i++;
	}
	return out;
}

/**
 * The editor's completion hook, over a session.
 * @param {{ complete(kind: 'path' | 'command', prefix: string): Promise<string[]> }} session
 * @param {{ forTerminal(text: string, o?: { crlf?: boolean }): string }} sanitize
 * @returns {(line: string, cursor: number) => Promise<{ start: number, candidates: Array<{ text: string, display: string, dir: boolean }> } | null>}
 */
function createCompleter(session, sanitize) {
	return async function complete(line, cursor) {
		const w = wordAt(line, cursor);
		if (w.kind === 'command' && w.prefix === '') { return null; }          // Tab on an empty line lists nothing
		let names;
		try { names = await session.complete(w.kind, w.prefix); } catch (e) { return null; }
		if (!Array.isArray(names)) { return null; }
		const seen = new Set();
		const candidates = [];
		for (const name of names) {
			if (typeof name !== 'string' || name === '' || CONTROL.test(name) || seen.has(name)) { continue; }
			// a candidate must continue what was typed
			if (!name.startsWith(w.prefix)) { continue; }
			seen.add(name);
			const dir = name.endsWith('/');
			candidates.push({ text: writeBack(name, w.quote, dir), display: sanitize.forTerminal(name), dir });
		}
		if (!candidates.length) { return null; }
		// The word as typed begins with its own opening quote; the candidates repeat it, so replace from the word start.
		return { start: w.start, candidates };
	};
}

module.exports = { wordAt, writeBack, createCompleter };
