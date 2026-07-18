# 2026-07-18-003 — WorkGraph approval gate + continuous execution (replaces supervised/autonomous)

Status: PLANNED (research + design complete; no implementation started)
Owner intent: replace the supervised/autonomous execution-mode concept with a durable human
approval gate (`Staged`) and continuous, pause/resume-gated execution. Everything the old model
made obsolete is deleted, not preserved.

Inherited operating principles (inlined because `docs/plans/goal.md` does not exist on `dev` —
it is cited by other plans but only survives in stale worktrees; fix or keep inlining):
one reactive data graph · UI + motion parity gate · strangler/additive rollout · TDD ·
make illegal states unrepresentable · per-slice vision-reviewed verification.

Execution strategy: this plan is sized for parallel agents. Phases 1 (SQLite), 3 (Convex/hosted),
4 (MCP), and 5 (UI) are independent once Phase 0 (contracts) lands; run them as parallel
worktree agents with Phase 2's conformance suite as the shared gate. Use a workflow with an
adversarial verify pass before merging each phase.

---

## 1. Executive summary

WorkGraph today has no approval concept: any actor — human or agent — that issues
`create_work_item` materializes a task at `lifecycle='pending'`, and execution is started by two
mode-carrying commands (`execute_stream`, `execute_work_item`) that stamp
`autonomous`/`supervised` onto streams and attempts. Autonomous streams self-continue through an
existing, already event-driven drain; supervised streams admit one batch per explicit command.

This plan:

1. Adds one persisted work-item lifecycle value, **`pending_approval`** (UI label **"Staged"**).
   Agent-created tasks are born `pending_approval`; human-created and human-confirmed tasks are
   born `pending` (= approved). Waiting vs Ready stay **derived, never stored** — exactly as
   readiness is computed today.
2. Adds three owner-only commands — `approve_work_item`, `reject_work_item`,
   `approve_work_items` (bulk) — all CAS-guarded by `expectedVersion`, closing the
   approve-vs-edit race that the mode commands left open (they are the only 2 of 29 commands
   without `expectedVersion`).
3. Re-gates the existing continuous-execution engine (SQLite drain + Convex
   `continueAutonomousStream`) from `execution_mode='autonomous' AND execution_state='active'`
   to `stream.lifecycle='active'`. **Stream pause/resume becomes the launch gate.** No new
   scheduler is built; the existing event-driven trigger points, leases, outbox claims, and
   reconciliation backstops are preserved unchanged.
4. Deletes the entire execution-mode surface: `ExecutionModeSchema`, both `execute_*` commands,
   the mode columns on streams/attempts (SQLite + Convex), the mode-replay in retry, the
   `workgraph_execute` MCP tool, the Supervised/Autonomous UI popover, both
   `*_execution_requested` events, and every test fixture that pins them.
5. Migrates existing data safely: existing `pending` tasks are grandfathered as approved;
   streams not actively running in autonomous mode (including never-executed streams whose
   `execution_state` is NULL — a real footgun, see §8) are set to `paused` so nothing
   auto-launches surprisingly on upgrade.

Direct mismatch callouts (requested; do not paper over):

- The requested "Staged" state does not exist anywhere; the UI's current `staged` bucket label
  ([work-item-rows.tsx:8-20](packages/claxedo-app/src/features/workgraph/work-item-rows.tsx)) is a
  UI-only alias for `pending`. The word `staged` is already a **different** live concept on
  intake candidates. This plan therefore names the persisted value `pending_approval` and keeps
  "Staged" as a display label only.
- Readiness is currently computed by **two divergent SQL copies** (the drain excludes
  decision-blocked items; `execute_stream` does not) — unified here.
- An `abandoned` dependency **deadlocks its dependents forever** under the current
  `<> 'completed'` rule; with `reject → abandoned` this would freeze all downstream work, so the
  rule changes to `IN ('completed','abandoned')` in every copy.
- `retry_work_item` currently *requires* a stored execution mode and rejects without one
  ([workgraphCommands.ts:227](convex/workgraphCommands.ts)); that replay path is deleted.
- No supervised/autonomous semantic bridge is built. The only rollout accommodation is a
  one-release typed rejection stub on the hosted command validator (§8.3), removed in the
  contract release.

---

## 2. Grounded current state (verified file:line evidence)

### 2.1 Domain and contracts (`packages/workgraph/src`)

- `WorkItemStateSchema` = `pending | active | result_ready | review_needed |
  integration_needed | blocked | verification_failed | completed | failed | abandoned`
  ([contracts/lifecycle.ts:12-24](packages/workgraph/src/contracts/lifecycle.ts)). No
  staged/waiting/ready values. `StreamLifecycleStateSchema` = `active|paused|closed|reopened`
  (line 3). `AttemptStateSchema` = `admitted|placing|running|result|attention|failed|cancelled`
  (line 26).
- Transition tables exist for all entities
  ([domain/transitions.ts:24-105](packages/workgraph/src/domain/transitions.ts)), but
  `transitionWorkItem`/`transitionAttempt` have **zero call sites** — the SQLite adapter mutates
  lifecycle via raw `UPDATE` SQL. Any new gate must be enforced in the reducers, not assumed to
  flow through `transitions.ts`.
- `ExecutionModeSchema = z.enum(["autonomous","supervised"])` and the two mode-carrying commands
  live at [contracts/commands.ts:243-260](packages/workgraph/src/contracts/commands.ts). They are
  the only 2 of 29 commands with **no `expectedVersion`**. `executionMode` never appears on any
  record DTO in `contracts/records.ts` — it is projected into non-contract DB columns only.
- Command catalog relevant here: `create_work_item`/`update_work_item` (commands.ts:113-141,
  update CAS at [store.ts:1596-1597](packages/workgraph/src/adapters/sqlite/store.ts)),
  `set_stream_lifecycle` (224-232, **kept — becomes the launch gate**), `cancel_attempt`
  (262-269), `retry_work_item` (271-277, has `expectedVersion`, no mode field).
- Events ([contracts/events.ts:22-67](packages/workgraph/src/contracts/events.ts)):
  `stream_execution_requested` (36) and `work_item_execution_requested` (51) exist only to serve
  the deleted commands. No approval events exist.
- Attention ([contracts/attention.ts](packages/workgraph/src/contracts/attention.ts)):
  `WorkItemAttentionItemSchema` (67-86) allow-lists
  `{result_ready, blocked, review_needed, integration_needed, verification_failed, failed}` —
  `pending_approval` must be added so staged tasks can surface in Needs-you.
  `recordIdentity()` (272-288) requires exact `{ownerUserId,id,updatedAt}` — the prior
  attention-500 root cause; reuse, don't re-invent.
- Dead code to delete: `domain/decision-readiness.ts` (`evaluateDecisionReadiness`, zero call
  sites) and `IntakeStateSchema` ([contracts/lifecycle.ts:32](packages/workgraph/src/contracts/lifecycle.ts),
  zero consumers — a vestigial third meaning of `staged`).

### 2.2 SQLite adapter (`packages/workgraph/src/adapters/sqlite`)

- Columns: `wg_v2_streams.execution_mode/execution_state`
  ([schema.ts:150-151](packages/workgraph/src/adapters/sqlite/schema.ts), CHECK-constrained),
  `wg_v2_attempts.execution_mode` (schema.ts:246). `wg_v2_work_items.lifecycle` has **no CHECK
  constraint** (schema.ts:194-219) — adding `pending_approval` is app-enforcement only, zero DDL.
