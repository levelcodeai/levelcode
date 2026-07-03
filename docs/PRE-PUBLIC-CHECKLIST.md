# Pre-public / release hygiene checklist

The gate before making this repo (or a release) public. Re-run the secret + build checks before any
public push; they're cheap and the failure mode is permanent (git history is forever, even after a
force-push, because forks/caches/crawlers may already have it).

## 1. Hygiene gates

- [x] **No secrets in history or tree.** No API keys, tokens, private keys, or `.env` files in any
      commit. Re-verify:
      ```bash
      git grep -InE "sk-ant-[A-Za-z0-9_-]{20}|sk-[A-Za-z0-9]{40}|sk_live_[A-Za-z0-9]{20}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY|ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{40}|xox[baprs]-" $(git rev-list --all)
      git ls-files | grep -iE "\.env($|\.)|secret|credential|\.pem$|\.key$|id_rsa"   # expect: no matches
      ```
      Atom++ keeps provider API keys in the OS keychain (VS Code SecretStorage) — never in code.
- [x] **LICENSE is MIT + Code-OSS attribution.** `LICENSE` is MIT and carries the Code-OSS / Microsoft
      derivative notice + "not affiliated with Microsoft" + "upstream fetched at build, not redistributed."
- [x] **`.gitignore` excludes generated/heavy paths.** `/vscode/` (the disposable Code-OSS checkout),
      `VSCode-*/` build outputs, `*.dmg`, `node_modules/`, `.DS_Store`, `out/`.
- [x] **README reflects reality.** No stale "M0 / branding-only / working codename" framing; states what
      works today + how to build.
- [ ] **No stray scratch files staged.** Confirm the tree is only the product (e.g. no `foo.js`,
      `calculator.html`, `server.py`, `site/`, ad-hoc PDFs). `git status` should be clean of these.
- [ ] **Never commit `vscode/`** — it's the gitignored, regenerated upstream checkout.
- [x] **No internal strategy / pricing docs.** No PRD, roadmap, monetization/pricing, competitive, or
      private-infra design docs in the tree *or history* — e.g. `PLAN.md`, `docs/atompp-cloud-PRD.md`,
      and the run-persistence / sync / update-flow design docs. These are gitignored and were scrubbed
      from history with `git filter-repo` (working copies kept locally, untracked). Re-verify:
      ```bash
      git grep -lIE "gross margin|markup M=|thin\.ly|systemu-net" -- . ':(exclude)vscode/*' ':(exclude)docs/PRE-PUBLIC-CHECKLIST.md'   # expect: no matches
      ```

## 2. Flatten to a clean root (one-time, before first public push)

The project should be the repo *root*, not nested under `atom-plus-plus/`. Do this on a **fresh clone**
(git-filter-repo's required workflow — never on your working dir), which also drops the old outer-level
junk from *all* history:

```bash
brew install git-filter-repo
# Clone the LOCAL repo (picks up your latest commits — no round-trip through the old remote).
# Commit any pending README/doc changes first; a clone only carries committed history.
git clone <your-local-checkout> /tmp/app-clean
cd /tmp/app-clean
git filter-repo --subdirectory-filter atom-plus-plus     # the atom-plus-plus/ SUBFOLDER becomes the root; outer junk gone from history
git remote add origin git@github.com:atom-plus-plus/atompp.git   # org = atom-plus-plus, repo = atompp (matches atompp.ai)
```

Result: `CLAUDE.md`, `extensions/`, `LICENSE`, `README.md` at the root; all commits preserved
(hashes rewritten); every outer-level stray removed from history. After this, re-clone from the new org
for ongoing dev so local matches the public root.

## 3. Push private → verify → public

1. `git push -u origin develop` to the new org while it's **private**.
2. Browse it on GitHub: root looks right, README renders, LICENSE detected, no stray files, no secrets.
3. Only then flip the repo to **public** in Settings.

## 4. Nice-to-have before/soon after going public

- [ ] Repo description + topics + the `atompp.ai` link in the About panel.
- [ ] A `CONTRIBUTING.md` and an issue template (once you want outside contributions).
- [ ] A tagged release + the `.dmg` as a downloadable asset (when you cut one).
- [ ] `SECURITY.md` with how to report vulnerabilities (BYOK/keychain model is a selling point — say so).
