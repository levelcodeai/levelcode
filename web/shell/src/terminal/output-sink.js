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
		pending: () => queue.length > 0,
	};
}

/**
 * One run's output: a filter per stream so a stream that ends in an unterminated sequence cannot hide the other,
 * and one budget, so the cap is for the run.
 * @param {{ write(s: string): void, limit?: number }} o
 */
function createRunOutput(o) {
	const budget = createBudget(o.limit === undefined ? OUTPUT_LIMIT : o.limit);
	const filters = { stdout: createOutputFilter({ budget }), stderr: createOutputFilter({ budget }) };
	/** @type {ReturnType<typeof createOutputFilter>} */
	let last = filters.stdout;
	let wrote = false;

	return {
		/** @param {'stdout' | 'stderr'} stream @param {string} text */
		write(stream, text) {
			const f = filters[stream === 'stderr' ? 'stderr' : 'stdout'];
			const s = f.write(String(text));
			if (s) { o.write(s); last = f; wrote = true; }
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
		truncated: () => budget.full,
		/** True when the run wrote nothing the screen shows (so nothing needs to be separated from what follows). */
		wrote: () => wrote,
	};
}

module.exports = { createWriter, createRunOutput, CHUNK, OUTPUT_LIMIT };
