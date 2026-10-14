// Tab completion for the line editor: which word is under the cursor, what to ask the session for, and how a
// candidate is written back into the line. Pure of vscode; the session is passed in.
//
// The session answers with names (session.complete): command names for the first word of a command, and for any
// other word the entries of the directory the typed prefix points into, keeping what was typed before the name and
// ending a folder with '/'. What this module adds is the shell's part: the word is read the way the shell reads it
// (quotes and backslashes), and a candidate is written back quoted or escaped so the line still means what it says.
// Tab inside a word (something after the cursor) offers only names that end with the rest of the word, and such a name
// replaces the whole word, its closing quote too: what was after the cursor is never dropped, split off or left over.
// @ts-check
'use strict';

const { cleanText } = require('./line-editor');

/** Words after which the next word is a command again. */
const COMMAND_WORDS = new Set(['if', 'then', 'else', 'elif', 'do', 'while', 'until', 'time', '!', '{']);
/** A word that assigns a variable (`NAME=`, `NAME+=`, `NAME[i]=`, the name as typed: unquoted): before the command it is not one. */
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?\+?=/;
/** A word of digits written against `<` or `>` is the descriptor it redirects (`2>err`), not a word of the command. */
const DESCRIPTOR = /^[0-9]+$/;
/** What ends a word that is not quoted or escaped. */
const WORD_END = /[ \t\n;|&()<>`]/;
/** Characters that need a backslash in an unquoted word, wherever they are. */
const ALWAYS_SPECIAL = /[\s"'\\$`&|;()<>*?[\]{}]/;
/** Characters that need one only at the start of a word. */
const START_SPECIAL = /[~#!^]/;
const CONTROL = /[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/;

/**
 * The word the cursor is in (or the empty word it is about to start), and the rest of it after the cursor.
 * @param {string} line
 * @param {number} cursor  in code points
 * @returns {{ start: number, prefix: string, quote: '' | '"' | "'", kind: 'command' | 'path', end: number, rest: string }}
 *   `end` is where the word ends after the cursor, and `rest` what it holds there (unquoted, as `prefix` is)
 */
function wordAt(line, cursor) {
	const all = Array.from(line);
	const chars = all.slice(0, cursor);
	const n = chars.length;
	let start = 0;
	let inWord = false;
	let prefix = '';
	let quote = /** @type {'' | '"' | "'"} */ ('');
	let escaped = false;        // the last character before the cursor is a backslash: it escapes the one after it
	let cmdPos = true;          // the word being read is the first of a command
	let redirect = false;       // the word being read is the target of > or <
	let opAt = -2;              // where the last `<` or `>` is: `>&`, `<&` and `>|` are one operator with it

	const begin = (/** @type {number} */ i) => {
		if (!inWord) { inWord = true; start = i; }
	};
	// The word that ends at `i`. The first word of a command takes the command position with it; the target of a
	// redirection, a keyword (`if`, `!`) and an assignment before the command (`LC_ALL=C`) do not.
	const endWord = (/** @type {number} */ i) => {
		if (inWord) {
			if (cmdPos && !redirect && !COMMAND_WORDS.has(prefix) && !ASSIGNMENT.test(chars.slice(start, i).join(''))) { cmdPos = false; }
			redirect = false;
		}
		inWord = false;
		prefix = '';
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
			if (i + 1 < n) { prefix += chars[++i]; } else { escaped = true; }
			continue;
		}
		if (c === "'" || c === '"') { begin(i); quote = c; continue; }
		if (c === ' ' || c === '\t') { endWord(i); continue; }
		if ((c === '&' || c === '|') && opAt === i - 1) { continue; }        // `>&2`, `<&0`, `>|`: the rest of the operator
		if (c === '&' && all[i + 1] === '>') { endWord(i); continue; }      // `&>`, `&>>`: a redirection, not a list
		if (c === ';' || c === '|' || c === '&' || c === '(' || c === '\n') {
			// the end of a command (a line end too, when it is not quoted or escaped): what follows is a command again
			inWord = false;
			prefix = '';
			cmdPos = true;
			redirect = false;
			continue;
		}
		if (c === '<' || c === '>') {
			if (inWord && !redirect && DESCRIPTOR.test(chars.slice(start, i).join(''))) {
				inWord = false;
				prefix = '';
			} else {
				endWord(i);                                                  // `cat>out`: `cat` is the command
			}
			redirect = true;
			opAt = i;
			continue;
		}
		begin(i);
		prefix += c;
	}
	if (!inWord) { start = n; prefix = ''; }
	const kind = cmdPos && !redirect && !prefix.includes('/') && !/^[.~]/.test(prefix) ? 'command' : 'path';

	// The rest of the word, read the same way, from the quote the cursor is in. A cursor that is not in a word (after a
	// blank, at the start of the line) starts a new one: what follows it is another word, not the rest of this one.
	let q = quote;
	let rest = '';
	let k = n;
	if (escaped && k < all.length) { rest += all[k++]; }
	for (; inWord && k < all.length; k++) {
		const c = all[k];
		if (q === "'") {
			if (c === "'") { q = ''; } else { rest += c; }
			continue;
		}
		if (q === '"') {
			if (c === '\\' && k + 1 < all.length && '"\\$`'.includes(all[k + 1])) { rest += all[++k]; } else if (c === '"') { q = ''; } else { rest += c; }
			continue;
		}
		if (c === '\\') {
			if (k + 1 < all.length) { rest += all[++k]; }
			continue;
		}
		if (c === "'" || c === '"') { q = c; continue; }
		if (WORD_END.test(c)) { break; }
		rest += c;
	}
	return { start, prefix, quote, kind, end: k, rest };
}

/**
 * Does `name` hold the whole word: what was typed before the cursor at its start and what is after it at its end, apart
 * (a folder's name with or without its '/')?
 * @param {string} name @param {string} prefix @param {string} rest
 */
function fits(name, prefix, rest) {
	if (rest === '') { return true; }
	const base = name.endsWith('/') && !rest.endsWith('/') ? name.slice(0, -1) : name;
	return base.length >= prefix.length + rest.length && base.endsWith(rest);
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
 * @returns {(line: string, cursor: number) => Promise<{ start: number, candidates: Array<{ text: string, display: string, dir: boolean, end?: number }> } | null>}
 *   a candidate with an `end` replaces the word up to there, past the cursor; one without, up to the cursor
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
			// a candidate must continue what was typed, and end with what the word has after the cursor
			if (!name.startsWith(w.prefix) || !fits(name, w.prefix, w.rest)) { continue; }
			seen.add(name);
			const dir = name.endsWith('/');
			// A folder at the end of the word is left open for the next name; anything else is written whole and replaces
			// the rest of the word (a closing quote after the cursor, the end of a name typed earlier).
			const open = dir && w.rest === '';
			const text = writeBack(name, w.quote, open);
			// The editor types only what the screen shows: a name it would type without one of its characters (a zero-width
			// space) is another file's name, so it is not offered.
			if (cleanText(text).cps.join('') !== text) { continue; }
			/** @type {{ text: string, display: string, dir: boolean, end?: number }} */
			const candidate = { text, display: sanitize.forTerminal(name), dir };
			if (!open && w.end > cursor) { candidate.end = w.end; }
			candidates.push(candidate);
		}
		if (!candidates.length) { return null; }
		// The word as typed begins with its own opening quote; the candidates repeat it, so replace from the word start.
		return { start: w.start, candidates };
	};
}

module.exports = { wordAt, writeBack, createCompleter };
