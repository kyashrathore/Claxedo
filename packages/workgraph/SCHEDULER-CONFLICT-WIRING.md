# Plan: TDD-Based Wiring of Scheduler + Conflict into WorkGraph

## Context

The cascade execution is already implemented: `onNodeStatusUpdate` (executor.ts:708) calls
`checkRunCompletion` → `findReadyNodes` → `spawnTaskAgent`. When a node completes, downstream
nodes auto-execute. The subtree runs itself.

Four components exist in isolation. Two are viable to wire now; two need more infrastructure:

| Component | Wire Now? | Reason |
|-----------|-----------|--------|
| Scheduler (leases + policies) | **YES** | Self-contained, no new deps |
| Conflict detection | **YES** | Self-contained, just add to event append path |
| Router | **NO** | Heuristic `resolveRoute()` is worse than planner's LLM role. Needs AI-based routing. |
| LeadLoop | **NO** | Needs `/health` endpoint per spawned agent to track real heartbeats |

**Branch:** `feat/workgraph-orchestrator-core`
**Working dir:** `packages/workgraph/`
**Test runner:** `bun run test` (NOT `bun test` — package.json script passes `--conditions=browser`)

---

## What the Executor Already Does (Do Not Redesign)

- `startOrchestration()` → spawns PLANNER agent → planner calls `finish_planning` MCP tool
- `onPlanningComplete()` → `beginExecution()` → `findReadyNodes()` → `spawnTaskAgent()` (first batch)
- `onNodeStatusUpdate()` → `checkRunCompletion()` → `findReadyNodes()` → spawn next batch **(THE CASCADE)**
- Retry logic, cascade failure, run completion all in `executor.ts`

---

## Wiring Change 1: Scheduler

**Current:** `findReadyNodes()` (executor.ts:862) — plain DB query, no leases, no parallelism caps.

**Change:** Replace the calls to `findReadyNodes()` inside `beginExecution()` (line 654) and
`checkRunCompletion()` (line 1169) with a new internal helper
`findScheduledReadyNodes(db, runId, state)` that:

1. Runs the same cascade-failure detection logic as `findReadyNodes` (marks blocked/failed nodes)
2. Builds `Node[]` from DB (mapping DB statuses to `Node["status"]`)
3. Builds `GraphEngine` from DB edges (all treated as `"hard"` — consistent with existing behavior)
4. Builds `nodeTeamMap` from `nodes_current.role`
5. Calls `getReadyNodes(nodes, graph, { leaseManager, teamPolicy, nodeTeamMap })` from `scheduler.ts`
6. Returns `string[]` of node IDs

Keep `findReadyNodes` exported unchanged — it is used directly by existing tests
(`executor.test.ts`, `orchestrator.test.ts`).

**Additional changes in executor.ts:**
- In `spawnTaskAgent()`: acquire `state.leaseManager.acquireLease(nodeId)` before spawning.
  If lease cannot be acquired, skip (already dispatched).
- In `onNodeStatusUpdate()`: release `state.leaseManager.releaseLease(nodeId)` on both
  `"completed"` and `"failed"` (retries exhausted) paths.
- In `startOrchestration()` and `startExecution()`: add `teamPolicy?: TeamPolicy` to opts,
  initialize `state.leaseManager = new LeaseManager()` and
  `state.teamPolicy = opts?.teamPolicy ?? { maxActivePerRun: 12, maxActivePerTeam: 4 }`.
- In `ensureState()`: same defaults for reconstructed state objects.

**Change in types.ts:**
- Import `LeaseManager`, `TeamPolicy` from `./core/scheduler`
- Add `leaseManager: LeaseManager` and `teamPolicy: TeamPolicy` to `OrchestratorRunState`

---

## Wiring Change 2: Conflict Detection

**Current:** `appendEvent()` in `event-store.ts` inserts without checking for conflicts.

**Change:** Before inserting the new event, query:
```sql
SELECT id, created_at FROM events WHERE stream_id = ? AND stream_seq = ?
```
(using the computed `seq` value, before the INSERT)

If a row exists **with a different `id`**:
1. Call `detectConflict(localEvent, remoteEvent)` from `src/orchestrator/sync/conflict.ts`
2. Call `resolveConflict(conflict, "lww")` — last-writer-wins on `created_at`
3. If the remote event (already in DB) is the winner → skip INSERT, return remote event
4. If the local event is the winner → DELETE the remote row, then INSERT local

If a row exists **with the same `id`** → idempotent re-insert, handled already by `op_id` UNIQUE.

---

## Files to Create / Modify

**NEW:**
- `test/unit/scheduler-wiring.test.ts` — unit tests for scheduler integration (Wave 1)
- `test/integration/conflict-wiring.test.ts` — conflict detection on event append (Wave 2)
- `test/integration/autonomous-e2e.test.ts` — full pipeline with scheduler + conflict (Wave 3)
- `LATER.md` — deferred Router + LeadLoop items

**MODIFIED:**
- `src/orchestrator/executor.ts` — replace `findReadyNodes()` calls with `findScheduledReadyNodes()`, add lease lifecycle
- `src/orchestrator/types.ts` — add `leaseManager: LeaseManager` and `teamPolicy: TeamPolicy` to `OrchestratorRunState`
- `src/orchestrator/core/services/event-store.ts` — add conflict detection in `appendEvent()`

---

## TDD Wave 1 — Unit: Scheduler Wiring (`test/unit/scheduler-wiring.test.ts`)

Setup: in-memory SQLite via `makeDb()` + `initializeDb()`, standard `live()` spawn mock.

