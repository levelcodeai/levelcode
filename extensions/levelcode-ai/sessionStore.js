// @ts-check
'use strict';

/*
 * sessionStore.js — the persistence spine for LevelCode chat sessions.
 *
 * Pure Node (fs / path / crypto), no `vscode` — so it unit-tests like update.js and mcpConfig.js.
 * The design lives in docs/levelcode-chat-sessions-design.md (storage) and
 * docs/levelcode-sessions-experience.md (why the shapes are what they are).
 *
 * The one property this module exists to guarantee is FAST RETRIEVAL that does not degrade with a
 * session's age or with the size of the corpus:
 *
 *   • LISTING / SEARCHING reads the in-memory INDEX, never the session files. `loadIndex` is paid once;
 *     `getEntry` / `listEntries` are pure lookups over that array. A chat created 25 days ago (or a
 *     year ago) costs exactly the same as one created a minute ago — the index carries its metadata.
 *   • SWITCHING (resume) reads exactly ONE file — that session's `.jsonl` — via `readSession`. It never
 *     scans the directory or touches its neighbours, so wall-clock is bounded by that one session's
 *     size, not by how many sessions exist or how old this one is.
 *   • The index is a CACHE, never load-bearing: `loadIndex` rebuilds it by scanning on any corruption,
 *     and `scanProject` (reading the files) is always the source of truth (anti-Copilot #vscdb).
 *
 * Storage layout (per project):
 *   <root>/<project-slug>/
 *     index.json                     cache of derived entries — rebuildable by scanning
 *     <session-id>.jsonl             one meta line + append-only events
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/** Bump only on an incompatible on-disk change; `loadIndex` refuses a newer index and rebuilds. */
const SCHEMA_V = 1;

const INDEX_NAME = 'index.json';
const PREVIEW_MAX = 96;

// ── slug & ids (pure) ──────────────────────────────────────────────────────────────────────────

/**
 * A project path → a human-readable, filesystem-safe directory slug.
 *   "/Users/ada/code/thin.ly"  →  "-Users-ada-code-thin-ly"
 *
 * Every run of non-`[A-Za-z0-9_]` collapses to a single "-"; the LEADING dash is kept (it encodes the
 * absolute-path root and matches the convention Claude Code and this repo's own memory dir already use),
 * a trailing dash is trimmed. The slug is intentionally lossy (two unicode-only paths can collide); that
 * is safe because the REAL path is stored in each file's meta line — a collision degrades to "listed
 * under a shared name", never to "lost" (design §3 keying). Callers disambiguate on `meta.project`.
 */
function projectSlug(projectPath) {
	const s = String(projectPath == null ? '' : projectPath).replace(/[^A-Za-z0-9_]+/g, '-').replace(/-+$/, '');
	return s || '-'; // the filesystem root (or an empty path) still needs a directory name
}

/**
 * A sortable, filesystem-safe session id: `YYYY-MM-DDTHH-MM-SS-<rand>` (colons/dots → dashes, so it is a
 * legal filename and lexicographically time-ordered). `now`/`rand` are injected for deterministic tests;
 * default to the clock and 4 base36 chars of randomness.
 */
function newSessionId(now, rand) {
	const d = now instanceof Date ? now : new Date();
	const stamp = d.toISOString().replace(/[:.]/g, '-').slice(0, 19); // 2026-07-28T09-12-33
	const r = rand != null ? String(rand) : crypto.randomBytes(3).toString('hex').slice(0, 4);
	return stamp + '-' + r;
}

// ── paths (pure) ───────────────────────────────────────────────────────────────────────────────

function projectDir(root, slug) { return path.join(root, slug); }
function sessionFile(root, slug, id) { return path.join(root, slug, String(id) + '.jsonl'); }
function indexFile(root, slug) { return path.join(root, slug, INDEX_NAME); }

// ── event encoding & parsing (pure) ──────────────────────────────────────────────────────────────

/** The birth line — written once, so even a one-message crash leaves a listable session (design §4). */
function metaLine(id, projectPath, createdAtIso, title) {
	return { kind: 'meta', v: SCHEMA_V, id: String(id), project: String(projectPath == null ? '' : projectPath),
		createdAt: String(createdAtIso), title: title == null ? null : String(title) };
}

