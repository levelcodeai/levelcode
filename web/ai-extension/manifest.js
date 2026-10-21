// The manifest of levelcode-ai as the browser build ships it.
//
// The desktop manifest promises things a browser tab cannot do: an agent that runs commands, MCP
// servers started as local processes, importing settings from VS Code on this machine, a folder
// of sessions on disk. A browser build that lists them would offer a command that always fails
// and a setting that does nothing. So the browser manifest is the desktop one with those removed,
// and a welcome page that says what is here. Nothing in the desktop manifest changes.
//
// Plain CommonJS so the gate can run it (web/test/unit/manifest.test.js) and build.mjs can load it.
'use strict';

/** Commands that need a machine, or a part of LevelCode that is not in the browser build. */
const REMOVED_COMMANDS = new Set([
	'levelcode.customize',          // the customization pack is a desktop extension
	'levelcode.import.vscode',      // reads another editor's settings from this machine's disk
	'levelcode.ai.manageMcp',       // MCP servers are local processes
	'levelcode.ai.sketch',          // Agent Sketch has not been run in the browser
	'levelcode.ai.setWebSearchKey', // an own search key is used from the desktop only; a tab searches through LevelCode Cloud
]);

/** Settings that only mean something with a local disk, a local model server or a program that serves a page. */
const REMOVED_SETTINGS = new Set([
	'levelcode.ai.preview.autoOpen',
	'levelcode.ai.mcp.servers',
	'levelcode.ai.mcp.toolPolicy',
	'levelcode.ai.sessions.dir',
	'levelcode.ai.ollama.url',
	'levelcode.ai.ollama.model',
	'levelcode.ai.web.searchProvider',   // a tab always searches through LevelCode Cloud (webSearch.cloudBackend)
]);

/**
 * The settings a FOLDER may set. Everything else is application-scoped in the browser edition.
 *
 * The workbench in a tab runs with Workspace Trust off (web/lib/config.mjs), and a setting with no scope is read from the
 * workspace's .vscode/settings.json when there is one. A folder opened from the computer, or a project the agent was
 * asked to read, could then set the account host (levelcode.cloud.endpoint: the session token goes to whatever https
 * host that names), the provider's base URL, Autopilot, the step and token budgets, the verify command. Measured in
 * the real workbench by the shell review (2026-10-11). 'application' scope makes the workbench ignore the workspace's
 * value, so only the user's own settings count.
 *
 * Default-deny: a setting added to the desktop manifest later is application-scoped here until someone puts it on
 * this list, and web/test/unit/manifest.test.js fails if one is on it that does not exist.
 *
 * The desktop manifest opens the same list (scope in extensions/levelcode-ai/package.json, since 2026-10-19: Restricted
 * Mode did not stop a folder there either). extensions/levelcode-ai/test/settingsScope.test.js fails if the two differ.
 *
 * Only things that change what is shown, or which of the open files are offered as context, are listed.
 */
const WORKSPACE_SETTINGS_OK = new Set([
	'levelcode.ai.includeActiveFile',
	'levelcode.ai.chat.autoContext',
	'levelcode.ai.chat.autoContextMaxFiles',
	'levelcode.ai.chat.scopeToActiveProject',
	'levelcode.ai.chat.workspaceMap',
	'levelcode.ai.chat.startLocation',
	'levelcode.ai.chat.fontSize',
	'levelcode.ai.chat.maxImagesPerMessage',
	'levelcode.ai.chat.proseWidth',
	'levelcode.ai.chat.groupActivity',
	'levelcode.ai.diagrams.enabled',
]);

/**
 * Settings the browser keeps, whose desktop description names things a tab does not have (npm, sudo, a process
 * group). Only the text differs; the setting, its type and its default are the desktop's.
 */
const DESCRIPTION_OVERRIDES = {
	'levelcode.ai.commandTimeout': {
		description: 'Backstop timeout in milliseconds before a command in LevelCode Shell is stopped. The Stop button on the command\'s card is the primary control; set 0 to disable the backstop.',
	},
	'levelcode.ai.verify.command': {
		markdownDescription: 'Optional one-shot command run in **LevelCode Shell** to verify the agent\'s edits (e.g. `! grep -rn TODO src`, which fails while any TODO is left, or `sh check.sh` for a script of your own). It must exit on its own. Leave empty to verify with editor diagnostics only.',
	},
	'levelcode.ai.agent.autopilot': {
		description: 'Autopilot: let the agent run commands without asking, and prefer verifying its own work over pausing to ask you. It still stops and asks before deleting files. File edits stay reviewable with Keep/Undo either way. Off by default.',
	},
};

