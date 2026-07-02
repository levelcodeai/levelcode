/*---------------------------------------------------------------------------------------------
 *  Atom++ — Agent Sketch  [SK1: the visual agent-orchestration canvas]
 *
 *  Sketch an agentic flow on a canvas: drop specialized agents (sketch/agentCatalog.js — 96
 *  ruflo-derived archetypes), wire them into a DAG, hit Run. Each node executes ONE turn on
 *  Atom++'s own multi-provider layer (providers.streamAgentTurn with no tools — text in/out),
 *  BYO-key, direct to the provider. Levels run in parallel, chains in sequence (sketch/graph.js).
 *
 *  The monitoring story (why this exists): every node reports REAL token usage (from the P2
 *  usage plumbing) and a cost estimate (sketch/pricing.js), totals roll up live, and the
 *  what-if selector re-prices the whole flow on a different model without re-running it.
 *
 *  SK1 scope: single-turn nodes, no file/command tools inside sketch runs (the chat agent keeps
 *  that); persistence in workspace .atompp/sketches/*.json. Tool-using sketch nodes = SK2.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
"use strict";

const vscode = require("vscode");
const path = require("path");
const fs = require("fs");
const providers = require("./providers/index");
const catalog = require("./providers/catalog");
const { AGENT_GROUPS, AGENTS, AGENT_BY_ID } = require("./sketch/agentCatalog");
const graph = require("./sketch/graph");
const pricing = require("./sketch/pricing");
const {
  TEMPLATES,
  TEMPLATE_INDEX,
  TEMPLATE_BY_ID,
} = require("./sketch/templates");

/** Default model per {provider → tier}. Anything unlisted falls back to the provider's active model. */
const MODEL_TIERS = {
  claude: {
    fast: "claude-haiku-4-5-20251001",
    balanced: "claude-sonnet-4-6",
    powerful: "claude-opus-4-8",
  },
  openai: { fast: "gpt-4o-mini", balanced: "gpt-4o", powerful: "gpt-4o" },
  openrouter: {
    fast: "google/gemini-2.0-flash-001",
    balanced: "anthropic/claude-sonnet-4-6",
    powerful: "anthropic/claude-opus-4-8",
  },
  groq: {
    fast: "llama-3.1-8b-instant",
    balanced: "llama-3.3-70b-versatile",
    powerful: "llama-3.3-70b-versatile",
  },
  deepseek: {
    fast: "deepseek-chat",
    balanced: "deepseek-chat",
    powerful: "deepseek-chat",
  },
  mistral: {
    fast: "codestral-latest",
    balanced: "mistral-large-latest",
    powerful: "mistral-large-latest",
  },
};

const NODE_MAX_TOKENS = 8192; // per-TURN output cap
const MAX_NODE_TURNS = 8; // auto-continue up to this many turns so a node's work is never truncated
const PATCH_CONTEXT_MAX_CHARS = 120 * 1024;

const REVIEW_AGENT_IDS = new Set([
  "code-analyzer",
  "security-auditor",
  "perf-analyzer",
  "reviewer",
]);

/** @type {vscode.WebviewPanel | undefined} */
let panel;
/** @type {AbortController | null} */
let runAbort = null;

function post(msg) {
  if (panel) {
    panel.webview.postMessage(msg);
  }
}

// ---- persistence: workspace .atompp/sketches/<name>.json -------------------------------------
function sketchesDir() {
  const f = vscode.workspace.workspaceFolders;
  if (!f || !f.length) {
    return null;
  }
  return path.join(f[0].uri.fsPath, ".atompp", "sketches");
}
function safeName(name) {
  return (
    String(name || "untitled")
      .replace(/[^\w.-]+/g, "-")
      .slice(0, 60) || "untitled"
  );
}
function saveSketch(sketch) {
  const dir = sketchesDir();
  if (!dir) {
    throw new Error(
      "Open a folder to save sketches (they live in .atompp/sketches/).",
    );
  }
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, safeName(sketch.name) + ".json");
  fs.writeFileSync(file, JSON.stringify(sketch, null, 2));
  return file;
}
function listSketches() {
  const dir = sketchesDir();
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.slice(0, -5));
  } catch {
    return [];
  }
}
function loadSketch(name) {
  const dir = sketchesDir();
  const raw = fs.readFileSync(path.join(dir, safeName(name) + ".json"), "utf8");
  return JSON.parse(raw);
}

