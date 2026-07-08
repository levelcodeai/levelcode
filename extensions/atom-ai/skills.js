/*---------------------------------------------------------------------------------------------
 *  LevelCode — AI (M6.5: implicit skills — SKILL.md expertise the agent picks per task)
 *
 *  A dependency-free registry of bundled SKILL.md "skills" (the open agentskills.io standard:
 *  a folder per skill with YAML-style frontmatter `name` + `description`, then a markdown body).
 *  Progressive disclosure: only name+description ever enter the prompt; the full body loads
 *  (via the use_skill tool) only when the agent picks it. No yaml dependency — a tiny line parser.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

const fs = require('fs');
const path = require('path');

const SKILLS_DIRNAME = 'skills';

/**
 * Parse a SKILL.md's YAML-style frontmatter WITHOUT a yaml dependency.
 * Returns { meta, body } or null if there is no valid (opened AND closed) frontmatter block.
 * Handles: BOM, CRLF/LF, quoted values, `key: value`, folded scalars (`description: >` then
 * indented continuation lines), and wrapped/indented continuation of the previous key.
 * Intentionally minimal — frontmatter is flat scalars only; anything fancier is ignored. Never throws.
 * @param {string} text
 * @returns {{meta:Record<string,string>, body:string}|null}
 */
function parseSkillFrontmatter(text) {
	const src = String(text == null ? '' : text).replace(/^﻿/, '');   // strip UTF-8 BOM
	const lines = src.split(/\r?\n/);
	if ((lines[0] || '').trim() !== '---') { return null; }                // must OPEN with ---
	const meta = {};
	let i = 1, closed = false, key = null;
	for (; i < lines.length; i++) {
		const raw = lines[i];
		if (raw.trim() === '---') { closed = true; i++; break; }            // closing fence
		// indented continuation of the previous key (folded `>` value or wrapped line)
		if (/^\s+\S/.test(raw) && key) { meta[key] = (meta[key] ? meta[key] + ' ' : '') + raw.trim(); continue; }
		const m = /^([A-Za-z0-9_-]+)\s*:\s?(.*)$/.exec(raw);                // key: value
		if (!m) { continue; }                                              // tolerate odd lines
		key = m[1].toLowerCase();
		let val = m[2].trim();
		if (val === '>' || val === '|' || val === '>-' || val === '|-') { meta[key] = ''; continue; } // block scalar → fill from continuations
		if (val.length >= 2 && ((val[0] === '"' && val.slice(-1) === '"') || (val[0] === "'" && val.slice(-1) === "'"))) {
			val = val.slice(1, -1);                                        // unquote
		}
		meta[key] = val;
	}
	if (!closed) { return null; }                                          // unterminated frontmatter → reject
	const body = lines.slice(i).join('\n').replace(/^\n+/, '');            // markdown body after the closing ---
	return { meta, body };
}

/**
 * quick_validate gate: turn a parsed file into an index entry, or null if malformed.
 * Mirrors agentskills.io's required {name, description}; ignores all other fields in v1.
 * @returns {{name:string, description:string, body:string}|null}
 */
function validateSkill(parsed) {
	if (!parsed || !parsed.meta) { return null; }
	const name = String(parsed.meta.name || '').trim();
	const description = String(parsed.meta.description || '').trim();
	if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) { return null; }          // kebab-case id
	if (description.length < 8 || description.length > 1024) { return null; }
	return { name, description, body: parsed.body };
}

const _cache = new Map();   // extensionPath → Map<name,{name,description,body,dir}>  (scan once per process)

/** Scan `<extensionPath>/skills/<name>/SKILL.md` → an index keyed by skill name. Malformed → skipped, never thrown. */
function loadSkills(extensionPath, dbg) {
	if (_cache.has(extensionPath)) { return _cache.get(extensionPath); }
	const index = new Map();
	const base = path.join(extensionPath || '', SKILLS_DIRNAME);
	let dirs = [];
	try { dirs = fs.readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); }
	catch { _cache.set(extensionPath, index); return index; }              // no skills/ folder → empty menu, feature inert
	for (const dirName of dirs) {
		let raw;
		try { raw = fs.readFileSync(path.join(base, dirName, 'SKILL.md'), 'utf8'); } catch { continue; }
		const v = validateSkill(parseSkillFrontmatter(raw));
		if (!v) { if (dbg) { dbg('skills.skip', { dir: dirName }); } continue; }   // quick_validate gate
		const id = v.name === dirName ? v.name : dirName;                  // folder wins on mismatch (on-disk id)
		index.set(id, { name: id, description: v.description, body: v.body, dir: path.join(base, dirName) });
	}
	if (dbg) { dbg('skills.loaded', { count: index.size, names: [...index.keys()] }); }
	_cache.set(extensionPath, index);
	return index;
}

/** The cheap menu sent in SYSTEM — name + description ONLY (bodies never enter the prompt at scan time). */
function skillsMenu(index) { return [...index.values()].map((s) => ({ name: s.name, description: s.description })); }

/** Resolve a full SKILL.md body by name, or null (→ unknown-skill guard in the use_skill tool). */
function getSkillBody(index, name) { const s = index.get(String(name || '')); return s ? s.body : null; }

module.exports = { parseSkillFrontmatter, validateSkill, loadSkills, skillsMenu, getSkillBody };
