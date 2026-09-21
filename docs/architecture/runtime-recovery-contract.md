# Runtime recovery contract

Status: proposed for review; implementation is not authorized by this document.

Defined on 2026-09-20 against the current working tree at HEAD `e06522f6e6092f90c549815edb33b37264759b20`. Existing uncommitted lifecycle changes were inspected. This contract specifies intended behavior, not behavior already delivered.

## 1. Objective

A failed operation must leave Claxedo inspectable, controllable, and recoverable. Recovery must not depend on the blocked execution path becoming healthy. A known error must reach a responsible owner and the caller promptly, even when cleanup or persistence cannot complete.

Legitimate background work may outlive the desktop. Silence or age is not proof that work is abandoned. Conversely, an active counter or a cached busy flag is not proof that useful execution continues.

This contract covers turns, approvals/questions, provider requests, runtime writes and projections, process ownership, harness retirement, and daemon recovery. It applies to native and configured harnesses, including remote and in-process execution. It does not prescribe fixes to individual frozen sessions or add a renderer reconciliation loop.

## 2. Current flow and the boundary that must change

When a user submits a prompt:

1. `AgentRuntime.turns.start` acquires the session's admission through `createTurnAdmissions`, including a durable turn lease. The workspace host also owns an active-turn scope and any checkpoint write scope.
2. The SDK adapter starts a producer. The harness owns provider requests and, where applicable, local child processes. The producer projects events into the runtime store and publishes them to clients.
3. On completion, the runtime records the turn outcome and releases admission; producer and workspace scopes drain. These releases remove the activity that keeps the harness and daemon resident.
4. On Stop, `AgentRuntime.turns.abort` calls the adapter. Codex rejects its completion wait, but its `finally` still awaits provider cancellation. Shared runtime disposal can await admitted operations before exposing an already-known stop failure.
5. `localDaemonResidencyPins` counts turns, writes, checkpoint transitions, and running PTYs. Daemon shutdown is currently deferred until those owners disappear. Desktop relaunch adopts a responding daemon.

The change point is the ownership and recovery boundary: normal completion remains one path to releasing resources, but a failure must also permit bounded inspection, containment, and verified cleanup by the existing parent owner. The UI and transport clients remain consumers of authoritative results.

## 3. Non-negotiable rules

1. Every operational error has one responsible owner and a caller-visible result. Error reporting cannot await cleanup.
2. Request acceptance, execution termination, resource cleanup, and durable reconciliation are different facts.
3. A deadline bounds an attempt; it does not prove an operation stopped or succeeded.
4. Recovery operations do not acquire a turn admission, wait for `whenIdle`, or queue behind the target producer, projection, or configuration operation.
5. An owner retains responsibility for possibly live resources after a failed stop. It may close a failed caller's wait without declaring those resources gone.
6. Every destructive action targets an execution/process generation. A stale action cannot affect its replacement.
7. State repair consumes canonical journal, provider, or verified lifecycle facts. No age-based synthetic completion, renderer-made idle, or inferred successful tool output.
8. Failure of optional telemetry may be ignored only because it has no operational responsibility. Approval persistence, cancellation, fencing, cleanup, and terminalization are not telemetry.

## 4. Owners and authority

| Existing boundary | Authoritative responsibility | Escalation authority |
|---|---|---|
| Runtime turn admission | Session turn identity, admission, and write generation | Workspace host may retire the affected execution under an authorized recovery operation |
| Runtime store and journal | Durable turn outcomes, ordered projections, persisted leases | Runtime reconciliation repairs from canonical evidence; clients never patch these tables |
| Harness adapter/driver | Provider interaction identity and normal cancel/query operations | Its host may retire the owned harness generation |
| Local process launch owner | Process handle/group, launch identity, verified exit and descendants | Host may signal its owned resources without provider cooperation |
| Workspace host | Affected sessions, admission gating, cleanup obligations, recovery operation results | Machine daemon coordinates escalation spanning a shared harness or workspaces |
| Machine daemon | Machine-local work and client leases; coordinated drain | Desktop main or the host launcher can terminate the verified local daemon generation if it is unresponsive |
| Renderer / remote client | Display facts and invoke authorized operations | No direct database repair or inferred process authority |

