// @ts-check
'use strict';

/*
 * sessions.js — the live-session lifecycle manager: turns the chat/agent loop's turns into a persisted,
 * append-only session on disk, and back. It is the thin seam between extension.js and the pure engine
 * (sessionStore + sessionEvents), and it is deliberately vscode-FREE: its deps (root/slug/projectPath, an
 * optional workspaceState-like pointer, and the clock) are injected, so the lifecycle unit-tests against a
 * temp directory like sessionStore does. extension.js just calls ensure/recordTurn/seal/list at four points.
 *
 * The one subtlety it handles: `agentMessages` in the loop is a TRIMMED live window, but a session must be
 * the FULL append-only history. So recordTurn is handed only THIS turn's new messages (the caller snapshots
 * the array length before the turn and slices after) and appends them — every turn is persisted verbatim
 * before the next turn can trim it away. Nothing here ever throws into a chat: index writes are best-effort
 * (the index is a rebuildable cache) and seal/pointer updates are guarded.
 */

const store = require('./sessionStore');
const events = require('./sessionEvents');
const planner = require('./sessionResume');
const memory = require('./sessionMemory');

/**
 * @param {{ root: string, slug: string, projectPath: string,
 *           state?: { get: (k: string) => any, set: (k: string, v: any) => any } | null,
 *           memory?: boolean, now?: () => Date }} opts
 */
