// `os` for the browser build. The editor has no machine to describe; the extension only needs a
// home directory to hang its private state under (the in-browser file system in shims/fs.js).
'use strict';
const HOME = '/home/levelcode';
module.exports = {
	EOL: '\n',
	homedir: () => HOME,
	tmpdir: () => '/tmp',
	hostname: () => 'levelcode-web',
	platform: () => 'browser',
	type: () => 'Browser',
	arch: () => 'wasm',
	release: () => '',
	cpus: () => [],
	totalmem: () => 0,
	freemem: () => 0,
	userInfo: () => ({ username: 'levelcode', homedir: HOME, shell: null, uid: -1, gid: -1 }),
};
