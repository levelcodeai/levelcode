# LevelCode — Signed auto-update (Squirrel `.zip`) — scope

**Goal:** make the editor's built-in **Check for Updates…** actually install a new build, instead of
always reporting "There are currently no updates available."

**Today:** that dialog is *correct behaviour*, not a bug. `Api::UpdatesController` (thin.ly) serves
**204** to every client except the notify-only extension — a deliberate **unsigned-build guard**,
because the built-in Squirrel updater *auto-downloads and installs* whatever `url` a 200 returns, and
today that `url` is a GitHub **release page**, not a signed `.zip`. Squirrel would download it and fail.

Verified against production while scoping:

| Client | Request | Response |
|---|---|---|
| Built-in Squirrel updater | `GET /api/update/darwin-arm64/stable/<commit>` | **204** (guard) |
| Notify-only extension (`User-Agent: LevelCode Updater`) | same | **200** `productVersion: 0.7.2` |

## What already exists (most of the hard part)

- **`scripts/notarize.sh sign`** — Developer ID signing with **hardened runtime** + `levelcode.entitlements`.
- **`scripts/notarize.sh notarize-app`** — notarizes **and staples the `.app` itself**, precisely so a
  copied-out app validates offline. **This is exactly the artifact Squirrel needs.**
- **CI already zips an app** with `ditto -c -k --sequesterRsrc --keepParent` (for the UNSIGNED artifact) —
  the same command, applied to the *signed* app, produces the feed asset.
- **`Api::UpdatesController`** already implements the full Code-OSS feed contract, the guard, and
  `LEVELCODE_UPDATE_FEED` (a JSON env override) — which doubles as the **rollback/pin lever**.
- **`Levelcode::EditorReleaseFeed`** already resolves tag → commit, `product_version`, and timestamp.

So this is **not** a new signing pipeline. It is: publish one more asset, teach the feed to point at it,
then lift the guard.

## The gap

1. **Release artifact.** Produce `LevelCode-<arch>.app.zip` from the **signed + notarized + stapled**
   `.app` (a `ditto` after `make-dmg.sh`'s signing step) and publish it on the release. The `.dmg` stays —
   it remains the fresh-install path; the `.zip` is update-only.
   *The zip is the only new release asset.* `make-dmg.sh` also writes a `.app.zip.sha256` beside it, but
   that stays **local**: the feed's `sha256hash` comes from GitHub's API-computed asset `digest`
   (`"sha256:<hex>"`), so no sidecar is ever fetched. The file is for verifying by hand that the zip you
   published is the zip you built.
2. **Feed asset resolution.** `EditorReleaseFeed#fetch_release` currently returns `url: rel["html_url"]`
   (the release page) and `sha256hash: nil`. It must select the **right asset** from `rel["assets"]` by
   arch and return its `browser_download_url` plus the hash from that asset's own `digest` field.
3. **Arch mapping.** Feed targets are `darwin-arm64` and `darwin` (Intel). Map to the arm64 / x64 zips
   respectively — **never serve a cross-arch zip**.
4. **Lift the guard.** Set `LEVELCODE_UPDATE_FEED_SIGNED=1` on Elastic Beanstalk — **only after 1–3**.
5. **Notify-only Download button.** `extensions/levelcode-updater/extension.js:96` is
   `feed.url || product.downloadUrl || base`. Once `feed.url` is a raw `.zip`, that button would hand
   users a zip instead of the release page. Reorder to prefer `product.downloadUrl` / the release page.

## Slices

**S1 — publish the signed zip (client).** Add the `ditto` + `shasum` step to `make-dmg.sh` (or a
`make-update-zip.sh`), update `docs/RELEASING.md`, and upload `LevelCode-<arch>.app.zip` with the dmg.
*Ship this alone first — it is inert until the feed points at it.*

**S2 — serve it (server).** Teach `EditorReleaseFeed` to pick the arch-matched asset + hash. Guard stays
on, so behaviour is unchanged; assert the new shape in `spec/requests/api/updates_spec.rb`.

**S3 — extension URL fix.** Reorder the Download preference so it never opens a raw zip.

**S4 — flip the flag + verify.** Set `LEVELCODE_UPDATE_FEED_SIGNED=1`, then run the end-to-end test below.

## Risks (the ones that actually bite)

- **Sequencing.** Flipping the flag before S1–S2 makes things *worse* — Squirrel would download a web
  page and fail loudly. S4 must be last.
- **Signing-identity continuity.** Squirrel.Mac refuses an update whose Developer ID doesn't match the
  running app. **Rotating or changing the signing cert breaks auto-update for every installed build**,
  with no in-app recovery — those users must re-download manually. Treat the identity as long-lived.
- **No staged rollout.** Publishing a release auto-installs for everyone on the next check. The rollback
  lever is `LEVELCODE_UPDATE_FEED` (pin the previous commit) — but installs that already updated are
  *not* reverted. Consider a canary/percentage gate before this is a large install base.
- **Unverifiable by inspection.** Auto-update can only be proven by actually doing it on a real Mac
  (install N, publish N+1, watch the swap). Budget a real test cycle, not a code review.
- **Stapling must survive the zip.** `ditto --sequesterRsrc --keepParent` preserves the stapled ticket;
  re-zipping with `zip(1)` can drop extended attributes. Keep using `ditto`.
- **Notarization latency.** Apple's notarization is minutes, occasionally longer — the zip must be cut
  *after* `notarize-app` completes, or you publish an unstapled app.

## Exit test

1. Install **N** (e.g. v0.7.2) from the dmg, confirm `About` shows its commit.
2. Publish **N+1** with the signed zip attached and the feed serving it.
3. In N: **Check for Updates…** → it offers, downloads, and **relaunches into N+1**; `About` shows the
   new commit. No Gatekeeper prompt.
4. Confirm the Intel build receives the x64 zip (not arm64).
5. Pin `LEVELCODE_UPDATE_FEED` back to N's commit → a fresh N+1 install reports "up to date"
   (proves the rollback lever).

## Not doing (explicitly)

- Windows/Linux feeds — `EditorReleaseFeed::TARGETS` is macOS-only by design; announcing a build that
  doesn't exist is worse than silence.
- Delta updates. Full-zip replacement is fine at this size.
- Auto-update for the notify-only extension — it stays notify-only by design.
