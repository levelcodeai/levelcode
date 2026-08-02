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

/**
 * @param {{ root: string, slug: string, projectPath: string,
 *           state?: { get: (k: string) => any, set: (k: string, v: any) => any } | null,
 *           now?: () => Date }} opts
 */
function createSessions(opts) {
	const root = opts.root, slug = opts.slug, projectPath = opts.projectPath;
	const state = opts.state || null;
	const clock = opts.now || (() => new Date());
	/** @type {{ id: string, file: string } | null} */
	let live = null;

	const iso = () => clock().toISOString();

	// Refresh this session's index row from its file. Best-effort: the index is a cache (scan rebuilds it),
	// so a failure here must never surface into a chat turn.
	function reindex() {
		if (!live) { return; }
		try {
			const s = store.readSession(live.file);
			const idx = store.loadIndex(root, slug);
			store.writeIndex(root, slug, store.upsertEntry(idx.entries, store.deriveEntry(s.meta, s.events)));
		} catch (e) { /* index is a rebuildable cache */ }
	}

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
		live = null;
		if (state) { try { state.set('liveSessionId', null); } catch (e) { /* convenience */ } }
	}

	/** The session index for this project (what the panel/view list). Empty (never throws) if unreadable. */
	function list() { try { return store.loadIndex(root, slug).entries; } catch (e) { return []; } }

	function liveId() { return live ? live.id : null; }

	return { ensure, recordTurn, seal, list, liveId };
}

module.exports = { createSessions };
