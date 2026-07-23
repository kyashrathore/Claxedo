# Hosted and Self-Hosted Persistence Profiles

Status: PLANNED
Date: 2026-07-22

## Purpose

Claxedo supports two first-class deployment profiles:

| Profile | Runtime | Authentication | Authority and hosted state | Session runtime state |
|---|---|---|---|---|
| `cloudflare-hosted` | Cloudflare Workers, Durable Objects, and sandbox execution | Clerk | Convex | Authority-backed hosted services and sandbox runtimes |
| `single-node-self-hosted` | One persistent Node process | Embedded Better Auth | SQLite | SQLite |

Cloudflare is the primary hosted deployment target. Convex provides the shared,
multi-writer state already used by the Worker composition, while Clerk supplies
hosted identity and organization claims.

The self-hosted profile optimizes for a different constraint: a person can run
one Claxedo node with a persistent volume and no required identity or database
SaaS. Embedded Better Auth supplies local signup, login, and sessions. SQLite
stores the control-plane authority and the Node session runtime.

The storage boundary exists to support these two product profiles with the same
control-plane behavior. Backend support is advertised through complete,
profile-level compositions rather than independently mixable database names.

## Product rationale

### Why storage is swappable

The hosted and self-hosted runtimes cannot share one physical persistence
implementation:

- a Cloudflare Worker has no durable local filesystem for a SQLite database;
- a single-node self-host should not require Convex or another remote database;
- both deployments still need the same workspace, project, session, share,
  runtime-token, extension-policy, and host-link semantics.

`WorkspaceAuthority` is therefore the portable persistence contract. Convex and
SQLite implement that contract for their respective profiles. Shared services
depend on the contract rather than importing either backend.

Authentication is a parallel composition boundary. Clerk and embedded Better
Auth both produce the signed principal consumed by the control plane, but their
provider state remains provider-owned:

- Clerk owns hosted identity state outside the Worker;
- embedded Better Auth owns `embedded-auth.sqlite` in the self-host data
  directory and runs its migrations in-process.

Better Auth support is delivered by a complete self-hosted composition that
pairs Better Auth with the SQLite authority and verifies that identity
resolution survives restart.

### Postgres follows a concrete Node deployment requirement

A shared SQL database does not by itself make the Node runtime horizontally
scalable. Multi-instance Node also requires distributed session ownership,
fencing, PTY and workspace affinity, cross-instance event fan-out, durable
wakes, and timer ownership. Those coordination capabilities are designed as a
separate deployment architecture.

The initial self-hosted promise is one Node process and one persistent volume.
SQLite is proportional to that promise. A Postgres profile becomes first-class
when there is a supported Node clustering design or a concrete single-node
operator requirement that justifies the additional adapter, migrations, pool
lifecycle, and conformance surface.

### Convex is the initial Cloudflare store

The hosted Worker currently relies on Convex for more than
`WorkspaceAuthority`, including WorkGraph state, leases, billing state,
connection metadata, and relay-target resolution. Replacing only the authority
store with D1 would not produce a Convex-free Cloudflare deployment.

The first-class Cloudflare profile therefore uses Convex consistently. A future
D1 profile is defined only when every required hosted capability has a D1,
Durable Object, R2, or KV owner and the assembled profile passes its own remote
acceptance suite.

## Scope

This plan owns:

1. the normative `WorkspaceAuthority` contract shared by SQLite and Convex;
2. explicit composition of the two first-class deployment profiles;
3. profile-specific authentication composition;
4. migration, readiness, restart, and public-API journey evidence;
5. documentation of every persistent resource required by each profile.

The Node-only `ProjectionStore` and `DurableSessionLog` remain explicit service
boundaries, but SQLite is their only required implementation in this plan. They
do not need portability-driven API changes until a second complete session
runtime profile requires them.

Hosted systems retain storage boundaries appropriate to their services:

- Convex for authority, WorkGraph, lease, billing, connection, and relay lookup
  state;
- R2 for hosted documents and blobs;
- Durable Objects for named coordination, wake lanes, and live-sync fan-out;
- encrypted Cloudflare KV for enabled hosted credential storage;
- the selected sandbox provider for workspace execution state.

## Deployment profile contracts

### `cloudflare-hosted`

The production composition is `src/worker.ts` through `src/hosted-app.ts` and
`control-plane/hosted-services.ts`.

The profile requires:

- `CLAXEDO_DEPLOYMENT_MODE=hosted`;
- Clerk issuer and JWKS configuration;
- a Convex workspace-authority URL and service token;
- the configured relay, signing, sandbox, R2, Durable Object, and optional
  encrypted credential bindings required by mounted capabilities;
- a Worker-safe import graph.

The profile fails boot before routes mount when a required dependency is
missing or unhealthy. Its capability declaration reflects the Worker surface:
authority-backed session access and sandbox relay are available; the in-process
Node central session runtime is not mounted.

The Cloudflare profile is accepted only when a deployed Worker journey proves:

