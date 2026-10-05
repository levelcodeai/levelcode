/*---------------------------------------------------------------------------------------------
 *  LevelCode — AI · rich diagrams · one conversation's diagrams  (docs/RICH-DIAGRAMS.md,
 *  "Validation and repair → Repair ladder" + "Storage")
 *
 *  repair.prepare() climbs the ladder for ONE call. This is what remembers across calls:
 *
 *    • whether the model has already had its one repair pass for a diagram — so the second failure
 *      degrades instead of bouncing again ("no automatic second repair"),
 *    • that a diagram sent back for repair still owes the user a picture — so if the model never
 *      answers, the run does not end on an empty placeholder ("no blank output"),
 *    • every diagram this conversation has drawn, by id — so a node can be clicked, a picture
 *      exported, a spec fetched back after the conversation is compacted, and a reopened chat shows
 *      exactly what it showed before, without running the ladder again ("re-opening a chat never
 *      re-runs repair").
 *
 *  vscode-free and deterministic: the host injects how a link is resolved and where numbers go, and
 *  gets back the tool result to return to the model plus the messages to post to the chat.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

const repair = require('./repair');
const validator = require('./validate');
const text = require('./text');
const tool = require('./tool');

/** A model that keeps sending broken specs gets this many repair passes in one run, then no more. */
const MAX_BOUNCES_PER_RUN = 3;
/** How much of an undrawable input is kept so the user can see what was sent. */
const SOURCE_CAP = 8000;

const norm = (s) => String(s == null ? '' : s).toLowerCase().replace(/\s+/g, ' ').trim();
const idsOf = (input) => {
	const nodes = input && typeof input === 'object' && Array.isArray(input.nodes) ? input.nodes : [];
	return nodes.map((n) => norm(n && typeof n === 'object' ? (n.id != null ? n.id : n.label) : n)).filter(Boolean);
};
const titleOf = (input) => norm(input && typeof input === 'object' ? input.title : '');
/** Is this call another go at the same diagram? Same title, or mostly the same nodes. */
function sameDiagram(a, b) {
	if (a.title && a.title === b.title) { return true; }
	if (!a.ids.length || !b.ids.length) { return false; }
	const set = new Set(a.ids);
	const shared = b.ids.filter((id) => set.has(id)).length;
	return shared / Math.max(a.ids.length, b.ids.length) >= 0.5;
}
/** The title a (possibly unparseable) input claims, cleaned and bounded — or ''. */
function titleFrom(input) {
	let t = input && typeof input === 'object' ? input.title : null;
	if (typeof input === 'string') { const m = /"title"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(input); if (m) { try { t = JSON.parse('"' + m[1] + '"'); } catch (e) { t = m[1]; } } }
	return typeof t === 'string' ? repair.cleanText(t).slice(0, 120) : '';
}
const countBy = (items, key) => { const out = {}; for (const it of items) { out[it[key]] = (out[it[key]] || 0) + 1; } return out; };
function sourceOf(input) {
	let s;
	try { s = typeof input === 'string' ? input : JSON.stringify(input, null, 2); } catch (e) { s = String(input); }
	s = String(s == null ? '' : s);
	return s.length > SOURCE_CAP ? s.slice(0, SOURCE_CAP) + '\n… (' + (s.length - SOURCE_CAP) + ' more characters)' : s;
}

/**
 * @param {{ resolveLink?: (link: {path:string, symbol?:string, line?:number}) => ({ ok: true, path: string } | { ok: false, reason: string }),
 *           onStat?: (ev: any) => void, now?: () => Date }} [opts]
 */
