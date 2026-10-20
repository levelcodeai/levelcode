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

## Not in this release

<!-- TODO -->

## Test coverage

<!-- TODO measure with scripts/draft-release-notes.mjs (counted cases only). -->
- `settingsScope` (4 cases): every LevelCode AI setting is user-only unless it is on the list above; every scope is one the editor knows, because it reads a misspelt one as a setting a folder can set; and the desktop and the browser edition allow the same list.
- `scripts/folder-settings-editor-check.js` opens the real editor on a project that tries all of the above and checks that none of it takes effect. It is not part of the gate.

**Full changelog:** https://github.com/levelcodeai/levelcode/compare/v1.4.0...vX.Y.Z
