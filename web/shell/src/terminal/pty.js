// The visitor's terminal: a vscode.Pseudoterminal over one engine Session.
//
// Everything here is plain node: the `vscode` object is only used for EventEmitter, and arrives injected, as do the
// session, the history, the sanitiser and the clocks. That is what lets a test drive it with bytes in and bytes out.
//
// What goes to the terminal, and how (the rule is README section 8, and it is why this file has three kinds of write):
//   1. constants of this extension (the banner, `^C`, the shell-integration sequences, the colours): written as they are;
//   2. strings that came from somewhere else (the cwd in the prompt, file names, notes, the history list): through
//      sanitize.forTerminal first, always;
//   3. command output: through the allow-list filter of output-filter.js, a filter per stream, one cap per run.
// All three go through one ordered queue (output-sink.js) in chunks of at most 16 KiB per macrotask.
// @ts-check
'use strict';

const { LineEditor } = require('./line-editor');
const { createInputParser, DEFAULT_MAX_PASTE } = require('./input-parser');
const { isComplete } = require('./completeness');
const { createCompleter } = require('./completion');
const { createWriter, createRunOutput, OUTPUT_LIMIT } = require('./output-sink');
const { strWidth } = require('./width');
const { promptFor, cwdLabel } = require('./prompt');
const { looksSecret } = require('./history');
const si = require('./shell-integration');

const ESC = '\x1b';
const NAME = 'LevelCode Shell';
/** A sequence cut by the end of a chunk is given this long to be finished before it is taken for what it is. */
const FLUSH_MS = 50;
const DEFAULT_DIMS = { columns: 80, rows: 24 };
const DIM = ESC + '[2m';
const YELLOW = ESC + '[33m';
const RED = ESC + '[31m';
const RESET = ESC + '[0m';

/** @typedef {import('./prompt').FolderRef} FolderRef */

/**
 * @param {unknown} dims
 * @param {{ columns: number, rows: number }} fallback
 */
function normalizeDims(dims, fallback) {
	const d = /** @type {any} */ (dims) || {};
	const columns = Number.isFinite(d.columns) && d.columns >= 2 ? Math.floor(d.columns) : fallback.columns;
	const rows = Number.isFinite(d.rows) && d.rows >= 2 ? Math.floor(d.rows) : fallback.rows;
	return { columns, rows };
}

/**
 * What to tell the person when a run ended any way but by running to its end, if the runtime did not already
 * (its notes normally do). Exit 126 and 124 are the engine's: a limit and a deadline.
 * @param {string} how
 * @param {number} exitCode
 * @returns {string} '' when there is nothing to add
 */
function outcomeLine(how, exitCode) {
	switch (how) {
		case 'limit': return 'the command was stopped: it reached a limit of this shell (exit ' + exitCode + ')';
		case 'deadline': return 'the command was stopped: it ran for too long (exit ' + exitCode + ')';
		case 'error': return 'the shell could not run this line (exit ' + exitCode + ')';
		default: return '';
	}
}

/**
 * The text rule for `exit`: a line that is only `exit` or `exit N` (and an optional `;`). The engine cannot say that a
 * script asked to leave (its status 3 is the same as `false` or a failed grep), so the terminal looks at the line.
 * `exit` inside a group or after another command is the engine's, and only ends that line.
 * @param {string} line
 * @returns {{ code: number | null } | null}
 */
function exitRule(line) {
	const m = /^exit(?:[ \t]+(-?[0-9]+))?[ \t]*;?$/.exec(line.trim());
	if (!m) { return null; }
	return { code: m[1] === undefined ? null : ((Number(m[1]) % 256) + 256) % 256 };
}

