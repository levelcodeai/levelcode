#!/usr/bin/env bash
#
# Run every extension's unit suites. This is the gate: the release workflow runs it before spending
# an hour of macOS build minutes, and every pull request runs it too (.github/workflows/test.yml).
#
# It DISCOVERS suites — extensions/*/test/*.test.js, and the browser edition's unit suites in
# web/test/unit/*.test.js — so a new one is gated the moment it is added, with no list to keep in sync.
# (web/test/e2e.mjs drives a real browser against a built editor; it is not a unit suite and is not here.) (The gate used to `cd extensions/levelcode-ai`; levelcode-updater's
# suites never ran, including the one guarding the Download button against serving a raw .app.zip.)
# Requires are file-relative, so the suites run from the repo root.
#
# Usage:
#   ./scripts/test-extensions.sh
#
set -euo pipefail
shopt -s nullglob

cd "$(dirname "$0")/.."

count=0
for t in extensions/*/test/*.test.js web/test/unit/*.test.js; do
  echo "── $t"
  node "$t"          # `set -e` stops at the first suite that fails
  count=$((count + 1))
done
# A glob that matches nothing would otherwise report success and gate nothing. Fail loudly instead.
if [ "$count" -eq 0 ]; then
  echo "::error::No suites matched extensions/*/test/*.test.js or web/test/unit/*.test.js — the gate would pass vacuously."
  exit 1
fi
echo "──────── $count test files passed ────────"
