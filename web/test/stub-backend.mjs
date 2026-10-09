// A stand-in for LevelCode Cloud, for testing the browser edition end to end without an account.
//
// It speaks the parts of the real backend that the editor uses and applies the SAME rules the real
// one is required to apply, so a break in the editor's side of the contract shows up here:
//
//   GET  /ai/login                          the browser sign-in page: checks redirect_uri the way
//                                           Levelcode::EditorCallback does for a web editor, then
//                                           acts as an already-signed-in user (302 with ?code=)
//   POST /api/levelcode/v1/auth/exchange    one-time code + PKCE verifier -> access/refresh/profile
//   POST /api/levelcode/v1/auth/refresh
//   GET  /api/levelcode/v1/account/profile  and /account/models
//   POST /api/levelcode/v1/ai/chat/completions   OpenAI-style SSE, scripted
//
// CORS is the part that matters for a browser: answered only for the editor's own origin, with
// `authorization` and `content-type` allowed, and never with credentials.
import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** An unsigned JWT-shaped token: the editor reads `exp` locally, the stub never needs a signature. */
function token(kind, ttlSeconds) {
	const head = b64url(JSON.stringify({ alg: 'none', typ: 'JWT' }));
	const body = b64url(JSON.stringify({ sub: 4242, kind, scope: 'ai:chat ai:agent account:read', exp: Math.floor(Date.now() / 1000) + ttlSeconds, jti: crypto.randomUUID() }));
	return `${head}.${body}.stub`;
}

/** Self-signed certificate for 127.0.0.1 — the editor refuses a plain-http gateway, for good reason. */
function selfSigned() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-stub-tls-'));
	const key = path.join(dir, 'key.pem');
	const cert = path.join(dir, 'cert.pem');
	execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '2',
		'-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost'], { stdio: 'ignore' });
	return { key: fs.readFileSync(key), cert: fs.readFileSync(cert) };
}

/**
 * The scripted model. `messages` are OpenAI-style. Return { text } and/or { toolCalls: [{name, args}] }.
 * The default: asked to "create" something, write one file; after the tool result, say Done.
 */
export function defaultModel(messages) {
	const last = messages[messages.length - 1] || {};
	if (last.role === 'tool') { return { text: 'Done: wrote the file you asked for.' }; }
	const text = String(typeof last.content === 'string' ? last.content : JSON.stringify(last.content || ''));
	if (/\bcreate\b/i.test(text)) {
		return {
			text: 'I will create the file now.',
			toolCalls: [{ name: 'write_file', args: { path: 'hello.txt', content: 'hello from the browser\n', explanation: 'Create the greeting file' } }],
		};
	}
	return { text: 'Hello from the stand-in gateway.' };
}

/**
 * @param {{ editorOrigin: string, port?: number, tls?: boolean, model?: typeof defaultModel, plan?: string }} o
 */
