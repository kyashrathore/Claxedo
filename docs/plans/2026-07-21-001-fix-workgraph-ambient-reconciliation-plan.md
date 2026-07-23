# Event-Driven WorkGraph Execution and Targeted Repair

## Summary

WorkGraph execution is driven by durable state transitions. A command that creates actionable work records an exact wake in the same transaction. A running Session becomes quiescent until the workspace runtime delivers a terminal event. Timed retries are reserved for operations that have a concrete next-attempt time, such as sandbox provisioning or a leased control effect.

The resulting cost model is proportional to lifecycle transitions, provider retries, and genuine recovery work. Wall-clock time spent in a healthy `running` state produces no WorkGraph settlement traffic. The periodic recovery path queries indexed overdue records globally and schedules exact repairs; it does not enumerate tenants or execute a complete tenant pipeline.

This plan covers hosted Convex/Cloudflare execution and the embedded SQLite server. The existing WorkGraph SSE live-sync path remains the client update mechanism.

## Design constraints from review (2026-07-21)

This plan is a clean replacement, not a phased overlay. Backward compatibility with the current tenant-sweep scheduler is **not** required:

- New binding/recovery tables and columns are defined as required from the start. There is no expand → backfill → contract migration and no "optional field until staging confirms" step.
- No dual-run or fall-back-to-old-behavior flags. A single rollout flag may gate turning the new terminal-delivery path on, but it never re-activates one-second tenant reconciliation.
- Cutover may drop in-flight work. Tasks that are mid-run at the deploy that ships terminal delivery have no managed binding under the old model and will restart. Deploy during a low-traffic window; this is accepted, not mitigated.

The master lifecycle is **event-driven only**. The platform does not enqueue a programmatic daily master schedule. Master turns are triggered by domain events — a message to the master mailbox (`mailbox`) and a task settling within the Stream (`task_settled`). The `schedule` trigger and its `nextDailyMasterRun`/`MASTER_DAILY_SCHEDULE` plumbing are removed. If a user's Session needs periodic master runs, that Session creates its own scheduled wake through its instructions; the platform does not impose one. A healthy Stream with no mailbox message and no settling task therefore produces no master traffic at all.

## Problem and Scope

The hosted wakes sink currently interprets nested values such as `settled: false`, `state: "running"`, and a non-empty `launched` array as reasons to schedule another tenant settlement wake. The default retry is one second. Each settlement wake invokes `runtime.reconcile({ tenants: [tenant] })`, which can claim launches, claim control effects, drain intake, claim and inspect source plans, list running Attempts, renew leases, mint relay tokens, and read Session history.

This couples unrelated maintenance paths and makes a stable running task generate repeated Convex calls and database reads. The same full reconciliation also runs from the hosted scheduled backstop, and the embedded server performs an owner sweep every second.

The scope is the scheduling and recovery architecture around:

- WorkGraph launch outbox records and sandbox provisioning;
- running Attempt Sessions and explicit completion;
- abnormal Session termination and the one allowed completion-retry turn;
- source-planning Sessions;
- Stream master Sessions;
- control effects such as interrupt, finalize, cleanup, and deletion;
- Session intake admission;
- execution-capability activation;
- WorkGraph client live synchronization;
- periodic crash/lost-delivery recovery;
- hosted and embedded runtime parity.

The WorkGraph domain model, command vocabulary, approval policy, evidence rules, and user-facing Stream/Task semantics remain in scope only where they provide transition events to this scheduler.

## Requirements Trace

| ID | Requirement | Planned coverage |
|---|---|---|
| R1 | A healthy running Attempt, source plan, or master Session schedules no recurring WorkGraph calls while its state is unchanged. | U1, U4, U5, U8 |
| R2 | Every durable transition that creates actionable work creates an exact, idempotent wake in the same transaction. | U2, U6 |
| R3 | Timed polling is limited to an exact operation with a concrete retry time, bounded backoff, and deadline. | U1, U3, U6 |
| R4 | Workspace terminal events are durable, authenticated, idempotent, restart-safe, and routed to the exact managed execution. | U4 |
| R5 | Explicit `workgraph_complete_task` remains the normal completion path and settles without waiting for a history poll. | U4, U5 |
| R6 | Duplicate, stale, reordered, and retried events produce deterministic no-op or fenced retry behavior. | U2, U4, U5, U7 |
| R7 | Control effects retain a fast path and retry only the claimed effect or outbox record. | U2, U6 |
| R8 | Recovery scans indexed overdue records globally and schedules exact repair work without tenant membership fan-out. | U7 |
| R9 | Local and hosted execution follow the same transition dispositions and terminal-delivery semantics. | U8 |
| R10 | Client synchronization stays event-driven through `workgraph.changed`; background execution does not depend on a connected browser. | U9 |
| R11 | Capability activation is versioned and idempotent so application bootstrap does not repeatedly attest and reread unchanged capabilities. | U9 |
| R12 | Telemetry measures call amplification by lifecycle transition and proves quiescence without imposing a fixed per-user call quota. | U10 |

## Case-by-Case Target Behavior

