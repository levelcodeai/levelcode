/*---------------------------------------------------------------------------------------------
 *  Local time that is not the visitor's — run: node web/test/unit/shell-engine-zone.test.js
 *
 *  engine/zone.js is the `Date` the patched just-bash uses (patch LC-16) and what compat.js and the overlay use for the
 *  times of a file: local time is the zone of the command's TZ, and UTC when it has none. The process's own zone (the
 *  visitor's, in a browser) is never asked: every check here is run under three of them.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

const assert = require('assert');
const path = require('path');

const zone = require(path.join(__dirname, '..', '..', 'shell', 'engine', 'zone.js'));
const D = zone.LcDate;

/** @type {Array<{ name: string, fn: () => Promise<void> | void }>} */
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

const was = process.env.TZ;
const iso = (ms) => new Date(ms).toISOString();
/** run fn once for each of several zones of the PROCESS: the answers must not depend on it */
function underProcessZones(fn) {
	try {
		for (const z of ['UTC', 'America/New_York', 'Asia/Tokyo', 'Pacific/Auckland', 'Asia/Kolkata']) {
			process.env.TZ = z;
			fn(z);
		}
	} finally {
		if (was === undefined) { delete process.env.TZ; } else { process.env.TZ = was; }
		zone.setZone(undefined);
	}
}

test('which names are zones: IANA names, UTC and its spellings; anything else is UTC (TZ is a variable people type anything in)', () => {
	assert.strictEqual(zone.validZone('America/New_York'), 'America/New_York');
	assert.strictEqual(zone.validZone('Asia/Kolkata'), 'Asia/Kolkata');
	for (const u of ['UTC', 'utc', 'GMT', 'Z', 'UT', 'Etc/UTC', 'Zulu']) { assert.strictEqual(zone.validZone(u), 'UTC', u); }
	for (const bad of ['', 'Nowhere/Land', 'EST5EDT-x', ' ', 42, null, undefined, {}]) { assert.strictEqual(zone.validZone(/** @type {any} */ (bad)), null, String(bad)); }
	zone.setZone('Asia/Tokyo');
	assert.strictEqual(zone.getZone(), 'Asia/Tokyo');
	zone.setZone('Nowhere/Land');
	assert.strictEqual(zone.getZone(), 'UTC', 'a bad TZ is UTC, not the previous command\'s zone');
	zone.setZone(undefined);
	assert.strictEqual(zone.getZone(), 'UTC');
});

test('offsets, including both sides of a daylight saving change and a zone that is not a whole hour', () => {
	assert.strictEqual(zone.offsetAt('UTC', 0), 0);
	assert.strictEqual(zone.offsetAt('Asia/Tokyo', 0), 9 * 3600000);
	assert.strictEqual(zone.offsetAt('Asia/Kolkata', 0), 5.5 * 3600000);
	assert.strictEqual(zone.offsetAt('America/New_York', Date.UTC(2020, 0, 15)), -5 * 3600000);
	assert.strictEqual(zone.offsetAt('America/New_York', Date.UTC(2020, 5, 15)), -4 * 3600000);
	// the change of 2020-03-08 is at 07:00 UTC
	assert.strictEqual(zone.offsetAt('America/New_York', Date.UTC(2020, 2, 8, 6, 59, 59)), -5 * 3600000);
	assert.strictEqual(zone.offsetAt('America/New_York', Date.UTC(2020, 2, 8, 7, 0, 0)), -4 * 3600000);
	assert.strictEqual(zone.offsetAt('Australia/Sydney', Date.UTC(2020, 0, 15)), 11 * 3600000);
	assert.strictEqual(zone.offsetAt('Nowhere/Land', 0), 0);
	assert.strictEqual(zone.offsetAt('Asia/Tokyo', NaN), 0);
});

