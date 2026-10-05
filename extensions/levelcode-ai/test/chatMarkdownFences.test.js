/*---------------------------------------------------------------------------------------------
 *  The chat's Markdown renderer: code fences and inline code — run: node test/chatMarkdownFences.test.js
 *
 *  The bug this suite exists for: an answer that mentioned three backticks in the middle of a
 *  sentence — the model had quoted them properly, in an inline span of four — was rendered as two
 *  one-character code blocks, and the rest of the paragraph came out ONE STREAMED FRAGMENT PER LINE
 *  ("gr / ounded ent / irely in the actual code"). Two causes, both pinned here:
 *
 *    1. Any three backticks, anywhere, were a code fence. A fence is a line; an inline span is not.
 *    2. While streaming, text after a "closed" fence with no newline yet was frozen into the page as
 *       it arrived, one piece per delta. Only a block that is really finished may be frozen.
 *
 *  The renderer lives inline in media/chat.html, so its functions are sliced out of the file itself
 *  (the pattern of shHighlight.test.js): these tests run the shipped code, not a copy of it.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'media', 'chat.html'), 'utf8');

/** Slice a 2-space-indented function out of chat.html (see shHighlight.test.js for why not brace counting). */
function extract(name) {
	const start = html.indexOf('\n  function ' + name + '(');
	assert.ok(start >= 0, 'chat.html no longer defines ' + name + '()');
	const from = start + 1;
	const oneLiner = html.slice(from, html.indexOf('\n', from));
	if (/}\s*$/.test(oneLiner) && oneLiner.split('{').length === oneLiner.split('}').length) { return oneLiner; }
	const end = html.indexOf('\n  }', from);
	assert.ok(end >= 0, 'no closing brace found for ' + name + '()');
	return html.slice(from, end + 4);
}
/** A top-level `const NAME = …;` line (or lines, up to the first line ending in `;`). */
function decl(name) {
	const m = new RegExp('\\n  const ' + name + ' = [\\s\\S]*?;\\n').exec(html);
	assert.ok(m, 'chat.html no longer declares ' + name);
	return m[0];
}
const optional = (name) => (html.indexOf('\n  function ' + name + '(') >= 0 ? extract(name) : '');
const optionalDecl = (name) => (new RegExp('\\n  const ' + name + ' = ').test(html) ? decl(name) : '');

// A document just big enough for streamFeed(): elements that hold innerHTML and keep their children in order.
function fakeDocument() {
	const el = () => ({ innerHTML: '', children: [], appendChild(c) { this.children.push(c); return c; }, insertBefore(c, ref) { const i = this.children.indexOf(ref); this.children.splice(i < 0 ? this.children.length : i, 0, c); return c; } });
	return { createElement: el };
}

const FUNCS = ['esc', 'escAttr', 'highlight', 'resolveFile', 'fileIcon', 'fileLinkChip', 'linkifyFiles', 'mdFmt', 'mdInline', 'mdListItem', 'mdBlockKind', 'mdParseList', 'mdTableBlock', 'mdBlocks', 'render', 'lastStableIndex', 'makeStream', 'stripThink', 'streamFeed'];
// eslint-disable-next-line no-new-func
const boot = new Function('document', [
	'let fileIndex = null; function scrollIfStuck(){}',
	decl('FENCE'), decl('TICK'), decl('HL_KW'), decl('HTML5_SHIELD'),
	optionalDecl('FENCE_LINE'), optionalDecl('FENCE_TAIL'), optionalDecl('FENCE_END'),
	optional('tickRuns'), optional('mdSegments'),
	...FUNCS.map(extract),
	'return { render, mdInline, mdBlocks, lastStableIndex, makeStream, streamFeed, setFiles: function(rels){ const paths = new Set(rels); const byBase = new Map(); for (const r of rels){ const b = r.split("/").pop(); if (!byBase.has(b)) byBase.set(b, []); byBase.get(b).push(r); } fileIndex = { paths: paths, byBase: byBase }; } };'
].join('\n'));
const doc = fakeDocument();
const C = boot(doc);

