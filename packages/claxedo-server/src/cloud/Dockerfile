FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive
ENV SHELL=/bin/bash

# System tools needed for git clone, native compilation, and process management
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      bash zsh ca-certificates curl git openssh-client \
      procps iproute2 netcat-openbsd \
      python3 make g++ && \
    rm -rf /var/lib/apt/lists/*

# Global CLI tools
RUN npm i -g opencode-ai@latest tsx

# Pre-install workspace-runtime with native deps (better-sqlite3, node-pty)
RUN mkdir -p /opt/workspace-runtime && \
    cd /opt/workspace-runtime && \
    npm init -y && \
    npm install @claxedo/workspace-runtime@dev && \
    test -x /opt/workspace-runtime/node_modules/.bin/claude-agent-acp && \
    test -x /opt/workspace-runtime/node_modules/.bin/codex-acp

WORKDIR /workspace
