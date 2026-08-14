# Releasing LevelCode (build → strip → sign → notarize → publish)

How to turn the source into a **de-Microsoft'd, Developer-ID-signed, notarized, stapled** `.dmg` that
launches cleanly on any Mac with no Gatekeeper warning — in one command once the one-time setup is done.

> **Status (2026-07-01):** Apple Developer Program **enrolled**; the *Developer ID Application* cert is
> installed (`AJ27Y4Z2HS`) and the `levelcode-notary` credential is stored. `scripts/notarize.sh` +
> `scripts/levelcode.entitlements` + the `make-dmg.sh`/`build-macos.sh` wiring are all in place.
> Without `CODESIGN_IDENTITY` set, `make-dmg.sh` still produces an **ad-hoc** dmg (local/tester use;
> other Macs need right-click→Open or `xattr -dr com.apple.quarantine`).

## 0. Where we're going

| | Ad-hoc (default) | Developer ID + notarized (release) |
| --- | --- | --- |
| Signature | `codesign --sign -` | `Developer ID Application: … (TEAMID)` |
| Hardened runtime | no | **yes** (`--options runtime`) |
| Entitlements | none | Electron/V8 JIT (`scripts/levelcode.entitlements`) |
| Notarized + stapled | no | **yes** (`notarytool` + `stapler`) |
| Proprietary MS/Copilot code | **stripped** either way | **stripped** (`scripts/strip-proprietary.mjs`) |
| Other Macs | Gatekeeper blocks | **launches cleanly** |

**Pipeline:** build → de-Microsoft strip → sign inside-out (hardened runtime + entitlements) → build dmg → notarize → staple → verify → publish.

## 1. One-time setup *(manual — only you can do this)*

**a. Developer ID Application certificate.** ⚠️ Pick the exact type — outside-the-App-Store distribution
needs **"Developer ID Application"** (NOT "Apple Distribution", NOT "Developer ID Installer" which is for
`.pkg`). Easiest via Xcode → **Settings → Accounts → Manage Certificates… → + → Developer ID Application**
(creates the private key in your login keychain). Confirm + note your Team ID:
```bash
security find-identity -v -p codesigning
# → "Developer ID Application: SERGII DEMIANCHUK (AJ27Y4Z2HS)"     ← the (…) is your TEAM ID
```
Back it up: Keychain Access → My Certificates → right-click → **Export** the `.p12` somewhere safe
(losing the private key means re-issuing).

**b. Notary credential** (stored once; no secret ever enters the repo):
```bash
# App-specific password: appleid.apple.com → Sign-In and Security → App-Specific Passwords → Generate
xcrun notarytool store-credentials "levelcode-notary" \
  --apple-id "you@example.com" --team-id "AJ27Y4Z2HS" --password "xxxx-xxxx-xxxx-xxxx"
```
(For CI, use an App Store Connect API key instead: `--key AuthKey_XXXX.p8 --key-id KEYID --issuer ISSUER-UUID`.)

**c. Export for your shell** (or your release env):
```bash
export CODESIGN_IDENTITY="Developer ID Application: SERGII DEMIANCHUK (AJ27Y4Z2HS)"
export NOTARY_PROFILE="levelcode-notary"
```

## 2. Cut a release

```bash
./scripts/bootstrap.sh        # first time / after an upstream bump (clone + brand + patch + npm ci)
./scripts/build-macos.sh      # → VSCode-darwin-<arch>/LevelCode.app; strips proprietary MS/Copilot code, then stamps the release version (§3)
./scripts/make-dmg.sh         # de-Microsoft (defensive) → sign (Developer ID) → dmg → notarize → staple → verify
```
With `CODESIGN_IDENTITY` + `NOTARY_PROFILE` set, `make-dmg.sh` runs the whole signed+notarized pipeline;
without them it's ad-hoc (unnotarized). **The de-Microsoft strip runs on the built *app*, never the source
`vscode/` checkout** — so dev mode (`run-dev.sh` → typecheck) still sees the real packages.

## 3. Verify it will pass Gatekeeper on a clean Mac

```bash
xcrun stapler validate LevelCode-arm64.dmg
spctl -a -t open --context context:primary-signature -v LevelCode-arm64.dmg     # → "source=Notarized Developer ID" / "accepted"
```
Best real test: copy the dmg to a **different Mac** (or fresh user account), open it, drag to Applications,
double-click — it should launch with no warning.

