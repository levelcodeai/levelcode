/*---------------------------------------------------------------------------------------------
 *  LevelCode — AI · rich diagrams · the painter  (docs/RICH-DIAGRAMS.md, "Safe rendering")
 *
 *  LevelCode builds the SVG itself. A diagram is a tree of plain objects — { tag, attrs, text,
 *  children } — produced here from a laid-out spec, and turned into pixels one of two ways:
 *
 *    mount(vnode, document)   the chat: real DOM nodes via createElementNS. A label becomes a TEXT
 *                             NODE (textContent) — never markup, never innerHTML — so nothing a model
 *                             writes into a label can become an element, an attribute or a script.
 *    toSvg(vnode)             an export / a test: a string, every text and attribute value escaped.
 *
 *  Both walk the same tree, so "exports match the rendered view" holds by construction.
 *
 *  The tree is drawn from two short allow-lists (TAGS, ATTRS). There is no script element, no
 *  foreignObject, no href, no style attribute and no event handler in them, and mount() refuses
 *  anything else — the allow-list is the guarantee, not the care taken by whoever built the tree.
 *
 *  (This file is inlined into the chat page's own script block, so it must never spell an HTML
 *  script tag or comment opener, even in a comment like this one — diagram/bundle.js refuses to
 *  build the page if it does, and test/diagramHost.test.js checks every module that ships there.)
 *
 *  Colour never appears here. Elements carry classes; theme.css() gives the classes their paint from
 *  editor theme tokens, which is why a theme switch restyles a diagram without rebuilding it.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
(function (root, factory) {
	'use strict';
	if (typeof module === 'object' && module.exports) { module.exports = factory(require('./theme')); }
	else { (root.LCDiagram = root.LCDiagram || {}).scene = factory(root.LCDiagram.theme); }
}(typeof globalThis !== 'undefined' ? globalThis : this, function (theme) {
	'use strict';

	const SVG_NS = 'http://www.w3.org/2000/svg';
	/** Every element a diagram may contain. `style` exists only in exported files (toSvg), never in the chat. */
	const TAGS = new Set(['svg', 'g', 'rect', 'path', 'text', 'title', 'style']);
	/** Every attribute a diagram may carry. Note what is absent: href, style, on*, xlink:*, src. */
	const ATTRS = new Set([
		'class', 'd', 'x', 'y', 'width', 'height', 'rx', 'ry', 'viewBox', 'transform', 'text-anchor',
		'role', 'aria-label', 'aria-hidden', 'tabindex', 'focusable', 'data-lc-link', 'data-lc-node', 'xmlns'
	]);

	const n2 = (v) => String(Math.round(v * 100) / 100);
	const h = (tag, attrs, kids) => {
		const node = { tag, attrs: attrs || {} };
		if (typeof kids === 'string') { node.text = kids; } else if (kids) { node.children = kids.filter(Boolean); }
		return node;
	};

	/** Where a line of text's baseline sits, given the centre of its line box. Avoids `dominant-baseline`, which exporters disagree about. */
	const baseline = (centerY, size) => centerY + size * 0.355;

	/**
	 * An orthogonal polyline as a path with softly rounded corners. `trim` shortens the final run so
	 * the stroke ends at the base of the arrowhead instead of poking through its tip.
	 */
	function edgePath(points, radius, trim) {
		const pts = points.map((p) => ({ x: p.x, y: p.y }));
		const n = pts.length;
		if (n < 2) { return ''; }
		if (trim) {
			const a = pts[n - 2], b = pts[n - 1];
			const len = Math.hypot(b.x - a.x, b.y - a.y);
			if (len > trim + 0.5) { b.x -= (b.x - a.x) / len * trim; b.y -= (b.y - a.y) / len * trim; }
		}
		let d = 'M' + n2(pts[0].x) + ',' + n2(pts[0].y);
		for (let i = 1; i < n; i++) {
			const p = pts[i];
			if (i === n - 1) { d += ' L' + n2(p.x) + ',' + n2(p.y); break; }
			const a = pts[i - 1], b = pts[i + 1];
			const inLen = Math.hypot(p.x - a.x, p.y - a.y), outLen = Math.hypot(b.x - p.x, b.y - p.y);
			const r = Math.min(radius, inLen / 2, outLen / 2);
			if (r < 0.75) { d += ' L' + n2(p.x) + ',' + n2(p.y); continue; }
			const s = { x: p.x - (p.x - a.x) / inLen * r, y: p.y - (p.y - a.y) / inLen * r };
			const e = { x: p.x + (b.x - p.x) / outLen * r, y: p.y + (b.y - p.y) / outLen * r };
			d += ' L' + n2(s.x) + ',' + n2(s.y) + ' Q' + n2(p.x) + ',' + n2(p.y) + ' ' + n2(e.x) + ',' + n2(e.y);
		}
		return d;
	}
	/** A filled triangle whose tip is the end of the connector. */
	function arrowPath(arrow, S) {
		const L = S.arrow, W = S.arrowHalf;
		const bx = arrow.x - arrow.dx * L, by = arrow.y - arrow.dy * L;
		const px = -arrow.dy, py = arrow.dx;   // perpendicular
		return 'M' + n2(arrow.x) + ',' + n2(arrow.y) + ' L' + n2(bx + px * W) + ',' + n2(by + py * W) + ' L' + n2(bx - px * W) + ',' + n2(by - py * W) + ' Z';
	}

	/** The outline(s) of one node, by shape. "Same kind, same shape." */
	function shapeNodes(n, B) {
		const x = n.x, y = n.y, w = n.w, ht = n.h;
		if (n.shape === 'decision') {
			return [h('path', { class: 'lcd-shape', d: 'M' + n2(x + w / 2) + ',' + n2(y) + ' L' + n2(x + w) + ',' + n2(y + ht / 2) + ' L' + n2(x + w / 2) + ',' + n2(y + ht) + ' L' + n2(x) + ',' + n2(y + ht / 2) + ' Z' })];
		}
		if (n.shape === 'store') {
			const ry = B.storeCap != null ? B.storeCap : 6, rx = w / 2;
			const body = 'M' + n2(x) + ',' + n2(y + ry) + ' A' + n2(rx) + ',' + n2(ry) + ' 0 0 1 ' + n2(x + w) + ',' + n2(y + ry)
				+ ' V' + n2(y + ht - ry) + ' A' + n2(rx) + ',' + n2(ry) + ' 0 0 1 ' + n2(x) + ',' + n2(y + ht - ry) + ' Z';
			const lid = 'M' + n2(x) + ',' + n2(y + ry) + ' A' + n2(rx) + ',' + n2(ry) + ' 0 0 0 ' + n2(x + w) + ',' + n2(y + ry);
			return [h('path', { class: 'lcd-shape', d: body }), h('path', { class: 'lcd-shape lcd-lid', d: lid })];
		}
		const r = n.shape === 'actor' ? Math.min(w, ht) / 2 : B.radius;
		return [h('rect', { class: 'lcd-shape', x: n2(x), y: n2(y), width: n2(w), height: n2(ht), rx: n2(r), ry: n2(r) })];
	}
	/** A 9×11 "file" glyph — the mark of a node that opens code. */
	function fileGlyph(x, y) {
		return h('path', { class: 'lcd-link-icon', 'aria-hidden': 'true', d: 'M' + n2(x) + ',' + n2(y) + ' h5.5 l3.5,3.5 v7.5 h-9 Z M' + n2(x + 5.5) + ',' + n2(y) + ' v3.5 h3.5' });
	}

	/** Greedy word wrap to a pixel width — used for the title of an exported file. */
	function wrapText(text, maxWidth, measure, role) {
		const words = String(text).split(' ');
		const lines = [];
		let cur = '';
		for (const w of words) {
			const next = cur ? cur + ' ' + w : w;
			if (cur && measure(next, role) > maxWidth) { lines.push(cur); cur = w; } else { cur = next; }
		}
		if (cur) { lines.push(cur); }
		return lines;
	}

	/**
	 * Build the tree for one diagram.
	 * @param {any} spec  the validated spec (for the title)
	 * @param {any} geo   layout.layout(spec, …)
	 * @param {{ title?: boolean, css?: string, measure?: (t:string, role:string)=>number, standalone?: boolean, background?: boolean }} [opts]
	 *        title: draw the spec's title inside the SVG (exports — in the chat it is HTML above the picture)
	 *        css: a stylesheet to embed (exports)        standalone: a file, not inline SVG — xmlns, and no live links
	 *        background: paint the editor background behind the drawing (exports — a file has no page behind it)
	 */
	function build(spec, geo, opts) {
		const o = opts || {};
		const T = theme.TYPE, B = theme.BOX, S = theme.SPACE;
		const measure = o.measure || theme.approxMeasure;
		const kids = [];
		let top = 0, width = geo.width;
		if (o.css) { kids.push(h('style', {}, o.css)); }
		if (o.title && spec.title) {
			const lines = wrapText(spec.title, Math.max(geo.width - 2 * S.margin, 260), measure, 'title');
			width = Math.max(width, Math.ceil(Math.max.apply(null, lines.map((l) => measure(l, 'title')))) + 2 * S.margin);
			lines.forEach((line, i) => {
				kids.push(h('text', { class: 'lcd-title', x: n2(S.margin), y: n2(baseline(S.margin + T.title.line * (i + 0.5), T.title.size)) }, line));
			});
			top = S.margin + lines.length * T.title.line + 6;
		}

		// A group's name is drawn with its frame — unless a connector has to run behind it (the layout
		// found no clear stretch for it). Then it is drawn after the connectors, backed like an edge label.
		const groupName = (g) => h('text', { class: 'lcd-group-label' + (g.labelHalo ? ' lcd-halo' : ''), x: n2(g.labelX), y: n2(baseline(g.labelY + g.labelH / 2, T.group.size)) }, g.label);
		const groups = geo.groups.slice().sort((a, b) => a.depth - b.depth).map((g) => h('g', { class: 'lcd-group' }, [
			h('rect', { class: 'lcd-group-box', x: n2(g.x), y: n2(g.y), width: n2(g.w), height: n2(g.h), rx: '10', ry: '10' }),
			g.labelHalo ? null : groupName(g),
			g.tip ? h('title', {}, g.tip) : null
		]));
		const backedNames = geo.groups.filter((g) => g.labelHalo).map(groupName);

		const edges = geo.edges.map((e) => h('g', { class: 'lcd-edge-g' }, [
			h('path', { class: 'lcd-edge' + (e.dashed ? ' lcd-dashed' : ''), d: edgePath(e.points, 5, S.arrow - 1) }),
			h('path', { class: 'lcd-arrow', d: arrowPath(e.arrow, S) }),
			e.tip ? h('title', {}, e.tip) : null
		]));

		const nodes = geo.nodes.map((n) => {
			const cls = 'lcd-node lcd-' + n.shape + (n.accent ? ' lcd-accent' : '') + (n.link ? ' lcd-linked' : '');
			const attrs = { class: cls, 'data-lc-node': n.id };
			if (n.link && !o.standalone) {
				// A link is something the CHAT can open. A saved file cannot, so there the node keeps its
				// glyph and its tooltip and is not a link: nothing to tab to that does nothing.
				// The attribute carries the NODE ID, not the path: the host looks the link up in its own
				// copy of the spec, so nothing the webview says can choose which file is opened.
				attrs['data-lc-link'] = n.id; attrs.tabindex = '0'; attrs.role = 'link';
				attrs['aria-label'] = 'Open ' + n.link.path + (n.link.symbol ? ' at ' + n.link.symbol : n.link.line ? ' line ' + n.link.line : '');
			}
			const parts = shapeNodes(n, B);
			let yy = n.cy - n.textH / 2 + (n.textDy || 0);
			let firstCenter = null, nameW = 0;
			n.lines.forEach((line, i) => {
				if (line.role === 'sub' && i > 0) { yy += B.textGap; }
				const cy = yy + line.h / 2;
				if (firstCenter === null) { firstCenter = cy; nameW = line.w; }
				parts.push(h('text', { class: line.role === 'sub' ? 'lcd-sub' : 'lcd-name', x: n2(n.cx), y: n2(baseline(cy, T[line.role].size)), 'text-anchor': 'middle' }, line.text));
				yy += line.h;
			});
			if (n.link) { parts.push(fileGlyph(n.cx + nameW / 2 + 4, (firstCenter || n.cy) - 5.5)); }
			const tips = [];
			if (n.tip) { tips.push(n.tip); }
			if (n.link) { tips.push(n.link.path + (n.link.symbol ? ' · ' + n.link.symbol : n.link.line ? ':' + n.link.line : '')); }
			if (tips.length) { parts.push(h('title', {}, tips.join('\n'))); }
			return h('g', attrs, parts);
		});

		const labels = geo.edges.filter((e) => e.label).map((e) => h('text', {
			class: 'lcd-edge-label' + (e.label.halo ? ' lcd-halo' : ''),
			x: n2(e.label.x), y: n2(baseline(e.label.y + e.label.h / 2, T.edge.size))
		}, e.label.text));

		const body = [h('g', { class: 'lcd-groups' }, groups), h('g', { class: 'lcd-edges' }, edges), h('g', { class: 'lcd-nodes' }, nodes), h('g', { class: 'lcd-labels' }, backedNames.concat(labels))];
		kids.push(top ? h('g', { transform: 'translate(0,' + n2(top) + ')' }, body) : h('g', {}, body));

		const height = geo.height + top;
		if (o.background) { kids.splice(o.css ? 1 : 0, 0, h('rect', { class: 'lcd-bg', x: '0', y: '0', width: String(width), height: String(height) })); }
		const attrs = { class: 'lcd-svg', viewBox: '0 0 ' + width + ' ' + height, width: String(width), height: String(height), role: 'img', 'aria-label': spec.title || 'Diagram', focusable: 'false' };
		if (o.standalone) { attrs.xmlns = SVG_NS; }
		const svg = h('svg', attrs, kids);
		svg.width = width; svg.height = height;
		return svg;
	}

	// ---- two ways to draw the same tree -----------------------------------------------------------

	const escText = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
	const escAttr = (s) => escText(s).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
	/**
	 * Characters XML 1.0 does not allow at all. repair.cleanText() already strips them from labels;
	 * this is the same rule again at the last moment, so an exported file is always well-formed.
	 */
	// eslint-disable-next-line no-control-regex
	const xmlSafe = (s) => String(s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, '');

	/** Serialize a tree to an SVG string. Unknown tags and attributes are a bug, so they throw. */
	function toSvg(vnode) {
		if (!TAGS.has(vnode.tag)) { throw new Error('diagram: element <' + vnode.tag + '> is not allowed'); }
		let out = '<' + vnode.tag;
		for (const k of Object.keys(vnode.attrs || {})) {
			if (!ATTRS.has(k)) { throw new Error('diagram: attribute "' + k + '" is not allowed'); }
			out += ' ' + k + '="' + escAttr(xmlSafe(vnode.attrs[k])) + '"';
		}
		if (vnode.text == null && !(vnode.children && vnode.children.length)) { return out + '/>'; }
		out += '>';
		if (vnode.text != null) {
			// A stylesheet is ours (theme.css) and CDATA keeps it readable; text is escaped.
			out += vnode.tag === 'style' ? '<![CDATA[' + String(vnode.text).replace(/]]>/g, ']] >') + ']]>' : escText(xmlSafe(vnode.text));
		}
		for (const c of (vnode.children || [])) { out += toSvg(c); }
		return out + '</' + vnode.tag + '>';
	}

	/**
	 * Build real DOM for the chat. Refuses any tag or attribute off the allow-lists, and refuses
	 * <style> outright — the live view is styled by the page's own stylesheet.
	 * @param {any} vnode
	 * @param {Document} doc
	 */
	function mount(vnode, doc) {
		if (!TAGS.has(vnode.tag) || vnode.tag === 'style') { throw new Error('diagram: element <' + vnode.tag + '> is not allowed'); }
		const el = doc.createElementNS(SVG_NS, vnode.tag);
		for (const k of Object.keys(vnode.attrs || {})) {
			if (!ATTRS.has(k) || k === 'xmlns') { if (k === 'xmlns') { continue; } throw new Error('diagram: attribute "' + k + '" is not allowed'); }
			el.setAttribute(k, String(vnode.attrs[k]));
		}
		if (vnode.text != null) { el.textContent = String(vnode.text); }
		for (const c of (vnode.children || [])) { el.appendChild(mount(c, doc)); }
		return el;
	}

	return { SVG_NS, TAGS, ATTRS, build, toSvg, mount, edgePath, arrowPath, wrapText };
}));
