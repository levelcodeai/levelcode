/*---------------------------------------------------------------------------------------------
 *  LevelCode — draft RELEASE-NOTES.md for a release.
 *
 *  Usage:  node scripts/draft-release-notes.mjs 0.9.2 [--write]
 *          (--write replaces RELEASE-NOTES.md; without it the draft goes to stdout)
 *
 *  WHY THIS EXISTS
 *
 *  Writing release notes has two halves, and only one of them is a computer's job.
 *
 *  The FACTS are: which commits are in the range, which PRs they came from, what the previous tag
 *  was, how many test suites there are and how many cases each holds, and the compare URL. Every one
 *  of those was previously looked up by hand for each release, which is exactly the kind of thing
 *  that gets misremembered — a stale test count or a compare link pointing at the wrong tag is a
 *  small lie that nobody catches.
 *
 *  The PROSE is: which two of fourteen commits actually matter to a user, what to lead with, and how
 *  to frame a change so it is not misread (v0.9.2 had to say "credits are a change of unit, not of
 *  price" — no commit subject contains that). This script does NOT attempt that, on purpose. A
 *  changelog auto-generated from commit subjects is the reason most release notes go unread.
 *
 *  So: this fills in everything factual and leaves clearly-marked TODOs where judgement is required.
 *
 *  IT ALSO SHOWS ITS WORKING. Every commit it classifies as internal is listed under "excluded" in
 *  the draft. A tool that silently drops commits is worse than no tool — you cannot review an
 *  omission you never see. Delete that section once you have checked it.
 *--------------------------------------------------------------------------------------------*/
import { execSync, spawnSync } from 'node:child_process';
import { readdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const REPO = process.cwd();
const sh = (cmd) => execSync(cmd, { cwd: REPO, encoding: 'utf8' }).trim();
const die = (msg) => { console.error('draft-release-notes: ' + msg); process.exit(1); };

// ---- arguments ---------------------------------------------------------------------------------

const args = process.argv.slice(2);
const write = args.includes('--write');
const version = args.find((a) => !a.startsWith('--'));
if (!version) { die('usage: node scripts/draft-release-notes.mjs <version> [--write]   e.g. 0.9.2'); }
if (!/^\d+\.\d+\.\d+$/.test(version)) { die(`"${version}" is not a bare semver (expected e.g. 0.9.2, no leading v)`); }

const tag = 'v' + version;
if (sh('git tag --list ' + tag)) {
	die(`${tag} already exists. Notes are written BEFORE tagging, so the tag contains them.`);
}

// ---- the range ---------------------------------------------------------------------------------

// Newest existing release tag, which is what this release is measured against.
const prevTag = sh("git tag --list 'v*' --sort=-v:refname").split('\n').filter(Boolean)[0];
if (!prevTag) { die('no previous v* tag found — cannot compute a range or a compare link'); }

const dirty = sh('git status --porcelain').split('\n').filter((l) => l && !l.startsWith('??'));
const warnings = [];
if (dirty.length) {
	warnings.push(`working tree has ${dirty.length} uncommitted change(s) — the notes may describe code that is not in the tag`);
}

// %x1f separates fields, %x1e separates records: commit subjects contain almost anything else.
const raw = sh(`git log --format=%H%x1f%s%x1f%an%x1e ${prevTag}..HEAD`);
const commits = raw.split('\x1e').map((r) => r.trim()).filter(Boolean).map((r) => {
	const [hash, subject, author] = r.split('\x1f');
	return { hash: hash.slice(0, 7), subject, author };
});
if (!commits.length) { die(`no commits between ${prevTag} and HEAD — nothing to release`); }

// ---- classification ----------------------------------------------------------------------------
//
// Conventional-commit type decides the SECTION, not whether the change matters — that is your call.
// Merge commits are dropped (their PR title is already carried by the squashed/branch commits), but
// their PR numbers are collected so the draft can cite them.

const prNumbers = [];
const isMerge = (c) => {
	const m = /^Merge pull request #(\d+)/.exec(c.subject);
	if (m) { prNumbers.push(m[1]); return true; }
	return /^Merge branch /.test(c.subject);
};

const typeOf = (subject) => (/^(\w+)(\([^)]*\))?!?:/.exec(subject) || [])[1] || 'other';
const USER_FACING = new Set(['feat', 'fix', 'perf', 'revert']);
const INTERNAL = new Set(['ci', 'build', 'chore', 'test', 'docs', 'refactor', 'style']);

