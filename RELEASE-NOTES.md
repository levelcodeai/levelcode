# LevelCode v1.4.1

The agent now shows its plan while it works, and pressing Enter no longer stops it: what you type waits its turn. A new approvals mode, **Ask When Risky**, has a reviewer model check each command against what you asked for before it runs. The agent can keep what you tell it to remember, and **Search Sessions** finds any past conversation. A repository's own settings can no longer loosen what the agent may do. And LevelCode now runs in a browser tab, at **app.levelcode.ai**.

## Highlights

### A project's settings no longer change what the agent may do

Until now, a folder's `.vscode/settings.json` could set any LevelCode AI setting, and its value won over yours. A repository you cloned could switch the agent to **Autopilot**, send the chat and your API key to a server of its choosing, or set a verify command that ran after the agent's next edit without asking. Restricted Mode did not stop any of it. We reproduced each of these in the editor, in a trusted folder and in Restricted Mode.

Now only your own user settings count, except for eleven display and context preferences a project may still set:

`levelcode.ai.includeActiveFile`, `levelcode.ai.diagrams.enabled`, and `levelcode.ai.chat.` `autoContext`, `autoContextMaxFiles`, `scopeToActiveProject`, `workspaceMap`, `startLocation`, `fontSize`, `maxImagesPerMessage`, `proseWidth`, `groupActivity`.

These are the same eleven the browser edition allows. The new settings in this release are user-only too.

- **If you set one of the others in a project on purpose, it no longer applies there.** For example, a per-project `levelcode.ai.verify.command`, `levelcode.ai.provider`, `levelcode.ai.baseURL` or `levelcode.cloud.endpoint`. Move it to your user settings. In the project's `settings.json` the editor shows the ignored value faded, with a note saying why.
- **They are now shared by all your profiles.** VS Code keeps settings like these in the Default profile. A value written in another profile's `settings.json` is ignored, and changing one from another profile writes it to the Default profile for you.
- **Nothing changes if you only ever set them in your user settings**, which is where the Settings editor and the chat's own menus put them.

### The agent shows its plan, and you can keep typing while it works

**Enter no longer stops the agent.** Until now, pressing Enter while the agent was working stopped the run. Now what you type waits just above the message box and is sent as your next message when the run finishes. To stop a run, use ■ with the message box empty.

