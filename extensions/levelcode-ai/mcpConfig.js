/*---------------------------------------------------------------------------------------------
 *  MCP config, tool naming, and approval policy — the PURE core of MCP support (see docs/MCP.md).
 *
 *  Three jobs, all of them decided before any process is spawned or any tool is called:
 *    1. WHICH servers exist — merge the user's setting with per-workspace `.levelcode/mcp.json`,
 *       keeping PROVENANCE, because the two are not equally trusted (below).
 *    2. WHAT their tools are called — namespace to `server__tool`. This is a CORRECTNESS gate, not
 *       cosmetics: Anthropic requires ^[a-zA-Z0-9_-]{1,128}$ and OpenAI-shaped providers {1,64}, and
 *       nothing else in the pipeline validates names (providers/translate.js renames the field
 *       verbatim). A '/' or ':' fails the FIRST agent turn with an opaque provider 400 — and because
 *       the name is echoed into the stored transcript and re-serialized every later turn, one bad
 *       name poisons the whole conversation, not one request. So: take the stricter 64-char limit,
 *       sanitize, truncate stably, and never shadow a built-in tool.
 *    3. WHETHER a call needs approval — default ask; only the user's allow-list may grant 'allow'.
 *
 *  TRUST: a server entry names A PROCESS TO SPAWN. The user's setting is user-authored. A workspace
 *  file is REPO-authored — i.e. attacker-controlled for any repo you clone — so entries from it are
 *  marked source:'workspace' and MUST NOT be started without explicit consent (the launch gate lives
 *  in a later slice; this module only reports the provenance it needs). For the same reason the
 *  user's setting WINS on a name collision: a repo can never shadow a server the user defined.
 *
 *  Pure + dependency-free (path only) — file reading is injected as a readFile callback, so all of it
 *  is unit-testable (test/mcpConfig.test.js) without a filesystem, a child process, or the editor.
 *  Nothing here connects, spawns, or calls anything.
 *--------------------------------------------------------------------------------------------*/
'use strict';

const path = require('path');

// The agent's built-in tools (agent.js TOOLS). An MCP tool may never shadow one of these.
const BUILTIN_TOOL_NAMES = [
	'list_files', 'read_file', 'search', 'update_plan', 'edit_file', 'write_file',
	'delete_file', 'run_command', 'read_command_output', 'ask_user', 'use_skill'
];

// Anthropic allows 128 chars, OpenAI-shaped providers 64. Take the stricter so one tool set works on
// every provider LevelCode supports.
const MAX_TOOL_NAME = 64;
const NAME_SEPARATOR = '__';

// Per-workspace config file, relative to each workspace folder root.
const WORKSPACE_CONFIG_PATH = ['.levelcode', 'mcp.json'];
// Bounds. Every tool schema rides EVERY turn, so an unbounded server would quietly eat the context
// window; and a config with 500 servers is a mistake, not a use case.
const MAX_SERVERS = 20;
const MAX_TOOLS_PER_SERVER = 64;
// A tool DESCRIPTION is a third-party string that rides every turn and is read by the model — both a
// context cost and the prompt-injection surface of docs/MCP.md G4. Bound it; we cannot sanitize meaning.
const MAX_TOOL_DESC = 1024;

// ---- 1. server config ------------------------------------------------------------------------

/** Accept both `{ mcpServers: {…} }` (the ecosystem convention) and a bare `{ name: {…} }` map. */
function serverMapOf(parsed) {
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) { return {}; }
	const inner = parsed.mcpServers;
	if (inner && typeof inner === 'object' && !Array.isArray(inner)) { return inner; }
	return parsed;
}

// Keys that must never be copied out of untrusted JSON: assigning `__proto__` invokes the prototype
// setter rather than creating a property, and `constructor`/`prototype` are the usual companions.
// See safeCopy.
const UNSAFE_KEYS = ['__proto__', 'constructor', 'prototype'];

/**
 * Shallow-copy a map that came from untrusted JSON — a repo-authored `.levelcode/mcp.json` env block,
 * or a server-supplied `inputSchema`. JSON.parse creates a REAL own `__proto__` key, so a plain
 * Object.assign would hand it to the prototype setter instead of copying it. The string-value check in
 * normalizeServer already rejects the classic object-valued payload, which makes today's safety
 * incidental — this makes it structural, and stops a key legitimately named `__proto__` from silently
 * vanishing into a setter. Deliberately a normal object, not Object.create(null): later code (and
 * tests) may reasonably call hasOwnProperty on it.
 */
