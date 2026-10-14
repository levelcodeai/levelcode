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
//
// What a TZ value may be, as it is on a system that has the tzdata files and a file system that has case: an IANA name
// written in the case its file has (`Asia/Tokyo`, also with glibc's leading colon, `:America/New_York`; `asia/tokyo` is
// no zone), the path of such a file (`/usr/share/zoneinfo/Asia/Tokyo`, `/usr/share/zoneinfo/posix/...`: `zoneFileName`;
// any other path is no file here, and is read as the text it is), and the POSIX form with a fixed offset (`JST-9`, `UTC+3`, `<+0530>-5:30`: the offset is hours WEST of
// Greenwich, so `JST-9` is UTC+9). A daylight saving part after it (`EST5EDT,M3.2.0,M11.1.0`) is not applied (standard
// time all year; a name Intl knows, `EST5EDT`, is the zone and has its rules). Anything else is what glibc makes of it:
// the letters it starts with (three or more) are the name and the offset is 0 (`Nowhere` says `Nowhere`, `asia/tokyo`
// says `asia`, `ab` says nothing).
'use strict';
// @ts-check

const { NAMES, ABBREVIATIONS } = require('./zone-data.js');

/** every zone file the reference system has, by its exact name */
const KNOWN = new Set(NAMES);

const HostDate = Date;

/** @type {string} the zone local time means now: an IANA name, 'UTC' when the script has no (valid) TZ */
let current = 'UTC';

/** @type {Map<string, Intl.DateTimeFormat | null>} */
const formatters = new Map();

/** The zones made from a POSIX `NAME[+-]hh[:mm[:ss]]` string, by the key `current` holds for them. */
/** @type {Map<string, { name: string, offsetMs: number }>} */
const fixedZones = new Map();

/** What `UTC` is called in a zone that has it as its key: the files of GMT say GMT, the others UTC. */
let utcLabel = 'UTC';

/** The zone files that are UTC under another name, and the ones that are the same with the name GMT. */
const UTC_FILES = new Set(['UTC', 'UCT', 'Zulu', 'Universal', 'Etc/UTC', 'Etc/UCT', 'Etc/Zulu', 'Etc/Universal']);
const GMT_FILES = new Set(['GMT', 'GMT0', 'GMT+0', 'GMT-0', 'Greenwich', 'Etc/GMT', 'Etc/GMT0', 'Etc/GMT+0', 'Etc/GMT-0', 'Etc/Greenwich']);

/**
 * What a TZ that is no zone file is, as glibc reads it: a name (three or more letters, or `<...>`), then an optional
 * offset in hours WEST of Greenwich; anything after that (a daylight saving rule) is not applied.
 */
const POSIX_PREFIX = /^(?:([A-Za-z]{3,})|<([A-Za-z0-9+-]{3,})>)?(?:([+-]?)(\d{1,2})(?::([0-5]\d))?(?::([0-5]\d))?)?/;

/**
 * @param {string} s
 * @returns {{ key: string, name: string, offsetMs: number }}
 */
function posixFixed(s) {
	const m = /** @type {RegExpExecArray} */ (POSIX_PREFIX.exec(s));
	const name = m[1] || m[2] || '';
	// no name, no zone: what comes after it is not read (glibc says UTC with no name for `ab`, `5`, `us/eastern`)
	const west = name !== '' && m[4] !== undefined && Number(m[4]) <= 24 ? (m[3] === '-' ? -1 : 1) * (Number(m[4]) * 3600 + Number(m[5] || 0) * 60 + Number(m[6] || 0)) : 0;
	return { key: `posix:${name}:${-west}`, name, offsetMs: west === 0 ? 0 : -west * 1000 };
}

/** The directories of the reference's zone tree (`/usr/share/zoneinfo`, and its `posix` and `right` copies), as paths. */
const ZONE_ROOT = 'usr/share/zoneinfo';
/** @type {Set<string> | null} */
let zoneDirs = null;
function isZoneDir(path) {
	if (!zoneDirs) {
		zoneDirs = new Set(['', 'etc', 'usr', 'usr/share', ZONE_ROOT, ZONE_ROOT + '/posix', ZONE_ROOT + '/right']);
		for (const n of NAMES) {
			const at = n.split('/');
			for (let i = 1; i < at.length; i++) {
				const d = at.slice(0, i).join('/');
				zoneDirs.add(`${ZONE_ROOT}/${d}`);
				zoneDirs.add(`${ZONE_ROOT}/posix/${d}`);
				zoneDirs.add(`${ZONE_ROOT}/right/${d}`);
			}
		}
	}
	return zoneDirs.has(path);
}

/**
 * The name of a zone file as glibc finds it from a TZ that holds a slash: relative to /usr/share/zoneinfo, or an absolute
 * path into it (also the `posix/` copy of the tree, which has the same zones; `right/` is a tree with leap seconds, which
 * this runtime has not). `//` and `.` are nothing and `..` is the parent, as the file system has them, and every folder
 * on the way has to be there (`a/../Asia/Tokyo` is not a file). `/etc/localtime` is the machine's own zone, which here is
 * UTC. Any other absolute path is a file this runtime has not, and a name with no slash is its own file.
 *
 * @param {string} s a TZ value without its leading colon
 * @returns {string | null} the name, or null when the path is no zone file of this runtime
 */
