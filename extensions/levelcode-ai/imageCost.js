/*---------------------------------------------------------------------------------------------
 *  Image geometry and cost — the arithmetic behind attaching a screenshot.
 *
 *  Pure: no canvas, no fs, no vscode. The webview does the actual pixel work; this decides what
 *  the pixel work should aim for, and tells the context meter what the result costs.
 *
 *  THE NUMBERS ARE NOT ESTIMATES. Claude sees images as 28x28 patches, so an image costs
 *  ceil(w/28) * ceil(h/28) visual tokens, and each model tier caps both the long edge and the
 *  token count, downscaling past either. This module reproduces every worked example in the
 *  vision documentation: 1092^2 -> 1521, 1000^2 -> 1296, 1920x1080 -> 2691 (high-res) / 1456x819
 *  at 1560 (standard), 3840x2160 -> 2576x1449 at 4784. test/imageCost.test.js pins all of them.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

/** One visual token per 28x28 patch, ceiling on each axis independently. */
const PATCH = 28;

/**
 * Per-tier limits. High-res is Claude 4.7 and later; everything else is standard.
 * Both are enforced server-side — an image over either limit is downscaled before the model sees
 * it, which is why sending more pixels than this buys latency rather than fidelity.
 */
const TIERS = {
	high: { edge: 2576, tokens: 4784 },
	standard: { edge: 1568, tokens: 1568 }
};

/** Visual tokens for an image at these dimensions. */
function visualTokens(w, h) {
	if (!(w > 0) || !(h > 0)) { return 0; }
	return Math.ceil(w / PATCH) * Math.ceil(h / PATCH);
}

/** Which tier a model id lands in. Unknown -> standard, so we never UNDER-count a cost. */
function tierFor(modelId) {
	const id = String(modelId || '').toLowerCase();
	// Claude 4.7+ (including the 5 line) is the high-resolution tier.
	if (/claude-(opus|sonnet|fable|mythos)-5/.test(id)) { return 'high'; }
	if (/claude-opus-4-(7|8|9)/.test(id)) { return 'high'; }
	return 'standard';
}

/**
 * What the server will actually process, given a source size and a tier.
 *
 * The rule is the largest scale (never above 1) whose patch grid fits the tier's token cap, with
 * the long edge bounded too. Binary search rather than stepping the scale down: a step-down loop
 * lands a few pixels short and misreports the size, which matters because this is also what the
 * UI shows the user.
 *
 * NEVER SCALES UP. A source already inside both limits comes back untouched — upscaling costs
 * bytes and tokens and adds no information.
 */
function fitToTier(w, h, tier) {
	const t = TIERS[tier] || TIERS.standard;
	if (!(w > 0) || !(h > 0)) { return { w: 0, h: 0, tokens: 0, scaled: false }; }

	let hi = Math.min(1, t.edge / Math.max(w, h));
	const at = (s) => [Math.round(w * s), Math.round(h * s)];

	if (visualTokens(...at(hi)) <= t.tokens) {
		const [ow, oh] = at(hi);
		return { w: ow, h: oh, tokens: visualTokens(ow, oh), scaled: hi < 1 };
	}
	let lo = 0;
	for (let i = 0; i < 60; i++) {
		const mid = (lo + hi) / 2;
		if (visualTokens(...at(mid)) <= t.tokens) { lo = mid; } else { hi = mid; }
	}
	const [ow, oh] = at(lo);
	return { w: ow, h: oh, tokens: visualTokens(ow, oh), scaled: true };
}

/**
 * The scale the CLIENT should apply before sending, for a configured long-edge cap.
 *
 * Separate from fitToTier on purpose. The server caps cost whatever we do, so this is not a
 * safety measure — it is a deliberate fidelity-for-cost trade the user can configure, and a
 * defence against the wire (bytes, latency, the request size limit).
 *
 * Returns exactly 1 when nothing should happen, so the caller can skip re-encoding entirely and
 * forward the original bytes. Re-encoding an untouched image only stacks compression artifacts,
 * which is worst on the screenshots of text that are most of what gets pasted.
 */
function clientScale(w, h, cap) {
	if (!(cap > 0) || !(w > 0) || !(h > 0)) { return 1; }
	return Math.min(1, cap / Math.max(w, h));
}

/** Apply clientScale, rounded to whole pixels. Never larger than the source. */
function clientTarget(w, h, cap) {
	const s = clientScale(w, h, cap);
	return s === 1 ? { w, h, scaled: false } : { w: Math.round(w * s), h: Math.round(h * s), scaled: true };
}

/**
 * What one image block costs the context meter.
 *
 * This exists because estimateMsgTokens measures JSON.stringify().length / 4, which is sound for
 * text and catastrophic for an image: base64 books about a third of its byte count as tokens, so a
 * 1MB screenshot reads as ~333,000 — larger than most context windows — for something that really
 * costs ~4,800. With bytes on disk and only a ref in the message the same estimator swings the
 * other way and under-counts a ~1800-token image as ~18. Both are wrong; this is the number.
 *
 * Scope, checked rather than assumed (a reviewer caught an earlier overstatement): today this only
 * misreports the UI meter — findCompactionCut cuts on message count and goal boundaries and never
 * reads a token number. It becomes a correctness bug the day anything automatic keys off it.
 */
function imageBlockTokens(block, modelId) {
	if (!block || block.type !== 'image') { return 0; }
	const w = Number(block.w) || 0, h = Number(block.h) || 0;
	if (!w || !h) { return TIERS[tierFor(modelId)].tokens; }   // unknown size: assume the cap, never zero
	return fitToTier(w, h, tierFor(modelId)).tokens;
}

module.exports = { PATCH, TIERS, visualTokens, tierFor, fitToTier, clientScale, clientTarget, imageBlockTokens };
