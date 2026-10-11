/*---------------------------------------------------------------------------------------------
 *  web/shell/src/sanitize.js - run: node web/test/unit/shell-sanitize.test.js
 *
 *  What reaches a terminal or an approval card from a file, a command or the model. The tables are the point:
 *  one row per CLASS of character, so a class that is missed is a missing row and not a missed example, and
 *  every row is checked against both functions. Source text is written with \u{...}: invisible characters are
 *  exactly the ones a review cannot see in a diff.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

const assert = require('assert');
const path = require('path');

const { forTerminal, forDisplay } = require(path.join(__dirname, '..', '..', 'shell', 'src', 'sanitize.js'));

let n = 0;
function test(/** @type {string} */ name, /** @type {() => void} */ fn) { fn(); n++; console.log('  ok - ' + name); }

/** @param {number} cp */
const bracket = (cp) => '[U+' + cp.toString(16).toUpperCase().padStart(4, '0') + ']';
const chr = (/** @type {number} */ cp) => String.fromCodePoint(cp);
/** Every code point of a [lo, hi] range. @param {number} lo @param {number} hi */
const span = (lo, hi) => Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);

/**
 * One row per class of invisible or reordering character, each shown as [U+XXXX] by BOTH functions when it
 * stands among ordinary ASCII (no emoji around it for forTerminal to treat as a sequence).
 * @type {Array<[string, number[]]>}
 */
const INVISIBLE = [
	['C1 controls (xterm.js reads U+009B as CSI)', span(0x80, 0x9F)],
	['bidi marks and overrides and isolates', [0x061C, 0x200E, 0x200F, 0x202A, 0x202B, 0x202C, 0x202D, 0x202E, 0x2066, 0x2067, 0x2068, 0x2069]],
	['zero-width space, non-joiner, joiner, word joiner, BOM, soft hyphen', [0x200B, 0x200C, 0x200D, 0x2060, 0xFEFF, 0x00AD]],
	['tag characters (U+E0000-E007F)', span(0xE0000, 0xE007F)],
	['variation selectors (FE00-FE0F, and the supplement E0100-E01EF)', span(0xFE00, 0xFE0F).concat(span(0xE0100, 0xE01EF))],
	['Hangul fillers', [0x115F, 0x1160, 0x3164, 0xFFA0]],
	['invisible math operators (2061-2064) and the deprecated format controls (206A-206F)', span(0x2061, 0x2064).concat(span(0x206A, 0x206F))],
	['combining grapheme joiner', [0x034F]],
	['Mongolian free variation selectors and vowel separator', span(0x180B, 0x180E)],
	['Khmer inherent vowels', [0x17B4, 0x17B5]],
	['line and paragraph separators', [0x2028, 0x2029]],
	['interlinear annotation anchors', [0xFFF9, 0xFFFA, 0xFFFB]],
	['blank Braille pattern', [0x2800]],
	['lone surrogates', [0xD800, 0xDBFF, 0xDC00, 0xDFFF]],
];

/* ----- classes, both functions ---------------------------------------------------------------- */

for (const [cls, cps] of INVISIBLE) {
	test('every ' + cls + ' is shown as [U+XXXX], by both', () => {
		for (const cp of cps) {
			const s = 'a' + (cp >= 0xD800 && cp <= 0xDFFF ? String.fromCharCode(cp) : chr(cp)) + 'b';
			const want = 'a' + bracket(cp) + 'b';
			assert.strictEqual(forTerminal(s), want, 'forTerminal U+' + cp.toString(16));
			assert.strictEqual(forDisplay(s), want, 'forDisplay U+' + cp.toString(16));
		}
	});
}

test('C0 controls (not \\n, \\t, \\r) and DEL become control pictures, ESC becomes U+241B', () => {
	for (let c = 0; c < 0x20; c++) {
		if (c === 0x09 || c === 0x0A || c === 0x0D) { continue; }
		const want = 'a' + String.fromCharCode(0x2400 + c) + 'b';
		assert.strictEqual(forTerminal('a' + String.fromCharCode(c) + 'b'), want, 'forTerminal 0x' + c.toString(16));
		assert.strictEqual(forDisplay('a' + String.fromCharCode(c) + 'b'), want, 'forDisplay 0x' + c.toString(16));
	}
	assert.strictEqual(forTerminal('\x1b'), '\u{241B}');
	assert.strictEqual(forTerminal('a\x7fb'), 'a\u{2421}b');
	assert.strictEqual(forDisplay('a\x7fb'), 'a\u{2421}b');
});

