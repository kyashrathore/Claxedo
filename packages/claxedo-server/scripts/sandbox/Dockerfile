FROM node:22-bookworm-slim

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
      opencode-ai@1.15.10 \
      @anthropic-ai/claude-code@2.1.150 \
      @openai/codex@0.133.0 \
      @google/gemini-cli@0.43.0 \
      @earendil-works/pi-coding-agent@0.75.5 && \
    curl https://cursor.com/install -fsS | bash && \
    curl -fsSL https://ampcode.com/install.sh | bash && \
    curl -fsSL https://app.factory.ai/cli | sh && \
    ln -sf /root/.local/bin/agent /usr/local/bin/agent && \
    ln -sf /root/.local/bin/cursor-agent /usr/local/bin/cursor-agent && \
    ln -sf /root/.local/bin/amp /usr/local/bin/amp && \
    ln -sf /root/.local/bin/droid /usr/local/bin/droid && \
    command -v opencode && \
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
# package.json pinning the native modules and ACP bins that cannot be bundled.
# Images are reproducible from the repo at a pinned commit; npm publishing of
# @claxedo/workspace-runtime is a release concern and does not gate builds.
COPY .build/ /opt/workspace-runtime/
RUN cd /opt/workspace-runtime && \
    npm install --omit=dev --min-release-age=2 --legacy-peer-deps && \
    test -f /opt/workspace-runtime/workspace-runtime-host.mjs && \
    test -x /opt/workspace-runtime/opencode && \
    test -x /opt/workspace-runtime/node_modules/.bin/claude-agent-acp && \
    test -x /opt/workspace-runtime/node_modules/.bin/codex-acp && \
    printf '#!/usr/bin/env bash\nexec node /opt/workspace-runtime/workspace-runtime-host.mjs "$@"\n' > /usr/local/bin/workspace-runtime && \
    chmod +x /usr/local/bin/workspace-runtime && \
    install -m 0755 /opt/workspace-runtime/opencode /usr/local/bin/opencode && \
    ln -sf /opt/workspace-runtime/node_modules/.bin/claude-agent-acp /usr/local/bin/claude-agent-acp && \
    ln -sf /opt/workspace-runtime/node_modules/.bin/codex-acp /usr/local/bin/codex-acp && \
    command -v workspace-runtime && \
    command -v claude-agent-acp && \
    command -v codex-acp

# Prove the exact OpenCode binary shipped with the runtime serves the durable
# Session V2 contract WorkGraph uses. An HTML app-shell fallback must fail the
# image build instead of reaching staging as a false-positive workspace.
RUN set -eu; \
    mkdir -p /tmp/opencode-session-v2-smoke; \
    opencode serve --hostname=127.0.0.1 --port=4096 >/tmp/opencode-session-v2.log 2>&1 & \
    pid=$!; \
    trap 'kill "$pid" 2>/dev/null || true' EXIT; \
    ready=0; \
    for attempt in $(seq 1 60); do \
      if curl -fsS -X POST \
        -H 'content-type: application/json' \
        -d '{"id":"ses_workgraph_image_smoke","location":{"directory":"/tmp/opencode-session-v2-smoke"}}' \
        http://127.0.0.1:4096/api/session >/tmp/opencode-session-v2.json; then ready=1; break; fi; \
      sleep 0.25; \
    done; \
    if [ "$ready" -ne 1 ]; then cat /tmp/opencode-session-v2.log; exit 1; fi; \
    node -e "const fs=require('fs');const value=JSON.parse(fs.readFileSync('/tmp/opencode-session-v2.json','utf8'));const id=value.id||value.data?.id;if(id!=='ses_workgraph_image_smoke')throw new Error('Session V2 create did not adopt the requested id')"; \
    kill "$pid"; \
    wait "$pid" || true; \
    trap - EXIT

# Prove the flattened production dependency graph reaches the serving loop.
# A healthy host is stopped by GNU timeout with status 124; any module-load or
# startup crash exits earlier and fails the image build with its captured log.
RUN set +e; \
    timeout 5s workspace-runtime >/tmp/workspace-runtime-smoke.log 2>&1; \
    status=$?; \
    set -e; \
    if [ "$status" -ne 124 ]; then cat /tmp/workspace-runtime-smoke.log; exit 1; fi; \
    rm /tmp/workspace-runtime-smoke.log

WORKDIR /workspace
