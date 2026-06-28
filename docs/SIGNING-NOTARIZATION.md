# Atom++ — Code Signing & Notarization Runbook (macOS)

How to turn the **unsigned / ad-hoc** Atom++ build into a **Developer-ID-signed, notarized, stapled**
`.dmg` that launches cleanly on any Mac with no Gatekeeper warnings.

> **Status (2026-06-28):** Apple Developer enrollment in progress (awaiting Apple support, up to ~2
> business days). This runbook captures the full process so it's ready the moment the account + cert
> land. Until then, `scripts/make-dmg.sh` keeps producing an **ad-hoc-signed** dmg (runs locally;
> needs right-click→Open or `xattr -dr com.apple.quarantine` on other Macs).

---

## 0. Where we are vs. where we're going

| | Today (ad-hoc) | Goal (Developer ID + notarized) |
| --- | --- | --- |
| Signature | `codesign --sign -` (ad-hoc) | `Developer ID Application: … (TEAMID)` |
| Hardened runtime | no | **yes** (`--options runtime`, required to notarize) |
| Entitlements | none | Electron/V8 JIT entitlements |
| Notarized by Apple | no | **yes** (`notarytool`) |
| Stapled ticket | no | **yes** (`stapler`) |
| Other Macs | Gatekeeper blocks (right-click→Open) | **launches cleanly, no warning** |

**The pipeline:** enroll → create *Developer ID Application* cert → create a notarization credential →
sign inside-out with hardened runtime + entitlements → notarize the dmg → staple → verify.

---

## 1. Enroll in the Apple Developer Program  *(manual — only you can do this)*

