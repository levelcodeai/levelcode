/*---------------------------------------------------------------------------------------------
 *  Rich diagrams — layout — run: node test/diagramLayout.test.js
 *
 *  docs/RICH-DIAGRAMS.md: the model decides what connects to what; the renderer decides where
 *  everything goes, the same way every time. So the layout is tested as GEOMETRY: boxes never
 *  overlap, a connector never passes through a box it does not join, lines are orthogonal and never
 *  run along one another, a group's frame holds its members and nothing else, labels sit beside
 *  lines, and all of it fits the frame — for the diagrams the feature exists for, and for a few
 *  thousand random ones nobody would draw on purpose.
 *
 *  Text is measured with theme.approxMeasure here (the webview uses a canvas), so every number in
 *  this file is deterministic on any machine.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const L = require('../diagram/layout');
const R = require('../diagram/repair');
const theme = require('../diagram/theme');

let n = 0;
function test(name, fn) { fn(); n++; console.log('  ok - ' + name); }

const gallery = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'diagrams', 'gallery.json'), 'utf8'));
const spec = (name) => R.prepare(gallery.find((g) => g.name === name).spec).spec;
const byId = (geo, id) => geo.nodes.find((x) => x.id === id);
const edge = (geo, from, to) => geo.edges.find((e) => e.from === from && e.to === to);
/** The hard rules. A label or a group's name that had to be backed is reported separately — it is legible, just not ideal. */
const HARD = (w) => w.cls !== 'label-collision' && w.cls !== 'shared-segment' && w.cls !== 'group-label-backed';
/** Does any connector run through this rectangle (with `pad` to spare)? Measured here, not asked of the layout. */
const lineThrough = (geo, rc, pad) => geo.edges.some((e) => e.points.some((p, i) => {
	const q = e.points[i + 1]; if (!q) { return false; }
	return !(Math.max(p.x, q.x) <= rc.x - pad || Math.min(p.x, q.x) >= rc.x + rc.w + pad || Math.max(p.y, q.y) <= rc.y - pad || Math.min(p.y, q.y) >= rc.y + rc.h + pad);
}));
const nameOf = (g) => ({ x: g.labelX, y: g.labelY, w: g.labelW, h: g.labelH });

test('EXAMPLE: the spec\'s routing flow — three ranks, the fork centred on its source, nothing flagged', () => {
	const geo = L.layout(spec('jev'));
	assert.deepStrictEqual(geo.warnings, []);
	assert.strictEqual(geo.direction, 'right');
	assert.strictEqual(geo.ranks, 3);
	assert.strictEqual(geo.crossings, 0);
	const inn = byId(geo, 'in'), jev = byId(geo, 'jev'), bill = byId(geo, 'bill'), rev = byId(geo, 'rev');
	assert.ok(inn.x + inn.w < jev.x && jev.x + jev.w < bill.x, 'the flow reads left to right');
	assert.strictEqual(inn.cy, jev.cy, 'a single connector is a straight line');
	assert.deepStrictEqual(edge(geo, 'in', 'jev').points.length, 2, 'in → jev has no bends');
	assert.ok(bill.cy < jev.cy && jev.cy < rev.cy, 'the two outcomes sit either side of the classifier');
	assert.ok(Math.abs((bill.cy + rev.cy) / 2 - jev.cy) < 0.01, 'and it is centred on them exactly');
	assert.ok(jev.accent && !inn.accent);
});

test('LABELS: an edge label sits BESIDE its line, clear of it, and nowhere near a box', () => {
	const geo = L.layout(spec('jev'));
	for (const e of geo.edges.filter((x) => x.label)) {
		assert.strictEqual(e.label.halo, false, 'no fallback needed');
		const last = e.points[e.points.length - 1], prev = e.points[e.points.length - 2];
		assert.strictEqual(prev.y, last.y, 'the run into the target is horizontal');
		assert.ok(e.label.y + e.label.h <= last.y - 3, 'the label is ABOVE that run with a clear gap, never on it');
		assert.ok(e.label.x >= Math.min(prev.x, last.x) && e.label.x + e.label.w <= Math.max(prev.x, last.x), 'and within its length');
		for (const node of geo.nodes) {
			const apart = e.label.x + e.label.w <= node.x || node.x + node.w <= e.label.x || e.label.y + e.label.h <= node.y || node.y + node.h <= e.label.y;
			assert.ok(apart, 'label "' + e.label.text + '" touches ' + node.id);
		}
	}
	assert.strictEqual(edge(geo, 'jev', 'bill').label.text, '0.90 or more');
});

