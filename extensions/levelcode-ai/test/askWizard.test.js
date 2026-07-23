/*---------------------------------------------------------------------------------------------
 *  Behavioural tests for the ask_user card — run: node test/askWizard.test.js
 *
 *  Several questions used to render stacked in one card with a single "Send answers" button. It
 *  was easy to answer the first, not notice the rest, and send a half-filled form — the agent then
 *  acted on defaults the user never chose. The card now shows ONE question at a time.
 *
 *  The invariants worth protecting, all of them clicked through here against the real function
 *  extracted from media/chat.html:
 *    - nothing is posted until the LAST question — the button advances before that,
 *    - passing over a question is deliberate: with nothing picked the button reads "Skip this one",
 *    - Back returns to a previous question with its selection intact,
 *    - the posted payload keeps every question in order, skipped ones included as empty,
 *    - a single question keeps the plain card (no step chrome, sends straight away).
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'media', 'chat.html'), 'utf8');

function extract(name) {
	const start = html.indexOf('function ' + name + '(');
	assert.ok(start >= 0, 'chat.html no longer defines ' + name + '()');
	const end = html.indexOf('\n  }', start);
	assert.ok(end >= 0, 'no closing brace found for ' + name + '()');
	return html.slice(start, end + 4);
}

// ── a fake DOM with just enough attribute support to drive the card ────────────────────────────
// The card is built as one innerHTML string and then wired by class, so the parser records every
// tag's classes and data-* attributes and serves them back through querySelector(All).
class El {
	constructor(tag) {
		this.tagName = (tag || 'div').toUpperCase();
		this.children = [];
		this._html = '';
		this._nodes = [];
		this.dataset = {};
		this.hidden = false;
		this.disabled = false;
		this.value = '';
		this.textContent = '';
		this.onclick = null;
		this.classList = {
			_s: new Set(),
			add: (...c) => c.forEach((x) => this.classList._s.add(x)),
			remove: (...c) => c.forEach((x) => this.classList._s.delete(x)),
			contains: (c) => this.classList._s.has(c),
			toggle: (c, force) => {
				const on = force === undefined ? !this.classList._s.has(c) : !!force;
				if (on) { this.classList._s.add(c); } else { this.classList._s.delete(c); }
				return on;
			}
		};
	}
	set className(v) { this.classList._s = new Set(String(v).split(/\s+/).filter(Boolean)); }
	get className() { return [...this.classList._s].join(' '); }
	set innerHTML(v) {
		this._html = String(v);
		this._nodes = [];
		for (const t of this._html.matchAll(/<(\w+)([^>]*)>/g)) {
			const attrs = t[2];
			if (!/class="/.test(attrs)) { continue; }
			const el = new El(t[1]);
			el.className = /class="([^"]*)"/.exec(attrs)[1];
			for (const d of attrs.matchAll(/data-([\w-]+)="([^"]*)"/g)) { el.dataset[d[1]] = d[2]; }
			if (/\shidden(?=[\s>/])/.test(attrs + ' ')) { el.hidden = true; }
			// text up to the next tag — enough for the labels the card ships in its markup
			el.textContent = (/^([^<]*)/.exec(this._html.slice(t.index + t[0].length)) || ['', ''])[1].trim();
			this._nodes.push(el);
		}
	}
	get innerHTML() { return this._html; }
	appendChild(c) { this.children.push(c); return c; }
	_match(sel) {
		const m = /^\.([\w-]+)(?:\[([\w-]+)="([^"]*)"\])?$/.exec(String(sel).trim());
		assert.ok(m, 'fake DOM cannot parse selector: ' + sel);
		const [, cls, attr, val] = m;
		return this._nodes.filter((n) => n.classList.contains(cls)
			&& (!attr || n.dataset[attr.replace(/^data-/, '')] === val));
	}
	querySelector(sel) { return this._match(sel)[0] || null; }
	querySelectorAll(sel) { return this._match(sel); }
}

function newCard(questions) {
	const log = new El('div');
	const posted = [];
	const sandbox = {};
	const preamble = 'const codicon = (n) => "<i:" + n + ">";\n'
		+ 'const esc = (s) => String(s == null ? "" : s);\n'
		+ 'const clearEmpty = () => {}; const clearStatus = () => {}; const closeGroup = () => {};\n'
		+ 'const scrollIfStuck = () => {}; let agentBubble = null;\n';
	new Function('document', 'log', 'vscode', preamble + extract('addQuestions') + '\nthis.addQuestions = addQuestions;')
		.call(sandbox, { createElement: (t) => new El(t) }, log, { postMessage: (msg) => posted.push(msg) });
	/** @type {any} */ (sandbox).addQuestions({ id: 'q1', questions });
	const card = log.children[0];
	return {
		card, posted,
		send: card.querySelector('.qsend'),
		back: card.querySelector('.qback'),
		step: card.querySelector('.qstep'),
		notes: card.querySelector('.qnotes'),
		pick: (qi, oi) => card.querySelectorAll('.qopt[data-q="' + qi + '"]')[oi].onclick(),
		curIndex: () => card.querySelectorAll('.qblock').findIndex((b) => b.classList.contains('cur'))
	};
}

const Q = (header, ...labels) => ({ header, question: header + '?', options: labels.map((l) => ({ label: l })) });
const THREE = [Q('Target', 'A', 'B'), Q('Content', 'C', 'D'), Q('Style', 'E', 'F')];

let n = 0;
function test(name, fn) { fn(); n++; console.log('  ok - ' + name); }

// ── 1. one at a time ───────────────────────────────────────────────────────────────────────────
test('several questions open on the first one alone', () => {
	const c = newCard(THREE);
	assert.ok(c.card.classList.contains('wizard'));
	assert.strictEqual(c.curIndex(), 0, 'only the first block is current');
	assert.strictEqual(c.step.textContent, '1 of 3');
	assert.ok(c.back.hidden, 'nothing to go back to yet');
});

