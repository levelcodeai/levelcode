/*---------------------------------------------------------------------------------------------
 *  Unit tests for project-rules loading — run: node test/projectRules.test.js
 *    loadProjectRules folds a repo's AGENTS.md (or CLAUDE.md / .cursorrules) into the system prompt.
 *    The reading is a callback, so these run without a filesystem: the mock returns file bodies by
 *    absolute path. Covers discovery, alias fallback, first-present-wins, multi-root, empty-skip,
 *    truncation, and a throwing reader.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

const assert = require('assert');
const path = require('path');
const { loadProjectRules, RULES_FILENAMES, PER_FILE_CAP } = require('../projectRules');

let n = 0;
function test(name, fn) { fn(); n++; console.log('  ok - ' + name); }

// Build a reader from a { absPath: content } map. Absent paths return null.
const reader = (files) => (abs) => (abs in files ? files[abs] : null);
const at = (root, name) => path.join(root, name);

const F1 = { name: 'app', root: '/ws/app' };
const F2 = { name: 'api', root: '/ws/api' };

test('no folders / no files → empty, no text injected', () => {
	assert.deepStrictEqual(loadProjectRules([], reader({})), { text: '', sources: [] });
	assert.deepStrictEqual(loadProjectRules([F1], reader({})), { text: '', sources: [] });
});

test('AGENTS.md is discovered and folded in with a preamble', () => {
	const r = loadProjectRules([F1], reader({ [at('/ws/app', 'AGENTS.md')]: 'Use tabs. Run npm test.' }));
	assert.deepStrictEqual(r.sources, ['AGENTS.md']);
	assert.ok(r.text.includes('PROJECT RULES'), 'no preamble');
	assert.ok(r.text.includes('Use tabs. Run npm test.'), 'rules body missing');
	assert.ok(r.text.startsWith('\n\n'), 'should append cleanly to the system prompt');
});

test('alias fallback: CLAUDE.md / .cursorrules when no AGENTS.md', () => {
	const claude = loadProjectRules([F1], reader({ [at('/ws/app', 'CLAUDE.md')]: 'claude rules' }));
	assert.deepStrictEqual(claude.sources, ['CLAUDE.md']);
	const cursor = loadProjectRules([F1], reader({ [at('/ws/app', '.cursorrules')]: 'cursor rules' }));
	assert.deepStrictEqual(cursor.sources, ['.cursorrules']);
});

test('first present file in a folder wins (AGENTS.md over the aliases)', () => {
	const r = loadProjectRules([F1], reader({
		[at('/ws/app', 'AGENTS.md')]: 'AGENTS wins',
		[at('/ws/app', 'CLAUDE.md')]: 'should be ignored',
		[at('/ws/app', '.cursorrules')]: 'also ignored',
	}));
	assert.deepStrictEqual(r.sources, ['AGENTS.md']);
	assert.ok(r.text.includes('AGENTS wins') && !r.text.includes('should be ignored'));
	// preference order matches the exported constant
	assert.deepStrictEqual(RULES_FILENAMES, ['AGENTS.md', 'CLAUDE.md', '.cursorrules']);
});

test('multi-root: each folder contributes, labeled by folder name', () => {
	const r = loadProjectRules([F1, F2], reader({
		[at('/ws/app', 'AGENTS.md')]: 'app rules',
		[at('/ws/api', 'AGENTS.md')]: 'api rules',
	}));
	assert.deepStrictEqual(r.sources, ['app/AGENTS.md', 'api/AGENTS.md']);
	assert.ok(r.text.includes('### app/AGENTS.md') && r.text.includes('### api/AGENTS.md'));
	assert.ok(r.text.includes('app rules') && r.text.includes('api rules'));
});

test('single-root labels without a folder prefix', () => {
	const r = loadProjectRules([F1], reader({ [at('/ws/app', 'AGENTS.md')]: 'x' }));
	assert.ok(r.text.includes('### AGENTS.md') && !r.text.includes('app/AGENTS.md'));
});

test('empty / whitespace-only rules files are skipped (treated as absent)', () => {
	assert.deepStrictEqual(loadProjectRules([F1], reader({ [at('/ws/app', 'AGENTS.md')]: '   \n\t ' })), { text: '', sources: [] });
	// falls through to a non-empty alias
	const r = loadProjectRules([F1], reader({ [at('/ws/app', 'AGENTS.md')]: '', [at('/ws/app', 'CLAUDE.md')]: 'real rules' }));
	assert.deepStrictEqual(r.sources, ['CLAUDE.md']);
});

test('an oversized rules file is truncated with a marker', () => {
	const big = 'R'.repeat(PER_FILE_CAP + 5000);
	const r = loadProjectRules([F1], reader({ [at('/ws/app', 'AGENTS.md')]: big }));
	assert.ok(r.text.includes('truncated at ' + PER_FILE_CAP), 'no truncation marker');
	assert.ok(r.text.length < big.length, 'not actually truncated');
});

test('a throwing reader is treated as absent, never crashes', () => {
	const boom = () => { throw new Error('EACCES'); };
	assert.deepStrictEqual(loadProjectRules([F1], boom), { text: '', sources: [] });
});

test('a malformed folder entry is skipped', () => {
	const r = loadProjectRules([null, { name: 'x' }, F1], reader({ [at('/ws/app', 'AGENTS.md')]: 'ok' }));
	assert.deepStrictEqual(r.sources, ['AGENTS.md']);
});

test('multi-root: a folder with no name falls back to its basename (never "undefined/…")', () => {
	const r = loadProjectRules([{ root: '/ws/app' }, F2], reader({
		[at('/ws/app', 'AGENTS.md')]: 'a',
		[at('/ws/api', 'AGENTS.md')]: 'b',
	}));
	assert.deepStrictEqual(r.sources, ['app/AGENTS.md', 'api/AGENTS.md']);
	assert.ok(!r.text.includes('undefined/'), 'label leaked an undefined folder name');
});

// The cases above inject a fake reader; this one uses the real fs to prove the on-disk path works.
test('real filesystem: discovers and reads an on-disk rules file (smoke)', () => {
	const fs = require('fs');
	const os = require('os');
	const real = (abs) => { try { return fs.readFileSync(abs, 'utf8'); } catch { return null; } };
	const withRules = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-rules-'));
	const noRules = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-none-'));
	try {
		fs.writeFileSync(path.join(withRules, 'AGENTS.md'), '# Rules\n- Use 2-space indent');
		const hit = loadProjectRules([{ name: 'app', root: withRules }], real);
		assert.deepStrictEqual(hit.sources, ['AGENTS.md']);
		assert.ok(hit.text.includes('Use 2-space indent'), 'on-disk rules content was not folded in');
		assert.deepStrictEqual(loadProjectRules([{ name: 'empty', root: noRules }], real), { text: '', sources: [] });
	} finally {
		fs.rmSync(withRules, { recursive: true, force: true });
		fs.rmSync(noRules, { recursive: true, force: true });
	}
});

console.log(n + ' passing');
