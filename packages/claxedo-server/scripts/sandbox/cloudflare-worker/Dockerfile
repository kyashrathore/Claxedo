FROM docker.io/cloudflare/sandbox:0.12.9

LABEL org.opencontainers.image.source="https://github.com/kyashrathore/Claxedo"

ENV PATH=/root/.local/bin:/root/.amp/bin:$PATH

# Direct terminal-agent CLIs baked into the image. These are the single biggest
# contributor to image size (claude ~228MB, codex ~218MB,
# gemini ~156MB, pi ~147MB) and the push bottleneck — so they are build-arg
# driven and default to a LEAN set. Pass the full list to restore every runner:
#   --build-arg CLAXEDO_NPM_AGENTS="@anthropic-ai/claude-code@2.1.150 @openai/codex@0.133.0 @google/gemini-cli@0.43.0 @earendil-works/pi-coding-agent@0.85.0"
# NOTE: `wrangler deploy` cannot inject --build-arg, so the DEFAULT below is what
# ships via wrangler. Override only for local `docker build`.
ARG CLAXEDO_NPM_AGENTS="@anthropic-ai/claude-code@2.1.150 @openai/codex@0.133.0 @google/gemini-cli@0.43.0 @earendil-works/pi-coding-agent@0.85.0"
# Set to "1" to also install the curl-based agents (cursor, amp, droid) — adds
# ~430MB and most deployments don't use them, so off by default.
ARG CLAXEDO_CURL_AGENTS="1"

# Install build tools for native deps (better-sqlite3, node-pty). `git` is named
# explicitly because the runtime configures a github.com clone header at boot
# and agents clone from inside the sandbox; whether the base image happens to
# carry it is not something this image should depend on.
RUN apt-get update && \
    apt-get install -y --no-install-recommends curl ca-certificates git make g++ python3 xz-utils && \
    rm -rf /var/lib/apt/lists/* && \
    command -v git

# The cloudflare/sandbox base ships Node 20, under which better-sqlite3 13.x
# SEGFAULTS on load (verified in-image: node20 `new Database(':memory:')`
# crashes, the same install under node22 works) — workspace-runtime died
# silently at boot and the image smoke burned its whole readiness ceiling.
# The public SDK also uses syntax unavailable on Node 22. Install Node 24
# (the same major as Electron 43 and the ghcr image) ahead of the base's node
# on PATH; the sandbox's own container
# server is a self-contained binary and does not resolve node from PATH.
RUN curl -fsSL https://nodejs.org/dist/v24.18.0/node-v24.18.0-linux-x64.tar.xz -o /tmp/node24.tar.xz && \
    mkdir -p /opt/node-24 && \
    tar -xJf /tmp/node24.tar.xz -C /opt/node-24 --strip-components=1 && \
    rm /tmp/node24.tar.xz && \
    /opt/node-24/bin/node --version
ENV PATH=/opt/node-24/bin:$PATH

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
# package.json pinning the native modules that cannot be bundled.
# Images are reproducible from the repo at a pinned commit; npm publishing of
# @claxedo/workspace-runtime is a release concern and does not gate builds.
COPY .build/ /opt/workspace-runtime/
RUN cd /opt/workspace-runtime && \
    npm install --omit=dev --min-release-age=2 --legacy-peer-deps && \
    test -f /opt/workspace-runtime/workspace-runtime-host.mjs && \
    chmod 0755 /opt/workspace-runtime/workspace-runtime-host.mjs && \
    ln -sf /opt/workspace-runtime/workspace-runtime-host.mjs /usr/local/bin/workspace-runtime && \
    test -x /usr/local/bin/workspace-runtime && \
    command -v workspace-runtime && \
    test "$(workspace-runtime --version)" = "$(cat /opt/workspace-runtime/workspace-runtime-version)"

# Exercise the canonical session lifecycle without starting an agent server.
RUN node /opt/workspace-runtime/workspace-runtime-image-smoke.mjs
