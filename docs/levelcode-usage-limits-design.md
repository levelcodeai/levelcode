# Usage Limits: How Claude Code & Cursor Meter Plans — and the LevelCode Design

*July 2026. Companion to `levelcode-paid-plans-model-economics.md` (credit scheme) and
`levelcode-free-tier-economics.md`. Grounded in current vendor docs (sources at end).*

## 0. Decoding the two screenshots

**cursor.png (free/Hobby account, at the limit)** shows two unrelated things:
1. *Plan usage exhausted*: the "You've hit your usage limit" banner + Upgrade CTA, and
   the model picker locked (🔒 next to Composer 2.5 Fast). Hobby ≈ 2,000 completions +
   ~50 premium agent requests/mo (deliberately unpublished / adjustable).
2. *Context Usage panel* (9% of 200K): a transparency feature showing what fills the
   context window — system prompt 486, tool definitions 8.8K, rules 3.7K, MCP 1.3K,
   subagent definitions 850, conversation 3.4K. **This is not plan usage** — it's
   context composition.

**claude.png (Claude Code, Max plan)** shows:
1. *Context window* 365.4k / 1.0M — again context, not plan.
2. *Plan usage*: "5-hour limit · Resets 3:30 PM · 59%" and "Weekly · all models ·
   Resets Jul 12 · 35%" — the two rolling budgets described below.

## 1. Claude Code: rolling time-window budgets (opaque compute units)

- **Dual limit**: a **5-hour session budget** + a **rolling 7-day weekly cap**. The
  session opens at your first prompt and covers everything for the next five hours;
  the timer follows the account, not the clock. The weekly cap is the absolute
  ceiling for a rolling week, aimed at "24/7" heavy users, and some plans carry a
  separate weekly Opus budget.
- **Shared pool**: Claude Code and Claude chat draw from the same session pool.
- **Unit of account is opaque**: budgets are compute-based; Anthropic publishes
  ratios, not tokens (Max 5x / Max 20x = 5× / 20× Pro's session capacity; 5-hour
  limits were doubled across paid plans on May 6, 2026). Expensive models burn the
  budget faster.
- **At the limit**: hard stop with a reset countdown; Max plans can buy extra usage
  at API rates; model fallback (Opus → Sonnet) stretches budgets.
- **Surface**: Settings → Usage progress bars; in-product meter like the screenshot.

**What this design buys**: the 5h window smooths infrastructure load and prevents
budget hoarding into single mega-bursts; the weekly cap bounds worst-case cost per
subscriber (the "cap is the margin floor" principle). The opacity gives Anthropic
tuning freedom but generates constant user confusion/anxiety — the top complaint.

## 2. Cursor: dollar-denominated included usage (transparent-ish credits)

- **Unit of account is dollars**: each paid plan includes a monthly credit pool
  ("included usage", ≈ plan price — Pro = ~$20/mo) that depletes by the *actual
  inference cost* of each request. No request counts — a $20 pool buys ≈225 Sonnet
  requests or ≈650 GPT-4.1 requests. Resets on the billing date.
- **Free (Hobby)**: small fixed allowances (≈2k completions, ≈50 premium requests),
  unpublished exact numbers; at the cap → the banner + locked premium models.
- **At the limit (paid)**: opt-in **on-demand usage** billed in arrears (pay-as-you-go
  overage), or keep working via Auto.
- **The Auto escape valve**: Auto mode (Cursor picks the model — usually their own
  Composer) does **not** draw from the included pool; it's their margin lever —
  cheap self-hosted inference presented as an unlimited-feeling lane.
- **Surface**: in-chat banner (screenshot), dashboard with per-model spend, usage
  emails; plus the Context Usage breakdown panel for context transparency.

**What this design buys**: dollars are honest and models are instantly comparable;
overage converts power users into revenue instead of churn. Weakness: no rate
governor — a user can burn a month's pool in a weekend, and "dollar anxiety" makes
some users under-use the product.

## 3. Side by side

| Dimension | Claude Code | Cursor | LevelCode (recommended) |
|---|---|---|---|
| Unit of account | Opaque compute units | **Dollars (credits)** | **Dollars (credits)** — per economics doc |
| Budget window | 5h rolling + 7d rolling | Monthly (billing date) | Monthly pool + **5h/7d governors** |
| Model cost handling | Faster burn, ratios unpublished | Actual $ cost per request | Actual $ from ledger; published multipliers |
| At the limit | Hard stop + countdown; buy extra (Max) | Overage opt-in; Auto lane free | **Degrade → gpt-oss lane**, then stop; overage opt-in (Max/Ultra) |
| Escape valve | Model fallback Opus→Sonnet | Auto mode (own model, excluded) | **Auto router** (gpt-oss/Kimi, governed-unlimited) |
| Transparency | % bars only | $ amounts + per-model dashboard | % + $ + per-model turns estimate |
| Abuse bound | Weekly cap | Dollar pool itself | Monthly pool ∧ weekly governor ∧ session governor |

## 4. The LevelCode metering design (steal the best of both)

Monthly compute budget **B** per plan comes from the credit-scheme doc
(Pro $14.43 / Pro+ $33.05 / Max $51.67 / Ultra $88.91). On top:

1. **Session governor (Claude-style)**: 5-hour rolling cap = **B / 20**
   (Pro ≈ $0.72 ≈ 19 Kimi turns per 5h at full burn). Allows ~3× the average
   day in a burst, smooths gateway load, kills runaway-loop damage.
2. **Weekly governor**: rolling 7d cap = **B / 3.2** (Pro ≈ $4.51). Bounds a
   compromised/abusive account to ~31% of monthly budget per week while letting
   legitimate crunch weeks through.
3. **At-limit ladder (graceful, not a wall)**:
   - 75% / 90% of any window → quiet meter color change + toast.
   - Session cap hit → **offer the free lane**: "Session limit reached — continue
     on gpt-oss-120b (doesn't count) or wait 1h 12m." (0.05× cost ≈ noise; the
     user never stops working — better than both competitors.)
   - Weekly/monthly cap → Cursor-style banner + single CTA (upgrade tier or
     opt-in overage at cost+20%, Max/Ultra only), with Claude-style reset time.
4. **Auto lane**: "Auto" model choice routes gpt-oss/Kimi and is marketed as
   *unlimited on paid plans* — honest footnote: subject to the weekly governor.
5. **UI**: one popover, exactly the claude.png layout (context bar + plan bars
   with reset times) — we already ship the context donut (PLAN §M5); add the two
   plan bars from the Redis ledger. Free tier gets the cursor.png treatment:
   banner + 🔒 on gateway models, BYOK always unlocked (our unique third lane).
6. **Ledger truth**: meter actual provider cost per request (M10 usage ledger);
   publish per-model multipliers on the pricing page; recompute monthly.

**Why this wins**: Cursor's honesty (dollars, published multipliers) + Claude's
load-smoothing and abuse bounds (rolling governors) + a degradation lane neither
has (gpt-oss continuation instead of a hard stop) + BYOK as the pressure-release
valve no competitor offers at all.

## Sources

- https://support.claude.com/en/articles/9797557-usage-limit-best-practices
- https://www.morphllm.com/claude-code-usage-limits
- https://usagebar.com/blog/claude-code-weekly-limit-vs-5-hour-lockout
- https://cursor.com/help/models-and-usage/usage-limits
- https://cursor.com/docs/models-and-pricing
- https://www.verdent.ai/guides/cursor-usage-limits-explained
- https://www.finout.io/blog/what-happened-to-cursor-pricing-2026-guide-5-cost-cutting-tips
