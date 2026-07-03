#!/usr/bin/env bash
#
# Package the built Atom++.app into a single distributable .dmg disk image.
#
# An .app is actually a *folder* of thousands of files — cloud drives upload it as
# loose files and it can't be "installed". A .dmg wraps the whole app into one
# compressed file you can upload, download, and drag-to-install.
#
# This script:
#   1. Locates VSCode-darwin-<arch>/Atom++.app (run ./scripts/build-macos.sh first).
#   2. Ad-hoc code-signs it. arm64 macOS refuses to launch *unsigned* binaries at all,
#      so even for personal use the app must carry at least an ad-hoc signature.
#   3. Builds a compressed .dmg containing the app + an /Applications symlink.
#
# The result is UNNOTARIZED. On another Mac, Gatekeeper will still warn on first launch:
#   - Right-click the app > Open (once), OR
#   - clear quarantine after copying out of the dmg:
#       xattr -dr com.apple.quarantine "/Applications/Atom++.app"
#
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"

# Target arch: first arg (arm64|x64) overrides the host arch (match build-macos.sh). Arch is
# normalized to arm64|x64 so the output is Atom++-arm64.dmg / Atom++-x64.dmg — the EXACT filenames
# the download funnel (atompp.ai/download/<arch>) and the site link to. Do not emit "x86_64" here.
ARCH="${1:-$(uname -m)}"
case "$ARCH" in
  arm64|aarch64)    ARCH="arm64"; OUT_DIR="VSCode-darwin-arm64" ;;
  x64|x86_64|amd64) ARCH="x64";   OUT_DIR="VSCode-darwin-x64"  ;;
  *) echo "[make-dmg] Unsupported arch: $ARCH (use arm64 or x64)"; exit 1 ;;
esac

APP="$OUT_DIR/Atom++.app"
if [ ! -d "$APP" ]; then
  echo "[make-dmg] ERROR: $APP not found. Run ./scripts/build-macos.sh first."
  exit 1
fi

VOL_NAME="Atom++"
DMG_OUT="$ROOT_DIR/Atom++-$ARCH.dmg"

# 0. De-Microsoft + hide not-yet-ready features (Atom++ Sync) before we sign + ship it (idempotent —
# no-ops if build-macos.sh already did it). Runs BEFORE signing so the signature covers the result.
node "$SCRIPT_DIR/strip-proprietary.mjs" "$APP/Contents/Resources/app"
node "$SCRIPT_DIR/strip-unreleased.mjs" "$APP/Contents/Resources/app"

# 1. Sign the bundle. Two modes:
#    - Distributable: set CODESIGN_IDENTITY to your "Developer ID Application: …" identity (and
#      NOTARY_PROFILE, or APPLE_ID/TEAM_ID/APP_SPECIFIC_PASSWORD) → real signing + Apple notarization,
#      so the app opens with a plain double-click on any Mac.
#    - Default: ad-hoc signing (arm64 refuses to launch unsigned binaries at all). Unnotarized —
#      fine for personal/tester use, Gatekeeper warns on first launch.
NOTARIZE=0
if [ -n "${CODESIGN_IDENTITY:-}" ] && [ "${CODESIGN_IDENTITY}" != "-" ]; then
  echo "[make-dmg] Developer ID signing (will notarize the .dmg after) …"
  "$SCRIPT_DIR/notarize.sh" sign "$APP"
  NOTARIZE=1
else
  echo "[make-dmg] Ad-hoc signing $APP (unnotarized — set CODESIGN_IDENTITY for a distributable build) …"
  codesign --remove-signature "$APP" 2>/dev/null || true
  codesign --force --deep --sign - "$APP"
  echo "[make-dmg] Verifying signature …"
  codesign --verify --deep --strict "$APP" && echo "[make-dmg]   signature OK"
fi

# 2. Stage a clean folder (app + drag-to-Applications shortcut).
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
echo "[make-dmg] Staging disk image contents …"
cp -R "$APP" "$STAGE/"
ln -s /Applications "$STAGE/Applications"

# 3. Build the compressed .dmg.
rm -f "$DMG_OUT"
echo "[make-dmg] Creating compressed .dmg (this takes a minute) …"
hdiutil create \
  -volname "$VOL_NAME" \
  -srcfolder "$STAGE" \
  -fs HFS+ \
  -format UDZO \
  -imagekey zlib-level=9 \
  -ov \
  "$DMG_OUT" >/dev/null

# 4. Notarize + staple the .dmg (only when Developer ID signing was used).
if [ "$NOTARIZE" = "1" ]; then
  "$SCRIPT_DIR/notarize.sh" submit "$DMG_OUT"
fi

SIZE="$(du -sh "$DMG_OUT" | cut -f1)"
echo "[make-dmg] Done."
echo "[make-dmg]   Output: $DMG_OUT  ($SIZE)"
if [ "$NOTARIZE" = "1" ]; then
  echo "[make-dmg]   Signed + notarized — upload it; users just open the dmg and drag to Applications."
else
  echo "[make-dmg]   Upload this single file. On the other Mac: open the dmg, drag Atom++ to"
  echo "[make-dmg]   Applications, then right-click > Open the first time (it's unnotarized)."
fi
