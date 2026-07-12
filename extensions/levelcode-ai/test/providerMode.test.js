/*---------------------------------------------------------------------------------------------
 *  Guards the "signed-in users auto-use the paid gateway" behavior — run: node test/providerMode.test.js
 *
 *  levelcode.ai.providerMode MUST default to 'gateway'. Because resolveGateway() falls back to BYOK
 *  whenever there's no token (signed out — see gateway.test.js), a 'gateway' default means signing in
 *  is all it takes to route through the metered plan, while signed-out users transparently stay on
 *  BYOK. If this regresses to 'byok', paid subscriptions silently go unused (users would have to find
 *  and flip the toggle by hand), so this test fails loudly to protect that revenue path.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

const assert = require('assert');
const { resolveGateway } = require('../providers/gateway');
const pkg = require('../package.json');

let n = 0;
function test(name, fn) { fn(); n++; console.log('  ok - ' + name); }

/** The contributed setting node, tolerating configuration being a single object or an array. */
function providerModeSetting() {
	const c = pkg.contributes.configuration;
	const props = Array.isArray(c) ? Object.assign({}, ...c.map(x => x.properties || {})) : (c && c.properties) || {};
	return props['levelcode.ai.providerMode'];
}

test('providerMode defaults to gateway (signed-in users auto-use their plan)', () => {
	const s = providerModeSetting();
	assert.ok(s, 'levelcode.ai.providerMode must be a contributed setting');
	assert.strictEqual(s.default, 'gateway', "default must be 'gateway' — signing in should route through the plan with no manual toggle");
});

test('both modes stay selectable so a user can still opt back into BYOK', () => {
	const s = providerModeSetting();
	assert.deepStrictEqual([...(s.enum || [])].sort(), ['byok', 'gateway']);
});

test('the gateway default is safe when signed out: no token → falls back to BYOK', () => {
	// This is what makes 'gateway' a safe DEFAULT rather than a footgun: with the default mode but no
	// session, the router does not try to use the gateway — it hands back to the BYOK path.
	assert.deepStrictEqual(resolveGateway({ mode: 'gateway', endpoint: 'https://levelcode.ai', token: '' }), { use: false });
});

console.log('\nproviderMode: ' + n + ' tests passed.');
