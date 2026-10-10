// Entry of the browser build of levelcode-ai. The extension itself is unchanged; this wrapper
// only does what a Node extension host does for it before `activate`: make the private file
// system ready and put the extension's own resources where `ctx.extensionPath` says they are.
'use strict';

// host.js reads this to know the code is running in the browser build (no shell, no ripgrep).
globalThis.__LEVELCODE_BROWSER_HOST__ = true;

const fs = require('fs');                 // aliased to ./shims/fs.js by build.mjs
const assets = require('./assets.generated.js');
const real = require('../../extensions/levelcode-ai/extension.js');

async function activate(context) {
	// Everything that reads a file synchronously needs the saved state in memory first.
	await fs.__levelcode.ready;
	fs.__levelcode.mountAssets(context.extensionPath, assets);
	globalThis.__lcExtPath = context.extensionPath;   // stands in for __dirname (see build.mjs)
	return real.activate(context);
}

async function deactivate() {
	try { if (real.deactivate) { await real.deactivate(); } }
	finally { await fs.__levelcode.flush(); }
}

module.exports = { activate, deactivate };
