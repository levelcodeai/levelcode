# LevelCode — Kimi K3 support — scope & implementation plan

**Goal:** make Moonshot's **Kimi K3** a first-class model in LevelCode — both to catch the current
wave of K3 interest and as an adoption lever ("LevelCode runs Kimi K3").

**The happy news:** the provider layer is explicitly *"many providers, little code"* — a new
OpenAI-compatible model is a **data row, not new code** (`providers/openaiCompat.js:2-8`). The whole
client-side integration is ~4 small edits along the existing **DeepSeek** template.

**The one catch:** K3 is an **always-on reasoning model**, and the agent's tool loop **drops**
`reasoning_content`. LevelCode already had to disable the agent for exactly one model for this reason
(`deepseek-reasoner`, `tools: false`). Whether K3 survives the loop is unknown and **must be validated
before shipping** — there is no non-reasoning K3 to fall back to. This is §3, and it gates everything.

---

## 1. The two paths (recommend both, sequenced)

| | **Path A — BYOK direct provider** | **Path B — Cloud gateway flagship** |
|---|---|---|
| What | User brings their own Moonshot key; LevelCode calls `api.moonshot.ai` directly | User just signs in; LevelCode Cloud proxies to K3, billed in LevelCode credits |
| Where | This repo only (`extensions/levelcode-ai/`) | thin.ly backend roster + billing **and** a client constant flip |
| Size | ~4 small edits + tests | Backend work (roster, cost multipliers, capacity) — out of this repo |
| Friction to **use** | High — needs a Moonshot account, key, billing | **None** — the real advertising vehicle |
| Advertisable as | "LevelCode now supports Kimi K3 (BYOK)" — to the K3-enthusiast crowd who already have keys | "Kimi K3, built in — just sign in" — to everyone |

**Recommendation:** ship **Path A first** (small, low-risk, independently shippable, immediately
advertisable), then do **Path B** as the mass-adoption follow-up. Both are gated by the §3 spike.
The gateway already ships a Moonshot flagship today — `GATEWAY_PRO_MODEL = 'moonshotai/kimi-k2.7-code'`
(`extension.js:174-175`), the default of `levelcode.ai.cloudModel` (`package.json:317`) — so Path B is
"upgrade the flagship to K3," not "wire Moonshot from scratch."

---

## 2. The Kimi K3 API (verified against Moonshot's own docs, 2026-07-20)

| | |
|---|---|
| Base URL | `https://api.moonshot.ai/v1` — **OpenAI-compatible** |
| Auth | `Authorization: Bearer $MOONSHOT_API_KEY` |
| Model id | **`kimi-k3`** (canonical; "K3 Max" / "Swarm Max" are product names, not API strings) |
| Streaming | Yes — emits **separate `reasoning_content` and `content`** deltas |
| Tools | Yes — official tool-calling + dynamic-loading guides exist |
| Context | 1,048,576 tokens (2^20; Moonshot/OpenRouter market it as "1M") |
| Pricing | ~$3 / M input, $15 / M output, $0.30 / M cached input *(secondary sources — confirm on the official pricing page before Path B billing)* |

