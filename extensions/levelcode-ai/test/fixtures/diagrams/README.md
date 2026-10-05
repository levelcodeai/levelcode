# Diagram fixtures

Inputs for the rich-diagram suites (`test/diagram*.test.js`). See `docs/RICH-DIAGRAMS.md`.

## `corpus.json` — the golden corpus of broken specs

Each entry is one way a model gets a `render_diagram` spec wrong, with what the repair ladder must
do about it:

| field | meaning |
| --- | --- |
| `name`, `why` | what the case is, and why it is in the corpus |
| `input` | exactly what arrived — an object, or a string when the JSON itself is the problem |
| `first` | the first attempt: `status`, the exact `errors` returned to the model, the fixes `shown` to the user, and the classes of silent tidy-up (`tidied`) |
| `final` | the same input once the model's one repair pass is spent: `status`, the banner `notes`, and how much was `drawn` |

**The rule the suite enforces: a fix to the validator or the auto-fixer must keep every case here
green.** If a change is meant to alter an outcome, the entry is edited in the same commit and the
diff says why.

These cases are *seeded* — written by hand from the failure modes models are known for (JSON5
syntax, Mermaid vocabulary, labels over the limit, edges that name a label). They are not yet
field data. The spec calls for real broken specs collected locally or from opted-in users; when
those exist, add them here unchanged: paste the raw input, run the ladder once, review the outcome
by eye, and record it.

Never put anything in an entry that came from a private workspace: labels are free text.

## `eval-prompts.json` — the diagram eval

Thirty prompts whose answer is structure and ten whose answer is not, for
`scripts/diagram-eval.js`. Almost none of the thirty says "diagram": the eval measures whether a
model *chooses* to draw, not whether it obeys. Edit freely — the harness reads whatever is here;
`test/diagramEval.test.js` holds the set to its 30/10 split and unique ids.

## `gallery.json` — realistic diagrams

Well-formed specs of the shapes the feature exists for (a routing flow, an architecture with
groups, a decision tree, a state machine with a loop, a twelve-node system). The layout suite
requires each to lay out with nothing flagged at all — nothing overlapping, every label clear of
every line, no connector through a group's name — at its natural width and at the widths a chat
panel really has (560, 420 and 320 px), where most of them turn top-to-bottom.

## `snapshots/` — rendered SVG, light and dark

The exact SVG the painter produces for three gallery diagrams under each palette. A change to the
style module, the layout or the painter shows up here as a diff. Regenerate deliberately with
`UPDATE_SNAPSHOTS=1 node test/diagramScene.test.js`, and look at the result before committing it.
