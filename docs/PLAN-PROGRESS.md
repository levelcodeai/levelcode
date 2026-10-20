# Plan and progress in the agent chat

How the agent shows its plan while it works, how a run hands back, and what happens to a message you
send while it is busy. Modelled on the Code tab of the Claude desktop app, which the owner asked us to
match ("I really love how Claude desktop is rendering the plan and tasks and queue of the work").

This note has three parts: what Claude does (read from the shipped app, with the evidence to check it
again), what LevelCode does, and which differences are on purpose.

## 1. What Claude does

Read on 2026-10-19 from Claude 2.42304.2 (`/Applications/Claude.app`). Nothing was copied: the
behaviour and the look are reimplemented below in LevelCode's own code and words.

### Where it lives

The desktop app is an Electron shell around claude.ai. Its `app.asar` holds the **tool schemas and the
host's plan state**; the **components that draw the plan, the next-step box and the queue** are part of
the claude.ai web bundle, which the app downloads at run time. They were read from the app's own HTTP
cache (`~/Library/Application Support/Claude/Cache/Cache_Data`, the bundle cached at 20:23 UTC that day).

| What | Where | sha256 |
| --- | --- | --- |
| The app | `Contents/Resources/app.asar` | `f0a063c8c2c7fb21eb51bca00f086e5b7355d7208e3d9f28600ea79961830907` |
| `update_plan` / `wrap_up` schemas, descriptions, the host's step arithmetic and replies | `app.asar:/.vite/build/index.chunk-B8PX1nMp.js` (the `ccd_turn` MCP server) | `c32451d17b2d4e8392c7921f750e2b72587a3fdb2373f7e79ea0fb6781b4a2ea` |
| Parsing a plan / wrap-up from the transcript, the same step arithmetic in the page | `…/assets/v1/cb27dab29-QZ5yQ8Vk.js` | `7e861c878f205e1bcfd69718dff20eecdb03e6deadc0618ffaca61fbac449f2d` |
| Deriving the turn's state (plan, plan before wrap-up, stale, settled) | `…/assets/v1/cc8868388-HuTgCGZg.js` | `6f2e05af57882d7481abd81aa94cd2d4724dfa3411737843d14c456fe45e19f3` |
| The turn box (task list + next-step box) | `…/assets/v1/cccc2cf0a-DgImlUHB.js` | `cf4c01a825117eab0cd55f5eb250272458e7b91c457d342d29e4bdb7f40c0a46` |
| The step list and its status icons | `…/assets/v1/cb6930dae-CGtVbuxy.js` | `41992d1f5690b46639e486ab42923eec8b84887b76836994c4356a97acb085bf` |
| The long-list window | `…/assets/v1/c26f8455e-GCVxaQcT.js` | `4f0ac8bd4e4a3fa22ec6cd07432d441337bb1fe3aab86ed8af26aff723864cdd` |
| The queued-messages band | `…/assets/v1/c81c42cdb-DeYTkBpl.js` | `8a7a95b0201e3d59dcb590023b9ec46add8e4790b6f94e3137df983b71bad65c` |
| Hiding the two tools from the transcript | `…/assets/v1/c06cf64bb-BYFl_HkI.js` | `985598ae1d555f6a1794fdf9e43c40f83a94537bf9a8d1074530dd53e5dca191` |
| Animations and tokens | `…/assets/v1/c6a992d55-BGPwQXHG.css` | `6dcdf6e00e5592118918b0c990b27f29f17d206cc1574a9e07e6f955898a6252` |

`…` is `https://assets-proxy.anthropic.com/claude-ai/v2`. The web bundle changes with every claude.ai
deploy, so these hashes pin what was read, not what the app shows tomorrow.

### The task list

- **The model's tool.** `update_plan` takes the whole list (`items`: 1–12 steps, each `content` and a
  `status` of `pending`, `in_progress` or `completed`) or a small update: `advance: true` completes the
  step in progress and starts the next pending one; `done: [n]` and `start: n` name steps by number,
  counted from 1. The host keeps only each step's **status**, by number, so an update never resends the
  words. Its reply says where the list stands ("step 3 of 7 is in progress"), warns when more than one
  step is in progress, and refuses a step number that does not exist — naming how many steps there are.
  Step text is cut at 160 characters; a 13th step is dropped. The model is told to send the list with
  its first tool call and each update *with* the call that starts the step, never as a message of its
  own, and not to also write the plan out as prose.
- **Where it shows.** In a card pinned under the latest message — the last thing in the transcript, not
  a bar above the composer. The card fades in (0.3 s). The tool calls themselves never appear in the
  transcript.
- **A step.** A 16 px icon column and the step's text (inline Markdown). Completed: a filled check
  circle, the row in the secondary text colour (no strike-through). In progress: a spinner while the
  agent is working, a still "dots" circle when it is not (waiting on the user). Pending: an empty
  circle in the muted colour. Each icon carries a screen-reader word: done / in progress / not done.
