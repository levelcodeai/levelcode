#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  A minimal MCP server, for driving mcpClient.js in tests. Not shipped behaviour — just enough
 *  protocol to exercise the client: initialize, tools/list, tools/call.
 *
 *  Flags:  --noise   write a non-JSON line to stdout first (servers really do this; the framer must cope)
 *          --crash   exit right after initialize (tests handshake failure + stderr surfacing)
 *          --sample  send a server→client sampling request (the client must REFUSE it)
 *  Deliberate tools: echo (ok) · boom (isError) · hang (never answers → tests the call timeout)
 *  Lives under test/fixtures/ so the CI glob (test/*.test.js) does not run it as a suite.
 *--------------------------------------------------------------------------------------------*/
'use strict';

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);

if (has('--noise')) { process.stdout.write('mock server starting — this line is not JSON\n'); }

const TOOLS = [
	{ name: 'echo', description: 'Echo the input back', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
	{ name: 'boom', description: 'Always fails', inputSchema: { type: 'object', properties: {} } },
	{ name: 'hang', description: 'Never answers', inputSchema: { type: 'object', properties: {} } }
];

function send(o) { process.stdout.write(JSON.stringify(o) + '\n'); }
function reply(id, result) { send({ jsonrpc: '2.0', id, result }); }

function handle(m) {
	// Our own outbound sampling request came back refused — record it so the test can assert it.
	if (m.id === 9001 && m.error) { process.stderr.write('REFUSED ' + m.error.message + '\n'); return; }

	if (m.method === 'initialize') {
		reply(m.id, { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'mock', version: '1' } });
		if (has('--crash')) { process.stderr.write('mock server crashing on purpose\n'); process.exit(3); }
		if (has('--sample')) { send({ jsonrpc: '2.0', id: 9001, method: 'sampling/createMessage', params: {} }); }
		return;
	}
	if (m.method === 'notifications/initialized') { return; }
	if (m.method === 'tools/list') { reply(m.id, { tools: TOOLS }); return; }
	if (m.method === 'tools/call') {
		const name = m.params && m.params.name;
		if (name === 'hang') { return; }                                       // no response, ever
		if (name === 'boom') { reply(m.id, { content: [{ type: 'text', text: 'it broke' }], isError: true }); return; }
		if (name === 'echo') {
			const text = (m.params.arguments && m.params.arguments.text) || '';
			reply(m.id, { content: [{ type: 'text', text: 'echo: ' + text }] });
			return;
		}
		send({ jsonrpc: '2.0', id: m.id, error: { code: -32602, message: 'unknown tool ' + name } });
		return;
	}
	if (m.method && m.id != null) { send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'method not found' } }); }
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
	buf += chunk;
	let i;
	while ((i = buf.indexOf('\n')) >= 0) {
		const line = buf.slice(0, i).trim();
		buf = buf.slice(i + 1);
		if (!line) { continue; }
		let m;
		try { m = JSON.parse(line); } catch { continue; }
		handle(m);
	}
});
process.stdin.on('end', () => process.exit(0));