test('GALLERY: every realistic diagram lays out with nothing flagged at all', () => {
	for (const g of gallery) {
		const p = R.prepare(g.spec);
		assert.ok(p.status === 'ok' || p.status === 'fixed', g.name + ' is a valid spec: ' + JSON.stringify(p.errors));
		const geo = L.layout(p.spec);
		assert.deepStrictEqual(geo.warnings, [], g.name);
		assert.strictEqual(geo.crossings, 0, g.name + ': these can all be drawn without a crossing');
		assert.ok(geo.width > 0 && geo.height > 0);
		assert.strictEqual(geo.nodes.length, p.spec.nodes.length);
		assert.strictEqual(geo.edges.length, p.spec.edges.length, g.name + ': every edge is drawn');
	}
});

test('GALLERY: …and at the widths a chat panel really has, where most of them turn downward', () => {
	for (const g of gallery) {
		for (const maxWidth of [560, 420, 320]) {
			const geo = L.layout(R.prepare(g.spec).spec, { maxWidth });
			assert.deepStrictEqual(geo.warnings, [], g.name + ' at ' + maxWidth + 'px (' + geo.direction + ')');
			for (const grp of geo.groups) { assert.strictEqual(lineThrough(geo, nameOf(grp), 2), false, g.name + ' at ' + maxWidth + 'px: a connector runs through the name of ' + grp.id); }
		}
	}
});

test('DETERMINISM: the same spec is the same picture, every time', () => {
	for (const g of gallery) {
		const a = L.layout(R.prepare(g.spec).spec), b = L.layout(R.prepare(g.spec).spec);
		assert.deepStrictEqual(a, b, g.name);
	}
});

test('DIRECTION: "down" is the same layout turned — ranks run top to bottom', () => {
	const s = spec('jev'); s.direction = 'down';
	const geo = L.layout(s);
	assert.deepStrictEqual(geo.warnings, []);
	assert.strictEqual(geo.direction, 'down');
	const inn = byId(geo, 'in'), jev = byId(geo, 'jev'), bill = byId(geo, 'bill'), rev = byId(geo, 'rev');
	assert.ok(inn.y + inn.h < jev.y && jev.y + jev.h < bill.y, 'the flow reads top to bottom');
	assert.strictEqual(inn.cx, jev.cx);
	assert.strictEqual(bill.cy, rev.cy, 'siblings share a row');
	assert.ok(Math.abs((bill.cx + rev.cx) / 2 - jev.cx) < 0.01);
	const e = edge(geo, 'in', 'jev');
	assert.deepStrictEqual([e.arrow.dx, e.arrow.dy], [0, 1], 'arrowheads point down the flow');
});

test('FIT: a flow too wide for the column is laid out downward instead — when that helps', () => {
	const chain = { title: 'T', direction: 'right', nodes: Array.from({ length: 8 }, (_, i) => ({ id: 'n' + i, label: 'Pipeline stage ' + (i + 1) })), edges: Array.from({ length: 7 }, (_, i) => ({ from: 'n' + i, to: 'n' + (i + 1) })) };
	const s = R.prepare(chain).spec;
	const wide = L.layout(s);
	assert.strictEqual(wide.direction, 'right');
	assert.strictEqual(wide.flipped, false);
	assert.ok(wide.width > 900, 'eight boxes in a row are wide: ' + wide.width);
	const fit = L.layout(s, { maxWidth: 480 });
	assert.strictEqual(fit.direction, 'down', '"Diagrams grow downward, never wider than the chat column"');
	assert.strictEqual(fit.flipped, true);
	assert.strictEqual(fit.asked, 'right', 'what the model asked for is still on record');
	assert.ok(fit.width <= 480, 'and now it fits: ' + fit.width);
	assert.deepStrictEqual(fit.warnings, []);
	assert.strictEqual(L.layout(s, { maxWidth: 4000 }).direction, 'right', 'no flip when it already fits');
	const down = Object.assign({}, s, { direction: 'down' });
	assert.strictEqual(L.layout(down, { maxWidth: 10 }).flipped, false, 'a downward flow is never turned sideways');
});

