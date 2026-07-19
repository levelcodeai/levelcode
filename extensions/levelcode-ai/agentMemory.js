/*---------------------------------------------------------------------------------------------
 *  Pure transcript-surgery helpers for context compaction (see compactAgentMemory in extension.js).
 *  Kept dependency-free so the one property that matters — the spliced transcript is still VALID
 *  (no orphaned tool_use/tool_result pair, clean role alternation across the seam) — is unit-testable
 *  without booting the extension. extension.js owns the impure parts (the summary model call, posting).
 *--------------------------------------------------------------------------------------------*/
'use strict';

/** A "goal boundary": a user message with plain STRING content (a fresh user turn, never a tool_result).
 *  It is the only splice point that cannot orphan a tool_use/tool_result pair — tool results always sit
 *  in the message immediately after their tool_use, so any pair is wholly on one side of such a cut. */
function isGoalBoundary(m) {
	return !!(m && m.role === 'user' && typeof m.content === 'string');
}

/**
 * Choose where to cut a transcript for compaction: summarize messages[0..cut), keep [cut..] verbatim.
 * Aims to keep roughly the last `keepRecent` messages, snapping to a goal boundary so the kept tail
 * begins with a clean user turn. Returns a cut index in [2, len), or -1 when there is no safe cut
 * (transcript too short, or no goal boundary to land on).
 * @param {Array<{role:string, content:any}>} msgs
 * @param {number} keepRecent
 * @returns {number}
 */
function findCompactionCut(msgs, keepRecent) {
	if (!Array.isArray(msgs)) { return -1; }
	const len = msgs.length;
	if (len <= keepRecent + 2) { return -1; }
	// Prefer the first goal boundary at/after the keep mark; else the most recent boundary before it.
	let cut = Math.max(1, len - keepRecent);
	while (cut < len && !isGoalBoundary(msgs[cut])) { cut++; }
	if (cut >= len) { cut = Math.max(1, len - keepRecent); while (cut > 1 && !isGoalBoundary(msgs[cut])) { cut--; } }
	if (cut < 2 || cut >= len || !isGoalBoundary(msgs[cut])) { return -1; }
	return cut;
}

/** Rough token estimate for a message list — the house chars/4 heuristic, used only for the UI meter. */
function estimateMsgTokens(msgs) {
	if (!Array.isArray(msgs)) { return 0; }
	return Math.round(msgs.reduce((n, m) => n + JSON.stringify(m).length, 0) / 4);
}

module.exports = { isGoalBoundary, findCompactionCut, estimateMsgTokens };
