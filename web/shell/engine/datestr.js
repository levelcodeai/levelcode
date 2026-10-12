// The strings `date -d` takes, as GNU's parse-datetime.y reads them (coreutils 8.32), for the forms a person types:
// relative ones (`yesterday`, `2 days ago`, `next friday`, `1 month`, `+1 week`), a date or a time alone or together
// (`2024-07-04`, `20240704 1200`, `07/04/2024`, `Jul 4 2024`, `12:00`, `3pm`, `2024-07-04T12:00:00+02:00`), and a date
// with a relative part (`2024-07-04 +1 week`). It follows the grammar, quirks included: a signed number right after a
// time is a zone (`12:00 +1 day` is 12:00 at +01:00, a day on), a date with no time is midnight, a day name does nothing
// to a string that has a date, a calendar date that is not there (`2023-02-29`) is "invalid date", and nothing here
// is "noon" or "midnight".
//
// The engine's own `date -d` takes `@N`, `now`, `yesterday`, `tomorrow` and a wall clock; this module reads what it
// reads and the rest, and hands back an instant, which the `date` wrapper gives it as `@SECONDS`. A string with a word
// or a shape this module does not know is "invalid date", as it is in GNU's grammar (the engine's own reader was
// lenient with junk: `last hr`, `ago first yr 1999-01-01`).
'use strict';
// @ts-check

const zone = require('./zone.js');

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
/** @type {Record<string, number>} the day names that are not a prefix of three letters and the full name */
const DAY_ALIASES = { tues: 2, wednes: 3, thur: 4, thurs: 4 };
/** @type {Record<string, number>} */
const ORDINALS = { first: 1, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10, eleventh: 11, twelfth: 12, next: 1, last: -1, this: 0 };
/** @type {Record<string, [string, number]>} unit words (a trailing `s` is taken off): kind and how many of it */
const UNITS = { year: ['year', 1], month: ['month', 1], fortnight: ['day', 14], week: ['day', 7], day: ['day', 1], hour: ['hour', 1], minute: ['minute', 1], min: ['minute', 1], second: ['second', 1], sec: ['second', 1] };
/**
 * The zones GNU names, in hours east of Greenwich; the second is true for the ones that already have daylight saving
 * time in them (`EDT`: a following `DST` is not allowed).
 * @type {Record<string, [number, boolean]>}
 */
const ZONES = {
	gmt: [0, false], ut: [0, false], utc: [0, false], z: [0, false], wet: [0, false], west: [1, true], bst: [1, true],
	art: [-3, false], brt: [-3, false], brst: [-2, true], nst: [-3.5, false], ndt: [-2.5, true], ast: [-4, false], adt: [-3, true],
	clt: [-4, false], clst: [-3, true], est: [-5, false], edt: [-4, true], cst: [-6, false], cdt: [-5, true], mst: [-7, false],
	mdt: [-6, true], pst: [-8, false], pdt: [-7, true], akst: [-9, false], akdt: [-8, true], hst: [-10, false], hast: [-10, false],
	hadt: [-9, true], sst: [-12, false], wat: [1, false], cet: [1, false], cest: [2, true], met: [1, false], mez: [1, false],
	mest: [2, true], mesz: [2, true], eet: [2, false], eest: [3, true], cat: [2, false], sast: [2, false], eat: [3, false],
	msk: [3, false], msd: [4, true], ist: [5.5, false], sgt: [8, false], kst: [9, false], jst: [9, false], gst: [10, false],
	nzst: [12, false], nzdt: [13, true],
};

/**
 * @typedef {{ t: 'num', value: number, digits: number, signed: boolean, sign: string, text: string }
 *   | { t: 'word', v: string }
 *   | { t: 'char', v: string }} Token
 */

/**
 * GNU's yylex: blanks are skipped; a sign followed (after blanks) by a digit makes a signed number, any other sign is
 * skipped; digits are a number (the number of digits is kept); letters are a word; anything else is itself.
 *
 * @param {string} s
 * @returns {Token[] | null} null when the string has a shape this lexer does not read
 */
