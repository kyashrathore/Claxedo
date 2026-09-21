# Steering admission and transcript reconciliation

Status: **runtime-owned workspace queue execution and admission safety implemented; provider incorporation, transcript placement, and the full acceptance matrix remain incomplete.** The investigation below records the pre-change baseline. Existing unrelated working-tree edits are present. Provider credentials and live runs have not been exercised.

## Implementation checkpoint

Implemented in the current checkout:

- Queue controls persist an operation ID and dispatching state before dispatch. Concurrent Steer requests observe the same operation. HTTP waits up to one second, returning 202 pending without cancelling or resending the attempt. Acceptance settles success only after its state is saved.
- Explicit refusal keeps the queued input and its reason. A transport error is unknown. Dispatching, accepted, and unknown records survive restart without automatic reissue. Provider-held or uncertain rows reject local edit/cancel with 423; this also prevents the composer from interpreting an edit conflict as permission to submit a duplicate.
- Direct asynchronous steering also requires a durable queue record. Prompt identities are allocated before admission so recovery keeps the original ID.
- Runtime publication sends committed turn projections through the shared event hub, independent of the HTTP observer. The HTTP observer no longer republishes the stream. Cancellation retains the runtime subscription contract and publishes its idle status to the shared hub.
- Removed synthetic user transcript creation on adapter acceptance. Accepted inputs stay pending with an explicitly unconfirmed transcript position. The UI distinguishes dispatching, accepted, and unknown, and disables unsafe controls while preserving hover behavior.
- Codex sends `clientUserMessageId`. Claude explicitly refuses steering until a correlated provider acknowledgement is implemented. Cursor and ACP return unsupported. Pi acceptance still proves only queue ownership. OpenCode engine-queued input is treated as engine-owned, preventing a second execution by the outer queue.

### Queue identity and turn-fencing sub-slice

- Queue sequence numbers now use a durable per-session high-water mark. Removing the last queue row and restarting no longer reuses its control identity.
- `RuntimeStore.queuePrompt()` allocates the sequence and writes the row in an immediate transaction, and deduplicates `(sessionId, messageId)` inside that transaction. The store owns this invariant across store handles; identical text with distinct IDs remains distinct.
- A queue handle captures the operation it actually dispatched. A late handler cannot read and settle another owner's newer operation. HTTP observers also match the recorded operation ID.
- `AgentRuntime.turns.start()` captures a steering target's generation before asynchronous adapter resolution. If that turn ends or is replaced while resolution waits, steering returns `no_active_turn` without sending input to the replacement.

This identity/fencing sub-slice supplies the prerequisites for the runtime-owned delivery migration below.

Verification for this sub-slice:

- From `packages/agent-sdk-runtime`: `bun test src/runtime/turn-admission.test.ts` — 20 passed, including replacement of the target during adapter resolution.
- From `packages/workspace-runtime`: `bun test src/store.test.ts src/routes/session-queued-prompts.test.ts src/routes/session-prompt-delivery.test.ts` — 111 passed, including schema migration, restart, stale controls, cross-store identity deduplication, and late-owner acknowledgement.
- From `packages/workspace-runtime`: `bun run typecheck` — passed.
- From `packages/agent-sdk-runtime`: `bun run typecheck` — blocked by the concurrently created, untracked `src/harnesses/claude/permission-audit.scratch.test.ts:150`: its permission callback options omit required `requestId`. No file in this sub-slice reported a type error.
- Root `git diff --check` — passed. This sub-slice adds no production imports. Real-provider and live-UI acceptance remains unverified.

### No-backward-compatibility cleanup

- Removed old queue-table renames, additive delivery-column upgrades, and historical sequence backfill. Existing databases are not destructively cleared; old queue tables are no longer read or migrated.
- Operation `mode` is required in the store, owner port, and public queue types. Claims persist the explicit mode without defaulting to steering.
- Replaced migration coverage with canonical restart coverage, preserving pending payloads, explicit attempt mode, and sequence identity.
- From `packages/workspace-runtime`: `bun test src/session/delivery-owner.test.ts src/store.test.ts src/routes/session-prompt-delivery.test.ts` — **119 passed, 0 failed**. `bun run typecheck` passed. Root `git diff --check` passed. No production imports changed in this cleanup.
- App `bunx tsgo -b` failed in unrelated current edits: `session-context-metrics.ts:62,72` and `session-ui/src/components/message-part.tsx:1726,1727` use possibly undefined values as strings/indexes. No queue contract errors were reported.
- Verification entries below describe earlier checkpoints, including migration coverage subsequently removed by this requirement.

