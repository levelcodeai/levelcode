/*---------------------------------------------------------------------------------------------
 *  LevelCode — AI (M5: diagnostics-driven auto-verify loop)
 *
 *  Pure, vscode-free helpers for the auto-verify loop, so they can be unit-tested with plain
 *  node. The loop itself lives in agent.js (orchestration) and extension.js (vscode glue);
 *  everything that is pure string/decision logic lives here.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

const SEV = ['error', 'warning', 'info', 'hint']; // vscode DiagnosticSeverity: 0=Error … 3=Hint

/** A stable key for "this exact problem already existed before the run" comparison. Position is
 *  deliberately excluded — line/col shift when the agent edits, but the message/severity don't. */
function diagKey(severity, message) { return severity + '\u0000' + String(message == null ? '' : message); }

/**
 * Keep only problems that are NEW vs a pre-run baseline and at/above the severity threshold,
 * formatted for the model as `rel:line:col: sev [source]: message`. Capped so a flood of errors
 * can't blow the transcript.
 * @param {Array<{rel:string, uriKey:string, diags:Array<{severity:number,message:string,source?:string,line:number,character:number}>}>} perFile
 * @param {Map<string, Set<string>>} baseline  uriKey → set of pre-existing diagKey()s
 * @param {boolean} includeWarnings  treat warnings (not just errors) as failures
 * @param {number} [cap=40]
 * @returns {{text:string, count:number}}
 */
function formatDiagnosticLines(perFile, baseline, includeWarnings, cap) {
	cap = cap || 40;
	const maxSev = includeWarnings ? 1 : 0;
	const lines = [];
	let count = 0, truncated = false;
	for (const f of (perFile || [])) {
		const base = baseline.get(f.uriKey) || new Set();
		const fresh = (f.diags || [])
			.filter((d) => d.severity <= maxSev && !base.has(diagKey(d.severity, d.message)))
			.sort((a, b) => (a.line - b.line) || (a.character - b.character));
		for (const d of fresh) {
			if (lines.length >= cap) { truncated = true; break; }
			count++;
			const src = d.source ? ' [' + d.source + ']' : '';
			const msg = String(d.message == null ? '' : d.message).replace(/\s+/g, ' ').trim();
			lines.push(f.rel + ':' + (d.line + 1) + ':' + (d.character + 1) + ': ' + (SEV[d.severity] || 'error') + src + ': ' + msg);
		}
		if (truncated) { break; }
	}
	if (truncated) { lines.push('… (more problems not shown)'); }
	return { text: lines.join('\n'), count };
}

/**
 * Did the verify command fail to even RUN (missing npm script, command-not-found) rather than run and
 * report real failures? Those are CONFIG problems, not the agent's code — we must never loop the agent
 * on them (it would otherwise "fix" verification by mutating the project to make the command exist).
 */
function looksUnrunnable(exitCode, output) {
	if (exitCode === 127) { return true; } // POSIX shells: "command not found"
	return /\bmissing script\b|command not found|: not found\b|no such file or directory|is not recognized as an internal or external command|unknown command|could not determine (an? )?executable|executable not found|\benoent\b/i.test(String(output || ''));
}

/**
 * When the model wants to finish and verification just ran, decide what to do.
 * @returns {'pass'|'fix'|'exhausted'} pass = clean, finish; fix = send it back; exhausted = give up, hand to user.
 */
function verifyOutcome(ok, feedbackUsed, maxRounds) {
	if (ok) { return 'pass'; }
	if (feedbackUsed >= maxRounds) { return 'exhausted'; }
	return 'fix';
}

/**
 * The synthetic user turn fed back to the model when verification fails. A plain string (pushed in
 * the no-tool path, so it never creates a dangling tool_use). Bounds the command tail.
 * @param {{cmdFail:boolean, cmdTail?:string, diag?:{text:string,count:number}}} r
 */
function formatVerifyFeedback(r, round, max, command) {
	const parts = [];
	parts.push('AUTOMATIC VERIFICATION FAILED (round ' + round + ' of ' + max + '). Your edits are applied but not yet correct. Fix the problems below, then finish again with a one-line "Done:" summary — only once everything is clean.');
	if (r.cmdFail) {
		const tail = String(r.cmdTail || '').slice(-4000);
		parts.push('\n● Verify command `' + String(command || '').trim() + '` failed:\n' + (tail || '(no output)'));
	}
	if (r.diag && r.diag.count > 0) {
		parts.push('\n● ' + r.diag.count + ' problem' + (r.diag.count > 1 ? 's' : '') + ' the editor reports in files you changed:\n' + r.diag.text);
	}
	parts.push('\nFix ONLY problems you introduced or that are clearly part of the goal. If a problem is pre-existing and unrelated to your task, do NOT chase it — mention it in one line and finish with "Done:".');
	return parts.join('\n');
}

// --- background command execution: pure sniffers for "what port did the server come up on?" ---------
/** First port a dev server advertises in its output, or null. Localhost/URL-scoped + ordered most-specific
 *  first so a later DB-connection log can't masquerade as the server port. */
