/*---------------------------------------------------------------------------------------------
 *  Rich diagrams — the editor's half, EXECUTED — run: node test/diagramHost.test.js
 *
 *  docs/RICH-DIAGRAMS.md, "Safe rendering": the host accepts exactly two things from a diagram —
 *  `openLink` and `export` — plus the user's own Retry and a request for the text fallback; and
 *  "Context budget": a spec is stubbed at compaction, never turn by turn.
 *
 *  extension.js cannot be required outside the editor, so — as sessionExpiredHost.test.js does — its
 *  own functions are sliced out of the source and run against a small stand-in for `vscode`, with the
 *  REAL diagram service, the REAL link resolver and a real directory on disk behind them. A name that
 *  is out of scope, or a branch that is never reached, fails here; a regex over the source would not.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const EXT_DIR = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(EXT_DIR, 'extension.js'), 'utf8');
const chatHtml = fs.readFileSync(path.join(EXT_DIR, 'media', 'chat.html'), 'utf8');
const pkg = require('../package.json');
const catalog = require('../providers/catalog');
const sessionMemory = require('../sessionMemory');
const { findCompactionCut, estimateMsgTokens } = require('../agentMemory');
const { createDiagrams } = require('../diagram/service');
const bundle = require('../diagram/bundle');
const diagramLinks = require('../diagram/links');
const diagramExport = require('../diagram/exportCheck');
const diagramText = require('../diagram/text');
const diagramTool = require('../diagram/tool');
const scene = require('../diagram/scene');
const layout = require('../diagram/layout');
const theme = require('../diagram/theme');
const repair = require('../diagram/repair');
const ascii = require('../diagram/ascii');

let n = 0;
async function test(name, fn) { await fn(); n++; console.log('  ok - ' + name); }

// ── slicing (the same brace matcher the other host suites use) ────────────────────────────────────
function extract(name) {
	let start = src.indexOf('function ' + name + '(');
	assert.ok(start >= 0, 'extension.js no longer defines ' + name + '()');
	const open = src.indexOf('{', start);
	if (src.slice(start - 6, start) === 'async ') { start -= 6; }
	let depth = 0, str = '', comment = '';
	for (let i = open; i < src.length; i++) {
		const ch = src[i], next = src[i + 1];
		if (comment === 'line') { if (ch === '\n') { comment = ''; } continue; }
		if (comment === 'block') { if (ch === '*' && next === '/') { comment = ''; i++; } continue; }
		if (str) { if (ch === '\\') { i++; } else if (ch === str) { str = ''; } continue; }
		if (ch === '/' && next === '/') { comment = 'line'; i++; continue; }
		if (ch === '/' && next === '*') { comment = 'block'; i++; continue; }
		if (ch === '"' || ch === "'" || ch === '`') { str = ch; continue; }
		if (ch === '{') { depth++; }
		else if (ch === '}' && --depth === 0) { return src.slice(start, i + 1); }
	}
	assert.fail('no matching closing brace found for ' + name + '()');
}
function decl(name) {
	const m = new RegExp('^(?:const|let) ' + name + ' = [^;\\n]*;', 'm').exec(src);
	assert.ok(m, 'extension.js no longer declares ' + name);
	return m[0];
}

// ── a workspace on disk ───────────────────────────────────────────────────────────────────────────
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lc-dhost-')));
process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* temp */ } });
const ws = path.join(tmp, 'app'), outside = path.join(tmp, 'outside');
fs.mkdirSync(path.join(ws, 'src'), { recursive: true }); fs.mkdirSync(outside);
fs.writeFileSync(path.join(ws, 'src', 'agent.js'), ['// the loop', 'const x = 1;', 'async function runAgent(ctx) {', '  return x;', '}', 'function runTool() {}', ''].join('\n'));
fs.writeFileSync(path.join(ws, 'README.md'), '# App\n');
fs.writeFileSync(path.join(outside, 'secret.env'), 'TOKEN=1\n');

// ── the stand-in for `vscode`: records what the host asks of the editor ───────────────────────────
function makeVscode() {
	const ui = { warnings: [], infos: [], errors: [], opened: [], shown: [], written: [], clipboard: [], saveAs: undefined, pick: undefined, symbols: null, active: null, edits: [], untitled: [], langs: ['javascript', 'markdown', 'json'] };
	class Position { constructor(line, character) { this.line = line; this.character = character; } }
	class Range { constructor(a, b) { this.start = a; this.end = b; } }
	class Selection extends Range { get active() { return this.end; } }
	const docFor = (uri) => { const text = fs.readFileSync(uri.fsPath, 'utf8'); const lines = text.split('\n'); return { uri, languageId: /\.md$/.test(uri.fsPath) ? 'markdown' : 'javascript', lineCount: lines.length, getText: () => text, lineAt: (i) => ({ range: new Range(new Position(i, 0), new Position(i, lines[i].length)) }) }; };
	const vscode = {
		Position, Range, Selection,
		Uri: { file: (p) => ({ fsPath: p, scheme: 'file' }) },
		workspace: {
			workspaceFolders: [{ name: 'app', uri: { fsPath: ws } }],
			openTextDocument: async (arg) => { if (arg && arg.fsPath) { ui.opened.push(arg.fsPath); return docFor(arg); } ui.untitled.push(arg); return { untitled: true, content: arg.content, languageId: arg.language }; },
			fs: { writeFile: async (uri, bytes) => { ui.written.push({ path: uri.fsPath, bytes: Buffer.from(bytes) }); } },
			findFiles: async () => [{ fsPath: path.join(ws, 'README.md'), scheme: 'file' }],
			asRelativePath: (u) => path.relative(ws, u.fsPath),
			getWorkspaceFolder: (uri) => (uri && String(uri.fsPath).startsWith(ws + path.sep) ? { name: 'app' } : undefined)
		},
		window: {
			get activeTextEditor() { return ui.active; },
			showWarningMessage: async (m) => { ui.warnings.push(m); },
			showInformationMessage: async (m) => { ui.infos.push(m); },
			showErrorMessage: async (m) => { ui.errors.push(m); },
			showSaveDialog: async (o) => { ui.saveDialog = o; return ui.saveAs ? { fsPath: ui.saveAs } : undefined; },
			showQuickPick: async (items) => { ui.picks = items; return ui.pick === undefined ? undefined : items[ui.pick]; },
			showTextDocument: async (doc, opts) => { ui.shown.push({ doc, opts }); const ed = { document: doc, selection: new Selection(new Position(0, 0), new Position(0, 0)), edit: async (fn) => { fn({ insert: (pos, text) => ui.edits.push({ pos, text, file: doc.uri && doc.uri.fsPath }) }); return true; } }; return ed; }
		},
		env: { clipboard: { writeText: async (t) => { ui.clipboard.push(t); } } },
		commands: { executeCommand: async (cmd) => { if (cmd === 'vscode.executeDocumentSymbolProvider') { if (ui.symbols === 'throw') { throw new Error('no provider'); } return ui.symbols; } return undefined; } },
		languages: { getLanguages: async () => ui.langs }
	};
	return { vscode, ui };
}