function encodeEvent(event) { return JSON.stringify(event) + '\n'; }

/**
 * Parse a session file's text into `{ meta, events }`. Tolerant by construction: append-only means the
 * only way a line is malformed is a torn final write (crash mid-append), so a trailing unparseable line
 * is DROPPED rather than throwing — the crash costs at most the in-flight event (design §prior-art).
 */
function parseSession(text) {
	const lines = String(text == null ? '' : text).split('\n');
	let meta = null;
	const events = [];
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (!line) { continue; } // blank (incl. the trailing newline's empty tail)
		let obj;
		try { obj = JSON.parse(line); }
		catch { if (i === lines.length - 1) { break; } else { continue; } } // torn last line → stop; a mid-file junk line → skip
		if (obj && obj.kind === 'meta' && !meta) { meta = obj; }
		else { events.push(obj); }
	}
	return { meta, events };
}

// ── derive an index entry from a parsed session (pure — the heart of the cache) ──────────────────

function truncate(s, n) { const t = String(s == null ? '' : s); return t.length > n ? t.slice(0, n - 1) + '…' : t; }

/**
 * Fold a parsed session into the compact entry the History list reads. PURE and total — every field
 * degrades gracefully so a partial/old-schema session still yields a listable row (never throws).
 */
function deriveEntry(meta, events) {
	const evs = Array.isArray(events) ? events : [];
	const id = meta && meta.id ? String(meta.id) : null;
	const createdAt = meta && meta.createdAt ? meta.createdAt : (evs[0] && evs[0].t) || null;

	let title = null, updatedAt = createdAt, model = null, state = 'active', lifecycle = 'active', pinned = false;
	let turns = 0, firstUser = null;
	const editCounts = new Map(); // path → times edited (order-preserving via Map)
	const spark = [];

	for (const e of evs) {
		if (!e || typeof e !== 'object') { continue; }
		if (e.t) { updatedAt = e.t; }
		switch (e.kind) {
			case 'user': turns++; if (firstUser == null && e.content != null) { firstUser = String(e.content); } break;
			case 'assistant': case 'agent': if (e.model) { model = e.model; } break;
			case 'title': if (e.title != null) { title = String(e.title); } break;
			case 'end': if (e.state) { state = String(e.state); } break;
			case 'label':
				if (e.lifecycle) { lifecycle = String(e.lifecycle); }
				if (typeof e.pinned === 'boolean') { pinned = e.pinned; }
				break;
		}
		// files edited + the activity sparkline come from agent turns (explicit `edits` + `tools` count)
		if (e.kind === 'agent' || e.kind === 'edit') {
			const paths = e.kind === 'edit' ? (e.path ? [e.path] : []) : (Array.isArray(e.edits) ? e.edits.map((x) => x && x.path).filter(Boolean) : []);
			for (const p of paths) { editCounts.set(p, (editCounts.get(p) || 0) + 1); }
		}
		if (e.kind === 'agent') { spark.push(Number.isFinite(e.tools) ? e.tools : (Array.isArray(e.edits) ? e.edits.length : 0)); }
	}

	if (title == null) { title = (meta && meta.title != null) ? String(meta.title) : (firstUser != null ? truncate(firstUser, 56) : null); }
	const filesEdited = [...editCounts.entries()].sort((a, b) => b[1] - a[1]).map(([p]) => p);

	return { id, title, createdAt, updatedAt, turns, model, state, lifecycle, pinned,
		filesEdited, spark, preview: firstUser != null ? truncate(firstUser, PREVIEW_MAX) : null };
}

// ── writing (append-only) ────────────────────────────────────────────────────────────────────────

/** Create a session: its directory + the meta birth line. Idempotent-ish (a re-create just rewrites meta). */
function createSession(root, slug, id, projectPath, createdAtIso, title) {
	fs.mkdirSync(projectDir(root, slug), { recursive: true });
	fs.writeFileSync(sessionFile(root, slug, id), encodeEvent(metaLine(id, projectPath, createdAtIso, title)));
	return sessionFile(root, slug, id);
}

/** Append ONE event line. The only write on the hot (per-turn) path — a tiny, crash-safe append. */
function appendEvent(file, event) { fs.appendFileSync(file, encodeEvent(event)); }

