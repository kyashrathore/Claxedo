FROM docker.io/cloudflare/sandbox:0.8.9

# Install build tools for native deps (better-sqlite3, node-pty)
RUN apt-get update && \
    apt-get install -y --no-install-recommends make g++ python3 && \
    rm -rf /var/lib/apt/lists/*

# Install global tools
RUN npm i -g opencode-ai@latest tsx

# Pre-install workspace-runtime with native deps
RUN mkdir -p /opt/workspace-runtime && \
    cd /opt/workspace-runtime && \
    npm init -y && \
    npm install @claxedo/workspace-runtime@dev
