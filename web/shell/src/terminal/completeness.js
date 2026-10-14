// Is this text a whole command, or does the shell want more lines? Pure.
//
// The editor asks this when Enter is pressed: an incomplete line gets a newline and the continuation prompt instead
// of being run. There is nothing to ask the engine: the browser build of just-bash has no parse export, and even the
// Node build's parse() accepts a trailing backslash, an unterminated here-doc and a trailing `|` or `&&`. So this
// module is the only implementation, and it is deliberately NOT a parser. It tracks what a shell lexer tracks
// (quotes, comments, expansions, here-documents, reserved words at command position) and answers one question.
//
// The rule that decides every doubtful case: a line that is wrong is better run (the engine reports the syntax
// error) than held back, because "incomplete" costs the visitor a stuck prompt that only Ctrl+C leaves. So a stray
// `fi`, `)`, `}` or `done`, an `esac` that closes the wrong thing, and an operator in a place no shell allows all
// count as complete.
//
// Incomplete (`reason`): quote dquote backtick subst ($( ) arith param (${ ) heredoc backslash (a trailing \)
// operator (a trailing | && || |&) if loop case brace paren array cond.
// A backslash-newline at the very end is NOT incomplete: the next line, left empty, ends the command (as in bash).
// @ts-check
'use strict';

const BAIL = { bail: true };
/**
 * How deep expansions and command substitutions may nest before the line is given up on as complete (run, so that the
 * engine reports it). A level of `$(` counts 2 (the expansion and its command list), so 99 of them are followed.
 * Every level is a few JavaScript frames, and a paste can carry 50,000 of them: the recursion would overflow the stack
 * at a depth that depends on the browser, and Enter would silently do nothing.
 */
const MAX_DEPTH = 200;

/** @typedef {{ complete: boolean, reason: string }} Completeness */

/** @param {string} c */
const isMeta = (c) => c === ' ' || c === '\t' || c === '\n' || c === ';' || c === '&' || c === '|' || c === '<' || c === '>' || c === '(' || c === ')';

/**
 * @param {string} src
 * @returns {Completeness}
 */
