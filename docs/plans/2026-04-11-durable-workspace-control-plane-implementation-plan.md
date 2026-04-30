---
title: "platform: Hosted Control Plane Implementation"
type: platform
status: active
date: 2026-04-11
---

# platform: Hosted Control Plane Implementation

## Summary

This doc defines the adopted hosted control-plane architecture for Claxedo.

The direction is:

- keep `workspace-runtime` as the workspace-local execution surface
- make hosted authority state durable in the central Node/Hono control plane
- introduce a `WorkflowEngine` abstraction for durable agent execution
- split shared metadata from runtime timeline durability
- move hosted connectivity toward relay/tunnel brokering instead of the current permanent proxy path

This file keeps the same path for continuity with earlier review work. During architecture review we explored a per-workspace Durable Object direction, but that is not the adopted implementation target.

## Doc Role

- **Adopted target architecture**
- **Primary owner doc** for hosted authority, connectivity, and durable execution boundaries

Related docs:

- [docs/sync-architecture.md](/Users/yashvardhansingh/.codex/worktrees/b0da/opencode/docs/sync-architecture.md) — current implementation
- [docs/sync-architecture-target.md](/Users/yashvardhansingh/.codex/worktrees/b0da/opencode/docs/sync-architecture-target.md) — target metadata/timeline architecture
- [docs/plans/2026-04-11-big-repo-workspace-reliability-plan.md](/Users/yashvardhansingh/.codex/worktrees/b0da/opencode/docs/plans/2026-04-11-big-repo-workspace-reliability-plan.md) — reliability and throughput requirements
- [docs/vm-control-plane-workstreams.md](/Users/yashvardhansingh/.codex/worktrees/b0da/opencode/docs/vm-control-plane-workstreams.md) — control-plane workstreams

## Problem Frame

Today hosted workspaces are real, but the control plane still mixes too many roles in one process:

- browser-facing control APIs
- permanent proxying to `workspace-runtime`
- best-effort metadata sync
- process-local workspace supervision
- local and cloud agent orchestration

The most important gap is not "hosted workspaces do not work." It is that the live authority model is still partly process-local and the durable architecture story is split across:

- runtime-local session durability
- SQLite metadata and replay tables
- process-local runtime transport state
- proxy-first request routing

That split is serviceable for the current product, but it is not the long-term shape for:

- resumable background agent runs
- reliable workspace recovery after control-plane restarts
- direct browser or cloud attachment to hosted workspaces
- upmarket failure isolation and auditable workspace ownership

## Scope

This doc covers:

- workspace authority and lease ownership
- workflow-backed durable agent execution
- session/workspace metadata ownership
- runtime timeline durability
- host registration and relay/tunnel connectivity
- workspace recovery, snapshots, and prepared image acceleration

This doc does not fully specify:

- billing
- every provider-specific sandbox implementation detail
- exact relay vendor choice
- final schema for every projection table

## Existing Ground Truth In Code

We should preserve the parts that already work:

### 1. Runtime-local session durability

`packages/workspace-runtime/src/store.ts` already persists:

- session
- message
- part
- todo
- pending permission
- pending question
- journal checkpoints

This remains useful. Hosted architecture should not replace runtime-local durability with a remote-only model.

### 2. Central metadata and replay already exist

Current code persists:

- session lineage and metadata
- cloud session cache rows
- message replay data

Relevant files:

- `packages/claxedo-server/src/session-meta.ts`
- `packages/claxedo-server/src/cloud/message-replay.ts`
- `packages/claxedo-server/src/storage/session-meta.sql.ts`
- `packages/claxedo-server/src/storage/cloud-session.sql.ts`

This is a strong starting point, but it is not yet a clean canonical ownership model.

### 3. Remote execution path already exists

Current hosted execution already flows through:

- `packages/claxedo-server/src/workspace-supervisor.ts`
- `packages/claxedo-server/src/cloud/sandbox-pool.ts`
- `packages/claxedo-server/src/cloud/sandbox-runtime.ts`
- `packages/claxedo-server/src/proxy.ts`

We should evolve this path, not replace it blindly.

## Architecture Decision

The hosted product should use five explicit roles:

