// The terminal side of LevelCode Shell: the profile, the commands, the visitor's shells and the agent's tab.
//
//   createTerminalSupport({ vscode, runtime, context, config }) -> { dispose() }
//
//   vscode    the extension host's API (injected: the unit tests hand in a stand-in)
//   runtime   createRuntime(...): folders(), createSession(), onAgentRun()
//   context   the ExtensionContext: globalState holds the history, workspaceState the last working folder
//   config    { info, limits } from the runtime; `info.commands` is the program list `help` prints
//
// Settings are read from `levelcode.shell.*` through vscode.workspace each time they matter, so a change in Settings
// applies to the next thing that reads it: revealAgentRuns, historySize.
//
// What this wires up, and the three facts about the workbench that shaped it (all MEASURED in the release build):
//   - the profile provider must stay the FIRST contributed profile: Split Terminal and the fallback of createTerminal
//     instantiate the first one;
//   - ctrl+` is a declarative keybinding in package.json; the built-in toggle shows the panel but does not move the
//     keyboard focus out of the chat, so the command here shows and focuses the terminal;
//   - a terminal made from the '+' menu does not open the panel and takes no focus until it is shown, and showing it at
//     once loses the focus in about one run in five, so it is shown now and again after 250 ms.
// There are no commandsToSkipShell entries: measured to have no effect.
// File links in the output of our terminals are this extension's (links.js): the workbench's own are off.
// @ts-check
'use strict';

const { ShellPty, NAME } = require('./pty');
const { createHistory } = require('./history');
const { createAgentTab } = require('./agent-tab');
const { createLinkProvider } = require('./links');
const sanitize = require('../sanitize');
const { planMounts, toMountPath } = require('../runtime');

const PROFILE_ID = 'levelcode.shell';
const CWD_KEY = 'levelcode.shell.cwd';
/** Showing a terminal that was just made is repeated after this long to take the focus back (see above). */
const REFOCUS_MS = 250;

/**
 * @param {{
 *   vscode: any,
 *   runtime: any,
 *   context: any,
 *   config?: { info?: { commands: string[] } },
 *   getRandomValues?: (a: Uint8Array) => Uint8Array,
 *   timers?: { setTimeout(fn: () => void, ms: number): any, clearTimeout(h: any): void, now(): number },
 * }} opts
 * @returns {{ dispose(): void }}
 */
