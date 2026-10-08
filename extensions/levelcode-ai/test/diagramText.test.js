/*---------------------------------------------------------------------------------------------
 *  Rich diagrams — a diagram as words — run: node test/diagramText.test.js
 *
 *  docs/RICH-DIAGRAMS.md, "UX" (accessibility, fallback) and "Context budget" (the stub).
 *  A picture has three readers it cannot serve: a screen reader, a model reading a compacted
 *  conversation, and another tool. Each gets text generated from the SAME spec — so the model never
 *  has to draw ASCII itself, and nothing the picture says is missing from the words.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const T = require('../diagram/text');
const A = require('../diagram/ascii');
const R = require('../diagram/repair');

let n = 0;
function test(name, fn) { fn(); n++; console.log('  ok - ' + name); }

const gallery = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'diagrams', 'gallery.json'), 'utf8'));
const specOf = (name) => R.prepare(gallery.find((g) => g.name === name).spec).spec;

test('OUTLINE: every node and every connection, in the order the model wrote them', () => {
	const o = T.outline(specOf('jev'));
	assert.strictEqual(o.title, 'Jev classifies; your code decides the action');
	assert.strictEqual(o.summary, '4 nodes, 3 connections.');
	assert.deepStrictEqual(o.nodes, ['Customer message — plus account details', 'Jev — returns probabilities, highlighted', 'Route to billing', 'Human review']);
	assert.deepStrictEqual(o.edges, ['Customer message to Jev', 'Jev to Route to billing, 0.90 or more', 'Jev to Human review, under 0.90']);
	assert.ok(o.text.startsWith('Jev classifies; your code decides the action. 4 nodes, 3 connections. Nodes: '));
});

test('OUTLINE: shape, group, link and line style are said in words', () => {
	const o = T.outline(specOf('arch'));
	assert.ok(o.nodes.includes('Chat webview, actor'));
	assert.ok(o.nodes.includes('agent.js — tool loop, in Extension host, highlighted, opens agent.js'));
	assert.ok(o.nodes.includes('Sessions — append-only JSONL, data store, in Extension host'));
	assert.ok(o.edges.includes('agent.js to Sessions, each turn (dashed)'));
	assert.strictEqual(T.outline(specOf('single')).summary, '1 node, 0 connections.');
});

test('OUTLINE: a shortened label is read out in full — a screen reader has no tooltip to hover', () => {
	const spec = R.prepare({ title: 'T', nodes: [{ id: 'a', label: 'Validate the incoming request payload' }, { id: 'b', label: 'Store' }], edges: [{ from: 'a', to: 'b', label: 'when every field checks out' }] }).spec;
	assert.strictEqual(spec.nodes[0].label, 'Validate the incoming…');
	const o = T.outline(spec);
	assert.strictEqual(o.nodes[0], 'Validate the incoming request payload');
	assert.strictEqual(o.edges[0], 'Validate the incoming request payload to Store, when every field checks out');
});

test('OUTLINE: never throws, whatever it is handed', () => {
	for (const junk of [null, undefined, {}, { nodes: 'x' }, { nodes: [], edges: [{ from: 'a', to: 'b' }] }]) {
		const o = T.outline(junk);
		assert.strictEqual(typeof o.text, 'string');
		assert.strictEqual(o.edges.length, 0);
	}
});

test('STUB: one line, in the shape the spec gives — "diagram: <title>, <n> nodes, id <id>"', () => {
	assert.strictEqual(T.stub({ id: 'd-17', spec: specOf('jev') }), 'diagram: Jev classifies; your code decides the action, 4 nodes, id d-17');
	assert.strictEqual(T.stub({ id: 'd-2', spec: specOf('single') }), 'diagram: One box, 1 node, id d-2');
	assert.ok(!/\n/.test(T.stub({ id: 'd-1', spec: { title: 'a\nb', nodes: [] } })), 'always exactly one line');
	assert.strictEqual(T.stub(null), 'diagram: untitled, 0 nodes, id ?');
	assert.ok(T.stub({ id: 'd-17', spec: specOf('twelve') }).length < JSON.stringify(specOf('twelve')).length / 10, 'a stub is a fraction of the spec it stands for');
});

test('MERMAID: a flowchart with shapes, groups, labels, dashes and the accent', () => {
	const mm = T.toMermaid(specOf('arch'));
	assert.strictEqual(mm.split('\n').slice(0, 4).join('\n'), '---\ntitle: "The agent talks to providers through one registry"\n---\nflowchart LR');
	assert.match(mm, /^ {2}chat\(\["Chat webview"\]\)$/m, 'actor → stadium');
	assert.match(mm, /^ {2}subgraph group_ext\["Extension host"\]$/m);
	assert.match(mm, /^ {4}agent\["agent\.js<br\/>tool loop"\]$/m, 'label and second line');
	assert.match(mm, /^ {4}store\[\("Sessions<br\/>append-only JSONL"\)\]$/m, 'store → cylinder');
	assert.match(mm, /^ {2}chat -->\|"goal"\| agent$/m);
	assert.match(mm, /^ {2}agent -\.->\|"each turn"\| store$/m, 'dashed');
	assert.match(mm, /^ {2}class agent accent$/m);
	assert.strictEqual((mm.match(/^\s*subgraph /gm) || []).length, (mm.match(/^\s*end$/gm) || []).length, 'every subgraph closes');
	assert.match(T.toMermaid(specOf('decision')), /^flowchart TD$/m, 'down → TD');
	assert.match(T.toMermaid(specOf('decision')), /q\{"Tool running\?"\}/, 'decision → diamond');
	assert.ok(!T.toMermaid(specOf('jev'), { title: false }).startsWith('---'));
});

test('MERMAID: nested groups nest, and every node appears exactly once', () => {
	const spec = specOf('twelve');
	const mm = T.toMermaid(spec);
	const lines = mm.split('\n');
	const app = lines.findIndex((l) => /subgraph group_app/.test(l)), w = lines.findIndex((l) => /subgraph group_w/.test(l));
	assert.ok(app >= 0 && w > app, 'Workers is declared inside Application');
	assert.ok(lines[w].startsWith('    '), 'and indented under it');
	for (const node of spec.nodes) {
		const id = T.mermaidIds(spec.nodes.map((x) => x.id)).get(node.id);
		assert.strictEqual(lines.filter((l) => new RegExp('^\\s*' + id + '[\\[({]').test(l)).length, 1, node.id + ' is declared once');
	}
});

test('MERMAID: the breakers the spec lists cannot occur — ids are rewritten, labels quoted and escaped', () => {
	// "capitalize a lowercase `end`", "an `o` or `x` that starts a linked node", "quote labels containing special characters"
	const spec = R.prepare({ title: 'A "quoted" <title>', nodes: [{ id: 'end', label: 'end' }, { id: 'o1', label: 'say "hi" & <go>' }, { id: 'x-ray', label: 'a|b [c] {d} (e)' }, { id: '9lives', label: 'nine' }, { id: 'class', label: 'class' }], edges: [{ from: 'end', to: 'o1', label: 'a "b" | c' }, { from: 'o1', to: 'x-ray' }, { from: 'x-ray', to: '9lives' }, { from: '9lives', to: 'class' }] }).spec;
	const mm = T.toMermaid(spec);
	assert.match(mm, /^ {2}n_end\["end"\]$/m, '`end` would close a subgraph; as an id it is renamed');
	assert.match(mm, /^ {2}n_class\["class"\]$/m);
	assert.match(mm, /^ {2}n_9lives\["nine"\]$/m, 'an id cannot start with a digit');
	assert.match(mm, /^ {2}x_ray\[/m, 'no hyphens in ids');
	assert.match(mm, /o1\["say #quot;hi#quot; #amp; #lt;go#gt;"\]/, 'quotes and angle brackets are entities');
	assert.match(mm, /^ {2}n_end -->\|"a #quot;b#quot; \| c"\| o1$/m, 'a pipe inside a QUOTED label is just a pipe');
	assert.match(mm, /^ {2}o1 --> x_ray$/m, 'an arrow always has spaces round it, so "o"/"x" never read as an arrowhead');
	assert.match(mm, /^title: "A \\"quoted\\" <title>"$/m);
	for (const line of mm.split('\n')) { assert.ok(!/["\]]\s*-->\S|\S-->/.test(line), 'spaced arrows: ' + line); }
	// ids stay unique even when two different slugs collapse to the same Mermaid id
	const ids = T.mermaidIds(['a-b', 'a_b', 'a.b']);
	assert.strictEqual(new Set(ids.values()).size, 3);
});

test('SOURCE: what "Copy source" gives is the model\'s spec — none of the renderer\'s own fields', () => {
	const spec = R.prepare({ title: 'T', nodes: [{ id: 'a', label: 'Validate the incoming request payload' }], edges: [] }).spec;
	assert.ok(spec.nodes[0].tip);
	const src = JSON.parse(T.toSource(spec));
	assert.strictEqual(src.nodes[0].tip, undefined);
	assert.strictEqual(R.prepare(src).status, 'ok', 'and it is a valid spec to send straight back');
	assert.ok(spec.nodes[0].tip, 'toSource() does not mutate');
});

test('ASCII: drawn from the same layout as the picture — boxes, arrows, and labels beside their lines', () => {
	const out = A.render(specOf('jev'));
	const lines = out.split('\n');
	assert.strictEqual(lines[0], 'Jev classifies; your code decides the action');
	for (const label of ['Customer message', 'plus account details', 'Jev', 'returns probabilities', 'Route to billing', 'Human review', '0.90 or more', 'under 0.90']) { assert.ok(out.includes(label), 'missing "' + label + '"'); }
	const row = (text) => lines.findIndex((l) => l.includes(text));
	assert.ok(row('Route to billing') < row('Human review'), 'the two outcomes are stacked as in the picture');
	assert.ok(lines[row('Customer message')].indexOf('Customer message') < lines[row('Route to billing')].indexOf('Route to billing'), 'and the flow still reads left to right');
	assert.strictEqual((out.match(/>/g) || []).length, 3, 'three connectors, three arrowheads');
	assert.match(lines[row('0.90 or more') + 1], /-+>\|/, 'the label sits on the row ABOVE its line, which runs into the box');
	assert.match(out, /#{5,}/, 'the accent box is marked');
	assert.ok(lines.every((l) => l === l.replace(/\s+$/, '')), 'no trailing spaces');
	assert.ok(out.endsWith('\n') && !out.endsWith('\n\n'));
});

test('ASCII: plain ASCII only — it must survive any terminal and any font', () => {
	for (const g of gallery) {
		const out = A.render(R.prepare(g.spec).spec).split('\n').slice(1).join('\n');   // the title is the user's text
		// eslint-disable-next-line no-control-regex
		assert.ok(/^[\x20-\x7e\n]*$/.test(out), g.name + ' uses a character outside printable ASCII');
	}
});

test('ASCII: a shortened label ends in three dots — a diagram of plain words stays plain ASCII when it is cut to fit', () => {
	const p = R.prepare({ title: 'Long labels are shortened', nodes: [{ id: 'a', label: 'Customer message with the whole account history', sub: 'and a second line that also runs on far too long', group: 'g' }, { id: 'b', label: 'B' }], edges: [{ from: 'a', to: 'b', label: 'a label that is much too long' }], groups: [{ id: 'g', label: 'A group whose name is longer than a group name may be' }] });
	assert.ok(/…$/.test(p.spec.nodes[0].label), 'the stored label carries the ellipsis the picture shows');
	const out = A.render(p.spec);
	// eslint-disable-next-line no-control-regex
	assert.ok(/^[\x20-\x7e\n]*$/.test(out), 'nothing outside printable ASCII: ' + JSON.stringify(out.match(/[^\x20-\x7e\n]/g)));
	const lines = out.split('\n');
	const sub = lines.find((l) => l.includes('and a second line that also...'));
	assert.match(sub, /\| and a second line that also\.\.\. \|/, 'the box is sized for the dots it is given: one space each side of its longest line\n' + out);
	assert.match(out, /\| +Customer message with the\.\.\. +\|/);
	assert.match(out, /a label that is\.\.\./);
	assert.match(out, /\. {2}A group whose name is\.\.\. /, 'a group\'s name too\n' + out);
	assert.ok(/…$/.test(p.spec.nodes[0].label), 'and the spec itself is untouched');
});

test('ASCII: wide characters take two cells and marks take none — a box in Japanese still closes on one column', () => {
	assert.deepStrictEqual(['abc', '日本語', 'Café', '🚀', 'ｆｕｌｌ', '한국어', '', '⚠️', '⚠'].map(A.width), [3, 6, 4, 2, 8, 6, 0, 2, 1]);
	// measured independently of the renderer: anything in the CJK and fullwidth blocks counts double
	const cols = (line) => Array.from(line).reduce((a, ch) => a + (/[　-鿿가-힣＀-｠]/.test(ch) ? 2 : 1), 0);
	const out = A.render(R.prepare({ title: 'T', nodes: [{ id: 'a', label: '顧客メッセージ', sub: 'アカウント情報つき' }, { id: 'b', label: '請求へ回す' }], edges: [{ from: 'a', to: 'b', label: '分類' }] }).spec);
	const rows = out.split('\n').slice(2).filter(Boolean);
	const first = rows.filter((l) => /^[+|]/.test(l));
	assert.strictEqual(first.length, 4, 'the first box: its lid, two lines of text, its base\n' + out);
	// where the first box closes, on every one of its rows
	const closes = first.map((l) => { const m = /^(\+-+\+|\|.*?\|)/.exec(l); return cols(m[1]); });
	assert.strictEqual(new Set(closes).size, 1, 'the right-hand side is on columns ' + closes.join(', ') + '\n' + out);
	// and the second box, further along the row, is square too: every row of it ends on the same column
	const ends = rows.filter((l) => /[+|]$/.test(l) && cols(l) > closes[0]).map(cols);
	assert.ok(ends.length >= 3 && new Set(ends).size === 1, 'the second box ends on columns ' + ends.join(', ') + '\n' + out);
	assert.ok(out.includes('顧客メッセージ') && out.includes('分類'), 'the text itself is not altered');
});

test('ASCII: shapes are told apart, groups are framed, dashed lines are dashed', () => {
	const d = A.render(specOf('decision'));
	assert.match(d, /\.-+\.\n\s*\( +Steer arrives +\)/, 'an actor is a rounded box');
	assert.match(d, /< +Tool running\? +>/, 'a decision is marked with angle brackets');
	assert.match(d, /\|yes/); assert.match(d, /\|no/);
	assert.ok((d.match(/v/g) || []).length >= 5, 'arrowheads point down the flow');
	const a = A.render(specOf('arch'));
	assert.match(a, /\. {2}Extension host /, 'a group frame carries its label');
	assert.match(a, /\.=+\..*\n.*Sessions/, 'a store has a doubled lid');
	assert.match(a, /- - - /, 'the dashed edge is drawn dashed');
});

test('ASCII: a group\'s name is never cut by a line — it moves along its frame as it does in the picture, or is written over the line', () => {
	// the architecture diagram turned downward: a connector comes in exactly where "Providers" would sit
	const out = A.render(specOf('arch'), { maxCols: 60 });
	const row = out.split('\n').find((l) => l.includes('Providers'));
	assert.ok(row, out);
	assert.match(row, /^\.[ .]*\+ Providers [ .+]*\.$/, 'the name is whole, on the frame\'s top row, just past the line that comes in: ' + JSON.stringify(row));
	assert.match(out, /\. {2}Extension host /, 'a name nothing crosses stays in its corner');
	// no stretch of the frame is clear: the name is written over the line, and the line carries on below it
	const s = R.prepare({ title: 'T', direction: 'down', groups: [{ id: 'g', label: 'A container with a long name' }], nodes: [{ id: 'top', label: 'Chat webview' }, { id: 'a', label: 'A', group: 'g' }], edges: [{ from: 'top', to: 'a' }] }).spec;
	const lines = A.render(s).split('\n');
	const at = lines.findIndex((l) => l.includes('A container with a long name'));
	assert.ok(at > 0, lines.join('\n'));
	assert.match(lines[at], /^\. {2}A container with a long name [ .]*\.$/);
	const col = lines[at - 1].indexOf('|');
	assert.ok(col > 0 && lines[at + 1][col] === '|', 'the connector is there above the name and below it:\n' + lines.slice(at - 1, at + 2).join('\n'));
	assert.ok(col > lines[at].indexOf('A container') && col < lines[at].indexOf('name') + 4, 'and it is the name that covers it');
});

test('ASCII: every gallery diagram renders, each node label is on the page, and it is deterministic', () => {
	for (const g of gallery) {
		const spec = R.prepare(g.spec).spec;
		const out = A.render(spec);
		for (const node of spec.nodes) { assert.ok(out.includes(node.label), g.name + ': "' + node.label + '" is missing'); }
		assert.strictEqual(A.render(spec), out, g.name);
		assert.ok(out.split('\n').every((l) => l.length < 260), g.name + ' is absurdly wide');
	}
});

test('ASCII: a flow too wide for the page turns downward, like the picture does', () => {
	const chain = R.prepare({ title: 'T', direction: 'right', nodes: Array.from({ length: 7 }, (_, i) => ({ id: 'n' + i, label: 'Pipeline stage ' + (i + 1) })), edges: Array.from({ length: 6 }, (_, i) => ({ from: 'n' + i, to: 'n' + (i + 1) })) }).spec;
	const wide = A.render(chain), fit = A.render(chain, { maxCols: 60 });
	const widest = (s) => Math.max.apply(null, s.split('\n').map((l) => l.length));
	assert.ok(widest(wide) > 120);
	assert.ok(widest(fit) <= 60, 'fits 60 columns: ' + widest(fit));
	assert.ok(fit.split('\n').length > wide.split('\n').length, 'by growing downward');
});

console.log('diagramText: ' + n + ' tests passed');
