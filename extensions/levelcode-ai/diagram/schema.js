/*---------------------------------------------------------------------------------------------
 *  LevelCode — AI · rich diagrams · the Graph JSON schema  (docs/RICH-DIAGRAMS.md, "Diagram spec")
 *
 *  The model describes STRUCTURE only — nodes, edges, groups and one accent. It never sets
 *  coordinates, colours or font sizes, so it cannot violate the style guide; the renderer owns those.
 *
 *  This file is the single definition of what a spec may contain. The SAME object is:
 *    • sent to the model as `render_diagram`'s input schema (diagram/tool.js), and
 *    • interpreted here to validate every spec that comes back (check()),
 *  so the contract the model is shown and the contract it is held to cannot drift apart.
 *
 *  Two tiers of limits, deliberately:
 *    HOUSE — what the model is asked for (12 nodes, 28-char labels …). Breaking one is an error the
 *            repair ladder deals with.
 *    HARD  — what the renderer will ever accept, even from a degraded spec. These exist because a
 *            spec is untrusted input: they bound layout time and DOM size no matter what arrives.
 *
 *  Versioned: `v` names the schema a spec was written against, and SCHEMAS keeps every version this
 *  editor can still read, so a chat saved today renders after the schema moves on (NFR-4).
 *--------------------------------------------------------------------------------------------*/
