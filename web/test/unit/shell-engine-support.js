// Shared by web/test/unit/shell-engine-*.test.js (it is not a suite: it does not match *.test.js).
// A host for the engine core in a plain node process: the fs RPC answered from an in-memory tree, the messages recorded
// in order, the change set applied back onto the tree.
'use strict';
// @ts-check

const path = require('path');
const { pathToFileURL } = require('url');

const ENGINE_DIR = path.join(__dirname, '..', '..', 'shell', 'engine');

/** The patched just-bash (ESM), loaded once per process. */
async function loadEngine() {
	const mod = await import(pathToFileURL(path.join(ENGINE_DIR, 'load.mjs')).href);
	return mod.loadEngine();
}

const enc = new TextEncoder();
const dec = new TextDecoder();

function posixError(code, message) {
	return Object.assign(new Error(message || code), { code });
}

/**
 * An in-memory workspace: path -> Uint8Array (file) or null (directory). Paths are absolute, the way the engine asks.
 * @param {Record<string, string | Uint8Array | null>} files
 */
function makeTree(files) {
	/** @type {Map<string, Uint8Array | null>} */
	const nodes = new Map();
	const parentOf = (p) => (p.slice(0, p.lastIndexOf('/')) || '/');
	const mkdirp = (p) => {
		if (p === '/' || nodes.has(p)) { return; }
		mkdirp(parentOf(p));
		nodes.set(p, null);
	};
	const tree = {
		nodes,
		put(p, content) {
			mkdirp(parentOf(p));
			nodes.set(p, typeof content === 'string' ? enc.encode(content) : content);
		},
		mkdir(p) { mkdirp(p); },
		/** @returns {Array<[string, 'file'|'dir']>} */
		list(p) {
			const pre = p === '/' ? '/' : p + '/';
			/** @type {Array<[string, 'file'|'dir']>} */
			const out = [];
			for (const [k, v] of nodes) {
				if (k !== p && k.startsWith(pre) && !k.slice(pre.length).includes('/')) { out.push([k.slice(pre.length), v === null ? 'dir' : 'file']); }
			}
			return out;
		},
		text(p) { const v = nodes.get(p); return v ? dec.decode(v) : undefined; },
		/** a stable text dump: one line per path, file contents inline */
		dump() {
			return [...nodes.keys()].sort().map((k) => { const v = nodes.get(k); return v === null ? k + '/' : k + ' = ' + JSON.stringify(dec.decode(/** @type {Uint8Array} */ (v))); });
		},
		remove(p) { for (const k of [...nodes.keys()]) { if (k === p || k.startsWith(p + '/')) { nodes.delete(k); } } },
		/** applies a change set the way the host would */
		apply(changes) {
			for (const c of changes) { if (c.kind === 'mkdir') { mkdirp(c.path); } }
			for (const c of changes) { if (c.kind === 'write') { tree.put(c.path, c.after); } }
			for (const c of changes) { if (c.kind === 'delete') { nodes.delete(c.path); } }
			for (const c of changes) { if (c.kind === 'rmdir') { tree.remove(c.path); } }
		},
	};
	for (const [p, v] of Object.entries(files || {})) {
		if (v === null) { mkdirp(p); } else { tree.put(p, v); }
	}
	return tree;
}

/**
 * @param {object} o
 * @param {any} o.Engine
 * @param {ReturnType<typeof makeTree>} [o.tree]
 * @param {Array<{ id: string, path: string, name?: string }>} [o.folders]
 * @param {boolean} [o.start=true]
 * @param {(op: string, p: string) => void} [o.onRead]
 */
async function makeHost(o) {
	const { createCore } = require(path.join(ENGINE_DIR, 'core.js'));
	const tree = o.tree || makeTree({});
	const folders = o.folders || [{ id: 'f0', path: '/w', name: 'w' }];
	/** @type {any[]} */
	const messages = [];
	/** @type {Array<{ op: string, path: string }>} */
	const reads = [];
	let core;
	const answer = (m) => {
		reads.push({ op: m.op, path: m.path });
		if (o.onRead) { o.onRead(m.op, m.path); }
		setImmediate(() => {
			const n = tree.nodes.get(m.path);
			const isRoot = folders.some((f) => f.path === m.path);
			if (m.op === 'stat') {
				if (n === undefined && !isRoot) { core.handle({ t: 'fsr', rid: m.rid, ok: false, error: { code: 'ENOENT', message: 'no such file' } }); return; }
				core.handle({ t: 'fsr', rid: m.rid, ok: true, value: { type: n === undefined || n === null ? 'dir' : 'file', size: n ? n.length : 0, mtime: 1700000000000 } });
			} else if (m.op === 'readFile') {
				if (n === undefined) { core.handle({ t: 'fsr', rid: m.rid, ok: false, error: { code: 'ENOENT', message: 'no such file' } }); return; }
				if (n === null) { core.handle({ t: 'fsr', rid: m.rid, ok: false, error: { code: 'EISDIR', message: 'is a directory' } }); return; }
				core.handle({ t: 'fsr', rid: m.rid, ok: true, value: n.slice() });
			} else if (m.op === 'readDir') {
				if (n === undefined && !isRoot) { core.handle({ t: 'fsr', rid: m.rid, ok: false, error: { code: 'ENOENT', message: 'no such dir' } }); return; }
				core.handle({ t: 'fsr', rid: m.rid, ok: true, value: tree.list(m.path) });
			}
		});
	};
	core = createCore({
		Engine: o.Engine,
		post: (m) => {
			messages.push(m);
			if (m.t === 'fs') { answer(m); }
		},
	});
	if (o.start !== false) {
		await core.handle({ t: 'init', gen: 1, folders, limits: {}, commands: undefined });
	}
	let nextId = 1;
	const host = {
		core,
		tree,
		messages,
		reads,
		folders,
		/**
		 * @param {string} script
		 * @param {{ cwd?: string, env?: Record<string, string>, stdin?: string, caps?: any, expandAliases?: boolean, keepTmp?: boolean, apply?: boolean }} [r]
		 */
		async run(script, r = {}) {
			const id = nextId++;
			const from = messages.length;
			await core.handle({ t: 'run', id, script, cwd: r.cwd || folders[0].path, env: r.env || {}, stdin: r.stdin || '', caps: r.caps, expandAliases: r.expandAliases, keepTmp: r.keepTmp });
			const mine = messages.slice(from).filter((m) => m.t !== 'fs');
			const done = mine.filter((m) => m.t === 'done');
			if (done.length !== 1) { throw new Error('expected exactly one done, got ' + done.length); }
			let stdout = '';
			let stderr = '';
			for (const m of mine) { if (m.t === 'out') { if (m.stream === 'stdout') { stdout += m.text; } else { stderr += m.text; } } }
			const d = done[0];
			if (r.apply !== false && d.how === 'exit') { tree.apply(d.changes); }
			return { stdout, stderr, exitCode: d.exitCode, how: d.how, done: d, outs: mine.filter((m) => m.t === 'out'), id };
		},
	};
	return host;
}

module.exports = { loadEngine, makeTree, makeHost, ENGINE_DIR, posixError };
