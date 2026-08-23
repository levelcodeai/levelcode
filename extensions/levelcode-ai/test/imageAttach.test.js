/*---------------------------------------------------------------------------------------------
 *  Attaching an image — the composer contract and the host seam. run: node test/imageAttach.test.js
 *
 *  Source-extraction, in the house style: the webview's logic lives inline in chat.html and cannot
 *  be required, so the invariants that no DOM test would catch are pinned against the source.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'media', 'chat.html'), 'utf8');
const ext = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');

let n = 0;
function test(name, fn) { fn(); n++; console.log('  ok - ' + name); }

/** Balanced-brace body of a named function, so a rule is read in its own scope. */
function fnBody(src, name) {
	const i = src.indexOf('function ' + name + '(');
	assert.ok(i >= 0, 'no function ' + name);
	const open = src.indexOf('{', i);
	let depth = 0;
	for (let j = open; j < src.length; j++) {
		if (src[j] === '{') { depth++; }
		else if (src[j] === '}') { depth--; if (!depth) { return src.slice(open, j + 1); } }
	}
	assert.fail('unbalanced braces in ' + name);
}

test('CAP: the long edge cap is 2000 — the value Claude Code ships, not a guess', () => {
	// Measured from Claude Code's own transcripts: every image it re-encodes is 2000 on the long
	// edge. It is also the threshold the vision docs name for staying clear of the stricter
	// per-image dimension limit above 20 images per request.
	const m = /const IMG_CAP = (\d+);/.exec(html);
	assert.ok(m, 'IMG_CAP is gone');
	assert.strictEqual(m[1], '2000');
});

test('NEVER UPSCALE, and never re-encode what did not need resizing', () => {
	const body = fnBody(html, 'normalizeImage');
	assert.match(body, /Math\.min\(1,\s*IMG_CAP\s*\/\s*Math\.max\(w,\s*h\)\)/,
		'the scale must be clamped at 1 — upscaling costs bytes and tokens and adds nothing');
	assert.match(body, /if \(scale === 1\)/, 'there must be a pass-through branch');
	// The pass-through must forward the ORIGINAL file, in its original type.
	const passthrough = body.slice(body.indexOf('if (scale === 1)'), body.indexOf('const tw ='));
	assert.match(passthrough, /media_type:\s*file\.type/, 'pass-through must keep the source format');
	assert.match(passthrough, /blobToBase64\(file\)/, 'pass-through must forward the ORIGINAL bytes');
	assert.ok(!/canvas|drawImage|convertToBlob/i.test(passthrough),
		're-encoding an image that did not need resizing only stacks compression artifacts');
});

test('FORMATS: only what Claude accepts, and the webview and the store agree', () => {
	const inWebview = (/const IMG_OK = \{([^}]*)\}/.exec(html) || [, ''])[1];
	for (const t of ['image/png', 'image/jpeg', 'image/gif', 'image/webp']) {
		assert.ok(inWebview.includes(t), 'webview should accept ' + t);
	}
	assert.ok(!/image\/svg|image\/tiff|image\/bmp/.test(inWebview), 'only the four Claude reads');
	const store = fs.readFileSync(path.join(__dirname, '..', 'imageStore.js'), 'utf8');
	for (const t of ['image/png', 'image/jpeg', 'image/gif', 'image/webp']) {
		assert.ok(store.includes("'" + t + "'"), 'store should accept ' + t);
	}
});

test('PASTE: a text paste is untouched; only an image paste is intercepted', () => {
	const i = html.indexOf("input.addEventListener('paste'");
	assert.ok(i > 0, 'no paste handler');
	const body = html.slice(i, i + 900);
	assert.match(body, /if \(!imgs\.length\) \{ return; \}/,
		'a paste with no image must fall through to normal text pasting');
	assert.ok(body.indexOf('if (!imgs.length) { return; }') < body.indexOf('preventDefault'),
		'preventDefault must come AFTER the no-image bail, or plain text pasting breaks');
});

