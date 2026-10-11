// Command history: an in-memory ring plus persistence through an injected { get, update } (the extension's
// globalState). Pure of vscode; the store is whatever the caller hands in.
//
// Rules (they are what a person expects of a shell, and the last two keep a pasted secret out of storage):
//   - cap 1000 lines by default, 0..5000 by setting; 0 remembers nothing at all, not even for the session;
//   - a line that starts with a space is not remembered ("ignorespace");
//   - a line equal to the one before it is not added again;
//   - a line that looks like it carries a secret, or is very long, is kept in memory for this session (Up recalls
//     it) and is never written to the store.
// What is stored under 0 is hidden and forgotten too: the setting says "keeps none", and the store is emptied.
// @ts-check
'use strict';

const KEY = 'levelcode.shell.history';
const DEFAULT_CAP = 1000;
const MAX_CAP = 5000;
/** A line longer than this is not persisted: a pasted script would bloat the store a thousand times over. */
const MAX_PERSISTED_LINE = 4000;
/**
 * looksSecret reads no more than this many characters of a line. Nothing past MAX_PERSISTED_LINE is ever stored and the
 * shell-integration command text is cut at 2048, so a secret that sits further in has nowhere to leak to; and a
 * pattern that has to backtrack is run over a bounded text, not over a 100,000-character paste.
 */
const MAX_SCANNED = 4096;

/**
 * The patterns are assembled from fragments: this repository is public and a secret scanner reads a literal token
 * shape in a source file as a leak, even in a regular expression.
 * @param {...string} parts
 */
const re = (...parts) => new RegExp(parts.join(''), 'i');

// Every repetition that can grow with the input is bounded, or anchored so that it cannot be restarted at every
// position (the scheme part of the URL shape): a line of 4 KiB of 'a' or of 'eyJ-' must cost microseconds.
const SECRET_SHAPES = [
	// name=value or name: value for the usual secret names (also matches GITHUB_TOKEN=..., --api-key=...)
	re('(?:pass', 'w(?:or)?d|pwd|passphrase|secret|to', 'ken|api[_-]?key|access[_-]?key|private[_-]?key|auth', '(?:orization)?|credential)s?', '\\s*[=:]\\s*\\S'),
	// a flag that takes the secret as the next word
	re('--(?:pass', 'w(?:or)?d|to', 'ken|secret|api[_-]?key)\\s+\\S'),
	// an Authorization header or a bearer token
	re('bea', 'rer\\s+[A-Za-z0-9._~+/=-]{8,}'),
	// credentials inside a URL
	re('(?<![a-z0-9+.-])[a-z][a-z0-9+.-]{0,31}://[^/\\s:@]{1,256}:[^/\\s@]{1,256}@'),
	// shapes of well-known tokens
	re('\\bsk', '-[A-Za-z0-9_-]{16,}'),
	re('\\bgh[pousr]', '_[A-Za-z0-9]{20,}'),
	re('\\bgithub', '_pat_[A-Za-z0-9_]{20,}'),
	re('\\bxox[abprs]', '-[A-Za-z0-9-]{10,}'),
	re('\\bAK', 'IA[0-9A-Z]{16}\\b'),
	re('\\bAI', 'za[0-9A-Za-z_-]{30,}'),
	re('\\bey', 'J[A-Za-z0-9_-]{10,2000}\\.ey', 'J[A-Za-z0-9_-]{10,2000}'),
	re('-----BEGIN [A-Z ]*PRIVATE', ' KEY-----'),
];

/** @param {string} line */
function looksSecret(line) {
	const text = line.length > MAX_SCANNED ? line.slice(0, MAX_SCANNED) : line;
	return SECRET_SHAPES.some((r) => r.test(text));
}

/** @param {unknown} n */
function clampCap(n) {
	const v = typeof n === 'number' && Number.isFinite(n) ? Math.floor(n) : DEFAULT_CAP;
	return Math.max(0, Math.min(MAX_CAP, v));
}

/**
 * @typedef {{ get<T>(key: string, fallback: T): T, update(key: string, value: unknown): PromiseLike<void> | void }} Store
 * @param {{ store?: Store, cap?: number, key?: string }} [options]
 */
function createHistory(options) {
	const o = options || {};
	const store = o.store;
	const key = o.key || KEY;
	let cap = clampCap(o.cap);
	/** @type {Array<{ line: string, memoryOnly: boolean }>} */
	let items = [];

	function persist() {
		if (!store) { return; }
		const lines = items.filter((x) => !x.memoryOnly).map((x) => x.line);
		try {
			const r = store.update(key, lines);
			if (r && typeof r.then === 'function') { r.then(undefined, () => { /* a private window: history stays in memory */ }); }
		} catch (e) { /* the same */ }
	}

	if (store) {
		/** @type {unknown} */
		let saved;
		try { saved = store.get(key, []); } catch (e) { saved = []; }
		if (Array.isArray(saved)) {
			// slice(-0) is slice(0): a cap of 0 is the empty list, not "all of it"; and what an earlier setting left in
			// the store is forgotten now, not at the next `history -c`
			items = cap === 0 ? [] : saved
				.filter((l) => typeof l === 'string' && l.trim() !== '')
				.slice(-cap)
				.map((line) => ({ line, memoryOnly: false }));
			if (cap === 0 && saved.length > 0) { persist(); }
		}
	}

	return {
		/** Oldest first. A copy: callers may keep it. */
		list: () => items.map((x) => x.line),
		/**
		 * @param {string} line
		 * @param {boolean} [secret] looksSecret(line), when the caller has it already (it is asked once per line)
		 * @returns {boolean} whether it was remembered
		 */
		add(line, secret) {
			if (cap === 0) { return false; }
			if (typeof line !== 'string' || line.trim() === '') { return false; }
			if (/^\s/.test(line)) { return false; }
			if (items.length && items[items.length - 1].line === line) { return false; }
			items.push({ line, memoryOnly: (secret === undefined ? looksSecret(line) : secret) || line.length > MAX_PERSISTED_LINE });
			if (items.length > cap) { items = items.slice(items.length - cap); }
			persist();
			return true;
		},
		/** Forget everything, here and in the store. */
		clear() {
			items = [];
			persist();
		},
		/** @param {number} n a new cap; lines beyond it are forgotten, oldest first */
		setCap(n) {
			cap = clampCap(n);
			if (items.length > cap) { items = items.slice(items.length - cap); persist(); }
		},
		cap: () => cap,
	};
}

module.exports = { createHistory, looksSecret, KEY, DEFAULT_CAP, MAX_CAP };
