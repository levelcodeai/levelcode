#!/usr/bin/env bash
#
# Build the Atom++ macOS app icon (.icns) from a source PNG, using macOS built-ins
# (sips + iconutil) — no dependencies. Squares the image (black padding) if needed,
# then emits all required iconset sizes and assembles code.icns.
#
# Usage:
#   ./scripts/make-icon.sh [path/to/source.png]
#   (defaults to branding/icons/atom-plus-plus-source.png)
#
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ICONS_DIR="$ROOT_DIR/branding/icons"
SRC="${1:-$ICONS_DIR/atom-plus-plus-source.png}"
OUT_ICNS="$ICONS_DIR/atom-plus-plus.icns"
OUT_PNG="$ICONS_DIR/atom-plus-plus-1024.png"   # for Linux builds

command -v sips >/dev/null     || { echo "sips not found (run on macOS)"; exit 1; }
command -v iconutil >/dev/null || { echo "iconutil not found (run on macOS)"; exit 1; }
[ -f "$SRC" ] || { echo "Source PNG not found: $SRC
Save your icon there (or pass a path) and re-run."; exit 1; }

mkdir -p "$ICONS_DIR"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

cp "$SRC" "$TMP/master.png"

# Square the image with black padding (no distortion), then normalize to 1024².
W="$(sips -g pixelWidth  "$TMP/master.png" | awk '/pixelWidth/{print $2}')"
H="$(sips -g pixelHeight "$TMP/master.png" | awk '/pixelHeight/{print $2}')"
S=$(( W > H ? W : H ))
if [ "$W" != "$H" ]; then
  echo "[make-icon] Source is ${W}x${H}; padding to ${S}x${S} (black) to square it."
  sips --padToHeightWidth "$S" "$S" --padColor 000000 "$TMP/master.png" >/dev/null
fi
sips -z 1024 1024 "$TMP/master.png" >/dev/null
cp "$TMP/master.png" "$OUT_PNG"

# Build the .iconset with the exact names iconutil expects.
ICONSET="$TMP/atom.iconset"; mkdir -p "$ICONSET"
gen() { sips -z "$1" "$1" "$TMP/master.png" --out "$ICONSET/$2" >/dev/null; }
gen 16   icon_16x16.png
gen 32   icon_16x16@2x.png
gen 32   icon_32x32.png
gen 64   icon_32x32@2x.png
gen 128  icon_128x128.png
gen 256  icon_128x128@2x.png
gen 256  icon_256x256.png
gen 512  icon_256x256@2x.png
gen 512  icon_512x512.png
gen 1024 icon_512x512@2x.png

iconutil -c icns "$ICONSET" -o "$OUT_ICNS"
echo "[make-icon] Wrote $OUT_ICNS"

# Apply into the Code-OSS checkout right away (apply-branding also does this on rebuild).
if [ -d "$ROOT_DIR/vscode/resources/darwin" ]; then
  cp "$OUT_ICNS" "$ROOT_DIR/vscode/resources/darwin/code.icns"
  echo "[make-icon] Installed into vscode/resources/darwin/code.icns"
fi

echo "[make-icon] Done. Rebuild with ./scripts/build-macos.sh to see the new app icon."
