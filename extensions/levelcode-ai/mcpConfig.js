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
 * incidental — this makes it structural.
 *
 * The unsafe keys (`__proto__`/`constructor`/`prototype`) are DROPPED outright — never copied to the
 * output — so none can reach the prototype setter. Note this is a drop, not a rescue: a key literally
 * named `__proto__` does not survive into the result. That is deliberate. Such a name is meaningless as
 * an env var and unused as a top-level JSON-Schema keyword, so losing it costs nothing, whereas copying
 * it would be exactly the pollution we are guarding against. Deliberately a normal object, not
 * Object.create(null): later code (and tests) may reasonably call hasOwnProperty on it.
 */
function safeCopy(raw) {
	const out = {};
	for (const k of Object.keys(raw || {})) {
		if (UNSAFE_KEYS.indexOf(k) !== -1) { continue; }   // dropped, not copied — see the doc above
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

/**
 * The value of a VS Code setting as authored BY THE USER — its global (user-settings) tier only,
 * deliberately ignoring the workspace and workspace-folder tiers.
 *
 * The whole MCP trust model rests on "user-authored = trusted, repo-authored = untrusted", and I had it
 * half-right: `.levelcode/mcp.json` is gated, but I missed that VS Code SETTINGS have a repo-authored
 * tier too — a committed `.vscode/settings.json` (or a folder in a `.code-workspace`) can set
 * `levelcode.ai.mcp.servers`, and a plain `cfg.get()` returns that merged value. Trusting it would spawn
 * arbitrary processes on clone-and-open — the exact RCE the model exists to prevent (PR #31 review).
 *
 * These settings are ALSO declared `application`-scoped in package.json, which already makes VS Code drop
 * any workspace value. This is the belt to that suspenders: the spawn decision is too dangerous to rest
 * on a declarative manifest guard alone, so the trust boundary is enforced here too, at the point of use,
 * and survives a scope regression. Takes a `getConfiguration().inspect(key)` result so it stays pure and
 * unit-testable off the editor.
 *
 * @param {{globalValue?:any}|undefined|null} info  a VS Code inspect() result
 * @param {any} fallback  returned when the user has not set it (workspace/folder values are NOT a fallback)
 */
function userScopedSetting(info, fallback) {
	if (!info || info.globalValue === undefined) { return fallback; }
	return info.globalValue;
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
 * Could `name` have come out of namespaceToolName? The guard for anything that PERSISTS a tool name —
 * today, "Always allow" writing a key into `levelcode.ai.mcp.toolPolicy`.
 *
 * It lives here, beside the function whose output it describes, because the caller was hand-rolling its
 * own regex, and two copies of one naming rule is how they drift apart.
 *
 * namespaceToolName emits exactly two SHAPES, and this accepts those two and nothing else:
 *
 *   1. `server__tool` — the separator survives whenever the joined name fits the cap.
 *   2. `<57 chars>_<6-char hash>` — the truncated form, always exactly MAX_TOOL_NAME long.
 *
 * Shape 2 is why a plain "must contain `__`" test is wrong: when a server's name ALONE reaches the cap,
 * the cut lands inside that first segment and the result carries no separator at all —
 *
 *   namespaceToolName('s'.repeat(70), 'tool')  ->  'sss…sss_a1b2c3'   // 64 chars, no '__'
 *
 * — so requiring one rejects a name this module itself produced, and "Always allow" then silently does
 * nothing for that server. Checking the two shapes keeps that case legal while still refusing a bare
 * `read_file` or `x`.repeat(64), which namespacing can never emit and which would only sit inert in the
 * policy map.
 *
 * UNSAFE_KEYS is rejected EXPLICITLY rather than left to fall out of the shape rules, so the protection
 * does not depend on an unrelated rule keeping a particular form.
 */
const LEGAL_NAME = /^[A-Za-z0-9_-]+$/;
// Shape 1. At least one character on EACH side of a separator, because sanitizeSegment never returns
// empty — so `abc__` and `__abc` are not names this module can emit.
//
// A regex rather than the obvious `indexOf('__') > 0` test, and that difference is not cosmetic: a
// server legitimately NAMED `__a` yields `__a__b`, whose FIRST separator sits at index 0. The
// index test rejects it; backtracking here finds the separator at index 3 and accepts.
const SHAPE_NAMESPACED = /^[A-Za-z0-9_-]+__[A-Za-z0-9_-]+$/;
// Shape 2. shortHash is base36, lower-case, padded to 6, and truncation always lands exactly at the cap.
const SHAPE_TRUNCATED = /_[0-9a-z]{6}$/;

function isNamespacedToolName(name) {
	if (typeof name !== 'string') { return false; }
	if (name.length === 0 || name.length > MAX_TOOL_NAME) { return false; }
	if (UNSAFE_KEYS.indexOf(name) !== -1) { return false; }
	if (!LEGAL_NAME.test(name)) { return false; }
	return SHAPE_NAMESPACED.test(name)
		|| (name.length === MAX_TOOL_NAME && SHAPE_TRUNCATED.test(name));
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

/**
 * A description the model can decide on, ALWAYS within MAX_TOOL_DESC. The cap is applied to the final
 * string — the server's own text AND the fallback — because the fallback embeds `tool`, which is the
 * server-chosen (untrusted) tool name: a server could send a giant name with a blank description and,
 * if only the real-description branch were capped, blow past the bound anyway (PR #31 review). One cap
 * at the exit covers every branch.
 */
function describeTool(spec, server, tool) {
	const raw = typeof spec.description === 'string' ? spec.description.trim() : '';
	const desc = raw || ('The "' + tool + '" tool from the "' + server + '" MCP server (no description provided).');
	return desc.length > MAX_TOOL_DESC ? desc.slice(0, MAX_TOOL_DESC - 1) + '…' : desc;
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

/**
 * Per-server counts of the tools ACTUALLY exposed, taken from the routes buildAgentTools emitted — i.e.
 * AFTER the per-server cap and junk-skipping. The startup chip uses this rather than the raw tools/list
 * length, so its per-server numbers reflect what the agent can really call and SUM to the run's real
 * total: a server that lists 100 tools but is capped to 64 must read `(64)`, not `(100)`, or the chip
 * contradicts its own allowed/total denominator (PR #31 review).
 *
 * @param {Map<string,{server:string}>} routes  the routes map from buildAgentTools
 * @returns {Map<string, number>} server name → exposed tool count
 */
function toolCountsByServer(routes) {
	const counts = new Map();
	if (!routes || typeof routes.values !== 'function') { return counts; }
	for (const r of routes.values()) {
		if (!r || typeof r.server !== 'string') { continue; }
		counts.set(r.server, (counts.get(r.server) || 0) + 1);
	}
	return counts;
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
 * `policyCanAllow` answers a question the callers kept getting wrong (PR #31 review): would adding
 * this tool to the allow-list actually grant it? For every ordinary refusal, yes. For a `destructiveHint`
 * refusal, NO — a server hint may only tighten, so the allow-list cannot override it. Callers use this to
 * avoid (a) counting a destructive-but-allow-listed tool as "allow-listed" in the startup chip, and
 * (b) telling the model to allow-list a tool that allow-listing can never enable.
 *
 * @param {string} name       the namespaced tool name (server__tool)
 * @param {object} [policy]   user map, e.g. { 'github__list_issues': 'allow', '*': 'ask' }
 * @param {object} [annotations]  the server's own hints for this tool (untrusted)
 * @returns {{ approve: 'ask'|'allow', reason: string, policyCanAllow: boolean }}
 */
function classifyMcpTool(name, policy, annotations) {
	if (annotations && annotations.destructiveHint === true) {
		return { approve: 'ask', reason: 'the server marks this tool destructive', policyCanAllow: false };
	}
	const p = policy || {};
	const exact = p[name];
	if (exact === 'allow') { return { approve: 'allow', reason: 'allow-listed by you', policyCanAllow: true }; }
	if (exact === 'ask') { return { approve: 'ask', reason: 'set to ask by you', policyCanAllow: true }; }
	const star = p['*'];
	if (star === 'allow') { return { approve: 'allow', reason: 'allow-listed by you (*)', policyCanAllow: true }; }
	return { approve: 'ask', reason: 'third-party tool (default)', policyCanAllow: true };
}

/**
 * The agent-facing explanation for a refused MCP call in a build with no approval card (S3). It lives
 * HERE, beside classifyMcpTool, on purpose: the PR #31 review caught this message telling the model to
 * allow-list a destructive tool that allow-listing can never enable — the message had drifted from the
 * policy. Keeping both in one module (and unit-testing this off the editor) is what stops the drift
 * recurring. Branches solely on the verdict, so it cannot disagree with the classifier.
 *
 * @param {string} name  the namespaced tool name
 * @param {{reason:string, policyCanAllow:boolean}} verdict  from classifyMcpTool (a non-'allow' one)
 * @returns {string}
 */
function explainMcpRefusal(name, verdict) {
	// Reached only when there is NO interactive approval to fall back on (a headless run, a test harness).
	// With a webview present, S4 shows the per-call card instead of this message.
	const head = 'ERROR: the MCP tool "' + name + '" is not approved to run (' + verdict.reason + '). ';
	const fix = verdict.policyCanAllow
		? 'No interactive approval is available here, so the only way to permit it is for the USER to add '
			+ '"' + name + '": "allow" to the "levelcode.ai.mcp.toolPolicy" setting. '
		: 'Such tools always require per-call approval and CANNOT be enabled through the allow-list, so '
			+ 'there is no way to run it in this non-interactive context. ';
	return head + fix + 'Do NOT retry it in this run — continue without it, or tell the user what you needed it for.';
}

// A tool call's arguments can be large, and the approval card must not be blown open by one. See
// describeMcpCall — the card is capped, the full args still reach the server if approved.
const MAX_ARG_CHARS = 2000;

/** Pretty, bounded JSON for the args shown on the approval card. Never throws (circular/huge input). */
function previewArgs(args) {
	if (args == null) { return ''; }
	let text;
	try { text = JSON.stringify(args, null, 2); }
	catch { try { text = String(args); } catch { text = '[unserializable arguments]'; } }
	if (text == null) { return ''; }
	return text.length > MAX_ARG_CHARS ? text.slice(0, MAX_ARG_CHARS - 1) + '…' : text;
}

/**
 * Shape an MCP call for the approval card (S4) — exactly what the user reads before deciding.
 *
 * Unlike the debug log (G4), the arguments are shown in FULL here, only length-capped. That is not an
 * oversight: the card is ephemeral UI shown to the person who owns the credentials, and seeing the real
 * arguments — the repo it will touch, the id it will delete — IS the decision. Redacting them would make
 * the prompt meaningless. Nothing here is persisted; the card is not the transcript.
 *
 * `canAllowAlways` is false for a destructive tool: a server-marked-destructive tool can never be moved
 * to the allow-list (classifyMcpTool tightens on it), so the card must not offer a button that would do
 * nothing. Derived from the same annotation the classifier reads, so the two cannot disagree.
 *
 * @param {string} name  namespaced tool name (server__tool)
 * @param {*} args  the arguments the model produced for this call
 * @param {{server?:string, tool?:string, annotations?:object}} [route]
 * @returns {{server:string, tool:string, argsText:string, destructive:boolean, canAllowAlways:boolean}}
 */
// ---- G1: trust-on-first-use for repo-authored servers ----------------------
// A `.levelcode/mcp.json` entry names a process to spawn, and the file is attacker-controlled for any
// repo you clone. These four functions are the launch gate: fingerprint what would be spawned, compare
// it to what this workspace has already trusted, and describe it for the consent card.

/**
 * A stable fingerprint of what a server entry would actually EXECUTE.
 *
 * Trust is remembered against this, not against the server's NAME, so a repo cannot be granted consent
 * for `npx @modelcontextprotocol/server-filesystem` and then quietly swap in `sh -c 'curl … | sh'` under
 * the same name — the fingerprint changes and the user is asked again.
 *
 * `env` is included, and that is not padding: `NODE_OPTIONS=--require /tmp/evil.js` turns an innocent
 * `node` command into arbitrary code execution without touching command or args. Keys are sorted so an
 * unrelated reordering of the JSON does not spuriously revoke trust.
 */
function launchFingerprint(server) {
	const s = server || {};
	const env = s.env || {};
	const envPairs = Object.keys(env).sort().map((k) => k + '=' + String(env[k]));
	return shortHash(JSON.stringify([String(s.command || ''), (s.args || []).map(String), envPairs]));
}

/**
 * Has THIS workspace already approved launching exactly this server?
 *
 * `store` is a plain `{ serverName: fingerprint }` map held in workspaceState, so trust is per-workspace
 * by construction: approving a server in one repo says nothing about another repo that happens to
 * declare a server by the same name.
 */
function isLaunchTrusted(server, store) {
	if (!server || !server.name) { return false; }
	const known = store && store[server.name];
	return typeof known === 'string' && known === launchFingerprint(server);
}

/** Record trust for one server. Pure: returns the new store, so the caller owns persistence. */
function rememberLaunchTrust(server, store) {
	const next = safeCopy(store || {});
	if (server && server.name) { next[server.name] = launchFingerprint(server); }
	return next;
}

/**
 * The consent card's data. docs/MCP.md G1: "shows the literal command line — no summarizing."
 *
 * So `commandLine` is the real thing, quoted only where an argument contains a space (otherwise
 * `--path /a b` reads as two arguments when it is one). Env is surfaced separately as NAME=value,
 * because it is part of the execution surface the user is consenting to and hiding it would make the
 * card a half-truth.
 */
function describeMcpLaunch(server) {
	const s = server || {};
	const quote = (a) => (/[\s"']/.test(String(a)) ? JSON.stringify(String(a)) : String(a));
	const env = s.env || {};
	const envLines = Object.keys(env).sort().map((k) => k + '=' + String(env[k]));
	return {
		server: String(s.name || ''),
		origin: String(s.origin || ''),
		commandLine: [String(s.command || '')].concat((s.args || []).map(quote)).join(' '),
		envLines: envLines,
		fingerprint: launchFingerprint(s)
	};
}

function describeMcpCall(name, args, route) {
	const r = route || {};
	const fallback = String(name == null ? '' : name).split(NAME_SEPARATOR);
	const server = typeof r.server === 'string' && r.server ? r.server : (fallback[0] || String(name));
	const tool = typeof r.tool === 'string' && r.tool ? r.tool : (fallback.slice(1).join(NAME_SEPARATOR) || String(name));
	const destructive = !!(r.annotations && r.annotations.destructiveHint === true);
	return { server, tool, argsText: previewArgs(args), destructive, canAllowAlways: !destructive };
}

module.exports = {
	loadServerConfig, userScopedSetting, namespaceToolName, isNamespacedToolName, assignToolNames,
	buildAgentTools, safeCopy,
	toolCountsByServer, classifyMcpTool, explainMcpRefusal, describeMcpCall,
	launchFingerprint, isLaunchTrusted, rememberLaunchTrust, describeMcpLaunch,
	BUILTIN_TOOL_NAMES, MAX_TOOL_NAME, MAX_TOOL_DESC, MAX_ARG_CHARS, MAX_SERVERS, MAX_TOOLS_PER_SERVER, WORKSPACE_CONFIG_PATH
};
