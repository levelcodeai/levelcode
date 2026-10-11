/*---------------------------------------------------------------------------------------------
 *  web/shell/src/info.js - run: node web/test/unit/shell-runtime-info.test.js
 *
 *  What the shell says about itself, and the table of limits. README section 7 is "explicit, asserted by
 *  tests": this is the assertion. A number changed in info.js without the README (and the prompt that quotes
 *  it) fails here, which is the point.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const { LIMITS, PROGRAMS, MISSING, BUILTINS, mergeLimits, createInfo } = require(path.join(__dirname, '..', '..', 'shell', 'src', 'info.js'));

const MiB = 1024 * 1024;
let n = 0;
function test(/** @type {string} */ name, /** @type {() => void} */ fn) { fn(); n++; console.log('  ok - ' + name); }

test('the limits are the ones of README section 7, number for number', () => {
	assert.deepStrictEqual(JSON.parse(JSON.stringify(LIMITS)), {
		engine: {
			maxCommandCount: 100000, maxLoopIterations: 100000, maxCallDepth: 100,
			maxOutputSize: 8 * MiB, maxStringLength: 16 * MiB, maxLiveBytes: 64 * MiB, maxInputBytes: 32 * MiB,
			maxExecutionTimeMs: 600000,
		},
		read: { file: 4 * MiB, run: 16 * MiB, served: 32 * MiB },
		agent: { writeFile: 1 * MiB, writeRun: 8 * MiB, entries: 2000 },
		terminal: { writeFile: 8 * MiB, writeRun: 32 * MiB, entries: 2000 },
		workers: { max: 4, idleMs: 60000, readyMs: 20000, fsMs: 60000, checkMs: 60000, commitMs: 120000, deadlineGraceMs: 15000, completeMax: 200, completeMs: 2000 },
	});
});

test('the table cannot be edited by whoever holds it: frozen all the way down', () => {
	assert.ok(Object.isFrozen(LIMITS) && Object.isFrozen(LIMITS.engine) && Object.isFrozen(LIMITS.workers));
	assert.throws(() => { 'use strict'; /** @type {any} */ (LIMITS).engine.maxCommandCount = 1; }, TypeError);
	assert.ok(Object.isFrozen(PROGRAMS) && Object.isFrozen(MISSING) && Object.isFrozen(BUILTINS));
});

test('mergeLimits: an override replaces a known key; unknown groups and keys, and values that are not positive numbers, change nothing', () => {
	const m = mergeLimits({ engine: { maxCommandCount: 50 }, read: { file: 10 }, nonsense: { x: 1 } });
	assert.strictEqual(m.engine.maxCommandCount, 50);
	assert.strictEqual(m.read.file, 10);
	assert.strictEqual(m.read.run, 16 * MiB, 'what was not overridden is the default');
	assert.ok(!('nonsense' in m));
	const bad = mergeLimits({ engine: { maxCommandCount: 0, maxLoopIterations: -5, maxCallDepth: NaN, maxOutputSize: Infinity, maxStringLength: '9', maxLiveBytes: null, typo: 7 }, read: 'no', agent: null });
	assert.deepStrictEqual(JSON.parse(JSON.stringify(bad)), JSON.parse(JSON.stringify(LIMITS)));
	assert.ok(!('typo' in bad.engine));
	assert.deepStrictEqual(JSON.parse(JSON.stringify(mergeLimits(undefined))), JSON.parse(JSON.stringify(LIMITS)));
	assert.strictEqual(LIMITS.engine.maxCommandCount, 100000, 'the defaults are untouched by a merge');
});

test('PROGRAMS: sorted, unique, plain names, and none of what README section 8 says answers 127', () => {
	assert.deepStrictEqual(PROGRAMS.slice(), PROGRAMS.slice().sort());
	assert.strictEqual(new Set(PROGRAMS).size, PROGRAMS.length);
	assert.ok(PROGRAMS.every((p) => /^[a-z0-9._-]+$/.test(p)), 'plain names');
	for (const never of ['curl', 'wget', 'js-exec', 'python3', 'python', 'sqlite3', 'tar', 'yq', 'xan', 'git', 'node', 'npm', 'html-to-markdown']) {
		assert.ok(!PROGRAMS.includes(never), never + ' is not a program of this shell');
	}
	for (const must of ['cat', 'ls', 'grep', 'sed', 'awk', 'find', 'sort', 'uniq', 'wc', 'head', 'tail', 'cp', 'mv', 'rm', 'mkdir', 'touch', 'xargs', 'jq', 'diff', 'tee', 'tr', 'cut', 'sh', 'bash', 'echo', 'printf']) {
		assert.ok(PROGRAMS.includes(must), must);
	}
	assert.ok(PROGRAMS.length >= 70 && PROGRAMS.length <= 100, 'about 80: ' + PROGRAMS.length);
});

