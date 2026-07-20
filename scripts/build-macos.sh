#!/usr/bin/env bash
#
# Build LevelCode.app for macOS from the branded Code-OSS checkout.
# Produces an unsigned .app in ../VSCode-darwin-<arch>/ (renamed to LevelCode.app).
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

# Target arch -> gulp target. First arg (arm64|x64) overrides the host arch so you can produce the
# Intel build too — best run on a native x64 machine / CI runner (cross-building x64 from Apple
# silicon needs the x64 toolchain installed). Defaults to the host arch.
HOST_ARCH="$(uname -m)"
ARCH="${1:-$HOST_ARCH}"
case "$ARCH" in
  arm64|aarch64)    ARCH="arm64"; GULP_TARGET="vscode-darwin-arm64"; OUT_DIR="VSCode-darwin-arm64" ;;
  x64|x86_64|amd64) ARCH="x64";   GULP_TARGET="vscode-darwin-x64";   OUT_DIR="VSCode-darwin-x64"  ;;
  *) echo "Unsupported target arch: $ARCH (use arm64 or x64)"; exit 1 ;;
esac
# The Rosetta guard below is a HOST check (node must run native), independent of the build target.
case "$HOST_ARCH" in
  arm64)  EXPECT_NODE_ARCH="arm64" ;;
  x86_64) EXPECT_NODE_ARCH="x64"  ;;
  *) echo "Unsupported host arch: $HOST_ARCH"; exit 1 ;;
esac

cd "$VSCODE_DIR"

# Guard against the Rosetta arch-mismatch that crashes esbuild/tsgo mid-build.
# (Run from inside the checkout; tolerate a missing glob under `set -e -o pipefail`.)
NODE_ARCH="$(node -p 'process.arch')"
if [ "$NODE_ARCH" != "$EXPECT_NODE_ARCH" ]; then
  echo "[build] ERROR: host is $HOST_ARCH but Node arch is '$NODE_ARCH' (Rosetta mismatch)."
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

# Stamp the shipped product.json with the LevelCode *release* commit, not the Code-OSS clone's.
# gulp's getVersion() prefers $BUILD_SOURCEVERSION when it's a full 40-hex sha; otherwise it falls back
# to vscode/.git HEAD — the pinned upstream Code-OSS commit, which is IDENTICAL for every LevelCode build
# from tag $VSCODE_TAG. A shared commit across releases breaks the self-update up-to-date check
# (GET /api/update/:target/:quality/:commit compares this exact value), so the app can never tell one
# LevelCode release from the next. Use the LevelCode repo HEAD → each release reports a distinct commit;
# set the same sha as the release's `commit` in the thin.ly update feed (LEVELCODE_UPDATE_FEED).
if LC_COMMIT="$(git -C "$ROOT_DIR" rev-parse HEAD 2>/dev/null)" && [ "${#LC_COMMIT}" -eq 40 ]; then
  export BUILD_SOURCEVERSION="$LC_COMMIT"
  echo "[build] Stamping product.json commit = $LC_COMMIT (LevelCode repo HEAD)."
else
  echo "[build] WARN: could not resolve a 40-char LevelCode repo commit — product.json will fall back to"
  echo "[build]       the Code-OSS clone commit, which is shared across releases (breaks self-update)."
fi

echo "[build] Compiling production build for $ARCH …"
npm run gulp -- "$GULP_TARGET"

APP_PARENT="$(cd "$VSCODE_DIR/.." && pwd)"
BUILT_APP="$APP_PARENT/$OUT_DIR"

# De-Microsoft: strip the proprietary Copilot/MS packages from the BUILT APP — NOT the source checkout,
# so dev-mode typecheck (run-dev.sh → tsgo) still sees the real type declarations. Removes ~120 MB of
# non-redistributable code from the shipped bundle. Idempotent + loud.
echo "[build] Stripping bundled proprietary packages from the app (de-Microsoft) …"
node "$SCRIPT_DIR/strip-proprietary.mjs" "$BUILT_APP/LevelCode.app/Contents/Resources/app"

# Hide not-yet-ready features from the public build (LevelCode Sync — its managed host isn't deployed).
# Source keeps it for dev + the future Pro release; only the shipped .app loses the surfaces.
echo "[build] Hiding not-yet-ready features from the app (LevelCode Sync) …"
node "$SCRIPT_DIR/strip-unreleased.mjs" "$BUILT_APP/LevelCode.app/Contents/Resources/app"

# Stamp the LevelCode RELEASE version for anything a human reads (update tooltip, About). product.json
# `version` deliberately stays the Code-OSS base — it is what extensions' engines.vscode is validated
# against — so the release version rides ALONGSIDE it rather than replacing it. Without this the update
# UI reports "1.126.0", the upstream base, next to a LevelCode commit. See stamp-levelcode-version.mjs.
# Tag-derived. NOTE the deliberate absence of --abbrev=0: at the exact tag (what CI checks out for a
# release) `describe` returns a clean "v0.8.0", but OFF the tag it returns "v0.8.0-1-g404ef20". With
# --abbrev=0 a dev build five commits past a release stamps a bare "0.8.0" and impersonates it in the
# UI; the suffix makes such a build self-identifying. A checkout with no reachable tag skips the stamp
# entirely and the UI falls back to `version`.
# %cI is the COMMITTER date on purpose: "Released" means when this build's commit landed, not when the
# work was originally written — a cherry-picked commit's author date can predate the release by weeks.
if LC_VERSION="$(git -C "$ROOT_DIR" describe --tags 2>/dev/null)" && [ -n "$LC_VERSION" ]; then
  LC_DATE="$(git -C "$ROOT_DIR" log -1 --format=%cI HEAD 2>/dev/null || true)"
  echo "[build] Stamping the LevelCode release version ($LC_VERSION) …"
  node "$SCRIPT_DIR/stamp-levelcode-version.mjs" \
    "$BUILT_APP/LevelCode.app/Contents/Resources/app" "$LC_VERSION" "$LC_DATE"
else
  echo "[build] WARN: no reachable git tag — skipping the release-version stamp. The update UI will"
  echo "[build]       show the Code-OSS base version instead of a LevelCode one."
fi

# The .app inside is named from product.json nameLong -> "LevelCode.app".
echo "[build] Done."
echo "[build] Output folder: $BUILT_APP"
echo "[build] Look for LevelCode.app inside it."
echo "[build] Note: quit any already-running LevelCode before launching this app"
echo "[build]       (macOS can forward launch to the existing process, so you might"
echo "[build]       end up in an older instance with missing LevelCode AI commands)."
echo
echo "If macOS blocks the unsigned app, clear the quarantine flag:"
echo "  xattr -dr com.apple.quarantine \"$BUILT_APP/LevelCode.app\""
