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
	'- When the goal is finished, end with a one-line summary starting with "Done:" and STOP (no more tools).'
].join('\n');

const TOOLS = [
	{ name: 'list_files', description: 'List workspace files (optional glob like "**/*.js"). Excludes node_modules/.git/build dirs.', input_schema: { type: 'object', properties: { glob: { type: 'string' } } } },
	{ name: 'read_file', description: 'Read a workspace file (path relative to the workspace root).', input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
	{ name: 'search', description: 'Search file contents for a literal string. Returns file:line snippets.', input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
	{ name: 'edit_file', description: 'Make a targeted edit to an EXISTING file: replace an exact, unique snippet (old_str) with new_str. Applied immediately; the user reviews it with Keep/Undo. old_str must appear exactly once — include enough surrounding context to be unique.', input_schema: { type: 'object', properties: { path: { type: 'string' }, old_str: { type: 'string' }, new_str: { type: 'string' } }, required: ['path', 'old_str', 'new_str'] } },
	{ name: 'write_file', description: 'Create a new file (or fully overwrite a short one) with the COMPLETE content. For edits to existing files, prefer edit_file. Applied immediately; the user reviews it with Keep/Undo.', input_schema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } },
	{ name: 'run_command', description: 'Run a shell command in the workspace root. Requires approval.', input_schema: { type: 'object', properties: { command: { type: 'string' }, explanation: { type: 'string' } }, required: ['command'] } }
];

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

function runCommand(root, command) {
	return new Promise((resolve) => {
		cp.exec(command, { cwd: root, timeout: 60000, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
			let out = (stdout || '') + (stderr ? '\n[stderr]\n' + stderr : '');
			if (err && err.killed) { out += '\n[timed out after 60s]'; }
			else if (err) { out += '\n[exit ' + (err.code != null ? err.code : '?') + ']'; }
			resolve(out.slice(0, 8000) || '(no output)');
		});
	});
}

/** Execute one tool call; returns a string result for the model. */
async function runTool(tu, ctx) {
	const root = ctx.root;
	const input = tu.input || {};
	try {
		if (tu.name === 'list_files') {
			ctx.post({ type: 'agentTool', icon: '📁', text: 'list_files ' + (input.glob || '') });
			const uris = await vscode.workspace.findFiles(input.glob || '**/*', FILE_EXCLUDES, 600);
			return uris.map((u) => vscode.workspace.asRelativePath(u)).join('\n') || '(no files)';
		}
		if (tu.name === 'read_file') {
			ctx.post({ type: 'agentTool', icon: '📄', text: 'read ' + input.path });
			const abs = safeJoin(root, input.path || '');
			if (!abs || !fs.existsSync(abs)) { return 'ERROR: file not found: ' + input.path; }
			let body = fs.readFileSync(abs, 'utf8');
			if (body.length > 100 * 1024) { body = body.slice(0, 100 * 1024) + '\n…(truncated)…'; }
			return body;
		}
		if (tu.name === 'search') {
			ctx.post({ type: 'agentTool', icon: '🔎', text: 'search "' + input.query + '"' });
			return (await rgSearch(String(input.query || ''), root)) || '(no matches)';
		}
		if (tu.name === 'edit_file') {
			const abs = safeJoin(root, input.path || '');
			if (!abs) { return 'ERROR: path is outside the workspace'; }
			if (!fs.existsSync(abs)) { return 'ERROR: file not found: ' + input.path + ' (use write_file to create it)'; }
			const cur = fs.readFileSync(abs, 'utf8');
			const oldStr = String(input.old_str || '');
			const newStr = String(input.new_str || '');
			if (!oldStr) { return 'ERROR: old_str is empty.'; }
			const idx = cur.indexOf(oldStr);
			if (idx < 0) { return 'ERROR: old_str was not found in ' + input.path + '. Read the file and copy the exact text (including whitespace).'; }
			if (cur.indexOf(oldStr, idx + 1) >= 0) { return 'ERROR: old_str appears more than once in ' + input.path + '. Add more surrounding context so it is unique.'; }
			const proposed = cur.slice(0, idx) + newStr + cur.slice(idx + oldStr.length);
			const ok = await ctx.applyEdit({ path: input.path, exists: true, proposed });
			if (!ok) { return 'ERROR: could not apply the edit to ' + input.path + ' (file may be read-only or in conflict).'; }
			ctx.editCount = (ctx.editCount || 0) + 1;
			return 'Applied edit to ' + input.path + ' (the user is reviewing it with Keep/Undo; do not re-edit it).';
		}
		if (tu.name === 'write_file') {
			const abs = safeJoin(root, input.path || '');
			if (!abs) { return 'ERROR: path is outside the workspace'; }
			const existed = fs.existsSync(abs);
			const newStr = String(input.content || '');
			const ok = await ctx.applyEdit({ path: input.path, exists: existed, proposed: newStr });
			if (!ok) { return 'ERROR: could not write ' + input.path + ' (path may be read-only or in conflict).'; }
			ctx.editCount = (ctx.editCount || 0) + 1;
			return 'Applied edit to ' + input.path + ' (pending the user\'s Keep/Undo review).';
		}
		if (tu.name === 'run_command') {
			const approved = await ctx.approve({ kind: 'command', command: String(input.command || ''), explanation: input.explanation || '' });
			if (!approved) { return 'User skipped this command. Do not retry it.'; }
			ctx.post({ type: 'agentTool', icon: '▶️', text: 'ran: ' + input.command });
			return await runCommand(root, String(input.command || ''));
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

	const messages = ctx.messages;
	let step = 0;
	let reason = 'done';
	let nudges = 0;
	try {
		while (step++ < ctx.maxSteps) {
			if (ctx.signal.aborted) { reason = 'stopped'; break; }
			ctx.post({ type: 'agentStatus', text: 'thinking…' });
			let streamed = false;
			const turn = await streamClaudeAgentTurn({
				apiKey: ctx.apiKey, model: ctx.model, maxTokens: 8192, system: SYSTEM,
				messages, tools: TOOLS, signal: ctx.signal,
				onText: (t) => { streamed = true; ctx.post({ type: 'agentDelta', text: t }); },
				onToolStart: (name) => {
					const verb = name === 'edit_file' || name === 'write_file' ? 'preparing edit (' + name + ')…'
						: name === 'run_command' ? 'preparing command…' : 'running ' + name + '…';
					ctx.post({ type: 'agentStatus', text: verb });
				}
			});
			if (streamed) { ctx.post({ type: 'agentTurnEnd' }); }
			messages.push({ role: 'assistant', content: turn.content });

			const toolUses = turn.content.filter((c) => c.type === 'tool_use');
			if (toolUses.length) {
				// CRITICAL: every tool_use MUST get a matching tool_result, even on abort, or the
				// next API call 400s ("tool_use ids were found without tool_result blocks").
				const results = [];
				let cancelled = false;
				for (const tu of toolUses) {
					if (cancelled || ctx.signal.aborted) { cancelled = true; results.push({ type: 'tool_result', tool_use_id: tu.id, content: 'Cancelled by the user.' }); continue; }
					const out = await runTool(tu, ctx);
					results.push({ type: 'tool_result', tool_use_id: tu.id, content: String(out) });
				}
				messages.push({ role: 'user', content: results });
				if (cancelled || ctx.signal.aborted) { reason = 'stopped'; break; }
				nudges = 0;
				continue;
			}

			// No tool calls this turn.
			const text = turn.content.filter((c) => c.type === 'text').map((c) => c.text).join('');
			if (turn.stop_reason === 'max_tokens') {
				ctx.post({ type: 'agentTool', icon: '⚠️', text: 'response was cut off — switching to smaller edits' });
				messages.push({ role: 'user', content: 'Your last response was cut off (too long). Use edit_file for small, targeted changes instead of rewriting whole files. Continue.' });
				if (nudges++ < 3) { continue; }
				reason = 'limit'; break;
			}
			if (/(^|\n)\s*done\s*:/i.test(text) || /\bdone\.?\s*$/i.test(text.trim())) { reason = 'done'; break; }
			// The model stalled on intent without acting — nudge it to act (a few times).
			if (nudges++ < 3) {
				messages.push({ role: 'user', content: 'Stop planning. You have read enough. Make your next edit_file (or write_file) call NOW — do not describe it, do it. If the goal is truly complete, reply with a one-line summary starting with "Done:".' });
				continue;
			}
			reason = 'done';
			break;
		}
		if (step > ctx.maxSteps) { reason = 'limit'; }
	} catch (e) {
		if (ctx.signal.aborted) { reason = 'stopped'; }
		else { ctx.post({ type: 'agentError', message: String((e && e.message) || e) }); reason = 'error'; }
	} finally {
		ctx.post({ type: 'agentDone', reason, edits: ctx.editCount || 0 });
	}
}

module.exports = { runAgent, makeDiff };
