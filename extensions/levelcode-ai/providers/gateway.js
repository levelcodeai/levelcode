/*---------------------------------------------------------------------------------------------
 *  LevelCode — AI · LevelCode Cloud gateway routing (pure)
 *
 *  When the user is signed in to LevelCode Cloud AND `levelcode.ai.providerMode` is `gateway`, AI runs
 *  through the cloud's metered gateway instead of the user's own provider/key. This file is the pure
 *  decision function — no VS Code, no IO — so it can be unit-tested (test/gateway.test.js). The token
 *  is a Bearer credential, so the endpoint MUST be https; an http endpoint is refused.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

/** The gateway is an openai-kind endpoint under the account server's isolated AI namespace. */
const GATEWAY_PATH = '/api/levelcode/v1/ai';

/**
 * Decide whether an AI request should route through the LevelCode Cloud gateway, and resolve the
 * OpenAI-kind endpoint if so. Gateway routing engages only when signed in (a token is present),
 * mode is 'gateway', and an endpoint is set — otherwise `{use:false}` (caller uses the BYOK path).
 * The endpoint MUST be https or we refuse (`{use:true, ok:false, reason:'insecureGateway'}`) so the
 * Bearer token is never sent in plaintext. Pure — unit-tested.
 * @param {{mode?:string, endpoint?:string, token?:string}} o
 * @returns {{use:false} | {use:true, ok:false, reason:string} | {use:true, ok:true, providerId:string, baseURL:string, apiKey:string}}
 */
function resolveGateway(o) {
	const mode = (o && o.mode) || 'byok';
	const endpoint = String((o && o.endpoint) || '').replace(/\/+$/, '');
	const token = (o && o.token) || '';
	if (mode !== 'gateway' || !token || !endpoint) { return { use: false }; }
	if (!/^https:\/\//i.test(endpoint)) { return { use: true, ok: false, reason: 'insecureGateway' }; }
	return { use: true, ok: true, providerId: 'openai', baseURL: endpoint + GATEWAY_PATH, apiKey: token };
}

module.exports = { resolveGateway, GATEWAY_PATH };
