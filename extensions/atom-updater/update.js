/*---------------------------------------------------------------------------------------------
 *  Atom++ — Updater : pure helpers (no vscode import, unit-testable with `node`).
 *
 *  Speaks the same update-feed contract as the editor's built-in updater
 *  (GET {updateUrl}/api/update/{target}/{quality}/{commit}), but only NOTIFIES — it never
 *  auto-applies, so it works on any build (incl. ad-hoc-signed) with no code-signing.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

/** Platform/arch → the update feed's asset target id (matches the built-in updater). */
function platformTarget(platform, arch) {
	if (platform === 'darwin') { return arch === 'arm64' ? 'darwin-arm64' : 'darwin'; }
	if (platform === 'win32') { return arch === 'arm64' ? 'win32-arm64' : 'win32-x64'; }
	return arch === 'arm64' ? 'linux-arm64' : 'linux-x64';
}

/** Build the feed URL: {base}/api/update/{target}/{quality}/{commit}. */
function buildFeedUrl(base, target, quality, commit) {
	const b = String(base || '').replace(/\/+$/, '');
	return b + '/api/update/' + encodeURIComponent(target) + '/' + encodeURIComponent(quality) + '/' + encodeURIComponent(commit);
}

/**
 * Interpret a feed response: 204 → up to date (null); 200 + valid JSON with a `version` → the
 * release; anything else → null (errors are non-fatal for a notify-only updater).
 * @param {number} status @param {string} body
 */
function parseFeed(status, body) {
	if (status === 204) { return null; }
	if (status === 200) {
		try { const j = JSON.parse(body); return j && j.version ? j : null; }
		catch { return null; }
	}
	return null;
}

/** A release is newer iff the feed advertises a different build commit than the one running. */
function isNewer(feed, currentCommit) {
	return !!(feed && feed.version && feed.version !== currentCommit);
}

/** Human label for a notification, preferring the SemVer productVersion. */
function releaseLabel(feed) {
	if (!feed) { return 'A new version'; }
	return feed.productVersion ? ('Atom++ ' + feed.productVersion) : 'A new Atom++ build';
}

module.exports = { platformTarget, buildFeedUrl, parseFeed, isNewer, releaseLabel };
