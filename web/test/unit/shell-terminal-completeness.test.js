/*---------------------------------------------------------------------------------------------
 *  LevelCode Shell terminal: is this line a whole command? - run: node web/test/unit/shell-terminal-completeness.test.js
 *
 *  completeness.js is the only implementation there is: the browser build of just-bash has no parse export, and the
 *  Node build's parse() accepts a trailing backslash, an unterminated here-document and a trailing `|` or `&&`.
 *  What matters is the cost of a wrong answer. "Incomplete" for a line that is whole leaves the visitor at a `>`
 *  prompt that only Ctrl+C leaves; "complete" for a line that is not just runs it and the engine reports the syntax
 *  error. So the table is mostly traps for the first mistake, and every doubtful case is pinned as complete.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

const assert = require('assert');
const path = require('path');

const { isComplete } = require(path.join(__dirname, '..', '..', 'shell', 'src', 'terminal', 'completeness.js'));

const queue = [];
const test = (name, fn) => queue.push([name, fn]);

/** @param {string[]} sources @param {boolean} complete */
function all(sources, complete) {
	for (const src of sources) {
		const r = isComplete(src);
		assert.strictEqual(r.complete, complete, JSON.stringify(src) + ' -> ' + JSON.stringify(r));
	}
}
const reasons = (pairs) => {
	for (const [src, reason] of pairs) {
		const r = isComplete(src);
		assert.deepStrictEqual(r, { complete: false, reason }, JSON.stringify(src));
	}
};

test('plain lines, comments and blank lines are complete', () => {
	all(['', '   ', '\n', 'echo hi', 'ls -la | grep x | wc -l', 'a && b || c', '# a comment', "echo a # it's a comment", 'echo a\necho b', 'cd /tmp; ls', 'ls &', 'ls ;', 'x=1 y=2 env'], true);
});

test('quotes: every trap that looks like an unterminated quote and is not', () => {
	all([
		'echo "it\'s"',            // a ' inside "..."
		'echo \'say "hi"\'',       // a " inside '...'
		"echo \\'",                // an escaped quote
		"echo it\\'s",
		'echo \\"',
		"echo '\\'",               // backslash is literal inside single quotes: 'echo \' is closed
		'echo "a\\\\"',            // an escaped backslash, then the closing quote
		"echo $'it\\'s'",          // ANSI-C quoting: \' does not end it
		'echo "$"',                // a dollar right before the closing quote
		'echo "\'"', 'echo \'"\'',
		'if [ "$x" = "\'" ]; then echo; fi',
		'echo "${x:-\'}"',         // a single quote inside a double-quoted expansion is a character
		'echo "a${x:-"b"}c"',
		'echo "a $(echo ")") b"', 'echo $(echo "(")', "echo '$('", "echo '`'",
		'# it\'s not a quote',
	], true);
});

test('quotes: the ones that are open', () => {
	reasons([
		['echo "a', 'dquote'], ["echo 'a", 'quote'], ['echo "a\n', 'dquote'], ["echo '\n", 'quote'],
		['echo "a\\"', 'dquote'],             // the backslash escapes the closing quote
		["echo $'a", 'quote'],
		['echo `', 'backtick'], ['echo $(', 'subst'], ['echo "$(', 'subst'], ['echo $(echo a', 'subst'],
		['echo ${x', 'param'], ['echo $((1+2', 'arith'], ['echo $((1+2)', 'subst'],
	]);
	all(['echo `ls`', 'echo $((1+2))', 'echo ${x:-}', 'echo "`ls`"', 'echo $(echo $(echo a))'], true);
});

test('comments and special parameters: # starts a comment only at the start of a word', () => {
	all(['echo a#b', 'echo $#', 'echo ${#x}', 'echo "${#x}"', 'echo ${x:-#}', 'echo $((1#0))', 'echo a "#" b', "echo a '#' b", 'echo a \\# b', 'echo #'], true);
	all(['echo a # "unterminated', "echo a # 'unterminated", 'echo a # $(', 'echo a # `'], true);
	// and what follows a # inside a word is still code: the quote is open
	reasons([['echo a#b "x', 'dquote'], ["echo $#'x", 'quote'], ['echo ${#x} "x', 'dquote'], ['echo $# `x', 'backtick']]);
});

