# better-sqlite3 13's Linux ARM64 prebuild requires glibc >= 2.38.
# Trixie supplies it; Bookworm's 2.36 cannot load the runtime store.
FROM node:24.18.0-trixie-slim

LABEL org.opencontainers.image.source="https://github.com/kyashrathore/Claxedo"

ENV DEBIAN_FRONTEND=noninteractive
ENV SHELL=/bin/bash
ENV PATH=/root/.local/bin:/root/.amp/bin:$PATH

# System tools needed for git clone, native compilation, and process management
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      bash zsh ca-certificates curl git openssh-client \
      procps iproute2 netcat-openbsd \
      python3 make g++ && \
    rm -rf /var/lib/apt/lists/*

# Global CLI tools used by direct terminal agents and materialized MCP configs.
RUN npm i -g --min-release-age=2 \
      tsx@4.22.3 \
      @anthropic-ai/claude-code@2.1.150 \
      @openai/codex@0.133.0 \
      @google/gemini-cli@0.43.0 \
      @earendil-works/pi-coding-agent@0.85.1 && \
    curl https://cursor.com/install -fsS | bash && \
    curl -fsSL https://ampcode.com/install.sh | bash && \
    curl -fsSL https://app.factory.ai/cli | sh && \
    ln -sf /root/.local/bin/agent /usr/local/bin/agent && \
    ln -sf /root/.local/bin/cursor-agent /usr/local/bin/cursor-agent && \
    ln -sf /root/.local/bin/amp /usr/local/bin/amp && \
    ln -sf /root/.local/bin/droid /usr/local/bin/droid && \
    command -v claude && \
    command -v codex && \
    command -v gemini && \
    command -v agent && \
    command -v cursor-agent && \
    command -v amp && \
    command -v droid && \
    command -v pi

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
    chmod 0755 /opt/workspace-runtime/workspace-runtime-host.mjs && \
    ln -sf /opt/workspace-runtime/workspace-runtime-host.mjs /usr/local/bin/workspace-runtime && \
    command -v workspace-runtime && \
    test "$(workspace-runtime --version)" = "$(cat /opt/workspace-runtime/workspace-runtime-version)"

# Exercise the canonical session lifecycle without starting an agent server.
RUN node /opt/workspace-runtime/workspace-runtime-image-smoke.mjs

WORKDIR /workspace
