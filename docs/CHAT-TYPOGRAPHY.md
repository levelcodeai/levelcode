# LevelCode — Chat typography and layout — scope & plan

The goal, in one sentence: make the chat read like a **document** rather than a log — a constrained
measure, real vertical rhythm, and a type scale with actual hierarchy — so a long answer is as
comfortable to read in LevelCode as it is in the Claude Code console.

Reference behavior: the Claude Code console transcript (side-by-side screenshots, 2026-08-15).
`CALM-TRANSCRIPT.md` already took the *structure* from the same reference — voice and grouped
activity. This doc takes the *visual layer*, which that one deliberately left alone.

This became urgent the moment the chat could open as an editor tab (#70). In a 380px sidebar the
line length is bounded by the container, so nothing looks badly wrong. At 900px it is unbounded,
and the same CSS produced **~154-character lines** — measured, at a 900px viewport.

---

## 1. Verified facts about our own code (read 2026-08-15, not recalled)

All from `extensions/levelcode-ai/media/chat.html`:

| | current | note |
| --- | --- | --- |
| Prose column width | **unconstrained** | 12 `max-width` rules exist; every one is a card, dialog or the empty state. **None applies to the message column.** |
| `#log` | `padding: 12px; gap: 12px` | the entire page margin |
| `body` | `font-family: var(--vscode-font-family)`<br>`font-size: var(--vscode-font-size)` | the workbench **UI** font — sized for chrome, not for reading |
| `.msg` | `line-height: 1.5` | |
| Paragraph | `margin: 0 0 8px` | |
| Headings | `1.3em / 1.18em / 1.07em`, `margin: 12px 0 6px` | h2→h3 differ by **0.11em**; at 13px that is 1.4px |
| `.msg.user .body` | `background: var(--field-bg)`, `1px` border, `radius 10px`, `padding: 9px 11px` | |
| `.msg.assistant .body` | `padding: 1px 2px` | effectively none |
| `.msg .role` | `11px`, `opacity .55`, uppercase, `letter-spacing .05em` | a label above every turn |
| Inline code | `background: var(--vscode-textCodeBlock-background…)`, `padding: 1px 5px`, `.92em` | **no `color` is set** — the red/orange in dark themes comes from the theme or webview defaults, not from us |
| `pre` | `padding: 9px 11px`, `radius 8px`, `margin: 8px 0` | |

Two observations worth stating plainly, because they explain almost everything:

1. **Nothing constrains the measure.** Every other property is defensible; this one is simply absent.
2. **The chat inherits the workbench UI font size.** That is a reasonable default for a sidebar
   widget and the wrong one for sustained reading. UI type is tuned for scanning labels at density;
   prose wants a larger size and looser leading.

---

## 2. Decisions (with the reasoning, so they can be re-litigated)

### D1 — Constrain the measure. This is the single biggest lever.

`max-width` on the prose column, centred, with the container still full-bleed so cards and code blocks
keep their current behaviour. *(D9 later brought the composer into the same column; T1 shipped with it
still full-bleed.)*

**Target 820px**. T1 shipped 680px, derived from first principles below. That number was later
overruled by the reference itself — see the revision at the end of this decision. The derivation is
kept because its correction is the reusable part; the figure it produced is not.

An earlier draft of this section said "~72ch, which lands near 640–700px". Both halves were wrong, and
that correction is worth keeping because the mistake is easy to repeat:

| measured in the shipped font at 13px | |
| --- | --- |
| `ch` (the width of `0`) | **8.13px** |
| real average prose character | **5.86px** |

`ch` is **39% wider than actual text**, so a `72ch` cap yields ~100 characters, not 72 — and 72 real
characters would be a 422px column, narrower than the sidebar. The print-typography range of 45–75
characters does not transfer to a technical chat: it assumes prose without identifiers, file paths or
code, and a 422px column would wrap every code block constantly.

680px was chosen against that measurement: ~116 characters at 13px, down from 154 at editor width,
while staying wide enough that a fenced block is still readable.

**Revised to 820px after comparing against the reference directly.** Side-by-side at the same window
width, the Claude Code console's column is **~815px** against our 680 — it uses about half the
available width where we used 41%. The user's report was "the content space is too narrow", and on a
design parameter chosen from first principles versus the artefact we are explicitly trying to match,
the artefact wins.

Stated honestly: 820px is **~130 characters** at the shipped 14px prose size, which is well outside the
print range this decision already argues does not transfer. Two things make that acceptable rather than
sloppy — the reference demonstrably reads well at that width, and this column carries tables, file
paths and fenced code, none of which wrap gracefully at 680. The risk section's "screenshots are not
measurements" caveat applies: ~815px is read off a screenshot, so 820 is a round number near a
measured one, not a precise transcription.

The elegant part: **in the sidebar this is a no-op.** The container is already narrower than the cap,
so nothing moves for existing users. It only takes effect in the editor tab, which is exactly the
surface that needs it.

### D2 — Prose diverges from the workbench UI font size. Chrome does not.

This is the real trade-off in the whole document, so it gets stated rather than smuggled in.

`--vscode-font-size` (typically 13px) is the size of menu labels and tree rows. Reading three
paragraphs of explanation at that size, at `line-height: 1.5`, is why the panel feels cramped next to
the reference.

**Decision:** message bodies get their own size and leading (~1.65), expressed through a single custom
property. Everything else — the composer, buttons, session cards, the status row, approval chips —
keeps inheriting the workbench size, so the panel still belongs to the editor.

The size is an **offset**, `calc(var(--vscode-font-size) + 1px)`, not a flat 14px. Review caught the
reason: a flat value silently inverts the decision for anyone who has raised the editor's UI font for
accessibility — an 18px workbench would read 14px prose inside 18px chrome, which is the divergence
this decision argues for, pointing the wrong way. At the default 13px it resolves to the same 14px, so
the change is invisible to everyone who has not touched it.

**The cost, honestly:** the chat will no longer match workbench chrome exactly. That is a real
inconsistency, and it is the deliberate price of the panel being a place you *read* rather than a
place you *operate*. D7 gives it an escape hatch.

### D3 — Vertical rhythm scales with the type, not with pixels.

Spacing is currently absolute (`8px`, `12px`), so raising the font size makes the page *tighter*
rather than proportionally airier. Every prose gap moves to `em`, anchored to the prose size:
paragraph `0.85em`, block gap `1.15em`, `#log` padding to ~`20px 24px` at editor width.

### D4 — Widen the heading scale so hierarchy survives.

`1.3 / 1.18 / 1.07` compresses three levels into a quarter of an em. Move to roughly
`1.45 / 1.25 / 1.1`, with more space *above* a heading than below it — the standard trick that makes
a heading belong to the section it introduces rather than float between two.

### D5 — Code surfaces get room, and stay theme-driven.

`pre` padding `9px 11px` → `12px 14px`, with the block's vertical margin tied to D3's rhythm.
Inline code keeps its neutral background; we do **not** start setting `color` (see §1 — we never
did, and hard-coding it would fight every theme).

**Shipped (T3), with one thing the decision did not anticipate:** `pre` is a **global** selector in
this stylesheet and draws four different things — the empty state's ASCII logo, the MCP approval
card's command block, the terminal output pane, and the prose code block this decision is about. Only
the logo has no padding override of its own, so widening bare `pre` would have quietly moved it. The
rule is scoped to `.msg .body pre`, which is the same distinction T2 had to make between `.msg` and
`.msg .body`.

Gated to reading width, like D3: a 380px sidebar is deliberately dense, and six more pixels a side is
content width it does not have. Measured, against `develop`:

| | sidebar (420px) | editor (1200px) |
| --- | --- | --- |
| prose `pre` padding | `9px 11px` — **unchanged** | **`12px 14px`** |
| prose `pre` margin | `8px` — **unchanged** | **`14px`** (1em at the shipped prose size) |
| ASCII logo, terminal pane, inline code | unchanged | **unchanged** |

Inline code's `padding: 1px 5px` is deliberately left alone. Vertical padding on an inline box does
not grow the line box, so a roomier inline span overlaps the line above it — "code surfaces get room"
is a statement about blocks, not spans.

Deliberately **not** in scope: a header row on code blocks (language label, copy button). That is a
component, not typography, and it belongs in its own slice.

### D6 — Soften the turn label; keep the user bubble.

The uppercase `LEVELCODE AI` label above every assistant turn adds a line of chrome to every message.
The reference distinguishes speakers by *treatment* — a tinted bubble for you, unadorned prose for
the assistant — rather than by labelling both. Keep the user bubble; make the assistant label quieter
or drop it where the previous turn already establishes who is speaking (`.msg.cont` already exists
for exactly this case).

**Shipped (T4):** dropped for *both* speakers, not softened, and not deleted — the label is clipped
out of the visual layer and kept in the accessibility tree. The bubble is a purely visual cue, so
removing the element outright would leave a screen reader with an unattributed wall of text. That is
why the rule must never be "simplified" to `display: none` or `visibility: hidden`; both take it out
of the a11y tree, and the test suite fails on either.

Two things measured rather than assumed (headless Chrome, computed styles, 900px, against `develop`):

| | develop | T4 |
| --- | --- | --- |
| label box | 16.5 × 680px | **1 × 1px, clipped** (`display: block`, `visibility: visible`) |
| user → assistant gap | 14.94px | **21.44px** |
| assistant → continuation gap | 9.94px | 9.94px |
| message height (user / assistant) | 63.59 / 45.59px | **43.09 / 25.09px** |

The second row is the part that was not obvious. The label was doing **20.5px of spacing work** above
every turn — the thing that made a new turn look new. Removing it and stopping there would have left a
turn start and a continuation separated by 12px versus 7px, which is not a difference you can see: the
transcript collapses into one undifferentiated column, the opposite of the intent, and it would read as
"the spacing feels off" rather than as a missing rule. `#log > .msg:not(.cont)` buys part of that
height back in `em`, so it tracks D2's prose size. Net: **20.5px reclaimed per message** while the
turn-boundary-to-continuation ratio *improves* from 1.5× to 2.2×.

### D7 — It stays hackable: two settings, no hard-coded values.

`levelcode.ai.chat.proseWidth` (px) and `levelcode.ai.chat.fontSize` (px). Both flow through the CSS
custom properties above, set on the container, so the defaults are a starting point rather than a
verdict — consistent with the editor's whole posture, and the honest answer to anyone who preferred
the old density.

**`0` means "leave the stylesheet alone" for both**, and nothing more. The first draft of this line
claimed `0` = *unconstrained* for the width and `0` = *follow the workbench* for the size; neither was
what the code did, and review caught both. The width's default is a 680px measure, not the absence of
one — the way to widen it is a large number. The size's default now does track the workbench, but by
the D2 offset, which is a property of the stylesheet rather than of the sentinel.

Both are **clamped at the host boundary** (`clampSetting`, 8–24 and 320–2000). `minimum`/`maximum` in
the contribution schema only drive the settings *editor*; a hand-edited `settings.json` reaches
`getConfiguration()` unchecked, and these values land directly in CSS. `proseWidth: 1` is a one-pixel
transcript — a panel with nothing left on screen to open settings with, whose only exit is finding the
JSON file again. `webviewCss.test.js` pins the clamp to the schema so the two cannot drift.

### D8 — Your turn sits right. The assistant's stays left.

Added after T4 shipped, from the reference: in the Claude Code console your messages are right-aligned
bubbles and the replies are left-aligned prose.

This is the half T4 was missing, and it closes a risk T4 opened rather than merely adding polish. T4
removed the labels and left the **bubble** carrying the speaker distinction alone — but the bubble is
`--field-bg` on a `--border` outline, which is near-invisible in some themes. On a low-contrast theme a
transcript could read as one undifferentiated voice, which is precisely the failure D6 was trying to
avoid. **Side is unmissable in every theme, at every contrast, and costs no chrome at all.**

Three things this decides, each with a way to get it wrong:

- **`align-items`, not `text-align`.** The *bubble* is what moves; the prose inside it stays
  left-aligned. `text-align: right` looks identical on a one-line message and is unreadable on a
  three-line one. The suite fails on it.
- **The bubble hugs its content** (`width: fit-content`), so "Yes" is a 47px bubble and a pasted stack
  trace is a wide one. The shape of a turn now carries information the label used to spell out.
- **Capped at 85%, not 100%.** At 100% a long question fills the measure, reads as a full-width block
  again, and the side cue disappears exactly when the transcript is densest.

Measured in headless Chrome at a 680px column, against `develop`:

| | before | after |
| --- | --- | --- |
| short bubble ("Yes") | 680px | **46.9px**, flush right |
| long user turn | 680px | **578px** — exactly the 85% cap, flush right |
| assistant | 680px, left | 680px, left (unchanged) |
| `text-align` inside the bubble | `start` | `start` |

Tint stays as the secondary cue rather than being removed: side alone would fail on any surface that
reflows the log to a single column.

### D9 — One column for the whole panel, not just the transcript.

T1 bounded the **transcript** and nothing else. `#composer`, `#status` and the four notice bars are
siblings of `#log`, not children, so none of them saw the cap: at editor width the input was a
**~1580px box sitting under an 820px conversation**. Side by side with the reference — where the
composer sits directly under the text it answers — this was the single most obvious difference left,
more than any type choice.

**The measure moves from `#log` to `body`.** This is the load-bearing part, not tidying. A custom
property declared on the log is invisible to the log's siblings, which is precisely how the split
arose. On `body`, every element in the shell resolves the same value.

Two consequences that are easy to miss:

- **`--shell-x`.** The shell insets by `calc(100% - 2 * var(--shell-x))`, the same value `#log` pads
  with, rather than a bare `width: 100%`. Without it the edges agree only where the cap binds, and
  out-dent by the log's padding everywhere else — including every sidebar, which is the width most
  users are actually in.
- **The runtime override moves too.** `chat.proseWidth` used to be written onto `#log`. Left there it
  would resize the conversation and leave the composer on the stylesheet default — reopening this exact
  split, but only for users who set the setting, which is the worst place for it to hide.

Verified in headless Chrome at four widths. Composer and prose edges, left and right:

| viewport | before (prose / composer) | after |
| --- | --- | --- |
| 1600px | 680 / **1584** — 452px out-dent per side | 820 / 820 — **Δ 0.0** |
| 900px | 680 / 884 | 820 / 820 — **Δ 0.0** |
| 800px | 680 / 784 | 752 / 752 — **Δ 0.0** |
| 420px (sidebar) | 476 / 484 | 476 / 476 — **Δ 0.0** |

The 420px row is the argument for `--shell-x` on its own: the sidebar was misaligned by 4px a side
before this, quietly, in the surface almost everyone uses.

---

## 3. Slices

Each ships independently and is visible on its own.

**T1 — measure + rhythm** *(S)*. D1 and D3. The largest perceptual change for the least code, and the
one that fixes the editor tab. Ships: a wrapper max-width, `em`-based prose spacing, wider `#log`
padding at editor width. **Exit:** a long answer in the editor tab holds **~116 characters** per line
(the 680px cap of D1, down from ~154), and the sidebar renders byte-identically to today — verified by
comparing computed styles against `develop` at 520px, not by eye.

**T2 — the reading type scale** *(S)*. D2 and D4. Ships: the prose size/leading custom properties and
the widened heading scale. **Exit:** h1/h2/h3 are distinguishable at a glance in a screenshot with no
selection, and every non-prose control still matches workbench chrome.

**T3 — code surfaces** *(S)*. D5. **Shipped.** `pre` padding and rhythm, scoped to `.msg .body pre`
and gated to reading width. **Exit:** a fenced block has room at editor width, the sidebar renders
identically to before, and the three other things that use `<pre>` are untouched — measured, not
eyeballed.

**T4 — speaker treatment** *(S)*. D6. **Shipped.** The label leaves the screen and stays in the
accessibility tree, and a turn start buys back part of the height it was occupying. **Exit:** the
transcript reads as prose with the bubble as the only visual speaker cue, a continuation is still
visibly tighter than a new turn, and `.msg.cont` still emits no label — verified by computed styles
against `develop`, not by eye. *(T6 then made side the primary cue, so "the bubble alone" describes
T4 as it shipped, not the current state.)*

**T6 — side** *(S)*. D8. **Shipped.** Your turn moves right and hugs its content; the assistant stays
left and full-measure. **Exit:** a short turn renders as a short right-flush bubble, a long one caps
below the column, the assistant is untouched, and the prose inside the bubble is still left-aligned —
all four measured, not eyeballed.

**T7 — the shell column** *(S)*. D9, plus D1's revision to 820px. Ships: the measure moves to `body`,
`--shell-x`, the shell rule over the composer/status/notice bars, and the runtime override retargeted.
**Exit:** composer and prose edges agree to **0.0px at 1600 / 900 / 800 / 420**, and `chat.proseWidth`
moves both together — measured, not eyeballed.

**T5 — the escape hatch** *(S)*. D7. **Folded into T2 and shipped with it.** Sequencing it last was a
mistake: T2 is the one slice that changes what every existing user sees, and shipping a divisive
change with no way back is worse than not shipping it. The plumbing is also shared — once one custom
property reaches the webview from settings, the second is a line — so splitting them bought nothing.

Sequencing: T1 first and alone — it may turn out to be most of the perceived fix, and shipping it
by itself is the cheapest way to find out before spending effort on T2–T4.

That held up: T1–T2, T4, T6, T7 and T3 shipped in that order, each visible on its own. **Every slice
of this plan has now shipped.** Neither D8/T6 nor D9/T7 was in the original decomposition
— both came from looking at the reference again after shipping, which is the argument for slices small
enough to look at. D9 in particular was invisible from inside the plan: T1's own wording said the
composer "keeps its current behaviour", and it took a side-by-side screenshot to notice that was the
bug rather than the scope.

---

## 4. Risks, honestly

- **Divergence from workbench chrome (D2).** The panel will read as slightly its own thing. Mitigated
  by scoping the change to message bodies only, and by T5.
- **Sidebar users who liked the density.** At 380px the measure is a no-op, but the type-size change
  is not. T5 is the answer, and T1 shipping alone gives us a read on whether T2 is even wanted.
- **Theme variance.** Inline-code colour already comes from the theme rather than from us (§1), so
  any judgement about "busy" colour must be checked across the light, dark and high-contrast themes
  the `webviewCss` suite already reasons about — not just the default.
- **~~No test currently guards the measure.~~ Closed by T1.** `webviewCss.test.js` now asserts the
  column is bounded, that the cap covers every child of the log rather than just `.msg`, that it stays
  an absolute length (not `ch`), and that the rhythm change stays width-gated. The risk was real: this
  regression is invisible in a sidebar, so whoever refactors the log container would not see it break —
  a user with the chat in an editor tab would.
- **Screenshots are not measurements.** Everything here is derived from our own CSS plus a
  side-by-side comparison. The specific numbers (72ch, 14px, 1.65) are considered starting points to
  be tuned against the real thing at real widths, not values copied from the reference — we cannot
  read the reference's stylesheet.