function zoneFileName(s) {
	if (!s.includes('/')) { return s; }
	if (s.endsWith('/')) { return null; }
	/** @type {string[]} */
	const at = s[0] === '/' ? [] : ZONE_ROOT.split('/');
	const segs = s.split('/').filter((x) => x !== '' && x !== '.');
	for (let i = 0; i < segs.length; i++) {
		// a folder is walked through only when it is there: each one before the last name, and the one `..` leaves
		if (!isZoneDir(at.join('/'))) { return null; }
		if (segs[i] === '..') {
			at.pop();
			continue;
		}
		at.push(segs[i]);
	}
	const full = at.join('/');
	if (full === 'etc/localtime') { return 'UTC'; }
	if (!full.startsWith(ZONE_ROOT + '/')) { return null; }
	const name = full.slice(ZONE_ROOT.length + 1);
	if (name.startsWith('right/')) { return null; }
	return name.startsWith('posix/') ? name.slice(6) : name;
}

/**
 * What a TZ value stands for: the key the rest of this module uses, or null when it is not a zone this runtime knows.
 * The key is the IANA name, `'UTC'`, or (a POSIX fixed offset) an opaque string that only this module reads.
 * @param {unknown} name
 * @returns {string | null}
 */
function validZone(name) {
	if (typeof name !== 'string' || name === '') { return null; }
	if (fixedZones.has(name)) { return name; }
	const typed = name[0] === ':' ? name.slice(1) : name;   // glibc: ":NAME" is the zone file NAME
	if (typed === '') { return null; }
	/** a TZ that is no zone file: glibc reads it as POSIX text (a name and an offset), whatever is there */
	const posix = () => {
		const fx = posixFixed(typed);
		fixedZones.set(fx.key, { name: fx.name, offsetMs: fx.offsetMs });
		return fx.key;
	};
	// an offset alone (`+05:00`, `-5`) is no zone, though a newer ICU would take it for one: UTC with no name, as `5` is
	if (/^[+-]\d/.test(typed)) { return posix(); }
	const s = zoneFileName(typed) || typed;
	if (UTC_FILES.has(s) || GMT_FILES.has(s)) { return 'UTC'; }
	if (formatters.get(s)) { return s; }
	if (!formatters.has(s)) {
		try {
			const f = new Intl.DateTimeFormat('en-US', { timeZone: s, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
			// Intl takes a name in any case (`asia/tokyo`, `est`); a file system that has case does not. The name is a zone
			// when it is one of the files, or is the very name Intl itself calls the zone (a zone newer than the table)
			if (KNOWN.has(s) || f.resolvedOptions().timeZone === s) {
				formatters.set(s, f);
				return s;
			}
		} catch { /* not a zone Intl knows */ }
		formatters.set(s, null);
	}
	return posix();
}

/** the zone file a TZ names, as validZone reads it (the value itself when it is no path) */
function fileOf(/** @type {string} */ name) {
	const typed = name[0] === ':' ? name.slice(1) : name;
	return zoneFileName(typed) || typed;
}

/** @param {unknown} name the value of TZ (anything: a missing or bad one is UTC) */
function setZone(name) {
	current = validZone(name) || 'UTC';
	utcLabel = current === 'UTC' && typeof name === 'string' && GMT_FILES.has(fileOf(name)) ? 'GMT' : 'UTC';
}
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
	const fx = fixedZones.get(zone);
	if (fx) { return fx.offsetMs; }
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

/**
 * What GNU prints for `%Z`: tzdata's letters (zone-data.js, generated from the reference container's tzdata: `EST`,
 * `CEST`, `IST`) by the offset the zone has at that instant, so that no rule of daylight saving is needed; a zone, or an
 * offset of it, that tzdata gives digits (`+04`, `-03`) is written with them below.
 */
/** @type {Map<string, Array<[number, string] | [number, string, number]>> | null} */
let abbreviationIndex = null;

/**
 * The short name of a zone at an instant, as GNU's `%Z` prints it: `JST`, `EDT`, `CEST`, `UTC`; the letters tzdata uses
 * for the zones above, else its digits (`+04`, `-03`, `+0530`). Never Intl's own `GMT+9`.
 *
 * @param {number} ms
 * @param {string} [zoneName] the key of a zone (the current one when omitted)
 * @returns {string}
 */
function abbreviation(ms, zoneName) {
	const z = zoneName === undefined || zoneName === '' ? current : (validZone(zoneName) || 'UTC');
	if (z === 'UTC') { return z === current ? utcLabel : 'UTC'; }
	const fx = fixedZones.get(z);
	if (fx) { return fx.name; }
	if (!abbreviationIndex) {
		abbreviationIndex = new Map();
		for (const [names, ...rows] of ABBREVIATIONS) { for (const i of names) { abbreviationIndex.set(NAMES[i], rows); } }
	}
	const minutes = Math.round(offsetAt(z, ms) / 60000);
	// the rows of this offset are in order of time: the last one that has begun (a zone that kept its offset and changed
	// what it calls it has two or more), whose letters '' are tzdata's digits
	let hit = null;
	for (const r of abbreviationIndex.get(z) || []) { if (r[0] === minutes && (r[2] === undefined || r[2] * 1000 <= ms)) { hit = r; } }
	if (hit && hit[1] !== '') { return hit[1]; }
	const a = Math.abs(minutes);
	const two = (n) => String(n).padStart(2, '0');
	return (minutes < 0 ? '-' : '+') + two(Math.floor(a / 60)) + (a % 60 ? two(a % 60) : '');
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
	getTimezoneOffset() { return -Math.trunc(fieldsOf(this).offsetMs / 60000) || 0; }          // whole minutes west of UTC (strftime's %z has no seconds), and 0, not -0

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

module.exports = { validZone, setZone, getZone, offsetAt, partsAt, instantOf, wallUtc, parseWall, abbreviation, LcDate };