test('what a terminal answers to is made visible, never passed: queries, OSC 52, title, 8-bit CSI', () => {
	const sequences = [
		'\x1b[6n', '\x1b[5n', '\x1b[c', '\x1b[>c', '\x1b[>q', '\x1b[18t', '\x1b[14t', '\x1b[?2004$p', '\x1bP$qm\x1b\\',
		'\x1b]10;?\x07', '\x1b]11;?\x1b\\', '\x1b]52;c;?\x07', '\x1b]52;c;aGk=\x07', '\x1b]0;title\x07', '\x1b]8;;https://example.test\x07x\x1b]8;;\x07',
		'\x1b]633;E;rm -rf x;nonce\x07', '\x1bc', '\x1b[2J', '\x1b[?1049h', '\x1b[?1000h',
		'\u{9B}6n', '\u{9D}52;c;?\u{9C}', '\u{90}$qm\u{9C}',
	];
	for (const s of sequences) {
		for (const out of [forTerminal(s), forDisplay(s)]) {
			assert.ok(!/[\x00-\x08\x0B-\x1F\x7F-\x9F]/.test(out), 'a control survived in ' + JSON.stringify(s) + ' -> ' + JSON.stringify(out));
		}
	}
	assert.strictEqual(forTerminal('\x1b[31mred\x1b[0m'), '\u{241B}[31mred\u{241B}[0m');
});

/* ----- what is left alone --------------------------------------------------------------------- */

test('ordinary text is returned unchanged, whatever the script', () => {
	const fine = [
		'plain ascii: ls -la | grep "x" > out.txt', 'tab\tseparated\nand two lines', 'caf\u{E9} na\u{EF}ve', '\u{65E5}\u{672C}\u{8A9E} \u{D55C}\u{AD6D}\u{C5B4}',
		'\u{41F}\u{440}\u{438}\u{432}\u{435}\u{442}', '\u{5E9}\u{5DC}\u{5D5}\u{5DD} \u{627}\u{644}\u{633}\u{644}\u{627}\u{645}',
		'e\u{301} (combining acute)', 'nb\u{A0}sp and \u{3000}ideographic', '\u{1F600} \u{1F680} \u{2728}',
		'[U+202E] written out as text', '\u{FFFD} replacement',
	];
	for (const s of fine) {
		assert.strictEqual(forTerminal(s), s);
		assert.strictEqual(forDisplay(s), s);
	}
});

test('null and undefined are the empty string, not the word', () => {
	assert.strictEqual(forTerminal(undefined), '');
	assert.strictEqual(forTerminal(null), '');
	assert.strictEqual(forDisplay(undefined), '');
	assert.strictEqual(forDisplay(null), '');
	assert.strictEqual(forDisplay(42), '42');
});

test('both are idempotent: what they print is not touched by a second pass', () => {
	const mixed = 'a\x1b[31m\u{202E}b\u{200D}c\r\nd\re\u{E0041}\u{D800}f\u{2764}\u{FE0F}';
	assert.strictEqual(forTerminal(forTerminal(mixed)), forTerminal(mixed));
	assert.strictEqual(forDisplay(forDisplay(mixed)), forDisplay(mixed));
});

/* ----- the two ways they differ ---------------------------------------------------------------- */

test('a carriage return: forTerminal makes it a line break (a line cannot overwrite itself), forDisplay shows it', () => {
	assert.strictEqual(forTerminal('rm -rf /\rls'), 'rm -rf /\nls');
	assert.strictEqual(forTerminal('a\r\nb'), 'a\nb');
	assert.strictEqual(forTerminal('a\rb\r'), 'a\nb\n');
	assert.strictEqual(forTerminal('a\n\rb'), 'a\n\nb');
	assert.strictEqual(forDisplay('rm -rf /\rls'), 'rm -rf /\u{240D}ls');
	assert.strictEqual(forDisplay('a\r\nb'), 'a\u{240D}\nb');
});

