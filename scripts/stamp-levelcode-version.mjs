/*---------------------------------------------------------------------------------------------
 *  LevelCode — stamp the RELEASE version into the BUILT app's product.json.
 *
 *  Usage:  node stamp-levelcode-version.mjs <app>/Contents/Resources/app <version> [isoDate]
 *
 *  WHY THIS EXISTS
 *  product.json `version` is, and must remain, the Code-OSS base ("1.126.0"). That value is what
 *  extensions' `engines.vscode` is validated against — set it to "0.8.0" and every extension
 *  requiring ^1.x is rejected. But it is also what the update UI and About dialog display, so a
 *  LevelCode build reported itself as "1.126.0", released on the upstream base's build date, while
 *  carrying a LevelCode commit. Half Code-OSS, half LevelCode, and confusing either way.
 *
 *  So we add SEPARATE, human-facing fields rather than overloading `version`:
 *    levelcodeVersion      "0.8.0"                 ← from the git tag
 *    levelcodeReleaseDate  "2026-07-20T02:51:22Z"  ← when this build's commit was COMMITTED (%cI)
 *
 *  Compatibility checks keep reading `version`; humans read these. Both are optional in the type,
 *  so a dev build with neither still renders (it falls back to `version`).
 *
 *  Idempotent + loud: re-stamping overwrites, and every outcome is printed.
 *--------------------------------------------------------------------------------------------*/
import fs from "node:fs";
import path from "node:path";

const appDir = process.argv[2];
const version = process.argv[3];
const isoDate = process.argv[4];

if (!appDir || !version) {
	console.error("[stamp] ERROR: usage: stamp-levelcode-version.mjs <.../Resources/app> <version> [isoDate]");
	process.exit(1);
}
if (!fs.existsSync(appDir)) {
	console.error(`[stamp] ERROR: ${appDir} not found — pass the built app's Contents/Resources/app dir.`);
	process.exit(1);
}

// A release version, not a tag: "v0.8.0" would render as "Current Version: v0.8.0".
//
// Accepted: X.Y.Z, optionally followed by a `-` or `+` suffix. The suffix is REQUIRED, not tolerated —
// build-macos.sh runs `git describe --tags` without --abbrev=0, so an off-tag build passes
// "v0.8.0-1-g404ef20" and must keep that suffix: it is exactly what stops a dev build from
// impersonating the release it happens to sit after. An exact-tag build (what CI does for a release)
// passes a clean "v0.8.0" and gets a clean "0.8.0".
//
// Rejected: anything else — "v0.8", a branch name, an empty describe. Those exit non-zero so the build
// fails rather than shipping a nonsense product version.
const clean = String(version).replace(/^v/, "");
if (!/^\d+\.\d+\.\d+([-+].+)?$/.test(clean)) {
	console.error(`[stamp] ERROR: "${version}" is not X.Y.Z or X.Y.Z-<suffix> — refusing to stamp.`);
	process.exit(1);
}

const productPath = path.join(appDir, "product.json");
try {
	const product = JSON.parse(fs.readFileSync(productPath, "utf8"));
	const previous = product.levelcodeVersion;

	product.levelcodeVersion = clean;
	if (isoDate && !Number.isNaN(Date.parse(isoDate))) {
		product.levelcodeReleaseDate = new Date(isoDate).toISOString();
	} else if (isoDate) {
		console.warn(`[stamp] WARN: ignoring unparseable date "${isoDate}" — the UI will fall back to product.date.`);
	}

	fs.writeFileSync(productPath, JSON.stringify(product, null, "\t") + "\n");
	console.log(
		`[stamp] product.json levelcodeVersion = ${clean}` +
		(product.levelcodeReleaseDate ? `, levelcodeReleaseDate = ${product.levelcodeReleaseDate}` : "") +
		(previous && previous !== clean ? `  (was ${previous})` : "")
	);
	// `version` stays put on purpose — see the header.
	console.log(`[stamp] product.json version left at ${product.version} (Code-OSS base, for engines.vscode).`);
} catch (e) {
	console.error(`[stamp] ERROR: could not stamp ${productPath}: ${(e && e.message) || e}`);
	process.exit(1);
}
