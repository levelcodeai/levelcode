#!/usr/bin/env bash
#
# Package the built LevelCode.app into a single distributable .dmg disk image.
#
# An .app is actually a *folder* of thousands of files — cloud drives upload it as
# loose files and it can't be "installed". A .dmg wraps the whole app into one
# compressed file you can upload, download, and drag-to-install.
#
# It operates on VSCode-darwin-<arch>/LevelCode.app (run ./scripts/build-macos.sh first).
# Steps below are numbered to match the `# N.` markers in the script body:
#   0. De-Microsoft the bundle + hide not-yet-ready features, before signing covers the result.
#   1. Sign the app. Ad-hoc by default (arm64 macOS refuses to launch *unsigned* binaries at all);
#      with CODESIGN_IDENTITY set, real Developer ID signing + notarize + staple.
#   2. Stage a clean folder: the app + an /Applications symlink.
#   3. Build the compressed .dmg from it.
#   4. Developer ID path only — sign, notarize + staple the .dmg itself.
#   5. Developer ID path only — emit LevelCode-<arch>.app.zip, the auto-update feed asset the
#      built-in Squirrel updater installs. See docs/AUTO-UPDATE.md.
#
# Gatekeeper: on the DEFAULT (ad-hoc) path the result is UNNOTARIZED, so on another Mac Gatekeeper
# warns on first launch:
#   - Right-click the app > Open (once), OR
#   - clear quarantine after copying out of the dmg:
#       xattr -dr com.apple.quarantine "/Applications/LevelCode.app"
# With CODESIGN_IDENTITY set, steps 1 + 4 notarize and staple both the app and the dmg — a plain
# double-click then works on any Mac, offline, with no warning.
#
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"

# Target arch: first arg (arm64|x64) overrides the host arch (match build-macos.sh). Arch is
# normalized to arm64|x64 so the output is LevelCode-arm64.dmg / LevelCode-x64.dmg — the EXACT filenames
# the download funnel (levelcode.ai/download/<arch>) and the site link to. Do not emit "x86_64" here.
ARCH="${1:-$(uname -m)}"
case "$ARCH" in
  arm64|aarch64)    ARCH="arm64"; OUT_DIR="VSCode-darwin-arm64" ;;
  x64|x86_64|amd64) ARCH="x64";   OUT_DIR="VSCode-darwin-x64"  ;;
  *) echo "[make-dmg] Unsupported arch: $ARCH (use arm64 or x64)"; exit 1 ;;
esac

APP="$OUT_DIR/LevelCode.app"
if [ ! -d "$APP" ]; then
  echo "[make-dmg] ERROR: $APP not found. Run ./scripts/build-macos.sh first."
  exit 1
fi

VOL_NAME="LevelCode"
DMG_OUT="$ROOT_DIR/LevelCode-$ARCH.dmg"

# 0. De-Microsoft + hide not-yet-ready features (LevelCode Sync) before we sign + ship it (idempotent —
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
  echo "[make-dmg] Developer ID signing + notarizing the app (will sign + notarize the .dmg after) …"
  "$SCRIPT_DIR/notarize.sh" sign "$APP"
  # Notarize + staple the APP *before* it goes into the dmg, so an app dragged out to
  # /Applications launches offline on first run. The dmg gets its own ticket below, but a
  # dmg's stapled ticket does NOT travel with the app once it's copied out.
  "$SCRIPT_DIR/notarize.sh" notarize-app "$APP"
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

# 4. Sign, notarize + staple the .dmg (only when Developer ID signing was used). Signing the
# disk image itself (before notarizing) makes it tamper-evident and lets Gatekeeper/spctl anchor
# the "Notarized Developer ID" verdict on the dmg, not just the app inside — an UNsigned dmg is
# still notarizable, but reports "no usable signature" under `spctl -t open`.
if [ "$NOTARIZE" = "1" ]; then
  echo "[make-dmg] Code-signing the .dmg (Developer ID) …"
  codesign --force --timestamp --sign "$CODESIGN_IDENTITY" "$DMG_OUT"
  "$SCRIPT_DIR/notarize.sh" submit "$DMG_OUT"
fi

# 5. Squirrel update asset — a .zip of the SIGNED + NOTARIZED + STAPLED .app.
# The built-in updater (Squirrel.Mac) installs from a .zip, never a .dmg, and refuses an update whose
# Developer ID doesn't match the running app — so this is produced ONLY on the signed path; an ad-hoc
# build must never masquerade as an update asset. Use `ditto` (not `zip`): it preserves the stapled
# notarization ticket, so the updated app still validates offline. Feed + rollout: docs/AUTO-UPDATE.md.
#
# The `.sha256` sidecar is LOCAL ONLY — do not upload it as a release asset. The update feed reads the
# hash from GitHub's own API-computed asset `digest` ("sha256:<hex>"), not from a sidecar file; see
# Levelcode::EditorReleaseFeed#build_assets in thin.ly. It exists so a releaser can verify by hand
# that the zip they published is the zip they built.
ZIP_OUT=""
if [ "$NOTARIZE" = "1" ]; then
  ZIP_OUT="$ROOT_DIR/LevelCode-$ARCH.app.zip"
  echo "[make-dmg] Creating the signed update asset (Squirrel .zip) …"
  rm -f "$ZIP_OUT" "$ZIP_OUT.sha256"
  ditto -c -k --sequesterRsrc --keepParent "$APP" "$ZIP_OUT"
  shasum -a 256 "$ZIP_OUT" | cut -d' ' -f1 > "$ZIP_OUT.sha256"
fi

SIZE="$(du -sh "$DMG_OUT" | cut -f1)"
echo "[make-dmg] Done."
echo "[make-dmg]   Output: $DMG_OUT  ($SIZE)"
if [ "$NOTARIZE" = "1" ]; then
  echo "[make-dmg]   Signed + notarized — upload it; users just open the dmg and drag to Applications."
  echo "[make-dmg]   Update asset: $ZIP_OUT  ($(du -sh "$ZIP_OUT" | cut -f1))"
  echo "[make-dmg]   sha256: $(cat "$ZIP_OUT.sha256")  (local check only — the feed uses GitHub's own digest)"
  echo "[make-dmg]   Upload EXACTLY these two: the .dmg (fresh installs) and the .app.zip (auto-update"
  echo "[make-dmg]   feed). The .sha256 stays local — uploading it is harmless but pointless."
else
  echo "[make-dmg]   Upload this single file. On the other Mac: open the dmg, drag LevelCode to"
  echo "[make-dmg]   Applications, then right-click > Open the first time (it's unnotarized)."
fi