Implement these responsibilities within the existing owners. Do not create another session store or a separate background recovery daemon.

`AgentProcessObserver` is currently optional diagnostics. Its inferred process rows and swallowed observer errors cannot establish permission to kill a process. Recovery must use the launch owner's mandatory handle and identity. Reuse descriptor identities where appropriate, but keep observation distinct from authority.

Every resource must be inspectable by owner ID, launch/execution generation, parent owner, affected sessions, and the operation keeping it resident. A PID alone is insufficient: verify creation identity and ownership to prevent PID-reuse mistakes. Detached descendants need explicit ownership or an explicit handoff to the managed-process owner; a name match is not a handoff.

Local launch ownership must be recoverable across a daemon crash before a process start is acknowledged as managed. Extend canonical host ownership persistence as needed; do not rely on the diagnostics sink. If that persistence cannot record ownership, refuse new managed execution. For remote execution, the provider or remote host owns the equivalent identity and recovery authority.

## 5. Separate facts in every recovery result

The following are proposed contract fields, not additional transcript statuses:

| Fact | Values | Meaning |
|---|---|---|
| Execution | `running`, `terminal`, `unknown` | What the authoritative owner/provider can establish for the target turn |
| Cleanup | `owned`, `verified_clear`, `unknown` | Whether resources that should end with the target are still owned, confirmed gone, or unverifiable |
| Persistence | `committed`, `pending`, `unavailable` | Whether the observed outcome and required ownership changes are durably recorded |

Attach evidence source, generation, and observation time to these facts. A completed turn may have intentionally transferred a dev server to the managed-process owner; that server is outside turn cleanup but remains visible in host ownership.

Examples:

- Provider confirmed cancellation, but a turn-owned command remains: execution terminal, cleanup owned. Do not offer a completed cleanup result.
- Owned process group exited, but SQLite rejects finalization: execution terminal if that group was the exclusive execution owner, cleanup verified clear, persistence unavailable. Do not claim the transcript is reconciled.
- A remote cancel request timed out: execution unknown; disconnecting the local client does not prove remote termination.

Reuse `AgentRuntimeStatus.recovering` with `uncertain_execution` for unresolved execution and existing health states `degraded`/`unavailable`. Recovery progress and storage failure belong in the recovery/health response; do not force every failure into `busy`, or add a parallel session-status authority.

## 6. Public operation contract

These are logical operation names. Extend the existing runtime/host APIs; route spelling is not a second implementation. Existing abort and daemon shutdown routes must expose these semantics instead of returning ambiguous success. UI, CLI, and agent callers use the same typed operations and authorization checks.

| Operation | Owner | Required postcondition / bounded result |
|---|---|---|
| Inspect | Host, with optional bounded provider reads | Return ownership, waiting reason, current failure, evidence freshness, persistence health, and permitted recovery actions. Return partial evidence if a dependency fails. Never resume a session to inspect it. |
| Reconcile session | Runtime/store owner | Replay valid journal entries in order; consult the existing execution owner where necessary; commit justified terminal state and lease changes. Otherwise return the precise unresolved evidence or storage blocker. Never repeat the user's prompt or tool call. |
| Cancel turn | Runtime, delegating to the harness | Target the exact turn generation. Attempt provider cancellation and clean up turn-owned resources within the authorized scope. Success requires terminal execution, required cleanup, and committed finalization. Otherwise report partial effects and the next permitted action. |
| Retire harness generation | Host/process owner | Gate admission for affected sessions, retire write authority, stop the owned generation, verify resources, then reconcile its affected turns. Never silently restart the failed prompt. |
| Drain daemon | Machine daemon | Gate new work; report all existing work and cleanup blockers; wait only to the operation deadline. A nonempty scope returns a blocked result, not an indefinitely pending shutdown. Ordinary client exit still permits background work. |
| Stop/restart daemon | Machine owner; external launcher if necessary | Execute an explicitly authorized scope of interruption, verify the old owned generation, and run startup reconciliation before reopening admission. A responding HTTP endpoint alone is not replacement readiness. |

