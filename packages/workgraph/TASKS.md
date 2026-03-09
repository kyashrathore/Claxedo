# WorkGraph: Pending Work

Status snapshot as of 2026-03-09. Each task is independent and can be picked up by a separate agent.

---

## P0 — Server Cannot Start

### TASK-01: Fix self-referencing import in workgraph-bridge.ts

**File:** `src/orchestrator/workgraph-bridge.ts`
**Problem:** Line 1 imports `from "@opencode-ai/workgraph"` — the package's own npm name. Bun cannot resolve it because the package is not published/symlinked.
**Fix:** Change the import to relative paths:
- `WorkGraph` class → `../model/workgraph`
- `WorkItem` type → `../model/types`

**Verify:** `bun run src/server.ts` starts without "Cannot find module" error.

---

### TASK-02: Fix stale tsconfig.json project references

**File:** `tsconfig.json`
**Problem:** `references` points to `../orchestrator-graph` and `../orchestrator-events` — packages deleted during consolidation. Also `rootDir: "./src"` conflicts with `include: ["test/**/*"]`.
**Fix:**
- Remove both stale `references` entries (or remove the `references` array entirely).
- Either add `test/` to a separate tsconfig or change `rootDir` to `.`.

**Verify:** `bunx tsc --noEmit` no longer errors on missing project references.

---

## P1 — 63 of 67 Tests Fail (Broken Imports)

### TASK-03: Fix test imports — old flat paths

**Scope:** 53 test files under `test/` use pre-consolidation flat import paths.
**Problem:** When 14 packages were merged into one, source files moved into subdirectories but test imports were never updated.

**Import mapping (apply to ALL test files):**

| Old import | New import |
|---|---|
| `../src/reducers/*` | `../src/orchestrator/core/reducers/*` |
| `../src/gates` | `../src/orchestrator/graph/gates` |
| `../src/graph` | `../src/orchestrator/graph/graph` |
| `../src/scheduler` | `../src/orchestrator/core/scheduler` |
| `../src/schema` | `../src/orchestrator/events/schema` |
| `../src/event-types` | `../src/orchestrator/events/event-types` |
| `../src/reducer` | `../src/model/reducer` |
| `../src/workgraph` | `../src/model/workgraph` |
| `../src/db` | `../src/model/db` |
| `../src/types` | `../src/model/types` |
| `../src/hooks` | `../src/model/hooks` |
| `../src/services/*` | `../src/orchestrator/core/services/*` |
| `../src/sync` | `../src/orchestrator/sync/sync` |
| `../src/conflict` | `../src/orchestrator/sync/conflict` |
| `../src/capabilities` | `../src/orchestrator/core/capabilities` |
| `../src/quality-gate` | `../src/orchestrator/core/quality-gate` |
| `../src/routing` | `../src/orchestrator/core/routing` |
| `../src/github` | `../src/connectors/github/github` |
| `../src/jira` | `../src/connectors/jira/jira` |
| `../src/linear` | `../src/connectors/linear/linear` |
| `../src/html-renderer` | `../src/renderers/html-brief/html-renderer` |
| `../src/renderer` | `../src/renderers/markdown/renderer` |

**Verify:** `bun test` — all 67 test files load without import errors.

---

### TASK-04: Fix test imports — deleted package names

**Scope:** ~30 test files import from `@opencode-ai/orchestrator-graph`, `@opencode-ai/orchestrator-events`, `@opencode-ai/orchestrator-core`.
**Fix:** Replace with relative imports per this mapping:

| Old package import | New relative import |
|---|---|
| `@opencode-ai/orchestrator-graph` (`GraphEngine`) | `../src/orchestrator/graph/graph` |
| `@opencode-ai/orchestrator-events` (`EventEnvelope`, `ConnectorInterface`) | `../src/orchestrator/events/schema` or `../src/orchestrator/events/connector` |
| `@opencode-ai/orchestrator-core/src/capabilities` | `../src/orchestrator/core/capabilities` |

**Verify:** `bun test` — no "Cannot find module @opencode-ai/*" errors.

---

### TASK-05: Fix source imports — deleted package names in src/

**Scope:** Source files in `src/model/` still import from `@opencode-ai/*` packages.
**Files:**
- `src/model/workgraph.ts` — imports from `@opencode-ai/orchestrator-graph`
- `src/model/hooks.ts` — imports from `@opencode-ai/orchestrator-events`
**Fix:** Replace with relative imports to the local files.

**Verify:** `bun run src/server.ts` starts. `bun test` passes for workgraph.test.ts and hooks.test.ts.

---

## P2 — Remove Dead Code (Per Simplified Spec v2)

### TASK-06: Delete team-related reducers and schema

**Delete these files entirely:**
- `src/orchestrator/core/reducers/team.ts` (72 lines — team_created, team_status_changed, team_member_added handlers)
- `src/orchestrator/core/reducers/handoff.ts` (72 lines — handoff_requested/accepted/rejected handlers)

