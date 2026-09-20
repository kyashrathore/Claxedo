# Claxedo control plane — self-host container image.
#
# Build context MUST be the monorepo root (the server runs from source and
# reaches sibling workspace packages):
#   docker build -f packages/claxedo-server/Dockerfile -t claxedo-control-plane .
#
FROM node:22-bookworm-slim AS build

# Bun drives workspace install and package builds; Node runs the server.
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

# better-sqlite3's prebuilt binary links GLIBC_2.38; bookworm has 2.36, so the
# prebuild loads and dies at the first `new Database()` with ERR_DLOPEN_FAILED.
# Compile against this image's glibc instead. `rm -rf build prebuilds` first:
# the install layer leaves a `build/` whose make stamps say "done", so a bare
# `node-gyp rebuild` touches two stamps, emits no binary, and reports ok; and a
# surviving `prebuilds/` would be picked up again if the compile were skipped.
# `node-gyp rebuild`, not `npm rebuild`: inside a package directory npm rebuilds
# that package's dependencies, not the package, and produces nothing.
RUN cd node_modules/.bun/better-sqlite3@*/node_modules/better-sqlite3 \
    && rm -rf build prebuilds \
    && node-gyp rebuild --release \
    && test -f build/Release/better_sqlite3.node

# The runtime stage runs under Node, whose `import` condition resolves the
# @claxedo/* workspace packages through their gitignored dist/. Build them with
# the one list the repo maintains (root package.json `build:packages`).
RUN bun run build:packages

# Web UI bundle, served by the control plane itself (CLAXEDO_APP_DIST_DIR
# below). Empty VITE_* URLs → the app calls its own origin, so one process
# serves both the UI and the API on any host name.
# NODE_OPTIONS is set here and not inherited: the ENV further down belongs to
# the runtime stage. Node sizes its default heap from the cgroup, so the same
# build passes outside Docker and dies with `Reached heap limit` inside it.
# 4096 rather than the runtime's 2048: this bundle emits hidden sourcemaps.
RUN cd packages/claxedo-app && VITE_CLAXEDO_SERVER_URL="" \
    NODE_OPTIONS=--max-old-space-size=4096 \
    node ./node_modules/vite/bin/vite.js build --config vite.cloud.config.ts --outDir dist-selfhost

FROM node:22-bookworm-slim AS runtime

# git: sessions clone/operate on repos. openssh-client: git-over-ssh remotes.
RUN apt-get update && apt-get install -y --no-install-recommends \
    git openssh-client ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=build /app /app

# The server runs from TypeScript source via tsx (the CMD's `development`
# condition resolves workspace packages that export src); claxedo-server itself
# has no dist build.
ENV NODE_ENV=production
ENV CLAXEDO_SERVER_HOST=0.0.0.0
ENV CLAXEDO_SERVER_PORT=3001
# Serve the in-image web UI bundle from the control plane.
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