let n = 0;
function test(name, fn) { fn(); n++; console.log('  ok - ' + name); }

const T = '`', F = '```';
const text = (h) => h.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const count = (h, tag) => (h.match(new RegExp('<' + tag + '[ >]', 'g')) || []).length;
/** Feed `full` through the streaming renderer in the given pieces; return what the page holds at the end, and after each piece. */
function stream(pieces) {
	const body = doc.createElement();
	const s = C.makeStream(body);
	let acc = ''; const frames = [];
	for (const p of pieces) {
		acc += p; C.streamFeed(s, acc);
		frames.push({ frozen: body.children.filter((c) => c !== s.live).map((c) => c.innerHTML), live: s.live.innerHTML });
	}
	return { html: body.children.map((c) => c.innerHTML).join(''), frames, frozen: body.children.filter((c) => c !== s.live).map((c) => c.innerHTML) };
}
const chunk = (s, sizes) => { const out = []; let i = 0, k = 0; while (i < s.length) { const z = sizes[k++ % sizes.length]; out.push(s.slice(i, i + z)); i += z; } return out; };
/** Deterministic pseudo-random chunk sizes. */
const sizesFor = (seed) => { let x = seed * 2654435761 >>> 0; const out = []; for (let i = 0; i < 40; i++) { x = (x * 1664525 + 1013904223) >>> 0; out.push(1 + (x >>> 24) % 17); } return out; };

// The paragraph from the report, exactly as the model wrote it.
const REPORTED = 'Four opening fences, matching four diagrams, each closed by a plain ' + F + T + ' ' + F + ' ' + F + T + '. The diagram is grounded entirely in the actual code: config trust tiers (' + T + 'loadServerConfig' + T + '), SHA-256 launch fingerprint (' + T + 'launchFingerprint' + T + '/' + T + 'approveMcpLaunch' + T + '), the ' + T + 'server__tool' + T + ' naming + routes (' + T + 'buildAgentTools' + T + '), and the four §4 gates.\n\nDone: Added ' + T + 'docs/MCP-DIAGRAM.md' + T + ' — four Mermaid diagrams.\n\n- **Flow diagram** traces config sources.\n- **Sequence diagram** walks one ' + T + 'tools/call' + T + '.\n';

const DOCS = {
	plain: 'A paragraph.\n\nAnother, with ' + T + 'inline code' + T + ' and **bold**.\n',
	fenced: 'Here is the code:\n\n' + F + 'js\nconst a = 1;\nconsole.log(a);\n' + F + '\n\nAnd then some prose after it.\n\n- one\n- two\n',
	twoBlocks: 'First:\n' + F + '\nplain block\n' + F + '\nbetween\n' + F + 'python\nprint("x")\n' + F + '\nlast words',
	inList: '1. Install it:\n   ' + F + 'bash\n   npm install\n   ' + F + '\n2. Run it.\n',
	nested: 'A Markdown example:\n\n' + F + T + 'markdown\nUse a fence:\n' + F + 'js\nlet x;\n' + F + '\n' + F + T + '\n\nThat was four backticks around three.\n',
	reported: REPORTED
};

// ---------------------------------------------------------------------------------------------------

test('PIN: an ordinary fenced block is a code block, and what surrounds it is prose', () => {
	const h = C.render(DOCS.fenced);
	assert.strictEqual(count(h, 'pre'), 1);
	assert.match(h, /<p>Here is the code:<\/p><pre><code>/);
	assert.ok(text(h).includes('const a = 1;\nconsole.log(a);\n'), 'the code, line for line');
	assert.ok(!text(h).includes('js\nconst'), 'the language tag is not part of the code');
	assert.match(h, /<\/code><\/pre><p>And then some prose after it\.<\/p><ul><li>one<\/li><li>two<\/li><\/ul>$/);
});