// ---- system prompt for a sketch node ---------------------------------------------------------
function nodeSystem(node) {
  const a = AGENT_BY_ID.get(node.agentId);
  const role = a ? a.description : "a specialized software agent";
  return (
    'You are the "' +
    (node.label || node.agentId) +
    '" agent inside a multi-agent flow sketched in the Atom++ editor. ' +
    "Your role: " +
    role +
    ". " +
    "You receive the flow's goal and the outputs of upstream agents; produce YOUR contribution as clear, " +
    "self-contained text (or code) that downstream agents can build on. Be focused and concrete — no preamble, " +
    "no meta-commentary about the flow itself."
  );
}

/**
 * Run ONE sketch node to completion — never truncated. streamAgentTurn caps a single turn at
 * NODE_MAX_TOKENS; if the model stops on "max_tokens" we feed its own partial back and tell it to
 * continue, accumulating text + usage across up to MAX_NODE_TURNS turns. So a node that needs more
 * than one turn's worth of output (a whole code module, a long design) keeps going instead of
 * losing its work at the cap. onProgress fires after each continuation so the UI can show it.
 * @returns {Promise<{text:string, usage:{input:number,output:number}, stop:string, turns:number}>}
 */
async function runNodeTurn(o) {
  const { req, model, system, userMsg, signal, onText, onProgress } = o;
  const messages = [{ role: "user", content: userMsg }];
  let full = "";
  const usage = { input: 0, output: 0 };
  let stop = "max_tokens";
  let turns = 0;
  while (turns < MAX_NODE_TURNS) {
    turns++;
    const before = full.length;
    const turn = await providers.streamAgentTurn({
      providerId: req.providerId,
      baseURL: req.baseURL,
      apiKey: req.apiKey,
      model,
      maxTokens: NODE_MAX_TOKENS,
      system,
      messages,
      signal,
      onText: (t) => {
        full += t;
        if (onText) onText(t);
      },
    });
    let piece = full.slice(before);
    if (!piece) {
      piece = (turn.content || [])
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("");
      full += piece;
    }
    const u = turn.usage || {};
    usage.input +=
      (u.input_tokens || 0) +
      (u.cache_read_input_tokens || 0) +
      (u.cache_creation_input_tokens || 0);
    usage.output += u.output_tokens || 0;
    stop = turn.stop_reason;
    if (stop !== "max_tokens" || signal.aborted) {
      break;
    }
    // A turn can hit the cap while emitting NO text (e.g. it spent the whole budget on hidden
    // reasoning). There's nothing to continue from, and pushing an empty assistant message would
    // 400 on the Anthropic path and be miscaught as a node failure that halts the graph — so stop
    // here and let it surface as a genuine truncation.
    if (!piece.trim()) {
      break;
    }
    // Continue from exactly where it stopped, without repeating.
    messages.push({ role: "assistant", content: piece });
    messages.push({
      role: "user",
      content:
        "You were cut off at the token limit. Continue exactly where you left off — do NOT repeat any text you already produced, just carry on from the last character.",
    });
    if (onProgress) {
      onProgress({ turns, output: usage.output });
    }
  }
  return { text: full, usage, stop, turns };
}

/** Resolve the model a node runs on: explicit per-node override → tier default → provider's active model. */
function nodeModel(node, providerId, activeModel) {
  if (node.model) {
    return node.model;
  }
  const a = AGENT_BY_ID.get(node.agentId);
  const tier = (a && a.tier) || "balanced";
  const tiers = MODEL_TIERS[providers.normId(providerId)];
  return (tiers && tiers[tier]) || activeModel;
}

/** Built-in model ids for a provider (empty ⇒ open-ended provider like custom/ollama — trust any id). */
function activeProviderModelIds(providerId) {
  const norm = providers.normId(providerId);
  const p = (providers.listProviders() || []).find((x) => x.id === norm);
  return (p && p.models ? p.models : []).map((m) => m.id);
}

function isReviewSwarmNode(node) {
  return !!(node && REVIEW_AGENT_IDS.has(node.agentId));
}

