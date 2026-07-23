/*---------------------------------------------------------------------------------------------
 *  MCP wire protocol — the PURE half of the stdio client (see docs/MCP.md, S2).
 *
 *  MCP over stdio is JSON-RPC 2.0, one message per line. Two things here are genuinely easy to get
 *  wrong, so they live away from the process handling and are unit-tested (test/mcpProtocol.test.js):
 *
 *    1. FRAMING. Chunks off a pipe do not respect message boundaries — one `data` event may carry
 *       half a message, or three and a half. A framer that assumes "one chunk = one message" works
 *       right up until a server answers with a big tools/list. It must also SKIP unparseable lines:
 *       servers writing a stray log line to stdout instead of stderr is a well-known MCP footgun, and
 *       one such line must not desynchronise the stream.
 *    2. RESULT FLATTENING. A tool result is a list of typed content blocks (text / image / audio /
 *       resource), but the agent's tool_result is a plain STRING (agent.js coerces with String()).
 *       Non-text blocks have to degrade to a readable placeholder, and the whole thing must be CAPPED —
 *       the generic tool path has no size limit, so an unbounded result would silently eat the context
 *       window. read_file caps at 100 KB and run_command at 8 000 chars; this sits between them.
 *
 *  Pure + dependency-free: no child_process, no fs, no vscode. Nothing here does IO.
 *--------------------------------------------------------------------------------------------*/
'use strict';

// The revision we ASK for. Current stable as of 2026-07; `initialize` negotiates, and a server that
// answers with an older revision it supports is still fine — we do not hard-fail on a mismatch.
const PROTOCOL_VERSION = '2025-11-25';

// A tool result is injected into the transcript and re-sent on later turns, so bound it.
const RESULT_CAP = 24000;
// A single line bigger than this is a broken or hostile server, not a message.
const MAX_LINE = 4 * 1024 * 1024;

/** One JSON-RPC message, newline-terminated (stdio framing). */
function encode(msg) { return JSON.stringify(msg) + '\n'; }

/**
 * Incremental newline-delimited JSON reader.
 * `push(chunk)` returns the messages that chunk COMPLETED (possibly none, possibly several).
 * Unparseable lines are skipped, not fatal. Throws only if a single line exceeds maxLine, which means
 * the peer is not speaking the protocol — the caller should drop the connection.
 */
function createFramer(opts) {
	const maxLine = (opts && opts.maxLine) || MAX_LINE;
	let buf = '';
	return {
		push(chunk) {
			buf += String(chunk == null ? '' : chunk);
			const out = [];
			let i;
			while ((i = buf.indexOf('\n')) >= 0) {
				const line = buf.slice(0, i).trim();
				buf = buf.slice(i + 1);
				if (!line) { continue; }
				let msg;
				try { msg = JSON.parse(line); } catch { continue; }   // a stray log line must not desync us
				if (msg && typeof msg === 'object') { out.push(msg); }
			}
			if (buf.length > maxLine) {
				buf = '';
				throw new Error('MCP server sent more than ' + maxLine + ' bytes with no newline');
			}
			return out;
		},
		/** Bytes buffered but not yet terminated by a newline (diagnostics/tests). */
		get pending() { return buf.length; }
	};
}

/** The `initialize` params we send. Capabilities are deliberately empty: we consume tools, nothing more. */
function initializeParams(clientName, clientVersion) {
	return {
		protocolVersion: PROTOCOL_VERSION,
		capabilities: {},
		clientInfo: { name: clientName || 'LevelCode', version: clientVersion || '0.0.0' }
	};
}

/**
 * A `tools/call` result → the single string the agent's tool_result carries.
 * Mirrors the agent's error convention: a failure comes back as a string starting with `ERROR: `
 * (agent.js treats that prefix as the failure signal) rather than throwing.
 */
function flattenContent(result, opts) {
	const cap = (opts && opts.cap) || RESULT_CAP;
	if (result == null || typeof result !== 'object') { return '(no output)'; }
	const parts = [];
	for (const b of (Array.isArray(result.content) ? result.content : [])) {
		if (!b || typeof b !== 'object') { continue; }
		if (b.type === 'text') { if (typeof b.text === 'string') { parts.push(b.text); } continue; }
		if (b.type === 'image') { parts.push('[image' + (b.mimeType ? ' ' + b.mimeType : '') + ' omitted — the transcript is text]'); continue; }
		if (b.type === 'audio') { parts.push('[audio omitted — the transcript is text]'); continue; }
		if (b.type === 'resource') {
			const r = b.resource || {};
			if (typeof r.text === 'string') { parts.push(r.text); }
			else { parts.push('[resource ' + (r.uri || 'unknown') + ' omitted]'); }
			continue;
		}
		parts.push('[' + String(b.type || 'unknown') + ' content omitted]');
	}
	// Servers may answer with structuredContent and no text block at all.
	if (!parts.length && result.structuredContent !== undefined) {
		try { parts.push(JSON.stringify(result.structuredContent)); } catch { /* not serialisable */ }
	}
	let text = parts.join('\n').trim();
	if (text.length > cap) { text = text.slice(0, cap) + '\n…[MCP result truncated at ' + cap + ' chars]'; }
	if (result.isError) { return 'ERROR: ' + (text || 'the tool reported a failure'); }
	return text || '(no output)';
}

/** A JSON-RPC error object → a one-line message. */
function errorText(err) {
	if (!err || typeof err !== 'object') { return 'unknown error'; }
	const code = err.code != null ? ' (' + err.code + ')' : '';
	return String(err.message || 'error') + code;
}

module.exports = {
	encode, createFramer, initializeParams, flattenContent, errorText,
	PROTOCOL_VERSION, RESULT_CAP, MAX_LINE
};
