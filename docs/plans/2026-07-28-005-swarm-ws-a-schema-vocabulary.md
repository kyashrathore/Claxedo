# WS-A — Schema + vocabulary foundation (the one coordinated breaking pass)

**Parent:** `2026-07-28-004` (master) · implements parts of A2/A5/A10/A11/A13 from `2026-07-28-003`.
**Executor profile:** one agent, mechanical discipline, high volume. Everything here is rename/add — **zero behavior change**. Behavior lands in WS-B/C/D against this schema.
**Why one pass:** renames touch every package; doing them once means dependents rebuild once. All *additive* schema (new tables) stays in the owning workstream — only renames + shared new columns/states/contracts live here.
**Sequencing:** land FIRST. WS-B/C/D/E branch from this.

## Non-goals (hard guards)
- NO behavior change: every test that passed before must pass after, modulo renamed identifiers.
- NO state-machine semantic changes (one state *rename* only, below).
- NO outcome removal/rename — plan 004 owns Outcomes' fate; untouched here.
- NO data migration code: zero users; old Convex tables are simply orphaned (delete their `schema.ts` entries; do not write `migrations.define` transforms).

## A1. The rename: attempt → run

Decision (owner, 2026-07-28, v0 authorship rule): the entity is a **run** everywhere — schema, types, wire contracts, routes, UI strings. Grounding: rename surface audit found ~4.3k domain hits, **zero i18n keys** (all UI strings hardcoded — `attempt-detail-view.tsx:35,39`, `item-dialogs.tsx:221`), no locale ripple.

**Rename (Convex `convex/schema.ts` + all functions):**
- `workgraph_attempts` → `workgraph_runs`; `attempt_number` → `run_number`.
- `workgraph_attempt_connection_bindings` → `workgraph_run_connection_bindings`; field `attempt_id` → `run_id`.
- `attempt_id` → `run_id` on: `workgraph_session_bindings.current_attempt_id` (:861), `workgraph_agent_checkpoints` (:877), `workgraph_durable_effect_receipts` (:1005), `workgraph_work_items.origin_attempt_id` (:792).
- Exported fns: `renewAttemptLease` (workgraphRuntime.ts:1648) → `renewRunLease`; `bindAttemptConnections`/`revokeAttemptBinding` (workgraphConnections.ts:127,555) → `bindRunConnections`/`revokeRunBinding`. All internal `attemptId`/`attempt` locals in `workgraphRuntime.ts` (285 hits), `workgraphCommands.ts` (211) follow.

**Rename (packages/workgraph):**
- `contracts/lifecycle.ts:27` state list: rename **`attention` → `parked`** (see A3). Other states keep their names.
- `contracts/commands.ts`: command types + wire strings — `cancel_attempt`→`cancel_run` (`CancelRunCommand`), `record_attempt_checkpoint`→`record_run_checkpoint`, `complete_attempt`→`complete_run`. (Wire strings are API; zero users = change them.)
- `contracts/attempt-operation.ts` → `contracts/run-operation.ts`: `WorkGraphAttemptOperation`→`WorkGraphRunOperation`, `WorkGraphAttemptToolNames`→`WorkGraphRunToolNames`, `MASTER_ATTEMPT_PREFIX`/`masterAttemptId`→`MASTER_RUN_PREFIX`/`masterRunId`. Keep `masterSessionId` as-is.
- `domain/attempt.ts` → `domain/run.ts`; `transitions.ts` `attemptTransitions`→`runTransitions`; `launch-readiness.ts` `hasRunningAttempt`→`hasLiveRun` (reason string `attempt_in_flight`→`run_in_flight`).
- `adapters/sqlite/schema.ts`: `wg_v2_attempts`→`wg_v2_runs` (+ column renames incl. `lease_epoch` — see A2); `store.ts` (358 hits) mechanical.
- HTTP router: `/attempts/:attemptId` → `/runs/:runId`; `/work-items/:id/attempts` → `/runs`.

**Rename (claxedo-server):** `workgraph-host/hosted-attempt-operation.ts` → `hosted-run-operation.ts` (+ its route mount in hosted-app.ts `/internal/workgraph/attempt-operation` → `/run-operation`); `hosted-runtime.ts` (86), `convex-store.ts`, `local-master-runtime.ts` identifiers. Mirror zod in `workspace-runtime/src/routes/workgraph-attempt-tools.ts` → `workgraph-run-tools.ts` (tool names the agent sees: `workgraph_*` tool ids containing `attempt` → `run`).

**Rename (claxedo-app, `features/workgraph/` ONLY — 361 domain hits):** `attempt-detail-view.tsx`→`run-detail-view.tsx` (`RunDetailView`), hardcoded strings "Attempt"→"Run", `waiting-source.ts`, `item-dialogs.tsx`, `api.ts` types.

**Rename (claxedo-mcp):** `workgraph-tools.ts:199` `record_type` enum value `"attempt"`→`"run"`; any tool descriptions.

