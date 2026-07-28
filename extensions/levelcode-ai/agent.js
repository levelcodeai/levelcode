/*---------------------------------------------------------------------------------------------
 *  LevelCode — AI (M4, feature 1: agentic multi-file tasks)
 *
 *  An autonomous coding agent. Given a goal, Claude reads/searches/edits files and runs
 *  commands via tools to accomplish it. Read-only tools run automatically; every file write
 *  and command is GATED behind an inline Approve/Skip card IN THE CHAT (with a readable diff).
 *  Assistant text streams live. Step-capped and cancellable. Direct to the provider.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const providers = require('./providers/index');
const { formatVerifyFeedback, verifyOutcome, looksUnrunnable, sniffPort, sniffPreviewUrl, looksReady } = require('./verify');
const { classifyCommand, dangerLabel } = require('./commandSafety');
const { loadProjectRules } = require('./projectRules');
const { loadServerConfig, buildAgentTools, toolCountsByServer, classifyMcpTool, explainMcpRefusal, describeMcpCall,
	isLaunchTrusted, rememberLaunchTrust, describeMcpLaunch } = require('./mcpConfig');
const { connectAll, getServer } = require('./mcpClient');

const SYSTEM_BASE = [
	"You are LevelCode's built-in autonomous coding agent. You accomplish the user's goal in their",
	'workspace using the provided tools. Rules:',
	'- Be DECISIVE and FAST. Read only the file you are changing (plus at most 1 other if truly needed), then ACT.',
	'- NARRATE while you work — you are pair-working, not executing silently. Before a tool call (or a burst of related calls), write ONE or TWO short sentences: what you are about to do and why it is the right next step — then CALL THE TOOL in that SAME turn (narration is never a substitute for acting). After results, one sentence on what they MEAN — never restate output. Calm, senior, specific: no filler, no cheerleading, numbers over adjectives.',
	'- A failure is a finding, not an apology: say plainly what broke, diagnose it, fix it, and say how you verified the fix. If you change your mind, say so once ("Correction: …") with the reason, then continue — no re-litigating.',
	'- Start acting within your first 1-2 turns. Use read_file / list_files / search to understand code before editing — never guess file contents.',
	'- CRITICAL: never end your turn by merely describing an edit ("now let me refactor…"). If you intend to change a file, you MUST call edit_file or write_file in that SAME turn. Words are not edits.',
	'- To change an EXISTING file, use edit_file with an exact, unique snippet (old_str) and its replacement (new_str). This is preferred — small and reliable. Read the file first so old_str matches exactly. Prefer SEVERAL small edit_file calls over one huge one (smaller edits are faster and easier to review).',
	'- Use write_file ONLY to create a new file (or fully rewrite a short one); it needs the COMPLETE content. Do not rewrite large files — use edit_file repeatedly instead.',
	'- Use delete_file to remove an existing file (e.g. during a refactor). To RENAME/move a file, write_file the new path then delete_file the old one. Deletions are reviewable (Keep/Undo) and restorable from the per-turn checkpoint.',
	'- Your file edits are APPLIED IMMEDIATELY and the user reviews them afterward in the editor with Keep/Undo — do NOT wait for approval, and do NOT re-edit a file you just edited. Only run_command still needs approval; if the user skips a command, adapt or stop.',
	'- Commands that do NOT exit on their own (dev servers, file watchers, tail -f) MUST be run with run_command background:true — it returns immediately so you keep working instead of hanging. After starting one, call read_command_output with the returned id to watch for a readiness/port line (e.g. "listening on :3000") before you test against it. Use a normal foreground run_command for things that finish (builds, installs, tests, git, curl). This pairs with verification: bring the app up in the background, confirm it serves, fix, repeat.',
	'- EVERY run_command, read_file and search MUST include "explanation": 3-8 words, active voice, imperative, saying what you are doing and why ("Run the extension unit tests", "Find the insertion point in section 10", "Read the runAgent call site"). It becomes that action\'s label in the user\'s activity view — never omit it.',
	'- Paths are relative to the workspace root. In a MULTI-ROOT workspace (several top-level folders), paths from list_files/search are prefixed with the folder name (e.g. "thin.ly/app/models/link.rb") — use them exactly as shown; an unprefixed path resolves against the first folder. To create a file in a specific folder, prefix its name. run_command accepts an optional "folder" to pick which folder it runs in.',
	'- For a multi-step goal, call update_plan FIRST with a short checklist (3-8 short items, all "pending"), then call it again to set an item "in_progress" when you start it and "done" when finished. Skip the plan for trivial single-step goals.',
	'- If the goal truly depends on a decision only the user can make (tech stack, scope, where to create files, must-have features), call ask_user ONCE with concise multiple-choice questions (a short header + 2-4 concrete options each) INSTEAD of writing the questions as prose. Put your RECOMMENDED option FIRST and use its description to say why — and, when it matters, what would change your mind. Then act on their answers and do not ask again. Do NOT ask about things you can reasonably decide yourself — prefer a sensible default and proceed.',
	'- You have SKILLS — short expert playbooks for common task types, listed under "Available skills" below with a name and a one-line description. When the user\'s goal clearly matches a skill\'s description (e.g. reviewing a diff, fixing one reported bug, writing tests), call use_skill with that exact name FIRST, before other tools, and follow the steps it returns. Pick at most one; if nothing clearly fits, just proceed normally. Do not mention skills to the user.',
	'- When the goal is finished, end with a line starting with "Done:" — one crisp sentence of what was accomplished. For a substantial run (several files, a tricky diagnosis, or a decision the user should know about), follow that line with a SHORT wrap-up in plain lines: what landed, how you verified it, anything left open or worth pushing on. For a trivial goal the "Done:" line alone is right. Then STOP (no more tools).',
	'- After you finish, your work is verified automatically: editor diagnostics for the files you changed (plus a verify command, if the user configured one) are checked. If problems are found you will get them back as a follow-up message — fix the ones you introduced, then finish again with "Done:". If a reported problem is clearly pre-existing and unrelated to the goal, do not chase it: note it in one line and finish.'
].join('\n');

const TOOLS = [
	{ name: 'list_files', description: 'List workspace files (optional glob like "**/*.js"). Excludes node_modules/.git/build dirs.', input_schema: { type: 'object', properties: { glob: { type: 'string' } } } },
	{ name: 'read_file', description: 'Read a workspace file (path relative to the workspace root; in a multi-root workspace use the folder-name prefix exactly as list_files shows it).', input_schema: { type: 'object', properties: { path: { type: 'string' }, explanation: { type: 'string', description: 'REQUIRED: 3-8 words, active voice, imperative — WHY you are reading this ("Read the runAgent call site", "Read agent.js tool definitions"). Shown to the user as this action\'s label.' } }, required: ['path', 'explanation'] } },
	{ name: 'search', description: 'Search file contents for a literal string. Returns file:line snippets.', input_schema: { type: 'object', properties: { query: { type: 'string' }, explanation: { type: 'string', description: 'REQUIRED: 3-8 words, active voice, imperative — what you are looking for ("Find every postMessage call site"). Shown to the user as this action\'s label.' } }, required: ['query', 'explanation'] } },
	{ name: 'update_plan', description: 'Declare or update your task checklist for a multi-step goal. Pass the FULL list each time, each item with a status. Call it once up front (all pending), then again to mark an item in_progress when you start it and done when finished. Skip for trivial single-step goals.', input_schema: { type: 'object', properties: { todos: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, status: { type: 'string', enum: ['pending', 'in_progress', 'done'] } }, required: ['title', 'status'] } } }, required: ['todos'] } },
	{ name: 'edit_file', description: 'Make a targeted edit to an EXISTING file: replace an exact, unique snippet (old_str) with new_str. Applied immediately; the user reviews it with Keep/Undo. old_str must appear exactly once — include enough surrounding context to be unique.', input_schema: { type: 'object', properties: { path: { type: 'string' }, old_str: { type: 'string' }, new_str: { type: 'string' } }, required: ['path', 'old_str', 'new_str'] } },
	{ name: 'write_file', description: 'Create a new file (or fully overwrite a short one) with the COMPLETE content. For edits to existing files, prefer edit_file. Applied immediately; the user reviews it with Keep/Undo.', input_schema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } },
	{ name: 'delete_file', description: 'Delete an EXISTING workspace file (e.g. removing a file during a refactor). Applied immediately; the user reviews it with Keep/Undo, and the per-turn checkpoint can restore it. To RENAME or move a file: write_file the new path, then delete_file the old one.', input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
	{ name: 'run_command', description: 'Run a shell command in the workspace root (or a named workspace folder via "folder" in multi-root workspaces). Requires approval. Pass background:true for commands that do not exit on their own (servers, watchers) so the agent is not blocked — it returns immediately and you read progress later with read_command_output.', input_schema: { type: 'object', properties: { command: { type: 'string' }, explanation: { type: 'string', description: 'REQUIRED: 3-8 words, active voice, imperative — what this command does ("Run the extension unit tests", "Find the insertion point in section 10"). Shown to the user as this action\'s label.' }, folder: { type: 'string', description: 'multi-root workspaces only: the workspace folder NAME to run in; defaults to the first folder' }, background: { type: 'boolean', description: 'true = start it and keep working without waiting (dev servers, watchers, tail -f). Returns immediately with an id; poll read_command_output for its output/status.' } }, required: ['command', 'explanation'] } },
	{ name: 'read_command_output', description: 'Read recent output + status of a command started with run_command background:true. Returns a status header ([running on :3000] / [exited 0] / [stopped]) followed by the latest output lines. Poll this to wait for a server to become ready before testing against it.', input_schema: { type: 'object', properties: { id: { type: 'string', description: 'the id returned by a background run_command' }, lines: { type: 'number', description: 'max recent output lines to return (default 80, max 400)' } }, required: ['id'] } },
	{ name: 'ask_user', description: 'Ask the user one or more multiple-choice questions when the goal genuinely depends on a decision only they can make (tech stack, scope, where to put files, must-have features). The user picks by CLICKING — do NOT write questions as prose. Ask ONCE up front with all your questions, then proceed with the answers and never re-ask. Prefer sensible defaults over asking; only ask when a wrong guess would waste real work.', input_schema: { type: 'object', properties: { questions: { type: 'array', items: { type: 'object', properties: { header: { type: 'string', description: 'a 1-3 word tag for the question' }, question: { type: 'string' }, multiSelect: { type: 'boolean', description: 'true if several options can be picked at once' }, options: { type: 'array', items: { type: 'object', properties: { label: { type: 'string' }, description: { type: 'string' } }, required: ['label'] } } }, required: ['question', 'options'] } } }, required: ['questions'] } },
	{ name: 'use_skill', description: 'Load an expert playbook (SKILL.md) for a task type, chosen from the "Available skills" list in your system prompt. Returns the skill\'s step-by-step instructions as the tool result — then follow them. Read-only and instant (no approval). Call it once, early, when the goal matches a skill\'s description.', input_schema: { type: 'object', properties: { name: { type: 'string', description: 'the exact skill name from the Available skills list' } }, required: ['name'] } }
];

