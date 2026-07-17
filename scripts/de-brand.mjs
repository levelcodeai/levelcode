#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  LevelCode — content-based de-branding of the Code-OSS source (`vscode/src` + bundled extensions).
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
 *  TWO passes:
 *    (1) RULES     — curated per-file "VS Code"/"Visual Studio Code" -> "LevelCode" name swaps
 *                    (+ a few targeted rewords). Curated because a blanket name swap could clobber a
 *                    genuine external-VS-Code reference (e.g. the "Open in VS Code" hand-off) or a
 *                    `vscode://` scheme; each file here was diff-reviewed.
 *    (2) MS-LINKS  — a GLOBAL, provably-safe sweep that strips clickable Microsoft doc links
 *                    `[text](https://code.visualstudio.com/…)` and `[text](https://aka.ms/…)` down to
 *                    just `text`, across all of src (minus tests/.d.ts/vendored agentHost) and every
 *                    bundled extension's package.nls.json. Safe to run globally because the pattern only
 *                    ever matches a Microsoft documentation link — never a LevelCode keep — so it can
 *                    only ever remove an MS URL, never touch anything else. Kills the settings-UI
 *                    "learn more" links (files.autoSave, terminal, search, git SCM welcome, …) that the
 *                    name swap alone left clickable.
 *
 *  ORDER: run AFTER bootstrap applies the core patch (bootstrap.sh), on the same `vscode/` clone.
 *  Only USER-VISIBLE display strings / links live here; anything structural stays in the patch.
 *
 *  Usage:  node scripts/de-brand.mjs [vscodeDir]     (defaults to ./vscode)
 *--------------------------------------------------------------------------------------------*/
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const vscodeDir = process.argv[2] || join(repoRoot, "vscode");

// Generic whole-file rebrand: used only where EVERY "VS Code"/"Visual Studio Code" in the file is a
// display string (settings descriptions, notifications) — verified by diff review.
const G = [["Visual Studio Code", "LevelCode"], ["VS Code", "LevelCode"]];

// The LevelCode double-chevron mark (branding/icons/code-icon.svg) as a FILLED silhouette in the
// aquarium symbol's `0 0 96 96` viewBox, spanning the sliced body region (x 5..90, see fish.ts
// BODY_X_START/END). Two overlapping subpaths — they union only under fill-rule:nonzero (the rule
// below flips it; evenodd would knock the overlap out as a hole). Filled, not stroked: each fish is
// rendered as clipped vertical slices, and a thin stroke would shred into disconnected segments.
const LEVELCODE_FISH_CHEVRON =
  "M6 47L48 12L90 47L78 57L48 32L18 57ZM6 79L48 44L90 79L78 89L48 64L18 89Z";