1. Clerk token verification and durable subject/org resolution;
2. workspace creation and authorized retrieval through Convex;
3. sandbox provisioning and relay-token issuance;
4. WorkGraph creation, wake, settlement, and restart-safe observation;
5. document persistence through R2;
6. live-sync fan-out through Durable Objects;
7. fail-closed behavior for missing auth, authority, or signing configuration.

Fast PR tests use Worker-local fixtures where appropriate. Release evidence uses
a real Cloudflare staging deployment and an isolated Convex deployment.

### `single-node-self-hosted`

The production composition is the Node server with:

- embedded Better Auth enabled for signed local accounts;
- SQLite `WorkspaceAuthority`;
- SQLite `ProjectionStore` and `DurableSessionLog`;
- local execution and the existing Node-only services;
- one persistent data directory owned by one running process.

The deployment tooling enables `CLAXEDO_EMBEDDED_AUTH=1` for the signed
self-hosted profile. Better Auth owns its schema and migrations in
`embedded-auth.sqlite`. The authority and central runtime retain independent
SQLite schemas and lifecycles.

The initial identity model provides local signup, login, bearer sessions, and a
personal organization for each account. Shared organizations, invitations, and
organization-scoped Better Auth claims are a separate product capability with
their own source-of-truth and migration design.

The self-hosted profile is accepted only when a packaged deployment journey
proves:

1. first-user signup and login without Clerk or Convex configuration;
2. authenticated workspace, project, and session creation;
3. durable message/event persistence;
4. process restart with the same login session and authority identity;
5. clean rejection of cross-account access;
6. schema upgrade from the previous released version;
7. actionable startup failure for an unwritable data directory, corrupt
   database, failed migration, or invalid auth secret configuration.

The documented backup unit contains `authority.db`, `claxedo.db`,
`embedded-auth.sqlite`, and the persisted embedded-auth secret. Backup and
restore documentation states the process quiescence requirement so the files
form one consistent deployment snapshot.

### Compatibility composition

The existing Node composition with Convex authority and SQLite central-runtime
state remains available for current operators. It is a compatibility
composition rather than a third first-class product profile. Changes to it must
continue to pass authority conformance and its existing integration tests, but
it does not expand the launch scope.

## Normative authority semantics

The `WorkspaceAuthority` contract defines product behavior independently of its
SQLite and Convex implementations.

All implementations provide:

- **Tenant isolation:** org-, project-, and workspace-scoped reads and writes
  remain inside the authorized scope.
- **Role precedence:** owner, workspace, project, org, and share grants resolve
  through one documented precedence table.
- **Absence versus failure:** documented not-found or empty results represent
  absent data; backend failures and malformed stored data reject with typed
  storage errors.
- **Idempotency:** retry-safe operations name their idempotency key and return
  an equivalent result on exact replay.
- **Atomicity:** multi-row invariants state their transaction boundary,
  including share grant/revoke and replacement of session visibility.
- **Ordering:** session messages use a stable per-session order.
- **Concurrency:** mutable operations declare last-write-wins,
  compare-and-swap, insert-if-absent, or serialized transaction behavior.
- **Read-after-write:** a successful mutation followed by a dependent read in
  the same request flow observes that mutation.
- **Representation:** timestamps, JSON values, nullable fields, identifiers,
  and pagination order have one backend-independent wire representation.

The authority conformance suite covers every `WorkspaceAuthority` method,
including:

- identity creation and exact retry;
- personal-org resolution and role precedence;
- deleted and revoked visibility;
- local-host challenge expiry, signature replay, pause, and heartbeat expiry;
- runtime-token creation, expiry, and revocation;
- Agent Extension install and policy precedence;
- session visibility, message ordering, and tenant isolation;
- service-authenticated and user-authenticated call paths;
- injected read and write failures.

SQLite and Convex run the same suite against real backend fixtures. Focused
executor tests may use fakes, but they do not substitute for backend
conformance.

## Persistence ownership manifest

W0 adds a checked-in manifest that maps persistent resources to their service
owner and deployment profile.

For the self-hosted profile it includes:

- all 17 authority tables in `authority.db`;
- the port-owned and adjacent tables in `claxedo.db`;
- Better Auth tables in `embedded-auth.sqlite`;
- the persisted auth secret and other filesystem state needed for restore.

For the Cloudflare profile it includes:

- Convex tables, indexes, functions, and crons by owning capability;
- R2 buckets;
- Durable Object namespaces and migrations;
- KV namespaces used for enabled credential storage;
- external sandbox-provider state and reconciliation ownership.

The manifest is the source for readiness checks, backup guidance, deployment
documentation, and capability claims. It keeps service-specific storage visible
without forcing it into one database interface.

## Composition rules

Profile selection occurs at the composition root, not through independent
backend selectors for each port.

### Cloudflare composition

`worker.ts` always selects Clerk and Convex. Configuration resolves concrete
bindings, URLs, and credentials; it does not select SQLite, Postgres, or D1.
Startup logs the profile and dependency health without logging credentials.

### Self-hosted composition

