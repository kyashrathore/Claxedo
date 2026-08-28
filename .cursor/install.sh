#!/usr/bin/env bash
# Cloud Agent install for the Claxedo monorepo.
#
# Idempotent by design: it can run on a fresh pod or against a warm checkout.
# The base image already ships Node 22 and the `ubuntu` user, so the only system
# dependency this adds is Bun, pinned to the version in package.json's
# `packageManager` field.
set -euo pipefail

BUN_VERSION="1.3.14"

if ! command -v bun >/dev/null 2>&1 || [ "$(bun --version 2>/dev/null || true)" != "$BUN_VERSION" ]; then
  curl -fsSL https://bun.sh/install | bash -s "bun-v${BUN_VERSION}"
fi
export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"

# Workspace dependencies, frozen to bun.lock (postinstall applies the vendored
# dependency patches and fixes node-pty).
bun install --frozen-lockfile

# packages/*/dist is gitignored, and several @claxedo/* packages resolve each
# other -- and are resolved by claxedo-app and claxedo-server -- through their
# `dist` exports (e.g. @claxedo/workgraph/contracts -> dist/contracts/index.mjs).
# Build that closure. This is the same filter list CI uses in
# .github/workflows/typecheck.yml and .github/workflows/test.yml; keep them in
# sync. `opencode#build` is deliberately excluded (it is broken repo-wide and
# cross-compiles 12 single-file binaries), so this never drags it in.
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

# The embedded OpenCode engine artifact the control plane loads at runtime.
# `opencode#build` (the full CLI + web UI) is broken in the hard fork, but
# `build:node` emits only the node embed (dist/node/node.js) that
# @claxedo/server-core imports, and it builds cleanly.
bun run --cwd packages/opencode build:node