/**
 * For review swarms, automatically load a patch from the opened workspace so nodes can
 * analyze real diff content without asking the user to paste it into chat.
 * @returns {Promise<string>} A context block to append to the node input (possibly empty).
 */
async function loadWorkspacePatchContext() {
  const folders = vscode.workspace.workspaceFolders || [];
  if (!folders.length) {
    return "";
  }

  const exclude =
    "{**/node_modules/**,**/.git/**,**/out/**,**/dist/**,**/.next/**,**/VSCode-darwin-*/**,**/vscode/**}";
  const exact = await vscode.workspace.findFiles("**/diff.patch", exclude, 20);
  const generic = await vscode.workspace.findFiles(
    "**/*.{patch,diff}",
    exclude,
    80,
  );
  const all = [...exact, ...generic];
  if (!all.length) {
    const roots = folders
      .map((f) => vscode.workspace.asRelativePath(f.uri, false))
      .join(", ");
    return (
      "Workspace patch lookup:\nNo .patch/.diff file found in the opened workspace roots (" +
      roots +
      ")."
    );
  }

  const seen = new Set();
  const unique = [];
  for (const u of all) {
    const k = u.toString();
    if (!seen.has(k)) {
      seen.add(k);
      unique.push(u);
    }
  }
  unique.sort((a, b) => {
    const an = path.basename(a.fsPath).toLowerCase();
    const bn = path.basename(b.fsPath).toLowerCase();
    const ap = an === "diff.patch" ? 0 : an.endsWith(".patch") ? 1 : 2;
    const bp = bn === "diff.patch" ? 0 : bn.endsWith(".patch") ? 1 : 2;
    if (ap !== bp) {
      return ap - bp;
    }
    return (
      vscode.workspace.asRelativePath(a).length -
      vscode.workspace.asRelativePath(b).length
    );
  });

  const pick = unique[0];
  let body = "";
  try {
    const doc = await vscode.workspace.openTextDocument(pick);
    body = doc.getText();
  } catch {
    return (
      "Workspace patch lookup:\nFound a patch candidate at `" +
      vscode.workspace.asRelativePath(pick) +
      "`, but it could not be read."
    );
  }

  if (!body.trim()) {
    return (
      "Workspace patch lookup:\nFound patch file `" +
      vscode.workspace.asRelativePath(pick) +
      "`, but it is empty."
    );
  }

  let trimmed = body;
  let note = "";
  if (trimmed.length > PATCH_CONTEXT_MAX_CHARS) {
    note =
      "\n(Note: patch truncated to " +
      PATCH_CONTEXT_MAX_CHARS +
      " characters.)";
    trimmed =
      trimmed.slice(0, PATCH_CONTEXT_MAX_CHARS) + "\n... (truncated) ...";
  }

  return (
    "Workspace patch lookup:\nLoaded patch from `" +
    vscode.workspace.asRelativePath(pick) +
    "`." +
    note +
    "\n\n```diff\n" +
    trimmed +
    "\n```"
  );
}

