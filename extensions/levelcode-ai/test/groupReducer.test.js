/*---------------------------------------------------------------------------------------------
 *  Behavioural tests for the calm-transcript GROUP REDUCER — run: node test/groupReducer.test.js
 *
 *  narrativeUi.test.js covers the grammar (pure strings). This file covers the part that actually
 *  bit: the DOM behaviour. It drives the REAL functions extracted from media/chat.html against a
 *  tiny fake DOM, so the invariants a user would notice are checked without launching the editor:
 *    - a group's header shows the LIVE step while running, the aggregate once closed,
 *    - members render as one-line rows (collapsed) and a FAILING one re-opens (collapse is for
 *      success — a hidden failure is the one thing this UI must never do),
 *    - a single-member group unwraps and hands the card back expanded,
 *    - a background command that exits AFTER its group closed still re-finalizes it,
 *    - grouping off ⇒ everything lands flat in the log, exactly as before.
 *
 *  The fake DOM is deliberately minimal: innerHTML is scanned for class="…" to create queryable
 *  child stubs (the reducer only ever queries by class), and appendChild/insertBefore/remove keep
 *  a real child list. It is not a browser — it is just enough to exercise the reducer honestly.
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

// ── the fake DOM ───────────────────────────────────────────────────────────────────────────────
class El {
	constructor(tag) {
		this.tagName = (tag || 'div').toUpperCase();
		this.children = [];
		this.parent = null;
		this._html = '';
		this._text = '';
		this._stubs = [];        // elements discovered in innerHTML, queryable by class
		this.hidden = false;
		this.onclick = null;
		this.classList = {
			_s: new Set(),
			add: (...c) => c.forEach((x) => this.classList._s.add(x)),
			remove: (...c) => c.forEach((x) => this.classList._s.delete(x)),
			contains: (c) => this.classList._s.has(c),
			toggle: (c) => (this.classList._s.has(c) ? (this.classList._s.delete(c), false) : (this.classList._s.add(c), true))
		};
	}
	set className(v) { this.classList._s = new Set(String(v).split(/\s+/).filter(Boolean)); }
	get className() { return [...this.classList._s].join(' '); }
	set innerHTML(v) {
		this._html = String(v);
		this._stubs = [];
		const re = /class="([^"]+)"/g;
		let m;
		while ((m = re.exec(this._html))) { const s = new El('div'); s.className = m[1]; this._stubs.push(s); }
	}
	get innerHTML() { return this._html; }
	set textContent(v) { this._text = String(v); }
	get textContent() { return this._text; }
	get isConnected() { let n = this; while (n.parent) { n = n.parent; } return n.__root === true; }
	get firstChild() { return this.children[0] || null; }
	appendChild(c) { if (c.parent) { c.parent.removeChild(c); } c.parent = this; this.children.push(c); return c; }
	insertBefore(c, ref) {
		if (c.parent) { c.parent.removeChild(c); }
		c.parent = this;
		const i = this.children.indexOf(ref);
		this.children.splice(i < 0 ? this.children.length : i, 0, c);
		return c;
	}
	removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) { this.children.splice(i, 1); } c.parent = null; }
	remove() { if (this.parent) { this.parent.removeChild(this); } }
	querySelector(sel) {
		const want = String(sel).replace(/^\./, '').split('.')[0];
		for (const s of this._stubs) { if (s.classList.contains(want)) { return s; } }
		for (const c of this.children) { if (c.classList.contains(want)) { return c; } const d = c.querySelector(sel); if (d) { return d; } }
		return null;
	}
}

function newHarness(groupsOn) {
	const log = new El('div');
	log.__root = true;
	const sandbox = {};
	const preamble = 'let curGroup = null; let groupsOn = ' + (groupsOn === false ? 'false' : 'true') + ';\n'
		+ 'let turnLabeled = false;\n'
		+ 'const LC_DOTS = "<dots>";\n'
		+ 'const codicon = (n) => "<i:" + n + ">";\n'
		+ 'const esc = (s) => String(s == null ? "" : s);\n'
		+ 'const IC = { file: 1, search: 1, "list-tree": 1 };\n'
		+ 'const scrollIfStuck = () => {}; const clearEmpty = () => {}; const clearStatus = () => {};\n';
	const src = preamble
		+ [
			'tenseLabel', 'groupAggregate', 'chipStep', 'cmdBase', 'groupCountsHtml', 'openGroup',
			'collapseMember', 'groupAppend', 'refreshGroupHead', 'finalizeGroup', 'closeGroup',
			'groupStepDone', 'groupStepCounts', 'addAgentLine', 'add'
		].map(extract).join('\n')
		+ '\nthis.api = { openGroup, groupAppend, closeGroup, groupStepDone, groupStepCounts, addAgentLine, add, get curGroup(){ return curGroup; } };';
	new Function('document', 'log', src).call(sandbox, { createElement: (t) => new El(t) }, log);
	return { log, api: /** @type {any} */ (sandbox).api };
}

