# Claxedo workspace relay — production container image (Fly.io machine, v1).
#
# Build context MUST be the monorepo root (bun workspace install resolves
# @claxedo/workspace-relay-protocol from the sibling package):
#   docker build -f packages/workspace-relay/Dockerfile -t claxedo-workspace-relay .
#
# Pairs with packages/workspace-relay/fly.toml (internal_port 7777, GET /health
# check, kill_signal=SIGTERM — the in-process drain handler owns shutdown;
# during a drain /health deliberately reports 503 so routing stops). Required
# production secrets are documented in fly.toml; the relay fail-closes without
# them (src/main.ts: validateProductionEnv + key loaders).
#
# Like packages/claxedo-server/Dockerfile, this ships SOURCE MODE: the relay is
# a Bun process (`bun src/main.ts`, package.json "start") and Bun runs the
# TypeScript directly. A bundled dist/main.mjs (`bun run build`) exists but the
# proven house pattern is running from the workspace tree.

FROM oven/bun:1.3.14 AS build

WORKDIR /app
COPY . .
# --ignore-scripts: the relay path needs no native postinstalls (node-pty /
# better-sqlite3 belong to other workspace packages; esbuild resolves its
# binary via optionalDependencies). Keeps the image free of node-gyp toolchains
# that claxedo-server's image needs and this one does not.
RUN bun install --frozen-lockfile --ignore-scripts

# @claxedo/workspace-relay-protocol's exports point at its gitignored dist/ —
# the relay imports it at runtime, so a fresh clone MUST build it.
RUN cd packages/workspace-relay-protocol && bun run build

FROM oven/bun:1.3.14 AS runtime

WORKDIR /app
COPY --from=build /app /app

ENV NODE_ENV=production
ENV CLAXEDO_WORKSPACE_RELAY_HOST=0.0.0.0
ENV CLAXEDO_WORKSPACE_RELAY_PORT=7777

EXPOSE 7777
# Mirrors the fly.toml http_service check (GET /health). bun -e avoids a curl
# dependency in the image.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD bun -e "const res = await fetch('http://127.0.0.1:7777/health'); process.exit(res.ok ? 0 : 1)"

WORKDIR /app/packages/workspace-relay
CMD ["bun", "src/main.ts"]
