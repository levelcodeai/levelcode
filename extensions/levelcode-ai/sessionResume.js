// @ts-check
'use strict';

/*
 * sessionResume.js — pure logic for resuming a stored session into a live model context.
 *
 * The three-tier rule (docs/levelcode-sessions-experience.md §4.5, spine §resume): a saved chat is
 * stored VERBATIM and losslessly; summarization is used at exactly ONE moment — fitting an old
 * conversation back into a finite context window on resume — and never to store. This module decides
 * which tier a resume needs and, when it must summarize, WHERE to cut so a tool_use/tool_result pair is
 * never orphaned. It is pure (no vscode, no LLM call): it produces a PLAN the caller executes.
 *
 *   Tier 1 — verbatim.        stored tokens ≤ budget → replay the messages as they were.
 *   Tier 2 — incremental.     over budget, a prior `compact` briefing exists → reuse it + the tail.
 *   Tier 3 — compact-on-resume. over budget, no briefing → summarize the head, keep the tail verbatim.
 *
 * Token estimation matches the rest of the extension: chars / 4 (see agent.js systemTokensEst).
 */

const CHARS_PER_TOKEN = 4;
const DEFAULT_BUDGET_PCT = 40;  // sessions.resumeBudgetPct — share of the window resume may fill
const DEFAULT_KEEP_TAIL = 8;    // how many recent user-turns stay verbatim when compacting

// ── token estimate (pure) ────────────────────────────────────────────────────────────────────────

function contentChars(content) {
	if (content == null) { return 0; }
	if (typeof content === 'string') { return content.length; }
	try { return JSON.stringify(content).length; } catch { return 0; }
}

/** Rough token estimate of a provider `messages` array — chars/4, the same heuristic the agent uses. */
function estimateTokens(messages) {
	if (!Array.isArray(messages)) { return 0; }
	let chars = 0;
	for (const m of messages) { chars += contentChars(m && m.content); }
	return Math.round(chars / CHARS_PER_TOKEN);
}

/** The token budget a resume may spend: a share (default 40%) of the model's context window. */
function resumeBudget(contextWindow, pct) {
	const w = Number(contextWindow) > 0 ? Number(contextWindow) : 0;
	const p = Number.isFinite(pct) ? pct : DEFAULT_BUDGET_PCT;
	return Math.max(0, Math.round((w * p) / 100));
}

// ── the tool-pair-safe cut boundary (pure — the tricky bit) ──────────────────────────────────────

/**
 * A "turn start" is a user message carrying a REAL prompt (string content, or blocks that aren't only
 * tool_result). A user message that is only tool_result blocks is the second half of the previous
 * assistant turn's tool call, NOT a new turn — cutting there would orphan the pair. So we only ever cut
 * immediately BEFORE a turn start, which keeps every tool_use with its tool_result.
 */
function isTurnStart(msg) {
	if (!msg || msg.role !== 'user') { return false; }
	if (typeof msg.content === 'string') { return true; }
	if (Array.isArray(msg.content)) { return msg.content.some((b) => b && b.type !== 'tool_result'); }
	return false;
}

function turnStartIndices(messages) {
	const idx = [];
	for (let i = 0; i < messages.length; i++) { if (isTurnStart(messages[i])) { idx.push(i); } }
	return idx;
}

/**
 * The index at which the verbatim TAIL begins: keep the last `keepTailTurns` user turns intact, cut the
 * head before that. Returns 0 when there is nothing safe to cut (fewer turns than the tail budget, or no
 * turn starts at all) — i.e. "keep everything". The head is `[0, cut)`, the tail is `[cut, end)`; because
 * `cut` always lands on a turn start, neither side ever splits a tool_use/tool_result pair.
 */
function pickCutBoundary(messages, keepTailTurns) {
	if (!Array.isArray(messages) || messages.length === 0) { return 0; }
	const keep = Number.isFinite(keepTailTurns) && keepTailTurns > 0 ? keepTailTurns : DEFAULT_KEEP_TAIL;
	const starts = turnStartIndices(messages);
	if (starts.length <= keep) { return 0; } // whole conversation is within the tail — nothing to cut
	return starts[starts.length - keep];
}

// ── the plan (pure) ──────────────────────────────────────────────────────────────────────────────

/**
 * Decide how to resume `messages` into a model of window `contextWindow`. Returns a PLAN:
 *   { tier, storedTokens, budget, load, ... }
 *     tier 1 → { load:'verbatim' }
 *     tier 2 → { load:'incremental', reusePriorBriefing:true, cutIndex, tail, tailTokens }  (a prior briefing exists)
 *     tier 3 → { load:'compact', cutIndex, head, tail, headTokens, tailTokens }             (summarize head)
 * The caller runs the actual summarization on `head` (tier 3) or reuses the stored briefing (tier 2); this
 * module never calls a model. `paidCompactOverTokens` marks whether tier 3 crosses the confirm-cost line.
 */
function planResume(messages, opts) {
	const o = opts || {};
	const msgs = Array.isArray(messages) ? messages : [];
	const storedTokens = estimateTokens(msgs);
	const budget = resumeBudget(o.contextWindow, o.budgetPct);

	if (storedTokens <= budget) {
		return { tier: 1, storedTokens, budget, load: 'verbatim' };
	}

	const cutIndex = pickCutBoundary(msgs, o.keepTailTurns);
	const head = msgs.slice(0, cutIndex);
	const tail = msgs.slice(cutIndex);
	const headTokens = estimateTokens(head);
	const tailTokens = estimateTokens(tail);
	const confirmOver = Number.isFinite(o.confirmCompactOverTokens) ? o.confirmCompactOverTokens : Infinity;

	if (o.hasCompact) {
		// A prior briefing already covers the head — reuse it and load only the tail (still may be tuned
		// by the caller if the tail alone is over budget, but that is the caller's follow-up).
		return { tier: 2, storedTokens, budget, load: 'incremental', reusePriorBriefing: true,
			cutIndex, tail, tailTokens, needsPaidCompact: false };
	}

	return { tier: 3, storedTokens, budget, load: 'compact', cutIndex,
		head, tail, headTokens, tailTokens, needsPaidCompact: headTokens > confirmOver };
}

// ── the honest UI line (pure) ────────────────────────────────────────────────────────────────────

/** The first-class "we summarized to fit" line (§4.5). Empty for a verbatim resume (nothing to say). */
function describeResume(plan, turnsSummarized) {
	if (!plan || plan.tier === 1) { return ''; }
	const n = Number.isFinite(turnsSummarized) ? turnsSummarized : null;
	const head = plan.tier === 2 ? 'Resumed from an earlier summary' : 'Resumed from a summary';
	return n != null ? `${head} of ${n} earlier turn${n === 1 ? '' : 's'} · view full transcript`
		: `${head} · view full transcript`;
}

module.exports = {
	CHARS_PER_TOKEN, DEFAULT_BUDGET_PCT, DEFAULT_KEEP_TAIL,
	estimateTokens, resumeBudget, isTurnStart, turnStartIndices, pickCutBoundary,
	planResume, describeResume
};