- **A task list under the latest message.** When a job has more than one step, the agent keeps a short task list as the last thing in the conversation. The step it is on spins (it stops spinning while the agent waits for you to approve something), finished steps turn grey, and a long list shows the steps around the current one with "earlier steps" and "more to go" counts. The list goes away when the run ends. It replaces the "Plan 2/5" bar above Keep all / Undo all.
- **A clear hand-back.** When a run ends with a decision for you, the agent asks one question with one or two answers to click ("Run the tests now?"). Clicking an answer sends it as your next message. Before that box appears, the files the agent changed are checked (the editor's diagnostics, and your verify command if you set one); if the check fails, the agent fixes the problems first.
- **Messages that wait their turn.** One waiting message shows as a single row; several fold into "3 messages queued · Next: …". **Send now** hands a message to the agent at its next step without stopping the run. You can also edit a waiting message in the message box, reorder several, or remove them. If a run is stopped or fails, anything still waiting comes back into the message box instead of being sent.

### Ask When Risky: a reviewer checks each command before it runs

The approvals menu under the message box has a third mode, between **Default Approvals** (asks before every command) and **Autopilot** (runs commands without asking; anything hard to undo still asks).

- **How it decides.** Before a command runs, a reviewer model is shown the command, your requests and the agent's recent activity. It rates how risky the command is and whether you asked for it. LevelCode runs the command only when the risk is low, or medium and clearly part of your task. Anything else shows you the usual approval card, with the reviewer's reason.
- **Some commands always ask.** Deleting files, `sudo`, force-push and the rest of the irreversible set ask you every time, and are never left to the reviewer.
- **Every failure asks.** A review that fails, cannot be read or takes longer than 30 seconds shows you the card. So does a command too long for the reviewer to see whole.
- **Only your own words count as your go-ahead.** What you typed and your answers to the agent's questions do. A diagram retry, Continue, a reply button's prepared text, and anything in a file or a command's output do not.
- **Each review is one model call, for every run of a command,** `npm test` included. With LevelCode Cloud it uses credits, and the run's cost includes it. `levelcode.ai.agent.reviewModel` can name a smaller, faster model from the same provider.
- **Default Approvals stays the default.** Choose the mode from the menu, or set `levelcode.ai.agent.approvals`.

### Memory from you, and Search Sessions

Until now, project memory was only what LevelCode inferred after a session ended. Now the agent also keeps what you tell it to.

- **Ask it to remember something**, correct how it works ("no, use pnpm"), confirm an approach, state a decision or say where something lives, and the agent saves a short note. Notes are listed under **From you** in the Sessions panel's Memory tab, and every new session in the project starts knowing them.
- **A note counts as yours only when it says what you said.** It must quote words you typed in this run, and use only those words, in your order, keeping every "not" and "never". Any other note is kept as unconfirmed and has no effect until you click **Confirm** in the Memory tab. So text in a repository cannot become one of your instructions by quoting you.
- **Ask it to forget something**, and it removes the matching note, but only when your words ask for that and name it. **Forget** in the Memory tab always works.
- **Memory says how old it is.** Each note and fact older than a day carries its age ("9 days old") in what the agent reads, so it knows to check it.
- **Search Sessions…** (in the Command Palette, and the search icon in the Sessions panel's title bar) searches the title and the whole conversation of every session, archived ones included, and reopens the one you pick. Title matches come first. History stays the short list of recent work. Search, listed as missing in these notes since v1.0.5, is here.
- Turn notes off with `levelcode.ai.sessions.memory.notes`.

### A light round the message box while LevelCode works

A thin line of light travels round the message box's border while the agent is thinking, writing, running a command or checking its edits. While it waits on you, for an approval or an answer, the light stops and the border stays dimly lit. With reduced motion the border is lit without moving, and high-contrast themes show no light. Turn it off with `levelcode.ai.chat.workingAura`.

### LevelCode in a browser tab

LevelCode now runs in a browser at **[app.levelcode.ai](https://app.levelcode.ai)**: the same editor, chat and agent, with nothing to install. Sign in with your LevelCode account, or bring your own provider key.

- **Your files:** a scratch workspace saved in the browser, or a folder from your computer (in Chrome and Edge), which the agent edits in place.
- **LevelCode Shell** gives you and the agent a terminal over your files, with the usual commands (`ls`, `cat`, `grep`, `sed`, `find`, `jq` and more). It starts no programs and has no network: no `node`, `npm`, `git` or `python`. What the agent's commands change comes back for review with Keep and Undo.
- **What stays in the Mac app:** running real programs (tests, builds, dev servers), local MCP servers, installing extensions, and the update check.

## New settings

- `levelcode.ai.agent.approvals` (default **Default Approvals**): how the agent's commands are approved: Default Approvals, Ask When Risky or Autopilot. The same choice as the approvals menu under the message box.
- `levelcode.ai.agent.reviewModel` (default **empty**, the agent's own model): the model that reviews commands in Ask When Risky.
- `levelcode.ai.sessions.memory.notes` (default **on**): let the agent remember and forget what you ask it to.
- `levelcode.ai.chat.workingAura` (default **on**): the light round the message box while LevelCode works.

## New commands

- **AI: Search Sessions…**: search every session's title and conversation, and reopen the one you pick.

## Not in this release

**Ask When Risky has been checked only with a scripted reviewer.** No real model has rated commands for it yet, so how often it lets routine commands run, and what it catches, has not been measured. The irreversible set asks you whatever the reviewer says, and Default Approvals stays the default.

**The task list, the hand-back and remembering were tested with scripted models.** Real models may use them differently. A model that never uses the task list or the hand-back ends its runs as before.

**Send now is for text.** A waiting message with an image is sent when the run ends, not mid-run. And a message sent with Send now is read after the step the agent is on: it does not interrupt a command that is already running, and it does not hold back the agent's next edit while it waits.

**There is still no Windows or Linux build.**

## Test coverage

- **137 test files** run in the gate, up from 126 in v1.4.0: the bundled extensions, the signature checker and the browser edition.
- **The bundled extensions' 80 suites hold 1,407 counted cases**, up from 70 suites and 1,252 cases in v1.4.0. Seven suites print `N passing` or `N passed` and are not counted.
- `settingsScope` (4 cases): every LevelCode AI setting is user-only unless it is on the list above; every scope is one the editor knows, because it reads a misspelt one as a setting a folder can set; and the desktop and the browser edition allow the same list.
- `turnPlan` (20 cases), `agentPlanProgress` (13) and `planProgressUi` (26): how the task list and the hand-back are read and moved; the agent loop ending on a hand-back with a question without another model call, checking its edits there, and delivering Send now at the next step (or handing it back when the run stops); and the chat page's list, box and queue, down to Enter queueing instead of stopping.
- `agentReview` (27, uncounted) and `agentReviewGate` (15): the reviewer's rules and every way a review can fail, and the real agent loop running commands in all three modes.
- `memoryNotes` (32), `memoryNotesHost` (14) and `memoryPoisoning` (49): when a note counts as yours and when forget may remove one, each tried against notes that change your order or drop a "not"; the real agent loop with the remember and forget tools; and Search Sessions over a store of 163 sessions.
- `workingAura` (15): when the light turns, stops and is off, and its look.
- Five scripts run each feature in the real editor with a scripted model: the project settings (16 checks), the task list and queue (17), Ask When Risky (12), memory and Search Sessions (11) and the working light (11). None is part of the gate.

**Full changelog:** https://github.com/levelcodeai/levelcode/compare/v1.4.0...v1.4.1
