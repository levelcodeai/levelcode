// @ts-check
'use strict';

/*
 * sessionEvents.js — the pure translation between the live agent's provider MESSAGES and the stored
 * session EVENTS. It is the seam that lets extension.js stay thin glue: the agent loop hands us the
 * messages it already has; we hand back event objects to append (sessionStore.appendEvent) and, on
 * resume, rebuild the exact messages array back.
 *
 * Two guarantees, both tested:
 *   • VERBATIM & LOSSLESS. Events store provider message shapes as-is, so `eventsToMessages(...)` rebuilds
 *     a byte-identical array — verbatim resume sees precisely the conversation it left (design §4 rules).
 *   • The card data is DERIVED, not hand-passed. `toolStatsFromMessages` reads the sparkline (tool-calls
 *     per turn) and files-edited straight out of the turn's messages, so the extension never computes or
 *     duplicates them — one source of truth (the transcript).
 */

/** Tool names that MUTATE files → count as "edited" for the files-touched chip (not read/list/run). */
const EDIT_TOOLS = new Set(['edit_file', 'write_file']);

// ── read stats out of a turn's messages (pure) ───────────────────────────────────────────────────

/**
 * Walk a messages array and pull { tools, edits } from its assistant `tool_use` blocks:
 *   tools — total tool calls (the sparkline height for the turn);
 *   edits — one `{ path }` per edit_file/write_file call (repeats kept, so "most-edited" ordering survives).
 * Tolerant of any shape — a message without array content, a tool_use without input, etc.
 */
function toolStatsFromMessages(messages) {
	let tools = 0;
	const edits = [];
	for (const m of (Array.isArray(messages) ? messages : [])) {
		if (!m || m.role !== 'assistant' || !Array.isArray(m.content)) { continue; }
		for (const b of m.content) {
			if (!b || b.type !== 'tool_use') { continue; }
			tools++;
			if (EDIT_TOOLS.has(b.name) && b.input && typeof b.input.path === 'string') { edits.push({ path: b.input.path }); }
		}
	}
	return { tools, edits };
}

// ── build events to append (pure) ────────────────────────────────────────────────────────────────

/** The user turn: `content` for preview/title/turn-count, `messages` (verbatim) for the rebuild. */
function userTurnEvent(userMessage, t) {
	const content = userMessage && typeof userMessage.content === 'string' ? userMessage.content
		: (userMessage && userMessage.content != null ? userMessage.content : '');
	return { kind: 'user', t: t || null, content, messages: userMessage ? [userMessage] : [] };
}

/**
 * The agent turn: the NEW messages the loop produced this turn (assistant + tool_result messages),
 * stored verbatim, plus the model and the derived tool/edit stats the card reads.
 */
function agentTurnEvent(newMessages, model, t) {
	const msgs = Array.isArray(newMessages) ? newMessages : [];
	const { tools, edits } = toolStatsFromMessages(msgs);
	return { kind: 'agent', t: t || null, model: model || null, messages: msgs, tools, edits };
}

function endEvent(state, t) { return { kind: 'end', t: t || null, state: state || 'done' }; }
function titleEvent(title, t) { return { kind: 'title', t: t || null, title: String(title == null ? '' : title) }; }
/** A lifecycle/pin change — append-only, so archiving/pinning never rewrites the file (experience §4.9). */
function labelEvent(fields, t) {
	const e = { kind: 'label', t: t || null };
	if (fields && fields.lifecycle) { e.lifecycle = String(fields.lifecycle); }
	if (fields && typeof fields.pinned === 'boolean') { e.pinned = fields.pinned; }
	return e;
}

// ── rebuild messages on resume (pure — the verbatim guarantee) ───────────────────────────────────

/**
 * Concatenate the stored `messages` from every transcript event, in order, into the provider messages
 * array the agent loop resumes from. Non-transcript events (title/label/end/compact) carry no messages
 * and are skipped, so the rebuild is exactly the conversation — nothing more, nothing lost.
 */
function eventsToMessages(events) {
	const out = [];
	for (const e of (Array.isArray(events) ? events : [])) {
		if (e && Array.isArray(e.messages)) { for (const m of e.messages) { out.push(m); } }
	}
	return out;
}

/** How many messages are already persisted — so a per-turn append stores only the new tail, not the lot. */
function tailFrom(messages, storedCount) {
	const msgs = Array.isArray(messages) ? messages : [];
	const from = Number.isFinite(storedCount) && storedCount > 0 ? storedCount : 0;
	return msgs.slice(from);
}

module.exports = {
	EDIT_TOOLS,
	toolStatsFromMessages,
	userTurnEvent, agentTurnEvent, endEvent, titleEvent, labelEvent,
	eventsToMessages, tailFrom
};
