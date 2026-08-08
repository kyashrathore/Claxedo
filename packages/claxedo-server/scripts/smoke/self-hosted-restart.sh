#!/usr/bin/env bash
# Boot the self-hosted entry, write durable state, restart against the SAME
# data root, and prove the state is still there.
#
# Why a script and not a vitest file: this needs two real process lifetimes
# against one data directory. A test that boots a server in-process shares the
# module registry and the open SQLite handle between "restarts", so it proves
# the cache still has the row rather than that the row is on disk — which is
# the only thing worth proving here.
#
# What it does NOT yet cover: booting a build of the PREVIOUS entry first.
# Unit 7 changed file paths and added a boot gate; it changed no schema and no
# data format, so the migration surface is unchanged code. That makes the
# cross-version fixture lower risk than a normal upgrade, and still unverified.
set -euo pipefail

PORT="${PORT:-3194}"
DATA_DIR="$(mktemp -d)"
trap 'rm -rf "$DATA_DIR"' EXIT

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$here"

boot() {
  CLAXEDO_DATA_DIR="$DATA_DIR" CLAXEDO_SERVER_PORT="$PORT" CLAXEDO_DISABLE_OPENCODE_COMPAT=1 \
    node --conditions=development \
      --import ../workspace-runtime/src/text-imports.mjs \
      --import tsx \
      src/deployments/self-hosted-node/index.ts > "$DATA_DIR/boot-$1.log" 2>&1 &
  echo $!
}

await_health() {
  for _ in $(seq 1 60); do
    if curl -fsS "http://127.0.0.1:$PORT/api/claxedo/health" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  echo "FAIL: server did not become healthy" >&2
  tail -20 "$DATA_DIR/boot-$1.log" >&2
  return 1
}

first=$(boot 1)
await_health 1

# A durable, owner-visible row. Network policy is a good probe: it is written
# through the real route, stored in claxedo.db, and read back through the app
# rather than by reaching into SQLite.
curl -fsS -X POST "http://127.0.0.1:$PORT/api/claxedo/network-policy" \
  -H 'content-type: application/json' \
  -d '{"target":"*.restart-probe.test","kind":"domain","mode":"deny"}' > /dev/null

kill "$first"; wait "$first" 2>/dev/null || true

second=$(boot 2)
await_health 2

if curl -fsS "http://127.0.0.1:$PORT/api/claxedo/network-policy" | grep -q "restart-probe.test"; then
  echo "PASS: durable state survived a restart on the self-hosted entry"
  kill "$second"; wait "$second" 2>/dev/null || true
else
  echo "FAIL: state written before the restart is gone" >&2
  kill "$second"; wait "$second" 2>/dev/null || true
  exit 1
fi
