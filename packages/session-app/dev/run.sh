#!/usr/bin/env bash
# One-command local run of the session-app against the REAL Claxedo server.
#
#   packages/session-app/dev/run.sh [workspace-dir]
#
# workspace-dir defaults to the Claxedo repo itself. Requires: bun, node 20+.
# Serves the app on http://localhost:4460 and the server on 127.0.0.1:4480.
set -euo pipefail

here="$(cd "$(dirname "$0")/.." && pwd)"      # packages/session-app
repo="$(cd "$here/../.." && pwd)"
workspace="${1:-$repo}"

# 1. The embedded engine artifact is a build output — build it when absent.
engine="$repo/packages/opencode/dist/node/node.js"
if [ ! -f "$engine" ]; then
  echo "[run] building the embedded engine artifact (first run only)…"
  (cd "$repo/packages/opencode" && bun run build:node)
fi

# 2. Real local server (control plane + engine + workspace runtime).
#    node+tsx, NOT bun — bun 1.3.14 crashes in this composition.
export CLAXEDO_DATA_DIR="${CLAXEDO_DATA_DIR:-$HOME/.claxedo-session-app-dev}"
mkdir -p "$CLAXEDO_DATA_DIR"
echo "[run] starting real local server on 127.0.0.1:4480 (data: $CLAXEDO_DATA_DIR)"
(cd "$repo/packages/workspace-runtime" \
  && exec node --import tsx "$here/dev/start-real-local-server.ts" 4480) &
server_pid=$!

# 3. Web app.
echo "[run] starting session-app on http://localhost:4460"
(cd "$here" && exec node ./node_modules/vite/bin/vite.js --port 4460 --strictPort) &
vite_pid=$!

trap 'kill $server_pid $vite_pid 2>/dev/null' EXIT INT TERM

until curl -sf --noproxy '*' -m 2 http://127.0.0.1:4480/api/claxedo/health >/dev/null 2>&1; do sleep 1; done
until curl -sf --noproxy '*' -m 2 http://127.0.0.1:4460/ >/dev/null 2>&1; do sleep 1; done

encoded=$(python3 - "$workspace" <<'EOF'
import sys, urllib.parse
print(urllib.parse.quote(sys.argv[1], safe=""))
EOF
)
echo
echo "──────────────────────────────────────────────────────────────────────"
echo "  Open:  http://localhost:4460/?server=http://127.0.0.1:4480&directory=$encoded"
echo "  Pick or create a session, then explore the composer chips."
echo "  (workspace-dir must be a git repository)"
echo "──────────────────────────────────────────────────────────────────────"
wait
