#!/usr/bin/env bash
#
# Build Atom++.app for macOS from the branded Code-OSS checkout.
# Produces an unsigned .app in ../VSCode-darwin-<arch>/ (renamed to Atom++.app).
#
# Signing/notarization is intentionally a separate, later step (needs an Apple
# Developer ID). An unsigned build runs locally fine for M0's exit test —
# right-click > Open the first time, or clear quarantine (see end of script).
#
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
VSCODE_DIR="$ROOT_DIR/vscode"

[ -d "$VSCODE_DIR" ] || { echo "Run ./scripts/bootstrap.sh first."; exit 1; }

# Detect arch -> gulp target.
ARCH="$(uname -m)"
case "$ARCH" in
  arm64)  GULP_TARGET="vscode-darwin-arm64"; OUT_DIR="VSCode-darwin-arm64"; EXPECT_NODE_ARCH="arm64" ;;
  x86_64) GULP_TARGET="vscode-darwin-x64";   OUT_DIR="VSCode-darwin-x64";   EXPECT_NODE_ARCH="x64"  ;;
  *) echo "Unsupported arch: $ARCH"; exit 1 ;;
esac

cd "$VSCODE_DIR"

# Guard against the Rosetta arch-mismatch that crashes esbuild/tsgo mid-build.
# (Run from inside the checkout; tolerate a missing glob under `set -e -o pipefail`.)
NODE_ARCH="$(node -p 'process.arch')"
if [ "$NODE_ARCH" != "$EXPECT_NODE_ARCH" ]; then
  echo "[build] ERROR: host is $ARCH but Node arch is '$NODE_ARCH' (Rosetta mismatch)."
  echo "[build] Use a native arm64 Node and reinstall deps, then retry. See docs/M0-RUNBOOK.md."
  exit 1
fi
# The installed esbuild binary must match too (it's the first thing to crash if not).
ESBUILD_PKGS=""
if compgen -G "node_modules/@esbuild/*" > /dev/null 2>&1; then
  ESBUILD_PKGS="$(for d in node_modules/@esbuild/*/; do basename "$d"; done | tr '\n' ' ')"
fi
if [ -n "$ESBUILD_PKGS" ] && ! echo "$ESBUILD_PKGS" | grep -q "darwin-${EXPECT_NODE_ARCH}"; then
  echo "[build] ERROR: installed esbuild is '${ESBUILD_PKGS}', but this build needs darwin-${EXPECT_NODE_ARCH}."
  echo "[build] Your node_modules were installed under a different arch (Rosetta)."
  echo "[build] Fix:  cd vscode && rm -rf node_modules && npm ci --python=\$(which python3)"
  exit 1
fi

echo "[build] Compiling production build for $ARCH …"
npm run gulp -- "$GULP_TARGET"

APP_PARENT="$(cd "$VSCODE_DIR/.." && pwd)"
BUILT_APP="$APP_PARENT/$OUT_DIR"

# The .app inside is named from product.json nameLong -> "Atom++.app".
echo "[build] Done."
echo "[build] Output folder: $BUILT_APP"
echo "[build] Look for Atom++.app inside it."
echo
echo "If macOS blocks the unsigned app, clear the quarantine flag:"
echo "  xattr -dr com.apple.quarantine \"$BUILT_APP/Atom++.app\""