// ---- the runner -------------------------------------------------------------------------------
/** @param {{sketch:any, deps:any}} o  deps = { prepProviderRequest } from extension.js */
async function runSketch(o) {
  const { sketch, deps } = o;
  const nodes = sketch.nodes || [],
    edges = sketch.edges || [];
  const check = graph.validateGraph(nodes, edges);
  if (!check.ok) {
    post({ type: "runError", message: check.error });
    return;
  }

  // Reentrancy guard: claim the run slot SYNCHRONOUSLY, before any await, so a double-clicked
  // Run (the button only disables after the runStart round-trip) can't spawn a second run that
  // overwrites runAbort — which would make Stop unable to abort the first (paid) run.
  if (runAbort) {
    post({ type: "runError", message: "A run is already in progress." });
    return;
  }
  const ac = new AbortController();
  runAbort = ac;
  const signal = ac.signal;
  const clearSlot = () => {
    if (runAbort === ac) {
      runAbort = null;
    }
  };

  try {
    const needsPatchContext = nodes.some((n) => isReviewSwarmNode(n));
    const patchContext = needsPatchContext
      ? await loadWorkspacePatchContext()
      : "";

    const req = await deps.prepProviderRequest({ prompt: true });
    if (!req.ok) {
      clearSlot();
      post({
        type: "runError",
        message:
          req.reason === "key"
            ? "No API key set for " + req.label + "."
            : "Provider not ready (" + (req.reason || "unknown") + ").",
      });
      return;
    }
    if (signal.aborted) {
      clearSlot();
      post({ type: "runDone", aborted: true, failed: false, totals: { input: 0, output: 0 }, usageByNode: {}, outputs: {} });
      return;
    }

    // Per-node model overrides run on the ACTIVE provider — a model from another provider would
    // 400. If the active provider has a known model set and the override isn't in it, fall back
    // to the tier default and tell the user (open-ended providers with no list are trusted as-is).
    const knownModels = new Set(activeProviderModelIds(req.providerId));
    const resolveModel = (node) => {
      const def = nodeModel(node, req.providerId, req.model);
      if (node.model && knownModels.size && !knownModels.has(node.model)) {
        const fallback = nodeModel(
          { agentId: node.agentId },
          req.providerId,
          req.model,
        );
        return {
          model: fallback,
          note:
            'model "' +
            node.model +
            '" isn\'t available on ' +
            req.label +
            " — using " +
            fallback,
        };
      }
      return { model: def, note: "" };
    };

    post({ type: "runStart" });

    const outputs = new Map(); // nodeId → {label, text}
    const usageByNode = new Map(); // nodeId → {input, output, model}
    const byId = new Map(nodes.map((n) => [n.id, n]));
    let failed = false;

    try {
      for (const level of graph.topoLevels(nodes, edges)) {
        if (signal.aborted || failed) {
          break;
        }
        await Promise.all(
          level.map(async (id) => {
            const node = byId.get(id);
            const { model, note } = resolveModel(node);
            post({ type: "nodeStatus", id, status: "running", model, note });
            try {
              const goalWithContext =
                (sketch.goal || "") +
                (patchContext && isReviewSwarmNode(node)
                  ? "\n\n" + patchContext
                  : "");
              const userMsg = graph.buildNodeInput(
                goalWithContext,
                node,
                edges,
                outputs,
              );
              // Run to completion with auto-continuation — the node's work is never truncated.
              const r = await runNodeTurn({
                req,
                model,
                system: nodeSystem(node),
                userMsg,
                signal,
                onText: (t) => post({ type: "nodeDelta", id, text: t }),
                onProgress: (p) =>
                  post({ type: "nodeStatus", id, status: "running", model, turns: p.turns }),
              });
              // Only truly truncated if we exhausted the continuation budget (very large output) —
              // an abort landing between turns also leaves stop==="max_tokens" but isn't truncation.
              const truncated = r.stop === "max_tokens" && !signal.aborted;
              const stored = truncated
                ? r.text +
                  "\n\n[still going after " +
                  r.turns +
                  " turns — stopped at the safety cap; ask this agent to be more concise]"
                : r.text;
              outputs.set(id, { label: node.label || node.agentId, text: stored });
              const usage = { input: r.usage.input, output: r.usage.output, model };
              usageByNode.set(id, usage);
              post({
                type: "nodeDone",
                id,
                usage,
                truncated,
                turns: r.turns,
                cost: pricing.costOf(model, usage.input, usage.output),
                preview: stored.slice(0, 400),
              });
            } catch (e) {
              // A user Stop surfaces here as an abort — that's not a node failure. Only real
              // errors mark the node red and halt scheduling of further levels.
              if (signal.aborted) {
                post({ type: "nodeStatus", id, status: "stopped" });
              } else {
                failed = true;
                post({
                  type: "nodeStatus",
                  id,
                  status: "error",
                  message: String((e && e.message) || e),
                });
              }
            }
          }),
        );
        const totals = graph.totalUsage(usageByNode);
        post({
          type: "runTotals",
          totals,
          usageByNode: Object.fromEntries(usageByNode),
        });
      }
    } finally {
      const totals = graph.totalUsage(usageByNode);
      post({
        type: "runDone",
        aborted: signal.aborted,
        failed: failed && !signal.aborted,
        totals,
        usageByNode: Object.fromEntries(usageByNode),
        outputs: Object.fromEntries([...outputs].map(([k, v]) => [k, v.text])),
      });
    }
  } finally {
    clearSlot();
  }
}

