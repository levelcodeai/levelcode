/*---------------------------------------------------------------------------------------------
 *  The turn box and the queue band, in the chat page — run: node test/planProgressUi.test.js
 *
 *  docs/PLAN-PROGRESS.md. The page's decisions are lifted out of the shipped media/chat.html and run
 *  here (the way narrativeUi.test.js lifts its grammar), so this is the real code, not a copy:
 *
 *    • the long-list window: one finished step above the one in progress, "N earlier steps", "N more to go"
 *    • what the card shows — the list only while a run works, a stale list's caption, no spinner while the
 *      agent waits on you, the next-step box only after the run and only when it asks something
 *    • the card's markup: a word for screen readers on every icon, the recommended reply first, and
 *      everything the model wrote shown as TEXT
 *    • the queue: one row or a folded stack, "Send now" only where it can work, and the run's end —
 *      the first message sent after a run that finished, all of them given back after one that did not
 *    • the wiring: Enter while the agent works queues instead of stopping it, ■ still stops, a reply
 *      button while busy queues too
 *
 *  What it cannot see — paint, animation, focus, drag — scripts/plan-progress-editor-check.js checks in
 *  the real editor.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'media', 'chat.html'), 'utf8');
const scriptOpen = html.lastIndexOf('<script');
const script = html.slice(html.indexOf('>', scriptOpen) + 1, html.indexOf('</script>', scriptOpen));

/** A function written over several lines: from `function name(` to its closing brace at two spaces. */
function extract(name) {
	let start = script.indexOf('  function ' + name + '(');
	if (start < 0) { start = script.indexOf('  async function ' + name + '('); }
	assert.ok(start >= 0, 'chat.html no longer defines ' + name + '()');
	const oneLine = script.indexOf('\n', start);
	if (/\}\s*$/.test(script.slice(start, oneLine)) && !/\{\s*$/.test(script.slice(start, oneLine))) { return script.slice(start, oneLine); }
	const end = script.indexOf('\n  }', start);
	assert.ok(end >= 0, 'no closing brace found for ' + name + '()');
	return script.slice(start, end + 4);
}
/** A `const` the functions read, as written. */
function constant(name) {
	const start = script.indexOf('  const ' + name + ' = ');
	assert.ok(start >= 0, 'chat.html no longer declares ' + name);
	if (name === 'IC') { return script.slice(start, script.indexOf('\n  };', start) + 5); }
	return script.slice(start, script.indexOf('\n', start));
}

let n = 0;
function test(name, fn) { fn(); n++; console.log('  ok - ' + name); }

// ── the card ────────────────────────────────────────────────────────────────────────────────────
const card = {};
new Function(
	[constant('IC'), extract('esc'), extract('escAttr'), extract('codicon'), constant('TB_WINDOW'), constant('TB_WAITING'),
		extract('planWindow'), extract('turnView'), extract('tbInline'), extract('turnBoxHtml'),
		'Object.assign(this, { planWindow, turnView, turnBoxHtml, TB_WINDOW, TB_WAITING });'].join('\n')
).call(card);
const { planWindow, turnView, turnBoxHtml, TB_WINDOW, TB_WAITING } = /** @type {any} */ (card);

const steps = (...st) => st.map((s, i) => ({ content: 'step ' + (i + 1), status: s }));
const many = (active) => Array.from({ length: 20 }, (_, i) => ({ content: 'step ' + (i + 1), status: i < active ? 'completed' : i === active ? 'in_progress' : 'pending' }));

