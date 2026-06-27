# Atom++ — Agent Guide (CLAUDE.md)

Atom++ is an **AI-native, hackable, Notepad++-powered code editor for macOS**, built as a
**fork of Code-OSS** (the MIT core behind VS Code). Goal: the user's "last editor" — Atom feel,
Notepad++ power-editing, native Claude AI, all MIT/license-clean.

Read `PLAN.md` for the vision/roadmap and `docs/CORE-PATCHES.md` for every change made inside
the upstream source.

## ⚠️ The most important rule: what's tracked vs generated

`vscode/` is a **gitignored, disposable clone** of Code-OSS produced by `scripts/bootstrap.sh`.
**Never edit anything in `vscode/` directly — it gets overwritten.** Everything that is *ours*
lives in the tracked repo and is re-applied onto a clean clone:

| Ours (edit here, tracked) | Gets installed into (generated) | By |
| --- | --- | --- |
| `extensions/atom-npp-pack/`, `extensions/atom-ai/` | `vscode/extensions/*` | `apply-branding.mjs` (copy) |
| `branding/product.overlay.json`, `branding/icons/` | `vscode/product.json`, `vscode/resources/...` | `apply-branding.mjs` (merge/copy) |
| `patches/atom-core.patch` | edits to `vscode/src/**`, `vscode/build/**` | `bootstrap.sh` (`git apply`) |

So: **edit extensions in `extensions/…`, not `vscode/extensions/…`.** After editing, run
`./scripts/run-dev.sh` (it syncs canonical → checkout first) to test.

A full rebuild from nothing = `bootstrap.sh` → `build-macos.sh`. Nothing is lost if `vscode/` is deleted.

## Repo layout

```
PLAN.md                     vision + phased roadmap (M0/M1/M2…)
CLAUDE.md                   this file
docs/CORE-PATCHES.md        log of every edit inside vscode/ (tagged // [Atom++])
docs/M0-RUNBOOK.md, EXIT-TEST.md, M1-SPEC.md
branding/product.overlay.json   Atom++ identity + Open VSX gallery (deep-merged onto product.json)
branding/icons/             app icon source PNG, generated .icns, 1024 png
extensions/atom-npp-pack/   Notepad++ power-editing pack (plain JS, no build step)
extensions/atom-ai/         native Claude AI (chat, inline completion, providers, edit-with-diff, LM provider)
extensions/atom-themes/     signature One Dark / One Light themes (JSON, default via configurationDefaults)
extensions/atom-hackability/ user init script (~/.atom-plus-plus/init.js) — runs your code at startup, live-reloadable
patches/atom-core.patch     our core source edits, applied on bootstrap
scripts/                    bootstrap.sh, apply-branding.mjs, run-dev.sh, build-macos.sh, make-dmg.sh, make-icon.sh
vscode/                     GITIGNORED upstream Code-OSS checkout (generated)
```

## Build / run

```bash
./scripts/bootstrap.sh        # fresh: clone Code-OSS @ pinned tag, brand, install extensions, apply patches, npm ci
./scripts/run-dev.sh          # dev: sync + compile + launch (Copilot disabled). Fast iteration.
./scripts/build-macos.sh      # package Atom++.app (arch-aware). Output: VSCode-darwin-<arch>/Atom++.app
./scripts/make-dmg.sh         # ad-hoc sign Atom++.app + wrap it into a single distributable Atom++-<arch>.dmg
./scripts/make-icon.sh        # regenerate .icns from branding/icons/atom-plus-plus-source.png (sips+iconutil)
```

## Toolchain (hard requirements — these bit us)

- **Node = `vscode/.nvmrc` (currently 24.15.0)**. Older majors fail to compile native modules.
- **Python ≥ 3.8** for node-gyp (its bundled gyp uses `:=`; 3.7 crashes).
- **Native arm64 everything.** If you run under Rosetta (x64 Node on an arm64 Mac), esbuild/tsgo
  crash mid-build ("wrong platform" / "tsgo exited with code unknown"). Fix: native arm64 terminal +
  arm64 Node, then `rm -rf vscode/node_modules && npm ci`. `bootstrap.sh`/`build-macos.sh` now hard-fail on mismatch.

## Core patches (things changed inside vscode/)

Tracked in `patches/atom-core.patch`, tagged with `// [Atom++]`. Find them all:
`grep -rn "\[Atom++\]" vscode/src vscode/build`. Re-create the patch after editing core:
`git -C vscode diff -- <files> > patches/atom-core.patch`. Current patches:

1. `src/vs/workbench/contrib/files/browser/files.contribution.ts` — `files.hotExit` default → `onExitAndWindowClose` (Sublime-style persistence; application-scoped so can't be set by an extension).
2. `build/lib/extensions.ts` (`packageCopilotExtensionStream`) — returns empty: do NOT bundle the proprietary GitHub Copilot Chat extension (not MIT).
3. `build/lib/copilot.ts` (`prepareBuiltInCopilotRipgrepShim`) — skip instead of throw when Copilot absent.

## Copilot is removed everywhere (keep it that way)

- Not bundled in the packaged app (patches #2/#3).
- Disabled in dev: `run-dev.sh` launches with `--disable-extension GitHub.copilot-chat`.
- **DON'T null `product.defaultChatAgent`** — the onboarding code does `assertDefined(product.defaultChatAgent)`
  and the workbench crashes at startup if it's missing. Leave it a valid object; we just don't show/use it.

## Settings shipped as defaults (via extension `configurationDefaults` or core patch)

- `files.hotExit = onExitAndWindowClose` (core patch — application-scoped).
- `workbench.editorLargeFileConfirmation = 2048`, `chat.commandCenter.enabled = false`, `chat.disableAIFeatures = true` (atom-npp-pack).
- Extensions can only override **machine-overridable / window / resource / language-overridable** scoped settings — NOT application/machine. (That's why hotExit needed a core patch.)

## Feature status

**M1 — Notepad++ pack (`extensions/atom-npp-pack/`, all done, plain JS):**
macros (`Cmd+Shift+R`/`Cmd+Alt+P`), Duplicate file (`Cmd+D` / Explorer menu), Sublime hot-exit,
line operations (sort/dedup/case/…), column incrementing numbers, encoding/EOL status-bar toggle,
big-file mode badge. Files: extension.js + fileOps/lineOps/columnOps/encodingEol/bigFile.js.

**M2 — native AI (`extensions/atom-ai/`, working):**
- `providers.js` — streaming + non-streaming Anthropic Messages API + Ollama (direct, BYO key, no backend).
  `streamClaude`/`streamOllama` for chat, `completeClaude`/`completeOllama` for inline completion.
- `extension.js` — webview chat panel **in the secondary (right) side bar** (`viewsContainers.secondarySidebar`),
  opens by default on first launch (`globalState` `didAutoOpen`), `Cmd+Alt+I` to focus. Model picker
  (Opus 4.8 / Sonnet 4.6 / Haiku 4.5 + Ollama). Context: auto-includes the open file
  (`atompp.ai.includeActiveFile`), **pin any workspace files** via a searchable picker (`addContext`,
  removable chips), and **automatic retrieval** (`gatherAutoContext`) — ripgrep content search + filename +
  workspace symbols, scoped to the active sub-project, shown as a `🔎 Auto-context` line. Key in SecretStorage
  (`atompp.ai.anthropicKey`). Settings under `atompp.ai.chat.*`.
- `media/chat.html` — the chat UI: Codex-style composer (context chips, model/mode toolbar) and a
  `requestAnimationFrame` **typewriter** that reveals streamed text smoothly instead of dumping chunks.
- `inlineComplete.js` — **inline tab-completion** (ghost text): `InlineCompletionItemProvider` over all files,
  debounced (`atompp.ai.completions.debounce`, 150ms), cancels in-flight on keystroke, silent key lookup
  (never prompts mid-typing). Status-bar toggle + `atompp.ai.toggleCompletions`. Default model Haiku.
- `lmProvider.js` — registers Claude as a native `LanguageModelChatProvider` (vendor `atompp`). Stable API.
- `aiEdit.js` — **edit-with-diff**: select code → `Cmd+Alt+E` → instruction → side-by-side diff → ✓ Keep / ✗ Discard
  buttons on the diff toolbar (gated on `atompp.ai.diffActive`).
- `inlineReview.js` — **dead code** (an inline per-hunk Keep/Undo attempt that was reverted; nothing imports it).

## Deferred / known limits (don't waste time re-hitting these)

- **Copilot-grade inline edit review** (floating Keep/Undo button widget + red removed-line phantom rows) is
  **core `chatEditing` UI only** — unreachable from an extension (no overlay widgets, no view-zones). Doing it
  "right" means driving VS Code's native chat-editing: register a chat participant + a complete
  `IDefaultChatAgent` in product.json + patch out Copilot's sign-in/entitlement gating in `chatSetup*`. Big,
  multi-session core effort. We use the diff-tab review instead.
- Built since M2 shipped: inline tab-completion (`inlineComplete.js`), multi-file + auto-retrieval chat context
  (`gatherAutoContext`), chat moved to the right side bar, typewriter streaming, `make-dmg.sh` packaging.
- Not yet built: Notepad++ keymap preset (M1 leftover); agentic multi-file tasks (M4); M3 hackability
  (settings UI, user init script, package generator, theme studio, settings import).

## Conventions

- Extensions are plain JS, no build step (so they ship via `fromLocalNormal`/vsce with no compile). Keep it that way.
- `// @ts-check` + JSDoc at top of JS files.
- Test JS logic with `node --check` and small unit snippets before wiring into the editor.
- After any change, `./scripts/run-dev.sh` to verify; package with `./scripts/build-macos.sh`.
- Commit `extensions/`, `patches/`, `branding/`, `scripts/`, `docs/`, `PLAN.md`, `CLAUDE.md`. Never commit `vscode/`.