### Runtime-owned workspace delivery migration

Implemented `packages/workspace-runtime/src/session/delivery-owner.ts` as the single queue executor for the workspace runtime. The workspace layer owns requester authority, host activity, and shutdown; the owner uses `AgentRuntime.turns` for actual turn admission and provider execution. This keeps host policy out of the standalone SDK. Standalone SDK memory/SQLite stores have not acquired a queue API in this slice.

- Removed `routes/session-queued-prompts.ts`, its action-resolver map, and the idle/control race loop from `runRuntimePromptTurn()`. HTTP handlers enqueue or observe operations; they no longer execute queued work.
- Every explicit Queue submission is persisted before any execution attempt, including when the session is already idle. `prompt_async` returns `{delivery:"queue"}` for that durable admission; synchronous `/message` with explicit Queue returns 202 with delivery and message identity. Immediate prompts without a delivery request retain their existing reply behavior. Client types and decoding cover empty immediate replies, durable admissions, and pending steering receipts.
- Canonical persistence uses `runtime_delivery` and `runtime_delivery_sequence`. Per the no-backward-compatibility requirement, there is no old-table migration, old-column upgrade, or sequence backfill. New schemas declare all delivery columns directly; canonical rows and sequence identities survive restart.
- Persisted holds. Claiming an ordinary start checks hold state and earlier pending/uncertain starts atomically. A second owner cannot overtake the first input while its execution is being prepared. Dispatch rereads the claimed row so a concurrent edit cannot be replaced by a stale local copy.
- Normal starts and steering both claim an operation before dispatch. Only a matching confirmed normal-start claim can remove its row. A transport exception or missing admission result remains unknown; restart never reissues dispatching/accepted/unknown records. Inputs submitted directly to the store without a message ID receive a stable ID in the claim before provider dispatch.
- Idle events wake the owner. Cancellation, replacement, and release update the authoritative store directly. Shutdown stops new dispatches, abandons idle handoffs, and awaits in-flight attempts before closing the store.
- Recovered managed work reacquires turn authority with the original actor and saved workspace authority, carries the lease fence into execution, and releases it when execution finishes. Credentials are not persisted. Managed inputs missing authority are refused rather than executed as local input.
- Deferred completions retain host activity, document flushing, and child completion handling. An admission-hook exception releases the SDK's turn claim, and the lease is checked again after asynchronous adapter resolution.

Verification for the migration:

- From `packages/workspace-runtime`: `bun test src/session/delivery-owner.test.ts src/session/service.test.ts src/routes/session-prompt-delivery.test.ts src/routes/session-core.test.ts src/routes/session.test.ts src/store.test.ts src/workspace/runtime-lifecycle.test.ts src/workspace/runtime-event-observer.test.ts src/client/request.test.ts` — **298 passed**.
- From `packages/agent-sdk-runtime`: `bun test src/runtime src/harnesses/shared/turn-steering.test.ts` — **103 passed**.
- Final `bun run typecheck` in workspace-runtime passed. Agent-sdk-runtime passed earlier; its final rerun is blocked by concurrent `src/harnesses/acp/elicitation-wire.test.ts:47,61,67` changes calling APIs with incompatible arguments. App TypeScript-only `bunx tsgo -b` passed. The ACP test was not modified by this slice.
- Root `bun run test:architecture-ratchets` — failed existing closure ceilings: app-local 1098 vs 1097 and desktop-renderer-unsigned 1141 vs 1140. Dependency walks find no workspace-runtime modules in either closure. Existing paths include `app/entry/local.tsx → ... → directory-scope.tsx → claxedo-tool-href.ts` and `renderer/local.tsx → shell.tsx → external-link.ts`. No ceilings or baselines were changed.
- Root `bun run typecheck` was also attempted and stopped on concurrent `agent-event-runtime/src/harnesses/tool-attachments.test.ts:41,48` changes passing a removed `root` option. The focused package checks above provide this slice's type evidence.
- `bun test src/client/request.test.ts src/client/session-route-inventory.guard.test.ts` exposed a separate route-inventory mismatch: the attachment route exists in the inventory but has no corresponding client member. Request tests passed; the inventory failure is not caused or repaired by this slice.
- Root `git diff --check` passed. Repository searches find no remaining `queuedAction`, `onQueuedWaitEnd`, old queue host factory, or old queue executor imports. No old SQL table names remain in the delivery implementation or its tests.

