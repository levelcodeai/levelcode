/*---------------------------------------------------------------------------------------------
 *  Image geometry + cost — run: node test/imageCost.test.js
 *
 *  The load-bearing test here is DOC PARITY: every worked example in the vision documentation,
 *  reproduced. If these drift, the context meter is lying and the UI is showing the user a size
 *  the server will not actually use.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

const assert = require('assert');
const C = require('../imageCost');

let n = 0;
function test(name, fn) { fn(); n++; console.log('  ok - ' + name); }

test('PATCHES: cost is a ceiling division on each axis, independently', () => {
	assert.strictEqual(C.visualTokens(28, 28), 1);
	assert.strictEqual(C.visualTokens(29, 28), 2, 'one pixel over buys a whole column of patches');
	assert.strictEqual(C.visualTokens(28, 29), 2, '…and a whole row');
	assert.strictEqual(C.visualTokens(1092, 1092), 1521);
	assert.strictEqual(C.visualTokens(0, 100), 0);
});

test('DOC PARITY: every worked example in the vision docs, both tiers', () => {
	// [w, h, standard "WxH/tokens", high-res "WxH/tokens"]
	const rows = [
		[1092, 1092, '1092x1092/1521', '1092x1092/1521'],
		[1000, 1000, '1000x1000/1296', '1000x1000/1296'],
		[1920, 1080, '1456x819/1560', '1920x1080/2691'],
		[3840, 2160, '1456x819/1560', '2576x1449/4784'],
		[200, 200, '200x200/64', '200x200/64']
	];
	for (const [w, h, std, hi] of rows) {
		const a = C.fitToTier(w, h, 'standard'), b = C.fitToTier(w, h, 'high');
		assert.strictEqual(`${a.w}x${a.h}/${a.tokens}`, std, `standard tier, ${w}x${h}`);
		assert.strictEqual(`${b.w}x${b.h}/${b.tokens}`, hi, `high-res tier, ${w}x${h}`);
	}
});

test('CAPS: nothing escapes its tier, at any source size', () => {
	for (const [w, h] of [[8000, 8000], [8000, 200], [200, 8000], [4032, 3024], [3024, 1964]]) {
		for (const tier of ['standard', 'high']) {
			const r = C.fitToTier(w, h, tier);
			assert.ok(r.tokens <= C.TIERS[tier].tokens, `${w}x${h} ${tier}: ${r.tokens} over the token cap`);
			assert.ok(Math.max(r.w, r.h) <= C.TIERS[tier].edge, `${w}x${h} ${tier}: over the long-edge cap`);
		}
	}
});

test('NEVER UPSCALE: a small source comes back untouched', () => {
	// Writing the plan, `sips -Z 1568` GREW a 1160x480 capture from 40KB to 89KB by scaling it up
	// to meet the cap. Upscaling costs bytes and tokens and adds no information.
	for (const [w, h] of [[100, 50], [1160, 480], [1568, 1018], [2576, 1449]]) {
		const hi = C.fitToTier(w, h, 'high');
		assert.ok(hi.w <= w && hi.h <= h, `${w}x${h} was scaled UP to ${hi.w}x${hi.h}`);
		assert.strictEqual(C.clientScale(w, h, 4000), 1, 'a cap above the source must be a no-op');
		const t = C.clientTarget(w, h, 4000);
		assert.deepStrictEqual([t.w, t.h, t.scaled], [w, h, false]);
	}
});

test('ASPECT: downscaling preserves the ratio to within a pixel', () => {
	for (const [w, h] of [[3840, 2160], [3024, 1964], [4032, 3024], [1920, 1200]]) {
		const r = C.fitToTier(w, h, 'high');
		assert.ok(Math.abs((r.w / r.h) - (w / h)) < 0.01, `${w}x${h} -> ${r.w}x${r.h} skewed the aspect`);
	}
});

test('CLIENT CAP: scale is a no-op at 1, so the caller can skip re-encoding', () => {
	// A factor of exactly 1 is the signal to forward the ORIGINAL bytes. Re-encoding an untouched
	// image only stacks compression artifacts, worst on the screenshots of text people paste.
	assert.strictEqual(C.clientScale(1000, 800, 1568), 1);
	assert.strictEqual(C.clientTarget(1000, 800, 1568).scaled, false);
	const t = C.clientTarget(3840, 2160, 1568);
	assert.deepStrictEqual([t.w, t.h, t.scaled], [1568, 882, true]);
	assert.strictEqual(C.clientScale(3840, 2160, 0), 1, 'cap 0 means no cap, not a zero-size image');
});

test('TIER: 4.7-and-later is high-res; anything unrecognised is standard, never the reverse', () => {
	for (const id of ['claude-opus-5', 'claude-sonnet-5', 'anthropic/claude-opus-4-8', 'claude-fable-5']) {
		assert.strictEqual(C.tierFor(id), 'high', id);
	}
	for (const id of ['claude-opus-4-6', 'gpt-4o', 'some-unknown-model', '', null]) {
		assert.strictEqual(C.tierFor(id), 'standard', String(id));
	}
});

test('METER: an image block costs its real visual tokens, not its JSON length', () => {
	// The bug this replaces: estimateMsgTokens is JSON.stringify(m).length / 4, which charges a
	// base64 image about a third of its BYTE count — a 1MB screenshot books ~333,000 phantom
	// tokens, more than most context windows, and the compaction cut evicts real history.
	const block = { type: 'image', ref: 'a'.repeat(64), w: 3840, h: 2160, media_type: 'image/png' };
	assert.strictEqual(C.imageBlockTokens(block, 'claude-opus-5'), 4784);
	assert.strictEqual(C.imageBlockTokens(block, 'gpt-4o'), 1560, 'standard tier costs less');

	const naive = Math.round(JSON.stringify(block).length / 4);
	assert.ok(C.imageBlockTokens(block, 'claude-opus-5') > naive * 10,
		'a ref is ~18 tokens by JSON length and ~4784 in reality — the meter must not under-count either');

	assert.strictEqual(C.imageBlockTokens({ type: 'text', text: 'hi' }, 'claude-opus-5'), 0);
	assert.strictEqual(C.imageBlockTokens(null, 'claude-opus-5'), 0);
});

test('METER: an image of unknown size is charged the cap, never zero', () => {
	// A missing dimension must fail toward over-counting. Charging zero would let a conversation
	// full of images look empty to the compaction cut.
	assert.strictEqual(C.imageBlockTokens({ type: 'image', ref: 'x' }, 'claude-opus-5'), 4784);
	assert.strictEqual(C.imageBlockTokens({ type: 'image', ref: 'x', w: 100 }, 'gpt-4o'), 1568);
});

console.log('\nimageCost: ' + n + ' tests passed.');
