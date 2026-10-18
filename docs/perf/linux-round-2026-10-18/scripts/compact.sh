#!/usr/bin/env bash
node /home/user/bench/tools/claxedo-runs.mjs verdict /home/user/bench/runs/$1 /home/user/bench/runs/$2 2>&1 | grep -E '^\| (App|Next|Memory|CPU)' | sed -E 's/Next session down the list, //; s/ +\|/ |/g; s/\| +/| /g; s/\(max [^)]*\)//g; s/\(p95 [^,]*, /(/g; s/95% CI //g' | cut -d'|' -f2,3,4,6
