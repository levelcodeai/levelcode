# M0 Runbook — "It builds and it's ours"

Goal: a working **LevelCode.app** on your Mac, branded as LevelCode, with zero Microsoft branding, installing extensions from **Open VSX**. Everything here runs on your Mac, because a native macOS `.app` can't be cross-built from a Linux sandbox.

## 0. Prerequisites (one-time)

The Code-OSS tag pins its toolchain exactly. Two versions matter and the bootstrap script now enforces both:

- **Node = the version in `vscode/.nvmrc`** (currently **24.15.0**). Older Node majors fail to compile native modules.
- **Python ≥ 3.8** for `node-gyp` (its bundled gyp uses the `:=` operator). Python 3.7 crashes with a `SyntaxError`.

```bash
xcode-select --install                       # Apple toolchain + a modern python3

# Node — match .nvmrc. You use nodenv:
nodenv install 24.15.0 && nodenv local 24.15.0
node -v                                       # expect v24.15.0

# Python — you have pyenv pointing at 3.7.2, which is too old. Either:
pyenv install 3.12.4 && pyenv local 3.12.4    # in this folder
# ...or leave pyenv alone and point just this build at system python:
#   PYTHON=/usr/bin/python3 ./scripts/bootstrap.sh
python3 --version                             # expect 3.8+ (3.12 ideal)
```

You also need ~15 GB free disk and a reasonably fast connection (the dependency install is large; npm caches it, so re-runs are fast).

## 1. Bootstrap

From this folder (`levelcode/`):

```bash
chmod +x scripts/*.sh                        # first time only
./scripts/bootstrap.sh
```

This shallow-clones Code-OSS at the pinned tag (currently `1.126.0` — override with `VSCODE_TAG=… ./scripts/bootstrap.sh`), applies the LevelCode branding overlay onto `vscode/product.json` (saving `product.json.vanilla` so you can always diff), and runs `npm ci`. The dependency install is the slow part — expect several minutes.

If the pinned tag ever 404s, pick a real one from https://github.com/microsoft/vscode/tags and pass it via `VSCODE_TAG`.

## 2. Sanity-check from source (fast feedback before a full build)

```bash
./scripts/run-dev.sh
```

This compiles the core and launches the editor from source. Confirm the window title and About box say **LevelCode**, not Code/VS Code. Quit when satisfied.

## 3. Produce the app

```bash
./scripts/build-macos.sh
```

Auto-detects Apple-silicon vs Intel and runs the matching gulp target. Output lands in a sibling folder `vscode/../VSCode-darwin-<arch>/` containing **LevelCode.app**.

The app is **unsigned** in M0 (code-signing + notarization need an Apple Developer ID and come later). To run an unsigned build:

```bash
xattr -dr com.apple.quarantine "../VSCode-darwin-arm64/LevelCode.app"   # adjust arch
open "../VSCode-darwin-arm64/LevelCode.app"
```

## 4. Run the exit test

Walk through [`EXIT-TEST.md`](./EXIT-TEST.md). When every box is checked, M0 is done and we move to **M1 (Notepad++ power-editing pack)**.

## Troubleshooting: Rosetta arch mismatch (most common)

Symptoms: build dies with esbuild `"@esbuild/darwin-x64" package is present but this platform needs "@esbuild/darwin-arm64"`, or `tsgo exited with code unknown`. Cause: deps were installed under Rosetta (x64) but Node now runs native (arm64), or vice versa — the native binaries don't match the CPU.

Fix — make the whole toolchain native arm64 and reinstall once:

```bash
# Use a NATIVE arm64 terminal: Terminal/iTerm > Get Info > uncheck "Open using Rosetta"
arch                         # must print: arm64

cd <repo>/levelcode
nodenv uninstall -f 24.15.0 && nodenv install 24.15.0   # ensures an arm64 build of Node
nodenv local 24.15.0
node -p process.arch         # must print: arm64

cd vscode && rm -rf node_modules && npm ci --python=$(which python3)
cd .. && ./scripts/build-macos.sh                       # now targets darwin-arm64
```

The `bootstrap.sh` and `build-macos.sh` scripts now refuse to run on an arch mismatch and print this fix, so you'll catch it early next time.

## Notes for later (don't do now)

- **Code-signing/notarization:** needs an Apple Developer account ($99/yr). We'll add a `sign-macos.sh` in a later milestone.
- **Rebasing onto a newer Code-OSS:** re-run `bootstrap.sh` with a newer `VSCODE_TAG`. Because branding is an overlay (not edits scattered through source), this stays cheap — the merge logic re-applies cleanly.
- **Icons:** the overlay sets names/ids but still uses stock Code-OSS icons. Swapping in an original LevelCode icon set is a small M0.5 / M3 task (and is gated on choosing the final logo, per `PLAN.md` §2 trademark note).
