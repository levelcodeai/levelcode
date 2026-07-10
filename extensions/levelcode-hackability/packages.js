/*---------------------------------------------------------------------------------------------
 *  LevelCode — Hackability: package generator + hot reload
 *
 *  "Generate Package" scaffolds a runnable LevelCode package (plain JS, no build step).
 *  "Develop Package (Hot Reload)" loads a package's extension.js into the RUNNING window and
 *  re-runs activate() on every save — Atom-style live development, no window restart. (Code
 *  runs live; manifest-only `contributes` still need the generated F5 launch config.)
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

const vscode = require('vscode');
const os = require('os');
const fs = require('fs');
const path = require('path');
const Module = require('module');

const PACKAGES_DIR = path.join(os.homedir(), '.levelcode', 'packages');

/** @type {vscode.OutputChannel} */
let output;
/** Active dev session, or null. */
let dev = null; // { dir, name, exports, ctx, watcher, status, timer }

// ---- generator -------------------------------------------------------------

function pkgJson(name, title) {
	return JSON.stringify({
		name,
		displayName: title,
		description: 'An LevelCode package.',
		version: '0.0.1',
		publisher: 'you',
		engines: { vscode: '^1.126.0' },
		categories: ['Other'],
		activationEvents: ['onStartupFinished'],
		main: './extension.js',
		contributes: { commands: [{ command: name + '.hello', title: title + ': Hello' }] }
	}, null, 2) + '\n';
}

function extJs(name) {
	return `// ${name} — an LevelCode package.
//
// Develop it live: run "LevelCode: Develop Package (Hot Reload)" and pick this folder.
// Edit + save and activate() re-runs instantly — no window restart. (For manifest
// contributions like keybindings, press F5 for a full Extension Development Host.)

const vscode = require('vscode');

function activate(context) {
\tconst hello = vscode.commands.registerCommand('${name}.hello', () => {
\t\tvscode.window.showInformationMessage('Hello from ${name}! 👋');
\t});
\tcontext.subscriptions.push(hello);

\t// A status bar item — try changing this text and saving while hot-reload is running:
\tconst item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
\titem.text = '$(rocket) ${name}';
\titem.tooltip = 'From the ${name} package';
\titem.show();
\tcontext.subscriptions.push(item);
}

function deactivate() {}

module.exports = { activate, deactivate };
`;
}

function launchJson() {
	return JSON.stringify({
		version: '0.2.0',
		configurations: [{
			name: 'Run Package',
			type: 'extensionHost',
			request: 'launch',
			args: ['--extensionDevelopmentPath=${workspaceFolder}']
		}]
	}, null, 2) + '\n';
}

async function generatePackage() {
	const name = await vscode.window.showInputBox({
		title: 'LevelCode — Generate Package',
		prompt: 'Package name (lowercase, hyphens — e.g. my-cool-package)',
		validateInput: (v) => /^[a-z][a-z0-9-]*$/.test(v || '') ? null : 'Use lowercase letters, digits and hyphens; start with a letter.'
	});
	if (!name) { return; }
	const dir = path.join(PACKAGES_DIR, name);
	if (fs.existsSync(dir)) {
		vscode.window.showErrorMessage('LevelCode: a package named “' + name + '” already exists at ' + dir);
		return;
	}
	const title = name.replace(/(^|-)([a-z])/g, (_, s, c) => (s ? ' ' : '') + c.toUpperCase());
	try {
		fs.mkdirSync(path.join(dir, '.vscode'), { recursive: true });
		fs.writeFileSync(path.join(dir, 'package.json'), pkgJson(name, title), 'utf8');
		fs.writeFileSync(path.join(dir, 'extension.js'), extJs(name), 'utf8');
		fs.writeFileSync(path.join(dir, 'README.md'), '# ' + title + '\n\nAn LevelCode package.\n', 'utf8');
		fs.writeFileSync(path.join(dir, '.vscode', 'launch.json'), launchJson(), 'utf8');
	} catch (e) {
		vscode.window.showErrorMessage('LevelCode: could not scaffold package: ' + ((e && e.message) || e));
		return;
	}
	const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(dir, 'extension.js')));
	await vscode.window.showTextDocument(doc);
	const go = 'Develop (Hot Reload)';
	const c = await vscode.window.showInformationMessage('LevelCode: created package “' + name + '”.', go);
	if (c === go) { startDev(dir); }
}

// ---- hot-reload dev loader -------------------------------------------------

/** Load a package's main module fresh, with require('vscode') wired to the real API. */
function loadPackageExports(dir) {
	let main = path.join(dir, 'extension.js');
	try {
		const pj = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
		if (pj.main) { main = path.join(dir, pj.main); }
	} catch { /* default to extension.js */ }

	// Bust any cached modules under this package so sub-requires reload too.
	for (const k of Object.keys(require.cache)) { if (k.startsWith(dir + path.sep)) { delete require.cache[k]; } }

	const m = new Module(main, null);
	m.filename = main;
	m.paths = Module._nodeModulePaths(path.dirname(main));
	const baseRequire = m.require.bind(m);
	// @ts-ignore — intercept the bare 'vscode' specifier
	m.require = (id) => (id === 'vscode' ? vscode : baseRequire(id));
	m._compile(fs.readFileSync(main, 'utf8'), main);
	return m.exports;
}

