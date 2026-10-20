/*---------------------------------------------------------------------------------------------
 *  LevelCode — AI: the agent's task list and its hand-back  (docs/PLAN-PROGRESS.md)
 *
 *  Two tools, both pure conversation (no file, no process), and everything they decide is here so it
 *  can be tested without a model, an editor or a webview:
 *
 *    update_plan  the task list the chat shows under the latest message while the agent works. The
 *                 model sends the whole list once ({"items": [...]}) and then small updates
 *                 ({"advance": true}, {"done": [2], "start": 4}). The host keeps each step's STATUS
 *                 by its number, so an update never resends the words.
 *    wrap_up      the end of the work: a short recap, and — only when the next move is the user's —
 *                 one question with one or two replies the user can click. Calling it checks off the
 *                 task list. The chat shows a box only when there is a question.
 *
 *  The shapes follow the Claude desktop app's tools of the same names (read from its app bundle; see
 *  the design note for the evidence). The words are LevelCode's.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

const MAX_STEPS = 12;            // a 13th step is dropped
const STEP_CHARS = 160;          // a step is a short phrase; anything longer is cut
const STATUSES = ['pending', 'in_progress', 'completed'];

const RECAP_CHARS = 300;         // the recap's target: two or three short sentences
const RECAP_HARD = 1200;         // what is kept of a recap that ran long
const ASK_CHARS = 100;           // one decision, one short sentence
const MAX_ACTIONS = 2;           // the recommendation and, at most, one realistic alternative
const LABEL_CHARS = 24;          // a button, not a sentence
const LABEL_WORDS = 4;
const MESSAGE_CHARS = 300;       // what a click sends

/** @typedef {'pending'|'in_progress'|'completed'} StepStatus */
/** @typedef {{ content: string, status: StepStatus }} Step */
/** @typedef {{ label: string, message: string }} Reply */
/** @typedef {{ recap: string, ask: string, actions: Reply[], blocked: boolean }} WrapUp */

// Characters that draw nothing or redraw the line: control and format characters, line and paragraph
// separators, and the fillers that render as blank space. Zero-width joiners stay (emoji need them).
const INVISIBLE = /(?![‌‍])[\p{Cc}\p{Cf}\p{Zl}\p{Zp}ᅟᅠㅤﾠ⠀￼]/gu;

/** One line of plain text: invisible characters out, runs of whitespace to one space, trimmed. */
function oneLine(v) {
	return typeof v === 'string' ? v.normalize('NFC').replace(INVISIBLE, ' ').replace(/\s+/g, ' ').trim() : '';
}

/** Cut at `n` UTF-16 units without leaving half a surrogate pair. */
function cut(s, n) {
	return s.length <= n ? s : s.slice(0, n).replace(/[\uD800-\uDBFF]$/, '');
}

// ── the task list ─────────────────────────────────────────────────────────────────────────────────

/**
 * The steps of a whole list. Takes `items` ({content, status}) and, for conversations started on an
 * older build, `todos` ({title, status} with "done"). A step with no words is skipped; an unknown
 * status is "pending".
 * @param {any} input
 * @returns {Step[]}
 */
function readSteps(input) {
	const list = Array.isArray(input && input.items) ? input.items : (Array.isArray(input && input.todos) ? input.todos : []);
	/** @type {Step[]} */
	const steps = [];
	for (const it of list) {
		if (!it || typeof it !== 'object') { continue; }
		const content = cut(oneLine(typeof it.content === 'string' ? it.content : it.title), STEP_CHARS);
		if (!content) { continue; }
		const st = it.status === 'done' ? 'completed' : it.status;
		steps.push({ content, status: STATUSES.includes(st) ? st : 'pending' });
		if (steps.length >= MAX_STEPS) { break; }
	}
	return steps;
}

/** A step number the list has: a whole number from 1 to n. */
function isStepNumber(v, n) {
	return typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= n;
}

/**
 * Apply a small update to the steps' statuses: `done` marks steps completed, `start` marks one in
 * progress, then `advance` completes the step in progress and starts the next pending one (the first
 * pending one, if none is left after it). Returns a new array.
 * @param {Step[]} steps
 * @param {any} input
 * @returns {Step[]}
 */