- **Long lists.** At most 12 rows show. The window starts one step above the step in progress (so the
  last finished step stays in view); "N earlier steps" above and "N more to go" below count what is cut.
- **A plan from an earlier message.** While a new request runs and the model has not touched the list
  yet, the old list stays with the caption "Plan from before your last message" — unless every step was
  already done, in which case nothing shows.
- **When the turn ends,** the list goes away. A list whose steps are all done but the last, still in
  progress, is completed when a turn ends cleanly.

### The end of a turn

- **The model's tool.** `wrap_up` takes a `recap` (2–3 sentences, about 300 characters: what is now
  true, and what is not done or not verified), and — only when the next move is the user's — an `ask`
  (one decision, about 100 characters) with 1–2 `actions` (a reply: a 1–3 word `label` and the
  `message` a click sends, or one of the app's own actions). `blocked: true` says the agent cannot go on
  without an answer. Calling it also completes every step of the task list.
- **The next-step box.** Drawn only when there is a question with buttons (or the agent is blocked).
  It rises into place (4 px, 0.3 s) in the same card as the list, which hides while the box has
  something in it. Recap in the secondary colour, the question in the primary colour, then the buttons:
  the first one is the recommendation and is drawn as the primary button. A × dismisses it (and stays
  dismissed). A blocked turn with no question reads "Claude is waiting on you. Pick a reply or type
  your own." A recap alone draws no box: it becomes the session's status line in the sidebar, and the
  model's closing message says the rest.
- **The box ends the turn.** When the box holds a question, the tool result tells the model to write
  nothing more, and the host ends the turn without another model call.
- **Checks on the buttons.** A reply whose label or message starts with `/` or `!`, holds `@`, or holds
  invisible characters is dropped (a click would run a command or hide what it sends); a third button is
  dropped; over-long labels and messages are reported back to the model as advice for next time.

### Messages sent while the agent works

- **They queue.** Enter while the agent works does not stop it: the message waits in a band above the
  composer and **is sent on its own when the agent is ready**. If the run fails or is stopped, queued
  messages are not sent: they go back into the message box, and a note says so.
- **One queued message:** one row — "1 message queued", the text cut to a line, and three icon
  buttons: **Send now** (the agent reads it at its next step, without stopping), **Edit in composer**,
  **Remove from queue**.
- **Several:** a collapsed row — "3 messages queued · Next: …" with a chevron. Open, each row shows two
  lines of its text, a drag handle to reorder, and a menu (Edit in composer, Send now, Remove from
  queue); the list scrolls past about 22 rem and has **Clear all** at the foot.
- The band leaves by sliding 6 px down and fading. Every animation is off under reduced motion.

## 2. What LevelCode had

- `update_plan` took the whole list every time (`todos`: `title` + `pending` / `in_progress` / `done`,
  up to 20) and the model resent it for every change.
- The webview drew a sticky "Plan 2/5" card above the Keep all / Undo all bar, with a progress bar, a
  collapse toggle and ×. It cleared when the next run started and collapsed itself when all done.
- A run ended when the model wrote a line starting with `Done:`. There was no recap or next-step box.
- Enter while the agent worked **stopped the run** (the send button is a stop button while streaming).
  There was no queue, and nothing could reach the agent mid-run.

## 3. What LevelCode does now

### The tools (agent.js)

- `update_plan` takes Claude's shape — `items` (1–12 steps, `content` + `pending` / `in_progress` /
  `completed`), or `advance`, `done`, `start` — and still accepts the old `todos` / `title` / `done`, so
  a conversation started on an older build keeps working. The steps' state lives with the conversation
  (extension.js), so `advance` works across runs and a new chat starts empty.
- `wrap_up` takes `recap`, `ask`, `actions` (replies only: `label` + `message`) and `blocked`.
  **Calling it is the end of the work**, so auto-verify runs there: if the configured verify command or
  the editor's diagnostics find problems in the files the agent changed, the box is not shown and the
  tool result carries the problems instead; the agent fixes them and calls `wrap_up` again. When the box
  holds a question the run ends on the spot, with no further model call.
- The prompt asks for the list with the first tool call and `advance` with the call that starts the
  next step, and for `wrap_up` at the end of every run that kept a list, changed files or ran commands.
  A run that ends with a `Done:` line and no `wrap_up` still ends as before (some models will not call
  it), and the last in-progress step is completed then, as Claude does.

### The chat page (media/chat.html)

- The **turn box** is a card that is always the last thing in the transcript, holding the task list
  while a run works and the next-step box when it ends. Same states as Claude's, in the editor's theme
  colours and LevelCode's own icons.
- The **queue band** sits above the composer. Enter while the agent works queues (the send button reads
  "Queue" once something is typed); ■ with an empty composer still stops. When a run ends normally the
  first queued message is sent; a stopped or failed run puts every queued message back into the message
  box, after anything already typed there. A reply button in the next-step box queues the same way if
  a run is going. A message counts as "busy" from the moment it is sent until its run starts, so the
  queue can never start a second run beside the first.