| # | Test | Assertion |
|---|------|-----------|
| 1 | respects maxActivePerRun | 5 pending nodes, `maxActivePerRun=2` → spawn called exactly 2× on first dispatch |
| 2 | respects maxActivePerTeam | 4 nodes same team (`role: "team_alpha"`), `maxActivePerTeam=2` → only 2 dispatched initially |
| 3 | lease acquired on dispatch | After `onPlanningComplete`, `state.leaseManager.isLeased(nodeId)` is true |
| 4 | lease released on completion | After `onNodeStatusUpdate(..., "completed")`, `state.leaseManager.isLeased(nodeId)` is false |
| 5 | lease released on failure | After `onNodeStatusUpdate(..., "failed")` with retries exhausted, lease released |
| 6 | downstream dispatched after upstream | Node B blocked on A → A completes → B dispatched in next cycle |

---

## TDD Wave 2 — Integration: Conflict (`test/integration/conflict-wiring.test.ts`)

| # | Test | Assertion |
|---|------|-----------|
| 1 | duplicate stream_seq detected | Remote event at seq=1 + local append to seq=1 → exactly 1 row for that seq |
| 2 | LWW: later timestamp wins | Local event with later `created_at` replaces earlier remote event |
| 3 | LWW: remote wins when later | Local event with earlier `created_at` is skipped; remote row stays |
| 4 | no conflict for different seq | Two events with different stream_seq → both inserted cleanly |
| 5 | idempotent re-insert (same op_id) | Same event appended twice → no conflict, no duplicate |

---

## TDD Wave 3 — E2E: Full Pipeline (`test/integration/autonomous-e2e.test.ts`)

| # | Test | Assertion |
|---|------|-----------|
| 1 | goal → all nodes complete | Mock planner builds diamond graph → cascade → all nodes "completed", `state.phase === "completed"` |
| 2 | scheduler obeys team policy mid-run | After `onPlanningComplete`, active node count ≤ `maxActivePerTeam` for same-team nodes |
| 3 | concurrent events resolved, no corruption | Remote event at seq=1 + local append → LWW → one canonical row, correct winner |
| 4 | event replay deterministic | Two replays of same event log → `JSON.stringify(s1) === JSON.stringify(s2)` |

---

## Implementation Order

1. Write `test/unit/scheduler-wiring.test.ts` — RED
2. Modify `src/orchestrator/types.ts` + `src/orchestrator/executor.ts` (scheduler wiring) — GREEN
3. Write `test/integration/conflict-wiring.test.ts` — RED
4. Modify `src/orchestrator/core/services/event-store.ts` (conflict detection) — GREEN
5. Write `test/integration/autonomous-e2e.test.ts` — should be GREEN after above changes
6. `bun run test` — all existing + new tests pass

---

## Key Implementation Notes

### `findScheduledReadyNodes` DB-to-Graph mapping

```typescript
// DB status → GraphEngine Node status
function dbStatusToNodeStatus(s: string): Node["status"] {
  if (s === "active" || s === "completed" || s === "failed" || s === "retryable") return s;
  if (s === "blocked" || s === "cancelled") return "failed"; // terminal, not dispatchable
  return "pending";
}
```

All `dependency_edges_current` rows are mapped to `type: "hard"` in `GraphEngine` — consistent
with how `findReadyNodes` currently treats all edges as blocking.

### Conflict resolution in `appendEvent()`

The seq computation happens before the INSERT. Use that seq value to check for conflicts:

```typescript
// After computing seq, before inserting:
const existing = await this.db
  .select({ id: events.id, created_at: events.created_at })
  .from(events)
  .where(and(eq(events.stream_id, partial.stream_id), eq(events.stream_seq, seq)))
  .limit(1);

if (existing.length > 0 && existing[0].id !== envelope.id) {
  const conflict = detectConflict(envelope, existing[0]);
  if (conflict) {
    const resolved = resolveConflict(conflict, "lww");
    if (resolved.resolution === existing[0]) return existing[0] as EventEnvelope; // remote wins
    // local wins: replace remote
    await this.db.delete(events).where(eq(events.id, existing[0].id));
    // fall through to INSERT
  }
}
```

---

## Verification

```bash
cd /Users/yashvardhansingh/test/opencode/packages/workgraph
git checkout feat/workgraph-orchestrator-core

bun run test   # must use bun run test, not bun test

# New test files specifically:
bun test test/unit/scheduler-wiring.test.ts
bun test test/integration/conflict-wiring.test.ts
bun test test/integration/autonomous-e2e.test.ts
```

Expected: all existing passing tests still pass + ~14 new tests pass.

---

## Deferred Items (LATER.md)

### Router: AI-Based Team Routing
The planner LLM already assigns `role` to each node. The heuristic `resolveRoute()` in
`routing.ts` (keyword matching, 0.85–0.90 confidence bands) is worse than the LLM's judgment.

**Needed later:** Replace keyword heuristics in `routing.ts` with a Claude API call
(`claude-opus-4-6`) that reasons about node title/kind → team assignment. Integrate into
`spawnTaskAgent()` as an async pre-dispatch enrichment step.

### LeadLoop: Agent Health Endpoint
Current `attempts_current.last_heartbeat_at` is only set at attempt create/finish time.
There is no in-flight heartbeat signal from running agents.

**Needed later:**
- Each spawned agent needs to `POST /runs/:run_id/nodes/:node_id/heartbeat` periodically
- `StallMonitor` class reads `last_heartbeat_at` from `attempts_current`
- Periodic `setInterval` calls `detectGaps()` and triggers reroute on silence
- Requires: heartbeat endpoint in `app.ts`, agent SDK changes to emit heartbeats