Inspection must report the individual owners behind aggregate counts. `activeTurns: 3` is insufficient for recovery: identify the three turns and their waiting conditions. Draining never means deleting lease rows until counts become zero.

Authorization remains scoped to the existing session/workspace/machine authority. Session access does not confer authority to terminate a shared harness. Shared escalation requires a preview naming the affected sessions/resources and an authorization bound to that generation and scope revision. Revalidate immediately before action; if the impact expands, return a scope-changed result for renewed selection. Gate admission atomically with accepting the reviewed scope.

Ordinary containment of resources exclusively owned by a failed operation is part of the execution owner's existing responsibility; it does not require a fresh permission prompt for every failure. User Stop authorizes cancellation of the named turn and cleanup of its owned resources. Escalation that interrupts additional sessions, retained managed processes, or the containing daemon requires the broader scope to be authorized. A provider or local process must not gain extra tool permissions during recovery.

## 7. Acknowledgements, deadlines, retries, and disconnects

Every mutating recovery request carries a client request ID, action, target generation, and authorized scope. The owner returns an operation ID and one of `accepted`, `running`, `succeeded`, `failed`, or `needs_action`. Responses also carry the three facts above, phase deadline, attempt number, initiating error, cleanup errors, and permitted next actions. These proposed operation states describe the command, not the session transcript.

`succeeded` means that action's advertised postcondition holds. Inspection may succeed while execution is running; cancellation may not. A deadline yields `needs_action` when evidence is uncertain or escalation is required, or `failed` for a known failure. It never leaves a command marked running forever. Later verified evidence may update the facts without rewriting the historical attempt as successful.

Proposed initial local budgets:

| Boundary | Budget | On expiry |
|---|---|---|
| Host acknowledgement / local ownership inspection | 2 seconds | Caller reports host unavailable; local launcher inspection remains available |
| Provider evidence query | 5 seconds | Return partial inspection / uncertain evidence |
| Graceful turn cancellation | 10 seconds | Return escalation action or continue only within pre-authorized termination scope |
| Owned process TERM grace | 3 seconds | Send KILL only if authorized for this verified ownership scope |
| Exit verification after KILL | 2 seconds | Report cleanup unresolved and retain ownership responsibility |
| Reconciliation attempt / daemon drain | 30 seconds | Return exact blockers and next actions; preserve checkpoint position |

Budgets are centralized policy, injectable in tests. Parent deadlines cap all child waits; sequential per-child timers must not multiply the total indefinitely. A caller may choose an explicit longer drain deadline. There is no arbitrary runtime limit on healthy model turns or managed dev servers.

Repeated transport delivery of the same request ID returns the same operation. Explicit Retry creates a new attempt linked to the failed operation, checks its partial effects and current generation, and retries only safe remaining steps. A cached rejected stop promise is not a retry policy. Query the outcome before retrying an RPC whose effects are uncertain; do not replay arbitrary tools.

Disconnecting a renderer does not cancel accepted recovery. Another authorized caller can read the operation. When persistence is healthy, operation identity and factual outcome are recorded through canonical host/runtime persistence. Automatic replay after restart is allowed only for a durably authorized operation whose current scope still matches; reconcile before resuming any destructive step.

## 8. Error propagation and containment

An operational error includes a stable code, origin, target identity/generation, stage, whether execution may continue, and available next actions. Preserve the initiating cause alongside cleanup failures. Public messages omit credentials and raw tool input; internal evidence is scoped and redacted.

1. The failing component reports to its owner immediately. The owner exposes the failure through a direct inspect/result path and the existing event mechanism where available.
2. That owner gates further work in the smallest unsafe scope. A failed session projection blocks its affected authoritative writes; a failed shared store can block all sessions using it. Healthy unrelated hosts remain available.
3. Cleanup begins independently. A failed projection must not prevent a provider error response or OS-level stop. A blocked producer must not suppress a stop error.
4. A waiter can receive a failed/uncertain result while the owner retains a cleanup obligation. The store is not closed underneath a possibly writing producer merely to make disposal return.
5. A timeout or exception in cleanup produces a readable unresolved obligation, not `stopped` or silent success. Reattempt/escalation remains available.

