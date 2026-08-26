#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

LANE=${1:?usage: cbx-ci-macos.sh <e2e-desktop|agent-runtime-stats>}

if [[ "$LANE" == "agent-runtime-stats" ]]; then
  machine=$(uname -m)
  case "$machine" in
    arm64) node_machine=arm64 ;;
    x86_64) node_machine=x64 ;;
    *) echo "unsupported macOS architecture: $machine" >&2; exit 2 ;;
  esac
  checksums=$(curl --fail --location --silent --show-error https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt)
  archive=$(printf '%s\n' "$checksums" | awk -v arch="$node_machine" '$2 ~ "node-v22.*-darwin-" arch ".tar.gz" { print $2; exit }')
  version_dir=${archive%.tar.gz}
  cache="$HOME/.cache/claxedo-ci/$version_dir"
  if [[ ! -x "$cache/bin/node" ]]; then
    mkdir -p "$cache" "$HOME/.cache/claxedo-ci/downloads"
    file="$HOME/.cache/claxedo-ci/downloads/$archive"
    curl --fail --location --silent --show-error "https://nodejs.org/dist/latest-v22.x/$archive" -o "$file"
    expected=$(printf '%s\n' "$checksums" | awk -v file="$archive" '$2 == file { print $1 }')
    actual=$(shasum -a 256 "$file" | awk '{ print $1 }')
    [[ "$actual" == "$expected" ]]
    tar -xzf "$file" --strip-components=1 -C "$cache"
  fi
  export PATH="$cache/bin:$PATH"
  [[ "$(node --version)" == v22.* ]]
  cd packages/agent-runtime-stats
  npm test
  node bin/agent-runtime-stats.js --version
  exit 0
fi

if [[ "$LANE" != "e2e-desktop" ]]; then
  echo "unknown Crabbox macOS CI lane: $LANE" >&2
  exit 2
fi

export CI=true
export NODE_OPTIONS=--max-old-space-size=4096

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
  --filter=@claxedo/workgraph \
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