const WELCOME = {
	id: 'welcome',
	title: 'Welcome to LevelCode',
	description: 'Your AI code editor, in a browser tab. Sign in and start.',
	steps: [
		{
			id: 'ai',
			title: 'Connect your AI',
			description: 'Chat with your files as context, get inline completions as you type, and let the agent read, search, create and edit files in your workspace and run shell commands over them. **Sign in and you are on your plan**, with no API key to manage. Prefer your own? Bring a key for Claude, OpenAI, Groq, Mistral and more.\n[Sign in to LevelCode](command:levelcode.ai.account)\n[Use your own key (BYOK)](command:levelcode.ai.setApiKey)\n[Pick a model](command:levelcode.ai.pickModel)\n[Open the chat](command:levelcode.ai.focus)',
			media: { svg: 'media/walkthrough/ai.svg', altText: 'Chat, inline completions and an agent built into the editor' },
			completionEvents: ['onCommand:levelcode.ai.setApiKey', 'onCommand:levelcode.ai.account'],
		},
		{
			id: 'files',
			title: 'Open your files',
			description: 'Work in the scratch workspace, which is saved in this browser, or open a folder from your computer (Chrome and Edge) and the agent edits it in place.\n[Open a folder from your computer](command:levelcode.web.openLocalFolder)\n[Go to the scratch workspace](command:levelcode.web.openScratch)\n[Choose a theme](command:workbench.action.selectTheme)',
			media: { svg: 'media/walkthrough/look.svg', altText: 'Themes and workspaces' },
			completionEvents: ['onCommand:levelcode.web.openLocalFolder'],
		},
		{
			id: 'limits',
			title: 'What stays in the Mac app',
			description: 'The browser edition has a shell over your workspace files (cat, grep, sed, find, jq and the like), but it starts no programs: no node, npm, git or python, no servers, and no local MCP servers. The agent can read, search, create, edit and delete files, and run shell commands over them. For the rest, [get the Mac app](https://levelcode.ai/download).',
			media: { svg: 'media/walkthrough/updates.svg', altText: 'LevelCode for Mac' },
		},
	],
};

/**
 * @param {any} pkg the desktop package.json
 * @param {{ entry?: string }} [opts]
 * @returns {any} a new object; `pkg` is not modified
 */
function toWebManifest(pkg, opts) {
	const out = JSON.parse(JSON.stringify(pkg));
	out.browser = (opts && opts.entry) || './extension.web.js';
	const c = out.contributes || (out.contributes = {});

	if (Array.isArray(c.commands)) { c.commands = c.commands.filter((x) => !REMOVED_COMMANDS.has(x.command)); }
	for (const [where, items] of Object.entries(c.menus || {})) {
		c.menus[where] = items.filter((m) => !REMOVED_COMMANDS.has(m.command));
	}
	if (Array.isArray(c.keybindings)) {
		c.keybindings = c.keybindings.filter((k) => !REMOVED_COMMANDS.has(k.command));
		// Windows and Linux browsers keep Ctrl+Shift+I for developer tools, and the page never sees it.
		c.keybindings.push({ command: 'levelcode.ai.focus', key: 'ctrl+alt+i', when: 'isWeb && !isMac' });
	}
	if (c.configuration) {
		const sections = Array.isArray(c.configuration) ? c.configuration : [c.configuration];
		for (const s of sections) {
			for (const k of Object.keys(s.properties || {})) { if (REMOVED_SETTINGS.has(k)) { delete s.properties[k]; } }
			for (const [k, o] of Object.entries(DESCRIPTION_OVERRIDES)) { if (s.properties && s.properties[k]) { Object.assign(s.properties[k], o); } }
			for (const [k, def] of Object.entries(s.properties || {})) {
				if (!WORKSPACE_SETTINGS_OK.has(k) && def && typeof def === 'object' && !def.scope) { def.scope = 'application'; }
			}
		}
	}
	c.walkthroughs = [JSON.parse(JSON.stringify(WELCOME))];
	if (Array.isArray(out.activationEvents)) {
		out.activationEvents = out.activationEvents.filter((e) => !(e.startsWith('onCommand:') && REMOVED_COMMANDS.has(e.slice('onCommand:'.length))));
	}
	return out;
}

module.exports = { toWebManifest, REMOVED_COMMANDS, REMOVED_SETTINGS, WORKSPACE_SETTINGS_OK, DESCRIPTION_OVERRIDES, WELCOME };