test('PIN: two blocks, prose between them, and an unfinished block at the end is still shown as code', () => {
	const h = C.render(DOCS.twoBlocks);
	assert.strictEqual(count(h, 'pre'), 2);
	assert.ok(text(h).includes('plain block\n') && text(h).includes('print("x")\n'));
	assert.match(h, /<p>between<\/p>/); assert.match(h, /<p>last words<\/p>$/);
	const open = C.render('Look:\n' + F + 'js\nconst a = 1;\nstill typing');
	assert.strictEqual(count(open, 'pre'), 1);
	assert.match(open, /<pre><code>[\s\S]*still typing<\/code><\/pre>$/, 'the tail of an open block is code, not prose');
});

test('PIN: inline code is escaped and never formatted; a lone backtick is just a backtick', () => {
	assert.strictEqual(C.mdInline('use ' + T + 'a<b> **x**' + T + ' here'), 'use <code>a&lt;b&gt; **x**</code> here');
	assert.strictEqual(C.mdInline('a ' + T + 'one' + T + ' and ' + T + 'two' + T + '.'), 'a <code>one</code> and <code>two</code>.');
	assert.strictEqual(C.mdInline('5' + T + ' is a backtick'), '5' + T + ' is a backtick');
	assert.strictEqual(C.mdInline('**bold** and *em*'), '<strong>bold</strong> and <em>em</em>');
});

test('PIN: a path in inline code that names a real project file becomes a file chip', () => {
	C.setFiles(['docs/MCP.md', 'extensions/levelcode-ai/agent.js']);
	const h = C.mdInline('see ' + T + 'docs/MCP.md' + T + ' and ' + T + 'nope.md' + T);
	assert.match(h, /<span class="filechip" data-path="docs\/MCP\.md"/);
	assert.match(h, /<code>nope\.md<\/code>/);
	C.setFiles([]);
});

test('PIN: a fence inside a list item, indented, is still a code block', () => {
	const h = C.render(DOCS.inList);
	assert.strictEqual(count(h, 'pre'), 1);
	assert.ok(text(h).includes('npm install'));
	assert.ok(/Run it\./.test(text(h)));
});

