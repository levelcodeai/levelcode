// Cases for the second round: what the independent check of round 1 found wrong, each against GNU bash 5.1 and
// coreutils 8.32 in the reference container (no TZ: UTC). Same shape as extra.mjs: [name, script, options?], run on a
// bare workspace. A file with a byte that is not UTF-8 is made with `base64 -d` (printf escapes make characters here).
const r = (s, ...v) => String.raw(s, ...v).replaceAll('\\u007b', '{');

// caf\xe9\n, a PNG-ish header, a BOM + hi, a NUL in the middle, \xc3\xa9\xff\n
const BIN = r`printf 'Y2Fm6Qo=' | base64 -d > lat; printf 'iVBORw0KGgoAAA1JSERS' | base64 -d > png; printf '77u/aGkK' | base64 -d > bom; printf 'YQBiCg==' | base64 -d > nul; printf 'w6n/Cg==' | base64 -d > two`;

export const CASES = [
	// ---- bytes that are not UTF-8 survive every text path
	['r2-bytes-sed-i', r`${BIN}; sed -i 's/zzz/y/' lat png bom nul two; for f in lat png bom nul two; do od -An -tx1 $f; done`],
	['r2-bytes-sed-i-find', r`${BIN}; find . -type f -exec sed -i 's/foo/bar/g' {} +; for f in lat png two; do od -An -tx1 $f; done`],
	['r2-bytes-tee-sort-o', r`${BIN}; tee t1 < lat > /dev/null; sort -o s1 lat; cat lat | cat > c1; for f in t1 s1 c1; do od -An -tx1 $f; done`],
	['r2-bytes-subst', r`${BIN}; x=$(cat lat); printf '%s\n' "$x" > c2; echo "$(cat two)" > c3; od -An -tx1 c2 c3`],
	['r2-bytes-awk-cut-tr', r`${BIN}; awk '{print}' lat > a1; cut -c1-4 lat > u1; tr a-z A-Z < lat > r1; od -An -tx1 a1 u1 r1`],
	['r2-bytes-paste-tac-uniq', r`${BIN}; paste lat > p1; tac lat > t1; uniq lat > u1; nl -ba lat > n1; od -An -tx1 p1 t1 u1 n1`],
	['r2-bytes-cat-bom', r`${BIN}; cat bom | cat > b2; echo "$(cat bom)" > b3; od -An -tx1 b2 b3`],
	['r2-bytes-sort-merge', r`${BIN}; cat lat two | sort > m1; od -An -tx1 m1`],

	// ---- sed a\ i\ c\ with no text, and c over a range
	['r2-sed-dollar-a', r`printf x | sed '$a\' | od -An -c; printf 'a\nb\n' | sed '$a\' | od -An -c`],
	['r2-sed-dollar-a-i', r`printf 'a\nb' > f; printf 'c\n' > g; sed -i -e '$a\' f g; od -An -c f g`],
	['r2-sed-bare-a-i-c', r`printf 'a\nb\n' | sed 'a\' | od -An -c; printf 'a\nb\n' | sed 'i\' | od -An -c; printf 'a\nb\nc\nd\n' | sed '2,3c\' | od -An -c; printf 'a\nb' | sed '1a\' | od -An -c`],
	['r2-sed-a-i-text-oneliner', r`printf 'a\nb\n' | sed '1i\HEAD'; printf 'a\nb\n' | sed '$a\TAIL'; printf 'a\nb\n' | sed '/a/c\CHANGED'`],
	['r2-sed-c-range', r`printf 'a\nb\nc\nd\n' | sed '2,3c X'; printf 'a\nb\nc\nd\n' | sed '/b/,/c/c X'; printf 'a\nb\nc\nd\n' | sed '2,$c X'; printf 'a\nb\nc\nd\n' | sed '3,2c X'`],
	['r2-sed-c-range-open', r`printf 'a\nb\nc\nd\n' | sed '/b/,/zzz/c X'; printf 'a\nb\nc\nd\n' | sed '2,100c X'`],
	['r2-sed-c-negated-group', r`printf 'a\nb\nc\nd\n' | sed '2,3!c X'; printf 'a\nb\nc\nd\n' | sed '2,3{c X
}'; printf 'a\nb\nc\nd\n' | sed '$!{2,3c X
}'`],
	['r2-sed-replacement-looks-like-a', r`printf 'x\n' | sed 's/x/;a\y/'; printf 'x\n' | sed 's/x/1i\z/'`],

	// ---- grep -o with a pattern that can match nothing
	['r2-grep-o-empty', r`printf 'abb\n' | grep -o 'b*'; echo "rc=$?"; echo aab | grep -o 'a*'; echo "rc=$?"; echo abc | grep -o '[0-9]*'; echo "rc=$?"; printf 'x1y22\n' | grep -oE '[0-9]*'; echo hello | grep -o 'l*'`],
	['r2-grep-o-empty-file', r`printf 'abc\nxyz\n123\n' > f; grep -o '[0-9]*' f; echo "rc=$?"; grep -on '[a-c]*' f; grep -c 'b*' f`],
	['r2-grep-o-empty-multi', r`printf 'ab\n' > f; printf 'cd\n' > g; grep -o 'x*' f g; echo "rc=$?"; grep -o '[a-z]*' f g`],

	// ---- grep file names and separated option values
	['r2-grep-H', r`printf 'foo\nbar\n' > f; grep -H foo f; echo foo | grep -H foo; grep -Hc foo f; grep -nH foo f; grep --with-filename foo f`],
	['r2-grep-r-names', r`mkdir src; printf 'TODO a\n' > src/a.js; printf 'TODO b\n' > f.txt; grep -rn TODO f.txt; grep -rn TODO src/ | sort; grep -rn TODO ./ | sort; grep -rnH TODO f.txt`],
	['r2-grep-long-values', r`mkdir -p src/deep; printf 'TODO a\nx\n' > src/a.js; printf 'TODO b\n' > src/b.txt; printf 'TODO c\n' > src/deep/c.js; grep -rl TODO src --include '*.js' | sort; grep -rl TODO src --exclude-dir deep | sort; grep -rl TODO src --exclude '*.txt' | sort; grep --max-count 1 TODO src/a.js; grep --after-context 1 TODO src/a.js; grep --regexp TODO src/b.txt`],

	// ---- awk length
	['r2-awk-length', r`printf 'foo bar\nHello\nHello World\n' | awk '{print length}'; printf 'foo bar\nHello\nHello World\n' | awk 'length > 5'; printf 'ab\nabc\n' | awk '{ n += length } END { print n }'; echo abc | awk '{print length()}'; echo abc | awk 'BEGIN{print length("xy")}'; printf 'a\n\nb\n' | awk 'length == 0 { print NR }'`],

	// ---- cut
	['r2-cut-no-delimiter', r`printf 'a,b\nx\n' | cut -d, -f2; printf 'a,b\nx\n' | cut -s -d, -f2; printf 'a,b\nx\n' | cut -d, -f1; printf 'a\tb\nx\n' | cut -f2`],

	// ---- cp and mv: what a directory may replace
	['r2-mv-dir-onto-nonempty', r`mkdir -p d1 dst/d1; echo new > d1/f; echo h > d1/h; echo OLD > dst/d1/f; echo g > dst/d1/g; mv d1 dst; echo "rc=$?"; find . | sort; cat dst/d1/f`],
	['r2-mv-dir-onto-empty', r`mkdir -p d1 dst/d1; echo x > d1/f; mv d1 dst; echo "rc=$?"; find . | sort`],
	['r2-mv-dir-onto-file', r`mkdir e; echo a > a.txt; mv e a.txt; echo "rc=$?"; ls; cat a.txt; cp -r e a.txt; echo "rc=$?"; ls`],
	['r2-mv-file-onto-dir', r`echo a > a; mkdir -p dst/a; echo x > dst/a/f; mv a dst; echo "rc=$?"; find . | sort`],
	['r2-cp-missing-dest-dir', r`echo a > a.txt; cp a.txt nodir/x; echo "rc=$?"; mv a.txt nodir/x; echo "rc=$?"; mkdir d; cp -r d nodir/y; echo "rc=$?"; ls`],
	['r2-mv-keeps-mode-and-time', r`echo a > a; chmod 600 a; touch -d @1000 a; mv a b; stat -c '%a %Y' b; mkdir d; echo x > d/f; chmod 700 d/f; mv d e; stat -c '%a' e/f`],
	['r2-cp-r-merges', r`mkdir -p s/sub t/sub; echo new > s/x; echo n > s/sub/y; echo old > t/x; echo keep > t/k; cp -r s/. t; find . | sort; cat t/x`],
	['r2-rm-rf-nested-staged', r`mkdir -p a/b/c; echo 1 > a/b/c/f; echo 2 > a/b/g; rm -rf a; ls; echo "rc=$?"`],
	['r2-nested-write-then-rm', r`mkdir -p build/out/deep; echo new > build/out/deep/old.txt; rm -rf build; cat build/out/deep/old.txt; echo "rc=$?"; ls`],
	['r2-nested-write-then-mv', r`mkdir -p pkg/lib/deep; echo old > pkg/lib/deep/file.js; sed -i 's/old/new/' pkg/lib/deep/file.js; mv pkg pkg2; find . | sort; cat pkg2/lib/deep/file.js`],

	// ---- sort option clusters that end in a valued option
	['r2-sort-clusters', r`printf 'x 3\ny 1\nz 2\n' > c; sort -nk2 c; sort -nrk2 c; sort -rk2,2 c; sort -t' ' -k2 c; sort -rt' ' -k2 c; sort -k2n c; sort -rn -k 2,2 c`],

	// ---- string order is by byte whatever the locale: jq and tree
	['r2-jq-order', r`echo '["z","B","a","A","_","1","b"]' | jq -c 'sort, unique, min, max, (group_by(.|ascii_downcase)|length)'; echo '{"b":1,"B":2,"a":3,"A":4}' | jq -c 'keys, (to_entries|map(.key)), (to_entries|sort_by(.key)|map(.key))'; echo '["é","e","z","É"]' | jq -c 'sort'`],

	// ---- time: no zone but UTC unless TZ says so
	['r2-date-d-utc', r`date -u -d '2020-02-29 12:00:00' '+%F %T %Z'; date -d '2020-02-29 12:00:00' '+%F %T %Z'; date -d '2020-02-29T12:00:00' +%s; date -d '2020-02-29' +%s; date -d '@1583000000' '+%F %T'; date -d 'Feb 29 2020 12:00' +%s`],
	['r2-date-d-explicit-zone', r`date -d '2020-03-01 00:00:00 +0100' +%s; date -d '2020-02-29 12:00:00 UTC' +%s; date -u -d '2020-02-29T12:00:00Z' '+%F %T'`],
	['r2-touch-stat-utc', r`touch -d '2020-01-02 03:04:05' t; stat -c '%y %Y' t; touch -t 202001020304.05 u; stat -c '%Y' u; touch -t 2001020304 v; stat -c '%y' v; touch -d @100 w; stat -c %Y w`],
	['r2-touch-t-two-digit-year', r`touch -t 6901020304 a; touch -t 6801020304 b; stat -c '%y' a b`],
	['r2-ls-l-time', r`touch -d '2020-01-02 03:04:05' t; ls -l t | awk '{print $6, $7, $8}'; touch -d @1 u; ls -l u | awk '{print $6, $7, $8}'`],
	['r2-find-newer', r`touch -d '2020-01-01' a; touch -d '2020-01-02' b; find . -type f -newer a | sort; find . -type f -not -newer b | sort`],
	['r2-tz-env-date', r`TZ=America/New_York date -d '2020-02-29 12:00:00' '+%F %T %Z %z'; TZ=Asia/Tokyo date -d '2020-02-29 12:00:00' '+%F %T'; TZ=Asia/Tokyo date -d @0 '+%F %T'`],
	['r2-tz-env-touch-stat', r`TZ=Asia/Tokyo touch -d '2020-01-02 03:04:05' t; stat -c '%Y' t; TZ=Asia/Tokyo stat -c '%y' t; TZ=Asia/Tokyo touch -t 202001020304.05 u; stat -c '%Y' u`],
	['r2-tz-env-ls', r`touch -d '@1' u; TZ=Asia/Tokyo ls -l u | awk '{print $6, $7, $8}'; ls -l u | awk '{print $6, $7, $8}'`],

	// ---- du with the numbers of a file system with 4 KiB blocks
	['r2-du-basic', r`mkdir -p d/sub; printf 'hello\n' > d/a; head -c 5000 /dev/zero > d/sub/big; du d | sort -k2; du -s d; du -sk d; du -sh d; du -s d/a; du -h d/a; du -k d/sub/big; du -a d | sort -k2`],
	['r2-du-options', r`mkdir -p d/sub; printf 'hello\n' > d/a; head -c 5000 /dev/zero > d/sub/big; du -d0 d; du -d1 d | sort -k2; du -c d d/sub | tail -n 1; du -sb d/a; du -m d | tail -n 1; du --apparent-size -s d/sub/big; du -sh d d/a`],
	['r2-du-missing', r`echo a > a; du -s a nope; echo "rc=$?"`],

	// ---- ls
	['r2-ls-p-color', r`mkdir d; echo x > f; ls -p; ls -lp | awk '{print $NF}'; ls --color=auto; ls --color=never -1; ls -1p d f`],
	['r2-ls-l-total', r`mkdir d; echo x > f; head -c 5000 /dev/zero > big; : > empty; ls -l | head -n 1; ls -la | head -n 1; ls -l d f | awk '{print $1, $2, $5}' | head -n 3; mkdir e; echo y > e/g; ls -l d e | grep total`],

	// ---- programs that are builtins in bash work with any PATH
	['r2-path-builtins', r`echo hi > f; PATH=/nonexistent; echo a; printf 'b\n'; pwd; cat f 2>/dev/null; echo "rc=$?"`],
	['r2-echo-after-path-unset', r`unset PATH; echo a; printf 'b\n'; pwd`],
];
