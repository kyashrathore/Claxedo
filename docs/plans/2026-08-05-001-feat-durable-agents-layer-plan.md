# Durable Agents — an agent layer above WorkGraph

Date: 2026-08-05. Status: active implementation plan.

Extracts the agent-turn primitives WorkGraph already runs (master, intake
planning) into a `@claxedo/agents` package whose **contract is the deliverable**:
an Agent is a row, a Turn is a claimed, receipted unit of work, and the work
ledger stays sovereign over what an agent is allowed to change.

One sentence carries most of the design; everything below follows from it:

> **The lane wake is the turn's scheduler, not the turn's lease.** A turn is a
> chain of short claim-poll-close fires on one serialized lane — never one long
> hold — and every trigger is a durable inbox row plus a lane dirty-flag, never
> a payload riding a wake.

Extends [`2026-07-18-004`](./2026-07-18-004-feat-workgraph-execution-shape-intake-trust-plan.md)
and [`2026-07-18-005`](./2026-07-18-005-feat-workgraph-v2-implementation-plan.md).
Nothing here rebuilds WorkGraph; every addition attaches to a named existing seam
(see §10, "Verified architecture facts").

---

## 1. Requirements

Each requirement names the code that makes it necessary.

**R1. Agents are data, not deploys.** A new agent today requires a new compiled
sink: the hosted wakes registry is a static composition-time map of three kinds
(`workgraph_settle`, `workgraph_control`, `workgraph_master` at
`packages/claxedo-server/src/hosts/wakes/hosted-wakes.ts:207-257`). Creating an
agent must be an INSERT; one generic `agent_turn` sink dispatches by `agentId`
from storage.

**R2. One turn loop for all long-lived agents.** WorkGraph runs two agent-shaped
loops today and they are the same object wearing different clothes:

| | intake planner | master |
|---|---|---|
| trigger | webhook / `source_plan` due job | `mailbox`, `task_settled`, daily `06:00Z` |
| transcript | fresh per candidate | durable session + `historyAfter` cursor |
| serialization | none today (the hosted `source_plan` drain takes 10 jobs and `Promise.all`s them, `convex/workgraphBackground.ts:185-200`) | one-turn-per-stream lane (`run-operation.ts:42-53`) |
| output | a proposal (needs a click) | actions + receipts |
| runner | `convex/workgraphBackground.ts:185+` (hosted, inline prompt at `:300+`); `adapters/sqlite/source-planning-runtime.ts` (self-host) | `claimMasterTurn` flow (`hosted/runtime.ts:800-985`; `local/master-runtime.ts`) |

Both reduce to *(trigger) × (transcript mode) × (lane key) × (prompt) ×
(tool grant) × (approval gate)*. This plan takes the reduction one level out:
not a flow stream, just an Agent, with WorkGraph as the first consumer rather
than the container. The reduction is a hypothesis phase 3 is designed to
falsify (§12), not an assumption.

**R3. Turns serialize per subject.** The safety property is one active turn per
*subject* (stream, source view), not per agent row: two agents on one subject
running concurrently is the hazard the single lane-key constructor at
`run-operation.ts:42-53` exists to prevent. Enforcement is therefore doubled:
`define()` rejects a duplicate `(org, owner, subject)` (unique index per store,
§7), and the lane key derives from the subject (invariant 2, §6).

