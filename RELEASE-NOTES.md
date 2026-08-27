# LevelCode v1.2.0

Take a screenshot, `⌘V` into the composer, ask why the layout is wrong. That is the whole feature, and most of this release is the work underneath it — a token meter that tells the truth about pixels, a store that keeps your screenshots on your own disk, and a gate that stops an image reaching a model that cannot see it. The transcript also stops narrating itself, and Sessions is one click from the chat tab.

## Highlights

### Paste a screenshot, ask about it

Three ways in, in the order you will actually use them:

- **Paste.** `⌘V` a screenshot straight into the composer. No dialog, no upload step, no file to manage.
- **The image button** in the composer, or **AI: Attach Image to Chat** from the palette. It offers the image tabs you already have open before it offers a file dialog — the picture you want is usually one you were just looking at.
- **Drag a file from Finder** onto the chat. This one needed a core patch; see below.

`png`, `jpeg`, `gif` and `webp` are accepted and nothing else — that is the list the vision APIs take, so a wider net would only fail later and further away. Each attachment becomes a chip under the composer with a thumbnail, its cost in tokens, and a remove button. Up to **five images per message** by default, and when there is more than one they are introduced to the model as `Image 1:`, `Image 2:` so that "the second screenshot" has something to refer to on this turn and every turn after it.

### Your screenshots never leave your machine

Bytes are written beside the session that used them, content-addressed by SHA-256:

```
~/.levelcode/sessions/<project-slug>/media/<sha256>.png
```

The conversation, the session log and the token meter all carry a **reference**, never the bytes. That is not a size optimisation: listing your History re-parses every session file in a project whenever the index is missing or on an older schema, and inlined base64 would make drawing a list of session titles parse every screenshot in every session you have ever taken.

Nothing is uploaded. There is no bucket, no signed URL and no retention policy to read, because there is nothing on our side to retain — which is also the only shape that works for BYOK, where the editor talks to your provider directly and a detour through our infrastructure would contradict the promise that we are not in the middle.

Because the same screenshot pasted twice hashes to the same file, a re-paste after a failed send costs a hash and a stat rather than a second copy.

**Media is swept, not orphaned.** Sessions are append-only and deleting one writes a lifecycle event rather than removing the transcript, so "the images go away with the session" was never going to be true. A sweep runs when a session is sealed and removes media nothing refers to any more — with a **seven-day age floor**, because a plain unreferenced-means-delete rule would delete the images of the conversation you have open right now.

### The context meter stopped lying about images

The estimator measured `JSON.stringify(messages).length / 4`, which is sound for text and catastrophic for an image. Base64 books about a third of its byte count as tokens, so a 1 MB screenshot read as roughly **333,000 tokens** — larger than most context windows — for something that really costs about 4,800. Storing refs instead of bytes then swung it the other way and reported a ~1,800-token image as about 18.

Images are now counted by what they actually cost. Claude sees an image as 28×28 patches, so the price is `⌈w/28⌉ × ⌈h/28⌉` visual tokens, capped per model tier:

| Model tier | Long edge | Token cap |
| --- | --- | --- |
| Claude 4.7 and later, including the 5 line | 2576 px | 4784 |
| Everything else | 1568 px | 1568 |

An unknown model falls to the standard tier and an unknown size assumes the cap, so the meter fails toward over-counting rather than under.

Worth being plain about the scope: **today this only misreported the meter you look at.** Compaction cuts on message count and goal boundaries and never reads a token number, so nothing was being silently evicted. It becomes a correctness bug the day anything automatic keys off that figure, which is why it is fixed now rather than later.

### Screenshots are resized before they are sent

The long edge is capped at **2000 px** in the webview before anything is stored or sent. An image already under the cap is **passed through untouched, in its original format** — re-encoding a screenshot of text only stacks compression artifacts on the thing that most needs to stay legible. One that is over gets a single resize and a single WebP pass at quality 0.92.

The cap is 2000 rather than the more obvious 1568 because the server caps the *cost* at 4784 tokens either way, so the extra pixels buy legibility on small editor text for tokens that were already being spent. Measured on a dense 4K editor screenshot — small text edge to edge, the worst case for re-encoding — **770 KB → 189 KB on the wire**, and 4784 → 2952 tokens. Shots with more flat UI in them compress harder than that.

| Source | Sent as | Visual tokens |
| --- | --- | --- |
| 4K screenshot 3840×2160 | 2000×1125 | 2952 |
| macOS retina window 3024×1964 | 2000×1299 | 3384 |
| 1080p screenshot 1920×1080 | unchanged | 2691 |
| Half-screen 1280×1440 | unchanged | 2392 |

Budget roughly **2,400–3,900 tokens per screenshot**, and remember it rides along on every subsequent turn in that conversation.

### Dropping a file on the chat needed a core patch

VS Code's workbench claims OS file drops before a webview iframe ever sees them, so a drag out of Finder arrived with an empty `dataTransfer.files` and the editor helpfully opened your screenshot in an image tab instead. The chat now handles the drop in `editorDropTarget.ts`, reads the paths, and hands them to the extension.

**If you build from source, this is a core patch, not an extension change** — a fresh `vscode/` clone needs `patches/levelcode-core.patch` applied by `bootstrap.sh` before drag-and-drop works. Two things cost real time here and are written down in `docs/IMAGES.md` so they cost nobody else any: extension webview view types are rewritten with a `mainThreadWebview-` prefix before they reach the drop target, so matching the bare id makes the patch silently inert; and holding Shift takes a different code path entirely, which means "drag with Shift works" was never evidence that the patch worked.