Live-provider and live-UI acceptance is still unverified. The durable owner does not invent incorporation receipts or authoritative transcript placement.

Still required (implementation owner: the runtime/adapters/UI work in this proposal):

1. The workspace runtime executor migration is complete as described above. Extending the standalone `AgentRuntime` facade and its memory/SQLite stores with the same delivery API remains outside this workspace slice; it must reuse this owner rather than introduce a second executor.
2. Persist provider receipts, execution identities, revisions, and incorporation evidence atomically with transcript placement. Wire provider replay/reconciliation, including incorporation before acknowledgement and late evidence after execution completion. Current pending states do not yet reconcile themselves from provider evidence.
3. Preserve native assistant item boundaries, normalize authoritative ordering, and use one revision-aware reconciler for live view, snapshots, pagination, and reconnect. **Exact X → Y → S placement is not implemented.** Accepted rows can remain pending until this work is completed.
4. Complete Claude receipt handling and Pi correlation support, Codex user-item ingestion/order verification, and OpenCode inbox event ingestion. No provider-specific live acceptance claim has been made.
5. Run the full failure/recovery matrix through real providers and the live UI. Automated transport/runtime fixtures are not live provider proof.

Verification checkpoint:

- Agent SDK: `bun test src/runtime src/harnesses/codex/protocol.test.ts src/harnesses/codex/steering.test.ts` — 105 passed.
- Workspace runtime: `bun test src/routes/session-prompt-delivery.test.ts src/routes/session-queued-prompts.test.ts src/routes/session-core.test.ts src/routes/session.test.ts src/opencode/harness-adapter.test.ts` — 181 passed, including bounded timeout and acceptance after original turn completion.
- Adapter contracts: `bun test src/harnesses/shared/turn-steering.test.ts src/harnesses/pi/driver.test.ts` — 15 passed.
- App: `bun test --conditions=browser --preload ./happydom.ts src/platform/runtime/agent/agent-runtime-client.test.ts src/features/session/composer/ui/submit-queued-edit.test.ts` — 38 passed.
- `bun run typecheck` in agent-sdk-runtime — passed. Workspace-runtime passed earlier in this run; the final rerun encountered a concurrent, unrelated edit in `src/store.test.ts:2919` calling `messagePartDelta` with five arguments instead of its object argument. That test was not edited by this slice.
- Root `bun run test:architecture-ratchets` — failed: unsigned desktop closure 1141 modules, recorded ceiling 1140. This slice adds no source-module dependency to that browser closure; the checkout already contained the new `external-link.ts` renderer module. No ceiling was raised.
- App `bun run typecheck` — blocked in architecture checks by route-bridge/message-timeline/session-controller size violations and existing debt-baseline violations. No baselines were changed. The TypeScript-only `bunx tsgo -b` passed separately.


## Decision

Treat a submitted message, its delivery attempt, the provider execution, and its transcript position as separate identities. A successful Steer response requires provider acceptance. Transcript placement requires evidence of incorporation into the provider conversation; acceptance alone is insufficient.

Keep the intentional product behavior: submitting while busy queues, and queued-message controls remain hover-revealed. Change the authoritative admission and ordering contracts, not those choices.

## Baseline flow and defects

