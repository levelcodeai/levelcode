/*---------------------------------------------------------------------------------------------
 *  sessionStore — persistence spine + FAST-RETRIEVAL guarantees — run: node test/sessionStore.test.js
 *
 *  The load-bearing claim this file pins: retrieval does not degrade with a session's AGE or with the
 *  size of the corpus. Two invariants, proven by counting real fs reads (§"fast retrieval" below):
 *    • listing / getting a session (even one created 25 days ago) reads the in-memory INDEX — zero
 *      session-file reads, zero directory scans;
 *    • switching (resume) reads EXACTLY ONE session file, whether there are 3 sessions or 50.
 *  Plus the spine's own safety net: the index is a rebuildable cache, never load-bearing.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const S = require('../sessionStore');

let n = 0;
function test(name, fn) { fn(); n++; console.log('  ok - ' + name); }

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-sessions-'));
process.on('exit', () => { try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best effort */ } });
let seq = 0;
function freshRoot() { return path.join(tmpRoot, 'r' + (seq++)); }

/** Count the fs reads a thunk performs, distinguishing session (.jsonl) reads from index/dir reads. */
function withReadCounter(fn) {
	const of = fs.readFileSync, od = fs.readdirSync;
	let jsonlReads = 0, otherFileReads = 0, dirReads = 0;
	fs.readFileSync = function (p, ...a) { if (String(p).endsWith('.jsonl')) { jsonlReads++; } else { otherFileReads++; } return of.call(fs, p, ...a); };
	fs.readdirSync = function (p, ...a) { dirReads++; return od.call(fs, p, ...a); };
	try { const result = fn(); return { result, jsonlReads, otherFileReads, dirReads }; }
	finally { fs.readFileSync = of; fs.readdirSync = od; }
}

// ── slug (pure) ─────────────────────────────────────────────────────────────────────────────────

test('SLUG: a project path becomes a human-readable, filesystem-safe, time-independent key', () => {
	assert.strictEqual(S.projectSlug('/Users/ada/code/thin.ly'), '-Users-ada-code-thin-ly');
	assert.strictEqual(S.projectSlug('/'), '-', 'the root still needs a directory name');
	assert.strictEqual(S.projectSlug('/a/b/'), '-a-b', 'a trailing separator is trimmed, the leading root kept');
	assert.strictEqual(S.projectSlug('C:\\Users\\ada\\app'), 'C-Users-ada-app', 'windows paths are legal filenames');
	assert.strictEqual(S.projectSlug(''), '-', 'an empty path is tolerated, never throws');
	// intentionally lossy (unicode collapses) — safe because meta.project carries the real path
	assert.strictEqual(S.projectSlug('/w/日本語'), '-w', 'unicode-only segments collapse; disambiguation is meta.project');
});

// ── ids (pure) ──────────────────────────────────────────────────────────────────────────────────

test('ID: sortable, filesystem-safe, deterministic under injected clock+rand', () => {
	const id = S.newSessionId(new Date('2026-07-28T09:12:33.456Z'), '8f3k');
	assert.strictEqual(id, '2026-07-28T09-12-33-8f3k');
	assert.ok(!id.includes(':') && !id.includes('.'), 'no filesystem-hostile chars');
	const a = S.newSessionId(new Date('2026-01-01T00:00:00Z'), 'aaaa');
	const b = S.newSessionId(new Date('2026-12-31T23:59:59Z'), 'bbbb');
	assert.ok(a < b, 'ids sort chronologically as plain strings');
});

// ── parse (pure) ────────────────────────────────────────────────────────────────────────────────

test('PARSE: meta is separated from events, and a torn final line is dropped (crash-safety)', () => {
	const text = [
		JSON.stringify({ kind: 'meta', v: 1, id: 'x', project: '/p', createdAt: 't0' }),
		JSON.stringify({ kind: 'user', t: 't1', content: 'hi' }),
		'{"kind":"agent","t":"t2",'   // torn — a crash mid-append
	].join('\n');
	const { meta, events } = S.parseSession(text);
	assert.strictEqual(meta.id, 'x');
	assert.strictEqual(events.length, 1, 'the torn last line is dropped, not thrown on');
	assert.strictEqual(events[0].content, 'hi');
});

// ── deriveEntry (pure — the heart of the cache) ──────────────────────────────────────────────────