// ── reading ONE session (the switch path — exactly one file) ─────────────────────────────────────

/** Read + parse a single session file. This is what `resume`/switch calls: one file, size-bounded. */
function readSession(file) { return parseSession(fs.readFileSync(file, 'utf8')); }

// ── the index (cache; rebuildable by scanning) ───────────────────────────────────────────────────

function listSessionFiles(root, slug) {
	let names;
	try { names = fs.readdirSync(projectDir(root, slug)); }
	catch { return []; } // no project dir yet → no sessions
	return names.filter((n) => n.endsWith('.jsonl')).map((n) => path.join(root, slug, n));
}

/** Sort newest-first for the default History order. */
function sortEntries(entries) {
	return entries.slice().sort((a, b) => String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || '')));
}

/**
 * The SOURCE OF TRUTH: derive every entry by reading the files. O(corpus) and only paid when the cache is
 * absent or corrupt — never on a normal list. This is what makes the index safe to treat as a throwaway.
 */
function scanProject(root, slug) {
	const entries = [];
	for (const file of listSessionFiles(root, slug)) {
		try { const { meta, events } = readSession(file); const e = deriveEntry(meta, events); if (e.id) { entries.push(e); } }
		catch { /* a single unreadable file must not sink the scan */ }
	}
	return sortEntries(entries);
}

/**
 * Load the index CACHE for a project. Reads index.json and validates it; on ANY problem — missing,
 * malformed, wrong/newer schema, not an array — it silently REBUILDS by scanning and reports `rebuilt`,
 * so a corrupt index can never hide sessions that still exist on disk. Returns { v, entries, rebuilt }.
 */
function loadIndex(root, slug) {
	try {
		const raw = fs.readFileSync(indexFile(root, slug), 'utf8');
		const obj = JSON.parse(raw);
		if (obj && obj.v === SCHEMA_V && Array.isArray(obj.entries)) {
			return { v: SCHEMA_V, entries: sortEntries(obj.entries), rebuilt: false };
		}
	} catch { /* fall through to rebuild */ }
	return { v: SCHEMA_V, entries: scanProject(root, slug), rebuilt: true };
}

/** Persist the index atomically (tmp + rename) so a crash never leaves a half-written cache. */
function writeIndex(root, slug, entries) {
	fs.mkdirSync(projectDir(root, slug), { recursive: true });
	const tmp = indexFile(root, slug) + '.' + process.pid + '.tmp';
	fs.writeFileSync(tmp, JSON.stringify({ v: SCHEMA_V, entries: sortEntries(entries) }));
	fs.renameSync(tmp, indexFile(root, slug));
}

/** Incrementally replace-or-insert one entry (by id) — the per-seal update, no full rescan. */
function upsertEntry(entries, entry) {
	const out = (Array.isArray(entries) ? entries : []).filter((e) => e && e.id !== entry.id);
	out.push(entry);
	return sortEntries(out);
}

// ── FAST RETRIEVAL (pure, in-memory — no disk) ───────────────────────────────────────────────────

/**
 * Look up one entry by id in an ALREADY-LOADED index. Pure: it takes the in-memory `index` and never
 * touches disk, so retrieving a 25-day-old (or any-age) session's metadata is a memory op, independent
 * of the corpus. For very large corpora a Map cache is a drop-in; a linear find over a few thousand
 * entries is already sub-millisecond.
 */
function getEntry(index, id) {
	const entries = index && Array.isArray(index.entries) ? index.entries : [];
	for (const e of entries) { if (e && e.id === id) { return e; } }
	return null;
}

/** The sorted list view (pure). Optional lifecycle filter (e.g. 'active' hides archived). */
function listEntries(index, opts) {
	const o = opts || {};
	let entries = (index && Array.isArray(index.entries) ? index.entries : []).slice();
	if (o.lifecycle) { entries = entries.filter((e) => (e.lifecycle || 'active') === o.lifecycle); }
	return sortEntries(entries);
}

module.exports = {
	SCHEMA_V,
	projectSlug, newSessionId, projectDir, sessionFile, indexFile,
	metaLine, encodeEvent, parseSession, deriveEntry,
	createSession, appendEvent, readSession,
	listSessionFiles, scanProject, loadIndex, writeIndex, upsertEntry,
	getEntry, listEntries
};
