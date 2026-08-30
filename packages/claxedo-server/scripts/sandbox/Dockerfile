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
    test -x /opt/workspace-runtime/node_modules/.bin/claude-agent-acp && \
    test -x /opt/workspace-runtime/node_modules/.bin/codex-acp && \
    chmod 0755 /opt/workspace-runtime/workspace-runtime-host.mjs && \
    ln -sf /opt/workspace-runtime/workspace-runtime-host.mjs /usr/local/bin/workspace-runtime && \
    ln -sf /opt/workspace-runtime/node_modules/.bin/claude-agent-acp /usr/local/bin/claude-agent-acp && \
    ln -sf /opt/workspace-runtime/node_modules/.bin/codex-acp /usr/local/bin/codex-acp && \
    command -v workspace-runtime && \
    test "$(workspace-runtime --version)" = "$(cat /opt/workspace-runtime/workspace-runtime-version)" && \
    command -v claude-agent-acp && \
    command -v codex-acp

# Prove the exact production chain serves the harness-neutral Session contract
# through workspace-runtime and the embedded OpenCode SDK.
RUN set -eu; \
    mkdir -p /tmp/opencode-embedded-smoke; \
    cd /tmp/opencode-embedded-smoke; \
    smoke_id="ses_workgraph_image_smoke_$(printf 'w%.0s' $(seq 1 200))"; \
    export smoke_id; \
    setsid env WORKSPACE_RUNTIME_PORT=2593 WORKSPACE_RUNTIME_HOSTNAME=127.0.0.1 WORKSPACE_RUNTIME_ID=image-smoke WORKSPACE_RUNTIME_RUNNER=opencode WORKSPACE_RUNTIME_DIRECTORY=/tmp/opencode-embedded-smoke workspace-runtime >/tmp/workspace-runtime-smoke.log 2>&1 & \
    runtime_pid=$!; \
    stop_servers() { python3 -c 'import os,signal,sys; os.killpg(int(sys.argv[1]), signal.SIGKILL)' "$runtime_pid" 2>/dev/null || true; }; \
    trap stop_servers EXIT; \
    ready=0; \
    for attempt in $(seq 1 4800); do \
      if curl -fsS -X POST -H 'content-type: application/json' \
        -d "{\"id\":\"$smoke_id\",\"agent\":\"build\",\"model\":{\"providerID\":\"missing-provider\",\"modelID\":\"missing-model\"},\"variant\":\"invalid\"}" \
        'http://127.0.0.1:2593/session?harness=opencode' >/tmp/opencode-embedded-session.json; then ready=1; break; fi; \
      sleep 0.25; \
    done; \
    if [ "$ready" -ne 1 ]; then cat /tmp/workspace-runtime-smoke.log; exit 1; fi; \
    node -e "const fs=require('fs');const value=JSON.parse(fs.readFileSync('/tmp/opencode-embedded-session.json','utf8'));if(value.id!==process.env.smoke_id)throw new Error('Embedded Session did not adopt the requested id')"; \
    curl -fsS -X POST -H 'content-type: application/json' \
      -d '{"messageID":"msg_workgraph_image_failure","parts":[{"type":"text","text":"Prove embedded pre-provider failures are durable."}],"agent":"build","model":{"providerID":"missing-provider","modelID":"missing-model"},"variant":"invalid"}' \
      "http://127.0.0.1:2593/session/$smoke_id/prompt_async?harness=opencode" >/dev/null; \
    failed=0; \
    for attempt in $(seq 1 40); do \
      curl -fsS "http://127.0.0.1:2593/session/$smoke_id" >/tmp/opencode-embedded-failure.json; \
      if node -e "const fs=require('fs');const value=JSON.parse(fs.readFileSync('/tmp/opencode-embedded-failure.json','utf8'));if(value.lastTurn?.status!=='failed')process.exit(1)"; then failed=1; break; fi; \
      sleep 0.25; \
    done; \
    if [ "$failed" -ne 1 ]; then cat /tmp/workspace-runtime-smoke.log; exit 1; fi; \
    curl -fsS -H 'accept-encoding: gzip' "http://127.0.0.1:2593/session/$smoke_id/message?snapshot=1" >/tmp/opencode-embedded-messages.json; \
    node -e "const fs=require('fs');const value=JSON.parse(fs.readFileSync('/tmp/opencode-embedded-messages.json','utf8'));if(!Array.isArray(value.messages)||!Number.isSafeInteger(value.maxEventOrdinal))throw new Error('Embedded Session snapshot was invalid')"; \
    stop_servers; \
    trap - EXIT

WORKDIR /workspace