// A stand-in for a term/edit card the reducer receives from the existing add* functions.
const card = (cls) => { const e = new El('div'); e.className = cls; return e; };

let n = 0;
function test(name, fn) { fn(); n++; console.log('  ok - ' + name); }

// ── 1. header states: live step while running → aggregate once closed ──────────────────────────
test('header shows the LIVE step (progressive) while the group runs', () => {
	const h = newHarness();
	h.api.addAgentLine('file', 'read a.js', 'Read the runAgent call site', 'read', 'a.js');
	const cmd = card('tl tl-cmd');
	h.api.groupAppend(cmd, { kind: 'cmd', base: 'Verify the reap wiring', status: 'running', card: cmd });
	assert.strictEqual(h.api.curGroup.label.textContent, 'Verifying the reap wiring');
});

test('header flips to the past-tense aggregate when the group closes', () => {
	const h = newHarness();
	h.api.addAgentLine('file', 'read extension.js', '', 'read', 'extension.js');
	const ed = card('editcard');
	h.api.groupAppend(ed, { kind: 'edit', base: 'Edit extension.js', path: 'extension.js', status: 'done' });
	const cmd = card('tl tl-cmd');
	h.api.groupAppend(cmd, { kind: 'cmd', base: 'Verify the reap wiring', status: 'running', card: cmd });
	const g = h.api.curGroup;
	h.api.groupStepCounts(g.steps[1], 3, 1);
	h.api.groupStepDone(g.steps[2], false);
	assert.ok(!g.el.classList.contains('collapsed'), 'stays open while it runs');
	h.api.closeGroup();
	assert.strictEqual(g.label.textContent, 'Read and edited extension.js, ran a command');
	assert.ok(/\+3/.test(g.counts.innerHTML) && /-1/.test(g.counts.innerHTML), 'summed diffstat in the header');
	// The fold IS the payoff: a finished group is ONE line, not a header plus every finished row.
	assert.ok(g.el.classList.contains('collapsed'), 'a successful group folds to its summary line');
	assert.ok(/i:check/.test(g.node.innerHTML), 'rail states the outcome');
	assert.ok(!/i:sync/.test(g.node.innerHTML), 'and stops wearing the running spinner');
});

test('a group the user opened by hand keeps their choice when it closes', () => {
	const h = newHarness();
	const a = card('tl tl-cmd'), b = card('tl tl-cmd');
	h.api.groupAppend(a, { kind: 'cmd', base: 'Run one', status: 'done', card: a });
	h.api.groupAppend(b, { kind: 'cmd', base: 'Run two', status: 'done', card: b });
	const g = h.api.curGroup;
	g.userToggled = true;                       // they clicked the header mid-run
	h.api.closeGroup();
	assert.ok(!g.el.classList.contains('collapsed'), 'auto-fold never overrides a deliberate click');
});

