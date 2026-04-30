---
title: "platform: Hosted Control Plane Phased TDD Plan"
type: platform
status: active
date: 2026-04-22
---

# platform: Hosted Control Plane Phased TDD Plan

## Summary

This is the execution plan for moving Claxedo from the current proxy-first, mixed sync/control model to the adopted hosted control-plane architecture described in:

- [docs/plans/2026-04-11-durable-workspace-control-plane-implementation-plan.md](/Users/yashvardhansingh/.codex/worktrees/b0da/opencode/docs/plans/2026-04-11-durable-workspace-control-plane-implementation-plan.md)
- [docs/sync-architecture-target.md](/Users/yashvardhansingh/.codex/worktrees/b0da/opencode/docs/sync-architecture-target.md)

The target shape is:

- `claxedo-server` remains the public Node/Hono control plane
- `WorkspaceAuthority` owns durable lease and epoch state
- a new hosted control-plane layer owns canonical metadata, durable timeline ingestion, projections, and relay/bootstrap contracts
- `WorkflowEngine` owns durable agent execution semantics
- `workspace-runtime` remains the workspace-local execution surface
- the current permanent proxy path becomes compatibility infrastructure, not the architecture center

This plan is intentionally TDD-first and grounded in the current codebase. Each phase starts with failing tests in the files that already own the closest behavior today.

## Current Grounding In Code

### Current control-plane seams

- [`packages/claxedo-server/src/sync-db.ts`](/Users/yashvardhansingh/.codex/worktrees/b0da/opencode/packages/claxedo-server/src/sync-db.ts) is a façade over direct session-meta, cloud-session, and message-replay writes. It is the most natural starting seam for extraction.
- [`packages/claxedo-server/src/server.ts`](/Users/yashvardhansingh/.codex/worktrees/b0da/opencode/packages/claxedo-server/src/server.ts) is the composition root. It wires `createSyncDB()`, `workspaceRuntimeProxy`, `AgentSessionRoutes`, `globalBus`, and workspace supervision together in one place.
- [`packages/claxedo-server/src/routes/agent-session.ts`](/Users/yashvardhansingh/.codex/worktrees/b0da/opencode/packages/claxedo-server/src/routes/agent-session.ts) still performs session persistence in `after*` hooks and reads merged/cached state.
- [`packages/claxedo-server/src/proxy.ts`](/Users/yashvardhansingh/.codex/worktrees/b0da/opencode/packages/claxedo-server/src/proxy.ts) is the current hosted byte-routing center for cloud sessions, permissions, questions, events, PTY, and related paths.
- [`packages/claxedo-server/src/cloud/authority.ts`](/Users/yashvardhansingh/.codex/worktrees/b0da/opencode/packages/claxedo-server/src/cloud/authority.ts) already contains the durable lease/epoch/hold semantics we want to preserve.
- [`packages/claxedo-server/src/workspace-supervisor.ts`](/Users/yashvardhansingh/.codex/worktrees/b0da/opencode/packages/claxedo-server/src/workspace-supervisor.ts) correctly treats the `runtimes` map as transport-only in comments, but still performs many of the effective hosted-runtime coordination responsibilities in practice.

### Existing test harnesses we should leverage

- [`packages/claxedo-server/src/control-plane.integration.test.ts`](/Users/yashvardhansingh/.codex/worktrees/b0da/opencode/packages/claxedo-server/src/control-plane.integration.test.ts) already boots a server, injects cloud runtimes, exercises SSE/WS behavior, and is the right home for hosted control-plane integration tests.
- [`packages/claxedo-server/src/agent-lifecycle.integration.test.ts`](/Users/yashvardhansingh/.codex/worktrees/b0da/opencode/packages/claxedo-server/src/agent-lifecycle.integration.test.ts) already validates session CRUD and streaming paths through the real HTTP surface for runner types.
- [`packages/claxedo-server/src/proxy.test.ts`](/Users/yashvardhansingh/.codex/worktrees/b0da/opencode/packages/claxedo-server/src/proxy.test.ts), [`packages/claxedo-server/src/cloud/message-replay.test.ts`](/Users/yashvardhansingh/.codex/worktrees/b0da/opencode/packages/claxedo-server/src/cloud/message-replay.test.ts), [`packages/claxedo-server/src/cloud/session-sync.test.ts`](/Users/yashvardhansingh/.codex/worktrees/b0da/opencode/packages/claxedo-server/src/cloud/session-sync.test.ts), and [`packages/claxedo-server/src/cloud/workspace-supervisor.test.ts`](/Users/yashvardhansingh/.codex/worktrees/b0da/opencode/packages/claxedo-server/src/cloud/workspace-supervisor.test.ts) are the unit-level safety net for current behavior.

