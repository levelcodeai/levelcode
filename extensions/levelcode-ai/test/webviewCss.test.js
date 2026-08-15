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
	assert.match(css, /#log\s*\{[^}]*--prose-max:\s*\d+px/,
		'the measure is no longer a custom property — T5 hands this to a setting');
	assert.match(css, /#log > \*\s*\{[^}]*max-width:\s*var\(--prose-max\)/,
		'the cap must apply to EVERY direct child, or cards and the timeline drift wider than the prose');
	assert.match(css, /#log > \*\s*\{[^}]*margin-inline:\s*auto/,
		'an uncentred capped column pins the transcript to the left edge at width');

	// `ch` is a trap here and the reason the first draft of the doc was wrong: `0` measures 8.13px in
	// this font against a 5.86px average prose character, so a ch-based cap overshoots by ~39%.
	const capRule = /#log\s*\{[^}]*--prose-max:\s*([^;]+);/.exec(css);
	assert.ok(capRule && /px$/.test(capRule[1].trim()),
		'the measure should be an absolute length, not `ch` — see CHAT-TYPOGRAPHY.md D1');
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
	const at = css.indexOf('@media (min-width: 760px)');
	assert.ok(at > 0, 'the width gate is gone — the rhythm change would now hit the sidebar too');
	const block = css.slice(at, css.indexOf('\n  }', at));
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
	assert.match(css, /#log\s*\{[^}]*--prose-size:\s*\d+px/, 'the prose size is no longer a custom property');
	assert.match(css, /#log\s*\{[^}]*--prose-leading:\s*[\d.]+/, 'the prose leading is no longer a custom property');
	assert.match(css, /\.msg \.body \{[^}]*font-size:\s*var\(--prose-size\)[^}]*line-height:\s*var\(--prose-leading\)/,
		'prose type must be set on .msg .body');

	const scoped = /\.msg \.body \{[^}]*font-size:\s*var\(--prose-size\)/.test(css);
	const leaked = /\.msg \{[^}]*font-size:\s*var\(--prose-size\)/.test(css);
	assert.ok(scoped && !leaked, 'the prose size leaked onto .msg — chrome inside a turn would scale with it');
	assert.match(css, /\.msg \.role \{[^}]*font-size:\s*11px/,
		'the turn label must keep an absolute size, or it grows with the prose it is labelling');
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