function applyUpdate(steps, input) {
	const st = steps.map((s) => s.status);
	if (Array.isArray(input.done)) { for (const n of input.done) { if (isStepNumber(n, st.length)) { st[n - 1] = 'completed'; } } }
	if (isStepNumber(input.start, st.length)) { st[input.start - 1] = 'in_progress'; }
	if (input.advance === true || input.advance === 'true') {
		const at = st.indexOf('in_progress');
		if (at >= 0) { st[at] = 'completed'; }
		const next = st.indexOf('pending', at + 1);
		const n = next >= 0 ? next : st.indexOf('pending');
		if (n >= 0) { st[n] = 'in_progress'; }
	}
	return steps.map((s, i) => ({ content: s.content, status: /** @type {StepStatus} */ (st[i]) }));
}

/** Where the list stands, said for the model. */
function describe(steps) {
	const active = [];
	steps.forEach((s, i) => { if (s.status === 'in_progress') { active.push(i + 1); } });
	if (active.length === 1) { return 'step ' + active[0] + ' of ' + steps.length + ' is in progress'; }
	if (active.length > 1) { return 'steps ' + active.join(', ') + ' of ' + steps.length + ' are in progress; keep one and mark the others {"done": [n]}'; }
	const done = steps.filter((s) => s.status === 'completed').length;
	return done === steps.length ? 'every step is done' : 'no step is in progress (' + done + ' of ' + steps.length + ' done); {"start": n} starts one';
}

/**
 * The update_plan tool. `plan` is the conversation's list, `{ steps: Step[] | null }`, changed in place.
 * Returns what to tell the model, and whether the list changed (then the chat redraws it).
 * @param {any} input
 * @param {{ steps: Step[] | null }} plan
 * @returns {{ text: string, changed: boolean }}
 */
function planTool(input, plan) {
	input = input && typeof input === 'object' ? input : {};
	const numbers = [...(Array.isArray(input.done) ? input.done : []), ...(input.start === undefined ? [] : [input.start])];
	const updating = input.advance === true || input.advance === 'true' || numbers.length > 0;
	if (Array.isArray(input.items) || Array.isArray(input.todos)) {
		const steps = readSteps(input);
		if (!steps.length) { return { text: 'ERROR: the list needs at least one step with content and a status.', changed: false }; }
		plan.steps = steps;
		const busy = steps.filter((s) => s.status === 'in_progress').length;
		return {
			text: 'Task list shown (' + steps.length + ' step' + (steps.length === 1 ? '' : 's') + ').'
				+ (busy > 1 ? ' Keep only one step in_progress.' : '')
				+ (updating ? ' A whole list sets every status, so the advance / done / start sent with it changed nothing; send that again on its own if it still applies.' : ''),
			changed: true
		};
	}
	if (!updating) { return { text: 'ERROR: send {"items": [...]} (the whole list), {"advance": true}, or {"done": [n], "start": m}.', changed: false }; }
	if (!plan.steps || !plan.steps.length) { return { text: 'ERROR: there is no task list yet. Send the whole list first: {"items": [...]}.', changed: false }; }
	const n = plan.steps.length;
	if (numbers.some((x) => !isStepNumber(x, n))) {
		return { text: 'ERROR: nothing changed. Steps are numbered from 1, and the list has ' + n + ' step' + (n === 1 ? '' : 's') + '. Send the update again with numbers that name a step, or the whole list ({"items": [...]}) if the plan changed.', changed: false };
	}
	plan.steps = applyUpdate(plan.steps, input);
	return { text: 'Task list updated: ' + describe(plan.steps) + '.', changed: true };
}

/** Every step completed — what calling wrap_up does to the list. */
function completeAll(steps) {
	return steps.map((s) => ({ content: s.content, status: /** @type {StepStatus} */ ('completed') }));
}

/**
 * A run that ended cleanly without wrap_up: when every step is done but the last, and the last is in
 * progress, the last is done too (the model finished it and simply did not say so). Anything else is
 * left as it is — a list with work still open is not quietly checked off.
 * @param {Step[]} steps
 * @returns {Step[] | null} the new steps, or null when nothing changes
 */
function completeOnCleanEnd(steps) {
	if (!steps || !steps.length) { return null; }
	const last = steps.length - 1;
	const ok = steps.every((s, i) => (i === last ? s.status === 'in_progress' : s.status === 'completed'));
	return ok ? completeAll(steps) : null;
}

// ── the hand-back ─────────────────────────────────────────────────────────────────────────────────

/**
 * A reply that could not be sent as written. Leading "/" would run one of the chat's own commands
 * (/skills, /mcp, /sessions …) instead of reaching the agent, and a leading "!" reads as a shell
 * escape in other tools; invisible characters would hide part of what a click sends.
 */