test('GROUPS: a frame holds its members with room for its label, and nested frames nest', () => {
	const geo = L.layout(spec('twelve'));
	assert.deepStrictEqual(geo.warnings, []);
	const frame = (id) => geo.groups.find((g) => g.id === id);
	const inside = (a, b, pad) => a.x >= b.x + pad && a.y >= b.y + pad && a.x + a.w <= b.x + b.w - pad && a.y + a.h <= b.y + b.h - pad;
	for (const node of geo.nodes) {
		if (!node.group) { continue; }
		assert.ok(inside(node, frame(node.group), theme.SPACE.groupInset - 0.01), node.id + ' sits ' + theme.SPACE.groupInset + 'px inside ' + node.group);
	}
	assert.ok(inside(frame('w'), frame('app'), theme.SPACE.groupInset - 0.01), 'Workers nests inside Application');
	assert.strictEqual(frame('w').parent, 'app');
	assert.strictEqual(frame('w').depth, 2);
	for (const g of geo.groups) {
		assert.ok(g.labelX >= g.x && g.labelY >= g.y, 'the label is in the top-left');
		assert.ok(g.labelX + g.labelW <= g.x + g.w, 'and fits: ' + g.id);
		for (const node of geo.nodes.filter((x) => x.group === g.id)) { assert.ok(node.y >= g.labelY + g.labelH, node.id + ' is below the label of ' + g.id); }
	}
	const stripe = byId(geo, 'ext');
	for (const g of geo.groups) { assert.ok(!(stripe.x < g.x + g.w && g.x < stripe.x + stripe.w && stripe.y < g.y + g.h && g.y < stripe.y + stripe.h), 'a node in no group is inside none'); }
});

test('GROUPS: a long group label widens its frame instead of spilling out of it', () => {
	const s = R.prepare({ title: 'T', groups: [{ id: 'g', label: 'A container with a long name' }], nodes: [{ id: 'a', label: 'A', group: 'g' }, { id: 'b', label: 'B' }], edges: [{ from: 'a', to: 'b' }] }).spec;
	for (const direction of ['right', 'down']) {
		const geo = L.layout(Object.assign({}, s, { direction }));
		assert.deepStrictEqual(geo.warnings, [], direction);
		const g = geo.groups[0];
		assert.ok(g.w >= g.labelW + 16, direction + ': frame ' + g.w + ' vs label ' + g.labelW);
	}
});

test('GROUP NAMES: a connector never runs through one — the name slides along its frame to a clear stretch', () => {
	// The architecture diagram, turned downward: the line into "Anthropic" comes in exactly where "Providers" would sit.
	const geo = L.layout(spec('arch'), { maxWidth: 420 });
	assert.strictEqual(geo.direction, 'down');
	const prov = geo.groups.find((g) => g.id === 'prov'), ext = geo.groups.find((g) => g.id === 'ext');
	const corner = (g) => g.x + theme.SPACE.groupInset - 4;
	assert.strictEqual(ext.labelX, corner(ext), 'a name nothing crosses stays in its corner');
	assert.ok(prov.labelX > corner(prov) + 10, 'the crossed one has moved along: ' + (prov.labelX - corner(prov)));
	// …to the NEAREST clear stretch — it starts just past the line that was in its way, not at the far end of the frame
	const into = edge(geo, 'reg', 'ant'), lineX = into.points[into.points.length - 1].x;
	assert.ok(prov.labelX - lineX >= 4 && prov.labelX - lineX <= 7, 'the name starts ' + (prov.labelX - lineX).toFixed(1) + 'px after the line into Anthropic');
	assert.ok(prov.labelX + prov.labelW < prov.x + prov.w - 60, 'with most of the frame still to its right');
	assert.ok(lineThrough(geo, { x: corner(prov), y: prov.labelY, w: prov.labelW, h: prov.labelH }, 2), 'and it had to — the corner has a line through it');
	for (const g of geo.groups) {
		assert.strictEqual(lineThrough(geo, nameOf(g), 2), false, g.id);
		assert.strictEqual(g.labelHalo, false, g.id + ' needs no backing');
		assert.ok(g.labelX >= g.x + 8 && g.labelX + g.labelW <= g.x + g.w - 8, g.id + ': the name is still inside its frame');
		assert.strictEqual(g.labelY, g.y + 7, 'and still on the top row');
		assert.ok(!('labelNeed' in g), 'working values are not part of the geometry');
	}
	// The same diagram left to right: lines come in through the side, the names are never in the way.
	const right = L.layout(spec('arch'));
	for (const g of right.groups) { assert.strictEqual(g.labelX, corner(g), g.id); }
});

