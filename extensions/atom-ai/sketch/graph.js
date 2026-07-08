/*---------------------------------------------------------------------------------------------
 *  LevelCode — Agent Sketch · pure graph logic  [SK1]
 *
 *  The sketch is a DAG: nodes are agent instances ({id, agentId, label?, instructions?, model?,
 *  x, y}), edges are directed handoffs ({from, to} node ids) — the output text of `from` becomes
 *  part of the input context of `to`. Everything here is PURE and unit-tested (test/sketch.test.js);
 *  the runner in sketch.js walks the levels this module computes.
 *
 *  Execution model (ruflo-style): Kahn topological LEVELS — all nodes in a level have their
 *  dependencies satisfied and run IN PARALLEL; levels run in sequence. A chain runs sequentially,
 *  a fan-out runs concurrently, a fan-in (coordinator) waits for all inputs.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

/**
 * Validate a sketch graph. Returns { ok:true } or { ok:false, error } with a human message.
 * Checks: at least one node, edge endpoints exist, no self-loops, no duplicate edges, no cycles.
 */
function validateGraph(nodes, edges) {
	nodes = nodes || []; edges = edges || [];
	if (!nodes.length) { return { ok: false, error: 'The sketch is empty — add at least one agent.' }; }
	const ids = new Set(nodes.map((n) => n.id));
	if (ids.size !== nodes.length) { return { ok: false, error: 'Duplicate node ids in the sketch.' }; }
	const seen = new Set();
	for (const e of edges) {
		if (!ids.has(e.from) || !ids.has(e.to)) { return { ok: false, error: 'An edge points at a node that no longer exists.' }; }
		if (e.from === e.to) { return { ok: false, error: 'An agent can’t hand off to itself.' }; }
		const k = e.from + '→' + e.to;
		if (seen.has(k)) { return { ok: false, error: 'Duplicate connection between the same two agents.' }; }
		seen.add(k);
	}
	if (findCycle(nodes, edges)) { return { ok: false, error: 'The flow has a cycle — agent handoffs must go forward only (a DAG).' }; }
	return { ok: true };
}

/** True if the directed graph contains a cycle (iterative DFS, colors). */
function findCycle(nodes, edges) {
	const adj = new Map(nodes.map((n) => [n.id, []]));
	for (const e of edges) { adj.get(e.from).push(e.to); }
	const state = new Map(); // 0 unseen, 1 in-stack, 2 done
	for (const n of nodes) {
		if (state.get(n.id)) { continue; }
		const stack = [[n.id, 0]];
		while (stack.length) {
			const top = stack[stack.length - 1];
			const [id] = top;
			if (top[1] === 0) { state.set(id, 1); }
			const kids = adj.get(id);
			if (top[1] < kids.length) {
				const next = kids[top[1]++];
				const s = state.get(next) || 0;
				if (s === 1) { return true; }
				if (s === 0) { stack.push([next, 0]); }
			} else {
				state.set(id, 2);
				stack.pop();
			}
		}
	}
	return false;
}

/**
 * Kahn topological LEVELS: [[roots...], [next wave...], ...]. All nodes in one level can run
 * in parallel; each level only depends on earlier ones. Assumes validateGraph passed (a DAG).
 * @returns {string[][]} levels of node ids
 */
function topoLevels(nodes, edges) {
	const indeg = new Map(nodes.map((n) => [n.id, 0]));
	const adj = new Map(nodes.map((n) => [n.id, []]));
	for (const e of edges) { adj.get(e.from).push(e.to); indeg.set(e.to, indeg.get(e.to) + 1); }
	let frontier = nodes.map((n) => n.id).filter((id) => indeg.get(id) === 0);
	const levels = [];
	const done = new Set();
	while (frontier.length) {
		levels.push(frontier);
		const next = [];
		for (const id of frontier) {
			done.add(id);
			for (const kid of adj.get(id)) {
				indeg.set(kid, indeg.get(kid) - 1);
				if (indeg.get(kid) === 0) { next.push(kid); }
			}
		}
		frontier = next;
	}
	if (done.size !== nodes.length) { throw new Error('topoLevels called on a cyclic graph — validate first.'); }
	return levels;
}

/** Direct upstream node ids of `id` (whose outputs feed it), in edge order. */
function upstreamOf(id, edges) {
	return (edges || []).filter((e) => e.to === id).map((e) => e.from);
}

/**
 * Build the user message for one node's turn: the shared goal + each upstream agent's output.
 * Pure; outputs is a Map<nodeId, {label, text}>.
 */
function buildNodeInput(goal, node, edges, outputs) {
	const parts = [];
	if (goal && goal.trim()) { parts.push('Overall goal of this flow:\n' + goal.trim()); }
	const ups = upstreamOf(node.id, edges);
	for (const upId of ups) {
		const out = outputs.get(upId);
		if (!out) { continue; }
		parts.push('Output from the upstream agent "' + out.label + '":\n' + (out.text || '(no output)'));
	}
	if (node.instructions && node.instructions.trim()) {
		parts.push('Your specific task in this flow:\n' + node.instructions.trim());
	}
	if (!parts.length) { parts.push('Perform your role for this flow.'); }
	return parts.join('\n\n---\n\n');
}

/**
 * Sum usage across nodes: Map<nodeId, {input,output}> → {input, output}.
 */
function totalUsage(usageByNode) {
	let input = 0, output = 0;
	for (const u of usageByNode.values()) { input += u.input || 0; output += u.output || 0; }
	return { input, output };
}

module.exports = { validateGraph, findCycle, topoLevels, upstreamOf, buildNodeInput, totalUsage };
