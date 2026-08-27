# Image input — paste a screenshot, get an answer about it

**Status:** design, not built. Seven slices, I1–I7.

The target is the interaction Cursor and the Claude Code console already have: take a screenshot, `⌘V` into the composer, ask "why does this look wrong". No dialog, no upload step, no file management.

The interaction is the easy part. This document is mostly about four things in our codebase that will quietly break when the first image goes through, and the cost model that decides how the bytes should be shaped before they leave the webview.

---

## 0. What is true today

Verified against `develop`, not recalled.

**The conversation carries strings, not blocks.** `handleSend` assembles context and text into one string:

```js
const userContent = blocks.length ? (blocks.join('\n\n') + '\n\n' + text) : text;
conversation.push({ role: 'user', content: userContent });
```

`blocks` here are *text* fragments — the workspace map, file contents, pending context. There is no shape in which an image could be expressed. This is the structural change, and everything else follows from it.

**`translate.js` silently drops any block it does not recognise.** Both the flatten path and the user-message path enumerate known types and fall through:

```js
if (b.type === 'tool_result') { … }
else if (b.type === 'text') { trailingText += (b.text || ''); }
// an image block reaches here and is discarded, without a trace
```

This is the most dangerous thing in the list. On any OpenAI-compatible provider — which is most of them through the gateway — an attached image would **vanish between the composer and the wire**, and the model would answer confidently about text it never saw. No error, no warning, no log line. A user would reasonably conclude the model is hallucinating.

**The vision capability is already modelled, and nothing gates on it.** `providers/catalog.js` carries `vision: true` per model and has done since the multi-provider work. It *is* read — `describeCaps` renders "vision" in the model picker's detail line — but no behaviour turns on it:

```js
'claude-opus-4-8':           { context: 200000, tools: true, vision: true, caching: true },
'gpt-4o':                    { context: 128000, tools: true, vision: true },
```

There is a `supportsToolsForModel(providerId, modelId)`. There is no `supportsVisionForModel`. The data exists and the decision does not.

**The context meter measures bytes, not tokens.** `agentMemory.js`:

```js
function estimateMsgTokens(msgs) {
  return Math.round(msgs.reduce((n, m) => n + JSON.stringify(m).length, 0) / 4);
}
```

Sound for text. For a base64 image it charges roughly **one third of the byte count as tokens** — a 1 MB screenshot books ~333,000 phantom tokens, which is larger than most context windows, for an image that actually costs ~4,800.

**What that does and does not break, checked rather than assumed.** An earlier draft of this document claimed the bad estimate would make `findCompactionCut` evict real history on the first paste. That is wrong, and a reviewer caught it. `findCompactionCut` cuts on message count and goal boundaries and never looks at a token number; `compactAgentMemory` uses `estimateMsgTokens` only for its before/after report. The function's own comment says as much — *used only for the UI meter*.

So the live consequence is narrower: the context meter reads wildly high the moment an image is attached, telling someone their context is full and they should start a new chat when it is nowhere near. That is still worth fixing — it is the meter reading the wrong quantity entirely — and it becomes a correctness bug rather than a display one the day any auto-compaction policy is keyed to that number.

**Nothing in the composer accepts an image.** No `paste`, `drop`, or `DataTransfer` handling in `media/chat.html`. Sessions persist message objects verbatim into append-only JSONL, which is re-read on resume.

---

## 1. The numbers that decide the design

From the vision documentation, checked rather than recalled — the figure I had in mind (`w × h / 750`) is stale and wrong.

**Claude sees 28×28-pixel patches.** An image costs:

```
⌈width / 28⌉ × ⌈height / 28⌉   visual tokens
```

**Each model has a resolution tier, and the server enforces it.**

| Tier | Models | Max long edge | Max visual tokens |
|---|---|---|---|
| High-resolution | Claude 4.7 and later | 2576 px | 4784 |
| Standard | everything else | 1568 px | 1568 |

Images above either limit are **downscaled server-side, preserving aspect ratio**. I reimplemented the rule and checked it against every worked example in the documentation: the **token count matches on all twelve** (1092² → 1521, 1000² → 1296, 1920×1080 → 2691, 3840×2160 → 2576×1449 at 4784), and the sent dimensions match on eleven — one standard-tier row lands a single pixel off (1270 vs 1269 wide, same 1564 tokens), a rounding convention I could not derive from six data points. Cost is exact; geometry is correct to within a pixel:

| Source | Sent as (high-res tier) | Tokens | After our 2000 px cap | Tokens |
|---|---|---|---|---|
| 4K screenshot 3840×2160 | 2576×1449 | 4784 | 2000×1125 | 2952 |
| macOS retina window 3024×1964 | 2380×1546 | 4760 | 2000×1299 | 3384 |
| 1080p screenshot 1920×1080 | unchanged | 2691 | 1920×1080 | 2691 |
| 12 MP phone photo 4032×3024 | 2212×1659 | 4740 | 2000×1500 | 3888 |

**The consequence that shapes everything: token cost is already capped by the server.** Sending a 12 MB PNG does not buy more than 4784 tokens of fidelity — it buys latency and bandwidth. So client-side downscaling is **not** a defence against a token blowup. It is a deliberate fidelity-for-cost trade, and a defence against the *wire*.

Other limits worth designing against:

- **Per image:** 10 MB base64 on the Claude API, 5 MB on Bedrock and Google Cloud.
- **Per request:** 100 images for 200k-context models, 600 otherwise — but the 32 MB request cap is reached first.
- **Above 20 images in one request**, a stricter per-image dimension limit applies; keep every image under 2000 px per side to stay safe.
- **Max dimensions:** 8000×8000.
- **Formats:** JPEG, PNG, GIF, WebP only. Animations unsupported — only the first frame is read.
- **Images before text works best.** Placement matters; put the image first in the user turn.
- **Base64 images are resent on every turn.** In a long conversation the same screenshot crosses the wire on every request.
- **Compression artifacts hurt, especially on text**, and repeated compression passes compound. Relevant to us because our images are mostly screenshots of code and UI.

---

## 2. Decisions

### D1 — Widen `content` to blocks, but only when there is an image

`content` becomes `string | Block[]`. Text-only turns keep the string, unchanged.

The alternative — blocks everywhere — is cleaner in the abstract and worse here: it churns every call site that reads `m.content`, changes the on-disk session format for every historical entry, and invalidates prompt caching for conversations that never touch an image. Widening at the point of need costs one type check at the boundary and nothing else.

### D2 — Image first, text after

Documented model behaviour, free to honour. The image block leads the user turn; our existing text context blocks (workspace map, file contents) and the typed message follow.

### D3 — Normalize at the webview boundary: downscale only, single compression pass

Three rules, each earning its place:

**Never upscale.** Writing this document I ran a 1160×480 capture through `sips -Z 1568` and it *grew* from 40 KB to 89 KB — the tool scaled it up to meet the cap. Upscaling costs bytes and tokens and adds precisely zero information. Scale factor is `min(1, cap / longEdge)`, and a factor of 1 means pass through.

**Re-encode only if we resized.** If the source is already inside the cap, forward the original bytes untouched. Every re-encode of an already-lossy source stacks artifacts, and the documentation calls that out specifically for text legibility — which is the entire content of a code screenshot.

**Default cap: 2000 px on the long edge.** *This was 1568 in the plan, argued from first principles. It was wrong, and measurement overturned it — see the note below.*

**⚠️ Corrected during implementation.** Claude Code's own transcripts are on disk, so rather than reason about the right cap I read what Anthropic's client actually ships: **24 images, and every re-encoded one is exactly 2000 px on the long edge**. That is the threshold the vision docs name for staying clear of the stricter per-image dimension limit above 20 images per request — the largest size that is never unsafe. It also sits above both model tiers' own caps, so the server does the final downscale and we never discard fidelity it would have kept. The 1568 argument traded legibility for a saving the server was going to make anyway.

The same transcripts confirmed the pass-through rule above, which had been derived rather than observed: images under the cap go through **untouched, in their original format** (their PNGs stay PNG, their JPEGs stay JPEG), and only oversize ones are resized and re-encoded — to **WebP**, not PNG. That is the second correction: the plan said PNG-in-PNG-out, and WebP at q0.92 is materially smaller for the same screenshot with no visible loss (a 4K PNG grab: 764 KB → 115 KB).

Format policy as shipped: pass through PNG / JPEG / GIF / WebP untouched under the cap; re-encode to WebP only when resizing. Never JPEG a screenshot of text.

Do the work off the main thread — `createImageBitmap` + `OffscreenCanvas` — and revoke every object URL. A 4K decode on the UI thread is a visible stall in a chat window.

### D4 — Bytes on disk, content-addressed; messages carry a reference

The in-memory message and the session log carry:

```js
{ type: 'image', ref: '<sha256>', media_type: 'image/webp', w: 2000, h: 1125, bytes: 115_112 }
```