### Execution posture

- Follow characterization-first TDD for phases that change existing behavior.
- Add new failing integration tests before introducing new contracts.
- Keep each phase shippable behind a feature flag or compatibility branch in composition.
- Run tests from `packages/claxedo-server` and `packages/claxedo-app`, never from repo root.

## Phase 1: Extract Control-Plane Ports Around Current Sync Behavior

### Goal

Create explicit interfaces for the future architecture without changing behavior yet. This phase turns the current `sync-db` façade into the first real control-plane seam.

### Test-first work

Add or expand tests in:

- [`packages/claxedo-server/src/control-plane.integration.test.ts`](/Users/yashvardhansingh/.codex/worktrees/b0da/opencode/packages/claxedo-server/src/control-plane.integration.test.ts)
- [`packages/claxedo-server/src/runtime-contract.test.ts`](/Users/yashvardhansingh/.codex/worktrees/b0da/opencode/packages/claxedo-server/src/runtime-contract.test.ts)

Write failing tests that prove:

1. control-plane composition can be injected with metadata/timeline interfaces rather than hard-coded `createSyncDB()`
2. `AgentSessionRoutes` can consume an injected service surface instead of a file-local singleton
3. current behavior is preserved when using default SQLite-backed adapters

### Production changes

- Add a new `packages/claxedo-server/src/control-plane/` folder with initial interfaces:
  - `workspace-authority.ts`
  - `canonical-metadata.ts`
  - `timeline-log.ts`
  - `projection-store.ts`
  - `workflow-engine.ts`
- Keep the initial interfaces intentionally thin and map them to existing code paths.
- Refactor [`packages/claxedo-server/src/sync-db.ts`](/Users/yashvardhansingh/.codex/worktrees/b0da/opencode/packages/claxedo-server/src/sync-db.ts) so it becomes a compatibility adapter rather than the primary abstraction.
- Refactor [`packages/claxedo-server/src/server.ts`](/Users/yashvardhansingh/.codex/worktrees/b0da/opencode/packages/claxedo-server/src/server.ts) to build a single `controlPlaneServices` object and thread it into the existing route initializers.
- Refactor [`packages/claxedo-server/src/routes/agent-session.ts`](/Users/yashvardhansingh/.codex/worktrees/b0da/opencode/packages/claxedo-server/src/routes/agent-session.ts) so it no longer creates its own file-local `sync` singleton.

### Acceptance criteria

- `server.ts` has one composition root for control-plane services
- `agent-session.ts` depends on injected services
- existing sync behavior remains unchanged
- no user-visible routing or persistence changes ship in this phase

## Phase 2: Introduce Canonical Metadata and Timeline Contracts With SQLite Adapters

### Goal

Split today’s mixed `sync-db` responsibilities into:

- canonical metadata writes/reads
- durable timeline append/replay
- query projections

without changing the hosted runtime flow yet.

### Test-first work

Add failing tests in:

- [`packages/claxedo-server/src/cloud/message-replay.test.ts`](/Users/yashvardhansingh/.codex/worktrees/b0da/opencode/packages/claxedo-server/src/cloud/message-replay.test.ts)
- [`packages/claxedo-server/src/cloud/session-sync.test.ts`](/Users/yashvardhansingh/.codex/worktrees/b0da/opencode/packages/claxedo-server/src/cloud/session-sync.test.ts)
- a new `packages/claxedo-server/src/control-plane/sqlite-adapters.test.ts`

Write tests that prove:

1. shared metadata writes go through a canonical metadata interface
2. replay-worthy message events append through a timeline interface with idempotency and ordering keys
3. projections can rebuild session timeline reads from canonical sources
4. default SQLite adapters preserve current behavior

### Production changes

- Add SQLite-backed adapters:
  - `SQLiteCanonicalMetadataStore`
  - `SQLiteTimelineLog`
  - `SQLiteProjectionStore`