// @ts-check
(function (root, factory) {
	'use strict';
	if (typeof module === 'object' && module.exports) { module.exports = factory(); }
	else { (root.LCDiagram = root.LCDiagram || {}).schema = factory(); }
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
	'use strict';

	/** The schema version new specs are written against. */
	const VERSION = 1;

	const SHAPES = ['box', 'decision', 'store', 'actor'];
	const DIRECTIONS = ['right', 'down'];
	const EDGE_STYLES = ['solid', 'dashed'];
	/** "Lowercase slug": starts alphanumeric, then letters, digits, `_` or `-`. */
	const ID_RE = /^[a-z0-9][a-z0-9_-]*$/;
	const ID_PATTERN = '^[a-z0-9][a-z0-9_-]*$';

	/** What the model is asked for — the numbers in the spec's field tables. */
	const HOUSE = Object.freeze({
		title: 80, label: 28, sub: 32, edgeLabel: 20, groupLabel: 28,
		nodesMin: 1, nodesMax: 12, groupDepth: 2,
		// Not in the field tables, but a spec is untrusted and these have to be SOME number. Chosen
		// so no diagram that respects the 12-node cap can run into them.
		edgesMax: 30, groupsMax: 8, id: 32, path: 260, symbol: 80
	});
	/**
	 * What the renderer accepts at all. A degraded spec may exceed a HOUSE count (it is drawn anyway,
	 * under a banner) but never these; text limits do not relax, because truncation always applies.
	 */
	const HARD = Object.freeze(Object.assign({}, HOUSE, { nodesMax: 24, edgesMax: 48, groupsMax: 12, tip: 400 }));

	/**
	 * Build the JSON Schema for one tier.
	 *
	 * `house` is the wire schema — plain JSON Schema with nothing a provider could reject (no custom
	 * keywords, no `additionalProperties`: a model that adds a stray field is tidied, not failed).
	 * `v` is deliberately not in it: the version is checked by validate() before any schema is
	 * chosen, and a model writing a new spec never needs to state it.
	 * `hard` is the render-ready shape: the same fields under the HARD limits, plus `tip` — the full
	 * text of a label the auto-fixer had to truncate, which the renderer shows as a tooltip. `tip` is
	 * ours; the model is never told about it.
	 * @param {'house'|'hard'} tier
	 */
	function build(tier) {
		const L = tier === 'hard' ? HARD : HOUSE;
		const hard = tier === 'hard';
		const tip = hard ? { tip: { type: 'string', maxLength: HARD.tip } } : {};
		// Only a DECLARED id carries the slug rule. A reference (an edge end, a node's group, a group's
		// parent) needs no rule of its own: the semantic layer requires it to equal a declared id, so it
		// is a slug or it is an error either way — and every keyword here is paid for on each request.
		const id = { type: 'string', maxLength: L.id, pattern: ID_PATTERN };
		const ref = { type: 'string' };
		return {
			type: 'object',
			properties: Object.assign({
				title: { type: 'string', minLength: 1, maxLength: L.title, description: 'The takeaway, not the topic.' },
				direction: { type: 'string', enum: DIRECTIONS, description: 'Default right.' },
				nodes: {
					type: 'array', minItems: L.nodesMin, maxItems: L.nodesMax,
					items: {
						type: 'object',
						properties: Object.assign({
							id: Object.assign({ description: 'Unique lowercase slug.' }, id),
							label: { type: 'string', minLength: 1, maxLength: L.label },
							sub: { type: 'string', maxLength: L.sub, description: 'Second line.' },
							shape: { type: 'string', enum: SHAPES, description: 'box=step (default), decision=branch, store=data at rest, actor=person or outside system.' },
							accent: { type: 'boolean', description: 'At most one node.' },
							group: Object.assign({ description: 'Group id.' }, ref),
							link: {
								type: 'object',
								description: 'Workspace file to open on click.',
								properties: {
									path: { type: 'string', minLength: 1, maxLength: L.path },
									symbol: { type: 'string', maxLength: L.symbol },
									line: { type: 'integer', minimum: 1 }
								},
								required: ['path']
							}
						}, tip),
						required: ['id', 'label']
					}
				},
				edges: {
					type: 'array', maxItems: L.edgesMax,
					items: {
						type: 'object',
						properties: Object.assign({
							from: ref, to: ref,
							label: { type: 'string', maxLength: L.edgeLabel },
							style: { type: 'string', enum: EDGE_STYLES }
						}, tip),
						required: ['from', 'to']
					}
				},
				groups: {
					type: 'array', maxItems: L.groupsMax,
					items: {
						type: 'object',
						properties: Object.assign({
							id: id,
							label: { type: 'string', minLength: 1, maxLength: L.groupLabel },
							parent: Object.assign({ description: 'Enclosing group (depth 2 max).' }, ref)
						}, tip),
						required: ['id', 'label']
					}
				}
			}, tip),
			required: ['title', 'nodes', 'edges']
		};
	}

	/**
	 * Every schema version this editor can read, each in both tiers. Adding v2 means adding a row
	 * here and a step in validate.migrate() — never editing v1, which stored chats still point at.
	 */
	const deepFreeze = (o) => { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); for (const k of Object.keys(o)) { deepFreeze(o[k]); } } return o; };
	const SCHEMAS = deepFreeze({
		1: { house: build('house'), hard: build('hard') }
	});
	const KNOWN_VERSIONS = Object.keys(SCHEMAS).map(Number);

	// ---- a JSON-Schema-subset interpreter -------------------------------------------------------
	// Exactly the keywords build() uses, and no more: type, properties, required, items, enum,
	// minLength/maxLength, minItems/maxItems, pattern, minimum. Ajv would do this too, but it would be
	// the extension's first runtime dependency for ~80 lines of work — and its messages are not the
	// ones the repair ladder needs. Each error names WHAT WAS EXPECTED and THE VALID OPTIONS, because
	// that is what turns a model's repair into a lookup instead of a guess.

	/** JSON's own type names, with `integer` and `array` told apart from number/object. */
	function typeOf(v) {
		if (v === null) { return 'null'; }
		if (Array.isArray(v)) { return 'array'; }
		if (typeof v === 'number') { return Number.isInteger(v) ? 'integer' : 'number'; }
		return typeof v;
	}
	/** Escape one JSON Pointer segment (RFC 6901). */
	function seg(s) { return String(s).replace(/~/g, '~0').replace(/\//g, '~1'); }

	/**
	 * What a too-long / too-many error should tell the model to DO. Keyed by the tail of the
	 * pointer, so `/nodes/3/label` and `/nodes/7/label` share one hint.
	 */
	const HINTS = {
		'title': 'Say the takeaway in fewer words.',
		'label': 'Shorten or move detail to prose.',
		'sub': 'Shorten or move detail to prose.',
		'nodes': 'Draw an overview, then one diagram per sub-flow.',
		'edges': 'Keep the connections that carry the point.',
		'groups': 'Use fewer containers.'
	};
	function hintFor(pointer) {
		const tail = String(pointer).split('/').pop() || '';
		return HINTS[tail] ? ' ' + HINTS[tail] : '';
	}
	const NOUN = { nodes: 'nodes', edges: 'edges', groups: 'groups' };

	/**
	 * Check `value` against `schema`, appending every violation to `errors`.
	 * @param {any} schema
	 * @param {any} value
	 * @param {string} pointer  JSON Pointer of `value` ('' for the root)
	 * @param {Array<{pointer:string, cls:string, message:string}>} errors
	 */
	function check(schema, value, pointer, errors) {
		const got = typeOf(value);
		const want = schema.type;
		const typeOk = want === got || (want === 'number' && got === 'integer');
		if (!typeOk) {
			errors.push({ pointer, cls: 'type', message: 'expected ' + (want === 'object' ? 'an object' : want === 'array' ? 'an array' : want === 'integer' ? 'an integer' : 'a ' + want) + ', got ' + got + '.' });
			return;   // nothing below means anything on a value of the wrong type
		}
		if (schema.enum && schema.enum.indexOf(value) < 0) {
			errors.push({ pointer, cls: pointer === '/v' ? 'version' : 'enum', message: JSON.stringify(value) + ' is not allowed. Use one of: ' + schema.enum.join(', ') + '.' });
		}
		if (want === 'string') {
			const n = Array.from(value).length;   // code points — an emoji is one character, not two
			if (schema.maxLength != null && n > schema.maxLength) {
				errors.push({ pointer, cls: 'length', message: n + ' chars, max ' + schema.maxLength + '.' + hintFor(pointer) });
			}
			if (schema.minLength != null && n < schema.minLength) {
				errors.push({ pointer, cls: 'required', message: 'must not be empty.' });
			} else if (schema.pattern && n <= (schema.maxLength != null ? schema.maxLength : n) && !new RegExp(schema.pattern).test(value)) {
				errors.push({ pointer, cls: 'pattern', message: JSON.stringify(value) + ' is not a lowercase slug (letters, digits, "-" or "_"; e.g. "auth-check").' });
			}
		}
		if ((want === 'integer' || want === 'number') && schema.minimum != null && value < schema.minimum) {
			errors.push({ pointer, cls: 'range', message: value + ' is below the minimum ' + schema.minimum + '.' });
		}
		if (want === 'array') {
			const noun = NOUN[String(pointer).split('/').pop() || ''] || 'items';
			if (schema.maxItems != null && value.length > schema.maxItems) {
				errors.push({ pointer, cls: 'count', message: value.length + ' ' + noun + ', max ' + schema.maxItems + '.' + hintFor(pointer) });
			}
			if (schema.minItems != null && value.length < schema.minItems) {
				errors.push({ pointer, cls: 'count', message: value.length + ' ' + noun + ', min ' + schema.minItems + '.' });
			}
			if (schema.items) {
				for (let i = 0; i < value.length; i++) { check(schema.items, value[i], pointer + '/' + i, errors); }
			}
		}
		if (want === 'object') {
			for (const key of (schema.required || [])) {
				if (value[key] === undefined) { errors.push({ pointer: pointer + '/' + seg(key), cls: 'required', message: 'missing. This field is required.' }); }
			}
			const props = schema.properties || {};
			for (const key of Object.keys(props)) {
				if (value[key] !== undefined) { check(props[key], value[key], pointer + '/' + seg(key), errors); }
			}
		}
	}

	/**
	 * A copy of `value` holding only what `schema` declares, in the order the value had it.
	 * check() says whether the declared fields are right; it does not object to fields it has never
	 * heard of — a model that adds `color` should not be sent back for it. So after a spec passes,
	 * this is what makes "validated" mean "exactly this shape, and nothing that came along with it".
	 */
	function project(schema, value) {
		if (schema.type === 'object' && typeOf(value) === 'object') {
			const props = schema.properties || {};
			const out = {};
			for (const key of Object.keys(value)) {
				if (Object.prototype.hasOwnProperty.call(props, key) && value[key] !== undefined) { out[key] = project(props[key], value[key]); }
			}
			return out;
		}
		if (schema.type === 'array' && Array.isArray(value)) { return value.map((v) => (schema.items ? project(schema.items, v) : v)); }
		return value;
	}

	return { VERSION, KNOWN_VERSIONS, SHAPES, DIRECTIONS, EDGE_STYLES, ID_RE, ID_PATTERN, HOUSE, HARD, SCHEMAS, build, check, project, typeOf, seg };
}));
