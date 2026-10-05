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

/**
 * A diagram the chat drew this turn (docs/RICH-DIAGRAMS.md, "Storage"): the FINAL record — the spec
 * as it was rendered, after the repair ladder, with its status and what was fixed or lost. Stored so
 * that reopening the session shows exactly the picture it showed before without validating, fixing or
 * asking a model again. It carries no `messages`, so it never enters the rebuilt conversation.
 */
function diagramEvent(record, t) { return { kind: 'diagram', t: t || null, record: record }; }

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

/**
 * Every diagram a session drew, in the order they were drawn. A later record for the same id wins
 * (append-only: nothing is rewritten, so an update is a second line).
 */
function diagramsFromEvents(events) {
	const byId = new Map();
	for (const e of (Array.isArray(events) ? events : [])) {
		const r = e && e.kind === 'diagram' ? e.record : null;
		if (r && typeof r === 'object' && typeof r.id === 'string') { byId.delete(r.id); byId.set(r.id, r); }
	}
	return Array.from(byId.values());
}

/** The tool whose calls draw diagrams — named here (not imported) so this module stays dependency-free. */
const DIAGRAM_TOOL = 'render_diagram';

// ── the readable transcript for a resume replay (pure) ───────────────────────────────────────────

/** The human-visible text of a provider message: a string as-is, or the joined `text` blocks of an array. */
function messageText(content) {
	if (content == null) { return ''; }
	if (typeof content === 'string') { return content; }
	if (Array.isArray(content)) {
		return content.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n\n');
	}
	return '';
}

/**
 * Fold a rebuilt messages array into the readable conversation to REPLAY on resume: one entry per user
 * prompt and per assistant answer, in order. Tool plumbing is dropped — a user message that is only a
 * `tool_result`, and an assistant turn that is only `tool_use` (no prose) — so the replay reads like the
 * chat did, not like the raw transcript. Pure, so the webview never has to know provider message shapes.
 *
 * With `diagrams` (the session's stored records), each diagram comes back as a turn of its own —
 * `{ role: 'diagram', key, record }` — at the place in the answer where the model drew it. A drawing
 * that a later one replaced is left out, as it was on screen. Without `diagrams` the result is exactly
 * what it always was: prose only.
 */
function toDisplayTurns(messages, diagrams) {
	const out = [];
	const records = Array.isArray(diagrams) ? diagrams : [];
	const byKey = new Map(records.filter((r) => r && r.key).map((r) => [String(r.key), r]));
	const replaced = new Set(records.filter((r) => r && r.replaces).map((r) => String(r.replaces)));
	for (const m of (Array.isArray(messages) ? messages : [])) {
		if (!m || (m.role !== 'user' && m.role !== 'assistant')) { continue; }
		// a user message whose content is purely tool_result blocks is plumbing, not something the user typed
		if (m.role === 'user' && Array.isArray(m.content) && m.content.length && m.content.every((b) => b && b.type === 'tool_result')) { continue; }
		const text = messageText(m.content);
		if (text.trim()) { out.push({ role: m.role, text }); }   // (an assistant turn that was only tool calls has none)
		if (m.role === 'assistant' && byKey.size && Array.isArray(m.content)) {
			for (const b of m.content) {
				const r = b && b.type === 'tool_use' && b.name === DIAGRAM_TOOL ? byKey.get(String(b.id)) : null;
				if (r && !replaced.has(String(r.id))) { out.push({ role: 'diagram', key: String(r.key), record: r }); }
			}
		}
	}
	return out;
}

/** How many messages are already persisted — so a per-turn append stores only the new tail, not the lot. */
function tailFrom(messages, storedCount) {
	const msgs = Array.isArray(messages) ? messages : [];
	const from = Number.isFinite(storedCount) && storedCount > 0 ? storedCount : 0;
	return msgs.slice(from);
}

