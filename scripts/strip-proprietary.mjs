#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  LevelCode — strip proprietary Microsoft/GitHub packages from the Code-OSS build.
 *
 *  VS Code 1.126 bundles GitHub's Copilot-CLI SDK + a Microsoft sandbox SDK as CORE deps for its
 *  new "agentHost" platform (src/vs/platform/agentHost/): @github/copilot, @github/copilot-sdk,
 *  @microsoft/mxc-sdk (~120 MB). These are NOT MIT/redistributable, so they must not ship in a
 *  public LevelCode build. They're only loaded by VS Code's built-in Copilot agent — a separate
 *  utility process that LevelCode disables and replaces with its own agent — so at runtime, in
 *  normal use, these stubs are never even called.
 *
 *  We replace each package with a tiny MIT-clean stub: an index.js exporting the few symbols the
 *  core imports as VALUES. Every export is an empty function so it's safe whether the (dormant) code
 *  path news it, calls it, or reads a property off it.
 *
 *  IMPORTANT — this runs on the BUILT APP (build-macos.sh / make-dmg.sh point it at
 *  `LevelCode.app/Contents/Resources/app`), NOT the source `vscode/` checkout. The source keeps the real
 *  packages so dev-mode typecheck (run-dev.sh → tsgo) still sees their type declarations; only the
 *  shipped bundle is stripped. Idempotent (a .levelcode-stub sentinel), loud, and it WARNS (doesn't fail)
 *  if a target package is absent — so an upstream change is surfaced, not hidden.
 *
 *  Usage:  node scripts/strip-proprietary.mjs <dir-containing-node_modules>
 *          (build: …/LevelCode.app/Contents/Resources/app)
 *--------------------------------------------------------------------------------------------*/
import fs from 'node:fs';
import path from 'node:path';

const vscodeDir = process.argv[2] || path.join(process.cwd(), 'vscode');
const nm = path.join(vscodeDir, 'node_modules');

/** The exact runtime (value) symbols the core imports from each package; everything else is `import type`. */
const STUBS = {
	'@github/copilot':     { exports: [], note: 'native Copilot CLI runtime — binary dir only; nothing imports it as a module' },
	'@github/copilot-sdk': { exports: ['CopilotClient', 'RuntimeConnection', 'CopilotSession', 'SessionEventType', 'SessionEventPayload'], note: 'Copilot agent SDK — loaded only by the agentHost node process' },
	'@microsoft/mxc-sdk':  { exports: ['getAvailableToolsPolicy', 'getUserProfilePolicy', 'getTemporaryFilesPolicy', 'buildSandboxPayload'], note: 'MS sandbox SDK — dynamic import in the agentHost sandbox only' }
};

const du = (p) => { let n = 0; try { for (const e of fs.readdirSync(p, { withFileTypes: true })) { const q = path.join(p, e.name); n += e.isDirectory() ? du(q) : (fs.statSync(q).size || 0); } } catch { /* */ } return n; };
const human = (b) => b >= 1048576 ? (b / 1048576).toFixed(0) + 'M' : b >= 1024 ? (b / 1024).toFixed(0) + 'K' : b + 'B';

if (!fs.existsSync(nm)) {
	console.error(`[strip] ERROR: ${nm} not found — run this AFTER 'npm ci'.`);
	process.exit(1);
}

let reclaimed = 0;
const stubbed = [], skipped = [], missing = [];
for (const [pkg, spec] of Object.entries(STUBS)) {
	const dir = path.join(nm, pkg);
	if (!fs.existsSync(dir)) { missing.push(pkg); continue; }
	if (fs.existsSync(path.join(dir, '.levelcode-stub'))) { skipped.push(pkg); continue; }

	let version = '0.0.0';
	try { version = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version || version; } catch { /* */ }

	const before = du(dir);
	fs.rmSync(dir, { recursive: true, force: true });
	fs.mkdirSync(dir, { recursive: true });

	const js = spec.exports.length
		? '// LevelCode MIT-clean stub (proprietary package removed — see scripts/strip-proprietary.mjs).\n' +
		  spec.exports.map((n) => `exports.${n} = function ${n}() {};`).join('\n') + '\n'
		: '// LevelCode MIT-clean stub (proprietary package removed — see scripts/strip-proprietary.mjs).\nmodule.exports = {};\n';
	fs.writeFileSync(path.join(dir, 'index.js'), js);
	fs.writeFileSync(path.join(dir, 'index.d.ts'), '// LevelCode stub types: all named imports resolve to any.\ndeclare const _: any;\nexport = _;\n');
	fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: pkg, version, description: 'LevelCode stub — proprietary package removed (scripts/strip-proprietary.mjs)', main: 'index.js', types: 'index.d.ts', license: 'MIT' }, null, 2) + '\n');
	fs.writeFileSync(path.join(dir, '.levelcode-stub'), spec.note + '\n');

	reclaimed += before;
	stubbed.push(`${pkg}  (−${human(before)})  — ${spec.note}`);
}

console.log('[strip] de-Microsoft: replacing bundled proprietary packages with MIT-clean stubs');
for (const s of stubbed) { console.log('  stubbed:         ' + s); }
for (const s of skipped) { console.log('  already stubbed: ' + s); }
for (const m of missing) { console.log('  ⚠️  NOT FOUND (upstream changed? re-check strip list): ' + m); }
console.log(`[strip] reclaimed ~${human(reclaimed)} of non-redistributable code.`);
if (missing.length === Object.keys(STUBS).length && stubbed.length === 0 && skipped.length === 0) {
	console.log('[strip] none of the target packages were present — nothing to strip (verify upstream still needs stripping).');
}
