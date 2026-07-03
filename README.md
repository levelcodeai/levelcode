# Atom++

**The AI-native, hackable, Notepad++-powered code editor for macOS — a Code-OSS fork.**

[atompp.ai](https://atompp.ai) · MIT-licensed · not affiliated with Microsoft

Atom++ stands on the same battle-tested Monaco / Code-OSS core behind VS Code and bends it into a fast, private editor that's *yours*: a first-class AI layer that talks **directly** to whatever model provider you choose (your own key, or a local model — no middle-man backend), Notepad++ power-editing, and the old Atom "everything is hackable" soul.

## Download

Get the latest **`.dmg`** from **[atompp.ai/download](https://atompp.ai/download)** — Apple Silicon or Intel — open it, and drag Atom++ to Applications. (Direct links: [Apple Silicon](https://atompp.ai/download/arm64) · [Intel](https://atompp.ai/download/x64) · [all releases](https://github.com/atom-plus-plus/atompp/releases/latest).)

> Signed + notarized builds open with a plain double-click. If you're on an early unsigned build and macOS blocks first launch, right-click the app → **Open** (once), or run `xattr -dr com.apple.quarantine "/Applications/Atom++.app"`.

Prefer to build it yourself? See [Quick start](#quick-start-macos).

## Highlights

**🤖 Native AI — bring your own key, any provider.**
Chat with your codebase, inline tab-completion, select-and-edit as a reviewable diff, and an autonomous **agent** that plans, edits across files, runs commands, and verifies its own work (apply-then-review with Keep / Undo + per-turn checkpoints). One provider registry + one OpenAI-compatible adapter unlocks **hundreds of models**: Anthropic Claude (native), OpenAI, OpenRouter, Groq, Together, Fireworks, DeepSeek, xAI, Mistral, any OpenAI-compatible endpoint, and local **Ollama**. Requests go straight from your machine to the provider — **no Atom++ server in the middle** — and keys live in your OS keychain, never synced.

**⚡ Notepad++ power-editing.**
Keystroke macros (record / replay), column-mode quality-of-life, line operations (sort / dedup / case), one-click encoding & line-ending controls always visible in the status bar, a read-optimized big-file mode, duplicate-file, and Sublime-style hot exit.

**🛠 Hackable — the Atom soul.**
A user init script, live config, package authoring with hot-reload, keymap presets (Atom / Notepad++ / Sublime muscle memory), and signature One Dark / One Light themes.

**🔄 Yours across machines.**
Built-in Settings Sync, notify-only update checks, and one-click **import from VS Code / VSCodium / Cursor** (settings, keybindings, snippets).

## What's in this repo

Atom++ is a **clean overlay on top of Code-OSS**, not a vendored copy of the editor source — so it rebases cleanly onto new upstream releases. `scripts/bootstrap.sh` fetches Code-OSS at a pinned tag and turns it into Atom++. This repo holds:

- `extensions/` — the first-party extensions (native AI, Notepad++ pack, themes, hackability, sync, updater), plain JS with no build step.
- `branding/` — the Atom++ identity (`product.overlay.json`) + icons, deep-merged onto upstream `product.json`; the extension gallery wired to **Open VSX**.
- `patches/` — the small set of core source patches (each tagged `// [Atom++]`).
- `scripts/` — bootstrap / run-dev / build / dmg / icon.
- `tools/` — dependency-free reference servers (Settings-Sync feed, update feed).
- `PLAN.md`, `docs/`, `CLAUDE.md` — the vision, roadmap, and repo map.

## Quick start (macOS)

```bash
# Prereqs: Xcode Command Line Tools, Node (see vscode/.nvmrc — currently 24.x), Python 3.8+.
./scripts/bootstrap.sh        # clone Code-OSS @ pinned tag, brand it, install extensions, npm ci
./scripts/run-dev.sh          # launch Atom++ from source (fast iteration)
./scripts/build-macos.sh      # produce Atom++.app
./scripts/make-dmg.sh         # wrap it into a distributable .dmg
```

See [`CLAUDE.md`](./CLAUDE.md) for the full repo map + build details and [`PLAN.md`](./PLAN.md) for the roadmap.

## Status

Actively built, macOS-first. Working today: the Notepad++ power-editing pack; the full native AI stack (chat, inline completion, edit-with-diff, the agent + auto-verify, and multi-provider BYOK); One Dark / One Light themes; the hackability layer; Settings Sync; and the update checker. Milestone detail and what's next live in [`PLAN.md`](./PLAN.md).

## Why a fork

Code-OSS is MIT-licensed and free to fork, modify, and ship. Atom++ honors the constraints every forker must: the **Microsoft Extension Marketplace is Microsoft-products-only**, so Atom++ points its gallery at **Open VSX** (the Eclipse-run open marketplace); and Atom++ ships its own name, icon, and identity. It is **not** produced by, endorsed by, or affiliated with Microsoft, and the upstream Code-OSS source is fetched at build time — never redistributed in this repository.

## License

MIT — see [`LICENSE`](./LICENSE). A derivative of [Code-OSS](https://github.com/microsoft/vscode) (MIT, © Microsoft Corporation). Not affiliated with Microsoft.