class ShellPty {
	/**
	 * @param {{
	 *   vscode: { EventEmitter: new () => any },
	 *   session: any,
	 *   history: { list(): string[], add(line: string): boolean, clear(): void },
	 *   sanitize: { forTerminal(text: string, o?: { crlf?: boolean }): string },
	 *   folders: () => FolderRef[],
	 *   info?: { commands: string[] },
	 *   getRandomValues: (a: Uint8Array) => Uint8Array,
	 *   schedule?: (fn: () => void) => void,
	 *   setTimeout?: (fn: () => void, ms: number) => any,
	 *   clearTimeout?: (h: any) => void,
	 *   outputLimit?: number,
	 *   maxPaste?: number,
	 *   onInput?: () => void,
	 *   onCwd?: (cwd: string) => void,
	 * }} deps
	 */
	constructor(deps) {
		this.deps = deps;
		this._write = new deps.vscode.EventEmitter();
		this._close = new deps.vscode.EventEmitter();
		/** Pseudoterminal events. */
		this.onDidWrite = this._write.event;
		this.onDidClose = this._close.event;
		/** The nonce this terminal was created with; the creator hands it to createTerminal. */
		this.nonce = si.createNonce(deps.getRandomValues);

		this.setTimeoutFn = deps.setTimeout || ((fn, ms) => setTimeout(fn, ms));
		this.clearTimeoutFn = deps.clearTimeout || ((h) => clearTimeout(h));
		this.writer = createWriter({
			fire: (s) => this._write.fire(s),
			schedule: deps.schedule || ((fn) => { setTimeout(fn, 0); }),
		});
		this.sanitize = deps.sanitize;
		this.session = deps.session;
		this.history = deps.history;
		this.dims = Object.assign({}, DEFAULT_DIMS);
		/** 'new' until open(), then 'idle' (editing) or 'running', and 'closed'. */
		this.state = 'new';
		this.token = 0;
		this.lastStatus = 0;
		this.interrupted = false;
		this.promptText = '$ ';
		this.flushTimer = /** @type {any} */ (null);
		this.maxPaste = deps.maxPaste || DEFAULT_MAX_PASTE;
		this.parser = createInputParser({ maxPaste: this.maxPaste });

		this.editor = new LineEditor({
			write: (s) => this.writer.write(s),
			prompt: () => this.promptText,
			continuation: '> ',
			marks: { start: si.promptStart(), end: si.promptEnd() },
			columns: this.dims.columns,
			rows: this.dims.rows,
			history: () => this.history.list(),
			isComplete: (src) => isComplete(src),
			complete: createCompleter(this.session, this.sanitize),
			onSubmit: (src) => this._accept(src),
			onEof: () => this._exit(this.lastStatus),
			maxPaste: this.maxPaste,
		});
	}

	/* ------------------------------------------------------------------------------------------------ Pseudoterminal */

	/** @param {{ columns: number, rows: number } | undefined} dims undefined until the panel has been laid out */
	open(dims) {
		if (this.state !== 'new') { return; }
		this.dims = normalizeDims(dims, DEFAULT_DIMS);
		this.editor.resize(this.dims.columns, this.dims.rows);
		this.state = 'idle';
		const n = this.deps.info && Array.isArray(this.deps.info.commands) ? this.deps.info.commands.length : 0;
		this.writer.write(
			ESC + '[?2004h'                                            // bracketed paste, for the life of the tab
			+ si.property('HasRichCommandDetection', 'True')
			+ si.property('ContinuationPrompt', '> ')
			+ si.cwd(String(this.session.cwd || '/'), this.nonce)
			+ DIM + 'LevelCode Shell: bash over the files of this workspace' + (n ? ', with ' + n + ' commands' : '') + '.' + RESET + '\r\n'
			+ DIM + 'It runs scripts and commands, not programs: no node, npm, git or python, no network, no background jobs.' + RESET + '\r\n'
			+ DIM + 'The working folder and exported variables carry from line to line; functions, aliases and options do not. Type help.' + RESET + '\r\n');
		this._prompt();
	}

	close() {
		if (this.state === 'closed') { return; }
		this.state = 'closed';
		this.token++;
		this.writer.clear();
		this._clearFlush();
		try { this.session.dispose(); } catch (e) { /* already gone */ }
	}

	/** @param {string} data */
	handleInput(data) {
		if (this.state === 'closed' || this.state === 'new') { return; }
		const events = this.parser.feed(String(data));
		this._dispatch(events);
		this._clearFlush();
		if (this.parser.hasPending()) {
			this.flushTimer = this.setTimeoutFn(() => {
				this.flushTimer = null;
				this._dispatch(this.parser.flush());
			}, FLUSH_MS);
		}
	}

