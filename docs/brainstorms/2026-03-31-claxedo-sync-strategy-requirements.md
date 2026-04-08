---
date: 2026-03-31
topic: claxedo-sync-strategy
---

# Claxedo Sync Strategy

## Problem Frame

Claxedo currently has a working local control-plane sync layer in `claxedo-server`, centered on local SQLite tables for session metadata, cloud session cache data, and message replay. This gives us a strong local-first experience and already supports useful merged session views across local, cloud, and global contexts.

However, the current model is architecturally mixed:

- Session metadata and cloud cache writes are best-effort hook side effects.
- Message replay is event-derived.
- Read paths merge multiple sources rather than reading from a single canonical owner.
- The current target RFC already assumes a `SyncDB` abstraction with `SQLiteSyncDB` as the initial backend, but its broader direction still leans toward remote canonical ownership as the main product story rather than an explicit opt-in mode.

The product direction for this brainstorm is:

- Local SQLite remains first-class by default.
- Remote sync is an explicit app-level opt-in.
- When remote sync is enabled, the remote store should eventually become canonical for all metadata except PTY stream output.
- If the remote store is unavailable, the product should continue to accept writes locally and reconcile later instead of failing closed.

The main problem is not whether the current system works. It does. The problem is that we need a cleaner architecture boundary so we can keep the default local experience simple while also making the opt-in remote mode correct enough for multi-device use.

## Requirements

**Default Mode**
- R1. The default Claxedo experience must remain fully local-first, with local SQLite as the primary metadata and replay store.
- R2. The default mode must not require any remote metadata backend, remote auth dependency, or central service to preserve core session, workspace, and message continuity on a single device.
- R3. The architecture must treat the default local SQLite system as a supported primary mode, not as a temporary compatibility shim.

**Remote Sync Mode**
- R4. Claxedo must support an explicit app-level opt-in that enables remote sync for users who want stronger multi-device continuity.
- R5. When remote sync is enabled, the remote store must cover all metadata domains except PTY stream output.
  Included domains are sessions, messages, message parts, PTY metadata, process definitions, workspace registry metadata, pages, workgraph metadata, and app or user config metadata.
- R6. The product must clearly preserve the distinction between remote metadata sync and live runtime streaming.
  Remote sync does not imply globally canonical PTY stdout or stderr transport.
- R7. Remote sync enablement must be reversible without making the local-first mode unusable or degrading the local-only product path.
- R8. Remote-enabled mode may roll out canonical ownership in staged domain groups, but the intended end state for remote-enabled mode remains all metadata domains except PTY stream output.

**Consistency Model**
- R9. In default local mode, local SQLite is the canonical metadata owner.
- R10. In remote-enabled mode, local writes must still succeed when the remote backend is temporarily unavailable, with reconciliation happening later.
- R11. Remote-enabled mode must define explicit reconciliation semantics so that delayed remote writes do not create silent dual-writer ambiguity.
- R12. In remote-enabled mode, local persistence during outage or degraded operation must be treated as queued or cached state for later reconciliation, not as a second equal canonical owner.
- R13. The architecture must define canonical ownership per entity for each mode, rather than relying on mixed merged-source behavior as the permanent design.
- R14. The app-level opt-in state must have one durable global owner that survives restarts and can be consulted consistently by routing and sync paths.

**Carrying Cost and Simplicity**
- R15. The next architecture step must minimize duplicated sync paths and avoid introducing a second permanent architecture that exists only to bridge to a future design.
- R16. New abstractions must be justified by reducing long-term system complexity, not by speculative backend flexibility alone.
- R17. The sync architecture must preserve fast local UX and keep offline-capable behavior strong even after remote sync is introduced.

**Observability and Repair**
- R18. Any mode with reconciliation must make repair behavior explicit, observable, and testable.
- R19. The system must expose enough metrics and logs to distinguish local canonical reads, remote canonical reads, queued writes, replay fallback, and reconciliation failures.
- R20. Planning must define how users and operators can tell whether remote-enabled state is healthy, degraded, or lagging.

## Success Criteria

- The project has one clear architecture story for sync instead of separate implicit stories for current code and future RFCs.
- A planner can answer, for each entity, who is canonical in local mode and who is canonical in remote-enabled mode without inventing behavior.
- The local-first product path remains simple and durable.
- The remote-enabled path improves multi-device correctness without forcing fail-closed behavior for normal local work.
- We reduce architecture drift between current implementation and target documentation.

## Scope Boundaries

- This brainstorm does not choose a specific remote backend vendor or storage product.
- This brainstorm does not require PTY stdout or stderr to become canonical remote data.
- This brainstorm does not define low-level schema, migration ordering, queue implementation, or endpoint design.
- This brainstorm does not require immediate removal of current SQLite tables or merged read paths.

## Key Decisions

- Default mode stays local-first with local SQLite as canonical.
  Rationale: this aligns with the strongest current experience and avoids making the primary product path depend on remote infrastructure.

- Remote sync is app-level opt-in, not default and not per-workspace.
  Rationale: this keeps the user mental model simpler and reduces configuration fragmentation.

- Remote-enabled mode should cover all metadata domains except PTY stream output.
  Rationale: this is the cleanest way to achieve multi-device correctness without overreaching into full terminal stream replication.

- Remote-enabled mode should queue locally and reconcile later instead of failing closed.
  Rationale: this preserves local usability and avoids making the product brittle during transient remote outages.

- Remote-enabled mode should be staged rather than treated as a one-pass cross-package cutover.
  Rationale: the desired end state is broad, but the rollout should not force every metadata domain to migrate in a single implementation phase.

- The future architecture should be judged by whether it reduces carrying cost, not by whether it maximizes theoretical backend flexibility.
  Rationale: the main risk is growing a second long-lived sync architecture rather than converging on a clear one.

## Dependencies / Assumptions

- The current local SQLite control plane remains maintainable enough to act as the first-class default mode.
- Users who opt into remote sync are willing to accept eventual reconciliation semantics when offline or degraded.
- A remote metadata system can be introduced without requiring PTY stream canonicalization.

## Outstanding Questions

### Resolve Before Planning

None.

### Deferred to Planning

- [Affects R5][Technical] Should remote-enabled mode use one shared persistence contract for both local and remote backends, or should local mode keep today’s direct SQLite implementation until remote mode is ready?
- [Affects R8][Technical] Which metadata domains should form the first staged rollout for remote-enabled mode, and which should remain local-derived until later phases?
- [Affects R10][Technical] What queueing and retry model gives us local-first writes in remote-enabled mode without creating hidden conflict behavior?
- [Affects R11][Needs research] What last-write-wins, versioning, or operation-log semantics are sufficient for remote reconciliation across all metadata entities?
- [Affects R13][Technical] Which current merged read paths should remain as transitional compatibility layers, and which should be replaced first by canonical reads?
- [Affects R14][Technical] Where should the app-level remote-sync opt-in live so every process and route sees the same durable value?
- [Affects R18][Technical] What repair jobs are required for session metadata, message history, PTY metadata, and workspace registry drift?
- [Affects R20][Product] How should the app present remote-enabled sync health, lag, and degraded mode to users without adding too much UI burden?
- [Affects R10][Technical] What shadow-write or parity-check phase is required before any remote-enabled domain is treated as canonical for reads?

## Next Steps

→ /prompts:ce-plan for structured implementation planning