**EXCLUSION LIST — do NOT touch (false-positive traps, from the audit):**
- Retry counters that mean "retry count", not the entity: `workgraph_webhook_deliveries.attempt_count` (:643), `workgraph_runtime_effects.attempt_count` (:1170), `workgraph_outbox.attempt_count` (:1244), `wakes.attempts` (:1398).
- claxedo-app non-domain hits (332): `lib/retry.ts`, `features/terminal/core/retry.ts`, `HARNESS_REPROBE_MAX_ATTEMPTS`, `session-config-sync-retry.ts`, etc.
- Generic `SessionTurnOutcome` (session-types.ts) — unrelated to workgraph Outcomes.
- `review-toolbar.tsx`/`review-tab.tsx:460` git "staged/unstaged" — unrelated to Staged tasks.
- `SessionAttachment.kind: "planner"` (`session-meta-types.ts:5`) — unrelated attachment kind; leave.
- "Worker-safe" comments (Cloudflare Workers), `claimed_by: "worker"` queue identities — leave.

## A2. Fencing becomes first-class: `generation`, required

Grounding: SQLite runs already carry `lease_epoch` on the row (`sqlite/schema.ts:261`); **Convex does not** (fence re-reads the lease each time); the identity schema's `leaseEpoch` is **optional** (`attempt-operation.ts:56-62`) — an optional fence is a hole.

- Add `generation: v.number()` to `workgraph_runs` (Convex), set at admission from the minted epoch (`workgraphCommands.ts:2352`); SQLite renames `lease_epoch` → `generation` on `wg_v2_runs`.
- `WorkGraphRunIdentitySchema`: `leaseEpoch?` → **`generation` (required)**. Update the mirror zod in workspace-runtime. Every verification site keeps its current logic (the enumerated list: `workgraphRuntime.ts:1593-1646` `fenced()`, `:397-404`, `:1430-1435`, `:1493`; `workgraphCommands.ts:1404-1409`; `store.ts:3182,751,765-780,5052,5077,5122,5197,905-911`) but compares against the run row's `generation` where it previously trusted an optional field. The `execution_kind==="managed"` guard on the fence (`workgraphCommands.ts:1404`, `store.ts:3181`) stays.

## A3. State rename + two new states (names only here; behavior in WS-C)

- `attention` → `parked` (+ field `attention_reason` → `parked_reason`; `markAttention` → `markParked` in both backends and the execution-service compensation calls). The `parked → running` edge already exists in `transitions.ts:57-65` — unchanged. Needs-you derivation keeps reading `parked` + reason exactly as it read `attention` (waiting-source.ts mapping updated).
- Add work-item state **`draft`** to `lifecycle.ts` + transitions: `draft → pending | pending_approval | abandoned` (arming; no inbound edges from other states). No writer yet — WS-C adds the create flag; adding the state here keeps the enum change in the single breaking pass.

## A4. New linkage columns (columns only; behavior in WS-C/D)

- `workgraph_work_items.parent_task_id: v.optional(v.string())` + index `by_tenant_parent` `[org, owner, parent_task_id]`; SQLite twin + index. (Subtasks, plan A2.)
- `workgraph_streams.parent_stream_id: v.optional(v.string())` + index `by_tenant_parent`; SQLite twin. (Child streams, plan A13.)

## A5. `agent_profile` contract type (types only; resolution in WS-D)

In `contracts/execution.ts`, alongside `ResolvedGenerationProfileSchema` (:63-66 — the existing `{harness, agent, model, effort, tools, connectionIds}` seam):

```ts
export const AgentProfileSchema = z.strictObject({
  name: z.string().min(1).max(64),
  brief: z.string().max(2000),            // capability brief the master reads
  generation: ResolvedGenerationProfileSchema, // harness/model/effort/tools/connections
  memoryRef: z.string().optional(),       // portable memory handle (MemoryBackend seam)
})
```

Plus `ExecutionProfileDefaultsSchema` gains optional `agents: AgentProfileSchema[]` and `assignments: { planning?: name, execution?: name, review?: name }` so profiles ride the existing `execution_defaults` merge (root→stream→outcome→item, `workgraphCommands.ts:2443-2460` / `domain/execution-profile.ts:41`) with **no new storage**.

## Build/verify protocol (dist hazard — mandatory order)
1. Edit `packages/workgraph` → `bun turbo build --filter=@claxedo/workgraph` (consumers resolve through `dist/`; no dev-condition bypass — audit §5).
2. `tsgo -b` per dependent (claxedo-server, claxedo-app, claxedo-mcp, workspace-runtime, root convex) to isolate real errors.
3. `bunx convex codegen` (root) after schema edits.
4. Full suites: `packages/workgraph` conformance (both adapters), claxedo-server workgraph-host tests (expect 210–280s, don't kill), app vitest.

## DoD
- Zero grep hits for the old domain identifiers outside the exclusion list: `rg -w 'attempt|Attempt' convex packages/workgraph packages/claxedo-server/src/workgraph-host packages/claxedo-mcp packages/claxedo-app/src/features/workgraph` returns only exclusion-list items (commit the audit command + allowlist as a test: `packages/workgraph/test/vocabulary.test.ts`).
- `generation` required end-to-end: a run-operation POST without `generation` is a 400 (new test); conformance green on both backends; all renamed suites green.
- No behavior diffs: `git diff` review confirms only identifier/schema-name changes + the two new states + columns; CI typecheck green from every dependent.
