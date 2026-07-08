# LevelCode — Universal Multi-Provider BYOK — Design

> **Status:** Draft v0.1 · **Date:** 2026-06-29 · **Owner:** Sergii Demianchuk
> **Goal:** Unlock LevelCode from Anthropic-only to a broad development tool that works with **any** model provider in BYOK mode — the way Cline and Continue.dev do — without giving up LevelCode's dependency-free, no-build-step extension model.

## 0. TL;DR

LevelCode AI is Anthropic-only (with a second-class Ollama path): an `if (provider === 'claude') {…} else {…}` branch is copy-pasted at every call site, and the **agent is hard-gated to Claude**. Both Cline and Continue solved "many providers, little code" the **same** way:

**one provider interface + a single OpenAI-compatible adapter that covers dozens of providers + OpenRouter as a one-key mega-lever.**

We adopt that pattern — but **hand-write the 2–3 protocol adapters with `fetch` + SSE** (as `streamClaude`/`streamOllama` already do) instead of pulling in the Vercel AI SDK, because **LevelCode extensions are plain JS with no build step** (CLAUDE.md). Phased so the biggest unlock (300+ models for chat/completion/edit) lands first, and the genuinely hard part (the *agent* across providers) is isolated.

---

## 1. How Cline + Continue actually do it

Despite different stacks, both converge on the **same four ideas**:

### 1.1 A provider-abstraction interface + registry dispatch
- **Cline:** `interface ApiHandler` (`sdk/packages/llms/src/providers/handler.ts`) — `createMessage(system, messages, tools) → ApiStream`, `getModel()`. Factory `createHandler(config)` does registry lookup → gateway → adapter.
- **Continue:** `abstract class BaseLLM implements ILLM` (`core/llm/index.ts`) owns *all* orchestration (token counting, retry, logging, tool-override); a subclass overrides only `_streamChat`. Dispatch is one `LLMClasses.find(c => c.providerName === desc.provider)`.
- **Takeaway:** the base owns orchestration; the adapter owns only the wire protocol. Adding a provider = one entry, not a new call path.

### 1.2 ONE OpenAI-compatible adapter covers the long tail
- **Cline:** **~35 of ~49** provider specs use `family: "openai-compatible"` — a declarative data row `{ id, baseUrl, defaultModelId, apiKeyEnv }`, **no adapter code**. DeepSeek, xAI, Together, Fireworks, Groq, Cerebras, Moonshot, Qwen, Doubao, Z.AI, LM Studio, Ollama, LiteLLM, **OpenRouter** — all just rows in `builtins.ts`.
- **Continue:** **~50 of ~70** providers are ~15-line subclasses of one `OpenAI` class setting only `static providerName` + `defaultOptions.apiBase` (`Groq.ts`, `Together.ts`, `Deepseek.ts`, `xAI.ts`, `Fireworks.ts`, `Cerebras.ts`, `Moonshot.ts`, `LMStudio.ts`, `Vllm.ts`, …).
- **Takeaway:** the `/v1/chat/completions` standard is the single highest-leverage adapter. Build it once, parameterize by `{ baseURL, apiKey, model }`.

### 1.3 OpenRouter = one key → hundreds of models
Both ship OpenRouter as a single OpenAI-compatible endpoint (`https://openrouter.ai/api/v1`). One user key exposes Anthropic + OpenAI + Google + Meta + Mistral + hundreds more, with a live `/api/v1/models` catalog carrying **context length + pricing + modality**. This is the cheapest possible path to breadth for a small team.

### 1.4 Only ~3 real protocols need bespoke code
Everything reduces to **OpenAI Chat Completions**, **Anthropic Messages** (blocks + thinking + `cache_control`), and **Gemini** (`functionDeclarations`/`functionCall`). Everything else is OpenAI-compatible or reachable via OpenRouter.

**The one divergence that matters for us:** Cline delegates *all* transforms to the **Vercel AI SDK** (`streamText()`) — inheriting tools/streaming/multimodal for free, but as an npm-installed, **bundled** dependency. LevelCode ships extensions as plain JS with no build step, so we follow **Continue's model**: hand-write the adapters with `fetch` + SSE. The existing `streamClaude`/`streamOllama` already prove the pattern; the new OpenAI adapter is ~200 lines, once.

---

## 2. Recommended architecture for LevelCode

### 2.1 Module layout — `extensions/levelcode-ai/providers/`

Today everything is one flat `providers.js` with eight provider-named exports and hard-coded Anthropic assumptions in 4 places. Evolve it into a directory (keep `providers.js` as a thin re-export shim during migration so nothing breaks mid-refactor):

