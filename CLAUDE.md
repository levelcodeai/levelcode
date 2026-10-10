# LevelCode — Agent Guide (CLAUDE.md)

LevelCode is an **AI-native, hackable, Notepad++-powered code editor for macOS**, built as a
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
| `extensions/levelcode-npp-pack/`, `extensions/levelcode-ai/` | `vscode/extensions/*` | `apply-branding.mjs` (copy) |
| `branding/product.overlay.json`, `branding/icons/` | `vscode/product.json`, `vscode/resources/...` | `apply-branding.mjs` (merge/copy) |
| `patches/levelcode-core.patch` | edits to `vscode/src/**`, `vscode/build/**` | `bootstrap.sh` (`git apply`) |

So: **edit extensions in `extensions/…`, not `vscode/extensions/…`.** After editing, run
`./scripts/run-dev.sh` (it syncs canonical → checkout first) to test.

A full rebuild from nothing = `bootstrap.sh` → `build-macos.sh`. Nothing is lost if `vscode/` is deleted.

## Repo layout

```
PLAN.md                     vision + phased roadmap (M0/M1/M2…)
CLAUDE.md                   this file
docs/CORE-PATCHES.md        log of every edit inside vscode/ (tagged // [LevelCode])
docs/M0-RUNBOOK.md, EXIT-TEST.md, M1-SPEC.md
branding/product.overlay.json   LevelCode identity + Open VSX gallery (deep-merged onto product.json)
branding/icons/             app icon source PNG, generated .icns, 1024 png
extensions/levelcode-npp-pack/   Notepad++ power-editing pack (plain JS, no build step)
extensions/levelcode-ai/         native Claude AI (chat, inline completion, providers, edit-with-diff, LM provider)
extensions/levelcode-themes/     signature One Dark / One Light themes (JSON, default via configurationDefaults)
extensions/levelcode-hackability/ user init script + Atom/NPP keymap presets + package generator & hot-reload dev loader
extensions/levelcode-sync/       'levelcode' auth provider that lights up the built-in Settings Sync (LevelCode Sync, S0)
extensions/levelcode-updater/    notify-only update checker (polls the update feed; never auto-applies)
patches/levelcode-core.patch     our core source edits, applied on bootstrap
scripts/                    bootstrap.sh, apply-branding.mjs, run-dev.sh, editor-identity.mjs, build-macos.sh, make-dmg.sh, make-icon.sh, build-web.mjs; atom (CLI launcher) + install-level.sh
tools/                      dependency-free reference servers: sync-server (/v1 Settings-Sync), update-server (/api/update feed)
web/                        LevelCode in a browser tab: page entry + callback, scratch-workspace extension, browser build of levelcode-ai, dev server, tests (docs/WEB.md)
vscode/                     GITIGNORED upstream Code-OSS checkout (generated)
```

## Build / run

```bash
./scripts/bootstrap.sh        # fresh: clone Code-OSS @ pinned tag, brand, install extensions, apply patches, npm ci
./scripts/run-dev.sh          # dev: sync + compile + launch (Copilot disabled). Fast iteration.
./scripts/build-macos.sh      # package LevelCode.app (arch-aware). Output: VSCode-darwin-<arch>/LevelCode.app
./scripts/make-dmg.sh         # ad-hoc sign LevelCode.app + wrap it into a single distributable LevelCode-<arch>.dmg
./scripts/make-icon.sh        # regenerate .icns from branding/icons/levelcode-source.png (sips+iconutil)
```

## The dev editor is its own app (keep it that way)

To macOS a run from source and the installed LevelCode used to be ONE app — same bundle id, same
`levelcode://` scheme — so a sign-in started in the dev editor was handed back to the app in
/Applications. `run-dev.sh` now gives the dev run its own identity (`scripts/editor-identity.mjs dev`):

- **Identity:** `branding/product.dev.json` — scheme `levelcode-dev`, bundle id `ai.levelcode.app.dev`.
  Both must differ from the shipped ones; a scheme alone still lets macOS confuse the two apps.