test('WINDOW: a short list shows whole', () => {
	const w = planWindow(steps('completed', 'in_progress', 'pending'), TB_WINDOW);
	assert.deepStrictEqual([w.rows.length, w.earlier, w.more], [3, 0, 0]);
});
test('WINDOW: a long list starts one step above the one in progress, and counts what it cuts', () => {
	const w = planWindow(many(10), 8);
	assert.deepStrictEqual(w.rows.map((r) => r.content), ['step 10', 'step 11', 'step 12', 'step 13', 'step 14', 'step 15', 'step 16', 'step 17']);
	assert.deepStrictEqual([w.earlier, w.more], [9, 3]);
});
test('WINDOW: near the end it never runs past the last step; at the start nothing is "earlier"', () => {
	const end = planWindow(many(19), 8);
	assert.deepStrictEqual([end.rows[0].content, end.rows[7].content, end.earlier, end.more], ['step 13', 'step 20', 12, 0]);
	const start = planWindow(many(0), 8);
	assert.deepStrictEqual([start.rows[0].content, start.earlier, start.more], ['step 1', 0, 12]);
	const allDone = planWindow(many(20), 8);
	assert.deepStrictEqual([allDone.rows[7].content, allDone.more], ['step 20', 0], 'a finished list shows its end');
});
test('WINDOW: nothing in progress — the window opens at the first open step', () => {
	const s = many(12); s[12].status = 'pending';
	assert.strictEqual(planWindow(s, 8).rows[0].content, 'step 12');
});

const T = (o) => Object.assign({ steps: steps('completed', 'in_progress', 'pending'), stale: false, running: true, wrap: null }, o);
const ask = { recap: 'Dates parse now.', ask: 'Run the tests?', actions: [{ label: 'Yes, run them', message: 'Run the tests.' }, { label: 'Not now', message: 'Not now' }], blocked: false, dismissed: false };

test('VIEW: while a run works, the list — spinning unless the agent waits on you', () => {
	assert.strictEqual(turnView(T({}), false).plan.spin, true);
	assert.strictEqual(turnView(T({}), true).plan.spin, false, 'waiting on an approval or a question: no spinner');
	assert.strictEqual(turnView(T({}), false).next, null);
});
test('VIEW: when the run is over the list goes; with no question, nothing is shown', () => {
	assert.deepStrictEqual(turnView(T({ running: false }), false), { plan: null, next: null });
	assert.deepStrictEqual(turnView(T({ running: false, wrap: Object.assign({}, ask, { ask: '', actions: [] }) }), false), { plan: null, next: null }, 'a recap alone draws no box');
});
test('VIEW: a list from before your message keeps a caption and does not spin — unless it was finished', () => {
	const v = turnView(T({ stale: true }), false);
	assert.deepStrictEqual([v.plan.stale, v.plan.spin], [true, false]);
	assert.strictEqual(turnView(T({ stale: true, steps: steps('completed', 'completed') }), false).plan, null);
	assert.ok(turnView(T({ stale: false, steps: steps('completed', 'completed') }), false).plan, 'a list this run finished stays until the run ends');
});
test('VIEW: the next-step box — only after the run, only with a question or a block, and gone once dismissed', () => {
	assert.strictEqual(turnView(T({ wrap: ask }), false).next, null, 'not while the run is still writing its closing answer');
	const v = turnView(T({ running: false, wrap: ask }), false);
	assert.deepStrictEqual(v.next, { recap: 'Dates parse now.', ask: 'Run the tests?', actions: ask.actions });
	assert.strictEqual(v.plan, null);
	assert.strictEqual(turnView(T({ running: false, wrap: Object.assign({}, ask, { dismissed: true }) }), false).next, null);
	const blocked = turnView(T({ running: false, wrap: { recap: 'No key.', ask: '', actions: [], blocked: true } }), false).next;
	assert.strictEqual(blocked.ask, TB_WAITING, 'blocked with no question: it says it is waiting on you');
	assert.strictEqual(turnView(T({ running: false, wrap: Object.assign({}, ask, { actions: ask.actions.concat(ask.actions) }) }), false).next.actions.length, 2);
});

