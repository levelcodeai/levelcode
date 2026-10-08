/*---------------------------------------------------------------------------------------------
 *  LevelCode — AI · rich diagrams · what the model is told  (docs/RICH-DIAGRAMS.md, "Diagram spec
 *  and render_diagram tool" + "Prompting and capability detection")
 *
 *  Host-only (never shipped to the webview). Three things live here, and they are the whole of the
 *  model's side of the feature:
 *
 *    RENDER_DIAGRAM   the tool. Its input schema is schema.SCHEMAS[v].house — the same object the
 *                     validator checks against, so what the model is shown is what it is held to.
 *    PROMPT           the rules a rich client adds to the system prompt: when a diagram earns its
 *                     place, that characters are never to be drawn with, and one worked example.
 *    result()         what a call answers: {"ok":true,"id":"d-1"}, or every error at once.
 *
 *  Both cost tokens on every request, so both are kept tight and their size is pinned by a test.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

const schema = require('./schema');
const validator = require('./validate');
const repair = require('./repair');

/**
 * The tool definition (Anthropic shape; translate.js renames it for OpenAI-compatible providers).
 * Read-only and instant — it draws in the chat and touches nothing — so it never asks for approval.
 */
const RENDER_DIAGRAM = Object.freeze({
	name: 'render_diagram',
	description: 'Draw a diagram in the chat (flow, architecture, pipeline, decision tree, state machine). '
		+ 'Describe STRUCTURE only — nodes, edges, optional groups, one accent; the editor does layout and style, so never send coordinates, colours or sizes. '
		+ 'Returns {"ok":true,"id":"d-1"} or a list of problems to fix (then call it once more).',
	input_schema: schema.SCHEMAS[schema.VERSION].house
});

/**
 * Fetch the spec of a diagram drawn earlier. Offered only once a diagram's spec has left the
 * conversation (after a compaction), so it costs nothing until there is something to fetch.
 */
const GET_DIAGRAM = Object.freeze({
	name: 'get_diagram',
	description: 'Fetch the full spec of a diagram drawn earlier in this session, by its id (e.g. "d-17"), so you can edit it and call render_diagram again. '
		+ 'Use it when the conversation only shows a one-line "diagram: …, id d-17" stub.',
	input_schema: { type: 'object', properties: { id: { type: 'string', description: 'The diagram id from the stub, e.g. "d-17".' } }, required: ['id'] }
});

/**
 * The system-prompt block for a client that can render (`client.render === 'rich'`). An ASCII client
 * gets neither this nor the tool.
 *
 * Phase 1 draws boxes-and-arrows only. The block therefore says what to do INSTEAD of a chart or a
 * sequence diagram — telling a model to emit a format the client would show as raw source would be
 * worse than not mentioning it.
 */
const PROMPT = [
	'DIAGRAMS. This client renders real diagrams. When STRUCTURE is the point — a flow, an architecture, a pipeline, a routing or decision tree, a state machine — call render_diagram instead of describing it in a wall of prose. When the answer reads fine as prose, draw nothing.',
	'- NEVER draw boxes, arrows, trees or bars out of characters (no ASCII art, no box-drawing glyphs): they break in this client. render_diagram is the only way to draw.',
	'- Asked for a diagram, DRAW it here with render_diagram. Writing one into a file instead (a diagram language in a document, an image) is only for when the user asks for a file.',
	'- The title states the TAKEAWAY ("Jev classifies; your code decides the action"), not the topic. Labels are short — a name plus at most one line; detail goes in the prose around the diagram, not inside it.',
	'- At most ONE accent: the node the title is about. Same kind of thing, same shape.',
	'- More than 12 nodes: draw an overview, then one diagram per sub-flow.',
	'- When the diagram describes code in this workspace, give nodes a link {path, symbol or line} so the user can click through.',
	'- Numbers to compare go in a Markdown table and steps over time in a numbered list (charts and sequence diagrams are not available yet).',
	'- After it returns ok the user is looking at the picture: do not restate it as a list. Say what it shows in a sentence and continue.',
	'Example call: {"title":"Jev classifies; your code decides the action","nodes":[{"id":"in","label":"Customer message","sub":"plus account details"},{"id":"jev","label":"Jev","sub":"returns probabilities","accent":true},{"id":"bill","label":"Route to billing"},{"id":"rev","label":"Human review"}],"edges":[{"from":"in","to":"jev"},{"from":"jev","to":"bill","label":"0.90 or more"},{"from":"jev","to":"rev","label":"under 0.90"}]}'
].join('\n');

