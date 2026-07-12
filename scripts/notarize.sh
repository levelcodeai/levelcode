#!/usr/bin/env bash
#
# LevelCode — Developer ID signing + Apple notarization for the packaged .app / .dmg.
#
# Notarization requires a paid Apple Developer Program membership and a
# "Developer ID Application" certificate in your login keychain. It turns the scary
# Gatekeeper prompt into a plain double-click-to-open for everyone who downloads the app.
#
# ── One-time setup ──────────────────────────────────────────────────────────────────────
#   1. Install the cert: Xcode > Settings > Accounts > Manage Certificates > + >
#      "Developer ID Application" (or developer.apple.com > Certificates). Confirm:
#        security find-identity -v -p codesigning        # note the exact "Developer ID Application: …" line
#   2. Save notary credentials ONCE (a keychain profile so you never paste the password again):
#        xcrun notarytool store-credentials "levelcode-notary" \
#          --apple-id "you@example.com" --team-id "TEAMID" --password "<app-specific-password>"
#      (App-specific password: appleid.apple.com > Sign-In & Security > App-Specific Passwords.)
#
# ── Usage ───────────────────────────────────────────────────────────────────────────────
#   Normally you don't call this directly — make-dmg.sh runs it when CODESIGN_IDENTITY is set:
#     CODESIGN_IDENTITY="Developer ID Application: Your Name (TEAMID)" NOTARY_PROFILE="levelcode-notary" \
#       ./scripts/make-dmg.sh
#
#   Or by hand:
#     CODESIGN_IDENTITY="Developer ID Application: Your Name (TEAMID)" scripts/notarize.sh sign  VSCode-darwin-arm64/LevelCode.app
#     NOTARY_PROFILE="levelcode-notary"                                    scripts/notarize.sh submit LevelCode-arm64.dmg
#
# ── Config (env) ────────────────────────────────────────────────────────────────────────
#   CODESIGN_IDENTITY   (sign)   the "Developer ID Application: …" identity string
#   ENTITLEMENTS        (sign)   optional; defaults to scripts/levelcode.entitlements
#   NOTARY_PROFILE      (submit) notarytool keychain profile from store-credentials
#     — or, for CI without a stored profile —
#   APPLE_ID + TEAM_ID + APP_SPECIFIC_PASSWORD
#
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENTITLEMENTS="${ENTITLEMENTS:-$SCRIPT_DIR/levelcode.entitlements}"

die() { echo "[notarize] ERROR: $*" >&2; exit 1; }

