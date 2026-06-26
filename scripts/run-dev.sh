#!/usr/bin/env bash
#
# Launch Atom++ from source (no packaging). Fast way to verify branding/gallery
# before doing a full .app build. Compiles on first run, then opens the editor.
#
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VSCODE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)/vscode"

[ -d "$VSCODE_DIR" ] || { echo "Run ./scripts/bootstrap.sh first."; exit 1; }

# Sync tracked Atom++ branding + extensions into the checkout (single source of truth).
echo "[run-dev] Syncing Atom++ branding + extensions…"
node "$SCRIPT_DIR/apply-branding.mjs" "$VSCODE_DIR" >/dev/null

cd "$VSCODE_DIR"
echo "[run-dev] Building core (first run takes a while)…"
npm run compile
echo "[run-dev] Launching Atom++ (dev)… (Copilot disabled to match the packaged app)"
# In dev, built-in extensions load from source — the proprietary Copilot extension
# would otherwise appear. Disable it so dev matches the shipped (Copilot-free) app.
./scripts/code.sh --disable-extension GitHub.copilot-chat "$@"
