# LevelCode v0.9.1

Two big things this release: the agent gains **external tools via MCP**, and it learns to **narrate its work** instead of scrolling a wall of chips.

## Highlights

### The agent can use external tools — MCP support

LevelCode's agent now speaks the **Model Context Protocol**, so it can use tools from external MCP servers — a filesystem server, GitHub, Postgres, an internal company server — right alongside its own built-in tools. There's no glue code: an MCP tool becomes an agent tool directly.

Add a server in your **user settings** and its tools show up in the agent, namespaced `server__tool`:

```json
"levelcode.ai.mcp.servers": {
  "filesystem": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path"] }
}
```

Security is the feature here, not a footnote — an MCP server is a process LevelCode spawns with your privileges:

- **User-authored only.** These live in your *user* settings; a repo's committed `.vscode/settings.json` can't add a server, so opening an untrusted project can never make LevelCode spawn a process. A repo's own `.levelcode/mcp.json` is read and listed but **never started** on its own.
- **Nothing runs unless you allow it.** Every MCP tool call is gated by default — including under Autopilot. A tool runs only once you allow-list it in `levelcode.ai.mcp.toolPolicy`, and a server's own "destructive" hint can only ever *tighten* that, never loosen it.

This is the **first slice**: servers are configured in settings and tools are enabled through the allow-list. A per-call approval card and a one-click "Add MCP Server…" are what come next.

### A calmer, narrated transcript

An agent run now reads like a colleague narrating their work rather than a flat scroll of chips and cards.

- **Short prose between actions.** The agent says what it's about to do, then interprets what it found — in the same turn, so it never stops to chatter instead of working.
- **Activity folds into one card.** Consecutive actions collapse into a single expandable group: while it runs, the header shows the *live* step; when it finishes, a past-tense summary takes its place — "Read and edited `PLAN.md` +56 −0, ran 2 commands."
- **Failures read as findings.** A hiccup shows up as a one-line `Correction:` and a next step, not an alarm.
- **Plain-language command labels.** A `run_command` shows what it *does* ("Run the extension unit tests"); the raw command stays tucked behind the card.
- **One question at a time.** `ask_user` now asks a single question per prompt.

### Smaller things
- **`Shift+Cmd+I` now focuses the chat** — previously only `Ctrl+Cmd+I` did.
- A single circle-check glyph wherever a "done" check appears, and an HTML5 shield icon for `.html` files.

## Under the hood

- **MCP is three small, dependency-free modules** — no SDK, in keeping with the plain-JS extension style. `mcpProtocol.js` (JSON-RPC 2.0 framing + typed-content flattening, pure), `mcpConfig.js` (server config, tool-name namespacing, and the approval policy — pure), and `mcpClient.js` (the stdio subprocess: spawned detached and group-killed on New Chat and reload, with a per-call timeout and an output cap so one server can neither hang the agent nor flood its context). The full plan and threat model are in `docs/MCP.md`.
- **The calm transcript ships as two halves** — the *voice* lives in the agent's system prompt (`agent.js`), the *grouping* in the chat webview (`chat.html`). Scope and design are in `docs/CALM-TRANSCRIPT.md`.

## Test coverage

- **56 MCP unit tests**, all off-editor (no process, no network): `mcpConfig.test.js` (41 — tool names stay provider-legal across a hostile corpus, a repo's config can never shadow or auto-start a server, untrusted keys are dropped before they can reach a prototype, and the allow-list never defaults to "allow") and `mcpProtocol.test.js` (15 — JSON-RPC framing with partial-line buffering, and base64 image/audio payloads never reaching the stored transcript).
- The CI gate runs **every** bundled extension's suite on each release.

**Full changelog:** https://github.com/levelcodeai/levelcode/compare/v0.9.0...v0.9.1
