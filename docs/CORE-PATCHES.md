# LevelCode — Core Patches Log

Changes we make **inside** the Code-OSS source (`vscode/`) rather than in our bundled
extension. Keep this list short and every patch tagged with a searchable `[LevelCode]`
comment in the code, so a rebase onto a newer Code-OSS tag is easy to re-apply/verify.

## How our code survives (reproducibility)

`vscode/` is **gitignored** — it's a disposable clone produced by `bootstrap.sh`. Everything
that is *ours* lives in the tracked repo and is re-installed onto a clean clone:

- **Branding** → `branding/product.overlay.json` (+ `branding/icons/`), applied by `apply-branding.mjs`.
- **Extensions** → `extensions/levelcode-npp-pack/`, `extensions/levelcode-ai/` are the **canonical source**;
  `apply-branding.mjs` copies them into `vscode/extensions/`. Edit them *here*, not in `vscode/`.
- **Core source edits** → captured as `patches/levelcode-core.patch`; `bootstrap.sh` applies it
  (`git apply --3way`) onto the fresh checkout.

So a full rebuild from nothing is: `bootstrap.sh` (clone + brand + extensions + patches) → `build-macos.sh`.

To re-create the core patch after changing core files in `vscode/`:

```bash
git -C vscode diff -- \
  src/vs/workbench/contrib/files/browser/files.contribution.ts \
  build/lib/extensions.ts build/lib/copilot.ts > patches/levelcode-core.patch
```

To find every core touch in the checkout:

```bash
grep -rn "\[LevelCode\]" vscode/src vscode/build
```

## Patches

| # | File | Change | Why |
| --- | --- | --- | --- |
| 1 | `src/vs/workbench/contrib/files/browser/files.contribution.ts` | `files.hotExit` default → `onExitAndWindowClose` (was `onExit`) | Sublime-style persistence by default. `files.hotExit` is application-scoped, which extensions are forbidden from overriding (only machine-overridable/window/resource/language-overridable defaults may be set by extensions), so this must be a core default. |
| 2 | `build/lib/extensions.ts` (`packageCopilotExtensionStream`) | Return an empty stream — don't bundle the GitHub Copilot Chat extension. | Copilot Chat is **proprietary, not MIT**; redistributing it in a non-Microsoft product isn't permitted, and its from-source packaging is fragile (missing `shims.txt`/prebuilts broke the build). LevelCode's own AI layer (M2) replaces it. |
| 3 | `build/lib/copilot.ts` (`prepareBuiltInCopilotRipgrepShim`) | Skip (return) instead of throwing when the Copilot SDK dir is absent. | Pairs with patch #2: with Copilot not bundled, the ripgrep-shim packaging step must no-op rather than fail. |

> Dev mode (`run-dev.sh`) still loads `extensions/copilot` from source; patches #2/#3 only affect the **packaged** app. We can disable it in dev too later if desired.

## Rebase procedure

After re-running `bootstrap.sh` on a newer tag, run `grep -rn "\[LevelCode\]" vscode/src`
to confirm each patch above still applies (line may move; the change is a one-liner).
If upstream restructured the file, re-apply the equivalent change and update this table.
