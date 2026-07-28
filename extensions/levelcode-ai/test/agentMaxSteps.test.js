/*---------------------------------------------------------------------------------------------
 *  Guards that `levelcode.ai.agent.maxSteps` is read LIVE, not snapshotted — run: node test/agentMaxSteps.test.js
 *
 *  The bug this locks down: the step cap was captured once, as a plain number, when a goal STARTED
 *  (`maxSteps: cfg.get('agent.maxSteps')`). Raising it from 25 to 1000 while the agent was running —
 *  exactly what you do when autopilot pauses at "step limit" and you want it to keep going — had no
 *  effect, because the loop kept comparing against the frozen 25.
 *
 *  The fix mirrors the neighbouring `autopilot` getter: extension.js hands runAgent a live getter that
 *  re-reads a FRESH getConfiguration on each access, and agent.js's loop gates on `ctx.maxSteps`
 *  directly every iteration. Both halves matter, so both are asserted here (from source — a running
 *  runAgent needs a workspace + provider, which this pure-unit suite deliberately doesn't stand up).
 *  If either half regresses to a snapshot, a raised limit silently won't take effect mid-run again.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const pkg = require('../package.json');

let n = 0;
function test(name, fn) { fn(); n++; console.log('  ok - ' + name); }

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

/** The contributed setting node, tolerating configuration being a single object or an array. */
function maxStepsSetting() {
	const c = pkg.contributes.configuration;
	const props = Array.isArray(c) ? Object.assign({}, ...c.map((x) => x.properties || {})) : (c && c.properties) || {};
	return props['levelcode.ai.agent.maxSteps'];
}

test('the setting exists, defaults to 25, and has no upper bound (1000 is valid)', () => {
	const s = maxStepsSetting();
	assert.ok(s, 'levelcode.ai.agent.maxSteps must be contributed');
	assert.equal(s.type, 'number');
	assert.equal(s.default, 25);
	assert.equal(s.minimum, 1);
	// No `maximum`: a user must be able to raise it well past the default (the 1000 in the bug report).
	assert.ok(!('maximum' in s), 'maxSteps must not cap the user below large values like 1000');
});

test('extension.js hands runAgent maxSteps as a LIVE getter over a fresh aiConfig()', () => {
	const ext = read('extension.js');
	assert.match(
		ext,
		/get\s+maxSteps\s*\(\s*\)\s*\{[^}]*aiConfig\(\)\s*\.get\(\s*['"]agent\.maxSteps['"]/,
		'runAgent ctx must expose `get maxSteps()` re-reading a FRESH aiConfig() each access'
	);
});

test('extension.js does NOT re-snapshot the cap from the goal-start cfg (the original bug)', () => {
	const ext = read('extension.js');
	// A `maxSteps:` property whose value pulls from the captured `cfg` freezes the limit for the whole
	// run. (The start-of-run dbg log may still read cfg for telemetry; only the runAgent input matters.)
	assert.ok(
		!/\bmaxSteps:\s*Math\.max\([^)]*\bcfg\.get\(/.test(ext),
		'maxSteps passed to runAgent must not be a static snapshot of the start-of-goal cfg'
	);
});

test('agent.js gates the loop on ctx.maxSteps directly, and never hoists it into a local', () => {
	const ag = read('agent.js');
	assert.match(ag, /while\s*\([^)]*\bctx\.maxSteps\b[^)]*\)/, 'the step loop must read ctx.maxSteps live');
	// A copy (`const max = ctx.maxSteps`) or a destructure (`const { maxSteps } = ctx`) taken before the
	// loop would evaluate the getter exactly once — reintroducing the snapshot from the other side.
	assert.ok(!/\b(?:const|let|var)\s+\w+\s*=\s*ctx\.maxSteps\b/.test(ag), 'ctx.maxSteps must not be assigned into a variable');
	assert.ok(
		!/\b(?:const|let|var)\s*\{[^}]*\bmaxSteps\b[^}]*\}\s*=\s*ctx\b/.test(ag),
		'maxSteps must not be destructured off ctx'
	);
});

console.log(n + ' passing');