// Rough token estimates (chars/4) for the static prompt segments, so the context popover can break
// down "what's filling the window" — system + tools are sent on every request, the rest is messages.
const SYSTEM_TOKENS_EST = Math.round(SYSTEM_BASE.length / 4);

/** Append an "Available skills" name+description menu to the base prompt. Bodies NEVER go here —
 *  progressive disclosure means only name+description are ever in the prompt (~100 words for a dozen). */
function buildSystem(menu) {
	if (!menu || !menu.length) { return SYSTEM_BASE; }
	const list = menu.map((s) => '- ' + s.name + ': ' + s.description).join('\n');
	return SYSTEM_BASE + '\n\nAvailable skills (call use_skill with the name):\n' + list;
}
const TOOLS_TOKENS_EST = Math.round(JSON.stringify(TOOLS).length / 4);

// How much of a background command's accumulated output the sniffers re-read on each chunk. Generous
// next to any single log line, so a url split across chunk boundaries is still found, yet small enough
// that a noisy watcher which never prints an address costs nothing to keep scanning.
const SNIFF_TAIL = 8192;

const FILE_EXCLUDES = '{**/node_modules/**,**/.git/**,**/out/**,**/dist/**,**/.vscode-test/**,**/*.map}';

// ---- ripgrep search (self-contained) ---------------------------------------
function rgPath() {
	const root = vscode.env.appRoot;
	const cands = [
		path.join(root, 'node_modules', '@vscode', 'ripgrep', 'bin', 'rg'),
		path.join(root, 'node_modules', '@vscode', 'ripgrep-universal', 'bin', process.platform + '-' + process.arch, 'rg')
	];
	return cands.find((c) => { try { return fs.existsSync(c); } catch { return false; } }) || null;
}
function rgSearch(term, cwd) {
	return new Promise((resolve) => {
		const bin = rgPath();
		if (!bin || !cwd) { resolve(''); return; }
		const args = ['--line-number', '--no-messages', '--no-config', '-i', '-F', '--max-count', '20', '--max-filesize', '1M', '-g', '!**/node_modules/**', '-g', '!**/.git/**', '-e', term, '.'];
		let out = '';
		try {
			const child = cp.spawn(bin, args, { cwd });
			const t = setTimeout(() => { try { child.kill(); } catch { /* */ } resolve(out.slice(0, 6000)); }, 5000);
			child.stdout.on('data', (d) => { out += d.toString(); });
			child.on('error', () => { clearTimeout(t); resolve(''); });
			child.on('close', () => { clearTimeout(t); resolve(out.slice(0, 6000)); });
		} catch { resolve(''); }
	});
}

// ---- readable line diff ----------------------------------------------------
/** LCS diff of two small line arrays → [{type:'ctx'|'add'|'del', text}]. */
function lcsDiff(a, b) {
	const n = a.length, m = b.length;
	if (n === 0) { return b.map((t) => ({ type: 'add', text: t })); }
	if (m === 0) { return a.map((t) => ({ type: 'del', text: t })); }
	if (n > 500 || m > 500) { return a.map((t) => ({ type: 'del', text: t })).concat(b.map((t) => ({ type: 'add', text: t }))); }
	const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
	for (let i = n - 1; i >= 0; i--) {
		for (let j = m - 1; j >= 0; j--) {
			dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
		}
	}
	const out = [];
	let i = 0, j = 0;
	while (i < n && j < m) {
		if (a[i] === b[j]) { out.push({ type: 'ctx', text: a[i] }); i++; j++; }
		else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ type: 'del', text: a[i] }); i++; }
		else { out.push({ type: 'add', text: b[j] }); j++; }
	}
	while (i < n) { out.push({ type: 'del', text: a[i++] }); }
	while (j < m) { out.push({ type: 'add', text: b[j++] }); }
	return out;
}

/** Diff old/new content with trimmed common prefix/suffix + a little context. Capped. */
function makeDiff(oldStr, newStr) {
	const a = oldStr.length ? oldStr.split('\n') : [];
	const b = newStr.split('\n');
	let p = 0;
	while (p < a.length && p < b.length && a[p] === b[p]) { p++; }
	let s = 0;
	while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) { s++; }
	const aMid = a.slice(p, a.length - s), bMid = b.slice(p, b.length - s);
	const out = [];
	a.slice(Math.max(0, p - 2), p).forEach((t) => out.push({ type: 'ctx', text: t }));
	out.push(...lcsDiff(aMid, bMid));
	a.slice(a.length - s, a.length - s + 2).forEach((t) => out.push({ type: 'ctx', text: t }));
	if (out.length > 200) { return out.slice(0, 200).concat([{ type: 'ctx', text: '… (diff truncated)' }]); }
	return out;
}

// ---- workspace helpers -----------------------------------------------------
// Multi-root aware: helpers read vscode.workspace.workspaceFolders LIVE on every call, so a
// folder added to the workspace mid-session is usable by the very next tool call.
function workspaceFolderList() {
	return (vscode.workspace.workspaceFolders || []).map((f) => ({ name: f.name, root: f.uri.fsPath }));
}
function workspaceRoot() {
	const f = vscode.workspace.workspaceFolders;
	return f && f.length ? f[0].uri.fsPath : null;
}
function safeJoin(root, rel) {
	const pth = path.resolve(root, rel);
	if (pth !== root && !pth.startsWith(root + path.sep)) { return null; }
	return pth;
}
/** Resolve a model-supplied workspace-relative path to an absolute path, multi-root aware.
 *  Accepts VS Code's asRelativePath convention: in a multi-root workspace, paths are prefixed
 *  with the folder NAME ("thin.ly/app/models/link.rb") — which is exactly what list_files
 *  returns to the model. Containment is enforced per matched folder, so the sandbox is the
 *  UNION of the workspace folders (never anything outside them).
 *  mustExist=true (read/edit/delete): first existing candidate wins — folder-name prefix, then
 *  the primary folder, then every other folder. Returns null if nowhere.
 *  mustExist=false (create): the folder-name prefix targets that folder; else the primary. */