test('REFUSAL: a blind model refuses BEFORE anything typed is lost', () => {
	// The composer clears on send, so refusing host-side would throw away what they wrote. The
	// capability rides with the model instead, and the refusal happens at attach time.
	const body = fnBody(html, 'attachImageFiles');
	assert.match(body, /if \(!canSeeImages\)/, 'no vision gate at attach time');
	assert.ok(body.indexOf('if (!canSeeImages)') < body.indexOf('normalizeImage'),
		'refuse before doing the decode work, not after');
	assert.match(body, /cannot read images/, 'the refusal must say what is wrong');
	assert.match(body, /Switch to a vision model/, '…and what to do about it');
	assert.match(ext, /canSeeImages: supportsVisionForModel\(/, 'the host must publish the capability');
	assert.strictEqual((ext.match(/canSeeImages: supportsVisionForModel\(/g) || []).length, 2,
		'both config paths — gateway and BYOK — must publish it, or one of them silently allows');
});

test('BUDGET: a per-turn image count, enforced where images are added', () => {
	const body = fnBody(html, 'attachImageFiles');
	assert.match(body, /IMG_MAX_PER_TURN/, 'no per-turn cap');
	assert.match(body, /break;/, 'the cap must stop the loop, not just warn');
	assert.match(body, /the rest were not attached/, 'silently dropping attachments is the bug pattern');
});

test('SEND: an image with no words is a valid message', () => {
	const body = fnBody(html, 'doSend');
	assert.match(body, /if \(!t && !pendingImages\.length\) return;/,
		'"look at this" is implied by attaching — an image alone must be sendable');
	assert.match(body, /images: imgs/, 'the send payload must carry the images');
	assert.match(body, /clearImages\(\)/, 'the tray must empty on send, or the next turn re-sends them');
});

test('HOST: images become refs in the conversation, and bytes only at request time', () => {
	assert.match(ext, /case 'send': await handleSend\(msg\.text, msg\.images\)/, 'send must carry images');
	const store = fnBody(ext, 'storeImages');
	assert.match(store, /imageStore\.put\(/, 'bytes must go through the store');
	assert.match(store, /type: 'image', ref/, 'the conversation must keep a ref, never the base64');
	assert.ok(!/base64/.test(store.replace(/im\.base64/g, '')), 'no base64 should be retained host-side');

	// A copy, not a mutation: agentMessages persists across runs and is what recordTurn writes.
	const w = fnBody(ext, 'withImages');
	assert.match(w, /msgs\.map\(/, 'withImages must map to a new array');
	assert.match(w, /\{ \.\.\.msg, content:/, 'and copy each touched message rather than mutating it');
	assert.ok(!/msg\.content\[|\.content\s*=/.test(w), 'must not write into the caller\'s messages');
	for (const site of ['withImages(conversation)', 'withImages(agentMessages)']) {
		assert.ok(ext.includes(site), 'the request must materialize at: ' + site);
	}
});

test('CONVERSATION: blocks only when there is an image', () => {
	const body = fnBody(ext, 'handleSend');
	assert.match(body, /imageBlocks\.length\s*\n?\s*\?\s*\{ role: 'user', content: \[\.\.\.imageBlocks/,
		'images lead the block array');
	assert.match(body, /:\s*\{ role: 'user', content: userContent \}/,
		'a text-only turn must stay a plain string, or every cached prefix churns');
});

test('AGENT MODE: the default path carries images too', () => {
	// I shipped this broken. handleSend stored the bytes and then early-returned into agentFlow(text),
	// which never saw them — so in the DEFAULT mode a pasted screenshot was written to disk and
	// dropped. The exact silent-drop failure this whole feature exists to prevent.
	assert.match(ext, /if \(agentMode\) \{ await agentFlow\(text, imageBlocks\); return; \}/,
		'agent mode must forward the image blocks');
	assert.match(ext, /async function agentFlow\(text, imageBlocks\)/, 'agentFlow must accept them');
	const body = fnBody(ext, 'agentFlow');
	assert.match(body, /imageBlocks && imageBlocks\.length/, 'and use them when present');
	assert.match(body, /content: \[\.\.\.imageBlocks, \{ type: 'text', text \}\]/, 'images lead the goal');
	assert.match(body, /:\s*\{ role: 'user', content: text \}/,
		'a text-only goal must stay a plain string, or every cached agent prefix churns');
});

test('NO WORKSPACE: an image still has somewhere to live', () => {
	// v1.1.0 deliberately made the agent answer with no folder open. Refusing a screenshot in that
	// state would re-introduce the limitation that release removed.
	const body = fnBody(ext, 'imageRoot');
	assert.match(body, /sessionsManager\(\)/, 'prefer the project session dir when there is one');
	assert.match(body, /_no-workspace/, 'and fall back when there is not');
	assert.ok(!/Images need a session/.test(ext), 'the old session-required refusal must be gone');
});

console.log('\nimageAttach: ' + n + ' tests passed.');
