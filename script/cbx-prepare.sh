#!/usr/bin/env bash
# Sync + install + build everything the unit / e2e / perf runs need on a box.
# Mirrors .github/workflows/test.yml's setup steps.
#
#   script/cbx-prepare.sh cbx1 cbx2 cbx3 cbx4
set -uo pipefail
cd "$(dirname "$0")/.."

BOXES=("$@")
[ ${#BOXES[@]} -eq 0 ] && { echo "usage: $0 <box-slug>..." >&2; exit 2; }

OUT=${PREPARE_OUT_DIR:-/tmp/cbx-prepare}
mkdir -p "$OUT"

for box in "${BOXES[@]}"; do
  (
    ./script/cbx run --id "$box" --reclaim -- bash -c 'umask 022; set -e
      bun install --frozen-lockfile
      bun turbo build \
        --filter=@claxedo/agent-event-runtime \
        --filter=@claxedo/agent-extensions \
        --filter=@claxedo/agent-sdk-runtime \
        --filter=@claxedo/channels \
        --filter=@claxedo/connections \
        --filter=@claxedo/mcp \
        --filter=@claxedo/sandbox-manager \
        --filter=@claxedo/wakes \
        --filter=@claxedo/workgraph \
        --filter=@claxedo/workspace-relay-protocol \
        --filter=@claxedo/workspace-relay \
        --filter=@claxedo/workspace-runtime
      # Browsers come from the base image; only install when they are actually
      # missing. Re-running the installer OVER a populated cache has produced a
      # ZERO-BYTE chrome-headless-shell -- the file is there and executable, it
      # launches and exits 0 with no output, and Playwright reports "Target
      # page, context or browser has been closed" for every test with nothing
      # in any log naming the browser cache. A clean install into an empty
      # cache is reliable, so wipe before installing, and use the pinned
      # playwright from node_modules rather than npx (the npx->bunx shim
      # resolves playwright@latest, a different version than the suite imports).
      cd packages/claxedo-app
      CHROME=$(find ~/.cache/ms-playwright -name chrome-headless-shell -type f 2>/dev/null | head -1)
      if [ -z "$CHROME" ] || [ ! -s "$CHROME" ]; then
        rm -rf ~/.cache/ms-playwright
        ./node_modules/.bin/playwright install chromium
        CHROME=$(find ~/.cache/ms-playwright -name chrome-headless-shell -type f | head -1)
      fi
      # Run it. Stat-ing the path did not catch the zero-byte binary; this does.
      [ -n "$CHROME" ] && [ -s "$CHROME" ] && "$CHROME" --version
      echo prepared-ok' > "$OUT/$box.log" 2>&1
    echo "$box exited $?"
  ) &
done
wait

echo
echo "================ PREPARE RESULTS ================"
for box in "${BOXES[@]}"; do
  printf '%-8s %s\n' "$box" "$(grep -c prepared-ok "$OUT/$box.log" >/dev/null && tail -1 "$OUT/$box.log")"
done
echo "logs in $OUT"