test('the wall clock of an instant, and the instant of a wall clock (a skipped hour and a repeated one)', () => {
	const p = zone.partsAt(Date.UTC(2020, 1, 29, 23, 30, 5, 123), 'Asia/Tokyo');
	assert.deepStrictEqual([p.year, p.month, p.day, p.hour, p.minute, p.second, p.ms, p.weekday], [2020, 2, 1, 8, 30, 5, 123, 0]);
	assert.strictEqual(p.offsetMs, 9 * 3600000);
	assert.strictEqual(iso(zone.instantOf(Date.UTC(2020, 1, 29, 12), 'Asia/Tokyo')), '2020-02-29T03:00:00.000Z');
	assert.strictEqual(iso(zone.instantOf(Date.UTC(2020, 5, 1, 12), 'America/New_York')), '2020-06-01T16:00:00.000Z');
	assert.strictEqual(iso(zone.instantOf(Date.UTC(2020, 11, 31, 23, 59, 59), 'UTC')), '2020-12-31T23:59:59.000Z');
	// 2020-03-08 02:30 does not exist in New York: read with the offset from before the skip (EST), so it is 03:30 EDT
	assert.strictEqual(iso(zone.instantOf(Date.UTC(2020, 2, 8, 2, 30), 'America/New_York')), '2020-03-08T07:30:00.000Z');
	// 2020-11-01 01:30 exists twice: the first (EDT)
	assert.strictEqual(iso(zone.instantOf(Date.UTC(2020, 10, 1, 1, 30), 'America/New_York')), '2020-11-01T05:30:00.000Z');
	assert.strictEqual(zone.wallUtc(99, 0, 1, 0, 0, 0, 0), Date.parse('0099-01-01T00:00:00Z'), 'a year 99 is the year 99 here, not 1999');
	assert.ok(zone.wallUtc(99, 0, 1, 0, 0, 0, 0) < 0);
});

test('a string with no zone is read in the current zone; one that has a zone keeps it', () => {
	zone.setZone('Asia/Tokyo');
	try {
		const cases = [
			['2020-02-29 12:00:00', '2020-02-29T03:00:00.000Z'],
			['2020-02-29T12:00:00', '2020-02-29T03:00:00.000Z'],
			['2020-02-29 12:00', '2020-02-29T03:00:00.000Z'],
			['2020-02-29', '2020-02-28T15:00:00.000Z'],
			['2020/02/29 12:00:00', '2020-02-29T03:00:00.000Z'],
			['Feb 29 2020 12:00:00', '2020-02-29T03:00:00.000Z'],
			['Feb 29, 2020', '2020-02-28T15:00:00.000Z'],
			['2020-02-29 12:00:00.5', '2020-02-29T03:00:00.500Z'],
			['2020-02-29T12:00:00Z', '2020-02-29T12:00:00.000Z'],
			['2020-02-29T12:00:00+01:00', '2020-02-29T11:00:00.000Z'],
			['2020-02-29 12:00:00 +0100', '2020-02-29T11:00:00.000Z'],
			['2020-02-29 12:00:00 UTC', '2020-02-29T12:00:00.000Z'],
			['Sat, 29 Feb 2020 12:00:00 GMT', '2020-02-29T12:00:00.000Z'],
			['Sat Feb 29 2020 12:00:00 GMT+0100 (CET)', '2020-02-29T11:00:00.000Z'],
			['2020-02-29 12:00:00 EST', '2020-02-29T17:00:00.000Z'],
		];
		for (const [text, want] of cases) { assert.strictEqual(iso(new D(text).getTime()), want, text); assert.strictEqual(iso(D.parse(text)), want, 'parse ' + text); }
		assert.ok(Number.isNaN(new D('not a date').getTime()));
		assert.ok(Number.isNaN(new D('').getTime()));
		zone.setZone('UTC');
		assert.strictEqual(iso(new D('2020-02-29 12:00:00').getTime()), '2020-02-29T12:00:00.000Z');
	} finally {
		zone.setZone(undefined);
	}
});

