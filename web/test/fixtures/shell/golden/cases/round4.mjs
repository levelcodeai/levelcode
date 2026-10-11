// Cases for the fourth round: what the independent check of fix round 2 found, each against GNU bash 5.1 and coreutils
// 8.32 in the reference container (no TZ: UTC). Same shape as round3.mjs: [name, script, options?], run on a bare
// workspace. A file with a byte that is not UTF-8 is made with `base64 -d`.
const r = (s, ...v) => String.raw(s, ...v).replaceAll('\\u007b', '{');

export const CASES = [
	// ---- xargs builds its command lines by size (-s, default 128 KiB, every word counted with its NUL), as GNU does
	['r4-xargs-default-batches', r`seq 1 40000 | xargs echo | awk '{ n++; c += length($0) } END { print n, c }'`],
	['r4-xargs-s-batches', r`seq 1 3000 | xargs -s 100 echo | awk '{ n++; c += length($0) } END { print n, c }'; seq 1 3000 | xargs -s 4096 echo | awk '{ n++ } END { print n }'`],
	['r4-xargs-s-exact', r`printf 'aa\nbb\ncc\ndd\n' | xargs -s 12 echo; printf 'aa\nbb\ncc\ndd\n' | xargs -s 13 echo; printf 'aa\nbb\ncc\ndd\n' | xargs -s 14 echo; printf 'aa\nbb\ncc\ndd\n' | xargs -s 17 echo`],
	['r4-xargs-s-n-mixed', r`seq 1 20 | xargs -s 30 -n 4 echo; seq 1 20 | xargs -s 100 -n 4 echo`],
	['r4-xargs-s-utf8', r`printf 'é\nb\n' | xargs -s 8 echo; printf 'é\nb\n' | xargs -s 7 echo; echo "rc=$?"; printf '日\nb\n' | xargs -s 9 echo`],
	['r4-xargs-s-initial-args', r`printf 'a b\n' | xargs -s 10 echo xx; printf 'a b\n' | xargs -s 12 echo xx; printf 'a\n' | xargs -s 5 echo; echo "rc=$?"; xargs -s 1 echo </dev/null; echo "rc=$?"; xargs -s 5 echo </dev/null; echo "rc=$?"`],
	['r4-xargs-line-too-long', r`printf 'a\nb\nzzzzzzzzzzzzzzzzzzzz\nc\n' | xargs -s 12 echo; echo "rc=$?"; printf 'a\nb\nzzzzzzzzzzzzzzzzzzzz\nc\n' | xargs -s 12 -n 1 echo; echo "rc=$?"; printf 'abcdefgh\n' | xargs -s 14 echo aaaa; echo "rc=$?"`],
	['r4-xargs-x-n', r`printf 'a\nb\n' | xargs -n 1 -x -s 7 echo; echo "rc=$?"; printf 'a\nbb\n' | xargs -n 2 -x -s 8 echo; echo "rc=$?"; printf 'aa\nbb\ncc\ndd\n' | xargs -x -s 12 echo; echo "rc=$?"`],
	['r4-xargs-L-implies-x', r`printf 'a b\n' | xargs -L 1 -s 7 echo; echo "rc=$?"; printf 'a b\n' | xargs -L 1 -s 9 echo; echo "rc=$?"; printf 'a\nb\nc\nd\n' | xargs -L 2 -s 11 echo; echo "rc=$?"`],
	['r4-xargs-I-size', r`printf 'aaa\nbb\n' | xargs -s 12 -I{} echo x{}y; printf 'aaa\nbb\n' | xargs -s 10 -I{} echo x{}y; echo "rc=$?"; printf 'aaaa\n' | xargs -s 14 -I{} echo {} {}; echo "rc=$?"; printf 'aaaa\n' | xargs -s 15 -I{} echo {} {}; echo "rc=$?"; printf 'aaaaaaaaaaaaaaaaaaaa\n' | xargs -s 12 -I{} echo x{}y; echo "rc=$?"`],
	['r4-xargs-s-values', r`printf 'a\n' | xargs -s 0 echo; echo "rc=$?"; printf 'a\n' | xargs -s -5 echo; echo "rc=$?"; printf 'a\n' | xargs -s abc echo; echo "rc=$?"; printf 'a\n' | xargs -n -1 echo; echo "rc=$?"`],
	['r4-xargs-unmatched-quote-items', r`printf "a b it's c\n" | xargs echo; echo "rc=$?"; printf "a\nit's\n" | xargs -n1 echo; echo "rc=$?"; printf "a b c it's d\n" | xargs -n 2 echo; echo "rc=$?"`],
	['r4-xargs-unmatched-quote-lines', r`printf "a b c\nit's d\n" | xargs -L 1 echo; echo "rc=$?"; printf "a b\nc d it's\n" | xargs -L 1 echo; echo "rc=$?"; printf "a\nb it's\nc\n" | xargs -I{} echo x{}; echo "rc=$?"`],
	['r4-xargs-unmatched-quote-status', r`printf "a b it's c\n" | xargs sh -c 'echo "n=$#"; exit 1' sh; echo "rc=$?"; printf "a b it's\n" | xargs -n1 sh -c 'echo "$1"; exit 1' sh; echo "rc=$?"`],
	['r4-xargs-unmatched-quote-rm', r`touch x.txt "don't.txt"; ls | xargs rm; echo "rc=$?"; ls`],
	['r4-xargs-p-fails-closed', r`printf 'a b\nc d\n' | xargs -p echo; echo "rc=$?"; printf 'a b\n' | xargs --interactive echo; echo "rc=$?"; printf '' | xargs -p -r echo; echo "rc=$?"; touch f; echo f | xargs -p rm; echo "rc=$?"; ls`],
	['r4-xargs-o-fails-closed', r`printf 'a b\n' | xargs -o echo 2>/dev/null; echo "rc=$?"; printf '' | xargs -o -r echo; echo "rc=$?"; touch f; echo f | xargs -o rm 2>/dev/null; echo "rc=$?"; ls`],
	['r4-xargs-I-empty', r`printf 'a\nb\n' | xargs -I '' echo x; echo "rc=$?"; printf '' | xargs -I '' echo x; echo "rc=$?"`],
	['r4-xargs-missing-values', r`for o in --max-args -n --arg-file -a -I -L -s -P -d -E --delimiter --max-lines --max-chars --max-procs --process-slot-var; do echo "## $o"; xargs $o 2>&1; echo "rc=$?"; done`],
	['r4-xargs-big-find', r`mkdir -p a/b/c; for i in $(seq 1 600); do echo TODO > a/b/c/very_long_directory_name_for_a_file_number_$i.java; done; find . -name '*.java' | xargs grep -l TODO | wc -l; find . -type f | xargs echo | wc -l; find . -type f | xargs -n 100 echo | wc -l`],

	// ---- an option that needs a value and has none: getopt's words, and nothing runs
	['r4-missing-values-try', r`for c in "touch -r" "touch --reference" "touch -d" "touch -t" "cp -t" "cp --target-directory" "mv -t" "mv -S" "cp -S" "du -d" "du --max-depth" "du -B" "du --block-size" "sort -k" "sort -t" "sort -o" "sort --key" "head -n" "head -c" "tail -n" "tail -c" "head --lines" "tail --bytes" "mkdir -m" "mkdir --mode" "uniq -f" "uniq -s" "uniq -w" "date -d" "date -r" "date --date" "stat -c" "stat --format" "wc --files0-from" "ls -w" "ls -I" "paste -d" "realpath --relative-to"; do echo "## $c"; eval "$c" 2>&1; echo "rc=$?"; done`],
	['r4-missing-values-grep', r`for c in "grep -e" "grep -f" "grep -m" "grep -A" "grep -B" "grep -C" "grep --regexp" "grep --file" "grep --max-count" "grep --include" "grep --exclude-dir" "grep --label"; do echo "## $c"; eval "$c" 2>&1; echo "rc=$?"; done`],
	['r4-missing-values-awk-sed', r`for c in "awk -f" "awk -v" "awk -F" "sed -f" "sed -e" "sed --expression" "sed --file"; do echo "## $c"; eval "$c" 2>&1 | head -1; done`],

	// ---- touch -r REF with a time of its own: -d and -t win
	['r4-touch-r-d', r`touch -d '2001-02-03 04:05:06' ref; touch -r ref -d '2010-01-01' a; stat -c '%y' a; touch -r ref a2; stat -c '%y' a2; touch -d '2010-01-01' -r ref a3; stat -c '%y' a3; touch -r ref -t 202001020304 a4; stat -c '%y' a4`],

	// ---- cp and mv operands, the shapes the matrix of the fixture pins in bulk
	['r4-mv-dot-source', r`mkdir d x; echo 1 > d/one; mv d/. x/; echo "rc=$?"; mv d/. y; echo "rc=$?"; mv d/.. y; echo "rc=$?"; mv . y; echo "rc=$?"; mv -n d/. x; echo "rc=$?"; find . | sort`],
	['r4-cp-r-target-not-dir', r`mkdir d; echo 1 > f; cp -R d f/ x/; echo "rc=$?"; mv d f/ x/; echo "rc=$?"; find . | sort`],
	['r4-cp-T-extra-slash-file', r`mkdir d; echo 1 > f; cp -rT f/ d/ ./; echo "rc=$?"; find . | sort`],
	['r4-mv-n-slash-file', r`echo 1 > f; echo 2 > g; mv -nv f/ g; echo "rc=$?"; mv -n f/ nonexist; echo "rc=$?"; cp -n f/ g; echo "rc=$?"; cat g`],
	['r4-mv-u-same-and-gone', r`echo 1 > f; mkdir e; mv -u ./f f e//; echo "rc=$?"; find . | sort; echo 1 > g; mv -u g ./g; echo "rc=$?"`],
	['r4-cp-rn-merges', r`mkdir -p d/sub e/sub; echo 1 > d/one; echo 2 > d/sub/two; echo X > e/one; cp -rn d/. e; echo "rc=$?"; cat e/one e/sub/two; cp -rnv d e2 | sort; find . | sort`],
	['r4-cp-ru-empty-dir', r`mkdir emp ws; cp -ru emp ws/; echo "rc=$?"; find . | sort; cp -rn emp ws; echo "rc=$?"`],
	['r4-cp-rn-dir-onto-file', r`mkdir d; echo 1 > g; cp -rn d g; echo "rc=$?"; find . | sort`],
	['r4-verbose-names-as-typed', r`mkdir -p d/sub e; echo 1 > d/sub/f; cp -rv d/sub . | sort; mv -v d/ e; mv -v e/d x//; ls`],

	// ---- head and tail take the long forms
	['r4-tail-lines-plus', r`printf 'alpha\nbeta\ngamma\ndelta\nepsilon\n' > f; tail --lines=+4 f; tail --lines +4 f; tail -n +4 f; tail --lines=2 f; tail --bytes=6 f; head --lines 2 f; head --lines=-3 f; head --bytes 3 f`],

	// ---- sort keys: the letters are read where they are written
	['r4-sort-k-b-end', r`printf '   c,FOO,0,foo\naa,Foo,007\n9,Foo,é,B\n' | sort -k1.1,1b -k3,4; printf ' b\na\n  c\n' | sort -k1b; printf 'b  x\na  y\n c z\n' | sort -k2b; printf ' b 3\na   1\n  c 2\n' | sort -k1,1b`],
	['r4-sort-k-start-char', r`printf 'xb\nya\nzc\n' | sort -k1.2; printf 'xb\nya\nzc\n' | sort -k1.2,1.2; printf 'x b\ny a\nz c\n' | sort -k2.1b`],
	['r4-sort-k-invalid', r`printf 'a\n' | sort -k0; echo "rc=$?"; printf 'a\n' | sort -k1.0; echo "rc=$?"; printf 'a\n' | sort -kx; echo "rc=$?"`],
	['r4-sort-o-errors', r`mkdir d; echo a > d/f; rm -rf d; echo b | sort -o d/f; echo "rc=$?"; mkdir e; echo b | sort -o e; echo "rc=$?"; echo a > g; echo b | sort -o g/x; echo "rc=$?"; echo b | sort -o ok; cat ok`],

	// ---- a program's own write to a path that was a redirection's target is its own error
	['r4-tee-after-redirect-removed', r`mkdir d; echo a > d/f; rm -rf d; echo b | tee d/f; echo "rc=$?"; echo b | tee -a d/f; echo "rc=$?"`],
	['r4-tee-after-redirect-dir', r`echo a > f; rm f; mkdir f; echo b | tee f; echo "rc=$?"`],
	['r4-awk-after-redirect-removed', r`mkdir d; echo a > d/f; rm -rf d; awk 'BEGIN { print "x" > "d/f" }' 2>/dev/null; echo "rc=$?"`],
	['r4-redirect-then-redirect-removed', r`mkdir d; echo a > d/f; rm -rf d; echo b > d/f; echo "rc=$?"; mkdir d; { rm -rf d; echo hi; } > d/f; echo "rc=$?"`],
	['r4-touch-after-redirect-removed', r`mkdir d; echo a > d/f; rm -rf d; touch d/f; echo "rc=$?"; echo hi > g; rm g; mkdir g; touch g; echo "rc=$?"`],

	// ---- cd to the root and down again, `..` and `.` in a path
	['r4-cd-dotdot-root', r`mkdir -p src; cd /w/../w/./src && pwd; cd /; cd /w/../w; pwd; echo $PWD; cd /w/./src/..; pwd; cd -; pwd; cd /w/src; cd ../../w/src; pwd; echo "$OLDPWD"`],
	['r4-realpath-dotdot', r`mkdir -p src; realpath /w/../w/./src; realpath src/../src; readlink -f /w/src/../src/.; cd /w/../w/src; realpath .; realpath ..`],

	// ---- bytes that are not ASCII, written as escapes, are those bytes
	['r4-printf-bytes-wc', r`printf '\xff\xfe' > f; wc -c f; printf '\377' > g; wc -c g; echo -e '\xff' > h; wc -c h; echo $'\xff\xfe' > i; wc -c i`],
	['r4-printf-bytes-od', r`printf '\000\001\377\376' | od -An -tx1; printf '\xe9' | od -An -tx1; printf '\303\251' | od -An -tx1; printf '\xc3\xa9\xe2\x9c\x93' | od -An -tx1; echo -e '\xff\x41' | od -An -tx1; echo -e '\0377' | od -An -tx1`],
	['r4-printf-bytes-roundtrip', r`printf '\xff\xfe\x00\x80' > b.bin; wc -c < b.bin; cat b.bin | wc -c; cp b.bin c.bin; cmp b.bin c.bin && echo same; base64 b.bin; printf '\xff' | base64; printf '\xff' | sha256sum; printf '\377\n' | md5sum`],
	['r4-printf-utf8-text', r`printf 'caf\303\251 \342\234\223\n' > u.txt; wc -m u.txt; wc -c u.txt; cat u.txt; x=$(printf '\303\251'); echo "$\u007b#x}"; printf '\xc3\xa9\n'; echo -e 'caf\xc3\xa9'; echo $'\xe2\x9c\x93'`],

	// ---- time zones: file names are written in their case; the letters of tzdata; what glibc makes of a name that is none
	['r4-tz-names-letters', r`for z in America/Indiana/Indianapolis America/Kentucky/Louisville America/North_Dakota/Center America/Havana America/Mazatlan America/Chihuahua Pacific/Pago_Pago Europe/Vatican Asia/Amman Asia/Istanbul Europe/Istanbul Europe/Kyiv Europe/Kiev US/Eastern Canada/Yukon Asia/Calcutta GMT0 Universal Zulu UCT Etc/GMT Etc/UTC; do printf '%s ' $z; TZ=$z date -d @1594814400 '+%Z %z'; done`],
	['r4-tz-case-and-names', r`for z in asia/tokyo ASIA/TOKYO Asia/tokyo us/eastern est utc gmt Nowhere ab Nowhere/Land JST-9 jst-9 EST5 UT Z; do printf '%s ' $z; TZ=$z date -d @1594814400 '+%Z %z %H'; done`],
	['r4-tz-seconds-offset', r`TZ=XXX-9:30:15 date -d @0 '+%z %Z %H:%M:%S'; TZ=XXX+9:30:15 date -d @0 '+%z %Z %H:%M:%S'`],

	// ---- a command word that is only expansions is split into words (and globbed) as an argument is
	['r4-command-word-split', r`c='echo a b'; $c; c='echo a'; $c b c; x=' '; $x echo hi; $(echo echo hi from sub); c='printf %s-%s\n x y'; $c; touch a.txt b.txt; c='echo *.txt'; $c; c='echo "a b"'; $c; c='true && echo no'; $c; echo "rc=$?"; c='exit 3'; ($c); echo "rc=$?"; c='cd /tmp'; $c; pwd; IFS=:; c='echo:a:b'; $c; IFS=; c='echo x'; $c 2>/dev/null; echo "rc=$?"`],

	// ---- grep and sed: a quantifier after a quantifier, and after an assertion
	['r4-bre-quant-quant', r`printf 'aaa b\n' | grep -o 'a*\+'; printf 'ab\n' | grep -o 'a\+\?'; printf 'aaab\n' | sed 's/a*\+/X/'; printf 'abab\n' | grep -o '\(ab\)*\+'; printf 'aaab\n' | sed -E 's/a*+/X/'; printf 'aaab\n' | grep -oE 'a*?'`],
	['r4-bre-assertion-literal', r`printf 'x+y a+\n' | grep -o '\b\+'; echo "rc=$?"; printf 'x? a?\n' | grep -o '\b\?'; echo "rc=$?"`],
];
