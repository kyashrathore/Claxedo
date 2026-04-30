---
date: 2026-03-31
topic: claxedo-sync-strategy
status: active
type: brainstorm
---

# Claxedo Sync Strategy

## Doc Role

- **Brainstorm / requirements input**
- informs [docs/sync-architecture-target.md](/Users/yashvardhansingh/.codex/worktrees/b0da/opencode/docs/sync-architecture-target.md)

## Problem Frame

Claxedo already has useful local durability in `workspace-runtime` and useful central persistence in `claxedo-server`, but the hosted architecture story is mixed:

- shared metadata is partly central and partly merged from compatibility paths
- message replay is event-derived
- runtime-local durability and hosted canonical ownership are not cleanly separated
- repair and reconciliation are under-specified

The problem is not whether the current system works. It does. The problem is that we need one clearer target for:

- canonical metadata ownership
- durable replay-worthy timeline ingestion
- repair and reconciliation
- local desktop adapter parity

This brainstorm is intentionally about those architecture requirements, not about a product-mode toggle or rollout flag as the primary architecture story.

## Requirements

### Canonical ownership

- R1. The architecture must define one canonical owner for each major entity family.
- R2. Shared session and workspace metadata must have an explicit hosted canonical owner.
- R3. Replay-worthy timeline events must have an explicit durable append path.
- R4. Runtime-local state may remain durable and valuable, but it must not be treated as a second equal hosted canonical owner.
- R5. PTY stdout and stderr do not need to become globally canonical data.

### Metadata and timeline split

- R6. The target architecture must separate shared metadata durability from runtime timeline durability.
- R7. Metadata tables should own listable/indexable product state such as session identity, workspace linkage, archive/title state, and attachments.
- R8. A durable timeline path should own ordered replay-worthy events such as runtime message flow and other session timeline data that must reconstruct cleanly.
- R9. The target architecture must not force every concern into one event log if a simpler canonical metadata table is the better fit.

### Repair and reconciliation

- R10. Repair behavior must be explicit, observable, and testable.
- R11. The architecture must define how projections are rebuilt from canonical sources.
- R12. Hosted drift between runtime-local state, canonical metadata, and timeline history must be detectable and repairable.
- R13. Retry and idempotency semantics must be explicit for both metadata writes and timeline appends.

### Local adapter parity

- R14. Local desktop and local dev must be supported through adapters that honor the same ownership rules, even if they use SQLite and in-process services.
- R15. Local adapter parity should reduce carrying cost rather than create a second long-lived architecture.
- R16. The hosted target should not depend on desktop-only shortcuts or merged read behavior to remain coherent.

### Observability

- R17. The system must expose enough metrics and logs to distinguish metadata write health, timeline append health, replay fallback, projection lag, and repair status.
- R18. Planning must define how operators can tell whether hosted metadata and timeline state are healthy, degraded, or lagging.

## Success Criteria

- A planner can answer who is canonical for each major entity family without inventing behavior.
- The architecture cleanly separates metadata ownership from timeline replay.
- Local runtime durability stays valuable without blurring hosted ownership.
- Repair and reconciliation are first-class parts of the design rather than best-effort afterthoughts.
- Local adapters and hosted control-plane paths can share the same architecture story.

## Scope Boundaries

- This brainstorm does not choose a specific database vendor, stream vendor, or relay vendor.
- This brainstorm does not require PTY stream bytes to become canonical data.
- This brainstorm does not define exact endpoint shapes or schema details.
- This brainstorm does not require every current compatibility read path to disappear immediately.

## Key Decisions

- Define canonical ownership by entity instead of by mode.
  Rationale: the long-term problem is not “local mode vs remote mode”; it is unclear ownership.

- Separate metadata durability from timeline durability.
  Rationale: shared product state and replay-oriented runtime state have different shapes and should not be forced into one model.

- Keep runtime-local durability valuable but non-competing.
  Rationale: runtime-local journals are useful for recovery, but they should not blur hosted canonical ownership.

- Make repair a first-class design concern.
  Rationale: if reconciliation is required, it must be explicit and testable.

- Require local adapter parity.
  Rationale: local desktop/dev should exercise the same architecture story instead of relying on one-off shortcuts.

## Dependencies / Assumptions

- The current local SQLite and runtime-local durability layers are strong enough to act as the first adapters.
- Hosted product state needs stronger canonical ownership than today’s merged-source behavior.
- Some replay-worthy state is better modeled as timeline append data than as final-table writes.

## Outstanding Questions

### Resolve Before Planning

None.

### Deferred to Planning

- [Affects R2][Technical] Which session and workspace metadata entities should move first to canonical hosted ownership?
- [Affects R8][Technical] Which runtime events should be durable timeline events in the first rollout?
- [Affects R11][Technical] Which projection views are required for browser reads and repair?
- [Affects R12][Technical] What reconciliation jobs are required for metadata drift, timeline gaps, and authority drift?
- [Affects R14][Technical] What local adapter seams best preserve parity without adding a second architecture?
- [Affects R17][Technical] What metrics and alerts are required for metadata health, timeline append health, replay fallback, and projection lag?

## Next Steps

→ [docs/sync-architecture-target.md](/Users/yashvardhansingh/.codex/worktrees/b0da/opencode/docs/sync-architecture-target.md) for the adopted target architecture
