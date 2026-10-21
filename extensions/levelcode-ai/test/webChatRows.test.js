/*---------------------------------------------------------------------------------------------
 *  Web rows in the chat — run: node test/webChatRows.test.js
 *
 *  A web search shows as a row with its result count and time, and the pages it found as small links under it; a
 *  finished group says "searched the web" and "read a web page" (media/chat.html). The functions are lifted out of
 *  the shipped chat.html and run, as groupReducer.test.js does.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'media', 'chat.html'), 'utf8');
const scriptOpen = html.lastIndexOf('<script');
const script = html.slice(html.indexOf('>', scriptOpen) + 1, html.indexOf('</script>', scriptOpen));
function extract(name) {
	const start = script.indexOf('  function ' + name + '(');
	assert.ok(start >= 0, 'chat.html no longer defines ' + name + '()');
	const end = script.indexOf('\n  }', start);
	return script.slice(start, end + 4);
}
// The page's own escapers, so what is tested is what ships.
// eslint-disable-next-line no-new-func
const api = new Function(['esc', 'escAttr', 'webMeta', 'webSources', 'chipStep', 'groupAggregate'].map(extract).join('\n')
	+ '\nreturn { esc, escAttr, webMeta, webSources, chipStep, groupAggregate };')();

let n = 0;
function test(name, fn) { fn(); n++; console.log('  ok - ' + name); }

test('ROW: a search shows its count and time, then the pages as links named by their host, title as the tooltip', () => {
	const m = { kind: 'web', detail: '9 results · 1.2 s', sources: [{ title: 'OpenEoX report', url: 'https://docs.oasis-open.org/openeox/x.pdf', host: 'docs.oasis-open.org' }] };
	assert.strictEqual(api.webMeta(m), '<span class="webmeta">9 results · 1.2 s</span>');
	assert.strictEqual(api.webSources(m), '<div class="websrc"><a href="https://docs.oasis-open.org/openeox/x.pdf" title="OpenEoX report">docs.oasis-open.org</a></div>');
});

test('ROW: only http(s) links, at most eight, everything escaped; other rows get nothing', () => {
	const evil = { kind: 'web', detail: '<img src=x onerror=alert(1)>', sources: [
		{ title: '"><script>alert(1)</script>', url: 'https://ok.example/?a="b"&c=<d>', host: '<b>ok</b>' },
		{ title: 'js', url: 'javascript:alert(1)', host: 'js' },
		{ title: 'data', url: 'data:text/html,<script>', host: 'data' }].concat(Array.from({ length: 12 }, (_, i) => ({ title: 't' + i, url: 'https://p' + i + '.org/', host: 'p' + i + '.org' }))) };
	const out = api.webMeta(evil) + api.webSources(evil);
	assert.ok(!/<script|<img|javascript:|data:text/i.test(out), out);
	assert.strictEqual((out.match(/<a /g) || []).length, 8);
	assert.match(out, /href="https:\/\/ok\.example\/\?a=&quot;b&quot;&amp;c=&lt;d&gt;"/);
	assert.strictEqual(api.webSources({ kind: 'read', sources: [{ url: 'https://x.org/' }] }), '');
	assert.strictEqual(api.webMeta({ kind: 'search', detail: 'x' }), '');
});

test('SUMMARY: a finished group says how often it searched the web and how many pages it read', () => {
	const steps = [
		api.chipStep('globe', 'Searched the web for "a"', '', 'web', ''),
		api.chipStep('globe', 'Searched the web for "b"', '', 'web', ''),
		api.chipStep('globe', 'Read OpenEoX', '', 'webread', 'https://docs.oasis-open.org/x'),
		api.chipStep('globe', 'Looked for "x" in OpenEoX', '', 'webread', 'https://docs.oasis-open.org/x'),
	];
	assert.strictEqual(api.groupAggregate(steps), 'Searched the web 2 times, read a web page');
	assert.strictEqual(api.groupAggregate([steps[0], api.chipStep('globe', 'Read A', '', 'webread', 'https://a.org/'), api.chipStep('globe', 'Read B', '', 'webread', 'https://b.org/')]), 'Searched the web, read 2 web pages');
	assert.strictEqual(steps[0].kind, 'web'); assert.strictEqual(steps[0].base, 'Searched the web for "a"');
});

console.log('\nwebChatRows: ' + n + ' tests passed.');
