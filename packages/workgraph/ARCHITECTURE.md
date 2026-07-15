# WorkGraph Architecture

## Overview

WorkGraph is a user-owned application service embedded in `claxedo-server` for organizing and executing AI-assisted work across versioned Work Sources, external trackers, and Claxedo workspace runtimes. Each personal graph is physically scoped by the trusted `(organization, user)` tuple supplied by the host.

```text
Claxedo app ── HTTP/JSON + ordered changes ──► claxedo-server
                                         │
Standalone MCP ── authenticated HTTP ────┤
Local agent tools and workers ── direct ─┤
                                         ▼
                            Embedded WorkGraph services
                              ├─ Streams, Tasks, optional Outcomes
                              ├─ Work Sources and intake
                              ├─ Attempts and Decisions
                              ├─ Recaps and attention
                              └─ events and subscriptions
                                         │
                                         ├──► Claxedo Connections
                                         ├──► Workspace execution
                                         └──► WorkGraphStore
                                               Convex | SQLite | custom
```

HTTP is the northbound app and standalone-MCP contract, not an internal service boundary. `claxedo-server` constructs one WorkGraph service composition and mounts its router. Local embedded agent tools, workers, webhooks, and reconcilers receive that composition directly and call application services in-process. Hosted embedded agent tools are registered only when the durable Session carries verified organization-and-user provenance.

## Ownership boundaries

### WorkGraph

WorkGraph owns personal Streams, workspace intent, Outcomes, Work Items, source views, intake candidates, Attempts, Decisions, Recaps, execution profiles, completion evidence, durable-effect receipts, activity, events, and leases.

### Work Sources

WorkGraph owns exact source text captured through agents, explicit source actions, and authoring adapters, together with its immutable revisions. Confirmed work records the exact source revision. Later revisions produce diff-based replan proposals with keep, replace-disposable-work, or fork choices. The Docs v2 adapter seam appends exact external document revisions through the source port while the document remains the authoring surface and WorkGraph remains execution truth. The current Documents feature is legacy Pages without a durable Docs v2 revision model, so no triggerable document journey is part of the delivered composition yet. Additional authoring systems use the same source port without becoming WorkGraph storage dependencies.

### Connections

Connections owns organization-scoped provider credentials and Connection metadata, refresh, capability grants, account health, and team partitioning. WorkGraph owns each user's provider identity mapping and saved filters. Attempt bindings contain only tenant-bound Connection references and permitted tools; they never transfer credential ownership into WorkGraph.

### Workspace runtimes

Workspace runtimes own repositories, filesystems, worktrees, cloud VMs, processes, terminals, and sessions. WorkGraph assigns one primary isolated envelope to each executable Stream and dispatches Work Item Attempts inside it through a stable execution port.

### Hosted control plane

The control plane authenticates the user, verifies organization membership for Connection use, gates entitlements, and authorizes workspace placement. It supplies trusted organization, user, and actor context.

## Ownership and access model

Every personal aggregate carries required `organization_id` and `owner_user_id`. The host derives both from verified authentication and organization authority; clients cannot choose a tenant through request data. Organization scope provides physical isolation and access to team Connections, while the user remains the product owner of personal work.

Primary uniqueness constraints include the trusted tenant tuple:

- external identity: `(organization_id, owner_user_id, provider, connection_id, external_id)`;
- idempotent operation: `(organization_id, owner_user_id, operation_id)`;
- event sequence: `(organization_id, owner_user_id, stream_id, sequence)`;
- saved source view: `(organization_id, owner_user_id, source_view_id)`.

Private tenant-bound owner access is the initial contract. Future sharing adds explicit read grants over a Stream or full WorkGraph. A grant does not transfer ownership, expose provider credentials, or authorize mutation.

## Storage ports

Domain services depend on capability-focused command and query maps rather than database handles:

```ts
type AtomicWorkGraphStore<Commands, Queries> = Readonly<{
  commands: Commands
  queries: Queries
}>

type AtomicCommand<Input, Result> = (context: WorkGraphContext, input: Readonly<Input>) => Promise<Result>

type TenantQuery<Input, Result> = (context: WorkGraphContext, input: Readonly<Input>) => Promise<Result>
```

