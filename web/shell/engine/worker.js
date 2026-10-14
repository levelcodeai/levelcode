// The engine worker. build.mjs bundles this file, core.js, overlay-fs.js, compat.js, limits.js and the patched
// just-bash into ONE classic script (engine.worker.js), because a worker made from a Blob cannot import anything.
//
// It does nothing but wire the worker's message port to the core: every decision is made in core.js, which is the
// part the node tests run.
'use strict';
// @ts-check

/** @type {any} the patched just-bash: build.mjs resolves this name to apply-patches.mjs's output */
// @ts-ignore -- not a package: only the build knows it
const Engine = require('lc-just-bash');
const { createCore } = require('./core.js');

const core = createCore({
	Engine,
	post: (message, transfer) => /** @type {any} */ (self).postMessage(message, transfer || []),
});

self.onmessage = (event) => {
	// handle() answers for itself, always; this catch only keeps a bug in it from becoming an unhandled rejection
	core.handle(event.data).catch(() => { /* nothing a worker can do about it */ });
};
