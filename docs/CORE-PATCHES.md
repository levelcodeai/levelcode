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
# STRUCTURAL patch only (11 files). Display-string rebrands are NOT here — they live in scripts/de-brand.mjs.
git -C vscode diff HEAD -- \
  src/vs/workbench/contrib/files/browser/files.contribution.ts \
  build/lib/extensions.ts build/lib/copilot.ts \
  src/vs/workbench/contrib/welcomeGettingStarted/browser/gettingStarted.contribution.ts \
  src/vs/workbench/contrib/welcomeGettingStarted/browser/gettingStartedService.ts \
  src/vs/workbench/contrib/update/browser/releaseNotesEditor.ts \
  src/vs/workbench/browser/actions/helpActions.ts \
  src/vs/workbench/contrib/welcomeWalkthrough/browser/walkThrough.contribution.ts \
  src/vs/workbench/contrib/welcomeOnboarding/browser/welcomeOnboarding.contribution.ts \
  src/vs/workbench/api/node/loopbackServer.ts \
  src/vs/workbench/contrib/chat/browser/chatSetup/chatSetupContributions.ts \
  > patches/levelcode-core.patch
# NOTE 1: use `diff HEAD` (not plain `diff`) — bootstrap's `git apply` may leave these STAGED,
# and plain `git diff` shows only UNSTAGED changes, silently dropping the staged patches.
# NOTE 2: regenerate BEFORE running de-brand.mjs. de-brand's global MS-doc-link sweep (pass 2) also
# strips links from `files.contribution.ts` (a patched file); if you regen after de-brand, those
# link-strips leak into the patch. Order: patch → regen → de-brand (this is also bootstrap's order).
```

To find every core touch in the checkout:

```bash
grep -rn "\[LevelCode\]" vscode/src vscode/build
```

## Patches (structural / behavioural only)

These can't be a content swap — behaviour, build logic, unregistrations. Kept small on purpose so they
survive Code-OSS bumps. Each is tagged `[LevelCode]`. **The build is strict** (`noUnusedLocals` +
`allowUnreachableCode: false`), so these avoid dead early-`return`s (unreachable-code error), commented-out
calls that orphan a private method (unused-member error), and any now-unused import — **run `npm run
compile-client` after touching a core file.**

| # | File | Change | Why |
| --- | --- | --- | --- |
| 1 | `src/vs/workbench/contrib/files/browser/files.contribution.ts` | `files.hotExit` default → `onExitAndWindowClose` | Sublime-style persistence by default; `files.hotExit` is application-scoped, which extensions may not override — so it must be a core default. |
| 2 | `build/lib/extensions.ts` (`packageCopilotExtensionStream`) | Return an empty stream — don't bundle GitHub Copilot Chat. | Proprietary, not MIT; from-source packaging is fragile. LevelCode's own AI layer replaces it. |
| 3 | `build/lib/copilot.ts` (`prepareBuiltInCopilotRipgrepShim`) | Skip instead of throwing when the Copilot SDK dir is absent. | Pairs with #2 — the ripgrep-shim step must no-op when Copilot isn't bundled. |
| 4 | `welcomeGettingStarted/browser/gettingStarted.contribution.ts` | `experimentalOnboarding` default `true`→`false`; removed `experiment:{mode:'auto'}`. | De-brand (WS-A). The **sole** kill of the first-run **"Welcome to VS Code — Sign in to use GitHub Copilot"** overlay: with it off (and no experiment to re-enable it) `tryShowOnboarding` returns at its config check, so `onboardingService.show()` never runs. No code-level guard in `startupPage.ts` — a bare `return` there is unreachable-code-flagged. Do **not** null `product.defaultChatAgent` (assertDefined-d, ~15 files). |
| 5 | `welcomeGettingStarted/browser/gettingStartedService.ts` (`registerWalkthroughs`) | Iterate `walkthroughs.slice(0, 0)` → the built-in **VS Code walkthroughs** (Setup / Web / Accessibility) never register. | De-brand (WS-C/H2). An empty slice — *not* an early `return` (unreachable) nor an uncalled method (unused) — keeps `walkthroughs` referenced and compiles clean. LevelCode's own walkthrough registers via the **extension** path. |
| 6 | `update/browser/releaseNotesEditor.ts` (`show`) | Open `product.releaseNotesUrl` in the browser instead of fetching `code.visualstudio.com/raw/v{ver}.md`. | De-brand (WS-B). Stops the in-editor **"Visual Studio Code 1.126"** release-notes tab. `useCurrentFile` dev command still renders a local `.md`. |
| 7 | `browser/actions/helpActions.ts` | **Hide** the "**Ask @vscode**" Help item (`when: ContextKeyExpr.false()`) + command (`f1: false`). | De-brand (WS-C/M4). Copilot participant, not shipped. *Gated* rather than deleted so all imports stay used — the class stays registered but never surfaces. |
| 8 | `welcomeWalkthrough/browser/walkThrough.contribution.ts` | **Remove** the "**Editor Playground**" action registration + Help item + their now-unused imports (`registerAction2`, `MenuRegistry`, `MenuId`, `EditorWalkThroughAction`). | De-brand (WS-C/M5). Its walkthrough is verbatim Microsoft VS Code content. Clean full removal (no leftover unused imports). |
| 9 | `welcomeOnboarding/browser/welcomeOnboarding.contribution.ts` | Developer command **"Welcome Onboarding 2026"** → `f1: false`. | De-brand (WS-A/B3). That command calls `onboardingService.show()`, which renders the verbatim **"Welcome to VS Code — Sign in to use GitHub Copilot"** modal. Patch #4 blocks it on *first run*; this hides the one remaining Command-Palette path to it. `f1:false` (not removal) keeps the action + its imports used. |
| 10 | `api/node/loopbackServer.ts` (`getHtml`) | Replace the `this._appName === 'Visual Studio Code'` / `'… - Insiders'` branches (which embedded the VS Code stable/Insiders **shields**, falling through to the blue VS Code **"book"** default) with a single **LevelCode chevron** data-URI. | De-brand (WS-C/L5). A latent bug **and** a leak: `appName` is now "LevelCode" so no branch matched → every GitHub OAuth success page flashed a VS Code logo. `this._appName` is still used in the page text, so no unused-field error. |
| 11 | `chat/browser/chatSetup/chatSetupContributions.ts` | **Hide** the two GitHub Copilot sign-in call-to-actions (Accounts menu + title bar) with `when: ContextKeyExpr.false()`, and drop the two imports that becomes unused (`ChatEntitlementContextKeys`, `InEditorZenModeContext` — strict build). | De-brand (WS-A/B4). A sign-in funnel for an extension we don't ship. **Gated per MENU ITEM on purpose.** The previous attempt forced `IChatEntitlementService.setForceHidden(true)` instead — but `Setup.hidden` is upstream's *hide-ALL-chat/agent-UI* flag, not a CTA gate: it also gates `OPEN_AGENTS_WINDOW_PRECONDITION` (constants.ts), the **Agent Plugins view**, chat participants and several chat/plugin actions. That shipped in v0.6.0–v0.7.0 and made **Open Agents Window disappear from the Command Palette**. Never gate a de-brand on `Setup.hidden`; gate the item. |

## String + link rebrands — `scripts/de-brand.mjs` (NOT in the patch)

Content-based replacements — matched on the string, not its line number — so they survive upstream line
movement and no-op if a target disappears. `bootstrap.sh` runs it right after `git apply`; idempotent, and
it **warns (never fails)** on drift. **Add display-string / link rules here, not the patch.** Two passes:

**Pass 1 — curated name swaps.** Every user-visible **"VS Code" / "Visual Studio Code" → "LevelCode"**
display string (settings descriptions, notifications, menu labels, the Agents-window "Open …" actions, the
`openInVSCode.css` icon swap, and now the **update settings** M1 reword, the **git SCM welcome** M3, and the
bundled-extension `package.nls.json` descriptions L1). Curated per-file because a blanket swap could clobber
a genuine external-VS-Code reference or a `vscode://` scheme.