Confirm the app carries no proprietary code:
```bash
find VSCode-darwin-arm64/LevelCode.app \( -path "*@github/copilot*" -o -path "*mxc-sdk*" \) \
  \( -name "*.node" -o -name "*.dylib" -o -name "mxc-exec-mac" \) -print   # → prints NOTHING
```

Confirm the app reports **its own** version rather than the Code-OSS base — this **fails silently**, so
check it every release:
```bash
python3 -c "import json;d=json.load(open('VSCode-darwin-arm64/LevelCode.app/Contents/Resources/app/product.json'));print(d.get('levelcodeVersion'),'|',d.get('version'),'|',d.get('commit','')[:7])"
# → 0.8.1 | 1.126.0 | 07b7341
#   ^ the release version   ^ MUST stay 1.126.0 (extensions' engines.vscode is checked against it)
```
A **missing `levelcodeVersion`** means `build-macos.sh` could not resolve a tag (`git describe --tags`
failed) and fell back — the update tooltip and About will then report `1.126.0`, the upstream base, which
is exactly the confusion this stamp exists to prevent. The build log distinguishes the two:

| Log line | Meaning |
| --- | --- |
| `[build] Stamping the LevelCode release version (v0.8.1) …` | Good. |
| `[build] WARN: no reachable git tag — skipping the release-version stamp.` | **No stamp** — fix before publishing. |

An off-tag build is stamped `0.8.1-3-g1a2b3c4` on purpose (see `scripts/stamp-levelcode-version.mjs`): a
build that isn't a release must not impersonate one. A release build sits on the tag and gets a clean
`0.8.1`, so a suffix here means you are not building what you think you are.

Build **both architectures** on matching hardware (Apple silicon → `arm64`, Intel → `x64`) to ship both dmgs.

## 4. Publish

```bash
gh release create v0.1.0 --title "LevelCode v0.1.0" --notes "First public build. …" \
  LevelCode-arm64.dmg LevelCode-x64.dmg \
  LevelCode-arm64.app.zip LevelCode-x64.app.zip
```
Upload **both kinds**: the `.dmg` is what humans install; the `.app.zip` is what the built-in updater
installs (Squirrel takes a zip, never a dmg). `make-dmg.sh` also writes a `.app.zip.sha256` next to each
zip — that one is **not** a release asset; it stays local. See §5.
Stable URL: `https://github.com/levelcodeai/levelcode/releases/latest/download/LevelCode-arm64.dmg` — link it
from **levelcode.ai/download**.

## 5. The update feed

> ⚠️ **Auto-update is LIVE — publishing is deploying.** `LEVELCODE_UPDATE_FEED_SIGNED=1` is set in
> production, so a published release is no longer just *announced*: the built-in Squirrel updater
> **downloads and installs it on every existing install** at that install's next check. There is no
> staged rollout and no percentage gate. The rollback lever (below) stops it propagating further but
> **cannot un-update anyone who already took it**. Finish §3 on a real Mac *before* `--draft=false`.
>
> This changed with v0.8.0 — the first release to carry signed `.app.zip` assets. Everything published
> before that stayed notify-only regardless of the flag, because the feed refuses to hand Squirrel a
> release that has no installable asset for its arch.

Publishing the GitHub release **is** the announcement — `Levelcode::EditorReleaseFeed` (thin.ly) reads
`releases/latest` and serves `/api/update/{target}/{quality}/{commit}`. There is no feed file to
hand-maintain per release.

Confirm the feed picked the release up (it caches for 5 minutes):
```bash
curl -s -H "User-Agent: LevelCode Updater" \
  https://levelcode.ai/api/update/darwin-arm64/stable/deadbeef | python3 -m json.tool
# url must end in LevelCode-arm64.app.zip (NOT a /releases/tag/ page), and productVersion must be the new one
```

Two assets, **not** interchangeable:

| Asset | Consumer |
| --- | --- |
| `LevelCode-<arch>.dmg` | Humans — fresh install, drag to Applications. |
| `LevelCode-<arch>.app.zip` | The built-in **Squirrel** updater — it installs from a zip, never a dmg. |

`make-dmg.sh` emits the `.app.zip` **only on the Developer-ID path**, because Squirrel refuses an update
whose signing identity doesn't match the running app — an ad-hoc build must never be served as an update.