	/** @param {{ columns: number, rows: number }} dims */
	setDimensions(dims) {
		if (this.state === 'closed') { return; }
		this.dims = normalizeDims(dims, this.dims);
		this.editor.resize(this.dims.columns, this.dims.rows);
	}

	/* ------------------------------------------------------------------------------------------------ input */

	_clearFlush() {
		if (this.flushTimer !== null) { this.clearTimeoutFn(this.flushTimer); this.flushTimer = null; }
	}

	/** @param {any[]} events */
	_dispatch(events) {
		if (this.state === 'closed' || !events.length) { return; }
		if (this.deps.onInput && events.some((e) => e.t !== 'ignored')) { this.deps.onInput(); }
		if (this.state === 'running') {
			// While a command runs only Ctrl+C is heard. Whatever else is typed is dropped, not kept for the next prompt.
			if (events.some((e) => e.t === 'key' && e.key === 'c' && e.ctrl)) { this._interrupt(); }
			return;
		}
		this.editor.input(events);
	}

	/** Ctrl+C while a command runs: the session stops the engine; the pending run settles as aborted. */
	_interrupt() {
		if (this.interrupted) { return; }
		this.interrupted = true;
		this.writer.clear();                    // what has not been written yet is not worth the wait
		this.writer.write(DIM + '^C' + RESET);
		try { this.session.stop(); } catch (e) { /* nothing was running */ }
	}

	/* ------------------------------------------------------------------------------------------------ lines */

	_prompt() {
		this.promptText = promptFor({
			cwd: String(this.session.cwd || '/'),
			folders: this.deps.folders(),
			status: this.lastStatus,
			columns: this.dims.columns,
			sanitize: this.sanitize,
		});
		this.state = 'idle';
		this.interrupted = false;
		this.editor.start();
	}

	/** @param {string} src one accepted line (or script) */
	_accept(src) {
		if (src.trim() === '') { this._prompt(); return; }
		this.history.add(src);
		const t = src.trim();
		const ex = exitRule(t);
		if (ex) { this._exit(ex.code === null ? this.lastStatus : ex.code); return; }
		if (t === 'clear' || t === 'clear;') { this._local(src, () => ESC + '[2J' + ESC + '[H'); return; }
		if (t === 'help' || t === 'help;') { this._local(src, () => this._help()); return; }
		const h = /^history(?:[ \t]+(-c|[0-9]+))?[ \t]*;?$/.exec(t);
		if (h) { this._local(src, () => this._historyText(h[1])); return; }
		this._run(src);
	}

	/**
	 * A line the terminal answers itself. It is told to the workbench like any other command, so the decorations and
	 * the status marker behave.
	 * @param {string} src @param {() => string} produce
	 */
	_local(src, produce) {
		this.state = 'running';
		this.writer.write(this._commandMarks(src) + produce());
		this._epilogue(0, '', []);
	}

	/**
	 * The marks that announce a command (E, C). The workbench keeps the command line of what runs in the "recent
	 * commands" it persists; a line that looks like it carries a secret is announced without its text, as it is kept out
	 * of the history.
	 * @param {string} src
	 */
	_commandMarks(src) {
		return si.commandLine(looksSecret(src) ? '' : src, this.nonce) + si.executed();
	}

	/** @param {string} src */
	_run(src) {
		this.state = 'running';
		this.interrupted = false;
		const token = ++this.token;
		const output = createRunOutput({ write: (s) => this.writer.write(s), limit: this.deps.outputLimit || OUTPUT_LIMIT });
		this.writer.write(this._commandMarks(src));
		const live = () => token === this.token && this.state === 'running';
		let pending;
		try {
			pending = this.session.run(src, {
				onStdout: (/** @type {string} */ t) => { if (live()) { output.write('stdout', t); } },
				onStderr: (/** @type {string} */ t) => { if (live()) { output.write('stderr', t); } },
				cols: this.dims.columns,
				rows: this.dims.rows,
			});
		} catch (e) {
			pending = Promise.reject(e);
		}
		Promise.resolve(pending).then(
			(r) => { if (live()) { this._ended(output, r); } },
			(e) => {
				if (!live()) { return; }
				const message = e && /** @type {any} */ (e).message ? String(/** @type {any} */ (e).message) : String(e);
				this._ended(output, { exitCode: 1, how: 'error', notes: ['[LevelCode Shell: ' + message + ']'] });
			});
	}