1. `workspace-runtime` persists a waiting prompt in `queued_prompt` in its `state.db`. `createQueuedPromptHost()` also registers an in-memory resolver for controls. Recovery reissues persisted rows.
2. Clicking Steer invokes `QueuedPromptHost.control()`. It resolves the waiter and returns a boolean; the HTTP endpoint returns `{ok:true}` before the harness has decided.
3. `runRuntimePromptTurn()` asks `runtime.turns.start({delivery:"steer"})`. `deliverToBusySession()` calls `adapter.steerTurn()`, reduces its result to `.ok`, and converts every negative result to `queue` without its reason.
4. On success, `steeredUserMessage()` creates the user transcript envelope locally, after the adapter promise resolves. The queue row is removed. It is not placed using a provider admission anchor.
5. The Steer request assumes the running request will forward these events. If that request has already ended, the successful message remains stored but its live events are lost.
6. The UI appends a new message when its event arrives and hides the queue bubble by matching message ID. Existing rows keep their position on updates. Snapshot merging can reorder rows, but cannot recover provider ordering that the producer discarded.

Two controlled probes reproduced these defects against the implementation:

- `bun test /tmp/steer-race-probe.test.ts`: real `createAgentRuntime()` and `runRuntimePromptTurn()`, controlled adapter acceptance after original turn completion. Persisted IDs included `msg_steer`; forwarded message IDs did not. 1 pass, 2 assertions confirming the defect.
- `bun test /tmp/steer-ack-probe.test.ts`: actual queue routes/store with a delayed runtime double. First click returned 200 while undecided; a second returned 409 claiming the message was admitted/removed while it remained queued. 1 pass, 8 assertions confirming the defect.
- Existing `bun test src/routes/session-prompt-delivery.test.ts` from `packages/workspace-runtime`: 15 passed in the earlier investigation; those tests do not exercise either delayed-ack scenario.

The temporary probes document this session's evidence; turn them into durable regression tests during implementation.

## Baseline harness matrix

The registry contains five native harnesses. Configured ACP connections are a separate access path, including Claude ACP, Cursor ACP, and arbitrary validated connection IDs. A native capability must not be inherited by its ACP counterpart.

| Harness/access | Current Steer transport | What success currently proves | Provider identity / ordering evidence | Required adapter work |
| --- | --- | --- | --- | --- |
| Codex native | `turn/steer` with `expectedTurnId` | App-server RPC accepted the request; response type supplies `turnId`, not a transcript position | Checked-in protocol supports `clientUserMessageId`; user items carry `clientId` and native item IDs. Current request omits the client ID; adapter discards user `item/started` and `item/completed` events | Pass a stable client correlation ID, retain native turn/item mappings, normalize authoritative user-item insertion events. Verify precise item-event ordering and replay with the pinned server before claiming exact incorporation |
| Claude native | Push `SDKUserMessage` into the running query's async input iterator | Only local enqueue: `createClaudeTurnInput().steer()` returns after `pending.push`, before the SDK necessarily consumes it | Installed SDK 0.3.220 supports optional user `uuid` and replayed user messages. Its declarations describe async-message cancellation/interrupt receipts and lifecycle behavior; exact usable receipt API/event semantics are not yet verified. Current adapter's user branch processes tool results, not submitted-user incorporation | Stamp supported UUIDs, correlate provider acknowledgements/replays, distinguish local enqueue from provider acceptance and actual incorporation. Verify pinned CLI capabilities. Do not promote local iterator consumption to provider acknowledgement |
| Pi native | RPC `steer` with message and images | Provider steering queue accepted input, not incorporation | Installed pinned Pi 0.85.1 RPC calls `session.steer`; `_queueSteer()` enqueues a user message. User `message_start` marks delivery, but the current RPC input does not carry a client message identity. Current adapter ignores user starts | Extend the authoritative Pi bridge/upstream protocol to carry client identity through queue, delivery events, and persisted transcript. Project user starts and provider order. Do not match repeated messages by text or timestamps |
| OpenCode native | Embedded `sessions.prompt`, carrying the user ID and `delivery:"steer"` | Engine recorded steering delivery intent in its inbox | Adapter passes the user ID. Repository contract probe identifies `session.inbox.delivered` and matching inbox/message identity, but that probe is not a live verification in this investigation. Current `projectTurnEvent()` ignores inbox delivery | Verify and consume engine inbox accepted/delivered/rejected state and ordered message identity. Keep only one executor: an engine-held inbox item must never also be independently replayed by the outer queue |
| Cursor native | No `steer` handler registered on the active run | No steering acknowledgement exists in this adapter; shared code declines, then runtime queues | `agent.send()` creates a run with ID and event stream; current integration has no mid-run input contract | Report steering unsupported for this access path. Keep queued submission and normal next-turn start. Add steering only when a verified provider API supplies the required contract |
| ACP connections (Claude ACP, Cursor ACP, custom) | No `steerTurn` implementation in the ACP adapter | No steering acknowledgement exists in this adapter; runtime queues | Prompt stream and session updates exist, but no negotiated mid-turn steering/receipt/order extension is implemented | Gate on negotiated connection capabilities. Unsupported is explicit. Implement a provider-specific extension only with stable correlation and replay semantics; do not cancel/restart to simulate steering |

