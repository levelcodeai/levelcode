# LevelCode — go to market

**Status:** plan. Five phases, gated. Phase 0 is not marketing; it is the three things that make marketing safe to spend on.

Written against the actual repos on 2026-08-18, not against a template. Every number below is either read out of the code or computed from prices the code itself records. Where something is unverified it says so.

---

## What LevelCode is, in the terms the business runs on

A VS Code fork with an agent, shipped as **a Mac app only** — `darwin-arm64` and `darwin` (Intel) are the two release targets in `editor_release_feed.rb`; there is no Windows or Linux build.

The money model is **freemium into prepaid credits**:

| | |
|---|---|
| Free | signed-in, unpaid; gateway access to `openai/gpt-oss-120b`, 5M input / 1M output tokens a month |
| Pro | $20/mo — 2,000 credits, 15M in / 2M out |
| Pro+ | $40/mo — 4,000 credits, 35M in / 4.5M out |
| Max | $60/mo — 6,000 credits, 55M in / 7M out |
| BYOK | free, always — your own key, no gateway |

`$1 = 100 credits`, and a credit is retail micro-dollars of real model spend. There is also auto-routing that already sends trivial turns to the cheap model and reserves the flagship for tool and agent turns — a gross-margin lever that exists and works.

---

## Phase 0 — Three things to close before spending a dollar on acquisition

Nothing here is growth work. All three are reasons a growth dollar would leak out of the bucket.

### 0.1 The front door fails on mobile networks

**The entire stack is IPv4-only.** Checked today, and checked twice — the first read looked like `www` was dualstack, but that was `dig` echoing a CNAME with no address behind it:

```
levelcode.ai                       A=100.61.52.98, 32.196.52.195      AAAA=(none)
www.levelcode.ai   -> CNAME thinly-env…elasticbeanstalk.com           AAAA=(none)
thinly-env…elasticbeanstalk.com    A=32.196.52.195, 100.61.52.98      AAAA=(none)
accounts.google.com                                                   AAAA=2607:f8b0:4004:c1b::54
```

Apex, `www`, and the Elastic Beanstalk load balancer behind them: no IPv6 anywhere. Every other host in the sign-in flow — Google's included — answers on IPv6.

On an IPv6-only mobile network, which is most 5G, the site is reachable only through the carrier's NAT64, and that is the shape of the sign-in hangs customers have already reported. This is **at the top of the funnel**: every acquisition dollar spent before it is fixed pays for a click that may never reach a sign-in.

The fix is two steps, in order — enabling the records without the load balancer behind them makes things worse, because an AAAA that resolves to nothing serving is a hard failure rather than a slow one:

1. Enable dualstack on the EB environment's load balancer.
2. Then add AAAA alias records for both `levelcode.ai` and `www` in Route 53.

**Exit:** `dig AAAA levelcode.ai` returns an address, and a sign-in completes on a phone with wifi off.

### 0.2 You do not currently know your gross margin

This is the team's own note, in `lib/levelcode.rb`:

> the plan caps/prices in PLANS were sized against the old ~$0.66/$3.41 assumption — re-check margins now that the flagship is a touch pricier.

Unresolved. Here is what it means, using the current list prices recorded in that same file (`kimi-k2.7-code`: $0.74/M in, $3.50/M out, $0.15/M cached), costing one **fully consumed** plan-month:

| Plan | Price | No cache | GM | 50% cached | GM | 80% cached | GM |
|---|---|---|---|---|---|---|---|
| Pro | $20 | $18.10 | **9%** | $13.68 | 32% | $11.02 | 45% |
| Pro+ | $40 | $41.65 | **−4%** | $31.32 | 22% | $25.13 | 37% |
| Max | $60 | $65.20 | **−9%** | $48.98 | 18% | $39.24 | 35% |

At full consumption and no prompt caching, **Pro+ and Max sell below cost**. Only a high cache-hit rate pulls them back above water.

Read the structure, not just the numbers: **margin on this model does not come from usage, it comes from unused allowance.** That is a legitimate business (gyms, phone plans) but it inverts the usual GTM instinct — your heaviest, most enthusiastic, most vocal users are your least profitable, and an AI coding tool selects for exactly those people. A campaign that lands power users faster than casual ones can grow revenue and shrink cash at the same time.

The good news: the number that decides this is **already being recorded**. `usages.cached_input_tokens` exists per row. One query answers it.

**Exit:** the real blended cache-hit rate and the P50/P90/P99 of consumption per plan are known. Then either the caps move, the prices move, or the routing gets more aggressive — but the decision is made on data, before it is made at scale.

### 0.3 What the site promises must match what the build does

Recorded previously and still worth re-checking before a launch: the README and CLAUDE.md advertise features that are not in the shipped extension. The docs surface is now thirteen pages (`overview`, `agent`, `chat`, `autocomplete`, `edit`, `power-editing`, `providers`, `cloud`, `hackability`, `import-and-updates`, `quickstart`, `setup`, `troubleshooting`).

Before any of it is amplified, walk each page against a clean install of the current release. A launch is the worst possible moment to discover the docs oversell, because the people you attract are the people who will check.

**Exit:** every claim on every docs page is either true of the shipped build or removed.

---

## Phase 1 — Make the funnel legible

You cannot run a GTM motion on numbers you cannot trust. The instrumentation mostly exists; it needs tightening.

**The referral report already documents its own weaknesses** — this is unusually honest code, and the caveats are load-bearing:

