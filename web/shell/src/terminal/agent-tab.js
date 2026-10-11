// The mirror of the agent's commands: one reusable, read-only terminal tab, "LevelCode Agent".
//
// The chat's command card stays the primary view; this tab shows the same run as a terminal would, fed by
// runtime.onAgentRun. It takes no input (the chat's Stop button is the stop), enables no shell integration (a
// command the MODEL wrote must not become an entry in the workbench's "recent commands"), and goes through the
// same output filter and cap as the visitor's terminal.
//
// Revealing it is the delicate part. Measured in the release build: terminal.show(true) from a terminal that has the
// focus makes the new tab active and leaves the keyboard focus on the page body, so the visitor's next keystrokes
// vanish. The extension API cannot ask where the focus is, so the shells report their input and this tab does not
// reveal itself for 30 s after the last of it.
// @ts-check
'use strict';

const { createInputParser } = require('./input-parser');
const { createWriter, createRunOutput, OUTPUT_LIMIT } = require('./output-sink');
const { cwdLabel } = require('./prompt');

const NAME = 'LevelCode Agent';
const UNSEEN_NAME = NAME + ' •';
/** No reveal this soon after the visitor typed in a terminal. */
const RECENT_INPUT_MS = 30000;
const MAX_COMMAND_SHOWN = 300;

const ESC = '\x1b';
const DIM = ESC + '[2m';
const BOLD = ESC + '[1m';
const GREEN = ESC + '[32m';
const RED = ESC + '[31m';
const YELLOW = ESC + '[33m';
const RESET = ESC + '[0m';

/**
 * Whether to open the tab (move the panel to it) for a run that is starting.
 * @param {{ mode: string, firstRunThisSession: boolean, msSinceLastShellInput: number }} o
 */
function shouldReveal(o) {
	if (o.mode === 'never') { return false; }
	if (o.msSinceLastShellInput < RECENT_INPUT_MS) { return false; }       // the visitor is typing in a terminal
	return o.mode === 'always' || o.firstRunThisSession;
}

/** @param {number} ms */
function duration(ms) {
	if (!(ms >= 0)) { return '0ms'; }
	if (ms < 1000) { return Math.round(ms) + 'ms'; }
	if (ms < 60000) { return (ms / 1000).toFixed(1) + 's'; }
	return Math.floor(ms / 60000) + 'm ' + Math.round((ms % 60000) / 1000) + 's';
}

/**
 * @param {{
 *   vscode: any,
 *   runtime: { onAgentRun(l: (e: any) => void): { dispose(): void }, folders(): Array<{ name: string, root: string }> },
 *   sanitize: { forTerminal(text: string, o?: { crlf?: boolean }): string },
 *   getMode: () => string,
 *   activity: { lastInput: number },
 *   now?: () => number,
 *   schedule?: (fn: () => void) => void,
 *   outputLimit?: number,
 * }} deps
 */
