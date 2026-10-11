// Seeded sessions for the line editor's resize handling, run on the real xterm.js: a user's prompt, earlier output
// before it, and a chain of 6 to 16 events (keys, pastes, a Tab, Enter and the output of the command, Ctrl+L, and the
// panel changing size: by width, by height, by both at once, by a drag in small steps, by a toggle, by a maximise and a
// restore). After EVERY step the checks are the ones that matter to a person:
//   - what the terminal showed before the prompt (earlier output, a command's result) is still there, whole and in order,
//     and so is the note under a line ('lost', 'lostNote': the editor wrote over it);
//   - the region is on the screen where the editor says, and is what it says ('misplaced');
//   - what the editor believes about the blank rows under its region is true ('blankOver': a floor, as `ghosts` is);
//   - a pasted line is on the screen once: a second one is a copy the editor left above the region ('copyVisible'; one
//     only in the scrollback is 'copyScrollback'). Copies are untidy, not lost: they are counted, and the caller bounds
//     the count.
// The generator is an independent one (a different random source and different shapes from the suite's own scenarios):
// the verifier of fix round 3 wrote it. With `many` a session here is the session of the same family and seed in his
// `rz2.js MANYRZ=1 EXTRA=1` (seed * 100000 + k), which is how the acceptance table of NOTES is made.
// @ts-check
'use strict';

const path = require('path');

const TERMINAL = path.join(__dirname, '..', '..', '..', 'shell', 'src', 'terminal');
const { LineEditor } = require(path.join(TERMINAL, 'line-editor.js'));
const { createInputParser } = require(path.join(TERMINAL, 'input-parser.js'));
const { cpWidth } = require(path.join(TERMINAL, 'width.js'));

const E = '\x1b';
const KEYS = { up: E + '[A', down: E + '[B', left: E + '[D', right: E + '[C', home: E + '[H', end: E + '[F', bs: '\x7f', ctrlK: '\x0b', ctrlU: '\x15', ctrlA: '\x01', ctrlE: '\x05', del: E + '[3~' };
const WORDS = ['git', 'status', 'ls', '-la', 'src/index.js', 'grep', '-rn', 'TODO', 'cat', 'README.md', 'find', '.', '-name', '"*.ts"', 'echo', 'hello', '&&', '|', 'wc', '-l', 'mkdir', 'build', 'cp', 'a.txt', 'b.txt', '中文', 'データ', 'ünïcödé', '日本語のファイル.txt'];
/** The families, as the verifier named them. */
const FAMILIES = ['user', 'width', 'rows', 'both', 'drag', 'toggle', 'mixed', 'maximize'];

