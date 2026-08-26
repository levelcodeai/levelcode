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
	assert.match(body, /were not attached/, 'silently dropping attachments is the bug pattern');
	assert.match(body, /remove one to add another/, 'and it must say how to make room');
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
	assert.match(body, /\[\.\.\.imageBlocks, \{ type: 'text', text: userContent \}\]/,
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
	assert.match(body, /\[\.\.\.imageBlocks, \{ type: 'text', text \}\]/, 'images lead the goal');
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

test('400: an image with no words must not emit an empty text block', () => {
	// Anthropic rejects it outright — "text content blocks must be non-empty" — and an image sent
	// with no words produced exactly that. Both paths must omit the block rather than send "".
	const send = fnBody(ext, 'handleSend');
	assert.match(send, /userContent \? \[\.\.\.imageBlocks/, 'handleSend must gate the text block on there being text');
	assert.match(send, /:\s*imageBlocks\b/, 'handleSend must fall back to the images alone');

	const agent = fnBody(ext, 'agentFlow');
	assert.match(agent, /text \? \[\.\.\.imageBlocks/, 'agentFlow must gate the text block on there being text');
	assert.match(agent, /:\s*imageBlocks\b/, 'agentFlow must fall back to the images alone');
});

test('CSP: the webview is allowed to render a data: image, and nothing else', () => {
	// default-src 'none' blocks every image, which is why the first thumbnail rendered broken.
	const csp = fnBody(ext, 'webviewCsp');
	assert.match(csp, /"img-src data:"/, 'attached images cannot render without this');
	assert.ok(!/img-src[^"]*https:/.test(csp), 'the panel must not be able to fetch a remote image');
});

test('PICKER + DROP: a Finder file reaches the same normalizer as a paste', () => {
	// VS Code's workbench intercepts OS file drops before a webview iframe sees them, so
	// dataTransfer.files is usually empty for a Finder drag while the PATH is still there.
	assert.match(html, /getData\('text\/uri-list'\)/, 'no uri-list fallback for the VS Code drop case');
	assert.match(html, /type: 'attachImagePaths'/, 'paths must be handed to the host to read');
	assert.match(ext, /case 'attachImagePaths'/, 'the host must accept them');
	assert.match(ext, /case 'pickImages'/, 'and offer a picker that works regardless');
	assert.match(ext, /showOpenDialog\(/, 'the picker must be a real file dialog');

	const reader = fnBody(ext, 'attachImagePaths');
	assert.match(reader, /25 \* 1024 \* 1024/, 'guard the size BEFORE base64 crosses the message bus');
	assert.match(reader, /is not an image LevelCode can read/, 'a non-image must say so, not fail silently');
	assert.match(html, /function b64ToFile/, 'host bytes must become a File so both routes share normalizeImage');
	assert.match(html, /id="attachImg"/, 'there must be a visible way in besides paste');
});

test('FINDER DROP: the workbench wins, so the recovery is one click from where it lands', () => {
	// VS Code's workbench takes an OS file drop and OPENS the file before a webview iframe sees any
	// event — the drop handler inside the panel never fires, and the uri-list fallback with it. The
	// image the user meant to attach is therefore sitting in a tab. Offer it there.
	const pick = fnBody(ext, 'pickImages');
	assert.match(pick, /openImageTabs\(\)/, 'the picker must offer images already open in tabs');
	assert.match(pick, /\(b\.active \? 1 : 0\) - \(a\.active \? 1 : 0\)/,
		'the active tab is the one they just dropped — it must come first');
	assert.match(pick, /showOpenDialog\(/, 'and still fall through to a real file dialog');

	const tabs = fnBody(ext, 'openImageTabs');
	assert.match(tabs, /uri\.scheme !== 'file'/, 'only real files on disk can be read');
	assert.match(tabs, /IMAGE_EXTS\.test/, 'and only images');
	assert.match(tabs, /seen\.has\(uri\.fsPath\)/, 'the same file open in two groups must appear once');

	// A button on the image tab's own title bar: that is where the drop lands.
	const pkg = require('../package.json');
	const menu = pkg.contributes.menus['editor/title']
		.find((m) => m.command === 'levelcode.ai.attachImage');
	assert.ok(menu, 'no attach button on the image editor title bar');
	assert.match(menu.when, /png|jpe\?g/, 'it must only appear for images');
	assert.match(menu.group, /^navigation/, 'in navigation, or it hides under the overflow menu');
	assert.ok(pkg.contributes.commands.some((c) => c.command === 'levelcode.ai.attachImage' && c.icon),
		'the command needs an icon to render as a button');
});

test('REMOVE: the image × is not stolen by the generic chip handler', () => {
	// The image × carries BOTH `x` and `imgx`, and both handlers assign .onclick rather than adding a
	// listener — so whichever registers last silently wins. It did: clicking × posted removeContext
	// with a null id and the image stayed attached. Excluded by selector, not by ordering, so it
	// cannot come back the next time these two blocks move relative to each other.
	const body = fnBody(html, 'renderChips');
	assert.match(body, /querySelectorAll\('\.x:not\(\.imgx\)'\)/,
		'the generic chip handler must exclude image chips, or it overwrites the remove handler');
	assert.match(body, /querySelectorAll\('\.imgx'\)/, 'image chips need their own handler');
	assert.match(body, /removeImage\(/, '…which must actually remove the image');

	// Focusable by keyboard, so it must be activatable by keyboard — reachable-but-dead is worse
	// than not reachable.
	assert.match(body, /onkeydown/, 'the × is role=button tabindex=0 and needs a key handler');
	assert.match(body, /'Enter' \|\| e\.key === ' '/, 'Enter and Space both activate a button');

	const rm = fnBody(html, 'removeImage');
	assert.match(rm, /pendingImages\.filter/, 'remove must drop it from the pending list');
	assert.match(rm, /renderChips\(\)/, 'and re-render, or the chip stays on screen');
});

test('CAP: one setting, honoured on every route in, and visible before it bites', () => {
	// Each image is ~1,800-3,000 input tokens, so a maxed message is a five-figure prompt before a
	// word is typed. The number must be the SAME everywhere or one route quietly allows more.
	const pkg = require('../package.json');
	const setting = pkg.contributes.configuration.properties['levelcode.ai.chat.maxImagesPerMessage'];
	assert.ok(setting, 'no setting for the image cap');
	assert.strictEqual(setting.default, 5);

	// Clamped in code, not just in the settings editor — a hand-edited settings.json is unchecked.
	const clamp = fnBody(ext, 'maxImagesPerMessage');
	assert.match(clamp, /n < 1/, 'a zero or negative cap must not disable attaching entirely');
	assert.match(clamp, /Math\.min\(Math\.floor\(n\), 20\)/, 'and it must be bounded above');

	// Every route in uses it: the host path (drop + picker) and the webview path (paste + drop).
	assert.match(ext, /\.slice\(0, maxImagesPerMessage\(\)\)/, 'the host path must use the setting');
	assert.ok(!/slice\(0, 8\)/.test(ext), 'a hardcoded cap must not survive beside the setting');
	assert.strictEqual((ext.match(/maxImages: maxImagesPerMessage\(\)/g) || []).length, 2,
		'both config paths must publish it, or one silently keeps the old default');
	assert.match(html, /pendingImages\.length >= IMG_MAX_PER_TURN/,
		'the webview cap must be CUMULATIVE, not per-batch');
	assert.match(fnBody(html, 'syncAttachImgBtn'), /Image limit reached/,
		'the cap should be visible on the button before it refuses anything');
});

test('UX: an attachment problem is reported where it happened, not in a corner toast', () => {
	// This used to post to the host and surface as a VS Code notification in the far corner of the
	// window — seconds later, a long way from the paste, and outliving the moment it described.
	const body = fnBody(html, 'note');
	assert.match(body, /getElementById\('imgnote'\)/, 'the notice must render in the composer');
	assert.ok(!/postMessage/.test(body), 'it must no longer be thrown to a global notification');
	assert.match(body, /setTimeout/, 'and it must clear itself rather than linger over the next try');
	assert.match(html, /id="imgnote"/, 'the notice element is missing from the composer');
	assert.match(html, /aria-live="polite"/, 'a screen reader must hear it too');
});

test('UX: a chip appears the instant you paste, before the decode finishes', () => {
	// Decoding and re-encoding a 4K screenshot takes long enough to read as "nothing happened".
	const body = fnBody(html, 'attachImageFiles');
	assert.match(body, /loading: true/, 'no placeholder chip while the image is being prepared');
	assert.ok(body.indexOf('loading: true') < body.indexOf('await normalizeImage'),
		'the placeholder must go in BEFORE the work, or it is not feedback');
	assert.match(body, /at < 0.*continue|if \(at < 0\)/s,
		'an image removed mid-decode must stay removed, not reappear when its bytes arrive');
	assert.match(body, /pendingImages\.filter/, 'a failed image must not leave its placeholder behind');
	assert.match(fnBody(html, 'imgChip'), /im\.loading/, 'the chip must render the loading state');
});

test('UX: the chip says what the image will cost, compactly', () => {
	// This product meters credits per turn and an image is not a rounding error. Someone deciding
	// whether to attach three should see that before they send, not after they are billed.
	const chip = fnBody(html, 'imgChip');
	assert.match(chip, /imgTokens\(im\.w, im\.h\)/, 'the chip must compute a real token cost');
	assert.match(chip, /toFixed\(1\) \+ 'k'/, 'compact on the chip — full width wraps the tray');
	assert.match(chip, /input tokens/, 'the exact figure belongs in the tooltip');

	const t = fnBody(html, 'imgTokens');
	assert.match(t, /Math\.ceil\(w \/ 28\) \* Math\.ceil\(h \/ 28\)/, 'must be the real 28px patch formula');
	assert.match(t, /4784/, 'and clamped to the tier ceiling the server enforces anyway');
});

test('UX: a thumbnail can be opened full size, and closed again', () => {
	// A 28px thumb cannot tell you WHICH screenshot you attached — the one thing worth checking
	// before sending.
	assert.match(html, /id="imgzoom"/, 'no full-size view');
	assert.match(html, /aria-modal="true"/, 'the overlay should announce itself as a dialog');
	const z = fnBody(html, 'closeZoom');
	assert.match(z, /src = ''/, 'closing must drop the src, or the bytes stay live in the DOM');
	assert.match(html, /e\.key === 'Escape'/, 'Escape must close it');
	assert.match(html, /classList\.contains\('msgimg'\)/, 'transcript images must open too, not just the tray');
});

console.log('\nimageAttach: ' + n + ' tests passed.');