function safeCopy(raw) {
	const out = {};
	for (const k of Object.keys(raw || {})) {
		if (UNSAFE_KEYS.indexOf(k) !== -1) { continue; }
		out[k] = raw[k];
	}
	return out;
}

/** Validate one entry. Returns a server object, or a string describing why it was rejected. */
function normalizeServer(name, raw, source, origin) {
	if (!name || typeof name !== 'string') { return 'server name must be a non-empty string'; }
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { return 'entry must be an object'; }
	if (!raw.command || typeof raw.command !== 'string') { return 'missing "command"'; }
	if (raw.args != null && (!Array.isArray(raw.args) || raw.args.some((a) => typeof a !== 'string'))) {
		return '"args" must be an array of strings';
	}
	if (raw.env != null && (typeof raw.env !== 'object' || Array.isArray(raw.env)
		|| Object.values(raw.env).some((v) => typeof v !== 'string'))) {
		return '"env" must be an object of strings';
	}
	return {
		name: name,
		command: raw.command,
		args: raw.args ? raw.args.slice() : [],
		env: raw.env ? safeCopy(raw.env) : {},
		source: source,     // 'settings' (user-authored) | 'workspace' (repo-authored, untrusted)
		origin: origin      // human label for the consent card / problem messages
	};
}

/**
 * Merge the user's MCP server setting with any per-workspace `.levelcode/mcp.json`.
 *
 * @param {{settings?:object, folders?:Array<{name:string, root:string}>,
 *          readFile?:(absPath:string)=>(string|null)}} opts
 * @returns {{ servers: Array<object>, problems: Array<{level:string, message:string}> }}
 */
function loadServerConfig(opts) {
	const o = opts || {};
	const servers = [];
	const problems = [];
	const byName = new Map();

	const add = (map, source, origin) => {
		for (const key of Object.keys(map || {})) {
			if (byName.has(key)) {
				// Settings are added first and therefore win — a repo must not be able to redefine a
				// server the user already trusts (it would inherit that trust with a new command line).
				problems.push({ level: 'warn', message: 'ignored duplicate server "' + key + '" from ' + origin + ' (already defined in ' + byName.get(key).origin + ')' });
				continue;
			}
			if (servers.length >= MAX_SERVERS) {
				problems.push({ level: 'warn', message: 'ignored server "' + key + '" from ' + origin + ' (over the ' + MAX_SERVERS + '-server cap)' });
				continue;
			}
			const s = normalizeServer(key, map[key], source, origin);
			if (typeof s === 'string') { problems.push({ level: 'error', message: 'server "' + key + '" in ' + origin + ': ' + s }); continue; }
			byName.set(key, s);
			servers.push(s);
		}
	};

	// 1. User setting first — see the precedence note above. A MISSING setting is an empty map, not an
	// empty wrapper: {mcpServers: undefined} would fall through serverMapOf's bare-map branch and get
	// reported as a phantom server literally named "mcpServers" — a spurious error for every user who
	// has no MCP config at all.
	const settingsRaw = (o.settings && typeof o.settings === 'object' && !Array.isArray(o.settings)) ? o.settings : null;
	add(settingsRaw ? serverMapOf(settingsRaw) : {}, 'settings', 'settings');

	// 2. Then each workspace folder's file.
	for (const f of (Array.isArray(o.folders) ? o.folders : [])) {
		if (!f || !f.root) { continue; }
		const abs = path.join(f.root, ...WORKSPACE_CONFIG_PATH);
		const label = (f.name || path.basename(f.root)) + '/' + WORKSPACE_CONFIG_PATH.join('/');
		let raw = null;
		try { raw = o.readFile ? o.readFile(abs) : null; } catch { raw = null; }
		if (!raw || !String(raw).trim()) { continue; }
		let parsed = null;
		try { parsed = JSON.parse(String(raw)); }
		catch (e) { problems.push({ level: 'error', message: 'could not parse ' + label + ': ' + ((e && e.message) || e) }); continue; }
		add(serverMapOf(parsed), 'workspace', label);
	}

	return { servers, problems };
}

