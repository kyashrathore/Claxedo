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
# package.json pinning the native modules that cannot be bundled.
# Images are reproducible from the repo at a pinned commit; npm publishing of
# @claxedo/workspace-runtime is a release concern and does not gate builds.
COPY .build/ /opt/workspace-runtime/
RUN cd /opt/workspace-runtime && \
    npm install --omit=dev --min-release-age=2 --legacy-peer-deps && \
    test -f /opt/workspace-runtime/workspace-runtime-host.mjs && \
    test -x /opt/workspace-runtime/opencode && \
    chmod 0755 /opt/workspace-runtime/workspace-runtime-host.mjs && \
    ln -sf /opt/workspace-runtime/workspace-runtime-host.mjs /usr/local/bin/workspace-runtime && \
    install -m 0755 /opt/workspace-runtime/opencode /usr/local/bin/opencode && \
    command -v workspace-runtime && \
    test "$(workspace-runtime --version)" = "$(cat /opt/workspace-runtime/workspace-runtime-version)" && \
    command -v opencode

# Prove the exact production chain serves WorkGraph's durable Session V2
# contract through workspace-runtime, including a compressed history page.
RUN set -eu; \
    mkdir -p /tmp/opencode-session-v2-smoke; \
    cd /tmp/opencode-session-v2-smoke; \
    # WorkGraph derives a Run's session id from a run id carrying the owner,
    # operation, and work-item ids, so production ids run to ~250 characters.
    # A short id here would pass against a router that silently refuses to match
    # path parameters over 100 chars — which is exactly how that bug reached
    # staging, creating Sessions that every later route reported as absent.
    smoke_id="ses_workgraph_image_smoke_$(printf 'w%.0s' $(seq 1 200))"; \
    failure_id="ses_workgraph_image_failure_$(printf 'f%.0s' $(seq 1 200))"; \
    export smoke_id failure_id; \
    setsid env OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER=true opencode serve --hostname=127.0.0.1 --port=4096 >/tmp/opencode-session-v2.log 2>&1 & \
    engine_pid=$!; \
    setsid env WORKSPACE_RUNTIME_PORT=2593 WORKSPACE_RUNTIME_HOSTNAME=127.0.0.1 WORKSPACE_RUNTIME_ID=image-smoke WORKSPACE_RUNTIME_DIRECTORY=/tmp/opencode-session-v2-smoke OPENCODE_URL=http://127.0.0.1:4096 workspace-runtime >/tmp/workspace-runtime-smoke.log 2>&1 & \
    runtime_pid=$!; \
    stop_servers() { python3 -c 'import os,signal,sys; os.killpg(int(sys.argv[1]), signal.SIGKILL)' "$runtime_pid" 2>/dev/null || true; python3 -c 'import os,signal,sys; os.killpg(int(sys.argv[1]), signal.SIGKILL)' "$engine_pid" 2>/dev/null || true; }; \
    trap stop_servers EXIT; \
    ready=0; \
    for attempt in $(seq 1 4800); do \
      if curl -fsS -X POST \
        -H 'content-type: application/json' \
        -d "{\"id\":\"$smoke_id\",\"location\":{\"directory\":\"/tmp/opencode-session-v2-smoke\"}}" \
        http://127.0.0.1:2593/api/session >/tmp/opencode-session-v2.json; then ready=1; break; fi; \
      sleep 0.25; \
    done; \
    if [ "$ready" -ne 1 ]; then cat /tmp/opencode-session-v2.log /tmp/workspace-runtime-smoke.log; exit 1; fi; \
    node -e "const fs=require('fs');const value=JSON.parse(fs.readFileSync('/tmp/opencode-session-v2.json','utf8'));const id=value.id||value.data?.id;if(id!==process.env.smoke_id)throw new Error('Session V2 create did not adopt the requested id')"; \
    for sequence in $(seq 1 20); do \
      curl -fsS -X POST -H 'content-type: application/json' \
        -d "{\"id\":\"msg_workgraph_image_smoke_$sequence\",\"prompt\":{\"text\":\"Durable image smoke prompt $sequence with enough repeated content to force response compression through the proxy boundary.\"},\"resume\":false}" \
        "http://127.0.0.1:2593/api/session/$smoke_id/prompt" >/dev/null; \
    done; \
    curl -fsS -H 'accept-encoding: gzip' "http://127.0.0.1:2593/api/session/$smoke_id/history?limit=100&after=0" >/tmp/opencode-session-v2-history.json; \
    node -e "const fs=require('fs');const value=JSON.parse(fs.readFileSync('/tmp/opencode-session-v2-history.json','utf8'));if(!Array.isArray(value.data)||value.data.length!==20)throw new Error('Session V2 history was truncated across workspace-runtime')"; \
    curl -fsS -X POST -H 'content-type: application/json' \
      -d "{\"id\":\"$failure_id\",\"agent\":\"build\",\"model\":{\"providerID\":\"missing-provider\",\"id\":\"missing-model\",\"variant\":\"invalid\"},\"location\":{\"directory\":\"/tmp/opencode-session-v2-smoke\"}}" \
      http://127.0.0.1:2593/api/session >/dev/null; \
    curl -fsS -X POST -H 'content-type: application/json' \
      -d '{"id":"msg_workgraph_image_failure","prompt":{"text":"Prove pre-provider failures are durable."},"resume":true}' \
      "http://127.0.0.1:2593/api/session/$failure_id/prompt" >/dev/null; \
    failed=0; \
    for attempt in $(seq 1 40); do \
      curl -fsS "http://127.0.0.1:2593/api/session/$failure_id/history?limit=100&after=0" >/tmp/opencode-session-v2-failure.json; \
      if node -e "const fs=require('fs');const value=JSON.parse(fs.readFileSync('/tmp/opencode-session-v2-failure.json','utf8'));if(!value.data?.some((event)=>event.type.startsWith('session.next.step.failed')))process.exit(1)"; then failed=1; break; fi; \
      sleep 0.25; \
    done; \
    if [ "$failed" -ne 1 ]; then cat /tmp/opencode-session-v2.log /tmp/workspace-runtime-smoke.log; exit 1; fi; \
    stop_servers; \
    trap - EXIT

WORKDIR /workspace