function createSessions(opts) {
	const root = opts.root, slug = opts.slug, projectPath = opts.projectPath;
	const state = opts.state || null;
	const memoryOn = opts.memory !== false;   // cross-session memory: journal a line on seal (off → skip)
	const clock = opts.now || (() => new Date());
	/** @type {{ id: string, file: string } | null} */
	let live = null;

	const iso = () => clock().toISOString();

	// Refresh a session's index row from its file. Best-effort: the index is a cache (scan rebuilds it), so
	// a failure here must never surface into a chat turn. Works for any id, so lifecycle actions on a past
	// (non-live) session update the list too.
	function reindexId(id) {
		if (!id) { return; }
		try {
			const s = store.readSession(store.sessionFile(root, slug, id));
			const idx = store.loadIndex(root, slug);
			store.writeIndex(root, slug, store.upsertEntry(idx.entries, store.deriveEntry(s.meta, s.events)));
		} catch (e) { /* index is a rebuildable cache */ }
	}
	function reindex() { if (live) { reindexId(live.id); } }

	/** Open a fresh session (its dir + meta birth line) if none is live. Idempotent while one is live. */
	function ensure() {
		if (live) { return live; }
		const id = store.newSessionId(clock());
		store.createSession(root, slug, id, projectPath, iso(), null);
		live = { id, file: store.sessionFile(root, slug, id) };
		if (state) { try { state.set('liveSessionId', id); } catch (e) { /* pointer is a convenience */ } }
		reindex(); // a meta-only row, so even a one-message crash lists
		return live;
	}

	/**
	 * Persist ONE turn — the new messages the loop produced this turn (goal + the agent's messages). The
	 * leading user message becomes a `user` event (turn count / title / preview); the rest a verbatim
	 * `agent` event (sparkline + files-edited derive from it). Creates the session on the first turn.
	 */
	function recordTurn(turnMessages, model) {
		ensure();
		const msgs = Array.isArray(turnMessages) ? turnMessages : [];
		if (!msgs.length) { return; }
		if (msgs[0] && msgs[0].role === 'user') {
			store.appendEvent(live.file, events.userTurnEvent(msgs[0], iso()));
			const rest = msgs.slice(1);
			if (rest.length) { store.appendEvent(live.file, events.agentTurnEvent(rest, model, iso())); }
		} else {
			store.appendEvent(live.file, events.agentTurnEvent(msgs, model, iso()));
		}
		reindex();
	}

	/** Seal the live session (append its terminal state, finalize the row) and clear the live pointer. */
	function seal(endState) {
		if (!live) { return; }
		try { store.appendEvent(live.file, events.endEvent(endState || 'done', iso())); reindex(); } catch (e) { /* best-effort */ }
		if (memoryOn) {
			// Cross-session memory: one journal line per sealed session (deterministic outcome now; a cheap-lane
			// model pass refines the summary later). Best-effort — memory must never disturb sealing a chat.
			try {
				const s = store.readSession(live.file);
				memory.appendJournal(root, slug, memory.outcomeEntry(store.deriveEntry(s.meta, s.events), iso()));
				consolidate();   // refresh MEMORY.md from the now-updated journal
			} catch (e) { /* memory is best-effort */ }
		}
		live = null;
		if (state) { try { state.set('liveSessionId', null); } catch (e) { /* convenience */ } }
	}

	/**
	 * Reopen a past session as the LIVE one. Rebuilds its full transcript, plans how much fits the model's
	 * window (three-tier, §4.5), and re-attaches so further turns append to THIS session. Returns:
	 *   full     — the whole conversation (for the visible replay),
	 *   messages — the budget-fitted subset the model resumes with (== full for a verbatim/tier-1 resume),
	 *   plan     — the resume plan (tier + cut), note — the honest "resumed from a summary" line, entry.
	 * null if the session is gone/unreadable. Append-only: the prior `end` event is harmless (rebuild skips
	 * it, and the next turn's events simply extend the history).
	 */
	function resume(id, opts) {
		let s;
		try { s = store.readSession(store.sessionFile(root, slug, id)); } catch (e) { return null; }
		const full = events.eventsToMessages(s.events);
		const plan = planner.planResume(full, opts || {});
		const messages = plan.tier === 1 ? full : (Array.isArray(plan.tail) ? plan.tail : full);
		const head = full.slice(0, plan.cutIndex || 0);
		const turnsSummarized = head.filter((m) => m && m.role === 'user').length;
		live = { id, file: store.sessionFile(root, slug, id) };
		if (state) { try { state.set('liveSessionId', id); } catch (e) { /* convenience */ } }
		reindexId(id);
		return { id, meta: s.meta, entry: store.deriveEntry(s.meta, s.events), full, messages, plan,
			turns: events.toDisplayTurns(full),   // the readable transcript to replay in the webview
			note: planner.describeResume(plan, turnsSummarized) };
	}

	// Append-only lifecycle edits (§4.9): each writes one event, then refreshes that id's index row. All
	// best-effort (return false rather than throw) — a History edit must never disrupt anything.
	function appendTo(id, event) {
		try { store.appendEvent(store.sessionFile(root, slug, id), event); reindexId(id); return true; }
		catch (e) { return false; }
	}
	/** Completion = ARCHIVE (reversible, keeps the work), never delete. Drops out of the active list. */
	function archive(id) { return appendTo(id, events.labelEvent({ lifecycle: 'archived' }, iso())); }
	/** Soft delete — moves to the `trashed` lifecycle (reversible, append-only; the file is left on disk). */
	function trash(id) { return appendTo(id, events.labelEvent({ lifecycle: 'trashed' }, iso())); }
	/** Bring an archived/trashed session back into the active list — the Undo behind Done/Delete. */
	function restore(id) { return appendTo(id, events.labelEvent({ lifecycle: 'active' }, iso())); }
	function setPinned(id, on) { return appendTo(id, events.labelEvent({ pinned: !!on }, iso())); }
	function rename(id, title) {
		if (title == null || !String(title).trim()) { return false; }
		return appendTo(id, events.titleEvent(String(title).trim(), iso()));
	}

	/**
	 * Fade stale sessions out of the working set (§4.9 — "auto-archive at 30 days, keep the magic"): archive
	 * every ACTIVE, non-pinned, non-live session whose last activity is older than `days`. Pinned means
	 * "keep" (exempt); already archived/trashed are skipped; the live session is never touched. Append-only
	 * (a label event each) — it NEVER deletes — and best-effort. Returns how many it archived.
	 */
	function autoArchiveStale(opts) {
		const o = opts || {};
		const days = Number.isFinite(o.days) && o.days > 0 ? o.days : 30;
		const nowMs = Number.isFinite(o.nowMs) ? o.nowMs : clock().getTime();
		const cutoff = nowMs - days * 86400000;
		const liveNow = live ? live.id : null;
		let archived = 0;
		for (const e of list()) {
			if (!e || e.pinned || e.id === liveNow) { continue; }
			if ((e.lifecycle || 'active') !== 'active') { continue; }
			const last = Date.parse(e.updatedAt || e.createdAt || '');
			if (Number.isFinite(last) && last < cutoff && archive(e.id)) { archived++; }
		}
		return archived;
	}

	/** The always-on memory digest (recent + pinned outcomes) built from this project's journal. Empty on error. */
	function digest(opts) {
		try { return memory.buildDigest(memory.readJournal(root, slug), Object.assign({ nowMs: clock().getTime() }, opts)); }
		catch (e) { return { recently: [], pinned: [], total: 0 }; }
	}
	/**
	 * On-demand recall: past-session outcomes matching a query — ranked by journal metadata (summary/title/
	 * files, all sessions) AND a bounded DEEP scan of recent transcripts, so a match that lives only in the
	 * conversation (never the one-line summary) is still found and returns a cited snippet. Empty on error.
	 */
	function recall(query, opts) {
		const o = opts || {};
		const limit = Number.isFinite(o.limit) && o.limit > 0 ? o.limit : 6;
		const scanMax = Number.isFinite(o.scanMax) ? o.scanMax : 40;   // bound the deep transcript reads
		try {
			const entries = memory.latestBySession(memory.readJournal(root, slug));   // newest-first
			const terms = memory.queryTerms(query);
			if (!terms.length) { return []; }
			const metaIds = new Set(memory.recallRank(entries, query, { limit: entries.length }).map((e) => e.id));
			const hits = [];
			let scanned = 0;
			for (const e of entries) {
				let snippet = '';
				if (scanned < scanMax) {
					scanned++;
					try {
						const turns = events.toDisplayTurns(events.eventsToMessages(store.readSession(store.sessionFile(root, slug, e.id)).events));
						snippet = memory.snippetFor(turns, terms);
					} catch (err) { /* a gone/corrupt session just yields no snippet */ }
				}
				const score = (metaIds.has(e.id) ? 2 : 0) + (snippet ? 1 : 0);   // a metadata hit weighs more than a body hit
				if (score > 0) { hits.push(Object.assign({}, e, { score, snippet })); }
			}
			hits.sort((a, b) => b.score - a.score || String(b.at || '').localeCompare(String(a.at || '')));
			return hits.slice(0, limit);
		} catch (e) { return []; }
	}
	/** All current memory outcomes (one per session, newest-first) — what the memory panel lists. */
	function memoryItems() { try { return memory.latestBySession(memory.readJournal(root, slug)); } catch (e) { return []; } }
	/**
	 * Forget a session's memory contribution: a tombstone that drops it from the digest/recall/panel while
	 * the session itself stays in History. Append-only + re-consolidate MEMORY.md. Best-effort.
	 */
	function forget(id) {
		if (!id) { return false; }
		try { memory.appendJournal(root, slug, { v: memory.SCHEMA_V, id: String(id), at: iso(), forgotten: true }); consolidate(); return true; }
		catch (e) { return false; }
	}
	/** The deterministic consolidation pass: rewrite MEMORY.md from the current journal. Returns the digest. */
	function consolidate(opts) {
		const o = Object.assign({ nowMs: clock().getTime() }, opts);
		let d = { recently: [], pinned: [], total: 0 };
		try {
			d = memory.buildDigest(memory.readJournal(root, slug), o);
			memory.writeMemoryMd(root, slug, memory.digestMarkdown(d, { asOf: iso().slice(0, 10) }));
		} catch (e) { /* memory is best-effort */ }
		return d;
	}
	/** The full message transcript of a session, read-only (for a post-hoc outcome summary). Empty on error. */
	function transcript(id) {
		try { return events.eventsToMessages(store.readSession(store.sessionFile(root, slug, id)).events); }
		catch (e) { return []; }
	}
	/**
	 * Replace a session's journal summary with a refined (model-written) outcome — append a superseding line
	 * for that id (latestBySession then wins) and re-consolidate MEMORY.md. Append-only; best-effort.
	 */
	function refineSummary(id, summary) {
		if (!id || summary == null || !String(summary).trim()) { return false; }
		try {
			const latest = memory.latestBySession(memory.readJournal(root, slug)).find((e) => e.id === id);
			if (!latest) { return false; }
			memory.appendJournal(root, slug, Object.assign({}, latest, { summary: String(summary).trim(), refined: true }));
			consolidate();
			return true;
		} catch (e) { return false; }
	}
	/** Where this project's memory lives (for opening it — the transparency promise). */
	function memoryPaths() { return { dir: memory.memoryDir(root, slug), journal: memory.journalFile(root, slug), memoryMd: memory.memoryMdFile(root, slug) }; }

	/** The session index for this project (what the panel/view list). Empty (never throws) if unreadable. */
	function list() { try { return store.loadIndex(root, slug).entries; } catch (e) { return []; } }

	function liveId() { return live ? live.id : null; }

	return { ensure, recordTurn, seal, resume, archive, trash, restore, setPinned, rename, autoArchiveStale, digest, consolidate, transcript, refineSummary, recall, memoryItems, forget, memoryPaths, list, liveId };
}

module.exports = { createSessions };
