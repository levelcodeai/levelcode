// Which of Code-OSS's built-in extensions the browser edition carries, and how they are staged.
//
// The web build bakes into its bundle only the extensions that have a browser entry point (about
// twenty: JSON, CSS and HTML language features, Markdown, the TypeScript language service...). The
// declarative ones that give an editor its colour — TextMate grammars, language configurations,
// themes, file icons — are not packaged for the web by this checkout's tooling, so without them a
// file is plain text. Declaring them is all they need, so they are staged beside LevelCode's own
// extensions and loaded as additional built-ins (the workbench reads each package.json).
import fs from 'node:fs';
import path from 'node:path';

/** Directories never copied: tests, sources, and package managers' droppings. */
const SKIP = new Set(['node_modules', 'test', 'tests', 'src', '.vscode', '.git', 'build']);
/** Extensions that exist in a Code-OSS checkout for its own development. */
const DEV_ONLY = new Set(['vscode-api-tests', 'vscode-colorize-tests', 'vscode-colorize-perf-tests', 'vscode-test-resolver', 'copilot']);

/** Mirrors build/lib/extensions.ts isWebExtension() for a manifest with neither main nor browser. */
export function isDeclarativeWebExtension(manifest) {
	if (manifest.main || manifest.browser) { return false; }
	const c = manifest.contributes || {};
	for (const id of ['debuggers', 'terminal', 'typescriptServerPlugins']) { if (Object.prototype.hasOwnProperty.call(c, id)) { return false; } }
	return true;
}

/**
 * Which extensions of a Code-OSS `extensions/` directory are staged: the declarative ones that are not excluded.
 * @param {string} extensionsDir
 * @param {Iterable<string>} [excludeNames] names to leave out (already baked into the bundle)
 * @returns {string[]} sorted
 */
export function declarativeExtensionNames(extensionsDir, excludeNames = []) {
	const exclude = new Set(excludeNames);
	const names = [];
	for (const name of fs.readdirSync(extensionsDir).sort()) {
		if (exclude.has(name) || DEV_ONLY.has(name)) { continue; }
		const dir = path.join(extensionsDir, name);
		const pkgPath = path.join(dir, 'package.json');
		if (!fs.statSync(dir).isDirectory() || !fs.existsSync(pkgPath)) { continue; }
		let manifest;
		try { manifest = JSON.parse(fs.readFileSync(pkgPath, 'utf8')); } catch { continue; }
		if (!isDeclarativeWebExtension(manifest)) { continue; }
		names.push(name);
	}
	return names;
}

/** Names `copyExtension` leaves out, for hashing the same inputs it copies. */
export const COPY_SKIP = [...SKIP];

/**
 * @param {string} extensionsDir Code-OSS's extensions/ directory
 * @param {string} outDir where to stage
 * @param {{ exclude?: Iterable<string> }} [opts] names to leave out (already baked into the bundle)
 * @returns {string[]} the staged extension names, sorted
 */
export function stageDeclarativeExtensions(extensionsDir, outDir, opts = {}) {
	const staged = [];
	for (const name of declarativeExtensionNames(extensionsDir, opts.exclude)) {
		copyExtension(path.join(extensionsDir, name), path.join(outDir, name));
		// The workbench asks every extension for a package.nls.json; an absent one is a 404 in the console.
		const nls = path.join(outDir, name, 'package.nls.json');
		if (!fs.existsSync(nls)) { fs.writeFileSync(nls, '{}\n'); }
		staged.push(name);
	}
	return staged;
}

/** Copy an extension directory without its development files and its translations (English ships). */
export function copyExtension(from, to) {
	fs.mkdirSync(to, { recursive: true });
	for (const e of fs.readdirSync(from, { withFileTypes: true })) {
		if (SKIP.has(e.name)) { continue; }
		if (/^package\.nls\..+\.json$/.test(e.name)) { continue; }   // localisations: the build is English-only
		const src = path.join(from, e.name);
		const dst = path.join(to, e.name);
		if (e.isDirectory()) { copyExtension(src, dst); }
		else if (e.isFile()) { fs.copyFileSync(src, dst); }
	}
}

/**
 * Remove a staged extension's default settings from its manifest. An extension's `configurationDefaults` outrank the
 * embedder's, and levelcode-themes pins the desktop's default theme; the browser edition has a theme of its own, so
 * the page's configuration has to be the one that decides.
 * @param {string} manifestPath
 * @returns {boolean} whether anything was removed
 */
export function withoutConfigurationDefaults(manifestPath) {
	const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
	const c = manifest.contributes;
	if (!c || !Object.prototype.hasOwnProperty.call(c, 'configurationDefaults')) { return false; }
	delete c.configurationDefaults;
	fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, '\t') + '\n');
	return true;
}
