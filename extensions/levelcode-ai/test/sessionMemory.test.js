/*---------------------------------------------------------------------------------------------
 *  sessionMemory — the cross-session memory store — run: node test/sessionMemory.test.js
 *
 *  The plain-JSONL substrate for project memory (docs/levelcode-sessions-memory.md). Pure fs/path, so it
 *  unit-tests against a temp dir: a journal entry derives deterministically from a session's index row
 *  (sourced + dated), append/read roundtrips and tolerates corruption, and latestBySession collapses the
 *  append-only log to one current outcome per session, newest-first.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const M = require('../sessionMemory');

let n = 0;
function test(name, fn) { fn(); n++; console.log('  ok - ' + name); }

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-mem-'));
process.on('exit', () => { try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best effort */ } });
let seq = 0;
const freshRoot = () => path.join(tmpRoot, 'r' + (seq++));
const slug = 'proj';

test('OUTCOME: a journal entry derives from a session index row — deterministic, sourced + dated', () => {
	const derived = { id: 's1', title: 'Tidy the CHANGELOG for v1.0.4', updatedAt: 't-up', createdAt: 't-cr',
		turns: 6, state: 'done', pinned: true, filesEdited: ['RELEASE-NOTES.md', 'a', 'b', 'c', 'd', 'e', 'f', 'g'] };
	const e = M.outcomeEntry(derived, 't-seal');
	assert.strictEqual(e.id, 's1', 'source_session (provenance link back to the full JSONL)');
	assert.strictEqual(e.at, 't-seal', 'learned_at = the seal time when given');
	assert.strictEqual(e.title, 'Tidy the CHANGELOG for v1.0.4');
	assert.strictEqual(e.summary, e.title, 'v1 outcome summary = the goal headline (model refines later)');
	assert.strictEqual(e.turns, 6);
	assert.strictEqual(e.state, 'done');
	assert.strictEqual(e.pinned, true);
	assert.strictEqual(e.files.length, 6, 'files capped at 6');
	assert.strictEqual(e.files[0], 'RELEASE-NOTES.md');
	assert.strictEqual(M.outcomeEntry(derived).at, 't-up', 'falls back to updatedAt with no seal time');
});

test('JOURNAL: append then read roundtrips oldest-first, creating memory/ on first write', () => {
	const root = freshRoot();
	assert.deepStrictEqual(M.readJournal(root, slug), [], 'empty before any write');
	M.appendJournal(root, slug, M.outcomeEntry({ id: 'a', title: 'one', updatedAt: 't1', turns: 1, state: 'done', filesEdited: [] }));
	M.appendJournal(root, slug, M.outcomeEntry({ id: 'b', title: 'two', updatedAt: 't2', turns: 2, state: 'done', filesEdited: ['x'] }));
	const j = M.readJournal(root, slug);
	assert.strictEqual(j.length, 2);
	assert.deepStrictEqual(j.map((e) => e.id), ['a', 'b'], 'append order (oldest-first)');
	assert.ok(fs.existsSync(M.journalFile(root, slug)), 'journal.jsonl exists under memory/');
});

test('JOURNAL: read tolerates blank + corrupt lines (keeps the good ones)', () => {
	const root = freshRoot();
	fs.mkdirSync(M.memoryDir(root, slug), { recursive: true });
	fs.writeFileSync(M.journalFile(root, slug),
		JSON.stringify({ v: 1, id: 'a', at: 't1' }) + '\n\n{ not json\n' + JSON.stringify({ v: 1, id: 'b', at: 't2' }) + '\n');
	assert.deepStrictEqual(M.readJournal(root, slug).map((e) => e.id), ['a', 'b'], 'blank + garbage skipped');
});

test('LATEST: one outcome per session — the latest supersedes, newest-first', () => {
	const entries = [
		{ id: 'a', at: '2026-01-01', title: 'a-old' },
		{ id: 'b', at: '2026-03-01', title: 'b' },
		{ id: 'a', at: '2026-02-01', title: 'a-new' }   // 'a' resumed + re-sealed → later line wins
	];
	const latest = M.latestBySession(entries);
	assert.deepStrictEqual(latest.map((e) => e.id), ['b', 'a'], 'collapsed to one per id, newest-first by date');
	assert.strictEqual(latest.find((e) => e.id === 'a').title, 'a-new', 'the later line supersedes the earlier');
});

console.log('sessionMemory: ' + n + ' tests passed');
