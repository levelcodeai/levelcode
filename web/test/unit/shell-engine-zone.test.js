/*---------------------------------------------------------------------------------------------
 *  Local time that is not the visitor's — run: node web/test/unit/shell-engine-zone.test.js
 *
 *  engine/zone.js is the `Date` the patched just-bash uses (patch LC-16) and what compat.js and the overlay use for the
 *  times of a file: local time is the zone of the command's TZ, and UTC when it has none. The process's own zone (the
 *  visitor's, in a browser) is never asked: every check here is run under three of them.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

// A test that waits for something that never happens must fail the suite, not end it silently with status 0.
require('../helpers/shell-exit-guard.js');

const assert = require('assert');
const fs = require('fs');
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

test('which names are zones: the files of tzdata, in the case they are written in; the files that are UTC are UTC; what is not a string, empty, or an offset alone is UTC (TZ is a variable people type anything in)', () => {
	assert.strictEqual(zone.validZone('America/New_York'), 'America/New_York');
	assert.strictEqual(zone.validZone('Asia/Kolkata'), 'Asia/Kolkata');
	assert.strictEqual(zone.validZone('US/Eastern'), 'US/Eastern', 'an alias is a file too');
	for (const u of ['UTC', 'GMT', 'Etc/UTC', 'Etc/GMT', 'Zulu', 'UCT', 'Universal', 'GMT0', 'GMT+0', 'GMT-0', 'Greenwich']) { assert.strictEqual(zone.validZone(u), 'UTC', u); }
	for (const bad of ['', ' \u0000'.slice(2), '+09:00', '-0500', ':', 42, null, undefined, {}]) { assert.strictEqual(zone.validZone(/** @type {any} */ (bad)), null, String(bad)); }
	// a file system has case: Intl takes `asia/tokyo`, `est`, `us/eastern`, GNU does not (it keeps the letters as a name)
	for (const mis of ['asia/tokyo', 'ASIA/TOKYO', 'Asia/tokyo', 'us/eastern', 'america/new_york', 'est', 'utc', 'gmt']) {
		const key = /** @type {string} */ (zone.validZone(mis));
		assert.ok(key.startsWith('posix:'), mis + ' is no zone file: ' + key);
		assert.strictEqual(zone.offsetAt(key, 1600000000000), 0, mis);
	}
	zone.setZone('Asia/Tokyo');
	assert.strictEqual(zone.getZone(), 'Asia/Tokyo');
	zone.setZone(undefined);
	assert.strictEqual(zone.getZone(), 'UTC');
	zone.setZone('asia/tokyo');
	assert.strictEqual(zone.partsAt(0).hour, 0, 'a mis-cased name is not Tokyo');
	zone.setZone(undefined);
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

test('what a TZ may be: an IANA name (with glibc\'s colon too), UTC, or POSIX NAME+offset in hours WEST (JST-9 is UTC+9); with a daylight rule the standard time; anything else the letters it starts with and offset 0', () => {
	const offsetOf = (name, at = 0) => zone.offsetAt(/** @type {string} */ (zone.validZone(name)), at) / 60000;
	assert.strictEqual(zone.validZone(':America/New_York'), 'America/New_York');
	assert.strictEqual(zone.validZone(':UTC'), 'UTC');
	assert.strictEqual(offsetOf('JST-9'), 540);
	assert.strictEqual(offsetOf('UTC+3'), -180);
	assert.strictEqual(offsetOf('EST5'), -300);
	assert.strictEqual(offsetOf('<+0530>-5:30'), 330);
	assert.strictEqual(offsetOf('<-03>3'), -180);
	assert.strictEqual(offsetOf('ABC-1:30:15'), 90 + 0.25);
	assert.strictEqual(offsetOf('EST5EDT', Date.UTC(2020, 6, 1)), -240, 'a name Intl knows has its rules');
	assert.strictEqual(offsetOf('EST5EDT,M3.2.0,M11.1.0', Date.UTC(2020, 6, 1)), -300, 'a daylight saving rule is not applied: standard time');
	assert.strictEqual(offsetOf('JST-9x'), 540, 'what follows the offset is not read');
	assert.strictEqual(offsetOf('JST-25'), 0, 'an offset over 24 hours is none');
	for (const none of ['+09:00', '-0500', ':']) { assert.strictEqual(zone.validZone(none), null, none); }
	// no zone: the letters it starts with are the name (three or more), the offset is 0
	const named = (name) => { zone.setZone(name); try { return zone.abbreviation(1600000000000); } finally { zone.setZone(undefined); } };
	assert.deepStrictEqual(['Nowhere', 'Nowhere/Land', 'asia/tokyo', 'est', 'ab', 'us/eastern', 'a/b/c', '9'].map(named), ['Nowhere', 'Nowhere', 'asia', 'est', '', '', '', '']);
	underProcessZones((proc) => {
		zone.setZone('JST-9');
		assert.strictEqual(new D(2020, 1, 29, 12).toISOString(), '2020-02-29T03:00:00.000Z', proc);
		assert.deepStrictEqual([new D(0).getHours(), new D(0).getTimezoneOffset()], [9, -540], proc);
		assert.strictEqual(zone.parseWall('2020-02-29 12:00:00'), Date.UTC(2020, 1, 29, 3), proc);
		zone.setZone(undefined);
	});
});

