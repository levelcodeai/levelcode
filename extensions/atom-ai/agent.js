/*---------------------------------------------------------------------------------------------
 *  Atom++ — AI (M4, feature 1: agentic multi-file tasks)
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
const { streamClaudeAgentTurn } = require('./providers');
const { formatVerifyFeedback, verifyOutcome, looksUnrunnable } = require('./verify');

const SYSTEM = [
	"You are Atom++'s built-in autonomous coding agent. You accomplish the user's goal in their",
	'workspace using the provided tools. Rules:',
	'- Be DECISIVE and FAST. Read only the file you are changing (plus at most 1 other if truly needed), then ACT. Do NOT write long multi-point plans — at most ONE short sentence before each tool call.',
	'- Start acting within your first 1-2 turns. Use read_file / list_files / search to understand code before editing — never guess file contents.',
	'- CRITICAL: never end your turn by merely describing an edit ("now let me refactor…"). If you intend to change a file, you MUST call edit_file or write_file in that SAME turn. Words are not edits.',
	'- To change an EXISTING file, use edit_file with an exact, unique snippet (old_str) and its replacement (new_str). This is preferred — small and reliable. Read the file first so old_str matches exactly. Prefer SEVERAL small edit_file calls over one huge one (smaller edits are faster and easier to review).',
	'- Use write_file ONLY to create a new file (or fully rewrite a short one); it needs the COMPLETE content. Do not rewrite large files — use edit_file repeatedly instead.',
	'- Your file edits are APPLIED IMMEDIATELY and the user reviews them afterward in the editor with Keep/Undo — do NOT wait for approval, and do NOT re-edit a file you just edited. Only run_command still needs approval; if the user skips a command, adapt or stop.',
	'- Paths are relative to the workspace root.',
	'- For a multi-step goal, call update_plan FIRST with a short checklist (3-8 short items, all "pending"), then call it again to set an item "in_progress" when you start it and "done" when finished. Skip the plan for trivial single-step goals.',
	'- If the goal truly depends on a decision only the user can make (tech stack, scope, where to create files, must-have features), call ask_user ONCE with concise multiple-choice questions (a short header + 2-4 concrete options each) INSTEAD of writing the questions as prose. Then act on their answers and do not ask again. Do NOT ask about things you can reasonably decide yourself — prefer a sensible default and proceed.',
	'- When the goal is finished, end with a one-line summary starting with "Done:" and STOP (no more tools).',
	'- After you finish, your work is verified automatically: editor diagnostics for the files you changed (plus a verify command, if the user configured one) are checked. If problems are found you will get them back as a follow-up message — fix the ones you introduced, then finish again with "Done:". If a reported problem is clearly pre-existing and unrelated to the goal, do not chase it: note it in one line and finish.'
].join('\n');

const TOOLS = [
	{ name: 'list_files', description: 'List workspace files (optional glob like "**/*.js"). Excludes node_modules/.git/build dirs.', input_schema: { type: 'object', properties: { glob: { type: 'string' } } } },
	{ name: 'read_file', description: 'Read a workspace file (path relative to the workspace root).', input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
	{ name: 'search', description: 'Search file contents for a literal string. Returns file:line snippets.', input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
	{ name: 'update_plan', description: 'Declare or update your task checklist for a multi-step goal. Pass the FULL list each time, each item with a status. Call it once up front (all pending), then again to mark an item in_progress when you start it and done when finished. Skip for trivial single-step goals.', input_schema: { type: 'object', properties: { todos: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, status: { type: 'string', enum: ['pending', 'in_progress', 'done'] } }, required: ['title', 'status'] } } }, required: ['todos'] } },
	{ name: 'edit_file', description: 'Make a targeted edit to an EXISTING file: replace an exact, unique snippet (old_str) with new_str. Applied immediately; the user reviews it with Keep/Undo. old_str must appear exactly once — include enough surrounding context to be unique.', input_schema: { type: 'object', properties: { path: { type: 'string' }, old_str: { type: 'string' }, new_str: { type: 'string' } }, required: ['path', 'old_str', 'new_str'] } },
	{ name: 'write_file', description: 'Create a new file (or fully overwrite a short one) with the COMPLETE content. For edits to existing files, prefer edit_file. Applied immediately; the user reviews it with Keep/Undo.', input_schema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } },
	{ name: 'run_command', description: 'Run a shell command in the workspace root. Requires approval.', input_schema: { type: 'object', properties: { command: { type: 'string' }, explanation: { type: 'string' } }, required: ['command'] } },
	{ name: 'ask_user', description: 'Ask the user one or more multiple-choice questions when the goal genuinely depends on a decision only they can make (tech stack, scope, where to put files, must-have features). The user picks by CLICKING — do NOT write questions as prose. Ask ONCE up front with all your questions, then proceed with the answers and never re-ask. Prefer sensible defaults over asking; only ask when a wrong guess would waste real work.', input_schema: { type: 'object', properties: { questions: { type: 'array', items: { type: 'object', properties: { header: { type: 'string', description: 'a 1-3 word tag for the question' }, question: { type: 'string' }, multiSelect: { type: 'boolean', description: 'true if several options can be picked at once' }, options: { type: 'array', items: { type: 'object', properties: { label: { type: 'string' }, description: { type: 'string' } }, required: ['label'] } } }, required: ['question', 'options'] } } }, required: ['questions'] } }
];