- `create_work_item` inserts `lifecycle='pending'` unconditionally
  ([store.ts:1560-1562](packages/workgraph/src/adapters/sqlite/store.ts)); `confirm_admission`
  materializes at `'pending'` (insert loop store.ts:2374-2417). These are the **only two**
  `INSERT INTO wg_v2_work_items` sites.
- Continuous execution: `executeWithAutonomousContinuation` wraps ~20 of 29 handlers
  (command map store.ts:630-654) → `drainAutonomousExecutions` (store.ts:334-348) →
  `drainSqliteAutonomousStreams` (store.ts:932-987), gated
  `WHERE execution_mode='autonomous' AND execution_state='active'` (store.ts:944), plus a boot
  `queueMicrotask` drain (store.ts:663-668). **Event-driven already; only the gate changes.**
- Readiness SQL exists in two divergent copies: drain version store.ts:1055-1077 (deps
  `<> 'completed'` + decision guard) and `execute_stream` version store.ts:2603-2619 (deps only,
  **no** decision guard).
- `execute_stream` handler: store.ts:2596-2652 (pause/closed guards at 2599-2602; mode write at
  2633-2644). `execute_work_item`: mode write 2515-2529. `retry_work_item` replays the prior
  attempt's `execution_mode` (store.ts:2547-2568). `cancel_attempt` sets the work item
  `lifecycle='failed'` (store.ts:2689-2696) — **cancel lands in Needs-you and requires explicit
  retry; this behavior is kept** (returning to `pending` would let the drain instantly relaunch).
- Double-launch fence: `admitAttempt` (store.ts:4885-5071) atomic lease upsert on
  `UNIQUE(resource_type,resource_id)` with epoch fencing (schema.ts:328, store.ts:5043-5064).
  `admitAttempt` performs **no work-item `row_version` CAS** — the gap the new approve command
  closes. Attention auto-stop is mode-gated (store.ts:4829-4836) and must become derived (§5.3).
- Supported-command allow-lists `SQLITE_WORKGRAPH_(UN)SUPPORTED_COMMANDS` (store.ts:151-186) and
  the dispatch map (store.ts:629-661) must be edited for the new/removed commands.
- Archive: owner-wide export gated on `assertQuiescent` (archive.ts:1408-1423) and the
  schema-closed `assertCanonicalCoverage` (archive.ts:1425-1457).

### 2.3 Convex + hosted runtime

- `workgraph_work_items.state` is a free `v.string()` ([convex/schema.ts:528](convex/schema.ts))
  — `pending_approval` needs no schema change (but reducers must validate it; nothing else
  does). Mode fields: `workgraph_streams.execution_mode/execution_state` (schema.ts:465-466),
  `workgraph_attempts.execution_mode` (schema.ts:571).
- Command handling: `execute_work_item`/retry at
  [workgraphCommands.ts:218-243](convex/workgraphCommands.ts) (retry **rejects** without stored
  mode, line 227), `execute_stream` at 244-280, `admitAttempt` chokepoint at 1859-2005 (readiness
  re-derived inline at 1877-1888), `continueAutonomousStream` at 2047-2120 (mode gate line 2049;
  stops the stream on any proposed/pending decision or attention/failed attempt, 2067-2071;
  admits every `pending` item at 2092), `reconcileAutonomousStreams` at 2033-2045.
- Continuation triggers: synchronously in-transaction after `complete_attempt`/`record_evidence`
  (workgraphCommands.ts:1204-1206, 1305-1307) and unconditionally inside `claimLaunches`
  ([workgraphRuntime.ts:63-72](convex/workgraphRuntime.ts)). `convex/crons.ts` has zero
  WorkGraph jobs.
- Outbox claim fence: `claimLaunches` re-validates lease holder/epoch/attempt-state, 60s
  `claim_expires_at` (workgraphRuntime.ts:120-193). `recordFailure`/`markAttention` force
  `execution_state:'stopped'` **guarded by `execution_mode==='autonomous'`**
  (workgraphRuntime.ts:1204, 1262) — silently dead once the column goes; must be reworked (§5.3).
- **Third admission path:** `attachSessionTask`
  ([workgraphActivity.ts:363-457](convex/workgraphActivity.ts)) inserts an attempt with
  hardcoded `execution_mode:"supervised"` (line 438), gates on `state !== 'pending'`, and
  bypasses lease+outbox entirely. Must drop the field; its `pending`-only gate correctly rejects
  attaching to a `pending_approval` task.
- Hosted: `SettlementDispatcher.nudge(tenant)`
  ([settlement-dispatcher.ts:12-19](packages/claxedo-server/src/workgraph-host/settlement-dispatcher.ts));
  primary nudge after successful commands at
  [hosted.ts:206-219](packages/claxedo-server/src/workgraph-host/hosted.ts). **Gap:** the
  agent-tool completion path
  ([hosted-attempt-operation.ts:27-97](packages/claxedo-server/src/workgraph-host/hosted-attempt-operation.ts),
  wired in hosted-app.ts:246-262) calls `executeForService` directly and never nudges — dependent
  launches ride the ~2-minute CF cron backstop (`worker.ts:278-291`, `listStaleTenants`
  workgraphRuntime.ts:23-60). This plan wires the nudge (§5.2) so continuous execution is
  sub-second, with the cron as the durability floor. `reconcile-serialize.ts:12-25`
  (skip-overlapping) unchanged.
- Migration discipline: expand-migrate-contract via `@convex-dev/migrations` is law
  ([convex/migrations.ts:1-21](convex/migrations.ts)).

### 2.4 Local server

- Composition: `createLocalEmbeddedWorkGraph`
  ([server-workgraph.ts:67](packages/claxedo-server/src/server-workgraph.ts)), mounted at
  `/api/workgraph` (server.ts:1145). Launch callback = `WorkGraphSessionGateway.admit` via
  [local-execution.ts:145-165](packages/claxedo-server/src/workgraph-host/local-execution.ts)
  (mode-unaware). Local reconciler = 1s unref'd `setInterval` (server.ts:1101-1143).
- HTTP surface ([http/router.ts:82+](packages/workgraph/src/http/router.ts)): all approvals flow
  as new command types through the existing owner-gated `POST /commands` (router.ts:104-115).
  **No route changes.** `/changes` is already removed and stays gone.
- Restart invariants pinned by
  [workgraph-process-restart.integration.test.ts](packages/claxedo-server/src/workgraph-process-restart.integration.test.ts):
  operationId idempotency survives SIGKILL; reconcile never auto-settles
  (`awaitingExplicitCompletion: true`) — explicit `complete_attempt` required. Unchanged by this
  plan.

### 2.5 Task origins (approval-relevant)

Verified in A7 (grounding): the only materialization paths are `create_work_item` and
`confirm_admission`. Manual add, MCP `workgraph_create_task`, and agent
`workgraph_create_followup` all compile to the **identical** `create_work_item` command
([workgraph-tools.ts:825-850](packages/claxedo-mcp/src/workgraph-tools.ts)); the only
discriminant is the command `actor`, and `workgraph-agent-tools.ts:96-102` hardcodes
`actor:{type:"agent"}, access:{mode:"owner"}` for every agent tool call. The propose→confirm
admission flow: `propose_admission` (store.ts:1906-1975) → background agent-session planning
(source-planning-runtime.ts:35-98) → `confirm_admission` (store.ts:2109-2444). Keep/Replace/Fork
is `selection.mode` on the same command; only `replace` has special server behavior
(cancels/abandons superseded items, store.ts:2246-2344). Intake candidates
(`unorganized|staged|confirmed|dismissed`, [source-view.ts:70](packages/workgraph/src/contracts/source-view.ts),
convex/schema.ts:423) are a **different table and meaning** of `staged` — pre-Stream discovery
state, not task approval.

