/*---------------------------------------------------------------------------------------------
 *  Atom++ — hide NOT-YET-READY features from the PUBLIC build. Runs on the BUILT app (same arg
 *  as strip-proprietary.mjs: the .../Contents/Resources/app dir). Source keeps everything for dev
 *  and the future Pro release; only the shipped .dmg has these surfaces removed.
 *
 *  Today this hides **Atom++ Sync**: the managed cloud host isn't deployed and the store URL is a
 *  localhost dev placeholder, so a public user clicking "Set up Sync" would just fail. We remove
 *  its user-facing surfaces:
 *    1. the atom-sync extension       (its commands + the `atompp` sync auth provider)
 *    2. product.json configurationSync.store   (the dead localhost sync endpoint)
 *    3. the "Sync" step in the Atom++ AI Welcome walkthrough
 *  (The Customize panel's Sync section hides itself at runtime when the sync command is absent.)
 *
 *  Idempotent + loud; warns — does not fail — if a target is already gone.
 *--------------------------------------------------------------------------------------------*/
import fs from "node:fs";
import path from "node:path";

const appDir = process.argv[2] || path.join(process.cwd(), "vscode");
if (!fs.existsSync(appDir)) {
  console.error(`[hide] ERROR: ${appDir} not found — pass the built app's Contents/Resources/app dir.`);
  process.exit(1);
}

const done = [];
const missing = [];

// 1. Remove the atom-sync extension from the built app.
const syncExt = path.join(appDir, "extensions", "atom-sync");
if (fs.existsSync(syncExt)) {
  fs.rmSync(syncExt, { recursive: true, force: true });
  done.push("extensions/atom-sync (commands + `atompp` sync auth provider)");
} else {
  missing.push("extensions/atom-sync");
}

// 2. Drop the configurationSync.store override from product.json (the dead localhost endpoint).
// Our overlay writes it as a FLAT "configurationSync.store" key; handle a nested shape too.
const productPath = path.join(appDir, "product.json");
try {
  const product = JSON.parse(fs.readFileSync(productPath, "utf8"));
  let changed = false;
  if (product.configurationSync && product.configurationSync.store !== undefined) {
    delete product.configurationSync.store;
    changed = true;
  }
  if (product["configurationSync.store"] !== undefined) {
    delete product["configurationSync.store"];
    changed = true;
  }
  if (changed) {
    fs.writeFileSync(productPath, JSON.stringify(product, null, "\t") + "\n");
    done.push("product.json configurationSync.store (localhost sync endpoint)");
  } else {
    missing.push("product.json configurationSync.store");
  }
} catch (e) {
  missing.push("product.json (" + ((e && e.message) || e) + ")");
}

// 3. Remove the "Sync" step from the Atom++ AI Welcome walkthrough so it can't dangle a dead link.
const aiPkgPath = path.join(appDir, "extensions", "atom-ai", "package.json");
try {
  const pkg = JSON.parse(fs.readFileSync(aiPkgPath, "utf8"));
  const walkthroughs = ((pkg.contributes || {}).walkthroughs) || [];
  let removed = 0;
  for (const w of walkthroughs) {
    if (!Array.isArray(w.steps)) continue;
    const before = w.steps.length;
    w.steps = w.steps.filter(
      (s) => s.id !== "sync" && !JSON.stringify(s).includes("atompp.sync."),
    );
    removed += before - w.steps.length;
  }
  if (removed) {
    fs.writeFileSync(aiPkgPath, JSON.stringify(pkg, null, "\t") + "\n");
    done.push(`atom-ai Welcome walkthrough: removed ${removed} Sync step`);
  } else {
    missing.push("atom-ai walkthrough Sync step");
  }
} catch (e) {
  missing.push("atom-ai package.json (" + ((e && e.message) || e) + ")");
}

console.log("[hide] removing not-yet-ready features from the public build (Atom++ Sync)");
for (const d of done) console.log("  removed: " + d);
for (const m of missing) console.log("  · not present (already hidden?): " + m);
if (!done.length) {
  console.log("[hide] nothing to hide — everything was already absent.");
}
