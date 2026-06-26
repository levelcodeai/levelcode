#!/usr/bin/env bash
#
# Atom++ M0 bootstrap — clone a pinned Code-OSS, apply Atom++ branding, install deps.
# Safe to re-run. Run this on your Mac (the build that produces a .app must be native).
#
# Usage:
#   ./scripts/bootstrap.sh                # uses pinned tag below
#   VSCODE_TAG=1.124.0 ./scripts/bootstrap.sh   # override the tag
#
set -euo pipefail

# --- config -----------------------------------------------------------------
# Pin to a known-good upstream tag. Override with VSCODE_TAG=... if this tag
# ever 404s or you want to track a newer release.
VSCODE_TAG="${VSCODE_TAG:-1.126.0}"
REPO_URL="https://github.com/microsoft/vscode.git"

# --- paths ------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
VSCODE_DIR="$ROOT_DIR/vscode"

bold() { printf "\033[1m%s\033[0m\n" "$*"; }
info() { printf "\033[36m[bootstrap]\033[0m %s\n" "$*"; }
err()  { printf "\033[31m[bootstrap] %s\033[0m\n" "$*" >&2; }

# --- preflight --------------------------------------------------------------
bold "Atom++ bootstrap — Code-OSS @ ${VSCODE_TAG}"

command -v git  >/dev/null || { err "git not found"; exit 1; }
command -v node >/dev/null || { err "node not found — install Node 24 (nvm/nodenv recommended)"; exit 1; }

# Node: Code-OSS pins an exact version in .nvmrc (checked again after clone).
# Up front we require at least Node 22 — older majors fail to compile native modules.
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 22 ]; then
  err "Node $(node -v) detected; this Code-OSS tag needs Node 22+ (it pins 24.x in .nvmrc)."
  err "  nodenv:  nodenv install 24.15.0 && nodenv local 24.15.0"
  err "  nvm:     nvm install 24 && nvm use 24"
  exit 1
fi

# Arch consistency: native modules (esbuild, tsgo) are arch-specific. If Node's arch
# doesn't match the host CPU, you're in Rosetta and the install will produce x64
# binaries that crash under arm64 (or vice versa). Catch it before the slow npm ci.
HOST_ARCH="$(uname -m)"   # arm64 or x86_64
case "$HOST_ARCH" in
  arm64)  EXPECT_NODE_ARCH="arm64" ;;
  x86_64) EXPECT_NODE_ARCH="x64"   ;;
  *)      EXPECT_NODE_ARCH="" ;;
esac
NODE_ARCH="$(node -p 'process.arch')"
if [ -n "$EXPECT_NODE_ARCH" ] && [ "$NODE_ARCH" != "$EXPECT_NODE_ARCH" ]; then
  err "Architecture mismatch: host is ${HOST_ARCH} but Node reports arch '${NODE_ARCH}'."
  err "You're almost certainly in a Rosetta shell. Native modules will be built for the"
  err "wrong arch and crash later (esbuild/tsgo 'wrong platform' or 'exited with code unknown')."
  err "Fix: open a NATIVE arm64 Terminal (Get Info > uncheck 'Open using Rosetta'),"
  err "     reinstall Node there (nodenv uninstall -f ${WANT_NODE:-24.15.0} && nodenv install ${WANT_NODE:-24.15.0}),"
  err "     then re-run this script. 'arch' must print arm64 and 'node -p process.arch' must match."
  exit 1
fi
info "Arch OK: host ${HOST_ARCH} / node ${NODE_ARCH} ✓"

# Python: node-gyp's bundled gyp uses the := walrus operator -> needs Python >= 3.8.
# Honor a PYTHON override (npm/node-gyp read it too).
PYBIN="${PYTHON:-python3}"
if ! command -v "$PYBIN" >/dev/null; then
  err "python3 not found — node-gyp needs it. On macOS: 'xcode-select --install'."
  exit 1
fi
PY_OK="$("$PYBIN" -c 'import sys; print(1 if sys.version_info[:2] >= (3,8) else 0)' 2>/dev/null || echo 0)"
if [ "$PY_OK" != "1" ]; then
  err "Active python is $("$PYBIN" --version 2>&1) — node-gyp needs Python >= 3.8."
  err "You appear to use pyenv; pick a newer interpreter, e.g.:"
  err "  pyenv install 3.12.4 && pyenv local 3.12.4      # in this folder"
  err "  # or point this build at the system python without changing pyenv:"
  err "  PYTHON=/usr/bin/python3 ./scripts/bootstrap.sh"
  exit 1
fi
export PYTHON="$PYBIN"  # node-gyp picks this up for the npm ci step

# --- clone (shallow, pinned) ------------------------------------------------
if [ -d "$VSCODE_DIR/.git" ]; then
  info "vscode/ already exists — fetching tag ${VSCODE_TAG}"
  git -C "$VSCODE_DIR" fetch --depth 1 origin "refs/tags/${VSCODE_TAG}:refs/tags/${VSCODE_TAG}"
  git -C "$VSCODE_DIR" checkout -f "tags/${VSCODE_TAG}"
else
  info "Cloning Code-OSS (shallow) at ${VSCODE_TAG}"
  git clone --depth 1 --branch "${VSCODE_TAG}" "$REPO_URL" "$VSCODE_DIR"
fi

# Record what we pinned to (handy for rebases later).
echo "${VSCODE_TAG}" > "$ROOT_DIR/.vscode-pinned-tag"

# Exact Node check against the checkout's .nvmrc (more precise than the major check).
if [ -f "$VSCODE_DIR/.nvmrc" ]; then
  WANT_NODE="$(tr -d '[:space:]' < "$VSCODE_DIR/.nvmrc")"
  WANT_MAJOR="${WANT_NODE%%.*}"
  if [ "$NODE_MAJOR" != "$WANT_MAJOR" ]; then
    err "This tag's .nvmrc wants Node ${WANT_NODE} (major ${WANT_MAJOR}); you have $(node -v)."
    err "  nodenv install ${WANT_NODE} && nodenv local ${WANT_NODE}"
    err "  # then re-run ./scripts/bootstrap.sh (downloads are cached, so it's fast)"
    exit 1
  fi
  info "Node $(node -v) matches .nvmrc (${WANT_NODE}) ✓"
fi

# --- apply branding ---------------------------------------------------------
info "Applying Atom++ branding overlay"
node "$SCRIPT_DIR/apply-branding.mjs" "$VSCODE_DIR"

# --- install deps -----------------------------------------------------------
info "Installing dependencies (this is the slow part — several minutes)"
info "Using Python: $("$PYTHON" --version 2>&1) at $(command -v "$PYTHON")"
( cd "$VSCODE_DIR" && npm ci --python="$PYTHON" )

bold "Bootstrap complete."
echo "Next:"
echo "  ./scripts/run-dev.sh      # launch Atom++ from source to sanity-check"
echo "  ./scripts/build-macos.sh  # produce Atom++.app"
