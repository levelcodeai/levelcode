// `child_process` for the browser build: there is no machine to run a program on. Every entry
// point fails the way Node fails for an unsupported syscall, so callers that already handle a
// spawn error (all of them do: it is what a missing ripgrep looks like) take their normal path.
// The agent's shell tools are not offered at all in this build (host.js `caps.shell`).
'use strict';
function unavailable(name) {
	return function () {
		const e = new Error('child_process.' + name + ' is not available in LevelCode in the browser');
		e.code = 'ENOSYS';
		throw e;
	};
}
module.exports = {
	spawn: unavailable('spawn'),
	spawnSync: unavailable('spawnSync'),
	exec: unavailable('exec'),
	execSync: unavailable('execSync'),
	execFile: unavailable('execFile'),
	execFileSync: unavailable('execFileSync'),
	fork: unavailable('fork'),
};