| Current case | Required latency | Target mechanism | Recovery behavior |
|---|---:|---|---|
| A command admits a runnable launch | Seconds | The Convex command mutation creates a `workgraph_launch` wake carrying the launch/outbox ID. | The global overdue query finds an unclaimed launch whose `next_recovery_at` passed and recreates the same wake. |
| A sandbox provider reports `provisioning` | Provider-defined | The exact launch, source-plan job, or master turn returns `retry_at(providerRetryAt)` and schedules one wake for that subject. | Exponential/provider-directed retries stop at the operation deadline and transition to attention/failure. |
| An Attempt Session is running normally | Event latency | The launch worker records the managed Session binding and returns `wait_for_event`. | The explicit execution/lease deadline makes the binding eligible for one exact timeout check; runtime terminal delivery has its own durable retry outbox. |
| The agent calls `workgraph_complete_task` | Request latency | The existing attempt-operation broker records result/evidence, releases the lease and binding, advances the Stream, and creates any resulting exact wake atomically. | Operation ID idempotency returns the recorded result on retry. |
| An Attempt Session ends without explicit completion | Event latency | The runtime terminal event targets the Attempt binding. The consumer requests history once and schedules the single completion-retry prompt defined by current semantics. | A later terminal event fails or raises attention according to the existing completion-retry state; duplicate terminal sequence is a no-op. |
| A source-planning Session is running | Event latency | A managed Session binding with purpose `source_plan` waits for a terminal event. The consumer reads history once and completes that job. | Overdue terminal delivery schedules a check for that source-plan job ID only. |
| A Stream master Session is running | Event latency | A managed Session binding with purpose `master` waits for a terminal event. The consumer reads history once and settles the claimed turn. | A deferred turn uses a concrete `retry_at`; an overdue terminal delivery checks that master turn only. |
| A control effect is written | Sub-second to a few seconds | The mutation creates a `workgraph_control` wake carrying the effect/outbox ID on the dedicated control serial lane. | Lease expiry recreates an exact effect wake; retries are bounded and fenced by effect epoch. |
| Session intake is admitted | Seconds | Intake admission creates a `workgraph_intake` wake carrying the intake row ID, or performs the deterministic transition within the admitting transaction when possible. | Overdue pending intake is returned by the global recovery query as an exact target. |
| Execution capabilities are activated | Request/bootstrap latency | A versioned attestation is upserted only when its fingerprint changes. Concurrent reads join one owner activation and consume the stored version. | Expired or invalid attestations create one activation request; failures remain observable and retryable at the request boundary. |
| WorkGraph data changes for an open client | Interactive | The existing `workgraph.changed` SSE doorbell invalidates and reloads the owner snapshot. | SSE replay-gap behavior refetches current state. |
| A process crashes or a nudge/event delivery is lost | Minutes | One scheduled global query returns a bounded page of discriminated overdue targets ordered by `next_recovery_at`. | Each result creates the same exact idempotent wake used by the normal path; pagination continues on the next scheduled pass. |
| The embedded local server runs WorkGraph | Same-process event latency | SQLite transactions create exact local wakes and the runtime bus immediately nudges their lanes. Terminal events are journaled before delivery. | A next-due timer and indexed overdue query replace the one-second owner sweep. |

## High-Level Design

### 1. Explicit reconciliation dispositions

Every exact worker returns one top-level disposition:

```ts
type WorkGraphDisposition =
  | { type: "complete" }
  | { type: "wait_for_event"; bindingId: string; deadlineAt: number }
  | { type: "retry_at"; at: number; reason: string; deadlineAt: number }
  | { type: "attention"; code: string }
```

The wakes sink schedules another wake only for `retry_at`. `wait_for_event` is a successful, quiescent state. `attention` persists the existing failure/attention state and emits a user-visible change. The recursive `settleRetryDelayMs(result)` heuristic is removed after all sinks return this contract.

This contract separates an incomplete business lifecycle from a runnable scheduler operation. A Session can be incomplete for hours while the scheduler has nothing to execute.

### 2. Exact wakes and serial keys

A wake identifies one actionable record:

```text
kind:            workgraph_launch | workgraph_control | workgraph_intake |
                 workgraph_terminal | workgraph_source_plan | workgraph_master |
                 workgraph_recovery
subject:         { kind, id, organizationId, ownerUserId }
serialKey:       a conflict-domain key for the resource the worker mutates
idempotencyKey:  wg:{subject-kind}:{subject-id}:{transition-or-attempt}
fireAt:          now or a concrete retry timestamp
```

The `transition-or-attempt` component is a **monotonic epoch that must advance on every legitimately distinct retry**. It is the durable transition/lease epoch of the subject, never the request timestamp. The invariant is: two wakes carry the same idempotency key **iff** they represent the same logical operation at the same epoch (bursts coalesce), and any operation that genuinely needs to run again advances the epoch first (retries are never coalesced away). A bounded provider retry (for example, three `provisioning` polls before ready) advances the epoch on each attempt so all attempts survive. Coalescing a needed retry as a duplicate would silently strand the subject, so this is a correctness-critical rule and is tested directly (see U2).

Tenant identity remains authorization and routing context. It is not the unit of reconciliation. The wake intent always names an exact subject, while its serial key represents the smallest real conflict domain: a workspace-execution key for Attempt/source/master operations that share a workspace, and an effect-specific control key for independent interrupt/cleanup work. Existing domain claims remain the final concurrency fence. Mutations use `createWakeInTx` so the domain row and its wake commit atomically. The Worker-side request wrapper nudges the Durable Object after commit as a latency optimization; the persisted wake remains authoritative.

