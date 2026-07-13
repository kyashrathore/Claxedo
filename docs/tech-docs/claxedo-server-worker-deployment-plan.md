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
- hosted sandbox admin routes,
- personal WorkGraph HTTP routes backed by Convex.

The personal, user-owned WorkGraph is embedded in the hosted server. Signed
identity selects the owner, the service token authenticates in-process Convex
calls, and runtime commands atomically admit Attempts plus fenced launch
outbox records. The scheduled Worker provisions the hosted Stream workspace,
uses runtime-token-authenticated relay routes for Session V2 admission, and
reconciles explicit durable terminal events on later passes. Transport and
terminal failures become durable Attempt attention.

The hosted app imports the Worker-safe WorkGraph domain, service, router, and
Convex adapter. Its import boundary excludes the local Node server, embedded
workspace runtime, local workspace store, local supervisor, local tunnel, and
the Node-only SQLite adapter.

The WorkGraph router is one owner-scoped application contract. Source View and
`intake` paths are backend candidate-admission APIs; the Claxedo app presents
their relevant records through the single personal WorkGraph attention surface.
Connections remains the authority for team credentials, while each WorkGraph
owner supplies a provider identity mapping and saved filters.

## Local Server Boundary

`packages/claxedo-server/src/server.ts` remains the Node/local entrypoint. It
owns local execution, embedded workspace runtime proxying, PTY/process/file
routes, local workspace store access, pages, and the SQLite WorkGraph adapter.
The WorkGraph domain and hosted Convex adapter belong to the Worker-safe
service composition; only the SQLite adapter is Node-only.

## WorkGraph deployment acceptance

The Worker-safe Convex composition, scheduled reconciliation, and hosted
workspace dispatch are implemented in the repository. The current WorkGraph
smoke verifies fail-closed authentication and an optional signed
create/snapshot/delete persistence cycle.

Release acceptance requires a real Convex and Worker staging deployment, signed
cross-user policy checks, hosted Attempt execution, the approved single-surface
browser journey, and retained rollout and recovery evidence. SQLite portable
archive support is local-only today; Convex archive parity and owner-level
permanent deletion remain repository work.

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
