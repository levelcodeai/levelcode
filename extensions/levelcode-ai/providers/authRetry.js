/*---------------------------------------------------------------------------------------------
 *  LevelCode — AI · a lapsed LevelCode Cloud token: renewed, and the request sent once more (pure)
 *
 *  The access token lives 8 hours; the session behind it lives as long as its refresh token. So the
 *  gateway can refuse a request with a 401 while the session is perfectly renewable — the token
 *  LAPSED, the session did not END. The chat and the agent recover from that: renew the token, send
 *  the request again, once. Everything else that asks the host for a provider did not. Inline edit,
 *  Agent Sketch, inline completion, Compact and the session-memory summary sent the request once
 *  and reported the gateway's 401 — "LevelCode AI edit failed: … API 401: Signature has expired" —
 *  for a request the chat would have carried through. And nothing renews the token ahead of time in
 *  a window that simply stays focused: the session check runs when the chat loads and when the
 *  window regains focus.
 *
 *  This is that recovery for them, in one place: no VS Code, no IO, everything it needs handed in,
 *  so it can be unit-tested (test/authRetry.test.js) and run for real under the callers
 *  (test/authRetryCallers.test.js).
 *
 *  What it will and will not do:
 *
 *    - Only a GATEWAY request is renewed. A 401 from the user's own provider is a wrong key, and no
 *      amount of refreshing a cloud session fixes that: it is rethrown untouched.
 *    - Only an auth failure, only before any of the answer has arrived (a second send would repeat
 *      it), and not once the caller has aborted. One retry: the second failure is the answer.
 *    - It never ends a session. One thing does — the refresh endpoint answering 401, inside the
 *      host's own refresh. This only FINDS OUT, by asking the host for a provider again: `signedOut`
 *      means the session is over, and the caller gets the sentence the chat shows — coded
 *      'session_expired', as the chat's is — instead of the gateway's 401. (The chat and the agent
 *      put the same question to the host's isEndedSessionError; the callers' test holds the two
 *      answers together.) A renewal that merely failed (offline, a 5xx) changes nothing: the tokens
 *      stay, and the request's own error is rethrown as the error it is.
 *    - One renewal at a time, among the requests that come through here. The nodes of an Agent
 *      Sketch level fail together, and the refresh token is rotated on use: five refreshes racing
 *      for one token is something to untangle afterwards, one that five requests wait on is not.
 *      It is not a lock on the host's refresh — the chat, the agent and the session check call that
 *      themselves.
 *    - A request refused on a token that has been renewed SINCE it was sent — by a sibling node, by
 *      the chat — is just sent again on the stored one. And the renewed token is written onto the
 *      request itself, so whatever else holds that request (the rest of a Sketch run) is on it too.
 *    - A request stays with the session and the gateway it was sent on. "A different token is
 *      stored" is only a renewal if it is the same session's token for the same URL: after a
 *      sign-in as someone else, or a change of cloud host, the stored token is not this request's.
 *      Putting it on the request would send one host's credential to another, or replay one
 *      account's prompt as another's — so recovery stops there, before refreshing and again before
 *      re-sending, and the request's own error stands.
 *    - A request nobody asked for (ghost text) may START a renewal once a minute at most. It is
 *      sent on every pause in typing; a gateway that keeps answering 401 must not turn typing into
 *      a stream of refreshes, each one rotating the session's credentials. Waiting on a renewal
 *      that is already out starts nothing, and is never held back.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

const { SESSION_EXPIRED_MESSAGE } = require('./session');

/** How often requests the user did not ask for may START a renewal. */
const BACKGROUND_RENEWAL_INTERVAL_MS = 60 * 1000;

/** @param {AbortSignal|undefined} signal */
function aborted(signal) { return !!(signal && signal.aborted); }