- **WorkspaceAuthority**
  - durable workspace lease state
  - epoch fencing
  - reconnect acceptance or rejection
  - host liveness and current sandbox identity
- **WorkflowEngine**
  - scheduled runs
  - approval waits
  - webhook wakes
  - retries, cancel, and resume
- **Canonical metadata store**
  - shared session and workspace records
  - listings, lineage, titles, archive state, attachments, and other product metadata
- **Durable runtime/timeline stream**
  - ordered replay-worthy session and runtime timeline events where needed
  - append-only ingress for timeline reconstruction and repair
- **Projection/read layer**
  - query-optimized views for browser and control-plane reads

Hosted implementation:

- `claxedo-server` remains the public Node/Hono control plane
- hosted authority state is backed by durable DB rows, not process-local memory
- `workspace-runtime` dials out to the control plane or relay
- browser attachment moves toward relay/tunnel mediation

Local and desktop implementation:

- keep an in-process `WorkspaceAuthority` adapter backed by local durable storage
- keep local execution and local-only state independent of hosted infrastructure

## Core Model

### Workspace vs sandbox

These stay separate:

- **workspace**
  - stable product identity
  - survives sandbox replacement
  - can own many sessions and workflow runs
- **sandbox**
  - current machine or container hosting that workspace
  - may be resumed, replaced, or restored

Example:

- workspace `w1` starts on sandbox `s1`
- `s1` dies or becomes unreachable
- control plane resumes or replaces the sandbox
- the user still owns workspace `w1`

### WorkspaceAuthority

We still want one authority boundary per workspace, but as an interface and data model, not as a platform-specific object runtime.

`WorkspaceAuthority` should own:

- current lease row
- current epoch
- sandbox identity and runtime endpoint registration
- hold state
- readiness and failure state
- reconnect acceptance and stale host rejection

Implementation targets:

- hosted: central control plane backed by durable DB state
- local/desktop: in-process adapter backed by local storage

### WorkflowEngine

`WorkspaceAuthority` is not the durable execution engine for long-running plans.

`WorkflowEngine` should own:

- scheduled starts
- sleep/wake semantics
- human approval waits
- webhook waits
- retries and timeout handling
- run cancellation and resumability

Workflow runs should be linked to workspaces and sessions, but they are a separate execution concern from workspace lease ownership.

## Canonical Ownership By Entity

| Entity | Canonical owner | Notes |
|--------|------------------|-------|
| Workspace lease, epoch, current host/sandbox state | `WorkspaceAuthority` durable store | Central hosted authority; local adapter for desktop/dev |
| Shared session/workspace metadata | Canonical metadata store | Session identity, lineage, title, archive state, attachments, workspace registry |
| Runtime timeline / replay-worthy ordered events | Durable runtime/timeline stream | Replay and reconstruction path for timeline-oriented state |
| Workflow run state | `WorkflowEngine` runtime + mirrored summaries | Workflow engine is authoritative; summaries are projected for reads |
| Runtime-local journal, filesystem, PTY stdout/stderr | `workspace-runtime` local state | Not globally canonical |

Rule:

- do not make one subsystem authoritative for another subsystem's responsibility
- keep metadata, authority, workflow execution, and runtime transport distinct

## Failure Model

### Client restart

Target behavior:

- client reconnects
- session/workspace metadata still reads correctly
- live timeline can replay
- workspace status remains available

Primary owners:

- runtime-local journal
- canonical metadata store
- durable runtime/timeline stream
- `WorkspaceAuthority`

### Control-plane restart

Target behavior:

- durable lease state is reloaded
- active host reconnects or is revalidated
- stale reconnects are rejected by epoch
- projections recover from the canonical metadata and timeline sources

Primary owners:

- `WorkspaceAuthority`
- canonical metadata store
- durable runtime/timeline stream

### Workspace-host or runtime restart

Target behavior:

- host reconnects through the hosted authority contract
- session-local state replays from runtime-local store when the filesystem survives
- browser attachment can recover without relying on the old permanent proxy path

Primary owners:

- runtime-local journal
- `WorkspaceAuthority`
- relay/tunnel attachment layer

### Sandbox loss

Target behavior:

- if provider supports resume, attempt resume
- else if runtime snapshot exists, restore from snapshot
- else if prepared image exists, start from prepared image
- else cold start from base image

Primary owners:

- sandbox/provider adapter
- `WorkspaceAuthority`
- snapshot and prepared-image registry

## Relay and Tunnel Role

Hosted connectivity should move toward explicit brokering instead of the current "proxy every workspace-runtime route through `claxedo-server`" model.

Target responsibilities:

- `workspace-runtime` registers with the control plane and/or relay
- browser receives attach/bootstrap info from the control plane
- relay/tunnel layer brokers live host connectivity
- control plane remains the authority and metadata surface, not the byte-forwarding path for every long-lived runtime interaction

Implications:

- `workspaceRuntimeProxy` is a current implementation detail and migration bridge, not the target center of the architecture
- frontend `resolveSessionUrl` should eventually return real hosted attach information

## Metadata and Timeline Split

The target architecture follows a Superset-like split:

- use **canonical metadata tables** for shared product records and listable state
- use a **durable runtime/timeline stream** for ordered replay-worthy events
- use **projection/read models** for browser and control-plane queries

This does **not** mean everything becomes one event log.

Examples:

- session title and archive state belong in canonical metadata
- timeline and replay-oriented runtime events belong in the durable stream
- PTY stream bytes remain transport data, not canonical global state

## Migration Away From Proxy-First Sync

The current hosted path depends on:

- proxying workspace-runtime routes
- best-effort sync hooks
- replay persistence from the global event bus

The target migration should move through these stages:

1. introduce `WorkspaceAuthority`, `WorkflowEngine`, metadata, stream, and projection interfaces
2. route current writes through those interfaces without changing user-visible behavior
3. teach `workspace-runtime` to register and publish through explicit control-plane contracts
4. make canonical metadata and durable timeline ingestion authoritative for hosted reads
5. move browser attachment to relay/tunnel-mediated bootstrap
6. retire the permanent proxy path as the normal hosted architecture

## Recovery and Acceleration

This architecture should continue to support:

- runtime snapshots
- prepared images
- compute classes
- repo bootstrap contracts
- health and readiness verification

Those concerns remain orthogonal to the authority/runtime/timeline split and should continue to evolve under the reliability plan.

## Implementation Units

### Unit 1: WorkspaceAuthority contract

- define authority API, lease row shape, and epoch rules
- keep existing lease/hold semantics from current `cloud/authority.ts`

### Unit 2: Hosted authority persistence

- move hosted authority state off process-local supervision maps
- support re-adoption and recovery from durable state

### Unit 3: WorkflowEngine contract

- define run, wait, wake, retry, cancel, and resume semantics
- keep provider-specific workflow runtime behind an adapter

### Unit 4: Canonical metadata store

- define central tables and contracts for shared session/workspace metadata
- remove ambiguity about what is cache vs canonical state

### Unit 5: Durable runtime/timeline stream

- define append contract for replay-worthy runtime and session timeline events
- support ordering, idempotency, and repair/rebuild

### Unit 6: Projection/read layer

- build query-facing projections for browser and control-plane reads
- keep replay and metadata surfaces consistent

### Unit 7: Relay and host registration

- add host registration, heartbeat, and attach bootstrap contracts
- move browser/runtime connectivity toward relay/tunnel brokering

### Unit 8: Proxy retirement

- demote proxy-first routing to compatibility mode
- remove it as the long-term hosted architecture center

## Acceptance Criteria

- hosted workspace authority survives control-plane restart
- stale host reconnects are rejected by epoch
- metadata ownership is explicit by entity
- timeline replay has one durable ingress path
- workflow execution is clearly separated from workspace authority
- relay/tunnel role is explicit in browser/runtime connectivity
- proxy-first sync is documented as transitional, not target-state

## Open Questions

1. Which metadata entities should move to the canonical metadata store first?
2. Which runtime events require durable timeline ingestion in the first hosted rollout?
3. Which hosted interactions still need direct proxy compatibility during migration?
4. Which workflow provider should back the first `WorkflowEngine` adapter?

## Status

This is the active hosted architecture plan.

The earlier per-workspace Durable Object direction remains useful review context, but it is not the adopted implementation target.
