# LevelCode v1.3.0

When a LevelCode Cloud session ended, v1.2.0 said so with `API 401: Signature has expired` in red — beside an account popover that still claimed you were signed in. This release replaces that with one card and a **Sign in** button, shown before you send anything. Mostly you will not see even the card: the session is renewed ahead of time, a lapsed token is renewed wherever a request is sent rather than only in the chat, and thirty days of sign-in now run from the last time you used the editor. GPT-6 Astra and Claude Fable 5 / 5.1 are sized as the models they are, and the agent's browser preview can open for the first time.

## Highlights

### An ended session is a Sign in button, not a red error

The card is headed **Your session has expired**, greets you by name, and says: *Sign in again to keep using LevelCode Cloud — your chat and files here are untouched.* It has two buttons: **Sign in**, and **Use my own key instead**, which opens the provider-mode setting.

- **It is found before your first message.** The session is checked when the chat opens and every time the window comes back to the front. The check reads the token's own expiry, so a session with hours left costs no request.
- **The popover and the footer stop saying you are signed in** at the same moment. That was the worst part of the old failure: two parts of the same window disagreeing about whether you were signed in.
- **The card stays with the conversation.** New Chat, a resumed session and a checkpoint restore each rewrite the transcript, and each puts the card back while the expiry is unanswered. Signing in, or choosing your own key, takes it away.
- **Inline edit and Agent Sketch say it too.** An ended session reads *Your LevelCode Cloud session has expired. Sign in again to continue.* there — with a **Sign in** button on the inline-edit toast — where v1.2.0 showed the gateway's 401.

**Only the server saying no ends a session.** Being offline, a 5xx or a malformed reply means nothing is known yet: you stay signed in, and the request shows its own error. A renewal that hangs is given ten seconds and then treated the same way. Clearing credentials on a network blip would sign you out for closing your laptop on a train.

If you use LevelCode on your own key with no account, none of this reaches you — no card, no prompt. Gateway mode with no token is what a fresh install is, and it still falls back to your key.

### Thirty days now run from the last time you used it

A cloud sign-in is two credentials: an access token good for 8 hours, and a refresh token good for 30 days that buys the next access token. Through v1.2.0 the editor kept the refresh token it was handed at sign-in for that token's whole life, so the thirty days ran from the day you signed in. Someone who used LevelCode every day was signed out on day thirty all the same.

The cloud now issues a new refresh token with every renewal, and the editor stores it. The thirty days slide: keep using the editor and you do not reach the wall; leave it for a month and you sign in again.

| What | Value |
| --- | --- |
| Access token | 8 hours |
| Sign-in | 30 days, counted from the last renewal |
| Renewed ahead of expiry | when under 5 minutes remain — checked at chat open, and on window focus at most every 10 minutes |
| A renewal that hangs | given up on after 10 seconds — you stay signed in |

### A lapsed token is renewed wherever a request is sent

The chat and the agent already renewed a lapsed access token and sent the request again. Nothing else did. Once the eight hours were up, everything around the chat failed until a chat message happened to renew the token — for a session that was perfectly renewable.

| Where | v1.2.0 | Now |
| --- | --- | --- |
| Inline edit | *LevelCode AI edit failed: … API 401: Signature has expired* | renewed, and the edit asked once more |
| Agent Sketch — Run, the board command, Generate flow | the gateway's 401 on the nodes that ran | renewed; nodes that fail together share one renewal |
| Inline completion | silently nothing, on every pause in typing | renewed quietly |
| Compact and the session-memory summary | failed | renewed |

What it deliberately will not do:

- **Send anything twice.** One retry, and none once part of an answer has arrived — a second send would repeat it.
- **Outlive a Cancel.** Stop, Cancel or the next keystroke ends the wait at once, and a request nobody is waiting for starts no renewal.
- **Cross accounts or hosts.** A request stays with the account and the cloud host it was sent on. Sign in as someone else while it is out — in this window or another — or point the editor at a different host, and it is not sent again on the new credentials.
- **Turn typing into refreshes.** Ghost text is sent on every pause in typing. It may start one renewal a minute, and waits on one that is already out.

### One session, every window

The session is stored once and every window shares it, but a window only heard about the changes it made itself. One left open in the background kept showing "signed in" after another window had signed out.

Each window now compares what is stored with what it is showing whenever it comes to the front, and catches up: the card and a signed-out popover if the session ended elsewhere, the popover alone if you signed out there, and the card taken down if you signed back in there.

### GPT-6 Astra and Claude Fable 5 / 5.1, sized as they are

v1.2.0 had no entry for any of them and fell back to a guess: a 200k-token window for all three, and no images for Astra. In gateway mode that meant the model picker offered Astra while the composer refused your screenshot, and the context meter was sized for a fifth of the real window.