/** How many problem / fix lines one tool result carries. Past this they are counted, not listed. */
const MAX_LINES = 8;
const capLines = (lines) => (lines.length > MAX_LINES ? lines.slice(0, MAX_LINES).concat(['… and ' + (lines.length - MAX_LINES) + ' more.']) : lines);
const fixLine = (f) => (f.pointer || '/') + ': ' + f.message.replace(' (the full text is kept as a tooltip)', '');

/**
 * The tool result for one prepared call.
 * @param {ReturnType<typeof repair.prepare>} prepared
 * @param {{ id?: string, unlinked?: string[] }} [info]  id: the diagram id it was drawn under; unlinked: links that did not resolve
 * @returns {string}
 */
function result(prepared, info) {
	const i = info || {};
	const shown = repair.visibleFixes(prepared.fixes).map(fixLine);
	if (prepared.status === 'ok' || prepared.status === 'fixed') {
		const out = { ok: true, id: i.id };
		if (shown.length) { out.fixed = capLines(shown); }
		if (i.unlinked && i.unlinked.length) { out.unlinked = capLines(i.unlinked); }
		if (shown.length || (i.unlinked && i.unlinked.length)) { out.note = 'Drawn. Redraw only if one of these changed what you meant.'; }
		return JSON.stringify(out);
	}
	if (prepared.status === 'errors') {
		const errs = capLines(validator.formatErrors(prepared.errors).split('\n'));
		const k = prepared.errors.length;
		return 'ERROR: the diagram was not drawn — ' + k + ' problem' + (k === 1 ? '' : 's') + ' in the spec. Fix ' + (k === 1 ? 'it' : 'them') + ' and call render_diagram once more.\n'
			+ errs.join('\n')
			+ (shown.length ? '\nAlso changed to fit (reword them yourself if the wording matters):\n' + capLines(shown).join('\n') : '');
	}
	if (prepared.status === 'truncated') {
		return 'ERROR: the diagram spec was cut off before it was complete (your output hit its length limit). Send the whole spec again, smaller: at most 12 nodes, short labels, no detail in the diagram that belongs in prose.';
	}
	if (prepared.status === 'degraded') {
		return JSON.stringify({ ok: true, id: i.id, degraded: capLines(prepared.notes), note: 'Drawn without the parts that were still invalid; the user can see what was left out and has a Retry button. Do NOT call render_diagram again for this diagram unless the user asks.' });
	}
	// failed
	const first = prepared.errors.length ? validator.formatError(prepared.errors[0]) : 'nothing drawable in the spec';
	return JSON.stringify({ ok: false, id: i.id, error: 'not drawn: ' + first, note: 'The user sees the source, the error and a Retry button. Do NOT call render_diagram again for this diagram unless the user asks; explain it in prose instead.' });
}

/**
 * Did an answer DRAW with characters? The "ASCII leaks" metric: box-drawing glyphs, or frames built
 * from +---+ and | |, in text sent to a client that can render. Conservative on purpose — a table, a
 * file tree in a code block and a single "->" are not diagrams.
 * @param {string} text
 */
function looksLikeAsciiArt(text) {
	const s = String(text || '');
	const boxGlyphs = (s.match(/[─-╿▶◀▲▼]/g) || []).length;
	if (boxGlyphs >= 8) { return true; }
	const lines = s.split('\n');
	const frames = lines.filter((l) => /\+-{3,}\+/.test(l)).length;
	const walls = lines.filter((l) => /^\s*\|.*\|\s*(-+>|<-+)?\s*(\|.*\|)?\s*$/.test(l) && !/\|\s*:?-{3,}/.test(l)).length;
	if (frames >= 2 && walls >= 1) { return true; }
	const arrows = lines.filter((l) => /(\]|\)|\w)\s*(-{2,}>|={2,}>)\s*(\[|\(|\w)/.test(l) && /[\[(|]/.test(l)).length;
	return arrows >= 3 && frames >= 1;
}

module.exports = { RENDER_DIAGRAM, GET_DIAGRAM, PROMPT, result, looksLikeAsciiArt, MAX_LINES };