These are statements about integrations in this checkout, not claims that Cursor or every ACP provider can never support steering.

### Source map

- Registry: `packages/agent-runtime-contract/src/harnesses.ts`.
- Queue persistence/control: `packages/workspace-runtime/src/store.ts`, `session/delivery-owner.ts`, `routes/session-core.ts`. The baseline resolver host `routes/session-queued-prompts.ts` has been removed.
- Runtime admission/forwarding: `packages/agent-sdk-runtime/src/runtime/turn-admission.ts`, `packages/workspace-runtime/src/session/service.ts`.
- Codex: `packages/agent-sdk-runtime/src/harnesses/codex/protocol.ts`; `packages/agent-event-runtime/src/harnesses/codex/adapter.ts`; checked-in `protocol/v2/TurnSteerParams.ts`, `TurnSteerResponse.ts`, `ThreadItem.ts`.
- Claude: `packages/agent-sdk-runtime/src/harnesses/claude/turn-input.ts`, `driver.ts`; `packages/agent-event-runtime/src/harnesses/claude/adapter.ts`; installed `@anthropic-ai/claude-agent-sdk/sdk.d.ts`.
- Pi: `packages/agent-sdk-runtime/src/harnesses/pi/driver.ts`, `executable.ts`; `packages/agent-event-runtime/src/harnesses/pi/adapter.ts`; installed Pi 0.85.1 `dist/modes/rpc/rpc-mode.js`, `dist/core/agent-session.js`.
- OpenCode: `packages/workspace-runtime/src/opencode/harness-adapter.ts`, `session-port.ts`; `packages/workspace-runtime/contract/opencode/gate-inbox-identity.mjs` (probe source, not a fresh passing result).
- Cursor: `packages/agent-sdk-runtime/src/harnesses/cursor/driver.ts`.
- ACP: `packages/agent-sdk-runtime/src/harnesses/acp/index.ts`, `turn-runner.ts`.
- UI: `packages/claxedo-app/src/features/session/conversation/agent-conversation.ts`, `ui/message-timeline.tsx`, `queue/queued-messages-controller.ts`.

## Proposed ownership and contracts

### A. One durable session delivery owner

Move waiting-input execution from detached HTTP requests and resolver maps into the agent runtime's session delivery owner. Its durable store should hold delivery state alongside the existing canonical transcript/event journal so incorporation, transcript identity/order updates, and their replay events can commit atomically. Reuse the existing runtime store implementations; do not add an independent event store.

`workspace-runtime` retains routing, authorization, placement, and runtime lifecycle. Its queue endpoints become views/commands over the runtime owner. Use only the canonical delivery schema and remove the old queue executor and duplicate table ownership. Backward compatibility with the old queue schema is explicitly out of scope.

Provider inboxes remain provider-owned. Our record tracks whether ownership has transferred; it must not schedule a second execution of an input already held by the provider.

The runtime owner records a delivery operation before external dispatch and runs under the session's existing ownership/fencing rules. A session deletion or owner change invalidates stale local work. Cross-process fencing alone does not revoke an already-issued external RPC; late results still need reconciliation against the recorded attempt.

### B. Separate message state from attempt outcome

Proposed message states:

`queued -> dispatching -> accepted -> incorporated`

