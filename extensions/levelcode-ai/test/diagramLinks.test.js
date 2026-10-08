/*---------------------------------------------------------------------------------------------
 *  Rich diagrams — code links — run: node test/diagramLinks.test.js
 *
 *  docs/RICH-DIAGRAMS.md, "Link safety": "openLink only resolves paths inside the current workspace,
 *  after normalizing `..` segments and symlinks. Anything else is shown as plain text."
 *
 *  A link is model output. These tests are the attacker's side of it: every way to name a file the
 *  user did not open — `..`, an absolute path, a URL scheme, a symlink planted inside the repo — run
 *  against a real directory tree on disk.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { resolveLink, findSymbolLine } = require('../diagram/links');

let n = 0;
function test(name, fn) { fn(); n++; console.log('  ok - ' + name); }

// A workspace with one real file, a secret OUTSIDE it, and symlinks that try to reach the secret.
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lc-links-')));
process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* temp */ } });
const ws = path.join(tmp, 'app'), other = path.join(tmp, 'lib'), outside = path.join(tmp, 'outside');
for (const d of [path.join(ws, 'src'), other, outside]) { fs.mkdirSync(d, { recursive: true }); }
fs.writeFileSync(path.join(ws, 'src', 'agent.js'), 'function runAgent() {}\n');
fs.writeFileSync(path.join(other, 'util.js'), 'exports.x = 1;\n');
fs.writeFileSync(path.join(outside, 'secret.env'), 'TOKEN=1\n');
let symlinks = true;
try {
	fs.symlinkSync(path.join(outside, 'secret.env'), path.join(ws, 'src', 'innocent.js'));
	fs.symlinkSync(outside, path.join(ws, 'vendor'));
	fs.symlinkSync(path.join(ws, 'src', 'agent.js'), path.join(ws, 'alias.js'));
} catch (e) { symlinks = false; }
const one = [{ name: 'app', root: ws }];
const two = [{ name: 'app', root: ws }, { name: 'lib', root: other }];
const ok = (r) => { assert.strictEqual(r.ok, true, JSON.stringify(r)); return r; };
const no = (r) => { assert.strictEqual(r.ok, false, 'should have been refused: ' + JSON.stringify(r)); return r; };

test('INSIDE: a workspace-relative path to a real file resolves, and is reported relative', () => {
	const r = ok(resolveLink({ path: 'src/agent.js' }, one));
	assert.strictEqual(r.path, 'src/agent.js');
	assert.strictEqual(r.abs, path.join(ws, 'src', 'agent.js'));
	assert.strictEqual(ok(resolveLink({ path: './src/../src/agent.js' }, one)).path, 'src/agent.js', '`..` that stays inside is just normalised');
	assert.strictEqual(ok(resolveLink({ path: path.join(ws, 'src', 'agent.js') }, one)).path, 'src/agent.js', 'an absolute path INTO the workspace is the same file');
});

test('OUTSIDE: `..` out of the workspace is refused, however it is dressed', () => {
	for (const p of ['../outside/secret.env', 'src/../../outside/secret.env', '../../../../../../etc/passwd', 'src/../../../etc/hosts', '..', '../app/../outside/secret.env']) {
		assert.match(no(resolveLink({ path: p }, one)).reason, /outside this workspace|no such file/, p);
	}
});

test('OUTSIDE: an absolute path to anywhere else is refused', () => {
	for (const p of [path.join(outside, 'secret.env'), '/etc/passwd', os.homedir(), path.join(os.homedir(), '.ssh', 'id_rsa')]) {
		assert.strictEqual(no(resolveLink({ path: p }, one)).reason, 'outside this workspace', p);
	}
});

test('SCHEMES: anything that is a URL is refused before the file system is touched', () => {
	const touched = [];
	const spy = { statSync: (p) => { touched.push(p); return fs.statSync(p); }, realpathSync: (p) => { touched.push(p); return fs.realpathSync(p); } };
	for (const p of ['javascript:alert(1)', 'file:///etc/passwd', 'http://evil.example/x.js', 'https://evil.example/', 'vscode://file/etc/passwd', 'command:workbench.action.terminal.new', 'data:text/html,<script>1</script>', 'JaVaScRiPt:alert(1)', 'ftp://x']) {
		assert.strictEqual(no(resolveLink({ path: p }, one, { fs: spy })).reason, 'not a file path', p);
	}
	assert.deepStrictEqual(touched, [], 'refused on sight');
});