function createTerminalSupport(opts) {
	const { vscode, runtime, context } = opts;
	const info = opts.config && opts.config.info;
	const timers = opts.timers || { setTimeout: (/** @type {() => void} */ fn, /** @type {number} */ ms) => setTimeout(fn, ms), clearTimeout: (/** @type {any} */ h) => clearTimeout(h), now: () => Date.now() };
	const getRandomValues = opts.getRandomValues || ((/** @type {Uint8Array} */ a) => /** @type {any} */ (globalThis).crypto.getRandomValues(a));

	/** @param {string} key @param {any} fallback */
	const setting = (key, fallback) => {
		try {
			const v = vscode.workspace.getConfiguration('levelcode.shell').get(key, fallback);
			return v === undefined ? fallback : v;
		} catch (e) { return fallback; }
	};

	const disposables = /** @type {Array<{ dispose(): void }>} */ ([]);
	const history = createHistory({ store: context && context.globalState, cap: setting('historySize', 1000) });
	/** The last time any of our shells heard a key: the agent's tab does not take the panel from someone typing. */
	const activity = { lastInput: -Infinity };

	/** @type {Set<{ terminal: any, session: any }>} */
	const shells = new Set();
	/** Terminals the profile provider made, until the workbench has opened them: pty -> its session and name. */
	const profileShells = new Map();
	let lastCwd = /** @type {string | undefined} */ (context && context.workspaceState ? context.workspaceState.get(CWD_KEY) : undefined);

	/** Show a terminal and take the focus; the second call is the one that survives the quick pick closing. @param {any} terminal */
	function reveal(terminal) {
		try { terminal.show(false); } catch (e) { return; }
		timers.setTimeout(() => {
			try { terminal.show(false); } catch (e) { /* closed in the meantime */ }
		}, REFOCUS_MS);
	}

	function nextName() {
		const used = new Set();
		for (const s of shells) { used.add(s.terminal.name); }
		for (const p of profileShells.values()) { used.add(p.name); }
		if (!used.has(NAME)) { return NAME; }
		for (let n = 2; ; n++) { if (!used.has(NAME + ' (' + n + ')')) { return NAME + ' (' + n + ')'; } }
	}

	/** The folder a new shell starts in: the one the active LevelCode shell is in, else where the last one was. */
	function startDir() {
		const active = vscode.window.activeTerminal;
		for (const s of shells) { if (s.terminal === active) { return s.session.cwd; } }
		return lastCwd;
	}

	/**
	 * The workspace folders as the shell sees them: a session's cwd is a path in the engine, and a folder whose root the
	 * engine cannot hold (the file system's root, /tmp, a folder inside another) is mounted under /mnt. The prompt
	 * names a folder by the mount, so the label is the folder's name wherever it was put.
	 */
	function mountedFolders() {
		const list = runtime.folders();
		// `origin` is where the folder is in the workspace: two folders of one name are told apart by what they are in
		try { return planMounts(list).map((m) => ({ name: m.name, root: m.mount, origin: m.root })); } catch (e) { return list; }
	}

	/** One shell: its session, its pty and the options the workbench makes the terminal from. */
	function build() {
		const session = runtime.createSession({ cwd: startDir() });
		const pty = new ShellPty({
			vscode,
			session,
			history,
			sanitize,
			folders: mountedFolders,
			info,
			getRandomValues,
			setTimeout: timers.setTimeout,
			clearTimeout: timers.clearTimeout,
			onInput: () => { activity.lastInput = timers.now(); },
			onCwd: (cwd) => {
				lastCwd = cwd;
				try {
					const r = context && context.workspaceState ? context.workspaceState.update(CWD_KEY, cwd) : undefined;
					// update() answers with a Thenable, and a storage that is full or gone rejects it
					if (r && typeof r.then === 'function') { r.then(undefined, () => { /* not worth an unhandled rejection */ }); }
				} catch (e) { /* not worth failing a command for */ }
			},
		});
		const options = {
			name: nextName(),
			pty,
			iconPath: new vscode.ThemeIcon('terminal'),
			shellIntegrationNonce: pty.nonce,
		};
		return { pty, session, options };
	}

	function createShell() {
		const b = build();
		const terminal = vscode.window.createTerminal(b.options);
		shells.add({ terminal, session: b.session });
		reveal(terminal);
	}

	/* ---------------------------------------------------------------------------------------------- the profile */

	disposables.push(vscode.window.registerTerminalProfileProvider(PROFILE_ID, {
		provideTerminalProfile() {
			const b = build();
			profileShells.set(b.pty, { session: b.session, name: b.options.name });
			return new vscode.TerminalProfile(b.options);
		},
	}));

	// A terminal made from the '+' menu is not shown by the workbench; the one made by our own command is shown above.
	disposables.push(vscode.window.onDidOpenTerminal((/** @type {any} */ terminal) => {
		const pty = terminal && terminal.creationOptions && terminal.creationOptions.pty;
		const made = pty && profileShells.get(pty);
		if (!made) { return; }
		profileShells.delete(pty);
		shells.add({ terminal, session: made.session });
		reveal(terminal);
	}));

	disposables.push(vscode.window.onDidCloseTerminal((/** @type {any} */ terminal) => {
		for (const s of Array.from(shells)) {
			if (s.terminal === terminal) { shells.delete(s); }
		}
	}));

	/* ---------------------------------------------------------------------------------------------- commands */

	const agent = createAgentTab({
		vscode,
		runtime,
		sanitize,
		getMode: () => String(setting('revealAgentRuns', 'firstRun')),
		activity,
		now: timers.now,
	});

	// The links are ours alone: a line is only ever looked at when the terminal it is in is one of ours.
	if (typeof vscode.window.registerTerminalLinkProvider === 'function') {
		disposables.push(vscode.window.registerTerminalLinkProvider(createLinkProvider({
			vscode,
			mounts: () => { try { return planMounts(runtime.folders()); } catch (e) { return []; } },
			cwdOf(terminal) {
				for (const s of shells) { if (s.terminal === terminal) { return s.session.cwd; } }
				const tab = agent.terminal();
				if (!tab || tab !== terminal) { return undefined; }
				// the agent's runs are reported in workspace paths; the links are resolved in the engine's
				const cwd = agent.cwd();
				if (!cwd) { return undefined; }
				try { return toMountPath(planMounts(runtime.folders()), cwd) || cwd; } catch (e) { return cwd; }
			},
			setTimeout: timers.setTimeout,
			clearTimeout: timers.clearTimeout,
		})));
	}

	disposables.push(
		vscode.commands.registerCommand('levelcode.shell.new', () => { createShell(); }),

		vscode.commands.registerCommand('levelcode.shell.toggle', () => {
			// The keybinding is guarded by `!terminalFocus`: with a terminal focused the workbench's own toggle hides the
			// panel. Here: show one of ours and give it the focus (the built-in leaves the focus in the chat).
			const active = vscode.window.activeTerminal;
			for (const s of shells) { if (s.terminal === active) { s.terminal.show(false); return; } }
			const first = shells.values().next().value;
			if (first) { first.terminal.show(false); return; }
			createShell();
		}),

		vscode.commands.registerCommand('levelcode.shell.showAgent', () => { agent.show(); }),

		vscode.commands.registerCommand('levelcode.shell.clearHistory', () => {
			history.clear();
			try { if (vscode.window.showInformationMessage) { vscode.window.showInformationMessage('LevelCode Shell: command history cleared.'); } } catch (e) { /* a message is a courtesy */ }
		}),
	);

	if (vscode.workspace && typeof vscode.workspace.onDidChangeConfiguration === 'function') {
		disposables.push(vscode.workspace.onDidChangeConfiguration((/** @type {any} */ e) => {
			if (e && typeof e.affectsConfiguration === 'function' && e.affectsConfiguration('levelcode.shell.historySize')) {
				history.setCap(setting('historySize', 1000));
			}
		}));
	}

	return {
		dispose() {
			for (const d of disposables.splice(0)) { try { d.dispose(); } catch (e) { /* on the way out */ } }
			try { agent.dispose(); } catch (e) { /* the same */ }
			for (const s of Array.from(shells)) { try { s.terminal.dispose(); } catch (e) { /* the same */ } }
			shells.clear();
		},
	};
}

module.exports = { createTerminalSupport, PROFILE_ID };
