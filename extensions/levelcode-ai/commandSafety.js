/*---------------------------------------------------------------------------------------------
 *  Danger classifier for autopilot (see the run_command gate in agent.js).
 *
 *  In autopilot the agent runs shell commands WITHOUT asking — except the ones this flags, which
 *  still show the approval card. This is a SECURITY gate, so it is deliberately biased toward flagging:
 *  a false positive costs one extra prompt; a false negative auto-runs something irreversible. When in
 *  doubt, flag. Matching is word-boundaried and scans the WHOLE command (so `echo hi && rm -rf x` and
 *  `xargs rm` are caught wherever the dangerous token sits), accepting that a dangerous word inside a
 *  quoted string ("rm is scary") will over-flag — that is the safe direction.
 *
 *  Scope (user-chosen "Deletion + irreversible"): file deletion, discarding uncommitted work, plus a
 *  small set of hard-to-undo, high-blast-radius ops — sudo, force-push / history rewrite, piping a
 *  remote script into a shell, irreversible publishes, and writes into system directories. Pure +
 *  dependency-free so the boundary is unit-testable (test/commandSafety.test.js) without booting the extension.
 *
 *  Known limitations (by design — this is a good-faith guardrail, not a sandbox): it matches command
 *  strings, so it does NOT catch deletion smuggled through an interpreter (`node -e fs.rmSync(...)`,
 *  `python -c shutil.rmtree(...)`), a bare truncating redirect (`> important.txt`), or a command
 *  deliberately obfuscated to evade it. Prompt injection that steers the model into one of those forms
 *  can therefore reach the shell unprompted in autopilot. It defends against the common case — an
 *  obviously-destructive command the model emits in good faith — not against an adversary evading it.
 *--------------------------------------------------------------------------------------------*/
'use strict';

// Each rule: [category, regex]. Ordered so the most specific/telling category wins the report.
const RULES = [
	// --- file deletion ---
	['deletion', /\brm\b/i],                                   // rm / git rm / sudo rm / xargs rm (any form)
	['deletion', /\brmdir\b/i],
	['deletion', /\bunlink\b/i],
	['deletion', /\bshred\b/i],
	['deletion', /\brimraf\b/i],                               // the idiomatic Node recursive delete — no \brm\b boundary inside "rimraf"
	['deletion', /\bgit\s+clean\b/i],                          // -f/-d/-x wipe untracked files
	['deletion', /\bfind\b[\s\S]*?-delete\b/i],
	['deletion', /\bfind\b[\s\S]*?-exec\s+rm\b/i],
	['deletion', /\btruncate\b/i],                             // -s 0 empties a file
	['deletion', /\bdd\b/i],                                   // disk-destroyer
	['deletion', /\bmkfs\b/i],
	['deletion', />\s*\/dev\/(sd|disk|nvme|null\/)/i],         // redirect over a device node

	// --- discarding uncommitted work (same irreversible effect as reset --hard; NOT in the reflog) ---
	['discard-changes', /\bgit\s+reset\s+--hard\b/i],          // discards the working tree
	// `git checkout` that targets a path/HEAD/force (not a branch switch, which is safe):
	['discard-changes', /\bgit\s+checkout\b[^&|;\n]*(\s--(\s|$)|\s\.(\s|$)|\bHEAD\b|--force\b|\s-f\b)/i],
	// `git restore <path>` overwrites the working tree; `git restore --staged` only unstages (safe).
	// But `--staged --worktree` (or `-W`) DOES write the working tree, so flag it before the exemption below.
	['discard-changes', /\bgit\s+restore\b[^\n&|;]*(--worktree\b|\s-W\b)/i],
	['discard-changes', /\bgit\s+restore\b(?![^\n&|;]*--staged)/i],

	// --- irreversible / high blast radius ---
	['sudo', /\bsudo\b/i],
	['sudo', /\bdoas\b/i],
	['force-push', /\bgit\s+push\b[\s\S]*?(--force\b|--force-with-lease\b|--mirror\b|\s-f\b)/i],
	['history-rewrite', /\bgit\s+filter-(branch|repo)\b/i],
	['history-rewrite', /\bgit\s+reflog\s+expire\b/i],
	['history-rewrite', /\bgit\s+gc\b[\s\S]*?--prune/i],
	['remote-exec', /\b(curl|wget|fetch)\b[\s\S]*?\|\s*(sudo\s+)?(sh|bash|zsh|ksh|fish|python3?|node|ruby|perl)\b/i],
	['publish', /\b(npm|yarn|pnpm)\s+publish\b/i],

	// --- writes that escape the project into system dirs ---
	['system-write', />>?\s*\/(etc|usr|bin|sbin|System|Library|var|boot|opt)\b/i],
	['system-write', /\b(rm|mv|cp|chmod|chown|tee)\b[\s\S]*?\s\/(etc|usr|bin|sbin|System|boot)\b/i],
];

/**
 * Classify a shell command for the autopilot gate.
 * @param {string} command
 * @returns {{ dangerous: boolean, category: string|null }}
 */
function classifyCommand(command) {
	const s = String(command || '');
	for (const [category, re] of RULES) {
		if (re.test(s)) { return { dangerous: true, category }; }
	}
	return { dangerous: false, category: null };
}

/** Convenience boolean wrapper. */
function isDangerousCommand(command) {
	return classifyCommand(command).dangerous;
}

/** Short human label for the approval card ("why is autopilot still asking?"). */
function dangerLabel(category) {
	switch (category) {
		case 'deletion': return 'deletes files';
		case 'discard-changes': return 'discards uncommitted changes';
		case 'sudo': return 'runs as root (sudo)';
		case 'force-push': return 'force-pushes / rewrites remote history';
		case 'history-rewrite': return 'rewrites git history';
		case 'remote-exec': return 'pipes a remote script into a shell';
		case 'publish': return 'publishes a package';
		case 'system-write': return 'writes outside the project';
		default: return 'is potentially destructive';
	}
}

module.exports = { classifyCommand, isDangerousCommand, dangerLabel };
