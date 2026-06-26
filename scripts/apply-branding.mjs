#!/usr/bin/env node
/**
 * Atom++ branding applier.
 *
 * Deep-merges branding/product.overlay.json onto the checked-out vscode/product.json.
 * We MERGE (not replace) so we stay compatible as upstream adds keys across rebases.
 *
 * Usage:
 *   node scripts/apply-branding.mjs <path-to-vscode-checkout>
 *
 * Idempotent: a backup of the original product.json is written once to
 * product.json.vanilla so you can always diff/restore.
 */

import { readFileSync, writeFileSync, existsSync, copyFileSync, readdirSync, cpSync, statSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

const vscodeDir = resolve(process.argv[2] || join(repoRoot, "vscode"));
const productPath = join(vscodeDir, "product.json");
const overlayPath = join(repoRoot, "branding", "product.overlay.json");
const vanillaBackup = join(vscodeDir, "product.json.vanilla");

function fail(msg) {
  console.error(`\x1b[31m[apply-branding] ${msg}\x1b[0m`);
  process.exit(1);
}

if (!existsSync(productPath)) {
  fail(`Could not find product.json at ${productPath}.\n` +
       `Pass the vscode checkout path: node scripts/apply-branding.mjs /path/to/vscode`);
}
if (!existsSync(overlayPath)) {
  fail(`Missing overlay at ${overlayPath}`);
}

// Strip keys whose name starts with "_" (comments/namespacing) before merging.
function stripComments(value) {
  if (Array.isArray(value)) return value.map(stripComments);
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (k.startsWith("_")) continue;
      out[k] = stripComments(v);
    }
    return out;
  }
  return value;
}

function deepMerge(base, overlay) {
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(overlay)) {
    if (
      v && typeof v === "object" && !Array.isArray(v) &&
      out[k] && typeof out[k] === "object" && !Array.isArray(out[k])
    ) {
      out[k] = deepMerge(out[k], v);
    } else {
      out[k] = v; // overlay wins (objects merged above, scalars/arrays replaced)
    }
  }
  return out;
}

const product = JSON.parse(readFileSync(productPath, "utf8"));
const overlayRaw = JSON.parse(readFileSync(overlayPath, "utf8"));
const overlay = stripComments(overlayRaw);

if (!existsSync(vanillaBackup)) {
  copyFileSync(productPath, vanillaBackup);
  console.log(`[apply-branding] Saved pristine copy -> ${vanillaBackup}`);
}

const merged = deepMerge(product, overlay);
writeFileSync(productPath, JSON.stringify(merged, null, "\t") + "\n", "utf8");

// Apply the Atom++ app icon, if we have one, so rebuilds/rebootstraps keep it.
const icnsSrc = join(repoRoot, "branding", "icons", "atom-plus-plus.icns");
const icnsDst = join(vscodeDir, "resources", "darwin", "code.icns");
if (existsSync(icnsSrc) && existsSync(dirname(icnsDst))) {
  copyFileSync(icnsSrc, icnsDst);
  console.log(`[apply-branding] Installed app icon -> ${icnsDst}`);
}
const pngSrc = join(repoRoot, "branding", "icons", "atom-plus-plus-1024.png");
const pngDst = join(vscodeDir, "resources", "linux", "code.png");
if (existsSync(pngSrc) && existsSync(dirname(pngDst))) {
  copyFileSync(pngSrc, pngDst);
}

// Install our bundled Atom++ extensions into the checkout. The canonical, version-controlled
// source lives in this repo's extensions/ folder; the copies inside vscode/ are generated.
const extSrcRoot = join(repoRoot, "extensions");
if (existsSync(extSrcRoot)) {
  for (const name of readdirSync(extSrcRoot)) {
    const src = join(extSrcRoot, name);
    if (!statSync(src).isDirectory()) { continue; }
    cpSync(src, join(vscodeDir, "extensions", name), { recursive: true, force: true });
    console.log(`[apply-branding] Installed extension -> extensions/${name}`);
  }
}

console.log(`[apply-branding] Atom++ branding applied to ${productPath}`);
console.log(`[apply-branding]   nameLong        = ${merged.nameLong}`);
console.log(`[apply-branding]   applicationName = ${merged.applicationName}`);
console.log(`[apply-branding]   gallery         = ${merged.extensionsGallery?.serviceUrl}`);
console.log(`[apply-branding]   telemetry       = ${merged.enableTelemetry}`);