function sniffPort(text) {
	const s = String(text == null ? '' : text);
	const m = /https?:\/\/[a-z0-9.\-[\]]*:(\d{2,5})\b/i.exec(s)            // http://localhost:3000
		|| /\b(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]):(\d{2,5})\b/i.exec(s)  // localhost:3000
		|| /\bport[:=\s]+(\d{2,5})\b/i.exec(s)                            // "port 3000" / "port: 3000"
		|| /\blistening on\b[^\n]*?:(\d{2,5})\b/i.exec(s);                // "listening on :3000"
	return m ? m[1] : null;
}
/** Hosts we will point the built-in browser at. See sniffPreviewUrl — this list IS the security bound. */
const LOCAL_HOSTS = /^(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|\[::\])$/i;

/**
 * The LOCAL http(s) address a dev server just advertised, ready to hand to the built-in browser — or
 * null. Used to auto-open a preview when the agent brings a site up.
 *
 * SECURITY — the reason this is not just "find a URL": the input is a command's stdout, i.e. whatever
 * a repo's dev script chose to print. If we opened any URL we found, a hostile repo could aim the
 * editor's browser anywhere simply by logging a line ("Local: http://evil.example.com"). So the host
 * must be LOCAL; a remote URL is ignored, never opened. 0.0.0.0 / [::] are BIND addresses rather than
 * destinations, so they are rewritten to localhost, which is what actually resolves.
 *
 * Prefers a full URL when one is printed (it carries the scheme, port and any base path — Vite and
 * friends print exactly that), and otherwise falls back to the sniffed port on localhost. The fallback
 * can occasionally fire on a non-web port ("listening on port 5432"), which costs the user one tab
 * they close; missing real servers would cost them the whole feature, so it errs toward opening.
 */
function sniffPreviewUrl(text) {
	const s = String(text == null ? '' : text);
	const re = /(https?):\/\/([a-z0-9.\-]+|\[[0-9a-f:]*\]):(\d{2,5})(\/[^\s"'<>)\]]*)?/gi;
	let m;
	while ((m = re.exec(s)) !== null) {
		if (!LOCAL_HOSTS.test(m[2])) { continue; }   // remote → not ours to open
		const host = /^(?:0\.0\.0\.0|\[::\])$/i.test(m[2]) ? 'localhost' : m[2];
		return m[1].toLowerCase() + '://' + host + ':' + m[3] + (m[4] || '');
	}
	// Nothing local was printed as a URL. Before falling back to a bare port, blank out any REMOTE one:
	// sniffPort's first pattern matches any http(s) URL, so it would re-extract the port out of the very
	// address we just refused and we'd open localhost:<their port> — a preview inferred entirely from a
	// line we deliberately ignored. A port with no host attached ("running on port 3000") still counts.
	const localOnly = s.replace(/(https?):\/\/([a-z0-9.\-]+|\[[0-9a-f:]*\]):(\d{2,5})(\/[^\s"'<>)\]]*)?/gi,
		(full, _scheme, host) => (LOCAL_HOSTS.test(host) ? full : ' '));
	const port = sniffPort(localOnly);
	return port ? 'http://localhost:' + port : null;
}

/**
 * Tracks which preview URLs have actually been SHOWN, so the auto-preview opens each address once and
 * never fights the user who closed the tab.
 *
 * The distinction that matters (PR #35 review): a URL counts as shown only when the open SUCCEEDED. An
 * attempt that throws — Simple Browser disabled, or unavailable for a moment — must stay retryable, or
 * one transient failure silently suppresses the preview for the rest of the session and the feature
 * looks broken with nothing to point at. Hence three states rather than a single Set: never-tried,
 * in-flight, shown. In-flight exists because opening is async, so two runs advertising the same address
 * could otherwise both pass the check and stack two tabs.
 */
function createPreviewGate() {
	const shown = new Set();
	const inFlight = new Set();
	return {
		/** May we try to open this URL right now? */
		shouldOpen(url) { return !!url && !shown.has(url) && !inFlight.has(url); },
		begin(url) { inFlight.add(url); },
		/** It really appeared — never open it again, so closing the tab is final. */
		succeeded(url) { inFlight.delete(url); shown.add(url); },
		/** It did NOT appear — forget the attempt entirely so a later run can retry. */
		failed(url) { inFlight.delete(url); },
		clear() { shown.clear(); inFlight.clear(); },
		get size() { return shown.size; }
	};
}

/** Does this output line signal the server/watcher is up and ready? (Used even when no port is found.) */
function looksReady(text) {
	return /\bcompiled successfully\b|\blistening on\b|\bserver (?:is )?(?:running|started|ready)\b|\bwatching for file changes\b|\bready in\b|\bLocal:\s/i.test(String(text == null ? '' : text));
}

module.exports = { SEV, diagKey, formatDiagnosticLines, verifyOutcome, formatVerifyFeedback, looksUnrunnable, sniffPort, sniffPreviewUrl, createPreviewGate, looksReady };
