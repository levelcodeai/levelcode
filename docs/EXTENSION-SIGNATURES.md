# Extension signatures

How LevelCode verifies the extensions it installs from Open VSX, what that does and does not
prove, and what to do on the two days it will need attention: when Open VSX changes its signing
key, and when Code-OSS is bumped.

## What was wrong

Before installing or updating an extension, the editor loads a module named `@vscode/vsce-sign`
and asks it to verify the download (`extensionSignatureVerificationService.ts`). That module is
Microsoft's: closed source, licensed for use "only with" Microsoft's own products. It is not in
Code-OSS, so no build from the open source has it.

With nothing to load, a built app could not verify, and a built app that cannot verify refuses:

> Cannot install '…' extension because LevelCode cannot verify the extension signature.
> Signature verification was not executed.

Every LevelCode release up to 1.3.1 did this for every extension on Open VSX, and offered
**Install Anyway (Don't Verify Signature)** as the only way forward. Less visibly, the automatic
update of installed extensions failed the same way at every start, so extensions never updated.

Other forks solve this by switching verification off. LevelCode verifies.

## What LevelCode does

Open VSX signs every package it serves. Next to each `.vsix` is a signature archive (`.sigzip`):

| Entry | What it is |
| --- | --- |
| `.signature.sig` | A 64-byte Ed25519 signature over the bytes of the `.vsix` |
| `.signature.manifest` | JSON: the size and SHA-256 of the package and of each file in it. Not signed. |
| `.signature.p7s` | Empty. The slot Microsoft's format keeps its signature in; the editor checks it exists. |

`modules/extension-signature` is LevelCode's own module for the slot the editor loads from. It
reads `.signature.sig`, and accepts the package only if `crypto.verify` says one of the keys it
trusts signed exactly those bytes. It is plain Node with no dependencies, about 300 lines.

**The key is pinned, not fetched.** Open VSX serves its public key too
(`/api/-/public-key/<id>`), and the obvious verifier downloads it. That asks the server being
checked for the answer: whoever can replace the package can replace the key. The keys LevelCode
trusts ship inside the app, in `modules/extension-signature/keys.json`, and are read from nowhere
else. The suite runs the verifier with every socket refused to hold it to that.

**Nothing in the editor's source is patched.** A build step puts the module where a built app
looks for it, under the name the editor imports:

```
LevelCode.app/Contents/Resources/app/node_modules/@vscode/vsce-sign/
    index.js   keys.json   package.json
```

This is the same move as `strip-proprietary.mjs`: done to the built app, never to `vscode/`, with
nothing to re-apply on a Code-OSS bump. The package is `private`, version `0.0.0-levelcode`, and is
never published; the name is the editor's import, not a claim to be Microsoft's module.

## What a verified signature means

It is a **repository signature**: this file is, byte for byte, what Open VSX published.

It does **not** mean the publisher signed it, and it does not mean the extension is safe. A
malicious extension that Open VSX accepted verifies perfectly. Nor does it say the package is the
newest: an older version the registry once signed still verifies, and what stops one being served
in place of another is the editor's own comparison of the package's name and version with what
the gallery listed. What the signature rules out is a package changed between the registry and
the editor: a tampered mirror or cache, a download corrupted on the way, a response rewritten by
something in the path.

## Where it runs

| When | What | If it fails |
| --- | --- | --- |
| `build-macos.sh`, after the strip steps | `install --replace`, then `check` | The build fails |
| `release.yml`, after the build | `smoke` on the built app | The job fails; a registry that cannot be reached is a warning |
| `release.yml`, in the test gate | `registry` | The release stops before the hour-long build; unreachable is a warning |
| `make-dmg.sh` step 0, before signing | `install`, then `check` | The app is not signed |
| Every pull request | The suite, via `test-extensions.sh` | The gate is red |

All four commands are `node scripts/extension-signature.mjs <command>`.

- **`install <app-code-folder>`** copies the three files. Doing it twice changes nothing. A build
  passes `--replace`: this checkout decides what the build ships. Signing does not: an app that
  already carries LevelCode's verifier keeps it, because the keys an app trusts are its build's and
  not the signer's. A module of that name that is *not* LevelCode's is an error either way.
- **`check <app-code-folder>`** fails unless: the module is there, is LevelCode's, and is only the
  three files; the built editor still names `@vscode/vsce-sign` (today in two bundles, the shared
  process and the command line); from each of those files the name resolves to this module; and
  the module, imported by that name from that folder in a process of its own, accepts a real Open
  VSX package and refuses the same package with one byte changed.
- **`smoke <LevelCode.app>`** asks the app. It runs the app's own command line
  (`--install-extension perrinjerome.git-rebase-syntax`) as a command-line process, with its own
  data and extension folders in a temp directory, and reads the app's log for
  `Extension signature verification result … Success. Executed: true`. No window opens and
  nothing of an installed LevelCode is touched. Run against 1.3.1 it fails with "not executed",
  which is the bug.
- **`registry`** is described below.

`<app-code-folder>` is `LevelCode.app/Contents/Resources/app`.

## What a user sees when verification refuses

The editor shows the result **code** and nothing else. The module's explanation goes to the log
at trace level only: run with `--log trace`, or *Developer: Set Log Level… → Trace* and read the
**Shared** log, and look for `Extension signature verification output`.

| Code | What happened | What to do |
| --- | --- | --- |
| `PackageIntegrityCheckFailed` | The package's SHA-256 is not the one its signature archive states. Damaged or altered on the way. | Try again. If it repeats on another network, report it to Open VSX. |
| `Untrusted` | The package matches its archive, but no key this build trusts signed it. | Almost always: Open VSX changed its key and this LevelCode predates it. Update LevelCode. |
| `SignatureIsInvalid` | The signature does not verify and the archive cannot say why. | As above, then as the first row. |
| `NotSigned` | The registry listed the extension with no signature. (The editor's own code, not the module's.) | See "Limits". |
| `SignatureArchiveHasTooManyEntries`, `SignatureIsMissing`, `SignatureIsUnreadable`, `SignatureArchiveHasSameSignatureFile` | The archive is not shaped like a signature archive. | Try again; if it persists the registry is serving something new. |
| `SignatureArchiveIsUnreadable`, `PackageIsUnreadable` | A downloaded file could not be read from disk. | Disk or permissions on this machine. |
| "end of central directory record signature not found" | The archive is not a readable zip (`SignatureArchiveIsInvalidZip`); the editor reports it in its own words for a corrupt download. | Try again. |

Every one of these is a refusal. `Untrusted` and `PackageIntegrityCheckFailed` differ only in
wording: the manifest that tells them apart is not signed, so an attacker can choose which one a
tampered package produces. Neither can be turned into a pass.

The dialog still offers **Install Anyway (Don't Verify Signature)**, as upstream does. Its
**Learn More** button still opens Microsoft's page about the VS Code Marketplace, which does not
describe any of this; pointing it somewhere true needs a core patch or a de-brand rule, and is
not done yet.

## The pinned key

| | |
| --- | --- |
| Id | `14ccb407-4e79-41ed-be5a-6d608325c45a` |
| Key | Ed25519, `MCowBQYDK2VwAyEAje+vAaSS1zHV5WHCJSa5UXvxRo6+yerEU3IEmtuEuF4=` (base64 of the SPKI DER) |
| Served at | `https://open-vsx.org/api/-/public-key/14ccb407-4e79-41ed-be5a-6d608325c45a` |
| Pinned | 2026-10-04 |

How it was checked before it went in: it was named as the signing key by every one of 762
extensions sampled that day (the newest, the oldest back to March 2020, the most and the least
downloaded; none was unsigned, none named another key), and the signatures of 64 of them — 87 MB
of packages published between 2020 and that day — were verified against the downloaded files.
Then the shipped 1.3.1 app's own code, copied and given the module, installed Claude Code and
EditorConfig with `Success. Executed: true` in its log, and refused them with another key pinned.

That establishes that this is the key Open VSX signs with. It does not establish it through any
channel other than open-vsx.org over TLS: Open VSX publishes no fingerprint elsewhere that we
know of. A key swapped in on the day of pinning, for everything we downloaded that day, would
have passed. That is the residual risk of pinning on first use, and the reason a *change* of key
is handled with more suspicion than the first one.

## When Open VSX changes its key

**What happens at Open VSX.** Its server has one setting for this, `ovsx.integrity.key-pair`
(`GenerateKeyPairJobRequestHandler` in `eclipse-openvsx/openvsx`):

- `renew` generates a new key pair, makes it the active one, and queues a job per extension
  version to sign it again. New uploads are signed with the new key at once. Existing versions
  change over as the queue drains: hours at least, for a registry of this size.
- `delete` removes every signature and every key. The registry then lists everything unsigned.

**What happens in LevelCode.** Every shipped build trusts only the keys it was built with. As
versions are signed again, those builds refuse them with `Untrusted`: installs fail, and the
automatic update of extensions fails without a dialog. Nothing already installed stops working.
Users can still click *Install Anyway*, which is exactly the habit this feature exists to end, so
the gap should be short. After `delete`, every install is refused with `NotSigned`.

**How you find out.** The release gate's `registry` step fails, or a user reports `Untrusted`.
To ask by hand:

```bash
node scripts/extension-signature.mjs registry
```

It exits 1 and names the new key id and where the registry serves it. It exits 1 only on
evidence: a key id that is not pinned, signatures that stopped verifying under a pinned key, or a
registry that lists no signatures at all. If it merely could not ask, it warns and exits 0, or 2
with `--strict`.

**What to do.**

1. **Find out why the key changed, from somewhere other than the registry's API.** Look for an
   announcement: the [`eclipse-openvsx/openvsx`](https://github.com/eclipse-openvsx/openvsx)
   issues and discussions, the Open VSX status page and blog, the Eclipse Foundation's security
   advisories. A routine renewal and a compromised key need different answers in step 5. If there
   is no word anywhere, ask (an issue on that repository) before trusting the new key. An
   unannounced key that only you see is what an attack on your network path looks like.
2. **Fetch the new key, more than once.** From two networks (a phone hotspot is another network),
   and compare:

   ```bash
   curl -fsS https://open-vsx.org/api/-/public-key/<new-id>
   ```

   The value for `keys.json` is the body of that PEM: the base64 between the `BEGIN` and `END`
   lines, with no line breaks.
3. **Add it to `modules/extension-signature/keys.json`** as a second entry. Fill in `pinned` and
   `evidence` with what you actually did in steps 1 and 2. Do not remove the old key yet.
4. **Prove it.** `registry` must now exit 0, and the suite must pass:

   ```bash
   node scripts/extension-signature.mjs registry
   ./scripts/test-extensions.sh
   ```

5. **Decide about the old key.**
   - *Routine renewal:* keep both for now. Versions not yet signed again still carry the old
     signature, and a build that trusts only the new key would refuse those instead.
   - *The old key was compromised:* remove it in this same change. Whoever holds it can sign
     anything, and a build that still trusts it will accept that. Some not-yet-re-signed versions
     will be refused until the registry catches up; that is the right trade.
6. **Release.** Auto-update carries the new keys to users; until they update, they are in the gap
   described above. Say so in the release notes, in those words: installs and extension updates
   fail with `Untrusted` on older versions, and updating LevelCode fixes it.
7. **Afterwards, drop the old key.** When `registry` prints
   `note — pinned key <old-id> is named by none of the … newest extensions`, the old key signs
   nothing new. Give the re-signing time to finish, then remove the old entry in the next release.
   The two fixture packages were signed with it and go with it: replace them
   (`modules/extension-signature/test/fixtures/README.md`) in the same change, or the suite and
   `check` will fail, correctly.

If Open VSX has stopped signing altogether, there is no key to add. That is a decision, not a
runbook step: ship with verification relaxed, or wait. Raise it before doing either.

## When Code-OSS is bumped

The module depends on four things in the editor, none of which LevelCode controls:

1. It is loaded with `import('@vscode/vsce-sign')`.
2. It is called as `verify(vsixFilePath, signatureArchiveFilePath, verbose)`.
3. The answer is read as `{ code, didExecute }`, where `code` is an
   `ExtensionSignatureVerificationCode` and `Success` is the only one that installs.
4. The module is looked up in the app's plain `node_modules` folder.

`check` catches a change to 1 and 4 at build time, and fails the build. `smoke` catches all four,
because it asks the app, but only where there is a network. After a bump, run both against the
new build before anything else:

```bash
node scripts/extension-signature.mjs check VSCode-darwin-arm64/LevelCode.app/Contents/Resources/app
node scripts/extension-signature.mjs smoke VSCode-darwin-arm64/LevelCode.app
```

If either fails, read `src/vs/platform/extensionManagement/node/extensionSignatureVerificationService.ts`
in the new tag first; it is about 130 lines and the whole contract. The result codes are in
`common/extensionManagement.ts`, and the suite keeps a copy of that list (`EDITOR_CODES`) to
compare against.

Should upstream ever ship a verifier of its own that works against Open VSX, this module should
go, not be kept beside it.

## Limits

- **`Install Anyway` exists**, and `extensions.verifySignature: false` turns verification off
  entirely. Both are upstream's. Anyone who set that to work around the old refusal is still
  unprotected until they remove it; say so in the release notes for the version that ships this.
- **An extension the registry lists without a signature is refused** (`NotSigned`), because the
  editor treats a gallery configured in `product.json` as fully signed. Of 762 sampled on
  2026-10-04, none was unsigned.
- **A `.vsix` installed from a file is not verified.** It has no signature archive. Upstream is
  the same.
- **A run from source does not enforce any of this.** The editor only refuses on a built app, and
  `run-dev.sh` has no module installed. Verification is tested on a build, or with `check`.
- **Verification reads the whole package into memory.** Pure Ed25519 hashes the message twice, so
  it cannot be streamed; Open VSX's own signer has the same constraint. A 300 MB extension costs
  300 MB for a moment. The signature check itself runs off the event loop.
- **The keys are only as good as the day they were pinned.** See "The pinned key".
- **macOS only today.** The module is plain JavaScript; a Linux or Windows build would run the
  same `install` and `check` against its own code folder.
