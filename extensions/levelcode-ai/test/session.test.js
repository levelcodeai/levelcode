/*---------------------------------------------------------------------------------------------
 *  Unit tests for providers/session.js (pure) — run: node test/session.test.js
 *    - jwtExpiresAt: reads `exp` off a JWT payload without verifying; never throws
 *    - jwtSubject: reads `sub` the same way — who the token says it is for, the same across a
 *      renewal and different across accounts
 *    - accessNeedsRefresh: the 5-minute margin, expired, unreadable
 *    - classifyRefresh: ONLY a 401 ends the session; offline/5xx keep the tokens; a 2xx is a
 *      renewal only when what it carries can be stored
 *    - isSessionExpiredError: the shapes a dead session arrives in
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

const assert = require('assert');
const S = require('../providers/session');

let n = 0;
function test(name, fn) { fn(); n++; console.log('  ok - ' + name); }

/** An unsigned JWT with the given payload — the shape is all jwtExpiresAt reads. */
function jwt(payload) {
	const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
	return b64({ alg: 'HS256', typ: 'JWT' }) + '.' + b64(payload) + '.sig';
}

const NOW = 1_800_000_000_000;   // fixed "now" so the margin arithmetic is exact

test('jwtSubject: who the token says it is for — a string or a number, read as a string', () => {
	assert.strictEqual(S.jwtSubject(jwt({ sub: 'user_42', exp: 7 })), 'user_42');
	assert.strictEqual(S.jwtSubject(jwt({ sub: 42 })), '42');
});
test('jwtSubject: the same across a renewal, different across accounts', () => {
	assert.strictEqual(S.jwtSubject(jwt({ sub: 1, exp: 100, jti: 'a' })), S.jwtSubject(jwt({ sub: 1, exp: 200, jti: 'b' })));
	assert.notStrictEqual(S.jwtSubject(jwt({ sub: 1, exp: 100 })), S.jwtSubject(jwt({ sub: 2, exp: 100 })));
});
test('jwtSubject: null for a token that names nobody — not a JWT, no sub, an empty or odd one, garbage, nothing; never throws', () => {
	const five = 'a.' + Buffer.from('5').toString('base64') + '.c';   // a payload that is JSON, and not an object
	for (const token of ['opaque-token', jwt({ exp: 7 }), jwt({ sub: '' }), jwt({ sub: null }), jwt({ sub: { id: 1 } }), jwt({ sub: true }), 'a.!!!.c', five, '', null, undefined]) {
		assert.strictEqual(S.jwtSubject(token), null, JSON.stringify(token));
	}
});
test('jwtExpiresAt: a payload that is not an object is still just "no exp"', () => {
	assert.strictEqual(S.jwtExpiresAt('a.' + Buffer.from('5').toString('base64') + '.c'), null);
	assert.strictEqual(S.jwtExpiresAt('a.' + Buffer.from('[1]').toString('base64') + '.c'), null);
});

test('jwtExpiresAt: reads exp (seconds) as epoch milliseconds', () => {
	assert.strictEqual(S.jwtExpiresAt(jwt({ sub: 1, exp: 1_800_000_123 })), 1_800_000_123_000);
});
test('jwtExpiresAt: survives base64url padding edge cases (payload lengths mod 4)', () => {
	for (const pad of ['', 'x', 'xy', 'xyz']) {
		assert.strictEqual(S.jwtExpiresAt(jwt({ p: pad, exp: 7 })), 7000, 'pad=' + JSON.stringify(pad));
	}
});
test('jwtExpiresAt: null for a non-JWT, a JWT without exp, garbage, and nothing — never throws', () => {
	assert.strictEqual(S.jwtExpiresAt('opaque-token'), null);
	assert.strictEqual(S.jwtExpiresAt(jwt({ sub: 1 })), null);
	assert.strictEqual(S.jwtExpiresAt('a.!!!.c'), null);
	assert.strictEqual(S.jwtExpiresAt(''), null);
	assert.strictEqual(S.jwtExpiresAt(null), null);
	assert.strictEqual(S.jwtExpiresAt(undefined), null);
});

test('accessNeedsRefresh: a token with hours left does not', () => {
	assert.strictEqual(S.accessNeedsRefresh(jwt({ exp: NOW / 1000 + 3600 }), NOW), false);
});
test('accessNeedsRefresh: inside the 5-minute margin, at the margin, and already expired all do', () => {
	assert.strictEqual(S.accessNeedsRefresh(jwt({ exp: NOW / 1000 + 299 }), NOW), true);
	assert.strictEqual(S.accessNeedsRefresh(jwt({ exp: NOW / 1000 + 300 }), NOW), true);
	assert.strictEqual(S.accessNeedsRefresh(jwt({ exp: NOW / 1000 - 1 }), NOW), true);
	assert.strictEqual(S.accessNeedsRefresh(jwt({ exp: NOW / 1000 + 301 }), NOW), false);
});
test('accessNeedsRefresh: an unreadable token is treated as expired (ask the server, do not guess)', () => {
	assert.strictEqual(S.accessNeedsRefresh('opaque', NOW), true);
	assert.strictEqual(S.accessNeedsRefresh('', NOW), true);
});

