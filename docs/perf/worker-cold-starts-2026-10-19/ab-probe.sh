#!/bin/bash
# Interleaved A/B: for every idle gap and path, host A then host B (order alternating each repetition),
# each as one curl with the URL twice (fresh then reused connection). Columns as probe.sh plus "host".
A="$1"; B="$2"; out="$3"; plan="$4"; shift 4
paths=("$@")
fmt='%{url}\t%{num_connects}\t%{time_connect}\t%{time_appconnect}\t%{time_starttransfer}\t%{time_total}\t%{http_code}\t%header{cf-ray}\t%header{cf-placement}\t%header{server-timing}\n'
echo -e "ts\tgap\thost\tconn\turl\tnum_connects\tconnect\ttls\tttfb\ttotal\tstatus\tcf_ray\tcf_placement\tserver_timing" >> "$out"
one() { # host label path
  local ts; ts=$(date -u +%H:%M:%S)
  curl -s -o /dev/null -o /dev/null -H 'Origin: https://app.claxedo.dev' -w "$fmt" "$1$3" "$1$3" \
    | awk -v ts="$ts" -v gap="$gap" -v host="$2" 'BEGIN{FS=OFS="\t"}{print ts, gap, host, (NR==1?"fresh":"reused"), $0}' >> "$out"
}
r=0
for entry in $plan; do
  gap="${entry%%:*}"; reps="${entry##*:}"
  for ((i=1; i<=reps; i++)); do
    for p in "${paths[@]}"; do
      r=$((r+1))
      sleep "$gap"
      if (( r % 2 )); then one "$A" A "$p"; one "$B" B "$p"; else one "$B" B "$p"; one "$A" A "$p"; fi
    done
  done
done