function resolveWorkspacePath(rel, opts) {
	const mustExist = !!(opts && opts.mustExist);
	const folders = workspaceFolderList();
	if (!folders.length) { return null; }
	rel = String(rel || '');
	const seg = rel.split(/[\\/]/)[0];
	const named = folders.length > 1 ? folders.find((f) => f.name === seg) : null;
	const namedAbs = named ? safeJoin(named.root, rel.slice(seg.length).replace(/^[\\/]+/, '')) : null;
	const primaryAbs = safeJoin(folders[0].root, rel);
	if (!mustExist) { return namedAbs || primaryAbs; }
	const candidates = [namedAbs, primaryAbs];
	for (const f of folders.slice(1)) { candidates.push(safeJoin(f.root, rel)); }
	for (const c of candidates) { if (c && fs.existsSync(c)) { return c; } }
	return null;
}
/** "file not found" help for the model — names the folders it can address in a multi-root workspace. */
function whereHint() {
	const folders = workspaceFolderList();
	return folders.length > 1 ? ' (workspace folders: ' + folders.map((f) => f.name).join(', ') + ' — prefix the folder name)' : '';
}

/** EOL/BOM-tolerant edit. raw = file content (may have BOM + CRLF); old/new from the model (often LF).
 *  Matches across line-ending differences and preserves the file's EOL; strips the BOM from the
 *  result (VS Code's encoding re-adds it on save). Returns { proposed } or { error }. */
function applyStringEdit(raw, oldStr, newStr) {
	if (!oldStr.trim()) { return { error: 'old_str is empty or only whitespace — include real surrounding code so the match is unambiguous.' }; }
	const eol = raw.includes('\r\n') ? '\r\n' : '\n';
	const toEol = (s) => s.replace(/\r\n/g, '\n').replace(/\n/g, eol);
	const variants = []; const seen = new Set();
	for (const v of [oldStr, toEol(oldStr)]) { if (v && !seen.has(v)) { seen.add(v); variants.push(v); } }
	// Collect ALL distinct match positions across every EOL variant (so mixed-EOL files can't hide a second match).
	const byPos = new Map();
	for (const v of variants) {
		let from = 0, idx;
		while ((idx = raw.indexOf(v, from)) >= 0) { if (!byPos.has(idx)) { byPos.set(idx, v.length); } from = idx + v.length; }
	}
	if (byPos.size === 0) { return { error: 'old_str was not found. Copy the exact text from the file (whitespace matters; line endings are handled automatically).' }; }
	if (byPos.size > 1) { return { error: 'old_str appears more than once; add more surrounding context to make it unique.' }; }
	const idx = byPos.keys().next().value;
	const len = byPos.get(idx);
	const proposed = (raw.slice(0, idx) + toEol(newStr) + raw.slice(idx + len)).replace(/^﻿/, '');
	return { proposed };
}

/**
 * Compact summary of a tool's input for debug logs (truncate long strings).
 *
 * `redact` is for MCP calls (docs/MCP.md G4): those arguments are headed for a third-party server and
 * routinely carry API tokens, record ids, and private query text — and this debug line is POSTED INTO
 * THE CHAT when levelcode.ai.debug is on. Log the shape, never the values.
 */
function inputPreview(input, redact) {
	if (!input || typeof input !== 'object') { return input; }
	const out = {};
	for (const k of Object.keys(input)) {
		const v = input[k];
		if (redact) { out[k] = '‹' + (Array.isArray(v) ? 'array' : typeof v) + '›'; continue; }
		out[k] = typeof v === 'string' ? (v.length > 60 ? v.slice(0, 60) + '…(' + v.length + 'ch)' : v) : v;
	}
	return out;
}

/** Cheap binary sniff — a NUL byte in the first 8KB means it isn't text we should round-trip as UTF-8. */
function isBinaryFile(abs) {
	try { const buf = fs.readFileSync(abs); const n = Math.min(buf.length, 8000); for (let i = 0; i < n; i++) { if (buf[i] === 0) { return true; } } return false; } catch { return false; }
}

// Run a shell command, STREAMING its output: onChunk(text, 'stdout'|'stderr') fires as it runs (live
// terminal in the chat), onExit(code, ms, how) at the end. onStart(child, stop) exposes a stop() that
// kills the whole process GROUP (server + children) — needed because a server is a child of the shell.
// Returns the (capped) full output for the model.
function runCommand(root, command, onChunk, onExit, onStart, timeoutMs) {
	return new Promise((resolve) => {
		let out = '', streamed = 0, settled = false, timedOut = false, stopped = false;
		const STREAM_CAP = 100000;            // max we push to the live terminal view
		const start = Date.now();
		const cap = (s, stream) => {
			out += s;
			if (out.length > 262144) { out = out.slice(-262144); }   // bound the model buffer's memory
			if (onChunk && streamed < STREAM_CAP) {
				const room = STREAM_CAP - streamed;
				const piece = s.length > room ? s.slice(0, room) : s;
				onChunk(piece, stream);
				streamed += piece.length;
				if (streamed >= STREAM_CAP) { onChunk('\n[output truncated in view]', 'stderr'); }
			}
		};
		let child;
		// detached:true → the shell becomes its own process-group leader, so process.kill(-pid) kills the
		// whole tree (the shell AND the server/children it spawned), not just the shell (which orphans the server).
		try { child = cp.spawn(command, { cwd: root, shell: true, detached: true }); }
		catch (e) { if (onExit) { onExit(-1, 0, 'error'); } resolve('ERROR: ' + ((e && e.message) || e)); return; }
		const killGroup = (sig) => { try { if (child.pid) { process.kill(-child.pid, sig); } else { child.kill(sig); } } catch (e) { try { child.kill(sig); } catch (e2) { /* already gone */ } } };
		const stop = () => { if (settled || stopped) { return; } stopped = true; killGroup('SIGTERM'); setTimeout(() => { if (!settled) { killGroup('SIGKILL'); } }, 1500); };
		if (onStart) { onStart(child, stop); }
		if (child.stdout) { child.stdout.on('data', (d) => cap(d.toString(), 'stdout')); }
		if (child.stderr) { child.stderr.on('data', (d) => cap(d.toString(), 'stderr')); }
		const to = (timeoutMs && timeoutMs > 0) ? setTimeout(() => { timedOut = true; killGroup('SIGKILL'); }, timeoutMs) : null;
		const finish = (code) => {
			if (settled) { return; } settled = true;
			if (to) { clearTimeout(to); }
			const ms = Date.now() - start;
			const how = stopped ? 'stopped' : timedOut ? 'timeout' : 'exit';
			const exit = stopped ? 130 : (timedOut ? 124 : (code == null ? -1 : code));
			if (onExit) { onExit(exit, ms, how); }
			const note = stopped ? '\n[stopped by user]' : timedOut ? '\n[timed out]' : (exit !== 0 ? '\n[exit ' + exit + ']' : '');
			resolve((out + note).slice(0, 8000) || '(no output)');
		};
		child.on('close', (code) => finish(code));
		child.on('error', (e) => { cap('\n' + ((e && e.message) || e), 'stderr'); finish(1); });
	});
}

