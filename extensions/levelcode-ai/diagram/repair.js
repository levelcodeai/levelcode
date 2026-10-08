/*---------------------------------------------------------------------------------------------
 *  LevelCode — AI · rich diagrams · the repair ladder  (docs/RICH-DIAGRAMS.md, "Validation and repair")
 *
 *  Most broken specs are broken MECHANICALLY — a trailing comma, `"shape": "diamond"`, an edge that
 *  names a node by its label — so most should never cost a model call. The ladder reaches for a
 *  model only when deterministic fixes run out, and it never loops:
 *
 *    rung 1  normalize()  deterministic, no model. Tidies everything that has ONE obvious reading:
 *                         lenient JSON, synonyms ("diamond" → decision), an edge that names a node by
 *                         its label, a label over the limit (shortened; the full text survives as a
 *                         tooltip and in the screen-reader outline).
 *    rung 2  (the caller) ONE model pass: whatever needs intent — an edge to a node that does not
 *                         exist, two accents, 17 nodes, groups three deep — goes back as an error list.
 *    rung 3  normalize({lossy}) + degrade()   still broken after that pass: drop the edges that point
 *                         nowhere, rename the colliding ids, keep one accent, flatten the nesting —
 *                         and draw what is left under a banner that says what was lost. Or give up
 *                         honestly (`failed`) so the UI can show the source and a Retry.
 *
 *  THE RULE THAT ORDERS THE RUNGS: an "auto-fixed" diagram never says something different from what
 *  the model wrote, and a "degraded" one always says what it lost. So a fix that changes MEANING
 *  (a dropped edge, a renamed duplicate) is never applied before the model has had its one chance
 *  to do it properly — while a fix that only changes PRESENTATION never costs a model call.
 *
 *  prepare() runs the ladder for one call and says which rung it ended on. It is pure: the caller
 *  decides what "the repair pass was already spent" means (`final`) and what to do with the answer.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
(function (root, factory) {
	'use strict';
	if (typeof module === 'object' && module.exports) { module.exports = factory(require('./schema'), require('./validate')); }
	else { (root.LCDiagram = root.LCDiagram || {}).repair = factory(root.LCDiagram.schema, root.LCDiagram.validate); }
}(typeof globalThis !== 'undefined' ? globalThis : this, function (schema, validator) {
	'use strict';

	const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
	const q = (s) => JSON.stringify(String(s));
	const HOUSE = schema.HOUSE, HARD = schema.HARD;

	// ---- text hygiene ---------------------------------------------------------------------------
	// Control characters and bidirectional overrides have no business in a label: the first break
	// layout, the second can make a node READ as something other than what it says.
	// eslint-disable-next-line no-control-regex
	const UNSAFE_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f​-‏‪-‮⁠-⁩﻿]/g;
	/** One clean line: unsafe characters gone, runs of whitespace collapsed. */
	function cleanText(s) { return String(s == null ? '' : s).replace(UNSAFE_CHARS, '').replace(/\s+/g, ' ').trim(); }
	const count = (s) => Array.from(s).length;

	/**
	 * Cut `text` to `max` characters, ending in an ellipsis. Prefers a word boundary when one is
	 * close, so "Validate the incoming request" shortens to "Validate the incoming…", not "…incoming reque…".
	 */
	function truncate(text, max) {
		const chars = Array.from(String(text));
		if (chars.length <= max) { return String(text); }
		let cut = chars.slice(0, Math.max(1, max - 1)).join('');
		const sp = cut.lastIndexOf(' ');
		if (sp >= Math.floor(max * 0.6)) { cut = cut.slice(0, sp); }
		return cut.replace(/[\s,;:.\-–—(]+$/, '') + '…';
	}

	/** A model-supplied name → a lowercase slug. '' when nothing sluggable is left (the caller invents one). */
	function slugify(s) {
		let t = String(s == null ? '' : s);
		try { t = t.normalize('NFKD'); } catch (e) { /* no ICU — fine, non-ASCII just becomes '-' */ }
		t = t.replace(/[̀-ͯ]/g, '').toLowerCase().trim()
			.replace(/[^a-z0-9_-]+/g, '-').replace(/-{2,}/g, '-').replace(/^[-_]+|[-_]+$/g, '');
		return t.slice(0, HOUSE.id).replace(/[-_]+$/, '');
	}

	// ---- lenient JSON ---------------------------------------------------------------------------
	const QUOTES = { '"': '"', "'": "'", '“': '”', '”': '”' };

	/**
	 * Parse JSON the way models actually write it: comments, trailing commas, single or "smart"
	 * quotes, bare keys, Python's True/False/None, a ```json fence around the lot.
	 *
	 * What it will NOT do is finish a spec that stops mid-structure. Truncated output means the
	 * model hit its token cap, and guessing at the rest would draw a diagram nobody wrote — so that
	 * comes back as `truncated`, and the caller re-requests instead of repairing.
	 * @param {string} text
	 * @returns {{ ok: boolean, value?: any, lenient?: boolean, truncated?: boolean, error?: string }}
	 */
	function parseLenient(text) {
		let src = String(text == null ? '' : text).replace(/^﻿/, '').trim();
		try { return { ok: true, value: JSON.parse(src), lenient: false }; } catch (e) { /* fall through to the tolerant path */ }
		const fence = /^```[a-zA-Z0-9_-]*\s*\n([\s\S]*?)\n?```\s*$/.exec(src);
		if (fence) { src = fence[1].trim(); }
		const start = src.search(/[{[]/);
		if (start < 0) { return { ok: false, error: 'no JSON object found' }; }
		src = src.slice(start);

		let out = '', i = 0, depth = 0;
		const n = src.length;
		const skipSpaceAndComments = (j) => {
			for (;;) {
				while (j < n && /\s/.test(src[j])) { j++; }
				if (src[j] === '/' && src[j + 1] === '/') { const e = src.indexOf('\n', j); j = e < 0 ? n : e; continue; }
				if (src[j] === '/' && src[j + 1] === '*') { const e = src.indexOf('*/', j + 2); j = e < 0 ? n : e + 2; continue; }
				return j;
			}
		};
		while (i < n) {
			const c = src[i];
			if (QUOTES[c]) {
				const close = QUOTES[c], smart = c !== '"' && c !== "'";
				let j = i + 1, buf = '', closed = false;
				while (j < n) {
					const d = src[j];
					if (d === '\\') {
						if (j + 1 >= n) { break; }
						buf += (c === "'" && src[j + 1] === "'") ? "'" : d + src[j + 1];
						j += 2; continue;
					}
					if (d === close || (smart && d === '“')) { closed = true; j++; break; }
					if (d === '"') { buf += '\\"'; j++; continue; }             // a bare " inside '…' or “…”
					if (d === '\n') { buf += '\\n'; j++; continue; }
					if (d === '\r') { j++; continue; }
					if (d === '\t') { buf += '\\t'; j++; continue; }
					buf += d; j++;
				}
				if (!closed) { return { ok: false, truncated: true, error: 'unterminated string' }; }
				out += '"' + buf + '"'; i = j; continue;
			}
			if (c === '/' && (src[i + 1] === '/' || src[i + 1] === '*')) {
				const j = skipSpaceAndComments(i);
				if (j >= n && src[i + 1] === '*' && src.indexOf('*/', i + 2) < 0) { return { ok: false, truncated: true, error: 'unterminated comment' }; }
				i = j; continue;
			}
			if (c === ',') {
				const j = skipSpaceAndComments(i + 1);
				if (src[j] === '}' || src[j] === ']') { i++; continue; }      // trailing comma
			}
			if (/[A-Za-z_$]/.test(c)) {
				let j = i; while (j < n && /[\w$]/.test(src[j])) { j++; }
				const word = src.slice(i, j);
				const k = skipSpaceAndComments(j);
				if (src[k] === ':') { out += '"' + word + '"'; }               // bare key
				else if (word === 'True') { out += 'true'; }
				else if (word === 'False') { out += 'false'; }
				else if (word === 'None' || word === 'undefined') { out += 'null'; }
				else { out += word; }
				i = j; continue;
			}
			if (c === '{' || c === '[') { depth++; }
			else if (c === '}' || c === ']') {
				depth--;
				if (depth === 0) { out += c; break; }                          // ignore prose after the object
			}
			out += c; i++;
		}
		if (depth > 0) { return { ok: false, truncated: true, error: 'the JSON stops before it is complete' }; }
		try { return { ok: true, value: JSON.parse(out), lenient: true }; }
		catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
	}

	// ---- rung 1: normalize ----------------------------------------------------------------------
	const DIRECTION_SYNONYMS = {
		right: 'right', lr: 'right', 'left-to-right': 'right', 'left-right': 'right', ltr: 'right', horizontal: 'right', east: 'right', row: 'right',
		rl: 'right', 'right-to-left': 'right', left: 'right',
		down: 'down', tb: 'down', td: 'down', 'top-to-bottom': 'down', 'top-down': 'down', 'top-bottom': 'down', vertical: 'down', south: 'down', column: 'down',
		bt: 'down', 'bottom-to-top': 'down', up: 'down'
	};
	const SHAPE_SYNONYMS = {
		box: 'box', rect: 'box', rectangle: 'box', square: 'box', process: 'box', step: 'box', node: 'box', default: 'box', task: 'box', service: 'box', component: 'box',
		decision: 'decision', diamond: 'decision', rhombus: 'decision', condition: 'decision', choice: 'decision', branch: 'decision', 'if': 'decision', gateway: 'decision',
		store: 'store', database: 'store', db: 'store', cylinder: 'store', storage: 'store', datastore: 'store', 'data-store': 'store', table: 'store', cache: 'store', queue: 'store', bucket: 'store',
		actor: 'actor', person: 'actor', user: 'actor', human: 'actor', external: 'actor', pill: 'actor', stadium: 'actor', terminal: 'actor', terminator: 'actor', round: 'actor', rounded: 'actor', start: 'actor', end: 'actor', client: 'actor'
	};
	const STYLE_SYNONYMS = {
		solid: 'solid', line: 'solid', normal: 'solid', plain: 'solid', thick: 'solid', bold: 'solid',
		dashed: 'dashed', dash: 'dashed', dashes: 'dashed', dotted: 'dashed', dots: 'dashed', dot: 'dashed', broken: 'dashed', optional: 'dashed', async: 'dashed'
	};
	const WRAPPERS = ['spec', 'diagram', 'graph', 'input', 'json', 'arguments', 'data'];
	const key = (s) => String(s == null ? '' : s).toLowerCase().trim().replace(/[\s_]+/g, '-');
	// A synonym table is an object, and every object answers to "constructor": the word is looked up as
	// the table's OWN entry, so a word it has never heard of is unknown whatever it happens to be.
	const synonym = (table, word) => { const k = key(word); return Object.prototype.hasOwnProperty.call(table, k) ? table[k] : undefined; };
	const pick = (obj, names) => { for (const n of names) { if (obj[n] !== undefined && obj[n] !== null) { return obj[n]; } } return undefined; };
	const asBool = (v) => (v === true || v === 1 || (typeof v === 'string' && /^(true|yes|1)$/i.test(v.trim())));
	const scalar = (v) => (typeof v === 'string' || typeof v === 'number') ? String(v) : undefined;

	/**
	 * Rung 1. Turn whatever the model sent into a clean spec in canonical form, recording each thing
	 * it changed.
	 *
	 * Three kinds of fix come out of here, and the difference is what the user is told:
	 *   (plain)  a tidy-up with one obvious reading — `"shape": "diamond"`, a trailing comma, an id
	 *            with a space in it. The drawing is what the model meant; nobody needs a badge.
	 *   `show`   the drawing differs from what was written, but says the same thing: a label over
	 *            the limit was shortened, a shape nobody knows became a box. "auto-fixed" badge.
	 *   `lossy`  it changed what the diagram SAYS — an edge dropped, a duplicate id renamed. Only
	 *            ever applied when `opts.lossy` is set, which the ladder does on its last rung.
	 *
	 * Never throws. A value it cannot make sense of is passed through for validate() to name.
	 * @param {any} input
	 * @param {{ lossy?: boolean }} [opts]
	 * @returns {{ spec: any, fixes: Array<{pointer:string, cls:string, message:string, show?:boolean, lossy?:boolean, shortened?:boolean}>, truncated?: boolean, syntax?: string }}
	 */
	function normalize(input, opts) {
		const allowLossy = !!(opts && opts.lossy);
		/** @type {Array<{pointer:string, cls:string, message:string, show?:boolean, lossy?:boolean, shortened?:boolean}>} */
		const fixes = [];
		const fix = (pointer, cls, message, flags) => { fixes.push(Object.assign({ pointer, cls, message }, flags || {})); };

		// -- syntax: text → object, and unwrap a spec that arrived inside an envelope
		let raw = input;
		for (let hop = 0; hop < 3; hop++) {
			if (typeof raw === 'string') {
				const p = parseLenient(raw);
				if (!p.ok) { return p.truncated ? { spec: null, fixes, truncated: true } : { spec: null, fixes, syntax: p.error || 'not valid JSON' }; }
				fix('', p.lenient ? 'lenient-json' : 'stringified', p.lenient ? 'JSON repaired (comments, quotes or trailing commas).' : 'spec arrived as a JSON string; parsed it.');
				raw = p.value; continue;
			}
			if (isObj(raw) && raw.nodes === undefined) {
				const w = WRAPPERS.find((k) => raw[k] !== undefined && (isObj(raw[k]) || typeof raw[k] === 'string'));
				if (w) { fix('', 'unwrapped', 'spec was nested under "' + w + '"; unwrapped it.'); raw = raw[w]; continue; }
			}
			break;
		}
		if (!isObj(raw)) { return { spec: raw, fixes }; }
		// A structural copy: plain data only, and nothing shared with the caller's object.
		try { raw = JSON.parse(JSON.stringify(raw)); } catch (e) { return { spec: null, fixes, syntax: 'spec is not plain JSON data' }; }

		const spec = {};
		let dropped = 0;   // unknown fields, counted not listed
		// `tip` is the renderer's own field (the full text of a label that was shortened). A spec that
		// has been through here before carries them, and going through again must not lose them.
		const keepTip = (from, to) => { if (typeof from.tip === 'string' && cleanText(from.tip)) { to.tip = truncate(cleanText(from.tip), HARD.tip); } };
		keepTip(raw, spec);

		// -- v
		if (raw.v === undefined || raw.v === null) { spec.v = schema.VERSION; }
		else if (typeof raw.v === 'string' && /^\d+$/.test(raw.v.trim())) { spec.v = Number(raw.v); fix('/v', 'coerced', 'version given as a string; read it as a number.'); }
		else { spec.v = raw.v; }

		// -- title
		const title = scalar(pick(raw, ['title', 'name', 'caption', 'heading']));
		if (title !== undefined) { spec.title = cleanText(title); }
		if (raw.title === undefined && title !== undefined) { fix('/title', 'renamed-field', 'used the "name"/"caption" field as the title.'); }

		// -- direction
		const dirRaw = pick(raw, ['direction', 'dir', 'rankdir', 'orientation', 'flow']);
		if (dirRaw === undefined) { spec.direction = 'right'; }
		else {
			const d = synonym(DIRECTION_SYNONYMS, dirRaw);
			if (d) { spec.direction = d; if (d !== dirRaw) { fix('/direction', 'synonym', JSON.stringify(dirRaw) + ' read as "' + d + '".'); } }
			else { spec.direction = 'right'; fix('/direction', 'enum', JSON.stringify(dirRaw) + ' is not a direction; used "right".', { show: true }); }
		}

		// -- groups first: nodes refer to them
		const groupIdOf = new Map();   // what the model wrote → the slug we settled on
		let groupsIn = raw.groups;
		if (isObj(groupsIn)) {
			groupsIn = Object.keys(groupsIn).map((k) => (isObj(groupsIn[k]) ? Object.assign({ id: k }, groupsIn[k]) : { id: k, label: scalar(groupsIn[k]) }));
			fix('/groups', 'coerced', 'groups given as an object; read as a list.');
		}
		let groups;
		if (Array.isArray(groupsIn)) {
			groups = [];
			groupsIn.forEach((g, i) => {
				if (typeof g === 'string') { g = { id: g, label: g }; }
				if (!isObj(g)) { groups.push(g); return; }
				const out = {};
				const rawId = scalar(pick(g, ['id', 'key', 'name']));
				const label = scalar(pick(g, ['label', 'title', 'name', 'text']));
				let id = rawId !== undefined ? slugify(rawId) : '';
				if (!id) { id = slugify(label || '') || ('g' + (i + 1)); }
				if (rawId !== undefined) { groupIdOf.set(rawId, id); groupIdOf.set(key(rawId), id); }
				if (rawId !== id && rawId !== undefined) { fix('/groups/' + i + '/id', 'slug', q(rawId) + ' written as the slug "' + id + '".'); }
				out.id = id;
				out.label = label !== undefined && cleanText(label) ? cleanText(label) : (rawId !== undefined ? cleanText(rawId) : id);
				if (label === undefined) { fix('/groups/' + i + '/label', 'defaulted', 'group had no label; used its id.'); }
				const parent = scalar(pick(g, ['parent', 'in', 'group']));
				if (parent !== undefined && cleanText(parent)) { out.parent = parent; }
				keepTip(g, out);
				dropped += Object.keys(g).filter((k) => ['id', 'key', 'name', 'label', 'title', 'text', 'parent', 'in', 'group', 'tip'].indexOf(k) < 0).length;
				groups.push(out);
			});
			const gid = (ref) => (groupIdOf.has(ref) ? groupIdOf.get(ref) : groupIdOf.has(key(ref)) ? groupIdOf.get(key(ref)) : (slugify(ref) || String(ref)));
			for (const g of groups) { if (isObj(g) && g.parent !== undefined) { g.parent = gid(g.parent); } }
		} else if (groupsIn !== undefined && groupsIn !== null) { groups = groupsIn; }
		const groupRef = (ref) => (groupIdOf.has(ref) ? groupIdOf.get(ref) : groupIdOf.has(key(ref)) ? groupIdOf.get(key(ref)) : (slugify(ref) || String(ref)));

		// -- nodes
		const idOf = new Map();        // what the model wrote → the slug we settled on
		const idByLabel = new Map();   // lowercased label → id (null when two nodes share a label)
		let nodesIn = raw.nodes;
		if (isObj(nodesIn)) {
			nodesIn = Object.keys(nodesIn).map((k) => (isObj(nodesIn[k]) ? Object.assign({ id: k }, nodesIn[k]) : { id: k, label: scalar(nodesIn[k]) }));
			fix('/nodes', 'coerced', 'nodes given as an object; read as a list.');
		}
		let nodes;
		if (Array.isArray(nodesIn)) {
			nodes = [];
			nodesIn.forEach((n, i) => {
				const at = '/nodes/' + i;
				if (typeof n === 'string' || typeof n === 'number') { n = { id: String(n), label: String(n) }; fix(at, 'coerced', 'node given as a bare name; used it as both id and label.'); }
				if (!isObj(n)) { nodes.push(n); return; }
				const out = {};
				const rawId = scalar(pick(n, ['id', 'key']));
				let labelRaw = scalar(pick(n, ['label', 'name', 'title', 'text']));
				let subRaw = scalar(pick(n, ['sub', 'subtitle', 'sublabel', 'description', 'desc', 'detail', 'note']));
				if (n.label === undefined && labelRaw !== undefined) { fix(at + '/label', 'renamed-field', 'used the "name"/"title" field as the label.'); }
				if (n.sub === undefined && subRaw !== undefined) { fix(at + '/sub', 'renamed-field', 'used the "description"/"subtitle" field as the second line.'); }
				// "Jev\nreturns probabilities" is a label and a sub written in one field.
				if (labelRaw !== undefined && subRaw === undefined && /\r?\n|<br\s*\/?>/i.test(labelRaw)) {
					const parts = labelRaw.split(/\r?\n|<br\s*\/?>/i).map(cleanText).filter(Boolean);
					if (parts.length > 1) { labelRaw = parts[0]; subRaw = parts.slice(1).join(' '); fix(at + '/label', 'split-label', 'two-line label split into label and sub.'); }
				}
				const label = labelRaw !== undefined ? cleanText(labelRaw) : undefined;
				let id = rawId !== undefined ? slugify(rawId) : '';
				if (!id) { id = slugify(label || '') || ('n' + (i + 1)); if (rawId === undefined) { fix(at + '/id', 'defaulted', 'node had no id; made "' + id + '" from its label.'); } }
				if (rawId !== undefined && rawId !== id) { fix(at + '/id', 'slug', q(rawId) + ' written as the slug "' + id + '".'); }
				if (rawId !== undefined) { if (!idOf.has(rawId)) { idOf.set(rawId, id); } if (!idOf.has(key(rawId))) { idOf.set(key(rawId), id); } }
				out.id = id;
				if (label !== undefined && label) { out.label = label; }
				else if (rawId !== undefined && cleanText(rawId)) { out.label = cleanText(rawId); fix(at + '/label', 'defaulted', 'node had no label; used its id.'); }
				if (out.label) { const lk = out.label.toLowerCase(); idByLabel.set(lk, idByLabel.has(lk) ? null : id); }
				const sub = subRaw !== undefined ? cleanText(subRaw) : '';
				if (sub) { out.sub = sub; }
				const shapeRaw = pick(n, ['shape', 'type', 'kind']);
				if (shapeRaw !== undefined) {
					const s = synonym(SHAPE_SYNONYMS, shapeRaw);
					if (s) { if (s !== 'box') { out.shape = s; } if (s !== shapeRaw) { fix(at + '/shape', 'synonym', JSON.stringify(shapeRaw) + ' read as "' + s + '".'); } }
					else { fix(at + '/shape', 'enum', JSON.stringify(shapeRaw) + ' is not a shape; drew a box.', { show: true }); }
				}
				const accentRaw = pick(n, ['accent', 'highlight', 'primary', 'emphasis']);
				if (accentRaw !== undefined) {
					if (asBool(accentRaw)) { out.accent = true; }
					if (typeof accentRaw !== 'boolean') { fix(at + '/accent', 'coerced', 'accent read as ' + asBool(accentRaw) + '.'); }
				}
				const groupRaw = scalar(pick(n, ['group', 'parent', 'cluster', 'in']));
				if (groupRaw !== undefined && cleanText(groupRaw)) { out.group = groupRef(groupRaw); }
				const link = normalizeLink(pick(n, ['link', 'file', 'href', 'path']));
				if (link) { out.link = link; }
				keepTip(n, out);
				dropped += Object.keys(n).filter((k) => NODE_KEYS.indexOf(k) < 0).length;
				nodes.push(out);
			});
		} else if (nodesIn !== undefined) { nodes = nodesIn; }

		// -- duplicate ids. The same node listed twice is one node. Two DIFFERENT nodes under one id
		//    is a question only the model can answer (which one do the edges mean?), so that is
		//    left for validate() to report — and settled by renaming only on the last rung.
		if (Array.isArray(nodes)) {
			const seen = new Map();
			const kept = [];
			nodes.forEach((n, i) => {
				if (!isObj(n) || typeof n.id !== 'string') { kept.push(n); return; }
				if (!seen.has(n.id)) { seen.set(n.id, n); kept.push(n); return; }
				if (JSON.stringify(seen.get(n.id)) === JSON.stringify(n)) {
					fix('/nodes/' + i, 'duplicate-node', 'node "' + n.id + '" was listed twice; kept one.');
					return;
				}
				if (!allowLossy) { kept.push(n); return; }
				let k = 2, id = n.id + '-' + k;
				const taken = (x) => seen.has(x) || nodes.some((m) => isObj(m) && m !== n && m.id === x);
				while (taken(id)) { id = n.id + '-' + (++k); }
				fix('/nodes/' + i + '/id', 'duplicate-id', 'duplicate id "' + n.id + '" renamed to "' + id + '"; edges to "' + n.id + '" point at the first one.', { lossy: true });
				n.id = id; seen.set(id, n); kept.push(n);
			});
			nodes = kept;
		}
		if (Array.isArray(groups)) {
			const seen = new Set();
			groups = groups.filter((g, i) => {
				if (!isObj(g) || typeof g.id !== 'string') { return true; }
				if (!seen.has(g.id)) { seen.add(g.id); return true; }
				const twin = groups.find((x) => isObj(x) && x.id === g.id);
				if (JSON.stringify(twin) === JSON.stringify(g)) { fix('/groups/' + i, 'duplicate-node', 'group "' + g.id + '" was listed twice; kept one.'); return false; }
				if (!allowLossy) { return true; }
				fix('/groups/' + i, 'duplicate-id', 'duplicate group id "' + g.id + '"; kept the first.', { lossy: true });
				return false;
			});
		}
		const known = new Set((Array.isArray(nodes) ? nodes : []).filter((n) => isObj(n) && typeof n.id === 'string').map((n) => n.id));
		const knownList = Array.from(known);

		// -- edges
		const nodeRef = (ref) => {
			if (idOf.has(ref)) { return idOf.get(ref); }
			if (idOf.has(key(ref))) { return idOf.get(key(ref)); }
			const s = slugify(ref);
			if (known.has(s)) { return s; }
			// Models often point an edge at a node's LABEL. When exactly one node has that label,
			// that is not a guess — it is a lookup.
			const byLabel = idByLabel.get(cleanText(ref).toLowerCase());
			if (byLabel) { fix('/edges', 'ref-by-label', 'an edge named a node by its label (' + q(ref) + '); matched it to "' + byLabel + '".'); return byLabel; }
			return s || String(ref);
		};
		let edgesIn = raw.edges !== undefined ? raw.edges : pick(raw, ['links', 'connections', 'arrows']);
		if (raw.edges === undefined && edgesIn !== undefined) { fix('/edges', 'renamed-field', 'used the "links"/"connections" field as the edges.'); }
		let edges;
		if (edgesIn === undefined || edgesIn === null) { edges = []; if (raw.edges === undefined) { fix('/edges', 'defaulted', 'no edges given; drew the nodes alone.'); } }
		else if (Array.isArray(edgesIn)) {
			edges = [];
			const seenEdge = new Set();
			edgesIn.forEach((e, i) => {
				const at = '/edges/' + i;
				if (typeof e === 'string') {
					const m = /^\s*(.+?)\s*(-{1,3}|={1,3}|\.{1,3}-?)>\s*(.+?)(?:\s*:\s*(.+))?$/.exec(e);
					if (m) { e = { from: m[1], to: m[3], label: m[4], style: m[2][0] === '.' ? 'dashed' : undefined }; fix(at, 'coerced', 'edge written as "a -> b"; read it as from/to.'); }
				} else if (Array.isArray(e) && e.length >= 2) { e = { from: e[0], to: e[1], label: e[2] }; fix(at, 'coerced', 'edge given as a list; read it as from/to.'); }
				if (!isObj(e)) { edges.push(e); return; }
				const out = {};
				const fromRaw = scalar(pick(e, ['from', 'source', 'src', 'start', 'a']));
				const toRaw = scalar(pick(e, ['to', 'target', 'dst', 'dest', 'end', 'b']));
				if (e.from === undefined && fromRaw !== undefined) { fix(at + '/from', 'renamed-field', 'used "source" as the from end.'); }
				if (fromRaw !== undefined) { out.from = nodeRef(fromRaw); }
				if (toRaw !== undefined) { out.to = nodeRef(toRaw); }
				const label = scalar(pick(e, ['label', 'text', 'name', 'title']));
				if (label !== undefined && cleanText(label)) { out.label = cleanText(label); }
				const styleRaw = pick(e, ['style', 'type', 'line', 'kind']);
				if (styleRaw !== undefined) {
					const s = synonym(STYLE_SYNONYMS, styleRaw);
					if (s === 'dashed') { out.style = 'dashed'; }
					if (!s) { fix(at + '/style', 'enum', JSON.stringify(styleRaw) + ' is not a line style; drew it solid.', { show: true }); }
					else if (s !== styleRaw) { fix(at + '/style', 'synonym', JSON.stringify(styleRaw) + ' read as "' + s + '".'); }
				} else if (e.dashed === true) { out.style = 'dashed'; }
				keepTip(e, out);
				dropped += Object.keys(e).filter((k) => EDGE_KEYS.indexOf(k) < 0).length;
				// An edge to a node that does not exist. On the last rung it is dropped (and the banner
				// says so); before that it stays, so validate() can hand the model the list of known ids.
				const bad = ['from', 'to'].filter((end) => typeof out[end] === 'string' && !known.has(out[end]));
				if (bad.length && known.size && allowLossy) {
					fix(at, 'unknown-node', 'dropped: unknown node ' + bad.map((end) => q(end === 'from' ? fromRaw : toRaw)).join(' and ') + '. Known ids: ' + validator.listIds(knownList) + '.', { lossy: true });
					return;
				}
				const sig = out.from + '\u0000' + out.to + '\u0000' + (out.label || '') + '\u0000' + (out.style || '');
				if (out.from !== undefined && out.to !== undefined && seenEdge.has(sig)) { fix(at, 'duplicate-edge', 'the same edge was listed twice; kept one.'); return; }
				seenEdge.add(sig);
				edges.push(out);
			});
		} else { edges = edgesIn; }

		// -- long text: the spec's "truncate long labels with a tooltip". Presentation, not meaning —
		//    the whole label is still there on hover and in the outline — so it never costs a model call.
		const shorten = (obj, field, max, pointer) => {
			if (!isObj(obj) || typeof obj[field] !== 'string' || count(obj[field]) <= max) { return null; }
			const full = obj[field];
			obj[field] = truncate(full, max);
			fix(pointer, 'length', count(full) + ' chars, max ' + max + ' — shortened to ' + q(obj[field]) + ' (the full text is kept as a tooltip).', { shortened: true, show: true });
			return full;
		};
		const tip = (s) => truncate(s, HARD.tip);
		const fullTitle = shorten(spec, 'title', HOUSE.title, '/title');
		if (fullTitle) { spec.tip = tip(fullTitle); }
		if (Array.isArray(nodes)) {
			nodes.forEach((n, i) => {
				if (!isObj(n)) { return; }
				const before = [n.label, n.sub];
				const a = shorten(n, 'label', HOUSE.label, '/nodes/' + i + '/label');
				const b = shorten(n, 'sub', HOUSE.sub, '/nodes/' + i + '/sub');
				if (a || b) { n.tip = tip([before[0], before[1]].filter(Boolean).join(' — ')); }
			});
		}
		if (Array.isArray(edges)) { edges.forEach((e, i) => { const f = shorten(e, 'label', HOUSE.edgeLabel, '/edges/' + i + '/label'); if (f) { e.tip = tip(f); } }); }
		if (Array.isArray(groups)) { groups.forEach((g, i) => { const f = shorten(g, 'label', HOUSE.groupLabel, '/groups/' + i + '/label'); if (f) { g.tip = tip(f); } }); }

		// -- a group nothing lives in has no geometry; drop it rather than draw an empty frame
		if (Array.isArray(groups) && Array.isArray(nodes)) {
			const used = new Set(nodes.filter((n) => isObj(n) && typeof n.group === 'string').map((n) => n.group));
			let changed = true;
			while (changed) {
				changed = false;
				for (const g of groups) { if (isObj(g) && used.has(g.id) && typeof g.parent === 'string' && !used.has(g.parent)) { used.add(g.parent); changed = true; } }
			}
			const declared = new Set(groups.filter(isObj).map((g) => g.id));
			const before = groups.length;
			groups = groups.filter((g) => !isObj(g) || used.has(g.id) || (typeof g.parent === 'string' && !declared.has(g.parent)));
			if (groups.length !== before) { fix('/groups', 'empty-group', (before - groups.length) + ' empty group(s) left out.'); }
		}

		spec.nodes = nodes;
		spec.edges = edges;
		if (Array.isArray(groups) ? groups.length : groups !== undefined) { spec.groups = groups; }
		const KNOWN_TOP = ['v', 'title', 'name', 'caption', 'heading', 'direction', 'dir', 'rankdir', 'orientation', 'flow', 'nodes', 'edges', 'links', 'connections', 'arrows', 'groups', 'tip'];
		dropped += Object.keys(raw).filter((k) => KNOWN_TOP.indexOf(k) < 0).length;
		if (dropped) { fix('', 'unknown-field', dropped + ' unrecognised field(s) ignored.'); }
		return { spec, fixes };
	}
	const NODE_KEYS = ['id', 'key', 'label', 'name', 'title', 'text', 'sub', 'subtitle', 'sublabel', 'description', 'desc', 'detail', 'note', 'shape', 'type', 'kind', 'accent', 'highlight', 'primary', 'emphasis', 'group', 'parent', 'cluster', 'in', 'link', 'file', 'href', 'path', 'tip'];
	const EDGE_KEYS = ['from', 'source', 'src', 'start', 'a', 'to', 'target', 'dst', 'dest', 'end', 'b', 'label', 'text', 'name', 'title', 'style', 'type', 'line', 'kind', 'dashed', 'tip'];

	/**
	 * `link` in any of the ways a model writes one — an object, "src/app.js:42", "src/app.js#render".
	 * Only shapes it; WHETHER the path may be opened is decided by the host against the workspace.
	 */
	function normalizeLink(v) {
		if (v === undefined || v === null) { return null; }
		let p, symbol, line;
		if (typeof v === 'string') {
			const m = /^(.*?)(?::(\d+)(?::\d+)?|#(.+))?$/.exec(v.trim());
			p = m ? m[1] : v; line = m && m[2] ? Number(m[2]) : undefined; symbol = m && m[3] ? m[3] : undefined;
		} else if (isObj(v)) {
			p = scalar(pick(v, ['path', 'file', 'uri', 'href']));
			symbol = scalar(pick(v, ['symbol', 'name', 'function', 'fn']));
			const l = pick(v, ['line', 'lineNumber', 'row']);
			line = (typeof l === 'number' || (typeof l === 'string' && /^\d+$/.test(l.trim()))) ? Number(l) : undefined;
		} else { return null; }
		p = cleanText(p == null ? '' : p).replace(/^file:\/\//i, '');
		if (!p) { return null; }
		const out = { path: Array.from(p).slice(0, HOUSE.path).join('') };
		if (symbol !== undefined && cleanText(symbol)) { out.symbol = Array.from(cleanText(symbol)).slice(0, HOUSE.symbol).join(''); }
		if (Number.isInteger(line) && line >= 1) { out.line = line; }
		return out;
	}

	// ---- rung 3: degrade ------------------------------------------------------------------------
	/**
	 * The repair pass is spent and the spec is still invalid. Cut it down to the part that IS valid,
	 * and say exactly what was cut — or return null when nothing drawable is left.
	 *
	 * Counts relax here and nowhere else: a 17-node diagram the model twice declined to split is
	 * drawn whole under a banner, because showing 12 of 17 would be a different diagram presented as
	 * the answer. The HARD ceiling still applies; past it, the tail really is dropped.
	 * @param {any} spec  a normalize()d spec
	 * @returns {{ spec: any, notes: string[] } | null}
	 */
	function degrade(spec) {
		if (!isObj(spec) || !Array.isArray(spec.nodes)) { return null; }
		const notes = [];
		const plural = (n, word) => n + ' ' + word + (n === 1 ? '' : 's');
		const out = { v: schema.VERSION, title: '', direction: schema.DIRECTIONS.indexOf(spec.direction) >= 0 ? spec.direction : 'right', nodes: [], edges: [] };
		if (typeof spec.title === 'string' && cleanText(spec.title)) { out.title = truncate(cleanText(spec.title), HOUSE.title); }
		else { out.title = 'Untitled diagram'; notes.push('no title given'); }
		if (typeof spec.tip === 'string') { out.tip = truncate(spec.tip, HARD.tip); }
		// A spec from a NEWER editor than this one: draw what this schema understands, and say so.
		if (spec.v !== undefined && !schema.schemaFor(spec.v)) { notes.push('written for schema v' + String(spec.v).slice(0, 8) + '; drawn as v' + schema.VERSION); }

		// nodes: keep the well-formed ones, up to the hard ceiling
		const ids = new Set();
		let badNodes = 0;
		for (const n of spec.nodes) {
			if (!isObj(n) || typeof n.id !== 'string' || !schema.ID_RE.test(n.id) || ids.has(n.id) || typeof n.label !== 'string' || !n.label) { badNodes++; continue; }
			if (out.nodes.length >= HARD.nodesMax) { badNodes++; continue; }
			const m = { id: n.id.slice(0, HOUSE.id), label: truncate(n.label, HOUSE.label) };
			if (typeof n.sub === 'string' && n.sub) { m.sub = truncate(n.sub, HOUSE.sub); }
			if (schema.SHAPES.indexOf(n.shape) >= 0 && n.shape !== 'box') { m.shape = n.shape; }
			if (n.accent === true) { m.accent = true; }
			if (typeof n.group === 'string') { m.group = n.group; }
			if (isObj(n.link) && typeof n.link.path === 'string' && n.link.path) {
				m.link = { path: n.link.path.slice(0, HOUSE.path) };
				if (typeof n.link.symbol === 'string' && n.link.symbol) { m.link.symbol = n.link.symbol.slice(0, HOUSE.symbol); }
				if (Number.isInteger(n.link.line) && n.link.line >= 1) { m.link.line = n.link.line; }
			}
			if (typeof n.tip === 'string') { m.tip = truncate(n.tip, HARD.tip); }
			ids.add(m.id); out.nodes.push(m);
		}
		if (!out.nodes.length) { return null; }
		if (badNodes) { notes.push(plural(badNodes, 'node') + ' dropped: malformed or over the limit'); }
		if (out.nodes.length > HOUSE.nodesMax) { notes.push(out.nodes.length + ' nodes — over the ' + HOUSE.nodesMax + '-node limit, drawn anyway'); }

		// one accent
		const accented = out.nodes.filter((n) => n.accent);
		if (accented.length > 1) { accented.slice(1).forEach((n) => { delete n.accent; }); notes.push(plural(accented.length - 1, 'extra accent') + ' removed'); }

		// groups: unknown parents and cycles lose their parent; anything deeper than the limit is lifted
		const groups = [];
		const gids = new Set();
		for (const g of (Array.isArray(spec.groups) ? spec.groups : [])) {
			if (!isObj(g) || typeof g.id !== 'string' || !schema.ID_RE.test(g.id) || gids.has(g.id) || groups.length >= HARD.groupsMax) { continue; }
			const m = { id: g.id.slice(0, HOUSE.id), label: truncate(typeof g.label === 'string' && g.label ? g.label : g.id, HOUSE.groupLabel) };
			if (typeof g.parent === 'string') { m.parent = g.parent; }
			if (typeof g.tip === 'string') { m.tip = truncate(g.tip, HARD.tip); }
			gids.add(m.id); groups.push(m);
		}
		let regrouped = 0;
		for (const g of groups) { if (g.parent !== undefined && (!gids.has(g.parent) || g.parent === g.id)) { delete g.parent; regrouped++; } }
		let depths = validator.groupDepths(groups);
		for (const g of groups) { const d = depths.get(g.id); if (d && d.cycle && g.parent !== undefined) { delete g.parent; regrouped++; depths = validator.groupDepths(groups); } }
		// too deep: fold the group into its parent (its nodes move up a level) until everything fits
		const byId = new Map(groups.map((g) => [g.id, g]));
		const folded = new Map();
		for (let guard = 0; guard < 32; guard++) {
			depths = validator.groupDepths(groups.filter((g) => !folded.has(g.id)));
			const deep = groups.find((g) => !folded.has(g.id) && (depths.get(g.id) || { depth: 1 }).depth > HOUSE.groupDepth);
			if (!deep) { break; }
			folded.set(deep.id, deep.parent);
			for (const g of groups) { if (g.parent === deep.id) { g.parent = deep.parent; } }
		}
		const live = groups.filter((g) => !folded.has(g.id));
		const resolveGroup = (id) => { let cur = id, guard = 0; while (folded.has(cur) && guard++ < 32) { cur = folded.get(cur); } return cur; };
		let ungrouped = 0;
		for (const n of out.nodes) {
			if (n.group === undefined) { continue; }
			const g = resolveGroup(n.group);
			if (g !== undefined && byId.has(g) && !folded.has(g)) { n.group = g; } else { delete n.group; ungrouped++; }
		}
		if (folded.size) { notes.push(plural(folded.size, 'group') + ' flattened: nested too deep'); }
		if (regrouped || ungrouped) { notes.push('group references that did not resolve were removed'); }
		// groups left with nothing in them are not drawn
		const used = new Set(out.nodes.map((n) => n.group).filter(Boolean));
		for (let changed = true; changed;) { changed = false; for (const g of live) { if (used.has(g.id) && g.parent && !used.has(g.parent)) { used.add(g.parent); changed = true; } } }
		const keptGroups = live.filter((g) => used.has(g.id));
		if (keptGroups.length) { out.groups = keptGroups; }

		// edges: both ends must exist
		let droppedEdges = 0;
		for (const e of (Array.isArray(spec.edges) ? spec.edges : [])) {
			if (!isObj(e) || !ids.has(e.from) || !ids.has(e.to) || out.edges.length >= HARD.edgesMax) { droppedEdges++; continue; }
			const m = { from: e.from, to: e.to };
			if (typeof e.label === 'string' && e.label) { m.label = truncate(e.label, HOUSE.edgeLabel); }
			if (e.style === 'dashed') { m.style = 'dashed'; }
			if (typeof e.tip === 'string') { m.tip = truncate(e.tip, HARD.tip); }
			out.edges.push(m);
		}
		if (droppedEdges) { notes.push(plural(droppedEdges, 'edge') + ' dropped: no valid ends'); }
		return { spec: out, notes };
	}

	// ---- the ladder -----------------------------------------------------------------------------
	/** What the "auto-fixed" popover and the tool result list: the fixes a person might care about. */
	function visibleFixes(fixes) { return (fixes || []).filter((f) => f.show || f.lossy); }
	const plural = (n, one, many) => n + ' ' + (n === 1 ? one : many);
	/** "2 edges dropped: unknown nodes" — what a degraded diagram's banner says it lost. */
	function lossNotes(fixes) {
		const lossy = (fixes || []).filter((f) => f.lossy);
		const edges = lossy.filter((f) => f.cls === 'unknown-node').length;
		const ids = lossy.filter((f) => f.cls === 'duplicate-id').length;
		const notes = [];
		if (edges) { notes.push(plural(edges, 'edge', 'edges') + ' dropped: unknown nodes'); }
		if (ids) { notes.push(plural(ids, 'duplicate id', 'duplicate ids') + ' renamed'); }
		return notes;
	}
	/** "2 labels shortened" — the short form that sits beside the auto-fixed badge. */
	function fixSummary(fixes) {
		const n = (fixes || []).filter((f) => f.shortened).length;
		return n ? plural(n, 'label', 'labels') + ' shortened' : '';
	}

	/**
	 * Run the ladder for ONE render_diagram call.
	 *
	 *   status   ok         valid as written (defaults aside)                        → draw it
	 *            fixed      rung 1 tidied something, meaning untouched               → draw it, "auto-fixed" badge
	 *            errors     needs the model's one repair pass (only when !final)     → return the error list
	 *            degraded   repair pass spent; the valid part is drawn               → draw it, banner + Retry
	 *            failed     nothing drawable                                         → source + errors + Retry
	 *            truncated  the JSON stops mid-structure                             → re-request, never repair
	 *
	 * @param {any} input  the tool call's arguments (an object), or raw text
	 * @param {{ final?: boolean }} [opts]  final: the model has had its repair pass (or there is no
	 *        model to ask — a replay, a fence) so `errors` is not an option; degrade instead.
	 */
	function prepare(input, opts) {
		const final = !!(opts && opts.final);
		const n = normalize(input);
		if (n.truncated) { return { status: 'truncated', fixes: n.fixes, errors: [{ pointer: '', cls: 'truncated', message: 'the spec was cut off before it was complete.' }], notes: [] }; }
		if (n.syntax) {
			const errors = [{ pointer: '', cls: 'syntax', message: 'not valid JSON (' + n.syntax + '). Send one JSON object with "title", "nodes" and "edges".' }];
			return { status: final ? 'failed' : 'errors', fixes: n.fixes, errors, notes: [] };
		}
		const first = validator.validate(n.spec, { tier: 'house' });
		if (first.ok) {
			const summary = fixSummary(n.fixes);
			return { status: visibleFixes(n.fixes).length ? 'fixed' : 'ok', spec: n.spec, fixes: n.fixes, errors: [], notes: summary ? [summary] : [] };
		}
		if (!final) { return { status: 'errors', fixes: n.fixes, errors: first.errors, notes: [] }; }

		// Rung 3. The same tidy-up again, this time allowed to drop and rename; then cut away
		// whatever is still invalid. `first.errors` is kept: it is what the banner's details show.
		const last = normalize(input, { lossy: true });
		const d = degrade(last.spec);
		if (d) {
			const again = validator.validate(d.spec, { tier: 'hard' });
			if (again.ok) { return { status: 'degraded', spec: d.spec, fixes: last.fixes, errors: first.errors, notes: lossNotes(last.fixes).concat(d.notes) }; }
		}
		return { status: 'failed', fixes: last.fixes, errors: first.errors, notes: [] };
	}

	/**
	 * Accept a spec the RENDERER was handed — from the host, or from a session written by an older
	 * build. It has already been through the ladder once, so this is the cheap re-check that makes
	 * "no unvalidated spec reaches the renderer" true at the last possible moment: migrate, validate
	 * against the HARD tier, and if (and only if) that fails, run the ladder with no model to ask.
	 * @returns {{ ok: boolean, spec?: any, notes?: string[], errors?: any[] }}
	 */
	function accept(spec) {
		const m = validator.migrate(spec);
		const r = validator.validate(m, { tier: 'hard' });
		if (r.ok) {
			// Valid — but the validator checks the fields it knows and is silent about any others, and a
			// record from a session file can carry anything. What is handed on is the declared shape only.
			const declared = schema.project(schema.schemaFor(m.v).hard, m);
			return { ok: true, spec: Object.assign({ v: m.v }, declared), notes: [] };
		}
		const p = prepare(spec, { final: true });
		if (p.spec) { return { ok: true, spec: p.spec, notes: p.notes }; }
		return { ok: false, errors: p.errors };
	}

	return { parseLenient, normalize, degrade, prepare, accept, truncate, slugify, cleanText, visibleFixes, lossNotes, fixSummary };
}));
