/*---------------------------------------------------------------------------------------------
 *  LevelCode — AI · rich diagrams · a diagram as words  (docs/RICH-DIAGRAMS.md, "UX" + "Context budget")
 *
 *  Three text forms of one spec, each for a reader a picture cannot serve:
 *
 *    outline(spec)    a screen reader. The nodes and the connections, in the order the model wrote
 *                     them, as sentences — carried next to the picture so the diagram has an
 *                     accessible name AND a description that says what it shows.
 *    stub(record)     the model, later. "diagram: Jev routing, 4 nodes, id d-17" — the one line that
 *                     stands in for a spec once the conversation is compacted.
 *    toMermaid(spec)  another tool. A flowchart GitHub, GitLab and most docs sites render natively —
 *                     what "Open as Mermaid" and "Insert into Markdown" produce, and what a session
 *                     exported to Markdown carries in place of the picture.
 *
 *  All three read the full text of a label that was shortened for display (`tip`), because none of
 *  them has a tooltip to hover.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
(function (root, factory) {
	'use strict';
	if (typeof module === 'object' && module.exports) { module.exports = factory(); }
	else { (root.LCDiagram = root.LCDiagram || {}).text = factory(); }
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
	'use strict';

	const arr = (v) => (Array.isArray(v) ? v : []);
	const SHAPE_WORD = { decision: 'decision', store: 'data store', actor: 'actor' };

	/** A node's name as it should be READ: the full label and second line, not the shortened ones. */
	function nodeName(n) {
		if (n.tip) { return String(n.tip); }
		return n.sub ? n.label + ' — ' + n.sub : String(n.label);
	}
	const shortName = (n) => String(n.tip ? String(n.tip).split(' — ')[0] : n.label);

	/**
	 * The screen-reader outline.
	 * @returns {{ title: string, summary: string, nodes: string[], edges: string[], text: string }}
	 */
	function outline(spec) {
		const nodes = arr(spec && spec.nodes), edges = arr(spec && spec.edges), groups = arr(spec && spec.groups);
		const byId = new Map(nodes.map((n) => [n.id, n]));
		const groupLabel = new Map(groups.map((g) => [g.id, g.tip || g.label]));
		const nodeLines = nodes.map((n) => {
			const bits = [nodeName(n)];
			if (SHAPE_WORD[n.shape]) { bits.push(SHAPE_WORD[n.shape]); }
			if (n.group && groupLabel.has(n.group)) { bits.push('in ' + groupLabel.get(n.group)); }
			if (n.accent) { bits.push('highlighted'); }
			if (n.link && n.link.path) { bits.push('opens ' + n.link.path); }
			return bits.join(', ');
		});
		const edgeLines = edges.filter((e) => byId.has(e.from) && byId.has(e.to)).map((e) => {
			const label = e.tip || e.label;
			return shortName(byId.get(e.from)) + ' to ' + shortName(byId.get(e.to)) + (label ? ', ' + label : '') + (e.style === 'dashed' ? ' (dashed)' : '');
		});
		const count = (k, one, many) => k + ' ' + (k === 1 ? one : many);
		const title = String((spec && (spec.tip || spec.title)) || 'Diagram');
		const summary = count(nodeLines.length, 'node', 'nodes') + ', ' + count(edgeLines.length, 'connection', 'connections') + '.';
		const text = title + '. ' + summary
			+ (nodeLines.length ? ' Nodes: ' + nodeLines.join('; ') + '.' : '')
			+ (edgeLines.length ? ' Connections: ' + edgeLines.join('; ') + '.' : '');
		return { title, summary, nodes: nodeLines, edges: edgeLines, text };
	}

	/**
	 * The one-line stand-in for a diagram once its spec has left the conversation.
	 * @param {{ id: string, spec: any }} record
	 */
	function stub(record) {
		const spec = (record && record.spec) || {};
		const k = arr(spec.nodes).length;
		// One line, always: the title is the only free text in it, so that is where a newline could hide.
		const title = String(spec.title || 'untitled').replace(/\s+/g, ' ').trim();
		return 'diagram: ' + title + ', ' + k + ' node' + (k === 1 ? '' : 's') + ', id ' + String((record && record.id) || '?');
	}

	// ---- Mermaid ------------------------------------------------------------------------------------
	// The source is written to be pasted somewhere else, so it is written defensively: every label is
	// quoted and entity-escaped, and ids are rewritten wherever Mermaid would read them as something
	// else — `end` closes a subgraph, and a leading digit or a hyphen is not an id at all.
	const RESERVED = new Set(['end', 'subgraph', 'graph', 'flowchart', 'class', 'classdef', 'click', 'style', 'linkstyle', 'default', 'direction', 'call', 'href', 'interpolate']);
	const mmText = (s) => String(s).replace(/&/g, '#amp;').replace(/"/g, '#quot;').replace(/</g, '#lt;').replace(/>/g, '#gt;').replace(/[\r\n]+/g, ' ');

	/** Map every node and group id to one Mermaid accepts, keeping them readable and unique. */
	function mermaidIds(ids) {
		const used = new Set(), out = new Map();
		for (const id of ids) {
			let m = String(id).replace(/[^A-Za-z0-9_]/g, '_');
			if (!m || /^[0-9_]/.test(m) || RESERVED.has(m.toLowerCase())) { m = 'n_' + m; }
			let k = 2, candidate = m;
			while (used.has(candidate)) { candidate = m + '_' + (k++); }
			used.add(candidate); out.set(id, candidate);
		}
		return out;
	}

	/**
	 * The spec as a Mermaid flowchart.
	 * @param {any} spec
	 * @param {{ title?: boolean }} [opts]  title: emit the spec's title as Mermaid front matter (default true)
	 */
	function toMermaid(spec, opts) {
		const nodes = arr(spec && spec.nodes), edges = arr(spec && spec.edges), groups = arr(spec && spec.groups);
		const ids = mermaidIds(nodes.map((n) => n.id).concat(groups.map((g) => 'group:' + g.id)));
		const gid = (id) => ids.get('group:' + id);
		const lines = [];
		if ((!opts || opts.title !== false) && spec && spec.title) {
			lines.push('---', 'title: ' + JSON.stringify(String(spec.tip || spec.title)), '---');
		}
		lines.push('flowchart ' + (spec && spec.direction === 'down' ? 'TD' : 'LR'));
		const shape = (n) => {
			const label = '"' + mmText(n.tip ? String(n.tip).replace(' — ', '<br/>') : (n.sub ? n.label + '<br/>' + n.sub : n.label)).replace(/#lt;br\/#gt;/g, '<br/>') + '"';
			const id = ids.get(n.id);
			if (n.shape === 'decision') { return id + '{' + label + '}'; }
			if (n.shape === 'store') { return id + '[(' + label + ')]'; }
			if (n.shape === 'actor') { return id + '([' + label + '])'; }
			return id + '[' + label + ']';
		};
		const groupIds = new Set(groups.map((g) => g.id));
		const emitGroup = (g, depth) => {
			const pad = '  '.repeat(depth);
			lines.push(pad + 'subgraph ' + gid(g.id) + '["' + mmText(g.tip || g.label) + '"]');
			for (const n of nodes) { if (n.group === g.id) { lines.push(pad + '  ' + shape(n)); } }
			for (const k of groups) { if (k.parent === g.id && k.id !== g.id) { emitGroup(k, depth + 1); } }
			lines.push(pad + 'end');
		};
		for (const n of nodes) { if (!n.group || !groupIds.has(n.group)) { lines.push('  ' + shape(n)); } }
		for (const g of groups) { if (!g.parent || !groupIds.has(g.parent) || g.parent === g.id) { emitGroup(g, 1); } }
		for (const e of edges) {
			if (!ids.has(e.from) || !ids.has(e.to)) { continue; }
			const label = e.tip || e.label;
			lines.push('  ' + ids.get(e.from) + (e.style === 'dashed' ? ' -.->' : ' -->') + (label ? '|"' + mmText(label) + '"| ' : ' ') + ids.get(e.to));
		}
		const accent = nodes.filter((n) => n.accent).map((n) => ids.get(n.id));
		if (accent.length) { lines.push('  classDef accent stroke-width:2px', '  class ' + accent.join(',') + ' accent'); }
		return lines.join('\n') + '\n';
	}

	/** The spec as it should be shown or copied: stable key order, two-space indent, no renderer-only fields. */
	function toSource(spec) {
		const strip = (o) => { const c = Object.assign({}, o); delete c.tip; return c; };
		const clean = Object.assign({}, spec);
		delete clean.tip;
		if (Array.isArray(clean.nodes)) { clean.nodes = clean.nodes.map(strip); }
		if (Array.isArray(clean.edges)) { clean.edges = clean.edges.map(strip); }
		if (Array.isArray(clean.groups)) { clean.groups = clean.groups.map(strip); }
		return JSON.stringify(clean, null, 2);
	}

	return { outline, stub, toMermaid, toSource, mermaidIds, nodeName };
}));
