# LevelCode v0.9.2

A small, practical release: your site **opens itself** in the editor while the agent builds it, and what a run costs is now measured in **credits** rather than dollars.

## Highlights

### The browser opens itself

LevelCode has always shipped a built-in browser — but you had to know the command to find it, so most people never did. Now it appears on its own: the moment the agent starts a web server in the background, the site opens **beside the chat**.

- **It updates as the agent works.** Edits land on disk immediately (that's the apply-then-review model — Keep/Undo comes *after*), so your dev server's watcher fires HMR and the preview refreshes before you click Keep. Ask for a page, watch it appear.
- **It never steals your focus.** A server coming up mid-run doesn't yank the caret away from whatever you're typing.
- **Closing it means closed.** Each address opens at most once per session, so a chatty server can't reopen the tab you just dismissed, and a restart-on-save server can't stack one tab per reload.
- **Only local addresses, ever.** The address is read from the dev server's own output — which is whatever a project's start script chose to print. So only `localhost`, `127.0.0.1`, the IPv6 loopback `[::1]`, and the bind addresses `0.0.0.0` / `[::]` (treated as `localhost`) are opened; a remote URL printed by a script is ignored. A hostile repo can't point your editor's browser somewhere else.

Turn it off with `levelcode.ai.preview.autoOpen`, or open previews yourself with **Simple Browser: Show**.

### Credits, not dollars

The response bar under each run now reads **`Opus 4.8 · 46 credits · 1,279 left`** instead of dollar amounts. $1 = 100 credits, so a $100 Ultra plan is a 10,000-credit allowance.

This is a change of unit, not of price — nothing about what you pay or what a turn costs has moved. A balance that ticks down in dollars reads as money draining away; an allowance reads as something you're meant to spend, which is what it is.

- **Small runs stay honest.** A cheap-model turn costs a fraction of a credit, so it shows as `0.4` rather than rounding to `0` and looking free.
- **One number everywhere.** The editor and levelcode.ai/ai/account now format the same figure identically, down to digit grouping.

## Under the hood

- The dev-server address is sniffed from the **accumulated output**, not a single chunk. Node delivers stdout in arbitrary slices, so a URL routinely arrives split (`http://local` + `host:5173/`) and would otherwise never be recognised — the preview would silently never open.
- `verify.js` gained its first test suite, and shed a stray NUL byte that had been making the whole file invisible to `grep` and `diff`.
- Release builds no longer download a Playwright browser during bootstrap — an unnecessary network dependency that failed one architecture while the other passed.

## Test coverage

- **24 suites** across the bundled extensions, all green on every release.
- `verify.test.js` (16 cases) — the preview sniffers, led by the one that matters: a remote address in command output must open **nothing**. `creditFormat.test.js` (8 cases) extracts the real formatters out of the shipped `chat.html`, so the tests can't drift from what ships.

**Full changelog:** https://github.com/levelcodeai/levelcode/compare/v0.9.1...v0.9.2