sign_app() {
  local APP="$1"
  [ -d "$APP" ] || die "app not found: $APP"
  [ -n "${CODESIGN_IDENTITY:-}" ] || die "set CODESIGN_IDENTITY to your 'Developer ID Application: …' identity (see: security find-identity -v -p codesigning)"
  [ -f "$ENTITLEMENTS" ] || die "entitlements not found: $ENTITLEMENTS"
  command -v codesign >/dev/null || die "codesign not found (install Xcode command line tools)"
  echo "[notarize] Signing $APP"
  echo "[notarize]   identity: $CODESIGN_IDENTITY"

  # Inside-out: sign the deepest code first, and seal each *bundle* only AFTER its nested
  # code is signed — otherwise codesign fails with "In subcomponent: …: code object is not
  # signed at all". Order below: loose nested Mach-O → helper .apps → frameworks → the app.
  #
  # CRITICAL: skip every bundle *main executable* in this leaf pass — the .app/helper main
  # binaries (…/Contents/MacOS/…) AND each framework's main binary (…/Foo.framework/Versions/
  # <v>/Foo). Signing a bundle's main executable seals that whole bundle, so signing one here
  # would seal the enclosing .app / .framework before its nested code (helpers, dylibs, the
  # crashpad handler) is signed. Those bundles are sealed explicitly further down, which signs
  # their main executable for us. This latent ordering bug was masked on arm64 — whose nested
  # binaries arrive already (ad-hoc) signed, so the premature seal happened to pass — but it
  # broke on an unsigned Intel (x64) build ("In subcomponent: …/Electron Framework").
  # (Uses `file` so nothing is missed; this pass takes a minute on a full app.)
  echo "[notarize]   signing nested binaries …"
  while IFS= read -r -d '' f; do
    b="${f##*/}"; d="${f%/*}"                                   # basename / dirname (no subprocess)
    case "$f" in */Contents/MacOS/*) continue ;; esac           # .app / helper .app main executable
    case "$d" in */"$b".framework/Versions/*) continue ;; esac  # …/Foo.framework/Versions/A/Foo main binary
    if file -b "$f" | grep -q "Mach-O"; then
      codesign --force --timestamp --options runtime --sign "$CODESIGN_IDENTITY" "$f"
    fi
  done < <(find "$APP" -type f -print0)

  # Electron helper .app bundles (renderer / GPU / plugin) need the entitlements too.
  while IFS= read -r -d '' h; do
    echo "[notarize]   signing helper: $(basename "$h")"
    codesign --force --timestamp --options runtime --entitlements "$ENTITLEMENTS" --sign "$CODESIGN_IDENTITY" "$h"
  done < <(find "$APP/Contents/Frameworks" -maxdepth 1 -name "*.app" -print0 2>/dev/null)

  # Framework bundles.
  while IFS= read -r -d '' fw; do
    codesign --force --timestamp --options runtime --sign "$CODESIGN_IDENTITY" "$fw"
  done < <(find "$APP/Contents/Frameworks" -maxdepth 1 -name "*.framework" -print0 2>/dev/null)

  # The outer app last, with entitlements — this is what carries the hardened runtime for the main process.
  echo "[notarize]   signing the app bundle …"
  codesign --force --timestamp --options runtime --entitlements "$ENTITLEMENTS" --sign "$CODESIGN_IDENTITY" "$APP"

  echo "[notarize]   verifying …"
  codesign --verify --deep --strict --verbose=2 "$APP"
  echo "[notarize]   signature OK"
}

submit_dmg() {
  local DMG="$1"
  [ -f "$DMG" ] || die "dmg not found: $DMG"
  command -v xcrun >/dev/null || die "xcrun not found (install Xcode command line tools)"
  echo "[notarize] Submitting $DMG to Apple's notary service (a few minutes) …"
  if [ -n "${NOTARY_PROFILE:-}" ]; then
    xcrun notarytool submit "$DMG" --keychain-profile "$NOTARY_PROFILE" --wait
  elif [ -n "${APPLE_ID:-}" ] && [ -n "${TEAM_ID:-}" ] && [ -n "${APP_SPECIFIC_PASSWORD:-}" ]; then
    xcrun notarytool submit "$DMG" --apple-id "$APPLE_ID" --team-id "$TEAM_ID" --password "$APP_SPECIFIC_PASSWORD" --wait
  else
    die "set NOTARY_PROFILE (from 'xcrun notarytool store-credentials'), or APPLE_ID + TEAM_ID + APP_SPECIFIC_PASSWORD"
  fi
  echo "[notarize] Stapling the ticket onto $DMG …"
  xcrun stapler staple "$DMG"
  xcrun stapler validate "$DMG"
  echo "[notarize] ✅ $DMG is signed, notarized and stapled — opens with a plain double-click."
}

cmd="${1:-}"; [ $# -gt 0 ] && shift || true
case "$cmd" in
  sign)   [ $# -ge 1 ] || die "usage: notarize.sh sign <LevelCode.app>";  sign_app "$1" ;;
  submit) [ $# -ge 1 ] || die "usage: notarize.sh submit <LevelCode.dmg>"; submit_dmg "$1" ;;
  *) echo "usage: $(basename "$0") {sign <LevelCode.app> | submit <LevelCode.dmg>}"; exit 2 ;;
esac