const kept = commits.filter((c) => !isMerge(c));
const features = kept.filter((c) => typeOf(c.subject) === 'feat');
const fixes = kept.filter((c) => ['fix', 'perf', 'revert'].includes(typeOf(c.subject)));
const excluded = kept.filter((c) => INTERNAL.has(typeOf(c.subject)));
const unclassified = kept.filter((c) => !USER_FACING.has(typeOf(c.subject)) && !INTERNAL.has(typeOf(c.subject)));

// ---- test coverage, measured rather than recalled -----------------------------------------------
//
// Runs the same suites the release gate runs and reads each one's own reported count. If a suite
// fails, that is a release blocker, not a footnote — say so loudly and exit non-zero.

function measureSuites() {
	const extRoot = join(REPO, 'extensions');
	if (!existsSync(extRoot)) { return { suites: [], failed: [] }; }
	const suites = [];
	const failed = [];
	for (const ext of readdirSync(extRoot)) {
		const testDir = join(extRoot, ext, 'test');
		if (!existsSync(testDir)) { continue; }
		for (const file of readdirSync(testDir).filter((f) => f.endsWith('.test.js'))) {
			const rel = join('extensions', ext, 'test', file);
			const run = spawnSync('node', [rel], { cwd: REPO, encoding: 'utf8' });
			if (run.status !== 0) { failed.push(rel); continue; }
			const m = /(\d+) tests? passed/.exec(run.stdout || '');
			suites.push({ file, cases: m ? Number(m[1]) : null });
		}
	}
	return { suites, failed };
}

const { suites, failed } = measureSuites();
if (failed.length) {
	die(`these suites FAIL — fix before drafting notes:\n  ${failed.join('\n  ')}`);
}
const totalCases = suites.reduce((n, s) => n + (s.cases || 0), 0);
const biggest = [...suites].sort((a, b) => (b.cases || 0) - (a.cases || 0)).slice(0, 3);

// ---- render -------------------------------------------------------------------------------------

const bullet = (c) => `- \`${c.hash}\` ${c.subject}`;
const section = (title, list) => (list.length ? `\n### ${title}\n${list.map(bullet).join('\n')}\n` : '');

const draft = `# LevelCode v${version}

<!-- TODO one sentence: what does this release GIVE someone? Lead with the change they will notice,
     not the biggest diff. Two features is a fine release; say so plainly. -->

## Highlights
${section('Candidates — feat (write these up, or move them down / delete)', features)}${section('Candidates — fix/perf (usually "Under the hood", unless a user hit the bug)', fixes)}
<!-- TODO For each thing you keep: say what it does, then the ONE non-obvious property a user should
     know (a bound, a tradeoff, a thing it deliberately will not do). That sentence is the whole
     value of hand-writing these. -->

## Under the hood

<!-- TODO implementation notes worth a curious reader's time. -->

## Test coverage

- **${suites.length} suites** across the bundled extensions, ${totalCases} cases in total — all green.
${biggest.map((s) => `- \`${s.file}\`${s.cases != null ? ` (${s.cases} cases)` : ''} — <!-- TODO what does it guard? -->`).join('\n')}

**Full changelog:** https://github.com/levelcodeai/levelcode/compare/${prevTag}...${tag}

<!-- ============================================================================================
     EVERYTHING BELOW IS SCAFFOLDING — delete it before committing.

     Range: ${prevTag}..HEAD (${commits.length} commits, ${kept.length} after dropping merges)
     PRs merged: ${prNumbers.length ? prNumbers.map((n) => '#' + n).join(', ') : '(none detected)'}
${warnings.length ? '\n     WARNINGS:\n' + warnings.map((w) => '       - ' + w).join('\n') + '\n' : ''}
     EXCLUDED as internal — check this list; anything user-visible in here belongs above:
${excluded.length ? excluded.map((c) => `       ${c.hash} ${c.subject}`).join('\n') : '       (none)'}
${unclassified.length ? '\n     UNCLASSIFIED (no conventional-commit type) — decide for each:\n' + unclassified.map((c) => `       ${c.hash} ${c.subject}`).join('\n') + '\n' : ''}
     Deliberate omissions are fine, but they should be CHOSEN. v0.9.1 left out an undocumented
     command on purpose because publishing it would have defeated it.
     ============================================================================================ -->
`;

if (write) {
	writeFileSync(join(REPO, 'RELEASE-NOTES.md'), draft);
	console.error(`draft-release-notes: wrote RELEASE-NOTES.md for ${tag} (${prevTag}..HEAD)`);
	console.error('  Fill in the TODOs, delete the scaffolding block, then commit BEFORE tagging.');
	if (warnings.length) { warnings.forEach((w) => console.error('  WARNING: ' + w)); }
} else {
	process.stdout.write(draft);
}