test('backslash: a trailing one wants more; a backslash-newline does not at the end', () => {
	reasons([['echo hi \\', 'backslash'], ['echo hi\\', 'backslash'], ['echo a \\\n b \\', 'backslash']]);
	all(['echo hi \\\n', 'echo hi \\\n there', 'echo a\\\\', 'echo ab\\ cd'], true);
});

test('operators: a trailing pipe, && or || wants a command; || as the middle of a line does not', () => {
	reasons([['ls |', 'operator'], ['ls | ', 'operator'], ['ls &&', 'operator'], ['ls ||', 'operator'], ['ls |&', 'operator'], ['a &&\n', 'operator'], ['a |\n\n', 'operator'], ['a && # c', 'operator']]);
	all(['a || b', 'a | b', 'a && b', 'a &', 'a ;', 'a ; b', 'a |\nb', 'echo "a ||"', 'echo a \\| b'], true);
});

test('here-documents: open until the delimiter, quoted or not, <<- strips tabs, several on one line, not a here-string', () => {
	reasons([
		['cat <<EOF', 'heredoc'], ['cat <<EOF\n', 'heredoc'], ['cat <<EOF\nhi', 'heredoc'], ["cat <<'EOF'\nx\n", 'heredoc'], ['cat <<"EOF"\nx', 'heredoc'],
		['cat <<-EOF\n\thi\n', 'heredoc'], ['cat <<A <<B\n1\nA\n2\n', 'heredoc'], ['cat <<EOF | grep x\nhi\n', 'heredoc'],
		['a=$(cat <<EOF\nhi\nEOF\n', 'subst'],
	]);
	all([
		'cat <<EOF\nhi\nEOF', 'cat <<EOF\nhi\nEOF\n', 'cat <<EOF\n\nEOF', "cat <<'EOF'\n$x \"y\n'\nEOF", 'cat <<"EOF"\nx\nEOF',
		'cat <<-EOF\n\thi\n\tEOF', 'cat <<A <<B\n1\nA\n2\nB', 'cat <<EOF | grep x\nhi\nEOF', 'cat << EOF\nhi\nEOF',
		"cat <<EOF\nit's\n\"open\nEOF",                 // a quote inside the body is not a quote
		'cat <<E"O"F\nx\nEOF',                          // a quoted part of the delimiter still makes it EOF
		'echo <<<"here string"', 'echo "<<EOF"', 'echo a \\<<EOF', 'echo foo # <<EOF', 'x=$(cat <<EOF\nhi\nEOF\n)',
		'echo $((1 << 2))', '(( x = 1 << 2 ))', 'for ((i=1;i<8;i<<=1)); do echo $i; done',
	], true);
});