- `queued`: held by our runtime, editable/cancellable under current product policy.
- `dispatching`: a particular attempt is in flight. Repeated HTTP calls attach to that attempt; they do not send twice.
- `accepted`: provider acknowledgement is persisted. It may still be waiting in the provider's own inbox; never present this as consumed.
- `incorporated`: authoritative provider evidence places the input in the conversation. Publish its transcript placement and retire its pending presentation in the same state revision.
- `cancelled`: cancellation confirmed by the current owner, not inferred from losing a connection.

Each attempt separately records success, explicit rejection (with reason), or an unknown outcome. A rejected attempt leaves its message queued and visible. A transport failure after dispatch is unknown, not a rejection: do not automatically resend. Preserve enough state to reconcile after reconnect.

Persist: stable message ID, operation/attempt ID, session ID, target execution identity, provider correlation ID, current content revision, state revision, outcome/reason, provider receipt identity, and confirmed transcript placement when available. Provider-generated UUIDs may require a persisted mapping rather than copying our ID format.

The existing `SteerResult` boolean union is insufficient. Its replacement must express provider-accepted, explicitly-rejected, unsupported, and unknown, and retain provider identity/evidence. Delivery/incorporation observations are separate ordered events. Events may establish incorporation before an RPC response arrives; state transitions must be monotonic and idempotent.

### C. HTTP success follows provider acceptance

The Steer endpoint observes the durable operation, not a resolver's boolean. Return successful Steer acknowledgement only after provider acceptance has been persisted. Return an explicit rejection/unsupported result with its reason. A bounded HTTP wait may return a pending operation reference (for example 202); that is not successful steering, and the UI continues pending via the operation stream/read API. A disconnect does not cancel or restart the operation.

If the expected turn ends before dispatch, return a target-ended result and preserve the ordinary queued-message policy. If the provider confirms incorporation into a different execution, retain that actual execution identity and show what happened. Do not silently describe a newly started turn as steering the old one.

### D. Publish from durable runtime events, independent of requests

The existing runtime event journal is the source for client delivery. Route committed session events through the host's established aggregate event stream independent of the request that started a turn. Reuse that stream; do not add one browser SSE connection per workspace/session.

Turn completion ends that execution's work, not the publication owner for its session. A late accepted input and its incorporation event must remain publishable after the original turn request ends. Subscribers resume by cursor; reconnect reads a snapshot with a consistent cursor and then later events. Deduplicate replay by event identity/revision. Audit and remove request-level forwarding when this owner takes over so events are not published twice.

### E. Identity and ordering are different contracts

Maintain two orders:

1. Journal revision/cursor: orders our committed state changes and permits replay.
2. Canonical transcript placement: provider-backed position of user entries and assistant content segments.

A journal receive sequence, click timestamp, or receipt timestamp is not a provider transcript position. Adapters must produce a verified native ordering token, predecessor relation, or authoritative ordered snapshot. The normalizer persists that evidence and assigns canonical display placement. Late authoritative evidence may revise placement without changing message identity.

Preserve provider item/content boundaries. A steering input can be incorporated between two assistant items inside the same execution. Do not represent the entire execution as one indivisible assistant row or reparent all its output to the steered input. Tool output that completes later remains attached to its existing tool call; chronological receipt alone cannot move it into a new message.

Where a protocol omits stable correlation or ordering, fix that producer/bridge or explicitly report placement as unconfirmed. Do not synthesize a user insertion event, match text, split a stream at the click timestamp, or invent an exact position. Provider protocols that batch multiple inputs may need a canonical mapping from several message IDs to one provider item, preserving their provenance.

### F. UI reconciliation

Use the same stable message ID for pending presentation and transcript membership, with operation state and confirmed placement supplied by the runtime. Reduce snapshots and live events through one revision-aware reconciler.

While dispatching, keep the pending row and disable duplicate controls. After provider acceptance but before placement is known, show accepted/pending-incorporation status without claiming a position. Once incorporation is committed, move the existing keyed presentation to its canonical location and remove the pending representation atomically.

Example: click after X; provider emits Y, then incorporates S. Render `X -> Y -> S -> subsequent content`. If S actually belongs before already-rendered Y, authoritative placement moves S there. Preserve scroll anchoring, selection, attachments, and expansion state while moving. Existing hover behavior remains unchanged.

