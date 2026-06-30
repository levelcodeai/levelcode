---
name: focused-fix
description: Fix one specific reported bug with the smallest correct change, using SCOPE then TRACE then DIAGNOSE then FIX then VERIFY. Use when the user reports a concrete defect — a crash, a wrong result, a function that throws or misbehaves on certain input.
---

# Focused fix

There is ONE concrete bug. Your job is the smallest change that makes it correct — not a refactor, not a redesign. Work the five phases in order and do not skip ahead.

## SCOPE — pin down exactly what's broken

State, in one sentence to yourself, the observable failure: the input, the actual behavior, the expected behavior. If the report is "login throws on empty input," the bug is *empty input*, not "login is messy." Resist widening scope. If the real reproduction is genuinely ambiguous (you cannot tell which of two behaviors is wanted), call `ask_user` ONCE with the concrete options — otherwise pick the obvious reading and proceed.

## TRACE — find the exact code on the failure path

Do not guess where the bug lives. Locate it:

- `search` for the symbol, error string, route, or message from the report.
- `read_file` the function that fails AND the callers/inputs that reach it. Follow the data from where it enters to where it breaks.
- Identify the precise line(s) responsible. If you cannot point at a specific line, you have not traced enough — keep reading.

## DIAGNOSE — name the root cause before touching anything

In one sentence: *why* does it fail? ("`user.name` is read before the null check, so empty input dereferences undefined.") Distinguish root cause from symptom — patching the symptom (swallowing the error) leaves the bug. If a quick `run_command` (a failing test, a one-line repro, a `node -e`) confirms the cause, do it — a confirmed diagnosis beats a plausible one. Do not start editing until you can name the cause.

## FIX — smallest correct edit

- Prefer `edit_file` with a tight, unique `old_str` — read the file first so the snippet matches exactly. Several small edits beat one large rewrite.
- Change only what the diagnosis requires. Do not reformat, rename, or "improve" nearby code — that hides the fix and risks new bugs.
- Handle the actual edge case from SCOPE (the empty/null/boundary input), not a vague "add validation everywhere."
- Match the surrounding code's style and existing error-handling convention.

## VERIFY — prove it's fixed and nothing else broke

- Re-read the edited region to confirm the change is what you intended.
- If a test or repro exists or you wrote one, `run_command` it and confirm the failure is gone.
- The auto-verify loop will check editor diagnostics + the configured verify command for the files you touched. Stay until it is clean; fix only problems YOU introduced. If a reported problem is clearly pre-existing and unrelated to this bug, do not chase it — note it in one line.
- Confirm you did not regress the happy path (the non-empty, normal input still works).

Finish with a one-line `Done:` summary naming the root cause and the fix (e.g. `Done: empty-input crash in login — added an early guard before user.name is read`).