**Delete these test files:**
- `test/team_reducer.test.ts`
- `test/handoff_reducer.test.ts`

**Update `src/orchestrator/core/reducers/index.ts`:**
- Remove `team` and `handoff` from `RootState` and `rootReducer` composition.

**Delete from `src/orchestrator/core/db/schema.ts`:**
- `teams_current` table definition
- `team_members_current` table definition
- `handoffs_current` table definition

**Update `src/app.ts`:**
- Remove `CREATE TABLE teams_current` SQL
- Remove `POST /runs/:run_id/teams` endpoint
- Remove `GET /runs/:run_id/teams` endpoint

**Verify:** `bun test` still passes for all non-deleted tests. Server starts without team tables.

---

### TASK-07: Delete unused decision/lead/message reducers

**Delete these files entirely:**
- `src/orchestrator/core/reducers/decision.ts` (decision_proposed/challenged/accepted/rejected — never emitted)
- `src/orchestrator/core/reducers/lead.ts` (lead_plan_created/gap_detected/reroute_requested — never emitted)
- `src/orchestrator/core/reducers/message.ts` (message_posted — MessageState never queried)

**Delete these test files:**
- `test/decision_reducer.test.ts`
- `test/lead_reducer.test.ts` (if exists)
- `test/message_reducer.test.ts`

**Delete from `src/orchestrator/core/db/schema.ts`:**
- `messages_current` table definition
- `decisions_current` table definition

**Update `src/orchestrator/core/reducers/index.ts`:**
- Remove `decision`, `lead`, `message` from `RootState` and `rootReducer`.

**Update `src/app.ts`:**
- Remove `CREATE TABLE messages_current` SQL
- Remove `POST /runs/:run_id/messages` endpoint
- Remove `GET /runs/:run_id/messages` endpoint

**Verify:** `bun test` passes. No references to deleted reducers remain.

---

### TASK-08: Delete unused planning reducer

**Delete:**
- `src/orchestrator/core/reducers/planning.ts` (question_scoped, route_scored, route_selected, dispatch_requested handlers — none emitted in source)

**Delete test:**
- `test/planning_reducer.test.ts`

**Update `src/orchestrator/core/reducers/index.ts`:**
- Remove `planning` from `RootState` and `rootReducer`.

**Verify:** `bun test` passes.

---

### TASK-09: Remove team_id from nodes, executor, graph-builder, session-bridge

**Files to modify:**
- `src/orchestrator/types.ts` — remove `team` from `DecomposedTask`, remove `teams` from `DecompositionPlan`, remove `team_id_map` from `OrchestratorRunState`. Add `role` field to `DecomposedTask`.
- `src/orchestrator/graph-builder.ts` — remove team creation loop (lines ~25-55), remove `team_id` from node creation. Add `role` field.
- `src/orchestrator/executor.ts` — remove `team_id` from message storage, remove team_id references.
- `src/orchestrator/session-bridge.ts` — replace `task.team` agent lookup with `node.role`.
- `src/orchestrator/planner.ts` — update decomposition prompt: remove team assignment, add role assignment (architect, developer, code_reviewer, qa, pm, designer).
- `src/orchestrator/core/reducers/node.ts` — remove `team_id` from `NodeState`.
- `src/orchestrator/core/db/schema.ts` — remove `team_id` column from `nodes_current`.
- `src/ui/dashboard.html.ts` — remove team rendering (team table, team colors on canvas, team grouping in messages).

**Verify:** `bun test` passes. Server starts. `POST /orchestrate` with a test goal produces nodes with `role` instead of `team_id`.

---

### TASK-10: Delete unused capability packs

**Delete these directories entirely:**
- `src/capabilities/execution/`
- `src/capabilities/research/`
- `src/capabilities/ux/`

**Delete test files:**
- `test/capabilities/execution-pack.test.ts`
- `test/capabilities/research-pack.test.ts`
- `test/capabilities/ux-pack.test.ts`

**Check:** `src/orchestrator/core/capabilities.ts` — if `CapabilityRegistry` is never instantiated in source, delete it too.

**Verify:** No import errors. `bun test` passes.

---

### TASK-11: Delete unused renderers

**Delete these directories entirely:**
- `src/renderers/html-brief/`
- `src/renderers/markdown/`

**Delete test files:**
- `test/renderers/html-renderer.test.ts`
- `test/renderers/renderer.test.ts`

**Verify:** No import errors. `bun test` passes.

---

### TASK-12: Wire connectors into app or delete them

**Current state:** `src/connectors/github/`, `src/connectors/jira/`, `src/connectors/linear/` exist but are never instantiated in source code. Only tests import them (with broken paths).

