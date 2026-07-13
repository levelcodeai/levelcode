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
- **Structural / behavioural core edits** → captured as `patches/levelcode-core.patch`; `bootstrap.sh`
  applies it (`git apply --3way`) onto the fresh checkout. This is a **line-anchored diff** — brittle
  across upstream bumps — so keep it to the *few* changes that can't be a content swap (behaviour, build
  logic, unregistrations, early-returns).
- **User-visible "VS Code" → "LevelCode" strings** → `scripts/de-brand.mjs`, run by `bootstrap.sh` right
  after the patch. These are **content** replacements (match the string, not its line number), so they
  survive upstream line movement and no-op if a target is gone. **Add new display strings there, not to
  the patch.**

So a full rebuild from nothing is: `bootstrap.sh` (clone → brand → extensions → patch → de-brand) → `build-macos.sh`.

To re-create the core patch after changing core files in `vscode/`:

```bash
# STRUCTURAL patch only (9 files). Display-string rebrands are NOT here — they live in scripts/de-brand.mjs.
git -C vscode diff HEAD -- \
  src/vs/workbench/contrib/files/browser/files.contribution.ts \
  build/lib/extensions.ts build/lib/copilot.ts \
  src/vs/workbench/contrib/welcomeGettingStarted/browser/gettingStarted.contribution.ts \
  src/vs/workbench/contrib/welcomeGettingStarted/browser/startupPage.ts \
  src/vs/workbench/contrib/welcomeGettingStarted/browser/gettingStartedService.ts \
  src/vs/workbench/contrib/update/browser/releaseNotesEditor.ts \
  src/vs/workbench/browser/actions/helpActions.ts \
  src/vs/workbench/contrib/welcomeWalkthrough/browser/walkThrough.contribution.ts \
  > patches/levelcode-core.patch
# NOTE: use `diff HEAD` (not plain `diff`) — bootstrap's `git apply` may leave these STAGED,
# and plain `git diff` shows only UNSTAGED changes, silently dropping the staged patches.
```

To find every core touch in the checkout:

```bash
grep -rn "\[LevelCode\]" vscode/src vscode/build
```

## Patches (structural / behavioural only)

These can't be a content swap — behaviour, build logic, unregistrations, early-returns. Kept small on
purpose so they survive Code-OSS bumps. Each is tagged `[LevelCode]` in the source.

| # | File | Change | Why |
| --- | --- | --- | --- |
| 1 | `src/vs/workbench/contrib/files/browser/files.contribution.ts` | `files.hotExit` default → `onExitAndWindowClose` | Sublime-style persistence by default; `files.hotExit` is application-scoped, which extensions may not override — so it must be a core default. |
| 2 | `build/lib/extensions.ts` (`packageCopilotExtensionStream`) | Return an empty stream — don't bundle GitHub Copilot Chat. | Proprietary, not MIT; from-source packaging is fragile. LevelCode's own AI layer replaces it. |
| 3 | `build/lib/copilot.ts` (`prepareBuiltInCopilotRipgrepShim`) | Skip instead of throwing when the Copilot SDK dir is absent. | Pairs with #2 — the ripgrep-shim step must no-op when Copilot isn't bundled. |
| 4 | `welcomeGettingStarted/browser/gettingStarted.contribution.ts` | `experimentalOnboarding` default `true`→`false`; removed `experiment:{mode:'auto'}`. | De-brand (WS-A). Kills the first-run **"Welcome to VS Code — Sign in to use GitHub Copilot"** overlay; the experiment block would silently re-enable it. |
| 5 | `welcomeGettingStarted/browser/startupPage.ts` (`tryShowOnboarding`) | Early `return` — never call `onboardingService.show()`. | De-brand (WS-A). Guaranteed kill. Do **not** null `product.defaultChatAgent` (assertDefined-d, ~15 files) — kill the *entry point*. |
| 6 | `welcomeGettingStarted/browser/gettingStartedService.ts` (`registerWalkthroughs`) | Early `return` → the built-in **VS Code walkthroughs** (Setup / Web / Accessibility) never register. | De-brand (WS-C/H2). LevelCode's own walkthrough registers via the **extension** path and is unaffected. |
| 7 | `update/browser/releaseNotesEditor.ts` (`show`) | Open `product.releaseNotesUrl` in the browser instead of fetching `code.visualstudio.com/raw/v{ver}.md`. | De-brand (WS-B). Stops the in-editor **"Visual Studio Code 1.126"** release-notes tab. `useCurrentFile` dev command still renders a local `.md`. |
| 8 | `browser/actions/helpActions.ts`; `welcomeWalkthrough/browser/walkThrough.contribution.ts` | **Unregister** the Help ▸ "**Ask @vscode**" item + command (Copilot participant, not shipped) and the "**Editor Playground**" action + Help item (100% Microsoft VS Code content). | De-brand (WS-C/M4+M5). The now-dead classes are tree-shaken from the build. |