const HOST = ['clientRender', 'openDiagramLink', 'diagramMarkdown', 'exportDiagram', 'retryDiagram', 'diagramAsciiText', 'handleDiagramAction', 'serializeMsgForSummary', 'compactAgentMemory', 'resumeSession', 'isWorkspaceFile', 'webviewCsp', 'getHtml'];
// eslint-disable-next-line no-new-func
const makeHost = new Function('env', [
	"'use strict';",
	'const { vscode, host, fs, path, os, catalog, sessionMemory, diagrams, diagramLinks, diagramExport, diagramText, diagramTool, diagramBundle, diagramAscii, aiConfig, dbg,',
	'  recordDiagramStat, agentFlow, findCompactionCut, estimateMsgTokens, meterModel, prepProviderRequest, authRetry, providers, checkpoints, ctx,',
	'  sessionsManager, currentContextLimit, post, replaySessionExpired, postContextFiles, refreshSessions, focusChatView } = env;',
	"const COMPACT_SYSTEM = 'system', COMPACT_INSTRUCTIONS = 'Summarize:\\n';",
	decl('FILE_EXCLUDES'),
	'let abort = null, agentMessages = [], lastAgentGoal = null, diagramsStubbed = false;',
	'let conversation = [], currentCheckpoint = null, agentMode = true;',
	decl('diagramFolders'),
	...HOST.map(extract),
	'return { ' + HOST.join(', ') + ',',
	'  setAbort: (v) => { abort = v; }, setMessages: (m) => { agentMessages = m; }, messages: () => agentMessages,',
	'  stubbed: () => diagramsStubbed, goal: () => lastAgentGoal, setGoal: (g) => { lastAgentGoal = g; } };'
].join('\n'));

function boot(over) {
	const { vscode, ui } = makeVscode();
	const stats = [], logs = [], flows = [], posted = [];
	const settings = Object.assign({ 'diagrams.enabled': true }, over && over.settings);
	const diagrams = createDiagrams({ resolveLink: (link) => diagramLinks.resolveLink(link, [{ name: 'app', root: ws }]), onStat: (ev) => stats.push(ev) });
	const env = {
		vscode,
		// The host module (host.js) as the desktop sees it: workspace paths are files on disk.
		host: { isBrowser: false, caps: { shell: true, mcpStdio: true, ripgrep: true }, uriFor: (abs) => vscode.Uri.file(abs) },
		fs, path, os, catalog, sessionMemory, diagrams, diagramLinks, diagramExport, diagramText, diagramTool, diagramBundle: bundle,
		diagramAscii: (over && over.ascii) || ascii,
		aiConfig: () => ({ get: (k, d) => (k in settings ? settings[k] : d) }),
		dbg: (label, data) => logs.push({ label, data }),
		recordDiagramStat: (ev) => stats.push(ev),
		agentFlow: async (text) => { flows.push(text); host.setGoal(text); },
		findCompactionCut, estimateMsgTokens, meterModel: () => 'm',
		prepProviderRequest: async () => ({ ok: true, providerId: 'claude', model: 'm' }),
		authRetry: async (req, fn) => fn(req),
		providers: { complete: async () => (over && over.summary) || '- built the routing diagram' },
		checkpoints: [],
		ctx: { extensionPath: EXT_DIR },
		sessionsManager: () => (over && over.sessions) || null,
		currentContextLimit: () => 200000,
		post: (m) => posted.push(m),
		replaySessionExpired: async () => { }, postContextFiles: () => { }, refreshSessions: () => { }, focusChatView: () => { }
	};
	const host = makeHost(env);
	return { host, ui, diagrams, stats, logs, flows, posted };
}
const jev = () => ({
	title: 'Jev classifies; your code decides the action',
	nodes: [{ id: 'in', label: 'Customer message' }, { id: 'jev', label: 'Jev', accent: true, link: { path: 'src/agent.js', symbol: 'runAgent' } }, { id: 'bill', label: 'Route to billing', link: { path: 'src/agent.js', line: 6 } }],
	edges: [{ from: 'in', to: 'jev' }, { from: 'jev', to: 'bill', label: '0.90 or more' }]
});
function drawn(b, input, key) { b.diagrams.beginRun(); const out = b.diagrams.render(input || jev(), { key: key || 'toolu_1', model: 'm' }); b.diagrams.endRun(); return out.post.find((m) => m.type === 'diagram').record; }