/** Execute one tool call; returns a string result for the model. */
async function runTool(tu, ctx) {
	const root = ctx.root;
	const input = tu.input || {};
	try {
		if (tu.name === 'list_files') {
			ctx.post({ type: 'agentTool', icon: 'list-tree', text: 'list_files ' + (input.glob || '') });
			const uris = await vscode.workspace.findFiles(input.glob || '**/*', FILE_EXCLUDES, 600);
			return uris.map((u) => vscode.workspace.asRelativePath(u)).join('\n') || '(no files)';
		}
		if (tu.name === 'read_file') {
			// label/path ride alongside the legacy `text` so the chat can title this action with the
			// model's own words ("Read the runAgent call site") and still attribute it to a file.
			ctx.post({ type: 'agentTool', icon: 'file', text: 'read ' + input.path, label: input.explanation || '', path: input.path, kind: 'read' });
			const abs = resolveWorkspacePath(input.path || '', { mustExist: true });
			if (!abs) { return 'ERROR: file not found: ' + input.path + whereHint(); }
			if (isBinaryFile(abs)) { return 'ERROR: ' + input.path + ' looks like a binary file — not reading it as text.'; }
			let body = fs.readFileSync(abs, 'utf8').replace(/^﻿/, ''); // drop BOM so old_str matches cleanly
			if (body.length > 100 * 1024) { body = body.slice(0, 100 * 1024) + '\n…(truncated)…'; }
			return body;
		}
		if (tu.name === 'search') {
			ctx.post({ type: 'agentTool', icon: 'search', text: 'search "' + input.query + '"', label: input.explanation || '', kind: 'search' });
			// Multi-root: search EVERY workspace folder, prefixing hits with the folder name so the
			// model can hand the paths straight back to read_file/edit_file.
			const folders = workspaceFolderList();
			let hits = '';
			for (const f of folders) {
				const r = await rgSearch(String(input.query || ''), f.root);
				if (!r) { continue; }
				hits += folders.length > 1
					? r.split('\n').map((ln) => (ln ? f.name + '/' + ln.replace(/^\.\//, '') : ln)).join('\n')
					: r;
			}
			return hits || '(no matches)';
		}
		if (tu.name === 'update_plan') {
			const todos = Array.isArray(input.todos) ? input.todos.slice(0, 20) : [];
			ctx.post({ type: 'plan', todos });
			const done = todos.filter((t) => t && t.status === 'done').length;
			return 'Plan updated (' + done + '/' + todos.length + ' done).';
		}
		if (tu.name === 'edit_file') {
			const abs = resolveWorkspacePath(input.path || '', { mustExist: true });
			if (!abs) { return 'ERROR: file not found: ' + input.path + whereHint() + ' (use write_file to create it)'; }
			if (isBinaryFile(abs)) { return 'ERROR: ' + input.path + ' looks like a binary file — refusing to edit it as text.'; }
			const cur = fs.readFileSync(abs, 'utf8');
			const oldStr = String(input.old_str || '');
			if (!oldStr) { return 'ERROR: old_str is empty.'; }
			const res = applyStringEdit(cur, oldStr, String(input.new_str || ''));
			if (res.error) { return 'ERROR: ' + res.error + ' (' + input.path + ')'; }
			const ok = await ctx.applyEdit({ path: input.path, exists: true, proposed: res.proposed });
			if (!ok) { return 'ERROR: could not apply the edit to ' + input.path + ' (file may be read-only or in conflict).'; }
			ctx.editCount = (ctx.editCount || 0) + 1;
			if (ctx.touched) { ctx.touched.add(abs); }   // this run's edited files → verified afterward
			return 'Applied edit to ' + input.path + ' (the user is reviewing it with Keep/Undo; do not re-edit it).';
		}
		if (tu.name === 'write_file') {
			const abs = resolveWorkspacePath(input.path || '');
			if (!abs) { return 'ERROR: path is outside the workspace' + whereHint(); }
			const existed = fs.existsSync(abs);
			let newStr = String(input.content || '');
			if (existed) {
				if (isBinaryFile(abs)) { return 'ERROR: ' + input.path + ' looks like a binary file — refusing to overwrite it.'; }
				try { if (fs.statSync(abs).size > 100 * 1024) { return 'ERROR: ' + input.path + ' is large (>100KB) and you only saw the first 100KB on read. Use edit_file for targeted changes — a full write_file risks dropping content you did not see.'; } } catch { /* */ }
				const raw = fs.readFileSync(abs, 'utf8'); const eol = raw.includes('\r\n') ? '\r\n' : '\n'; newStr = newStr.replace(/\r\n/g, '\n').replace(/\n/g, eol);
			}
			const ok = await ctx.applyEdit({ path: input.path, exists: existed, proposed: newStr });
			if (!ok) { return 'ERROR: could not write ' + input.path + ' (path may be read-only or in conflict).'; }
			ctx.editCount = (ctx.editCount || 0) + 1;
			if (ctx.touched) { ctx.touched.add(abs); }   // this run's edited files → verified afterward
			return 'Applied edit to ' + input.path + ' (pending the user\'s Keep/Undo review).';
		}
		if (tu.name === 'delete_file') {
			const abs = resolveWorkspacePath(input.path || '', { mustExist: true });
			if (!abs) { return 'ERROR: file not found: ' + input.path + whereHint(); }
			try { if (fs.statSync(abs).isDirectory()) { return 'ERROR: ' + input.path + ' is a directory — delete_file removes a single file.'; } } catch { /* */ }
			// Deletion is in the autopilot danger set — ask even when autopilot runs everything else silently.
			// (In manual mode nothing gates here: the edit is applied and reviewed with Keep/Undo as before.)
			if (ctx.autopilot && typeof ctx.approve === 'function') {
				const okDel = await ctx.approve({ kind: 'delete', path: input.path, danger: dangerLabel('deletion') });
				if (!okDel) { return 'User skipped deleting ' + input.path + '. Do not retry it.'; }
			}
			const ok = ctx.applyDelete ? await ctx.applyDelete({ path: input.path }) : false;
			if (!ok) { return 'ERROR: could not delete ' + input.path + '.'; }
			ctx.editCount = (ctx.editCount || 0) + 1;
			if (ctx.touched) { ctx.touched.delete(abs); }   // it's gone — don't verify a deleted file
			return 'Deleted ' + input.path + ' (pending the user\'s Keep/Undo review; the per-turn checkpoint can also restore it).';
		}
		if (tu.name === 'run_command') {
			const cmd = String(input.command || '');
			const bg = input.background === true;
			// Multi-root: optional input.folder picks WHICH workspace folder the command runs in.
			let cwdRoot = root;
			if (input.folder) {
				const wf = workspaceFolderList().find((w) => w.name === String(input.folder));
				if (!wf) { return 'ERROR: no workspace folder named "' + input.folder + '"' + whereHint(); }
				cwdRoot = wf.root;
			}
			// Autopilot runs commands without asking — EXCEPT the danger set (deletion, sudo, force-push,
			// remote|shell, publish, system writes), which always asks. Manual mode asks for everything.
			const danger = ctx.autopilot ? classifyCommand(cmd) : { dangerous: true, category: null };
			const approved = danger.dangerous
				? await ctx.approve({ kind: 'command', command: cmd, explanation: input.explanation || '', danger: danger.category ? dangerLabel(danger.category) : null })
				: true;
			if (!approved) { return 'User skipped this command. Do not retry it.'; }
			const runId = tu.id || ('run-' + Date.now());
			ctx.post({ type: 'termRun', id: runId, command: cmd, cwd: path.basename(cwdRoot) || 'workspace', background: bg, explanation: input.explanation || '' });
			const stops = ctx.commandStops;   // shared registry so the Stop button / ■ can kill the process group
			// Only BACKGROUND commands get a registry entry (read_command_output reads it). Foreground
			// one-shots keep their old behavior + don't accumulate — the model already gets their output.
			const entry = bg ? { command: cmd, status: 'running', code: null, how: null, port: null, ready: false, previewUrl: null, ring: '', totalBytes: 0, lastReadOffset: 0, startedAt: Date.now() } : null;
			if (entry && ctx.commandRuns) { ctx.commandRuns.set(runId, entry); }
			const onChunk = (chunk, stream) => {
				ctx.post({ type: 'termOutput', id: runId, chunk: chunk, stream: stream });
				if (entry) {
					entry.ring = (entry.ring + chunk).slice(-100000);   // bounded tail for read_command_output
					entry.totalBytes += chunk.length;
					// Sniff the accumulated TAIL, never the raw chunk: stdout arrives in arbitrary slices, so
					// a line can straddle a boundary ("http://local" + "host:5173/") and match neither half.
					// A few KB is far more than any single line needs, and bounding it keeps the rescan cheap
					// for a chatty server that never prints an address at all. (Applies to all three sniffs —
					// port and ready had the same latent gap.)
					const tail = entry.ring.slice(-SNIFF_TAIL);
					if (!entry.port) { const p = sniffPort(tail); if (p) { entry.port = p; ctx.post({ type: 'bgTask', id: runId, port: p }); } }
					if (!entry.ready && looksReady(tail)) { entry.ready = true; ctx.post({ type: 'bgTask', id: runId, ready: true }); }
					// Auto-preview: the moment a background command advertises a LOCAL address, offer to show
					// it in the built-in browser. Fired at most ONCE per run — if the user closes the tab we
					// must not reopen it on the next log line, and a restart-on-save server would otherwise
					// spawn a tab per reload. The host decides whether to honour it (setting + dedupe).
					if (!entry.previewUrl && typeof ctx.openPreview === 'function') {
						const url = sniffPreviewUrl(tail);
						if (url) {
							entry.previewUrl = url;
							dbg('preview.detected', { id: runId, url: url });
							// Never let a preview reject inside a live stream handler — showing a browser tab
							// must not be able to disturb a running command's output.
							Promise.resolve(ctx.openPreview(url)).catch((e) => dbg('preview.rejected', { id: runId, error: String((e && e.message) || e) }));
						}
					}
				}
			};
			const onExit = (code, ms, how) => {
				if (stops) { stops.delete(runId); }
				if (entry) { entry.status = how === 'exit' ? 'exited' : how; entry.code = code; entry.how = how; ctx.post({ type: 'bgTask', id: runId, status: entry.status, code: code, done: true }); }   // exited | stopped | timeout — drop from tray
				ctx.post({ type: 'termExit', id: runId, code: code, ms: ms, how: how });
			};
			const onStart = (child, stop) => { if (stops) { stops.set(runId, stop); } };
			if (bg) {
				// Fire-and-forget: keep streaming + tracking, but return NOW so the agent loop isn't blocked.
				// No timeout — a background server is meant to run long (Stop / New Chat reap it).
				ctx.post({ type: 'bgTask', id: runId, command: cmd, status: 'running' });   // add to the Background tasks tray
				(async () => { try { await runCommand(cwdRoot, cmd, onChunk, onExit, onStart, 0); } catch (e) { entry.status = 'error'; entry.how = 'error'; ctx.post({ type: 'bgTask', id: runId, status: 'error', done: true }); dbg('bg.error', { id: runId, msg: String((e && e.message) || e) }); } })();
				return 'Started in the background as id "' + runId + '" — it keeps running while you continue. Use read_command_output with this id to watch its output; wait for a readiness/port line before testing against it. Do not start it again.';
			}
			return await runCommand(cwdRoot, cmd, onChunk, onExit, onStart, ctx.commandTimeout);
		}
		if (tu.name === 'read_command_output') {
			const runs = ctx.commandRuns;
			const id = String(input.id || '');
			const entry = runs && runs.get(id);
			if (!entry) { return 'ERROR: no command with id "' + id + '" (it may never have started, or was cleared by New Chat). Start it with run_command background:true first.'; }
			const lines = Math.min(400, Math.max(1, Number(input.lines) || 80));
			const statusStr = entry.status === 'running'
				? ('running' + (entry.port ? ' on :' + entry.port : entry.ready ? ' (ready)' : ''))
				: entry.status === 'exited' ? ('exited ' + entry.code)
					: entry.status;   // stopped | timeout | error
			ctx.post({ type: 'agentTool', icon: 'terminal', text: 'read output of ' + id + ' [' + statusStr + ']' });
			const head = '[' + statusStr + '] ' + entry.command;
			if (!entry.ring) { return head + '\n(no output yet)'; }
			const noNew = entry.totalBytes <= entry.lastReadOffset;
			entry.lastReadOffset = entry.totalBytes;
			const tail = entry.ring.split('\n').slice(-lines).join('\n');
			return head + '\n' + (noNew ? '(no new output since your last read)\n' + tail : tail);
		}
		if (tu.name === 'ask_user') {
			const questions = Array.isArray(input.questions) ? input.questions : [];
			if (!questions.length) { return 'ERROR: ask_user needs a non-empty "questions" array.'; }
			if (typeof ctx.ask !== 'function') { return 'ERROR: interactive questions are unavailable here. Choose sensible defaults and proceed.'; }
			const res = await ctx.ask({ questions });
			if (!res || !res.answers) { return 'The user dismissed the questions without answering. Pick sensible defaults and proceed; only ask again if truly essential.'; }
			const lines = res.answers.map((a) => {
				const sel = (a.selected && a.selected.length) ? a.selected.join(', ') : '(no selection)';
				return '- ' + (a.header ? a.header + ' — ' : '') + (a.question || '') + ' → ' + sel;
			});
			if (res.notes) { lines.push('- Additional notes from the user: ' + res.notes); }
			return 'The user answered your questions (these are their recorded decisions — honor them and do NOT ask again):\n' + lines.join('\n') + '\n\nProceed with the work using these answers.';
		}
		if (tu.name === 'use_skill') {
			const name = String(input.name || '').trim();
			if (!ctx.skills) { return 'ERROR: skills are not available in this session. Proceed without one.'; }
			const body = ctx.skills.getBody(name);
			if (body == null) {
				const avail = ctx.skills.menu().map((s) => s.name).join(', ') || '(none)';
				return 'ERROR: no skill named "' + name + '". Available skills: ' + avail + '. Pick one exactly, or proceed without a skill.';
			}
			ctx.post({ type: 'agentTool', icon: 'sparkle', text: '🧩 using skill: ' + name });   // quiet chip — only on success (🧩 is the marker; 'sparkle' falls back cleanly)
			return body;                                                                       // SKILL.md body → tool_result, steers the next turns
		}
		// MCP tools (docs/MCP.md S3). An MCP name matches none of the built-in branches above, so every
		// MCP call necessarily arrives HERE — which is why the router is one block at one line rather
		// than a dispatch scattered through runTool.
		const route = ctx.mcpRoutes && ctx.mcpRoutes.get(tu.name);
		if (route) {
			const verdict = classifyMcpTool(tu.name, ctx.mcp && ctx.mcp.toolPolicy, route.annotations);
			const server = getServer(route.server);
			if (!server || !server.alive) { return 'ERROR: the MCP server "' + route.server + '" is not running.'; }
			// S4: a call the user hasn't allow-listed is now PROMPTED, not refused. Autopilot does not relax
			// this (G3) — an MCP tool is third-party code — and a server-marked-destructive tool prompts even
			// when allow-listed (classifyMcpTool tightens on it). Only 'allow' skips the card.
			if (verdict.approve !== 'allow') {
				if (typeof ctx.approve !== 'function') {
					// No webview to ask through (headless / a test harness) — fall back to S3's safe refusal
					// rather than run third-party code with no way to say no.
					ctx.post({ type: 'agentTool', icon: 'shield', text: '🔌 mcp · refused ' + tu.name + ' — ' + verdict.reason });
					return explainMcpRefusal(tu.name, verdict);
				}
				const call = describeMcpCall(tu.name, input, route);
				const approved = await ctx.approve({
					kind: 'mcp', name: tu.name, server: call.server, tool: call.tool,
					args: call.argsText, destructive: call.destructive, canAllowAlways: call.canAllowAlways
				});
				if (!approved) {
					ctx.post({ type: 'agentTool', icon: 'shield', text: '🔌 mcp · skipped ' + tu.name });
					return 'User declined to run the MCP tool "' + tu.name + '". Do NOT retry it in this run — '
						+ 'continue without it, or tell the user what you needed it for.';
				}
			}
			ctx.post({ type: 'agentTool', icon: 'sparkle', text: '🔌 ' + route.server + ' · ' + route.tool });
			return await server.call(route.tool, input);   // never throws — failures come back as `ERROR: …`
		}
		return 'ERROR: unknown tool ' + tu.name;
	} catch (e) {
		return 'ERROR: ' + ((e && e.message) || e);
	}
}

/**
 * Run the agent loop until the model stops calling tools (or the step cap / abort).
 * `ctx.messages` is the persistent session transcript — already seeded with the new user goal —
 * and is appended to in place, so subsequent runs remember this one.
 * @param {{messages:any[], providerId:string, apiKey:string, baseURL?:string, model:string, maxSteps:number,
 *          post:(m:any)=>void, approve:(req:any)=>Promise<boolean>,
 *          applyEdit:(req:any)=>Promise<boolean>, signal:AbortSignal}} ctx
 *   providerId/baseURL select the model provider (Anthropic native, or any OpenAI-shaped one via the
 *   tool-use translation layer); applyEdit applies file edits (apply-then-review); approve gates run_command only.
 */
// A gateway 401 (expired LevelCode access token) surfaces as "<provider> API 401: …" or the raw
// "Signature has expired". Used to trigger ONE token-refresh + retry inside the agent loop (mirrors
// the chat path's refresh-on-401 — see extension.js isAuthError).
function isAgentAuthError(e) {
	return /\bAPI 401\b|signature has expired/i.test(String((e && e.message) || e));
}

/**
 * Connect the user's MCP servers and turn their tools into this run's extra TOOLS entries (docs/MCP.md
 * S3). Returns `{tools, routes}` — empty when MCP is unconfigured, which is the overwhelming common case
 * and must cost nothing.
 *
 * TRUST: only `source:'settings'` servers are started. A `.levelcode/mcp.json` is REPO-authored — i.e.
 * attacker-controlled for any repo you clone — and a server entry names a process to spawn, so starting
 * one here would make this slice exactly the RCE-on-clone hole that the S4 launch gate exists to close.
 * They are reported, not silently skipped, so the gap looks like a missing feature rather than a bug.
 *
 * Never throws: MCP is an enhancement, and no server misconfiguration may take down an agent run.
 */
/**
 * G1 launch gate for ONE repo-authored server. Returns true if it may be spawned.
 *
 * Trust is per workspace and keyed on the fingerprint of what would run, so a repo that was approved
 * once cannot later swap the command, args, or env under the same server name — that reads as a new
 * server and asks again.
 *
 * Fails CLOSED. With no webview there is nobody to ask, so the server does not start; a headless or
 * test context must never be the path that spawns a repo's process silently.
 */
async function approveMcpLaunch(ctx, server, dbg) {
	const store = (ctx.mcp && ctx.mcp.launchTrust) || {};
	if (isLaunchTrusted(server, store)) {
		dbg('mcp.launch.trusted', { server: server.name });
		return true;
	}

	const card = describeMcpLaunch(server);
	if (typeof ctx.approve !== 'function') {
		dbg('mcp.launch.nonInteractive', { server: server.name });
		ctx.post({ type: 'agentTool', icon: 'shield', text: '🔌 mcp · "' + server.name + '" not started — repo-defined servers need approval, and there is no prompt in this context' });
		return false;
	}

	dbg('mcp.launch.prompt', { server: server.name, fingerprint: card.fingerprint });
	const approved = await ctx.approve({
		kind: 'mcpLaunch',
		server: card.server,
		origin: card.origin,
		commandLine: card.commandLine,
		envLines: card.envLines
	});

	if (!approved) {
		dbg('mcp.launch.declined', { server: server.name });
		ctx.post({ type: 'agentTool', icon: 'shield', text: '🔌 mcp · "' + server.name + '" not started (declined)' });
		return false;
	}

	// Remembered only on approval, and only for this workspace. Best-effort: failing to persist means
	// the user is asked again next run, which is the safe direction to fail.
	if (typeof ctx.rememberMcpTrust === 'function') {
		try { await ctx.rememberMcpTrust(rememberLaunchTrust(server, store)); } catch (e) {
			dbg('mcp.launch.rememberFailed', { server: server.name, error: String((e && e.message) || e) });
		}
	}
	ctx.post({ type: 'agentTool', icon: 'check', text: '🔌 mcp · trusted "' + server.name + '" for this workspace' });
	return true;
}

async function setupMcp(ctx, wsFolders, dbg) {
	const empty = { tools: [], routes: null };
	const cfg = ctx.mcp || {};
	try {
		const { servers, problems } = loadServerConfig({
			settings: cfg.servers,
			folders: wsFolders,
			readFile: (abs) => { try { return fs.readFileSync(abs, 'utf8'); } catch { return null; } }
		});
		for (const p of problems) { dbg('mcp.config', p); }
		if (!servers.length) { return empty; }

		// G1. Settings servers start unprompted — the user typed them. Repo-authored ones go through
		// trust-on-first-use, per server, per workspace, keyed on what they would actually spawn.
		const trusted = servers.filter((s) => s.source === 'settings');
		for (const s of servers.filter((s) => s.source !== 'settings')) {
			const ok = await approveMcpLaunch(ctx, s, dbg);
			if (ok) { trusted.push(s); }
		}
		if (!trusted.length) { return empty; }

		// Connecting is up-front work: the tool list must be complete before turn one, so there is no
		// lazy option. Only the FIRST run of a session pays it — mcpClient keeps handles in a module
		// registry, and connectAll reuses a live one.
		ctx.post({ type: 'agentStatus', text: 'starting MCP servers…' });
		const { handles, problems: connectProblems } = await connectAll(trusted, { cwd: ctx.root });
		for (const p of connectProblems) {
			dbg('mcp.connect', p);
			ctx.post({ type: 'agentTool', icon: 'warning', text: '🔌 mcp · "' + p.server + '" failed to start — ' + p.message });
		}
		if (!handles.length) { return empty; }

		const built = buildAgentTools(handles.map((h) => ({ name: h.name, tools: h.tools })));
		for (const p of built.problems) {
			dbg('mcp.tools', p);
			ctx.post({ type: 'agentTool', icon: 'warning', text: '🔌 mcp · ' + p.message });
		}
		if (!built.tools.length) { return empty; }

		// Show the allow-listed count up front: with no policy set it reads "0/12 allow-listed", which is
		// what makes a later refusal legible instead of looking broken. Pass the SAME annotations runTool
		// will (PR #31 review) — otherwise a destructive-but-allow-listed tool is counted here yet refused
		// there, and the chip lies. The route always exists for a built tool; guard defensively anyway.
		const allowed = built.tools.filter((t) => {
			const route = built.routes.get(t.name);
			return classifyMcpTool(t.name, cfg.toolPolicy, route && route.annotations).approve === 'allow';
		}).length;
		// Per-server counts come from what was actually EXPOSED (built.routes), not the raw tools/list
		// length — a server capped at MAX_TOOLS_PER_SERVER or listing junk exposes fewer than it
		// advertised, and showing the raw number would contradict the allowed/total denominator below
		// (PR #31 review). A server that exposed nothing still shows "(0)": honest, and a useful signal.
		const perServer = toolCountsByServer(built.routes);
		const summary = handles.map((h) => h.name + ' (' + (perServer.get(h.name) || 0) + ')').join(', ');
		dbg('mcp.ready', { servers: handles.map((h) => h.name), tools: built.tools.length, allowed });
		ctx.post({ type: 'agentTool', icon: 'sparkle', text: '🔌 mcp · ' + summary + ' · ' + allowed + '/' + built.tools.length + ' allow-listed' });
		return built;
	} catch (e) {
		dbg('mcp.failed', { error: (e && e.message) || String(e) });
		ctx.post({ type: 'agentTool', icon: 'warning', text: '🔌 mcp · setup failed — ' + ((e && e.message) || e) });
		return empty;
	}
}

async function runAgent(ctx) {
	const root = workspaceRoot();
	if (!root) { ctx.post({ type: 'agentError', message: 'Open a folder first — the agent works on your workspace.' }); ctx.post({ type: 'agentDone', reason: 'error' }); return; }
	ctx.root = root;
	// M6.5 implicit skills: build the system prompt ONCE per run — append the tiny name+description menu.
	// Multi-root: name every workspace folder so the model addresses them by prefix from turn one.
	const wsFolders = workspaceFolderList();
	const multiRootNote = wsFolders.length > 1
		? '\n\nWorkspace folders (multi-root — prefix paths with the folder name): ' + wsFolders.map((f) => f.name).join(', ') + '. The first folder ("' + wsFolders[0].name + '") is the default for unprefixed paths and run_command.'
		: '';
	// Autopilot: act decisively and self-verify rather than pausing. Commands run without approval (the
	// host still gates the danger set — deletion, sudo, force-push, remote|shell, publish, system writes),
	// so the model should lean on verification, not on asking, when it's unsure.
	const autopilotNote = ctx.autopilot
		? '\n\nAUTOPILOT IS ON. Work end-to-end without pausing for confirmation. Your run_command calls execute immediately (only irreversible ones — deleting files, sudo, force-push, piping a remote script to a shell, publishing — still ask the user). Do NOT call ask_user for anything you can reasonably decide; pick a sensible default and proceed. When you are unsure whether a change is correct, do not stop to ask — verify it: run the build/tests/linters via run_command and read editor diagnostics, then fix and re-verify until clean, and only then move on. Prefer doing and checking over asking.'
		: '';
	// Project rules: fold a repo's own AGENTS.md (or CLAUDE.md / .cursorrules) into the cached system
	// block so the agent follows the project's conventions from turn one. Read once per run — an edit is
	// picked up on the next run.
	const rules = loadProjectRules(wsFolders, (abs) => { try { return fs.readFileSync(abs, 'utf8'); } catch { return null; } });
	const system = (ctx.skills ? buildSystem(ctx.skills.menu()) : SYSTEM_BASE) + multiRootNote + autopilotNote + rules.text;
	const systemTokensEst = Math.round(system.length / 4);

	const dbg = ctx.dbg || (() => {});
	if (rules.sources.length) {
		dbg('projectRules.loaded', { sources: rules.sources });
		// Quiet timeline chip at the top of the run so the user can see their repo rules are in effect
		// (mirrors the skill chip). Reuses the agentTool → addAgentLine rendering — no webview change.
		ctx.post({ type: 'agentTool', icon: 'file', text: '📋 project rules · ' + rules.sources.join(', ') });
	}

	// MCP (docs/MCP.md S3): the tool list becomes PER-RUN. It was a module constant only because it was
	// the same every time; a run's servers are whatever is configured and reachable right now. Same shape
	// as `system`/`systemTokensEst` two lines up — built once per run, then used for every turn.
	const mcp = await setupMcp(ctx, wsFolders, dbg);
	ctx.mcpRoutes = mcp.routes;                                        // runTool's router reads this
	const tools = mcp.tools.length ? TOOLS.concat(mcp.tools) : TOOLS;
	// Recomputed only when MCP actually contributed tools, so the no-MCP path keeps the module constant
	// and pays nothing for a feature it isn't using.
	const toolsTokensEst = mcp.tools.length ? Math.round(JSON.stringify(tools).length / 4) : TOOLS_TOKENS_EST;

	const messages = ctx.messages;
	let step = 0;
	let reason = 'done';
	let nudges = 0;
	// Bound worst-case token spend across max_tokens continuation turns. Each continuation is another
	// full API call whose input grows with the (never-truncated) transcript, so an adversarial or
	// runaway model that keeps hitting the cap could otherwise rack up unbounded, user-billed calls.
	// Budget = a generous multiple of the per-turn cap; once exceeded we stop continuing and hand back.
	const perTurnMax = Math.max(1024, Math.min(32768, ctx.maxTokens || 8192));
	const OUTPUT_TOKEN_BUDGET = perTurnMax * 8;
	let cumulativeOutputTokens = 0;
	// [LevelCode] Gateway turns report real money: this run's cost + the wallet balance, both RETAIL
	// micro-$ (what the customer paid). BYOK turns never report them and these stay 0/null.
	let runCostMicros = 0;

	// --- M5 auto-verify loop ------------------------------------------------
	// When the model wants to finish AND it edited files this run, check its work before handing back:
	// run the configured verify command (one-shot — typecheck/lint/test) + pull editor diagnostics for
	// the touched files, then if anything failed feed it back so the agent self-corrects. Bounded by
	// verify.maxRounds (re-entries) AND maxSteps; respects abort. A failing verify never blocks the user —
	// after the budget it hands the remaining problems over honestly.
	let feedbackUsed = 0, verifySeq = 0;
	async function runVerifyOnce() {
		const id = 'verify-' + (++verifySeq);
		const cmd = ((ctx.verify && ctx.verify.command) || '').trim();
		ctx.post({ type: 'verifyRun', id, command: cmd });
		let ran = false, exitCode = 0, cmdTail = '';
		if (cmd) {
			ran = true;
			cmdTail = await runCommand(root, cmd,
				(chunk, stream) => ctx.post({ type: 'verifyOutput', id, chunk, stream }),
				(code) => { if (ctx.commandStops) { ctx.commandStops.delete(id); } exitCode = (code == null ? -1 : code); },
				(child, stop) => { if (ctx.commandStops) { ctx.commandStops.set(id, stop); } },
				ctx.commandTimeout);
		}
		// A command that couldn't even start (missing npm script / command-not-found) is a CONFIG problem,
		// not the agent's code — flag it as unrunnable so we warn the user instead of looping the agent on it.
		const unrunnable = ran && looksUnrunnable(exitCode, cmdTail);
		const cmdProblem = ran && exitCode !== 0 && !unrunnable;
		let diag = { text: '', count: 0 };
		if (ctx.getNewDiagnostics) { try { diag = await ctx.getNewDiagnostics(); } catch (e) { dbg('verify.diagErr', { msg: String((e && e.message) || e) }); } }
		return { id, ok: !cmdProblem && diag.count === 0, cmdProblem, unrunnable, cmdTail, diag };
	}
	/** Returns true if the loop should CONTINUE (verification failed, fix-feedback pushed). */
	async function attemptVerify() {
		const v = ctx.verify;
		if (!v || !v.enabled) { return false; }
		if (ctx.signal.aborted) { return false; }
		if (!(ctx.editCount > 0)) { return false; }                       // no edits this run → nothing to verify
		const cmd = (v.command || '').trim();
		const touchedCount = ctx.getTouchedUris ? ctx.getTouchedUris().length : 0;
		if (!cmd && !touchedCount) { return false; }                      // nothing to check
		const max = Math.max(0, v.maxRounds || 0);
		ctx.post({ type: 'agentStatus', text: 'verifying edits…' });
		const r = await runVerifyOnce();
		if (ctx.signal.aborted) { return false; }
		const outcome = verifyOutcome(r.ok, feedbackUsed, max);
		ctx.post({ type: 'verifyDone', id: r.id, ok: r.ok, exhausted: outcome === 'exhausted', errorCount: r.diag.count, cmdFail: r.cmdProblem, unrunnable: r.unrunnable, hadCommand: !!cmd });
		if (r.unrunnable) {
			// The verify command itself is misconfigured — tell the user, never make the agent "fix" it.
			dbg('verify.unrunnable', { tail: String(r.cmdTail || '').slice(0, 160) });
			ctx.post({ type: 'agentTool', icon: 'warning', text: 'verify command couldn’t run — check the levelcode.ai.verify.command setting' });
		}
		if (outcome === 'pass') { dbg('verify.pass', { cmd: !!cmd, touched: touchedCount, unrunnable: r.unrunnable }); return false; }
		if (outcome === 'exhausted') {
			dbg('verify.exhausted', { errors: r.diag.count, cmdFail: r.cmdProblem });
			ctx.post({ type: 'agentTool', icon: 'warning', text: 'verification still failing — left for your review' });
			return false;
		}
		feedbackUsed++;
		dbg('verify.fail', { round: feedbackUsed, errors: r.diag.count, cmdFail: r.cmdProblem });
		messages.push({ role: 'user', content: formatVerifyFeedback({ cmdFail: r.cmdProblem, cmdTail: r.cmdTail, diag: r.diag }, feedbackUsed, max, cmd) });
		return true;
	}

	try {
		while (step++ < ctx.maxSteps) {
			if (ctx.signal.aborted) { reason = 'stopped'; break; }
			ctx.post({ type: 'agentStatus', text: 'thinking…' });
			dbg('turn.request', { step, transcriptMsgs: messages.length });
			let streamed = false;
			let textChars = 0;
			const turnOpts = {
				providerId: ctx.providerId, baseURL: ctx.baseURL, label: ctx.label,
				apiKey: ctx.apiKey, model: ctx.model, maxTokens: perTurnMax, system: system,
				messages, tools: tools, signal: ctx.signal,
				onText: (t) => { streamed = true; textChars += t.length; ctx.post({ type: 'agentDelta', text: t }); },
				onToolStart: (name) => {
					dbg('tool.start', { name });
					const verb = name === 'edit_file' || name === 'write_file' ? 'preparing edit (' + name + ')…'
						: name === 'delete_file' ? 'deleting a file…'
						: name === 'run_command' ? 'preparing command…' : name === 'update_plan' ? 'planning…' : 'running ' + name + '…';
					ctx.post({ type: 'agentStatus', text: verb });
				},
				// A transient upstream 5xx (502/503/504) is retried once before it can fail the run — surface it
				// as a status rather than a mystery pause, and log it. Nothing has streamed yet when this fires.
				onRetry: (info) => { dbg('turn.retry', info); ctx.post({ type: 'agentStatus', text: 'upstream busy (' + info.status + ') — retrying…' }); }
			};
			let turn;
			try {
				turn = await providers.streamAgentTurn(turnOpts);
			} catch (e) {
				// LevelCode Cloud access token expired mid-run → refresh once and retry THIS turn. A 401 is
				// rejected upfront, so we only retry when nothing has streamed yet (a mid-stream failure
				// would otherwise duplicate output). BYOK / no refresh hook / refresh returned null → rethrow.
				if (!streamed && isAgentAuthError(e) && typeof ctx.refreshAuth === 'function') {
					const fresh = await ctx.refreshAuth();
					if (!fresh) { throw e; }
					dbg('turn.authRetry', { step });
					ctx.apiKey = fresh;
					turnOpts.apiKey = fresh;
					turn = await providers.streamAgentTurn(turnOpts);
				} else {
					throw e;
				}
			}
			if (streamed) { ctx.post({ type: 'agentTurnEnd' }); }
			dbg('turn.response', { step, stop: turn.stop_reason, blocks: turn.content.length, textChars, tools: turn.content.filter((c) => c.type === 'tool_use').map((c) => c.name + (turn.malformed && turn.malformed.has(c.id) ? '!malformed' : '')) });
			// Report real context usage (input_tokens = how full the transcript is) so the UI can meter + warn.
			if (turn.usage) {
				cumulativeOutputTokens += (turn.usage.output_tokens || 0);
				// [LevelCode] The Cloud gateway's credits frame (retail micro-$): accumulate what the RUN
				// cost and keep the latest remaining balance for the response bar.
				if (turn.usage.cost_micros != null) { runCostMicros += turn.usage.cost_micros; }
				if (turn.usage.credits_remaining_micros != null) { ctx.credits = turn.usage.credits_remaining_micros; }
				dbg('usage', { input: turn.usage.input_tokens, output: turn.usage.output_tokens, cacheRead: turn.usage.cache_read_input_tokens, cumulativeOutput: cumulativeOutputTokens, costMicros: turn.usage.cost_micros, creditsLeftMicros: turn.usage.credits_remaining_micros });
				ctx.post({ type: 'contextUsage', input: (turn.usage.input_tokens || 0) + (turn.usage.cache_read_input_tokens || 0) + (turn.usage.cache_creation_input_tokens || 0), output: turn.usage.output_tokens || 0, limit: ctx.contextLimit || 200000, model: ctx.model, system: systemTokensEst, tools: toolsTokensEst, cacheRead: turn.usage.cache_read_input_tokens || 0, cacheWrite: turn.usage.cache_creation_input_tokens || 0 });
			}

			// Reasoning models (e.g. Kimi K2.7 Code) emit <think>…</think> inline in the text
			// block. Strip it from the STORED turn so the reasoning isn't re-sent — and
			// re-metered on the gateway — on every later turn. (The chat view hides it too.)
			for (const c of turn.content) {
				if (c.type === 'text' && typeof c.text === 'string') {
					let t = c.text.replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, '');   // completed pairs
					const close = t.match(/<\/think\s*>/i);                            // dangling closer (implicit open)
					if (close) { t = t.slice(close.index + close[0].length); }
					c.text = t.replace(/^\s+/, '');
				}
			}

			// Guard: never push an empty assistant message — Anthropic 400s on content:[] (e.g. a
			// turn cut off before any output). Substitute a placeholder and recover or stop.
			const hasReal = turn.content.some((c) => (c.type === 'text' && c.text.trim()) || c.type === 'tool_use');
			if (!hasReal) {
				messages.push({ role: 'assistant', content: [{ type: 'text', text: '(no output)' }] });
				if (turn.stop_reason === 'max_tokens' && nudges++ < 3) {
					ctx.post({ type: 'agentTool', icon: 'warning', text: 'cut off with no content — retrying smaller' });
					messages.push({ role: 'user', content: 'Your last turn produced no usable output (cut off). Take a smaller step and continue.' });
					continue;
				}
				reason = (turn.stop_reason === 'max_tokens') ? 'limit' : 'done';
				break;
			}
			messages.push({ role: 'assistant', content: turn.content });

			const toolUses = turn.content.filter((c) => c.type === 'tool_use');
			if (toolUses.length) {
				// CRITICAL: every tool_use MUST get a matching tool_result, even on abort, or the
				// next API call 400s ("tool_use ids were found without tool_result blocks").
				const results = [];
				let cancelled = false;
				for (const tu of toolUses) {
					if (cancelled || ctx.signal.aborted) { cancelled = true; dbg('tool.cancelled', { name: tu.name }); results.push({ type: 'tool_result', tool_use_id: tu.id, content: 'Cancelled by the user.' }); continue; }
					if (turn.malformed && turn.malformed.has(tu.id)) { dbg('tool.malformed', { name: tu.name }); results.push({ type: 'tool_result', tool_use_id: tu.id, content: 'ERROR: your tool arguments were cut off (truncated JSON). Retry with smaller input — for edits use edit_file with a short snippet.' }); continue; }
					dbg('tool.call', { name: tu.name, input: inputPreview(tu.input, !!(ctx.mcpRoutes && ctx.mcpRoutes.has(tu.name))) });
					const out = await runTool(tu, ctx);
					dbg('tool.result', { name: tu.name, chars: String(out).length, error: String(out).startsWith('ERROR') });
					results.push({ type: 'tool_result', tool_use_id: tu.id, content: String(out) });
				}
				// max_tokens can co-occur with a (possibly truncated) tool_use — surface it here too.
				if (turn.stop_reason === 'max_tokens') {
					ctx.post({ type: 'agentTool', icon: 'warning', text: 'response was cut off — making smaller edits' });
					results.push({ type: 'text', text: 'Your previous turn was cut off (length limit). Make smaller, targeted edits (edit_file with short snippets); avoid huge tool inputs.' });
				}
				messages.push({ role: 'user', content: results });
				if (cancelled || ctx.signal.aborted) { reason = 'stopped'; break; }
				if (turn.stop_reason === 'max_tokens' && nudges++ >= 3) { reason = 'limit'; break; }
				if (turn.stop_reason !== 'max_tokens') { nudges = 0; }
				continue;
			}

			// No tool calls this turn.
			const text = turn.content.filter((c) => c.type === 'text').map((c) => c.text).join('');
			if (turn.stop_reason === 'max_tokens') {
				// The turn was pure prose cut off at the token cap. Ask the model to CONTINUE exactly where it
				// left off (not switch strategies) so the full answer streams out across turns instead of being
				// truncated. The already-streamed text stays; the continuation is appended seamlessly.
				// Guard: bail out of the continuation loop once cumulative output blows the budget, so a
				// model that keeps hitting the cap can't run up unbounded, user-billed API calls.
				if (cumulativeOutputTokens >= OUTPUT_TOKEN_BUDGET) {
					dbg('continue.budgetExceeded', { cumulativeOutput: cumulativeOutputTokens, budget: OUTPUT_TOKEN_BUDGET });
					ctx.post({ type: 'agentTool', icon: 'warning', text: 'response length budget reached — stopping to avoid runaway token spend' });
					reason = 'limit'; break;
				}
				ctx.post({ type: 'agentTool', icon: 'warning', text: 'response was long — continuing…' });
				if (nudges++ < 6) {
					// Two distinct continuation prompts. When the prior turn was building toward a file we let
					// the model switch to a write tool; otherwise it's plain prose and we must NOT suggest tools
					// (a tool hint mid-explanation can trigger an unexpected/out-of-scope file write, and it also
					// widens a prompt-injection path if the cut-off text came from injected workspace content).
					const buildingFile = /```|\b(create|write|save|add)\b[^.\n]{0,40}\bfile\b|\bfile\b[^.\n]{0,40}\b(create|write|save|add)\b/i.test(text);
					const grounding = 'You are a coding assistant. Continue your previous response where it was cut off. Do not repeat content already written.';
					messages.push({ role: 'user', content: buildingFile
						? grounding + ' If you were about to produce a file, stop pasting its contents into the chat and instead call edit_file or write_file to actually apply it.'
						: grounding });
					continue;
				}
				reason = 'limit'; break;
			}
			if (/(^|\n)\s*done\s*:/i.test(text) || /\bdone\.?\s*$/i.test(text.trim())) {
				if (await attemptVerify()) { continue; }   // verification failed → fix feedback pushed, keep going
				reason = 'done'; break;
			}
			// Only nudge when the model PROMISED an action but didn't call a tool (a real stall) —
			// not when it gave a complete conversational answer (e.g. a joke, an explanation, a question).
			const promisesAction = /[:…]\s*$/.test(text.trim())
				|| /\b(let me|let['’]?s|now i['’]?ll|i['’]?ll|i will|going to|i'?m going to)\b[^.!?]*\b(add|edit|create|write|update|insert|implement|fix|change|modify|refactor|append|replace|check|read|look|search|run)\b/i.test(text)
				|| /\bnext[, ]/i.test(text);
			if (promisesAction && nudges++ < 3) {
				dbg('nudge', { n: nudges, stop: turn.stop_reason });
				messages.push({ role: 'user', content: 'Stop planning. You have read enough. Make your next edit_file (or write_file) call NOW — do not describe it, do it. If the goal is truly complete, reply with a one-line summary starting with "Done:".' });
				continue;
			}
			dbg(promisesAction ? 'stall.giveup' : 'turn.complete', { nudges, promised: promisesAction });
			if (await attemptVerify()) { continue; }   // verification failed → fix feedback pushed, keep going
			reason = 'done';
			break;
		}
		if (step > ctx.maxSteps) { reason = 'limit'; }
	} catch (e) {
		const msg = String((e && e.message) || e);
		const code = e && e.code;   // structured gateway code (e.g. service_unavailable) → webview picks the card
		dbg('agent.error', { msg, aborted: ctx.signal.aborted });
		if (ctx.signal.aborted) { reason = 'stopped'; }
		else if (/prompt is too long|context.{0,12}(limit|window|length)|exceed.{0,20}(context|maximum)|too many tokens/i.test(msg)) {
			// Real context-window overflow — surface a clear, actionable message instead of the raw 400.
			ctx.post({ type: 'agentError', message: 'You’ve hit the model’s context window (the conversation got too long). Start a New chat to reset it, switch to a larger-context model, or pin fewer files — then continue.', kind: 'context' });
			reason = 'error';
		}
		else { ctx.post({ type: 'agentError', message: msg, code }); reason = 'error'; }
	} finally {
		dbg('agent.done', { reason, steps: step - 1, edits: ctx.editCount || 0, costMicros: runCostMicros, creditsLeftMicros: ctx.credits != null ? ctx.credits : null });
		// [LevelCode] Gateway runs now carry real money: costMicros = what THIS run cost, credits = the
		// remaining balance — both RETAIL micro-$. BYOK runs send neither (null/0) and the bar omits them.
		ctx.post({
			type: 'agentDone', reason, edits: ctx.editCount || 0, maxSteps: ctx.maxSteps,
			costMicros: runCostMicros > 0 ? runCostMicros : null,
			credits: ctx.credits != null ? ctx.credits : null
		});
	}
}

module.exports = { runAgent, makeDiff, resolveWorkspacePath };
