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
git -C vscode diff HEAD -- \
  src/vs/workbench/contrib/files/browser/files.contribution.ts \
  build/lib/extensions.ts build/lib/copilot.ts \
  src/vs/workbench/contrib/welcomeGettingStarted/browser/gettingStarted.contribution.ts \
  src/vs/workbench/contrib/welcomeGettingStarted/browser/startupPage.ts \
  src/vs/workbench/contrib/update/browser/releaseNotesEditor.ts \
  src/vs/sessions/browser/media/openInVSCode.css \
  src/vs/workbench/contrib/extensions/browser/extensions.contribution.ts \
  src/vs/workbench/contrib/extensions/browser/extensionsActions.ts \
  src/vs/workbench/contrib/extensions/browser/extensionsWorkbenchService.ts \
  src/vs/workbench/contrib/terminal/browser/terminalView.ts \
  src/vs/sessions/electron-browser/actions/vscodeActions.ts \
  src/vs/sessions/browser/widget/openInVSCodeWidget.ts \
  src/vs/sessions/contrib/providers/remoteAgentHost/browser/remoteAgentHost.contribution.ts \
  src/vs/sessions/contrib/providers/localChatSessions/browser/localChatSessions.contribution.ts \
  src/vs/sessions/contrib/policyBlocked/browser/sessionsPolicyBlocked.ts \
  src/vs/workbench/contrib/issue/browser/baseIssueReporterService.ts \
  src/vs/workbench/contrib/chat/browser/widget/input/chatModelPicker.ts \
  src/vs/workbench/contrib/welcomeGettingStarted/browser/gettingStartedService.ts \
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

## Patches

