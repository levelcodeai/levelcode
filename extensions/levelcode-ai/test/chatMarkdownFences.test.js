/*---------------------------------------------------------------------------------------------
 *  The chat's Markdown renderer: code fences and inline code — run: node test/chatMarkdownFences.test.js
 *
 *  What it does today, pinned before the way it finds a code fence is changed: an ordinary fenced
 *  block, two of them with prose between, a block still being typed, a fence indented inside a list
 *  item, inline code and file chips — and the two sloppy shapes models produce that it already
 *  tolerates (a fence stuck to the end of a line of prose; a closing fence stuck to the code).
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

const DOCS = {
	fenced: 'Here is the code:\n\n' + F + 'js\nconst a = 1;\nconsole.log(a);\n' + F + '\n\nAnd then some prose after it.\n\n- one\n- two\n',
	twoBlocks: 'First:\n' + F + '\nplain block\n' + F + '\nbetween\n' + F + 'python\nprint("x")\n' + F + '\nlast words',
	inList: '1. Install it:\n   ' + F + 'bash\n   npm install\n   ' + F + '\n2. Run it.\n'
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

console.log('chatMarkdownFences: ' + n + ' tests passed');