- **Two halves, both required.** Runtime: `vscode/product.overrides.json` (Code-OSS reads it only when
  running from source, never packages it). macOS: the dev Electron bundle's `Info.plist`, then
  `lsregister`. The bundle is regenerated when Electron changes, so the step runs on every launch.
- **Both or neither, and confirmed.** The two files are replaced as one change (staged, renamed, undone
  if the second rename fails). Then the step asks macOS which app opens `levelcode-dev://` and FAILS —
  `run-dev.sh` stops before launching — unless the answer is this bundle. `lsregister` exiting 0 is
  not that answer: it registers a bundle it will never route to.
- **`branding/product.overlay.json` is the product that ships — never put a dev value in it.**
  `build-macos.sh` runs `editor-identity.mjs check-release` and fails a build that is not
  `levelcode://` + `ai.levelcode.app`, or that carries an overrides file.
- **Auth code never spells a scheme.** `accountSignIn()` builds the callback from
  `vscode.env.uriScheme`; that is why the dev identity needed no auth change. Keep it so.
- **The server must be told:** `LEVELCODE_EXTRA_EDITOR_SCHEMES=levelcode-dev` on the backend the dev
  editor signs in to (thin.ly `Levelcode::EditorCallback`). Off by default, and it only ever accepts
  `levelcode-<variant>`. Symptom when missing: the browser lands on the account page and the editor
  hears nothing.
- A LaunchServices handler must live outside temp folders — a bundle under `/tmp` is registered but
  never chosen. Tests therefore run on fixtures and do not register anything (`test/editorIdentity.test.js`).

## LevelCode in a tab (`web/`) — read `docs/WEB.md` first

The same `extensions/levelcode-ai` source runs in a browser tab (web-worker extension host). Rules that keep
the desktop app exactly as it was:

- **A workspace read or write goes through `extensions/levelcode-ai/host.js`**, never `fs` on a workspace path:
  in a tab the workspace is whatever the editor's file-system provider says, and every read is asynchronous.
  On the desktop each `host` function does what the call site did before, behind `await`.
- **Nothing outside `host.js` asks "am I in a browser?"** — a call site asks for a capability (`host.caps.shell`,
  `.mcpStdio`, `.ripgrep`) or calls a function that already knows. A new tool that needs a shell/disk/process is
  listed in `NEEDS_SHELL` (agent.js) so the browser neither offers it nor promises it.
- The browser build is `web/ai-extension/` (esbuild + shims for `fs`/`path`/`os`/`crypto`/`child_process`).
  Strings that are true on a Mac and false in a tab are rewritten by `web/ai-extension/copy.js`, which fails the
  build when the desktop text it expects is gone — change both together. `manifest.js` drops the commands and
  settings a tab cannot honour.
- `web/main.js` is a plain ES module with a **top-level `await`**: a `const` declared lower in the file is not
  initialised until that await finishes (this cleared a saved session once). Declare constants above the
  `try`, and use function declarations for helpers it calls.
- The session store (`createSecretStorage`) belongs to every tab: no cache, one-key read-modify-write under a
  Web Lock. The refresh token is rotated on use; do not reintroduce a start-up snapshot.
- Build: `node scripts/build-web.mjs --account <origin>` → `dist-web/`; serve with `node web/serve.mjs --dist dist-web`.
  Tests: the unit gate (`scripts/test-extensions.sh` includes `web/test/unit/*.test.js`) and the end-to-end checks in
  `web/test/e2e*.mjs` (headless Chrome, stand-in backend; Node 22+). What was not run is listed in `docs/WEB.md`.

## Toolchain (hard requirements — these bit us)

- **Node = `vscode/.nvmrc` (currently 24.15.0)**. Older majors fail to compile native modules.
- **Python ≥ 3.8** for node-gyp (its bundled gyp uses `:=`; 3.7 crashes).
- **Native arm64 everything.** If you run under Rosetta (x64 Node on an arm64 Mac), esbuild/tsgo
  crash mid-build ("wrong platform" / "tsgo exited with code unknown"). Fix: native arm64 terminal +
  arm64 Node, then `rm -rf vscode/node_modules && npm ci`. `bootstrap.sh`/`build-macos.sh` now hard-fail on mismatch.

