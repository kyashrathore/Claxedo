# Hosted Control Plane Worker

Status: retained code-grounded reference
Last updated: 2026-07-14

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
identity and verified membership select the trusted `(organization, user)`
tenant; public routes expose no tenant selector. The service token authenticates
in-process Convex calls, and runtime commands atomically admit Attempts plus
fenced launch outbox records. The scheduled Worker provisions the hosted Stream
workspace, uses runtime-token-authenticated relay routes for Session V2
admission, and reconciles explicit durable terminal events on later passes.
Transport and terminal failures become durable Attempt attention.

The hosted app imports the Worker-safe WorkGraph domain, service, router, and
Convex adapter. Its import boundary excludes the local Node server, embedded
workspace runtime, local workspace store, local supervisor, local tunnel, and
the Node-only SQLite adapter.

The WorkGraph router is one tenant-scoped application contract. Candidate
admission remains backend vocabulary; the Claxedo app presents relevant records
through Needs you in the one shared WorkspacePanel, without a separate intake,
capture, or onboarding screen. Connections owns organization credentials and
metadata, while each WorkGraph user owns provider identity mappings, filters,
source views, candidates, and bindings inside that organization.

## Local Server Boundary

`packages/claxedo-server/src/server.ts` remains the Node/local entrypoint. It
owns local execution, embedded workspace runtime proxying, PTY/process/file
routes, local workspace store access, pages, and the SQLite WorkGraph adapter.
The WorkGraph domain and hosted Convex adapter belong to the Worker-safe
service composition; only the SQLite adapter is Node-only.

## WorkGraph deployment acceptance

The Worker-safe composition and Convex paths implement trusted tuple-leading
physical tenancy, deterministic migration, bounded workers, archive, cleanup,
and deletion barriers in focused repository verification. The final integrated
Claxedo Server regression and real environment checks remain release gates.

Release acceptance requires a real Convex and Worker staging deployment,
signed cross-tenant policy checks including one user represented in two
organizations, exact capability-catalog verification with explicit unavailable
state, hosted Attempt execution, the approved single-surface browser journey, and
retained rollout and recovery evidence. The Docs v2 adapter seam exists, but
the current legacy Pages surface does not yet supply its triggerable browser
journey. SQLite portable archive support is verified locally; final Convex
archive and tenant-deletion parity must be exercised again against deployed
Convex before release acceptance.

The normal release path is `deploy-control-plane.yml`: additive Convex changes,
then the Worker, then authenticated smoke verification, then the Pages app from
one reviewed SHA. The top-level Convex, Worker, and app workflows share a single
deployment concurrency group. The standalone Convex workflow is an
operator-driven roll-forward for an isolated compatible SHA; production remains
gated by the protected GitHub environment.

## Tests To Check

- `packages/claxedo-server/src/worker.import-graph.test.ts`
- `packages/claxedo-server/src/hosted-app.test.ts`
- `packages/claxedo-server/src/routes/hosted-workspace.test.ts`
- `packages/claxedo-server/src/routes/hosted-internal-relay.test.ts`
- `packages/claxedo-server/src/routes/hosted-sandbox-admin.test.ts`
- `packages/claxedo-server/src/control-plane/hosted-services.test.ts`
- `packages/claxedo-server/src/control-plane/deployment-workflow.test.ts`

## Maintenance Rule

Keep this as a current route/composition reference. Historical porting plans and
Cloudflare rollout notes belong in git history, not in tracked docs.
