/*---------------------------------------------------------------------------------------------
 *  Chat surfaces — sidebar ⇄ editor tab — run: node test/chatSurface.test.js
 *
 *  WHY THIS EXISTS. The chat is a WebviewPanel — an editor tab — and nothing else. It used to ALSO be
 *  hostable by a contributed WebviewView in the right-hand bar, and one conversation with two possible
 *  hosts needed a hand-over card, a detached document, a move command, a close-versus-move
 *  distinction, and a transcript replay on every transition. All of that is gone; Sessions keeps the
 *  right-hand container, because an index of past conversations is a different thing from the
 *  conversation and does not need to share a column with it.
 *
 *  Everything that can go wrong here is STATE, not layout, and none of it is visible in a diff:
 *    · a listener registered twice, so every click is handled twice
 *    · a second panel, so a post() reaches one DOM and the user is looking at the other
 *    · a close that silently discards the conversation instead of sealing it
 *    · a reveal that resurrects the surface the user just closed
 *
 *  So these assertions are about the SHAPE of the wiring, read out of the shipped extension.js the
 *  way mcpManage/ctxSegments read theirs. extension.js requires `vscode`, which does not exist
 *  outside the editor, and a copy of the logic here would be a test of the copy.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ext = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');
const chatHtml = fs.readFileSync(path.join(__dirname, '..', 'media', 'chat.html'), 'utf8');
const pkg = require('../package.json');

let n = 0;
function test(name, fn) { fn(); n++; console.log('  ok - ' + name); }

/**
 * The body of a named function OR class method, brace-matched (strings and comments ignored).
 * Both forms matter here: openChatInEditor is a plain function, wire/makeLive are methods on
 * ChatViewProvider, and the tests should not care which.
 */
function fnBody(src, name) {
	const decl = new RegExp('(?:^|\\n)\\s*(?:async\\s+)?(?:function\\s+)?' + name + '\\s*\\(');
	const m = decl.exec(src);
	assert.ok(m, 'extension.js no longer defines ' + name + '()');
	const start = m.index;
	const open = src.indexOf('{', start + m[0].length - 1);
	let depth = 0, i = open, inStr = '', inLine = false, inBlock = false;
	for (; i < src.length; i++) {
		const c = src[i], p = src[i - 1];
		if (inLine) { if (c === '\n') { inLine = false; } continue; }
		if (inBlock) { if (c === '/' && p === '*') { inBlock = false; } continue; }
		if (inStr) { if (c === inStr && p !== '\\') { inStr = ''; } continue; }
		if (c === '/' && src[i + 1] === '/') { inLine = true; continue; }
		if (c === '/' && src[i + 1] === '*') { inBlock = true; continue; }
		if (c === '"' || c === "'" || c === '`') { inStr = c; continue; }
		if (c === '{') { depth++; }
		else if (c === '}') { depth--; if (depth === 0) { return src.slice(open, i + 1); } }
	}
	throw new Error('unbalanced braces reading ' + name + '()');
}

// ---- 1. Exactly one live surface ----------------------------------------------------------------

test('SURFACE: only makeLive() ever moves the conversation, so two surfaces cannot both be live', () => {
	// `post()` writes to activeWebview. If anything else assigned it, a hand-over could leave the
	// pointer on a webview the user is no longer looking at — messages vanish into a hidden DOM.
	// Stated as an invariant rather than an exact list: RESETS may multiply, but the places that point
	// it at a live surface may not.
	const writes = [...ext.matchAll(/activeWebview\s*=\s*([^;]+);/g)].map((m) => m[1].trim());
	const live = writes.filter((w) => w !== 'undefined');
	assert.deepStrictEqual(live, ['webview'],
		'activeWebview is pointed at a surface somewhere other than makeLive(): ' + writes.join(' | '));
	assert.ok(writes.length > live.length, 'nothing releases activeWebview — a disposed webview stays addressable');
	assert.match(fnBody(ext, 'openChatInEditor'), /chatProvider\.makeLive\(panel\.webview\)/,
		'the panel never becomes the live surface');
});

