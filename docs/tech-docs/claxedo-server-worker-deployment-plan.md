# Hosted Control Plane Worker

Status: retained code-grounded reference
Last updated: 2026-07-09

This document is retained because `public-docs/hosted-control-plane-worker.md`,
`packages/claxedo-server/src/worker.ts`, `packages/claxedo-server/wrangler.toml`,
and `packages/claxedo-server/src/architecture.test.ts` point here.

## Current Implementation

- Worker entrypoint: `packages/claxedo-server/src/worker.ts`
- Worker-safe Hono app: `packages/claxedo-server/src/hosted-app.ts`
- Hosted services composition:
  `packages/claxedo-server/src/control-plane/hosted-services.ts`
- Worker credentials:
  `packages/claxedo-server/src/control-plane/worker-credentials.ts`
- Worker telemetry:
  `packages/claxedo-server/src/control-plane/worker-telemetry.ts`
- Import-graph guard:
  `packages/claxedo-server/src/worker.import-graph.test.ts`
- Deployment config: `packages/claxedo-server/wrangler.toml`

## Hosted Surface

`createHostedApp()` mounts the Worker-safe hosted control-plane subset:

- health, mode, compatibility, bootstrap, and hosted shell routes,
- JWKS,
- device-login routes,
- hosted workspace connection/register/heartbeat/pause routes,
- hosted control routes,
- internal relay target/revocation routes,
- hosted sandbox admin routes.

The hosted app deliberately does not import the local Node server, embedded
workspace runtime, local workspace store, local supervisor, local tunnel, or
SQLite-only route implementations.

## Local Server Boundary

`packages/claxedo-server/src/server.ts` remains the Node/local entrypoint. It
owns local execution, embedded workspace runtime proxying, PTY/process/file
routes, local workspace store access, pages, WorkGraph mounting, and other
Node-only integrations.

## Tests To Check

- `packages/claxedo-server/src/worker.import-graph.test.ts`
- `packages/claxedo-server/src/hosted-app.test.ts`
- `packages/claxedo-server/src/routes/hosted-workspace.test.ts`
- `packages/claxedo-server/src/routes/hosted-internal-relay.test.ts`
- `packages/claxedo-server/src/routes/hosted-sandbox-admin.test.ts`
- `packages/claxedo-server/src/control-plane/hosted-services.test.ts`

## Maintenance Rule

Keep this as a current route/composition reference. Historical porting plans and
Cloudflare rollout notes belong in git history, not in tracked docs.
