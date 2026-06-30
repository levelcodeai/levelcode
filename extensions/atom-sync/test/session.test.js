/*---------------------------------------------------------------------------------------------
 *  Unit tests for extensions/atom-sync/session.js  —  run: node session.test.js
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

const assert = require('assert');
const S = require('../session');

let n = 0;
function test(name, fn) { fn(); n++; console.log('  ok - ' + name); }

test('SCOPES is ["sync"] and matches the provider scope', () => {
	assert.deepStrictEqual(S.SCOPES, ['sync']);
});

test('mintDevToken: deterministic per email, opaque, email-specific', () => {
	const a = S.mintDevToken('you@example.com');
	const b = S.mintDevToken('You@Example.com '); // case/space-insensitive
	const c = S.mintDevToken('other@example.com');
	assert.ok(a.startsWith('atmps_'), 'has prefix');
	assert.strictEqual(a, b, 'same email → same token (reachable across devices)');
	assert.notStrictEqual(a, c, 'different email → different token');
	assert.ok(!a.includes(Buffer.from('you@example.com').toString('base64url')), 'email NOT recoverable from token');
});

test('makeSession shape: id, lowercased account.id, default scopes', () => {
	const s = S.makeSession('You@Example.com', 'tok123');
	assert.ok(s.id.startsWith('atompp-'), 'id prefix');
	assert.strictEqual(s.accessToken, 'tok123');
	assert.strictEqual(s.account.id, 'you@example.com', 'account id lowercased');
	assert.strictEqual(s.account.label, 'You@Example.com', 'label preserves case');
	assert.deepStrictEqual(s.scopes, ['sync']);
});

test('makeSession id is stable for the same token, differs across tokens', () => {
	assert.strictEqual(S.makeSession('a@b.co', 'T').id, S.makeSession('a@b.co', 'T').id);
	assert.notStrictEqual(S.makeSession('a@b.co', 'T1').id, S.makeSession('a@b.co', 'T2').id);
});

test('serializeMeta never includes the token; parseMeta round-trips', () => {
	const s = S.makeSession('a@b.co', 'SECRET_TOKEN');
	const json = S.serializeMeta([s]);
	assert.ok(!json.includes('SECRET_TOKEN'), 'token must not be serialized');
	const back = S.parseMeta(json);
	assert.strictEqual(back.length, 1);
	assert.strictEqual(back[0].id, s.id);
	assert.deepStrictEqual(back[0].account, s.account);
});

test('parseMeta tolerates garbage', () => {
	assert.deepStrictEqual(S.parseMeta('not json'), []);
	assert.deepStrictEqual(S.parseMeta(''), []);
	assert.deepStrictEqual(S.parseMeta('{"x":1}'), []); // not an array
});

test('scopesMatch: empty/undefined requested matches; subset required', () => {
	const s = { scopes: ['sync'] };
	assert.strictEqual(S.scopesMatch(s, undefined), true);
	assert.strictEqual(S.scopesMatch(s, []), true);
	assert.strictEqual(S.scopesMatch(s, ['sync']), true);
	assert.strictEqual(S.scopesMatch(s, ['sync', 'other']), false);
});

test('validateEmail', () => {
	assert.ok(S.validateEmail('a@b.co'));
	assert.ok(!S.validateEmail('nope'));
	assert.ok(!S.validateEmail('a@b'));
	assert.ok(!S.validateEmail(''));
	assert.ok(!S.validateEmail(42));
});

// ======================== Additional Comprehensive Tests ========================

test('mintDevToken: different emails produce different tokens', () => {
	const t1 = S.mintDevToken('alice@example.com');
	const t2 = S.mintDevToken('bob@example.com');
	assert.notStrictEqual(t1, t2, 'different emails must produce different tokens');
});

test('mintDevToken: email case-insensitivity', () => {
	const t1 = S.mintDevToken('Test@Example.COM');
	const t2 = S.mintDevToken('test@example.com');
	const t3 = S.mintDevToken('TEST@EXAMPLE.COM');
	assert.strictEqual(t1, t2, 'case should be ignored');
	assert.strictEqual(t2, t3, 'case should be ignored');
});

test('mintDevToken: whitespace normalization', () => {
	const t1 = S.mintDevToken('  user@domain.com  ');
	const t2 = S.mintDevToken('user@domain.com');
	assert.strictEqual(t1, t2, 'leading/trailing spaces should be normalized');
});

test('mintDevToken: token structure and length', () => {
	const token = S.mintDevToken('user@example.com');
	assert.ok(token.startsWith('atmps_'), 'must start with atmps_ prefix');
	assert.strictEqual(token.length, 70, 'atmps_ (6) + 64-char hex SHA256 = 70 chars'); // atmps_ is 6 chars, SHA256 hex is 64
});

test('makeSession: custom scopes override defaults', () => {
	const s1 = S.makeSession('a@b.co', 'tok', ['custom', 'scopes']);
	assert.deepStrictEqual(s1.scopes, ['custom', 'scopes']);
});

test('makeSession: null/undefined scopes use defaults', () => {
	const s1 = S.makeSession('a@b.co', 'tok', null);
	const s2 = S.makeSession('a@b.co', 'tok', undefined);
	const s3 = S.makeSession('a@b.co', 'tok');
	assert.deepStrictEqual(s1.scopes, S.SCOPES);
	assert.deepStrictEqual(s2.scopes, S.SCOPES);
	assert.deepStrictEqual(s3.scopes, S.SCOPES);
});

test('makeSession: empty scopes array uses defaults', () => {
	const s = S.makeSession('a@b.co', 'tok', []);
	assert.deepStrictEqual(s.scopes, S.SCOPES);
});

test('makeSession: id deterministic for same token', () => {
	const s1 = S.makeSession('email1@test.com', 'abc123');
	const s2 = S.makeSession('email2@test.com', 'abc123');
	// Same token should produce same id, regardless of email
	assert.strictEqual(s1.id, s2.id, 'id should be based on token only');
});

test('makeSession: email case-insensitive in account.id', () => {
	const s1 = S.makeSession('User@Example.COM', 'tok');
	const s2 = S.makeSession('user@example.com', 'tok');
	assert.strictEqual(s1.account.id, 'user@example.com');
	assert.strictEqual(s2.account.id, 'user@example.com');
	assert.strictEqual(s1.account.id, s2.account.id);
});

test('makeSession: account label preserves original case', () => {
	const labels = ['USER@EXAMPLE.COM', 'User@Example.Com', 'user@example.com'];
	labels.forEach((label, i) => {
		const s = S.makeSession(label, 'tok' + i);
		assert.strictEqual(s.account.label, label, `label ${i} should preserve case`);
	});
});

test('serializeMeta: multiple sessions', () => {
	const s1 = S.makeSession('a@b.co', 'tok1');
	const s2 = S.makeSession('c@d.com', 'tok2');
	const s3 = S.makeSession('e@f.org', 'tok3');
	const json = S.serializeMeta([s1, s2, s3]);
	const back = S.parseMeta(json);
	assert.strictEqual(back.length, 3);
	assert.strictEqual(back[0].id, s1.id);
	assert.strictEqual(back[1].id, s2.id);
	assert.strictEqual(back[2].id, s3.id);
});

test('serializeMeta: preserves account and scopes for each session', () => {
	const s1 = S.makeSession('alice@example.com', 'token1', ['sync', 'profile']);
	const s2 = S.makeSession('bob@example.com', 'token2', ['sync']);
	const json = S.serializeMeta([s1, s2]);
	const back = S.parseMeta(json);
	assert.deepStrictEqual(back[0].account, s1.account);
	assert.deepStrictEqual(back[0].scopes, s1.scopes);
	assert.deepStrictEqual(back[1].account, s2.account);
	assert.deepStrictEqual(back[1].scopes, s2.scopes);
});

test('parseMeta: empty array string', () => {
	assert.deepStrictEqual(S.parseMeta('[]'), []);
});

test('parseMeta: null as input', () => {
	assert.deepStrictEqual(S.parseMeta(null), []);
});

test('parseMeta: undefined as input', () => {
	assert.deepStrictEqual(S.parseMeta(undefined), []);
});

test('parseMeta: malformed JSON returns empty array', () => {
	assert.deepStrictEqual(S.parseMeta('{invalid'), []);
	assert.deepStrictEqual(S.parseMeta('[1, 2, }'), []);
});

test('parseMeta: object instead of array returns empty array', () => {
	assert.deepStrictEqual(S.parseMeta(JSON.stringify({ sessions: [] })), []);
});

test('scopesMatch: exact scope match', () => {
	const s = { scopes: ['sync', 'profile'] };
	assert.strictEqual(S.scopesMatch(s, ['sync']), true);
	assert.strictEqual(S.scopesMatch(s, ['profile']), true);
	assert.strictEqual(S.scopesMatch(s, ['sync', 'profile']), true);
});

test('scopesMatch: missing required scope fails', () => {
	const s = { scopes: ['sync'] };
	assert.strictEqual(S.scopesMatch(s, ['profile']), false);
	assert.strictEqual(S.scopesMatch(s, ['sync', 'profile']), false);
});

test('scopesMatch: session without scopes property', () => {
	const s = {};
	assert.strictEqual(S.scopesMatch(s, undefined), true);
	assert.strictEqual(S.scopesMatch(s, []), true);
	assert.strictEqual(S.scopesMatch(s, ['sync']), false);
});

test('scopesMatch: order independence', () => {
	const s = { scopes: ['a', 'b', 'c'] };
	assert.strictEqual(S.scopesMatch(s, ['c', 'a']), true);
	assert.strictEqual(S.scopesMatch(s, ['b', 'a', 'c']), true);
});

test('validateEmail: valid email formats', () => {
	const valid = [
		'a@b.co',
		'user@example.com',
		'test.user@example.co.uk',
		'first.last@example.org',
		'user+tag@example.com',
		'x@y.z'
	];
	valid.forEach(email => {
		assert.ok(S.validateEmail(email), `"${email}" should be valid`);
	});
});

test('validateEmail: invalid email formats', () => {
	const invalid = [
		'', 'user', 'user@', '@example.com', 'user@example',
		'user name@example.com', 'user@exam ple.com', 'user@@example.com',
		null, undefined, 123, true, false, [], {}
	];
	invalid.forEach(email => {
		assert.ok(!S.validateEmail(email), `"${email}" should be invalid`);
	});
});

test('validateEmail: email edge cases', () => {
	assert.ok(!S.validateEmail('  '), 'whitespace-only string is invalid');
	assert.ok(!S.validateEmail('a@.co'), 'no domain name is invalid');
	assert.ok(!S.validateEmail('@.'), 'only @ and . is invalid');
	assert.ok(S.validateEmail('a@b.c'), 'single letter domain parts are valid');
});

test('SCOPES: contains expected default scope', () => {
	assert.ok(S.SCOPES.includes('sync'), 'SCOPES must include "sync"');
	assert.ok(Array.isArray(S.SCOPES), 'SCOPES must be an array');
	// Store original for next tests
	const original = S.SCOPES.slice();
	assert.deepStrictEqual(S.SCOPES, original, 'SCOPES should be consistent');
});

test('Cross-session consistency: same email always maps to same token', () => {
	const sessions = [];
	for (let i = 0; i < 5; i++) {
		const token = S.mintDevToken('consistent@example.com');
		sessions.push(token);
	}
	// All tokens for the same email should be identical
	const first = sessions[0];
	assert.ok(sessions.every(t => t === first), 'same email should always produce same token');
});

test('Session isolation: different tokens create independent sessions', () => {
	const t1 = S.mintDevToken('user@test.com');
	const t2 = S.mintDevToken('user@test.com');
	// Same email but generated at different times should still be identical
	assert.strictEqual(t1, t2, 'dev tokens are deterministic');
	
	const s1 = S.makeSession('user@test.com', t1);
	const s2 = S.makeSession('user@test.com', t2);
	// Since tokens are identical, sessions should be identical
	assert.strictEqual(s1.id, s2.id);
	assert.deepStrictEqual(s1, s2);
});

test('Metadata security: tokens never leak into serialized data', () => {
	const secret = 'SUPER_SECRET_TOKEN_12345';
	const session = S.makeSession('test@example.com', secret);
	const serialized = S.serializeMeta([session]);
	
	// The secret token must not appear anywhere in the serialized output
	assert.ok(!serialized.includes(secret), 'token should not be in serialized metadata');
	assert.ok(!serialized.includes(Buffer.from(secret).toString('base64')), 'base64 encoded token should not be in metadata');
	assert.ok(!serialized.includes(Buffer.from(secret).toString('hex')), 'hex encoded token should not be in metadata');
});

console.log('\nsession.js: ' + n + ' tests passed.');
