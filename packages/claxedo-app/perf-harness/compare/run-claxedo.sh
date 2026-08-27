#!/bin/bash
# Claxedo graded-corpus benchmark arms (workspace + resource).
# See compare/README.md for the full runbook and measurement discipline.
set -u
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
H=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
CLX=$(CDPATH= cd -- "$H/../../.." && pwd)
APP="${CLX_APP:-$CLX/packages/claxedo-desktop/dist/mac-arm64/Claxedo Dev.app}"
CORPUS=${CORPUS:-}

if [ -z "$CORPUS" ]; then
  echo "usage: CORPUS=/absolute/path/to/corpus.json [CLX_APP=/absolute/path/to/Claxedo.app] $0" >&2
  echo "CORPUS is generated and is not stored in this repository; set it explicitly." >&2
  exit 2
fi
if [ ! -f "$CORPUS" ]; then
  echo "CORPUS does not exist: $CORPUS" >&2
  exit 2
fi
if [ ! -d "$APP" ]; then
  echo "Claxedo app bundle does not exist: $APP" >&2
  echo "Build the repo-owned default or set CLX_APP explicitly; see compare/README.md." >&2
  exit 2
fi

wait_quiet() { until [ "$(sysctl -n vm.loadavg | awk '{print ($2 < 3.5) ? "ok" : "no"}')" = "ok" ]; do echo "waiting for quiet host"; sleep 15; done; }
wait_ac_power() { until pmset -g batt | head -1 | grep -q "AC Power"; do echo "waiting for AC power"; sleep 30; done; }
guard() {
  # Refuse to measure beside any other instance of either app under test —
  # a sibling instance makes the benchmark app's backend unreachable and the
  # failure mode reads like an app bug. Match executable PATHS, not names:
  # T3's dev binary is named plain "Electron" under .electron-runtime.
  local hits
  hits=$(pgrep -lf "Contents/MacOS/T3 Code|Contents/MacOS/Claxedo|t3code/apps/desktop/.electron-runtime" | grep -vE "pgrep|Claxedo Dev" | head -2)
  if [ -n "$hits" ]; then echo "REFUSING: app instance running:"; echo "$hits"; exit 3; fi
}

STAMP=$(date +%H%M%S)
for PROFILE in workspace-core-v1 resource-core-v1; do
  guard; wait_ac_power; wait_quiet
  echo "=== [$(date +%H:%M:%S)] Claxedo GRADED $PROFILE ==="
  (cd "$H" && bun src/agent-app-benchmark.ts \
    --app "$APP" \
    --profiles "$PROFILE" --run-profile iteration --seed 1 \
    --targets targets/graded-v1.json \
    --corpus "$CORPUS" \
    --output "$CLX/.artifacts/agent-app-benchmark/graded-$STAMP-$PROFILE") \
    > "/tmp/clx-graded-$PROFILE.log" 2>&1
  echo "claxedo graded $PROFILE exit $? out=graded-$STAMP-$PROFILE"
done