test('DERIVE: entry fields fold from events, and every field degrades gracefully', () => {
	const meta = { kind: 'meta', v: 1, id: 's1', project: '/p', createdAt: 'c0', title: null };
	const events = [
		{ kind: 'user', t: 't1', content: 'Add idempotency to refunds' },
		{ kind: 'agent', t: 't2', model: 'anthropic/claude-opus-5', tools: 3, edits: [{ path: 'refund.rb' }] },
		{ kind: 'agent', t: 't3', model: 'anthropic/claude-opus-5', tools: 5, edits: [{ path: 'refund.rb' }, { path: 'redis_lock.rb' }] },
		{ kind: 'title', t: 't4', title: 'Idempotent refunds via Redis keys' },
		{ kind: 'label', t: 't5', pinned: true },
		{ kind: 'end', t: 't6', state: 'done' }
	];
	const e = S.deriveEntry(meta, events);
	assert.strictEqual(e.title, 'Idempotent refunds via Redis keys', 'a title event beats the first-message fallback');
	assert.strictEqual(e.turns, 1);
	assert.strictEqual(e.model, 'anthropic/claude-opus-5');
	assert.strictEqual(e.state, 'done');
	assert.strictEqual(e.pinned, true);
	assert.deepStrictEqual(e.spark, [3, 5], 'sparkline = tool-calls per agent turn');
	assert.deepStrictEqual(e.filesEdited, ['refund.rb', 'redis_lock.rb'], 'edited files, de-duped, most-edited first');
	assert.strictEqual(e.updatedAt, 't6');

	// graceful floor: a one-line session still lists
	const bare = S.deriveEntry({ kind: 'meta', id: 's2', createdAt: 'c', project: '/p' }, []);
	assert.strictEqual(bare.id, 's2'); assert.strictEqual(bare.state, 'active'); assert.deepStrictEqual(bare.filesEdited, []);
});

// ── write / read roundtrip ───────────────────────────────────────────────────────────────────────

test('ROUNDTRIP: create + append + read reconstructs meta and events in order', () => {
	const root = freshRoot(), slug = S.projectSlug('/p/one');
	const id = S.newSessionId(new Date('2026-07-01T00:00:00Z'), 'aa01');
	const file = S.createSession(root, slug, id, '/p/one', '2026-07-01T00:00:00.000Z');
	S.appendEvent(file, { kind: 'user', t: 't1', content: 'hello' });
	S.appendEvent(file, { kind: 'end', t: 't2', state: 'done' });
	const { meta, events } = S.readSession(file);
	assert.strictEqual(meta.project, '/p/one');
	assert.deepStrictEqual(events.map((e) => e.kind), ['user', 'end']);
});

// ── index: cache + self-heal ─────────────────────────────────────────────────────────────────────

function seed(root, slug, id, createdIso, title) {
	const file = S.createSession(root, slug, id, '/proj', createdIso, null);
	S.appendEvent(file, { kind: 'user', t: createdIso, content: title });
	S.appendEvent(file, { kind: 'title', t: createdIso, title });
	S.appendEvent(file, { kind: 'end', t: createdIso, state: 'done' });
	return file;
}

test('INDEX: a valid cache is trusted; a corrupt one silently rebuilds by scanning (never load-bearing)', () => {
	const root = freshRoot(), slug = S.projectSlug('/proj');
	seed(root, slug, S.newSessionId(new Date('2026-07-01T00:00:00Z'), 'a'), '2026-07-01T00:00:00Z', 'one');
	seed(root, slug, S.newSessionId(new Date('2026-07-02T00:00:00Z'), 'b'), '2026-07-02T00:00:00Z', 'two');

	// build + persist the cache from the source of truth
	S.writeIndex(root, slug, S.scanProject(root, slug));
	assert.ok(!fs.existsSync(S.indexFile(root, slug) + '.' + process.pid + '.tmp'), 'atomic write leaves no tmp');

	const good = S.loadIndex(root, slug);
	assert.strictEqual(good.rebuilt, false, 'a valid cache is used as-is');
	assert.strictEqual(good.entries.length, 2);
	assert.strictEqual(good.entries[0].title, 'two', 'newest first');

	// corrupt the cache — sessions must still list
	fs.writeFileSync(S.indexFile(root, slug), '{ this is not json');
	const healed = S.loadIndex(root, slug);
	assert.strictEqual(healed.rebuilt, true, 'a corrupt cache is rebuilt, not fatal');
	assert.deepStrictEqual(healed.entries.map((e) => e.title), good.entries.map((e) => e.title), 'rebuild == the real content');
});