test('GROUP NAMES: where the frame has no clear stretch, room is made — the line comes in beside the name — if that is cheap', () => {
	const one = (name, node) => R.prepare({ title: 'T', direction: 'down', groups: [{ id: 'g', label: name }], nodes: [{ id: 'top', label: 'Chat webview' }, { id: 'a', label: node, group: 'g' }, { id: 'b', label: 'Next', group: 'g' }], edges: [{ from: 'top', to: 'a' }, { from: 'a', to: 'b' }] }).spec;
	// A short name over a wide node: the line is already clear of it. Nothing to do.
	const easy = L.layout(one('Data', 'Redis'));
	assert.deepStrictEqual(easy.warnings, []);
	// A name longer than half its node, in a frame one node wide: no stretch is clear.
	const geo = L.layout(one('Extension host', 'agent.js'));
	assert.deepStrictEqual(geo.warnings, []);
	const g = geo.groups[0], into = edge(geo, 'top', 'a');
	const lineX = into.points[into.points.length - 1].x;
	assert.strictEqual(g.labelX, g.x + theme.SPACE.groupInset - 4, 'the name keeps its corner');
	assert.strictEqual(g.labelHalo, false);
	assert.ok(lineX >= g.labelX + g.labelW + 5, 'the line comes in ' + (lineX - g.labelX - g.labelW).toFixed(1) + 'px to the right of it');
	assert.strictEqual(lineThrough(geo, nameOf(g), 2), false);
	const a = byId(geo, 'a');
	assert.ok(Math.abs(lineX - a.cx) < 0.5 && Math.abs(into.points[0].x - lineX) < 0.5, 'and still drops straight into the middle of its node');
	// what it cost: the frame grew by less than the name is long
	const narrow = L.layout(one('E', 'agent.js'));
	assert.ok(g.w > narrow.groups[0].w && g.w < narrow.groups[0].w + g.labelW, 'frame ' + narrow.groups[0].w + ' → ' + g.w);
});

test('GROUP NAMES: room is made even when something stands to the left of the frame — and only for lines that come in through the top', () => {
	// A neighbour on the left, both fed from above: the frame cannot simply reach leftward for the room.
	const s1 = R.prepare({ title: 'T', direction: 'down', groups: [{ id: 'g', label: 'check Billing API' }], nodes: [{ id: 'top', label: 'Billing sessions' }, { id: 'gw', label: 'Gateway' }, { id: 'a', label: 'request Cache', group: 'g' }], edges: [{ from: 'top', to: 'gw' }, { from: 'top', to: 'a' }] }).spec;
	const geo = L.layout(s1);
	assert.deepStrictEqual(geo.warnings, []);
	const g = geo.groups[0], gw = byId(geo, 'gw'), into = edge(geo, 'top', 'a');
	assert.strictEqual(g.labelHalo, false);
	assert.ok(gw.x + gw.w + theme.SPACE.groupGap <= g.x + 0.01, 'the neighbour keeps its distance from the frame');
	assert.ok(into.points[into.points.length - 1].x >= g.labelX + g.labelW + 5, 'and the line still comes in beside the name');
	assert.strictEqual(lineThrough(geo, nameOf(g), 2), false);
	// A fork INSIDE the frame: those lines are nowhere near the name's row, so they spread under the name as usual.
	const s2 = R.prepare({ title: 'T', direction: 'down', groups: [{ id: 'g', label: 'Extension host' }], nodes: [{ id: 'top', label: 'Chat' }, { id: 'a', label: 'agent', group: 'g' }, { id: 'b1', label: 'One', group: 'g' }, { id: 'b2', label: 'Two', group: 'g' }], edges: [{ from: 'top', to: 'a' }, { from: 'a', to: 'b1' }, { from: 'a', to: 'b2' }] }).spec;
	const fork = L.layout(s2);
	assert.deepStrictEqual(fork.warnings, []);
	const fg = fork.groups[0], a = byId(fork, 'a'), b1 = byId(fork, 'b1'), b2 = byId(fork, 'b2');
	assert.ok(edge(fork, 'top', 'a').points[0].x >= fg.labelX + fg.labelW + 5, 'the line from outside comes in beside the name');
	assert.ok(b1.cx < fg.labelX + fg.labelW, 'while a child sits under the name: ' + b1.cx + ' < ' + (fg.labelX + fg.labelW));
	assert.ok(Math.abs((b1.cx + b2.cx) / 2 - a.cx) < 0.5, 'and the fork is still centred on its source');
});

