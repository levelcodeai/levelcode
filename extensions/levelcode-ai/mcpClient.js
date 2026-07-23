/*---------------------------------------------------------------------------------------------
 *  MCP stdio client — spawns a configured server and speaks JSON-RPC to it (docs/MCP.md, S2).
 *
 *  Hand-rolled on purpose (docs/MCP.md D1): the official SDK pulls 93 transitive packages — two web
 *  frameworks and an OAuth stack — to support the REMOTE transport we do not use, is ESM against this
 *  CJS extension, and `npm install` never runs for this extension anyway. The surface we need is three
 *  methods: initialize, tools/list, tools/call. The framing/flattening lives in mcpProtocol.js so the
 *  fiddly parts are testable without spawning; this file is the process handling.
 *
 *  Four things this owes the agent that the generic tool path does NOT provide:
 *    • a per-call TIMEOUT — tools run sequentially in agent.js, so one wedged server would hang the
 *      whole run;
 *    • a capped, flattened STRING result (mcpProtocol.flattenContent) — tool_result is text;
 *    • never throwing out of call() — a failure comes back as an `ERROR: …` string, the same shape the
 *      agent's other tools use, so one bad server cannot break the turn loop;
 *    • deterministic REAPING. A server is a detached child holding ports/handles; it must die on New
 *      Chat and on unload, exactly like bgRuns/commandStops (extension.js) — otherwise the next run
 *      inherits orphans.
 *
 *  SECURITY: spawning a server is arbitrary code execution, so this module deliberately does NOT decide
 *  whether a server may start — the caller must have cleared it (mcpConfig marks workspace-sourced
 *  entries, and the launch gate is S4). Two hardening choices here: `shell:false` (args are passed as
 *  argv, never re-parsed by a shell), and server→client requests (`sampling/*`, `elicitation/*`) are
 *  explicitly REFUSED rather than ignored — a server must not be able to drive our model.
 *--------------------------------------------------------------------------------------------*/
'use strict';

const cp = require('child_process');
const { encode, createFramer, initializeParams, flattenContent, errorText } = require('./mcpProtocol');

const CONNECT_TIMEOUT_MS = 20000;   // spawn + initialize + tools/list
const CALL_TIMEOUT_MS = 60000;      // one tools/call
const KILL_GRACE_MS = 1500;         // SIGTERM → SIGKILL, same as runCommand
const STDERR_KEEP = 2000;           // ring buffer for diagnostics ("command not found", "missing key")

/** name → handle, module-scoped so servers survive between agent runs (like bgRuns). */
const active = new Map();

/**
 * Start one MCP server and complete the handshake.
 * @param {{name:string, command:string, args?:string[], env?:object, source?:string, origin?:string}} server
 * @param {{cwd?:string, connectTimeoutMs?:number, clientVersion?:string}} [opts]
 * @returns {Promise<object>} handle
 */
