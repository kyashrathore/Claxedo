#!/usr/bin/env bash
# Run the core e2e suite as an N-way Playwright shard across separate crabbox boxes.
#
# One box does not scale: the suite is dominated by fixed per-test waits (poll
# intervals, SSE settle windows), not CPU, so 8x workers on a single box buys
# ~1.6x. Separate boxes are the only thing that divides wall-clock.
#
#   script/cbx-e2e-shard.sh fixe2e e2e2 e2e3 fixci
#
# Writes each shard's output to /tmp/e2e-shard-<slug>.log and prints a merged
# failure list. Extra playwright args can be passed via E2E_ARGS.
set -uo pipefail
cd "$(dirname "$0")/.."

BOXES=("$@")
N=${#BOXES[@]}
[ "$N" -eq 0 ] && { echo "usage: $0 <box-slug>..." >&2; exit 2; }

OUT=${E2E_OUT_DIR:-/tmp/e2e-shards}
mkdir -p "$OUT"
rm -f "$OUT"/shard-*.log

for i in "${!BOXES[@]}"; do
  box=${BOXES[$i]}
  shard=$((i + 1))
  (
    # Env mirrors .github/workflows/test.yml's e2e job EXACTLY. Dropping any of
    # it does not just lose coverage, it manufactures failures: without
    # CLAXEDO_E2E_SERVE_MODE=build-preview, the dev server transforms on demand
    # and every first navigation blows its expect timeout (the workflow records 188
    # toBeVisible timeouts / 2.5h that way), and without VITE_CLAXEDO_E2E the
    # bundle tree-shakes the test-auth seam so auth specs go anonymous.
    ./script/cbx run --id "$box" --no-sync -- bash -c "umask 022; cd packages/claxedo-app && \
      CLAXEDO_E2E_SERVE_MODE=build-preview PLAYWRIGHT_VIDEO=0 VITE_AUTH_ENABLED=true \
      VITE_CLAXEDO_SERVER_URL=http://127.0.0.1:3001 VITE_CLAXEDO_E2E=1 CI=1 \
      bun run test:e2e:core:base -- \
      --workers=8 --shard=$shard/$N --reporter=list ${E2E_ARGS:-}" \
      > "$OUT/shard-$shard-$box.log" 2>&1
    echo "shard $shard/$N ($box) exited $?"
  ) &
done
wait

echo
echo "================ MERGED FAILURES ================"
grep -hE "^\s+[0-9]+\) |✘|Error:|expect\(" "$OUT"/shard-*.log | sed 's/^[[:space:]]*//' | sort -u
echo
echo "================ SHARD TOTALS ================"
grep -hE "^\s*[0-9]+ (passed|failed|flaky|skipped)|passed \(|failed \(" "$OUT"/shard-*.log
echo
echo "logs in $OUT"
