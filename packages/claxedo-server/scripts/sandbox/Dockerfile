# better-sqlite3 13's Linux ARM64 prebuild requires glibc >= 2.38.
# Trixie supplies it; Bookworm's 2.36 cannot load the runtime store.
FROM node:24.21.0-trixie-slim

LABEL org.opencontainers.image.source="https://github.com/kyashrathore/Claxedo"

ENV DEBIAN_FRONTEND=noninteractive
ENV SHELL=/bin/bash
ENV PATH=/root/.local/bin:/root/.amp/bin:$PATH
ENV AMP_SKIP_UPDATE_CHECK=1 FACTORY_DROID_AUTO_UPDATE_ENABLED=false

# System tools needed for git clone, native compilation, and process management
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      bash zsh ca-certificates curl git gzip openssh-client \
      procps iproute2 netcat-openbsd \
      python3 make g++ && \
    rm -rf /var/lib/apt/lists/*

# Harness SDKs and CLIs skip npm's release-age gate: their releases carry the
# protocol changes Claxedo tracks the day they ship (owner exemption,
# 2026-09-30). npm honors these exclusions from 11.17 (Node 24.19); every other
# package, the harness packages' own dependencies included, stays gated.
RUN printf '%s\n' \
      'min-release-age-exclude[]=@agentclientprotocol/sdk' \
      'min-release-age-exclude[]=@anthropic-ai/claude-*' \
      'min-release-age-exclude[]=@cursor/sdk*' \
      'min-release-age-exclude[]=@earendil-works/*' \
      'min-release-age-exclude[]=@google/gemini-cli*' \
      'min-release-age-exclude[]=@openai/codex' \
      >> "$HOME/.npmrc"

# Global CLI tools used by direct terminal agents and materialized MCP configs.
RUN npm i -g --min-release-age=2 \
      tsx@4.22.3 \
      @anthropic-ai/claude-code@2.1.285 \
      @openai/codex@0.159.2 \
      @google/gemini-cli@0.62.0

COPY .build/install-agent-artifacts.sh /tmp/install-agent-artifacts.sh
RUN sh /tmp/install-agent-artifacts.sh && \
    ln -sf /root/.local/bin/agent /usr/local/bin/agent && \
    ln -sf /root/.local/bin/cursor-agent /usr/local/bin/cursor-agent && \
    ln -sf /root/.amp/bin/amp /usr/local/bin/amp && \
    ln -sf /root/.local/bin/droid /usr/local/bin/droid && \
    command -v claude && \
    command -v codex && \
    command -v gemini && \
    command -v agent && \
    command -v cursor-agent && \
    command -v amp && \
    command -v droid

# Claxedo workspace-runtime host: an in-repo esbuild bundle (built by
# scripts/sandbox/build-sandbox-image.ts into .build/) plus a generated
# package.json pinning the native modules that cannot be bundled.
# Images are reproducible from the repo at a pinned commit; npm publishing of
# @claxedo/workspace-runtime is a release concern and does not gate builds.
COPY .build/ /opt/workspace-runtime/
RUN cd /opt/workspace-runtime && \
    npm install --omit=dev --min-release-age=2 --legacy-peer-deps && \
    test -f /opt/workspace-runtime/workspace-runtime-host.mjs && \
    test -f /opt/workspace-runtime/launch-gate-child.mjs && \
    test -f /opt/workspace-runtime/cursor-worker.mjs && \
    chmod 0755 /opt/workspace-runtime/workspace-runtime-host.mjs && \
    ln -sf /opt/workspace-runtime/workspace-runtime-host.mjs /usr/local/bin/workspace-runtime && \
    command -v workspace-runtime && \
    test "$(workspace-runtime --version)" = "$(cat /opt/workspace-runtime/workspace-runtime-version)"

# Exercise the canonical session lifecycle and one embedded OpenCode turn
# against a loopback stand-in provider, the turn path a cloud VM serves.
RUN node /opt/workspace-runtime/workspace-runtime-image-smoke.mjs

WORKDIR /workspace