function unsafeReply(text) {
	return typeof text === 'string' && (/^\s*[/!]/.test(text) || new RegExp(INVISIBLE.source, 'u').test(text.replace(/[\r\n\t]/g, ' ')));
}

/**
 * Read a wrap_up call. `error` is set when there is nothing to show (no recap); `advice` lists what
 * was dropped or cut, for the model's next call.
 * @param {any} input
 * @returns {{ error?: string, wrap?: WrapUp, advice: string[] }}
 */
function readWrapUp(input) {
	input = input && typeof input === 'object' ? input : {};
	const advice = [];
	const recapRaw = typeof input.recap === 'string' ? input.recap.replace(INVISIBLE, ' ').trim() : '';
	if (!recapRaw) { return { error: 'ERROR: recap is required: two or three sentences to the user on what is now true and where it stands.', advice }; }
	if (recapRaw.length > RECAP_CHARS) { advice.push('The recap is two or three sentences (about ' + RECAP_CHARS + ' characters); this one ran ' + recapRaw.length + '.'); }
	const recap = cut(recapRaw.replace(/\s+/g, ' '), RECAP_HARD);
	const ask = cut(oneLine(input.ask), RECAP_HARD);
	if (ask.length > ASK_CHARS) { advice.push('ask is one decision in one short sentence (about ' + ASK_CHARS + ' characters); this one ran ' + ask.length + '.'); }
	const raw = Array.isArray(input.actions) ? input.actions : [];
	/** @type {Reply[]} */
	const actions = [];
	let dropped = false, long = '', longMessage = false;
	for (const a of raw) {
		if (!a || typeof a !== 'object') { continue; }
		const label = oneLine(a.label);
		if (!label) { continue; }
		const message = typeof a.message === 'string' && a.message.trim() ? a.message.trim() : label;
		if (unsafeReply(a.label) || unsafeReply(message)) { dropped = true; continue; }
		if (label.length > LABEL_CHARS || label.split(' ').length > LABEL_WORDS) { long = long || label; }
		if (message.length > MESSAGE_CHARS) { longMessage = true; }
		if (actions.length < MAX_ACTIONS) { actions.push({ label: cut(label, LABEL_CHARS * 2), message: cut(message, MESSAGE_CHARS) }); }
	}
	if (raw.length > MAX_ACTIONS) { advice.push('actions is 1–' + MAX_ACTIONS + ' buttons; this call had ' + raw.length + ', and only the first ' + MAX_ACTIONS + ' are shown.'); }
	if (dropped) { advice.push('A reply whose label or message starts with "/" or "!", or holds an invisible character, is dropped: a click would run one of the chat\'s commands or hide what it sends.'); }
	if (long) { advice.push('A reply label is a button, 1–3 words (' + LABEL_CHARS + ' characters at most); "' + long + '" is too long. Put the detail in message.'); }
	if (longMessage) { advice.push('A reply\'s message is cut at ' + MESSAGE_CHARS + ' characters.'); }
	const blocked = input.blocked === true || input.blocked === 'true';
	if (ask && !actions.length && !blocked) { advice.push('The box showed no question: a question needs at least one reply in actions. When nothing waits on the user, send the recap alone.'); }
	if (!ask && actions.length) { advice.push('The replies were not shown: they answer a question, and this call had no ask.'); }
	return { wrap: { recap, ask: ask && (actions.length || blocked) ? ask : '', actions: ask ? actions : [], blocked }, advice };
}

/** Whether the chat draws the next-step box: a question with replies, or an agent that cannot go on. */
function showsBox(w) {
	return !!w && (w.blocked || (!!w.ask && w.actions.length > 0));
}

/**
 * What the model is told after a wrap_up the chat accepted. When the box holds the question the run
 * ends with this call; otherwise the model's closing answer comes next.
 * @param {WrapUp} w
 * @param {string[]} advice
 */
function wrapUpResult(w, advice) {
	const head = showsBox(w)
		? 'Shown to the user in the next-step box, with your question. The run ends with this call: write nothing after it.'
		: 'Recorded; the task list is checked off. Nothing waits on the user, so no box is shown: write your closing answer now, as the last thing in this run.';
	return head + (advice.length ? ' For next time: ' + advice.join(' ') : '');
}

module.exports = {
	MAX_STEPS, STEP_CHARS, RECAP_CHARS, ASK_CHARS, MAX_ACTIONS, LABEL_CHARS, MESSAGE_CHARS,
	readSteps, applyUpdate, describe, planTool, completeAll, completeOnCleanEnd,
	readWrapUp, showsBox, wrapUpResult
};
