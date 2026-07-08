FROM docker.io/cloudflare/sandbox:0.8.9

LABEL org.opencontainers.image.source="https://github.com/kyashrathore/Claxedo"

ENV PATH=/root/.local/bin:/root/.amp/bin:$PATH

# Direct terminal-agent CLIs baked into the image. These are the single biggest
# contributor to image size (opencode ~544MB, claude ~228MB, codex ~218MB,
# gemini ~156MB, pi ~147MB) and the push bottleneck — so they are build-arg
# driven and default to a LEAN set. Pass the full list to restore every runner:
#   --build-arg CLAXEDO_NPM_AGENTS="opencode-ai@1.15.10 @anthropic-ai/claude-code@2.1.150 @openai/codex@0.133.0 @google/gemini-cli@0.43.0 @earendil-works/pi-coding-agent@0.75.5"
# NOTE: `wrangler deploy` cannot inject --build-arg, so the DEFAULT below is what
# ships via wrangler. Override only for local `docker build`.
ARG CLAXEDO_NPM_AGENTS="opencode-ai@1.15.10 @anthropic-ai/claude-code@2.1.150 @openai/codex@0.133.0 @google/gemini-cli@0.43.0 @earendil-works/pi-coding-agent@0.75.5"
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
    command -v opencode && \
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
    test -x /opt/workspace-runtime/node_modules/.bin/claude-agent-acp && \
    test -x /opt/workspace-runtime/node_modules/.bin/codex-acp && \
    printf '#!/usr/bin/env bash\nexec node /opt/workspace-runtime/workspace-runtime-host.mjs "$@"\n' > /usr/local/bin/workspace-runtime && \
    chmod +x /usr/local/bin/workspace-runtime && \
    ln -sf /opt/workspace-runtime/node_modules/.bin/claude-agent-acp /usr/local/bin/claude-agent-acp && \
    ln -sf /opt/workspace-runtime/node_modules/.bin/codex-acp /usr/local/bin/codex-acp && \
    command -v workspace-runtime && \
    command -v claude-agent-acp && \
    command -v codex-acp
