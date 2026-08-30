# Claxedo control plane — self-host container image.
#
# Build context MUST be the monorepo root (the server runs from source and
# reaches sibling workspace packages):
#   docker build -f packages/claxedo-server/Dockerfile -t claxedo-control-plane .
#

FROM node:22-bookworm-slim AS build

# Bun drives workspace installation and builds; Node runs the server.
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

# better-sqlite3 ships a prebuilt binary linked against GLIBC_2.38. This image
# is bookworm (glibc 2.36), so the prebuild loads and then dies at the first
# `new Database()` with `ERR_DLOPEN_FAILED ... GLIBC_2.38 not found` — after a
# clean build, a healthy-looking start, and the log line "opening claxedo
# database". Compiling from source against THIS image's glibc is the fix; the
# node-gyp installed above exists for exactly this and was never invoked.
# `rm -rf build prebuilds` first, and it is not defensive tidying. The install
# layer leaves a `build/` whose make stamps already say "done", so `node-gyp
# rebuild` reports `gyp info ok` after only TOUCHing two stamp files and
# emitting no binary — a green step that compiled nothing. `prebuilds/` goes
# too, so the wrong-glibc artifact cannot be picked up again if the compile is
# ever skipped.
#
# `node-gyp rebuild`, not `npm rebuild`: run inside a package directory, npm
# rebuilds that package's DEPENDENCIES, not the package itself. It reports
# "rebuilt dependencies successfully" in two seconds and produces nothing —
# which is what the `test -f` below caught.
RUN cd node_modules/.bun/better-sqlite3@*/node_modules/better-sqlite3 \
    && rm -rf build prebuilds \
    && node-gyp rebuild --release \
    && test -f build/Release/better_sqlite3.node

# Build workspace packages whose `main`/exports point at a gitignored dist/.
# claxedo-server imports these as @claxedo/* (resolving to dist even under the
# development condition), so a fresh clone MUST build them or the import fails.
RUN for pkg in agent-event-runtime agent-sdk-runtime workspace-runtime sandbox-manager claxedo-connections claxedo-channels; do \
      (cd "packages/$pkg" && bun run build); \
    done

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
