# LevelCode v1.3.1

One fix you will feel: the chat stays where it is. Past a conversation's first long turn, scrolling beyond the end of the transcript slid the whole chat — transcript, composer and status row — up over a blank page. It has done that since v1.1.0. The rest of this release is for people who run LevelCode from source: the dev editor is now its own app to macOS, so a sign-in started there comes back there.

## Highlights

### The composer stays put

The chat is a page exactly one window tall, and the transcript is the only thing in it meant to scroll. The composer and the status row sit under it and should never move. From the second turn of any conversation whose first one was long, they did: reach the end of the transcript, keep scrolling, and the whole chat rode up together with blank space beneath it.

The page itself had become scrollable. Since v1.1.0 the speaker label — "You", "LevelCode AI" — is kept for screen readers and taken off the screen, with the usual rule for that: out of flow, one pixel, clipped. Nothing above the label was positioned, so it was laid out against the **page** rather than the transcript, at its unscrolled place in the log, where the log's own scrolling and clipping do not reach. A message that started more than a window down had its label below the fold, the page grew to reach that one pixel, and once the transcript was at its end the wheel scrolled the page.

The transcript is now the anchor for everything inside it. The label is as it was — off screen, and still read out.

| Measured in a 1118px window, two turns | v1.3.0 | Now |
| --- | --- | --- |
| Page height | 1963px | **1118px** — the window |
| Composer after four wheel ticks at the end of the transcript | 400px higher, blank page beneath | **unmoved** |
| Transcript content height | 2919px | 2919px — nothing inside it moved |

Scrolling up inside the transcript still pauses auto-scroll and offers "jump to latest".

**What it deliberately does not do: lock the page.** `overflow: hidden` on the page would have hidden the symptom and left the cause. It would also have cost something real: in a window too short for the composer and the status row — they need 208px — scrolling the page is the only way to reach the bottom controls.

**What is proven, and what is not.** The numbers above were measured in Chromium against the shipped chat page, served the way the editor serves it and driven with the editor's own messages. They were not taken from a packaged build.

### Running from source: the dev editor is its own app

To macOS, the editor started by `./scripts/run-dev.sh` and the LevelCode in /Applications were the same app: one bundle identifier, one `levelcode://` scheme. Sign-in ends with the browser opening a `levelcode://` link, and macOS decides which app that belongs to. It picked the installed one. The dev editor that had asked never heard back, and the installed editor was handed a sign-in it had not started.

`run-dev.sh` now gives the dev run an identity of its own — the scheme `levelcode-dev` **and** the bundle identifier `ai.levelcode.app.dev`. A scheme alone would not have been enough: with one shared identifier macOS can still hand a launch, or a link, to whichever copy is running.

- **It is set on every launch,** in the two places it lives: what the editor believes at runtime, and what macOS believes about the dev bundle. Both or neither — the two files change as one change, and a failure half-way is undone.
- **The launch waits for macOS to agree.** After registering the bundle, the script asks macOS which app opens `levelcode-dev://` and stops unless the answer is this bundle. Being told about a bundle is not the same as agreeing to use it: one under a temporary folder is registered and never chosen.
- **The sign-in code did not change.** It already asked to be called back on the editor's own scheme, whatever that is.
- **The installed app is untouched.** Its identity is the product's, and a build is now checked for it (below).

**A server has to be told to accept the scheme.** No server does by default — LevelCode Cloud included — so from a source build, a LevelCode Cloud sign-in ends on the account page in the browser and the editor hears nothing. Your own key works as it always has. If you run the backend yourself, set `LEVELCODE_EXTRA_EDITOR_SCHEMES=levelcode-dev` on it; it accepts `levelcode-<variant>` and nothing else.

On the first run after updating: quit a dev editor that is already open, because a second launch joins the running one and that one still has the old identity. macOS may also ask again for folder access — to it, this is a new app.

### A build is checked for the identity it ships with

`scripts/build-macos.sh` now fails a build that is not `levelcode://` and `ai.levelcode.app`, or that carries the from-source overrides file. The dev identity lives outside the product definition and cannot be picked up by a build; the check says so out loud, before anything else is done to the app. It ran on both architectures in this release's build.

## Also changed

- **`run-dev.sh` lost its `pkill`.** It targeted the binary name the app had before it was renamed, so it had been matching nothing. The reason it gave — dev and packaged builds sharing a bundle identifier — is what this release removes.

## Not in this release

**The Sessions panel still does not search.** It was the stated gap in v1.0.5, v1.1.0, v1.2.0 and v1.3.0, and it is the stated gap again.

**A source build cannot sign in to LevelCode Cloud.** That follows from the scheme being off by default, and it is new: on a Mac with no installed LevelCode, a source build could complete that sign-in, being the only app that claimed `levelcode://`.

**The website's IDE link still opens the installed app.** It is written with the shipped scheme, so in a development setup it does not reach the dev editor.

**The editor still acts on a callback it did not ask for.** Ignoring a sign-in callback when no sign-in is in flight would make a misrouted one harmless; today it is merely unlikely.

**Off macOS, the dev scheme is not registered with the system.** The script says so and sets the runtime half alone.

## Test coverage

- **49 suites**, **892 cases** across the bundled extensions — all green. v1.3.0 measured the same way was 48 suites and 854 cases.
- `test/editorIdentity.test.js` (37 cases, new) — the two identities and the shape a server accepts; the dev bundle changing in two lines and nowhere else; the two files changing as one, with the undo; a registration that fails, or that macOS does not act on; the release check; and the real sign-in function run under each scheme. It runs on fixtures and cannot reach LaunchServices: the script's macOS object is replaced with one that throws.
- `test/webviewCss.test.js` (36 cases, one new) — the transcript is positioned and stays positioned, with the page's one-window premise pinned beside it. No DOM test can see this bug, since a fake DOM lays nothing out; the guard fails on v1.3.0's chat page.

**Full changelog:** https://github.com/levelcodeai/levelcode/compare/v1.3.0...v1.3.1