// Rough token estimates (chars/4) for the static prompt segments, so the context popover can break
// down "what's filling the window" — system + tools are sent on every request, the rest is messages.
const SYSTEM_TOKENS_EST = Math.round(SYSTEM.length / 4);
const TOOLS_TOKENS_EST = Math.round(JSON.stringify(TOOLS).length / 4);

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
function workspaceRoot() {
	const f = vscode.workspace.workspaceFolders;
	return f && f.length ? f[0].uri.fsPath : null;
}
function safeJoin(root, rel) {
	const pth = path.resolve(root, rel);
	if (pth !== root && !pth.startsWith(root + path.sep)) { return null; }
	return pth;
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

/** Compact summary of a tool's input for debug logs (truncate long strings). */
function inputPreview(input) {
	if (!input || typeof input !== 'object') { return input; }
	const out = {};
	for (const k of Object.keys(input)) {
		const v = input[k];
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
			ctx.post({ type: 'agentTool', icon: 'file', text: 'read ' + input.path });
			const abs = safeJoin(root, input.path || '');
			if (!abs || !fs.existsSync(abs)) { return 'ERROR: file not found: ' + input.path; }
			if (isBinaryFile(abs)) { return 'ERROR: ' + input.path + ' looks like a binary file — not reading it as text.'; }
			let body = fs.readFileSync(abs, 'utf8').replace(/^﻿/, ''); // drop BOM so old_str matches cleanly
			if (body.length > 100 * 1024) { body = body.slice(0, 100 * 1024) + '\n…(truncated)…'; }
			return body;
		}
		if (tu.name === 'search') {
			ctx.post({ type: 'agentTool', icon: 'search', text: 'search "' + input.query + '"' });
			return (await rgSearch(String(input.query || ''), root)) || '(no matches)';
		}
		if (tu.name === 'update_plan') {
			const todos = Array.isArray(input.todos) ? input.todos.slice(0, 20) : [];
			ctx.post({ type: 'plan', todos });
			const done = todos.filter((t) => t && t.status === 'done').length;
			return 'Plan updated (' + done + '/' + todos.length + ' done).';
		}
		if (tu.name === 'edit_file') {
			const abs = safeJoin(root, input.path || '');
			if (!abs) { return 'ERROR: path is outside the workspace'; }
			if (!fs.existsSync(abs)) { return 'ERROR: file not found: ' + input.path + ' (use write_file to create it)'; }
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
			const abs = safeJoin(root, input.path || '');
			if (!abs) { return 'ERROR: path is outside the workspace'; }
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
		if (tu.name === 'run_command') {
			const cmd = String(input.command || '');
			const approved = await ctx.approve({ kind: 'command', command: cmd, explanation: input.explanation || '' });
			if (!approved) { return 'User skipped this command. Do not retry it.'; }
			const runId = tu.id || ('run-' + Date.now());
			ctx.post({ type: 'termRun', id: runId, command: cmd, cwd: path.basename(root) || 'workspace' });
			const stops = ctx.commandStops;   // shared registry so the Stop button / ■ can kill the process group
			return await runCommand(root, cmd,
				(chunk, stream) => ctx.post({ type: 'termOutput', id: runId, chunk: chunk, stream: stream }),
				(code, ms, how) => { if (stops) { stops.delete(runId); } ctx.post({ type: 'termExit', id: runId, code: code, ms: ms, how: how }); },
				(child, stop) => { if (stops) { stops.set(runId, stop); } },
				ctx.commandTimeout);
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
		return 'ERROR: unknown tool ' + tu.name;
	} catch (e) {
		return 'ERROR: ' + ((e && e.message) || e);
	}
}

/**
 * Run the agent loop until the model stops calling tools (or the step cap / abort).
 * `ctx.messages` is the persistent session transcript — already seeded with the new user goal —
 * and is appended to in place, so subsequent runs remember this one.
 * @param {{messages:any[], apiKey:string, model:string, maxSteps:number,
 *          post:(m:any)=>void, approve:(req:any)=>Promise<boolean>,
 *          applyEdit:(req:any)=>Promise<boolean>, signal:AbortSignal}} ctx
 *   applyEdit applies file edits (apply-then-review); approve gates run_command only.
 */
async function runAgent(ctx) {
	const root = workspaceRoot();
	if (!root) { ctx.post({ type: 'agentError', message: 'Open a folder first — the agent works on your workspace.' }); ctx.post({ type: 'agentDone', reason: 'error' }); return; }
	ctx.root = root;

	const dbg = ctx.dbg || (() => {});
	const messages = ctx.messages;
	let step = 0;
	let reason = 'done';
	let nudges = 0;

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
			ctx.post({ type: 'agentTool', icon: 'warning', text: 'verify command couldn’t run — check the atompp.ai.verify.command setting' });
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
			const turn = await streamClaudeAgentTurn({
				apiKey: ctx.apiKey, model: ctx.model, maxTokens: 8192, system: SYSTEM,
				messages, tools: TOOLS, signal: ctx.signal,
				onText: (t) => { streamed = true; textChars += t.length; ctx.post({ type: 'agentDelta', text: t }); },
				onToolStart: (name) => {
					dbg('tool.start', { name });
					const verb = name === 'edit_file' || name === 'write_file' ? 'preparing edit (' + name + ')…'
						: name === 'run_command' ? 'preparing command…' : name === 'update_plan' ? 'planning…' : 'running ' + name + '…';
					ctx.post({ type: 'agentStatus', text: verb });
				}
			});
			if (streamed) { ctx.post({ type: 'agentTurnEnd' }); }
			dbg('turn.response', { step, stop: turn.stop_reason, blocks: turn.content.length, textChars, tools: turn.content.filter((c) => c.type === 'tool_use').map((c) => c.name + (turn.malformed && turn.malformed.has(c.id) ? '!malformed' : '')) });
			// Report real context usage (input_tokens = how full the transcript is) so the UI can meter + warn.
			if (turn.usage) {
				dbg('usage', { input: turn.usage.input_tokens, output: turn.usage.output_tokens, cacheRead: turn.usage.cache_read_input_tokens });
				ctx.post({ type: 'contextUsage', input: (turn.usage.input_tokens || 0) + (turn.usage.cache_read_input_tokens || 0) + (turn.usage.cache_creation_input_tokens || 0), output: turn.usage.output_tokens || 0, limit: ctx.contextLimit || 200000, model: ctx.model, system: SYSTEM_TOKENS_EST, tools: TOOLS_TOKENS_EST });
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
					dbg('tool.call', { name: tu.name, input: inputPreview(tu.input) });
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
				ctx.post({ type: 'agentTool', icon: 'warning', text: 'response was cut off — switching to smaller edits' });
				messages.push({ role: 'user', content: 'Your last response was cut off (too long). Use edit_file for small, targeted changes instead of rewriting whole files. Continue.' });
				if (nudges++ < 3) { continue; }
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
		dbg('agent.error', { msg, aborted: ctx.signal.aborted });
		if (ctx.signal.aborted) { reason = 'stopped'; }
		else if (/prompt is too long|context.{0,12}(limit|window|length)|exceed.{0,20}(context|maximum)|too many tokens/i.test(msg)) {
			// Real context-window overflow — surface a clear, actionable message instead of the raw 400.
			ctx.post({ type: 'agentError', message: 'You’ve hit the model’s context window (the conversation got too long). Start a New chat to reset it, switch to a larger-context model, or pin fewer files — then continue.', kind: 'context' });
			reason = 'error';
		}
		else { ctx.post({ type: 'agentError', message: msg }); reason = 'error'; }
	} finally {
		dbg('agent.done', { reason, steps: step - 1, edits: ctx.editCount || 0, credits: ctx.credits != null ? ctx.credits : null });
		// credits: null until the M10 gateway returns real usage; the response bar shows it when present.
		ctx.post({ type: 'agentDone', reason, edits: ctx.editCount || 0, credits: ctx.credits != null ? ctx.credits : null, maxSteps: ctx.maxSteps });
	}
}

module.exports = { runAgent, makeDiff };