The application service dispatches a public command discriminator to the corresponding atomic handler and exposes typed tenant-scoped queries. Atomic commands map to Convex mutations, SQLite transactions, or custom adapter units of work. Core adapters provide tuple-bound queries, atomic state/change/outbox mutation, ordered append, idempotency, compare-and-set transitions, expiring leases, opaque tenant-and-filter-bound cursors, and migrations. Published core conformance version 5 certifies these semantics through restart-safe snapshot convergence, Attempt runtime recovery, and source-revision replacement fencing. Portable tenant export/restore uses a separate archive port and archive conformance version 1. SQLite and Convex implement archive, cleanup, deletion, bounded workers, and tuple-leading indexes in repository verification.

### Convex

Convex is the default Claxedo Cloud adapter. Every personal record and access path is physically scoped by the trusted `(organization_id, owner_user_id)` tuple, with tuple-leading indexes for tenant reads and background work. Organization-owned Connection credentials and metadata remain separate from user-owned provider mappings, filters, source bindings, and WorkGraph state. Authenticated server queries and mutations power tenant-scoped candidate state and live execution state through the same northbound HTTP and ordered-change contract used locally. Scheduled functions process source planning, source refresh, connector outbox work, expired leases, independent-session candidates, and eight-hour Recaps. Repository verification covers migration, indexing, deletion barriers, bounded workers, archive, cleanup, and owner deletion; staged Cloud proof remains a release gate.

The hosted Worker-safe composition imports domain ports and the Convex adapter, not SQLite or Node-native database modules.

### SQLite

SQLite is the default local and single-node self-host adapter. It implements the same ownership, command, ordering, lease, and conformance semantics. Local composition uses the authenticated tenant or a stable local organization-and-user identity.

### Custom adapters

OSS operators can register another adapter and run the public conformance suite. PostgreSQL is a natural external SQL implementation but is not required by the core package.

## Application services

- `WorkGraphService` dispatches the canonical atomic command set and tenant-scoped query capabilities.
- Source admission and matching services bind immutable revisions, rank bounded Stream and duplicate candidates, and confirm versioned proposal packages.
- Execution, completion, and lifecycle services resolve immutable Attempt profiles, reconcile runtime state, evaluate evidence, and enforce close/delete boundaries.
- Intake, Source View, webhook, and Session-intake services produce personal candidates and perform provider work through Connections.
- Recap, notification, and attention services schedule incremental memory updates and expose exact actionable delivery records.

Every service receives a `RequestContext` containing the trusted organization, owner user, actor, request ID, and verified access claims. Public WorkGraph requests never select either tenant component.

## Connections flow

```text
Personal source view
  → organization Connection reference + provider user identity + filters
  → verify current organization membership and capability
  → CapabilityHandle.getToken()
  → connector query or sync-back
  → CapabilityHandle.reportAuthFailure() on rejection
  → receipt without secret material
```

The credential scope and result scope are distinct: the Connection credentials and metadata are organization-owned, while the user owns provider mappings, filters, source views, candidates, and bindings. WorkGraph never persists access tokens or API keys.

## Candidate admission flow

Work Source revisions, source views, agents, and independent sessions produce proposals or candidates. `intake` remains the backend lifecycle vocabulary for candidates that have not entered the executable graph. Candidates appear through the Needs you view in the shared WorkspacePanel; WorkGraph has no separate intake, capture, or onboarding screen. Admission is an explicit owner action except for agent-discovered factual findings and clearly necessary follow-up work allowed by the active authority policy. A later Work Source revision produces a replan proposal and never mutates confirmed work directly.

“Turn into work” writes a durable planning record and schedules a normal Session V2 planning job. The planner uses a stable caller-owned Session/message identity, validates one strict result shape, and may publish a reviewable proposal only against the exact current source revision, proposal version, and lease epoch. Invalid or unavailable generation records `planning_failed`; bounded retry and attention preserve the failure truth. A lost admission response is reconciled by retrying the same identity. Owner confirmation uses compare-and-set against the rendered proposal version.

Placement uses compact Stream memory cards. It searches pinned and recent Streams first, then older cards on low confidence. Duplicate detection offers link, merge, or create separately and records the owner's choice.

## Execution flow

1. Resolve or create the Stream's primary worktree/VM envelope from its base repository and revision.
2. Resolve WorkGraph, Stream, optional Outcome, and Work Item settings into an immutable Attempt profile inside that envelope.
3. Verify blockers, Decisions, workspace access, organization Connection access, user binding, and the completion contract.
4. Acquire the Attempt execution lease and adopt the Stream workspace.
5. Launch the session and record stable envelope, child worktree, session, model, effort, and Connection identities.
6. Consume runtime lifecycle and semantic MCP updates independently.
7. Evaluate the completion contract and create integration, review, or verification work when required.

