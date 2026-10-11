// Local time that does not depend on the visitor.
//
// just-bash reads and prints "local" time (`new Date('2020-02-29 12:00')`, `getHours()`, `touch -d`, `ls -l`, `stat`,
// `find -newer`), and in a browser worker local time is the visitor's zone: the same script printed 12:00 for one
// person and 07:00 for another, and `date -u -d '2020-02-29 12:00'` was not 12:00. In a shell with no TZ the answer is
// UTC; with TZ=America/New_York in the script's environment it is that zone, as GNU has it.
//
// The patched just-bash shadows `Date` (patch LC-16) with `LcDate`, whose "local" fields are the CURRENT zone's, and
// calls `setZone` with the command's TZ before each command it runs. compat.js and overlay-fs.js use the same module
// for `touch -t`, `stat -c %y` and the modification times they hand out.
//
// Nothing here reads the host's zone, with one exception that cannot be avoided: a string with no zone that V8's own
// parser cannot read with " UTC" appended (none of the forms people type) falls back to the host's reading.
'use strict';
// @ts-check

const HostDate = Date;

/** @type {string} the zone local time means now: an IANA name, 'UTC' when the script has no (valid) TZ */
let current = 'UTC';

/** @type {Map<string, Intl.DateTimeFormat | null>} */
const formatters = new Map();

/**
 * The IANA name `name` stands for, or null when it is not a zone this runtime knows.
 * @param {unknown} name
 * @returns {string | null}
 */