Bytes live at `media/<sha256>.<ext>` beside the session index. Base64 is materialized **only** when building the provider request, and never retained.

Three reasons. The session JSONL is append-only and fully re-read on resume — multi-megabyte base64 lines make it slow to parse and impossible to read. `postMessage` between webview and extension host would otherwise carry the same blob twice. And content addressing means the same screenshot pasted twice is one file, which is the common case when someone re-pastes after a failed send.

The deciding fact came from this codebase specifically: `sessionStore.scanProject` does `readFileSync` + `JSON.parse` on **every session file in a project** whenever `index.json` is missing, malformed or on an older schema — first run, and after any schema bump. Inlined bytes would make drawing a list of session titles parse every screenshot in every session. Claude Code inlines base64 in its own JSONL and that is fine there; it is not fine here.

**⚠️ Corrected during implementation.** An earlier version of this section said images live beside the session "so they are deleted with it". That was never true: sessions are append-only and `trash()` only writes a lifecycle event, so nothing removed a stored image, ever. Storage is **project-scoped**, and it is bounded by an explicit sweep (`imageStore.sweep` → `sessions.sweepMedia`) that runs on session seal and deletes media no session refers to any more.

The sweep has an **age floor**, which is not incidental: a normal (non-agent) chat writes media whose refs are never persisted to any session file, so an unreferenced-means-delete rule would delete files belonging to a conversation that is still open. A week is long past the point a conversation is live, and it bounds the growth — which was the actual problem.

### D5 — Token accounting must know what an image costs

`estimateMsgTokens` is wrong in both directions: catastrophically over, if base64 lands in the message; quietly under, once refs replace it (a 70-character ref reads as ~18 tokens instead of ~1800).

It needs an explicit branch: for an image block, add `⌈w/28⌉ × ⌈h/28⌉`, clamped to the tier cap for the active model. The dimensions are recorded at normalize time, so this is arithmetic, not I/O.

Getting this wrong is not cosmetic today (the meter lies to the user about how much room they have) and becomes load-bearing the moment anything automatic keys off it.

### D6 — The provider boundary fails loudly

`translate.js` learns the image block:

```js
{ type: 'image_url', image_url: { url: `data:${media_type};base64,${data}` } }
```

And — separately — the fall-through that currently discards unknown blocks becomes an explicit throw. A block type the translator does not understand is a bug in us, and the correct behaviour is a loud failure at the boundary, not a request that looks fine and is missing its subject. This is worth doing on its own merits even before images ship.

### D7 — Gate on the capability that already exists

Add `supportsVisionForModel(providerId, modelId)` alongside `supportsToolsForModel`. The attach affordance is disabled, with the reason named, when the selected model cannot see.

**Both halves must agree.** The first implementation read only the per-model `vision` flag, which meant `custom` — an arbitrary user-supplied OpenAI-compatible endpoint that deliberately declares no vision capability — was handed images whenever the model's *name* looked like a vision model. The registry already enumerates vision providers (anthropic, openai, openrouter declare it; ollama and `custom` do not), so the gate honours the provider capability **and** the model one, exactly as `supportsToolsForModel` already did. A custom endpoint opts in through its registry entry; there is deliberately no per-user override, because the honest place to declare a provider's capabilities is the provider registry.

**And it is re-checked at send.** Gating only at attach time is not enough: a model can be switched between attaching an image and pressing enter, and that path would otherwise hand images to a model that cannot read them. The re-check refuses **without discarding** anything typed or attached.

### D8 — Three ways in; paste is the one that matters

1. **Paste** (`⌘V` with an image on the clipboard) — the 90% case, and the whole interaction being copied.
2. **Drag and drop** onto the transcript or composer.
3. **A picker**, and images already open in a tab.

An attached image shows as a thumbnail chip in the composer — removable, with its size and what it will cost — and renders as a bounded thumbnail in the transcript. Either can be clicked for a full-size view: a 28px thumb cannot tell you *which* screenshot you attached, which is the one thing worth checking before sending.

**⚠️ Drag-and-drop needed a core patch, which this plan did not anticipate.** A webview iframe is **never offered an OS file drop** — VS Code's workbench takes it first and opens the file in an editor tab. Nothing inside the extension can recover it: the panel's own `drop` handler never fires, and a `text/uri-list` fallback has no event to fall back from. This is the one part of the feature that could not be an extension change.

The patch lives in `editorDropTarget.ts` (see `docs/CORE-PATCHES.md`) and forwards the dropped paths to the extension when the chat is the active editor of the group being dropped on. It is deliberately narrow — no split requested, every dropped file an image, paths that resolve — and falls through to the normal handler on any doubt, because a dropped image doing nothing is worse than one that opens.

