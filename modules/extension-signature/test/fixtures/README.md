# Fixtures: real packages from Open VSX

Two extension packages exactly as [Open VSX](https://open-vsx.org) serves them, each with the
signature archive the registry serves beside it. They are here so the suite can show, offline, that
the key LevelCode pins verifies what the registry really publishes — and that one changed byte is
refused. `scripts/extension-signature.mjs check` uses the first pair for the same purpose on a built app.

They are other people's work, redistributed unmodified under their own licences. Each package
carries its licence text inside (`extension/LICENCE`, `extension/LICENSE.txt`).

| File | From | Licence | Copyright |
| --- | --- | --- | --- |
| `perrinjerome.git-rebase-syntax-0.0.1.vsix` + `.sigzip` | https://open-vsx.org/extension/perrinjerome/git-rebase-syntax · https://github.com/perrinjerome/git-rebase-syntax | MIT | © 2020 Jérome Perrin |
| `coolbear.systemd-unit-file-1.0.6.vsix` + `.sigzip` | https://open-vsx.org/extension/coolbear/systemd-unit-file · https://github.com/bearmini/vscode-systemd-unit-file | MIT | © 2018 Takashi Oguma |

Chosen for being small, old, plainly licensed, and unrelated to LevelCode. Downloaded 2026-10-04 and
signed by Open VSX key `14ccb407-4e79-41ed-be5a-6d608325c45a`.

## SHA-256

The suite checks the files against this list.

```
a5417f80c1d595651c36ea09deff10a4a32f18920d109e07ed8f21ab986632ce  perrinjerome.git-rebase-syntax-0.0.1.vsix
a5d0c14abab355c71d9c7cf589a5ac1666fdd24a1614a19a7cd1d8ddab7b9af7  perrinjerome.git-rebase-syntax-0.0.1.sigzip
b707f0152c9f00274a88163586a07e4e062065f8edee3a1dda9c1f925f283319  coolbear.systemd-unit-file-1.0.6.vsix
2784cc4e40f9bb1b3e09aa9ee52a1d676017fa8055517b680b9a1793de20d59b  coolbear.systemd-unit-file-1.0.6.sigzip
```

## Replacing them

A fixture is replaced only when Open VSX changes its signing key and the old key is being dropped
from `keys.json` (`docs/EXTENSION-SIGNATURES.md`): the registry signs every package again with the
new key, and these archives, made with the old one, stop verifying. Download both files of a
package again, update the list above, and run the suite.

```bash
cd modules/extension-signature/test/fixtures
for f in perrinjerome/git-rebase-syntax/0.0.1/file/perrinjerome.git-rebase-syntax-0.0.1 \
         coolbear/systemd-unit-file/1.0.6/file/coolbear.systemd-unit-file-1.0.6; do
  curl -fsSLO "https://open-vsx.org/api/$f.vsix" && curl -fsSLO "https://open-vsx.org/api/$f.sigzip"
done
shasum -a 256 *.vsix *.sigzip
```
