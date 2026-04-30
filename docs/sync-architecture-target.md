---
title: "Sync Architecture (Target)"
status: active
type: architecture-target
date: 2026-04-22
---

# Sync Architecture (Target)

## Doc Role

- **Adopted target architecture** for metadata, replay, and query ownership

Related docs:

- [docs/sync-architecture.md](/Users/yashvardhansingh/.codex/worktrees/b0da/opencode/docs/sync-architecture.md) — current implementation
- [docs/plans/2026-04-11-durable-workspace-control-plane-implementation-plan.md](/Users/yashvardhansingh/.codex/worktrees/b0da/opencode/docs/plans/2026-04-11-durable-workspace-control-plane-implementation-plan.md) — hosted control-plane target
- [docs/brainstorms/2026-03-31-claxedo-sync-strategy-requirements.md](/Users/yashvardhansingh/.codex/worktrees/b0da/opencode/docs/brainstorms/2026-03-31-claxedo-sync-strategy-requirements.md) — requirements input

## Goals

1. Define one explicit canonical owner for each session/workspace data domain.
2. Separate shared metadata durability from runtime timeline durability.
3. Keep runtime-local state valuable without treating it as a second equal hosted source of truth.
4. Make replay, repair, and query paths explicit and observable.
5. Support local desktop adapters without making hosted architecture depend on local-only shortcuts.

## Non-Goals

- Turning all runtime bytes into globally canonical replicated state.
- Making PTY stdout/stderr globally canonical.
- Keeping proxy response interception as the long-term center of hosted sync.
- Forcing every metadata and runtime concern into one event log.

## Target Ownership Model

| Entity | Canonical owner (target) | Derived/cache copies |
|--------|---------------------------|----------------------|
| Session and workspace metadata | Central canonical metadata store | Local cache allowed |
| Message timeline / replay-worthy runtime events | Durable runtime/timeline stream | Runtime replay cache allowed |
| PTY lifecycle metadata | Central canonical metadata store | Runtime in-memory state allowed |
| PTY stdout/stderr bytes | Runtime transport/local disk | No hosted canonical copy required |
| Workflow run summaries | Projection/read layer fed from `WorkflowEngine` | Runtime-local views allowed |
| Workspace lease and host authority state | `WorkspaceAuthority` durable store | Supervisor transport cache allowed |

Hard rule:

- one canonical owner per entity
- any mirrored copy is derived data
- local runtime durability remains important, but does not replace hosted canonical ownership for shared product state

## Metadata and Timeline Split

Use two different durability paths:

### 1. Canonical metadata store

Stores shared product state such as:

- session identity
- workspace linkage
- title
- archive state
- tags
- attachments
- session/workspace listing metadata
- PTY lifecycle metadata

### 2. Durable runtime/timeline stream

Stores ordered replay-worthy events such as:

- user submit events
- runtime message and message-part events
- approval/question/plan interaction events where timeline replay matters
- other ordered session timeline events required for reconstruction

This split is intentionally narrower than “everything becomes one append log.”

## Required Contracts

### Canonical metadata contract

The metadata contract should be explicit and idempotent:

- `upsertSessionRecord(input)`
- `deleteSessionRecord(input)`
- `upsertWorkspaceRecord(input)`
- `upsertPtySession(input)`
- `deletePtySession(input)`
- `upsertSessionAux(input)` for tags, attachments, archive/title updates

Each method should accept:

- stable primary key
- `updated_at`
- optional source metadata
- idempotency key when writes can be retried

### Durable runtime/timeline contract

The timeline contract should be append-first:

- `appendTimelineEvent(input)`
- `appendTimelineEvents(input[])`
- `readTimeline(session_id, after?)`
- `replayTimeline(session_id)`

Each appended event should include:

- aggregate identity such as `workspace_id` and `session_id`
- ordering key
- idempotency key
- event type
- event timestamp
- source metadata

### Projection/read contract

The query layer should serve product-facing reads such as:

- `getSession(session_id)`
- `listSessions(workspace_id)`
- `getSessionTimeline(session_id)`
- `getPtySession(pty_id)`
- `listWorkspaceSessions(workspace_id)`
- `getWorkflowRunSummary(run_id)`

## Consistency Model

- Shared metadata writes are fail-closed once the hosted cutover is complete.
- Timeline writes are append-first and idempotent.
- Read paths should come from projections and canonical metadata/timeline sources, not merged ad hoc runtime/cache composition.
- Runtime event streams remain live transport. They are not themselves the canonical write API unless explicitly appended through the durable timeline contract.
- PTY bytes remain non-canonical transport data.

Target SLOs:

- Metadata write success: `>= 99.9%` over 24h.
- Metadata read freshness: P95 `<= 1s`.
- Timeline append success: `>= 99.9%` over 24h.
- Replay availability lag: P95 `<= 1s`.

## Hosted Read and Write Paths

### Write path

Hosted writes should move toward:

- explicit control-plane mutation contracts from `workspace-runtime` and workflow callbacks
- canonical metadata writes for shared records
- append-only timeline writes for replay-worthy events

### Read path

Hosted reads should move toward:

- canonical metadata tables for list/detail/index views
- projection/timeline reads for replay and live session history
- explicit relay/bootstrap metadata for runtime attachment

The current proxy-first hosted path may remain as transitional compatibility, but it is not the target architecture center.

## Repair and Reconciliation

Repair must be explicit:

- periodic parity checks between runtime snapshots and canonical metadata
- timeline replay rebuild for projections
- idempotent re-append or repair writes for missing timeline gaps
- authority/host reconciliation for stale leases and orphaned runtimes

Required observability:

- metadata write success/failure
- timeline append success/failure
- projection lag
- replay fallback rate
- reconciliation runs and unresolved drift

## Rollout Plan

### Phase 0: Contracts and observability

- land canonical metadata, timeline, and projection interfaces
- add metrics and logs before behavior changes

### Phase 1: Local adapters

- implement SQLite-backed adapters for local/dev
- route current writes through the new contracts without behavior change

### Phase 2: Hosted explicit writes

- add explicit hosted mutation contracts from `workspace-runtime`
- keep proxy-driven compatibility paths only as fallback

### Phase 3: Canonical metadata and timeline cutover

- make hosted metadata tables canonical for shared records
- make timeline append canonical for replay-worthy events
- switch product reads to projection-backed queries

### Phase 4: Relay/bootstrap alignment

- align browser attach and runtime registration with the hosted control-plane contracts
- remove current reliance on merged proxy-first state for hosted reads

### Phase 5: Cleanup

- delete obsolete sync hooks and dead compatibility assumptions
- update current-state docs after implementation lands

## Guardrails

- no entity should have two equal canonical owners
- no fail-closed hosted write path until retry, alerting, and repair are in place
- no new merged ad hoc read path without documenting why it is transitional
- no assumption that local runtime durability alone is enough for shared hosted product state

## Test Plan

Required coverage before hosted cutover:

- unit tests for metadata idempotency and last-write-wins rules
- unit tests for timeline append ordering and dedupe
- integration tests for hosted mutation contracts
- integration tests for projection lag and replay rebuild
- failure-mode tests for backend down, partial timeout, malformed payloads
- rollback test proving compatibility paths still work during migration

## Open Decisions

1. Which metadata entities move first to canonical hosted ownership?
2. Which runtime events require durable timeline ingestion in the first phase?
3. What projection layout best supports browser reads without rebuilding merged source behavior?
4. Which compatibility reads can be removed first once hosted projections are live?