**Pass 2 — global MS-doc-link strip.** Collapses `[text](https://code.visualstudio.com/…)` and
`[text](https://aka.ms/…)` to just `text` across **all** of `vscode/src` (minus `test/`, `.test.ts`, and
vendored `agentHost/**`) plus every bundled extension's `package.nls.json`. Safe to run globally: the
pattern only ever matches a Microsoft **doc link**, never a LevelCode keep. Two subtleties baked into the
regex/callback: link text is `[^\[\]\r\n]+` (can't span an `= [` array bracket to a later link), and the
`{Locked='](url)'}` NLS translator-annotation idiom is skipped (its `[` is a code bracket, not markdown).
**`.d.ts` are included on purpose** — `monaco.d.ts` copies JSDoc (incl. these links) verbatim from the
editor source, and the build fails ("monaco.d.ts is no longer up to date") unless both sides are stripped.

**Also pass 1 — the aquarium easter egg (not a *name* swap).** `sessions/contrib/aquarium/**` renders the
Agents-window "fish" as live SVG: upstream they are the **VS Code logo silhouette** (`vscodeLogoPath.ts`)
tinted with **VS Code's three release-channel colors** (`#007ACC` / `#24bfa5` / `#E04F00`). We keep the
easter egg and make it ours — the LevelCode **double chevron** in our brand-gradient stops
(`#6a3fe0` / `#7069ff` / `#4fb2ff`). Three things to know if you touch it:
- The path `from` is a **RegExp** (`export const VSCODE_LOGO_PATH = '…';`) so an upstream tweak to the
  silhouette can't silently leave Microsoft's logo in place — it still matches and re-swaps.
- The mark is **filled, not stroked**, and sized to the symbol's `0 0 96 96` viewBox spanning
  `BODY_X_START..BODY_X_END` (5..90) — each fish is drawn as clipped vertical slices, so a thin stroke
  would shred into disconnected segments and a narrower path would leave the head/tail strips empty.
- It is two **overlapping** subpaths, so `fill-rule` is flipped `evenodd`→`nonzero` (evenodd would knock
  the overlap out as a hole). Upstream file/const names (`vscodeLogoPath.ts`, `VSCODE_LOGO_PATH`,
  `FishSpecies.Insiders`…) are deliberately left alone — internal identifiers, never user-visible.

- **KEPT** (intentional): `sessions/contrib/applyCommitsToParentRepo/.../applyChangesToParentRepo.ts` "Open in VS Code" — a real hand-off to *external* VS Code via the `vscode://` scheme. And the `{Locked=…}` NLS annotations (translator metadata, never user-visible) keep their MS URLs.
- **NOT a de-brand issue** (checked, left alone): the empty-editor **letterpress watermark**
  (`parts/editor/media/letterpress-*.svg`) — it renders a generic editor pane with a sidebar and text
  lines. No VS Code logo, wordmark, or brand colour; replacing it would be taste, not de-branding.
- **SKIPPED**: M13 quality-switch dialogs — dormant (no Insiders LevelCode build); rebranding would imply a false "Insiders LevelCode".
- **EXCLUDED**: `platform/agentHost/**` — its ~631 "VS Code" hits are all `test/` files + vendored proprietary Copilot/MS SDK (stripped from the shipped app by `strip-proprietary.mjs`).

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
