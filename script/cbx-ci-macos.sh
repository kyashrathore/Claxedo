#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

LANE=${1:?usage: cbx-ci-macos.sh <e2e-desktop>}

if [[ "$LANE" != "e2e-desktop" ]]; then
  echo "unknown Crabbox macOS CI lane: $LANE" >&2
  exit 2
fi

export CI=true
export NODE_OPTIONS=--max-old-space-size=4096

bun install --frozen-lockfile
bun run build:packages
(
  cd packages/claxedo-app
  npx playwright install chromium
  bun run e2e -- --project=desktop
)
