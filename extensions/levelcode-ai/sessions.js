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
const imageStore = require('./imageStore');

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

	/**
	 * FORK a session (experience doc §6): a NEW session seeded with a copy of this one's conversation,
	 * leaving the original completely untouched — "the what-if-I'd-told-it-to-do-X-instead branch".
	 *
	 * Fork-from-END, deliberately. §411 settles the scoping question: "fork-from-end first; per-turn
	 * fork rides the transcript picker later." Forking from an arbitrary turn needs a UI for choosing
	 * the turn, and that is a different piece of work from the copy itself.
	 *
	 * WHICH EVENTS TRAVEL is the whole design here, and the answer is not "all of them":
	 *   • `user` / `agent` / `assistant`  — YES. This is the conversation; it is the thing being forked.
	 *   • `title`                         — YES, then overridden below, so the fork is recognisable in a
	 *                                       list where it would otherwise be a second row with the
	 *                                       identical name.
	 *   • `end`                           — NO. That is the original's terminal state. Copying it would
	 *                                       make a live fork claim it had already finished, and
	 *                                       deriveEntry would render it `done` while you typed into it.
	 *   • `label`                         — NO. Lifecycle and pinning belong to the ORIGINAL. A fork of
	 *                                       an archived session must arrive active, or it is born
	 *                                       invisible in the default Active scope; a fork of a pinned
	 *                                       one must not silently take up a second pin.
	 *
	 * Returns the new id, or null if the source is gone/unreadable. The caller resumes it — a fork IS a
	 * resume, just into a copy — so nothing here duplicates the replay logic.
	 */
	function fork(id) {
		let s;
		try { s = store.readSession(store.sessionFile(root, slug, id)); }
		catch (e) { return null; }

		const src = store.deriveEntry(s.meta, s.events);
		const newId = store.newSessionId(clock());
		try {
			// The meta records what it came from — provenance is the honesty guarantee everywhere else
			// in this system (§4), and it is also what a later branch-graph would draw from.
			store.createSession(root, slug, newId, projectPath, iso(), null, id);
			const file = store.sessionFile(root, slug, newId);
			for (const e of (Array.isArray(s.events) ? s.events : [])) {
				if (!e || e.kind === 'end' || e.kind === 'label') { continue; }
				store.appendEvent(file, e);
			}
			// Last, so it wins: deriveEntry takes the LATEST title event.
			const base = src.title || 'Untitled';
			store.appendEvent(file, events.titleEvent(/\(fork\)\s*$/.test(base) ? base : base + ' (fork)', iso()));
			live = { id: newId, file };
			if (state) { try { state.set('liveSessionId', newId); } catch (e2) { /* convenience */ } }
			reindexId(newId);
			return newId;
		} catch (e) { return null; }
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
		try {
			const d = memory.buildDigest(memory.readJournal(root, slug), Object.assign({ nowMs: clock().getTime() }, opts));
			d.facts = memory.activeFacts(memory.readFacts(root, slug));
			return d;
		} catch (e) { return { recently: [], pinned: [], total: 0, facts: [] }; }
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
	/**
	 * Facts matching a query, INCLUDING the ones that decayed out of the always-on digest (§4:
	 * "Decayed ≠ deleted — it's still in Recall"). Separate from recall() because they are a
	 * different kind of answer — a curated truth, not "here is a session where that came up" — and
	 * the caller labels them differently.
	 */
	function recallFacts(query, opts) {
		try { return memory.recallFacts(memory.readFacts(root, slug), query, opts || {}); }
		catch (e) { return []; }
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
	/** The consolidation pass: rewrite MEMORY.md from the current journal + facts. Returns the digest. */
	function consolidate(opts) {
		const o = Object.assign({ nowMs: clock().getTime() }, opts);
		let d = { recently: [], pinned: [], total: 0, facts: [] };
		try {
			d = memory.buildDigest(memory.readJournal(root, slug), o);
			d.facts = memory.activeFacts(memory.readFacts(root, slug));
			memory.writeMemoryMd(root, slug, memory.digestMarkdown(d, { asOf: iso().slice(0, 10) }));
		} catch (e) { /* memory is best-effort */ }
		return d;
	}
	/** Record candidate durable facts observed in a session (extracted by the summarizer). Re-consolidates. */
	function recordFacts(sourceId, texts) {
		const arr = (Array.isArray(texts) ? texts : []).map((t) => String(t == null ? '' : t).trim()).filter(Boolean).slice(0, 3);
		if (!arr.length) { return false; }
		try { memory.appendFacts(root, slug, arr.map((t) => memory.factObservation(t, sourceId, iso()))); consolidate(); return true; }
		catch (e) { return false; }
	}
	/** All folded facts (active + inferred) — what the memory panel lists. */
	function factsList() { try { return memory.foldFacts(memory.readFacts(root, slug)); } catch (e) { return []; } }
	/** Confirm ('confirm') or mark not-true ('remove') a fact by its normalized key. Re-consolidates. */
	function factAction(key, action) {
		if (!key) { return false; }
		try { memory.appendFacts(root, slug, memory.factControl(key, action, iso())); consolidate(); return true; }
		catch (e) { return false; }
	}
	/** Supersede an old fact because a newer session made it obsolete (§4 conflict). Keeps `byText` as history. */
	function supersedeFact(oldKey, byText) {
		if (!oldKey) { return false; }
		try { memory.appendFacts(root, slug, memory.factControl(oldKey, 'supersede', iso(), byText)); consolidate(); return true; }
		catch (e) { return false; }
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
			// Model output summarizing a transcript that contained repo files, command output and MCP
			// results — redact before it lands in journal.jsonl and, from there, MEMORY.md.
			memory.appendJournal(root, slug, Object.assign({}, latest, { summary: memory.redactSecrets(String(summary).trim()), refined: true }));
			consolidate();
			return true;
		} catch (e) { return false; }
	}
	/** Where this project's memory lives (for opening it — the transparency promise). */
	function memoryPaths() { return { dir: memory.memoryDir(root, slug), journal: memory.journalFile(root, slug), memoryMd: memory.memoryMdFile(root, slug) }; }
	/**
	 * Where attached images live: `media/` beside this project's sessions.
	 *
	 * PROJECT-scoped, not session-scoped, and nothing removes a file when a session goes away —
	 * sessions are append-only and `trash()` only writes a lifecycle event. `sweepMedia()` below is
	 * what actually bounds this.
	 */
	function mediaRoot() { return { root, slug }; }

	/**
	 * Delete images no session in this project refers to any more, and that are old enough not to
	 * belong to a live conversation. Returns { removed, bytes }; never throws.
	 */
	function sweepMedia(maxAgeMs) {
		try {
			const keep = new Set();
			for (const entry of list()) {
				for (const ref of imageStore.refsIn(transcript(entry.id) || [])) { keep.add(ref); }
			}
			return imageStore.sweep(root, slug, keep, maxAgeMs);
		} catch (e) { return { removed: 0, bytes: 0 }; }
	}

	/** The session index for this project (what the panel/view list). Empty (never throws) if unreadable. */
	function list() { try { return store.loadIndex(root, slug).entries; } catch (e) { return []; } }

	function liveId() { return live ? live.id : null; }

	return { ensure, recordTurn, seal, resume, fork, archive, trash, restore, setPinned, rename, autoArchiveStale, digest, consolidate, transcript, refineSummary, recall, recallFacts, memoryItems, forget, recordFacts, factsList, factAction, supersedeFact, memoryPaths, mediaRoot, sweepMedia, list, liveId };
}

module.exports = { createSessions };
