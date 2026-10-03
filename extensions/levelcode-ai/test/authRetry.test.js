/*---------------------------------------------------------------------------------------------
 *  Unit tests for providers/authRetry.js — run: node test/authRetry.test.js
 *
 *  A LevelCode Cloud access token lapses after 8 hours while the session behind it stays renewable.
 *  The chat and the agent renew it and send the request again; authRetry is that recovery for
 *  everything else that sends a provider request. What is pinned here is the rule itself:
 *
 *    - a gateway 401 renews the token and the request is sent ONCE more, on the new one
 *    - a BYOK request is never refreshed and never retried, whatever its error says
 *    - a renewal that merely failed keeps everything and rethrows the request's own error; one that
 *      found the session over is the session sentence — and nothing here ever ends a session
 *    - nothing is sent twice once part of the answer has arrived, or after the caller's own abort
 *    - requests that fail together wait on one renewal, and one refused on a token that has been
 *      renewed since is simply sent again
 *    - a request stays with the session and the gateway it was sent on: a token stored by a later
 *      sign-in, or for another cloud host, is never put on it
 *    - a request nobody asked for (ghost text) cannot turn typing into a stream of refreshes — but
 *      is never kept from waiting on a renewal that is already out
 *
 *  The host is a stand-in: what is stored, and what a renewal does to it. The same rule run against
 *  the shipped host code, the real adapters and the real callers is test/authRetryCallers.test.js.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

const assert = require('assert');
const { SESSION_EXPIRED_MESSAGE } = require('../providers/session');
const { BACKGROUND_RENEWAL_INTERVAL_MS, createAuthRetry, sendWithAuthRetry } = require('../providers/authRetry');

/** One turn of the event loop — what a SecretStorage read or a network reply costs. */
const tick = () => new Promise((resolve) => setImmediate(resolve));
async function until(cond, what) {
	for (let i = 0; i < 200; i++) { if (cond()) { return; } await tick(); }
	assert.fail('never happened: ' + what);
}
/** Let everything already in motion get as far as it can. */
async function settle() { for (let i = 0; i < 25; i++) { await tick(); } }
function deferred() { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; }
function within(promise, ms, what) {
	let timer;
	const late = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(what + ' did not finish within ' + ms + ' ms')), ms); });
	return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

/** The gateway's answer to a lapsed access token, as the openai adapter throws it. */
const gateway401 = () => Object.assign(new Error('LevelCode Cloud API 401: Signature has expired'), { status: 401 });

/** The failure a send ended in. */
async function failure(promise) {
	try { await promise; } catch (e) { return e; }
	assert.fail('the request was expected to fail');
}

/**
 * One window: a stored cloud session, a gateway that refuses lapsed tokens, and a refresh endpoint.
 *   token    — the stored access token ('' = none)
 *   ended    — the marker an ENDED session leaves behind
 *   byokKey  — the user's own key: what a request falls back to when there is no cloud token
 *   renewal  — what a renewal does: 'renew' (a new token is stored), 'fail' (offline / 5xx: nothing
 *              changes), 'end' (the refresh endpoint said 401: the HOST ends the session), 'claim'
 *              (says it worked, stores nothing new), 'throw', or a function returning one of those
 *   generation — the host's count of the sessions this window has been through (a sign-in, a
 *              sign-out and an expiry each move it; a renewal does not)
 *   baseURL  — where the gateway is
 */