**Decision needed:** Either:
- **(A) Keep and wire:** Register connectors in `app.ts` or a service, so hydration routes actually use them.
- **(B) Delete:** Remove all three connector directories + their tests. Hydration routes become stubs until connectors are needed.

If keeping, fix the test imports first (TASK-03/04).

---

### TASK-13: Delete unused artifacts_current schema

**File:** `src/orchestrator/core/db/schema.ts`
**Delete:** `artifacts_current` table definition (never created in DB, never queried).

**Verify:** No references to it in source.

---

## P3 — Add Scratchpad Context Flow (Per Spec v2)

### TASK-14: Implement upstream scratchpad injection in executor

**Spec reference:** SPEC.md Section 7.4 — `collectUpstreamScratchpads`
**What:** When the executor dispatches a node, gather scratchpad entries from all completed upstream nodes (connected via hard/review_gate edges) and append them to the agent's prompt.
**Files:**
- `src/orchestrator/executor.ts` — add `collectUpstreamScratchpads(db, node)` and call it before `executeNode`.
- `src/orchestrator/core/db/schema.ts` — ensure `scratchpad_entries` table has `node_id` (it already does per dead-code analysis).

**Test:** Integration test: create 2 nodes (A→B hard edge), write scratchpad on A, complete A, dispatch B — verify B's prompt includes A's scratchpad content.

---

### TASK-15: Implement role/skill file loading in SessionBackend

**Spec reference:** SPEC.md Section 4.3, 10.2
**What:** When creating a session for a node, load `skills/{role}.md` and prepend it to the agent's system prompt.
**Files:**
- `src/orchestrator/backends.ts` (or `session-bridge.ts`) — add `loadSkillFile(role)` function.
- Create `skills/` directory with starter skill files: `architect.md`, `developer.md`, `code_reviewer.md`, `qa.md`, `pm.md`, `designer.md`.

**Test:** Unit test: `loadSkillFile("developer")` returns content of `skills/developer.md`. Integration test: dispatched node with role="developer" has skill file content in prompt.

---

## P4 — Test Quality & Coverage

### TASK-16: Create .dev-docs/@tests.md for workgraph

**What:** Create `packages/workgraph/.dev-docs/@tests.md` documenting:
- Test architecture (bun:test, SQLite :memory:, test/ directory structure)
- How to run tests (`bun test`, `bun test test/specific-file.test.ts`)
- Test categories: unit (reducers, services, model), integration (pipelines, sync, connectors), smoke (ACP)
- Coverage gaps (listed below)
- Testing conventions (factory helpers, mock patterns, event-driven assertions)

---

### TASK-17: Add missing integration tests

**Current gaps (no integration test coverage):**
- Full goal → plan → execute → complete cycle (e2e-pipeline.test.ts exists but may be broken)
- Failure cascade: fail one node → verify dependents marked failed
- Retry: fail a node once → verify it retries and succeeds
- Concurrency: dispatch more nodes than `maxActivePerRun` → verify queuing
- Scratchpad context flow: upstream scratchpad → downstream prompt (requires TASK-14 first)
- Skill file loading per role (requires TASK-15 first)

**Test location:** `test/integration/`

---

### TASK-18: Audit and fix existing test quality

**Known issues:**
- `test/collaboration.test.ts` tests team handoffs — needs rewrite for scratchpad model
- `test/integration/collaboration-flow.test.ts` tests multi-team message flows — needs rewrite or delete
- Several reducer tests (team, handoff, decision, lead, message, planning) test deleted code — delete them (covered in TASK-06/07/08)
- Remaining tests need quality check: are assertions meaningful? Do they test behavior or just structure?

---

## Task Dependency Graph

```
TASK-01 ──┐
TASK-02 ──┤
TASK-05 ──┼──→ Server starts
          │
TASK-03 ──┤
TASK-04 ──┼──→ Tests load (import errors fixed)
          │
          ├──→ TASK-06 (delete team reducers)
          ├──→ TASK-07 (delete decision/lead/message reducers)
          ├──→ TASK-08 (delete planning reducer)
          ├──→ TASK-09 (remove team_id, add role) ──→ TASK-14 (scratchpad flow)
          │                                        ──→ TASK-15 (skill files)
          ├──→ TASK-10 (delete capability packs)
          ├──→ TASK-11 (delete renderers)
          ├──→ TASK-12 (connectors: wire or delete)
          ├──→ TASK-13 (delete artifacts_current)
          │
          └──→ TASK-16 (@tests.md)
               TASK-17 (integration tests) — depends on TASK-14, TASK-15
               TASK-18 (test audit) — depends on TASK-06/07/08
```

**Parallelism:** TASK-01 through TASK-05 can run in parallel. TASK-06 through TASK-13 can run in parallel after imports are fixed. TASK-14 and TASK-15 depend on TASK-09. TASK-16/17/18 are last.