| Model | Context window | Images |
| --- | --- | --- |
| GPT-6 Astra | 1,050,000 tokens | yes |
| Claude Fable 5 and 5.1 | 1,000,000 tokens | yes |

The rows hold under every id the models arrive as: `openai/gpt-6-astra` and `anthropic/claude-fable-5.1` from the gateway and OpenRouter, and Anthropic's own `claude-fable-5-1`.

On LevelCode Cloud, Fable 5 and 5.1 are included from **Pro** and GPT-6 Astra from **Pro+**. They are expensive models, and the pricing page says so in turns rather than leaving you to find out: Pro's 2,000 credits are about 260 turns on Kimi K2.7 and about 20 on Fable 5.1.

### The agent's browser preview opens

When the agent starts a web server in the background and it prints a local address, LevelCode opens it in the built-in browser beside the chat — without taking focus, and once per address, so closing the tab is final. That is what `levelcode.ai.preview.autoOpen` has promised since v0.9.2.

It never happened. A logging call on that path referred to a name that was out of scope, and threw before the browser was asked for. Every release from v0.9.2 to v1.2.0 carries it; this is the first that can open the tab.

**What is proven, and what is not.** A test now runs the real chain — the agent, the tool, the command's output — up to the call that opens the browser. The tab itself appearing in a packaged build is the one step no test covers.

Only local addresses are ever opened: `localhost`, `127.0.0.1` and `[::1]`.

## Also fixed

- **Three icons were printed as words.** Opening the chat in an editor tab showed a banner reading *layout MOVED TO THE EDITOR*; the preview chip and the recall and project-memory chips showed `globe` and `history` as text on ungrouped timeline rows. The glyphs are in, and a test now runs every icon name written down on either side through the real renderer.
- **A sign-in replaces the whole session.** One that arrived without a refresh token kept the previous session's, and the next renewal was made with it: refused, it ended the session you had just started; still valid, it renewed the *previous* account under the new one's name. Latent — the cloud sends a refresh token with every sign-in — and closed.
- **A background command that failed to start** raised an unhandled rejection instead of being logged. Same out-of-scope name as the preview.

## Not in this release

**The Sessions panel still does not search.** It was the stated gap in v1.0.5, in v1.1.0 and in v1.2.0, and it is the stated gap again. This cycle went to sign-in.

**A session with no refresh token cannot be renewed, and is not ended either.** When its access token lapses, the request still shows the gateway's 401. The cloud issues a refresh token with every sign-in, so reaching this takes a sign-in that arrives without one — but it is the one path left where that error can appear.

**Nothing renews the token in a window that simply stays in front.** The check runs when the chat opens and when the window regains focus. A window you never leave finds a lapsed token on its next request, which is renewed and sent again — a moment's delay rather than an error, but not the same as never lapsing.

**"Use my own key instead" is only on the chat's card.** The inline-edit toast offers **Sign in** alone, and Agent Sketch shows the sentence with no button at all.

## Test coverage

- **48 suites**, **854 cases** across the bundled extensions — all green. v1.2.0 measured the same way was 40 suites and 599 cases.
- `test/sessionExpiredHost.test.js` (70 cases) — the host's own functions, sliced out of `extension.js` and run against stores that answer a turn late: the expiry found at open and on focus, late answers that must not touch a newer session, a sign-out in the middle of a request, and what other windows do to the store.
- `test/authRetryCallers.test.js` (76 cases) — the real inline edit, Agent Sketch and completion modules, driven as the editor drives them against a gateway that answers 401 to a lapsed token.
- `test/authRetry.test.js` (45 cases) — the renew-and-retry rules on their own: one retry, one renewal at a time, and a request that stays with its account and host.
- `test/session.test.js` (19 cases), `test/sessionExpiredUi.test.js` (17) and `test/sessionExpiredCallers.test.js` (16) — the token arithmetic, the card's routing in the webview, and what inline edit and Agent Sketch say.
- `test/chatIcons.test.js` (6 cases) and `test/agentRunCommand.test.js` (4) — the icon guard, and the preview chain.

**The suites now run on every pull request.** Until this release they ran in CI at one moment only — when a tag was pushed — so a new suite's first run on Linux was the release gate, after the merge. The first v1.3.0 tag failed its gate that way: a new test counted turns of the event loop across a real timer, which holds on a Mac and not on the runner. The test waits by the clock now, and the gate is one script, `scripts/test-extensions.sh`, shared by the release workflow and a pull-request check.

**Full changelog:** https://github.com/levelcodeai/levelcode/compare/v1.2.0...v1.3.0
