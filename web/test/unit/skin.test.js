/*---------------------------------------------------------------------------------------------
 *  The chat's browser skin — run: node web/test/unit/skin.test.js
 *
 *  The skin is a stylesheet, a class on <body> and a script, inserted into the copy of media/chat.html that goes
 *  into the browser bundle. What matters:
 *    - the desktop's chat.html is untouched, and nothing of the skin lives under extensions/;
 *    - the insertions are exactly the three, and taking them out gives the original back;
 *    - every rule of the skin is under body.lc-web, so a stray rule cannot restyle the page without the class;
 *    - the script only sends messages the page already sends;
 *    - the build says so when chat.html stops having the places the skin is cut into.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..', '..', '..');
const { skinChat, ANCHORS } = require(path.join(REPO, 'web', 'ai-extension', 'skin.js'));
const { applyCopy } = require(path.join(REPO, 'web', 'ai-extension', 'copy.js'));

const desktop = fs.readFileSync(path.join(REPO, 'extensions', 'levelcode-ai', 'media', 'chat.html'), 'utf8');
const base = applyCopy('media/chat.html', desktop);
const css = fs.readFileSync(path.join(REPO, 'web', 'ai-extension', 'skin', 'chat.css'), 'utf8');
const js = fs.readFileSync(path.join(REPO, 'web', 'ai-extension', 'skin', 'chat.js'), 'utf8');

let n = 0;
function test(name, fn) { fn(); n++; console.log('  ok - ' + name); }
const count = (text, needle) => text.split(needle).length - 1;

test('the desktop page has no trace of the skin, and no file of it is under extensions/', () => {
	assert.ok(!/lc-web|lcw-/.test(desktop), 'chat.html names the skin');
	const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
		const p = path.join(d, e.name);
		if (e.name === 'node_modules' || e.name === '.git') { return []; }
		return e.isDirectory() ? walk(p) : [p];
	});
	const strays = walk(path.join(REPO, 'extensions')).filter((f) => /skin/i.test(path.basename(f)) || (/\.(js|css|html)$/.test(f) && fs.readFileSync(f, 'utf8').includes('lcw-skin')));
	assert.deepStrictEqual(strays, []);
});

test('the skinned page is the original plus the three insertions, and nothing else', () => {
	const out = skinChat(base);
	assert.strictEqual(count(out, 'id="lcw-skin"'), 1);
	assert.strictEqual(count(out, '<body class="lc-web">'), 1);
	assert.strictEqual(count(out, '<script nonce="__NONCE__">'), count(base, '<script nonce="__NONCE__">') + 1);
	const back = out
		.replace(`</style>\n<style id="lcw-skin">\n${css}</style>\n</head>`, ANCHORS.STYLE_END)
		.replace('</head>\n<body class="lc-web">\n', ANCHORS.BODY_OPEN)
		.replace(`</script>\n<script nonce="__NONCE__">\n${js}</script>\n</body>`, ANCHORS.SCRIPT_END);
	assert.strictEqual(back, base);
});

test('the skin script is the last thing to run, after the page\'s own', () => {
	const out = skinChat(base);
	const own = out.lastIndexOf('vscode.postMessage({ type: \'ready\' });');
	assert.ok(own > 0, 'the page\'s own ready message');
	assert.ok(out.indexOf(js.slice(0, 80)) > own, 'the skin script comes after it');
});

test('every rule of the stylesheet is under body.lc-web', () => {
	const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
	let depth = 0; let head = '';
	const bad = [];
	for (const ch of text) {
		if (ch === '{') {
			const sel = head.trim();
			if (depth === 0 && !sel.startsWith('@')) { sel.split(',').forEach((s) => { if (!s.trim().startsWith('body.lc-web')) { bad.push(s.trim()); } }); }
			else if (depth === 1 && !sel.startsWith('@')) { sel.split(',').forEach((s) => { if (!s.trim().startsWith('body.lc-web')) { bad.push(s.trim()); } }); }
			depth++; head = '';
		} else if (ch === '}') { depth--; head = ''; }
		else if (ch === ';' && depth > 0) { head = ''; }
		else if (depth === 0 || (depth === 1 && head !== undefined)) { head += ch; }
	}
	assert.strictEqual(depth, 0, 'balanced braces');
	assert.deepStrictEqual(bad.filter((s) => s && !/^\d/.test(s)), []);
});

test('neither file can end its own block early', () => {
	for (const text of [css, js]) {
		assert.ok(!/<\/(script|style)/i.test(text));
		assert.ok(!text.includes('<!--'));
	}
});

test('the script is valid and sends only messages the page already sends', () => {
	assert.doesNotThrow(() => new Function(js));
	const sent = new Set([...js.matchAll(/type:\s*'([A-Za-z]+)'/g)].map((m) => m[1]));
	assert.ok(sent.size > 0);
	for (const t of sent) {
		assert.ok(new RegExp(`vscode\\.postMessage\\(\\{\\s*type:\\s*'${t}'`).test(desktop), `the page itself never sends ${t}`);
	}
});

test('the build refuses a chat.html that is not the shape the skin is cut into', () => {
	for (const anchor of [ANCHORS.STYLE_END, ANCHORS.BODY_OPEN, ANCHORS.SCRIPT_END]) {
		assert.throws(() => skinChat(base.replace(anchor, '')), /expected exactly one/);
		assert.throws(() => skinChat(base + anchor), /expected exactly one/);
	}
});

console.log(`\n${n} tests passed`);