/**
 * Render a session as a clean Markdown transcript — the "Copy as Markdown" export
 * (levelcode-sessions-experience.md §6), and the seed of a later share-a-run.
 *
 * SCRUBBED, not raw. levelcode-chat-sessions-design.md §10 is explicit: transcripts at rest are the
 * same trust class as your code, but "anything that later *shares* a session must scrub — that is
 * that feature's burden." Export IS the first sharing surface — the doc's own framing is
 * paste-into-a-PR — so the redaction added for project memory is applied here too. A credential
 * pasted into chat to ask about it must not ride along into a pull request.
 *
 * STRUCTURE: bold role labels and a rule between turns, deliberately NOT headings. A turn's own text
 * routinely contains `## …` and fenced code; heading-based roles would be visually outranked by the
 * content they are supposed to delimit, and an `###` label looks broken next to a reply that opens
 * with `#`. Bold + `---` survives every renderer and every nesting depth.
 *
 * @param {{title?:string, id?:string, model?:string, createdAt?:string, updatedAt?:string,
 *          filesEdited?:string[], turns?:number}} meta  a sessionStore index entry
 * @param {Array<{role:string, content:any}>} messages   the session's messages
 * DIAGRAMS: a diagram the session drew is exported where it stood, as a fenced block of whatever
 * `opts.diagram(record)` returns — the caller passes Mermaid, which GitHub and most docs sites render
 * natively, so a transcript pasted into a pull request shows the picture. It is scrubbed like any
 * other text: a label is free text too.
 *
 * @param {{redact?:(s:string)=>string, now?:string, diagrams?:any[],
 *          diagram?:(record:any)=>({lang:string, body:string}|null)}} [opts]  `redact` and `diagram`
 *          are injected so this module stays dependency-free and both are visible at the call site
 */
function toMarkdown(meta, messages, opts) {
	const m = meta || {};
	const o = opts || {};
	const scrub = typeof o.redact === 'function' ? o.redact : (s) => s;
	const turns = toDisplayTurns(messages, o.diagrams).filter((t) => t.role !== 'diagram' || (t.record && t.record.spec));

	const title = scrub(String(m.title || 'Untitled session')).trim() || 'Untitled session';
	const when = String(m.updatedAt || m.createdAt || '').slice(0, 10);
	const files = (Array.isArray(m.filesEdited) ? m.filesEdited : []).map((f) => scrub(String(f)));

	// One subtitle line of provenance. Everything on it is optional — an export of a session that
	// never named a model or touched a file should read as a transcript, not as a form with blanks.
	const bits = [];
	if (when) { bits.push(when); }
	const spoken = turns.filter((t) => t.role !== 'diagram').length;   // a diagram is part of an answer, not a turn of its own
	bits.push(spoken + ' turn' + (spoken === 1 ? '' : 's'));
	if (m.model) { bits.push('`' + scrub(String(m.model)) + '`'); }
	if (files.length) { bits.push(files.slice(0, 6).map((f) => '`' + f + '`').join(', ')); }

	let md = '# ' + title + '\n\n';
	md += '_LevelCode session · ' + bits.join(' · ') + '_\n';

	for (const t of turns) {
		if (t.role === 'diagram') {
			// Under the answer it belongs to — no rule, no second speaker label.
			const title = scrub(String((t.record.spec && t.record.spec.title) || 'Diagram')).replace(/\s+/g, ' ').trim();
			let block = null;
			try { block = typeof o.diagram === 'function' ? o.diagram(t.record) : null; } catch (e) { block = null; }
			if (block && block.body) {
				const body = scrub(String(block.body)).replace(/\n+$/, '');
				// a fence one backtick longer than any run inside it, so nothing in a label can close it early
				const longest = (body.match(/`+/g) || []).reduce((k, run) => Math.max(k, run.length), 0);
				const fence = '`'.repeat(Math.max(3, longest + 1));
				md += '\n' + fence + String(block.lang || '').replace(/[^a-z0-9-]/gi, '') + '\n' + body + '\n' + fence + '\n';
			} else {
				md += '\n_[diagram: ' + title + ']_\n';
			}
			continue;
		}
		md += '\n---\n\n**' + (t.role === 'user' ? 'You' : 'LevelCode') + '**\n\n';
		// Verbatim aside from redaction — NOT trimmed. Trimming changes Markdown semantics: it de-indents a
		// leading 4-space (indented code block) and eats trailing "  " (a hard line break). The `**role**\n\n`
		// above already supplies the blank line an indented block needs after it.
		md += scrub(String(t.text)) + '\n';
	}
	// An empty session still exports — a file with a header and no turns is a truthful answer, and
	// silently producing nothing would read as a broken button.
	return md;
}

module.exports = {
	EDIT_TOOLS,
	toolStatsFromMessages,
	userTurnEvent, agentTurnEvent, diagramEvent, endEvent, titleEvent, labelEvent,
	eventsToMessages, diagramsFromEvents, DIAGRAM_TOOL, messageText, toDisplayTurns, tailFrom, toMarkdown
};