test('compound commands: open until their closer; a closer that does not match is a syntax error, so complete', () => {
	reasons([
		['if true; then', 'if'], ['if true', 'if'], ['if a; then b; else', 'if'],
		['while true; do', 'loop'], ['for i in 1 2 3; do echo $i', 'loop'], ['until false; do', 'loop'], ['select x in a b; do echo $x', 'loop'],
		['case x in', 'case'], ['case x in a) echo;;', 'case'],
		['{ echo a;', 'brace'], ['{ echo a', 'brace'], ['f() {', 'brace'], ['function f {', 'brace'],
		['(echo a', 'paren'], ['a=(1 2', 'array'], ['[[ a == b', 'cond'],
	]);
	all([
		'if a; then b; elif c; then d; else e; fi', 'if true; then echo "a;b"; fi',
		'for i in 1 2 3; do echo $i; done', 'while read l; do echo "$l"; done < file', 'while true; do break; done',
		'for ((i=0;i<3;i++)); do echo $i; done', 'select x in a b; do echo $x; done',
		'case $x in a) echo 1;; b|c) echo 2;; *) echo 3;; esac', 'case x in (a) echo;; esac', 'case x in a) (echo hi);; esac',
		'f() { echo hi; }', 'function f { echo; }', 'f ()\n{\n echo\n}', '{ echo a; } | cat', '(echo a; echo b)', '( (echo a) | cat )',
		'[[ a == b ]]', '[[ $a =~ ^(a|b)$ ]] && echo y', '[[ a < b ]]', 'arr=(a b c)', 'arr=(if then fi)', 'arr=(\n a\n b\n)',
		'echo {a,b}', 'echo }', 'echo {', 'echo ${arr[@]}', 'echo ${x//a/b}', 'echo $(case x in a) echo;; esac)',
		'if true; then echo $(if false; then :; fi); fi',
	], true);
	// syntax errors the shell reports itself: held back, they would leave the prompt stuck
	all(['fi', 'done', 'esac', '}', ')', 'then', 'echo a; }', 'if x; done', 'while x; fi', 'case x in a) if y; then z;; esac', 'echo ;;', 'echo $(if x; then y; )'], true);
});

test('what a line needs to become complete is what its reason says', () => {
	const closers = { quote: "'", dquote: '"', backtick: '`', subst: ')', arith: '))', param: '}', heredoc: '\nEOF', backslash: ' x', operator: ' b', if: '; fi', loop: '; done', case: '; esac', brace: '; }', paren: ')', array: ')', cond: ' ]]' };
	const open = ["echo 'a", 'echo "a', 'echo `a', 'echo $(a', 'echo $((1', 'echo ${x', 'cat <<EOF\nhi', 'echo \\', 'a &&', 'if a; then b', 'while a; do b', 'case x in a) b', '{ a', '(a', 'x=(a', '[[ a'];
	for (const src of open) {
		const r = isComplete(src);
		assert.strictEqual(r.complete, false, src);
		assert.ok(closers[r.reason] !== undefined, src + ' has an unknown reason ' + r.reason);
		assert.strictEqual(isComplete(src + closers[r.reason]).complete, true, JSON.stringify(src) + ' + ' + JSON.stringify(closers[r.reason]));
	}
});

test('a divergence on purpose: a quote inside "${x:-...}" is a character here, as in bash; the engine reads it as a quote', () => {
	// just-bash's parser says "unexpected EOF while looking for matching `'" for this line. Held back it would leave the
	// visitor stuck; run, the engine reports its own error, which is the better of the two.
	assert.strictEqual(isComplete('echo "${x:-\'}"').complete, true);
});

test('arbitrary text never throws, and a long one is answered quickly (seeded)', () => {
	let seed = 99;
	const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
	const pieces = ['"', "'", '`', '$(', ')', '(', '${', '}', '{', ' ', '\n', '\\', '|', '&&', '||', ';', ';;', '<<EOF', 'EOF', 'if ', 'then ', 'fi', 'do ', 'done', 'case ', 'esac', '#', 'a', '$', '$((', '))', '<<-', '[[', ']]', 'for ', 'while '];
	const t0 = Date.now();
	for (let i = 0; i < 3000; i++) {
		let s = '';
		const n = 1 + Math.floor(rnd() * 30);
		for (let k = 0; k < n; k++) { s += pieces[Math.floor(rnd() * pieces.length)]; }
		const r = isComplete(s);
		assert.ok(typeof r.complete === 'boolean' && typeof r.reason === 'string');
	}
	const big = 'echo "a" | grep b && ls; '.repeat(20000);
	assert.strictEqual(isComplete(big).complete, true);
	assert.ok(Date.now() - t0 < 5000, 'took ' + (Date.now() - t0) + ' ms');
});

(async () => {
	let n = 0;
	for (const [name, fn] of queue) { await fn(); n++; console.log('  ok - ' + name); }
	console.log(`\n${n} tests passed`);
})().catch((e) => { console.error(e); process.exit(1); });