test('GROUP NAMES: …and where it is not cheap, the name is backed instead: the line passes behind it, and the layout says so', () => {
	const s = R.prepare({ title: 'T', direction: 'down', groups: [{ id: 'g', label: 'A container with a long name' }], nodes: [{ id: 'top', label: 'Chat webview' }, { id: 'a', label: 'A', group: 'g' }], edges: [{ from: 'top', to: 'a' }] }).spec;
	const geo = L.layout(s);
	assert.deepStrictEqual(geo.warnings, [{ cls: 'group-label-backed', message: 'group g: a connector runs behind its name' }]);
	const g = geo.groups[0];
	assert.strictEqual(g.labelHalo, true);
	assert.strictEqual(g.labelX, g.x + theme.SPACE.groupInset - 4, 'it stays in its corner');
	assert.ok(lineThrough(geo, nameOf(g), 0), 'with the line behind it');
	// the picture is otherwise the one it would have been: a node is not shoved aside to free a long name
	const a = byId(geo, 'a');
	assert.ok(Math.abs((a.x + a.w / 2) - (g.x + g.w / 2)) < 1, 'the node is still centred in its frame');
	// the self-check would call an UNBACKED name with a line through it an error
	const lied = JSON.parse(JSON.stringify(geo)); lied.groups[0].labelHalo = false;
	assert.deepStrictEqual(L.inspect(lied).map((w) => w.cls), ['group-label-crossed']);
	assert.deepStrictEqual(L.inspect(geo), [], 'and a backed one is not');
});

test('GROUP NAMES: freeing a name never pushes a drawing that fitted its column out of it', () => {
	const s = R.prepare({ title: 'T', direction: 'down', groups: [{ id: 'g', label: 'Extension host' }], nodes: [{ id: 'top', label: 'Chat webview' }, { id: 'a', label: 'agent.js', group: 'g' }], edges: [{ from: 'top', to: 'a' }] }).spec;
	const free = L.layout(s);
	assert.strictEqual(free.groups[0].labelHalo, false, 'with room to spare the name is freed…');
	// …which made the drawing a little wider. A column that the narrower drawing fits and the wider one does not:
	const column = free.width - 4;
	const tight = L.layout(s, { maxWidth: column });
	assert.ok(tight.width <= column, 'the drawing fits: ' + tight.width + ' in ' + column);
	assert.strictEqual(tight.groups[0].labelHalo, true, 'and its name is backed instead');
	assert.deepStrictEqual(tight.warnings.map((w) => w.cls), ['group-label-backed']);
	assert.ok(free.width > tight.width);
	// a column wide enough for either: the freed name wins
	assert.strictEqual(L.layout(s, { maxWidth: free.width + 40 }).groups[0].labelHalo, false);
});

test('CYCLES: the edge that closes a loop is drawn running back, and its arrow still points the right way', () => {
	const s = R.prepare({ title: 'T', nodes: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }, { id: 'c', label: 'C' }], edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }, { from: 'c', to: 'a' }] }).spec;
	const geo = L.layout(s);
	assert.deepStrictEqual(geo.warnings.filter(HARD), []);
	assert.strictEqual(geo.ranks, 3, 'a → b → c still reads as three steps');
	const a = byId(geo, 'a'), c = byId(geo, 'c');
	assert.ok(a.x < c.x);
	const back = edge(geo, 'c', 'a');
	assert.strictEqual(back.back, true);
	assert.strictEqual(edge(geo, 'a', 'b').back, false);
	const tip = back.points[back.points.length - 1], start = back.points[0];
	assert.ok(Math.abs(start.x - c.x) < 0.01 || Math.abs(start.x - (c.x + c.w)) < 0.01, 'it leaves c');
	assert.ok(tip.x >= a.x - 0.01 && tip.x <= a.x + a.w + 0.01 && tip.y >= a.y && tip.y <= a.y + a.h, 'and its arrowhead lands on a');
	assert.deepStrictEqual([back.arrow.x, back.arrow.y], [tip.x, tip.y]);
});