- Move current direct helpers behind those adapters:
  - `session-meta.ts` responsibilities into canonical metadata adapter
  - `cloud/session-sync.ts` responsibilities into canonical metadata compatibility layer
  - `cloud/message-replay.ts` responsibilities into timeline/projection compatibility layer
- Update `server.ts` to subscribe global message replay through the new timeline adapter, not through `sync.subscribe_message_replay(...)`.
- Keep current tables initially; do not force a schema migration in this phase unless tests show one is required for idempotency or ordering.

### Acceptance criteria

- there is a code-level distinction between metadata and timeline responsibilities
- SQLite remains the backing implementation for all current behavior
- `sync-db.ts` is now a compatibility layer or deleted entirely if the adapters make it unnecessary

## Phase 3: Make WorkspaceAuthority the Only Hosted Lease Owner

### Goal

Finish the control-plane separation between:

- durable workspace authority state
- transport-only runtime state in `workspace-supervisor`

### Test-first work

Add failing tests in:

- [`packages/claxedo-server/src/cloud/workspace-supervisor.test.ts`](/Users/yashvardhansingh/.codex/worktrees/b0da/opencode/packages/claxedo-server/src/cloud/workspace-supervisor.test.ts)
- [`packages/claxedo-server/src/control-plane.integration.test.ts`](/Users/yashvardhansingh/.codex/worktrees/b0da/opencode/packages/claxedo-server/src/control-plane.integration.test.ts)

Write tests that prove:

1. restarting or recreating transport state does not lose lease/epoch ownership
2. stale reconnects are rejected using `cloud/authority.ts` semantics
3. `workspace-supervisor` can reconstruct runtime tracking from durable authority state

### Production changes

- Preserve and reuse [`packages/claxedo-server/src/cloud/authority.ts`](/Users/yashvardhansingh/.codex/worktrees/b0da/opencode/packages/claxedo-server/src/cloud/authority.ts) as the core authority logic.
- Refactor [`packages/claxedo-server/src/workspace-supervisor.ts`](/Users/yashvardhansingh/.codex/worktrees/b0da/opencode/packages/claxedo-server/src/workspace-supervisor.ts) so its `runtimes` map only holds:
  - child handles
  - sandbox handles
  - event/stream abort controllers
  - timers and transient transport state
- Move any remaining effective authority decisions out of `workspace-supervisor` into the injected `WorkspaceAuthority` service.
- Add explicit authority-driven host registration hooks if the existing runtime injection helpers are not enough.

### Acceptance criteria

- `WorkspaceAuthority` is the single hosted owner of lease/epoch state
- `workspace-supervisor` is reduced to transport/process orchestration
- cloud reconnection logic is explicitly fenced by authority state

## Phase 4: Add Explicit Host-to-Control-Plane Mutation Contracts

### Goal

Stop relying on `AgentSessionRoutes.after*` hooks and proxy side effects as the long-term hosted metadata write path.

### Test-first work

Add failing tests in:

- [`packages/claxedo-server/src/runtime-contract.test.ts`](/Users/yashvardhansingh/.codex/worktrees/b0da/opencode/packages/claxedo-server/src/runtime-contract.test.ts)
- [`packages/claxedo-server/src/control-plane.integration.test.ts`](/Users/yashvardhansingh/.codex/worktrees/b0da/opencode/packages/claxedo-server/src/control-plane.integration.test.ts)
- [`packages/workspace-runtime/src/routes/session.test.ts`](/Users/yashvardhansingh/.codex/worktrees/b0da/opencode/packages/workspace-runtime/src/routes/session.test.ts)

Write tests that prove:

1. `workspace-runtime` can register a host and heartbeat with the control plane
2. `workspace-runtime` can send explicit metadata mutations for session upsert/delete and timeline append
3. duplicate mutation delivery is idempotent
4. hosted behavior still works when the old proxy fallback is left enabled

### Production changes

- Add new Hono routes in `claxedo-server` under a dedicated hosted control-plane namespace, for example:
  - `POST /api/control/workspaces/:workspaceId/register-host`
  - `POST /api/control/workspaces/:workspaceId/heartbeat`
  - `POST /api/control/workspaces/:workspaceId/upsert-session`
  - `POST /api/control/workspaces/:workspaceId/delete-session`
  - `POST /api/control/workspaces/:workspaceId/append-timeline`
