/*---------------------------------------------------------------------------------------------
 *  Keep/Undo after a reload, in a browser (extensions/levelcode-ai/reviewSession.js) — run:
 *  node web/test/unit/review-rehydrate.test.js
 *
 *  Edits the agent made and the user has not yet kept or undone are saved with the workspace, and a reload brings
 *  them back. On the desktop the files are read synchronously as the extension starts. In a browser they can only
 *  be read asynchronously — and the chat may ask for its cards (`resync`, when it is ready) before those reads are
 *  back. It was then sent an empty review, and nothing more: the pending edits were gone from the chat until
 *  something else made it ask again. The real module runs here against a stand-in for the editor.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

const assert = require('assert');
const Module = require('module');

let n = 0;
async function test(name, fn) { await fn(); n++; console.log('  ok - ' + name); }

/** Anything the module touches and this test does not care about: callable, constructible, every property another one. */
const anything = () => new Proxy(function () {}, {
	get: (_t, p) => (p === 'then' ? undefined : p === Symbol.iterator ? undefined : anything()),
	apply: () => anything(),
	construct: () => anything(),
});
const files = new Map([['/scratch/app.js', 'const a = 2;\n']]);
let release = () => {};
let readsHeld = false;
const vscode = new Proxy({
	Uri: {
		parse: (s) => { const u = new URL(s); return { scheme: u.protocol.slice(0, -1), path: u.pathname, fsPath: u.pathname, toString: () => s }; },
		file: (p) => ({ scheme: 'file', path: p, fsPath: p, toString: () => 'file://' + p }),
	},
	Range: class { constructor(...a) { this.a = a; } },
	EventEmitter: class { constructor() { this.event = () => ({ dispose() {} }); } fire() {} },
	window: new Proxy({ visibleTextEditors: [], activeTextEditor: undefined }, { get: (t, p) => (p in t ? t[p] : anything()) }),
	workspace: new Proxy({
		workspaceFolders: [{ uri: { scheme: 'levelcode-scratch', path: '/scratch', fsPath: '/scratch', toString: () => 'levelcode-scratch:/scratch',
			with: (o) => ({ scheme: 'levelcode-scratch', path: o.path, fsPath: o.path, toString: () => 'levelcode-scratch:' + o.path }) }, name: 'scratch' }],
		fs: {
			async readFile(uri) {
				if (readsHeld) { await new Promise((r) => { release = r; }); }
				if (!files.has(uri.path)) { throw new Error('FileNotFound'); }
				return new TextEncoder().encode(files.get(uri.path));
			},
		},
	}, { get: (t, p) => (p in t ? t[p] : anything()) }),
}, { get: (t, p) => (p in t ? t[p] : anything()) });

const origLoad = Module._load;
// @ts-ignore
Module._load = function (request, parent, isMain) { return request === 'vscode' ? vscode : origLoad.call(this, request, parent, isMain); };
globalThis.__LEVELCODE_BROWSER_HOST__ = true;
const { registerReview } = require('../../../extensions/levelcode-ai/reviewSession.js');

const saved = [{ uri: 'levelcode-scratch:/scratch/app.js', rel: 'app.js', exists: true, snapshot: 'const a = 1;\n' }];
const context = () => ({ subscriptions: [], workspaceState: { get: (k) => (k === 'levelcode.ai.pendingReviews' ? saved : undefined), update: async () => {} } });
const tick = () => new Promise((r) => setTimeout(r, 5));

(async () => {
	await test('the chat asks for its cards before the files are read back: it gets them once they are', async () => {
		readsHeld = true;
		const posted = [];
		const review = registerReview(context(), (m) => posted.push(m), () => {});
		await tick();
		review.resync();                                                   // the chat is ready first
		assert.deepStrictEqual(posted.map((m) => m.type), ['reviewState']);
		assert.strictEqual(posted[0].count, 0, 'nothing is back yet');
		posted.length = 0;
		readsHeld = false; release();                                      // the read comes back
		await tick(); await tick();
		const card = posted.find((m) => m.type === 'editApplied');
		assert.ok(card, 'the pending edit was never sent to the chat: ' + JSON.stringify(posted.map((m) => m.type)));
		assert.strictEqual(card.id, 'levelcode-scratch:/scratch/app.js');
		assert.strictEqual(card.path, 'app.js');
		const state = posted.filter((m) => m.type === 'reviewState').pop();
		assert.strictEqual(state.count, 1);
		assert.strictEqual(review.pendingCount(), 1);
	});
	await test('the chat asks after they are back: one set of cards, as before', async () => {
		readsHeld = false;
		const posted = [];
		const review = registerReview(context(), (m) => posted.push(m), () => {});
		await tick(); await tick();
		posted.length = 0;                                                 // what the read itself sent, if anything, is not the question here
		review.resync();
		assert.deepStrictEqual(posted.map((m) => m.type), ['editApplied', 'reviewState']);
	});

	console.log(`\n${n} tests passed`);
})().catch((e) => { console.error(e); process.exit(1); });