// ---- 2. tool naming --------------------------------------------------------------------------

/**
 * Stable 6-char tag (djb2) so a truncated name is identical every run — it lives in the transcript.
 * Takes the LAST 6 base-36 digits, not the first: the low-order digits are the ones that actually vary
 * between similar inputs, and slicing from the left collapsed `…zzzA` and `…zzzB` onto the same tag.
 */
function shortHash(s) {
	let h = 5381;
	for (let i = 0; i < s.length; i++) { h = ((h * 33) ^ s.charCodeAt(i)) >>> 0; }
	return h.toString(36).padStart(6, '0').slice(-6);
}

/** Reduce one segment to the legal alphabet; never returns empty. */
function sanitizeSegment(raw, fallback) {
	const s = String(raw == null ? '' : raw).replace(/[^A-Za-z0-9_-]/g, '_');
	return s.length ? s : fallback;
}

/**
 * `server__tool`, guaranteed to match ^[A-Za-z0-9_-]{1,64}$ — the intersection of every provider's
 * rule. Over-long names truncate with a stable hash tag rather than a counter, because the name is
 * re-serialized on every later turn and must not change between runs.
 */
function namespaceToolName(server, tool) {
	const full = sanitizeSegment(server, 'server') + NAME_SEPARATOR + sanitizeSegment(tool, 'tool');
	if (full.length <= MAX_TOOL_NAME) { return full; }
	const tag = shortHash(String(server) + '\u0000' + String(tool));
	return full.slice(0, MAX_TOOL_NAME - tag.length - 1) + '_' + tag;
}

/**
 * Assign a final, unique, provider-legal name to every (server, tool) pair — the last line of defence
 * before names reach the wire. Collisions (with a built-in, or between two servers whose names
 * sanitize alike) get a numeric suffix rather than being dropped.
 *
 * @param {Array<{server:string, tool:string}>} pairs
 * @returns {{ tools: Array<{server:string, tool:string, name:string}>, problems: Array<object> }}
 */
function assignToolNames(pairs, opts) {
	const reserved = (opts && opts.reserved) || BUILTIN_TOOL_NAMES;
	const taken = new Set(reserved);
	const perServer = new Map();
	const tools = [];
	const problems = [];

	for (const p of (Array.isArray(pairs) ? pairs : [])) {
		if (!p || !p.tool || typeof p.tool !== 'string') { continue; }
		const count = (perServer.get(p.server) || 0) + 1;
		perServer.set(p.server, count);
		if (count > MAX_TOOLS_PER_SERVER) {
			problems.push({ level: 'warn', message: 'server "' + p.server + '" exposes more than ' + MAX_TOOLS_PER_SERVER + ' tools; "' + p.tool + '" and the rest were dropped' });
			continue;
		}
		const base = namespaceToolName(p.server, p.tool);
		let name = base;
		let n = 2;
		while (taken.has(name)) {
			const suffix = '_' + n;
			name = base.slice(0, MAX_TOOL_NAME - suffix.length) + suffix;
			n++;
		}
		if (name !== base) {
			problems.push({ level: 'warn', message: 'tool name "' + base + '" was already taken; exposed as "' + name + '"' });
		}
		taken.add(name);
		tools.push({ server: p.server, tool: p.tool, name });
	}
	return { tools, problems };
}

/**
 * A tool schema the providers will actually accept. MCP says `inputSchema` is a JSON Schema of type
 * "object", but a server can send anything; a non-object top-level schema is a provider 400, which the
 * agent would surface as an opaque failure on turn one. Normalize rather than trust, and copy safely —
 * this is server-supplied JSON, same reasoning as safeCopy's other caller.
 */
function schemaOf(raw) {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { return { type: 'object', properties: {} }; }
	const out = safeCopy(raw);
	out.type = 'object';
	if (!out.properties || typeof out.properties !== 'object' || Array.isArray(out.properties)) { out.properties = {}; }
	return out;
}