/**
 * Wait for `promise` — or until `signal` aborts, whichever comes first. The renewal itself is not
 * cancelled (other requests may be waiting on it, and what it stores is worth having either way);
 * the caller just stops waiting, so Stop and Cancel stay as quick as they were. `promise` must not
 * reject.
 * @param {Promise<void>} promise
 * @param {AbortSignal|undefined} signal
 * @returns {Promise<void>}
 */
function unlessAborted(promise, signal) {
	if (!signal) { return promise; }
	return new Promise((resolve) => {
		if (signal.aborted) { resolve(); return; }
		const stop = () => resolve();
		signal.addEventListener('abort', stop, { once: true });
		promise.then(() => { signal.removeEventListener('abort', stop); resolve(); });
	});
}

/**
 * @typedef {object} AuthRetryOptions
 * @property {() => boolean} [streamed]  true once any of the answer has reached the user: no second send after that
 * @property {AbortSignal} [signal]      the request's own abort signal (Stop, Cancel, the next keystroke)
 * @property {boolean} [background]      a request the user did not ask for — see BACKGROUND_RENEWAL_INTERVAL_MS
 */

/**
 * Build the host's renew-and-retry. ONE instance per window: the renewal in flight is what requests
 * that fail together share.
 *
 *   prepProviderRequest — the host's; asked again (never prompting) for what is stored NOW
 *   refreshGatewayToken — the host's; what it achieved is read back from what is stored, not from its answer
 *   isAuthError         — the host's test for "the provider refused the credentials"
 *   sessionGeneration   — the host's count of the sessions this window has been through: it moves
 *                         on a sign-in, a sign-out and an expiry, and stays put through a renewal
 *
 * @param {{
 *   prepProviderRequest: (opts?: any) => Promise<any>,
 *   refreshGatewayToken: () => Promise<any>,
 *   isAuthError: (e: any) => boolean,
 *   sessionGeneration?: () => any,
 *   dbg?: (label: string, data?: any) => void,
 *   now?: () => number
 * }} host
 * @returns {<T>(req: any, send: (req: any) => Promise<T>, opts?: AuthRetryOptions) => Promise<T>}
 */
