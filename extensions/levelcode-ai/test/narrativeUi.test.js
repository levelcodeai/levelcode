/*---------------------------------------------------------------------------------------------
 *  Unit tests for the calm-transcript webview logic — run: node test/narrativeUi.test.js
 *  (docs/CALM-TRANSCRIPT.md S3). The group header is the ONLY thing the user reads while a
 *  collapsed group works, so its grammar functions are pinned here: tense conversion for the
 *  live label, the past-tense aggregate sentence, chip→step derivation, and the command label.
 *  Like shHighlight.test.js, the functions are extracted from the shipped chat.html — these
 *  tests exercise the real code, not a copy that can drift from it.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'media', 'chat.html'), 'utf8');

// Same slicing convention as shHighlight.test.js: functions sit at 2 spaces and close with "  }".
function extract(name) {
	const start = html.indexOf('function ' + name + '(');
	assert.ok(start >= 0, 'chat.html no longer defines ' + name + '()');
	const end = html.indexOf('\n  }', start);
	assert.ok(end >= 0, 'no closing brace found for ' + name + '()');
	return html.slice(start, end + 4);
}

const sandbox = {};
new Function(
	extract('tenseLabel') + '\n' + extract('groupAggregate') + '\n' + extract('chipStep') + '\n'
	+ extract('cmdBase') + '\n'
	+ 'this.tenseLabel = tenseLabel; this.groupAggregate = groupAggregate; this.chipStep = chipStep; this.cmdBase = cmdBase;'
).call(sandbox);
const { tenseLabel, groupAggregate, chipStep, cmdBase } = /** @type {any} */ (sandbox);

let n = 0;
function test(name, fn) { fn(); n++; console.log('  ok - ' + name); }

// ── 0. The whole webview script COMPILES — catches a syntax slip anywhere in chat.html's JS.
test('chat.html script compiles', () => {
	const open = html.lastIndexOf('<script');
	const start = html.indexOf('>', open) + 1;
	const end = html.indexOf('</script>', start);
	assert.ok(open >= 0 && end > start, 'no <script> block found');
	new Function(html.slice(start, end));   // compile only — never executed
});

// ── 1. tenseLabel: the live header (progressive) and finished rows (past).
test('progressive converts every verb slot ("and" re-arms)', () => {
	assert.strictEqual(tenseLabel('Verify the edit and check repo state', 0), 'Verifying the edit and checking repo state');
});
test('past converts the same label', () => {
	assert.strictEqual(tenseLabel('Verify the edit and check repo state', 1), 'Verified the edit and checked repo state');
});
test('irregular past: run → Ran, find → Found', () => {
	assert.strictEqual(tenseLabel('Run the extension unit tests', 1), 'Ran the extension unit tests');
	assert.strictEqual(tenseLabel('Find the insertion point in section 10', 0), 'Finding the insertion point in section 10');
});
test('a comma re-arms the verb slot', () => {
	assert.strictEqual(tenseLabel('Draft the spec, run it, read the failure', 0), 'Draft the spec, running it, reading the failure');
});
test('unknown leading verb passes through unchanged', () => {
	assert.strictEqual(tenseLabel('Bootstrap the repo', 0), 'Bootstrap the repo');
});
test('a verb-shaped word mid-phrase is NOT converted (only verb slots)', () => {
	assert.strictEqual(tenseLabel('Read the run output', 1), 'Read the run output');
});
test('lowercase labels keep their case', () => {
	assert.strictEqual(tenseLabel('run tests', 0), 'running tests');
});

// ── 2. groupAggregate: the collapsed summary sentence.
const S = (kind, path) => ({ kind, path, base: '', status: 'done' });
// Clause ORDER is load-bearing: file work leads, commands trail — matching the reference transcript
// ("Read and edited extension.js, ran a command"). An earlier build inverted it and read wrong.
test('the reference sentence: read-and-edited same file, then commands', () => {
	assert.strictEqual(
		groupAggregate([S('cmd'), S('cmd'), S('read', 'docs/PLAN.md'), S('edit', 'docs/PLAN.md')]),
		'Read and edited PLAN.md, ran 2 commands');
});
test('the other reference sentence: 4 files then a single command', () => {
	assert.strictEqual(
		groupAggregate([S('read', 'a.js'), S('read', 'b.js'), S('read', 'c.js'), S('read', 'd.js'), S('cmd')]),
		'Read 4 files, ran a command');
});
test('a lone command reads "a command", not "1 command"', () => {
	assert.strictEqual(groupAggregate([S('cmd')]), 'Ran a command');
});
test('different files split into read/edited clauses', () => {
	assert.strictEqual(groupAggregate([S('read', 'a.md'), S('edit', 'b.md')]), 'Read a.md, edited b.md');
});
test('more than two files collapse to a count', () => {
	assert.strictEqual(groupAggregate([S('edit', 'a'), S('edit', 'b'), S('edit', 'c')]), 'Edited 3 files');
});
test('repeat reads dedupe before folding', () => {
	assert.strictEqual(
		groupAggregate([S('read', 'PLAN.md'), S('read', 'PLAN.md'), S('edit', 'PLAN.md')]),
		'Read and edited PLAN.md');
});
test('creates, deletes and verify get their clauses', () => {
	assert.strictEqual(groupAggregate([S('create', 'x.js'), S('delete', 'y.js')]), 'Created x.js, deleted y.js');
	assert.strictEqual(groupAggregate([S('cmd'), S('verify')]), 'Ran a command, verified the edits');
});
test('searches summarize; notes alone fall back to a step count', () => {
	assert.strictEqual(groupAggregate([S('search'), S('cmd')]), 'Searched the workspace, ran a command');
	assert.strictEqual(groupAggregate([S('note'), S('note')]), '2 steps');
});

// ── 3. chipStep: chips → steps. The model's own label wins; parsing `text` is the fallback.
test('the model label titles the row (and carries the path for the aggregate)', () => {
	assert.deepStrictEqual(
		chipStep('file', 'read src/agent.js', 'read the runAgent call site.', 'read', 'src/agent.js'),
		{ kind: 'read', base: 'Read the runAgent call site', path: 'src/agent.js' });
});
test('no label → derive from the legacy text (older transcripts still group)', () => {
	assert.deepStrictEqual(chipStep('file', 'read docs/PLAN.md'), { kind: 'read', base: 'Read docs/PLAN.md', path: 'docs/PLAN.md' });
});
test('search and list chips get canonical bases; anything else is a note', () => {
	assert.strictEqual(chipStep('search', 'search "foo"').kind, 'search');
	assert.strictEqual(chipStep('search', 'search "foo"', 'find every postMessage call site').base, 'Find every postMessage call site');
	assert.strictEqual(chipStep('list-tree', 'list_files **/*.js').base, 'List files');
	assert.deepStrictEqual(chipStep('warning', 'response was cut off'), { kind: 'note', base: 'response was cut off' });
});

// ── 4. cmdBase: the model's explanation is the label; the raw command is only a fallback.
test('explanation wins, trailing period stripped, capitalized', () => {
	assert.strictEqual(cmdBase({ explanation: 'find the insertion point in section 10.', command: 'grep -n x' }),
		'Find the insertion point in section 10');
});
test('fallback: first command segment, backticked and truncated', () => {
	assert.strictEqual(cmdBase({ command: 'npm test && npm run lint' }), 'Run `npm test`');
	const long = 'x'.repeat(60);
	assert.strictEqual(cmdBase({ command: long }), 'Run `' + 'x'.repeat(48) + '…`');
});

console.log('narrativeUi: ' + n + ' tests passed');