Every ready Work Item may launch. Operational quotas and failures are observable execution conditions, not a product-level agent-capacity queue.

Pause stops new launches; explicit cancel targets active Attempts. Transient infrastructure failures retry automatically. Semantic, repeated, and ambiguous failures create attention.

Placement failure handling reserves a durable compensation effect before invoking external cancellation and cleanup. Reconciliation runs both operations independently, preserves their failure history, and retries across process restart. Stale admitted or placing Attempts become durable attention only after compensation completes, so attention never substitutes for unfinished external cleanup.

## Completion and Decisions

Attempts report execution results; Work Items complete only when their contracts are satisfied. Outcomes move to ready-to-close when success criteria have evidence and require owner confirmation.

Agents directly record factual findings and necessary follow-up work. Changes to confirmed scope, priority, success criteria, or consequential direction create Decisions. Pending Decisions block only affected and dependent work.

## Stream deletion and closure

The Stream tracks durable-effect receipts for merged or directly integrated code, published artifacts, and accepted external writes.

While no durable effect exists, deletion is destructive and atomic from the user's perspective: cancel Attempts, destroy the Stream workspace, discard unmerged work, then remove personal graph records according to deletion policy.

Once a durable effect exists, deletion is rejected. Closing records the reason, marks unfinished Work Items abandoned, preserves Attempts/Decisions/Recaps/evidence and external references, and cleans up the envelope after retained results are secured.

## Recap flow

Stream activity advances a quiet-window marker. After eight hours without activity, a durable worker generates a Recap from changes since the prior Recap plus current state and prior memory. Previous Recaps remain immutable timeline entries.

The Recap model and effort come from Stream-owned Recap configuration. Stream creation initializes that configuration from the effective execution model and effort with an eight-hour quiet period; explicit Stream Recap settings take precedence. Local and hosted workers use ordinary tool-less Session V2 jobs with stable identity, exact activity-range binding, strict structured output, and publication fencing. Only validated output from the exact Session publishes a Recap. A requirement is created only when the effective generation profile is incomplete; repeated generation failure or missing source access creates attention without publishing a substitute Recap or notification.

An actionable Recap and its single unread tenant-scoped notification commit atomically. The notification points to the exact Stream and Recap and is acknowledged with compare-and-set against the rendered delivery version.

## WorkGraph app composition

The app renders one compact `/workgraph` surface whose Streams expand in place. The existing app-global WorkspacePanel and its top-level toggle are the only secondary-panel shell and control. The panel is not owned or bounded by a workspace; individual views supply their own scope. WorkGraph contributes tenant-bound Needs you and Settings views while keeping WorkGraph domain state in the feature.

The existing top-level toggle carries a small accessible attention indicator when the bounded tenant-scoped Attention projection is non-empty. The WorkGraph header Needs you and Settings controls select those top-level views in the same panel instance. Zero attention produces no WorkGraph dot, contextual card, list, or empty body content. Selecting a Needs you item opens a focused proposal, candidate, Task/Attempt, Decision, Recap, or configuration dialog over the same `/workgraph` surface. WorkGraph Settings is a tabless execution-defaults view. Stream Settings is a tabless Stream-scoped dialog containing execution overrides and Recap configuration; each Stream row exposes its latest Recap through a hover/focus Recap icon and popover. Settings content is flush, descriptions and validation errors sit beside their fields, and the footer stays pinned. Add task remains the canonical manual work action.

Attention and candidate collections use stable tenant-bound cursor pages. Targeted tenant-scoped queries load the selected item's details. An Attention, candidate, or detail-query failure remains explicit and never switches to a full-snapshot or fabricated result. Settings changes are versioned atomic commands: WorkGraph saves one execution-defaults patch, while Stream saves one execution-and-Recap patch. Clearing an override is explicit.

### Execution capability catalog

WorkGraph Settings obtains valid execution choices through a tenant-scoped execution-capabilities port. Its northbound `GET /execution-capabilities` derives the trusted organization and user from the host, accepts no tenant or workspace selector, and performs no provisioning. Local composition observes the configured repository and live runtime. Hosted composition observes a deterministic per-tenant catalog workspace owned by the control plane. This catalog workspace is an infrastructure probe, while a Stream workspace is the later execution target created from repository and Attempt-profile state. Profile `presetId` is reserved for adapter configuration and never identifies either workspace.

