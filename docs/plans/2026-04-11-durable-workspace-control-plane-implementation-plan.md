---
title: "platform: Durable Workspace Control Plane Implementation"
type: platform
status: active
date: 2026-04-11
---

# platform: Durable Workspace Control Plane Implementation

## Summary

This doc turns the broader reliability direction in `docs/plans/2026-04-11-big-repo-workspace-reliability-plan.md` into a concrete implementation shape.

The core change is:

- stop treating `packages/claxedo-server/src/workspace-supervisor.ts` as the durable owner of live remote workspaces
- introduce one durable control object per workspace
- let the remote `workspace-host` or `workspace-runtime` report to that object first
- mirror searchable product state to Convex, rather than using Convex as the live coordinator

This keeps the product identity stable at the workspace layer even when the backing sandbox changes.

## Problem Frame

Today the hosted workspace path is real, but the live ownership model is still process-local:

- `packages/claxedo-server/src/workspace-supervisor.ts` keeps remote runtime state in `const runtimes = new Map<string, State>()`
- that map currently holds runtime URL, process or sandbox handle, crash count, retry timing, active hold count, and event stream controllers
- if `claxedo-server` restarts, central session replay and metadata may still exist, but the live workspace ownership state is gone

This is the main reliability gap for large-repo and long-running background work.

The product test we actually need to pass is:

- if the client dies, can state replay cleanly?
- if the control plane dies, can workspace ownership be reconstructed?
- if the workspace host dies, can the same workspace come back?
- if the sandbox dies, can we resume from snapshot or prepared image without turning the workspace into a cold start?

## Scope

This doc covers:

- durable workspace ownership
- lifecycle and recovery
- workspace contract
- prepared images
- runtime snapshots
- Convex mirroring

This doc does not fully specify:

- backward compatibility for the old hosted supervisor model
- the final secret broker
- billing
- full UI implementation
- every provider-specific sandbox detail

## Existing Ground Truth In Code

We should preserve the parts that already work:

### 1. Runtime-local session state

`packages/workspace-runtime/src/store.ts` already persists:

- session
- message
- part
- todo
- pending permission
- pending question
- journal checkpoints

This is still useful and should not be replaced in the first pass.

### 2. Central session metadata and message replay

Current code really does persist central session data:

- `packages/claxedo-server/src/session-meta.ts`
- `packages/claxedo-server/src/cloud/message-replay.ts`
- `packages/claxedo-server/src/storage/session-meta.sql.ts`
- `packages/claxedo-server/src/storage/cloud-session.sql.ts`

This gives us:

- session lineage
- archive state
- tags and attachments
- central replay for streamed messages

### 3. Real remote execution path

Current hosted execution already goes through:

- `packages/claxedo-server/src/workspace-supervisor.ts`
- `packages/claxedo-server/src/cloud/sandbox-pool.ts`
- `packages/claxedo-server/src/cloud/sandbox-runtime.ts`
- `packages/claxedo-server/src/proxy.ts`

We should evolve this path instead of replacing it wholesale.

## Architecture Decision

The hosted product should use three different storage and coordination roles:

- **durable workspace authority**
  - one durable control object per workspace
  - owns live truth for that workspace
- **central queryable store**
  - Convex for list views, product metadata, reporting, and indexing
- **workspace-local state**
  - runtime-local journal, process state, service state, repo working copy

In hosted Cloudflare deployments, the clean match for the durable workspace authority is a per-workspace Durable Object.

For local development, we should not route workspace authority through Cloudflare Durable Objects.

Local should use an in-process authority backed by local durable storage inside `claxedo-server` so cloud-workspace development can run without hosted control-plane infrastructure.

The intended shape is:

```text
client
  -> vm-control-plane router
  -> workspace authority object (1 per workspace)
workspace-host / sandbox
  -> workspace authority object
workspace authority object
  -> Convex mirror for searchable product state
workspace authority object
  -> provider adapter for sandbox create/resume/restore/stop
```

Hosted shape:

- router and per-workspace authority run in the hosted control plane
- Durable Object is the authority implementation

Local shape:

- `packages/claxedo-server/src/workspace-supervisor.ts` and local authority run in the same local server process
- local SQLite or equivalent local durable storage backs lease and hold state
- no Cloudflare Durable Object hop is required for local cloud-workspace development

## Core Model

### Workspace vs Sandbox

These must stay separate:

- **workspace**
  - stable product identity
  - survives sandbox replacement
  - can have many sessions
- **sandbox**
  - the current machine or container hosting the workspace
  - may be resumed or replaced

Example:

- workspace `w1` starts on sandbox `s1`
- `s1` dies or becomes unreachable
- control plane resumes `s1` if provider allows it
- otherwise it starts `s2`
- the user still has workspace `w1`

### Per-workspace durable authority

We should use one durable control object per workspace, not per session.

Reason:

- `workspaceId` is already the intended stable product identity in `docs/vm-control-plane-workstreams.md`
- one workspace may contain many sessions
- sandbox lifecycle is a workspace concern, not a single-session concern

### Convex role

Convex should not be the live coordinator for heartbeats and ownership races.

Convex should store:

- workspace records
- workspace summaries
- session index
- lineage
- audit events
- usage and reporting surfaces
- image and snapshot metadata

The durable workspace authority should own:

- current sandbox identity
- current epoch
- current lease state
- current heartbeat and activity state
- reconnect acceptance or rejection

## Failure Model

### Client restart

Target behavior:

- client reconnects
- session replay is served
- live workspace status is still available

Primary owners:

- runtime-local journal
- central replay
- workspace authority object

### Control-plane process restart

Target behavior:

- workspace authority object is reconstructed from durable state
- active workspace continues if sandbox still exists
- stale sandbox reconnects are rejected by epoch

Primary owner:

- workspace authority object

### Workspace-host or workspace-runtime restart

Target behavior:

- workspace host reconnects to the same workspace authority object
- session-local state is replayed from workspace-local store if filesystem survives

Primary owners:

- workspace-local journal
- workspace authority object

### Sandbox loss

Target behavior:

- if provider supports resume, attempt resume
- else if runtime snapshot exists, restore from snapshot
- else if prepared image exists, start from prepared image
- else cold start from base image

Primary owners:

- provider adapter
- workspace authority object
- snapshot and image registry

## Durable Workspace Authority

### Responsibility

One authority object per workspace should own:

- lease state
- current epoch
- current sandbox identity
- heartbeat and last activity
- retry state
- current active holds
- status broadcasts
- reconnect validation
- lifecycle alarms

This object is the live brain for one workspace.

Implementation note:

- in hosted Cloudflare deployments, this authority is a Durable Object
- in local development, this authority is a local durable service inside `claxedo-server`
- both implementations must preserve the same lease, epoch, hold, and reconnect semantics

### Required persisted fields

The authority object should durably persist:

- `workspace_id`
- `lease_id`
- `epoch`
- `status`
- `provider`
- `provider_object_id`
- `provider_snapshot_id`
- `sandbox_id`
- `runtime_url`
- `retry_count`
- `next_retry_at`
- `last_heartbeat_at`
- `last_activity_at`
- `last_health_failure_at`
- `last_error`
- `compute_class`
- `accel_base_image_id`
- `accel_prepared_image_id`
- `accel_runtime_snapshot_id`
- `created_at`
- `updated_at`

### Holds

Do not model active holds as only an integer counter.

Use explicit durable hold rows:

- `hold_id`
- `workspace_id`
- `owner_type`
- `owner_id`
- `reason`
- `expires_at`
- `updated_at`

Then derive effective hold count from live rows.

This avoids leaked holds after process crashes.

### Epoch fencing

Every acquisition or re-adoption of workspace runtime ownership should bump an `epoch`.

Every reconnect or heartbeat from `workspace-host` should include:

- `workspace_id`
- `lease_id`
- `epoch`
- `sandbox_id`

The authority object should reject messages from stale epochs.

This is what prevents an old sandbox from becoming active again after a new sandbox already took over.

## Lifecycle Decision Model

`packages/claxedo-server/src/workspace-supervisor.ts` currently mixes:

- state lookup
- provider calls
- retry handling
- timers
- streaming side effects

We should split this into:

- **decision layer**
  - pure logic
  - input: persisted lease state + provider capabilities + time
  - output: next action
- **effect layer**
  - calls provider
  - updates durable authority object
  - broadcasts state

### Required decision outcomes

The decision layer should return one of:

- `skip`
- `wait`
- `resume`
- `restore_snapshot`
- `start_prepared`
- `start_fresh`
- `stop_idle`
- `mark_failed`

### Provider capability abstraction

Provider adapters should expose explicit capability flags like:

- `supports_persistent_resume`
- `supports_filesystem_snapshot`
- `supports_prepared_images`
- `supports_explicit_stop`
- `supports_health_probe`

This makes lifecycle policy testable without inlining provider-specific assumptions into supervisor code.

## Workspace Contract

For v1 we should use a repo-owned workspace contract instead of a generic workload manifest.

The first-pass contract should be split into:

- `.claxedo/workspace`
  - outer workspace contract
  - runtime requirements
  - `prepare`
  - `verify`
  - compute class
  - acceleration policy
  - network and secret requirements
- `.claxedo/processes`
  - long-running services
  - commands
  - ports
  - per-service readiness

### Fields

A workspace contract should include:

- source repo reference
- branch or version
- runtime requirements
  - node
  - python
  - bun
  - system packages if needed
- compute class
- `prepare` phase
- `verify` phase
- cacheability hints
- snapshot policy
- secret requirements
- network policy

### Phase meaning

- **prepare**
  - expensive setup
  - safe to cache into a prepared image
- **verify**
  - explicit health and readiness checks

`.claxedo/processes` remains the runtime services layer. It should not compete with `.claxedo/workspace`.

Authority split:

- `.claxedo/workspace` is authoritative for runtime requirements, `prepare`, `verify`, compute class, and acceleration policy
- `.claxedo/processes` is authoritative for service definitions, commands, ports, and per-service readiness

This avoids two startup sources fighting over ownership.

### Surface

We should support this through:

- repo file manifest for versioned, reviewable config
- optional UI editing later

The first pass should be repo-owned and file-based.

Suggested first-pass files:

- `.claxedo/workspace`
- `.claxedo/processes`
- optional helper scripts referenced by those files

## Prepared Images

### Purpose

Prepared images exist to avoid paying full setup cost on every fresh workspace.

They should capture:

- runtime version selection from the workspace contract
- cloned repo source
- dependency installation
- code generation
- expensive caches created during `prepare`

### Relationship to base image

Prepared images should always be built from a known base image.

Flow:

```text
base image
  -> apply workspace contract runtime requirements
  -> fetch source
  -> run prepare phase
  -> snapshot filesystem
  = prepared image
```

This means:

- base image is the generic platform image
- prepared image is the source-specific acceleration layer built from it

If the base image has Node 25 and the repo needs Node 20, the builder must apply the runtime requirements from `.claxedo/workspace` during prepared-image build. This must come from repo-declared config, not guesswork.

### Selection precedence

Workspace startup should use:

1. runtime snapshot
2. prepared image
3. shared base image

Compatibility checks:

- runtime snapshot is only valid when `workspace` contract hash, source compatibility, runtime fingerprint, and base image lineage still match
- prepared image is only valid when `workspace` contract hash, source compatibility, runtime fingerprint, and base image lineage still match
- invalid acceleration layers must be skipped without best-effort reuse

### Registry data

Prepared image registry should store:

- `workspace_key`
- `base_image_id`
- `prepared_image_id`
- `source_ref`
- `source_sha`
- `runtime_fingerprint`
- `profile_hash`
- `status`
- `build_error`
- `build_duration_ms`
- `created_at`
- `updated_at`

Convex should store indexable metadata for these records.

## Runtime Filesystem Snapshots

### Purpose

Runtime snapshots are for cheap resume of an already-lived workspace.

They capture:

- installed dependencies
- built artifacts
- repo working copy
- local caches
- workspace-local session and service state that survives on filesystem

### Difference from prepared image

- **prepared image**
  - shared across fresh workspaces for the same workspace contract/source ref
  - created after `prepare`
- **runtime snapshot**
  - specific to one workspace
  - created after real usage

### Trigger points

Runtime snapshot triggers should include:

- before idle stop
- after successful first-time bootstrap of a new workspace
- after major workspace mutations
- explicit save if later needed

Restore checks:

- runtime snapshot restore must re-run `verify`
- failed `verify` after restore must move the workspace into a non-ready lease state
- failed `verify` must not silently publish `ready`

### Snapshot metadata

Authority object and Convex mirror should track:

- `workspace_id`
- `runtime_snapshot_id`
- `provider_snapshot_id`
- `base_prepared_image_id`
- `source_sha`
- `created_at`
- `reason`
- `size_bytes` if available
- `status`

## Sync Model

### Rule

The remote workspace should not write live ownership state directly to Convex.

The desired path is:

```text
workspace-host / sandbox
  -> durable workspace authority
  -> Convex mirror
```

### Why

Convex is good for:

- lists
- reporting
- searching
- cross-workspace queries

The durable workspace authority is better for:

- serialized per-workspace coordination
- epoch checks
- live reconnect decisions
- heartbeat ordering

### What should be mirrored to Convex

Mirror these categories:

- workspace summary state
- current sandbox id and provider object id
- session index
- lineage
- image and snapshot metadata
- audit events
- failure summaries
- usage metrics