function createAuthRetry(host) {
	const now = host.now || Date.now;
	const dbg = host.dbg || (() => { });
	const generation = host.sessionGeneration || (() => 0);
	/** @type {Promise<void>|null} the renewal that is out, if one is */
	let renewing = null;
	let lastBackgroundRenewal = -Infinity;
	/**
	 * The session each request's credentials came from: the host's generation, noted the first time
	 * the request is sent through here — for every caller, the moment after it was prepared. Kept
	 * per REQUEST, not per send: a Sketch run sends its one request many times over minutes, and a
	 * sign-in half-way through must not put the new account's token on the nodes still to come.
	 * @type {WeakMap<object, any>}
	 */
	const sessionOf = new WeakMap();

	/**
	 * Renew the token — or wait on the renewal already out. Never rejects, and says nothing: a
	 * refresh that throws has failed, and whether one worked is read from what is stored afterwards.
	 */
	function renew() {
		if (!renewing) {
			renewing = Promise.resolve().then(() => host.refreshGatewayToken())
				.then(() => { }, () => { })
				.then(() => { renewing = null; });
		}
		return renewing;
	}

	/**
	 * What the host would send this request on NOW, read against what it was sent on:
	 *
	 *   'ended'      — the session is over: the host answers `signedOut`
	 *   'superseded' — the request is no longer this session's to recover. The session it was sent
	 *                  in has been replaced (a sign-in, a sign-out), or the host would now send it
	 *                  somewhere else: another gateway URL, the user's own provider, nowhere.
	 *                  Whatever token is stored for THAT is not put on this request.
	 *   'renewed'    — same session, same gateway, a different token in place: `apiKey`
	 *   'same'       — the token that was refused is still the one stored
	 *
	 * @param {any} req
	 * @param {string} sent
	 * @returns {Promise<{state: 'ended'|'superseded'|'renewed'|'same', apiKey?: string}>}
	 */
	async function look(req, sent) {
		const cur = await host.prepProviderRequest({ prompt: false });   // a retry never opens a key dialog
		if (cur && !cur.ok && cur.reason === 'signedOut') { return { state: 'ended' }; }
		const sameGateway = !!cur && cur.ok && cur.gateway && cur.providerId === req.providerId && cur.baseURL === req.baseURL;
		if (!sameGateway || generation() !== sessionOf.get(req)) { return { state: 'superseded' }; }
		return cur.apiKey && cur.apiKey !== sent ? { state: 'renewed', apiKey: cur.apiKey } : { state: 'same' };
	}

	/**
	 * A gateway request carrying `sent` was refused. Find the token to send it again on.
	 * @param {any} req
	 * @param {string} sent
	 * @param {AuthRetryOptions} o
	 * @returns {Promise<{outcome: string, apiKey?: string}>}
	 */
	async function recover(req, sent, o) {
		let cur = await look(req, sent);
		if (cur.state === 'renewed') { return { outcome: 'already-renewed', apiKey: cur.apiKey }; }
		if (cur.state !== 'same') { return { outcome: cur.state }; }   // ended, or no longer this request's: nothing to refresh
		// The limit is on STARTING a renewal. One that is already out costs nothing to wait on — and the
		// request that started it may be gone by now (the next keystroke cancelled it) with this one
		// the only one left to use what it brings back.
		if (o.background && !renewing) {
			if (now() - lastBackgroundRenewal < BACKGROUND_RENEWAL_INTERVAL_MS) { return { outcome: 'throttled' }; }
			lastBackgroundRenewal = now();
		}
		await unlessAborted(renew(), o.signal);
		if (aborted(o.signal)) { return { outcome: 'aborted' }; }
		// Asked again, not carried over: a sign-in or a sign-out can land while the renewal is out.
		cur = await look(req, sent);
		if (cur.state === 'renewed') { return { outcome: 'renewed', apiKey: cur.apiKey }; }
		return { outcome: cur.state === 'same' ? 'failed' : cur.state };
	}

	return async function authRetry(req, send, opts) {
		const o = opts || {};
		const sent = req.apiKey;
		if (req.gateway && !sessionOf.has(req)) { sessionOf.set(req, generation()); }
		try {
			return await send(req);
		} catch (e) {
			if (!req.gateway || !host.isAuthError(e) || aborted(o.signal) || (o.streamed && o.streamed())) { throw e; }
			/** @type {{outcome: string, apiKey?: string}} */
			let found;
			// Whatever goes wrong while looking for a way to recover, the request's own failure is the news.
			try { found = await recover(req, sent, o); } catch { found = { outcome: 'failed' }; }
			dbg('auth.retry', { outcome: found.outcome });
			if (found.outcome === 'ended') {
				throw Object.assign(new Error(SESSION_EXPIRED_MESSAGE), { code: 'session_expired', cause: e });
			}
			if (!found.apiKey || aborted(o.signal)) { throw e; }
			req.apiKey = found.apiKey;
			return send(req);
		}
	};
}

/**
 * How a caller that is handed `deps` sends a provider request: through the host's renew-and-retry
 * when it was given one (`deps.authRetry`), and plainly when it was not — so a caller wired without
 * it behaves exactly as it did before there was one.
 * @template T
 * @param {any} deps
 * @param {any} req               an ok prepProviderRequest() result
 * @param {(req: any) => Promise<T>} send   sends the request on `req`; called a second time, at most, after a renewal
 * @param {AuthRetryOptions} [opts]
 * @returns {Promise<T>}
 */
function sendWithAuthRetry(deps, req, send, opts) {
	return deps && typeof deps.authRetry === 'function' ? deps.authRetry(req, send, opts) : send(req);
}

module.exports = { BACKGROUND_RENEWAL_INTERVAL_MS, createAuthRetry, sendWithAuthRetry };
