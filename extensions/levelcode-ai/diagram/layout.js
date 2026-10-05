/*---------------------------------------------------------------------------------------------
 *  LevelCode — AI · rich diagrams · layout  (docs/RICH-DIAGRAMS.md, "Architecture" + "Style guide")
 *
 *  Turns a validated Graph JSON spec into geometry: where every box sits, the route every connector
 *  takes, and where each label goes. The model never supplies a coordinate; this file supplies all
 *  of them, the same way every time — which is the whole reason a diagram looks the same whichever
 *  model asked for it.
 *
 *  It is a layered ("Sugiyama") layout with orthogonal routing, written for the house rules:
 *
 *    rank      nodes are placed in columns (or rows) along the flow; cycles are broken first, and the
 *              edge that closes one is drawn running back
 *    order     within a rank, positions are chosen to minimise crossings — with every group kept
 *              contiguous, and sibling groups in one consistent order so their frames never interleave
 *    place     positions across the flow come from a small constraint system (nothing overlaps,
 *              every group owns one band through all the ranks it spans) relaxed until connected
 *              things line up
 *    route     connectors leave and enter on the sides that face the flow, each on its own port, and
 *              turn in their own track in the gap between ranks — so lines run THROUGH GAPS and
 *              never share a segment
 *    label     an edge label is placed BESIDE its line, on the best spot that touches nothing else;
 *              the gap it needs is reserved before routing rather than hoped for after
 *
 *  WHY NOT ELK.js (the spec names it): ELK is EPL-2.0 and a ~1.5 MB bundle. This extension is
 *  MIT-clean, plain JS and dependency-free (CLAUDE.md, "Conventions"), and the spec's own open
 *  question allows "a simpler layered layout". With a 12-node cap the problem is small enough to do
 *  directly. layout(spec, opts) is the entire interface, so swapping ELK in later touches one call.
 *
 *  Everything is computed on two abstract axes — M, along the flow, and C, across it — and mapped to
 *  x/y at the very end, so `direction: "down"` is the same code as `"right"`, not a second copy.
 *
 *  Pure and deterministic: no randomness, no clock, no DOM. Text is measured by an injected
 *  `measure(text, role)` — a canvas in the webview, theme.approxMeasure in Node.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
(function (root, factory) {
	'use strict';
	if (typeof module === 'object' && module.exports) { module.exports = factory(require('./theme')); }
	else { (root.LCDiagram = root.LCDiagram || {}).layout = factory(root.LCDiagram.theme); }
}(typeof globalThis !== 'undefined' ? globalThis : this, function (theme) {
	'use strict';

	/** Two cross coordinates this close are "the same line": the connector between them is drawn straight. */
	const STRAIGHT = 1.0;
	const r2 = (v) => Math.round(v * 100) / 100;

	// ---- node sizes -----------------------------------------------------------------------------

	/** Split a decision's label into two balanced lines when it is long enough to make the diamond sprawl. */
	function wrapTwo(text, measure, role) {
		const words = String(text).split(' ');
		if (words.length < 2 || Array.from(text).length <= 14) { return [text]; }
		let best = null;
		for (let i = 1; i < words.length; i++) {
			const a = words.slice(0, i).join(' '), b = words.slice(i).join(' ');
			const w = Math.max(measure(a, role), measure(b, role));
			if (!best || w < best.w) { best = { w, lines: [a, b] }; }
		}
		return best ? best.lines : [text];
	}

	/**
	 * The size of a node and the lines of text inside it, in screen terms (w across, h down).
	 * "Width from the measured longest line plus 24" — plus whatever the shape itself needs.
	 */
	function nodeSize(node, measure, T, B) {
		const shape = node.shape || 'box';
		const nameLines = shape === 'decision' ? wrapTwo(node.label, measure, 'name') : [node.label];
		const lines = nameLines.map((t) => ({ text: t, role: 'name', w: measure(t, 'name'), h: T.name.line }));
		if (node.sub) { lines.push({ text: node.sub, role: 'sub', w: measure(node.sub, 'sub'), h: T.sub.line }); }
		const textW = Math.max.apply(null, lines.map((l) => l.w));
		const textH = lines.reduce((s, l) => s + l.h, 0) + (node.sub ? B.textGap : 0);
		const link = node.link ? B.linkIcon : 0;
		let w, h, textDy = 0;
		if (shape === 'decision') {
			// A rhombus with half-diagonals a (across) and b (down) contains a line of half-width hw whose
			// far edge is `far` from the centre when hw/a + far/b <= 1. Fit EACH line rather than the
			// block's bounding box — a short line near a tip needs far less room than the widest one —
			// and take the smallest diamond that is neither a sliver nor a square.
			let yy = -textH / 2;
			const rows = lines.map((l, i) => {
				if (l.role === 'sub' && i > 0) { yy += B.textGap; }
				const far = Math.max(Math.abs(yy), Math.abs(yy + l.h)) + 3;
				yy += l.h;
				return { hw: l.w / 2 + 6 + (i === 0 ? link : 0), far };
			});
			const farMax = Math.max.apply(null, rows.map((rw) => rw.far));
			let best = null;
			for (let b = farMax * 1.2; b <= farMax * 3.2; b += 1) {
				const a = Math.max.apply(null, rows.map((rw) => rw.hw / (1 - rw.far / b)));
				const ratio = a / b;
				if (ratio < 1.35 || ratio > 3.1) { continue; }
				if (!best || a * b < best.a * best.b) { best = { a, b }; }
			}
			if (!best) { const b = farMax * 2; best = { a: Math.max.apply(null, rows.map((rw) => rw.hw / (1 - rw.far / b))), b }; }
			w = Math.ceil(2 * best.a); h = Math.ceil(2 * best.b);
		} else if (shape === 'store') {
			const cap = B.storeCap != null ? B.storeCap : 6;
			w = Math.max(B.minWidth, Math.ceil(textW + 2 * B.padX + link));
			h = Math.ceil(textH + 2 * B.padY + cap);
			textDy = cap / 2;                                         // the lid pushes the text down a little
		} else if (shape === 'actor') {
			h = Math.ceil(textH + 2 * B.padY);
			w = Math.max(B.minWidth, Math.ceil(textW + 2 * B.padX + link + h * 0.3));   // room for the round ends
		} else {
			w = Math.max(B.minWidth, Math.ceil(textW + 2 * B.padX + link));
			h = Math.ceil(textH + 2 * B.padY);
		}
		return { shape, w, h, lines, textH, textDy };
	}

	/**
	 * How far the outline is from the node's centre, measured along `axis`, at offset `off` on the
	 * other axis. Connectors stop ON the outline, so a line into a diamond meets its slanted edge
	 * rather than floating at the corner of its bounding box.
	 * @param {{shape:string, w:number, h:number}} n  screen size
	 * @param {'x'|'y'} axis
	 */
	function outline(n, axis, off, B) {
		const hw = n.w / 2, hh = n.h / 2, a = Math.abs(off);
		if (n.shape === 'decision') {
			return axis === 'x' ? hw * Math.max(0, 1 - a / hh) : hh * Math.max(0, 1 - a / hw);
		}
		if (n.shape === 'actor') {
			const r = Math.min(hw, hh);                                // the pill's end radius
			if (axis === 'x') { return hw - r + Math.sqrt(Math.max(0, r * r - Math.min(a, r) * Math.min(a, r))); }
			const d = a - (hw - r);
			return d <= 0 ? hh : Math.sqrt(Math.max(0, r * r - Math.min(d, r) * Math.min(d, r)));
		}
		if (n.shape === 'store' && axis === 'y') {
			const cap = B.storeCap != null ? B.storeCap : 6;
			const t = Math.min(1, a / hw);
			return hh - cap * (1 - Math.sqrt(1 - t * t));
		}
		return axis === 'x' ? hw : hh;
	}
	/** How much of a side connectors may spread over, by shape (kept off corners and slants). */
	function portSpan(n, sideLen, S) {
		if (n.shape === 'decision') { return sideLen * 0.5; }
		if (n.shape === 'actor') { return Math.max(0, sideLen * 0.55); }
		return Math.max(0, sideLen - 2 * S.portInset);
	}

	/** The least distance between a connector and a group's name. */
	const NAME_CLEAR = 6;
	/** How far a group's incoming lines may be moved aside to clear its name before a backed name is the better picture. */
	const NAME_ROOM = 72;

	// ---- the layout -----------------------------------------------------------------------------

	/**
	 * @param {any} spec  a spec that passed validate() (or repair.accept())
	 * @param {{ measure?: (text:string, role:string)=>number, maxWidth?: number,
	 *           space?: object, box?: object, type?: object }} [opts]
	 * @returns geometry — see the bottom of layoutOnce()
	 */
	function layout(spec, opts) {
		const o = opts || {};
		const asked = spec.direction === 'down' ? 'down' : 'right';
		let geo = layoutDir(spec, asked, o);
		// "Diagrams grow downward, never wider than the chat column." A flow that was asked for
		// left-to-right but cannot fit is laid out top-to-bottom instead, when that actually helps.
		if (o.maxWidth && asked === 'right' && geo.width > o.maxWidth) {
			const down = layoutDir(spec, 'down', o);
			if (down.width <= o.maxWidth || down.width < geo.width * 0.8) { down.flipped = true; geo = down; }
		}
		geo.asked = asked;
		return geo;
	}

	/**
	 * One direction, laid out — and, when the flow runs down, laid out again if a group's name was left
	 * with a connector behind it. A name is first slid along its frame to a clear stretch, which costs
	 * nothing. Where the frame has no such stretch, room can be MADE: the group's incoming lines are
	 * kept to the far side of its name, which widens the frame by however far the lines have to move.
	 * That is worth a little width and not a lot — a frame half empty under a long name reads worse
	 * than a line passing behind the name — so it is done only for groups where the lines have less
	 * than NAME_ROOM to move, and kept only if the drawing still fits its column. The rest keep their
	 * backed name.
	 */
	function layoutDir(spec, dir, o) {
		let best = layoutOnce(spec, dir, o, null);
		if (dir !== 'down') { return tidy(best); }
		const reserve = new Set();
		for (let pass = 0; pass < 2; pass++) {
			const more = best.groups.filter((g) => g.labelHalo && !reserve.has(g.id) && g.labelNeed <= NAME_ROOM);
			if (!more.length) { break; }
			more.forEach((g) => reserve.add(g.id));
			const next = layoutOnce(spec, dir, o, reserve);
			// Kept unless the result is wider than its column: a name is not worth shrinking the whole drawing.
			if (o.maxWidth && next.width > o.maxWidth) { break; }
			best = next;
		}
		return tidy(best);
	}

	/** @param {Set<string>|null} reserve  groups whose incoming lines must keep clear of the name (see layoutDir) */
	function layoutOnce(spec, dir, o, reserve) {
		const T = Object.assign({}, theme.TYPE, o.type);
		const B = Object.assign({}, theme.BOX, o.box);
		const S = Object.assign({}, theme.SPACE, o.space);
		const measure = o.measure || theme.approxMeasure;
		const right = dir === 'right';
		const warnings = [];

		// ---- nodes, groups, edges as indexed records ------------------------------------------
		const specNodes = Array.isArray(spec.nodes) ? spec.nodes : [];
		const idIndex = new Map();
		const N = specNodes.map((n, i) => {
			const sz = nodeSize(n, measure, T, B);
			idIndex.set(n.id, i);
			return { i, id: n.id, spec: n, shape: sz.shape, w: sz.w, h: sz.h, lines: sz.lines, textH: sz.textH, textDy: sz.textDy, grp: -1, rank: 0 };
		});
		const specGroups = Array.isArray(spec.groups) ? spec.groups : [];
		const gIndex = new Map();
		const G = specGroups.map((g, i) => { gIndex.set(g.id, i); return { i, id: g.id, label: g.label, tip: g.tip, parent: -1, kids: [], path: [], nodes: new Set(), rmin: Infinity, rmax: -Infinity, labelW: measure(g.label, 'group') }; });
		for (const g of G) {
			const p = specGroups[g.i].parent;
			if (p !== undefined && gIndex.has(p) && gIndex.get(p) !== g.i) { g.parent = gIndex.get(p); }
		}
		// a parent chain that loops (validate() rejects it; this is belt and braces) is cut
		for (const g of G) { let cur = g, hops = 0; while (cur.parent >= 0 && hops++ <= G.length) { cur = G[cur.parent]; } if (hops > G.length) { g.parent = -1; } }
		for (const g of G) { if (g.parent >= 0) { G[g.parent].kids.push(g.i); } }
		const pathOf = (g) => { const p = []; let cur = g; while (cur) { p.unshift(cur.i); cur = cur.parent >= 0 ? G[cur.parent] : null; } return p; };
		for (const g of G) { g.path = pathOf(g); }
		for (const n of N) {
			const gi = n.spec.group !== undefined ? gIndex.get(n.spec.group) : undefined;
			if (gi !== undefined) { n.grp = gi; for (const a of G[gi].path) { G[a].nodes.add(n.i); } }
		}
		const liveGroups = G.filter((g) => g.nodes.size > 0);

		const E = [];
		(Array.isArray(spec.edges) ? spec.edges : []).forEach((e, k) => {
			const u = idIndex.get(e.from), v = idIndex.get(e.to);
			if (u === undefined || v === undefined) { return; }
			const label = e.label ? { text: e.label, w: measure(e.label, 'edge'), h: T.edge.line } : null;
			E.push({ k, u, v, self: u === v, rev: false, dashed: e.style === 'dashed', label, tip: e.tip });
		});
		const flow = E.filter((e) => !e.self);

		// ---- rank: break cycles, then longest path, then pull loose ends in --------------------
		const outE = N.map(() => []), inDeg = N.map(() => 0);
		for (const e of flow) { outE[e.u].push(e); inDeg[e.v]++; }
		const mark = N.map(() => 0);
		const visit = (u) => {
			mark[u] = 1;
			for (const e of outE[u]) { if (mark[e.v] === 1) { e.rev = true; } else if (mark[e.v] === 0) { visit(e.v); } }
			mark[u] = 2;
		};
		// Sources first, in the order the model wrote them: a spec lists a flow start-to-finish, so
		// the edge that points back at an earlier node is the one to treat as the loop.
		for (const n of N) { if (inDeg[n.i] === 0 && mark[n.i] === 0) { visit(n.i); } }
		for (const n of N) { if (mark[n.i] === 0) { visit(n.i); } }
		for (const e of flow) { e.a = e.rev ? e.v : e.u; e.b = e.rev ? e.u : e.v; }

		const succ = N.map(() => []), pred = N.map(() => []);
		for (const e of flow) { succ[e.a].push(e.b); pred[e.b].push(e.a); }
		if (!flow.length) {
			// Nothing connects anything: a tidy grid reads better than one long line of boxes.
			const order = N.slice().sort((p, q) => (p.grp - q.grp) || (p.i - q.i));
			const per = Math.max(1, Math.ceil(order.length / Math.max(1, Math.round(Math.sqrt(order.length)))));
			order.forEach((n, j) => { n.rank = Math.floor(j / per); });
		} else {
			const deg = N.map((n) => pred[n.i].length);
			const queue = N.filter((n) => deg[n.i] === 0).map((n) => n.i);
			for (let qi = 0; qi < queue.length; qi++) {
				const u = queue[qi];
				for (const v of succ[u]) { N[v].rank = Math.max(N[v].rank, N[u].rank + 1); if (--deg[v] === 0) { queue.push(v); } }
			}
			// Tighten: move each node, within the slack its neighbours leave, toward the side it has
			// more connections on. Stops a source being parked five ranks from its only successor.
			for (let pass = 0; pass < 12; pass++) {
				let moved = false;
				for (const n of N) {
					if (!pred[n.i].length && !succ[n.i].length) { continue; }
					const lo = pred[n.i].length ? Math.max.apply(null, pred[n.i].map((p) => N[p].rank)) + 1 : 0;
					const hi = succ[n.i].length ? Math.min.apply(null, succ[n.i].map((s) => N[s].rank)) - 1 : n.rank;
					let want = n.rank;
					if (succ[n.i].length > pred[n.i].length) { want = hi; }
					else if (pred[n.i].length > succ[n.i].length) { want = lo; }
					want = Math.max(lo, Math.min(Math.max(lo, hi), want));
					if (want !== n.rank) { n.rank = want; moved = true; }
				}
				if (!moved) { break; }
			}
			const minRank = Math.min.apply(null, N.map((n) => n.rank));
			if (minRank) { for (const n of N) { n.rank -= minRank; } }
		}
		const R = N.length ? Math.max.apply(null, N.map((n) => n.rank)) + 1 : 1;
		for (const g of liveGroups) { for (const ni of g.nodes) { g.rmin = Math.min(g.rmin, N[ni].rank); g.rmax = Math.max(g.rmax, N[ni].rank); } }

		// ---- items: real nodes, the virtual nodes that carry long edges, group spacers ---------
		const items = [];
		const ms = (n) => (right ? n.w : n.h), cs = (n) => (right ? n.h : n.w);
		const nodeItem = N.map((n) => {
			const it = { kind: 'node', node: n, rank: n.rank, ms: ms(n), cs: cs(n), grp: n.grp, path: n.grp >= 0 ? G[n.grp].path : [], order: 0, x: 0, extraLo: 0, extraHi: 0, lo: [], hi: [] };
			items.push(it); return it;
		});
		/**
		 * Which group a long edge is "in" as it crosses rank r. An edge into a group enters at the
		 * group's edge and then travels INSIDE its band to the node it wants — it does not skirt the
		 * frame and double back. So: the innermost group of either end that spans this rank; when the
		 * two ends offer unrelated groups, the one whose node is nearer.
		 */
		const groupAt = (n, r) => {
			if (n.grp < 0) { return -1; }
			const path = G[n.grp].path;
			for (let i = path.length - 1; i >= 0; i--) { const g = G[path[i]]; if (g.rmin <= r && r <= g.rmax) { return g.i; } }
			return -1;
		};
		const chainGroup = (a, b, r) => {
			const ga = groupAt(a, r), gb = groupAt(b, r);
			if (ga < 0 || gb < 0) { return Math.max(ga, gb); }
			if (ga === gb || G[gb].path.indexOf(ga) >= 0) { return gb; }
			if (G[ga].path.indexOf(gb) >= 0) { return ga; }
			return (r - a.rank) <= (b.rank - r) ? ga : gb;
		};
		const lm = (label) => (right ? label.w : label.h), lc = (label) => (right ? label.h : label.w);
		const rankMs = new Array(R).fill(0);
		for (const it of nodeItem) { rankMs[it.rank] = Math.max(rankMs[it.rank], it.ms); }
		const chains = [];
		for (const e of flow) {
			const a = nodeItem[e.a], b = nodeItem[e.b];
			const seq = [a];
			for (let r = a.rank + 1; r < b.rank; r++) {
				const grp = chainGroup(N[e.a], N[e.b], r);
				const v = { kind: 'virt', rank: r, ms: 0, cs: 0, grp, path: grp >= 0 ? G[grp].path : [], order: 0, x: 0, extraLo: 0, extraHi: 0, chain: null };
				items.push(v); seq.push(v);
			}
			seq.push(b);
			const ch = { e, seq, offA: 0, offB: 0, host: null };
			for (const v of seq) { if (v.kind === 'virt') { v.chain = ch; } }
			// A long edge's label rides above the line where it crosses a rank that is wide enough for it.
			if (e.label) {
				const host = seq.find((v) => v.kind === 'virt' && rankMs[v.rank] >= lm(e.label) + 2 * S.labelPad);
				if (host) { ch.host = host; host.extraLo = lc(e.label) + S.labelGap + 2; }
			}
			chains.push(ch);
		}
		// A group owns one band across EVERY rank it spans. Where it has nothing of its own in a
		// rank, a zero-size spacer holds its place, so what else is in that rank is above or below.
		const inSubtree = (it, g) => it.path.indexOf(g.i) >= 0;
		for (const g of liveGroups.slice().sort((p, q) => q.path.length - p.path.length)) {
			for (let r = g.rmin; r <= g.rmax; r++) {
				if (!items.some((it) => it.rank === r && inSubtree(it, g))) {
					items.push({ kind: 'spacer', rank: r, ms: 0, cs: 0, grp: g.i, path: g.path, order: 0, x: 0, extraLo: 0, extraHi: 0 });
				}
			}
		}
		const ranks = [];
		for (let r = 0; r < R; r++) { ranks.push(items.filter((it) => it.rank === r)); }
		/** segs[r] = the pieces of chains that cross the gap between rank r and r+1. */
		const segs = [];
		for (let r = 0; r < R; r++) { segs.push([]); }
		for (const ch of chains) { for (let j = 0; j + 1 < ch.seq.length; j++) { segs[ch.seq[j].rank].push({ a: ch.seq[j], b: ch.seq[j + 1], ch, j }); } }

		orderRanks(ranks, segs, G, N, nodeItem);

		// ---- ports: every connector end gets its own point on its side -------------------------
		// A side's ends are sorted by where the other end sits in the neighbouring rank, so two
		// connectors leaving one node never cross on the way out.
		for (const ch of chains) {
			const first = ch.seq[0], last = ch.seq[ch.seq.length - 1];
			first.hi.push({ ch, other: ch.seq[1], end: 'A' });
			last.lo.push({ ch, other: ch.seq[ch.seq.length - 2], end: 'B' });
		}
		const selfLoops = E.filter((e) => e.self);
		for (const e of selfLoops) { nodeItem[e.u].hi.push({ self: e, other: { order: -1 }, end: 'S' }); }
		for (const it of nodeItem) {
			for (const side of ['lo', 'hi']) {
				const ends = it[side];
				if (!ends.length) { continue; }
				ends.sort((p, q) => (p.other.order - q.other.order) || ((p.ch ? p.ch.e.k : -1) - (q.ch ? q.ch.e.k : -1)));
				const n = ends.length;
				// A label sits on the stub that carries the arrowhead. Where several connectors arrive
				// side by side and one is labelled, they are spread a label-height apart so each label
				// has a lane of its own — and the node grows to fit them. Only when the flow runs right:
				// run down, a label lies ACROSS the stubs and no sane spacing would hold it.
				const arrowEnd = (en) => !!en.ch && !!en.ch.e.label && !en.ch.host && (en.ch.e.rev ? en.end === 'A' : en.end === 'B');
				const labelled = right && n > 1 && ends.some(arrowEnd);
				const lane = S.labelLane != null ? S.labelLane : T.edge.line + S.labelGap + 2;
				const floor = labelled ? lane : (S.portMin != null ? S.portMin : 6);
				let gap = Math.max(S.portGap, labelled ? floor : 0);
				const span = portSpan(it.node, it.cs, S);
				if (n > 1 && (n - 1) * gap > span) {
					gap = Math.max(floor, span / (n - 1));
					if ((n - 1) * gap > span + 1e-6) {
						// Still does not fit: the node grows along its side. ("Renderer only: widen, wrap.")
						const need = (n - 1) * gap;
						const grow = it.node.shape === 'decision' ? need / 0.5 : it.node.shape === 'actor' ? need / 0.55 : need + 2 * S.portInset;
						if (right) { it.node.h = Math.ceil(grow); } else { it.node.w = Math.ceil(grow); }
						it.cs = cs(it.node);   // (the node now holds exactly `need`: there is nothing left to re-measure)
					}
				}
				ends.forEach((en, i) => {
					const off = (i - (n - 1) / 2) * gap;
					if (en.end === 'A') { en.ch.offA = off; } else if (en.end === 'B') { en.ch.offB = off; } else { en.self.off = off; }
				});
			}
			// a self-loop steps out above the node; keep that space free
			const loop = selfLoops.filter((e) => e.u === it.node.i);
			if (loop.length) { it.extraLo = Math.max(it.extraLo, S.selfLoop + (loop.length - 1) * S.track + (loop.some((e) => e.label) ? Math.max.apply(null, loop.filter((e) => e.label).map((e) => lc(e.label))) + S.labelGap : 0) + 2); }
		}

		// ---- place across the flow --------------------------------------------------------------
		const crossPadLo = right ? S.groupHeader + S.groupInset - 6 : S.groupInset;
		const crossPadHi = S.groupInset;
		const mainPadLo = right ? S.groupInset : S.groupHeader + S.groupInset - 6;
		const mainPadHi = S.groupInset;
		placeCross(items, ranks, liveGroups, G, chains, S, { crossPadLo, crossPadHi, right, reserve: reserve || null }, warnings);

		// ---- gaps between ranks: tracks for the bends, room for the labels -----------------------
		const nestLo = (g) => mainPadLo + Math.max(0, Math.max.apply(null, [0].concat(g.kids.filter((k) => G[k].nodes.size && G[k].rmin === g.rmin).map((k) => nestLo(G[k])))));
		const nestHi = (g) => mainPadHi + Math.max(0, Math.max.apply(null, [0].concat(g.kids.filter((k) => G[k].nodes.size && G[k].rmax === g.rmax).map((k) => nestHi(G[k])))));
		const openPad = new Array(R + 1).fill(0), closePad = new Array(R + 1).fill(0);
		for (const g of liveGroups) {
			if (g.parent >= 0) { continue; }
			openPad[g.rmin] = Math.max(openPad[g.rmin], nestLo(g));
			closePad[g.rmax] = Math.max(closePad[g.rmax], nestHi(g));
		}
		const crossAt = (it, ch, end) => it.x + (it.kind === 'node' ? (end === 'A' ? ch.offA : ch.offB) : 0);
		const gaps = [];
		const hasLoop = new Array(R).fill(0);
		const loopCount = new Map();
		for (const e of selfLoops) { loopCount.set(e.u, (loopCount.get(e.u) || 0) + 1); hasLoop[N[e.u].rank] = Math.max(hasLoop[N[e.u].rank], loopCount.get(e.u)); }
		for (let r = 0; r + 1 < R; r++) {
			const conns = segs[r].map((sg) => {
				const ca = crossAt(sg.a, sg.ch, 'A'), cb = crossAt(sg.b, sg.ch, 'B');
				return { sg, ca, cb, lo: Math.min(ca, cb), hi: Math.max(ca, cb), bent: Math.abs(ca - cb) > STRAIGHT, track: -1 };
			});
			const tracks = assignTracks(conns.filter((c) => c.bent), S);
			// Which labels live in THIS gap: an edge with no wide-enough rank to ride over puts its
			// label on the stub into its target, i.e. in the last gap it crosses.
			let tail = 0, straightRoom = 0, crowd = 0;
			const arriving = new Map();
			for (const c of conns) {
				const ch = c.sg.ch, e = ch.e;
				if (!e.label || ch.host || c.sg.j !== ch.seq.length - 2) { continue; }
				if (c.bent) { tail = Math.max(tail, lm(e.label) + 2 * S.labelPad); }
				else { straightRoom = Math.max(straightRoom, lm(e.label) + 2 * S.labelPad + S.arrow + 4); }
				arriving.set(c.sg.b, (arriving.get(c.sg.b) || 0) + 1);
				if (arriving.get(c.sg.b) > 2) { crowd = Math.max(crowd, lm(e.label) + 2 * S.labelPad + 2); }
			}
			// Three or more labelled connectors into one node cannot all be labelled where they arrive;
			// a longer stub out of each SOURCE gives the extra ones somewhere clear to sit.
			const loopPad = hasLoop[r] ? S.selfLoop + (hasLoop[r] - 1) * S.track + 6 : 0;
			const lead = Math.max(S.channelPad, crowd) + loopPad;
			const bundle = tracks > 0 ? (tracks - 1) * S.track : 0;
			const trail = Math.max(S.channelPad, tail ? tail + S.arrow + 4 : 0);
			let core = tracks > 0 ? lead + bundle + trail : Math.max(loopPad + S.channelPad, 0);
			core = Math.max(core, straightRoom + loopPad, S.rankGap);
			gaps.push({ conns, tracks, lead, bundle, trail, core, hugLo: tail > 0 || loopPad > 0, width: closePad[r] + core + openPad[r + 1] });
		}

		// ---- place along the flow, then route ----------------------------------------------------
		const rankLo = new Array(R).fill(0), rankHi = new Array(R).fill(0);
		const placeMain = () => {
			let m = openPad[0];
			for (let r = 0; r < R; r++) {
				rankLo[r] = m; rankHi[r] = m + rankMs[r];
				m = rankHi[r] + (r + 1 < R ? gaps[r].width : 0);
			}
		};
		placeMain();
		// A group must be wide enough to carry its own label along the top.
		if (right) {
			const extra = new Array(R).fill(0);
			for (const g of liveGroups) {
				const have = (rankHi[g.rmax] + mainPadHi) - (rankLo[g.rmin] - mainPadLo);
				const need = g.labelW + 2 * S.groupInset;
				if (need > have) { g.extraHi = need - have; extra[g.rmax] = Math.max(extra[g.rmax], g.extraHi); }
			}
			if (extra.some((v) => v > 0)) {
				for (let r = 0; r + 1 < R; r++) { gaps[r].width += extra[r]; }
				placeMain();
			}
		}
		for (const it of items) { it.m = (rankLo[it.rank] + rankHi[it.rank]) / 2; }

		const P = (m, c) => (right ? { x: m, y: c } : { x: c, y: m });
		const mAxis = right ? 'x' : 'y', cAxis = right ? 'y' : 'x';
		for (let r = 0; r + 1 < R; r++) {
			const gp = gaps[r];
			const zoneLo = rankHi[r] + closePad[r], zoneHi = rankLo[r + 1] - openPad[r + 1];
			const start = gp.hugLo ? zoneLo + gp.lead : zoneLo + ((zoneHi - zoneLo) - gp.bundle) / 2;
			for (const c of gp.conns) { if (c.bent) { c.m = start + c.track * S.track; } }
		}
		const connOf = new Map();
		for (const gp of gaps) { for (const c of gp.conns) { connOf.set(c.sg.ch.e.k + ':' + c.sg.j, c); } }

		const routes = [];
		for (const ch of chains) {
			const first = ch.seq[0], last = ch.seq[ch.seq.length - 1];
			let cur = first.x + ch.offA;
			const pts = [{ m: first.m + outline(first.node, mAxis, ch.offA, B), c: cur }];
			for (let j = 0; j + 1 < ch.seq.length; j++) {
				const next = ch.seq[j + 1];
				const c = connOf.get(ch.e.k + ':' + j);
				if (c && c.bent) { pts.push({ m: c.m, c: cur }); cur = c.cb; pts.push({ m: c.m, c: cur }); }
				if (next.kind === 'virt') { pts.push({ m: rankLo[next.rank], c: cur }, { m: rankHi[next.rank], c: cur }); }
			}
			pts.push({ m: last.m - outline(last.node, mAxis, cur - last.x, B), c: cur });
			routes.push({ e: ch.e, ch, pts: simplify(pts) });
		}
		const loopsAt = new Map();
		for (const e of selfLoops) {
			const it = nodeItem[e.u], n = it.node;
			const nth = loopsAt.get(e.u) || 0; loopsAt.set(e.u, nth + 1);
			const L = S.selfLoop + nth * S.track;
			const top = it.x - it.cs / 2, enter = Math.max(-it.ms / 2 + S.portInset, it.ms / 4 - nth * S.track);
			const pts = [
				{ m: it.m + outline(n, mAxis, e.off, B), c: it.x + e.off },
				{ m: it.m + it.ms / 2 + L, c: it.x + e.off },
				{ m: it.m + it.ms / 2 + L, c: top - L },
				{ m: it.m + enter, c: top - L },
				{ m: it.m + enter, c: it.x - outline(n, cAxis, enter, B) }
			];
			routes.push({ e, ch: null, pts: simplify(pts), loop: true });
		}
		for (const rt of routes) { if (rt.e.rev) { rt.pts.reverse(); } }

		// ---- group frames -----------------------------------------------------------------------
		const frames = [];
		const frameOf = new Map();
		const frame = (g) => {
			if (frameOf.has(g.i)) { return frameOf.get(g.i); }
			let mLo = rankLo[g.rmin] - mainPadLo, mHi = rankHi[g.rmax] + mainPadHi + (g.extraHi || 0);
			for (const k of g.kids) {
				if (!G[k].nodes.size) { continue; }
				const f = frame(G[k]);
				mLo = Math.min(mLo, f.mLo - mainPadLo); mHi = Math.max(mHi, f.mHi + mainPadHi);
			}
			const f = { g, mLo, mHi, cLo: g.lo, cHi: g.hi };
			frameOf.set(g.i, f); return f;
		};
		for (const g of liveGroups) { frames.push(frame(g)); }

		// ---- everything into screen coordinates -------------------------------------------------
		const rectMC = (mLo, mHi, cLo, cHi) => (right ? { x: mLo, y: cLo, w: mHi - mLo, h: cHi - cLo } : { x: cLo, y: mLo, w: cHi - cLo, h: mHi - mLo });
		const nodesOut = nodeItem.map((it) => {
			const n = it.node;
			const c = P(it.m, it.x);
			return { id: n.id, shape: n.shape, x: c.x - n.w / 2, y: c.y - n.h / 2, w: n.w, h: n.h, cx: c.x, cy: c.y, accent: n.spec.accent === true, link: n.spec.link || null, tip: n.spec.tip || null, group: n.grp >= 0 ? G[n.grp].id : null, lines: n.lines, textH: n.textH, textDy: n.textDy };
		});
		const groupsOut = frames.map((f) => {
			const rc = rectMC(f.mLo, f.mHi, f.cLo, f.cHi);
			return { id: f.g.id, label: f.g.label, tip: f.g.tip || null, parent: f.g.parent >= 0 ? G[f.g.parent].id : null, depth: f.g.path.length, x: rc.x, y: rc.y, w: rc.w, h: rc.h, labelW: f.g.labelW, labelH: T.group.line };
		});
		for (const g of groupsOut) { g.labelX = g.x + S.groupInset - 4; g.labelY = g.y + 7; g.labelHalo = false; g.labelNeed = 0; }
		const edgesOut = routes.map((rt) => {
			const points = rt.pts.map((p) => P(p.m, p.c));
			const n = points.length, a = points[n - 2], b = points[n - 1];
			const dx = Math.sign(r2(b.x - a.x)), dy = Math.sign(r2(b.y - a.y));
			const host = rt.ch && rt.ch.host ? P(rt.ch.host.m, rt.ch.host.x) : null;
			return { index: rt.e.k, from: N[rt.e.u].id, to: N[rt.e.v].id, dashed: rt.e.dashed, points, arrow: { x: b.x, y: b.y, dx, dy }, label: null, tip: rt.e.tip || null, loop: !!rt.loop, back: !!rt.e.rev, _e: rt.e, _host: host };
		});

		placeGroupLabels(groupsOut, edgesOut, warnings);
		placeLabels(edgesOut, nodesOut, groupsOut, S, warnings, right);

		// ---- frame it: shift so the drawing starts at the margin, and measure --------------------
		let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
		const grow = (x, y) => { if (x < minX) { minX = x; } if (y < minY) { minY = y; } if (x > maxX) { maxX = x; } if (y > maxY) { maxY = y; } };
		for (const n of nodesOut) { grow(n.x - 1, n.y - 1); grow(n.x + n.w + 1, n.y + n.h + 1); }
		for (const g of groupsOut) { grow(g.x, g.y); grow(g.x + g.w, g.y + g.h); }
		for (const e of edgesOut) {
			for (const p of e.points) { grow(p.x - S.arrowHalf, p.y - S.arrowHalf); grow(p.x + S.arrowHalf, p.y + S.arrowHalf); }
			if (e.label) { grow(e.label.x, e.label.y); grow(e.label.x + e.label.w, e.label.y + e.label.h); }
		}
		if (!Number.isFinite(minX)) { minX = minY = 0; maxX = maxY = 0; }
		const dx = S.margin - minX, dy = S.margin - minY;
		for (const n of nodesOut) { n.x = r2(n.x + dx); n.y = r2(n.y + dy); n.cx = r2(n.cx + dx); n.cy = r2(n.cy + dy); }
		for (const g of groupsOut) { g.x = r2(g.x + dx); g.y = r2(g.y + dy); g.w = r2(g.w); g.h = r2(g.h); g.labelX = r2(g.labelX + dx); g.labelY = r2(g.labelY + dy); }
		for (const e of edgesOut) {
			for (const p of e.points) { p.x = r2(p.x + dx); p.y = r2(p.y + dy); }
			e.arrow.x = r2(e.arrow.x + dx); e.arrow.y = r2(e.arrow.y + dy);
			if (e.label) { e.label.x = r2(e.label.x + dx); e.label.y = r2(e.label.y + dy); }
			delete e._e; delete e._host;
		}
		const geo = {
			direction: dir, flipped: false, asked: dir,
			width: Math.ceil(maxX - minX + 2 * S.margin), height: Math.ceil(maxY - minY + 2 * S.margin),
			nodes: nodesOut, edges: edgesOut, groups: groupsOut, ranks: R,
			crossings: countAllCrossings(ranks, segs), warnings
		};
		for (const w of inspect(geo)) { warnings.push(w); }
		return geo;
	}
	/** What layoutDir() needs from a pass and nobody else does. */
	function tidy(geo) { for (const g of geo.groups) { delete g.labelNeed; } return geo; }

	/** Drop repeated points and points in the middle of a straight run. */
	function simplify(pts) {
		const out = [];
		for (const p of pts) {
			const q = out[out.length - 1];
			if (q && Math.abs(q.m - p.m) < 0.01 && Math.abs(q.c - p.c) < 0.01) { continue; }
			out.push({ m: p.m, c: p.c });
		}
		for (let i = out.length - 2; i > 0; i--) {
			const a = out[i - 1], b = out[i], c = out[i + 1];
			if ((Math.abs(a.m - b.m) < 0.01 && Math.abs(b.m - c.m) < 0.01) || (Math.abs(a.c - b.c) < 0.01 && Math.abs(b.c - c.c) < 0.01)) { out.splice(i, 1); }
		}
		return out;
	}

	// ---- ordering -------------------------------------------------------------------------------

	function crossingsBetween(sgs) {
		let c = 0;
		for (let i = 0; i < sgs.length; i++) {
			for (let j = i + 1; j < sgs.length; j++) {
				const p = sgs[i], q = sgs[j];
				const da = p.a.order - q.a.order, db = p.b.order - q.b.order;
				if (da * db < 0) { c++; }
			}
		}
		return c;
	}
	function countAllCrossings(ranks, segs) { let c = 0; for (let r = 0; r + 1 < ranks.length; r++) { c += crossingsBetween(segs[r]); } return c; }

	/**
	 * Order every rank to minimise crossings. A rank is a TREE, not a list: items that share a group
	 * stay next to each other at every level, so the order is found by sorting blocks (an item, or a
	 * whole group) among their siblings and recursing — which keeps frames contiguous by construction.
	 */
	function orderRanks(ranks, segs, G, N, nodeItem) {
		const R = ranks.length;
		const number = () => { for (const rk of ranks) { rk.forEach((it, i) => { it.order = i; }); } };
		const blocksOf = (list, depth) => {
			const blocks = [], by = new Map();
			for (const it of list) {
				const g = it.path[depth];
				if (g === undefined) { blocks.push({ group: -1, items: [it] }); continue; }
				let b = by.get(g);
				if (!b) { b = { group: g, items: [] }; by.set(g, b); blocks.push(b); }
				b.items.push(it);
			}
			return blocks;
		};
		const mean = (arr) => arr.reduce((s, v) => s + v, 0) / arr.length;
		/** Sort a rank's tree by each block's mean key (stable — ties keep their order). */
		const arrange = (list, depth, flip) => {
			const blocks = blocksOf(list, depth);
			blocks.forEach((b, i) => { b.key = mean(b.items.map((it) => it.key)); b.at = i; });
			blocks.sort((p, q) => (p.key - q.key) || (flip ? q.at - p.at : p.at - q.at));
			const out = [];
			for (const b of blocks) { if (b.group < 0) { out.push(b.items[0]); } else { for (const it of arrange(b.items, depth + 1, flip)) { out.push(it); } } }
			return out;
		};
		// Sibling groups must keep ONE order through every rank they share, or their bands would
		// have to cross. Decide that order once (by where each group sits on average) and impose it.
		const groupKey = new Map();
		const settleGroups = () => {
			number();
			const sum = new Map(), cnt = new Map();
			for (const rk of ranks) {
				const span = Math.max(1, rk.length - 1);
				for (const it of rk) { for (const g of it.path) { sum.set(g, (sum.get(g) || 0) + it.order / span); cnt.set(g, (cnt.get(g) || 0) + 1); } }
			}
			for (const g of sum.keys()) { groupKey.set(g, sum.get(g) / cnt.get(g)); }
			const keep = (list, depth) => {
				const blocks = blocksOf(list, depth);
				const slots = [], groups = [];
				blocks.forEach((b, i) => { if (b.group >= 0) { slots.push(i); groups.push(b); } });
				groups.sort((p, q) => (groupKey.get(p.group) - groupKey.get(q.group)) || (p.group - q.group));
				slots.forEach((s, i) => { blocks[s] = groups[i]; });
				const out = [];
				for (const b of blocks) { if (b.group < 0) { out.push(b.items[0]); } else { for (const it of keep(b.items, depth + 1)) { out.push(it); } } }
				return out;
			};
			for (let r = 0; r < R; r++) { ranks[r] = keep(ranks[r], 0); }
			number();
		};

		// Start from a depth-first walk in the order the model wrote things: a flow drawn the way it
		// was described is usually already close to crossing-free.
		const adjHi = new Map();
		for (const sg of segs.flat()) { if (!adjHi.has(sg.a)) { adjHi.set(sg.a, []); } adjHi.get(sg.a).push(sg.b); }
		let tick = 0;
		const seen = new Set();
		const walk = (it) => { if (seen.has(it)) { return; } seen.add(it); it.key = tick++; for (const nx of (adjHi.get(it) || [])) { walk(nx); } };
		for (const it of nodeItem.slice().sort((p, q) => (p.rank - q.rank) || (p.node.i - q.node.i))) { walk(it); }
		for (const rk of ranks) { for (const it of rk) { if (!seen.has(it)) { it.key = tick++; } } }
		for (let r = 0; r < R; r++) { ranks[r] = arrange(ranks[r], 0, false); }
		settleGroups();

		const nbrLo = new Map(), nbrHi = new Map();
		for (const sg of segs.flat()) {
			if (!nbrHi.has(sg.a)) { nbrHi.set(sg.a, []); } nbrHi.get(sg.a).push(sg.b);
			if (!nbrLo.has(sg.b)) { nbrLo.set(sg.b, []); } nbrLo.get(sg.b).push(sg.a);
		}
		const snapshot = () => ranks.map((rk) => rk.slice());
		const restore = (snap) => { for (let r = 0; r < R; r++) { ranks[r] = snap[r].slice(); } number(); };
		let best = snapshot(), bestCost = countAllCrossings(ranks, segs);
		for (let it = 0; it < 24 && bestCost > 0; it++) {
			const down = it % 2 === 0, flip = it % 4 >= 2;
			for (let s = 1; s < R; s++) {
				const r = down ? s : R - 1 - s;
				const ref = down ? nbrLo : nbrHi;
				for (const item of ranks[r]) {
					const ns = ref.get(item);
					item.key = ns && ns.length ? mean(ns.map((n) => n.order)) : item.order;
				}
				ranks[r] = arrange(ranks[r], 0, flip);
				ranks[r].forEach((x, i) => { x.order = i; });
			}
			settleGroups();
			const cost = countAllCrossings(ranks, segs);
			if (cost < bestCost) { bestCost = cost; best = snapshot(); }
		}
		restore(best);

		// Transpose: swap neighbouring siblings wherever that removes a crossing. (Two groups are
		// never swapped here — their order is global, settled above.)
		const local = (r) => (r > 0 ? crossingsBetween(segs[r - 1]) : 0) + (r + 1 < R ? crossingsBetween(segs[r]) : 0);
		const treeOf = (list, depth) => blocksOf(list, depth).map((b) => (b.group < 0 ? { item: b.items[0] } : { group: b.group, kids: treeOf(b.items, depth + 1) }));
		const flat = (tree, out) => { for (const t of tree) { if (t.item) { out.push(t.item); } else { flat(t.kids, out); } } return out; };
		for (let pass = 0; pass < 30 && bestCost > 0; pass++) {
			let improved = false;
			for (let r = 0; r < R; r++) {
				const tree = treeOf(ranks[r], 0);
				const apply = () => { ranks[r] = flat(tree, []); ranks[r].forEach((x, i) => { x.order = i; }); };
				const sweep = (level) => {
					for (let i = 0; i + 1 < level.length; i++) {
						if (level[i].group !== undefined && level[i + 1].group !== undefined) { continue; }
						const before = local(r);
						const t = level[i]; level[i] = level[i + 1]; level[i + 1] = t; apply();
						if (local(r) < before) { improved = true; }
						else { level[i + 1] = level[i]; level[i] = t; apply(); }
					}
					for (const t of level) { if (t.kids) { sweep(t.kids); } }
				};
				sweep(tree);
			}
			if (!improved) { break; }
			bestCost = countAllCrossings(ranks, segs);
		}
		number();
	}

	// ---- placement across the flow ----------------------------------------------------------------

	/**
	 * Give every item its cross coordinate, and every group its band.
	 *
	 * The hard part is stated as difference constraints (x[b] - x[a] >= d): neighbours in a rank keep
	 * their gap, a group's band contains its members plus padding, and — because a group's band is ONE
	 * pair of variables shared by every rank it spans — nothing outside a group can ever sit inside it.
	 * The soft part is alignment: sweeps along the flow move each item to the median of what it
	 * connects to, as far as the constraints let it; then anything within a hair of straight is made
	 * exactly straight.
	 */
	function placeCross(items, ranks, liveGroups, G, chains, S, pad, warnings) {
		const vars = [];
		items.forEach((it) => { it.v = vars.length; vars.push(0); });
		for (const g of liveGroups) { g.vLo = vars.length; vars.push(0); g.vHi = vars.length; vars.push(0); }
		const X = new Float64Array(vars.length);
		const cons = [];
		const add = (a, b, d) => { cons.push({ a, b, d }); };

		const gapBetween = (p, q) => {
			if (p.group >= 0 || q.group >= 0) { return S.groupGap; }
			const a = p.items[0], b = q.items[0];
			if (a.kind === 'node' && b.kind === 'node') { return S.nodeGap; }
			if (a.kind === 'virt' && b.kind === 'virt') { return S.track; }
			return S.lineClear;
		};
		const blocksOf = (list, depth) => {
			const blocks = [], by = new Map();
			for (const it of list) {
				const g = it.path[depth];
				if (g === undefined) { blocks.push({ group: -1, items: [it] }); continue; }
				let b = by.get(g);
				if (!b) { b = { group: g, items: [] }; by.set(g, b); blocks.push(b); }
				b.items.push(it);
			}
			return blocks;
		};
		const hiOf = (b) => (b.group >= 0 ? { v: G[b.group].vHi, off: 0 } : { v: b.items[0].v, off: b.items[0].cs / 2 + b.items[0].extraHi });
		const loOf = (b) => (b.group >= 0 ? { v: G[b.group].vLo, off: 0 } : { v: b.items[0].v, off: -(b.items[0].cs / 2 + b.items[0].extraLo) });
		const walk = (list, depth) => {
			const blocks = blocksOf(list, depth);
			for (let i = 0; i + 1 < blocks.length; i++) {
				const hi = hiOf(blocks[i]), lo = loOf(blocks[i + 1]);
				// (x[lo.v] + lo.off) - (x[hi.v] + hi.off) >= gap
				add(hi.v, lo.v, gapBetween(blocks[i], blocks[i + 1]) + hi.off - lo.off);
			}
			for (const b of blocks) { if (b.group >= 0) { walk(b.items, depth + 1); } }
		};
		for (const rk of ranks) { walk(rk, 0); }
		// containment: a group's band holds its direct items and its child groups, plus padding
		const kidsOf = new Map();
		for (const it of items) {
			if (it.grp < 0) { continue; }
			const g = G[it.grp];
			const isSpacer = it.kind === 'spacer';
			add(g.vLo, it.v, isSpacer ? 0 : it.cs / 2 + it.extraLo + (it.kind === 'virt' ? S.lineClear : pad.crossPadLo));
			add(it.v, g.vHi, isSpacer ? 0 : it.cs / 2 + it.extraHi + (it.kind === 'virt' ? S.lineClear : pad.crossPadHi));
			if (!kidsOf.has(g.i)) { kidsOf.set(g.i, []); } kidsOf.get(g.i).push(it);
		}
		for (const g of liveGroups) {
			if (g.parent >= 0 && G[g.parent].nodes.size) {
				add(G[g.parent].vLo, g.vLo, pad.crossPadLo);
				add(g.vHi, G[g.parent].vHi, pad.crossPadHi);
			}
			// when the flow runs down, the label lies across the band: the band must be wide enough for it
			add(g.vLo, g.vHi, pad.right ? 0 : g.labelW + 2 * S.groupInset);
		}
		// When the flow runs down, a group's name lies along the very edge its connectors come in by.
		// For the groups named in `reserve` — the ones whose name found no clear stretch on the first
		// pass — every line entering from above is kept to the far side of the name, so the name stays
		// in its corner with nothing through it.
		const besideName = new Map();   // group index → [{ v, d }]: x[v] - x[group.vLo] >= d
		if (!pad.right && pad.reserve && pad.reserve.size) {
			for (const ch of chains) {
				for (let j = 0; j + 1 < ch.seq.length; j++) {
					const a = ch.seq[j], b = ch.seq[j + 1];
					const port = b.kind === 'node' ? ch.offB : 0;   // where on `b` the line lands, from its centre
					for (const gi of b.path) {
						if (!pad.reserve.has(G[gi].id) || a.path.indexOf(gi) >= 0) { continue; }   // (a line already inside does not cross this frame's top)
						const d = (S.groupInset - 4) + G[gi].labelW + NAME_CLEAR - port;
						add(G[gi].vLo, b.v, d);
						if (!besideName.has(gi)) { besideName.set(gi, []); }
						besideName.get(gi).push({ v: b.v, d });
					}
				}
			}
		}

		/** Push everything down until every constraint holds. Returns false if they contradict. */
		const settle = () => {
			for (let pass = 0; pass <= X.length + 1; pass++) {
				let changed = false;
				for (const c of cons) { if (X[c.b] < X[c.a] + c.d - 1e-9) { X[c.b] = X[c.a] + c.d; changed = true; } }
				if (!changed) { return true; }
			}
			return false;
		};
		if (!settle()) { warnings.push({ cls: 'layout-constraints', message: 'group bands could not all be honoured' }); }

		// What each item would like to line up with: the items its connectors lead to, one rank down
		// the flow (`tLo`) and one rank up it (`tHi`), each adjusted for the port the connector uses.
		for (const it of items) { it.tLo = []; it.tHi = []; }
		const terms = [];
		for (const ch of chains) {
			for (let j = 0; j + 1 < ch.seq.length; j++) {
				const a = ch.seq[j], b = ch.seq[j + 1];
				const off = (a.kind === 'node' ? ch.offA : 0) - (b.kind === 'node' ? ch.offB : 0);   // want x[b] - x[a] = off
				a.tHi.push({ o: b.v, off: -off }); b.tLo.push({ o: a.v, off: off });
				terms.push({ u: a.v, v: b.v, off });
			}
		}
		const inc = Array.from({ length: X.length }, () => []), out = Array.from({ length: X.length }, () => []);
		for (const c of cons) { inc[c.b].push(c); out[c.a].push(c); }
		const lbOf = (v) => { let lb = -Infinity; for (const c of inc[v]) { lb = Math.max(lb, X[c.a] + c.d); } return lb; };
		const ubOf = (v) => { let ub = Infinity; for (const c of out[v]) { ub = Math.min(ub, X[c.b] - c.d); } return ub; };
		const itemOf = new Map(items.map((it) => [it.v, it]));

		/**
		 * Where an item wants to be, looking at one side: the MEDIAN of what it connects to there.
		 * A median, not a mean, because a connector is either straight or it has two corners — being
		 * "nearly" in line buys nothing. Two neighbours: sit exactly between them (the symmetric fork).
		 * Four or more, an even count: take whichever middle one is nearer the centre of mass, so one
		 * connector still runs straight.
		 */
		const target = (it, side) => {
			let ts = side === 'lo' ? it.tLo : it.tHi;
			if (!ts.length) { ts = side === 'lo' ? it.tHi : it.tLo; }
			if (!ts.length) { return null; }
			const ds = ts.map((t) => X[t.o] + t.off).sort((p, q) => p - q);
			const n = ds.length, lo = ds[Math.floor((n - 1) / 2)], hi = ds[Math.floor(n / 2)];
			const mean = ds.reduce((p, q) => p + q, 0) / n;
			if (n >= 4 && n % 2 === 0) { return Math.abs(lo - mean) <= Math.abs(hi - mean) ? lo : hi; }
			return Math.max(lo, Math.min(hi, mean));
		};
		const byDepth = liveGroups.slice().sort((p, q) => p.path.length - q.path.length);
		/**
		 * Open every band as far as its surroundings allow, so its members can move inside it. Two
		 * neighbouring groups cannot both have the free space between them, so who is asked first
		 * alternates from sweep to sweep.
		 */
		const loosen = (flip) => {
			const order = flip ? byDepth.slice().sort((p, q) => (p.path.length - q.path.length) || (q.i - p.i)) : byDepth;
			for (const g of order) {
				const lb = lbOf(g.vLo), ub = ubOf(g.vHi);
				X[g.vLo] = Number.isFinite(lb) ? Math.min(lb, X[g.vLo]) : X[g.vLo] - 600;
				X[g.vHi] = Number.isFinite(ub) ? Math.max(ub, X[g.vHi]) : X[g.vHi] + 600;
			}
		};
		/**
		 * Close every band back around what it holds. A band may have to stay wider than its
		 * contents (when the flow runs down, its label lies across it); the spare width is shared
		 * out on both sides where there is room, and taken from whichever side has it where there
		 * is not — it is never taken from a neighbour.
		 */
		const tighten = () => {
			for (const g of byDepth.slice().reverse()) {
				let lo = Infinity, hi = -Infinity;
				for (const it of (kidsOf.get(g.i) || [])) {
					const sp = it.kind === 'spacer', vt = it.kind === 'virt';
					lo = Math.min(lo, X[it.v] - (sp ? 0 : it.cs / 2 + it.extraLo + (vt ? S.lineClear : pad.crossPadLo)));
					hi = Math.max(hi, X[it.v] + (sp ? 0 : it.cs / 2 + it.extraHi + (vt ? S.lineClear : pad.crossPadHi)));
				}
				for (const k of g.kids) { if (G[k].nodes.size) { lo = Math.min(lo, X[G[k].vLo] - pad.crossPadLo); hi = Math.max(hi, X[G[k].vHi] + pad.crossPadHi); } }
				// the band also reaches far enough to the low side for its name to sit clear of the lines coming in
				for (const c of (besideName.get(g.i) || [])) { lo = Math.min(lo, X[c.v] - c.d); }
				if (!Number.isFinite(lo)) { continue; }
				const spare = (pad.right ? 0 : g.labelW + 2 * S.groupInset) - (hi - lo);
				if (spare > 0) {
					// how far each side may move out before it meets something
					let roomLo = Infinity, roomHi = Infinity;
					for (const c of inc[g.vLo]) { roomLo = Math.min(roomLo, lo - (X[c.a] + c.d)); }
					for (const c of out[g.vHi]) { if (c.b !== g.vLo) { roomHi = Math.min(roomHi, (X[c.b] - c.d) - hi); } }
					roomLo = Math.max(0, roomLo); roomHi = Math.max(0, roomHi);
					let takeLo = Math.min(spare / 2, roomLo), takeHi = Math.min(spare - takeLo, roomHi);
					takeLo = Math.min(spare - takeHi, roomLo);
					lo -= takeLo; hi += spare - takeLo;          // anything still owed goes down-flow; settle() makes the room
				}
				X[g.vLo] = lo; X[g.vHi] = hi;
			}
		};
		/**
		 * Move an item toward `want`. Rank-mates it is pressed against in that direction come along —
		 * but only as far as that cluster agrees to go (the median of what each member wants), and
		 * never past the next thing in the way. So two children stacked under one parent slide
		 * together until the parent is centred on them, instead of the first one hogging the line.
		 *
		 * A group's band is a WALL here, not a member: nothing pushes a group, and a group pushes
		 * nothing. Letting pushes travel through bands links every rank into one cluster that never
		 * settles; with walls, a group moves only because the things inside it did.
		 */
		const move = (it, want, side, alone) => {
			const delta = want - X[it.v];
			if (Math.abs(delta) < 0.01) { return; }
			const dir = delta > 0 ? 1 : -1;
			const cluster = new Set([it.v]), stack = [it.v];
			while (!alone && stack.length) {
				const a = stack.pop();
				for (const c of (dir > 0 ? out[a] : inc[a])) {
					const o = dir > 0 ? c.b : c.a;
					if (!cluster.has(o) && itemOf.has(o) && X[c.b] - X[c.a] - c.d <= 1e-6) { cluster.add(o); stack.push(o); }
				}
			}
			let limit = Infinity;
			const wishes = [];
			for (const v of cluster) {
				for (const c of (dir > 0 ? out[v] : inc[v])) {
					if (!cluster.has(dir > 0 ? c.b : c.a)) { limit = Math.min(limit, X[c.b] - X[c.a] - c.d); }
				}
				const m = itemOf.get(v);
				if (m.kind !== 'spacer') { const t = target(m, side); if (t !== null) { wishes.push((t - X[v]) * dir); } }
			}
			wishes.sort((p, q) => p - q);
			const n = wishes.length;
			let step = n ? (wishes[Math.floor((n - 1) / 2)] + wishes[Math.floor(n / 2)]) / 2 : Math.abs(delta);
			step = Math.max(0, Math.min(step, Math.abs(delta), limit));
			if (step > 1e-6) { for (const v of cluster) { X[v] += dir * step; } }
		};
		const R = ranks.length;
		const sweep = (down, flip, alone) => {
			loosen(flip);
			for (let s = 0; s < R; s++) {
				const rk = ranks[down ? s : R - 1 - s];
				for (const list of [rk, rk.slice().reverse()]) {
					for (const it of list) {
						if (it.kind === 'spacer') { continue; }
						const t = target(it, down ? 'lo' : 'hi');
						if (t !== null) { move(it, t, down ? 'lo' : 'hi', alone); }
					}
				}
			}
			tighten();
		};
		// Sweep up the flow lining things up with what they lead to, then down it lining them up
		// with what leads to them. The last sweeps run WITH the flow and move one item at a time, so
		// a line leaves its source straight, does its turning at the far end, and nothing that was
		// just lined up is nudged again.
		for (let round = 0; round < 6; round++) { sweep(false, round % 2 === 1, false); sweep(true, round % 2 === 0, false); }
		for (let polish = 0; polish < 3; polish++) { sweep(true, polish % 2 === 1, true); }
		settle();

		// Straighten: a connector within a hair of straight is MADE straight, when nothing objects.
		const holds = (v) => inc[v].every((c) => X[c.b] - X[c.a] >= c.d - 1e-6) && out[v].every((c) => X[c.b] - X[c.a] >= c.d - 1e-6);
		for (let pass = 0; pass < 2; pass++) {
			for (const t of terms) {
				const delta = X[t.v] - X[t.u] - t.off;
				if (Math.abs(delta) < 1e-9 || Math.abs(delta) > 2.5) { continue; }
				const keep = X[t.v];
				X[t.v] = X[t.u] + t.off;
				if (holds(t.v)) { continue; }
				X[t.v] = keep;
				const keepU = X[t.u];
				X[t.u] = X[t.v] - t.off;
				if (!holds(t.u)) { X[t.u] = keepU; }
			}
		}
		tighten();
		settle();
		for (const it of items) { it.x = X[it.v]; }
		for (const g of liveGroups) { g.lo = X[g.vLo]; g.hi = X[g.vHi]; }
	}

	// ---- channel tracks -----------------------------------------------------------------------------

	/**
	 * Give each bent connector in a gap a track to turn in. Two connectors whose turns overlap never
	 * share a track; among the orders that satisfy that, the one with the fewest crossings wins.
	 * Returns the number of tracks used; sets `track` on each connector.
	 */
	function assignTracks(bent, S) {
		const n = bent.length;
		if (!n) { return 0; }
		// i before j (i turns closer to the source rank): its inbound stub crosses j's turn when it
		// lands inside j's span, and j's outbound stub crosses i's turn when it starts inside i's.
		const inside = (v, c) => v > c.lo + 0.5 && v < c.hi - 0.5;
		// ...and when i's inbound stub and j's outbound stub lie on (nearly) the same line, i turning
		// first lays one on top of the other. That is worse than a crossing: two connectors that
		// run along each other read as one.
		const along = (u, v) => Math.abs(u - v) < 4;
		const cost = (order) => {
			let x = 0;
			for (let i = 0; i < order.length; i++) {
				for (let j = i + 1; j < order.length; j++) {
					const p = order[i], q = order[j];
					if (inside(p.cb, q)) { x++; }
					if (inside(q.ca, p)) { x++; }
					if (along(p.cb, q.ca)) { x += 4; }
				}
			}
			return x;
		};
		let order = bent.slice().sort((p, q) => (p.lo - q.lo) || (p.hi - q.hi));
		if (n <= 7) {
			let best = order, bestCost = cost(order);
			const permute = (arr, k) => {
				if (bestCost === 0) { return; }
				if (k === arr.length) { const c = cost(arr); if (c < bestCost) { bestCost = c; best = arr.slice(); } return; }
				for (let i = k; i < arr.length; i++) {
					const t = arr[k]; arr[k] = arr[i]; arr[i] = t;
					permute(arr, k + 1);
					arr[i] = arr[k]; arr[k] = t;
				}
			};
			permute(order.slice(), 0);
			order = best;
		} else {
			let improved = true, guard = 0;
			while (improved && guard++ < 60) {
				improved = false;
				for (let i = 0; i + 1 < order.length; i++) {
					const before = cost(order);
					const t = order[i]; order[i] = order[i + 1]; order[i + 1] = t;
					if (cost(order) < before) { improved = true; } else { order[i + 1] = order[i]; order[i] = t; }
				}
			}
		}
		// Turns that do not overlap may share a track (a fan-out going up and one going down meet on one line).
		const clear = S.track * 0.75;
		let track = 0, current = [];
		for (const c of order) {
			const fits = current.every((o) => (c.lo > o.hi + clear || c.hi < o.lo - clear) && !along(c.cb, o.ca) && !along(c.ca, o.cb));
			if (current.length && !fits) { track++; current = []; }
			c.track = track; current.push(c);
		}
		return track + 1;
	}

	// ---- labels -------------------------------------------------------------------------------------

	const overlap = (a, b, padBy) => !(a.x + a.w <= b.x - padBy || b.x + b.w <= a.x - padBy || a.y + a.h <= b.y - padBy || b.y + b.h <= a.y - padBy);
	/** Does the axis-aligned segment p→q pass through rectangle r (grown by `padBy`)? */
	function segHitsRect(p, q, r, padBy) {
		const x0 = Math.min(p.x, q.x), x1 = Math.max(p.x, q.x), y0 = Math.min(p.y, q.y), y1 = Math.max(p.y, q.y);
		return !(x1 <= r.x - padBy || x0 >= r.x + r.w + padBy || y1 <= r.y - padBy || y0 >= r.y + r.h + padBy);
	}
	/**
	 * Does a rectangle touch a NODE — its drawn outline, not its bounding box? A diamond's box has
	 * four empty corners, and a label tucked into one of them is beside the node, not on it.
	 */
	function rectHitsNode(rc, n, padBy) {
		if (!overlap(rc, n, padBy)) { return false; }
		if (n.shape !== 'decision') { return true; }
		const cx = n.x + n.w / 2, cy = n.y + n.h / 2, hw = n.w / 2 + padBy, hh = n.h / 2 + padBy;
		// the point of the rectangle nearest the diamond's centre decides it
		const px = Math.max(rc.x, Math.min(cx, rc.x + rc.w)), py = Math.max(rc.y, Math.min(cy, rc.y + rc.h));
		return Math.abs(px - cx) / hw + Math.abs(py - cy) / hh <= 1;
	}

	/**
	 * A group's name sits in the top-left of its frame — which, when the flow runs down, is exactly
	 * where connectors come in. A name with a line through it is slid along the top of the frame to
	 * the nearest clear stretch; if the frame has none, it stays where it was and is marked to be
	 * backed, so the line passes behind it and the name still reads. Runs before the edge labels are
	 * placed, so they keep clear of wherever the name ends up.
	 */
	function placeGroupLabels(groups, edges, warnings) {
		const CLEAR = NAME_CLEAR - 1;
		for (const g of groups) {
			const y = g.labelY, h = g.labelH, w = g.labelW;
			const lo = g.labelX, hi = g.x + g.w - (g.labelX - g.x) - w;   // from the left inset to the same inset on the right
			const crossed = (x) => {
				const rc = { x, y, w, h };
				for (const e of edges) { for (let i = 0; i + 1 < e.points.length; i++) { if (segHitsRect(e.points[i], e.points[i + 1], rc, 2)) { return true; } } }
				return false;
			};
			if (!crossed(lo)) { continue; }
			// The places worth trying: just past each line that comes through the name's row, and the far end.
			const cands = [hi];
			for (const e of edges) {
				for (let i = 0; i + 1 < e.points.length; i++) {
					const p = e.points[i], q = e.points[i + 1];
					if (Math.abs(p.x - q.x) > 0.02) { continue; }   // a line running ALONG the row cannot be stepped past
					if (Math.max(p.y, q.y) <= y - 2 || Math.min(p.y, q.y) >= y + h + 2) { continue; }
					cands.push(p.x + CLEAR, p.x - CLEAR - w);
				}
			}
			const clear = cands.filter((x) => x >= lo - 0.01 && x <= hi + 0.01).sort((a, b) => a - b).find((x) => !crossed(x));
			if (clear !== undefined) { g.labelX = clear; continue; }
			g.labelHalo = true;
			// How far the leftmost line through the name would have to move to clear it (layoutDir decides
			// whether that is worth doing). A line running along the row cannot be moved aside at all.
			let need = 0;
			for (const e of edges) {
				for (let i = 0; i + 1 < e.points.length; i++) {
					const p = e.points[i], q = e.points[i + 1];
					if (!segHitsRect(p, q, { x: lo, y, w, h }, 2)) { continue; }
					need = Math.max(need, Math.abs(p.x - q.x) > 0.02 ? Infinity : lo + w + CLEAR - p.x);
				}
			}
			g.labelNeed = need;
			warnings.push({ cls: 'group-label-backed', message: 'group ' + g.id + ': a connector runs behind its name' });
		}
	}

	/**
	 * Put each edge label BESIDE its line. Candidates are stepped along every run of the route
	 * (above and below a horizontal run, left and right of a vertical one) and scored by what they
	 * would touch; the cleanest wins, with a preference for the run that carries the arrowhead. The
	 * labels with the fewest clean options choose first. A label that cannot be placed clear of
	 * everything is still placed — with a halo so it stays legible — and reported, never dropped.
	 */
	function placeLabels(edges, nodes, groups, S, warnings, right) {
		const groupLabels = groups.map((g) => ({ x: g.labelX, y: g.labelY, w: g.labelW, h: g.labelH }));
		const STEP = 8;
		const side = S.labelSideGap != null ? S.labelSideGap : S.labelGap + 1;   // beside a vertical run
		const jobs = [];
		for (const e of edges) {
			const lab = e._e && e._e.label;
			if (!lab) { continue; }
			const cands = [];
			const pts = e.points;
			const last = pts.length - 2;
			for (let i = 0; i + 1 < pts.length; i++) {
				const p = pts[i], q = pts[i + 1];
				const horizontal = Math.abs(p.y - q.y) < 0.01;
				const runPen = i === last ? 0 : 4;
				// keep clear of the arrowhead on the last run, and of the corner on any run
				const headLo = (i === last && (horizontal ? q.x < p.x : q.y < p.y)) ? S.arrow + 4 : 3;
				const headHi = (i === last && (horizontal ? q.x > p.x : q.y > p.y)) ? S.arrow + 4 : 3;
				if (horizontal) {
					const lo = Math.min(p.x, q.x) + headLo, hi = Math.max(p.x, q.x) - headHi;
					const room = (hi - lo) - lab.w;
					const prefer = i === last ? (q.x > p.x ? hi - lab.w : lo) : lo + room / 2;
					const xs = [];
					if (room >= 0) { for (let x = lo; x <= lo + room + 0.01; x += STEP) { xs.push(x); } xs.push(lo + room); xs.push(lo + room / 2); }
					else { xs.push(lo + room / 2); }
					for (const x of xs) {
						const far = Math.abs(x - prefer) * 0.02 + (room < 0 ? 40 : 0);
						cands.push({ x, y: p.y - S.labelGap - lab.h, pen: runPen + far });
						cands.push({ x, y: p.y + S.labelGap, pen: runPen + far + 6 });
					}
				} else {
					const lo = Math.min(p.y, q.y) + headLo, hi = Math.max(p.y, q.y) - headHi;
					const room = (hi - lo) - lab.h;
					if (room < -4) { continue; }
					const ys = [];
					for (let y = lo; y <= lo + Math.max(0, room) + 0.01; y += STEP) { ys.push(y); }
					ys.push(lo + room / 2);
					const prefer = lo + room / 2;
					for (const y of ys) {
						const far = Math.abs(y - prefer) * 0.02;
						cands.push({ x: p.x + side, y, pen: runPen + far + (right ? 8 : 1) });
						cands.push({ x: p.x - side - lab.w, y, pen: runPen + far + (right ? 10 : 3) });
					}
				}
			}
			// A long edge reserved clear space above its line in one rank; that spot goes first.
			if (e._host) {
				cands.push(right
					? { x: e._host.x - lab.w / 2, y: e._host.y - S.labelGap - lab.h, pen: -2 }
					: { x: e._host.x - side - lab.w, y: e._host.y - lab.h / 2, pen: -2 });
			}
			if (!cands.length) { const p = pts[0]; cands.push({ x: p.x + 4, y: p.y - S.labelGap - lab.h, pen: 50 }); }
			// what each candidate touches that will not move: nodes, lines, frames
			for (const c of cands) {
				const rc = { x: c.x, y: c.y, w: lab.w, h: lab.h };
				let score = c.pen;
				for (const n of nodes) { if (rectHitsNode(rc, n, 3)) { score += 1000; } }
				for (const g of groupLabels) { if (overlap(rc, g, 3)) { score += 600; } }
				for (const g of groups) {
					// a label straddling a group's border reads as belonging to neither side
					const inside = rc.x >= g.x + 2 && rc.x + rc.w <= g.x + g.w - 2 && rc.y >= g.y + 2 && rc.y + rc.h <= g.y + g.h - 2;
					if (!inside && overlap(rc, g, 0)) { score += 40; }
				}
				for (const o of edges) {
					for (let i = 0; i + 1 < o.points.length; i++) {
						if (segHitsRect(o.points[i], o.points[i + 1], rc, o === e ? 1 : 2)) { score += 300; }
					}
				}
				c.rc = rc; c.fixed = score;
			}
			jobs.push({ e, lab, cands, clean: cands.filter((c) => c.fixed < 300).length });
		}
		jobs.sort((p, q) => (p.clean - q.clean) || (p.e.index - q.e.index));
		const placed = [];
		for (const job of jobs) {
			let best = null;
			for (const c of job.cands) {
				let score = c.fixed;
				for (const o of placed) { if (overlap(c.rc, o, 4)) { score += 1000; } }
				if (!best || score < best.score) { best = { rc: c.rc, score }; }
			}
			job.e.label = { text: job.lab.text, x: best.rc.x, y: best.rc.y, w: job.lab.w, h: job.lab.h, halo: best.score >= 300 };
			if (best.score >= 300) { warnings.push({ cls: 'label-collision', message: 'edge ' + job.e.index + ': no clear spot for its label' }); }
			placed.push(best.rc);
		}
	}

	// ---- the layout layer's own check ----------------------------------------------------------------

	/**
	 * "No text overflow, overlap or out-of-frame content." Returns what is wrong with a geometry —
	 * empty when it is clean. The renderer logs these; the tests assert there are none.
	 */
	function inspect(geo) {
		const out = [];
		const ns = geo.nodes;
		for (let i = 0; i < ns.length; i++) {
			for (let j = i + 1; j < ns.length; j++) {
				if (overlap(ns[i], ns[j], 1)) { out.push({ cls: 'node-overlap', message: ns[i].id + ' overlaps ' + ns[j].id }); }
			}
		}
		for (const n of ns) {
			if (n.x < 0 || n.y < 0 || n.x + n.w > geo.width || n.y + n.h > geo.height) { out.push({ cls: 'out-of-frame', message: 'node ' + n.id }); }
			for (const l of n.lines) { if (l.w > n.w + 0.5) { out.push({ cls: 'text-overflow', message: 'node ' + n.id + ': "' + l.text + '"' }); } }
		}
		for (const e of geo.edges) {
			for (const p of e.points) { if (p.x < 0 || p.y < 0 || p.x > geo.width || p.y > geo.height) { out.push({ cls: 'out-of-frame', message: 'edge ' + e.index }); break; } }
			for (let i = 0; i + 1 < e.points.length; i++) {
				const p = e.points[i], q = e.points[i + 1];
				if (Math.abs(p.x - q.x) > 0.02 && Math.abs(p.y - q.y) > 0.02) { out.push({ cls: 'diagonal', message: 'edge ' + e.index + ' is not orthogonal' }); }
				for (const n of ns) {
					// A connector touches the two nodes it joins — with its first and last run only —
					// and nothing else.
					const own = n.id === e.from || n.id === e.to;
					const terminal = i === 0 || i === e.points.length - 2;
					if (own && (terminal || e.loop)) { continue; }
					if (segHitsRect(p, q, n, -1)) { out.push({ cls: 'edge-through-node', message: 'edge ' + e.index + ' crosses ' + n.id }); }
				}
			}
			if (e.label) {
				for (const n of ns) { if (rectHitsNode(e.label, n, 0)) { out.push({ cls: 'label-on-node', message: 'edge ' + e.index + ' label on ' + n.id }); } }
				if (e.label.x < 0 || e.label.y < 0 || e.label.x + e.label.w > geo.width || e.label.y + e.label.h > geo.height) { out.push({ cls: 'out-of-frame', message: 'label of edge ' + e.index }); }
			}
		}
		// "Never share a segment": two connectors may cross, but never run along each other.
		const runs = [];
		for (const e of geo.edges) {
			for (let i = 0; i + 1 < e.points.length; i++) {
				const p = e.points[i], q = e.points[i + 1];
				const hz = Math.abs(p.y - q.y) < 0.02;
				runs.push({ e: e.index, hz, at: hz ? p.y : p.x, lo: Math.min(hz ? p.x : p.y, hz ? q.x : q.y), hi: Math.max(hz ? p.x : p.y, hz ? q.x : q.y) });
			}
		}
		for (let i = 0; i < runs.length; i++) {
			for (let j = i + 1; j < runs.length; j++) {
				const a = runs[i], b = runs[j];
				if (a.e === b.e || a.hz !== b.hz || Math.abs(a.at - b.at) > 0.75) { continue; }
				if (Math.min(a.hi, b.hi) - Math.max(a.lo, b.lo) > 1.5) { out.push({ cls: 'shared-segment', message: 'edges ' + a.e + ' and ' + b.e + ' run along each other' }); }
			}
		}
		const gs = geo.groups;
		const inside = (inner, outer) => inner.x >= outer.x - 0.5 && inner.y >= outer.y - 0.5 && inner.x + inner.w <= outer.x + outer.w + 0.5 && inner.y + inner.h <= outer.y + outer.h + 0.5;
		for (let i = 0; i < gs.length; i++) {
			for (let j = i + 1; j < gs.length; j++) {
				if (overlap(gs[i], gs[j], 0) && !inside(gs[i], gs[j]) && !inside(gs[j], gs[i])) { out.push({ cls: 'group-overlap', message: gs[i].id + ' overlaps ' + gs[j].id }); }
			}
			if (gs[i].labelW + 8 > gs[i].w) { out.push({ cls: 'text-overflow', message: 'group ' + gs[i].id + ' label' }); }
			else if (gs[i].labelX < gs[i].x - 0.5 || gs[i].labelX + gs[i].labelW > gs[i].x + gs[i].w + 0.5) { out.push({ cls: 'out-of-frame', message: 'the name of group ' + gs[i].id }); }
		}
		// A group's name is text like any other: no connector runs through it. (One marked to be backed
		// is drawn over the line on purpose, and reported separately.)
		for (const g of gs) {
			if (g.labelHalo) { continue; }
			const rc = { x: g.labelX, y: g.labelY, w: g.labelW, h: g.labelH };
			for (const e of geo.edges) {
				for (let i = 0; i + 1 < e.points.length; i++) {
					if (segHitsRect(e.points[i], e.points[i + 1], rc, 1)) { out.push({ cls: 'group-label-crossed', message: 'edge ' + e.index + ' runs through the name of group ' + g.id }); break; }
				}
			}
		}
		// a node is inside every group it belongs to, and outside every other
		const parentOf = new Map(gs.map((g) => [g.id, g.parent]));
		for (const n of ns) {
			const mine = new Set();
			for (let g = n.group, hops = 0; g && hops < 16; g = parentOf.get(g), hops++) { mine.add(g); }
			for (const g of gs) {
				if (mine.has(g.id)) { if (!inside(n, g)) { out.push({ cls: 'member-outside-group', message: n.id + ' is outside ' + g.id }); } }
				else if (overlap(n, g, 0)) { out.push({ cls: 'stranger-in-group', message: n.id + ' sits inside ' + g.id }); }
			}
		}
		return out;
	}

	return { layout, inspect, nodeSize, outline, assignTracks, simplify };
}));
