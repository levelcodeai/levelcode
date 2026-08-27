/*---------------------------------------------------------------------------------------------
 *  Pure transcript-surgery helpers for context compaction (see compactAgentMemory in extension.js).
 *  Kept dependency-free so the one property that matters — the spliced transcript is still VALID
 *  (no orphaned tool_use/tool_result pair, clean role alternation across the seam) — is unit-testable
 *  without booting the extension. extension.js owns the impure parts (the summary model call, posting).
 *--------------------------------------------------------------------------------------------*/
'use strict';


const { imageBlockTokens } = require('./imageCost');
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

/**
 * Rough token estimate for a message list — the house chars/4 heuristic, used only for the UI meter.
 *
 * Images are counted by their real visual cost, not by their JSON. chars/4 is sound for text and
 * wrong for an image in whichever shape it takes: inline base64 books about a third of its byte
 * count (a 1MB screenshot reads as ~333,000 tokens, more than most context windows, for something
 * that really costs ~4,800), and a stored ref swings the other way — 64 hex characters read as ~18
 * tokens for the same ~4,800. Both would make the meter lie about how much room is left.
 *
 * `modelId` picks the resolution tier; omitting it costs the standard tier, which over-counts
 * rather than under-counts. See imageCost.js.
 */
function estimateMsgTokens(msgs, modelId) {
	if (!Array.isArray(msgs)) { return 0; }
	let chars = 0;
	let imageTokens = 0;
	for (const m of msgs) {
		if (!m) { continue; }
		if (!Array.isArray(m.content)) { chars += JSON.stringify(m).length; continue; }
		chars += 24;   // role + envelope, roughly what the object costs around its blocks
		for (const b of m.content) {
			if (b && b.type === 'image') { imageTokens += imageBlockTokens(b, modelId); }
			else { chars += JSON.stringify(b).length; }
		}
	}
	return Math.round(chars / 4) + imageTokens;
}

module.exports = { isGoalBoundary, findCompactionCut, estimateMsgTokens };
