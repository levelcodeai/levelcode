// The bytes of VS Code's shell integration (OSC 633), and the one place that writes them. Pure.
//
// What the workbench does with them (READ in shellIntegrationAddon.ts, MEASURED in the release build): A/B/C/D/E give
// the command decorations, "recent commands" and the exit status; `P;Cwd=` sets the terminal's cwd. The command line
// (E) and the cwd are only believed when they carry the NONCE the terminal was created with. So:
//   - the nonce is random per terminal, never a constant, never in the environment, never printed;
//   - it appears in exactly two sequences (E and P;Cwd), which only this module writes;
//   - command output never reaches these sequences: the output filter drops every OSC but a link, and the cwd and
//     the command come from the session and the editor, not from anything a program printed.
// @ts-check
'use strict';

const ESC = '\x1b';
const ST = ESC + '\\';
/** A command line longer than this is cut for the sequence: it is for a tooltip and a recent-commands list. */
const MAX_COMMAND = 2048;

/**
 * The workbench's own escaping (serializeVSCodeOscMessage), plus DEL and C1, which xterm treats as controls: a
 * backslash, a semicolon and every character up to space become \xNN, so the value cannot end the field or the string.
 * @param {string} value
 */
function escapeValue(value) {
	return String(value).replace(/[\\;\x00-\x20\x7f-\x9f]/g, (c) => (c === '\\' ? '\\\\' : '\\x' + c.charCodeAt(0).toString(16).padStart(2, '0')));
}

/** @param {string} body */
const osc = (body) => ESC + ']633;' + body + ST;

/**
 * A fresh nonce: 128 random bits as hex. `getRandomValues` is crypto.getRandomValues; it is injected so a test can
 * count the calls, and there is deliberately no fallback to Math.random: a guessable nonce is worth nothing.
 * @param {(a: Uint8Array) => Uint8Array} getRandomValues
 */
function createNonce(getRandomValues) {
	const bytes = getRandomValues(new Uint8Array(16));
	let s = '';
	for (const b of bytes) { s += b.toString(16).padStart(2, '0'); }
	return s;
}

const promptStart = () => osc('A');
const promptEnd = () => osc('B');
const executed = () => osc('C');
/** @param {number} code */
const finished = (code) => osc('D;' + (Number.isFinite(code) ? Math.trunc(code) : 0));
/** @param {string} command @param {string} nonce */
const commandLine = (command, nonce) => osc('E;' + escapeValue(String(command).slice(0, MAX_COMMAND)) + ';' + nonce);
/** @param {string} cwd @param {string} nonce */
const cwd = (cwd, nonce) => osc('P;Cwd=' + escapeValue(cwd) + ';' + nonce);
/** @param {string} name @param {string} value */
const property = (name, value) => osc('P;' + name + '=' + escapeValue(value));

module.exports = { escapeValue, createNonce, promptStart, promptEnd, executed, finished, commandLine, cwd, property, MAX_COMMAND };
