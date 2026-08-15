/*---------------------------------------------------------------------------------------------
 *  Chat surfaces — sidebar ⇄ editor tab — run: node test/chatSurface.test.js
 *
 *  WHY THIS EXISTS. The chat can be hosted by a contributed WebviewView (sidebar) or a WebviewPanel
 *  (an editor tab). A view can never live in the editor grid — `ViewContainerLocation` is
 *  Sidebar | Panel | AuxiliaryBar and nothing else — so the centre needs a genuinely different
 *  object, and now two objects can host one conversation.
 *
 *  Everything that can go wrong here is STATE, not layout, and none of it is visible in a diff:
 *    · two live surfaces, so a post() reaches one and the user is looking at the other
 *    · a listener registered twice, so every click is handled twice
 *    · a hand-over that blanks the transcript, because it lives in the DOM
 *    · a restore path that only runs for one of the two ways a tab can close
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
	const writes = [...ext.matchAll(/activeWebview\s*=\s*([^;]+);/g)].map((m) => m[1].trim());
	assert.deepStrictEqual(writes.sort(), ['undefined', 'webview'],
		'activeWebview is assigned somewhere other than makeLive()/the dispose reset: ' + writes.join(' | '));
	assert.match(fnBody(ext, 'openChatInEditor'), /chatProvider\.makeLive\(panel\.webview\)/,
		'the panel never becomes the live surface');
});

test('SURFACE: an already-open tab is revealed, never opened twice', () => {
	// Two panels would mean two DOMs, two `ready` messages, and a race for activeWebview.
	assert.match(fnBody(ext, 'openChatInEditor'), /^\s*\{\s*if \(chatEditorPanel\) \{ chatEditorPanel\.reveal\(\); return; \}/,
		'the guard must be the first thing the command does');
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
	assert.strictEqual((ext.match(/pendingTranscriptReplay = '[^']+'/g) || []).length, 3,
		'a hand-over path does not arm the replay');
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

test('RESTORE: closing the tab and "Bring it back" are the SAME path', () => {
	// Two restore paths is two chances to leave the chat with no surface. The card disposes the panel
	// and lets onDidDispose do the work, rather than restoring the sidebar itself.
	assert.match(ext, /case 'reattach': if \(chatEditorPanel\) \{ chatEditorPanel\.dispose\(\); \} break;/,
		'reattach restores the sidebar directly instead of disposing the panel');
	const open = fnBody(ext, 'openChatInEditor');
	assert.match(open, /onDidDispose\(\(\) => \{/, 'no disposal handler — closing the tab would strand the chat');
	assert.match(open, /chatEditorPanel = undefined/, 'the panel ref outlives the panel');
});

test('RESTORE: a sidebar that was never resolved is revealed rather than assumed', () => {
	// If the container has not been opened this session, sidebarChatView is undefined — restoring by
	// writing to it would throw, and doing nothing would leave the chat with no surface at all.
	const open = fnBody(ext, 'openChatInEditor');
	assert.match(open, /if \(sidebarChatView\) \{[\s\S]*\} else \{[\s\S]*levelcodeAi\.chat\.focus/,
		'the never-resolved sidebar case is unhandled');
});

test('RESTORE: while detached, the sidebar shows the hand-off card, not a second chat', () => {
	assert.match(ext, /if \(chatEditorPanel\) \{ view\.webview\.html = detachedHtml\(\); return; \}/,
		'a sidebar resolving while the tab is open would load a second live chat');
	const card = fnBody(ext, 'detachedHtml');
	assert.match(card, /postMessage\(\{type:"reattach"\}\)/, 'the card offers no way back');
	assert.ok(!/getHtml\(\)/.test(card), 'the card must not be the full chat');
});

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
	assert.match(ext, /registerCommand\('levelcode\.ai\.openChatInEditor', openChatInEditor\)/);
	const cmd = pkg.contributes.commands.find((c) => c.command === 'levelcode.ai.openChatInEditor');
	assert.ok(cmd, 'not declared in package.json — it would not appear in the Command Palette');
	assert.match(cmd.title, /Chat in Editor/);
});

test('COMMAND: it has a BUTTON on the chat header, not only the palette', () => {
	// A feature whose whole point is "I did not know I could do that" is not served by a
	// palette-only entry — nobody searches for a capability they do not know exists. This shipped
	// icon-less and button-less on the first pass, which is exactly why it is pinned now.
	const cmd = pkg.contributes.commands.find((c) => c.command === 'levelcode.ai.openChatInEditor');
	assert.ok(cmd.icon, 'no icon — a view/title action with no icon renders as nothing');

	const entry = (pkg.contributes.menus['view/title'] || [])
		.find((m) => m.command === 'levelcode.ai.openChatInEditor');
	assert.ok(entry, 'not contributed to view/title — reachable only from the Command Palette');
	assert.strictEqual(entry.when, 'view == levelcodeAi.chat',
		'the button must be scoped to the chat view, or it appears on every view title in the editor');
	assert.match(entry.group, /^navigation@\d+$/,
		'navigation keeps it inline and lets VS Code overflow it into … when the sidebar is narrow');
});

console.log('\nchatSurface: ' + n + ' tests passed.');
