/*---------------------------------------------------------------------------------------------
 *  Local image store + the meter that counts what it holds — run: node test/imageStore.test.js
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const S = require('../imageStore');
const { estimateMsgTokens } = require('../agentMemory');

let n = 0;
function test(name, fn) { fn(); n++; console.log('  ok - ' + name); }

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-img-'));
const slug = 'proj';
const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').toString('base64');

test('ROUND TRIP: bytes go in, the same bytes come back', () => {
	const { ref, bytes } = S.put(root, slug, png, 'image/png');
	assert.ok(S.isRef(ref), 'ref should be sha256 + extension: ' + ref);
	assert.strictEqual(bytes, Buffer.from(png, 'base64').length);
	assert.strictEqual(S.read(root, slug, ref), png);
	assert.strictEqual(S.mediaTypeOf(ref), 'image/png');
});

test('CONTENT ADDRESSED: the same screenshot twice is one file', () => {
	// Exactly what happens when someone re-pastes after a send fails.
	const a = S.put(root, slug, png, 'image/png');
	const b = S.put(root, slug, png, 'image/png');
	assert.strictEqual(a.ref, b.ref);
	const files = fs.readdirSync(S.mediaDir(root, slug)).filter((f) => f.endsWith('.png'));
	assert.strictEqual(files.length, 1, 'a duplicate paste must not write a second file');
});

test('CONTENT ADDRESSED: different bytes get different refs', () => {
	const other = Buffer.from('ffd8ffe000104a464946', 'hex').toString('base64');
	assert.notStrictEqual(S.put(root, slug, png, 'image/png').ref,
		S.put(root, slug, other, 'image/jpeg').ref);
});

test('NO TMP LEFT BEHIND: a completed write leaves only the final file', () => {
	assert.ok(!fs.readdirSync(S.mediaDir(root, slug)).some((f) => f.includes('.tmp')),
		'tmp+rename must not leave a .tmp file behind');
});

test('REFUSED: unsupported media type, empty bytes, and oversize', () => {
	assert.throws(() => S.put(root, slug, png, 'image/tiff'), /unsupported media type/);
	assert.throws(() => S.put(root, slug, png, 'image/svg+xml'), /unsupported media type/);
	assert.throws(() => S.put(root, slug, '', 'image/png'), /empty image/);
	const huge = Buffer.alloc(S.MAX_BYTES + 1).toString('base64');
	assert.throws(() => S.put(root, slug, huge, 'image/png'), /over the/);
});

test('REFS ARE NOT PATHS: traversal and junk are rejected, not read', () => {
	// read() takes a ref straight from a session file, which is data on disk that a user could edit.
	for (const bad of ['../../etc/passwd', '../secrets.png', 'a/b.png', 'notahash.png',
		'a'.repeat(64) + '.exe', 'a'.repeat(63) + '.png', '', null, undefined]) {
		assert.strictEqual(S.isRef(bad), false, 'should not look like a ref: ' + String(bad));
		assert.strictEqual(S.read(root, slug, bad), null, 'must not read: ' + String(bad));
		assert.strictEqual(S.mediaTypeOf(bad), null);
	}
});

test('MATERIALIZE: a ref becomes a wire block only when a request is built', () => {
	const { ref } = S.put(root, slug, png, 'image/png');
	const out = S.materialize(root, slug, { type: 'image', ref, w: 100, h: 50 });
	assert.deepStrictEqual(out, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } });
	// already-materialized blocks pass through untouched
	const inline = { type: 'image', source: { type: 'url', url: 'https://x.test/a.png' } };
	assert.strictEqual(S.materialize(root, slug, inline), inline);
	assert.deepStrictEqual(S.materialize(root, slug, { type: 'text', text: 'hi' }), { type: 'text', text: 'hi' });
});

test('MATERIALIZE: a missing file throws rather than sending a request without its subject', () => {
	assert.throws(
		() => S.materialize(root, slug, { type: 'image', ref: 'b'.repeat(64) + '.png' }),
		/missing from disk/,
		'a silently dropped image is the exact failure this feature exists to avoid'
	);
});

test('REFS IN: the keep-set sees every attached image and nothing else', () => {
	const r1 = 'a'.repeat(64) + '.png', r2 = 'c'.repeat(64) + '.webp';
	const got = S.refsIn([
		{ role: 'user', content: [{ type: 'image', ref: r1 }, { type: 'text', text: 'x' }] },
		{ role: 'user', content: 'a plain string turn' },
		{ role: 'user', content: [{ type: 'image', ref: r2 }, { type: 'image', ref: '../evil' }] }
	]);
	assert.deepStrictEqual([...got].sort(), [r1, r2].sort());
});

test('METER: the storage shape does not change the number', () => {
	// This is the point of the whole design. An image costs what it costs; whether the bytes are
	// inline or on disk behind a ref must not move the meter.
	const big = 'A'.repeat(1_400_000);
	const inline = [{ role: 'user', content: [
		{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: big } },
		{ type: 'text', text: 'why?' }] }];
	const ref = [{ role: 'user', content: [
		{ type: 'image', ref: 'a'.repeat(64) + '.png', w: 3840, h: 2160 },
		{ type: 'text', text: 'why?' }] }];

	const a = estimateMsgTokens(inline, 'claude-opus-5');
	const b = estimateMsgTokens(ref, 'claude-opus-5');
	assert.strictEqual(a, b, 'inline and ref must cost the same');
	assert.ok(a < 6000, 'a 1MB image must not book six figures of tokens — got ' + a);
	assert.ok(a > 4000, 'nor may it be under-counted as a short string — got ' + a);
	assert.ok(estimateMsgTokens(ref, 'gpt-4o') < b, 'the standard tier costs less than high-res');
});

test('METER: text-only messages are unchanged by any of this', () => {
	const msgs = [{ role: 'user', content: 'hello there' }, { role: 'assistant', content: 'hi' }];
	assert.strictEqual(estimateMsgTokens(msgs), Math.round(
		msgs.reduce((n2, m) => n2 + JSON.stringify(m).length, 0) / 4),
		'the old heuristic must still hold exactly for text');
});

try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
console.log('\nimageStore: ' + n + ' tests passed.');
