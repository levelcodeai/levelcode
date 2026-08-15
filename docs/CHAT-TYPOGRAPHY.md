# LevelCode — Chat typography and layout — scope & plan

The goal, in one sentence: make the chat read like a **document** rather than a log — a constrained
measure, real vertical rhythm, and a type scale with actual hierarchy — so a long answer is as
comfortable to read in LevelCode as it is in the Claude Code console.

Reference behavior: the Claude Code console transcript (side-by-side screenshots, 2026-08-15).
`CALM-TRANSCRIPT.md` already took the *structure* from the same reference — voice and grouped
activity. This doc takes the *visual layer*, which that one deliberately left alone.

This became urgent the moment the chat could open as an editor tab (#70). In a 380px sidebar the
line length is bounded by the container, so nothing looks badly wrong. At 900px it is unbounded,
and the same CSS produces ~130-character lines — roughly twice the readable measure.

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

`max-width` on the prose column, centred, with the container still full-bleed so cards, code blocks
and the composer keep their current behaviour.

**Target 680px** — measured, not estimated. An earlier draft of this section said "~72ch, which lands
near 640–700px". Both halves were wrong, and the correction is worth keeping because the mistake is
easy to repeat:

| measured in the shipped font at 13px | |
| --- | --- |
| `ch` (the width of `0`) | **8.13px** |
| real average prose character | **5.86px** |

`ch` is **39% wider than actual text**, so a `72ch` cap yields ~100 characters, not 72 — and 72 real
characters would be a 422px column, narrower than the sidebar. The print-typography range of 45–75
characters does not transfer to a technical chat: it assumes prose without identifiers, file paths or
code, and a 422px column would wrap every code block constantly.

680px is chosen against the measurement: **~116 characters at 13px**, down from 154 at editor width,
while staying wide enough that a fenced block is still readable. When T2 raises the prose size the
same cap tightens to ~108 characters, which is the right direction.

The elegant part: **in the sidebar this is a no-op.** The container is already narrower than the cap,
so nothing moves for existing users. It only takes effect in the editor tab, which is exactly the
surface that needs it.

### D2 — Prose diverges from the workbench UI font size. Chrome does not.

This is the real trade-off in the whole document, so it gets stated rather than smuggled in.

`--vscode-font-size` (typically 13px) is the size of menu labels and tree rows. Reading three
paragraphs of explanation at that size, at `line-height: 1.5`, is why the panel feels cramped next to
the reference.

**Decision:** message bodies get their own size (~14px) and leading (~1.65), expressed relative to a
single custom property. Everything else — the composer, buttons, session cards, the status row,
approval chips — keeps inheriting the workbench size, so the panel still belongs to the editor.

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

`pre` padding `9px 11px` → ~`12px 14px`, with the block's vertical margin tied to D3's rhythm.
Inline code keeps its neutral background; we do **not** start setting `color` (see §1 — we never
did, and hard-coding it would fight every theme).

Deliberately **not** in scope: a header row on code blocks (language label, copy button). That is a
component, not typography, and it belongs in its own slice.

### D6 — Soften the turn label; keep the user bubble.

The uppercase `LEVELCODE AI` label above every assistant turn adds a line of chrome to every message.
The reference distinguishes speakers by *treatment* — a tinted bubble for you, unadorned prose for
the assistant — rather than by labelling both. Keep the user bubble; make the assistant label quieter
or drop it where the previous turn already establishes who is speaking (`.msg.cont` already exists
for exactly this case).

### D7 — It stays hackable: two settings, no hard-coded values.

`levelcode.ai.chat.proseWidth` (px, `0` = unconstrained) and `levelcode.ai.chat.fontSize`
(`0` = follow the workbench). Both flow through CSS custom properties set on the container, so the
defaults are a starting point rather than a verdict — consistent with the editor's whole posture, and
the honest answer to anyone who preferred the old density.

---

## 3. Slices

Each ships independently and is visible on its own.

**T1 — measure + rhythm** *(S)*. D1 and D3. The largest perceptual change for the least code, and the
one that fixes the editor tab. Ships: a wrapper max-width, `em`-based prose spacing, wider `#log`
padding at editor width. **Exit:** a long answer in the editor tab holds ~72 characters per line, and
the sidebar renders byte-identically to today.

**T2 — the reading type scale** *(S)*. D2 and D4. Ships: the prose size/leading custom properties and
the widened heading scale. **Exit:** h1/h2/h3 are distinguishable at a glance in a screenshot with no
selection, and every non-prose control still matches workbench chrome.

**T3 — code surfaces** *(S)*. D5. Ships: `pre` padding and rhythm.

**T4 — speaker treatment** *(S)*. D6. Ships: the quieter label, verified against `.msg.cont`.

**T5 — the escape hatch** *(S)*. D7. Ships: the two settings and their plumbing.

Sequencing: T1 first and alone — it may turn out to be most of the perceived fix, and shipping it
by itself is the cheapest way to find out before spending effort on T2–T4.

---

## 4. Risks, honestly

- **Divergence from workbench chrome (D2).** The panel will read as slightly its own thing. Mitigated
  by scoping the change to message bodies only, and by T5.
- **Sidebar users who liked the density.** At 380px the measure is a no-op, but the type-size change
  is not. T5 is the answer, and T1 shipping alone gives us a read on whether T2 is even wanted.
- **Theme variance.** Inline-code colour already comes from the theme rather than from us (§1), so
  any judgement about "busy" colour must be checked across the light, dark and high-contrast themes
  the `webviewCss` suite already reasons about — not just the default.
- **No test currently guards the measure.** `webviewCss.test.js` pins hidden-attribute defeats and the
  session-card overflow; it should gain a guard that the prose column is bounded, or T1 will regress
  silently the first time someone refactors the log container.
- **Screenshots are not measurements.** Everything here is derived from our own CSS plus a
  side-by-side comparison. The specific numbers (72ch, 14px, 1.65) are considered starting points to
  be tuned against the real thing at real widths, not values copied from the reference — we cannot
  read the reference's stylesheet.
