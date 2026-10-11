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
// What a TZ value may be: an IANA name (`Asia/Tokyo`, also with glibc's leading colon, `:America/New_York`), UTC and its
// spellings, and the POSIX form with a fixed offset and no daylight saving rule (`JST-9`, `UTC+3`, `<+0530>-5:30`: the
// offset is hours WEST of Greenwich, so `JST-9` is UTC+9). The POSIX form WITH a daylight saving part
// (`EST5EDT,M3.2.0,M11.1.0`) is not read; a name Intl knows (`EST5EDT`) is. Anything else is UTC.
'use strict';
// @ts-check

const HostDate = Date;

/** @type {string} the zone local time means now: an IANA name, 'UTC' when the script has no (valid) TZ */
let current = 'UTC';

/** @type {Map<string, Intl.DateTimeFormat | null>} */
const formatters = new Map();

/** The zones made from a POSIX `NAME[+-]hh[:mm[:ss]]` string, by the key `current` holds for them. */
/** @type {Map<string, { name: string, offsetMs: number }>} */
const fixedZones = new Map();

/** What `UTC` is called in a zone that has it as its key: GNU prints the name that was asked for (`TZ=GMT` is GMT). */
let utcLabel = 'UTC';

/** UTC and what people write for it. */
const UTC_NAMES = /^(?:UTC|GMT|UT|Z|Etc\/UTC|Etc\/GMT|UCT|Zulu)$/i;

/** A POSIX TZ with a fixed offset: a name of three or more letters (or `<...>`), then hours west of Greenwich. */
const POSIX_FIXED = /^(?:([A-Za-z]{3,})|<([A-Za-z0-9+-]{3,})>)([+-]?)(\d{1,2})(?::([0-5]\d))?(?::([0-5]\d))?$/;

/**
 * @param {string} s
 * @returns {{ key: string, name: string, offsetMs: number } | null}
 */
function posixFixed(s) {
	const m = POSIX_FIXED.exec(s);
	if (!m || Number(m[4]) > 24) { return null; }
	const west = (m[3] === '-' ? -1 : 1) * (Number(m[4]) * 3600 + Number(m[5] || 0) * 60 + Number(m[6] || 0));
	const name = m[1] || m[2];
	return { key: `posix:${name}:${-west}`, name, offsetMs: -west * 1000 };
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
	const s = name[0] === ':' ? name.slice(1) : name;       // glibc: ":NAME" is the zone file NAME
	if (s === '' || /^[+-]\d/.test(s)) { return null; }      // an offset alone is no TZ (and a newer ICU would take it)
	if (UTC_NAMES.test(s)) { return 'UTC'; }
	if (formatters.get(s)) { return s; }
	if (!formatters.has(s)) {
		try {
			formatters.set(s, new Intl.DateTimeFormat('en-US', { timeZone: s, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }));
			return s;
		} catch {
			formatters.set(s, null);
		}
	}
	const fx = posixFixed(s);
	if (!fx) { return null; }
	fixedZones.set(fx.key, { name: fx.name, offsetMs: fx.offsetMs });
	return fx.key;
}