The response is one server-attested observation containing a content-addressed revision, observation time, exclusive expiry, supported environment policy values, the active harness, agent/model/effort/tool catalogs, repository inputs, and connected Connection metadata. Lifetime is capped at five minutes. Settings writes and execution admission validate the exact tenant, freshness, and selections. An unavailable, expired, wrong-tenant, or invalid catalog cannot authorize execution. The explicit tenant-bound `POST /execution-capabilities/refresh` operation may provision or refresh the catalog workspace for agents and hosted background setup. The app reads through GET only. Cloud deployment establishes catalog runtimes before Settings use and monitors their availability separately from Stream execution workspaces.

## Events and ordered changes

Events include organization, owner, stream, sequence, schema version, operation ID, actor provenance, payload, correlation, causation, and timestamp. Projection mutation and event/outbox append are atomic through the adapter.

The hosted Convex adapter and local SQLite adapter expose the same tenant-scoped `WorkGraphChange` and reconnect cursor semantics through `claxedo-server`. A branded `SnapshotResumeCursor` continues one unchanged page chain, while the distinct `ChangeCursor` in `snapshotCursor` starts ordered convergence after the complete snapshot. Mutations invalidate outstanding resume cursors. Convex must advance with bounded keyset pages beyond 100 records, and the app and MCP aggregate the full snapshot, discard partial data on invalidation, and perform one clean restart. Convex may use its reactive primitives behind the adapter, while clients remain coupled only to the northbound snapshot/change contract.

## Security

- Organization and owner identity come from verified auth and membership context.
- Share grants are explicit, read-only initially, and resource-scoped.
- Organization Connection use rechecks membership and capability.
- Provider secrets remain inside Connections and in memory for one request.
- MCP tools bind the agent to owner, Attempt, and permitted work.
- Workspace placement verifies owner access to the workspace and repository.
- Webhooks verify provider signatures before source-view routing and deduplication.
- Events and logs exclude credentials and sensitive provider bodies.

## Packaging

The core package contains domain types, services, connector interfaces, storage ports, workspace execution ports, and conformance tests. Its current public surfaces are:

```text
@claxedo/workgraph             embedded service, router, SQLite adapter, connectors
@claxedo/workgraph/contracts   runtime-neutral DTOs and validators
@claxedo/workgraph/domain      browser-safe domain rules
@claxedo/workgraph/hosted      Worker-safe service and router composition
@claxedo/workgraph/matching    runtime-neutral bounded placement helpers
@claxedo/workgraph/ports       public adapter port definitions
@claxedo/workgraph/conformance runner-neutral custom-adapter contract tests
```

`@claxedo/workgraph` exposes backend-neutral application services and a standard HTTP router over those services. The Convex model and adapter compose in the hosted control plane without entering browser or Worker-unsafe exports. Custom OSS adapters implement the same ports and conformance suite. `claxedo-server` is the production host: it supplies verified request context, selects adapters, mounts the router for app and standalone-MCP clients, and injects the services into local embedded agent tools, webhook, scheduled, and reconciliation modules. Hosted embedded agent tools require durable Session tenant provenance. Cloud deployment changes the adapters and runtime placement, not this host boundary.

## Delivery status

The repository contains the personal WorkGraph application service embedded in `claxedo-server`, its portable storage ports and HTTP/ordered-change contract, SQLite and Convex adapters, execution and source-planning primitives, Connections integration seams, MCP tools, and the compact Stream tree with inline Add task. Focused repository verification is green. The Docs v2 adapter seam can admit exact immutable revisions once a durable authoring surface invokes it; the current legacy Pages surface does not yet provide that triggerable journey.

[TASKS.md](./TASKS.md) tracks the final integrated regression, approved WorkspacePanel interactions, browser acceptance, the triggerable Docs v2 journey, and real Cloud release evidence. Staging has not been deployed because its GitHub environment lacks the required deployment configuration. Cloud release acceptance requires credentialed deployment in strict Convex schema/functions → Worker → app order, signed cross-tenant policy checks, exact capability-catalog verification, and the canonical browser journey against deployed Convex and hosted workspace execution.