Do not put recovery behind the target's normal `whenIdle`, apply queue, event iterator, or projection mutex. Recovery uses narrow owner coordination to fence admission and observe/control resources. Any provider call is optional, bounded evidence or a cancellation attempt, not a prerequisite to local process containment.

If a synchronous native/database call blocks the daemon's entire event loop, an in-daemon deadline cannot run. The local desktop/launcher is then the independent owner: verify the daemon generation and scope, obtain authorization for its full impact, and use OS controls. A remote client cannot substitute local PID operations for a remote host's unavailable authority.

## 9. Persistence failure and reconciliation

The journal remains the transcript authority. Runtime recovery must not write a second transcript or manufacture replacement tool events.

When persistence fails:

- Stop admitting execution that requires the unavailable store.
- Keep inspection and authorized containment available from the existing host owner. Expose observed execution/cleanup facts and `persistence: unavailable` directly; an SSE write or journal append is not required to report the outage.
- Retain uncommitted lifecycle observations in the existing owner while it lives and retry canonical persistence after repair. Mark recovery receipts as volatile when they cannot be recorded. Never acknowledge them as durable.
- OS containment may finish while reconciliation remains incomplete. Exiting an emergency-stopped daemon may lose volatile observations; report that limitation before a requested emergency stop where possible.
- After restart, volatile operation IDs from the old generation are not reported as succeeded. Inspect/reconcile the target afresh. If no trustworthy terminal evidence can be recovered, preserve uncertainty and block conflicting execution.

Reconciliation algorithm:

1. Resolve the canonical session, turn, write generation, and process/provider ownership. Gate conflicting admission for that scope.
2. Inspect journal integrity, last successfully projected sequence, current execution, outstanding interactions, and cleanup obligations. Failure to query a source is unknown evidence, not an idle answer.
3. Replay valid entries strictly in order. Never checkpoint past a failed entry. For projections already skipped by an older bug, support an explicit bounded rebuild of the affected projection from the journal, preserving live ordering and avoiding duplicate publication.
4. If the journal already contains the terminal outcome, apply it. Otherwise use an authoritative provider outcome or verified owner-loss/termination fact through the canonical runtime lifecycle producer. Owner loss establishes interrupted/failed execution only where that owner exclusively controlled execution; it does not establish remote completion or successful tool output.
5. Retire old write authority before admitting replacement work. Commit terminalization and required lease changes through the existing runtime finalization owner. Late callbacks cannot cross that generation boundary.
6. Publish the committed state and its reconciliation position. Clients consume it using existing event/read mechanisms. Clear recovery restrictions only when the required execution, cleanup, and persistence postconditions hold.

Trigger bounded reconciliation on owner/process loss, failed authoritative projection, startup before admission, reconnect when a generation or stream gap invalidates the client's evidence, and an explicit user request. Coalesce work for the same target/generation in the existing owner. A renderer reconnect may request reconciliation but never become its owner. Passive reconciliation may inspect/replay automatically; it must not silently widen cancellation scope or resubmit execution.

If durable fencing cannot be advanced, in-memory gating protects only the current host. Do not admit a replacement writer or claim cross-process fencing. First repair durable authority or verify all old writers are gone and establish the new authority durably.

## 10. Harness and daemon escalation

| Execution shape | Independent containment | Proof required |
|---|---|---|
| Direct local process (for example Codex/Pi or a spawned ACP transport) | Host signals the verified owned process/group | Verified exit of resources that belong to the retired generation, including relevant descendants |
| SDK-managed local process with inferred PID | Supported SDK owner action; otherwise escalate to the verified containing owner | SDK-confirmed shutdown or verified containing-process ownership; inferred PID alone is insufficient |
| In-process runtime | Cooperative cancellation; if wedged, explicit containing-daemon escalation | A settled in-process owner or verified daemon-generation termination |
| Remote connection/provider | Remote cancellation/reconciliation through that authority | Provider/remote-host terminal evidence; local disconnect is not proof |

Maintain a recoverable record of retired generations with unresolved cleanup. Do not label them active model work, and do not erase them from diagnostics or shutdown impact. Managed processes with explicit handoff remain separate legitimate work.