function createAgentTab(deps) {
	const vscode = deps.vscode;
	const now = deps.now || (() => Date.now());
	const sanitize = deps.sanitize;

	/** @type {any} */ let terminal = null;
	/** @type {any} */ let pty = null;
	let firstRun = true;
	let unseen = false;
	let hinted = false;
	let wroteSomething = false;
	/** @type {{ id: number, output: ReturnType<typeof createRunOutput>, startedAt: number } | null} */
	let current = null;
	/** @type {Map<number, any[]>} events of runs that started while another was still going, in order */
	const waiting = new Map();
	/** @type {number[]} */
	const order = [];
	const subscriptions = /** @type {Array<{ dispose(): void }>} */ ([]);

	/* ---------------------------------------------------------------------------------------------- the pty */

	function makePty() {
		const writeEmitter = new vscode.EventEmitter();
		const closeEmitter = new vscode.EventEmitter();
		const nameEmitter = new vscode.EventEmitter();
		const parser = createInputParser();
		let ready = false;
		let before = '';
		let name = NAME;
		const writer = createWriter({
			fire: (s) => { if (ready) { writeEmitter.fire(s); } else { before += s; } },
			schedule: deps.schedule || ((fn) => { setTimeout(fn, 0); }),
		});
		const self = {
			onDidWrite: writeEmitter.event,
			onDidClose: closeEmitter.event,
			onDidChangeName: nameEmitter.event,
			open() {
				// events fired before the workbench opened the pty are lost, so what they said is said again now
				ready = true;
				if (name !== NAME) { nameEmitter.fire(name); }
				if (before) { const b = before; before = ''; writer.write(b); }
			},
			close() {
				// the visitor closed the tab: the runs go on, the next one makes a new tab
				if (pty === self) { terminal = null; pty = null; }
			},
			/** @param {string} data */
			handleInput(data) {
				for (const e of parser.feed(String(data))) {
					if (e.t === 'ignored') { continue; }
					if (e.t === 'key' && e.key === 'c' && e.ctrl) {
						writer.write(DIM + 'Ctrl+C does nothing here: stop a command with the Stop button on its card in the chat.' + RESET + '\r\n');
					} else if (!hinted) {
						hinted = true;
						writer.write(DIM + 'This tab shows the agent\'s commands and takes no input. Ctrl+Shift+` opens a shell of your own.' + RESET + '\r\n');
					}
				}
			},
			setDimensions() { /* nothing is laid out by width here */ },
			writer,
			/** @param {string} next */
			setName(next) { name = next; if (ready) { nameEmitter.fire(next); } },
		};
		return self;
	}

	function ensureTab() {
		if (terminal && pty) { return; }
		pty = makePty();
		terminal = vscode.window.createTerminal({
			name: NAME,
			pty,
			iconPath: new vscode.ThemeIcon('sparkle'),
			color: new vscode.ThemeColor('terminal.ansiMagenta'),
		});
		unseen = false;
		wroteSomething = false;
		hinted = false;
	}

	/** @param {string} s */
	function put(s) { if (pty) { pty.writer.write(s); } }

	function markUnseen() {
		if (!pty || unseen) { return; }
		const active = vscode.window && vscode.window.activeTerminal;
		if (active === terminal) { return; }
		unseen = true;
		pty.setName(UNSEEN_NAME);
	}

	function clearUnseen() {
		if (!unseen || !pty) { return; }
		unseen = false;
		pty.setName(NAME);
	}

	if (vscode.window && typeof vscode.window.onDidChangeActiveTerminal === 'function') {
		subscriptions.push(vscode.window.onDidChangeActiveTerminal((/** @type {any} */ t) => { if (t && t === terminal) { clearUnseen(); } }));
	}

	/* ---------------------------------------------------------------------------------------------- runs */

	/** @param {string} text @returns {string} one line, safe to write */
	function oneLine(text) {
		return sanitize.forTerminal(String(text).replace(/\s*\r?\n\s*/g, ' ')).replace(/[\r\n]+/g, ' ');
	}

	/** @param {any} e a 'start' event */
	function begin(e) {
		ensureTab();
		const mode = deps.getMode();
		const reveal = shouldReveal({ mode, firstRunThisSession: firstRun, msSinceLastShellInput: now() - deps.activity.lastInput });
		firstRun = false;
		if (reveal && terminal) { terminal.show(true); }

		const command = String(e.command === undefined ? '' : e.command);
		const lines = command.split('\n');
		let first = lines[0];
		if (first.length > MAX_COMMAND_SHOWN) { first = first.slice(0, MAX_COMMAND_SHOWN) + '…'; }
		const more = lines.length > 1 ? ' ' + DIM + '(+' + (lines.length - 1) + ' more line' + (lines.length > 2 ? 's' : '') + ')' + RESET : '';
		const folders = deps.runtime.folders();
		const where = e.cwd ? cwdLabel(String(e.cwd), folders, 120, sanitize) : '';

		let head = wroteSomething ? '\r\n' : '';
		if (typeof e.explanation === 'string' && e.explanation.trim() !== '') { head += DIM + oneLine(e.explanation) + RESET + '\r\n'; }
		head += BOLD + '$ ' + oneLine(first) + RESET + more + '\r\n';
		if (where) { head += DIM + 'in ' + where + RESET + '\r\n'; }
		put(head);
		wroteSomething = true;
		markUnseen();

		current = {
			id: e.id,
			output: createRunOutput({ write: (s) => put(s), limit: deps.outputLimit || OUTPUT_LIMIT }),
			startedAt: now(),
		};
	}

	/** @param {any} e an 'end' event */
	function finish(e) {
		const run = current;
		if (!run) { return; }
		let s = run.output.end();
		const notes = Array.isArray(e.notes) ? e.notes.slice(0, 8) : [];
		for (const n of notes) { if (typeof n === 'string') { s += DIM + oneLine(n) + RESET + '\r\n'; } }
		const took = duration(now() - run.startedAt);
		const code = Number.isFinite(e.exitCode) ? Math.trunc(e.exitCode) : 1;
		switch (e.how) {
			case 'aborted': s += YELLOW + '■ stopped · ' + took + RESET + '\r\n'; break;
			case 'deadline': s += YELLOW + '■ timed out · ' + took + RESET + '\r\n'; break;
			case 'limit': s += YELLOW + '■ stopped: a limit of the shell was reached · ' + took + RESET + '\r\n'; break;
			case 'error': s += RED + '✗ could not run · ' + took + RESET + '\r\n'; break;
			default:
				s += code === 0
					? GREEN + '✓ exit 0 · ' + took + RESET + '\r\n'
					: RED + '✗ exit ' + code + ' · ' + took + RESET + '\r\n';
		}
		put(s);
		current = null;
		markUnseen();
		// the next run that was waiting for this one
		while (!current && order.length) {
			const id = /** @type {number} */ (order.shift());
			const events = waiting.get(id) || [];
			waiting.delete(id);
			for (const ev of events) { handle(ev); }
		}
	}

	/** @param {any} e */
	function handle(e) {
		if (!e || typeof e !== 'object') { return; }
		if (e.type === 'start') {
			if (current) {
				waiting.set(e.id, [e]);
				order.push(e.id);
				return;
			}
			begin(e);
			return;
		}
		if (current && current.id === e.id) {
			if (e.type === 'chunk') { current.output.write(e.stream === 'stderr' ? 'stderr' : 'stdout', String(e.text)); } else if (e.type === 'end') { finish(e); }
			return;
		}
		const queued = waiting.get(e.id);
		if (queued) { queued.push(e); }
	}

	subscriptions.push(deps.runtime.onAgentRun(handle));

	return {
		/** The command `levelcode.shell.showAgent`: the tab, with the focus, made if it is not there. */
		show() {
			const fresh = !terminal;
			ensureTab();
			if (fresh && !wroteSomething) { put(DIM + 'The agent\'s commands appear here as they run.' + RESET + '\r\n'); wroteSomething = true; }
			terminal.show(false);
			clearUnseen();
		},
		dispose() {
			for (const s of subscriptions.splice(0)) { try { s.dispose(); } catch (e) { /* already gone */ } }
			if (terminal) { try { terminal.dispose(); } catch (e) { /* already gone */ } }
			terminal = null;
			pty = null;
		},
		/** For tests and the extension's own bookkeeping. */
		terminal: () => terminal,
	};
}

module.exports = { createAgentTab, shouldReveal, duration, NAME, UNSEEN_NAME, RECENT_INPUT_MS };