- **Cost:** $99 / year. **Time:** minutes to ~48h for approval.
- Pre-req: your **Apple ID must have two-factor auth** enabled (<https://appleid.apple.com>).
- Go to <https://developer.apple.com/programs/> → **Enroll**.
- **Entity type:**
  - **Individual / Sole Proprietor** — fastest; the app's signer shows your *personal legal name*.
  - **Organization** — shows your *company name*, supports a team, but needs a **D-U-N-S number**
    (free; can take a few days) and legal authority to enroll the entity.
- Pay the **$99** (Apple Developer iPhone app or web) and wait for the approval email.

> Recommendation for an indie/personal release: **Individual** now; convert to Organization later if needed.

---

## 2. Create the **Developer ID Application** certificate  *(manual)*

⚠️ **Pick the exact right type** — distribution outside the App Store needs **"Developer ID Application"**:
- NOT "Apple Distribution" (App-Store only).
- NOT "Developer ID Installer" (that's for `.pkg`; we ship a `.dmg`, so we don't need it).

**Via Xcode (easiest — also creates the private key):**
1. Install **Xcode** (Mac App Store, free).
2. Xcode → **Settings → Accounts** → add your Apple ID → **Manage Certificates…**
3. **+** → **Developer ID Application**. The cert + private key land in your **login keychain**.

**Verify (this exact identity string is what the build uses):**
```bash
security find-identity -v -p codesigning
#  → "Developer ID Application: Your Name (TEAMID1234)"
```
Record your **Team ID** (`TEAMID1234`) and the full identity string.

> Back up the cert+key: Keychain Access → My Certificates → right-click the Developer ID Application
> cert → **Export** → save the `.p12` somewhere safe. Losing the private key means re-issuing.

---

## 3. Create a notarization credential  *(manual)*

`notarytool` must authenticate to Apple. Pick one and store it once in the keychain:

**Option A — App-specific password (simplest):**
1. <https://appleid.apple.com> → **Sign-In and Security → App-Specific Passwords** → generate (name it `atompp-notary`).
2. Store it:
   ```bash
   xcrun notarytool store-credentials "atompp-notary" \
     --apple-id "you@example.com" \
     --team-id  "TEAMID1234" \
     --password "xxxx-xxxx-xxxx-xxxx"     # the app-specific password (not your Apple ID password)
   ```

**Option B — App Store Connect API key (best for CI):**
- App Store Connect → **Users and Access → Integrations → App Store Connect API → +** → download the
  `.p8`, note **Key ID** + **Issuer ID**.
  ```bash
  xcrun notarytool store-credentials "atompp-notary" \
    --key AuthKey_XXXXXX.p8 --key-id "KEYID" --issuer "ISSUER-UUID"
  ```

Either way the saved profile is referenced later as `--keychain-profile "atompp-notary"`. No secret ever
enters the repo.

---

## 4. Entitlements  *(in the repo — Electron/V8 needs these or it crashes under the hardened runtime)*

Create `build/entitlements/atompp.entitlements.plist`:
```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>com.apple.security.cs.allow-jit</key><true/>
  <key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/>
  <key>com.apple.security.cs.disable-library-validation</key><true/>
  <key>com.apple.security.cs.allow-dyld-environment-variables</key><true/>
</dict>
</plist>
```
The same set is applied to the **helper apps** (GPU / Renderer / Plugin) — they inherit these so V8's JIT
works in every process. (This mirrors what upstream VS Code / `@electron/osx-sign` apply.)

---

## 5. Sign — inside-out, hardened runtime  *(automated by `scripts/sign-notarize.sh`, to be added)*

Electron apps **must be signed from the inside out** (every nested `.dylib`/`.framework` and each
`*.app` helper first, the main bundle last). Plain `--deep` is unreliable for this — prefer
[`@electron/osx-sign`](https://github.com/electron/osx-sign) which knows the correct order, or a manual
loop. Key flags on every binary:
```bash
codesign --force --timestamp --options runtime \
  --entitlements build/entitlements/atompp.entitlements.plist \
  --sign "Developer ID Application: Your Name (TEAMID1234)" <path>
```
- `--options runtime` → hardened runtime (mandatory for notarization).
- `--timestamp` → secure timestamp (mandatory; needs network).
- Sign helpers/frameworks **before** the outer `Atom++.app`.

**Verify the signature before notarizing:**
```bash
codesign --verify --deep --strict --verbose=2 "VSCode-darwin-arm64/Atom++.app"
codesign -dv --verbose=4 "VSCode-darwin-arm64/Atom++.app"   # → "Authority=Developer ID Application…", "flags=…runtime"
```

---

## 6. Notarize the `.dmg`

Build the dmg (`scripts/make-dmg.sh`), then:
```bash
xcrun notarytool submit "Atom++-arm64.dmg" --keychain-profile "atompp-notary" --wait
```
- `--wait` blocks until Apple finishes (usually a few minutes) and prints **Accepted / Invalid**.
- On **Invalid**, get the details:
  ```bash
  xcrun notarytool log <submission-id> --keychain-profile "atompp-notary"
  ```

---

## 7. Staple the ticket

```bash
xcrun stapler staple "Atom++-arm64.dmg"
```
Stapling embeds the notarization ticket so Gatekeeper validates **offline** (no network on first launch).
You can also staple the `.app` *before* building the dmg, then staple the dmg too.

---

## 8. Verify it will pass Gatekeeper on a clean Mac

```bash
xcrun stapler validate "Atom++-arm64.dmg"
spctl -a -t open --context context:primary-signature -v "Atom++-arm64.dmg"
#  → "source=Notarized Developer ID"  /  "accepted"
```
Best real test: copy the dmg to a **different Mac** (or a fresh user account), open it, drag to
Applications, double-click — it should launch with **no warning**.

---

## 9. Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `notarytool` → **Invalid**, log says "not signed with a valid Developer ID" | Re-sign with the *Developer ID Application* identity + `--options runtime`. |
| Log: "The executable does not have the hardened runtime enabled" | Missing `--options runtime` on some nested binary — re-sign inside-out. |
| App crashes on launch ("killed", code 137 / SIGKILL) after signing | Missing JIT entitlements (§4) on the main app or a helper. |
| "The signature does not include a secure timestamp" | Add `--timestamp` (needs network when signing). |
| Gatekeeper still warns after notarizing | Forgot to **staple** (§7), or stapled the app but not the dmg. |
| `errSecInternalComponent` during codesign | Keychain locked / wrong identity — `security unlock-keychain`; check `security find-identity`. |

---

## 10. Repo integration plan (to wire once the cert is installed)

1. `build/entitlements/atompp.entitlements.plist` — the entitlements from §4 (tracked).
2. `scripts/sign-notarize.sh` — Developer-ID signs inside-out (`@electron/osx-sign` or manual loop),
   notarizes (§6), staples (§7), verifies (§8). **Gated on env vars** so it's a no-op without a cert:
   - `ATOMPP_SIGN_IDENTITY` — e.g. `Developer ID Application: Your Name (TEAMID1234)`
   - `ATOMPP_NOTARY_PROFILE` — e.g. `atompp-notary`
3. `scripts/make-dmg.sh` — when `ATOMPP_SIGN_IDENTITY` is set, call `sign-notarize.sh` instead of the
   ad-hoc `codesign --sign -`; otherwise behave exactly as today (ad-hoc, unnotarized).

So a signed release becomes:
```bash
export ATOMPP_SIGN_IDENTITY="Developer ID Application: Your Name (TEAMID1234)"
export ATOMPP_NOTARY_PROFILE="atompp-notary"
./scripts/build-macos.sh && ./scripts/make-dmg.sh     # signs → dmg → notarize → staple → verify
```

---

## Quick reference (once enrolled)

```bash
security find-identity -v -p codesigning                                   # confirm cert
xcrun notarytool store-credentials "atompp-notary" --apple-id … --team-id … --password …
# build + sign + notarize + staple (via the wired scripts):
ATOMPP_SIGN_IDENTITY="Developer ID Application: … (TEAMID)" \
ATOMPP_NOTARY_PROFILE="atompp-notary" ./scripts/make-dmg.sh
xcrun stapler validate Atom++-arm64.dmg && spctl -a -t open --context context:primary-signature -v Atom++-arm64.dmg
```