test('%Z: the short name by the offset the zone has at that instant; tzdata\'s digits for a zone without letters; the name asked for when it is GMT; never Intl\'s GMT+9', () => {
	const at = (name, ms) => { zone.setZone(name); try { return zone.abbreviation(ms); } finally { zone.setZone(undefined); } };
	const jan = Date.UTC(2020, 0, 15);
	const jul = Date.UTC(2020, 6, 15);
	assert.deepStrictEqual(['Asia/Tokyo', 'Asia/Seoul', 'Asia/Kolkata', 'Asia/Shanghai', 'Asia/Hong_Kong'].map((z) => at(z, jan)), ['JST', 'KST', 'IST', 'CST', 'HKT']);
	assert.deepStrictEqual(['America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'America/Phoenix', 'America/Anchorage', 'Pacific/Honolulu'].map((z) => at(z, jan)), ['EST', 'CST', 'MST', 'PST', 'MST', 'AKST', 'HST']);
	assert.deepStrictEqual(['America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'America/Phoenix', 'America/Anchorage'].map((z) => at(z, jul)), ['EDT', 'CDT', 'MDT', 'PDT', 'MST', 'AKDT']);
	assert.deepStrictEqual([at('Europe/London', jan), at('Europe/London', jul), at('Europe/Dublin', jul), at('Europe/Paris', jan), at('Europe/Paris', jul), at('Europe/Athens', jul), at('Europe/Moscow', jul)], ['GMT', 'BST', 'IST', 'CET', 'CEST', 'EEST', 'MSK']);
	assert.deepStrictEqual([at('Australia/Sydney', jan), at('Australia/Sydney', jul), at('Australia/Perth', jan), at('Pacific/Auckland', jan), at('Pacific/Auckland', jul)], ['AEDT', 'AEST', 'AWST', 'NZDT', 'NZST']);
	assert.deepStrictEqual([at('Asia/Dubai', jan), at('America/Sao_Paulo', jan), at('Asia/Singapore', jan), at('Asia/Kathmandu', jul), at('Etc/GMT-9', jan), at('Asia/Colombo', jul)], ['+04', '-03', '+08', '+0545', '+09', '+0530']);
	assert.strictEqual(at('JST-9', jan), 'JST', 'the name a POSIX TZ was given');
	assert.strictEqual(at('<+0530>-5:30', jan), '+0530');
	assert.strictEqual(at('UTC', jan), 'UTC');
	assert.strictEqual(at('GMT', jan), 'GMT');
	assert.strictEqual(at(':Etc/GMT', jan), 'GMT');
	assert.strictEqual(at('GMT0', jan), 'GMT');
	assert.strictEqual(at('Universal', jan), 'UTC');
	assert.strictEqual(at('Etc/UTC', jan), 'UTC');
	assert.strictEqual(at('Nowhere/Land', jan), 'Nowhere', 'what glibc does with a name that is no file: its letters');
	assert.strictEqual(at(undefined, jan), 'UTC');
	zone.setZone('Asia/Tokyo');
	assert.strictEqual(zone.abbreviation(jan, 'America/New_York'), 'EST', 'a zone named is the zone');
	assert.strictEqual(zone.abbreviation(jan, 'UTC'), 'UTC');
	zone.setZone(undefined);
	for (const z of ['Asia/Tokyo', 'Europe/Paris', 'Asia/Kolkata', 'Australia/Adelaide', 'America/St_Johns']) { assert.ok(!/GMT[+-]/.test(at(z, jan)), z); }
});

test('every zone file of the reference system, at four instants: %Z and %z are what GNU date printed (zones.json, recorded by the generator, not read back from zone-data.js)', () => {
	const rec = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'shell', 'zones', 'zones.json'), 'utf8'));
	const names = Object.keys(rec.zones);
	assert.ok(names.length > 550, 'the names recorded: ' + names.length);
	const wrong = [];
	for (const name of names) {
		zone.setZone(name);
		rec.instants.forEach((t, k) => {
			const minutes = Math.trunc(zone.offsetAt(zone.getZone(), t * 1000) / 60000);
			const a = Math.abs(minutes);
			const z = (minutes < 0 ? '-' : '+') + String(Math.floor(a / 60)).padStart(2, '0') + String(a % 60).padStart(2, '0');
			const got = `${zone.abbreviation(t * 1000)}|${z}`;
			if (got !== rec.zones[name][k]) { wrong.push(`${name} @${t}: ${got} (GNU ${rec.zones[name][k]})`); }
		});
	}
	zone.setZone(undefined);
	assert.deepStrictEqual(wrong.slice(0, 20), [], `${wrong.length} of ${names.length * rec.instants.length} differ`);
	// the data names exactly the files the recording has
	const data = require(path.join(__dirname, '..', '..', 'shell', 'engine', 'zone-data.js'));
	assert.deepStrictEqual([...data.NAMES].sort(), [...names].sort());
	assert.ok(data.NAMES.length < 700);
});

test('a time zone with seconds in its offset prints %z without them, as strftime does (the engine printed +0930.25)', () => {
	zone.setZone('XXX-9:30:15');
	const d = new D(0);
	assert.strictEqual(d.getTimezoneOffset(), -570);
	assert.strictEqual(zone.offsetAt(zone.getZone(), 0), 34215000, 'the instants keep the seconds');
	zone.setZone('XXX+9:30:15');
	assert.strictEqual(new D(0).getTimezoneOffset(), 570);
	zone.setZone(undefined);
});

(async () => {
	for (const t of tests) {
		await t.fn();
		console.log('  ok - ' + t.name);
	}
	console.log(`\n${tests.length} tests passed`);
})().catch((e) => { console.error(e); process.exit(1); });
