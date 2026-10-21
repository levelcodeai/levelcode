// `http`, `https`, `dns`, `net` and `zlib` for the browser build: a browser tab cannot open a connection of its own.
// Only webFetchNode.js uses them, and only where host.caps.webDirect is true (the desktop); in the browser the agent
// reads pages through LevelCode Cloud (webSearch.cloudBackend). Anything that still calls one fails the way Node fails
// for an unsupported operation, so a caller's ordinary error path runs.
'use strict';
function unavailable(name) {
	return function () {
		const e = new Error(name + ' is not available in LevelCode in the browser');
		e.code = 'ENOSYS';
		throw e;
	};
}
module.exports = {
	request: unavailable('http.request'), get: unavailable('http.get'), Agent: function Agent() { },
	lookup: unavailable('dns.lookup'), isIP: () => 0,
	createGunzip: unavailable('zlib.createGunzip'), createInflate: unavailable('zlib.createInflate'), createBrotliDecompress: unavailable('zlib.createBrotliDecompress'),
};
