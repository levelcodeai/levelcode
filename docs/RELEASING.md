# Releasing Atom++ (build → strip → sign → notarize → publish)

How to turn the source into a **de-Microsoft'd, Developer-ID-signed, notarized, stapled** `.dmg` that
launches cleanly on any Mac with no Gatekeeper warning — in one command once the one-time setup is done.

> **Status (2026-07-01):** Apple Developer Program **enrolled**; the *Developer ID Application* cert is
> installed (`AJ27Y4Z2HS`) and the `atompp-notary` credential is stored. `scripts/notarize.sh` +
> `scripts/atompp.entitlements` + the `make-dmg.sh`/`build-macos.sh` wiring are all in place.
> Without `CODESIGN_IDENTITY` set, `make-dmg.sh` still produces an **ad-hoc** dmg (local/tester use;
> other Macs need right-click→Open or `xattr -dr com.apple.quarantine`).

## 0. Where we're going

| | Ad-hoc (default) | Developer ID + notarized (release) |
| --- | --- | --- |
| Signature | `codesign --sign -` | `Developer ID Application: … (TEAMID)` |
| Hardened runtime | no | **yes** (`--options runtime`) |
| Entitlements | none | Electron/V8 JIT (`scripts/atompp.entitlements`) |
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
xcrun notarytool store-credentials "atompp-notary" \
  --apple-id "you@example.com" --team-id "AJ27Y4Z2HS" --password "xxxx-xxxx-xxxx-xxxx"
```
(For CI, use an App Store Connect API key instead: `--key AuthKey_XXXX.p8 --key-id KEYID --issuer ISSUER-UUID`.)

**c. Export for your shell** (or your release env):
```bash
export CODESIGN_IDENTITY="Developer ID Application: SERGII DEMIANCHUK (AJ27Y4Z2HS)"
export NOTARY_PROFILE="atompp-notary"
```

## 2. Cut a release

```bash
./scripts/bootstrap.sh        # first time / after an upstream bump (clone + brand + patch + npm ci)
./scripts/build-macos.sh      # → VSCode-darwin-<arch>/Atom++.app, then auto-strips proprietary MS/Copilot code from the app
./scripts/make-dmg.sh         # de-Microsoft (defensive) → sign (Developer ID) → dmg → notarize → staple → verify
```
With `CODESIGN_IDENTITY` + `NOTARY_PROFILE` set, `make-dmg.sh` runs the whole signed+notarized pipeline;
without them it's ad-hoc (unnotarized). **The de-Microsoft strip runs on the built *app*, never the source
`vscode/` checkout** — so dev mode (`run-dev.sh` → typecheck) still sees the real packages.

## 3. Verify it will pass Gatekeeper on a clean Mac

```bash
xcrun stapler validate Atom++-arm64.dmg
spctl -a -t open --context context:primary-signature -v Atom++-arm64.dmg     # → "source=Notarized Developer ID" / "accepted"
```
Best real test: copy the dmg to a **different Mac** (or fresh user account), open it, drag to Applications,
double-click — it should launch with no warning.

Confirm the app carries no proprietary code:
```bash
find VSCode-darwin-arm64/Atom++.app \( -path "*@github/copilot*" -o -path "*mxc-sdk*" \) \
  \( -name "*.node" -o -name "*.dylib" -o -name "mxc-exec-mac" \) -print   # → prints NOTHING
```

Build **both architectures** on matching hardware (Apple silicon → `arm64`, Intel → `x64`) to ship both dmgs.

## 4. Publish

```bash
gh release create v0.1.0 --title "Atom++ v0.1.0" --notes "First public build. …" \
  Atom++-arm64.dmg Atom++-x64.dmg
```
Stable URL: `https://github.com/atom-plus-plus/atompp/releases/latest/download/Atom++-arm64.dmg` — link it
from **atompp.ai/download**.

## 5. Point the update feed at the release

The notify-only updater (`extensions/atom-updater`) polls a feed from `tools/update-server`. After
publishing, update the feed's release entry (version + the release-asset URLs above) so running installs
see the new version. Keep the feed version in lockstep with the tag.

## 6. Troubleshooting *(the ones that actually bit us are marked ⚑)*

| Symptom | Cause / fix |
| --- | --- |
| ⚑ `security find-identity` → **0 valid identities**, cert shows **"not trusted"** in Keychain Access | The Apple **intermediate** is missing. Install the Developer ID **G2** CA: `curl -O https://www.apple.com/certificateauthority/DeveloperIDG2CA.cer` → double-click. Do NOT hand-set trust on the leaf — leave "Use System Defaults". |
| ⚑ `notarytool store-credentials` → **HTTP 401 Invalid credentials** | You used your Apple ID password, or never generated an app-specific one. appleid.apple.com → App-Specific Passwords → **Generate** → paste that (with the dashes). |
| ⚑ Notarization stuck **In Progress** for hours | Apple-side queue/incident (check [system status](https://developer.apple.com/system-status/)). The submission is server-side — `Ctrl-C` the `--wait`, then `xcrun notarytool info <id> --keychain-profile atompp-notary` later and `stapler staple` once `Accepted`. Don't resubmit (duplicates just queue behind it). |
| `notarytool` → **Invalid** | `xcrun notarytool log <id> --keychain-profile atompp-notary` names the exact file/entitlement. Usually: sign with the Developer ID identity + `--options runtime`. |
| App crashes on launch (SIGKILL / code 137) after signing | Missing JIT entitlements on the main app or a helper — check `scripts/atompp.entitlements` is applied to the helper `.app`s too (notarize.sh does this). |
| "signature does not include a secure timestamp" | Add `--timestamp` (needs network) — notarize.sh always does. |
| Gatekeeper still warns after notarizing | Forgot to **staple**, or stapled the app but not the dmg. |
| Chat won't open / shortcut dead in a build | `atompp.ai.focus` is `Ctrl+Cmd+I` (moved off the `Cmd+Alt+I` DevTools collision); the chat also auto-reveals until the first message is sent. |

## 7. CI (optional)

On a `macos` runner: base64-encode the `.p12` Developer ID export + store it (plus cert password,
`APPLE_ID`, `TEAM_ID`, `APP_SPECIFIC_PASSWORD`) as repo secrets; import the cert into a temp keychain at
job start, then run `build-macos.sh` → `make-dmg.sh` with `APPLE_ID`/`TEAM_ID`/`APP_SPECIFIC_PASSWORD`
set (make-dmg.sh uses those when `NOTARY_PROFILE` is absent).