Two traps worth recording, both found only by testing the real thing:

- The first version compared against the viewType the extension registers. **Extension-created webview panels do not keep it** — the API layer rewrites it to `mainThreadWebview-levelcode.ai.chat` — so the check was silently always false and the patch was inert.
- **Shift-drag is a different code path entirely.** It makes `onDragEnter` return early, the overlay never appears, and `handleDrop` never runs. A report that "drag and drop + shift works" was therefore *not* evidence the patch worked; it was the webview fallback doing the job.

**Because normalization is async, a send can outrun it.** A placeholder chip carries no bytes, so sending mid-decode posts an attachment with no `media_type` and no data — refused at the host, and the image disappears from a message the user watched it attach to. The send path waits on tracked in-flight work and refuses a surviving placeholder outright.

### D10 — Several images are introduced by name

From the vision guidance: with more than one image, precede each with `Image 1:`, `Image 2:` so the question — and every follow-up turn — can refer to them. Without it, "the second screenshot" has nothing to bind to.

Only when there is more than one. A single image needs no name, and labelling it would put a pointless text block ahead of every screenshot anyone pastes.

### D9 — Multi-turn repetition is a known, deferred cost

Base64 rides on every subsequent request. Refs keep *our* history small but do not shrink the wire. The Files API (`{type:'image', source:{type:'file', file_id}}`, beta `files-api-2025-04-14`) fixes it properly by uploading once and referencing thereafter — but it is Anthropic-direct only, so it cannot be the primary path in a multi-provider client. Flagged as a follow-up, sized in §6.

---

## 3. The pipeline

```
clipboard / drop / picker
   │  Blob
   ▼
[webview]  decode → downscale (only if over cap, never up) → encode (only if resized)
   │  { base64, media_type, w, h }        one crossing, one copy
   ▼
[host]     sha256 → write media/<sha>.<ext> → { type:'image', ref, w, h, media_type }
   │
   ├─► conversation[]        (ref — small)
   ├─► session JSONL         (ref — small, readable, resumable)
   ├─► estimateMsgTokens     (⌈w/28⌉ × ⌈h/28⌉, tier-clamped)
   └─► transcript            (thumbnail from a webview-safe URI)
   │
   ▼  at request-build time only
[provider] read file → base64 → Anthropic image block
                              → OpenAI image_url data: URI
                              → throw if the provider cannot carry it
```

---

## 4. Slices

Each is independently shippable and independently revertible. Exit criteria are the guards, and every guard is bypass-verified — the fix is reverted and the test must fail.