// Each rule: { f: <path under vscode/>, subs: [[from, to], ...], extra?: [[from, to], ...] }.
// `subs === G` is a whole-file name sweep; otherwise it's a TARGETED rule (explicit strings) — used for
// files that contain a "VS Code" which must STAY (e.g. a real external-VS-Code reference) or where
// precision matters. `extra` runs additional targeted swaps AFTER `subs` (e.g. a reword alongside a G
// sweep). Targeted misses warn.
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

  // ---- update settings (M1): "new VS Code versions" via G, plus a reword of the "Microsoft online
  //      service" phrasing (updates come from levelcode.ai, not Microsoft). ----
  { f: "src/vs/platform/update/common/update.config.contribution.ts", subs: G, extra: [
    ["a Microsoft online service", "an online service"],
  ] },

  // ---- bundled-extension package.nls.json (M3 + L1): Extensions-view description/displayName +
  //      setting descriptions + the git SCM-welcome messages. All are "this editor's own feature"
  //      references (no external-VS-Code hand-off), so a whole-file name swap is safe. Translator
  //      `comment` hints ("…command syntax for VS Code") get swapped too — invisible metadata, never
  //      shipped to users, harmless. Copilot's nls is intentionally NOT here: it isn't bundled
  //      (build/lib/extensions.ts drops it), so rebranding it would be dead work. ----
  { f: "extensions/git/package.nls.json", subs: G },
  { f: "extensions/css-language-features/package.nls.json", subs: G },
  { f: "extensions/html-language-features/package.nls.json", subs: G },
  { f: "extensions/json-language-features/package.nls.json", subs: G },
  { f: "extensions/markdown-language-features/package.nls.json", subs: G },
  { f: "extensions/typescript-language-features/package.nls.json", subs: G },
  { f: "extensions/emmet/package.nls.json", subs: G },
  { f: "extensions/github/package.nls.json", subs: G },
  { f: "extensions/grunt/package.nls.json", subs: G },
  { f: "extensions/jake/package.nls.json", subs: G },
  { f: "extensions/npm/package.nls.json", subs: G },
  { f: "extensions/media-preview/package.nls.json", subs: G },
  { f: "extensions/mermaid-markdown-features/package.nls.json", subs: G },
  { f: "extensions/terminal-suggest/package.nls.json", subs: G },

  // ---- targeted URL removal the global sweep can't see: a doc link assembled from SPLIT localize args
  //      ({2}='[', {3}='](url)') so it's never contiguous in source. Blank both → plain text, no link. ----
  { f: "src/vs/platform/terminal/common/terminalPlatformConfiguration.ts", subs: [
    ["'[',\n\t\t'](https://code.visualstudio.com/docs/terminal/profiles)'", "'',\n\t\t''"],
  ] },

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

  // ---- Agents-window "aquarium" easter egg: the fish were literally the VS Code logo silhouette,
  //      tinted with VS Code's three RELEASE-CHANNEL colors, swimming across our UI. Keep the joy,
  //      make it ours — our double-chevron in the brand-gradient stops. Pure content swaps, no patch.
  //      The path `from` is a REGEX so an upstream tweak to the silhouette can't silently leave
  //      Microsoft's logo in place; it still re-matches (and the file/const names are upstream's). ----
  { f: "src/vs/sessions/contrib/aquarium/browser/vscodeLogoPath.ts", subs: [
    [/export const VSCODE_LOGO_PATH = '[^']*';/, `export const VSCODE_LOGO_PATH = '${LEVELCODE_FISH_CHEVRON}';`],
    ["// VS Code logo silhouette path, extracted from sessions/contrib/chat/browser/media/vscode-icon.svg.",
      "// [LevelCode] The LevelCode double-chevron mark (branding/icons/code-icon.svg) as a filled silhouette."],
  ] },
  { f: "src/vs/sessions/contrib/aquarium/browser/fish.ts", subs: [
    ['/** The three VS Code release channel colors used as fish "species". */',
      '/** [LevelCode] The three brand-gradient stops as fish "species" (upstream: VS Code release channels). */'],
    ["[FishSpecies.Stable]: '#007ACC'", "[FishSpecies.Stable]: '#6a3fe0'"],
    ["[FishSpecies.Insiders]: '#24bfa5'", "[FishSpecies.Insiders]: '#7069ff'"],
    ["[FishSpecies.Exploration]: '#E04F00'", "[FishSpecies.Exploration]: '#4fb2ff'"],
    // Our mark is two OVERLAPPING subpaths; evenodd would knock the overlap out as a hole.
    ["logoPath.setAttribute('fill-rule', 'evenodd');", "logoPath.setAttribute('fill-rule', 'nonzero');"],
  ] },

  // ---- WS-D pairing: the Agents "Open in VS Code" button OPENS real VS Code, so it must show the VS
  //      Code shield — not code-icon.svg, which LevelCode overwrites with its own mark. (KEEP note:
  //      sessions/contrib/applyCommitsToParentRepo/.../applyChangesToParentRepo.ts "Open in VS Code" is a
  //      genuine external hand-off via the vscode:// scheme and is deliberately NOT listed here.) ----
  { f: "src/vs/sessions/browser/media/openInVSCode.css", subs: [
    ["url('../../../workbench/browser/media/code-icon.svg')", "url('./vscode-icon.svg')"],
  ] },
];