test('SELF-LOOP: steps out of its node and back in, without touching anything else', () => {
	const geo = L.layout(spec('state'));
	assert.deepStrictEqual(geo.warnings, []);
	const loop = geo.edges.find((e) => e.loop);
	assert.strictEqual(loop.from, 'active'); assert.strictEqual(loop.to, 'active');
	const node = byId(geo, 'active');
	assert.ok(loop.points.length >= 4, 'a loop has corners');
	assert.ok(loop.points.some((p) => p.y < node.y - 4), 'it rises above the node');
	assert.strictEqual(loop.label.text, 'new turn');
	// two loops on one node do not draw on top of each other
	const two = L.layout(R.prepare({ title: 'T', nodes: [{ id: 'a', label: 'Worker' }], edges: [{ from: 'a', to: 'a', label: 'retry' }, { from: 'a', to: 'a', label: 'backoff' }] }).spec);
	assert.deepStrictEqual(two.warnings.filter((w) => w.cls === 'shared-segment'), []);
});

test('PORTS: connectors that share a side each get their own point on it — and the node grows if it must', () => {
	const fan = L.layout(spec('fan'));
	const router = byId(fan, 'r');
	const starts = fan.edges.filter((e) => e.from === 'r').map((e) => e.points[0]);
	assert.strictEqual(starts.length, 5);
	assert.strictEqual(new Set(starts.map((p) => p.y)).size, 5, 'five connectors, five ports');
	for (const p of starts) { assert.ok(Math.abs(p.x - (router.x + router.w)) < 0.01 && p.y > router.y && p.y < router.y + router.h, 'each on the side that faces the flow'); }
	const gaps = starts.map((p) => p.y).sort((a, b) => a - b).map((y, i, arr) => (i ? y - arr[i - 1] : null)).slice(1);
	assert.ok(gaps.every((g) => g >= 6 - 0.01), 'never closer than the minimum: ' + gaps.join(','));
	// a hub with more connectors than its side can hold gets taller rather than crowding them
	const hub = { title: 'T', nodes: [{ id: 'h', label: 'Hub' }].concat(Array.from({ length: 9 }, (_, i) => ({ id: 't' + i, label: 'T' + i }))), edges: Array.from({ length: 9 }, (_, i) => ({ from: 'h', to: 't' + i })) };
	const big = L.layout(R.prepare(hub).spec);
	assert.deepStrictEqual(big.warnings, []);
	assert.ok(byId(big, 'h').h > byId(big, 't0').h, 'the hub grew along its side');
});

test('MEASURE: the estimate used where there is no canvas errs WIDE, class by class — an emoji is wider than a CJK character', () => {
	// Regular weight at 11.5px, so the numbers are plain multiples of the em.
	const px = (t) => theme.approxMeasure(t, 'sub');
	assert.ok(px('i') < px('a') && px('a') < px('m'), 'narrow, ordinary and wide letters');
	assert.ok(px('7') > px('a') && px('A') > px('7'), 'digits and capitals are wider than lower case');
	assert.strictEqual(px('\u65e5'), 11.5, 'a CJK character is a full em');
	assert.strictEqual(px('\u{1f680}'), 12.7, 'an emoji is 1.1 em — the widest class, not lumped in with CJK');
	assert.ok(px('\u{1f680}') > px('\u65e5'));
	assert.strictEqual(px('\u{1f680}\u{1f680}'), 25.3, 'and it is ONE character, though it is two code units');
	assert.strictEqual(px('\u{20000}'), 12.7, 'anything else beyond the basic plane is measured the same generous way');
	assert.strictEqual(px(''), 0); assert.strictEqual(px(null), 0);
});

test('SHAPES: size comes from the measured text — and a connector stops ON a diamond\'s outline', () => {
	const double = (t, role) => theme.approxMeasure(t, role) * 2;
	const s = R.prepare({ title: 'T', nodes: [{ id: 'a', label: 'A fairly long label' }], edges: [] }).spec;
	const normal = L.layout(s).nodes[0], wide = L.layout(s, { measure: double }).nodes[0];
	assert.strictEqual(normal.w, Math.ceil(theme.approxMeasure('A fairly long label', 'name') + 2 * theme.BOX.padX), '"width from the measured longest line plus 24"');
	assert.ok(wide.w > normal.w * 1.6, 'a wider font makes a wider box, so text never overflows');
	const d = L.layout(spec('decision'));
	const q = byId(d, 'q');
	assert.strictEqual(q.shape, 'decision');
	for (const e of d.edges.filter((x) => x.from === 'q')) {
		const p = e.points[0];
		const onOutline = Math.abs(p.x - q.cx) / (q.w / 2) + Math.abs(p.y - q.cy) / (q.h / 2);
		assert.ok(Math.abs(onOutline - 1) < 0.02, 'the line leaves from the diamond\'s edge, not its bounding box (' + onOutline.toFixed(3) + ')');
	}
	for (const node of d.nodes) { for (const line of node.lines) { assert.ok(line.w <= node.w, node.id + ': "' + line.text + '" fits'); } }
});