function makeContext(dir) {
	const noState = { get: () => undefined, update: async () => {}, keys: () => [] };
	return {
		subscriptions: [],
		extensionPath: dir,
		extensionUri: vscode.Uri.file(dir),
		globalState: noState,
		workspaceState: noState,
		extensionMode: 2 // Development
	};
}

function teardownDev(keepStatus) {
	if (!dev) { return; }
	try { if (dev.exports && typeof dev.exports.deactivate === 'function') { dev.exports.deactivate(); } } catch (e) { output.appendLine('[dev] deactivate error: ' + e); }
	for (const d of dev.ctx.subscriptions) { try { if (d && d.dispose) { d.dispose(); } } catch { /* ignore */ } }
	dev.ctx.subscriptions = [];
	if (!keepStatus) {
		if (dev.timer) { clearTimeout(dev.timer); }
		try { dev.watcher.close(); } catch { /* ignore */ }
		dev.status.dispose();
	}
}

function activatePackage() {
	const ctx = makeContext(dev.dir);
	dev.ctx = ctx;
	const exports = loadPackageExports(dev.dir);
	dev.exports = exports;
	if (typeof exports.activate === 'function') { exports.activate(ctx); }
	output.appendLine('[dev] activated ' + dev.name + ' (' + ctx.subscriptions.length + ' disposable(s))');
}

function reloadDev() {
	if (!dev) { return; }
	teardownDev(true);
	try {
		activatePackage();
		dev.status.text = '$(sync) dev: ' + dev.name;
		vscode.window.setStatusBarMessage('LevelCode: reloaded ' + dev.name, 1500);
		setTimeout(() => { if (dev) { dev.status.text = '$(circle-filled) dev: ' + dev.name; } }, 600);
	} catch (e) {
		const msg = (e && e.stack) ? e.stack : String(e);
		output.appendLine('[dev] ERROR activating ' + dev.name + ':\n' + msg);
		vscode.window.showErrorMessage('LevelCode: ' + dev.name + ' failed to load: ' + ((e && e.message) || e), 'Show Log')
			.then((c) => { if (c) { output.show(true); } });
		if (dev) { dev.status.text = '$(error) dev: ' + dev.name; }
	}
}

function startDev(dir) {
	if (dev) { stopDev(); }
	const name = path.basename(dir);
	const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, -10);
	status.command = 'levelcode.package.stop';
	status.text = '$(circle-filled) dev: ' + name;
	status.tooltip = 'LevelCode is hot-reloading “' + name + '”. Click to stop.';
	status.show();

	const watcher = fs.watch(dir, { recursive: true }, (_event, file) => {
		if (file && /node_modules|\.git|\.vscode/.test(String(file))) { return; }
		if (file && !/\.js$/.test(String(file))) { return; }
		if (dev && dev.timer) { clearTimeout(dev.timer); }
		if (dev) { dev.timer = setTimeout(reloadDev, 150); } // debounce burst saves
	});

	dev = { dir, name, exports: null, ctx: { subscriptions: [] }, watcher, status, timer: null };
	reloadDev();
	vscode.window.showInformationMessage('LevelCode: developing “' + name + '” with hot reload. Save to re-run.');
}

function stopDev() {
	if (!dev) { vscode.window.showInformationMessage('LevelCode: no package is being developed.'); return; }
	const name = dev.name;
	teardownDev(false);
	dev = null;
	vscode.window.setStatusBarMessage('LevelCode: stopped developing ' + name, 2000);
}

async function developPackage() {
	let dirs = [];
	try { dirs = fs.existsSync(PACKAGES_DIR) ? fs.readdirSync(PACKAGES_DIR).map((n) => path.join(PACKAGES_DIR, n)).filter((p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } }) : []; } catch { dirs = []; }

	/** @type {any[]} */
	const items = dirs.map((d) => ({ label: '$(package) ' + path.basename(d), description: d, _dir: d }));
	items.push({ label: '$(folder-opened) Choose a folder…', _dir: null });
	const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Develop which package? (hot-reloads into this window)' });
	if (!pick) { return; }

	let dir = pick._dir;
	if (!dir) {
		const picked = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: false, openLabel: 'Develop this package', title: 'Pick an LevelCode package folder' });
		if (!picked || !picked.length) { return; }
		dir = picked[0].fsPath;
	}
	if (!fs.existsSync(path.join(dir, 'extension.js')) && !fs.existsSync(path.join(dir, 'package.json'))) {
		vscode.window.showErrorMessage('LevelCode: that folder has no extension.js / package.json.');
		return;
	}
	startDev(dir);
}

function registerPackages(context) {
	output = vscode.window.createOutputChannel('LevelCode Packages');
	context.subscriptions.push(
		output,
		vscode.commands.registerCommand('levelcode.package.generate', generatePackage),
		vscode.commands.registerCommand('levelcode.package.develop', developPackage),
		vscode.commands.registerCommand('levelcode.package.stop', stopDev),
		{ dispose: () => { if (dev) { teardownDev(false); dev = null; } } }
	);
}

module.exports = { registerPackages };
