# Atom++ — AI

Native, Claude-first AI for Atom++. The chat lives in its own activity-bar panel and talks
**directly** to the provider — there is no Atom++ server in between.

**Providers**

- **Claude** (Anthropic) — bring your own API key (`console.anthropic.com`). The key is stored in
  VS Code SecretStorage (your OS keychain), never written to settings.
- **Ollama** — local models, no key. Point `atompp.ai.ollama.url` at your server and set
  `atompp.ai.ollama.model` to a model you've pulled.

**Use**

1. Click the **Atom++ AI** icon in the activity bar.
2. First send prompts for your Anthropic key (or use the 🔑 button / `Atom++: AI: Set Anthropic API Key`).
3. Type and press Enter. Responses stream in; **Stop** cancels.
4. Select code in the editor → **Add selection** (or `⌥⌘A`) to send it as context.

**Settings:** `atompp.ai.provider`, `atompp.ai.claude.model`, `atompp.ai.claude.maxTokens`,
`atompp.ai.ollama.url`, `atompp.ai.ollama.model`.

**Edit with inline review:** select code → `⌥⌘E` (or right-click → *AI: Edit Selection…*) → describe the change. The model rewrites it and the result appears **inline in the editor** with changed lines highlighted green and a CodeLens above each change offering **✓ Keep / ✗ Undo** (plus **Keep All / Undo All** at the top). Keep accepts a change; Undo restores the original for that hunk. Nothing is final until you Keep.

Coming next in M2: inline tab-completion, and codebase-wide context.