/** @param {unknown} name the value of TZ (anything: a missing or bad one is UTC) */
function setZone(name) {
	current = validZone(name) || 'UTC';
	utcLabel = current === 'UTC' && typeof name === 'string' && /^:?(?:Etc\/)?GMT$/i.test(name) ? 'GMT' : 'UTC';
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
 * What GNU prints for `%Z`, for the zones a person is likely to use: [names, [offset in minutes, abbreviation]...]. tzdata
 * has letters for these and digits (`+04`, `-03`) for most of the rest, which is what a zone that is not here prints.
 * The abbreviation is chosen by the offset the zone has at that instant, so no rule of daylight saving is needed.
 * @type {Array<[string[], ...Array<[number, string]>]>}
 */
const ABBREVIATIONS = [
	[['America/New_York', 'America/Toronto', 'America/Detroit', 'America/Nassau', 'US/Eastern', 'EST5EDT', 'America/Montreal'], [-300, 'EST'], [-240, 'EDT']],
	[['America/Panama', 'America/Jamaica', 'America/Cancun', 'EST'], [-300, 'EST']],
	[['America/Chicago', 'America/Winnipeg', 'America/Menominee', 'US/Central', 'CST6CDT'], [-360, 'CST'], [-300, 'CDT']],
	[['America/Mexico_City', 'America/Monterrey', 'America/Regina', 'America/Guatemala', 'America/Costa_Rica', 'America/El_Salvador', 'America/Belize'], [-360, 'CST'], [-300, 'CDT']],
	[['America/Denver', 'America/Edmonton', 'America/Boise', 'US/Mountain', 'MST7MDT'], [-420, 'MST'], [-360, 'MDT']],
	[['America/Phoenix', 'US/Arizona', 'MST'], [-420, 'MST']],
	[['America/Los_Angeles', 'America/Vancouver', 'America/Tijuana', 'US/Pacific', 'PST8PDT'], [-480, 'PST'], [-420, 'PDT']],
	[['America/Anchorage', 'America/Juneau', 'America/Sitka', 'America/Nome', 'America/Yakutat'], [-540, 'AKST'], [-480, 'AKDT']],
	[['Pacific/Honolulu', 'US/Hawaii', 'HST'], [-600, 'HST']],
	[['America/Halifax', 'America/Glace_Bay', 'America/Moncton', 'Atlantic/Bermuda', 'America/Puerto_Rico'], [-240, 'AST'], [-180, 'ADT']],
	[['America/St_Johns'], [-210, 'NST'], [-150, 'NDT']],
	[['Europe/London', 'Europe/Belfast', 'Europe/Jersey', 'Europe/Guernsey', 'Europe/Isle_of_Man', 'GB'], [0, 'GMT'], [60, 'BST']],
	[['Europe/Dublin', 'Eire'], [0, 'GMT'], [60, 'IST']],
	[['Europe/Lisbon', 'Atlantic/Canary', 'Atlantic/Faroe', 'Atlantic/Madeira', 'Portugal', 'WET'], [0, 'WET'], [60, 'WEST']],
	[['Atlantic/Reykjavik', 'Africa/Abidjan', 'Africa/Accra', 'Africa/Dakar', 'Africa/Monrovia', 'Etc/GMT', 'GMT', 'Greenwich'], [0, 'GMT']],
	[['Europe/Paris', 'Europe/Berlin', 'Europe/Madrid', 'Europe/Rome', 'Europe/Amsterdam', 'Europe/Brussels', 'Europe/Vienna', 'Europe/Zurich', 'Europe/Stockholm', 'Europe/Oslo', 'Europe/Copenhagen', 'Europe/Prague', 'Europe/Warsaw', 'Europe/Budapest', 'Europe/Belgrade', 'Europe/Zagreb', 'Europe/Ljubljana', 'Europe/Bratislava', 'Europe/Luxembourg', 'Europe/Monaco', 'Europe/Malta', 'Europe/Vaduz', 'Europe/Andorra', 'Europe/Sarajevo', 'Europe/Skopje', 'Europe/Tirane', 'Europe/Podgorica', 'Europe/Gibraltar', 'Africa/Ceuta', 'Arctic/Longyearbyen', 'CET', 'MET'], [60, 'CET'], [120, 'CEST']],
	[['Africa/Tunis', 'Africa/Algiers'], [60, 'CET']],
	[['Europe/Athens', 'Europe/Helsinki', 'Europe/Kiev', 'Europe/Kyiv', 'Europe/Bucharest', 'Europe/Sofia', 'Europe/Riga', 'Europe/Vilnius', 'Europe/Tallinn', 'Europe/Chisinau', 'Europe/Mariehamn', 'Asia/Nicosia', 'Europe/Nicosia', 'Asia/Beirut', 'Africa/Cairo', 'Egypt', 'EET'], [120, 'EET'], [180, 'EEST']],
	[['Africa/Tripoli', 'Europe/Kaliningrad'], [120, 'EET']],
	[['Europe/Moscow', 'Europe/Simferopol', 'Europe/Kirov', 'Europe/Volgograd', 'W-SU'], [180, 'MSK']],
	[['Asia/Tokyo', 'Japan'], [540, 'JST']],
	[['Asia/Seoul', 'Asia/Pyongyang', 'ROK'], [540, 'KST']],
	[['Asia/Shanghai', 'Asia/Chongqing', 'Asia/Harbin', 'Asia/Macau', 'Asia/Taipei', 'PRC', 'ROC'], [480, 'CST']],
	[['Asia/Hong_Kong', 'Hongkong'], [480, 'HKT']],
	[['Asia/Manila'], [480, 'PST']],
	[['Asia/Kolkata', 'Asia/Calcutta'], [330, 'IST']],
	[['Asia/Karachi'], [300, 'PKT']],
	[['Asia/Jakarta', 'Asia/Pontianak'], [420, 'WIB']],
	[['Asia/Makassar'], [480, 'WITA']],
	[['Asia/Jayapura'], [540, 'WIT']],
	[['Asia/Jerusalem', 'Asia/Tel_Aviv', 'Israel'], [120, 'IST'], [180, 'IDT']],
	[['Australia/Sydney', 'Australia/Melbourne', 'Australia/Canberra', 'Australia/Hobart', 'Australia/ACT', 'Australia/NSW', 'Australia/Victoria', 'Australia/Tasmania'], [600, 'AEST'], [660, 'AEDT']],
	[['Australia/Brisbane', 'Australia/Queensland', 'Australia/Lindeman'], [600, 'AEST']],
	[['Australia/Adelaide', 'Australia/Broken_Hill', 'Australia/South'], [570, 'ACST'], [630, 'ACDT']],
	[['Australia/Darwin', 'Australia/North'], [570, 'ACST']],
	[['Australia/Perth', 'Australia/West'], [480, 'AWST']],
	[['Pacific/Auckland', 'NZ', 'Antarctica/McMurdo'], [720, 'NZST'], [780, 'NZDT']],
	[['Pacific/Guam', 'Pacific/Saipan'], [600, 'ChST']],
	[['Africa/Johannesburg', 'Africa/Maseru', 'Africa/Mbabane'], [120, 'SAST']],
	[['Africa/Lagos', 'Africa/Kinshasa', 'Africa/Luanda', 'Africa/Douala', 'Africa/Libreville', 'Africa/Niamey', 'Africa/Ndjamena'], [60, 'WAT']],
	[['Africa/Nairobi', 'Africa/Addis_Ababa', 'Africa/Dar_es_Salaam', 'Africa/Kampala', 'Africa/Mogadishu', 'Africa/Djibouti', 'Africa/Asmara'], [180, 'EAT']],
	[['Africa/Maputo', 'Africa/Harare', 'Africa/Lusaka', 'Africa/Kigali', 'Africa/Lubumbashi', 'Africa/Gaborone', 'Africa/Windhoek', 'Africa/Khartoum', 'Africa/Blantyre', 'Africa/Bujumbura'], [120, 'CAT']],
];

/** @type {Map<string, Array<[number, string]>> | null} */
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
		for (const [names, ...rows] of ABBREVIATIONS) { for (const n of names) { abbreviationIndex.set(n, rows); } }
	}
	const minutes = Math.round(offsetAt(z, ms) / 60000);
	const hit = (abbreviationIndex.get(z) || []).find((r) => r[0] === minutes);
	if (hit) { return hit[1]; }
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

module.exports = { validZone, setZone, getZone, offsetAt, partsAt, instantOf, wallUtc, parseWall, abbreviation, LcDate };
