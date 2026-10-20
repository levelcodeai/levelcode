<!--
  Started early (2026-10-19), while v1.4.0 was the last release; v1.4.0's notes are its GitHub release body.
  TODO before tagging: set the version in the title and the changelog link, write the intro, add the rest of the
  cycle. `node scripts/draft-release-notes.mjs X.Y.Z --write` REPLACES this file: run it without --write and merge.
  TODO before tagging: levelcode-updater's `levelcode.update.url` / `enabled` / `intervalHours` and the customization
  pack's `levelcode.init.enabled` can still be set by a folder (same finding, left for its own change). Fix them first,
  or decide what to say here.
-->
# LevelCode vX.Y.Z

<!-- TODO intro: what does this release give someone? -->

## Highlights

### A project's settings no longer change what the agent may do

Until now, a folder's `.vscode/settings.json` could set any LevelCode AI setting, and its value won over yours. A repository you cloned could switch the agent to **Autopilot**, send the chat and your API key to a server of its choosing, or set a verify command that ran after the agent's next edit without asking. Restricted Mode did not stop any of it. We reproduced each of these in the editor, in a trusted folder and in Restricted Mode.

Now only your own user settings count, except for eleven display and context preferences a project may still set:

`levelcode.ai.includeActiveFile`, `levelcode.ai.diagrams.enabled`, and `levelcode.ai.chat.` `autoContext`, `autoContextMaxFiles`, `scopeToActiveProject`, `workspaceMap`, `startLocation`, `fontSize`, `maxImagesPerMessage`, `proseWidth`, `groupActivity`.

These are the same eleven the browser edition allows.

- **If you set one of the others in a project on purpose, it no longer applies there.** For example, a per-project `levelcode.ai.verify.command`, `levelcode.ai.provider`, `levelcode.ai.baseURL` or `levelcode.cloud.endpoint`. Move it to your user settings. In the project's `settings.json` the editor shows the ignored value faded, with a note saying why.
- **They are now shared by all your profiles.** VS Code keeps settings like these in the Default profile. A value written in another profile's `settings.json` is ignored, and changing one from another profile writes it to the Default profile for you.
- **Nothing changes if you only ever set them in your user settings**, which is where the Settings editor and the chat's own menus put them.

### The agent shows its plan, and you can keep typing while it works

**Enter no longer stops the agent.** Until now, pressing Enter while the agent was working stopped the run. Now what you type waits just above the message box and is sent as your next message when the run finishes. To stop a run, use ■ with the message box empty.

- **A task list under the latest message.** When a job has more than one step, the agent keeps a short task list as the last thing in the conversation. The step it is on spins (it stops spinning while the agent waits for you to approve something), finished steps turn grey, and a long list shows the steps around the current one with "earlier steps" and "more to go" counts. The list goes away when the run ends. It replaces the "Plan 2/5" bar above Keep all / Undo all.
- **A clear hand-back.** When a run ends with a decision for you, the agent asks one question with one or two answers to click ("Run the tests now?"). Clicking an answer sends it as your next message. Before that box appears, the files the agent changed are checked (the editor's diagnostics, and your verify command if you set one); if the check fails, the agent fixes the problems first.
- **Messages that wait their turn.** One waiting message shows as a single row; several fold into "3 messages queued · Next: …". **Send now** hands a message to the agent at its next step without stopping the run. You can also edit a waiting message in the message box, reorder several, or remove them. If a run is stopped or fails, anything still waiting comes back into the message box instead of being sent.

## Not in this release

<!-- TODO -->
- **Send now is for text.** A waiting message with an image is sent when the run ends, not mid-run. And a message sent with Send now is read after the step the agent is on: it does not interrupt a command that is already running, and it does not hold back the agent's next edit while it waits.

## Test coverage

<!-- TODO measure with scripts/draft-release-notes.mjs (counted cases only). -->
- `settingsScope` (4 cases): every LevelCode AI setting is user-only unless it is on the list above; every scope is one the editor knows, because it reads a misspelt one as a setting a folder can set; and the desktop and the browser edition allow the same list.
- `turnPlan` (20 cases), `agentPlanProgress` (11) and `planProgressUi` (24): how the task list and the hand-back are read and moved; the agent loop ending on a hand-back with a question without another model call, checking its edits there, and delivering Send now at the next step (or handing it back when the run stops); and the chat page's list, box and queue, down to Enter queueing instead of stopping.
- `scripts/plan-progress-editor-check.js` runs a scripted agent in the real editor (17 checks, light and dark), and `web/test/e2e-plan-progress.mjs` does the same in the browser edition (9 checks). Neither is part of the gate.
- `scripts/folder-settings-editor-check.js` opens the real editor on a project that tries all of the above and checks that none of it takes effect. It is not part of the gate.

**Full changelog:** https://github.com/levelcodeai/levelcode/compare/v1.4.0...vX.Y.Z
