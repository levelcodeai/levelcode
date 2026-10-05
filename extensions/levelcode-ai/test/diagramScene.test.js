/*---------------------------------------------------------------------------------------------
 *  Rich diagrams — the painter and the house style — run: node test/diagramScene.test.js
 *
 *  docs/RICH-DIAGRAMS.md, "Safe rendering" and "Style guide". Two promises are pinned here:
 *
 *  SAFE.   Model output is untrusted. A label is a text node, never markup; a diagram is built from
 *          two short allow-lists with no script, no foreignObject, no href, no style attribute and no
 *          event handler in them; and the painter refuses anything off the lists.
 *  STYLED. One module owns every visual decision, colours are editor theme tokens, and the rendered
 *          SVG for known diagrams is snapshotted under both palettes — so a change of style is a
 *          diff someone looked at, not an accident.
 *
 *      UPDATE_SNAPSHOTS=1 node test/diagramScene.test.js     regenerate, then LOOK at the result
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const scene = require('../diagram/scene');
const layout = require('../diagram/layout');
const repair = require('../diagram/repair');
const theme = require('../diagram/theme');

let n = 0;
function test(name, fn) { fn(); n++; console.log('  ok - ' + name); }

const FIX = path.join(__dirname, 'fixtures', 'diagrams');
const gallery = JSON.parse(fs.readFileSync(path.join(FIX, 'gallery.json'), 'utf8'));
const specOf = (name) => repair.prepare(gallery.find((g) => g.name === name).spec).spec;
const build = (spec, opts) => scene.build(spec, layout.layout(spec), opts);
const walk = (node, fn) => { fn(node); for (const c of (node.children || [])) { walk(c, fn); } };
/** Every start tag in a serialized SVG, with its attribute names. Text is escaped, so a raw "<" only ever opens one of ours. */
function tagsIn(svg) {
	const out = [];
	const body = svg.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '');
	const re = /<([A-Za-z][\w:-]*)((?:\s+[\w:-]+="[^"]*")*)\s*\/?>/g;
	let m;
	while ((m = re.exec(body))) { out.push({ tag: m[1], attrs: (m[2].match(/[\w:-]+(?==")/g) || []) }); }
	return out;
}

/** The nastiest labels we can think of — each of these must come out as the text it is. */
const HOSTILE = {
	title: '</title><script>alert("t")</script>',
	nodes: [
		{ id: 'a', label: '<script>alert(1)</script>', sub: '"><img src=x onerror=alert(2)>' },
		{ id: 'b', label: "'><svg onload=alert(3)>", link: { path: 'javascript:alert(4)', symbol: '"><x' } },
		{ id: 'c', label: '</text><foreignObject>', sub: '&lt;b&gt; ]]> &amp; &#x3c;' },
		{ id: 'd', label: '<a href="//evil">x</a>', shape: 'decision' }
	],
	edges: [{ from: 'a', to: 'b', label: '<style>*{}</style>' }, { from: 'b', to: 'c', label: '" onmouseover="x' }, { from: 'c', to: 'd' }],
	groups: [{ id: 'g', label: '<iframe src=//evil>' }]
};
HOSTILE.nodes[0].group = 'g';

test('ALLOW-LIST: there is no script, foreignObject, link or image element, and no href, style or handler attribute', () => {
	for (const bad of ['script', 'foreignObject', 'a', 'image', 'use', 'iframe', 'object', 'embed', 'animate', 'set']) { assert.ok(!scene.TAGS.has(bad), '<' + bad + '> must not be drawable'); }
	for (const bad of ['href', 'xlink:href', 'style', 'src', 'onclick', 'onload', 'onerror', 'id', 'filter', 'mask', 'clip-path', 'fill', 'stroke']) { assert.ok(!scene.ATTRS.has(bad), 'attribute "' + bad + '" must not be settable'); }
	for (const a of scene.ATTRS) { assert.ok(!/^on/i.test(a), a + ' looks like an event handler'); }
});

test('ALLOW-LIST: everything the painter builds is on the lists — the gallery and the hostile spec', () => {
	const specs = gallery.map((g) => repair.prepare(g.spec).spec).concat([repair.prepare(HOSTILE, { final: true }).spec]);
	for (const spec of specs) {
		for (const opts of [{}, { title: true, css: theme.css({ resolved: theme.PALETTES.dark }), standalone: true }]) {
			walk(build(spec, opts), (node) => {
				assert.ok(scene.TAGS.has(node.tag), '<' + node.tag + '>');
				for (const k of Object.keys(node.attrs)) { assert.ok(scene.ATTRS.has(k), k + ' on <' + node.tag + '>'); }
				assert.ok(!(node.text != null && node.children && node.children.length), 'an element has text or children, never both');
			});
		}
	}
});

test('ALLOW-LIST: both painters REFUSE what is off the lists, rather than trusting whoever built the tree', () => {
	const fakeDoc = { createElementNS: () => ({ setAttribute() {}, appendChild() {}, set textContent(v) {} }) };
	const bad = [
		{ tag: 'script', attrs: {}, text: 'alert(1)' },
		{ tag: 'foreignObject', attrs: {} },
		{ tag: 'a', attrs: {} },
		{ tag: 'g', attrs: { onclick: 'alert(1)' } },
		{ tag: 'g', attrs: { href: 'javascript:alert(1)' } },
		{ tag: 'rect', attrs: { style: 'background:url(//evil)' } },
		{ tag: 'svg', attrs: {}, children: [{ tag: 'g', attrs: {}, children: [{ tag: 'script', attrs: {} }] }] }
	];
	for (const vnode of bad) {
		assert.throws(() => scene.toSvg(vnode), /not allowed/, 'toSvg: ' + JSON.stringify(vnode));
		assert.throws(() => scene.mount(vnode, fakeDoc), /not allowed/, 'mount: ' + JSON.stringify(vnode));
	}
	assert.throws(() => scene.mount({ tag: 'style', attrs: {}, text: '*{}' }, fakeDoc), /not allowed/, 'the live view never takes a stylesheet from a tree');
});

test('TEXT NODES: mount() puts every label in with textContent — markup in a label never becomes an element', () => {
	// A stand-in document that records what was done to it, and has no innerHTML to misuse.
	const made = [];
	const doc = { createElementNS(ns, tag) {
		const el = { ns, tag, attrs: {}, kids: [], text: null,
			setAttribute(k, v) { this.attrs[k] = v; }, appendChild(c) { this.kids.push(c); },
			set textContent(v) { this.text = v; }, get textContent() { return this.text; },
			set innerHTML(v) { throw new Error('innerHTML was used'); }, set outerHTML(v) { throw new Error('outerHTML was used'); },
			insertAdjacentHTML() { throw new Error('insertAdjacentHTML was used'); } };
		made.push(el); return el;
	} };
	const spec = repair.prepare(HOSTILE, { final: true }).spec;
	const root = scene.mount(build(spec), doc);
	assert.strictEqual(root.tag, 'svg');
	assert.ok(made.every((el) => el.ns === 'http://www.w3.org/2000/svg'), 'every element is created in the SVG namespace');
	assert.ok(made.every((el) => scene.TAGS.has(el.tag) && el.tag !== 'style'));
	const texts = made.filter((el) => el.text != null).map((el) => el.text);
	assert.ok(texts.includes('<script>alert(1)</script>'), 'the label is there, as text: ' + texts.join(' | '));
	assert.ok(texts.includes('</text><foreignObject>'));
	assert.ok(!made.some((el) => /script|foreignobject|img|iframe/i.test(el.tag)), 'and nothing it "contained" exists as an element');
	for (const el of made) { for (const k of Object.keys(el.attrs)) { assert.ok(scene.ATTRS.has(k) && !/^on|href|style/i.test(k), k); } }
});

test('ESCAPING: a serialized diagram contains only our elements and attributes, whatever the labels said', () => {
	const spec = repair.prepare(HOSTILE, { final: true }).spec;
	const svg = scene.toSvg(build(spec, { title: true, css: theme.css({ resolved: theme.PALETTES.light }), standalone: true }));
	const tags = tagsIn(svg);
	assert.ok(tags.length > 20);
	for (const t of tags) {
		assert.ok(scene.TAGS.has(t.tag), 'unexpected element <' + t.tag + '>');
		for (const a of t.attrs) { assert.ok(scene.ATTRS.has(a), 'unexpected attribute ' + a + ' on <' + t.tag + '>'); }
	}
	// No attribute value was broken out of. Text is escaped, so every "<" opens a tag — and every tag
	// must be either a plain end tag or a start tag made of nothing but name="value" pairs.
	const markup = svg.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '');
	for (const m of markup.matchAll(/<[^>]*>/g)) {
		assert.ok(/^<\/[A-Za-z][\w:-]*>$/.test(m[0]) || /^<[A-Za-z][\w:-]*(\s+[\w:-]+="[^"<>]*")*\s*\/?>$/.test(m[0]), 'malformed tag: ' + m[0]);
	}
	assert.ok(!/<[^>]*$/.test(markup), 'no tag is left open');
	assert.ok(svg.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), 'the label survives, escaped');
	assert.ok(!/<script|<foreignObject|<img|<iframe|<a\s/i.test(svg));
	// well-formed: every tag that opens closes, in order
	const stack = [];
	const body = svg.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '');
	for (const m of body.matchAll(/<(\/?)([A-Za-z][\w:-]*)[^>]*?(\/?)>/g)) {
		if (m[1]) { assert.strictEqual(stack.pop(), m[2], 'mismatched </' + m[2] + '>'); } else if (!m[3]) { stack.push(m[2]); }
	}
	assert.deepStrictEqual(stack, []);
});

test('LINKS: a clickable node carries its NODE ID, never the path — the host looks the link up itself', () => {
	const spec = specOf('arch');
	let linked = 0;
	walk(build(spec), (node) => {
		if (node.attrs['data-lc-link'] === undefined) { return; }
		linked++;
		assert.match(String(node.attrs['data-lc-link']), /^[a-z0-9][a-z0-9_-]*$/, 'a slug, so it cannot smuggle anything');
		assert.strictEqual(node.attrs['data-lc-link'], node.attrs['data-lc-node']);
		assert.strictEqual(node.attrs.tabindex, '0', 'reachable from the keyboard');
		assert.strictEqual(node.attrs.role, 'link');
		assert.match(node.attrs['aria-label'], /^Open /);
		assert.ok(node.children.some((c) => c.tag === 'title'), 'hover shows the path');
		assert.ok(node.children.some((c) => c.attrs.class === 'lcd-link-icon'), 'and a small file glyph marks it');
	});
	assert.strictEqual(linked, 2);
	const hostile = repair.prepare(HOSTILE, { final: true }).spec;
	walk(build(hostile), (node) => { if (node.attrs['data-lc-link']) { assert.strictEqual(node.attrs['data-lc-link'], 'b', 'the javascript: "path" is nowhere in an attribute the host acts on'); } });
});

test('ACCESSIBLE: the picture is an image named by its title', () => {
	const svg = build(specOf('jev'));
	assert.strictEqual(svg.attrs.role, 'img');
	assert.strictEqual(svg.attrs['aria-label'], 'Jev classifies; your code decides the action');
	assert.strictEqual(svg.attrs.focusable, 'false');
});

test('STYLE GUIDE: the type scale, the box and the accent are the numbers in the spec', () => {
	assert.deepStrictEqual([theme.TYPE.title.size, theme.TYPE.name.size, theme.TYPE.sub.size], [15, 13, 11.5], 'three sizes: title 15, node name 13, secondary 11.5');
	assert.strictEqual(theme.TYPE.name.weight, 600, 'node name is semibold');
	assert.strictEqual(theme.MIN_TEXT, 10.5);
	for (const t of Object.values(theme.TYPE)) { assert.ok(t.size >= theme.MIN_TEXT, 'nothing below 10.5'); }
	assert.deepStrictEqual([theme.BOX.radius, theme.BOX.border, theme.BOX.padX, theme.BOX.accentBorder], [8, 1.25, 12, 2]);
	assert.strictEqual(theme.SPACE.groupInset, 16, 'children inset 16');
	const css = theme.css();
	assert.match(css, /\.lcd-shape \{[^}]*stroke-width: 1\.25px/);
	assert.match(css, /\.lcd-accent \.lcd-shape \{[^}]*stroke-width: 2px/);
	const box = build(specOf('jev')).children[0].children.find((g) => g.attrs.class === 'lcd-nodes').children[0].children[0];
	assert.strictEqual(box.tag, 'rect'); assert.strictEqual(box.attrs.rx, '8');
});

test('STYLE GUIDE: same kind, same shape — box, diamond, cylinder, pill', () => {
	const spec = repair.prepare({ title: 'T', nodes: [{ id: 'a', label: 'Step' }, { id: 'b', label: 'Branch?', shape: 'decision' }, { id: 'c', label: 'Data', shape: 'store' }, { id: 'd', label: 'Person', shape: 'actor' }], edges: [] }).spec;
	const nodes = build(spec).children[0].children.find((g) => g.attrs.class === 'lcd-nodes').children;
	const shapeOf = (i) => nodes[i].children.filter((c) => /lcd-shape/.test(c.attrs.class || ''));
	assert.strictEqual(shapeOf(0)[0].tag, 'rect');
	assert.strictEqual(shapeOf(1)[0].tag, 'path'); assert.strictEqual((shapeOf(1)[0].attrs.d.match(/L/g) || []).length, 3, 'a diamond has four corners');
	assert.strictEqual(shapeOf(2).length, 2, 'a cylinder is a body and a lid'); assert.match(shapeOf(2)[0].attrs.d, /A/);
	const pill = shapeOf(3)[0];
	assert.strictEqual(pill.tag, 'rect'); assert.strictEqual(Number(pill.attrs.rx), Number(pill.attrs.height) / 2, 'a pill is rounded to half its height');
});

test('THEME: colours are editor theme tokens — the live stylesheet contains no colour of its own', () => {
	const css = theme.css();
	const rules = css.split('\n').filter((l) => !/--lcd-[a-z-]+:/.test(l));   // everything except the token definitions
	for (const rule of rules) { assert.ok(!/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/.test(rule), 'a literal colour in: ' + rule); }
	for (const m of css.matchAll(/var\(--lcd-([a-z-]+)\)/g)) { assert.ok(theme.TOKEN_NAMES.includes(m[1]), '--lcd-' + m[1] + ' is used but never defined'); }
	for (const name of theme.TOKEN_NAMES) { assert.match(theme.TOKENS[name], /var\(--vscode-/, name + ' is defined from the editor theme'); }
	assert.match(css, /^\.lcd \{/, 'scoped to the diagram container');
	assert.ok(css.split('\n').every((l) => /^(body\.vscode-high-contrast[^{]*)?\.lcd[ ,{]/.test(l)), 'no rule reaches outside it');
	assert.match(css, /vscode-high-contrast/, 'high-contrast themes get real borders');
});

test('THEME: an exported stylesheet has every token resolved, and both palettes are legible', () => {
	const lum = (hex) => { const v = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4))); return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2]; };
	const contrast = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
	for (const mode of ['light', 'dark']) {
		const pal = theme.PALETTES[mode];
		for (const name of theme.TOKEN_NAMES) { assert.ok(pal[name], mode + ' palette is missing ' + name); }
		const css = theme.css({ resolved: pal });
		assert.ok(!/var\(/.test(css), mode + ': nothing is left to resolve');
		assert.match(css, /^svg\.lcd-svg /m, 'scoped so it can sit inside a standalone file');
		assert.ok(contrast(pal.fg, pal.bg) >= 7, mode + ' text ' + contrast(pal.fg, pal.bg).toFixed(1));
		assert.ok(contrast(pal.muted, pal.bg) >= 4.5, mode + ' secondary text ' + contrast(pal.muted, pal.bg).toFixed(1));
		assert.ok(contrast(pal.fg, pal['node-fill']) >= 7, mode + ' text on a box');
		assert.ok(contrast(pal.fg, pal['accent-fill']) >= 7, mode + ' text on the accent box');
		assert.ok(contrast(pal.accent, pal.bg) >= 3, mode + ' accent border');
		assert.ok(contrast(pal.line, pal.bg) >= 3, mode + ' connectors');
		assert.ok(contrast(pal['node-stroke'], pal.bg) >= 1.8, mode + ' box border is visible but quiet');
	}
});

test('EXPORT: a file has no page behind it, so an export paints the editor background itself', () => {
	const spec = specOf('jev');
	const bare = build(spec, {}), filled = build(spec, { background: true, css: theme.css({ resolved: theme.PALETTES.dark }), standalone: true });
	const bg = (tree) => { let found = null; walk(tree, (node) => { if (node.attrs.class === 'lcd-bg') { found = node; } }); return found; };
	assert.strictEqual(bg(bare), null, 'in the chat the page IS the background');
	const rect = bg(filled);
	assert.deepStrictEqual([rect.tag, rect.attrs.width, rect.attrs.height], ['rect', String(filled.width), String(filled.height)], 'it covers the whole picture');
	assert.strictEqual(filled.children[0].tag, 'style'); assert.strictEqual(filled.children[1], rect, 'and sits behind everything else');
	assert.match(theme.css({ resolved: theme.PALETTES.dark }), /\.lcd-bg \{ fill: #1e1f22; \}/);
});

test('EXPORT: the title is drawn inside an exported file, wrapped to the picture', () => {
	const spec = specOf('decision');
	const plain = build(spec), titled = build(spec, { title: true });
	const titles = [];
	walk(titled, (node) => { if (node.attrs.class === 'lcd-title') { titles.push(node.text); } });
	assert.ok(titles.length >= 2, 'a long title wraps: ' + titles.join(' / '));
	assert.strictEqual(titles.join(' '), spec.title, 'and loses no word');
	assert.ok(titled.height > plain.height);
	let any = false; walk(plain, (node) => { if (node.attrs.class === 'lcd-title') { any = true; } });
	assert.strictEqual(any, false, 'in the chat the title is HTML above the picture, not part of it');
	assert.strictEqual(scene.toSvg(build(spec, { standalone: true })).slice(0, 5), '<svg ');
	assert.match(scene.toSvg(build(spec, { standalone: true })), /xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
});

test('GEOMETRY: connectors round their corners, and stop at the base of the arrowhead', () => {
	const d = scene.edgePath([{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 40 }, { x: 100, y: 40 }], 5, 6);
	assert.strictEqual(d, 'M0,0 L45,0 Q50,0 50,5 L50,35 Q50,40 55,40 L94,40');
	assert.strictEqual(scene.edgePath([{ x: 0, y: 0 }, { x: 3, y: 0 }, { x: 3, y: 3 }], 5, 0), 'M0,0 L1.5,0 Q3,0 3,1.5 L3,3', 'a corner never rounds past half a run');
	assert.strictEqual(scene.arrowPath({ x: 100, y: 40, dx: 1, dy: 0 }, theme.SPACE), 'M100,40 L93,43.6 L93,36.4 Z');
});

test('GROUP NAMES: a name that a connector has to pass behind is drawn AFTER the connectors, backed — every other name is drawn with its frame', () => {
	// one group whose name is clear, and one whose frame has no clear stretch for it
	const s = repair.prepare({ title: 'T', direction: 'down', groups: [{ id: 'long', label: 'A container with a long name' }, { id: 'ok', label: 'Data' }],
		nodes: [{ id: 'top', label: 'Chat webview' }, { id: 'a', label: 'A', group: 'long' }, { id: 'r', label: 'Redis cache', group: 'ok' }], edges: [{ from: 'top', to: 'a' }, { from: 'a', to: 'r' }] }).spec;
	const geo = layout.layout(s);
	assert.deepStrictEqual(geo.groups.map((g) => [g.id, g.labelHalo]), [['long', true], ['ok', false]]);
	const svg = scene.build(s, geo, {});
	const body = svg.children[svg.children.length - 1];
	const layer = (cls) => body.children.find((c) => c.attrs.class === cls);
	assert.deepStrictEqual(body.children.map((c) => c.attrs.class), ['lcd-groups', 'lcd-edges', 'lcd-nodes', 'lcd-labels'], 'the paint order: frames, connectors, boxes, then text that must stay on top');
	const names = (root) => { const out = []; walk(root, (n) => { if (n.tag === 'text' && /lcd-group-label/.test(n.attrs.class)) { out.push([n.text, n.attrs.class]); } }); return out; };
	assert.deepStrictEqual(names(layer('lcd-groups')), [['Data', 'lcd-group-label']], 'a clear name stays with its frame, under the connectors');
	assert.deepStrictEqual(names(layer('lcd-labels')), [['A container with a long name', 'lcd-group-label lcd-halo']], 'a crossed one goes on top, with the halo an edge label gets');
	assert.strictEqual(names(svg).length, 2, 'each name is drawn exactly once');
	// and the halo is the background colour, so the line reads as passing BEHIND the word
	assert.match(theme.css(), /\.lcd-halo \{ paint-order: stroke; stroke: var\(--lcd-bg\)/);
	// both painters accept it
	assert.ok(/class="lcd-group-label lcd-halo"/.test(scene.toSvg(scene.build(s, geo, { standalone: true, css: theme.css({ resolved: theme.PALETTES.light }) }))));
});

test('WELL-FORMED: a control character that slipped through cannot break an exported file', () => {
	const svg = scene.toSvg({ tag: 'svg', attrs: { 'aria-label': 'a\u0000b\u0008c' }, children: [{ tag: 'text', attrs: {}, text: 'x\u0001y\u000bz' }] });
	// eslint-disable-next-line no-control-regex
	assert.ok(!/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(svg));
	assert.match(svg, /aria-label="abc"/);
});

// ---- visual regression: the exact SVG, under both palettes ----------------------------------------
const SNAP = path.join(FIX, 'snapshots');
for (const name of ['jev', 'arch', 'decision']) {
	for (const mode of ['light', 'dark']) {
		test('SNAPSHOT: ' + name + ' · ' + mode, () => {
			const spec = specOf(name);
			// exactly the options the chat exports with: title, background, resolved colours
			const svg = scene.toSvg(build(spec, { title: true, background: true, css: theme.css({ resolved: theme.PALETTES[mode] }), standalone: true })) + '\n';
			const file = path.join(SNAP, name + '.' + mode + '.svg');
			if (process.env.UPDATE_SNAPSHOTS) { fs.mkdirSync(SNAP, { recursive: true }); fs.writeFileSync(file, svg); return; }
			assert.ok(fs.existsSync(file), 'no snapshot yet — run with UPDATE_SNAPSHOTS=1 and look at ' + file);
			assert.strictEqual(svg, fs.readFileSync(file, 'utf8'), name + '.' + mode + '.svg changed. If that was intended: UPDATE_SNAPSHOTS=1, then look at it.');
		});
	}
}

test('SNAPSHOT: light and dark differ only in colour — one layout, one set of rules', () => {
	for (const name of ['jev', 'arch', 'decision']) {
		const strip = (s) => s.replace(/<style>[\s\S]*?<\/style>/, '');
		const light = fs.readFileSync(path.join(SNAP, name + '.light.svg'), 'utf8'), dark = fs.readFileSync(path.join(SNAP, name + '.dark.svg'), 'utf8');
		assert.notStrictEqual(light, dark);
		assert.strictEqual(strip(light), strip(dark), name + ': the drawing itself is identical');
	}
});

console.log('diagramScene: ' + n + ' tests passed');
