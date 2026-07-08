# M0 Exit Test

M0 is complete when **all** of these pass on your Mac. Check them off.

### Build & launch
- [ ] `./scripts/bootstrap.sh` completes with no errors.
- [ ] `./scripts/build-macos.sh` produces **LevelCode.app**.
- [ ] LevelCode.app launches and opens a folder.

### It's ours, not Microsoft's
- [ ] Window title / Dock / `About` all read **LevelCode** (no "Visual Studio Code" / "Code - OSS").
- [ ] Bundle identifier is `net.systemu.levelcode` (verify: `mdls -name kMDItemCFBundleIdentifier LevelCode.app`).
- [ ] Telemetry is off by default (Settings shows no MS telemetry; `enableTelemetry` is `false` in `vscode/product.json`).
- [ ] Custom URL protocol works conceptually: `product.json` `urlProtocol` is `levelcode`.

### Open VSX, not the MS marketplace
- [ ] Extensions view loads results from **Open VSX** (search e.g. "Python" returns results; the gallery URL in `product.json` points at `open-vsx.org`).
- [ ] Installing one extension from Open VSX succeeds and it activates.

### Hygiene
- [ ] `vscode/product.json.vanilla` exists (pristine upstream copy for diffing).
- [ ] `.vscode-pinned-tag` records the upstream version we built from.
- [ ] `git status` in this repo shows the `vscode/` checkout is gitignored (not accidentally committed).

When everything above is checked: **M0 done.** Next is M1 — the Notepad++ power-editing pack (macros, big-file mode, encoding/EOL, column extras).