**Status: I1–I7 all shipped** in [#90](https://github.com/levelcodeai/levelcode/pull/90), plus the core patch D8 turned out to need. What follows is the plan as written; where the implementation diverged, the decision above it says so.

**I1 — Fail loudly at the translator.** Turn the silent block drop into a throw; add the image → `image_url` mapping. No UI. Ships alone because the silent-drop bug predates images.
*Exit:* a non-text block reaching `translate.js` throws with the block type named; an image block round-trips to `image_url`; the existing text and tool_result paths are unchanged.

**I2 — Vision gate.** `supportsVisionForModel`, exercised nowhere yet.
*Exit:* returns false for a model with `vision: false`, true for `vision: true`, and follows the same exact → basename → family → default resolution chain as `supportsToolsForModel`.

**I3 — The normalizer, pure and tested.** `normalizeImage(bitmapLike, cap)` → `{w, h, scaled, reencoded}`. Pure geometry, no canvas, unit-testable.
*Exit:* never returns dimensions larger than the source; returns `scaled:false, reencoded:false` when already under the cap; preserves aspect ratio within a pixel; the tier-clamped token estimate matches the documented table for all six rows in §1.

**I4 — Store and account.** Content-addressed write, the `{type:'image', ref}` shape, `estimateMsgTokens` learning images.
*Exit:* the same bytes stored twice produce one file; a session containing an image resumes; the meter charges the computed visual tokens and **not** the JSON length — verified by asserting a 1 MB image does not book six figures of tokens.

**I5 — Paste.** Clipboard → normalize → chip → send. The end-to-end path on one input method.
*Exit:* pasting an image produces a chip and no base64 in `conversation`; the chip is removable; a paste of text is unaffected; the request carries an image block before the text block.

**I6 — Drop, picker, and the transcript thumbnail.** The remaining two inputs, and rendering.
*Exit:* dropping an image file and choosing one via Add Files both reach the same normalizer; the transcript renders a bounded thumbnail; object URLs are revoked on teardown.

**I7 — The refusals.** Model without vision, image too large, unsupported format, too many images.
*Exit:* each refuses before the request is built, names the actual constraint, and leaves the composer contents intact so nothing typed is lost.

---

## 5. Budget

Per screenshot, at the shipped 2000 px cap, against doing nothing. The wire figures are measured
from a real 4K PNG through the shipped normalizer, not estimated:

| | Native 4K | Normalized | Change |
|---|---|---|---|
| Visual tokens | 4784 (server-capped) | 2952 | **1.6× fewer** |
| Encoded bytes | 764 KB PNG | 115 KB WebP | **6.6× fewer** |
| Pixels on the wire | 8.3 MP | 2.3 MP | 3.7× fewer |
| Base64 inflation | ×4/3 of encoded bytes | ×4/3 | unchanged — it is the byte count that moves |
| Bytes in the session log | multi-MB per turn | ~70 bytes | ref, not blob |
| Token-meter error | ~333,000 phantom tokens per MB | 0 | the meter bug |

The token saving is smaller than the 1568 plan promised (1.6× rather than 2.7×) and that is the
right trade: the server was going to cap the cost at 4784 either way, so the extra 432 px buys
legibility on small editor text for tokens we were spending anyway. **The bytes are where the real
win is**, and they moved further than the plan expected because resizing re-encodes to WebP.

The last row would have shipped as a mystery report: *"the context meter says I'm full right after
I paste a screenshot."* (An earlier draft claimed it evicted history — it does not; see §8.)

---

## 6. Not in scope

- **Files API upload** (D9). Anthropic-direct only; worth doing once image use is real, and worth measuring first — the win is on repeat turns, not the first one. *Still deferred.*
- **S3 upload via thin.ly's existing integration.** Evaluated and rejected: it cannot serve BYOK (where the editor talks to the provider directly), it would put screenshots of customers' proprietary code in our bucket along with the retention and deletion duties that follow, and the problem it solves on the gateway path has a better answer in the Files API. Revisit only if repeat-turn uplink is measurably hurting gateway users — and then as a cache in front of the Files API, not as the store.
- **Image *output*.** Claude does not generate images. Nothing to build.
- **PDF and document blocks.** Adjacent, different limits, different block type.
- **Coordinates and bounding boxes.** Only interesting if the agent gains a computer-use tool; the resize rule interacts with coordinate mapping and would need its own design.
- **OCR or client-side preprocessing.** The model reads text in images; adding our own pass adds failure modes.

## 7. Open

- ~~**Cap default 1568 or 2576.**~~ **Settled at 2000** by reading what Claude Code actually ships, not by argument. See D3.
- **Whether the workspace-file path should route images through this pipeline at all**, or attach by path and let the tools read them. Attaching by path costs nothing until read; pasting has no path. *Still open — the picker currently reads and normalizes, like any other route.*
- **Whether `custom` endpoints should be able to opt into vision.** Today they cannot without a registry edit (D7). Nobody has asked; the alternative is a per-user override that lets someone declare a capability their endpoint may not have.
- **The sweep's age floor is a week, hard-coded.** It bounds growth without a setting, which is the right default. If someone attaches enough to notice, it should become one rather than shrink.

---

## 8. What this document got wrong

Kept deliberately, because a design note that records where it was wrong is worth more than one quietly rewritten to match the code.

| The plan said | What shipped | Why |
|---|---|---|
| Cap at **1568 px** | **2000 px** | Measured Claude Code's own output instead of arguing from the docs |
| **PNG in, PNG out** | **WebP** when resizing | 764 KB → 115 KB on a 4K grab, no visible loss |
| Cost is `w × h / 750` | `⌈w/28⌉ × ⌈h/28⌉` | A stale prior; the real formula is 28px patches |
| A bad token estimate would make compaction **evict history** | It misreports the **UI meter** | `findCompactionCut` never reads a token number — caught in review |
| Images are "deleted with the session" | Nothing deleted them; there is a **sweep** now | Sessions are append-only; `trash()` only writes a lifecycle event |
| The vision gate reads the **model** flag | **Provider and model** must both allow it | `custom` would otherwise take images by model name alone |
| Drop is handled **in the webview** | Needed a **core patch** | A webview iframe is never offered an OS file drop |
| `describeCaps` "does not read" the vision flag | It does; nothing **gated** on it | Caught in review |
