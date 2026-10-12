// Cases for the sixth round: what the independent check of fix round 4 found, the idioms a model writes every day that
// the check listed (grep -r over dot files, an array element with a default in $(( )), `grep -nA1`, `for x; do`, `--`,
// `-` for standard input, `date +%-d`, `find -exec \;`, `-mtime`, `printf '\"'`, `sort -r -k2n`, `Jul-04-2024`,
// `touch -d '1 day ago'`, the names diff quotes, an unquoted expansion with blanks at its edge). Each against GNU bash
// 5.1 and coreutils 8.32 in the reference container (no TZ: UTC). Same shape as round5.mjs: [name, script, options?],
// run on a bare workspace. No case reads the clock for what it prints: an age is given with `touch -d` and only
// compared (`-nt`, `find -mtime`), a date is anchored (`@N`) or a whole number of hours apart. `export LC_ALL=C` where
// a message is in the case: GNU's curly quotes are not the engine's.
const r = (s, ...v) => String.raw(s, ...v).replaceAll('\\u007b', '{');

export const CASES = [
	// ---- grep -r reads dot entries (only rg skips them); find, du, ls -R -a, tree -a, cp -r never skipped them
	['r6-grep-r-dot-entries', r`mkdir -p .github/w d/.hid; echo name > .github/w/ci.yml; echo name > .env; echo name > d/.hid/x; echo name > d/y; grep -r name . | sort; echo --; grep -r name | sort; echo --; grep -rl name --include='*.yml'; echo --; grep -rc name d | sort; echo --; grep -rn name d/.hid; echo --; grep -R name .github; echo --; grep -rh name | sort | uniq -c`],
	// the one deliberate difference: a folder named .git is not entered by a recursive search (its objects would use the
	// traversal limit up); naming it as an operand searches it
	['r6-grep-r-git-folder', r`mkdir -p .git/o d; echo name > .git/o/obj; echo name > d/y; echo name > .gitignore; grep -r name . | sort; echo --; grep -rl name | sort; echo --; grep -r name .git`],
	['r6-grep-r-git-file', r`echo 'gitdir: name' > .git; mkdir d; echo name > d/y; grep -r name . | sort; grep -rl name | sort`],
	['r6-find-du-tree-cp-dot-entries', r`mkdir -p .github/w d/.hid; echo a > .env; echo b > d/.hid/x; echo c > d/y; find . -type f | sort; du -a . | sort -k2; ls -Ra d | head -20; cp -r d e; find e | sort; rm -r e; ls -A`],

	// ---- an array element with a default inside $(( )): the word-count idiom
	['r6-arith-assoc-default', r`declare -A c; for w in a b a c a; do c[$w]=$(($\u007bc[$w]:-0}+1)); done; echo $\u007bc[a]} $\u007bc[b]} $\u007bc[c]}; k=(); for i in 1 2 1; do k[$i]=$(($\u007bk[$i]:-0}+1)); done; echo $\u007bk[1]} $\u007bk[2]}; w=a; echo $(( $\u007bc[$w]:-0} + $\u007bc[nope]:-10} ))`],
	['r6-arith-default-forms', r`k=(5 6); i=1; echo $(($\u007bk[$i]:-0}+1)) $(($\u007bk[i]:-0}+1)) $(($\u007bk[i+1]:-9}+1)) $(($\u007bk[-1]:-0}+1)); y=5; echo $(($\u007bx:-$y}+1)) $(($\u007bx:-$\u007by}}+1)) $(($\u007bx:-$((y+1))}+1)); echo $(($\u007bx:=7}+1)) $x; z=3; echo $(($\u007bz:+10}+$\u007bw:-1})); a=(5 6); echo $(($\u007ba:-0}+1)) $(($\u007bq:-0}+1))`],
	['r6-arith-assoc-quoted-subscript', r`declare -A m; m[x-y]=4; m["a b"]=8; echo $(($\u007bm[x-y]:-0}+1)); echo $(($\u007bm["a b"]:-0}+1)); k="a b"; echo $(($\u007bm[$k]:-0}+1)) $(($\u007bm[$k]-0}+1)) $(($\u007bm[none]:-100}+1))`],
	['r6-arith-element-assign-and-plus', r`declare -A c; echo $(($\u007bc[q]:=9}+1)); echo $\u007bc[q]}; c[a]=5; echo $(($\u007bc[a]:=9}+1)) $\u007bc[a]}; n[3]=; echo $(($\u007bn[3]-4}+1)) $(($\u007bn[3]:-4}+1)); echo $(($\u007bc[a]:+20}+1))`],

	// ---- a cluster whose last letter takes the value (-nA1, -qn1, -sf1)
	['r6-grep-cluster-value', r`printf 'a\nTODO b\nc\nd\nTODO e\nf\n' > f; grep -nA1 TODO f; echo --; grep -iA1 todo f; echo --; grep -vA1 TODO f; echo --; grep -nB1 TODO f; echo --; grep -nC1 TODO f; echo --; grep -A1 -B1 TODO f; echo --; grep -nC 1 TODO f; echo --; grep -hA1 TODO f; mkdir d; cp f d/f; grep -rnC1 TODO d; grep -nm1 TODO f; grep -cm1 TODO f`],
	['r6-head-tail-cluster-value', r`printf 'a\nb\nc\n' > f; printf 'x\ny\nz\n' > g; head -qn1 f g; head -vn1 f; tail -qn1 f g; tail -vn1 f; head -qc2 f g | od -c; tail -qc2 f g | od -c`],
	['r6-cut-cluster-value', r`printf 'a:b:c\nd e\nf:g:h\n' > f; cut -sf1 -d: f; cut -d: -sf1 f; cut -sd: -f1 f; cut -nc1-3 f; cut -sd: -f1,3 f; cut -nsf2 -d: f; cut -c1-2 -n f`],
	['r6-cut-long-options', r`printf 'a b c\nd\n' > f; cut --fields=1 -d' ' f; cut --delimiter=' ' --fields 2 f; cut --characters=1-2 f; cut -s --delimiter=' ' -f1 f; cut --only-delimited -d' ' -f1 f; cut --fields=2 --delimiter=' ' -s f`],
	['r6-paste-delimiter-escapes', r`printf 'a,b\nc,d\n' > f; paste -sd, f; paste -sd'\t' f; paste -d '\n' f f; paste -d'\\' f f; paste -sd'\n' f; paste -d '\t,' f f f; paste --delimiters=, f f; paste -d, - - < f`],
	['r6-awk-attached-v', r`printf 'a:b c\n' > f; awk -F: -vx=1 '{print x, $1}' f; awk -vx=1 -F: 'BEGIN{print x}'; awk -vOFS=- -F: '{print $1,$2}' f; awk -vx=1 -vy=2 'BEGIN{print x+y}'; awk -v x=3 -vy=4 'BEGIN{print x*y}'`],
	['r6-date-basename-cluster-value', r`printf x > f; touch -d @86400 f; TZ=UTC date -ur f +%F; TZ=UTC date -uIminutes -d @0; TZ=UTC date -ud '2024-03-05 10:00' '+%a %-d'; TZ=UTC date -Iseconds -ud @0; basename -as .js a.js b.js; basename -s.js a.js; basename -zs .js a.js | od -c | head -1; basename -as.js p.js`],
	['r6-touch-cluster-value', r`touch -ct 202001010000 nosuch; ls; touch -t 202001010000 e; touch -cd '2021-03-04 05:06:07' e; stat -c %y e; touch -ad '2022-01-01' e; stat -c %y e`],

	// ---- for x; do (no `in`): the positional parameters as they are
	['r6-for-no-in', r`set -- "a b" c; for x; do echo "<$x>"; done; k() { for a; do echo "<$a>"; done; }; k "p q" r; k; k ""; set -- "" a ""; for x; do echo "[$x]"; done; for x do echo "{$x}"; done; set -- x y; for v; do set -- 1 2 3; echo $v; done; set --; for z; do echo no; done; echo done`],

	// ---- -- ends the options
	['r6-double-dash-readers', r`printf 'a:b:c\nd e\n' > f; head -n1 -- f; tail -n1 -- f; cut -c1 -- f; sed -n 1p -- f; tac -- f; md5sum -- f; sha1sum -- f; sha256sum -- f; file -- f; comm -- f f; cmp -- f f; echo rc=$?; basename -- a/b.js .js; dirname -- a/b; env -- echo hi; TZ=UTC date -u -d @0 -- +%Y`],
	['r6-double-dash-env-date-operands', r`env -- true; echo rc=$?; env -i -- printf '%s\n' -x -y; env -- printf '%s\n' -z`],
	['r6-double-dash-dash-names', r`printf 'b\na\n' > f; cp f -- -x; ls; head -n1 -- -x; cat -- -x; sort -- -x; wc -l -- -x; grep -- b -x; sed -n -- 1p -x; cut -c1 -- -x; tac -- -x; tail -- -x; nl -- -x; od -c -- -x | head -1; rm -- -x; ls`],

	// ---- - is standard input as an operand
	['r6-stdin-operand-first-and-last', r`printf 'b\na\nc\n' > f; printf 'z\ny\n' > g; cat f | sort - g; cat f | sort g -; cat f | cut -c1 - g; cat f | cut -c1 g -; cat f | tac - g; cat f | tac g -; cat f | nl - g; cat f | nl g -; cat f | head -n1 - g; cat f | tail -n1 - g; cat f | tail -n1 g -`],
	['r6-stdin-operand-alone', r`printf 'b\na\nc\n' > f; cat f | sort -; cat f | cut -c1 -; cat f | tac -; cat f | head -n 2 -; cat f | tail -n1 -; cat f | nl -; cat f | awk '{print}' -; cat f | fold -; cat f | expand -; cat f | wc -l -; cat f | cat -n -`],
	['r6-stdin-operand-twice', r`printf 'b\na\nc\n' > f; cat f | cat - -; cat f | cat -n - -; cat f | sort - -; cat f | cut -c1 - -; cat f | nl - -; cat f | awk '{print}' - -; cat f | head -n2 - -`],
	['r6-stdin-operand-counts-and-sums', r`printf 'b\na\nc\n' > f; cat f | wc - -; cat f | wc -l - -; cat f | md5sum - -; cat f | sha256sum - - | cut -c1-20; cat f | od -c - -; cat f | wc -; cat f | wc - f; cat f | wc f -; cat f | wc -c - -; cat f | wc -lw - - f`],
	['r6-jq-csv-sh-formats', r`echo '[["a,b","c",1,null,true,"x\"y","it'"'"'s"]]' | jq -r '.[] | @csv'; echo '[["a b","c d",1,null,true,"it'"'"'s"]]' | jq -r '.[] | @sh'; echo '"x y"' | jq -r '@sh'; echo '5' | jq -r '@sh'; echo '["a","b"]' | jq -r '@csv'; echo '[1,2]' | jq -r '@csv'; echo '[[1,2]]' | jq -r '.[] | @sh'`],
	['r6-basename-dirname-edges', r`basename /; basename //; basename a/b/; basename ''; basename a//; basename -a / a/; dirname /; dirname //; dirname a//b//; dirname a/b/; dirname a; dirname .; dirname ''; dirname a/b c/d; dirname /a; dirname /a/; basename a.js .js; basename .js .js; basename a.js a.js; basename -s .js -a a.js x.js; basename --suffix=.js a.js; dirname -z a/b | od -c | head -1`],
	['r6-stat-long-format', r`mkdir src; echo 1 > f; stat --format=%F src; stat --format=%s f; stat --format %n f; stat -c %F f; stat --format='%F %s' src f`],
	['r6-grep-r-missing-operand', r`export LC_ALL=C; echo x > f; mkdir d; echo x > d/g; grep -r TODO nosuch; echo rc=$?; grep -r x nosuch f; echo rc=$?; grep -rl x nosuch .; echo rc=$?; grep -rq x nosuch f; echo rc=$?; grep -rs x nosuch f; echo rc=$?; grep -rc x f nosuch d; echo rc=$?; grep -r x d nosuch nosuch2; echo rc=$?; grep -rh x nosuch d; echo rc=$?; grep -rL zzz nosuch f; echo rc=$?`],
	['r6-grep-label', r`echo a > f; grep --label=X -H a < f; grep --label X -c a < f; echo a | grep --label=in -H a; echo a | grep -H a; echo a | grep --label=in a`],
	['r6-diff-i-ascii-only', r`printf 'é\n' > a; printf 'É\n' > b; diff -i a b; echo rc=$?; printf 'ABC\n' > c; printf 'abc\n' > d; diff -i c d; echo rc=$?; diff -qi c d; echo rc=$?`],
	['r6-diff-x-globs', r`mkdir d1 d2; echo 1 > d1/x.o; echo 2 > d2/x.o; echo 1 > d1/y.c; echo 2 > d2/y.c; echo 1 > d1/z1; echo 2 > d2/z1; diff -r -x '*.o' d1 d2; echo rc=$?; diff -rq -x '*.[oc]' -x 'z?' d1 d2; echo rc=$?; diff -rq -x '[!z]*' d1 d2; echo rc=$?; diff -rq -x 'x.[a-z]' d1 d2; echo rc=$?; diff -rq -x '*' d1 d2; echo rc=$?; diff -rq -x 'y\.c' d1 d2; echo rc=$?; diff -rq -x '[z-a]' d1 d2; echo rc=$?; : > d1/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaac; : > d2/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaac; diff -rq -x 'a*a*a*a*a*a*a*a*a*a*a*a*b' d1 d2 | head -3`],
	['r6-date-count-out-of-range', r`export LC_ALL=C; TZ=UTC date -d '2024-01-01 +9999999999 years' +%F; echo rc=$?; TZ=UTC date -d '99999999999 Mon' +%F; echo rc=$?; TZ=UTC date -d '2024-01-01 +100 years' +%F; echo rc=$?`],
	['r6-tac-options', r`export LC_ALL=C; printf 'a\nb\nc\n' > f; printf 'x\ny' > g; tac f; tac g; echo; tac -s: f; printf 'a:b:c' | tac -s:; echo; printf 'a:b:c:' | tac -s :; echo; printf 'a\nb\n' | tac -b | od -c | head -2; printf 'a,b;c' | tac -r -s '[,;]'; echo; tac -a f; echo rc=$?; tac --before f | od -c | head -1; tac nosuch f; echo rc=$?; mkdir d; tac d; echo rc=$?; printf 'one\ntwo\n' | tac -; printf '' | tac | od -c; printf 'ab' | tac -s ab | od -c; tac --separator=: f | od -c | head -2; tac -sx f | od -c | head -2; tac -s '' f | od -c | head -2; printf 'a\0b\0' | tac -s '' | od -c | head -2; tac --bef f | od -c | head -1; tac --regex=1 f; echo rc=$?`],
	['r6-tac-more-than-one-file', r`export LC_ALL=C; printf 'b\na\n' > f; printf 'z\ny\n' > g; tac f g; tac g f; tac f nosuch g; echo rc=$?`],

	// ---- strftime flags and widths (date and printf %(...)T)
	['r6-date-flags-numbers', r`for d in 2024-03-05 2024-11-30 '2024-07-04 15:07:09' '2024-01-01 00:00:00' '2024-12-31 23:59:59'; do TZ=UTC date -d "$d" '+%-d/%-m/%y|%_d|%_m|%5Y|%010d|%-H|%-I|%e|%k|%l|%-j|%_j|%03e|%-e|%_H|%-M|%-S|%-y|%C|%-C|%u|%w|%U|%-U|%V|%G|%g|%s|%3N|%N'; done`],
	['r6-date-flags-text', r`for d in 2024-03-05 '2024-07-04 15:07:09' '2024-12-31 23:59:59'; do TZ=UTC date -d "$d" '+%^a|%^B|%^b|%^A|%#a|%P|%Z|%#p|%#Z|%^p|%10A|%-10A|%010A|%5%|%-d%%|%^c|%^r|%Ey|%Od|%Ex|%EY'; done`],
	['r6-date-flags-grid', r`for f in %-d %_5d %05d %-5d %_-5d %-_5d %^5a %^-5a %#b %#B %#A %-I %-l %_I %0e %0k %6a %06a %-6a %3S %-3S %_3S %3u %3j %-3j %4C %3y %1Y %2Y %3Y %6Y %-6Y %_6Y %+6Y %+Y %E %F %5F %-F %T %^T %10T %R %D %x %X %c %5N %2N %0N; do TZ=UTC date -d @1709600000 "+[$f]"; done`],
	['r6-date-colon-z', r`for z in UTC Asia/Kolkata America/New_York America/St_Johns Pacific/Honolulu; do TZ=$z date -d @1709600000 '+%z %:z %::z %:::z'; done; TZ=America/New_York date -d '2024-07-04 05:06:07' '+%z %:z %Z'`],
	['r6-printf-strftime-flags', r`printf '%(%-d %-m %_d %^a %5Y %010d %e %k %l %P %Z)T\n' 1709600000 1720105629; TZ=Asia/Tokyo printf '%(%-H:%-M %:z)T\n' 1709600000`],

	// ---- find -exec ... \; leaves find's status alone; -exec ... + is 1 when a run failed
	['r6-find-exec-status', r`echo a > f; echo b > g; find . -name '*.md' -exec grep -l Guide {} \; ; echo rc=$?; find . -type f -exec false {} \; ; echo rc=$?; find . -type f -exec grep -q zzz {} \; ; echo rc=$?; find . -type f -exec grep -q zzz {} + ; echo rc=$?; find . -type f -exec true {} + ; echo rc=$?; find . -type f -exec grep -q a {} + ; echo rc=$?; find . -type f -exec sh -c 'exit 3' sh {} + ; echo rc=$?; find . -type f -exec sh -c 'exit 3' sh {} \; ; echo rc=$?; find . -type f -exec grep -q a {} \; && echo yes; set -e; find . -type f -exec false {} \; ; echo still-here`],
	['r6-find-mtime-days', r`echo a > n0; touch -d '2 hours ago' h2; touch -d '25 hours ago' d1; touch -d '36 hours ago' d15; touch -d '49 hours ago' d2; touch -d '10 days ago' d10; touch -d '10 hours' fut; for p in 0 +0 -1 1 +1 -2 2 +2 9 +9 10 +10 -11; do echo "mtime $p: $(find . -type f -mtime $p | sort | tr '\n' ' ')"; done`],
	['r6-find-mmin', r`echo a > n0; touch -d '30 seconds ago' s30; touch -d '61 seconds ago' s61; touch -d '5 hours ago' h5; touch -d '2 days ago' d2; for p in +0 -1 1 -2 2 +1 -5 +5 -60 +60 +299 -301 301; do echo "mmin $p: $(find . -type f -mmin $p | sort | tr '\n' ' ')"; done; find . -type f -amin +100 | sort; find . -type f -atime +1 | sort`],
	['r6-find-time-arg-errors', r`export LC_ALL=C; find . -mtime; echo rc=$?; find . -mmin abc; echo rc=$?; find . -mmin -1x; echo rc=$?`],

	// ---- printf: \" and \? in the format
	['r6-printf-quote-escapes', r`printf 'a\"b\n'; printf 'q\?x\n'; printf '{\"a\": 1}\n'; printf '\\\"x\\\"\n'; printf '%b\n' 'a\"b' 'q\?x'; printf "\"%s\"\n" a; printf 'x\qy\n'; printf '\"%s\" and \"%s\"\n' 1 2; printf '%s\n' $'a\"b' $'q\?x' $'a\'b'; printf 'a\'"'"'b\n'`],

	// ---- sort: the global options belong to a key only when it has none of its own
	['r6-sort-global-and-key-letters', r`printf 'b 3\na 10\nc 1\n' | sort -r -k2n; echo --; printf 'b 3\na 10\nc 1\n' | sort -n -k1,1r; echo --; printf 'b 3\na 10\nc 1\n' | sort -n -k2b; echo --; printf 'b 3\na 10\nc 1\n' | sort -r -k1d; echo --; printf 'b 3\na 10\nc 1\n' | sort -n -k1f; echo --; printf 'b 3\na 3\nc 1\nd 3\n' | sort -u -k2nr,2; echo --; printf 'x 1\nX 1\ny 2\n' | sort -f -k1,1 -k2n`],
	['r6-sort-last-resort', r`printf 'a 1\nb 1\nc 1\n' | sort -s -r -k2,2; echo --; printf 'a 1\nb 1\nc 1\n' | sort -r -k2,2; echo --; printf 'a 1\nb 1\nc 1\n' | sort -rs -k2,2n; echo --; printf 'a 1\nb 1\nc 1\n' | sort -ru -k2,2n; echo --; printf 'a 1\nb 1\nc 1\n' | sort -k2n -r; echo --; printf 'a 1\nb 1\nc 1\n' | sort -r -k2,2n; echo --; printf 'b,2\na,1\nc,2\n' | sort -t, -nk2 -r; printf 'b,2\na,1\nc,2\n' | sort -t, -rk2; printf 'b,2\na,1\nc,2\n' | sort -t, -k2,2nr`],
	['r6-sort-key-letters-the-engine-lacks', r`printf '5 a\n10 b\n' | sort -n -k2g; printf '3 x\n10 x\n9 x\n' | sort -n -k2,2g; printf '3 x\n10 x\n9 x\n' | sort -r -k2,2g`],
	['r6-sort-numeric-reading', r`printf '1e2\n+4\n5\n-3\n 7\n.5\n3.\n-\n0x10\n1,000\nabc\n' | sort -n; echo --; printf '1e2\n+4\n5\n-3\n' | sort -nr; echo --; printf '10\n9\n2\n1\n' | sort -n | head -2; printf '1.5\n1.25\n1.05\n-0.5\n' | sort -n`],

	// ---- date -d Mon-DD-YYYY (the grammar's tMONTH tSNUMBER tSNUMBER)
	['r6-date-mon-dd-yyyy', r`for d in Jul-04-2024 Jul-4-2024 July-4-2024 jul-04-24 Dec-31-2024 Feb-29-2024 Sep-1-2024 'Jul-04-2024 10:00' '10:00 Jul-04-2024' 'Jul-04-2024 +1 day' 'Jul-04-2024 next week' 'Jul-04-2024 10:00:30 EST' Jul-04-99 Jul-04-69 Jul-04-68 Jul-04-100 Jul-04-20; do TZ=UTC date -d "$d" '+%F %T'; done; export LC_ALL=C; for d in Jul-04 Jul-04- Jul-04-2024-05 'Jul 04-2024' 'Jul-04 2024' Jul-4,2024 Jul-32-2024 2024-Jul-04 Jul-0-2024; do TZ=UTC date -d "$d" '+%F' 2>&1; done`],

	// ---- touch -d with the whole grammar of date -d, and -r with a relative -d
	['r6-touch-date-relative', r`touch -d '1 day ago' a; touch -d yesterday b; touch -d 'next week' c; touch -d '2 hours ago' f; touch -d 'tomorrow 10:00' g; touch -d '3 days ago 12:00' k; touch -cd '1 day ago' l; [ -e l ] || echo 'no l'; [ a -nt c ] || echo "a older than c"; [ c -nt a ] && echo "c newer than a"; [ f -nt a ] && echo "f newer than a"; [ g -nt f ] && echo "g newer than f"; [ k -nt a ] || echo "k older than a"; echo $(( ($(date +%s) - $(stat -c %Y a)) / 3600 )) $(( ($(date +%s) - $(stat -c %Y f)) / 3600 )) $(( ($(stat -c %Y c) - $(date +%s)) / 86400 ))`],
	['r6-touch-date-anchored', r`touch -d '2024-03-05 +1 week' d; stat -c '%n %Y' d; touch -d '@86400' h; stat -c '%n %Y' h; touch -d '2024-01-02' i; stat -c '%n %Y' i; touch -d '2024-01-02 03:04:05' j; stat -c '%n %Y' j; touch -d '2024-03-05 10:00' x; touch -r x y -d '+1 day'; stat -c '%n %Y' x y; touch -r x z -d 'yesterday'; stat -c '%n %Y' z`],
	['r6-touch-invalid-dates', r`export LC_ALL=C; touch -d 'xyz' m; echo rc=$?; touch -t 2024 q; echo rc=$?; touch -t 1 q; echo rc=$?; touch -t 202401011230.45 ok; stat -c '%n %Y' ok; ls`],

	// ---- diff names with a blank, a quote, a backslash or a tab are in double quotes in the header and the labels
	['r6-diff-quoted-names', r`mkdir d1 d2; for n in 'a b' 'a"b' 'a\b' "a'b" 'a$b' 'a*b' 'a#b' 'a=b' 'a:b' 'a(b' 'a;b' 'a&b' 'a|b' 'a<b' 'a>b' 'a!b' 'a~b' 'a[b' 'a{b' 'a?b' 'a%b' 'a,b' 'a	b' ' lead' 'trail ' 'a^b'; do echo 1 > "d1/$n"; echo 2 > "d2/$n"; done; for n in 'a b' 'a"b' 'a\b' "a'b" 'a$b' 'a*b' 'a#b' 'a=b' 'a:b' 'a(b' 'a;b' 'a&b' 'a|b' 'a<b' 'a>b' 'a!b' 'a~b' 'a[b' 'a{b' 'a?b' 'a%b' 'a,b' 'a	b' ' lead' 'trail ' 'a^b'; do diff -u "d1/$n" "d2/$n" | sed -n 1,2p | sed 's/\t.*//'; done`],
	['r6-diff-r-quoted-names', r`mkdir d1 d2; echo 1 > 'd1/a b'; echo 2 > 'd2/a b'; echo x > d1/only; echo y > 'd2/only two'; mkdir 'd1/sub dir' 'd2/sub dir'; diff -r d1 d2; diff -rq d1 d2; diff -rc d1 d2 | sed 's/\t.*//'; diff -ru d1 d2 | sed 's/\t.*//'; diff 'd1/a b' 'd2/a b'; echo rc=$?; diff -s 'd1/a b' 'd1/a b'`],
	['r6-diff-quoted-labels', r`echo 1 > 'a b'; echo 2 > c; diff -u 'a b' c | sed 's/\t.*//'; diff -c 'a b' c | sed 's/\t.*//'; diff 'a b' c; diff --label 'x y' -u 'a b' c | sed 's/\t.*//'; diff -u c 'a b' | head -2 | sed 's/\t.*//'; diff -q 'a b' c; diff -s 'a b' 'a b'`],

	// ---- rm: an option the program does not have is said once; cp/mv: the source with a slash is looked at first
	['r6-rm-option-error-once', r`export LC_ALL=C; touch a b c; rm -rvz a b c; echo rc=$?; rm --bogus a b c; echo rc=$?; rm -dz a b c; echo rc=$?; rm -r -v --bogus a b c; echo rc=$?; ls`],
	['r6-cp-mv-file-with-slash-first', r`export LC_ALL=C; echo F > f; cp -v f/ x/../h; echo rc=$?; cp -rv f/ x/../h; echo rc=$?; cp -rn f/ x/../h; echo rc=$?; cp -T f/ x/../h; echo rc=$?; cp -f f/ x/../h; echo rc=$?; cp -u f/ x/../h; echo rc=$?; mv f/ x/../h; echo rc=$?; mv -v f/ x/../h; echo rc=$?; mv -n f/ x/../h; echo rc=$?; mv -T f/ x/../h; echo rc=$?; mv -f f/ x/../h; echo rc=$?; ls`],

	// ---- an unquoted expansion with blanks at its edge, next to a literal or another expansion
	['r6-split-edge-blanks', r`v=" hi"; echo a$v b; echo $v$v; set -- x$v y; echo $#; for i in ec$v; do echo "[$i]"; done; v='hi '; echo a$v b; echo $v$v; set -- x$v y; echo $#; for i in ec$v; do echo "[$i]"; done`],
	['r6-split-edge-command-word', r`v=' ho'; ec$v; echo rc=$?; w=$v; ec$w; echo rc=$?; c=' echo'; x$c; echo rc=$?; d='echo '; $\u007bd}hi`],
	['r6-split-edge-grid', r`v=' a b '; for i in x$v; do echo "[$i]"; done; for i in $v-; do echo "[$i]"; done; for i in x$\u007bv}y; do echo "[$i]"; done; for i in "x"$v; do echo "[$i]"; done; for i in $v"x"; do echo "[$i]"; done; for i in ""$v; do echo "[$i]"; done; v=' '; for i in a$v b; do echo "[$i]"; done; for i in a$\u007bv}b; do echo "[$i]"; done; for i in $v$v; do echo "[$i]"; done; for i in x$v$v y; do echo "[$i]"; done`],
	['r6-split-edge-ifs-and-arrays', r`v="a:b"; IFS=:; for i in x$v y; do echo "[$i]"; done; for i in x$\u007bv}:; do echo "[$i]"; done; v=":a:"; for i in x$v y; do echo "[$i]"; done; for i in $v$v; do echo "[$i]"; done; unset IFS; v=" hi"; a=(a$v b); echo $\u007b#a[@]}; x=a$v; echo "[$x]"; echo "a$v"b; echo 'a'$v; echo $v'a'; echo $\u007bv}$\u007bv}x; set -- $v$v; echo $#; case a$v in "a hi") echo m;; *) echo n;; esac; w=" x  y "; echo [$w$w]; echo a$w$w; echo $(echo " p  q ")r; echo r$(echo " p  q "); echo -$w-`],

	// ---- tee: a name that cannot be written as typed
	['r6-tee-slash-names', r`export LC_ALL=C; echo f > f; mkdir d; echo hi | tee 'x/../n'; echo rc=$?; echo hi | tee 'n/'; echo rc=$?; echo hi | tee 'f/'; echo rc=$?; echo hi | tee d; echo rc=$?; echo hi | tee d/; echo rc=$?; echo hi | tee -a 'f/'; echo rc=$?; echo hi | tee ok d/in; echo rc=$?; echo hi | tee nodir/x; echo rc=$?; ls; cat f`],

	// ---- grep -m and -c
	['r6-grep-m-count', r`printf 'a\nb\na\na\n' > f; printf 'a\n' > g; grep -m1 -c a f; grep -cm2 a f g; grep -m0 a f; echo rc=$?; grep -c -m0 a f; echo rc=$?; grep -m1 a f; grep -m2 -n a f; grep -cm10 a f; grep -vcm1 a f; grep -c -m 3 -H a f; cat f | grep -c -m1 a`],
];