The self-host deployment path selects embedded Better Auth and SQLite. Database
paths derive from the persistent data directory. Startup applies migrations,
probes each database, verifies the auth secret, and mounts routes only after the
profile is ready.

Development-only unsigned mode may remain available for local development. It
is not the documented production self-host profile.

### Capability validation

Every composition exports a capability declaration consumed by route mounting,
readiness, telemetry, and tests. A route that requires an unavailable capability
is absent or returns the documented unavailable response; no production profile
uses a silent fallback store.

## Delivery waves

### W0 — Profile and ownership contract

- Add the persistence ownership manifest for both profiles.
- Add explicit profile capability declarations.
- Record the authority method coverage matrix and normative semantics.
- Document the self-host backup unit and Cloudflare service dependencies.

**DoD:** every persistent resource has an owner, every mounted capability maps
to a profile dependency, and every authority method has a semantic test case.

### W1 — Shared authority conformance

- Add `workspaceAuthorityConformance(createFixture)`.
- Run it against isolated real SQLite databases.
- Run it against a real local or isolated CI Convex deployment.
- Require authority adapters to report storage failures as typed failures.
- Move `authority.db` initialization to versioned migrations.

**DoD:** SQLite and Convex pass the complete authority suite, migration tests,
failure injection, and restart cases.

### W2 — Single-node self-hosted profile

- Make the self-host deployment path select embedded Better Auth and SQLite as
  one composition.
- Add readiness for all three SQLite databases and the embedded-auth secret.
- Replace central SQLite catch-and-default behavior with typed storage failures
  and explicit product-level resilience policies.
- Add signup, login, authorization, persistence, restart, upgrade, and restore
  journeys using the packaged Node deployment.
- Publish persistent-volume and backup requirements.

**DoD:** a clean machine can deploy Claxedo with one persistent volume, create a
local account, use a workspace, restart, and continue without Clerk, Convex, or
an external database.

### W3 — Cloudflare hosted profile

- Make the Worker composition and capability declaration explicitly
  `cloudflare-hosted`.
- Validate all required Clerk, Convex, R2, Durable Object, relay, signing, and
  sandbox dependencies before serving traffic.
- Keep the Worker import-graph guard as a release gate.
- Add the real Cloudflare and Convex staging journey.

**DoD:** the deployed Worker passes the hosted public-API journey, survives
isolate replacement, and fails closed when a required hosted dependency is
removed.

### W4 — Release documentation and evidence

- Publish the two-profile deployment matrix.
- Document capability differences, operational requirements, backups, and
  supported upgrade paths.
- Store evidence notes with backend/schema versions and exact commands.
- Label the Node-plus-Convex composition as compatibility support.

**DoD:** every deployment claim names a profile and links to current acceptance
evidence.

## Future profile gates

Additional backends enter the supported matrix through complete deployment
profiles:

- **Postgres:** requires a concrete operator use case, authority and Node
  session-runtime adapters, migrations, lifecycle management, and full profile
  acceptance. Multi-instance claims additionally require the coordination
  architecture.
- **D1:** requires storage ownership for every Convex-backed hosted capability
  or an explicit retained Convex dependency, plus remote D1 consistency and
  profile journey evidence.
- **Multi-instance Node:** requires distributed ownership, fencing, affinity,
  fan-out, wakes, timers, and failure recovery in addition to shared storage.

These gates let future profiles reuse the authority contract without making
speculative adapters part of the initial launch.

## Risks and fixed decisions

- **Profile coupling:** auth and persistence are selected as tested profile
  pairs. Hosted uses Clerk plus Convex; self-hosted uses Better Auth plus
  SQLite.
- **Cloudflare priority:** hosted implementation and release evidence target
  Cloudflare before a clustered Node architecture.
- **Self-host simplicity:** the supported self-host topology is one Node process
  with one persistent volume.
- **Provider ownership:** Better Auth, Convex, R2, Durable Objects, KV, and
  sandbox-provider state retain their native schemas and lifecycles.
- **Failure behavior:** storage failures remain distinguishable from valid
  empty results. Product-level degradation is explicit and observable.
- **Capability honesty:** database support is advertised only as part of a
  complete deployment profile.

## Success criteria

The plan is complete when:

1. `cloudflare-hosted` and `single-node-self-hosted` have explicit capability
   declarations and green profile journeys.
2. SQLite and Convex pass the same complete `WorkspaceAuthority` conformance
   suite against real backends.
3. A self-hosted operator can use embedded Better Auth and SQLite with one
   persistent volume and no Clerk, Convex, or external SQL service.
4. A Cloudflare deployment uses Clerk, Convex, R2, Durable Objects, and sandbox
   execution through a fail-closed Worker composition.
5. Restart and schema-upgrade tests preserve identity, authority, and session
   state for the self-hosted profile.
6. Hosted acceptance survives Worker isolate replacement and proves durable
   state through the owning hosted services.
7. Postgres, D1, and multi-instance Node are documented as future complete
   profiles rather than partial backend claims.