test('classifyRefresh: 200 with an access token → ok', () => {
	assert.strictEqual(S.classifyRefresh({ status: 200, body: { access: 'a' } }), 'ok');
	assert.strictEqual(S.classifyRefresh({ status: 200, body: { token: 'a' } }), 'ok');   // legacy field name
});
test('classifyRefresh: ONLY an explicit 401 ends the session', () => {
	assert.strictEqual(S.classifyRefresh({ status: 401, body: { error: { code: 'refresh_expired' } } }), 'expired');
	assert.strictEqual(S.classifyRefresh({ status: 401, body: null }), 'expired');
});
test('classifyRefresh: offline, 5xx, 403, a 200 with no token, nothing at all → retry (tokens kept)', () => {
	assert.strictEqual(S.classifyRefresh(null), 'retry');
	assert.strictEqual(S.classifyRefresh({ status: 503, body: null }), 'retry');
	assert.strictEqual(S.classifyRefresh({ status: 500, body: {} }), 'retry');
	assert.strictEqual(S.classifyRefresh({ status: 403, body: {} }), 'retry');
	assert.strictEqual(S.classifyRefresh({ status: 200, body: {} }), 'retry');
	assert.strictEqual(S.classifyRefresh({ status: 200, body: null }), 'retry');
});

test('classifyRefresh: a 2xx whose access token is not a usable string is NOT a renewal', () => {
	for (const access of [{}, [], ['a'], 123, true]) {
		assert.strictEqual(S.classifyRefresh({ status: 200, body: { access } }), 'retry', 'access=' + JSON.stringify(access));
	}
	assert.strictEqual(S.classifyRefresh({ status: 200, body: { token: {} } }), 'retry', 'the legacy field too');
	// The host stores `access || token`, so that is the one judged: a broken `access` is not rescued by a
	// good `token` beside it, and an EMPTY `access` falls through to `token` exactly as the store would.
	assert.strictEqual(S.classifyRefresh({ status: 200, body: { access: {}, token: 'legacy' } }), 'retry');
	assert.strictEqual(S.classifyRefresh({ status: 200, body: { access: '', token: 'legacy' } }), 'ok');
});
test('classifyRefresh: a refresh token, when one is sent, has to be a usable string too', () => {
	for (const refresh of [{}, [], ['r'], 123, true]) {
		assert.strictEqual(S.classifyRefresh({ status: 200, body: { access: 'a', refresh } }), 'retry', 'refresh=' + JSON.stringify(refresh));
	}
});
test('classifyRefresh: no refresh token is still ok — a server that does not rotate sends none', () => {
	for (const body of [{ access: 'a' }, { access: 'a', refresh: null }, { access: 'a', refresh: '' }, { access: 'a', refresh: 'r' }, { token: 'a', refresh: 'r' }]) {
		assert.strictEqual(S.classifyRefresh({ status: 200, body }), 'ok', JSON.stringify(body));
	}
});

test('isSessionExpiredError: the adapter\'s "<label> API 401: …" shape, with and without e.status', () => {
	const e = new Error('LevelCode Cloud API 401: Your LevelCode Cloud session has expired. Sign in again to continue.');
	assert.strictEqual(S.isSessionExpiredError(e), true);
	// @ts-ignore
	e.status = 401; assert.strictEqual(S.isSessionExpiredError(e), true);
	assert.strictEqual(S.isSessionExpiredError({ status: 401 }), true);
});
test('isSessionExpiredError: the server codes and the old raw JWT text, as bare strings', () => {
	assert.strictEqual(S.isSessionExpiredError('token_expired'), true);
	assert.strictEqual(S.isSessionExpiredError('refresh_expired'), true);
	assert.strictEqual(S.isSessionExpiredError('Signature has expired'), true);
});
test('isSessionExpiredError: a 402 cap hit, a 500, a 4010-byte message, nothing → not a dead session', () => {
	assert.strictEqual(S.isSessionExpiredError(new Error('LevelCode Cloud API 402: {"error":{"code":"cap_reached"}}')), false);
	assert.strictEqual(S.isSessionExpiredError(new Error('LevelCode Cloud API 500: upstream')), false);
	assert.strictEqual(S.isSessionExpiredError(new Error('read 4010 bytes')), false);
	assert.strictEqual(S.isSessionExpiredError(null), false);
	assert.strictEqual(S.isSessionExpiredError(undefined), false);
});

console.log('\nsession: ' + n + ' tests passed.');