test('SURFACE: an already-open tab is revealed, never opened twice', () => {
	// Two panels would mean two DOMs, two `ready` messages, and a race for activeWebview.
	// The guard must still be the first STATEMENT, but it now reveals with the caller's focus
	// preference — a startup open that reveals an existing tab must not yank focus either.
	const open = fnBody(ext, 'openChatInEditor');
	assert.match(open, /if \(chatEditorPanel\) \{ chatEditorPanel\.reveal\(undefined, preserveFocus\); return; \}/,
		'the already-open guard is gone or no longer honours preserveFocus');
	const guardAt = open.indexOf('if (chatEditorPanel)');
	assert.ok(guardAt >= 0 && guardAt < open.indexOf('createWebviewPanel'),
		'the guard must run before anything can construct a second panel');
	assert.strictEqual((ext.match(/createWebviewPanel\(\s*\n?\s*'levelcode\.ai\.chat'/g) || []).length, 1,
		'more than one place constructs the chat panel');
});

// ---- 2. The listener is registered once per webview ---------------------------------------------

test('WIRING: wire() is separate from makeLive(), because a listener survives an html swap', () => {
	// The sidebar's html is swapped between the chat and the hand-off card. onDidReceiveMessage lives
	// on the WEBVIEW, not the document, so wiring on every swap would stack handlers and every click
	// would fire twice — a double-sent message, a double-resolved approval.
	const wire = fnBody(ext, 'wire') || '';
	assert.match(wire, /onDidReceiveMessage/, 'wire() no longer owns the handler');
	assert.ok(!/onDidReceiveMessage/.test(fnBody(ext, 'makeLive')),
		'makeLive() registers a handler — swapping html would now duplicate it');
	assert.match(fnBody(ext, 'makeLive'), /\.html = getHtml\(\)/, 'makeLive() must load the chat');
});

test('WIRING: every surface is wired exactly once, before it is shown', () => {
	const open = fnBody(ext, 'openChatInEditor');
	assert.ok(open.indexOf('chatProvider.wire(panel.webview)') < open.indexOf('chatProvider.makeLive(panel.webview)'),
		'the panel is made live before it can receive messages');
	assert.strictEqual((open.match(/chatProvider\.wire\(/g) || []).length, 1, 'the panel is wired more than once');
});

// ---- 3. The transcript survives the hand-over ---------------------------------------------------

test('REPLAY: every hand-over arms a replay — the transcript is DOM state and would be lost', () => {
	// Three transitions exist: to the tab, back to a resolved sidebar, and back to one that was never
	// resolved. Miss any and the user lands in an empty chat holding a conversation the model still
	// remembers — the worst of both worlds.
	assert.strictEqual((ext.match(/pendingTranscriptReplay = '[^']+'/g) || []).length, 1,
		'the tab-open replay is gone, or a second hand-over path crept back in');
	assert.match(fnBody(ext, 'openChatInEditor'), /pendingTranscriptReplay = 'Moved to the editor'[\s\S]*makeLive\(panel\.webview\)/,
		'the replay must be armed BEFORE the surface loads, or `ready` fires with nothing pending');
});

test('REPLAY: it fires on `ready` and clears itself, so it cannot repeat', () => {
	// `ready` is the earliest a fresh webview can receive anything. Not clearing would replay the
	// transcript again on every later reload, stacking duplicate copies of the conversation.
	assert.match(ext, /if \(pendingTranscriptReplay\) \{ const t = pendingTranscriptReplay; pendingTranscriptReplay = ''; replayLiveTranscript\(t\); \}/,
		'the replay is not read-and-cleared in one step on ready');
});

test('REPLAY: nothing is invented when there is nothing to replay', () => {
	const body = fnBody(ext, 'replayLiveTranscript');
	assert.match(body, /if \(!id\) \{ return; \}/, 'a chat with no live session must stay empty');
	assert.match(body, /if \(!turns\.length\) \{ return; \}/, 'an empty transcript must not render a banner');
	assert.match(body, /catch \(e\)/, 'an unreadable session must not throw into a surface swap');
});

// ---- 4. The restore path ------------------------------------------------------------------------




// ---- 5. It reads as a move, not a resume --------------------------------------------------------

test('LABEL: a move is not rendered as "Resumed"', () => {
	// The same renderer serves both. Labelling a move "Resumed" would tell the user their session had
	// been reloaded from disk when nothing of the sort happened.
	assert.match(chatHtml, /esc\(m\.tag \|\| 'Resumed'\)/, 'the banner tag is hard-coded again');
	assert.match(chatHtml, /codicon\(m\.icon \|\| 'sync'\)/, 'the banner icon is hard-coded again');
	assert.match(fnBody(ext, 'replayLiveTranscript'), /tag, icon: 'layout'/, 'the replay does not name itself');
	// …and a real resume still says Resumed, because it passes no tag.
	assert.match(fnBody(ext, 'resumeSession'), /post\(\{ type: 'sessionResumed', id, title:[^}]*\}\)/);
	assert.ok(!/tag:/.test(fnBody(ext, 'resumeSession')), 'resumeSession should rely on the default label');
});

test('COMMAND: it is registered and discoverable in the palette', () => {
	// Wrapped rather than bound by reference — see the START test on menu arguments below.
	assert.match(ext, /registerCommand\('levelcode\.ai\.openChatInEditor', \(\) => openChatInEditor\(\)\)/);
	const cmd = pkg.contributes.commands.find((c) => c.command === 'levelcode.ai.openChatInEditor');
	assert.ok(cmd, 'not declared in package.json — it would not appear in the Command Palette');
	assert.match(cmd.title, /Chat in Editor/);
});

// ---- 6. Every webview document describes its own script surface --------------------------------


test('CSP: one helper describes the policy for every document the extension serves', () => {
	// The construction was duplicated in getHtml and getSessionsHtml before this; a third copy would
	// have made "tighten the CSP" a three-file change with one of them easy to miss.
	const helper = fnBody(ext, 'webviewCsp');
	assert.match(helper, /default-src 'none'/, 'no remote origins');
	assert.match(helper, /script-src 'nonce-/, 'inline script is nonce-gated');
	assert.ok(!/style-src[^;]*http/.test(helper), 'no remote stylesheets');

	// Nobody may build the policy by hand any more.
	const handRolled = (ext.match(/"default-src 'none'"/g) || []).length;
	assert.strictEqual(handRolled, 1, 'the policy string appears ' + handRolled + ' times — it should exist only inside webviewCsp()');

	// And every document generator goes through it.
	// detachedHtml was the third; it was the sidebar's hand-off card and went with the sidebar.
	for (const fn of ['getHtml', 'getSessionsHtml']) {
		assert.match(fnBody(ext, fn), /webviewCsp\(\)/, fn + '() does not use the shared policy');
	}
});

test('COMMAND: the chat TAB carries the actions the view title used to', () => {
	// New Chat, Add Files and Set API Key lived on the sidebar view's title bar. Deleting that view
	// would have deleted the only place they were reachable outside the palette — a capability nobody
	// searches for, because nobody knows it exists. They move to the tab, which is where the chat is.
	const onTab = (pkg.contributes.menus['editor/title'] || [])
		.filter((m) => m.when === "activeWebviewPanelId == 'levelcode.ai.chat'");
	const ids = onTab.map((m) => m.command);
	for (const id of ['levelcode.ai.newChat', 'levelcode.ai.addFileContext', 'levelcode.ai.setApiKey']) {
		assert.ok(ids.includes(id), id + ' lost its button when the sidebar view was removed');
		const cmd = pkg.contributes.commands.find((c) => c.command === id);
		assert.ok(cmd && cmd.icon, id + ' has no icon — an editor/title action with no icon renders as nothing');
	}
	for (const m of onTab) {
		assert.match(m.group, /^navigation@\d+$/,
			m.command + ' must be in navigation, so VS Code can overflow it into … on a narrow tab');
	}

	// And nothing may be scoped to the view that no longer exists — a stale `when` is a button that
	// never appears anywhere.
	const all = Object.values(pkg.contributes.menus).flat();
	const stale = all.filter((m) => String(m.when || '').includes('levelcodeAi.chat'));
	assert.deepStrictEqual(stale, [], 'menu entries still target the removed chat view');
});

test('START: the chat opens centred by default, and the setting is the only place that decides', () => {
	const prop = pkg.contributes.configuration.properties['levelcode.ai.chat.startLocation'];
	assert.ok(prop, 'chat.startLocation is not declared — the default would be unchangeable');
	assert.strictEqual(prop.default, 'editor', 'the chat must open in the centre by default');
	assert.deepStrictEqual(prop.enum, ['editor', 'none'],
		'the chat has one surface now; `none` is the only other honest value, and the opt-out that '
		+ 'replaced the old launch cap — dropping it leaves no way to turn this off');
	assert.strictEqual(prop.enumDescriptions.length, prop.enum.length,
		'every value needs a description, or the settings UI shows bare identifiers');

	// One reader, so a second caller cannot quietly disagree about what an unknown value means.
	const body = fnBody(ext, 'chatStartLocation');
	assert.match(body, /'editor', 'none'/, 'the reader must validate against exactly the enum the package ships');
	assert.match(body, /: 'editor'/, 'an unknown value must fall back to the default, not leave the window with no chat');
});

test('START: exactly one thing opens the chat at startup', () => {
	// The bug this pins: the old onboarding block revealed the SIDEBAR on launch. Left in place next to
	// the new centred default it would open both surfaces at once on a fresh install — and because the
	// old one was capped at five launches, it would have "fixed itself" later, which is the worst kind.
	assert.ok(!/AUTO_REVEAL_MAX_LAUNCHES/.test(ext),
		'the old capped auto-reveal is still here — it opens the sidebar alongside the new editor tab');
	const startupCalls = (ext.match(/revealChatAtStartup\(\)/g) || []).length;
	assert.strictEqual(startupCalls, 2, 'expected one definition and one call site, found ' + startupCalls);

	const body = fnBody(ext, 'revealChatAtStartup');
	assert.match(body, /where === 'none'/, 'none must return before opening anything');
	assert.match(body, /openChatInEditor\(\{ preserveFocus: true \}\)/,
		'the startup open must preserve focus — otherwise it steals the caret from a restored file');
});

test('START: the startup open cannot be triggered by a menu click', () => {
	// openChatInEditor now reads an options object from its first argument, and VS Code hands a command
	// its menu context in exactly that position. Bound by reference, a title-bar click would pass
	// whatever VS Code supplies — so the command is wrapped, and this is why.
	assert.match(ext, /registerCommand\('levelcode\.ai\.openChatInEditor', \(\) => openChatInEditor\(\)\)/,
		'bind the command through a wrapper, or a menu argument can reach the options parameter');
	assert.match(fnBody(ext, 'openChatInEditor'), /opts && opts\.preserveFocus === true/,
		'preserveFocus must be read strictly, so a stray truthy argument cannot enable it');
});

test('START: the fire-and-forget startup call cannot become an unhandled rejection', () => {
	// Nothing awaits the startup timer, so a rejection from createWebviewPanel or from the focus
	// command would land in the extension host attributed to nothing. Caught — but LOGGED, not
	// swallowed: a chat that never appears with no trace of why is the exact failure this setting is
	// supposed to make explicable.
	const call = /revealChatAtStartup\(\)([\s\S]{0,160}?)\}, 600\)/.exec(ext);
	assert.ok(call, 'the startup call site moved — this guard no longer covers it');
	assert.match(call[1], /\.catch\(/, 'the fire-and-forget startup call has no .catch — unhandled rejection');
	assert.match(call[1], /dbg\(/, 'the failure is swallowed silently; log the reason so it can be diagnosed');
});



test('FOCUS: no reveal of the chat view is left to reject unhandled', () => {
	// One guard for the whole class, rather than six assertions that each name a function. `executeCommand`
	// returns a Thenable, so a bare call in a void context makes any rejection an unhandled promise
	// rejection in the extension host — attributed to nothing, which is what makes it useless.
	//
	// Scanning every call site means the NEXT one is covered too. That matters here: this pattern was
	// copied into six places over time precisely because nothing was watching for it.
	// Repointed when the chat became editor-only: the old scan looked for
	// executeCommand('levelcodeAi.chat.focus'), a string that no longer appears anywhere, so it would
	// have kept passing while checking nothing at all. openChatInEditor() is what opens the chat now,
	// and it is async, so the same rule applies to it.
	const CALL = 'openChatInEditor(';
	const bare = [];
	for (let i = ext.indexOf(CALL); i >= 0; i = ext.indexOf(CALL, i + 1)) {
		const before = ext.slice(Math.max(0, i - 40), i);
		const after = ext.slice(i + CALL.length, i + CALL.length + 40);
		const handled = /\bfunction\s+$/.test(before)       // the declaration itself, not a call
			|| /\breturn\s+$/.test(before)                    // returned — a command handler VS Code awaits
			|| /\bawait\s+$/.test(before)                    // awaited by a caller that catches
			|| /=>\s*$/.test(before)                         // concise arrow body: also a return
			|| /Promise\.resolve\($/.test(before)            // wrapped by focusChatView
			|| /^\s*\)?\s*\.(then|catch)\(/.test(after);     // handled inline
		if (!handled) { bare.push('line ' + ext.slice(0, i).split('\n').length); }
	}
	assert.deepStrictEqual(bare, [],
		'these reveals are fire-and-forget — a rejection becomes an unhandled promise rejection.\n'
		+ 'Use focusChatView(why) for a background reveal, or `return` it when the command IS the reveal:\n  '
		+ bare.join('\n  '));
});

test('FOCUS: the shared helper logs the failure and names who caused it', () => {
	// The whole complaint was "attributed to nothing", so swallowing it silently would answer the letter
	// of the review and none of it. A chat surface that never appears, with no trace, is the failure
	// that costs an afternoon.
	const body = fnBody(ext, 'focusChatView');
	assert.match(body, /dbg\('chat\.focus\.failed'/, 'the failure is not logged — .catch(() => {}) is not a fix');
	assert.match(body, /\bwhy\b/, 'the log must name the caller, or it is as unattributed as the rejection was');
	assert.ok(!/\bthrow\b/.test(body), 'the helper must not rethrow — every caller uses it in a void context');
	// Either `.then(undefined, …)` or `.catch(…)`. They are equivalent here and pinning one would fail a
	// refactor that changes nothing; what must not disappear is the rejection handler itself.
	assert.match(body, /\.then\(undefined,|\.catch\(/, 'no rejection handler — the helper can still reject');

	// And it must be the thing the background callers actually use.
	const callers = (ext.match(/focusChatView\('/g) || []).length;
	assert.ok(callers >= 5, 'expected the background reveals to route through the helper, found ' + callers);
});

test('CLOSE: closing the tab seals the session and lets memory learn from it', () => {
	// The promise this change makes. Closing the chat is an ENDING, not a discard: the conversation
	// lands in History with its outcome recorded and its facts promoted, exactly as New Chat does.
	// Without this, shutting the tab would silently drop whatever was said.
	const dispose = ext.slice(ext.indexOf('panel.onDidDispose'), ext.indexOf('panel.onDidDispose') + 1400);
	assert.match(dispose, /sealLiveSession\('chatClosed'\)/, 'closing the tab no longer seals the session');
	assert.match(dispose, /activeWebview = undefined;/, 'the disposed webview stays addressable — post() would write into it');

	// ONE implementation, shared with New Chat. Two copies would drift, and the half that drifted
	// would be the close path, because that is the half nobody watches.
	const seal = fnBody(ext, 'sealLiveSession');
	assert.match(seal, /m\.seal\('done'\)/, 'the session is not sealed');
	assert.match(seal, /enrichMemoryAsync\(sealedId\)/, 'memory never learns from the closed session');
	assert.match(seal, /try \{/, 'sealing must not throw out of a dispose handler, where nothing can catch it');
	assert.match(fnBody(ext, 'newChat'), /sealLiveSession\('newChat'\)/,
		'New Chat has its own copy of the sealing logic again — the two will drift');
});

test('CLOSE: nothing resurrects the chat on the right', () => {
	// The reported bug, and the reason the view is gone rather than merely deprioritised: closing the
	// tab, and ⇧⌘I, both revealed a contributed view in the right-hand bar. Neither surface nor
	// command may point there any more.
	assert.ok(!/levelcodeAi\.chat\b/.test(ext),
		'extension.js still references the removed chat view — something will reveal it');
	assert.ok(!/sidebarChatView|detachedHtml|moveChatToSidebar/.test(ext),
		'dead sidebar machinery survives: the hand-over card, the move command, or the view reference');

	// ⇧⌘I must open the tab. This is the exact call that kept pulling out the right-hand panel.
	assert.match(ext, /registerCommand\('levelcode\.ai\.focus', \(\) => openChatInEditor\(\)\)/,
		'the ⇧⌘I command does not open the editor tab');
	const kb = (pkg.contributes.keybindings || []).filter((k) => k.command === 'levelcode.ai.focus');
	assert.ok(kb.length >= 1, 'the focus keybinding is gone');

	// The chat provider is still constructed — it owns wire()/makeLive() — but not as a view provider.
	assert.match(ext, /chatProvider = new ChatViewProvider\(\);/, 'nothing constructs the chat provider');
	assert.ok(!/registerWebviewViewProvider\('levelcodeAi\.chat'/.test(ext),
		'the chat is registered as a contributed view again');
	assert.match(ext, /registerWebviewViewProvider\('levelcodeAi\.sessions'/,
		'Sessions must KEEP its view — it is the right-hand container\'s reason to exist');
});

test('CLOSE: the conversation is torn down, not just sealed', () => {
	// Review caught the two halves disagreeing. sealLiveSession ends the SESSION — liveId() goes null,
	// so the next chat opens visually empty — while `conversation` and `agentMessages` still held every
	// previous turn, so the next message shipped the old history to the model anyway. An empty-looking
	// chat that secretly remembers is worse than either honest option.
	const dispose = ext.slice(ext.indexOf('panel.onDidDispose'), ext.indexOf('panel.onDidDispose') + 1400);
	assert.match(dispose, /sealLiveSession\('chatClosed'\)/, 'closing no longer seals the session');
	assert.match(dispose, /resetConversationState\(\)/,
		'closing seals but leaves conversation/agentMessages loaded — the next send replays the old history');

	// ONE teardown, shared with New Chat, or the close path drifts — and it is the path nobody watches.
	assert.match(fnBody(ext, 'newChat'), /resetConversationState\(\)/,
		'New Chat has its own copy of the teardown again');
	const reset = fnBody(ext, 'resetConversationState');
	for (const [frag, why] of [
		['conversation = []', 'the model history survives the close'],
		['agentMessages = []', 'the agent history survives the close'],
		['checkpoints.length = 0', 'the restore stack still points at a finished turn'],
		['contextFiles = []', 'stale attachments carry into the next chat'],
		['abort.abort()', 'an in-flight run keeps going with no surface to report to'],
		['reapCommands()', 'background commands outlive the chat — they are detached children'],
		['reapMcp()', 'MCP servers outlive the chat — they are detached children too']
	]) {
		assert.ok(reset.includes(frag), why + ' (missing: ' + frag + ')');
	}

	// It must NOT post: the close path is tearing the surface down, and New Chat re-renders itself.
	assert.ok(!/\bpost\(/.test(reset),
		'resetConversationState posts to the webview — on the close path that webview is being disposed');
});

test('START: a legacy secondarySidebar setting maps to the editor, and says so', () => {
	// The value was valid until the chat became editor-only, so it is still sitting in real
	// settings.json files. Left to fall through the unknown-value path it produced the right BEHAVIOUR
	// with a lying debug log — `where: secondarySidebar` while opening the editor tab.
	const body = fnBody(ext, 'chatStartLocation');
	assert.match(body, /raw === 'secondarySidebar'/, 'the legacy value is not mapped explicitly');
	assert.ok(!/\['editor', 'secondarySidebar', 'none'\]/.test(body),
		'secondarySidebar is still an accepted value — it names a surface that no longer exists');
	assert.match(body, /\['editor', 'none'\]/, 'the accepted set should be exactly what the enum ships');

	// Behaviour, evaluated from the SHIPPED source rather than a copy of it: fnBody hands back the
	// braces, so wrapping it in a declaration gives the real function with aiConfig injected.
	// aiConfig is CALLED and returns the config object, so the stub has to be a function that returns
	// one — passing the object itself is the obvious thing and it is wrong.
	const run = (v) => new Function('aiConfig',
		'function chatStartLocation() ' + body + '\nreturn chatStartLocation();')(() => ({ get: () => v }));
	assert.strictEqual(run('secondarySidebar'), 'editor', 'a legacy setting must resolve to the editor');
	assert.strictEqual(run('none'), 'none', 'the opt-out must survive');
	assert.strictEqual(run('editor'), 'editor');
	assert.strictEqual(run('nonsense'), 'editor', 'an unknown value must fall back to the default');
});

console.log('\nchatSurface: ' + n + ' tests passed.');