- Add a lightweight client in `workspace-runtime` to call those APIs.
- Keep [`packages/claxedo-server/src/routes/agent-session.ts`](/Users/yashvardhansingh/.codex/worktrees/b0da/opencode/packages/claxedo-server/src/routes/agent-session.ts) compatibility hooks in place for local paths and hosted fallback paths, but stop treating them as the future hosted contract.

### Acceptance criteria

- hosted metadata and timeline writes can occur without proxy body interception
- runtime contracts are explicit and test-covered
- compatibility behavior still works

## Phase 5: Cut Hosted Reads Over to Canonical Metadata and Projections

### Goal

Replace merged/cached hosted reads with projection-backed reads while preserving local semantics.

### Test-first work

Add failing tests in:

- [`packages/claxedo-server/src/control-plane.integration.test.ts`](/Users/yashvardhansingh/.codex/worktrees/b0da/opencode/packages/claxedo-server/src/control-plane.integration.test.ts)
- [`packages/claxedo-server/src/session-grouping.integration.test.ts`](/Users/yashvardhansingh/.codex/worktrees/b0da/opencode/packages/claxedo-server/src/session-grouping.integration.test.ts)
- [`packages/claxedo-server/src/proxy.test.ts`](/Users/yashvardhansingh/.codex/worktrees/b0da/opencode/packages/claxedo-server/src/proxy.test.ts)

Write tests that prove:

1. hosted session list/detail reads come from canonical metadata and projections
2. timeline reads prefer projections/replay-backed sources instead of ad hoc adapter fallbacks
3. current merged-source behavior is still available behind a compatibility flag during rollout

### Production changes

- Refactor `AgentSessionRoutes.listSessions`, `getMessages`, and related read paths to use the injected `ProjectionStore`.
- Refactor any hosted session list composition in `opencode-compat.ts` to consume canonical/projection reads instead of merging local/runtime/cache views for hosted workspaces.
- Keep local-only flows unchanged where they are genuinely local.

### Acceptance criteria

- hosted reads no longer depend on merged source-of-truth behavior
- projections become the primary browser-facing hosted read model
- fallback/repair behavior is explicit instead of hidden inside merged reads

## Phase 6: Introduce WorkflowEngine With a Compatibility Adapter

### Goal

Create the durable execution seam for:

- scheduled runs
- approval waits
- webhook wakes
- retries, cancel, and resume

without yet requiring the full final hosted rollout.

### Test-first work

Add failing tests in:

- [`packages/claxedo-server/src/agent-lifecycle.integration.test.ts`](/Users/yashvardhansingh/.codex/worktrees/b0da/opencode/packages/claxedo-server/src/agent-lifecycle.integration.test.ts)
- a new `packages/claxedo-server/src/control-plane/workflow-engine.test.ts`

Write tests that prove:

1. workflow runs can be started and tracked separately from workspace authority
2. wait/retry/cancel semantics are represented in one workflow interface
3. workflow summaries can be projected back into control-plane reads

### Production changes

- Add `WorkflowEngine` interface and a first adapter that can be implemented locally in-process for tests and desktop.
- Thread workflow references into the projection layer so browser reads can show workflow status without conflating workflow state with session metadata.
- Do not bind browser/runtime traffic to the workflow provider yet; this phase is about the execution seam and contract only.

### Acceptance criteria

- workflow execution has a first-class seam in code
- workspace authority and workflow execution are clearly separate
- workflow summaries are queryable through projections

## Phase 7: Add Relay/Bootstrap Contracts and Demote the Permanent Proxy

### Goal

Make the control plane the source of attach/bootstrap information while moving long-lived hosted connectivity away from `workspaceRuntimeProxy`.

### Test-first work

Add failing tests in:

- [`packages/claxedo-server/src/proxy.test.ts`](/Users/yashvardhansingh/.codex/worktrees/b0da/opencode/packages/claxedo-server/src/proxy.test.ts)
- [`packages/claxedo-app/src/overrides/context/server-url.test.ts`](/Users/yashvardhansingh/.codex/worktrees/b0da/opencode/packages/claxedo-app/src/overrides/context/server-url.test.ts)
- [`packages/claxedo-app/src/overrides/components/terminal-connection.test.ts`](/Users/yashvardhansingh/.codex/worktrees/b0da/opencode/packages/claxedo-app/src/overrides/components/terminal-connection.test.ts)

Write tests that prove:

