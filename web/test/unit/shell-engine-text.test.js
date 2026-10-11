/*---------------------------------------------------------------------------------------------
 *  Text and bytes — run: node web/test/unit/shell-engine-text.test.js
 *
 *  engine/text.js decodes the bytes of a file to a string and encodes a string back, without losing a byte that is
 *  not UTF-8 (U+FFFD is what TextDecoder makes of it, and `sed -i` on a latin-1 file then changed the file). A byte
 *  that is not part of a valid sequence is U+DC00 + byte (Python's "surrogateescape").
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

const assert = require('assert');
const path = require('path');

const { decodeBytes, encodeText, decodeByteString, decodeIfBytes, joinEscapes, displayText, hasLoneSurrogate } = require(path.join(__dirname, '..', '..', 'shell', 'engine', 'text.js'));

/** @type {Array<{ name: string, fn: () => Promise<void> | void }>} */
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

const dec = new TextDecoder('utf-8', { ignoreBOM: true });
const bytesOf = (...b) => Uint8Array.from(b);

function rng(seed) {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6D2B79F5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

test('valid UTF-8 is exactly what TextDecoder gives (a BOM stays), and encodes back to the same bytes', () => {
	for (const s of ['', 'abc', 'café', '日本語', '😀 and ✓', '\u0000\u0001', 'a\u0000b', '﻿hi', '\u{10FFFF}', '\u{10000}', '\u007f\u0080߿ࠀ￿']) {
		const b = new TextEncoder().encode(s);
		assert.strictEqual(decodeBytes(b), s, JSON.stringify(s));
		assert.deepStrictEqual([...encodeText(s)], [...b], JSON.stringify(s));
	}
	assert.strictEqual(decodeBytes(bytesOf(0xef, 0xbb, 0xbf, 0x68)), '﻿h', 'the BOM is a character of the text, not a marker');
});

test('a byte that is not part of a valid sequence is U+DC00 + the byte, each one, and goes back to it', () => {
	const cases = [
		[[0xe9], '\udce9'],
		[[0x63, 0x61, 0x66, 0xe9, 0x0a], 'caf\udce9\n'],
		[[0xff], '\udcff'],
		[[0x80], '\udc80'],
		[[0xc3], '\udcc3'],
		[[0xc3, 0xa9, 0xff], 'é\udcff'],
		[[0xc0, 0x80], '\udcc0\udc80'],                       // overlong NUL
		[[0xe0, 0x80, 0x80], '\udce0\udc80\udc80'],           // overlong
		[[0xed, 0xa0, 0x80], '\udced\udca0\udc80'],           // a surrogate, which UTF-8 does not have
		[[0xf4, 0x90, 0x80, 0x80], '\udcf4\udc90\udc80\udc80'], // above U+10FFFF
		[[0xf5], '\udcf5'],
		[[0xf0, 0x9f, 0x98], '\udcf0\udc9f\udc98'],           // cut short
		[[0xe2, 0x82, 0x61], '\udce2\udc82a'],                // a sequence that is broken by an ASCII
		[[0xf0, 0x9f, 0x98, 0x80, 0xff], '\u{1F600}\udcff'],
	];
	for (const [bytes, text] of cases) {
		assert.strictEqual(decodeBytes(Uint8Array.from(bytes)), text, JSON.stringify(bytes));
		assert.deepStrictEqual([...encodeText(text)], bytes, JSON.stringify(bytes));
	}
});

test('property: any bytes round-trip, and a string with no escape encodes as TextEncoder does', () => {
	const r = rng(20261011);
	for (let i = 0; i < 400; i++) {
		const n = Math.floor(r() * 40);
		const b = new Uint8Array(n);
		// a mix that makes valid and invalid sequences meet
		for (let k = 0; k < n; k++) { const x = r(); b[k] = x < 0.3 ? 0x41 + Math.floor(r() * 26) : x < 0.5 ? 0xc2 + Math.floor(r() * 30) : x < 0.7 ? 0x80 + Math.floor(r() * 64) : Math.floor(r() * 256); }
		const text = decodeBytes(b);
		assert.deepStrictEqual([...encodeText(text)], [...b], 'bytes ' + [...b].map((x) => x.toString(16)).join(' '));
		let valid = true;
		try { new TextDecoder('utf-8', { fatal: true }).decode(b); } catch { valid = false; }
		assert.strictEqual(valid, !/[\udc80-\udcff]/.test(text.replace(/[\ud800-\udbff][\udc00-\udfff]/g, '')), 'an escape appears exactly when the bytes are not valid UTF-8');
		if (valid) { assert.strictEqual(text, dec.decode(b)); }
	}
	// a long input: bad bytes all through, in well under a second
	const big = new Uint8Array(4 << 20);
	for (let i = 0; i < big.length; i++) { big[i] = i % 7 === 0 ? 0xe9 : 0x61 + (i % 20); }
	const t0 = Date.now();
	const text = decodeBytes(big);
	const back = encodeText(text);
	assert.ok(Date.now() - t0 < 2000, 'took ' + (Date.now() - t0) + ' ms');
	assert.strictEqual(back.length, big.length);
	assert.ok(back.every((v, i) => v === big[i]));
});

test('what is not an escape stays what TextEncoder makes of it: a lone surrogate is U+FFFD, a pair is one character', () => {
	assert.deepStrictEqual([...encodeText('a\ud800b')], [0x61, 0xef, 0xbf, 0xbd, 0x62]);
	assert.deepStrictEqual([...encodeText('\udbff')], [0xef, 0xbf, 0xbd]);
	assert.deepStrictEqual([...encodeText('\udc7f')], [0xef, 0xbf, 0xbd], 'below the escape range');
	assert.deepStrictEqual([...encodeText('𐂀')], [0xf0, 0x90, 0x82, 0x80], 'U+10080: the low half is in the escape range and is not one here');
	assert.deepStrictEqual([...encodeText('😀x\udcff')], [0xf0, 0x9f, 0x98, 0x80, 0x78, 0xff]);
	assert.deepStrictEqual([...encodeText('\udcff\udcfe')], [0xff, 0xfe]);
	// an escape right after a high surrogate that is not from this decoder reads as a pair: an inherent ambiguity of UTF-16
	assert.deepStrictEqual([...encodeText('𐃿')], [...new TextEncoder().encode('𐃿')]);
});

test('a byte string (one character per byte) decodes with escapes; a string that is text already, or ASCII, is left alone', () => {
	assert.strictEqual(decodeByteString('café'), 'caf\udce9', 'one byte e9: invalid');
	assert.strictEqual(decodeByteString('cafÃ©'), 'café', 'two bytes c3 a9: é');
	assert.strictEqual(decodeByteString('abc'), 'abc');
	assert.strictEqual(decodeByteString('café 日'), 'café 日', 'a character above 255: text already');
	assert.strictEqual(decodeByteString(''), '');
	assert.strictEqual(decodeByteString('ï»¿h'), '﻿h', 'a BOM is kept');
});

test('a string that may be bytes or text: valid UTF-8 bytes are decoded, anything else is text and is left alone', () => {
	assert.strictEqual(decodeIfBytes('cafÃ©'), 'café', 'printf \'\\303\\251\' makes these two characters');
	assert.strictEqual(decodeIfBytes('naïve'), 'naïve', 'text with a character below 256 that is not valid as a byte');
	assert.strictEqual(decodeIfBytes('café ñ'), 'café ñ');
	assert.strictEqual(decodeIfBytes('caf\udce9'), 'caf\udce9', 'an escape is above 255: text');
	assert.strictEqual(decodeIfBytes('plain'), 'plain');
	assert.strictEqual(decodeIfBytes(''), '');
	assert.strictEqual(decodeIfBytes('Ã©Ã'), 'Ã©Ã', 'valid in part is not valid');
});

test('what is shown: an escape is U+FFFD, a pair is not touched, nothing else changes', () => {
	assert.strictEqual(displayText('caf\udce9\n'), 'caf�\n');
	assert.strictEqual(displayText('\udc80\udcff'), '��');
	assert.strictEqual(displayText('😀'), '😀');
	assert.strictEqual(displayText('𐂀 \udc80'), '𐂀 �', 'U+10080 is a character; the lone one is not');
	assert.strictEqual(displayText('plain é 日'), 'plain é 日');
	assert.strictEqual(displayText(''), '');
	assert.ok(!/[\udc80-\udcff]/.test(displayText(decodeBytes(bytesOf(1, 2, 0xff, 0xfe, 0x80)))));
});

test('what is shown has NO lone surrogate at all: half of an emoji (awk substr, cut -c) is U+FFFD as an escape is, and a pair is left alone', () => {
	assert.strictEqual(displayText('\ud83d'), '�', 'a high half');
	assert.strictEqual(displayText('\ude00'), '�', 'a low half that is not an escape');
	assert.strictEqual(displayText('a\ud83d'), 'a�', 'a high half at the very end');
	assert.strictEqual(displayText('\ud83db'), '�b', 'a high half before a character that is not a low one');
	assert.strictEqual(displayText('\ude00\ud83d'), '��', 'a low one and then a high one are not a pair');
	assert.strictEqual(displayText('😀\ud83d'), '😀�');
	assert.strictEqual(displayText('😀 caf\udce9 \ud83d'), '😀 caf� �');
	for (const s of ['\ud83d', '\ude00', '\udcff', 'a\ud83db', '\ud83d😀']) {
		assert.ok(!/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(displayText(s)), JSON.stringify(s));
	}
	// the question the overlay asks of a name
	assert.strictEqual(hasLoneSurrogate('plain'), false);
	assert.strictEqual(hasLoneSurrogate('😀'), false);
	assert.strictEqual(hasLoneSurrogate('a\udcff'), true);
	assert.strictEqual(hasLoneSurrogate('\ud83d'), true);
	assert.strictEqual(hasLoneSurrogate('😀\ude00'), true);
	assert.strictEqual(hasLoneSurrogate(''), false);
});

test('joinEscapes: the escapes of bytes that are UTF-8 together are the character (what printf \\303\\251 makes); a lone byte stays an escape; a surrogate pair is left alone', () => {
	const esc = (...b) => String.fromCharCode(...b.map((x) => 0xdc00 + x));
	assert.strictEqual(joinEscapes(esc(0xc3, 0xa9)), 'é');
	assert.strictEqual(joinEscapes('caf' + esc(0xc3, 0xa9) + ' ' + esc(0xe2, 0x9c, 0x93) + '\n'), 'café ✓\n');
	assert.strictEqual(joinEscapes(esc(0xf0, 0x9f, 0x98, 0x80)), '😀');
	assert.strictEqual(joinEscapes(esc(0xff)), esc(0xff), 'a byte that is not UTF-8 stays what it is');
	assert.strictEqual(joinEscapes(esc(0xc3)), esc(0xc3), 'the first half of a character');
	assert.strictEqual(joinEscapes(esc(0xc3, 0xa9, 0xff, 0xc3, 0xa9)), 'é' + esc(0xff) + 'é', 'a run of valid and invalid bytes is each where it is');
	assert.strictEqual(joinEscapes('plain'), 'plain');
	assert.strictEqual(joinEscapes(''), '');
	// a pair is a character: the low half of U+1F480 is U+DC80 and of U+1F4C3 is U+DCC3, which look like escapes of the
	// bytes 0x80 and 0xC3 when they stand alone, and are not when a high surrogate is in front of them
	assert.strictEqual(joinEscapes('\u{1F480}'), '\u{1F480}');
	assert.strictEqual(joinEscapes('x\u{1F4C3}y' + esc(0xc3, 0xa9)), 'x\u{1F4C3}yé');
	assert.strictEqual(joinEscapes('\u{1F4C3}' + esc(0xa9)), '\u{1F4C3}' + esc(0xa9), 'the byte after a pair is a byte');
	assert.strictEqual(joinEscapes('\u{1F4C3}' + esc(0xc3, 0xa9)), '\u{1F4C3}é', 'and valid ones after it are the character');
	// U+1F4A9 is D83D DCA9: DCA9 lies in the escape range and is half of a character, not a byte
	assert.strictEqual(joinEscapes('💩'), '💩');
	assert.strictEqual(joinEscapes('💩' + esc(0xc3, 0xa9)), '💩é');
	assert.strictEqual(joinEscapes(esc(0xc3) + '💩' + esc(0xa9)), esc(0xc3) + '💩' + esc(0xa9), 'a pair between two halves joins nothing');
	// it is what encodeText would have written, as text: encode(join(s)) is encode(s)
	const r = rng(7);
	for (let i = 0; i < 300; i++) {
		const b = new Uint8Array(1 + Math.floor(r() * 12));
		for (let k = 0; k < b.length; k++) { b[k] = r() < 0.5 ? 0x80 + Math.floor(r() * 128) : Math.floor(r() * 128); }
		const escaped = [...b].map((x) => (x < 0x80 ? String.fromCharCode(x) : String.fromCharCode(0xdc00 + x))).join('');
		assert.deepStrictEqual([...encodeText(joinEscapes(escaped))], [...b]);
		assert.strictEqual(decodeBytes(b), joinEscapes(escaped));
	}
});

(async () => {
	for (const t of tests) {
		await t.fn();
		console.log('  ok - ' + t.name);
	}
	console.log(`\n${tests.length} tests passed`);
})().catch((e) => { console.error(e); process.exit(1); });
