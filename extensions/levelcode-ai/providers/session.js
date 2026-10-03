/*---------------------------------------------------------------------------------------------
 *  LevelCode — AI · LevelCode Cloud session state (pure)
 *
 *  The editor keeps two credentials for the cloud: a short-lived access token (8 h) and a refresh
 *  token (30 days, rotated on use). Everything here is the arithmetic and classification around
 *  them — no VS Code, no IO — so it can be unit-tested (test/session.test.js) and so the host can
 *  answer "is this session still alive?" WITHOUT a network round-trip, by reading the access
 *  token's own `exp` claim. A JWT's payload is plain base64url JSON; reading it is not verifying it
 *  (the server does that), it is only asking the token when it says it dies.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

/** Refresh this far ahead of expiry, so a request issued right now cannot land after the deadline. */
const EXPIRY_MARGIN_MS = 5 * 60 * 1000;

/**
 * How long the whole refresh exchange may take — connecting, the headers AND the body. The webview's
 * `ready` waits on a refresh before it restores the chat, so this is how long a host that accepts the
 * connection and then says nothing can hold that up. Running out of it is "this attempt failed",
 * never "the session is over".
 */
const REFRESH_TIMEOUT_MS = 10 * 1000;

/** The sentence shown when the session is gone. Mirrors the server's own wording. */
const SESSION_EXPIRED_MESSAGE = 'Your LevelCode Cloud session has expired. Sign in again to continue.';

/**
 * The payload of a JWT, or null when the token is not a JWT or is unreadable. Never throws.
 * @param {string|null|undefined} token
 * @returns {any}
 */
function jwtPayload(token) {
	try {
		const parts = String(token || '').split('.');
		if (parts.length !== 3) { return null; }
		const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
		const payload = JSON.parse(Buffer.from(b64 + '='.repeat((4 - b64.length % 4) % 4), 'base64').toString('utf8'));
		return payload && typeof payload === 'object' ? payload : null;
	} catch { return null; }
}

/**
 * The `exp` claim of a JWT as epoch milliseconds, or null when the token is not a JWT, carries no
 * `exp`, or is unreadable. Never throws: a malformed token is a reason to re-check with the server,
 * not a reason to crash the editor.
 * @param {string|null|undefined} token
 * @returns {number|null}
 */
function jwtExpiresAt(token) {
	const payload = jwtPayload(token);
	const exp = Number(payload && payload.exp);
	return Number.isFinite(exp) && exp > 0 ? exp * 1000 : null;
}

/**
 * Who a JWT says it is for: its `sub` claim, as a string — or null when the token is not a JWT, is
 * unreadable, or names no subject. Read, not verified, like `exp`: it is only asking the token.
 *
 * It is the one thing about a session that every window can see and that a renewal does not change.
 * The stored tokens belong to all the windows, and a window only counts the sign-ins it makes
 * itself; but two tokens that name different subjects are two accounts, whichever window stored the
 * second one.
 * @param {string|null|undefined} token
 * @returns {string|null}
 */
function jwtSubject(token) {
	const payload = jwtPayload(token);
	const sub = payload ? payload.sub : undefined;
	if (typeof sub === 'string') { return sub || null; }
	return typeof sub === 'number' && Number.isFinite(sub) ? String(sub) : null;
}

/**
 * Whether an access token should be refreshed before use: it expires within the margin, has
 * already expired, or cannot be read at all (an unreadable token is treated as expired — the
 * server would reject it anyway, and asking first is cheaper than a failed request).
 * @param {string|null|undefined} token
 * @param {number} [nowMs]
 */
function accessNeedsRefresh(token, nowMs = Date.now()) {
	const exp = jwtExpiresAt(token);
	return exp === null || exp - nowMs <= EXPIRY_MARGIN_MS;
}

/**
 * Classify the outcome of POST /auth/refresh so the caller knows whether the SESSION is over, or
 * only this attempt failed.
 *
 *   'ok'      — a new access token was issued
 *   'expired' — the server rejected the refresh token itself (401): the session is over, sign in again
 *   'retry'   — anything else: offline, 5xx, a malformed reply. Keep the tokens; nothing is known yet.
 *
 * Only an explicit 401 ends the session. Clearing credentials on a network blip would log a user
 * out for closing their laptop on the train.
 *
 * And 'ok' means the reply can be STORED as it stands, not merely that it was a 2xx with something
 * in the right field. The tokens go into SecretStorage, which takes strings: `{ access: {} }` would
 * throw on the way in, and `{ access: 'a', refresh: {} }` would throw after the access token had
 * already been replaced. Either is a malformed reply — "nothing is known yet" — and the credentials
 * in hand are still the best ones available. The refresh token is optional (a server that does not
 * rotate sends none); when one is present it has to be usable too.
 * @param {{status?:number, body?:any}|null|undefined} res
 * @returns {'ok'|'expired'|'retry'}
 */
function classifyRefresh(res) {
	if (!res) { return 'retry'; }
	if (res.status === 401) { return 'expired'; }
	if (!(res.status >= 200 && res.status < 300) || !res.body) { return 'retry'; }
	const isToken = (v) => typeof v === 'string' && v.length > 0;
	if (!isToken(res.body.access || res.body.token)) { return 'retry'; }   // the one the host will store
	if (res.body.refresh && !isToken(res.body.refresh)) { return 'retry'; }
	return 'ok';
}

/**
 * True when a provider error means the cloud session is dead — a gateway 401 that a refresh could
 * not recover. The adapter formats failures as `<label> API <status>: <detail>`; the server's own
 * codes (`token_expired`, `refresh_expired`) are matched too so a structured body is not needed.
 * @param {any} e
 */
function isSessionExpiredError(e) {
	const status = e && e.status;
	const msg = String((e && e.message) || e || '');
	return status === 401 || /\bAPI 401\b|token_expired|refresh_expired|signature has expired/i.test(msg);
}

module.exports = { EXPIRY_MARGIN_MS, REFRESH_TIMEOUT_MS, SESSION_EXPIRED_MESSAGE, jwtExpiresAt, jwtSubject, accessNeedsRefresh, classifyRefresh, isSessionExpiredError };