Daemon normal exit keeps today's background-work policy. Drain reports blockers within its deadline. Explicit stop may escalate past broken activity counters after authorized scope selection; counters are accounting, not a veto over the machine owner's recovery authority.

Startup/adoption inspects daemon identity, build/protocol compatibility, recovery health, and outstanding ownership. A responding but degraded daemon remains inspectable and exposes recovery; it is not silently treated as healthy. Replacement must verify the old generation and its resources or report unresolved ownership. Host-wide interruption must never be hidden behind a session-only Stop action.

## 11. User-visible behavior

The session should explain the failed stage, what is known to be running, whether cleanup or persistence is blocked, and the next available action. Examples: “Cancellation did not respond. The harness may still be running”; “Execution stopped. Saving the interrupted state failed.”

Stop promptly shows its accepted operation, then a terminal command result or an actionable escalation. Repeated clicks join the in-progress operation; Retry after failure starts a checked attempt. Inspect/reconcile remain usable while the session composer is blocked.

The machine recovery view names the sessions and processes preventing drain. It shows transport responsiveness, execution health, and persistence health separately. Do not require users to interpret raw lease counts or search logs to discover the blocker.

## 12. Acceptance matrix

| Injected condition | Required observation and recovery result |
|---|---|
| Permission projection throws | Error visible promptly; valid provider response attempted; no invisible waiting request or checkpoint skip |
| Provider never answers interrupt | Cancellation reaches deadline; independent authorized containment available; no indefinite Stop |
| First cancellation attempt fails | Cause retained; explicit retry makes a valid new attempt after checking partial effects |
| Stop rejects while producer hangs | Stop failure visible before producer drains; retained cleanup ownership inspectable |
| Provider reports terminal but owned tool child survives | Terminal execution plus incomplete cleanup; generation not declared fully retired |
| TERM ignored / KILL denied / exit unverifiable | Escalation bounded; unresolved resources and failure visible; no false exit claim |
| Daemon event loop blocked | External local owner can inspect/stop verified generation without daemon HTTP cooperation |
| Database unavailable during cleanup | Containment works; persistence failure visible; replacement admission blocked until authority is established |
| Crash between OS exit and terminal commit | Startup reconciliation establishes facts or remains explicitly uncertain; no fabricated completion |
| Crash between process spawn and ownership acknowledgement | Launch protocol leaves the process contained or discoverable by its authoritative owner; no unowned child |
| Late event or delayed Stop from retired turn | Cannot mutate or stop the replacement turn |
| Shared harness scope changes after preview | Action refused with updated impact; no unintended session interruption |
| Lost client response / renderer relaunch | Same request ID returns operation; no duplicated cancellation or escalation |
| Healthy silent turn / approval waiting / managed dev server | Remains owned and inspectable; no age-based termination |
| Graceful drain with stranded owner | Deadline returns named blockers and authorized next actions |
| All owned work and cleanup resolved | Normal daemon idle exit occurs; no orphaned managed descendants |
| Remote host unavailable | Execution remains unknown; local UI never claims remote cleanup |

Tests must use actual production owners with injected faults, plus real provider/process-tree probes for supported execution shapes. Contract tests alone do not prove SDK cancellation or packaged daemon replacement. Record skipped platform/provider acceptance explicitly.

## 13. Proposed implementation slices after approval

1. Define shared result/evidence types and owner failure propagation; make known teardown failures visible without awaiting producer drain.
2. Implement generation-scoped recovery operations in existing runtime and host owners, with retry/deadline semantics and independent local containment.
3. Complete ordered journal reconciliation, durable authority checks, and startup recovery under storage failure.
4. Apply the contract to each harness capability; add machine drain/stop escalation and external local recovery where needed.
5. Expose the typed operations and readable failure state through existing clients, then prove the acceptance matrix through real entrypoints.

Each slice must remove superseded cleanup paths and retain one authority per responsibility. Production import changes require `bun run test:architecture-ratchets`; implementation also requires the relevant focused tests, typechecks, and real acceptance flows. No code changes or live recovery are authorized by approval to define this contract alone.