- clicks are attributed by parsing a channel out of `links.original_url`, so **editing a link's destination silently re-attributes all of its past clicks**
- clicks, signups and paid conversions are joined by **channel name only** — three unrelated tables, one string
- signups come from `users.signup_attribution->>'source'`

Fix the first one before running paid campaigns: freeze a channel token at click time rather than deriving it from a mutable URL. Otherwise your first real campaign will rewrite the history you are measuring it against.

**Define activation, and instrument it.** Not "signed up". Something like *first agent turn that produces a kept edit* — the moment the product has demonstrably done work. Every later decision (onboarding, pricing, channel spend) is scored against that number.

**Treat the free tier as a real COGS line.** A fully-burned free month is roughly $0.90 of model spend per user at gpt-oss-120b rates. That is a genuine cost of acquisition and belongs next to ad spend in the same table, not filed under infrastructure.

**Exit:** a weekly view of click → signup → activation → paid, per channel, that you would be willing to make a spending decision on.

---

## Phase 2 — Position

**Own the Mac-only constraint rather than apologising for it.** macOS is a large minority of professional developers and skews toward higher willingness to pay and toward the early-adopter audience that tries new editors at all — worth confirming against a current developer survey before it goes in a deck, but directionally the constraint is not the handicap it looks like. The alternative — a rushed Windows build — splits an already-small team's QA across platforms at the moment the product needs polish most. Ship Mac, say so plainly, and put Windows on a public "not yet" list, which converts a weakness into a signal that you have a roadmap.

**The wedge is the pricing model, not the feature list.** Against Cursor and the Claude Code console, feature-for-feature comparison is a losing frame — they are bigger and faster. Two things are structurally yours:

1. **BYOK is free, forever.** No seat, no floor, no minimum. That is a genuinely different offer from a subscription that gates the editor itself, and it converts the "I already pay for an API key" objection from a blocker into a reason to install.
2. **Credits are real retail dollars, shown to you.** The editor and the dashboard render the same balance from the same code path. Cost transparency is rare and it is exactly what the price-sensitive, technically literate buyer wants.

The honest positioning is roughly: *the AI editor that doesn't make you rent your own API key back from us.*

**Do not lead with the agent.** Everyone leads with the agent. Lead with the thing you can prove in ten seconds on a landing page.

---

## Phase 3 — Channels, sequenced by what the product can prove

Run these in order. Each one is gated on the previous phase's exit criteria, and none of them starts before Phase 0 closes.

**3.1 — Founder-led, unpaid, high-signal (weeks 1–6).** Show the work. This codebase has genuinely interesting engineering in it — a silent block-drop bug in a provider translator, a token estimator that measured bytes, a wordmark that shattered because `█` doesn't tile in Monaco. Write those up. Developer audiences reward specificity and punish polish; the failure posts travel further than the feature posts. Zero CAC, and it builds the thing paid channels need: something to point at.

**3.2 — The BYOK trial as the top of funnel (weeks 4–10).** Because BYOK costs you nothing to serve, it is an unusually cheap acquisition offer: *install it, use your own key, pay us nothing.* The conversion to credits comes later, from people who get tired of managing keys or want the routing. Instrument BYOK installs separately — they are not free-tier users and should not be measured as though they were.

**3.3 — Comparison and migration content (weeks 6–12).** `import-and-updates` already exists as a docs page. The highest-intent search traffic in this category is people already using a competitor. Meet it.

**3.4 — Paid, last and small (week 12+).** Only after activation is instrumented and gross margin is known. Paid acquisition into an unmeasured funnel with unknown unit economics is how a company spends its runway learning what a query would have told it.

---

## Phase 4 — Pricing motion

Sequenced after 0.2, because these choices depend on its answer.

- **If the blended cache rate is high** (say >60%), the current ladder works and the job is a Team tier above Max.
- **If it is low**, the caps must come down or the prices must go up — and the cheapest fix is neither: extend the existing auto-routing so more turn shapes qualify for the cheap model. That lever is already built and costs nothing to tune.
- **Annual billing** improves cash and reduces churn, and on a breakage-based model it also smooths the heavy-user problem across twelve months instead of one.
- **A usage-based top-up** above the plan cap is the natural relief valve for the heavy users who are currently your loss leaders. Selling them more credits at retail turns your worst-margin customers into your best.

---

## Phase 5 — Scale gates

Do not move to the next stage until the previous one holds:

1. Activation rate stable and understood
2. Gross margin positive at P90 consumption, not just at median
3. A channel with repeatable, attributed, positive-margin conversion
4. Then, and only then, spend into it

---

## What this plan deliberately does not do

- **No Windows build.** It doubles QA surface at the moment polish matters most. Revisit after Phase 3.
- **No enterprise motion.** SSO, audit logs and procurement are a different company. The credits model and BYOK point at individuals and small teams.
- **No launch-day event.** Product Hunt and similar reward a moment; this product needs the docs-versus-build audit and the margin answer first. A launch is a lever you can pull once — pull it when the funnel holds.

---

## Open questions only you can answer

- **What is runway, and is the goal revenue or users?** A breakage-margin model optimised for revenue and one optimised for growth diverge sharply, and this plan is sequenced for the former.
- **Is thin.ly still an active business?** The two products share a Stripe account. `credit_wallets.product` now separates them for reporting, but shared billing infrastructure constrains how independently either can price, and eventually how either can be sold or raised against.
- **Is the flagship model choice fixed?** Every margin number above moves with it, and switching costs are mostly a routing-table change.