1. hosted session bootstrap can return a non-null attach URL / relay descriptor
2. the frontend uses that value instead of assuming localhost/proxy routing
3. the existing proxy path can be bypassed behind a feature flag

### Production changes

- Add bootstrap/read APIs in `claxedo-server` for hosted attach metadata.
- Implement real `resolveSessionUrl()` in [`packages/claxedo-app/src/extensions/server.tsx`](/Users/yashvardhansingh/.codex/worktrees/b0da/opencode/packages/claxedo-app/src/extensions/server.tsx) using control-plane bootstrap data.
- Demote [`packages/claxedo-server/src/proxy.ts`](/Users/yashvardhansingh/.codex/worktrees/b0da/opencode/packages/claxedo-server/src/proxy.ts) to:
  - internal health/config compatibility
  - rollout fallback path
- Keep deletion of the proxy path itself for the final cleanup phase only after the frontend and runtime both speak the new bootstrap model.

### Acceptance criteria

- browser attachment no longer conceptually depends on the permanent proxy path
- hosted bootstrap data is explicit
- proxy routing is clearly compatibility-only

## Phase 8: Cleanup and Deletion

### Goal

Remove legacy architecture paths once the new seams are proven.

### Test-first work

Add or update final characterization tests in:

- [`packages/claxedo-server/src/control-plane.integration.test.ts`](/Users/yashvardhansingh/.codex/worktrees/b0da/opencode/packages/claxedo-server/src/control-plane.integration.test.ts)
- [`packages/claxedo-server/src/proxy.test.ts`](/Users/yashvardhansingh/.codex/worktrees/b0da/opencode/packages/claxedo-server/src/proxy.test.ts)
- [`packages/claxedo-server/src/cloud/session-sync.test.ts`](/Users/yashvardhansingh/.codex/worktrees/b0da/opencode/packages/claxedo-server/src/cloud/session-sync.test.ts)
- [`packages/claxedo-server/src/cloud/message-replay.test.ts`](/Users/yashvardhansingh/.codex/worktrees/b0da/opencode/packages/claxedo-server/src/cloud/message-replay.test.ts)

Write tests that prove:

1. hosted correctness still holds after removing legacy sync assumptions
2. compatibility code only remains where explicitly intended
3. replay, metadata, workflow, and authority paths all have one clear owner

### Production changes

- delete dead `sync-db` compatibility pieces if still present
- delete hosted-only `after*` hook persistence that the explicit runtime contracts replaced
- delete or heavily narrow any proxy routes that no longer need to front hosted runtime APIs
- update docs and comments that still describe the old mixed model as current target state

### Acceptance criteria

- one clear hosted architecture story remains in code
- all long-term owners match the architecture docs
- compatibility code is intentionally minimal

## TDD Rules For Every Phase

1. Write the smallest failing test that proves the new boundary, not just the new method.
2. Preserve current behavior with compatibility adapters before changing the read/write center.
3. Prefer integration tests for control-plane boundaries and unit tests for ordering/idempotency rules.
4. Do not introduce a second equal canonical path during rollout.
5. Keep phases independently shippable behind composition flags or compatibility fallbacks.

## Test Execution Matrix

Run from `packages/claxedo-server`:

- `bun test src/control-plane.integration.test.ts`
- `bun test src/agent-lifecycle.integration.test.ts`
- `bun test src/proxy.test.ts`
- `bun test src/cloud/message-replay.test.ts`
- `bun test src/cloud/session-sync.test.ts`
- `bun test src/cloud/workspace-supervisor.test.ts`
- `bun test src/runtime-contract.test.ts`
- `bun typecheck`

Run from `packages/claxedo-app` when the relay/bootstrap work begins:

- `bun test src/overrides/context/server-url.test.ts`
- `bun test src/overrides/components/terminal-connection.test.ts`
- `bun typecheck`

## Assumptions and Defaults

- `WorkspaceAuthority` in `cloud/authority.ts` remains the semantic base for lease and epoch behavior.
- SQLite remains the first adapter for metadata/timeline/projection interfaces.
- `WorkflowEngine` starts as an abstraction with a simple local adapter before any hosted provider-specific rollout.
- The current proxy path remains as a migration bridge until the relay/bootstrap path is real.
- This plan intentionally defers vendor lock-in decisions for workflow and relay infrastructure until the seams are implemented and tested.
