/*---------------------------------------------------------------------------------------------
 *  Atom++ — Import from VS Code
 *
 *  Bring your settings, keybindings, and snippets over from VS Code / VSCodium / Cursor so
 *  switching to Atom++ takes seconds. Settings are MERGED (your VS Code values win on conflicts,
 *  Atom++ defaults kept), keybindings are appended (later = higher priority), snippets copied.
 *
 *  Data safety (verified by review + tests):
 *   - The destination is the editor's REAL User dir, derived from context.globalStorageUri
 *     (`<userData>/User/...`), so it works in both dev and packaged builds — never a guessed path.
 *   - Every destination file is backed up BEFORE it's written; the write is GATED on the backup
 *     succeeding (a failed backup → the file is skipped, never clobbered). Writes are atomic
 *     (temp + rename).
 *   - JSONC is parsed by a string-aware scanner that never strips comment-looking text inside
 *     string values, so it can't silently corrupt a setting. An unparseable EXISTING file is left
 *     untouched (we don't replace it with incoming-only).
 *
 *  The parse/merge logic is pure + unit-tested (importVscode.test.js); the command does the IO.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
// `vscode` is required lazily inside importFromVscode() so the pure helpers below stay
// unit-testable under plain node (the test imports this module directly).
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

// ---- pure helpers (no vscode/fs writes) ----------------------------------------------------

/** Strip // and /* *\/ comments and trailing commas, but ONLY outside JSON strings (string-aware). */
function stripJsonc(text) {
	const s = String(text);
	let out = '';
	let i = 0, inStr = false, esc = false;
	while (i < s.length) {
		const ch = s[i];
		if (inStr) {
			out += ch;
			if (esc) { esc = false; }
			else if (ch === '\\') { esc = true; }
			else if (ch === '"') { inStr = false; }
			i++; continue;
		}
		if (ch === '"') { inStr = true; out += ch; i++; continue; }
		if (ch === '/' && s[i + 1] === '/') { i += 2; while (i < s.length && s[i] !== '\n' && s[i] !== '\r') { i++; } continue; }
		if (ch === '/' && s[i + 1] === '*') { i += 2; while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) { i++; } i += 2; continue; }
		if (ch === ',') {
			// trailing comma → drop it if the next significant token (past ws + comments) is } or ]
			let j = i + 1;
			for (;;) {
				while (j < s.length && /\s/.test(s[j])) { j++; }
				if (s[j] === '/' && s[j + 1] === '/') { j += 2; while (j < s.length && s[j] !== '\n' && s[j] !== '\r') { j++; } continue; }
				if (s[j] === '/' && s[j + 1] === '*') { j += 2; while (j < s.length && !(s[j] === '*' && s[j + 1] === '/')) { j++; } j += 2; continue; }
				break;
			}
			if (s[j] === '}' || s[j] === ']') { i++; continue; }
			out += ch; i++; continue;
		}
		out += ch; i++;
	}
	return out;
}

/** JSONC-tolerant parse. Returns the value, or null on failure (caller treats null as "skip"). */
function jsoncParse(text) {
	if (text == null) { return null; }
	try { return JSON.parse(stripJsonc(text)); } catch { return null; }
}

/** Whether a config text is "present" (non-empty) vs absent. */
function nonEmpty(text) { return text != null && String(text).trim() !== ''; }

/**
 * Merge VS Code settings over the existing Atom++ settings (incoming wins). Returns null (→ skip)
 * if the incoming OR a NON-EMPTY existing file can't be parsed (so we never clobber/lose data).
 */
function mergeSettings(baseText, incomingText) {
	const inc = jsoncParse(incomingText);
	if (inc == null || typeof inc !== 'object' || Array.isArray(inc)) { return null; }
	const base = jsoncParse(baseText);
	if (nonEmpty(baseText) && base == null) { return null; }   // existing file unparseable → leave it untouched
	const baseObj = (base && typeof base === 'object' && !Array.isArray(base)) ? base : {};
	return JSON.stringify(Object.assign({}, baseObj, inc), null, 2) + '\n';
}

/** Append VS Code keybindings after the existing ones. Returns null (→ skip) on the same conditions. */
function mergeKeybindings(baseText, incomingText) {
	const inc = jsoncParse(incomingText);
	if (!Array.isArray(inc)) { return null; }
	const base = jsoncParse(baseText);
	if (nonEmpty(baseText) && base == null) { return null; }
	return JSON.stringify((Array.isArray(base) ? base : []).concat(inc), null, 2) + '\n';
}

// ---- IO ------------------------------------------------------------------------------------

function supportDir() { return path.join(os.homedir(), 'Library', 'Application Support'); } // macOS

/** Existing VS Code-family user dirs to import FROM (macOS). */
function vscodeCandidates() {
	const base = supportDir();
	return [
		{ name: 'Visual Studio Code', dir: path.join(base, 'Code', 'User') },
		{ name: 'VS Code Insiders', dir: path.join(base, 'Code - Insiders', 'User') },
		{ name: 'VSCodium', dir: path.join(base, 'VSCodium', 'User') },
		{ name: 'Cursor', dir: path.join(base, 'Cursor', 'User') }
	].filter((c) => { try { return fs.statSync(c.dir).isDirectory(); } catch { return false; } });
}

