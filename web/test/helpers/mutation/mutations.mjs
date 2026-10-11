// One entry = one defect put back (see mutate.mjs). edits: [{ file, find, replace, count? }]; tests: the suites to run
// (default: `suites`, the cheap ones first). A defect that no suite notices is a property nobody pinned.
export const suites = [
	'shell-sanitize', 'shell-commit', 'shell-runtime', 'shell-runtime-commit', 'shell-runtime-session', 'shell-runtime-agent',
	'shell-runtime-info', 'shell-runtime-extension', 'shell-runtime-engine', 'shell-runtime-worker',
];
const RT = 'web/shell/src/runtime.js';
const CM = 'web/shell/src/commit.js';
const SZ = 'web/shell/src/sanitize.js';
const IN = 'web/shell/src/info.js';
const EX = 'web/shell/src/extension.js';
const e = (file, find, replace, count) => ({ file, find, replace, count });

export const mutations = [
	// ---- runtime: the generation guard and message hygiene
	{ name: 'guard: dead-worker check AND done-state check both removed (a stopped worker\'s late done is applied)', edits: [
		e(RT, "if (rec.dead || !data || typeof data !== 'object') { return; }", "if (!data || typeof data !== 'object') { return; }"),
		e(RT, "if (!run || run.state !== 'running' || msg.id !== run.id) { return; }   // late, duplicate, or for a run that was stopped", "if (!run || msg.id !== run.id) { return; }"),
	] },
	{ name: 'guard: `done` of another run id is accepted', edits: [e(RT, "if (!run || run.state !== 'running' || msg.id !== run.id) { return; }   // late", "if (!run || run.state !== 'running') { return; }   // late")] },
	{ name: 'guard: a message stamped with another generation is accepted', edits: [e(RT, "if (data.gen !== undefined && data.gen !== rec.gen) { return; }", '')] },
	{ name: 'guard: fs request is answered while the run is committing', edits: [e(RT, "if (!run || run.state !== 'running') { return; }\n\t\tlet reply;", "if (!run) { return; }\n\t\tlet reply;")] },
	{ name: 'guard: out of another run is forwarded', edits: [e(RT, "if (!run || run.state !== 'running' || msg.id !== run.id || typeof msg.text !== 'string' || msg.text === '') { return; }", "if (!run || run.state !== 'running' || typeof msg.text !== 'string' || msg.text === '') { return; }")] },
	{ name: 'chunks that are not strings are forwarded', edits: [e(RT, "msg.id !== run.id || typeof msg.text !== 'string' || msg.text === '') { return; }", "msg.id !== run.id || msg.text === '') { return; }")] },

	// ---- runtime: what the engine may read
	{ name: 'read: a path outside every mount falls back to the first mount', edits: [e(RT, "return m ? targetFor(m, /** @type {string} */ (p)) : null;", "const m2 = m || mounts[0]; return m2 ? targetFor(m2, p || '/') : null;")] },
	{ name: 'read: `..` is not resolved', edits: [e(RT, "if (seg === '..') { out.pop(); continue; }", "if (seg === '..') { out.push(seg); continue; }")] },
	{ name: 'read: the per-file cap is not checked before the read', edits: [e(RT, "\t\tif (size > run.caps.readFile) { throw fsError('EFBIG', size + ' bytes; this shell reads at most ' + run.caps.readFile + ' per file'); }\n", '')] },
	{ name: 'read: the per-run budget is not reserved before the read', edits: [e(RT, "\t\trun.readBytes += size;\n\t\tlet bytes;", "\t\tlet bytes;")] },
	{ name: 'read: the size after the read is not checked', edits: [e(RT, "if (bytes.length > run.caps.readFile || run.readBytes > limits.read.served) { throw fsError('EFBIG', 'the file is larger than it said it was'); }", '')] },
	{ name: 'read: a failed read keeps its reservation', edits: [e(RT, "catch (e) { run.readBytes -= size; throw e; }", "catch (e) { throw e; }")] },
	{ name: 'read: the engine gets the provider\'s own buffer (transferred, not copied)', edits: [e(RT, "const copy = reply.value.slice();\n\t\t\treply.value = copy;\n\t\t\tpost(rec, reply, [copy.buffer]);", "post(rec, reply, [reply.value.buffer]);")] },
	{ name: 'read: a read that never answers is never timed out', edits: [e(RT, "const h = deps.setTimeout(() => reject(fsError('ETIMEDOUT')), ms);", "const h = deps.setTimeout(() => { }, ms);")] },
	{ name: 'read: an unknown operation is served as a stat', edits: [e(RT, "if (op !== 'readFile') { throw fsError('EINVAL', 'unknown operation'); }", '')] },
	{ name: 'read: FileSystemError.name is not looked at', edits: [e(RT, "if (c === 'FileNotFound' || /^EntryNotFound/.test(n) || n === 'NotFoundError') { return 'ENOENT'; }", "if (c === 'FileNotFound') { return 'ENOENT'; }")] },
	{ name: 'read: a provider message is passed on to the engine', edits: [e(RT, "if (code !== 'EIO') { return { code, message: POSIX_TEXT[code] }; }", "if (code !== 'EIO') { return { code, message: String(e && e.message) }; }")] },

	// ---- runtime: mounts
	{ name: 'mounts: a folder named like the engine\'s own is not moved', edits: [e(RT, "else if (RESERVED_TOP.has(root.split('/')[1])) { reason = 'that path is one the shell uses for itself'; }", '')] },
	{ name: 'mounts: nested folders are not moved', edits: [e(RT, "else if (clashes(root)) { reason = 'it overlaps another folder'; }", '')] },
	{ name: 'mounts: the review is handed mount paths', edits: [e(RT, "const handed = changes.map((c) => toAgentChange(run.mounts, c));", "const handed = changes;")] },
	{ name: 'mounts: the agent\'s cwd is not translated', edits: [e(RT, "cwd: cwdMount, mounts, owner: agentOwner,", "cwd: cwdN, mounts, owner: agentOwner,")] },
	{ name: 'mounts: a stale worker is reused after the folders changed (no key check at acquire)', edits: [e(RT, "if (rec && rec.key !== key) { terminateRec(rec, 'folders changed'); rec = null; }", '')] },
	{ name: 'mounts: the folder-change event frees nothing', edits: [e(RT, "if (!r.dead && !r.run && r.key !== key) { terminateRec(r, 'folders changed'); }", '')] },

	// ---- runtime: lifecycle
	{ name: 'lifecycle: idle workers are never terminated', edits: [e(RT, "rec.idleTimer = deps.setTimeout(() => { if (!rec.dead && !rec.run) { terminateRec(rec, 'idle'); } }, ms);", "rec.idleTimer = deps.setTimeout(() => { }, ms);")] },
	{ name: 'lifecycle: the idle clock is not started after a run', edits: [e(RT, "rec.run = null; rec.lastUsed = deps.now(); armIdle(rec); }", "rec.run = null; rec.lastUsed = deps.now(); }")] },
	{ name: 'lifecycle: the cap is one too many', edits: [e(RT, "if (workers.size >= limits.workers.max) {", "if (workers.size > limits.workers.max) {")] },
	{ name: 'lifecycle: the NEWEST idle worker is the one replaced', edits: [e(RT, "(idle(r) && (!lru || r.lastUsed < lru.lastUsed))", "(idle(r) && (!lru || r.lastUsed > lru.lastUsed))")] },
	{ name: 'lifecycle: Stop does not terminate the worker', edits: [e(RT, "if (run.rec) { terminateRec(run.rec, 'stopped'); }\n\t\tsettleRun(run, stoppedOutcome(run, signal, null));", "settleRun(run, stoppedOutcome(run, signal, null));")] },
	{ name: 'lifecycle: the host deadline never fires', edits: [e(RT, "\t\t\t\t}, run.timeoutMs);", "\t\t\t\t}, 1e15);")] },
	{ name: 'lifecycle: a worker that is not ready in time is waited for for ever', edits: [e(RT, "rec.readyTimer = deps.setTimeout(() => failRec(rec, 'the shell engine did not start in ' + Math.round(limits.workers.readyMs / 1000) + ' s'), limits.workers.readyMs);", '')] },
	{ name: 'lifecycle: a worker error event does not end the run', edits: [e(RT, "failRec(rec, 'the shell engine stopped unexpectedly' + (ev && ev.message ? ': ' + messageOf(ev.message) : ''));", '')] },
	{ name: 'lifecycle: a postMessage that throws is not caught', edits: [e(RT, "catch (e) { failRec(rec, 'the shell engine could not be reached: ' + messageOf(e)); return false; }", "catch (e) { throw e; }")] },
	{ name: 'lifecycle: a failed script load is remembered', edits: [e(RT, "p.catch(() => { if (sourceP === p) { sourceP = null; } });", "")] },
	{ name: 'lifecycle: agent runs never reuse a worker', edits: [
		e(RT, "let rec = run.owner.rec;", "let rec = null;"),
		e(RT, "if (!rec && run.kind === 'agent') {", "if (false) {"),
	] },
	{ name: 'lifecycle: a worker busy with a run is also handed out', edits: [e(RT, "const idle = (/** @type {Rec} */ r) => !r.dead && !r.run;", "const idle = (/** @type {Rec} */ r) => !r.dead;")] },

	// ---- runtime: the commit rule and the exit status
	{ name: 'commit: changes are applied whatever `how` was', edits: [e(RT, "if (how !== 'exit') {", "if (false) {")] },
	{ name: 'commit: a failed apply does not raise the status', edits: [e(RT, "if (failed > 0 && exit === 0) { exit = 1; }", '')] },
	{ name: 'commit: a denied write does not raise the status', edits: [e(RT, "if (Array.isArray(msg.denied) && msg.denied.length > 0 && exit === 0) { exit = 1; }", '')] },
	{ name: 'commit: the status is raised even from non-zero', edits: [e(RT, "if (failed > 0 && exit === 0) { exit = 1; }", "if (failed > 0) { exit = 1; }")] },
	{ name: 'commit: a limit is not 126', edits: [e(RT, "limit: 126, deadline: 124,", "limit: 1, deadline: 124,")] },
	{ name: 'commit: the review is handed a set nobody checked', edits: [e(RT, "const problems = checkChangeSet(changes, io, caps);\n\t\tif (problems.length > 0) {", "const problems = [];\n\t\tif (problems.length > 0) {")] },
	{ name: 'commit: a refused review still has its leftovers applied', edits: [e(RT, "const handedBack = refused ? [] : r.rest;", "const handedBack = r.rest;")] },
	{ name: 'commit: a review that throws is not caught', edits: [e(RT, "return { applied: 0, failed: total, early: false, notes: [note('the command\\'s file changes could not be applied (' + messageOf(e) + '); some of them may have been')] };", "throw e;")] },
	{ name: 'commit: Stop interrupts the apply', edits: [e(RT, "if (run.state === 'committing') { return true; }", '')] },
	{ name: 'commit: the review\'s failed count is ignored', edits: [e(RT, "if (typeof r.failed === 'number' && Number.isFinite(r.failed) && r.failed >= 0) { failed = Math.trunc(r.failed); }", "if (false) { failed = 0; }")] },
	{ name: 'commit: engine notes are dropped', edits: [e(RT, ".concat(cleanNotes(msg.notes));", ";")] },
	{ name: 'commit: output cap not enforced', edits: [e(RT, "if (run.outChars > limits.engine.maxOutputSize * 2) { run.outCapped = true; return; }", '')] },

	// ---- runtime: ChildLike
	{ name: 'child: notes are not appended to stderr', edits: [e(RT, "if (out.notes.length > 0) { c.data('stderr', out.notes.join('\\n') + '\\n'); }", '')] },
	{ name: 'child: close comes before the notes', edits: [e(RT, "const end = (/** @type {Outcome} */ out) => {\n\t\t\ttry {", "const end = (/** @type {Outcome} */ out) => {\n\t\t\tc.close(out.exitCode);\n\t\t\ttry {")] },
	{ name: 'child: kill after close is true', edits: [e(RT, "if (c.closed) { return false; }\n\t\t\t\tif (run)", "if (run)")] },
	{ name: 'child: a second kill before close is false', edits: [e(RT, "if (run) { killRun(run, signal === 'SIGKILL' || signal === 9 ? 'SIGKILL' : 'SIGTERM'); }\n\t\t\t\treturn true;", "return run ? killRun(run, signal === 'SIGKILL' || signal === 9 ? 'SIGKILL' : 'SIGTERM') : true;")] },
	{ name: 'child: SIGKILL is not 137', edits: [e(RT, "finish(run, 'aborted', signal === 'SIGKILL' ? 137 : 130,", "finish(run, 'aborted', 130,")] },
	{ name: 'child: spawn throws', edits: [e(RT, "failFast('could not start the command: ' + messageOf(e));", "throw e;")] },
	{ name: 'child: a non-string command is run', edits: [e(RT, "if (typeof command !== 'string') { failFast('the command must be text'); return c.child; }", '')] },
	{ name: 'child: a cwd outside the folders is run anyway', edits: [e(RT, "if (!cwdMount) { failFast('the working directory ' + forNote(o.cwd) + ' is not inside a workspace folder'); return c.child; }", "")] },
	{ name: 'child: opts.env is passed unfiltered', edits: [e(RT, "if (!ENV_NAME.test(k) || typeof v !== 'string') { continue; }", '')] },
	{ name: 'child: a late listener hears nothing', edits: [e(RT, "if (subs[name].length === 0) { held[name].push(text); return; }", "if (subs[name].length === 0) { return; }")] },
	{ name: 'child: a failed spawn is not an end for the mirror', edits: [e(RT, "emitAgent({ type: 'end', id, exitCode: out.exitCode, how: out.how, notes: out.notes.slice() });", '')] },
	{ name: 'child: a throwing mirror breaks the run', edits: [e(RT, "try { l(e); } catch (err) { log('listener-threw', { message: messageOf(err) }); }", "l(e);")] },

	// ---- runtime: session
	{ name: 'session: busy is not rejected', edits: [e(RT, "if (pending) { throw new Error('busy'); }", '')] },
	{ name: 'session: a cwd in the engine\'s memory is carried over a replaced worker', edits: [e(RT, "if (!findMount(mounts, cwd) && !ENGINE_DIRS.has(cwd) && !(owner.rec && !owner.rec.dead && owner.rec.gen === cwdGen)) {", "if (false) {")] },
	{ name: 'session: env is not carried', edits: [e(RT, "if (out.env) { env = out.env; }", '')] },
	{ name: 'session: a stopped run changes cwd', edits: [e(RT, "if (out.how === 'exit' && !closed) {", "if (!closed) {")] },
	{ name: 'session: env is handed out as is', edits: [e(RT, "get env() { return Object.freeze(Object.assign({}, env)); },", "get env() { return env; },")] },
	{ name: 'session: COLUMNS from any value', edits: [e(RT, "const columns = sizeVar(o2.cols);", "const columns = o2.cols ? String(o2.cols) : undefined;")] },
	{ name: 'session: completion is not capped', edits: [e(RT, ".slice(0, limits.workers.completeMax);", ";", 2)] },
	{ name: 'session: completion has no time limit', edits: [e(RT, "try { return await withTimeout(completePath(p), limits.workers.completeMs); } catch { return []; }", "try { return await completePath(p); } catch { return []; }")] },
	{ name: 'session: completion shows dotfiles always', edits: [e(RT, ".filter(([n]) => n.startsWith(namePart) && (hidden || n[0] !== '.'))", ".filter(([n]) => n.startsWith(namePart))")] },
	{ name: 'session: dispose leaves the worker', edits: [e(RT, "if (owner.rec) { terminateRec(owner.rec, 'session closed'); }", '')] },
	{ name: 'session: dispose of the runtime leaves runs pending', edits: [e(RT, "for (const run of Array.from(active)) { killRun(run, 'SIGKILL'); }", '')] },

	// ---- commit.js
	{ name: 'commit.js: the conflict check is skipped', edits: [e(CM, "if (conflicts.length) { return refuse(conflicts, total); }", '')] },
	{ name: 'commit.js: deletes and folder removals shallowest first', edits: [e(CM, ".sort((a, b) => depth(b.path) - depth(a.path) || byPath(a.path, b.path));", ".sort((a, b) => depth(a.path) - depth(b.path) || byPath(a.path, b.path));", 2)] },
	{ name: 'commit.js: deletes before writes', edits: [
		e(CM, "for (const c of writes) { await step(c.path, true, () => io.writeFile(io.resolve(c.path), c.after)); }\n\tfor (const c of deletes) { await step(c.path, true, () => io.remove(io.resolve(c.path))); }",
			"for (const c of deletes) { await step(c.path, true, () => io.remove(io.resolve(c.path))); }\n\tfor (const c of writes) { await step(c.path, true, () => io.writeFile(io.resolve(c.path), c.after)); }"),
	] },
	{ name: 'commit.js: the apply goes on after a failure', edits: [e(CM, "if (stopped) { return; }\n\t\ttry { await fn();", "try { await fn();")] },
	{ name: 'commit.js: per-file cap off by one', edits: [e(CM, "if (c.after.length > caps.writeFile) {", "if (c.after.length >= caps.writeFile) {")] },
	{ name: 'commit.js: per-run cap off by one', edits: [e(CM, "if (bytes > caps.writeRun) {", "if (bytes >= caps.writeRun) {")] },
	{ name: 'commit.js: entry cap off by one', edits: [e(CM, "if (changes.length > caps.entries) {", "if (changes.length >= caps.entries) {")] },
	{ name: 'commit.js: a path outside every folder is accepted', edits: [e(CM, "if (!io.resolve(c.path)) { out.push(p + ' is outside the workspace folders'); continue; }", '')] },
	{ name: 'commit.js: an unnormalised path is accepted', edits: [e(CM, "if (c.path[0] !== '/' || UNNORMALISED.test(c.path)) { out.push(p + ' is not a normal absolute path'); continue; }", '')] },
	{ name: 'commit.js: the same path twice is accepted', edits: [e(CM, "first === c.path\n\t\t\t\t? p + ' appears twice in the change set'\n\t\t\t\t: p + ' differs from '", "false\n\t\t\t\t? p + ' appears twice in the change set'\n\t\t\t\t: p + ' differs from '")] },
	{ name: 'commit.js: a refusal still applies what is fine', edits: [e(CM, "if (problems.length) { return refuse(problems, total); }", '')] },
	{ name: 'commit.js: bytes are read even when the size already differs', edits: [e(CM, "if (before && (st.size !== before.length || !sameBytes(await io.readFile(t), before)))", "if (before && !sameBytes(await io.readFile(t), before))")] },
	{ name: 'commit.js: a folder that exists is made again', edits: [e(CM, "if (st && st.isDirectory) { return; }\n\t\t\tawait io.createDirectory(t);", "await io.createDirectory(t);")] },
	{ name: 'commit.js: reasons are not made safe', edits: [e(CM, "function reasonOf(e) { return forNote((e && /** @type {any} */ (e).message) || e).slice(0, 160); }", "function reasonOf(e) { return String((e && /** @type {any} */ (e).message) || e).slice(0, 160); }")] },
	{ name: 'commit.js: a file that was not there may have appeared', edits: [e(CM, "if (!expectedHere) { if (st) { out.push(p + ' was created while the command ran'); } continue; }", "if (!expectedHere) { continue; }")] },
	{ name: 'commit.js: a file that is now a folder is overwritten', edits: [e(CM, "if (st.isDirectory) { out.push(p + ' is a folder now'); continue; }", '')] },
	{ name: 'commit.js: a path that cannot be checked passes', edits: [e(CM, "out.push(p + ' could not be checked: ' + reasonOf(e));", '')] },
	{ name: 'commit.js: failure report counts nothing', edits: [e(CM, "total, applied, failed: total - applied, refused: false,", "total, applied, failed: 0, refused: false,")] },

	// ---- sanitize.js
	{ name: 'sanitize: U+2028/2029, braille blank and annotation anchors pass', edits: [e(SZ, String.raw`\u{2028}\u{2029}\u{2800}\u{FFF9}-\u{FFFB}`, '')] },
	{ name: 'sanitize: default-ignorable characters pass', edits: [e(SZ, String.raw`\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}\u{2028}`, String.raw`\p{Cc}\p{Cf}\u{2028}`)] },
	{ name: 'sanitize: C1 controls pass', edits: [e(SZ, String.raw`/[\p{Cc}\p{Cf}\p{Default`, String.raw`/[\x00-\x1F\x7F\p{Cf}\p{Default`)] },
	{ name: 'sanitize: lone surrogates pass', edits: [e(SZ, String.raw`\u{D800}-\u{DFFF}]/gu;`, String.raw`]/gu;`)] },
	{ name: 'sanitize: a lone CR is left for the terminal', edits: [e(SZ, "if (cp === 0x0D) { return s.charCodeAt(i + 1) === 0x0A ? '' : nl; }", "if (cp === 0x0D) { return '\\r'; }")] },
	{ name: 'sanitize: a CR LF becomes two breaks', edits: [e(SZ, "return s.charCodeAt(i + 1) === 0x0A ? '' : nl;", "return nl;")] },
	{ name: 'sanitize: forDisplay turns a CR into a break', edits: [e(SZ, "if (cp === 0x0A || cp === 0x09) { return ch; }", "if (cp === 0x0A || cp === 0x09 || cp === 0x0D) { return ch; }")] },
	{ name: 'sanitize: forTerminal draws no emoji sequence', edits: [e(SZ, "if (joinsEmoji(s, i, cp) || joinsScript(s, i, cp)) { return ch; }", "if (joinsScript(s, i, cp)) { return ch; }")] },
	{ name: 'sanitize: forDisplay keeps emoji joiners', edits: [e(SZ, "return bracket(cp);\n\t});\n}\n\n/**\n * A name, a path", "return /[\\u{FE0F}\\u{200D}]/u.test(ch) ? ch : bracket(cp);\n\t});\n}\n\n/**\n * A name, a path")] },
	{ name: 'sanitize: a VS16 after anything is kept', edits: [e(SZ, "if (PICTOGRAPH.test(prev)) { return true; }", "return true;")] },
	{ name: 'sanitize: a ZWJ anywhere is kept', edits: [e(SZ, "return PICTOGRAPH.test(left) && PICTOGRAPH.test(after(s, i + 1));", "return true;")] },
	{ name: 'sanitize: a second VS in a row is kept', edits: [e(SZ, "if (left === '\\u{FE0F}' || left === '\\u{FE0E}') { left = before(s, i - 1); }", "")] },
	{ name: 'sanitize: null is the word null', edits: [e(SZ, "if (value === null || value === undefined) { return ''; }", "")] },
	{ name: 'sanitize: DEL passes', edits: [e(SZ, "if (cp === 0x7F) { return '\\u{2421}'; }", "", 2)] },

	// ---- info.js
	{ name: 'info: call depth limit changed', edits: [e(IN, "maxCallDepth: 100,", "maxCallDepth: 1000,")] },
	{ name: 'info: read budget changed', edits: [e(IN, "read: { file: 4 * MiB, run: 16 * MiB, served: 32 * MiB },", "read: { file: 4 * MiB, run: 64 * MiB, served: 32 * MiB },")] },
	{ name: 'info: agent staging cap changed', edits: [e(IN, "agent: { writeFile: 1 * MiB, writeRun: 8 * MiB, entries: 2000 },", "agent: { writeFile: 8 * MiB, writeRun: 8 * MiB, entries: 2000 },")] },
	{ name: 'info: an empty list from the engine replaces the programs', edits: [e(IN, "if (ok.length === 0) { return; }", '')] },
	{ name: 'info: `missing` is the constant', edits: [e(IN, "get() { return MISSING.filter((n) => !have.has(n)); }", "get() { return MISSING.slice(); }")] },
	{ name: 'info: the table is not frozen', edits: [e(IN, "Object.values(o).forEach(deepFreeze); Object.freeze(o);", "Object.values(o).forEach(deepFreeze);")] },
	{ name: 'info: an override with a bad value is applied', edits: [e(IN, "if (typeof o[k] === 'number' && Number.isFinite(o[k]) && o[k] > 0) {", "if (k in o) {")] },
	{ name: 'info: commands are handed out by reference', edits: [e(IN, "get() { return commands.slice(); }", "get() { return commands; }")] },

	// ---- extension.js
	{ name: 'extension: activation starts a worker', edits: [e(EX, "const runtime = createRuntime(production.deps);", "const runtime = createRuntime(production.deps);\n\truntime.spawnAgent('', { cwd: '/scratch' });")] },
	{ name: 'extension: a broken terminal fails activation', edits: [e(EX, "log('terminal-unavailable', { message: String((e && /** @type {any} */ (e).message) || e) });", "throw e;")] },
	{ name: 'extension: without workers an agent shell is still offered', edits: [e(EX, "if (!canMakeWorkers()) { return { apiVersion: 1 }; }", '')] },
	{ name: 'extension: the Blob URL is never revoked', edits: [e(EX, "production.release();", '')] },
	{ name: 'extension: one Blob URL per worker', edits: [e(EX, "if (url === null || urlSource !== source) {", "if (true) {")] },
	{ name: 'extension: the terminal is told nothing of the limits', edits: [e(EX, "config: { info: runtime.info, limits: runtime.limits },", "config: {},")] },
	{ name: 'extension: the engine script is read from the wrong place', edits: [e(EX, "const ENGINE_ASSET = 'engine.worker.js';", "const ENGINE_ASSET = 'dist/engine.worker.js';")] },
	{ name: 'extension: the worker is not named', edits: [e(EX, "return new Worker(url, { name: 'levelcode-shell-engine' });", "return new Worker(url);")] },

	// ---- more of the same
	{ name: 'session: Stop does nothing', edits: [e(RT, "stop() { if (pending) { killRun(pending, 'SIGTERM'); } },", "stop() { },")] },
	{ name: 'init: no command list', edits: [e(RT, "limits: Object.assign({}, limits.engine), commands: PROGRAMS.slice(),", "limits: Object.assign({}, limits.engine), commands: [],")] },
	{ name: 'init: no limits', edits: [e(RT, "limits: Object.assign({}, limits.engine), commands: PROGRAMS.slice(),", "limits: {}, commands: PROGRAMS.slice(),")] },
	{ name: 'init: folders at their root, not their mount', edits: [e(RT, "folders: mounts.map((m) => ({ id: m.id, path: m.mount, name: m.name })),", "folders: mounts.map((m) => ({ id: m.id, path: m.root, name: m.name })),")] },
	{ name: 'run: the script gets stdin', edits: [e(RT, "stdin: '', caps: run.caps", "stdin: 'x', caps: run.caps")] },
	{ name: 'run: caps are the terminal\'s for the agent too', edits: [e(RT, "const k = o.kind === 'agent' ? limits.agent : limits.terminal;", "const k = limits.terminal;")] },
	{ name: 'lifecycle: a dead worker keeps its idle timer', edits: [e(RT, "\t\tdeps.clearTimeout(rec.idleTimer);\n\t\tdeps.clearTimeout(rec.readyTimer);\n\t\tworkers.delete(rec);", "\t\tworkers.delete(rec);")] },
	{ name: 'lifecycle: the ready timer is not cleared when ready', edits: [e(RT, "\t\t\t\t\tdeps.clearTimeout(rec.readyTimer);\n\t\t\t\t\tupdateInfo(data.commands);", "\t\t\t\t\tupdateInfo(data.commands);")] },
	{ name: 'lifecycle: a settled run keeps its deadline timer', edits: [e(RT, "\t\trun.state = 'settled';\n\t\tdeps.clearTimeout(run.deadlineTimer);", "\t\trun.state = 'settled';")] },
	{ name: 'lifecycle: the runtime does not terminate workers on dispose', edits: [e(RT, "for (const r of Array.from(workers)) { terminateRec(r, 'disposed'); }", '')] },
	{ name: 'lifecycle: the workspace subscription outlives the runtime', edits: [e(RT, "if (sub && typeof sub.dispose === 'function') { sub.dispose(); }", '')] },
	{ name: 'lifecycle: the engine script is loaded for every worker', edits: [e(RT, "sourceP = p;\n", "")] },
	{ name: 'child: spawn throws for a cwd with a throwing toString', edits: [e(RT, "failFast('could not start the command: ' + messageOf(e));", "throw e;")], tests: ['shell-runtime-agent'] },
	{ name: 'info: runtime.info is not the engine-fed one', edits: [e(RT, "updateInfo(data.commands);", "")] },
	{ name: 'run: PWD is not the cwd for the agent', edits: [e(RT, "env: Object.assign(baseEnv(cwdMount), given.env, { PWD: cwdMount }),", "env: Object.assign(baseEnv(cwdMount), given.env),")] },
	{ name: 'run: opts.env cannot override the base', edits: [e(RT, "env: Object.assign(baseEnv(cwdMount), given.env, { PWD: cwdMount }),", "env: Object.assign(given.env, baseEnv(cwdMount), { PWD: cwdMount }),")] },

	// ---- added with the engine integration
	{ name: 'run: a terminal does not ask to keep /tmp and aliases', edits: [e(RT, "post(rec, run.kind === 'terminal' ? Object.assign(msg, { keepTmp: true, expandAliases: true }) : msg);", "post(rec, msg);")] },
	{ name: 'run: an agent keeps /tmp too', edits: [e(RT, "post(rec, run.kind === 'terminal' ? Object.assign(msg, { keepTmp: true, expandAliases: true }) : msg);", "post(rec, Object.assign(msg, { keepTmp: true, expandAliases: true }));")] },
	{ name: 'mounts: a moved folder is not said', edits: [e(RT, "const notes = run.mounts.filter((m) => m.reason).map(", "const notes = run.mounts.filter((m) => false).map(")] },
	{ name: 'read: the run budget error is not EFBIG', edits: [e(RT, "throw fsError('EFBIG', 'this command has read its share: at most '", "throw fsError('EIO', 'this command has read its share: at most '")] },
	{ name: 'lifecycle: a script load that never answers is waited for for ever', edits: [e(RT, "const h = deps.setTimeout(() => reject(new Error('the shell engine could not be loaded in ' + Math.round(limits.workers.readyMs / 1000) + ' s')), limits.workers.readyMs);", "const h = null;")] },
	{ name: 'read: a provider that does not return bytes is trusted', edits: [e(RT, "if (!(bytes instanceof Uint8Array)) { run.readBytes -= size; throw fsError('EIO', 'the file system did not return bytes'); }", '')] },
	{ name: 'read: a stat without a time is passed on as undefined', edits: [e(RT, "mtime: typeof s.mtime === 'number' ? s.mtime : 0 };", "mtime: s.mtime };")] },
	{ name: 'extension: no fetch fallback', edits: [e(EX, "if (typeof fetch !== 'function') { throw e; }", "throw e;")] },
	{ name: 'extension: a failed fetch hides the first reason', edits: [e(EX, "throw new Error(said(e) + '; fetching ' + ENGINE_ASSET + ' instead failed too: ' + said(e2));", "throw e2;")] },

	// ---- commit I/O, case folding, the served cap
	{ name: 'commit.js: case-only differences are accepted', edits: [e(CM, "if (first !== undefined) {", "if (false) {")] },
	{ name: 'commit.js: accent forms are not folded', edits: [e(CM, "const key = c.path.normalize('NFC').toLowerCase();", "const key = c.path.toLowerCase();")] },
	{ name: 'commit: a write that never answers is waited for for ever', edits: [e(RT, "writeFile: (/** @type {any} */ t, /** @type {Uint8Array} */ b) => withTimeout(fs.writeFile(t, b), limits.workers.fsMs),", "writeFile: (/** @type {any} */ t, /** @type {Uint8Array} */ b) => fs.writeFile(t, b),")] },
	{ name: 'commit: a stat that never answers is waited for for ever', edits: [e(RT, "try { const s = await withTimeout(fs.stat(t), limits.workers.fsMs); return", "try { const s = await fs.stat(t); return")] },
	{ name: 'commit: a review that never answers is waited for for ever', edits: [e(RT, ", limits.workers.commitMs);", ", Infinity);")] },
	{ name: 'read: the served cap is the engine\'s budget', edits: [e(RT, "if (run.readBytes + size > limits.read.served) {", "if (run.readBytes + size > run.caps.readRun) {")] },

	// ---- the fix round: planMounts always returns, mounts()
	{ name: 'mounts: a folder at /mnt does not take /mnt away as the place to move others to (the host hangs)', edits: [e(RT, "for (let b = 1; taken.some((t) => isInside(base, t)); b++) { base = '/lc-mnt' + (b > 1 ? '-' + b : ''); }", '')], tests: ['shell-runtime'] },
	{ name: 'mounts: /lc-mnt is the base even when it is taken', edits: [e(RT, "base = '/lc-mnt' + (b > 1 ? '-' + b : '');", "base = '/lc-mnt';")], tests: ['shell-runtime'] },
	{ name: 'mounts: runtime.mounts() is gone', edits: [e(RT, "mounts: currentMounts,\n", '')], tests: ['shell-runtime'] },
	{ name: 'mounts: nested roots map to the first root that matches, not the longest', edits: [e(RT, "if (isInside(abs, m.root) && (!best || m.root.length > best.root.length)) { best = m; }", "if (isInside(abs, m.root) && !best) { best = m; }")], tests: ['shell-runtime'] },

	// ---- a commit that is going on is never reported as something else
	{ name: 'lifecycle: a worker that dies after done settles the run with an error while its changes are written', edits: [e(RT, "if (run.state === 'committing') { run.workerFailure = message; return; }", '')], tests: ['shell-runtime-commit'] },
	{ name: 'lifecycle: a worker that dies after done is not mentioned in the result', edits: [e(RT, "if (run.workerFailure) { notes.push(note(run.workerFailure + ', after the command had finished')); }", '')], tests: ['shell-runtime-commit'] },
	{ name: 'lifecycle: dispose settles a run whose commit is going on, with "nothing applied"', edits: [e(RT, "for (const run of Array.from(active)) { killRun(run, 'SIGKILL'); }", "for (const run of Array.from(active)) { if (run.rec) { terminateRec(run.rec, 'disposed'); } run.killed = run.killed || 'SIGKILL'; settleRun(run, stoppedOutcome(run, 'SIGKILL', null)); }")], tests: ['shell-runtime-commit'] },
	{ name: 'lifecycle: a worker that fails is not logged', edits: [e(RT, "log('worker-failed', { gen: rec.gen, kind: rec.kind, reason: message });", '')], tests: ['shell-runtime', 'shell-runtime-extension'] },
	{ name: 'lifecycle: a messageerror is ignored (the run waits for its deadline)', edits: [e(RT, "worker.onmessageerror = () => failRec(rec, 'the shell engine sent a message that could not be read');", "worker.onmessageerror = () => { };")], tests: ['shell-runtime'] },
	{ name: 'lifecycle: the idle timer of the run before kills a worker that is running (clearTimeout at acquire AND the !rec.run guard removed)', edits: [
		e(RT, "if (!rec.dead && !rec.run) { terminateRec(rec, 'idle'); }", "if (!rec.dead) { terminateRec(rec, 'idle'); }"),
		e(RT, "\t\tdeps.clearTimeout(rec.idleTimer);\n\t\trec.run = run;", "\t\trec.run = run;"),
	], tests: ['shell-runtime'] },
	{ name: 'lifecycle: a late done of a deadline-terminated worker is applied (dead check and state check removed)', edits: [
		e(RT, "if (rec.dead || !data || typeof data !== 'object') { return; }", "if (!data || typeof data !== 'object') { return; }"),
		e(RT, "if (!run || run.state !== 'running' || msg.id !== run.id) { return; }   // late, duplicate, or for a run that was stopped", "if (!run || msg.id !== run.id) { return; }"),
	], tests: ['shell-runtime-commit'] },

	// ---- /tmp
	{ name: 'tmp: a replaced worker\'s /tmp is never mentioned', edits: [e(RT, "if (before && before.tmpFiles > 0) { run.lead.push(emptiedTmpNote(before.tmpFiles)); }", '')], tests: ['shell-runtime-session'] },
	{ name: 'tmp: an agent worker remembers its /tmp too (and is kept twice as long)', edits: [e(RT, "if (run.kind === 'terminal') { rec.tmpFiles = tmpFilesOf(msg); }", "rec.tmpFiles = tmpFilesOf(msg);")], tests: ['shell-runtime-session'] },
	{ name: 'tmp: the files of a worker\'s /tmp are never remembered', edits: [e(RT, "if (run.kind === 'terminal') { rec.tmpFiles = tmpFilesOf(msg); }", '')], tests: ['shell-runtime-session'] },
	{ name: 'tmp: a worker with files in /tmp is idle-terminated after one idle time', edits: [e(RT, "const ms = limits.workers.idleMs * (rec.tmpFiles > 0 ? 2 : 1);", "const ms = limits.workers.idleMs;")], tests: ['shell-runtime-session'] },
	{ name: 'tmp: every worker is kept twice as long', edits: [e(RT, "const ms = limits.workers.idleMs * (rec.tmpFiles > 0 ? 2 : 1);", "const ms = limits.workers.idleMs * 2;")], tests: ['shell-runtime', 'shell-runtime-session'] },
	{ name: 'tmp: notes of the run are not delivered (lead notes dropped)', edits: [e(RT, "if (run.lead.length > 0) { o.notes = run.lead.concat(o.notes); }", '')], tests: ['shell-runtime-session'] },
	{ name: 'tmp: tmpFiles is believed whatever it is', edits: [e(RT, "return typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;", "return n || 0;")], tests: ['shell-runtime-session'] },

	// ---- rmdir, Stop in the check
	{ name: 'commit: a folder is removed with what it holds (recursive: true)', edits: [e(RT, "fs.delete(t, { recursive: false, useTrash: false })", "fs.delete(t, { recursive: true, useTrash: false })")], tests: ['shell-runtime-commit'] },
	{ name: 'commit: a removal goes to the trash', edits: [e(RT, "fs.delete(t, { recursive: false, useTrash: false })", "fs.delete(t, { recursive: false, useTrash: true })")], tests: ['shell-runtime-commit'] },
	{ name: 'commit: Stop is not heard while the change set is checked', edits: [e(RT, "const cancelled = () => run.killed !== null;", "const cancelled = () => false;")], tests: ['shell-runtime-commit'] },
	{ name: 'commit.js: cancelled() is not asked after the last check', edits: [e(CM, "if (cancelled && cancelled()) { return { total, applied: 0, failed: total, refused: false, cancelled: true, notes: [] }; }", '')], tests: ['shell-commit'] },
	{ name: 'commit.js: cancelled() is not asked between files', edits: [e(CM, "if (cancelled && cancelled()) { break; }", '')], tests: ['shell-commit'] },
	{ name: 'commit.js: a conflict wins over a stop', edits: [
		e(CM, "if (cancelled && cancelled()) { return { total, applied: 0, failed: total, refused: false, cancelled: true, notes: [] }; }\n\tif (conflicts.length) { return refuse(conflicts, total); }",
			"if (conflicts.length) { return refuse(conflicts, total); }\n\tif (cancelled && cancelled()) { return { total, applied: 0, failed: total, refused: false, cancelled: true, notes: [] }; }"),
	], tests: ['shell-commit'] },
	{ name: 'commit: a stop in the check is reported as a stop while applying', edits: [e(RT, "? 'stopped before anything was applied: the command\\'s file changes were checked, and were NOT applied.'", "? 'stopped while its file changes were being applied; ' + applied + ' of them were applied.'")], tests: ['shell-runtime-commit'] },
	{ name: 'commit: the folders a stopped review left are made anyway', edits: [e(RT, "const rr = await commitChanges(back, io, caps, cancelled);", "const rr = await commitChanges(back, io, caps);")], tests: ['shell-runtime-commit'] },

	// ---- what the review hands back
	{ name: 'review: `rest` of any kind is applied by the shell', edits: [e(RT, "c && (c.kind === 'mkdir' || c.kind === 'rmdir') && folders.has(c.kind + ' ' + c.path));", "c && typeof c.path === 'string');")], tests: ['shell-runtime-commit'] },
	{ name: 'review: a folder the command never touched is applied from `rest`', edits: [e(RT, "&& folders.has(c.kind + ' ' + c.path));", ");")], tests: ['shell-runtime-commit'] },
	{ name: 'review: an entry dropped from `rest` is not said', edits: [e(RT, "if (ignored > 0) {\n\t\t\tfailed += ignored;", "if (false) {\n\t\t\tfailed += ignored;")], tests: ['shell-runtime-commit'] },
	{ name: 'review: an answer that is not an object with `rest` is success', edits: [e(RT, "if (!r || typeof r !== 'object' || !Array.isArray(r.rest)) {", "if (false) {")], tests: ['shell-runtime-commit'] },
	{ name: 'review: a failure count of Infinity or NaN is believed', edits: [e(RT, "if (typeof r.failed === 'number' && Number.isFinite(r.failed) && r.failed >= 0) { failed = Math.trunc(r.failed); }", "if (typeof r.failed === 'number') { failed = r.failed > 0 ? Math.trunc(r.failed) : 0; }")], tests: ['shell-runtime-commit'] },
	{ name: 'review: viaDir is not translated to the agent\'s paths', edits: [e(RT, "if (typeof c.viaDir === 'string') { out.viaDir = toRootPath(mounts, c.viaDir); }", '')], tests: ['shell-runtime-commit'] },
	{ name: 'review: a viaDir that was not there is invented', edits: [e(RT, "if (typeof c.viaDir === 'string') { out.viaDir = toRootPath(mounts, c.viaDir); }", "out.viaDir = toRootPath(mounts, c.viaDir);")], tests: ['shell-runtime-commit'] },

	// ---- variables, sizes, answers, timers
	{ name: 'env: the variable that overflows ends the list (everything after it is lost)', edits: [e(RT, "if (count >= MAX_ENV_ENTRIES || bytes + size > MAX_ENV_BYTES) { dropped++; continue; }", "if (count >= MAX_ENV_ENTRIES || bytes + size > MAX_ENV_BYTES) { dropped++; break; }")], tests: ['shell-runtime-session'] },
	{ name: 'env: the byte bound is off by one', edits: [e(RT, "bytes + size > MAX_ENV_BYTES", "bytes + size >= MAX_ENV_BYTES")], tests: ['shell-runtime-session'] },
	{ name: 'env: the entry bound is off by one', edits: [e(RT, "count >= MAX_ENV_ENTRIES", "count > MAX_ENV_ENTRIES")], tests: ['shell-runtime-session'] },
	{ name: 'env: the variables left out are not said (carried env)', edits: [e(RT, "if (carried && carried.dropped > 0) { notes.push(droppedEnvNote(carried.dropped)); }", '')], tests: ['shell-runtime-session'] },
	{ name: 'env: the variables left out are not said (agent opts.env)', edits: [e(RT, "if (given.dropped > 0) { run.lead.push(droppedEnvNote(given.dropped)); }", '')], tests: ['shell-runtime-session'] },
	{ name: 'env: a name that is not a name is counted as left out', edits: [e(RT, "if (!ENV_NAME.test(k) || typeof v !== 'string') { continue; }", "if (!ENV_NAME.test(k) || typeof v !== 'string') { dropped++; continue; }")], tests: ['shell-runtime-session'] },
	{ name: 'size: a size that is not a number is used as it is', edits: [e(RT, "function sizeOf(s) { return s && typeof s.size === 'number' && Number.isFinite(s.size) && s.size >= 0 ? s.size : null; }", "function sizeOf(s) { return s ? s.size : null; }")], tests: ['shell-runtime'] },
	{ name: 'size: a negative size is a size', edits: [e(RT, "Number.isFinite(s.size) && s.size >= 0 ? s.size : null;", "Number.isFinite(s.size) ? s.size : null;")], tests: ['shell-runtime'] },
	{ name: 'size: a folder with no size is an error too', edits: [e(RT, "if (size === null && (s.type & DIR) === 0) {", "if (size === null) {")], tests: ['shell-runtime'] },
	{ name: 'fs: an error that cannot be described makes the read unanswered', edits: [e(RT, "try { error = toWireError(e); } catch { error = { code: 'EIO', message: POSIX_TEXT.EIO }; }", "error = toWireError(e);")], tests: ['shell-runtime'] },
	{ name: 'fs: a rejection of the answer itself is unhandled', edits: [e(RT, "case 'fs': serveFs(rec, data).catch((e) => fsFailed(rec, data, e)); return;", "case 'fs': serveFs(rec, data); return;")], tests: ['shell-runtime'] },
	{ name: 'fs: the last-resort answer is not sent', edits: [e(RT, "post(rec, { t: 'fsr', rid: msg.rid, ok: false, error: { code: 'EIO', message: POSIX_TEXT.EIO } });\n\t}", "void 0;\n\t}")], tests: ['shell-runtime'] },
	{ name: 'timeout: an absurd timeoutMs is passed to setTimeout', edits: [e(RT, "typeof o.timeoutMs === 'number' && o.timeoutMs >= 1 && o.timeoutMs <= MAX_TIMER_MS", "typeof o.timeoutMs === 'number' && o.timeoutMs > 0")], tests: ['shell-runtime'] },
	{ name: 'timeout: the largest timer is refused', edits: [e(RT, "o.timeoutMs <= MAX_TIMER_MS", "o.timeoutMs < MAX_TIMER_MS")], tests: ['shell-runtime'] },
	{ name: 'timeout: 1 ms is refused', edits: [e(RT, "o.timeoutMs >= 1 &&", "o.timeoutMs > 1 &&")], tests: ['shell-runtime'] },
	{ name: 'timeout: the default is not clamped to what a timer holds', edits: [e(RT, "? o.timeoutMs : Math.min(MAX_TIMER_MS, limits.engine.maxExecutionTimeMs + limits.workers.deadlineGraceMs),", "? o.timeoutMs : limits.engine.maxExecutionTimeMs + limits.workers.deadlineGraceMs,")], tests: ['shell-runtime'] },

	// ---- the session and the agent
	{ name: 'session: run() throws synchronously', edits: [e(RT, "async run(script, opts) {", "run(script, opts) {")], tests: ['shell-runtime-session'] },
	{ name: 'session: a script that is not text is run', edits: [e(RT, "if (typeof script !== 'string') { throw new Error('script must be text'); }", '')], tests: ['shell-runtime-session'] },
	{ name: 'session: LINES is not set', edits: [e(RT, "if (lines) { env2.LINES = lines; }", '')], tests: ['shell-runtime-session'] },
	{ name: 'session: LINES takes the width', edits: [e(RT, "const lines = sizeVar(o2.rows);", "const lines = sizeVar(o2.cols);")], tests: ['shell-runtime-session'] },
	{ name: 'session: a terminal size of 0 or less than 1 is passed', edits: [e(RT, "return whole >= 1 && whole < 10000 ? String(whole) : undefined;", "return whole >= 0 && whole < 10000 ? String(whole) : undefined;")], tests: ['shell-runtime-session'] },
	{ name: 'session: a terminal size of 10000 is passed', edits: [e(RT, "return whole >= 1 && whole < 10000 ? String(whole) : undefined;", "return whole >= 1 && whole <= 10000 ? String(whole) : undefined;")], tests: ['shell-runtime-session'] },
	{ name: 'agent: the explanation is not carried', edits: [e(RT, "if (typeof o.explanation === 'string' && o.explanation.length > 0) { start.explanation = cut(o.explanation, MAX_EXPLANATION); }", '')], tests: ['shell-runtime-agent'] },
	{ name: 'agent: the explanation is not capped', edits: [e(RT, "start.explanation = cut(o.explanation, MAX_EXPLANATION);", "start.explanation = o.explanation;")], tests: ['shell-runtime-agent'] },
	{ name: 'agent: the explanation cap is 499', edits: [e(RT, "const MAX_EXPLANATION = 500;", "const MAX_EXPLANATION = 499;")], tests: ['shell-runtime-agent'] },
	{ name: 'agent: an empty explanation is carried', edits: [e(RT, "if (typeof o.explanation === 'string' && o.explanation.length > 0) {", "if (typeof o.explanation === 'string') {")], tests: ['shell-runtime-agent'] },
	{ name: 'agent: a working directory that cannot be printed is "could not start"', edits: [e(RT, "forNote(o.cwd) + ' is not inside a workspace folder'", "forNote(String(o.cwd)) + ' is not inside a workspace folder'")], tests: ['shell-runtime-agent'] },
	{ name: 'agent: spawn throws for a folder whose name throws', edits: [e(RT, "failFast('could not start the command: ' + messageOf(e));", "throw e;")], tests: ['shell-runtime-agent'] },

	// ---- notes that carry a name
	{ name: 'notes: the relocation note passes the folder\'s root', edits: [e(RT, "', not at ' + forNote(m.root) + ': '", "', not at ' + m.root + ': '")], tests: ['shell-runtime'] },
	// (forNote(m.mount) in the same note has no mutation: a relocated mount is /mnt/<slug> and the slug is [a-z0-9._-], so
	// there is nothing in it to show; it is wrapped like every other name so that changing the slug cannot open a hole)
	{ name: 'notes: the relocation note passes the folder\'s name', edits: [e(RT, "note('The folder \"' + forNote(m.name) + '\" is mounted at '", "note('The folder \"' + m.name + '\" is mounted at '")], tests: ['shell-runtime'] },
	{ name: 'notes: the cwd-gone note passes the cwd', edits: [e(RT, "lead.push(note(forNote(cwd) + ' is gone", "lead.push(note(cwd + ' is gone")], tests: ['shell-runtime-session'] },
	{ name: 'notes: the cwd-gone note passes the folder it starts in', edits: [e(RT, "starting in ' + forNote(to)));", "starting in ' + to));")], tests: ['shell-runtime-session'] },
	{ name: 'notes: a conflict path is passed', edits: [e(CM, "const p = forNote(c.path);\n\t\ttry {", "const p = c.path;\n\t\ttry {")], tests: ['shell-commit'] },
	{ name: 'notes: a provider\'s message is passed on to the engine unprinted (messageOf)', edits: [e(RT, "function messageOf(e) { return forNote((e && /** @type {any} */ (e).message) || e).slice(0, 200); }", "function messageOf(e) { return String((e && /** @type {any} */ (e).message) || e).slice(0, 200); }")], tests: ['shell-runtime', 'shell-runtime-agent'] },
	{ name: 'notes: the case-only refusal does not say why it is conservative', edits: [e(CM, "and this shell cannot tell which kind of disk the folder is on, so it refuses on every one'", "and nothing more'")], tests: ['shell-commit'] },

	// ---- sanitize: format characters, joiners of scripts, totality
	{ name: 'sanitize: format characters (Cf) are not hazards', edits: [e(SZ, "const HAZARD = /[\\p{Cc}\\p{Cf}\\p{Default_Ignorable_Code_Point}", "const HAZARD = /[\\p{Cc}\\p{Default_Ignorable_Code_Point}")], tests: ['shell-sanitize'] },
	{ name: 'sanitize: a joiner between any two letters is drawn', edits: [e(SZ, "return JOINER_SCRIPTS.some((script) => script.test(left) && script.test(right));", "return true;")], tests: ['shell-sanitize'] },
	{ name: 'sanitize: a joiner needs only one side to be a letter of the script', edits: [e(SZ, "if (!LETTER_OR_MARK.test(left) || !LETTER_OR_MARK.test(right)) { return false; }", "if (!LETTER_OR_MARK.test(left) && !LETTER_OR_MARK.test(right)) { return false; }")], tests: ['shell-sanitize'] },
	{ name: 'sanitize: a joiner may have two different scripts around it', edits: [e(SZ, "return JOINER_SCRIPTS.some((script) => script.test(left) && script.test(right));", "return JOINER_SCRIPTS.some((script) => script.test(left)) && JOINER_SCRIPTS.some((script) => script.test(right));")], tests: ['shell-sanitize'] },
	{ name: 'sanitize: Hebrew is a script that is written with joiners', edits: [e(SZ, "const JOINER_SCRIPTS = [\n", "const JOINER_SCRIPTS = [\n\t/^\\p{Script_Extensions=Hebrew}$/u,\n")], tests: ['shell-sanitize'] },
	{ name: 'sanitize: every format character is a joiner in script (not just ZWNJ and ZWJ)', edits: [e(SZ, "if (cp !== 0x200C && cp !== 0x200D) { return false; }", '')], tests: ['shell-sanitize'] },
	{ name: 'sanitize: forDisplay draws the joiners of scripts', edits: [e(SZ, "\treturn textOf(text).replace(HAZARD, (ch) => {\n\t\tconst cp = /** @type {number} */ (ch.codePointAt(0));\n\t\tif (cp === 0x0A || cp === 0x09) { return ch; }", "\treturn textOf(text).replace(HAZARD, (ch, i, whole) => {\n\t\tconst cp = /** @type {number} */ (ch.codePointAt(0));\n\t\tif (joinsScript(whole, i, cp)) { return ch; }\n\t\tif (cp === 0x0A || cp === 0x09) { return ch; }")], tests: ['shell-sanitize'] },
	{ name: 'sanitize: a value with no text throws', edits: [e(SZ, "try { return String(value); } catch { return '[unprintable value]'; }", "return String(value);")], tests: ['shell-sanitize'] },
	{ name: 'sanitize: a value with no text is nothing', edits: [e(SZ, "catch { return '[unprintable value]'; }", "catch { return ''; }")], tests: ['shell-sanitize', 'shell-runtime-agent'] },

	// ---- properties the first round left unpinned (the verifier's survivors)
	{ name: 'paths: no length cap', edits: [e(RT, "p.length > 4096 || ", "")], tests: ['shell-runtime'] },
	{ name: 'paths: the cap is one too many', edits: [e(RT, "p.length > 4096 || ", "p.length > 4097 || ")], tests: ['shell-runtime'] },
	{ name: 'errors: NoModificationAllowedError is not EACCES', edits: [e(RT, " || n === 'NoModificationAllowedError'", "")], tests: ['shell-runtime'] },
	{ name: 'read: a directory is read as a file when the provider lets it', edits: [e(RT, "\t\tif ((s.type & DIR) !== 0) { throw fsError('EISDIR'); }\n", '')], tests: ['shell-runtime'] },
	{ name: 'errors: unclassified provider text is not trimmed', edits: [e(RT, "forNote((e && e.message) || e).slice(0, 160) };", "forNote((e && e.message) || e) };")], tests: ['shell-runtime'] },
	{ name: 'errors: a failure message is not trimmed', edits: [e(RT, "forNote((e && /** @type {any} */ (e).message) || e).slice(0, 200); }", "forNote((e && /** @type {any} */ (e).message) || e); }")], tests: ['shell-runtime'] },
	{ name: 'notes: the number of the engine\'s notes is not bounded', edits: [e(RT, ".slice(0, MAX_NOTES).map((n) => {", ".map((n) => {")], tests: ['shell-runtime-commit'] },
	{ name: 'notes: the length of a note is not bounded', edits: [e(RT, "const t = forNote(n.slice(0, MAX_NOTE_LENGTH));", "const t = forNote(n);")], tests: ['shell-runtime-commit'] },
	{ name: 'notes: an engine note that looks framed is framed again', edits: [e(RT, "return t[0] === '[' ? t : note(t);", "return note(t);")], tests: ['shell-runtime-commit'] },
	{ name: 'session: the cwd of the engine\'s answer is not normalised', edits: [e(RT, "const cwd = normalizePath(msg.cwd) || run.cwd;", "const cwd = msg.cwd || run.cwd;")], tests: ['shell-runtime-commit'] },
	{ name: 'child: an empty chunk is delivered (mirror and terminal)', edits: [e(RT, "|| typeof msg.text !== 'string' || msg.text === '') { return; }", "|| typeof msg.text !== 'string') { return; }")], tests: ['shell-runtime'] },
	{ name: 'commit: ENOTDIR on stat is a conflict, not "nothing there"', edits: [e(RT, "if (c === 'ENOENT' || c === 'ENOTDIR') { return null; } throw e;", "if (c === 'ENOENT') { return null; } throw e;")], tests: ['shell-runtime-commit'] },
	{ name: 'commit.js: a delete with a `before` that is not bytes is accepted', edits: [e(CM, "} else if (c.kind === 'delete' && !(c.before === null || c.before instanceof Uint8Array)) {\n\t\t\tout.push('the entry for ' + p + ' is malformed');\n\t\t}", "}")], tests: ['shell-commit'] },
	{ name: 'session: ~ is completed as a folder name', edits: [e(RT, "if (prefix[0] === '~') { return []; }", "")], tests: ['shell-runtime-session'] },
	{ name: 'lifecycle: a run stopped while its worker is handed over still posts its script and starts a deadline timer', edits: [e(RT, "if (run.state === 'settled') { return; }   // stopped while the engine was starting", "")], tests: ['shell-runtime'] },
	{ name: 'lifecycle: the agent pool takes the OLDEST idle worker', edits: [e(RT, "(!rec || r.lastUsed > rec.lastUsed)) { rec = r; }", "(!rec || r.lastUsed < rec.lastUsed)) { rec = r; }")], tests: ['shell-runtime-agent'] },
	{ name: 'lifecycle: a second kill while committing changes the signal', edits: [e(RT, "\t\tif (run.killed) { return true; }\n", "")], tests: ['shell-runtime-commit'] },
	{ name: 'extension: the Output channel has no bound', edits: [e(EX, "if (QUIET.has(event) || lines >= MAX_LOG_LINES) { return; }", "if (QUIET.has(event)) { return; }")], tests: ['shell-runtime-extension'] },
	{ name: 'extension: routine events (a worker started, a worker stopped) are written to the channel', edits: [e(EX, "if (QUIET.has(event) || lines >= MAX_LOG_LINES) { return; }", "if (lines >= MAX_LOG_LINES) { return; }")], tests: ['shell-runtime-extension'] },
	{ name: 'extension: the engine script is decoded as latin1', edits: [e(EX, "new TextDecoder('utf-8').decode(bytes)", "new TextDecoder('latin1').decode(bytes)")], tests: ['shell-runtime-extension'] },

	// ---- a note is one line
	{ name: 'notes: a name in a note may add a line (forNote is forDisplay)', edits: [e(SZ, ".replace(/\\n/g, '\\u{240A}').replace(/\\t/g, '\\u{2409}');", ";")], tests: ['shell-sanitize', 'shell-commit', 'shell-runtime'] },
	{ name: 'review: the review is not given the question "was it stopped?"', edits: [e(RT, "run.commit(handed, { cancelled })", "run.commit(handed)")], tests: ['shell-runtime-commit'] },
	{ name: 'agent: the explanation is cut in the middle of a surrogate pair', edits: [e(RT, "return text.length > max && last >= 0xD800 && last <= 0xDBFF ? t.slice(0, -1) : t;", "return t;")], tests: ['shell-runtime-agent'] },
];
