/*---------------------------------------------------------------------------------------------
 *  Atom++ — Sync : pure session helpers (no vscode import, unit-testable with `node`).
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

const crypto = require('crypto');

/** The OAuth-style scopes our auth provider issues. Must match product.json authenticationProviders.atompp.scopes. */
const SCOPES = ['sync'];

/**
 * Mint a local DEV bearer token for an account. The real loopback+PKCE flow against
 * Atom++ Cloud (PRD §6.2.3) will replace this — only this function changes.
 * Shape: `atmps_<base64url(email)>.<random>` — opaque to the editor; the dev server
 * isolates storage per token.
 * @param {string} email
 * @returns {string}
 */
function mintDevToken(email) {
	// DEV token: a one-way hash of the email — DETERMINISTIC, so signing in with the same email
	// on another machine reaches the same account (that's what makes cross-device sync testable),
	// yet the email is NOT recoverable from the token (no PII in the credential). This is NOT a
	// security boundary; the real loopback+PKCE flow (S1) issues an opaque server-side token.
	return 'atmps_' + crypto.createHash('sha256').update('atompp-sync-dev:' + String(email).toLowerCase().trim()).digest('hex');
}

/**
 * Build a `vscode.AuthenticationSession`-shaped object.
 * @param {string} email
 * @param {string} token
 * @param {readonly string[]} [scopes]
 */
function makeSession(email, token, scopes) {
	const id = 'atompp-' + crypto.createHash('sha256').update(token).digest('hex').slice(0, 16);
	const list = scopes && scopes.length ? Array.from(scopes) : SCOPES.slice();
	return {
		id,
		accessToken: token,
		account: { id: String(email).toLowerCase(), label: String(email) },
		scopes: list
	};
}

/**
 * Serialize session METADATA only (never the token — tokens live in SecretStorage).
 * @param {Array<{id:string, account:{id:string,label:string}, scopes:string[]}>} sessions
 */
function serializeMeta(sessions) {
	return JSON.stringify(sessions.map(s => ({ id: s.id, account: s.account, scopes: s.scopes })));
}

/** @param {string} json */
function parseMeta(json) {
	try {
		const arr = JSON.parse(json || '[]');
		return Array.isArray(arr) ? arr : [];
	} catch {
		return [];
	}
}

/**
 * Whether a stored session satisfies a requested scope list.
 * @param {{scopes?: string[]}} session
 * @param {readonly string[]} [requested]
 */
function scopesMatch(session, requested) {
	if (!requested || requested.length === 0) { return true; }
	const have = new Set(session.scopes || []);
	return Array.from(requested).every(s => have.has(s));
}

/** @param {unknown} s */
function validateEmail(s) {
	return typeof s === 'string' && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s.trim());
}

module.exports = { SCOPES, mintDevToken, makeSession, serializeMeta, parseMeta, scopesMatch, validateEmail };