test('a FAILED group closes open, so the problem is on screen', () => {
	const h = newHarness();
	const a = card('tl tl-cmd'), b = card('tl tl-cmd');
	h.api.groupAppend(a, { kind: 'cmd', base: 'Run one', status: 'done', card: a });
	const step = { kind: 'cmd', base: 'Run two', status: 'running', card: b };
	h.api.groupAppend(b, step);
	const g = h.api.curGroup;
	h.api.groupStepDone(step, true);
	h.api.closeGroup();
	assert.ok(!g.el.classList.contains('collapsed'), 'failures never fold away');
	assert.ok(/circle-slash/.test(g.node.innerHTML), 'rail marks the failure');
});

// ── 2. members are one-line rows; a failure re-opens its row ───────────────────────────────────
test('members render collapsed (one-line rows) inside a group', () => {
	const h = newHarness();
	const a = card('tl tl-cmd'), b = card('tl tl-cmd');
	h.api.groupAppend(a, { kind: 'cmd', base: 'Run the tests', status: 'done', card: a });
	h.api.groupAppend(b, { kind: 'cmd', base: 'Run the linter', status: 'done', card: b });
	assert.ok(a.classList.contains('collapsed') && b.classList.contains('collapsed'));
});

test('a FAILING member re-opens its own row and the group (collapse is for success)', () => {
	const h = newHarness();
	const ok = card('tl tl-cmd'), bad = card('tl tl-cmd');
	h.api.groupAppend(ok, { kind: 'cmd', base: 'Run the tests', status: 'done', card: ok });
	const step = { kind: 'cmd', base: 'Run the linter', status: 'running', card: bad };
	h.api.groupAppend(bad, step);
	const g = h.api.curGroup;
	g.el.classList.add('collapsed');            // user had collapsed the whole group
	h.api.groupStepDone(step, true);            // …then it failed
	assert.ok(!bad.classList.contains('collapsed'), 'failing row expands');
	assert.ok(!g.el.classList.contains('collapsed'), 'group re-opens');
	h.api.closeGroup();
	assert.ok(/circle-slash/.test(g.state.innerHTML), 'group state marks failure');
});

test('a user-stopped command is NOT a failure', () => {
	const h = newHarness();
	const a = card('tl tl-cmd'), b = card('tl tl-cmd');
	h.api.groupAppend(a, { kind: 'cmd', base: 'Run one', status: 'done', card: a });
	const step = { kind: 'cmd', base: 'Run two', status: 'running', card: b };
	h.api.groupAppend(b, step);
	const g = h.api.curGroup;
	h.api.groupStepDone(step, false);           // termExitFinish passes false for how === 'stopped'
	h.api.closeGroup();
	assert.ok(/i:check/.test(g.node.innerHTML), 'group still closes clean');
	assert.strictEqual(g.state.innerHTML, '', 'no second glyph trailing the header');
});

// ── 3. degenerate + late-exit lifecycles ───────────────────────────────────────────────────────
test('a single-member group unwraps and hands the card back EXPANDED', () => {
	const h = newHarness();
	const only = card('tl tl-cmd');
	h.api.groupAppend(only, { kind: 'cmd', base: 'Run the tests', status: 'done', card: only });
	const g = h.api.curGroup;
	h.api.closeGroup();
	assert.ok(!g.el.isConnected, 'group wrapper removed');
	assert.ok(h.log.children.indexOf(only) >= 0, 'member rejoined the log');
	assert.ok(!only.classList.contains('collapsed'), 'standalone card is expanded again');
});

