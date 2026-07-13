#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  LevelCode — content-based de-branding of the Code-OSS source (`vscode/src`).
 *
 *  WHY THIS EXISTS (vs. patches/levelcode-core.patch):
 *  The core patch is a line-anchored `git diff` — brittle across Code-OSS tag bumps (a moved or
 *  refactored line can make a hunk fail to apply). That's fine for the handful of STRUCTURAL /
 *  behavioural edits (kill onboarding, redirect release notes, unregister actions, suppress
 *  walkthroughs) — few, small, anchored to stable code. But the ~30 user-visible STRING rebrands
 *  ("VS Code" -> "LevelCode") were the fragile part: many tiny hunks scattered across files that
 *  churn between versions. This script does those as CONTENT replacements instead — it matches on
 *  the string, not its position, so it survives line movement and is a harmless no-op if upstream
 *  removes a target. Mirrors scripts/strip-proprietary.mjs: idempotent, loud, and it WARNS (never
 *  fails) so drift surfaces instead of hiding.
 *
 *  ORDER: run AFTER bootstrap applies the core patch (bootstrap.sh), on the same `vscode/` clone.
 *  Only USER-VISIBLE display strings live here; anything structural stays in the patch.
 *
 *  Usage:  node scripts/de-brand.mjs [vscodeDir]     (defaults to ./vscode)
 *--------------------------------------------------------------------------------------------*/
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const vscodeDir = process.argv[2] || join(repoRoot, "vscode");

// Generic whole-file rebrand: used only where EVERY "VS Code"/"Visual Studio Code" in the file is a
// display string (settings descriptions, notifications) — verified by diff review.
const G = [["Visual Studio Code", "LevelCode"], ["VS Code", "LevelCode"]];

// Each rule: { f: <path under vscode/>, subs: [[from, to], ...] }. `subs === G` is a whole-file sweep;
// otherwise it's a TARGETED rule (explicit strings) — used for files that contain a "VS Code" which must
// STAY (e.g. a real external-VS-Code reference) or where precision matters. Targeted misses warn.
const RULES = [
  // ---- settings-description / notification strings (whole-file safe) ----
  { f: "src/vs/workbench/contrib/terminal/common/terminalConfiguration.ts", subs: G },
  { f: "src/vs/workbench/contrib/terminal/browser/terminalView.ts", subs: G },
  { f: "src/vs/workbench/services/extensions/common/extensionsRegistry.ts", subs: G },
  { f: "src/vs/workbench/contrib/welcomeGettingStarted/browser/gettingStartedExtensionPoint.ts", subs: G },
  { f: "src/vs/workbench/contrib/extensions/browser/extensions.contribution.ts", subs: G },
  { f: "src/vs/workbench/contrib/extensions/browser/extensionsActions.ts", subs: G },
  { f: "src/vs/workbench/contrib/extensions/browser/extensionsWorkbenchService.ts", subs: G },
  { f: "src/vs/workbench/contrib/tasks/common/taskDefinitionRegistry.ts", subs: G },
  { f: "src/vs/workbench/contrib/tasks/common/jsonSchemaCommon.ts", subs: G },
  { f: "src/vs/workbench/contrib/tasks/common/jsonSchema_v2.ts", subs: G },
  { f: "src/vs/workbench/contrib/tasks/browser/abstractTaskService.ts", subs: G },
  { f: "src/vs/workbench/contrib/tasks/electron-browser/taskService.ts", subs: G },
  { f: "src/vs/workbench/contrib/chat/browser/widget/input/chatModelPicker.ts", subs: G },

  // ---- targeted (a "VS Code" must stay, or precise edits) ----
  { f: "src/vs/workbench/contrib/issue/browser/baseIssueReporterService.ts", subs: [
    ['"Visual Studio Code"', '"LevelCode"'],
    ['"A VS Code extension"', '"A LevelCode extension"'],
  ] },
  { f: "src/vs/sessions/electron-browser/actions/vscodeActions.ts", subs: [
    ["Open VS Code Window", "Open LevelCode Window"],
  ] },
  { f: "src/vs/sessions/browser/widget/openInVSCodeWidget.ts", subs: [
    ["Open in VS Code Editor Window", "Open in LevelCode Editor Window"],
  ] },
  { f: "src/vs/sessions/contrib/providers/remoteAgentHost/browser/remoteAgentHost.contribution.ts", subs: [
    ["managed by VS Code", "managed by LevelCode"],
  ] },
  { f: "src/vs/sessions/contrib/providers/localChatSessions/browser/localChatSessions.contribution.ts", subs: [
    ["Local VS Code chat sessions", "Local LevelCode chat sessions"],
  ] },
  { f: "src/vs/sessions/contrib/policyBlocked/browser/sessionsPolicyBlocked.ts", subs: [
    ['"Open VS Code"', '"Open LevelCode"'],
  ] },

  // ---- WS-D pairing: the Agents "Open in VS Code" button OPENS real VS Code, so it must show the VS
  //      Code shield — not code-icon.svg, which LevelCode overwrites with its own mark. (KEEP note:
  //      sessions/contrib/applyCommitsToParentRepo/.../applyChangesToParentRepo.ts "Open in VS Code" is a
  //      genuine external hand-off via the vscode:// scheme and is deliberately NOT listed here.) ----
  { f: "src/vs/sessions/browser/media/openInVSCode.css", subs: [
    ["url('../../../workbench/browser/media/code-icon.svg')", "url('./vscode-icon.svg')"],
  ] },
];

let files = 0, total = 0, warnings = 0;
for (const { f, subs } of RULES) {
  const p = join(vscodeDir, f);
  if (!existsSync(p)) {
    console.warn(`[de-brand] WARN missing file (upstream moved it?): ${f}`);
    warnings++;
    continue;
  }
  const generic = subs === G;
  let text = readFileSync(p, "utf8");
  const before = text;
  let n = 0;
  for (const [from, to] of subs) {
    const parts = text.split(from);
    const hits = parts.length - 1;
    if (hits > 0) { text = parts.join(to); n += hits; }
    else if (!generic && !text.includes(to)) {
      // `from` is gone AND the replacement isn't present either → the string genuinely changed upstream.
      // (If `to` IS present, it was already applied — stay silent so re-runs are clean/idempotent.)
      console.warn(`[de-brand] WARN target not found in ${f}: ${JSON.stringify(from)} (upstream changed it?)`);
      warnings++;
    }
  }
  if (text !== before) {
    writeFileSync(p, text, "utf8");
    files++; total += n;
    console.log(`[de-brand] ${f}: ${n} replacement(s)`);
  }
  // A lingering "Visual Studio Code" (the unambiguous product name) after processing almost always means
  // a NEW upstream string we should add a rule for — surface it (non-fatal).
  if (text.includes("Visual Studio Code")) {
    console.warn(`[de-brand] WARN residual "Visual Studio Code" in ${f} — add a rule?`);
    warnings++;
  }
}
console.log(`[de-brand] done — ${total} replacement(s) across ${files} file(s), ${warnings} warning(s).`);
