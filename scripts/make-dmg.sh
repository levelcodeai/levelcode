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

ARCH="$(uname -m)"
case "$ARCH" in
  arm64)  OUT_DIR="VSCode-darwin-arm64" ;;
  x86_64) OUT_DIR="VSCode-darwin-x64"  ;;
  *) echo "[make-dmg] Unsupported arch: $ARCH"; exit 1 ;;
esac

APP="$OUT_DIR/Atom++.app"
if [ ! -d "$APP" ]; then
  echo "[make-dmg] ERROR: $APP not found. Run ./scripts/build-macos.sh first."
  exit 1
fi

VOL_NAME="Atom++"
DMG_OUT="$ROOT_DIR/Atom++-$ARCH.dmg"

# 1. Ad-hoc sign the whole bundle (inside-out via --deep). Required for arm64 to run at all.
echo "[make-dmg] Ad-hoc signing $APP …"
codesign --remove-signature "$APP" 2>/dev/null || true
codesign --force --deep --sign - "$APP"
echo "[make-dmg] Verifying signature …"
codesign --verify --deep --strict "$APP" && echo "[make-dmg]   signature OK"

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

SIZE="$(du -sh "$DMG_OUT" | cut -f1)"
echo "[make-dmg] Done."
echo "[make-dmg]   Output: $DMG_OUT  ($SIZE)"
echo "[make-dmg]   Upload this single file. On the other Mac: open the dmg, drag Atom++ to"
echo "[make-dmg]   Applications, then right-click > Open the first time (it's unnotarized)."