// ---- panel ------------------------------------------------------------------------------------
function getHtml(context) {
  const nonce = String(Math.random()).slice(2) + String(Date.now());
  const csp = [
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    "script-src 'nonce-" + nonce + "'",
  ].join("; ");
  const html = fs.readFileSync(
    path.join(context.extensionPath, "media", "sketch.html"),
    "utf8",
  );
  return html.replace(/__CSP__/g, csp).replace(/__NONCE__/g, nonce);
}

/** Models offered in the per-node override + what-if dropdowns (registry built-ins with prices). */
function modelChoices() {
  const out = [];
  for (const p of providers.listProviders()) {
    for (const m of p.models || []) {
      const price = pricing.modelPricing(m.id);
      out.push({ id: m.id, label: m.label + " · " + p.label, priced: !!price });
    }
  }
  return out;
}

/**
 * Resolve {id → {inM,outM} | null} for every model the webview might price, computed once here
 * with the authoritative pricing matcher. The webview looks up prices by id in this map instead
 * of re-implementing the exact→basename→family matching (which had drifted and mispriced models).
 */
function resolvedPrices() {
  const out = {};
  const add = (id) => {
    if (id && !(id in out)) {
      const p = pricing.modelPricing(id);
      out[id] = p ? { inM: p.inM, outM: p.outM } : null;
    }
  };
  for (const c of modelChoices()) {
    add(c.id);
  }
  for (const tiers of Object.values(MODEL_TIERS)) {
    for (const id of Object.values(tiers)) {
      add(id);
    }
  }
  return out;
}

// ---- board command: natural language → deterministic graph ops --------------------------------
const COMMAND_SYSTEM =
  "You are the board copilot for Atom++ Agent Sketch — a visual multi-agent flow (a DAG of agent " +
  "nodes). The user types an instruction to change the flow; you return ONLY a JSON object " +
  '{"ops":[...]} listing the edits to apply. No prose, no code fence.\n\n' +
  "Op types (reference nodes by their label or id):\n" +
  '- {"type":"add","agent":"<catalog id>","label":"<short>","task":"<optional>","after":"<node?>"}  (after ⇒ connect that node → the new one)\n' +
  '- {"type":"connect","from":"<node>","to":"<node>"}\n' +
  '- {"type":"disconnect","from":"<node>","to":"<node>"}\n' +
  '- {"type":"remove","node":"<node>"}\n' +
  '- {"type":"setModel","scope":"all" | "<agent id>" | "<node>","model":"<model id>"}\n' +
  '- {"type":"setTask","node":"<node>","task":"..."}\n' +
  '- {"type":"setGoal","goal":"..."}\n' +
  '- {"type":"layout"}   (auto-arrange left→right by dependency)\n\n' +
  "Rules: use ONLY agent ids from the provided catalog and model ids from the provided list. " +
  "Keep the DAG acyclic. Prefer the fewest ops that satisfy the instruction. If the instruction " +
  'says something like "change all agents to opus", use one setModel with scope "all" and the ' +
  'matching model id. Return {"ops":[]} if there is nothing to do.';

function summarizeSketch(sketch) {
  const nodes = (sketch.nodes || []).map((n) => ({
    id: n.id,
    label: n.label || n.agentId,
    agent: n.agentId,
    model: n.model || "(tier default)",
  }));
  const edges = (sketch.edges || []).map((e) => e.from + "→" + e.to);
  return JSON.stringify({ goal: sketch.goal || "", nodes, edges });
}

/** Pull an {ops:[...]} array out of a model reply (tolerates code fences / surrounding prose). */
function parseOps(raw) {
  let s = String(raw || "").trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) {
    s = fence[1].trim();
  }
  const a = s.indexOf("{"),
    b = s.lastIndexOf("}");
  if (a < 0 || b < 0) {
    return null;
  }
  try {
    const o = JSON.parse(s.slice(a, b + 1));
    return Array.isArray(o.ops) ? o.ops : null;
  } catch {
    return null;
  }
}