| # | File | Change | Why |
| --- | --- | --- | --- |
| 1 | `src/vs/workbench/contrib/files/browser/files.contribution.ts` | `files.hotExit` default → `onExitAndWindowClose` (was `onExit`) | Sublime-style persistence by default. `files.hotExit` is application-scoped, which extensions are forbidden from overriding (only machine-overridable/window/resource/language-overridable defaults may be set by extensions), so this must be a core default. |
| 2 | `build/lib/extensions.ts` (`packageCopilotExtensionStream`) | Return an empty stream — don't bundle the GitHub Copilot Chat extension. | Copilot Chat is **proprietary, not MIT**; redistributing it in a non-Microsoft product isn't permitted, and its from-source packaging is fragile (missing `shims.txt`/prebuilts broke the build). LevelCode's own AI layer (M2) replaces it. |
| 3 | `build/lib/copilot.ts` (`prepareBuiltInCopilotRipgrepShim`) | Skip (return) instead of throwing when the Copilot SDK dir is absent. | Pairs with patch #2: with Copilot not bundled, the ripgrep-shim packaging step must no-op rather than fail. |
| 4 | `src/vs/workbench/contrib/welcomeGettingStarted/browser/gettingStarted.contribution.ts` | `workbench.welcomePage.experimentalOnboarding` default `true`→`false`; removed the `experiment:{mode:'auto'}` block. | De-brand (WS-A/B1-B2). Kills the first-run **"Welcome to VS Code — Sign in to use GitHub Copilot"** onboarding overlay a client saw. The experiment block would silently re-enable it, so it must go too. |
| 5 | `src/vs/workbench/contrib/welcomeGettingStarted/browser/startupPage.ts` (`tryShowOnboarding`) | Early `return` — never invoke `onboardingService.show()`. | De-brand (WS-A/B1). Guaranteed kill of the onboarding overlay regardless of config/experiment. Do NOT null `product.defaultChatAgent` (it's `assertDefined`-d and used in ~15 core files) — killing the *entry point* is the safe route. |
| 6 | `src/vs/workbench/contrib/update/browser/releaseNotesEditor.ts` (`show`) | Open `product.releaseNotesUrl` in the browser instead of fetching `code.visualstudio.com/raw/v{ver}.md`. | De-brand (WS-B/B5). Stops the in-editor **"Visual Studio Code 1.126"** release-notes tab. The `useCurrentFile` dev command (author a local `.md`) still renders locally. |
| 7 | `src/vs/sessions/browser/media/openInVSCode.css` | The `[data-product-quality]` "Open in VS Code" button icon → `./vscode-icon.svg` (the real VS Code shield) instead of `code-icon.svg`. | De-brand (WS-D). That button *opens VS Code*, so it must show the VS Code logo — but we now overwrite `code-icon.svg` with the LevelCode mark (see the asset-override note below), which would otherwise make it show LevelCode. |
| 8 | extensions `extensions.contribution.ts`, `extensionsActions.ts`, `extensionsWorkbenchService.ts`; terminal `terminalView.ts` | Rebrand user-visible reload/restart/deprecation notices: "Please reload/restart **Visual Studio Code**", "[**VS Code** Release Notes]", "bundled with **Visual Studio Code**" → **LevelCode**. | De-brand (WS-C / H4+M7). These fire on extension install/uninstall and terminal font changes. Tagged `// [LevelCode] rebrand` where the syntax allows. NOTE: lower-priority *settings-description* strings ("VS Code installs only…") in these files are **not yet** done (L1). |
| 9 | sessions `vscodeActions.ts`, `openInVSCodeWidget.ts`, `policyBlocked/sessionsPolicyBlocked.ts`, `remoteAgentHost.contribution.ts`, `localChatSessions.contribution.ts` | Rebrand Agents-window strings that reference the app itself: "Open VS Code Window" / "Open in VS Code Editor Window" / "Open VS Code" (all open a **LevelCode** window via `urlProtocol`) → LevelCode; "SSH … managed by VS Code" and "Local VS Code chat sessions" settings → LevelCode. | De-brand (WS-C/H3). **KEPT** `applyCommitsToParentRepo/applyChangesToParentRepo.ts` "Open in VS Code" — that one genuinely hands off to *external* VS Code via the `vscode://` scheme. (Residual: a `aka.ms/VSCode/Agents/docs` "Learn more" URL in the policy-blocked card — no LevelCode equivalent yet.) |
| 10 | issue `baseIssueReporterService.ts`; chat `chatModelPicker.ts` | Report-Issue **source dropdown** "Visual Studio Code" / "A VS Code extension" → LevelCode; chat model-picker "requires a newer version of VS Code" / "Update VS Code" → LevelCode. | De-brand (WS-C/M2+M6). **SKIPPED** M13 quality-switch dialogs — dormant (no Insiders LevelCode build); rebranding would imply a false "Insiders LevelCode". |
| 11 | `browser/actions/helpActions.ts`; `welcomeWalkthrough/browser/walkThrough.contribution.ts` | **Unregister** the Help ▸ "**Ask @vscode**" item + command (Copilot participant; Copilot not shipped) and the Help ▸ "**Editor Playground**" action + item (100% Microsoft VS Code walkthrough content). | De-brand (WS-C/M4+M5). The now-dead classes are left in place (tree-shaken from the build). |
| 12 | `welcomeGettingStarted/browser/gettingStartedService.ts` (+ `gettingStarted.contribution.ts` §4) | `registerWalkthroughs()` early-returns → the built-in **VS Code walkthroughs** (Setup / VS Code for the Web / Accessibility, all `code.visualstudio.com`/`aka.ms`-linked) never register; Welcome menu description "get started in VS Code" → LevelCode. | De-brand (WS-C/H2). LevelCode's "Welcome to LevelCode" walkthrough registers via the **extension** path, so it's the only getting-started walkthrough shown. |

> **Branding asset override (not a patch):** `apply-branding.mjs` also copies `branding/icons/code-icon.svg` (the LevelCode chevron mark) over `vscode/src/vs/workbench/browser/media/code-icon.svg`. Stock Code-OSS ships the blue `#167abf` VS Code "book" there; it's used as a `background-image` on the title-bar app icon, the update tooltip, the welcome/onboarding hero, the walkthrough and the banner (one file → ~6 surfaces). Because it's a whole-file swap it's done by the branding copy step, not this patch — but patch #7 above pairs with it.

> Dev mode (`run-dev.sh`) still loads `extensions/copilot` from source; patches #2/#3 only affect the **packaged** app. We can disable it in dev too later if desired.

## Rebase procedure

After re-running `bootstrap.sh` on a newer tag, run `grep -rn "\[LevelCode\]" vscode/src`
to confirm each patch above still applies (line may move; the change is a one-liner).
If upstream restructured the file, re-apply the equivalent change and update this table.
