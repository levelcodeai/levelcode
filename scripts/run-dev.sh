#!/usr/bin/env bash
#
# Launch LevelCode from source (no packaging). Fast way to verify branding/gallery
# before doing a full .app build. Compiles on first run, then opens the editor.
#
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VSCODE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)/vscode"

[ -d "$VSCODE_DIR" ] || { echo "Run ./scripts/bootstrap.sh first."; exit 1; }

# Sync tracked LevelCode branding + extensions into the checkout (single source of truth).
echo "[run-dev] Syncing LevelCode branding + extensions…"
node "$SCRIPT_DIR/apply-branding.mjs" "$VSCODE_DIR" >/dev/null

cd "$VSCODE_DIR"
echo "[run-dev] Building core (first run takes a while)…"
# compile-client ONLY — deliberately NOT `npm run compile`, which also runs compile-copilot (the
# proprietary GitHub Copilot Chat extension). LevelCode disables Copilot at launch (--disable-extension
# below) and strips it from the packaged app (build-macos.sh), so compiling it is pointless here — and
# upstream's extensions/copilot/.esbuild.mts fails under Node 24 (glob CJS/ESM named-export error).
npm run compile-client
# A LevelCode run from source is its OWN app to macOS: its own bundle identifier and its own URL
# scheme (branding/product.dev.json). Sharing the installed app's meant a sign-in started here was
# handed back to the LevelCode in /Applications — the browser's levelcode:// callback goes to
# whichever app macOS picks, and it picked that one. See scripts/editor-identity.mjs.
#
# The identity is set on the dev Electron bundle, so the bundle has to exist first: preLaunch is
# what code.sh would run anyway (it fetches Electron on first launch), run here so the identity can
# go on before the editor starts — and skipped below so it does not run twice.
echo "[run-dev] Giving the dev editor its own identity…"
node build/lib/preLaunch.ts
node "$SCRIPT_DIR/editor-identity.mjs" dev "$VSCODE_DIR"
# A dev editor that is already open is joined, not replaced: quit it first to load rebuilt code.
echo "[run-dev] Launching LevelCode (dev)… (Copilot disabled to match the packaged app)"
# In dev, built-in extensions load from source — the proprietary Copilot extension
# would otherwise appear. Disable it so dev matches the shipped (Copilot-free) app.
# NB: workspace trust is left ENABLED — it is a security boundary, not a UX nag. If the
# trust dialog is disruptive during development, use a throwaway --user-data-dir profile
# or pre-trust the workspace path instead of disabling trust globally.
VSCODE_SKIP_PRELAUNCH=1 ./scripts/code.sh --new-window --disable-extension GitHub.copilot-chat "$@"