test('MARKUP: every step has its icon and a word for screen readers; the spinner only on the running step', () => {
	const h = turnBoxHtml(turnView(T({}), false));
	assert.match(h, /<ul class="tb-steps" role="list" aria-label="Task list">/);
	assert.strictEqual((h.match(/<li class="tb-step /g) || []).length, 3);
	for (const [cls, word] of [['completed', 'done'], ['in_progress', 'in progress'], ['pending', 'not done']]) {
		assert.match(h, new RegExp('<li class="tb-step ' + cls + '"><span class="tb-ic[^"]*"><svg[^>]*>[\\s\\S]*?</svg><span class="tb-sr">' + word + '</span>'));
	}
	assert.strictEqual((h.match(/tb-spin/g) || []).length, 1);
	assert.ok(!/tb-spin/.test(turnBoxHtml(turnView(T({}), true))), 'parked: no spinner');
	assert.ok(!/check-circle-filled|>spinner<|>circle</.test(h), 'every icon name is one the page can draw — none printed as a word');
});
test('MARKUP: the caption and the counts, said in words', () => {
	const h = turnBoxHtml(turnView(T({ steps: many(10), stale: true }), false));
	assert.match(h, /<p class="tb-note">Plan from before your last message<\/p>/);
	assert.match(h, /tb-gap">9 earlier steps</);
	assert.match(h, /tb-gap">3 more to go</);
	assert.match(turnBoxHtml(turnView(T({ steps: many(2) }), false)), /1 earlier step</, 'one step, singular');
});
test('MARKUP: the box — recap, question, the recommendation first and primary, a way to dismiss', () => {
	const h = turnBoxHtml(turnView(T({ running: false, wrap: ask }), false));
	assert.match(h, /<p class="tb-recap" dir="auto">Dates parse now\.<\/p><button type="button" class="tb-x" data-tb="dismiss"/);
	assert.match(h, /<p class="tb-ask" dir="auto">Run the tests\?<\/p>/);
	assert.match(h, /<button type="button" class="tb-act primary" data-tb="reply" data-i="0" title="Run the tests\.">Yes, run them<\/button><button type="button" class="tb-act" data-tb="reply" data-i="1"/);
	const noRecap = turnBoxHtml(turnView(T({ running: false, wrap: Object.assign({}, ask, { recap: '' }) }), false));
	assert.match(noRecap, /<p class="tb-ask" dir="auto">Run the tests\?<\/p><button type="button" class="tb-x"/, 'the × moves to the question when there is no recap');
});
test('MARKUP: what the model wrote is shown as text, never as markup', () => {
	const evil = '<img src=x onerror=alert(1)>';
	const h = turnBoxHtml(turnView(T({ steps: [{ content: evil + ' `code`', status: 'in_progress' }] }), false));
	assert.ok(!/<img/.test(h));
	assert.match(h, /&lt;img src=x onerror=alert\(1\)&gt; <code>code<\/code>/, 'escaped, with `code` as the one markup a step gets');
	const b = turnBoxHtml(turnView(T({ running: false, wrap: { recap: evil, ask: evil, actions: [{ label: evil, message: '"><script>x</script>' }], blocked: false, dismissed: false } }), false));
	assert.ok(!/<img|<script/.test(b));
	assert.match(b, /title="&quot;&gt;&lt;script&gt;x&lt;\/script&gt;"/);
});

// ── the queue ───────────────────────────────────────────────────────────────────────────────────
function makeQueue(state) {
	const env = Object.assign({ streaming: false, awaitingStart: false, runIsAgent: false, lastRunOk: true, stopAsked: false, sent: [], notes: [], posted: [], composer: '', images: [] }, state);
	const o = {};
	new Function('env', [
		constant('IC'), extract('esc'), extract('escAttr'), extract('codicon'),
		'let queue = [], queueOpen = false, queueSeq = 0;',
		'let streaming = env.streaming, awaitingStart = env.awaitingStart, runIsAgent = env.runIsAgent, lastRunOk = env.lastRunOk, stopAsked = env.stopAsked;',
		'let pendingImages = env.images;',
		'const input = { get value(){ return env.composer; }, set value(v){ env.composer = v; }, focus(){} };',
		'const vscode = { postMessage: (m) => env.posted.push(m) };',
		'function renderQueue(){} function renderChips(){} function syncSendBtn(){} function auto(){}',
		'function note(t){ env.notes.push(t); }',
		'function postSend(t, imgs, reply){ env.sent.push(reply === true ? { text: t, images: imgs, reply: true } : { text: t, images: imgs }); awaitingStart = true; }',
		...['busy', 'queuePeek', 'queueCount', 'canSendNow', 'enqueue', 'queueEntry', 'dropQueued', 'queueBtn', 'queueHtml', 'moveQueued',
			'sendQueuedNow', 'editQueued', 'queueToComposer', 'drainQueue', 'sendOrQueue'].map(extract),
		'Object.assign(this, { queue: () => queue, images: () => pendingImages, open: (v) => { queueOpen = v; }, busy, enqueue, queueHtml, moveQueued, sendQueuedNow, editQueued, drainQueue, sendOrQueue, canSendNow });'
	].join('\n')).call(o, env);
	return Object.assign(o, { env });
}

test('BAND: one message is one row — its text, and Send now only while an agent run can take it', () => {
	const q = makeQueue({ streaming: true, runIsAgent: true });
	q.enqueue('Also handle ISO weeks', []);
	const h = q.queueHtml();
	assert.match(h, /<span class="qb-count">1 message queued<\/span><span class="qb-peek"[^>]*>Also handle ISO weeks<\/span>/);
	for (const a of ['send', 'edit', 'remove']) { assert.match(h, new RegExp('data-q="' + a + '"')); }
	assert.match(h, /aria-label="Send now — the agent reads it at its next step"/);
	const chat = makeQueue({ streaming: true, runIsAgent: false });
	chat.enqueue('x', []);
	assert.ok(!/data-q="send"/.test(chat.queueHtml()), 'a chat reply has no loop to hand it to');
	const img = makeQueue({ streaming: true, runIsAgent: true });
	img.enqueue('look', [{ url: 'blob:1' }]);
	assert.ok(!/data-q="send"/.test(img.queueHtml()), 'a message with images waits for its turn');
});
test('BAND: several fold into "N messages queued · Next: …", and open into a list with a menu, a grip and Clear all', () => {
	const q = makeQueue({ streaming: true, runIsAgent: true });
	q.enqueue('first', []); q.enqueue('second', []); q.enqueue('third', []);
	assert.match(q.queueHtml(), /<button type="button" class="qb-head" data-q="open" aria-expanded="false"><span class="qb-count">3 messages queued<\/span><span class="qb-peek">Next: first<\/span>/);
	q.open(true);
	const h = q.queueHtml();
	assert.strictEqual((h.match(/<li class="qb-item"/g) || []).length, 3);
	assert.match(h, /data-q="close" aria-expanded="true"/);
	assert.strictEqual((h.match(/data-q="menu"/g) || []).length, 3);
	assert.strictEqual((h.match(/data-q="grip"/g) || []).length, 3);
	assert.match(h, /data-q="clear">Clear all</);
	q.moveQueued(q.queue()[2].id, 0);
	assert.deepStrictEqual(q.queue().map((e) => e.text), ['third', 'first', 'second'], 'reordered');
});
test('BAND: queued text is shown as text', () => {
	const q = makeQueue({});
	q.enqueue('<b onclick=x>hi</b>', []);
	assert.ok(!/<b /.test(q.queueHtml()));
});
test('SEND NOW: posts the message for the agent\'s next step and marks it — or, with no run going, just sends it', () => {
	const q = makeQueue({ streaming: true, runIsAgent: true });
	q.enqueue('use UTC', []);
	const id = q.queue()[0].id;
	q.sendQueuedNow(id);
	assert.deepStrictEqual(q.env.posted, [{ type: 'steer', id, text: 'use UTC' }]);
	assert.ok(q.queue()[0].sending);
	assert.match(q.queueHtml(), /qb sending[\s\S]*data-q="noop"[^>]*class="qb-btn busy"|qb-btn busy[\s\S]*data-q="noop"/);
	q.sendQueuedNow(id);
	assert.strictEqual(q.env.posted.length, 1, 'once');
	const idle = makeQueue({});
	idle.enqueue('hi', []);
	idle.sendQueuedNow(idle.queue()[0].id);
	assert.deepStrictEqual(idle.env.sent.map((s) => s.text), ['hi']);
	assert.strictEqual(idle.queue().length, 0);
});
test('THE RUN ENDS WELL: the first message waiting is sent — one, not all; one still on its way to the agent is skipped', () => {
	const q = makeQueue({ lastRunOk: true });
	q.enqueue('a', []); q.enqueue('b', []);
	q.queue()[0].sending = true;
	q.drainQueue();
	assert.deepStrictEqual(q.env.sent.map((s) => s.text), ['b']);
	q.drainQueue();
	assert.deepStrictEqual(q.env.sent.map((s) => s.text), ['b'], 'nothing more while that send is on its way');
});
test('THE RUN STOPPED OR FAILED: every message goes back to the message box, with a note — nothing is sent', () => {
	const q = makeQueue({ lastRunOk: false, stopAsked: true, composer: 'my draft' });
	q.enqueue('one', [{ url: 'blob:a' }]); q.enqueue('two', []);
	q.drainQueue();
	assert.deepStrictEqual(q.env.sent, []);
	assert.strictEqual(q.queue().length, 0);
	assert.strictEqual(q.env.composer, 'my draft\n\none\n\ntwo', 'after what was already typed, never over it');
	assert.strictEqual(q.images().length, 1, 'with its images');
	assert.deepStrictEqual(q.env.notes, ['Your 2 queued messages weren’t sent because the run was stopped. They’re back in the message box.']);
});
test('STILL BUSY: nothing is drained, and a reply button queues like Enter does', () => {
	const q = makeQueue({ streaming: true, lastRunOk: true });
	q.enqueue('a', []);
	q.drainQueue();
	assert.deepStrictEqual(q.env.sent, []);
	q.sendOrQueue('Run the tests.', []);
	assert.deepStrictEqual(q.queue().map((e) => e.text), ['a', 'Run the tests.']);
	const waiting = makeQueue({ awaitingStart: true });
	waiting.sendOrQueue('x', []);
	assert.strictEqual(waiting.queue().length, 1, 'a message on its way that has not started yet counts as busy — no second run');
});
test('A REPLY STAYS A REPLY: a click\'s words are sent marked as a reply — straight away, queued, drained, and by Send now when idle', () => {
	const idle = makeQueue({});
	idle.sendOrQueue('Go ahead and push the fix.', [], true);
	assert.deepStrictEqual(idle.env.sent, [{ text: 'Go ahead and push the fix.', images: [], reply: true }]);
	const typed = makeQueue({});
	typed.sendOrQueue('typed by me', []);
	assert.deepStrictEqual(typed.env.sent, [{ text: 'typed by me', images: [] }], 'a message that is not a reply carries no mark');
	const busyQ = makeQueue({ streaming: true });
	busyQ.sendOrQueue('Run the tests.', [], true);
	busyQ.sendOrQueue('and mine', []);
	assert.deepStrictEqual(busyQ.queue().map((e) => [e.text, e.reply]), [['Run the tests.', true], ['and mine', false]], 'queued while busy, the mark is kept');
	const drained = makeQueue({ lastRunOk: true });
	drained.enqueue('Run the tests.', [], true);
	drained.drainQueue();
	assert.deepStrictEqual(drained.env.sent, [{ text: 'Run the tests.', images: [], reply: true }], 'the queued reply lost its mark on the way out');
	const now = makeQueue({});
	now.enqueue('Yes, fix it.', [], true);
	now.sendQueuedNow(now.queue()[0].id);
	assert.deepStrictEqual(now.env.sent, [{ text: 'Yes, fix it.', images: [], reply: true }]);
});
test('EDIT IN COMPOSER: out of the queue, into the message box after any draft', () => {
	const q = makeQueue({ streaming: true, composer: 'draft' });
	q.enqueue('fix the test', []);
	q.editQueued(q.queue()[0].id);
	assert.strictEqual(q.queue().length, 0);
	assert.strictEqual(q.env.composer, 'draft\n\nfix the test');
});

// ── the wiring ──────────────────────────────────────────────────────────────────────────────────
test('WIRING: a reply button sends its words as a reply, and the page tells the host so', () => {
	assert.match(html, /sendOrQueue\(a\.message \|\| a\.label, \[\], true\);/, 'the reply button no longer marks its click as a reply');
	assert.match(html, /vscode\.postMessage\(\{ type: 'send', text: t, images: payload, reply: reply === true \}\);/);
});

test('ENTER WHILE THE AGENT WORKS: queued — ■ with an empty composer still stops', () => {
	const body = extract('doSend');
	const stopAt = body.indexOf("vscode.postMessage({ type: 'stop' })");
	assert.ok(stopAt > 0 && body.slice(0, stopAt).includes('if (busy() && !t && !pendingImages.length) {'), 'stop only with nothing typed');
	assert.match(body, /if \(busy\(\)\) \{ enqueue\(t, imgs\); syncSendBtn\(\); return; \}/);
	assert.ok(body.indexOf('enqueue(t, imgs)') < body.indexOf('postSend(t, imgs)'));
	assert.ok(body.indexOf('/^\\/skills\\b/i') < body.indexOf('enqueue(t, imgs)'), 'the chat\'s own commands still run at once, never queued');
});
test('THE SEND BUTTON: Stop while busy and empty, Queue once you type, Send otherwise', () => {
	const btn = (streaming, text) => { const e = { streaming, text, btn: { classList: { on: null, toggle(c, v) { this.on = v; } }, innerHTML: '', title: '' } }; new Function('env', 'let streaming = env.streaming, awaitingStart = false; const pendingImages = []; const input = { value: env.text }; const sendBtn = env.btn; function syncAura(){}\n' + extract('busy') + '\n' + extract('syncSendBtn') + '\nsyncSendBtn();')(e); return [e.btn.classList.on, e.btn.title]; };
	assert.deepStrictEqual(btn(true, ''), [true, 'Stop']);
	assert.deepStrictEqual(btn(true, 'and the README'), [false, 'Queue — it sends when the agent is ready (Enter)']);
	assert.deepStrictEqual(btn(false, 'hi'), [false, 'Send (Enter)']);
});
test('MESSAGES: the host\'s plan, wrap-up and Send-now replies reach the card and the band', () => {
	assert.match(script, /else if \(m\.type === 'plan'\)\{ turn\.steps = Array\.isArray\(m\.steps\) \? m\.steps : \[\]; turn\.stale = false; renderTurnBox\(\); \}/);
	assert.match(script, /else if \(m\.type === 'wrapUp'\)\{ turn\.wrap = \{/);
	assert.match(script, /else if \(m\.type === 'steersDelivered'\)\{[\s\S]{0,300}dropQueued\(id\); if \(e\) \{ add\('user', render\(e\.text\)\); \}/);
	assert.match(script, /else if \(m\.type === 'steersReturned'\)\{[\s\S]{0,300}e\.sending = false;/);
	assert.match(script, /m\.type === 'agentStart'\)\{[\s\S]{0,400}turn\.running = true; turn\.wrap = null; turn\.stale = turn\.steps\.length > 0; renderTurnBox\(\);/);
	assert.match(script, /m\.type === 'agentDone'\)\{[\s\S]{0,400}lastRunOk = m\.reason === 'done';[\s\S]{0,200}turn\.running = false; renderTurnBox\(\);[\s\S]{0,120}setStreaming\(false\);/);
	assert.match(extract('setStreaming'), /else \{ setTimeout\(drainQueue, 60\); \}/, 'the end of every run drains the queue');
	assert.match(script, /new MutationObserver\(function\(\)\{\s*if \(turnBox\.parentNode === log && log\.lastElementChild !== turnBox\) \{ log\.appendChild\(turnBox\); \}/, 'the card stays the last thing in the transcript');
});
test('THE OLD STICKY PLAN BAR IS GONE — one place shows the list', () => {
	assert.ok(!/id="planBar"|renderPlan\(/.test(html));
	const at = (re) => html.search(re);
	assert.ok(at(/<div id="workbar"/) < at(/<div id="queueBar" hidden><\/div>/) && at(/<div id="queueBar"/) < at(/<div id="composer">/),
		'the band sits just above the composer (only the full-size overlays are between them)');
});

console.log('planProgressUi: ' + n + ' tests passed');