**R4. Every turn knows why it woke.** Today the wake trigger is stamped on the
receipt (`hosted/runtime.ts:963`) and then dropped — `buildMasterPrompt` has no
reason parameter (`master-prompt.ts:17-25`), so the master infers its reason
from a mailbox diff. The wakes primitive already carries the field
(`intent: Json`, `types.ts:25-27`; serialized `intentJson` on the row,
`types.ts:50`; `schedule_followup` documents it as "What the resumed turn
should do", `wakes/src/tools.ts:70-72`). The reason is a required prompt input
in the new layer, and it survives coalescing because it lives in the inbox, not
in the wake (§5.5).

**R5. Every terminal turn writes a runtime-attested receipt.** The audit shape
exists as `RecordMasterAuditCommandSchema` (`contracts/commands.ts:297-313`).
Two honesty gaps in today's receipts must close, not propagate: `toolCalls` is
hardcoded `[]` on the local path (`local/master-runtime.ts:184`), and
`citedCharterClause` is not cited by anyone — it is `charterClause(text)`, the
first non-blank charter line, synthesized by the runtime (`master-prompt.ts:9-12`,
`local/master-runtime.ts:293-299`). Every receipt field is populated by the
runtime from the session event log and store state — never asserted by the
agent (§5.7).

**R6. "Runs indefinitely" needs brakes that exist on every deployment.** Budget
enforcement exists at the wake create path (`budgets.ts:30-47`) but the hosted
composition disables three of four with `MAX_SAFE_INTEGER`
(`hosted-wakes.ts:203-205`). There is no wall-clock bound on a hung turn (the
master polls at 1s until a terminal event, `hosted/runtime.ts:948-950`). There
is no failure discrimination: three unrelated transient errors permanently halt
a healthy master (`failureCount >= 3`, `workgraphRuntime.ts:627-652`), while a
repeating poison pill is indistinguishable from a transient blip. And an
agent's own output must never retrigger it — the existing loop-breaker filters
the master's own mailbox messages by actor id (`hosted/runtime.ts:996-1000`).

**R7. The profile is per-turn, and harness switches must not corrupt.**
Per-turn profiles are not aspirational: models deprecate mid-chain, and a
routine sweep should run a cheaper model than a crisis turn (§5.5(d)). A
transcript is bound to the harness that produced it — resuming a claude
transcript under codex is silent corruption — so resume is conditional, and the
failure mode of every boundary case (lost session, renumbered history,
incompatible profile) is *deliberate fresh start with a recorded reason*, never
a silent resume.

**R8. Tools must reach harnesses we don't control.** Closures cross in exactly
one place (pi central's `extraTools`, C4). Everywhere else, tools cross as
descriptions and calls come back as data. The layer owes each harness class a
projection (§5.8).

**R9. Tenancy is a column pair.** An agent belongs to `(orgId, ownerUserId)`.
Enforcement stays where it already works (`ensureOwnerOrg`, private-by-default
sessions per `2026-08-01-002`). A transcript is never shared across users.

**R10. The ledger stays sovereign.** Work item admission is decided in the
store, in both backends (`adapters/sqlite/store.ts:2374-2382`,
`convex/workgraphCommands.ts:1164-1172`). The agents layer never gains approval
authority over work; **agents propose, the ledger disposes.**

**R11. Every action is inspectable.** The owner can read any turn's prompt,
session transcript, and receipt. Agent sessions are real sessions — recorded,
tagged, reachable — not hidden plumbing (§5.10).

**R12. An agent is operable.** There is a kill switch (`setEnabled`), pending
work is cancellable, schedules are agent data (wakes are derived, so disable
tears them down and enable rebuilds them), and storage is bounded (GC is
designed, not asserted). An unattended system without these is not shippable.

Non-functional: strangler/additive (the master keeps running throughout);
dual-backend parity (SQLite + Convex implement one `AgentStore` port behind a
conformance suite, following `packages/workgraph/src/conformance/`); zero new
external services for self-host.

## 2. Constraints

**C1. Hosted is Cloudflare Workers.** The `WakeLane` Durable Object is "the
platform's only legal 'run soon, serialized per key' primitive (in-request
work, cross-request promise sharing, and self-fetch all fail on Workers)"
(`deployments/hosted-workerd/wake-lane.cf.ts:1-4`). A turn cannot be one long
hold anywhere, and on Workers it cannot be one at all — hence the poll-chain
turn model (§5.6).

**C2. Two stores, create-only schema.** Self-host is SQLite; hosted is Convex;
Postgres has no adapter. WorkGraph schema is create-only, no ALTER migrations
([[reference_workgraph_schema_create_only]]) — new tables land as `CREATE
TABLE` plus a fresh DB path. Convex has no unique constraints: uniqueness is
check-then-insert inside one mutation (the `createLaneWakeIfIdle` pattern,
`convex/wakes.ts:173-181`); SQLite uses real UNIQUE constraints (the pattern to
copy: `wg_v2_due_jobs` `UNIQUE(organization_id, owner_user_id, job_type,
subject_id)`, `adapters/sqlite/schema.ts:652`).

**C3. One scheduler — `@claxedo/wakes` — and sinks cannot be added to a live
engine.** `createWakes` takes `sinks` at construction; the `Wakes` interface
(`wakes.ts:80-106`) has no registration method. The agents layer therefore
exports its sinks for composition to register (§5.1). Sinks run at-least-once
(`types.ts:80-84`). Lanes bind **time-triggered claims only**
(`sqlite-store.ts:157-186`); `deliverEvent` and approval resolution fire
inline, in the caller's process, outside the lane — so event/approval wakes
must never carry the turn sink (§5.1). Wake claims hold a ~30s lease
(`leaseMs`); a turn runs minutes — the turn is a chain of fires (§5.6).

**C4. Closures (almost) never cross to the harness.** Exactly one integration
passes real closures: pi central's model backend accepts `extraTools:
PiAgentTool[]` (`session/runtime.ts:300-314,825-856`). Our own opencode host in
workspace-runtime is already on the data side: dynamic per-session *descriptors*
(`{name, description, inputSchema, callbackUrl}` — `workspace/host.ts:70-76`),
execution over a nonce-bound loopback callback. External harnesses
(cursor/codex/claude) accept a tool surface exactly two ways: **MCP server
configuration, loaded at harness startup**, or **prompt text**. Anthropic
`input_schema` must be a flat object schema — `oneOf`/`anyOf`/`allOf` fail the
whole turn with an opaque `tools.N.custom.input_schema…` error; this repo has
been burned by it.

**C5. Trigger payloads are an injection surface.** A durable agent woken by a
public webhook has attacker-influenced text arriving in the same assembly step
as its standing instructions. The fence pattern exists (`trust:
"untrusted-data-only"`, `domain/stream-notes.ts:22-28`) and is a *mitigation*,
not a boundary — the doc says "fenced", never "closed".

**C6. Permission modes are harness-owned and must be clamped server-side.**
Per [[project_permission_modes_across_harnesses]]: one Claxedo mode (Auto) plus
harness-advertised modes; an unexpressible mode surfaces `unsupported` (the
reporting primitive exists: `AgentPermissionModeState.unsupported`,
`agent-sdk-runtime/src/adapter-contract.ts:140-161`); `bypassPermissions`
requires `allowDangerouslySkipPermissions: true` (sent only under that mode,
`harnesses/claude/driver.ts:159-164`). A caller-picked permissive mode is a
privilege escalation unless the server clamps against a per-harness allowlist
— the highest-risk field on the record.

**C7. Transcripts are harness-bound and harness-versioned.** History is paged
from the harness's own session (`hostedSessionHistory`,
`hosted/runtime.ts:1709-1721`). A harness switch forfeits continuity; a harness
*upgrade* that renumbers events is the same hazard in miniature (§5.6 resume
rule).

**C8. The central-harness path is self-host-only today.** `projectionStore` and
`durableSessionLog` throw on the hosted Worker (`hosted-services.ts:328-336,
442-443`; `central-runtime.ts:71`). Convex adapters are a prerequisite plan,
out of scope here.

**C9. Self-host ships zero external services** (rules out substrates whose
durability lives in a console product; T8).

**C10. Approval resolution is human-only and fail-closed.** Wakes
`resolve(token, answer, resolver)` checks `authorize(resolver, workspaceId)`,
whose default is `() => true` (`wakes.ts:121,319-324`); approval tokens are
stored indexed in plaintext (`convex/schema.ts:1475,1486`;
`sqlite-store.ts:90`). The agents layer requires an explicit `authorize` (no
default), tokens are stored hashed (phase 0), and an agent actor can never
resolve an approval (§8).

## 3. Vocabulary

Names were chosen against the existing codebase; collisions found by survey are
listed with the resolution.

| term | meaning here | collision check |
|---|---|---|
| `Agent` | the durable row | CLEAR |
| `AgentTurn` (record), `agent_turn` (wake kind) | one claimed, receipted unit of agent work | "turn" is saturated (`SessionTurnOutcome`, `turns.start/abort`, `SpawnTurn`, `session_turn`) — but the master domain already says "master turn" and stores `turnId` (`contracts/records.ts:89`; "one-turn-per-stream", `run-operation.ts:42`). `AgentTurn` extends that vocabulary deliberately; schemas use the qualified name |
| `TurnReceipt` | the runtime-attested audit record, 1:1 with a turn | near-miss: wake effect receipts (`WakeStore.getReceipt`), `LandingReceipt`, `IntakeReceiptStore`. Qualified name avoids all three; `outcome` field matches `RecordMasterAuditCommandSchema` |
| `AgentInbox` (rows) | durable trigger payloads, one row per notify/schedule-fire/approval-resolution | generalizes `wg_v2_master_mailbox` (`local/master-runtime.ts:188-193`) |
| `TurnReason` | discriminated union of why a turn woke | CLEAR |
| `transcript: "resume" \| "fresh"` | Agent field: transcript continuity mode | renamed from `session` — the field controls the transcript, and `session` already means the session itself (`lastSession.sessionId`) |
| `charter {text, hash}` | standing instructions; reuses `StreamCharterSchema` verbatim (`contracts/charter.ts:7-10`) | intentional reuse — same concept, same schema |
| `profile` | per-turn execution profile: `{harness, model, effort, tools, permissionMode, connectionIds}` | near-miss: workgraph `AgentProfile` (`execution.ts:115`) is a different record; the shape here is `ResolvedGenerationProfileSchema` (`execution.ts:91-111`) minus placement plus `permissionMode` |
| `historyAfter` | history fence cursor | exact-match intentional: same field, same meaning as `StreamMasterStatus.historyAfter` (`records.ts:90`), generalized |
| `failureCount`, `failureSignature` | turn failure bookkeeping | replaces Wake-style `attempts` (reclaim re-drives don't increment `attempts`, `convex/wakes.ts:390-393` — it cannot count failures); mirrors `master_status.failureCount` |
| `deadlineAt` | turn wall-clock deadline | CLEAR (Wake `expiresAt` is give-up-before-firing, not a turn deadline) |
| `budget {maxChainLength, maxSelfScheduleDepth, maxTurnDurationMs, wakeHorizonMs}` | per-agent brakes | renamed for self-clarification: `maxTurns`→`maxChainLength` (§5.6 chain semantics), `maxDepth`→`maxSelfScheduleDepth` (maps to wakes `depth`, `types.ts:55,110`), `maxWallClockMs`→`maxTurnDurationMs`, `horizonMs`→`wakeHorizonMs` |
| `subject {kind, id}` | what the agent is bound to | near-miss: `EvidenceSubject` (completion contracts) — different domain, right word |
| `lastSession {sessionId, profile, harnessVersion?}` | stored session identity | CLEAR |
| `memoryScope` | MemoryBackend scope ref | CLEAR (`memoryRef`, `execution.ts:120`, is the inert workgraph slot; agents is a separate package) |
| `agents.notify / schedule / resolveApproval / cancel / update / setEnabled / define / status / listTurns / receipt` | public verbs | `schedule` shares name *and* semantics with `Wakes.schedule` (it is implemented by it) — acceptable; `deliver` was renamed `resolveApproval` (matches `Wakes.resolve`, says who it is for); `listReceipts(turnId)` renamed `receipt(turnId)` — the relation is 1:1 |

## 4. Tradeoffs

**T1. The subject lives on the Agent row; one agent per subject, enforced.**
Every real case is 1:1 (a master supervises one stream, an intake agent one
source view). The enforcement is what makes it safe: `define()` rejects a
duplicate `(org, owner, subject)` (unique per store, C2 patterns), and the lane
key derives from the subject — so "two rows, one subject, concurrent turns" is
unrepresentable, not merely discouraged (R3). An agent watching N subjects is N
agents: separate budgets, separate lanes, separate transcripts, and honest
about it.

**T2. `transcript` is a column; cross-session memory is a separate port.** The
column controls exactly one thing — whether the next turn reuses the last
transcript via `historyAfter`. Portable memory is the `MemoryBackend` port
(§5.9): phase-1 contract surface, null implementation, scope key composed
server-side. Mastra's `threadId` present/absent reached the same split
independently.

**T3. Session identity is stored, never derived.** The master derives
`ses_master_${streamId}` (`run-operation.ts:29-31`); a formula cannot survive
an agent whose subject changes and silently forks the transcript when it does.
`lastSession` is a stored column — with a liveness rule (§5.6): a recreated
harness session whose history restarts below the fence is detected
(`lastSeq < historyAfter`) and downgraded to fresh with reason `session_lost`,
never resumed into amnesia.

**T4. A turn is a poll chain; endings are `succeeded | continue | failed`.**
The harness runs its own agentic loop, so its terminal event means "the harness
stopped emitting", not "the goal is done". `continue` re-arms immediately and
counts against `maxChainLength` — **continuations do not consume
`maxSelfScheduleDepth`** (depth bounds agent-initiated *new-intent*
self-schedules; a continuation is the same intent completing). The alternative
— depth-bounded continuations — makes the two budget fields fight: the chain
dies at depth while turns remain. `failed` covers `step.failed`,
wall-clock expiry, and lane-external force-fail (§5.6).

**T5. Resume is conditional on compatibility.** Resume only if the turn's
profile is transcript-compatible with `lastSession.profile`: **same harness id
required; model, effort, and tools may change**; `harnessVersion` is recorded
when present and a history-renumbering upgrade forces fresh (C7). Anything else
starts a new session and records why.

**T6. The tool registry is an open, namespaced contribution point — with the
authorization rule that replaces the closed enum.** Today's closed
`z.enum(WorkGraphRuntimeToolNames)` makes a binding unforgeable. Tool sources
are genuinely plural (workgraph, wakes, connections, the layer's own, org MCP
servers), so the registry opens — and the security invariant moves to every
projection boundary: MCP `tools/list`, dispatch argument, and brokered forward
all validate against *this turn's granted profile*, never "anything registered"
(§5.8). Registration is static per deployment until phase 4's dynamic
registration, which is where this rule gets sharp.

**T7. Every trigger is an inbox row plus a dirty-flag wake — never a payload
riding a wake.** Coalescing loses payloads: `createLaneWakeIfIdle` keeps the
first wake's `intentJson` (`convex/wakes.ts:184-202`), and per-fireAt
idempotency keys dedup only identical target times. The master survives this
today because content lives in mailbox rows re-read at claim
(`workgraphRuntime.ts:441-447`). The layer generalizes that: `notify()` writes
the inbox row and the lane wake **in one transaction** (the `createWakeInTx`
pattern, `convex/wakes.ts:9-10,122-156`); the prompt renders inbox rows, never
wake intent. Two notifies in one window → one turn, two inbox rows, nothing
lost.

**T8. Build on `@claxedo/wakes` and the existing seams — no external
durable-execution substrate.** Ten candidates were read at the docs/source
level (2026-08-05 survey):

| Candidate | Version / license | Why not the substrate |
|---|---|---|
| deepagents (JS) | 1.12.1, MIT | Checkpointed thread suspension; no time triggers at any version; async subagents are pull-based with the anti-poll rule enforced by prompt instruction |
| VoltAgent | `@voltagent/core` 2.9.2, MIT | Durable/scheduling half lives in VoltOps (a console product) — fails C9 |
| CF Workflows | platform | CF-only kills self-host; 10k step ceiling bounds an unbounded-lifetime agent; is deterministic code replay |
| Absurd | `absurd-sdk` 0.5.0, Apache-2.0 | Postgres-only by construction — fails C2 |
| DBOS Transact TS | 4.25.14, MIT | Postgres system DB; SQLite backend announced for Go, not TS — fails C2 |
| Centaur (Paradigm) | Apache-2.0 | Postgres mandatory + container platform |
| Agentspan | MIT | Requires a Spring Boot / Conductor server |
| Restate / Trigger.dev | MIT | Bring their own store beside our ledger |
| Mastra | `@mastra/core` 1.55.0, Apache-2.0 core | Closest fit — libSQL and Convex adapters, threaded-vs-fresh split. Blocked on two: its scheduler is a `setInterval` tick loop its own docs say does not fire on Cloudflare Workers (C1), and it has no serialization primitive (`ifActive: 'discard'` drops the second turn; R3 needs it queued) |
| Inngest | 4.15.0, fair-source | Best lane primitive found (`concurrency: [{limit: 1, key, scope}]`). Declined on license (not OSI-open; we ship self-host) plus redundancy with `wake-lane.cf.ts` |

Two survey findings shape the design: durable execution *can* hold thousands of
long human waits (CF excludes waiting instances from concurrency; Absurd/DBOS
suspend free), so the surviving objections are portability, step ceilings, and
model mismatch; and keyed serialization exists elsewhere (Inngest), validating
the lane as the right primitive.

Adopted as ideas, zero dependency: Centaur's in-flight credential injection
(tracked separately); Absurd's first-emit-wins event caching (phase 0 —
`deliverEvent` drops early events today, `wakes.ts:334-341` +
`sqlite-store.ts:206-210`); Mastra's fire-once-after-gap rule (phase 0);
Inngest's two-constraint budgets — per-agent lane plus org ceiling (phase 0);
deepagents' delegation inheritance (phase 4).

Tripwire to re-open: if the hosted path ever leaves Workers for a long-lived
process, Mastra + Inngest becomes a coherent stack covering most of this
package. Re-evaluate then; not for scale alone.

**T9. API-first: contracts freeze before any runtime moves.** Phase 1 is Zod
schemas plus a conformance suite with zero behavior change — being wrong is
cheap in a file nobody imports. The freeze covers records, reasons, outcomes,
and the store port; the `runtime.run` port signature is the one exception,
reconciled against the real placement path in phase 2 (§5.6) — stated openly
rather than frozen wrong.

**T10. Tenancy is a column pair, never a scope flag (R9).** Two users wanting
the same behavior get two rows with the same charter; a row is cheap. A
transcript is never shared across users.

**T11. Receipts are runtime-attested, never agent-asserted (R5).** Today's
receipt is already runtime-written; the gaps are content (`toolCalls: []`
locally; synthetic clause citation). The layer closes them: `toolCalls`
extracted from session events on both backends (the hosted extraction at
`runtime.ts:1039-1048` generalizes), and `citedCharterClause` is validated as a
verbatim line of the charter text or omitted. A caller-supplied receipt is
self-attestation; the audit trail's value is that the runtime wrote it.

**T12. The wall-clock brake rides the poll loop, with a lane-external
backstop.** A watchdog wake on the same lane starves (lane exclusion blocks it
while any same-key row is `firing`); a watchdog on another lane races
`closeTurn`. So: (a) each monitor poll checks elapsed > `maxTurnDurationMs` →
`closeTurn(failed)` — no new machinery; (b) the backstop is a lane-external
force-fail mutation fenced on `turnId`, first-writer-wins (the
`completeMasterTurn` CAS pattern, `workgraphRuntime.ts:561`); (c) force-fail
interrupts the harness session — today nothing does, so a hung session keeps
burning tokens after the turn is declared dead.

## 5. The API

This section is the specification. Phases exist to make these snippets compile
and run; if a phase's output does not move one of them toward compiling
verbatim, the phase is wrong.

### 5.1 Composition

`Wakes` takes sinks at construction and cannot gain them later (C3), so the
agents package exports its sinks and composition wires both directions:

```ts
import { createAgents, AGENT_TURN_KIND, AGENT_TRIGGER_KIND } from "@claxedo/agents"
import { SqliteAgentStore } from "@claxedo/agents/sqlite"   // hosted: ConvexAgentStore

let wakes: Wakes   // late-bound, mirroring hosted-wakes.ts:196-198

const agents = createAgents({
  store: new SqliteAgentStore(db),
  runtime,                 // TurnRuntime port; the existing placement path (§5.6)
  clock,                   // injectable now(); test seam, mirrors createWakes
  wakes: () => wakes,      // accessor; the engine schedules through this
  authorize: requireUser,  // C10: REQUIRED, fail-closed — who may resolve approvals
})

wakes = createWakes({
  store: wakeStore, driver,
  sinks: {
    ...existingSinks,
    [AGENT_TURN_KIND]: agents.sinks.turn,         // lane-keyed; runs one claim-poll-close step
    [AGENT_TRIGGER_KIND]: agents.sinks.trigger,   // un-laned; writes inbox row + schedules lane wake
  },
})
```

Two kinds, because of C3's lane rule: `agent_turn` is lane-keyed and is the
only kind that runs turn steps; `agent_trigger` carries event/approval fires,
which arrive outside the lane, and its sink only writes the inbox row and
inserts the lane wake (idempotency key `agent-turn:${agentId}:${sourceWakeId}`
— the trigger sink is itself at-least-once). **A turn never executes inside
`resolve()` or `deliverEvent()`.**

### 5.2 Define (and operate) an agent

```ts
const master = await agents.define({
  name: "stream-master",                   // unique per (org, owner)
  ownerUserId, orgId,
  subject: { kind: "stream", id: streamId },   // unique per (org, owner) — T1
  charter: { text: charterText },              // hash COMPUTED server-side (below)
  transcript: "resume",
  profile: {
    harness: "claude", model, effort: "high",
    tools: ["workgraph.report_progress", "workgraph.update_stream_notes"],
    permissionMode: "claxedo:auto",
    connectionIds,
  },
  budget: { maxChainLength: 12, maxSelfScheduleDepth: 3,
            maxTurnDurationMs: 30 * MINUTE, wakeHorizonMs: 30 * DAY },
})

const intake = await agents.define({
  name: "intake-planner",
  ownerUserId, orgId,
  subject: { kind: "sourceView", id: viewId },
  charter: { text: intakeCharter },
  transcript: "fresh",
  profile: { harness: "claude", model, effort: "medium",
             tools: PLANNING_TOOLS, permissionMode: "claude:plan", connectionIds: [] },
  budget: { maxChainLength: 60, maxSelfScheduleDepth: 1,
            maxTurnDurationMs: 10 * MINUTE, wakeHorizonMs: 7 * DAY },
})

await agents.update(agentId, { profile: { model: NEW_MODEL } })  // takes effect next turn
await agents.setEnabled(agentId, false)   // kill switch: settles claims, cancels pending wakes, interrupts live turn
await agents.cancel(agentId)              // cancel all pending wakes (schedules re-materialize on next enable/cron edge)
```

`define` computes `charter.hash = sha256(text)` itself — the existing stores
verify caller-supplied hashes (`charterMatchesHash`,
`adapters/sqlite/store.ts:6722-6724`; `convex/workgraphCommands.ts:559-560`);
the agents layer removes the caller from the integrity path entirely.

`update` semantics: `subject` is immutable (a new subject is a new agent);
`charter.text` recomputes the hash; `profile`/`budget` patches validate and
apply from the next claim — a turn's resolved profile never changes
mid-execution. A lowered budget never retroactively kills a mid-flight turn; it
takes effect at the next re-arm, and a refused re-arm is a receipted chain halt
(`budget_exceeded`), never a thrown sink.

`setEnabled(false)`: `claimTurn` returns `settled`; pending lane wakes are
cancelled (requires the store op of §7); the live turn is interrupted
best-effort (the §5.6 force-fail path) with a receipt (`failed`,
`agent_disabled`). `setEnabled(true)` re-materializes schedule wakes — **cron
schedules are data on the Agent row; wakes are derived**, which is what makes
disable/enable lossless.

### 5.3 The Agent record, field by field

Every field answers: why it exists, where it is enforced, and whether the
caller can supply it.

| field | why it exists | enforced / populated where | caller-supplied? |
|---|---|---|---|
| `id, orgId, ownerUserId` | tenancy + addressing (R9) | `ensureOwnerOrg` on every mutation | identity only; tenancy never |
| `name` | human handle; unique per (org, owner) | unique index / check-then-insert (C2 patterns) | yes |
| `subject` | the lane scope, the surfacing anchor, the memory scope component (T1) | unique (org, owner, subject) at define | yes, immutable |
| `charter {text, hash}` | standing instructions + receipt attestation (§5.7) | hash computed at define/update | text yes; hash **no** |
| `transcript` | resume vs fresh (T2) | claim-time session resolution | yes |
| `profile` | per-turn execution config (R7) | claim-time validation against the capability catalog (`validateResolvedExecutionProfileAgainstCapabilities`, `domain/execution-capability-policy.ts:56-64` — run admission calls it at `workgraphCommands.ts:2633-2646` / `store.ts:5663-5671`; the master path skips it today, the agents claim path must not) | yes, clamped at claim |
| `profile.permissionMode` | what the agent may do without asking | server clamp against the per-harness allowlist; `unsupported` surfaced (C6) | yes, **clamped** — highest-risk field |
| `lastSession` | stored session identity (T3) | written by closeTurn; liveness-checked at claim | **no** |
| `memoryScope` | MemoryBackend scope (§5.9) | composed server-side from (agent, owner, subject) | **no** (type-level rejection) |
| `budget` | brakes (R6) | per field, §5.4 | yes, enforced server-side |
| `schedules` | cron registrations as data | materialized to wakes; rebuilt on enable | yes |
| `enabled` | kill switch (R12) | claimTurn + wake cancellation | yes |
| `failureBookkeeping {count, signatures[]}` | brakes (§8) | written only by the turn loop | **no** |

### 5.4 Budget — four fields, four enforcement points

An unenforced budget field is a lie; each names its site.

| field | semantics | enforced |
|---|---|---|
| `maxChainLength` | consecutive `continue`-chained turns since the last external (non-`self`) trigger; reset on any external reason (T4) | claim-time count over the Turn table (indexed, bounded — no full scans, §7) |
| `maxSelfScheduleDepth` | agent-initiated new-intent self-schedules | wake create-path via wakes `depth` (`budgets.ts:30-47`); continuations pass depth unchanged, so cron agents run forever at depth 0 and chains are bounded by `maxChainLength` |
| `maxTurnDurationMs` | wall-clock per turn | the T12 watchdog: poll check + lane-external backstop |
| `wakeHorizonMs` | how far ahead wakes may be scheduled | wake create-path (`budgets.ts:30-47`); crons re-insert at each edge so the horizon slides |

`maxSpend` is absent: nothing meters per-agent spend today (the substrate is
`llm_usage_events`, `convex/usageMetering.ts:106-189`, which needs an agent-id
dimension first), and a field that enforces nothing is worse than no field. It
returns when metering exists.

### 5.5 Triggering — inbox row + dirty flag (T7)

```ts
// (a) something happened — writes inbox row + lane wake, one transaction
await agents.notify(agentId, {
  reason: { kind: "event", key: "task_settled", payload: { runId } },
  prompt: "Run 41 finished. Decide whether the outcome can close.",
  provenance: { source: "workgraph", trust: "trusted" },   // required; drives fencing
})

// (b) on a schedule — stored on the Agent row, materialized to wakes
await agents.schedule(agentId, {
  cron: "0 6 * * *",                  // UTC (existing convention: nextDailyMasterRun is Date.UTC-based)
  prompt: "Daily sweep: check stalled tasks, escalate anything blocked >48h.",
})

// (c) a human answered a blocking question — actor is required and must be a user (C10)
await agents.resolveApproval(approvalToken, { answer: "approved" }, actor)

// (d) one turn, different profile — cheaper model for a routine sweep
await agents.notify(agentId, {
  reason: { kind: "schedule", cron: "0 6 * * *" },
  profile: { model: CHEAP_MODEL },        // merged over the agent's profile for THIS turn
})
```

```ts
type TurnReason =
  | { kind: "event";    key: string; payload: Json }       // CI passed, webhook, task_settled
  | { kind: "schedule"; cron: string }
  | { kind: "message";  from: Actor; text: string }        // mailbox / owner nudge
  | { kind: "approval"; question: string; answer: string; resolvedBy: Actor }
  | { kind: "approval_expired"; question: string }         // a pending approval lapsed unanswered
  | { kind: "self";     intent: string; depth: number }    // scheduled by a prior turn
```

Rules:

- **`reason` is required; `prompt` is optional** and defaults to the reason's
  canonical rendering (each kind has one; an explicit prompt overrides).
- **Every entry point writes an inbox row** `{agentId, reason, prompt?,
  profileOverride?, provenance, createdAt, consumedByTurnId?}` and inserts the
  lane wake in the same transaction. The wake carries no content.
- **Coalescing merges, never drops.** Several inbox rows drained by one turn
  produce a turn with several reasons; the receipt lists every consumed inbox
  row id. Per-turn profile overrides on merged rows: last-write-wins, and the
  receipt records the winner.
- **Rate limiting:** public-facing `notify` callers (webhooks) are rate-limited
  per source key, and `provenance.trust` is derived server-side from the entry
  point — an agent's own session id as source is filtered out (the R6
  loop-breaker, generalized from `hosted/runtime.ts:996-1000`).
- **Approval expiry is a first-class reason** (`approval_expired`): hosted has
  no expiry sweep today (lane-scoped `runDue` skips the expiry sweep,
  `wakes.ts:96-100`) and `resolve()` never compares `expiresAt` — phase 0 fixes
  both; an expired approval wakes the agent to reconsider rather than
  vanishing.

### 5.6 What one turn does — the state machine

Consumers do not write this; it is the package's internal loop, shown because
it IS the contract. A turn is a **chain of fires**, each fire one
claim-poll-close step bounded by the 30s wake lease (C3):

```
agent_turn wake fires (lane-keyed; content already in inbox rows)
  → claimTurn(agentId)
      settled                      — no eligible inbox rows / disabled / duplicate
      deferred { retryAfterMs, blocker } — typed blocker: busy resource, unmaterializable
                                         tool, profile fails catalog validation
      launch  { turnId, profile, session, promptSnapshotId }
      monitor { turnId, session }
  → launch: resolve profile (§5.3 clamp) → resolve session (T3/T5 rules)
      → snapshot the prompt DURABLY (below) → admit via runtime.run (steer+resume)
  → monitor: poll history since historyAfter
      → terminal event? closeTurn(outcome)  :  re-arm monitor (backoff 1s→5s→30s, reset on new events)
      → elapsed > maxTurnDurationMs? closeTurn(failed)   (T12 primary brake)
  → closeTurn — ONE atomic store transaction:
      receipt write + historyAfter advance + inbox consume + continue re-arm
      (idempotency key self:${turnId}) — retried closeTurn cannot double-arm
```

```ts
const claim = await agents.claimTurn(agentId)
if (claim.state === "settled") return claim
if (claim.state === "deferred") return claim   // retryAfterMs; blocker is typed
if (claim.state === "monitor") return agents.monitorTurn(claim.turnId)

const prompt = agents.buildTurnPrompt(claim)
// identity + charter + hash + authority + tool-derived duties
// + reasons (each trust-fenced per provenance) + inbox page + sinceLastTurn page

const admitted = await runtime.run({
  agentId: claim.agentId,
  profile: claim.profile,               // resolved, clamped, final for this turn
  session: claim.session,               // { sessionId, historyAfter } | { sessionId: null }
  prompt,                               // snapshotted; replays byte-identical on re-admission
})
```

Crash-window rules, each load-bearing:

- **The prompt snapshot is byte-stable.** The history fence persists before
  prompt admission today (`workgraphRuntime.ts:517-532`), but the prompt is
  *rebuilt* from re-queried state on re-admission — and V2 prompt admission
  rejects conflicting id reuse, so a crash between admission and confirmation
  currently poisons the turn into the failure escalator. The layer snapshots
  the built prompt at fence time; retries replay the snapshot; volatile
  sections (inbox, runs) refresh only on a *new* turn.
- **closeTurn is one transaction** (receipt + fence + consume + re-arm). The
  existing `completeMasterTurn` is atomic for receipt+mailbox but drops the
  fence — the next turn recomputes it by walking full history
  (`hosted/runtime.ts:915,1030-1032`), an O(all events) read per turn that the
  persisted fence removes.
- **Monitor fires redo placement cheaply.** Placement and runtime tokens are
  cached per turn with a re-mint cadence — a 30-minute turn needs ≤3 token
  mints (ttl 10 min, `hosted/runtime.ts:855-862`), not ~1,800.
- **Session liveness is checked at claim** (T3): `lastSeq < historyAfter` →
  fresh session, reason `session_lost` recorded.
- **Context overflow is a first-class failure.** A resume-mode transcript grows
  until the provider rejects it; that failure class gets a defined recovery
  (harness compaction, or auto-fresh with `session_overflow` recorded and the
  carried-forward state named explicitly — with the null memory backend, that
  is the charter, the inbox, and the receipt chain). Unhandled, a healthy
  long-lived agent converges to its own death.
- **`runtime.run` returns typed placement failures** (`adoption_refused` vs
  `unavailable`) so claim can halt vs retry; today's generic throw
  (`hosted/runtime.ts:878-880`) burns failure count on a permanent condition.
  The exact port signature is reconciled against the real placement path in
  phase 2 (T9).
- **Prompt assembly has a size budget:** inbox page 20 items / 16KB with a
  "+k more" marker (unclaimed items stay pending for the next turn — the
  `take(100)` + status pattern at `workgraphRuntime.ts:447-450` generalized);
  per-field byte caps on run results; a total cap with a truncation order in
  which the reason and charter are never truncated.

### 5.7 The TurnReceipt (R5, T11)

1:1 with a turn; a turn cannot reach a terminal state without one (type-level).

| field | populated by | note |
|---|---|---|
| `turnId, agentId` | runtime | receipt queryable by agent |
| `reasons` + `inboxRowIds` | runtime | everything this turn consumed (T7) |
| `charterHash` | runtime | the standing instructions in force |
| `citedCharterClause` | runtime | validated verbatim line of the charter text, or omitted — never synthesized |
| `modelVersion` | runtime | from the resolved profile |
| `reasoningSummary` | runtime, extracted from the transcript (hosted: last text event, 10k cap, `runtime.ts:1034-1037`) | the one field whose *content* originates with the model — still server-extracted |
| `toolCalls` | runtime, extracted from session events on **both** backends | closes the local `toolCalls: []` gap (`local/master-runtime.ts:184`) |
| `resultingDiffs` | runtime | artifact refs |
| `outcome: succeeded \| continue \| failed` | runtime | `continue` receipts record the re-arm key |
| `error? {class, signature}` | runtime | on failed/halts; the signature feeds §8 |
| `durationMs, createdAt` | runtime | |

### 5.8 How tools reach a harness (materialization)

**The registry is a contribution point, not a WorkGraph re-export (T6).** The
dependency arrow is agents ← workgraph; the package names no consumer's tools:

```ts
agents.registerTools("workgraph",   workgraphTools)    // one consumer's contribution
agents.registerTools("wakes",       getWakeToolDefinitions())
agents.registerTools("connections", connectionTools)
agents.registerTools("agent",       spawnDelegateEscalateMemory)   // the layer's own
```

`Agent.profile.tools` holds **namespaced names** the registry resolves to
`{description, inputSchema, execute}` — functions are real, the *row*
references them. The registry is the source of truth; **materialization is a
per-harness-class projection of the turn's granted subset** (C4):

| harness class | examples | projection |
|---|---|---|
| in-process engine | pi central | real closures — `extraTools: PiAgentTool[]` resolved per turn (`session/runtime.ts:300-314`) |
| hosted SDK (our opencode host) | opencode sessions in workspace-runtime | dynamic per-session descriptors (`host.registerSessionTools`, `server.ts:542-584`); execution over a nonce-bound loopback callback — data, not functions, but re-registrable at will |
| external binaries | cursor, codex, claude | one stable MCP endpoint attached at harness start; the turn's granted catalog resolved server-side and projected through it |

The property that matters per class is not whether execution crosses a process
boundary (it does everywhere except pi) but **whether the catalog can change
without reconfiguring the harness**: closures and descriptors can, MCP startup
config cannot — which forces the executor pattern below.

**External binaries: the attachment is static, the catalog is dynamic.**
Harnesses load MCP configuration at startup, so a per-turn tool set cannot be
expressed by reconfiguring the harness between turns. The pattern — reference
[executor](https://github.com/UsefulSoftwareCo/executor): a single
always-attached endpoint whose served catalog is resolved per binding. The
harness config never changes; what the endpoint serves depends on the token it
was spawned with. The catalog reaches the model one of two ways:

- **Real `tools/list` projection** — the granted subset as genuine MCP tools.
  Argument validation happens at the model API; duty text and tool list stay
  derived from one array (§6 invariant 5). Caveat constraining T5: on a
  *resumed* session the negotiated list is from session start, so a mid-session
  `profile.tools` change takes effect only if the harness honors
  `notifications/tools/list_changed`; otherwise a tool-set delta forces a fresh
  session. Which harnesses honor it is an empirical question phase 2 answers
  per supported harness.
- **Single dispatch tool + prompt catalog** (the executor/codemode shape) — one
  always-available tool, the catalog described in the prompt, dispatch resolved
  server-side. Universally compatible, but the model API never sees the real
  schemas and the catalog costs prompt tokens every turn. The fallback for
  harnesses whose MCP support is partial.

The seed of the endpoint exists: `packages/claxedo-mcp` binds scope at spawn
via env (`CLAXEDO_AUTH_TOKEN` bearer, `CLAXEDO_WORKSPACE_ID`,
`CLAXEDO_SESSION_ID`, `server.ts:14-17,47-50`) with static per-build tool
groups (`server.ts:32-35`) under a read-only policy (`server.ts:30,50`). Two
gaps for agent use: the catalog must become a function of the turn's granted
profile, and the bearer must become turn-scoped.

The hosted-SDK worker path also exists, scoped to WorkGraph:
`packages/workspace-runtime/src/routes/workgraph-run-tools.ts` binds a session
(`POST /api/workgraph/run-binding`, inbound `x-claxedo-workgraph-broker-token`),
delivers JSON-schema definitions at bind time (`zodToJsonSchema`,
`registerSessionTools`, `:213-217`), serves a name+description catalog
(`GET /api/workgraph/run-tools`), and forwards executions to
`/internal/workgraph/run-operation` under the binding's `Authorization` bearer
(`:308-310`). Generalizing: `{runId, streamId, sessionId, workspaceId,
generation}` identity → `{agentId, turnId}`; closed enum → registry lookup.

Four constraints, none optional:

- **Binding validates against the turn's granted profile** at every projection
  boundary: MCP `tools/list`, dispatch argument, brokered forward (T6).
- **Names are namespaced** (`workgraph.report_progress`).
- **Flat schemas only (C4)** — validated at registration; a union-typed tool
  re-parses internally behind a flat envelope. One malformed registrant must
  not fail a turn.
- **Tokens bind to the turn** — MCP env bearer and broker token alike; a leaked
  token is not replayable by another agent or after the turn closed.

**Materialization is per-turn** (T5). A tool that cannot materialize under the
turn's harness class is a **launch blocker** — `claimTurn` returns `deferred`
with a typed blocker, joining the oracle's 12 (`launch-readiness.ts:10-22`).
Silently dropping it is worse than failing: an agent told to "open a draft PR"
whose PR tool vanished improvises with raw git — what the landing-tool gate
exists to prevent.

**Where this points: the agent as a central-harness session.** The contract is
shaped so the durable agent's own session can be a pi central session holding
real closures and *deciding* what to spawn, while spawned workers are
disposable and get projections. That collapses the cross-harness transcript
rule for the agent (its session never switches harness — only its workers do),
gives memory one home, and makes channel-triggering free
(`session/runtime.ts:820-827` gives pi central an in-process `spawn_session`).
The phases stay harness-agnostic; pi-central is the specialization the contract
is shaped for, gated on the two hosted store adapters (C8).

**Code mode — the dispatch shape taken to its limit — is deferred, with a
tripwire.** Upstream ships a confined interpreter (`packages/codemode`, an AST
walker — no `vm`, no `new Function`) exposed as a single `execute` tool,
currently unreachable because `CodeModeTool` is not registered in
`packages/opencode/src/tool/registry.ts`. Confinement is a *capability*
guarantee: the global scope is built from an empty map
(`codemode.ts:1505-1537`), so `fetch`/`require`/`process` are undefined
identifiers, and `ToolReference` gives the program a path string while "the
interpreter never holds the tree itself" (`codemode.ts:1488-1490`). What it
does NOT bound: misuse of granted tools, exfiltration between two legitimate
tools, or resource exhaustion — "budgets are host policy, not library policy"
(`codemode.ts:474-476`) and the host passes none (`code-mode.ts:255-276`), so
`while(true){}` runs until an outer abort an unattended agent does not have.
**Tripwire:** when an agent's catalog makes per-turn schema cost dominant,
revisit — with `timeoutMs` + `maxToolCalls` mandatory, since code mode changes
nothing about prompt-injection susceptibility.

### 5.9 What memory is (and is not)

`transcript: "resume"` means one thing: reuse `lastSession.sessionId`, read
history from `historyAfter` forward. That is the harness's own transcript;
nothing is summarized or stored by us. It is therefore **not portable** (C7).

So the `MemoryBackend` port is what makes harness-switching viable (R7), and it
is phase-1 contract surface with a null implementation:

```ts
Agent.memoryScope?: MemoryScopeRef       // {userId, orgId, subject} — composed SERVER-SIDE
```

Per [[project_proactive_memory_durable_decisions]] the scope key is composed
and enforced server-side, derived from the SAME (agent, owner, subject) tuple
as the session, or an agent could read memory it cannot see in its transcript.
The real backend lands separately with no contract change.

### 5.10 Reads, and where agent sessions surface

```ts
const turns    = await agents.listTurns(agentId, { limit: 20, before? })
const receipt  = await agents.receipt(turnId)                 // 1:1
const live     = await agents.status(agentId)
// → { enabled, lane: { pendingWakes, activeTurnId? }, liveSessionId?, lastTurnAt,
//     failureBookkeeping, blocked?: TypedBlocker }
```

`status` exposes the live turn's session id so the subject screen can
deep-link an in-flight turn. The session is **read-only to the owner mid-turn**:
steering a running agent goes through `agents.notify({kind: "message"})`, which
queues as an inbox row and promotes at the next safe boundary — the same
discipline as every other trigger, not a side channel into the prompt surface.

Reads flow through the existing snapshot + change-cursor doorbell (one
reactive data graph).

**Every session is a record; visibility is a user filter, not a hardcode.**
Agent sessions are real sessions — receipt auditability requires reading what
the agent read and did (R11). The convention, generalizing what exists:

- **Tag at creation.** Self-host has exactly one tag-construction site,
  `createHybridSession` (`session/runtime.ts:729-756`, building
  `source-channel:*` / `harness:*` tags); agent sessions are tagged
  `system_created:agent_turn` plus `agent:{agentId}` plus the subject tag. The
  same convention covers the other system-created sessions that exist today
  untagged or prefix-only: wake "Scheduled Sessions", `spawn_session`
  "Background Sessions", workgraph master/run sessions. (Title generation and
  compaction are in-session side calls, not sessions — `opencode/src/session/
  prompt.ts:193-253`, `compaction.ts:301-370` — so the convention covers them
  only if they are ever reified as sessions.)
- **Default-hide, user-configurable.** The sidebar already auto-surfaces tags
  as Status filter chips with a persisted view (`rail-sidebar.tsx:355-362,
  709-720`, localStorage `claxedo.session-view.v1`): the convention adds a
  default rule — `system_created:*` tags are excluded from the default view —
  and the user's saved filter can re-show any of them, per tag. That is the
  whole UX: the record exists for every session, and the user decides what
  crowds their list.
- **Two plumbing gaps to close:** self-host sync rows drop tags
  (`session/meta/shape.ts:141-165` — extend `sessionMetaSyncRow` or PUT meta
  post-admit via `meta-routes.ts:123-139`); hosted `session_history` has no
  tags column at all (`convex/schema.ts:333-346`) — add one, thread it through
  `syncWorkGraphSession`/`list`, and carry tags in the app mapper
  (`controlPlaneSessionToItem` hardcodes `tags: []`,
  `features/session/data/sync/inventory-source.ts:211`).

Row pressure by mode: `resume` is one session row per agent; `fresh` is one row
*per turn* — default-hide plus GC (§7) is what makes fresh-mode affordable.

### 5.11 The authority boundary (R10, T11)

The surface stops where the ledger begins. Approval of *work* lives in the
store's admission logic; wakes approvals (human-in-the-loop questions from
tools) are a different system — §5.5(c) touches only those, and only for human
actors (C10). Evidence contracts own "done"; the DAG is work items, not agent
code; a turn is the unit of durability, so there is no step replay; the harness
owns the permission mode mid-turn; memory is a separate port. The conformance
suite proves the boundary by type: each absent verb (`approve`,
`completeWorkItem`, `createWorkflow`, `step`, `setPermissionMode`, `remember`)
is an `@ts-expect-error` case in the usage file.

## 6. Design rules restated as invariants

1. **Agents are rows, not sinks** — one generic `agent_turn` sink dispatches by
   `agentId` from storage (R1).
2. **The lane key derives from the subject** — `agent:{org}:{owner}:{kind}:{id}`
   — with a single constructor and the same "two constructors split the lane"
   comment as `run-operation.ts:42-53`; subject uniqueness is enforced at
   `define` (T1).
3. **The wake is a dirty flag; the inbox is the content** (T7).
4. **Every terminal turn writes a runtime-attested Receipt, or the turn did not
   happen** (R5).
5. **Grants shape the prompt** — never describe a duty whose tool was not
   granted (`master-prompt.ts:14-16` generalized).
6. **Every turn knows why it woke** — reasons are required, external payloads
   fenced, an agent's own actions never trigger it (R4, R6).
7. **The lane wake is the turn's scheduler, not the turn's lease** — turns are
   poll chains; the wall-clock brake rides the poll plus a lane-external
   backstop (T12).

## 7. Data model and storage rules

```ts
Agent      id, orgId, ownerUserId, name                      // unique (org, owner, name)
           subject: { kind: "stream" | "sourceView" | "none", id? }   // unique (org, owner, subject)
           charter { text, hash }              // hash computed server-side
           transcript: "resume" | "fresh"
           profile { harness, model, effort, tools, permissionMode, connectionIds }
           schedules: { cron, prompt? }[]      // data; wakes are derived
           lastSession? { sessionId, profile, harnessVersion? }
           memoryScope?: MemoryScopeRef         // composed server-side; null backend in P1
           budget { maxChainLength, maxSelfScheduleDepth, maxTurnDurationMs, wakeHorizonMs }
           failureBookkeeping { count, signatures: { signature, count, windowStartMs }[] }
           enabled: boolean

AgentInbox id, agentId, reason: TurnReason, prompt?, profileOverride?,
           provenance { source, trust }, createdAt, consumedByTurnId?

AgentTurn  id, agentId, orgId, ownerUserId, status, reasons[],
           profile,                            // resolved for THIS turn, immutable mid-turn
           sessionId, historyAfter, deadlineAt,
           chainDepth, failureCount, createdAt, closedAt?

TurnReceipt turnId, agentId, reasons[], inboxRowIds[], charterHash,
            citedCharterClause?, modelVersion, reasoningSummary,
            toolCalls, resultingDiffs, outcome, error? { class, signature },
            durationMs, createdAt
```

Storage rules:

- **Uniqueness:** SQLite gets `UNIQUE(org, owner, subject_kind, subject_id)`
  and `UNIQUE(org, owner, name)` (pattern: `adapters/sqlite/schema.ts:652`);
  Convex gets check-then-insert inside one mutation (pattern:
  `convex/wakes.ts:173-181`).
- **Inbox + lane wake are one transaction** (pattern: `createWakeInTx`,
  `convex/wakes.ts:9-10,122-156`; SQLite: `ON CONFLICT` upsert, pattern
  `store.ts:6820-6834`).
- **closeTurn is one transaction** (§5.6).
- **New wake store op:** cancel-by-lane (`WakeStore` has no delete-by-lane
  today, `store.ts:11-68`) — needed by `setEnabled(false)` and `cancel`.
- **Turn queries are index-bounded** — the `maxChainLength` count and
  `listTurns` read through indexes, never full scans (this repo has an explicit
  unbounded-read policy).
- **GC is designed:** wakes (`gcWakes` exists with no caller —
  `convex/wakes.ts:471-490`, `sqlite-store.ts:286-291` — phase 0 wires callers);
  fresh-mode transcripts are GC-eligible once their receipt exists (the receipt
  is the durable record, the transcript is evidence); Turn/Receipt rows are
  retained per stream-archive norms. Each names its sweeper and cadence.
- **Create-only (C2):** the SQLite tables land as `CREATE TABLE` + fresh DB
  path; phase 2 states what happens to in-flight self-host turns across the
  swap (the adoption gate below).

## 8. Safety model

**The brakes (R6), all enforceable:**

- **Chain length** — `maxChainLength`, claim-time (§5.4).
- **Self-schedule depth** — via wakes `depth` (§5.4).
- **Rate + horizon** — per-agent `wakeHorizonMs`; per-workspace and org-scoped
  creation ceilings (the Inngest two-constraint shape) land in phase 0 —
  sized against measured settle/master re-arm volume, with re-arm wakes charged
  as continuations of one logical wake rather than independent creations, or
  the monitor cadence itself trips the rate limit.
- **Wall clock** — T12's two-part watchdog; force-fail interrupts the harness
  session.
- **Failure signatures** — replace the raw 3-strikes counter
  (`workgraphRuntime.ts:627-652`): `signature = stableHash(errorClass ‖
  normalize(message))` where `normalize` strips ids, numerals, timestamps,
  paths; typed errors collapse to their code. Store `{signature, count,
  windowStartMs}` on the Agent; cap per signature (3 per 24h, mirroring the
  existing intuition) plus a global cap across signatures (10 per window) so
  rotating distinct errors cannot slow-burn. Any success resets the signature's
  counter. Every halt writes a receipt naming the signature — the owner sees
  *what* killed it.
- **Loop-breaker** — the agent's own actions never trigger it (§5.5), and
  `kind: "self"` carries `depth` so the agent can see its own recursion.

**Trust:** external payloads are fenced `trust: "untrusted-data-only"` (C5) at
the layer that builds the prompt; `provenance.trust` is derived server-side per
entry point. The fence is a mitigation — the honest word is "fenced", never
"closed".

**Approvals — two systems, one invariant.** Ledger admission (R10) is the
store's; wakes approvals are human-in-the-loop questions. The invariant: **an
agent actor can never resolve an approval, including its own** —
`resolveApproval` requires a user actor, `createAgents` requires an explicit
`authorize` (C10), tokens are stored hashed (phase 0), and an approval token
appearing in a transcript is unforgeable-input, not authority.

**Permission modes:** clamped server-side per harness (C6); `unsupported`
surfaced, never silently applied. An unattended agent under `bypassPermissions`
is a different risk class than a supervised chat; phase 4's UI shows the
effective mode.

**Prompt injection via tools:** grants shape the prompt (invariant 5); a tool
that cannot materialize blocks launch (§5.8); the charter floor cannot be
lowered by charter text (§9).

## 9. What a charter is (and is not)

A charter is `{text, hash}` (`contracts/charter.ts:7-10`) and three things
happen to it:

1. **Inlined into the prompt** (`master-prompt.ts:38-39`) — exactly a system
   prompt.
2. **Hashed into every receipt**, with a validated verbatim clause or none
   (T11) — "which standing instructions were in force when this agent did
   that" becomes a checkable fact.
3. **Designed to raise an enforcement floor** — `landing-integrity.ts:72-83`
   has the `charter_pattern` rule: "Charter patterns extend this floor; they
   cannot remove the built-in rules."

Current gap, closed in phase 1: #3 does not read the charter today.
`forbiddenPatterns` arrives as a *parameter the agent passes to*
`workgraph_land_candidate`
(`hosts/workgraph/composition/agent-tools.ts:211,218,228`), not from the
charter row — the single place a charter is enforced is not sourced from the
charter. The hardcoded floor (no new `any`, no `@ts-ignore`, no weakened
strict flags) is real and unbypassable; the charter's contribution is
aspirational until phase 1.

A charter can never grant authority: `MASTER_AUTHORITY_ENVELOPE`
(`master-prompt.ts:6-7`) is not charter-derived, and no charter text can
approve agent-proposed work, push a protected ref, or lower the strictness
floor (R10). The charter is instructions; the envelope and the store are facts.

## 10. Verified architecture facts (first-hand, file:line)

Every seam this plan attaches to, confirmed in the working tree on `dev`:

| Fact | Verified at |
|---|---|
| `SpawnTurn(sessionId \| null, result)` — null starts a fresh session | `packages/wakes/src/types.ts:76-77` |
| `serialKey` IS the lane lock for time-triggered claims; `deliverEvent`/`resolve` fire immediately via CAS outside the lane | `types.ts:44-49`; `sqlite-store.ts:157-186` |
| Sinks are construction-time only; `Wakes` has no registration method | `packages/wakes/src/wakes.ts:24-49,80-106` |
| Budget enforcement at the create path, `BudgetError` (`max_live \| rate \| horizon \| depth`); defaults 5 / 240/hr / 1000 / 90d | `packages/wakes/src/budgets.ts:17-24,30-47` |
| Hosted disables 3 of 4 budgets (`MAX_SAFE_INTEGER`) | `hosted-wakes.ts:203-205` |
| Hosted sinks: static registry of 3 kinds; re-arm wakes carry per-target-time idempotency keys | `hosted-wakes.ts:207-257` |
| Wake claims lease ~30s; reclaim re-drives WITHOUT incrementing `attempts` | `wakes.ts:124`; `convex/wakes.ts:390-393`; `sqlite-store.ts:233-249` |
| Lane-scoped `runDue` skips the expiry sweep; no hosted component calls unscoped `runDue` | `wakes.ts:96-100`; `convex/crons.ts` |
| `resolve()` checks state but never `expiresAt <= now`; `authorize` defaults to `() => true`; tokens stored plaintext | `wakes.ts:121,319-332`; `convex/schema.ts:1475,1486` |
| `deliverEvent` has no first-emit-wins cache; `deliveryId` declared but unused | `wakes.ts:93,334-341`; `sqlite-store.ts:206-210` |
| Cron re-drive computes strictly after the wake's own `fireAt` (downtime replays every missed occurrence); re-arm CAS happens BEFORE next-occurrence insert | `wakes.ts:159-183` (recompute `:164`) |
| The only production `computeNextRun` accepts exactly `"daily@06:00Z"` | `hosted-wakes.ts:262-265`; `run-operation.ts:59-64` |
| `gcWakes` exists with no caller on either backend | `convex/wakes.ts:471-490`; `sqlite-store.ts:286-291` |
| Master lane key single constructor ("two constructors would split the lane…") | `run-operation.ts:42-53` |
| Master tools: 2 core + 1 separately-gated landing tool | `run-operation.ts:6-15` |
| Master session id derived: `ses_master_${streamId}`; master runtimes re-derive it per turn | `run-operation.ts:20,29-31`; `local/master-runtime.ts:163` |
| `claimMasterTurn` returns `settled \| launch \| monitor \| deferred` with `sessionId, turnId, historyAfter, failureCount, trigger, mailbox, runs, evidenceIds`; mailbox re-read at every claim | `convex/workgraphRuntime.ts:399-513` (mailbox `:441-447`) |
| History fence persisted BEFORE prompt admission; fence DROPPED at completion and recomputed by full-history walk next turn | `workgraphRuntime.ts:517-532`; `hosted/runtime.ts:915,1030-1032` |
| Prompt re-admitted under `id: msg_${turnId}` with `delivery: "steer"`, `resume: true` — REBUILT per claim, not byte-stable | `hosted/runtime.ts:928-936` |
| `completeMasterTurn` is atomic for receipt+mailbox+hibernate (CAS first-writer-wins); failure escalator halts at `failureCount >= 3` | `workgraphRuntime.ts:551-615,627-652` |
| `buildMasterPrompt` has no reason parameter; `claim.trigger` stamped on receipt then dropped | `master-prompt.ts:17-25`; `hosted/runtime.ts:807,963` |
| Terminal detection: `session.next.step.ended`/`.failed`, else 1s poll; monitor fire redoes placement + token mint (ttl 10 min) every poll | `hosted/runtime.ts:946-950,825-863` |
| Master's own mailbox messages filtered by actor id (loop-breaker) | `hosted/runtime.ts:996-1000` |
| Untrusted external text fenced `trust: "untrusted-data-only"` | `domain/stream-notes.ts:22-28` |
| Receipt gaps: local `toolCalls: []` hardcoded; `citedCharterClause` = first charter line synthesized; hosted extracts tool names from session events | `local/master-runtime.ts:184,293-299`; `hosted/runtime.ts:1039-1048`; `master-prompt.ts:9-12` |
| `RecordMasterAuditCommandSchema` = full receipt shape | `contracts/commands.ts:297-313` |
| `AgentProfileSchema.memoryRef` inert ("until the MemoryBackend mount is wired"); no runtime reader | `contracts/execution.ts:115-122` |
| `assignments {planning, execution, review}` exists; no delegation tool | `execution.ts:138-142`; `master-prompt.ts:44` |
| Launchability oracle: 12 typed blockers | `domain/launch-readiness.ts:10-22` |
| Capability catalog + claim-time profile validator exist (run admission calls it; the master path skips it) | `contracts/execution-capabilities.ts:115-145`; `domain/execution-capability-policy.ts:56-64`; call sites `workgraphCommands.ts:2633-2646`, `store.ts:5663-5671` |
| `ExecutionCapabilityNameSchema`: closed enum of 8 | `execution-capabilities.ts:16-26` |
| Charter hash caller-supplied, server-VERIFIED (`charterMatchesHash`) | `adapters/sqlite/store.ts:6722-6724`; `convex/workgraphCommands.ts:559-560` |
| Charter enforcement does not read the charter (`forbiddenPatterns` is a tool parameter) | `hosts/workgraph/composition/agent-tools.ts:211,218,228` vs `landing-integrity.ts:72-83` |
| bornState decided in the store, both backends | `adapters/sqlite/store.ts:2374-2382`; `convex/workgraphCommands.ts:1164-1172` |
| Uniqueness patterns: SQLite `UNIQUE(org, owner, job_type, subject_id)`; Convex check-then-insert in one mutation | `adapters/sqlite/schema.ts:652`; `convex/wakes.ts:173-181` |
| Inbox+atomicity patterns: `createWakeInTx`; `ON CONFLICT` upsert | `convex/wakes.ts:9-10,122-156`; `adapters/sqlite/store.ts:6820-6834` |
| Only pi central receives real closures (`extraTools: PiAgentTool[]`); opencode host receives descriptors (loopback execution) | `session/runtime.ts:255-314,825-856`; `workspace-runtime/src/workspace/host.ts:70-76` |
| Brokered worker path: bind (token inbound) → definitions at bind time → forward under bearer; WorkGraph-scoped closed enum | `workspace-runtime/src/routes/workgraph-run-tools.ts:20,22-36,140-143,174-243,286,308-310` |
| claxedo-mcp binds scope at spawn via env; tool groups static per build; read-only policy | `packages/claxedo-mcp/src/server.ts:14-17,30,32-35,47-50` |
| `spawn_session` in-process for pi central ("no MCP hop needed") | `session/runtime.ts:820-827` |
| `projectionStore`/`durableSessionLog` throw on hosted; pi-central self-host-only | `hosted-services.ts:328-336,442-443`; `central-runtime.ts:71` |
| Hosted intake planning: `source_plan` due-job drain (10-job parallel batch, inline prompt, profile from workgraph defaults); session intake is a deterministic drain (no LLM) | `convex/workgraphBackground.ts:73,185-320` |
| Self-host intake planning: `createSqliteSourcePlanningRuntime`, wired only in self-host composition; planner validates revision echo / target stream / duplicate keys | `composition/server-workgraph.ts:135`; `adapters/sqlite/source-planning-runtime.ts:177-188,197-206` |
| Session tag infra: one construction site (`createHybridSession` builds `source-channel:*`/`harness:*`); sync rows DROP tags; PUT meta route accepts tags | `session/runtime.ts:729-756`; `session/meta/shape.ts:141-165`; `session/routes/meta-routes.ts:123-139` |
| Sidebar auto-surfaces tags as Status filter chips; view persisted in localStorage; app inventory drops tags for control-plane rows | `claxedo-app/src/app/workbench/rail/rail-sidebar.tsx:97,355-362,709-720`; `features/session/data/sync/inventory-source.ts:211` |
| Hosted `session_history` has no tags/hidden column; workgraph sessions marked by id prefix only, synced into a dedicated `WorkGraph · <stream>` workspace | `convex/schema.ts:333-346`; `hosted/runtime.ts:1810-1854` |
| Title generation / compaction are in-session side calls, NOT sessions | `packages/opencode/src/session/prompt.ts:193-253`; `compaction.ts:301-370` |
| WakeLane DO: "the platform's only legal 'run soon, serialized per key' primitive"; gives up a lane after 10 min of continuous failure | `wake-lane.cf.ts:1-4,16` |
| Codemode exists, unregistered; budgets are host policy, host passes none | `packages/opencode/src/tool/code-mode.ts:20,204,255-276`; `registry.ts`; `codemode.ts:474-476,1485-1537` |

## 11. Inherited operating principles (from `docs/plans/goal.md`)

- **Make illegal states unrepresentable.** An Agent without a charter hash, a
  Turn without a deadline, or a terminal Turn without a Receipt must not
  typecheck.
- **Strangler / additive.** The master keeps running throughout; no phase has a
  half-live cutover.
- **TDD + behavior-asserting state-machine tests.** Assert the transition and
  the refusal, never `includes()` on a collection
  ([[reference_includes_assertions_dont_bite]]).
- **Green is a claim, not proof** ([[feedback_no_false_positive_verification]]).
  Every phase's DoD names a negative proof: revert the change, the test goes
  red.
- **One reactive data graph.** Reads flow through the existing snapshot +
  change-cursor doorbell.

## 12. Phases

### Phase 0 — The brakes (wakes-level; independently correct; ship regardless)

- [ ] `hosted-wakes.ts:203-205` no longer passes `MAX_SAFE_INTEGER`. Values
      justified in a comment against **measured settle/master re-arm volume** —
      re-arm wakes are charged as continuations of one logical wake (or the
      monitor cadence trips the rate limit and hot-loops on reclaim, since
      reclaim does not increment `attempts`). Progress:
- [ ] A test proves a `depth`-exceeding self-schedule throws `BudgetError` on
      the hosted composition path specifically. Progress:
- [ ] Negative proof: reverting the `hosted-wakes.ts` change turns that test
      red. Progress:
- [ ] An org-scoped ceiling exists alongside the per-workspace one; a test
      shows a single workspace cannot consume the org allowance. Progress:
- [ ] Approval hardening: tokens stored hashed; `resolve()` rejects
      `expiresAt <= now` regardless of sweep state; the hosted composition
      passes an explicit `authorize` (no `() => true`). Tests prove a stale
      token and an unauthorized actor are rejected. Progress:
- [ ] Hosted expiry sweep exists (Convex cron → unscoped `runDue` pass or
      per-lane nudges); a test asserts an expired approval fires
      `expired: true`. Progress:
- [ ] `deliverEvent` gains first-emit-wins caching: an event emitted before its
      watch exists is still delivered to a later watch (today dropped,
      `wakes.ts:334-341`). Test: emit, then watch, assert fire. Progress:
- [ ] Cron hardening: next-occurrence insert is atomic with the fired CAS
      (today the CAS happens first, `wakes.ts:159-183` — a crash between loses
      the recurrence); recovery fires ONCE after a gap (recompute against
      `now()`), asserted by a test after a multi-period gap. Progress:
- [ ] A periodic backstop re-nudges every lane holding a pending wake (a lost
      nudge on a quiet lane is a lost turn; the DO abandons a lane after 10 min
      of continuous failure, `wake-lane.cf.ts:16`). Progress:
- [ ] `gcWakes` gets a caller on both deployments, with retention stated.
      Progress:
- [ ] `bun run typecheck` + wakes suite + `packages/claxedo-server` tests
      green. Progress:

### Phase 1 — The contract (API-first; zero behavior change)

New `packages/agents/src/contracts/`. Schemas + conformance suite only; nothing
imports it yet. Being wrong is cheap here.

- [ ] `AgentSchema`, `AgentTurnSchema`, `TurnReceiptSchema`, `AgentInboxSchema`,
      `TurnReasonSchema` (six kinds) exist as Zod strict objects, with the §5.3
      field semantics: charter hash computed server-side, `memoryScope`
      server-composed (caller supply is an `@ts-expect-error`), `subject`
      immutable after define. `TurnReceiptSchema` structurally matches
      `RecordMasterAuditCommandSchema:297-313` with `streamId` → `turnId`,
      `wakeTrigger` widened to `TurnReason[]`, plus `error{class, signature}`.
      Progress:
- [ ] Illegal states do not typecheck (`@ts-expect-error` cases): Agent without
      `charter.hash`; Turn without `deadlineAt`; Turn without reasons; terminal
      Turn with no Receipt; `transcript: "fresh"` Agent carrying
      `historyAfter`. Progress:
- [ ] Turn outcomes are `succeeded | continue | failed`; `continue` re-arms
      with depth UNCHANGED and chain depth incremented; a test drives two
      chained turns and asserts the chain halts at `maxChainLength` with a
      receipted `budget_exceeded`, not a throw. Progress:
- [ ] `maxTurnDurationMs` force-fails a hung turn: a test simulates a harness
      that never emits terminal and asserts `failed` via the poll check AND via
      the lane-external backstop racing a live closeTurn (first-writer-wins,
      loser no-ops). Progress:
- [ ] closeTurn is ONE transaction: receipt + fence advance + inbox consume +
      continue re-arm (idempotency key `self:${turnId}`). Conformance crashes
      between logical steps by construction (there is no multi-call close API)
      and asserts a retried closeTurn cannot double-arm. Progress:
- [ ] The prompt snapshot is durable and byte-stable: a test re-admits a turn
      after mutating the underlying inbox and asserts the replayed prompt is
      byte-identical to the snapshot. Progress:
- [ ] Session identity is stored (`lastSession`), never derived — a guard test
      proves no `ses_agent_${…}` formula exists in the package. Session
      liveness is checked at claim: a test recreates a harness session
      (history restarts below the fence) and asserts fresh start +
      `session_lost` recorded, never a silent resume. Progress:
- [ ] Resume compatibility (T5): same harness id required; a harness-switch
      test asserts fresh session + recorded reason. Progress:
- [ ] Subject uniqueness: duplicate `(org, owner, subject)` define is rejected
      — SQLite by UNIQUE constraint, Convex by in-mutation check; conformance
      covers both. Progress:
- [ ] `budget` carries only enforceable fields; a guard test asserts each key
      has a named enforcement site; `maxSpend` absent. Progress:
- [ ] Tool registry: namespaced names; refuses non-flat `inputSchema` at
      registration; two namespaces contributing the same bare name coexist; the
      package contains zero references to any consumer's tool names (enforced
      via `test:architecture`, not grep). Progress:
- [ ] A required tool that cannot materialize under the turn's harness class is
      a `deferred` blocker with a typed reason, never a silent drop. Progress:
- [ ] `buildTurnPrompt` takes reasons as REQUIRED input; each kind renders a
      distinguishable opening line; external payloads render inside the
      `trust: "untrusted-data-only"` fence; a payload shaped like an
      instruction never appears as bare prompt text. Prompt size budget: a
      50-item inbox test asserts the page cap, the "+k more" marker, and that
      unclaimed items stay pending. Progress:
- [ ] The three authority concepts are distinct non-assignable types (`tools`
      vs `permissionMode` vs `ExecutionCapabilityName`); `permissionMode`
      resolution can express `unsupported` (C6). Progress:
- [ ] The self-approval invariant is type- and test-level: an agent actor
      calling `resolveApproval` is rejected; `createAgents` without
      `authorize` fails to boot. Progress:
- [ ] **Charter gap closed:** `forbiddenPatterns` sourced from the charter
      record, not the agent-supplied tool parameter
      (`agent-tools.ts:211,218,228`); an agent passing patterns not in its
      charter can neither widen nor narrow the gate. Progress:
- [ ] `agentLaneKey(scope)` is the ONLY lane-key constructor (subject-derived),
      with the single-constructor comment; a guard test greps for hand-built
      `agent:` template strings. Progress:
- [ ] An `AgentStore` port (agents + inbox + turns + receipts) with a
      conformance suite in `packages/agents/src/conformance/`, following
      `packages/workgraph/src/conformance/` — both backends drift-guarded from
      the first commit. Progress:
- [ ] **Snippets §5.2 and §5.11 compile verbatim** as
      `packages/agents/src/contracts/usage.typecheck.ts`; each absent verb in
      §5.11 is an `@ts-expect-error`. If a snippet needed editing to compile,
      update this doc in the same commit. Progress:
- [ ] `bun run typecheck:src` and `typecheck:test` both green
      ([[reference_typecheck_scripts_hide_test_files]] — typecheck tsconfigs
      exclude `*.test.ts`, so both scripts must run). Progress:
- [ ] Zero runtime imports of `@claxedo/agents` anywhere (grep-verified in
      DoD). Progress:

### Phase 2 — Master onto the loop (extract, do not invent)

- [ ] `claimTurn` is `claimMasterTurn` generalized; the Convex mutation
      delegates. The fence still persists before admission
      (`workgraphRuntime.ts:517-532`) — now with the prompt snapshot, and a
      crash-between-fence-and-admission test proves the replay is
      byte-identical. Progress:
- [ ] **Cutover gate:** first `claimTurn` adopts legacy in-flight state
      (`stream.master_status` / self-host due-job rows) into a Turn row, or
      refuses new claims while a legacy turn is non-terminal. A test deploys
      the change mid-turn and asserts no double-launch. Progress:
- [ ] `buildTurnPrompt` is `buildMasterPrompt` generalized;
      `MASTER_AUTHORITY_ENVELOPE` byte-identical against a frozen fixture
      across VARYING reasons (authority invariant while the reason section
      changes). The master's wake reason reaches its prompt (R4):
      `mailbox`/`task_settled`/`schedule` map onto `TurnReason`; a
      `task_settled` turn names the settled run. Progress:
- [ ] The self-trigger filter generalizes to reasons: an event whose actor is
      the agent's own session produces no inbox row. Progress:
- [ ] `runtime.run` reconciled against the REAL placement path (typed
      `adoption_refused` vs `unavailable`); §5.6 snippet updated in the same
      commit if the signature differs. Placement + tokens cached per turn (≤3
      mints per 30-min turn). Monitor backoff 1s→5s→30s, reset on new events.
      Progress:
- [ ] `permissionMode` threaded to the harness on spawn with server clamp; the
      per-turn override (§5.5(d)) wins over the agent row; a harness that
      cannot express the mode surfaces `unsupported`. Progress:
- [ ] `tools`/`profile` revalidated at claim against the capability catalog
      (the master path skips this today — §5.3). Progress:
- [ ] Receipt content honest on both backends: `toolCalls` extracted from
      session events locally too; `citedCharterClause` verbatim-validated or
      omitted. Progress:
- [ ] The `workgraph_master` sink routes through `agent_turn`;
      `WORKGRAPH_MASTER_KIND` stays registered so pre-deploy wakes still fire.
      Progress:
- [ ] Master sessions tagged `system_created:workgraph` + agent tag at creation
      (§5.10 seams). Progress:
- [ ] Both stores implement `AgentStore`; the phase-1 conformance suite passes
      on SQLite AND Convex. Behavior parity: existing master tests pass
      unmodified — any edited assertion called out in the PR with the reason.
      Progress:
- [ ] Negative proof: forcing closeTurn to skip the receipt write turns a test
      red. Progress:
- [ ] **Snippets §5.1, §5.5, §5.6, §5.10 run for real** against the master on
      both stores. Progress:
- [ ] `bun run typecheck` green; workgraph + claxedo-server suites green.
      Progress:

### Phase 3 — Intake as the second consumer (THE falsification test)

Three intake paths exist today; the phase names each one's fate: the hosted
`source_plan` due-job drain (`convex/workgraphBackground.ts:185-320`) moves to
`claimTurn`; the self-host sqlite planning runtime
(`source-planning-runtime.ts`) moves to `claimTurn`; the deterministic
session-intake drain (no LLM, `workgraphBackground.ts:73`) stays deterministic
— it is not an agent and does not become one.

- [ ] Intake planning runs through `claimTurn` + `buildTurnPrompt` with
      `subject: {kind: "sourceView"}` and NO new branch in the shared loop.
      Progress:
- [ ] The planner's defensive validation still bites: wrong-revision echo
      rejected (`source-planning-runtime.ts:197-206`), on both backends.
      Progress:
- [ ] `transcript: "fresh"` proven: two consecutive intake turns share no
      transcript — asserted on session identity. Progress:
- [ ] Webhook-sourced candidates arrive as `{kind: "event"}` with
      `provenance.trust: "untrusted"`, payload fenced at prompt build. The doc
      says fenced, not closed (C5). Progress:
- [ ] Intake runs a stricter `permissionMode` on its own agent row — the
      `2026-07-18-004` public-source asymmetry expressed as policy, with no
      Binding record (T1). Progress:
- [ ] **Stop condition, explicit.** Any conditional in the shared loop keyed on
      `subject.kind` fails this phase by design: record the divergence here, do
      not paper over it, do not start phase 4. Progress:
- [ ] Negative proof: reverting the intake migration turns the new subject test
      red while pre-existing intake tests stay green. Progress:

### Phase 4 — Agents as rows (only if phase 3 passed cleanly)

- [ ] One generic `agent_turn` sink dispatches by `agentId` from storage; a
      test creates an agent row at runtime and drives a turn with NO redeploy.
      Progress:
- [ ] `agent_delegate` added to the registry with deepagents' inheritance
      semantics in-contract: tools override entirely, permissions replace,
      prompt does not inherit; a delegate's tools validate against the
      DELEGATE's granted profile (T6). `assignments {planning, execution,
      review}` gains its verb. Progress:
- [ ] Delegation is capability-gated: an agent without `delegate` never sees
      the tool AND never receives delegation duty text. Progress:
- [ ] **Sidebar filter:** the `system_created:*` convention is wired end-to-end
      — self-host sync rows carry tags (shape.ts gap closed), hosted
      `session_history` gains a tags column, the app mapper stops dropping
      tags, and the sidebar's persisted view defaults `system_created:*` to
      hidden with per-tag user override. A test asserts 20 fresh-mode turns
      produce zero default-visible sidebar rows while every session stays
      reachable from the subject's screen and via the filter. Progress:
- [ ] Owner-facing surface stays inside existing screens — no "agents tab";
      agents appear where their subject lives; the effective (post-clamp)
      permission mode is shown. Progress:
- [ ] Per-agent budgets enforced at wake-create; one runaway agent cannot
      exhaust the org ceiling. Progress:
- [ ] Per-org dynamic tool registration (user-wired MCP servers) with the T6
      authorization rule. Progress:

---

## 13. Definition of Done

- [ ] This plan linked from `docs/plans/README.md` under "Retained Plans".
      Progress:
- [ ] Phase 0 landed: no budget on any deployment path is `MAX_SAFE_INTEGER`;
      approval tokens hashed; expiry sweep live; wake GC has callers. Progress:
- [ ] `packages/agents` exists with contracts, an `AgentStore` port, and a
      conformance suite passing on SQLite and Convex. Progress:
- [ ] The master runs on the generic loop with byte-identical authority
      envelope text, byte-stable prompt replay, and unmodified existing tests.
      Progress:
- [ ] Intake runs on the same loop with only a different subject — or the
      divergence is recorded here and phase 4 is abandoned. Progress:
- [ ] Every terminal turn writes a runtime-attested Receipt (toolCalls
      populated on both backends); removing the write turns a test red.
      Progress:
- [ ] Every turn carries `TurnReason`(s) into its prompt; external payloads
      fenced; an agent's own actions never trigger it. Progress:
- [ ] closeTurn is one transaction; a retried closeTurn never double-arms.
      Progress:
- [ ] `tools`, `permissionMode`, `ExecutionCapabilities` remain three distinct
      types; permissionMode is clamped server-side with `unsupported`
      surfaced. Progress:
- [ ] The registry is a contribution API with namespaced names;
      `packages/agents` names no consumer's tools. Progress:
- [ ] Turn boundaries explicit: `succeeded | continue | failed`; the wall-clock
      brake (poll check + lane-external backstop) force-fails a hung turn and
      interrupts its session. Progress:
- [ ] An agent can switch harness between turns without resuming an
      incompatible transcript; a lost session downgrades to fresh with
      `session_lost` recorded. Progress:
- [ ] Every agent tool reaches its harness through the per-class projection of
      §5.8 — closures for pi central, descriptors for hosted opencode sessions,
      the MCP endpoint for external harnesses, brokered execution for sandboxed
      workers — flat-schema rule enforced at the registry boundary. Progress:
- [ ] The charter enforcement gap is closed — `forbiddenPatterns` comes from
      the charter, not from an agent-supplied tool argument. Progress:
- [ ] Agent sessions are tagged `system_created:*`, default-hidden, and
      user-filterable in the sidebar on both backends. Progress:
- [ ] An agent actor can never resolve an approval; `createAgents` without
      `authorize` fails to boot. Progress:
- [ ] `bun run typecheck`, `typecheck:src`, `typecheck:test`,
      `bun run test:architecture` green. Progress:
- [ ] Every phase's negative proof executed and recorded. Progress:
- [ ] CI replayed locally per house rule before pushing
      ([[feedback_simulate_ci_locally]]). Progress:

## 14. Files touched (primary)

- `packages/claxedo-server/src/hosts/wakes/hosted-wakes.ts` — real budgets,
  explicit authorize (P0)
- `packages/wakes/src/{wakes,budgets,store,sqlite-store}.ts`,
  `convex/wakes.ts`, `convex/crons.ts` — expiry sweep, token hashing, event
  caching, cron atomicity + catch-up, backstop nudge, GC callers,
  cancel-by-lane store op (P0–P1)
- `packages/agents/**` — NEW: contracts, ports, conformance (P1)
- `convex/workgraphRuntime.ts` — `claimMasterTurn` delegates; adoption gate (P2)
- `packages/workgraph/src/application/master-prompt.ts` → generalized prompt (P2)
- `packages/workgraph/src/adapters/sqlite/{store,source-planning-runtime}.ts` (P2–P3)
- `convex/workgraphBackground.ts` — `source_plan` drain through the loop (P3)
- `packages/workgraph/src/contracts/run-operation.ts` — `agent_delegate` (P4)
- `packages/claxedo-server/src/session/meta/**`, `convex/sessions.ts`,
  `convex/schema.ts` — session tags end-to-end (P2, P4)
- `packages/claxedo-app/src/app/workbench/rail/rail-sidebar.tsx`,
  `features/session/data/sync/inventory-source.ts` — sidebar filter (P4)

## 15. Risks

1. **Phase 3 may legitimately fail.** Intake's output is a *proposal* reviewed
   before work exists; the master's is *actions*. If that difference does not
   collapse into a capability grant, they are two things. Phase 3's stop
   condition exists so finding out costs two phases, not four.
2. **Dual-backend drift on the new tables.** Create-only schema discipline
   (C2) plus a conformance suite on BOTH adapters is the gate; a green
   typecheck means nothing here.
3. **The memory backend is null at phase 1.** Harness-switching genuinely
   forgets. The risk is shipping the switch before the backend: gate it, or
   document the loss in the UI.
4. **The trigger payload is the highest-severity addition** (C5). The fence is
   a mitigation, not a boundary; phase 1 DoD treats it as such.
5. **Opening the closed tool enum removes a compile-time guarantee (T6).** The
   binding must validate against the granted profile at every projection
   boundary; phase 4's dynamic registration is where it gets sharp.
6. **Pi-central is blocked on two hosted store adapters** (C8); the contract is
   shaped for it while every phase ships the harness-agnostic path. Phase 3's
   falsification does not depend on pi-central, which bounds the drift risk.
7. **Unattended agents change the permission-mode risk class** (C6). Effective
   mode must be surfaced; phase 4's UI shows it.
8. **Monitor-loop economics.** A turn is a chain of fires; each fire is a claim
   + mutation + (cached) placement. Backoff and per-turn token caching are in
   the design (§5.6); if measured cost still hurts, the cadence — not the model
   — is the dial.

## 16. Verification

Phase-gated on each DoD above. Globally: `bun run typecheck` and
`bun run test:architecture` green, both conformance suites green on both
adapters, and the negative proofs (P0 budget, P2 receipt, P2 envelope fixture,
P2 byte-stable replay, P3 subject) each demonstrated red-on-revert.

Per house rule, green is a claim and not proof. No phase is accepted on a green
run alone; each names the revert that must break it.

## 17. Execution: parallelize with agents and workflows

Phase 0 (`packages/wakes` + `hosted-wakes.ts`) and phase 1 (`packages/agents`,
a new directory) are **fully disjoint** — different packages, no shared
symbols — so they start as two agents in the same message. Phase 2 is the
critical path and serializes behind phase 1's frozen contract. Phase 3 cannot
start until phase 2 lands (both edit the shared loop).

- **Agent A — phase 0.** Brakes, approval hardening, expiry sweep, cron
  atomicity, backstop, GC callers. Self-contained; start immediately.
- **Agent B — phase 1.** Contracts + conformance scaffold. Longest independent
  stretch; start with A. Its output freezes the API; blocks review of 2 and 3.
- **Agent C — phase 2, after B.** Critical path: `claimTurn`,
  `buildTurnPrompt`, adoption gate, both store implementations. Deepest effort
  budget — dual-backend drift enters silently here.
- **Agent D — phase 3, after C.** Intake migration and the falsification test.
  Its job is to try to BREAK C's abstraction, not defend it.

Within phase 2, the SQLite and Convex `AgentStore` implementations are disjoint
files and run in parallel against the shared conformance suite — the drift
guard that makes parallel authorship safe. Do not parallelize phase 2's stores
with phase 3's intake migration: both touch the shared loop, and
`git commit --only` on a shared file is a known hazard in this repo
([[reference_commit_only_is_file_granular]]).
