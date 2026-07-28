# WS-C — Runtime: resume-first runs, autonomy, draft capture, budgets

**Parent:** `2026-07-28-004` · implements A1/A5/A8/A10 of `2026-07-28-003`. Depends on WS-A (generation, `parked`, `draft`, renames). Parallel-safe with WS-B except `workgraphCommands.ts` (coordinate merge order: WS-B's B1/B3 touch the same command path — land WS-B first or rebase).

## Non-goals
- No placement/parallelism changes (WS-D). One live run per stream stays in this WS.
- No approval-verb for agents, ever. Autonomy = born-state policy only.
- Supervised-stream behavior byte-identical except where a task explicitly says otherwise.

## C1. Autonomy: born-state consults stream policy (A1)

**Grounding.** Born-state lines: `convex/workgraphCommands.ts:840` (stream row **already loaded** at `:823-825` — zero extra reads) and `sqlite/store.ts:1858`. Agent-edit knockback twins: `store.ts:2000-2013`, `workgraphCommands.ts:965-982` (stream NOT loaded there — one extra read). Policy storage: `execution_defaults` on streams (`schema.ts:712`, defaulted `{}` at `workgraphCommands.ts:420`), typed via `ExecutionProfileDefaultsSchema` (WS-A added `agents`; this WS adds `autonomy`).

**Tasks:**
1. Extend `ExecutionProfileDefaultsSchema` (contracts/execution.ts) with `autonomy?: z.enum(["supervised","autonomous"])` and `budget?: { amount: number; unit: "usd" | "tokens"; window: "day" | "stream" }`. Compiled-envelope fields only — no new columns.
2. Both born-state sites become: `const autonomous = streamAutonomy(stream) === "autonomous"; const bornState = context.actor.type === "user" || autonomous ? "pending" : "pending_approval"` — with the **untrusted-source carve-out**: if the created item's `source_revision_refs` trace to a provenance-tagged untrusted source (the guardrail-2 tag; grep `untrustedSource` — it already threads into `buildAttemptPrompt`, `workgraphRuntime.ts:496-503`), born state stays `pending_approval` regardless of autonomy. Same line in both backends, same comment.
3. Knockback sites: in autonomous streams, agent edits do NOT restage (`work_item_restaged` skipped) — load the stream (the one extra read) and gate on the same helper.
4. Hold-and-confirm on the flip: `update_stream`/`set_stream_charter` writing `autonomy: "autonomous"` for the first time on a stream requires `confirmAutonomy: true` in the command (schema field); without it → typed error `autonomy_confirmation_required`. UI passes it from an explicit dialog (WS-E).
5. Auto-admitted work is labeled: born-pending items created by agents in autonomous streams keep full provenance (`created_by_actor_type` etc. — already written); add `auto_admitted: true` flag so Needs-you/UI can render the "ran without approval" feed (WS-E).

**Positive controls:** same agent-create fixture → Staged in supervised stream, launched in autonomous stream; untrusted-source fixture stays Staged in the autonomous stream; flip without confirmation → `autonomy_confirmation_required`; knockback skipped only in autonomous.

## C2. Draft capture (A5)

1. `CreateWorkItemCommandSchema` gains `draft?: boolean`. When true, born state = `draft` (WS-A added the state) regardless of actor/autonomy. New command `arm_work_item {workItemId}` (human-only like approvals — reuse the owner-verb guard pattern from `approve_work_item`, `store.ts:2880` / `workgraphCommands.ts:256`) transitions `draft → pending` (human) — agents get `forbidden`.
2. Oracle: `launch-readiness.ts` — `draft` is unlaunchable (`not_pending` already covers any non-pending state at `:56`; add explicit reason `draft` for UI clarity).
3. Bulk arm rides the existing `approve_work_items` batch shape (add `arm_work_items`).

**Positive control:** drafted task never launches under an aggressive drain fixture; arming launches it; agent calling `arm_work_item` → forbidden.

## C3. Resume-first runs (A10)

**Grounding.** Fresh-session-per-run is baked in at exactly two places: hosted `hosted-runtime.ts:361` (`POST /api/session`, no id) and local gateway `workgraph-session-gateway.ts:461-488` (`input.sessionId` never supplied by `local-execution.ts:156-166`). Deterministic-session precedent: master `hosted-runtime.ts:799` (`masterSessionId(streamId)`), planning `:1212`. The one existing continue-same-session path: completion retry `hosted-runtime.ts:566-609` (fenced by `requestCompletionRetry`). `parked` (né `attention`) currently releases the lease on write (`store.ts:5208-5215`, `workgraphRuntime.ts:1543-1591` → lease delete) — that's why recovery today means a new run. History replay exists (`hosted-runtime.ts:516-560`; `convex/sessions.ts:374,419,437,456`). Sandbox restore exists (`sandbox-manager/src/checkpoint-manager.ts:101-156`; `workspace-runtime/routes/checkpoint.ts:34 POST /resume`; `workspace-supervisor-sandbox.ts:248,328-333`). App reconnect is transport-only.

**Design:** a run's session id becomes deterministic: `runSessionId(runId) = "ses_wgrun_" + runId`. Transient failure paths write `parked` **keeping the lease** (renewed with `PARKED_LEASE_TTL_MS = 15 * 60_000`) + `parked_reason` + schedule a resume wake on the run's lane. Resume = re-`ensure` the workspace (hosted: `manager.ensure` same id — idempotent; if the sandbox was destroyed, checkpoint restore path), then `POST /api/session` **with the deterministic id** (both call sites pass it; the engine adopts-or-creates — the gateway already supports `id`), then re-prompt with `delivery:"steer", resume:true` (the existing flags — `hosted-runtime.ts:460`). Generation unchanged on resume. Fresh run (`generation+1`, new run row, new session id) happens only via: explicit `retry_work_item` after `failed`, a new `restart_run {runId, reason}` command (human or charter policy), or compensation after a *poisoned* placement.

**Tasks:**
1. Thread `id: runSessionId(run.id)` at `hosted-runtime.ts:361` and `local-execution.ts:156-166` → gateway `:469`.
2. `markParked` (both backends): keep + renew lease instead of delete; write `parked_reason`; enqueue resume wake (settle lane, `hosted-wakes.ts` shape). Distinguish **parked** (transient: relay drop, limit, eviction — resumable) from **failed** (the run itself errored) at every current `markAttention`/`recordFailure` call site — classify each site (the executing agent lists them from the grounding: compensation paths stay `parked` only when the envelope survived; else `failed`).
3. Resume driver: on lane wake with a parked run, execute the resume sequence; give up into `failed` after `RUN_RESUME_MAX = 5` attempts with backoff (persist attempt count in `parked_reason` payload or a `resume_attempts` column — column, both backends).
4. Fencing: resume does NOT bump generation; run-operation callbacks keep working (same generation). A **fresh** run bumps generation at admission (already the mint logic) — the zombie test below is the referee.
5. Delete `completion_retry` special-casing where the general resume path subsumes it — or keep it as the completion-specific resume; decide by reading `hosted-runtime.ts:566-609` at implementation time; if kept, add the missing SQLite twin (grounding: Convex-only today) for parity.

**Positive controls (the fragile-parts tests, headless):** (a) kill the relay/session mid-run (fake provider harness) → run parks → resume reattaches the SAME session id and the transcript continues (assert history length grows, no new session id); (b) zombie: park a run, force a fresh run (`restart_run`), then let the old sandbox POST a completion with the old generation → rejected by fencing, new run unaffected; (c) resume cap → `failed` after 5, Needs-you row appears.

## C4. Budgets (A8)

**Grounding.** `llm_usage_events` has no stream/run/cost fields (`schema.ts:516-534`); writer `recordLlmTurn` (`usageMetering.ts:44-79`) called from `telemetry/convex-usage-ledger.ts:32`, ledger port `telemetry/metering.ts:66`, threaded `central-session-runtime.ts:375`. Join key today: `session_id` → `workgraph_session_bindings`. Budget gate site: `claimLaunches` (`workgraphRuntime.ts:340-366`) already loads run+lease+item before emitting a claim; policy-rejection shape precedent at `workgraphCommands.ts:2316-2343`. Stream mutable-counter precedent: `master_status` object.

**Tasks:**
1. Schema (additive): `llm_usage_events` + optional `stream_id`, `run_id`, `work_item_id`; index `by_org_stream_created [org_id, stream_id, created_at]`.
2. Attribution: launches set env `CLAXEDO_WORKGRAPH_STREAM_ID` / `RUN_ID` / `WORK_ITEM_ID` on the session (hosted-runtime `manager.ensure`/session create params; local gateway equivalent); the runtime's ledger record passes them through (`metering.ts` record type + `convex-usage-ledger.ts` + `recordLlmTurn` args). Master/planning sessions attribute stream-only.
3. Spend counter: `workgraph_streams.spend: { total_usd?: number; total_tokens: number; as_of: number }` — updated **incrementally by the drain**, not per turn (no hot row): at `claimLaunches` and at settle, read usage rows `by_org_stream_created` since `spend.as_of` (`.take()`-bounded loop), fold, patch. USD derivation: a static `MODEL_PRICES` map in `contracts/execution.ts` keyed `providerId/modelId` (explicit, updatable; unknown models count tokens only).
4. Enforcement: in `claimLaunches`, if compiled `budget` exists and `spend` ≥ budget → emit zero claims for that stream and write a stream hold marker (`master_status.escalation = "budget_exhausted"` shape — reuse the existing hold derivation `workgraphCommands.ts:2509-2513` inputs) + attention entry. Resume of parked runs is also gated (a parked run does not resume past budget).
5. SQLite path: same counter fields, folded in the local drain (`server-workgraph.ts:255` reconcile tick).

**Positive controls:** fixture stream with budget 1,000 tokens + fake usage rows → next drain claims nothing, Needs-you shows budget-exhausted, supervised stream without budget unaffected; spend folding is idempotent across drain repeats (as_of watermark).

## Leave it better
- `workgraphRuntime.ts` markAttention/recordFailure sites get one shared classifier helper instead of copy-pasted state writes (bounded to touched functions).
- Kill the unused `transitionAttempt` domain helper OR wire both stores through it — decide by diff size; document the choice in the PR (grounding: it's exported but never called — dead code today).

## DoD
All positive controls green (each is a named test file listed in the PR); autonomy/budget/draft behavior covered in BOTH backends (conformance additions where the store contract is touched: born-state policy + parked-keeps-lease + resume idempotency become conformance invariants v8); supervised-stream regression suite untouched-green; single-box self-host: identical behavior with no autonomy configured.
