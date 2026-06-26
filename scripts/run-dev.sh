#!/usr/bin/env bash
#
# Launch Atom++ from source (no packaging). Fast way to verify branding/gallery
# before doing a full .app build. Compiles on first run, then opens the editor.
#
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VSCODE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)/vscode"

[ -d "$VSCODE_DIR" ] || { echo "Run ./scripts/bootstrap.sh first."; exit 1; }

cd "$VSCODE_DIR"
echo "[run-dev] Building core (first run takes a while)…"
npm run compile
echo "[run-dev] Launching Atom++ (dev)…"
./scripts/code.sh "$@"
