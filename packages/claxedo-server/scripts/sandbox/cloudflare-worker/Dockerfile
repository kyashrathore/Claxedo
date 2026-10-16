# better-sqlite3 13 needs Node 22 or later and glibc 2.38 or later; Trixie
# carries both. The Worker starts this image with `sleep infinity` as its
# main process and runs the runtime beside it, so no base entrypoint is used.
FROM node:24.21.0-trixie-slim

LABEL org.opencontainers.image.source="https://github.com/kyashrathore/Claxedo"

ENV PATH=/root/.local/bin:/root/.amp/bin:$PATH
ENV AMP_SKIP_UPDATE_CHECK=1 FACTORY_DROID_AUTO_UPDATE_ENABLED=false

# Direct terminal-agent CLIs baked into the image. These are the single biggest
# contributor to image size (claude ~228MB, codex ~218MB) and the push
# bottleneck, so they are build-arg driven: pass a different CLAXEDO_NPM_AGENTS
# to a local `docker build`.
# NOTE: `wrangler deploy` cannot inject --build-arg, so the DEFAULT below is what
# ships via wrangler.
ARG CLAXEDO_NPM_AGENTS="@anthropic-ai/claude-code@2.1.285 @openai/codex@0.159.2"
ARG CLAXEDO_CURL_AGENTS="1"

# Install build tools for native deps (better-sqlite3, node-pty). `git` is named
# explicitly because the runtime configures a github.com clone header at boot
# and agents clone from inside the sandbox, `procps` because the runtime asks
# `ps` whether any git still runs before it removes a stale shallow.lock, and
# `util-linux` because the Worker launches the runtime under `setsid` and
# `ca-certificates` because it rebuilds the system bundle with the credential
# interception CA on every container start.
RUN apt-get update && \
    apt-get install -y --no-install-recommends bash curl ca-certificates git gzip make g++ procps python3 util-linux xz-utils && \
    rm -rf /var/lib/apt/lists/* && \
    command -v git && command -v ps && command -v setsid && test -s /etc/ssl/certs/ca-certificates.crt

# The driver boots the runtime (as root) with HOME=/home/claxedo, because a
# process the Worker starts inherits no image environment but PATH. Nothing at
# runtime creates it, and git refuses to write its global config into a HOME
# that does not exist.
RUN install -d -m 0700 -o root -g root /home/claxedo

# Harness SDKs and CLIs skip npm's release-age gate: their releases carry the
# protocol changes Claxedo tracks the day they ship (owner exemption,
# 2026-09-30). npm honors these exclusions from 11.17 (Node 24.19); every other
# package, the harness packages' own dependencies included, stays gated. The
# exclusions go to npm's global config: the runtime runs with HOME=/home/claxedo,
# where root's ~/.npmrc is not read.
RUN npmrc="$(npm config get globalconfig)" && mkdir -p "$(dirname "$npmrc")" && printf '%s\n' \
      'min-release-age-exclude[]=@agentclientprotocol/sdk' \
      'min-release-age-exclude[]=@anthropic-ai/claude-*' \
      'min-release-age-exclude[]=@cursor/sdk*' \
      'min-release-age-exclude[]=@earendil-works/*' \
      'min-release-age-exclude[]=@openai/codex' \
      >> "$npmrc"

# Global CLI tools used by direct terminal agents and materialized MCP configs.
# tsx is always needed by the runtime; the agent set is configurable above.
RUN npm i -g --min-release-age=2 tsx@4.22.3 ${CLAXEDO_NPM_AGENTS}

COPY .build/install-agent-artifacts.sh /tmp/install-agent-artifacts.sh
RUN if [ "${CLAXEDO_CURL_AGENTS}" = "1" ]; then \
      sh /tmp/install-agent-artifacts.sh && \
      ln -sf /root/.local/bin/agent /usr/local/bin/agent && \
      ln -sf /root/.local/bin/cursor-agent /usr/local/bin/cursor-agent && \
      ln -sf /root/.amp/bin/amp /usr/local/bin/amp && \
      ln -sf /root/.local/bin/droid /usr/local/bin/droid && \
      command -v cursor-agent && command -v amp && command -v droid; \
    fi && \
    command -v claude && command -v codex

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
    test -x /usr/local/bin/workspace-runtime && \
    command -v workspace-runtime && \
    test "$(workspace-runtime --version)" = "$(cat /opt/workspace-runtime/workspace-runtime-version)"

# Exercise the canonical session lifecycle and one embedded OpenCode turn
# against a loopback stand-in provider, the turn path a cloud VM serves.
RUN node /opt/workspace-runtime/workspace-runtime-image-smoke.mjs

WORKDIR /workspace
