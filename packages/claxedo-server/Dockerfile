# Claxedo control plane — self-host container image.
#
# Build context MUST be the monorepo root (the server runs from source and
# reaches sibling workspace packages):
#   docker build -f packages/claxedo-server/Dockerfile -t claxedo-control-plane .
#
# The embedded OpenCode engine is built inside the image (needs network at
# build time: the engine build fetches models.dev; override via
# MODELS_DEV_API_JSON / OPENCODE_MODELS_URL for air-gapped builds).

FROM node:22-bookworm-slim AS build

# Bun drives workspace install + the engine build; Node runs the server.
COPY --from=oven/bun:1.3.14 /usr/local/bin/bun /usr/local/bin/bun

RUN apt-get update && apt-get install -y --no-install-recommends \
    git ca-certificates python3 make g++ \
    && rm -rf /var/lib/apt/lists/* \
    # node-pty (and friends) compile from source on platforms without
    # prebuilds; bun does not vend node-gyp, so provide it via npm.
    && npm install -g node-gyp

WORKDIR /app
COPY . .
RUN bun install --frozen-lockfile

# Build workspace packages whose `main`/exports point at a gitignored dist/.
# claxedo-server imports these as @claxedo/* (resolving to dist even under the
# development condition), so a fresh clone MUST build them or the import fails.
RUN for pkg in agent-event-runtime agent-sdk-runtime workspace-runtime sandbox-manager claxedo-connections claxedo-channels; do \
      (cd "packages/$pkg" && bun run build); \
    done

# Build the embedded engine artifact (opencode/node-embed -> dist/node/node.js).
# OPENCODE_CHANNEL/OPENCODE_VERSION bypass the build script's git-metadata
# lookups (.git is deliberately excluded from the build context).
RUN cd packages/opencode && OPENCODE_CHANNEL=selfhost OPENCODE_VERSION=0.0.0-selfhost bun run build:node

# Web UI bundle (W2): served by the control plane itself (CLAXEDO_APP_DIST_DIR
# below). Empty VITE_* URLs → the app calls its own origin, so one process
# serves both the UI and the API on any host name.
# NODE_OPTIONS is set here and not inherited: the ENV further down belongs to
# the RUNTIME stage, so this build ran on the container default heap and died
# with `FATAL ERROR: Reached heap limit` (exit 134). Node sizes its default heap
# from the cgroup, not the host, so the same build succeeds outside Docker and
# fails inside it — which is why nothing caught this until the image was built.
# 4096 rather than the runtime's 2048 because this bundle emits hidden
# sourcemaps, and those are what the heap is spent on.
RUN cd packages/claxedo-app && VITE_CLAXEDO_SERVER_URL="" VITE_OPENCODE_BACKEND_URL="" VITE_AUTH_ENABLED=false \
    NODE_OPTIONS=--max-old-space-size=4096 \
    node ./node_modules/vite/bin/vite.js build --config vite.cloud.config.ts --outDir dist-selfhost

FROM node:22-bookworm-slim AS runtime

# git: sessions clone/operate on repos. openssh-client: git-over-ssh remotes.
RUN apt-get update && apt-get install -y --no-install-recommends \
    git openssh-client ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=build /app /app

# Deliberate: the server runs from TypeScript source via tsx, and workspace
# packages export src under the "development" condition — there is no dist
# build for claxedo-server (v1 ships source-mode; dist-mode is future work).
ENV NODE_ENV=production
ENV CLAXEDO_SERVER_HOST=0.0.0.0
ENV CLAXEDO_SERVER_PORT=3001
# Serve the in-image web UI bundle from the control plane (W2 parity).
ENV CLAXEDO_APP_DIST_DIR=/app/packages/claxedo-app/dist-selfhost
# The embedded engine runs in a worker thread. Worker threads get a small
# default V8 heap in a container (unlike the main thread, which auto-sizes to
# machine RAM), so the engine OOM-crash-loops without an explicit cap. This
# propagates to the worker; keep it well under the machine memory. Verified:
# /provider loads fine at 1536MB locally.
ENV NODE_OPTIONS=--max-old-space-size=2048
# Persistent state (SQLite central store + authority + runtime data). Mount a
# volume here.
ENV CLAXEDO_DATA_DIR=/data
RUN mkdir -p /data

EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD curl -fsS http://127.0.0.1:3001/api/claxedo/health || exit 1

WORKDIR /app/packages/claxedo-server
CMD ["node", "--conditions=development", "--import", "../workspace-runtime/src/text-imports.mjs", "--import", "tsx", "src/deployments/self-hosted-node/index.ts"]
