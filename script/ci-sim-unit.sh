#!/usr/bin/env bash
# Simulate the CI `unit (linux)` job on a crabbox Linux box for a FAST feedback
# loop: same command shape as .github/workflows/test.yml (build dist-resolved
# packages, then `bun turbo test --concurrency=2`), pinned to 2 cores with
# `taskset` to reproduce the runner's CPU starvation. Iterate here until green,
# THEN push — instead of debugging through 25-minute CI round-trips.
#
#   script/ci-sim-unit.sh <box-slug> [--sync] [--runs N]
set -uo pipefail
cd "$(dirname "$0")/.."

BOX=${1:?usage: ci-sim-unit.sh <box-slug> [--sync] [--runs N]}
shift
SYNC=0
RUNS=1
while [ $# -gt 0 ]; do
  case "$1" in
    --sync) SYNC=1 ;;
    --runs) RUNS="$2"; shift ;;
  esac
  shift
done

SYNC_FLAG="--no-sync"
[ "$SYNC" = 1 ] && SYNC_FLAG=""

./script/cbx run --id "$BOX" $SYNC_FLAG -- bash -c "umask 022; set -e
bun install --frozen-lockfile >/dev/null 2>&1
bun turbo build \
  --filter=@claxedo/agent-event-runtime \
  --filter=@claxedo/agent-extensions \
  --filter=@claxedo/agent-sdk-runtime \
  --filter=@claxedo/channels \
  --filter=@claxedo/connections \
  --filter=@claxedo/mcp \
  --filter=@claxedo/sandbox-contract \
  --filter=@claxedo/sandbox-manager \
  --filter=@claxedo/wakes \
  --filter=@claxedo/workspace-relay-protocol \
  --filter=@claxedo/workspace-relay \
  --filter=@claxedo/workspace-runtime >/dev/null 2>&1
echo '=== BUILD DONE ==='
export OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER=false
for run in \$(seq 1 $RUNS); do
  echo \"=== RUN \$run/$RUNS ===\"
  taskset -c 0,1 bun turbo test --concurrency=2 --force > /tmp/ci-sim-run.log 2>&1
  code=\$?
  grep -E '\(fail\)|FAIL |Failed:|Tasks:' /tmp/ci-sim-run.log | tail -20
  echo \"=== RUN \$run exit=\$code ===\"
  [ \$code -ne 0 ] && cp /tmp/ci-sim-run.log /tmp/ci-sim-failed-run\$run.log
done
true"