test('MISSING: names what a model reaches for; sorted, unique, and never a program that is in PROGRAMS', () => {
	for (const m of ['git', 'npm', 'npx', 'node', 'nodejs', 'yarn', 'pnpm', 'python', 'python3', 'pip', 'pip3', 'curl', 'wget', 'make', 'tar', 'unzip', 'zip', 'gcc', 'docker', 'ssh', 'sudo']) {
		assert.ok(MISSING.includes(m), m);
	}
	assert.deepStrictEqual(MISSING.slice(), MISSING.slice().sort());
	assert.strictEqual(new Set(MISSING).size, MISSING.length);
	assert.deepStrictEqual(MISSING.filter((m) => PROGRAMS.includes(m)), []);
});

test('BUILTINS are for completion only: none of them is also a program name twice over', () => {
	assert.ok(BUILTINS.includes('cd') && BUILTINS.includes('export') && BUILTINS.includes('source'));
	assert.deepStrictEqual(BUILTINS.filter((b) => ['cat', 'ls', 'grep'].includes(b)), []);
});

test('createInfo: the object README section 3 describes - label, three false flags, commands, missing, limits - and JSON of it', () => {
	const { info } = createInfo();
	assert.deepStrictEqual(JSON.parse(JSON.stringify(info)), {
		label: 'LevelCode Shell', background: false, programs: false, network: false,
		commands: PROGRAMS, missing: MISSING,
		limits: { commandCount: 100000, loopIterations: 100000, callDepth: 100, outputBytes: 8 * MiB, fileReadBytes: 4 * MiB, runReadBytes: 16 * MiB },
	});
	assert.deepStrictEqual(Object.keys(info), ['label', 'background', 'programs', 'network', 'commands', 'missing', 'limits']);
});

test('createInfo: nothing on it can be assigned, and the lists handed out are copies', () => {
	const { info } = createInfo();
	for (const k of ['label', 'background', 'network', 'commands', 'missing', 'limits']) {
		assert.throws(() => { 'use strict'; /** @type {any} */ (info)[k] = 1; }, TypeError, k);
	}
	info.commands.push('hack');
	info.missing.length = 0;
	assert.ok(!info.commands.includes('hack'));
	assert.ok(info.missing.includes('git'));
	assert.throws(() => { 'use strict'; /** @type {any} */ (info.limits).commandCount = 1; }, TypeError);
});

test('createInfo: limits come from the table, so an override of the table is what the prompt quotes', () => {
	const { info, limits } = createInfo({ engine: { maxCommandCount: 777 }, read: { file: 5 } });
	assert.strictEqual(info.limits.commandCount, 777);
	assert.strictEqual(info.limits.fileReadBytes, 5);
	assert.strictEqual(limits.engine.maxCommandCount, 777);
});

test('update: the engine\'s list replaces the constant, sorted and de-duplicated, and `missing` follows it', () => {
	const { info, update } = createInfo();
	update(['zip', 'cat', 'git', 'cat', 'ls']);
	assert.deepStrictEqual(info.commands, ['cat', 'git', 'ls', 'zip']);
	assert.ok(!info.missing.includes('git') && !info.missing.includes('zip'));
	assert.ok(info.missing.includes('npm') && info.missing.includes('tar'));
});

test('update: anything that is not a list of plain names is ignored, and the old list stays', () => {
	const { info, update } = createInfo();
	update(['alpha']);
	for (const bad of [undefined, null, 'cat', 42, {}, [], [42, null, {}], ['has space', 'new\nline', '', 'x'.repeat(65)]]) {
		update(/** @type {any} */ (bad));
		assert.deepStrictEqual(info.commands, ['alpha'], JSON.stringify(bad));
	}
	update(['ok', 'bad name', 7, 'fine']);
	assert.deepStrictEqual(info.commands, ['fine', 'ok'], 'the good names of a mixed list are kept');
});

/* ----- against the engine itself ----------------------------------------------------------------- */

// The prompt names these programs before an engine has ever answered, and init hands them to the engine as its
// allow-list, so a drift from what the engine really has is a lie to the model or a disabled command. The engine
// is loaded here the way its own suites load it (the patched just-bash, imported).
(async () => {
	const engineDir = path.join(__dirname, '..', '..', 'shell', 'engine');
	if (!fs.existsSync(path.join(engineDir, 'load.mjs'))) {
		console.log('  skipped - the engine is not in this tree');
	} else {
		const { loadEngine } = await import(pathToFileURL(path.join(engineDir, 'load.mjs')).href);
		const compat = require(path.join(engineDir, 'compat.js'));
		const engine = await loadEngine();
		const offered = Array.from(new Set(engine.getCommandNames().filter((/** @type {string} */ c) => !compat.EXCLUDED.includes(c)).concat(compat.ADDED))).sort();

		test('PROGRAMS is exactly what the engine offers (its built-ins minus the excluded, plus what it defines)', () => {
			assert.deepStrictEqual(PROGRAMS.slice(), offered);
		});

		test('MISSING names everything the engine\'s own list of likely-missing programs does, and nothing the engine offers', () => {
			const absent = compat.LIKELY_MISSING.filter((/** @type {string} */ m) => !MISSING.includes(m));
			assert.deepStrictEqual(absent, [], 'the engine knows these are missing and the prompt would not say so');
			assert.deepStrictEqual(MISSING.filter((m) => offered.includes(m)), []);
		});
	}
	console.log(`\n${n} tests passed`);
})().catch((e) => { console.error(e); process.exit(1); });