**Only those two files get uploaded per arch.** `make-dmg.sh` also writes `LevelCode-<arch>.app.zip.sha256`,
but that is a **local verification convenience, not a release asset**: the feed reads `sha256hash` from
GitHub's own API-computed asset `digest` (`"sha256:<hex>"`), so nothing ever fetches a sidecar file.
Uploading one is harmless — `EditorReleaseFeed` matches assets by exact filename and ignores anything
else — just unnecessary. Use it to confirm the zip you published is the zip you built:
```bash
Z=LevelCode-arm64.app.zip
[ "$(shasum -a 256 "$Z" | cut -d' ' -f1)" = "$(cat "$Z.sha256")" ] && echo "$Z OK" || echo "$Z MISMATCH"
```

`LEVELCODE_UPDATE_FEED` (env JSON on the server) overrides the GitHub lookup and is the **rollback pin**:
point it at the previous commit to stop a bad release propagating. Note it can't un-update anyone who
already took the release.

Full contract, rollout order, and risks: **`docs/AUTO-UPDATE.md`**.

## 6. Troubleshooting *(the ones that actually bit us are marked ⚑)*

| Symptom | Cause / fix |
| --- | --- |
| ⚑ `security find-identity` → **0 valid identities**, cert shows **"not trusted"** in Keychain Access | The Apple **intermediate** is missing. Install the Developer ID **G2** CA: `curl -O https://www.apple.com/certificateauthority/DeveloperIDG2CA.cer` → double-click. Do NOT hand-set trust on the leaf — leave "Use System Defaults". |
| ⚑ `notarytool store-credentials` → **HTTP 401 Invalid credentials** | You used your Apple ID password, or never generated an app-specific one. appleid.apple.com → App-Specific Passwords → **Generate** → paste that (with the dashes). |
| ⚑ Notarization stuck **In Progress** for hours | Apple-side queue/incident (check [system status](https://developer.apple.com/system-status/)). The submission is server-side — `Ctrl-C` the `--wait`, then `xcrun notarytool info <id> --keychain-profile levelcode-notary` later and `stapler staple` once `Accepted`. Don't resubmit (duplicates just queue behind it). |
| `notarytool` → **Invalid** | `xcrun notarytool log <id> --keychain-profile levelcode-notary` names the exact file/entitlement. Usually: sign with the Developer ID identity + `--options runtime`. |
| App crashes on launch (SIGKILL / code 137) after signing | Missing JIT entitlements on the main app or a helper — check `scripts/levelcode.entitlements` is applied to the helper `.app`s too (notarize.sh does this). |
| "signature does not include a secure timestamp" | Add `--timestamp` (needs network) — notarize.sh always does. |
| Gatekeeper still warns after notarizing | Forgot to **staple**, or stapled the app but not the dmg. |
| Chat won't open / shortcut dead in a build | `levelcode.ai.focus` is `Ctrl+Cmd+I` (moved off the `Cmd+Alt+I` DevTools collision); the chat also auto-reveals until the first message is sent. |

## 7. CI release — automated, with one human gate (`.github/workflows/`)

**CI does everything; you approve the last step.** Three workflows, in order:

| Workflow | Trigger | What it does |
| --- | --- | --- |
| `prepare-release.yml` | you, manually | Drafts `RELEASE-NOTES.md` and opens a `release/vX.Y.Z` PR |
| `tag-on-merge.yml` | that PR merging | Refuses unfinished notes, then pushes the tag |
| `release.yml` | the tag | Builds both arches, signs, notarizes, drafts the release, **waits for you**, publishes |

There is no version file to bump. The release version comes from `git describe --tags` at build time
(`scripts/build-macos.sh`), so **the tag is the version**.

### One-time setup

Six repository secrets — *Settings → Secrets and variables → Actions*:

| Secret | Where it comes from |
| --- | --- |
| `APPLE_CERT_P12_BASE64` | Keychain Access → export the *Developer ID Application* cert **with its private key** as `.p12` → `base64 -i cert.p12 \| pbcopy` |
| `APPLE_CERT_PASSWORD` | the password you set on that export |
| `APPLE_SIGNING_IDENTITY` | `security find-identity -v -p codesigning` — the full `Developer ID Application: NAME (TEAMID)` string |
| `APPLE_ID` | the Apple ID owning the Developer Program membership |
| `APPLE_TEAM_ID` | the `(TEAMID)` from that identity |
| `APPLE_APP_SPECIFIC_PASSWORD` | appleid.apple.com → Sign-In and Security → App-Specific Passwords |

> ⚠️ **And the gate itself** — *Settings → Environments → New environment → `release`* → tick
> **Required reviewers** and add yourself. **This is not optional.** GitHub creates a missing
> environment implicitly, with no protection rules, so without this the publish job runs
> straight through and the approval gate is decorative. Verify by opening the environment and
> confirming a reviewer is listed.

### Cutting a release

```sh
# 1. Draft the notes.  Actions → "Prepare release" → Run workflow
#      Use workflow from: develop      ← the run FAILS from any other ref, because tag-on-merge.yml
#      version:           1.0.5           only tags PRs merged into develop
#    → opens PR "release: v1.0.5" with every FACT filled in and TODO markers where prose is needed.

# 2. Write the prose in that PR: replace the TODOs, check the "excluded as internal" list at the
#    bottom for anything user-visible, delete the scaffolding block. Merge it.
#    → tag-on-merge.yml refuses to tag while a TODO or the scaffolding survives, or if the first
#      line doesn't name this version. Then it pushes v1.0.5.

# 3. Wait (~30–60 min/arch). release.yml builds both arches on native runners, signs with the
#    Developer ID cert, notarizes with Apple, staples, verifies with spctl, and creates a DRAFT
#    release carrying all four assets and RELEASE-NOTES.md as the body.

# 4. Verify on a real Mac — §3. Download the dmg from the draft:
gh release download v1.0.5 --pattern 'LevelCode-arm64.dmg'

# 5. Approve. Actions → the running "Publish (requires approval)" job → Review deployments →
#    Approve. It flips draft=false and then polls the update feed to confirm it went live.
```

### Why the pause is where it is

Steps 1–3 are all reversible: delete a branch, delete a tag, delete a draft. Step 5 is not.
Publishing **is** deploying — §5 — and the rollback pin cannot un-update anyone who already took
the release. So the automation runs right up to that line and stops, which is a better place for
your attention than remembering the `gh release upload` argument order.

### The trade-off, stated plainly

Earlier revisions of this doc described the hybrid model — CI builds unsigned, you sign locally —
and noted its one real virtue: *"puts your signing identity in the cloud — the hybrid flow above
deliberately doesn't."* That is now the cost we have accepted. The `.p12` and its password live in
GitHub secrets, and anyone who can push a workflow to this repo can, in principle, use them.
What limits the blast radius:

- The cert is imported into a **temporary keychain in `RUNNER_TEMP`**, unlocked for that job only,
  and deleted in an `if: always()` step.
- Secrets are **not exposed to workflows triggered from forks**, so a fork PR cannot reach them.
- Revocation is real and quick: revoke the cert in the Apple Developer portal and re-issue. Do that
  the moment a repo admin leaves, or if a workflow file is ever changed by someone unexpected.

If you'd rather not hold that risk, the hybrid model still works — remove the *Import the Developer
ID certificate* and *Sign, notarize…* steps from `release.yml`, upload the unsigned zips instead,
and sign locally with `NOTARY_PROFILE` as before.

> **Intel runner note.** `macos-13` (the old x64 runner) was retired 2025-12-04, so we build x64 on
> `macos-15-intel` — GitHub's last native x86_64 image. It's a premium/large runner (bills ~2× minutes)
> and Intel support on Actions ends **Fall 2027**. After that, the x64 job must cross-compile on an
> arm64 runner (set `VSCODE_ARCH=x64`/`npm_config_arch=x64`, rebuild native modules for x64) rather than
> build natively — a `scripts/build-macos.sh` + `scripts/bootstrap.sh` change, not just a runner swap.

Notes:
- The dmg names (`LevelCode-arm64.dmg` / `LevelCode-x64.dmg`) are exactly what the download funnel at
  `levelcode.ai/download/<arch>` expects — don't rename them.
- `releases/latest` only resolves once this is a **published, non-prerelease** release with both dmgs.
- The draft job **fails if any of the four assets is missing**, rather than publishing a half release —
  losing just the x64 job would otherwise strand every Intel user, silently, since the feed is per-arch.
- The `.app.zip.sha256` files `make-dmg.sh` writes are still local-only: the feed reads GitHub's own
  asset `digest` (§5), never a sidecar.
