// The browser's look for the chat — applied to the copy of media/chat.html that goes into the browser bundle, and
// to nothing else. The desktop app packages extensions/* alone, so nothing under web/ can reach it, and chat.html
// itself stays exactly as the desktop's suites pin it (a third <script>, a hover rule or a changed measure in the
// shared file fails them).
//
// Three insertions, each at an exact, unique place; the build fails when one is missing, the way copy.js does,
// so a change to chat.html says so here instead of quietly shipping the unskinned page:
//   the skin's stylesheet   after chat.html's own <style>
//   `lc-web` on <body>      the scope every rule of the skin is under
//   the skin's script       after chat.html's own <script>, same nonce (the host replaces __NONCE__ everywhere)
//
// Plain CommonJS; web/test/unit/skin.test.js pins it against the real chat.html.
'use strict';

const fs = require('fs');
const path = require('path');

const STYLE_END = '</style>\n</head>';
const BODY_OPEN = '</head>\n<body>\n';
const SCRIPT_END = '</script>\n</body>';

const read = (name) => fs.readFileSync(path.join(__dirname, 'skin', name), 'utf8');

/**
 * @param {string} html the desktop chat.html (after copy.js has rewritten its desktop-only words)
 * @returns {string} the same page with the browser skin
 * @throws if the page is not the shape this expects, or a skin file could end its own block early
 */
function skinChat(html) {
	const css = read('chat.css');
	const js = read('chat.js');
	for (const [name, text] of [['chat.css', css], ['chat.js', js]]) {
		if (/<\/(?:script|style)/i.test(text) || text.includes('<!--')) {
			throw new Error(`browser skin: ${name} contains markup that would end its own block early`);
		}
	}
	for (const anchor of [STYLE_END, BODY_OPEN, SCRIPT_END]) {
		const n = html.split(anchor).length - 1;
		if (n !== 1) {
			throw new Error(`browser skin: expected exactly one ${JSON.stringify(anchor)} in media/chat.html, found ${n}; update web/ai-extension/skin.js`);
		}
	}
	return html
		.replace(STYLE_END, () => `</style>\n<style id="lcw-skin">\n${css}</style>\n</head>`)
		.replace(BODY_OPEN, () => '</head>\n<body class="lc-web">\n')
		.replace(SCRIPT_END, () => `</script>\n<script nonce="__NONCE__">\n${js}</script>\n</body>`);
}

module.exports = { skinChat, ANCHORS: { STYLE_END, BODY_OPEN, SCRIPT_END } };