```
extensions/levelcode-ai/providers/
  index.js         # registry (PROVIDERS data table) + getProvider(id) + resolveProvider(id) + shared readLines()
  anthropic.js     # native Anthropic Messages adapter (streamClaude/completeClaude/streamClaudeAgentTurn moved here)
  openaiCompat.js  # THE universal adapter — /v1/chat/completions, param'd by {baseURL, apiKey, headers}
  gemini.js        # (P3) native Google adapter
  bedrock.js       # (P3) native AWS SigV4 adapter
  translate.js     # (P2) tool-use translation: Anthropic tool_use/tool_result <-> OpenAI tool_calls/role:tool
  catalog.js       # (P4) model catalog: dynamic /models fetch + a static capability/pricing table
```

### 2.2 The registry — a data table (the "many providers, little code" core)

```js
// providers/index.js
const PROVIDERS = {
  anthropic:  { kind:'anthropic', label:'Anthropic',   keyId:'anthropic', caps:{tools:true, caching:true, vision:true} },
  // every openai-kind row shares ONE adapter — differ only by baseURL + auth + caps
  openai:     { kind:'openai', label:'OpenAI',     baseURL:'https://api.openai.com/v1',           keyId:'openai',   caps:{tools:true, vision:true} },
  openrouter: { kind:'openai', label:'OpenRouter', baseURL:'https://openrouter.ai/api/v1',        keyId:'openrouter', caps:{tools:true, vision:true}, headers:{'HTTP-Referer':'https://levelcode.ai','X-Title':'LevelCode'} },
  groq:       { kind:'openai', label:'Groq',       baseURL:'https://api.groq.com/openai/v1',      keyId:'groq',     caps:{tools:true} },
  together:   { kind:'openai', label:'Together',   baseURL:'https://api.together.xyz/v1',         keyId:'together', caps:{tools:true} },
  fireworks:  { kind:'openai', label:'Fireworks',  baseURL:'https://api.fireworks.ai/inference/v1', keyId:'fireworks', caps:{tools:true} },
  deepseek:   { kind:'openai', label:'DeepSeek',   baseURL:'https://api.deepseek.com/v1',         keyId:'deepseek', caps:{tools:true} },
  xai:        { kind:'openai', label:'xAI',        baseURL:'https://api.x.ai/v1',                 keyId:'xai',      caps:{tools:true, vision:true} },
  mistral:    { kind:'openai', label:'Mistral',    baseURL:'https://api.mistral.ai/v1',           keyId:'mistral',  caps:{tools:true} },
  ollama:     { kind:'openai', label:'Ollama (local)', baseURL:'http://localhost:11434/v1',       noKey:true,       caps:{tools:false} },
  custom:     { kind:'openai', label:'OpenAI-compatible (custom)', baseURL:null /* user-supplied */, keyId:'custom', caps:{tools:true} },
};
```
Adding Cerebras / Moonshot / Qwen / Perplexity later = **adding a row, zero code**.

### 2.3 The Provider interface

Mirror the current `opts` shapes so migration is mechanical:

```js
/**
 * @typedef {Object} Provider
 * @property {(o)=>Promise<void>}          streamChat       // chat; opts.onDelta(text); resolves at end
 * @property {(o)=>Promise<string>}        complete         // one-shot (inline completion, edit)
 * @property {(o)=>Promise<AgentTurn>}     streamAgentTurn  // agent loop turn (P2+)
 * @property {(o)=>Promise<ModelInfo[]>}   listModels       // for the picker (P4)
 * @property {ProviderCapabilities}        capabilities     // {tools, vision, streaming, caching}
 * @property {'anthropic'|'openai'|'gemini'} kind           // drives message/tool translation
 */
```

### 2.4 Keep the native Anthropic adapter
Move `streamClaude`, `completeClaude`, `claudeAgentTurn`, `streamClaudeAgentTurn`, `finalizeAgentBlocks` **verbatim** into `providers/anthropic.js`. **Do not route Anthropic through OpenRouter** — the native path gives prompt caching (`cache_control`) and highest-fidelity tool-use, both of which the agent depends on. The internal agent transcript already *is* Anthropic-block-shaped, so the default provider needs **zero** translation.