test('THE REPORT: three backticks quoted inside four are inline code — one paragraph, no code block', () => {
	const h = C.render(REPORTED);
	assert.strictEqual(count(h, 'pre'), 0, 'no code block: ' + h.slice(0, 300));
	assert.match(h, /^<p>Four opening fences, matching four diagrams, each closed by a plain <code>```<\/code>\. The diagram is grounded entirely in the actual code: config trust tiers \(<code>loadServerConfig<\/code>\)/);
	assert.strictEqual(count(h, 'p'), 2, 'the paragraph, then the Done line');
	assert.match(h, /<p>Done: Added <code>docs\/MCP-DIAGRAM\.md<\/code> — four Mermaid diagrams\.<\/p><ul><li><strong>Flow diagram<\/strong>/);
});

test('THE REPORT, STREAMED: however it arrives, nothing is frozen mid-paragraph and the page ends up the same', () => {
	const whole = C.render(REPORTED);
	for (let seed = 1; seed <= 60; seed++) {
		const r = stream(chunk(REPORTED, sizesFor(seed)));
		assert.strictEqual(r.html, whole, 'seed ' + seed + ': streamed in pieces, it must render as it does whole');
		assert.deepStrictEqual(r.frozen, [], 'seed ' + seed + ': there is no finished code block here, so nothing may be frozen');
	}
	// one character at a time — the worst case for anything that looks at "the text so far"
	const slow = stream(REPORTED.split(''));
	assert.strictEqual(slow.html, whole);
	assert.ok(slow.frames.every((f) => f.frozen.length === 0), 'not at any point along the way either');
});

test('STREAMING: for every document, streamed and whole are the same page — and only finished blocks are frozen', () => {
	for (const [name, src] of Object.entries(DOCS)) {
		const whole = C.render(src);
		for (let seed = 1; seed <= 40; seed++) {
			const r = stream(chunk(src, sizesFor(seed * 7 + name.length)));
			assert.strictEqual(r.html, whole, name + ', seed ' + seed);
			for (const f of r.frozen) { assert.ok(/<\/code><\/pre>$/.test(f) || !/<pre>/.test(f) || /<\/pre>/.test(f), name + ': a frozen piece ends an open block: ' + f.slice(-80)); }
			// frozen pieces are never taken back or changed once written
			let seen = [];
			for (const frame of r.frames) { assert.deepStrictEqual(frame.frozen.slice(0, seen.length), seen, name + ', seed ' + seed + ': a frozen piece changed'); seen = frame.frozen; }
		}
	}
});

test('STREAMING: a finished block is frozen as soon as its closing line is complete, and not a moment before', () => {
	const src = 'Intro\n' + F + 'js\nlet a;\n' + F + '\nAfter the block, more words.';
	const at = (upto) => stream([src.slice(0, upto)]);
	const closeAt = src.indexOf(F + '\nAfter');
	assert.deepStrictEqual(at(closeAt + 2).frozen, [], 'two of the three closing backticks: still open');
	assert.deepStrictEqual(at(closeAt + 3).frozen, [], 'the closing fence with no newline yet: the line is not finished');
	const done = at(closeAt + 4);
	assert.strictEqual(done.frozen.length, 1, 'the newline ends the closing line');
	assert.match(done.frozen[0], /^<p>Intro<\/p><pre><code>[\s\S]*<\/code><\/pre>$/);
	// and what follows it, word by word, stays in the live tail — one paragraph, never a pile of fragments
	const r = stream(chunk(src, [3]));
	assert.strictEqual(r.frozen.length, 1);
	assert.strictEqual(r.html, C.render(src));
	assert.match(r.html, /<p>After the block, more words\.<\/p>$/);
});

test('INLINE: N backticks open a span that N backticks close — so backticks can be quoted', () => {
	assert.strictEqual(C.mdInline('a ' + T + T + 'x ' + T + ' y' + T + T + ' b'), 'a <code>x ' + T + ' y</code> b', 'one backtick inside two');
	assert.strictEqual(C.mdInline('the marker ' + F + T + ' ' + F + ' ' + F + T + ' opens a block'), 'the marker <code>```</code> opens a block', 'three inside four, the padding spaces dropped');
	assert.strictEqual(C.mdInline(T + T + 'plain' + T + T), '<code>plain</code>');
	assert.strictEqual(C.mdInline('odd ' + T + T + 'x' + T + ' ones'), 'odd ' + T + T + 'x' + T + ' ones', 'two and one do not pair: text');
	assert.strictEqual(C.mdInline('a ' + T + 'b\nc' + T + ' d'), 'a ' + T + 'b\nc' + T + ' d', 'a span does not run across a line break');
	assert.strictEqual(C.mdInline(T + ' spaced ' + T), '<code> spaced </code>', 'a single-backtick span keeps its text as written');
	assert.strictEqual(C.mdInline('one ' + T + ' then two ' + T + T + ' end'), 'one ' + T + ' then two ' + T + T + ' end', 'a run is closed by one of the SAME length, not by a longer one');
	assert.strictEqual(C.mdInline('a ' + T + T + ' b ' + F + ' c ' + T + T + ' d'), 'a <code>b ' + F + ' c</code> d', 'a longer run inside is content');
	// a paragraph is handed over whole: spans on its later lines are found where they are
	assert.strictEqual(C.mdInline('first line\nsecond ' + T + 'code' + T + ' here\nthird ' + T + T + 'x' + T + T + '.'), 'first line\nsecond <code>code</code> here\nthird <code>x</code>.');
	assert.strictEqual(C.mdBlocks('one ' + T + 'a' + T + '\ntwo ' + T + 'b' + T), '<p>one <code>a</code><br>two <code>b</code></p>');
});

test('FENCES: a fence is a line — backticks in the middle of a sentence never start a block', () => {
	for (const prose of [
		'Wrap it in ' + F + T + ' ' + F + ' ' + F + T + ' to quote a fence.',
		'The ' + F + ' marker, then text, then ' + F + ' again on one line.',
		'Three ticks ' + F + ' then words and nothing else on the line',
		'It ends with a quoted fence: ' + F + T + ' ' + F + ' ' + F + T
	]) {
		const h = C.render(prose + '\n\nNext paragraph.');
		assert.strictEqual(count(h, 'pre'), 0, 'no code block for: ' + prose);
		assert.match(h, /<p>Next paragraph\.<\/p>$/, 'and the next paragraph is still a paragraph: ' + prose);
	}
});

test('FENCES: a longer fence holds shorter ones — a Markdown example inside four backticks is one block', () => {
	const h = C.render(DOCS.nested);
	assert.strictEqual(count(h, 'pre'), 1);
	assert.ok(text(h).includes('Use a fence:\n' + F + 'js\nlet x;\n' + F + '\n'), 'the inner fence is shown as code, backticks and all');
	assert.match(h, /<p>That was four backticks around three\.<\/p>$/);
});

test('FENCES: the language line may say more than a word, and is never shown as code', () => {
	for (const info of ['js', 'diff', 'c++', 'objective-c', 'js title="app.js"', '{r, echo=FALSE}', 'python {1,3}']) {
		const h = C.render('Before\n' + F + info + '\nBODY\n' + F + '\nAfter');
		assert.strictEqual(count(h, 'pre'), 1, info);
		assert.strictEqual(text(/<pre><code>([\s\S]*?)<\/code><\/pre>/.exec(h)[1]), 'BODY\n', 'info "' + info + '" is not in the block');
		assert.match(h, /<p>After<\/p>$/);
	}
});

test('FENCES, SLOPPY: a fence stuck to the end of a line of prose, or a closing fence stuck to the code, still works', () => {
	const opener = C.render('Run this: ' + F + 'bash\nnpm test\n' + F + '\nDone.');
	assert.strictEqual(count(opener, 'pre'), 1);
	assert.match(opener, /^<p>Run this:\s*<\/p><pre><code>/);
	assert.ok(text(opener).includes('npm test\n'));
	assert.match(opener, /<p>Done\.<\/p>$/);
	const closer = C.render(F + 'js\nlet a = 1;' + F + '\nAfter.');
	assert.strictEqual(count(closer, 'pre'), 1);
	assert.strictEqual(text(/<pre><code>([\s\S]*?)<\/code><\/pre>/.exec(closer)[1]), 'let a = 1;');
	assert.match(closer, /<p>After\.<\/p>$/);
});

test('SAFE: nothing in a message becomes markup — in prose, in inline code, or in a block', () => {
	const evil = '<img src=x onerror=alert(1)> ' + T + '<script>alert(2)</script>' + T + ' ' + F + T + ' <b>x</b> ' + F + T + '\n' + F + 'html\n<script>alert(3)</script>\n' + F + '\n';
	const h = C.render(evil);
	assert.ok(!/<img|<script|<b>/.test(h), h);
	assert.ok(h.includes('&lt;img src=x onerror=alert(1)&gt;') && h.includes('<code>&lt;script&gt;alert(2)&lt;/script&gt;</code>') && h.includes('<code>&lt;b&gt;x&lt;/b&gt;</code>'));
	assert.strictEqual(stream(evil.split('')).html, h);
});

test('ROBUST: any mix of backticks, newlines and words renders without throwing, streamed or whole, to the same page', () => {
	const bits = [T, T + T, F, F + T, '\n', '\n\n', ' ', 'word', 'js', '- item', '**b**', '   ', 'x' + T + 'y', F + 'py\n', '\n' + F + '\n'];
	let x = 12345;
	const rnd = (k) => { x = (x * 1103515245 + 12345) >>> 0; return (x >>> 16) % k; };
	for (let i = 0; i < 400; i++) {
		let src = ''; const len = 3 + rnd(14);
		for (let j = 0; j < len; j++) { src += bits[rnd(bits.length)]; }
		const whole = C.render(src);
		assert.strictEqual(typeof whole, 'string');
		const r = stream(chunk(src, sizesFor(i + 1)));
		assert.strictEqual(r.html, whole, 'case ' + i + ': ' + JSON.stringify(src));
		assert.ok(C.lastStableIndex(src) <= src.length);
	}
});

console.log('chatMarkdownFences: ' + n + ' tests passed');