Snapshots, reload, pagination, and live events must agree on these positions. An older snapshot cannot undo newer placement. The message being present by ID alone is insufficient evidence that all placement/content data has arrived.

## Acceptance matrix

Run common cases against every adapter that advertises steering; verify explicit unsupported behavior for Cursor/ACP until implemented. Provider-specific tests establish the exact acknowledgement and correlation guarantees before enabling those capabilities.

| Case | Required runtime result | Required UI result |
| --- | --- | --- |
| Normal steer during work | Persist provider acceptance, then incorporation and placement | Pending until acceptance; one message at confirmed position |
| X visible at click; Y emitted before incorporation | Preserve provider placement after Y | X, Y, S; no guessed placement after X |
| Incorporation event arrives before RPC response | Incorporation proves acceptance; late response is idempotent | No regression back to pending |
| Original turn finishes before acknowledgement | Session publication survives; reconcile receipt and actual target | Message never disappears because its request bridge closed |
| Provider rejects or cannot steer | Preserve actual reason; retain queued message | Action settles with reason, no claimed delivery |
| Double click / two clients | Same operation/revision or explicit in-progress conflict | No duplicate dispatch and no false already-removed error |
| Two identical prompts / attachment-only prompts | Correlate by identities, never contents | Two distinct correctly ordered messages |
| Provider batches several inputs | Record exact provider grouping and mappings | Preserve each submitted input's identity without inventing intermediate boundaries |
| Network timeout after possible acceptance | Mark outcome unknown; reconcile before retry | No false failure/success and no automatic duplicate |
| Crash after provider acceptance, before local receipt commit | Query/replay by provider identity; resend only with proven idempotency | Restore accurate pending/accepted state |
| Reconnect / replay / stale snapshot / history pagination | Cursor-consistent snapshots and idempotent ordering updates | Same order and membership as before disconnect |
| Edit/cancel while dispatching or provider-held | Revision/ownership check; provider cancellation needs receipt | Never claim an accepted input was locally edited or cancelled |
| Stop races with steer | Reconcile which execution/input was stopped or remains provider-held | Do not imply stopping one turn cleared every pending input |
| Runtime ownership changes / session removed | Fence local mutations and reconcile outstanding external effects | No cross-session delivery or stale resurrection |
| Queue recovery after restart | Recover original IDs/config/actor; separate unsent from uncertain/provider-held | No silent resubmission of an already accepted input |
| OpenCode returns engine-queued | Track existing engine inbox ownership and identity | One pending message, one eventual execution |

Exactly-once external execution cannot be promised where the provider offers neither idempotent submission nor a query/replayable receipt. Those capability gaps must remain explicit; a local database transaction cannot close the external send/ack crash window.

## Implementation slices

1. Preserve the reproduced races as package-local regression tests. Add harness contract probes for acceptance vs incorporation, identity, ordering, rejection, and cancellation. Verify Claude receipt semantics, Codex user-item ordering, Pi identity extension, and OpenCode inbox ownership before finalizing adapter claims.
2. Add the typed delivery/placement contracts and durable runtime owner; use the canonical queue schema and remove request-owned execution. Preserve public message IDs and author/config contracts.
3. Normalize each supported adapter's real evidence. Disable unsupported steering explicitly rather than substituting queue success. Land provider/bridge changes for missing identities.
4. Connect session publication to committed runtime events independent of prompt requests. Verify reconnect/cursor behavior and remove duplicated forwarding.
5. Switch Steer HTTP and UI to operation outcome plus canonical placement. Reconcile snapshots/live updates with revisions, preserve scroll state, and retain intentional queue/hover UX.
6. Verify the case matrix through real harness entrypoints, then remove synthetic steer transcript creation, discarded refusal paths, old resolver controls, and redundant persistence. Run focused tests/typechecks and `bun run test:architecture-ratchets` for production import changes.

Cost: this crosses queue persistence, adapter contracts, event publication, and transcript structure; an endpoint-only patch fixes early feedback but cannot establish exact provider ordering or crash-safe recovery. Benefit: one truthful delivery state and one authoritative transcript order across live view, reload, and every supported access path.