### 3. Durable managed Session bindings

The central store records a binding for every WorkGraph-managed Session:

```text
binding_id
purpose                 attempt | source_plan | master
subject_id              attempt ID, source-plan job ID, or master turn ID
organization_id
owner_user_id
workspace_id
session_id
state                    active | terminal_received | released
expected_terminal_seq
execution_deadline_at
callback_capability_hash
created_at / updated_at / released_at
```

Existing Attempt session-binding data is migrated into this common shape. Purpose-specific domain rows retain their current authority; the binding is the delivery and routing index.

The workspace runtime persists its corresponding binding and a scoped delivery capability in the system-owned runtime store outside the agent workspace. The capability authorizes terminal delivery only for the bound workspace, Session, purpose, and subject. Its lifetime follows the managed execution and it is revoked when the binding is released. The runtime does not persist an owner-wide relay token for this purpose.

### 4. Durable terminal event delivery

When Session persistence records a terminal runtime event, one store operation appends the journal record and inserts a terminal-delivery outbox row in the same SQLite transaction. The outbox row contains the binding ID, Session ID, terminal journal sequence, outcome, and timestamp. An in-process driver attempts delivery immediately. Failed delivery updates `attempt_count` and `next_attempt_at` with bounded backoff; runtime restart reloads due rows. Accepted deliveries retain a compact receipt through the binding's replay-retention window and then become eligible for garbage collection.

The central terminal endpoint:

1. validates the scoped delivery capability while the runtime validates the configured HTTPS broker origin when accepting the binding;
2. resolves the current managed Session binding;
3. rejects identity mismatch and treats released/stale sequence delivery as an idempotent no-op;
4. records a terminal receipt and creates the exact `workgraph_terminal` wake in one transaction;
5. responds after the receipt is durable.

The terminal consumer performs purpose-specific settlement. Session history is fetched once at the transition boundary. A duplicate receipt or consumer retry reuses the persisted terminal sequence and outcome.

### 5. Indexed global recovery

Actionable tables expose a consistent recovery projection with `next_recovery_at` and a subject discriminator. A service query merges bounded indexed pages for:

- available launch outbox records;
- available control-effect records;
- pending intake rows;
- due source-plan jobs and master turns;
- managed Session bindings whose explicit execution/lease deadline elapsed;
- expired claims or delivery leases.

The scheduled Worker calls this query once per page and creates exact wakes. It does not call `listWorkerTenants` and does not run `reconcile()` for every membership. Recovery telemetry records the overdue reason and age.

## Implementation Units

### U1. Introduce explicit disposition semantics and stop ambient rearming

Files:

- `packages/claxedo-server/src/wakes-host/hosted-wakes.ts`
- `packages/claxedo-server/src/wakes-host/hosted-wakes.test.ts`
- `packages/claxedo-server/src/workgraph-host/hosted-runtime.ts`
- `packages/claxedo-server/src/workgraph-host/hosted-runtime.test.ts`

Edits:

- Add the `WorkGraphDisposition` schema/type at the hosted-runtime boundary and return it from settlement, control, and master workers.
- Map stable `running` and the first completion-retry state to `wait_for_event`.
- Map provider provisioning and explicit deferred-until timestamps to `retry_at` with operation deadline metadata.
- Map exhausted deadlines and terminal business failures to `attention`.
- Replace `settleRetryDelayMs` and its recursive inspection with a direct switch on the disposition.
- Update wake sink tests to prove `wait_for_event` schedules no follow-up and `retry_at` schedules exactly one capped wake at the requested timestamp.
- Add a staging containment assertion: a launched running task leaves no future tenant settlement wake.

Dependencies: none.

