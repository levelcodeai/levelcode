// Words that are true on the desktop and false in a tab, and what the browser build says instead.
//
// The desktop extension's text is written for a Mac: keys in the OS keychain, nothing leaves "your
// machine". In a browser the same facts read differently (keys are sealed in this browser's
// storage; the page runs on the user's machine but the files may be in the browser's own store).
// A claim about where a secret lives has to be right, so the browser build rewrites these exact
// strings and FAILS if one is not found: when the desktop copy changes, the build says so instead
// of quietly shipping the old claim.
//
// Plain CommonJS; web/test/unit/copy.test.js pins it against the real sources.
'use strict';

/** [file relative to extensions/levelcode-ai, exact desktop text, browser text] */
const REPLACEMENTS = [
	['extension.js',
		'Stored encrypted in your OS keychain — it never leaves your machine except to ',
		'Stored encrypted in this browser — it never leaves this browser except to '],
	['media/chat.html',
		'Bring your own API key, stored in your OS keychain.',
		'Bring your own API key, stored encrypted in this browser.'],
	['media/chat.html',
		'Your keys never leave your machine — requests go direct to your provider.',
		'Your keys never leave this browser — requests go direct to your provider.'],
];

/**
 * @param {string} file path relative to extensions/levelcode-ai
 * @param {string} text the file's contents
 * @returns {string} the text with every replacement for `file` applied
 * @throws if a replacement's desktop text is not in the file
 */
function applyCopy(file, text) {
	let out = text;
	for (const [f, from, to] of REPLACEMENTS) {
		if (f !== file) { continue; }
		if (!out.includes(from)) {
			throw new Error(`browser copy: "${from.slice(0, 60)}…" is no longer in ${file}; update web/ai-extension/copy.js`);
		}
		out = out.split(from).join(to);
	}
	return out;
}

module.exports = { REPLACEMENTS, applyCopy };