test('with nothing picked the button offers to SKIP, not to send', () => {
	const c = newCard(THREE);
	assert.strictEqual(c.send.textContent, 'Skip this one');
	assert.ok(c.send.classList.contains('ghost'), 'and it steps down to a quiet style');
});

test('picking an option turns it into the advance button', () => {
	const c = newCard(THREE);
	c.pick(0, 1);
	assert.strictEqual(c.send.textContent, 'Next question');
	assert.ok(!c.send.classList.contains('ghost'));
});

// ── 2. nothing escapes early ───────────────────────────────────────────────────────────────────
test('the button ADVANCES on every question but the last — no early post', () => {
	const c = newCard(THREE);
	c.pick(0, 0); c.send.onclick();
	assert.deepStrictEqual(c.posted, [], 'nothing sent after question 1');
	assert.strictEqual(c.curIndex(), 1);
	assert.strictEqual(c.step.textContent, '2 of 3');
	assert.ok(!c.back.hidden, 'Back appears once there is somewhere to go back to');

	c.pick(1, 0); c.send.onclick();
	assert.deepStrictEqual(c.posted, [], 'nothing sent after question 2');
	assert.strictEqual(c.send.textContent, 'Send answers', 'only the last step sends');
	assert.ok(c.card.classList.contains('laststep'), 'and the free-text box appears with it');
});

test('the final step posts every answer, in order', () => {
	const c = newCard(THREE);
	c.pick(0, 1); c.send.onclick();
	c.pick(1, 0); c.send.onclick();
	c.pick(2, 1); c.send.onclick();
	assert.strictEqual(c.posted.length, 1);
	assert.strictEqual(c.posted[0].type, 'questionsResponse');
	assert.deepStrictEqual(c.posted[0].answers.map((a) => a.selected), [['B'], ['C'], ['F']]);
	assert.deepStrictEqual(c.posted[0].answers.map((a) => a.header), ['Target', 'Content', 'Style']);
});

test('a skipped question posts as empty — recorded, not silently defaulted', () => {
	const c = newCard(THREE);
	c.send.onclick();                       // "Skip this one"
	c.pick(1, 1); c.send.onclick();
	c.pick(2, 0); c.send.onclick();
	assert.deepStrictEqual(c.posted[0].answers.map((a) => a.selected), [[], ['D'], ['E']]);
});

// ── 3. going back ──────────────────────────────────────────────────────────────────────────────
test('Back returns to the previous question with its answer still selected', () => {
	const c = newCard(THREE);
	c.pick(0, 1); c.send.onclick();
	c.back.onclick();
	assert.strictEqual(c.curIndex(), 0);
	assert.strictEqual(c.step.textContent, '1 of 3');
	assert.strictEqual(c.send.textContent, 'Next question', 'the earlier pick is still held');
	assert.ok(c.back.hidden, 'and Back retires at the start again');
});

test('changing a mind on the way back is what gets posted', () => {
	const c = newCard(THREE);
	c.pick(0, 0); c.send.onclick();
	c.back.onclick(); c.pick(0, 1);         // switch A → B
	c.send.onclick();
	c.pick(1, 0); c.send.onclick();
	c.pick(2, 0); c.send.onclick();
	assert.deepStrictEqual(c.posted[0].answers[0].selected, ['B']);
});

// ── 4. the shapes that must not gain step chrome ───────────────────────────────────────────────
test('a single question keeps the plain card and sends straight away', () => {
	const c = newCard([Q('Target', 'A', 'B')]);
	assert.ok(!c.card.classList.contains('wizard'), 'no step chrome for one question');
	assert.strictEqual(c.send.textContent, 'Send answers');
	c.pick(0, 0); c.send.onclick();
	assert.strictEqual(c.posted.length, 1);
	assert.deepStrictEqual(c.posted[0].answers[0].selected, ['A']);
});

test('multiSelect collects several picks before advancing', () => {
	const c = newCard([{ header: 'Pick', question: 'Which?', multiSelect: true, options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }] },
		Q('Then', 'X', 'Y')]);
	c.pick(0, 0); c.pick(0, 2);
	assert.strictEqual(c.send.textContent, 'Next question');
	c.send.onclick();
	c.pick(1, 0); c.send.onclick();
	assert.deepStrictEqual(c.posted[0].answers[0].selected, ['A', 'C']);
});

// ── 5. the record left behind ──────────────────────────────────────────────────────────────────
test('once sent, the card folds itself away and says so', () => {
	const c = newCard(THREE);
	c.pick(0, 0); c.send.onclick();
	c.pick(1, 0); c.send.onclick();
	c.pick(2, 0); c.send.onclick();
	assert.ok(c.card.classList.contains('collapsed'), 'the finished card gets out of the way');
	assert.ok(c.card.classList.contains('answered'));
	assert.ok(/Answers recorded/.test(c.card.querySelector('.qtitle').innerHTML),
		'and the header — the only thing still on screen — states the outcome');
});

test('unfolding it shows every question as a frozen record', () => {
	const c = newCard(THREE);
	c.pick(0, 0); c.send.onclick();
	c.pick(1, 0); c.send.onclick();
	c.pick(2, 0); c.send.onclick();
	assert.ok(!c.card.classList.contains('wizard'), 'all questions revealed, not just the last one');
	assert.ok(c.card.querySelectorAll('.qopt').every((b) => b.disabled), 'answers are no longer editable');
	assert.ok(/Answers recorded/.test(c.card.querySelector('.qbtns').innerHTML));
});

console.log('askWizard: ' + n + ' tests passed');
