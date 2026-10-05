/*---------------------------------------------------------------------------------------------
 *  LevelCode — AI · rich diagrams · the ASCII fallback  (docs/RICH-DIAGRAMS.md, "UX → Fallback")
 *
 *  "If rendering is unavailable, the user sees an ASCII rendering generated from the same spec, so
 *  the model never has to draw ASCII itself."
 *
 *  This is the SAME layout as the picture, not a second one: layout.layout() is run with every
 *  character one cell wide, and its geometry is rasterised onto a character grid — boxes, connectors
 *  with their corners and arrowheads, labels beside lines, group frames. So the fallback puts things
 *  where the picture would have, and a fix to the layout fixes both.
 *
 *  It is drawn by the editor, for a <pre> in a monospaced face — the one place box-and-arrow
 *  characters hold their shape. That is the difference from a model typing them into prose.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
(function (root, factory) {
	'use strict';
	if (typeof module === 'object' && module.exports) { module.exports = factory(require('./layout')); }
	else { (root.LCDiagram = root.LCDiagram || {}).ascii = factory(root.LCDiagram.layout); }
}(typeof globalThis !== 'undefined' ? globalThis : this, function (layoutMod) {
	'use strict';

	/** One character cell, in the layout's pixels. Tall cells are halved so two lines 12px apart stay on different rows. */
	const CW = 8, CH = 8;
	const chars = (s) => Array.from(String(s));
	// How wide text is in a monospaced face, in cells. Ranges are [first, last], from Unicode's East Asian
	// Width (Wide and Fullwidth) and its combining blocks — the common cases, not the whole standard.
	// Without this a label in Japanese, or one with an emoji in it, pushes the right-hand side of its own
	// box — and everything after it on the row — out of line.
	const MARKS = [[0x300, 0x36f], [0x1ab0, 0x1aff], [0x1dc0, 0x1dff], [0x200b, 0x200f], [0x20d0, 0x20ff], [0xfe00, 0xfe0f], [0xfe20, 0xfe2f], [0xe0100, 0xe01ef]];
	const WIDE = [[0x1100, 0x115f], [0x231a, 0x231b], [0x23e9, 0x23ec], [0x23f0, 0x23f0], [0x23f3, 0x23f3], [0x25fd, 0x25fe], [0x2614, 0x2615], [0x2648, 0x2653], [0x267f, 0x267f], [0x2693, 0x2693],
		[0x26a1, 0x26a1], [0x26aa, 0x26ab], [0x26bd, 0x26be], [0x26c4, 0x26c5], [0x26ce, 0x26ce], [0x26d4, 0x26d4], [0x26ea, 0x26ea], [0x26f2, 0x26f3], [0x26f5, 0x26f5], [0x26fa, 0x26fa], [0x26fd, 0x26fd],
		[0x2705, 0x2705], [0x270a, 0x270b], [0x2728, 0x2728], [0x274c, 0x274c], [0x274e, 0x274e], [0x2753, 0x2755], [0x2757, 0x2757], [0x2795, 0x2797], [0x27b0, 0x27b0], [0x27bf, 0x27bf], [0x2b1b, 0x2b1c],
		[0x2b50, 0x2b50], [0x2b55, 0x2b55], [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf], [0x4e00, 0x9fff], [0xa000, 0xa4cf], [0xa960, 0xa97f], [0xac00, 0xd7a3], [0xf900, 0xfaff], [0xfe30, 0xfe4f],
		[0xff00, 0xff60], [0xffe0, 0xffe6], [0x1f004, 0x1f004], [0x1f0cf, 0x1f0cf], [0x1f18e, 0x1f18e], [0x1f191, 0x1f19a], [0x1f200, 0x1f2ff], [0x1f300, 0x1f64f], [0x1f680, 0x1f6ff], [0x1f7e0, 0x1f7eb],
		[0x1f900, 0x1faff], [0x20000, 0x3fffd]];
	const within = (table, c) => table.some((r) => c >= r[0] && c <= r[1]);
	/** Text as the units a monospaced face sets: a character with any marks that sit on it, and its width in cells. */
	function units(text) {
		const out = [];
		for (const ch of chars(text)) {
			const c = ch.codePointAt(0);
			if (c >= 0x300 && out.length && within(MARKS, c)) {
				const last = out[out.length - 1];
				last.text += ch;
				if (c === 0xfe0f) { last.w = 2; }   // "show the character before me as an emoji" — which is a wide one
				continue;
			}
			out.push({ text: ch, w: c >= 0x1100 && within(WIDE, c) ? 2 : 1 });
		}
		return out;
	}
	const width = (text) => units(text).reduce((a, u) => a + u.w, 0);
	/** The layout is told how wide text is in cells, and sizes boxes to match. */
	const measure = (text) => width(text) * CW;
	/** The mark a shortened label ends with, in characters every terminal has. */
	const plain = (s) => (typeof s === 'string' ? s.replace(/\u2026/g, '...') : s);

	// Box furniture per shape — different corners so "same kind, same shape" survives without curves.
	const FRAME = {
		box: { tl: '+', tr: '+', bl: '+', br: '+', h: '-', v: '|' },
		decision: { tl: '/', tr: '\\', bl: '\\', br: '/', h: '-', v: '|' },
		store: { tl: '.', tr: '.', bl: "'", br: "'", h: '=', v: '|' },
		actor: { tl: '.', tr: '.', bl: "'", br: "'", h: '-', v: '(' }
	};

	/**
	 * Render a validated spec as text.
	 * @param {any} spec
	 * @param {{ maxCols?: number, title?: boolean }} [opts]  maxCols: the width to fit (a flow asked for left-to-right
	 *        turns downward when it will not). title: false leaves the title line out, for a card that already shows it.
	 * @returns {string}
	 */
	function render(spec, opts) {
		const o = opts || {};
		// A character grid has no slanted or curved edges for a connector to stop on, so every shape is
		// laid out as a rectangle here; what kind it is shows in how its frame is drawn.
		const shapeOf = new Map((spec.nodes || []).map((n) => [n.id, n.shape || 'box']));
		const flat = Object.assign({}, spec, {
			nodes: (spec.nodes || []).map((n) => Object.assign({}, n, { shape: 'box', label: plain(n.label), sub: plain(n.sub) })),
			edges: (spec.edges || []).map((e) => Object.assign({}, e, { label: plain(e.label) })),
			groups: (spec.groups || []).map((g) => Object.assign({}, g, { label: plain(g.label) }))
		});
		const geo = layoutMod.layout(flat, {
			measure,
			maxWidth: o.maxCols ? o.maxCols * CW : undefined,
			// a little more air than the picture needs: after rounding to cells, neighbours must still be apart
			// Every distance is a whole number of cells: two things a fixed distance apart are then the
			// same number of cells apart after rounding, wherever on the grid they land.
			space: { portGap: 2 * CH, portMin: 2 * CH, labelLane: 2 * CH, track: 2 * CW, labelGap: CH / 2, labelSideGap: CW, labelPad: CW, channelPad: 3 * CW, nodeGap: 3 * CH, rankGap: 6 * CW, lineClear: 2 * CH, groupGap: 2 * CH, groupInset: 2 * CW, groupHeader: 2 * CH, arrow: CW, arrowHalf: 1, margin: CW, selfLoop: 2 * CW },
			type: { name: { size: 13, weight: 400, line: CH }, sub: { size: 13, weight: 400, line: CH }, edge: { size: 13, weight: 400, line: CH }, group: { size: 13, weight: 400, line: CH }, title: { size: 13, weight: 400, line: CH } },
			box: { padX: 1.5 * CW, padY: CH / 2, textGap: 0, minWidth: 5 * CW, linkIcon: 0, storeCap: 0 }
		});
		const col = (x) => Math.round(x / CW), row = (y) => Math.round(y / CH);
		const W = col(geo.width) + 2, H = row(geo.height) + 2;
		const grid = Array.from({ length: H }, () => new Array(W).fill(' '));
		const put = (r, c, ch) => { if (r >= 0 && r < H && c >= 0 && c < W) { grid[r][c] = ch; } };
		const get = (r, c) => (r >= 0 && r < H && c >= 0 && c < W ? grid[r][c] : ' ');
		// A wide character fills its own cell and empties the next, so the row still adds up.
		const write = (r, c, text) => {
			let at = c;
			for (const u of units(text)) { put(r, at, u.text); if (u.w === 2) { put(r, at + 1, ''); } at += u.w; }
		};

		// group frames first: everything else is drawn over them
		const byDepth = geo.groups.slice().sort((a, b) => a.depth - b.depth);
		for (const g of byDepth) {
			const c0 = col(g.x), c1 = col(g.x + g.w), r0 = row(g.y), r1 = row(g.y + g.h);
			for (let c = c0; c <= c1; c++) { put(r0, c, (c - c0) % 2 ? ' ' : '.'); put(r1, c, (c - c0) % 2 ? ' ' : '.'); }
			for (let r = r0 + 1; r < r1; r++) { put(r, c0, ':'); put(r, c1, ':'); }
		}
		// A group's name sits on its frame's top row, where the layout put it: slid clear of the lines
		// that come in through that row when there was room. It is written AFTER the connectors, so one
		// that has to share the row with a line is still whole.
		const nameGroups = () => {
			for (const g of byDepth) {
				const c0 = col(g.x), c1 = col(g.x + g.w), r0 = row(g.y);
				const slid = col(g.labelX - (g.x + 2 * CW - 4));   // how far the layout moved it from the corner
				const text = ' ' + g.label + ' ';
				write(r0, Math.max(c0 + 2, Math.min(c0 + 2 + slid, c1 - 1 - width(text))), text);
			}
		};

		// connectors: runs, then corners, then the arrowhead
		const HORIZ = new Set(['-', '.', '=']), VERT = new Set(['|', ':']);
		for (const e of geo.edges) {
			const pts = e.points.map((p) => ({ c: col(p.x), r: row(p.y) }));
			for (let i = 0; i + 1 < pts.length; i++) {
				const a = pts[i], b = pts[i + 1];
				if (a.r === b.r) {
					for (let c = Math.min(a.c, b.c); c <= Math.max(a.c, b.c); c++) {
						const cur = get(a.r, c);
						put(a.r, c, VERT.has(cur) || cur === '+' ? '+' : (e.dashed && c % 2 ? ' ' : '-'));
					}
				} else {
					for (let r = Math.min(a.r, b.r); r <= Math.max(a.r, b.r); r++) {
						const cur = get(r, a.c);
						put(r, a.c, HORIZ.has(cur) || cur === '+' ? '+' : (e.dashed ? ':' : '|'));
					}
				}
			}
			for (let i = 1; i + 1 < pts.length; i++) { put(pts[i].r, pts[i].c, '+'); }
		}
		nameGroups();

		// nodes over the connectors that end on them
		for (const n of geo.nodes) {
			const shape = shapeOf.get(n.id) || 'box';
			const f = FRAME[shape] || FRAME.box;
			const c0 = col(n.x), c1 = col(n.x + n.w), r0 = row(n.y), r1 = row(n.y + n.h);
			for (let r = r0; r <= r1; r++) { for (let c = c0; c <= c1; c++) { put(r, c, ' '); } }
			for (let c = c0 + 1; c < c1; c++) { put(r0, c, n.accent ? '#' : f.h); put(r1, c, n.accent ? '#' : f.h); }
			for (let r = r0 + 1; r < r1; r++) { put(r, c0, f.v); put(r, c1, f.v === '(' ? ')' : f.v); }
			put(r0, c0, f.tl); put(r0, c1, f.tr); put(r1, c0, f.bl); put(r1, c1, f.br);
			if (shape === 'decision') { const mid = Math.round((r0 + r1) / 2); put(mid, c0, '<'); put(mid, c1, '>'); }
			const first = Math.round((r0 + r1) / 2 - (n.lines.length - 1) / 2);
			n.lines.forEach((line, i) => {
				write(first + i, Math.round((c0 + c1) / 2 - (width(line.text) - 1) / 2), line.text);
			});
		}

		// arrowheads sit in the last cell BEFORE the node, so they survive the node being drawn
		for (const e of geo.edges) {
			const a = e.arrow, c = col(a.x) - a.dx, r = row(a.y) - a.dy;
			put(r, c, a.dx > 0 ? '>' : a.dx < 0 ? '<' : a.dy > 0 ? 'v' : '^');
		}

		// labels last, each on the row its line box is centred on
		for (const e of geo.edges) {
			if (!e.label) { continue; }
			write(row(e.label.y + e.label.h / 2), col(e.label.x), e.label.text);
		}

		const lines = grid.map((r) => r.join('').replace(/\s+$/, ''));
		while (lines.length && !lines[0]) { lines.shift(); }
		while (lines.length && !lines[lines.length - 1]) { lines.pop(); }
		const indent = Math.min.apply(null, lines.filter(Boolean).map((l) => l.search(/\S/)).concat([Infinity]));
		const body = lines.map((l) => (Number.isFinite(indent) ? l.slice(indent) : l));
		const title = o.title !== false && spec && spec.title ? [String(spec.tip || spec.title), ''] : [];
		return title.concat(body).join('\n') + '\n';
	}

	return { render, width, CW, CH };
}));