/** The running editor's REAL User dir, derived from globalStorageUri = <userData>/User/globalStorage/<id>. */
function userDirFromContext(context) {
	try { return path.dirname(path.dirname(context.globalStorageUri.fsPath)); } catch { return path.join(supportDir(), 'Atom++', 'User'); }
}

function readSafe(p) { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } }

/** Back up `file` (if it exists). Returns true if there's nothing to back up OR the backup is verified; false on failure. */
function backup(file, stamp) {
	try {
		if (!fs.existsSync(file)) { return true; }
		const bak = file + '.bak-' + stamp;
		fs.copyFileSync(file, bak);
		return fs.existsSync(bak);
	} catch { return false; }
}

/** Atomic write: temp file + rename (so a crash mid-write can't truncate the target). */
function writeAtomic(file, content) {
	const tmp = file + '.tmp-' + process.pid;
	fs.writeFileSync(tmp, content);
	fs.renameSync(tmp, file);
}

/** Copy snippet files, backing up each collision first; a file whose backup fails is skipped. Returns [copied, skipped]. */
function copySnippets(srcDir, destDir, stamp) {
	let copied = 0, skipped = 0, files;
	try { files = fs.readdirSync(srcDir).filter((f) => /\.(json|code-snippets)$/i.test(f)); } catch { return [0, 0]; }
	try { fs.mkdirSync(destDir, { recursive: true }); } catch { /* */ }
	for (const f of files) {
		const dest = path.join(destDir, f);
		if (!backup(dest, stamp)) { skipped++; continue; }
		try { fs.copyFileSync(path.join(srcDir, f), dest); copied++; } catch { skipped++; }
	}
	return [copied, skipped];
}

async function importFromVscode(context) {
	const vscode = require('vscode');
	if (process.platform !== 'darwin') {
		vscode.window.showInformationMessage('Atom++: Import from VS Code is currently macOS-only.');
		return;
	}
	const cands = vscodeCandidates();
	if (!cands.length) { vscode.window.showInformationMessage('Atom++: no VS Code / VSCodium / Cursor settings found to import.'); return; }

	let src = cands[0];
	if (cands.length > 1) {
		const pick = await vscode.window.showQuickPick(cands.map((c) => ({ label: c.name, description: c.dir, _cand: c })), { title: 'Import from which editor?' });
		if (!pick) { return; }
		src = pick._cand;
	}

	const has = (f) => { try { return fs.existsSync(path.join(src.dir, f)); } catch { return false; } };
	const hasSnippets = () => { try { return fs.readdirSync(path.join(src.dir, 'snippets')).some((f) => /\.(json|code-snippets)$/i.test(f)); } catch { return false; } };
	const items = [];
	if (has('settings.json')) { items.push({ label: 'Settings', detail: 'merged at top level — your VS Code values win, Atom++ defaults kept', id: 'settings', picked: true }); }
	if (has('keybindings.json')) { items.push({ label: 'Keybindings', detail: 'appended after Atom++ defaults', id: 'keybindings', picked: true }); }
	if (hasSnippets()) { items.push({ label: 'Snippets', detail: 'copied into your snippets folder', id: 'snippets', picked: true }); }
	if (!items.length) { vscode.window.showInformationMessage('Atom++: nothing to import from ' + src.name + '.'); return; }

	const chosen = await vscode.window.showQuickPick(items, { canPickMany: true, title: 'Import from ' + src.name + ' — existing files are backed up first' });
	if (!chosen || !chosen.length) { return; }
	const ids = new Set(chosen.map((c) => c.id));

	const dest = userDirFromContext(context);
	try { fs.mkdirSync(dest, { recursive: true }); } catch { /* */ }
	const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
	const report = [];

	const importMerged = (file, merge, okLabel) => {
		const target = path.join(dest, file);
		const merged = merge(readSafe(target), readSafe(path.join(src.dir, file)));
		if (merged == null) { report.push(file + ' skipped (couldn’t parse — left untouched)'); return; }
		if (!backup(target, stamp)) { report.push(file + ' skipped (backup failed)'); return; }
		try { writeAtomic(target, merged); report.push(okLabel); } catch { report.push(file + ' failed to write'); }
	};

	if (ids.has('settings')) { importMerged('settings.json', mergeSettings, 'settings merged'); }
	if (ids.has('keybindings')) { importMerged('keybindings.json', mergeKeybindings, 'keybindings imported'); }
	if (ids.has('snippets')) {
		const [copied, skipped] = copySnippets(path.join(src.dir, 'snippets'), path.join(dest, 'snippets'), stamp);
		report.push(copied + ' snippet file' + (copied === 1 ? '' : 's') + (skipped ? ' (' + skipped + ' skipped)' : ''));
	}

	const choice = await vscode.window.showInformationMessage(
		'Imported from ' + src.name + ' → ' + dest + ': ' + report.join(', ') + '.',
		'Reload Window', 'Open settings.json');
	if (choice === 'Reload Window') { vscode.commands.executeCommand('workbench.action.reloadWindow'); }
	else if (choice === 'Open settings.json') { try { await vscode.window.showTextDocument(vscode.Uri.file(path.join(dest, 'settings.json'))); } catch (e) { /* */ } }
}

module.exports = { importFromVscode, stripJsonc, jsoncParse, mergeSettings, mergeKeybindings, vscodeCandidates, userDirFromContext };