test('the date of the shell is the same whatever zone the process is in (five of them)', () => {
	underProcessZones((proc) => {
		zone.setZone('UTC');
		const t = new D(2020, 1, 29, 12, 30, 45);
		assert.strictEqual(iso(t.getTime()), '2020-02-29T12:30:45.000Z', proc);
		assert.deepStrictEqual([t.getFullYear(), t.getMonth(), t.getDate(), t.getDay(), t.getHours(), t.getMinutes(), t.getSeconds(), t.getMilliseconds(), t.getTimezoneOffset()], [2020, 1, 29, 6, 12, 30, 45, 0, 0], proc);
		assert.strictEqual(iso(new D('2020-02-29 12:30:45').getTime()), '2020-02-29T12:30:45.000Z', proc);
		assert.strictEqual(iso(new D(1583000000000).getTime()), '2020-02-29T18:13:20.000Z');
		zone.setZone('America/New_York');
		const n = new D(2020, 5, 1, 8);
		assert.strictEqual(iso(n.getTime()), '2020-06-01T12:00:00.000Z', proc);
		assert.strictEqual(n.getHours(), 8, proc);
		assert.strictEqual(n.getTimezoneOffset(), 240, proc);
		assert.strictEqual(new D(Date.UTC(2020, 0, 15, 12)).getTimezoneOffset(), 300, 'winter');
	});
});

test('setters work in the zone, across a daylight saving change, whatever zone the process is in', () => {
	underProcessZones((proc) => {
		zone.setZone('America/New_York');
		const d = new D(2020, 2, 8, 1, 30);                  // the evening before the change, 01:30 EST
		d.setDate(d.getDate() + 1);
		assert.deepStrictEqual([d.getDate(), d.getHours(), d.getMinutes()], [9, 1, 30], proc + ': the same wall clock the next day (23 hours later)');
		assert.strictEqual(iso(d.getTime()), '2020-03-09T05:30:00.000Z', proc);
		const e = new D(2020, 0, 31, 10);
		e.setMonth(1);                                         // Feb 31 does not exist: March 2
		assert.deepStrictEqual([e.getMonth(), e.getDate()], [2, 2], proc);
		e.setHours(23, 59, 59, 999);
		assert.deepStrictEqual([e.getHours(), e.getMinutes(), e.getSeconds(), e.getMilliseconds()], [23, 59, 59, 999], proc);
		e.setFullYear(2021, 5, 15);
		assert.deepStrictEqual([e.getFullYear(), e.getMonth(), e.getDate()], [2021, 5, 15], proc);
		e.setMinutes(5);
		e.setSeconds(7);
		e.setMilliseconds(8);
		assert.deepStrictEqual([e.getMinutes(), e.getSeconds(), e.getMilliseconds()], [5, 7, 8], proc);
		// the week of a date, as strftime computes it: set the day to the Thursday of its week
		const w = new D(2020, 0, 1, 12);                      // a Wednesday
		w.setDate(w.getDate() + 3 - ((w.getDay() + 6) % 7));
		assert.deepStrictEqual([w.getFullYear(), w.getMonth(), w.getDate(), w.getDay()], [2020, 0, 2, 4], proc);
	});
});

test('a Date made elsewhere is still a Date of this class, and the class keeps what Date has', () => {
	zone.setZone('UTC');
	assert.ok(new Date(0) instanceof D, 'a Date from the host is one');
	assert.ok(new D(0) instanceof Date);
	assert.ok(!(({}) instanceof D));
	assert.strictEqual(new D(new Date(5000)).getTime(), 5000, 'copied from a Date');
	assert.strictEqual(typeof D.now(), 'number');
	assert.strictEqual(D.UTC(2020, 0, 1), Date.UTC(2020, 0, 1));
	assert.ok(new D().getTime() <= Date.now());
	assert.strictEqual(new D(2020, 0).getDate(), 1, 'the day defaults to 1');
	assert.strictEqual(new D(99, 0, 1).getFullYear(), 1999, 'as Date has it');
	assert.strictEqual(new D(2020, 0, 1).toISOString(), '2020-01-01T00:00:00.000Z');
	assert.strictEqual(JSON.stringify({ t: new D(0) }), '{"t":"1970-01-01T00:00:00.000Z"}');
});

(async () => {
	for (const t of tests) {
		await t.fn();
		console.log('  ok - ' + t.name);
	}
	console.log(`\n${tests.length} tests passed`);
})().catch((e) => { console.error(e); process.exit(1); });