### 2.6 App UI

- API client: `executeStream`/`executeWorkItem` are the only mode carriers
  ([api.ts:365-376](packages/claxedo-app/src/features/workgraph/api.ts));
  `setStreamLifecycle` exists (api.ts:331-335) but has **zero call sites** — no user can pause a
  stream today; the paused state is only reachable in test fixtures.
- Execute popover (Supervised/Autonomous) in `StreamCard`
  ([workgraph-overview.tsx:280-323](packages/claxedo-app/src/features/workgraph/workgraph-overview.tsx));
  eligibility mirror at 232-238; pinned by workgraph-overview.vitest.tsx:419-518.
- Second launch path: `TaskDialog` "Run task" hardcodes `executeWorkItem(id,"autonomous")`
  ([waiting/item-dialogs.tsx:56](packages/claxedo-app/src/features/workgraph/waiting/item-dialogs.tsx));
  its `executable` check ignores dependencies (line 41).
- `taskStatusBucket` maps state → `attention|in_progress|staged|done` with `staged` as the
  fallback (= `pending`) ([work-item-rows.tsx:8-20](packages/claxedo-app/src/features/workgraph/work-item-rows.tsx)).
- Live updates: doorbell → `reloadCanonical` full snapshot+attention refetch
  (workgraph-content.tsx:223-225). New states propagate with no transport work.

---

## 3. Domain model and state-transition table

### 3.1 Representation decision

**One new persisted `WorkItemState` value: `pending_approval`.** Waiting/Ready remain derived;
no approval column; rejection = transition to the existing terminal `abandoned`.

Why this over a separate `approval` field: (a) the user-facing model *is* a state machine and
the repo already persists exactly one lifecycle string per work item with no CHECK constraint on
either backend — a new value is zero DDL and zero backfill, while a NOT-NULL column requires a
populated-table backfill plus an archive canonical-schema extension; (b) approval durability
across retries holds by construction: `failed → pending` (the retry edge,
transitions.ts:57) never passes through `pending_approval`, so an approved task can never be
silently un-approved by the execution cycle; (c) the migration story collapses to
"grandfather every existing `pending` row as approved" — nothing to write.

