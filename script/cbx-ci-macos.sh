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
# The PR lane builds an unsigned directory package. Never let electron-builder
# discover identities through a runner's login Keychain; that can block a
# headless Crabbox job behind an interactive "Keychain Not Found" dialog.
export CSC_IDENTITY_AUTO_DISCOVERY=false
# The PR lane builds an unsigned directory package. Never let electron-builder
# discover identities through a runner's login Keychain; that can block a
# headless Crabbox job behind an interactive "Keychain Not Found" dialog.
export CSC_IDENTITY_AUTO_DISCOVERY=false

bun install --frozen-lockfile
npm install -g @anthropic-ai/claude-code@2.1.150
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
  --filter=@claxedo/workspace-runtime
bun run --cwd packages/claxedo-local-server build
(
  cd packages/claxedo-desktop
  VITE_AUTH_ENABLED=true bun run build
  npx electron-builder --dir --config electron-builder.config.ts
)
(
  cd packages/claxedo-app
  PLAYWRIGHT_SKIP_WEBSERVER=1 PLAYWRIGHT_VIDEO=0 bun run test:e2e:desktop
  PLAYWRIGHT_VIDEO=0 bun run test:e2e:desktop:real
)
