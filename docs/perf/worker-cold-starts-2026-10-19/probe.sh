#!/bin/bash
# Cold against warm from one client: for every idle gap, each route is fetched twice in one curl
# invocation, the first transfer on a fresh TLS connection and the second on the reused one, and
# every answer's TTFB, cf-ray, cf-placement and Server-Timing land in a TSV.
#
#   ./probe.sh https://api.claxedo.dev gaps.csv "0:6 1:4 5:4 30:4 120:3" /health /api/claxedo/auth/descriptor /api/auth/get-session
#
# "<gap seconds>:<repetitions>" entries run in order; the gap is slept before every request.
origin="$1"; out="$2"; plan="$3"; shift 3
paths=("$@")
fmt='%{url}\t%{num_connects}\t%{time_connect}\t%{time_appconnect}\t%{time_starttransfer}\t%{time_total}\t%{http_code}\t%header{cf-ray}\t%header{cf-placement}\t%header{server-timing}\n'
echo -e "ts\tgap\tconn\turl\tnum_connects\tconnect\ttls\tttfb\ttotal\tstatus\tcf_ray\tcf_placement\tserver_timing" >> "$out"
for entry in $plan; do
  gap="${entry%%:*}"; reps="${entry##*:}"
  for ((r=1; r<=reps; r++)); do
    for p in "${paths[@]}"; do
      sleep "$gap"
      ts=$(date -u +%H:%M:%S)
      curl -s -o /dev/null -o /dev/null -H 'Origin: https://app.claxedo.dev' -w "$fmt" "$origin$p" "$origin$p" \
        | awk -v ts="$ts" -v gap="$gap" 'BEGIN{FS=OFS="\t"}{print ts, gap, (NR==1?"fresh":"reused"), $0}' >> "$out"
    done
  done
done