// ---- Pass 2: strip clickable Microsoft doc links. Matches ONLY `[text](https://code.visualstudio.com/…)`
// or `[text](https://aka.ms/…)` and collapses it to `text`. Never matches a github.com / marketplace /
// vscode:// / command: link, so it is safe to run over the whole tree. ----
// Link text is constrained to a single line with NO brackets ([^\[\]\r\n]+) so the match can't run from
// an unrelated `[` (e.g. an array literal `= [`) across code to a later link's `]` — that greediness
// once ate a `const x = [` bracket. The URL half stops at the first `)` / `>` / whitespace.
const MS_DOC_LINK = /\[([^\[\]\r\n]+)\]\(<?https?:\/\/(?:code\.visualstudio\.com|aka\.ms)[^)>\s]*>?\)/g;
const stripMsDocLinks = (text) => text.replace(MS_DOC_LINK, (match, label) =>
  // Skip VS Code's NLS `{Locked='](url)'}` translator-annotation idiom: there the leading `[` is a code
  // array bracket and the `]` lives inside `{Locked=…}` metadata (never user-visible). Stripping it would
  // eat the array bracket and break TS syntax. Real doc links (incl. `[foo `bar`](url)`) are untouched.
  label.includes("{Locked") ? match : label
);

// Collect the files pass 2 sweeps: all src .ts (minus tests / type decls / vendored agentHost) + every
// bundled extension's package.nls.json.
function collectUrlSweepFiles() {
  const out = [];
  const skipDir = new Set(["test", "node_modules", "agentHost"]);
  const walk = (dir) => {
    let entries;
    try { entries = readdirSync(dir); } catch { return; }
    for (const name of entries) {
      const p = join(dir, name);
      let st;
      try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) {
        if (!skipDir.has(name)) { walk(p); }
      } else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) {
        // NB: .d.ts are INCLUDED on purpose. `monaco.d.ts` copies JSDoc (incl. these MS doc-links)
        // verbatim from the editor source; the build fails ("monaco.d.ts is no longer up to date") unless
        // the generated-from-stripped-source .d.ts matches the on-disk one — so we must strip both.
        out.push(p);
      }
    }
  };
  walk(join(vscodeDir, "src"));
  const extRoot = join(vscodeDir, "extensions");
  if (existsSync(extRoot)) {
    for (const name of readdirSync(extRoot)) {
      const nls = join(extRoot, name, "package.nls.json");
      if (existsSync(nls)) { out.push(nls); }
    }
  }
  return out;
}

// ===================== Pass 1: curated name swaps =====================
let files = 0, total = 0, warnings = 0;
for (const { f, subs, extra } of RULES) {
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
  const applyOne = (from, to, warnOnMiss) => {
    const parts = text.split(from);
    const hits = parts.length - 1;
    if (hits > 0) { text = parts.join(to); n += hits; return; }
    // `from` is gone AND the replacement isn't present either → the string genuinely changed upstream.
    // (If `to` IS present, it was already applied — stay silent so re-runs are clean/idempotent.)
    if (warnOnMiss && !text.includes(to)) {
      console.warn(`[de-brand] WARN target not found in ${f}: ${JSON.stringify(from)} (upstream changed it?)`);
      warnings++;
    }
  };
  // Generic (G) name swaps: silent on miss — a file may legitimately contain only one of the two forms.
  // Targeted `subs` and every `extra` reword: warn on miss so real drift surfaces.
  for (const [from, to] of subs) { applyOne(from, to, !generic); }
  if (extra) { for (const [from, to] of extra) { applyOne(from, to, true); } }
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

// ===================== Pass 2: strip Microsoft doc links (global) =====================
let linkFiles = 0, linkTotal = 0;
for (const p of collectUrlSweepFiles()) {
  let text;
  try { text = readFileSync(p, "utf8"); } catch { continue; }
  if (!text.includes("code.visualstudio.com") && !text.includes("aka.ms")) { continue; }
  const matches = text.match(MS_DOC_LINK);
  if (!matches) { continue; } // has the host, but not in a clickable [..](..) link — leave it (may be code)
  const swept = stripMsDocLinks(text);
  if (swept !== text) {
    writeFileSync(p, swept, "utf8");
    linkFiles++; linkTotal += matches.length;
  }
}
if (linkFiles) { console.log(`[de-brand] MS doc-links stripped: ${linkTotal} link(s) across ${linkFiles} file(s)`); }

console.log(`[de-brand] done — ${total} name replacement(s) across ${files} file(s), ${linkTotal} MS link(s) across ${linkFiles} file(s), ${warnings} warning(s).`);
