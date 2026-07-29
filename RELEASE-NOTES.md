# LevelCode v1.0.4

The big one: **the agent can now use external tools over MCP** — a filesystem server, GitHub, Postgres, an internal company server — alongside its own built-in tools, with a security model that treats an MCP server as exactly what it is: arbitrary code that runs with your privileges. Plus autopilot now honors a changed step limit live, and the agent's activity timeline reads as one clean thread.

## Highlights

### Bring your own tools, over MCP

Point LevelCode at any [Model Context Protocol](https://modelcontextprotocol.io) server and its tools join the agent's own — namespaced `server__tool`, usable by every model LevelCode supports, with no code to write. This first release speaks **stdio** (a server you run as a local subprocess), which covers the overwhelming majority of servers and sidesteps the remote-transport spec churn landing this year; remote/HTTP servers come later.

You declare a server in one of two places, and they are trusted differently on purpose:

- **`levelcode.ai.mcp.servers`** (your own settings) — you typed it, so it starts.
- **`.levelcode/mcp.json`** (committed in a repo) — read and listed, but it **never starts on its own**.

### Security is the feature, not a footnote

Spawning an MCP server is at least as dangerous as running a shell command, so every edge is gated:

- **A launch gate for repo servers.** A `.levelcode/mcp.json` server asks before it ever runs, showing you the **literal command, arguments, and environment** — no summarizing. Approve once and it's remembered, but trust is bound to a **SHA-256 fingerprint of exactly what would run**: change the command, an argument, *or* an env var and it asks again — so a repo can't get `npx …server-filesystem` approved and then quietly swap in `curl … | sh` under the same name. With no window to ask in (a headless or test context) it **fails closed** and simply doesn't start.
- **Every tool call asks by default**, showing server · tool · arguments before it runs.
- **Autopilot doesn't relax this.** MCP tools are third-party code, so autopilot still prompts for them — the *only* thing that grants a silent run is your own per-tool allow-list (`"github__list_issues": "allow"`). A server's own "this is safe" hint grants nothing on its own; its "this is destructive" hint forces a prompt regardless.

### Manage MCP servers without touching JSON

A new **`AI: Manage MCP Servers…`** command (and a link at the foot of `/mcp`) lets you:

- **Add or remove a server** through a prompt instead of hand-editing settings — it writes your global settings only, never a repo's, so adding one can never weaken the launch gate above. The arguments box takes a real command line and splits it quote-aware, so `-y @modelcontextprotocol/server-filesystem "/Users/me/My Documents"` stays one path.
- **Revoke trust** you granted a repo server, per server or workspace-wide — the missing other half of "trust on first use," which used to be a write-once decision.
- **See a stale approval for what it is** — a server whose command changed since you approved it now reads `command changed — needs approval`, not a bland "not started," because that gap is exactly the attack the launch gate exists to stop.

### See what's configured with `/mcp`

`/mcp` lists every **configured** server — running or not — with its state, where it came from, its exact command, and (once live) its tools and whether each is allow-listed. It answers the two questions you actually have — *why isn't my server being used?* and *what is this repo asking to run?* — that a list of only-running servers can't. The context-usage popover now also breaks out an **MCP tools** line, so the standing per-turn cost of a chatty server is no longer invisible.

### A cleaner agent timeline

The activity thread under each run — its tool calls, approvals, and commands — now reads as **one connected line** instead of disconnected stubs: the connector rail threads continuously through consecutive steps (only a stretch of narration breaks it), the way GitHub, Cursor, and Claude Code draw theirs. And an **approved MCP tool call is now a single row** — not an `Approved · server · tool` chip *plus* a separate `🔌 server · tool` node — so it's one row per action, matching how allow-listed calls already looked.

### Autopilot honors a changed step limit, live

Raising **Maximum tool-use steps** mid-run now takes effect on the very next step, instead of being frozen at the value from when the goal started — so bumping it from 25 to 1000 when autopilot pauses at "step limit" actually lets it keep going.

## Test coverage

- **27 suites** across the bundled extensions, all green.
- The MCP core is pure, testable modules by design: config merge + tool-name namespacing + the approval policy (`mcpConfig`), the launch fingerprint and trust logic, and the `/mcp` + manage-servers row builders are all unit-tested **without spawning a process or opening the editor** — in the same two-corpus style the command-danger classifier uses, where the test banner states the load-bearing direction.
- The webview timeline changes are pinned by the chat UI's static-CSS-invariant suite (`webviewCss`) — e.g. the rail's connector offset can't silently drift from the row gap, and the one-row MCP fold stays wired end to end (`agent.js` → approval chip → run-node).

**Full changelog:** https://github.com/levelcodeai/levelcode/compare/v1.0.3...v1.0.4