export async function startStub(o) {
	const editorOrigin = o.editorOrigin;
	const model = o.model || defaultModel;
	const plan = o.plan || 'Pro';
	const codes = new Map();       // code -> { challenge, at }
	const refreshes = new Set();
	const log = [];
	const state = { log, codes, signIns: 0, chats: 0, lastChatBody: null };

	const handler = async (req, res) => {
		const url = new URL(req.url, 'http://stub');
		const origin = req.headers.origin;
		const entry = { method: req.method, path: url.pathname, origin, auth: !!req.headers.authorization, at: Date.now() };
		log.push(entry);

		// CORS: only the editor's origin, never credentials.
		const cors = {};
		if (origin && origin === editorOrigin && url.pathname.startsWith('/api/levelcode/v1/')) {
			cors['access-control-allow-origin'] = origin;
			cors.vary = 'Origin';
			cors['access-control-expose-headers'] = '';
		}
		if (req.method === 'OPTIONS') {
			if (cors['access-control-allow-origin']) {
				const wanted = String(req.headers['access-control-request-headers'] || '').toLowerCase().split(',').map((s) => s.trim()).filter(Boolean);
				const ok = wanted.every((h) => ['authorization', 'content-type', 'accept'].includes(h));
				if (ok) {
					Object.assign(cors, { 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'authorization, content-type, accept', 'access-control-max-age': '600' });
				} else { delete cors['access-control-allow-origin']; }
			}
			res.writeHead(204, cors); res.end(); return;
		}

		const readBody = async () => { let s = ''; for await (const c of req) { s += c; } return s; };
		const json = (status, obj) => { res.writeHead(status, Object.assign({ 'content-type': 'application/json' }, cors)); res.end(JSON.stringify(obj)); };

		if (url.pathname === '/ai/login') {
			// The editor sends a URI's toString(), which percent-encodes its query, and then encodes that again
			// for the login URL. The real backend decodes until stable (at most three times); so does this.
			let redirect = url.searchParams.get('redirect_uri') || '';
			for (let i = 0; i < 3 && redirect.includes('%'); i++) {
				let d; try { d = decodeURIComponent(redirect); } catch { break; }
				if (d === redirect) { break; }
				redirect = d;
			}
			const challenge = url.searchParams.get('code_challenge') || '';
			let ok = false;
			try {
				const r = new URL(redirect);
				const q = r.searchParams;
				ok = r.origin === editorOrigin && r.pathname === '/callback.html' && !r.username && !r.hash
					&& q.get('vscode-authority') === 'levelcode.levelcode-ai' && q.get('vscode-path') === '/auth/callback'
					&& /^\d{1,9}$/.test(q.get('vscode-reqid') || '') && ['levelcode', 'atom-plus-plus'].includes(q.get('vscode-scheme') || '');
			} catch { ok = false; }
			if (!ok || !challenge) { res.writeHead(400, { 'content-type': 'text/plain' }); res.end('redirect_uri is not an editor callback'); return; }
			const code = crypto.randomBytes(18).toString('hex');
			codes.set(code, { challenge, at: Date.now() });
			state.signIns++;
			const dest = new URL(redirect);
			dest.searchParams.set('code', code);
			res.writeHead(302, { location: dest.toString(), 'cache-control': 'no-store' });
			res.end();
			return;
		}

		if (url.pathname === '/api/levelcode/v1/auth/exchange' && req.method === 'POST') {
			const body = JSON.parse((await readBody()) || '{}');
			const rec = codes.get(body.code);
			codes.delete(body.code);   // single use
			if (!rec || Date.now() - rec.at > 60_000) { return json(401, { error: 'invalid_code' }); }
			if (b64url(crypto.createHash('sha256').update(String(body.verifier || '')).digest()) !== rec.challenge) { return json(401, { error: 'invalid_verifier' }); }
			const refresh = token('refresh', 30 * 86400);
			refreshes.add(refresh);
			return json(200, { access: token('access', 8 * 3600), refresh, profile: { name: 'Web Tester', email: 'web@example.test', plan } });
		}
		if (url.pathname === '/api/levelcode/v1/auth/refresh' && req.method === 'POST') {
			const body = JSON.parse((await readBody()) || '{}');
			if (!refreshes.has(body.refresh)) { return json(401, { error: 'refresh_expired' }); }
			refreshes.delete(body.refresh);
			const next = token('refresh', 30 * 86400);
			refreshes.add(next);
			return json(200, { access: token('access', 8 * 3600), refresh: next });
		}

		const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
		if (url.pathname.startsWith('/api/levelcode/v1/') && !bearer) { return json(401, { error: 'token_expired' }); }

		if (url.pathname === '/api/levelcode/v1/account/profile') { return json(200, { name: 'Web Tester', email: 'web@example.test', plan }); }
		if (url.pathname === '/api/levelcode/v1/account/models') {
			return json(200, { plan, credits_remaining_micros: 12_500_000, models: [
				{ id: 'levelcode-sonnet', label: 'Sonnet 4.6', live: true },
				{ id: 'levelcode-opus', label: 'Opus 4.8', live: true },
			] });
		}

		if (url.pathname === '/api/levelcode/v1/ai/chat/completions' && req.method === 'POST') {
			const body = JSON.parse((await readBody()) || '{}');
			state.chats++;
			state.lastChatBody = body;
			const turn = model(body.messages || [], body);
			res.writeHead(200, Object.assign({ 'content-type': 'text/event-stream', 'cache-control': 'no-store' }, cors));
			const send = (obj) => res.write('data: ' + JSON.stringify(obj) + '\n\n');
			const base = { id: 'chatcmpl-stub', object: 'chat.completion.chunk', model: body.model || 'stub' };
			if (turn.text) {
				for (const piece of turn.text.match(/.{1,24}/gs) || []) {
					send({ ...base, choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] });
					await new Promise((r) => setTimeout(r, 5));
				}
			}
			(turn.toolCalls || []).forEach((tc, i) => {
				const args = JSON.stringify(tc.args);
				send({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: i, id: 'call_' + state.chats + '_' + i, type: 'function', function: { name: tc.name, arguments: '' } }] }, finish_reason: null }] });
				for (const piece of args.match(/.{1,40}/gs) || []) {
					send({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: i, function: { arguments: piece } }] }, finish_reason: null }] });
				}
			});
			send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: turn.toolCalls && turn.toolCalls.length ? 'tool_calls' : 'stop' }],
				usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 } });
			res.write('data: [DONE]\n\n');
			res.end();
			return;
		}

		res.writeHead(404, Object.assign({ 'content-type': 'application/json' }, cors));
		res.end(JSON.stringify({ error: 'not_found', path: url.pathname }));
	};

	const useTls = o.tls !== false;
	const server = useTls ? https.createServer(selfSigned(), handler) : http.createServer(handler);
	await new Promise((resolve) => server.listen(o.port || 0, '127.0.0.1', resolve));
	const port = server.address().port;
	const origin = `${useTls ? 'https' : 'http'}://127.0.0.1:${port}`;
	return { origin, port, state, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }) };
}

// `node web/test/stub-backend.mjs --editor http://127.0.0.1:8800 --port 8443` runs it by hand.
if (import.meta.url === `file://${process.argv[1]}`) {
	const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, all) => { if (v.startsWith('--')) { a.push([v.slice(2), all[i + 1]]); } return a; }, []));
	const s = await startStub({ editorOrigin: args.editor || 'http://127.0.0.1:8800', port: Number(args.port || 8443) });
	console.log('stub LevelCode Cloud on ' + s.origin);
}