/** Capped description, with a fallback — the model needs *something* to decide with. */
function describeTool(spec, server, tool) {
	const raw = typeof spec.description === 'string' ? spec.description.trim() : '';
	if (!raw) { return 'The "' + tool + '" tool from the "' + server + '" MCP server (no description provided).'; }
	return raw.length > MAX_TOOL_DESC ? raw.slice(0, MAX_TOOL_DESC - 1) + '…' : raw;
}

/**
 * Turn the tool lists of connected servers into (a) agent TOOLS entries and (b) the routing table the
 * agent uses to send a call back to the right server. This is the whole translation layer: MCP's
 * `{name, description, inputSchema}` is our `{name, description, input_schema}` — a field rename, per
 * docs/MCP.md — plus the naming/capping that makes it safe to put on the wire.
 *
 * Pure: takes plain data (`{name, tools}`), not live handles, so it is unit-testable without spawning.
 *
 * @param {Array<{name:string, tools:Array<object>}>} servers
 * @returns {{ tools: Array<object>, routes: Map<string,{server:string, tool:string, annotations:object|null}>,
 *             problems: Array<object> }}
 */
function buildAgentTools(servers, opts) {
	const specs = new Map();
	const pairs = [];
	for (const s of (Array.isArray(servers) ? servers : [])) {
		if (!s || typeof s.name !== 'string' || !s.name || !Array.isArray(s.tools)) { continue; }
		for (const t of s.tools) {
			if (!t || typeof t.name !== 'string' || !t.name) { continue; }
			const key = s.name + '\u0000' + t.name;
			if (specs.has(key)) { continue; }   // a server that lists the same tool twice
			specs.set(key, t);
			pairs.push({ server: s.name, tool: t.name });
		}
	}

	// assignToolNames may DROP entries (the per-server cap) so its output is a subsequence, not a 1:1
	// row-for-row mapping — correlate by (server, tool) rather than by index.
	const assigned = assignToolNames(pairs, opts);
	const tools = [];
	const routes = new Map();
	for (const a of assigned.tools) {
		const spec = specs.get(a.server + '\u0000' + a.tool) || {};
		tools.push({
			name: a.name,
			description: describeTool(spec, a.server, a.tool),
			input_schema: schemaOf(spec.inputSchema)
		});
		routes.set(a.name, {
			server: a.server,
			tool: a.tool,
			// Kept for classifyMcpTool, which may only ever TIGHTEN on them (they are server-supplied).
			annotations: (spec.annotations && typeof spec.annotations === 'object') ? spec.annotations : null
		});
	}
	return { tools, routes, problems: assigned.problems };
}

// ---- 3. approval policy ----------------------------------------------------------------------

/**
 * Does this MCP tool call need the approval card?
 *
 * Default is ASK — an MCP tool is third-party code, so autopilot deliberately does NOT relax it (only
 * the user's explicit allow-list does). Server-supplied annotations are UNTRUSTED and may therefore
 * only push toward asking, never toward allowing: a `destructiveHint` overrides an allow-list entry
 * (worst case, one extra prompt), while a `readOnlyHint` grants nothing on its own.
 *
 * @param {string} name       the namespaced tool name (server__tool)
 * @param {object} [policy]   user map, e.g. { 'github__list_issues': 'allow', '*': 'ask' }
 * @param {object} [annotations]  the server's own hints for this tool (untrusted)
 * @returns {{ approve: 'ask'|'allow', reason: string }}
 */
function classifyMcpTool(name, policy, annotations) {
	if (annotations && annotations.destructiveHint === true) {
		return { approve: 'ask', reason: 'the server marks this tool destructive' };
	}
	const p = policy || {};
	const exact = p[name];
	if (exact === 'allow') { return { approve: 'allow', reason: 'allow-listed by you' }; }
	if (exact === 'ask') { return { approve: 'ask', reason: 'set to ask by you' }; }
	const star = p['*'];
	if (star === 'allow') { return { approve: 'allow', reason: 'allow-listed by you (*)' }; }
	return { approve: 'ask', reason: 'third-party tool (default)' };
}

module.exports = {
	loadServerConfig, namespaceToolName, assignToolNames, buildAgentTools, classifyMcpTool,
	BUILTIN_TOOL_NAMES, MAX_TOOL_NAME, MAX_TOOL_DESC, MAX_SERVERS, MAX_TOOLS_PER_SERVER, WORKSPACE_CONFIG_PATH
};