test('SHAPES: a long decision label wraps to two lines so the diamond stays compact', () => {
	const one = L.layout(R.prepare({ title: 'T', nodes: [{ id: 'a', label: 'Valid?', shape: 'decision' }], edges: [] }).spec).nodes[0];
	const two = L.layout(R.prepare({ title: 'T', nodes: [{ id: 'a', label: 'Is the session still valid?', shape: 'decision' }], edges: [] }).spec).nodes[0];
	assert.strictEqual(one.lines.length, 1);
	assert.strictEqual(two.lines.length, 2);
	assert.strictEqual(two.lines.map((l) => l.text).join(' '), 'Is the session still valid?', 'no word is lost');
	assert.ok(two.w < theme.approxMeasure('Is the session still valid?', 'name') * 2, 'narrower than a one-line diamond would be');
});

test('NO EDGES: unconnected nodes make a tidy block, not one long line', () => {
	const s = R.prepare({ title: 'T', nodes: Array.from({ length: 9 }, (_, i) => ({ id: 'n' + i, label: 'Item ' + i })), edges: [] }).spec;
	const geo = L.layout(s);
	assert.deepStrictEqual(geo.warnings, []);
	assert.strictEqual(geo.ranks, 3, 'nine nodes → three by three');
	assert.ok(geo.width < 600 && geo.height < 300, geo.width + '×' + geo.height);
});