Why the value is named `pending_approval` and not `staged`: `staged` already has two live
meanings (intake-candidate status on both backends, plus the UI bucket label) and one dead one
(`IntakeStateSchema`). Raw-SQL fixtures and reducers in the *same files* already contain
`status='staged'` literals for candidates; a work-item `lifecycle='staged'` literal one table
over would make every grep and every future maintainer's read ambiguous. `pending_approval`
greps uniquely, reads correctly next to `pending` ("awaiting approval" vs "approved, awaiting
execution"), and the UI still renders **"Staged"** — display label and code term are decoupled.

### 3.2 State-transition table (delta on `workItemTransitions`, transitions.ts:40-59)

| From | To | Trigger | Actor gate | Notes |
|---|---|---|---|---|
| *(insert)* | `pending` | `create_work_item` with `actor.type='user'`; `confirm_admission` materialization | human | born approved |
| *(insert)* | `pending_approval` | `create_work_item` with `actor.type='agent'` (or `'system'`) | agent | born staged |
| `pending_approval` | `pending` | `approve_work_item` / `approve_work_items` | **user + owner only**, CAS `expectedVersion` | emits `work_item_approved` + `work_item_state_changed` |
| `pending_approval` | `abandoned` | `reject_work_item` (reason required) | **user + owner only**, CAS | emits `work_item_rejected`; terminal |
| `pending` | `pending_approval` | agent `update_work_item` changing any material field of a not-yet-launched item | agent | **demotion**; emits `work_item_restaged` |
| `pending` | `active` | automatic admission by the drain (readiness predicate §5.1) | system | unchanged edge, new gate |
| `failed` | `pending` | `retry_work_item` | user | approval preserved (never re-staged) |
| all other edges | | | | unchanged from transitions.ts:40-59 |

`cancel_attempt` semantics are **unchanged**: attempt → `cancelled`, work item → `failed`
(store.ts:2689-2696) → Needs-you → explicit `retry_work_item`. Cancel must not return the item
to `pending`: under continuous execution the drain would immediately re-admit it, defeating
cancel. (This was a defect in one draft design; verified against source and corrected here.)

Update `transitions.ts` to document these edges even though work-item enforcement lives in the
reducers (transitions.ts is dead code for work items today; enforcement sites are the reducers —
do not assume the table is on the hot path).

Display-state derivation (never stored):

| Display | Derivation |
|---|---|
| **Staged** | `state === 'pending_approval'` |
| **Waiting** | `state === 'pending'` ∧ some blocker's lifecycle ∉ {`completed`,`abandoned`}, or a blocking decision is `proposed`/`pending` |
| **Ready** | `state === 'pending'` ∧ launchable-now per §5.1 (stream gate excluded — a paused stream shows "Ready · paused") |
| **Running** | `state === 'active'` |
| **Needs-you** | `state ∈ {result_ready, review_needed, integration_needed, blocked, verification_failed, failed}` ∨ attempt `attention` ∨ blocking decision ∨ `configuration_required` attention |
| **Done** | `state === 'completed'` |

---

## 4. Approval and authority rules by task origin

Governing rule: **the `actor.type` of the materializing command decides the initial state.**
Origin is additionally recorded (new columns, §8.1) for audit/UI.

| # | Origin | Code path | Initial state | Rationale |
|---|---|---|---|---|
| a | Manual Add task | `create_work_item`, actor `user` (app command bus) | `pending` | manual = human-approved |
| b | Confirm AI admission proposal | `confirm_admission` materialize (store.ts:2374-2417) | `pending` | the confirm **payload is authored/submitted by the human** — they approved exactly what they sent (see note below) |
| c | Source-revision replanning confirm (Keep/Replace/Fork) | same `confirm_admission`, `selection.mode` | `pending` | still a human confirm; `replace` abandons superseded items first |
| d | Agent follow-up during an attempt | `workgraph_create_followup` → `create_work_item`, actor `agent` | `pending_approval` | agent-created, no human review |
| e | MCP-created under an active attempt | `workgraph_create_task`/`create_work` → same command, actor `agent` | `pending_approval` | same |
| f | External/webhook/session-idle candidate admission | candidate → `stage()` → `propose_admission` → `confirm_admission` | `pending` | tasks only exist after the human confirm; candidate `staged` status is unrelated |

Note on (b) "exact confirmed proposal": the server never diffs the confirm payload against the
AI-proposed plan and overwrites `proposed_work_json` at confirm time (store.ts:2426). That does
**not** weaken approval validity — the human authored the confirm payload (the app echoes the
proposal verbatim, item-dialog-proposal.tsx:270-313, and any human edit before confirm is still
human-seen content), and `confirm_admission` carries `expectedVersion` against the proposal row.
Server-enforced proposal fidelity is explicitly a **non-goal** here (§14).

Authority boundary (Q9):

1. **Agents can never approve, reject, or launch.** `approve_work_item`/`reject_work_item`
   reducers reject unless `actor.type === 'user'` and `access.mode === 'owner'`
   (`not_authorized`). There is **no MCP approve/reject tool** — every agent tool call carries
   hardcoded owner access (workgraph-agent-tools.ts:96-102), so a shared tool would let an agent
   self-approve and structurally defeat the gate. Approval exists only in the app UI via
   `POST /commands`. The `execute_*` escape hatch is deleted.
2. **Agent material edits demote.** In the `update_work_item` reducer, after the existing CAS:
   if `actor.type === 'agent'` ∧ target `state === 'pending'` → set `state='pending_approval'`,
   emit `work_item_restaged`. Material fields = every field `update_work_item` can change
   (commands.ts:128-141). This is the only backstop against owner-authorized agents mutating an
   approved plan; it is required, not optional.
3. **Human edits re-affirm.** `actor.type === 'user'` edits never demote; the `row_version` bump
   CAS-invalidates any concurrently in-flight stale approval.
4. **Edits to running/terminal items never touch approval.** Demotion applies only at
   `state === 'pending'`; a mid-run agent edit does not stop the attempt and does not re-stage.
5. Q8 (approved task gains a dependency): human edit → stays `pending`, derivation flips
   Ready → Waiting automatically; auto-promotes and launches when the blocker completes. Agent
   edit → demotes per rule 2 (UI shows the Staged affordances again). Required hardening:
   `update_work_item` must run the same acyclicity check `confirm_admission` runs
   (store.ts:2189-2212) — today dependency edits validate existence only (store.ts:1545-1555),
   so an edit can create a silent Waiting-forever cycle.

---

## 5. Readiness invariants and scheduler triggering

### 5.1 Authoritative launchability predicate

One domain function, `evaluateWorkItemLaunchability`, in new
`packages/workgraph/src/domain/launch-readiness.ts` (replacing dead `decision-readiness.ts`),
serving as spec/oracle; the SQLite adapter ships **one shared SQL fragment** used by every
consumer (fixing the drain-vs-execute divergence). Item launchable iff ALL:

1. `state === 'pending'` (implies approved; `pending_approval` is excluded by construction).
2. Stream `lifecycle === 'active'` (pause gate). `reopened` streams are not scanned; the only
   legal edge is `reopened → active` (transitions.ts:26), so work is held until the owner
   resumes — document, don't special-case.
3. Stream visibility ≠ `archived`.
4. Every blocker's `lifecycle IN ('completed','abandoned')` — **change** from `<> 'completed'`
   in all three copies (store.ts:1065, store.ts:2614's successor, workgraphCommands.ts:1877-1888
   + workgraphActivity.ts:393-397), else `reject → abandoned` deadlocks dependents forever.
5. No blocking decision `proposed`/`pending` (present in drain, absent in `execute_stream` today
   — unify on present).
6. No live attempt (`admitted|placing|running`) for the item (belt-and-suspenders with the lease).
7. Resolved execution profile passes `validateResolvedExecutionProfileAgainstCapabilities`
   (execution-capability-policy.ts:56, called pre-admission store.ts:5005). **Change:** today
   invalidity rejects the `execute_*` command; with no command to reject, invalidity makes the
   item non-launchable AND emits a `configuration_required` attention so it lands in Needs-you
   instead of silently never running.
8. Stream hold (preserved current behavior, now **derived per pass instead of persisted**): a
   stream with any attempt in `attention` or any work item in `failed` admits no new items until
   the owner resolves/retries. This replaces the mode-gated `execution_state='stopped'` writes
   (store.ts:1044-1051, 4829-4836; workgraphRuntime.ts:1204, 1262 — the guard would otherwise go
   permanently false when the column drops, silently killing the halt). Deliberate nuance to
   requirement 5 ("every ready task launches"): a needs-you condition auto-holds the stream,
   exactly as autonomous mode halts today; the stream card explains the hold (§6).

Return shape: `{launchable:true} | {launchable:false, reason: "not_approved" |
"stream_not_active" | "deps_incomplete" | "blocking_decision" | "attempt_in_flight" |
"replacement_barrier" | "capability_invalid" | "stream_held" | "not_pending"}` — consumed by the
drain (launch), snapshot projector (Waiting/Ready display), and attention projector (Needs-you
reasons).

### 5.2 Scheduler triggering (event-driven; no new engine)

The engine exists and already fires after every mutation. Renames:
`drainAutonomousExecutions` → `drainReadyStreams`, `drainSqliteAutonomousStreams` →
`drainSqliteReadyStreams`, `continueSqliteAutonomousStream` → `continueSqliteStream`,
`continueAutonomousStream` → `continueStream`, `reconcileAutonomousStreams` →
`reconcileReadyStreams`. (Do NOT rename `executeWithAutonomousContinuation`'s due-jobs cousin at
store.ts:641 blindly — that "autonomous" means async job continuation, unrelated.)

| # | Readiness-changing mutation | SQLite trigger | Convex/hosted trigger |
|---|---|---|---|
| 1 | `approve_work_item(s)` (new) | add to `executeWithAutonomousContinuation` wrap list → drain | `applyWorkGraphCommand` → `hosted.ts:206` nudge + in-txn `continueStream` |
| 2 | `reject_work_item` (new) | same (no-op launch-wise; recompute attention) | same |
| 3 | Dependency completion (`complete_attempt`/`record_evidence`) | already wrapped | already in-txn (workgraphCommands.ts:1204-1206, 1305-1307) |
| 4 | Dependency/task edit (`update_work_item`) | wrapped | nudge |
| 5 | Decision answered/dismissed | wrapped | nudge (re-arms the §5.1.8 hold) |
| 6 | Attempt settled/failed/cancelled | wrapped | nudge + **NEW: wire the agent-tool completion path** (hosted-app.ts:246-262 / hosted-attempt-operation.ts) to call `SettlementDispatcher.nudge(tenant)` — mandatory, not optional, else dependent launches lag ~2 min behind the CF cron |
| 7 | `retry_work_item` | wrapped | nudge |
| 8 | Stream resume (`set_stream_lifecycle → active`) | wrapped (already in map, store.ts:634) | nudge — **this is the launch gate** |
| 9 | Capability refresh (`POST /execution-capabilities/refresh`) | **NEW: route handler calls `drainReadyStreams()`** (not a command; no pass fires today) | **NEW: nudge after refresh** |
| 10 | Creation/deletion/replacement (`create_work_item`, `confirm_admission`, `delete_stream`) | wrapped | nudge |

Restart recovery unchanged: readiness is re-derived from durable rows on every pass — SQLite
boot microtask (store.ts:663-668) + 1s local reconciler (server.ts:1101-1143); Convex outbox +
`claimLaunches` re-validation + CF cron `listStaleTenants` (~2 min floor). A crash between
approve and launch re-derives "approved + ready" at boot; operationId idempotency prevents
double-approve; lease/outbox fencing prevents double-launch.

### 5.3 Double-launch and halt invariants

Unchanged fences: per-item lease upsert with epoch (store.ts:5043-5064), hosted outbox claim
re-validation with 60s expiry (workgraphRuntime.ts:120-193), operationId dedupe
(store.ts:353-360), `skipOverlappingReconcile` (reconcile-serialize.ts:12-25). The single
`approve_work_item` reducer must treat CAS `UPDATE ... WHERE row_version=?` affecting 0 rows as
`version_conflict`/`not_found` — never silent success (approve-vs-delete race).

---

## 6. UX behavior

Respect the flat-UI constraints (static project headers, quiet fixed-size cards, info on hover,
Needs-you card final model — do not relitigate).

- **Stream card** (`StreamCard`, workgraph-overview.tsx:154-481): delete the Execute popover
  (280-323) and `runExecution`. Card face: one muted pill **"N need you"** where
  `N = staged + needsYou` (both are owner-blocking), muted `done/total` fraction, and a muted
  **"Paused"** marker when `lifecycle==='paused'` (now load-bearing) or **"Held"** when §5.1.8
  applies (tooltip names the failed/attention item). Hover: full breakdown
  `1 staged · 2 ready · 3 waiting · 1 running · 1 needs you · 4 done`, zero segments omitted,
  attention-first order.
- **Pause/Resume** (net-new UI; `setStreamLifecycle` has zero call sites today): quiet toggle on
  the card header/More menu; carries `expectedVersion`. Copy: "Stop launching new tasks. Running
  tasks continue."
- **Task rows** (`WorkItemLeaf`, work-item-rows.tsx:100-228): `taskStatusBucket` becomes a
  six-label `taskStatusLabel(item, depsComplete)`; glyphs: Staged `circle-dashed`, Waiting
  `circle-dotted`, Ready `circle`, Running `circle-half`, Needs-you `circle-alert`, Done
  `circle-check` (readable without color). Staged rows get inline **Approve**/**Reject**;
  Waiting keeps the `waits for N` chip; Ready shows "Queued" (or "Ready · paused"); Running
  keeps Session; Needs-you keeps Retry (`isRetryable`, 230-239); Done unchanged.
- **Task inspector** (`TaskDialog`, item-dialogs.tsx:23-69): delete "Run task" + its hardcoded
  autonomous call. `pending_approval` → Approve primary, Reject secondary (reason required);
  `pending` → read-only "Ready, will run automatically" / "Waiting on N dependencies" (list
  them); Running/Needs-you/Done unchanged. Same six-label badge as rows.
- **Staged review + Needs-you**: add `pending_approval` to the `WorkItemAttentionItemSchema`
  allow-list so staged tasks surface as attention items ("3 tasks awaiting approval") with
  inline Approve/Reject — reuse the existing `work_item` kind and `recordIdentity` plumbing;
  no new attention kind. Visually distinct from result-review (dashed glyph, verb "Approve to
  run" vs "Confirm complete").
- **Bulk approval — recommendation: YES, per-stream, in the staged group header**: one
  "Approve all staged (N)" button scoped to a stream (the natural successor of the deleted
  per-stream Execute affordance). Individual approve/reject remains primary. **No bulk reject**
  (reasons are per-task; destructive). Version-conflict safety in §7.
- **Approval while paused** (Q7): Approve stays enabled; task becomes `pending` but does not
  launch (drain skips paused streams); row shows "Ready · paused"; confirmation copy "Approved.
  Will run when you resume the stream." Never auto-resume on approve.
- **Approved task edited / gains dependency** (Q8): human edit → row flips Ready↔Waiting on the
  doorbell reload, no prompt; agent edit → row returns to Staged with a "changed by agent —
  re-approve" chip.
- **Failures/retry**: unchanged mechanics (`retryWorkItem(id, version)`, `cancelAttempt`);
  Needs-you labeling per §3.2.

---

## 7. Exact contract/API changes

### 7.1 New commands (`contracts/commands.ts`, matching existing `version`/`expectedVersion`/`strictObject` conventions)

```ts
export const ApproveWorkItemCommandSchema = z.strictObject({
  version, type: z.literal("approve_work_item"),
  workItemId: WorkItemIDSchema,
  expectedVersion,            // CAS against wg_v2_work_items.row_version — mandatory
})
export const RejectWorkItemCommandSchema = z.strictObject({
  version, type: z.literal("reject_work_item"),
  workItemId: WorkItemIDSchema,
  expectedVersion,
  reason: text,               // required
})
export const ApproveWorkItemsCommandSchema = z.strictObject({
  version, type: z.literal("approve_work_items"),
  approvals: z.array(z.strictObject({
    workItemId: WorkItemIDSchema,
    expectedVersion,
  })).min(1).max(200),
})
```

Bulk semantics: per-entry transactional CAS `pending_approval → pending` iff
`row_version === expectedVersion` ∧ `state === 'pending_approval'`; result is
`{ ok: true, results: Array<{workItemId, outcome: "approved"|"version_conflict"|"not_staged"|"not_found", version?}> }`
— partial success by design; one stale task never blocks the rest; a `version_conflict` entry is
**not approved** and the UI surfaces "M approved · K changed since you looked — re-review". The
client sends the exact `row_version`s it rendered (from the `records()` memo). A server-side
"approve everything currently staged" sweep is forbidden — it would approve unseen edits.
Command names use the `*_work_item` family (matches `update/cancel/retry_work_item`).

### 7.2 Deleted (full cleanup; nothing preserved)

- `ExecutionModeSchema`, `ExecuteStreamCommandSchema`, `ExecuteWorkItemCommandSchema`
  (commands.ts:243-260) + their union entries (commands.ts:422-455).
- Events `stream_execution_requested`, `work_item_execution_requested` (events.ts:36, 51).
- Mode replay in retry (store.ts:2547-2568; workgraphCommands.ts:218-243 branch).
- Columns per §8. MCP tool `workgraph_execute` (workgraph-tools.ts:221, mapping 902-910).
- `api.ts` `executeStream`/`executeWorkItem` + `ExecutionMode` import (api.ts:365-376).
- UI popover + `TaskDialog` run path (§6).
- Dead code: `domain/decision-readiness.ts`, `IntakeStateSchema` (lifecycle.ts:32).
- Allow-lists updated (add approve/reject, drop execute): `SQLITE_WORKGRAPH_(UN)SUPPORTED_COMMANDS`
  (store.ts:151-186), dispatch map (store.ts:629-661), Convex `supported` set
  (workgraphCommands.ts:17-49), `CONVEX_WORKGRAPH_SUPPORTED_COMMANDS`
  (convex-store.ts:79-111).

### 7.3 New events + kept commands

New: `work_item_approved`, `work_item_rejected`, `work_item_restaged` in `WorkGraphEventSchema`
(events.ts:22-67); all three also emit `work_item_state_changed` and append change-log rows
(remember the "attention writes never appended change rows" bug class from plan 2026-07-17-004 —
every new transition must ring the doorbell). Kept unchanged: `set_stream_lifecycle` (launch
gate), `cancel_attempt`, `retry_work_item` (stripped of mode replay; keeps `expectedVersion` —
already present), `create_work_item`/`update_work_item` (reducer behavior changes only).

### 7.4 HTTP, app client, MCP

- **HTTP: zero route changes.** New command types ride `POST /commands` (owner-gated).
- App client adds `approveWorkItem(id, expectedVersion)`,
  `rejectWorkItem(id, expectedVersion, reason)`, `approveWorkItems(approvals[])`; wires
  `setStreamLifecycle` to real UI.
- MCP: delete `workgraph_execute`; **no approve/reject tools** (§4); `workgraph_update_execution`
  (profile defaults) is kept — do not conflate. Create-tool schemas unchanged (no client-supplied
  approval field — agents must not request "pre-approved"); their descriptions gain "Tasks you
  create enter Staged and do not run until the owner approves them"; create-tool results include
  the returned DTO's `state:"pending_approval"` plus an explicit
  `approval:{required:true, note:"Awaiting owner approval before this task can run."}` hint so
  agents reliably relay the gate.
- DTO: `WorkItemDto.state` gains the value (shared `WorkItemStateSchema` propagates to snapshot,
  archive, attention embeds). New origin fields (§8.1) added to `WorkItemDto` as optional.

---

## 8. Persistence and rollout

### 8.1 SQLite (desktop/local — atomic single-build upgrade)

Idempotent guarded schema-init steps (check `PRAGMA table_info` before each), ordered inside the
same build that re-gates the drain, running before the server serves:

1. **Behavioral reconciliation (must run first):**
   `UPDATE wg_v2_streams SET lifecycle='paused' WHERE lifecycle='active' AND
   (execution_state IS NULL OR execution_state <> 'active')`.
   The `IS NULL` arm is load-bearing: `create_stream` never writes `execution_state`
   (store.ts:1229; column nullable, schema.ts:151), so **every never-executed stream is NULL** —
   a plain `<> 'active'` predicate skips them in SQL and their grandfathered-approved `pending`
   tasks would auto-launch on the first re-gated drain. Streams already `paused/closed/reopened`
   untouched. Only `execution_state='active'` (live autonomous) streams stay `active` and
   continue running seamlessly.
2. New columns: `wg_v2_work_items.created_by_actor_type TEXT` / `created_by_actor_id TEXT` /
   `origin_attempt_id TEXT` (nullable, no backfill — existing rows read as legacy/unknown).
3. **Column drops** (after 1, same init): drop `wg_v2_streams.execution_mode`,
   `wg_v2_streams.execution_state`, `wg_v2_attempts.execution_mode` via guarded `DROP COLUMN`.
4. No work-item state migration: existing `pending` rows are grandfathered as approved.
5. Archive: accept-and-ignore `execution_mode`/`execution_state` on import (tolerant read);
   omit on export; `pending_approval` flows through the shared `WorkItemStateSchema` into the
   archive value schema; `assertCanonicalCoverage` (archive.ts:1425-1457) reviewed so legacy
   archives restore and new exports round-trip. In-flight attempts untouched (lease recovery
   handles them).

### 8.2 Convex (expand-migrate-contract, via `@convex-dev/migrations` only)

- **EXPAND deploy:** accept `approve_work_item`/`reject_work_item`/`approve_work_items`; make
  the three mode fields `v.optional`; reducers start writing `pending_approval` for agent-origin
  creates and re-gate `continueStream`/`reconcileReadyStreams` on `lifecycle`; make the
  failure/attention stream-hold derived (replacing the mode-gated `execution_state:'stopped'`
  writes at workgraphRuntime.ts:1204/1262); `attachSessionTask` stops writing `execution_mode`
  (workgraphActivity.ts:438; its `state==='pending'` gate already rejects staged tasks — pin
  with a test). The two `execute_*` validators are replaced by a **typed rejection stub**:
  `validation_error` with message "Execution modes were removed — approve tasks and resume the
  stream instead" (friendly failure for stale tabs; NOT a semantic shim; no mode behavior
  preserved).
- **MIGRATE:** one `migrations.define` over `workgraph_streams`
  (`reconcileStreamLifecycleFromExecutionState`): if `lifecycle === 'active'` and
  `execution_state !== 'active'` (JS — `undefined` correctly matches, keeping both backends
  aligned) → patch `lifecycle:'paused'`. Run via
  `npx convex run migrations:run '{"fn":"migrations:<name>"}'`. No work-item migration. Since
  readiness is derived, previously-deadlocked graphs (abandoned blockers) self-heal on the next
  reconcile pass (CF cron ≤ ~2 min) — no dedicated nudge migration.
- **CONTRACT deploy (next release):** drop the three optional fields from `convex/schema.ts`;
  delete the typed rejection stubs. This is the bounded removal step for the only rollout
  bridge.
- Regenerate `convex/_generated/api.d.ts` via `bunx convex dev --once` (command args are
  `v.any()`, so changes are routine regeneration, not signature breaks).

### 8.3 Deployment sequence

1. Land contracts + SQLite + tests (desktop/local is atomic — vendored in-process, no version
   boundary).
2. Convex EXPAND + MIGRATE deploy.
3. Web SPA deploy (new UI; client stops sending `execute_*`). Stale-tab window: old tabs get the
   typed rejection with actionable copy; acceptable pre-launch. **No supervised/autonomous
   semantic bridge exists at any point** — repository evidence (grandfathered `pending`,
   dropped columns, atomic desktop) shows none is required.
4. Convex CONTRACT deploy: drop columns, delete stubs.
5. Per local-first deploy rules: before any hosted deploy, replay the CI commands in a fresh
   worktree and boot the composed hosted router locally (Miniflare/`wrangler dev` for the CF
   worker path); verify the migration against a copy of staging data.

---

## 9. File-by-file implementation inventory

### Contracts/domain (`packages/workgraph/src`)
- `contracts/lifecycle.ts` — add `pending_approval` to `WorkItemStateSchema`; **delete
  `IntakeStateSchema`** (dead).
- `contracts/commands.ts` — add 3 approve/reject schemas + union entries; delete
  `ExecutionModeSchema` + both `execute_*` schemas + union entries.
- `contracts/events.ts` — add `work_item_approved|rejected|restaged`; delete both
  `*_execution_requested`.
- `contracts/attention.ts` — add `pending_approval` to the `WorkItemAttentionItemSchema`
  allow-list (67-86).
- `contracts/records.ts` — optional origin fields on `WorkItemDto`.
- `contracts/archive.ts` — tolerant-read of removed mode fields; state-value coverage.
- `domain/transitions.ts` — new edges per §3.2.
- `domain/launch-readiness.ts` — **new**, `evaluateWorkItemLaunchability`; delete
  `domain/decision-readiness.ts`; update `domain/index.ts` exports.

### SQLite (`packages/workgraph/src/adapters/sqlite`)
- `schema.ts` — guarded migration steps (§8.1); origin columns; drop mode columns/CHECKs.
- `store.ts` — approve/reject/bulk reducers (user+owner gate, CAS, 0-rows ⇒ conflict);
  `create_work_item` actor-branch insert state; `update_work_item` agent-demotion + acyclicity
  check; delete both `execute_*` handlers; strip retry mode replay (2547-2568); unified shared
  readiness SQL fragment (abandoned-satisfies + decision guard) replacing both copies
  (1055-1077, 2603-2619); drain re-gate + renames (334-348, 932-987, 944, 1016-1033); derived
  stream-hold replacing mode-gated stops (1044-1051, 4829-4836, 4833, 5571); dispatch-map +
  supported-command list edits (151-186, 629-661); attention projection for staged.
- `archive.ts` — export/import tolerance per §8.1.

### Convex/hosted runtime
- `convex/schema.ts` — optional-then-dropped mode fields (465-466, 571).
- `convex/workgraphCommands.ts` — approve/reject handlers; typed rejection stubs for
  `execute_*` (218-280) then deletion; `continueStream` re-gate (2047-2120); `supported` set
  (17-49); `create_work_item` actor branch (524); readiness fix (1877-1888).
- `convex/workgraphRuntime.ts` — derived hold replacing mode-gated stops (1204, 1262);
  `reconcileReadyStreams` rename (63-72).
- `convex/workgraphActivity.ts` — `attachSessionTask` drops `execution_mode` (438); pin the
  attach-to-staged rejection.
- `convex/workgraphAttention.ts` — add `pending_approval` to `attentionWorkItemStates` (18).
- `convex/migrations.ts` — `reconcileStreamLifecycleFromExecutionState`.
- `convex/_generated/*` — regenerate.
- `packages/claxedo-server/src/workgraph-host/convex-store.ts` — command lists (79-111).
- `packages/claxedo-server/src/workgraph-host/hosted-app.ts` (246-262) +
  `hosted-attempt-operation.ts` — wire `SettlementDispatcher.nudge` on agent-tool completion
  (mandatory; §5.2 row 6).
- Capability-refresh handlers (local router + hosted) — post-refresh drain/nudge (§5.2 row 9).

### Server/API
- `packages/workgraph/src/http/router.ts` — no changes (verify only).
- `packages/claxedo-server/src/server.ts` / `server-workgraph.ts` — recheck composition after
  renames; local reconciler unchanged.

### MCP and agent tools
- `packages/claxedo-mcp/src/workgraph-tools.ts` — delete `workgraph_execute` (221, 902-910);
  description updates + staged-hint result wrapper for the four create tools; keep
  `workgraph_update_execution`.
- `packages/claxedo-server/src/workgraph-agent-tools.ts` — no auth change (gate lives in
  reducers); verify no execute references.

### App UI (`packages/claxedo-app/src/features/workgraph`)
- `api.ts` — per §7.4.
- `workgraph-overview.tsx` — popover deletion; card face/hover counts; Pause/Resume; Held
  marker.
- `work-item-rows.tsx` — six-label `taskStatusLabel` + glyphs + row affordances.
- `waiting/item-dialogs.tsx` — inspector per §6; delete Run-task path (41, 56).
- `workgraph-content.tsx` — counts plumbing; no transport changes.
- Needs-you attention rendering — staged rows with Approve/Reject; bulk button.

### Tests (add/update/delete detail in §11)
### Documentation/generated
- `docs/plans/README.md` — index entry; retire superseded execution prose in
  `2026-07-13-001` (state diagram at lines 204-219 gains `pending_approval`) and
  `2026-07-16-003` journey step 5.
- `packages/workgraph/dist` — `bun run build` after src edits (consumed via gitignored dist).
- Coordinate edits to `convex/workgraphCommands.ts` with the in-flight wakes-v2 settlement plan
  (`2026-07-17-002`) — same mutation family; stay substrate-agnostic (speak only via
  `SettlementDispatcher`/wakes ports).

---

## 10. Ordered implementation phases

- **P0 — Contracts & domain** (no deps): lifecycle value, commands, events, attention
  allow-list, DTO fields, transitions, `launch-readiness.ts`, deletions of dead code.
  Gate: `packages/workgraph` typechecks; contract tests green.
- **P1 — SQLite adapter + migration** (needs P0): reducers, unified readiness, drain re-gate,
  migration steps, allow-lists. Gate: workgraph unit + conformance + migration tests green.
- **P2 — Conformance & package tests** (with P1): shared conformance case update
  (`conformance/index.ts:414-447` currently embeds `executionMode:"autonomous"`), new
  approval-gate conformance factory registered for both backends.
- **P3 — Convex + hosted** (needs P0; parallel with P1 after contracts): handlers, re-gates,
  stubs, migrations, `attachSessionTask`, nudge wiring, convex-store lists. Gate: targeted
  claxedo-server suites green; migration verified on staging-copy data.
- **P4 — MCP + server surface** (needs P0): tool deletion, descriptions, staged-hint results.
- **P5 — App UI** (needs P0 contracts + a P1 or P3 backend to run against): api client, cards,
  rows, inspector, staged review, bulk, pause/resume. Gate: vitest + vision-reviewed
  screenshots (green tests are claims; require visual evidence per repo rule).
- **P6 — E2E, smoke, docs, cleanup sweep** (needs all): Playwright rewrite, smoke script
  update, docs, final `grep -rn "executionMode\|execute_stream\|execute_work_item\|
  \"supervised\"\|\"autonomous\""` sweep over src (excluding dist and the unrelated
  `HookRunSummary.ts` codex hook and store.ts:641 due-jobs wrapper name).
- **P7 — Hosted rollout** (§8.3): EXPAND+MIGRATE deploy → SPA deploy → CONTRACT deploy
  (stub removal bound here).

---

## 11. Test plan

Run from each **package directory**, never the repo root.

### `packages/workgraph` — `bun run test` (plain vitest; `bun run build` before dependents typecheck)
- **Delete:** `execution-hardening.test.ts:12-38` mode-count table;
  `sqlite-store-commands.test.ts:872-916` ("durably stops autonomous execution", raw
  `SET execution_mode` fixture at 880); `sqlite-owner-deletion.test.ts:217-249`
  (`autonomousExecution` helper + raw SQL at 225); `command-contracts.test.ts` execute-schema
  pins.
- **Update:** `execution-service.test.ts:87` (pause blocks admission — becomes the launch-gate
  spec); `execution-hardening.test.ts:72` (auto-continuation after dependency completion — drop
  mode arg); `execution-hardening.test.ts:503` (result_ready vs completion — relabel);
  `e2e/personal-journey.test.ts:169-183`; `conformance/index.ts:414-447` (lease case loses
  `executionMode`; bump `WORKGRAPH_ADAPTER_CONFORMANCE_VERSION`).
- **Keep:** admission race (`execution-hardening.test.ts:147,161`), lease-epoch recovery
  (`execution-service.test.ts:205`), durable restart (`execution-hardening.test.ts:102`).
- **Add (unit/contract):** approve/reject/bulk schema + reducer tests (user-gate,
  `not_authorized` for agent actor, CAS conflict, 0-rows ⇒ conflict, idempotent replay by
  operationId); create-by-actor initial state; agent-edit demotion + `work_item_restaged`;
  human-edit non-demotion; retry preserves approval; cancel → failed (never relaunches);
  `launch-readiness` truth table incl. abandoned-satisfies, decision guard, capability_invalid
  ⇒ attention, stream_held; dependency-edit acyclicity; approve-while-paused (no launch;
  launches on resume); reject → dependents unblocked via abandoned-satisfies.
- **Add (conformance, both backends):** approval-gate factory — staged never admitted; approve
  → auto-launch when ready; bulk partial success; never-executed-stream migration lands paused
  (the NULL/undefined `execution_state` case — SQLite and Convex must agree); archive
  round-trips `pending_approval` and tolerates legacy mode fields.
- **Add (migration):** fixture DBs covering streams with `execution_state` ∈
  {NULL, 'active', 'stopped', 'completed'} × lifecycle states; post-migration drain launches
  nothing except previously-autonomous-active streams.

### `packages/claxedo-server` — targeted files only (full suite hangs locally):
`bun run test -- src/server-workgraph.test.ts src/workgraph-process-restart.integration.test.ts src/workgraph-host/convex-store.test.ts`
- **Update:** `server-workgraph.test.ts:403` and
  `workgraph-process-restart.integration.test.ts:64-65,87` (replace `execute_work_item` fixtures
  with approve-driven launch); `convex-store.test.ts:391-445` (mode table twin — must change
  with `execution-hardening.test.ts` or backends diverge) and `:3081` conformance registration.
- **Add:** hosted nudge-on-agent-completion test (dependent launch without waiting for cron);
  `attachSessionTask` rejects staged + no mode write; typed-rejection stub behavior for stale
  `execute_*`; restart mid-approval (approve → SIGKILL → boot drain launches exactly once).
- Smoke: update `scripts/smoke/smoke-workgraph.ts:210` (hardcoded autonomous execute) to the
  approve+resume flow; keep the 10s placement SLA and reconcile polling.

### `packages/claxedo-app`
- Unit/component: `bun run test` (bun test, `--conditions=browser`). Typecheck: `tsgo -b`
  directly (debt-ratchet runs first under `bun run typecheck`). Rebuild
  `packages/workgraph` dist first.
- **Update:** `api.test.ts:494-547` — delete nothing for execute (never pinned); add body pins
  for `approve_work_item`/`reject_work_item`/`approve_work_items` and the **first-ever**
  `setStreamLifecycle` pin; `workgraph-overview.vitest.tsx:419-518` — replace popover pins with
  Approve/Reject + Pause/Resume + count pins; `workgraph-overview.vitest.tsx:15-38` +
  item-dialogs pins for the deleted Run-task path.
- **Add:** six-label `taskStatusLabel` truth table; bulk-approve partial-conflict rendering
  ("changed since you looked"); approve-while-paused copy; staged attention rows.
- Playwright (CI-gated): rewrite
  `e2e/playwright/core-workgraph.spec.ts` (Supervised/Autonomous clicks at 423, 608, 729, 828;
  `execute_work_item` posts at 942, 1010, 1207, 1240) around: agent-created task appears
  Staged → Approve → auto-runs → complete → dependent auto-runs; Reject; Pause holds, Resume
  launches; bulk approve with one concurrent edit → conflict surfaced. Run:
  `bun run test:e2e:core` from the package dir. Update `e2e/helpers/real-workgraph-harness.ts`
  accordingly.
- Browser UX gate: vision-reviewed screenshots of card counts, staged rows, pause marker
  (per no-false-positive-verification rule).

### Races & recovery (explicit tests, mostly in P1/P3 suites)
approve-vs-edit (CAS conflict); approve-vs-delete (not_found/conflict, never silent);
concurrent duplicate approve (operationId + CAS); settle-vs-cancel (unchanged pins);
restart mid-admission (existing pins kept); hosted reconcile double-fire (lease epoch pins kept).

---

## 12. Acceptance criteria (observable behavior)

1. An agent-created task (MCP or follow-up) appears as **Staged**, is never admitted, and the
   creating agent's tool result says approval is required.
2. `approve_work_item` from the app moves it to Waiting (deps incomplete) or Ready (deps met);
   in an active stream a Ready task launches with no further user action.
3. A manually created task and every task from a confirmed admission proposal never show Staged.
4. Completing a blocker auto-promotes and auto-launches its approved dependents (hosted:
   sub-second via nudge, never waiting for the 2-min cron in the happy path).
5. Rejecting a task abandons it with a reason and **unblocks** its dependents (abandoned
   satisfies dependencies).
6. Pause stops new launches (running attempts continue); Resume launches all approved+ready
   tasks; approving while paused records approval and launches only on resume.
7. `execute_stream`/`execute_work_item`, `executionMode`, and the Supervised/Autonomous UI no
   longer exist anywhere in src; retry works with no stored mode; cancel lands in Needs-you and
   only explicit retry relaunches.
8. Stream cards show "N need you" on the face and the full
   `staged · ready · waiting · running · needs you · done` breakdown on hover; rows/inspector
   distinguish all six labels.
9. Bulk approve approves only unmodified rows; concurrently edited rows return
   `version_conflict` and are visibly flagged, never approved.
10. Agents cannot approve/reject via any tool; an agent's material edit to an approved
    not-yet-run task returns it to Staged.
11. Upgrade of an existing database: no task auto-launches from any stream that was not actively
    running autonomous at upgrade time (including never-executed streams); previously
    autonomous-active streams continue seamlessly.
12. SIGKILL between approval and launch: after restart the task launches exactly once.

---

## 13. Risks and mitigations

- **Double execution** — unchanged triple fence (lease upsert + epoch, outbox claim
  re-validation, operationId dedupe) + skip-overlapping reconcile; §5.1.6 as belt-and-suspenders.
- **Approval/version races** — mandatory `expectedVersion` CAS on approve/reject (single and
  per-entry bulk); 0-rows-affected ⇒ conflict; human edits bump `row_version`, invalidating
  stale approvals.
- **Stale readiness** — readiness is derived on every pass, never cached; every
  readiness-changing mutation triggers a pass (§5.2 table, incl. the two closed gaps:
  capability refresh, agent-tool completion nudge); CF cron remains the floor.
- **Dependency changes** — derivation handles add/remove; new acyclicity check on
  `update_work_item` prevents silent Waiting-forever cycles; abandoned-satisfies prevents
  reject-deadlock.
- **Process death after admission** — outbox row + lease survive; 60s claim expiry; epoch-fenced
  takeover with `compensateRejectedLaunch`; boot drain + 1s local reconciler; reconcile never
  auto-settles (explicit completion invariant preserved and pinned).
- **Candidate-staging vs task-staging confusion** — persisted value is `pending_approval`
  (grep-unique); UI label "Staged" for tasks vs "Staged for review" for intake candidates; no
  shared `data-bucket` selectors; dead `IntakeStateSchema` deleted; the coincidental
  `executeWithAutonomousContinuation` due-jobs name (store.ts:641) and the unrelated codex
  `HookRunSummary.executionMode` are documented non-targets for the deletion sweep.
- **Migration auto-run hole** — the `execution_state IS NULL` arm (§8.1.1) + the JS
  `!== 'active'` twin keep both backends paused-by-default; conformance case pins it.
- **Silent halt loss** — the mode-gated stop writes are replaced by the derived stream-hold
  before the columns drop (they would otherwise go permanently false and kill the
  needs-you-halts-stream behavior).
- **In-flight plan collision** — wakes-v2 (`2026-07-17-002`) touches the same Convex mutation
  family; sequence P3 merges with that work-stream's owner; stay substrate-agnostic.

---

## 14. Non-goals

- No approval history/audit table (events + activity log suffice).
- No agent self-approval capability flag, roles, or multi-approver flows.
- No server-enforced confirm-admission payload fidelity (the confirm payload is human-authored;
  see §4 note — separate workstream if the owner wants content certification).
- No changes to attempt placement, leases, outbox, wakes carrier, or the CF-vs-Fly substrate
  decision.
- No incremental UI diffing (doorbell + full reload stays).
- No bulk reject.
- No reopen path for rejected tasks (create a new task; `abandoned` stays terminal).
- No supervised/autonomous compatibility mode of any kind; the typed-rejection stub in §8.2 is
  the entire bridge and is deleted in the contract release.

---

## Definition of Done

All §12 criteria demonstrated; §11 suites green from their package directories; visual evidence
captured for §12.8; migration verified against NULL/stopped/active/never-executed stream
fixtures on both backends; final repo-wide sweep shows zero remaining
`executionMode|execute_stream|execute_work_item` in src (documented non-targets excluded);
`docs/plans/README.md` updated; CONTRACT deploy completed with stubs and columns removed.