function createDiagrams(opts) {
	const o = opts || {};
	const stat = (ev) => { if (typeof o.onStat === 'function') { try { o.onStat(ev); } catch (e) { /* counting must never break drawing */ } } };
	const iso = () => (o.now ? o.now() : new Date()).toISOString();

	/** @type {Map<string, any>} */
	const records = new Map();
	/** @type {Map<string, string>} */
	const byKey = new Map();
	let seq = 0;
	let fresh = [];          // records made since the host last took them (to persist with the turn)
	let run = { pending: null, bounces: 0, drawn: [] };

	const nextId = () => { let id; do { id = 'd-' + (++seq); } while (records.has(id)); return id; };

	/** Keep only the links the host says may be opened; the rest become plain text. */
	function resolveLinks(spec) {
		const unlinked = [];
		for (const n of spec.nodes) {
			if (!n.link) { continue; }
			let r = null;
			try { r = typeof o.resolveLink === 'function' ? o.resolveLink(n.link) : { ok: false, reason: 'links are unavailable here' }; } catch (e) { r = { ok: false, reason: 'could not be checked' }; }
			if (r && r.ok) {
				const link = { path: String(r.path) };
				if (n.link.symbol) { link.symbol = n.link.symbol; }
				if (n.link.line) { link.line = n.link.line; }
				n.link = link;
			} else {
				unlinked.push(n.id + ': ' + ((r && r.reason) || 'not a file in this workspace'));
				delete n.link;
			}
		}
		return unlinked;
	}

	/** File a finished diagram (drawn, cut down, or failed) and build the message that shows it. */
	function commit(prepared, meta, extra) {
		const id = nextId();
		const record = {
			id, key: String(meta.key || id), v: prepared.spec ? prepared.spec.v : null, at: iso(),
			status: prepared.status,
			spec: prepared.spec || null,
			fixes: repair.visibleFixes(prepared.fixes).map((f) => (f.pointer || '/') + ': ' + f.message),
			notes: prepared.notes.slice(),
			errors: validator.formatErrors(prepared.errors).split('\n').filter(Boolean)
		};
		if (meta.model) { record.model = String(meta.model); }
		if (!prepared.spec) {
			// Nothing was drawn, so there is no spec to read a title from; keep what the model called it.
			record.source = sourceOf(extra && extra.input);
			const t = titleFrom(extra && extra.input);
			if (t) { record.title = t; }
		}
		if (extra && extra.repaired) { record.repaired = true; }           // "the repaired spec is stored and marked as repaired"
		if (extra && extra.replaces) { record.replaces = extra.replaces; }
		records.set(id, record);
		byKey.set(record.key, id);
		fresh.push(record);
		const msg = { type: 'diagram', key: record.key, record };
		if (extra && extra.replacesKey) { msg.replacesKey = extra.replacesKey; }
		return { record, msg };
	}

	/** A diagram that was sent back and never came back right: draw what can be drawn of the original. */
	function settlePending() {
		const p = run.pending;
		if (!p) { return []; }
		run.pending = null;
		const prepared = repair.prepare(p.input, { final: true });
		let unlinked = [];
		if (prepared.spec) { unlinked = resolveLinks(prepared.spec); }
		if (unlinked.length) { prepared.notes = prepared.notes.concat([unlinked.length + ' link' + (unlinked.length === 1 ? '' : 's') + ' removed: not files in this workspace']); }
		stat({ type: 'call', model: p.model, format: 'graph', outcome: prepared.status === 'degraded' ? 'degraded' : prepared.status === 'failed' ? 'failed' : 'fixed', errorClasses: validator.errorClasses(prepared.errors), fixClasses: countBy(prepared.fixes, 'cls') });
		return [commit(prepared, { key: p.key, model: p.model }, { input: p.input }).msg];
	}

	/** A run begins: nothing is owed, and the model has its repair passes back. */
	function beginRun() { run = { pending: null, bounces: 0, drawn: [] }; }
	/** A run ends. Returns the messages that settle anything still owed. */
	function endRun() { const post = settlePending(); run = { pending: null, bounces: 0, drawn: [] }; return post; }

	/**
	 * One render_diagram call.
	 * @param {any} input  the tool call's arguments
	 * @param {{ key: string, model?: string }} meta  key: the tool_use id (the chat placeholder is keyed by it)
	 * @returns {{ result: string, post: any[] }}  the tool result for the model, and what to show
	 */
	function render(input, meta) {
		const m = meta || { key: '' };
		const me = { title: titleOf(input), ids: idsOf(input) };
		const post = [];
		let pending = run.pending;
		// Something else was sent back for repair and the model has moved on to a different diagram:
		// settle the old one now, so its placeholder does not wait for a call that is not coming.
		if (pending && !sameDiagram(pending, me)) { for (const msg of settlePending()) { post.push(msg); } pending = null; }

		const isRepair = !!pending;
		const final = isRepair || run.bounces >= MAX_BOUNCES_PER_RUN;
		const prepared = repair.prepare(input, { final });
		const tokens = Math.round(sourceOf(input).length / 4);
		const classes = { errorClasses: validator.errorClasses(prepared.errors), fixClasses: countBy(prepared.fixes, 'cls') };

		if (prepared.status === 'truncated') {
			stat(Object.assign({ type: 'call', model: m.model, format: 'graph', outcome: 'truncated', tokens }, classes));
			return { result: tool.result(prepared), post };   // re-requested, never repaired; whatever was pending stays pending
		}
		if (prepared.status === 'errors') {
			// Rung 2: the model's one repair pass. Remember what it owes, and say so in the chat.
			run.pending = { key: String(m.key), input, model: m.model, title: me.title, ids: me.ids };
			run.bounces++;
			stat(Object.assign({ type: 'call', model: m.model, format: 'graph', outcome: 'bounced', tokens }, classes));
			post.push({ type: 'diagramPending', key: String(m.key), state: 'repairing', title: typeof (input && input.title) === 'string' ? repair.cleanText(input.title).slice(0, 120) : '' });
			return { result: tool.result(prepared), post };
		}

		run.pending = null;
		let unlinked = [];
		if (prepared.spec) { unlinked = resolveLinks(prepared.spec); }
		// A second drawing of the same thing in the same run takes the first one's place in the chat.
		const earlier = prepared.spec ? run.drawn.find((d) => d.title === me.title && me.title) : null;
		const { record, msg } = commit(prepared, m, { input, repaired: isRepair && !!prepared.spec, replaces: earlier ? earlier.id : undefined, replacesKey: isRepair ? pending.key : (earlier ? earlier.key : undefined) });
		if (prepared.spec) { run.drawn = run.drawn.filter((d) => d !== earlier).concat([{ id: record.id, key: record.key, title: me.title }]); }
		post.push(msg);

		const outcome = prepared.status === 'degraded' || prepared.status === 'failed' ? prepared.status
			: isRepair ? 'repaired'
				: prepared.status === 'fixed' ? 'fixed'
					: prepared.fixes.length ? 'tidied' : 'clean';
		stat(Object.assign({ type: 'call', model: m.model, format: 'graph', outcome, tokens }, classes));
		return { result: tool.result(prepared, { id: record.id, unlinked }), post };
	}

	/** The tool arguments were cut off (malformed JSON at the token cap): re-request, never repair. */
	function truncated(meta) {
		stat({ type: 'call', model: meta && meta.model, format: 'graph', outcome: 'truncated' });
		return { result: tool.result({ status: 'truncated', fixes: [], errors: [], notes: [] }), post: [] };
	}

	const get = (id) => records.get(String(id)) || null;
	const byToolUse = (key) => (byKey.has(String(key)) ? records.get(byKey.get(String(key))) : null);
	const list = () => Array.from(records.values());
	/** Records made since the last call — what the host persists alongside the turn. */
	const takeNew = () => { const out = fresh; fresh = []; return out; };

	/**
	 * A session was reopened: take its stored diagrams back. A record on disk is input too — a session
	 * file can be edited, cut short or written by an older build — so each spec passes the validator on
	 * the way in, exactly as a model's does. What the host then acts on (a link to open, a file to
	 * export, a stub, get_diagram) is only ever a spec that was accepted; one that is not is kept as a
	 * diagram that was never drawn. Nothing here calls a model, and a valid record comes back unchanged.
	 */
	function load(stored) {
		records.clear(); byKey.clear(); fresh = []; seq = 0;
		for (const r of (Array.isArray(stored) ? stored : [])) {
			if (!r || typeof r !== 'object' || typeof r.id !== 'string' || !/^d-\d+$/.test(r.id)) { continue; }
			let rec = r;
			if (r.spec != null) {
				let ok = null;
				try { ok = repair.accept(r.spec); } catch (e) { ok = null; }
				rec = Object.assign({}, r, ok && ok.ok ? { spec: ok.spec } : { spec: null, status: 'failed' });
			}
			records.set(rec.id, rec);
			if (rec.key) { byKey.set(String(rec.key), rec.id); }
			seq = Math.max(seq, Number(rec.id.slice(2)) || 0);
		}
		beginRun();
	}
	function reset() { records.clear(); byKey.clear(); fresh = []; seq = 0; beginRun(); }

	/** get_diagram: the spec as the model would write it, or a plain reason there is none. */
	function fetch(id) {
		const want = String(id == null ? '' : id).trim();
		const r = get(want);
		if (!r) {
			const known = list().filter((x) => x.spec).map((x) => x.id);
			return 'ERROR: no diagram with id "' + want.slice(0, 40) + '" in this session.' + (known.length ? ' Known ids: ' + validator.listIds(known) + '.' : ' None has been drawn yet.');
		}
		if (!r.spec) { return 'ERROR: diagram ' + r.id + ' was never drawn (its spec was invalid). Draw it again with render_diagram.'; }
		return text.toSource(r.spec);
	}

	/**
	 * The one-line stubs for every diagram whose spec is in `messages` — what replaces those specs
	 * when that stretch of the conversation is compacted. Nothing here runs turn by turn.
	 */
	function stubsFor(messages) {
		const out = [];
		for (const msg of (Array.isArray(messages) ? messages : [])) {
			if (!msg || msg.role !== 'assistant' || !Array.isArray(msg.content)) { continue; }
			for (const b of msg.content) {
				if (!b || b.type !== 'tool_use' || b.name !== tool.RENDER_DIAGRAM.name) { continue; }
				const r = byToolUse(b.id);
				if (r && r.spec) { out.push(text.stub(r)); }
			}
		}
		return out;
	}

	/** One finished answer to a client that can render: did it draw with characters anyway? */
	function noteAnswer(answer) { stat({ type: 'answer', asciiArt: tool.looksLikeAsciiArt(answer) }); }

	return { beginRun, endRun, render, truncated, noteAnswer, get, byToolUse, list, takeNew, load, reset, fetch, stubsFor, get pending() { return run.pending ? run.pending.key : null; } };
}

module.exports = { createDiagrams, sameDiagram, MAX_BOUNCES_PER_RUN, SOURCE_CAP };