/** @param {number} seed @returns {() => number} */
function rngOf(seed) {
	let a = (seed * 2654435761) >>> 0;
	return () => {
		a |= 0; a = (a + 0x6D2B79F5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/**
 * @typedef {{ send?: string, paste?: string, size?: [number, number], enter?: boolean, out?: number, wide?: boolean, tab?: boolean }} SessionStep
 * @typedef {{ cols: number, rows: number, earlier: string[], steps: SessionStep[], prompt: string }} SessionSpec
 */

/**
 * The session of a family and a seed.
 * @param {number} seed
 * @param {string} family one of FAMILIES
 * @param {boolean} [many] 6 to 16 events and no Enter (the verifier's acceptance run, `MANYRZ=1`); otherwise 3 to 10,
 *   with the output of a command between prompts as well
 * @returns {SessionSpec}
 */
function makeSession(seed, family, many) {
	const rnd = rngOf(seed);
	const pick = (/** @type {any[]} */ a) => a[Math.floor(rnd() * a.length)];
	const int = (/** @type {number} */ lo, /** @type {number} */ hi) => lo + Math.floor(rnd() * (hi - lo + 1));
	const real = family === 'user' || family === 'maximize';
	const cols = real ? pick([60, 80, 80, 100, 120]) : pick([20, 24, 30, 40, 50, 60, 80, 100, 132]);
	const rows = real ? pick([10, 12, 15, 18, 24, 30]) : pick([4, 5, 6, 8, 10, 12, 16, 24, 30]);
	let prompt = pick(['$ ', '$ ', '$ ', 'proj/src $ ', '中文 $ ', 'levelcode:~/work/project/src $ ']);
	const pw = [...prompt].reduce((a, ch) => a + ((/** @type {number} */ (ch.codePointAt(0))) > 0x2e80 ? 2 : 1), 0);
	if (pw > cols - 6) { prompt = '$ '; }
	const banner = real ? int(0, 6) : pick([0, 0, 1, 3, 8, rows + 4, rows * 3]);
	/** @type {string[]} */
	const earlier = [];
	const mkLine = (/** @type {string} */ tag, /** @type {number} */ i) => {
		const t = rnd();
		let s = tag + String(i).padStart(3, '0');
		if (t < 0.25) { s += ' ' + 'x'.repeat(int(Math.max(1, cols - 8), cols * 2 + 1)); }
		else if (t < 0.32) { s += ' ' + '中'.repeat(int(3, cols + 3)); }
		else if (t < 0.5) { s += ' ' + pick(WORDS) + ' ' + pick(WORDS); }
		return s;
	};
	for (let i = 0; i < banner; i++) { earlier.push(mkLine('ban', i)); }
	/** @type {SessionStep[]} */
	const steps = [];
	let c = cols;
	let r = rows;
	let n = 0;
	const text = (/** @type {number} */ k) => { const a = []; for (let i = 0; i < k; i++) { a.push(pick(WORDS)); } return a.join(' '); };
	const typed = () => { steps.push({ send: text(int(1, 6)) }); };
	const long = () => { steps.push({ send: pick(WORDS) + ' ' + 'y'.repeat(int(c, c * 3)) }); };
	const pasteLines = () => {
		n++;
		const k = pick([1, 2, 3, 4, 6, 9]);
		const ls = [];
		for (let i = 0; i < k; i++) {
			const tok = 'q' + n + 'n' + (i + 1) + ' ';
			ls.push(tok + (rnd() < 0.5 ? 'w'.repeat(int(0, Math.floor(c * 2.4))) : text(int(1, 4))));
		}
		steps.push({ paste: ls.join('\n') });
	};
	const nav = () => { steps.push({ send: KEYS[pick(['up', 'up', 'down', 'left', 'left', 'right', 'home', 'end', 'ctrlA', 'ctrlE', 'bs', 'del', 'ctrlK'])].repeat(pick([1, 1, 2, 3, 7])) }); };
	const resizeTo = (/** @type {number} */ nc, /** @type {number} */ nr) => {
		nc = Math.max(real ? 24 : 12, pw + 6, Math.min(180, nc));
		nr = Math.max(3, Math.min(50, nr));
		if (nc !== c || nr !== r) { steps.push({ size: [nc, nr] }); c = nc; r = nr; }
	};
	const rz = (/** @type {string} */ f) => {
		if (f === 'width') { resizeTo(pick([c - 30, c - 12, c - 5, c + 8, c + 25, c + 60, 20, 33, 72, 132]), r); }
		else if (f === 'rows') { resizeTo(c, pick([3, 4, 5, 6, r - 5, r - 2, r + 3, r + 9, 10, 20, 40])); }
		else if (f === 'both') { resizeTo(pick([c - 30, c - 7, c + 9, c + 40, 20, 50, 120]), pick([3, 4, 5, 7, r - 6, r + 4, 12, 24, 44])); }
		else if (f === 'drag') {
			const k = pick([3, 5, 8]);
			const dr = pick([-1, 1]);
			const both = rnd() < 0.5;
			for (let i = 0; i < k; i++) { resizeTo(c + dr * pick([1, 2, 4, 7]), both ? r + dr * pick([0, 1, 2]) : r); }
		} else if (f === 'toggle') {
			const old = r;
			const oc = c;
			resizeTo(c, pick([3, 4, 5, 6, 8]));
			if (rnd() < 0.6) { steps.push({ send: pick(['q', 'ab', 'z z']) }); }
			resizeTo(oc, old);
		} else if (f === 'maximize') {
			const oc = c;
			const orr = r;
			resizeTo(pick([160, 180, 140]), pick([40, 48, 36]));
			if (rnd() < 0.5) { typed(); }
			if (rnd() < 0.5) { nav(); }
			resizeTo(oc, orr);
		}
	};
	pick([typed, pasteLines, long, typed, pasteLines])();
	const m = many ? int(6, 16) : int(3, 10);
	for (let i = 0; i < m; i++) {
		const t = rnd();
		if (t < 0.10) { pasteLines(); }
		else if (t < 0.18) { typed(); }
		else if (t < 0.24) { long(); }
		else if (t < 0.30) { steps.push({ send: pick(['\t', '\t\t', 'ls s\t', 'ls s\t\t']), tab: true }); }
		else if (t < 0.34) { steps.push({ paste: 'a\u200bb ' + pick(WORDS) }); }
		else if (t < 0.37) { steps.push({ send: '\x0c' }); }
		else if (t < 0.44) { nav(); }
		else if (many && t < 0.95) { rz(family === 'mixed' ? pick(['width', 'rows', 'both', 'drag', 'toggle', 'maximize']) : family); }
		else if (t < 0.56) {
			// Enter, and the output of the command (it may be long, wide, wrapped): a new prompt follows it
			steps.push({ enter: true, out: int(0, family === 'user' ? 6 : 30), wide: rnd() < 0.3 });
			if (rnd() < 0.6) { typed(); }
		} else { rz(family === 'mixed' ? pick(['width', 'rows', 'both', 'drag', 'toggle', 'maximize']) : family === 'user' ? pick(['rows', 'both', 'maximize', 'drag', 'toggle', 'width']) : family); }
	}
	steps.push({ send: 'Z' });
	return { cols, rows, earlier, steps, prompt };
}

/**
 * Run a session on a real xterm.js and report what went wrong at which step.
 * @param {{ Terminal: any, Unicode11Addon: any }} xt
 * @param {SessionSpec} spec
 * @returns {Promise<{ fails: Array<{ cat: string, label: string, detail: string }>, cats: string[] }>}
 */
async function runSession(xt, spec) {
	let { cols, rows } = spec;
	const term = new xt.Terminal({ cols, rows, allowProposedApi: true, scrollback: 2000, scrollOnEraseInDisplay: true });
	term.loadAddon(new xt.Unicode11Addon());
	term.unicode.activeVersion = '11';
	const written = (/** @type {string} */ s) => new Promise((resolve) => term.write(s, resolve));
	let out = '';
	/** @type {string[]} */
	const submitted = [];
	const parser = createInputParser();
	const hist = ['older command one', 'older command two with some words in it'];
	const names = ['src/', 'srv.log', 'setup.sh', 'sample.txt', 'sort.py', 'a.txt', 'b.txt', 'data' + 'd'.repeat(30), '中文目录/'];
	const ed = new LineEditor({
		write: (x) => { out += x; }, prompt: () => spec.prompt, columns: cols, rows,
		history: () => hist,
		complete: async (line, cursor) => {
			const w = /** @type {RegExpExecArray} */ (/(\S*)$/.exec(line.slice(0, cursor)))[1];
			const cs = names.filter((nm) => nm.startsWith(w));
			return cs.length ? { start: cursor - w.length, candidates: cs.map((nm) => ({ text: nm, display: nm, dir: nm.endsWith('/') })) } : null;
		},
		isComplete: (src) => ({ complete: !/\\$/.test(src) }),
		onSubmit(src) { submitted.push(src); },
	});
	const flush = async () => { const x = out; out = ''; await written(x); };
	const earlier = spec.earlier.slice();
	await written(earlier.map((l) => l + '\r\n').join(''));
	ed.start();
	await flush();
	let regions = 1;
	let pasteN = 0;
	let legitN = 0;
	let notes = 0;
	/** @type {Array<{ cat: string, label: string, detail: string }>} */
	const fails = [];
	const grab = () => {
		const b = term.buffer.active;
		const rowsList = [];
		for (let y = 0; y < b.length; y++) { const l = b.getLine(y); rowsList.push({ t: l ? l.translateToString(true) : '', w: l ? l.isWrapped : false, y }); }
		return { rows: rowsList, base: b.baseY, cy: b.cursorY };
	};
	/** The rows of the region at the current width, written once (independent of the editor's own layout). */
	const expectRows = () => {
		const lines = ed.text().split('\n');
		/** @type {string[]} */
		const rowsOut = [];
		lines.forEach((ln, i) => {
			let row = '';
			let col = 0;
			const put = (/** @type {string} */ ch, /** @type {number} */ w) => { if (w > 0 && col + w > cols) { rowsOut.push(row); row = ''; col = 0; } row += ch; col += w; };
			for (const ch of (i === 0 ? spec.prompt : '> ')) { put(ch, cpWidth(/** @type {number} */ (ch.codePointAt(0)))); }
			for (const ch of ln) {
				if (ch === '\t') {
					if (col >= cols) { rowsOut.push(row); row = ''; col = 0; }
					const w = 8 - (col % 8);
					for (let k = 0; k < w; k++) { put(' ', 1); }
				} else { put(ch, cpWidth(/** @type {number} */ (ch.codePointAt(0)))); }
			}
			rowsOut.push(row);
		});
		return rowsOut.map((s) => s.replace(/\s+$/, ''));
	};
	const check = (/** @type {string} */ label) => {
		const g = grab();
		const all = g.rows;
		// 1. earlier output, in order, whole (logical lines)
		/** @type {Array<{ t: string, y: number }>} */
		const logical = [];
		for (const r of all) { if (r.w && logical.length) { logical[logical.length - 1].t += r.t; } else { logical.push({ t: r.t, y: r.y }); } }
		const texts = logical.map((l) => l.t.replace(/\s+$/, ''));
		let at = 0;
		for (const e of earlier) {
			const j = texts.indexOf(e.replace(/\s+$/, ''), at);
			if (j < 0) { return { cat: 'lost', label, detail: e.slice(0, 40) }; }
			at = j + 1;
		}
		if (notes > 0) {
			const have = texts.filter((t) => t === '[1 invisible character was not typed]').length;
			if (have < notes) { return { cat: 'lostNote', label, detail: 'note: ' + have + ' of ' + notes }; }
		}
		// 2. the region is where the editor says, and is what it says
		if (ed.active) {
			const exp = expectRows();
			const top = g.cy - ed.cursorRow;
			const h = ed.lastRow - ed.winTop + 1;
			if (top < 0) { return { cat: 'misplaced', label, detail: 'region top above the viewport: cy ' + g.cy + ' cursorRow ' + ed.cursorRow }; }
			for (let k = 0; k < h; k++) {
				const got = (all[g.base + top + k] ? all[g.base + top + k].t : '').replace(/\s+$/, '');
				const want = (exp[ed.winTop + k] || '').replace(/\s+$/, '');
				if (got !== want) { return { cat: 'misplaced', label, detail: 'row ' + k + ' got ' + JSON.stringify(got.slice(0, 50)) + ' want ' + JSON.stringify(want.slice(0, 50)) }; }
			}
			// 2b. what the editor believes is blank under its region is blank
			let blank = 0;
			for (let y = top + (ed.lastRow - ed.winTop) + 1; y < rows; y++) {
				const r = all[g.base + y];
				if (r && r.t === '') { blank++; } else { break; }
			}
			if (ed.blank > blank) { return { cat: 'blankOver', label, detail: 'the editor counts ' + ed.blank + ' blank rows under the region, there are ' + blank }; }
		}
		// 3. a pasted line (the tokens qNnK) is on the screen once: a second one is a copy
		const seen = new Map();
		for (const r of all) {
			if (r.w) { continue; }
			const m = /^(?:\$ |proj\/src \$ |中文 \$ |levelcode:~\/work\/project\/src \$ |> )(q\d+n\d+) /.exec(r.t) || /^(?:.{0,40}\$ )(q\d+n\d+) /.exec(r.t);
			if (m && Number(/** @type {RegExpExecArray} */ (/^q(\d+)n/.exec(m[1]))[1]) > legitN) {
				const v = seen.get(m[1]) || [];
				v.push(r.y);
				seen.set(m[1], v);
			}
		}
		for (const [tok, ys] of seen) {
			if (ys.length > 1) {
				const visible = ys.filter((/** @type {number} */ y) => y >= g.base).length;
				return { cat: visible > 1 ? 'copyVisible' : 'copyScrollback', label, detail: tok + ' at rows ' + ys.join(',') + ' base ' + g.base };
			}
		}
		return null;
	};
	for (let i = 0; i < spec.steps.length; i++) {
		const st = spec.steps[i];
		let label = 'step ' + i + ' ' + JSON.stringify(st).slice(0, 90) + ' (' + cols + 'x' + rows + ')';
		if (st.paste !== undefined) {
			const mm = /q(\d+)n/.exec(st.paste);
			if (mm) { pasteN = Math.max(pasteN, Number(mm[1])); }
			if (st.paste.includes('\u200b')) { notes++; }
		}
		if (st.tab || st.send === '\x0c' || (st.paste !== undefined && st.paste.includes('\u200b'))) { legitN = pasteN; }
		try {
			if (st.size) {
				const [nc, nr] = st.size;
				term.resize(nc, nr);
				await written('');
				cols = nc;
				rows = nr;
				ed.resize(nc, nr);
			} else if (st.enter) {
				const before = submitted.length;
				ed.input(parser.feed('\r'));
				await flush();
				if (submitted.length > before) {
					// the command's lines are earlier output from now on, as they stand
					/** @type {string[]} */
					const lines = [];
					for (let k = 0; k < (st.out || 0); k++) { lines.push('res' + regions + '_' + k + (st.wide ? ' ' + 'o'.repeat(cols + 7 + k) : '')); }
					await written(lines.map((l) => l + '\r\n').join(''));
					lines.forEach((l) => earlier.push(l));
					regions++;
					ed.start();
				}
			} else if (st.paste !== undefined) {
				ed.input(parser.feed(E + '[200~' + st.paste + E + '[201~'));
				ed.input(parser.flush());
			} else {
				ed.input(parser.feed(/** @type {string} */ (st.send)));
				ed.input(parser.flush());
				if (st.tab) { await new Promise((resolve) => setImmediate(resolve)); }
			}
			await flush();
		} catch (e) {
			fails.push({ cat: 'throw', label, detail: String(e && /** @type {any} */ (e).stack).split('\n').slice(0, 3).join(' | ') });
			break;
		}
		label += ' -> ' + cols + 'x' + rows;
		const r = check(label);
		if (r) { fails.push(r); }
	}
	term.dispose();
	return { fails, cats: Array.from(new Set(fails.map((f) => f.cat))) };
}

/**
 * Run sessions side by side (they share nothing: each has its own terminal and editor, and a terminal's writes are
 * timers, so most of the time of one is waiting), and give the results in the order of the sessions.
 * @param {{ Terminal: any, Unicode11Addon: any }} xt
 * @param {SessionSpec[]} specs
 * @param {number} [width] how many at a time
 */
async function runSessions(xt, specs, width) {
	/** @type {Array<Awaited<ReturnType<typeof runSession>>>} */
	const results = new Array(specs.length);
	let next = 0;
	const worker = async () => {
		for (let i = next++; i < specs.length; i = next++) { results[i] = await runSession(xt, specs[i]); }
	};
	await Promise.all(Array.from({ length: Math.min(width || 24, specs.length) }, worker));
	return results;
}

module.exports = { makeSession, runSession, runSessions, FAMILIES };