function isComplete(src) {
	const s = String(src);
	const n = s.length;
	let i = 0;
	/** @type {Array<{ delim: string, strip: boolean }>} */
	const heredocs = [];
	let depth = 0;

	/** @param {string} reason */
	const incomplete = (reason) => ({ complete: false, reason });

	/**
	 * Reads the bodies of the pending here-documents; i is just after the newline that starts the first one.
	 * @returns {boolean} false when the input ended before every delimiter was found
	 */
	function readHeredocs() {
		while (heredocs.length) {
			const h = /** @type {{ delim: string, strip: boolean }} */ (heredocs.shift());
			for (;;) {
				if (i >= n) { return false; }
				let e = s.indexOf('\n', i);
				const last = e === -1;
				if (last) { e = n; }
				let line = s.slice(i, e);
				if (h.strip) { line = line.replace(/^\t+/, ''); }
				i = last ? n : e + 1;
				if (line === h.delim) { break; }
				if (last) { return false; }
			}
		}
		return true;
	}

	/** At `<<` (or `<<-`) outside arithmetic: read the delimiter word and queue the here-document. */
	function heredocStart() {
		i += 2;
		let strip = false;
		if (s[i] === '-') { strip = true; i++; }
		while (s[i] === ' ' || s[i] === '\t') { i++; }
		let delim = '';
		while (i < n && !isMeta(s[i])) {
			const c = s[i];
			if (c === "'") {
				const e = s.indexOf("'", i + 1);
				if (e === -1) { delim += s.slice(i + 1); i = n; break; }
				delim += s.slice(i + 1, e);
				i = e + 1;
			} else if (c === '"') {
				i++;
				while (i < n && s[i] !== '"') {
					if (s[i] === '\\' && i + 1 < n) { i++; }
					delim += s[i];
					i++;
				}
				i++;
			} else if (c === '\\' && i + 1 < n) {
				delim += s[i + 1];
				i += 2;
			} else {
				delim += c;
				i++;
			}
		}
		if (delim !== '') { heredocs.push({ delim, strip }); }
	}

	/** After `'`: to the closing quote. @returns {boolean} false at end of input */
	function skipSingle() {
		const e = s.indexOf("'", i);
		if (e === -1) { i = n; return false; }
		i = e + 1;
		return true;
	}

	/** After `$'`: an ANSI-C string, where a backslash escapes the next character (so \' does not end it). */
	function skipAnsiC() {
		while (i < n) {
			const c = s[i];
			if (c === '\\') { i += 2; continue; }
			i++;
			if (c === "'") { return true; }
		}
		return false;
	}

	/**
	 * After `"`: to the closing quote, with the expansions that nest inside it.
	 * @returns {string} '' when closed, else the reason
	 */
	function skipDouble() {
		while (i < n) {
			const c = s[i];
			if (c === '\\') { i += 2; continue; }
			if (c === '"') { i++; return ''; }
			if (c === '$') {
				const r = dollar(true);
				if (r) { return r; }
				continue;
			}
			if (c === '`') {
				i++;
				const r = list('`');
				if (r) { return r; }
				continue;
			}
			i++;
		}
		return 'dquote';
	}

	/**
	 * After `${`: to the matching `}`. Quotes inside are quotes, except that a single quote inside double quotes
	 * (inDouble) is a plain character, as it is in bash.
	 * @param {boolean} inDouble
	 * @returns {string}
	 */
	function skipParam(inDouble) {
		while (i < n) {
			const c = s[i];
			if (c === '\\') { i += 2; continue; }
			if (c === '}') { i++; return ''; }
			if (c === "'" && !inDouble) { i++; if (!skipSingle()) { return 'param'; } continue; }
			if (c === '"') {
				i++;
				const r = skipDouble();
				if (r) { return r; }
				continue;
			}
			if (c === '$') {
				const r = dollar(inDouble);
				if (r) { return r; }
				continue;
			}
			if (c === '`') {
				i++;
				const r = list('`');
				if (r) { return r; }
				continue;
			}
			i++;
		}
		return 'param';
	}

	/**
	 * After `((`: arithmetic, to the `))` that closes it. Parentheses nest; `<<` is a shift here, never a here-doc.
	 * @returns {string}
	 */
	function skipArith() {
		let depth = 0;
		while (i < n) {
			const c = s[i];
			if (c === '\\') { i += 2; continue; }
			if (c === '(') { depth++; i++; continue; }
			if (c === ')') {
				if (depth > 0) { depth--; i++; continue; }
				if (s[i + 1] === ')') { i += 2; return ''; }
				// `$((cmd) | cmd)` was a command substitution that starts with a subshell: the rest is a list
				i++;
				return list(')');
			}
			if (c === "'") { i++; if (!skipSingle()) { return 'arith'; } continue; }
			if (c === '"') {
				i++;
				const r = skipDouble();
				if (r) { return r; }
				continue;
			}
			if (c === '$') {
				const r = dollar(false);
				if (r) { return r; }
				continue;
			}
			if (c === '`') {
				i++;
				const r = list('`');
				if (r) { return r; }
				continue;
			}
			i++;
		}
		return 'arith';
	}

	/**
	 * At a `$`: consume the expansion it starts.
	 * @param {boolean} inDouble
	 * @returns {string} '' or the reason it is unfinished
	 */
	function dollar(inDouble) {
		if (++depth > MAX_DEPTH) { throw BAIL; }
		try { return expansion(inDouble); } finally { depth--; }
	}

	/** @param {boolean} inDouble @returns {string} */
	function expansion(inDouble) {
		const c = s[i + 1];
		if (c === '(') {
			if (s[i + 2] === '(') { i += 3; return skipArith(); }
			i += 2;
			return list(')');
		}
		if (c === '{') { i += 2; return skipParam(inDouble); }
		if (c === "'" && !inDouble) { i += 2; return skipAnsiC() ? '' : 'quote'; }
		if (c === '"' && !inDouble) { i += 2; return skipDouble(); }
		// any other dollar is an ordinary character; what follows ($#, $?, $1 ...) is read as part of the word, so a
		// # right after it is not the start of a comment
		i++;
		return '';
	}

	/**
	 * Scans commands until `closer` (')' for $( ), '`' for a backtick substitution, null for the whole text).
	 * @param {')' | '`' | null} closer
	 * @returns {string} '' when finished, else the reason it is incomplete
	 */
	function list(closer) {
		if (++depth > MAX_DEPTH) { throw BAIL; }
		try { return commands(closer); } finally { depth--; }
	}

	/** @param {')' | '`' | null} closer @returns {string} */
	function commands(closer) {
		/** @type {Array<string>} */
		const stack = [];
		let cmdPos = true;          // the next word is at command position
		let lastOp = false;         // the last token was | && || |&, which want a command after them
		let inWord = false;
		let wordText = '';          // the literal, unquoted characters of the word so far
		let wordPlain = true;       // nothing quoted or expanded in it: a reserved word can only be a plain one
		let redirect = false;       // the next word is a redirection target: it does not change command position
		let redirectCmdPos = true;
		let afterFor = false;       // `for ((` : the (( there is arithmetic although it is not at command position
		let funcName = false;       // after `function`: the next word is a name, then the body follows

		const top = () => stack[stack.length - 1];
		const inCond = () => top() === 'cond';
		/** @param {boolean} v */
		const setCmdPos = (v) => {
			cmdPos = v && top() !== 'array';
			if (v) { afterFor = false; redirect = false; }
		};

		/** @param {string} kind */
		const popExpect = (kind) => {
			if (top() !== kind) { throw BAIL; }
			stack.pop();
		};

		function endWord() {
			if (!inWord) { return; }
			inWord = false;
			const w = wordText;
			const plain = wordPlain;
			wordText = '';
			wordPlain = true;
			lastOp = false;
			afterFor = false;
			if (redirect) { redirect = false; cmdPos = redirectCmdPos; return; }
			if (funcName) { funcName = false; setCmdPos(true); return; }
			if (top() === 'array') { return; }
			if (inCond()) {
				if (plain && w === ']]') { stack.pop(); cmdPos = false; }
				return;
			}
			if (plain && cmdPos && keyword(w)) { return; }
			if (cmdPos && plain && /^[A-Za-z_][A-Za-z0-9_]*(\+?=.*)?$/.test(w) && w.includes('=')) { return; }   // VAR=value cmd
			setCmdPos(false);
		}

		/** @param {string} w @returns {boolean} whether it was a reserved word */
		function keyword(w) {
			switch (w) {
				case 'if': stack.push('if'); setCmdPos(true); return true;
				case 'then': case 'else': case 'elif': case 'do': setCmdPos(true); return true;
				case 'fi': popExpect('if'); setCmdPos(false); return true;
				case 'while': case 'until': stack.push('loop'); setCmdPos(true); return true;
				case 'for': case 'select': stack.push('loop'); setCmdPos(false); afterFor = true; return true;
				case 'done': popExpect('loop'); setCmdPos(false); return true;
				case 'case': stack.push('case'); setCmdPos(false); return true;
				case 'esac': popExpect('case'); setCmdPos(false); return true;
				case '{': stack.push('brace'); setCmdPos(true); return true;
				case '}': popExpect('brace'); setCmdPos(false); return true;
				case '[[': stack.push('cond'); setCmdPos(false); return true;
				case 'function': funcName = true; return true;
				case 'time': case '!': case 'coproc': setCmdPos(true); return true;
				default: return false;
			}
		}

		/** @param {string} c */
		const wordChar = (c) => { inWord = true; wordText += c; lastOp = false; };
		const quotedPart = () => { inWord = true; wordPlain = false; lastOp = false; };

		/** @returns {string} */
		function pendingReason() {
			if (closer === ')') { return 'subst'; }
			if (closer === '`') { return 'backtick'; }
			if (heredocs.length) { return 'heredoc'; }
			if (lastOp) { return 'operator'; }
			return stack.length ? /** @type {string} */ (top()) : '';
		}

		while (i < n) {
			const c = s[i];

			if (c === ' ' || c === '\t') { endWord(); i++; continue; }

			if (c === '\n') {
				endWord();
				i++;
				if (heredocs.length && !readHeredocs()) { return 'heredoc'; }
				setCmdPos(true);
				continue;
			}

			if (c === '\\') {
				if (i + 1 >= n) { return 'backslash'; }
				if (s[i + 1] === '\n') { i += 2; continue; }       // a line continuation; the word goes on
				quotedPart();
				i += 2;
				continue;
			}

			if (c === "'") {
				quotedPart();
				i++;
				if (!skipSingle()) { return 'quote'; }
				continue;
			}

			if (c === '"') {
				quotedPart();
				i++;
				const r = skipDouble();
				if (r) { return r; }
				continue;
			}

			if (c === '`') {
				if (closer === '`') { endWord(); i++; return ''; }
				quotedPart();
				i++;
				const r = list('`');
				if (r) { return r; }
				continue;
			}

			if (c === '$') {
				quotedPart();
				const r = dollar(false);
				if (r) { return r; }
				continue;
			}

			if (c === '#' && !inWord) {
				while (i < n && s[i] !== '\n') { i++; }
				continue;
			}

			if (inCond() && (c === '(' || c === ')' || c === '<' || c === '>')) {
				// inside [[ ]] these are comparison and grouping characters, not operators
				wordChar(c);
				i++;
				continue;
			}

			if (c === ';') {
				endWord();
				i++;
				while (s[i] === ';' || s[i] === '&') { i++; }          // ;; ;& ;;&
				lastOp = false;
				setCmdPos(true);
				continue;
			}

			if (c === '&') {
				endWord();
				if (s[i + 1] === '&') { i += 2; lastOp = true; setCmdPos(true); continue; }
				if (s[i + 1] === '>') {                                   // &> and &>> redirect both streams
					i += s[i + 2] === '>' ? 3 : 2;
					redirectCmdPos = cmdPos;
					redirect = true;
					continue;
				}
				i++;
				lastOp = false;
				setCmdPos(true);
				continue;
			}

			if (c === '|') {
				endWord();
				i += s[i + 1] === '|' || s[i + 1] === '&' ? 2 : 1;
				lastOp = true;
				setCmdPos(true);
				continue;
			}

			if (c === '<' || c === '>') {
				// a bare number just before is a file descriptor, not a command
				if (inWord && wordPlain && /^[0-9]+$/.test(wordText)) { inWord = false; wordText = ''; } else { endWord(); }
				if (s[i + 1] === '(') {                               // process substitution <( ) and >( )
					i += 2;
					const r = list(')');
					if (r) { return r; }
					quotedPart();
					continue;
				}
				if (c === '<' && s[i + 1] === '<' && s[i + 2] === '<') { i += 3; redirectCmdPos = cmdPos; redirect = true; continue; }
				if (c === '<' && s[i + 1] === '<') {
					heredocStart();
					continue;
				}
				i++;
				while (s[i] === '>' || s[i] === '&' || s[i] === '|' || s[i] === '<') { i++; }   // >> >& >| <& <>
				redirectCmdPos = cmdPos;
				redirect = true;
				continue;
			}

			if (c === '(') {
				if (inWord && /\+?=$/.test(wordText)) {                   // a=(1 2 3): an array literal
					endWordKeep();
					stack.push('array');
					cmdPos = false;
					i++;
					continue;
				}
				endWord();
				if (s[i + 1] === '(' && (cmdPos || afterFor)) {          // ((arithmetic command)) and for ((;;))
					afterFor = false;
					i += 2;
					const r = skipArith();
					if (r) { return r; }
					setCmdPos(false);
					continue;
				}
				stack.push('paren');
				lastOp = false;
				setCmdPos(true);
				i++;
				continue;
			}

			if (c === ')') {
				endWord();
				const t = top();
				if (t === 'paren' || t === 'array') { stack.pop(); setCmdPos(true); i++; continue; }
				if (t === 'case') { setCmdPos(true); i++; continue; }      // the end of a case pattern
				if (closer === ')') { i++; return ''; }
				throw BAIL;                                                // a stray ) is a syntax error, not a continuation
			}

			// an ordinary character of a word
			wordChar(c);
			i++;
		}

		endWord();
		if (closer !== null) { return pendingReason(); }
		if (heredocs.length) { return 'heredoc'; }
		if (lastOp) { return 'operator'; }
		if (stack.length) { return /** @type {string} */ (top()); }
		return '';

		/** The word before `(` of an array assignment is consumed without the usual command-position handling. */
		function endWordKeep() {
			inWord = false;
			wordText = '';
			wordPlain = true;
			lastOp = false;
		}
	}

	try {
		const reason = list(null);
		return reason ? incomplete(reason) : { complete: true, reason: '' };
	} catch (e) {
		if (e === BAIL) { return { complete: true, reason: 'error' }; }
		throw e;
	}
}

module.exports = { isComplete };