- **Send now** posts the message to the extension, which hands it to the running agent at its next step:
  after the tool results of the current step (in the same message, so every tool call still has its
  result), or, if the agent had just answered with no tool call, as a new message that keeps the run
  going. It then appears in the transcript as your message, where it landed.

### Where the pieces are

| Piece | File |
| --- | --- |
| What the two tools decide (reading a list, `advance`, replies a click may send) | `extensions/levelcode-ai/turnPlan.js` |
| The tools' schemas and prompt lines; wrap_up in the loop (verify, end the run); delivering Send now | `extensions/levelcode-ai/agent.js` |
| The conversation's list (`agentPlan`), the Send-now inbox, `steer` from the page | `extensions/levelcode-ai/extension.js` |
| The turn box, the queue band, the send button | `extensions/levelcode-ai/media/chat.html` |
| `wrap_up` reserved from MCP tool names | `extensions/levelcode-ai/mcpConfig.js` |

Host → page messages: `plan` {steps}, `wrapUp` {recap, ask, actions, blocked}, `steersDelivered` {ids},
`steersReturned` {ids}. Page → host: `steer` {id, text}.

## 4. Differences on purpose

| Claude | LevelCode | Why |
| --- | --- | --- |
| Window of 12 rows | Window of 8 | The chat is a side panel, usually narrower and shorter than Claude's transcript column. |
| A recap alone is the sidebar status | A recap alone shows nothing (the closing message has it) | LevelCode has no session sidebar status line. |
| App actions as buttons (commit, create PR, fix CI …) | Replies only | LevelCode has no such app actions yet; Keep all / Undo all stay in their bar. |
| A keyboard shortcut presses the recommended button | Buttons are focusable; no shortcut | Enter in the composer must keep meaning "send". |
| Steps can name a side session | Not supported | LevelCode has no side sessions. |
| "N running tasks" under the step in progress | Not shown there | Background commands already have their tray (`#bgTasksBar`). |
| Send now on a message with images | Text only; a queued message with images waits for its turn | Mid-run delivery carries text into a tool-result message. |
| A queued message's menu opens below its button | Below, or above when the window has no room below | The band sits low, over the composer, in a short panel. |
| No closing-line convention | The closing answer still starts with `Done:` unless the box holds the question | The loop has always used it to tell a finished answer from a stall, and a model that never calls `wrap_up` still ends cleanly with it. |

## 5. Decisions

1. **Enter while the agent works queues the message, as in Claude** (owner, 2026-10-19). It waits
   above the composer and sends itself when the run ends; *Send now* hands it to the agent at its next
   step without stopping. This supersedes, for now, the Mid-Run Messaging Spec (2026-10-04), where
   Enter *steers* (delivered at the next step, with write and command calls held until the agent
   re-decides) and ⌘Enter queues. The owner was offered that spec's behaviour, and "this now, the spec
   later", and chose this alone: so the spec's steering by default and its holding of write and command
   calls are not built. *Send now* is the only way a message reaches a run in progress.

## 6. How to check it

- The gate (`./scripts/test-extensions.sh`) runs three suites for this: `test/turnPlan.test.js` (the rules),
  `test/agentPlanProgress.test.js` (the real agent loop on scripted turns) and `test/planProgressUi.test.js`
  (the page's decisions, lifted out of `chat.html`). 23 hand-made mutations of the feature's key lines were
  each caught by one of them.
- In the real editor, with no key: `node extensions/levelcode-ai/scripts/plan-progress-editor-check.js --vscode <checkout with vscode/>`.
  A stand-in model is scripted turn by turn and held at three points, so the page is looked at and typed into
  while the agent "works"; it writes screenshots in LevelCode One Dark and LevelCode One Light.
- In the browser edition: build the extension (`node web/ai-extension/build.mjs --out <dir> --vscode <checkout>`,
  then copy `web/workspace` to `<dir>/levelcode-web`) and run
  `node web/test/e2e-plan-progress.mjs --static <vscode-web> --extensions <dir> --scheme dark` (and `light`).

## 7. Not verified

- No real model has driven it: every run so far used a scripted stand-in. Whether real models call
  `update_plan` with `advance` (rather than resending the list) and `wrap_up` with a sensible question is
  untested — Claude, GPT and the OpenRouter models may differ.
- Only the OpenAI-compatible route ran (a BYOK custom provider). The Anthropic-native route and the
  LevelCode gateway were not exercised end to end. A run that ends on a question leaves the history ending in a tool
  result, and the next message follows it; that shape already occurs after ■, but was not re-checked here.
- Drag-to-reorder was checked from the keyboard (Alt+↑ / Alt+↓) only; dragging with the mouse was not driven.
- Linux and Windows were not run; neither were Safari or Firefox for the browser edition.
