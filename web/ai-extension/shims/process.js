// A `process` for code that was written for Node and only reads a few fields from it. esbuild
// injects this wherever the bundle mentions the free variable `process` (see build.mjs).
'use strict';
const proc = {
	platform: 'browser',
	arch: 'wasm',
	pid: 0,
	env: {},
	argv: [],
	versions: {},
	version: '',
	cwd: () => '/',
	kill() { const e = new Error('process.kill is not available in LevelCode in the browser'); e.code = 'ENOSYS'; throw e; },
	nextTick: (fn, ...args) => { queueMicrotask(() => fn(...args)); },
	emitWarning() { /* nothing to warn */ },
};
module.exports = proc;
module.exports.process = proc;
