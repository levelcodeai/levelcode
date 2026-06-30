/*---------------------------------------------------------------------------------------------
 *  Atom++ — Updater (notify-only)
 *
 *  Polls the update feed (GET {updateUrl}/api/update/{target}/{quality}/{commit}); when a newer
 *  build is advertised, shows a notification with a Download link. It NEVER downloads or applies
 *  anything itself, so it works on any build (including ad-hoc-signed) with no code-signing —
 *  unlike the editor's built-in Squirrel updater. When Developer-ID signing lands, the built-in
 *  updater can take over and this becomes a fallback. See docs/atompp-update-flow.md (U0).
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const U = require('./update');

const LAST_NOTIFIED_KEY = 'atompp.update.lastNotifiedVersion';

/** @type {vscode.ExtensionContext} */
let ctx;
/** @type {NodeJS.Timeout | undefined} */
let timer;

/** Read the packaged product.json (commit / version / updateUrl / quality / downloadUrl). */
function readProduct() {
	try { return JSON.parse(fs.readFileSync(path.join(vscode.env.appRoot, 'product.json'), 'utf8')); }
	catch { return {}; }
}

function cfg() { return vscode.workspace.getConfiguration('atompp.update'); }

/** Resolve the feed base URL: the atompp.update.url setting wins, else product.json updateUrl. */
function feedBase(product) {
	return String(cfg().get('url', '') || product.updateUrl || '').trim();
}

/** Minimal GET that never throws (errors → status 0). */
function httpGet(url) {
	return new Promise((resolve) => {
		let mod;
		try { mod = url.startsWith('https:') ? require('https') : require('http'); }
		catch { return resolve({ status: 0, body: '' }); }
		const req = mod.get(url, { timeout: 8000, headers: { 'User-Agent': 'Atom++ Updater' } }, (res) => {
			let body = '';
			res.on('data', (c) => { body += c; });
			res.on('end', () => resolve({ status: res.statusCode || 0, body }));
		});
		req.on('error', () => resolve({ status: 0, body: '' }));
		req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: '' }); });
	});
}

/**
 * Check once. `explicit` = the user clicked "Check for Updates" (show an "up to date" toast and
 * re-notify even if previously dismissed); background checks stay quiet + don't nag.
 */
async function check(explicit) {
	const product = readProduct();
	const base = feedBase(product);
	const commit = product.commit || '';
	if (!base) {
		if (explicit) { vscode.window.showInformationMessage('Atom++: no update server configured (set atompp.update.url).'); }
		return;
	}
	if (!commit && !explicit) { return; } // dev build with no commit stamped — stay quiet in the background
	const target = U.platformTarget(process.platform, process.arch);
	const quality = product.quality || 'stable';
	const url = U.buildFeedUrl(base, target, quality, commit || 'unknown');

	const { status, body } = await httpGet(url);
	if (status === 0) {
		// network error / server down — DON'T claim "up to date" (that was the bug).
		if (explicit) { vscode.window.showWarningMessage('Atom++ Updater: couldn’t reach the update server at ' + base + ' — is it running?'); }
		return;
	}
	if (status !== 200 && status !== 204) {
		// e.g. the URL points at the SYNC server (which 404s /api/update) or a wrong path.
		if (explicit) { vscode.window.showWarningMessage('Atom++ Updater: unexpected response (HTTP ' + status + ') from ' + url + ' — is the UPDATE server (tools/update-server, default :9696) running there? The Settings-Sync server on :9595 is a different one.'); }
		return;
	}
	const feed = U.parseFeed(status, body);
	if (!U.isNewer(feed, commit)) {
		if (explicit) { vscode.window.showInformationMessage('Atom++ is up to date. (checked ' + target + '/' + quality + ' — running ' + (commit ? commit.slice(0, 8) : 'dev build, no commit') + ')'); }
		return;
	}
	// New version available.
	if (!explicit && ctx.globalState.get(LAST_NOTIFIED_KEY) === feed.version) { return; } // already nagged for this one
	ctx.globalState.update(LAST_NOTIFIED_KEY, feed.version);

	const actions = ['Download'];
	if (feed.releaseNotesUrl || product.releaseNotesUrl) { actions.push('Release Notes'); }
	actions.push('Later');
	const choice = await vscode.window.showInformationMessage(U.releaseLabel(feed) + ' is available.', ...actions);
	if (choice === 'Download') {
		const dl = feed.url || product.downloadUrl || base;
		try { await vscode.env.openExternal(vscode.Uri.parse(dl)); } catch { /* */ }
	} else if (choice === 'Release Notes') {
		const rn = feed.releaseNotesUrl || product.releaseNotesUrl;
		if (rn) { try { await vscode.env.openExternal(vscode.Uri.parse(rn)); } catch { /* */ } }
	}
}

function reschedule() {
	if (timer) { clearInterval(timer); timer = undefined; }
	if (!cfg().get('enabled', true)) { return; }
	const hours = Math.max(1, Number(cfg().get('intervalHours', 4)) || 4);
	timer = setInterval(() => { check(false).catch(() => {}); }, hours * 3600 * 1000);
	if (timer.unref) { timer.unref(); }
}

function activate(context) {
	ctx = context;
	context.subscriptions.push(vscode.commands.registerCommand('atompp.update.check', () => check(true)));
	context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => {
		if (e.affectsConfiguration('atompp.update')) { reschedule(); }
	}));
	context.subscriptions.push({ dispose: () => { if (timer) { clearInterval(timer); } } });
	reschedule();
	// initial background check shortly after startup
	const kick = setTimeout(() => { check(false).catch(() => {}); }, 30 * 1000);
	if (kick.unref) { kick.unref(); }
	context.subscriptions.push({ dispose: () => clearTimeout(kick) });
}

function deactivate() { if (timer) { clearInterval(timer); } }

module.exports = { activate, deactivate };
