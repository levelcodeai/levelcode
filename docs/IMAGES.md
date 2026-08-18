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

**The vision capability is already modelled, and nothing reads it.** `providers/catalog.js` carries `vision: true` per model and has done since the multi-provider work:

```js
'claude-opus-4-8':           { context: 200000, tools: true, vision: true, caching: true },
'gpt-4o':                    { context: 128000, tools: true, vision: true },
```

There is a `supportsToolsForModel(providerId, modelId)`. There is no `supportsVisionForModel`. Half the gate exists.

**The context meter measures bytes, not tokens.** `agentMemory.js`:

```js
function estimateMsgTokens(msgs) {
  return Math.round(msgs.reduce((n, m) => n + JSON.stringify(m).length, 0) / 4);
}
```

Sound for text. For a base64 image it charges roughly **one third of the byte count as tokens** — a 1 MB screenshot books ~333,000 phantom tokens, which is larger than most context windows. `findCompactionCut` would fire on the first screenshot and evict real conversation history to make room for an image that actually costs ~4,800. This is not a rounding error; it is the meter reading the wrong quantity entirely.

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

Images above either limit are **downscaled server-side, preserving aspect ratio**. I reimplemented the rule and checked it against every worked example in the documentation: the **token count matches on all twelve** (1092² → 1521, 1000² → 1296, 1920×1080 → 2691, 3840×2160 → 2576×1449 at 4784), and the sent dimensions match on eleven — one standard-tier row lands a single pixel off (1270 vs 1269 wide, same 1564 tokens), a rounding convention I could not derive from six data points. Cost is exact; geometry is exact to a pixel:

| Source | Sent as (high-res tier) | Tokens | If we cap the long edge at 1568 | Tokens |
|---|---|---|---|---|
| 4K screenshot 3840×2160 | 2576×1449 | **4784** | 1568×882 | **1792** |
| macOS retina window 3024×1964 | 2380×1546 | 4760 | 1568×1018 | 2072 |
| 1080p screenshot 1920×1080 | unchanged | 2691 | 1568×882 | 1792 |
| 12 MP phone photo 4032×3024 | 2212×1659 | 4740 | 1568×1176 | 2352 |

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

**Default cap: 1568 px on the long edge**, with `levelcode.ai.chat.imageMaxEdge` to raise it to 2576 for dense documents. Reasoning: it is a documented breakpoint rather than an invented one; it more than halves token cost against the high-res cap (1792 vs 4784 on a 4K grab); it stays under the 2000 px many-image threshold; and at 1568 px a typical logical UI screenshot is still supersampled, so text stays legible. Users doing computer-use or dense-document work can raise it.

Format policy: **PNG in, PNG out** — screenshots are flat-colour UI where PNG is both smaller and lossless. Fall back to WebP q0.9 only when a resized PNG exceeds a byte budget. Never JPEG a screenshot of text.

Do the work off the main thread — `createImageBitmap` + `OffscreenCanvas` — and revoke every object URL. A 4K decode on the UI thread is a visible stall in a chat window.

### D4 — Bytes on disk, content-addressed; messages carry a reference

The in-memory message and the session log carry:

```js
{ type: 'image', ref: '<sha256>', media_type: 'image/png', w: 1568, h: 882, bytes: 214_003 }
```

Bytes live at `media/<sha256>.<ext>` beside the session index. Base64 is materialized **only** when building the provider request, and never retained.

Three reasons. The session JSONL is append-only and fully re-read on resume — multi-megabyte base64 lines make it slow to parse and impossible to read. `postMessage` between webview and extension host would otherwise carry the same blob twice. And content addressing means the same screenshot pasted twice is one file, which is the common case when someone re-pastes after a failed send.

### D5 — Token accounting must know what an image costs

`estimateMsgTokens` is wrong in both directions: catastrophically over, if base64 lands in the message; quietly under, once refs replace it (a 70-character ref reads as ~18 tokens instead of ~1800).

It needs an explicit branch: for an image block, add `⌈w/28⌉ × ⌈h/28⌉`, clamped to the tier cap for the active model. The dimensions are recorded at normalize time, so this is arithmetic, not I/O.

Getting this wrong is not cosmetic — the same estimate drives `findCompactionCut`, so a wrong number silently evicts conversation history.

### D6 — The provider boundary fails loudly

`translate.js` learns the image block:

```js
{ type: 'image_url', image_url: { url: `data:${media_type};base64,${data}` } }
```

And — separately — the fall-through that currently discards unknown blocks becomes an explicit throw. A block type the translator does not understand is a bug in us, and the correct behaviour is a loud failure at the boundary, not a request that looks fine and is missing its subject. This is worth doing on its own merits even before images ship.

### D7 — Gate on the capability that already exists

Add `supportsVisionForModel(providerId, modelId)` alongside `supportsToolsForModel`, reading the `vision` flag already in the catalog. The attach affordance is disabled, with the reason named, when the selected model cannot see. Attempting to send an image to a text-only model refuses with a message that says which model and suggests one that can.

### D8 — Three ways in; paste is the one that matters

1. **Paste** (`⌘V` with an image on the clipboard) — the 90% case, and the whole interaction being copied.
2. **Drag and drop** onto the transcript or composer.
3. **The existing Add Files button**, which should accept an image file from the workspace rather than reading it as text.

An attached image shows as a thumbnail chip in the composer, removable before send, and renders as a bounded thumbnail in the transcript — never the base64, and never at native size.

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

Per screenshot, at the 1568 default, against doing nothing:

| | Native 4K | Normalized | Change |
|---|---|---|---|
| Visual tokens | 4784 (server-capped) | 1792 | **2.7× fewer** |
| Pixels on the wire | 8.3 MP | 1.4 MP | **6× fewer** |
| Base64 inflation | ×4/3 of encoded bytes | ×4/3 | unchanged — it is the pixel count that moves |
| Bytes in the session log | multi-MB per turn | ~70 bytes | ref, not blob |
| Token-meter error | ~333,000 phantom tokens per MB | 0 | the compaction bug |

The last row is the one that would have shipped as a mystery bug report: *"long conversations forget things after I paste a screenshot."*

---

## 6. Not in scope

- **Files API upload** (D9). Anthropic-direct only; worth doing once image use is real, and worth measuring first — the win is on repeat turns, not the first one.
- **Image *output*.** Claude does not generate images. Nothing to build.
- **PDF and document blocks.** Adjacent, different limits, different block type.
- **Coordinates and bounding boxes.** Only interesting if the agent gains a computer-use tool; the resize rule interacts with coordinate mapping and would need its own design.
- **OCR or client-side preprocessing.** The model reads text in images; adding our own pass adds failure modes.

## 7. Open

- **Cap default 1568 or 2576.** Named a decision above rather than left open, but it should be re-measured against real code screenshots before I5 ships — if 11px editor text is unreadable at 1568, the default moves to 2576 and the setting inverts.
- **Whether the workspace-file path should route images through this pipeline at all**, or attach by path and let the tools read them. Attaching by path costs nothing until read; pasting has no path.