function validZone(name) {
	if (typeof name !== 'string' || name === '') { return null; }
	if (/^(?:UTC|GMT|UT|Z|Etc\/UTC|Etc\/GMT|UCT|Zulu)$/i.test(name)) { return 'UTC'; }
	if (formatters.has(name)) { return formatters.get(name) ? name : null; }
	try {
		const f = new Intl.DateTimeFormat('en-US', { timeZone: name, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
		formatters.set(name, f);
		return name;
	} catch {
		formatters.set(name, null);
		return null;
	}
}

/** @param {unknown} name the value of TZ (anything: a missing or bad one is UTC) */
function setZone(name) { current = validZone(name) || 'UTC'; }
function getZone() { return current; }

/** Wall-clock fields as a UTC instant: `new Date(Date.UTC(...))` without the 0..99 -> 1900s rule. */
function wallUtc(y, mo, d, h, mi, s, ms) {
	const t = new HostDate(0);
	t.setUTCFullYear(y, mo, d);
	t.setUTCHours(h, mi, s, ms);
	return t.getTime();
}

/**
 * How far `zone` is ahead of UTC at instant `ms`, in milliseconds (the offset is whole minutes; a historical one may
 * have seconds, which this keeps).
 * @param {string} zone
 * @param {number} ms
 * @returns {number}
 */
function offsetAt(zone, ms) {
	if (zone === 'UTC' || !Number.isFinite(ms)) { return 0; }
	const f = validZone(zone) ? formatters.get(zone) : null;
	if (!f) { return 0; }
	/** @type {Record<string, number>} */
	const v = {};
	for (const p of f.formatToParts(new HostDate(ms))) { if (p.type !== 'literal') { v[p.type] = Number(p.value); } }
	if (!(v.year > 0)) { return 0; }
	return wallUtc(v.year, v.month - 1, v.day, v.hour % 24, v.minute, v.second, 0) - Math.floor(ms / 1000) * 1000;
}

/**
 * The wall-clock fields of an instant in a zone.
 * @param {number} ms
 * @param {string} [zone]
 * @returns {{ year: number, month: number, day: number, hour: number, minute: number, second: number, ms: number, weekday: number, offsetMs: number }}
 *   `month` is 0..11 and `weekday` 0..6 (Sunday), as Date has them
 */
function partsAt(ms, zone = current) {
	const off = offsetAt(zone, ms);
	const w = new HostDate(ms + off);
	return {
		year: w.getUTCFullYear(), month: w.getUTCMonth(), day: w.getUTCDate(),
		hour: w.getUTCHours(), minute: w.getUTCMinutes(), second: w.getUTCSeconds(), ms: w.getUTCMilliseconds(),
		weekday: w.getUTCDay(), offsetMs: off,
	};
}

/**
 * The instant at which the wall clock of `zone` showed `wallMs` read as UTC (the usual trick: 12:00 in Tokyo is
 * `wallMs - 9 h`). A time that does not exist (the hour a clock skips) is read with the offset from before the skip,
 * so it lands after it; one that exists twice (the hour a clock repeats) is the first of the two.
 *
 * @param {number} wallMs
 * @param {string} [zone]
 * @returns {number}
 */
function instantOf(wallMs, zone = current) {
	if (zone === 'UTC' || !Number.isFinite(wallMs)) { return wallMs; }
	const DAY = 86400000;
	const before = offsetAt(zone, wallMs - DAY);
	const after = offsetAt(zone, wallMs + DAY);
	if (before === after) { return wallMs - before; }          // no change of offset around it
	const first = wallMs - before;
	const second = wallMs - after;
	const firstOk = offsetAt(zone, first) === before;
	const secondOk = offsetAt(zone, second) === after;
	if (firstOk && secondOk) { return Math.min(first, second); }   // repeated: the first
	if (secondOk) { return second; }
	return first;                                                  // the one that is valid, or, in a gap, the pre-gap reading
}

/** A time zone, said in a string: Z, UTC, GMT, EST ..., +0100, +01:00, GMT+0100, "(CET)". */
const ZONED = /(?:\dz\s*$|\b(?:UTC|GMT|UT|Z|[ECMP][SD]T)\b|\d:\d{2}(?::\d{2}(?:\.\d+)?)?\s*[+-]\d{2}(?::?\d{2})?\s*(?:\([^)]*\))?\s*$|\([A-Za-z ]+\)\s*$)/i;

/**
 * `Date.parse` for a string that has no zone of its own: its wall clock is read in the current zone, not the host's.
 * @param {string} str
 * @returns {number}
 */
function parseWall(str) {
	const s = String(str).trim();
	const t = HostDate.parse(s);
	if (Number.isNaN(t) || ZONED.test(s)) { return t; }
	const wall = HostDate.parse(s.replace(/(\d)T(\d)/, '$1 $2') + ' UTC');
	return Number.isNaN(wall) ? t : instantOf(wall, current);
}

/** Fields of `this` in the current zone, for the getters. */
function fieldsOf(d) { return partsAt(HostDate.prototype.getTime.call(d)); }

/**
 * Date whose local time is the current zone's. It is what a `Date` means inside the patched just-bash.
 */
class LcDate extends HostDate {
	/** @param {...any} a */
	constructor(...a) {
		let t;
		if (a.length === 0) {
			t = HostDate.now();
		} else if (a.length === 1) {
			const v = a[0];
			t = typeof v === 'string' ? parseWall(v) : (v instanceof HostDate ? v.getTime() : Number(v));
		} else {
			const n = a.map(Number);
			const y = n[0] >= 0 && n[0] <= 99 ? 1900 + n[0] : n[0];
			t = instantOf(wallUtc(y, n[1], n.length > 2 ? n[2] : 1, n[3] || 0, n[4] || 0, n[5] || 0, n[6] || 0), current);
		}
		super(t);
	}

	static parse(s) { return parseWall(s); }
	static [Symbol.hasInstance](x) { return x instanceof HostDate; }

	getFullYear() { return fieldsOf(this).year; }
	getMonth() { return fieldsOf(this).month; }
	getDate() { return fieldsOf(this).day; }
	getDay() { return fieldsOf(this).weekday; }
	getHours() { return fieldsOf(this).hour; }
	getMinutes() { return fieldsOf(this).minute; }
	getSeconds() { return fieldsOf(this).second; }
	getMilliseconds() { return fieldsOf(this).ms; }
	getTimezoneOffset() { return (-fieldsOf(this).offsetMs / 60000) || 0; }          // minutes west of UTC, and 0, not -0

	/**
	 * Replace some wall-clock fields, in the current zone.
	 * @param {Partial<ReturnType<typeof partsAt>>} over
	 */
	_with(over) {
		const p = Object.assign(fieldsOf(this), over);
		return this.setTime(instantOf(wallUtc(p.year, p.month, p.day, p.hour, p.minute, p.second, p.ms), current));
	}
	setFullYear(y, m, d) { return this._with({ year: y, ...(m === undefined ? {} : { month: m }), ...(d === undefined ? {} : { day: d }) }); }
	setMonth(m, d) { return this._with({ month: m, ...(d === undefined ? {} : { day: d }) }); }
	setDate(d) { return this._with({ day: d }); }
	setHours(h, m, s, ms) { return this._with({ hour: h, ...(m === undefined ? {} : { minute: m }), ...(s === undefined ? {} : { second: s }), ...(ms === undefined ? {} : { ms }) }); }
	setMinutes(m, s, ms) { return this._with({ minute: m, ...(s === undefined ? {} : { second: s }), ...(ms === undefined ? {} : { ms }) }); }
	setSeconds(s, ms) { return this._with({ second: s, ...(ms === undefined ? {} : { ms }) }); }
	setMilliseconds(ms) { return this._with({ ms }); }
}

module.exports = { validZone, setZone, getZone, offsetAt, partsAt, instantOf, wallUtc, parseWall, LcDate };