test('a background command exiting AFTER its group closed still re-finalizes the header', () => {
	const h = newHarness();
	const a = card('tl tl-cmd'), bg = card('tl tl-cmd');
	h.api.groupAppend(a, { kind: 'read', base: 'Read a.js', path: 'a.js', status: 'done' });
	const step = { kind: 'cmd', base: 'Start the dev server', status: 'running', card: bg };
	h.api.groupAppend(bg, step);
	const g = h.api.curGroup;
	h.api.closeGroup();                          // narration arrived while the server still ran
	assert.ok(/Starting the dev server/.test(g.label.textContent) === false, 'closed header is an aggregate, not the live step');
	h.api.groupStepDone(step, true);             // server later exits nonzero
	assert.ok(/circle-slash/.test(g.state.innerHTML), 'late failure still marks the closed group');
	assert.ok(!g.el.classList.contains('collapsed'), 'and re-opens it');
});

test('closing twice is a no-op (idempotent)', () => {
	const h = newHarness();
	const a = card('tl tl-cmd'), b = card('tl tl-cmd');
	h.api.groupAppend(a, { kind: 'cmd', base: 'Run one', status: 'done', card: a });
	h.api.groupAppend(b, { kind: 'cmd', base: 'Run two', status: 'done', card: b });
	h.api.closeGroup();
	const before = h.log.children.length;
	h.api.closeGroup();
	assert.strictEqual(h.log.children.length, before);
});

// ── 4. the escape hatch ────────────────────────────────────────────────────────────────────────
test('grouping OFF puts every card straight in the log, uncollapsed', () => {
	const h = newHarness(false);
	const a = card('tl tl-cmd'), b = card('tl tl-cmd');
	h.api.groupAppend(a, { kind: 'cmd', base: 'Run one', status: 'done', card: a });
	h.api.groupAppend(b, { kind: 'cmd', base: 'Run two', status: 'done', card: b });
	assert.strictEqual(h.api.curGroup, null, 'no group is ever opened');
	assert.strictEqual(h.log.children.length, 2);
	assert.ok(!a.classList.contains('collapsed'), 'cards keep their normal expanded form');
});

test('the model label titles the row; the raw tool text stays as the tooltip', () => {
	const h = newHarness();
	h.api.addAgentLine('file', 'read src/agent.js', 'Read the runAgent call site', 'read', 'src/agent.js');
	const row = h.api.curGroup.body.children[0];
	assert.ok(/Read the runAgent call site/.test(row.innerHTML), 'row shows the model sentence');
	assert.ok(/title="read src\/agent\.js"/.test(row.innerHTML), 'raw text preserved as the tooltip');
});

// ── 5. one speaker label per turn ──────────────────────────────────────────────────────────────
// A run narrates repeatedly around its tool cards. Re-stamping "LEVELCODE AI" over every block is
// what made the transcript read as four announcements instead of one person thinking out loud.
const roleOf = (el) => (/class="role">([^<]*)</.exec(el.innerHTML) || [, null])[1];

test('the first narration of a turn is labelled; the rest flow as prose', () => {
	const h = newHarness();
	h.api.add('user', 'do the thing');
	h.api.add('assistant', 'Let me look at the repo first.');
	h.api.add('assistant', 'I have enough context now.');
	h.api.add('assistant', 'Done: created the file.');
	const [u, first, second, third] = h.log.children;
	assert.strictEqual(roleOf(u), 'You');
	assert.strictEqual(roleOf(first), 'LevelCode AI', 'the turn announces itself once');
	assert.strictEqual(roleOf(second), null, 'continuation carries no second label');
	assert.strictEqual(roleOf(third), null);
	assert.ok(!first.classList.contains('cont') && second.classList.contains('cont'),
		'continuations are marked so CSS can tighten the gap');
});

test('a new user message re-arms the label', () => {
	const h = newHarness();
	h.api.add('user', 'first ask');
	h.api.add('assistant', 'working…');
	h.api.add('assistant', 'still working…');
	h.api.add('user', 'second ask');
	h.api.add('assistant', 'on it');
	assert.strictEqual(roleOf(h.log.children[4]), 'LevelCode AI', 'the next turn is labelled again');
});

console.log('groupReducer: ' + n + ' tests passed');
