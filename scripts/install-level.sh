#!/usr/bin/env bash
#
# Symlink the `level` launcher onto your PATH so you can run it from anywhere.
#   ./scripts/install-level.sh                 # links into /usr/local/bin (may need sudo)
#   ./scripts/install-level.sh ~/bin/level      # or any writable dir already on your PATH
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$SCRIPT_DIR/level"
DEST="${1:-/usr/local/bin/level}"

chmod +x "$SRC"
mkdir -p "$(dirname "$DEST")" 2>/dev/null || true

if ln -sf "$SRC" "$DEST" 2>/dev/null; then
	echo "Linked:  $DEST -> $SRC"
	echo "Try it:  level ."
else
	echo "Couldn't write '$DEST'. Either run with sudo:" >&2
	echo "    sudo ln -sf \"$SRC\" \"$DEST\"" >&2
	echo "or install to a writable dir on your PATH, e.g.:" >&2
	echo "    ./scripts/install-level.sh \"\$HOME/bin/level\"   (then ensure ~/bin is on PATH)" >&2
	exit 1
fi