async function connect(server, opts) {
	const o = opts || {};
	const name = server.name;
	const connectTimeout = o.connectTimeoutMs || CONNECT_TIMEOUT_MS;

	const proc = cp.spawn(server.command, Array.isArray(server.args) ? server.args : [], {
		cwd: o.cwd || process.cwd(),
		env: Object.assign({}, process.env, server.env || {}),
		stdio: ['pipe', 'pipe', 'pipe'],
		// Detached so we can kill the whole process group — a server that spawns children (npx, docker)
		// would otherwise leave them behind. Mirrors runCommand in agent.js.
		detached: true,
		shell: false   // args are argv, never re-parsed by a shell
	});

	const framer = createFramer();
	const pending = new Map();
	let nextId = 1;
	let alive = true;
	let stderrBuf = '';
	let tools = [];

	const stderrTail = () => stderrBuf.trim().split('\n').filter(Boolean).slice(-3).join(' | ').slice(0, 300);

	const failAll = (why) => {
		for (const [, p] of pending) { clearTimeout(p.timer); p.reject(new Error(why)); }
		pending.clear();
	};

	const killGroup = () => {
		if (!proc.pid) { return; }
		try { process.kill(-proc.pid, 'SIGTERM'); } catch { try { proc.kill('SIGTERM'); } catch { /* gone */ } }
		const t = setTimeout(() => {
			try { process.kill(-proc.pid, 'SIGKILL'); } catch { try { proc.kill('SIGKILL'); } catch { /* gone */ } }
		}, KILL_GRACE_MS);
		if (t.unref) { t.unref(); }
	};

	const dispose = (reason) => {
		if (!alive) { return; }
		alive = false;
		active.delete(name);
		failAll(reason || 'MCP server "' + name + '" was stopped');
		try { proc.stdin.end(); } catch { /* already closed */ }
		killGroup();
	};

	const request = (method, params, timeoutMs) => new Promise((resolve, reject) => {
		if (!alive) { reject(new Error('MCP server "' + name + '" is not running')); return; }
		const id = nextId++;
		const timer = setTimeout(() => {
			pending.delete(id);
			reject(new Error(method + ' timed out after ' + timeoutMs + 'ms'));
		}, timeoutMs);
		if (timer.unref) { timer.unref(); }
		pending.set(id, { resolve, reject, timer });
		try { proc.stdin.write(encode({ jsonrpc: '2.0', id, method, params: params || {} })); }
		catch (e) { clearTimeout(timer); pending.delete(id); reject(e); }
	});

	const notify = (method, params) => {
		try { proc.stdin.write(encode({ jsonrpc: '2.0', method, params: params || {} })); } catch { /* dying */ }
	};

	proc.stdout.setEncoding('utf8');
	proc.stdout.on('data', (chunk) => {
		let messages;
		try { messages = framer.push(chunk); }
		catch (e) { dispose('protocol error from "' + name + '": ' + ((e && e.message) || e)); return; }
		for (const msg of messages) {
			// A response to something we asked.
			if (msg.id != null && pending.has(msg.id)) {
				const p = pending.get(msg.id);
				pending.delete(msg.id);
				clearTimeout(p.timer);
				if (msg.error) { p.reject(new Error(errorText(msg.error))); } else { p.resolve(msg.result); }
				continue;
			}
			// A REQUEST from the server (sampling/elicitation/roots). We implement none of them — refuse
			// explicitly so the server gets a clean answer instead of hanging, and so it can never drive
			// our model or prompt the user behind our back.
			if (msg.method && msg.id != null) {
				notifyError(msg.id, 'LevelCode does not implement ' + msg.method);
				continue;
			}
			// Notifications (no id) are ignored in v1.
		}
	});

	const notifyError = (id, message) => {
		try { proc.stdin.write(encode({ jsonrpc: '2.0', id, error: { code: -32601, message } })); } catch { /* dying */ }
	};

	proc.stderr.setEncoding('utf8');
	proc.stderr.on('data', (c) => { stderrBuf = (stderrBuf + c).slice(-STDERR_KEEP); });

	proc.on('error', (e) => {
		// Spawn failure (ENOENT: command not found) — surfaces as a rejected connect().
		alive = false;
		active.delete(name);
		failAll('could not start MCP server "' + name + '": ' + ((e && e.message) || e));
	});

	proc.on('exit', (code, signal) => {
		alive = false;
		active.delete(name);
		const why = 'MCP server "' + name + '" exited (' + (signal || 'code ' + code) + ')';
		const tail = stderrTail();
		failAll(tail ? why + ': ' + tail : why);
	});

	const handle = {
		name,
		pid: proc.pid,
		source: server.source,
		origin: server.origin,
		get alive() { return alive; },
		get tools() { return tools; },
		stderrTail,
		dispose,
		/**
		 * Call a tool. NEVER throws — returns the agent-facing string, with failures as `ERROR: …`
		 * so a bad server cannot break the turn loop.
		 */
		async call(toolName, args, callOpts) {
			const timeout = (callOpts && callOpts.timeoutMs) || CALL_TIMEOUT_MS;
			try {
				const result = await request('tools/call', { name: toolName, arguments: args || {} }, timeout);
				return flattenContent(result, callOpts);
			} catch (e) {
				const tail = stderrTail();
				return 'ERROR: ' + ((e && e.message) || e) + (tail ? ' — server stderr: ' + tail : '');
			}
		}
	};

	try {
		await request('initialize', initializeParams('LevelCode', o.clientVersion), connectTimeout);
		notify('notifications/initialized');
		const listed = await request('tools/list', {}, connectTimeout);
		tools = (listed && Array.isArray(listed.tools)) ? listed.tools : [];
	} catch (e) {
		const tail = stderrTail();
		dispose('handshake failed');
		throw new Error('MCP server "' + name + '" failed to start: ' + ((e && e.message) || e) + (tail ? ' — ' + tail : ''));
	}

	active.set(name, handle);
	return handle;
}

/**
 * Connect a list of servers, tolerating individual failures — one broken server must not deny the user
 * the others. Returns the handles that came up plus a problem per server that did not.
 */
async function connectAll(servers, opts) {
	const handles = [];
	const problems = [];
	for (const s of (Array.isArray(servers) ? servers : [])) {
		if (active.has(s.name)) { handles.push(active.get(s.name)); continue; }
		try { handles.push(await connect(s, opts)); }
		catch (e) { problems.push({ level: 'error', server: s.name, message: (e && e.message) || String(e) }); }
	}
	return { handles, problems };
}

/** Kill every server. Call from newChat() and deactivate(), beside reapCommands(). */
function reapMcp() {
	for (const h of Array.from(active.values())) {
		try { h.dispose('reaped'); } catch { /* already gone */ }
	}
	active.clear();
}

/** Live servers, for the /mcp view and the context meter (S5). */
function listActive() {
	return Array.from(active.values()).map((h) => ({
		name: h.name, source: h.source, origin: h.origin, alive: h.alive, toolCount: h.tools.length
	}));
}

function getServer(name) { return active.get(name) || null; }

module.exports = {
	connect, connectAll, reapMcp, listActive, getServer,
	CONNECT_TIMEOUT_MS, CALL_TIMEOUT_MS
};