test('SYMLINKS: a link inside the repo that points outside it is refused — the REAL path decides', () => {
	if (!symlinks) { console.log('    (symlinks unavailable on this file system — skipped)'); return; }
	assert.strictEqual(no(resolveLink({ path: 'src/innocent.js' }, one)).reason, 'it is a link to somewhere outside this workspace');
	assert.strictEqual(no(resolveLink({ path: 'vendor/secret.env' }, one)).reason, 'it is a link to somewhere outside this workspace', 'through a symlinked DIRECTORY too');
	assert.strictEqual(ok(resolveLink({ path: 'alias.js' }, one)).path, 'alias.js', 'a symlink that stays inside the workspace is fine');
});

test('SYMLINKS: a workspace that is itself reached through a symlink still works', () => {
	if (!symlinks) { console.log('    (skipped)'); return; }
	const via = path.join(tmp, 'via');
	fs.symlinkSync(ws, via);
	assert.strictEqual(ok(resolveLink({ path: 'src/agent.js' }, [{ name: 'app', root: via }])).path, 'src/agent.js');
});

test('FILES ONLY: a directory, a missing file and an empty path are not links', () => {
	assert.strictEqual(no(resolveLink({ path: 'src' }, one)).reason, 'no such file in this workspace');
	assert.strictEqual(no(resolveLink({ path: 'src/nope.js' }, one)).reason, 'no such file in this workspace');
	for (const junk of [{ path: '' }, { path: '   ' }, {}, null, undefined, { path: 42 }, { path: ['src/agent.js'] }]) { assert.strictEqual(no(resolveLink(junk, one)).reason, 'no path'); }
	assert.strictEqual(no(resolveLink({ path: 'src/agent.js\u0000.png' }, one)).reason, 'not a path');
	assert.strictEqual(no(resolveLink({ path: 'src/agent.js' }, [])).reason, 'no folder is open');
	assert.strictEqual(no(resolveLink({ path: 'src/agent.js' }, null)).reason, 'no folder is open');
});

test('MULTI-ROOT: a folder-name prefix picks that folder, and the answer keeps the prefix', () => {
	assert.strictEqual(ok(resolveLink({ path: 'lib/util.js' }, two)).path, 'lib/util.js');
	assert.strictEqual(ok(resolveLink({ path: 'app/src/agent.js' }, two)).path, 'app/src/agent.js');
	assert.strictEqual(ok(resolveLink({ path: 'util.js' }, two)).path, 'lib/util.js', 'an unprefixed path is found in whichever folder has it');
	assert.strictEqual(no(resolveLink({ path: 'lib/../../outside/secret.env' }, two)).reason, 'outside this workspace');
});

test('SYMBOLS: the text fallback finds where a name is defined, not just where it is mentioned', () => {
	const src = ['// runAgent drives the loop', 'const x = runAgent;', 'async function runAgent(ctx) {', '  return runTool(ctx);', '}', 'const runTool = async (tu) => {};', 'class Planner {}', 'def render_diagram(spec):'].join('\n');
	assert.strictEqual(findSymbolLine(src, 'runAgent'), 3);
	assert.strictEqual(findSymbolLine(src, 'runTool'), 6);
	assert.strictEqual(findSymbolLine(src, 'Planner'), 7);
	assert.strictEqual(findSymbolLine(src, 'render_diagram'), 8);
	assert.strictEqual(findSymbolLine(src, 'Agent.runAgent()'), 3, 'a qualified name is matched by its last part');
	assert.strictEqual(findSymbolLine(src, 'x'), 2);
	assert.strictEqual(findSymbolLine(src, 'nowhere'), null);
	assert.strictEqual(findSymbolLine(src, 'run'), null, 'a whole-word match — "run" is not "runAgent"');
	for (const junk of ['', '   ', '.*', '(', 'a b', null, undefined]) { assert.doesNotThrow(() => findSymbolLine(src, junk)); }
	assert.strictEqual(findSymbolLine(src, '.*'), null, 'a symbol is never used as a pattern');
});

console.log('diagramLinks: ' + n + ' tests passed');
