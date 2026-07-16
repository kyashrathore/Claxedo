FROM docker.io/cloudflare/sandbox:0.8.9

LABEL org.opencontainers.image.source="https://github.com/kyashrathore/Claxedo"

ENV PATH=/root/.local/bin:/root/.amp/bin:$PATH

# Direct terminal-agent CLIs baked into the image. These are the single biggest
# contributor to image size (opencode ~544MB, claude ~228MB, codex ~218MB,
# gemini ~156MB, pi ~147MB) and the push bottleneck — so they are build-arg
# driven and default to a LEAN set. Pass the full list to restore every runner:
#   --build-arg CLAXEDO_NPM_AGENTS="@anthropic-ai/claude-code@2.1.150 @openai/codex@0.133.0 @google/gemini-cli@0.43.0 @earendil-works/pi-coding-agent@0.75.5"
# NOTE: `wrangler deploy` cannot inject --build-arg, so the DEFAULT below is what
# ships via wrangler. Override only for local `docker build`.
ARG CLAXEDO_NPM_AGENTS="@anthropic-ai/claude-code@2.1.150 @openai/codex@0.133.0 @google/gemini-cli@0.43.0 @earendil-works/pi-coding-agent@0.75.5"
# Set to "1" to also install the curl-based agents (cursor, amp, droid) — adds
# ~430MB and most deployments don't use them, so off by default.
ARG CLAXEDO_CURL_AGENTS="1"

# Install build tools for native deps (better-sqlite3, node-pty)
RUN apt-get update && \
    apt-get install -y --no-install-recommends curl ca-certificates make g++ python3 && \
    rm -rf /var/lib/apt/lists/*

# Global CLI tools used by direct terminal agents and materialized MCP configs.
# tsx is always needed by the runtime; the agent set is configurable above.
RUN npm i -g --min-release-age=2 tsx@4.22.3 ${CLAXEDO_NPM_AGENTS} && \
    if [ "${CLAXEDO_CURL_AGENTS}" = "1" ]; then \
      curl https://cursor.com/install -fsS | bash && \
      curl -fsSL https://ampcode.com/install.sh | bash && \
      curl -fsSL https://app.factory.ai/cli | sh && \
      ln -sf /root/.local/bin/agent /usr/local/bin/agent && \
      ln -sf /root/.local/bin/cursor-agent /usr/local/bin/cursor-agent && \
      ln -sf /root/.local/bin/amp /usr/local/bin/amp && \
      ln -sf /root/.local/bin/droid /usr/local/bin/droid && \
      command -v cursor-agent && command -v amp && command -v droid; \
    fi && \
    command -v claude && \
    command -v codex && \
    command -v gemini && \
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
    command -v opencode && \
    command -v claude-agent-acp && \
    command -v codex-acp

# Fail the image build unless the bundled checkout serves WorkGraph's durable
# Session V2 create contract as JSON (rather than an HTML app-shell fallback).
RUN set -eu; \
    mkdir -p /tmp/opencode-session-v2-smoke; \
    setsid opencode serve --hostname=127.0.0.1 --port=4096 >/tmp/opencode-session-v2.log 2>&1 & \
    pid=$!; \
    stop_server() { python3 -c 'import os,signal,sys; os.killpg(int(sys.argv[1]), signal.SIGKILL)' "$pid" 2>/dev/null || true; }; \
    trap stop_server EXIT; \
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
    stop_server; \
    trap - EXIT

# Load the exact flattened production dependency graph and keep the host alive
# long enough to prove it reached its serving loop. A module-load crash exits
# before timeout and fails the image build; a healthy server is stopped by
# timeout with its documented status 124.
RUN set +e; \
    timeout 5s workspace-runtime >/tmp/workspace-runtime-smoke.log 2>&1; \
    status=$?; \
    set -e; \
    if [ "$status" -ne 124 ]; then cat /tmp/workspace-runtime-smoke.log; exit 1; fi; \
    rm /tmp/workspace-runtime-smoke.log
