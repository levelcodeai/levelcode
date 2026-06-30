/*---------------------------------------------------------------------------------------------
 *  Atom++ — Sync
 *
 *  Contributes the `atompp` authentication provider that the editor's BUILT-IN Settings Sync
 *  uses (matched via product.json → configurationSync.store.authenticationProviders). Once
 *  signed in + turned on, the editor syncs settings/keybindings/snippets/theme/MCP/UI-state to
 *  the configured sync server using its own battle-tested engine — we add no sync logic here.
 *
 *  Sign-in is a DEV flow for now (mints a local token); the real loopback+PKCE flow against
 *  Atom++ Cloud (PRD §6.2.3) drops into createSession() later. See docs/atompp-sync-design.md.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

const vscode = require('vscode');
const S = require('./session');

const PROVIDER_ID = 'atompp';
const PROVIDER_LABEL = 'Atom++ Account';
const SECRET_PREFIX = 'atompp.sync.token.'; // + session.id  → token in SecretStorage (keychain)
const META_KEY = 'atompp.sync.sessions';    // globalState → [{id, account, scopes}] (no tokens)

/** @type {vscode.ExtensionContext} */
let ctx;
/** @type {vscode.StatusBarItem} */
let statusItem;
const sessionsChanged = new vscode.EventEmitter();

/** Load full sessions: metadata from globalState + token from SecretStorage. */
async function loadSessions() {
	const meta = S.parseMeta(ctx.globalState.get(META_KEY, '[]'));
	const out = [];
	for (const m of meta) {
		const token = await ctx.secrets.get(SECRET_PREFIX + m.id);
		if (token) { out.push({ id: m.id, accessToken: token, account: m.account, scopes: m.scopes }); }
	}
	return out;
}

async function addSession(session) {
	const sessions = await loadSessions();
	const next = sessions.filter(s => s.id !== session.id).concat([session]);
	await ctx.secrets.store(SECRET_PREFIX + session.id, session.accessToken);
	await ctx.globalState.update(META_KEY, S.serializeMeta(next));
}

async function deleteSession(id) {
	const sessions = await loadSessions();
	const removed = sessions.find(s => s.id === id) || null;
	const next = sessions.filter(s => s.id !== id);
	await ctx.secrets.delete(SECRET_PREFIX + id);
	await ctx.globalState.update(META_KEY, S.serializeMeta(next));
	return removed;
}

async function currentSession() {
	const sessions = await loadSessions();
	return sessions[0] || null;
}

/** @type {vscode.AuthenticationProvider} */
const provider = {
	onDidChangeSessions: sessionsChanged.event,
	async getSessions(scopes) {
		const sessions = await loadSessions();
		return sessions.filter(s => S.scopesMatch(s, scopes ? Array.from(scopes) : undefined));
	},
	async createSession(scopes) {
		const email = await vscode.window.showInputBox({
			title: 'Sign in to Atom++ Sync',
			prompt: 'Your Atom++ account email — dev sign-in for now (real OAuth/PKCE lands later)',
			placeHolder: 'you@example.com',
			ignoreFocusOut: true,
			validateInput: (v) => (S.validateEmail(v) ? undefined : 'Enter a valid email address')
		});
		if (!email) { throw new Error('Atom++ Sync sign-in cancelled'); }
		const token = S.mintDevToken(email.trim());
		const session = S.makeSession(email.trim(), token, scopes ? Array.from(scopes) : S.SCOPES);
		await addSession(session);
		sessionsChanged.fire({ added: [session], removed: [], changed: [] });
		updateStatus(session);
		return session;
	},
	async removeSession(sessionId) {
		const removed = await deleteSession(sessionId);
		if (removed) { sessionsChanged.fire({ added: [], removed: [removed], changed: [] }); }
		updateStatus(null);
	}
};

function updateStatus(sessionOrNull) {
	if (!statusItem) { return; }
	if (!vscode.workspace.getConfiguration('atompp.sync').get('showStatusBar', true)) {
		statusItem.hide();
		return;
	}
	if (sessionOrNull) {
		statusItem.text = '$(sync) ' + sessionOrNull.account.label;
		statusItem.tooltip = 'Atom++ Sync — signed in. Click for status.';
		statusItem.command = 'atompp.sync.status';
	} else {
		statusItem.text = '$(sync-ignored) Atom++ Sync';
		statusItem.tooltip = 'Atom++ Sync — not signed in. Click to set up.';
		statusItem.command = 'atompp.sync.setUp';
	}
	statusItem.show();
}

async function activate(context) {
	ctx = context;

	// Registered here (onStartupFinished) so the status bar reflects state at launch — but also
	// lazily on demand: when Settings Sync requests a session, the implicit
	// `onAuthenticationRequest:atompp` activation fires, so timing relative to sync is never a concern.
	context.subscriptions.push(
		vscode.authentication.registerAuthenticationProvider(PROVIDER_ID, PROVIDER_LABEL, provider, { supportsMultipleAccounts: false })
	);

	statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 50);
	context.subscriptions.push(statusItem);
	updateStatus(await currentSession());

	context.subscriptions.push(vscode.commands.registerCommand('atompp.sync.signIn', async () => {
		const session = await vscode.authentication.getSession(PROVIDER_ID, S.SCOPES, { createIfNone: true });
		if (session) { vscode.window.showInformationMessage('Atom++ Sync: signed in as ' + session.account.label + '.'); }
	}));

	context.subscriptions.push(vscode.commands.registerCommand('atompp.sync.setUp', async () => {
		const session = await vscode.authentication.getSession(PROVIDER_ID, S.SCOPES, { createIfNone: true });
		if (!session) { return; }
		// Hand off to the editor's built-in Settings Sync (uses our provider + product.json store).
		try {
			await vscode.commands.executeCommand('workbench.userDataSync.actions.turnOn');
		} catch (e) {
			vscode.window.showWarningMessage(
				'Signed in. Now run "Settings Sync: Turn On" to start syncing. (' + (e && e.message ? e.message : String(e)) + ')'
			);
		}
	}));

	context.subscriptions.push(vscode.commands.registerCommand('atompp.sync.signOut', async () => {
		const session = await currentSession();
		if (!session) { vscode.window.showInformationMessage('Atom++ Sync: not signed in.'); return; }
		await provider.removeSession(session.id);
		vscode.window.showInformationMessage('Atom++ Sync: signed out.');
	}));

	context.subscriptions.push(vscode.commands.registerCommand('atompp.sync.status', async () => {
		const session = await currentSession();
		vscode.window.showInformationMessage(
			session
				? 'Atom++ Sync: signed in as ' + session.account.label + '. Sync server is configured in product.json → configurationSync.store.'
				: 'Atom++ Sync: not signed in. Run "Atom++ Sync: Set Up Sync".'
		);
	}));

	context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(async (e) => {
		if (e.affectsConfiguration('atompp.sync.showStatusBar')) { updateStatus(await currentSession()); }
	}));
}

function deactivate() { }

module.exports = { activate, deactivate };