	/**
	 * @param {ReturnType<typeof createRunOutput>} output
	 * @param {{ exitCode: number, how: string, notes?: string[] }} r
	 */
	_ended(output, r) {
		const code = Number.isFinite(r && r.exitCode) ? Math.trunc(r.exitCode) : 1;
		const how = r && typeof r.how === 'string' ? r.how : 'exit';
		const notes = r && Array.isArray(r.notes) ? r.notes.filter((n) => typeof n === 'string') : [];
		this._epilogue(code, output.end(), notes, how);
	}

	/**
	 * Everything after a command's last byte, in one write: the filter's resets, what the runtime says about the run,
	 * the end-of-command marks, and then the next prompt.
	 * @param {number} code @param {string} tail @param {string[]} notes @param {string} [how]
	 */
	_epilogue(code, tail, notes, how) {
		let s = tail;
		const lines = notes.slice(0, 8).map((n) => this.sanitize.forTerminal(n, { crlf: false }).replace(/\n/g, ' '));
		const own = how && how !== 'exit' && how !== 'aborted' && lines.length === 0 ? outcomeLine(how, code) : '';
		for (const l of lines) { s += DIM + l + RESET + '\r\n'; }
		if (own) { s += YELLOW + '[' + own + ']' + RESET + '\r\n'; }
		this.lastStatus = code;
		const cwd = String(this.session.cwd || '/');
		s += si.finished(code) + si.cwd(cwd, this.nonce);
		this.writer.write(s);
		if (this.deps.onCwd) { this.deps.onCwd(cwd); }
		this._prompt();
	}

	/** @param {number} code */
	_exit(code) {
		if (this.state === 'closed') { return; }
		this.state = 'closed';
		this.token++;
		this.writer.clear();
		this._clearFlush();
		try { this.session.dispose(); } catch (e) { /* already gone */ }
		this._close.fire(code & 255);
	}

	/* ------------------------------------------------------------------------------------------------ built-in text */

	_help() {
		const commands = this.deps.info && Array.isArray(this.deps.info.commands) ? this.deps.info.commands : [];
		const names = commands.map((c) => this.sanitize.forTerminal(String(c))).join(' ');
		const lines = [
			'LevelCode Shell runs shell scripts over the files of this workspace.',
			'',
			'  It has' + (names ? ' these commands: ' + names : ' about 80 everyday commands (ls, cat, grep, sed, awk, jq, find)') + '.',
			'  It does not run programs: no node, npm, git, python or other binaries, no network, no background jobs.',
			'  The working folder and exported variables carry from one line to the next;',
			'  functions, aliases and shell options last for one line only.',
			'',
			'  Up/Down history   Tab complete   Ctrl+C stop   Ctrl+L clear   Ctrl+D or exit leave',
			'  help  history [n|-c]  clear  exit [n]   are handled by the terminal itself',
		];
		return lines.map((l) => this._wrap(l)).join('\r\n') + '\r\n';
	}

	/** @param {string} line */
	_wrap(line) {
		const cols = this.dims.columns;
		if (strWidth(line) <= cols) { return line; }
		const indent = (/^ */.exec(line) || [''])[0] + '  ';
		const out = [];
		let cur = '';
		for (const w of line.split(' ')) {
			if (cur && strWidth(cur + ' ' + w) > cols - 1) { out.push(cur); cur = indent + w; } else { cur = cur ? cur + ' ' + w : w; }
		}
		if (cur) { out.push(cur); }
		return out.join('\r\n');
	}

	/** @param {string | undefined} arg */
	_historyText(arg) {
		if (arg === '-c') { this.history.clear(); return ''; }
		const all = this.history.list();
		const n = arg === undefined ? all.length : Math.min(all.length, Number(arg));
		const first = all.length - n;
		let s = '';
		for (let i = first; i < all.length; i++) {
			s += String(i + 1).padStart(5) + '  ' + this.sanitize.forTerminal(all[i], { crlf: true }).replace(/\r\n/g, '\r\n       ') + '\r\n';
		}
		return s;
	}
}

module.exports = { ShellPty, outcomeLine, exitRule, NAME };