/** Ask the active model to translate a natural-language instruction into graph ops. */
async function boardCommand(o) {
  const { text, sketch, deps } = o;
  const req = await deps.prepProviderRequest({ prompt: true });
  if (!req.ok) {
    post({
      type: "uiError",
      message:
        req.reason === "key"
          ? "No API key set for " + req.label + "."
          : "Provider not ready.",
    });
    return;
  }
  const user =
    "Current sketch:\n" +
    summarizeSketch(sketch) +
    "\n\nAvailable agent ids:\n" +
    AGENTS.map((a) => a.id).join(", ") +
    "\n\nAvailable model ids:\n" +
    modelChoices()
      .map((m) => m.id)
      .join(", ") +
    "\n\nInstruction: " +
    text +
    "\n\nReturn ONLY the JSON object.";
  let raw = "";
  try {
    raw = await providers.complete({
      providerId: req.providerId,
      baseURL: req.baseURL,
      apiKey: req.apiKey,
      model: req.model,
      maxTokens: 2048,
      system: COMMAND_SYSTEM,
      messages: [{ role: "user", content: user }],
    });
  } catch (e) {
    post({ type: "uiError", message: "Command failed: " + String((e && e.message) || e) });
    return;
  }
  const ops = parseOps(raw);
  if (!ops) {
    post({
      type: "uiError",
      message: "Couldn't turn that into board changes — try rephrasing.",
    });
    return;
  }
  post({ type: "commandResult", ops });
}

/** {fast,balanced,powerful} model ids for the current provider — candidates for the what-if panel. */
function activeTierModels(providerId) {
  return MODEL_TIERS[providers.normId(providerId)] || null;
}

/**
 * Open the Agent Sketch panel.
 * @param {vscode.ExtensionContext} context
 * @param {{ prepProviderRequest:(o?:any)=>Promise<any>, aiConfig:()=>any, currentProviderId?:()=>string }} deps
 */
function openSketch(context, deps) {
  if (panel) {
    panel.reveal();
    return;
  }
  panel = vscode.window.createWebviewPanel(
    "atompp.sketch",
    "Agent Sketch",
    vscode.ViewColumn.Active,
    { enableScripts: true, retainContextWhenHidden: true },
  );
  panel.onDidDispose(() => {
    if (runAbort) {
      runAbort.abort();
    }
    panel = undefined;
  });
  panel.webview.html = getHtml(context);

  panel.webview.onDidReceiveMessage(async (m) => {
    try {
      switch (m.type) {
        case "ready": {
          post({
            type: "init",
            groups: AGENT_GROUPS,
            agents: AGENTS,
            models: modelChoices(),
            prices: resolvedPrices(),
            sketches: listSketches(),
            templates: TEMPLATE_INDEX,
            activeTiers: deps.currentProviderId
              ? activeTierModels(deps.currentProviderId())
              : null,
          });
          break;
        }
        case "run":
          await runSketch({ sketch: m.sketch, deps });
          break;
        case "command":
          // Backstop the webview gating: never edit the board while a run holds the abort slot.
          if (runAbort) {
            post({ type: "uiError", message: "Can't edit the board while a run is in progress." });
            break;
          }
          await boardCommand({ text: m.text, sketch: m.sketch, deps });
          break;
        case "stop":
          if (runAbort) {
            runAbort.abort();
          }
          break;
        case "save": {
          const file = saveSketch(m.sketch);
          post({
            type: "saved",
            name: m.sketch.name,
            sketches: listSketches(),
          });
          vscode.window.setStatusBarMessage(
            "Atom++: sketch saved → " + vscode.workspace.asRelativePath(file),
            3000,
          );
          break;
        }
        case "load":
          post({ type: "sketchLoaded", sketch: loadSketch(m.name) });
          break;
        case "loadTemplate": {
          const t = TEMPLATE_BY_ID.get(m.id);
          if (t) {
            post({
              type: "sketchLoaded",
              sketch: JSON.parse(JSON.stringify(t.sketch)),
            });
          }
          break;
        }
        case "copyOutput":
          try {
            await vscode.env.clipboard.writeText(String(m.text || ""));
          } catch {
            /* */
          }
          break;
      }
    } catch (e) {
      // Message-handler failures (save with no folder, load a deleted file, clipboard) are UI
      // errors — NOT run errors. Posting 'runError' here would flip the run UI to "stopped" and
      // re-enable Run mid-run, letting a second run orphan the first. 'uiError' only flashes.
      post({ type: "uiError", message: String((e && e.message) || e) });
    }
  });
}

module.exports = { openSketch };