**Two corrections to watch for:**
- The API host is **`api.moonshot.ai`**, not `platform.kimi.ai` (that's the docs/console host — it would 404).
- There is **no Anthropic-compatible endpoint** (confirmed against Moonshot's official `llms.txt` index).
  K2 had one; K3 does not. So this does **not** reuse the native Anthropic provider — it goes through the
  OpenAI-compat adapter.

Sources: `platform.kimi.ai/docs/guide/kimi-k3-quickstart`, `platform.kimi.ai/docs/api/overview`,
`platform.kimi.ai/docs/llms.txt`.

---

## 3. The gate — validate the reasoning/tool loop FIRST (½ day, blocks everything)

**Why this is the whole risk.** K3 streams its thinking as a separate `reasoning_content` field. The
universal adapter reads **only** `d.content` and `d.tool_calls` and never `reasoning_content`
(`openaiCompat.js:72-77`, `:229-235`). So the stored transcript carries no reasoning, and the next
turn's request (rebuilt by `translate.toOpenAIMessages`) echoes none back. For most reasoning models
that is fine — reasoning is output-only. But **`deepseek-reasoner` is marked `tools: false`**
(`providers/index.js:73-83`, `catalog.js`) with the note *"its tool loop needs reasoning_content
round-tripping the boundary doesn't carry."* If K3 has the same requirement, it breaks in the agent —
and because K3's thinking is **always on**, there is no `kimi-k3-chat` to fall back to.

**The test — run before writing any provider row.** With a Moonshot key, drive a **multi-step**
tool-calling conversation directly against `https://api.moonshot.ai/v1/chat/completions`, `model:
"kimi-k3"`, `stream: true`, sending `tools`, and on the second turn send the assistant's prior
`tool_calls` + the `tool` result **without** any `reasoning_content` (exactly what the transcript
boundary produces). Three outcomes:

- **Works** → Path A is a pure data-row addition. Proceed to §4.
- **400 / rejects the turn** (like deepseek-reasoner) → K3 cannot be an agent model via the naive
  adapter. Options: (a) teach `streamOpenAIAgentTurn` to capture `reasoning_content` into a block and
  `translate.toOpenAIMessages` to re-emit it (real adapter work, no longer a data row); or (b) ship K3
  as **chat-only** (`tools: false`) and say so. Decide then.
- **Works but pollutes** — leaks `<think>…</think>` into `content` → already handled: the agent strips
  inline think tags from stored turns (`agent.js:621-631`). Just confirm it's clean.

Also confirm two body details during the spike: Moonshot accepts `max_tokens` (the adapter sends
`max_tokens`, not `max_completion_tokens`, because `kimi-k3` doesn't match the `o[1-9]` reasoning
heuristic at `openaiCompat.js:42-44`), and it accepts a `temperature` (K3 "thinking always on" endpoints
sometimes reject it). The quickstart's bare `model + messages` call implies defaults are fine; verify
under `tools`.

**Runnable version:** `extensions/levelcode-ai/scripts/kimi-k3-spike.js` does exactly this — it calls the
*real* `streamOpenAIAgentTurn` twice, building turn 2's transcript the way `agent.js` does (assistant
`tool_use` with reasoning already dropped, then a `tool_result`), and prints a PASS/FAIL/INCONCLUSIVE
verdict. It defaults to the Path-B route (OpenRouter, `moonshotai/kimi-k3`) so it validates production:
```bash
export OPENROUTER_API_KEY=…     # thin.ly: `rails credentials:show` → openrouter_api_key, or the EB env
node extensions/levelcode-ai/scripts/kimi-k3-spike.js
```
PASS → keep `tools:true`; FAIL → set the catalog `kimi-k3` to chat-only or add reasoning capture to the
adapter. Runs server-side with the gateway's own key — no user key, no editor build.

---

## 4. Path A — BYOK direct Moonshot provider (client only)

Copy the **DeepSeek** row — the closest analog (dedicated key, own `api.*/v1`, curated model list). No
adapter, dispatch, key-storage, picker, streaming, or tool-translation code changes: all are
provider-agnostic and key on the row's `kind: 'openai'`.

**A1 — registry row** · `providers/index.js` (alongside `deepseek`, ~`:73`):
```js
moonshot: {
    id: 'moonshot', kind: 'openai', label: 'Moonshot (Kimi)',
    baseURL: 'https://api.moonshot.ai/v1', keyId: 'moonshot',
    caps: { tools: true },                    // ← set tools:false here if §3 says chat-only
    models: [
        { id: 'kimi-k3', label: 'Kimi K3', detail: 'Moonshot · 1M ctx, reasoning' }
    ]
},
```
Follow DeepSeek exactly: no `vision` (image wire-format unverified), no `fast` (K3 is a large, slow
reasoning model — a poor ghost-text completer), no `agent: true` (appears claude-specific).

**A2 — per-model caps** · `providers/catalog.js` `CAPS` table (~`:27-56`):
```js
'kimi-k3': { context: 1048576, tools: true, reasoning: true },   // 2^20 — match the shipped caps exactly
```
`context` feeds the context meter; without it the agent falls back to 200 000 (`agent.js:618`) and would
badly under-report K3's 1M window. Do **not** add `kimi-k3` to `FAST_COMPLETION` (`catalog.js:110-116`).

**A3 — settings enum** · `package.json`, `levelcode.ai.provider` (`:274-304`): append `"moonshot"` to
**both** the `enum` array and the parallel `enumDescriptions` array (they must stay index-aligned). The
QuickPick lists built-in models automatically, but the settings-UI dropdown reads this enum.

**A4 — tests** · add `'moonshot'` to the `kind === 'openai'` id list (`test/providers.test.js:77`) and
the `listProviders` presence list (`:97`); assert `secretStorageKey('moonshot') ===
'levelcode.ai.key.moonshot'`. Add the `'kimi-k3'` caps-resolution + `supportsToolsForModel('moonshot',
'kimi-k3')` cases to `test/catalog.test.js`. Run: `for t in test/*.test.js; do node "$t"; done`.

**A5 — (optional) show K3's reasoning.** By default the separate `reasoning_content` is dropped, so users
see answers but not thinking — fine, and less clutter. If we want "watch Kimi think" as a demo hook,
teach `deltaFromEvent` / `streamOpenAIAgentTurn` to surface `d.reasoning_content` into a collapsible
reasoning block. Real adapter work; defer unless §3 forces it or marketing wants it.

**Verification (Path A):** unit tests green; then a live smoke test — set a Moonshot key via
`AI: Set API Key…`, pick **Moonshot (Kimi) → Kimi K3**, and (1) send a plain chat message, (2) run a
real agent task that edits a file and runs a command (the §3 loop, now end-to-end in the editor), (3)
confirm the context pill shows the 1M window. No key must ever touch settings/logs — it's in
SecretStorage (`extension.js:128-152`).

---

## 5. Path B — Kimi K3 in the Cloud gateway  ← **CHOSEN**

The zero-friction, mass-adoption path. It turned out **far simpler** than "stand up backend billing":
the gateway is driven by **one table** — `Levelcode::ModelCatalog::MODELS` in
`app/services/levelcode/model_catalog.rb` — and everything (entitlement, pricing, the derived multiplier,
the editor picker, the pricing page) falls out of it. And Kimi is reached **via OpenRouter**, not a direct
Moonshot key: the direct `MoonshotAdapter` is a disabled stub, and any `moonshotai/*` slug routes through
`OpenRouterAdapter` on the existing `OPENROUTER_API_KEY` (`ai_router.rb:49-56`). **Verified 2026-07-20:**
`moonshotai/kimi-k3` is **live on OpenRouter** — 1,048,576 ctx, $3/$15 in/out, cache $0.19–0.30.

### It ships without an editor release
The client picker reads the roster **live** from `GET /account/models` (`extension.js:210-233`). A new
`status: :confirmed` catalog row appears in every entitled user's picker **with no client update**. That
is the entire "make it available" feature.

### Two shapes — very different blast radius

**B1 — Add K3 as a *selectable* Pro model (recommended first).** One row in `model_catalog.rb` (after the
K2.7 entry, ~`:35`):
```ruby
"moonshotai/kimi-k3" => {
  label: "Kimi K3", provider: "openrouter",
  input: 3.00, cached_input: 0.30, output: 15.00,   # OpenRouter list $/M; ROUTING_FEE 1.055 added on top
  context: 1_048_576, min_tier: :pro, status: :confirmed
},
```
Server-only, ships instantly, doesn't touch anyone's default or existing cost. `status: :assumption`
first if you want it shown-but-not-billable during the spike. Reversible (flip status / delete the row).
Its **derived multiplier is ≈ 4×** the current K2.7 baseline (`REFERENCE_TURN` cost ratio) — the picker
shows that honestly, so users opt into the cost knowingly.

**B2 — Make K3 THE default flagship (separate, riskier — do NOT bundle with B1).** Also change
`DEFAULT_MODEL` (`lib/levelcode.rb:90`), the client `GATEWAY_PRO_MODEL` + label (`extension.js:174-175`),
and `levelcode.ai.cloudModel` default (`package.json:317`). This **re-bases every multiplier** (they're
relative to `DEFAULT_MODEL`), rewrites the multiplier specs, and — because K3 is ~4× the cost — **quarters
every paid user's effective turns-per-plan** silently. Plan budgets are revenue-based and model-independent
(`lib/levelcode.rb`), so margins are safe, but the *user-visible* `turns_left` drops ~4×. Defer until
capacity + cost are proven.

### Tests (B1)
- `spec/models/levelcode_model_catalog_spec.rb` — add K3 to the `rate_table` (`:16-19`), the multiplier
  map (`:30-36`), and confirmed-status list (`:7-14`); keep `MODELS` ordered so the monotonic-multiplier
  assertion (`:38-42`) still holds.
- `spec/requests/api/levelcode/v1/account_spec.rb:59-82` — assert K3 appears with `live: true`.
- Optional request spec: a Pro user may select `moonshotai/kimi-k3`; a free user may not.

### No changes needed
No adapter/key/routing edit (rides OpenRouter), no migration, no plan/budget change, no streaming-proxy
change — the proxy re-emits chunks **verbatim**, so K3's `reasoning_content` already passes straight
through to the editor (`ai_controller.rb:332-334`).

### The §3 spike, now server-side
Because thin.ly holds the `OPENROUTER_API_KEY`, the always-on-reasoning validation runs **without any user
key** — drive a multi-step agent turn through the gateway (or hit OpenRouter directly with that key) and
confirm K3 survives the tool loop with no `reasoning_content` echoed back. OpenRouter bills the hidden
reasoning trace at the full $15/M output rate, so watch real cost during the spike, not just correctness.

---

## 6. Risks

- **Always-on reasoning in the tool loop (§3)** — the one that can sink it. No non-reasoning K3 fallback.
- **Model-id drift** — Moonshot may also expose a dated snapshot (`kimi-k3-0716`-style, as K2 did). We seed
  the stable `kimi-k3`; the picker's "Browse all models (live)" (`extension.js:1230-1250` → `GET /v1/models`)
  surfaces snapshots without a code change.
- **Data governance** — Moonshot is a PRC company; `api.moonshot.ai` is the international endpoint but some
  users/orgs will care where prompts go. For BYOK it's the user's own call; for the **gateway default**
  (Path B) it's LevelCode's, so it's a positioning decision, not just an engineering one. Worth a line in
  the model's `detail` and the marketing.
- **Advertising accuracy** — K3's own launch materials put it behind the current Claude/GPT flagships on
  overall quality (ahead on some coding/agent benches). Advertise it as "supported / strong at coding,"
  not "best model," so the claim survives contact with users.
- **OpenRouter capacity (blocks B2, not B1)** — OpenRouter's own K3 page warns *"upstream capacity is
  currently limited, may return frequent 429 errors"* (4 days post-launch). As a *selectable* model (B1)
  a 429 hits only the user who chose it; as the *default* (B2) it would hit the entire paid base. Wait for
  capacity to settle before B2. Confirm the gateway degrades a 429 gracefully (`classify_upstream`,
  `ai_controller.rb:406-425`).
- **Cost, ~4× and hidden** — K3 is *always-on reasoning with no non-thinking mode*, and OpenRouter bills
  the reasoning trace at the full **$15/M output** rate. So every turn costs more than its visible answer
  implies, and K3's turn is ~4× the current flagship's. Fine as an opt-in (B1, multiplier shown); a silent
  ~4× budget burn if made default (B2).

---

## 7. Exit test

1. **Spike (§3)** passes, or the fallback (chat-only / adapter work) is chosen deliberately.
2. **Path A:** unit suites green (14 → still green with the new cases); live smoke test — chat + a
   real file-editing, command-running agent task on `kimi-k3` — succeeds; context pill shows ~1M.
3. **Path B (if pursued):** signed-in user with zero keys selects Kimi K3, runs an agent task, and the
   credits meter decrements at the expected multiplier.

## 8. Not doing (yet)

- Self-hosting the open weights (released ~2026-07-27) — out of scope; BYOK/gateway only.
- Vision/image input — K3 is multimodal, but the editor's image path isn't verified against Moonshot;
  ship text/code first, revisit `caps.vision` later.
- A bespoke reasoning-display UI (A5) — only if the spike or marketing calls for it.