test('crlf: the newline a pty wants, for LF, CRLF and a lone CR alike; tabs stay', () => {
	assert.strictEqual(forTerminal('a\nb\r\nc\rd\te', { crlf: true }), 'a\r\nb\r\nc\r\nd\te');
	assert.strictEqual(forTerminal('a\nb', { crlf: false }), 'a\nb');
});

test('line breaks and tabs are the only controls forDisplay leaves, so a card can be multi-line', () => {
	assert.strictEqual(forDisplay('line one\n\tline two'), 'line one\n\tline two');
});

/** @type {Array<[string, string]>} */
const EMOJI = [
	['VS16 after a pictograph', '\u{2764}\u{FE0F}'],
	['a family: ZWJ between pictographs', '\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}'],
	['a skin tone then ZWJ', '\u{1F9D1}\u{1F3FD}\u{200D}\u{1F4BB}'],
	['a keycap', '1\u{FE0F}\u{20E3}'],
	['VS16 before a ZWJ', '\u{1F468}\u{200D}\u{2764}\u{FE0F}\u{200D}\u{1F468}'],
];
for (const [what, s] of EMOJI) {
	test('emoji sequence: ' + what + ' is drawn by forTerminal and shown by forDisplay', () => {
		assert.strictEqual(forTerminal(s), s);
		const shown = forDisplay(s);
		assert.ok(/\[U\+(FE0F|200D)\]/.test(shown), 'forDisplay must not leave the joiner invisible: ' + shown);
		assert.ok(!/[\u{FE0F}\u{200D}]/u.test(shown), 'a joiner survived forDisplay');
	});
}

/** The same joiners where no emoji is: a VS after a letter is how "rm" + VS16 hides, and a lone ZWJ hides a word. @type {Array<[string, string, string]>} */
const NOT_EMOJI = [
	['VS16 after ASCII', 'rm\u{FE0F} -rf', 'rm[U+FE0F] -rf'],
	['VS16 at the start', '\u{FE0F}x', '[U+FE0F]x'],
	['a second VS16 in a row (variation selectors carry hidden data)', '\u{2764}\u{FE0F}\u{FE0F}', '\u{2764}\u{FE0F}[U+FE0F]'],
	['VS15 after a letter', 'a\u{FE0E}', 'a[U+FE0E]'],
	['a keycap base without U+20E3', '1\u{FE0F}', '1[U+FE0F]'],
	['ZWJ between letters', 'a\u{200D}b', 'a[U+200D]b'],
	['ZWJ at the end of a string', '\u{1F468}\u{200D}', '\u{1F468}[U+200D]'],
	['ZWJ at the start of a string', '\u{200D}\u{1F468}', '[U+200D]\u{1F468}'],
	['ZWJ between an emoji and ASCII', '\u{1F468}\u{200D}b', '\u{1F468}[U+200D]b'],
	['ZWNJ between emoji (not a joiner)', '\u{1F468}\u{200C}\u{1F469}', '\u{1F468}[U+200C]\u{1F469}'],
	['a tag character after an emoji (flag smuggling)', '\u{1F3F4}\u{E0067}', '\u{1F3F4}[U+E0067]'],
	['a supplement selector after an emoji', '\u{2764}\u{E0100}', '\u{2764}[U+E0100]'],
];
for (const [what, input, want] of NOT_EMOJI) {
	test('not an emoji sequence: ' + what, () => { assert.strictEqual(forTerminal(input), want); });
}

/* ----- shape ------------------------------------------------------------------------------------ */

test('a long input with every class in it is handled, and nothing invisible is left', () => {
	let s = '';
	for (const [, cps] of INVISIBLE) { for (const cp of cps) { s += 'x' + (cp >= 0xD800 && cp <= 0xDFFF ? String.fromCharCode(cp) : chr(cp)); } }
	s = s.repeat(20);
	for (const out of [forTerminal(s), forDisplay(s)]) {
		assert.ok(!/[\p{Cc}\p{Default_Ignorable_Code_Point}\u{2028}\u{2029}\u{2800}\u{FFF9}-\u{FFFB}\u{D800}-\u{DFFF}]/u.test(out));
		assert.ok(out.length > s.length);
	}
	const big = 'line of text with \x1b[0m and \u{202E}\n'.repeat(40000);
	assert.ok(forTerminal(big).length > big.length - 1);
});

console.log(`\n${n} tests passed`);
