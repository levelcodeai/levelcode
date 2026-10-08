/*---------------------------------------------------------------------------------------------
 *  LevelCode — AI · rich diagrams · layered validation  (docs/RICH-DIAGRAMS.md, "Validation and repair")
 *
 *  THE ONE GATE. Every spec — whichever model wrote it, whether it arrived a second ago or was read
 *  back from a session saved last month — passes through validate() before anything lays it out.
 *  That is what keeps the quality of a diagram independent of the model that asked for it.
 *
 *  Layers, cheapest first:
 *    version    `v` names a schema this editor still reads (migrate() lifts old ones forward)
 *    schema     fields, types, enums, lengths, counts — schema.check(), driven by the wire schema
 *    semantics  the things a schema cannot say: edge ends exist, ids are unique, one accent at most,
 *               groups nest two deep and never in a circle
 *
 *  EVERY error comes back at once, each as  <JSON Pointer>: <what was expected + the valid options>.
 *  A model handed "unknown node" has to guess; handed the list of known ids it only has to look.
 *
 *  Pure, synchronous, dependency-free — it runs in the extension host (the tool result) and again in
 *  the webview (the renderer refuses anything this rejects).
 *--------------------------------------------------------------------------------------------*/
// @ts-check
(function (root, factory) {
	'use strict';
	if (typeof module === 'object' && module.exports) { module.exports = factory(require('./schema')); }
	else { (root.LCDiagram = root.LCDiagram || {}).validate = factory(root.LCDiagram.schema); }
}(typeof globalThis !== 'undefined' ? globalThis : this, function (schema) {
	'use strict';

	const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
	const q = (s) => JSON.stringify(String(s));
	/** "a, b, c" — capped, so one error line can never carry a whole oversized spec back to the model. */
	function listIds(ids, max) {
		const cap = max || 16;
		const shown = ids.slice(0, cap).join(', ');
		return ids.length > cap ? shown + ', … (' + (ids.length - cap) + ' more)' : (shown || '(none)');
	}

	/**
	 * Lift a spec written against an older schema to the current one. Today there is only v1, so
	 * this is the identity — but it is the single place a future v2 teaches the editor to keep
	 * reading v1, and render paths call it so that promise is exercised from day one.
	 * A spec with no `v` at all is read as v1 (the tool marks the field optional).
	 */
	function migrate(spec) {
		if (!isObj(spec)) { return spec; }
		if (spec.v === undefined) { return Object.assign({ v: 1 }, spec); }
		return spec;
	}

	/**
	 * The group each group id sits in, walking `parent` links. Returns { depth, cycle } per id.
	 * Depth 1 = a top-level group. A cycle is reported once, on every member of it.
	 */
	function groupDepths(groups) {
		const byId = new Map();
		for (const g of groups) { if (isObj(g) && typeof g.id === 'string' && !byId.has(g.id)) { byId.set(g.id, g); } }
		const out = new Map();
		for (const id of byId.keys()) {
			let depth = 1, cur = byId.get(id), cycle = false;
			const seen = new Set([id]);
			while (cur && typeof cur.parent === 'string' && byId.has(cur.parent)) {
				if (seen.has(cur.parent)) { cycle = true; break; }
				seen.add(cur.parent);
				cur = byId.get(cur.parent);
				depth++;
			}
			out.set(id, { depth, cycle });
		}
		return out;
	}

	/** The semantic layer. Assumes nothing about shape — it skips whatever the schema layer already flagged. */
	function checkSemantics(spec, errors, limits) {
		const nodes = Array.isArray(spec.nodes) ? spec.nodes : [];
		const edges = Array.isArray(spec.edges) ? spec.edges : [];
		const groups = Array.isArray(spec.groups) ? spec.groups : [];

		// ids are unique
		const firstAt = new Map();
		const ids = [];
		nodes.forEach((n, i) => {
			if (!isObj(n) || typeof n.id !== 'string') { return; }
			if (firstAt.has(n.id)) {
				errors.push({ pointer: '/nodes/' + i + '/id', cls: 'duplicate-id', message: 'duplicate id ' + q(n.id) + ' (already used by /nodes/' + firstAt.get(n.id) + '). Every node needs its own id.' });
			} else { firstAt.set(n.id, i); ids.push(n.id); }
		});

		// one accent at most
		const accented = nodes.filter((n) => isObj(n) && n.accent === true).map((n) => String(n.id));
		if (accented.length > 1) {
			errors.push({ pointer: '/nodes', cls: 'accent-count', message: accented.length + ' nodes have accent=true, max 1 (' + listIds(accented) + '). Keep it on the node the title is about.' });
		}

		// groups: unique ids, parents exist, no cycles, depth within the limit
		const groupAt = new Map();
		const groupIds = [];
		groups.forEach((g, i) => {
			if (!isObj(g) || typeof g.id !== 'string') { return; }
			if (groupAt.has(g.id)) {
				errors.push({ pointer: '/groups/' + i + '/id', cls: 'duplicate-id', message: 'duplicate group id ' + q(g.id) + ' (already used by /groups/' + groupAt.get(g.id) + ').' });
			} else { groupAt.set(g.id, i); groupIds.push(g.id); }
		});
		const depths = groupDepths(groups);
		groups.forEach((g, i) => {
			if (!isObj(g) || typeof g.id !== 'string' || groupAt.get(g.id) !== i) { return; }
			if (typeof g.parent === 'string') {
				if (g.parent === g.id) {
					errors.push({ pointer: '/groups/' + i + '/parent', cls: 'group-cycle', message: 'a group cannot contain itself. Remove "parent" or name another group.' });
					return;
				}
				if (!groupAt.has(g.parent)) {
					errors.push({ pointer: '/groups/' + i + '/parent', cls: 'unknown-group', message: 'unknown group ' + q(g.parent) + '. Known groups: ' + listIds(groupIds) + '.' });
					return;
				}
			}
			const d = depths.get(g.id);
			if (d && d.cycle) {
				errors.push({ pointer: '/groups/' + i + '/parent', cls: 'group-cycle', message: 'groups contain each other in a circle (' + q(g.id) + ' → ' + q(g.parent) + ' → …). Nesting must be a tree.' });
			} else if (d && d.depth > limits.groupDepth) {
				errors.push({ pointer: '/groups/' + i + '/parent', cls: 'group-depth', message: 'nested ' + d.depth + ' deep, max ' + limits.groupDepth + '. Flatten it.' });
			}
		});
		nodes.forEach((n, i) => {
			if (isObj(n) && typeof n.group === 'string' && !groupAt.has(n.group)) {
				errors.push({ pointer: '/nodes/' + i + '/group', cls: 'unknown-group', message: 'unknown group ' + q(n.group) + '. Known groups: ' + listIds(groupIds) + '.' });
			}
		});

		// each end of an edge names an existing node
		edges.forEach((e, i) => {
			if (!isObj(e)) { return; }
			for (const end of ['from', 'to']) {
				if (typeof e[end] === 'string' && !firstAt.has(e[end])) {
					errors.push({ pointer: '/edges/' + i + '/' + end, cls: 'unknown-node', message: 'unknown node ' + q(e[end]) + '. Known ids: ' + listIds(ids) + '.' });
				}
			}
		});
	}

	/**
	 * Validate a parsed spec.
	 * @param {any} spec
	 * @param {{ tier?: 'house'|'hard' }} [opts]  `house` (default) is what the model is held to; `hard`
	 *        is what the renderer accepts — see schema.js.
	 * @returns {{ ok: boolean, errors: Array<{pointer:string, cls:string, message:string}> }}
	 */
	function validate(spec, opts) {
		const tier = opts && opts.tier === 'hard' ? 'hard' : 'house';
		/** @type {Array<{pointer:string, cls:string, message:string}>} */
		const errors = [];
		if (!isObj(spec)) {
			errors.push({ pointer: '', cls: 'type', message: 'expected an object with "title", "nodes" and "edges", got ' + schema.typeOf(spec) + '.' });
			return { ok: false, errors };
		}
		const v = spec.v === undefined ? schema.VERSION : spec.v;
		const known = schema.schemaFor(v);
		if (!known) {
			errors.push({ pointer: '/v', cls: 'version', message: 'unknown schema version ' + JSON.stringify(spec.v) + '. This editor reads: ' + schema.KNOWN_VERSIONS.join(', ') + '.' });
			return { ok: false, errors };
		}
		schema.check(known[tier], spec, '', errors);
		checkSemantics(spec, errors, tier === 'hard' ? schema.HARD : schema.HOUSE);
		return { ok: errors.length === 0, errors };
	}

	/** One error as the line the model (and the details popover) reads. */
	function formatError(e) { return (e.pointer || '/') + ': ' + e.message; }
	/** Every error, one per line — the spec's "Error format". */
	function formatErrors(errors) { return (errors || []).map(formatError).join('\n'); }
	/** Error classes with counts — what telemetry records (classes, never the text). */
	function errorClasses(errors) {
		const out = {};
		for (const e of (errors || [])) { out[e.cls] = (out[e.cls] || 0) + 1; }
		return out;
	}

	return { validate, migrate, groupDepths, formatError, formatErrors, errorClasses, listIds };
}));
