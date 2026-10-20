#!/usr/bin/env bash
set -u
usage() {
  echo "usage: bench-run.sh <run-name> <packaged-executable> [driver-checkout] [extra 'run' options, e.g. --repetitions 1]" >&2
  exit 2
}
[ $# -ge 2 ] || usage
name=$1; executable=$(realpath "$2"); shift 2
root=/home/user/Claxedo
if [ $# -gt 0 ] && [ "${1#--}" = "$1" ]; then root=$(realpath "$1"); shift; fi
benchmark=/home/user/kyashrathore/agent-app-benchmark
output=/home/user/bench/runs/$name
log=/home/user/bench/logs/run-$name.log
[ ! -e "$output" ] || { echo "$output already exists" >&2; exit 2; }
mkdir -p /home/user/bench/logs
started=$(date +%s)
xvfb-run -a -s "-screen 0 3024x1804x24 -nolisten tcp" bash -c '
  cd "$0" && exec node bin/agent-app-benchmark.mjs run --app claxedo --root "$1" --executable "$2" --output "$3" \
    --driver-env DISPLAY="$DISPLAY" --driver-env XAUTHORITY="$XAUTHORITY" --driver-env AGENT_APP_BENCHMARK_ROOT="$0" \
    --driver-env CLAXEDO_BENCHMARK_DRIVER_LOG="$4" "${@:5}"
' "$benchmark" "$root" "$executable" "$output" "/home/user/bench/logs/driver-$name.log" "$@" > "$log" 2>&1
code=$?
echo "EXIT=$code SECONDS=$(( $(date +%s) - started ))" | tee -a "$log"
exit $code
