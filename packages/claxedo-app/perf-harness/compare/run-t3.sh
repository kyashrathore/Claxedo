#!/bin/bash
# T3 graded-corpus benchmark arms (workspace + resource).
# See compare/README.md for the full runbook and measurement discipline.
set -u
T3=${T3_ROOT:-}

if [ -z "$T3" ]; then
  echo "usage: T3_ROOT=/absolute/path/to/t3code $0" >&2
  echo "T3 is an external checkout; set T3_ROOT explicitly." >&2
  exit 2
fi
if [ ! -d "$T3" ]; then
  echo "T3_ROOT does not exist: $T3" >&2
  exit 2
fi

wait_quiet() { until [ "$(sysctl -n vm.loadavg | awk '{print ($2 < 3.5) ? "ok" : "no"}')" = "ok" ]; do echo "waiting for quiet host"; sleep 15; done; }
wait_ac_power() { until pmset -g batt | head -1 | grep -q "AC Power"; do echo "waiting for AC power"; sleep 30; done; }
guard() {
  local hits
  hits=$(pgrep -lf "Contents/MacOS/T3 Code|Contents/MacOS/Claxedo|t3code/apps/desktop/.electron-runtime" | grep -vE "pgrep|Claxedo Dev" | head -2)
  if [ -n "$hits" ]; then echo "REFUSING: app instance running:"; echo "$hits"; exit 3; fi
}

for PROFILE in workspace-core-v1 resource-core-v1; do
  guard; wait_ac_power; wait_quiet
  echo "=== [$(date +%H:%M:%S)] T3 GRADED $PROFILE ==="
  (cd "$T3" && node scripts/agent-app-benchmark.ts \
    --app-driver scripts/lib/agent-app-benchmark/drivers/t3.ts \
    --corpus benchmarks/agent-app/corpora/graded-v1.json \
    --profiles "$PROFILE" --run-profile smoke --seed 1 \
    --output artifacts/agent-app-benchmark \
    --resource-monitor native/resource-monitor/target/release/t3-resource-monitor) \
    > "/tmp/t3-graded-$PROFILE.log" 2>&1
  echo "t3 graded $PROFILE exit $?"
done
echo "newest T3 attempts:"
ls -dt "$T3"/artifacts/agent-app-benchmark/attempt-* | head -2
