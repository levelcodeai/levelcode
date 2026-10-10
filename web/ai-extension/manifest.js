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
]);

/** Settings that only mean something with a shell, a local disk or a local model server. */
const REMOVED_SETTINGS = new Set([
	'levelcode.ai.commandTimeout',
	'levelcode.ai.verify.command',
	'levelcode.ai.preview.autoOpen',
	'levelcode.ai.mcp.servers',
	'levelcode.ai.mcp.toolPolicy',
	'levelcode.ai.sessions.dir',
	'levelcode.ai.ollama.url',
	'levelcode.ai.ollama.model',
]);

const WELCOME = {
	id: 'welcome',
	title: 'Welcome to LevelCode',
	description: 'Your AI code editor, in a browser tab. Sign in and start.',
	steps: [
		{
			id: 'ai',
			title: 'Connect your AI',
			description: 'Chat with your files as context, get inline completions as you type, and let the agent read, search, create and edit files in your workspace. **Sign in and you are on your plan**, with no API key to manage. Prefer your own? Bring a key for Claude, OpenAI, Groq, Mistral and more.\n[Sign in to LevelCode](command:levelcode.ai.account)\n[Use your own key (BYOK)](command:levelcode.ai.setApiKey)\n[Pick a model](command:levelcode.ai.pickModel)\n[Open the chat](command:levelcode.ai.focus)',
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
			description: 'The browser edition has no terminal, runs no commands, and starts no local MCP servers. The agent can read, search, create, edit and delete files. For the rest, [get the Mac app](https://levelcode.ai/download).',
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
		}
	}
	c.walkthroughs = [JSON.parse(JSON.stringify(WELCOME))];
	if (Array.isArray(out.activationEvents)) {
		out.activationEvents = out.activationEvents.filter((e) => !(e.startsWith('onCommand:') && REMOVED_COMMANDS.has(e.slice('onCommand:'.length))));
	}
	return out;
}

module.exports = { toWebManifest, REMOVED_COMMANDS, REMOVED_SETTINGS, WELCOME };