(async () => {
	try {
		// ── the page ────────────────────────────────────────────────────────────────────────────────

		await test('BUNDLE: every module that ships to the chat exists, and none can end the script block it is inlined into', async () => {
			assert.deepStrictEqual(bundle.FILES, ['theme.js', 'schema.js', 'validate.js', 'repair.js', 'layout.js', 'scene.js', 'text.js', 'ascii.js']);
			for (const f of bundle.FILES) {
				const text = fs.readFileSync(path.join(EXT_DIR, 'diagram', f), 'utf8');
				assert.ok(!bundle.BREAKS_SCRIPT.test(text), 'diagram/' + f + ' spells a script tag or an HTML comment opener — even in a comment, that ends the inline block early');
			}
			assert.ok(bundle.webviewSource().length > 20000);
			for (const hostOnly of ['tool.js', 'service.js', 'stats.js', 'bundle.js', 'links.js', 'exportCheck.js']) { assert.ok(!bundle.FILES.includes(hostOnly), hostOnly + ' is the host\'s; it must not be shipped to the webview'); }
			assert.ok(!/require\('fs'\)|child_process|require\('vscode'\)/.test(bundle.webviewSource()), 'nothing that ships to the page touches the file system or the editor API');
		});

		await test('BUNDLE: with no `require` and no `module` — a browser — the modules wire themselves up and draw the same picture', async () => {
			const sandbox = { globalThis: null };
			sandbox.globalThis = sandbox;
			vm.createContext(sandbox);
			vm.runInContext(bundle.webviewSource(), sandbox);
			const D = sandbox.LCDiagram;
			assert.deepStrictEqual(Object.keys(D).sort(), ['ascii', 'layout', 'repair', 'scene', 'schema', 'text', 'theme', 'validate']);
			const spec = repair.prepare(jev()).spec;
			const inPage = D.layout.layout(D.repair.accept(JSON.parse(JSON.stringify(spec))).spec, {});
			assert.deepStrictEqual(JSON.parse(JSON.stringify(inPage)), JSON.parse(JSON.stringify(layout.layout(spec, {}))), 'one layout, wherever it runs');
			assert.strictEqual(D.scene.toSvg(D.scene.build(spec, inPage, {})), scene.toSvg(scene.build(spec, layout.layout(spec, {}), {})));
			assert.strictEqual(D.theme.css(), theme.css());
		});

		await test('PAGE: chat.html carries one placeholder for the styles and one for the modules, and the modules load first', async () => {
			assert.strictEqual(chatHtml.split('/*__LCD_CSS__*/').length, 2);
			assert.strictEqual(chatHtml.split('/*__LCD_JS__*/').length, 2);
			assert.ok(chatHtml.indexOf('/*__LCD_CSS__*/') < chatHtml.indexOf('</style>'), 'the stylesheet placeholder is inside the style block');
			const lib = chatHtml.indexOf('<script nonce="__NONCE__">/*__LCD_JS__*/</' + 'script>');
			assert.ok(lib > 0, 'the module block carries the page nonce and nothing else');
			assert.ok(lib < chatHtml.indexOf('const vscode = acquireVsCodeApi();'), 'and comes before the script that uses it');
			assert.strictEqual((chatHtml.match(/<script/g) || []).length, 2, 'two script blocks: the modules, then the chat');
			assert.ok(!/<script[^>]*\ssrc=/.test(chatHtml), 'nothing is loaded by URL');
		});

		await test('PAGE: getHtml() inlines both, under the SAME policy as before — nothing added to the CSP', async () => {
			const b = boot();
			const html = b.host.getHtml();
			assert.ok(!/__LCD_|__CSP__|__NONCE__/.test(html), 'no placeholder survives');
			assert.ok(html.includes(bundle.webviewSource()), 'the modules are in the page verbatim (a "$" in the source is not read as a pattern)');
			assert.ok(html.includes(theme.css()), 'and so is the stylesheet');
			const csp = /<meta http-equiv="Content-Security-Policy" content="([^"]*)">/.exec(html)[1];
			const nonce = /script-src 'nonce-([^']+)'/.exec(csp)[1];
			assert.deepStrictEqual(csp.split('; '), ["default-src 'none'", 'img-src data:', "style-src 'unsafe-inline'", "script-src 'nonce-" + nonce + "'"], 'the policy is exactly what it was: no new source, no unsafe-eval, no frame or connect');
			const scripts = html.match(/<script[^>]*>/g);
			assert.deepStrictEqual(scripts, ['<script nonce="' + nonce + '">', '<script nonce="' + nonce + '">']);
			// the whole page still parses as two scripts: nothing in the bundle closed its block early
			const blocks = html.split('<script nonce="' + nonce + '">').slice(1).map((s) => s.slice(0, s.indexOf('</' + 'script>')));
			assert.strictEqual(blocks.length, 2);
			for (const code of blocks) { assert.doesNotThrow(() => new Function(code), 'an inlined block is not valid JavaScript'); }   // eslint-disable-line no-new-func
			assert.ok(blocks[0].includes('LCDiagram') && blocks[1].includes('acquireVsCodeApi'));
		});

		// ── the capability flag ───────────────────────────────────────────────────────────────────────

		await test('CAPABILITY: rich by default; the setting or a model that opts out makes it an ASCII client', async () => {
			assert.strictEqual(pkg.contributes.configuration.properties['levelcode.ai.diagrams.enabled'].default, true);
			assert.strictEqual(boot().host.clientRender('claude', 'claude-opus-4-8'), 'rich');
			assert.strictEqual(boot({ settings: { 'diagrams.enabled': false } }).host.clientRender('claude', 'claude-opus-4-8'), 'ascii');
			assert.strictEqual(boot().host.clientRender('openai', 'o1-mini'), 'ascii', 'a model that cannot call tools cannot draw');
			assert.strictEqual(catalog.diagramSupportForModel('openrouter', 'vendor/some-unlisted-model'), 'tool');
			catalog.CAPS['test/no-diagrams'] = { tools: true, diagrams: false };
			try { assert.strictEqual(boot().host.clientRender('openrouter', 'test/no-diagrams'), 'ascii', 'the registry switch: one line in CAPS'); }
			finally { delete catalog.CAPS['test/no-diagrams']; }
		});

		// ── the two actions a diagram may ask for ───────────────────────────────────────────────────

		await test('ROUTING: only openLink, export, retry and ascii are routed — and only for a real diagram id', async () => {
			const b = boot();
			const rec = drawn(b);
			for (const bad of [{ action: 'openLink', id: '../../etc', node: 'jev' }, { action: 'openLink', id: 'd-1; rm -rf', node: 'jev' }, { action: 'openLink', node: 'jev' }, { action: 'runCommand', id: rec.id, command: 'whoami' }, { action: 'eval', id: rec.id }, null, undefined, {}]) {
				await b.host.handleDiagramAction(bad);
			}
			assert.deepStrictEqual([b.ui.opened, b.ui.written, b.ui.clipboard, b.flows, b.posted], [[], [], [], [], []], 'nothing happened');
			await b.host.handleDiagramAction({ action: 'openLink', id: rec.id, node: 'jev' });
			assert.deepStrictEqual(b.ui.opened, [path.join(ws, 'src', 'agent.js')]);
		});

		await test('FALLBACK: a chat with no renderer is sent the same diagram drawn with characters — from the host\'s record, by the same layout', async () => {
			const b = boot();
			const rec = drawn(b);
			// whatever the webview sends along with the request is ignored: the text is made from the record
			await b.host.handleDiagramAction({ action: 'ascii', id: rec.id, text: 'pwned', spec: { title: 'pwned', nodes: [{ id: 'x', label: 'pwned' }], edges: [] } });
			assert.strictEqual(b.posted.length, 1);
			const m = b.posted[0];
			assert.deepStrictEqual([m.type, m.id], ['diagramAscii', rec.id]);
			assert.strictEqual(m.text, ascii.render(repair.accept(rec.spec).spec, { maxCols: 110, title: false }), 'exactly what the ASCII renderer makes of the stored spec');
			for (const label of ['Customer message', 'Jev', 'Route to billing', '0.90 or more']) { assert.ok(m.text.includes(label), label); }
			assert.ok(!m.text.includes('Jev classifies; your code decides the action'), 'without the title: the card shows it as its heading');
			assert.ok(/\+-+\+/.test(m.text) && m.text.includes('>'), 'boxes and arrows');
			assert.ok(!/pwned/.test(m.text));
			assert.ok(m.text.split('\n').every((l) => l.length <= 110), 'no line wider than the chat can show');
			assert.ok(/^[\x20-\x7e\n]*$/.test(m.text), 'plain ASCII: it must survive any font');
		});

		await test('FALLBACK: the page says how many characters fit, and the diagram turns downward to fit them — a number, bounded, and nothing more', async () => {
			const b = boot();
			const rec = drawn(b);
			const ask = async (cols) => { b.posted.length = 0; await b.host.handleDiagramAction({ action: 'ascii', id: rec.id, cols }); return b.posted[0].text; };
			const widest = (t) => Math.max.apply(null, t.split('\n').map((l) => l.length));
			const wide = await ask(160), narrow = await ask(48);
			assert.ok(widest(wide) > 48, 'given room, the flow runs left to right: ' + widest(wide));
			assert.ok(widest(narrow) <= 48, 'in a narrow panel it fits: ' + widest(narrow));
			assert.ok(narrow.split('\n').length > wide.split('\n').length, 'by growing downward, as the picture does');
			const at = (n) => ascii.render(repair.accept(rec.spec).spec, { maxCols: n, title: false });
			assert.strictEqual(await ask(3), at(40), 'never narrower than 40');
			assert.strictEqual(await ask(1e9), at(200), 'never wider than 200');
			for (const junk of [undefined, null, 'wide', NaN, {}, [], '120; rm -rf', -5]) { assert.strictEqual(await ask(junk), junk === -5 ? at(40) : at(110), 'cols = ' + JSON.stringify(junk)); }
			assert.strictEqual(await ask('72'), at(72), 'a numeric string is a number');
			assert.strictEqual(await ask(72.9), at(72));
			// what the renderer is actually handed: a whole number between 40 and 200, whatever the page sent
			const seen = [];
			const spy = boot({ ascii: { render: (spec, o) => { seen.push(o); return 'text'; } } });
			const one = drawn(spy);
			for (const cols of [3, -5, 0, 39.9, 40, 72.9, '96', 200, 201, 1e9, Infinity, NaN, 'wide', null, undefined, {}, [150], '120; rm -rf']) { await spy.host.handleDiagramAction({ action: 'ascii', id: one.id, cols }); }
			assert.deepStrictEqual(seen.map((o) => o.maxCols), [40, 40, 110, 40, 40, 72, 96, 200, 200, 200, 200, 110, 110, 110, 110, 110, 150, 110]);
			assert.ok(seen.every((o) => o.title === false && Object.keys(o).sort().join() === 'maxCols,title'), 'and nothing else from the page rides along');
		});

		await test('FALLBACK: an unknown id, or a diagram with nothing drawable, answers with no text — the chat keeps the source open', async () => {
			const b = boot();
			await b.host.handleDiagramAction({ action: 'ascii', id: 'd-99' });
			assert.deepStrictEqual(b.posted, [{ type: 'diagramAscii', id: 'd-99', text: '' }]);
			b.diagrams.beginRun();
			b.diagrams.render({ title: 'Nothing to draw' }, { key: 't1', model: 'm' });
			const failed = b.diagrams.render({ title: 'Nothing to draw' }, { key: 't2', model: 'm' }).post.find((x) => x.type === 'diagram').record;
			b.diagrams.endRun();
			assert.strictEqual(failed.spec, null);
			await b.host.handleDiagramAction({ action: 'ascii', id: failed.id });
			assert.strictEqual(b.posted[1].text, '');
		});

		await test('FALLBACK: a diagram too awkward for characters still says what connects to what', async () => {
			const b = boot({ ascii: { render: () => { throw new Error('too wide for a character grid'); } } });
			const rec = drawn(b);
			await b.host.handleDiagramAction({ action: 'ascii', id: rec.id });
			assert.strictEqual(b.posted[0].text, diagramText.outline(repair.accept(rec.spec).spec).text);
			assert.ok(/Customer message/.test(b.posted[0].text) && /Jev/.test(b.posted[0].text));
		});

		await test('A SESSION FILE IS INPUT TOO: a stored diagram that is not a valid spec is never acted on — no link, no export, no text, no throw', async () => {
			const b = boot();
			const good = drawn(b);
			const evil = (id, spec) => ({ id, key: 'k-' + id, v: 1, status: 'ok', spec, fixes: [], notes: [], errors: [] });
			b.diagrams.load([
				JSON.parse(JSON.stringify(good)),
				evil('d-2', { title: 'Nodes are not a list', nodes: 'oops', edges: [] }),
				evil('d-3', { title: 'T', nodes: [{ id: 'a', label: 'A', link: { path: '../outside/secret.env' } }, { id: 'a', label: 'again' }], edges: [{ from: 'a', to: 'ghost' }] }),
				evil('d-4', 'not even an object'),
				evil('d-5', { title: 'T', nodes: [{ id: 'x', label: 'X', link: { path: 'src/agent.js' }, onclick: 'alert(1)', shape: 'box' }], edges: [], script: 'alert(1)' })
			]);
			assert.strictEqual(b.diagrams.get('d-1').spec.title, good.spec.title, 'a valid record comes back as it was');
			assert.deepStrictEqual(b.diagrams.get('d-1').spec, good.spec);
			assert.deepStrictEqual(['d-2', 'd-4'].map((id) => [b.diagrams.get(id).spec, b.diagrams.get(id).status]), [[null, 'failed'], [null, 'failed']], 'nothing drawable: kept as a diagram that was never drawn');
			// d-3 is salvageable the way a model's would be: the duplicate renamed, the edge to nowhere dropped
			const d3 = b.diagrams.get('d-3').spec;
			assert.deepStrictEqual([d3.nodes.length, d3.edges.length, new Set(d3.nodes.map((n) => n.id)).size], [2, 0, 2]);
			// d-5: the fields the schema does not know are gone before anything can read them
			assert.deepStrictEqual(Object.keys(b.diagrams.get('d-5').spec).sort(), ['edges', 'nodes', 'title', 'v']);
			assert.deepStrictEqual(Object.keys(b.diagrams.get('d-5').spec.nodes[0]).sort(), ['id', 'label', 'link', 'shape']);
			for (const id of ['d-2', 'd-4']) {
				for (const action of [{ action: 'openLink', node: 'a' }, { action: 'export', format: 'source' }, { action: 'export', format: 'mermaid' }, { action: 'export', format: 'markdown' }, { action: 'ascii', cols: 80 }]) {
					await b.host.handleDiagramAction(Object.assign({ id }, action));
				}
			}
			assert.deepStrictEqual([b.ui.opened, b.ui.clipboard, b.ui.untitled, b.ui.edits, b.ui.errors], [[], [], [], [], []], 'nothing was opened, copied or written — and nothing threw');
			assert.deepStrictEqual(b.posted.map((m) => m.text), ['', ''], 'the text fallback has nothing to say about them');
			// a link in a stored record is resolved at the click like any other: out of the workspace is refused
			await b.host.handleDiagramAction({ action: 'openLink', id: 'd-3', node: 'a' });
			assert.deepStrictEqual(b.ui.opened, []);
			assert.strictEqual(b.ui.warnings.length, 1, 'and the user is told why nothing opened');
			await b.host.handleDiagramAction({ action: 'openLink', id: 'd-5', node: 'x' });
			assert.deepStrictEqual(b.ui.opened, [path.join(ws, 'src', 'agent.js')], 'while a real file in a stored record still opens');
			assert.match(b.diagrams.fetch('d-2'), /^ERROR: diagram d-2 was never drawn/);
			assert.deepStrictEqual(b.diagrams.stubsFor([{ role: 'assistant', content: [{ type: 'tool_use', id: 'k-d-2', name: 'render_diagram', input: {} }, { type: 'tool_use', id: 'k-d-5', name: 'render_diagram', input: {} }] }]), ['diagram: T, 1 node, id d-5']);
		});

		await test('OPEN LINK: the webview names a node; the FILE comes from the host\'s own record', async () => {
			const b = boot();
			const rec = drawn(b);
			// a path smuggled in the message is never read — there is no field for one
			await b.host.handleDiagramAction({ action: 'openLink', id: rec.id, node: 'jev', path: path.join(outside, 'secret.env'), link: { path: '/etc/passwd' } });
			assert.deepStrictEqual(b.ui.opened, [path.join(ws, 'src', 'agent.js')]);
			// a node with no link, and a node that does not exist, open nothing
			await b.host.openDiagramLink(rec.id, 'in'); await b.host.openDiagramLink(rec.id, 'ghost'); await b.host.openDiagramLink('d-99', 'jev');
			assert.strictEqual(b.ui.opened.length, 1);
			assert.deepStrictEqual(b.stats.filter((e) => e.type === 'link'), [{ type: 'link' }], 'one click, counted once');
		});

		await test('OPEN LINK: lands on the symbol — from the language\'s own symbols, else by text, else on the line', async () => {
			const b = boot();
			const rec = drawn(b);
			b.ui.symbols = [{ name: 'Outer', range: { start: { line: 0 } }, children: [{ name: 'runAgent', selectionRange: { start: { line: 2 } }, range: { start: { line: 2 } } }] }];
			await b.host.openDiagramLink(rec.id, 'jev');
			assert.strictEqual(b.ui.shown[0].opts.selection.start.line, 2, 'the symbol provider\'s answer (line 3, zero-based 2)');
			b.ui.symbols = 'throw';   // no provider for this language
			await b.host.openDiagramLink(rec.id, 'jev');
			assert.strictEqual(b.ui.shown[1].opts.selection.start.line, 2, 'found by text: `async function runAgent(` is on line 3');
			await b.host.openDiagramLink(rec.id, 'bill');
			assert.strictEqual(b.ui.shown[2].opts.selection.start.line, 5, 'a line number is used as given (6 → zero-based 5)');
			assert.strictEqual(b.ui.shown[2].opts.preview, false);
		});

		await test('OPEN LINK: checked AGAIN at the click — a file swapped for a link out of the workspace is refused', async () => {
			const b = boot();
			const target = path.join(ws, 'src', 'later.js');
			fs.writeFileSync(target, 'function ok() {}\n');
			const spec = jev(); spec.nodes[1].link = { path: 'src/later.js' };
			const rec = drawn(b, spec);
			assert.deepStrictEqual(rec.spec.nodes[1].link, { path: 'src/later.js' }, 'a real file when it was drawn');
			fs.rmSync(target);
			let linked = true;
			try { fs.symlinkSync(path.join(outside, 'secret.env'), target); } catch (e) { linked = false; }
			if (!linked) { console.log('    (symlinks unavailable — skipped)'); return; }
			await b.host.openDiagramLink(rec.id, 'jev');
			assert.deepStrictEqual(b.ui.opened, [], 'nothing outside the workspace is opened');
			assert.match(b.ui.warnings[0], /that link cannot be opened — it is a link to somewhere outside this workspace/);
			assert.deepStrictEqual(b.stats.filter((e) => e.type === 'link'), [], 'and a refused click is not a click');
			fs.rmSync(target);
		});

		await test('EXPORT source / Mermaid: made by the host from its own record — whatever data the webview sends is ignored', async () => {
			const b = boot();
			const rec = drawn(b);
			await b.host.handleDiagramAction({ action: 'export', id: rec.id, format: 'source', data: 'IGNORED' });
			assert.deepStrictEqual(b.ui.clipboard, [diagramText.toSource(rec.spec)]);
			assert.ok(!b.ui.clipboard[0].includes('IGNORED'));
			await b.host.handleDiagramAction({ action: 'export', id: rec.id, format: 'mermaid', data: 'IGNORED' });
			assert.deepStrictEqual(b.ui.untitled, [{ content: diagramText.toMermaid(rec.spec), language: 'plaintext' }]);
			b.ui.langs.push('mermaid');
			await b.host.exportDiagram(rec.id, 'mermaid');
			assert.strictEqual(b.ui.untitled[1].language, 'mermaid', 'as Mermaid when the editor knows the language');
			assert.deepStrictEqual(b.stats.filter((e) => e.type === 'export').map((e) => e.format), ['source', 'mermaid', 'mermaid']);
		});

		await test('EXPORT markdown: inserted at the cursor of an open Markdown file, as a fenced Mermaid block', async () => {
			const b = boot();
			const rec = drawn(b);
			const { vscode } = makeVscode();
			const inserted = [];
			b.ui.active = { document: { languageId: 'markdown', uri: { fsPath: path.join(ws, 'README.md'), scheme: 'file' } }, selection: { active: new vscode.Position(4, 2) }, edit: async (fn) => { fn({ insert: (pos, text) => inserted.push({ pos, text }) }); return true; } };
			await b.host.exportDiagram(rec.id, 'markdown');
			assert.strictEqual(inserted.length, 1);
			assert.deepStrictEqual([inserted[0].pos.line, inserted[0].pos.character], [4, 2]);
			assert.match(inserted[0].text, /^\n```mermaid\n---\ntitle: "Jev classifies; your code decides the action"\n---\nflowchart LR\n[\s\S]*\n```\n$/);
			// no Markdown file in front: pick one, and it goes at the end of that
			b.ui.active = null; b.ui.pick = 0;
			await b.host.exportDiagram(rec.id, 'markdown');
			assert.deepStrictEqual(b.ui.picks.map((p) => p.label), ['README.md']);
			assert.strictEqual(b.ui.edits.length, 1);
			assert.strictEqual(b.ui.edits[0].file, path.join(ws, 'README.md'));
			assert.strictEqual(b.ui.edits[0].pos.line, 1, 'the end of a two-line file');
			// dismissed picker: nothing is inserted anywhere
			b.ui.pick = undefined;
			await b.host.exportDiagram(rec.id, 'markdown');
			assert.strictEqual(b.ui.edits.length, 1);
		});

		await test('EXPORT svg / png: bytes from the webview are checked before one is written — and hostile ones are not', async () => {
			const b = boot();
			const rec = drawn(b);
			const geo = layout.layout(rec.spec);
			const good = scene.toSvg(scene.build(rec.spec, geo, { title: true, background: true, standalone: true, css: theme.css({ resolved: theme.PALETTES.dark }) }));
			b.ui.saveAs = path.join(tmp, 'out.svg');
			for (const evil of ['<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</' + 'script></svg>', good.replace('<g', '<g onload="x"'), good.replace('</svg>', '<a href="https://example.invalid"/></svg>'), good.replace('<![CDATA[', '<![CDATA[@import url(//example.invalid);'), '<html></html>', 42, null, { svg: good }]) {
				await b.host.exportDiagram(rec.id, 'svg', evil);
			}
			assert.deepStrictEqual(b.ui.written, [], 'not one byte of any of them was written');
			assert.strictEqual(b.ui.warnings.length, 8, 'and each refusal is said');
			assert.strictEqual(b.ui.saveDialog, undefined, 'the save dialog is not even opened for data that failed the check');
			await b.host.exportDiagram(rec.id, 'svg', good);
			assert.deepStrictEqual(b.ui.written.map((w) => [w.path, w.bytes.toString('utf8') === good]), [[path.join(tmp, 'out.svg'), true]]);
			// png
			b.ui.saveAs = path.join(tmp, 'out.png');
			for (const junk of ['not base64 !!', Buffer.from('<svg/>').toString('base64'), '', 7]) { await b.host.exportDiagram(rec.id, 'png', junk); }
			assert.strictEqual(b.ui.written.length, 1, 'something that is not a PNG is not written as one');
			const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(80, 1)]);
			await b.host.exportDiagram(rec.id, 'png', png.toString('base64'));
			assert.ok(b.ui.written[1].bytes.equals(png));
			// a cancelled dialog writes nothing
			b.ui.saveAs = undefined;
			await b.host.exportDiagram(rec.id, 'svg', good);
			assert.strictEqual(b.ui.written.length, 2);
			assert.deepStrictEqual(b.stats.filter((e) => e.type === 'export').map((e) => e.format), ['svg', 'png'], 'only what was actually saved is counted');
		});

		await test('EXPORT: the file name comes from the title — redacted first, like a session export', async () => {
			const b = boot();
			const pat = ['ghp', '_', 'abcdefghijklmnopqrstuvwxyz0123456789'].join('');   // split: push protection
			const spec = jev(); spec.title = 'Deploy with ' + pat + ' safely';
			const rec = drawn(b, spec);
			const good = scene.toSvg(scene.build(rec.spec, layout.layout(rec.spec), { standalone: true }));
			b.ui.saveAs = path.join(tmp, 'x.svg');
			await b.host.exportDiagram(rec.id, 'svg', good);
			const suggested = b.ui.saveDialog.defaultUri.fsPath;
			assert.ok(suggested.startsWith(ws + path.sep), 'offered in the workspace');
			assert.ok(!/ghp|abcdefghij/i.test(path.basename(suggested)), 'a token in a title cannot leak into the save path: ' + path.basename(suggested));
			assert.match(path.basename(suggested), /^deploy-with-.*\.svg$/);
		});

		await test('RETRY: the user asks for another go — never while a run is active, and it does not replace their own goal', async () => {
			const b = boot();
			b.diagrams.beginRun();
			const bad = jev(); bad.edges.push({ from: 'jev', to: 'ghost' });
			b.diagrams.render(bad, { key: 'k1' });
			const rec = b.diagrams.endRun()[0].record;
			assert.strictEqual(rec.status, 'degraded');
			b.host.setGoal('the user\'s real goal');
			b.host.setAbort({});   // a run is in flight
			await b.host.handleDiagramAction({ action: 'retry', id: rec.id });
			assert.deepStrictEqual(b.flows, [], 'Retry does nothing mid-run');
			b.host.setAbort(null);
			await b.host.handleDiagramAction({ action: 'retry', id: rec.id });
			assert.strictEqual(b.flows.length, 1);
			assert.match(b.flows[0], /^Redraw the diagram “Jev classifies; your code decides the action” \(id d-1\) with render_diagram\./);
			assert.ok(b.flows[0].includes('/edges/2/to: unknown node "ghost". Known ids: in, jev, bill.'), 'the model is told what was wrong');
			assert.ok(b.flows[0].includes('1 edge dropped: unknown nodes'));
			assert.strictEqual(b.host.goal(), 'the user\'s real goal', 'Retry/Continue on the response bar still mean what the user asked');
		});

		// ── context budget: stubbed at compaction, never turn by turn ───────────────────────────────

		const longChat = (b, withDiagram) => {
			const msgs = [];
			for (let t = 0; t < 8; t++) {
				msgs.push({ role: 'user', content: 'goal ' + t });
				if (withDiagram && t === 1) {
					b.diagrams.beginRun();
					const out = b.diagrams.render(jev(), { key: 'toolu_d' });
					b.diagrams.endRun();
					msgs.push({ role: 'assistant', content: [{ type: 'text', text: 'Here.' }, { type: 'tool_use', id: 'toolu_d', name: 'render_diagram', input: jev() }] });
					msgs.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_d', content: out.result }] });
				}
				msgs.push({ role: 'assistant', content: 'Done: step ' + t });
			}
			return msgs;
		};

		await test('COMPACTION: a diagram in the summarized stretch becomes one line, with its id — and get_diagram is switched on', async () => {
			const b = boot();
			const msgs = longChat(b, true);
			b.host.setMessages(msgs);
			assert.strictEqual(b.host.stubbed(), false);
			const r = await b.host.compactAgentMemory();
			assert.strictEqual(r.ok, true);
			const head = b.host.messages()[0].content;
			assert.match(head, /^\[Summary of the earlier conversation, compacted to save context\]\n\n- built the routing diagram\n\nDiagrams drawn earlier \(their specs are no longer in this conversation — call get_diagram with the id before editing one\):\n- diagram: Jev classifies; your code decides the action, 3 nodes, id d-1$/);
			assert.strictEqual(b.host.stubbed(), true, 'the next run is offered get_diagram');
			assert.ok(!JSON.stringify(b.host.messages()).includes('"nodes"'), 'the spec itself is gone from the conversation');
			assert.strictEqual(JSON.parse(b.diagrams.fetch('d-1')).nodes.length, 3, 'and still on file for get_diagram');
		});

		await test('COMPACTION: no diagram in the stretch — no note, and no extra tool', async () => {
			const b = boot();
			b.host.setMessages(longChat(b, false));
			const r = await b.host.compactAgentMemory();
			assert.strictEqual(r.ok, true);
			assert.strictEqual(b.host.messages()[0].content, '[Summary of the earlier conversation, compacted to save context]\n\n- built the routing diagram');
			assert.strictEqual(b.host.stubbed(), false);
		});

		await test('COMPACTION: the summarizer is shown a diagram as one short line, not as its spec', async () => {
			const b = boot();
			const line = b.host.serializeMsgForSummary({ role: 'assistant', content: [{ type: 'text', text: 'Here.' }, { type: 'tool_use', id: 't', name: 'render_diagram', input: jev() }] });
			assert.strictEqual(line, 'Assistant: Here.\n[draws a diagram: Jev classifies; your code decides the action]');
			const other = b.host.serializeMsgForSummary({ role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'read_file', input: { path: 'a.js' } }] });
			assert.strictEqual(other, 'Assistant: [calls read_file {"path":"a.js"}]', 'every other tool is serialized as before');
		});

		// ── reopening a session ─────────────────────────────────────────────────────────────────────

		const stored = (b) => {
			// what sessions.resume() hands back: the full conversation, the part that fits, and the stored records
			// (drawn in an earlier editor session, against the same workspace — so its links resolved)
			const first = createDiagrams({ resolveLink: (link) => diagramLinks.resolveLink(link, [{ name: 'app', root: ws }]) });
			first.beginRun(); const out = first.render(jev(), { key: 'toolu_d', model: 'm' }); first.endRun();
			const records = first.takeNew();
			const full = [
				{ role: 'user', content: 'how is it routed?' },
				{ role: 'assistant', content: [{ type: 'text', text: 'Here.' }, { type: 'tool_use', id: 'toolu_d', name: 'render_diagram', input: jev() }] },
				{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_d', content: out.result }] },
				{ role: 'assistant', content: 'Done: drawn.' },
				{ role: 'user', content: 'and then?' },
				{ role: 'assistant', content: 'Done: then it is billed.' }
			];
			return { records, full };
		};
		const resumeWith = async (tier) => {
			const data = stored();
			const r = { id: 's1', entry: { title: 'Routing' }, full: data.full, messages: tier === 1 ? data.full : data.full.slice(4), plan: { tier }, note: '', diagrams: data.records,
				turns: require('../sessionEvents').toDisplayTurns(data.full, data.records) };
			const b = boot({ sessions: { resume: () => r } });
			await b.host.resumeSession('s1');
			return { b, r };
		};

		await test('RESUME: the session\'s diagrams come back as stored — clickable, exportable, replayed in place', async () => {
			const { b, r } = await resumeWith(1);
			// Checked on the way in (a session file is input too) — and a valid record comes through that check
			// equal to what was stored: same spec, same status, same fixes. Nothing is repaired again.
			assert.deepStrictEqual(b.diagrams.get('d-1'), r.diagrams[0]);
			assert.strictEqual(JSON.stringify(b.diagrams.get('d-1').spec), JSON.stringify(r.diagrams[0].spec), 'field for field, in the stored order');
			const resumed = b.posted.find((m) => m.type === 'sessionResumed');
			assert.deepStrictEqual(resumed.turns.map((t) => t.role), ['user', 'assistant', 'diagram', 'assistant', 'user', 'assistant']);
			assert.strictEqual(resumed.turns[2].record.id, 'd-1');
			assert.strictEqual(b.host.stubbed(), false, 'the whole conversation fits: nothing was stubbed, so no get_diagram');
			assert.deepStrictEqual(b.host.messages(), r.full);
			await b.host.openDiagramLink('d-1', 'jev');
			assert.deepStrictEqual(b.ui.opened, [path.join(ws, 'src', 'agent.js')], 'a node clicked after reopening opens its file');
		});

		await test('RESUME: when the earlier part did not fit, the model is told which diagrams it can no longer see — and how to fetch one', async () => {
			const { b, r } = await resumeWith(2);
			const note = b.host.messages()[0];
			assert.strictEqual(note.role, 'user');
			assert.match(note.content, /^\[Resumed session — the earlier part of this conversation \(4 messages\) was omitted/);
			assert.ok(note.content.includes('Diagrams drawn in that part (call get_diagram with the id before editing one):\n- diagram: Jev classifies; your code decides the action, 3 nodes, id d-1]'), note.content);
			assert.strictEqual(b.host.stubbed(), true, 'so get_diagram is offered on the next run');
			assert.deepStrictEqual(b.host.messages().slice(1), r.full.slice(4));
			assert.strictEqual(JSON.parse(b.diagrams.fetch('d-1')).title, 'Jev classifies; your code decides the action');
			// the user still sees the whole transcript, picture included
			assert.ok(b.posted.find((m) => m.type === 'sessionResumed').turns.some((t) => t.role === 'diagram'));
		});

		// ── what may be written to disk ────────────────────────────────────────────────────────────

		await test('EXPORT CHECK: an SVG is accepted only if the painter could have produced it', async () => {
			const spec = repair.prepare(jev()).spec;
			const good = scene.toSvg(scene.build(spec, layout.layout(spec), { title: true, background: true, standalone: true, css: theme.css({ resolved: theme.PALETTES.light }) }));
			assert.deepStrictEqual(diagramExport.checkSvg(good), { ok: true });
			assert.deepStrictEqual(diagramExport.checkSvg('  ' + good + '\n'), { ok: true }, 'surrounding whitespace is not an attack');
			const reasons = {
				'<svg><script>1</script></svg>': 'element <script> is not allowed',
				'<svg><foreignObject></foreignObject></svg>': 'element <foreignObject> is not allowed',
				'<svg><image/></svg>': 'element <image> is not allowed',
				'<svg onload="x"></svg>': 'attribute "onload" is not allowed',
				'<svg><g style="x"></g></svg>': 'attribute "style" is not allowed',
				'<svg><g id="x"></g></svg>': 'attribute "id" is not allowed',
				'<svg><!-- x --></svg>': 'declarations and comments are not allowed',
				'<?xml version="1.0"?><svg></svg>': 'not an SVG document',
				'<svg><!DOCTYPE x [<!ENTITY a "b">]></svg>': 'declarations and comments are not allowed',
				'<svg><g></svg>': 'tags do not nest',
				'<svg><g>': 'not an SVG document',
				'<svg><style>a{}</style></svg>': 'stylesheet is not the painter\'s',
				'<svg><style><![CDATA[a{b:url(x)}]]></style></svg>': 'stylesheet is not the painter\'s',
				'<svg><style><![CDATA[@import "x";]]></style></svg>': 'stylesheet is not the painter\'s',
				'<svg><style><![CDATA[a{}]]></style><style><![CDATA[b{}]]></style></svg>': 'more than one stylesheet',
				'<svg><text a=b>x</text></svg>': 'malformed tag'
			};
			for (const [input, reason] of Object.entries(reasons)) { assert.deepStrictEqual(diagramExport.checkSvg(input), { ok: false, reason }, input); }
			assert.strictEqual(diagramExport.checkSvg('<svg>' + 'x'.repeat(diagramExport.MAX_SVG) + '</svg>').reason, 'too large');
			for (const junk of [null, undefined, 5, {}, [], Buffer.from(good)]) { assert.strictEqual(diagramExport.checkSvg(junk).reason, 'not text'); }
		});

		await test('EXPORT CHECK: a PNG is a PNG — by its bytes, not by its name', async () => {
			const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(100, 7)]);
			const ok = diagramExport.checkPng(png.toString('base64'));
			assert.ok(ok.ok && ok.bytes.equals(png));
			assert.ok(diagramExport.checkPng('data:image/png;base64,' + png.toString('base64')).ok, 'a data-URL prefix is tolerated');
			assert.strictEqual(diagramExport.checkPng(Buffer.from('GIF89a' + 'x'.repeat(100)).toString('base64')).reason, 'not a PNG image');
			assert.strictEqual(diagramExport.checkPng(Buffer.from('<svg onload=x>' + ' '.repeat(100)).toString('base64')).reason, 'not a PNG image');
			assert.strictEqual(diagramExport.checkPng('<svg/>').reason, 'not base64');
			assert.strictEqual(diagramExport.checkPng(png.slice(0, 20).toString('base64')).reason, 'not a PNG image', 'eight magic bytes and nothing else is not an image');
			for (const junk of ['', null, undefined, 4, {}]) { assert.strictEqual(diagramExport.checkPng(junk).reason, 'no image data'); }
		});

		await test('EXPORT CHECK: a file name is plain words — never a path, never empty', async () => {
			assert.strictEqual(diagramExport.fileStem('Jev classifies; your code decides the action'), 'jev-classifies-your-code-decides-the-action');
			assert.strictEqual(diagramExport.fileStem('../../etc/passwd'), 'etc-passwd');
			assert.strictEqual(diagramExport.fileStem('C:\\Windows\\system32'), 'c-windows-system32');
			assert.strictEqual(diagramExport.fileStem('   '), 'diagram');
			assert.strictEqual(diagramExport.fileStem(null), 'diagram');
			assert.ok(diagramExport.fileStem('x'.repeat(300)).length <= 60);
			assert.ok(!/[\/\\.]/.test(diagramExport.fileStem('a/b\\c.d')));
		});

		console.log('diagramHost: ' + n + ' tests passed');
	} catch (e) {
		console.error(e);
		process.exitCode = 1;
	}
})();