function window_(over) {
	const w = Object.assign({ token: 'access-1', ended: false, byokKey: '', renewal: 'renew', clock: 0, generation: 0, baseURL: 'https://cloud.test/ai' }, over);
	let serial = 1;
	w.preps = []; w.renewals = 0; w.sent = []; w.sentTo = []; w.dbg = [];
	w.refused = new Set([w.token]);   // the tokens the gateway answers 401 to: the first one has lapsed
	const whatIsStored = () => {
		if (w.token) { return { ok: true, gateway: true, providerId: 'openai', apiKey: w.token, baseURL: w.baseURL, model: 'cloud-model', label: 'LevelCode Cloud' }; }
		if (w.ended) { return { ok: false, providerId: 'openai', label: 'LevelCode Cloud', reason: 'signedOut', gateway: true }; }
		if (w.byokKey) { return { ok: true, providerId: 'claude', apiKey: w.byokKey, model: 'claude-model', label: 'Claude' }; }
		return { ok: false, providerId: 'claude', label: 'Claude', reason: 'key' };
	};
	w.authRetry = createAuthRetry({
		prepProviderRequest: async (opts) => {
			w.preps.push(opts);
			if (w.onPrep) { w.onPrep(w.preps.length); }
			await tick();
			if (w.prepError) { throw w.prepError; }
			return whatIsStored();
		},
		refreshGatewayToken: async () => {
			w.renewals++;
			await tick();
			const how = typeof w.renewal === 'function' ? await w.renewal() : w.renewal;
			if (how === 'throw') { throw new Error('keychain is locked'); }
			if (how === 'renew') { w.token = 'access-' + (++serial); return true; }
			if (how === 'end') { w.token = ''; w.ended = true; w.generation++; return false; }
			return how === 'claim';
		},
		isAuthError: (e) => /\bAPI 401\b/.test(String((e && e.message) || e)),
		sessionGeneration: () => w.generation,
		dbg: (label, data) => { w.dbg.push(label + ' ' + data.outcome); },
		now: () => w.clock
	});
	/** The request a caller holds: what the host prepared BEFORE anything went wrong. */
	w.request = () => whatIsStored();
	/** The provider adapter. */
	w.send = async (req) => {
		w.sent.push(req.apiKey);
		w.sentTo.push(req.baseURL || req.providerId);
		await tick();
		if (w.refused.has(req.apiKey)) { throw req.gateway ? gateway401() : new Error('Claude API 401: invalid x-api-key'); }
		return 'answered on ' + req.apiKey;
	};
	return w;
}

let n = 0;
async function test(name, fn) { await fn(); n++; console.log('  ok - ' + name); }