test('INDEX: upsert replaces by id and keeps newest-first, no rescan', () => {
	let entries = [];
	entries = S.upsertEntry(entries, { id: 'a', title: 'A', updatedAt: '2026-07-01' });
	entries = S.upsertEntry(entries, { id: 'b', title: 'B', updatedAt: '2026-07-03' });
	entries = S.upsertEntry(entries, { id: 'a', title: 'A2', updatedAt: '2026-07-02' }); // replace a
	assert.strictEqual(entries.length, 2);
	assert.strictEqual(S.getEntry({ entries }, 'a').title, 'A2');
	assert.strictEqual(entries[0].id, 'b', 'newest-first preserved');
});

// ── FAST RETRIEVAL — the guarantees the user asked to verify ─────────────────────────────────────

test('FAST: listing + getting a 25-day-old session reads the INDEX only — zero session-file reads', () => {
	const root = freshRoot(), slug = S.projectSlug('/proj/big');
	// a realistic corpus with one session created 25 days ago
	const now = new Date('2026-07-28T12:00:00Z');
	const oldDate = new Date(now.getTime() - 25 * 24 * 3600 * 1000);
	const oldId = S.newSessionId(oldDate, 'old0');
	seed(root, slug, oldId, oldDate.toISOString(), 'Tidy the CHANGELOG for v1.0.4');
	for (let i = 0; i < 40; i++) {
		const d = new Date(now.getTime() - i * 3600 * 1000);
		seed(root, slug, S.newSessionId(d, 'n' + i), d.toISOString(), 'session ' + i);
	}
	S.writeIndex(root, slug, S.scanProject(root, slug));

	// loading the cache touches index.json only — NOT the 41 session files
	const load = withReadCounter(() => S.loadIndex(root, slug));
	assert.strictEqual(load.result.rebuilt, false);
	assert.strictEqual(load.jsonlReads, 0, 'a valid cache means listing never scans the corpus');
	assert.strictEqual(load.dirReads, 0, 'and never even reads the directory');

	// getting the 25-day-old entry + listing is pure in-memory — zero disk of any kind, age-irrelevant
	const idx = load.result;
	const q = withReadCounter(() => ({ entry: S.getEntry(idx, oldId), list: S.listEntries(idx, { lifecycle: 'active' }) }));
	assert.strictEqual(q.jsonlReads, 0);
	assert.strictEqual(q.otherFileReads, 0);
	assert.strictEqual(q.dirReads, 0, 'getEntry/listEntries are pure — they cannot touch disk');
	assert.strictEqual(q.result.entry.title, 'Tidy the CHANGELOG for v1.0.4', 'the 25-day-old session is retrieved, intact');
	assert.strictEqual(q.result.entry.createdAt, oldDate.toISOString());
});

test('FAST: switching (resume) reads EXACTLY ONE session file, independent of corpus size', () => {
	function build(count) {
		const root = freshRoot(), slug = S.projectSlug('/proj/switch');
		const now = new Date('2026-07-28T12:00:00Z');
		const targetDate = new Date(now.getTime() - 25 * 24 * 3600 * 1000);
		const targetId = S.newSessionId(targetDate, 'tgt0');
		seed(root, slug, targetId, targetDate.toISOString(), 'the 25-day-old target');
		for (let i = 0; i < count; i++) {
			const d = new Date(now.getTime() - i * 3600 * 1000);
			seed(root, slug, S.newSessionId(d, 'x' + i), d.toISOString(), 's' + i);
		}
		S.writeIndex(root, slug, S.scanProject(root, slug));
		const idx = S.loadIndex(root, slug);
		// the switch: resolve the id in-memory (no read), then read that one file
		const counted = withReadCounter(() => { const e = S.getEntry(idx, targetId); return S.readSession(S.sessionFile(root, slug, e.id)); });
		return Object.assign(counted, { targetId });
	}
	const small = build(3), large = build(50);
	assert.strictEqual(small.jsonlReads, 1, 'a 4-session corpus: one file read to switch');
	assert.strictEqual(large.jsonlReads, 1, 'a 51-session corpus: STILL one file read — corpus size is irrelevant');
	assert.strictEqual(large.dirReads, 0, 'and the switch never scans the directory');
	assert.strictEqual(large.result.meta.id, large.targetId, 'the one file read is the right session');
});

console.log('sessionStore: ' + n + ' tests passed');
