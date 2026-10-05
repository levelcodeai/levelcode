/*---------------------------------------------------------------------------------------------
 *  LevelCode — AI · rich diagrams · what may be written to disk  (docs/RICH-DIAGRAMS.md, FR-7 +
 *  "Safe rendering")
 *
 *  An exported SVG or PNG is produced in the webview — that is where the real font and the live
 *  theme are, and it is the only way "exports match the rendered view" can be true. So the bytes
 *  cross the webview boundary, and the host does not take them on trust: before anything is written,
 *  an SVG must be made of nothing but the painter's own elements and attributes, and a PNG must
 *  actually be a PNG.
 *
 *  This is an allow-list over structure, the same lists the painter draws from — not a search for
 *  known-bad strings.
 *
 *  Host-only, pure.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

const scene = require('./scene');

const MAX_SVG = 2 * 1024 * 1024;
const MAX_PNG = 20 * 1024 * 1024;
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * Is this an SVG the painter could have produced?
 * @param {any} svg
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
function checkSvg(svg) {
	if (typeof svg !== 'string') { return { ok: false, reason: 'not text' }; }
	if (svg.length > MAX_SVG) { return { ok: false, reason: 'too large' }; }
	const src = svg.trim();
	if (!/^<svg[\s>]/.test(src) || !/<\/svg>$/.test(src)) { return { ok: false, reason: 'not an SVG document' }; }
	// One stylesheet at most, in CDATA, and it may not reach outside the file.
	const styles = src.match(/<style>[\s\S]*?<\/style>/g) || [];
	if (styles.length > 1) { return { ok: false, reason: 'more than one stylesheet' }; }
	for (const st of styles) {
		const css = st.replace(/^<style><!\[CDATA\[/, '').replace(/\]\]><\/style>$/, '');
		if (css === st || /<|\]\]>|@import|url\s*\(|expression\s*\(|javascript:|\\/i.test(css)) { return { ok: false, reason: 'stylesheet is not the painter\'s' }; }
	}
	const body = src.replace(/<style>[\s\S]*?<\/style>/g, '<style/>');
	if (/<!|<\?|\]\]>/.test(body)) { return { ok: false, reason: 'declarations and comments are not allowed' }; }
	const stack = [];
	for (const m of body.matchAll(/<[^>]*>/g)) {
		const tag = m[0];
		const end = /^<\/([A-Za-z][\w:-]*)>$/.exec(tag);
		if (end) { if (stack.pop() !== end[1]) { return { ok: false, reason: 'tags do not nest' }; } continue; }
		const start = /^<([A-Za-z][\w:-]*)((?:\s+[\w:-]+="[^"<>]*")*)\s*(\/?)>$/.exec(tag);
		if (!start) { return { ok: false, reason: 'malformed tag' }; }
		if (!scene.TAGS.has(start[1])) { return { ok: false, reason: 'element <' + start[1] + '> is not allowed' }; }
		for (const a of (start[2].match(/[\w:-]+(?==")/g) || [])) { if (!scene.ATTRS.has(a)) { return { ok: false, reason: 'attribute "' + a + '" is not allowed' }; } }
		if (!start[3]) { stack.push(start[1]); }
	}
	if (stack.length) { return { ok: false, reason: 'unclosed element' }; }
	if (/<[^>]*$/.test(body)) { return { ok: false, reason: 'unclosed tag' }; }
	return { ok: true };
}

/**
 * Decode a base64 PNG, checking it is one.
 * @param {any} base64
 * @returns {{ ok: true, bytes: Buffer } | { ok: false, reason: string }}
 */
function checkPng(base64) {
	if (typeof base64 !== 'string' || !base64) { return { ok: false, reason: 'no image data' }; }
	const b64 = base64.replace(/^data:image\/png;base64,/, '');
	if (b64.length > MAX_PNG * 1.4) { return { ok: false, reason: 'too large' }; }
	if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) { return { ok: false, reason: 'not base64' }; }
	const bytes = Buffer.from(b64, 'base64');
	if (bytes.length > MAX_PNG) { return { ok: false, reason: 'too large' }; }
	if (bytes.length < 60 || PNG_MAGIC.some((v, i) => bytes[i] !== v)) { return { ok: false, reason: 'not a PNG image' }; }
	return { ok: true, bytes };
}

/** A file name for a diagram, from its title: lowercase words joined by hyphens, never empty. */
function fileStem(title) {
	return String(title == null ? '' : title).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/, '') || 'diagram';
}

module.exports = { checkSvg, checkPng, fileStem, MAX_SVG, MAX_PNG };