Do not require every tiny heartbeat update to become a Convex write if that creates unnecessary write pressure.

## Cleanup Policy

The system must define retention and garbage-collection rules for:

- expired holds
- abandoned workspace authorities
- obsolete runtime snapshots
- obsolete prepared images
- stale Convex mirror rows after workspace deletion

First-pass rules should be simple and explicit:

- expired holds are ignored and removed opportunistically
- deleted workspaces tombstone their mirror rows before final cleanup
- only the latest valid runtime snapshot per workspace is required for v1 unless manual save says otherwise
- prepared image retention can be capped per source key

## Integration With Existing Code

### `packages/claxedo-server/src/workspace-supervisor.ts`

Refactor it so that:

- in-memory `State` becomes a disposable cache and transport holder
- durable authority owns canonical lease state
- supervisor becomes a reconciler and effect runner

### `packages/claxedo-server/src/cloud/sandbox-pool.ts`

Extend it to:

- accept compute class
- return provider object ids needed for durable lease state
- support prepared-image and snapshot startup hints

### `packages/claxedo-server/src/cloud/sandbox-runtime.ts`

Extend it to:

- accept `.claxedo/workspace` inputs
- report readiness in structured phases
- attach runtime identity and epoch for reconnect

### `packages/workspace-runtime/src/process/index.ts`

Preserve it as the local services layer, but make it consume `.claxedo/workspace` authority and `.claxedo/processes` service definitions instead of being the only source of startup behavior.

## Proposed Implementation Units

- [x] **Unit 1: Durable workspace authority contract**

Goal:

- define per-workspace authority object API, state, and epoch rules

Files:

- add control object contract doc under `docs/`
- add authority types under `packages/claxedo-server/src/cloud/`
- refactor `packages/claxedo-server/src/workspace-supervisor.ts`

- [x] **Unit 2: Lease and hold persistence**

Goal:

- persist lease state and explicit holds outside process memory

Files:

- add storage under `packages/claxedo-server/src/storage/`
- add Convex mirror schema in hosted product layer later

- [x] **Unit 3: Lifecycle decision engine**

Goal:

- split lifecycle decisions from provider and broadcast side effects

Files:

- add `packages/claxedo-server/src/cloud/lifecycle/`
- refactor `workspace-supervisor.ts`
- thread provider capability flags through `sandbox-pool.ts`

- [x] **Unit 4: Workspace contract**

Goal:

- define `.claxedo/workspace` and `.claxedo/processes` contract

Files:

- add `.claxedo/workspace` schema support
- add `.claxedo/processes` schema support or migrate existing process config shape
- add loader under `packages/workspace-runtime/src/`
- extend process runtime integration

- [x] **Unit 5: Prepared image registry and build pipeline**

Goal:

- build workspace-scoped prepared images from the base image and workspace contract

Files:

- add prepared image storage and routes
- add builder path under `packages/claxedo-server/src/cloud/`

- [x] **Unit 6: Runtime snapshot support**

Goal:

- restore existing workspaces cheaply after sandbox loss or idle stop

Files:

- extend provider layer
- persist snapshot metadata on authority state
- update lifecycle restore precedence

- [x] **Unit 7: Convex mirror**

Goal:

- expose searchable and product-safe workspace/session/image state

Files:

- hosted product schema layer outside current `claxedo-server`
- mirror adapters from authority object events

## Recommended Order

1. durable workspace authority contract
2. lease and hold persistence
3. lifecycle decision engine
4. workspace contract
5. prepared image pipeline
6. runtime snapshot support
7. Convex mirror

## Success Criteria

- control-plane restart does not destroy live workspace ownership state
- old sandbox reconnects are rejected once a new epoch takes over
- a workspace can be restored from runtime snapshot without cold setup
- a fresh workspace can start from a prepared image when available
- runtime requirements come from `.claxedo/workspace`, not inference
- Convex can answer global product queries without owning live coordination

## Non-Goals

- moving all session internals out of `packages/workspace-runtime/src/store.ts`
- making Convex the live heartbeat coordinator
- limiting the design to coding-only workloads
- requiring full UI support before file-based workspace contracts ship

## Bottom Line

The right durable shape is:

- one durable authority per workspace
- one stable workspace identity above changing sandboxes
- one repo-owned workspace contract in `.claxedo/workspace`
- one service runtime layer in `.claxedo/processes`
- two acceleration layers
  - prepared image
  - runtime snapshot
- one central queryable mirror in Convex

This keeps the system reliable for large code work now, while still leaving the architecture broad enough for future non-code sandbox workloads.
