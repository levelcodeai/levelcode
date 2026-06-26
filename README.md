# Atom++

The hackable, AI-native, Notepad++-powered code editor for macOS — a Code-OSS fork.

> **Status: M0 (foundation).** This repo holds the Atom++ *branding overlay and build kit*, not a copy of the editor source. `scripts/bootstrap.sh` fetches Code-OSS at a pinned version and turns it into Atom++. The full vision and roadmap live in [`PLAN.md`](./PLAN.md).

## What this repo is

We don't vendor the VS Code source. Instead we keep a thin overlay that is applied on top of a clean Code-OSS checkout, so we can cleanly rebase onto new upstream releases. This repo contains:

- `branding/product.overlay.json` — the Atom++ identity (name, bundle id, URL protocol) and the **Open VSX** gallery wiring, deep-merged onto upstream `product.json`.
- `scripts/` — `bootstrap.sh` (clone + brand + install), `run-dev.sh` (launch from source), `build-macos.sh` (produce `Atom++.app`), `apply-branding.mjs` (the merge logic).
- `docs/` — the M0 runbook and exit-test checklist.

## Quick start (on your Mac)

```bash
# Prereqs: Xcode Command Line Tools, Node 20+ (nvm recommended), Python 3.
./scripts/bootstrap.sh        # clone Code-OSS @ pinned tag, apply Atom++ branding, npm ci
./scripts/run-dev.sh          # sanity-check: launches Atom++ from source
./scripts/build-macos.sh      # produce Atom++.app
```

See [`docs/M0-RUNBOOK.md`](./docs/M0-RUNBOOK.md) for the full walkthrough and [`docs/EXIT-TEST.md`](./docs/EXIT-TEST.md) for how we know M0 is done.

## Why a fork (and the rules)

Code-OSS is MIT-licensed and free to fork. Two hard constraints we honor from day one: the **Microsoft Extension Marketplace is off-limits** to non-MS products, so we use **Open VSX**; and **"Atom" is a trademark**, so the name here is a working codename until a final name + original logo are chosen. Details in `PLAN.md` §2.

## License

MIT — see [`LICENSE`](./LICENSE). Not affiliated with Microsoft.