function lex(s) {
	/** @type {Token[]} */
	const out = [];
	let i = 0;
	const n = s.length;
	while (i < n) {
		const c = s[i];
		if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\v' || c === '\f') { i++; continue; }
		if (c === '(') {
			// a comment, nested
			let depth = 1;
			i++;
			while (i < n && depth > 0) { if (s[i] === '(') { depth++; } else if (s[i] === ')') { depth--; } i++; }
			if (depth > 0) { return null; }
			continue;
		}
		if ((c >= '0' && c <= '9') || c === '+' || c === '-') {
			let sign = '';
			let j = i;
			if (c === '+' || c === '-') {
				sign = c;
				j++;
				while (j < n && (s[j] === ' ' || s[j] === '\t' || s[j] === '\n')) { j++; }
				if (!(j < n && s[j] >= '0' && s[j] <= '9')) { i++; continue; }      // a sign that is no number's is skipped
			}
			let k = j;
			while (k < n && s[k] >= '0' && s[k] <= '9') { k++; }
			const digits = s.slice(j, k);
			out.push({ t: 'num', value: Number(digits), digits: digits.length, signed: sign !== '', sign, text: digits });
			i = k;
			continue;
		}
		if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')) {
			let k = i;
			// letters, and the dots of `a.m.` and `Jan.`
			while (k < n && ((s[k] >= 'a' && s[k] <= 'z') || (s[k] >= 'A' && s[k] <= 'Z') || s[k] === '.')) { k++; }
			out.push({ t: 'word', v: s.slice(i, k).toLowerCase().replace(/\.+$/, '').replace(/\./g, '') });
			i = k;
			continue;
		}
		if (c === ':' || c === '/' || c === ',' || c === '.') { out.push({ t: 'char', v: c }); i++; continue; }
		return null;
	}
	return out;
}

/** The kind of a word: what parse-datetime.y's table says it is. */
function classify(w) {
	if (w === 'ago') { return { k: 'ago' }; }
	if (w === 'am' || w === 'pm') { return { k: 'meridian', pm: w === 'pm' }; }
	if (w === 'yesterday') { return { k: 'dayshift', n: -1 }; }
	if (w === 'tomorrow') { return { k: 'dayshift', n: 1 }; }
	if (w === 'today' || w === 'now') { return { k: 'dayshift', n: 0 }; }
	if (Object.prototype.hasOwnProperty.call(ORDINALS, w)) { return { k: 'ordinal', n: ORDINALS[w] }; }
	if (w === 'second') { return { k: 'unit', unit: 'second', mult: 1 }; }
	const month = MONTHS.findIndex((m) => m === w || (w.length === 3 && m.startsWith(w)) || (w === 'sept' && m === 'september'));
	if (month >= 0) { return { k: 'month', n: month + 1 }; }
	const day = DAYS.findIndex((d) => d === w || (w.length === 3 && d.startsWith(w)));
	if (day >= 0) { return { k: 'day', n: day }; }
	if (Object.prototype.hasOwnProperty.call(DAY_ALIASES, w)) { return { k: 'day', n: DAY_ALIASES[w] }; }
	const unitWord = Object.prototype.hasOwnProperty.call(UNITS, w) ? w : (w.endsWith('s') && Object.prototype.hasOwnProperty.call(UNITS, w.slice(0, -1)) ? w.slice(0, -1) : null);
	if (unitWord) { return { k: 'unit', unit: UNITS[unitWord][0], mult: UNITS[unitWord][1] }; }
	if (w === 'dst') { return { k: 'dst' }; }
	if (Object.prototype.hasOwnProperty.call(ZONES, w)) { return { k: 'zone', hours: ZONES[w][0], day: ZONES[w][1] }; }
	// a military letter: A to M (not J) east, N to Y west
	if (/^[a-ik-z]$/.test(w)) {
		const c = w.charCodeAt(0) - 96;
		const h = w <= 'i' ? c : w <= 'm' ? c - 1 : w === 'z' ? 0 : -(c - 13);
		return { k: 'zone', hours: h, day: false };
	}
	return { k: 'unknown' };
}

