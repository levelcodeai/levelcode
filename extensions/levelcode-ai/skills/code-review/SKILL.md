---
name: code-review
description: Review a code diff or a set of changed files for correctness bugs, security issues, and reuse/simplification cleanups, then report findings grouped by severity. Use when asked to review changes, a diff, a PR, or to check code before shipping.
---

# Code review

You are reviewing code, not rewriting it. Default to READ-ONLY: do not edit files unless the user explicitly asked you to fix what you find. Your output is a findings report, not a patch.

## 1. Get the diff first

Review the CHANGE, not the whole repo. Establish what actually changed before reading anything else:

- `run_command`: `git diff --stat` then `git diff` (or `git diff main...HEAD` for a branch). If the user named files, `read_file` those.
- If there is no git diff (uncommitted new work), `read_file` the files the user pointed at.
- For each changed file, `read_file` enough surrounding context to judge the change — a hunk in isolation lies. Read the function it lives in and its callers (`search` for the symbol).

Do not review code you have not actually read. Never invent line numbers.

## 2. Hunt, in priority order

Go through every hunk. For each, ask in this order and stop escalating once you log a finding:

1. **Correctness** — off-by-one, null/undefined/empty-input, wrong operator, inverted condition, await missing on a promise, unhandled error path, resource left open, mutation of a shared/input object, wrong default. Trace the new edge cases the change introduces.
2. **Security & data safety** — injection (shell/SQL/path), unvalidated input crossing a trust boundary, secrets in code/logs, path traversal, missing authz check, unsafe deserialization.
3. **Contract drift** — a changed signature/return shape/throw behavior whose callers were NOT updated. `search` for every caller and confirm.
4. **Reuse & simplification** — duplicated logic that an existing helper already covers, dead code, a 20-line block that a stdlib call replaces, needless re-computation in a loop.
5. **Tests & docs** — behavior changed but no test covers the new path; a public comment/README now contradicts the code.

Prefer FEWER, HIGH-CONFIDENCE findings over a long list of nits. If you are unsure a finding is real, say so explicitly rather than dropping it or overstating it.

## 3. Verify suspicions before reporting

A suspected bug is a hypothesis. Confirm it with the tools before you write it down:

- Re-`read_file` the exact lines.
- `search` for the symbol to check callers / existing helpers / existing tests.
- If a verify command is configured, `run_command` the typecheck/lint/test to see if the change already breaks something concrete — that turns a guess into a fact.

Drop anything you cannot substantiate. A wrong finding costs the reviewer more than a missed nit.

## 4. Report

Group findings by severity. For each: `file:line — what's wrong — why it matters — concrete fix`. Be specific and short.

```
BLOCKER  src/auth.js:42 — token compared with == so "0" matches ""; use === . An empty token would authenticate.
MAJOR    src/db.js:88 — query interpolates req.params.id directly (SQL injection). Use a parameterized query.
MINOR    src/util.js:12 — re-reads config inside the loop; hoist it above the loop.
NIT      src/api.js:5 — duplicates formatDate() from lib/time.js; reuse it.
```

If nothing is wrong, say so plainly and name the riskiest hunk you were least sure about. End with a one-line `Done:` summary of the review (e.g. `Done: reviewed 4 files, 1 blocker + 2 minor`). Apply fixes only if the user asked — then make the smallest edit per finding and let the auto-verify loop check it.