### 2.5 The one new adapter — `openaiCompat.js`
A single `fetch`-based `/v1/chat/completions` streamer, reusing the existing `readLines()` SSE helper. Handles:
- **Auth:** `Authorization: Bearer <key>` (+ optional per-spec `headers`, e.g. OpenRouter's `HTTP-Referer`/`X-Title`).
- **Body:** `{ model, messages, max_tokens, stream:true }` — `system` becomes a `{role:'system'}` message (OpenAI has no top-level `system` field), exactly as `streamOllama` already does.
- **SSE parse:** `data:`-prefixed lines; text at `choices[0].delta.content` (vs Anthropic's `content_block_delta`/`text_delta`); `[DONE]` sentinel.
- **Ollama consolidation:** Ollama exposes `/v1/chat/completions`, so the bespoke `streamOllama`/`completeOllama` can be **deleted** and Ollama becomes just a row (`baseURL:'http://localhost:11434/v1', noKey:true`). Keep `listOllamaModels` (`/api/tags`) for the picker.

---

## 3. The HARD part — agentic tool-use translation (P2)

The agent (`agent.js`) is 100% Anthropic-block-shaped and hard-gated off for non-Claude (`extension.js`). Strategy (both Cline and Continue use it): **keep the internal transcript in Anthropic block shape; translate to/from OpenAI at the adapter boundary only** — least-invasive because `agent.js`, `finalizeAgentBlocks`, and `repairAgentMemory` all depend on `tool_use`/`tool_result` id-pairing.

### 3.1 What has to be translated (Anthropic ↔ OpenAI)

| Concern | Anthropic (internal canonical) | OpenAI (wire, in `openaiCompat.js`) |
|---|---|---|
| **Tool defs** | `TOOLS`: `{ name, description, input_schema }` | `tools:[{type:'function', function:{name, description, parameters: input_schema}}]` (field rename) |
| **Assistant tool call** | `{type:'tool_use', id, name, input}` block | `message.tool_calls:[{id, type:'function', function:{name, arguments: JSON.stringify(input)}}]` |
| **Tool result** | `{role:'user', content:[{type:'tool_result', tool_use_id, content}]}` | a separate `{role:'tool', tool_call_id, content}` message per result |
| **Assistant text + tools** | one msg, `content:[{text},{tool_use}]` | one msg with `content` string **and** `tool_calls` array |
| **stop_reason** | `end_turn` / `tool_use` / `max_tokens` | `finish_reason: stop` / `tool_calls` / `length` → normalize back |

Lives in `providers/translate.js`: `toOpenAIMessages()`, `toOpenAITools(TOOLS)`, `fromOpenAIStopReason()`, and the streaming assembler. `agent.js` stays untouched except swapping its one turn call to a provider-dispatched `streamAgentTurn`.

### 3.2 The streaming difference (the genuinely tricky bit)
Anthropic streams a tool call as `content_block_start(tool_use)` + accumulated `input_json_delta.partial_json`. OpenAI streams `choices[0].delta.tool_calls[]` with an **`index`** and incremental `function.arguments` fragments (and the `id`/`name` only on the first fragment per index). The OpenAI adapter must assemble by `index`, then hand `agent.js` the same canonical `{type:'tool_use', id, name, input}` blocks (+ the `malformed` Set) that `finalizeAgentBlocks` produces today.

### 3.3 Capability gating
A `PROVIDER_TOOL_SUPPORT`-style check (Continue's `toolSupport.ts`): only offer the agent when the selected model supports native tools (Anthropic claude-3+, OpenAI gpt-4+/o-series, most OpenRouter models, etc.); otherwise keep the agent Claude-only or fall back to chat. Store per-model `supportsTools` in the catalog (§4).

---

## 4. Model catalog + picker (P4)
Collapse the 3 hard-coded Claude lists (`extension.js` model list, `lmProvider.js` MODELS, `package.json` enum) into **one catalog**:
- **Dynamic fetch** where available: OpenRouter `/api/v1/models` (ids + context + pricing + modality), OpenAI `/v1/models`, Ollama `/api/tags`.
- **A small static capability table** merged in (context window, `supportsTools`, `supportsVision`, caching) for providers that only return ids. **Done** — `catalog.CAPS` + basename/family heuristics + a permissive `tools:true` default for unknown ids (so a brand-new model is never wrongly locked out of the agent).
- Drives `pickModel` (caps shown inline; a live "Browse all models" action fetches the provider's full `/models` list) and the agent gate, carrying **real** per-model `contextWindow`/`supportsTools` (`catalog.supportsToolsForModel` combines the provider gate with a per-model opt-out — e.g. `deepseek-reasoner` is offered for chat but blocked from the agent). The LM provider stays Claude-only (all Claude models are already 200k/native).
- **Per-provider fast completion model** — **done**: `catalog.fastCompletionModel` gives ghost-text a snappy model per provider (`gpt-4o-mini`, `llama-3.1-8b-instant`, `codestral-latest`, …), falling back to the active chat model when none is curated.

---

## 5. Keys, settings & UI

- **Per-provider keys.** Replace the single `levelcode.ai.anthropicKey` (read in ~7 places) with `levelcode.ai.key.<provider>` in SecretStorage + a provider-aware `promptForKey(providerId)` (current one is hardwired to Anthropic copy). `noKey` providers (Ollama) skip it.
- **Settings schema.** Widen `levelcode.ai.provider` beyond `["claude","ollama"]` to the registry ids; add `levelcode.ai.model` (active model id, free-text/picked) and `levelcode.ai.baseURL` (for the `custom` OpenAI-compatible provider).
- **Customize panel.** The AI section gains a provider dropdown + "Set key for <provider>" + model picker + (for `custom`) a base-URL field.

---

## 6. Phased plan

| Phase | Deliverable | Files | Unlock |
|---|---|---|---|
| **P1** ✅ | `providers/{index,anthropic,openaiCompat,sse}.js` + registry; route **chat / inline-completion / edit** through it; per-provider keys; widen settings | `providers/*`, `extension.js`, `inlineComplete.js`, `aiEdit.js`, `package.json`, `customize.js` | **300+ models for chat, completion & edit** — no longer Anthropic-only |
| **P2** ✅ | `providers/translate.js` + OpenAI streamed-tool-call assembler (`streamOpenAIAgentTurn`); `providers.streamAgentTurn` dispatch; un-gate the agent via `supportsTools` | `providers/translate.js`, `openaiCompat.js`, `providers/index.js`, `agent.js`, `extension.js` | The **agent** runs on OpenAI-shaped providers |
| **P3** 🎯 *held for launch* | Native `gemini.js` / `bedrock.js` adapters | `providers/gemini.js`, `providers/bedrock.js` | Direct Google Gemini + AWS Bedrock BYO-key — **both already reachable via OpenRouter today**, so native is the *announceable upgrade*, not a coverage gap |
| **P4** ✅ | `catalog.js` — static caps table + heuristics + dynamic `/models` fetch; **per-model** `supportsToolsForModel` (agent gate), `contextWindowFor` (meter), `fastCompletionModel` (ghost-text); caps-aware `pickModel` + live "Browse all models" | `providers/catalog.js`, `extension.js`, `inlineComplete.js`, `customize.js`, `providers/index.js` | Real per-model capabilities + a live, searchable catalog |

**P1 is ~90% of the value for ~10% of the effort** and is a clean, dependency-free adapter mirroring code that already exists. P2 (the agent across providers) is the hard part and is deliberately isolated.

> **P3 is intentionally deferred as a release/marketing beat**, not a backlog gap. Gemini and Bedrock models already work in LevelCode *today* through OpenRouter (BYO OpenRouter key), so P3 delivers the *native, direct-with-your-own-Google/AWS-key* path — a concrete "new in LevelCode" headline to announce once there's a downloadable app and an audience following updates. Do not build it opportunistically; hold it for launch.

### 6.1 P2 provider-compat notes (from adversarial review)
The agent runs on OpenAI-shaped providers via the boundary translation, but three real wire-protocol quirks were handled explicitly (the transcript stays Anthropic-shaped; these live in `openaiCompat.js`/`index.js`):
- **Reasoning models** (OpenAI `o1`/`o3`/`o4`, incl. OpenRouter `openai/o3-mini`) reject `max_tokens` + non-default `temperature` → `buildChatBody` sends `max_completion_tokens` and omits temperature for them (`isReasoningModel`).
- **Streamed usage** is omitted unless requested → the agent turn sets `stream_options:{include_usage:true}` so the context meter isn't stuck at 0 on non-Anthropic providers.
- **`deepseek-reasoner`** requires `reasoning_content` round-tripping on every tool turn (400s otherwise), which the boundary intentionally doesn't carry → it's not listed as a picker model (only `deepseek-chat`); revisit with per-model handling in P4.
- Synthetic tool-call ids (used only when a provider omits one) are kept Mistral-legal (`[a-zA-Z0-9]{9}`), and a tool call whose name never streamed is dropped rather than re-serialized as an illegal `function.name:""`.

---

## 7. Notes & security
- **Keys stay in SecretStorage (OS keychain)**, per provider, and are **never** synced (consistent with the Sync design).
- **The `custom` OpenAI-compatible base URL is user-supplied** — validate it's `https` (or explicit localhost) before use; don't send keys to an arbitrary `http` host silently.
- **BYOK-primary alignment**: multi-provider is exactly the BYOK-primary story — the user brings *any* provider's key. A future managed gateway would reuse the same registry + adapters server-side.
- **No new npm dependencies / no build step** — every adapter is plain-JS `fetch` + the existing `readLines()`.
