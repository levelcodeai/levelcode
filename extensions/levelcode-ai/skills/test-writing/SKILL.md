---
name: test-writing
description: Write focused, behavior-driven tests for a function, module, or recent change, covering the happy path plus edge and error cases, in the project's existing test framework. Use when asked to add tests, improve coverage, or write a test for new or changed code.
---

# Test writing

Write tests that pin down BEHAVIOR and would actually catch a regression. A test that always passes, or that just restates the implementation, is worse than no test.

## 1. Match the project — never invent a framework

Before writing anything, discover how this repo already tests:

- `search` / `list_files` for existing tests (`*.test.*`, `*_test.*`, `*.spec.*`, `test/`, `__tests__/`, `spec/`).
- `read_file` one or two of them and copy their framework, assertion style, file location, naming, and setup/teardown. Use Jest if they use Jest, pytest if they use pytest, RSpec if they use RSpec, etc.
- `read_file` `package.json` / `pyproject.toml` / `Makefile` to find the actual test command (e.g. `npm test`, `pytest`).
- If there is genuinely no existing test setup and the choice is non-trivial, `ask_user` once which framework to use; otherwise pick the ecosystem default and proceed.

Mirror the existing layout: put the new test where this project keeps tests.

## 2. Understand the unit under test

`read_file` the function/module you are testing. List its real behaviors: the return for normal input, each branch, what it throws/returns on bad input, side effects (writes, calls). Tests come from the code's contract, not from guessing.

## 3. Cover the cases that matter

For each behavior write one focused test. Prioritize:

1. **Happy path** — typical input -> expected output.
2. **Edge cases** — empty / null / undefined / zero / negative / boundary / very large / unicode / duplicate.
3. **Error cases** — invalid input throws or returns the documented error; assert the failure, don't just call it.
4. **The specific change** — if you're testing a fix or new feature, add a test that FAILS without it (the regression guard).

Rules: one logical assertion focus per test; a clear name describing the scenario and expectation (`returns 0 for an empty list`); arrange-act-assert; deterministic (no real network/clock/random — stub or inject). Assert real values, not just "truthy." Don't test private internals or the language itself — test the public contract.

## 4. Run them and make them honest

- `write_file` for a brand-new test file, or `edit_file` to add cases to an existing one.
- `run_command` the test suite and read the output. They must PASS.
- Sanity-check that they could fail: a regression test for a fix should fail against the un-fixed code. If you can briefly confirm a test fails when you'd expect it to, you've proven it's real.
- Fix flakiness and any problems the auto-verify loop reports for the files you touched.

Finish with a one-line `Done:` summary: how many tests, what they cover, and that the suite is green (e.g. `Done: 6 tests for parseDate — happy path + empty/invalid/boundary, all passing`).
