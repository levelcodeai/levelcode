/*---------------------------------------------------------------------------------------------
 *  Static CSS invariants for the chat webview — run: node test/webviewCss.test.js
 *
 *  These are the bugs no DOM test can see. groupReducer.test.js proves the reducer sets
 *  `el.hidden = true`; it cannot prove the browser then paints nothing, because the fake DOM has
 *  no stylesheet. That gap shipped a stop button which sat next to a finished group offering to
 *  stop a command that had already exited — `hidden` was inert the whole time.
 *
 *  The trap: the UA stylesheet's `[hidden] { display: none }` is a plain element-level rule, so
 *  ANY class rule that sets `display` outclasses it. Toggling `.hidden` on such an element does
 *  nothing at all. chat.html already carried four hand-written escapes for this (#workbar,
 *  .modewrap, .modemenu, .st-approvals) — proof it is easy to hit and easy to forget.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'media', 'chat.html'), 'utf8');
const css = html.slice(html.indexOf('<style'), html.indexOf('</style>'));

// Comment-stripped CSS, for anything that reasons about BLOCK STRUCTURE rather than text. A `{` inside
// a comment would throw off brace matching, and the comments in this stylesheet are prose-heavy enough
// that one will eventually contain a brace.
const cssBlocks = css.replace(/\/\*[\s\S]*?\*\//g, '');

/**
 * The body of the `{ … }` block that opens at or after `from`, matched by BALANCED braces.
 *
 * Written because the obvious shortcut is wrong: searching for a literal closing brace (`\n  }`) only
 * terminates rules that happen to be formatted across multiple lines. A one-line block — like
 * `@media (…) { body { --shell-x: 24px; } }` — has no such terminator, so the search runs on into the
 * NEXT block and quietly returns a slice spanning both. A test built on that asserts against whatever
 * the file's rule order happens to put in reach.
 */
function blockAt(src, from) {
	const open = src.indexOf('{', from);
	if (open < 0) { return ''; }
	let depth = 0;
	for (let i = open; i < src.length; i++) {
		if (src[i] === '{') { depth++; } else if (src[i] === '}') { depth--; if (!depth) { return src.slice(open + 1, i); } }
	}
	return '';   // unbalanced — the caller's assertion fails on the empty body, which is the honest result
}

let n = 0;
function test(name, fn) { fn(); n++; console.log('  ok - ' + name); }

// Every class/id on a tag that ships the `hidden` attribute — i.e. every element that declares
// "I get shown and hidden at runtime".
function tokensDeclaredHidden() {
	const toks = new Set();
	for (const t of html.matchAll(/<\w+([^>]*?)\shidden(?=[\s>])([^>]*)>/g)) {
		const attrs = t[1] + ' ' + t[2];
		const cls = /class="([^"]+)"/.exec(attrs);
		if (cls) { cls[1].split(/\s+/).filter(Boolean).forEach((c) => toks.add('.' + c)); }
		const id = /id="([^"]+)"/.exec(attrs);
		if (id) { toks.add('#' + id[1]); }
	}
	return [...toks];
}

// Rules whose selector mentions `tok`, split into the ones that set `display` unconditionally and
// the `[hidden]`-qualified escape that would restore the UA behaviour.
function displayRulesFor(tok) {
	const esc = tok.replace(/[.#]/g, '\\$&');
	const rules = [...css.matchAll(new RegExp('^\\s*([^{}\\n]*' + esc + '[^{}\\n]*)\\{([^}]*)\\}', 'gm'))];
	return {
		unconditional: rules.filter((r) => /display\s*:/.test(r[2]) && !/\[hidden\]/.test(r[1])).map((r) => r[1].trim()),
		hasEscape: rules.some((r) => /\[hidden\]/.test(r[1]) && /display\s*:\s*none/.test(r[2]))
	};
}

test('the hidden attribute is never defeated by an explicit display', () => {
	const toks = tokensDeclaredHidden();
	assert.ok(toks.length >= 4, 'expected to find the runtime-toggled elements, found ' + toks.length);
	const broken = [];
	for (const tok of toks) {
		const { unconditional, hasEscape } = displayRulesFor(tok);
		if (unconditional.length && !hasEscape) { broken.push(tok + ' — set by: ' + unconditional.join(' | ')); }
	}
	assert.deepStrictEqual(broken, [],
		'these elements toggle `hidden` but a class rule forces `display`, so hiding them is a no-op.\n'
		+ 'Add a `<selector>[hidden] { display: none; }` rule, as #workbar and .modemenu already do:\n  '
		+ broken.join('\n  '));
});

// The guard above only bites if the group's stop button is still a hidden-toggled element, so pin
// the pairing directly: the reducer hides it on finalize, and the CSS must let that mean something.
test('the group stop button is hideable, and the reducer hides it when the group closes', () => {
	assert.ok(/class="groupstop"[^>]*\shidden/.test(html), 'groupstop still ships the hidden attribute');
	assert.ok(/\.groupstop\[hidden\]\s*\{[^}]*display\s*:\s*none/.test(css), 'groupstop has its [hidden] escape');
	assert.ok(/g\.stopBtn\.hidden\s*=\s*true/.test(html), 'finalizeGroup still hides it');
});

// The other way CSS lies about state: a more specific rule quietly outranking the one that should
// win. Collapsing the ask_user card must hide the question on screen, but `.questions.collapsed
// .qblock` is three classes and `.questions.wizard .qblock.cur` is four — so the override has to
// exist AND come later, or a collapsed card keeps showing its current question.
test('collapsing the ask_user card outranks the wizard rule that reveals a question', () => {
	const wizardRule = css.indexOf('.questions.wizard .qblock.cur');
	const override = css.indexOf('.questions.collapsed .qblock.cur');
	assert.ok(wizardRule >= 0, 'wizard reveal rule still present');
	assert.ok(override >= 0, 'missing the collapsed override — collapsing mid-wizard would do nothing');
	assert.ok(override > wizardRule, 'the override must come later to win at equal specificity');
});

// The circle-check glyph is one icon shared by every "done" tick and the menu's selected mark.
// Pin its shape and its reach so a refactor can't quietly drop it back to a bare check.
test('the check-circle glyph is an outline: a ring AND a stroked tick', () => {
	const m = /'check-circle':\s*\{[^}]*p:\s*'([^']*)'/.exec(html);
	assert.ok(m, "IC no longer defines 'check-circle'");
	const p = m[1];
	assert.ok(/<circle[^>]*stroke="currentColor"/.test(p), 'the ring is drawn as a stroke');
	assert.ok(/<path[^>]*fill="none"[^>]*stroke="currentColor"/.test(p), 'the tick is a stroked path, not a fill');
});