**This is a hard gate.** The ambient one-second rearm does not stop until the settle, control, **and** master sinks all return dispositions — all three currently route through `settleRetryDelayMs`, so converting only one does not change observed behavior. U1 must convert all three atomically. U1 ships to staging **alone** and must prove `workgraph_quiescent_rearm_total == 0` (U10's invariant counter, introduced early enough to observe U1) across a multi-hour running task before any of U2+ is written. This unit is the first rollout step because it removes wall-clock-driven amplification while preserving explicit timed retries, and it is the one guaranteed win to bank before the larger surface area is touched.

### U2. Add exact wake kinds and transaction helpers

Files:

- `convex/wakes.ts`
- `convex/workgraphCommands.ts`
- `convex/workgraphRuntime.ts`
- `convex/workgraphBackground.ts`
- `convex/schema.ts`
- `packages/claxedo-server/src/wakes-host/hosted-wakes.ts`
- `packages/claxedo-server/src/wakes-host/convex-wake-store.ts`
- `packages/claxedo-server/src/wakes-host/convex-wake-store.test.ts`
- `packages/claxedo-server/src/control-plane/convex-workgraph-background.test.ts`

Edits:

- Define exact intent schemas for launch, control, intake, terminal, source-plan, and master wakes.
- Use conflict-domain serial keys: shared workspace execution where Session mutations conflict, effect-specific control lanes where they do not, and subject-specific keys for independent intake/recovery work. Keep the current owner/tenant fields in the intent for service authorization.
- Extend `createWakeInTx` usage to every mutation that makes an exact subject runnable.
- Build idempotency keys from the subject and its durable transition/lease epoch, not the request timestamp.
- Have command mutations create wakes only when the command creates or unblocks actionable work. Progress checkpoints, notes, notifications, and read-only commands continue to emit `workgraph.changed` but do not create settlement wakes.
- Keep Durable Object nudges after transaction commit to minimize latency, with the Convex wake row as the durable source.

Tests:

- Atomicity: a mutation failure rolls back both the domain row and wake.
- Coalescing: repeated delivery of one transition at the same epoch creates one wake.
- Epoch monotonicity (correctness-critical): a legitimately distinct retry advances the epoch and is **not** coalesced. Assert that three provider `provisioning` retries produce three distinct wakes while a same-epoch burst produces one — the "retry is not silently swallowed as a duplicate" case.
- Isolation: two subjects for one tenant can run independently; repeated work for one subject serializes.
- Command matrix: each command type asserts whether it creates launch, control, master, or no execution wake.

Dependencies: U1.

### U3. Split tenant reconciliation into exact workers

Files:

- `packages/claxedo-server/src/workgraph-host/hosted-runtime.ts`
- `packages/claxedo-server/src/workgraph-host/hosted-runtime.test.ts`
- `packages/claxedo-server/src/workgraph-host/convex-store.ts`
- `packages/claxedo-server/src/workgraph-host/convex-store.test.ts`
- `convex/workgraphRuntime.ts`
- `convex/workgraphBackground.ts`

Edits:

- Expose exact runtime operations: `runLaunch(outboxId)`, `runControl(effectId)`, `runIntake(intakeId)`, `runSourcePlan(jobId)`, `runMaster(turnId)`, and `runTerminal(bindingId, terminalSeq)`.
- Change claim mutations to accept the exact ID plus tenant fence. Preserve lease/epoch validation and return idempotent terminal results for already-settled records.
- Move sandbox `ensure()` retries into the exact launch/source/master worker and return `retry_at` using the provider delay and the durable operation deadline.
- Remove Session-history reads and running-attempt enumeration from launch execution.
- Keep bounded batch claims only inside the global recovery worker, where each claimed result is converted into a subject wake.

Tests:

- Exact worker cannot claim a different tenant's record.
- Provider provisioning touches only the subject and schedules one retry.
- A stable running result returns `wait_for_event` and performs no list-running/history operation.
- Lease expiration and stale worker epoch are fenced.

Dependencies: U1, U2.

### U4. Persist managed Session bindings and terminal delivery

Files:

- `packages/workspace-runtime/src/store.ts`
- `packages/workspace-runtime/src/store.test.ts`
- `packages/workspace-runtime/src/session/service.ts`
- `packages/workspace-runtime/src/session/service.test.ts`
- `packages/workspace-runtime/src/routes/events.ts`
- `packages/workspace-runtime/src/routes/session.ts`
- `packages/workspace-runtime/src/routes/session.test.ts`
- `packages/workspace-runtime/src/routes/workgraph-attempt-tools.ts`
- `packages/workspace-runtime/src/routes/workgraph-attempt-tools.test.ts`
- `packages/claxedo-server/src/hosted-app.ts`
- `packages/claxedo-server/src/workgraph-host/hosted-attempt-operation.ts`
- `packages/claxedo-server/src/workgraph-host/hosted-attempt-operation.test.ts`
- `convex/schema.ts`
- `convex/workgraphRuntime.ts`

Edits:

- Add workspace-runtime SQLite tables for managed Session bindings and terminal-delivery outbox rows, with indexes on `(state, next_attempt_at)` and uniqueness on `(binding_id, terminal_seq)`.
- Add a single `appendTerminalAndEnqueueDelivery(...)` store operation so callers cannot journal a terminal event without its delivery row.
- Persist the binding currently held only in the `bindings` map. Reconstruct tool registrations and pending terminal deliveries during runtime startup.
- Insert the delivery outbox row in the same transaction that journals a terminal Session event.
- Add the central terminal-delivery route and Convex mutation that validates the scoped capability, records a receipt, and creates the exact terminal wake atomically.
- Extend the binding payload to include purpose, subject, callback capability, delivery endpoint, and execution deadline.
- Store only a hash of the callback capability centrally; use constant-time verification and redact credentials from logs and event payloads.
- Enforce the existing bounded-body policy on the endpoint, rate-limit invalid/replayed requests by binding and origin, and keep accepted duplicate delivery cheap through the receipt index.
- Release both central and runtime bindings after terminal settlement, while retaining the receipt needed for duplicate suppression.

Tests:

- Runtime restart restores a binding and delivers an already-journaled terminal event.
- A terminal event and outbox insert commit atomically.
- Duplicate and reordered terminal sequences are idempotent.
- Workspace, Session, purpose, subject, and capability mismatches return authorization errors without state changes.
- Capability revocation follows binding release.
- Delivery failure backs off and remains due after process restart.

Dependencies: U2. This unit can proceed alongside U3 once the exact terminal intent is fixed.

### U5. Convert Attempt, source-plan, and master settlement to terminal consumers

Files:

- `packages/claxedo-server/src/workgraph-host/hosted-runtime.ts`
- `packages/claxedo-server/src/workgraph-host/hosted-runtime.test.ts`
- `packages/claxedo-server/src/workgraph-host/hosted-attempt-operation.ts`
- `packages/claxedo-server/src/workgraph-host/hosted-attempt-operation.test.ts`
- `convex/workgraphRuntime.ts`
- `convex/workgraphBackground.ts`
- `convex/workgraphCommands.ts`
- `packages/claxedo-server/src/control-plane/convex-workgraph-background.test.ts`
- `packages/claxedo-server/src/workgraph-host/convex-store.test.ts`

Edits:

- Preserve direct explicit Attempt completion through `complete_attempt`; make the mutation release the managed binding and create the next exact Stream/master/launch wake in the same transaction.
- Route Attempt terminal events without explicit completion through the current one-retry completion policy. Fetch Session history once for that terminal sequence and persist the decision before prompting again.
- Bind source-plan and master Sessions with their actual purpose and subject rather than an Attempt-shaped synthetic identity.
- On source-plan terminal delivery, fetch/parse the final history once, complete or fail the exact job, and enqueue resulting actionable work.
- On master terminal delivery, fetch history once, settle the exact master turn, persist mailbox/summary effects, and enqueue the next exact transition.
- Make the master lifecycle event-driven only. Keep the `mailbox` and `task_settled` master-wake triggers; remove the programmatic `schedule` trigger, the `enqueueMasterSchedule` producer, and the `nextDailyMasterRun`/`MASTER_DAILY_SCHEDULE`/`computeNextRun` daily plumbing in `convex/workgraphCommands.ts`, `hosted-wakes.ts`, and `local-master-runtime.ts`. The platform imposes no periodic master run; a Session that wants one creates its own scheduled wake through its instructions. A Stream with no mailbox message and no settling task produces no master traffic.
- Remove `listRunning`, `listRunningSourcePlans`, and repeated master Session-history inspection from the active hosted execution path after terminal delivery is enabled.

Tests:

- Explicit completion settles immediately and a later terminal callback is a no-op.
- First terminal-without-completion creates exactly one retry prompt; the second terminal settles failure/attention exactly once.
- Source-plan and master terminal consumers fetch history once per accepted terminal sequence.
- Master triggering: creating a Stream enqueues **no** daily-schedule wake; a `task_settled` event and a `mailbox` message each enqueue exactly one master wake; an idle Stream (no message, no settling task) enqueues none.
- Duplicate consumer execution after a crash returns the recorded result without another prompt or domain transition.

Dependencies: U3, U4.

### U6. Make control effects and intake exact, fast, and bounded

Files:

- `convex/workgraphCommands.ts`
- `convex/workgraphRuntime.ts`
- `convex/workgraphBackground.ts`
- `packages/claxedo-server/src/wakes-host/hosted-wakes.ts`
- `packages/claxedo-server/src/workgraph-host/hosted-runtime.ts`
- `packages/claxedo-server/src/workgraph-host/hosted.ts`
- `packages/claxedo-server/src/hosted-app.ts`
- `packages/claxedo-server/src/control-plane/convex-workgraph-background.test.ts`
- `packages/claxedo-server/src/workgraph-host/hosted.test.ts`

Edits:

- Create control wakes inside the mutation that writes interrupt/finalize/cleanup/delete effects.
- Claim and complete one exact effect by ID and epoch on the dedicated control lane.
- Represent retryable remote interruption/cleanup failures as `retry_at`; represent successful or obsolete effects as `complete`.
- Create an intake wake when durable Session intake is admitted. Process the exact row and create any launch/master wake caused by its transition.
- Remove request-level general settlement nudges from successful commands. Keep the post-commit driver nudge for wake rows and keep `workgraph.changed` for UI state.
- Remove the full background pipeline from the control sink.

Tests:

- Delete/cancel creates and drains one exact control wake without launch/source/history calls.
- A retryable control failure preserves its fence and schedules the requested retry.
- Repeated control wake delivery after completion is a no-op.
- Intake admission creates one exact wake and its retry does not duplicate the admitted prompt.

Dependencies: U2, U3.

### U7. Replace tenant sweeps with indexed overdue-target recovery

Files:

- `convex/schema.ts`
- `convex/workgraphRuntime.ts`
- `convex/workgraphBackground.ts`
- `packages/claxedo-server/src/workgraph-host/hosted-runtime.ts`
- `packages/claxedo-server/src/workgraph-host/hosted-runtime.test.ts`
- `packages/claxedo-server/src/worker.ts`
- `packages/claxedo-server/src/worker.test.ts`
- `packages/claxedo-server/src/control-plane/convex-workgraph-policy.test.ts`

Edits:

- Define the recovery fields (`next_recovery_at`, subject discriminator) and their indexes as **required** from the start. No backward compatibility is required, so there is no optional-field/backfill/contract sequence: rows are created in the new shape and any pre-existing in-flight rows are abandoned at cutover per the review constraints.
- Replace `listStaleTenants` and `listWorkerTenants` recovery usage with `listOverdueTargets({ cursor, limit, now })` returning discriminated exact subjects.
- Have the 15-minute Worker schedule one idempotent exact wake per returned target. Bound each invocation by page size and CPU budget; carry pagination to the next scheduled invocation or a recovery continuation wake.
- Record overdue age, target kind, and recovery reason for operations visibility.
- Keep execution/lease deadlines independent from terminal-delivery retry timing. A healthy Session receives one explicit maximum-execution alarm when policy requires it; it does not receive recurring health checks.

Tests:

- Recovery query uses the declared indexes and does not enumerate organization memberships.
- One overdue Attempt binding creates one terminal-health wake and no launch/control/source claims.
- Lost launch and control nudges recreate their exact wake.
- A page limit never drops targets; continuation resumes after the last cursor.
- Healthy running bindings before their deadline produce no recovery result.

Dependencies: U2, U3, U4.

### U8. Bring the embedded server onto the same event model

Files:

- `packages/claxedo-server/src/server.ts`
- `packages/claxedo-server/src/server-workgraph.test.ts`
- `packages/claxedo-server/src/workgraph-process-restart.integration.test.ts`
- `packages/claxedo-server/src/server-workgraph.ts`
- `packages/workgraph/src/adapters/sqlite/schema.ts`
- `packages/workgraph/src/adapters/sqlite/store.ts`
- `packages/workgraph/src/adapters/sqlite/source-planning-runtime.ts`
- `packages/workspace-runtime/src/runtime-event-hub.ts`
- `packages/workspace-runtime/src/store.ts`

Edits:

- Route local domain transitions through the same exact wake intent and disposition vocabulary.
- Subscribe the local WorkGraph host to durable runtime terminal delivery. Because the embedded runtime and host share one process, local delivery is a **direct in-process function call** into the same terminal consumer, reusing the durable terminal outbox (crash-safe replay) but **not** the HTTPS endpoint, scoped callback capability, origin validation, or credential-hashing layer — those exist only for the cross-process hosted case. The in-memory runtime bus is the immediate nudge; the durable outbox row is authoritative. There is exactly one terminal-consumer implementation shared by both surfaces; only the transport in front of it differs (HTTP endpoint hosted, direct call local).
- Replace the one-second `setInterval` owner enumeration with a next-due timer derived from SQLite wake/outbox indexes plus a slower overdue-target recovery sweep.
- Persist timer intent before arming it and recompute the earliest due row on restart.
- Retain conflict-domain serialization and allow operations on independent resources to run concurrently.

Tests:

- A local running Attempt causes no periodic store calls between launch and terminal event.
- Process restart delivers a journaled terminal event and settles once.
- Lost in-memory nudge is recovered from the durable next-due row.
- Two owners and two subjects do not block one another.

Dependencies: U1-U6. The local implementation can reuse the common contract while hosted recovery is completed in U7.

### U9. Stabilize capability activation and preserve event-driven client sync

Files:

- `packages/claxedo-server/src/workgraph-host/hosted.ts`
- `packages/claxedo-server/src/workgraph-host/hosted.test.ts`
- `convex/workgraphCapabilities.ts`
- `packages/claxedo-server/src/control-plane/convex-workgraph-capabilities.test.ts`
- `packages/claxedo-app/src/features/workgraph/sync-lifecycle.ts`
- `packages/claxedo-app/src/app/connection/stream-sync-lifecycle.test.ts`
- `packages/claxedo-app/src/features/workgraph/workgraph-changed-event.ts`

Edits:

- Compute a capability fingerprint from the provider/catalog version and upsert an attestation only when the fingerprint or expiry window changes.
- Persist an owner activation claim/status in Convex so concurrent isolates join the same activation. The claim is leased, retryable after expiry, and invalidated when provider/catalog inputs change.
- Replace the fixed 16-by-2-second cross-isolate read loop with one activation state read that returns ready, pending with retry metadata, or terminal error. A pending response is carried by existing application bootstrap/revalidation behavior.
- Create an exact launch wake when capability readiness unblocks durable WorkGraph work.
- Retain `workgraph.changed` SSE invalidation and replay-gap refetch. Add a regression assertion that WorkGraph UI synchronization contains no timer-based activity polling.

Dependencies: U2. Capability work is independent of terminal delivery and can be shipped before U10 measurement.

### U10. Add cost-amplification telemetry and remove legacy settlement paths

Files:

- `packages/claxedo-server/src/workgraph-host/hosted-runtime.ts`
- `packages/claxedo-server/src/wakes-host/hosted-wakes.ts`
- `packages/claxedo-server/src/wakes-host/wake-settlement-dispatcher.ts`
- `packages/claxedo-server/src/workgraph-host/cloudflare-settlement-dispatcher.ts`
- `packages/claxedo-server/src/worker.ts`
- `packages/claxedo-server/wrangler.toml`
- `packages/claxedo-server/src/workgraph-host/hosted-runtime.test.ts`
- `packages/claxedo-server/src/wakes-host/hosted-wakes.test.ts`
- `packages/claxedo-server/src/worker.test.ts`

Edits:

- Emit counters for wakes created/fired by kind and cause, exact worker executions, provider retries, terminal deliveries, duplicate receipts, recovery targets, and Convex calls per transition.
- Add a `workgraph_quiescent_rearm_total` invariant counter. Its healthy value is zero; any attempt to schedule from `wait_for_event` fails a test and emits an error in staging.
- Measure call amplification as `background function calls / durable actionable transitions`, segmented by wake kind. Report absolute calls alongside the ratio without enforcing a product-wide fixed call count.
- Run staging soak scenarios before removing `CLAXEDO_WAKES_SETTLEMENT`, the tenant `workgraph_settle` sink, request-level settlement dispatchers, full `reconcile()` scheduling, and their Durable Object bindings/migrations where unused.
- Keep one rollback flag that routes terminal delivery to the bounded exact recovery worker during rollout. The flag does not reactivate one-second tenant reconciliation.

Dependencies: U5-U9.

## Dependency Order

```text
U1 explicit dispositions
 └─ U2 exact atomic wakes
     ├─ U3 exact workers ───────────┐
     ├─ U4 terminal delivery ───────┼─ U5 terminal consumers
     ├─ U6 control + intake ────────┤
     └─ U9 capabilities + UI ───────┤
                                    ├─ U7 indexed recovery
                                    └─ U8 local parity
                                          └─ U10 telemetry + retirement
```

U3 and U4 can be developed concurrently after U2. U6 and U9 touch separate domain surfaces and can proceed while terminal delivery is built. U10 owns deletion of legacy paths only after the event consumers and recovery proof are complete.

The delivery milestones are:

- **Containment (hard gate):** U1 stops the one-second rearm behavior independently and ships/soaks **alone**. U2 is not started until U1 has proven `workgraph_quiescent_rearm_total == 0` on a multi-hour staging task. This banks the one guaranteed cost win before the larger, harder-to-review surface area is opened, and matches this repo's history of large WorkGraph plans needing revision after real observation.
- **Hosted transition model:** U2-U7 make hosted execution event-driven and exact.
- **Parity and cleanup:** U8-U10 align embedded execution, capability bootstrap, observability, and legacy removal.

## End-to-End Test Scenarios

1. **Healthy long-running Attempt:** admit one task, reach `running`, hold for 30 minutes, then complete explicitly. This is the hard, numeric proof of the plan's headline claim: sample the WorkGraph background-call counter at launch-settled and again at completion and assert the **delta is exactly zero**, and assert `workgraph_quiescent_rearm_total == 0` over the interval, and assert no future settlement wake exists. This equality — not a prose "proportional" judgment — is the pass/fail gate for quiescence.
2. **Provider provisioning:** provider returns three `provisioning` responses with explicit delays, then ready. Exactly four subject worker executions occur; no control, intake, source-plan, master, or running-history query runs.
3. **Explicit completion:** the tool broker completes the Attempt, advances the Stream, and releases the binding. A later runtime terminal event is accepted as a duplicate/no-op.
4. **Missing completion tool:** terminal delivery triggers one history read and one retry prompt. A second terminal event records failure/attention without further prompts.
5. **Runtime restart:** a terminal event is journaled, delivery fails, and the runtime process restarts. The recovered outbox delivers once and central settlement remains idempotent.
6. **Source planning and master:** each managed Session waits without rearming, then one terminal event causes one history read and one exact settlement.
7. **Fast control:** a Stream delete during an unrelated provisioning launch settles on its control lane without waiting for the launch and without invoking tenant reconciliation.
8. **Lost wake nudge:** the Convex wake row commits while the Durable Object nudge fails. The scheduled recovery query recreates/drives only that exact subject.
9. **Stale and hostile callbacks:** wrong workspace, wrong Session, wrong subject, released binding, expired capability, replayed sequence, and reordered sequence cannot mutate domain state.
10. **Local quiescence:** the embedded server executes the same lifecycle with no one-second owner enumeration and recovers a pending terminal delivery after restart.
11. **Capability bootstrap:** repeated application loads with an unchanged capability fingerprint perform reads against the valid attestation and do not write a new attestation or create general settlement wakes.
12. **Client live sync:** one durable WorkGraph change produces an SSE invalidation and serialized snapshot reload; an idle open browser creates no WorkGraph activity polling.

## Rollout and Operational Proof

1. Ship U1 to staging **alone** and verify that existing running Sessions stop creating follow-up settlement wakes. This is a hard gate: `workgraph_quiescent_rearm_total` must read zero across a multi-hour running task before U2 begins. Keep the 15-minute recovery path during the transition.
2. Ship exact atomic wakes and exact workers behind per-kind flags. Compare exact-worker outcomes with current domain state for launch, control, and intake transitions.
3. Enable durable terminal delivery for test workspaces. Observe delivery latency, duplicate rate, callback authorization failures, and outbox age.
4. Enable Attempt consumers, then source-plan and master consumers. Confirm stable running intervals are quiescent before disabling their history-poll path.
5. Enable indexed global recovery and local next-due scheduling. Confirm recovery targets are sparse, exact, and explainable.
6. Run the end-to-end staging scenarios, including a multi-hour running task and runtime restart.
7. Remove tenant settlement scheduling and legacy dispatcher code after two staging soak windows show zero quiescent rearms and successful recovery injections.

Rollback is per wake kind. An event consumer can be disabled while its exact records remain recoverable through the indexed backstop. Persisted bindings, receipts, and wakes are additive during rollout, so disabling a consumer does not discard domain work.

## Security Invariants

- The terminal endpoint accepts only scoped callback capabilities; interactive user credentials and broad runtime owner tokens do not authorize it.
- Authorization binds organization, owner, workspace, Session, purpose, subject, and current binding state before any receipt or wake is written.
- Callback capability material is kept in the system-owned runtime store outside the agent workspace with restrictive file permissions, hashed centrally, redacted from logs, and revocable by releasing the binding.
- Terminal payloads contain lifecycle metadata and journal sequence only. Session content remains behind the existing authenticated runtime history request and is fetched by the exact consumer when required.
- Replay protection uses the durable `(binding_id, terminal_seq)` receipt. Released bindings keep replay receipts for a defined retention window.
- Bounded request bodies, invalid-request throttling, delivery backoff, and per-binding wake coalescing constrain callback and replay traffic.

## Risks and Mitigations

| Risk | Mitigation |
|---|---|
| A runtime emits terminal state before its managed binding commits. | Create the central binding before prompt admission, persist the runtime binding before starting the Session, and replay any terminal journal entries newer than the binding's acknowledged sequence. |
| Terminal delivery credentials outlive or cross their subject. | Scope credentials to workspace, Session, purpose, and subject; store only their hash centrally; revoke on release; validate current binding state for every callback. |
| Explicit completion races with terminal delivery. | Both paths use the same binding/state fence. The first terminal domain transition wins; the other records an idempotent receipt and returns the stored result. |
| Recovery begins while a normal delivery is in flight. | Use lease epochs and idempotency keys on the exact subject. Recovery deadlines exceed normal delivery retry windows. |
| Provider provisioning has no callback support. | Preserve subject-scoped timed retries using provider delay, bounded backoff, and a durable deadline. |
| A broad command wrapper accidentally recreates wake amplification. | Maintain the command-to-wake matrix test and require every wake to carry an exact subject and cause. |
| Capability attestation staleness blocks launch. | Persist fingerprint, expiry, and activation state; capability-ready transition creates the exact launch wake. |
| Removing tenant reconciliation hides an unmodeled transition. | Instrument legacy reconcile during rollout to report which exact actionable records it would have found, add the missing transition producer, then retire that discovery case. |
| Workspace-wide serialization slows unrelated work. | Derive the key from the actual mutation conflict: workspace execution only for shared Session/sandbox state, effect ID for isolated controls, and subject ID for independent records. Domain lease/epoch checks remain authoritative. |
| Inverting central-pull to runtime-push delays settlement during a runtime→control-plane network partition (the old poll would have driven it). | The delivery outbox retries the push itself with bounded backoff, so an ordinary blip self-heals in seconds without recovery. Only a lost outbox or a dead worker process falls through to the indexed recovery backstop (minutes). This is an accepted latency tradeoff, not an unbounded stall; state it explicitly rather than presenting push as pure upside. |

## Verification Commands

Run tests and type checking from package directories. Run the **named files only** — the full `claxedo-server` vitest suite is known to hang locally, so the targeted list below is the supported path, not a convenience.

```sh
cd packages/claxedo-server
bun run test src/wakes-host/hosted-wakes.test.ts
bun run test src/workgraph-host/hosted-runtime.test.ts
bun run test src/workgraph-host/hosted-attempt-operation.test.ts
bun run test src/control-plane/convex-workgraph-background.test.ts
bun run test src/control-plane/convex-workgraph-capabilities.test.ts
bun run test src/worker.test.ts
bun run test src/server-workgraph.test.ts
bun run test src/workgraph-process-restart.integration.test.ts
bun typecheck

cd ../workspace-runtime
bun run test src/store.test.ts
bun run test src/session/service.test.ts
bun run test src/routes/session.test.ts
bun run test src/routes/workgraph-attempt-tools.test.ts
bun typecheck

cd ../claxedo-app
bun run test -- src/app/connection/stream-sync-lifecycle.test.ts
bun typecheck
```

After public Protocol or Server `HttpApi` changes, run:

```sh
cd packages/client
bun run generate
```

## Definition of Done

- Stable `running` states produce no WorkGraph rearm wakes and no periodic history reads.
- Every actionable state transition has an identified producer, exact durable subject, atomic wake, idempotency key, and bounded recovery path.
- Sandbox polling is subject-scoped, provider-directed, bounded, and deadline-aware.
- Attempt, source-plan, and master terminal settlement is driven by durable authenticated runtime events.
- Control effects remain independently fast under unrelated launch or Session load.
- Hosted recovery performs indexed exact-target queries without tenant membership enumeration.
- The embedded server has no one-second WorkGraph owner sweep.
- The master lifecycle has no platform-imposed schedule; master turns fire only on `mailbox` and `task_settled` events, and `nextDailyMasterRun`/`MASTER_DAILY_SCHEDULE` are removed.
- Capability attestation writes occur only for changed/expiring fingerprints.
- WorkGraph UI synchronization remains SSE-driven.
- A 30-minute idle running Attempt produces a background-call-counter delta of **exactly zero** (E2E scenario 1), and staging telemetry demonstrates zero quiescent rearms (`workgraph_quiescent_rearm_total == 0`) across all soak scenarios. The zero-delta equality — not a "proportional" judgment — is the pass/fail gate.
