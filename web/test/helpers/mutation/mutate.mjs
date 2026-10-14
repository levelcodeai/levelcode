// Mutation runner: node web/test/helpers/mutation/mutate.mjs [mutations.mjs] [name-regex]  (prints "N mutations, N caught, 0 not"; exit 1 if one survives)
//
// For each entry of mutations.mjs: put ONE defect back (a textual edit of web/shell/src or web/shell/engine in a copy of
// the tree), run the suites that should notice, and say RED (a suite failed: the behaviour is pinned) or GREEN (it
// survived: an unpinned property). The repo is never touched: the copy is in the temp dir and removed at the end.
// An entry may add environment for its suites (`env`): LEVELCODE_REQUIRE_WORKER is cleared otherwise, so that a machine
// that cannot start a thread gives a skip and not a hundred false RED.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..', '..');
const args = process.argv.slice(2);
const given = args.find((a) => /\.mjs$/.test(a));
const file = given ? path.resolve(process.cwd(), given) : path.join(HERE, 'mutations.mjs');
const filter = args.find((a) => a !== given);
const only = filter ? new RegExp(filter) : null;
const { mutations, suites: DEFAULT_SUITES } = await import(pathToFileURL(file).href);

const SUITE_TIMEOUT_MS = 90000;
const present = (s) => fs.existsSync(path.join(ROOT, 'web/test/unit', s + '.test.js'));

function copyDir(from, to, filter) {
	fs.mkdirSync(to, { recursive: true });
	for (const e of fs.readdirSync(from, { withFileTypes: true })) {
		const a = path.join(from, e.name), b = path.join(to, e.name);
		if (filter && !filter(a, e)) { continue; }
		if (e.isDirectory()) { copyDir(a, b, filter); } else { fs.copyFileSync(a, b); }
	}
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-mutate-'));
const results = [];
try {
	// One copy of what the suites read: the shell's sources and engine, the helpers, the shell suites.
	copyDir(path.join(ROOT, 'web/shell'), path.join(dir, 'web/shell'), (a, e) => !/node_modules/.test(a));
	copyDir(path.join(ROOT, 'web/test/helpers'), path.join(dir, 'web/test/helpers'), (a, e) => !/mutation$/.test(a));
	copyDir(path.join(ROOT, 'web/test/unit'), path.join(dir, 'web/test/unit'), (a, e) => e.isDirectory() || /shell-[\w-]*\.(test\.)?js$/.test(a) || /\/helpers\//.test(a));
	if (fs.existsSync(path.join(ROOT, 'web/test/fixtures/shell'))) { copyDir(path.join(ROOT, 'web/test/fixtures/shell'), path.join(dir, 'web/test/fixtures/shell')); }   // the engine suites read these

	for (const m of mutations) {
		if (only && !only.test(m.name)) { continue; }
		const touched = [];
		let bad = null;
		for (const ed of m.edits) {
			const target = path.join(dir, ed.file);
			const text = fs.readFileSync(target, 'utf8');
			const count = text.split(ed.find).length - 1;
			if (count !== (ed.count || 1)) { bad = 'BAD-ANCHOR (found ' + count + ' of ' + (ed.count || 1) + ': ' + ed.find.slice(0, 70).replace(/\n/g, '\\n') + ')'; break; }
			fs.writeFileSync(target, text.split(ed.find).join(ed.replace));
			touched.push(ed.file);
		}
		let red = null;
		if (!bad) {
			const list = (m.tests || DEFAULT_SUITES).filter(present);
			for (const s of list) {
				const r = spawnSync(process.execPath, [path.join(dir, 'web/test/unit', s + '.test.js')], { encoding: 'utf8', timeout: SUITE_TIMEOUT_MS, env: Object.assign({}, process.env, { LEVELCODE_REQUIRE_WORKER: '' }, m.env || {}) });
				if (!(r.status === 0 && /\d+ tests passed/.test(r.stdout))) { red = s + (r.signal ? ' (timeout)' : ''); break; }
			}
		}
		for (const f of touched) { fs.copyFileSync(path.join(ROOT, f), path.join(dir, f)); }   // the next one starts clean
		results.push([m.name, bad ? bad : red ? 'RED   ' + red : 'GREEN (survived)']);
		console.log((bad ? 'BAD   ' : red ? 'RED   ' : 'GREEN ') + m.name + (red ? '  <- ' + red : bad ? '  ' + bad : ''));
	}
} finally {
	fs.rmSync(dir, { recursive: true, force: true });
}
const survived = results.filter((r) => !r[1].startsWith('RED'));
if (survived.length) { console.log('\nNOT CAUGHT:\n' + survived.map((r) => '  ' + r.join(': ')).join('\n')); }
console.log(`\n${results.length} mutations, ${results.length - survived.length} caught, ${survived.length} not`);
process.exit(survived.length ? 1 : 0);