/** how many days a month has (`month` is 1..12) */
function daysIn(year, month) {
	if (month === 2) { return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28; }
	return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/**
 * @param {string} input the string given to `-d`
 * @param {number} nowMs the clock
 * @param {string} tz the zone key of the command (zone.getZone())
 * @returns {{ ms: number, nanos: number } | { invalid: true }} the instant (whole seconds; `nanos` is the fraction of the time given)
 */
function parse(input, nowMs, tz) {
	const tokens = lex(input);
	if (tokens === null) { return { invalid: true }; }
	const base = zone.partsAt(nowMs, tz);
	const pc = {
		year: base.year, yearDigits: 0, month: base.month + 1, day: base.day,
		hour: base.hour, minute: base.minute, second: base.second, meridian24: true, pm: false,
		times: 0, dates: 0, days: 0, zones: 0, rels: 0,
		/** east of Greenwich, in seconds */
		zoneSeconds: 0,
		/** the fraction of a second a time gave, in nanoseconds */
		nanos: 0,
		zoneNamed: false,
		zoneDay: false,
		dayNumber: 0, dayOrdinal: 0,
		rel: { year: 0, month: 0, day: 0, hour: 0, minute: 0, second: 0 },
	};
	const invalid = { invalid: true };
	/** the relative item that can still be made "ago": a function that negates it */
	let lastRel = null;
	const addRel = (unit, n) => {
		const key = unit;
		pc.rel[key] += n;
		pc.rels++;
		lastRel = () => { pc.rel[key] -= 2 * n; };
	};
	let p = 0;
	const peek = (k = 0) => tokens[p + k];
	const isNum = (t, signed) => !!t && t.t === 'num' && (signed === undefined || t.signed === signed);
	const isChar = (t, c) => !!t && t.t === 'char' && t.v === c;
	const setTime = (h, m, s) => { pc.hour = h; pc.minute = m; pc.second = s; pc.times++; pc.meridian24 = true; pc.pm = false; };
	/** a zone as a signed number that is the token at `p`: `+1`, `-0500`, `+02:00` (the minutes after a colon are taken too) */
	const zoneOffset = (t) => {
		const sign = t.sign === '-' ? -1 : 1;
		let seconds;
		if (t.digits <= 2) {
			seconds = t.value * 3600;
			if (isChar(peek(1), ':') && isNum(peek(2), false)) { seconds += peek(2).value * 60; p += 2; }
		} else { seconds = Math.floor(t.value / 100) * 3600 + (t.value % 100) * 60; }
		// more than a day east or west is not a zone: GNU counts one more zone for it, which is "invalid date" at the end
		// (`12:00 +42 days` is, `12:00 +1 day` is not)
		if (seconds > 24 * 3600) { pc.zones++; }
		return sign * seconds;
	};
	/**
	 * the item before this one was a bare number (a year after `Jul 4`, `20240704`, `1200`) or the name of a zone without
	 * daylight saving time in it (`UTC`, `EST`; not `EDT`): a signed
	 * count of a unit after it is read as a zone's offset first, and `ago` after it is a syntax error in GNU's parser
	 * (`Jul 4 2024 +1 day ago`, `18:00 UTC +1 day ago`; `+1 day` alone, and `Jul 4, 2024 +1 day ago`, are fine)
	 */
	let bare = false;
	while (p < tokens.length) {
		const was = bare;
		bare = false;
		const t = tokens[p];
		if (t.t === 'char') {
			// (a comma belongs to a day name, a `Jul 4, 2024` and a fraction of a second, each read where it is: anywhere else
			// it is a syntax error)
			return invalid;
		}
		if (t.t === 'num') {
			const next = peek(1);
			// time: H:M[:S[.f]] [am|pm] [zone offset]
			if (!t.signed && isChar(next, ':') && isNum(peek(2), false)) {
				const h = t.value;
				const m = /** @type {any} */ (peek(2)).value;
				let s = 0;
				p += 3;
				if (isChar(peek(), ':') && isNum(peek(1), false)) {
					s = /** @type {any} */ (peek(1)).value;
					p += 2;
					if ((isChar(peek(), '.') || isChar(peek(), ',')) && isNum(peek(1), false)) {
						// the digits as written (`.05` is 50 ms), past nine of them dropped
						pc.nanos = Number((/** @type {any} */ (peek(1)).text + '000000000').slice(0, 9));
						p += 2;
					}
				}
				setTime(h, m, s);
				const w = peek();
				const c = w && w.t === 'word' ? classify(w.v) : null;
				if (c && c.k === 'meridian') {
					pc.meridian24 = false;
					pc.pm = c.pm;
					p++;
					continue;
				}
				// only a time on the 24-hour clock takes a zone as a number
				const z = peek();
				if (isNum(z, true)) { pc.zones++; pc.zoneSeconds = zoneOffset(z); p++; }
				continue;
			}
			// H am|pm
			if (!t.signed && next && next.t === 'word' && /^[ap]m$/.test(next.v)) {
				setTime(t.value, 0, 0);
				pc.meridian24 = false;
				pc.pm = next.v === 'pm';
				p += 2;
				continue;
			}
			// the date 2024-07-04: a number and two negative ones
			if (!t.signed && isNum(next, true) && isNum(peek(2), true)) {
				const a = /** @type {any} */ (next);
				const b = /** @type {any} */ (peek(2));
				if (a.sign !== '-' || b.sign !== '-') { return invalid; }
				pc.year = t.value;
				pc.yearDigits = t.digits;
				pc.month = a.value;
				pc.day = b.value;
				pc.dates++;
				p += 3;
				continue;
			}
			// m/d, m/d/y and y/m/d
			if (!t.signed && isChar(next, '/') && isNum(peek(2), false)) {
				const b = /** @type {any} */ (peek(2));
				pc.dates++;
				if (isChar(peek(3), '/') && isNum(peek(4), false)) {
					const c3 = /** @type {any} */ (peek(4));
					if (t.digits >= 4) { pc.year = t.value; pc.yearDigits = t.digits; pc.month = b.value; pc.day = c3.value; } else { pc.month = t.value; pc.day = b.value; pc.year = c3.value; pc.yearDigits = c3.digits; }
					p += 5;
				} else {
					pc.month = t.value;
					pc.day = b.value;
					p += 3;
				}
				continue;
			}
			// D Mon [YYYY], D-Mon-YYYY (the dash is a sign of the year)
			if (!t.signed && next && next.t === 'word') {
				const c = classify(next.v);
				if (c && c.k === 'month') {
					pc.dates++;
					pc.day = t.value;
					pc.month = c.n;
					p += 2;
					const y = peek();
					if (isNum(y, true) && y.sign === '-') { pc.year = y.value; pc.yearDigits = y.digits; p++; } else if (isNum(y, false) && !(isChar(peek(1), ':'))) { pc.year = y.value; pc.yearDigits = y.digits; p++; }
					continue;
				}
				// N unit, N day-name, N ordinal-unit
				if (c && c.k === 'unit') { addRel(c.unit, t.value * c.mult * (t.sign === '-' ? -1 : 1)); p += 2; if (peek() && peek().t === 'word' && peek().v === 'ago') { /** @type {any} */ (lastRel)(); p++; } continue; }
				if (c && c.k === 'day' && !t.signed) { pc.days++; pc.dayOrdinal = t.value; pc.dayNumber = c.n; p += 2; continue; }
			}
			// a signed number: an offset of a zone when it follows a time (done above), a count of a unit otherwise
			if (t.signed && next && next.t === 'word') {
				const c = classify(next.v);
				if (c && c.k === 'unit') {
					addRel(c.unit, (t.sign === '-' ? -1 : 1) * t.value * c.mult);
					p += 2;
					if (peek() && peek().t === 'word' && peek().v === 'ago') {
						if (was) { return invalid; }
						/** @type {any} */ (lastRel)();
						p++;
					}
					continue;
				}
			}
			// a number of its own
			if (!t.signed) {
				bare = true;
				if (pc.dates && !pc.yearDigits && !pc.rels && (pc.times || t.digits > 2)) {
					pc.year = t.value;
					pc.yearDigits = t.digits;
				} else if (t.digits > 4) {
					pc.dates++;
					pc.day = t.value % 100;
					pc.month = Math.floor(t.value / 100) % 100;
					pc.year = Math.floor(t.value / 10000);
					pc.yearDigits = t.digits - 4;
				} else {
					setTime(t.digits <= 2 ? t.value : Math.floor(t.value / 100), t.digits <= 2 ? 0 : t.value % 100, 0);
				}
				p++;
				continue;
			}
			return invalid;
		}
		// a word
		// the `T` of 2024-07-04T12:00 (a date, then a `T`, then a time) is only the separator
		if (t.v === 't' && pc.dates && !pc.times && isNum(peek(1), false) && isChar(peek(2), ':')) { p++; continue; }
		const c = classify(t.v);
		if (c.k === 'unknown') { return invalid; }
		p++;
		if (c.k === 'dayshift') { pc.rels++; pc.rel.day += c.n; continue; }
		if (c.k === 'ordinal') {
			const w = peek();
			const d = w && w.t === 'word' ? classify(w.v) : null;
			if (d && d.k === 'unit') { addRel(d.unit, c.n * d.mult); p++; if (peek() && peek().t === 'word' && peek().v === 'ago') { /** @type {any} */ (lastRel)(); p++; } continue; }
			if (d && d.k === 'day') { pc.days++; pc.dayOrdinal = c.n; pc.dayNumber = d.n; p++; continue; }
			return invalid;
		}
		if (c.k === 'unit') { addRel(c.unit, c.mult); if (peek() && peek().t === 'word' && peek().v === 'ago') { /** @type {any} */ (lastRel)(); p++; } continue; }
		if (c.k === 'day') { pc.days++; pc.dayOrdinal = 0; pc.dayNumber = c.n; if (isChar(peek(), ',')) { p++; } continue; }
		if (c.k === 'month') {
			// Mon D [, YYYY]   (Mon YYYY is not a date)
			const d = peek();
			if (!isNum(d, false)) { return invalid; }
			pc.dates++;
			pc.month = c.n;
			pc.day = /** @type {any} */ (d).value;
			p++;
			if (isChar(peek(), ',') && isNum(peek(1), false)) { const y = /** @type {any} */ (peek(1)); pc.year = y.value; pc.yearDigits = y.digits; p += 2; }
			continue;
		}
		if (c.k === 'zone') {
			pc.zones++;
			pc.zoneSeconds = c.hours * 3600;
			pc.zoneDay = c.day;
			pc.zoneNamed = true;
			// (a name with no daylight saving in it is followed by `relunit_snumber` in the grammar; `EDT` is not)
			bare = !c.day;
			// a zone's name may be followed by a number that adds to it (`UTC +0100`), when no unit follows the number
			const z = peek();
			const after = peek(1);
			if (isNum(z, true) && !(after && after.t === 'word' && classify(after.v).k === 'unit')) { pc.zoneSeconds += zoneOffset(z); p++; bare = false; }
			continue;
		}
		// `DST` after a zone name that has no daylight saving in it: an hour more east
		if (c.k === 'dst') {
			if (!pc.zoneNamed || pc.zoneDay) { return invalid; }
			pc.zoneSeconds += 3600;
			pc.zoneNamed = false;
			continue;
		}
		return invalid;
	}
	// the grammar's own refusals
	if (pc.times > 1 || pc.dates > 1 || pc.days > 1 || pc.zones > 1) { return invalid; }
	// the wall clock, and which parts of it the string gave
	const year = pc.yearDigits === 2 ? pc.year + (pc.year < 69 ? 2000 : 1900) : pc.year;
	let hour = pc.hour;
	if (pc.times) {
		if (pc.meridian24) { if (hour > 23) { return invalid; } } else {
			if (hour < 1 || hour > 12) { return invalid; }
			hour = hour % 12 + (pc.pm ? 12 : 0);
		}
	}
	let minute = pc.minute;
	let second = pc.second;
	if (!(pc.times || (pc.rels && !pc.dates && !pc.days))) { hour = 0; minute = 0; second = 0; }
	if (pc.month < 1 || pc.month > 12 || pc.day < 1 || pc.day > daysIn(year, pc.month) || minute > 59 || second > 59) { return invalid; }
	// the fixed offset of a zone given: no daylight rule is in it
	const zoneKey = pc.zones ? null : tz;
	const toInstant = (wallMs) => (zoneKey === null ? wallMs - pc.zoneSeconds * 1000 : zone.instantOf(wallMs, zoneKey));
	// a day name when there is no date comes first: that day, today or after (an ordinal moves it by weeks); then the
	// relative years, months and days move the wall clock, and the instant is read once
	let day = pc.day;
	if (pc.days && !pc.dates) {
		const weekday = new Date(zone.wallUtc(year, pc.month - 1, pc.day, 0, 0, 0, 0)).getUTCDay();
		day += ((pc.dayNumber - weekday + 7) % 7) + 7 * (pc.dayOrdinal - (pc.dayOrdinal > 0 && weekday !== pc.dayNumber ? 1 : 0));
	}
	const start = toInstant(zone.wallUtc(year + pc.rel.year, pc.month - 1 + pc.rel.month, day + pc.rel.day, hour, minute, second, 0));
	return { ms: start + (pc.rel.hour * 3600 + pc.rel.minute * 60 + pc.rel.second) * 1000, nanos: pc.times ? pc.nanos : 0 };
}

module.exports = { parse, lex };
