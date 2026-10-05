# Rich diagrams — the model describes, the editor draws

**Status:** phase 1 is built (Graph JSON through a `render_diagram` tool call). It is verified by
unit and property suites, by the real agent loop against a scripted provider, by the real
`chat.html` in headless Chrome under the real CSP, and in the real editor (the dev build) against a
stand-in provider. It has **not** been run against a live model, and the diagram eval has not been
run on any model — see [What is and is not verified](#what-is-and-is-not-verified). Mermaid,
Vega-Lite and raw SVG (phases 2–4) are not built.

This is the implementation record for the *LevelCode Rich Diagrams Spec* (2026-10-04), the third
companion to the Context Budget and Mid-Run Messaging specs. It keeps the spec's section names,
because the code cites them (`docs/RICH-DIAGRAMS.md, "Validation and repair"`). Under each heading:
the rule, what the code does about it, and every place the build chose differently — with the reason,
so the choice can be re-argued.

## Overview

The agent used to draw flows and routing trees with box-drawing characters. They break when the
font or the panel width changes, cannot follow the theme, cannot be clicked and cannot be exported.

Now the model sends a small description of **structure** — nodes, edges, optional groups, one
accent — and never a coordinate, a colour or a size. The editor validates it, lays it out in one
house style and paints it. Quality comes from the renderer, so it is the same whichever model drew.

One diagram, start to finish:

1. A rich client's request carries the `render_diagram` tool and a short block of rules.
2. The model calls the tool. While its arguments stream, the chat shows a placeholder card with the
   title as soon as the title is known.
3. The host runs the repair ladder's first rung and validates the result. Valid: a record is stored
   and sent to the webview. Invalid: every error goes back as the tool result, once.
4. The webview validates the record again, measures the text in the real font, lays it out and
   paints it from allow-lists.
5. If the model's one repair pass does not produce a valid spec, the editor draws what is valid and
   says what it left out — or shows the source, the error and Retry. Never an empty card.

## Requirements

| ID | Requirement | Status | Pinned by |
| --- | --- | --- | --- |
| FR-1 | Graph JSON, Mermaid, Vega-Lite, opt-in raw SVG | **Graph JSON only.** The other three are phases 2–4 | — |
| FR-2 | Graph JSON arrives through `render_diagram`; schema validated on every call | Done | `diagramAgent`, `diagramSchema` |
| FR-3 | No unvalidated spec reaches the renderer | Done — validated in the host before a record exists, again when a session's records are read back from disk, and again in the webview before anything is drawn | `diagramRepair`, `diagramHost`, `diagramUi`, browser check |
| FR-4 | Auto-fix, one model pass, graceful degrade; no automatic second repair; no blank output | Done, with one deliberate reordering — see [Validation and repair](#validation-and-repair) | `diagramRepair`, `diagramAgent` |
| FR-5 | House style in light and dark | Done | `diagramScene` snapshots in both palettes; browser check in both themes |
| FR-6 | Nodes link to files and symbols | Done | `diagramLinks`, `diagramHost` |
| FR-7 | Export SVG, PNG and source | Done, plus Mermaid and "insert into a Markdown file" | `diagramHost`, `diagramText`, browser check |
| FR-8 | Terminal clients get ASCII; rich clients never do | Done for the one client that exists (the chat webview is rich); the flag and the ASCII renderer are in place, and the renderer is what the chat falls back to | `diagramAgent`, `diagramText`, `diagramHost` |
| NFR-1 | Sanitized; no script, no network | Done — the page's CSP is unchanged and nothing model-written is ever parsed as markup | `diagramScene`, `diagramUi`, browser check |
| NFR-2 | Render under 300 ms p95 at 12 nodes | **Layout measured, time-to-picture not.** Layout of the 12-node gallery diagram: p95 under 1 ms in Node once warm (the suite asserts under 50 ms); the slowest of 6,000 random specs took 7 ms. The webview reports its own layout-and-paint time to the local counters; there is no figure from a real editor yet, and nothing measures the hop from host to page | `diagramLayout` |
| NFR-3 | Graph JSON median under 600 tokens | Done — gallery diagrams are 21–309 tokens, the twelve-node one included (characters ÷ 4) | `diagramAgent` |
| NFR-4 | Old chats keep rendering after schema changes | Mechanism done: a versioned schema and `migrate`; a stored record that still validates is drawn as stored, and one that no longer does is cut down by the deterministic rungs instead of being refused. Only version 1 exists, so there is nothing yet to migrate from | `diagramSchema`, `diagramRepair`, `diagramSession` |

## Output formats

Phase 1 draws boxes and arrows only. The spec's five-step format rule therefore ships as two
steps — structure → `render_diagram`; reads fine as prose → no diagram — plus an instruction for the
shapes that have no renderer yet: numbers to compare go in a Markdown table, steps over time in a
numbered list. Telling a model to emit Mermaid or Vega-Lite that the chat would show as raw source
would be worse than not mentioning them; a test fails if the prompt names either.

## Architecture

Everything lives in `extensions/levelcode-ai/diagram/`. The modules are plain UMD: Node `require`s
them, and `bundle.js` inlines the shared ones into `chat.html` under the page's existing nonce.

| Module | Runs in | Job |
| --- | --- | --- |
| `theme.js` | both | The style guide as numbers and CSS: type scale, box metrics, spacing, theme tokens, the two export palettes |
| `schema.js` | both | The versioned schema and a small interpreter for it. The object the model is shown **is** the object it is validated against |
| `validate.js` | both | Schema, then semantics. Every error at once, each with a JSON Pointer |
| `repair.js` | both | The ladder: `normalize` (rung 1), `degrade` (rung 3), `prepare` (the whole trip), `accept` (re-validation of a stored record) |
| `layout.js` | both | Layered layout with orthogonal routing, and `inspect`, which lists anything overlapping or out of frame |
| `scene.js` | both | The painter: a tree of elements built from two allow-lists; `mount` (DOM) and `toSvg` (string) |
| `text.js` | both | The screen-reader outline, the one-line stub, Mermaid and source export |
| `ascii.js` | both | The fallback: the same layout drawn on a character grid |
| `tool.js` | host | The tool definition, the system-prompt block, the tool-result text |
| `service.js` | host | One conversation's diagrams: ids, the one repair pass, records, stubs |
| `links.js` | host | Resolving a node's link inside the workspace, or refusing |
| `exportCheck.js` | host | Checking an SVG or PNG the webview hands back before it is written to disk |
| `stats.js` | host | The local counters |
| `bundle.js` | host | Inlining the shared modules into the page |

**Where rendering runs** (an open question in the spec). Validation and the repair ladder run in
the extension host. Layout and painting run in the chat webview itself — not in a worker or a
second frame — because layout needs to measure text in the real font, and because the Graph JSON
painter executes nothing the model wrote: it creates elements from a fixed list and sets text with
`textContent`. Isolation buys nothing there. It will matter for Mermaid and Vega, which run large
third-party parsers over model text; those should get the sandboxed frame the spec describes.

**Layout engine: not ELK.** The spec names ELK.js. The build uses its own layered (Sugiyama-style)
layout: rank assignment, crossing reduction, coordinate assignment by constraints, one port per
edge, per-gap track assignment for orthogonal connectors, and label placement scored against
nodes, lines and other labels. Reasons: ELK is EPL-2.0 in a repository that is otherwise MIT-clean;
it is about 1.5 MB; and extensions here have no build step. The spec's own open question asks
whether a simpler layered layout is needed as a fallback — this is that layout, as the only one.
`layout.layout(spec, opts)` is the single entry point, so ELK can replace it without touching the
painter. What the trade costs is listed under [Known limits](#known-limits).

**Validator: not Ajv.** Same reasons, smaller scale. `schema.js` interprets the subset of JSON
Schema the diagram schema uses, and produces the spec's error format directly.

**Host ↔ webview messages**

| Direction | Message | Meaning |
| --- | --- | --- |
| host → webview | `diagramPending {key, state, title}` | A call has started (`drawing`) or was sent back (`repairing`) |
| host → webview | `diagram {key, replacesKey?, record}` | The final record for a call; `replacesKey` when it redraws the attempt before it |
| webview → host | `diagramAction {action: 'openLink', id, node}` | A linked node was clicked. The node **id** — never a path |
| webview → host | `diagramAction {action: 'export', id, format, data?}` | Copy or save. `data` only for SVG and PNG, and it is checked before use |
| webview → host | `diagramAction {action: 'retry', id}` | Retry on a degraded or failed diagram |
| webview → host | `diagramAction {action: 'ascii', id, cols}` | The page has no renderer: send the text version. `cols` is how many characters fit the card, clamped to 40–200 |
| host → webview | `diagramAscii {id, text}` | The answer — empty when there is nothing drawable |
| webview → host | `diagramRendered {id, ok, ms, flipped}` | Layout-and-paint time, or a failure, for the local counters |

## Diagram spec and render_diagram tool

The fields are the spec's. Two tiers of limits apply: the **house** tier is what the model is held
to; the **hard** tier is what the renderer will draw when a diagram is degraded, so that a
thirteen-node diagram loses nothing rather than everything.

| Field | House limit | Hard limit |
| --- | --- | --- |
| `title` | 80 characters | 80 |
| `nodes` | 1–12 | 24 |
| `edges` | 30 | 48 |
| `groups` | 8, nested 2 deep | 12, nested 2 deep |
| node `label` / `sub` | 28 / 32 | same; the full text survives as a tooltip |
| edge `label` | 20 | same |
| `accent` | at most one node | one |

Differences from the spec's tables:

- **`v` is optional on the wire.** The tool schema leaves it out to save tokens on every request;
  the host stamps `v: 1` on the stored record. A call that names a version the editor does not know
  is refused.
- **Edges and groups have counts.** The spec caps nodes only. An uncapped edge list is an easy way
  to produce an unreadable picture, so edges stop at 30 and groups at 8.
- **`tip` exists.** It is the renderer's field: the full text of a label that had to be shortened,
  shown on hover and read in the outline. A `tip` the model sends is kept as hover text (cleaned,
  400 characters at most); it is not in the model-facing schema.
- **Unknown fields are ignored, not errors.** A model that adds `color` or `x` is not sent back for
  it — the fields are dropped and counted. The same goes for a stored record: whatever else it
  carries, only declared fields reach the renderer, the exports and `get_diagram`.

The tool returns `{"ok":true,"id":"d-1"}`, optionally with what was changed to fit and which links
did not resolve; or the error list; or, when the diagram was drawn degraded, what was left out and
an instruction not to redraw it unprompted.

**Cost of offering it.** The tool definition is about 520 tokens and the prompt block about 450, on
every request from a rich client. Both are constant for a session, so they sit in the cached prefix
where the provider caches. `get_diagram` (about 100 tokens) is offered only once a diagram has been
stubbed.

## Style guide

`theme.js` is the one place the numbers live: title 15, node name 13 semibold, second lines and
edge labels 11.5, nothing below 10.5; corner radius 8, border 1.25, padding 12; the accent is a
low-opacity fill plus a 2 px border; groups inset their children by 16. Colours are editor theme
tokens (`--vscode-*` behind `--lcd-*`), so a theme switch repaints with no re-render and nothing is
baked in. Shapes: box, diamond, cylinder, pill.

- Width is the measured longest line plus 24. Text is measured in the page's real font in the
  webview; Node-side tests use a calibrated estimate.
- Connectors are orthogonal and run in the gaps between ranks; labels sit beside their line. When
  no clear position exists the label gets a background halo instead of being dropped.
- A diagram never grows wider than the chat column: a `right` flow that does not fit is laid out
  `down` instead. If it is still too wide it is scaled to fit, and opens full-panel with zoom and
  pan.
- A group's name sits in the top-left of its frame, and no connector runs through it. When the
  flow runs down that corner is exactly where lines come in, so the layout works through three
  answers in order. Slide the name along the frame to the nearest clear stretch — free. If the
  frame has none and the lines have less than 72 px to move, move them to the far side of the name
  — the frame gets that much wider, and only if the drawing still fits its column. Otherwise leave
  the name where it is and draw it over the line with a halo, so the line reads as passing behind
  the word.
- Exported SVG and PNG carry one of two fixed palettes (light or dark, picked from the theme at the
  moment of export), because a file cannot read the editor's variables.

The spec's chart rules have nothing to apply to until the Vega-Lite phase.

## Validation and repair

**Layers as built**

| Layer | Checks | Where |
| --- | --- | --- |
| Extraction | The call's arguments are complete. Output cut off by `max_tokens` is re-requested with a "send it again, smaller" result — never repaired | `agent.js`, `service.truncated` |
| Syntax | The arguments parse — leniently: comments, trailing commas, single or smart quotes, bare keys, Python literals, a stray code fence | `repair.parseLenient` |
| Schema | Fields, types, enums, lengths, counts | `schema.check` |
| Semantics | Edge ends exist, ids unique, one accent, groups known, acyclic and at most 2 deep | `validate.js` |
| Layout | Nothing overlaps, overflows or leaves the frame, and no line runs through a node or a group's name. Renderer-only fixes: grow a node, wrap to two lines, flip the direction, halo a label, slide or back a group's name | `layout.js`, `layout.inspect` |

**The ladder, and the one place it departs from the spec.** The spec's first rung lists "dedupe
ids" and "drop edges to unknown nodes with a warning" among the deterministic fixes — while its own
layer table says semantic errors are fixed by the model, "because intent is needed". Both cannot
hold: an edge to `billing` when the node is called `bill` is a typo the model can fix in one pass,
and dropping it silently changes what the diagram says.

The build resolves it with one rule: **an auto-fixed diagram never says something different from
what the model wrote; a degraded one always says what it lost.**

1. **Auto-fix, no model — lossless only.** Lenient parsing; synonyms (`diamond` → `decision`,
   `source`/`target` → `from`/`to`, `rankdir: LR` → `right`); ids slugged; an edge that names a
   node's *label* pointed at that node's id; long labels shortened with the full text kept as a
   tooltip. Silent when it changes nothing visible; a quiet "auto-fixed" badge when it does.
2. **One model pass.** Anything else — an unknown node, a duplicate id, two accents, too many
   nodes — returns every error at once as the tool result, in the spec's format
   (`/edges/1/to: unknown node "billing". Known ids: in, jev, bill, rev.`).
3. **Degrade, never loop.** If the second attempt is still invalid, the lossy fixes run *now*: edges
   to unknown nodes are dropped, duplicates renamed, the first accent kept, deep groups flattened,
   counts allowed up to the hard tier. The diagram is drawn with a banner listing each loss, and a
   Retry button. If nothing drawable remains, the card shows the errors, the source and Retry.

"No automatic second repair" is enforced per diagram (one bounce, then the verdict is final) and
per run (three bounces across all diagrams, after which every call is final). A diagram still
waiting on its repair when the run ends — the model gave up, hit its step limit, or was stopped — is
settled from its last attempt before `agentDone`, so no placeholder is left spinning.

**Storage.** The final record — spec, status, fixes, notes — is written to the session's event log
after the turn. Reopening a chat replays records; no model is asked anything, and a valid record
comes back exactly as it was stored.

A session file is input too — it can be edited, cut short, or written by an older build — so a
stored spec is checked like a model's: by the host when the session is loaded (before a link can be
opened or a file exported from it) and by the webview before it is drawn. The check is
`repair.accept`: validate against the hard tier and hand on only the fields the schema declares;
if that fails, run the deterministic rungs alone and draw what is left with its banner; if nothing
is left, treat it as a diagram that was never drawn and show the source.

**Strict tool schemas** are not enabled. Which providers enforce them well enough is an open
question the eval should answer first; semantic rules stay in the validator either way.

**Fence mode, JSON Patch repair, the cheap repair model** belong to the Mermaid and Vega-Lite
phases and are not built.

## Safe rendering

Graph JSON is the easy case, and the build keeps it easy: there is no sanitizer because there is
nothing to sanitize. The painter creates elements from a fixed list (`svg g rect path text title
style`) with attributes from a fixed list that has no `href`, no `style`, no `id` and no event
handlers, and model text goes in through `textContent`. Text is also stripped of control,
zero-width and bidirectional-override characters before it is stored.

- The page's CSP is unchanged: `default-src 'none'`, scripts by nonce only, no network origin.
- The inlined modules must never contain the text of a script tag or an HTML comment opener, in
  code or comments, or they would end the inline block they live in. `bundle.js` refuses to build
  if one does, and a suite checks it.
- A linked node carries `data-lc-link` = its node id. A click sends that id; the host looks the
  path up in its own record and resolves it again. A path is never taken from the page.

**The host accepts four actions, not two.** The spec lists `openLink` and `export`. Its own UX
section also puts a Retry button on degraded diagrams and promises a text fallback when rendering
is unavailable, which need a third and a fourth (`retry`, `ascii`). All four name a diagram by id
and are looked up in the host's own records; none carries a path, a URL or a command. The only
other value read from the page is the fallback's column count, used as a clamped number.

**Link safety.** `links.js` resolves a link against the workspace folders at draw time *and again
at click time*: schemes are refused, `..` is normalized, the real path (symlinks followed) must
still be inside a workspace folder, and the target must be a file. A link that fails is removed
from the node — it is drawn as plain text — and the model is told which ones did not resolve.

**Exports.** Source, Mermaid and Markdown are generated in the host from the stored spec. SVG and
PNG are produced in the webview (PNG needs a canvas), so the host checks them before writing: the
SVG against the painter's own allow-lists, the PNG by signature and size. File names come from the
title after secret redaction.

## UX

| Spec item | As built |
| --- | --- |
| While streaming | A placeholder card appears when the call starts; the title fills in as soon as it has streamed; the picture replaces it |
| Code links | A small file icon; click or Enter opens the file at the symbol (document symbols, then a text search, then the line); hover shows the path |
| Zoom and pan | Diagrams larger than the column are scaled to fit; click opens a full-panel view with zoom, pan, fit and Esc |
| Toolbar | Copy source, save SVG, save PNG, open as Mermaid, insert into a Markdown file |
| Repair states | "auto-fixed" badge with a details popover; degraded banner listing each loss, plus Retry |
| Theme switch | Instant — colours are CSS variables |
| Accessibility | The title is the accessible name; a text outline (nodes, then edges, in reading order) is attached for screen readers; linked nodes are focusable |
| Fallback | Two ways rendering can be unavailable, one answer. If painting throws, the page draws the spec with characters itself. If the diagram modules never loaded, the page asks the host, which draws it from its own record. Either way it is the same layout on a character grid, fitted to the card's width, in a monospaced block, under a line saying that a text version is being shown. Source stays one click away |

The text fallback is made of plain ASCII — a shortened label ends in three dots there, not an
ellipsis — and it counts East Asian wide characters and emoji as two cells and combining marks as
none, so a box with a Japanese label still closes on one column.

Dragging nodes is not built (an open question in the spec).

## Prompting and capability detection

**Capability flag.** Each agent run carries `client.render`: `rich` or `ascii`. A rich client gets
the tool and the rules; an ASCII client gets neither. Today the chat webview is the only client and
it is rich, unless `levelcode.ai.diagrams.enabled` is off or the model's catalog row says
`diagrams: false`.

**The prompt block** (`tool.PROMPT`) says when a diagram earns its place, that characters are never
to be drawn with, that a request for a diagram means drawing it in the chat rather than writing a
file of diagram source, that the title states the takeaway, at most one accent, split above 12
nodes, link nodes to workspace files, and not to restate the picture as a list afterwards. It carries one worked
example — the spec's Jev flow — and a suite checks that the example is itself a valid, fix-free spec.

**Model differences.** `providers/catalog.js` `diagramSupportForModel` is the registry switch: a
model that fails the eval is turned off with `diagrams: false` in its `CAPS` row. The spec's third
state, "fenced Mermaid only", arrives with the Mermaid phase; until then a switched-off model simply
answers in prose.

**Chat mode is unchanged.** Diagrams are a tool, and only the agent has tools.

## Context budget and cost

- **Collapsing old diagrams.** At compaction — never turn by turn — a diagram call in the
  summarized range becomes `[draws a diagram: <title>]` in the summary input, and the summary is
  followed by one stub line per diagram (`diagram: <title>, 4 nodes, id d-17`). From then on the
  model is also offered `get_diagram`, which returns the full spec by id. Resuming a session whose
  history was shortened does the same.
- **Retention** (an open question). A spec is kept as long as its session file is. There is no
  separate expiry.
- **Repair tokens.** The repair pass is an ordinary agent turn, so it is counted, metered and
  capped like one.
- **Read-only.** A diagram call touches nothing and never asks for approval.
- **Mid-run updates.** Mid-run steering is not in this branch. Nothing in the diagram path cancels
  a call that is streaming; when steering lands, the rule in the spec (the diagram renders, the model
  may redraw) needs no change here.

## Telemetry and evaluation

**Local counters, not telemetry.** `stats.js` keeps the spec's table — first-pass valid rate, fix
share by rung, error classes per model, render time, tokens per diagram, ASCII leaks, link clicks,
exports — in the editor's own storage. `AI: Diagram Statistics` shows it. Nothing is sent anywhere.
It records enums and numbers only; `record()` copies nothing else out of an event, and a suite
checks that no label, title or path can reach the store.

**Golden corpus.** `test/fixtures/diagrams/corpus.json` holds 39 broken specs with the exact
outcome of each attempt. They are **seeded** — written from the failure modes models are known
for — not field data. Real broken specs should be added unchanged as they are found.

**Diagram eval.** `scripts/diagram-eval.js` runs the real agent loop over
`test/fixtures/diagrams/eval-prompts.json` (30 prompts that should draw, 10 that should not) and
scores format choice, first-pass validity, fix share by rung, degraded rate, error classes, tokens,
node-count overruns, title quality and ASCII leaks against the spec's proposed bars (first-pass
valid ≥ 90%, degraded < 2%, no leaks). `--dry-run` uses a scripted model and no network. `--run`
makes billed calls on your key and says how many before the first one. **It has not been run
against any model yet.**

**Acceptance criteria**

- [x] Visual regression snapshots pass in light and dark themes
- [x] Zero script execution or network requests in the security checks — for Graph JSON, the only
      format built
- [ ] Degraded rate under 2% across the diagram eval on default models — the eval exists; not run
- [ ] No ASCII diagrams in rich-client answers over one week of internal use — the counter exists;
      the week has not happened

## Rollout and open questions

Phase 1 — Graph JSON — is what is built, and by the spec it alone retires ASCII for flows and
architecture. The spec's rollout figure (four phases, three gates) is not reproduced here. What
stands between this build and calling phase 1 done is the two unchecked boxes above: run the eval
on the default models, then use it for a week and read the counters.

| Open question | Where it stands |
| --- | --- |
| Which models handle strict tool schemas well enough? | Open. Run the eval per model; strict mode is not enabled |
| Where does rendering run? | Decided for Graph JSON: the chat webview. Revisit for Mermaid and Vega |
| Is ELK fast enough, or is a simpler layered layout needed? | Sidestepped: the simpler layout is the only one. Sub-millisecond at 12 nodes |
| Should users drag nodes? | Not built |
| A simplified chart schema instead of full Vega-Lite? | Open — phase 3 |
| How long are stubbed specs kept? | As long as the session file |

## Known limits

- **Dense labelled fan-ins.** Over 6,000 adversarial random graphs, 6.5% of specs have at least one
  edge label that falls back to a halo over a line (4.5% of all labels) — 2% of flows that run
  right, 11% of flows that run down, where many labelled edges enter one node. Nothing overlaps a
  node. The house-size gallery has none. The suite fails above 9%.
- **Lane swaps.** In 0.3% of the same specs two connectors in one gap cross where a perfect router
  would not have crossed them. The suite fails above 0.5%.
- **Backed group names.** Of the random specs that have groups, 0.5% of those flowing right and
  4.9% of those flowing down end with a connector passing behind a group's name — long names over
  narrow frames. None has a line *through* an unbacked name, and none of the gallery diagrams needs
  a backing at any width from 320 px up. Making room instead costs width: grouped top-to-bottom
  random specs are 0.6% wider on average and at most 121 px. The suite fails above 10% backed.
- **Text fallback width.** Character widths follow the common Unicode ranges, not the whole
  standard; an unusual script or a font with its own ideas can still put a box edge one cell out.
- **Time to picture is unmeasured in a real editor.** Layout is fast; font loading, DOM work and
  the webview's message hop are not in any number here.
- **The corpus is seeded** and the eval has not been run, so the first-pass and degraded rates for
  real models are unknown.
- **One renderer.** A terminal client does not exist yet, so `client.render = ascii` is exercised
  only through the setting, the catalog switch and tests.

## What is and is not verified

Verified:

- 12 suites, 252 tests (`test/diagram*.test.js`), including a 1,500-spec layout fuzz, the corpus,
  SVG snapshots in both palettes, the gallery at chat-panel widths, the real `runAgent` loop with a
  scripted provider, and the host functions sliced out of `extension.js` against a `vscode`
  stand-in.
- The whole gate (`./scripts/test-extensions.sh`, 62 suite files) on macOS arm64 with Node 24, and
  on Linux (Ubuntu 22.04 arm64, Node 18) in a container with no network and a read-only checkout.
  The diagram suites also pass with every timer delayed by 15 ms.
- `scripts/diagram-browser-check.js`: the real `chat.html` in headless Chrome under the real CSP —
  light and dark, hostile labels, links, exports, a painter that throws, and the page with no
  diagram modules at all — 155 checks, with no CSP violation and no resource request. Each step
  waits for its result rather than for a length of time.
- Mutation testing: 147 single-edit defects seeded across the modules, the host glue, the page and
  the eval harness, each run against the suite that should notice (and only after that suite
  passed on the unmutated copy). Ten survived at first: three were redundant code (removed or
  simplified), seven were gaps in the suites (closed). All 144 that still apply are caught.

- `scripts/diagram-editor-check.js`: the real editor. A second, throwaway instance of the dev build
  loads this checkout's extension, talks to a stand-in provider on localhost, and is driven through
  the DevTools protocol — 17 checks: the tool and its rules reach the model, the diagram is painted
  in the real webview in the editor's theme, a linked node opens its file at the symbol, the session
  on disk holds the diagram, a wider column re-lays it out, and the answer around it renders as
  Markdown. (Added after the feature was first called done without ever having run in the editor.)

Not verified:

- Any live model. No provider call was made while building this; the editor check's "model" is a
  script. What a real model does with the tool is what the eval is for.
- The gate on CI's own runner (ubuntu-latest, x64, Node 24) — it runs there on the pull request.

## How to check it

```bash
./scripts/test-extensions.sh                                        # every suite, the release gate
node extensions/levelcode-ai/scripts/diagram-browser-check.js       # the real page in headless Chrome
node extensions/levelcode-ai/scripts/diagram-editor-check.js        # the real editor, a stand-in provider
node extensions/levelcode-ai/scripts/diagram-eval.js --dry-run      # the eval harness, offline
UPDATE_SNAPSHOTS=1 node extensions/levelcode-ai/test/diagramScene.test.js   # after a deliberate style change
```

The editor check opens a window for about a minute. It is a separate instance with its own
profile, so it neither joins an editor that is already open nor touches your settings or sessions.

**To try it by hand.** In the checkout that has `vscode/`, `./scripts/run-dev.sh` runs the
extension that is checked out there. From anywhere else — a git worktree has no `vscode/` of its
own — load that checkout's extension into the build that exists:

```bash
./scripts/run-dev.sh --extensionDevelopmentPath=/absolute/path/to/worktree/extensions/levelcode-ai
```

Run it from the checkout that has `vscode/`, and quit a dev editor that is already open first (a
running one is joined, not replaced). The window's title says `[Extension Development Host]`.
Then, in agent mode, ask something whose answer is structure — "how does a request flow through
this app?". The editor check takes the same route (`--vscode <that checkout>/vscode`).

To measure a model: `node extensions/levelcode-ai/scripts/diagram-eval.js --run --model <id> --limit 8`
first, then without `--limit`.