test('the menu selected-tick uses the circle-check, not a literal ✓', () => {
	const ticks = html.match(/<span class="mocheck"[^>]*>/g) || [];
	assert.ok(ticks.length >= 2, 'menu tick spans still present');
	assert.ok(ticks.every((t) => /data-ico="check-circle"/.test(t)), 'every mocheck is painted from the glyph');
	assert.ok(!/mocheck[^>]*>&#10003;/.test(html) && !/mocheck[^>]*>\s*✓/.test(html), 'no literal check left in the menu');
	// and the paint pass is broad enough to reach them (not just .moico)
	assert.ok(/querySelectorAll\('\[data-ico\]'\)[\s\S]{0,80}codicon\(/.test(html),
		'the [data-ico] paint pass must cover .mocheck, not only .moico');
});

test('every check migrated to the ring-check — no bare codicon(\'check\') anywhere', () => {
	// Including the group rail node: its own .tl-node border is dropped for the done state
	// (.tl-group.gok/.gfailed border-color: transparent) so the glyph's ring is the only ring.
	const bare = [...html.matchAll(/codicon\('check'\)/g)].length;
	assert.strictEqual(bare, 0, "no plain codicon('check') should remain — use codicon('check-circle')");
	assert.ok(/g\.node\.innerHTML = codicon\(g\.failed \? 'circle-slash' : 'check-circle'\)/.test(html),
		'the group node paints the ring-check');
	assert.ok(/\.tl-group\.gok \.tl-node\b[^}]*border-color:\s*transparent/.test(css),
		'and drops its own border so there is a single ring, not two');
});

// New calm-transcript state (curGroup, turnLabeled) must be torn down wherever the log is wiped,
// or the next run appends into a detached group (nothing shows) and the first line renders unlabeled.
test('the reset handler clears the group + speaker-label state, not just the card maps', () => {
	const reset = html.slice(html.indexOf("m.type === 'reset'"), html.indexOf("m.type === 'reset'") + 900);
	assert.ok(/curGroup = null/.test(reset), 'reset drops the open-group ref');
	assert.ok(/turnLabeled = false/.test(reset), 'reset re-arms the speaker label');
});

test('a checkpoint restore prunes step maps and drops a group whose DOM was removed', () => {
	const fn = html.slice(html.indexOf('function applyCheckpointRestored'), html.indexOf('function applyCheckpointRestored') + 900);
	assert.ok(/pruneDetached\(editSteps\)/.test(fn) && /pruneDetached\(termSteps\)/.test(fn) && /pruneDetached\(verifySteps\)/.test(fn),
		'the step maps are pruned alongside the card maps');
	assert.ok(/curGroup && !log\.contains\(curGroup\.el\)/.test(fn), 'a stranded (detached) group is dropped');
	// pruneDetached must handle both an element value and a {card} step value
	assert.ok(/function pruneDetached\(map\)\{[^}]*\.card/.test(html), 'pruneDetached also follows step.card');
});

// ---- G1 launch-consent card ----
// The card standing between "open a repo" and "run its command". Static assertions, matching how the
// rest of this file tests chat.html: the DOM cannot be booted here (no acquireVsCodeApi), but these are
// the invariants that break silently.

test('the mcpLaunch card is reachable and uses the pendingApproval contract the keyboard handler reads', () => {
	assert.ok(/kind === 'mcpLaunch'/.test(html), 'addApproval dispatches on the new kind');
	assert.ok(/kind === 'mcpLaunch'[\s\S]{0,120}kind === 'mcp'/.test(html),
		'mcpLaunch is matched BEFORE the plain mcp branch');

	const fn = html.slice(html.indexOf('function addMcpLaunchApproval'),
		html.indexOf('function addMcpApproval'));
	assert.ok(fn.length > 200, 'found the card body');

	// The bug this pins: the keydown handler calls pendingApproval.done(true|false). A card that
	// publishes {approve, skip} instead throws on Enter — on a card whose Enter means "spawn this
	// repo's process". Two shapes exist in this file, so the wrong one is easy to copy.
	assert.ok(/pendingApproval = \{ done \}/.test(fn), 'publishes { done }, which is what keydown calls');
	assert.ok(!/pendingApproval = \{ approve/.test(fn), 'must not publish the {approve, skip} shape');
});

test('the mcpLaunch card shows the literal command and offers no always-allow', () => {
	const fn = html.slice(html.indexOf('function addMcpLaunchApproval'),
		html.indexOf('function addMcpApproval'));

	// docs/MCP.md G1: "shows the literal command line — no summarizing."
	assert.ok(/esc\(m\.commandLine/.test(fn), 'the command line is rendered (escaped)');
	assert.ok(/m\.envLines/.test(fn), 'env is surfaced — it is executable surface, not decoration');
	assert.ok(/askdanger/.test(fn), 'carries the trust warning');

	// Trust is remembered against a fingerprint of THIS command, so approval is already durable. A
	// vaguer "always allow this server" button would blur exactly what was consented to.
	assert.ok(!/mcp-always/.test(fn), 'no always-allow button on the launch card');
	assert.ok(/remember: false/.test(fn), 'never rides the tool-policy remember path');
});

test('the /mcp command is wired end to end and lists CONFIGURED servers', () => {
	assert.ok(/\/\^\\\/mcp\\b\/i\.test\(t\)/.test(html) || /\/\^\\\/mcp/.test(html), 'the composer intercepts /mcp');
	assert.ok(/type: 'listMcp'/.test(html), 'it asks the extension for the list');
	assert.ok(/m\.type === 'mcpList'/.test(html), 'and renders the reply');

	const fn = html.slice(html.indexOf('function renderMcpList'), html.indexOf('function renderSkillsList'));
	assert.ok(fn.length > 200, 'found the renderer');

	// The three states a row can be in. "needs approval" is the one that must not read as a fault:
	// a repo server waiting on the G1 card is working exactly as designed.
	assert.ok(/needs approval/.test(fn), 'an untrusted repo server says so rather than just "not started"');
	assert.ok(/not started/.test(fn) && /running/.test(fn), 'the other two states');
	// The command line is the security-relevant part of this list, so it must be rendered escaped.
	assert.ok(/esc\(s\.commandLine/.test(fn), 'the command is shown, and escaped');
	assert.ok(/mcpcmd/.test(html) && /overflow-wrap: anywhere/.test(html), 'and wraps rather than truncating');
});

test('the timeline rail bridges the #log gap between consecutive rows (offsets stay in sync)', () => {
	// The rail is drawn per-row (.tl-rail::before spans ONE row). #log stacks rows with a flex `gap`,
	// so a run of tool/approval/group nodes only reads as one connected line if each consecutive row's
	// rail is pulled UP by exactly that gap. Drift re-breaks it: a smaller bridge leaves the "cut in
	// the middle" MCP-run stubs; a larger one paints the rail through an intended narration break.
	const gap = css.match(/#log\s*\{[^}]*?\bgap:\s*(\d+)px/);
	assert.ok(gap, '#log declares a flex gap');
	const bridge = css.match(/#log\s*>\s*\.tl\s*\+\s*\.tl\s*>\s*\.tl-rail::before\s*\{\s*top:\s*-(\d+)px/);
	assert.ok(bridge, 'consecutive top-level .tl rows bridge the gap (scoped to #log > direct children)');
	assert.strictEqual(bridge[1], gap[1], 'the rail-bridge offset must equal #log gap, or the rail drifts');
});

test('an approved MCP tool call folds its run-node into the approval chip (one row, not two)', () => {
	// Removes the redundancy where a manually-approved MCP call showed BOTH an "Approved …" chip AND a
	// separate "🔌 server · tool" node. It is a three-part handshake; break any leg and the pair splits
	// back into two rows (or folds into a stale chip):
	//   1. agent.js tags the run-node kind:'mcp' so the webview can recognise it,
	//   2. addMcpApproval arms the fold ONLY on approval (a skip keeps its own chip as the record),
	//   3. addAgentLine folds a kind==='mcp' node into that pending row, and clears the window otherwise.
	const agent = fs.readFileSync(path.join(__dirname, '..', 'agent.js'), 'utf8');
	assert.ok(/type: 'agentTool'[^}]*route\.tool[^}]*kind: 'mcp'/.test(agent), 'agent.js posts the MCP run-node with kind:mcp');

	const done = html.slice(html.indexOf('function addMcpApproval'), html.indexOf('function addApproval'));
	assert.ok(/mcpMergePending = approved \? card : null/.test(done), 'addMcpApproval arms the fold only when approved');

	const line = html.slice(html.indexOf('function addAgentLine'), html.indexOf('function setAgentStatus'));
	assert.ok(/kind === 'mcp' && mcpMergePending/.test(line), 'addAgentLine folds an MCP node into the pending chip');
	assert.ok(/mcpMergePending = null;/.test(line), 'and closes a stale merge window on any other row');
});

test('SESSION CARD: the label-collapse threshold is above the width the labels actually need', () => {
	// The card is two fixed-height lines and the action row is `flex-wrap: nowrap`, so buttons that do
	// not fit do not wrap — they OVERFLOW the card.
	//
	// The numbers below were MEASURED in headless Chrome against the shipped button styling, with all
	// six labels (Rename · Fork · Copy · Done · Delete · Pin) rendered:
	//
	//   chat.html          434px   padding 0 9px, 11.5px text, gap 6, 1px border
	//   sessionsView.html  363px   padding 0 8px, 11px   text, gap 4, no border
	//
	// A threshold BELOW those leaves a band of widths where the labels are still painted and the row
	// spills out of the card — which is exactly what shipped at 420/400 until this test existed. The
	// assertion is therefore on the RELATIONSHIP, not on a magic number: raise a threshold freely,
	// but never below what the labels need. Add a seventh button and this fails until you re-measure.
	const NEEDS = { 'chat.html': 434, 'sessionsView.html': 363 };
	const sheets = {
		'chat.html': css,
		'sessionsView.html': fs.readFileSync(path.join(__dirname, '..', 'media', 'sessionsView.html'), 'utf8')
	};
	for (const [where, sheet] of Object.entries(sheets)) {
		assert.match(sheet, /\.sesscard\s*\{[^}]*container-type:\s*inline-size/,
			where + ': the card must be a container, or the query resolves against the viewport instead');
		const m = /@container\s*\(max-width:\s*(\d+)px\)\s*\{\s*\.sesscard \.sesslbl\s*\{\s*display:\s*none/.exec(sheet);
		assert.ok(m, where + ': no width at which the labels collapse — a narrow pane will overflow');
		assert.ok(Number(m[1]) >= NEEDS[where],
			where + ': labels collapse at ' + m[1] + 'px but six labelled buttons need ' + NEEDS[where]
			+ 'px — between those widths the labels paint and the nowrap row overflows the card');
		assert.match(sheet, /\.sesscard \.sessacts \{[^}]*flex-wrap:\s*nowrap/,
			where + ': the row stopped being nowrap, so this guard now tests the wrong failure');
	}
});

test('TRANSCRIPT: the prose column is bounded, and every child shares the one measure', () => {
	// docs/CHAT-TYPOGRAPHY.md T1. Nothing constrained line length before this — the other max-width
	// rules in the file are cards, dialogs and the empty state. It went unnoticed for as long as the
	// chat only ever lived in a ~380px sidebar, where the container did the bounding; opening it as an
	// editor tab (#70) put the same CSS at 900px and produced ~154-character lines.
	//
	// This guard exists because the regression is INVISIBLE in a sidebar. Whoever refactors the log
	// container will not see it break; a user with the chat open in an editor tab will.
	// T7/D9 moved the declaration from `#log` to `body`. That is load-bearing, not tidying: the composer
	// and the status row are siblings of the log, so a measure declared ON the log is invisible to them —
	// which is exactly how a full-panel composer ended up sitting under a 680px conversation.
	assert.match(css, /body \{[^}]*--prose-max:\s*\d+px/,
		'the measure must be declared on `body`, or the composer cannot resolve the same column as the log');
	assert.ok(!/#log\s*\{[^}]*--prose-max:/.test(css),
		'declaring it on #log too gives the shell two sources of truth for one column');
	assert.match(css, /#log > \*\s*\{[^}]*max-width:\s*var\(--prose-max\)/,
		'the cap must apply to EVERY direct child, or cards and the timeline drift wider than the prose');
	assert.match(css, /#log > \*\s*\{[^}]*margin-inline:\s*auto/,
		'an uncentred capped column pins the transcript to the left edge at width');

	// `ch` is a trap here and the reason the first draft of the doc was wrong: `0` measures 8.13px in
	// this font against a 5.86px average prose character, so a ch-based cap overshoots by ~39%.
	const capRule = /body \{[^}]*--prose-max:\s*([^;]+);/.exec(css);
	assert.ok(capRule && /px$/.test(capRule[1].trim()),
		'the measure should be an absolute length, not `ch` — see CHAT-TYPOGRAPHY.md D1');
});

test('TRANSCRIPT: the stylesheet comment keeps no copy of the cap', () => {
	// Review found the comment beside the rule still saying "680px" and "~116 characters" after the cap
	// became 820 — the third place this number has drifted, and the only one no test was watching. The
	// doc pin above covers CHAT-TYPOGRAPHY.md; nothing covered the stylesheet's own prose.
	//
	// The fix is not to sync it. A comment that restates a value will drift again the next time the
	// value changes, so it must not carry the number at all — it points at `--prose-max` instead.
	const block = /THE MEASURE[\s\S]*?\*\//.exec(css);
	assert.ok(block, 'the THE MEASURE comment is gone — this guard covers nothing');
	assert.match(block[0], /--prose-max/, 'the comment must point at the property rather than restate its value');

	// 380px and 900px are VIEWPORT widths — facts about where the problem showed up, which cannot go
	// stale. Any other length in here is a copy of a decision that can.
	const VIEWPORTS = ['380px', '900px'];
	const restated = (block[0].match(/\b\d{3,4}px\b/g) || []).filter((v) => !VIEWPORTS.includes(v));
	assert.deepStrictEqual(restated, [],
		'the measure comment quotes a length again — reference --prose-max instead, or it drifts the next '
		+ 'time the cap moves: ' + restated.join(', '));
});

test('SHELL: the composer shares the transcript column instead of spanning the panel', () => {
	// docs/CHAT-TYPOGRAPHY.md D9. T1 bounded the TRANSCRIPT and nothing else, so at editor width the
	// input was a ~1580px box under an 820px conversation — the single thing that most made the panel
	// look unlike the reference, where the composer sits directly under the text it answers.
	const shell = /(#bgTasksBar[^{]*#status)\s*\{([^}]*)\}/.exec(css);
	assert.ok(shell, 'the shell-column rule is gone — the composer and status row span the panel again');
	for (const id of ['#composer', '#status', '#workbar']) {
		assert.ok(shell[1].includes(id), id + ' dropped out of the shell column');
	}
	assert.match(shell[2], /max-width:\s*var\(--prose-max\)/, 'the shell must use the SAME measure as the log');
	assert.match(shell[2], /margin-inline:\s*auto/, 'an uncentred shell sits left while the transcript is centred');

	// `calc(100% - 2 * --shell-x)`, not a bare `width: 100%`. Below the cap a bare 100% out-dents the
	// composer by the log's own padding — 24px a side in an editor tab, and misaligned in every sidebar,
	// which is the width most users are actually in.
	assert.match(shell[2], /width:\s*calc\(100% - 2 \* var\(--shell-x\)\)/,
		'the shell must inset by the same --shell-x the log pads with, or the edges only agree above the cap');
	assert.match(css, /#log \{[^}]*padding:\s*12px var\(--shell-x\)/,
		'the log must PAD by --shell-x — that shared value is the whole alignment mechanism');
	assert.match(css, /@media \(min-width: 760px\) \{ body \{ --shell-x:\s*\d+px/,
		'--shell-x must widen with the panel, or an editor tab keeps sidebar margins');

	// Measured in headless Chrome at 1600 / 900 / 800 / 420px: composer and prose left AND right edges
	// agree to 0.0px at every one. Before, the gap at 1600px was 452px a side.
});

test('SHELL: the runtime width setting reaches the composer, not just the transcript', () => {
	// The half of the move that is easy to forget. If the override is written to #log while the property
	// is declared on body, `chat.proseWidth` resizes the conversation and leaves the composer at the
	// stylesheet default — re-opening the exact split D9 exists to close, but only for users who set it.
	const handler = html.slice(html.indexOf("m.type === 'config'"), html.indexOf("m.type === 'config'") + 600);
	assert.ok(/document\.body/.test(handler),
		'the override must target document.body, where --prose-max is declared');
	assert.ok(!/getElementById\('log'\)[\s\S]{0,200}setProperty\('--prose-max'/.test(handler),
		'writing --prose-max onto #log leaves the composer on the stylesheet default');
	assert.match(handler, /setProperty\('--prose-max', m\.proseWidth \? m\.proseWidth \+ 'px' : ''\)/,
		'0 must still clear the property so the stylesheet wins again');
});

test('TRANSCRIPT: the design doc quotes the SAME measure the stylesheet ships', () => {
	// Review found the doc contradicting itself in three places: the cap was corrected in D1 after
	// measuring, and the intro, the exit criterion and the risks list kept the pre-measurement numbers.
	// Prose drifts from code silently, so the one number that matters is pinned to the code instead of
	// to a proofread.
	const doc = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'docs', 'CHAT-TYPOGRAPHY.md'), 'utf8');
	const shipped = /--prose-max:\s*(\d+)px/.exec(css);
	assert.ok(shipped, 'the stylesheet no longer declares --prose-max');

	assert.ok(doc.includes('**Target ' + shipped[1] + 'px**'),
		'CHAT-TYPOGRAPHY.md D1 does not name the ' + shipped[1] + 'px cap the stylesheet actually ships');
	// And no stray reference to the estimate that measuring disproved.
	assert.ok(!/~72 characters per line/.test(doc),
		'the doc still quotes the pre-measurement 72-character target somewhere');
});

test('TRANSCRIPT: the looser rhythm is gated to reading width, so the sidebar is untouched', () => {
	// T1's exit criterion is that a narrow panel renders exactly as before — a user who upgrades and
	// never opens the editor tab should see nothing move. Verified against develop's computed styles
	// at 520px: padding, gap, paragraph and heading margins, line-height and font-size all identical.
	// Located by CONTENT, not by position: there is more than one `min-width: 760px` gate (D9 gates
	// --shell-x on the same breakpoint), so an indexOf would grab whichever comes first in the file and
	// assert on rule ORDER rather than on the thing being checked.
	//
	// And located with BALANCED BRACES, not by searching for a literal `\n  }`. Review caught that: the
	// --shell-x gate is written on one line, so it has no `\n  }` of its own and the search ran straight
	// past it into the next multi-line block. It happened to resolve correctly here — the swallowed span
	// did not contain `#log {` — but only because of where the rules currently sit. Move one rule and
	// the slice silently spans two gates, which is the same order-dependence in a new disguise.
	const gates = [...cssBlocks.matchAll(/@media \(min-width: 760px\)/g)].map((m) => m.index);
	assert.ok(gates.length, 'the width gate is gone — the rhythm change would now hit the sidebar too');
	const at = gates.find((i) => blockAt(cssBlocks, i).includes('#log {'));
	assert.ok(at !== undefined, 'no min-width:760px gate contains the #log rhythm rules');
	const block = blockAt(cssBlocks, at);
	assert.match(block, /#log \{[^}]*padding:/, 'the wider page margin belongs inside the gate');
	assert.match(block, /margin-bottom:\s*1em/, 'prose spacing must be em-based so T2 scales it');
	assert.match(block, /h1[\s\S]*margin:\s*1\.6em 0 \.55em/,
		'headings need more space above than below, or they float between sections');
});

test('TRANSCRIPT: prose has its own type, and chrome does not follow it', () => {
	// docs/CHAT-TYPOGRAPHY.md D2 — the deliberate divergence, and the whole risk of T2. The workbench
	// size is tuned for menu labels; message bodies get their own. The scoping is the entire safety
	// property: applied to `.msg` instead of `.msg .body` it would drag the role label, the copy
	// button and the checkpoint control up with it, and the panel would stop matching the editor.
	assert.match(css, /body \{[^}]*--prose-size:\s*calc\(var\(--vscode-font-size[^)]*\)\s*\+\s*\d+px\)/,
		'the prose size must be an OFFSET from the workbench, not a flat value — see below');
	assert.match(css, /body \{[^}]*--prose-leading:\s*[\d.]+/, 'the prose leading is no longer a custom property');
	assert.match(css, /\.msg \.body \{[^}]*font-size:\s*var\(--prose-size\)[^}]*line-height:\s*var\(--prose-leading\)/,
		'prose type must be set on .msg .body');

	const scoped = /\.msg \.body \{[^}]*font-size:\s*var\(--prose-size\)/.test(css);
	const leaked = /\.msg \{[^}]*font-size:\s*var\(--prose-size\)/.test(css);
	assert.ok(scoped && !leaked, 'the prose size leaked onto .msg — chrome inside a turn would scale with it');
	// The turn label used to be this test's example of in-turn chrome holding an absolute size. T4 took
	// it out of the visual layer entirely (see below), so the checkpoint control carries the guard now:
	// it still renders inside a .msg and still must not grow with the prose beside it.
	assert.match(css, /\.ckrestore \{[^}]*font-size:\s*11px/,
		'in-turn chrome must keep an absolute size, or it grows with the prose it sits next to');
});

test('TRANSCRIPT: the prose size TRACKS the workbench rather than pinning against it', () => {
	// The bug a flat `--prose-size: 14px` hides, and the reason review's "0 doesn't do what the
	// description says" comment was worth more than a wording fix.
	//
	// D2 argues prose should read a step ABOVE workbench chrome. A flat value only satisfies that at
	// the default 13px: raise the editor's UI font for accessibility and the relationship inverts —
	// 14px prose inside 18px buttons, the divergence pointing the wrong way, for exactly the users who
	// most need it not to. An offset holds the decision at every workbench size.
	const decl = /--prose-size:\s*([^;]+);/.exec(css);
	assert.ok(decl, 'the stylesheet no longer declares --prose-size');
	const m = /calc\(\s*var\(--vscode-font-size(?:\s*,\s*(\d+)px)?\)\s*\+\s*(\d+)px\s*\)/.exec(decl[1]);
	assert.ok(m, '--prose-size must be workbench-relative, got: ' + decl[1].trim());

	// The offset stays small: this is "a step above for reading", not a second font scale. Past ~3px
	// the panel stops looking like part of the editor and D2's cost is no longer the one we accepted.
	assert.ok(Number(m[2]) >= 1 && Number(m[2]) <= 3,
		'the reading offset is ' + m[2] + 'px; beyond ~3px the chat stops belonging to the workbench');
	// A fallback is required: `--vscode-font-size` is injected by the host, and the file opens in a
	// plain browser during development, where an unresolved var() would void the whole declaration.
	assert.ok(m[1], '--vscode-font-size needs a px fallback, or the rule is void outside the webview');

	// And the default must still land on the 14px the doc and T1's character count were measured at.
	assert.strictEqual(Number(m[1]) + Number(m[2]), 14,
		'at the default 13px workbench this must still resolve to 14px, or T1\'s ~108-character figure moves');
});

test('TRANSCRIPT: settings are clamped at the host boundary, to the schema\'s own bounds', () => {
	// `minimum`/`maximum` in the contribution schema are advice for the settings EDITOR — it squiggles
	// and saves anyway, and a hand-edited settings.json, a synced profile or a bad merge never passes
	// through that UI at all. These two land straight in CSS, where `proseWidth: 1` is a one-pixel
	// transcript: a panel with nothing left on screen to open settings with, whose only way out is
	// finding the JSON file again.
	const ext = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');
	const src = /function clampSetting\(raw, lo, hi\) \{[\s\S]*?\n\}/.exec(ext);
	assert.ok(src, 'clampSetting is gone — the settings reach CSS unchecked again');
	const clampSetting = new Function(src[0] + '\nreturn clampSetting;')(); // eslint-disable-line no-new-func

	const props = require('../package.json').contributes.configuration.properties;
	for (const key of ['fontSize', 'proseWidth']) {
		const call = new RegExp('clampSetting\\(cfg\\.get\\(\'chat\\.' + key + '\', 0\\),\\s*(\\d+),\\s*(\\d+)\\)').exec(ext);
		assert.ok(call, 'chat.' + key + ' is read without clampSetting — the bound is decorative again');
		const lo = Number(call[1]), hi = Number(call[2]);
		const schema = props['levelcode.ai.chat.' + key];

		// The pin: the number the host enforces IS the number the settings UI advertises. Raising one
		// without the other is the drift this test exists to catch.
		assert.strictEqual(hi, schema.maximum,
			'chat.' + key + ' clamps at ' + hi + ' but the schema advertises ' + schema.maximum);
		assert.ok(lo > schema.minimum,
			'the floor must be a real readability bound, not the schema minimum (which is 0, the sentinel)');
		assert.ok(new RegExp('clamped to ' + lo + '.' + hi).test(schema.markdownDescription),
			'chat.' + key + ' does not tell the user it is clamped to ' + lo + '-' + hi);

		// 0 is the sentinel, and it must survive the clamp — clamping it up to `lo` would make the
		// default un-expressible and permanently override the stylesheet.
		assert.strictEqual(clampSetting(0, lo, hi), 0, '0 must stay 0 — it means "leave the stylesheet alone"');
		assert.strictEqual(clampSetting(undefined, lo, hi), 0, 'an unset value falls back to the stylesheet');
		assert.strictEqual(clampSetting('nonsense', lo, hi), 0, 'a non-number falls back rather than emitting NaNpx');
		assert.strictEqual(clampSetting(-5, lo, hi), 0, 'a negative falls back — CSS would drop it and behave unpredictably');
		assert.strictEqual(clampSetting(Infinity, lo, hi), 0, 'Infinity falls back rather than emitting "Infinitypx"');

		// In range, untouched. Out of range, pulled in — someone asking for a 200px measure wants it
		// narrow, so give them the narrowest readable one instead of ignoring them.
		assert.strictEqual(clampSetting(lo + 1, lo, hi), lo + 1, 'an in-range value must pass through unchanged');
		assert.strictEqual(clampSetting(1, lo, hi), lo, 'a below-floor value snaps to the floor');
		assert.strictEqual(clampSetting(1e9, lo, hi), hi, 'an absurd value snaps to the ceiling');
	}
});

test('TRANSCRIPT: the speaker label leaves the screen but NOT the accessibility tree', () => {
	// docs/CHAT-TYPOGRAPHY.md D6/T4. Speakers are told apart by treatment — a tinted bubble for you,
	// unadorned prose for the assistant — so a label restating it above every message was chrome.
	//
	// The trap this guards is the obvious "simplification". `display: none` and `visibility: hidden`
	// both look like tidier ways to hide a label, and both remove it from the accessibility tree. The
	// bubble is a purely VISUAL cue, so that would leave a screen reader with an unattributed wall of
	// text and nothing anywhere in the document naming who is speaking — a worse transcript than the
	// one we started with, and invisible to whoever makes the change.
	const rule = /\.msg \.role \{([^}]*)\}/.exec(css);
	assert.ok(rule, '.msg .role no longer has a rule');
	const body = rule[1];

	assert.ok(!/display\s*:\s*none/.test(body),
		'display:none removes the label from the a11y tree — clip it instead (see the comment on the rule)');
	assert.ok(!/visibility\s*:\s*hidden/.test(body),
		'visibility:hidden removes the label from the a11y tree — clip it instead');
	assert.match(body, /clip-path:\s*inset\(50%\)/, 'the label must be clipped out of the visual layer');
	assert.match(body, /position:\s*absolute/, 'a clipped label must be taken out of flow, or it still reserves a line');
	assert.match(body, /height:\s*1px/, 'the clipped box must not reserve height');

	// And it must still BE there to hide: both speakers labelled on a turn start, neither on a
	// continuation (which is the same voice carrying on, and was never labelled).
	const at = html.indexOf('function add(role, html)');
	assert.ok(at !== -1, 'function add(role, html) is gone — cannot verify label emission');
	const add = html.slice(at, at + 700);
	assert.match(add, /role === 'user' \? 'You' : 'LevelCode AI'/, 'the label text is no longer emitted at all');
	assert.match(add, /cont \? '' : '<div class="role">/, 'a continuation must still omit the label element entirely');
});

test('TRANSCRIPT: dropping the label does not collapse the gap between speakers', () => {
	// The label was doing spacing work nobody had accounted for: ~19px above every turn. Remove it and
	// a new turn is separated from a continuation by 12px versus 7px — not a difference you can see, so
	// the transcript reads as one undifferentiated column. That is the failure mode of T4 done naively,
	// and it would look like "the spacing feels off" rather than like a missing rule.
	assert.match(css, /#log > \.msg:not\(\.cont\) \{[^}]*margin-top:\s*[\d.]+em/,
		'a turn start must buy back part of the height the label used to occupy, in em so T2 scales it');
	assert.match(css, /#log > \.msg:first-child \{[^}]*margin-top:\s*0/,
		'the first turn must not open the transcript with a stray gap');
	assert.match(css, /\.msg\.cont \{[^}]*margin-top:\s*-\d+px/,
		'continuations must stay pulled tight, or there is no hierarchy left to see');

	// The whole design rests on the user bubble now: it is the ONLY remaining visual speaker cue.
	// Flatten it and the transcript loses the distinction entirely, with no label left to fall back on.
	assert.match(css, /\.msg\.user \.body \{[^}]*background:\s*var\(--field-bg\)/,
		'the user bubble is the last visual speaker cue — D6 keeps it deliberately');
	assert.match(css, /\.msg\.user \.body \{[^}]*border:\s*1px solid/,
		'the bubble needs its border: --field-bg alone is near-invisible in some themes');
});

test('TRANSCRIPT: your turn sits right, the assistant stays left', () => {
	// docs/CHAT-TYPOGRAPHY.md D8/T6. T4 removed the labels and left the bubble carrying the speaker
	// distinction alone — but the bubble is `--field-bg`, near-invisible in some themes, so on a
	// low-contrast theme the transcript could read as one undifferentiated voice. Side is unmissable in
	// every theme, at every contrast, and costs no chrome.
	assert.match(css, /\.msg\.user \{[^}]*display:\s*flex/, 'the user turn is no longer a flex container');
	assert.match(css, /\.msg\.user \{[^}]*flex-direction:\s*column/,
		'a row direction would put the checkpoint control beside the bubble instead of under it');
	assert.match(css, /\.msg\.user \{[^}]*align-items:\s*flex-end/, 'the user turn is no longer pushed right');

	// THE TRAP. `text-align: right` looks like the same change on a one-line message and is completely
	// different on a three-line one: it right-aligns the PROSE, which is unreadable past one line.
	// The bubble is the thing being placed; the words inside it stay left.
	const userRules = [...css.matchAll(/\.msg\.user[^{}\n]*\{([^}]*)\}/g)].map((m) => m[1]).join(' ');
	assert.ok(!/text-align\s*:\s*right/.test(userRules),
		'right-align the BUBBLE (align-items), never the text — multi-line prose becomes unreadable');

	// The asymmetry IS the cue. Give the assistant the same treatment and both sides move together,
	// which restores exactly the undifferentiated column T4 was at risk of.
	assert.ok(!/\.msg\.assistant[^{}\n]*\{[^}]*align-items:\s*flex-end/.test(css),
		'the assistant must stay left — if both sides sit right there is no side cue at all');
});

test('TRANSCRIPT: the user bubble hugs its content, and is capped short of the column', () => {
	const rule = /\.msg\.user \.body \{([^}]*width:\s*fit-content[^}]*)\}/.exec(css);
	assert.ok(rule, 'the user bubble no longer hugs its content — "Yes" would be a full-width block');

	// Capped BELOW the column: at 100% a long question fills the measure, reads as a full-width block
	// again, and the side cue disappears exactly when the transcript is densest.
	const cap = /max-width:\s*(\d+)%/.exec(rule[1]);
	assert.ok(cap, 'the bubble needs a percentage cap, or a long turn spans the whole column');
	const pct = Number(cap[1]);
	assert.ok(pct >= 70 && pct <= 90,
		'the cap is ' + pct + '%; below ~70% a normal question wraps far too early, above ~90% the '
		+ 'asymmetry stops being visible');

	// Measured in headless Chrome at a 680px column: "Yes" renders 46.9px wide and the long turn
	// lands on 578px, exactly the cap. Both flush to the column's right edge; the assistant stays 680.
	assert.match(css, /\.msg\.user \.body \{[^}]*background:\s*var\(--field-bg\)/,
		'tint is the secondary cue and still earns its place — side alone would drop on a wrapped log');
});

test('WORDMARK: the mark and its cqi scale factor stay in agreement', () => {
	// NOT asserted here: which characters it is drawn from. A previous version required full blocks
	// only, on the theory that `█` tiles seamlessly while `▀`/`▄` can seam. Half of that is right —
	// `▀` above `▄` does leave a gap — but the other half is not: whether `█` FILLS its cell is a
	// property of the FONT, not of the character. In Monaco it does not, and a wordmark built on that
	// assumption shattered into disconnected bars in the editor while looking perfect in a harness
	// running SF Mono.
	//
	// The current mark sidesteps that entirely: box-drawing rules are CONNECTOR glyphs that join in
	// every monospace family, and the letters are real text rather than pixel art. Verified by
	// rendering it in Monaco, SF Mono, Menlo, Courier New, Andale Mono, Consolas and the generic
	// fallback — legible in all seven. That check cannot live in this file; ASCII art has to be looked
	// at in the target font.
	const m = /<pre class="lc-ascii"[^>]*>([\s\S]*?)<\/pre>/.exec(html);
	assert.ok(m, 'the empty-state wordmark is gone');
	const art = m[1].replace(/^\n/, '');
	const lines = art.split('\n');
	const cols = Math.max(...lines.map((l) => l.length));

	// What IS checkable, and the thing most likely to be got wrong: the mark is sized from the
	// container, so its WIDTH IN COLUMNS and the cqi factor are two halves of one number. Widen the art
	// without lowering the factor and it overflows; narrow it without raising the factor and it shrinks
	// to a stamp floating in white space. The 41-column mark used 3.6cqi; this 32-column one uses 4.6
	// precisely to land in the same place.
	// The selector is anchored with a negative lookahead because `.lc-ascii-wrap` is declared BEFORE
	// `.lc-ascii` and `.lc-ascii-sub` right after it. A looser `\.lc-ascii[^{]*\{` reads the right rule
	// today only because -wrap happens to declare no font-size — luck of content, not construction, and
	// it would silently start measuring the wrong rule the day one of them gains a cqi clamp.
	const rule = /\.lc-ascii(?![-\w])[^{]*\{([^}]*)\}/.exec(css);
	assert.ok(rule, 'the .lc-ascii rule is gone');
	const cqi = /font-size:\s*clamp\(\s*\d+px\s*,\s*([\d.]+)cqi/.exec(rule[1]);
	assert.ok(cqi, 'the wordmark is no longer sized from its container');

	// Asserted on cols x cqi directly, which IS the contract: the art width in columns and the font
	// size as a percentage of the container are two halves of one number, and their product is what
	// stays constant. The previous version multiplied in a hard-coded 0.6em cell width to report a
	// tidy "fill %", but that factor is a property of whatever font the editor resolves — it differs
	// between Monaco and SF Mono — so it dressed the real invariant in a precision it does not have.
	const product = cols * Number(cqi[1]);
	assert.ok(product > 132 && product < 162,
		'cols x cqi is ' + product.toFixed(1) + ' (' + cols + ' columns at ' + cqi[1] + 'cqi). '
		+ 'It must stay near 147 — the value both shipped marks share (41x3.6, 32x4.6). Lower and the '
		+ 'mark shrinks to a stamp in white space; higher and it touches the edges and can overflow.');

	assert.ok(lines.length <= 14,
		'the wordmark is ' + lines.length + ' lines; it has to leave room for the prompt and starters beneath it');

	// The accessible name is the whole reason a picture made of text is not a wall of noise to a
	// screen reader.
	assert.match(m[0], /role="img"/, 'the wordmark must be exposed as an image, not read out block by block');
	assert.match(m[0], /aria-label="[^"]+"/, 'the wordmark has no accessible name');
});

test('CODE: prose blocks get room, and nothing else that uses <pre> moves', () => {
	// docs/CHAT-TYPOGRAPHY.md D5/T3. `pre` is a GLOBAL selector in this file, and it draws four different
	// things: the empty state's ASCII logo, the MCP approval card's command block, the terminal output
	// pane, and the prose code block D5 is actually about. Only the logo has no padding override of its
	// own — so widening bare `pre` would quietly move it, which is the T2 mistake (`.msg` vs `.msg .body`)
	// waiting in a new place.
	const gates = [...cssBlocks.matchAll(/@media \(min-width: 760px\)/g)].map((m) => m.index);
	const at = gates.find((i) => blockAt(cssBlocks, i).includes('#log {'));
	assert.ok(at !== undefined, 'the rhythm gate is gone');
	const block = blockAt(cssBlocks, at);

	assert.match(block, /\.msg \.body pre \{[^}]*padding:/,
		'the code-block padding must be scoped to .msg .body pre');
	assert.ok(!/^\s*pre \{[^}]*padding:\s*12px/m.test(css),
		'bare `pre` was widened — that moves the ASCII logo and the approval cards too');
	assert.match(css, /^\s*pre \{[^}]*padding:\s*9px 11px/m,
		'the base `pre` padding changed; the logo and cards inherit it and have no override');

	// Gated to reading width for the same reason D3 is: a 380px sidebar is deliberately dense, and
	// 6 more pixels a side is content width it does not have. Measured: at 420px the computed padding
	// and margins are identical to develop; at 1200px they are 12px 14px and 14px.
	// Membership in `block` above is what proves it is gated; this catches the narrower case of a SECOND
	// ungated copy declared earlier in the file, which would apply at every width and win nothing visible
	// in review.
	assert.ok(!/\.msg \.body pre \{[^}]*padding:\s*12px/.test(css.slice(0, at)),
		'a second, ungated copy of the code-block padding is declared before the width gate');

	// The margin joins D3's rhythm rather than staying an absolute, so raising the prose size opens the
	// spacing around a block with it.
	assert.match(block, /\.msg \.body pre \{[^}]*margin:\s*[\d.]+em/,
		'the block margin must be em-based, or it stops matching the paragraph spacing beside it');
});

test('CODE: inline code stays theme-driven — we still never set its colour', () => {
	// D5, and §1 before it: no `color` has ever been set here. The red/orange in dark themes comes from
	// the theme, so hard-coding one would fight every theme rather than fixing anything. It is the kind
	// of line that gets added while "tidying up the code style" and is invisible until someone switches
	// to a light theme.
	const rule = /:not\(pre\) > code \{([^}]*)\}/.exec(css);
	assert.ok(rule, 'the inline-code rule is gone');
	assert.ok(!/(^|;)\s*color\s*:/.test(rule[1]),
		'inline code now sets a colour — D5 keeps this theme-driven: ' + rule[1].trim());
	assert.match(rule[1], /background:\s*var\(--vscode-textCodeBlock-background/,
		'inline code must keep the theme background it has always had');

	// Its padding stays tight ON PURPOSE. Vertical padding on an inline box does not grow the line box,
	// so a roomier inline code span overlaps the line above it — "code surfaces get room" applies to
	// blocks, not to spans.
	assert.match(rule[1], /padding:\s*1px 5px/,
		'inline padding grew; on an inline box that overlaps the neighbouring line rather than adding room');
});

test('TRANSCRIPT: the heading scale has steps you can actually see', () => {
	// The old 1.3/1.18/1.07 put 0.11em between h2 and h3 — 1.4px at 13px, i.e. three levels of
	// hierarchy that were indistinguishable without selecting the text.
	const sizes = ['h1', 'h2', 'h3'].map((h) => {
		const m = new RegExp('\\.msg \\.body ' + h + ' \\{ font-size: ([\\d.]+)em').exec(css);
		assert.ok(m, 'no font-size for ' + h);
		return Number(m[1]);
	});
	assert.ok(sizes[0] > sizes[1] && sizes[1] > sizes[2], 'the scale must descend: ' + sizes.join(' > '));
	for (let i = 0; i < 2; i++) {
		assert.ok(sizes[i] - sizes[i + 1] >= 0.13,
			'h' + (i + 1) + '→h' + (i + 2) + ' differ by ' + (sizes[i] - sizes[i + 1]).toFixed(2)
			+ 'em; below ~0.13em the levels are indistinguishable at this type size');
	}
});

test('TRANSCRIPT: both type settings exist and reach the stylesheet (D7)', () => {
	// Shipping a divisive change with no way back is worse than not shipping it. T5's escape hatch is
	// folded into T2 for exactly that reason — see the PR.
	const pkg2 = require('../package.json');
	const props = pkg2.contributes.configuration.properties;
	for (const key of ['levelcode.ai.chat.fontSize', 'levelcode.ai.chat.proseWidth']) {
		assert.ok(props[key], key + ' is not declared — the change would be irreversible for a user');
		assert.strictEqual(props[key].default, 0, key + ' must default to 0, meaning "follow the default"');
	}
	const ext2 = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');
	assert.match(ext2, /cfg\.get\('chat\.fontSize', 0\)/, 'the host never reads chat.fontSize');
	assert.match(ext2, /cfg\.get\('chat\.proseWidth', 0\)/, 'the host never reads chat.proseWidth');
	assert.strictEqual((ext2.match(/proseSize, proseWidth,/g) || []).length, 2,
		'both config payloads must carry them, or the setting works in one provider mode and not the other');

	// 0 must CLEAR the property so the stylesheet wins again, rather than pinning today's default.
	assert.match(html, /setProperty\('--prose-size', m\.proseSize \? m\.proseSize \+ 'px' : ''\)/,
		'0 must clear --prose-size, not write a hard-coded fallback');
	assert.match(html, /setProperty\('--prose-max', m\.proseWidth \? m\.proseWidth \+ 'px' : ''\)/,
		'0 must clear --prose-max, not write a hard-coded fallback');
});

test('SESSION CARD: every action button keeps a label for pointers and screen readers', () => {
	// The collapse above hides `.sesslbl` VISUALLY. If the buttons had no title/aria-label, an
	// icon-only row in a narrow pane would be unusable rather than merely compact.
	const pure = html.slice(html.indexOf('function sessActBtn'), html.indexOf('var SESS_BUCKETS'));
	assert.match(pure, /title="' \+ label \+ '"/, 'no tooltip on an icon-only button');
	assert.match(pure, /aria-label="' \+ label \+ '"/, 'no accessible name on an icon-only button');
});

console.log('webviewCss: ' + n + ' tests passed');