(async () => {
	// ── the rule ─────────────────────────────────────────────────────────────────────────────────
	await test('a request that is answered is sent once, and nothing else happens', async () => {
		const w = window_();
		w.refused.clear();
		assert.strictEqual(await w.authRetry(w.request(), w.send), 'answered on access-1');
		assert.deepStrictEqual({ sent: w.sent, renewals: w.renewals, preps: w.preps.length }, { sent: ['access-1'], renewals: 0, preps: 0 });
	});

	await test('a gateway 401 whose renewal succeeds is retried once, on the new token', async () => {
		const w = window_();
		const req = w.request();
		assert.strictEqual(await w.authRetry(req, w.send), 'answered on access-2');
		assert.deepStrictEqual(w.sent, ['access-1', 'access-2']);
		assert.strictEqual(w.renewals, 1);
		assert.strictEqual(req.apiKey, 'access-2', 'the request itself carries the renewed token');
		assert.deepStrictEqual(w.dbg, ['auth.retry renewed']);
	});

	await test('a retry never opens a key dialog: every look at what is stored is prompt:false', async () => {
		const w = window_();
		await w.authRetry(w.request(), w.send);
		assert.ok(w.preps.length >= 1);
		assert.ok(w.preps.every((o) => o && o.prompt === false), JSON.stringify(w.preps));
	});

	await test('a gateway 401 whose renewal FAILS keeps the session and rethrows the request\'s own error', async () => {
		const w = window_({ renewal: 'fail' });
		const e = await failure(w.authRetry(w.request(), w.send));
		assert.strictEqual(e.message, 'LevelCode Cloud API 401: Signature has expired', 'the error it is');
		assert.notStrictEqual(e.code, 'session_expired');
		assert.deepStrictEqual(w.sent, ['access-1'], 'no retry without a fresh token');
		assert.strictEqual(w.renewals, 1, 'one renewal attempt');
		assert.strictEqual(w.token, 'access-1', 'the token is still there for the next attempt');
		assert.deepStrictEqual(w.dbg, ['auth.retry failed']);
	});

	await test('a renewal that THROWS is a renewal that failed: still the request\'s own error', async () => {
		const w = window_({ renewal: 'throw' });
		const e = await failure(w.authRetry(w.request(), w.send));
		assert.ok(/API 401/.test(e.message), 'not "keychain is locked"');
		assert.deepStrictEqual(w.sent, ['access-1']);
	});

	await test('a renewal that throws does not wedge the ones after it — the next request renews again', async () => {
		const w = window_({ renewal: 'throw' });
		// With a signal to watch and without: the two ways a caller waits on the renewal.
		const watched = await within(failure(w.authRetry(w.request(), w.send, { signal: new AbortController().signal })), 2000, 'the watched request');
		const plain = await within(failure(w.authRetry(w.request(), w.send)), 2000, 'the plain request');
		assert.ok(/API 401/.test(watched.message) && /API 401/.test(plain.message));
		w.renewal = 'renew';   // the keychain is unlocked again
		assert.strictEqual(await within(w.authRetry(w.request(), w.send), 2000, 'the next request'), 'answered on access-2');
		assert.strictEqual(w.renewals, 3, 'each of them got its own attempt');
	});

	await test('a renewal that says it worked but left the same token in place is not retried', async () => {
		const w = window_({ renewal: 'claim' });
		const e = await failure(w.authRetry(w.request(), w.send));
		assert.ok(/API 401/.test(e.message));
		assert.deepStrictEqual(w.sent, ['access-1'], 'the refused token is not sent a second time');
	});

	await test('the retry is the last word: a second 401 is thrown, with no second renewal', async () => {
		const w = window_();
		w.refused.add('access-2');
		const e = await failure(w.authRetry(w.request(), w.send));
		assert.ok(/API 401/.test(e.message));
		assert.deepStrictEqual(w.sent, ['access-1', 'access-2']);
		assert.strictEqual(w.renewals, 1);
	});

	// ── an ended session: found out, never caused ────────────────────────────────────────────────
	await test('a renewal that found the session OVER is the session sentence, coded session_expired', async () => {
		const w = window_({ renewal: 'end' });
		const e = await failure(w.authRetry(w.request(), w.send));
		assert.strictEqual(e.message, SESSION_EXPIRED_MESSAGE);
		assert.strictEqual(e.code, 'session_expired');
		assert.ok(/API 401/.test(e.cause.message), 'the gateway\'s own error is kept as the cause');
		assert.deepStrictEqual(w.sent, ['access-1'], 'nothing is sent again');
		assert.deepStrictEqual(w.dbg, ['auth.retry ended']);
	});

	await test('a session that had ALREADY ended is found without asking for another renewal', async () => {
		const w = window_();
		const req = w.request();
		w.token = ''; w.ended = true;   // ended by someone else while this request was out
		const e = await failure(w.authRetry(req, w.send));
		assert.strictEqual(e.code, 'session_expired');
		assert.strictEqual(w.renewals, 0);
	});

	await test('signed out on purpose meanwhile: the request\'s own error, not a session card, and no fallback to BYOK', async () => {
		const w = window_({ byokKey: 'sk-own' });
		const req = w.request();
		w.token = ''; w.generation++;   // no marker: a sign-out, not an expiry
		const e = await failure(w.authRetry(req, w.send));
		assert.ok(/API 401/.test(e.message));
		assert.notStrictEqual(e.code, 'session_expired');
		assert.deepStrictEqual(w.sent, ['access-1'], 'a gateway request is not quietly re-sent to another provider');
		assert.strictEqual(w.renewals, 0, 'and nothing is refreshed on behalf of a session that is gone');
		assert.deepStrictEqual(w.dbg, ['auth.retry superseded']);
	});

	// ── what is never renewed ────────────────────────────────────────────────────────────────────
	await test('a BYOK request is never refreshed and never retried — not even on a 401', async () => {
		const w = window_({ token: '', byokKey: 'sk-own' });
		w.refused.add('sk-own');
		const req = w.request();
		assert.ok(!req.gateway, 'premise: not a gateway request');
		const e = await failure(w.authRetry(req, w.send));
		assert.strictEqual(e.message, 'Claude API 401: invalid x-api-key');
		assert.deepStrictEqual({ sent: w.sent, renewals: w.renewals, preps: w.preps.length }, { sent: ['sk-own'], renewals: 0, preps: 0 });
	});

	await test('a gateway error that is not an auth failure is left alone', async () => {
		for (const message of ['LevelCode Cloud API 402: cap_reached', 'LevelCode Cloud API 502: Bad Gateway', 'fetch failed']) {
			const w = window_();
			const thrown = new Error(message);
			const e = await failure(w.authRetry(w.request(), async (req) => { w.sent.push(req.apiKey); throw thrown; }));
			assert.strictEqual(e, thrown);
			assert.deepStrictEqual({ sent: w.sent.length, renewals: w.renewals, preps: w.preps.length }, { sent: 1, renewals: 0, preps: 0 }, message);
		}
	});

	await test('once part of the answer has arrived, nothing is sent again', async () => {
		const w = window_();
		const e = await failure(w.authRetry(w.request(), w.send, { streamed: () => true }));
		assert.ok(/API 401/.test(e.message));
		assert.deepStrictEqual({ sent: w.sent, renewals: w.renewals }, { sent: ['access-1'], renewals: 0 });
	});

	await test('a request the caller has already aborted is not renewed', async () => {
		const w = window_();
		const ac = new AbortController();
		const send = async (req) => { ac.abort(); return w.send(req); };
		await failure(w.authRetry(w.request(), send, { signal: ac.signal }));
		assert.deepStrictEqual({ sent: w.sent, renewals: w.renewals, preps: w.preps.length }, { sent: ['access-1'], renewals: 0, preps: 0 });
	});

	await test('if the host cannot say what is stored, the request\'s own error stands', async () => {
		const w = window_();
		w.prepError = new Error('keychain is locked');
		const e = await failure(w.authRetry(w.request(), w.send));
		assert.ok(/API 401/.test(e.message));
		assert.deepStrictEqual(w.sent, ['access-1']);
	});

	// ── requests that fail together ──────────────────────────────────────────────────────────────
	await test('five requests that fail together share ONE renewal, and each is retried once', async () => {
		const w = window_();
		const req = w.request();   // one request object for all of them, as the nodes of a Sketch run have
		const answers = await Promise.all([1, 2, 3, 4, 5].map(() => w.authRetry(req, w.send)));
		assert.deepStrictEqual(answers, Array(5).fill('answered on access-2'));
		assert.strictEqual(w.renewals, 1, 'one refresh, not five racing for the same refresh token');
		assert.deepStrictEqual(w.sent, [...Array(5).fill('access-1'), ...Array(5).fill('access-2')]);
	});

	await test('the same holds for requests that each prepared their own', async () => {
		const w = window_();
		const answers = await Promise.all([1, 2, 3].map(() => w.authRetry(w.request(), w.send)));
		assert.deepStrictEqual(answers, Array(3).fill('answered on access-2'));
		assert.strictEqual(w.renewals, 1);
	});

	await test('together and refused: every one of them says the session expired, after one renewal', async () => {
		const w = window_({ renewal: 'end' });
		const errors = await Promise.all([1, 2, 3].map(() => failure(w.authRetry(w.request(), w.send))));
		assert.deepStrictEqual(errors.map((e) => e.code), Array(3).fill('session_expired'));
		assert.strictEqual(w.renewals, 1);
	});

	await test('refused on a token that has been renewed SINCE: sent again on the stored one, no second renewal', async () => {
		const w = window_();
		const req = w.request();
		w.token = 'access-9';   // the chat renewed it while this request was out
		assert.strictEqual(await w.authRetry(req, w.send), 'answered on access-9');
		assert.strictEqual(w.renewals, 0);
		assert.deepStrictEqual(w.dbg, ['auth.retry already-renewed']);
	});

	await test('the renewed token is written onto the request: whoever shares it never sees the 401', async () => {
		const w = window_();
		const req = w.request();
		await w.authRetry(req, w.send);
		w.sent.length = 0;
		assert.strictEqual(await w.authRetry(req, w.send), 'answered on access-2');   // the next node of the run
		assert.deepStrictEqual({ sent: w.sent, renewals: w.renewals }, { sent: ['access-2'], renewals: 1 });
	});

	await test('one renewal at a time is not one renewal for ever: the next lapse is renewed too', async () => {
		const w = window_();
		await w.authRetry(w.request(), w.send);
		w.refused.add('access-2');   // eight hours later
		assert.strictEqual(await w.authRetry(w.request(), w.send), 'answered on access-3');
		assert.strictEqual(w.renewals, 2);
	});

	await test('our own renewal failed, but someone else\'s landed meanwhile: what is stored decides, and it is sent again', async () => {
		const w = window_({ renewal: async () => { w.token = 'access-9'; return 'fail'; } });
		assert.strictEqual(await w.authRetry(w.request(), w.send), 'answered on access-9');
		assert.deepStrictEqual(w.sent, ['access-1', 'access-9']);
	});

	// ── a request stays with the session and the gateway it was sent on ──────────────────────────
	/** While the request is out: this window signs out, and someone else signs in. */
	const someoneElseSignsIn = (w) => { w.generation += 2; w.token = 'access-bo'; };

	await test('another account signed in while the request was out: its token is NOT put on the old request', async () => {
		const w = window_();
		const req = w.request();
		const send = async (r) => { if (!w.sent.length) { someoneElseSignsIn(w); } return w.send(r); };
		const e = await failure(w.authRetry(req, send));
		assert.ok(/API 401/.test(e.message), 'the request\'s own error');
		assert.deepStrictEqual(w.sent, ['access-1'], 'one account\'s prompt is not replayed as another\'s');
		assert.strictEqual(req.apiKey, 'access-1');
		assert.strictEqual(w.renewals, 0, 'and the new session is not refreshed on the old request\'s behalf');
		assert.deepStrictEqual(w.dbg, ['auth.retry superseded']);
	});

	await test('the sign-in lands DURING the renewal: what the renewal brought back is not this request\'s either', async () => {
		const w = window_({ renewal: async () => { someoneElseSignsIn(w); return 'claim'; } });
		const e = await failure(w.authRetry(w.request(), w.send));
		assert.ok(/API 401/.test(e.message));
		assert.deepStrictEqual(w.sent, ['access-1']);
		assert.deepStrictEqual(w.dbg, ['auth.retry superseded']);
	});

	await test('a run\'s request stays in the session it started in, however much later it is sent', async () => {
		const w = window_();
		w.refused.clear();
		const req = w.request();   // one request for the whole run, as Agent Sketch has
		assert.strictEqual(await w.authRetry(req, w.send), 'answered on access-1');   // the first node: all is well
		someoneElseSignsIn(w);          // …then the account changes under the run,
		w.refused.add('access-1');      // and the old session's token stops working
		const e = await failure(w.authRetry(req, w.send));   // the next node — sent AFTER the sign-in, on the run's request
		assert.ok(/API 401/.test(e.message));
		assert.deepStrictEqual(w.sent, ['access-1', 'access-1'], 'the rest of the run is not carried on as the other account');
		assert.strictEqual(w.renewals, 0);
	});

	await test('the cloud host moved: a token stored for the new URL is never sent to the old one', async () => {
		const w = window_();
		const req = w.request();
		// Changed by another window, so nothing this window counts has moved: only where the gateway is.
		w.baseURL = 'https://other.test/ai'; w.token = 'access-other';
		const e = await failure(w.authRetry(req, w.send));
		assert.ok(/API 401/.test(e.message));
		assert.deepStrictEqual(w.sentTo, ['https://cloud.test/ai'], 'one request, to the URL it was prepared for');
		assert.deepStrictEqual(w.sent, ['access-1'], 'and the other host\'s credential never left');
		assert.strictEqual(w.renewals, 0);
		assert.deepStrictEqual(w.dbg, ['auth.retry superseded']);
	});

	await test('the same URL under another provider is not the same gateway', async () => {
		const stored = { ok: true, gateway: true, providerId: 'openai', apiKey: 'access-1', baseURL: 'https://cloud.test/ai' };
		const authRetry = createAuthRetry({
			prepProviderRequest: async () => Object.assign({}, stored),
			refreshGatewayToken: async () => true,
			isAuthError: (e) => /API 401/.test(e.message)
		});
		const sent = [];
		const send = async (r) => { sent.push(r.providerId + ' ' + r.apiKey); throw gateway401(); };
		const req = Object.assign({}, stored);
		Object.assign(stored, { providerId: 'openrouter', apiKey: 'access-2' });
		await failure(authRetry(req, send));
		assert.deepStrictEqual(sent, ['openai access-1']);
	});

	await test('a host that keeps no count of sessions still gets the gateway check', async () => {
		const stored = { ok: true, gateway: true, providerId: 'openai', apiKey: 'access-1', baseURL: 'https://cloud.test/ai' };
		let renewals = 0;
		const authRetry = createAuthRetry({
			prepProviderRequest: async () => Object.assign({}, stored),
			refreshGatewayToken: async () => { renewals++; stored.apiKey = 'access-2'; return true; },
			isAuthError: (e) => /API 401/.test(e.message)
		});
		const send = async (r) => { if (r.apiKey === 'access-1') { throw gateway401(); } return r.baseURL + ' ' + r.apiKey; };
		assert.strictEqual(await authRetry(Object.assign({}, stored), send), 'https://cloud.test/ai access-2', 'renews as before');
		const old = Object.assign({}, stored, { apiKey: 'access-1' });
		stored.baseURL = 'https://other.test/ai';
		const e = await failure(authRetry(old, send));
		assert.ok(/API 401/.test(e.message));
		assert.strictEqual(renewals, 1, 'nothing more was refreshed');
	});

	// ── Stop and Cancel ──────────────────────────────────────────────────────────────────────────
	await test('aborted while the renewal is out: the caller stops waiting, nothing is re-sent, the renewal still lands', async () => {
		const reply = deferred();
		const w = window_({ renewal: () => reply.promise });
		const ac = new AbortController();
		const run = failure(w.authRetry(w.request(), w.send, { signal: ac.signal }));
		await until(() => w.renewals === 1, 'the renewal');
		ac.abort();
		const e = await within(run, 2000, 'the aborted request');   // …with the renewal still unanswered
		assert.ok(/API 401/.test(e.message));
		assert.deepStrictEqual(w.sent, ['access-1']);
		assert.deepStrictEqual(w.dbg, ['auth.retry aborted'], 'stopped waiting — not "the renewal failed"');
		assert.strictEqual(w.preps.length, 1, 'and does not go back to look at what is stored');
		reply.resolve('renew');
		await until(() => w.token === 'access-2', 'the renewal landing');
		assert.strictEqual(await w.authRetry(w.request(), w.send), 'answered on access-2', 'the next request finds the new token');
		assert.strictEqual(w.renewals, 1);
	});

	await test('aborted AFTER the renewal landed, before the re-send: the new token is kept, the request is not sent', async () => {
		const w = window_();
		const ac = new AbortController();
		w.onPrep = (nth) => { if (nth === 2) { ac.abort(); } };   // Stop lands while the renewed token is being read back
		const e = await failure(w.authRetry(w.request(), w.send, { signal: ac.signal }));
		assert.ok(/API 401/.test(e.message));
		assert.deepStrictEqual(w.sent, ['access-1'], 'nothing goes out after Stop');
		assert.strictEqual(w.token, 'access-2', 'the renewal is not undone');
	});

	// ── requests nobody asked for ────────────────────────────────────────────────────────────────
	const background = { background: true };

	await test('background: a lapsed token is renewed and the request retried, like any other', async () => {
		const w = window_();
		assert.strictEqual(await w.authRetry(w.request(), w.send, background), 'answered on access-2');
		assert.strictEqual(w.renewals, 1);
	});

	await test('background: typing starts one renewal a minute at most — a foreground request is not held to that', async () => {
		const w = window_({ renewal: 'fail' });
		await failure(w.authRetry(w.request(), w.send, background));
		assert.strictEqual(w.renewals, 1);

		w.clock += BACKGROUND_RENEWAL_INTERVAL_MS - 1;   // the user keeps typing: a request on every pause
		for (let i = 0; i < 5; i++) { await failure(w.authRetry(w.request(), w.send, background)); }
		assert.strictEqual(w.renewals, 1, 'no refresh per keystroke');
		assert.strictEqual(w.dbg.pop(), 'auth.retry throttled');

		await failure(w.authRetry(w.request(), w.send));   // an inline edit, a Sketch run: the user asked, so it tries
		assert.strictEqual(w.renewals, 2);

		w.clock += 1;   // the minute is up
		await failure(w.authRetry(w.request(), w.send, background));
		assert.strictEqual(w.renewals, 3);
	});

	await test('background: a request that only has to WAIT on a renewal already out is not held back', async () => {
		const reply = deferred();
		const w = window_({ renewal: () => reply.promise });
		const typing = new AbortController();
		const first = failure(w.authRetry(w.request(), w.send, { background: true, signal: typing.signal }));
		await until(() => w.renewals === 1, 'the renewal');
		typing.abort();   // the next keystroke: the completion that started the renewal is gone
		await first;
		// The next pause in typing — well inside the minute. (Its outcome is kept as a value: held back,
		// it would be refused while this test is still waiting, and that should read as a failed case.)
		const second = w.authRetry(w.request(), w.send, background).then((answer) => answer, (e) => 'refused: ' + e.message);
		await until(() => w.sent.length === 2, 'the second request');
		await settle();   // refused on the old token, and now waiting on the renewal that is still out
		reply.resolve('renew');
		assert.strictEqual(await within(second, 2000, 'the second request'), 'answered on access-2');
		assert.strictEqual(w.renewals, 1, 'it started nothing');
		assert.deepStrictEqual(w.dbg, ['auth.retry aborted', 'auth.retry renewed']);
	});

	await test('background: a gateway that keeps answering 401 to FRESH tokens does not rotate the session on every keystroke', async () => {
		const w = window_();
		w.send = async (req) => { w.sent.push(req.apiKey); throw gateway401(); };   // refused whatever the token
		for (let i = 0; i < 6; i++) { await failure(w.authRetry(w.request(), w.send, background)); }
		assert.strictEqual(w.renewals, 1);
		assert.strictEqual(w.token, 'access-2', 'renewed once, not six times');
	});

	await test('background: while held back, a token renewed by someone else is still picked up', async () => {
		const w = window_({ renewal: 'fail' });
		const stale = w.request();
		await failure(w.authRetry(w.request(), w.send, background));
		w.token = 'access-9';   // the chat got through
		assert.strictEqual(await w.authRetry(stale, w.send, background), 'answered on access-9');
		assert.strictEqual(w.renewals, 1);
	});

	await test('the shipped interval is one minute', () => {
		assert.strictEqual(BACKGROUND_RENEWAL_INTERVAL_MS, 60000);
	});

	// ── a caller wired without it ────────────────────────────────────────────────────────────────
	await test('sendWithAuthRetry: no hook in deps means one plain send, its error passed through', async () => {
		const w = window_();
		for (const deps of [{}, { authRetry: undefined }, null]) {
			w.sent.length = 0;
			const e = await failure(sendWithAuthRetry(deps, w.request(), w.send, { streamed: () => false }));
			assert.ok(/API 401/.test(e.message));
			assert.deepStrictEqual({ sent: w.sent, renewals: w.renewals }, { sent: ['access-1'], renewals: 0 });
		}
	});

	await test('sendWithAuthRetry: with the hook, the request, the send and the options all reach it', async () => {
		const w = window_();
		const opts = { streamed: () => false };
		const seen = [];
		const deps = { authRetry: (req, send, o) => { seen.push(o); return w.authRetry(req, send, o); } };
		assert.strictEqual(await sendWithAuthRetry(deps, w.request(), w.send, opts), 'answered on access-2');
		assert.deepStrictEqual(seen, [opts]);
	});

	console.log('\nauthRetry: ' + n + ' tests passed.');
})().catch((e) => { console.error(e); process.exit(1); });
