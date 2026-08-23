/*---------------------------------------------------------------------------------------------
 *  Pasted images on disk — content-addressed, beside the session that used them.
 *
 *  LOCAL, SESSION-ATTACHED. Nothing is uploaded. A screenshot of someone's proprietary code
 *  never leaves their machine, which is also the only shape that works for BYOK, where the
 *  editor talks to the provider directly and a detour through our infrastructure would both add
 *  a failure mode and contradict the promise that we are not in the middle.
 *
 *  WHY A SIBLING DIRECTORY RATHER THAN INLINE BASE64. Claude Code inlines image bytes in its
 *  own JSONL transcript and that works fine there. It does not work here, and the reason is
 *  specific to this codebase: sessionStore.scanProject readFileSync + JSON.parses EVERY session
 *  file in a project whenever index.json is missing, malformed, or on an older schema — which
 *  happens on first run and after any schema bump. Inlined bytes would make drawing a list of
 *  session titles parse every screenshot in every session. Refs keep that scan cheap, keep the
 *  transcript greppable, and dedupe the re-paste that follows a failed send.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/** Claude accepts exactly these. Anything else is refused before it reaches a provider. */
const MEDIA_EXT = {
	'image/png': 'png',
	'image/jpeg': 'jpg',
	'image/gif': 'gif',
	'image/webp': 'webp'
};

/**
 * Per-image ceiling. The Claude API's own limit is 10MB of base64 (5MB on Bedrock and Vertex),
 * and base64 inflates by 4/3 — so 5MB of BYTES is the largest thing that is safe everywhere.
 * Normalization should keep real pastes far under this; the cap is for the pathological file.
 */
const MAX_BYTES = 5 * 1024 * 1024;

function mediaDir(root, slug) { return path.join(root, slug, 'media'); }
function refPath(root, slug, ref) { return path.join(mediaDir(root, slug), ref); }

/** true for a ref this module could have produced — 64 hex chars, a known extension, no path parts. */
function isRef(ref) {
	return typeof ref === 'string' && /^[0-9a-f]{64}\.(png|jpg|gif|webp)$/.test(ref);
}

/**
 * Store bytes and return the ref that identifies them.
 *
 * Content-addressed: the same screenshot pasted twice is one file, which is exactly what happens
 * when someone re-pastes after a send fails. Writing is skipped when the file already exists, so
 * a duplicate paste costs a hash and a stat.
 */
function put(root, slug, base64, mediaType) {
	const ext = MEDIA_EXT[mediaType];
	if (!ext) { throw new Error('imageStore: unsupported media type: ' + String(mediaType)); }
	const buf = Buffer.from(String(base64 || ''), 'base64');
	if (!buf.length) { throw new Error('imageStore: empty image'); }
	if (buf.length > MAX_BYTES) {
		throw new Error('imageStore: image is ' + Math.round(buf.length / 1024) + 'KB, over the '
			+ Math.round(MAX_BYTES / 1024) + 'KB limit');
	}
	const ref = crypto.createHash('sha256').update(buf).digest('hex') + '.' + ext;
	const dest = refPath(root, slug, ref);
	if (!fs.existsSync(dest)) {
		fs.mkdirSync(mediaDir(root, slug), { recursive: true });
		// tmp + rename: a crash mid-write must never leave a truncated file under a hash that
		// claims to describe its full contents.
		const tmp = dest + '.' + process.pid + '.tmp';
		fs.writeFileSync(tmp, buf);
		fs.renameSync(tmp, dest);
	}
	return { ref, bytes: buf.length };
}

/** Read bytes back as base64 for a provider request. Returns null when the file is gone. */
function read(root, slug, ref) {
	if (!isRef(ref)) { return null; }
	try { return fs.readFileSync(refPath(root, slug, ref)).toString('base64'); }
	catch { return null; }
}

/** The media type a ref implies, from its extension. */
function mediaTypeOf(ref) {
	if (!isRef(ref)) { return null; }
	const ext = ref.slice(ref.lastIndexOf('.') + 1);
	return Object.keys(MEDIA_EXT).find((k) => MEDIA_EXT[k] === ext) || null;
}

/**
 * A stored `{type:'image', ref, …}` block → the Anthropic wire block, bytes and all.
 *
 * Called only when a request is being built, and the result is never retained: the conversation,
 * the session log and the token meter all keep the ref. Throws when the file is missing, because
 * a request that silently drops its subject is the failure this whole feature exists to avoid.
 */
function materialize(root, slug, block) {
	if (!block || block.type !== 'image') { return block; }
	if (block.source) { return block; }   // already materialized (or an inline block from elsewhere)
	const data = read(root, slug, block.ref);
	if (!data) { throw new Error('imageStore: attached image is missing from disk: ' + String(block.ref)); }
	return { type: 'image', source: { type: 'base64', media_type: mediaTypeOf(block.ref), data } };
}

/** Refs still referenced by these messages — the keep-set for a sweep. */
function refsIn(msgs) {
	const out = new Set();
	for (const m of (Array.isArray(msgs) ? msgs : [])) {
		for (const b of (Array.isArray(m && m.content) ? m.content : [])) {
			if (b && b.type === 'image' && isRef(b.ref)) { out.add(b.ref); }
		}
	}
	return out;
}

module.exports = { MEDIA_EXT, MAX_BYTES, mediaDir, refPath, isRef, put, read, mediaTypeOf, materialize, refsIn };