## String rebrands — `scripts/de-brand.mjs` (NOT in the patch)

Every user-visible **"VS Code" / "Visual Studio Code" → "LevelCode"** display string (settings
descriptions, notifications, menu labels, the Agents-window "Open …" actions, and the `openInVSCode.css`
icon swap) lives here as a **content** replacement — deliberately kept out of the patch, because ~30
scattered line-anchored hunks are exactly what breaks on an upstream bump. A content match doesn't care
where the string is, and no-ops if upstream removes it. `bootstrap.sh` runs it right after `git apply`;
it's idempotent and **warns (never fails)** on drift (a missing targeted string, or a residual "Visual
Studio Code"). **Add or adjust display-string rules in `scripts/de-brand.mjs`, not the patch.**

- **KEPT** (intentional): `sessions/contrib/applyCommitsToParentRepo/.../applyChangesToParentRepo.ts` "Open in VS Code" — a real hand-off to *external* VS Code via the `vscode://` scheme.
- **SKIPPED**: M13 quality-switch dialogs — dormant (no Insiders LevelCode build); rebranding would imply a false "Insiders LevelCode".
- **EXCLUDED**: `platform/agentHost/**` — its ~631 "VS Code" hits are all `test/` files + vendored proprietary Copilot/MS SDK (stripped from the shipped app by `strip-proprietary.mjs`).
- **Residual**: an `aka.ms/VSCode/Agents/docs` "Learn more" link in the policy-blocked card — no LevelCode equivalent yet.

> **Branding asset override:** `apply-branding.mjs` copies `branding/icons/code-icon.svg` (the LevelCode
> chevron mark) over `vscode/src/vs/workbench/browser/media/code-icon.svg` — the blue `#167abf` VS Code
> "book" used as a `background-image` on the title bar, update tooltip, welcome hero, walkthrough and
> banner (~6 surfaces). Whole-file swap → the branding copy step. The `openInVSCode.css` shield-swap in
> `de-brand.mjs` pairs with it, so the "Open in VS Code" button keeps the *real* VS Code logo.

> Dev mode (`run-dev.sh`) still loads `extensions/copilot` from source; patches #2/#3 only affect the **packaged** app.

## Rebase procedure

After re-running `bootstrap.sh` on a newer Code-OSS tag:

1. **Patch** — if `git apply --3way` fails, bootstrap **halts** (`set -euo pipefail` + explicit `exit 1`)
   and names the file, so a stale patch can never silently ship stock branding. Re-apply the equivalent
   structural change by hand, regenerate the patch (command above), and re-run.
   `grep -rn "\[LevelCode\]" vscode/src` lists every structural touch to verify.
2. **Strings** — `de-brand.mjs` runs automatically and **warns** on drift (it never blocks the build):
   `WARN target not found` = a targeted string moved/changed → fix that rule; `WARN residual "Visual
   Studio Code"` = a new upstream string → add a rule. Read its output on every upgrade.
3. **Smoke-test** — launch against a fresh profile (`--user-data-dir=$(mktemp -d)`): no "Welcome to VS
   Code" wizard, LevelCode chevron in the title bar, LevelCode release notes.