test('DEFENSIVE: a spec that slipped past validation still lays out — the edge to nowhere is just not drawn', () => {
	const geo = L.layout({ title: 'T', nodes: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B', group: 'nope' }], edges: [{ from: 'a', to: 'ghost' }, { from: 'a', to: 'b' }], groups: [{ id: 'x', label: 'X', parent: 'x' }] });
	assert.strictEqual(geo.edges.length, 1);
	assert.strictEqual(geo.groups.length, 0, 'an empty group draws nothing');
	assert.deepStrictEqual(geo.warnings, []);
	assert.doesNotThrow(() => L.layout({ title: 'T', nodes: [], edges: [] }));
});

// ---- a few thousand diagrams nobody would draw on purpose ----------------------------------------
function rng(seed) { let a = seed >>> 0; return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
const WORDS = ['Auth', 'API', 'Queue', 'Worker', 'Cache', 'Router', 'Billing', 'Search', 'Index', 'Parse', 'Validate', 'Render', 'Store', 'Notify', 'User', 'Admin', 'Gateway', 'Token', 'Session', 'Upload', 'the', 'of', 'request', 'response', 'check', 'retry', 'done', 'fail', 'ok', 'data'];
function words(r, maxChars) { let s = ''; const k = 1 + Math.floor(r() * 4); for (let i = 0; i < k; i++) { const w = WORDS[Math.floor(r() * WORDS.length)]; if ((s + ' ' + w).trim().length > maxChars) { break; } s = (s + ' ' + w).trim(); } return s || 'X'; }
/** A random VALID spec: any shapes, any groups (nested or not), forward edges, back edges, self-loops, duplicates, labels. */
function randomSpec(seed) {
	const r = rng(seed);
	const count = 1 + Math.floor(r() * 12);
	const shapes = ['box', 'box', 'box', 'decision', 'store', 'actor'];
	const groupCount = r() < 0.45 ? 1 + Math.floor(r() * 4) : 0;
	const groups = [];
	for (let g = 0; g < groupCount; g++) { const gr = { id: 'g' + g, label: words(r, 28) }; if (g > 0 && r() < 0.3 && !groups[g - 1].parent) { gr.parent = 'g' + (g - 1); } groups.push(gr); }
	const accent = r() < 0.7 ? Math.floor(r() * count) : -1;
	const nodes = [];
	for (let i = 0; i < count; i++) {
		const nd = { id: 'n' + i, label: words(r, 28) };
		if (r() < 0.4) { nd.sub = words(r, 32); }
		const sh = shapes[Math.floor(r() * shapes.length)]; if (sh !== 'box') { nd.shape = sh; }
		if (i === accent) { nd.accent = true; }
		if (groupCount && r() < 0.6) { nd.group = 'g' + Math.floor(r() * groupCount); }
		if (r() < 0.15) { nd.link = { path: 'src/a.js', line: 3 }; }
		nodes.push(nd);
	}
	const edges = [];
	const m = Math.floor(r() * Math.min(18, count * 1.8));
	for (let k = 0; k < m; k++) {
		let a = Math.floor(r() * count), b = Math.floor(r() * count);
		if (r() < 0.75 && a > b) { const t = a; a = b; b = t; }
		if (a === b && r() > 0.12) { b = (a + 1) % count; }
		const e = { from: 'n' + a, to: 'n' + b };
		if (r() < 0.35) { e.label = words(r, 20); }
		if (r() < 0.2) { e.style = 'dashed'; }
		edges.push(e);
	}
	const out = { v: 1, title: words(r, 60), direction: r() < 0.5 ? 'right' : 'down', nodes, edges };
	if (groups.length) { out.groups = groups; }
	return out;
}

const FUZZ = Number(process.env.DIAGRAM_FUZZ || 1500);
test('PROPERTY: ' + FUZZ + ' random specs — no overlap, no line through a box, nothing out of frame, frames intact', () => {
	const soft = { 'label-collision': 0, 'shared-segment': 0, 'group-label-backed': 0 };
	let flagged = 0, worst = 0, backedNames = 0, grouped = 0;
	for (let seed = 1; seed <= FUZZ; seed++) {
		const p = R.prepare(randomSpec(seed), { final: true });
		assert.ok(p.spec, 'seed ' + seed + ' did not prepare');
		const t0 = process.hrtime.bigint();
		const geo = L.layout(p.spec);
		worst = Math.max(worst, Number(process.hrtime.bigint() - t0) / 1e6);
		const hard = geo.warnings.filter(HARD);
		assert.deepStrictEqual(hard, [], 'seed ' + seed + ' (' + geo.direction + ')');
		assert.strictEqual(geo.edges.length, p.spec.edges.length, 'seed ' + seed + ': every edge is drawn');
		for (const e of geo.edges) { assert.ok(e.points.length >= 2 && e.points.every((pt) => Number.isFinite(pt.x) && Number.isFinite(pt.y)), 'seed ' + seed + ': edge ' + e.index + ' has a route'); }
		const seen = new Set();
		for (const w of geo.warnings.filter((x) => !HARD(x))) { soft[w.cls]++; seen.add(w.cls); }
		if (seen.has('label-collision')) { flagged++; }
		if (geo.groups.length) { grouped++; }
		if (seen.has('group-label-backed')) { backedNames++; }
		// measured here rather than taken from the layout's own check: no connector through an unbacked name
		for (const g of geo.groups) { if (!g.labelHalo) { assert.strictEqual(lineThrough(geo, nameOf(g), 1), false, 'seed ' + seed + ': a connector runs through the name of ' + g.id); } }
	}
	// The soft findings are known limits, bounded here so they cannot quietly get worse:
	//   label-collision     a label with no clear spot falls back to a halo (dense fan-ins, mostly when the flow runs down)
	//   shared-segment      two connectors that swap lanes exactly cannot both be straight
	//   group-label-backed  a group's name with no clear stretch in its frame has a connector pass behind it
	assert.ok(grouped > FUZZ / 4, 'the fuzz still exercises groups: ' + grouped);
	assert.ok(backedNames / grouped <= 0.10, 'backed group names in ' + (100 * backedNames / grouped).toFixed(1) + '% of specs with groups (limit 10%)');
	assert.ok(flagged / FUZZ <= 0.09, 'label fallbacks in ' + (100 * flagged / FUZZ).toFixed(1) + '% of specs (limit 9%)');
	assert.ok(soft['shared-segment'] / FUZZ <= 0.005, 'lane swaps in ' + (100 * soft['shared-segment'] / FUZZ).toFixed(2) + '% of specs (limit 0.5%)');
	assert.ok(worst < 200, 'slowest layout ' + worst.toFixed(1) + ' ms — the spec budgets 200 ms for layout');
});

test('SPEED: a full twelve-node diagram lays out in a few milliseconds (budget: 200 ms)', () => {
	const s = spec('twelve');
	L.layout(s);   // warm up
	const times = [];
	for (let i = 0; i < 40; i++) { const t0 = process.hrtime.bigint(); L.layout(s); times.push(Number(process.hrtime.bigint() - t0) / 1e6); }
	times.sort((a, b) => a - b);
	const p95 = times[Math.floor(times.length * 0.95)];
	assert.ok(p95 < 50, 'p95 ' + p95.toFixed(2) + ' ms');
});

console.log('diagramLayout: ' + n + ' tests passed');
