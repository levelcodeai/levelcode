/*---------------------------------------------------------------------------------------------
 *  Project rules — load a per-repo AGENTS.md (or a common alias) and fold it into the agent's
 *  system prompt so the model follows the project's own conventions from turn one. Read ONCE per
 *  run and placed in the (cached) system block, so it stays byte-stable across a run's turns.
 *
 *  AGENTS.md is the emerging cross-vendor standard; we also accept CLAUDE.md and .cursorrules so an
 *  existing repo works without a rename. The first file present in a folder wins.
 *
 *  Pure + dependency-free (path only): the finding/reading is injected as a readFile callback, so the
 *  assembly is unit-testable (test/projectRules.test.js) without a filesystem. Note: rules content is
 *  the repo author's, injected into the prompt by design — the same trust model as Cursor/Copilot
 *  rules files. The agent is told they yield to a direct request in the conversation.
 *--------------------------------------------------------------------------------------------*/
'use strict';

const path = require('path');

// Preference order; the first present file in a given folder wins.
const RULES_FILENAMES = ['AGENTS.md', 'CLAUDE.md', '.cursorrules'];
// A rules file rides the cached prefix on EVERY turn, so cap it. Past this it's truncated with a marker.
const PER_FILE_CAP = 16000;

/**
 * Load the project's rules file(s) and format them as a system-prompt section.
 * @param {Array<{name:string, root:string}>} folders  workspace folders (name + absolute root)
 * @param {(absPath:string)=>(string|null)} readFile   returns file content, or null if absent/unreadable
 * @returns {{ text: string, sources: string[] }}       text is '' when no rules file is found
 */
function loadProjectRules(folders, readFile) {
	const valid = (Array.isArray(folders) ? folders : []).filter((f) => f && f.root);
	const multi = valid.length > 1;   // prefix labels by folder only when there really are 2+ folders
	const blocks = [];
	const sources = [];
	for (const f of valid) {
		for (const name of RULES_FILENAMES) {
			let content = null;
			try { content = readFile(path.join(f.root, name)); } catch { content = null; }
			if (content && content.trim()) {
				const label = multi ? (f.name || path.basename(f.root)) + '/' + name : name;   // never "undefined/AGENTS.md"
				let body = content.trim();
				if (body.length > PER_FILE_CAP) { body = body.slice(0, PER_FILE_CAP) + '\n\n…[' + label + ' truncated at ' + PER_FILE_CAP + ' chars]'; }
				blocks.push('### ' + label + '\n' + body);
				sources.push(label);
				break;   // first present rules file in this folder wins
			}
		}
	}
	if (!blocks.length) { return { text: '', sources: [] }; }
	const preamble = '\n\nPROJECT RULES — the user maintains these in their repository. Treat them as part of your'
		+ ' instructions and follow them, unless they conflict with a direct request in this conversation:\n\n';
	return { text: preamble + blocks.join('\n\n'), sources };
}

module.exports = { loadProjectRules, RULES_FILENAMES, PER_FILE_CAP };