### An image only goes to a model that can actually see

The provider **and** the model must both declare vision. Reading only the model id meant a custom OpenAI-compatible endpoint returned true for any model whose *name* looked like a vision model, and images went to an endpoint nobody had said could read them.

Four providers declare it: **Anthropic**, **OpenAI**, **OpenRouter** and **xAI**. Ollama and custom endpoints deliberately do not — a custom endpoint that does serve a vision model needs `vision: true` on its registry entry, because the honest place to declare a provider's capabilities is the provider registry, not a per-user override. In gateway mode the check runs against the gateway's own model, so LevelCode Cloud gets images wherever the model supports them.

The composer refuses an attachment *before* you type anything, and re-checks at send — you can switch models between attaching a screenshot and pressing enter, and that used to produce a provider error instead of a sentence.

### The activity group reads as text, not as a widget

The collapsed header said "3 steps". It now says what actually happened — which files were read, which command ran — because a count is the one thing you can already see. Context is announced **once** when it enters the conversation rather than re-stated every turn, the chevron trails the thing it discloses instead of leading it, and the group rows are inset inside a single container rather than nested in two with a rail down the side.

### Sessions and Project Memory are one click from the chat

Both have a button on the chat tab, and **AI: Project Memory** is a command now. The row actions inside the Sessions panel — Rename, Done, Delete, Pin — were rendered but invisible, showing an empty grey box on hover; they render, and they are visible.

## New settings

| Setting | Default | Description |
| --- | --- | --- |
| `levelcode.ai.chat.maxImagesPerMessage` | `5` | How many images may be attached to one message. Clamped to 1–20 at the boundary — 20 is the API's own ceiling |

## New commands

| Command | Does |
| --- | --- |
| `AI: Attach Image to Chat` | Offers open image tabs first, then a file dialog |
| `AI: Project Memory` | Opens the project's memory from anywhere |

## Also fixed

- **The context and review bars sat flush left** instead of in the transcript column, because a `margin` shorthand overwrote the `margin-inline: auto` that centred them. The guard that now prevents it reads *every* declaration rather than the first — the original check used `.exec()` without the global flag, so it inspected one rule and reported the file clean.
- **Every image thumbnail was broken.** The chat's Content-Security-Policy declared `default-src 'none'` with no `img-src`, so the composer chip rendered as a broken-image glyph.
- **An image with no words returned a 400.** Sending a screenshot with an empty composer produced an empty text block alongside it, which Anthropic rejects. Text-only turns also stay a plain string rather than becoming a single-element array, so cached prefixes do not churn.
- **Agent mode dropped every pasted image.** The send path stored the bytes and then called the agent with the text alone.
- **Opening without a folder refused images outright**, on the same guard that used to refuse everything else.
- **The × on an image chip could not remove it**, and the target was too small to hit reliably. Both fixed, and the cap moved into one setting rather than being written in two places.
- **A send can no longer outrun its own attachment.** Normalisation is async, so pressing enter mid-decode posted an attachment with no data — refused at the host, and the image vanished from a message you had watched it attach to. The send path now waits on in-flight work and refuses a placeholder outright.
- **The provider boundary fails loudly.** Translating a conversation for an OpenAI-compatible provider silently dropped content blocks it did not recognise. It now throws, because a request that quietly discards its own subject is the exact failure this feature exists to avoid. Extended-thinking blocks remain an explicit, deliberate drop.

## Not in this release

**The Sessions panel still does not search.** No filter, no fuzzy switcher, no keyboard jump. It was the stated gap in v1.0.5 and in v1.1.0, and it is the stated gap again — the chat surface took another cycle.

**Images are re-sent on every turn.** Base64 rides along with each subsequent request in a conversation, so a screenshot you attached ten turns ago is still being uploaded. The Files API fixes this properly by uploading once and referencing thereafter, but it is Anthropic-direct only, so it cannot be the primary path in a multi-provider client. Deferred deliberately, and the cost is bounded by the resize.

**Custom endpoints cannot opt into vision** without editing the provider registry. That is the correct default and the wrong end state; a per-endpoint capability declaration is the missing piece.

**The sweep's seven-day floor is hard-coded.** It is the right default and it should probably be a setting.

## Test coverage

- **40 suites**, **599 cases** across the bundled extensions — all green. v1.1.0 measured the same way was 36 suites and 527 cases.
- `test/imageAttach.test.js` (30 cases) — the wire shape end to end: images lead and text follows, refs materialise into base64 only when a request is built, the vision gate at attach and again at send, the per-message cap, and multi-image labelling.
- `test/imageCost.test.js` (9 cases) — the arithmetic, pinned against every worked example in the vision documentation: 1092² → 1521, 1920×1080 → 2691, 3840×2160 → 2576×1449 at 4784, and that nothing is ever scaled *up*.
- `test/imageStore.test.js` (11 cases) — content addressing, the 5 MB ceiling, path-traversal refusal on a ref, a missing file throwing rather than sending a request without its subject, and the sweep's age floor.
- `test/contextAnnounce.test.js` (5 cases) — context enters the conversation once and is not re-announced.
- `test/translate.test.js` gained 92 lines covering the boundary that now throws instead of dropping blocks.

**Full changelog:** https://github.com/levelcodeai/levelcode/compare/v1.1.0...v1.2.0
