/*---------------------------------------------------------------------------------------------
 *  LevelCode — Notepad++ Pack
 *  Feature: JSON beautify-on-paste — the PURE core (no vscode import, unit-tested).
 *
 *  Decides whether a pasted string is beautifiable JSON and produces the pretty-printed text. The
 *  vscode paste-provider glue that calls this lives in jsonPaste.js; keeping the logic here means it
 *  runs under plain `node` in test/jsonBeautify.test.js.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

// Don't parse a paste larger than this — JSON.parse + stringify on a huge blob would block the
// extension host mid-paste. 5 MB is far past any hand-pasted JSON; bigger pastes just paste normally.
// Measured in real UTF-8 BYTES (Buffer.byteLength), NOT String#length — a code-unit count undercounts
// multibyte content (a CJK char is 1 code unit but 3 bytes), which would let a much bigger payload through.
const MAX_BYTES = 5 * 1024 * 1024;

/**
 * Decide whether a pasted string should be beautified, and to what.
 *
 * Fires ONLY when the WHOLE trimmed paste is a single valid JSON *container* (object or array):
 *   - a bare scalar ("5", "\"hi\"", "true", "null") is valid JSON but must never be transformed;
 *   - anything with trailing junk after the JSON (`{"a":1} x`) fails the parse and is left alone;
 *   - text that is already exactly the canonical output is skipped (idempotent — so re-pasting, or
 *     pasting output we'd produce, doesn't fight a normal paste).
 * Everything that isn't "yes, beautify" returns `beautify:false` so the caller falls through to a
 * plain paste.
 *
 * @param {unknown} text  the pasted text
 * @param {{indent?: number|string, maxBytes?: number}} [opts]  indent for JSON.stringify (space count
 *        or a literal like '\t'; default 2); maxBytes overrides the size guard (for tests)
 * @returns {{beautify: boolean, output?: string, reason: string}}
 */
function analyzePaste(text, opts) {
	if (typeof text !== 'string') { return { beautify: false, reason: 'not-string' }; }
	const trimmed = text.trim();
	// Cheap pre-filter: a JSON container starts with { or [. This skips the parse for ~every paste that
	// isn't JSON, and rules out bare scalars without parsing them.
	if (trimmed.length < 2 || (trimmed[0] !== '{' && trimmed[0] !== '[')) { return { beautify: false, reason: 'not-container' }; }
	const maxBytes = (opts && typeof opts.maxBytes === 'number') ? opts.maxBytes : MAX_BYTES;
	if (Buffer.byteLength(trimmed, 'utf8') > maxBytes) { return { beautify: false, reason: 'too-large' }; }
	let parsed;
	try { parsed = JSON.parse(trimmed); }
	catch { return { beautify: false, reason: 'invalid-json' }; }
	// Only { and [ reach here, so parsed is already an object/array — but be explicit rather than assume.
	if (parsed === null || typeof parsed !== 'object') { return { beautify: false, reason: 'not-container' }; }
	const indent = (opts && opts.indent != null) ? opts.indent : 2;
	const output = JSON.stringify(parsed, null, indent);
	if (output === trimmed) { return { beautify: false, reason: 'already-formatted' }; }
	return { beautify: true, output, reason: 'ok' };
}

module.exports = { analyzePaste, MAX_BYTES };
