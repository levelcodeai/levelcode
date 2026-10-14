// What stands between a command's output and onDidWrite: the allow-list filter, the per-run cap, and writing in
// macrotask chunks. Shared by the visitor's terminal and the agent's tab, so both show the same bytes for the same
// output and neither can be flooded.
//
// The ext host coalesces onDidWrite per 5 ms and there is no flow control back from xterm, so the writer bounds the
// size of one fire (16 KiB) and spreads a large output over macrotasks, which keeps the page responsive and the
// ordering simple: everything written to a tab (output, the editor, the prompt) goes through ONE queue.
// @ts-check
'use strict';

const { createOutputFilter, createBudget } = require('./output-filter');

const CHUNK = 16 * 1024;
/** README section 7: what one run may show in a terminal tab. */
const OUTPUT_LIMIT = 1024 * 1024;

/**
 * @param {{ fire(data: string): void, schedule(fn: () => void): void, chunk?: number }} o
 */
function createWriter(o) {
	const chunk = o.chunk || CHUNK;
	/** @type {string[]} */
	let queue = [];
	let scheduled = false;

	function pump() {
		scheduled = false;
		let budget = chunk;
		let out = '';
		while (queue.length && budget > 0) {
			const s = queue[0];
			if (s.length <= budget) {
				out += s;
				budget -= s.length;
				queue.shift();
			} else {
				let cut = budget;
				const code = s.charCodeAt(cut - 1);
				if (code >= 0xd800 && code <= 0xdbff) { cut--; }     // never split a surrogate pair across two fires
				out += s.slice(0, cut);
				queue[0] = s.slice(cut);
				budget = 0;
			}
		}
		if (out) { o.fire(out); }
		if (queue.length) { scheduled = true; o.schedule(pump); }
	}

	return {
		/** @param {string} s */
		write(s) {
			if (!s) { return; }
			// the queue must stay in order: a small write waits behind a large one
			if (queue.length === 0 && s.length <= chunk) { o.fire(s); return; }
			queue.push(s);
			if (!scheduled) { scheduled = true; o.schedule(pump); }
		},
		/** Drop what has not been written yet (Ctrl+C, close). */
		clear() { queue = []; },
	};
}

/**
 * Put the terminal back to where a command found it, whatever the filters believe they wrote: colours, a link, a hidden
 * cursor. The filters only know what they emitted, and after a Ctrl+C part of that was dropped from the queue unwritten.
 */
const RESET_TAIL = '\x1b[0m' + '\x1b]8;;\x1b\\' + '\x1b[?25h';

/**
 * One run's output: a filter per stream so a stream that ends in an unterminated sequence cannot hide the other,
 * and one budget, so the cap is for the run.
 * @param {{ write(s: string): void, limit?: number }} o
 */
function createRunOutput(o) {
	const budget = createBudget(o.limit === undefined ? OUTPUT_LIMIT : o.limit);
	const filters = { stdout: createOutputFilter({ budget }), stderr: createOutputFilter({ budget }) };
	/** The writer of the last text shown: whether it ended a line says whether the next thing needs a break. */
	let last = { endsAtLineStart: () => true };
	let wrote = false;
	let stopped = false;

	/**
	 * The terminal's own words in the middle of the output (a notice): written as they are (the caller says they are
	 * constants), and the line state follows them.
	 * @param {string} text
	 */
	function say(text) {
		if (!text) { return; }
		o.write(text);
		const ends = /\n$/.test(text);
		last = { endsAtLineStart: () => ends };
		wrote = true;
	}

	return {
		/** @param {'stdout' | 'stderr'} stream @param {string} text */
		write(stream, text) {
			if (stopped) { return; }
			const f = filters[stream === 'stderr' ? 'stderr' : 'stdout'];
			const s = f.write(String(text));
			if (s) { o.write(s); last = f; wrote = true; }
		},
		say,
		/**
		 * Ctrl+C: the run shows nothing more. The terminal is put back unconditionally (RESET_TAIL), and `^C` is written
		 * the way a shell echoes it: where the output stopped. end() then supplies the line break after it.
		 */
		interrupt() {
			stopped = true;
			filters.stdout.end();
			filters.stderr.end();
			o.write(RESET_TAIL);
			say('\x1b[2m^C\x1b[0m');
		},
		/**
		 * The run is over: put back colours/links/cursor, make sure the next thing starts on its own line, and say
		 * when the cap cut the output.
		 * @returns {string}
		 */
		end() {
			let s = filters.stdout.end() + filters.stderr.end();
			if (wrote && !last.endsAtLineStart()) { s += '\r\n'; }
			if (budget.full) {
				const n = filters.stdout.stats().discarded + filters.stderr.stats().discarded;
				s += '\x1b[33m[output limit reached: ' + n + ' more characters were not shown]\x1b[0m\r\n';
			}
			return s;
		},
		/**
		 * Count text that is shown outside the filters (the agent's explanation, which is written before the output)
		 * against the run's cap, so that the cap is for what the run puts in the tab and not only for its output.
		 * @param {string} text @returns {string} the same text
		 */
		charge(text) {
			budget.used += text.length;
			return text;
		},
	};
}

/**
 * A note that says a command's file changes were NOT applied - "NONE of this command's file changes were applied",
 * "Any file changes it had made were NOT applied", "Its 3 file changes were NOT applied". The shell and levelcode-ai's
 * review write it in capitals, and a cap on the notes must never be what drops it.
 */
const NOT_APPLIED = /\bNONE of\b|\b(?:was|were) NOT applied\b/;

/**
 * The notes of a run that a terminal shows after it: at most `max` of them, in their order. When there are more, a
 * note that says the changes were NOT applied is still among them, in the place of the last of the others: a refusal
 * ends with it (six reasons, the count of the rest, then that line), and the notes the run already had - a moved
 * folder, an emptied /tmp, the engine's own - come in front of it, so it was the one a plain cut dropped.
 * @param {string[]} notes @param {number} max @returns {string[]}
 */
function notesShown(notes, max) {
	if (notes.length <= max) { return notes.slice(); }
	/** @type {number[]} */ const said = [];
	for (let i = 0; i < notes.length; i++) { if (NOT_APPLIED.test(notes[i])) { said.push(i); } }
	const keep = new Set(said.slice(-max));
	for (let i = 0; i < notes.length && keep.size < max; i++) { keep.add(i); }
	return notes.filter((_, i) => keep.has(i));
}

module.exports = { createWriter, createRunOutput, notesShown, CHUNK, OUTPUT_LIMIT, RESET_TAIL };
