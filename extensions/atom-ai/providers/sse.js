/*---------------------------------------------------------------------------------------------
 *  Atom++ — AI · shared streaming helper
 *  Line reader for server-sent-event style response bodies, shared by every streaming adapter
 *  (Anthropic, OpenAI-compatible). Works with the Node (undici) fetch body used by the
 *  extension host. Kept as a leaf module so adapters can require it without a cycle.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

/**
 * Read a fetch Response body as UTF-8 lines, invoking onLine for each complete line.
 * @param {any} res
 * @param {(line:string)=>void} onLine
 */
async function readLines(res, onLine) {
	let buf = '';
	for await (const chunk of res.body) {
		buf += Buffer.from(chunk).toString('utf8');
		let idx;
		while ((idx = buf.indexOf('\n')) >= 0) {
			const line = buf.slice(0, idx);
			buf = buf.slice(idx + 1);
			onLine(line);
		}
	}
	if (buf.length) { onLine(buf); }
}

module.exports = { readLines };
