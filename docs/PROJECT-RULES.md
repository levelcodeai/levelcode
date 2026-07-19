# LevelCode — Project Rules (`AGENTS.md`)

Drop an **`AGENTS.md`** in your repository and the LevelCode agent reads it and follows your
project's conventions from the first turn — no per-message reminders, no configuration. It's the
cross-vendor rules-file standard (agentsmd.org), and LevelCode also accepts a couple of common
aliases so an existing repo works without a rename.

## Using it

Create a Markdown file at your workspace root and write whatever the agent should always know:

```markdown
# Project rules

- Use 2-space indent; run `npm test` before finishing.
- Prefer `edit_file` over rewriting whole files.
- Never touch `src/generated/**` — it's built from `schema/`.
- Commit style: conventional commits, imperative mood.
```

That's it. The next time you give the agent a goal, those rules are part of its instructions. Edit
the file and the change is picked up on your **next** run.

### Which files, and precedence

The agent looks in each workspace-folder root for the first of these that exists:

| Order | File | Why it's accepted |
|------:|------|-------------------|
| 1 | `AGENTS.md` | The emerging cross-vendor standard — **use this**. |
| 2 | `CLAUDE.md` | So a Claude Code repo works as-is. |
| 3 | `.cursorrules` | So a Cursor repo works as-is. |

**First present file per folder wins** — if you have both `AGENTS.md` and `.cursorrules`, only
`AGENTS.md` is used. Empty or whitespace-only files are ignored.

### Multi-root workspaces

Every workspace folder is checked, and each folder's rules are labelled by folder name
(`app/AGENTS.md`, `api/AGENTS.md`), so folder-specific conventions stay attributable. In a
single-folder workspace the label is just the filename.

### Seeing that it's active

When rules are loaded, a quiet line appears at the top of the run's activity timeline:

> 📋 project rules · AGENTS.md

(Multi-root shows every source, e.g. `📋 project rules · app/AGENTS.md, api/AGENTS.md`.) If you
don't see it, no rules file was found in any workspace folder.

## How it works

- **Loaded once per run.** `runAgent` (`extensions/levelcode-ai/agent.js`) calls
  `loadProjectRules()` when it builds the system prompt, and folds the result into the **system
  block** — after the base prompt, the multi-root note, and the autopilot note. Because it's read
  once and lives in the system block, it is **byte-stable across every turn of a run**, so it rides
  the prompt cache (billed at ~0.1× on reads) instead of being re-sent at full price each turn. A
  fresh run re-reads the file, so edits take effect on the next goal.
- **Bounded.** Each rules file is capped at **16,000 characters** (`PER_FILE_CAP`) and truncated
  with a marker past that — it rides the cached prefix on every turn, so it can't be allowed to
  balloon the request.
- **How it reaches the model.** The content is appended under a short preamble:
  *"PROJECT RULES — the user maintains these in their repository. Treat them as part of your
  instructions and follow them, unless they conflict with a direct request in this conversation."*

### Trust and safety

Rules are **the repository author's text, injected into the prompt by design** — the same trust
model as Cursor and Copilot rules files. Two things bound the risk:

- **They yield to you.** The preamble tells the agent that a direct request in the conversation
  overrides the rules file.
- **They can't disable the safety gates.** The autopilot **danger set** (deletion, `sudo`,
  force-push, discarding uncommitted work, remote-piped shells, publishing, system writes) and the
  command-approval prompts are enforced **host-side** in `commandSafety.js` / the extension — they
  are not driven by the prompt, so an `AGENTS.md` cannot turn them off. Still, only add rules from
  repositories you trust, as you would any project config.

### Code map

| File | Role |
|------|------|
| `extensions/levelcode-ai/projectRules.js` | Pure loader: `loadProjectRules(folders, readFile)` → `{ text, sources }`. File reading is injected as a callback, so it's testable without a filesystem. |
| `extensions/levelcode-ai/agent.js` | Reads with `fs`, folds `rules.text` into the system prompt, posts the timeline chip, and `dbg('projectRules.loaded', …)`. |
| `extensions/levelcode-ai/test/projectRules.test.js` | 10 unit cases (discovery, alias fallback, first-present-wins, multi-root, empty-skip, truncation, throwing reader) plus a real-filesystem smoke test. |

## Not yet (planned)

- **Nested `AGENTS.md`.** The standard allows per-directory files (closest wins for work in that
  subtree). This slice reads **folder-root** files only.
- **An on/off setting.** Rules are opt-in by file presence today; a
  `levelcode.ai.projectRules.enabled` toggle would let a user suppress a repo's rules.