## Core patches (things changed inside vscode/)

Tracked in `patches/levelcode-core.patch`, tagged with `// [LevelCode]`. Find them all:
`grep -rn "\[LevelCode\]" vscode/src vscode/build`. Re-create the patch after editing core:
`git -C vscode diff -- <files> > patches/levelcode-core.patch`. Current patches:

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
- `workbench.editorLargeFileConfirmation = 2048`, `chat.commandCenter.enabled = false`, `chat.disableAIFeatures = true` (levelcode-npp-pack).
- Extensions can only override **machine-overridable / window / resource / language-overridable** scoped settings — NOT application/machine. (That's why hotExit needed a core patch.)

## Feature status

**M1 — Notepad++ pack (`extensions/levelcode-npp-pack/`, all done, plain JS):**
macros (`Cmd+Shift+R`/`Cmd+Alt+P`), Duplicate file (`Cmd+D` / Explorer menu), Sublime hot-exit,
line operations (sort/dedup/case/…), column incrementing numbers, encoding/EOL status-bar toggle,
big-file mode badge. Files: extension.js + fileOps/lineOps/columnOps/encodingEol/bigFile.js.

**M2 — native AI (`extensions/levelcode-ai/`, working):**
- `providers/` — **multi-provider BYOK (P1)**. A registry data table (`providers/index.js` `PROVIDERS` +
  `getProvider`/`normId`/`secretStorageKey`/`isInsecureCustomUrl`) dispatches `streamChat()`/`complete()` on the
  row's `kind`: **Anthropic** keeps its native adapter (`providers/anthropic.js` — prompt caching + full tool-use,
  what the agent needs); **every other provider shares ONE OpenAI-compatible adapter** (`providers/openaiCompat.js` —
  fetch + SSE `/v1/chat/completions`, param'd by `{baseURL,apiKey,headers}`): OpenAI, OpenRouter, Groq, Together,
  Fireworks, DeepSeek, xAI, Mistral, Ollama-via-`/v1`, and a user-supplied `custom` endpoint. Adding a provider =
  a new row, zero code. `providers.js` is now a thin **back-compat shim** (agent.js + lmProvider.js still import it).
  Design: `docs/levelcode-multiprovider-design.md`. Pure body-builder/SSE-parser/registry logic is unit-tested
  (`test/providers.test.js`). **Chat, inline completion, edit AND the agent all route through the registry.**
  - **P2 — the agent is multi-provider too.** `providers/translate.js` (pure, `test/translate.test.js`) is the
    Anthropic↔OpenAI tool-use bridge; the agent's internal transcript stays **Anthropic-block-shaped for every
    provider** and is translated only at the wire boundary (`openaiCompat.streamOpenAIAgentTurn`), so
    `repairAgentMemory`, checkpoints, max_tokens handling and the verify loop are untouched. `providers.streamAgentTurn`
    dispatches by kind; the agent is gated by `supportsTools(providerId)` (Ollama blocked — flaky tool support;
    Claude/OpenAI/OpenRouter/Groq/DeepSeek/Mistral/xAI/custom allowed). `buildChatBody` emits `max_completion_tokens`
    for o-series reasoning models; the agent turn requests `stream_options.include_usage` so the context meter works.
  - **P4 — model catalog + per-model capabilities.** `providers/catalog.js` (pure logic + mappers unit-tested,
    `test/catalog.test.js`): a static `CAPS` table + basename/family heuristics + a permissive `tools:true` default
    give every model a real context window + tool/vision flags. `supportsToolsForModel` (provider gate + per-model
    opt-out) drives the agent gate — so `deepseek-reasoner`/`o1-mini` are offered for chat but blocked from the agent;
    `contextWindowFor` drives the context meter; `fastCompletionModel` gives ghost-text a snappy per-provider model.
    `pickModel` shows caps inline and has a live "Browse all models" action (`getModelChoices({dynamic:true})` →
    OpenRouter `/api/v1/models`, OpenAI-compatible `/v1/models`, Ollama `/api/tags`), all best-effort (offline → built-ins).
  - Per-provider keys in SecretStorage (`levelcode.ai.key.<provider>`; Anthropic keeps its legacy `levelcode.ai.anthropicKey`).
    Provider via `levelcode.ai.provider`; model via `levelcode.ai.claude.model`/`ollama.model`/generic `levelcode.ai.model`;
    custom base URL via `levelcode.ai.baseURL`.
- `extension.js` — webview chat panel **in the secondary (right) side bar** (`viewsContainers.secondarySidebar`),
  opens by default on first launch (`globalState` `didAutoOpen`), `Cmd+Alt+I` to focus. Model picker
  (Opus 4.8 / Sonnet 4.6 / Haiku 4.5 + Ollama). Context: auto-includes the open file
  (`levelcode.ai.includeActiveFile`), **pin any workspace files** via a searchable picker (`addContext`,
  removable chips), and **automatic retrieval** (`gatherAutoContext`) — ripgrep content search + filename +
  workspace symbols, scoped to the active sub-project, shown as a `🔎 Auto-context` line. Provider-aware key +
  model resolution (`prepProviderRequest`/`activeModel`/`baseUrlFor`); keys in SecretStorage per provider.
  Settings under `levelcode.ai.chat.*`.
- `media/chat.html` — the chat UI: Codex-style composer (context chips, model/mode toolbar) and a
  `requestAnimationFrame` **typewriter** that reveals streamed text smoothly instead of dumping chunks.
- `inlineComplete.js` — **inline tab-completion** (ghost text): `InlineCompletionItemProvider` over all files,
  debounced (`levelcode.ai.completions.debounce`, 150ms), cancels in-flight on keystroke, silent key lookup
  (never prompts mid-typing). Status-bar toggle + `levelcode.ai.toggleCompletions`. Default model Haiku.
- `lmProvider.js` — registers Claude as a native `LanguageModelChatProvider` (vendor `levelcode`). Stable API.
- `aiEdit.js` — **edit-with-diff**: select code → `Cmd+Alt+E` → instruction → side-by-side diff → ✓ Keep / ✗ Discard
  buttons on the diff toolbar (gated on `levelcode.ai.diffActive`).
- `inlineReview.js` — **dead code** (an inline per-hunk Keep/Undo attempt that was reverted; nothing imports it).
- `diagram/` — **rich diagrams, phase 1** (`docs/RICH-DIAGRAMS.md`). The agent calls a `render_diagram` tool with
  STRUCTURE only (nodes, edges, groups, one accent — never coordinates or colours); the editor validates it, lays it
  out in one house style and paints it in the chat, themed, with nodes that link to code. Graph JSON only — Mermaid,
  Vega-Lite and raw SVG are later phases and are **not built**. Not yet run in the packaged editor or against a live
  model; the eval (`scripts/diagram-eval.js`) exists and has not been run.
  - Shared UMD modules (`theme` `schema` `validate` `repair` `layout` `scene` `text` `ascii`) run in Node AND are
    inlined into `chat.html` by `diagram/bundle.js` under the page's existing nonce — the CSP is unchanged. Host-only:
    `tool` (tool + prompt block + result text), `service` (ids, the one repair pass, records, stubs), `links`,
    `exportCheck`, `stats`.
  - Repair ladder: lossless auto-fix → every error back to the model ONCE → degrade with a banner, or source + Retry.
    Never a blank card, never a second automatic repair. Records are stored in the session log and re-validated (not
    re-repaired) on reopen, by the host and by the page.
  - Layout is in-house (layered + orthogonal routing), **not ELK** (EPL-2.0, ~1.5 MB, no build step here);
    `layout.layout()` is the one swap point. The validator is a small JSON-Schema-subset interpreter, not Ajv.
  - Gated per run by `client.render` (`rich`|`ascii`): off via `levelcode.ai.diagrams.enabled`, or per model with
    `diagrams: false` in `providers/catalog.js` `CAPS`. Costs ~970 tokens of tool + prompt per request while on.
  - Checks: `test/diagram*.test.js` (in the gate), `scripts/diagram-browser-check.js` (real page in headless Chrome,
    not in the gate), `scripts/diagram-editor-check.js` (the REAL editor: a throwaway instance of the dev build with
    this checkout's extension and a stand-in provider), `scripts/diagram-eval.js --dry-run`. Local counters: command
    `AI: Diagram Statistics`.

## Deferred / known limits (don't waste time re-hitting these)

- **Copilot-grade inline edit review** (floating Keep/Undo button widget + red removed-line phantom rows) is
  **core `chatEditing` UI only** — unreachable from an extension (no overlay widgets, no view-zones). Doing it
  "right" means driving VS Code's native chat-editing: register a chat participant + a complete
  `IDefaultChatAgent` in product.json + patch out Copilot's sign-in/entitlement gating in `chatSetup*`. Big,
  multi-session core effort. We use the diff-tab review instead.
- Built since M2 shipped: inline tab-completion (`inlineComplete.js`), multi-file + auto-retrieval chat context
  (`gatherAutoContext`), chat moved to the right side bar, typewriter streaming, `make-dmg.sh` packaging.
- M3 so far: One Dark/Light themes (`levelcode-themes`); user init script + Atom/Notepad++ keymap presets +
  package generator with live hot-reload (`levelcode-hackability`). The Atom/NPP keymap also clears the old M1 leftover.
- M4 agentic multi-file tasks: DONE. `agent.js` has the full tool loop — list_files/read_file/search,
  update_plan, edit_file/write_file/**delete_file** (apply-then-review with Keep/Undo + per-turn checkpoint
  restore via `reviewSession.js`), run_command(+background)/read_command_output, ask_user, use_skill — plus the
  M5 auto-verify loop. `delete_file` also enables rename/move (write new path → delete old).
- LevelCode Sync (S0) + notify-only updater (U0): see `extensions/levelcode-sync` / `extensions/levelcode-updater` + `tools/`.
- Not yet built: remaining M3 hackability — settings UI, theme studio, VS Code settings import.

## Conventions

- Extensions are plain JS, no build step (so they ship via `fromLocalNormal`/vsce with no compile). Keep it that way.
- `// @ts-check` + JSDoc at top of JS files.
- Test JS logic with `node --check` and small unit snippets before wiring into the editor.
- After any change, `./scripts/run-dev.sh` to verify; package with `./scripts/build-macos.sh`.
- `run-dev.sh` runs the extensions of the checkout that HAS `vscode/`. A git worktree has none, so work in a worktree
  is not in the editor until you load it: `./scripts/run-dev.sh --extensionDevelopmentPath=<worktree>/extensions/levelcode-ai`
  (from the main checkout; the dev extension replaces the built-in one). Uncommitted work is not "on the branch" —
  checking the branch out somewhere else gets none of it. Run it in the editor before telling anyone to try it.
- Commit `extensions/`, `patches/`, `branding/`, `scripts/`, `web/`, `docs/`, `PLAN.md`, `CLAUDE.md`. Never commit `vscode/` or `dist-web/`.
- `extensions/levelcode-ai/diagram/` modules listed in `bundle.FILES` are pasted INTO a script block in `chat.html`.
  They must never contain the text of a script tag or an HTML comment opener — not even in a comment — or the block
  ends early; `bundle.js` refuses to build if one does. Keep them dependency-free and free of `require('vscode')`/`fs`.
- Host suites slice functions out of `extension.js` with a brace matcher (`extract()` in `test/*Host.test.js`). It
  does not understand a backtick inside a regex literal: write `String.fromCharCode(96)` there instead.
