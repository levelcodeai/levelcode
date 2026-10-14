// Cases for the third round: what the independent check of fix round 1 found wrong, each against GNU bash 5.1 and
// coreutils 8.32 in the reference container (no TZ: UTC). Same shape as round2.mjs: [name, script, options?], run on a
// bare workspace. A file with a byte that is not UTF-8 is made with `base64 -d`.
const r = (s, ...v) => String.raw(s, ...v).replaceAll('\\u007b', '{');

export const CASES = [
	// ---- cp and mv onto a destination written `name/` that is not there yet: a directory is made, a file cannot be
	['r3-cp-r-d-slash', r`mkdir d; echo 1 > d/f; echo 2 > d/h; cp -r d d2/; echo "rc=$?"; find . | sort`],
	['r3-cp-r-dslash-slash', r`mkdir d; echo 1 > d/f; cp -r d/ d2/; echo "rc=$?"; find . | sort`],
	['r3-cp-R-a', r`mkdir d; echo 1 > d/f; cp -R d e/; cp -a d g/; echo "rc=$?"; find . | sort`],
	['r3-cp-rT-slash', r`mkdir d; echo 1 > d/f; cp -rT d d2/; echo "rc=$?"; find . | sort`],
	['r3-cp-rv-slash', r`mkdir d; echo 1 > d/f; cp -rv d d2/; echo "rc=$?"; find . | sort`],
	['r3-cp-r-into-existing-parent', r`mkdir d ex; echo 1 > d/f; cp -r d ex/n/; echo "rc=$?"; find . | sort`],
	['r3-cp-r-missing-parent', r`mkdir d; echo 1 > d/f; cp -r d nodir/n/; echo "rc=$?"; find . | sort`],
	['r3-cp-dir-no-r-slash', r`mkdir d; echo 1 > d/f; cp d d2/; echo "rc=$?"; find . | sort`],
	['r3-mv-d-slash', r`mkdir d; echo 1 > d/f; mv d d2/; echo "rc=$?"; find . | sort`],
	['r3-mv-dslash-slash', r`mkdir d; echo 1 > d/f; mv d/ d2/; echo "rc=$?"; find . | sort`],
	['r3-mv-double-slash', r`mkdir d; echo 1 > d/f; mv d d2//; echo "rc=$?"; find . | sort`],
	['r3-mv-v-slash', r`mkdir d; echo 1 > d/f; mv -v d d2/; echo "rc=$?"; find . | sort`],
	['r3-mv-missing-parent-slash', r`mkdir d; mv d nodir/n/; echo "rc=$?"; find . | sort`],
	['r3-file-onto-missing-slash', r`echo a > a.txt; cp a.txt n/; echo "rc=$?"; mv a.txt n/; echo "rc=$?"; find . | sort`],
	['r3-file-below-a-file', r`echo a > a; echo b > b.txt; cp a b.txt/x/y; mv a b.txt/x/y; mkdir d; cp -r d b.txt/x/y/; cp a b.txt/; mv a b.txt/n; echo "rc=$?"; find . | sort`],
	['r3-src-file-with-slash', r`echo a > a; mkdir d; cp a/ x; cp -r a/ x; mv a/ x; echo "rc=$?"; find . | sort`],
	['r3-src-file-with-slash-multi', r`echo a > a; echo b > b; mkdir t; cp a/ b t; echo "rc=$?"; mv a/ b t; echo "rc=$?"; find . | sort`],
	['r3-cp-u-r-slash', r`mkdir d; echo 1 > d/f; cp -ru d d2/; echo "rc=$?"; find . | sort`],
	['r3-mv-same-file', r`echo 1 > a; mv a a; echo "rc=$?"; mv a ./a; echo "rc=$?"; mv -n a a; echo "rc=$?"; mv a .; echo "rc=$?"; cp a a; echo "rc=$?"; cp -n a a; echo "rc=$?"; cat a`],
	['r3-cp-T-dir', r`mkdir d e; echo 1 > d/f; echo 2 > e/g; cp -rT d e; echo "rc=$?"; find . | sort`],
	['r3-cp-T-file-onto-dir', r`echo 1 > a; mkdir b; cp -T a b; echo "rc=$?"; find . | sort`],
	['r3-cp-T-extra-operand', r`echo 1 > a; echo 2 > b; mkdir c; cp -T a b c; echo "rc=$?"; find . | sort`],
	['r3-cp-T-long', r`mkdir d e; echo 1 > d/f; cp -r --no-target-directory d e; echo "rc=$?"; find . | sort`],
	['r3-mv-T-empty-dir', r`mkdir d e; echo 1 > d/f; mv -T d e; echo "rc=$?"; find . | sort`],
	['r3-mv-T-full-dir', r`mkdir d e; echo 1 > d/f; echo 2 > e/g; mv -T d e; echo "rc=$?"; find . | sort`],
	['r3-mv-T-file-onto-dir', r`echo 1 > a; mkdir e; mv -T a e; echo "rc=$?"; find . | sort`],
	['r3-mv-T-file', r`echo 1 > a; echo 2 > b; mv -T a b; echo "rc=$?"; cat b; find . | sort`],
	['r3-cp-rv-lists-files', r`mkdir d d2; echo 1 > d/f; mkdir d/s; echo 2 > d/s/g; cp -rv d d2 | sort; cp -av d e | sort; cp -rv d/. d2 | sort`],

	// ---- a redirection's content survives the command taking its target away
	['r3-redirect-parent-removed', r`mkdir d; echo before; { rm -rf d; echo hi; } > d/f; echo "after rc=$?"; ls`],
	['r3-redirect-function', r`mkdir d; f() { rm -rf d; echo hi; }; f > d/log; echo "after rc=$?"; ls`],
	['r3-redirect-subshell-2to1', r`mkdir d; ( rm -rf d; echo hi ) > d/f 2>&1; echo "after rc=$?"; ls`],
	['r3-redirect-loop', r`mkdir d; for i in 1 2; do rm -rf d; echo $i; done > d/f; echo "after rc=$?"; ls`],
	['r3-redirect-exec', r`mkdir d; exec > d/log; rm -rf d; echo hi; echo there`],
	['r3-redirect-append-parent-removed', r`mkdir d; echo x > d/f; { rm -rf d; echo hi; } >> d/f; echo "after rc=$?"; ls`],

	// ---- printf '%(fmt)T' and %Z: the zone of the command, and tzdata's names
	['r3-printf-T-utc', r`printf '%(%F %T %Z %z)T\n' 1600000000; printf '%(%Y-%m-%d)T|%(%H:%M)T\n' 0 86400; printf '%(%Z)T\n' -1; printf '%(%Z)T\n' -2`],
	['r3-printf-T-tz-prefix', r`TZ=Asia/Tokyo printf '%(%F %T %Z %z)T\n' 1600000000; TZ=America/New_York printf '%(%F %T %Z)T\n' 1600000000; TZ=America/New_York printf '%(%F %T %Z)T\n' 1610000000`],
	['r3-printf-T-tz-export', r`export TZ=Europe/London; printf '%(%F %T %Z)T\n' 1600000000; printf '%(%F %T %Z)T\n' 1610000000; printf '%(%c)T\n' 0`],
	['r3-printf-T-unexported-tz', r`TZ=Asia/Tokyo; printf '%(%F %T %Z)T\n' 1600000000; date -d @1600000000 '+%F %T %Z'; export TZ; date -d @1600000000 '+%F %T %Z'`],
	['r3-date-u-d-with-tz', r`TZ=America/New_York date -u -d '2020-02-29 12:00:00' '+%F %T %Z'; export TZ=Asia/Tokyo; date -u -d '2020-02-29 12:00:00' '+%F %T %Z'; date -d '2020-02-29 12:00:00' '+%F %T %Z %s'; date -u -d @0 '+%F %T %Z'`],
	['r3-date-Z-names', r`for z in Asia/Tokyo Europe/London America/New_York Asia/Kolkata Europe/Paris Australia/Sydney Asia/Dubai America/Sao_Paulo Asia/Singapore Europe/Moscow Pacific/Auckland America/Los_Angeles Asia/Kathmandu; do TZ=$z date -d @1600000000 '+%Z %z'; TZ=$z date -d @1610000000 '+%Z %z'; done`],
	['r3-date-iso', r`date -d @1600000000 -I; date -d @1600000000 -Iseconds; date -d @1600000000 --iso-8601=hours; date -d @1600000000 --iso-8601=minutes; date -d @1600000000 --iso-8601; TZ=Asia/Tokyo date -d @1600000000 -Iseconds; date -u -d @1600000000 -I; date -d @1600000000 -R`],
	['r3-tz-posix-forms', r`TZ=JST-9 date -d @0 '+%F %T %Z %z'; TZ=UTC+3 date -d @0 '+%F %T %Z %z'; TZ=:America/New_York date -d @0 '+%F %T %Z'; TZ=EST5EDT date -d @1600000000 '+%F %T %Z'; TZ=GMT date -d @0 '+%F %T %Z'; TZ=Etc/GMT-9 date -d @0 '+%F %T %Z'`],
	['r3-tz-exported-vs-assigned', r`TZ=Asia/Tokyo; date -d @0 '+%F %T'; export TZ; date -d @0 '+%F %T'; f() { local TZ=America/New_York; date -d @0 '+%F %T'; }; unset TZ; f; touch -d @100 t; TZ=Asia/Tokyo; stat -c %y t; ls -l t | awk '{print $6,$7,$8}'`],
	['r3-tz-reaches-children', r`env TZ=Asia/Tokyo date -d @0 '+%F %T %Z'; (export TZ=Asia/Tokyo; date -d @0 '+%F %T'); date -d @0 '+%F %T'; export TZ=Asia/Tokyo; echo @0 | xargs -I{} date -d {} '+%F %T'; timeout 5 date -d @0 '+%F %T'; sh -c 'date -d @0 +%T'; env -i date -d @0 '+%F %T'`],
	['r3-exported-vars-reach-xargs', r`export FOO=1; echo x | xargs -I{} sh -c 'echo [$FOO]'; BAR=2; echo x | xargs -I{} sh -c 'echo [$BAR]'; BAZ=3 sh -c 'echo [$BAZ]'; echo x | BAZ=4 xargs -I{} sh -c 'echo [$BAZ]'; export FOO=1; find . -maxdepth 0 -exec sh -c 'echo [$FOO]' ';'`],

	// ---- grep and sed: GNU's escapes in a basic expression
	['r3-bre-plus-class', r`printf 'abc 12 def345 a+b\n' | grep -o '[0-9]\+'; printf 'abc 12 def345 a+b\n' | grep -c '[0-9]\+'`],
	['r3-bre-plus-atoms', r`printf 'abc 12 def345 a+b\n' | grep -o 'a\+'; printf 'abc 12 def345 a+b\n' | grep -o '.\+'; printf 'abc 12 def345 a+b\n' | grep -o '\w\+'`],
	['r3-bre-question', r`printf 'abc de\n' | grep -o 'd\?e'; printf 'colour\ncolor\ncolr\n' | grep 'colou\?r'`],
	['r3-bre-word-boundaries', r`printf 'abc abcd\nxabc\nabc\n' | grep -o '\<abc\>'; printf 'the cat\nconcatenate\ncat\n' | grep '\<cat\>'; printf 'the cat\nconcatenate\n' | grep '\<cat'; printf 'the cat\nbobcat\n' | grep 'cat\>'`],
	['r3-ere-word-boundaries', r`printf 'a cat b\nconcat\n' | grep -oE '\<cat\>'; printf 'a cat b\nconcat\n' | grep -E '\<cat'; printf 'a cat\nconcat\n' | egrep 'cat\>'`],
	['r3-bre-group-plus', r`printf 'ababx\nx\n' | grep -o '\(ab\)\+'; printf 'ab\ncd\nxe\n' | grep '\(ab\|cd\)'`],
	['r3-bre-posix-class-plus', r`printf 'a1\nb\n' | grep '[[:digit:]]\+'; printf 'a1\nb\n' | grep '[[:alpha:]]\+[0-9]'; printf 'a b\n' | grep -o '\S\+'`],
	['r3-bre-literals', r`printf 'a+b\na?b\nab\n' | grep 'a+b'; printf 'a+b\na?b\nab\n' | grep 'a?b'; printf '*a\nb\n' | grep '*a'; printf 'a*b\n' | grep 'a\*b'; printf '+a\nb\n' | grep '\+a'`],
	['r3-bre-anchors', r`printf 'a^b\na$b\n' | grep 'a^b'; printf 'a^b\na$b\n' | grep 'a$b'; printf 'ab\ncd\nxe\n' | grep '^ab\|cd$'`],
	['r3-bre-intervals', r`printf 'aa\na\naaa\n' | grep -x 'a\{2,3\}'; printf 'aa\na\naaa\n' | grep -x 'a\{2\}'; printf 'aa\na\naaa\n' | grep 'a\{2,\}'`],
	['r3-bre-options-combined', r`printf 'cat catalog cat\n' | grep -ow cat; printf 'Cat CAT cat\n' | grep -io 'c\w\+'; printf 'a\nab\nb\n' | grep -vx 'a\|b'; printf 'foo12 12 bar\n' | grep -ow '[0-9]\+'; printf 'a1\nb2\nc\n' | grep -e '[0-9]\+' -e 'c'`],
	['r3-grep-oc-counts-lines', r`printf 'a a a\nb\na\n' | grep -oc a; printf 'a a a\nb\na\n' | grep -co a; printf 'a a a\nb\na\n' > f; grep -oc a f; grep -c a f`],
	['r3-sed-word-boundaries', r`echo 'abc abcd xabc abc' | sed 's/\<abc\>/X/g'; echo 'abc abcd xabc' | sed 's/\<abc/X/g'; echo 'abc abcd xabc' | sed 's/abc\>/X/g'; echo 'abc abcd' | sed -E 's/\<abc\>/X/'; echo 'abc abcd' | sed -n '/\<abc\>/p'`],
	['r3-sed-plus-question-alt', r`echo 'abc 12 def345 aa' | sed 's/[0-9]\+/N/g'; echo 'colour color' | sed 's/colou\?r/C/g'; echo 'cat dog bird' | sed 's/cat\|dog/PET/g'; echo 'ab_1 c-d' | sed 's/\w\+/W/g'`],

	// ---- sed: a label ends at ; and -f script files get the same one-line a/i/c
	['r3-sed-label-semicolon', r`printf 'a\nb\nc\n' | sed ':a;N;$!ba;s/\n/ /g;$a\END'; printf 'a\nb\n' | sed ':a;2a\foo'`],
	['r3-sed-f-oneliner', r`printf 'a\nb\n' > a.txt; printf '$a\\END\n1i\\START\n' > s.sed; sed -f s.sed a.txt; printf '1i\\\nHEAD\n$a\\\nTAIL\ns/a/A/\n' > t.sed; sed -f t.sed a.txt`],
	['r3-sed-label-branches', r`printf 'a\nb\n' | sed -e ':x' -e 'N;s/\n/+/;tx'; printf 'a\nb\n' | sed -n '/a/b end;p;:end'; printf 'aaa\n' | sed ':a;s/a/b/;ta'`],
	['r3-sed-s-w-file', r`printf 'a\nx\nb\nx\n' > in; sed 's/x/y/w out' in; echo ---; cat out; sed -n 's/x/z/gpw out2' in; echo ---; cat out2`],
	['r3-sed-range-numeric-end-before-start', r`printf 'one\ntwo\nthree\nfour\nfive\n' | sed '/four/,3c X'; printf 'one\ntwo\nthree\nfour\nfive\n' | sed -n '/four/,3p'; printf 'one\ntwo\nthree\nfour\nfive\n' | sed '/four/,3d'; printf 'one\ntwo\nthree\nfour\nfive\n' | sed '/two/,/four/c X'`],

	// ---- sort: keys to the end of the line, GNU's fields, and -u keeps the first of equal lines
	['r3-sort-k-no-end', r`printf 'x,3,b\ny,1,a\nz,2,c\nw,2,d\n' > c.csv; sort -t, -k2 c.csv; printf 'a 1 z\nb 1 y\nc 1 x\n' | sort -k2; printf 'a 1 z\nb 1 y\nc 1 x\n' | sort -k2,2`],
	['r3-sort-u-keeps-first', r`printf 'x,3,b\ny,1,a\nz,2,c\nw,2,d\n' | sort -t, -u -k2,2; printf '1\n01\n1.0\n2\n02\n' | sort -un; printf 'b\nA\na\nB\nc\n' | sort -uf; printf 'b\na\nb\nc\na\n' | sort -ur; printf 'a 2\nb 1\na 1\nb 2\n' | sort -u -k1,1`],
	['r3-sort-fields-blanks', r`printf 'a   b\nc b\nd  a\n' | sort -k2b; printf 'a   b\nc b\nd  a\n' | sort -k2; printf 'a   b\nc b\nd  a\n' | sort -b -k2`],
	['r3-sort-fields-chars', r`printf 'a 11\nb 12\nc 21\nd 02\n' | sort -k2.2; printf 'a 11\nb 12\nc 21\nd 02\n' | sort -k2.2,2.2; printf 'abcd 1\nabxy 0\n' | sort -k1.1,1.2`],
	['r3-sort-t-fields', r`printf 'a:3:z\nb:1:y\nc:2:x\n' | sort -t: -k2n; printf 'a::z\nb:1:y\nc:2:x\n' | sort -t: -k2; printf 'a b\nc\nd e f\n' | sort -k3`],
	['r3-sort-multi-keys', r`printf 'a 2 z\nb 1 y\na 1 x\nb 1 w\n' | sort -k1,1 -k2,2n; printf 'b 1\na 2\nb 0\na 1\n' | sort -k1,1 -k2; printf 'b 1\na 1\nc 0\n' | sort -s -k2,2; printf 'a 1\nb 1\nc 2\n' | sort -u -rk2,2`],
	['r3-sort-check-unique', r`printf 'a\na\nb\n' | sort -cu; echo "rc=$?"; printf 'a\nb\n' | sort -cu; echo "rc=$?"`],

	// ---- xargs: lines, quotes, -L, GNU's status codes
	['r3-xargs-I-lines', r`printf 'a b\nc d\n' | xargs -I{} echo [{}]; printf '  a b  \n\n c\n' | xargs -I{} echo [{}]; echo a > 'f s.txt'; echo b > g.txt; ls | xargs -I{} echo file:{}`],
	['r3-xargs-I-quotes', r`printf '"a b" c\n'"'x y'"' z\n' | xargs -I{} echo [{}]; printf 'f s.txt\ng.txt\n' | xargs -I{} sh -c 'echo file:{}'; printf 'a\n' | xargs -I@ echo @ @ x@y; printf 'echo\n' | xargs -I{} {} hi; echo "rc=$?"`],
	['r3-xargs-L', r`printf 'a b\nc d\n' | xargs -L 1 echo; printf 'a b\nc d\ne\n' | xargs -L 2 echo; printf 'a \nb\nc\n' | xargs -L 1 echo; printf 'a b\nc d\n' | xargs --max-lines=1 echo; printf 'a b\nc\n' | xargs -l echo; printf 'a\nb\nc\n' | xargs -l2 echo`],
	['r3-xargs-quotes-and-backslash', r`printf '"a b" c '"'d e'"' f\\ g\n' | xargs -n1 echo; printf 'a\\\nb\n' | xargs echo; printf 'a\tb\n' | xargs -n1 echo`],
	['r3-xargs-delimiters', r`printf 'a b\0c\0' | xargs -0 -n1 echo; printf 'a b,c d,e' | xargs -d, -n1 echo; printf 'a b\nc d\n' | xargs -d '\n' echo; printf 'a b,c d' | xargs -d, -I{} echo [{}]; printf 'a\0\0b\0' | xargs -0 -n1 echo '[x]'; printf 'a,b\n' | xargs -d, -n1 echo`],
	['r3-xargs-eof-and-files', r`printf 'a\nSTOP\nb\n' | xargs -E STOP echo; printf 'a b STOP c\nd\n' | xargs -E STOP echo; printf 'a\nb\n' | xargs -E '' echo; printf 'x y\nz\n' > in; xargs -a in echo; xargs --arg-file=in -n1 echo`],
	['r3-xargs-status', r`printf 'a\nb\n' | xargs -n1 sh -c 'exit 3' _; echo "rc=$?"; printf 'a\n' | xargs nosuchcmd; echo "rc=$?"; printf 'a\n' | xargs sh -c 'exit 255' _; echo "rc=$?"; printf '1\n2\n3\n' | xargs -n1 sh -c 'echo $0; test $0 != 2'; echo "rc=$?"; printf '1\n2\n' | xargs -n1 sh -c 'echo $0; exit 255'; echo "rc=$?"`],
	['r3-xargs-empty-input', r`printf '' | xargs -r echo hi; echo "rc=$?"; printf '' | xargs echo hi; echo "rc=$?"; printf '' | xargs -I{} echo [{}]; echo "rc=$?"; printf '' | xargs -L1 echo hi; printf '' | xargs -n1 echo hi; printf '  \n' | xargs echo done; printf '\n' | xargs -I{} echo [{}]; echo "rc=$?"`],
	['r3-xargs-bad-options', r`echo a | xargs -n0 echo; echo "rc=$?"; echo a | xargs -n x echo; echo "rc=$?"; echo a | xargs -L0 echo; echo "rc=$?"; echo a | xargs -d '' echo; echo "rc=$?"; echo a | xargs -P x echo; echo "rc=$?"`],
	['r3-xargs-long-forms', r`printf 'a b c\n' | xargs --max-args=2 echo; printf 'a\nb\n' | xargs --replace=@ echo @; printf 'a\nb\n' | xargs -i echo x{}; printf 'a\n' | xargs -iX echo '<X>'; printf 'a\nb\n' | xargs -P2 -n1 echo; printf 'a b\n' | xargs -s 4096 echo; printf 'a b\n' | xargs echo pre`],
	['r3-xargs-pipelines', r`mkdir d; touch 'd/a b' d/c; find d -type f -print0 | xargs -0 ls | sort; echo hi > d/c; find d -type f | grep -v ' ' | xargs grep -l hi; printf 'b\na\n' | xargs -n1 | sort`],

	// ---- touch -r, tail -c +N, mkdir -pv
	['r3-touch-r', r`touch -d '2020-05-05 05:05:05' a; touch -r a b; stat -c '%y' a b; touch -d '@86400' c; touch --reference=c d; touch --reference c e; touch -rc f; stat -c %Y d e f`],
	['r3-touch-r-missing-and-c', r`touch -r nofile b; echo "rc=$?"; ls; touch -d '@1000' a; touch -c -r a nofile; ls; echo x > b; touch -r a b; stat -c %Y b; cat b; touch -d '@5000' g; touch -r g h i; stat -c %Y h i`],
	['r3-tail-c-plus', r`printf 'abcdef' | tail -c +1; echo; printf 'abcdef' | tail -c +3; echo; printf 'abcdef' | tail -c +7; echo; printf 'abcdef' > f; printf 'xyz' > g; tail -c +2 f g; echo; tail -qc +2 f g; echo; tail -c+4 f; echo; printf 'abcdef' | tail -c -2; echo; seq 1 10 | tail -n -3`],
	['r3-mkdir-pv', r`mkdir -pv a/b/c a/x; mkdir -v d e; mkdir -pv a/b`],

	// ---- du: the walk's answers (its bound is a limit, tested in the compat suite)
	['r3-du-slash-and-multi', r`mkdir d e; touch d/f; du d/; du -s d/; du -s d e; du -s .`],

	// ---- what the engine still does not have, found while differencing (each is in the known-differences table and NOTES §4)
	['r3-gap-date-relative', r`date -d '2020-01-01 +1 day' +%F; date -d '2020-01-31 +1 month' +%F; date -d '1 Jan 2020 3pm' '+%F %T'; date -d '2020-01-01 -2 days' +%F`],
	['r3-gap-sed-q-exit-and-z', r`printf '1\n2\n3\n' | sed '2q5'; echo "rc=$?"; printf 'a\nb\n' | sed -z 's/\n/,/g'`],
	['r3-gap-rm-d', r`mkdir d; rm -d d; echo "rc=$?"; ls`],
	['r3-gap-sort-z', r`printf 'b\0a\0' | sort -z | tr '\0' '\n'`],
	['r3-gap-grep-b', r`printf 'ab\ncd\n' | grep -b c`],
	['r3-gap-find-printf-type', r`mkdir d; touch d/f; find d -printf '%p %y\n' | sort`],
	['r3-gap-ln-hard', r`echo a > f; ln f g; echo "rc=$?"; ls`],
	['r3-gap-xargs-t-order', r`printf 'a b\n' | xargs -t echo 2>&1; printf 'a\nb\n' | xargs -L1 -n1 echo 2>&1`],
];
